/**
 * Task #1962 — One-shot legacy video duration backfill, callable from the
 * super-admin dashboard.
 *
 * Background. Tasks #1323 and #1574 made the highlight editor's trim
 * window depend on `media.duration_seconds`: rows with NULL there silently
 * lose the slider on the editor side, and the server strips any window
 * the client tries to send for them. Every video uploaded after Task #703
 * (server-side ffprobe on upload) gets `duration_seconds` populated, but
 * the rows that pre-date that change are stuck without trim until a probe
 * fills the column in. The CLI script `scripts/backfillMediaDurations.ts`
 * exists, but it has to be run by hand from the shell — there's no way
 * for a producer looking at the admin dashboard to kick it off.
 *
 * This module is the shared engine the super-admin endpoint calls. It
 * sweeps a capped batch of legacy video rows (across ALL orgs — the
 * problem is platform-wide) and:
 *
 *   - probe succeeds → writes `duration_seconds` so the trim slider
 *                      reappears for that clip.
 *   - probe fails    → stamps `duration_last_checked_at` so the row
 *                      drops out of the candidate set on subsequent
 *                      sweeps. We do NOT keep retrying forever — the
 *                      task explicitly calls out that legacy videos
 *                      whose object is missing or whose container is
 *                      malformed should fall out of scope after one
 *                      attempt so admins can spot them via the existing
 *                      `unverifiable-videos` page (Task #993) and
 *                      decide whether to delete or re-upload.
 *
 * The candidate query intentionally uses `duration_last_checked_at IS
 * NULL` rather than the org-scoped `recheck-all-durations` filter
 * (`duration_unverifiable_reason IS NOT NULL`). The org-scoped flow
 * targets rows the background cron has already given up on and lets
 * admins try one more time. This sweep is the *first* pass for legacy
 * rows that the cron and the upload path never saw — they have no
 * "unverifiable reason" because nobody ever measured them.
 *
 * Capped at LEGACY_BACKFILL_BATCH_SIZE per call so a runaway backlog
 * can't pin the API server inside one HTTP request (each probe
 * downloads the object and ffprobes it). The endpoint surfaces
 * `remaining` so the dashboard can render "X legacy videos still
 * un-measured — click again" until the queue drains.
 */
import { db, mediaTable } from "@workspace/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import { ObjectNotFoundError } from "./objectStorage";
import { probeMediaDurationSeconds } from "./mediaDurationProbe";

export const LEGACY_BACKFILL_BATCH_SIZE = 50;

export interface LegacyVideoBackfillResult {
  attempted: number;
  recovered: number;
  stillFailing: number;
  objectMissing: number;
  remaining: number;
  batchSize: number;
}

/**
 * Number of legacy video rows that have never been measured AND never
 * been attempted. Powers the "X legacy videos still un-measured" tile
 * on the super-admin dashboard so producers can watch the backlog
 * shrink as they re-run the sweep.
 *
 * Rows whose probe already failed (`duration_last_checked_at` stamped)
 * are intentionally excluded — they're "un-measurable", not "un-tried",
 * and the producer can act on them via the per-org unverifiable-videos
 * page.
 */
export async function countUnmeasuredLegacyVideos(): Promise<number> {
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(mediaTable)
    .where(and(
      eq(mediaTable.mediaType, "video"),
      isNull(mediaTable.durationSeconds),
      isNull(mediaTable.durationLastCheckedAt),
    ));
  return Number(n) || 0;
}

/**
 * Probe a single legacy row, mirroring the per-row recheck endpoint's
 * outcome handling. Either we recover the duration (and the row drops
 * out of the candidate set on its own) or we stamp the attempt
 * timestamp so it's excluded from future sweeps.
 *
 * Exposed only so the test suite can reason about a single row in
 * isolation; production callers should use `runLegacyVideoBackfillBatch`.
 */
export async function probeAndPersistLegacyRow(rowId: number): Promise<
  | { kind: "recovered"; durationSeconds: number }
  | { kind: "still_failing" }
  | { kind: "object_missing" }
> {
  const [row] = await db
    .select({ id: mediaTable.id, objectPath: mediaTable.objectPath })
    .from(mediaTable)
    .where(eq(mediaTable.id, rowId))
    .limit(1);
  if (!row) return { kind: "still_failing" };

  try {
    const durationSeconds = await probeMediaDurationSeconds(row.objectPath);
    if (durationSeconds === null) {
      // Probe couldn't determine a duration (timeout, no video stream,
      // malformed container). Stamp so the row drops out of the
      // candidate set — repeated sweeps shouldn't keep grinding on
      // rows that have already proven unverifiable.
      await db.update(mediaTable)
        .set({ durationLastCheckedAt: new Date() })
        .where(eq(mediaTable.id, rowId));
      return { kind: "still_failing" };
    }
    // Recovered. Clear the attempt stamp (it's NULL by definition of
    // the candidate set, but be explicit so the row's state is
    // unambiguous afterwards).
    await db.update(mediaTable)
      .set({
        durationSeconds,
        durationLastCheckedAt: null,
      })
      .where(eq(mediaTable.id, rowId));
    return { kind: "recovered", durationSeconds };
  } catch (err) {
    // Stamp regardless of failure mode so we don't keep retrying. A
    // missing object is reported separately so the dashboard can flag
    // "N rows whose underlying file is gone — go delete them" without
    // the producer having to dig through logs.
    await db.update(mediaTable)
      .set({ durationLastCheckedAt: new Date() })
      .where(eq(mediaTable.id, rowId));
    if (err instanceof ObjectNotFoundError) {
      return { kind: "object_missing" };
    }
    return { kind: "still_failing" };
  }
}

/**
 * Run one batch of the legacy-video duration sweep. Picks up to
 * `LEGACY_BACKFILL_BATCH_SIZE` rows that have never been measured and
 * never been attempted, probes each, and persists the outcome. Returns
 * aggregate counts plus how many rows are still in the queue afterwards
 * so the caller can render a "click again to keep going" CTA when the
 * backlog is larger than one batch.
 */
export async function runLegacyVideoBackfillBatch(): Promise<LegacyVideoBackfillResult> {
  const candidates = await db
    .select({ id: mediaTable.id })
    .from(mediaTable)
    .where(and(
      eq(mediaTable.mediaType, "video"),
      isNull(mediaTable.durationSeconds),
      isNull(mediaTable.durationLastCheckedAt),
    ))
    .orderBy(mediaTable.id)
    .limit(LEGACY_BACKFILL_BATCH_SIZE);

  let recovered = 0;
  let stillFailing = 0;
  let objectMissing = 0;
  for (const row of candidates) {
    const r = await probeAndPersistLegacyRow(row.id);
    if (r.kind === "recovered") recovered++;
    else if (r.kind === "object_missing") { stillFailing++; objectMissing++; }
    else stillFailing++;
  }

  const remaining = await countUnmeasuredLegacyVideos();
  return {
    attempted: candidates.length,
    recovered,
    stillFailing,
    objectMissing,
    remaining,
    batchSize: LEGACY_BACKFILL_BATCH_SIZE,
  };
}
