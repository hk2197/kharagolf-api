/**
 * Integration tests for the durable AI Caddie prompt-metrics store
 * (Task #845 — persist metrics across restarts).
 *
 * Hits the real PostgreSQL database (DATABASE_URL).
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { db, caddiePromptMetricsTable } from "@workspace/db";
import { sql } from "drizzle-orm";
import {
  recordCaddiePromptMetric,
  getCaddiePromptMetricsSummary,
  pruneCaddiePromptMetrics,
  _resetCaddiePromptMetricsForTests,
} from "../lib/caddiePromptMetrics";

async function clearTable() {
  await db.execute(sql`TRUNCATE TABLE ${caddiePromptMetricsTable} RESTART IDENTITY`);
}

async function recordAndWait(m: Parameters<typeof recordCaddiePromptMetric>[0]) {
  recordCaddiePromptMetric(m);
  // recordCaddiePromptMetric is fire-and-forget, but the in-process insert
  // resolves on the next microtask; await one round-trip to flush it.
  await new Promise((r) => setTimeout(r, 50));
}

describe("caddiePromptMetrics (durable)", () => {
  beforeEach(async () => {
    _resetCaddiePromptMetricsForTests();
    await clearTable();
  });

  afterAll(async () => {
    await clearTable();
  });

  it("returns empty windows when nothing has been recorded", async () => {
    const s = await getCaddiePromptMetricsSummary();
    expect(s.windows["24h"].total).toBe(0);
    expect(s.windows["7d"].total).toBe(0);
    expect(s.windows["30d"].total).toBe(0);
    expect(s.windows["24h"].byMode).toEqual({ shots: 0, rounds: 0 });
    expect(s.recent).toEqual([]);
  });

  it("aggregates contextMode counts and percentile stats over the 24h window", async () => {
    for (let i = 0; i < 10; i++) {
      await recordAndWait({
        userId: i + 1,
        contextMode: i < 7 ? "shots" : "rounds",
        estimatedInputTokens: 1000 + i * 100,
        totalTrackedShots: 50 + i,
        roundCount: 2,
        shotLineCount: 30,
      });
    }
    const s = await getCaddiePromptMetricsSummary();
    const w = s.windows["24h"];
    expect(w.total).toBe(10);
    expect(w.byMode.shots).toBe(7);
    expect(w.byMode.rounds).toBe(3);
    expect(w.avgEstimatedInputTokens).toBe(1450);
    expect(w.maxEstimatedInputTokens).toBe(1900);
    expect(w.p50EstimatedInputTokens).toBeGreaterThanOrEqual(1400);
    expect(w.p95EstimatedInputTokens).toBeGreaterThanOrEqual(1800);
    expect(s.recent.length).toBe(10);
    // Most recent first.
    expect(s.recent[0].userId).toBe(10);
  });

  it("clamps the recent limit", async () => {
    for (let i = 0; i < 5; i++) {
      await recordAndWait({
        userId: i,
        contextMode: "rounds",
        estimatedInputTokens: 100,
        totalTrackedShots: 0,
        roundCount: 1,
        shotLineCount: 0,
      });
    }
    const s = await getCaddiePromptMetricsSummary(50);
    expect(s.recent.length).toBe(5);
  });

  it("survives a 'restart' — aggregates re-read from the DB", async () => {
    for (let i = 0; i < 3; i++) {
      await recordAndWait({
        userId: 100 + i,
        contextMode: "shots",
        estimatedInputTokens: 2000,
        totalTrackedShots: 10,
        roundCount: 1,
        shotLineCount: 5,
      });
    }
    // Simulate process restart: blow away in-process trend buffer; DB rows stay.
    _resetCaddiePromptMetricsForTests();
    const s = await getCaddiePromptMetricsSummary();
    expect(s.windows["24h"].total).toBe(3);
    expect(s.windows["7d"].total).toBe(3);
    expect(s.recent.length).toBe(3);
  });

  it("prune deletes rows older than 90 days", async () => {
    // Recent row — should survive prune.
    await recordAndWait({
      userId: 1,
      contextMode: "shots",
      estimatedInputTokens: 500,
      totalTrackedShots: 0,
      roundCount: 0,
      shotLineCount: 0,
    });
    // Backdated row — should be pruned.
    await db.insert(caddiePromptMetricsTable).values({
      userId: 999,
      contextMode: "shots",
      estimatedInputTokens: 500,
      totalTrackedShots: 0,
      roundCount: 0,
      shotLineCount: 0,
      createdAt: new Date(Date.now() - 100 * 24 * 60 * 60 * 1000),
    });
    const { deleted } = await pruneCaddiePromptMetrics();
    expect(deleted).toBe(1);
    const s = await getCaddiePromptMetricsSummary();
    expect(s.windows["30d"].total).toBe(1);
  });
});
