/**
 * The hub's skills store (skills.ts): the hub-hosted skills store of
 * ADR 0007 — amp-style, scoped `personal` or `workspace`, imported from
 * repos. Lives on the `KvStore` seam (keys: `skills/<id>`, via the
 * `jsonRecords` layer at prefix `"skills/"`), like the registry; the
 * wire's minimal slice: list, import, delete. Records keep `source` +
 * `version` from day one so versioning and sharing UX are additive later.
 */

import { Context, Effect, Ref } from "effect";
import type { SkillInfo, SkillScope } from "@saku/wire";

import type { HubError } from "./hub-error.ts";
import { jsonRecords, KvStore } from "@saku/store";

export interface SkillsStoreApi {
  readonly list: () => Effect.Effect<readonly SkillInfo[], HubError>;
  /** Import from a repo; the name is derived from the source (git-style). */
  readonly import: (input: {
    source: string;
    scope?: SkillScope;
  }) => Effect.Effect<SkillInfo, HubError>;
  /** Remove a skill; `false` when the id is unknown. */
  readonly delete: (id: string) => Effect.Effect<boolean, HubError>;
}

/** The default name for an imported repo: `owner/repo` → `repo`. */
export const skillNameFromSource = (source: string) =>
  source
    .split("/")
    .pop()
    ?.replace(/\.git$/u, "") ?? "skill";

/** The hub's skills store (ADR 0007): `SkillsStore.make` builds one over the `KvStore`. */
export class SkillsStore extends Context.Service<SkillsStore, SkillsStoreApi>()("SkillsStore", {
  make: Effect.fn("SkillsStore.make")(function* make() {
    const kv = yield* KvStore;
    const skills = jsonRecords<SkillInfo>(kv, "skills/");
    const loaded = yield* skills.list();
    const skillsRef = yield* Ref.make<ReadonlyMap<string, SkillInfo>>(
      new Map(loaded.map(({ value }) => [value.id, value])),
    );

    return {
      delete: Effect.fn("delete")(function* deleteSkill(id) {
        const current = yield* Ref.get(skillsRef);
        if (!current.has(id)) {
          return false;
        }
        yield* Ref.update(skillsRef, (map) => {
          const next = new Map(map);
          next.delete(id);
          return next;
        });
        yield* skills.delete(id);
        return true;
      }),
      import: Effect.fn("import")(function* importSkill(input) {
        const skill: SkillInfo = {
          id: crypto.randomUUID().replaceAll("-", ""),
          name: skillNameFromSource(input.source),
          scope: input.scope ?? "personal",
          source: input.source,
          version: null,
        };
        yield* skills.put(skill.id, skill);
        yield* Ref.update(skillsRef, (map) => new Map(map).set(skill.id, skill));
        return skill;
      }),
      list: () =>
        Ref.get(skillsRef).pipe(
          Effect.map((map) => [...map.values()].toSorted((a, b) => a.name.localeCompare(b.name))),
        ),
    };
  }),
}) {}
