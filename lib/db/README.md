# `@workspace/db`

Drizzle schema (`src/schema/`), numbered SQL migrations (`drizzle/`),
and the schema-sync tooling for the dev/test database.

## Schema sync (`pnpm --filter @workspace/db sync`)

The sync converges the live database to whatever
`src/schema/index.ts` describes. It runs automatically after every
task merge (see `scripts/post-merge.sh`) and can be invoked manually.

Performance: a typical run is **~5 seconds** on the current 300+-table
schema. It used to take **5+ minutes** (timing out CI / fresh
containers) because every cold container had to introspect the whole
live DB. The fix:

- A JSON snapshot of the desired schema is committed to the repo at
  `lib/db/.sync-cache/snapshot.json`, alongside a guard hash
  (`snapshot.guard`) of the numbered-migration filenames.
- On every run, the sync compares the cached snapshot to the snapshot
  freshly generated from `src/schema/` (`generateMigration(prev, cur)`)
  and applies only the additive diff. **No live-DB introspect needed**
  in the common case.
- The cache is refreshed after every successful apply, so it always
  reflects the most recently converged state.
- A slow fallback (`pushSchema(...)`, which does introspect) only runs
  when the cache files are missing entirely, or when a new numbered
  migration has landed since the cache was last updated (guard
  mismatch). After a successful slow-path run the cache is refreshed,
  so subsequent runs are fast again.

Because the cache is committed, fresh and isolated containers — CI
runners, task-agent sandboxes, anyone whose `/tmp` was just wiped —
hit the fast path on their very first run.

Destructive or ambiguous diffs (`DROP TABLE/COLUMN/CONSTRAINT`,
`RENAME *`, `TRUNCATE`, or drizzle-reported `hasDataLoss`) cause the
sync to print the full diff and exit with code 2 without touching the
DB. Author a numbered SQL file in `drizzle/` instead, or re-run with
`ALLOW_SCHEMA_DATA_LOSS=1` after reviewing the diff.

See [`docs/db-test-sync.md`](../../docs/db-test-sync.md) for the full
flow, env-var knobs (`DRY_RUN`, `POST_MERGE_FORCE_INTROSPECT`,
`SYNC_SNAPSHOT_FILE`, …), the post-merge integration, and the drift
check.

## Migration coverage check (`pnpm --filter @workspace/db check:migrations-cover-schema`)

Production only ever applies the numbered SQL files in
[`drizzle/`](./drizzle/) (see the apply loop in
`scripts/post-merge.sh` and `scripts/apply-prod-migrations.sh`). The
schema sync above (`pnpm --filter @workspace/db sync`) closes any gap
between those numbered files and `src/schema/` — but it **never runs
in production**. So a schema change without a matching numbered
migration silently works in dev/test/staging and is missing in
production. This is exactly how Task #579's
`club_marketing_site_images` table shipped to staging fine and missed
production until Task #1034's backfill failed.

The `check:migrations-cover-schema` script defends against that:

1. Apply every numbered SQL file in `drizzle/` to a throwaway DB the
   same way `scripts/post-merge.sh` does.
2. Call drizzle-kit's `pushSchema(...)` to compute the DDL drizzle
   *would* run to make that DB match `src/schema/`. (It only computes
   the diff — `.apply()` is never called.)
3. Filter the cosmetic introspect re-formatting churn the same way
   `sync-schema.ts` and `scripts/check-db-drift.sh` do.
4. Diff the remaining statements against
   [`./.migration-coverage-baseline.json`](./.migration-coverage-baseline.json)
   and exit `1` listing any statement NOT in the baseline.

A failing run means: a table/column/type is defined in `src/schema/`
that no numbered SQL file in `drizzle/` creates. The fix is to author
a numbered migration:

```bash
pnpm --filter @workspace/db generate
# Review the generated lib/db/drizzle/NNNN_*.sql, make it idempotent
# (IF NOT EXISTS, DO blocks for enums) so post-merge can replay it
# safely, then commit it alongside your schema change.
```

### CI integration

[`.github/workflows/db-migration-coverage.yml`](../../.github/workflows/db-migration-coverage.yml)
runs this check on every PR (and on push to `main`) against an
ephemeral Postgres service container, with `FRESH_DB=1` so the script
uses `$DATABASE_URL` directly. A failing job blocks the merge. The
same workflow also enforces a **baseline-must-not-grow** rule on PRs:
any PR that adds entries to `.migration-coverage-baseline.json`
(instead of writing a real numbered migration) fails the check.

### Refreshing the baseline

The baseline file at
[`./.migration-coverage-baseline.json`](./.migration-coverage-baseline.json)
records historical drift the team has knowingly accepted; the guard
fails only when statements appear that are NOT in the baseline.

**You should almost never need to refresh it upward.** The whole
point of the guard is that new schema changes get a real migration
instead of being papered over in the baseline. Refresh only after
**writing a real numbered migration** that closes drift — at which
point the baseline should *shrink*, not grow:

```bash
UPDATE_BASELINE=1 FRESH_DB=1 \
  DATABASE_URL=postgres://… \
  pnpm --filter @workspace/db check:migrations-cover-schema
```

Review the diff carefully before committing the refreshed baseline:
statements LEAVING the baseline are good (you closed real drift);
statements ENTERING it mean you are accepting new historical drift
instead of writing a migration, and the PR check (see "CI
integration" above) will reject the change.
