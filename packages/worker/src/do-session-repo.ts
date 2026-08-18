/**
 * The DO session repo (do-session-repo.ts): pi's `SessionRepo` over one
 * KvStore (one thread's namespace). Sessions live flat under
 * `session/<id>/`, so forked children coexist with the thread's own
 * session, and pi's conformance suite passes against this backend.
 */

import { Session, SessionError } from "@earendil-works/pi-agent-core";
import type { ForkOptions, SessionCreateOptions, SessionRepo } from "@earendil-works/pi-agent-core";

import { DateTime, Effect, Option } from "effect";

import { jsonRecords, LogKey, SessionPrefix } from "@saku/store";
import type { KvStoreApi } from "@saku/store";
import { SessionState } from "./session-state.ts";
import type { SessionMutation } from "./session-state.ts";
import { DoSessionStorage, mutationSeq, validateSessionId } from "./do-session.ts";
import type { DoSessionMetadata } from "./do-session.ts";

/** The repo over one KvStore (one thread's namespace). */
export class DoSessionRepo implements SessionRepo<DoSessionMetadata> {
  private readonly kv: KvStoreApi;

  constructor(kv: KvStoreApi) {
    this.kv = kv;
  }

  async create(options: SessionCreateOptions = {}) {
    const kv = this.kv;
    return await Effect.runPromise(
      Effect.gen(function* () {
        const id = options.id ?? crypto.randomUUID().replaceAll("-", "");
        yield* validateSessionId(id);
        const prefix = SessionPrefix.create(id);
        // Byte-existence check (raw kv): a corrupt meta still counts as taken,
        // so create never overwrites a foreign session's keys.
        if (Option.isSome(yield* kv.get(`${prefix}meta`))) {
          return yield* Effect.fail(
            new SessionError("already_exists", `Session already exists: ${id}`),
          );
        }
        const now = yield* DateTime.now;
        const metadata: DoSessionMetadata = {
          createdAt: DateTime.toEpochMillis(now),
          cwd: "",
          id,
          ...(options.parentSessionId === undefined
            ? {}
            : { parentSessionId: options.parentSessionId }),
        };
        const storage = yield* DoSessionStorage.create(kv, metadata);
        return new Session(storage);
      }),
    );
  }

  /**
   * Adopt a parsed pi session (pi-sessions): write its mutations into
   * this repo as a fresh session, then load it back — the load replays the
   * whole log through `SessionState`, so an invalid import (broken chain,
   * duplicate id, non-consecutive seq) fails here, before a thread points
   * at it. The session id must be the thread's own id: the host looks up
   * the trail by thread id (session-host.ts).
   */
  async import(
    id: string,
    data: {
      readonly cwd: string;
      readonly createdAt: number;
      readonly mutations: readonly SessionMutation[];
    },
  ) {
    return await Effect.runPromise(
      Effect.gen({ self: this }, function* () {
        yield* validateSessionId(id);
        const prefix = SessionPrefix.create(id);
        if (Option.isSome(yield* this.kv.get(`${prefix}meta`))) {
          return yield* Effect.fail(
            new SessionError("already_exists", `Session already exists: ${id}`),
          );
        }
        const metadata: DoSessionMetadata = { createdAt: data.createdAt, cwd: data.cwd, id };
        const meta = jsonRecords<DoSessionMetadata>(this.kv, prefix);
        yield* meta.put("meta", metadata);
        const log = jsonRecords<SessionMutation>(this.kv, prefix);
        yield* Effect.forEach(data.mutations, (mutation) =>
          log.put(LogKey.create(mutationSeq(mutation)), mutation),
        );
        return yield* this.openEffect(metadata);
      }),
    );
  }

  /** Open a session's storage as an Effect (the shared core of `open` and `import`). */
  private openEffect(metadata: DoSessionMetadata) {
    return DoSessionStorage.load(this.kv, metadata.id).pipe(
      Effect.map((storage) => new Session(storage)),
    );
  }

  async open(metadata: DoSessionMetadata) {
    return await Effect.runPromise(this.openEffect(metadata));
  }

  async list() {
    const sessions = jsonRecords<DoSessionMetadata>(this.kv, "session/");
    const entries = await Effect.runPromise(sessions.list());
    return entries
      .filter(({ key }) => key.endsWith("/meta"))
      .map(({ value }) => value)
      .toSorted((a, b) => b.createdAt - a.createdAt);
  }

  async delete(metadata: DoSessionMetadata) {
    const prefix = SessionPrefix.create(metadata.id);
    await Effect.runPromise(
      this.kv.list({ prefix }).pipe(
        Effect.flatMap((entries) =>
          Effect.forEach(entries, (entry) => this.kv.delete(entry.key), {
            concurrency: "unbounded",
          }),
        ),
      ),
    );
  }

  async fork(source: DoSessionMetadata, options: ForkOptions & SessionCreateOptions) {
    const kv = this.kv;
    return await Effect.runPromise(
      Effect.gen(function* () {
        const sourceStorage = yield* DoSessionStorage.load(kv, source.id);
        const childId = options.id ?? crypto.randomUUID().replaceAll("-", "");
        yield* validateSessionId(childId);
        const childPrefix = SessionPrefix.create(childId);
        if (Option.isSome(yield* kv.get(`${childPrefix}meta`))) {
          return yield* Effect.fail(
            new SessionError("already_exists", `Session already exists: ${childId}`),
          );
        }
        const childNow = yield* DateTime.now;
        const metadata: DoSessionMetadata = {
          // Forks default their parent to the source session (jsonl parity).
          createdAt: DateTime.toEpochMillis(childNow),
          cwd: "",
          id: childId,
          parentSessionId: options.parentSessionId ?? source.id,
        };
        yield* jsonRecords<DoSessionMetadata>(kv, childPrefix).put("meta", metadata);
        const mutations = sourceStorage.forkMutations(options);
        const childStorage = new DoSessionStorage(kv, metadata, new SessionState());
        yield* Effect.forEach(mutations, (mutation) => childStorage.appendMutation(mutation));
        childStorage.applyMutations(mutations);
        return new Session(childStorage);
      }),
    );
  }
}
