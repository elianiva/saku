// @saku/worker — the execution pod. A long-lived daemon process per machine
// that owns the thread registry and hosts one pi session runtime per thread.
//
// Three seams keep the cloud future a drop-in (ADR 0002):
//   1. Storage — pi's `SessionStorage` (pi-agent-core). A DO-backed
//      implementation swaps in under the same harness.
//   2. Transport — the wire (ADR 0001) is transport-agnostic: unix socket
//      today, Worker/DO later.
//   3. Hands — execution happens behind the thread's mode; only `local`
//      exists in v1 (the daemon's own filesystem), sandbox providers come later.
export {};
