#!/bin/bash
#
# Non-mutating drift check for the test database.
#
# Why: lib/db/src/schema/golf.ts is the source of truth, but the test DB
# has historically drifted (47 tables behind, undetected for weeks).
# This script catches drift the moment it appears so a privacy/staff
# test does not have to crash to surface it.
#
# How (true dry-run, the live DB is never modified):
#   1. Snapshot the live DB schema with pg_dump --schema-only.
#   2. Restore that snapshot into a throwaway database
#      (drift_check_<pid>_<epoch>).
#   3. Run `drizzle-kit push --force --verbose` against the throwaway DB.
#   4. Inspect the captured output for substantive DDL.
#   5. Always DROP the throwaway database (trap on EXIT).
#
# Inspection:
#   * "No changes detected"            → exit 0 (clean).
#   * Any DDL drizzle would apply (CREATE/DROP TABLE, ADD/DROP/ALTER
#     COLUMN, indexes, enum changes, FK constraint changes)
#                                                     → exit 1 with a
#     pointer to docs/db-test-sync.md.
#   * Stalled prompt / unparseable output             → exit 1.
#
# Two narrowly-scoped exceptions:
#   * Long FK names that Postgres truncates to 63 chars used to re-emit
#     on every push. Fixed at the schema level — golf.ts uses explicit
#     short `foreignKey({ name: ... })` names for any FK whose auto-name
#     would exceed 63 chars.
#   * `ALTER COLUMN ... SET DEFAULT` re-formatting churn for jsonb /
#     text[] / array defaults (drizzle re-emits `ARRAY['email']::text[]`
#     vs the Postgres-stored `ARRAY['email'::text]`, jsonb pretty-prints
#     keys in alphabetical order, etc.). Filtered ONLY for the specific
#     literal-shapes drizzle is known to reformat (jsonb literal,
#     text[] literal, ARRAY[...] literal). All other SET DEFAULT
#     changes — numbers, timestamps, enums, plain strings — are still
#     reported as real drift so an intentional default change cannot
#     hide. See `lib/db/scripts/sync-schema.ts` for the same exception.
#
# Exit codes: 0 = clean, 1 = drift, 2 = misconfiguration.
#
# Usage:
#   scripts/check-db-drift.sh
#   pnpm run check:db-drift
#
set -euo pipefail

if [ -z "${DATABASE_URL:-}" ]; then
  echo "ERROR: DATABASE_URL is not set." >&2
  echo "       Provision a database (see docs/db-test-sync.md) and re-run." >&2
  exit 2
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DOCS_REF="docs/db-test-sync.md"

# ── Fast path ───────────────────────────────────────────────────────────
# When `lib/db/scripts/sync-schema.ts` last converged the DB to the
# current schema it cached the JSON snapshot it converged to. Diffing
# that snapshot against `generateDrizzleJson(schema)` in pure JS catches
# any pending DDL in a couple of seconds — no pg_dump, no throwaway DB,
# no drizzle-kit reintrospect. We only fall back to the slow dump+push
# below when the cache is missing (cold container / fresh checkout) or
# stale because a new numbered migration landed (which may have done
# out-of-band DDL we cannot model from the schema files alone). Set
# DRIFT_CHECK_FORCE_SLOW=1 to skip the fast path and always introspect.
FAST_SCRIPT="$REPO_ROOT/lib/db/scripts/check-drift-fast.ts"
if [ -f "$FAST_SCRIPT" ] && [ "${DRIFT_CHECK_FORCE_SLOW:-0}" != "1" ]; then
  set +e
  ( cd "$REPO_ROOT/lib/db" && pnpm exec tsx "$FAST_SCRIPT" )
  FAST_RC=$?
  set -e
  case "$FAST_RC" in
    0) exit 0 ;;     # clean
    1) exit 1 ;;     # drift detected (script already printed details)
    2) exit 2 ;;     # misconfiguration (DATABASE_URL unset, etc.)
    3) ;;            # cache miss → fall through to slow path below
    *)
      echo "WARN: fast drift check exited with $FAST_RC; falling back to slow path." >&2
      ;;
  esac
fi

# ── Parse $DATABASE_URL ─────────────────────────────────────────────────
# Expected shape: postgres(ql)://[user[:pwd]@]host[:port]/dbname[?params]
# Split into base (everything up to and including the last '/' before the
# dbname) and the dbname (+ optional ?params) tail.
TEMP_DB="drift_check_$$_$(date +%s)"
if [[ "$DATABASE_URL" =~ ^(postgres(ql)?://[^/]+/)([^?]+)(\?.*)?$ ]]; then
  URL_BASE="${BASH_REMATCH[1]}"
  SOURCE_DB="${BASH_REMATCH[3]}"
  URL_TAIL="${BASH_REMATCH[4]}"
  TEMP_URL="${URL_BASE}${TEMP_DB}${URL_TAIL}"
else
  echo "ERROR: could not parse \$DATABASE_URL (expected postgres://.../dbname)." >&2
  exit 2
fi

# ── Cleanup trap ────────────────────────────────────────────────────────
LOG="$(mktemp -t db-drift-check.XXXXXX.log)"
CLEAN="$(mktemp -t db-drift-check.XXXXXX.txt)"
DUMP="$(mktemp -t db-drift-check.XXXXXX.sql)"
cleanup() {
  # DROP throwaway DB unconditionally. -q so a missing DB doesn't spam.
  psql "$DATABASE_URL" -v ON_ERROR_STOP=0 -q \
    -c "DROP DATABASE IF EXISTS \"$TEMP_DB\";" >/dev/null 2>&1 || true
  rm -f "$LOG" "$CLEAN" "$DUMP"
}
trap cleanup EXIT INT TERM

# ── 1. Snapshot live schema ─────────────────────────────────────────────
if ! pg_dump --schema-only --no-owner --no-acl --no-comments \
       "$DATABASE_URL" > "$DUMP" 2>/dev/null; then
  echo "ERROR: pg_dump failed against \$DATABASE_URL." >&2
  exit 2
fi

# ── 2. Build throwaway DB and restore the snapshot ──────────────────────
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q \
  -c "CREATE DATABASE \"$TEMP_DB\";" >/dev/null 2>&1 || {
    echo "ERROR: could not CREATE DATABASE $TEMP_DB (need CREATEDB)." >&2
    exit 2
  }

# Drop scorer_credentials before restore so drizzle does not later prompt
# to rename it (matches scripts/post-merge.sh).
sed -i '/CREATE TABLE.*scorer_credentials/,/^);/d' "$DUMP"

if ! psql "$TEMP_URL" -v ON_ERROR_STOP=0 -q -f "$DUMP" >/dev/null 2>&1; then
  # Some restore warnings are expected (search_path, extension owners).
  # Only fail if the restore left the temp DB empty.
  TABLES="$(psql "$TEMP_URL" -At -c \
    "SELECT count(*) FROM information_schema.tables WHERE table_schema='public';" 2>/dev/null || echo 0)"
  if [ "${TABLES:-0}" -lt 10 ]; then
    echo "ERROR: failed to restore schema snapshot into $TEMP_DB." >&2
    exit 2
  fi
fi

# ── 3. Run drizzle-kit push against the throwaway DB ────────────────────
# drizzle-kit's `prompts` library reads /dev/tty, so we drive it through
# a PTY (`script -qfc`). With --force no prompts should fire on a clean
# run; the streaming newlines accept any safe defaults if they do.
(
  for _ in $(seq 1 120); do printf '\n'; sleep 0.25; done
) | DATABASE_URL="$TEMP_URL" script -qfc \
      "cd \"$REPO_ROOT/lib/db\" && pnpm exec drizzle-kit push --force --verbose --config ./drizzle.config.ts" \
      "$LOG" >/dev/null 2>&1 || true

# Strip ANSI escapes & convert CR→LF so grep sees clean text.
sed 's/\x1b\[[0-9;]*[a-zA-Z]//g; s/\r/\n/g' "$LOG" > "$CLEAN"

# ── 4. Inspect output ───────────────────────────────────────────────────
if grep -qiE 'No changes detected' "$CLEAN"; then
  echo "✓ DB schema matches lib/db/src/schema/golf.ts (no drift)."
  exit 0
fi

# Any DDL drizzle would apply is real drift. Long FK names that PostgreSQL
# used to truncate are given explicit short names in the schema so they no
# longer re-emit. We still filter `ALTER COLUMN ... SET DEFAULT` because
# drizzle re-formats Postgres-stored defaults (e.g. `ARRAY['email']::text[]`
# vs `ARRAY['email'::text]`, jsonb pretty-printing) on every introspect even
# when the value is semantically identical, and there is no schema-level
# fix for that — see `sync-schema.ts` for the same exception.
ALL_DDL_LINES="$(grep -iE '^[[:space:]]*(CREATE TABLE|DROP TABLE|CREATE (UNIQUE )?INDEX|DROP INDEX|CREATE TYPE|DROP TYPE|ALTER TYPE|RENAME|ALTER TABLE)[[:space:]]' "$CLEAN" \
  | grep -v '^[[:space:]]*$' | head -100 || true)"
# Narrow filter: only suppress SET DEFAULT lines whose right-hand side
# matches a known re-formatting shape — jsonb object literal, ARRAY[...]
# literal, or text[]/array literal cast. Anything else (numeric, boolean,
# enum, timestamp, plain string) is still treated as real drift, so an
# intentional default change cannot slip through.
COSMETIC_DEFAULT_RE='ALTER COLUMN[[:space:]]+"[^"]+"[[:space:]]+SET DEFAULT[[:space:]]+(ARRAY\[[^]]*\]([[:space:]]*::[[:space:]]*[a-zA-Z_]+(\[\])?)?|'\''[^'\'']*'\''::(jsonb|text\[\]|[a-zA-Z_]+\[\]))[[:space:]]*;?[[:space:]]*$'
DDL_LINES="$(echo "$ALL_DDL_LINES" \
  | grep -ivE "$COSMETIC_DEFAULT_RE" \
  | grep -v '^[[:space:]]*$' || true)"

# If the only DDL drizzle wanted to emit was cosmetic SET DEFAULT churn,
# treat the schema as clean. drizzle also prints "[✓] Changes applied"
# in that case, which we use as a corroborating signal that the run
# completed (vs stalling on a prompt).
if [ -z "$DDL_LINES" ] && [ -n "$ALL_DDL_LINES" ] \
   && grep -qE '\[.\] Changes applied' "$CLEAN"; then
  echo "✓ DB schema matches lib/db/src/schema/golf.ts" \
       "(only cosmetic SET DEFAULT re-formatting; ignored)."
  exit 0
fi

if [ -n "$DDL_LINES" ]; then
  cat >&2 <<EOF

==================================================================
✗ Database schema drift detected
==================================================================
The live DB does not match lib/db/src/schema/golf.ts. drizzle-kit
would have to run the following DDL to bring it back in sync:

$DDL_LINES

To resolve, follow the catch-up flow documented in:
  $DOCS_REF

In short:
  psql "\$DATABASE_URL" -c 'DROP TABLE IF EXISTS scorer_credentials CASCADE;'
  pnpm --filter @workspace/db push-force

Re-run this check after the catch-up to confirm a clean state.
==================================================================
EOF
  exit 1
fi

# Neither "No changes detected" nor a parseable DDL list → unsafe to call
# this clean. Most likely drizzle-kit stalled on a prompt it could not
# auto-answer (table rename, destructive truncate, etc.).
cat >&2 <<EOF

==================================================================
✗ Could not confirm DB schema is in sync
==================================================================
drizzle-kit push neither reported "No changes detected" nor a list
of DDL statements. This usually means it stalled on an interactive
prompt (table rename, destructive constraint, etc.).

Last 40 lines of the push output:

$(tail -40 "$CLEAN")

Follow the manual catch-up flow in $DOCS_REF and re-run this check.
==================================================================
EOF
exit 1
