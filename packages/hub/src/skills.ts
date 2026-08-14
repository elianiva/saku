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
import { KvStore } from "@saku/store";

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

const skillKey = (id: string) => `skills/${id}`;

const encodeSkill = (skill: SkillInfo) =>
  new TextEncoder().encode(`${JSON.stringify(skill)}\n`);

const decodeSkill = (value: Uint8Array) =>
  JSON.parse(new TextDecoder().decode(value)) as SkillInfo;

/** The default name for an imported repo: `owner/repo` → `repo`. */
export const skillNameFromSource = (source: string) =>
  source
    .split("/")
    .pop()
    ?.replace(/\.git$/u, "") ?? "skill";

export const makeSkillsStore = Effect.fn("makeSkillsStore")(function* () {
  const kv = yield* KvStore;
  const entries = yield* kv.list({ prefix: "skills/" });
  const loaded = yield* Effect.forEach(entries, (entry) =>
    Effect.try(() => decodeSkill(entry.value)).pipe(
      Effect.catch((error) =>
        // Corrupt record: skip (the key stays on disk for inspection).
        Effect.logWarning(`[hub] skipping corrupt skill record: ${String(error)}`).pipe(
          Effect.as(undefined),
        ),
      ),
    ),
  ).pipe(Effect.map((skills) => skills.filter((skill) => skill !== undefined)));
  const skillsRef = yield* Ref.make<ReadonlyMap<string, SkillInfo>>(
    new Map(loaded.map((skill) => [skill.id, skill])),
  );

  return {
    list: () =>
      Ref.get(skillsRef).pipe(
        Effect.map((skills) => [...skills.values()].sort((a, b) => a.name.localeCompare(b.name))),
      ),
    import: Effect.fn("import")(function* (input) {
      const skill: SkillInfo = {
        id: crypto.randomUUID().replaceAll("-", ""),
        name: skillNameFromSource(input.source),
        scope: input.scope ?? "personal",
        source: input.source,
        version: null,
      };
      yield* kv.put(skillKey(skill.id), encodeSkill(skill));
      yield* Ref.update(skillsRef, (skills) => new Map(skills).set(skill.id, skill));
      return skill;
    }),
    delete: Effect.fn("delete")(function* (id) {
      const skills = yield* Ref.get(skillsRef);
      if (!skills.has(id)) return false;
      yield* Ref.update(skillsRef, (skills) => {
        const next = new Map(skills);
        next.delete(id);
        return next;
      });
      yield* kv.delete(skillKey(id));
      return true;
    }),
  };
});
