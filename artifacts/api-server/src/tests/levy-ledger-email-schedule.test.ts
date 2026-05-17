/**
 * Tests for the scheduled levy-ledger email flow (Task #229 / coverage #279).
 *
 * Covers:
 *   - PUT /levies/:id/email-schedule validation (frequency, bad emails, >20
 *     recipients, empty recipients, levy not found)
 *   - PUT inserts/updates a schedule with a computed nextRunAt
 *   - runOneLevyLedgerEmailSchedule on success: history row inserted with
 *     status='sent', cadence advanced (lastSentAt set, nextRunAt advanced),
 *     mailer called with the right payload
 *   - runOneLevyLedgerEmailSchedule on failure: history row inserted with
 *     status='failed' + errorMessage, cadence still advanced so we don't
 *     spam the broken inbox every poll cycle
 *   - runOneLevyLedgerEmailSchedule when underlying levy is gone: status
 *     'skipped', history row recorded, schedule auto-disabled
 *   - runDueLevyLedgerEmailSchedules picks up only enabled+due rows and
 *     leaves disabled / future-scheduled rows untouched
 *
 * The mailer is mocked so no real SMTP call is attempted. The DB is real
 * (DATABASE_URL) so we exercise the same SQL the production code runs.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

vi.mock("../lib/mailer.js", async () => {
  return {
    sendLevyLedgerScheduleEmail: vi.fn(async () => undefined),
  };
});

import request from "supertest";
import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  clubMembersTable,
  memberLeviesTable,
  levyLedgerEmailSchedulesTable,
  levyLedgerEmailRunsTable,
} from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import { createTestApp, type TestUser } from "./helpers.js";
import {
  runOneLevyLedgerEmailSchedule,
  runDueLevyLedgerEmailSchedules,
  computeLevyLedgerNextRunAt,
} from "../routes/member-360.js";
import { sendLevyLedgerScheduleEmail } from "../lib/mailer.js";

const mailerMock = vi.mocked(sendLevyLedgerScheduleEmail);

let testOrgId: number;
let testUserId: number;
let testMemberId: number;
let admin: TestUser;
let app: ReturnType<typeof createTestApp>;
const levyIds: number[] = [];

const BASE = () => `/api/organizations/${testOrgId}/members-360`;

async function makeLevy(name = "Annual"): Promise<number> {
  const [l] = await db.insert(memberLeviesTable).values({
    organizationId: testOrgId,
    name: `${name}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    amount: "100.00",
    currency: "INR",
    status: "applied",
    appliedAt: new Date(),
  }).returning({ id: memberLeviesTable.id });
  levyIds.push(l.id);
  return l.id;
}

async function fetchSchedule(levyId: number) {
  const [row] = await db.select().from(levyLedgerEmailSchedulesTable)
    .where(and(
      eq(levyLedgerEmailSchedulesTable.organizationId, testOrgId),
      eq(levyLedgerEmailSchedulesTable.levyId, levyId),
    ));
  return row ?? null;
}

async function fetchRuns(scheduleId: number) {
  return db.select().from(levyLedgerEmailRunsTable)
    .where(eq(levyLedgerEmailRunsTable.scheduleId, scheduleId));
}

beforeAll(async () => {
  const stamp = Date.now();
  const [org] = await db.insert(organizationsTable).values({
    name: `TestOrg_LedgerEmail_${stamp}`,
    slug: `test-ledger-email-${stamp}`,
  }).returning({ id: organizationsTable.id });
  testOrgId = org.id;

  const [u] = await db.insert(appUsersTable).values({
    replitUserId: `test-ledger-email-${stamp}`,
    username: `test_ledger_admin_${stamp}`,
    email: `ledger_admin_${stamp}@example.com`,
    displayName: "Ledger Email Admin",
    role: "org_admin",
    organizationId: testOrgId,
  }).returning({ id: appUsersTable.id });
  testUserId = u.id;

  const [m] = await db.insert(clubMembersTable).values({
    organizationId: testOrgId,
    firstName: "Sched",
    lastName: "Tester",
    email: `member_${stamp}@example.com`,
  }).returning({ id: clubMembersTable.id });
  testMemberId = m.id;

  admin = {
    id: testUserId,
    username: `test_ledger_admin_${stamp}`,
    displayName: "Ledger Email Admin",
    role: "org_admin",
    organizationId: testOrgId,
  };
  app = createTestApp(admin);
});

afterAll(async () => {
  // Cascades clean up schedules + runs when the levy / org is gone.
  for (const id of levyIds) {
    await db.delete(memberLeviesTable).where(eq(memberLeviesTable.id, id));
  }
  if (testMemberId) {
    await db.delete(clubMembersTable).where(eq(clubMembersTable.id, testMemberId));
  }
  if (testUserId) {
    await db.delete(appUsersTable).where(eq(appUsersTable.id, testUserId));
  }
  if (testOrgId) {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, testOrgId));
  }
});

beforeEach(() => {
  mailerMock.mockReset();
  mailerMock.mockResolvedValue(undefined);
});

// ─────────────────────────────────────────────────────────────────────────
// PUT validation
// ─────────────────────────────────────────────────────────────────────────
describe("PUT /levies/:id/email-schedule — validation", () => {
  it("rejects invalid frequency", async () => {
    const levyId = await makeLevy();
    const res = await request(app)
      .put(`${BASE()}/levies/${levyId}/email-schedule`)
      .send({ frequency: "yearly", recipients: ["t@example.com"] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/frequency/);
  });

  it("rejects empty recipients", async () => {
    const levyId = await makeLevy();
    const res = await request(app)
      .put(`${BASE()}/levies/${levyId}/email-schedule`)
      .send({ frequency: "weekly", recipients: [] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/recipient/);
  });

  it("rejects malformed recipient email", async () => {
    const levyId = await makeLevy();
    const res = await request(app)
      .put(`${BASE()}/levies/${levyId}/email-schedule`)
      .send({ frequency: "weekly", recipients: ["t@example.com", "not-an-email"] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid recipient email/);
  });

  it("rejects more than 20 recipients", async () => {
    const levyId = await makeLevy();
    const recipients = Array.from({ length: 21 }, (_, i) => `r${i}@example.com`);
    const res = await request(app)
      .put(`${BASE()}/levies/${levyId}/email-schedule`)
      .send({ frequency: "weekly", recipients });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/20 recipients/);
  });

  it("returns 404 when the levy doesn't exist for this org", async () => {
    const res = await request(app)
      .put(`${BASE()}/levies/9999999/email-schedule`)
      .send({ frequency: "weekly", recipients: ["t@example.com"] });
    expect(res.status).toBe(404);
  });

  it("creates a schedule with computed nextRunAt and dedupes recipients", async () => {
    const levyId = await makeLevy();
    const res = await request(app)
      .put(`${BASE()}/levies/${levyId}/email-schedule`)
      .send({
        frequency: "weekly",
        recipients: ["a@example.com", "b@example.com", "a@example.com", "  "],
      });
    expect(res.status).toBe(200);
    const sched = res.body.schedule;
    expect(sched.frequency).toBe("weekly");
    expect(sched.enabled).toBe(true);
    expect(sched.recipients).toEqual(["a@example.com", "b@example.com"]);
    expect(new Date(sched.nextRunAt).getTime()).toBeGreaterThan(Date.now());
    // Computed nextRunAt is anchored to 07:00 UTC.
    expect(new Date(sched.nextRunAt).getUTCHours()).toBe(7);
  });

  it("recomputes nextRunAt when frequency changes; preserves it otherwise", async () => {
    const levyId = await makeLevy();
    // First create with weekly.
    let res = await request(app)
      .put(`${BASE()}/levies/${levyId}/email-schedule`)
      .send({ frequency: "weekly", recipients: ["a@example.com"] });
    expect(res.status).toBe(200);
    const firstNextRun = new Date(res.body.schedule.nextRunAt).getTime();

    // Same frequency, different recipients → nextRunAt is preserved.
    res = await request(app)
      .put(`${BASE()}/levies/${levyId}/email-schedule`)
      .send({ frequency: "weekly", recipients: ["b@example.com"] });
    expect(res.status).toBe(200);
    expect(new Date(res.body.schedule.nextRunAt).getTime()).toBe(firstNextRun);
    expect(res.body.schedule.recipients).toEqual(["b@example.com"]);

    // Frequency change → nextRunAt is recomputed (monthly is much further out).
    res = await request(app)
      .put(`${BASE()}/levies/${levyId}/email-schedule`)
      .send({ frequency: "monthly", recipients: ["b@example.com"] });
    expect(res.status).toBe(200);
    expect(new Date(res.body.schedule.nextRunAt).getTime()).not.toBe(firstNextRun);
    expect(res.body.schedule.frequency).toBe("monthly");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// computeLevyLedgerNextRunAt
// ─────────────────────────────────────────────────────────────────────────
describe("computeLevyLedgerNextRunAt", () => {
  it("advances by 7 days for weekly and anchors to 07:00 UTC", () => {
    const from = new Date(Date.UTC(2026, 0, 1, 12, 34, 56));
    const next = computeLevyLedgerNextRunAt("weekly", from);
    expect(next.getUTCDate()).toBe(8);
    expect(next.getUTCHours()).toBe(7);
    expect(next.getUTCMinutes()).toBe(0);
  });

  it("advances by one month for monthly and anchors to 07:00 UTC", () => {
    const from = new Date(Date.UTC(2026, 0, 15, 23, 59, 59));
    const next = computeLevyLedgerNextRunAt("monthly", from);
    expect(next.getUTCMonth()).toBe(1); // February
    expect(next.getUTCDate()).toBe(15);
    expect(next.getUTCHours()).toBe(7);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// runOneLevyLedgerEmailSchedule — success
// ─────────────────────────────────────────────────────────────────────────
describe("runOneLevyLedgerEmailSchedule — success", () => {
  it("sends the email, records a 'sent' history row, and advances cadence", async () => {
    const levyId = await makeLevy();
    const putRes = await request(app)
      .put(`${BASE()}/levies/${levyId}/email-schedule`)
      .send({ frequency: "weekly", recipients: ["treasurer@example.com"] });
    expect(putRes.status).toBe(200);
    const scheduleId = putRes.body.schedule.id as number;

    const before = await fetchSchedule(levyId);
    expect(before).not.toBeNull();
    expect(before!.lastSentAt).toBeNull();

    const result = await runOneLevyLedgerEmailSchedule(scheduleId);
    expect(result.status).toBe("sent");
    expect(result.recipients).toEqual(["treasurer@example.com"]);

    expect(mailerMock).toHaveBeenCalledTimes(1);
    const arg = mailerMock.mock.calls[0][0];
    expect(arg.to).toEqual(["treasurer@example.com"]);
    expect(arg.frequency).toBe("weekly");
    expect(typeof arg.csv).toBe("string");
    expect(arg.csv.split("\n")[0]).toContain("date"); // CSV header

    const runs = await fetchRuns(scheduleId);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("sent");
    expect(runs[0].errorMessage).toBeNull();
    expect(runs[0].recipients).toEqual(["treasurer@example.com"]);

    const after = await fetchSchedule(levyId);
    expect(after!.lastSentAt).not.toBeNull();
    expect(after!.enabled).toBe(true);
    // nextRunAt advanced ~7 days into the future from the run.
    expect(new Date(after!.nextRunAt).getTime()).toBeGreaterThan(Date.now() + 6 * 24 * 60 * 60 * 1000);
    expect(new Date(after!.nextRunAt).getUTCHours()).toBe(7);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// runOneLevyLedgerEmailSchedule — failure
// ─────────────────────────────────────────────────────────────────────────
describe("runOneLevyLedgerEmailSchedule — failure", () => {
  it("records 'failed' with errorMessage but still advances the cadence", async () => {
    mailerMock.mockRejectedValueOnce(new Error("smtp blew up"));

    const levyId = await makeLevy();
    const putRes = await request(app)
      .put(`${BASE()}/levies/${levyId}/email-schedule`)
      .send({ frequency: "monthly", recipients: ["t@example.com"] });
    const scheduleId = putRes.body.schedule.id as number;

    const result = await runOneLevyLedgerEmailSchedule(scheduleId);
    expect(result.status).toBe("failed");
    expect(result.errorMessage).toBe("smtp blew up");

    const runs = await fetchRuns(scheduleId);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("failed");
    expect(runs[0].errorMessage).toBe("smtp blew up");

    // Cadence still advances so we don't hammer a broken inbox every poll.
    const after = await fetchSchedule(levyId);
    expect(after!.lastSentAt).not.toBeNull();
    expect(new Date(after!.nextRunAt).getTime()).toBeGreaterThan(Date.now() + 25 * 24 * 60 * 60 * 1000);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// runOneLevyLedgerEmailSchedule — underlying levy deleted
// ─────────────────────────────────────────────────────────────────────────
describe("runOneLevyLedgerEmailSchedule — underlying levy deleted", () => {
  it("auto-disables the schedule and records a 'skipped' history row", async () => {
    const levyId = await makeLevy();
    const putRes = await request(app)
      .put(`${BASE()}/levies/${levyId}/email-schedule`)
      .send({ frequency: "weekly", recipients: ["t@example.com"] });
    const scheduleId = putRes.body.schedule.id as number;

    // The FK from levy_ledger_email_schedules.levy_id to member_levies(id) is
    // ON DELETE CASCADE, so deleting the levy normally wipes the schedule too.
    // We bypass triggers/FKs to simulate the defensive code path that handles
    // a schedule whose underlying levy has gone missing.
    await db.execute(sql`SET session_replication_role = 'replica'`);
    try {
      await db.execute(sql`DELETE FROM member_levies WHERE id = ${levyId}`);
    } finally {
      await db.execute(sql`SET session_replication_role = 'origin'`);
    }
    // Drop the bookkeeping id since we just hard-deleted the row.
    const idx = levyIds.indexOf(levyId);
    if (idx >= 0) levyIds.splice(idx, 1);

    const result = await runOneLevyLedgerEmailSchedule(scheduleId);
    expect(result.status).toBe("skipped");
    expect(result.errorMessage).toBe("underlying levy was deleted");
    expect(mailerMock).not.toHaveBeenCalled();

    const [sched] = await db.select().from(levyLedgerEmailSchedulesTable)
      .where(eq(levyLedgerEmailSchedulesTable.id, scheduleId));
    expect(sched.enabled).toBe(false);

    const runs = await fetchRuns(scheduleId);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("skipped");
    expect(runs[0].errorMessage).toBe("underlying levy was deleted");

    // Cleanup the orphaned schedule (cascade is broken because the parent is gone).
    await db.delete(levyLedgerEmailSchedulesTable)
      .where(eq(levyLedgerEmailSchedulesTable.id, scheduleId));
  });
});

// ─────────────────────────────────────────────────────────────────────────
// runDueLevyLedgerEmailSchedules — selection
// ─────────────────────────────────────────────────────────────────────────
describe("runDueLevyLedgerEmailSchedules — selection", () => {
  it("processes only enabled schedules whose nextRunAt has elapsed", async () => {
    const dueLevyId = await makeLevy("due");
    const futureLevyId = await makeLevy("future");
    const disabledLevyId = await makeLevy("disabled");

    const past = new Date(Date.now() - 60 * 60 * 1000);
    const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    const [dueSched] = await db.insert(levyLedgerEmailSchedulesTable).values({
      organizationId: testOrgId, levyId: dueLevyId,
      frequency: "weekly", recipients: ["due@example.com"],
      enabled: true, nextRunAt: past,
    }).returning();

    const [futureSched] = await db.insert(levyLedgerEmailSchedulesTable).values({
      organizationId: testOrgId, levyId: futureLevyId,
      frequency: "weekly", recipients: ["future@example.com"],
      enabled: true, nextRunAt: future,
    }).returning();

    const [disabledSched] = await db.insert(levyLedgerEmailSchedulesTable).values({
      organizationId: testOrgId, levyId: disabledLevyId,
      frequency: "weekly", recipients: ["disabled@example.com"],
      enabled: false, nextRunAt: past,
    }).returning();

    await runDueLevyLedgerEmailSchedules();

    expect(mailerMock).toHaveBeenCalledTimes(1);
    expect(mailerMock.mock.calls[0][0].to).toEqual(["due@example.com"]);

    const dueRuns = await fetchRuns(dueSched.id);
    expect(dueRuns).toHaveLength(1);
    expect(dueRuns[0].status).toBe("sent");

    const futureRuns = await fetchRuns(futureSched.id);
    expect(futureRuns).toHaveLength(0);

    const disabledRuns = await fetchRuns(disabledSched.id);
    expect(disabledRuns).toHaveLength(0);

    // Future schedule should be untouched.
    const futureAfter = await fetchSchedule(futureLevyId);
    expect(futureAfter!.lastSentAt).toBeNull();
    expect(new Date(futureAfter!.nextRunAt).getTime()).toBe(future.getTime());

    // Disabled schedule should still be disabled and untouched.
    const disabledAfter = await fetchSchedule(disabledLevyId);
    expect(disabledAfter!.enabled).toBe(false);
    expect(disabledAfter!.lastSentAt).toBeNull();
  });
});
