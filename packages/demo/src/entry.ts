// Terminal entry point. Run with `pnpm demo` (or `bun run` this file).
import { makeApplication, run } from "foldtui";

import { Model, init, update, view } from "./main.js";

const app = makeApplication({ Model, init, update, view });

await run(app);
