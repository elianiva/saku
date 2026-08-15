/**
 * Config-value resolution (config-value.ts): pi's models.json convention for
 * apiKey/header values, ported from pi-coding-agent's `resolve-config-value`
 * so a models.json behaves identically under saku (extend pi, never shim it):
 *
 * - `!command`          executes the rest as a shell command, stdout is the value (cached)
 * - `$ENV_VAR`/`${E}`   interpolates the named environment variable
 * - `$$` / `$!`         escapes a literal `$` / `!` in non-command values
 * - anything else       is a literal value
 *
 * Resolution is pure over the caller's `env` — the daemon passes its own
 * environment once at catalog build; nothing here touches `process.env`.
 */

import { execSync } from "node:child_process";
import { Data, Result } from "effect";

const ENV_VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const ENV_VAR_NAME_PREFIX_RE = /^[A-Za-z_][A-Za-z0-9_]*/u;

/** One template part: a literal chunk or an env-var reference. */
type TemplatePart = Data.TaggedEnum<{
  literal: { value: string };
  env: { name: string };
}>;
const TemplatePart = Data.taggedEnum<TemplatePart>();

const appendLiteral = (parts: TemplatePart[], value: string) => {
  if (value.length === 0) return;
  const previous = parts[parts.length - 1];
  if (previous !== undefined && previous._tag === "literal") {
    parts[parts.length - 1] = TemplatePart.literal({ value: previous.value + value });
    return;
  }
  parts.push(TemplatePart.literal({ value }));
};

/** Split a value into literal/env parts, honoring `$$`/`$!` escapes. */
const parseTemplate = (config: string) => {
  const parts: TemplatePart[] = [];
  let index = 0;
  while (index < config.length) {
    const dollarIndex = config.indexOf("$", index);
    if (dollarIndex < 0) {
      appendLiteral(parts, config.slice(index));
      break;
    }
    appendLiteral(parts, config.slice(index, dollarIndex));
    const next = config[dollarIndex + 1];
    if (next === "$" || next === "!") {
      appendLiteral(parts, next);
      index = dollarIndex + 2;
      continue;
    }
    if (next === "{") {
      const endIndex = config.indexOf("}", dollarIndex + 2);
      if (endIndex < 0 || !ENV_VAR_NAME_RE.test(config.slice(dollarIndex + 2, endIndex))) {
        appendLiteral(parts, "$");
        index = dollarIndex + 1;
        continue;
      }
      parts.push(TemplatePart.env({ name: config.slice(dollarIndex + 2, endIndex) }));
      index = endIndex + 1;
      continue;
    }
    const match = config.slice(dollarIndex + 1).match(ENV_VAR_NAME_PREFIX_RE);
    if (match !== null) {
      parts.push(TemplatePart.env({ name: match[0] }));
      index = dollarIndex + 1 + match[0].length;
      continue;
    }
    appendLiteral(parts, "$");
    index = dollarIndex + 1;
  }
  return parts;
};

const resolveTemplate = (
  parts: readonly TemplatePart[],
  env: Record<string, string>,
) => {
  let resolved = "";
  for (const part of parts) {
    if (part._tag === "literal") {
      resolved += part.value;
    } else {
      const value = env[part.name];
      if (value === undefined) return undefined;
      resolved += value;
    }
  }
  return resolved;
};

// Shell command results are cached for the process lifetime (pi's behavior).
const commandCache = new Map<string, string | undefined>();

const executeCommand = (config: string) => {
  if (commandCache.has(config)) return commandCache.get(config);
  const output = Result.try(() =>
    execSync(config.slice(1), {
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "ignore"],
    }),
  );
  const result = Result.isSuccess(output) ? output.success.trim() || undefined : undefined;
  commandCache.set(config, result);
  return result;
};

/** A `!command` value: executed (and cached), never treated as a literal. */
export const isCommandConfigValue = (config: string) => config.startsWith("!");

/** The environment variables a template value references, in order. */
export const getConfigValueEnvVarNames = (config: string) => {
  if (isCommandConfigValue(config)) return [];
  const names: string[] = [];
  for (const part of parseTemplate(config)) {
    if (part._tag === "env" && !names.includes(part.name)) names.push(part.name);
  }
  return names;
};

/** Env var names referenced by the value that are not set in `env`. */
export const getMissingConfigValueEnvVarNames = (
  config: string,
  env: Record<string, string>,
) => getConfigValueEnvVarNames(config).filter((name) => env[name] === undefined);

/** Resolve a config value to its actual value; undefined when a reference cannot be resolved. */
export const resolveConfigValue = (
  config: string,
  env: Record<string, string>,
) =>
  isCommandConfigValue(config)
    ? executeCommand(config)
    : resolveTemplate(parseTemplate(config), env);

/** Resolve every header value (missing references drop the header, pi's rule). */
export const resolveHeaders = (
  headers: Record<string, string> | undefined,
  env: Record<string, string>,
) => {
  if (headers === undefined) return undefined;
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const resolvedValue = resolveConfigValue(value, env);
    if (resolvedValue !== undefined) resolved[key] = resolvedValue;
  }
  return Object.keys(resolved).length > 0 ? resolved : undefined;
};
