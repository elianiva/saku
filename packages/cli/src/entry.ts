#!/usr/bin/env bun
// saku — the software factory CLI.
// Scaffold entry: the worker steward + headless console commands land here
// once the wire client exists.

const args = Bun.argv.slice(2);

if (args.length === 0) {
  console.log(
    [
      "saku — the software factory",
      "",
      "Usage: saku <command>",
      "",
      "commands (scaffold):",
      "  daemon   start/stop/status the worker",
      "  tui      launch the console",
      "  run      headless prompt on a thread",
      "",
    ].join("\n"),
  );
  process.exit(0);
}

console.error("not implemented yet:", args.join(" "));
process.exit(1);
