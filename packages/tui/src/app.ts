/**
 * The saku TUI: a foldkit TEA application rendered by foldtui.
 *
 * Three screens — home (the default: a prompt box over an empty canvas,
 * pi's no-session shape), the thread list, and the thread view — plus the
 * tree overlay (jump between messages in a session), slash commands, modal
 * dialogs (confirm / input / help), and a status bar. All keyboard input
 * arrives through a single root-level `OnKeyDown`; the wire lives behind
 * `WireHub`, whose events enter the loop as ordinary messages.
 */

import { Effect } from "effect";
import type { Command } from "foldkit";
import type { HtmlBuilder, KeyboardModifiers } from "foldkit/html";

import {
  shortThreadId,
  type CompactResult,
  type Entry,
  type SessionWireEvent,
  type ThreadInfo,
  type ThreadSessionState,
  type ThinkingLevel,
  type WireModelInfo,
} from "@saku/wire";

import { parseSlash, slashCommands, slashFill, slashMatches, slashMenuOpen } from "./slash.ts";
import { WireHub } from "./wire.ts";

// ---------------------------------------------------------------------------
// Palette (rose-pine dawn)
// ---------------------------------------------------------------------------

const rose = {
  base: "#faf4ed",
  surface: "#fffaf3",
  overlay: "#f2e9e1",
  muted: "#9893a5",
  text: "#575279",
  gold: "#ea9d34",
  love: "#b4637a",
  foam: "#286983",
  iris: "#907aa9",
  pine: "#56949f",
} as const;

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export type Msg =
  | { readonly _tag: "Boot" }
  | { readonly _tag: "Key"; readonly key: string; readonly mods: KeyboardModifiers }
  | { readonly _tag: "Paste"; readonly text: string }
  | { readonly _tag: "Connected" }
  | { readonly _tag: "Threads"; readonly threads: ReadonlyArray<ThreadInfo> }
  | { readonly _tag: "ThreadChanged"; readonly thread: ThreadInfo }
  | {
      readonly _tag: "ThreadOpened";
      readonly threadId: string;
      readonly entries: ReadonlyArray<Entry>;
      readonly tailSeq: number;
      readonly leafId: string | null;
      readonly state: ThreadSessionState;
      /** True when the open was immediately followed by a prompt (quick start). */
      readonly started: boolean;
    }
  | {
      readonly _tag: "Entries";
      readonly threadId: string;
      readonly entries: ReadonlyArray<Entry>;
      readonly tailSeq: number;
      readonly leafId: string | null;
    }
  | { readonly _tag: "ThreadState"; readonly threadId: string; readonly state: ThreadSessionState }
  | { readonly _tag: "Event"; readonly threadId: string; readonly event: SessionWireEvent }
  | { readonly _tag: "WireError"; readonly message: string }
  | { readonly _tag: "ConnectionLost" }
  | { readonly _tag: "ModelChanged"; readonly model: WireModelInfo | null }
  | { readonly _tag: "ThinkingChanged"; readonly level: ThinkingLevel }
  | { readonly _tag: "PromptAccepted" }
  | { readonly _tag: "Aborted" }
  | { readonly _tag: "Deleted"; readonly id: string }
  | { readonly _tag: "DialogClose" }
  | { readonly _tag: "DialogSubmit" }
  | { readonly _tag: "BackToList" }
  | { readonly _tag: "GoHome" }
  | { readonly _tag: "NewThreadDialog" }
  | { readonly _tag: "Help" }
  | { readonly _tag: "TreeOpen" }
  | { readonly _tag: "TreeClose" }
  | { readonly _tag: "TreeJump" }
  | { readonly _tag: "BranchDone"; readonly threadId: string; readonly leafId: string | null }
  | { readonly _tag: "CompactResult"; readonly result: CompactResult }
  | { readonly _tag: "Renamed" }
  | { readonly _tag: "EscArm"; readonly id: number }
  | { readonly _tag: "Quit" };

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

export type Dialog =
  | {
      readonly kind: "confirm";
      readonly title: string;
      readonly message: string;
      readonly action: "delete-thread" | "ok";
    }
  | {
      readonly kind: "input";
      readonly title: string;
      readonly placeholder: string;
      readonly action: "create-thread";
      readonly text: string;
    }
  | { readonly kind: "help"; readonly title: string; readonly lines: ReadonlyArray<string> };

export interface HomeScreen {
  readonly kind: "home";
}

export interface ListScreen {
  readonly kind: "list";
  readonly threads: ReadonlyArray<ThreadInfo>;
  readonly selected: number;
  readonly loading: boolean;
}

export interface TreeOverlay {
  readonly selected: number;
}

export interface ThreadScreen {
  readonly kind: "thread";
  readonly threadId: string;
  readonly info: ThreadInfo;
  readonly state: ThreadSessionState | null;
  readonly entries: ReadonlyArray<Entry>;
  readonly tailSeq: number;
  readonly working: boolean;
  readonly liveText: string;
  readonly input: string;
  readonly scrollBack: number;
  /** Where this thread was opened from — esc returns there (back-stack). */
  readonly cameFrom: "home" | "list";
  /** The session's active leaf; the tree overlay's active path. */
  readonly leafId: string | null;
}

export interface Model {
  readonly screen: HomeScreen | ListScreen | ThreadScreen;
  readonly dialog: Dialog | null;
  readonly tree: TreeOverlay | null;
  /** Slash-menu selection; null when the menu is closed. */
  readonly slash: { readonly selected: number } | null;
  /** The home prompt box's text, preserved across navigation. */
  readonly homeInput: string;
  /** Thread to auto-open once the list loads (`saku open <id>`). */
  readonly pendingOpen: string | null;
  /** Double-esc arm: the id of the pending "back" timer, if armed. */
  readonly escArm: { readonly id: number } | null;
  readonly connected: boolean;
}

// ---------------------------------------------------------------------------
// Command helper
// ---------------------------------------------------------------------------

const cmd = <M extends Msg>(name: string, effect: Effect.Effect<M, never, never>): Command.Command<Msg> =>
  ({ name, effect }) as Command.Command<Msg>;

// ---------------------------------------------------------------------------
// Entry rendering
// ---------------------------------------------------------------------------

const clip = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
};

const textOf = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      const p = part as { type?: string; text?: string; toolName?: string };
      if (p.type === "text" || p.type === "thinking") return p.text ?? "";
      if (p.type === "toolCall") return `🔧 ${p.toolName ?? "tool"}`;
      return "";
    })
    .join("");
};

/** One-line rendering of a durable entry. */
export const entryLine = (entry: Entry): { readonly text: string; readonly dim: boolean } => {
  switch (entry.type) {
    case "message": {
      const message = entry.message as {
        role?: string;
        content?: unknown;
        toolName?: string;
        isError?: boolean;
      };
      const body = clip(textOf(message.content), 160);
      if (message.role === "user") return { text: `» ${body}`, dim: false };
      if (message.role === "assistant") return { text: `assistant: ${body}`, dim: false };
      const mark = message.isError === true ? "✗" : "✓";
      return { text: `🔧 ${message.toolName ?? "tool"} ${mark} ${body}`, dim: false };
    }
    case "model_change":
      return { text: `→ model ${entry.provider}/${entry.modelId}`, dim: true };
    case "thinking_level_change":
      return { text: `→ thinking ${entry.thinkingLevel}`, dim: true };
    case "active_tools_change":
      return { text: `→ tools ${entry.activeToolNames.join(", ")}`, dim: true };
    case "compaction":
      return { text: `↷ compacted: ${clip(entry.summary, 120)}`, dim: true };
    case "branch_summary":
      return { text: `↷ branch summary: ${clip(entry.summary, 120)}`, dim: true };
    case "custom":
      return { text: `custom ${entry.customType}`, dim: true };
  }
};

// ---------------------------------------------------------------------------
// Session tree (tree overlay)
// ---------------------------------------------------------------------------

export interface TreeRow {
  readonly id: string;
  readonly depth: number;
  readonly prefix: string;
  readonly text: string;
  readonly dim: boolean;
  /** The node is on the path from the session's leaf back to the root. */
  readonly onPath: boolean;
}

/**
 * Flatten the session tree (entries + parentId, pi's flat-with-parent shape)
 * into display rows with pi-style `│ ├ └` connectors. Entries arrive in seq
 * order, so children lists are already chronological.
 */
export const treeRows = (entries: ReadonlyArray<Entry>, leafId: string | null): TreeRow[] => {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const children = new Map<string, Entry[]>();
  const roots: Entry[] = [];
  for (const entry of entries) {
    const parent = entry.parentId;
    if (parent === null || !byId.has(parent)) {
      roots.push(entry);
    } else {
      const list = children.get(parent) ?? [];
      list.push(entry);
      children.set(parent, list);
    }
  }

  // Active path: leafId and every ancestor of it.
  const onPath = new Set<string>();
  let cursor = leafId;
  while (cursor !== null && byId.has(cursor)) {
    onPath.add(cursor);
    cursor = byId.get(cursor)?.parentId ?? null;
  }

  const rows: TreeRow[] = [];
  const visit = (entry: Entry, depth: number, prefix: string, lastOfParent: boolean): void => {
    const line = entryLine(entry);
    const connector = depth === 0 ? "" : lastOfParent ? "└─ " : "├─ ";
    rows.push({
      id: entry.id,
      depth,
      prefix: prefix + connector,
      text: line.text,
      dim: line.dim,
      onPath: onPath.has(entry.id),
    });
    const kids = children.get(entry.id) ?? [];
    // Children hang from the connector: `│ ` while the parent has later
    // siblings, `  ` after its last one.
    const gutter = depth === 0 || lastOfParent ? "  " : "│ ";
    for (let i = 0; i < kids.length; i++) {
      const kid = kids[i];
      if (kid !== undefined) visit(kid, depth + 1, prefix + connector + gutter, i === kids.length - 1);
    }
  };
  for (const root of roots) visit(root, 0, "", roots.length === 1);
  return rows;
};

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

const EMPTY_COMMANDS: ReadonlyArray<Command.Command<Msg>> = [];

const cwd = process.cwd();

const visibleLines = 18;

const DOUBLE_ESC_MS = 250;

let escArmSeq = 0;

const homeOf = (model: Model): Model => ({
  ...model,
  screen: { kind: "home" },
  tree: null,
  slash: null,
  escArm: null,
});

const listOf = (model: Model): Model => ({
  ...model,
  screen: { kind: "list", threads: [], selected: 0, loading: true },
  tree: null,
  slash: null,
  escArm: null,
});

const refreshList = (model: Model, hub: WireHub): readonly [Model, ReadonlyArray<Command.Command<Msg>>] => [
  listOf(model),
  [cmd("refresh", hub.refreshThreads())],
];

/** Set the active input's text, keeping the slash menu in sync. */
const withInput = (model: Model, input: string): Model => {
  const next =
    model.screen.kind === "home"
      ? { ...model, homeInput: input }
      : model.screen.kind === "thread"
        ? { ...model, screen: { ...model.screen, input } }
        : model;
  if (!input.startsWith("/")) return { ...next, slash: null };
  const matches = slashMatches(next);
  if (matches.length === 0) return { ...next, slash: null };
  const selected = Math.min(next.slash?.selected ?? 0, matches.length - 1);
  return { ...next, slash: { selected } };
};

/** Submit the active input: quick start on home, prompt or slash command on a thread. */
const submitInput = (
  model: Model,
  hub: WireHub,
  onQuit: () => void,
): readonly [Model, ReadonlyArray<Command.Command<Msg>>] => {
  const input = model.screen.kind === "home" ? model.homeInput : model.screen.kind === "thread" ? model.screen.input : "";
  const text = input.trim();
  if (text.length === 0) return [model, EMPTY_COMMANDS];

  if (model.screen.kind === "home") {
    return [{ ...model, homeInput: "" }, [cmd("quick-start", hub.quickStart(text))]];
  }
  if (model.screen.kind !== "thread") return [model, EMPTY_COMMANDS];

  const parsed = parseSlash(text);
  if (parsed.kind === "prompt") {
    return [
      { ...model, screen: { ...model.screen, input: "" } },
      [cmd("prompt", hub.sendPrompt(model.screen.threadId, text))],
    ];
  }
  if (parsed.kind === "unknown") {
    return [
      { ...model, screen: { ...model.screen, input: "" } },
      [
        cmd(
          "unknown-command",
          Effect.succeed({
            _tag: "WireError",
            message: `unknown command /${parsed.name}`,
          } satisfies Msg),
        ),
      ],
    ];
  }
  if (parsed.command.scope !== "any" && parsed.command.scope !== "thread") {
    return [
      { ...model, screen: { ...model.screen, input: "" } },
      [
        cmd(
          "out-of-scope",
          Effect.succeed({
            _tag: "WireError",
            message: `/${parsed.command.name} is only available on the ${parsed.command.scope} screen`,
          } satisfies Msg),
        ),
      ],
    ];
  }
  return [
    { ...model, screen: { ...model.screen, input: "" }, slash: null },
    [cmd(`slash-${parsed.command.name}`, parsed.command.run({ hub, model, onQuit }, parsed.args))],
  ];
};

/** Fill (and possibly submit) the slash menu's selected item. */
const slashActivate = (
  model: Model,
  hub: WireHub,
  onQuit: () => void,
  submit: boolean,
): readonly [Model, ReadonlyArray<Command.Command<Msg>>] => {
  const matches = slashMatches(model);
  const selected = matches[model.slash?.selected ?? 0];
  if (selected === undefined) return [model, EMPTY_COMMANDS];
  const fill = slashFill(model, selected);
  const next = withInput(model, fill.input);
  if (!submit || !fill.submit) return [next, EMPTY_COMMANDS];
  return submitInput({ ...next, slash: null }, hub, onQuit);
};

export const update = (
  model: Model,
  message: Msg,
  hub: WireHub,
  onQuit: () => void,
): readonly [Model, ReadonlyArray<Command.Command<Msg>>] => {
  switch (message._tag) {
    case "Boot":
      return [model, [cmd("hub-boot", hub.boot())]];
    case "Connected":
      return [{ ...model, connected: true }, EMPTY_COMMANDS];
    case "ConnectionLost":
      return [{ ...model, connected: false }, EMPTY_COMMANDS];
    case "Quit":
      return [model, EMPTY_COMMANDS];

    case "Threads": {
      const next = { ...model, pendingOpen: null };
      if (model.screen.kind === "list") {
        const screen: ListScreen = {
          ...model.screen,
          threads: message.threads,
          loading: false,
          selected: Math.min(model.screen.selected, Math.max(0, message.threads.length - 1)),
        };
        if (model.pendingOpen !== null) {
          const match = resolveThreadArg(message.threads, model.pendingOpen);
          if (match !== undefined) {
            return [
              { ...next, screen },
              [cmd("open-thread", hub.openThread(match.id))],
            ];
          }
          return [
            {
              ...next,
              screen,
              dialog: {
                kind: "confirm",
                title: "unknown thread",
                message: `no thread matches "${model.pendingOpen}"`,
                action: "ok",
              },
            },
            EMPTY_COMMANDS,
          ];
        }
        return [{ ...next, screen }, EMPTY_COMMANDS];
      }
      if (model.screen.kind === "home" && model.pendingOpen !== null) {
        const match = resolveThreadArg(message.threads, model.pendingOpen);
        if (match !== undefined) {
          return [{ ...next }, [cmd("open-thread", hub.openThread(match.id))]];
        }
        return [
          {
            ...next,
            dialog: {
              kind: "confirm",
              title: "unknown thread",
              message: `no thread matches "${model.pendingOpen}"`,
              action: "ok",
            },
          },
          EMPTY_COMMANDS,
        ];
      }
      return [model, EMPTY_COMMANDS];
    }

    case "ThreadChanged": {
      if (model.screen.kind === "thread" && model.screen.threadId === message.thread.id) {
        return [
          { ...model, screen: { ...model.screen, info: message.thread } },
          EMPTY_COMMANDS,
        ];
      }
      if (model.screen.kind === "list") {
        const threads = model.screen.threads.map((t) => (t.id === message.thread.id ? message.thread : t));
        return [{ ...model, screen: { ...model.screen, threads } }, EMPTY_COMMANDS];
      }
      return [model, EMPTY_COMMANDS];
    }

    case "ThreadOpened": {
      if (model.screen.kind !== "home" && model.screen.kind !== "list") return [model, EMPTY_COMMANDS];
      const screen: ThreadScreen = {
        kind: "thread",
        threadId: message.threadId,
        info: model.screen.kind === "list"
          ? model.screen.threads.find((t) => t.id === message.threadId) ?? {
              id: message.threadId,
              name: message.threadId,
              cwd: "",
              mode: "local",
              state: message.state.state,
              sessionId: message.state.sessionId,
              tailSeq: message.tailSeq,
            }
          : {
              id: message.threadId,
              name: message.threadId,
              cwd: "",
              mode: "local",
              state: message.state.state,
              sessionId: message.state.sessionId,
              tailSeq: message.tailSeq,
            },
        state: message.state,
        entries: message.entries,
        tailSeq: message.tailSeq,
        working: message.started || message.state.state === "working",
        liveText: "",
        input: "",
        scrollBack: 0,
        cameFrom: model.screen.kind,
        leafId: message.leafId,
      };
      return [{ ...model, screen, pendingOpen: null, slash: null, tree: null, escArm: null }, EMPTY_COMMANDS];
    }

    case "Entries": {
      if (model.screen.kind !== "thread" || model.screen.threadId !== message.threadId) {
        return [model, EMPTY_COMMANDS];
      }
      const screen = model.screen;
      const fresh = message.entries.filter((entry) => entry.seq > screen.tailSeq);
      if (fresh.length === 0) return [model, EMPTY_COMMANDS];
      return [
        {
          ...model,
          screen: {
            ...screen,
            entries: [...screen.entries, ...fresh],
            tailSeq: Math.max(screen.tailSeq, message.tailSeq),
          },
        },
        EMPTY_COMMANDS,
      ];
    }

    case "ThreadState": {
      if (model.screen.kind !== "thread" || model.screen.threadId !== message.threadId) {
        return [model, EMPTY_COMMANDS];
      }
      return [
        {
          ...model,
          screen: { ...model.screen, state: message.state, working: message.state.state === "working" },
        },
        EMPTY_COMMANDS,
      ];
    }

    case "Event": {
      if (model.screen.kind !== "thread" || model.screen.threadId !== message.threadId) {
        return [model, EMPTY_COMMANDS];
      }
      const screen = model.screen;
      switch (message.event.type) {
        case "entry_appended": {
          const entry = message.event.entry as Entry;
          if (entry.seq <= screen.tailSeq) return [model, EMPTY_COMMANDS];
          return [
            {
              ...model,
              screen: {
                ...screen,
                entries: [...screen.entries, entry],
                tailSeq: entry.seq,
                // Appends always advance the session's leaf.
                leafId: entry.id,
                scrollBack: 0,
              },
            },
            EMPTY_COMMANDS,
          ];
        }
        case "settled":
          return [{ ...model, screen: { ...screen, working: false, liveText: "" } }, EMPTY_COMMANDS];
        case "compaction_start":
          return [{ ...model, screen: { ...screen, working: true } }, EMPTY_COMMANDS];
        case "compaction_end":
          return [{ ...model, screen: { ...screen, working: false } }, EMPTY_COMMANDS];
        case "message_update": {
          const inner = message.event.assistantMessageEvent as
            | { type?: string; text?: string; errorMessage?: string }
            | undefined;
          if (inner === undefined) return [model, EMPTY_COMMANDS];
          if (inner.type === "text_delta" && typeof inner.text === "string") {
            return [{ ...model, screen: { ...screen, liveText: screen.liveText + inner.text } }, EMPTY_COMMANDS];
          }
          if (inner.type === "done" || inner.type === "error") {
            return [{ ...model, screen: { ...screen, liveText: "" } }, EMPTY_COMMANDS];
          }
          return [model, EMPTY_COMMANDS];
        }
        default:
          return [model, EMPTY_COMMANDS];
      }
    }

    case "WireError":
      return [
        { ...model, dialog: { kind: "confirm", title: "error", message: message.message, action: "ok" } },
        EMPTY_COMMANDS,
      ];

    case "BackToList":
      return refreshList(model, hub);

    case "GoHome":
      return [homeOf(model), EMPTY_COMMANDS];

    case "NewThreadDialog":
      return [
        {
          ...model,
          dialog: {
            kind: "input",
            title: "new thread",
            placeholder: "name",
            action: "create-thread",
            text: "",
          },
        },
        EMPTY_COMMANDS,
      ];

    case "Help":
      return [
        {
          ...model,
          dialog: {
            kind: "help",
            title: "commands",
            lines: slashCommands.map((c) => `/${c.name}${c.usage.length > 0 ? ` ${c.usage}` : ""} — ${c.description}`),
          },
        },
        EMPTY_COMMANDS,
      ];

    case "TreeOpen": {
      if (model.screen.kind !== "thread") return [model, EMPTY_COMMANDS];
      const thread = model.screen;
      if (thread.working || model.tree !== null || model.slash !== null) return [model, EMPTY_COMMANDS];
      const rows = treeRows(thread.entries, thread.leafId);
      const leafIndex = rows.findIndex((r) => r.id === thread.leafId);
      return [
        { ...model, tree: { selected: leafIndex >= 0 ? leafIndex : 0 }, escArm: null },
        EMPTY_COMMANDS,
      ];
    }

    case "TreeClose":
      return [{ ...model, tree: null, escArm: null }, EMPTY_COMMANDS];

    case "TreeJump": {
      if (model.screen.kind !== "thread" || model.tree === null || model.screen.working) {
        return [model, EMPTY_COMMANDS];
      }
      const rows = treeRows(model.screen.entries, model.screen.leafId);
      const row = rows[model.tree.selected];
      if (row === undefined) return [model, EMPTY_COMMANDS];
      return [model, [cmd("branch", hub.branch(model.screen.threadId, row.id))]];
    }

    case "BranchDone": {
      if (model.screen.kind !== "thread" || model.screen.threadId !== message.threadId) {
        return [model, EMPTY_COMMANDS];
      }
      return [
        {
          ...model,
          screen: { ...model.screen, leafId: message.leafId },
          tree: null,
          escArm: null,
        },
        EMPTY_COMMANDS,
      ];
    }

    case "CompactResult": {
      const summary = (message.result as { summary?: string }).summary;
      return [
        {
          ...model,
          dialog: {
            kind: "confirm",
            title: "compacted",
            message: summary === undefined ? "session compacted" : clip(summary, 240),
            action: "ok",
          },
        },
        EMPTY_COMMANDS,
      ];
    }

    case "Renamed":
      return [model, EMPTY_COMMANDS];

    case "PromptAccepted":
      if (model.screen.kind === "thread") {
        return [
          {
            ...model,
            screen: { ...model.screen, input: "", working: true, liveText: "" },
          },
          EMPTY_COMMANDS,
        ];
      }
      return [model, EMPTY_COMMANDS];

    case "ModelChanged":
      if (model.screen.kind === "thread" && model.screen.state !== null) {
        return [
          {
            ...model,
            screen: { ...model.screen, state: { ...model.screen.state, model: message.model } },
          },
          EMPTY_COMMANDS,
        ];
      }
      return [model, EMPTY_COMMANDS];

    case "ThinkingChanged":
      if (model.screen.kind === "thread" && model.screen.state !== null) {
        return [
          {
            ...model,
            screen: { ...model.screen, state: { ...model.screen.state, thinkingLevel: message.level } },
          },
          EMPTY_COMMANDS,
        ];
      }
      return [model, EMPTY_COMMANDS];

    case "Aborted":
      return [model, EMPTY_COMMANDS];

    case "Deleted": {
      if (model.screen.kind !== "list") return [model, EMPTY_COMMANDS];
      const threads = model.screen.threads.filter((t) => t.id !== message.id);
      return [
        {
          ...model,
          screen: { ...model.screen, threads, selected: Math.min(model.screen.selected, Math.max(0, threads.length - 1)) },
        },
        EMPTY_COMMANDS,
      ];
    }

    case "EscArm": {
      if (model.escArm === null || model.escArm.id !== message.id) return [model, EMPTY_COMMANDS];
      if (model.screen.kind !== "thread") return [{ ...model, escArm: null }, EMPTY_COMMANDS];
      if (model.screen.cameFrom === "home") return [homeOf(model), EMPTY_COMMANDS];
      return refreshList(model, hub);
    }

    case "DialogClose":
      return [{ ...model, dialog: null }, EMPTY_COMMANDS];

    case "DialogSubmit": {
      const dialog = model.dialog;
      if (dialog === null) return [model, EMPTY_COMMANDS];
      if (dialog.kind === "confirm" && dialog.action === "delete-thread") {
        const thread = model.screen.kind === "list" ? model.screen.threads[model.screen.selected] : undefined;
        if (thread === undefined) return [{ ...model, dialog: null }, EMPTY_COMMANDS];
        return [
          { ...model, dialog: null },
          [cmd("delete-thread", hub.deleteThread(thread.id))],
        ];
      }
      if (dialog.kind === "confirm" && dialog.action === "ok") {
        return [{ ...model, dialog: null }, EMPTY_COMMANDS];
      }
      if (dialog.kind === "input" && dialog.action === "create-thread") {
        const name = dialog.text.trim();
        if (name.length === 0) return [{ ...model, dialog: null }, EMPTY_COMMANDS];
        return [
          { ...model, dialog: null },
          [cmd("create-and-open", hub.createAndOpen(name, cwd))],
        ];
      }
      return [model, EMPTY_COMMANDS];
    }

    case "Key":
      return handleKey(model, message.key, message.mods, hub, onQuit);

    case "Paste": {
      if (model.dialog?.kind === "input") {
        return [
          { ...model, dialog: { ...model.dialog, text: model.dialog.text + message.text } },
          EMPTY_COMMANDS,
        ];
      }
      if (model.screen.kind === "home") {
        return [withInput(model, model.homeInput + message.text), EMPTY_COMMANDS];
      }
      if (model.screen.kind === "thread") {
        return [withInput(model, model.screen.input + message.text), EMPTY_COMMANDS];
      }
      return [model, EMPTY_COMMANDS];
    }
  }
};

const handleKey = (
  model: Model,
  key: string,
  mods: KeyboardModifiers,
  hub: WireHub,
  onQuit: () => void,
): readonly [Model, ReadonlyArray<Command.Command<Msg>>] => {
  // Ctrl+C always quits.
  if (mods.ctrlKey && key === "c") {
    return [model, [cmd("quit", Effect.sync(onQuit).pipe(Effect.as({ _tag: "Quit" } satisfies Msg)))]];
  }

  // Dialogs swallow every other key.
  if (model.dialog !== null) {
    return handleDialogKey(model, key, mods);
  }

  // The tree overlay swallows everything but its own keys.
  if (model.tree !== null) {
    return handleTreeKey(model, key);
  }

  const screen = model.screen;
  if (screen.kind === "home") return handleHomeKey(model, key, mods, hub, onQuit);
  if (screen.kind === "list") return handleListKey(model, screen, key, mods, hub, onQuit);
  return handleThreadKey(model, screen, key, mods, hub, onQuit);
};

const handleDialogKey = (
  model: Model,
  key: string,
  mods: KeyboardModifiers,
): readonly [Model, ReadonlyArray<Command.Command<Msg>>] => {
  const dialog = model.dialog;
  if (dialog === null) return [model, EMPTY_COMMANDS];

  if (dialog.kind === "help") {
    if (key === "escape" || key === "enter" || key === "space") return [{ ...model, dialog: null }, EMPTY_COMMANDS];
    return [model, EMPTY_COMMANDS];
  }

  if (key === "escape") return [{ ...model, dialog: null }, EMPTY_COMMANDS];

  if (dialog.kind === "confirm") {
    if (dialog.action === "ok") {
      if (key === "enter" || key === "space" || key === "y") return [{ ...model, dialog: null }, EMPTY_COMMANDS];
      return [model, EMPTY_COMMANDS];
    }
    if (key === "enter" || key === "y") return [model, [cmd("dialog-submit", Effect.succeed({ _tag: "DialogSubmit" } satisfies Msg))]];
    if (key === "n") return [{ ...model, dialog: null }, EMPTY_COMMANDS];
    return [model, EMPTY_COMMANDS];
  }

  // input dialog
  if (key === "enter") {
    return [model, [cmd("dialog-submit", Effect.succeed({ _tag: "DialogSubmit" } satisfies Msg))]];
  }
  if (key === "backspace") {
    return [{ ...model, dialog: { ...dialog, text: dialog.text.slice(0, -1) } }, EMPTY_COMMANDS];
  }
  if (key === "space") {
    return [{ ...model, dialog: { ...dialog, text: dialog.text + " " } }, EMPTY_COMMANDS];
  }
  if (key.length === 1 && !mods.ctrlKey && !mods.metaKey && !mods.altKey) {
    return [{ ...model, dialog: { ...dialog, text: dialog.text + key } }, EMPTY_COMMANDS];
  }
  return [model, EMPTY_COMMANDS];
};

const handleTreeKey = (
  model: Model,
  key: string,
): readonly [Model, ReadonlyArray<Command.Command<Msg>>] => {
  if (model.screen.kind !== "thread" || model.tree === null) return [model, EMPTY_COMMANDS];
  const rows = treeRows(model.screen.entries, model.screen.leafId);
  if (key === "up") {
    return [{ ...model, tree: { selected: Math.max(0, model.tree.selected - 1) } }, EMPTY_COMMANDS];
  }
  if (key === "down") {
    return [{ ...model, tree: { selected: Math.min(rows.length - 1, model.tree.selected + 1) } }, EMPTY_COMMANDS];
  }
  if (key === "enter" || key === "l") {
    return [model, [cmd("tree-jump", Effect.succeed({ _tag: "TreeJump" } satisfies Msg))]];
  }
  if (key === "escape") {
    return [{ ...model, tree: null, escArm: null }, EMPTY_COMMANDS];
  }
  return [model, EMPTY_COMMANDS];
};

const handleHomeKey = (
  model: Model,
  key: string,
  mods: KeyboardModifiers,
  hub: WireHub,
  onQuit: () => void,
): readonly [Model, ReadonlyArray<Command.Command<Msg>>] => {
  if (slashMenuOpen(model)) {
    if (key === "up") {
      const matches = slashMatches(model);
      const selected = Math.max(0, (model.slash?.selected ?? 0) - 1);
      return [{ ...model, slash: { selected: Math.min(selected, matches.length - 1) } }, EMPTY_COMMANDS];
    }
    if (key === "down") {
      const matches = slashMatches(model);
      const selected = Math.min(matches.length - 1, (model.slash?.selected ?? 0) + 1);
      return [{ ...model, slash: { selected } }, EMPTY_COMMANDS];
    }
    if (key === "tab") return slashActivate(model, hub, onQuit, false);
    if (key === "enter") return slashActivate(model, hub, onQuit, true);
    if (key === "escape") return [{ ...model, slash: null }, EMPTY_COMMANDS];
  }
  if (key === "enter") return submitInput(model, hub, onQuit);
  if (key === "l") return refreshList(model, hub);
  if (key === "n") {
    return [
      {
        ...model,
        dialog: {
          kind: "input",
          title: "new thread",
          placeholder: "name",
          action: "create-thread",
          text: "",
        },
      },
      EMPTY_COMMANDS,
    ];
  }
  if (key === "q") {
    return [model, [cmd("quit", Effect.sync(onQuit).pipe(Effect.as({ _tag: "Quit" } satisfies Msg)))]];
  }
  if (mods.ctrlKey && key === "u") return [{ ...model, homeInput: "", slash: null }, EMPTY_COMMANDS];
  if (key === "backspace") {
    return [withInput(model, model.homeInput.slice(0, -1)), EMPTY_COMMANDS];
  }
  if (key === "space") {
    return [withInput(model, model.homeInput + " "), EMPTY_COMMANDS];
  }
  if (key.length === 1 && !mods.ctrlKey && !mods.metaKey && !mods.altKey) {
    return [withInput(model, model.homeInput + key), EMPTY_COMMANDS];
  }
  return [model, EMPTY_COMMANDS];
};

const handleListKey = (
  model: Model,
  screen: ListScreen,
  key: string,
  mods: KeyboardModifiers,
  hub: WireHub,
  onQuit: () => void,
): readonly [Model, ReadonlyArray<Command.Command<Msg>>] => {
  if (key === "down" || key === "j") {
    const selected = Math.min(screen.selected + 1, Math.max(0, screen.threads.length - 1));
    return [{ ...model, screen: { ...screen, selected } }, EMPTY_COMMANDS];
  }
  if (key === "up" || key === "k") {
    return [{ ...model, screen: { ...screen, selected: Math.max(0, screen.selected - 1) } }, EMPTY_COMMANDS];
  }
  if (key === "enter" || key === "l") {
    const thread = screen.threads[screen.selected];
    if (thread === undefined) return [model, EMPTY_COMMANDS];
    return [model, [cmd("open-thread", hub.openThread(thread.id))]];
  }
  if (key === "n") {
    return [
      {
        ...model,
        dialog: {
          kind: "input",
          title: "new thread",
          placeholder: "name",
          action: "create-thread",
          text: "",
        },
      },
      EMPTY_COMMANDS,
    ];
  }
  if (key === "d") {
    const thread = screen.threads[screen.selected];
    if (thread === undefined) return [model, EMPTY_COMMANDS];
    return [
      {
        ...model,
        dialog: {
          kind: "confirm",
          title: "delete thread",
          message: `delete "${thread.name}" (${shortThreadId(thread.id)})?`,
          action: "delete-thread",
        },
      },
      EMPTY_COMMANDS,
    ];
  }
  if (key === "r") {
    return [model, [cmd("refresh", hub.refreshThreads())]];
  }
  if (key === "escape") {
    return [homeOf(model), EMPTY_COMMANDS];
  }
  if (key === "q") {
    return [model, [cmd("quit", Effect.sync(onQuit).pipe(Effect.as({ _tag: "Quit" } satisfies Msg)))]];
  }
  return [model, EMPTY_COMMANDS];
};

const handleThreadKey = (
  model: Model,
  screen: ThreadScreen,
  key: string,
  mods: KeyboardModifiers,
  hub: WireHub,
  onQuit: () => void,
): readonly [Model, ReadonlyArray<Command.Command<Msg>>] => {
  // Navigation with modifiers takes precedence over text input.
  if (mods.ctrlKey && key === "up") {
    return [{ ...model, screen: { ...screen, scrollBack: screen.scrollBack + 1 } }, EMPTY_COMMANDS];
  }
  if (mods.ctrlKey && key === "down") {
    return [{ ...model, screen: { ...screen, scrollBack: Math.max(0, screen.scrollBack - 1) } }, EMPTY_COMMANDS];
  }
  if (mods.ctrlKey && key === "l") {
    return [{ ...model, screen: { ...screen, scrollBack: 0 } }, EMPTY_COMMANDS];
  }

  if (key === "escape") {
    if (model.slash !== null) return [{ ...model, slash: null }, EMPTY_COMMANDS];
    // Double-esc opens the tree (pi's habit); a single esc leaves after the
    // arm window. While working there is no tree, so esc leaves at once.
    if (model.escArm !== null && !screen.working) {
      return [{ ...model, escArm: null }, [cmd("tree-open", Effect.succeed({ _tag: "TreeOpen" } satisfies Msg))]];
    }
    if (screen.working) {
      if (screen.cameFrom === "home") return [homeOf(model), EMPTY_COMMANDS];
      return refreshList(model, hub);
    }
    const id = ++escArmSeq;
    return [
      { ...model, escArm: { id } },
      [
        cmd(
          "esc-arm",
          Effect.sleep(`${DOUBLE_ESC_MS} millis`).pipe(Effect.as({ _tag: "EscArm", id } satisfies Msg)),
        ),
      ],
    ];
  }

  if (slashMenuOpen(model)) {
    if (key === "up") {
      const matches = slashMatches(model);
      const selected = Math.max(0, (model.slash?.selected ?? 0) - 1);
      return [{ ...model, slash: { selected: Math.min(selected, matches.length - 1) } }, EMPTY_COMMANDS];
    }
    if (key === "down") {
      const matches = slashMatches(model);
      const selected = Math.min(matches.length - 1, (model.slash?.selected ?? 0) + 1);
      return [{ ...model, slash: { selected } }, EMPTY_COMMANDS];
    }
    if (key === "tab") return slashActivate(model, hub, onQuit, false);
    if (key === "enter") return slashActivate(model, hub, onQuit, true);
  } else {
    if (key === "enter") {
      const text = screen.input.trim();
      if (text.length === 0) return [model, EMPTY_COMMANDS];
      return [model, [cmd("prompt", hub.sendPrompt(screen.threadId, text))]];
    }
    // Modal keys only while the input is empty — typing `m`/`t` must work
    // (slash commands like /model and /tree depend on it).
    if (key === "m" && screen.input.length === 0) {
      return [model, [cmd("cycle-model", hub.cycleModel(screen.threadId))]];
    }
    if (key === "t" && screen.input.length === 0) {
      return [model, [cmd("cycle-thinking", hub.cycleThinkingLevel(screen.threadId))]];
    }
    if (mods.ctrlKey && key === "d") {
      return [model, [cmd("abort", hub.abortRun(screen.threadId))]];
    }
    if (mods.ctrlKey && key === "u") {
      return [{ ...model, screen: { ...screen, input: "" }, slash: null }, EMPTY_COMMANDS];
    }
  }

  if (key === "backspace") {
    return [withInput(model, screen.input.slice(0, -1)), EMPTY_COMMANDS];
  }
  if (key === "space") {
    return [withInput(model, screen.input + " "), EMPTY_COMMANDS];
  }
  if (key.length === 1 && !mods.ctrlKey && !mods.metaKey && !mods.altKey) {
    return [withInput(model, screen.input + key), EMPTY_COMMANDS];
  }
  return [model, EMPTY_COMMANDS];
};

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

const resolveThreadArg = (threads: ReadonlyArray<ThreadInfo>, arg: string): ThreadInfo | undefined => {
  const exact = threads.find((t) => t.id === arg || t.name === arg);
  if (exact !== undefined) return exact;
  const prefixes = threads.filter((t) => t.id.startsWith(arg));
  return prefixes.length === 1 ? prefixes[0] : undefined;
};

const listRow = (h: HtmlBuilder<Msg>, thread: ThreadInfo, selected: boolean) =>
  h.div(
    [
      h.Style({
        flexDirection: "row",
        gap: "1",
        padding: "0 1",
        backgroundColor: selected ? rose.overlay : "transparent",
      }),
    ],
    [
      h.span([h.Style({ color: selected ? rose.gold : rose.muted, width: "9" })], [shortThreadId(thread.id)]),
      h.span([h.Style({ color: rose.text, width: "24", flexShrink: "0" })], [thread.name]),
      h.span([h.Style({ color: rose.foam, width: "9" })], [thread.mode]),
      h.span([h.Style({ color: thread.state === "working" ? rose.gold : rose.muted, width: "12" })], [thread.state]),
      h.span([h.Style({ color: rose.muted, flexGrow: "1" })], [thread.cwd]),
    ],
  );

const listView = (h: HtmlBuilder<Msg>, screen: ListScreen) => {
  const rows: Array<ReturnType<typeof h.div>> = [];
  if (screen.loading) {
    rows.push(h.p([h.Style({ color: rose.muted })], ["loading threads…"]));
  } else if (screen.threads.length === 0) {
    rows.push(h.p([h.Style({ color: rose.muted })], ["no threads — press n to create one"]));
  } else {
    for (let i = 0; i < screen.threads.length; i++) {
      rows.push(listRow(h, screen.threads[i]!, i === screen.selected));
    }
  }
  return rows;
};

const entryView = (h: HtmlBuilder<Msg>, entry: Entry) => {
  const line = entryLine(entry);
  return h.p([h.Style({ color: line.dim ? rose.muted : rose.text, margin: "0" })], [line.text]);
};

const slashMenuView = (h: HtmlBuilder<Msg>, model: Model) => {
  const matches = slashMatches(model);
  const selected = model.slash?.selected ?? 0;
  const nodes: Array<ReturnType<typeof h.div>> = [];
  for (let i = 0; i < matches.length; i++) {
    const command = matches[i]!;
    const isSelected = i === selected;
    nodes.push(
      h.div(
        [h.Style({ flexDirection: "row", gap: "1", padding: "0 1", backgroundColor: isSelected ? rose.overlay : "transparent" })],
        [
          h.span([h.Style({ color: isSelected ? rose.gold : rose.foam, width: "18", flexShrink: "0" })], [`/${command.name} ${command.usage}`.trim()]),
          h.span([h.Style({ color: rose.muted, flexGrow: "1" })], [command.description]),
        ],
      ),
    );
  }
  return nodes;
};

const inputBox = (h: HtmlBuilder<Msg>, text: string) =>
  h.div(
    [h.Style({ flexDirection: "row", gap: "1", padding: "0 1", backgroundColor: rose.surface })],
    [
      h.span([h.Style({ color: rose.foam })], ["❯"]),
      h.span([h.Style({ color: rose.text, flexGrow: "1" })], [text.length > 0 ? text : " "]),
      h.span([h.Style({ color: rose.gold })], ["▌"]),
    ],
  );

const homeView = (h: HtmlBuilder<Msg>, model: Model) => {
  const nodes: Array<ReturnType<typeof h.div> | ReturnType<typeof h.p>> = [];
  nodes.push(h.p([h.Style({ color: rose.iris })], ["saku"]));
  nodes.push(
    h.p([h.Style({ color: rose.muted })], [
      "enter to start a thread · l list · n new · / commands · q quit",
    ]),
  );
  nodes.push(h.p([h.Style({ color: rose.muted })], [cwd]));
  if (slashMenuOpen(model)) {
    nodes.push(...slashMenuView(h, model));
  }
  nodes.push(inputBox(h, model.homeInput));
  return nodes;
};

const treePanel = (h: HtmlBuilder<Msg>, screen: ThreadScreen, tree: TreeOverlay) => {
  const rows = treeRows(screen.entries, screen.leafId);
  const windowSize = 16;
  const start = Math.max(0, Math.min(tree.selected - Math.floor(windowSize / 2), Math.max(0, rows.length - windowSize)));
  const end = Math.min(rows.length, start + windowSize);

  const nodes: Array<ReturnType<typeof h.div>> = [];
  nodes.push(
    h.div(
      [h.Style({ flexDirection: "row", gap: "1", padding: "0 1", backgroundColor: rose.overlay })],
      [
        h.span([h.Style({ color: rose.iris, flexGrow: "1" })], ["session tree — jump to a message"]),
        h.span([h.Style({ color: rose.muted })], ["↑/↓ move · enter jump · esc close"]),
      ],
    ),
  );
  for (let i = start; i < end; i++) {
    const row = rows[i]!;
    const selected = i === tree.selected;
    nodes.push(
      h.div(
        [
          h.Style({
            flexDirection: "row",
            padding: "0 1",
            backgroundColor: selected ? rose.overlay : "transparent",
          }),
        ],
        [
          h.span([h.Style({ color: selected ? rose.gold : rose.muted, flexShrink: "0" })], [row.prefix]),
          h.span(
            [
              h.Style({
                color: selected ? rose.gold : row.onPath ? rose.foam : row.dim ? rose.muted : rose.text,
                flexGrow: "1",
              }),
            ],
            [`${row.onPath ? "• " : ""}${row.text}`],
          ),
        ],
      ),
    );
  }
  if (rows.length === 0) {
    nodes.push(h.p([h.Style({ color: rose.muted, margin: "0" })], ["no entries yet"]));
  }
  return nodes;
};

const threadView = (h: HtmlBuilder<Msg>, model: Model, screen: ThreadScreen, tree: TreeOverlay | null) => {
  const nodes: Array<ReturnType<typeof h.div> | ReturnType<typeof h.p>> = [];

  const state = screen.state;
  const modelInfo = state?.model ?? null;
  const modelLabel = modelInfo === null ? "no model" : `${modelInfo.provider}/${modelInfo.id}`;

  nodes.push(
    h.p(
      [h.Style({ color: rose.iris })],
      [
        `${screen.info.name} · ${shortThreadId(screen.threadId)} · `,
      ],
    ),
  );
  nodes.push(
    h.p(
      [h.Style({ color: rose.muted, fontSize: "1" })],
      [
        `${screen.info.cwd}  ${screen.working ? "● working" : "○ idle"}  ${modelLabel}  thinking:${state?.thinkingLevel ?? "off"}`,
      ],
    ),
  );

  if (tree !== null) {
    nodes.push(...treePanel(h, screen, tree));
    return nodes;
  }

  const start = Math.max(0, screen.entries.length - visibleLines - screen.scrollBack);
  const end = start + visibleLines;
  if (screen.scrollBack > 0) {
    nodes.push(h.p([h.Style({ color: rose.gold })], [`▲ ${screen.scrollBack} lines back (ctrl+l to tail)`]));
  }
  for (let i = start; i < end && i < screen.entries.length; i++) {
    nodes.push(entryView(h, screen.entries[i]!));
  }
  if (screen.entries.length === 0) {
    nodes.push(h.p([h.Style({ color: rose.muted })], ["no entries yet — type a prompt below"]));
  }
  if (screen.working && screen.liveText.length > 0) {
    nodes.push(h.p([h.Style({ color: rose.foam })], [`… ${clip(screen.liveText, 160)}`]));
  }

  if (slashMenuOpen(model)) {
    nodes.push(...slashMenuView(h, model));
  }
  nodes.push(inputBox(h, screen.input));
  nodes.push(
    h.p(
      [h.Style({ color: rose.muted })],
      [
        "enter send · ctrl+d abort · m/t model·thinking (empty input) · esc esc tree · / commands · ctrl+↑/↓ scroll · ctrl+l tail",
      ],
    ),
  );

  return nodes;
};

const dialogView = (h: HtmlBuilder<Msg>, dialog: Dialog) => {
  const title = h.p([h.Style({ color: rose.love, margin: "0" })], [dialog.title]);
  if (dialog.kind === "confirm") {
    return [
      h.div(
        [h.Style({ flexDirection: "column", gap: "1", padding: "1", backgroundColor: rose.overlay })],
        [
          title,
          h.p([h.Style({ color: rose.text, margin: "0" })], [dialog.message]),
          h.p([h.Style({ color: rose.muted, margin: "0" })], ["[enter] confirm   [esc] cancel"]),
        ],
      ),
    ];
  }
  if (dialog.kind === "help") {
    return [
      h.div(
        [h.Style({ flexDirection: "column", gap: "1", padding: "1", backgroundColor: rose.overlay })],
        [
          title,
          ...dialog.lines.map((line) => h.p([h.Style({ color: rose.text, margin: "0" })], [line])),
          h.p([h.Style({ color: rose.muted, margin: "0" })], ["[enter] close"]),
        ],
      ),
    ];
  }
  return [
    h.div(
      [h.Style({ flexDirection: "column", gap: "1", padding: "1", backgroundColor: rose.overlay })],
      [
        title,
        h.div(
          [h.Style({ flexDirection: "row", gap: "1" })],
          [
            h.span([h.Style({ color: rose.foam })], ["❯"]),
            h.span([h.Style({ color: rose.text, flexGrow: "1" })], [dialog.text.length > 0 ? dialog.text : dialog.placeholder]),
          ],
        ),
        h.p([h.Style({ color: rose.muted, margin: "0" })], ["[enter] create   [esc] cancel"]),
      ],
    ),
  ];
};

export const view = (model: Model, h: HtmlBuilder<Msg>) => {
  const body: Array<ReturnType<typeof h.div> | ReturnType<typeof h.p>> = [];

  if (model.screen.kind === "home") {
    body.push(...homeView(h, model));
  } else if (model.screen.kind === "list") {
    body.push(h.p([h.Style({ color: rose.iris })], ["saku — threads"]));
    body.push(...listView(h, model.screen));
  } else {
    body.push(...threadView(h, model, model.screen, model.tree));
  }

  if (model.dialog !== null) {
    body.push(...dialogView(h, model.dialog));
  }

  const conn = model.connected ? h.span([h.Style({ color: rose.foam })], ["●"]) : h.span([h.Style({ color: rose.muted })], ["○"]);
  const hints =
    model.screen.kind === "home"
      ? "enter start · l list · n new · / commands"
      : model.screen.kind === "list"
        ? "j/k move · enter open · n new · d delete · r refresh · esc home"
        : "enter send · ctrl+d abort · m/t model·thinking · esc esc tree · / commands";
  body.push(
    h.div(
      [h.Style({ flexDirection: "row", gap: "1", marginTop: "auto", paddingTop: "1" })],
      [
        conn,
        h.span([h.Style({ color: rose.muted })], ["saku"]),
        h.span([h.Style({ color: rose.muted, flexGrow: "1" })], [hints]),
      ],
    ),
  );

  return {
    title: "saku",
    body: h.div(
      [
        h.Style({
          flexGrow: "1",
          flexDirection: "column",
          gap: "1",
          padding: "1",
          backgroundColor: rose.base,
        }),
        h.OnKeyDown((key, mods) => ({ _tag: "Key", key, mods } satisfies Msg)),
      ],
      body,
    ),
  };
};

// ---------------------------------------------------------------------------
// Application
// ---------------------------------------------------------------------------

export const makeApp = (
  initialThread: string | undefined,
  onQuit: () => void,
): {
  readonly init: () => readonly [Model, ReadonlyArray<Command.Command<Msg>>];
  readonly update: (
    model: Model,
    message: Msg,
  ) => readonly [Model, ReadonlyArray<Command.Command<Msg>>];
  readonly view: (model: Model, h: HtmlBuilder<Msg>) => ReturnType<typeof view>;
  readonly subscribe: (dispatch: (message: Msg) => void) => () => void;
} => {
  const hub = new WireHub(
    (message) => dispatchRef.current?.(message),
    initialThread ?? null,
  );
  const dispatchRef: { current: ((message: Msg) => void) | null } = { current: null };

  return {
    init: (): readonly [Model, ReadonlyArray<Command.Command<Msg>>] => [
      {
        screen: { kind: "home" },
        dialog: null,
        tree: null,
        slash: null,
        homeInput: "",
        pendingOpen: initialThread ?? null,
        escArm: null,
        connected: false,
      },
      [cmd("boot", Effect.succeed({ _tag: "Boot" } satisfies Msg))],
    ],
    update: (model, message) => update(model, message, hub, onQuit),
    view,
    subscribe: (dispatch) => {
      dispatchRef.current = dispatch;
      return () => {
        dispatchRef.current = null;
        hub.shutdown();
      };
    },
  };
};
