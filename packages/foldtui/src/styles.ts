/**
 * Maps foldkit inline styles (string-typed, CSS-ish) onto OpenTUI
 * renderable setters. Only the subset that has a terminal meaning is
 * translated; everything else is ignored.
 */

import { BoxRenderable, TextRenderable, type Renderable } from "@opentui/core";

/** Layout properties with verified setters on Renderable. */
const LAYOUT_PROPS: readonly string[] = [
  "flexGrow",
  "flexShrink",
  "flexBasis",
  "flexDirection",
  "flexWrap",
  "alignItems",
  "alignSelf",
  "justifyContent",
  "position",
  "overflow",
  "width",
  "height",
  "minWidth",
  "minHeight",
  "maxWidth",
  "maxHeight",
  "margin",
  "marginTop",
  "marginRight",
  "marginBottom",
  "marginLeft",
  "padding",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "top",
  "right",
  "bottom",
  "left",
];

/** Box-only properties (gap, colors) with verified setters on BoxRenderable. */
const BOX_ONLY_PROPS: readonly string[] = [
  "gap",
  "rowGap",
  "columnGap",
  "backgroundColor",
  "borderColor",
];

/** Layout properties that take enum strings (not sizes). */
const LAYOUT_ENUM_PROPS: readonly string[] = [
  "flexDirection",
  "flexWrap",
  "alignItems",
  "alignSelf",
  "justifyContent",
  "position",
  "overflow",
];

const toLayoutValue = (value: string): number | "auto" | `${number}%` | null => {
  if (value === "auto") return "auto";
  if (value.endsWith("%")) return value as `${number}%`;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

const set = (target: unknown, key: string, value: unknown): void => {
  (target as Record<string, unknown>)[key] = value;
};

export const applyStyle = (
  renderable: Renderable,
  oldStyle: Record<string, string> | undefined,
  newStyle: Record<string, string> | undefined,
): void => {
  const textLike = renderable instanceof TextRenderable;

  // Clear properties that disappeared between renders.
  if (oldStyle !== undefined) {
    for (const key of Object.keys(oldStyle)) {
      if (newStyle !== undefined && key in newStyle) continue;
      try {
        if (key === "color") {
          set(renderable, "fg", undefined);
        } else if (key === "backgroundColor") {
          set(renderable, textLike ? "bg" : "backgroundColor", undefined);
        } else if (LAYOUT_PROPS.includes(key) || LAYOUT_ENUM_PROPS.includes(key)) {
          set(renderable, key, null);
        } else if (BOX_ONLY_PROPS.includes(key) && renderable instanceof BoxRenderable) {
          set(renderable, key, undefined);
        }
      } catch (error) {
        console.warn(`[foldtui] failed to clear style "${key}":`, error);
      }
    }
  }

  if (newStyle === undefined) return;

  for (const [key, value] of Object.entries(newStyle)) {
    try {
      if (LAYOUT_ENUM_PROPS.includes(key)) {
        set(renderable, key, value);
        continue;
      }
      if (LAYOUT_PROPS.includes(key)) {
        const normalized = toLayoutValue(value);
        if (normalized !== null) set(renderable, key, normalized);
        continue;
      }
      if (key === "color") {
        if (textLike) set(renderable, "fg", value);
        continue;
      }
      if (key === "backgroundColor") {
        if (textLike) set(renderable, "bg", value);
        else set(renderable, "backgroundColor", value);
        continue;
      }
      if (BOX_ONLY_PROPS.includes(key)) {
        if (renderable instanceof BoxRenderable) {
          set(renderable, key, key.endsWith("Color") ? value : (toLayoutValue(value) ?? 0));
        }
        continue;
      }
      // Unknown style keys (CSS-only concerns like font-size, display,
      // cursor, ...) are intentionally ignored.
    } catch (error) {
      console.warn(
        `[foldtui] failed to apply style "${key}" to ${renderable.constructor.name}:`,
        error,
      );
    }
  }
};
