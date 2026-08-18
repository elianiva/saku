/**
 * TrailSession (trail-session.ts): the Effect adapter over pi-agent-core's
 * `Session`. pi's Session is promise-based (its conformance suite demands it);
 * this module wraps every async method once so callers upstream (the machine,
 * the host value, the agent-event projection) work with Effects directly.
 *
 * Built once in `SessionHost.create`; never re-created per call.
 */

import { Effect } from "effect";
import type {
  AgentMessage,
  Entry,
  IdGenerator,
  LogItem,
  OperationStartedRecord,
  ProvisionedEntry,
  SessionStats,
} from "@earendil-works/pi-agent-core";
import type { Session } from "@earendil-works/pi-agent-core";

import { SessionHostError, toSessionHostError } from "./session-host-error.ts";

/** pi's Session wrapped in Effects — the single promise→Effect boundary. */
export interface TrailSession {
  /** The session's entry-id generator (sync — pi's `Session.idGenerator`). */
  readonly idGenerator: IdGenerator;
  readonly getLog: (options?: { afterSeq?: number }) => Effect.Effect<LogItem[], SessionHostError>;
  readonly findOpenOperations: (
    lane: string,
    options?: { limit?: number },
  ) => Effect.Effect<OperationStartedRecord[], SessionHostError>;
  readonly appendEntry: (
    entry: ProvisionedEntry<Entry>,
    lane: string,
  ) => Effect.Effect<Entry, SessionHostError>;
  readonly getLeafId: () => Effect.Effect<string | null, SessionHostError>;
  readonly getEntry: (
    id: string,
  ) => Effect.Effect<Entry | undefined, SessionHostError>;
  readonly moveLane: (
    lane: string,
    entryId: string | null,
  ) => Effect.Effect<void, SessionHostError>;
  readonly getStats: () => Effect.Effect<SessionStats, SessionHostError>;
  readonly getName: () => Effect.Effect<string | undefined, SessionHostError>;
  readonly setName: (name: string) => Effect.Effect<void, SessionHostError>;
  readonly appendMessage: (
    message: AgentMessage,
  ) => Effect.Effect<string, SessionHostError>;
}

/** Wrap a pi Session so every async method returns an Effect. */
export const makeTrailSession = (session: Session): TrailSession => ({
  idGenerator: session.idGenerator,
  appendEntry: (entry, lane) =>
    Effect.tryPromise({ catch: toSessionHostError, try: () => session.appendEntry(entry, lane) }),
  appendMessage: (message) =>
    Effect.tryPromise({ catch: toSessionHostError, try: () => session.appendMessage(message) }),
  findOpenOperations: (lane, options) =>
    Effect.tryPromise({ catch: toSessionHostError, try: () => session.findOpenOperations(lane, options) }),
  getEntry: (id) => Effect.tryPromise({ catch: toSessionHostError, try: () => session.getEntry(id) }),
  getLeafId: () => Effect.tryPromise({ catch: toSessionHostError, try: () => session.getLeafId() }),
  getLog: (options) => Effect.tryPromise({ catch: toSessionHostError, try: () => session.getLog(options) }),
  getName: () => Effect.tryPromise({ catch: toSessionHostError, try: () => session.getName() }),
  getStats: () => Effect.tryPromise({ catch: toSessionHostError, try: () => session.getStats() }),
  moveLane: (lane, entryId) =>
    Effect.tryPromise({ catch: toSessionHostError, try: () => session.moveLane(lane, entryId) }),
  setName: (name) => Effect.tryPromise({ catch: toSessionHostError, try: () => session.setName(name) }),
});
