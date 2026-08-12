# 0006 — No approval gates

Status: accepted

## Context

Carried over unchanged from the original spine: the factory's agents act without per-action approval.

## Decision

No approval gates in the worker. A thread's hands (env) are trusted by construction — `mode: local` is the owner's own machine, `mode: sandbox` is a first-party Box with the owner's credentials. Steering/follow-up are the control surfaces (pi's `steer`/`follow_up` vocabulary), not gates. If gates ever exist, they are a console concern, not a worker one.

## Consequences

- Simpler worker; the trust boundary is the env, not a permission UI.
