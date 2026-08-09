/**
 * The foldtui runtime: a minimal The Elm Architecture loop that drives a
 * foldkit application (Model / init / update / view) and renders its view
 * through OpenTUI instead of the DOM.
 *
 * The loop mirrors foldkit's own runtime: messages are queued and drained
 * synchronously, each message runs `update`, the new model is rendered, and
 * any returned Commands are forked as Effects whose result messages are
 * dispatched back into the loop.
 */

import { Context, Effect } from "effect";
import { createCliRenderer, type CliRenderer } from "@opentui/core";
import { clearHtmlRuntime, htmlBuilder, setHtmlRuntime } from "foldkit/html";
import type { Document, HtmlBuilder } from "foldkit/html";
import type { TuiVNode } from "./vnode.ts";
import * as Command from "foldkit/command";
import { Dispatch } from "foldkit/runtime";

import { TuiPatcher } from "./patcher.ts";
import { wireKeyboard } from "./events.ts";

export interface TuiApplication<Model, Message> {
  /** Accepted for foldkit shape parity; not yet used by the terminal runtime. */
  Model?: unknown;
  init: () => readonly [Model, ReadonlyArray<Command.Command<Message>>];
  update: (
    model: Model,
    message: Message,
  ) => readonly [Model, ReadonlyArray<Command.Command<Message>>];
  view: (model: Model, h: HtmlBuilder<Message>) => Document;
  /**
   * Host-side subscription (the terminal equivalent of foldkit ports): the
   * app registers a callback that pushes messages into the loop, e.g. wire
   * events from a socket. Returns an unsubscribe function.
   */
  subscribe?: (dispatch: (message: Message) => void) => () => void;
}

export interface TuiHandle {
  renderer: CliRenderer;
  destroy: () => Promise<void>;
}

/** Identity wrapper mirroring `Runtime.makeApplication`. */
export const makeApplication = <Model, Message>(
  config: TuiApplication<Model, Message>,
): TuiApplication<Model, Message> => config;

/** Creates a CLI renderer and runs the application in it. */
export const run = async <Model, Message>(
  app: TuiApplication<Model, Message>,
): Promise<TuiHandle> => {
  const renderer = await createCliRenderer();
  return runWithRenderer(renderer, app);
};

/** Runs the application inside an existing renderer (e.g. tests with custom streams). */
export const runWithRenderer = <Model, Message>(
  renderer: CliRenderer,
  app: TuiApplication<Model, Message>,
): TuiHandle => {
  const queue: Array<Message> = [];
  let model: Model;
  let pumping = false;

  const dispatchToLoop = (message: Message): void => {
    queue.push(message);
    pump();
  };

  const dispatchService = Dispatch.of({
    dispatchAsync: () => Effect.void,
    dispatchSync: (message: unknown) => {
      queue.push(message as Message);
      pump();
    },
  });
  const runtimeContext = Context.make(Dispatch, dispatchService);
  const patcher = new TuiPatcher(renderer);

  const render = (): void => {
    const h = htmlBuilder<Message>();
    setHtmlRuntime(dispatchService.dispatchSync, runtimeContext);
    let document: Document;
    try {
      document = app.view(model, h);
    } finally {
      clearHtmlRuntime();
    }
    if (document.body !== null) {
      patcher.patch(document.body as unknown as TuiVNode);
    }
  };

  const runCommand = (command: Command.Command<Message>): void => {
    // The conditional `Command.Command<Message>` type stays unresolved for a
    // generic `Message`; cast to a concrete effect for the pipeline.
    const effect = command.effect as Effect.Effect<Message>;
    Effect.runFork(
      effect.pipe(
        Effect.catchCause((cause) => Effect.logError(`[foldtui] command failed: ${String(cause)}`)),
        Effect.flatMap((message) =>
          Effect.sync(() => {
            queue.push(message as Message);
            pump();
          }),
        ),
      ),
    );
  };

  const pump = (): void => {
    if (pumping) return;
    pumping = true;
    void (async () => {
      try {
        while (queue.length > 0) {
          const message = queue.shift()!;
          const [nextModel, commands] = app.update(model, message);
          model = nextModel;
          try {
            render();
          } catch (error) {
            console.error("[foldtui] render failed:", error);
          }
          for (const command of commands) {
            runCommand(command);
          }
        }
      } catch (error) {
        console.error("[foldtui] update failed:", error);
      } finally {
        pumping = false;
      }
    })();
  };

  // Boot: initial model, first render, then init commands.
  const [initialModel, initCommands] = app.init();
  model = initialModel;
  render();
  for (const command of initCommands) {
    runCommand(command);
  }

  const stopKeyboard = wireKeyboard(renderer);
  const unsubscribe = app.subscribe === undefined ? undefined : app.subscribe(dispatchToLoop);

  return {
    renderer,
    destroy: async () => {
      unsubscribe?.();
      stopKeyboard();
      await renderer.destroy();
    },
  };
};
