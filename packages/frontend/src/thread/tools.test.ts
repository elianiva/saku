/**
 * Per-tool argument rendering tests (tools.test.ts): each tool's args
 * render as a one-line preview plus structured lines (not raw JSON), and
 * unknown tools fall back to JSON. String-encoded arguments (pi's streamed
 * form) decode like objects.
 */

import { describe, expect, it } from "vitest";

import { jsonLine, toolArgsView } from "./tools.ts";

describe("toolArgsView", () => {
  it("renders bash as the command line with an optional timeout", () => {
    const view = toolArgsView("bash", { command: "pnpm test", timeout: 30 });
    expect(view.preview).toBe("$ pnpm test · timeout 30s");
    expect(view.lines).toEqual([
      { kind: "code", text: "pnpm test" },
      { kind: "label", text: "timeout 30s" },
    ]);
    expect(toolArgsView("bash", { command: "ls" }).preview).toBe("$ ls");
  });

  it("renders read with pi's line-range suffix", () => {
    expect(toolArgsView("read", { path: "src/a.ts" }).preview).toBe("src/a.ts");
    expect(toolArgsView("read", { limit: 40, offset: 10, path: "src/a.ts" }).preview).toBe(
      "src/a.ts:10-49",
    );
    expect(toolArgsView("read", { offset: 10, path: "src/a.ts" }).preview).toBe("src/a.ts:10");
  });

  it("renders write as the path plus a capped content block", () => {
    const view = toolArgsView("write", { content: "export const a = 1;", path: "src/new.ts" });
    expect(view.preview).toBe("src/new.ts");
    expect(view.lines[0]).toEqual({ kind: "code", text: "src/new.ts" });
    expect(view.lines[1]).toEqual({ kind: "code", text: "export const a = 1;" });
  });

  it("renders edit as the path with one −/+ pair per edit", () => {
    const view = toolArgsView("edit", {
      edits: [
        { newText: "new one", oldText: "old one" },
        { newText: "new two", oldText: "old two" },
      ],
      path: "src/a.ts",
    });
    expect(view.preview).toBe("src/a.ts · 2 edits");
    expect(view.lines).toEqual([
      { kind: "code", text: "src/a.ts" },
      { kind: "label", text: "edit 1" },
      { kind: "removed", text: "old one" },
      { kind: "added", text: "new one" },
      { kind: "label", text: "edit 2" },
      { kind: "removed", text: "old two" },
      { kind: "added", text: "new two" },
    ]);
    // A single edit keeps the bare path preview.
    expect(
      toolArgsView("edit", { edits: [{ newText: "b", oldText: "a" }], path: "src/a.ts" }).preview,
    ).toBe("src/a.ts");
  });

  it("renders grep with the pattern, path, flags, glob, and limit", () => {
    const view = toolArgsView("grep", {
      context: 2,
      glob: "*.ts",
      ignoreCase: true,
      limit: 50,
      path: "src/",
      pattern: "foo",
    });
    expect(view.preview).toBe("/foo/ in src/ -i -c 2 (*.ts) limit 50");
    expect(view.lines[0]).toEqual({ kind: "code", text: "/foo/" });
    // A bare grep defaults the path to `.` and shows no `in` label.
    expect(toolArgsView("grep", { pattern: "foo" }).preview).toBe("/foo/ in .");
  });

  it("renders find and ls with their path and limit", () => {
    expect(toolArgsView("find", { limit: 10, path: "src", pattern: "**/*.ts" }).preview).toBe(
      "**/*.ts in src limit 10",
    );
    expect(toolArgsView("ls", { limit: 500, path: "packages" }).preview).toBe("packages limit 500");
    expect(toolArgsView("ls", {}).preview).toBe(".");
  });

  it("decodes string-encoded arguments like objects", () => {
    const view = toolArgsView("bash", JSON.stringify({ command: "echo hi" }));
    expect(view.preview).toBe("$ echo hi");
    expect(view.lines).toEqual([{ kind: "code", text: "echo hi" }]);
  });

  it("falls back to one-line JSON for unknown tools", () => {
    const view = toolArgsView("web_search", { query: "pi" });
    expect(view.preview).toBe('{"query":"pi"}');
    expect(view.lines).toEqual([{ kind: "code", text: '{"query":"pi"}' }]);
  });

  it("caps previews and code content", () => {
    const long = "a".repeat(500);
    const bash = toolArgsView("bash", { command: long });
    expect(bash.preview.endsWith("…")).toBe(true);
    const write = toolArgsView("write", { content: "b".repeat(1000), path: "f" });
    const [, contentLine] = write.lines;
    if (contentLine === undefined) {
      throw new Error("expected the content line");
    }
    expect(contentLine.text.length).toBeLessThan(1000);
  });
});

describe("jsonLine", () => {
  it("renders strings verbatim, objects as JSON, and undefined as empty", () => {
    expect(jsonLine("raw")).toBe("raw");
    expect(jsonLine({ a: 1 })).toBe('{"a":1}');
    const empty = undefined;
    expect(jsonLine(empty)).toBe("");
  });
});
