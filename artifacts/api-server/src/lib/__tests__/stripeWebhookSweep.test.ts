/**
 * Task #1294 — Integration test for the daily `stripe_webhook_deliveries`
 * retention sweep. Verifies that:
 *
 *   1. `sweepOldStripeWebhookDeliveries` writes a `stripe_webhook_sweep_runs`
 *      row recording how many old rows it removed, even when removed === 0
 *      (admins want to know the sweep ran on a healthy quiet day).
 *   2. `getLastStripeWebhookSweepResult` returns the most recent run.
 *   3. The summary survives a "server restart" — clearing the in-process
 *      cache and re-reading falls back to the DB and returns the same row.
 *
 * Uses the real Postgres test DB (matches the convention used by the other
 * integration tests in src/tests/ and the wellness-sweep test).
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  db,
  stripeWebhookDeliveriesTable,
  stripeWebhookSweepRunsTable,
} from "@workspace/db";
import { lt } from "drizzle-orm";
import { sweepOldStripeWebhookDeliveries } from "../cron.js";
import {
  getLastStripeWebhookSweepResult,
  isStripeWebhookSweepStale,
  STRIPE_WEBHOOK_SWEEP_STALE_AFTER_MS,
  _resetStripeWebhookSweepCacheForTests,
  _setProcessStartedAtForTests,
} from "../stripeWebhookSweepStatus.js";

beforeEach(async () => {
  // Clean both tables so each test starts from a deterministic baseline.
  await db.delete(stripeWebhookSweepRunsTable);
  await db.delete(stripeWebhookDeliveriesTable);
  _resetStripeWebhookSweepCacheForTests();
});

describe("sweepOldStripeWebhookDeliveries — Task #1294 audit persistence", () => {
  it("records a sweep run with removed=0 on a quiet day so admins can see the sweep ran", async () => {
    const result = await sweepOldStripeWebhookDeliveries();
    expect(result.removed).toBe(0);

    const last = await getLastStripeWebhookSweepResult();
    expect(last).not.toBeNull();
    expect(last!.removed).toBe(0);
    expect(typeof last!.ranAt).toBe("string");
    expect(Number.isNaN(Date.parse(last!.ranAt))).toBe(false);
  });

  it("records the actual removed-row count when old deliveries are pruned", async () => {
    // Seed 3 deliveries older than the 30-day retention window plus 1 fresh
    // row that should NOT be deleted.
    const oldDate = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000);
    const freshDate = new Date(Date.now() - 60 * 1000);
    for (let i = 0; i < 3; i++) {
      await db.insert(stripeWebhookDeliveriesTable).values({
        eventId: `evt_old_${i}_${Date.now()}`,
        eventType: "payment_intent.succeeded",
        receivedAt: oldDate,
        sourceIp: "127.0.0.1",
        signatureValid: true,
        applied: true,
        responseStatus: 200,
      });
    }
    await db.insert(stripeWebhookDeliveriesTable).values({
      eventId: `evt_fresh_${Date.now()}`,
      eventType: "payment_intent.succeeded",
      receivedAt: freshDate,
      sourceIp: "127.0.0.1",
      signatureValid: true,
      applied: true,
      responseStatus: 200,
    });

    const result = await sweepOldStripeWebhookDeliveries();
    expect(result.removed).toBe(3);

    const last = await getLastStripeWebhookSweepResult();
    expect(last).not.toBeNull();
    expect(last!.removed).toBe(3);

    // The fresh row should still be present.
    const remaining = await db.select().from(stripeWebhookDeliveriesTable);
    expect(remaining).toHaveLength(1);
  });

  it("re-hydrates the last sweep result from the DB after the in-memory cache is cleared", async () => {
    await sweepOldStripeWebhookDeliveries();
    const cached = await getLastStripeWebhookSweepResult();
    expect(cached).not.toBeNull();

    // Simulate a server restart: forget the in-memory cache. The next read
    // should fall back to `stripe_webhook_sweep_runs` and return the same
    // row, so the admin tile is populated immediately on cold start.
    _resetStripeWebhookSweepCacheForTests();
    const afterRestart = await getLastStripeWebhookSweepResult();
    expect(afterRestart).not.toBeNull();
    expect(afterRestart!.ranAt).toBe(cached!.ranAt);
    expect(afterRestart!.removed).toBe(cached!.removed);
  });

  it("returns the most recent sweep when multiple runs have completed", async () => {
    await sweepOldStripeWebhookDeliveries();
    const first = await getLastStripeWebhookSweepResult();
    expect(first).not.toBeNull();

    // Wait a tiny amount so the second run's `ran_at` is strictly newer than
    // the first (millisecond resolution is enough for postgres `now()`).
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Seed one old row so the second sweep removes a different count.
    await db.insert(stripeWebhookDeliveriesTable).values({
      eventId: `evt_old_recent_${Date.now()}`,
      eventType: "checkout.session.completed",
      receivedAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000),
      sourceIp: "127.0.0.1",
      signatureValid: true,
      applied: false,
      responseStatus: 200,
    });

    await sweepOldStripeWebhookDeliveries();
    const second = await getLastStripeWebhookSweepResult();
    expect(second).not.toBeNull();
    expect(second!.removed).toBe(1);
    expect(Date.parse(second!.ranAt)).toBeGreaterThanOrEqual(Date.parse(first!.ranAt));

    // Two rows should exist in the audit table.
    const allRuns = await db.select().from(stripeWebhookSweepRunsTable);
    expect(allRuns.length).toBe(2);
  });

  it("prunes audit rows older than 90 days on each sweep", async () => {
    // Seed an aged audit row beyond the 90-day retention window.
    const ancient = new Date(Date.now() - 120 * 24 * 60 * 60 * 1000);
    await db.insert(stripeWebhookSweepRunsTable).values({
      ranAt: ancient,
      removed: 99,
    });
    // Sanity: the seed row exists.
    const before = await db.select().from(stripeWebhookSweepRunsTable);
    expect(before.length).toBe(1);

    await sweepOldStripeWebhookDeliveries();

    // The new sweep insert is kept, the ancient row is pruned.
    const after = await db.select().from(stripeWebhookSweepRunsTable);
    expect(after.length).toBe(1);
    const stillThere = await db
      .select()
      .from(stripeWebhookSweepRunsTable)
      .where(lt(stripeWebhookSweepRunsTable.ranAt, ancient));
    expect(stillThere.length).toBe(0);
  });
});

describe("isStripeWebhookSweepStale — Task #1295 stale-sweep alert", () => {
  // Always restore a "process started right now" baseline so individual cases
  // don't leak into one another.
  beforeEach(() => {
    _setProcessStartedAtForTests(Date.now());
  });

  it("treats a recent sweep as healthy (not stale)", () => {
    const now = Date.parse("2026-04-29T12:00:00.000Z");
    const ranAt = new Date(now - 6 * 60 * 60 * 1000).toISOString(); // 6h ago
    expect(isStripeWebhookSweepStale({ ranAt, removed: 0 }, now)).toBe(false);
  });

  it("flags a sweep older than the ~36h threshold as stale", () => {
    const now = Date.parse("2026-04-29T12:00:00.000Z");
    const ranAt = new Date(
      now - STRIPE_WEBHOOK_SWEEP_STALE_AFTER_MS - 60 * 1000,
    ).toISOString();
    expect(isStripeWebhookSweepStale({ ranAt, removed: 5 }, now)).toBe(true);
  });

  it("does NOT flag a fresh-deploy null reading as stale (process just started)", () => {
    const now = Date.parse("2026-04-29T12:00:00.000Z");
    _setProcessStartedAtForTests(now - 10 * 60 * 1000); // process up 10m
    expect(isStripeWebhookSweepStale(null, now)).toBe(false);
  });

  it("flags a null reading after long uptime as stale (cron has never run)", () => {
    const now = Date.parse("2026-04-29T12:00:00.000Z");
    _setProcessStartedAtForTests(
      now - STRIPE_WEBHOOK_SWEEP_STALE_AFTER_MS - 60 * 1000,
    );
    expect(isStripeWebhookSweepStale(null, now)).toBe(true);
  });

  it("falls back to not-stale when ranAt is unparseable rather than alerting on garbage", () => {
    const now = Date.parse("2026-04-29T12:00:00.000Z");
    expect(
      isStripeWebhookSweepStale({ ranAt: "not-a-timestamp", removed: 0 }, now),
    ).toBe(false);
  });
});
