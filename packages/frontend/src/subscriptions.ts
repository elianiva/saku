/**
 * The console's subscriptions (subscriptions.ts): the bridge from the wire
 * client's callback events into the TEA world. One persistent stream attaches
 * the client's listeners for the app's lifetime and forwards every payload
 * as a message: session events (filtered by thread in update), registry
 * broadcasts, connection-level errors, and the close signal.
 */

import { Effect, Queue, Stream } from "effect";
import { Subscription } from "foldkit";

import {
  ConnectionClosed,
  ServerErrorNotice,
  ThreadChanged,
  WireEvent,
  type AppMessage,
} from "./message.ts";
import type { Model } from "./model.ts";
import { decodeSessionEvent } from "./projection.ts";
import { Wire } from "./wire.ts";

export const subscriptions = Subscription.make<Model, AppMessage, Wire>()(() => ({
  wire: Subscription.persistent(
    Stream.service(Wire).pipe(
      Stream.flatMap(({ client }) =>
        Stream.callback<AppMessage>((queue) =>
          Effect.gen(function* () {
            const offEvent = client.on("event", (payload) => {
              // Decode at the boundary: the wire's TS-typed event becomes the
              // console's schema projection (ADR 0005) before anything folds it.
              Queue.offerUnsafe(
                queue,
                WireEvent({ threadId: payload.threadId, event: decodeSessionEvent(payload.event) }),
              );
            });
            const offChanged = client.on("thread_changed", (thread) => {
              Queue.offerUnsafe(queue, ThreadChanged({ thread }));
            });
            const offError = client.on("error", (payload) => {
              Queue.offerUnsafe(queue, ServerErrorNotice({ message: payload.message }));
            });
            const offClose = client.on("close", () => {
              Queue.offerUnsafe(queue, ConnectionClosed());
            });
            yield* Effect.acquireRelease(
              Effect.sync(() => ({ offEvent, offChanged, offError, offClose })),
              (handles) =>
                Effect.sync(() => {
                  handles.offEvent();
                  handles.offChanged();
                  handles.offError();
                  handles.offClose();
                }),
            );
          }),
        ),
      ),
    ),
  ),
}));
