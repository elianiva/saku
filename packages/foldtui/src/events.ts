/**
 * Wires foldkit vnode event handlers (`data.on`) onto OpenTUI renderables.
 *
 * OpenTUI has no DOM-style "click" event, so `click` is synthesized from a
 * `mousedown` followed by a `mouseup` on the same renderable within one
 * cell of each other.
 *
 * Keyboard events are global in OpenTUI (there is no per-renderable focus).
 * The foldkit contract — `data.on.keydown(key, modifiers)` — is honored by
 * routing every keypress to the renderable that most recently wired a
 * `keydown` handler: the app's root element owns the single handler, which
 * matches the v1 plan ("root vnode data.on.keydown via Dispatch").
 * `paste` follows the same slot: `data.on.paste(text)`.
 */

import type { CliRenderer, KeyEvent, MouseEvent, PasteEvent, Renderable } from "@opentui/core";

export type Handler = (...args: unknown[]) => void;

export interface KeyboardModifiers {
  readonly shiftKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
}

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

// -- keyboard -----------------------------------------------------------------
//
// One active slot per event kind; the most recent vnode wiring wins. A
// renderable whose handlers are rewired (or destroyed) releases its slots.

interface KeySlot {
  readonly renderable: Renderable;
  readonly handler: Handler;
}

const keydownSlot: { current: KeySlot | undefined } = { current: undefined };
const keyupSlot: { current: KeySlot | undefined } = { current: undefined };
const pasteSlot: { current: KeySlot | undefined } = { current: undefined };

const keyHandlers = new WeakMap<Renderable, { keydown?: Handler; keyup?: Handler; paste?: Handler }>();

/** Releases a renderable's keyboard slots (call on destroy / rewire). */
export const clearKeyboard = (renderable: Renderable): void => {
  const record = keyHandlers.get(renderable);
  if (record === undefined) return;
  if (keydownSlot.current?.renderable === renderable) keydownSlot.current = undefined;
  if (keyupSlot.current?.renderable === renderable) keyupSlot.current = undefined;
  if (pasteSlot.current?.renderable === renderable) pasteSlot.current = undefined;
  keyHandlers.delete(renderable);
};

/** The shape foldkit's `data.on.keydown` handlers receive (a DOM KeyboardEvent). */
const keyboardEventOf = (event: KeyEvent): KeyboardEvent =>
  Object.assign(new Event("keydown"), {
    key: event.name,
    shiftKey: event.shift,
    ctrlKey: event.ctrl,
    altKey: event.option,
    metaKey: event.meta,
  }) as KeyboardEvent;

/**
 * Subscribes the renderer's global key input and translates OpenTUI key
 * events into foldkit `data.on.keydown/keyup` handler calls. Returns a
 * function that removes the listeners.
 */
export const wireKeyboard = (renderer: CliRenderer): (() => void) => {
  const onKeypress = (event: KeyEvent): void => {
    if (event.eventType === "release") return;
    if (keydownSlot.current === undefined) return;
    keydownSlot.current.handler(keyboardEventOf(event));
  };
  const onKeyrelease = (event: KeyEvent): void => {
    if (event.eventType !== "release") return;
    if (keyupSlot.current === undefined) return;
    keyupSlot.current.handler(keyboardEventOf(event));
  };
  const onPaste = (event: PasteEvent): void => {
    if (pasteSlot.current === undefined) return;
    const text = new TextDecoder().decode(event.bytes);
    pasteSlot.current.handler(new CustomEvent("paste", { detail: text }));
  };
  const keyInput = renderer.keyInput;
  keyInput.on("keypress", onKeypress);
  keyInput.on("keyrelease", onKeyrelease);
  keyInput.on("paste", onPaste);
  return () => {
    keyInput.off("keypress", onKeypress);
    keyInput.off("keyrelease", onKeyrelease);
    keyInput.off("paste", onPaste);
  };
};

/** Rewires a renderable's mouse and keyboard handlers from a fresh vnode's `data.on`. */
export const wireEvents = (
  renderable: Renderable,
  on: Record<string, unknown> | undefined,
): void => {
  clearMouseHandlers(renderable);
  clearKeyboard(renderable);
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
      case "keydown": {
        const record = keyHandlers.get(renderable) ?? {};
        record.keydown = call;
        keyHandlers.set(renderable, record);
        keydownSlot.current = { renderable, handler: call };
        break;
      }
      case "keyup": {
        const record = keyHandlers.get(renderable) ?? {};
        record.keyup = call;
        keyHandlers.set(renderable, record);
        keyupSlot.current = { renderable, handler: call };
        break;
      }
      case "paste": {
        const record = keyHandlers.get(renderable) ?? {};
        record.paste = call;
        keyHandlers.set(renderable, record);
        pasteSlot.current = { renderable, handler: call };
        break;
      }
      default:
        console.warn(`[foldtui] event "${eventName}" is not wired in the terminal renderer (MVP)`);
    }
  }
};
