/**
 * The provider-neutral remote-machine contract: lifecycle and bootstrap
 * primitives for a hub-provisioned machine. Box and Freestyle implement this
 * contract; the hub never depends on either provider's API vocabulary.
 */

import { Effect, Schedule, Schema } from "effect";

const taggedError = Schema.TaggedError;

/** A remote machine returned by a provider. Status stays provider-defined. */
export interface RemoteMachine {
  readonly id: string;
  readonly status: string;
}

/** The tagged failure shape providers use at the generic boundary. */
export interface RemoteMachineProviderError {
  readonly _tag?: string;
}

/** The result of a command run through a remote-machine provider. */
export interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly success: boolean;
}

/** A generic timeout after a provider kept a machine unready. */
export class RemoteMachineError extends taggedError<RemoteMachineError>()("RemoteMachineError", {
  machineId: Schema.optional(Schema.String),
  message: Schema.String,
  status: Schema.optional(Schema.String),
}) {}

interface RemoteMachineNotReady extends RemoteMachineProviderError {
  readonly _tag: "RemoteMachineNotReady";
  readonly status: string;
}

const remoteMachineNotReady = (status: string) =>
  ({ _tag: "RemoteMachineNotReady", status }) satisfies RemoteMachineNotReady;

const isRemoteMachineNotReady = (
  error: RemoteMachineProviderError,
): error is RemoteMachineNotReady =>
  error._tag === "RemoteMachineNotReady" && "status" in error && typeof error.status === "string";

/**
 * The low-level operations a lifecycle-managed remote-machine provider must
 * expose. Provider errors remain opaque at this boundary and are normalized
 * by the provider-specific EnvProvisioner implementation.
 */
export interface RemoteMachineProvider<
  E extends RemoteMachineProviderError = RemoteMachineProviderError,
> {
  readonly create: (input: {
    /** Provider-neutral metadata used to identify the thread's machine. */
    env?: Record<string, string>;
  }) => Effect.Effect<RemoteMachine, E>;
  readonly get: (machineId: string) => Effect.Effect<RemoteMachine, E>;
  readonly isReady: (machine: RemoteMachine) => boolean;
  readonly runCommand: (
    machineId: string,
    command: string,
    options?: { timeoutSeconds?: number; cwd?: string },
  ) => Effect.Effect<CommandResult, E>;
  readonly writeFile: (machineId: string, path: string, content: string) => Effect.Effect<void, E>;
  readonly readFile: (machineId: string, path: string) => Effect.Effect<string, E>;
  readonly suspend: (machineId: string) => Effect.Effect<void, E>;
  readonly resume: (machineId: string) => Effect.Effect<void, E>;
}

/** Poll a provider until its machine reaches the provider's ready state. */
export const pollUntilReady = <E extends RemoteMachineProviderError>(
  provider: RemoteMachineProvider<E>,
  machineId: string,
  options: {
    intervalMs?: number;
    timeoutMs?: number;
    log?: (message: string) => Effect.Effect<void>;
  } = {},
) => {
  const intervalMs = options.intervalMs ?? 1000;
  const timeoutMs = options.timeoutMs ?? 5 * 60 * 1000;
  const attempt = Effect.gen(function* attempt() {
    const machine = yield* provider.get(machineId);
    if (provider.isReady(machine)) {
      return machine;
    }
    return yield* Effect.fail(remoteMachineNotReady(machine.status));
  });
  return attempt.pipe(
    Effect.retry({
      schedule: Schedule.spaced(`${intervalMs} millis`).pipe(
        Schedule.upTo({ duration: `${timeoutMs} millis` }),
      ),
      while: isRemoteMachineNotReady,
    }),
    Effect.catchIf(isRemoteMachineNotReady, (notReady) =>
      Effect.fail(
        new RemoteMachineError({
          machineId,
          message: `remote machine ${machineId} not ready after ${timeoutMs}ms (status ${notReady.status})`,
          status: notReady.status,
        }),
      ),
    ),
  );
};
