#!/usr/bin/env node
/**
 * The saku TUI entry. Spawned by `saku open [thread]`; the optional argv
 * picks a thread to jump into (full id, prefix, or name).
 */

import { run } from "foldtui";

import { makeApp } from "./app.ts";

const threadArg = process.argv[2];

const main = async (): Promise<void> => {
  const handle = await run(makeApp(threadArg, onQuit));

  function onQuit(): void {
    void handle.destroy().then(() => process.exit(0));
  }

  process.on("SIGTERM", onQuit);
  process.on("SIGINT", onQuit);
};

main().catch((error) => {
  console.error(`saku-tui: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
