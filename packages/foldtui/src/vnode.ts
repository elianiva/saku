/**
 * Structural view of foldkit's VNode.
 *
 * foldkit's `Html.Document.body` is a snabbdom-style VNode, but the `VNode`
 * type itself is not part of foldkit's public API. This module defines the
 * minimal structural shape the terminal patcher relies on; the real VNode is
 * structurally compatible with it.
 */

export interface TuiVNode {
  /** CSS-ish selector, e.g. `div`, `button`. `undefined` for text vnodes. */
  sel?: string;
  data?: {
    /** Inline styles, e.g. `{ flexGrow: '1', color: '#7aa2f7' }`. */
    style?: Record<string, string>;
    /** Event handlers, e.g. `{ click: () => dispatch(Clicked()) }`. */
    on?: Record<string, unknown>;
    /** DOM properties (foldkit sets `hidden` here). */
    props?: Record<string, unknown>;
    /** Raw attributes (ignored by the terminal renderer). */
    attrs?: Record<string, unknown>;
    key?: unknown;
  };
  children?: Array<TuiVNode | string>;
  /** Text content for element vnodes with a single string child. */
  text?: string;
  /** Diffing key. */
  key?: unknown;
}

export type Child = TuiVNode | string;

export const isVNode = (child: Child): child is TuiVNode =>
  typeof child === "object" && child !== null;

export const childList = (v: TuiVNode): Array<Child> => v.children ?? [];

export const textOf = (child: Child): string =>
  typeof child === "string" ? child : (child.text ?? "");

/** Concatenated text content of a vnode (its own `text` or its children). */
export const textContent = (v: TuiVNode): string => {
  if (v.text !== undefined) return v.text;
  return childList(v).map(textOf).join("");
};

/** True when every child is a string or a bare text vnode. */
export const allTextChildren = (v: TuiVNode): boolean =>
  childList(v).every(
    (child) => typeof child === "string" || (isVNode(child) && child.sel === undefined),
  );
