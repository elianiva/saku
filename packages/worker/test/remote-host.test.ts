/**
 * Remote-host tests: the M4 worker shape proven today — a real
 * `SessionHost` whose hands are a real `RemoteEnv` over the env protocol
 * to a real `makeEnvDaemon` (ADR 0003). The agent's tools (`bash`) execute
 * on the daemon, and the trail records real tool calls — the data plane
 * end to end, no stubs between the host and the daemon.
 *
 * The model stream is scripted (no LLM): first an assistant message with a
 * `bash` toolCall, then — once the agent runtime has executed the tool
 * over the env and appended the result — a final plain message.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeFileSystem } from "@effect/platform-node";
import { Effect, Exit, FileSystem, Scope } from "effect";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { makeEnvDaemon, nodeSocket, RemoteEnv, type EnvDaemonShape } from "@saku/env";
import { KvStore } from "@saku/store";

import { SessionHost, type HostEventSink } from "../src/session-host.ts";
import { assistantMessage, fakeCatalog, FakeRegistry } from "./fakes.ts";

const THREAD_ID = "0123456789abcdef0123456789abcdef";
const ENV_TOKEN = "remote-host-token";

// The per-test trail/workspace dir (set in beforeEach, before record()).
let workdir: string;

const record = () => ({
  id: THREAD_ID,
  name: "remote thread",
  // The trail/workspace cwd: the RemoteEnv is built per-test with the
  // fresh workdir, and the record's cwd mirrors it.
  cwd: workdir,
  mode: "sandbox" as const,
  createdAt: Date.now(),
  sessionId: null,
  nameAuto: true,
});

/**
 * A two-phase stream: first an assistant message carrying a `bash`
 * toolCall (pi's content vocabulary), then a final message once the agent
 * runtime has executed the tool and fed the result back.
 */
const toolThenDoneStream = (doneText: string): StreamFn => {
  let phase = 0;
  return () => {
    const stream = createAssistantMessageEventStream();
    if (phase === 0) {
      phase = 1;
      const message = assistantMessage("Let me run a command.", "toolUse");
      stream.end({
        ...message,
        content: [
          {
            type: "toolCall",
            id: "tc-1",
            name: "bash",
            arguments: { command: "echo hello-from-env && printf 'world' > made.txt" },
          },
        ],
      });
    } else {
      stream.end(assistantMessage(doneText, "stop"));
    }
    return stream;
  };
};

describe("SessionHost over RemoteEnv", () => {
  let daemon: EnvDaemonShape;
  let env: RemoteEnv;
  let scope: Scope.Scope;
  let host: SessionHost;
  const sink: HostEventSink = (event) => {
    void event;
  };
  const registry = new FakeRegistry(record());

  beforeEach(async () => {
    workdir = await mkdtemp(join(tmpdir(), "saku-remote-host-"));
    const built = await Effect.runPromise(
      Effect.gen(function* () {
        scope = yield* Scope.make();
        const fs = yield* FileSystem.FileSystem;
        const daemon = yield* makeEnvDaemon({ token: ENV_TOKEN, fs, cwd: workdir }).pipe(
          Effect.provideService(Scope.Scope, scope),
        );
        return { daemon, fs };
      }).pipe(Effect.provide(NodeFileSystem.layer)),
    );
    daemon = built.daemon;
    env = new RemoteEnv({ url: daemon.url, token: ENV_TOKEN, cwd: workdir, socket: nodeSocket });
    await env.connect();
    host = await Effect.runPromise(
      SessionHost.create({
        threadId: THREAD_ID,
        record: record(),
        catalog: fakeCatalog(),
        registry,
        sink,
        env,
        streamFn: toolThenDoneStream("Done, the command ran."),
      }).pipe(
        // The trail lives under the workdir (the remote env's workspace).
        Effect.provide(KvStore.file(built.fs, join(workdir, "trail"))),
      ),
    );
  });

  afterEach(async () => {
    await Effect.runPromise(host.dispose());
    env.close();
    await Effect.runPromise(Scope.close(scope, Exit.void));
    await rm(workdir, { recursive: true, force: true });
  });

  it("runs a prompt whose bash tool executes on the daemon and records the call", async () => {
    await Effect.runPromise(host.prompt("Run the command."));
    await waitForState(host, "idle");

    const { entries } = await Effect.runPromise(host.getEntries());
    // The trail is pi's message vocabulary: the tool call rides inside an
    // assistant message, the tool result (the daemon's stdout) in the
    // messages that follow. Both are the data plane's proof.
    const serialized = JSON.stringify(entries);
    expect(serialized).toContain("toolCall");
    expect(serialized).toContain('"name":"bash"');
    expect(serialized).toContain("hello-from-env");
  });

  it("sees the daemon-side side effects: the bash tool created a real file", async () => {
    await Effect.runPromise(host.prompt("Run the command."));
    await waitForState(host, "idle");
    // The tool ran in the env daemon's workspace (not the host's process).
    const read = await env.readTextFile("made.txt");
    expect(read.ok && read.value).toContain("world");
  });
});

/** Wait for the host's lifecycle tag (the machine moves asynchronously). */
const waitForState = async (host: SessionHost, state: string, timeoutMs = 5000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (host.threadState === state) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`host state ${state} not reached; last: ${host.threadState}`);
};
