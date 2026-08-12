/**
 * The wire's skills feature: the hub-hosted skills store (ADR 0007).
 *
 * Skills are imported from repos, scoped `personal` or `workspace`
 * (workspace = pushed, loaded by default for everyone), and loaded by every
 * worker from the hub. The minimal slice: list, import, delete. Records keep
 * `source` + `version` fields from day one so versioning and sharing UX are
 * additive later.
 */

import { Schema as S } from "effect";

export const SkillScope = S.Literals(["personal", "workspace"]);
export type SkillScope = S.Schema.Type<typeof SkillScope>;

export const SkillInfo = S.Struct({
  id: S.String,
  name: S.String,
  scope: SkillScope,
  /** Where the skill was imported from (repo reference); null for hub-native skills. */
  source: S.Union([S.Null, S.String]),
  /** Imported version; null until versioning lands. */
  version: S.Union([S.Null, S.String]),
});
export type SkillInfo = S.Schema.Type<typeof SkillInfo>;

export const ListSkillsCommand = S.TaggedStruct("list_skills", {});
export const ImportSkillCommand = S.TaggedStruct("import_skill", {
  source: S.String,
  /** Defaults to `personal` when omitted. */
  scope: S.optional(SkillScope),
});
export const DeleteSkillCommand = S.TaggedStruct("delete_skill", { id: S.String });

export const SkillCommand = S.Union([ListSkillsCommand, ImportSkillCommand, DeleteSkillCommand]);
export type SkillCommand = S.Schema.Type<typeof SkillCommand>;

export const ListSkillsResponse = S.TaggedStruct("list_skills", { skills: S.Array(SkillInfo) });
export const ImportSkillResponse = S.TaggedStruct("import_skill", { skill: SkillInfo });
export const DeleteSkillResponse = S.TaggedStruct("delete_skill", {});

export const SkillResponse = S.Union([
  ListSkillsResponse,
  ImportSkillResponse,
  DeleteSkillResponse,
]);
export type SkillResponse = S.Schema.Type<typeof SkillResponse>;
