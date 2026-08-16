/**
 * The DO session repo (do-session-repo.ts): pi's `SessionRepo` over one
 * KvStore (one thread's namespace). Sessions live flat under
 * `session/<id>/`, so forked children coexist with the thread's own
 * session, and pi's conformance suite passes against this backend.
 */

import { Session, SessionError } from "@earendil-works/pi-agent-core";
import type { ForkOptions, SessionCreateOptions, SessionRepo } from "@earendil-works/pi-agent-core";

import { Effect, Option } from "effect";

import { jsonRecords } from "@saku/store";
import type { KvStoreApi } from "@saku/store";
import { SessionState } from "./session-state.ts";
import type { SessionMutation } from "./session-state.ts";
import {
  DoSessionStorage,
  logKey,
  mutationSeq,
  sessionPrefix,
  validateSessionId,
} from "./do-session.ts";
import type { DoSessionMetadata } from "./do-session.ts";

/** The repo over one KvStore (one thread's namespace). */
export class DoSessionRepo implements SessionRepo<DoSessionMetadata> {
  private readonly kv: KvStoreApi;

  constructor(kv: KvStoreApi) {
    this.kv = kv;
  }

  async create(options: SessionCreateOptions = {}) {
    const id = options.id ?? crypto.randomUUID().replaceAll("-", "");
    validateSessionId(id);
    const prefix = sessionPrefix(id);
    // Byte-existence check (raw kv): a corrupt meta still counts as taken,
    // so create never overwrites a foreign session's keys.
    if (Option.isSome(await Effect.runPromise(this.kv.get(`${prefix}meta`)))) {
      throw new SessionError("already_exists", `Session already exists: ${id}`);
    }
    const metadata: DoSessionMetadata = { createdAt: Date.now(), cwd: "", id };
    if (options.parentSessionId !== undefined) {
      metadata.parentSessionId = options.parentSessionId;
    }
    const storage = await DoSessionStorage.create(this.kv, metadata);
    return new Session(storage);
  }

  /**
   * Adopt a parsed pi session (pi-sessions.ts): write its mutations into
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
    validateSessionId(id);
    const prefix = sessionPrefix(id);
    if (Option.isSome(await Effect.runPromise(this.kv.get(`${prefix}meta`)))) {
      throw new SessionError("already_exists", `Session already exists: ${id}`);
    }
    const metadata: DoSessionMetadata = { createdAt: data.createdAt, cwd: data.cwd, id };
    const meta = jsonRecords<DoSessionMetadata>(this.kv, prefix);
    await Effect.runPromise(meta.put("meta", metadata));
    const log = jsonRecords<SessionMutation>(this.kv, prefix);
    await Promise.all(
      data.mutations.map(async (mutation) => {
        await Effect.runPromise(log.put(logKey(mutationSeq(mutation)), mutation));
      }),
    );
    return await this.open(metadata);
  }

  async open(metadata: DoSessionMetadata) {
    return new Session(await DoSessionStorage.load(this.kv, metadata.id));
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
    const prefix = sessionPrefix(metadata.id);
    const keys = await Effect.runPromise(this.kv.list({ prefix }));
    await Promise.all(
      keys.map(async (entry) => {
        await Effect.runPromise(this.kv.delete(entry.key));
      }),
    );
  }

  async fork(source: DoSessionMetadata, options: ForkOptions & SessionCreateOptions) {
    const sourceStorage = await DoSessionStorage.load(this.kv, source.id);
    const childId = options.id ?? crypto.randomUUID().replaceAll("-", "");
    validateSessionId(childId);
    const childPrefix = sessionPrefix(childId);
    if (Option.isSome(await Effect.runPromise(this.kv.get(`${childPrefix}meta`)))) {
      throw new SessionError("already_exists", `Session already exists: ${childId}`);
    }
    const metadata: DoSessionMetadata = {
      // Forks default their parent to the source session (jsonl parity).
      createdAt: Date.now(),
      cwd: "",
      id: childId,
      parentSessionId: options.parentSessionId ?? source.id,
    };
    await Effect.runPromise(
      jsonRecords<DoSessionMetadata>(this.kv, childPrefix).put("meta", metadata),
    );
    const mutations = sourceStorage.forkMutations(options);
    const childStorage = new DoSessionStorage(this.kv, metadata, new SessionState());
    await Promise.all(
      mutations.map(async (mutation) => {
        await childStorage.appendMutation(mutation);
      }),
    );
    childStorage.applyMutations(mutations);
    return new Session(childStorage);
  }
}
