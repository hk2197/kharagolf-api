/**
 * Integration tests for Task #1324 — read-only week-over-week needs_reauth
 * drift snapshot that powers the admin dashboard tile.
 *
 * Covers:
 *   1. With insufficient runs in either window the snapshot reports
 *      `hasSufficientData: false` and `exceedsThreshold: false`.
 *   2. With drift above the configured threshold the snapshot computes the
 *      same delta the cron evaluator would and reports
 *      `exceedsThreshold: true`. The org watermark slot remains untouched
 *      (snapshot is read-only).
 *   3. After the cron evaluator stamps the watermark, the snapshot surfaces
 *      `lastSentAt` and a `nextEligibleAt` exactly 7 days later.
 */
import { describe, it, expect, afterAll, vi } from "vitest";

vi.mock("../mailer.js", async () => ({
  sendBroadcastEmail: vi.fn(async () => undefined),
}));

import {
  db,
  organizationsTable,
  wearableReauthWowAcknowledgmentsTable,
  wellnessSweepRunsTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";

import {
  evaluateWeeklyReauthDrift,
  getWeeklyReauthDriftSnapshot,
  WELLNESS_REAUTH_WOW_RATE_LIMIT_DAYS,
} from "../wearables.js";

const createdOrgIds: number[] = [];
const insertedRunIds: number[] = [];

async function makeOrg(label: string, email: string | null): Promise<number> {
  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const [o] = await db.insert(organizationsTable).values({
    name: `wow-drift-snap-${label}-${stamp}`,
    slug: `wow-drift-snap-${label}-${stamp}`,
    wearableReauthAlertEmail: email,
  }).returning();
  createdOrgIds.push(o.id);
  return o.id;
}

async function seedRuns(window: "this" | "last", needsReauthValues: number[], now: Date): Promise<void> {
  const day = 24 * 60 * 60 * 1000;
  const end = window === "this" ? now.getTime() : now.getTime() - 7 * day;
  for (let i = 0; i < needsReauthValues.length; i++) {
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

afterAll(async () => {
  if (insertedRunIds.length > 0) {
    await db.delete(wellnessSweepRunsTable).where(inArray(wellnessSweepRunsTable.id, insertedRunIds));
  }
  if (createdOrgIds.length > 0) {
    await db.delete(organizationsTable).where(inArray(organizationsTable.id, createdOrgIds));
  }
});

describe("getWeeklyReauthDriftSnapshot — insufficient data", () => {
  it("reports hasSufficientData=false and never trips when fewer than minRuns rows exist", async () => {
    // Distant-past anchor so this test's windows do not overlap with rows
    // seeded by sibling tests in this file or others.
    const now = new Date("2019-01-15T12:00:00Z");
    await seedRuns("this", [10, 10], now);
    const orgId = await makeOrg("insuff", null);

    const snap = await getWeeklyReauthDriftSnapshot(orgId, { now });
    expect(snap.windowDays).toBe(7);
    expect(snap.rateLimitDays).toBe(WELLNESS_REAUTH_WOW_RATE_LIMIT_DAYS);
    expect(snap.thisWeek.runs).toBe(2);
    expect(snap.lastWeek.runs).toBe(0);
    expect(snap.hasSufficientData).toBe(false);
    expect(snap.exceedsThreshold).toBe(false);
    expect(snap.org).not.toBeNull();
    expect(snap.org!.lastSentAt).toBeNull();
    expect(snap.org!.nextEligibleAt).toBeNull();
  });
});

describe("getWeeklyReauthDriftSnapshot — drift above threshold", () => {
  it("computes the same delta the cron evaluator uses and flags exceedsThreshold", async () => {
    const now = new Date("2019-02-15T12:00:00Z");
    const orgId = await makeOrg("above", null);

    // last avg = 1, this avg = 5 → delta 4 ≥ default threshold 1.
    await seedRuns("last", Array(30).fill(1), now);
    await seedRuns("this", Array(30).fill(5), now);

    const snap = await getWeeklyReauthDriftSnapshot(orgId, { now });
    expect(snap.thisWeek.runs).toBe(30);
    expect(snap.lastWeek.runs).toBe(30);
    expect(snap.thisWeek.averageNeedsReauth).toBeCloseTo(5, 5);
    expect(snap.lastWeek.averageNeedsReauth).toBeCloseTo(1, 5);
    expect(snap.delta).toBeCloseTo(4, 5);
    expect(snap.hasSufficientData).toBe(true);
    expect(snap.exceedsThreshold).toBe(true);

    // Snapshot must be read-only — no email, no watermark stamp.
    const [org] = await db.select({
      lastSentAt: organizationsTable.wearableReauthWowAlertLastSentAt,
    }).from(organizationsTable).where(eq(organizationsTable.id, orgId));
    expect(org.lastSentAt).toBeNull();
  });
});

describe("getWeeklyReauthDriftSnapshot — surfaces watermark", () => {
  it("returns lastSentAt + nextEligibleAt (lastSentAt + 7d) once the cron evaluator has stamped", async () => {
    const now = new Date("2019-03-15T12:00:00Z");
    const orgId = await makeOrg("water", "ops+water@example.test");

    await seedRuns("last", Array(30).fill(0), now);
    await seedRuns("this", Array(30).fill(8), now);

    // Run the real evaluator so the watermark is stamped exactly the way
    // the cron path stamps it.
    const evalRes = await evaluateWeeklyReauthDrift({ now });
    expect(evalRes.tripped).toBe(true);

    const snap = await getWeeklyReauthDriftSnapshot(orgId, { now });
    expect(snap.exceedsThreshold).toBe(true);
    expect(snap.org).not.toBeNull();
    expect(snap.org!.lastSentAt).not.toBeNull();
    expect(new Date(snap.org!.lastSentAt!).getTime()).toBe(now.getTime());
    expect(snap.org!.nextEligibleAt).not.toBeNull();
    const expectedNext = now.getTime() + 7 * 24 * 60 * 60 * 1000;
    expect(new Date(snap.org!.nextEligibleAt!).getTime()).toBe(expectedNext);
  });
});

describe("getWeeklyReauthDriftSnapshot — surfaces lastAcknowledgment", () => {
  // Task #1578 — once an admin clicks "Acknowledge / snooze", the most
  // recent ack row should bubble up on the snapshot so the dashboard tile
  // can render the "Acknowledged by X on Y (snoozed N days)" line. The
  // snapshot must read the most recent row only — older rows must not
  // overwrite a fresher acknowledgment.
  it("returns the most recent ack row in org.lastAcknowledgment", async () => {
    const now = new Date("2019-05-15T12:00:00Z");
    const orgId = await makeOrg("ack", null);

    const older = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);
    await db.insert(wearableReauthWowAcknowledgmentsTable).values({
      organizationId: orgId,
      acknowledgedByUserId: null,
      acknowledgedByName: "Older Admin",
      acknowledgedByRole: "org_admin",
      snoozeDays: 3,
      prevWatermark: null,
      newWatermark: new Date(older.getTime() - 4 * 24 * 60 * 60 * 1000),
      createdAt: older,
    });
    const recent = new Date(now.getTime() - 60 * 1000);
    await db.insert(wearableReauthWowAcknowledgmentsTable).values({
      organizationId: orgId,
      acknowledgedByUserId: null,
      acknowledgedByName: "Recent Admin",
      acknowledgedByRole: "tournament_director",
      snoozeDays: 14,
      prevWatermark: null,
      newWatermark: new Date(recent.getTime() + 7 * 24 * 60 * 60 * 1000),
      createdAt: recent,
    });

    const snap = await getWeeklyReauthDriftSnapshot(orgId, { now });
    expect(snap.org).not.toBeNull();
    expect(snap.org!.lastAcknowledgment).not.toBeNull();
    expect(snap.org!.lastAcknowledgment!.acknowledgedByName).toBe("Recent Admin");
    expect(snap.org!.lastAcknowledgment!.acknowledgedByRole).toBe("tournament_director");
    expect(snap.org!.lastAcknowledgment!.snoozeDays).toBe(14);
    expect(new Date(snap.org!.lastAcknowledgment!.acknowledgedAt).getTime()).toBe(recent.getTime());

    // Cleanup the rows we inserted so the table doesn't accumulate
    // cross-test residue (org cascade would also handle it via afterAll,
    // but explicit is friendlier when running the suite repeatedly).
    await db.delete(wearableReauthWowAcknowledgmentsTable)
      .where(eq(wearableReauthWowAcknowledgmentsTable.organizationId, orgId));
  });

  it("returns lastAcknowledgment=null when there are no ack rows", async () => {
    const now = new Date("2019-05-20T12:00:00Z");
    const orgId = await makeOrg("ack-none", null);
    const snap = await getWeeklyReauthDriftSnapshot(orgId, { now });
    expect(snap.org).not.toBeNull();
    expect(snap.org!.lastAcknowledgment).toBeNull();
  });
});

describe("getWeeklyReauthDriftSnapshot — surfaces snoozeCountLast30d (Task #1970)", () => {
  // The runaway-snooze guard counts ack rows in the trailing 30 days so
  // the dashboard can render "snoozed K times in the last 30 days" and
  // the acknowledge endpoint can refuse further clicks. Older rows
  // (>30d) must NOT be counted, which is what makes the cap a sliding
  // window rather than a once-and-forever lockout.
  it("counts only ack rows whose createdAt falls inside the trailing 30-day window", async () => {
    const now = new Date("2019-06-15T12:00:00Z");
    const orgId = await makeOrg("count", null);

    // 3 fresh clicks (within 30d) and 2 ancient clicks (>30d) — the
    // ancient ones must NOT contribute to the count.
    const day = 24 * 60 * 60 * 1000;
    const fresh = [1, 5, 20].map(d => new Date(now.getTime() - d * day));
    const ancient = [31, 45].map(d => new Date(now.getTime() - d * day));
    for (const ts of [...fresh, ...ancient]) {
      await db.insert(wearableReauthWowAcknowledgmentsTable).values({
        organizationId: orgId,
        acknowledgedByUserId: null,
        acknowledgedByName: "Snooze Bot",
        acknowledgedByRole: "org_admin",
        snoozeDays: 7,
        prevWatermark: null,
        newWatermark: new Date(ts.getTime() + 7 * day),
        createdAt: ts,
      });
    }

    const snap = await getWeeklyReauthDriftSnapshot(orgId, { now });
    expect(snap.org).not.toBeNull();
    expect(snap.org!.snoozeCountLast30d).toBe(3);
    // Default cap is 5; absent env override the snapshot must surface it.
    expect(snap.org!.maxSnoozesPer30d).toBe(5);

    await db.delete(wearableReauthWowAcknowledgmentsTable)
      .where(eq(wearableReauthWowAcknowledgmentsTable.organizationId, orgId));
  });

  it("returns snoozeCountLast30d=0 when no ack rows exist", async () => {
    const now = new Date("2019-06-20T12:00:00Z");
    const orgId = await makeOrg("count-zero", null);
    const snap = await getWeeklyReauthDriftSnapshot(orgId, { now });
    expect(snap.org).not.toBeNull();
    expect(snap.org!.snoozeCountLast30d).toBe(0);
    expect(snap.org!.maxSnoozesPer30d).toBe(5);
  });
});

describe("getWeeklyReauthDriftSnapshot — null org", () => {
  it("returns aggregates with org=null when caller has no organization", async () => {
    const now = new Date("2019-04-15T12:00:00Z");
    await seedRuns("this", Array(30).fill(2), now);
    await seedRuns("last", Array(30).fill(2), now);

    const snap = await getWeeklyReauthDriftSnapshot(null, { now });
    expect(snap.org).toBeNull();
    expect(snap.hasSufficientData).toBe(true);
    expect(snap.exceedsThreshold).toBe(false);
  });
});
