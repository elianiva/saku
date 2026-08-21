/**
 * The thread update's property tests (update.test.ts): the session-event
 * fold wiring, the trail landing, the composer's gating, the welcome's
 * quick-start flow, and the route-derived `informRouteChanged`. Exercised as
 * pure updates; the commands are asserted, never executed.
 *
 * The gating contracts are properties over arbitrary models: send prompts
 * or quick-starts exactly when the draft is non-blank (trimmed), the
 * starting guard absorbs Enter while a create is in flight, and the
 * registry broadcast updates the header only for the pinned thread.
 * `informRouteChanged` is specified field-by-field: pin/unpin, view reset,
 * composer preserved, and the load-trail command riding along exactly on a
 * Thread route.
 *
 * (The pi-session flow moved to the rail with the section —
 * rail/update.test.ts covers it.)
 */

import { describe, expect, it } from "vitest";
import { Option } from "effect";
import { WireError } from "@saku/wire";
import type { ThreadInfo, WireModelInfo } from "@saku/wire";
import type { Arbitrary } from "fast-check";
import {
  array,
  assert,
  boolean,
  constant,
  constantFrom,
  integer,
  oneof,
  option,
  property,
  record,
  string,
} from "fast-check";
import { ThreadsRoute, ThreadRoute } from "../route.ts";
import { filterModels } from "../presentation.ts";
import { informRouteChanged, update } from "./update.ts";
import { ModelPicker } from "./model.ts";
import type { Model } from "./model.ts";
import type { EntryProjection } from "./projection.ts";
import { Trail } from "./live.ts";
import type { Live } from "./live.ts";
import {
  AbortDone,
  AbortFailed,
  AbortRequested,
  ComposerBlurred,
  ComposerFocused,
  CreateFailed,
  ModelPicked,
  ModelPickerClosed,
  ModelPickerRequested,
  ModelSet,
  ModelSetFailed,
  ModelsListed,
  ModelsListFailed,
  NewThreadRequested,
  NoticeDismissed,
  PickerMove,
  PickerQueryChanged,
  PromptAcked,
  SendFailed,
  SendRequested,
  StateFailed,
  StateLoaded,
  ThinkingToggled,
  ToolToggled,
  ThreadChanged,
  ThreadCreated,
  TrailFailed,
  TrailLoaded,
  UsagePanelClosed,
  UsagePanelRequested,
} from "./message.ts";

const threadArb: Arbitrary<ThreadInfo> = record({
  archivedAt: oneof(constant(null), integer()),
  cwd: oneof(constant(null), string({ maxLength: 24 })),
  env: constantFrom("stopped", "provisioning", "ready", "error"),
  id: string({ maxLength: 24 }),
  mode: constantFrom("local", "sandbox", "any"),
  name: string({ maxLength: 24 }),
  sessionId: oneof(constant(null), string({ maxLength: 24 })),
  state: constantFrom("idle", "working", "interrupted"),
  tailSeq: integer({ min: 0 }),
});

const wireErrorArb = string({ maxLength: 24 }).map(
  (message) => new WireError({ code: "command_failed", message }),
);

const trailArb: Arbitrary<Model["trail"]> = oneof(
  constant(Trail.Idle()),
  record({
    entries: array(
      record({
        id: option(string({ maxLength: 12 }), { nil: undefined }),
        seq: option(integer(), { nil: undefined }),
      }),
      { maxLength: 4 },
    ),
    tailSeq: integer({ min: 0 }),
  }).map((data) => Trail.Success({ data })),
  constant(Trail.Failure({ error: "boom" })),
);

const liveArb: Arbitrary<Live["live"]> = record({
  message: option(string({ maxLength: 24 }), { nil: undefined }),
  notice: option(string({ maxLength: 24 }), { nil: undefined }),
  thinking: option(string({ maxLength: 24 }), { nil: undefined }),
  tools: array(
    record({
      callId: string({ maxLength: 12 }),
      name: string({ maxLength: 12 }),
      state: constantFrom("running", "done", "failed"),
    }),
    { maxLength: 3 },
  ),
});

const wireModelArb: Arbitrary<WireModelInfo> = record({
  contextWindow: integer({ min: 0 }),
  id: string({ maxLength: 24 }),
  provider: string({ maxLength: 12 }),
  reasoning: boolean(),
});

const modelPickerArb: Arbitrary<Model["modelPicker"]> = oneof(
  constant(ModelPicker.Idle()),
  constant(ModelPicker.Loading()),
  record({ data: array(wireModelArb, { maxLength: 3 }) }).map(({ data }) =>
    ModelPicker.Success({ data }),
  ),
  wireErrorArb.map((error) => ModelPicker.Failure({ error })),
);

const entryArb: Arbitrary<EntryProjection> = record({
  id: option(string({ maxLength: 12 }), { nil: undefined }),
  seq: option(integer(), { nil: undefined }),
  type: option(constantFrom("message", "toolResult", "user_message"), { nil: undefined }),
});

/** Any pane model the update loop could hold. */
const modelArb: Arbitrary<Model> = record({
  composer: string({ maxLength: 24 }),
  composerMenu: constant(null),
  focused: boolean(),
  id: oneof(constant(null), string({ maxLength: 24 })),
  info: oneof(constant(null), threadArb),
  live: liveArb,
  model: oneof(constant(null), wireModelArb),
  modelBusy: boolean(),
  modelPicker: modelPickerArb,
  notice: oneof(constant(null), string({ maxLength: 24 })),
  pickerActive: integer({ max: 3, min: -1 }),
  pickerQuery: string({ maxLength: 12 }),
  starting: boolean(),
  thinkingOpen: array(string({ maxLength: 12 }), { maxLength: 4 }),
  toolsOpen: array(string({ maxLength: 12 }), { maxLength: 4 }),
  trail: trailArb,
  pendingEntries: array(entryArb, { maxLength: 3 }),
  usageOpen: boolean(),
});

describe("thread update", () => {
  it("send prompts or quick-starts exactly when the draft is non-blank", () => {
    assert(
      property(modelArb, (model) => {
        const [next, commands] = update(model, SendRequested());
        const text = model.composer.trim();
        if (text === "") {
          expect(next).toEqual(model);
          expect(commands).toHaveLength(0);
        } else if (model.id !== null) {
          expect(next).toEqual(model);
          if (model.info?.state === "working") {
            expect(commands).toHaveLength(0);
          } else {
            expect(commands).toHaveLength(1);
          }
        } else if (model.starting) {
          expect(next).toEqual(model);
          expect(commands).toHaveLength(0);
        } else {
          expect(next).toEqual({ ...model, starting: true });
          expect(commands).toHaveLength(2);
        }
      }),
    );
  });

  it("a created thread clears the draft and guard, and surfaces OpenedThread", () => {
    assert(
      property(modelArb, threadArb, (model, thread) => {
        const [next, commands, out] = update(model, ThreadCreated({ thread }));
        expect(next).toEqual({
          ...model,
          composer: "",
          composerMenu: null,
          focused: false,
          notice: null,
          starting: false,
        });
        expect(commands).toHaveLength(1);
        expect(out).toEqual(Option.some({ _tag: "OpenedThread", id: thread.id }));
      }),
    );
  });

  it("a failed create releases the guard, keeps the draft, and shows the notice", () => {
    assert(
      property(modelArb, string({ maxLength: 24 }), (model, message) => {
        const [next] = update(model, CreateFailed({ message }));
        expect(next).toEqual({ ...model, notice: message, starting: false });
      }),
    );
  });

  it("the new-thread button surfaces NewThreadRequested on a pinned thread only", () => {
    assert(
      property(modelArb, (model) => {
        const [next, commands, out] = update(model, NewThreadRequested());
        expect(next).toEqual(model);
        expect(commands).toHaveLength(0);
        expect(out).toEqual(
          model.id === null ? Option.none() : Option.some({ _tag: "NewThreadRequested" }),
        );
      }),
    );
  });

  it("keeps the header current from a broadcast for the pinned thread only", () => {
    assert(
      property(modelArb, threadArb, (model, thread) => {
        const [next, commands] = update(model, ThreadChanged({ thread }));
        expect(commands).toHaveLength(model.id === thread.id ? 1 : 0);
        expect(next).toEqual(model.id === thread.id ? { ...model, info: thread } : model);
      }),
    );
  });

  it("the trail lands as Success, and failures land as Failure", () => {
    assert(
      property(
        modelArb,
        array(
          record({
            id: option(string({ maxLength: 12 }), { nil: undefined }),
            seq: option(integer(), { nil: undefined }),
          }),
          { maxLength: 4 },
        ),
        integer({ min: 0 }),
        string({ maxLength: 24 }),
        (model, entries, tailSeq, error) => {
          const [loaded] = update(model, TrailLoaded({ entries, tailSeq }));
          // The load merges the server's entries with anything buffered
          // while it was in flight: deduped by id (first copy wins),
          // ordered by seq, tailSeq never lowering.
          const seen = new Set<string>();
          const merged = [...entries, ...model.pendingEntries]
            .filter((entry) => {
              const id = entry.id ?? "";
              if (seen.has(id)) {
                return false;
              }
              seen.add(id);
              return true;
            })
            .toSorted(
              (a, b) => (a.seq ?? Number.MAX_SAFE_INTEGER) - (b.seq ?? Number.MAX_SAFE_INTEGER),
            );
          const nextTail = merged.reduce((max, entry) => Math.max(max, entry.seq ?? 0), tailSeq);
          expect(loaded.trail).toEqual(Trail.Success({ data: { entries: merged, tailSeq: nextTail } }));
          expect(loaded.pendingEntries).toEqual([]);
          const [failed] = update(model, TrailFailed({ error }));
          expect(failed.trail).toEqual(Trail.Failure({ error }));
        },
      ),
    );
  });

  it("focus, blur, prompt-ack, and send-failure drive their one field", () => {
    assert(
      property(modelArb, string({ maxLength: 24 }), (model, message) => {
        expect(update(model, ComposerFocused())[0]).toEqual({ ...model, focused: true });
        expect(update(model, ComposerBlurred())[0]).toEqual({ ...model, focused: false });
        // The ack is a success of the gesture that could have failed: it
        // clears the draft AND a stale failure notice.
        expect(update(model, PromptAcked())[0]).toEqual({ ...model, composer: "", notice: null });
        expect(update(model, SendFailed({ message }))[0]).toEqual({ ...model, notice: message });
      }),
    );
  });

  it("the state read lands the model and the header's info; a failed read keeps both", () => {
    assert(
      property(modelArb, wireModelArb, threadArb, (model, next, info) => {
        const [loaded] = update(model, StateLoaded({ info, model: next }));
        expect(loaded).toEqual({ ...model, info, model: next, notice: null });
        const [failed] = update(model, StateFailed({ error: "offline" }));
        expect(failed).toEqual({ ...model, notice: "offline" });
      }),
    );
  });

  it("the model picker opens only on a pinned, non-working thread when closed", () => {
    assert(
      property(modelArb, (model) => {
        const [next, commands] = update(model, ModelPickerRequested());
        const opens =
          model.id !== null && model.info?.state !== "working" && model.modelPicker._tag === "Idle";
        expect(next).toEqual(
          opens
            ? {
                ...model,
                modelPicker: ModelPicker.Loading(),
                pickerActive: 0,
                pickerQuery: "",
                // The picker and the usage panel float over the same card
                // edge — opening one closes the other.
                usageOpen: false,
              }
            : model,
        );
        expect(commands).toHaveLength(opens ? 1 : 0);
      }),
    );
  });

  it("the model list lands as Success and a failed list lands as Failure", () => {
    assert(
      property(
        modelArb,
        array(wireModelArb, { maxLength: 3 }),
        wireErrorArb,
        (model, models, error) => {
          const [listed] = update(model, ModelsListed({ models }));
          expect(listed.modelPicker).toEqual(ModelPicker.Success({ data: models }));
          const [failed] = update(model, ModelsListFailed({ error }));
          expect(failed.modelPicker).toEqual(ModelPicker.Failure({ error }));
        },
      ),
    );
  });

  it("typing in the picker sets the filter and restarts the highlight at the top", () => {
    assert(
      property(modelArb, string({ maxLength: 12 }), (model, text) => {
        const [next] = update(model, PickerQueryChanged({ text }));
        expect(next).toEqual({ ...model, pickerActive: 0, pickerQuery: text });
      }),
    );
  });

  it("arrows move the highlight, clamped to the filtered list, and no-op without one", () => {
    assert(
      property(modelArb, integer({ max: 3, min: -3 }), (model, delta) => {
        const [next] = update(model, PickerMove({ delta }));
        if (model.modelPicker._tag !== "Success") {
          expect(next).toEqual(model);
          return;
        }
        const filtered = filterModels(model.modelPicker.data, model.pickerQuery);
        if (filtered.length === 0) {
          expect(next).toEqual(model);
          return;
        }
        const expected = Math.min(Math.max(model.pickerActive + delta, 0), filtered.length - 1);
        expect(next).toEqual({ ...model, pickerActive: expected });
      }),
    );
  });

  it("a model pick is guarded: one in flight, then no-ops", () => {
    assert(
      property(modelArb, wireModelArb, (model, candidate) => {
        const [next, commands] = update(
          model,
          ModelPicked({ modelId: candidate.id, provider: candidate.provider }),
        );
        if (model.id === null || model.modelBusy) {
          expect(next).toEqual(model);
          expect(commands).toHaveLength(0);
        } else {
          expect(next).toEqual({ ...model, modelBusy: true });
          expect(commands).toHaveLength(1);
        }
      }),
    );
  });

  it("a set model lands the model and closes the picker; an unresolvable one shows the notice", () => {
    assert(
      property(modelArb, wireModelArb, (model, next) => {
        const [set] = update(model, ModelSet({ model: next }));
        expect(set).toEqual({
          ...model,
          model: next,
          modelBusy: false,
          modelPicker: ModelPicker.Idle(),
          notice: null,
        });
        const [unresolved] = update(model, ModelSet({ model: null }));
        expect(unresolved).toEqual({
          ...model,
          modelBusy: false,
          notice: "model unavailable",
        });
        const [failed] = update(model, ModelSetFailed({ message: "boom" }));
        expect(failed).toEqual({ ...model, modelBusy: false, notice: "boom" });
      }),
    );
  });

  it("closing the model picker returns it to Idle", () => {
    assert(
      property(modelArb, (model) => {
        const [next] = update(model, ModelPickerClosed());
        expect(next).toEqual({ ...model, modelPicker: ModelPicker.Idle() });
      }),
    );
  });

  it("the usage badge toggles the floating usage panel; the close message closes it", () => {
    assert(
      property(modelArb, (model) => {
        const [opened] = update(model, UsagePanelRequested());
        expect(opened).toEqual({ ...model, usageOpen: !model.usageOpen });
        const [closed] = update(opened, UsagePanelClosed());
        expect(closed).toEqual({ ...model, usageOpen: false });
      }),
    );
  });

  it("opening the model picker closes the usage panel (both float over the card)", () => {
    assert(
      property(modelArb, (model) => {
        const [next, commands] = update({ ...model, usageOpen: true }, ModelPickerRequested());
        // The picker still opens exactly as before (guards unchanged).
        const opens =
          model.id !== null && model.info?.state !== "working" && model.modelPicker._tag === "Idle";
        if (opens) {
          expect(next.usageOpen).toBe(false);
          expect(next.modelPicker._tag).toBe("Loading");
          expect(commands).toHaveLength(1);
        } else {
          // The guard returns the model it was handed, untouched.
          expect(next).toEqual({ ...model, usageOpen: true });
          expect(commands).toHaveLength(0);
        }
      }),
    );
  });

  it("a thinking toggle expands once per id and collapses by id", () => {
    assert(
      property(modelArb, string({ maxLength: 12 }), (model, messageId) => {
        const [expanded] = update(model, ThinkingToggled({ expanded: true, messageId }));
        expect(expanded.thinkingOpen).toEqual(
          model.thinkingOpen.includes(messageId)
            ? model.thinkingOpen
            : [...model.thinkingOpen, messageId],
        );
        const [again] = update(expanded, ThinkingToggled({ expanded: true, messageId }));
        expect(again.thinkingOpen).toEqual(expanded.thinkingOpen);
        const [collapsed] = update(expanded, ThinkingToggled({ expanded: false, messageId }));
        expect(collapsed.thinkingOpen).toEqual(
          expanded.thinkingOpen.filter((id) => id !== messageId),
        );
      }),
    );
  });

  it("a tool toggle expands once per id and collapses by id", () => {
    assert(
      property(modelArb, string({ maxLength: 12 }), (model, id) => {
        const [expanded] = update(model, ToolToggled({ expanded: true, id }));
        expect(expanded.toolsOpen).toEqual(
          model.toolsOpen.includes(id) ? model.toolsOpen : [...model.toolsOpen, id],
        );
        const [again] = update(expanded, ToolToggled({ expanded: true, id }));
        expect(again.toolsOpen).toEqual(expanded.toolsOpen);
        const [collapsed] = update(expanded, ToolToggled({ expanded: false, id }));
        expect(collapsed.toolsOpen).toEqual(expanded.toolsOpen.filter((x) => x !== id));
      }),
    );
  });

  it("AbortRequested is a no-op when no thread is pinned, and fires AbortCmd with the pinned id otherwise", () => {
    assert(
      property(modelArb, (model) => {
        const [next, commands, out] = update(model, AbortRequested());
        expect(next).toEqual(model);
        expect(out).toEqual(Option.none());
        if (model.id === null) {
          expect(commands).toHaveLength(0);
        } else {
          expect(commands).toHaveLength(1);
          expect(commands[0]?.name).toBe("Abort");
          expect(commands[0]?.args).toEqual({ id: model.id });
        }
      }),
    );
  });

  it("AbortDone clears a stale notice; AbortFailed lands one; dismiss and expiry clear both", () => {
    assert(
      property(modelArb, string({ maxLength: 24 }), (model, message) => {
        const [done] = update(model, AbortDone());
        expect(done).toEqual({ ...model, notice: null });
        const [failed] = update(model, AbortFailed({ message }));
        expect(failed).toEqual({ ...model, notice: message });
        const [dismissed] = update(failed, NoticeDismissed());
        expect(dismissed).toEqual({ ...model, notice: null });
      }),
    );
  });

  it("informRouteChanged pins the thread, resets the view, preserves the composer, and reads the trail and state", () => {
    assert(
      property(modelArb, string({ maxLength: 24 }), (model, id) => {
        const reset = {
          composerMenu: null,
          focused: false,
          info: null,
          live: { tools: [] },
          model: null,
          modelBusy: false,
          modelPicker: ModelPicker.Idle(),
          notice: null,
          pickerActive: 0,
          pickerQuery: "",
          thinkingOpen: [],
          toolsOpen: [],
          trail: Trail.Idle(),
          pendingEntries: [],
          usageOpen: false,
        };
        const [pinned, pinnedCommands] = informRouteChanged(model, ThreadRoute({ id }), true);
        expect(pinned).toEqual({ ...model, id, ...reset });
        expect(pinnedCommands).toHaveLength(2);
        const [unpinned, unpinnedCommands] = informRouteChanged(model, ThreadsRoute(), true);
        expect(unpinned).toEqual({ ...model, id: null, ...reset });
        expect(unpinnedCommands).toHaveLength(0);
      }),
    );
  });
});
