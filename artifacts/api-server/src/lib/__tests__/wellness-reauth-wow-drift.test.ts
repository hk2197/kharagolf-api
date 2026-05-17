/**
 * Integration tests for Task #1151 — weekly week-over-week needs_reauth
 * drift evaluator.
 *
 * Covers:
 *   1. Below threshold (or insufficient data) → no email, no watermark stamp.
 *   2. Above threshold → per-org email sent and `wearable_reauth_wow_alert_last_sent_at`
 *      stamped.
 *   3. Per-org rate limit: a second evaluation within 7 days does NOT re-send,
 *      and reports the org as rateLimited.
 *   4. After 7+ days, the rate limit unblocks and the email fires again.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

vi.mock("../mailer.js", async () => ({
  sendBroadcastEmail: vi.fn(async () => undefined),
}));

import {
  db,
  organizationsTable,
  wellnessSweepRunsTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";

import { evaluateWeeklyReauthDrift } from "../wearables.js";
import { sendBroadcastEmail } from "../mailer.js";

const emailMock = vi.mocked(sendBroadcastEmail);

const createdOrgIds: number[] = [];
const insertedRunIds: number[] = [];

async function makeOrg(
  label: string,
  email: string | null,
  opts: { wowMinDelta?: string } = {},
): Promise<number> {
  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const [o] = await db.insert(organizationsTable).values({
    name: `wow-drift-${label}-${stamp}`,
    slug: `wow-drift-${label}-${stamp}`,
    wearableReauthAlertEmail: email,
    ...(opts.wowMinDelta !== undefined
      ? { wearableReauthWowAlertMinDelta: opts.wowMinDelta }
      : {}),
  }).returning();
  createdOrgIds.push(o.id);
  return o.id;
}

async function seedRuns(window: "this" | "last", needsReauthValues: number[], now: Date): Promise<void> {
  // Spread runs across the window so they all fall inside [start, end).
  // "this" → [now-7d, now); "last" → [now-14d, now-7d).
  const day = 24 * 60 * 60 * 1000;
  const end = window === "this" ? now.getTime() : now.getTime() - 7 * day;
  for (let i = 0; i < needsReauthValues.length; i++) {
    // Stagger by hour, anchored well inside the window so float math doesn't
    // bump rows out by a few ms.
    const ranAt = new Date(end - (i + 1) * 60 * 60 * 1000);
    const [row] = await db.insert(wellnessSweepRunsTable).values({
      ranAt,
      attempted: 100,
      succeeded: 100 - needsReauthValues[i],
      needsReauth: needsReauthValues[i],
      alerted: false,
    }).returning({ id: wellnessSweepRunsTable.id });
    insertedRunIds.push(row.id);
  }
}

beforeEach(() => {
  emailMock.mockClear();
});

afterAll(async () => {
  if (insertedRunIds.length > 0) {
    await db.delete(wellnessSweepRunsTable).where(inArray(wellnessSweepRunsTable.id, insertedRunIds));
  }
  if (createdOrgIds.length > 0) {
    await db.delete(organizationsTable).where(inArray(organizationsTable.id, createdOrgIds));
  }
});

describe("evaluateWeeklyReauthDrift — insufficient data", () => {
  it("does not send when fewer than minRuns rows exist in either window", async () => {
    // Use a distant past anchor so each test's [now-14d, now) windows do
    // not overlap with rows seeded by sibling tests in this file (or by
    // other integration tests that touch wellness_sweep_runs).
    const now = new Date("2020-01-15T12:00:00Z");
    // Only 2 runs in this week, threshold default 24 → insufficient_data.
    await seedRuns("this", [10, 10], now);
    const result = await evaluateWeeklyReauthDrift({ now });
    expect(result.tripped).toBe(false);
    expect(result.reason).toBe("insufficient_data");
    expect(result.orgsNotified).toBe(0);
    expect(emailMock).not.toHaveBeenCalled();
  });
});

describe("evaluateWeeklyReauthDrift — above threshold", () => {
  it("sends per-org email and stamps watermark when WoW delta exceeds threshold", async () => {
    const now = new Date("2020-02-15T12:00:00Z");
    const orgId = await makeOrg("above", "ops+above@example.test");

    // Last week avg = 1, this week avg = 5 → delta 4 ≥ default threshold 1.
    await seedRuns("last", Array(30).fill(1), now);
    await seedRuns("this", Array(30).fill(5), now);

    const result = await evaluateWeeklyReauthDrift({ now });
    expect(result.tripped).toBe(true);
    expect(result.reason).toBeNull();
    expect(result.orgsNotified).toBeGreaterThanOrEqual(1);
    expect(result.delta).toBeCloseTo(4, 5);

    expect(emailMock).toHaveBeenCalled();
    const call = emailMock.mock.calls.find(c => c[0] === "ops+above@example.test");
    expect(call).toBeDefined();

    const [org] = await db.select({
      lastSentAt: organizationsTable.wearableReauthWowAlertLastSentAt,
    }).from(organizationsTable).where(eq(organizationsTable.id, orgId));
    expect(org.lastSentAt).not.toBeNull();
    expect(org.lastSentAt!.getTime()).toBe(now.getTime());
  });
});

describe("evaluateWeeklyReauthDrift — per-org rate limit", () => {
  it("does not re-send within 7 days; resends after the rate-limit window", async () => {
    const now = new Date("2020-03-15T12:00:00Z");
    const orgId = await makeOrg("rate", "ops+rate@example.test");

    await seedRuns("last", Array(30).fill(0), now);
    await seedRuns("this", Array(30).fill(8), now);

    // First evaluation → email + watermark.
    const first = await evaluateWeeklyReauthDrift({ now });
    expect(first.tripped).toBe(true);
    const callsAfterFirst = emailMock.mock.calls.filter(c => c[0] === "ops+rate@example.test").length;
    expect(callsAfterFirst).toBe(1);

    // Same instant + 1 hour → still rate-limited.
    const oneHourLater = new Date(now.getTime() + 60 * 60 * 1000);
    const second = await evaluateWeeklyReauthDrift({ now: oneHourLater });
    expect(second.tripped).toBe(true);
    expect(second.orgsRateLimited).toBeGreaterThanOrEqual(1);
    const callsAfterSecond = emailMock.mock.calls.filter(c => c[0] === "ops+rate@example.test").length;
    expect(callsAfterSecond).toBe(1); // unchanged

    // Manually rewind the watermark > 7 days to simulate the rate-limit
    // window expiring, then re-run.
    const eightDaysAgo = new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000);
    await db.update(organizationsTable)
      .set({ wearableReauthWowAlertLastSentAt: eightDaysAgo })
      .where(eq(organizationsTable.id, orgId));

    const third = await evaluateWeeklyReauthDrift({ now: oneHourLater });
    expect(third.tripped).toBe(true);
    const callsAfterThird = emailMock.mock.calls.filter(c => c[0] === "ops+rate@example.test").length;
    expect(callsAfterThird).toBe(2);
  });
});

describe("evaluateWeeklyReauthDrift — below threshold", () => {
  it("does not send when WoW delta is under the configured threshold", async () => {
    const now = new Date("2020-04-15T12:00:00Z");
    const orgId = await makeOrg("below", "ops+below@example.test");

    // delta = 0.1 — well under default threshold of 1.0.
    await seedRuns("last", Array(30).fill(2), now);
    await seedRuns("this", Array(30).fill(2), now);

    const result = await evaluateWeeklyReauthDrift({ now });
    expect(result.tripped).toBe(false);
    expect(result.reason).toBe("below_threshold");
    expect(emailMock.mock.calls.find(c => c[0] === "ops+below@example.test")).toBeUndefined();

    const [org] = await db.select({
      lastSentAt: organizationsTable.wearableReauthWowAlertLastSentAt,
    }).from(organizationsTable).where(eq(organizationsTable.id, orgId));
    expect(org.lastSentAt).toBeNull();
  });
});

// Task #1325 — per-org min-delta override.
//
// Asserts target the per-org email + watermark state only (the prior tests
// in this file leave their own orgs in the DB across `it` blocks, so the
// global `result.tripped` field can be true for unrelated reasons).
describe("evaluateWeeklyReauthDrift — per-org min-delta override", () => {
  it("alerts an org with a lower override even when the global default is not exceeded", async () => {
    const now = new Date("2020-05-15T12:00:00Z");
    const lowOrg = await makeOrg("low", "ops+low@example.test", { wowMinDelta: "0.25" });
    // Sibling org on the global default — should NOT be alerted at delta 0.5.
    const defaultOrg = await makeOrg("low-default", "ops+low-default@example.test");

    // Last avg = 2.0, this avg = 2.5 → delta 0.5. Below global default 1.0
    // but above the low override of 0.25. needsReauth is an integer column
    // so build the half-step average from a 50/50 mix of 2s and 3s.
    await seedRuns("last", Array(30).fill(2), now);
    const halfStep: number[] = [];
    for (let i = 0; i < 30; i++) halfStep.push(i % 2 === 0 ? 2 : 3);
    await seedRuns("this", halfStep, now);

    const result = await evaluateWeeklyReauthDrift({ now });
    expect(result.delta).toBeCloseTo(0.5, 5);

    // Low-override org got the email.
    const lowCalls = emailMock.mock.calls.filter(c => c[0] === "ops+low@example.test");
    expect(lowCalls.length).toBe(1);
    // Default-threshold sibling org did NOT.
    const defaultCalls = emailMock.mock.calls.filter(c => c[0] === "ops+low-default@example.test");
    expect(defaultCalls.length).toBe(0);

    // Watermark stamped only on the alerted org.
    const [low] = await db.select({
      lastSentAt: organizationsTable.wearableReauthWowAlertLastSentAt,
    }).from(organizationsTable).where(eq(organizationsTable.id, lowOrg));
    expect(low.lastSentAt).not.toBeNull();
    const [def] = await db.select({
      lastSentAt: organizationsTable.wearableReauthWowAlertLastSentAt,
    }).from(organizationsTable).where(eq(organizationsTable.id, defaultOrg));
    expect(def.lastSentAt).toBeNull();
  });

  it("an org without an explicit override inherits the WELLNESS_REAUTH_WOW_ALERT_MIN_DELTA env var", async () => {
    // Reproduces the regression flagged in code review of the first fix
    // attempt: a hardcoded column default would freeze every untouched
    // org at 1.00 and silently bypass any future change to this env var.
    const now = new Date("2020-07-15T12:00:00Z");
    const inheritOrg = await makeOrg("inherit", "ops+inherit@example.test");

    // delta = 0.5 — below the hardcoded fallback (1.0) but above the
    // env-configured default of 0.3 we set just for this test.
    await seedRuns("last", Array(30).fill(2), now);
    const halfStep: number[] = [];
    for (let i = 0; i < 30; i++) halfStep.push(i % 2 === 0 ? 2 : 3);
    await seedRuns("this", halfStep, now);

    const prev = process.env.WELLNESS_REAUTH_WOW_ALERT_MIN_DELTA;
    process.env.WELLNESS_REAUTH_WOW_ALERT_MIN_DELTA = "0.3";
    try {
      await evaluateWeeklyReauthDrift({ now });
    } finally {
      if (prev === undefined) delete process.env.WELLNESS_REAUTH_WOW_ALERT_MIN_DELTA;
      else process.env.WELLNESS_REAUTH_WOW_ALERT_MIN_DELTA = prev;
    }

    // Inheriting org WAS alerted because the env fallback (0.3) is below
    // delta 0.5 — proving the column being NULL does NOT bypass the env.
    const calls = emailMock.mock.calls.filter(c => c[0] === "ops+inherit@example.test");
    expect(calls.length).toBe(1);
    const [stamped] = await db.select({
      lastSentAt: organizationsTable.wearableReauthWowAlertLastSentAt,
      override: organizationsTable.wearableReauthWowAlertMinDelta,
    }).from(organizationsTable).where(eq(organizationsTable.id, inheritOrg));
    expect(stamped.lastSentAt).not.toBeNull();
    // And critically: the column is still NULL — we didn't accidentally
    // backfill it with the env value.
    expect(stamped.override).toBeNull();
  });

  it("suppresses alert for an org with a higher override even when the global default IS exceeded", async () => {
    const now = new Date("2020-06-15T12:00:00Z");
    // delta = 4 — well over global default 1.0, but this club only wants
    // to hear about it at ≥ 10 flips/sweep delta.
    const tolerantOrg = await makeOrg("tolerant", "ops+tolerant@example.test", { wowMinDelta: "10.00" });

    await seedRuns("last", Array(30).fill(1), now);
    await seedRuns("this", Array(30).fill(5), now);

    await evaluateWeeklyReauthDrift({ now });
    // The tolerant org specifically must not have been emailed or stamped,
    // even though the global default threshold IS exceeded by delta=4.
    expect(emailMock.mock.calls.find(c => c[0] === "ops+tolerant@example.test")).toBeUndefined();

    const [org] = await db.select({
      lastSentAt: organizationsTable.wearableReauthWowAlertLastSentAt,
    }).from(organizationsTable).where(eq(organizationsTable.id, tolerantOrg));
    expect(org.lastSentAt).toBeNull();
  });
});
