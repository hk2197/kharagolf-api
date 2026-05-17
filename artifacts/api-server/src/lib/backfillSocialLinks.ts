/**
 * Task #1431 — Implementation of the social-link backfill, kept here in
 * `src/lib/` (rather than inside `scripts/`) so vitest and any future
 * scheduled-deploy hook can import it without violating the api-server
 * tsconfig `rootDir`. The CLI entry point that the
 * `backfill:social-links` package script runs lives at
 * `scripts/backfillSocialLinks.ts` and is now a thin wrapper around
 * `runBackfill()` below.
 *
 * See the script wrapper for the full rationale; in short, this walks
 * `app_users` rows whose `replit_user_id` matches the
 * `apple_<sub>` / `google_<sub>` placeholder format produced by
 * `providerLocalId(...)` in routes/social-auth.ts and inserts the
 * corresponding `(user_id, provider, provider_sub)` row into
 * `app_user_social_links`. The insert uses `ON CONFLICT DO NOTHING`,
 * so re-running is safe.
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

export interface BackfillSocialLinksResult {
  candidates: number;
  inserted: number;
  skipped: number;
}

/**
 * Run one pass of the backfill. Returns counts so callers (CLI, tests,
 * future post-deploy hook) can log or assert on them.
 */
export async function runBackfill(): Promise<BackfillSocialLinksResult> {
  // Note: we use literal `left(...)` prefix matching rather than `LIKE
  // 'apple_%'` because `_` is a single-char wildcard in LIKE — `'apple_%'`
  // would also match e.g. `'applex_…'`. `left()` matches the underscore
  // literally, which is what `providerLocalId(...)` actually writes.
  const candidates = await db.execute(sql`
    SELECT COUNT(*)::int AS count
    FROM app_users
    WHERE left(replit_user_id, 6) = 'apple_'
       OR left(replit_user_id, 7) = 'google_'
  `);
  const candidateCount =
    (candidates.rows?.[0] as { count?: number } | undefined)?.count ?? 0;

  const result = await db.execute(sql`
    INSERT INTO app_user_social_links (user_id, provider, provider_sub)
    SELECT
      u.id,
      CASE
        WHEN left(u.replit_user_id, 6) = 'apple_' THEN 'apple'::social_auth_provider
        ELSE 'google'::social_auth_provider
      END,
      CASE
        WHEN left(u.replit_user_id, 6) = 'apple_'  THEN substr(u.replit_user_id, 7)
        WHEN left(u.replit_user_id, 7) = 'google_' THEN substr(u.replit_user_id, 8)
      END
    FROM app_users u
    WHERE (left(u.replit_user_id, 6) = 'apple_' OR left(u.replit_user_id, 7) = 'google_')
      AND u.erased_at IS NULL
    ON CONFLICT DO NOTHING
  `);

  const inserted = (result as { rowCount?: number | null }).rowCount ?? 0;
  const skipped = Math.max(0, candidateCount - inserted);

  return { candidates: candidateCount, inserted, skipped };
}
