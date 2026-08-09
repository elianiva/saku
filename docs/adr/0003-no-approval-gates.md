# 0003 — No approval gates (human-in-the-loop is out)

No approval flow for agent actions — no gates on tool calls, no HumanLayer-style human-in-the-loop, no audit trail of approvals. The agent (pi) does the work; consoles watch and steer. Decided after research on HumanLayer and the Anthropic managed-agents security-boundary patterns.

Rationale: approval gates are security theatre for a single-user, single-machine factory whose execution is already the user's own machine. The threat they mitigate (an agent taking destructive actions) is the same user watching the thread operate; blocking tool calls adds an interaction loop without adding a boundary. Also consistent with the pi philosophy saku adopts: minimal, trust the model, extend what's needed.

If a gate is ever needed (e.g., destructive wide-scope operations in a team setting), pi's `beforeToolCall`/`afterToolCall` hooks are the seam; extension UI already carries generic dialogs. The wire protocol is unaffected — this is a non-decision by design.
