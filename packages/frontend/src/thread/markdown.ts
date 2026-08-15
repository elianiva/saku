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

import { Result } from "effect";
import { init as md4xInit, parseAST } from "md4x/standalone";
import type { ComarkElement, ComarkElementAttributes, ComarkNode } from "md4x";
import type { Html, HtmlBuilder } from "foldkit/html";

/** A foldkit child: a built node or a text run. */
type FoldkitChild = Html | string;

let ready = false;

/** Resolves once md4x is ready to parse (browser: WASM instantiated). */
export const markdownReady = md4xInit()
  .then(() => {
    ready = true;
  })
  .catch(() => {});

const parseTree = (text: string) => {
  const raw = Result.try(() => parseAST(text));
  return Result.isSuccess(raw) ? raw.success : null;
};

/** The literal text of a node subtree (code, math, raw html bodies). */
const textOf = (nodes: readonly ComarkNode[]): string =>
  nodes.map((node) => (typeof node === "string" ? node : textOf(tail(node)))).join("");

/** An element's children (everything past the tag/props tuple head). */
const tail = (node: ComarkElement) => {
  const [, , ...children] = node;
  return children;
};

/** The string value of a prop, absent when it is missing or not a string. */
const strProp = (props: ComarkElementAttributes, key: string) =>
  typeof props[key] === "string" ? props[key] : "";

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
  nodes.some((node) => typeof node !== "string" && (isBlockTag(node[0]) || holdsBlock(tail(node))));

/** The streaming cursor (live region): a blinking block appended in-line. */
const cursorSpan = <M>(h: HtmlBuilder<M>) => h.span([h.Class("saku-cursor")], ["▊"]);

/** The pre-markdown fallback: the old plain pre-wrap body. */
const plainBody = <M>(h: HtmlBuilder<M>, text: string) =>
  h.div([h.Class("whitespace-pre-wrap text-[13px] leading-relaxed")], [text]);

/**
 * Render `children`, carrying the streaming cursor to the LAST child that
 * can host it — the cursor marks where the stream continues, which is at
 * the end of the content — and as a trailing sibling when nothing hosted
 * it (the stream ends on a text run, a comment, or a void element).
 */
const renderChildren = <M>(h: HtmlBuilder<M>, children: readonly ComarkNode[], cursor: boolean) => {
  const out: FoldkitChild[] = [];
  let remaining = cursor;
  for (let i = 0; i < children.length; i++) {
    const last = i === children.length - 1;
    const rendered = convert(h, children[i]!, cursor && last);
    if (rendered.node !== null) out.push(rendered.node);
    remaining = remaining && !rendered.placed;
  }
  if (remaining) out.push(cursorSpan(h));
  return out;
};

/** One comark element → foldkit node. */
const convert = <M>(h: HtmlBuilder<M>, node: ComarkNode, cursor: boolean): Rendered => {
  if (typeof node === "string") return { node, placed: false };
  const [tag, props, ...children] = node;
  const kids = () => renderChildren(h, children, cursor);
  const container = (element: Html): Rendered => ({ node: element, placed: true });

  switch (tag) {
    // Comments and frontmatter never render.
    case null:
    case "frontmatter":
      return { node: null, placed: false };
    // Raw HTML (either spelling) is a text node: escaped by the builder,
    // never injected.
    case "html":
      return { node: textOf(children), placed: false };
    case "br":
      return { node: h.br([h.Class("saku-md-br")]), placed: false };
    case "hr":
      return { node: h.hr([h.Class("saku-md-hr")]), placed: false };
    case "img": {
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
    }
    case "p":
      return container(h.p([h.Class("saku-md-p")], kids()));
    case "blockquote":
      return container(h.blockquote([h.Class("saku-md-blockquote")], kids()));
    case "ul":
      return container(h.ul([h.Class("saku-md-ul")], kids()));
    case "ol": {
      const start = Number(strProp(props, "start"));
      return container(
        h.ol(
          [
            h.Class("saku-md-ol"),
            ...(Number.isInteger(start) && start > 1 ? [h.Start(start)] : []),
          ],
          kids(),
        ),
      );
    }
    case "li":
      return container(
        h.li(
          [h.Class("saku-md-li")],
          [
            ...(props.task === true
              ? [h.span([h.Class("saku-md-task")], [props.checked === true ? "[✓]" : "[ ]"])]
              : []),
            ...kids(),
          ],
        ),
      );
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6": {
      const id = strProp(props, "id");
      return container(
        h[tag]([h.Class(`saku-md-h saku-md-${tag}`), ...(id === "" ? [] : [h.Id(id)])], kids()),
      );
    }
    case "pre": {
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
    }
    case "table":
      return container(
        h.div([h.Class("saku-md-table-wrap")], [h.table([h.Class("saku-md-table")], kids())]),
      );
    case "thead":
      return container(h.thead([], kids()));
    case "tbody":
      return container(h.tbody([], kids()));
    case "tr":
      return container(h.tr([], kids()));
    case "th":
    case "td": {
      const align = strProp(props, "align");
      return container(
        h[tag](
          [h.Class(`saku-md-${tag}`), ...(align === "" ? [] : [h.Style({ textAlign: align })])],
          kids(),
        ),
      );
    }
    case "em":
      return container(h.em([], kids()));
    case "strong":
      return container(h.strong([], kids()));
    case "del":
      return container(h.del([], kids()));
    case "mark":
      return container(h.mark([h.Class("saku-md-mark")], kids()));
    case "span": {
      const cls = strProp(props, "class");
      const id = strProp(props, "id");
      return container(
        h.span([...(cls === "" ? [] : [h.Class(cls)]), ...(id === "" ? [] : [h.Id(id)])], kids()),
      );
    }
    case "a": {
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
          kids(),
        ),
      );
    }
    // Inline code and math: leaf containers with a literal text child.
    case "code":
      return container(
        h.code(
          [h.Class("saku-md-code-inline")],
          [textOf(children), ...(cursor ? [cursorSpan(h)] : [])],
        ),
      );
    case "math":
      return container(
        h.code([h.Class("saku-md-math")], [textOf(children), ...(cursor ? [cursorSpan(h)] : [])]),
      );
    case "math-display":
      return container(
        h.div(
          [h.Class("saku-md-math-display")],
          [textOf(children), ...(cursor ? [cursorSpan(h)] : [])],
        ),
      );
    case "wikilink": {
      const target = strProp(props, "target");
      return container(
        h.a([h.Class("saku-md-a"), ...(target === "" ? [] : [h.Href(target)])], kids()),
      );
    }
    case "alert": {
      const type = strProp(props, "type") || "note";
      return container(
        h.div(
          [h.Class(`saku-md-alert saku-md-alert-${type}`)],
          [h.div([h.Class("saku-md-alert-label")], [type]), ...kids()],
        ),
      );
    }
    case "footnotes":
      return container(h.div([h.Class("saku-md-footnotes")], kids()));
    case "footnote": {
      const label = strProp(props, "label");
      return container(
        h.div(
          [h.Class("saku-md-footnote")],
          [
            ...(label === "" ? [] : [h.span([h.Class("saku-md-footnote-label")], [`${label} `])]),
            ...kids(),
          ],
        ),
      );
    }
    case "footnote-ref": {
      const label = strProp(props, "label");
      const id = strProp(props, "id");
      return {
        node: h.sup([h.Class("saku-md-footnote-ref")], [label === "" ? `[${id}]` : `[${label}]`]),
        placed: false,
      };
    }
    // Named slots: the component decides where they sit, so just render the body.
    case "template":
      return container(h.div([h.Class("saku-md-template")], kids()));
    // MDC components and anything else: children in a plain wrapper,
    // block when the subtree is block content, inline otherwise.
    default:
      return container(
        holdsBlock(children)
          ? h.div([h.Class("saku-md-unknown")], kids())
          : h.span([h.Class("saku-md-unknown")], kids()),
      );
  }
};

/**
 * The LLM body as foldkit nodes: the markdown parse of `text`, or the
 * plain pre-wrap fallback before md4x is ready / on parse failure. With
 * `cursor`, the streaming cursor is carried to the end of the last block.
 */
export const markdownBody = <M>(h: HtmlBuilder<M>, text: string, cursor = false): Html => {
  if (text === "") return null;
  if (!ready) return plainBody(h, text);
  const tree = parseTree(text);
  if (tree === null) return plainBody(h, text);
  return h.div([h.Class("saku-md")], renderChildren(h, tree.nodes, cursor));
};
