/**
 * The saku console (main.ts): a foldkit TEA application with URL routing
 * and DevTools, following lutra's root-application shape (lutra main.ts).
 *
 * One root Model orchestrating two Submodels behind `Got*Message`
 * boundaries: the rail (registry) and the thread pane (trail + live run +
 * composer), plus the connection machine. The wire connection (`Wire`
 * service — the typed client, built against the bootstrap config) is the
 * only resource; subscriptions feed wire events in as root messages, which
 * the root routes to the owning submodel.
 *
 * The console never holds session state: it lists threads, loads the trail
 * with `get_entries`, streams live events into the live region, and persists
 * everything back to the worker (CONTEXT.md: Console). The URL is the
 * selection: `/thread/:id` pins a thread; the route change drives the pane.
 */

import { Runtime, Url } from "foldkit";
import type { UrlRequest } from "foldkit/navigation";

import { init } from "./root/init.ts";
import { ChangedRoute, Navigated, RootMessage } from "./root/message.ts";
import { Model } from "./root/model.ts";
import { subscriptions } from "./root/subscriptions.ts";
import { update } from "./root/update.ts";
import { view } from "./root/view.ts";
import { parseRoute } from "./route.ts";
import { WireLive } from "./wire.ts";

export const application = Runtime.makeApplication({
  Model,
  init: (url: Url.Url) => init(url),
  update,
  view,
  container: document.getElementById("root"),
  resources: WireLive,
  subscriptions,
  routing: {
    onUrlRequest: (request: UrlRequest) => Navigated({ request }),
    onUrlChange: (url: Url.Url) => ChangedRoute({ route: parseRoute(url) }),
  },
  devTools: { Message: RootMessage },
});

export type { Model, RootMessage };
