/**
 * Tests for the per-levy CSV pack delivery format on the club-wide ledger
 * digest (Task #322 / coverage Task #390).
 *
 * Pins down the new "deliveryFormat" surface added on top of the existing
 * combined-CSV path so future refactors can't silently regress treasurers'
 * ZIPs:
 *
 *   - PUT /levy-ledger/email-schedule validation accepts each documented
 *     deliveryFormat value, persists it round-trip, defaults to "combined"
 *     when omitted, and rejects unknown / malformed values.
 *   - runOneOrgLevyLedgerEmailSchedule with deliveryFormat="combined"
 *     attaches one CSV (and no ZIP), and the email body labels the format.
 *   - runOneOrgLevyLedgerEmailSchedule with deliveryFormat="per_levy_zip"
 *     attaches a ZIP containing one CSV per levy that had events in the
 *     period, with slug-safe + id-disambiguated filenames, and no combined
 *     CSV. The email body labels the format.
 *   - runOneOrgLevyLedgerEmailSchedule with deliveryFormat="both" attaches
 *     BOTH the combined CSV and the per-levy ZIP, and the email body labels
 *     the format.
 *   - When the period has no levy activity the ZIP falls back to a single
 *     README.txt entry instead of an empty archive, so attachments are
 *     never empty/corrupt for treasurers.
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
import AdmZip from "adm-zip";
import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  clubMembersTable,
  memberLeviesTable,
  memberLevyChargesTable,
  memberLevyChargeEventsTable,
  levyLedgerEmailOrgSchedulesTable,
  levyLedgerEmailOrgRunsTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { createTestApp, type TestUser } from "./helpers.js";
import { runOneOrgLevyLedgerEmailSchedule } from "../routes/member-360.js";
import { sendOrgLevyLedgerScheduleEmail } from "../lib/mailer.js";

const mailerMock = vi.mocked(sendOrgLevyLedgerScheduleEmail);

let testOrgId: number;
let testUserId: number;
let memberId: number;
let admin: TestUser;
let app: ReturnType<typeof createTestApp>;
const levyIds: number[] = [];
const chargeIds: number[] = [];

const BASE = () => `/api/organizations/${testOrgId}/members-360`;

async function makeLevy(name: string): Promise<number> {
  const [l] = await db.insert(memberLeviesTable).values({
    organizationId: testOrgId,
    name,
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
  // Wipe charges (and their cascading events) between tests so each test
  // controls exactly which levies show up in the period.
  if (chargeIds.length) {
    await db.delete(memberLevyChargesTable)
      .where(inArray(memberLevyChargesTable.id, chargeIds));
    chargeIds.length = 0;
  }
  await db.delete(levyLedgerEmailOrgSchedulesTable)
    .where(eq(levyLedgerEmailOrgSchedulesTable.organizationId, testOrgId));
}

beforeAll(async () => {
  const stamp = Date.now();
  const [org] = await db.insert(organizationsTable).values({
    name: `TestOrg_OrgLedgerFormat_${stamp}`,
    slug: `test-org-ledger-format-${stamp}`,
  }).returning({ id: organizationsTable.id });
  testOrgId = org.id;

  const [u] = await db.insert(appUsersTable).values({
    replitUserId: `test-org-ledger-format-${stamp}`,
    username: `test_org_ledger_admin_${stamp}`,
    email: `org_ledger_admin_${stamp}@example.com`,
    displayName: "Org Ledger Admin",
    role: "org_admin",
    organizationId: testOrgId,
  }).returning({ id: appUsersTable.id });
  testUserId = u.id;

  const [m] = await db.insert(clubMembersTable).values({
    organizationId: testOrgId,
    firstName: "Format",
    lastName: "Tester",
    email: `member_${stamp}@example.com`,
  }).returning({ id: clubMembersTable.id });
  memberId = m.id;

  admin = {
    id: testUserId,
    username: `test_org_ledger_admin_${stamp}`,
    displayName: "Org Ledger Admin",
    role: "org_admin",
    organizationId: testOrgId,
  };
  app = createTestApp(admin);
});

afterAll(async () => {
  // Cascades wipe charges/events/schedules/runs when the levy/org go.
  for (const id of levyIds) {
    await db.delete(memberLeviesTable).where(eq(memberLeviesTable.id, id));
  }
  if (memberId) {
    await db.delete(clubMembersTable).where(eq(clubMembersTable.id, memberId));
  }
  if (testUserId) {
    await db.delete(appUsersTable).where(eq(appUsersTable.id, testUserId));
  }
  if (testOrgId) {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, testOrgId));
  }
});

beforeEach(async () => {
  mailerMock.mockReset();
  mailerMock.mockResolvedValue(undefined);
  await clearActivity();
});

// ─────────────────────────────────────────────────────────────────────────
// PUT validation — deliveryFormat
// ─────────────────────────────────────────────────────────────────────────
describe("PUT /levy-ledger/email-schedule — deliveryFormat validation", () => {
  it("defaults to 'combined' when deliveryFormat is omitted", async () => {
    const res = await request(app)
      .put(`${BASE()}/levy-ledger/email-schedule`)
      .send({ frequency: "weekly", recipients: ["t@example.com"] });
    expect(res.status).toBe(200);
    expect(res.body.schedule.deliveryFormat).toBe("combined");

    const [persisted] = await db.select().from(levyLedgerEmailOrgSchedulesTable)
      .where(eq(levyLedgerEmailOrgSchedulesTable.organizationId, testOrgId));
    expect(persisted?.deliveryFormat).toBe("combined");
  });

  it("rejects unknown deliveryFormat values with a clear error", async () => {
    const res = await request(app)
      .put(`${BASE()}/levy-ledger/email-schedule`)
      .send({ frequency: "weekly", recipients: ["t@example.com"], deliveryFormat: "pdf" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/deliveryFormat/);
  });

  it("rejects empty deliveryFormat strings", async () => {
    const res = await request(app)
      .put(`${BASE()}/levy-ledger/email-schedule`)
      .send({ frequency: "weekly", recipients: ["t@example.com"], deliveryFormat: "" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/deliveryFormat/);
  });

  it.each(["combined", "per_levy_zip", "both"] as const)(
    "accepts and persists deliveryFormat=%s round-trip",
    async (format) => {
      const res = await request(app)
        .put(`${BASE()}/levy-ledger/email-schedule`)
        .send({ frequency: "weekly", recipients: ["t@example.com"], deliveryFormat: format });
      expect(res.status).toBe(200);
      expect(res.body.schedule.deliveryFormat).toBe(format);

      // GET reflects the persisted value.
      const getRes = await request(app).get(`${BASE()}/levy-ledger/email-schedule`);
      expect(getRes.status).toBe(200);
      expect(getRes.body.schedule.deliveryFormat).toBe(format);
    },
  );

  it("normalises uppercase deliveryFormat values via case-insensitive match", async () => {
    const res = await request(app)
      .put(`${BASE()}/levy-ledger/email-schedule`)
      .send({ frequency: "weekly", recipients: ["t@example.com"], deliveryFormat: "PER_LEVY_ZIP" });
    expect(res.status).toBe(200);
    expect(res.body.schedule.deliveryFormat).toBe("per_levy_zip");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// runOneOrgLevyLedgerEmailSchedule — combined
// ─────────────────────────────────────────────────────────────────────────
describe("runOneOrgLevyLedgerEmailSchedule — deliveryFormat='combined'", () => {
  it("attaches a single combined CSV (no ZIP) and labels the email body", async () => {
    const levyA = await makeLevy(`Annual ${Date.now()}`);
    await makeChargeWithPayment(levyA);

    const putRes = await request(app)
      .put(`${BASE()}/levy-ledger/email-schedule`)
      .send({
        frequency: "weekly",
        recipients: ["treasurer@example.com"],
        deliveryFormat: "combined",
      });
    expect(putRes.status).toBe(200);
    const scheduleId = putRes.body.schedule.id as number;

    const result = await runOneOrgLevyLedgerEmailSchedule(scheduleId);
    expect(result.status).toBe("sent");
    expect(result.deliveryFormat).toBe("combined");
    expect(result.levyCount).toBe(1);
    expect(result.rowCount).toBeGreaterThan(0);

    expect(mailerMock).toHaveBeenCalledTimes(1);
    const arg = mailerMock.mock.calls[0][0];
    expect(arg.deliveryFormat).toBe("combined");
    expect(typeof arg.csv).toBe("string");
    expect(arg.csv as string).toContain("date");
    expect(arg.zip == null).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// runOneOrgLevyLedgerEmailSchedule — per_levy_zip
// ─────────────────────────────────────────────────────────────────────────
describe("runOneOrgLevyLedgerEmailSchedule — deliveryFormat='per_levy_zip'", () => {
  it("attaches a ZIP with one CSV per levy and slug-safe + id-suffixed names", async () => {
    // Two levies that share an IDENTICAL base name to force the
    // id-disambiguator path, plus one with non-portable characters in the
    // name to exercise the slug-safe filename helper.
    const sharedName = "Spring/Drive Levy";
    const levyA = await makeLevy(sharedName);
    const levyB = await makeLevy(sharedName);
    const levyC = await makeLevy(`Membership Fee #2026`);
    await makeChargeWithPayment(levyA);
    await makeChargeWithPayment(levyB);
    await makeChargeWithPayment(levyC);

    const putRes = await request(app)
      .put(`${BASE()}/levy-ledger/email-schedule`)
      .send({
        frequency: "weekly",
        recipients: ["treasurer@example.com"],
        deliveryFormat: "per_levy_zip",
      });
    expect(putRes.status).toBe(200);
    const scheduleId = putRes.body.schedule.id as number;

    const result = await runOneOrgLevyLedgerEmailSchedule(scheduleId);
    expect(result.status).toBe("sent");
    expect(result.deliveryFormat).toBe("per_levy_zip");
    expect(result.levyCount).toBe(3);
    // rowCount is back-filled from the per-levy CSVs when no combined build runs.
    expect(result.rowCount).toBeGreaterThan(0);

    expect(mailerMock).toHaveBeenCalledTimes(1);
    const arg = mailerMock.mock.calls[0][0];
    expect(arg.deliveryFormat).toBe("per_levy_zip");
    // No combined CSV should be built when only the ZIP is requested.
    expect(arg.csv == null).toBe(true);
    expect(Buffer.isBuffer(arg.zip)).toBe(true);

    const zip = new AdmZip(arg.zip as Buffer);
    const entries = zip.getEntries();
    expect(entries).toHaveLength(3);

    // Filenames are slug-safe (no slashes / spaces / `#`) and end with `-<id>.csv`.
    const names = entries.map((e) => e.entryName).sort();
    for (const name of names) {
      expect(name).toMatch(/^[A-Za-z0-9._-]+\.csv$/);
    }
    expect(names.some((n) => n.endsWith(`-${levyA}.csv`))).toBe(true);
    expect(names.some((n) => n.endsWith(`-${levyB}.csv`))).toBe(true);
    expect(names.some((n) => n.endsWith(`-${levyC}.csv`))).toBe(true);
    // Unique names — id-disambiguation prevents collisions when two levies share a base.
    expect(new Set(names).size).toBe(names.length);

    // Each CSV has the standard header row so treasurers can open them directly.
    for (const entry of entries) {
      const text = entry.getData().toString("utf8");
      const firstLine = text.split("\n")[0];
      expect(firstLine).toContain("date");
      expect(firstLine).toContain("levy");
      expect(firstLine).toContain("running_balance");
    }
  });

  it("falls back to a README.txt entry when the period has no levy activity", async () => {
    // No charges / events seeded — the period is empty for this org.
    const putRes = await request(app)
      .put(`${BASE()}/levy-ledger/email-schedule`)
      .send({
        frequency: "weekly",
        recipients: ["treasurer@example.com"],
        deliveryFormat: "per_levy_zip",
      });
    expect(putRes.status).toBe(200);
    const scheduleId = putRes.body.schedule.id as number;

    const result = await runOneOrgLevyLedgerEmailSchedule(scheduleId);
    expect(result.status).toBe("sent");
    expect(result.deliveryFormat).toBe("per_levy_zip");
    expect(result.levyCount).toBe(0);
    expect(result.rowCount).toBe(0);

    const arg = mailerMock.mock.calls[0][0];
    expect(Buffer.isBuffer(arg.zip)).toBe(true);
    const zip = new AdmZip(arg.zip as Buffer);
    const entries = zip.getEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].entryName).toBe("README.txt");
    const text = entries[0].getData().toString("utf8");
    expect(text).toMatch(/no levy activity/i);

    // Run history records the empty digest as 'sent' with zeroed counts.
    const [run] = await db.select().from(levyLedgerEmailOrgRunsTable)
      .where(eq(levyLedgerEmailOrgRunsTable.scheduleId, scheduleId));
    expect(run.status).toBe("sent");
    expect(run.rowCount).toBe(0);
    expect(run.levyCount).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// runOneOrgLevyLedgerEmailSchedule — both
// ─────────────────────────────────────────────────────────────────────────
describe("runOneOrgLevyLedgerEmailSchedule — deliveryFormat='both'", () => {
  it("attaches the combined CSV AND the per-levy ZIP", async () => {
    const levyA = await makeLevy(`Range ${Date.now()}`);
    const levyB = await makeLevy(`Caddie ${Date.now()}`);
    await makeChargeWithPayment(levyA);
    await makeChargeWithPayment(levyB);

    const putRes = await request(app)
      .put(`${BASE()}/levy-ledger/email-schedule`)
      .send({
        frequency: "monthly",
        recipients: ["treasurer@example.com"],
        deliveryFormat: "both",
      });
    expect(putRes.status).toBe(200);
    const scheduleId = putRes.body.schedule.id as number;

    const result = await runOneOrgLevyLedgerEmailSchedule(scheduleId);
    expect(result.status).toBe("sent");
    expect(result.deliveryFormat).toBe("both");
    expect(result.levyCount).toBe(2);

    const arg = mailerMock.mock.calls[0][0];
    expect(arg.deliveryFormat).toBe("both");
    expect(typeof arg.csv).toBe("string");
    expect((arg.csv as string).split("\n")[0]).toContain("date");
    expect(Buffer.isBuffer(arg.zip)).toBe(true);

    const zip = new AdmZip(arg.zip as Buffer);
    const entries = zip.getEntries();
    expect(entries).toHaveLength(2);
    const names = entries.map((e) => e.entryName);
    expect(names.some((n) => n.endsWith(`-${levyA}.csv`))).toBe(true);
    expect(names.some((n) => n.endsWith(`-${levyB}.csv`))).toBe(true);
  });
});
