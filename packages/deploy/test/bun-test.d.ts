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
  export interface Expect {
    toBe(expected: unknown): void;
    toEqual(expected: unknown): void;
    toContain(expected: unknown): void;
    toBeGreaterThanOrEqual(n: number): void;
    toBeUndefined(): void;
  }
  export function expect<T>(value: T): Expect;
  export function test(name: string, fn: () => void | Promise<void>, opts?: object): void;
  export function beforeAll(fn: () => void | Promise<void>): void;
  export function afterAll(fn: () => void | Promise<void>): void;
}
