/**
 * Pi-sessions reader tests: the local daemon's window into pi's session
 * files. Fixtures are crafted to pi's real formats — v3 (what pi's shell
 * writes today: type-keyed lines, no seq/lane) and v4 (pi-agent-core's
 * jsonl format: kind/seq/lane mutations) — and asserted against the
 * mutation vocabulary saku's trail replays.
 */

import { describe, expect, it } from "vitest";
import { NodeFileSystem } from "@effect/platform-node";
import { Effect, FileSystem, Result } from "effect";

import { listPiSessions, readPiSession, PiSessionsError } from "../src/pi-sessions.ts";
import { getAgentDir } from "../src/paths.ts";

const fs = await Effect.runPromise(Effect.provide(NodeFileSystem.layer)(Effect.gen(function* () {
  return yield* FileSystem.FileSystem;
})));

/** A temp dir acting as pi's agent dir (getAgentDir honors PI_CODING_AGENT_DIR). */
const withPiAgentDir = async <T>(run: (root: string) => Promise<T>): Promise<T> => {
  const root = await Effect.runPromise(fs.makeTempDirectory({ prefix: "saku-pi-test-" }));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  try {
    return await run(root);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await Effect.runPromise(fs.remove(root, { recursive: true, force: true }).pipe(Effect.catch(() => Effect.void)));
  }
};

const writeSession = (root: string, cwdSlug: string, fileName: string, content: string): Promise<string> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const dir = `${getAgentDir()}/sessions/${cwdSlug}`;
      yield* fs.makeDirectory(dir, { recursive: true });
      yield* fs.writeFileString(`${dir}/${fileName}`, content);
      return `${dir}/${fileName}`;
    }),
  );

/** A realistic v3 session: header, model, thinking level, messages, a name,
 * a label (chained like an entry), a custom_message, and a compaction. */
const V3_SESSION = [
  '{"type":"session","version":3,"id":"v3sess0001","timestamp":"2026-01-31T22:33:31.764Z","cwd":"/tmp/pi-workspace"}',
  '{"type":"model_change","id":"m1","parentId":null,"timestamp":"2026-01-31T22:33:31.765Z","provider":"google-antigravity","modelId":"gemini-3-flash"}',
  '{"type":"thinking_level_change","id":"t1","parentId":"m1","timestamp":"2026-01-31T22:33:31.766Z","thinkingLevel":"low"}',
  '{"type":"message","id":"u1","parentId":"t1","timestamp":"2026-01-31T22:33:31.900Z","message":{"role":"user","content":[{"type":"text","text":"fix the flaky test"}]}}',
  '{"type":"message","id":"a1","parentId":"u1","timestamp":"2026-01-31T22:33:34.009Z","message":{"role":"assistant","content":[{"type":"text","text":"I am Pi."}]}}',
  '{"type":"custom_message","id":"c1","parentId":"a1","timestamp":"2026-01-31T22:33:35.000Z","customType":"ext.demo","content":[{"type":"text","text":"hello from an extension"}],"display":true,"details":{"k":1}}',
  '{"type":"label","id":"l1","parentId":"c1","timestamp":"2026-01-31T22:33:36.000Z","targetId":"u1","label":"flagged"}',
  '{"type":"message","id":"u2","parentId":"l1","timestamp":"2026-01-31T22:33:37.000Z","message":{"role":"user","content":"actually also check the e2e"}}',
  '{"type":"session_info","id":"s1","parentId":"u2","timestamp":"2026-01-31T22:33:38.000Z","name":"flaky tests"}',
].join("\n") + "\n";

describe("listPiSessions", () => {
  it("lists v3 sessions with pi's buildSessionInfo semantics", async () => {
    await withPiAgentDir(async (root) => {
      const path = await writeSession(root, "--tmp-pi-workspace--", "2026-01-31T22-33-31-764Z_v3sess0001.jsonl", V3_SESSION);

      const sessions = await Effect.runPromise(listPiSessions(fs));
      expect(sessions).toHaveLength(1);
      expect(sessions[0]).toMatchObject({
        id: "v3sess0001",
        cwd: "/tmp/pi-workspace",
        name: "flaky tests",
        messageCount: 3,
        firstMessage: "fix the flaky test",
        path,
      });
    });
  });

  it("skips malformed and non-session files silently", async () => {
    await withPiAgentDir(async (root) => {
      await writeSession(root, "--tmp-other--", "not-json.jsonl", "not json at all\n");
      await writeSession(root, "--tmp-other--", "empty.jsonl", "");
      await writeSession(root, "--tmp-other--", "good.jsonl", V3_SESSION);
      const sessions = await Effect.runPromise(listPiSessions(fs));
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.id).toBe("v3sess0001");
    });
  });

  it("lists v4 sessions through the header line", async () => {
    await withPiAgentDir(async (root) => {
      const content = [
        '{"kind":"header","version":4,"id":"v4sess0001","createdAt":1780500000000,"cwd":"/tmp/v4-workspace"}',
        '{"kind":"entry","seq":1,"lane":"main","id":"e1","type":"model_change","parentId":null,"timestamp":1780500000001,"provider":"p","modelId":"m"}',
        '{"kind":"entry","seq":2,"lane":"main","id":"e2","type":"message","parentId":"e1","timestamp":1780500000002,"message":{"role":"user","content":[{"type":"text","text":"hello v4"}]}}',
        '{"kind":"fact","seq":3,"fact":"name","name":"v4 named"}',
      ].join("\n") + "\n";
      await writeSession(root, "--tmp-v4-workspace--", "2026-01-31T22-33-31-764Z_v4sess0001.jsonl", content);

      const sessions = await Effect.runPromise(listPiSessions(fs));
      expect(sessions).toHaveLength(1);
      expect(sessions[0]).toMatchObject({
        id: "v4sess0001",
        cwd: "/tmp/v4-workspace",
        name: "v4 named",
        messageCount: 1,
        firstMessage: "hello v4",
      });
    });
  });

  it("sorts newest first by modified time", async () => {
    await withPiAgentDir(async (root) => {
      const oldContent = V3_SESSION;
      const newContent = V3_SESSION.replace("v3sess0001", "v3sess0002").replace("/tmp/pi-workspace", "/tmp/pi-other");
      await writeSession(root, "--tmp-pi-workspace--", "2026-01-31T22-33-31-764Z_v3sess0001.jsonl", oldContent);
      const newPath = await writeSession(root, "--tmp-pi-other--", "2026-02-01T22-33-31-764Z_v3sess0002.jsonl", newContent);
      const sessions = await Effect.runPromise(listPiSessions(fs));
      expect(sessions.map((s) => s.id)).toEqual(["v3sess0002", "v3sess0001"]);
      expect(sessions[0]?.path).toBe(newPath);
    });
  });
});

describe("readPiSession (v3)", () => {
  it("maps v3 lines to consecutive, replayable mutations", async () => {
    await withPiAgentDir(async (root) => {
      const path = await writeSession(root, "--tmp-pi-workspace--", "2026-01-31T22-33-31-764Z_v3sess0001.jsonl", V3_SESSION);
      const data = await Effect.runPromise(readPiSession(fs, path));

      expect(data).toMatchObject({
        id: "v3sess0001",
        cwd: "/tmp/pi-workspace",
        name: "flaky tests",
        firstMessage: "fix the flaky test",
      });

      // Entry mutations: model_change, thinking_level_change, message×3,
      // custom_message (as a role-custom message), message — the label and
      // session_info lines became facts, so 6 entries + 2 facts + 1 lane.
      const entries = data.mutations.filter((m) => m.kind === "entry");
      const facts = data.mutations.filter((m) => m.kind === "fact");
      const lanes = data.mutations.filter((m) => m.kind === "lane");

      expect(entries).toHaveLength(6);
      expect(facts).toHaveLength(2);
      expect(lanes).toHaveLength(1);

      // seqs are consecutive from 1 in file order.
      expect(data.mutations.map((m) => (m.kind === "entry" ? m.entry.seq : m.seq))).toEqual([
        1, 2, 3, 4, 5, 6, 7, 8, 9,
      ]);

      // The label and session_info are facts; their children re-parent to
      // the fact's own parent (the fact becomes transparent).
      const labelFact = facts.find((f) => f.kind === "fact" && f.fact === "label");
      expect(labelFact).toMatchObject({ fact: "label", targetId: "u1", label: "flagged" });
      const nameFact = facts.find((f) => f.kind === "fact" && f.fact === "name");
      expect(nameFact).toMatchObject({ fact: "name", name: "flaky tests" });

      const u2 = entries.find((e) => e.kind === "entry" && e.entry.id === "u2");
      expect(u2?.kind === "entry" ? u2.entry.parentId : null).toBe("c1"); // l1 re-parented away
      const s1Child = entries.find((e) => e.kind === "entry" && e.entry.id === "u2");
      expect(s1Child?.kind === "entry" ? s1Child.entry.parentId : null).toBe("c1");

      // custom_message became a message entry with role "custom".
      const custom = entries.find((e) => e.kind === "entry" && e.entry.id === "c1");
      expect(custom?.kind === "entry" ? custom.entry.type : "").toBe("message");
      const message = custom?.kind === "entry" ? (custom.entry as { message?: { role?: string; customType?: string; display?: boolean } }).message : undefined;
      expect(message).toMatchObject({ role: "custom", customType: "ext.demo", display: true });

      // The final lane fact pins the leaf to the last entry (u2).
      expect(lanes[0]).toMatchObject({ lane: "main", leafId: "u2" });
    });
  });

  it("re-parents through consecutive facts", async () => {
    await withPiAgentDir(async (root) => {
      const content = [
        '{"type":"session","version":3,"id":"chain0001","timestamp":"2026-01-31T22:00:00.000Z","cwd":"/tmp/chain"}',
        '{"type":"message","id":"a","parentId":null,"timestamp":"2026-01-31T22:00:01.000Z","message":{"role":"user","content":"one"}}',
        '{"type":"session_info","id":"f1","parentId":"a","timestamp":"2026-01-31T22:00:02.000Z","name":"first"}',
        '{"type":"session_info","id":"f2","parentId":"f1","timestamp":"2026-01-31T22:00:03.000Z","name":"second"}',
        '{"type":"message","id":"b","parentId":"f2","timestamp":"2026-01-31T22:00:04.000Z","message":{"role":"assistant","content":"two"}}',
      ].join("\n") + "\n";
      const path = await writeSession(root, "--tmp-chain--", "chain0001.jsonl", content);
      const data = await Effect.runPromise(readPiSession(fs, path));
      const b = data.mutations.find((m) => m.kind === "entry" && m.entry.id === "b");
      // f2's parent is f1, whose parent is a — b chains to a.
      expect(b?.kind === "entry" ? b.entry.parentId : null).toBe("a");
      // The name is the latest session_info.
      expect(data.name).toBe("second");
    });
  });

  it("synthesizes retainedTail for compaction entries", async () => {
    await withPiAgentDir(async (root) => {
      const content = [
        '{"type":"session","version":3,"id":"comp00001","timestamp":"2026-01-31T22:00:00.000Z","cwd":"/tmp/comp"}',
        '{"type":"message","id":"a","parentId":null,"timestamp":"2026-01-31T22:00:01.000Z","message":{"role":"user","content":"old 1"}}',
        '{"type":"message","id":"b","parentId":"a","timestamp":"2026-01-31T22:00:02.000Z","message":{"role":"assistant","content":"old 2"}}',
        '{"type":"compaction","id":"c","parentId":"b","timestamp":"2026-01-31T22:00:03.000Z","summary":"summarized the old stuff","firstKeptEntryId":"b","tokensBefore":123}',
        '{"type":"message","id":"d","parentId":"c","timestamp":"2026-01-31T22:00:04.000Z","message":{"role":"user","content":"new 1"}}',
      ].join("\n") + "\n";
      const path = await writeSession(root, "--tmp-comp--", "comp00001.jsonl", content);
      const data = await Effect.runPromise(readPiSession(fs, path));
      const compaction = data.mutations.find((m) => m.kind === "entry" && m.entry.id === "c");
      const entry = compaction?.kind === "entry" ? compaction.entry : undefined;
      expect(entry?.type).toBe("compaction");
      // Kept region: firstKeptEntryId (b) → leaf (d): messages "old 2" and "new 1".
      const tail = (entry as { retainedTail?: { content: unknown }[] } | undefined)?.retainedTail;
      expect(tail).toHaveLength(2);
      expect(tail?.[0]).toMatchObject({ role: "assistant" });
      expect(tail?.[1]).toMatchObject({ role: "user" });
    });
  });

  it("rejects a broken parent chain with the offending line", async () => {
    await withPiAgentDir(async (root) => {
      const content = [
        '{"type":"session","version":3,"id":"broken001","timestamp":"2026-01-31T22:00:00.000Z","cwd":"/tmp/broken"}',
        '{"type":"message","id":"a","parentId":null,"timestamp":"2026-01-31T22:00:01.000Z","message":{"role":"user","content":"one"}}',
        '{"type":"message","id":"b","parentId":"ghost","timestamp":"2026-01-31T22:00:02.000Z","message":{"role":"assistant","content":"two"}}',
      ].join("\n") + "\n";
      const path = await writeSession(root, "--tmp-broken--", "broken001.jsonl", content);
      const outcome = await Effect.runPromise(readPiSession(fs, path).pipe(Effect.result));
      expect(Result.isFailure(outcome)).toBe(true);
      if (Result.isFailure(outcome)) {
        expect(outcome.failure).toBeInstanceOf(PiSessionsError);
        expect(outcome.failure.message).toContain("line 3");
        expect(outcome.failure.message).toContain("ghost");
      }
    });
  });
});

describe("readPiSession (v4)", () => {
  it("adopts a v4 file through pi's own repo, re-pinning lanes", async () => {
    await withPiAgentDir(async (root) => {
      const content = [
        '{"kind":"header","version":4,"id":"v4imp0001","createdAt":1780500000000,"cwd":"/tmp/v4-import"}',
        '{"kind":"entry","seq":1,"lane":"main","id":"e1","type":"model_change","parentId":null,"timestamp":1780500000001,"provider":"p","modelId":"m"}',
        '{"kind":"entry","seq":2,"lane":"main","id":"e2","type":"message","parentId":"e1","timestamp":1780500000002,"message":{"role":"user","content":[{"type":"text","text":"hello v4"}]}}',
        '{"kind":"entry","seq":3,"lane":"main","id":"e3","type":"message","parentId":"e2","timestamp":1780500000003,"message":{"role":"assistant","content":[{"type":"text","text":"hi"}]}}',
        '{"kind":"fact","seq":4,"fact":"name","name":"v4 imported"}',
      ].join("\n") + "\n";
      const path = await writeSession(root, "--tmp-v4-import--", "2026-01-31T22-33-31-764Z_v4imp0001.jsonl", content);

      const data = await Effect.runPromise(readPiSession(fs, path));
      expect(data).toMatchObject({ id: "v4imp0001", cwd: "/tmp/v4-import", name: "v4 imported" });
      const entries = data.mutations.filter((m) => m.kind === "entry");
      expect(entries).toHaveLength(3);
      // The main lane leaf was carried on entry lines; re-pinned at the end.
      const lanes = data.mutations.filter((m) => m.kind === "lane");
      expect(lanes).toEqual([{ kind: "lane", seq: 5, lane: "main", leafId: "e3" }]);
      // Mutations replay consecutively.
      const seqs = data.mutations.map((m) => (m.kind === "entry" ? m.entry.seq : m.seq));
      expect(seqs).toEqual([1, 2, 3, 4, 5]);
    });
  });
});
