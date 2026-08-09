/**
 * The daemon (daemon.ts): the worker's socket server.
 *
 * Listens on `~/.saku/worker.sock`, authenticates consoles by token,
 * routes wire commands to the registry or to per-thread session hosts,
 * and fans session events out to every connected console (stateless
 * routing — no attach/detach).
 */

import { appendFileSync, readdirSync, unlinkSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { Schema as S } from "effect";

import {
  Hello,
  WIRE_VERSION,
  WireCommand,
  encodeHelloOk,
  type ResponsePayload,
  type SessionCommand,
  type SessionWireEvent,
  type ThreadCommand,
  type ThreadInfo,
  type WireEvent,
} from "@saku/wire";
import { JsonLinesReader, parseJsonLine, writeJsonLine } from "@saku/wire";

import { ensureAuthToken, ensureSakuDirs } from "./auth.ts";
import { getThreadSessionsRoot, getWorkerLogPath, getWorkerSocketPath } from "./paths.ts";
import { ThreadRegistry, type ThreadRecord } from "./registry.ts";
import { ModelCatalog } from "./model-catalog.ts";
import { SessionHost, SessionHostError } from "./session-host.ts";

const DECODE_COMMAND = S.decodeUnknownSync(S.Union([Hello, WireCommand]));

/** Thinking levels of a thread that has no model yet (nothing to clamp to). */
const ALL_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** Whether a thread's pi session has ever been created (started). */
const sessionStarted = (record: ThreadRecord | undefined, threadId: string): boolean => {
  if (record !== undefined && record.sessionId !== null) return true;
  try {
    return readdirSync(getThreadSessionsRoot(threadId)).some((name) => name.endsWith(".jsonl"));
  } catch {
    // No sessions directory — never started.
    return false;
  }
};

interface Client {
  socket: Socket;
  authed: boolean;
}

export interface DaemonOptions {
  /** Override the socket path (tests). Defaults to ~/.saku/worker.sock. */
  socketPath?: string;
}

export class SakuDaemon {
  private readonly socketPath: string;
  private server: Server | null = null;
  private readonly clients = new Set<Client>();
  private registry: ThreadRegistry = new ThreadRegistry();
  private readonly catalog: ModelCatalog;
  private readonly hosts = new Map<string, SessionHost>();
  private closed = false;

  private constructor(options: DaemonOptions) {
    this.socketPath = options.socketPath ?? getWorkerSocketPath();
    this.catalog = ModelCatalog.create();
  }

  static create(options: DaemonOptions = {}): SakuDaemon {
    return new SakuDaemon(options);
  }

  /** Load the registry, ensure dirs/token, start listening. */
  async start(): Promise<void> {
    ensureSakuDirs();
    ensureAuthToken();
    this.registry = ThreadRegistry.load();
    try {
      unlinkSync(this.socketPath);
    } catch {
      // No stale socket — fine.
    }
    await new Promise<void>((resolve, reject) => {
      const server = createServer((socket) => this.handleConnection(socket));
      server.on("error", (error) => {
        this.log(`server error: ${error.message}`);
        reject(error);
      });
      server.listen(this.socketPath, () => {
        this.log(`listening on ${this.socketPath}`);
        resolve();
      });
      this.server = server;
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const client of this.clients) {
      client.socket.destroy();
    }
    this.clients.clear();
    for (const host of this.hosts.values()) {
      await host.dispose().catch(() => undefined);
    }
    this.hosts.clear();
    const server = this.server;
    this.server = null;
    if (server !== null) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
    try {
      unlinkSync(this.socketPath);
    } catch {
      // Socket already gone.
    }
  }

  // -- connections -----------------------------------------------------------

  private handleConnection(socket: Socket): void {
    const client: Client = { socket, authed: false };
    this.clients.add(client);
    const reader = new JsonLinesReader((line) => {
      let value: unknown;
      try {
        value = parseJsonLine(line);
      } catch {
        this.send(client, { _tag: "error", message: "malformed JSON line" });
        return;
      }
      let decoded: Hello | WireCommand;
      try {
        decoded = DECODE_COMMAND(value);
      } catch {
        this.send(client, { _tag: "error", message: "undecodable message" });
        return;
      }
      if (decoded._tag === "hello") {
        this.handleHello(client, decoded);
      } else {
        void this.handleCommand(client, decoded);
      }
    });
    socket.on("data", (chunk) => reader.push(chunk));
    socket.on("close", () => {
      this.clients.delete(client);
    });
    socket.on("error", (error) => {
      this.log(`socket error: ${error.message}`);
    });
  }

  private handleHello(client: Client, hello: Hello): void {
    const expected = ensureAuthToken();
    if (hello.token !== expected) {
      this.send(client, { _tag: "error", message: "invalid token" });
      client.socket.destroy();
      return;
    }
    client.authed = true;
    this.send(client, encodeHelloOk(process.pid));
  }

  private send(client: Client, event: WireEvent): void {
    writeJsonLine(client.socket, event);
  }

  private broadcast(event: WireEvent): void {
    for (const client of this.clients) {
      if (client.authed) {
        this.send(client, event);
      }
    }
  }

  /** All consoles see every thread event (stateless routing). */
  private emitSessionEvent(threadId: string, event: SessionWireEvent): void {
    this.broadcast({ _tag: "event", threadId, event });
  }

  private emitThreadChanged(thread: ThreadInfo): void {
    this.broadcast({ _tag: "thread_changed", thread });
  }

  private async tailSeqOf(threadId: string): Promise<number> {
    const host = this.hosts.get(threadId);
    if (host === undefined) return 0;
    const { tailSeq } = await host.getEntries();
    return tailSeq;
  }

  private async infoOf(threadId: string): Promise<ThreadInfo | undefined> {
    return this.registry.toInfo(threadId, await this.tailSeqOf(threadId));
  }

  // -- command routing -------------------------------------------------------

  private async handleCommand(client: Client, command: WireCommand): Promise<void> {
    if (!client.authed) {
      this.send(client, { _tag: "error", message: "hello first" });
      return;
    }
    try {
      if (command._tag === "thread") {
        await this.handleThreadCommand(client, command.id, command.command);
      } else {
        await this.handleSessionCommand(client, command.id, command.threadId, command.command);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (command.id !== undefined) {
        this.send(client, { _tag: "response", id: command.id, ok: false, error: message });
      } else {
        this.send(client, { _tag: "error", message });
      }
    }
  }

  private respond(client: Client, id: string | undefined, payload: ResponsePayload): void {
    if (id === undefined) return;
    this.send(client, { _tag: "response", id, ok: true, payload });
  }

  private resolveThreadId(input: string): string {
    const exact = this.registry.get(input);
    if (exact !== undefined) return exact.id;
    const matches = this.registry.list().filter((record) => record.id.startsWith(input));
    if (matches.length === 1 && matches[0] !== undefined) return matches[0].id;
    if (matches.length === 0) {
      throw new SessionHostError(`unknown thread: ${input}`);
    }
    throw new SessionHostError(
      `ambiguous thread "${input}": ${matches.map((m) => `${m.id.slice(0, 8)} (${m.name})`).join(", ")}`,
    );
  }

  private async handleThreadCommand(client: Client, id: string | undefined, command: ThreadCommand): Promise<void> {
    switch (command._tag) {
      case "list_threads": {
        const threads: ThreadInfo[] = [];
        for (const record of this.registry.list()) {
          const info = await this.infoOf(record.id);
          if (info !== undefined) threads.push(info);
        }
        this.respond(client, id, { _tag: "list_threads", threads });
        return;
      }
      case "create_thread": {
        const record = this.registry.create({
          name: command.name,
          cwd: command.cwd,
          ...(command.mode === undefined ? {} : { mode: command.mode }),
          ...(command.autoName === undefined ? {} : { autoName: command.autoName }),
        });
        const info = await this.infoOf(record.id);
        if (info !== undefined) this.emitThreadChanged(info);
        this.respond(client, id, { _tag: "create_thread", thread: info ?? (await this.infoOf(record.id))! });
        return;
      }
      case "get_thread": {
        const threadId = this.resolveThreadId(command.threadId);
        const info = await this.infoOf(threadId);
        if (info === undefined) throw new SessionHostError(`unknown thread: ${command.threadId}`);
        this.respond(client, id, { _tag: "get_thread", thread: info });
        return;
      }
      case "delete_thread": {
        const threadId = this.resolveThreadId(command.threadId);
        const host = this.hosts.get(threadId);
        if (host !== undefined) {
          await host.dispose().catch(() => undefined);
          this.hosts.delete(threadId);
        }
        this.registry.delete(threadId);
        const info = this.registry.toInfo(threadId, 0);
        if (info !== undefined) this.emitThreadChanged(info);
        this.respond(client, id, { _tag: "delete_thread" });
        return;
      }
      case "rename_thread": {
        const threadId = this.resolveThreadId(command.threadId);
        const name = command.name.trim();
        if (name.length === 0) {
          throw new SessionHostError("name must not be empty");
        }
        // A user rename wins over auto-title forever (CONTEXT.md: Auto-title).
        this.registry.update(threadId, { name, nameAuto: false });
        const info = await this.infoOf(threadId);
        if (info !== undefined) this.emitThreadChanged(info);
        this.respond(client, id, { _tag: "rename_thread", thread: info ?? (await this.infoOf(threadId))! });
        return;
      }
    }
  }

  private async handleSessionCommand(
    client: Client,
    id: string | undefined,
    threadIdInput: string,
    command: SessionCommand,
  ): Promise<void> {
    const threadId = this.resolveThreadId(threadIdInput);

    // Read-only commands are served without a session host: a thread that
    // has never started answers from the registry/catalog alone, so
    // browsing the TUI never starts the thread's pi session. The session
    // starts on the first mutating command below.
    switch (command._tag) {
      case "get_entries": {
        const readOnly = await this.readOnlyHost(threadId);
        if (readOnly === undefined) {
          this.respond(client, id, { _tag: "get_entries", entries: [], tailSeq: 0, leafId: null });
          return;
        }
        const result = await readOnly.getEntries(command.sinceSeq);
        this.respond(client, id, {
          _tag: "get_entries",
          entries: result.entries,
          tailSeq: result.tailSeq,
          leafId: result.leafId,
        });
        return;
      }
      case "get_state": {
        const readOnly = await this.readOnlyHost(threadId);
        if (readOnly === undefined) {
          this.respond(client, id, {
            _tag: "get_state",
            state: { sessionId: null, state: "idle", tailSeq: 0, model: null, thinkingLevel: "off" },
          });
          return;
        }
        const state = await readOnly.getState();
        this.respond(client, id, { _tag: "get_state", state });
        return;
      }
      case "get_available_models": {
        const models = await this.catalog.available();
        this.respond(client, id, { _tag: "get_available_models", models: models.map((m) => this.catalog.toWireInfo(m)) });
        return;
      }
      case "get_available_thinking_levels": {
        const readOnly = await this.readOnlyHost(threadId);
        const levels =
          readOnly === undefined ? ALL_THINKING_LEVELS : await readOnly.getAvailableThinkingLevels();
        this.respond(client, id, { _tag: "get_available_thinking_levels", levels });
        return;
      }
    }

    // -- mutating commands: the thread starts here ---------------------------
    const host = await this.hostFor(threadId);

    switch (command._tag) {
      case "prompt":
        await host.prompt(command.text, command.images);
        this.respond(client, id, { _tag: "prompt" });
        return;
      case "steer":
        await host.steer(command.text);
        this.respond(client, id, { _tag: "steer" });
        return;
      case "follow_up":
        await host.followUp(command.text);
        this.respond(client, id, { _tag: "follow_up" });
        return;
      case "abort":
        host.abort();
        this.respond(client, id, { _tag: "abort" });
        return;
      case "set_steering_mode":
        host.agent.steeringMode = command.mode;
        this.respond(client, id, { _tag: "set_steering_mode" });
        return;
      case "set_follow_up_mode":
        host.agent.followUpMode = command.mode;
        this.respond(client, id, { _tag: "set_follow_up_mode" });
        return;
      case "get_messages":
        this.respond(client, id, { _tag: "get_messages", messages: host.getMessages() });
        return;
      case "get_last_assistant_text":
        this.respond(client, id, { _tag: "get_last_assistant_text", text: host.getLastAssistantText() });
        return;
      case "compact": {
        const result = await host.compact(command.customInstructions);
        this.respond(client, id, { _tag: "compact", result });
        return;
      }
      case "set_auto_compaction":
        host.setAutoCompaction(command.enabled);
        this.respond(client, id, { _tag: "set_auto_compaction" });
        return;
      case "set_model": {
        const model = await host.setModel(command.provider, command.modelId);
        this.respond(client, id, { _tag: "set_model", model: model === null ? null : host.catalog.toWireInfo(model) });
        return;
      }
      case "cycle_model": {
        const model = await host.cycleModel();
        this.respond(client, id, { _tag: "cycle_model", model: model === null ? null : host.catalog.toWireInfo(model) });
        return;
      }
      case "set_thinking_level": {
        const level = await host.setThinkingLevel(command.level);
        this.respond(client, id, { _tag: "set_thinking_level", level });
        return;
      }
      case "cycle_thinking_level": {
        const level = await host.cycleThinkingLevel();
        this.respond(client, id, { _tag: "cycle_thinking_level", level });
        return;
      }
      case "get_tree": {
        const tree = await host.getTree();
        this.respond(client, id, { _tag: "get_tree", tree });
        return;
      }
      case "branch": {
        const leafId = await host.branch(command.entryId);
        this.respond(client, id, { _tag: "branch", leafId });
        return;
      }
      case "get_session_stats":
        this.respond(client, id, { _tag: "get_session_stats", stats: await host.getSessionStats() });
        return;
      case "set_session_name":
        await host.setSessionName(command.name);
        this.respond(client, id, { _tag: "set_session_name" });
        return;
    }
  }

  /** The live host only when the thread's session has already started; undefined otherwise. */
  private async readOnlyHost(threadId: string): Promise<SessionHost | undefined> {
    const live = this.hosts.get(threadId);
    if (live !== undefined) return live;
    const record = this.registry.get(threadId);
    if (!sessionStarted(record, threadId)) return undefined;
    return this.hostFor(threadId);
  }

  /** Lazy host: constructed on first command; crashed hosts rebuild. */
  private async hostFor(threadId: string): Promise<SessionHost> {
    const existing = this.hosts.get(threadId);
    if (existing !== undefined) {
      if (existing.threadState === "crashed") {
        this.log(`thread ${threadId.slice(0, 8)} crashed; rebuilding host`);
        await existing.dispose().catch(() => undefined);
        this.hosts.delete(threadId);
      } else {
        return existing;
      }
    }
    const record = this.registry.get(threadId);
    if (record === undefined) {
      throw new SessionHostError(`unknown thread: ${threadId}`);
    }
    const host = await SessionHost.create({
      threadId,
      threadCwd: record.cwd,
      catalog: this.catalog,
      registry: this.registry,
      sink: (event) => this.emitSessionEvent(threadId, event),
      onRecordChanged: (changed) => {
        void (async () => {
          const info = await this.infoOf(changed.id);
          if (info !== undefined) this.emitThreadChanged(info);
        })().catch(() => undefined);
      },
    });
    this.hosts.set(threadId, host);
    return host;
  }

  // -- misc ------------------------------------------------------------------

  private log(message: string): void {
    const line = `${new Date().toISOString()} ${message}\n`;
    try {
      appendFileSync(getWorkerLogPath(), line);
    } catch {
      // Logging must never take the daemon down.
    }
    console.log(`[saku-worker] ${message}`);
  }
}
