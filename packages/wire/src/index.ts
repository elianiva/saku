/**
 * @saku/wire — the saku wire protocol: the typed, versioned vocabulary that
 * consoles (frontend, CLI) and the hub (or, transitionally, the local
 * daemon) exchange over WebSocket JSONL.
 *
 * The package is organized by protocol feature, not by technical layer:
 *
 * - `version.ts`  — protocol version, gate for handshake compatibility
 * - `hello.ts`    — connection handshake (token, role, version)
 * - `thread.ts`   — the registry layer pi lacks (threads, modes, states, env)
 * - `session.ts`  — pi's own session vocabulary, carried verbatim
 * - `skills.ts`   — the hub-hosted skills store (list / import / delete)
 * - `envelope.ts` — top-level frames (command / response / event)
 * - `transport.ts`— JSONL framing over WebSocket
 * - `client.ts`   — `WireClient.make`, the console side of the wire (an
 *     effect-machine actor)
 */

export * from "./version.ts";
export * from "./hello.ts";
export * from "./thread.ts";
export * from "./pi-sessions.ts";
export * from "./session.ts";
export * from "./skills.ts";
export * from "./envelope.ts";
export * from "./transport.ts";
export * from "./client.ts";
