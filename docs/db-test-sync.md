# Catching the test database up to the Drizzle schema

> Applying migration `0059_canonicalize_fk_names.sql` to **production**?
> Follow [`runbook-migration-0059.md`](./runbook-migration-0059.md) — it
> has the operator commands, verification queries, and the full
> rename / drop list for the change ticket.


`lib/db/src/schema/index.ts` (re-exports from `auth.ts` and `golf.ts`) is the
source of truth for the test database schema. Numbered SQL files in
`lib/db/drizzle/` apply the schema in chunks, and any drift between those
files and the schema is closed by a deterministic, non-interactive sync
(`pnpm --filter @workspace/db sync`).

## Automatic catch-up (post-merge)

`scripts/post-merge.sh` runs automatically after every task merge and does
the following, in order:

1. `pnpm install --frozen-lockfile`.
2. Apply every numbered SQL file in `lib/db/drizzle/` (idempotent).
3. `DROP TABLE IF EXISTS scorer_credentials CASCADE` — clears the legacy
   table so the diff does not contain a rename-vs-drop against
   `affiliate_codes`.
4. Schema-files short-circuit: if every file under `lib/db/src/schema/`
   is byte-identical to the last successful sync (hash recorded in
   `lib/db/.sync-cache/last-schema-files-hash`, committed to the repo
   so cold containers can short-circuit too), skip the sync entirely.
5. Otherwise, run `pnpm --filter @workspace/db sync` **in the
   foreground**. The sync uses a snapshot cache (see below) so the
   typical run is a sub-second JSON diff — the multi-minute drizzle-kit
   introspect only runs on a cold cache or after a new numbered
   migration lands. A destructive or ambiguous diff fails the **same**
   post-merge run (no more buried background log). On failure, the log
   is preserved at `/tmp/post-merge-schema-sync.log.failed` *and* a
   timestamped copy `…log.failed.<UTC-stamp>` so back-to-back failures
   don't clobber earlier diagnostics. When the host CI exposes
   `GITHUB_STEP_SUMMARY` (or `POST_MERGE_SUMMARY_FILE`), a markdown
   summary block with the tail is appended there so the failure is
   visible from the CI run page without scrolling the raw log.

When the schema and DB are already in sync, step 5 prints
`database already matches schema. No-op.` and exits 0.

## Manual catch-up

The sync script is fully non-interactive — no PTY, no `/dev/tty` reads,
no piped newlines — so it can be driven from any shell, including CI:

```bash
pnpm --filter @workspace/db sync
```

What it does:

- Replaces `process.stdin` with a synthetic `Readable` that auto-fires a
  `return` keypress whenever drizzle-kit's bundled `hanji` Terminal
  attaches a `keypress` listener. This deterministically selects the
  first option of every drizzle prompt:
  * "rename vs. create new" → defaults to **create new** (the unmatched
    old entity stays in the diff as a DROP and is caught by the
    destructive-gate below).
  * "truncate this table to add a unique constraint?" → defaults to
    **No, add the constraint without truncating** (no data deleted; if
    existing rows violate the constraint, the apply fails loudly at SQL
    exec time).
- Imports `lib/db/src/schema/index.ts` and computes a JSON snapshot of
  the desired schema (`generateDrizzleJson`).
- **Fast path** — if `lib/db/.sync-cache/snapshot.json` exists and its
  sibling `snapshot.guard` file matches the sha256 of the current
  numbered-migration filenames in `lib/db/drizzle/`, the script diffs
  the cached snapshot against the current one with drizzle-kit's
  `generateMigration(prev, cur)`. No live-DB introspect needed; a
  300+-table sync drops from 5+ minutes to ~5 s. The cache is refreshed
  after every successful apply.

  The cache lives **inside the repo** and is committed alongside schema
  changes. That way fresh, isolated containers — CI runners, task-agent
  sandboxes, anyone whose `/tmp` was just wiped — hit the fast path
  immediately on their first run instead of triggering a full
  introspect. (The previous `/tmp/post-merge-schema-sync.snapshot.*`
  defaults effectively guaranteed a cold cache on every cold container,
  which is what made the sync time out.)
- **Slow path** — on a cold cache (the cache files were deleted, e.g.
  on a brand-new clone before the first successful sync) or when the
  migrations guard doesn't match (a new numbered SQL file landed since
  the cache was last refreshed and may have done out-of-band DDL we
  cannot model from schema files alone), the script falls back to
  drizzle-kit's `pushSchema(...)`, which introspects the live DB and
  takes several minutes on a 300+-table schema. Set
  `POST_MERGE_FORCE_INTROSPECT=1` (or `POST_MERGE_FORCE_SYNC=1`) to
  force this path manually. After a successful slow-path run the cache
  is refreshed, so subsequent runs are fast again.
- If drizzle reports `hasDataLoss`, or the diff contains any destructive
  / ambiguous statement (`DROP TABLE / SCHEMA / VIEW`, `DROP COLUMN`,
  `RENAME TO`, `RENAME COLUMN`, `DROP CONSTRAINT`, `TRUNCATE`), the
  script **prints the full diff and exits with code 2** without touching
  the DB.
- Otherwise it applies the additive statements (`CREATE TABLE`,
  `ADD COLUMN`, new indexes, etc.) and exits 0.

Four focused tests live alongside the script. All four are wired into
`.github/workflows/db-migration-coverage.yml` (Task #1666 finished the
wiring for the first three; Task #1390 wired the fourth) so a
regression in any of the four classifiers fails the PR check:

- `lib/db/scripts/sync-schema-stdin.test.ts` — asserts the auto-Enter
  fake stdin actually delivers a `return` keypress and tears down its
  timers.
- `lib/db/scripts/sync-schema-classify.test.ts` — asserts the
  destructive-statement classifier flags `DROP * / RENAME * / DROP
  CONSTRAINT / TRUNCATE` and lets `CREATE / ADD COLUMN / CREATE INDEX`
  through. Imports the patterns and helpers from
  `lib/db/scripts/sync-schema-classify.ts` (the same module
  `sync-schema.ts` uses), so weakening a pattern in the source without
  updating the test now fails the case-level checks AND the
  pattern-set sanity assertions (Task #2062).
- `lib/db/scripts/check-fk-names.test.ts` — asserts the FK auto-name
  preflight (Task #805) flags any `.references(...)` whose default
  `<table>_<col>_<reftable>_<refcol>_fk` name would exceed Postgres's
  63-character identifier limit, while letting short FKs and
  explicitly-named long FKs pass.
- `lib/db/scripts/apply-prod-migrations.test.ts` — exercises
  `scripts/apply-prod-migrations.sh` (Tasks #1198, #1389, #1669)
  end-to-end against a throwaway Postgres schema. Pins the skip-path
  messages and exit codes (`SKIP_PROD_MIGRATIONS=1`, no `NODE_ENV`,
  missing `DATABASE_URL`), confirms a clean apply on an empty schema
  succeeds and a clean re-apply (every file already in the ledger)
  also succeeds, and pins the strict-error contract: every `psql`
  ERROR — including "already exists" and "does not exist" — fails the
  deploy with the offending file named, and the failed file is NOT
  recorded in the ledger so the next deploy retries it.

```bash
pnpm --filter @workspace/db exec tsx ./scripts/sync-schema-stdin.test.ts
pnpm --filter @workspace/db exec tsx ./scripts/sync-schema-classify.test.ts
pnpm --filter @workspace/db exec tsx ./scripts/check-fk-names.test.ts
pnpm --filter @workspace/db exec tsx ./scripts/check-fk-names.ts   # against live schema
pnpm --filter @workspace/db exec tsx ./scripts/apply-prod-migrations.test.ts
```

Note: post-merge runs the sync in the **foreground** since the snapshot
cache makes the typical run sub-second. A destructive/ambiguous diff
fails the same post-merge run (no more buried background log).

### Environment knobs

- `DRY_RUN=1` — print the diff and exit 0 without applying anything.
  Does not refresh the snapshot cache.
- `ALLOW_SCHEMA_DATA_LOSS=1` — opt in to applying destructive/ambiguous
  changes. Use only after reviewing the printed statements. Prefer
  authoring a numbered SQL file in `lib/db/drizzle/` instead.
- `POST_MERGE_FORCE_INTROSPECT=1` (or `POST_MERGE_FORCE_SYNC=1`) — bypass
  the snapshot cache and re-introspect the live DB on this run.
- `SYNC_SNAPSHOT_FILE` / `SYNC_SNAPSHOT_GUARD_FILE` — override the
  default cache paths (`lib/db/.sync-cache/snapshot.json` and
  `lib/db/.sync-cache/snapshot.guard`).

### Adding a new schema change

You have two equivalent options:

1. **Numbered SQL migration (preferred for destructive changes).** Add a
   file `lib/db/drizzle/NNNN_<description>.sql`. Use `IF NOT EXISTS` /
   `DO $$ ... $$` blocks so it stays idempotent. Post-merge will pick it
   up automatically.
2. **Schema-only change (additive).** Edit `lib/db/src/schema/golf.ts`
   (or `auth.ts`). The next post-merge sync will diff it against the DB
   and apply the additive statements automatically. If your change
   triggers a destructive diff, the sync will refuse — author a numbered
   SQL file instead.

## Verifying

```bash
psql "$DATABASE_URL" -c "\d org_memberships"   # must include vendor_operator_id
psql "$DATABASE_URL" -c "\d member_messages"   # must exist
psql "$DATABASE_URL" -c "\d member_data_requests"
psql "$DATABASE_URL" -c "\d member_comm_prefs"
```

A clean `pnpm --filter @workspace/db sync` should print
`database already matches schema. No-op.` once everything is in sync.

## Automated drift check

`scripts/check-db-drift.sh` is a non-mutating guard that catches drift
the moment it appears. It is wired into two pipeline stages so a
contributor never has to remember to run it manually:

- **Before tests** — `@workspace/api-server`'s `pretest` hook runs
  `scripts/apply-test-schema.sh`, which syncs the schema and then
  invokes the drift check. Any `pnpm --filter @workspace/api-server
  test` (local or CI) fails fast on drift with a pointer back to this
  document.
- **Before deploys** — `@workspace/api-server`'s `prebuild` hook runs
  two DB scripts in this order: `scripts/apply-prod-migrations.sh`
  (applies the migrations — see *Production migration apply* below)
  and then `scripts/predeploy-db-drift.sh`. The drift check is scoped
  to deploy / CI builds (it skips unless `NODE_ENV=production` or `CI`
  is truthy) so the ~60–120 s check does not slow down inner-loop dev
  rebuilds, but it always runs during a Replit production deploy
  because `[services.production.build.env]` sets
  `NODE_ENV=production`. Bypass with `SKIP_DEPLOY_DB_DRIFT=1` only
  after manually verifying the schema.

## Production migration apply (Tasks #1198, #1389)

`scripts/apply-prod-migrations.sh` is the prod-side counterpart to the
`for f in lib/db/drizzle/[0-9]*.sql; do psql -f "$f"; done` loop in
`scripts/post-merge.sh`. It applies every **not-yet-applied** numbered
migration in `lib/db/drizzle/` to the prod `$DATABASE_URL` during a
Replit publish, **before** the drift check above.

Why it has to exist: `post-merge.sh` only ever runs against the dev
DB, and `predeploy-db-drift.sh` is read-only. Without an active apply
step, new tables and columns lived in the migration files for months
without ever reaching prod. The marketing-site rollout (Task #1034)
finally surfaced this when a route hit a "missing table" error in
prod despite the migration existing in `lib/db/drizzle/` for weeks.

Where it runs: the api-server's `prebuild` script, ahead of
`predeploy-db-drift.sh`. Order matters — the drift check compares
`lib/db/src/schema/*.ts` against the live DB and so must see the
post-migration state. Apply, then verify.

When it runs: only when `NODE_ENV=production` (or
`FORCE_PROD_MIGRATIONS=1` is set). Local `pnpm run build` and dev
rebuilds skip it, and CI test runs are explicitly excluded so they
cannot accidentally replay prod migrations against the test DB —
those use `scripts/apply-test-schema.sh` instead.

### `__deploy_migrations` ledger (Task #1389)

The script tracks which numbered SQL files have already been applied
to this DB in a tiny bookkeeping table:

```sql
CREATE TABLE IF NOT EXISTS "__deploy_migrations" (
  filename   text PRIMARY KEY,                       -- e.g. '0042_add_widget.sql'
  applied_at timestamptz NOT NULL DEFAULT now()
);
```

The double-underscore prefix keeps it clearly out of the application
schema. On every deploy the script:

1. Creates the ledger if missing (`CREATE TABLE IF NOT EXISTS`,
   idempotent).
2. **One-time backfill (gated — Task #1667)** — if `count(*) = 0`,
   records every numbered filename currently in `lib/db/drizzle/` as
   already-applied. This is safe on the existing production DB
   because before Task #1389 the heuristic-based loop was re-running
   (and tolerating) every file on every deploy, so by induction
   every existing file had already landed in prod. The backfill
   prevents the first post-change deploy from re-running 200+ files.

   **An empty ledger alone is not a safe signal**, so the backfill
   is gated on evidence that the application schema is in fact
   present. The script probes for the baseline `public.users` table
   (created by `0000_role_system_overhaul.sql`):
   - **`users` exists** → backfill runs (matches existing prod).
   - **`users` is missing** → the script refuses to backfill and
     exits with code `2` and a clear pointer back here. This is
     the disaster-recovery / greenfield case: backfilling an empty
     schema would mark every migration as applied without executing
     any of them, so the very first request would hit "missing
     table".

   For a brand-new database, you have two options:

   - **`BOOTSTRAP_FRESH_DB=1` (preferred — Task #2071).** Re-run this
     script with `BOOTSTRAP_FRESH_DB=1`. Every numbered migration in
     `lib/db/drizzle/` is applied in order against the empty DB
     **inside a single transaction** (no backfill — each file is
     actually executed), and each filename is recorded in the ledger
     as the transaction commits. Any error rolls the whole
     transaction back: no migration is applied and the ledger
     remains empty, so the operator fixes the failing file and
     re-runs from a known-clean state. The flag still requires the
     existing prod-only gate (`NODE_ENV=production` or
     `FORCE_PROD_MIGRATIONS=1`), so a stray flag in a dev shell
     can't accidentally rebuild a non-prod DB.

   - **Manual two-step.** Run `scripts/post-merge.sh` (or
     `pnpm --filter @workspace/db sync`) against the new
     `DATABASE_URL` first to build the schema, then re-run this
     script — `users` will exist and the gate will pass on the
     second run. Equivalent to the bootstrap flag but spread across
     two commands.

   To override the probe (e.g. the schema is genuinely present but
   under a non-default name), re-run with
   `ALLOW_EMPTY_LEDGER_BACKFILL=1`. Use this only after manually
   verifying the schema actually exists; bypassing it on a real
   greenfield DB reproduces the original footgun.
3. Reads the ledger contents into a local file once, then iterates
   `lib/db/drizzle/[0-9][0-9][0-9][0-9]_*.sql` in sorted order.
4. For each file: if its basename is in the ledger, skip it. Otherwise
   run it with `psql -v ON_ERROR_STOP=1` and, on success, insert its
   filename into the ledger. **Any** non-zero `psql` exit fails the
   deploy — there is no longer any tolerated error string. Files that
   fail are NOT inserted into the ledger, so the next deploy retries
   them.

Manually marking a file as applied (e.g. you ran it out-of-band
against prod yourself, or you authored a new migration that is a
no-op against the current state and should not be replayed):

```bash
psql "$DATABASE_URL" -c \
  "INSERT INTO \"__deploy_migrations\" (filename) VALUES ('NNNN_my_file.sql')
     ON CONFLICT (filename) DO NOTHING;"
```

Inspecting the ledger:

```bash
psql "$DATABASE_URL" -c \
  "SELECT filename, applied_at FROM \"__deploy_migrations\" ORDER BY applied_at DESC LIMIT 20;"
```

### Idempotency of the migration files

Every migration file is *intended* to be idempotent (`IF NOT EXISTS`,
`DO $$ ... EXCEPTION WHEN duplicate_object` blocks, `DROP ... IF
EXISTS`). A handful of older files pre-date that convention
(`0000_role_system_overhaul`, `0007_junior_golf_programs`,
`0022_outbound_webhooks`, `0024_supported_language_enum`, etc.) and
re-emit `relation/type/column "..." already exists` when re-applied.

Pre-Task #1389 the script tolerated `ERROR: ... already exists` lines
to handle those legacy files. The ledger removes the need for that
heuristic: every existing file is in the ledger from the backfill, so
those files are never re-executed and the idempotency rough edges
become irrelevant for the prod path. Task #1669 then dropped the
tolerated-error branch entirely — every `psql` ERROR (including
"already exists") now fails the deploy with the offending file named,
so a typo in a future migration that accidentally relied on that
shape being silently swallowed aborts loudly instead of being treated
as a no-op. New files written today should still be authored to be
idempotent so they can be safely replayed in dev
(`scripts/post-merge.sh`) and in tests
(`scripts/apply-test-schema.sh`), neither of which uses the ledger.

### Failure mode

Any non-zero `psql` exit on an unapplied file fails the deploy
loudly. The failure block prints the offending file, the full psql
output, and a pointer to this document. Because the ledger insert
only happens after a successful apply, a failed file is automatically
retried on the next deploy.

### Environment knobs

- `SKIP_PROD_MIGRATIONS=1` — bypass the apply entirely (emergency
  rollback deploy that is known not to need DDL applied).
- `FORCE_PROD_MIGRATIONS=1` — run even when `NODE_ENV` is not
  `production` (manual catch-up against any `$DATABASE_URL` you have
  pointed at).
- `ALLOW_EMPTY_LEDGER_BACKFILL=1` — override the empty-ledger
  baseline-table probe (Task #1667). Set this only when you know
  the application schema already exists on the target DB but the
  `public.users` probe would fail (renamed table, non-default
  search_path). On a truly greenfield DB this re-introduces the
  silent "fresh DB marked fully migrated" footgun, so prefer
  bootstrapping the schema first (see step 2 above) over flipping
  this knob.
- `BOOTSTRAP_FRESH_DB=1` — opt-in self-bootstrap mode for a
  brand-new / disaster-recovery DB (Task #2071). When the
  empty-ledger gate detects a truly empty schema (no
  `public.users`), instead of refusing the script applies every
  numbered migration in `lib/db/drizzle/` from scratch in a single
  transaction and records each filename in the ledger on commit.
  Any error rolls the whole transaction back (no half-bootstrapped
  schema). Still requires `NODE_ENV=production` or
  `FORCE_PROD_MIGRATIONS=1` (the existing prod-only gate is
  unchanged). On a DB that already has the schema this flag is a
  no-op — the gate's baseline probe sees `public.users` and the
  script falls through to the normal backfill / apply path.

Manual run (for catch-up against a specific DB):

```bash
DATABASE_URL=postgres://... FORCE_PROD_MIGRATIONS=1 \
  bash scripts/apply-prod-migrations.sh
```

Exit codes: `0` = applied (or skipped by gate), `1` = a migration
file failed to apply, `2` = misconfiguration (`DATABASE_URL` unset,
missing `psql`, missing `lib/db/drizzle/`).

What it does (the live DB is never modified):

1. `pg_dump --schema-only` of `$DATABASE_URL`.
2. Restores that snapshot into a throwaway database
   (`drift_check_<pid>_<epoch>`).
3. Runs `drizzle-kit push --force --verbose` against the throwaway DB.
4. Inspects the captured output for substantive DDL.
5. Always drops the throwaway database (trap on `EXIT`).

Run it manually with:

```bash
pnpm run check:db-drift
```

Exit codes:

- `0` — drizzle-kit reported `No changes detected` (or only the known
  cosmetic FK-rename / default re-formatting churn drizzle emits every
  run because Postgres truncates identifiers to 63 chars).
- `1` — substantive drift was detected (new/removed tables or columns,
  type changes, indexes, enum changes), or drizzle-kit stalled on an
  interactive prompt. The script prints the offending statements.
- `2` — `$DATABASE_URL` is not set or cannot be parsed, the user lacks
  `CREATEDB`, or `pg_dump` failed.

The check needs ~60–120 s (drizzle-kit re-introspects the entire
schema). It is intended as a pre-test / CI gate, not an inner-loop
command. When it fails, follow the catch-up flow above and re-run it.

## Things that break a clean sync / push

- A duplicated column block in `golf.ts` (drizzle-kit will throw
  `duplicate key`). Search for repeated column names inside a single
  table definition.
- Malformed defaults like `default(sql\`'[]'::jsonb\`)` written as
  `default(sql\`[]::jsonb\`)`.
- Redundant `uniqueIndex(...)` declarations on a column that already
  has `.unique()` at the column level.
- Pre-existing rows that violate a new `UNIQUE` constraint (e.g.
  `tee_pricing_rules` with duplicate `(course_id, name)`). Clear them
  first with a targeted `DELETE`.
- Stale tables present in the DB but absent from the schema. The new
  sync will refuse to drop them automatically; either add the table
  back to the schema, or write a numbered SQL migration that drops
  it explicitly, or run the sync with `ALLOW_SCHEMA_DATA_LOSS=1`
  after reviewing the diff.
