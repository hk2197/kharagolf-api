#!/bin/bash
#
# Pre-deploy: run safe, idempotent one-shot data backfills against the
# production $DATABASE_URL after migrations are applied.
#
# Why this exists (Task #1731):
#   Several `backfill:*` scripts in artifacts/api-server/package.json
#   exist to surface historical data that newer code paths only started
#   writing from a particular task onward (e.g. backfill:social-links
#   from Task #1431). Until Task #1731 they relied on an operator
#   remembering to run each one by hand in every environment after the
#   feature deploy. Wiring the safe ones into the prebuild chain
#   guarantees they run automatically and the historical data shows up
#   without manual intervention.
#
# Idempotency requirement:
#   A backfill is only added to AUTOMATIC_BACKFILLS below if it is safe
#   to re-run on every deploy — i.e. it uses `ON CONFLICT DO NOTHING`
#   (or equivalent) and is a no-op once everything has been backfilled.
#   Backfills that are NOT safe to re-run (e.g. ones with side effects
#   or counter resets) must keep being run by hand from the runbook in
#   replit.md / scripts/post-merge.sh.
#
# Where it runs:
#   From `artifacts/api-server`'s `prebuild` script, AFTER
#   `apply-prod-migrations.sh` and `predeploy-db-drift.sh` so the
#   schema is guaranteed to be up-to-date AND matches the code before
#   we touch any rows.
#
# When it runs:
#   Replit production deploys set NODE_ENV=production in
#   `[services.production.build.env]`, so this script triggers
#   automatically during a publish. Local `pnpm run build` and dev
#   rebuilds (NODE_ENV=development) are no-ops so the inner loop stays
#   fast. We deliberately do NOT auto-trigger on CI=true — CI test
#   runs already operate against an unrelated test DATABASE_URL and
#   must not have prod backfills replayed against it. Set
#   FORCE_PROD_BACKFILLS=1 to override the gate (e.g. to dry-run the
#   chain locally against a staging DATABASE_URL).
#
# Skip with SKIP_PROD_BACKFILLS=1 (e.g. emergency rollback deploy that
# is known not to need any data work done).
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

if is_truthy "${SKIP_PROD_BACKFILLS:-}"; then
  echo "SKIP_PROD_BACKFILLS set → skipping production backfills."
  exit 0
fi

if [ "${NODE_ENV:-}" != "production" ] \
     && ! is_truthy "${FORCE_PROD_BACKFILLS:-}"; then
  echo "run-prod-backfills: NODE_ENV=${NODE_ENV:-unset} → skipping" \
       "(not a production deploy; set FORCE_PROD_BACKFILLS=1 to override)."
  exit 0
fi

if [ -z "${DATABASE_URL:-}" ]; then
  echo "ERROR: DATABASE_URL is not set; cannot run production backfills." >&2
  echo "       Set DATABASE_URL (or SKIP_PROD_BACKFILLS=1 to bypass)." >&2
  exit 2
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# ---------------------------------------------------------------------------
# AUTOMATIC_BACKFILLS — pnpm script names under @workspace/api-server.
#
# Add a new entry here ONLY if the underlying script is safe to re-run
# on every deploy (see "Idempotency requirement" above). Keep a brief
# comment per entry pointing back to the originating task so future
# operators understand what each one does without reading the script.
# ---------------------------------------------------------------------------
AUTOMATIC_BACKFILLS=(
  # Task #1731 / originated by Task #1431 — surfaces existing
  # Apple/Google links in the portal Privacy screen for players who
  # signed in before Task #1225 introduced `app_user_social_links`.
  # Idempotent via `ON CONFLICT DO NOTHING`.
  "backfill:social-links"
)

echo "▶ run-prod-backfills: ${#AUTOMATIC_BACKFILLS[@]} backfill script(s) to run."

for script in "${AUTOMATIC_BACKFILLS[@]}"; do
  echo "  • pnpm --filter @workspace/api-server $script"
  ( cd "$REPO_ROOT" && pnpm --filter @workspace/api-server run "$script" )
done

echo "✓ run-prod-backfills: completed ${#AUTOMATIC_BACKFILLS[@]} backfill(s)" \
     "(against \$DATABASE_URL)."
