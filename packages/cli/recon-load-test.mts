import { Effect } from "effect";
import { WorkerClient } from "@saku/wire";

const client = new WorkerClient({ socketPath: "/tmp/saku-loadtest2/worker.sock", token: "t", role: "cli" });
const started = Date.now();
try {
  const hello = await Effect.runPromise(Effect.timeout(client.connect(), "2 seconds"));
  console.log("connect ok:", JSON.stringify(hello), "in", Date.now() - started, "ms");
} catch (e) {
  console.log("connect failed:", (e as { _tag?: string })._tag, JSON.stringify(e), "in", Date.now() - started, "ms");
}
