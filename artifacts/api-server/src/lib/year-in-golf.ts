/**
 * Year in Golf — Spotify-Wrapped-style annual & quarterly recap.
 *
 * Aggregates per-player metrics across tournaments, general play rounds,
 * shots, achievements and handicap history for a single window.
 *
 * Pure aggregator; safe to call from a route handler or a cron job.
 */
import { db, scoresTable, playersTable, tournamentsTable, coursesTable, achievementsTable, handicapHistoryTable, shotsTable, generalPlayRoundsTable, generalPlayHoleScoresTable, holeDetailsTable, appUsersTable } from "@workspace/db";
import { and, asc, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";

export type RecapPeriod = "year" | "q1" | "q2" | "q3" | "q4";

export interface RecapWindow {
  year: number;
  period: RecapPeriod;
  startsAt: Date;
  endsAt: Date;
  label: string;
}

export interface YearInGolfRecap {
  user: { id: number; displayName: string | null };
  window: { year: number; period: RecapPeriod; label: string; startsAt: string; endsAt: string };
  totals: {
    rounds: number;
    holes: number;
    courses: number;
    partners: number;
    achievementsUnlocked: number;
  };
  bestRound: { gross: number; courseName: string | null; playedAt: string | null } | null;
  longestDrive: { distanceYards: number; club: string | null; courseName: string | null; recordedAt: string | null } | null;
  lowestHoleScore: { strokes: number; par: number | null; courseName: string | null; holeNumber: number; playedAt: string | null } | null;
  mostImproved: { metric: string; previousValue: number; currentValue: number; deltaLabel: string } | null;
  topCourses: { courseId: number; courseName: string; rounds: number }[];
  topPartners: { name: string; roundsTogether: number }[];
  achievements: { badgeType: string; badgeLabel: string; badgeIcon: string; earnedAt: string }[];
  handicapJourney: { startIndex: number | null; endIndex: number | null; deltaLabel: string; points: { recordedAt: string; index: number }[] };
}

export function buildRecapWindow(year: number, period: RecapPeriod): RecapWindow {
  const y = year;
  let startMonth = 0;
  let endMonth = 12;
  let label = `${y}`;
  if (period === "q1") { startMonth = 0; endMonth = 3; label = `Q1 ${y}`; }
  else if (period === "q2") { startMonth = 3; endMonth = 6; label = `Q2 ${y}`; }
  else if (period === "q3") { startMonth = 6; endMonth = 9; label = `Q3 ${y}`; }
  else if (period === "q4") { startMonth = 9; endMonth = 12; label = `Q4 ${y}`; }
  const startsAt = new Date(Date.UTC(y, startMonth, 1, 0, 0, 0));
  const endsAt = new Date(Date.UTC(y, endMonth, 1, 0, 0, 0));
  return { year: y, period, startsAt, endsAt, label };
}

export function parseRecapPeriod(value: unknown): RecapPeriod {
  if (value === "q1" || value === "q2" || value === "q3" || value === "q4") return value;
  return "year";
}

/** Compute the previous comparable window (previous year for "year", previous quarter for "qN"). */
function previousWindow(w: RecapWindow): RecapWindow {
  if (w.period === "year") return buildRecapWindow(w.year - 1, "year");
  const order: RecapPeriod[] = ["q1", "q2", "q3", "q4"];
  const idx = order.indexOf(w.period);
  if (idx <= 0) return buildRecapWindow(w.year - 1, "q4");
  return buildRecapWindow(w.year, order[idx - 1]);
}

interface RoundAgg {
  rounds: number;
  holes: number;
  courseIds: Set<number>;
  /** One entry per round (with non-null courseId) — used for accurate top-courses counts. */
  courseRounds: number[];
  girCount: number;
  girHoles: number;
  fairwayCount: number;
  fairwayHoles: number;
  puttsCount: number;
  puttsTotal: number;
}

function emptyAgg(): RoundAgg {
  return { rounds: 0, holes: 0, courseIds: new Set(), courseRounds: [], girCount: 0, girHoles: 0, fairwayCount: 0, fairwayHoles: 0, puttsCount: 0, puttsTotal: 0 };
}

async function aggregateGeneralPlay(userId: number, w: RecapWindow): Promise<{ agg: RoundAgg; bestRound: { gross: number; courseName: string | null; playedAt: string | null } | null; lowestHole: { strokes: number; par: number | null; courseName: string | null; holeNumber: number; playedAt: string | null } | null }> {
  const rounds = await db
    .select({ id: generalPlayRoundsTable.id, courseId: generalPlayRoundsTable.courseId, gross: generalPlayRoundsTable.grossScore, holes: generalPlayRoundsTable.holesPlayed, playedAt: generalPlayRoundsTable.playedAt })
    .from(generalPlayRoundsTable)
    .where(and(
      eq(generalPlayRoundsTable.userId, userId),
      gte(generalPlayRoundsTable.playedAt, w.startsAt),
      lte(generalPlayRoundsTable.playedAt, w.endsAt),
      sql`${generalPlayRoundsTable.status} IN ('confirmed','unverified','pending_marker')`,
    ));

  const agg = emptyAgg();
  agg.rounds = rounds.length;
  for (const r of rounds) {
    agg.holes += r.holes ?? 0;
    if (r.courseId) {
      agg.courseIds.add(r.courseId);
      agg.courseRounds.push(r.courseId);
    }
  }

  let bestRound: { gross: number; courseName: string | null; playedAt: string | null } | null = null;
  let bestId: number | null = null;
  for (const r of rounds) {
    if (r.gross != null && (bestRound == null || r.gross < bestRound.gross)) {
      bestRound = { gross: r.gross, courseName: null, playedAt: r.playedAt ? r.playedAt.toISOString() : null };
      bestId = r.id;
    }
  }
  if (bestId != null) {
    const [row] = await db.select({ name: coursesTable.name }).from(generalPlayRoundsTable).innerJoin(coursesTable, eq(coursesTable.id, generalPlayRoundsTable.courseId)).where(eq(generalPlayRoundsTable.id, bestId));
    if (row && bestRound) bestRound.courseName = row.name;
  }

  let lowestHole: { strokes: number; par: number | null; courseName: string | null; holeNumber: number; playedAt: string | null } | null = null;
  if (rounds.length > 0) {
    const ids = rounds.map(r => r.id);
    const holes = await db
      .select({ roundId: generalPlayHoleScoresTable.roundId, holeNumber: generalPlayHoleScoresTable.holeNumber, strokes: generalPlayHoleScoresTable.strokes, par: generalPlayHoleScoresTable.par })
      .from(generalPlayHoleScoresTable)
      .where(inArray(generalPlayHoleScoresTable.roundId, ids));
    let bestRelative = Infinity;
    for (const h of holes) {
      if (h.par == null) continue;
      const rel = h.strokes - h.par;
      if (rel < bestRelative) {
        bestRelative = rel;
        const r = rounds.find(x => x.id === h.roundId);
        lowestHole = {
          strokes: h.strokes,
          par: h.par,
          courseName: null,
          holeNumber: h.holeNumber,
          playedAt: r?.playedAt ? r.playedAt.toISOString() : null,
        };
      }
    }
  }

  return { agg, bestRound, lowestHole };
}

async function aggregateTournaments(userEmail: string | null, userId: number, w: RecapWindow): Promise<{ partners: number; rounds: number; holes: number; bestRound: { gross: number; courseName: string | null; playedAt: string | null } | null; lowestHole: { strokes: number; par: number | null; courseName: string | null; holeNumber: number; playedAt: string | null } | null; topPartners: { name: string; roundsTogether: number }[]; courseIds: Set<number>; courseRoundCounts: Map<number, number> }> {
  // Match tournament players strictly by stable userId; only include the
  // email predicate when we actually have a non-empty email. This prevents
  // null/empty emails from matching unrelated rows and contaminating recap
  // stats / leaking partner data across users.
  const trimmedEmail = (userEmail ?? "").trim().toLowerCase();
  const emailPredicate = trimmedEmail.length > 0
    ? sql`OR LOWER(${playersTable.email}) = ${trimmedEmail}`
    : sql``;
  const myPlayers = await db
    .select({ id: playersTable.id, tournamentId: playersTable.tournamentId })
    .from(playersTable)
    .where(sql`(${playersTable.userId} = ${userId} ${emailPredicate})`);

  if (myPlayers.length === 0) {
    return { partners: 0, rounds: 0, holes: 0, bestRound: null, lowestHole: null, topPartners: [], courseIds: new Set(), courseRoundCounts: new Map() };
  }

  const playerIds = myPlayers.map(p => p.id);
  const myTids = [...new Set(myPlayers.map(p => p.tournamentId))];

  // Tournaments inside the window
  const inWindowTournaments = await db
    .select({ id: tournamentsTable.id, courseId: tournamentsTable.courseId, startsAt: tournamentsTable.startDate })
    .from(tournamentsTable)
    .where(and(
      inArray(tournamentsTable.id, myTids),
      gte(tournamentsTable.startDate, w.startsAt),
      lte(tournamentsTable.startDate, w.endsAt),
    ));
  const tIds = inWindowTournaments.map(t => t.id);
  if (tIds.length === 0) {
    return { partners: 0, rounds: 0, holes: 0, bestRound: null, lowestHole: null, topPartners: [], courseIds: new Set(), courseRoundCounts: new Map() };
  }

  const courseIds = new Set<number>();
  const courseByTid = new Map<number, number>();
  for (const t of inWindowTournaments) if (t.courseId) {
    courseIds.add(t.courseId);
    courseByTid.set(t.id, t.courseId);
  }

  // Player rows in those tournaments (mine)
  const myPlayerInWindow = myPlayers.filter(p => tIds.includes(p.tournamentId));
  const myPlayerIds = myPlayerInWindow.map(p => p.id);

  // Per-hole score rows for this user across in-window tournaments
  const scoreRows = myPlayerIds.length === 0 ? [] : await db
    .select({ playerId: scoresTable.playerId, tournamentId: scoresTable.tournamentId, round: scoresTable.round, holeNumber: scoresTable.holeNumber, strokes: scoresTable.strokes })
    .from(scoresTable)
    .where(and(
      inArray(scoresTable.playerId, myPlayerIds),
      inArray(scoresTable.tournamentId, tIds),
    ));

  const roundMap = new Map<string, number>();
  for (const s of scoreRows) {
    const key = `${s.playerId}-${s.tournamentId}-${s.round}`;
    roundMap.set(key, (roundMap.get(key) ?? 0) + s.strokes);
  }
  const tournamentRounds = roundMap.size;
  const tournamentHoles = scoreRows.length;
  let best: { gross: number; courseName: string | null; playedAt: string | null } | null = null;
  let bestKey: string | null = null;
  for (const [key, gross] of roundMap) {
    if (best == null || gross < best.gross) { best = { gross, courseName: null, playedAt: null }; bestKey = key; }
  }
  if (bestKey && best) {
    const [, tidStr] = bestKey.split("-");
    const tid = Number(tidStr);
    const t = inWindowTournaments.find(x => x.id === tid);
    if (t) {
      best.playedAt = t.startsAt ? t.startsAt.toISOString() : null;
      if (t.courseId) {
        const [row] = await db.select({ name: coursesTable.name }).from(coursesTable).where(eq(coursesTable.id, t.courseId));
        best.courseName = row?.name ?? null;
      }
    }
  }

  // Playing partners — other players who shared a tournament round with us
  const partnerMap = new Map<string, number>();
  if (tIds.length > 0) {
    const partners = await db
      .select({ tournamentId: playersTable.tournamentId, firstName: playersTable.firstName, lastName: playersTable.lastName, id: playersTable.id })
      .from(playersTable)
      .where(and(
        inArray(playersTable.tournamentId, tIds),
        sql`${playersTable.id} <> ALL(ARRAY[${sql.join((playerIds.length ? playerIds : [-1]).map((id) => sql`${id}`), sql`, `)}]::int[])`,
      ));
    for (const p of partners) {
      const name = `${p.firstName ?? ""} ${p.lastName ?? ""}`.trim() || "Player";
      partnerMap.set(name, (partnerMap.get(name) ?? 0) + 1);
    }
  }
  const topPartners = [...partnerMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, roundsTogether]) => ({ name, roundsTogether }));

  // Per-tournament-round course counts (each scored round on a course = 1)
  const courseRoundCounts = new Map<number, number>();
  for (const key of roundMap.keys()) {
    const tid = Number(key.split("-")[1]);
    const cid = courseByTid.get(tid);
    if (cid != null) courseRoundCounts.set(cid, (courseRoundCounts.get(cid) ?? 0) + 1);
  }

  // Lowest single hole across the user's tournament holes (look up par from
  // hole_details for the tournament's course when available).
  let lowestHole: { strokes: number; par: number | null; courseName: string | null; holeNumber: number; playedAt: string | null } | null = null;
  if (scoreRows.length > 0) {
    let minRow = scoreRows[0];
    for (const s of scoreRows) if (s.strokes < minRow.strokes) minRow = s;
    const t = inWindowTournaments.find(x => x.id === minRow.tournamentId) ?? null;
    const cid = t?.courseId ?? null;
    let par: number | null = null;
    let courseName: string | null = null;
    if (cid != null) {
      const [hd] = await db
        .select({ par: holeDetailsTable.par, name: coursesTable.name })
        .from(holeDetailsTable)
        .innerJoin(coursesTable, eq(coursesTable.id, holeDetailsTable.courseId))
        .where(and(eq(holeDetailsTable.courseId, cid), eq(holeDetailsTable.holeNumber, minRow.holeNumber)));
      par = hd?.par ?? null;
      courseName = hd?.name ?? null;
      if (courseName == null) {
        const [c] = await db.select({ name: coursesTable.name }).from(coursesTable).where(eq(coursesTable.id, cid));
        courseName = c?.name ?? null;
      }
    }
    lowestHole = {
      strokes: minRow.strokes,
      par,
      courseName,
      holeNumber: minRow.holeNumber,
      playedAt: t?.startsAt ? t.startsAt.toISOString() : null,
    };
  }

  return {
    partners: partnerMap.size,
    rounds: tournamentRounds,
    holes: tournamentHoles,
    bestRound: best,
    lowestHole,
    topPartners,
    courseIds,
    courseRoundCounts,
  };
}

async function longestDriveInWindow(userId: number, w: RecapWindow): Promise<{ distanceYards: number; club: string | null; courseName: string | null; recordedAt: string | null } | null> {
  const rows = await db
    .select({ distance: shotsTable.distanceCarried, club: shotsTable.club, recordedAt: shotsTable.recordedAt, gpId: shotsTable.generalPlayRoundId })
    .from(shotsTable)
    .where(and(
      eq(shotsTable.userId, userId),
      gte(shotsTable.recordedAt, w.startsAt),
      lte(shotsTable.recordedAt, w.endsAt),
      sql`${shotsTable.distanceCarried} IS NOT NULL`,
    ))
    .orderBy(desc(shotsTable.distanceCarried))
    .limit(1);
  const r = rows[0];
  if (!r || r.distance == null) return null;
  let courseName: string | null = null;
  if (r.gpId != null) {
    const [c] = await db.select({ name: coursesTable.name }).from(generalPlayRoundsTable).innerJoin(coursesTable, eq(coursesTable.id, generalPlayRoundsTable.courseId)).where(eq(generalPlayRoundsTable.id, r.gpId));
    courseName = c?.name ?? null;
  }
  return {
    distanceYards: Math.round(Number(r.distance)),
    club: r.club ?? null,
    courseName,
    recordedAt: r.recordedAt ? r.recordedAt.toISOString() : null,
  };
}

async function handicapJourney(userId: number, w: RecapWindow): Promise<YearInGolfRecap["handicapJourney"]> {
  const points = await db
    .select({ index: handicapHistoryTable.handicapIndex, recordedAt: handicapHistoryTable.recordedAt })
    .from(handicapHistoryTable)
    .where(and(
      eq(handicapHistoryTable.userId, userId),
      gte(handicapHistoryTable.recordedAt, w.startsAt),
      lte(handicapHistoryTable.recordedAt, w.endsAt),
    ))
    .orderBy(asc(handicapHistoryTable.recordedAt));
  const series = points
    .filter(p => p.recordedAt != null)
    .map(p => ({ recordedAt: p.recordedAt!.toISOString(), index: Number(p.index) }));
  const startIndex = series.length > 0 ? series[0].index : null;
  const endIndex = series.length > 0 ? series[series.length - 1].index : null;
  const delta = startIndex != null && endIndex != null ? Math.round((endIndex - startIndex) * 10) / 10 : null;
  const deltaLabel = delta == null ? "" : delta === 0 ? "Steady" : delta < 0 ? `▼ ${Math.abs(delta).toFixed(1)} (improved)` : `▲ ${delta.toFixed(1)}`;
  return { startIndex, endIndex, deltaLabel, points: series };
}

async function unlockedAchievements(userId: number, w: RecapWindow): Promise<YearInGolfRecap["achievements"]> {
  const rows = await db
    .select({ badgeType: achievementsTable.badgeType, badgeLabel: achievementsTable.badgeLabel, badgeIcon: achievementsTable.badgeIcon, earnedAt: achievementsTable.earnedAt })
    .from(achievementsTable)
    .where(and(
      eq(achievementsTable.userId, userId),
      gte(achievementsTable.earnedAt, w.startsAt),
      lte(achievementsTable.earnedAt, w.endsAt),
    ))
    .orderBy(desc(achievementsTable.earnedAt));
  return rows.map(r => ({ badgeType: r.badgeType, badgeLabel: r.badgeLabel, badgeIcon: r.badgeIcon, earnedAt: r.earnedAt!.toISOString() }));
}

async function mostImprovedStat(userId: number, current: RecapWindow): Promise<YearInGolfRecap["mostImproved"]> {
  const previous = previousWindow(current);
  const [{ gp: cur }, { gp: prev }] = await Promise.all([
    aggregateGeneralPlay(userId, current).then(r => ({ gp: r })),
    aggregateGeneralPlay(userId, previous).then(r => ({ gp: r })),
  ]);
  if (cur.bestRound == null || prev.bestRound == null) return null;
  const delta = prev.bestRound.gross - cur.bestRound.gross;
  if (delta <= 0) return null;
  return {
    metric: "Best gross score",
    previousValue: prev.bestRound.gross,
    currentValue: cur.bestRound.gross,
    deltaLabel: `▼ ${delta} strokes vs. ${previous.label}`,
  };
}

export async function computeYearInGolf(userId: number, year: number, period: RecapPeriod): Promise<YearInGolfRecap> {
  const w = buildRecapWindow(year, period);

  const [user] = await db.select({ id: appUsersTable.id, displayName: appUsersTable.displayName, email: appUsersTable.email }).from(appUsersTable).where(eq(appUsersTable.id, userId));
  const userEmail = user?.email ?? null;

  const [gp, tour, drive, journey, achv, improved] = await Promise.all([
    aggregateGeneralPlay(userId, w),
    aggregateTournaments(userEmail, userId, w),
    longestDriveInWindow(userId, w),
    handicapJourney(userId, w),
    unlockedAchievements(userId, w),
    mostImprovedStat(userId, w),
  ]);

  const courseIds = new Set<number>([...gp.agg.courseIds, ...tour.courseIds]);
  const topCourses: { courseId: number; courseName: string; rounds: number }[] = [];
  if (courseIds.size > 0) {
    const courses = await db.select({ id: coursesTable.id, name: coursesTable.name }).from(coursesTable).where(inArray(coursesTable.id, [...courseIds]));
    const nameById = new Map(courses.map(c => [c.id, c.name]));
    // Per-round course counts: general play counts each round on its course,
    // tournament play counts each scored round on its tournament's course.
    const counts = new Map<number, number>();
    for (const id of gp.agg.courseRounds) counts.set(id, (counts.get(id) ?? 0) + 1);
    for (const [cid, n] of tour.courseRoundCounts) counts.set(cid, (counts.get(cid) ?? 0) + n);
    for (const [courseId, rounds] of counts) {
      topCourses.push({ courseId, courseName: nameById.get(courseId) ?? `Course ${courseId}`, rounds });
    }
    topCourses.sort((a, b) => b.rounds - a.rounds);
  }

  // Pick the better of GP best round vs tournament best round
  let bestRound = gp.bestRound;
  if (tour.bestRound && (bestRound == null || tour.bestRound.gross < bestRound.gross)) {
    bestRound = tour.bestRound;
  }

  // Pick the lowest single hole across both general play and tournament play.
  let lowestHoleScore = gp.lowestHole;
  if (tour.lowestHole && (lowestHoleScore == null || tour.lowestHole.strokes < lowestHoleScore.strokes)) {
    lowestHoleScore = tour.lowestHole;
  }

  return {
    user: { id: userId, displayName: user?.displayName ?? null },
    window: { year: w.year, period: w.period, label: w.label, startsAt: w.startsAt.toISOString(), endsAt: w.endsAt.toISOString() },
    totals: {
      rounds: gp.agg.rounds + tour.rounds,
      holes: gp.agg.holes + tour.holes,
      courses: courseIds.size,
      partners: tour.partners,
      achievementsUnlocked: achv.length,
    },
    bestRound,
    longestDrive: drive,
    lowestHoleScore,
    mostImproved: improved,
    topCourses: topCourses.slice(0, 5),
    topPartners: tour.topPartners,
    achievements: achv.slice(0, 8),
    handicapJourney: journey,
  };
}

// Task #1503 — Short TTL cache of `computeYearInGolf` results keyed by
// (userId, year, period). The aggregation is identical across every
// chapter of a multi-chapter recap, so once a viewer has paged to
// chapter 0 the cache lets chapters 2..N skip the DB round-trip and
// only pay the cheap PNG render. Bots that retry the exact same
// (handle, year, period, chapter) URL still get the hit on the
// second-level PNG cache in `routes/public.ts`.
//
// In-flight promise map coalesces concurrent misses for the same key
// so even the first thundering herd of chapter requests only triggers
// one aggregation. Bounded by an LRU cap to keep memory predictable
// across many users.
type RecapCacheEntry = { recap: YearInGolfRecap; expiresAt: number };
const RECAP_CACHE_MAX = 256;
const RECAP_CACHE_TTL_MS = 60 * 1000;
// Task #1842 — entries written by the launch-cron's prime path get a much
// longer TTL than the 60s "multi-chapter dedup" window above. The cron is
// idempotent per (year, period) per process (see year-in-golf-cron.ts),
// so a primed entry only ever gets refreshed on process restart. The
// post-push tap spike, however, can stretch for tens of minutes as the
// notification fans out across providers and users actually look at
// their phones, so a 60s TTL would let the cache go cold before most of
// the launch recipients ever tap. 30 minutes is comfortably longer than
// that realistic spike window without keeping the (potentially stale,
// for late-arriving scores) recap pinned in memory all day.
const RECAP_PRIME_CACHE_TTL_MS = 30 * 60 * 1000;
const _recapCache = new Map<string, RecapCacheEntry>();
const _recapInflight = new Map<string, Promise<YearInGolfRecap>>();

function _recapCacheKey(userId: number, year: number, period: RecapPeriod): string {
  return `${userId}|${year}|${period}`;
}

function _recapCacheGet(key: string): YearInGolfRecap | undefined {
  const entry = _recapCache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    _recapCache.delete(key);
    return undefined;
  }
  // Refresh LRU recency.
  _recapCache.delete(key);
  _recapCache.set(key, entry);
  return entry.recap;
}

function _recapCacheSet(key: string, recap: YearInGolfRecap): void {
  _recapCache.set(key, { recap, expiresAt: Date.now() + RECAP_CACHE_TTL_MS });
  while (_recapCache.size > RECAP_CACHE_MAX) {
    const oldest = _recapCache.keys().next().value;
    if (oldest === undefined) break;
    _recapCache.delete(oldest);
  }
}

/**
 * Cached wrapper around {@link computeYearInGolf}. Reuses one aggregation
 * per (userId, year, period) within a 60s window; coalesces concurrent
 * misses for the same key into a single computation.
 *
 * Use this from request handlers that serve recap data (the public PNG
 * endpoint, the authenticated portal recap fetch, the portal card.png
 * and video.mp4 endpoints). Background cache-warmers that intentionally
 * want to bypass the in-memory cache should keep calling the underlying
 * `computeYearInGolf` directly.
 */
export async function getCachedYearInGolf(
  userId: number,
  year: number,
  period: RecapPeriod,
): Promise<YearInGolfRecap> {
  const key = _recapCacheKey(userId, year, period);
  const cached = _recapCacheGet(key);
  if (cached) return cached;
  const inflight = _recapInflight.get(key);
  if (inflight) return inflight;
  const p = (async () => {
    try {
      const recap = await computeYearInGolf(userId, year, period);
      _recapCacheSet(key, recap);
      return recap;
    } finally {
      _recapInflight.delete(key);
    }
  })();
  _recapInflight.set(key, p);
  return p;
}

/**
 * Task #1842 — Background warm-up entry point used by the launch cron's
 * `primeRecapAggregations`. Computes the recap and writes it into the
 * same in-memory cache that {@link getCachedYearInGolf} reads from, so
 * the very first user who taps the launch push notification skips the
 * aggregation entirely and lands straight on the cheap PNG render path.
 *
 * Uses {@link RECAP_PRIME_CACHE_TTL_MS} (30 minutes) instead of the
 * shorter request-handler TTL so the warmed entries survive the full
 * post-push tap spike. Also clears any stale in-flight promise for the
 * same key so a half-finished warm-up from a prior process doesn't
 * shadow the freshly computed value.
 *
 * Errors from the underlying aggregation propagate to the caller; the
 * cron logs and counts them per-user so a single bad row doesn't
 * abort the whole launch warm-up.
 */
export async function primeYearInGolfCache(
  userId: number,
  year: number,
  period: RecapPeriod,
): Promise<YearInGolfRecap> {
  const key = _recapCacheKey(userId, year, period);
  const recap = await computeYearInGolf(userId, year, period);
  _recapInflight.delete(key);
  _recapCache.delete(key);
  _recapCache.set(key, { recap, expiresAt: Date.now() + RECAP_PRIME_CACHE_TTL_MS });
  while (_recapCache.size > RECAP_CACHE_MAX) {
    const oldest = _recapCache.keys().next().value;
    if (oldest === undefined) break;
    _recapCache.delete(oldest);
  }
  return recap;
}
