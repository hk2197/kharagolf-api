/**
 * Tests for the ledger email preview endpoint (Task #314).
 *
 * GET /api/organizations/:orgId/members-360/levies/:id/email-schedule/preview
 *
 * The preview lets admins inspect the next scheduled ledger email without
 * actually sending it. These tests guard against regressions where the
 * preview accidentally:
 *   - inserts a row into levy_ledger_email_runs (history)
 *   - invokes the mailer
 *   - returns the wrong period boundaries or row count
 *
 * Also covers:
 *   - ?download=1 returns the CSV as an attachment with the right headers
 *   - 404 when no schedule is configured
 *   - 403 when the caller lacks member-admin
 *
 * Mailer is mocked so a stray send would be caught immediately.
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
  memberLevyChargesTable,
  memberLevyChargeEventsTable,
  levyLedgerEmailSchedulesTable,
  levyLedgerEmailRunsTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { createTestApp, type TestUser } from "./helpers.js";
import { sendLevyLedgerScheduleEmail } from "../lib/mailer.js";

const mailerMock = vi.mocked(sendLevyLedgerScheduleEmail);

let testOrgId: number;
let adminUserId: number;
let memberUserId: number;
let testMemberId: number;
let admin: TestUser;
let nonAdmin: TestUser;
let app: ReturnType<typeof createTestApp>;
let nonAdminApp: ReturnType<typeof createTestApp>;
const levyIds: number[] = [];
const scheduleIds: number[] = [];

const BASE = () => `/api/organizations/${testOrgId}/members-360`;

async function makeLevy(name = "Preview"): Promise<number> {
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

async function makeSchedule(
  levyId: number,
  opts: {
    frequency?: "weekly" | "monthly";
    recipients?: string[];
    lastSentAt?: Date | null;
    enabled?: boolean;
  } = {},
): Promise<number> {
  const [row] = await db.insert(levyLedgerEmailSchedulesTable).values({
    organizationId: testOrgId,
    levyId,
    frequency: opts.frequency ?? "weekly",
    recipients: opts.recipients ?? ["treasurer@example.com"],
    enabled: opts.enabled ?? true,
    nextRunAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    lastSentAt: opts.lastSentAt ?? null,
  }).returning({ id: levyLedgerEmailSchedulesTable.id });
  scheduleIds.push(row.id);
  return row.id;
}

async function fetchRuns(scheduleId: number) {
  return db.select().from(levyLedgerEmailRunsTable)
    .where(eq(levyLedgerEmailRunsTable.scheduleId, scheduleId));
}

beforeAll(async () => {
  const stamp = Date.now();
  const [org] = await db.insert(organizationsTable).values({
    name: `TestOrg_LedgerPreview_${stamp}`,
    slug: `test-ledger-preview-${stamp}`,
  }).returning({ id: organizationsTable.id });
  testOrgId = org.id;

  const [adminRow] = await db.insert(appUsersTable).values({
    replitUserId: `test-ledger-preview-admin-${stamp}`,
    username: `test_preview_admin_${stamp}`,
    email: `preview_admin_${stamp}@example.com`,
    displayName: "Preview Admin",
    role: "org_admin",
    organizationId: testOrgId,
  }).returning({ id: appUsersTable.id });
  adminUserId = adminRow.id;

  const [memberRow] = await db.insert(appUsersTable).values({
    replitUserId: `test-ledger-preview-member-${stamp}`,
    username: `test_preview_member_${stamp}`,
    email: `preview_member_${stamp}@example.com`,
    displayName: "Preview Member",
    role: "player",
    organizationId: testOrgId,
  }).returning({ id: appUsersTable.id });
  memberUserId = memberRow.id;

  const [m] = await db.insert(clubMembersTable).values({
    organizationId: testOrgId,
    firstName: "Preview",
    lastName: "Tester",
    email: `member_preview_${stamp}@example.com`,
  }).returning({ id: clubMembersTable.id });
  testMemberId = m.id;

  admin = {
    id: adminUserId,
    username: `test_preview_admin_${stamp}`,
    displayName: "Preview Admin",
    role: "org_admin",
    organizationId: testOrgId,
  };
  nonAdmin = {
    id: memberUserId,
    username: `test_preview_member_${stamp}`,
    displayName: "Preview Member",
    role: "member",
    organizationId: testOrgId,
  };
  app = createTestApp(admin);
  nonAdminApp = createTestApp(nonAdmin);
});

afterAll(async () => {
  for (const id of scheduleIds) {
    await db.delete(levyLedgerEmailSchedulesTable)
      .where(eq(levyLedgerEmailSchedulesTable.id, id));
  }
  for (const id of levyIds) {
    await db.delete(memberLeviesTable).where(eq(memberLeviesTable.id, id));
  }
  if (testMemberId) {
    await db.delete(clubMembersTable).where(eq(clubMembersTable.id, testMemberId));
  }
  if (adminUserId) {
    await db.delete(appUsersTable).where(eq(appUsersTable.id, adminUserId));
  }
  if (memberUserId) {
    await db.delete(appUsersTable).where(eq(appUsersTable.id, memberUserId));
  }
  if (testOrgId) {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, testOrgId));
  }
});

beforeEach(() => {
  mailerMock.mockReset();
  mailerMock.mockResolvedValue(undefined);
});

describe("GET /levies/:id/email-schedule/preview — JSON summary", () => {
  it("returns rowCount=0 and a header-only CSV when there are no ledger events in the window", async () => {
    const levyId = await makeLevy("empty");
    const scheduleId = await makeSchedule(levyId, {
      frequency: "weekly",
      recipients: ["t@example.com"],
      lastSentAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
    });

    const res = await request(app)
      .get(`${BASE()}/levies/${levyId}/email-schedule/preview`);
    expect(res.status).toBe(200);
    expect(res.body.rowCount).toBe(0);
    // CSV contains only the header line.
    expect(res.body.csv.split("\n")).toHaveLength(1);
    expect(res.body.csv.split("\n")[0]).toContain("date");

    expect(mailerMock).not.toHaveBeenCalled();
    expect(await fetchRuns(scheduleId)).toHaveLength(0);
  });

  it("returns rowCount, period, recipients, frequency and CSV — counting only events inside the window — without sending or recording history", async () => {
    const levyId = await makeLevy("seeded");
    const recipients = ["a@example.com", "b@example.com"];
    const lastSentAt = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);

    // Seed one charge with two events: one inside the window and one before it.
    // Preview window = (lastSentAt, now], so only the in-window event must be
    // counted. A regression that ignores the date filter would return 2 here.
    const [charge] = await db.insert(memberLevyChargesTable).values({
      levyId,
      clubMemberId: testMemberId,
      amount: "100.00",
      status: "partial",
      paidAmount: "30.00",
    }).returning({ id: memberLevyChargesTable.id });
    await db.insert(memberLevyChargeEventsTable).values([
      {
        chargeId: charge.id,
        organizationId: testOrgId,
        clubMemberId: testMemberId,
        eventType: "payment",
        amount: "20.00",
        occurredAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000), // before window
      },
      {
        chargeId: charge.id,
        organizationId: testOrgId,
        clubMemberId: testMemberId,
        eventType: "payment",
        amount: "10.00",
        occurredAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000), // inside window
      },
    ]);

    const scheduleId = await makeSchedule(levyId, {
      frequency: "weekly",
      recipients,
      lastSentAt,
    });

    const before = Date.now();
    const res = await request(app)
      .get(`${BASE()}/levies/${levyId}/email-schedule/preview`);
    const after = Date.now();

    expect(res.status).toBe(200);
    expect(res.body.frequency).toBe("weekly");
    expect(res.body.recipients).toEqual(recipients);

    // Exactly one event falls inside (lastSentAt, now].
    expect(res.body.rowCount).toBe(1);
    // CSV: one header row + one data row.
    expect(res.body.csv.split("\n")).toHaveLength(1 + res.body.rowCount);

    // Period uses lastSentAt as the start when present.
    expect(new Date(res.body.periodStart).getTime()).toBe(lastSentAt.getTime());
    const periodEnd = new Date(res.body.periodEnd).getTime();
    expect(periodEnd).toBeGreaterThanOrEqual(before);
    expect(periodEnd).toBeLessThanOrEqual(after);

    expect(typeof res.body.csv).toBe("string");
    expect(res.body.csv.split("\n")[0]).toContain("date");

    // Crucially: no mailer invocation, no history row.
    expect(mailerMock).not.toHaveBeenCalled();
    expect(await fetchRuns(scheduleId)).toHaveLength(0);
  });

  it("falls back to a one-cadence-ago window when lastSentAt is null", async () => {
    const levyId = await makeLevy("fallback");
    const scheduleId = await makeSchedule(levyId, {
      frequency: "monthly",
      recipients: ["t@example.com"],
      lastSentAt: null,
    });

    const before = Date.now();
    const res = await request(app)
      .get(`${BASE()}/levies/${levyId}/email-schedule/preview`);
    expect(res.status).toBe(200);

    const periodStart = new Date(res.body.periodStart).getTime();
    const periodEnd = new Date(res.body.periodEnd).getTime();
    const span = periodEnd - periodStart;
    // monthly fallback is exactly 30 days.
    const thirtyDays = 30 * 24 * 60 * 60 * 1000;
    expect(span).toBeGreaterThanOrEqual(thirtyDays - 1000);
    expect(span).toBeLessThanOrEqual(thirtyDays + 1000);
    expect(periodEnd).toBeGreaterThanOrEqual(before);
    // No charges/events seeded for this levy.
    expect(res.body.rowCount).toBe(0);

    expect(mailerMock).not.toHaveBeenCalled();
    expect(await fetchRuns(scheduleId)).toHaveLength(0);
  });
});

describe("GET /levies/:id/email-schedule/preview?download=1 — CSV download", () => {
  it("returns the CSV with text/csv Content-Type and an attachment Content-Disposition", async () => {
    const levyId = await makeLevy();
    const scheduleId = await makeSchedule(levyId, {
      frequency: "weekly",
      recipients: ["t@example.com"],
    });

    const res = await request(app)
      .get(`${BASE()}/levies/${levyId}/email-schedule/preview`)
      .query({ download: "1" });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/csv/);
    expect(res.headers["content-type"]).toMatch(/charset=utf-8/);
    expect(res.headers["content-disposition"]).toBe(
      `attachment; filename="levy-ledger-${levyId}-preview.csv"`,
    );

    const body = res.text ?? res.body.toString();
    expect(typeof body).toBe("string");
    expect(body.split("\n")[0]).toContain("date");

    // Still no side effects.
    expect(mailerMock).not.toHaveBeenCalled();
    expect(await fetchRuns(scheduleId)).toHaveLength(0);
  });
});

describe("GET /levies/:id/email-schedule/preview — error cases", () => {
  it("returns 404 when no schedule has been configured for the levy", async () => {
    const levyId = await makeLevy();
    const res = await request(app)
      .get(`${BASE()}/levies/${levyId}/email-schedule/preview`);
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/no schedule/i);

    expect(mailerMock).not.toHaveBeenCalled();
    // Sanity: no schedule was created as a side effect either.
    const [maybe] = await db.select().from(levyLedgerEmailSchedulesTable)
      .where(and(
        eq(levyLedgerEmailSchedulesTable.organizationId, testOrgId),
        eq(levyLedgerEmailSchedulesTable.levyId, levyId),
      ));
    expect(maybe).toBeUndefined();
  });

  it("returns 403 when the caller lacks member-admin", async () => {
    const levyId = await makeLevy();
    const scheduleId = await makeSchedule(levyId, {
      recipients: ["t@example.com"],
    });

    const res = await request(nonAdminApp)
      .get(`${BASE()}/levies/${levyId}/email-schedule/preview`);
    expect(res.status).toBe(403);

    expect(mailerMock).not.toHaveBeenCalled();
    expect(await fetchRuns(scheduleId)).toHaveLength(0);
  });
});
