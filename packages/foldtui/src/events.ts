/**
 * Wires foldkit vnode event handlers (`data.on`) onto OpenTUI renderables.
 *
 * OpenTUI has no DOM-style "click" event, so `click` is synthesized from a
 * `mousedown` followed by a `mouseup` on the same renderable within one
 * cell of each other.
 */

import type { MouseEvent, Renderable } from "@opentui/core";

export type Handler = (...args: unknown[]) => void;

const downPositions = new WeakMap<Renderable, { x: number; y: number }>();

const clearMouseHandlers = (renderable: Renderable): void => {
  renderable.onMouse = undefined;
  renderable.onMouseDown = undefined;
  renderable.onMouseUp = undefined;
  renderable.onMouseMove = undefined;
  renderable.onMouseDrag = undefined;
  renderable.onMouseDragEnd = undefined;
  renderable.onMouseDrop = undefined;
  renderable.onMouseOver = undefined;
  renderable.onMouseOut = undefined;
};

const installClick = (renderable: Renderable, handler: Handler): void => {
  renderable.onMouseDown = (event: MouseEvent) => {
    downPositions.set(renderable, { x: event.x, y: event.y });
  };
  renderable.onMouseUp = (event: MouseEvent) => {
    const down = downPositions.get(renderable);
    downPositions.delete(renderable);
    if (down !== undefined && Math.abs(down.x - event.x) <= 1 && Math.abs(down.y - event.y) <= 1) {
      handler({
        type: "click",
        x: event.x,
        y: event.y,
        button: event.button,
        modifiers: event.modifiers,
      });
    }
  };
};

/** Rewires a renderable's mouse handlers from a fresh vnode's `data.on`. */
export const wireEvents = (
  renderable: Renderable,
  on: Record<string, unknown> | undefined,
): void => {
  clearMouseHandlers(renderable);
  if (on === undefined) return;

  for (const [eventName, handler] of Object.entries(on)) {
    if (typeof handler !== "function") continue;
    const call = handler as Handler;
    switch (eventName) {
      case "click":
        installClick(renderable, call);
        break;
      case "mousedown":
        renderable.onMouseDown = (event) => call(event);
        break;
      case "mouseup":
        renderable.onMouseUp = (event) => call(event);
        break;
      case "mousemove":
        renderable.onMouseMove = (event) => call(event);
        break;
      case "mouseover":
        renderable.onMouseOver = (event) => call(event);
        break;
      case "mouseout":
        renderable.onMouseOut = (event) => call(event);
        break;
      default:
        console.warn(`[foldtui] event "${eventName}" is not wired in the terminal renderer (MVP)`);
    }
  }
};
