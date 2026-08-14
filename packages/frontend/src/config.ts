/**
 * Connection config (config.ts): where the console dials.
 *
 * Resolution order: the dev bootstrap (`/__saku` — the vite dev server
 * publishing the local worker daemon's URL + token from ~/.saku, verified
 * live by a wire handshake probe) wins; then a saved override in
 * localStorage (`saku.config` — the v1 single-owner flow for a deployed
 * hub: its domain + the deployment secret); then the same-origin `/ws`
 * default (ADR 0002: the console is served from the hub's domain). The
 * hub's login/cookie minting is a later slice.
 *
 * A bootstrap that reports no live daemon (`{url: null}`) resolves to the
 * `offline` state instead of falling through to a fallback: the dev
 * bootstrap's word about the local daemon is authoritative, and a stale
 * published URL must not send the browser dialing dead sockets. The
 * console shows the offline state and polls the bootstrap until the
 * daemon is back (subscriptions.ts).
 *
 * Everything is an Effect with `never` failure: a missing or unparsable
 * bootstrap falls through to the next source instead of surfacing an error.
 */

import { Effect, Option, Result, Schema as S } from "effect";

/** A verified wire endpoint: where to dial + the credential it enforces. */
export interface SakuEndpoint {
  readonly url: string;
  readonly token: string;
}

/** What boot resolution found. */
export type ResolvedConfig =
  | { readonly _tag: "daemon"; readonly endpoint: SakuEndpoint }
  | { readonly _tag: "offline" }
  | { readonly _tag: "fallback"; readonly endpoint: SakuEndpoint };

const BootstrapSchema = S.Struct({
  url: S.NullOr(S.String),
  token: S.NullOr(S.String),
});

const LOCALSTORAGE_KEY = "saku.config";

export const defaultConfig = (): SakuEndpoint => {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return { url: `${protocol}//${window.location.host}/ws`, token: "" };
};

/**
 * The dev bootstrap endpoint: `daemon` when it verified a live daemon,
 * `offline` when it reports none (the vite plugin probes before
 * publishing); `None` when absent (production) or unparsable.
 */
export const fetchBootstrap: Effect.Effect<
  Option.Option<ResolvedConfig>,
  never
> = Effect.tryPromise({
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
      : Effect.sync(() => {
          const decoded = Option.getOrNull(S.decodeUnknownOption(BootstrapSchema)(parsed));
          if (decoded === null) return Option.none();
          // A null url is the daemon-offline marker; a half-payload is
          // treated as offline too — never as a fallback trigger.
          return decoded.url !== null && decoded.token !== null
            ? Option.some({
                _tag: "daemon",
                endpoint: { url: decoded.url, token: decoded.token },
              })
            : Option.some({ _tag: "offline" });
        }),
  ),
);

export const readSavedConfig = (): SakuEndpoint | null => {
  const raw = window.localStorage.getItem(LOCALSTORAGE_KEY);
  if (raw === null) return null;
  // A corrupt saved config falls through to the next source, like a
  // missing bootstrap (Result.try at the sync parse point, house style).
  const parsed = Result.try(() => JSON.parse(raw) as unknown);
  if (Result.isFailure(parsed)) return null;
  const decoded = Option.getOrNull(S.decodeUnknownOption(BootstrapSchema)(parsed.success));
  // A saved half-payload (null url/token) is not an endpoint.
  if (decoded === null || decoded.url === null || decoded.token === null) return null;
  return { url: decoded.url, token: decoded.token };
};

export const resolveConfig: Effect.Effect<ResolvedConfig, never> = Effect.gen(function* () {
  const bootstrap = yield* fetchBootstrap;
  if (Option.isSome(bootstrap)) return bootstrap.value;
  const saved = readSavedConfig();
  if (saved !== null) return { _tag: "fallback", endpoint: saved };
  return { _tag: "fallback", endpoint: defaultConfig() };
});
