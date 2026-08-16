// @saku/cli — the headless console + the worker's steward.
//
// Owns the worker lifecycle (auto-start on demand, stop, status), drives
// threads over the wire (list/create/attach/prompt/steer/abort), and
// supports scripting shapes like `saku run "prompt" --thread <id>`.

// The CLI's tagged failure type: the shape `main`'s error channel carries
// to the process edge (usage, resolution, and daemon/env failures).
export { CliError } from "./cli-error.ts";
