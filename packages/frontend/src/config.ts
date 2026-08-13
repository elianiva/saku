/**
 * Connection config (config.ts): where the console dials.
 *
 * Resolution order: the dev bootstrap (`/__saku` — the vite dev server
 * publishing the local worker daemon's URL + token from ~/.saku) wins; then
 * a saved override in localStorage (`saku.config` — the v1 single-owner flow
 * for a deployed hub: its domain + the deployment secret); then the
 * same-origin `/ws` default (ADR 0002: the console is served from the hub's
 * domain). The hub's login/cookie minting is a later slice.
 *
 * Everything is an Effect with `never` failure: a missing or unparsable
 * bootstrap falls through to the next source instead of surfacing an error.
 */

import { Effect, Option, Schema as S } from "effect";

export interface SakuConfig {
  readonly url: string;
  readonly token: string;
}

const BootstrapSchema = S.Struct({ url: S.String, token: S.String });

const LOCALSTORAGE_KEY = "saku.config";

const defaultConfig = (): SakuConfig => {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return { url: `${protocol}//${window.location.host}/ws`, token: "" };
};

/** The dev bootstrap endpoint; `None` when absent (production) or unparsable. */
export const fetchBootstrap: Effect.Effect<Option.Option<SakuConfig>, never> = Effect.tryPromise({
  try: () =>
    fetch("/__saku").then((response) =>
      response.ok ? (response.json() as Promise<unknown>) : null,
    ),
  catch: () => null,
}).pipe(
  // A failed fetch is the same as no bootstrap: fall through.
  Effect.orElseSucceed(() => null),
  Effect.flatMap((parsed) =>
    parsed === null
      ? Effect.succeed(Option.none())
      : Effect.sync(() => S.decodeUnknownOption(BootstrapSchema)(parsed)),
  ),
);

export const readSavedConfig = (): SakuConfig | null => {
  const raw = window.localStorage.getItem(LOCALSTORAGE_KEY);
  if (raw === null) return null;
  try {
    return Option.getOrNull(S.decodeUnknownOption(BootstrapSchema)(JSON.parse(raw)));
  } catch {
    return null;
  }
};

export const resolveConfig: Effect.Effect<SakuConfig, never> = Effect.gen(function* () {
  const bootstrap = yield* fetchBootstrap;
  if (Option.isSome(bootstrap)) return bootstrap.value;
  const saved = readSavedConfig();
  if (saved !== null) return saved;
  return defaultConfig();
});
