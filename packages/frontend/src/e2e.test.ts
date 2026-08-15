/**
 * End-to-end integration test (e2e.test.ts): boots the real foldkit
 * application in happy-dom against a real worker daemon and drives the
 * welcome: connect → type a prompt → Enter → quick start opens the thread →
 * the run's entries stream into the trail. This is the empty-state contract
 * exercised for real: the composer lives on the welcome, the gesture is one
 * Enter, and the pane becomes the thread. A second pass drives the pi
 * section in the rail: a session file planted in the daemon's pi dir
 * appears as a row, and a click adopts and opens it — the import is not an
 * import gesture, it is what opening a session means.
 *
 * The test needs an isolated daemon running with only the fake model
 * (a real gateway would make the run take minutes and burn tokens):
 *
 *   mkdir -p /tmp/saku-e2e-pi
 *   SAKU_HOME=/tmp/saku-e2e-home PI_CODING_AGENT_DIR=/tmp/saku-e2e-pi \
 *     SAKU_FAKE_MODEL=1 pnpm saku daemon start
 *
 * and then run vitest with `SAKU_E2E_HOME=/tmp/saku-e2e-home`. The suite
 * skips when that variable is unset (CI has no daemon at all). The pi
 * session file is planted in the daemon's `PI_CODING_AGENT_DIR` (default
 * `/tmp/saku-e2e-pi`, matching the setup above).
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { Effect } from "effect";
import { Runtime } from "foldkit";
import { WireClient } from "@saku/wire";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const e2eHome = process.env.SAKU_E2E_HOME;
const available = e2eHome !== undefined && existsSync(join(e2eHome, "worker.url"));

const token = available ? readFileSync(join(e2eHome!, "auth"), "utf8").trim() : "";
const daemonUrl = available ? readFileSync(join(e2eHome!, "worker.url"), "utf8").trim() : "";

const waitFor = async (predicate: () => boolean, what: string, timeoutMs = 20000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timeout waiting for ${what}`);
};

let createdThreadId: string | null = null;
let adoptedThreadId: string | null = null;

/** The planted pi session's file path and the id its rows are keyed by. */
const piFile = () => {
  const root = process.env.PI_CODING_AGENT_DIR ?? "/tmp/saku-e2e-pi";
  return { dir: join(root, "sessions", "e2e"), file: join(root, "sessions", "e2e", "session.jsonl") };
};

/** A minimal v3 session (the daemon parses v3 natively): a named session
 *  with one user message. Recreated per run with a fresh id — a crashed
 *  previous run may have left an adopted thread behind, and a fresh id
 *  keeps this run's click an adoption, never an already-imported. */
const plantPiSession = () => {
  const { dir, file } = piFile();
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const id = `e2epi${Date.now()}`;
  const content = [
    `{"type":"session","version":3,"id":"${id}","timestamp":"2026-01-31T22:00:00.000Z","cwd":"/tmp"}`,
    `{"type":"message","id":"u1","parentId":null,"timestamp":"2026-01-31T22:00:01.000Z","message":{"role":"user","content":"hello from a pi session"}}`,
    `{"type":"session_info","id":"s1","parentId":"u1","timestamp":"2026-01-31T22:00:02.000Z","name":"e2e pi session"}`,
  ].join("\n") + "\n";
  writeFileSync(file, content);
};

beforeAll(async () => {
  if (!available) return;
  plantPiSession();
  document.body.innerHTML = '<div id="root"></div>';
  // The dev bootstrap: point the app at the isolated test daemon.
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).endsWith("/__saku")) {
      return { ok: true, json: async () => ({ url: daemonUrl, token }) } as Response;
    }
    throw new Error(`unexpected fetch in e2e test: ${String(input)}`);
  }) as typeof fetch;
  // main.ts reads the container at module scope — import after the DOM exists.
  const { application } = await import("./main.ts");
  Runtime.run(application);
});

afterAll(async () => {
  // Leave the test daemon's registry as it was: delete the quick-started
  // and the adopted threads. (No-op when the suite was skipped.)
  if (available) {
    const ids = [createdThreadId, adoptedThreadId].filter((id): id is string => id !== null);
    if (ids.length > 0) {
      await Effect.runPromise(
        Effect.gen(function* () {
          const client = yield* WireClient.make({ url: daemonUrl, token, role: "cli" });
          yield* client.connect();
          for (const id of ids) yield* client.deleteThread(id);
          yield* client.disconnect();
        }),
      ).catch(() => {});
    }
  }
});

describe.skipIf(!available)("welcome end-to-end", () => {
  it(
    "connects, quick-starts from the welcome composer, and streams the run into the thread pane",
    { timeout: 60000 },
    async () => {
      // The app boots, connects, and the rail lists the registry.
      await waitFor(() => document.body.innerText.includes("online"), "online connection");
      await waitFor(() => document.body.innerText.includes("threads ·"), "rail list");

      // The welcome is the empty state: wordmark, greeting, composer, start.
      const welcomeText = document.body.innerText;
      expect(welcomeText).toContain("Welcome back! What should we work on today?");
      expect(welcomeText).toContain("start ❯");
      const textarea = document.querySelector("textarea");
      expect(textarea).not.toBeNull();
      // The welcome autofocuses on arrival, so the focused placeholder shows.
      expect(textarea!.placeholder).toBe("prompt saku — enter to spin up a thread");

      // Type a prompt into the welcome composer (real input event).
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      setter.call(textarea, "  e2e quick start  ");
      textarea!.dispatchEvent(new Event("input", { bubbles: true }));
      await waitFor(
        () =>
          (document.querySelector("textarea") as HTMLTextAreaElement).value ===
          "  e2e quick start  ",
        "composer draft",
      );

      // Enter: one gesture — a thread is born, opened, set to work.
      textarea!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      );
      await waitFor(() => location.pathname.startsWith("/thread/"), "navigation to the thread");
      createdThreadId = location.pathname.split("/").pop()!;

      // The thread pane took over: header, trail with the fake run's
      // streamed entries, and the thread composer (draft consumed).
      await waitFor(
        () => document.querySelectorAll("#trail > div").length > 0,
        "trail entries from the fake run",
      );
      expect(document.body.innerText).toContain("send ❯");
      expect((document.querySelector("textarea") as HTMLTextAreaElement).value).toBe("");
      expect(document.body.innerText).not.toContain("Welcome back!");

      // The composer's status row (the humanlayer pattern): the model badge
      // from the state read and the context badge from the fake run's usage.
      await waitFor(
        () => document.body.innerText.includes("saku-fake/test"),
        "the model badge from the state read",
      );
      expect(document.body.innerText).toContain("ctx 15/128,000 · 0%");

      // The model badge opens the picker once the run has settled; the
      // fake model is current, and the panel closes again.
      await waitFor(
        () => {
          const badge = [...document.querySelectorAll("button")].find((b) =>
            b.textContent?.includes("✎"),
          );
          return badge !== undefined && !(badge as HTMLButtonElement).disabled;
        },
        "the model badge enabled after the run",
      );
      const badge = [...document.querySelectorAll("button")].find((b) =>
        b.textContent?.includes("✎"),
      )!;
      badge.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await waitFor(
        () => document.body.innerText.includes("models — the thread's next model"),
        "the model picker panel",
      );
      expect(document.body.innerText).toContain("▸");
      const close = [...document.querySelectorAll("button")].find(
        (b) => b.getAttribute("aria-label") === "close model picker",
      )!;
      close.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await waitFor(
        () => !document.body.innerText.includes("models — the thread's next model"),
        "the model picker closed",
      );
    },
  );

  it(
    "lists pi sessions in the rail and opens one with a click (adoption is not an import gesture)",
    { timeout: 60000 },
    async () => {
      // The pi section sits under the threads: the planted session's row.
      await waitFor(
        () => document.body.innerText.includes("pi sessions · 1"),
        "the pi sessions section",
      );
      expect(document.body.innerText).toContain("e2e pi session");
      expect(document.body.innerText).toContain("1 msgs");

      // A click opens the session — adoption happens under the hood, the
      // user just opens it (no "import" framing anywhere).
      const row = [...document.querySelectorAll("button")].find((b) =>
        b.textContent?.includes("e2e pi session"),
      )!;
      row.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await waitFor(
        () => location.pathname.startsWith("/thread/"),
        "navigation to the adopted thread",
      );
      adoptedThreadId = location.pathname.split("/").pop()!;

      // The adopted trail renders the session's messages.
      await waitFor(
        () => document.body.innerText.includes("hello from a pi session"),
        "the adopted session's trail",
      );

      // The adopted session is a thread now — it left the pi section.
      await waitFor(
        () => !document.body.innerText.includes("pi sessions · 1"),
        "the adopted session dropped from the pi section",
      );
    },
  );
});
