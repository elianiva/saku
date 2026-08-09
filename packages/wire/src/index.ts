/**
 * @saku/wire — the saku wire protocol: the typed, versioned vocabulary that
 * consoles (TUI, CLI) and the local worker exchange over a unix socket.
 *
 * The package is organized by protocol feature, not by technical layer:
 *
 * - `version.ts`  — protocol version, gate for handshake compatibility
 * - `hello.ts`    — connection handshake (token, role)
 * - `thread.ts`   — the registry layer pi lacks (threads, modes, states)
 * - `session.ts`  — pi's own session vocabulary, carried verbatim
 * - `envelope.ts` — top-level frames (command / response / event)
 * - `transport.ts`— JSONL framing over the socket
 * - `client.ts`   — `WorkerClient`, the console side of the wire
 */

export * from "./version.ts";
export * from "./hello.ts";
export * from "./thread.ts";
export * from "./session.ts";
export * from "./envelope.ts";
export * from "./transport.ts";
export * from "./client.ts";
