import { db, caddiePromptMetricsTable } from "@workspace/db";
import { and, gte, lt, desc, sql } from "drizzle-orm";
import { logger as baseLogger } from "./logger";

export type CaddieContextMode = "shots" | "rounds";

export interface CaddiePromptMetric {
  ts: number;
  userId: number;
  contextMode: CaddieContextMode;
  estimatedInputTokens: number;
  totalTrackedShots: number;
  roundCount: number;
  shotLineCount: number;
}

// Trend warning still uses a small in-process window so that a single replica
// can detect a sudden jump in its own traffic without an extra DB round-trip
// on every request. The durable record is the DB row.
const TREND_WINDOW = 50;
const TREND_BASELINE_MULTIPLIER = 1.5;
const TREND_MIN_TOKENS = 4000;
const TREND_RING_SIZE = TREND_WINDOW * 2;
const trendRing: number[] = [];
let trendRingStart = 0;
let lastTrendWarnAt = 0;
const TREND_WARN_COOLDOWN_MS = 5 * 60 * 1000;

function pushTrend(tokens: number): void {
  if (trendRing.length < TREND_RING_SIZE) {
    trendRing.push(tokens);
  } else {
    trendRing[trendRingStart] = tokens;
    trendRingStart = (trendRingStart + 1) % TREND_RING_SIZE;
  }
}

function trendSnapshot(): number[] {
  if (trendRing.length < TREND_RING_SIZE) return trendRing.slice();
  return [...trendRing.slice(trendRingStart), ...trendRing.slice(0, trendRingStart)];
}

function avg(nums: number[]): number {
  if (nums.length === 0) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function maybeWarnOnTrend(): void {
  const all = trendSnapshot();
  if (all.length < TREND_WINDOW * 2) return;
  const recent = all.slice(-TREND_WINDOW);
  const baseline = all.slice(0, all.length - TREND_WINDOW);
  const recentAvg = avg(recent);
  const baselineAvg = avg(baseline);
  if (
    recentAvg >= TREND_MIN_TOKENS &&
    baselineAvg > 0 &&
    recentAvg >= baselineAvg * TREND_BASELINE_MULTIPLIER &&
    Date.now() - lastTrendWarnAt > TREND_WARN_COOLDOWN_MS
  ) {
    lastTrendWarnAt = Date.now();
    baseLogger.warn(
      {
        caddiePrompt: true,
        recentAvgTokens: Math.round(recentAvg),
        baselineAvgTokens: Math.round(baselineAvg),
        windowSize: TREND_WINDOW,
      },
      "[caddie/ask] avg prompt size trending up",
    );
  }
}

export function recordCaddiePromptMetric(m: Omit<CaddiePromptMetric, "ts">): void {
  baseLogger.info(
    {
      caddiePrompt: true,
      userId: m.userId,
      contextMode: m.contextMode,
      estimatedInputTokens: m.estimatedInputTokens,
      totalTrackedShots: m.totalTrackedShots,
      roundCount: m.roundCount,
      shotLineCount: m.shotLineCount,
    },
    "[caddie/ask] prompt sized",
  );

  pushTrend(m.estimatedInputTokens);
  maybeWarnOnTrend();

  // Fire-and-forget: never block the chat response on metrics persistence.
  void db.insert(caddiePromptMetricsTable).values({
    userId: m.userId,
    contextMode: m.contextMode,
    estimatedInputTokens: m.estimatedInputTokens,
    totalTrackedShots: m.totalTrackedShots,
    roundCount: m.roundCount,
    shotLineCount: m.shotLineCount,
  }).catch((err: unknown) => {
    baseLogger.warn({ err, caddiePrompt: true }, "[caddie/ask] failed to persist prompt metric");
  });
}

export interface CaddiePromptMetricsWindow {
  total: number;
  byMode: Record<CaddieContextMode, number>;
  avgEstimatedInputTokens: number;
  p50EstimatedInputTokens: number;
  p95EstimatedInputTokens: number;
  maxEstimatedInputTokens: number;
  avgTotalTrackedShots: number;
  avgRoundCount: number;
}

export interface CaddiePromptMetricsSummary {
  windows: {
    "24h": CaddiePromptMetricsWindow;
    "7d": CaddiePromptMetricsWindow;
    "30d": CaddiePromptMetricsWindow;
  };
  recent: CaddiePromptMetric[];
}

const EMPTY_WINDOW: CaddiePromptMetricsWindow = {
  total: 0,
  byMode: { shots: 0, rounds: 0 },
  avgEstimatedInputTokens: 0,
  p50EstimatedInputTokens: 0,
  p95EstimatedInputTokens: 0,
  maxEstimatedInputTokens: 0,
  avgTotalTrackedShots: 0,
  avgRoundCount: 0,
};

async function aggregateWindow(sinceMs: number): Promise<CaddiePromptMetricsWindow> {
  const since = new Date(sinceMs);
  const rows = await db
    .select({
      total: sql<number>`count(*)::int`,
      shotsCount: sql<number>`count(*) filter (where ${caddiePromptMetricsTable.contextMode} = 'shots')::int`,
      roundsCount: sql<number>`count(*) filter (where ${caddiePromptMetricsTable.contextMode} = 'rounds')::int`,
      avgTokens: sql<number>`coalesce(avg(${caddiePromptMetricsTable.estimatedInputTokens}), 0)`,
      p50Tokens: sql<number>`coalesce(percentile_cont(0.5) within group (order by ${caddiePromptMetricsTable.estimatedInputTokens}), 0)`,
      p95Tokens: sql<number>`coalesce(percentile_cont(0.95) within group (order by ${caddiePromptMetricsTable.estimatedInputTokens}), 0)`,
      maxTokens: sql<number>`coalesce(max(${caddiePromptMetricsTable.estimatedInputTokens}), 0)::int`,
      avgShots: sql<number>`coalesce(avg(${caddiePromptMetricsTable.totalTrackedShots}), 0)`,
      avgRounds: sql<number>`coalesce(avg(${caddiePromptMetricsTable.roundCount}), 0)`,
    })
    .from(caddiePromptMetricsTable)
    .where(gte(caddiePromptMetricsTable.createdAt, since));
  const r = rows[0];
  if (!r || Number(r.total) === 0) return { ...EMPTY_WINDOW };
  return {
    total: Number(r.total),
    byMode: { shots: Number(r.shotsCount), rounds: Number(r.roundsCount) },
    avgEstimatedInputTokens: Math.round(Number(r.avgTokens)),
    p50EstimatedInputTokens: Math.round(Number(r.p50Tokens)),
    p95EstimatedInputTokens: Math.round(Number(r.p95Tokens)),
    maxEstimatedInputTokens: Number(r.maxTokens),
    avgTotalTrackedShots: Math.round(Number(r.avgShots)),
    avgRoundCount: Math.round(Number(r.avgRounds) * 100) / 100,
  };
}

export async function getCaddiePromptMetricsSummary(recentLimit = 20): Promise<CaddiePromptMetricsSummary> {
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  const [w24h, w7d, w30d, recentRows] = await Promise.all([
    aggregateWindow(now - day),
    aggregateWindow(now - 7 * day),
    aggregateWindow(now - 30 * day),
    db
      .select()
      .from(caddiePromptMetricsTable)
      .orderBy(desc(caddiePromptMetricsTable.createdAt))
      .limit(Math.max(1, Math.min(200, recentLimit))),
  ]);
  const recent: CaddiePromptMetric[] = recentRows.map((r) => ({
    ts: r.createdAt.getTime(),
    userId: r.userId,
    contextMode: r.contextMode as CaddieContextMode,
    estimatedInputTokens: r.estimatedInputTokens,
    totalTrackedShots: r.totalTrackedShots,
    roundCount: r.roundCount,
    shotLineCount: r.shotLineCount,
  }));
  return {
    windows: { "24h": w24h, "7d": w7d, "30d": w30d },
    recent,
  };
}

const PRUNE_KEEP_DAYS = 90;

export async function pruneCaddiePromptMetrics(): Promise<{ deleted: number }> {
  const cutoff = new Date(Date.now() - PRUNE_KEEP_DAYS * 24 * 60 * 60 * 1000);
  const deleted = await db
    .delete(caddiePromptMetricsTable)
    .where(lt(caddiePromptMetricsTable.createdAt, cutoff))
    .returning({ id: caddiePromptMetricsTable.id });
  if (deleted.length > 0) {
    baseLogger.info(
      { caddiePrompt: true, deleted: deleted.length, cutoff: cutoff.toISOString() },
      "[caddie/prompt-metrics] pruned old rows",
    );
  }
  return { deleted: deleted.length };
}

// Used by tests to clear in-process trend window. The DB table is cleaned by
// the test fixture itself.
export function _resetCaddiePromptMetricsForTests(): void {
  trendRing.length = 0;
  trendRingStart = 0;
  lastTrendWarnAt = 0;
}

// Avoid an unused-import warning if drizzle helpers are tree-shaken differently.
void and;
