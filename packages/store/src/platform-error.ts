/**
 * Platform-error helpers (platform-error.ts).
 *
 * `isNotFound` — whether an error is a missing-path failure: an Effect
 * `PlatformError` with the "NotFound" reason, any tagged error whose
 * `_tag` is "NotFound", or an error carrying an ENOENT cause
 * (`NodeJS.ErrnoException`).
 *
 * The file backend answers `Option.none` on reads that hit this (kv.ts);
 * pi's promise-based adapters (`LocalEnv`, credential stores) use it to
 * turn a missing file into a "not found" result instead of a defect.
 */

/** Whether `error` is a missing-path failure (PlatformError "NotFound" / ENOENT). */
export const isNotFound = (error: unknown) => {
  if (typeof error !== "object" || error === null) return false;
  const e = error as { _tag?: unknown; reason?: { _tag?: unknown }; cause?: unknown };
  if (e._tag === "NotFound") return true;
  if (e._tag === "PlatformError" && e.reason?._tag === "NotFound") return true;
  return (e.cause as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
};
