#!/usr/bin/env bash
#
# squash-baseline.sh
#
# End-to-end regenerator for `lib/db/drizzle/0000_initial.sql`.
#
# Replaces the ad-hoc Task #1716 procedure (manual `pg_dump` + run a
# disposable `/tmp/squash_make_idempotent.py`) with a single committed
# command. The full runbook — when to squash, how to validate, how to
# regenerate `_journal.json`, and how the `__deploy_migrations` ledger
# stays compatible — lives in `docs/db-migration-squash.md`.
#
# What this script does:
#   1. Checks every numbered SQL file under <migrations-dir> (matching
#      `[0-9][0-9][0-9][0-9]_*.sql`) in sorted order is present.
#   2. Refuses to run unless the target DB (BUILD_DATABASE_URL) is
#      empty (`public` has zero relations) — the dump must reflect
#      ONLY what the migrations build, not whatever was already there.
#      Bypass with FORCE_NON_EMPTY=1 (e.g. you are pointing at a
#      throwaway DB you just truncated).
#   3. Applies every numbered file with `psql -v ON_ERROR_STOP=1`.
#      Order matches `scripts/post-merge.sh` so behaviour is identical.
#   4. Runs `pg_dump --schema-only --no-owner --no-privileges
#      --no-comments` against the target DB.
#   5. Pipes the dump through `squash-baseline-postprocess.py` to apply
#      the idempotency rules (see that script's header for the full
#      list).
#   6. Writes the result to <output-path> atomically (mktemp + mv).
#   7. Optional: with --validate, applies the produced baseline twice
#      against a SECOND empty DB (VALIDATE_DATABASE_URL) — the first
#      pass must succeed end-to-end with no errors, the second must
#      be a no-op (still ON_ERROR_STOP=1, so a missing IF NOT EXISTS
#      / DO-EXCEPTION wrapper would fail the run).
#
# Usage:
#   BUILD_DATABASE_URL=postgres://.../squash_build \
#   VALIDATE_DATABASE_URL=postgres://.../squash_verify \
#   lib/db/scripts/squash-baseline.sh \
#       --migrations lib/db/drizzle \
#       --output     lib/db/drizzle/0000_initial.sql \
#       --validate
#
# The two URLs MUST point at empty databases the operator created
# (e.g. `createdb squash_build`); see docs/db-migration-squash.md for
# the suggested local-Postgres + Replit-DB recipes.
#
# Exit codes:
#   0  baseline written (and validated, if --validate)
#   1  user error (missing flags, bad paths)
#   2  precondition failure (target DB not empty without override)
#   3  apply / dump / post-process / validation failure

set -euo pipefail

usage() {
  sed -n '2,/^$/p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

MIGRATIONS_DIR=""
OUTPUT_PATH=""
VALIDATE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --migrations) MIGRATIONS_DIR="$2"; shift 2 ;;
    --output)     OUTPUT_PATH="$2";    shift 2 ;;
    --validate)   VALIDATE=1;          shift 1 ;;
    -h|--help)    usage 0 ;;
    *) echo "ERROR: unknown argument: $1" >&2; usage 1 ;;
  esac
done

if [ -z "$MIGRATIONS_DIR" ] || [ -z "$OUTPUT_PATH" ]; then
  echo "ERROR: --migrations and --output are required." >&2
  usage 1
fi
if [ ! -d "$MIGRATIONS_DIR" ]; then
  echo "ERROR: migrations dir not found: $MIGRATIONS_DIR" >&2
  exit 1
fi
if [ -z "${BUILD_DATABASE_URL:-}" ]; then
  echo "ERROR: BUILD_DATABASE_URL is not set (must point at an EMPTY DB)." >&2
  exit 1
fi
if [ "$VALIDATE" = "1" ] && [ -z "${VALIDATE_DATABASE_URL:-}" ]; then
  echo "ERROR: --validate requires VALIDATE_DATABASE_URL (a SECOND empty DB)." >&2
  exit 1
fi
if ! command -v psql >/dev/null 2>&1; then
  echo "ERROR: psql is not on PATH." >&2
  exit 1
fi
if ! command -v pg_dump >/dev/null 2>&1; then
  echo "ERROR: pg_dump is not on PATH." >&2
  exit 1
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "ERROR: python3 is not on PATH." >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
POSTPROCESS="$(cd "$(dirname "$0")" && pwd)/squash-baseline-postprocess.py"
if [ ! -f "$POSTPROCESS" ]; then
  echo "ERROR: post-processor not found: $POSTPROCESS" >&2
  exit 1
fi

# --- Collect & sort migration files ---------------------------------------
shopt -s nullglob
files=( "$MIGRATIONS_DIR"/[0-9][0-9][0-9][0-9]_*.sql )
shopt -u nullglob
if [ "${#files[@]}" -eq 0 ]; then
  echo "ERROR: no numbered migrations found under $MIGRATIONS_DIR" >&2
  exit 1
fi
IFS=$'\n' sorted=( $(printf '%s\n' "${files[@]}" | sort) )
unset IFS

echo "▶ squash-baseline: found ${#sorted[@]} numbered migration file(s)."

# --- Verify target DB is empty (gate) -------------------------------------
relcount="$(psql "$BUILD_DATABASE_URL" -v ON_ERROR_STOP=1 -X -q -t -A -c "
  SELECT count(*) FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind IN ('r','S','v','m','i','p','c');
")"
relcount="${relcount//[[:space:]]/}"
if [ "$relcount" != "0" ]; then
  if [ "${FORCE_NON_EMPTY:-0}" != "1" ]; then
    echo "" >&2
    echo "ERROR: BUILD_DATABASE_URL has $relcount existing relation(s) in 'public'." >&2
    echo "       The dump must reflect ONLY what the migrations build, so the" >&2
    echo "       target must start empty." >&2
    echo "" >&2
    echo "       Provide a fresh DB (e.g. 'createdb squash_build'), or set" >&2
    echo "       FORCE_NON_EMPTY=1 if you have just truncated/dropped the schema" >&2
    echo "       yourself and accept the risk of stale objects leaking into the" >&2
    echo "       baseline." >&2
    exit 2
  fi
  echo "▶ squash-baseline: FORCE_NON_EMPTY=1 — proceeding despite $relcount existing relation(s)."
fi

# --- Apply migrations -----------------------------------------------------
echo "▶ squash-baseline: applying ${#sorted[@]} migration(s) to BUILD_DATABASE_URL..."
# Pre-initialize the temp-file vars so the trap below is safe under
# `set -u` even when an early exit (e.g. apply failure) fires before
# the dump/post-process steps populate DUMP_FILE / TMP_OUT.
APPLY_LOG="$(mktemp -t squash-baseline.apply.XXXXXX.log)"
DUMP_FILE=""
TMP_OUT=""
trap 'rm -f "$APPLY_LOG" "$DUMP_FILE" "$TMP_OUT" 2>/dev/null || true' EXIT INT TERM

for f in "${sorted[@]}"; do
  printf '  applying %s\n' "$(basename "$f")"
  if ! PGOPTIONS='-c client_min_messages=warning' \
       psql "$BUILD_DATABASE_URL" -v ON_ERROR_STOP=1 -X -q -f "$f" \
       > "$APPLY_LOG" 2>&1; then
    echo "" >&2
    echo "ERROR: migration failed: $(basename "$f")" >&2
    echo "psql output:" >&2
    sed 's/^/  /' "$APPLY_LOG" >&2
    exit 3
  fi
done

# --- Dump + post-process --------------------------------------------------
DUMP_FILE="$(mktemp -t squash-baseline.dump.XXXXXX.sql)"
TMP_OUT="$(mktemp -t squash-baseline.out.XXXXXX.sql)"

echo "▶ squash-baseline: pg_dump --schema-only..."
if ! pg_dump --schema-only --no-owner --no-privileges --no-comments \
             "$BUILD_DATABASE_URL" > "$DUMP_FILE" 2> "$APPLY_LOG"; then
  echo "ERROR: pg_dump failed:" >&2
  sed 's/^/  /' "$APPLY_LOG" >&2
  exit 3
fi

echo "▶ squash-baseline: post-processing for idempotency..."
if ! python3 "$POSTPROCESS" < "$DUMP_FILE" > "$TMP_OUT" 2> "$APPLY_LOG"; then
  echo "ERROR: post-processor failed:" >&2
  sed 's/^/  /' "$APPLY_LOG" >&2
  exit 3
fi

# Atomic write so a partial baseline can never persist on disk.
mkdir -p "$(dirname "$OUTPUT_PATH")"
mv "$TMP_OUT" "$OUTPUT_PATH"
echo "✓ squash-baseline: wrote $OUTPUT_PATH ($(wc -l < "$OUTPUT_PATH" | tr -d ' ') lines)."

# --- Validation pass (optional) -------------------------------------------
if [ "$VALIDATE" = "1" ]; then
  echo "▶ squash-baseline: validating against VALIDATE_DATABASE_URL (must be empty)..."
  vrelcount="$(psql "$VALIDATE_DATABASE_URL" -v ON_ERROR_STOP=1 -X -q -t -A -c "
    SELECT count(*) FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r','S','v','m','i','p','c');
  ")"
  vrelcount="${vrelcount//[[:space:]]/}"
  if [ "$vrelcount" != "0" ]; then
    echo "ERROR: VALIDATE_DATABASE_URL is not empty ($vrelcount relation(s))." >&2
    exit 3
  fi

  echo "  ▸ pass 1 (fresh apply): must succeed end-to-end..."
  if ! PGOPTIONS='-c client_min_messages=warning' \
       psql "$VALIDATE_DATABASE_URL" -v ON_ERROR_STOP=1 -X -q \
            -f "$OUTPUT_PATH" > "$APPLY_LOG" 2>&1; then
    echo "ERROR: baseline failed to apply on a fresh DB:" >&2
    sed 's/^/  /' "$APPLY_LOG" >&2
    exit 3
  fi

  echo "  ▸ pass 2 (re-apply): must be a no-op..."
  if ! PGOPTIONS='-c client_min_messages=warning' \
       psql "$VALIDATE_DATABASE_URL" -v ON_ERROR_STOP=1 -X -q \
            -f "$OUTPUT_PATH" > "$APPLY_LOG" 2>&1; then
    echo "ERROR: baseline is NOT idempotent — second apply errored:" >&2
    sed 's/^/  /' "$APPLY_LOG" >&2
    exit 3
  fi

  # Diff the post-baseline schema against what the migrations would
  # have produced. They MUST match exactly — that's the whole point.
  echo "  ▸ pg_dump diff (BUILD vs VALIDATE) must be empty..."
  build_schema="$(mktemp -t squash-baseline.build.XXXXXX.sql)"
  validate_schema="$(mktemp -t squash-baseline.validate.XXXXXX.sql)"
  # Strip pg_dump 16.x's per-session `\restrict <random-token>` /
  # `\unrestrict <random-token>` directives — they are session-local
  # nonces (different on every pg_dump invocation) and would always
  # show up as a spurious diff. The post-processor drops them from the
  # baseline anyway.
  pg_dump --schema-only --no-owner --no-privileges --no-comments \
          "$BUILD_DATABASE_URL" \
    | grep -Ev '^\\(restrict|unrestrict)\b' > "$build_schema"
  pg_dump --schema-only --no-owner --no-privileges --no-comments \
          "$VALIDATE_DATABASE_URL" \
    | grep -Ev '^\\(restrict|unrestrict)\b' > "$validate_schema"
  if ! diff -u "$build_schema" "$validate_schema" > "$APPLY_LOG"; then
    echo "ERROR: schema diff is NOT empty — baseline drifts from migrations:" >&2
    sed 's/^/  /' "$APPLY_LOG" >&2
    rm -f "$build_schema" "$validate_schema"
    exit 3
  fi
  rm -f "$build_schema" "$validate_schema"
  echo "✓ squash-baseline: validation passed."
fi

echo "✓ squash-baseline: done."
