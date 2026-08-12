# 0007 — Hub-hosted skills store (amp-style)

Status: accepted

## Context

pi loads skills from `.pi/` and `~/.pi/agent/` on the machine. A worker in a Box has neither — so for sandbox threads, the hub is the only place skills can come from. The management model follows amp's global plugins and skills: hosted, scoped, importable, agent-manageable.

## Decision

The hub owns a **skills store** with `personal` and `workspace` scopes (workspace = pushable, loaded by default for everyone). Skills are imported from repos, updated, and loaded by every worker from the hub; a thread's repo `.pi/` still contributes in place. The wire carries the minimal ops now (`list_skills` · `import_skill` · `delete_skill`); versioning, sharing UX, and live reload are the frontend pass. The store's records keep `source` + `version` fields from day one so those don't paint us into a corner.

## Considered Options

- Filesystem loading only (pi's own model) — rejected: impossible for Box-env threads, which are the point of the rework.
- Full management surface now — rejected: working-first; the frontend pass owns the UX.

## Consequences

- Skills provisioning is a hub concern and a first-class wire surface, not an env concern.
