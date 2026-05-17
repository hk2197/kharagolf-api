/**
 * Offline support for the AI Caddie (Task #356).
 *
 * - Stores a per-round model snapshot (club stats, miss bias, handicap,
 *   acceptance history) in AsyncStorage so we can compute on-device
 *   recommendations when the network is unreachable.
 * - Persists feedback events that fail to POST and replays them when
 *   connectivity returns.
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
import { fetchPortal, postPortal } from "@/utils/api";

export interface ClubStat {
  club: string;
  avgCarry: number;
  stddevCarry: number;
  shotCount: number;
  source: "shots" | "manual" | "fallback";
}

export interface CaddieSnapshot {
  generatedAt: string;
  handicap: number | null;
  missBiasLateralYards: number;
  clubStats: ClubStat[];
  acceptanceByClub: Record<string, number>;
  /**
   * Per-(lie, club) acceptance rates mirroring the live recommend endpoint.
   * Outer key is the normalised lie label (e.g. "fairway", "rough", "bunker");
   * inner key is the club name. Older snapshots may omit this field, so it is
   * optional and treated as empty when absent.
   */
  acceptanceByLie?: Record<string, Record<string, number>>;
}

export interface QueuedFeedback {
  recommendationId: number;
  chosenClub: string;
  accepted: boolean;
  outcomeStrokes?: number;
  outcomeDistanceToPin?: number;
  queuedAt: number;
}

const SNAPSHOT_PREFIX = "kharagolf_caddie_model_v1:";
const FEEDBACK_QUEUE_KEY = "kharagolf_caddie_feedback_queue_v1";

function snapshotKey(tournamentId: number | null, generalPlayRoundId: number | null, round: number) {
  const ctx = tournamentId ? `t${tournamentId}` : generalPlayRoundId ? `g${generalPlayRoundId}` : "x";
  return `${SNAPSHOT_PREFIX}${ctx}/r${round}`;
}

/** Fetch the player's caddie model snapshot and cache it for offline use. */
export async function prefetchSnapshot(
  token: string,
  tournamentId: number | null,
  generalPlayRoundId: number | null,
  round: number,
): Promise<CaddieSnapshot | null> {
  try {
    const data = await fetchPortal<CaddieSnapshot>("/caddie/snapshot", token);
    await AsyncStorage.setItem(snapshotKey(tournamentId, generalPlayRoundId, round), JSON.stringify(data));
    return data;
  } catch {
    return loadSnapshot(tournamentId, generalPlayRoundId, round);
  }
}

export async function loadSnapshot(
  tournamentId: number | null,
  generalPlayRoundId: number | null,
  round: number,
): Promise<CaddieSnapshot | null> {
  try {
    const raw = await AsyncStorage.getItem(snapshotKey(tournamentId, generalPlayRoundId, round));
    return raw ? JSON.parse(raw) as CaddieSnapshot : null;
  } catch {
    return null;
  }
}

// ── On-device recommendation (mirrors lib/caddie.ts; used only offline) ─────

function normalCdf(x: number, mean: number, stddev: number): number {
  if (stddev <= 0) return x >= mean ? 1 : 0;
  const z = (x - mean) / (stddev * Math.SQRT2);
  const t = 1 / (1 + 0.3275911 * Math.abs(z));
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  const erf = z >= 0 ? y : -y;
  return 0.5 * (1 + erf);
}

function probWithinBand(targetYds: number, carry: number, stddev: number, tolerance = 10): number {
  const upper = normalCdf(targetYds + tolerance, carry, stddev);
  const lower = normalCdf(targetYds - tolerance, carry, stddev);
  return Math.max(0, Math.min(1, upper - lower));
}

function offsetYardsToLatLng(pinLat: number, forwardYds: number, lateralYds: number, bearingDeg: number) {
  const yardsToMeters = 0.9144;
  const fwdM = forwardYds * yardsToMeters;
  const latM = lateralYds * yardsToMeters;
  const bRad = bearingDeg * Math.PI / 180;
  const northM = fwdM * Math.cos(bRad) - latM * Math.sin(bRad);
  const eastM = fwdM * Math.sin(bRad) + latM * Math.cos(bRad);
  const metersPerDegLat = 111111;
  const metersPerDegLng = 111111 * Math.cos(pinLat * Math.PI / 180);
  return { lat: northM / metersPerDegLat, lng: eastM / metersPerDegLng };
}

export interface LocalRecommendation {
  recommendationId: null;
  distanceYards: number;
  effectiveDistance: number;
  windAdjustmentYards: number;
  headwindComponent: number;
  crosswindComponent: number;
  lateralStddevYards: number;
  aimOffsetYards: { forward: number; lateral: number };
  aimLatLngOffset: { lat: number; lng: number } | null;
  rankedClubs: Array<{ club: string; carry: number; stddev: number; shotCount: number; source: ClubStat["source"]; onGreenProb: number; surplusYards: number }>;
  recommended: { club: string; carryYards: number; stddev: number; onGreenProb: number; shotCount: number } | null;
  alternate: { club: string; carryYards: number; stddev: number; onGreenProb: number; shotCount: number } | null;
  rationale: string[];
  usingFallback: boolean;
  missBiasLateralYards: number;
  isLocal: true;
}

// Mirrors LIE_ADJUSTMENTS in api-server/src/lib/caddie.ts so on-device offline
// estimates apply the same lie penalties as the backend engine.
const LOCAL_LIE_ADJUSTMENTS: Record<string, { distanceMultiplier: number; dispersionMultiplier: number; label: string }> = {
  tee:     { distanceMultiplier: 1.00, dispersionMultiplier: 1.00, label: "tee" },
  fairway: { distanceMultiplier: 1.00, dispersionMultiplier: 1.00, label: "fairway" },
  green:   { distanceMultiplier: 1.00, dispersionMultiplier: 1.00, label: "green" },
  rough:   { distanceMultiplier: 1.05, dispersionMultiplier: 1.30, label: "rough" },
  sand:    { distanceMultiplier: 1.15, dispersionMultiplier: 1.50, label: "bunker" },
  bunker:  { distanceMultiplier: 1.15, dispersionMultiplier: 1.50, label: "bunker" },
  hazard:  { distanceMultiplier: 1.10, dispersionMultiplier: 1.40, label: "hazard" },
};

/** Compute a recommendation on-device using the cached model snapshot. */
export function computeLocalRecommendation(args: {
  snapshot: CaddieSnapshot;
  distanceYards: number;
  windSpeedMph: number;
  windDirectionDeg: number;
  windBearingDeg: number;
  pinLat: number | null;
  bearingToPinDeg: number | null;
  elevationDeltaYards?: number;
  lieType?: string | null;
}): LocalRecommendation | null {
  const {
    snapshot, distanceYards, windSpeedMph, windDirectionDeg, windBearingDeg,
    pinLat, bearingToPinDeg, elevationDeltaYards = 0, lieType = null,
  } = args;
  const stats = snapshot.clubStats;
  if (stats.length === 0) return null;

  const angle = (windDirectionDeg - windBearingDeg) * Math.PI / 180;
  const headwind = windSpeedMph * Math.cos(angle);
  const crosswind = windSpeedMph * Math.sin(angle);
  const windAdj = headwind > 0 ? headwind : headwind * 0.6;
  const elevAdj = elevationDeltaYards >= 0 ? elevationDeltaYards : elevationDeltaYards * 0.7;
  const lieAdj = (lieType && LOCAL_LIE_ADJUSTMENTS[lieType.toLowerCase()]) || LOCAL_LIE_ADJUSTMENTS.fairway;
  const lieAdjYards = distanceYards * (lieAdj.distanceMultiplier - 1);
  const effective = Math.max(20, distanceYards + windAdj + elevAdj + lieAdjYards);

  // Per-lie acceptance bucket for the current shot's lie. Falls back to an
  // empty object when the snapshot predates per-lie data or the player has no
  // history from this lie yet, so the local recommendation degrades gracefully
  // to the per-club bias.
  const currentLieKey = lieType ? lieAdj.label : null;
  const lieAcceptanceForCurrent = currentLieKey ? snapshot.acceptanceByLie?.[currentLieKey] ?? null : null;

  const ranked = stats.map(s => {
    const adjStddev = Math.max(4, s.stddevCarry * lieAdj.dispersionMultiplier);
    const baseProb = probWithinBand(effective, s.avgCarry, adjStddev, 10);
    const baseAccept = snapshot.acceptanceByClub[s.club];
    const lieAccept = lieAcceptanceForCurrent?.[s.club];
    let combinedAccept: number | undefined;
    if (lieAccept != null && baseAccept != null) combinedAccept = 0.4 * baseAccept + 0.6 * lieAccept;
    else if (lieAccept != null) combinedAccept = lieAccept;
    else if (baseAccept != null) combinedAccept = baseAccept;
    const personalisation = combinedAccept == null ? 1 : 0.95 + 0.10 * combinedAccept;
    return {
      club: s.club, carry: s.avgCarry, stddev: Math.round(adjStddev), shotCount: s.shotCount, source: s.source,
      onGreenProb: Math.max(0, Math.min(1, baseProb * personalisation)),
      surplusYards: s.avgCarry - effective,
    };
  }).sort((a, b) => b.onGreenProb - a.onGreenProb);

  let recommended = ranked[0] ?? null;
  if (recommended && ranked.length > 1) {
    const close = ranked.filter(r => recommended!.onGreenProb - r.onGreenProb < 0.05);
    if (close.length > 1) recommended = close.reduce((best, r) => r.carry > best.carry ? r : best, close[0]);
  }
  const alternate = ranked.find(r => r.club !== recommended?.club) ?? null;

  const lateralStddev = recommended ? Math.max(4, recommended.stddev * 0.7) : 8;
  const crossDrift = (crosswind * 0.8) * (effective / 100);
  const aimLateral = -crossDrift - snapshot.missBiasLateralYards;
  const forwardTrim = recommended && recommended.surplusYards > recommended.stddev
    ? Math.min(8, recommended.surplusYards - recommended.stddev) : 0;
  const aimForward = -forwardTrim;

  const aimLatLng = (pinLat != null && bearingToPinDeg != null)
    ? offsetYardsToLatLng(pinLat, aimForward, aimLateral, bearingToPinDeg) : null;

  const rationale: string[] = [];
  if (recommended) {
    rationale.push(`${recommended.club} carries ${recommended.carry}y (offline estimate)`);
    rationale.push(`${Math.round(recommended.onGreenProb * 100)}% chance within 10y of pin`);
    if (recommended.shotCount >= 5) rationale.push(`based on ${recommended.shotCount} of your tracked shots`);
  }
  if (Math.abs(headwind) > 3) rationale.push(`${Math.round(Math.abs(headwind))}mph ${headwind > 0 ? "headwind" : "tailwind"}`);
  if (Math.abs(elevationDeltaYards) >= 3) rationale.push(`${Math.round(Math.abs(elevationDeltaYards))}y ${elevationDeltaYards > 0 ? "uphill" : "downhill"}`);
  if (lieAdj.distanceMultiplier !== 1) rationale.push(`from the ${lieAdj.label} — playing ${Math.max(1, Math.round(lieAdjYards))}y longer`);
  if (Math.abs(crosswind) > 4) rationale.push(`${Math.round(Math.abs(crosswind))}mph crosswind — aim ${Math.round(Math.abs(crossDrift))}y ${crosswind > 0 ? "left" : "right"}`);

  return {
    recommendationId: null,
    distanceYards,
    effectiveDistance: Math.round(effective),
    windAdjustmentYards: Math.round(windAdj),
    headwindComponent: Math.round(headwind * 10) / 10,
    crosswindComponent: Math.round(crosswind * 10) / 10,
    lateralStddevYards: Math.round(lateralStddev * 10) / 10,
    aimOffsetYards: { forward: Math.round(aimForward * 10) / 10, lateral: Math.round(aimLateral * 10) / 10 },
    aimLatLngOffset: aimLatLng,
    rankedClubs: ranked.slice(0, 3),
    recommended: recommended ? { club: recommended.club, carryYards: recommended.carry, stddev: recommended.stddev, onGreenProb: recommended.onGreenProb, shotCount: recommended.shotCount } : null,
    alternate: alternate ? { club: alternate.club, carryYards: alternate.carry, stddev: alternate.stddev, onGreenProb: alternate.onGreenProb, shotCount: alternate.shotCount } : null,
    rationale,
    usingFallback: stats.every(s => s.source === "fallback"),
    missBiasLateralYards: snapshot.missBiasLateralYards,
    isLocal: true,
  };
}

// ── Feedback queue ──────────────────────────────────────────────────────────

async function readQueue(): Promise<QueuedFeedback[]> {
  try {
    const raw = await AsyncStorage.getItem(FEEDBACK_QUEUE_KEY);
    return raw ? JSON.parse(raw) as QueuedFeedback[] : [];
  } catch { return []; }
}

async function writeQueue(q: QueuedFeedback[]): Promise<void> {
  try { await AsyncStorage.setItem(FEEDBACK_QUEUE_KEY, JSON.stringify(q)); } catch {}
}

/**
 * Send feedback to the backend. If the request fails (e.g. offline), queue it
 * locally and return false. The caller can call `flushFeedbackQueue` later.
 */
export async function sendOrQueueFeedback(token: string, fb: Omit<QueuedFeedback, "queuedAt">): Promise<boolean> {
  try {
    await postPortal("/caddie/feedback", token, fb);
    return true;
  } catch {
    const q = await readQueue();
    q.push({ ...fb, queuedAt: Date.now() });
    await writeQueue(q);
    return false;
  }
}

/** Replay all queued feedback POSTs. Returns the count flushed. */
export async function flushFeedbackQueue(token: string): Promise<number> {
  const q = await readQueue();
  if (q.length === 0) return 0;
  const remaining: QueuedFeedback[] = [];
  let flushed = 0;
  for (const item of q) {
    try {
      await postPortal("/caddie/feedback", token, {
        recommendationId: item.recommendationId,
        chosenClub: item.chosenClub,
        accepted: item.accepted,
        outcomeStrokes: item.outcomeStrokes,
        outcomeDistanceToPin: item.outcomeDistanceToPin,
      });
      flushed += 1;
    } catch {
      remaining.push(item);
    }
  }
  await writeQueue(remaining);
  return flushed;
}
