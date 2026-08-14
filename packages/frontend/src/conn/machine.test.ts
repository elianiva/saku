/**
 * The conn machine's unit tests (machine.test.ts): the wire lifecycle edges —
 * boot → online/offline, the retry loop, the reconnect, and the
 * command-carrying transitions. Exercised as pure machine steps; no foldkit
 * runtime, no DOM, no wire service (the edge commands are never executed).
 */

import { describe, expect, it } from "vitest";
import { HelloOk } from "@saku/wire";
import type { RootMessage } from "../root/message.ts";

import { connMachine, Connecting, Offline, Online, type Conn } from "./machine.ts";
import { Connected, ConnectFailed, ConnectionClosed, RetryRequested } from "./message.ts";

const hello = HelloOk.make({ pid: 1, version: "0.1.0" });

const online = Online({ pid: 1, version: "0.1.0" });
const offline = (error = "nope"): Conn => Offline({ error });

/** Step and narrow: the test's interest is the Transitioned arm. */
const step = (state: Conn, message: RootMessage) => {
  const result = connMachine.step(state, message);
  if (result._tag === "Ignored") {
    throw new Error(`expected a transition from ${state._tag}, got Ignored`);
  }
  return result;
};

describe("conn machine", () => {
  it("starts connecting", () => {
    expect(connMachine.initial).toEqual(Connecting());
  });

  it("goes online on a successful handshake and fires the registry refresh", () => {
    const result = step(connMachine.initial, Connected({ hello }));
    expect(result.state).toEqual(online);
    expect(result.commands).toHaveLength(1);
  });

  it("goes offline on a failed handshake, carrying the error", () => {
    const result = step(connMachine.initial, ConnectFailed({ message: "refused" }));
    expect(result.state).toEqual(offline("refused"));
    expect(result.commands).toHaveLength(0);
  });

  it("retries from offline: back to connecting and the connect command rides along", () => {
    const result = step(offline(), RetryRequested());
    expect(result.state).toEqual(Connecting());
    expect(result.commands).toHaveLength(1);
  });

  it("a failed retry stays offline and replaces the shown error", () => {
    const result = step(offline("first"), ConnectFailed({ message: "second" }));
    expect(result.state).toEqual(offline("second"));
  });

  it("reconnects from offline on a later successful handshake", () => {
    const result = step(offline(), Connected({ hello }));
    expect(result.state).toEqual(online);
    expect(result.commands).toHaveLength(1);
  });

  it("a closed socket while online goes offline", () => {
    const result = step(online, ConnectionClosed());
    expect(result.state).toEqual(offline("connection closed"));
  });

  it("ignores messages with no edge from the current state", () => {
    // A retry tick while online is not a transition.
    const ticked = connMachine.step(online, RetryRequested());
    expect(ticked._tag).toBe("Ignored");
    // A handshake success while already online is not a transition either.
    const duplicated = connMachine.step(online, Connected({ hello }));
    expect(duplicated._tag).toBe("Ignored");
  });
});
