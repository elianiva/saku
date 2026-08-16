/**
 * Markdown rendering (thread/markdown.ts): LLM bodies — the assistant
 * message text and its thinking block — are markdown, parsed with md4x
 * (the unjs/md4c port). The `md4x/standalone` entry is the self-contained
 * module Vite's `browser` condition also resolves the bare `md4x` import
 * to: the WASM binary inlined (nothing to fetch, no native addon), and
 * the only entry whose types declare the API. It runs the same in Node
 * (tests) and the browser; both expose the same `parseAST` → Comark tree
 * (tuples: `[tag, props, ...children]`, text as plain strings).
 *
 * The Comark tree is converted into foldkit nodes here, through the view's
 * own builder, so LLM output can never inject markup: raw HTML arrives as
 * an `html` node and renders as escaped text, comments and frontmatter are
 * dropped, and unknown tags (MDC components) degrade to a plain wrapper
 * around their children.
 *
 * md4x needs one async `init()` before parsing (WASM inflate + instantiate).
 * The module fires it at load; until it resolves — a frame or two, long
 * before the first trail renders — bodies fall back to the plain pre-wrap
 * rendering, and a parse failure falls back the same way.
 */

import { Option, Result, Schema as S } from "effect";
import { init as md4xInit, parseAST } from "md4x/standalone";
import type { ComarkElement, ComarkElementAttributes, ComarkNode } from "md4x";
import type { Html, HtmlBuilder } from "foldkit/html";

import { icon } from "../icon.ts";

/** A foldkit child: a built node or a text run. */
type FoldkitChild = Html | string;

let ready = false;

/** Resolves once md4x is ready to parse (browser: WASM instantiated). */
export const markdownReady = (async () => {
  try {
    await md4xInit();
    ready = true;
  } catch (error) {
    // md4x stays unready; bodies keep falling back to plain rendering.
    void error;
  }
})();

const parseTree = (text: string) => {
  const raw = Result.try(() => parseAST(text));
  return Result.isSuccess(raw) ? raw.success : null;
};

/** A comark node that is a plain text run. */
const isText = (node: ComarkNode): node is string => typeof node === "string";

/** An element's children (everything past the tag/props tuple head). */
const tail = (node: ComarkElement) => {
  const [tag, props, ...children] = node;
  void tag;
  void props;
  return children;
};

/** The literal text of a node subtree (code, math, raw html bodies). */
const textOf = (nodes: readonly ComarkNode[]): string =>
  nodes.map((node) => (isText(node) ? node : textOf(tail(node)))).join("");

/** The string value of a prop, absent when it is missing or not a string. */
const DECODE_STRING = S.decodeUnknownOption(S.String);
const strProp = (props: ComarkElementAttributes, key: string) =>
  Option.getOrElse(DECODE_STRING(props[key]), () => "");

/** A rendered node plus whether it hosted the streaming cursor. */
interface Rendered {
  readonly node: FoldkitChild;
  readonly placed: boolean;
}

/** The block-level tags the comark tree can emit at document level. */
const BLOCK_TAGS: ReadonlySet<string> = new Set([
  "p",
  "blockquote",
  "ul",
  "ol",
  "li",
  "hr",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "pre",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
  "frontmatter",
  "alert",
  "footnotes",
  "footnote",
  "template",
  "math-display",
  "html",
]);

const isBlockTag = (tag: string | null) => tag !== null && BLOCK_TAGS.has(tag);

/** Whether a subtree holds a block element (unknown tags pick div vs span). */
const holdsBlock = (nodes: readonly ComarkNode[]): boolean =>
  nodes.some((node) => !isText(node) && (isBlockTag(node[0]) || holdsBlock(tail(node))));

/** The streaming cursor (live region): a blinking block appended in-line. */
const cursorSpan = <M>(h: HtmlBuilder<M>) =>
  h.span([h.Class("saku-cursor"), h.Attribute("aria-hidden", "true")], []);

/** The pre-markdown fallback: the old plain pre-wrap body. */
const plainBody = <M>(h: HtmlBuilder<M>, text: string) =>
  h.div([h.Class("whitespace-pre-wrap text-[13px] leading-relaxed")], [text]);

/** Wrap a built node as a placed render (the streaming cursor moved past it). */
const container = (element: Html): Rendered => ({ node: element, placed: true });

/** Render a node list, carrying the streaming cursor (renderChildren). */
type Render = (children: readonly ComarkNode[], cursor: boolean) => FoldkitChild[];

/** One tag's renderer context: the builder, the recursion seam, the
 *  element's children, the cursor flag, and its props. */
interface RendererContext<M> {
  readonly children: readonly ComarkNode[];
  readonly cursor: boolean;
  readonly h: HtmlBuilder<M>;
  readonly props: ComarkElementAttributes;
  readonly render: Render;
}

/** One tag's renderer: a context → rendered node. */
type Renderer = <M>(ctx: RendererContext<M>) => Rendered;

/** The null/frontmatter handler: nothing renders. */
const skip = (): Rendered => ({ node: null, placed: false });

/** Raw HTML (either spelling) is a text node: escaped by the builder,
 *  never injected. */
const rawHtml = ({ children }: { children: readonly ComarkNode[] }): Rendered => ({
  node: textOf(children),
  placed: false,
});

const lineBreak = <M>({ h }: RendererContext<M>): Rendered => ({
  node: h.br([h.Class("saku-md-br")]),
  placed: false,
});

const rule = <M>({ h }: RendererContext<M>): Rendered => ({
  node: h.hr([h.Class("saku-md-hr")]),
  placed: false,
});

const image = <M>({ h, props }: RendererContext<M>): Rendered => {
  const src = strProp(props, "src");
  const alt = strProp(props, "alt");
  const title = strProp(props, "title");
  return {
    node: h.img([
      h.Class("saku-md-img"),
      ...(src === "" ? [] : [h.Src(src)]),
      ...(alt === "" ? [] : [h.Alt(alt)]),
      ...(title === "" ? [] : [h.Title(title)]),
    ]),
    placed: false,
  };
};

/** A plain block wrapper with the `saku-md-<tag>` class. */
const simple =
  (tag: "p" | "blockquote" | "ul") =>
  <M>({ h, render, children, cursor }: RendererContext<M>) =>
    container(h[tag]([h.Class(`saku-md-${tag}`)], render(children, cursor)));

const orderedList = <M>({ h, render, children, cursor, props }: RendererContext<M>) => {
  const start = Number(strProp(props, "start"));
  return container(
    h.ol(
      [h.Class("saku-md-ol"), ...(Number.isInteger(start) && start > 1 ? [h.Start(start)] : [])],
      render(children, cursor),
    ),
  );
};

const listItem = <M>({ h, render, children, cursor, props }: RendererContext<M>) => {
  const kids = render(children, cursor);
  return container(
    h.li(
      [h.Class("saku-md-li")],
      [
        ...(props.task === true
          ? [
              h.span(
                [
                  h.Class("saku-md-task"),
                  h.AriaLabel(props.checked === true ? "completed task" : "incomplete task"),
                ],
                [icon(h, props.checked === true ? "squareCheck" : "square")],
              ),
            ]
          : []),
        ...kids,
      ],
    ),
  );
};

/** Headings: the level only changes the builder method. */
const heading =
  (tag: "h1" | "h2" | "h3" | "h4" | "h5" | "h6") =>
  <M>({ h, render, children, cursor, props }: RendererContext<M>) => {
    const id = strProp(props, "id");
    return container(
      h[tag](
        [h.Class(`saku-md-h saku-md-${tag}`), ...(id === "" ? [] : [h.Id(id)])],
        render(children, cursor),
      ),
    );
  };

/** Table cells: alignment survives when present. */
const cell =
  (tag: "th" | "td") =>
  <M>({ h, render, children, cursor, props }: RendererContext<M>) => {
    const align = strProp(props, "align");
    return container(
      h[tag](
        [h.Class(`saku-md-${tag}`), ...(align === "" ? [] : [h.Style({ textAlign: align })])],
        render(children, cursor),
      ),
    );
  };

/** Bare wrappers with no attributes (inline runs, table sections). */
const bare =
  (tag: "em" | "strong" | "del" | "thead" | "tbody" | "tr") =>
  <M>({ h, render, children, cursor }: RendererContext<M>) =>
    container(h[tag]([], render(children, cursor)));

const codeBlock = <M>({ h, children, cursor, props }: RendererContext<M>) => {
  const lang = strProp(props, "language");
  const filename = strProp(props, "filename");
  const code = h.code(
    [h.Class(lang === "" ? "saku-md-code-block" : `saku-md-code-block language-${lang}`)],
    [textOf(children), ...(cursor ? [cursorSpan(h)] : [])],
  );
  return container(
    h.pre(
      [h.Class("saku-md-pre")],
      [...(filename === "" ? [] : [h.div([h.Class("saku-md-pre-file")], [filename])]), code],
    ),
  );
};

const tableWrap = <M>({ h, render, children, cursor }: RendererContext<M>) =>
  container(
    h.div(
      [h.Class("saku-md-table-wrap")],
      [h.table([h.Class("saku-md-table")], render(children, cursor))],
    ),
  );

const markTag = <M>({ h, render, children, cursor }: RendererContext<M>) =>
  container(h.mark([h.Class("saku-md-mark")], render(children, cursor)));

const spanTag = <M>({ h, render, children, cursor, props }: RendererContext<M>) => {
  const cls = strProp(props, "class");
  const id = strProp(props, "id");
  return container(
    h.span(
      [...(cls === "" ? [] : [h.Class(cls)]), ...(id === "" ? [] : [h.Id(id)])],
      render(children, cursor),
    ),
  );
};

const anchor = <M>({ h, render, children, cursor, props }: RendererContext<M>) => {
  const href = strProp(props, "href");
  const title = strProp(props, "title");
  return container(
    h.a(
      [
        h.Class("saku-md-a"),
        ...(href === "" ? [] : [h.Href(href)]),
        ...(title === "" ? [] : [h.Title(title)]),
        h.Target("_blank"),
        h.Rel("noreferrer"),
      ],
      render(children, cursor),
    ),
  );
};

// Inline code and math: leaf containers with a literal text child.
const inlineCode = <M>({ h, children, cursor }: RendererContext<M>) =>
  container(
    h.code(
      [h.Class("saku-md-code-inline")],
      [textOf(children), ...(cursor ? [cursorSpan(h)] : [])],
    ),
  );

const mathTag = <M>({ h, children, cursor }: RendererContext<M>) =>
  container(
    h.code([h.Class("saku-md-math")], [textOf(children), ...(cursor ? [cursorSpan(h)] : [])]),
  );

const mathDisplay = <M>({ h, children, cursor }: RendererContext<M>) =>
  container(
    h.div(
      [h.Class("saku-md-math-display")],
      [textOf(children), ...(cursor ? [cursorSpan(h)] : [])],
    ),
  );

const wikiLink = <M>({ h, render, children, cursor, props }: RendererContext<M>) => {
  const target = strProp(props, "target");
  return container(
    h.a(
      [h.Class("saku-md-a"), ...(target === "" ? [] : [h.Href(target)])],
      render(children, cursor),
    ),
  );
};

const alertBox = <M>({ h, render, children, cursor, props }: RendererContext<M>) => {
  const type = strProp(props, "type") || "note";
  return container(
    h.div(
      [h.Class(`saku-md-alert saku-md-alert-${type}`)],
      [h.div([h.Class("saku-md-alert-label")], [type]), ...render(children, cursor)],
    ),
  );
};

const footnoteList = <M>({ h, render, children, cursor }: RendererContext<M>) =>
  container(h.div([h.Class("saku-md-footnotes")], render(children, cursor)));

const footnoteItem = <M>({ h, render, children, cursor, props }: RendererContext<M>) => {
  const label = strProp(props, "label");
  return container(
    h.div(
      [h.Class("saku-md-footnote")],
      [
        ...(label === "" ? [] : [h.span([h.Class("saku-md-footnote-label")], [`${label} `])]),
        ...render(children, cursor),
      ],
    ),
  );
};

const footnoteRef = <M>({ h, props }: RendererContext<M>): Rendered => {
  const label = strProp(props, "label");
  const id = strProp(props, "id");
  return {
    node: h.sup([h.Class("saku-md-footnote-ref")], [label === "" ? `[${id}]` : `[${label}]`]),
    placed: false,
  };
};

// Named slots: the component decides where they sit, so just render the body.
const templateSlot = <M>({ h, render, children, cursor }: RendererContext<M>) =>
  container(h.div([h.Class("saku-md-template")], render(children, cursor)));

const RENDERER_ENTRIES: readonly (readonly [string, Renderer])[] = [
  ["a", anchor],
  ["alert", alertBox],
  ["blockquote", simple("blockquote")],
  ["br", lineBreak],
  ["code", inlineCode],
  ["del", bare("del")],
  ["em", bare("em")],
  ["footnote", footnoteItem],
  ["footnote-ref", footnoteRef],
  ["footnotes", footnoteList],
  ["frontmatter", skip],
  ["h1", heading("h1")],
  ["h2", heading("h2")],
  ["h3", heading("h3")],
  ["h4", heading("h4")],
  ["h5", heading("h5")],
  ["h6", heading("h6")],
  ["hr", rule],
  ["html", rawHtml],
  ["img", image],
  ["li", listItem],
  ["mark", markTag],
  ["math", mathTag],
  ["math-display", mathDisplay],
  ["ol", orderedList],
  ["p", simple("p")],
  ["pre", codeBlock],
  ["span", spanTag],
  ["strong", bare("strong")],
  ["table", tableWrap],
  ["tbody", bare("tbody")],
  ["td", cell("td")],
  ["template", templateSlot],
  ["th", cell("th")],
  ["thead", bare("thead")],
  ["tr", bare("tr")],
  ["ul", simple("ul")],
  ["wikilink", wikiLink],
];

/** Tag → renderer. Unknown tags fall through to the default wrapper. */
const RENDERERS = new Map(RENDERER_ENTRIES);

/** One comark node → foldkit node (text runs pass through; elements
 *  dispatch to their tag's renderer). */
const convert = <M>(h: HtmlBuilder<M>, render: Render, node: ComarkNode, cursor: boolean) => {
  if (isText(node)) {
    return { node, placed: false };
  }
  const [tag, props, ...children] = node;
  // Comments (tag null) and frontmatter never render.
  const renderer = tag === null ? skip : RENDERERS.get(tag);
  if (renderer !== undefined) {
    return renderer({ children, cursor, h, props, render });
  }
  // MDC components and anything else: children in a plain wrapper,
  // block when the subtree is block content, inline otherwise.
  const kids = render(children, cursor);
  return container(
    holdsBlock(children)
      ? h.div([h.Class("saku-md-unknown")], kids)
      : h.span([h.Class("saku-md-unknown")], kids),
  );
};

/**
 * Render `children`, carrying the streaming cursor to the LAST child that
 * can host it — the cursor marks where the stream continues, which is at
 * the end of the content — and as a trailing sibling when nothing hosted
 * it (the stream ends on a text run, a comment, or a void element).
 */
const renderChildren = <M>(h: HtmlBuilder<M>, children: readonly ComarkNode[], cursor: boolean) => {
  const render: Render = (nodes, withCursor) => renderChildren(h, nodes, withCursor);
  const out: FoldkitChild[] = [];
  let remaining = cursor;
  for (const [index, child] of children.entries()) {
    const last = index === children.length - 1;
    const rendered = convert(h, render, child, cursor && last);
    if (rendered.node !== null) {
      out.push(rendered.node);
    }
    remaining &&= !rendered.placed;
  }
  if (remaining) {
    out.push(cursorSpan(h));
  }
  return out;
};

/**
 * The LLM body as foldkit nodes: the markdown parse of `text`, or the
 * plain pre-wrap fallback before md4x is ready / on parse failure. With
 * `cursor`, the streaming cursor is carried to the end of the last block.
 */
export const markdownBody = <M>(h: HtmlBuilder<M>, text: string, cursor = false): Html => {
  if (text === "") {
    return null;
  }
  if (!ready) {
    return plainBody(h, text);
  }
  const tree = parseTree(text);
  if (tree === null) {
    return plainBody(h, text);
  }
  return h.div([h.Class("saku-md")], renderChildren(h, tree.nodes, cursor));
};
