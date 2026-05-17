/**
 * Tests for the club-wide ledger digest cron (Task #278 / coverage Task #323).
 *
 * Task #278 introduced `runOneOrgLevyLedgerEmailSchedule` and
 * `runDueOrgLevyLedgerEmailSchedules` plus the `/levy-ledger/email-schedule`
 * HTTP surface. The delivery-format test (Task #322 / #390) already covers
 * the per-levy ZIP attachment shape, so this file pins down the orthogonal
 * concerns the digest cadence depends on:
 *
 *   - RBAC on every endpoint (GET / PUT / DELETE / send-now): unauthenticated
 *     callers get 401, non-admin callers get 403, treasurers/org_admins pass.
 *   - Recipient validation rejects empty / malformed / >20 / blank-only inputs.
 *   - `runOneOrgLevyLedgerEmailSchedule` on success: a combined CSV is built,
 *     `rowCount` equals the actual data rows in the CSV, `levyCount` equals
 *     the number of distinct levies that had events in the period, a
 *     'sent' history row is recorded, and the cadence advances (lastSentAt
 *     set, nextRunAt rolled forward by the right interval, anchored 07:00 UTC).
 *   - Failure path (mailer rejects): history records 'failed' + error
 *     message but the cadence still advances so we don't hammer a broken
 *     inbox every poll cycle.
 *   - Skipped path (no recipients): logged as 'skipped' with the reason,
 *     no email sent, cadence NOT advanced.
 *   - `runDueOrgLevyLedgerEmailSchedules` only processes enabled schedules
 *     whose `next_run_at` has elapsed — paused (enabled=false) and
 *     future-scheduled rows are left strictly untouched, even when one of
 *     the due rows raises so the loop's try/catch absorbs it.
 *
 * The mailer is mocked so no real SMTP call is attempted; the DB is real
 * (DATABASE_URL) so we exercise the same SQL the production code runs.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

vi.mock("../lib/mailer.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/mailer.js")>("../lib/mailer.js");
  return {
    ...actual,
    sendOrgLevyLedgerScheduleEmail: vi.fn(async () => undefined),
  };
});

import request from "supertest";
import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  orgMembershipsTable,
  clubMembersTable,
  memberLeviesTable,
  memberLevyChargesTable,
  memberLevyChargeEventsTable,
  levyLedgerEmailOrgSchedulesTable,
  levyLedgerEmailOrgRunsTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { createTestApp, type TestUser } from "./helpers.js";
import {
  runOneOrgLevyLedgerEmailSchedule,
  runDueOrgLevyLedgerEmailSchedules,
} from "../routes/member-360.js";
import { sendOrgLevyLedgerScheduleEmail, buildOrgLevyLedgerScheduleEmailContent } from "../lib/mailer.js";

const mailerMock = vi.mocked(sendOrgLevyLedgerScheduleEmail);

let testOrgId: number;
let otherOrgId: number;
let adminUserId: number;
let outsiderUserId: number;
let treasurerUserId: number;
let memberId: number;
let admin: TestUser;
let outsider: TestUser;
let treasurer: TestUser;
let appAsAdmin: ReturnType<typeof createTestApp>;
let appAsOutsider: ReturnType<typeof createTestApp>;
let appAsTreasurer: ReturnType<typeof createTestApp>;
let appAnonymous: ReturnType<typeof createTestApp>;
const levyIds: number[] = [];
const chargeIds: number[] = [];

const BASE = () => `/api/organizations/${testOrgId}/members-360`;

async function makeLevy(name: string): Promise<number> {
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

async function makeChargeWithPayment(levyId: number, amount = "50.00") {
  const [charge] = await db.insert(memberLevyChargesTable).values({
    levyId,
    clubMemberId: memberId,
    amount,
    status: "paid",
    paid: true,
    paidAmount: amount,
    paidAt: new Date(),
  }).returning({ id: memberLevyChargesTable.id });
  chargeIds.push(charge.id);
  await db.insert(memberLevyChargeEventsTable).values({
    organizationId: testOrgId,
    clubMemberId: memberId,
    chargeId: charge.id,
    eventType: "payment",
    amount,
    method: "cash",
    occurredAt: new Date(),
  });
  return charge.id;
}

async function clearActivity() {
  if (chargeIds.length) {
    await db.delete(memberLevyChargesTable)
      .where(inArray(memberLevyChargesTable.id, chargeIds));
    chargeIds.length = 0;
  }
  await db.delete(levyLedgerEmailOrgSchedulesTable)
    .where(eq(levyLedgerEmailOrgSchedulesTable.organizationId, testOrgId));
}

beforeAll(async () => {
  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const [org] = await db.insert(organizationsTable).values({
    name: `TestOrg_OrgLedgerCron_${stamp}`,
    slug: `test-org-ledger-cron-${stamp}`,
  }).returning({ id: organizationsTable.id });
  testOrgId = org.id;

  // A second, unrelated org so we can build an "outsider" user whose org_admin
  // role applies to the wrong org — exercising the RBAC org-scope check.
  const [otherOrg] = await db.insert(organizationsTable).values({
    name: `TestOrg_OrgLedgerCron_Other_${stamp}`,
    slug: `test-org-ledger-cron-other-${stamp}`,
  }).returning({ id: organizationsTable.id });
  otherOrgId = otherOrg.id;

  const [a] = await db.insert(appUsersTable).values({
    replitUserId: `test-org-ledger-cron-admin-${stamp}`,
    username: `org_ledger_cron_admin_${stamp}`,
    email: `cron_admin_${stamp}@example.com`,
    displayName: "Cron Admin",
    role: "org_admin",
    organizationId: testOrgId,
  }).returning({ id: appUsersTable.id });
  adminUserId = a.id;

  const [o] = await db.insert(appUsersTable).values({
    replitUserId: `test-org-ledger-cron-outsider-${stamp}`,
    username: `org_ledger_cron_outsider_${stamp}`,
    email: `cron_outsider_${stamp}@example.com`,
    displayName: "Cron Outsider",
    role: "org_admin",
    organizationId: otherOrgId,
  }).returning({ id: appUsersTable.id });
  outsiderUserId = o.id;

  // Treasurer: a user whose top-level role is just "player" but who has an
  // org_memberships row granting `treasurer` for the test org. Exercises the
  // membership-based RBAC branch in `requireMemberAdmin`.
  const [t] = await db.insert(appUsersTable).values({
    replitUserId: `test-org-ledger-cron-treasurer-${stamp}`,
    username: `org_ledger_cron_treasurer_${stamp}`,
    email: `cron_treasurer_${stamp}@example.com`,
    displayName: "Cron Treasurer",
    role: "player",
    organizationId: testOrgId,
  }).returning({ id: appUsersTable.id });
  treasurerUserId = t.id;
  await db.insert(orgMembershipsTable).values({
    organizationId: testOrgId,
    userId: treasurerUserId,
    role: "treasurer",
  });

  const [m] = await db.insert(clubMembersTable).values({
    organizationId: testOrgId,
    firstName: "Cron",
    lastName: "Tester",
    email: `cron_member_${stamp}@example.com`,
  }).returning({ id: clubMembersTable.id });
  memberId = m.id;

  admin = {
    id: adminUserId,
    username: `org_ledger_cron_admin_${stamp}`,
    displayName: "Cron Admin",
    role: "org_admin",
    organizationId: testOrgId,
  };
  outsider = {
    id: outsiderUserId,
    username: `org_ledger_cron_outsider_${stamp}`,
    displayName: "Cron Outsider",
    // Real org_admin role but for the OTHER org — `requireMemberAdmin` should
    // reject because user.organizationId !== orgId in the URL and there's no
    // matching org_memberships row for the test org.
    role: "org_admin",
    organizationId: otherOrgId,
  };
  treasurer = {
    id: treasurerUserId,
    username: `org_ledger_cron_treasurer_${stamp}`,
    displayName: "Cron Treasurer",
    role: "player",
    organizationId: testOrgId,
  };
  appAsAdmin = createTestApp(admin);
  appAsOutsider = createTestApp(outsider);
  appAsTreasurer = createTestApp(treasurer);
  appAnonymous = createTestApp();
});

afterAll(async () => {
  for (const id of levyIds) {
    await db.delete(memberLeviesTable).where(eq(memberLeviesTable.id, id));
  }
  if (memberId) {
    await db.delete(clubMembersTable).where(eq(clubMembersTable.id, memberId));
  }
  if (adminUserId) {
    await db.delete(appUsersTable).where(eq(appUsersTable.id, adminUserId));
  }
  if (outsiderUserId) {
    await db.delete(appUsersTable).where(eq(appUsersTable.id, outsiderUserId));
  }
  if (treasurerUserId) {
    // Cascade wipes the org_memberships row when the user goes.
    await db.delete(appUsersTable).where(eq(appUsersTable.id, treasurerUserId));
  }
  if (testOrgId) {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, testOrgId));
  }
  if (otherOrgId) {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, otherOrgId));
  }
});

beforeEach(async () => {
  mailerMock.mockReset();
  mailerMock.mockResolvedValue(undefined);
  await clearActivity();
});

// ─────────────────────────────────────────────────────────────────────────
// RBAC on the org schedule endpoints
// ─────────────────────────────────────────────────────────────────────────
describe("RBAC — /levy-ledger/email-schedule", () => {
  it("rejects unauthenticated callers with 401 on every endpoint", async () => {
    const get = await request(appAnonymous).get(`${BASE()}/levy-ledger/email-schedule`);
    expect(get.status).toBe(401);

    const put = await request(appAnonymous)
      .put(`${BASE()}/levy-ledger/email-schedule`)
      .send({ frequency: "weekly", recipients: ["t@example.com"] });
    expect(put.status).toBe(401);

    const del = await request(appAnonymous).delete(`${BASE()}/levy-ledger/email-schedule`);
    expect(del.status).toBe(401);

    const send = await request(appAnonymous).post(`${BASE()}/levy-ledger/email-schedule/send-now`);
    expect(send.status).toBe(401);
  });

  it("rejects non-admin callers (wrong-org admin) with 403 on every endpoint", async () => {
    const get = await request(appAsOutsider).get(`${BASE()}/levy-ledger/email-schedule`);
    expect(get.status).toBe(403);

    const put = await request(appAsOutsider)
      .put(`${BASE()}/levy-ledger/email-schedule`)
      .send({ frequency: "weekly", recipients: ["t@example.com"] });
    expect(put.status).toBe(403);

    const del = await request(appAsOutsider).delete(`${BASE()}/levy-ledger/email-schedule`);
    expect(del.status).toBe(403);

    const send = await request(appAsOutsider).post(`${BASE()}/levy-ledger/email-schedule/send-now`);
    expect(send.status).toBe(403);
  });

  it("allows the org_admin to create, fetch, send-now, and delete the schedule", async () => {
    const put = await request(appAsAdmin)
      .put(`${BASE()}/levy-ledger/email-schedule`)
      .send({ frequency: "weekly", recipients: ["treasurer@example.com"] });
    expect(put.status).toBe(200);

    const get = await request(appAsAdmin).get(`${BASE()}/levy-ledger/email-schedule`);
    expect(get.status).toBe(200);
    expect(get.body.schedule).not.toBeNull();
    expect(Array.isArray(get.body.history)).toBe(true);

    const send = await request(appAsAdmin).post(`${BASE()}/levy-ledger/email-schedule/send-now`);
    expect(send.status).toBe(200);
    expect(["sent", "skipped"]).toContain(send.body.status);

    const del = await request(appAsAdmin).delete(`${BASE()}/levy-ledger/email-schedule`);
    expect(del.status).toBe(200);
    expect(del.body.ok).toBe(true);

    const after = await request(appAsAdmin).get(`${BASE()}/levy-ledger/email-schedule`);
    expect(after.status).toBe(200);
    expect(after.body.schedule).toBeNull();
  });

  it("allows a treasurer (org_memberships role) on every endpoint", async () => {
    // PUT — treasurer can create the schedule.
    const put = await request(appAsTreasurer)
      .put(`${BASE()}/levy-ledger/email-schedule`)
      .send({ frequency: "weekly", recipients: ["treasurer@example.com"] });
    expect(put.status).toBe(200);

    // GET — treasurer can read the schedule + history.
    const get = await request(appAsTreasurer).get(`${BASE()}/levy-ledger/email-schedule`);
    expect(get.status).toBe(200);
    expect(get.body.schedule).not.toBeNull();
    expect(Array.isArray(get.body.history)).toBe(true);

    // send-now — treasurer can trigger an immediate run.
    const send = await request(appAsTreasurer).post(`${BASE()}/levy-ledger/email-schedule/send-now`);
    expect(send.status).toBe(200);
    expect(["sent", "skipped"]).toContain(send.body.status);

    // DELETE — treasurer can remove the schedule.
    const del = await request(appAsTreasurer).delete(`${BASE()}/levy-ledger/email-schedule`);
    expect(del.status).toBe(200);
    expect(del.body.ok).toBe(true);
  });

  it("returns 404 from send-now when no schedule has been configured yet", async () => {
    const send = await request(appAsAdmin).post(`${BASE()}/levy-ledger/email-schedule/send-now`);
    expect(send.status).toBe(404);
    expect(send.body.error).toMatch(/schedule/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// PUT recipient validation
// ─────────────────────────────────────────────────────────────────────────
describe("PUT /levy-ledger/email-schedule — recipient validation", () => {
  it("rejects an empty recipient list", async () => {
    const res = await request(appAsAdmin)
      .put(`${BASE()}/levy-ledger/email-schedule`)
      .send({ frequency: "weekly", recipients: [] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/recipient/i);
  });

  it("rejects a recipient list of only whitespace strings", async () => {
    const res = await request(appAsAdmin)
      .put(`${BASE()}/levy-ledger/email-schedule`)
      .send({ frequency: "weekly", recipients: ["  ", "\t", ""] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/recipient/i);
  });

  it("rejects malformed recipient emails", async () => {
    const res = await request(appAsAdmin)
      .put(`${BASE()}/levy-ledger/email-schedule`)
      .send({ frequency: "weekly", recipients: ["ok@example.com", "not-an-email"] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid recipient email/);
  });

  it("rejects more than 20 recipients", async () => {
    const recipients = Array.from({ length: 21 }, (_, i) => `r${i}@example.com`);
    const res = await request(appAsAdmin)
      .put(`${BASE()}/levy-ledger/email-schedule`)
      .send({ frequency: "weekly", recipients });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/20 recipients/);
  });

  it("dedupes recipients and trims whitespace, persisting the cleaned list", async () => {
    const res = await request(appAsAdmin)
      .put(`${BASE()}/levy-ledger/email-schedule`)
      .send({
        frequency: "weekly",
        recipients: ["a@example.com", "b@example.com", "a@example.com", "  "],
      });
    expect(res.status).toBe(200);
    expect(res.body.schedule.recipients).toEqual(["a@example.com", "b@example.com"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// runOneOrgLevyLedgerEmailSchedule — success path
// ─────────────────────────────────────────────────────────────────────────
describe("runOneOrgLevyLedgerEmailSchedule — success", () => {
  it("counts CSV rows + distinct levies and advances the weekly cadence", async () => {
    // Seed three levies, two with activity in the period and one without — so
    // levyCount should be 2 (the one with no charges is excluded).
    const levyA = await makeLevy("Annual");
    const levyB = await makeLevy("Range");
    await makeLevy("Quiet"); // no charges → not in the period
    await makeChargeWithPayment(levyA, "50.00");
    await makeChargeWithPayment(levyB, "25.00");

    const putRes = await request(appAsAdmin)
      .put(`${BASE()}/levy-ledger/email-schedule`)
      .send({ frequency: "weekly", recipients: ["treasurer@example.com"] });
    expect(putRes.status).toBe(200);
    const scheduleId = putRes.body.schedule.id as number;

    const result = await runOneOrgLevyLedgerEmailSchedule(scheduleId);
    expect(result.status).toBe("sent");
    expect(result.recipients).toEqual(["treasurer@example.com"]);
    expect(result.levyCount).toBe(2);
    // Two charges across two levies → two payment events → two CSV data rows.
    expect(result.rowCount).toBe(2);

    expect(mailerMock).toHaveBeenCalledTimes(1);
    const arg = mailerMock.mock.calls[0][0];
    expect(arg.to).toEqual(["treasurer@example.com"]);
    expect(arg.frequency).toBe("weekly");
    expect(arg.levyCount).toBe(2);
    expect(arg.rowCount).toBe(2);
    expect(typeof arg.csv).toBe("string");
    // Header + 2 data rows; trailing newline may add an empty entry.
    const lines = (arg.csv as string).split(/\r?\n/).filter((l) => l.length > 0);
    expect(lines.length).toBe(1 + 2);

    // History row records the run accurately.
    const [run] = await db.select().from(levyLedgerEmailOrgRunsTable)
      .where(eq(levyLedgerEmailOrgRunsTable.scheduleId, scheduleId));
    expect(run.status).toBe("sent");
    expect(run.errorMessage).toBeNull();
    expect(run.rowCount).toBe(2);
    expect(run.levyCount).toBe(2);
    expect(run.recipients).toEqual(["treasurer@example.com"]);

    // Cadence advanced ~7 days into the future, anchored to 07:00 UTC.
    const [sched] = await db.select().from(levyLedgerEmailOrgSchedulesTable)
      .where(eq(levyLedgerEmailOrgSchedulesTable.id, scheduleId));
    expect(sched.lastSentAt).not.toBeNull();
    expect(new Date(sched.nextRunAt!).getTime()).toBeGreaterThan(Date.now() + 6 * 24 * 60 * 60 * 1000);
    expect(new Date(sched.nextRunAt!).getUTCHours()).toBe(7);
  });

  it("advances the monthly cadence by ~30 days on success", async () => {
    const levyA = await makeLevy("Membership");
    await makeChargeWithPayment(levyA);

    const putRes = await request(appAsAdmin)
      .put(`${BASE()}/levy-ledger/email-schedule`)
      .send({ frequency: "monthly", recipients: ["treasurer@example.com"] });
    const scheduleId = putRes.body.schedule.id as number;

    const result = await runOneOrgLevyLedgerEmailSchedule(scheduleId);
    expect(result.status).toBe("sent");

    const [sched] = await db.select().from(levyLedgerEmailOrgSchedulesTable)
      .where(eq(levyLedgerEmailOrgSchedulesTable.id, scheduleId));
    // Roughly 28+ days out (handles month-length variance).
    expect(new Date(sched.nextRunAt!).getTime()).toBeGreaterThan(Date.now() + 27 * 24 * 60 * 60 * 1000);
    expect(new Date(sched.nextRunAt!).getUTCHours()).toBe(7);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// runOneOrgLevyLedgerEmailSchedule — failure path
// ─────────────────────────────────────────────────────────────────────────
describe("runOneOrgLevyLedgerEmailSchedule — failure", () => {
  it("records 'failed' with the error and STILL advances the cadence", async () => {
    mailerMock.mockRejectedValueOnce(new Error("smtp blew up"));

    const levyA = await makeLevy("Annual");
    await makeChargeWithPayment(levyA);

    const putRes = await request(appAsAdmin)
      .put(`${BASE()}/levy-ledger/email-schedule`)
      .send({ frequency: "monthly", recipients: ["t@example.com"] });
    const scheduleId = putRes.body.schedule.id as number;

    const result = await runOneOrgLevyLedgerEmailSchedule(scheduleId);
    expect(result.status).toBe("failed");
    expect(result.errorMessage).toBe("smtp blew up");

    const [run] = await db.select().from(levyLedgerEmailOrgRunsTable)
      .where(eq(levyLedgerEmailOrgRunsTable.scheduleId, scheduleId));
    expect(run.status).toBe("failed");
    expect(run.errorMessage).toBe("smtp blew up");

    const [sched] = await db.select().from(levyLedgerEmailOrgSchedulesTable)
      .where(eq(levyLedgerEmailOrgSchedulesTable.id, scheduleId));
    expect(sched.lastSentAt).not.toBeNull();
    // Monthly cadence still advances ~30 days even on failure.
    expect(new Date(sched.nextRunAt!).getTime()).toBeGreaterThan(Date.now() + 27 * 24 * 60 * 60 * 1000);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// runOneOrgLevyLedgerEmailSchedule — skipped path
// ─────────────────────────────────────────────────────────────────────────
describe("runOneOrgLevyLedgerEmailSchedule — skipped (no recipients)", () => {
  it("records 'skipped', does not call the mailer, and does NOT advance cadence", async () => {
    // Insert a schedule directly with an empty recipients list — bypasses
    // the PUT validation that would otherwise reject it. Models the case
    // where recipients were emptied out-of-band (e.g. an admin tool).
    const past = new Date(Date.now() - 60 * 60 * 1000);
    const [row] = await db.insert(levyLedgerEmailOrgSchedulesTable).values({
      organizationId: testOrgId,
      frequency: "weekly",
      recipients: [],
      enabled: true,
      deliveryFormat: "combined",
      nextRunAt: past,
    }).returning();

    const result = await runOneOrgLevyLedgerEmailSchedule(row.id);
    expect(result.status).toBe("skipped");
    expect(result.errorMessage).toMatch(/no recipients/i);
    expect(mailerMock).not.toHaveBeenCalled();

    const [run] = await db.select().from(levyLedgerEmailOrgRunsTable)
      .where(eq(levyLedgerEmailOrgRunsTable.scheduleId, row.id));
    expect(run.status).toBe("skipped");
    expect(run.errorMessage).toMatch(/no recipients/i);

    // Cadence is NOT advanced for skipped runs — lastSentAt stays null and
    // nextRunAt remains the original past timestamp so the next poll picks
    // it up again once recipients are re-added.
    const [sched] = await db.select().from(levyLedgerEmailOrgSchedulesTable)
      .where(eq(levyLedgerEmailOrgSchedulesTable.id, row.id));
    expect(sched.lastSentAt).toBeNull();
    expect(new Date(sched.nextRunAt!).getTime()).toBe(past.getTime());
  });

  it("returns 'skipped' for a missing schedule id without throwing", async () => {
    const result = await runOneOrgLevyLedgerEmailSchedule(999_999_999);
    expect(result.status).toBe("skipped");
    expect(result.errorMessage).toMatch(/not found/i);
    expect(mailerMock).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// GET /levy-ledger/email-schedule/preview (Task #957 / coverage Task #1112)
// ─────────────────────────────────────────────────────────────────────────
describe("GET /levy-ledger/email-schedule/preview", () => {
  it("returns subject/html/row+levy counts identical to the real send path, without mailing or recording a run", async () => {
    // Seed two levies with activity in the period and one quiet one — should
    // give levyCount=2, rowCount=2 just like the success-path test above.
    const levyA = await makeLevy("Preview-A");
    const levyB = await makeLevy("Preview-B");
    await makeLevy("Preview-Quiet");
    await makeChargeWithPayment(levyA, "75.00");
    await makeChargeWithPayment(levyB, "20.00");

    const putRes = await request(appAsAdmin)
      .put(`${BASE()}/levy-ledger/email-schedule`)
      .send({ frequency: "weekly", recipients: ["treasurer@example.com"] });
    expect(putRes.status).toBe(200);
    const scheduleId = putRes.body.schedule.id as number;

    // Hit the preview FIRST so it sees the same activity the real send will,
    // and so we can assert the mailer + history side-effects are still pristine.
    const preview = await request(appAsAdmin).get(`${BASE()}/levy-ledger/email-schedule/preview`);
    expect(preview.status).toBe(200);

    // Mailer is NOT touched by the preview.
    expect(mailerMock).not.toHaveBeenCalled();

    // No history row was inserted by the preview.
    const runsAfterPreview = await db.select().from(levyLedgerEmailOrgRunsTable)
      .where(eq(levyLedgerEmailOrgRunsTable.scheduleId, scheduleId));
    expect(runsAfterPreview).toHaveLength(0);

    // Schedule cadence untouched by the preview (lastSentAt still null).
    const [schedAfterPreview] = await db.select().from(levyLedgerEmailOrgSchedulesTable)
      .where(eq(levyLedgerEmailOrgSchedulesTable.id, scheduleId));
    expect(schedAfterPreview.lastSentAt).toBeNull();

    // Now actually run the send so we can compare what would have been sent
    // against what the preview reported. Preview and run are evaluated within
    // the same UTC day, so the formatted period strings + date-stamped
    // filenames are byte-identical.
    const result = await runOneOrgLevyLedgerEmailSchedule(scheduleId);
    expect(result.status).toBe("sent");
    expect(result.rowCount).toBe(2);
    expect(result.levyCount).toBe(2);

    // Counts match between preview and the real send path.
    expect(preview.body.rowCount).toBe(result.rowCount);
    expect(preview.body.levyCount).toBe(result.levyCount);
    expect(preview.body.deliveryFormat).toBe(result.deliveryFormat);
    expect(preview.body.recipients).toEqual(result.recipients);
    expect(preview.body.frequency).toBe("weekly");

    // Subject + html + filenames match what the mailer was actually invoked with.
    expect(mailerMock).toHaveBeenCalledTimes(1);
    const mailerArg = mailerMock.mock.calls[0][0];
    const expected = buildOrgLevyLedgerScheduleEmailContent({
      orgName: mailerArg.orgName,
      frequency: mailerArg.frequency,
      periodStart: mailerArg.periodStart,
      periodEnd: mailerArg.periodEnd,
      rowCount: mailerArg.rowCount,
      levyCount: mailerArg.levyCount,
      deliveryFormat: mailerArg.deliveryFormat,
    });
    expect(preview.body.subject).toBe(expected.subject);
    expect(preview.body.html).toBe(expected.html);
    expect(preview.body.combinedFilename).toBe(expected.combinedFilename);
    expect(preview.body.zipFilename).toBe(expected.zipFilename);
  });

  it("returns 404 when no schedule has been configured for the org", async () => {
    const preview = await request(appAsAdmin).get(`${BASE()}/levy-ledger/email-schedule/preview`);
    expect(preview.status).toBe(404);
    expect(preview.body.error).toMatch(/schedule/i);
    expect(mailerMock).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// runDueOrgLevyLedgerEmailSchedules — selection
// ─────────────────────────────────────────────────────────────────────────
describe("runDueOrgLevyLedgerEmailSchedules — selection", () => {
  it("processes only enabled+due rows; leaves paused and future rows untouched", async () => {
    // Seed activity so the 'due' org's combined CSV has rows to count.
    const levyA = await makeLevy("Cron-Annual");
    await makeChargeWithPayment(levyA);

    // Two extra orgs so each row is uniquely keyed (the table has UNIQUE
    // (organization_id) — only one schedule per org).
    const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const [pausedOrg] = await db.insert(organizationsTable).values({
      name: `TestOrg_OrgLedgerCron_Paused_${stamp}`,
      slug: `test-org-ledger-cron-paused-${stamp}`,
    }).returning({ id: organizationsTable.id });
    const [futureOrg] = await db.insert(organizationsTable).values({
      name: `TestOrg_OrgLedgerCron_Future_${stamp}`,
      slug: `test-org-ledger-cron-future-${stamp}`,
    }).returning({ id: organizationsTable.id });

    try {
      const past = new Date(Date.now() - 60 * 60 * 1000);
      const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

      const [dueSched] = await db.insert(levyLedgerEmailOrgSchedulesTable).values({
        organizationId: testOrgId,
        frequency: "weekly",
        recipients: ["due@example.com"],
        enabled: true,
        deliveryFormat: "combined",
        nextRunAt: past,
      }).returning();

      const [pausedSched] = await db.insert(levyLedgerEmailOrgSchedulesTable).values({
        organizationId: pausedOrg.id,
        frequency: "weekly",
        recipients: ["paused@example.com"],
        enabled: false,
        deliveryFormat: "combined",
        nextRunAt: past,
      }).returning();

      const [futureSched] = await db.insert(levyLedgerEmailOrgSchedulesTable).values({
        organizationId: futureOrg.id,
        frequency: "weekly",
        recipients: ["future@example.com"],
        enabled: true,
        deliveryFormat: "combined",
        nextRunAt: future,
      }).returning();

      await runDueOrgLevyLedgerEmailSchedules();

      // Only the 'due' schedule fires.
      expect(mailerMock).toHaveBeenCalledTimes(1);
      expect(mailerMock.mock.calls[0][0].to).toEqual(["due@example.com"]);

      const dueRuns = await db.select().from(levyLedgerEmailOrgRunsTable)
        .where(eq(levyLedgerEmailOrgRunsTable.scheduleId, dueSched.id));
      expect(dueRuns).toHaveLength(1);
      expect(dueRuns[0].status).toBe("sent");

      const pausedRuns = await db.select().from(levyLedgerEmailOrgRunsTable)
        .where(eq(levyLedgerEmailOrgRunsTable.scheduleId, pausedSched.id));
      expect(pausedRuns).toHaveLength(0);

      const futureRuns = await db.select().from(levyLedgerEmailOrgRunsTable)
        .where(eq(levyLedgerEmailOrgRunsTable.scheduleId, futureSched.id));
      expect(futureRuns).toHaveLength(0);

      // Paused schedule still paused, cadence untouched.
      const [pausedAfter] = await db.select().from(levyLedgerEmailOrgSchedulesTable)
        .where(eq(levyLedgerEmailOrgSchedulesTable.id, pausedSched.id));
      expect(pausedAfter.enabled).toBe(false);
      expect(pausedAfter.lastSentAt).toBeNull();
      expect(new Date(pausedAfter.nextRunAt!).getTime()).toBe(past.getTime());

      // Future schedule's nextRunAt preserved exactly.
      const [futureAfter] = await db.select().from(levyLedgerEmailOrgSchedulesTable)
        .where(eq(levyLedgerEmailOrgSchedulesTable.id, futureSched.id));
      expect(futureAfter.lastSentAt).toBeNull();
      expect(new Date(futureAfter.nextRunAt!).getTime()).toBe(future.getTime());
    } finally {
      // Cleanup the extra orgs (cascades wipe schedules + runs).
      await db.delete(organizationsTable).where(eq(organizationsTable.id, pausedOrg.id));
      await db.delete(organizationsTable).where(eq(organizationsTable.id, futureOrg.id));
    }
  });

  it("absorbs per-row errors so one failing schedule does not block others", async () => {
    // First call rejects (failure path), second call succeeds — and crucially
    // the loop must not throw out so both rows get processed/recorded.
    mailerMock.mockRejectedValueOnce(new Error("smtp transient")).mockResolvedValue(undefined);

    const levyA = await makeLevy("Loop-A");
    await makeChargeWithPayment(levyA);

    const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const [otherOrg2] = await db.insert(organizationsTable).values({
      name: `TestOrg_OrgLedgerCron_Loop_${stamp}`,
      slug: `test-org-ledger-cron-loop-${stamp}`,
    }).returning({ id: organizationsTable.id });

    try {
      const past = new Date(Date.now() - 60 * 60 * 1000);
      const [a] = await db.insert(levyLedgerEmailOrgSchedulesTable).values({
        organizationId: testOrgId,
        frequency: "weekly",
        recipients: ["a@example.com"],
        enabled: true,
        deliveryFormat: "combined",
        nextRunAt: past,
      }).returning();
      const [b] = await db.insert(levyLedgerEmailOrgSchedulesTable).values({
        organizationId: otherOrg2.id,
        frequency: "weekly",
        recipients: ["b@example.com"],
        enabled: true,
        deliveryFormat: "combined",
        nextRunAt: past,
      }).returning();

      await expect(runDueOrgLevyLedgerEmailSchedules()).resolves.toBeUndefined();

      const aRuns = await db.select().from(levyLedgerEmailOrgRunsTable)
        .where(eq(levyLedgerEmailOrgRunsTable.scheduleId, a.id));
      const bRuns = await db.select().from(levyLedgerEmailOrgRunsTable)
        .where(eq(levyLedgerEmailOrgRunsTable.scheduleId, b.id));
      // Both rows recorded a run — one 'failed', one 'sent' — independent of order.
      expect(aRuns.length + bRuns.length).toBe(2);
      const statuses = [...aRuns.map((r) => r.status), ...bRuns.map((r) => r.status)].sort();
      expect(statuses).toEqual(["failed", "sent"]);
    } finally {
      await db.delete(organizationsTable).where(eq(organizationsTable.id, otherOrg2.id));
    }
  });
});
