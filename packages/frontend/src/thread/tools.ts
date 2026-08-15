/**
 * Per-tool argument rendering (tools.ts): the console renders each tool's
 * arguments the way pi's own shell does — a one-line preview for the
 * collapsed row and structured lines for the expanded body — instead of
 * raw JSON. The tool surface is pi's (`bash`, `read`, `write`, `edit`,
 * `grep`, `find`, `ls`); anything else falls back to a one-line JSON
 * rendering. The previews mirror pi's call format (`read src/a.ts:1-40`,
 * `grep /pat/ in src/ limit 100`, `$ ls -la`).
 */

import { Result } from "effect";

/** One line of the expanded argument rendering. */
export type ToolArgLine =
  | { readonly kind: "label"; readonly text: string }
  | { readonly kind: "code"; readonly text: string }
  | { readonly kind: "removed"; readonly text: string }
  | { readonly kind: "added"; readonly text: string };

/** Per-tool rendering of a tool call's arguments. */
export interface ToolArgsView {
  /** One-line preview shown in the collapsed summary. */
  readonly preview: string;
  /** The expanded rendering, in display order. */
  readonly lines: readonly ToolArgLine[];
}

/**
 * One-line JSON of an unknown value, falling back to `String(value)` when
 * it cannot be stringified (circular refs); absent values render as "".
 * `Result.try` at the sync stringify point (house style: no try/catch).
 */
export const jsonLine = (value: unknown) => {
  if (value === undefined) return "";
  const raw = Result.try(() => (typeof value === "string" ? value : JSON.stringify(value)));
  return Result.isSuccess(raw) ? raw.success : String(value);
};

const truncate = (text: string, limit: number) =>
  text.length > limit ? `${text.slice(0, limit)}…` : text;

/** The arguments as a record: pi passes an object, or a JSON string. */
const argsRecord = (args: unknown): Record<string, unknown> | undefined => {
  if (typeof args === "object" && args !== null && !Array.isArray(args)) {
    return args as Record<string, unknown>;
  }
  if (typeof args === "string" && args !== "") {
    const parsed = Result.try(() => JSON.parse(args));
    if (
      Result.isSuccess(parsed) &&
      typeof parsed.success === "object" &&
      parsed.success !== null
    ) {
      return parsed.success as Record<string, unknown>;
    }
  }
  return undefined;
};

const strArg = (args: Record<string, unknown> | undefined, key: string, alt?: string) => {
  if (args === undefined) return undefined;
  const raw = alt === undefined ? args[key] : (args[key] ?? args[alt]);
  return typeof raw === "string" && raw !== "" ? raw : undefined;
};

const numArg = (args: Record<string, unknown> | undefined, key: string) => {
  if (args === undefined) return undefined;
  const raw = args[key];
  return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
};

/** `read`: `path` with pi's line-range suffix (`:1-40`) when offset/limit
 *  narrow the read. */
const read = (args: Record<string, unknown>): ToolArgsView => {
  const path = strArg(args, "path", "file_path") ?? "";
  const offset = numArg(args, "offset");
  const limit = numArg(args, "limit");
  const start = offset ?? 1;
  const range =
    offset === undefined && limit === undefined
      ? ""
      : `:${start}${limit === undefined ? "" : `-${start + limit - 1}`}`;
  return {
    preview: truncate(`${path}${range}`, 160),
    lines: [
      { kind: "code", text: path },
      ...(range === ""
        ? []
        : [
            {
              kind: "label" as const,
              text:
                limit === undefined
                  ? `from line ${start}`
                  : `lines ${start}–${start + limit - 1}`,
            },
          ]),
    ],
  };
};

/** `bash`: the command, pi-style (`$ cmd`), with the timeout as a suffix. */
const bash = (args: Record<string, unknown>): ToolArgsView => {
  const command = strArg(args, "command") ?? "";
  const timeout = numArg(args, "timeout");
  return {
    preview: truncate(
      `$ ${command === "" ? "…" : command}${timeout === undefined ? "" : ` · timeout ${timeout}s`}`,
      160,
    ),
    lines: [
      { kind: "code", text: command === "" ? "…" : command },
      ...(timeout === undefined ? [] : [{ kind: "label" as const, text: `timeout ${timeout}s` }]),
    ],
  };
};

/** `write`: the path, plus the content as a capped code block. */
const write = (args: Record<string, unknown>): ToolArgsView => {
  const path = strArg(args, "path", "file_path") ?? "";
  const content = strArg(args, "content") ?? "";
  return {
    preview: truncate(path, 160),
    lines: [
      { kind: "code", text: path },
      ...(content === "" ? [] : [{ kind: "code" as const, text: truncate(content, 600) }]),
    ],
  };
};

/** `edit`: the path and one `− old / + new` pair per targeted edit. */
const edit = (args: Record<string, unknown>): ToolArgsView => {
  const path = strArg(args, "path", "file_path") ?? "";
  const raw = args.edits;
  const edits = Array.isArray(raw)
    ? raw.filter((candidate): candidate is Record<string, unknown> =>
        typeof candidate === "object" && candidate !== null,
      )
    : [];
  const lines: ToolArgLine[] = [{ kind: "code", text: path }];
  edits.forEach((one, i) => {
    const oldText = strArg(one, "oldText") ?? "";
    const newText = strArg(one, "newText") ?? "";
    lines.push({ kind: "label", text: `edit ${i + 1}` });
    if (oldText !== "") lines.push({ kind: "removed", text: truncate(oldText, 240) });
    if (newText !== "") lines.push({ kind: "added", text: truncate(newText, 240) });
  });
  return {
    preview: `${truncate(path, 160)}${edits.length > 1 ? ` · ${edits.length} edits` : ""}`,
    lines,
  };
};

/** `grep`: `/pattern/ in path` with the -i/-l/-c flags, glob, and limit. */
const grep = (args: Record<string, unknown>): ToolArgsView => {
  const pattern = strArg(args, "pattern") ?? "";
  const path = strArg(args, "path") ?? ".";
  const glob = strArg(args, "glob");
  const context = numArg(args, "context");
  const limit = numArg(args, "limit");
  const flags = [
    ...(args.ignoreCase === true ? ["-i"] : []),
    ...(args.literal === true ? ["-l"] : []),
    ...(context === undefined ? [] : [`-c ${context}`]),
  ];
  const flagsText = flags.length === 0 ? "" : ` ${flags.join(" ")}`;
  const preview = truncate(
    `/${pattern}/ in ${path}${flagsText}${glob === undefined ? "" : ` (${glob})`}${limit === undefined ? "" : ` limit ${limit}`}`,
    160,
  );
  return {
    preview,
    lines: [
      { kind: "code", text: `/${pattern}/` },
      ...(path === "." ? [] : [{ kind: "label" as const, text: `in ${path}` }]),
      ...(flagsText === "" ? [] : [{ kind: "label" as const, text: flagsText.trim() }]),
      ...(glob === undefined ? [] : [{ kind: "label" as const, text: `glob ${glob}` }]),
      ...(limit === undefined ? [] : [{ kind: "label" as const, text: `limit ${limit}` }]),
    ],
  };
};

/** `find`: `pattern in path`, with the result cap as a suffix. */
const find = (args: Record<string, unknown>): ToolArgsView => {
  const pattern = strArg(args, "pattern") ?? "";
  const path = strArg(args, "path") ?? ".";
  const limit = numArg(args, "limit");
  return {
    preview: truncate(
      `${pattern === "" ? "…" : pattern} in ${path}${limit === undefined ? "" : ` limit ${limit}`}`,
      160,
    ),
    lines: [
      { kind: "code", text: pattern === "" ? "…" : pattern },
      ...(path === "." ? [] : [{ kind: "label" as const, text: `in ${path}` }]),
      ...(limit === undefined ? [] : [{ kind: "label" as const, text: `limit ${limit}` }]),
    ],
  };
};

/** `ls`: the directory (`.` when absent), with the entry cap as a suffix. */
const ls = (args: Record<string, unknown>): ToolArgsView => {
  const path = strArg(args, "path") ?? ".";
  const limit = numArg(args, "limit");
  return {
    preview: truncate(`${path}${limit === undefined ? "" : ` limit ${limit}`}`, 160),
    lines: [
      { kind: "code", text: path },
      ...(limit === undefined ? [] : [{ kind: "label" as const, text: `limit ${limit}` }]),
    ],
  };
};

/** Unknown tools: the raw arguments as one-line JSON. */
const fallback = (args: unknown): ToolArgsView => ({
  preview: truncate(jsonLine(args), 240),
  lines: args === undefined ? [] : [{ kind: "code", text: jsonLine(args) }],
});

/**
 * Render a tool call's arguments for its name: a one-line preview (the
 * collapsed row) and the structured expanded lines. Undecodable arguments
 * and tools outside the pi surface fall back to JSON.
 */
export const toolArgsView = (name: string, args: unknown): ToolArgsView => {
  const record = argsRecord(args);
  switch (name) {
    case "read":
      return record === undefined ? fallback(args) : read(record);
    case "bash":
      return record === undefined ? fallback(args) : bash(record);
    case "write":
      return record === undefined ? fallback(args) : write(record);
    case "edit":
      return record === undefined ? fallback(args) : edit(record);
    case "grep":
      return record === undefined ? fallback(args) : grep(record);
    case "find":
      return record === undefined ? fallback(args) : find(record);
    case "ls":
      return record === undefined ? fallback(args) : ls(record);
    default:
      return fallback(args);
  }
};
