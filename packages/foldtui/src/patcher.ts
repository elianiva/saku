/**
 * The terminal patcher: diffs foldkit vnode trees against the previous
 * render and maintains a parallel OpenTUI renderable tree.
 *
 * MVP semantics:
 * - Children are matched positionally (snabbdom semantics when no keys are
 *   present); keyed children fall back to positional matching with a
 *   replace when keys differ.
 * - A vnode whose tag/class/keys differ from its predecessor is replaced.
 * - Same-reference vnodes (foldkit `createLazy` cache hits) are skipped.
 */

import { BoxRenderable, TextRenderable, type CliRenderer, type Renderable } from "@opentui/core";

import { applyStyle } from "./styles.ts";
import { clearKeyboard, wireEvents } from "./events.ts";
import { allTextChildren, childList, textContent, type Child, type TuiVNode } from "./vnode.ts";

/** Tags that render as text when their children are all text. */
const TEXT_TAGS = new Set([
  "p",
  "span",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "strong",
  "em",
  "b",
  "i",
  "small",
  "label",
  "code",
  "pre",
  "blockquote",
]);

/** Tags known to have no terminal meaning; rendered as boxes with a warning. */
const UNSUPPORTED_TAGS = new Set([
  "input",
  "textarea",
  "select",
  "option",
  "img",
  "picture",
  "video",
  "audio",
  "canvas",
  "svg",
  "iframe",
  "table",
  "thead",
  "tbody",
  "tr",
  "td",
  "th",
  "head",
  "html",
  "meta",
  "link",
  "script",
  "style",
]);

type RenderableClass = "text" | "text-element" | "box";

const classOf = (v: TuiVNode): RenderableClass => {
  if (v.sel === undefined) return "text";
  if (TEXT_TAGS.has(v.sel) && allTextChildren(v)) return "text-element";
  return "box";
};

const vnodeOf = (child: Child): TuiVNode => (typeof child === "string" ? { text: child } : child);

export class TuiPatcher {
  private readonly ctx: CliRenderer;
  private readonly root: Renderable;
  private oldRoot: TuiVNode | null = null;

  constructor(renderer: CliRenderer) {
    this.ctx = renderer;
    this.root = renderer.root;
  }

  /** Diffs `next` against the previous render and updates the tree. */
  patch(next: TuiVNode): void {
    if (this.oldRoot === null) {
      this.root.add(this.create(next));
    } else if (this.oldRoot !== next) {
      this.reconcile(this.root, 0, this.oldRoot, next);
    }
    this.oldRoot = next;
  }

  // -- construction ---------------------------------------------------------

  private create(v: TuiVNode): Renderable {
    if (v.sel === undefined) {
      return this.applyVNode(undefined, v, new TextRenderable(this.ctx, { content: v.text ?? "" }));
    }

    if (UNSUPPORTED_TAGS.has(v.sel)) {
      console.warn(`[foldtui] <${v.sel}> has no terminal rendering; using a box`);
    }

    const klass = classOf(v);
    if (klass === "text-element") {
      return this.applyVNode(
        undefined,
        v,
        new TextRenderable(this.ctx, { content: textContent(v) }),
      );
    }

    const box = new BoxRenderable(this.ctx, {});
    for (const child of childList(v)) {
      box.add(this.create(vnodeOf(child)));
    }
    return this.applyVNode(undefined, v, box);
  }

  // -- reconciliation -------------------------------------------------------

  private reconcile(container: Renderable, index: number, oldV: TuiVNode, newV: TuiVNode): void {
    if (oldV === newV) return;

    const oldRenderable = this.renderableAt(container, index);
    if (oldRenderable === undefined) {
      // Lost track (e.g. a shared vnode object); rebuild in place.
      container.add(this.create(newV), index);
      return;
    }

    const sameKey = oldV.key === newV.key || (oldV.key === undefined && newV.key === undefined);

    if (oldV.sel !== newV.sel || !sameKey || classOf(oldV) !== classOf(newV)) {
      this.replace(container, index, oldRenderable, newV);
      return;
    }

    // Same element kind: update in place.
    this.applyVNode(oldV, newV, oldRenderable);

    if (classOf(newV) === "box") {
      this.reconcileChildren(oldRenderable, childList(oldV), childList(newV));
    }
  }

  private replace(
    container: Renderable,
    index: number,
    oldRenderable: Renderable,
    newV: TuiVNode,
  ): void {
    const newRenderable = this.create(newV);
    container.insertBefore(newRenderable, oldRenderable);
    this.destroyRenderable(oldRenderable);
  }

  private reconcileChildren(
    parent: Renderable,
    oldChildren: Array<Child>,
    newChildren: Array<Child>,
  ): void {
    const count = Math.max(oldChildren.length, newChildren.length);
    for (let index = 0; index < count; index++) {
      const oldChild = oldChildren[index];
      const newChild = newChildren[index];

      if (oldChild === undefined) {
        parent.add(this.create(vnodeOf(newChild!)), index);
        continue;
      }
      if (newChild === undefined) {
        this.destroyRenderable(this.renderableAt(parent, index));
        continue;
      }
      this.reconcile(parent, index, vnodeOf(oldChild), vnodeOf(newChild));
    }
  }

  private destroyRenderable(renderable: Renderable | undefined): void {
    if (renderable === undefined) return;
    if (renderable.parent !== null) renderable.parent.remove(renderable);
    clearKeyboard(renderable);
    renderable.destroy();
  }

  /** Renderable at a child position, resolved positionally. */
  private renderableAt(parent: Renderable, index: number): Renderable | undefined {
    return parent.getChildren()[index] as Renderable | undefined;
  }

  // -- per-vnode updates ----------------------------------------------------

  private applyVNode(
    oldV: TuiVNode | undefined,
    newV: TuiVNode,
    renderable: Renderable,
  ): Renderable {
    if (renderable instanceof TextRenderable) {
      const nextText = newV.sel === undefined ? (newV.text ?? "") : textContent(newV);
      const previousText =
        oldV === undefined
          ? undefined
          : oldV.sel === undefined
            ? (oldV.text ?? "")
            : textContent(oldV);
      if (previousText !== nextText) {
        renderable.content = nextText;
      }
    }

    if (newV.data?.props?.hidden === true) {
      renderable.visible = false;
    } else if (newV.data?.props?.hidden === undefined || newV.data?.props?.hidden === false) {
      renderable.visible = true;
    }

    applyStyle(renderable, oldV?.data?.style, newV.data?.style);
    wireEvents(renderable, newV.data?.on);
    return renderable;
  }
}
