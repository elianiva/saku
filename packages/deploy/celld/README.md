# The celld twin (packages/deploy/celld)

Self-hosted saku: the same deployment code (`packages/deploy/src/*`) run on
celld instead of Cloudflare. The wrangler project here is the model celld
executes — hand-maintained, because alchemy's `WranglerJson` resource does
not exist in 2.0.0-beta.72 (the docs describe it; the package doesn't ship
it). The classes in `wrangler.jsonc` (`SakuHubDO`, `SakuThreadDO`) and the
`index.ts` re-exports are the same plain-workerd code the Cloudflare
deployment ships — the alchemy program (`../alchemy.run.ts`) declares the
identical bindings.

## Why it exists

- **One wire, two hosts**: `bun alchemy deploy` targets Cloudflare;
  `celld deploy` targets your own fleet. Both run the same entry code.
- **Dev-shaped by default**: `SAKU_ENV_PROVISIONER=static` — the env is one
  configured daemon at `SAKU_ENV_URL` (a dev machine running
  `saku env start`). No Box required.
- **Scripted model**: `SAKU_FAKE_MODEL=1` adds the `saku-fake` provider
  (answers instantly, no LLM keys) — useful for smoke-testing a fleet.

## Deploying

```bash
# Requirements: celld CLI, esbuild on PATH, an S3-compatible bucket.
celld deploy packages/deploy/celld --bucket <your-bucket>

# The fleet is then the hub's domain; point a console's wire client at it:
#   ws(s)://<celld-url>/ws   with hello { token, role: "cli" }
```

## Vars to set before deploying

| Var                 | Meaning                                                                                               |
| ------------------- | ----------------------------------------------------------------------------------------------------- |
| `DEPLOYMENT_SECRET` | The token consoles present in `hello`. **Trust note**: celld vars are                                 |
|                     | plaintext in the fleet bucket — this is a dev/self-hosted trust domain,                               |
|                     | not a secret store. Cloudflare deployments bind it as a secret instead.                               |
| `SAKU_ENV_URL`      | The static provisioner's env daemon URL (e.g. `http://<host>:4311`).                                  |
| `SAKU_ENV_TOKEN`    | The daemon's token (`saku env start` writes it to `~/.saku/env.json`).                                |
| `SAKU_IDLE_STOP_MS` | Idle window before a lifecycle-managed remote machine is suspended (default 300s); static is a no-op. |
| `SAKU_FAKE_MODEL`   | `"1"` adds the scripted `saku-fake` provider (no LLM keys needed).                                    |
| `BOX_API_KEY`       | Unused in the static twin (kept for parity with the Cloudflare shape). Box is incomplete — ADR 0008.  |
| `FREESTYLE_API_KEY` | The Freestyle sandbox key (ADR 0008) — unused until the freestyle provisioner backend lands.          |

## Known celld-specific checks

- **mode: local loopback**: the worker's env connection to your machine
  through the celld hub is the same outbound-relay path the integration
  suite exercises inside workerd (`packages/deploy/test/deploy.test.ts`,
  "the env relay lives in the hub DO"). A real fleet deployment of that
  path is a user-runnable check (celld needs the bucket; the harness
  doesn't).
- **Node version**: the env daemon on the far side must run the current
  node (effect 4 beta) — `saku env start` on the dev machine handles it.

## Regenerating the wrangler twin

The twin is deliberately plain: if the stack's bindings change (new vars,
new DO namespaces, new classes), mirror them here by hand — the Cloudflare
side reads the alchemy program, the celld side reads this file. Keep
`index.ts` re-exports in sync with the entry's class names.
