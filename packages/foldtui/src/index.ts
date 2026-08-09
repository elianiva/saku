/**
 * foldtui — render foldkit (Elm-architected, Effect-based) applications in
 * the terminal via OpenTUI.
 *
 * ```ts
 * import { makeApplication, run } from 'foldtui'
 * import { Model, init, update, view } from './main.js'
 *
 * await run(makeApplication({ Model, init, update, view }))
 * ```
 */

export { makeApplication, run, runWithRenderer } from "./runtime.ts";
export type { TuiApplication, TuiHandle } from "./runtime.ts";
