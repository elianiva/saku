/**
 * The saku console (main.ts): a foldkit TEA application.
 *
 * One model, one wire connection (`Wire` service — the typed client, built
 * against the bootstrap config), one subscription feeding wire events in as
 * messages. The view is three regions: the top bar (connection), the thread
 * rail, and the thread pane (header, entry trail, live run, composer).
 *
 * The console never holds session state: it lists threads, loads the trail
 * with `get_entries`, streams live events into the live region, and persists
 * everything back to the worker (CONTEXT.md: Console).
 */

import { Runtime } from "foldkit";

import { init } from "./init.ts";
import { AppMessage } from "./message.ts";
import { Model } from "./model.ts";
import { subscriptions } from "./subscriptions.ts";
import { update } from "./update.ts";
import { view } from "./view.ts";
import { WireLive, Wire } from "./wire.ts";

export const application = Runtime.makeApplication({
  Model,
  init,
  update,
  view,
  container: document.getElementById("root"),
  resources: WireLive,
  subscriptions,
});

export type { Model, AppMessage };
