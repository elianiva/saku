/**
 * The wire package — saku's wire protocol: the typed, versioned vocabulary
 * that consoles (frontend, CLI) and the hub (or, transitionally, the local
 * daemon) exchange over WebSocket JSONL.
 *
 * The package is organized by protocol feature, not by technical layer:
 *
 * - `version.ts`  — protocol version, gate for handshake compatibility
 * - `hello.ts`    — connection handshake (token, role, version)
 * - `thread.ts`   — the registry layer pi lacks (threads, modes, states, env)
 * - `session.ts`  — pi's own session vocabulary, carried verbatim
 * - `skills.ts`   — the hub-hosted skills store (list / import / delete)
 * - `envelope.ts` — top-level frames (command / response / event)
 * - `transport.ts`— JSONL framing over WebSocket
 * - `client.ts`   — `WireClient.make`, the console side of the wire (an
 *     effect-machine actor)
 */

export { WIRE_VERSION } from "./version.ts";
export { ConsoleRole, Hello, HelloOk } from "./hello.ts";
export {
  ArchiveThreadCommand,
  CreateThreadCommand,
  DeleteThreadCommand,
  GetThreadCommand,
  ListThreadsCommand,
  RenameThreadCommand,
  ThreadChanged,
  ThreadCommand,
  ThreadEnvState,
  ThreadInfo,
  ThreadMode,
  ThreadSource,
  ThreadState,
  UnarchiveThreadCommand,
  resolveThread,
  shortThreadId,
} from "./thread.ts";
export {
  AddProjectCommand,
  AddProjectResponse,
  BrowseProjectDirsCommand,
  BrowseProjectDirsResponse,
  ListProjectsCommand,
  ProjectCommand,
  ProjectDirEntry,
  ProjectInfo,
  ProjectResponse,
  RemoveProjectCommand,
  RemoveProjectResponse,
} from "./projects.ts";
export type { BrowseProjectDirsResult } from "./projects.ts";
export {
  ImportPiSessionCommand,
  ImportPiSessionResponse,
  ListPiSessionsCommand,
  ListPiSessionsResponse,
  PiSessionCommand,
  PiSessionInfo,
  PiSessionResponse,
} from "./pi-sessions.ts";
export {
  AbortCommand,
  AbortResponse,
  ArchiveThreadResponse,
  BranchCommand,
  BranchResponse,
  CompactCommand,
  CompactResponse,
  CreateThreadResponse,
  DeleteThreadResponse,
  FollowUpCommand,
  FollowUpResponse,
  GetAvailableModelsCommand,
  GetAvailableModelsResponse,
  GetAvailableThinkingLevelsCommand,
  GetAvailableThinkingLevelsResponse,
  GetEntriesCommand,
  GetEntriesResponse,
  GetSessionStatsCommand,
  GetSessionStatsResponse,
  GetStateCommand,
  GetStateResponse,
  GetThreadResponse,
  ListThreadsResponse,
  PromptCommand,
  PromptResponse,
  READ_ONLY_COMMANDS,
  RenameThreadResponse,
  ResponsePayload,
  SakuSessionEvent,
  SessionCommand,
  SetAutoCompactionCommand,
  SetAutoCompactionResponse,
  SetFollowUpModeCommand,
  SetFollowUpModeResponse,
  SetModelCommand,
  SetModelResponse,
  SetSessionNameCommand,
  SetSessionNameResponse,
  SetSteeringModeCommand,
  SetSteeringModeResponse,
  SetThinkingLevelCommand,
  SetThinkingLevelResponse,
  SteerCommand,
  SteerResponse,
  THINKING_LEVELS,
  ThinkingLevelSchema,
  ThreadSessionState,
  UnarchiveThreadResponse,
  WireModelInfo,
} from "./session.ts";
export type { SessionEventFromSaku, SessionResponse, SessionWireEvent } from "./session.ts";
export type {
  AgentEvent,
  CompactResult,
  Entry,
  SessionStats,
  ThinkingLevel,
} from "@earendil-works/pi-agent-core";
export { opaque } from "./opaque.ts";
export {
  DeleteSkillCommand,
  DeleteSkillResponse,
  ImportSkillCommand,
  ImportSkillResponse,
  ListSkillsCommand,
  ListSkillsResponse,
  SkillCommand,
  SkillInfo,
  SkillResponse,
  SkillScope,
} from "./skills.ts";
export {
  ErrorEvent,
  EventFrame,
  ResponseError,
  ResponseOk,
  WireCommand,
  WireEvent,
} from "./envelope.ts";
export {
  WireFrameError,
  decodeFrame,
  isSocketMessage,
  parseFrame,
  serializeFrame,
} from "./transport.ts";
export type { JsonValue, SocketMessage, WireFrame } from "./transport.ts";
export { WireError } from "./wire-error.ts";
export { WireClient } from "./client.ts";
export type {
  ClientEventKind,
  ClientEvents,
  WireClientApi,
  WorkerClientOptions,
} from "./client.ts";
