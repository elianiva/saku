# Research: Rivet + agentOS vs Cloudflare Workers/DOs + separate sandbox

> **Decision status**: this research is the evidence base for **ADR 0008** —
> Freestyle (freestyle.sh) is the sandbox provider of record; the ascii.dev Box
> integration is marked incomplete. The codebase is prepared for the freestyle
> backend (`SAKU_ENV_PROVISIONER=freestyle` + `FREESTYLE_API_KEY`; fails loudly
> until the backend lands).

**Question**: Is Rivet (rivet.dev) + agentOS a better fit for saku than the current
Cloudflare Workers + Durable Objects + ascii.dev Box stack, given a hard budget of
**$20/month for everything** (control plane + sandbox + all infra)?

**Date**: researched from primary sources; all claims cite their source.
**Bottom line up front**: agentOS is a genuinely better _sandbox_ fit (runs Pi, kills the
Box bill, in-process with the thread actor), but **Rivet Cloud compute is premium-priced**
(~$0.12/vCPU-hour vs ~$0.009 for Box) — the "$20 Hobby" is a floor, not a cap, and the
real bill grows with agent runtime. The best-value shapes are: **Rivet Cloud Free +
agentOS ($0/mo, light use)**, **self-hosted Rivet/agentOS on a $5–6 VPS (~$6/mo, unlimited)**,
or keeping the current **CF-free control plane and swapping the Box for an agentOS sidecar
on a $5 VPS** (same wire, ~$5/mo, lowest-risk experiment).

---

## 1. What the candidates are

### Rivet (rivet.dev) — the actor platform

- Open-source (Apache 2.0) **actor platform** — stateful, durable, per-entity compute units
  with WebSockets, timers, events, per-actor SQLite. The same mental model as Durable
  Objects; Rivet's own docs position it as a portable, open-source DO alternative
  (self-hostable on Kubernetes/VPS/cloud; "bring your own compute" on Vercel, Railway,
  Cloudflare Workers, AWS, bare metal) [1][2][3].
- **Rivet Cloud** = managed hosting (free/Hobby/Team plans + metered usage).
  **Rivet Compute** (June 2026) = the serverless compute substrate for actors, billed per
  active second [4][5].
- Company: Rivet Gaming, Inc. (the rivet.gg game-backend team), YC/a16z Speedrun backed [6].

### agentOS (agentos-sdk.dev, `@rivet-dev/agentos`) — the sandbox replacement

- Open-source (Apache 2.0) **virtual operating system for agents, as a library**: each
  agent gets a V8-isolate + WebAssembly VM with a POSIX-compliant virtual kernel
  (filesystem, processes, pipes/PTYs, sockets, permissions). ~6 ms cold start, tens of MB
  per VM, up to 10 GB persistent FS per agent that survives sleep/wake [7][8][9].
- Runs **Pi, Claude Code, Codex, and OpenCode** via ACP adapters; Pi is officially packaged
  as `@agentos-software/pi` (spawns `@earendil-works/pi-coding-agent/dist/cli.js`) [10][11].
- Software registry (42 packages, WASM-compiled): `git, sh, coreutils, grep, sed, gawk,
findutils, curl, wget, jq, yq, fd, ripgrep, sqlite3, duckdb, vim, tar, unzip, zip,
diffutils, ssh, build-essential, common, everything`, the agents (`pi`, `pi-cli`,
  `claude`, `codex`, `opencode`) [12]. Node.js runs natively on V8 (full JIT), Bash and
  Python run inside the VM [13].
- **Hybrid sandboxing**: agentOS can lazily mount a full external sandbox (provider-
  agnostic) for heavy workloads — browsers, native binaries, heavy compilation [14][15].
- Deploys three ways: **Rivet Cloud (managed)**, **self-hosted Rivet**, or **Direct VM
  API** embedded in any Node.js backend [16].
- **Status: beta — "agentOS is beta and still undergoing security review"** [17].

### The current stack (the baseline)

- Control plane: one Cloudflare Worker with `HUB` + `THREAD` Durable Object namespaces,
  deployed via alchemy; celld as the self-hosted twin (ADR 0002) [18].
- Sandbox: ascii.dev **Box** — one full Ubuntu VM (4 vCPU / 8 GB / 50 GB, Docker, SSH,
  snapshots) per sandbox-mode thread, lazy-provisioned by the hub, idle-stopped (ADR 0003) [19][20].

---

## 2. Pricing (primary sources, as researched)

### Cloudflare (control plane)

|                  | Workers Free                                                     | Workers Paid                                                 |
| ---------------- | ---------------------------------------------------------------- | ------------------------------------------------------------ |
| Workers requests | 100,000/day (account-wide)                                       | unlimited, $0.30/M                                           |
| DO requests      | 100,000/day (includes WS messages, 20:1 ratio for incoming)      | 1M/mo incl., +$0.15/M                                        |
| DO duration      | 13,000 GB-s/day (≈28 h/day of active DO processing at 128 MB)    | 400k GB-s/mo incl., +$12.50/M GB-s                           |
| DO storage       | 5 GB total                                                       | 5 GB-month incl., +$0.20/GB-mo                               |
| DO rows          | 5M reads/day, 100k writes/day                                    | 25B reads, 50M writes incl., +$0.20/M reads, +$1.00/M writes |
| Notes            | SQLite-backed DOs only; **WS Hibernation API available on Free** | $5/mo minimum                                                |

Sources: [21][22][23]. With hibernation, idle DOs cost ~$0; a personal project easily
fits Free. Exceeding a Free limit = hard error (not a bill).

### Sandbox options

| Provider                            | Rate                                                                                                              | Notes                                                                    |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| **box (ascii.dev)**                 | **$20/mo minimum → 555 h of 4 vCPU/8 GB (~$0.036/h)**, per-second, snapshot stop/resume, 7-day trial              | cheapest real-VM sandbox; flat monthly, shared across boxes [24][25][26] |
| E2B                                 | $0.0504/vCPU-h + $0.0162/GiB-h (2 vCPU/512 MiB ≈ $0.109/h)                                                        | per-second; one-time $100 free credits [27][28]                          |
| **Cloudflare Sandbox** (Containers) | Workers Paid only; **$0.000020/vCPU-s + $0.0000025/GiB-s → 4 vCPU/8 GB ≈ $0.36/h**; 25 GiB-h + 375 vCPU-min incl. | ~10× box per hour; also billed for the controlling Worker/DO [29][30]    |

### Rivet Cloud

|                                   | Free                      | Hobby                                                                                     | Team            |
| --------------------------------- | ------------------------- | ----------------------------------------------------------------------------------------- | --------------- |
| Price                             | **$0/mo**                 | **$20/mo + usage**                                                                        | $200/mo + usage |
| Awake Actor Hours                 | 100,000/mo hard cap       | 400,000/mo incl.                                                                          | same            |
| Compute                           | **$5/mo cap** (hard)      | usage-based, **no included amount**                                                       | usage-based     |
| Max vCPU / actor                  | 1                         | 8                                                                                         | 8               |
| Storage / reads / writes / egress | 5 GB / 200M / 5M / 100 GB | 5 GB / 25B / 50M / 1 TB                                                                   | same            |
| Overage                           | —                         | awake actors $0.05/1k h; storage $0.40/GB-mo; reads $0.20/M; writes $1/M; egress $0.15/GB | —               |

**Compute metering** (the number that matters): billed per active second, ~
`$0.0000330/vCPU-s + $0.0000029/GiB-s`:

- 1 vCPU / 512 MiB → **~$0.124/h**
- 0.5 vCPU / 512 MiB → ~$0.065/h
- Sleeping actors are **not** billed for compute [4][31][32].

For reference: their own estimator quotes $12.40/mo for 100 h of 1 vCPU/512 MiB [31].

---

## 3. Cost modeling for saku at ≤$20/mo

Assumptions: personal use; agents actually run ~1–4 h/day (30–120 h/mo); actors/threads
sleep when idle (saku already has idle-stop semantics; Rivet actors sleep natively).

| Path                                                     | Monthly bill           | What you get                                                                       | Fit at $20                                                                   |
| -------------------------------------------------------- | ---------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| **A. CF Free + Box** (current)                           | **$20 flat**           | 555 h/mo of 4 vCPU/8 GB VM-time; CF free caps (100k req/day)                       | ✅ exactly $20; most compute headroom per dollar                             |
| **B. CF Paid + Box**                                     | $25                    | lifts CF caps                                                                      | ❌ over budget                                                               |
| **C. CF Free + E2B**                                     | ~$0 + usage            | $0.109/h for 2 vCPU/0.5 GiB → $3–13/mo at 30–120 h                                 | ✅ possible, but worse per-hour than Box                                     |
| **D. CF Free + CF Sandbox**                              | ~$0 + usage            | $0.36/h at 4 vCPU/8 GB → $11–43/mo                                                 | ⚠️ only at light usage; worst value per hour                                 |
| **E. Rivet Cloud Free + agentOS**                        | **$0**                 | $5/mo compute cap ≈ 40 h/mo at 1 vCPU (or ~160 h at 0.25 vCPU); 100k awake actor-h | ✅ best if runs ≲1 h/day                                                     |
| **F. Rivet Cloud Hobby + agentOS**                       | **$20 + compute**      | 30 h/mo at 0.5 vCPU → ~$22; 100 h/mo → ~$26–32                                     | ⚠️ only fits $20 at light usage — compute is metered with no included amount |
| **G. Self-hosted Rivet + agentOS on a VPS**              | **~$5–6** (Hetzner/DO) | everything: hub, threads, agentOS sidecars; unlimited within the VPS               | ✅ cheapest unlimited; you own ops (updates, uptime, backups)                |
| **H. CF Free control plane + agentOS sidecar on $5 VPS** | **~$5–6**              | keep DOs and the wire as-is; Box replaced by an agentOS VM pool on the VPS         | ✅ lowest-risk way to test agentOS; sandbox spend $20 → ~$5                  |

Key asymmetry: **Rivet Cloud compute (~$0.124/vCPU-h) is ~13× Box's effective per-vCPU
rate (~$0.009)** and ~2.4× E2B's ($0.0504) [24][27][31]. Rivet's economics only work
because actors *sleep* (idle = $0). Long-running agents on Rivet Cloud compute will eat
the budget; agentOS's "254× cheaper than sandboxes" claim [8] compares per-VM overhead
inside an actor, but the _actor's_ compute is what's metered.

---

## 3b. Cost modeling at the user's real usage (5–6 h/day of coding agents)

~5.5 h/day × 30 = **~165 active agent-hours/month**. This changes the verdicts from §3
significantly:

| Path                                         | Monthly bill @ 165 h/mo                                                                                                                                                  | Fits $20?                      |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------ |
| **A. CF Free + Box** (current)               | **$20 flat** — 165 h of the 555 h included (30% utilization)                                                                                                             | ✅ exactly                     |
| **E. Rivet Cloud Free + agentOS**            | $5/mo compute hard cap ≈ 40 h/mo at 1 vCPU, ~77 h at 0.5, ~143 h at 0.25 — **breaks mid-month** (hard errors, not a bill)                                                | ❌                             |
| **F. Rivet Cloud Hobby + agentOS**           | $20 + 165 h × $0.124/h (1 vCPU) ≈ **$40/mo**; ~$31 at 0.5 vCPU; ~$26 at 0.25 vCPU (painfully slow)                                                                       | ❌                             |
| **H′. CF Free + static env daemon on a VPS** | **~$5–8/mo** (Hetzner CX22 2 vCPU/4 GB €4.49 ≈ $5.2; CX33 4 vCPU/8 GB €6.49 ≈ $7.5, EU prices [47]) — saku's existing `SAKU_ENV_PROVISIONER=static` shape, zero new code | ✅ best value                  |
| **G. Self-hosted Rivet + agentOS on a VPS**  | ~$5–8/mo + agentOS beta/no-Docker/native-binary limits + env-daemon packaging work                                                                                       | ✅ but more work than H′       |
| **C. CF Free + E2B**                         | ~$10–18/mo (1–2 vCPU configs)                                                                                                                                            | ✅ but worse per-hour than Box |
| **D. CF Free + CF Sandbox**                  | $5 Workers Paid + 2 vCPU/2 GB ≈ $0.16/h × 165 ≈ **$32/mo**; only the weak 1 vCPU/1 GB config (~$18) fits                                                                 | ⚠️/❌                          |

Key insight: at this usage level, **Rivet Cloud's metered compute is the wrong economics**
($0.124/vCPU-h vs box's effective $0.009). The cheap compute lives on a **plain VPS** —
and saku already ships a static-provisioner shape that points the CF deployment at one
env daemon URL [48][49]. A CX33-class VPS (4 vCPU/8 GB, ~$7.5) is box's spec at 37% of
box's price, with full Linux (Docker/apt/native binaries) and no agentOS beta risk. The
tradeoff: one shared sandbox for all threads (no per-thread isolation/snapshots — fine
for a single-person daily workflow), the daemon must be reachable by the worker (public
URL + token, same trust model as `mode: local`), and you own patching/backups/uptime.

CF Free request limits at this usage: comfortably fine — incoming WS messages bill at a
20:1 ratio and outgoing WS messages are free; a heavy day of streaming stays in the low
thousands of billing requests against the 100k/day account cap [22][23].

## 3c. Freestyle (freestyle.sh) — the new sandbox contender

**What it is**: managed infrastructure for code your product runs but didn't write —
**full Linux VMs** (real root, systemd, Docker, nested KVM) + multi-tenant **Git** for
agent filesystems. YC company, ex-Apple founders [50][51]. VMs provision warm in <6 ms,
cold boot sub-700 ms, **live forking ~400 ms**, and **suspend/resume** (hibernate a VM;
only storage is billed while suspended; resume via API, SSH, or network activity) [52][53].
TypeScript/Python SDKs + MCP support [54].

**Pricing (verified on the pricing page) [55]:**

|                            | Free                                          | Hobby                        | Pro                   |
| -------------------------- | --------------------------------------------- | ---------------------------- | --------------------- |
| Price                      | **$0 forever**                                | $50/mo + usage               | $500/mo + usage       |
| Concurrent VMs             | 10                                            | 40                           | 400                   |
| Included (per day)         | **20 vCPU-h, 40 GiB-h, 16,800 GiB-h storage** | —                            | —                     |
| Custom VM sizing           | ✗ (default 4 vCPU / 8 GB / 20 GB only)        | up to 8 vCPU / 16 GB / 32 GB | up to 32 vCPU / 64 GB |
| Persistent VMs / snapshots | ✗ / 50 saved VMs                              | ✓ / 1,000                    | ✓ / 12,000            |

Usage rates (beyond included): vCPU **$0.04032/h**, GiB memory **$0.0129/h**, GiB
storage $0.000086/h [55]. Exceeding the free daily allowance transitions to paid usage
(usage-based model) [52][56].

**Cost at the user's 5–6 h/day (≈165 h/mo), default 4 vCPU/8 GB VM:**

- 4 vCPU × 5.5 h = **22 vCPU-h/day vs 20 included**; 8 GiB × 5.5 h = **44 GiB-h/day vs 40
  included** — a hair over on 5.5+ h days.
- Overage if billed: ~60 vCPU-h + ~120 GiB-h per month ≈ **$2.4 + $1.5 ≈ $4/mo**.
- At exactly ≤5 h/day: **$0/mo**. Storage free allowance ≈ 700 GiB always-on — a handful
  of 20 GB VMs is negligible.
- Worst case (no allowance at all): 165 h × (4×$0.04032 + 8×$0.0129) ≈ **$44/mo** — the
  daily included amounts are load-bearing; there is **no mid-tier between $0 and $50**.

**Fit for saku** (Freestyle is a _sandbox_ provider, not a control plane — it replaces
**box**, not Cloudflare):

- **Zero-code path**: run the env daemon inside one Freestyle VM and use the existing
  `SAKU_ENV_PROVISIONER=static` shape; VMs are reachable via public domain mappings
  (hostname → VM port), so the worker can dial the daemon [57]. One shared sandbox.
- **Proper path**: add a `freestyle` backend to the hub's provisioner seam (today:
  `box` | `static`) — lazy-create one VM per thread, bootstrap the env daemon, hibernate
  on idle-stop, resume on the next prompt. Maps 1:1 onto saku's existing provisioning
  loop + idle-stop alarm; the freestyle TS SDK covers create/exec/fs/start/stop [58].
- Freestyle Git (commits, diffs, rollback, GitHub sync) could later back thread
  workspaces — optional, not required.

**Risks**: young startup with pricing churn (plans added/removed/changed per PulseSignal
[59]); free tier is daily-cap (no rollover) and forbids custom sizing; overage behavior
needs confirming (bills vs hard block); agent code lives on their infra (same trust
class as box); streaming socket latency/throughput of the daemon through their
networking needs a real test.

## 4. Fit analysis for saku

### Concepts that map 1:1 (Rivet Actors ≈ DOs)

- **Hub → one actor; Thread → one actor per thread** — "one actor per agent, per session"
  is literally Rivet's pitch [33].
- **DO storage → per-actor SQLite** (injected automatically into actor deployments) [34] —
  the `KvStore` seam (memory/file/DO backends) would gain an actor-SQLite backend.
- **DO alarm (idle-stop) → actor scheduling/timers** [35].
- **Wire over WS → native actor WebSockets with hibernation**: "idle WebSockets require no
  compute — actors sleep while keeping client WebSockets open, waking on message" [36].
  This covers both the console attach and the env-daemon relay shapes.
- **`thread_changed` fan-out → actor events/broadcast** [37].
- **celld twin → self-hosted Rivet** (open source, Apache 2.0, `docker run rivetdev/engine`
  or Kubernetes) [38]. Local dev is simpler: `rivetkit dev` runs actors in-process [39].
- Plain TypeScript/Node runtime (effect stack maps directly); edge networking on Rivet
  Cloud _and_ Cloudflare Workers [3].

### What agentOS replaces (the Box)

- **Box provisioning API/key, lazy-provision loop, idle-stop timer, snapshot/resume →
  built-in**: the thread actor boots its agentOS VM lazily on first action, disposes on
  sleep; the FS (≤10 GB) persists and survives sleep/wake [9][40]. The hub's Box
  provisioning machinery and `BOX_API_KEY` go away.
- **The env daemon runs inside the VM**: agentOS runs Node natively on V8, Bash via its
  WASM suite, and ships git/curl/ssh/jq/… in its registry — the daemon's tool surface
  (read/bash/edit/write) works in-VM [12][13]. Pi itself runs officially (`@agentos-software/pi`),
  so the deepest shape (worker actor drives pi in-VM via ACP) is supported [10][11].
- **The wire stays**: the env daemon's streaming protocol to the worker is unchanged if the
  daemon is packaged as agentOS software (`defineSoftware` + aospkg toolchain) [41].

### agentOS limitations that bite (vs a full-VM Box)

From the official limitations page [42]:

- **No Docker, no container runtimes; no apt/yum; no arbitrary native binaries** — the
  registry is the only software source (Go/Rust/C++ toolchains are _not_ in it).
- **No kernel modules/eBPF, no file watching (`inotify`/`fs.watch`), no GPU/USB/hardware.**
- Native npm deps (`sharp`, `better-sqlite3`, `playwright`), browsers, and heavy builds
  require the **external-sandbox hybrid** (beta, provider-agnostic) [14][15].
- Consequence for saku: sandbox threads doing real repo work (pnpm/npm installs with
  native deps, Docker builds, Playwright) will hit walls inside the VM. The Box has none
  of these limits (Docker included, dedicated IPv4, 60 fps desktop) [24][26].

### Risks

- **agentOS is beta and explicitly still under security review** — it _is_ the security
  boundary (untrusted agent code), so this is the product's load-bearing surface [17].
- **Rivet is young and fast-moving**: pricing/limits changed repeatedly 2024–2026
  (free-tier credit → usage → plan tiers; Rivet Compute launched June 2026) [4][43].
- **Hobby's $20 is a floor**: compute is usage-based with no included amount [31].
- **Verification needed**: npm presence in the VM is implied (MCP package installs [44])
  but **pnpm is not in the registry** — saku's own toolchain is pnpm-based; the env daemon
  would need its node_modules packaged via the agentOS toolchain regardless [41][45].
- Migration cost: new deploy target (rivetkit), `KvStore` backend, alarm→timer mapping,
  relay re-verification, and the integration suite (currently deploys to local workerd) [46].
  Frontend hosting is a non-issue either way (CF static assets are free).

---

## 5. Tradeoff summary

| Dimension                 | CF + Box (current)                            | Rivet Cloud + agentOS                                          | Self-hosted Rivet + agentOS |
| ------------------------- | --------------------------------------------- | -------------------------------------------------------------- | --------------------------- |
| Price @ typical use       | $20 flat (CF free)                            | $0–$32 depending on runtime h                                  | ~$5–6/mo                    |
| Control-plane maturity    | battle-tested, free tier                      | young but production-scale (multi-M player game backends)      | you own ops                 |
| Sandbox fidelity          | full Ubuntu VM, Docker, IPv4                  | POSIX VM: no Docker/apt/native binaries; hybrid sandbox (beta) | same as Rivet Cloud         |
| Sandbox cost              | $20/mo for 555 h                              | metered as actor compute (cheap only when sleeping)            | VPS-sized                   |
| Cold start (sandbox mode) | seconds (snapshot resume)                     | ~6 ms                                                          | ~6 ms                       |
| Lock-in                   | CF proprietary + box                          | Apache 2.0, self-hostable                                      | none                        |
| Ops surface               | provisioning API keys, idle-stop loop (built) | none (built into actors)                                       | VPS maintenance             |
| Fits $20 budget?          | ✅ (exactly)                                  | ⚠️ only Free tier or light Hobby usage                         | ✅ comfortably              |

---

## 6. Verdict for a $20/mo budget

**With the user's real usage (5–6 h/day ≈ 165 h/mo of agent runtime):**

1. **Rivet Cloud is decisively out** — at this usage the Free tier's $5 compute cap
   breaks mid-month and Hobby lands at **$31–40/mo** (metered compute, $0.124/vCPU-h).
   The "Rivet + agentOS" pitch only wins at ≲1 h/day — and Freestyle undercuts even
   that: full Linux VMs (Docker, root, KVM) at ~$0 where agentOS offers a limited POSIX
   VM for $31+.
2. **Freestyle Free is the new best sandbox value: ~$0–4/mo** — managed full-VM
   fidelity (4 vCPU/8 GB default), pause/resume matching saku's idle-stop semantics,
   sub-700 ms cold start (better than box's snapshot resume), 10 concurrent VMs, and
   only storage billed while suspended. Caveats: daily caps (20 vCPU-h / 40 GiB-h) sit
   right at 5–6 h/day of a default VM, no custom sizing on Free, no mid-tier below $50,
   young vendor with pricing churn. Integration: zero-code via the static shape, or a
   new `freestyle` backend on the hub's provisioner seam for per-thread VMs.
3. **The VPS static daemon (~$5–8/mo, Hetzner CX33)** remains the no-cap, full-control
   cheap option — you own ops and share one sandbox.
4. **The current stack (CF Free + Box, $20 flat) still fits** and remains the
   zero-anxiety pick — 555 h/mo of 4 vCPU/8 GB with no daily caps, snapshots, and a
   dedicated IPv4. You'd pay ~$16–20/mo extra vs Freestyle for that headroom.
5. **Do not treat "Rivet Hobby $20" as "everything for $20"** — compute is metered on
   top; at 165 h/mo it lands at ~$31–40.

---

## Sources (all primary)

1. Rivet — https://rivet.dev/ (footer: "Actors vs Durable Objects"; Apache 2.0, self-hosting)
2. Rivet blog: "Considering a W3C Standard for Stateful Serverless" — https://rivet.dev/blog/2025-03-23-what-would-a-w3c-standard-look-like-for-stateful-serverless-/
3. Edge Networking — https://rivet.dev/docs/general/edge/ (edge supported on Rivet Cloud & Cloudflare Workers)
4. Rivet Cloud pricing — https://rivet.dev/cloud/ (plans, usage rates, compute estimator)
5. "Introducing Rivet Compute" — https://rivet.dev/changelog/2026-06-17-introducing-rivet-compute/
6. Rivet footer/legal — https://rivet.dev/ (Rivet Gaming, Inc., YC/a16z Speedrun)
7. agentOS — https://agentos-sdk.dev/ and https://rivet.dev/agent-os/ (V8+WASM, 6 ms, 92×/47×/254× claims)
8. "Introducing agentOS" — https://rivet.dev/changelog/2026-04-04-introducing-agentos/
9. Sessions & persistence — https://agentos-sdk.dev/docs/sessions/ (10 GB FS, survives sleep/wake)
10. Quickstart (Pi) — https://agentos-sdk.dev/docs/quickstart/ (`@agentos-software/pi`)
11. `software/pi/agentos-package.json` — https://github.com/rivet-dev/agentos/tree/main/software/pi (pi-acp → @earendil-works/pi-coding-agent)
12. agentOS software registry — https://github.com/rivet-dev/agentos/tree/main/software (42 packages, verified via GitHub API)
13. agentOS homepage — https://agentos-sdk.dev/ ("Run Bash, Node.js, Python…"; "Node.js on native V8 isolates")
14. External Sandboxes — https://agentos-sdk.dev/docs/sandboxes/ (browsers/native binaries/heavy compilation; beta)
15. Sandbox Mounting — https://rivet.dev/docs/agent-os/sandbox/
16. Deploy — https://agentos-sdk.dev/docs/deployment/ (Rivet Cloud / self-hosted / Direct VM API)
17. Security Model — https://agentos-sdk.dev/docs/security-model/ ("beta and still undergoing security review")
18. saku `packages/deploy/alchemy.run.ts` + docs/adr/0002
19. saku docs/adr/0003 (env daemon + Box)
20. box.ascii.dev — https://box.ascii.dev/ ($20 → 555 h of 4 vCPU/8 GB)
21. DO pricing — https://developers.cloudflare.com/durable-objects/platform/pricing/
22. Workers limits — https://developers.cloudflare.com/workers/platform/limits/
23. DO WebSockets/hibernation — https://developers.cloudflare.com/durable-objects/best-practices/websockets/ (hibernation on Free)
24. box vs other providers — https://box.ascii.dev/compare
25. ascii.dev pricing — https://ascii.dev/pricing
26. docs.ascii.dev box quickstart — https://docs.ascii.dev/box/quickstart
27. E2B pricing — https://www.e2b.dev/pricing ; cost calc — https://e2b.dev/docs/faq/calculate-sandbox-price ; billing — https://www.e2b.dev/docs/billing
28. E2B free credits — https://www.e2b.dev/docs/billing (one-time $100)
29. CF Containers pricing — https://developers.cloudflare.com/containers/pricing/
30. CF Sandbox pricing — https://developers.cloudflare.com/sandbox/platform/pricing/ (built on Containers; Workers Paid)
31. Rivet Cloud pricing (compute estimator: 1 vCPU/512 MiB × 100 h = $12.40) — https://rivet.dev/cloud/
32. "Live WebSocket Migration and Hibernation" — https://rivet.dev/changelog/2025-11-24-introducing-live-websocket-migration-hibernation/
33. Rivet Actors — https://rivet.dev/actors/ ("One Actor per agent, per session")
34. agentOS sessions — https://agentos-sdk.dev/docs/sessions/ (actor deployments inject SQLite)
35. Rivet scheduling docs — https://rivet.dev/docs/actors/crash-course/ (scheduling/timers)
36. Realtime/events — https://rivet.dev/docs/actors/events/ (broadcast, conn.send)
37. Actors crash course (events) — https://rivet.dev/docs/actors/crash-course/
38. Self-hosting overview — https://rivet.dev/docs/self-hosting/ (`docker run rivetdev/engine`)
39. agentOS quickstart (rivetkit dev) — https://agentos-sdk.dev/docs/quickstart/
40. agentOS core/direct VM — https://agentos-sdk.dev/docs/core/ (VM lazily created on first action, disposed on sleep)
41. Custom software definition — https://agentos-sdk.dev/docs/custom-software/definition/ (aospkg toolchain)
42. agentOS limitations — https://agentos-sdk.dev/docs/limitations/ (no Docker/apt/native binaries/inotify; Go/Rust/C++ toolchains need external sandbox)
43. "Usage-Based Pricing Update" — https://rivet.dev/changelog/2024-02-12-usage-pricing-update/ (pricing churn)
44. agentOS sessions/MCP — https://agentos-sdk.dev/docs/sessions/ (MCP package installs imply npm in VM)
45. saku README (pnpm 11 toolchain) — https://github.com/earendil-works/pi-coding-agent (repo README)
46. saku README (integration suite deploys to local workerd) — repo README, "Development" section
47. Hetzner Cloud pricing (April 2026 update: CX22 €4.49, CX33 €6.49, EU regions) — https://www.hetzner.com/cloud/cost-optimized/ and https://betterstack.com/community/guides/web-servers/hetzner-cloud-review/ (US regions higher)
48. saku `packages/deploy/alchemy.run.ts` — `SAKU_ENV_PROVISIONER=static` wiring
49. saku `CONTEXT.md` — Static provisioner: "one configured env daemon at SAKU_ENV_URL is every thread's env — no Box, no provisioning loop"
50. Freestyle homepage — https://www.freestyle.sh/ (full Linux VMs, nested KVM, <6 ms provision, fork, pause/resume)
51. Freestyle on YC — https://www.ycombinator.com/companies/freestyle (ex-Apple founders)
52. Freestyle blog: "How to Deploy Long-Running Agents on Freestyle" — https://www.freestyle.sh/blog/engineering/how-to-deploy-long-running-agents-on-freestyle (suspend to avoid CPU/memory billing; storage-only while idle)
53. "Cloud Sandboxes That Fork in 400ms" — https://runany.dev/blog/freestyle-sandboxes-coding-agents/ (fork ~400 ms; sub-700 ms boot)
54. Freestyle product review (SDKs: TypeScript/Python, MCP) — https://4agent.dev/tools/freestyle
55. Freestyle pricing — https://www.freestyle.sh/pricing (plans, free daily included amounts, usage rates, custom-sizing restriction on Free)
56. Pricing-history tracker (plan churn) — https://getpulsesignal.com/changes/freestyle
57. Freestyle VMs docs — https://docs.freestyle.sh/vms (default size 4 vCPU/8 GB/20 GB, resize, domain mappings, start/stop)
58. Freestyle VM lifecycle docs — https://docs.freestyle.sh/v2/vms/configuration/lifecycle (idle timeout, network-triggered resume)
59. Launch HN: Freestyle — https://brianlovin.com/hn/47663147
