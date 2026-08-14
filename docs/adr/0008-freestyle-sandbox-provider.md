# 0008 — Freestyle is the sandbox provider; Box is incomplete

Status: accepted

## Context

ADR 0003 picked ascii.dev **Box** as the sandbox provider. The Box integration was never
validated end-to-end in production (the integration suite exercises the static
provisioner; the Box path needs a live `BOX_API_KEY`) — it is **incomplete**, not the
finished production shape.

The budget is a hard **$20/month for everything** (control plane + sandbox), and real
usage is ~5–6 h/day of agent runtime (~165 active hours/month). A research pass
(`docs/research/rivet-agentos-vs-cloudflare.md`) costed every candidate at that usage:

| Sandbox | $/mo at ~165 h/mo | Notes |
| --- | --- | --- |
| **freestyle.sh Free** | **~$0–4** | full Linux VMs (root, Docker, nested KVM), suspend/resume (only storage billed while idle), sub-700 ms cold start, 20 vCPU-h + 40 GiB-h per day included, 10 concurrent VMs |
| box (ascii.dev) | $20 flat | 555 h/mo of 4 vCPU/8 GB — fits but consumes the whole budget; integration incomplete |
| VPS static daemon | ~$5–8 | saku's existing `SAKU_ENV_PROVISIONER=static` shape; you own ops, one shared sandbox |
| E2B | ~$10–18 | worse per-hour than Freestyle's free allowance |
| CF Sandbox | ~$18–32 | ~$0.36/h for 4 vCPU/8 GB — worst value |
| Rivet Cloud + agentOS | $31–40 | metered compute ~$0.124/vCPU-h; agentOS is beta and lacks Docker/apt/native binaries |

## Decision

**Freestyle (freestyle.sh) is the sandbox provider.** The Box integration is marked
**incomplete** — kept selectable for development/parity, but not the production path.

- The deployment selects it with `SAKU_ENV_PROVISIONER=freestyle` and a
  `FREESTYLE_API_KEY` secret. Until the freestyle backend lands, setting the var
  **fails loudly at hub build** (no silent Box fallback).
- `SAKU_ENV_PROVISIONER=static` remains the dev/celld shape; `box` remains the
  fallback default until the freestyle backend is production-verified.

### The freestyle backend (in preparation)

The hub's `EnvProvisioner` seam is unchanged — the backend maps onto it 1:1, the same
way `Provisioner.make` (Box) does:

1. **ensure (fresh)** — lazily create one VM per sandbox thread on first use
   (`freestyle.vms.create`; default 4 vCPU / 8 GB / 20 GB; free tier allows 10
   concurrent), tag it with `SAKU_THREAD_ID`.
2. **bootstrap the env daemon into the VM** — the Box-path recipe, minus ascii
   specifics: write the embedded daemon bundle + run script through the VM filesystem
   API, ensure node ≥ 26, and start the daemon under a supervisor (systemd unit — full
   Linux VMs have systemd — so the daemon survives suspend/resume), then probe the env
   protocol's hello before declaring `ready`.
3. **ensure (resume)** — resume the suspended VM, wait for it, re-probe (re-read the
   URL if it moved).
4. **release** — suspend the VM (idle-stop trigger, thread deletion) — the Freestyle
   equivalent of Box's stop/snapshot; only storage is billed while suspended.
5. **reachability** — the worker must dial the env daemon over its streaming socket.
   Freestyle exposes VM ports via public domain mappings; whether a mapped hostname is
   the right transport (latency, throughput, TLS) is an **open item to verify before
   implementation**.

### Prerequisites (blocking a real backend)

- A Freestyle account + API key to validate against (the hub's provisioner is built on
  injectable fetch, so the API client is unit-testable without one, but end-to-end
  verification needs a live account).
- Confirm: behavior past the free daily caps (billed overage vs hard block), and the
  VM-port reachability mechanism for the daemon socket.
- Free-tier constraints to design around: daily caps (20 vCPU-h / 40 GiB-h) do not roll
  over, no custom VM sizing on Free, no mid-tier below $50/mo.

## Consequences

- Sandbox spend drops from $20/mo (Box) to **~$0–4/mo** at the current usage (a hair
  over the daily caps at 5.5+ h/day of a default 4 vCPU/8 GB VM → small billed
  overage; ≤5 h/day is $0).
- Full-VM fidelity is kept — Docker, native binaries, root — no agentOS-style
  restrictions on what a thread's hands can do.
- Idle-stop semantics are preserved: suspend/resume instead of snapshot stop/resume,
  with sub-700 ms cold starts (faster than Box's snapshot resume).
- Risks accepted: Freestyle is a young vendor with visible pricing churn; the free
  tier is daily-capped with no rollover; thread workspaces live on Freestyle's
  infrastructure (same trust class as Box).
- `BOX_API_KEY` stays wired for parity; `FREESTYLE_API_KEY` joins it as a deployment
  secret (Cloudflare secret binding; celld plaintext var, trust domain).
