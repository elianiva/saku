/**
 * End-to-end smoke test: runs the real demo app through the foldtui binding
 * on a pair of in-memory streams (no TTY), then drives it with genuine SGR
 * mouse-click sequences and asserts the count follows the TEA model.
 *
 * The renderer's stdout bytes are parsed into a screen grid with a minimal
 * ANSI parser; clicks are sent as `\x1b[<0;COL;ROWM` / `...m` (press/release)
 * at the located button labels.
 *
 * Run with: pnpm smoke
 */

import { Readable, Writable } from "node:stream";
import { createCliRenderer } from "@opentui/core";
import { runWithRenderer } from "foldtui";

import { init, update, view } from "../src/main.ts";

const WIDTH = 80;
const HEIGHT = 24;

const chunks: Buffer[] = [];
const output = new Writable({
  write(chunk: Buffer, _enc: unknown, callback: () => void) {
    chunks.push(Buffer.from(chunk));
    callback();
  },
});
const input = new Readable({ read() {} });

const renderer = await createCliRenderer({
  stdin: input as never,
  stdout: output as never,
  width: WIDTH,
  height: HEIGHT,
  useMouse: true,
  exitOnCtrlC: false,
});

runWithRenderer(renderer, { init, update, view });

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// Keep frames flowing regardless of the renderer's live-loop state.
const frameHammer = setInterval(() => renderer.requestRender(), 50);

// -- minimal ANSI screen parser ---------------------------------------------

const TOKEN = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|[\x00-\x08\x0a-\x1f\x7f]/g;

const parseScreen = (raw: string): string[][] => {
  const grid: string[][] = Array.from({ length: HEIGHT }, () => Array<string>(WIDTH).fill(" "));
  let x = 0;
  let y = 0;
  const put = (ch: string): void => {
    if (x >= 0 && x < WIDTH && y >= 0 && y < HEIGHT) grid[y]![x] = ch;
    x++;
  };
  const writeText = (text: string): void => {
    for (const ch of text) {
      if (ch === "\r") x = 0;
      else if (ch === "\n") {
        y++;
        x = 0;
      } else put(ch);
    }
  };

  let last = 0;
  for (const match of raw.matchAll(TOKEN)) {
    const index = match.index!;
    writeText(raw.slice(last, index));
    const token = match[0];
    if (token.startsWith("\x1b[")) {
      const body = token.slice(2, -1);
      const final = token[token.length - 1]!;
      if (final === "H" || final === "f") {
        const [row, col] = body.split(";");
        y = (row === undefined || row === "" ? 1 : Number(row)) - 1;
        x = (col === undefined || col === "" ? 1 : Number(col)) - 1;
      } else if (final === "J") {
        if (body === "" || body === "2" || body === "3") {
          for (const row of grid) row.fill(" ");
          x = 0;
          y = 0;
        }
      } else if (final === "K") {
        if (grid[y] !== undefined) {
          for (let cx = Math.max(0, x); cx < WIDTH; cx++) grid[y]![cx] = " ";
        }
      } else if (final === "A") y -= Number(body || "1");
      else if (final === "B") y += Number(body || "1");
      else if (final === "C") x += Number(body || "1");
      else if (final === "D") x -= Number(body || "1");
      // 'm' / 'h' / 'l' / ... are styling or mode changes: ignored.
    }
    last = index + token.length;
  }
  writeText(raw.slice(last));
  return grid;
};

const allOutput = (): string => Buffer.concat(chunks).toString("utf8");

const screen = (): string[][] => parseScreen(allOutput());

// OpenTUI's renderer captures `console.*` into its debug overlay, so the
// smoke reports via raw process.stdout/stderr writes instead.
const say = (line: string): void => {
  process.stdout.write(line + "\n");
};
const sayErr = (line: string): void => {
  process.stderr.write(line + "\n");
};

const dump = (): void => {
  sayErr("--- last screen ---");
  for (const row of screen()) sayErr(row.join("").replace(/\s+$/, ""));
  sayErr("--- raw tail ---");
  sayErr(JSON.stringify(allOutput().slice(-400)));
};

const assert = (condition: boolean, message: string): void => {
  if (!condition) {
    dump();
    sayErr(`ASSERT FAILED: ${message}`);
    process.exit(1);
  }
};

const findText = (grid: string[][], needle: string): { x: number; y: number } | null => {
  for (let y = 0; y < grid.length; y++) {
    const x = grid[y]!.join("").indexOf(needle);
    if (x >= 0) return { x, y };
  }
  return null;
};

const hasText = (grid: string[][], needle: string): boolean => findText(grid, needle) !== null;

/** Sends a full press+release SGR mouse click at 0-based grid coords. */
const click = (cell: { x: number; y: number }): void => {
  const col = cell.x + 1; // SGR coordinates are 1-based
  const row = cell.y + 1;
  input.push(`\x1b[<0;${col};${row}M`); // button press
  input.push(`\x1b[<0;${col};${row}m`); // release
};

// -- scenario ----------------------------------------------------------------

const FAILURES: string[] = [];

const run = async (): Promise<void> => {
  try {
    // 1. Initial render
    await sleep(1500);
    let grid = screen();
    assert(hasText(grid, "Count: 0"), 'initial frame shows "Count: 0"');
    say('ok — initial render shows "Count: 0"');

    const increment = findText(grid, " + ");
    const decrement = findText(grid, " - ");
    const reset = findText(grid, " Reset ");
    assert(increment !== null, '" + " button is rendered');
    assert(decrement !== null, '" - " button is rendered');
    assert(reset !== null, '" Reset " button is rendered');

    // 2. Click "+" twice
    click({ x: increment!.x + 1, y: increment!.y });
    await sleep(500);
    grid = screen();
    assert(hasText(grid, "Count: 1"), 'first "+" click increments to 1');
    say('ok — click "+" -> Count: 1');

    click({ x: increment!.x + 1, y: increment!.y });
    await sleep(500);
    grid = screen();
    assert(hasText(grid, "Count: 2"), 'second "+" click increments to 2');
    say('ok — click "+" -> Count: 2');

    // 3. Click "-"
    click({ x: decrement!.x + 1, y: decrement!.y });
    await sleep(500);
    grid = screen();
    assert(hasText(grid, "Count: 1"), '"-" click decrements to 1');
    say('ok — click "-" -> Count: 1');

    // 4. Click "Reset"
    click({ x: reset!.x + 2, y: reset!.y });
    await sleep(500);
    grid = screen();
    assert(hasText(grid, "Count: 0"), '"Reset" click resets to 0');
    say('ok — click "Reset" -> Count: 0');

    say("\nPASS — all click interactions updated the TEA model.");
  } catch (error) {
    FAILURES.push(String(error));
  } finally {
    clearInterval(frameHammer);
    try {
      await renderer.destroy();
    } catch {
      // destroy may be a no-op on non-TTY streams; fine.
    }
  }
};

await run();

if (FAILURES.length > 0) {
  sayErr(FAILURES.join("\n"));
  process.exit(1);
}
process.exit(0);
