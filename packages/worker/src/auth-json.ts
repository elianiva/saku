/**
 * Auth JSON credential store (auth-json.ts): pi's `auth.json` read as a
 * `CredentialStore` (`Record<providerId, Credential>`). Own module so
 * model-catalog.ts stays one class per file; the daemon is the only
 * provider of the store — writes are daemon-owned, out of v1 scope.
 *
 * The file is parsed at the boundary: the raw JSON is validated by the
 * `CredentialSchema` decode, so the store's data never enters through an
 * unchecked assertion.
 */

import { Effect, Result, Schema } from "effect";
import type { FileSystem } from "effect";
import type { Credential, CredentialStore } from "@earendil-works/pi-ai";
import { isNotFound } from "@saku/store";
import nodePath from "node:path";

const AUTH_JSON_FILE_MODE = 0o600;

/**
 * The auth.json value contract: a provider-id → credential map, parsed at
 * the file boundary (the store's data never enters through an assertion).
 * The guard passes each entry through untouched, so unknown credential
 * fields survive a read-modify-write exactly as pi wrote them.
 */
const CredentialSchema = Schema.declare((value): value is Credential => {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  if (!("type" in value)) {
    return false;
  }
  return value.type === "api_key" || value.type === "oauth";
});

const DECODE_AUTH_JSON = Schema.decodeUnknownSync(Schema.Record(Schema.String, CredentialSchema));

/** Credential store over pi's auth.json (`Record<providerId, Credential>`). */
export class AuthJsonCredentialStore implements CredentialStore {
  private readonly path: string;
  private readonly fs: FileSystem.FileSystem;
  private data: Record<string, Credential>;

  constructor(path: string, fs: FileSystem.FileSystem, initial: Record<string, Credential>) {
    this.path = path;
    this.fs = fs;
    this.data = initial;
  }

  static load(path: string, fs: FileSystem.FileSystem) {
    return Effect.fn("load")(function* load() {
      // Any read failure lands in the Result: missing auth.json is the default
      // install, an unreadable file is worth knowing — both yield an empty store.
      const content = yield* fs.readFileString(path).pipe(
        Effect.map(Result.succeed),
        Effect.catch((error) => Effect.succeed(Result.fail(error))),
      );
      if (Result.isFailure(content)) {
        // A missing auth.json is the default install; anything else is worth
        // knowing (the daemon never mutates credentials in v1, so a malformed
        // file is the user's to fix).
        if (!isNotFound(content.failure)) {
          yield* Effect.logError(`[worker] failed to read auth.json: ${String(content.failure)}`);
        }
        return new AuthJsonCredentialStore(path, fs, {});
      }
      // SAFETY: JSON.parse returns any; pinning to unknown makes the
      // boundary decode the only validation the file content passes through.
      const parsed = Result.try(() => DECODE_AUTH_JSON(JSON.parse(content.success) as unknown));
      if (Result.isFailure(parsed)) {
        yield* Effect.logError(`[worker] failed to read auth.json: ${String(parsed.failure)}`);
        return new AuthJsonCredentialStore(path, fs, {});
      }
      return new AuthJsonCredentialStore(path, fs, parsed.success);
    })();
  }

  async read(providerId: string) {
    return await Promise.resolve(this.data[providerId]);
  }

  async list() {
    return await Promise.resolve(
      Object.entries(this.data).map(([providerId, credential]) => ({
        providerId,
        type: credential.type,
      })),
    );
  }

  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ) {
    const next = await fn(this.data[providerId]);
    if (next === undefined) {
      return this.data[providerId];
    }
    this.data[providerId] = next;
    await Effect.runPromise(this.persistBestEffort());
    return next;
  }

  async delete(providerId: string) {
    this.data = Object.fromEntries(Object.entries(this.data).filter(([id]) => id !== providerId));
    await Effect.runPromise(this.persistBestEffort());
  }

  /** Write-back: the in-memory credential is already updated; a failed persist is logged, never surfaced to the auth flow. */
  private persistBestEffort() {
    return Effect.tryPromise(async () => {
      await this.persist();
    }).pipe(
      Effect.result,
      Effect.flatMap((outcome) =>
        Result.isFailure(outcome)
          ? Effect.logError(`[worker] failed to persist auth.json: ${String(outcome.failure)}`)
          : Effect.void,
      ),
    );
  }

  private async persist() {
    await Effect.runPromise(
      this.fs
        .makeDirectory(nodePath.dirname(this.path), { recursive: true })
        .pipe(
          Effect.andThen(
            this.fs.writeFileString(this.path, `${JSON.stringify(this.data, null, 2)}\n`, {
              mode: AUTH_JSON_FILE_MODE,
            }),
          ),
        )
        .pipe(Effect.andThen(this.fs.chmod(this.path, AUTH_JSON_FILE_MODE))),
    );
  }
}
