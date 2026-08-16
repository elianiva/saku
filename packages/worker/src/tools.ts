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
} from "@earendil-works/pi-agent-core";
import type {
  AgentHarnessTool,
  AgentTool,
  ExecutionEnv,
  ExecutionToolContext,
} from "@earendil-works/pi-agent-core";
import type { TSchema } from "@earendil-works/pi-ai";

const adapt = <TParameters extends TSchema, TDetails>(
  tool: AgentHarnessTool<ExecutionToolContext, TParameters, TDetails>,
  env: ExecutionEnv,
): AgentTool<TParameters, TDetails> => ({
  ...tool,
  execute: async (toolCallId, params, signal, onUpdate) =>
    await tool.execute(toolCallId, params, signal, onUpdate, { env }),
  label: tool.label ?? tool.name,
});

/** The standard hand toolset for a thread: read, bash, edit, write. */
export const buildTools = (env: ExecutionEnv) => [
  adapt(createReadTool(), env),
  adapt(createBashTool(), env),
  adapt(createEditTool(), env),
  adapt(createWriteTool(), env),
];
