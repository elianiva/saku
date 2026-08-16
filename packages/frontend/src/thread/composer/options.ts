/**
 * The composer's trigger vocabulary: a small, pure seam between Lexical's
 * cursor and Foldkit's suggestion surface. The editor owns the text; this
 * module owns which suggestion can be selected for the text immediately before
 * the caret.
 */

export type ComposerTrigger = "file" | "command";
export type ComposerSuggestionAction = "mention" | "compact" | "model" | "abort" | "clear";

export interface ComposerSuggestion {
  readonly value: string;
  readonly label: string;
  readonly detail: string;
  readonly icon: "fileStack" | "layers" | "pencil" | "square" | "x";
  readonly action: ComposerSuggestionAction;
}

const slashCommands = [
  {
    action: "compact",
    detail: "summarize the current thread",
    icon: "layers",
    label: "/compact",
    threadOnly: true,
    value: "compact",
  },
  {
    action: "model",
    detail: "change the thread's model",
    icon: "pencil",
    label: "/model",
    threadOnly: true,
    value: "model",
  },
  {
    action: "abort",
    detail: "stop the running thread",
    icon: "square",
    label: "/abort",
    threadOnly: true,
    value: "abort",
  },
  {
    action: "clear",
    detail: "clear the current prompt",
    icon: "x",
    label: "/clear",
    threadOnly: false,
    value: "clear",
  },
] as const satisfies readonly (ComposerSuggestion & { readonly threadOnly: boolean })[];

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
            action: "mention" as const,
            detail: "mention this file",
            icon: "fileStack" as const,
            label: `@${path}`,
            value: path,
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
