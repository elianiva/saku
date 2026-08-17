# 0010 — Provider-agnostic remote machines and a static default

Status: accepted

The env connection and the provider resource are separate domain concerns. `EnvHandle` therefore carries only the daemon connection (`url`, `token`, and optional relay identity), while the hub registry owns the nullable `remoteMachineId` used to resume or suspend a lifecycle-managed machine. Local and static daemons remain fixed-connection `EnvProvisioner` paths; only lifecycle-managed Box/Freestyle resources implement the `RemoteMachineProvider` contract. Provider adapters live under `@saku/hub/providers/*`, rather than leaking concrete provider vocabulary through the generic hub core or env package.

The deployment defaults to `SAKU_ENV_PROVISIONER=static`, which requires `SAKU_ENV_URL` and `SAKU_ENV_TOKEN`. Box is explicit opt-in and remains incomplete; Freestyle is explicit and fails loudly until its backend is implemented. Unknown provider values fail rather than silently selecting Box. The generic lifecycle vocabulary is `suspend`/`resume`; Box maps `suspend` to ascii.dev's `/stop` endpoint.

This shape keeps the worker ignorant of provider resources and avoids forcing fixed daemons through fake create/suspend operations. It also makes the Box-to-Freestyle replacement a provider-adapter change instead of a wire or worker change.
