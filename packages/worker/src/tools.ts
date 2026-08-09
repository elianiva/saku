/**
 * Tools (tools.ts): pi's built-in execution tools, bound to a thread's
 * execution environment.
 *
 * Core's tools are `AgentHarnessTool`s whose `execute` takes an
 * `ExecutionToolContext { env }` as a fifth argument; the Agent runtime wants
 * plain `AgentTool`s. The adapter pins a thread's `LocalEnv` into the context
 * and re-exposes the harness tool as an agent tool.
 */

import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  type AgentHarnessTool,
  type ExecutionEnv,
} from "@earendil-works/pi-agent-core";
import type { AgentTool } from "@earendil-works/pi-agent-core";

const adapt = <TContext extends { env: ExecutionEnv }, TDetails>(
  tool: AgentHarnessTool<TContext, any, TDetails>,
  env: ExecutionEnv,
): AgentTool<any, TDetails> => ({
  ...tool,
  label: tool.label ?? tool.name,
  execute: (toolCallId, params, signal, onUpdate) =>
    tool.execute(toolCallId, params, signal, onUpdate, { env } as TContext),
});

/** The standard hand toolset for a thread: read, bash, edit, write. */
export const buildTools = (env: ExecutionEnv): AgentTool[] => [
  adapt(createReadTool(), env),
  adapt(createBashTool(), env),
  adapt(createEditTool(), env),
  adapt(createWriteTool(), env),
];
