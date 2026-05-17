#!/bin/bash
#
# Pre-deploy gate: runs scripts/check-db-drift.sh only for builds that
# are about to ship (Replit production deploys set NODE_ENV=production
# in [services.production.build.env]; CI sets CI=true). All other
# invocations — local `pnpm run build`, dev rebuilds, watch mode — skip
# the check so the inner loop stays fast.
#
# Why scoped to deploy/CI: the drift check takes ~60–120 s because
# drizzle-kit re-introspects the entire schema. Running it on every dev
# build would be punishing; running it before every deploy catches
# `lib/db/src/schema/golf.ts` drifting away from $DATABASE_URL the
# moment a deploy is attempted.
#
# Skip with SKIP_DEPLOY_DB_DRIFT=1 (e.g. emergency rollback deploy
# where you have already confirmed the schema is fine).
#
# Exit codes: 0 = clean / skipped, non-zero = drift or misconfig
# (propagated from check-db-drift.sh, which prints a pointer to
# docs/db-test-sync.md).

set -euo pipefail

is_truthy() {
  case "${1:-}" in
    1|true|TRUE|True|yes|YES) return 0 ;;
    *) return 1 ;;
  esac
}

if is_truthy "${SKIP_DEPLOY_DB_DRIFT:-}"; then
  echo "SKIP_DEPLOY_DB_DRIFT set → skipping pre-deploy drift check."
  exit 0
fi

if [ "${NODE_ENV:-}" != "production" ] && ! is_truthy "${CI:-}"; then
  echo "predeploy-db-drift: NODE_ENV=${NODE_ENV:-unset}, CI=${CI:-unset} → skipping (not a deploy/CI build)."
  exit 0
fi

if [ -z "${DATABASE_URL:-}" ]; then
  echo "ERROR: DATABASE_URL is not set; cannot run the pre-deploy drift check." >&2
  echo "       Set DATABASE_URL (or SKIP_DEPLOY_DB_DRIFT=1 to bypass) and re-run." >&2
  echo "       See docs/db-test-sync.md." >&2
  exit 2
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
echo "▶ Pre-deploy drift check: lib/db/src/schema/ vs \$DATABASE_URL ..."
bash "$REPO_ROOT/scripts/check-db-drift.sh"
echo "✓ Pre-deploy drift check passed."
