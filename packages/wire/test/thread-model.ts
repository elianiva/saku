/**
 * The model-based thread-lifecycle machinery (thread-model.ts): arbitrary
 * op sequences against the real server, checked against an in-memory
 * registry model. Commands reference threads by a symbolic name drawn from
 * a small pool, so the known-thread arms (rename/get/delete of a created
 * thread) are hit as often as the unknown-thread failures. A symbol may
 * name several threads (duplicate creates): the model stacks them and the
 * commands act on the newest — the registry truth stays exact. One fixture
 * serves every run; the model is seeded from the registry's current state
 * so runs compose.
 */

import { Effect } from "effect";
import { commands, constant, constantFrom, oneof, record, string } from "fast-check";
import { expect } from "vitest";

import type { WireClientApi } from "../src/index.ts";

/** One live thread the model knows. */
export interface ThreadEntry {
  readonly id: string;
  readonly name: string;
}

/** The in-memory registry the commands are checked against. */
export class LifecycleModel {
  /** Symbol → the threads created under it, newest last. */
  readonly stacks = new Map<string, ThreadEntry[]>();
  /** Every live thread by id — the registry truth. */
  readonly all = new Map<string, ThreadEntry>();

  current(symbol: string): ThreadEntry | undefined {
    const stack = this.stacks.get(symbol);
    return stack?.at(-1);
  }
}

/** An id that can never resolve: real ids are 32-char hex, this is not. */
export const bogusId = (symbol: string) => `nope-${symbol}`;

/** The symbol pool: small so later commands hit earlier creates. */
const symbolArb = constantFrom("a", "b", "c", "d", "e", "z", "y", "x");

interface CreateCommandArgs {
  readonly cwd: string | null;
  readonly name: string;
  readonly symbol: string;
}

/** One create_thread op against the model and the real client. */
const createThreadCommand = ({ cwd, name, symbol }: CreateCommandArgs) => ({
  check: () => true,
  async run(model: LifecycleModel, real: WireClientApi) {
    const thread = await Effect.runPromise(real.createThread(name, cwd === null ? {} : { cwd }));
    expect(thread).toMatchObject({
      cwd,
      env: "ready",
      mode: "local",
      name,
      state: "idle",
    });
    const entry: ThreadEntry = { id: thread.id, name };
    const stack = model.stacks.get(symbol);
    if (stack === undefined) {
      model.stacks.set(symbol, [entry]);
    } else {
      stack.push(entry);
    }
    model.all.set(entry.id, entry);
  },
  toString: () => `create(${JSON.stringify(symbol)}, ${JSON.stringify(name)})`,
});

interface RenameCommandArgs {
  readonly name: string;
  readonly symbol: string;
}

/** One rename_thread op against the model and the real client. */
const renameThreadCommand = ({ name, symbol }: RenameCommandArgs) => ({
  check: () => true,
  async run(model: LifecycleModel, real: WireClientApi) {
    const entry = model.current(symbol);
    const id = entry?.id ?? bogusId(symbol);
    if (entry === undefined || name.trim() === "") {
      // Unknown symbol, or the registry rejects blank renames.
      await expect(Effect.runPromise(real.renameThread(id, name))).rejects.toMatchObject({
        code: "command_failed",
      });
      return;
    }
    const renamed = await Effect.runPromise(real.renameThread(entry.id, name));
    expect(renamed.name).toBe(name.trim());
    entry.name = name.trim();
  },
  toString: () => `rename(${JSON.stringify(symbol)}, ${JSON.stringify(name)})`,
});

/** One get_thread op against the model and the real client. */
const getThreadCommand = (symbol: string) => ({
  check: () => true,
  async run(model: LifecycleModel, real: WireClientApi) {
    const entry = model.current(symbol);
    if (entry === undefined) {
      await expect(Effect.runPromise(real.getThread(bogusId(symbol)))).rejects.toMatchObject({
        code: "command_failed",
      });
      return;
    }
    const got = await Effect.runPromise(real.getThread(entry.id));
    expect(got.id).toBe(entry.id);
    expect(got.name).toBe(entry.name);
  },
  toString: () => `get(${JSON.stringify(symbol)})`,
});

/** One delete_thread op against the model and the real client. */
const deleteThreadCommand = (symbol: string) => ({
  check: () => true,
  async run(model: LifecycleModel, real: WireClientApi) {
    const entry = model.current(symbol);
    if (entry === undefined) {
      await expect(Effect.runPromise(real.deleteThread(bogusId(symbol)))).rejects.toMatchObject({
        code: "command_failed",
      });
      return;
    }
    await Effect.runPromise(real.deleteThread(entry.id));
    const stack = model.stacks.get(symbol);
    if (stack !== undefined) {
      stack.pop();
    }
    model.all.delete(entry.id);
  },
  toString: () => `delete(${JSON.stringify(symbol)})`,
});

/** One list_threads op against the model and the real client. */
const listThreadsCommand = () => ({
  check: () => true,
  async run(model: LifecycleModel, real: WireClientApi) {
    const threads = await Effect.runPromise(real.listThreads());
    const byId = new Map(threads.map((thread) => [thread.id, thread]));
    expect(new Set(byId.keys())).toEqual(new Set(model.all.keys()));
    for (const entry of model.all.values()) {
      expect(byId.get(entry.id)?.name).toBe(entry.name);
    }
  },
  toString: () => "list()",
});

/** The op-sequence generator: arbitrary command lists over the symbol pool. */
export const lifecycleCommands = () =>
  commands(
    [
      record({
        cwd: oneof(constant(null), string({ maxLength: 12 })),
        name: string({ maxLength: 12 }),
        symbol: symbolArb,
      }).map(({ cwd, name, symbol }) => createThreadCommand({ cwd, name, symbol })),
      record({
        // Blank names are common: the registry rejects them (a real
        // contract arm, not a corner case).
        name: oneof(constant(""), constant("   "), string({ maxLength: 12 })),
        symbol: symbolArb,
      }).map(({ name, symbol }) => renameThreadCommand({ name, symbol })),
      record({ symbol: symbolArb }).map(({ symbol }) => getThreadCommand(symbol)),
      record({ symbol: symbolArb }).map(({ symbol }) => deleteThreadCommand(symbol)),
      constant(listThreadsCommand()),
    ],
    { maxCommands: 15 },
  );
