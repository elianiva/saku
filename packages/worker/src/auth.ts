/**
 * Auth: the daemon's connection token (auth.ts).
 *
 * Created on first daemon boot: 32 random bytes as hex, written 0600. Consoles
 * read the same file and present the token in their `hello` line; the daemon
 * drops sockets that present a different token. `SAKU_HOME` redirects the
 * whole layout (hermetic tests).
 */

import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { getAuthPath, getSakuDir } from "./paths.ts";

/** Read the token, creating it (and its directory) when absent. */
export const ensureAuthToken = (): string => {
  const path = getAuthPath();
  try {
    const existing = readFileSync(path, "utf8").trim();
    if (existing.length > 0) return existing;
  } catch {
    // Not present yet — create below.
  }
  mkdirSync(getSakuDir(), { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString("hex");
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return token;
};

/** Read the token without creating anything. Returns undefined when absent. */
export const readAuthToken = (): string | undefined => {
  try {
    const token = readFileSync(getAuthPath(), "utf8").trim();
    return token.length > 0 ? token : undefined;
  } catch {
    return undefined;
  }
};

/** Ensure the saku home directory exists. */
export const ensureSakuDirs = (): void => {
  mkdirSync(getSakuDir(), { recursive: true, mode: 0o700 });
};
