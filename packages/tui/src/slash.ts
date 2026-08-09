/**
 * Slash commands (slash.ts): pi's `/`-command vocabulary for the saku TUI.
 *
 * A registry of commands (one entry per command — the extension point), a
 * parser for the submit path, and a prefix matcher for the slash menu.
 * Commands never mutate the model: they emit `Msg`s like any other input
 * (pure TEA). Unknown commands surface an error dialog, exactly like pi.
 */

import { Effect } from "effect";

import type { ThinkingLevel } from "@saku/wire";
import type { Msg, Model } from "./app.ts";
import type { WireHub } from "./wire.ts";

export interface SlashContext {
  readonly hub: WireHub;
  readonly model: Model;
  readonly onQuit: () => void;
}

export interface SlashCommand {
  readonly name: string;
  readonly usage: string;
  readonly description: string;
  /** Screens the command is offered on. */
  readonly scope: "any" | "home" | "thread";
  /** True when the command needs arguments (enter fills it; it does not submit). */
  readonly needsArgs: boolean;
  readonly run: (ctx: SlashContext, args: string) => Effect.Effect<Msg, never, never>;
}

const threadIdOf = (model: Model): string | null =>
  model.screen.kind === "thread" ? model.screen.threadId : null;

/** The thread-scoped commands, driven by the wire surface saku has (ADR 0006). */
export const slashCommands: readonly SlashCommand[] = [
  {
    name: "tree",
    usage: "",
    description: "open the session tree to jump between messages",
    scope: "thread",
    needsArgs: false,
    run: (ctx) => {
      if (threadIdOf(ctx.model) === null) return Effect.succeed({ _tag: "TreeOpen" } satisfies Msg);
      return Effect.succeed({ _tag: "TreeOpen" } satisfies Msg);
    },
  },
  {
    name: "model",
    usage: "[provider/model]",
    description: "cycle the model, or set it: /model provider/model",
    scope: "thread",
    needsArgs: false,
    run: ({ hub, model }, args) => {
      const threadId = threadIdOf(model);
      if (threadId === null) return Effect.succeed({ _tag: "WireError", message: "/model needs a thread" } satisfies Msg);
      if (args.trim().length === 0) return hub.cycleModel(threadId);
      const [provider, modelId] = args.trim().split("/");
      if (provider === undefined || modelId === undefined || modelId.length === 0) {
        return Effect.succeed({
          _tag: "WireError",
          message: `usage: /model provider/model — got "${args.trim()}"`,
        } satisfies Msg);
      }
      return hub.setModel(threadId, provider, modelId);
    },
  },
  {
    name: "thinking",
    usage: "[level]",
    description: "cycle thinking level, or set one: off minimal low medium high xhigh max",
    scope: "thread",
    needsArgs: false,
    run: ({ hub, model }, args) => {
      const threadId = threadIdOf(model);
      if (threadId === null) return Effect.succeed({ _tag: "WireError", message: "/thinking needs a thread" } satisfies Msg);
      const level = args.trim();
      if (level.length === 0) return hub.cycleThinkingLevel(threadId);
      const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
      if (!(levels as readonly string[]).includes(level)) {
        return Effect.succeed({
          _tag: "WireError",
          message: `unknown thinking level "${level}" — one of: ${levels.join(" ")}`,
        } satisfies Msg);
      }
      return hub.setThinkingLevel(threadId, level as ThinkingLevel);
    },
  },
  {
    name: "compact",
    usage: "",
    description: "compact the session",
    scope: "thread",
    needsArgs: false,
    run: ({ hub, model }) => {
      const threadId = threadIdOf(model);
      if (threadId === null) return Effect.succeed({ _tag: "WireError", message: "/compact needs a thread" } satisfies Msg);
      return hub.compact(threadId);
    },
  },
  {
    name: "name",
    usage: "<name>",
    description: "rename the thread (a user name wins over auto-title)",
    scope: "thread",
    needsArgs: true,
    run: ({ hub, model }, args) => {
      const threadId = threadIdOf(model);
      if (threadId === null) return Effect.succeed({ _tag: "WireError", message: "/name needs a thread" } satisfies Msg);
      return hub.renameThread(threadId, args.trim());
    },
  },
  {
    name: "resume",
    usage: "",
    description: "go to the thread list",
    scope: "any",
    needsArgs: false,
    run: () => Effect.succeed({ _tag: "BackToList" } satisfies Msg),
  },
  {
    name: "new",
    usage: "",
    description: "create a new thread (asks for a name)",
    scope: "any",
    needsArgs: false,
    run: () => Effect.succeed({ _tag: "NewThreadDialog" } satisfies Msg),
  },
  {
    name: "quit",
    usage: "",
    description: "exit",
    scope: "any",
    needsArgs: false,
    run: ({ onQuit }) => Effect.sync(onQuit).pipe(Effect.as({ _tag: "Quit" } satisfies Msg)),
  },
  {
    name: "help",
    usage: "",
    description: "list slash commands",
    scope: "any",
    needsArgs: false,
    run: () => Effect.succeed({ _tag: "Help" } satisfies Msg),
  },
];

export type ParsedSlash =
  | { readonly kind: "prompt" }
  | { readonly kind: "command"; readonly command: SlashCommand; readonly args: string }
  | { readonly kind: "unknown"; readonly name: string; readonly args: string };

/** Parse a submitted input: `/cmd args` → command, anything else → prompt. */
export const parseSlash = (text: string): ParsedSlash => {
  if (!text.startsWith("/")) return { kind: "prompt" };
  const [rawName, ...rest] = text.slice(1).split(/\s+/);
  const name = rawName?.toLowerCase() ?? "";
  const args = rest.join(" ");
  const command = slashCommands.find((c) => c.name === name);
  if (command === undefined) return { kind: "unknown", name, args };
  return { kind: "command", command, args };
};

/** The text currently being typed in the active input box. */
export const currentInput = (model: Model): string =>
  model.screen.kind === "home" ? model.homeInput : model.screen.kind === "thread" ? model.screen.input : "";

/** Prefix-match commands for the slash menu, scoped to the current screen. */
export const slashMatches = (model: Model): readonly SlashCommand[] => {
  const input = currentInput(model);
  if (!input.startsWith("/")) return [];
  const name = input.slice(1).toLowerCase();
  const scope = model.screen.kind;
  return slashCommands
    .filter((c) => c.scope === "any" || c.scope === scope)
    .filter((c) => c.name.startsWith(name))
    .sort((a, b) => a.name.localeCompare(b.name));
};

/** True when the slash menu is visible (input starts with `/` and something matches). */
export const slashMenuOpen = (model: Model): boolean => model.slash !== null && slashMatches(model).length > 0;

/** Apply the selected menu item to the input: fill with a trailing space when args are needed. */
export const slashFill = (model: Model, selected: SlashCommand): { readonly input: string; readonly submit: boolean } => {
  const needs = selected.needsArgs;
  return { input: `/${selected.name}${needs ? " " : ""}`, submit: !needs };
};
