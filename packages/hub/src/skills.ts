/**
 * The hub's skills store (skills.ts): the hub-hosted skills store of
 * ADR 0007 — amp-style, scoped `personal` or `workspace`, imported from
 * repos. Lives on the `KvStore` seam (keys: `skills/<id>`), like the
 * registry; the wire's minimal slice: list, import, delete. Records keep
 * `source` + `version` from day one so versioning and sharing UX are
 * additive later.
 */

import { Effect, Ref } from "effect";
import type { SkillInfo, SkillScope } from "@saku/wire";

import { HubError } from "./hub-error.ts";
import type { KvStore } from "@saku/store";

export interface SkillsStoreShape {
  readonly list: () => Effect.Effect<readonly SkillInfo[], HubError>;
  /** Import from a repo; the name is derived from the source (git-style). */
  readonly import: (input: {
    source: string;
    scope?: SkillScope;
  }) => Effect.Effect<SkillInfo, HubError>;
  /** Remove a skill; `false` when the id is unknown. */
  readonly delete: (id: string) => Effect.Effect<boolean, HubError>;
}

const skillKey = (id: string): string => `skills/${id}`;

const encodeSkill = (skill: SkillInfo): Uint8Array =>
  new TextEncoder().encode(`${JSON.stringify(skill)}\n`);

const decodeSkill = (value: Uint8Array): SkillInfo =>
  JSON.parse(new TextDecoder().decode(value)) as SkillInfo;

const toHubError =
  (message: string) =>
  (error: unknown): HubError =>
    new HubError({ message, cause: error });

/** The default name for an imported repo: `owner/repo` → `repo`. */
export const skillNameFromSource = (source: string): string =>
  source
    .split("/")
    .pop()
    ?.replace(/\.git$/u, "") ?? "skill";

export const makeSkillsStore = (kv: KvStore): Effect.Effect<SkillsStoreShape, HubError, never> =>
  Effect.gen(function* () {
    const loaded = yield* Effect.tryPromise({
      try: async () => {
        const entries = await kv.list({ prefix: "skills/" });
        const skills: SkillInfo[] = [];
        for (const entry of entries) {
          try {
            skills.push(decodeSkill(entry.value));
          } catch (error) {
            console.warn(`[hub] skipping corrupt skill record: ${String(error)}`);
          }
        }
        return skills;
      },
      catch: toHubError("failed to load the skills store"),
    });
    const skillsRef = yield* Ref.make<ReadonlyMap<string, SkillInfo>>(
      new Map(loaded.map((skill) => [skill.id, skill])),
    );

    return {
      list: () =>
        Ref.get(skillsRef).pipe(
          Effect.map((skills) => [...skills.values()].sort((a, b) => a.name.localeCompare(b.name))),
        ),
      import: (input) =>
        Effect.gen(function* () {
          const skill: SkillInfo = {
            id: crypto.randomUUID().replaceAll("-", ""),
            name: skillNameFromSource(input.source),
            scope: input.scope ?? "personal",
            source: input.source,
            version: null,
          };
          yield* Effect.tryPromise({
            try: () => kv.put(skillKey(skill.id), encodeSkill(skill)),
            catch: toHubError(`failed to persist skill ${skill.id}`),
          });
          yield* Ref.update(skillsRef, (skills) => new Map(skills).set(skill.id, skill));
          return skill;
        }),
      delete: (id) =>
        Effect.gen(function* () {
          const skills = yield* Ref.get(skillsRef);
          if (!skills.has(id)) return false;
          yield* Ref.update(skillsRef, (skills) => {
            const next = new Map(skills);
            next.delete(id);
            return next;
          });
          yield* Effect.tryPromise({
            try: () => kv.delete(skillKey(id)),
            catch: toHubError(`failed to delete skill ${id}`),
          });
          return true;
        }),
    };
  });
