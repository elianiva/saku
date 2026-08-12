/**
 * MockHub: a spec-of-the-hub test server for the wire's integration tests.
 *
 * Implements the server side of the protocol the way the real hub will:
 * hello handshake (token + version), thread registry with `thread_changed`
 * broadcasts, lazy per-thread sessions (prompt appends entries, settles),
 * skills store, and fan-out of session events to every connected console.
 * Deliberately small — it is a fixture, not a product — but it exercises
 * every command the wire defines, so the wire's contract is proven end to
 * end before the hub exists.
 */

import { randomUUID } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import { Result, Schema as S } from "effect";

import {
  decodeFrame,
  ErrorEvent,
  EventFrame,
  Hello,
  HelloOk,
  parseFrame,
  ResponseError,
  ResponseOk,
  serializeFrame,
  ThreadChanged,
  WIRE_VERSION,
  WireCommand,
  type ResponsePayload,
  type SkillInfo,
  type ThreadInfo,
  type ThreadMode,
  type WireEvent,
} from "../src/index.ts";

/** The token the mock accepts (clients use the same constant). */
export const TEST_TOKEN = "test-secret";
/** The single model the mock catalog knows. */
export const MOCK_MODEL = { provider: "mock", id: "m1", contextWindow: 128_000, reasoning: true };
/** Simulated run latency; prompts with this text are slow (timeout tests). */
const SLOW_MARKER = "slow";

const DECODE = S.decodeUnknownSync(S.Union([Hello, WireCommand]));

interface MockThread {
  id: string;
  name: string;
  cwd: string | null;
  mode: ThreadMode;
  autoName: boolean;
  sessionId: string | null;
  state: "idle" | "working";
  thinkingLevel: string;
  nextSeq: number;
  entries: Array<{ seq: number; type: string; id: string }>;
  nameSet: string | null;
}

export interface MockHub {
  readonly url: string;
  /** Close every client connection (simulates a server restart). */
  readonly dropAll: () => void;
  /** Send a raw frame to every connected client (malformed-frame tests). */
  readonly sendRaw: (text: string) => void;
  /** Close the server for good. */
  readonly close: () => Promise<void>;
}

/** Start a mock hub on an ephemeral loopback port. */
export const startMockHub = (): Promise<MockHub> =>
  new Promise((resolve) => {
    const threads = new Map<string, MockThread>();
    const skills = new Map<string, SkillInfo>();
    const clients = new Set<WebSocket>();

    const send = (socket: WebSocket, frame: WireEvent): void => {
      if (socket.readyState === socket.OPEN) socket.send(serializeFrame(frame));
    };
    const broadcast = (frame: WireEvent): void => {
      for (const socket of clients) send(socket, frame);
    };
    const respond = (socket: WebSocket, id: string, payload: ResponsePayload): void => {
      send(socket, ResponseOk.make({ id, ok: true, payload }));
    };
    const fail = (socket: WebSocket, id: string, error: string): void => {
      send(socket, ResponseError.make({ id, ok: false, error }));
    };

    const threadInfo = (thread: MockThread): ThreadInfo => ({
      id: thread.id,
      name: thread.name,
      cwd: thread.cwd,
      mode: thread.mode,
      state: thread.state,
      env: "ready",
      sessionId: thread.sessionId,
      tailSeq: thread.nextSeq - 1,
    });
    const threadChanged = (thread: MockThread): void => {
      broadcast(ThreadChanged.make({ thread: threadInfo(thread) }));
    };

    const findThread = (threadId: string): MockThread | undefined => {
      // Exact id first, then an unambiguous prefix (the real hub's contract).
      const exact = threads.get(threadId);
      if (exact !== undefined) return exact;
      const byPrefix = [...threads.values()].filter((t) => t.id.startsWith(threadId));
      return byPrefix.length === 1 ? byPrefix[0] : undefined;
    };

    const newThread = (input: {
      name: string;
      cwd?: string;
      mode?: ThreadMode;
      autoName?: boolean;
    }): MockThread => {
      const thread: MockThread = {
        id: randomUUID().replaceAll("-", ""),
        name: input.name,
        cwd: input.mode === "sandbox" ? null : (input.cwd ?? null),
        mode: input.mode ?? "local",
        autoName: input.autoName === true,
        sessionId: null,
        state: "idle",
        thinkingLevel: "off",
        nextSeq: 1,
        entries: [],
        nameSet: null,
      };
      threads.set(thread.id, thread);
      return thread;
    };

    /** Settle one run: append the fake entry, broadcast it, go idle. */
    const settleRun = (thread: MockThread, text: string): void => {
      const entry = { seq: thread.nextSeq++, type: "user_message", id: `e${thread.nextSeq - 1}` };
      thread.entries.push(entry);
      if (thread.sessionId === null) thread.sessionId = thread.id;
      broadcast(EventFrame.make({ threadId: thread.id, event: { type: "entry_appended", entry } }));
      thread.state = "idle";
      threadChanged(thread);
      broadcast(EventFrame.make({ threadId: thread.id, event: { type: "settled" } }));
    };

    const runCommand = (socket: WebSocket, frame: WireCommand): void => {
      const { id, command } = frame;
      switch (command._tag) {
        case "list_threads":
          respond(socket, id, { _tag: "list_threads", threads: [...threads.values()].map(threadInfo) });
          return;
        case "create_thread": {
          const thread = newThread(command);
          // Broadcast before responding — the real hub's ordering: consoles
          // see the change before the command resolves.
          threadChanged(thread);
          respond(socket, id, { _tag: "create_thread", thread: threadInfo(thread) });
          return;
        }
        case "get_thread": {
          const thread = findThread(command.threadId);
          if (thread === undefined) return fail(socket, id, `unknown thread: ${command.threadId}`);
          respond(socket, id, { _tag: "get_thread", thread: threadInfo(thread) });
          return;
        }
        case "rename_thread": {
          const thread = findThread(command.threadId);
          if (thread === undefined) return fail(socket, id, `unknown thread: ${command.threadId}`);
          const name = command.name.trim();
          if (name.length === 0) return fail(socket, id, "name must not be empty");
          thread.name = name;
          threadChanged(thread);
          respond(socket, id, { _tag: "rename_thread", thread: threadInfo(thread) });
          return;
        }
        case "delete_thread": {
          const thread = findThread(command.threadId);
          if (thread === undefined) return fail(socket, id, `unknown thread: ${command.threadId}`);
          threads.delete(thread.id);
          threadChanged(thread);
          respond(socket, id, { _tag: "delete_thread" });
          return;
        }
        case "list_skills":
          respond(socket, id, { _tag: "list_skills", skills: [...skills.values()] });
          return;
        case "import_skill": {
          const skill: SkillInfo = {
            id: randomUUID().replaceAll("-", ""),
            name: command.source.split("/").pop()?.replace(/\.git$/u, "") ?? "skill",
            scope: command.scope ?? "personal",
            source: command.source,
            version: null,
          };
          skills.set(skill.id, skill);
          respond(socket, id, { _tag: "import_skill", skill });
          return;
        }
        case "delete_skill": {
          if (!skills.has(command.id)) return fail(socket, id, `unknown skill: ${command.id}`);
          skills.delete(command.id);
          respond(socket, id, { _tag: "delete_skill" });
          return;
        }
        default:
          // Session commands are handled below (they need the thread).
          break;
      }

      const thread = frame.threadId === undefined ? undefined : findThread(frame.threadId);
      if (thread === undefined) {
        fail(socket, id, `unknown thread: ${String(frame.threadId)}`);
        return;
      }
      switch (command._tag) {
        case "prompt": {
          if (thread.state === "working") return fail(socket, id, "agent is already processing");
          // A run is in flight from the moment the prompt is accepted.
          thread.state = "working";
          threadChanged(thread);
          const slow = command.text.includes(SLOW_MARKER);
          const finish = (): void => {
            settleRun(thread, command.text);
            // Hub behavior: the response arrives when the run settles.
            respond(socket, id, { _tag: "prompt" });
          };
          if (slow) {
            setTimeout(finish, 300);
            return;
          }
          finish();
          return;
        }
        case "steer":
        case "follow_up": {
          if (thread.state === "working") {
            // Queued: still an accepted command while working.
            respond(socket, id, { _tag: command._tag });
            return;
          }
          thread.state = "working";
          threadChanged(thread);
          settleRun(thread, command.text);
          respond(socket, id, { _tag: command._tag });
          return;
        }
        case "abort": {
          if (thread.state === "working") {
            thread.state = "idle";
            broadcast(EventFrame.make({ threadId: thread.id, event: { type: "settled" } }));
          }
          respond(socket, id, { _tag: "abort" });
          return;
        }
        case "compact": {
          if (thread.state === "working") return fail(socket, id, "cannot compact while the agent is working");
          respond(socket, id, { _tag: "compact", result: { ok: true, summary: "mock", retainedTail: [], tokensBefore: 0 } });
          return;
        }
        case "set_auto_compaction":
          respond(socket, id, { _tag: "set_auto_compaction" });
          return;
        case "get_available_models":
          respond(socket, id, { _tag: "get_available_models", models: [MOCK_MODEL] });
          return;
        case "set_model": {
          if (command.provider !== MOCK_MODEL.provider || command.modelId !== MOCK_MODEL.id) {
            return fail(socket, id, `unknown model: ${command.provider}/${command.modelId}`);
          }
          respond(socket, id, { _tag: "set_model", model: MOCK_MODEL });
          return;
        }
        case "get_available_thinking_levels":
          respond(socket, id, {
            _tag: "get_available_thinking_levels",
            levels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
          });
          return;
        case "set_thinking_level":
          thread.thinkingLevel = command.level;
          respond(socket, id, { _tag: "set_thinking_level", level: command.level });
          return;
        case "get_entries": {
          const since = command.sinceSeq ?? 0;
          respond(socket, id, {
            _tag: "get_entries",
            entries: thread.entries.filter((e) => e.seq > since),
            tailSeq: thread.nextSeq - 1,
            leafId: thread.entries.length === 0 ? null : thread.entries[thread.entries.length - 1]!.id,
          });
          return;
        }
        case "branch": {
          const entry = thread.entries.find((e) => e.id === command.entryId);
          if (entry === undefined) return fail(socket, id, `unknown entry: ${command.entryId}`);
          respond(socket, id, { _tag: "branch", leafId: entry.id });
          return;
        }
        case "get_session_stats":
          respond(socket, id, { _tag: "get_session_stats", stats: { totalPromptTokens: 0 } });
          return;
        case "set_session_name":
          thread.nameSet = command.name;
          respond(socket, id, { _tag: "set_session_name" });
          return;
        case "get_state":
          respond(socket, id, {
            _tag: "get_state",
            state: {
              sessionId: thread.sessionId,
              ...(thread.nameSet === null ? {} : { name: thread.nameSet }),
              state: thread.state,
              tailSeq: thread.nextSeq - 1,
              model: MOCK_MODEL,
              thinkingLevel: thread.thinkingLevel,
            },
          });
          return;
        case "list_threads":
        case "create_thread":
        case "get_thread":
        case "rename_thread":
        case "delete_thread":
        case "list_skills":
        case "import_skill":
        case "delete_skill":
          // Handled above; unreachable here (exhaustiveness).
          fail(socket, id, "internal: command routed to the wrong handler");
          return;
        default: {
          const exhaustive: never = command;
          void exhaustive;
          fail(socket, id, `unknown command: ${String((command as { _tag: string })._tag)}`);
        }
      }
    };

    const handleConnection = (socket: WebSocket): void => {
      clients.add(socket);
      socket.on("close", () => {
        clients.delete(socket);
      });
      socket.on("message", (data) => {
        const value = Result.try(() => parseFrame(decodeFrame(data)));
        if (Result.isFailure(value)) {
          send(socket, ErrorEvent.make({ message: "malformed JSON frame" }));
          return;
        }
        if (value.success === undefined) return;
        const decoded = Result.try(() => DECODE(value.success));
        if (Result.isFailure(decoded)) {
          send(socket, ErrorEvent.make({ message: "undecodable message" }));
          return;
        }
        if (decoded.success._tag === "hello") {
          if (decoded.success.version !== WIRE_VERSION) {
            send(socket, ErrorEvent.make({ message: `version mismatch: expected ${WIRE_VERSION}` }));
            socket.close();
            return;
          }
          if (decoded.success.token !== TEST_TOKEN) {
            send(socket, ErrorEvent.make({ message: "invalid token" }));
            socket.close();
            return;
          }
          send(socket, HelloOk.make({ pid: process.pid, version: WIRE_VERSION }));
          return;
        }
        runCommand(socket, decoded.success);
      });
    };

    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    server.on("connection", handleConnection);
    server.on("listening", () => {
      const address = server.address();
      const port = address !== null && typeof address !== "string" ? address.port : 0;
      resolve({
        url: `ws://127.0.0.1:${port}`,
        dropAll: () => {
          for (const socket of clients) socket.close();
        },
        sendRaw: (text) => {
          for (const socket of clients) {
            if (socket.readyState === socket.OPEN) socket.send(text);
          }
        },
        close: () =>
          new Promise((done) => {
            for (const socket of clients) socket.close();
            server.close(() => done());
          }),
      });
    });
  });
