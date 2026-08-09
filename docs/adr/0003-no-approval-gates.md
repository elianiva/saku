# 0003 — No approval gates

Status: accepted

## Context

Should saku interpose human approval on agent actions — gates on tool
calls, HumanLayer-style human-in-the-loop, audit trails of approvals?
Research covered HumanLayer and the managed-agents security-boundary
patterns before this was settled.

## Decision

No approval flow. The agent (pi) does the work; consoles watch and steer
(prompt, abort, steer, follow-up). There is no gate between a tool call and
its execution.

Rationale: approval gates are security theatre for a single-user,
single-machine factory whose execution is already the user's own machine.
The threat they nominally mitigate (an agent taking destructive actions) is
the same user watching the thread operate; blocking tool calls adds an
interaction loop without adding a boundary. This is also consistent with
pi's own philosophy, which saku adopts: minimal, trust the model, extend
only what's needed.

## Consequences

- The wire protocol carries no approval vocabulary, so there is no
  protocol surface to maintain.
- If a gate is ever needed (e.g. destructive wide-scope operations in a
  team setting), pi's `beforeToolCall`/`afterToolCall` hooks are the seam,
  and the extension-UI machinery already carries generic dialogs — the
  wire is unaffected. This is a non-decision by design.
