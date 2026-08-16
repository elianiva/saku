/**
 * The conn machine's property tests (machine.test.ts): the wire lifecycle
 * edges — boot → online/offline, the retry loop, the reconnect, and the
 * command-carrying transitions. Exercised as pure machine steps; no foldkit
 * runtime, no DOM, no wire service (the edge commands are never executed).
 *
 * The whole machine is specified as one property: for ANY state and ANY
 * message, the step either transitions to a state the oracle computes
 * (with the oracle's command count) or is Ignored — and the Ignored arm is
 * behavior, not absence (a retry tick while online does nothing; a
 * handshake while already online is not a transition).
 */

import { describe, expect, it } from "vitest";
import type { Arbitrary } from "fast-check";
import { assert, constant, integer, oneof, option, property, record, string } from "fast-check";
import { HelloOk } from "@saku/wire";

import { connMachine, Connecting, Offline, Online } from "./machine.ts";
import type { Conn } from "./machine.ts";
import { Connected, ConnectFailed, ConnectionClosed, RetryRequested } from "./message.ts";

/** The message spec: the discriminant plus the payload the oracle reads. */
type MessageSpec =
  | {
      readonly kind: "Connected";
      readonly hello: { readonly pid: number; readonly version: string };
    }
  | { readonly kind: "ConnectFailed"; readonly message: string }
  | { readonly kind: "ConnectionClosed" }
  | { readonly kind: "RetryRequested" };

const helloArb = record({ pid: integer(), version: string({ maxLength: 20 }) });

const messageSpecArb: Arbitrary<MessageSpec> = oneof(
  record({ hello: helloArb, kind: constant("Connected" as const) }),
  record({ kind: constant("ConnectFailed" as const), message: string({ maxLength: 20 }) }),
  record({ kind: constant("ConnectionClosed" as const) }),
  record({ kind: constant("RetryRequested" as const) }),
);

const toMessage = (spec: MessageSpec) => {
  switch (spec.kind) {
    case "Connected": {
      return Connected({ hello: HelloOk.make(spec.hello) });
    }
    case "ConnectFailed": {
      return ConnectFailed({ message: spec.message });
    }
    case "ConnectionClosed": {
      return ConnectionClosed();
    }
    case "RetryRequested": {
      return RetryRequested();
    }
    // Exhaustive: every MessageSpec kind returns above.
    default: {
      return spec;
    }
  }
};

const stateArb: Arbitrary<Conn> = oneof(
  constant(Connecting()),
  record({ pid: integer(), version: string({ maxLength: 20 }) }).map(({ pid, version }) =>
    Online({ pid, version }),
  ),
  record({ error: option(string({ maxLength: 20 }), { nil: undefined }) }).map(({ error }) =>
    Offline({ error }),
  ),
);

/** The online state a Connected message leads to. */
const onlineFrom = (hello: MessageSpec & { kind: "Connected" }) =>
  Online({ pid: hello.hello.pid, version: hello.hello.version });

/**
 * The machine's spec, from the module contract: Connecting dials (a
 * handshake succeeds or fails); Online falls only on a closed socket;
 * Offline retries, reconnects, or replaces the shown error; everything else
 * is ignored. Commands ride along on Connected (refresh the registry) and
 * RetryRequested (dial again).
 */
const stepOracle = (state: Conn, spec: MessageSpec) => {
  switch (state._tag) {
    case "Connecting": {
      if (spec.kind === "Connected") {
        return { _tag: "Transitioned" as const, commands: 1, state: onlineFrom(spec) };
      }
      if (spec.kind === "ConnectFailed") {
        return {
          _tag: "Transitioned" as const,
          commands: 0,
          state: Offline({ error: spec.message }),
        };
      }
      return { _tag: "Ignored" as const };
    }
    case "Online": {
      if (spec.kind === "ConnectionClosed") {
        return {
          _tag: "Transitioned" as const,
          commands: 0,
          state: Offline({ error: "connection closed" }),
        };
      }
      return { _tag: "Ignored" as const };
    }
    case "Offline": {
      if (spec.kind === "RetryRequested") {
        return { _tag: "Transitioned" as const, commands: 1, state: Connecting() };
      }
      if (spec.kind === "Connected") {
        return { _tag: "Transitioned" as const, commands: 1, state: onlineFrom(spec) };
      }
      if (spec.kind === "ConnectFailed") {
        return {
          _tag: "Transitioned" as const,
          commands: 0,
          state: Offline({ error: spec.message }),
        };
      }
      if (spec.kind === "ConnectionClosed") {
        return {
          _tag: "Transitioned" as const,
          commands: 0,
          state: Offline({ error: "connection closed" }),
        };
      }
      return { _tag: "Ignored" as const };
    }
    // Exhaustive: every Conn state returns above.
    default: {
      return state;
    }
  }
};

describe("conn machine", () => {
  it("starts connecting", () => {
    expect(connMachine.initial).toEqual(Connecting());
  });

  it("transitions exactly as the spec dictates for any state and message", () => {
    assert(
      property(stateArb, messageSpecArb, (state, spec) => {
        const result = connMachine.step(state, toMessage(spec));
        const expected = stepOracle(state, spec);
        if (expected._tag === "Ignored") {
          expect(result._tag).toBe("Ignored");
        } else {
          if (result._tag === "Ignored") {
            throw new Error(`expected a transition from ${state._tag}, got Ignored`);
          }
          expect(result.state).toEqual(expected.state);
          expect(result.commands).toHaveLength(expected.commands);
        }
      }),
    );
  });
});
