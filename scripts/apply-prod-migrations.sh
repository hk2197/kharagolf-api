#!/bin/bash
#
# Pre-deploy: apply every numbered SQL migration in lib/db/drizzle/ to
# the production $DATABASE_URL before the app starts serving — but
# **only** the files that have not already been recorded in the
# `__deploy_migrations` ledger table.
#
# Why this exists (Task #1198 / Task #1389):
#   `scripts/post-merge.sh` applies the same migrations on every task
#   merge but only ever runs against the **dev** DB. There is no path
#   that applies them to production. `scripts/predeploy-db-drift.sh`
#   only *checks* for drift (read-only). The result was that new tables
#   and columns lived in code for months without ever reaching prod —
#   the marketing-site rollout (Task #1034) only surfaced this when a
#   route returned a "missing table" error in prod despite the
#   migration existing in `lib/db/drizzle/` for weeks.
#
#   The original Task #1198 implementation re-ran every numbered file
#   on every deploy and used a heuristic ("ERROR: ... already exists")
#   to decide which errors were no-ops. That worked but was fragile —
#   a future migration that legitimately raised an "already exists"
#   error (e.g. due to a typo) could be silently swallowed, and every
#   deploy paid the cost of re-running 200+ files. Task #1389 replaces
#   the heuristic with an explicit ledger: every successfully-applied
#   filename is recorded in `__deploy_migrations`, the script skips
#   files already in the ledger, and each new file is applied with
#   `ON_ERROR_STOP=1` so any error is fatal. Task #1669 then dropped
#   the tolerated-error branch entirely — there is no longer ANY
#   error-string filter, so a typo in a future migration that would
#   have produced "already exists" aborts the deploy loudly with the
#   offending file and full psql output instead of being silently
#   treated as a no-op.
#
# Where it runs:
#   From `artifacts/api-server`'s `prebuild` script, BEFORE
#   `scripts/predeploy-db-drift.sh`. Order matters: the drift check
#   compares `lib/db/src/schema/*.ts` against the live DB, so it must
#   see the post-migration state. Apply first, then verify.
#
# When it runs:
#   Replit production deploys set NODE_ENV=production in
#   `[services.production.build.env]`, so this script triggers
#   automatically during a publish. Local `pnpm run build` and dev
#   rebuilds (NODE_ENV=development) are no-ops so the inner loop stays
#   fast. We deliberately do NOT auto-trigger on CI=true — CI test
#   runs already manage the test DB through `scripts/apply-test-schema.sh`
#   and must not have prod migrations replayed against an unrelated
#   DATABASE_URL. Set FORCE_PROD_MIGRATIONS=1 to override the gate.
#
# Skip with SKIP_PROD_MIGRATIONS=1 (e.g. emergency rollback that is
# known not to need any DDL applied).
#
# Exit codes: 0 = applied (or skipped), non-zero = failure (the deploy
# is aborted by the prebuild chain).

set -euo pipefail

is_truthy() {
  case "${1:-}" in
    1|true|TRUE|True|yes|YES) return 0 ;;
    *) return 1 ;;
  esac
}

if is_truthy "${SKIP_PROD_MIGRATIONS:-}"; then
  echo "SKIP_PROD_MIGRATIONS set → skipping production migration apply."
  exit 0
fi

if [ "${NODE_ENV:-}" != "production" ] \
     && ! is_truthy "${FORCE_PROD_MIGRATIONS:-}"; then
  echo "apply-prod-migrations: NODE_ENV=${NODE_ENV:-unset} → skipping" \
       "(not a production deploy; set FORCE_PROD_MIGRATIONS=1 to override)."
  exit 0
fi

if [ -z "${DATABASE_URL:-}" ]; then
  echo "ERROR: DATABASE_URL is not set; cannot apply production migrations." >&2
  echo "       Set DATABASE_URL (or SKIP_PROD_MIGRATIONS=1 to bypass)." >&2
  echo "       See docs/db-test-sync.md." >&2
  exit 2
fi

if ! command -v psql >/dev/null 2>&1; then
  echo "ERROR: psql is not on PATH; cannot apply production migrations." >&2
  exit 2
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MIGRATIONS_DIR="$REPO_ROOT/lib/db/drizzle"

if [ ! -d "$MIGRATIONS_DIR" ]; then
  echo "ERROR: migrations dir not found: $MIGRATIONS_DIR" >&2
  exit 2
fi

shopt -s nullglob
files=( "$MIGRATIONS_DIR"/[0-9][0-9][0-9][0-9]_*.sql )
shopt -u nullglob

if [ "${#files[@]}" -eq 0 ]; then
  echo "▶ apply-prod-migrations: no numbered migrations found under" \
       "$MIGRATIONS_DIR — nothing to apply."
  exit 0
fi

# Sort by leading number then name, matching scripts/post-merge.sh.
IFS=$'\n' sorted=( $(printf '%s\n' "${files[@]}" | sort) )
unset IFS

LOG="$(mktemp -t apply-prod-migrations.XXXXXX.log)"
APPLIED_LIST="$(mktemp -t apply-prod-migrations.applied.XXXXXX)"
BOOTSTRAP_SQL="$(mktemp -t apply-prod-migrations.bootstrap.XXXXXX.sql)"
cleanup() { rm -f "$LOG" "$APPLIED_LIST" "$BOOTSTRAP_SQL"; }
trap cleanup EXIT INT TERM

# ---------------------------------------------------------------------------
# Ledger setup (Task #1389)
# ---------------------------------------------------------------------------
# `__deploy_migrations` is a tiny bookkeeping table that records which
# numbered SQL files have already been successfully applied to this
# DB. It is created here (idempotently) on the very first deploy that
# carries this script change. The double-underscore prefix keeps it
# clearly out of the application schema (which never starts with `__`).
#
# Schema stays minimal on purpose:
#   filename   text PRIMARY KEY  -- e.g. '0042_add_widget_table.sql'
#   applied_at timestamptz NOT NULL DEFAULT now()
LEDGER_TABLE='"__deploy_migrations"'

echo "▶ apply-prod-migrations: ensuring ledger table $LEDGER_TABLE exists..."
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -X -q -c "
  CREATE TABLE IF NOT EXISTS ${LEDGER_TABLE} (
    filename   text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  );
" >/dev/null

# Read the current ledger contents into a local file so per-file
# membership checks are an in-memory grep instead of a network round
# trip per migration. (200+ files × per-file SELECT would otherwise
# add seconds of latency to every deploy.)
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -X -q -t -A \
     -c "SELECT filename FROM ${LEDGER_TABLE};" \
     > "$APPLIED_LIST"

ledger_count="$(wc -l < "$APPLIED_LIST" | tr -d ' ')"

# ---------------------------------------------------------------------------
# One-time backfill (gated — Task #1667)
# ---------------------------------------------------------------------------
# Before Task #1389 prod was kept caught-up by a heuristic loop that
# re-ran every numbered file on every deploy. That means every file
# currently in lib/db/drizzle/ has, by induction, already landed in
# prod. So on the very first run after the ledger table is created
# we record every existing numbered file as already-applied,
# preventing the first post-change deploy from re-running 200+ files.
#
# **Important:** an empty ledger is NOT a safe signal on its own.
# Two very different DBs both report `count(*) = 0`:
#   1. Existing prod (pre-#1389) — schema is fully built, the ledger
#      just hasn't been populated yet. Backfill is correct.
#   2. A brand-new DB or one restored from a schemaless backup —
#      no application tables exist. Backfilling here would silently
#      mark every migration as applied without ever executing it,
#      leaving an empty schema that thinks it's fully migrated. The
#      very first request would then 500 with "missing table".
#
# To tell the two apart we probe for a known baseline application
# table (`users`, created by `0000_role_system_overhaul.sql`). Its
# presence in `public` is sufficient evidence that the migrations
# have already been applied out-of-band; its absence means we're
# looking at a greenfield DB and must NOT silently skip 200+ files.
#
# An explicit override (`ALLOW_EMPTY_LEDGER_BACKFILL=1`) exists for
# the rare disaster-recovery / out-of-band-restore case where the
# operator knows the schema is in fact present but the baseline
# probe is misleading (e.g. `users` was renamed, or the schema lives
# under a non-default search_path). The override is documented in
# `docs/db-test-sync.md`.
if [ "$ledger_count" -eq 0 ]; then
  if is_truthy "${ALLOW_EMPTY_LEDGER_BACKFILL:-}"; then
    backfill_reason="ALLOW_EMPTY_LEDGER_BACKFILL=1 set (operator override)"
  else
    # Probe for the baseline `users` table. `to_regclass` returns NULL
    # if the relation does not exist (rather than raising), which keeps
    # the script's `set -e` happy.
    baseline_present="$(psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -X -q -t -A \
       -c "SELECT to_regclass('public.users') IS NOT NULL;")"
    case "$baseline_present" in
      t|true) backfill_reason="baseline 'public.users' table is present (pre-#1389 prod)" ;;
      *)
        # -----------------------------------------------------------------
        # Greenfield bootstrap (Task #2071)
        # -----------------------------------------------------------------
        # `BOOTSTRAP_FRESH_DB=1` is the opt-in self-bootstrap mode for the
        # disaster-recovery / brand-new-DB case the gate above refuses.
        # Instead of (a) silently backfilling an empty schema or (b)
        # bouncing the operator back to `scripts/post-merge.sh`, we apply
        # every numbered migration in `lib/db/drizzle/` to this DB from
        # scratch, in a single transaction, and record each filename in
        # the ledger as it commits.
        #
        # All-or-nothing on purpose: if any file fails the whole
        # transaction rolls back, including ledger inserts for prior
        # files, so a half-bootstrapped schema can never persist. The
        # operator fixes the failing migration and re-runs — the gate is
        # still in place because the schema is still empty.
        #
        # The flag still requires the existing prod-only gate
        # (NODE_ENV=production OR FORCE_PROD_MIGRATIONS=1, checked at the
        # top of this script) so a stray BOOTSTRAP_FRESH_DB=1 in a dev
        # shell can't accidentally rebuild a non-prod DB.
        if is_truthy "${BOOTSTRAP_FRESH_DB:-}"; then
          echo "▶ apply-prod-migrations: BOOTSTRAP_FRESH_DB=1 →" \
               "applying ${#sorted[@]} migration(s) from scratch in a" \
               "single transaction..."

          # Build one SQL stream: BEGIN; <\i file + INSERT> per migration;
          # COMMIT;. `\set ON_ERROR_STOP on` makes psql abort on the
          # first error (which also aborts the implicit transaction the
          # BEGIN opens). The per-file `\echo` markers tell the operator
          # exactly which migration was running when an error fired —
          # psql itself prints the file/line of the failing statement.
          {
            echo "\\set ON_ERROR_STOP on"
            echo "BEGIN;"
            for f in "${sorted[@]}"; do
              base="$(basename "$f")"
              esc="${base//\'/\'\'}"
              printf '\\echo Applying %s\n' "$base"
              printf '\\i %s\n' "$f"
              printf "INSERT INTO %s (filename) VALUES ('%s');\n" \
                     "$LEDGER_TABLE" "$esc"
            done
            echo "COMMIT;"
          } > "$BOOTSTRAP_SQL"

          : > "$LOG"
          set +e
          psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -X -q -f "$BOOTSTRAP_SQL" \
               > "$LOG" 2>&1
          psql_rc=$?
          set -e

          if [ "$psql_rc" -ne 0 ]; then
            {
              echo ""
              echo "=================================================================="
              echo "✗ BOOTSTRAP_FRESH_DB: bootstrap apply FAILED"
              echo "=================================================================="
              echo "psql exit: $psql_rc"
              echo ""
              echo "Full psql output (the last 'Applying <file>' line names the"
              echo "migration that was running when the error fired):"
              sed 's/^/  /' "$LOG"
              echo ""
              echo "The entire bootstrap transaction was rolled back: no"
              echo "migration was applied and the ledger remains empty. Fix"
              echo "the failing migration and re-run with BOOTSTRAP_FRESH_DB=1"
              echo "(the gate still applies because the schema is still empty)."
              echo "See docs/db-test-sync.md."
              echo "=================================================================="
            } >&2
            exit 1
          fi

          # Surface psql's own per-file '\echo Applying ...' lines so the
          # operator can see what was bootstrapped.
          sed 's/^/  /' "$LOG"
          echo "✓ apply-prod-migrations: bootstrap committed" \
               "${#sorted[@]} migration(s) and recorded each in" \
               "${LEDGER_TABLE}."
          exit 0
        fi

        {
          echo ""
          echo "=================================================================="
          echo "✗ apply-prod-migrations: REFUSING to backfill an empty ledger"
          echo "=================================================================="
          echo "The ${LEDGER_TABLE} ledger is empty AND the baseline application"
          echo "table 'public.users' does NOT exist on this database."
          echo ""
          echo "This looks like a brand-new / restored-from-backup database, not"
          echo "a pre-#1389 production DB. If we backfilled here, every numbered"
          echo "migration would be silently marked as already-applied without"
          echo "ever being executed, and the very first request to the app would"
          echo "fail with 'missing table'."
          echo ""
          echo "What to do:"
          echo "  • To self-bootstrap this DB end-to-end from inside this script:"
          echo "    re-run with BOOTSTRAP_FRESH_DB=1. Every migration in"
          echo "    lib/db/drizzle/ will be applied in order inside a single"
          echo "    transaction and each filename recorded in the ledger on"
          echo "    success. Any error rolls the whole transaction back."
          echo "  • Or, equivalently, run \`scripts/post-merge.sh\` (or"
          echo "    \`pnpm --filter @workspace/db sync\`) against the new"
          echo "    DATABASE_URL first to build the schema, then re-run this"
          echo "    script — \`users\` will exist and the gate will pass."
          echo "  • If you are SURE this DB already has the application schema"
          echo "    under a non-default name and the baseline probe is wrong,"
          echo "    re-run with ALLOW_EMPTY_LEDGER_BACKFILL=1 to override."
          echo "  • See docs/db-test-sync.md → '__deploy_migrations ledger'"
          echo "    for the full runbook."
          echo "=================================================================="
        } >&2
        exit 2
        ;;
    esac
  fi

  echo "▶ apply-prod-migrations: ledger is empty — backfilling" \
       "${#sorted[@]} existing migration filename(s) as already-applied" \
       "(${backfill_reason}; see Tasks #1389, #1667)."

  # Build a single multi-row INSERT to keep the backfill atomic. Pipe
  # the values through stdin so we don't have to splice 200+ filenames
  # into a single -c argument and worry about command-line length.
  {
    echo "INSERT INTO ${LEDGER_TABLE} (filename) VALUES"
    first=1
    for f in "${sorted[@]}"; do
      base="$(basename "$f")"
      # Escape any embedded single quotes (none today, but be safe).
      esc="${base//\'/\'\'}"
      if [ "$first" -eq 1 ]; then
        printf "  ('%s')" "$esc"
        first=0
      else
        printf ",\n  ('%s')" "$esc"
      fi
    done
    printf "\nON CONFLICT (filename) DO NOTHING;\n"
  } | psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -X -q >/dev/null

  # Refresh the local cache so the apply loop below sees the backfill.
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -X -q -t -A \
       -c "SELECT filename FROM ${LEDGER_TABLE};" \
       > "$APPLIED_LIST"

  echo "  backfilled $(wc -l < "$APPLIED_LIST" | tr -d ' ') entries."
fi

# ---------------------------------------------------------------------------
# Apply loop
# ---------------------------------------------------------------------------
echo "▶ apply-prod-migrations: scanning ${#sorted[@]} numbered" \
     "migration(s) against ledger..."

applied=0
skipped=0
for f in "${sorted[@]}"; do
  rel="${f#$REPO_ROOT/}"
  base="$(basename "$f")"

  # Already-applied? (Exact-line match against the cached ledger.)
  if grep -Fxq "$base" "$APPLIED_LIST"; then
    skipped=$((skipped + 1))
    continue
  fi

  echo "  • $rel"

  # ON_ERROR_STOP=1: any error aborts the file (and the deploy).
  # No more "already exists" tolerance — if the file has already been
  # applied to this DB it should be in the ledger; if it isn't, we
  # genuinely want to apply it, and any error is genuinely fatal.
  : > "$LOG"
  set +e
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -X -q -f "$f" \
       > "$LOG" 2>&1
  psql_rc=$?
  set -e

  if [ "$psql_rc" -ne 0 ]; then
    {
      echo ""
      echo "=================================================================="
      echo "✗ Production migration FAILED: $rel"
      echo "=================================================================="
      echo "psql exit: $psql_rc"
      echo ""
      echo "Full psql output:"
      sed 's/^/  /' "$LOG"
      echo ""
      echo "This file is NOT yet recorded in the ${LEDGER_TABLE} ledger,"
      echo "so the next deploy will retry it. Fix the migration file"
      echo "(or, if it has already been applied out-of-band, INSERT its"
      echo "filename into ${LEDGER_TABLE} manually) before redeploying."
      echo "Use SKIP_PROD_MIGRATIONS=1 only for an emergency rollback"
      echo "deploy that is known not to need DDL applied."
      echo "See docs/db-test-sync.md."
      echo "=================================================================="
    } >&2
    exit 1
  fi

  # Success → record in ledger so future deploys skip it.
  esc="${base//\'/\'\'}"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -X -q -c "
    INSERT INTO ${LEDGER_TABLE} (filename) VALUES ('${esc}')
      ON CONFLICT (filename) DO NOTHING;
  " >/dev/null
  echo "$base" >> "$APPLIED_LIST"
  applied=$((applied + 1))
done

echo "✓ apply-prod-migrations: applied=$applied," \
     "skipped (already in ledger)=$skipped," \
     "total=${#sorted[@]} (against \$DATABASE_URL)."
