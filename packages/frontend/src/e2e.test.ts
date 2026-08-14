/**
 * End-to-end integration test (e2e.test.ts): boots the real foldkit
 * application in happy-dom against a real worker daemon and drives the
 * welcome: connect → type a prompt → Enter → quick start opens the thread →
 * the run's entries stream into the trail. This is the empty-state contract
 * exercised for real: the composer lives on the welcome, the gesture is one
 * Enter, and the pane becomes the thread.
 *
 * The test needs an isolated daemon running with only the fake model
 * (a real gateway would make the run take minutes and burn tokens):
 *
 *   mkdir -p /tmp/saku-e2e-pi
 *   SAKU_HOME=/tmp/saku-e2e-home PI_CODING_AGENT_DIR=/tmp/saku-e2e-pi \
 *     SAKU_FAKE_MODEL=1 pnpm saku daemon start
 *
 * and then run vitest with `SAKU_E2E_HOME=/tmp/saku-e2e-home`. The suite
 * skips when that variable is unset (CI has no daemon at all).
 */

import { existsSync, readFileSync } from "node:fs";
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

beforeAll(async () => {
  if (!available) return;
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
  // thread. (No-op when the suite was skipped.)
  if (available && createdThreadId !== null) {
    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* WireClient.make({ url: daemonUrl, token, role: "cli" });
        yield* client.connect();
        yield* client.deleteThread(createdThreadId as string);
        yield* client.disconnect();
      }),
    ).catch(() => {});
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
    },
  );
});
