/**
 * Remote-host tests: the M4 worker shape proven today — a real
 * `SessionHost` whose hands are a real `RemoteEnv` over the env protocol
 * to a real `EnvDaemon.make` (ADR 0003). The agent's tools (`bash`) execute
 * on the daemon, and the trail records real tool calls — the data plane
 * end to end, no stubs between the host and the daemon.
 *
 * The model stream is scripted (no LLM): first an assistant message with a
 * `bash` toolCall, then — once the agent runtime has executed the tool
 * over the env and appended the result — a final plain message.
 */

import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeFileSystem } from "@effect/platform-node";
import { Effect, Exit, FileSystem, Schema, Scope } from "effect";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { EnvDaemon, nodeSocket, RemoteEnv } from "@saku/env";
import type { EnvDaemonApi } from "@saku/env";
import { KvStore } from "@saku/store";

import { SessionHost } from "../src/session-host.ts";
import type { HostEventSink } from "../src/session-host.ts";
import { assistantMessage, fakeCatalog, FakeRegistry } from "./fakes.ts";

const THREAD_ID = "0123456789abcdef0123456789abcdef";
const ENV_TOKEN = "remote-host-token";

/** Alias of `Schema.TaggedError` so oxlint's Error-name call heuristic
 * doesn't demand `new` on the factory call (which would break typecheck). */
const taggedError = Schema.TaggedError;

/** A polling assertion that gave up (the host machine hadn't moved in time). */
class TestError extends taggedError<TestError>()("TestError", {
  message: Schema.String,
}) {}

/** Wait for the host's lifecycle tag (the machine moves asynchronously). */
const waitForState = async (host: SessionHost, state: string, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs;
  const poll = async (): Promise<void> => {
    if (host.threadState === state) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new TestError({
        message: `host state ${state} not reached; last: ${host.threadState}`,
      });
    }
    await sleep(10);
    await poll();
  };
  await poll();
};

/** Events are not asserted in these tests. */
const sink: HostEventSink = (_event) => {
  // scripted: the remote host's events are covered by the host tests
};

// The per-test trail/workspace dir (set in beforeEach, before record()).
let workdir: string;

const record = () => ({
  createdAt: Date.now(),
  // The trail/workspace cwd: the RemoteEnv is built per-test with the
  // fresh workdir, and the record's cwd mirrors it.
  cwd: workdir,
  id: THREAD_ID,
  mode: "sandbox" as const,
  name: "remote thread",
  nameAuto: true,
  sessionId: null,
});

/**
 * A two-phase stream: first an assistant message carrying a `bash`
 * toolCall (pi's content vocabulary), then a final message once the agent
 * runtime has executed the tool and fed the result back.
 */
const toolThenDoneStream = (doneText: string) => {
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
            arguments: { command: "echo hello-from-env && printf 'world' > made.txt" },
            id: "tc-1",
            name: "bash",
            type: "toolCall",
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
  let daemon: EnvDaemonApi;
  let env: RemoteEnv;
  let scope: Scope.Scope;
  let host: SessionHost;
  const registry = new FakeRegistry(record());

  beforeEach(async () => {
    workdir = await Effect.runPromise(
      Effect.provide(NodeFileSystem.layer)(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          return yield* fs.makeTempDirectory({ directory: tmpdir(), prefix: "saku-remote-host-" });
        }),
      ),
    );
    const built = await Effect.runPromise(
      Effect.gen(function* () {
        const genScope = yield* Scope.make();
        const fs = yield* FileSystem.FileSystem;
        const builtDaemon: EnvDaemonApi = yield* EnvDaemon.make({
          cwd: workdir,
          fs,
          token: ENV_TOKEN,
        }).pipe(Effect.provideService(Scope.Scope, genScope));
        return { daemon: builtDaemon, fs, scope: genScope };
      }).pipe(Effect.provide(NodeFileSystem.layer)),
    );
    const { daemon: builtDaemon, fs, scope: daemonScope } = built;
    scope = daemonScope;
    daemon = builtDaemon;
    env = new RemoteEnv({ cwd: workdir, socket: nodeSocket, token: ENV_TOKEN, url: daemon.url });
    await env.connect();
    host = await Effect.runPromise(
      SessionHost.create({
        catalog: fakeCatalog(),
        env,
        record: record(),
        registry,
        sink,
        streamFn: toolThenDoneStream("Done, the command ran."),
        threadId: THREAD_ID,
      }).pipe(
        // The trail lives under the workdir (the remote env's workspace).
        Effect.provide(KvStore.file(fs, path.join(workdir, "trail"))),
      ),
    );
  });

  afterEach(async () => {
    await Effect.runPromise(host.dispose());
    env.close();
    await Effect.runPromise(Scope.close(scope, Exit.void));
    await Effect.runPromise(
      Effect.provide(NodeFileSystem.layer)(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          yield* fs.remove(workdir, { force: true, recursive: true });
        }),
      ).pipe(Effect.catch(() => Effect.void)),
    );
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
