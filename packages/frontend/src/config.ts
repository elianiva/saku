/**
 * Connection config (config.ts): where the console dials.
 *
 * Resolution order: the dev bootstrap (`/__saku` — the vite dev server
 * publishing the local worker daemon's URL + token from ~/.saku) wins; then
 * a saved override in localStorage (`saku.config` — the v1 single-owner flow
 * for a deployed hub: its domain + the deployment secret); then the
 * same-origin `/ws` default (ADR 0002: the console is served from the hub's
 * domain). The hub's login/cookie minting is a later slice.
 */

export interface SakuConfig {
  readonly url: string;
  readonly token: string;
}

const LOCALSTORAGE_KEY = "saku.config";

const defaultConfig = (): SakuConfig => {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return { url: `${protocol}//${window.location.host}/ws`, token: "" };
};

/** The dev bootstrap endpoint; `null` when absent (production) or unparsable. */
export const fetchBootstrap = (): Promise<SakuConfig | null> =>
  fetch("/__saku")
    .then((response) =>
      response.ok ? (response.json() as Promise<Partial<SakuConfig>>) : null,
    )
    .then((parsed) =>
      parsed !== null && typeof parsed.url === "string" && typeof parsed.token === "string"
        ? { url: parsed.url, token: parsed.token }
        : null,
    )
    .catch(() => null);

export const readSavedConfig = (): SakuConfig | null => {
  const raw = window.localStorage.getItem(LOCALSTORAGE_KEY);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<SakuConfig>;
    if (typeof parsed.url === "string" && typeof parsed.token === "string") {
      return { url: parsed.url, token: parsed.token };
    }
    return null;
  } catch {
    return null;
  }
};

export const resolveConfig = async (): Promise<SakuConfig> => {
  const bootstrap = await fetchBootstrap();
  if (bootstrap !== null) return bootstrap;
  const saved = readSavedConfig();
  if (saved !== null) return saved;
  return defaultConfig();
};
