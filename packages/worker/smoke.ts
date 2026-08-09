/**
 * Smoke: boots a real daemon in a hermetic SAKU_HOME and drives it with the
 * real wire client — the proof that the spine works end to end.
 *
 * Run: node smoke.ts (from packages/worker)
 */

import { accessSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import { WorkerClient } from "@saku/wire";

const here = dirname(fileURLToPath(import.meta.url));
const home = mkdtempSync(join(tmpdir(), "saku-smoke-"));
const agentDir = join(home, "pi-agent");
mkdirSync(agentDir, { recursive: true });

const env = { ...process.env, SAKU_HOME: home, PI_CODING_AGENT_DIR: agentDir };
const socketPath = join(home, "worker.sock");

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

let daemon: ChildProcess | undefined;
let failures = 0;

const check = (label: string, ok: boolean, detail = ""): void => {
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const main = async (): Promise<void> => {
  daemon = spawn(process.execPath, ["src/daemon-entry.ts"], {
    cwd: here,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  daemon.stdout?.on("data", (c: Buffer) => console.log(`[daemon] ${c.toString().trim()}`));
  daemon.stderr?.on("data", (c: Buffer) => console.error(`[daemon-err] ${c.toString().trim()}`));

  // Wait for the socket to appear.
  for (let i = 0; i < 100; i++) {
    try {
      accessSync(socketPath);
      break;
    } catch {
      await sleep(50);
    }
  }

  const client = new WorkerClient({ socketPath, token: "bogus-token-for-now", role: "cli" });

  // --- handshake rejection ------------------------------------------------
  const bad = new WorkerClient({ socketPath, token: "wrong-token", role: "cli" });
  const badResult = await Effect.runPromise(Effect.flip(bad.connect()));
  check("bad token rejected", badResult.code === "handshake", badResult.message);

  // --- connect with the real token -----------------------------------------
  const token = readFileSync(join(home, "auth"), "utf8").trim();
  check("token file created", token.length === 64, `len=${token.length}`);
  const authed = new WorkerClient({ socketPath, token, role: "cli" });
  const hello = await new Promise<unknown>((resolve) => {
    authed.on("hello_ok", resolve);
    void Effect.runPromise(authed.connect());
  }).catch(() => undefined);
  check("hello_ok received", (hello as { pid: number }).pid === daemon.pid, `pid=${(hello as { pid: number }).pid}`);

  // --- registry ops ----------------------------------------------------------
  const thread = await Effect.runPromise(authed.createThread("smoke thread", "/tmp"));
  check("create_thread", thread.id.length === 32, `id=${thread.id.slice(0, 8)}`);
  check("thread state idle", thread.state === "idle", thread.state);

  const list = await Effect.runPromise(authed.listThreads());
  check("list_threads", list.length === 1 && list[0]!.id === thread.id);

  const got = await Effect.runPromise(authed.getThread(thread.id.slice(0, 8)));
  check("get_thread by prefix", got.id === thread.id);

  // --- read-only commands never start the session ---------------------------
  const state = await Effect.runPromise(authed.getState(thread.id));
  check("get_state before first message: idle", state.state === "idle", JSON.stringify(state));
  check("get_state before first message: no session", state.sessionId === null, String(state.sessionId));
  check("get_state before first message: empty trail", state.tailSeq === 0, `tailSeq=${state.tailSeq}`);

  const entries = await Effect.runPromise(authed.getEntries(thread.id));
  check(
    "get_entries before first message: empty",
    entries.entries.length === 0 && entries.tailSeq === 0,
    `entries=${entries.entries.length}, tailSeq=${entries.tailSeq}`,
  );

  const sessionsDir = join(home, "threads", thread.id, "sessions");
  let sessionFiles: string[] = [];
  try {
    sessionFiles = readdirSync(sessionsDir);
  } catch {
    // No sessions dir — never started. Good.
  }
  check("no session storage before first message", sessionFiles.length === 0, `files=${sessionFiles.length}`);

  // --- prompt without a model fails cleanly ----------------------------------
  const promptResult = await Effect.runPromise(
    Effect.flip(authed.prompt(thread.id, "hello")),
  );
  check("prompt without model errors", promptResult.code === "command_failed", promptResult.message);

  // --- the first message starts the session -----------------------------------
  const afterPrompt = await Effect.runPromise(authed.getState(thread.id));
  check("first message started the session", afterPrompt.sessionId === thread.id, String(afterPrompt.sessionId));
  check("initial trail written on start", afterPrompt.tailSeq >= 1, `tailSeq=${afterPrompt.tailSeq}`);

  const entriesAfter = await Effect.runPromise(authed.getEntries(thread.id));
  check(
    "get_entries after start",
    entriesAfter.entries.length >= 1 && entriesAfter.tailSeq >= 1,
    `entries=${entriesAfter.entries.length}, tailSeq=${entriesAfter.tailSeq}`,
  );

  // --- delete + thread_changed? (no subscriber here; just verify deletion) ---
  await Effect.runPromise(authed.deleteThread(thread.id));
  const after = await Effect.runPromise(authed.listThreads());
  check("delete_thread", after.length === 0);

  // --- set_session_name / get_state name -------------------------------------
  const thread2 = await Effect.runPromise(authed.createThread("named", "/tmp"));
  await Effect.runPromise(authed.setSessionName(thread2.id, "renamed"));
  const state2 = await Effect.runPromise(authed.getState(thread2.id));
  check("set_session_name", state2.name === "renamed", String(state2.name));
  await Effect.runPromise(authed.deleteThread(thread2.id));

  // --- protocol error path -----------------------------------------------------
  const refused = new WorkerClient({ socketPath: join(home, "ghost.sock"), token, role: "cli" });
  const refusedResult = await Effect.runPromise(Effect.flip(refused.connect()));
  check("refused when no daemon", refusedResult.code === "refused");

  authed.disconnect();
  daemon.kill("SIGTERM");
  await sleep(300);
  daemon = undefined;

  console.log(failures === 0 ? "\nSMOKE OK" : `\nSMOKE FAILED (${failures} failures)`);
  process.exit(failures === 0 ? 0 : 1);
};

main()
  .catch((error) => {
    console.error("SMOKE CRASHED:", error);
    process.exit(1);
  })
  .finally(() => {
    if (daemon !== undefined && daemon.exitCode === null) daemon.kill("SIGKILL");
    rmSync(home, { recursive: true, force: true });
  });
