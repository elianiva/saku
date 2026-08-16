/**
 * Ambient types for `bun:test` used by the deploy tests.
 *
 * The lint's type-aware check doesn't apply the package tsconfig's
 * `types` field to files outside its `include` (test/ is excluded), so
 * the `bun:test` module declaration from bun-types never lands. This
 * shim declares the small surface the suite uses; bun's own types are
 * authoritative at runtime.
 */
declare module "bun:test" {
  export interface Expect<T = unknown> {
    toBe: (expected: T) => void;
    toBeGreaterThanOrEqual: (n: number) => void;
    toBeUndefined: () => void;
    toContain: (expected: T) => void;
    toEqual: (expected: T) => void;
  }
  export interface TestOptions {
    /** Per-test timeout in milliseconds (bun's default is 5000). */
    readonly timeout?: number;
  }
  export function expect<T>(value: T): Expect<T>;
  export function test(name: string, fn: () => void | Promise<void>, opts?: TestOptions): void;
  export function beforeAll(fn: () => void | Promise<void>): void;
  export function afterAll(fn: () => void | Promise<void>): void;
}
