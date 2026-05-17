/**
 * Wave 1 W1-D — Auto-club inference for tap-to-drop shot tagging.
 *
 * Given a player's history and a target distance (yards) we suggest
 * the most likely club for the shot. Strategy:
 *   1. Pull the player's past shots within ±15y of the target distance.
 *   2. Count clubs; pick the most-used.
 *   3. Confidence = (top count / total candidate shots), bounded 0-1.
 *   4. Fallback to a static distance table when the player has < 3 shots
 *      in that bucket. We never refuse to suggest — UI decides whether
 *      to actually apply the suggestion.
 */

import { db, shotsTable } from "@workspace/db";
import { and, eq, isNotNull, sql } from "drizzle-orm";

export type ClubSuggestionSource = "history" | "static_table";

export interface ClubSuggestion {
  club: string;
  confidence: number; // 0..1
  source: ClubSuggestionSource;
  sampleSize: number;
}

const STATIC_TABLE: ReadonlyArray<{ club: string; min: number; max: number }> = [
  { club: "driver", min: 230, max: 320 },
  { club: "3-wood", min: 200, max: 250 },
  { club: "5-wood", min: 180, max: 220 },
  { club: "3-hybrid", min: 170, max: 210 },
  { club: "4-iron", min: 160, max: 200 },
  { club: "5-iron", min: 150, max: 185 },
  { club: "6-iron", min: 140, max: 175 },
  { club: "7-iron", min: 130, max: 165 },
  { club: "8-iron", min: 120, max: 155 },
  { club: "9-iron", min: 105, max: 140 },
  { club: "pw",     min:  90, max: 125 },
  { club: "gw",     min:  75, max: 110 },
  { club: "sw",     min:  55, max:  95 },
  { club: "lw",     min:  35, max:  75 },
];

function staticFallback(distance: number): ClubSuggestion {
  let best = STATIC_TABLE[0];
  let bestScore = Infinity;
  for (const row of STATIC_TABLE) {
    const mid = (row.min + row.max) / 2;
    const score = Math.abs(distance - mid);
    if (score < bestScore) { bestScore = score; best = row; }
  }
  return { club: best.club, confidence: 0.4, source: "static_table", sampleSize: 0 };
}

export async function inferClub({
  userId,
  distanceYards,
  toleranceYards = 15,
}: {
  userId: number;
  distanceYards: number;
  toleranceYards?: number;
}): Promise<ClubSuggestion> {
  if (!Number.isFinite(distanceYards) || distanceYards <= 0) {
    return staticFallback(150);
  }
  const lo = distanceYards - toleranceYards;
  const hi = distanceYards + toleranceYards;

  const rows = await db
    .select({
      club: shotsTable.club,
      n: sql<number>`count(*)::int`.as("n"),
    })
    .from(shotsTable)
    .where(and(
      eq(shotsTable.userId, userId),
      isNotNull(shotsTable.club),
      sql`${shotsTable.distanceCarried} BETWEEN ${lo} AND ${hi}`,
    ))
    .groupBy(shotsTable.club);

  const total = rows.reduce((s, r) => s + r.n, 0);
  if (total < 3) return staticFallback(distanceYards);

  rows.sort((a, b) => b.n - a.n);
  const top = rows[0];
  if (!top.club) return staticFallback(distanceYards);

  return {
    club: top.club,
    confidence: Math.round((top.n / total) * 100) / 100,
    source: "history",
    sampleSize: total,
  };
}
