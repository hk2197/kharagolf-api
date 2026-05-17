#!/bin/bash
#
# Pre-test step: apply the latest Drizzle schema to the test database,
# then verify there is no remaining drift before vitest runs.
#
# Why: artifacts/api-server's integration tests under src/tests/ assume the
# live test DB has every table/column declared in lib/db/src/schema/. When
# the test DB falls behind (e.g. new tables like member_levies / member_levy
# _charges land in the schema but are never pushed), suites silently fail
# at the first SELECT. This script closes that gap so contributors do not
# have to remember to run `pnpm --filter @workspace/db push` by hand.
#
# Steps:
#   1. Run `pnpm --filter @workspace/db sync` (non-interactive pushSchema).
#      The sync refuses destructive/ambiguous diffs unless
#      ALLOW_SCHEMA_DATA_LOSS=1 is set, so prompt-worthy changes surface
#      as a loud failure instead of being silently mis-answered.
#   2. Run `scripts/check-db-drift.sh` as a paranoia check that the live
#      DB now matches `lib/db/src/schema/*` (catches partial-apply races).
#
# Skip with SKIP_PRETEST_DB_SYNC=1 (e.g. when iterating on a single test
# locally and you are sure the schema is already in sync).
#
# Exit codes: 0 = ready, non-zero = sync or drift error.

set -euo pipefail

if [ "${SKIP_PRETEST_DB_SYNC:-0}" = "1" ]; then
  echo "SKIP_PRETEST_DB_SYNC=1 → skipping schema sync + drift check."
  exit 0
fi

if [ -z "${DATABASE_URL:-}" ]; then
  echo "ERROR: DATABASE_URL is not set; cannot sync the test schema." >&2
  echo "       Provision a database (see docs/db-test-sync.md) and re-run." >&2
  exit 2
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "▶ Applying latest Drizzle schema to the test DB (pnpm --filter @workspace/db sync) ..."
(
  cd "$REPO_ROOT"
  pnpm --filter @workspace/db sync
)

echo "▶ Verifying the test DB now matches lib/db/src/schema/ (drift check) ..."
bash "$REPO_ROOT/scripts/check-db-drift.sh"

echo "✓ Test database is in sync with lib/db/src/schema/."
