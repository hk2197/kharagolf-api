/**
 * Recompute cross-club ladder standings.
 *
 * Extracted from routes/cross-club-ladders.ts so that auto-feed hooks (in
 * general-play and tournament completion code) can re-trigger the same
 * standings update used by the manual results endpoint.
 */

import { db } from "@workspace/db";
import {
  crossClubLaddersTable,
  crossClubLadderEntriesTable,
  crossClubLadderResultsTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";

export async function recomputeStandings(ladderId: number): Promise<void> {
  const [ladder] = await db.select().from(crossClubLaddersTable).where(eq(crossClubLaddersTable.id, ladderId));
  if (!ladder) return;

  const entries = await db
    .select()
    .from(crossClubLadderEntriesTable)
    .where(eq(crossClubLadderEntriesTable.ladderId, ladderId));

  const results = await db
    .select()
    .from(crossClubLadderResultsTable)
    .where(eq(crossClubLadderResultsTable.ladderId, ladderId));

  const byEntry = new Map<number, typeof results>();
  for (const r of results) {
    const arr = byEntry.get(r.entryId) ?? [];
    arr.push(r);
    byEntry.set(r.entryId, arr);
  }

  for (const e of entries) {
    const list = (byEntry.get(e.id) ?? []).slice();
    list.sort((a, b) => b.pointsAwarded - a.pointsAwarded);
    const limit = ladder.bestOfRounds ?? list.length;
    const counted = list.slice(0, limit);
    const uncountedIds = list.slice(limit).map(r => r.id);
    const countedIds = counted.map(r => r.id);
    const total = counted.reduce((s, r) => s + r.pointsAwarded, 0);

    if (countedIds.length > 0) {
      await db.update(crossClubLadderResultsTable)
        .set({ countedTowardTotal: true })
        .where(inArray(crossClubLadderResultsTable.id, countedIds));
    }
    if (uncountedIds.length > 0) {
      await db.update(crossClubLadderResultsTable)
        .set({ countedTowardTotal: false })
        .where(inArray(crossClubLadderResultsTable.id, uncountedIds));
    }

    await db.update(crossClubLadderEntriesTable)
      .set({
        previousPosition: e.position,
        totalPoints: total,
        roundsCounted: counted.length,
        updatedAt: new Date(),
      })
      .where(eq(crossClubLadderEntriesTable.id, e.id));
  }

  const fresh = await db
    .select()
    .from(crossClubLadderEntriesTable)
    .where(eq(crossClubLadderEntriesTable.ladderId, ladderId));
  const byDiv = new Map<number, typeof fresh>();
  for (const e of fresh) {
    const arr = byDiv.get(e.division) ?? [];
    arr.push(e);
    byDiv.set(e.division, arr);
  }
  for (const [, list] of byDiv) {
    list.sort((a, b) => b.totalPoints - a.totalPoints);
    let pos = 1;
    for (const e of list) {
      await db.update(crossClubLadderEntriesTable)
        .set({ position: pos++ })
        .where(eq(crossClubLadderEntriesTable.id, e.id));
    }
  }
}
