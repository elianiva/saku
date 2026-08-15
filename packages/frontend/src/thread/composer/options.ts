/**
 * The composer's trigger vocabulary: a small, pure seam between Lexical's
 * cursor and Foldkit's suggestion surface. The editor owns the text; this
 * module owns which suggestion can be selected for the text immediately before
 * the caret.
 */

export type ComposerTrigger = "file" | "command";
export type ComposerSuggestionAction =
  | "mention"
  | "compact"
  | "model"
  | "abort"
  | "clear";

export interface ComposerSuggestion {
  readonly value: string;
  readonly label: string;
  readonly detail: string;
  readonly icon: "fileStack" | "layers" | "pencil" | "square" | "x";
  readonly action: ComposerSuggestionAction;
}

const slashCommands = [
  {
    value: "compact",
    label: "/compact",
    detail: "summarize the current thread",
    icon: "layers",
    action: "compact",
    threadOnly: true,
  },
  {
    value: "model",
    label: "/model",
    detail: "change the thread's model",
    icon: "pencil",
    action: "model",
    threadOnly: true,
  },
  {
    value: "abort",
    label: "/abort",
    detail: "stop the running thread",
    icon: "square",
    action: "abort",
    threadOnly: true,
  },
  {
    value: "clear",
    label: "/clear",
    detail: "clear the current prompt",
    icon: "x",
    action: "clear",
    threadOnly: false,
  },
] as const satisfies ReadonlyArray<ComposerSuggestion & { readonly threadOnly: boolean }>;

/** The slash palette is deliberately data, not a second command runtime. The
 * actions map to existing Foldkit updates/Commands in thread/update.ts; an
 * unrecognised slash command can still be typed and sent as ordinary text. */
export const composerSuggestions = (
  trigger: ComposerTrigger,
  query: string,
  threadAvailable: boolean,
) => {
  const normalized = query.toLowerCase();
  if (trigger === "file") {
    const path = query.trim();
    return path === ""
      ? []
      : [
          {
            value: path,
            label: `@${path}`,
            detail: "mention this file",
            icon: "fileStack" as const,
            action: "mention" as const,
          },
        ];
  }
  return slashCommands.filter(
    (command) =>
      (threadAvailable || !command.threadOnly) &&
      (normalized === "" ||
        command.value.includes(normalized) ||
        command.detail.toLowerCase().includes(normalized)),
  );
};
