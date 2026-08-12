# 0005 — Pi-only

Status: accepted

## Context

The original project's founding rule, carried over unchanged: saku is a control plane for pi coding agents, not a generic agent platform.

## Decision

No generic agent layer. The worker embeds pi-agent-core directly; the wire is a projection of pi's own session model (its `AgentEvent`/`Entry` types, its vocabulary); skills and prompt templates are pi's extension system. Never invent parallel concepts — if pi has a word for it, use pi's word. If pi lacks it (threads, envs), add it as a thin saku layer on the same seams.

## Consequences

- Integration depth is the product: whatever pi grows (new tools, models, session machinery) saku inherits by construction.
- Shell-only surfaces of pi (extension UI, slash commands, extension-provided models) are cut until a wire seam exists for them.
