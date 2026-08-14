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

import { HubError } from "./hub-error.ts";
import { jsonRecords, KvStore } from "@saku/store";

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

/** The default name for an imported repo: `owner/repo` → `repo`. */
export const skillNameFromSource = (source: string) =>
  source
    .split("/")
    .pop()
    ?.replace(/\.git$/u, "") ?? "skill";

/** The hub's skills store (ADR 0007): `SkillsStore.make` builds one over the `KvStore`. */
export class SkillsStore extends Context.Service<SkillsStore, SkillsStoreShape>()("SkillsStore", {
  make: Effect.fn("SkillsStore.make")(function* () {
    const kv = yield* KvStore;
    const skills = jsonRecords<SkillInfo>(kv, "skills/");
    const loaded = yield* skills.list();
    const skillsRef = yield* Ref.make<ReadonlyMap<string, SkillInfo>>(
      new Map(loaded.map(({ value }) => [value.id, value])),
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
        yield* skills.put(skill.id, skill);
        yield* Ref.update(skillsRef, (skills) => new Map(skills).set(skill.id, skill));
        return skill;
      }),
      delete: Effect.fn("delete")(function* (id) {
        const current = yield* Ref.get(skillsRef);
        if (!current.has(id)) return false;
        yield* Ref.update(skillsRef, (skills) => {
          const next = new Map(skills);
          next.delete(id);
          return next;
        });
        yield* skills.delete(id);
        return true;
      }),
    };
  }),
}) {}
