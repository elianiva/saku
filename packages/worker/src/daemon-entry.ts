/**
 * Daemon entry (daemon-entry.ts): the process the CLI spawns.
 *
 * `saku daemon start` spawns `node daemon-entry.ts` detached with its output
 * redirected to `~/.saku/worker.log`; this module owns the process lifetime.
 */

import { SakuDaemon } from "./daemon.ts";

const main = async (): Promise<void> => {
  const daemon = SakuDaemon.create();
  await daemon.start();

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[saku-worker] ${signal}: shutting down`);
    await daemon.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("uncaughtException", (error) => {
    console.error(`[saku-worker] uncaught exception: ${error instanceof Error ? error.stack : String(error)}`);
  });
  process.on("unhandledRejection", (reason) => {
    console.error(`[saku-worker] unhandled rejection: ${String(reason)}`);
  });
};

main().catch((error) => {
  console.error(`[saku-worker] failed to start: ${error instanceof Error ? error.stack : String(error)}`);
  process.exit(1);
});
