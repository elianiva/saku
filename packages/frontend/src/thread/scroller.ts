/**
 * The trail's chat scroller (thread/scroller.ts): the shadcn message-scroller
 * pattern (ui.shadcn.com/docs/components/base/message-scroller) as a foldkit
 * mount. One mount owns the trail's scroll behavior for as long as the trail
 * element lives — the listener streams and observers attach on insert and
 * release on unmount, so every thread open or trail reload restarts it
 * fresh.
 *
 * The follow machine mirrors shadcn's: the viewport follows the live end —
 * any content growth scrolls to the bottom — until the reader scrolls away.
 * A wheel/touch gesture or a scroll-top decrease releases the follow
 * (shadcn's userScrollIntent); returning to the bottom re-arms it within the
 * edge threshold. A new user turn while reading history is anchored to the
 * reading line instead of the bottom (shadcn's scroll-anchor: the previous
 * turn peeks above it, the reply streams below). The jump-to-latest button
 * mirrors MessageScrollerButton — visible whenever content sits below the
 * viewport, one click returns to the live end.
 */

import { Effect, Option, Stream } from "effect";
import { Subscription } from "foldkit";
import type { MountAction } from "foldkit/mount";

import type { ThreadMessage } from "./message.ts";

/** shadcn's DEFAULT_SCROLL_EDGE_THRESHOLD: distance from the end that still
 *  counts as "at the bottom". */
const EDGE_THRESHOLD = 8;
/** shadcn's SCROLL_POSITION_EPSILON: absorbs rounding drift when comparing
 *  scroll positions. */
const POSITION_EPSILON = 0.5;
/** shadcn's DEFAULT_SCROLL_PREVIOUS_ITEM_PEEK: the previous turn's tail kept
 *  visible above a freshly anchored user turn. */
const ANCHOR_PEEK = 64;
/** shadcn's AUTOSCROLLING_CLEAR_DELAY: the window during which scroll events
 *  from a programmatic scroll cannot release the follow. */
const PROGRAMMATIC_SUPPRESS_MS = 180;

const atEnd = (trail: HTMLElement) =>
  trail.scrollHeight - trail.scrollTop - trail.clientHeight <= EDGE_THRESHOLD;

/** The trail's one scroller (view.ts attaches it to the trail viewport).
 *  Emits no messages — it is the pane's imperative shell, mirroring the
 *  composer's focus mount. */
export const ChatScroller: MountAction<ThreadMessage> = {
  name: "ChatScroller",
  f: (element) =>
    Stream.callback<ThreadMessage>(() =>
      Effect.gen(function* () {
        const trail = element as HTMLElement;
        const content =
          trail.firstElementChild instanceof HTMLElement ? trail.firstElementChild : null;
        const button =
          trail.parentElement?.querySelector<HTMLButtonElement>("[data-scroll-to-end]") ?? null;

        // The follow machine (shadcn's mode): following pins to the live end;
        // any scroll-away gesture releases it, returning to the bottom
        // re-arms it. Starts following — a loaded thread opens at the latest
        // message, never at the top of its history.
        let following = true;
        // The scrollTop of the previous scroll event, so a release can tell a
        // reader scrolling up from content growing past the live edge.
        let lastScrollTop = trail.scrollTop;
        // The pending content-change frame (0 = none), coalescing the bursty
        // stream of resize notifications into one scroll per frame.
        let frame = 0;
        // Programmatic scrolls cannot release the follow — the window during
        // which scroll events stay suppressed (shadcn's autoscrolling flag).
        let suppressUntil = 0;

        const syncButton = () => {
          button?.setAttribute("data-active", atEnd(trail) ? "false" : "true");
        };

        const scrollToEnd = (behavior: ScrollBehavior = "auto") => {
          following = true;
          suppressUntil = performance.now() + PROGRAMMATIC_SUPPRESS_MS;
          trail.scrollTo({ top: trail.scrollHeight, behavior });
          syncButton();
        };

        const onScroll = () => {
          const scrollTop = trail.scrollTop;
          const scrolledUp = scrollTop < lastScrollTop - POSITION_EPSILON;
          lastScrollTop = scrollTop;
          if (atEnd(trail)) {
            following = true;
          } else if (scrolledUp && performance.now() >= suppressUntil) {
            following = false;
          }
          syncButton();
        };

        // A wheel or touch gesture is the reader's intent to leave the live
        // end (shadcn's userScrollIntent) — released even when the gesture
        // cannot move the viewport yet; any scroll event re-arms at the end.
        const onWheel = () => {
          following = false;
        };
        const onTouchMove = () => {
          following = false;
        };

        const onContentChange = () => {
          if (following) scrollToEnd();
          else syncButton();
        };

        const scheduleContentChange = () => {
          if (frame !== 0) return;
          frame = requestAnimationFrame(() => {
            frame = 0;
            onContentChange();
          });
        };

        // A new user turn while the reader is away from the live end joins at
        // the reading line — the previous turn peeking above it — instead of
        // being swallowed at the bottom (shadcn's scroll-anchor).
        const anchorRow = (row: HTMLElement) => {
          const trailRect = trail.getBoundingClientRect();
          const top =
            row.getBoundingClientRect().top - trailRect.top + trail.scrollTop - ANCHOR_PEEK;
          suppressUntil = performance.now() + PROGRAMMATIC_SUPPRESS_MS;
          trail.scrollTo({ top: Math.max(0, top), behavior: "auto" });
          syncButton();
        };

        const onMutations = (records: MutationRecord[]) => {
          for (const record of records) {
            for (const node of record.addedNodes) {
              if (node instanceof HTMLElement && node.dataset.role === "user") {
                if (following) scrollToEnd();
                else anchorRow(node);
                return;
              }
            }
          }
          onContentChange();
        };

        // The listeners, foldkit-managed (Subscription.fromEventFilterMap):
        // each stream registers its listener when the trail mount's scope
        // opens and removes it when the mount unmounts — the acquireRelease
        // lifecycle foldkit's fromEvent helpers own, replacing the manual
        // add/remove pairing. The mappers run synchronously inside the
        // browser's event dispatch (the same call stack as the native
        // handlers they replace) and filter every event out (Option.none):
        // the scroller stays an imperative shell that emits no messages.
        const listeners = Stream.mergeAll(
          [
            button === null
              ? Stream.empty
              : Subscription.fromEventFilterMap<MouseEvent, ThreadMessage>({
                  target: button,
                  type: "click",
                  toMessage: () => {
                    button.blur();
                    scrollToEnd("smooth");
                    return Option.none();
                  },
                }),
            Subscription.fromEventFilterMap<Event, ThreadMessage>({
              target: trail,
              type: "scroll",
              toMessage: () => {
                onScroll();
                return Option.none();
              },
            }),
            Subscription.fromEventFilterMap<WheelEvent, ThreadMessage>({
              target: trail,
              type: "wheel",
              options: { passive: true },
              toMessage: () => {
                onWheel();
                return Option.none();
              },
            }),
            Subscription.fromEventFilterMap<TouchEvent, ThreadMessage>({
              target: trail,
              type: "touchmove",
              options: { passive: true },
              toMessage: () => {
                onTouchMove();
                return Option.none();
              },
            }),
          ],
          { concurrency: "unbounded" },
        );

        // The observers and the opening position (shadcn's
        // defaultScrollPosition "end") — the pane's imperative scope,
        // released on unmount. The insert hook runs after the patch, so the
        // trail already measures the loaded entries; the resources are
        // constructed inside the acquire body (foldkit's discipline) so the
        // release can only run with the handles it was registered for.
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            scrollToEnd();
            let resize: ResizeObserver | null = null;
            if (typeof ResizeObserver !== "undefined") {
              resize = new ResizeObserver(scheduleContentChange);
              // The content box grows with entries and the streaming live
              // region; the trail box only changes when the pane itself
              // resizes.
              if (content !== null) resize.observe(content);
              resize.observe(trail);
            }
            let mutation: MutationObserver | null = null;
            if (typeof MutationObserver !== "undefined") {
              mutation = new MutationObserver(onMutations);
              mutation.observe(content ?? trail, { childList: true });
            }
            return {
              resize,
              mutation,
              cancelFrame: () => {
                if (frame !== 0) {
                  cancelAnimationFrame(frame);
                  frame = 0;
                }
              },
            };
          }),
          ({ resize, mutation, cancelFrame }) =>
            Effect.sync(() => {
              resize?.disconnect();
              mutation?.disconnect();
              cancelFrame();
            }),
        );

        // The mount outlives the acquire — draining the merged listener
        // streams holds the scroller open until the trail unmounts, then the
        // interrupt closes their scopes (removing every listener) and runs
        // the release above.
        return yield* Stream.runDrain(listeners);
      }),
    ),
};
