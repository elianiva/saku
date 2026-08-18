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
import { homedir } from "node:os";

import {
  browseProjectDirs,
  listPiSessions,
  readPiSession,
  PiSessionsError,
} from "../src/pi-sessions/index.ts";
import { Paths, PathsTest } from "../src/paths.ts";
import type { PathsLayout } from "../src/paths.ts";
import type { SessionMutation } from "../src/session-state.ts";

const fs = await Effect.runPromise(
  Effect.provide(NodeFileSystem.layer)(
    Effect.gen(function* () {
      return yield* FileSystem.FileSystem;
    }),
  ),
);

/** The browse tests' real directory tree: fixed, dash-free paths (the
 *  lossy session-dir decode needs dash-free paths to round-trip into
 *  candidates). */
const FIXTURE_TREE = "/tmp/sakupicker";

/** The mutation's log sequence: entries carry theirs on the entry. */
const mutationSeq = (mutation: SessionMutation): number => {
  if (mutation.kind === "entry") {
    return mutation.entry.seq;
  }
  return mutation.kind === "record" ? mutation.record.seq : mutation.seq;
};

/** A temp dir acting as pi's agent dir; the layout comes from `PathsTest`. */
const withPiAgentDir = async <T>(run: (root: string, paths: PathsLayout) => Promise<T>) =>
  await Effect.runPromise(
    Effect.gen(function* () {
      const paths = yield* Paths;
      const outcome = yield* Effect.tryPromise(async () => await run(paths.agentDir, paths));
      return outcome;
    }).pipe(Effect.provide(PathsTest()), Effect.provide(NodeFileSystem.layer)),
  );

const writeSession = async (root: string, cwdSlug: string, fileName: string, content: string) =>
  await Effect.runPromise(
    Effect.gen(function* () {
      const dir = `${root}/sessions/${cwdSlug}`;
      yield* fs.makeDirectory(dir, { recursive: true });
      yield* fs.writeFileString(`${dir}/${fileName}`, content);
      return `${dir}/${fileName}`;
    }),
  );

/** A realistic v3 session: header, model, thinking level, messages, a name,
 * a label (chained like an entry), a custom_message, and a compaction. */
const V3_SESSION = `${[
  '{"type":"session","version":3,"id":"v3sess0001","timestamp":"2026-01-31T22:33:31.764Z","cwd":"/tmp/pi-workspace"}',
  '{"type":"model_change","id":"m1","parentId":null,"timestamp":"2026-01-31T22:33:31.765Z","provider":"google-antigravity","modelId":"gemini-3-flash"}',
  '{"type":"thinking_level_change","id":"t1","parentId":"m1","timestamp":"2026-01-31T22:33:31.766Z","thinkingLevel":"low"}',
  '{"type":"message","id":"u1","parentId":"t1","timestamp":"2026-01-31T22:33:31.900Z","message":{"role":"user","content":[{"type":"text","text":"fix the flaky test"}]}}',
  '{"type":"message","id":"a1","parentId":"u1","timestamp":"2026-01-31T22:33:34.009Z","message":{"role":"assistant","content":[{"type":"text","text":"I am Pi."}]}}',
  '{"type":"custom_message","id":"c1","parentId":"a1","timestamp":"2026-01-31T22:33:35.000Z","customType":"ext.demo","content":[{"type":"text","text":"hello from an extension"}],"display":true,"details":{"k":1}}',
  '{"type":"label","id":"l1","parentId":"c1","timestamp":"2026-01-31T22:33:36.000Z","targetId":"u1","label":"flagged"}',
  '{"type":"message","id":"u2","parentId":"l1","timestamp":"2026-01-31T22:33:37.000Z","message":{"role":"user","content":"actually also check the e2e"}}',
  '{"type":"session_info","id":"s1","parentId":"u2","timestamp":"2026-01-31T22:33:38.000Z","name":"flaky tests"}',
].join("\n")}\n`;

describe("listPiSessions", () => {
  it("lists v3 sessions with pi's buildSessionInfo semantics", async () => {
    await withPiAgentDir(async (root, paths) => {
      const path = await writeSession(
        root,
        "--tmp-pi-workspace--",
        "2026-01-31T22-33-31-764Z_v3sess0001.jsonl",
        V3_SESSION,
      );

      const sessions = await Effect.runPromise(listPiSessions(fs, paths, ["/tmp/pi-workspace"]));
      expect(sessions).toHaveLength(1);
      expect(sessions[0]).toMatchObject({
        cwd: "/tmp/pi-workspace",
        firstMessage: "fix the flaky test",
        id: "v3sess0001",
        messageCount: 3,
        name: "flaky tests",
        path,
      });
    });
  });

  it("skips malformed and non-session files silently", async () => {
    await withPiAgentDir(async (root, paths) => {
      await writeSession(root, "--tmp-pi-workspace--", "not-json.jsonl", "not json at all\n");
      await writeSession(root, "--tmp-pi-workspace--", "empty.jsonl", "");
      await writeSession(root, "--tmp-pi-workspace--", "good.jsonl", V3_SESSION);
      const sessions = await Effect.runPromise(listPiSessions(fs, paths, ["/tmp/pi-workspace"]));
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.id).toBe("v3sess0001");
    });
  });

  it("lists v4 sessions through the header line", async () => {
    await withPiAgentDir(async (root, paths) => {
      const content = `${[
        '{"kind":"header","version":4,"id":"v4sess0001","createdAt":1780500000000,"cwd":"/tmp/v4-workspace"}',
        '{"kind":"entry","seq":1,"lane":"main","id":"e1","type":"model_change","parentId":null,"timestamp":1780500000001,"provider":"p","modelId":"m"}',
        '{"kind":"entry","seq":2,"lane":"main","id":"e2","type":"message","parentId":"e1","timestamp":1780500000002,"message":{"role":"user","content":[{"type":"text","text":"hello v4"}]}}',
        '{"kind":"fact","seq":3,"fact":"name","name":"v4 named"}',
      ].join("\n")}\n`;
      await writeSession(
        root,
        "--tmp-v4-workspace--",
        "2026-01-31T22-33-31-764Z_v4sess0001.jsonl",
        content,
      );

      const sessions = await Effect.runPromise(listPiSessions(fs, paths, ["/tmp/v4-workspace"]));
      expect(sessions).toHaveLength(1);
      expect(sessions[0]).toMatchObject({
        cwd: "/tmp/v4-workspace",
        firstMessage: "hello v4",
        id: "v4sess0001",
        messageCount: 1,
        name: "v4 named",
      });
    });
  });

  it("sorts newest first by modified time", async () => {
    await withPiAgentDir(async (root, paths) => {
      const oldContent = V3_SESSION;
      const newContent = V3_SESSION.replace("v3sess0001", "v3sess0002").replace(
        "/tmp/pi-workspace",
        "/tmp/pi-other",
      );
      await writeSession(
        root,
        "--tmp-pi-workspace--",
        "2026-01-31T22-33-31-764Z_v3sess0001.jsonl",
        oldContent,
      );
      const newPath = await writeSession(
        root,
        "--tmp-pi-other--",
        "2026-02-01T22-33-31-764Z_v3sess0002.jsonl",
        newContent,
      );
      const sessions = await Effect.runPromise(
        listPiSessions(fs, paths, ["/tmp/pi-workspace", "/tmp/pi-other"]),
      );
      expect(sessions.map((s) => s.id)).toEqual(["v3sess0002", "v3sess0001"]);
      expect(sessions[0]?.path).toBe(newPath);
    });
  });

  it("lists only the added projects' sessions, subtree included", async () => {
    await withPiAgentDir(async (root, paths) => {
      const rootContent = V3_SESSION;
      const nestedContent = V3_SESSION.replace("v3sess0001", "v3sess0003").replace(
        "/tmp/pi-workspace",
        "/tmp/pi-workspace/apps/web",
      );
      const otherContent = V3_SESSION.replace("v3sess0001", "v3sess0004").replace(
        "/tmp/pi-workspace",
        "/tmp/other",
      );
      await writeSession(root, "--tmp-pi-workspace--", "s1.jsonl", rootContent);
      await writeSession(root, "--tmp-pi-workspace-apps-web--", "s3.jsonl", nestedContent);
      await writeSession(root, "--tmp-other--", "s4.jsonl", otherContent);

      // The project claims its own dir AND subdirectories (sessions started
      // inside apps/web are part of the project); other projects stay out.
      const scoped = await Effect.runPromise(listPiSessions(fs, paths, ["/tmp/pi-workspace"]));
      const scopedIds = scoped.map((s) => s.id);
      expect(scopedIds).toContain("v3sess0001");
      expect(scopedIds).toContain("v3sess0003");
      expect(scopedIds).toHaveLength(2);

      // The other project sees only its own.
      const other = await Effect.runPromise(listPiSessions(fs, paths, ["/tmp/other"]));
      expect(other.map((s) => s.id)).toEqual(["v3sess0004"]);

      // No projects: an empty window, nothing scanned.
      const none = await Effect.runPromise(listPiSessions(fs, paths, []));
      expect(none).toHaveLength(0);
    });
  });

  it("verifies the header cwd so lossy dir names can't misattribute", async () => {
    await withPiAgentDir(async (root, paths) => {
      // The dir name `--tmp-pi-workspace-foo--` is ambiguous: it encodes
      // either the child /tmp/pi-workspace/foo or the dash-named sibling
      // /tmp/pi-workspace-foo. The header's real cwd decides.
      const child = V3_SESSION.replace("v3sess0001", "v3sess0005").replace(
        "/tmp/pi-workspace",
        "/tmp/pi-workspace/foo",
      );
      const sibling = V3_SESSION.replace("v3sess0001", "v3sess0006").replace(
        "/tmp/pi-workspace",
        "/tmp/pi-workspace-foo",
      );
      await writeSession(root, "--tmp-pi-workspace-foo--", "child.jsonl", child);
      await writeSession(root, "--tmp-pi-workspace-foo--", "sibling.jsonl", sibling);

      const sessions = await Effect.runPromise(listPiSessions(fs, paths, ["/tmp/pi-workspace"]));
      expect(sessions.map((s) => s.id)).toEqual(["v3sess0005"]);
    });
  });

  it("keeps pre-cwd sessions (empty header cwd) on their dir match", async () => {
    await withPiAgentDir(async (root, paths) => {
      const old = `${[
        '{"type":"session","version":3,"id":"old000001","timestamp":"2026-01-31T22:00:00.000Z","cwd":""}',
        '{"type":"message","id":"a","parentId":null,"timestamp":"2026-01-31T22:00:01.000Z","message":{"role":"user","content":"ancient"}}',
      ].join("\n")}\n`;
      await writeSession(root, "--tmp-pi-workspace--", "old.jsonl", old);

      const sessions = await Effect.runPromise(listPiSessions(fs, paths, ["/tmp/pi-workspace"]));
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.id).toBe("old000001");
    });
  });

  it("browses the add-project tree: one level, dirs only, candidates marked", async () => {
    await withPiAgentDir(async (root, paths) => {
      // Real, dash-free directories (the lossy decode needs dash-free
      // paths to round-trip into candidates) plus sessions whose dir
      // names decode to them.
      await Effect.runPromise(
        fs.makeDirectory(`${FIXTURE_TREE}/tree/apps/web`, { recursive: true }),
      );
      await Effect.runPromise(
        fs.makeDirectory(`${FIXTURE_TREE}/tree/apps/api`, { recursive: true }),
      );
      await Effect.runPromise(fs.makeDirectory(`${FIXTURE_TREE}/other`, { recursive: true }));
      await Effect.runPromise(fs.writeFileString(`${FIXTURE_TREE}/tree/notes.txt`, "x"));
      await writeSession(root, "--tmp-sakupicker-tree-apps-web--", "a.jsonl", V3_SESSION);
      await writeSession(root, "--tmp-sakupicker-other--", "b.jsonl", V3_SESSION);
      try {
        // The default root is the deepest common ancestor of the
        // candidates: /tmp/sakupicker shows both projects' parents.
        const opened = await Effect.runPromise(browseProjectDirs(fs, paths, ""));
        expect(opened.path).toBe(FIXTURE_TREE);
        expect(opened.parent).toBe("/tmp");
        expect(opened.entries).toEqual([
          { hasPiSessions: true, name: "other", path: `${FIXTURE_TREE}/other` },
          { hasPiSessions: false, name: "tree", path: `${FIXTURE_TREE}/tree` },
        ]);

        // Descend one level: dirs only (the file is filtered), the
        // candidate marked, the rest plain.
        const apps = await Effect.runPromise(browseProjectDirs(fs, paths, `${FIXTURE_TREE}/tree`));
        expect(apps.path).toBe(`${FIXTURE_TREE}/tree`);
        expect(apps.parent).toBe(FIXTURE_TREE);
        expect(apps.entries).toEqual([
          { hasPiSessions: false, name: "apps", path: `${FIXTURE_TREE}/tree/apps` },
        ]);

        // The filesystem root has no parent: no up row.
        const atRoot = await Effect.runPromise(browseProjectDirs(fs, paths, "/"));
        expect(atRoot.parent).toBeNull();
        expect(atRoot.entries.some((entry) => entry.name === "tmp")).toBe(true);
      } finally {
        await Effect.runPromise(fs.remove(FIXTURE_TREE, { force: true, recursive: true }));
      }
    });
  });

  it("a single candidate opens at its parent; no candidates opens at home", async () => {
    await withPiAgentDir(async (root, paths) => {
      // One candidate: the picker opens one level up so the project
      // itself is the first marked row.
      await Effect.runPromise(fs.makeDirectory(`${FIXTURE_TREE}/only`, { recursive: true }));
      await writeSession(root, "--tmp-sakupicker-only--", "a.jsonl", V3_SESSION);
      try {
        const single = await Effect.runPromise(browseProjectDirs(fs, paths, ""));
        expect(single.path).toBe(FIXTURE_TREE);
        expect(single.entries).toEqual([
          { hasPiSessions: true, name: "only", path: `${FIXTURE_TREE}/only` },
        ]);
      } finally {
        await Effect.runPromise(fs.remove(FIXTURE_TREE, { force: true, recursive: true }));
      }
    });
  });

  it("no candidates opens the picker at the home directory", async () => {
    await withPiAgentDir(async (_root, paths) => {
      const none = await Effect.runPromise(browseProjectDirs(fs, paths, ""));
      expect(none.path).toBe(homedir());
    });
  });

  it("a missing directory fails the browse with a scan error", async () => {
    await withPiAgentDir(async (_root, paths) => {
      const outcome = await Effect.runPromise(
        browseProjectDirs(fs, paths, "/definitely/not/a/real/dir").pipe(Effect.result),
      );
      expect(Result.isFailure(outcome)).toBe(true);
      if (Result.isFailure(outcome)) {
        expect(outcome.failure).toBeInstanceOf(PiSessionsError);
        expect(outcome.failure.kind).toBe("scan");
      }
    });
  });
});

describe("readPiSession (v3)", () => {
  it("maps v3 lines to consecutive, replayable mutations", async () => {
    await withPiAgentDir(async (root, paths) => {
      const path = await writeSession(
        root,
        "--tmp-pi-workspace--",
        "2026-01-31T22-33-31-764Z_v3sess0001.jsonl",
        V3_SESSION,
      );
      const data = await Effect.runPromise(readPiSession(fs, paths, path));

      expect(data).toMatchObject({
        cwd: "/tmp/pi-workspace",
        firstMessage: "fix the flaky test",
        id: "v3sess0001",
        name: "flaky tests",
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
      expect(data.mutations.map(mutationSeq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);

      // The label and session_info are facts; their children re-parent to
      // the fact's own parent (the fact becomes transparent).
      const labelFact = facts.find((f) => f.kind === "fact" && f.fact === "label");
      expect(labelFact).toMatchObject({ fact: "label", label: "flagged", targetId: "u1" });
      const nameFact = facts.find((f) => f.kind === "fact" && f.fact === "name");
      expect(nameFact).toMatchObject({ fact: "name", name: "flaky tests" });

      const u2 = entries.find((e) => e.kind === "entry" && e.entry.id === "u2");
      // l1 re-parented away
      expect(u2?.kind === "entry" ? u2.entry.parentId : null).toBe("c1");
      const s1Child = entries.find((e) => e.kind === "entry" && e.entry.id === "u2");
      expect(s1Child?.kind === "entry" ? s1Child.entry.parentId : null).toBe("c1");

      // custom_message became a message entry with role "custom".
      const custom = entries.find((e) => e.kind === "entry" && e.entry.id === "c1");
      expect(custom?.kind === "entry" ? custom.entry.type : "").toBe("message");
      const message =
        custom?.kind === "entry" && custom.entry.type === "message"
          ? custom.entry.message
          : undefined;
      expect(message).toMatchObject({ customType: "ext.demo", display: true, role: "custom" });

      // The final lane fact pins the leaf to the last entry (u2).
      expect(lanes[0]).toMatchObject({ lane: "main", leafId: "u2" });
    });
  });

  it("re-parents through consecutive facts", async () => {
    await withPiAgentDir(async (root, paths) => {
      const content = `${[
        '{"type":"session","version":3,"id":"chain0001","timestamp":"2026-01-31T22:00:00.000Z","cwd":"/tmp/chain"}',
        '{"type":"message","id":"a","parentId":null,"timestamp":"2026-01-31T22:00:01.000Z","message":{"role":"user","content":"one"}}',
        '{"type":"session_info","id":"f1","parentId":"a","timestamp":"2026-01-31T22:00:02.000Z","name":"first"}',
        '{"type":"session_info","id":"f2","parentId":"f1","timestamp":"2026-01-31T22:00:03.000Z","name":"second"}',
        '{"type":"message","id":"b","parentId":"f2","timestamp":"2026-01-31T22:00:04.000Z","message":{"role":"assistant","content":"two"}}',
      ].join("\n")}\n`;
      const path = await writeSession(root, "--tmp-chain--", "chain0001.jsonl", content);
      const data = await Effect.runPromise(readPiSession(fs, paths, path));
      const b = data.mutations.find((m) => m.kind === "entry" && m.entry.id === "b");
      // f2's parent is f1, whose parent is a — b chains to a.
      expect(b?.kind === "entry" ? b.entry.parentId : null).toBe("a");
      // The name is the latest session_info.
      expect(data.name).toBe("second");
    });
  });

  it("synthesizes retainedTail for compaction entries", async () => {
    await withPiAgentDir(async (root, paths) => {
      const content = `${[
        '{"type":"session","version":3,"id":"comp00001","timestamp":"2026-01-31T22:00:00.000Z","cwd":"/tmp/comp"}',
        '{"type":"message","id":"a","parentId":null,"timestamp":"2026-01-31T22:00:01.000Z","message":{"role":"user","content":"old 1"}}',
        '{"type":"message","id":"b","parentId":"a","timestamp":"2026-01-31T22:00:02.000Z","message":{"role":"assistant","content":"old 2"}}',
        '{"type":"compaction","id":"c","parentId":"b","timestamp":"2026-01-31T22:00:03.000Z","summary":"summarized the old stuff","firstKeptEntryId":"b","tokensBefore":123}',
        '{"type":"message","id":"d","parentId":"c","timestamp":"2026-01-31T22:00:04.000Z","message":{"role":"user","content":"new 1"}}',
      ].join("\n")}\n`;
      const path = await writeSession(root, "--tmp-comp--", "comp00001.jsonl", content);
      const data = await Effect.runPromise(readPiSession(fs, paths, path));
      const compaction = data.mutations.find((m) => m.kind === "entry" && m.entry.id === "c");
      const entry = compaction?.kind === "entry" ? compaction.entry : undefined;
      expect(entry?.type).toBe("compaction");
      // Kept region: firstKeptEntryId (b) → leaf (d): messages "old 2" and "new 1".
      const tail = entry?.type === "compaction" ? entry.retainedTail : undefined;
      expect(tail).toHaveLength(2);
      expect(tail?.[0]).toMatchObject({ role: "assistant" });
      expect(tail?.[1]).toMatchObject({ role: "user" });
    });
  });

  it("rejects a broken parent chain with the offending line", async () => {
    await withPiAgentDir(async (root, paths) => {
      const content = `${[
        '{"type":"session","version":3,"id":"broken001","timestamp":"2026-01-31T22:00:00.000Z","cwd":"/tmp/broken"}',
        '{"type":"message","id":"a","parentId":null,"timestamp":"2026-01-31T22:00:01.000Z","message":{"role":"user","content":"one"}}',
        '{"type":"message","id":"b","parentId":"ghost","timestamp":"2026-01-31T22:00:02.000Z","message":{"role":"assistant","content":"two"}}',
      ].join("\n")}\n`;
      const path = await writeSession(root, "--tmp-broken--", "broken001.jsonl", content);
      const outcome = await Effect.runPromise(readPiSession(fs, paths, path).pipe(Effect.result));
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
    await withPiAgentDir(async (root, paths) => {
      const content = `${[
        '{"kind":"header","version":4,"id":"v4imp0001","createdAt":1780500000000,"cwd":"/tmp/v4-import"}',
        '{"kind":"entry","seq":1,"lane":"main","id":"e1","type":"model_change","parentId":null,"timestamp":1780500000001,"provider":"p","modelId":"m"}',
        '{"kind":"entry","seq":2,"lane":"main","id":"e2","type":"message","parentId":"e1","timestamp":1780500000002,"message":{"role":"user","content":[{"type":"text","text":"hello v4"}]}}',
        '{"kind":"entry","seq":3,"lane":"main","id":"e3","type":"message","parentId":"e2","timestamp":1780500000003,"message":{"role":"assistant","content":[{"type":"text","text":"hi"}]}}',
        '{"kind":"fact","seq":4,"fact":"name","name":"v4 imported"}',
      ].join("\n")}\n`;
      const path = await writeSession(
        root,
        "--tmp-v4-import--",
        "2026-01-31T22-33-31-764Z_v4imp0001.jsonl",
        content,
      );

      const data = await Effect.runPromise(readPiSession(fs, paths, path));
      expect(data).toMatchObject({ cwd: "/tmp/v4-import", id: "v4imp0001", name: "v4 imported" });
      const entries = data.mutations.filter((m) => m.kind === "entry");
      expect(entries).toHaveLength(3);
      // The main lane leaf was carried on entry lines; re-pinned at the end.
      const lanes = data.mutations.filter((m) => m.kind === "lane");
      expect(lanes).toEqual([{ kind: "lane", lane: "main", leafId: "e3", seq: 5 }]);
      // Mutations replay consecutively.
      const seqs = data.mutations.map(mutationSeq);
      expect(seqs).toEqual([1, 2, 3, 4, 5]);
    });
  });
});
