/**
 * Agent-event projection (agent-events.ts): pi's `AgentEvent`s, made
 * durable (`message_end` appends into the trail, ADR 0001) and projected
 * onto the wire — the same stripping pi's own shell applies. The seam
 * keeps pi's event vocabulary out of the machine and the host value.
 */

import { Effect, Ref } from "effect";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { SessionWireEvent } from "@saku/wire";

import type { HostDeps } from "./session-machine.ts";
import { toSessionHostError, type SessionHostError } from "./session-host-error.ts";

/**
 * pi's durable-session check rejects explicit `undefined`-valued keys, and
 * pi's tool results legitimately carry them (a bash result without
 * truncation has `details: undefined`). pi's JSONL backends silently dropped
 * such keys on stringify; the DO-storage repo made the loss explicit. Drop
 * them up front so the committed payload matches what JSONL would have
 * stored (ADR 0001: the trail is the wire's contract, not the memory shape).
 */
const stripUndefined = <A>(value: A): A => {
  if (Array.isArray(value)) {
    return value.map((item) => stripUndefined(item)) as A;
  }
  if (typeof value === "object" && value !== null) {
    const next: Record<string, unknown> = {};
    for (const [key, candidate] of Object.entries(value)) {
      if (candidate !== undefined) next[key] = stripUndefined(candidate);
    }
    return next as A;
  }
  return value;
};

/** Pi's agent events: durable appends on message_end, then wire projection. */
export const handleAgentEvent = Effect.fn("handleAgentEvent")(function* (
  deps: HostDeps,
  event: AgentEvent,
) {
  if (event.type === "message_end") {
    const message = event.message;
    if (message.role === "user" || message.role === "assistant" || message.role === "toolResult") {
      const entryId = yield* Effect.tryPromise({
        try: () => deps.session.appendMessage(stripUndefined(message)),
        catch: toSessionHostError,
      });
      const entry = yield* Effect.tryPromise({
        try: () => deps.session.getEntry(entryId),
        catch: toSessionHostError,
      });
      if (entry !== undefined) {
        deps.sink({ type: "entry_appended", entry });
      }
    }
    if (message.role === "assistant") {
      yield* Ref.set(deps.lastAssistantRef, message as AssistantMessage);
    }
  }

  const projected = projectAgentEvent(event);
  if (projected !== null) {
    deps.sink(projected);
  }
});

/**
 * Project a pi AgentEvent onto the wire: `agent_end` is replaced by saku's
 * `settled`; `message_update` drops the cumulative `partial` snapshot.
 */
const projectAgentEvent = (event: AgentEvent) => {
  if (event.type === "agent_end") return null;
  if (event.type === "message_update") {
    const assistantMessageEvent = event.assistantMessageEvent;
    if ("partial" in assistantMessageEvent) {
      const { partial: _partial, ...rest } = assistantMessageEvent;
      void _partial;
      return { ...event, assistantMessageEvent: rest } as SessionWireEvent;
    }
    return event as SessionWireEvent;
  }
  return event as SessionWireEvent;
};
