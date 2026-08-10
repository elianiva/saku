/**
 * Platform-error helpers (fs.ts).
 *
 * Effect code never imports node:fs: layers `yield* FileSystem.FileSystem`
 * (the service tag from `effect`) and compose `NodeFileSystem.layer` at the
 * daemon root. Pi's promise-based adapters (`LocalEnv`, credential stores)
 * cannot yield services, so they hold the service shape directly and run its
 * methods with `Effect.runPromise` at their own method boundary.
 */

/** Whether `error` is a missing-path failure (PlatformError "NotFound" / ENOENT). */
export const isNotFound = (error: unknown): boolean => {
  if (typeof error !== "object" || error === null) return false;
  const e = error as { _tag?: unknown; reason?: { _tag?: unknown }; cause?: unknown };
  if (e._tag === "NotFound") return true;
  if (e._tag === "PlatformError" && e.reason?._tag === "NotFound") return true;
  return (e.cause as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
};
