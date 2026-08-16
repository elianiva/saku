/**
 * The deployment entry (worker.ts): the Worker behind the deployment's
 * domain — the single address consoles and env daemons dial.
 *
 * It routes the two WebSocket surfaces to the hub DO (which accepts and
 * serves them), and 404s everything else (the foldkit frontend will take
 * `/` in the next pass). The DO classes are exported from this module
 * because the namespace bindings declare them by class name.
 */

import type { DeploymentEnv } from "./env.ts";

export { SakuHubDO } from "./hub-do.ts";
export { SakuThreadDO } from "./thread-do.ts";

export default {
  async fetch(request: Request, env: DeploymentEnv) {
    const path = new URL(request.url).pathname;
    if (path === "/ws" || path === "/relay") {
      // The upgrade lands in the hub DO, which accepts the socket and
      // serves the wire or the relay from the shared cores.
      const hub = env.HUB.get(env.HUB.idFromName("hub"));
      return await hub.fetch(request);
    }
    return new Response("saku: not found", { status: 404 });
  },
};
