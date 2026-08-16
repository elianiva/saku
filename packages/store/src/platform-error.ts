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

/** The raw error surface the platform can hand back at an I/O boundary. */
export interface PlatformErrorLike {
  readonly _tag?: unknown;
  readonly reason?: { readonly _tag?: unknown };
  readonly cause?: unknown;
}

/** The error shapes recognized as a missing-path failure. */
export type NotFoundError =
  | { readonly _tag: "NotFound" }
  | { readonly _tag: "PlatformError"; readonly reason: { readonly _tag: "NotFound" } }
  | { readonly cause: { readonly code: "ENOENT" } };

/** Whether `error` is a missing-path failure (PlatformError "NotFound" / ENOENT). */
export const isNotFound = (error: PlatformErrorLike): error is NotFoundError => {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  if (error._tag === "NotFound") {
    return true;
  }
  if (error._tag === "PlatformError" && error.reason?._tag === "NotFound") {
    return true;
  }
  const { cause } = error;
  if (typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT") {
    return true;
  }
  return false;
};
