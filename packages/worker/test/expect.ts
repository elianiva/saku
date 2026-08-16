/**
 * Shared test assertions (expect.ts): fail-loudly narrowing for values the
 * test guarantees by construction (a just-created session, the head lane).
 */

/** A value that exists by construction; fail loudly when it does not. */
export const expectPresent = <T>(value: T | undefined, what: string): T => {
  if (value === undefined) {
    throw new Error(`expected ${what} to be present`);
  }
  return value;
};
