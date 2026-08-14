/**
 * The console's routes (route.ts): two arms behind one URL scheme, mirroring
 * lutra's route module (route.ts). The rail is always visible; the thread
 * pane derives its active thread from the route.
 *
 *   Threads = "/"                → rail + the pane's empty state
 *   Thread  = "/thread/:id"      → rail + that thread's pane (id decoded
 *                                  through the plain-string segment)
 *
 * Any other path falls back to Threads — the console has no NotFound screen;
 * the root route is the safe landing. Selection IS navigation: clicking a
 * rail row pushes `/thread/:id`, and the URL change drives the thread
 * submodel (ADR 0009's route-derived submodel state).
 */

import { pipe, Schema as S } from "effect";
import { Route } from "foldkit";

/** The root: the rail plus the pane's empty state. */
export const ThreadsRoute = Route.r("Threads");
/** A thread's pane, attached to one thread by id. */
export const ThreadRoute = Route.r("Thread", { id: S.String });

export const AppRoute = S.Union([ThreadRoute, ThreadsRoute]);
export type AppRoute = S.Schema.Type<typeof AppRoute>;

// -- routers (biparsers) matching each route's URL --------------------------

const threadsRouter = pipe(Route.root, Route.mapTo(ThreadsRoute));
const threadRouter = pipe(
  Route.literal("thread"),
  Route.slash(Route.schemaSegment("id", S.String)),
  Route.mapTo(ThreadRoute),
);
// Most specific first, so `/thread/:id` wins over the root.
const router = Route.oneOf(threadRouter, threadsRouter);

/** Parse a URL into an AppRoute; anything unmatched falls back to Threads. */
export const parseRoute = Route.parseUrlWithFallback(router, {
  // The fallback constructor receives the unmatched path; the root route
  // ignores it — the console has no NotFound screen.
  make: () => ThreadsRoute(),
});
