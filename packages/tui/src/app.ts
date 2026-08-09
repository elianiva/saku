/**
 * The saku TUI: a foldkit TEA application rendered by foldtui.
 *
 * Two screens — the thread list and the thread view — plus modal dialogs
 * (confirm / input) and a status bar. All keyboard input arrives through a
 * single root-level `OnKeyDown`; the wire lives behind `WireHub`, whose
 * events enter the loop as ordinary messages.
 */

import { Effect } from "effect";
import type { Command } from "foldkit";
import type { HtmlBuilder, KeyboardModifiers } from "foldkit/html";

import {
  shortThreadId,
  type Entry,
  type SessionWireEvent,
  type ThreadInfo,
  type ThreadSessionState,
  type ThinkingLevel,
  type WireModelInfo,
} from "@saku/wire";

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
  | { readonly _tag: "Created"; readonly thread: ThreadInfo }
  | { readonly _tag: "Deleted"; readonly id: string }
  | { readonly _tag: "DialogClose" }
  | { readonly _tag: "DialogSubmit" }
  | { readonly _tag: "BackToList" }
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
    };

export interface ListScreen {
  readonly kind: "list";
  readonly threads: ReadonlyArray<ThreadInfo>;
  readonly selected: number;
  readonly loading: boolean;
  /** Thread to auto-open once the list loads (`saku open <id>`). */
  readonly pendingOpen: string | null;
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
}

export interface Model {
  readonly screen: ListScreen | ThreadScreen;
  readonly dialog: Dialog | null;
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
// Update
// ---------------------------------------------------------------------------

const EMPTY_COMMANDS: ReadonlyArray<Command.Command<Msg>> = [];

const cwd = process.cwd();

const visibleLines = 18;

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
      const screen = model.screen;
      if (screen.kind !== "list") return [model, EMPTY_COMMANDS];
      const next: ListScreen = {
        ...screen,
        threads: message.threads,
        loading: false,
        selected: Math.min(screen.selected, Math.max(0, message.threads.length - 1)),
      };
      if (next.pendingOpen !== null) {
        const match = resolveThreadArg(message.threads, next.pendingOpen);
        if (match !== undefined) {
          return [
            { ...model, screen: { ...next, pendingOpen: null } },
            [cmd("open-thread", hub.openThread(match.id))],
          ];
        }
        return [
          {
            ...model,
            screen: { ...next, pendingOpen: null },
            dialog: {
              kind: "confirm",
              title: "unknown thread",
              message: `no thread matches "${next.pendingOpen}"`,
              action: "ok",
            },
          },
          EMPTY_COMMANDS,
        ];
      }
      return [{ ...model, screen: next }, EMPTY_COMMANDS];
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
      if (model.screen.kind !== "list") return [model, EMPTY_COMMANDS];
      const screen: ThreadScreen = {
        kind: "thread",
        threadId: message.threadId,
        info: model.screen.threads.find((t) => t.id === message.threadId) ?? {
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
        working: message.state.state === "working",
        liveText: "",
        input: "",
        scrollBack: 0,
      };
      return [{ ...model, screen }, EMPTY_COMMANDS];
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
      return [
        {
          ...model,
          screen: { kind: "list", threads: [], selected: 0, loading: true, pendingOpen: null },
        },
        [cmd("refresh", hub.refreshThreads())],
      ];

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
    case "Created":
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
          [cmd("create-thread", hub.createThread(name, cwd))],
        ];
      }
      return [model, EMPTY_COMMANDS];
    }

    case "Created":
      return [model, EMPTY_COMMANDS];

    case "Key":
      return handleKey(model, message.key, message.mods, hub, onQuit);

    case "Paste": {
      if (model.dialog?.kind === "input") {
        return [
          { ...model, dialog: { ...model.dialog, text: model.dialog.text + message.text } },
          EMPTY_COMMANDS,
        ];
      }
      if (model.screen.kind === "thread") {
        return [
          { ...model, screen: { ...model.screen, input: model.screen.input + message.text } },
          EMPTY_COMMANDS,
        ];
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

  const screen = model.screen;
  if (screen.kind === "list") return handleListKey(model, screen, key, mods, hub, onQuit);
  return handleThreadKey(model, screen, key, mods, hub);
};

const handleDialogKey = (
  model: Model,
  key: string,
  mods: KeyboardModifiers,
): readonly [Model, ReadonlyArray<Command.Command<Msg>>] => {
  const dialog = model.dialog;
  if (dialog === null) return [model, EMPTY_COMMANDS];

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
    return [model, [cmd("back-to-list", Effect.succeed({ _tag: "BackToList" } satisfies Msg))]];
  }
  if (key === "enter") {
    const text = screen.input.trim();
    if (text.length === 0) return [model, EMPTY_COMMANDS];
    return [model, [cmd("prompt", hub.sendPrompt(screen.threadId, text))]];
  }
  if (mods.ctrlKey && key === "d") {
    return [model, [cmd("abort", hub.abortRun(screen.threadId))]];
  }
  if (mods.ctrlKey && key === "u") {
    return [{ ...model, screen: { ...screen, input: "" } }, EMPTY_COMMANDS];
  }
  if (key === "m") {
    return [model, [cmd("cycle-model", hub.cycleModel(screen.threadId))]];
  }
  if (key === "t") {
    return [model, [cmd("cycle-thinking", hub.cycleThinking(screen.threadId))]];
  }
  if (key === "backspace") {
    return [{ ...model, screen: { ...screen, input: screen.input.slice(0, -1) } }, EMPTY_COMMANDS];
  }
  if (key === "space") {
    return [{ ...model, screen: { ...screen, input: screen.input + " " } }, EMPTY_COMMANDS];
  }
  if (key.length === 1 && !mods.ctrlKey && !mods.metaKey && !mods.altKey) {
    return [{ ...model, screen: { ...screen, input: screen.input + key } }, EMPTY_COMMANDS];
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

const threadView = (h: HtmlBuilder<Msg>, screen: ThreadScreen) => {
  const nodes: Array<ReturnType<typeof h.div> | ReturnType<typeof h.p>> = [];

  const state = screen.state;
  const model = state?.model ?? null;
  const modelLabel = model === null ? "no model" : `${model.provider}/${model.id}`;

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

  // Input box
  nodes.push(
    h.div(
      [h.Style({ flexDirection: "row", gap: "1", padding: "0 1", backgroundColor: rose.surface })],
      [
        h.span([h.Style({ color: rose.foam })], ["❯"]),
        h.span([h.Style({ color: rose.text, flexGrow: "1" })], [screen.input.length > 0 ? screen.input : " "]),
        h.span([h.Style({ color: rose.gold })], ["▌"]),
      ],
    ),
  );
  nodes.push(
    h.p(
      [h.Style({ color: rose.muted })],
      [
        "enter send · ctrl+d abort · m model · t thinking · ctrl+↑/↓ scroll · ctrl+l tail · esc back",
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

  if (model.screen.kind === "list") {
    body.push(h.p([h.Style({ color: rose.iris })], ["saku — threads"]));
    body.push(...listView(h, model.screen));
  } else {
    body.push(...threadView(h, model.screen));
  }

  if (model.dialog !== null) {
    body.push(...dialogView(h, model.dialog));
  }

  const conn = model.connected ? h.span([h.Style({ color: rose.foam })], ["●"]) : h.span([h.Style({ color: rose.muted })], ["○"]);
  body.push(
    h.div(
      [h.Style({ flexDirection: "row", gap: "1", marginTop: "auto", paddingTop: "1" })],
      [
        conn,
        h.span([h.Style({ color: rose.muted })], ["saku"]),
        h.span([h.Style({ color: rose.muted, flexGrow: "1" })], [
          model.screen.kind === "list" ? "j/k move · enter open · n new · d delete · r refresh · q quit" : "",
        ]),
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
        screen: {
          kind: "list",
          threads: [],
          selected: 0,
          loading: true,
          pendingOpen: initialThread ?? null,
        },
        dialog: null,
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
