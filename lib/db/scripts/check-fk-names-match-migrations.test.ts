#!/usr/bin/env -S tsx
/**
 * Focused unit test for `check-fk-names-match-migrations.ts`.
 *
 * Exercises the three pure functions of the new lint against synthetic
 * SQL strings and synthetic in-memory drizzle schemas — NO live DB or
 * filesystem migration walk involved. Each block is a self-contained
 * scenario the live check has to handle correctly:
 *
 *   1. parseMigrationFile recognises BOTH FK shapes drizzle-kit emits
 *      (inline `CONSTRAINT ... FOREIGN KEY` inside CREATE TABLE, and
 *      top-level `ALTER TABLE ... ADD CONSTRAINT`), strips schema
 *      qualifiers, and ignores commented-out declarations.
 *   2. extractSchemaFks returns the same name drizzle would actually
 *      apply — the explicit `foreignKey({ name })` form OR the
 *      auto-generated form `<table>_<col>...<reftable>_<refcol>..._fk`
 *      (the formula `check-fk-names.ts` already pins).
 *   3. findNameDriftViolations flags ONLY the (signature, schema-name,
 *      migration-name) triples where the names differ — must NOT
 *      false-positive on:
 *        - matching explicit names, or
 *        - schema-only FKs that no migration created (different bug
 *          class, owned by `check-migrations-cover-schema.ts`).
 *
 * Run with:
 *   pnpm --filter @workspace/db exec tsx \
 *     ./scripts/check-fk-names-match-migrations.test.ts
 */

import { foreignKey, integer, pgTable, serial } from "drizzle-orm/pg-core";

import {
  extractSchemaFks,
  findNameDriftViolations,
  parseMigrationFile,
  parseMigrationFileDrops,
  signatureKey,
} from "./check-fk-names-match-migrations.ts";

let failed = 0;
function check(label: string, ok: boolean, detail?: string): void {
  if (ok) return;
  failed += 1;
  console.error(`FAIL: ${label}${detail ? ` — ${detail}` : ""}`);
}

// ── 1. parseMigrationFile recognises both FK shapes ──────────────────────

// Pattern (B): top-level ALTER TABLE ADD CONSTRAINT (the shape
// `lib/db/drizzle/0156_portal_digest_mute_confirmation_sends.sql`
// uses).
const alterSql = `
ALTER TABLE "portal_digest_mute_confirmation_sends"
  ADD CONSTRAINT "portal_digest_mute_confirmation_sends_user_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id")
  ON DELETE cascade ON UPDATE no action;
`;
const alterParsed = parseMigrationFile(alterSql);
check(
  "ALTER TABLE FK extracted",
  alterParsed.length === 1 &&
    alterParsed[0].name ===
      "portal_digest_mute_confirmation_sends_user_id_fk" &&
    alterParsed[0].signature.table ===
      "portal_digest_mute_confirmation_sends" &&
    alterParsed[0].signature.columns.length === 1 &&
    alterParsed[0].signature.columns[0] === "user_id" &&
    alterParsed[0].signature.refTable === "app_users" &&
    alterParsed[0].signature.refColumns[0] === "id",
  JSON.stringify(alterParsed),
);

// Pattern (A): inline CONSTRAINT inside CREATE TABLE (the shape the
// drizzle-kit generator emits for tables created in the same migration
// that declares their FKs). Includes a `numeric(10,2)` column to make
// sure the balanced-paren scan doesn't bail on the `(10,2)` and miss
// the FK that follows.
const createSql = `
CREATE TABLE IF NOT EXISTS "public"."bounced_digest_schedule_sends" (
  "id" serial PRIMARY KEY NOT NULL,
  "amount" numeric(10,2),
  "organization_id" integer NOT NULL,
  "changed_by_user_id" integer,
  CONSTRAINT "bounced_digest_schedule_sends_org_fk"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
    ON DELETE cascade,
  CONSTRAINT "bounced_digest_schedule_sends_user_fk"
    FOREIGN KEY ("changed_by_user_id") REFERENCES "app_users"("id")
    ON DELETE set null
);
`;
const createParsed = parseMigrationFile(createSql);
check(
  "inline CREATE TABLE FKs extracted (count)",
  createParsed.length === 2,
  `count=${createParsed.length}`,
);
check(
  "inline FK #1 — org",
  createParsed[0]?.name === "bounced_digest_schedule_sends_org_fk" &&
    createParsed[0]?.signature.table === "bounced_digest_schedule_sends" &&
    createParsed[0]?.signature.columns[0] === "organization_id" &&
    createParsed[0]?.signature.refTable === "organizations",
);
check(
  "inline FK #2 — user",
  createParsed[1]?.name === "bounced_digest_schedule_sends_user_fk" &&
    createParsed[1]?.signature.columns[0] === "changed_by_user_id" &&
    createParsed[1]?.signature.refTable === "app_users",
);

// Composite-key FK preserves column ORDER (Postgres FKs are
// position-sensitive — `(a,b) → (x,y)` is NOT the same constraint as
// `(b,a) → (y,x)`).
const compositeSql = `
ALTER TABLE "child" ADD CONSTRAINT "child_parent_fk"
  FOREIGN KEY ("a", "b") REFERENCES "parent"("x", "y");
`;
const compositeParsed = parseMigrationFile(compositeSql);
check(
  "composite FK column order preserved",
  compositeParsed.length === 1 &&
    compositeParsed[0].signature.columns.join(",") === "a,b" &&
    compositeParsed[0].signature.refColumns.join(",") === "x,y",
);

// Commented-out FK MUST be ignored — both `--` line comments and SQL
// block comments. A future hand-edited migration that comments out a
// stale FK declaration must not register it.
const commentedSql = `
-- ALTER TABLE "x" ADD CONSTRAINT "stale_line_fk" FOREIGN KEY ("a") REFERENCES "y"("id");
/* ALTER TABLE "x" ADD CONSTRAINT "stale_block_fk" FOREIGN KEY ("a") REFERENCES "y"("id"); */
ALTER TABLE "x" ADD CONSTRAINT "real_fk" FOREIGN KEY ("a") REFERENCES "y"("id");
`;
const commentedParsed = parseMigrationFile(commentedSql);
check(
  "commented FK declarations are ignored",
  commentedParsed.length === 1 && commentedParsed[0].name === "real_fk",
  JSON.stringify(commentedParsed.map((p) => p.name)),
);

// signatureKey is order-sensitive — pin it so a later refactor that
// "helpfully" sorts column lists silently masks a real drift.
const sigA = signatureKey({
  table: "child",
  columns: ["a", "b"],
  refTable: "parent",
  refColumns: ["x", "y"],
});
const sigB = signatureKey({
  table: "child",
  columns: ["b", "a"],
  refTable: "parent",
  refColumns: ["y", "x"],
});
check(
  "signatureKey is column-order sensitive",
  sigA !== sigB,
  `sigA=${sigA}, sigB=${sigB}`,
);

// ── 2. extractSchemaFks computes the same name drizzle would apply ───────

// Reference target (kept short so the auto-name stays in-bounds for
// the inline `.references(...)` case below).
const parents = pgTable("parents", {
  id: serial("id").primaryKey(),
});

// Case A: inline `.references(...)` → drizzle auto-name
//   `<table>_<col>_<reftable>_<refcol>_fk`
//   = `kids_parent_id_parents_id_fk`.
const kidsAuto = pgTable("kids", {
  id: serial("id").primaryKey(),
  parentId: integer("parent_id").references(() => parents.id),
});

// Case B: explicit `foreignKey({ name })` — the schema-side fix that
// `bouncedDigestScheduleOptOutsTable` and friends already use.
const kidsExplicit = pgTable(
  "kids_explicit",
  {
    id: serial("id").primaryKey(),
    parentId: integer("parent_id").notNull(),
  },
  (t) => [
    foreignKey({
      name: "kids_explicit_to_parent_fk",
      columns: [t.parentId],
      foreignColumns: [parents.id],
    }),
  ],
);

const synthSchema = { parents, kidsAuto, kidsExplicit };
const schemaFks = extractSchemaFks(synthSchema);
const autoFk = schemaFks.find((f) => f.signature.table === "kids");
const explicitFk = schemaFks.find(
  (f) => f.signature.table === "kids_explicit",
);
check(
  "auto-named schema FK resolves to drizzle's <table>_<col>_<reftable>_<refcol>_fk",
  autoFk !== undefined &&
    autoFk.name === "kids_parent_id_parents_id_fk" &&
    autoFk.isExplicit === false,
  autoFk ? `${autoFk.name} (explicit=${autoFk.isExplicit})` : "missing",
);
check(
  "explicit foreignKey({ name }) is honoured",
  explicitFk !== undefined &&
    explicitFk.name === "kids_explicit_to_parent_fk" &&
    explicitFk.isExplicit === true,
  explicitFk
    ? `${explicitFk.name} (explicit=${explicitFk.isExplicit})`
    : "missing",
);

// ── 3. findNameDriftViolations flags ONLY the mismatches ────────────────

// Scenario (A): migration set the FK to "kids_parent_id_fk" (a
// shorter, deliberate name) but the schema still uses inline
// `.references(...)`, so it auto-generates "kids_parent_id_parents_id_fk".
// This is exactly the #2219 / #2221 / #2192 / #2225 bug class — every
// post-merge introspect emits a real DROP+ADD pair the data-loss gate
// refuses to apply.
const driftMigrations = new Map<string, string>([
  [
    signatureKey({
      table: "kids",
      columns: ["parent_id"],
      refTable: "parents",
      refColumns: ["id"],
    }),
    "kids_parent_id_fk",
  ],
]);
const driftViolations = findNameDriftViolations(synthSchema, driftMigrations);
check(
  "name-drift FK is flagged",
  driftViolations.length === 1 &&
    driftViolations[0].schemaName === "kids_parent_id_parents_id_fk" &&
    driftViolations[0].migrationName === "kids_parent_id_fk" &&
    driftViolations[0].schemaUsedExplicitName === false,
  JSON.stringify(driftViolations),
);

// Scenario (B): the schema's explicit name MATCHES the migration —
// must NOT flag (this is the supported fix and it's already deployed
// for `portalDigestMuteConfirmationSendsTable` and friends).
const matchingMigrations = new Map<string, string>([
  [
    signatureKey({
      table: "kids_explicit",
      columns: ["parent_id"],
      refTable: "parents",
      refColumns: ["id"],
    }),
    "kids_explicit_to_parent_fk",
  ],
]);
const matchingViolations = findNameDriftViolations(
  synthSchema,
  matchingMigrations,
);
check(
  "matching explicit name produces zero violations",
  matchingViolations.length === 0,
  JSON.stringify(matchingViolations),
);

// Scenario (C): a schema FK that NO migration covers must NOT be
// flagged here — that's missing-migration drift, owned by
// `check-migrations-cover-schema.ts`.
const emptyMigrations = new Map<string, string>();
const emptyViolations = findNameDriftViolations(synthSchema, emptyMigrations);
check(
  "schema-only FKs are not flagged (different guard owns that)",
  emptyViolations.length === 0,
  JSON.stringify(emptyViolations),
);

// Scenario (D₂): the migration's name uses a Postgres-default suffix
// (`_fkey`, `_key`, `_pkey`) — those are already neutralised by the
// existing `isCosmeticDropConstraint` exemption in
// `sync-schema-classify.ts`, so the post-merge applies cleanly. This
// is the dominant baseline-drift class (~175 FKs from the pg_dump
// squash) and the lint MUST NOT scream about them. Same for names that
// hit Postgres's 63-char identifier limit.
const baselineMigrations = new Map<string, string>([
  [
    signatureKey({
      table: "kids",
      columns: ["parent_id"],
      refTable: "parents",
      refColumns: ["id"],
    }),
    // `_fkey` suffix → already cosmetic on DROP, harmless.
    "kids_parent_id_fkey",
  ],
]);
const baselineViolations = findNameDriftViolations(
  synthSchema,
  baselineMigrations,
);
check(
  "_fkey-suffix migration names are NOT flagged (baseline drift, cosmetic-DROP-exempt)",
  baselineViolations.length === 0,
  JSON.stringify(baselineViolations),
);

// And the 63-char-truncation case: a deliberately truncated migration
// name also gets the cosmetic-DROP exemption in
// `sync-schema-classify.ts` and so must NOT be flagged here either.
const truncatedName = "a".repeat(63);
const truncatedMigrations = new Map<string, string>([
  [
    signatureKey({
      table: "kids",
      columns: ["parent_id"],
      refTable: "parents",
      refColumns: ["id"],
    }),
    truncatedName,
  ],
]);
const truncatedViolations = findNameDriftViolations(
  synthSchema,
  truncatedMigrations,
);
check(
  "63-char-truncated migration names are NOT flagged (cosmetic-DROP-exempt)",
  truncatedViolations.length === 0,
  JSON.stringify(truncatedViolations),
);

// Scenario (D): a migration FK whose signature does NOT appear in the
// schema (someone deleted the schema declaration) must NOT be flagged
// here — the missing-from-schema direction is also out of scope.
const orphanMigrations = new Map<string, string>([
  [
    signatureKey({
      table: "deleted_table",
      columns: ["x"],
      refTable: "parents",
      refColumns: ["id"],
    }),
    "deleted_table_x_fk",
  ],
]);
const orphanViolations = findNameDriftViolations(
  synthSchema,
  orphanMigrations,
);
check(
  "migration-only FKs are not flagged (different guard owns that)",
  orphanViolations.length === 0,
  JSON.stringify(orphanViolations),
);

// ── 4. Late DROP CONSTRAINT removes the entry ────────────────────────────
// A real-life pattern: migration N adds an FK with name "old_fk", a
// later migration drops "old_fk" outright (no recreate). The
// migration-side map should NOT carry "old_fk" forward, so a schema
// that no longer declares the FK doesn't get accused of drift.
//
// We exercise this through the per-file parser by simulating the
// post-fold behaviour the driver implements: parse adds, then process
// drops by removing matching name entries.
const dropOnlySql = `
ALTER TABLE "x" DROP CONSTRAINT "old_fk";
`;
const dropParsed = parseMigrationFile(dropOnlySql);
check(
  "DROP CONSTRAINT statements are not parsed as ADD entries",
  dropParsed.length === 0,
  JSON.stringify(dropParsed),
);

// `parseMigrationFileDrops` must surface DROP CONSTRAINT statements
// with their byte-offset so the source-order replay in
// `buildMigrationFkMap` can interleave them with ADDs correctly.
const dropEvents = parseMigrationFileDrops(dropOnlySql);
check(
  "parseMigrationFileDrops surfaces the DROP with its position",
  dropEvents.length === 1 &&
    dropEvents[0].table === "x" &&
    dropEvents[0].name === "old_fk" &&
    typeof dropEvents[0].position === "number" &&
    dropEvents[0].position > 0,
  JSON.stringify(dropEvents),
);

// Source-order regression: a same-file `DROP CONSTRAINT x; ... ADD
// CONSTRAINT x;` (drop-then-recreate) MUST end up with the recreate's
// entry in the events stream landing AFTER the drop. The naive
// "process all ADDs, then all DROPs" approach silently corrupted this
// case (the post-pass DROP wiped the freshly-added entry); the
// merge-sort-by-position replay in `buildMigrationFkMap` fixes it.
//
// We exercise the source-order property at the parser layer here
// (positions strictly increasing in source) so a future refactor that
// reverses the order can't silently regress.
const dropThenRecreateSql = `
ALTER TABLE "kids" DROP CONSTRAINT "kids_parent_id_fk";
ALTER TABLE "kids" ADD CONSTRAINT "kids_parent_id_fk" FOREIGN KEY ("parent_id") REFERENCES "parents"("id");
`;
const dropThenRecreateAdds = parseMigrationFile(dropThenRecreateSql);
const dropThenRecreateDrops = parseMigrationFileDrops(dropThenRecreateSql);
check(
  "drop-then-recreate: ADD position is AFTER DROP position",
  dropThenRecreateAdds.length === 1 &&
    dropThenRecreateDrops.length === 1 &&
    dropThenRecreateAdds[0].position > dropThenRecreateDrops[0].position,
  JSON.stringify({
    add: dropThenRecreateAdds,
    drop: dropThenRecreateDrops,
  }),
);

// And the inverse — `ADD CONSTRAINT x; ... DROP CONSTRAINT x;` (add
// then drop, no recreate) — the DROP must land AFTER the ADD so the
// driver removes the freshly-added entry and the FK is correctly
// absent from the final map.
const addThenDropSql = `
ALTER TABLE "kids" ADD CONSTRAINT "kids_parent_id_fk" FOREIGN KEY ("parent_id") REFERENCES "parents"("id");
ALTER TABLE "kids" DROP CONSTRAINT "kids_parent_id_fk";
`;
const addThenDropAdds = parseMigrationFile(addThenDropSql);
const addThenDropDrops = parseMigrationFileDrops(addThenDropSql);
check(
  "add-then-drop: DROP position is AFTER ADD position",
  addThenDropAdds.length === 1 &&
    addThenDropDrops.length === 1 &&
    addThenDropDrops[0].position > addThenDropAdds[0].position,
  JSON.stringify({ add: addThenDropAdds, drop: addThenDropDrops }),
);

// Mixed-shape source-order regression: a single file may legally mix
// inline CREATE TABLE constraints with top-level ALTER TABLE
// statements. The position translation for inline FKs uses
// `bodyStart + f.index` to map body-relative offsets back to source
// coordinates, so the global merge-sort in `buildMigrationFkMap` must
// see consistent positions across both parser paths. Pin the
// invariant: an inline FK that appears BEFORE a top-level ALTER ADD
// in the source must have a SMALLER position, and one that appears
// AFTER must have a LARGER position.
const inlineBeforeAlterSql = `
CREATE TABLE "kids" (
  "id" serial PRIMARY KEY,
  "parent_id" integer NOT NULL,
  CONSTRAINT "kids_parent_id_fk" FOREIGN KEY ("parent_id") REFERENCES "parents"("id")
);
ALTER TABLE "pets" ADD CONSTRAINT "pets_owner_id_fk" FOREIGN KEY ("owner_id") REFERENCES "owners"("id");
`;
const inlineBeforeAlterAdds = parseMigrationFile(inlineBeforeAlterSql);
const inlineEntry = inlineBeforeAlterAdds.find(
  (a) => a.signature.table === "kids",
);
const alterEntry = inlineBeforeAlterAdds.find(
  (a) => a.signature.table === "pets",
);
check(
  "mixed-shape: inline FK position is BEFORE later top-level ALTER ADD",
  inlineEntry !== undefined &&
    alterEntry !== undefined &&
    inlineEntry.position < alterEntry.position,
  JSON.stringify({ inline: inlineEntry, alter: alterEntry }),
);

const alterBeforeInlineSql = `
ALTER TABLE "pets" ADD CONSTRAINT "pets_owner_id_fk" FOREIGN KEY ("owner_id") REFERENCES "owners"("id");
CREATE TABLE "kids" (
  "id" serial PRIMARY KEY,
  "parent_id" integer NOT NULL,
  CONSTRAINT "kids_parent_id_fk" FOREIGN KEY ("parent_id") REFERENCES "parents"("id")
);
`;
const alterBeforeInlineAdds = parseMigrationFile(alterBeforeInlineSql);
const alterEntry2 = alterBeforeInlineAdds.find(
  (a) => a.signature.table === "pets",
);
const inlineEntry2 = alterBeforeInlineAdds.find(
  (a) => a.signature.table === "kids",
);
check(
  "mixed-shape: top-level ALTER ADD position is BEFORE later inline FK",
  alterEntry2 !== undefined &&
    inlineEntry2 !== undefined &&
    alterEntry2.position < inlineEntry2.position,
  JSON.stringify({ alter: alterEntry2, inline: inlineEntry2 }),
);

// Suppression-parity: `_pkey` suffix MUST NOT be skipped by
// `findNameDriftViolations` because the classifier in
// `sync-schema-classify.ts` treats `_pkey` as a REAL drop (via
// `REAL_DROP_CONSTRAINT_SUFFIXES`), not a cosmetic one. Any drift
// between a `_pkey`-named migration FK and the schema would therefore
// block the post-merge, so the lint MUST flag it.
const pkeyMigrations = new Map<string, string>([
  [
    signatureKey({
      table: "kids",
      columns: ["parent_id"],
      refTable: "parents",
      refColumns: ["id"],
    }),
    // `_pkey` suffix → classifier treats DROP as REAL → drift here is
    // a real bug the lint MUST surface.
    "kids_parent_id_pkey",
  ],
]);
const pkeyViolations = findNameDriftViolations(synthSchema, pkeyMigrations);
check(
  "_pkey-suffix migration names ARE flagged (classifier treats as REAL drop)",
  pkeyViolations.length === 1 &&
    pkeyViolations[0].migrationName === "kids_parent_id_pkey",
  JSON.stringify(pkeyViolations),
);

if (failed > 0) {
  console.error(
    `\ncheck-fk-names-match-migrations.test: ${failed} case(s) failed`,
  );
  process.exit(1);
}
console.log(
  "OK: check-fk-names-match-migrations parses both FK shapes, computes " +
    "drizzle's auto-name correctly, and flags exactly the mismatches.",
);
