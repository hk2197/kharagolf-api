# Squashing the Drizzle migration history

> **TL;DR.** `lib/db/drizzle/0000_initial.sql` is a single idempotent
> baseline that replaces the historical numbered migrations.
> Regenerate it with
> [`lib/db/scripts/squash-baseline.sh`](../lib/db/scripts/squash-baseline.sh)
> only when the file count climbs back into the hundreds — every
> normal schema change is still a brand-new numbered migration.

## Why the baseline exists

Before Task #1716 `lib/db/drizzle/` accumulated 213 numbered migration
files. Every `scripts/post-merge.sh` run (and every `scripts/apply-prod-
migrations.sh` run on a fresh prod) re-walked the full list with
`psql -v ON_ERROR_STOP=1`, which made cold dev containers and
disaster-recovery bootstraps progressively slower. Task #1716 squashed
the history into one file, `lib/db/drizzle/0000_initial.sql`, that:

- Builds the same schema the original 213 files built (verified by
  `pg_dump --schema-only` diff).
- Is **idempotent** — applying it once on a fresh DB or twice on an
  already-migrated DB both succeed under `ON_ERROR_STOP=1`. This is
  what makes the apply loops in `scripts/post-merge.sh` and
  `scripts/apply-prod-migrations.sh` safe regardless of starting
  state.
- Coexists with the per-PR migration cadence: new schema changes still
  land as new numbered files (`0132_*.sql`, `0133_*.sql`, …) directly
  under `lib/db/drizzle/`. The baseline only ever replaces *historical*
  migrations.

The squash itself was performed once, by hand, with an ad-hoc
`/tmp/squash_make_idempotent.py` post-processor that was never checked
in — losing the institutional knowledge of how to do it again. Task
#2138 (this doc + the scripts that ship with it) fixes that gap.

## When to squash again

Only when **all** of the following hold:

1. The numbered file count under `lib/db/drizzle/` is back into the
   hundreds (~150+).
2. `scripts/post-merge.sh` slow-path runs measurably slower than
   target, even after the schema-hash short-circuit and snapshot
   cache (see `docs/db-test-sync.md`).
3. There is no in-flight schema work on a feature branch — the
   squash window must coincide with main being quiet, because every
   open branch has to rebase its schema onto the new baseline.

Squashing more often than that is **not free**: every developer
container has to refresh `lib/db/.sync-cache/` and walk the new
baseline once before the fast path warms up.

## Layout invariants the squash must preserve

The apply loops only consider files matching `[0-9][0-9][0-9][0-9]_*.sql`
**directly under** `lib/db/drizzle/`. Anything moved into
`lib/db/drizzle/archive/` is preserved for git-history reference but
is never re-applied.

```
lib/db/drizzle/
├── 0000_initial.sql              ← the baseline
├── 0132_*.sql … 0151_*.sql       ← per-PR migrations since the squash
├── archive/                       ← old per-PR migrations (NOT applied)
│   ├── 0000_role_system_overhaul.sql
│   ├── 0001_org_contact_fields.sql
│   └── …
└── meta/
    └── _journal.json              ← drizzle-kit's journal — see below
```

After a squash, the **previous** baseline + every numbered file the
new baseline replaces moves into `archive/` (or stays there, if it was
already archived during a previous squash). Never delete archive
files; they are the only record of the per-PR intent for code
archaeology.

## How to regenerate

### Prerequisites

- Two empty PostgreSQL databases the operator can `CREATE DATABASE`.
  - A local Postgres works fine: `createdb squash_build && createdb
    squash_validate`.
  - A managed Postgres (Replit DB, RDS, Cloud SQL) works too — point
    `BUILD_DATABASE_URL` / `VALIDATE_DATABASE_URL` at any two
    fresh, schemaless databases.
- `psql`, `pg_dump`, `python3` on PATH (already provisioned by the Nix
  shell in this repo).

### One-shot regenerate + validate

```bash
# 1. Provision two empty DBs
createdb squash_build
createdb squash_validate

export BUILD_DATABASE_URL="postgres://localhost/squash_build"
export VALIDATE_DATABASE_URL="postgres://localhost/squash_validate"

# 2. Regenerate + validate in one shot
lib/db/scripts/squash-baseline.sh \
    --migrations lib/db/drizzle \
    --output     lib/db/drizzle/0000_initial.sql \
    --validate
```

What the script does, in order:

1. Refuses to run unless `BUILD_DATABASE_URL` is empty in `public`
   (set `FORCE_NON_EMPTY=1` to override — only safe if you just
   truncated the schema yourself).
2. Applies every numbered file under `--migrations` in `sort` order
   (matches `scripts/post-merge.sh`) with `ON_ERROR_STOP=1`.
3. Runs `pg_dump --schema-only --no-owner --no-privileges
   --no-comments` against the build DB.
4. Pipes the dump through
   [`squash-baseline-postprocess.py`](../lib/db/scripts/squash-baseline-postprocess.py)
   to apply the idempotency rewrites (see "Idempotency rules" below).
5. Atomically writes the result to `--output`.
6. With `--validate`, applies the new baseline twice against
   `VALIDATE_DATABASE_URL`. Pass 1 builds from scratch; pass 2 must
   be a no-op under `ON_ERROR_STOP=1`. Then `pg_dump`'s the build DB
   and the validate DB and asserts the diff is empty (after stripping
   pg_dump 16.x's per-session `\restrict <token>` nonces).

If any step fails the script exits non-zero and leaves
`--output` untouched.

### Manual / debugging

The post-processor is a pure stdin-to-stdout transform, so you can
inspect it in isolation:

```bash
pg_dump --schema-only --no-owner --no-privileges --no-comments \
        "$BUILD_DATABASE_URL" \
  | python3 lib/db/scripts/squash-baseline-postprocess.py \
  > /tmp/baseline.sql
```

To reproduce the validation diff yourself:

```bash
diff -u \
  <(pg_dump --schema-only --no-owner --no-privileges --no-comments "$BUILD_DATABASE_URL"   | grep -Ev '^\\(restrict|unrestrict)\b') \
  <(pg_dump --schema-only --no-owner --no-privileges --no-comments "$VALIDATE_DATABASE_URL" | grep -Ev '^\\(restrict|unrestrict)\b')
```

### Idempotency rules

The post-processor applies these rewrites — they are the same rules
the original Task #1716 ad-hoc script applied, plus one extension
(see "Notes" below):

| Statement                             | Rewrite                                                                                                                     |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `CREATE TYPE …`                       | wrap in `DO $do$ BEGIN … EXCEPTION WHEN duplicate_object THEN null; END $do$`                                              |
| `CREATE TRIGGER …`                    | same as above                                                                                                               |
| `CREATE POLICY …`                     | same as above                                                                                                               |
| `CREATE TABLE …`                      | `CREATE TABLE IF NOT EXISTS …`                                                                                              |
| `CREATE SEQUENCE …`                   | `CREATE SEQUENCE IF NOT EXISTS …`                                                                                           |
| `CREATE [UNIQUE] INDEX …`             | `CREATE [UNIQUE] INDEX IF NOT EXISTS …`                                                                                     |
| `CREATE MATERIALIZED VIEW …`          | `CREATE MATERIALIZED VIEW IF NOT EXISTS …`                                                                                  |
| `CREATE VIEW …`                       | `CREATE OR REPLACE VIEW …`                                                                                                  |
| `CREATE FUNCTION …`                   | `CREATE OR REPLACE FUNCTION …`                                                                                              |
| `ALTER TABLE … ADD CONSTRAINT …`      | wrap in `DO $do$ BEGIN … EXCEPTION WHEN duplicate_object / duplicate_table / invalid_table_definition / unique_violation THEN null; END $do$` |

Lines stripped from the dump entirely (session-local pg_dump preamble
that breaks under `ON_ERROR_STOP=1` on some psql ↔ pg_dump version
mismatches):

- `SET …;` (statement_timeout, search_path, …)
- `SELECT pg_catalog.set_config(…);`
- `\restrict` / `\unrestrict` / `\connect` (psql backslash directives)
- `COMMENT ON EXTENSION …` (requires owner privs that managed Postgres
  rarely grants — the comment is harmless to drop)

**Notes on the ADD CONSTRAINT exception list.** The original Task
#1716 baseline catches four error classes, not two, because:

- adding a duplicate `PRIMARY KEY` raises `invalid_table_definition`
  ("multiple primary keys for table … are not allowed"), **not**
  `duplicate_object`;
- adding a duplicate `UNIQUE` constraint can race with conflicting
  data mid-creation and raise `unique_violation`.

Both have been observed when re-applying the baseline on top of an
already-migrated production DB, so the post-processor catches all
four classes for `ADD CONSTRAINT` (vs. a single `duplicate_object`
class for `CREATE TYPE / TRIGGER / POLICY`, which can only fire one
way).

## Validation: what "good" looks like

The `--validate` pass exercises the three checks Task #2138 calls
out:

1. **Fresh apply, 0 errors** — `psql -v ON_ERROR_STOP=1 -f
   0000_initial.sql` against an empty DB exits 0 with no error
   output. NOTICEs about `IF NOT EXISTS` skips are expected and
   benign.
2. **Re-apply, 0 errors** — running the same command a second time
   against the now-built DB exits 0 (still `ON_ERROR_STOP=1`). This
   is the property that makes the apply loops in
   `scripts/post-merge.sh` / `scripts/apply-prod-migrations.sh` safe
   on existing prod.
3. **`pg_dump` diff = 0** — the post-baseline schema is byte-identical
   to the schema the historical migrations would have built (after
   stripping per-session `\restrict` nonces). If this diff is non-empty
   the squash dropped or reordered something; review the diff in the
   script's error output and fix the post-processor or the migrations
   before checking the new baseline in.

You can also validate manually after the fact by pointing
`apply-prod-migrations.sh` at a copy of prod:

```bash
NODE_ENV=production \
DATABASE_URL=postgres://…/prod_copy \
scripts/apply-prod-migrations.sh
```

It must exit 0 and add zero rows to `__deploy_migrations` (the
baseline's filename is already in the ledger; see below).

## `meta/_journal.json` regeneration

Drizzle-kit keeps a journal at `lib/db/drizzle/meta/_journal.json`
recording one entry per numbered migration. The squash collapses the
history, so the journal is rewritten to reference exactly one entry —
the baseline:

```json
{
  "version": "7",
  "dialect": "postgresql",
  "entries": [
    {
      "idx": 0,
      "version": "7",
      "when": 1746000000000,
      "tag": "0000_initial",
      "breakpoints": true
    }
  ]
}
```

Rules when regenerating:

- `idx`: `0` for the baseline, then sequential for every numbered
  migration that survived the squash (post-squash files keep their
  `idx` from before — drizzle-kit only cares about uniqueness and
  ordering, not contiguity).
- `version` / `dialect`: copy from the existing file. Bumping is a
  separate, deliberate change.
- `when`: any past unix-millis timestamp older than the oldest
  surviving post-squash migration's `when`. The `1746000000000` value
  in the current file (≈ April 2025) was chosen for that reason; pick
  something similar (e.g. one second before the oldest surviving
  migration).
- `tag`: filename without the `.sql` extension.
- `breakpoints`: `true` (drizzle-kit's default).

Drizzle-kit only reads `_journal.json` for `drizzle-kit migrate`,
which **this repo does not use** — `scripts/post-merge.sh` and
`scripts/apply-prod-migrations.sh` apply files directly with `psql`.
The journal exists so a future migration generated with `drizzle-kit
generate` lands at the correct next index. Mis-numbering the journal
is recoverable (drop the file and `drizzle-kit generate` will rebuild
it), but it is easier to get right the first time.

## `__deploy_migrations` ledger compatibility

`scripts/apply-prod-migrations.sh` records every successfully-applied
filename in the `__deploy_migrations` table on prod. After a squash:

- The new `0000_initial.sql` filename is **not** in the ledger on the
  pre-squash prod DB. Without intervention the apply loop would try
  to apply it on the very next deploy.
- Since the baseline is idempotent (that is the whole point), simply
  applying it on prod is safe — every statement is either an `IF NOT
  EXISTS` no-op or a wrapped `DO/EXCEPTION` no-op. So the simplest
  correct behaviour on the post-squash deploy is to let the apply
  loop run the baseline once. It will succeed and record `0000_initial.sql`
  in the ledger.

To verify before deploy, on a copy of prod:

```bash
psql "$PROD_COPY_URL" -c \
  "SELECT count(*) FROM __deploy_migrations WHERE filename = '0000_initial.sql';"
# → 0 (baseline not yet applied — apply-prod-migrations.sh will apply
#      it on the next deploy and the count becomes 1)

NODE_ENV=production DATABASE_URL="$PROD_COPY_URL" \
  scripts/apply-prod-migrations.sh

psql "$PROD_COPY_URL" -c \
  "SELECT count(*) FROM __deploy_migrations WHERE filename = '0000_initial.sql';"
# → 1
```

The names of the files the squash *replaces* should already be in the
ledger from previous deploys (the original heuristic loop pre-#1389
backfilled them, and the gated backfill in `apply-prod-migrations.sh`
keeps them there). Do **not** delete those ledger rows — they are the
historical record and harmless: the apply loop only iterates files
that physically exist under `lib/db/drizzle/`, so archived filenames
in the ledger are simply ignored.

If the squash is also paired with renaming pre-existing post-squash
files (e.g. consolidating `0132_a.sql` + `0132_b.sql` into a single
`0132.sql`), the ledger entries for the old names stay; the new name
is applied and recorded normally on the next deploy. If you must
*delete* a previously-applied file (rare — usually only when
correcting a mistakenly-merged migration), remove its row from the
ledger by hand.

## Checklist for a squash PR

- [ ] Wait for an empty queue: no in-flight schema work on any
  feature branch.
- [ ] Provision two empty DBs and export `BUILD_DATABASE_URL` /
  `VALIDATE_DATABASE_URL`.
- [ ] `lib/db/scripts/squash-baseline.sh --migrations lib/db/drizzle
  --output lib/db/drizzle/0000_initial.sql --validate` exits 0.
- [ ] Move the historical numbered files the squash replaces into
  `lib/db/drizzle/archive/` (preserve filenames; never delete).
- [ ] Rewrite `lib/db/drizzle/meta/_journal.json` (see rules above).
- [ ] Run `scripts/post-merge.sh` against a fresh dev DB; it must
  exit 0 with the snapshot cache freshly written.
- [ ] On a copy of prod (or staging), run
  `NODE_ENV=production scripts/apply-prod-migrations.sh`; it must
  exit 0 and add `0000_initial.sql` to `__deploy_migrations`.
- [ ] Land the PR; the next prod deploy auto-applies the new
  baseline via the same `apply-prod-migrations.sh` path.
