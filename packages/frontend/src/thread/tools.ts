/**
 * Per-tool argument rendering (tools.ts): the console renders each tool's
 * arguments the way pi's own shell does — a one-line preview for the
 * collapsed row and structured lines for the expanded body — instead of
 * raw JSON. The tool surface is pi's (`bash`, `read`, `write`, `edit`,
 * `grep`, `find`, `ls`); anything else falls back to a one-line JSON
 * rendering. The previews mirror pi's call format (`read src/a.ts:1-40`,
 * `grep /pat/ in src/ limit 100`, `$ ls -la`).
 */

import { Option, Result, Schema as S } from "effect";
import type { Json } from "effect/Schema";

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

/** A tool's argument object: a JSON object, decoded at the boundary. */
export interface ToolArgs {
  readonly [key: string]: Json;
}

const isJsonString = (value: Json | undefined): value is string => typeof value === "string";

const isJsonNumber = (value: Json | undefined): value is number => typeof value === "number";

const isJsonObject = (value: Json | undefined): value is ToolArgs =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A JSON object decoded from an unknown payload (the string-args branch). */
const DECODE_ARGS = S.decodeUnknownOption(S.Record(S.String, S.Json));

/**
 * One-line JSON of a value, falling back to "" when it cannot be
 * stringified (circular refs — unreachable for Json inputs, which never
 * hold functions or cycles). `Result.try` at the sync stringify point
 * (house style: no try/catch).
 */
export const jsonLine = (value: Json | undefined) => {
  if (value === undefined) {
    return "";
  }
  const raw = Result.try(() => (isJsonString(value) ? value : JSON.stringify(value)));
  return Result.isSuccess(raw) ? (raw.success ?? "") : "";
};

const truncate = (text: string, limit: number) =>
  text.length > limit ? `${text.slice(0, limit)}…` : text;

/** The arguments as a record: pi passes an object, or a JSON string. */
const argsRecord = (args: Json | undefined): ToolArgs | undefined => {
  if (isJsonObject(args)) {
    return args;
  }
  if (!isJsonString(args) || args === "") {
    return undefined;
  }
  // SAFETY: JSON.parse returns any; pinning to unknown makes the schema
  // decode the only gate on the parsed payload.
  const parsed = Result.try(() => JSON.parse(args) as unknown);
  if (Result.isFailure(parsed)) {
    return undefined;
  }
  return Option.getOrUndefined(DECODE_ARGS(parsed.success));
};

const strArg = (args: ToolArgs | undefined, key: string, alt?: string) => {
  let raw: Json | undefined;
  if (args !== undefined) {
    raw = alt === undefined ? args[key] : (args[key] ?? args[alt]);
  }
  return isJsonString(raw) && raw !== "" ? raw : undefined;
};

const numArg = (args: ToolArgs | undefined, key: string) => {
  let raw: Json | undefined;
  if (args !== undefined) {
    raw = args[key];
  }
  return isJsonNumber(raw) && Number.isFinite(raw) ? raw : undefined;
};

/** `read`: `path` with pi's line-range suffix (`:1-40`) when offset/limit
 *  narrow the read. */
const read = (args: ToolArgs): ToolArgsView => {
  const path = strArg(args, "path", "file_path") ?? "";
  const offset = numArg(args, "offset");
  const limit = numArg(args, "limit");
  const start = offset ?? 1;
  const range =
    offset === undefined && limit === undefined
      ? ""
      : `:${start}${limit === undefined ? "" : `-${start + limit - 1}`}`;
  return {
    lines: [
      { kind: "code", text: path },
      ...(range === ""
        ? []
        : [
            {
              kind: "label" as const,
              text:
                limit === undefined ? `from line ${start}` : `lines ${start}–${start + limit - 1}`,
            },
          ]),
    ],
    preview: truncate(`${path}${range}`, 160),
  };
};

/** `bash`: the command, pi-style (`$ cmd`), with the timeout as a suffix. */
const bash = (args: ToolArgs): ToolArgsView => {
  const command = strArg(args, "command") ?? "";
  const timeout = numArg(args, "timeout");
  return {
    lines: [
      { kind: "code", text: command === "" ? "…" : command },
      ...(timeout === undefined ? [] : [{ kind: "label" as const, text: `timeout ${timeout}s` }]),
    ],
    preview: truncate(
      `$ ${command === "" ? "…" : command}${timeout === undefined ? "" : ` · timeout ${timeout}s`}`,
      160,
    ),
  };
};

/** `write`: the path, plus the content as a capped code block. */
const write = (args: ToolArgs): ToolArgsView => {
  const path = strArg(args, "path", "file_path") ?? "";
  const content = strArg(args, "content") ?? "";
  return {
    lines: [
      { kind: "code", text: path },
      ...(content === "" ? [] : [{ kind: "code" as const, text: truncate(content, 600) }]),
    ],
    preview: truncate(path, 160),
  };
};

/** `edit`: the path and one `− old / + new` pair per targeted edit. */
const edit = (args: ToolArgs): ToolArgsView => {
  const path = strArg(args, "path", "file_path") ?? "";
  const raw = args.edits;
  const edits = Array.isArray(raw) ? raw.filter(isJsonObject) : [];
  const lines: ToolArgLine[] = [{ kind: "code", text: path }];
  for (const [index, one] of edits.entries()) {
    const oldText = strArg(one, "oldText") ?? "";
    const newText = strArg(one, "newText") ?? "";
    lines.push({ kind: "label", text: `edit ${index + 1}` });
    if (oldText !== "") {
      lines.push({ kind: "removed", text: truncate(oldText, 240) });
    }
    if (newText !== "") {
      lines.push({ kind: "added", text: truncate(newText, 240) });
    }
  }
  return {
    lines,
    preview: `${truncate(path, 160)}${edits.length > 1 ? ` · ${edits.length} edits` : ""}`,
  };
};

/** `grep`: `/pattern/ in path` with the -i/-l/-c flags, glob, and limit. */
const grep = (args: ToolArgs): ToolArgsView => {
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
    lines: [
      { kind: "code", text: `/${pattern}/` },
      ...(path === "." ? [] : [{ kind: "label" as const, text: `in ${path}` }]),
      ...(flagsText === "" ? [] : [{ kind: "label" as const, text: flagsText.trim() }]),
      ...(glob === undefined ? [] : [{ kind: "label" as const, text: `glob ${glob}` }]),
      ...(limit === undefined ? [] : [{ kind: "label" as const, text: `limit ${limit}` }]),
    ],
    preview,
  };
};

/** `find`: `pattern in path`, with the result cap as a suffix. */
const find = (args: ToolArgs): ToolArgsView => {
  const pattern = strArg(args, "pattern") ?? "";
  const path = strArg(args, "path") ?? ".";
  const limit = numArg(args, "limit");
  return {
    lines: [
      { kind: "code", text: pattern === "" ? "…" : pattern },
      ...(path === "." ? [] : [{ kind: "label" as const, text: `in ${path}` }]),
      ...(limit === undefined ? [] : [{ kind: "label" as const, text: `limit ${limit}` }]),
    ],
    preview: truncate(
      `${pattern === "" ? "…" : pattern} in ${path}${limit === undefined ? "" : ` limit ${limit}`}`,
      160,
    ),
  };
};

/** `ls`: the directory (`.` when absent), with the entry cap as a suffix. */
const ls = (args: ToolArgs): ToolArgsView => {
  const path = strArg(args, "path") ?? ".";
  const limit = numArg(args, "limit");
  return {
    lines: [
      { kind: "code", text: path },
      ...(limit === undefined ? [] : [{ kind: "label" as const, text: `limit ${limit}` }]),
    ],
    preview: truncate(`${path}${limit === undefined ? "" : ` limit ${limit}`}`, 160),
  };
};

/** Unknown tools: the raw arguments as one-line JSON. */
const fallback = (args: Json | undefined): ToolArgsView => ({
  lines: args === undefined ? [] : [{ kind: "code", text: jsonLine(args) }],
  preview: truncate(jsonLine(args), 240),
});

/**
 * Render a tool call's arguments for its name: a one-line preview (the
 * collapsed row) and the structured expanded lines. Undecodable arguments
 * and tools outside the pi surface fall back to JSON.
 */
export const toolArgsView = (name: string, args: Json | undefined): ToolArgsView => {
  const record = argsRecord(args);
  switch (name) {
    case "read": {
      return record === undefined ? fallback(args) : read(record);
    }
    case "bash": {
      return record === undefined ? fallback(args) : bash(record);
    }
    case "write": {
      return record === undefined ? fallback(args) : write(record);
    }
    case "edit": {
      return record === undefined ? fallback(args) : edit(record);
    }
    case "grep": {
      return record === undefined ? fallback(args) : grep(record);
    }
    case "find": {
      return record === undefined ? fallback(args) : find(record);
    }
    case "ls": {
      return record === undefined ? fallback(args) : ls(record);
    }
    default: {
      return fallback(args);
    }
  }
};
