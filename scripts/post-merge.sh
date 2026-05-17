#!/bin/bash
set -e

# Free memory before pnpm install: kill any in-flight background schema sync
# from a previous (pre-fast-path) post-merge. We no longer launch background
# syncs ourselves, but a stacked sync left over from an older script revision
# can still OOM-kill pnpm install (SIGABRT).
LOCK=/tmp/post-merge-schema-sync.lock
LEGACY_SYNC_STATUS=/tmp/post-merge-schema-sync.status
LEGACY_SYNC_LOG=/tmp/post-merge-schema-sync.log
if [ -f "$LOCK" ]; then
  PREV_PID="$(cat "$LOCK" 2>/dev/null || true)"
  if [ -n "$PREV_PID" ] && kill -0 "$PREV_PID" 2>/dev/null; then
    echo "Killing in-flight schema sync (pid $PREV_PID) to free memory before install."
    kill -9 "$PREV_PID" 2>/dev/null || true
    pkill -9 -P "$PREV_PID" 2>/dev/null || true
  fi
  rm -f "$LOCK"
fi
# Belt-and-braces: also reap any orphan drizzle-kit / sync-schema processes
# from prior runs that may have detached from the lockfile owner.
pkill -9 -f 'drizzle-kit push' 2>/dev/null || true
pkill -9 -f 'sync-schema.ts'    2>/dev/null || true
# Clear legacy state files left by the old background-sync flow so they
# don't gate this run. The new flow runs the sync inline (foreground) and
# fails the post-merge directly on a destructive diff, so a leftover
# `$LEGACY_SYNC_STATUS` from a previous container is no longer meaningful.
rm -f "$LEGACY_SYNC_STATUS" "$LEGACY_SYNC_LOG" \
      /tmp/post-merge-drizzle-push.lock 2>/dev/null || true

# Helper: append a markdown block to the CI step summary if the host CI
# exposes one (GitHub Actions sets GITHUB_STEP_SUMMARY; other systems can
# point POST_MERGE_SUMMARY_FILE at any file we should append to). No-op
# locally, so this is safe to call unconditionally.
emit_ci_summary() {
  local body="$1"
  local target="${POST_MERGE_SUMMARY_FILE:-${GITHUB_STEP_SUMMARY:-}}"
  if [ -n "$target" ]; then
    printf '%s\n' "$body" >> "$target" 2>/dev/null || true
  fi
}

# Lockfile-hash short-circuit: if pnpm-lock.yaml is byte-identical to the
# last successful run AND node_modules/.modules.yaml exists (proof that
# `pnpm install` actually ran on this container at least once), skip the
# install entirely. On this container `pnpm install --frozen-lockfile` has
# been observed to take 2-4 minutes even on a no-op walk, which exceeds
# the post-merge platform timeout. The schema-files-hash short-circuit
# further down uses the same pattern; we just hoist the same idea earlier
# in the script. Set POST_MERGE_FORCE_INSTALL=1 to bypass.
mkdir -p lib/db/.sync-cache 2>/dev/null || true
LOCK_HASH_FILE=lib/db/.sync-cache/last-pnpm-lock-hash
LOCK_HASH=""
if [ -f pnpm-lock.yaml ]; then
  LOCK_HASH="$(sha256sum pnpm-lock.yaml 2>/dev/null | awk '{print $1}')"
fi
LAST_LOCK_HASH=""
if [ -f "$LOCK_HASH_FILE" ]; then
  LAST_LOCK_HASH="$(cat "$LOCK_HASH_FILE" 2>/dev/null || true)"
fi
if [ -n "$LOCK_HASH" ] && [ "$LOCK_HASH" = "$LAST_LOCK_HASH" ] \
     && [ -f node_modules/.modules.yaml ] \
     && [ "${POST_MERGE_FORCE_INSTALL:-0}" != "1" ]; then
  echo "Lockfile unchanged since last successful install (hash $LOCK_HASH); skipping pnpm install."
else
  pnpm install --frozen-lockfile
  if [ -n "$LOCK_HASH" ]; then
    echo "$LOCK_HASH" > "$LOCK_HASH_FILE"
  fi
fi

# Apply migrations directly using psql. Each migration file is idempotent
# (uses IF NOT EXISTS, DO blocks for enums, etc.).
MIGRATIONS_DIR="lib/db/drizzle"

# Migrations-hash short-circuit: if every numbered migration file under
# $MIGRATIONS_DIR is byte-identical (name AND contents) to the set we
# successfully applied last time on this container, skip the replay loop
# entirely. The loop spawns one psql per file, and each connection costs
# ~1-2 s on this container — at 130+ files that's 200-300 s of pure no-op
# work on every merge, which has already pushed two post-merge runs past
# the platform timeout (Tasks #1695, #1696, #1702). Migrations are
# strictly append-only and idempotent (IF NOT EXISTS / DO blocks), so a
# matching hash means there is nothing new to apply. Bypass with
# POST_MERGE_FORCE_MIGRATE=1. Same cache directory as the lockfile and
# schema hashes above.
MIG_HASH_FILE=lib/db/.sync-cache/last-migrations-hash
MIG_HASH=""
if ls "$MIGRATIONS_DIR"/[0-9][0-9][0-9][0-9]_*.sql >/dev/null 2>&1; then
  MIG_HASH="$(find "$MIGRATIONS_DIR" -maxdepth 1 -type f -name '[0-9][0-9][0-9][0-9]_*.sql' \
    | sort | xargs sha256sum 2>/dev/null | sha256sum | awk '{print $1}')"
fi
LAST_MIG_HASH=""
if [ -f "$MIG_HASH_FILE" ]; then
  LAST_MIG_HASH="$(cat "$MIG_HASH_FILE" 2>/dev/null || true)"
fi
if [ -n "$MIG_HASH" ] && [ "$MIG_HASH" = "$LAST_MIG_HASH" ] \
     && [ "${POST_MERGE_FORCE_MIGRATE:-0}" != "1" ]; then
  echo "Migration set unchanged since last successful apply (hash $MIG_HASH); skipping psql replay loop."
else
  # Apply every numbered SQL file (sorted by leading number, then name).
  #
  # We run with `ON_ERROR_STOP=1` (strict) and treat any per-file error
  # as a hard failure: every numbered migration is either fully
  # idempotent (IF NOT EXISTS / DO blocks with EXCEPTION handlers) or
  # explicitly guarded (`\if :post_merge_dep_present`) so it no-ops
  # cleanly on a fresh DB when its parent table/type/column hasn't been
  # created yet (the 0114-0118 catch-up migrations fill those in).
  #
  # `client_min_messages=warning` suppresses the chatty "NOTICE:
  # relation X already exists, skipping" stream from idempotent
  # re-runs so the only stderr we ever see in this loop is a real
  # ERROR — and a real ERROR will now exit non-zero.
  for f in $(ls "$MIGRATIONS_DIR"/[0-9][0-9][0-9][0-9]_*.sql 2>/dev/null | sort); do
    echo "Applying $f ..."
    PGOPTIONS='-c client_min_messages=warning' \
      psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f "$f"
  done
  if [ -n "$MIG_HASH" ]; then
    echo "$MIG_HASH" > "$MIG_HASH_FILE"
  fi
fi


# Catch the test DB up to the latest Drizzle schema. This closes any drift
# between the migration files above and `lib/db/src/schema/golf.ts` (newly
# added tables/columns that don't yet have a numbered migration).
#
# We use a fully programmatic, non-interactive sync (`pnpm --filter
# @workspace/db sync`) which calls drizzle-kit's `pushSchema` API on a
# cold cache and then a plain JSON snapshot diff (`generateMigration`) on
# every subsequent run. It refuses to apply destructive or ambiguous
# changes (DROP, RENAME, etc.) unless ALLOW_SCHEMA_DATA_LOSS=1 is set, so
# any new prompt-worthy diff surfaces as a loud failure (non-zero exit)
# right here in the foreground — not in a background log.
# See `docs/db-test-sync.md` for the manual flow.

# Drop the legacy `scorer_credentials` table (last referenced in migration
# 0000) so the diff doesn't include a rename-vs-drop against
# `affiliate_codes`. This is preserved from the legacy flow because the
# table predates the schema source-of-truth.
psql "$DATABASE_URL" -v ON_ERROR_STOP=0 \
  -c 'DROP TABLE IF EXISTS scorer_credentials CASCADE;' 2>&1 || true

# Schema-hash short-circuit: if every file under lib/db/src/schema/ is
# byte-identical to the last successful sync's snapshot, the schema files
# haven't changed since we last converged the DB and we can skip even
# starting the sync. Set POST_MERGE_FORCE_SYNC=1 to bypass.
# Persist the schema-files hash INSIDE the repo (committed) so fresh
# containers can short-circuit the sync when nothing changed since the
# last successful run. The previous /tmp default was wiped on every cold
# container, defeating the short-circuit and forcing a full slow-path
# introspect (5+ min) on every CI / task-agent run.
mkdir -p lib/db/.sync-cache 2>/dev/null || true
SCHEMA_HASH_FILE=lib/db/.sync-cache/last-schema-files-hash
SCHEMA_HASH="$(find lib/db/src/schema -type f -name '*.ts' \
  | sort | xargs sha256sum 2>/dev/null | sha256sum | awk '{print $1}')"
LAST_HASH=""
if [ -f "$SCHEMA_HASH_FILE" ]; then
  LAST_HASH="$(cat "$SCHEMA_HASH_FILE" 2>/dev/null || true)"
fi

# Compute the migrations-list guard hash exactly the way
# `lib/db/scripts/check-drift-fast.ts` does (sha256 of sorted numbered
# migration filenames joined with '\n', no trailing newline). The fast
# pre-test drift check rejects its cached snapshot when this hash does
# not match the file at `lib/db/.sync-cache/snapshot.guard`, so when a
# branch lands a new numbered migration the next `apply-test-schema.sh`
# pays the ~90 s slow path. We use this hash below to either trigger a
# full sync or, when the schema files are byte-identical, simply refresh
# the guard so the snapshot stays valid.
SNAPSHOT_FILE=lib/db/.sync-cache/snapshot.json
SNAPSHOT_GUARD_FILE=lib/db/.sync-cache/snapshot.guard
MIG_NAMES="$(ls "$MIGRATIONS_DIR" 2>/dev/null \
  | grep -E '^[0-9]{4}_.*\.sql$' | sort)"
CURRENT_MIG_GUARD=""
if [ -n "$MIG_NAMES" ]; then
  CURRENT_MIG_GUARD="$(printf '%s' "$MIG_NAMES" | sha256sum | awk '{print $1}')"
fi
CACHED_MIG_GUARD=""
if [ -f "$SNAPSHOT_GUARD_FILE" ]; then
  CACHED_MIG_GUARD="$(tr -d '[:space:]' < "$SNAPSHOT_GUARD_FILE" 2>/dev/null || true)"
fi

if [ -n "$SCHEMA_HASH" ] && [ "$SCHEMA_HASH" = "$LAST_HASH" ] \
     && [ "${POST_MERGE_FORCE_SYNC:-0}" != "1" ]; then
  echo "Schema unchanged since last successful sync (hash $SCHEMA_HASH); skipping."
  # Warm the fast pre-test drift cache. If new numbered migrations
  # landed on this branch the snapshot.guard is now stale and the next
  # `apply-test-schema.sh` would fall through to the slow ~90 s
  # introspect path. The schema-files hash matched above, so the
  # existing snapshot.json is still byte-identical to what
  # `pnpm --filter @workspace/db sync` would produce — only the guard
  # needs refreshing. Opt out with POST_MERGE_SKIP_CACHE_WARM=1 (CI
  # runners that prefer the current behaviour can set this).
  if [ "${POST_MERGE_SKIP_CACHE_WARM:-0}" != "1" ] \
       && [ -f "$SNAPSHOT_FILE" ] \
       && [ -n "$CURRENT_MIG_GUARD" ] \
       && [ "$CURRENT_MIG_GUARD" != "$CACHED_MIG_GUARD" ]; then
    echo "Refreshing $SNAPSHOT_GUARD_FILE so the fast pre-test drift check stays warm."
    printf '%s' "$CURRENT_MIG_GUARD" > "$SNAPSHOT_GUARD_FILE"
  fi
  echo "Post-merge setup complete."
  exit 0
fi

# If new numbered SQL migration(s) landed since the last snapshot was
# written, the cached snapshot may pre-date columns/tables those
# migrations just applied to the live DB. The fast diff path would then
# re-emit those ADD COLUMN / CREATE TABLE statements and fail with
# "already exists". Invalidate the snapshot in that case so sync falls
# back to the slower but accurate live-DB introspect path.
if [ -n "$CURRENT_MIG_GUARD" ] \
     && [ "$CURRENT_MIG_GUARD" != "$CACHED_MIG_GUARD" ] \
     && [ -f "$SNAPSHOT_FILE" ]; then
  echo "New numbered migration(s) detected since last snapshot; invalidating snapshot cache so sync re-introspects the live DB."
  rm -f "$SNAPSHOT_FILE" "$SNAPSHOT_GUARD_FILE" 2>/dev/null || true
fi

# Run the schema sync in the FOREGROUND. The sync uses a snapshot cache
# (see lib/db/scripts/sync-schema.ts) so the typical run is a fast JSON
# diff (~2 s on the current schema). The slow `pushSchema` introspect
# path only triggers on a cold cache or after a new numbered migration
# lands, both of which are rare. Running inline means a destructive or
# ambiguous diff fails THIS post-merge run instead of being buried in a
# background log.
echo "Catching DB up to latest Drizzle schema (programmatic sync) ..."
SYNC_LOG=/tmp/post-merge-schema-sync.log
SYNC_EXIT=0
set +e
pnpm --filter @workspace/db sync 2>&1 | tee "$SYNC_LOG"
SYNC_EXIT=${PIPESTATUS[0]}
set -e
if [ "$SYNC_EXIT" != "0" ]; then
  echo "Post-merge FAILED: schema sync exited $SYNC_EXIT (see diff above)."
  echo "Resolve the diff (add a numbered SQL migration in lib/db/drizzle/,"
  echo "or set ALLOW_SCHEMA_DATA_LOSS=1 after review) and re-run."
  # Snapshot the failing log so a subsequent run that overwrites $SYNC_LOG
  # can't erase the diagnostic context. Keep the latest failure at the
  # stable `.failed` path AND a timestamped copy so back-to-back failures
  # don't clobber earlier diagnostics.
  if [ -f "$SYNC_LOG" ]; then
    cp -f "$SYNC_LOG" "${SYNC_LOG}.failed" 2>/dev/null || true
    cp -f "$SYNC_LOG" "${SYNC_LOG}.failed.$(date -u +%Y%m%dT%H%M%SZ)" 2>/dev/null || true
  fi
  # Surface in the CI summary too, so the failure is visible from the
  # CI run page without having to scroll the raw log.
  emit_ci_summary "## ❌ Schema sync failed (foreground)"
  emit_ci_summary ""
  emit_ci_summary "\`pnpm --filter @workspace/db sync\` exited \`$SYNC_EXIT\`."
  emit_ci_summary ""
  emit_ci_summary "<details><summary>Tail of \`$SYNC_LOG\`</summary>"
  emit_ci_summary ""
  emit_ci_summary '```'
  emit_ci_summary "$(tail -n 200 "$SYNC_LOG" 2>/dev/null)"
  emit_ci_summary '```'
  emit_ci_summary ""
  emit_ci_summary "</details>"
  exit "$SYNC_EXIT"
fi

# Record the schema-files hash so the next post-merge with the same
# schema short-circuits the whole sync above.
echo "$SCHEMA_HASH" > "$SCHEMA_HASH_FILE"

# ── Ops runbook: one-shot backfills ─────────────────────────────────────────
# The scripts below are NOT auto-run by post-merge (they touch historical
# rows and should be invoked deliberately, once per environment, after
# the corresponding feature deploys). Listed here so operators have a
# single place to discover them.
#
#   pnpm --filter @workspace/api-server backfill:manual-entry-alert-recipients
#     Task #1672 — reconstructs best-effort `manual_entry_alert_recipients`
#     rows for manual-entry alerts that fired before Task #1386 landed
#     the per-recipient audit table, so the super-admin "silent
#     recipients" drill-down stops showing the empty-state hint on
#     historical alerts. Idempotent (re-runs are no-ops). Run once per
#     environment after Task #1386 + Task #1672 deploy.
#
#   pnpm --filter @workspace/api-server backfill:coach-payout-change-audit
#     Task #1702 — synthesises the missing per-channel
#     `notification_audit_log` rows under
#     `coach.payout.account.changed.coach` for every
#     `coach_payout_account_history` row that pre-dates Task #1406's
#     coach-side audit writer. Email/push status is read from the
#     existing `coach_payout_account_change_notify_attempts` row when
#     present; otherwise (and always for the in-app leg) the row is
#     marked `status='unknown'` with `reason='backfilled_pre_audit'` so
#     synthesised rows are visibly distinct from real ones. Idempotent
#     (re-runs are no-ops). Run once per environment after Task #1406
#     + Task #1702 deploy.
# ────────────────────────────────────────────────────────────────────────────

# Playwright browser cache. The e2e validation suites under
# `artifacts/api-server/e2e` and `artifacts/kharagolf-mobile/__e2e__`
# launch chromium-headless-shell from `~/.cache/ms-playwright`. Fresh
# containers start with an empty cache, so the first validator run after
# a merge can fail with `Executable doesn't exist at .../chrome-headless-shell`
# before any test executes — even though the application code is fine.
# Installing here makes the cache available before validation runs and
# is a no-op on subsequent merges (Playwright's installer skips browsers
# whose marker file is already present in the cache).
#
# Bypass with POST_MERGE_SKIP_PLAYWRIGHT_INSTALL=1 (e.g. when iterating
# locally and you don't need the e2e suites).
if [ "${POST_MERGE_SKIP_PLAYWRIGHT_INSTALL:-0}" != "1" ]; then
  # Mirror Playwright's own browsers-path resolution: explicit
  # PLAYWRIGHT_BROWSERS_PATH wins, otherwise XDG_CACHE_HOME (which this
  # container sets to /home/runner/workspace/.cache so the cache
  # survives across sessions), otherwise the standard ~/.cache fallback.
  if [ -n "${PLAYWRIGHT_BROWSERS_PATH:-}" ]; then
    PLAYWRIGHT_CACHE="$PLAYWRIGHT_BROWSERS_PATH"
  else
    PLAYWRIGHT_CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/ms-playwright"
  fi
  if ls "$PLAYWRIGHT_CACHE"/chromium_headless_shell-* >/dev/null 2>&1; then
    echo "Playwright chromium-headless-shell already cached at $PLAYWRIGHT_CACHE; skipping install."
  else
    echo "Installing Playwright chromium browser into $PLAYWRIGHT_CACHE ..."
    # `--filter` is required because @playwright/test isn't a root
    # workspace dep — it's pinned inside the artifact packages that
    # actually run e2e suites. Either filter resolves the same binary
    # since the lockfile pins one version (`^1.59.1`); kharagolf-mobile
    # is alphabetically first and always present.
    pnpm --filter @workspace/kharagolf-mobile exec playwright install chromium \
      || echo "WARN: Playwright chromium install failed; e2e suites may be skipped this run."
  fi
fi

echo "Post-merge setup complete."
