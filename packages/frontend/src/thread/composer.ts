/**
 * The Lexical composer adapter (composer.ts): the one imperative seam in the
 * thread pane. Foldkit owns the Model, Messages, suggestion panel, and
 * Commands; this module owns only the lifecycle of Lexical's contenteditable
 * and translates its events into those Messages.
 *
 * The Mount is deliberately framework-agnostic. Lexical keeps its own editor
 * state instead of being forced through Foldkit's VDOM on every keystroke,
 * while the runtime still sees focus, text, trigger, keyboard, and lifecycle
 * events. Commands are the other direction: Foldkit asks the mounted editor to
 * clear, replace a trigger, insert a file token, or change editability.
 */

import { Effect, Queue, Schema as S, Stream } from "effect";
import { Command, Mount } from "foldkit";
import { registerRichText } from "@lexical/rich-text";
import {
  $createParagraphNode,
  $generateNodesFromRawText,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  BLUR_COMMAND,
  COMMAND_PRIORITY_HIGH,
  FOCUS_COMMAND,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_UP_COMMAND,
  KEY_ENTER_COMMAND,
  KEY_ESCAPE_COMMAND,
  createEditor,
  TextNode,
  type EditorConfig,
  type LexicalEditor,
} from "lexical";

import {
  ComposerChanged,
  ComposerCleared,
  ComposerEditableChanged,
  ComposerFocused,
  ComposerBlurred,
  ComposerMenuClosed,
  ComposerMenuMoved,
  ComposerSuggestionAccepted,
  ComposerSuggestionInserted,
  ComposerTriggerChanged,
  ComposerTriggerRemoved,
  SendRequested,
} from "./message.ts";
import { composerSuggestions, type ComposerTrigger } from "./composer/options.ts";

export const ComposerKind = S.Literals(["welcome", "thread"]);
type ComposerKind = S.Schema.Type<typeof ComposerKind>;

/** A file reference is an inline token rather than a second markup language.
 * Its text content remains `@path`, so prompts sent over the existing wire
 * stay plain text-compatible while the editor can later attach richer file
 * metadata without changing the composer seam. */
type TriggerMatch = {
  readonly trigger: ComposerTrigger;
  readonly query: string;
  readonly node: TextNode;
  readonly start: number;
  readonly end: number;
};

export class FileMentionNode extends TextNode {
  $config() {
    return this.config("saku-file-mention", { extends: TextNode });
  }

  createDOM(config: EditorConfig, editor?: LexicalEditor) {
    const dom = super.createDOM(config, editor);
    dom.classList.add("saku-composer-file-mention");
    dom.dataset.sakuFileMention = this.getTextContent();
    return dom;
  }

  updateDOM(prevNode: this, dom: HTMLElement, config: EditorConfig) {
    const replaced = super.updateDOM(prevNode, dom, config);
    dom.classList.add("saku-composer-file-mention");
    dom.dataset.sakuFileMention = this.getTextContent();
    return replaced;
  }
}

const editors = new Map<ComposerKind, LexicalEditor>();

const activeEditor = (kind: ComposerKind) => editors.get(kind);

const triggerFromSelection = () => {
  const selection = $getSelection();
  if (!$isRangeSelection(selection) || !selection.isCollapsed()) return null;
  if (selection.anchor.type !== "text") return null;
  const node = selection.anchor.getNode();
  const beforeCaret = node.getTextContent().slice(0, selection.anchor.offset);
  const match = /(^|\s)([@/])([^\s]*)$/.exec(beforeCaret);
  if (match === null) return null;
  const symbol = match[2];
  if (symbol !== "@" && symbol !== "/") return null;
  const precedingSpace = match[1] ?? "";
  return {
    trigger: symbol === "@" ? ("file" as const) : ("command" as const),
    query: match[3] ?? "",
    node,
    start: match.index + precedingSpace.length,
    end: selection.anchor.offset,
  };
};

const triggerKey = (trigger: TriggerMatch | null) =>
  trigger === null ? "" : `${trigger.trigger}:${trigger.query}`;

const replaceActiveTrigger = (
  editor: LexicalEditor,
  expected: ComposerTrigger,
  replacement: string,
) => {
  editor.update(() => {
    const selection = $getSelection();
    const trigger = triggerFromSelection();
    if (
      !$isRangeSelection(selection) ||
      trigger === null ||
      trigger.trigger !== expected
    )
      return;
    selection.setTextNodeRange(trigger.node, trigger.start, trigger.node, trigger.end);
    selection.removeText();
    if (replacement !== "") selection.insertText(replacement);
  });
};

const insertFileMention = (editor: LexicalEditor, path: string) => {
  editor.update(() => {
    const selection = $getSelection();
    const trigger = triggerFromSelection();
    if (!$isRangeSelection(selection) || trigger === null || trigger.trigger !== "file") return;
    selection.setTextNodeRange(trigger.node, trigger.start, trigger.node, trigger.end);
    selection.removeText();
    const mention = new FileMentionNode(`@${path}`);
    selection.insertNodes([mention]);
    mention.setMode("token");
    selection.insertText(" ");
  });
};

const clearEditor = (editor: LexicalEditor) => {
  editor.update(() => {
    const root = $getRoot();
    root.clear();
    const paragraph = $createParagraphNode();
    root.append(paragraph);
    paragraph.selectEnd();
  });
};

/** A Foldkit Mount definition for Lexical. The editor instance is created
 * inside acquire so its root, listeners, and custom nodes are all released as
 * one lifecycle resource when the VDOM element leaves the document. */
export const ComposerMount = Mount.defineStream(
  "ComposerLexical",
  {
    kind: ComposerKind,
    initialText: S.String,
    placeholder: S.String,
    editable: S.Boolean,
    autofocus: S.Boolean,
  },
  ComposerChanged,
  ComposerTriggerChanged,
  ComposerMenuClosed,
  ComposerMenuMoved,
  ComposerSuggestionAccepted,
  ComposerFocused,
  ComposerBlurred,
  SendRequested,
)((args) => (element) =>
  Stream.callback((queue) =>
    Effect.gen(function* () {
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          const root = element as HTMLElement;
          const editor = createEditor({
            namespace: `SakuComposer:${args.kind}`,
            nodes: [FileMentionNode],
            editable: args.editable,
            theme: {
              paragraph: "saku-composer-paragraph",
              text: { base: "saku-composer-text" },
            },
            onError: (error) => {
              Effect.runFork(Effect.logError("[saku composer] Lexical error", error));
            },
          });

          root.setAttribute("data-saku-composer", args.kind);
          root.setAttribute("role", "textbox");
          root.setAttribute("aria-multiline", "true");
          root.setAttribute("aria-placeholder", args.placeholder);
          root.contentEditable = String(args.editable);
          editor.setRootElement(root);

          editor.update(
            () => {
              const documentRoot = $getRoot();
              documentRoot.clear();
              const paragraph = $createParagraphNode();
              paragraph.append(...$generateNodesFromRawText(args.initialText));
              documentRoot.append(paragraph);
              paragraph.selectEnd();
            },
            { discrete: true },
          );

          let lastTriggerKey = editor.getEditorState().read(() =>
            triggerKey(triggerFromSelection()),
          );
          // The core `lexical` package only dispatches the editing commands
          // (keydown, beforeinput, …); the actual text-editing behavior —
          // inserting controlled input, backspace/delete, Enter/paragraph
          // breaks, paste — lives in @lexical/rich-text's registerRichText.
          // Without it a bare editor drops every keystroke: the beforeinput
          // handler prevents the native insertion and the controlled
          // insertion command has no listener to carry it out.
          const listeners = [
            registerRichText(editor),
            editor.registerTextContentListener((text) => {
              Queue.offerUnsafe(queue, ComposerChanged({ text }));
            }),
            editor.registerUpdateListener(({ editorState }) => {
              const trigger = editorState.read(() => triggerFromSelection());
              const nextKey = triggerKey(trigger);
              if (nextKey === lastTriggerKey) return;
              lastTriggerKey = nextKey;
              Queue.offerUnsafe(
                queue,
                trigger === null
                  ? ComposerMenuClosed()
                  : ComposerTriggerChanged({ trigger: trigger.trigger, query: trigger.query }),
              );
            }),
            editor.registerCommand(
              FOCUS_COMMAND,
              () => {
                Queue.offerUnsafe(queue, ComposerFocused());
                return false;
              },
              COMMAND_PRIORITY_HIGH,
            ),
            editor.registerCommand(
              BLUR_COMMAND,
              () => {
                Queue.offerUnsafe(queue, ComposerBlurred());
                return false;
              },
              COMMAND_PRIORITY_HIGH,
            ),
            editor.registerCommand(
              KEY_ARROW_DOWN_COMMAND,
              (event) => {
                if (triggerFromSelection() === null) return false;
                event.preventDefault();
                Queue.offerUnsafe(queue, ComposerMenuMoved({ delta: 1 }));
                return true;
              },
              COMMAND_PRIORITY_HIGH,
            ),
            editor.registerCommand(
              KEY_ARROW_UP_COMMAND,
              (event) => {
                if (triggerFromSelection() === null) return false;
                event.preventDefault();
                Queue.offerUnsafe(queue, ComposerMenuMoved({ delta: -1 }));
                return true;
              },
              COMMAND_PRIORITY_HIGH,
            ),
            editor.registerCommand(
              KEY_ESCAPE_COMMAND,
              (event) => {
                if (triggerFromSelection() === null) return false;
                event.preventDefault();
                Queue.offerUnsafe(queue, ComposerMenuClosed());
                return true;
              },
              COMMAND_PRIORITY_HIGH,
            ),
            editor.registerCommand(
              KEY_ENTER_COMMAND,
              (event) => {
                const trigger = triggerFromSelection();
                if (
                  trigger !== null &&
                  composerSuggestions(trigger.trigger, trigger.query, args.kind === "thread").length > 0
                ) {
                  event?.preventDefault();
                  Queue.offerUnsafe(queue, ComposerSuggestionAccepted());
                  return true;
                }
                if (event === null) return false;
                event.preventDefault();
                if (event.shiftKey) {
                  const selection = $getSelection();
                  if ($isRangeSelection(selection)) selection.insertLineBreak();
                  return true;
                }
                Queue.offerUnsafe(queue, SendRequested());
                return true;
              },
              COMMAND_PRIORITY_HIGH,
            ),
          ];

          editors.set(args.kind, editor);
          if (args.autofocus) editor.focus(undefined, { defaultSelection: "rootEnd" });
          return { editor, listeners, root };
        }),
        ({ editor, listeners, root }) =>
          Effect.sync(() => {
            for (const removeListener of listeners) removeListener();
            editor.setRootElement(null);
            if (editors.get(args.kind) === editor) editors.delete(args.kind);
            root.removeAttribute("data-saku-composer");
          }),
      );

      return yield* Effect.never;
    }),
  ),
);

/** Foldkit Commands are the only way the declarative update loop reaches the
 * mounted Lexical instance. Missing editors are harmless during route swaps:
 * the next Mount initializes from the Model's draft. */
export const SetComposerEditableCmd = Command.define("SetComposerEditable", {
  args: { kind: ComposerKind, editable: S.Boolean },
  messages: [ComposerEditableChanged],
  execute: ({ kind, editable }) =>
    Effect.sync(() => {
      activeEditor(kind)?.setEditable(editable);
      return ComposerEditableChanged();
    }),
});

export const ClearComposerCmd = Command.define("ClearComposer", {
  args: { kind: ComposerKind },
  messages: [ComposerCleared],
  execute: ({ kind }) =>
    Effect.sync(() => {
      const editor = activeEditor(kind);
      if (editor !== undefined) clearEditor(editor);
      return ComposerCleared();
    }),
});

export const RemoveComposerTriggerCmd = Command.define("RemoveComposerTrigger", {
  args: { kind: ComposerKind, trigger: S.Literals(["file", "command"]) },
  messages: [ComposerTriggerRemoved],
  execute: ({ kind, trigger }) =>
    Effect.sync(() => {
      const editor = activeEditor(kind);
      if (editor !== undefined) replaceActiveTrigger(editor, trigger, "");
      return ComposerTriggerRemoved();
    }),
});

export const InsertComposerSuggestionCmd = Command.define("InsertComposerSuggestion", {
  args: { kind: ComposerKind, trigger: S.Literals(["file", "command"]), value: S.String },
  messages: [ComposerSuggestionInserted],
  execute: ({ kind, trigger, value }) =>
    Effect.sync(() => {
      const editor = activeEditor(kind);
      if (editor !== undefined) {
        if (trigger === "file") insertFileMention(editor, value);
        else replaceActiveTrigger(editor, trigger, `/${value} `);
      }
      return ComposerSuggestionInserted();
    }),
});
