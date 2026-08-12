# 0002 — Cloud-primary, celld twin

Status: accepted

## Context

The original plan was deliberately local-first, with the cloud brain deferred behind seams. The rework inverts this: the product is the cloud control plane, and local is a development host and a self-hosting option.

## Decision

The hub runs on **Cloudflare Workers** behind a domain; the frontend is served from that domain, not from localhost. The **same alchemy program** also targets **celld** (self-hosted Durable Objects) for development and self-hosting — one codebase, two hosts. The user's machine participates as an **env provider**, not a worker host: the local env daemon dials out to the hub and registers itself, so a cloud worker in `mode: local` drives the user's machine exactly like it drives a sandbox — no open ports, no tunnel.

## Considered Options

- Local-first with a cloud seam (the old plan) — rejected: the architecture (per-thread DOs, remote env) is cloud-shaped; building the seam first meant building the wrong layer twice.

## Consequences

- celld DO alarms and storage compatibility are load-bearing (idle-stop, entry trail) — they are standard DO APIs and verified against celld.
- A celld-only deployment is a supported configuration, not an afterthought.
- Open verification items: celld DO → host-loopback reachability for the local env; alchemy's celld target maturity; Box `host --private` URL stability across stop/resume.
