// @saku/tui — the console. A foldtui application that attaches to the
// worker over the wire: thread list screen, thread view (stream, entries,
// dialogs, input, status bar). Consoles never hold session state; they
// attach, tail, and command.
export { makeApp } from "./app.ts";
export { WireHub } from "./wire.ts";
export type { Model, Msg, Dialog, ListScreen, ThreadScreen } from "./app.ts";
