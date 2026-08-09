// @saku/wire — the protocol between consoles (TUI, CLI, GUI) and the worker.
//
// The wire is pi's RPC vocabulary extended with one thing pi lacks: threads.
// See ADR 0001 — the vocabulary survives into the cloud era; only the
// transport swaps (unix socket today, Worker/DO later).

export type {
  RpcCommand,
  RpcExtensionUIRequest,
  RpcExtensionUIResponse,
  RpcResponse,
  RpcSessionState,
} from "@earendil-works/pi-coding-agent";

/**
 * A thread's hands policy. Hard-pinned at creation — switching modes
 * mid-thread changes which filesystem the hands (ADR 0002) see.
 *
 * v1: `local` only. `sandbox` and `any` are designed for, not built.
 */
export type ThreadMode = "local" | "sandbox" | "any";

export interface ThreadInfo {
  readonly id: string;
  readonly name: string;
  readonly cwd: string;
  readonly mode: ThreadMode;
  /** Highest log sequence the thread's session has reached. */
  readonly tailSeq: number;
}

/** Registry ops: the control-plane layer pi doesn't have. */
export type ThreadCommand =
  | { readonly type: "list_threads" }
  | {
      readonly type: "create_thread";
      readonly name: string;
      readonly cwd: string;
      readonly mode?: ThreadMode;
    }
  | { readonly type: "get_thread"; readonly threadId: string }
  | { readonly type: "delete_thread"; readonly threadId: string }
  | { readonly type: "attach"; readonly threadId: string }
  | { readonly type: "detach" };
