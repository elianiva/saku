/**
 * Agent-event projection (agent-events.ts): pi's `AgentEvent`s, made
 * durable (`message_end` appends into the trail, ADR 0001) and projected
 * onto the wire — the same stripping pi's own shell applies. The seam
 * keeps pi's event vocabulary out of the machine and the host value.
 */

import { Effect, Ref, Schema } from "effect";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import type { SessionWireEvent } from "@saku/wire";

import type { HostDeps } from "./session-machine.ts";

/** Whether the round-tripped value kept its message role (the strip's typed boundary). */
const isMessage = (
  value: Schema.Json | UserMessage | AssistantMessage | ToolResultMessage,
): value is UserMessage | AssistantMessage | ToolResultMessage =>
  typeof value === "object" &&
  value !== null &&
  "role" in value &&
  (value.role === "user" || value.role === "assistant" || value.role === "toolResult");

/**
 * pi's durable-session check rejects explicit `undefined`-valued keys, and
 * pi's tool results legitimately carry them (a bash result without
 * truncation has `details: undefined`). pi's JSONL backends silently dropped
 * such keys on stringify; the DO-storage repo made the loss explicit. The
 * JSON round-trip commits exactly what the JSONL backend would have stored
 * (ADR 0001: the trail is the wire's contract, not the memory shape).
 */
const stripUndefined = (message: UserMessage | AssistantMessage | ToolResultMessage) =>
  Effect.gen(function* () {
    // The two-step round-trip is deliberate: stringify drops undefined-valued
    // keys (pi's JSONL parity); a plain clone would keep them.
    const serialized = JSON.stringify(message);
    const raw: unknown = JSON.parse(serialized);
    const parsed = yield* Schema.decodeUnknownEffect(Schema.Json)(raw);
    if (!isMessage(parsed)) {
      return yield* Effect.die(new Error("message lost its shape in the JSON round-trip"));
    }
    return parsed;
  });

/**
 * Project a pi AgentEvent onto the wire: `agent_end` is replaced by saku's
 * `settled`; `message_update` drops the cumulative `partial` snapshot. The
 * return type is the wire's projection (session.ts's `SessionWireEvent`),
 * so the compiler proves each branch keeps the wire's shape.
 */
const projectAgentEvent = (event: AgentEvent): SessionWireEvent | null => {
  if (event.type === "agent_end") {
    return null;
  }
  if (event.type === "message_update") {
    const { assistantMessageEvent } = event;
    if ("partial" in assistantMessageEvent) {
      // Dropping `partial` narrows the event to the wire's message_update
      // shape (no cumulative snapshot) — the same strip the wire's type
      // applies (`StripPartial` in session.ts).
      const { partial: _partial, ...rest } = assistantMessageEvent;
      void _partial;
      return { ...event, assistantMessageEvent: rest };
    }
    // A message_update without a partial snapshot is already the wire's shape.
    return event;
  }
  // The remaining agent events are the wire's session events verbatim
  // (entry_appended/settled/compaction_start/...).
  return event;
};

/** Pi's agent events: durable appends on message_end, then wire projection. */
export const handleAgentEvent = Effect.fn("handleAgentEvent")(function* (
  deps: HostDeps,
  event: AgentEvent,
) {
  if (event.type === "message_end") {
    const { message } = event;
    if (message.role === "user" || message.role === "assistant" || message.role === "toolResult") {
      const stripped = yield* stripUndefined(message);
      const entryId = yield* deps.trail.appendMessage(stripped);
      const entry = yield* deps.trail.getEntry(entryId);
      if (entry !== undefined) {
        deps.sink({ entry, type: "entry_appended" });
      }
    }
    if (message.role === "assistant") {
      yield* Ref.set(deps.lastAssistantRef, message);
    }
  }

  const projected = projectAgentEvent(event);
  if (projected !== null) {
    deps.sink(projected);
  }
});
