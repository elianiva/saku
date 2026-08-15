/**
 * Markdown conversion tests (markdown.test.ts): the md4x Comark AST →
 * foldkit VNode mapping, asserted on the built tree (the foldkit test
 * harness's `__setRuntime` frame is not needed — `inertHtml` builds real
 * VNodes with no dispatch). The contracts pinned here: block elements map
 * to the matching tags with the `saku-md-*` classes, literal containers
 * (code, math, raw html) render their text as text nodes, raw HTML never
 * becomes markup, comments and frontmatter vanish, unknown tags degrade to
 * a wrapper, and the streaming cursor lands inside the last inline block.
 */

import { describe, expect, it } from "vitest";
import { inertHtml } from "foldkit/html";

import { markdownBody, markdownReady } from "./markdown.ts";

/** The structural VNode subset the assertions read. */
interface TestNode {
  readonly sel?: string;
  readonly data?: {
    readonly class?: Readonly<Record<string, boolean>>;
    readonly attrs?: Readonly<Record<string, string>>;
    readonly props?: Readonly<Record<string, unknown>>;
    readonly style?: Readonly<Record<string, string>>;
  };
  readonly children?: ReadonlyArray<TestNode | string>;
  readonly text?: string;
}

type TestChild = TestNode | string;

const body = (markdown: string, cursor = false) =>
  markdownBody(inertHtml, markdown, cursor) as TestNode;

const classNames = (node: TestNode) => Object.keys(node.data?.class ?? {});

const textOf = (node: TestNode): string =>
  node.text ??
  (node.children ?? [])
    .map((child) => (typeof child === "string" ? child : textOf(child)))
    .join("");

const kids = (node: TestNode) => (node.children ?? []) as Array<TestChild>;

/** The element children (text runs and text vnodes skipped). */
const elementKids = (node: TestNode): TestNode[] =>
  kids(node).filter((c): c is TestNode => typeof c !== "string" && c.sel !== undefined);

/** The element child at `index`, failing the test when absent. */
const child = (node: TestNode, index: number): TestNode => {
  const item = elementKids(node)[index];
  if (item === undefined) throw new Error(`no element child at ${index}`);
  return item;
};

describe("markdown body", () => {
  it("is null for an empty body", () => {
    expect(markdownBody(inertHtml, "")).toBeNull();
  });

  it("renders headings with ids", async () => {
    await markdownReady;
    const root = body("# Hello **world**\n\n## Again");
    expect(root.sel).toBe("div");
    expect(classNames(root)).toContain("saku-md");
    const h1 = child(root, 0);
    const h2 = child(root, 1);
    expect(h1.sel).toBe("h1");
    expect(classNames(h1)).toEqual(expect.arrayContaining(["saku-md-h", "saku-md-h1"]));
    // `Id` lands on `data.props` (the builder's setDataProp path).
    expect(h1.data?.props?.id).toBe("hello-world");
    expect(textOf(h1)).toBe("Hello world");
    expect(child(h1, 0).sel).toBe("strong");
    expect(h2.sel).toBe("h2");
    expect(textOf(h2)).toBe("Again");
  });

  it("maps paragraphs and inline styles", async () => {
    await markdownReady;
    const root = body("a *b* **c** `d` ~~e~~ [f](https://x.test)");
    const p = child(root, 0);
    expect(p.sel).toBe("p");
    expect(textOf(kids(p)[0] as TestNode)).toBe("a ");
    expect(child(p, 0).sel).toBe("em");
    expect(child(p, 1).sel).toBe("strong");
    expect(child(p, 2).sel).toBe("code");
    expect(classNames(child(p, 2))).toContain("saku-md-code-inline");
    expect(textOf(child(p, 2))).toBe("d");
    expect(child(p, 3).sel).toBe("del");
    const link = child(p, 4);
    expect(link.sel).toBe("a");
    expect(link.data?.props?.href).toBe("https://x.test");
    expect(link.data?.props?.target).toBe("_blank");
  });

  it("renders lists and task items", async () => {
    await markdownReady;
    const root = body("- one\n- [x] two\n- [ ] three\n\n1. first\n2. second");
    const ul = child(root, 0);
    const ol = child(root, 1);
    expect(ul.sel).toBe("ul");
    const items = kids(ul);
    expect(items.map((li) => textOf(li as TestNode))).toEqual(["one", "two", "three"]);
    expect(classNames(child(items[1] as TestNode, 0))).toContain("saku-md-task");
    expect(child(child(items[1] as TestNode, 0), 0).sel).toBe("svg");
    expect(classNames(child(items[2] as TestNode, 0))).toContain("saku-md-task");
    expect(child(child(items[2] as TestNode, 0), 0).sel).toBe("svg");
    expect(ol.sel).toBe("ol");
  });

  it("renders code blocks with their language", async () => {
    await markdownReady;
    const root = body("```ts\nconst x = 1;\n```");
    const pre = child(root, 0);
    expect(pre.sel).toBe("pre");
    expect(classNames(pre)).toContain("saku-md-pre");
    const code = child(pre, 0);
    expect(code.sel).toBe("code");
    expect(classNames(code)).toContain("language-ts");
    expect(textOf(code)).toBe("const x = 1;\n");
  });

  it("renders tables with alignment", async () => {
    await markdownReady;
    const root = body("| a | b |\n|---|:--:|\n| 1 | 2 |");
    const wrap = child(root, 0);
    expect(wrap.sel).toBe("div");
    const table = child(wrap, 0);
    expect(table.sel).toBe("table");
    const thead = child(table, 0);
    const th = kids(child(thead, 0));
    expect((th[0] as TestNode).sel).toBe("th");
    expect((th[1] as TestNode).data?.style?.textAlign).toBe("center");
    const tbody = child(table, 1);
    expect((kids(child(tbody, 0))[0] as TestNode | undefined)?.sel).toBe("td");
  });

  it("renders blockquotes and alerts", async () => {
    await markdownReady;
    const root = body("> a quote\n\n> [!WARNING]\n> careful");
    const quote = child(root, 0);
    const alert = child(root, 1);
    expect(quote.sel).toBe("blockquote");
    expect(textOf(quote)).toBe("a quote");
    expect(alert.sel).toBe("div");
    expect(classNames(alert)).toEqual(
      expect.arrayContaining(["saku-md-alert", "saku-md-alert-warning"]),
    );
    expect(child(alert, 0).sel).toBe("div");
    expect(textOf(child(alert, 0))).toBe("warning");
  });

  it("never injects raw html and drops comments and frontmatter", async () => {
    await markdownReady;
    const root = body(
      "---\nhidden: true\n---\n\nbefore <script>alert(1)</script> after\n\n<!-- a comment -->",
    );
    const nodes = kids(root);
    // Frontmatter and the comment never render; the raw script tag is a
    // literal text run, never an element.
    expect(nodes.length).toBe(1);
    const raw = child(root, 0);
    expect(raw.sel).toBe("p");
    expect(textOf(raw)).toBe("before <script>alert(1)</script> after");
  });

  it("renders math as literal source", async () => {
    await markdownReady;
    const root = body("inline $E=mc^2$ and display\n\n$$\\int x dx$$");
    const p = child(root, 0);
    const math = child(p, 0);
    expect(math.sel).toBe("code");
    expect(classNames(math)).toContain("saku-md-math");
    expect(textOf(math)).toBe("E=mc^2");
    // Display math arrives wrapped in a paragraph; the body is the block.
    const display = child(child(root, 1), 0);
    expect(display.sel).toBe("div");
    expect(classNames(display)).toContain("saku-md-math-display");
    expect(textOf(display)).toBe("\\int x dx");
  });

  it("places the streaming cursor inside the last block", async () => {
    await markdownReady;
    const root = body("one\n\ntwo **bold**", true);
    const last = child(root, 1);
    expect(last.sel).toBe("p");
    // The cursor rides inside the last element of the last block, right
    // where the stream continues.
    const strong = child(last, 0);
    expect(strong.sel).toBe("strong");
    const cursor = child(strong, 0);
    expect(cursor.sel).toBe("span");
    expect(classNames(cursor)).toContain("saku-cursor");
  });

  it("degrades unknown tags to a wrapper", async () => {
    await markdownReady;
    const root = body("::badge[New]{color=blue} here");
    const p = child(root, 0);
    expect(p.sel).toBe("p");
    const badge = child(p, 0);
    expect(badge.sel).toBe("span");
    expect(textOf(badge)).toBe("New");
  });
});
