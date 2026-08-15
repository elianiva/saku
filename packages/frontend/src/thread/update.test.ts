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
import { WireError, type ThreadInfo, type WireModelInfo } from "@saku/wire";
import fc from "fast-check";

import { ThreadsRoute, ThreadRoute } from "../route.ts";
import { informRouteChanged, update } from "./update.ts";
import { ModelPicker, type Model } from "./model.ts";
import { Trail, type Live } from "./live.ts";
import {
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
  PromptAcked,
  SendFailed,
  SendRequested,
  StateFailed,
  StateLoaded,
  ThreadChanged,
  ThreadCreated,
  TrailFailed,
  TrailLoaded,
} from "./message.ts";

const threadArb: fc.Arbitrary<ThreadInfo> = fc.record({
  id: fc.string({ maxLength: 24 }),
  name: fc.string({ maxLength: 24 }),
  cwd: fc.oneof(fc.constant(null), fc.string({ maxLength: 24 })),
  mode: fc.constantFrom("local", "sandbox", "any"),
  state: fc.constantFrom("idle", "working", "interrupted"),
  env: fc.constantFrom("stopped", "provisioning", "ready", "error"),
  sessionId: fc.oneof(fc.constant(null), fc.string({ maxLength: 24 })),
  tailSeq: fc.integer({ min: 0 }),
});

const wireErrorArb = fc.string({ maxLength: 24 }).map(
  (message) => new WireError({ code: "command_failed", message }),
);

const trailArb: fc.Arbitrary<Model["trail"]> = fc.oneof(
  fc.constant(Trail.Idle()),
  fc
    .record({
      entries: fc.array(
        fc.record({
          id: fc.option(fc.string({ maxLength: 12 }), { nil: undefined }),
          seq: fc.option(fc.integer(), { nil: undefined }),
        }),
        { maxLength: 4 },
      ),
      tailSeq: fc.integer({ min: 0 }),
    })
    .map((data) => Trail.Success({ data })),
  fc.constant(Trail.Failure({ error: "boom" })),
);

const liveArb: fc.Arbitrary<Live["live"]> = fc.record({
  message: fc.option(fc.string({ maxLength: 24 }), { nil: undefined }),
  thinking: fc.option(fc.string({ maxLength: 24 }), { nil: undefined }),
  tools: fc.array(
    fc.record({
      callId: fc.string({ maxLength: 12 }),
      name: fc.string({ maxLength: 12 }),
      state: fc.constantFrom("running", "done", "failed"),
    }),
    { maxLength: 3 },
  ),
  notice: fc.option(fc.string({ maxLength: 24 }), { nil: undefined }),
});

const wireModelArb: fc.Arbitrary<WireModelInfo> = fc.record({
  provider: fc.string({ maxLength: 12 }),
  id: fc.string({ maxLength: 24 }),
  contextWindow: fc.integer({ min: 0 }),
  reasoning: fc.boolean(),
});

const modelPickerArb: fc.Arbitrary<Model["modelPicker"]> = fc.oneof(
  fc.constant(ModelPicker.Idle()),
  fc.constant(ModelPicker.Loading()),
  fc.record({ data: fc.array(wireModelArb, { maxLength: 3 }) }).map(({ data }) =>
    ModelPicker.Success({ data }),
  ),
  wireErrorArb.map((error) => ModelPicker.Failure({ error })),
);

/** Any pane model the update loop could hold. */
const modelArb: fc.Arbitrary<Model> = fc.record({
  id: fc.oneof(fc.constant(null), fc.string({ maxLength: 24 })),
  info: fc.oneof(fc.constant(null), threadArb),
  trail: trailArb,
  live: liveArb,
  model: fc.oneof(fc.constant(null), wireModelArb),
  modelPicker: modelPickerArb,
  modelBusy: fc.boolean(),
  composer: fc.string({ maxLength: 24 }),
  starting: fc.boolean(),
  focused: fc.boolean(),
  notice: fc.oneof(fc.constant(null), fc.string({ maxLength: 24 })),
});

describe("thread update", () => {
  it("send prompts or quick-starts exactly when the draft is non-blank", () => {
    fc.assert(
      fc.property(modelArb, (model) => {
        const [next, commands] = update(model, SendRequested());
        const text = model.composer.trim();
        if (text === "") {
          expect(next).toEqual(model);
          expect(commands).toHaveLength(0);
        } else if (model.id !== null) {
          expect(next).toEqual(model);
          expect(commands).toHaveLength(1);
        } else if (model.starting) {
          expect(next).toEqual(model);
          expect(commands).toHaveLength(0);
        } else {
          expect(next).toEqual({ ...model, starting: true });
          expect(commands).toHaveLength(1);
        }
      }),
    );
  });

  it("a created thread clears the draft and guard, and surfaces OpenedThread", () => {
    fc.assert(
      fc.property(modelArb, threadArb, (model, thread) => {
        const [next, commands, out] = update(model, ThreadCreated({ thread }));
        expect(next).toEqual({ ...model, starting: false, composer: "", focused: false });
        expect(commands).toHaveLength(0);
        expect(out).toEqual(Option.some({ _tag: "OpenedThread", id: thread.id }));
      }),
    );
  });

  it("a failed create releases the guard, keeps the draft, and shows the notice", () => {
    fc.assert(
      fc.property(modelArb, fc.string({ maxLength: 24 }), (model, message) => {
        const [next] = update(model, CreateFailed({ message }));
        expect(next).toEqual({ ...model, starting: false, notice: message });
      }),
    );
  });

  it("keeps the header current from a broadcast for the pinned thread only", () => {
    fc.assert(
      fc.property(modelArb, threadArb, (model, thread) => {
        const [next, commands] = update(model, ThreadChanged({ thread }));
        expect(commands).toHaveLength(0);
        expect(next).toEqual(
          model.id === thread.id ? { ...model, info: thread } : model,
        );
      }),
    );
  });

  it("the trail lands as Success with a scroll, and failures land as Failure", () => {
    fc.assert(
      fc.property(
        modelArb,
        fc.array(
          fc.record({
            id: fc.option(fc.string({ maxLength: 12 }), { nil: undefined }),
            seq: fc.option(fc.integer(), { nil: undefined }),
          }),
          { maxLength: 4 },
        ),
        fc.integer({ min: 0 }),
        fc.string({ maxLength: 24 }),
        (model, entries, tailSeq, error) => {
          const [loaded, loadedCommands] = update(model, TrailLoaded({ entries, tailSeq }));
          expect(loaded.trail).toEqual(Trail.Success({ data: { entries, tailSeq } }));
          expect(loadedCommands).toHaveLength(1);
          const [failed] = update(model, TrailFailed({ error }));
          expect(failed.trail).toEqual(Trail.Failure({ error }));
        },
      ),
    );
  });

  it("focus, blur, prompt-ack, and send-failure drive their one field", () => {
    fc.assert(
      fc.property(modelArb, fc.string({ maxLength: 24 }), (model, message) => {
        expect(update(model, ComposerFocused())[0]).toEqual({ ...model, focused: true });
        expect(update(model, ComposerBlurred())[0]).toEqual({ ...model, focused: false });
        expect(update(model, PromptAcked())[0]).toEqual({ ...model, composer: "" });
        expect(update(model, SendFailed({ message }))[0]).toEqual({ ...model, notice: message });
      }),
    );
  });

  it("the state read lands the model; a failed read keeps the current value", () => {
    fc.assert(
      fc.property(modelArb, wireModelArb, (model, next) => {
        const [loaded] = update(model, StateLoaded({ model: next }));
        expect(loaded).toEqual({ ...model, model: next });
        const [failed] = update(model, StateFailed());
        expect(failed).toEqual(model);
      }),
    );
  });

  it("the model picker opens only on a pinned, non-working thread when closed", () => {
    fc.assert(
      fc.property(modelArb, (model) => {
        const [next, commands] = update(model, ModelPickerRequested());
        const opens =
          model.id !== null &&
          model.info?.state !== "working" &&
          model.modelPicker._tag === "Idle";
        expect(next).toEqual(opens ? { ...model, modelPicker: ModelPicker.Loading() } : model);
        expect(commands).toHaveLength(opens ? 1 : 0);
      }),
    );
  });

  it("the model list lands as Success and a failed list lands as Failure", () => {
    fc.assert(
      fc.property(
        modelArb,
        fc.array(wireModelArb, { maxLength: 3 }),
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

  it("a model pick is guarded: one in flight, then no-ops", () => {
    fc.assert(
      fc.property(modelArb, wireModelArb, (model, candidate) => {
        const [next, commands] = update(
          model,
          ModelPicked({ provider: candidate.provider, modelId: candidate.id }),
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
    fc.assert(
      fc.property(modelArb, wireModelArb, (model, next) => {
        const [set] = update(model, ModelSet({ model: next }));
        expect(set).toEqual({
          ...model,
          model: next,
          modelBusy: false,
          modelPicker: ModelPicker.Idle(),
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
    fc.assert(
      fc.property(modelArb, (model) => {
        const [next] = update(model, ModelPickerClosed());
        expect(next).toEqual({ ...model, modelPicker: ModelPicker.Idle() });
      }),
    );
  });

  it("informRouteChanged pins the thread, resets the view, preserves the composer, and reads the trail and state", () => {
    fc.assert(
      fc.property(modelArb, fc.string({ maxLength: 24 }), (model, id) => {
        const reset = {
          info: null,
          trail: Trail.Idle(),
          live: { tools: [] },
          focused: false,
          model: null,
          modelPicker: ModelPicker.Idle(),
          modelBusy: false,
        };
        const [pinned, pinnedCommands] = informRouteChanged(model, ThreadRoute({ id }));
        expect(pinned).toEqual({ ...model, id, ...reset });
        expect(pinnedCommands).toHaveLength(2);
        const [unpinned, unpinnedCommands] = informRouteChanged(model, ThreadsRoute());
        expect(unpinned).toEqual({ ...model, id: null, ...reset });
        expect(unpinnedCommands).toHaveLength(0);
      }),
    );
  });
});
