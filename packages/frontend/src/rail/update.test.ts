/**
 * The rail update's property tests (update.test.ts): the grid transitions
 * (list/refresh/broadcast upsert), the delete flow, and the OutMessages the
 * rail surfaces to the root. (The quick-start flow moved to the pane with
 * the gesture — thread/update.test.ts covers it.) Exercised as pure
 * updates; the commands are asserted, never executed.
 *
 * The list semantics are pinned as properties over arbitrary lists and
 * threads: a broadcast upserts in place when the id is present (replacing
 * every occurrence) and appends otherwise; a delete filters the list; and
 * the click/delete OutMessages carry the id through unchanged. The
 * before-the-list-lands arms (Idle/Failure) are no-ops.
 */

import { describe, expect, it } from "vitest";
import { Option } from "effect";
import { WireError, type ThreadInfo } from "@saku/wire";
import fc from "fast-check";

import { ThreadsRoute, ThreadRoute } from "../route.ts";
import { update, informRouteChanged } from "./update.ts";
import { initialModel } from "./model.ts";
import {
  ClickedThread,
  DeleteFailed,
  DeleteRequested,
  ListFailed,
  RefreshRequested,
  ThreadChanged,
  ThreadDeleted,
  ThreadsListed,
} from "./message.ts";

/** Any registry thread the wire could broadcast. */
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

const listArb = fc.array(threadArb, { maxLength: 8 });

const wireErrorArb = fc.string({ maxLength: 24 }).map(
  (message) => new WireError({ code: "command_failed", message }),
);

/** Fold ThreadsListed, then one more update, returning the next model. */
const listed = (threads: readonly ThreadInfo[]) =>
  update(initialModel(), ThreadsListed({ threads }))[0];

describe("rail update", () => {
  it("lands any list as Success and clears the notice", () => {
    fc.assert(
      fc.property(
        listArb,
        fc.oneof(fc.constant(null), fc.string({ maxLength: 24 })),
        (threads, staleNotice) => {
          const [model] = update(
            { ...initialModel(), notice: staleNotice },
            ThreadsListed({ threads }),
          );
          expect(model.list).toEqual({ _tag: "Success", data: threads });
          expect(model.notice).toBeNull();
        },
      ),
    );
  });

  it("lands any failure as the list's Failure", () => {
    fc.assert(
      fc.property(wireErrorArb, (error) => {
        const [model] = update(initialModel(), ListFailed({ error }));
        expect(model.list).toEqual({ _tag: "Failure", error });
      }),
    );
  });

  it("refresh re-lists from any state", () => {
    fc.assert(
      fc.property(fc.oneof(fc.constant(initialModel()), listArb.map((threads) => listed(threads))), (model) => {
        const [next, commands] = update(model, RefreshRequested());
        expect(next).toEqual(model);
        expect(commands).toHaveLength(1);
      }),
    );
  });

  it("a broadcast upserts in place and appends otherwise", () => {
    fc.assert(
      fc.property(listArb, threadArb, (threads, incoming) => {
        const [model] = update(listed(threads), ThreadChanged({ thread: incoming }));
        const known = threads.some((existing) => existing.id === incoming.id);
        const expected = known
          ? threads.map((existing) => (existing.id === incoming.id ? incoming : existing))
          : [...threads, incoming];
        expect(model.list).toEqual({ _tag: "Success", data: expected });
      }),
    );
  });

  it("a broadcast before the list lands is a no-op", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constant(initialModel()),
          wireErrorArb.map((error) => update(initialModel(), ListFailed({ error }))[0]),
        ),
        threadArb,
        (model, incoming) => {
          const [next, commands] = update(model, ThreadChanged({ thread: incoming }));
          expect(next).toEqual(model);
          expect(commands).toHaveLength(0);
        },
      ),
    );
  });

  it("a row click surfaces OpenedThread with the id, leaving the model alone", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 24 }), (id) => {
        const [model, commands, out] = update(initialModel(), ClickedThread({ id }));
        expect(model).toEqual(initialModel());
        expect(commands).toHaveLength(0);
        expect(out).toEqual(Option.some({ _tag: "OpenedThread", id }));
      }),
    );
  });

  it("delete request fires the command; the landed delete filters the row and surfaces DeletedThread", () => {
    fc.assert(
      fc.property(listArb, fc.string({ maxLength: 24 }), (threads, id) => {
        const [, commands] = update(listed(threads), DeleteRequested({ id }));
        expect(commands).toHaveLength(1);
        const [model, , out] = update(listed(threads), ThreadDeleted({ id }));
        expect(model.list).toEqual({
          _tag: "Success",
          data: threads.filter((thread) => thread.id !== id),
        });
        expect(out).toEqual(Option.some({ _tag: "DeletedThread", id }));
      }),
    );
  });

  it("a failed delete shows the notice", () => {
    fc.assert(
      fc.property(wireErrorArb, (error) => {
        const [model] = update(initialModel(), DeleteFailed({ error }));
        expect(model.notice).toBe(error.message);
      }),
    );
  });

  it("informRouteChanged tracks the pinned thread for the row highlight", () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.constant(initialModel()), listArb.map((threads) => listed(threads))),
        fc.string({ maxLength: 24 }),
        (model, id) => {
          expect(informRouteChanged(model, ThreadsRoute()).selectedId).toBeNull();
          expect(informRouteChanged(model, ThreadRoute({ id })).selectedId).toBe(id);
        },
      ),
    );
  });
});
