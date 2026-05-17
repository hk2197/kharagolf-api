/**
 * Integration tests: POST /levy-ledger.pdf/email (Task #313 — covers the
 * on-demand "email this PDF to an auditor" endpoint added in Task #270).
 *
 * Locks down:
 *   - happy path: 200 response with recipients/rowCount/totals/currency/filename,
 *     mailer invoked with the right shape (PDF Buffer, dedup'd recipients,
 *     trimmed message, periodStart/periodEnd from filters)
 *   - recipient validation: missing recipients → 400, malformed email → 400,
 *     more than 20 recipients → 400. None of these should call the mailer
 *     and none should record an audit row.
 *   - filter pass-through: levyId / from / to / type narrow the embedded ledger
 *     exactly the way the GET endpoint does (different filters → different
 *     rowCount in the response and in the recorded audit metadata).
 *   - mailer throws → 502 returned to caller AND a memberAuditLogTable row is
 *     written with entity='levy_ledger', action='email_pdf', metadata.status
 *     ='failed' and the error message captured.
 *   - successful sends also write an audit row (entity/action/metadata) so
 *     admins can confirm what was sent and to whom.
 *
 * The mailer (sendLevyLedgerPdfEmail) is mocked so no real SMTP call is
 * attempted. The DB is real (DATABASE_URL) so we exercise the same SQL the
 * production code runs and can read back audit-log rows.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

vi.mock("../lib/mailer.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/mailer.js")>("../lib/mailer.js");
  return {
    ...actual,
    sendLevyLedgerPdfEmail: vi.fn(async () => undefined),
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
  memberAuditLogTable,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import { createTestApp, type TestUser } from "./helpers.js";
import { sendLevyLedgerPdfEmail } from "../lib/mailer.js";

const mailerMock = vi.mocked(sendLevyLedgerPdfEmail);

let testOrgId: number;
let testUserId: number;
let memberAId: number;
let memberBId: number;
let levyId: number;
let chargeAId: number;
let chargeBId: number;
let admin: TestUser;
let app: ReturnType<typeof createTestApp>;

const URL = () => `/api/organizations/${testOrgId}/members-360/levy-ledger.pdf/email`;

async function fetchEmailPdfAuditRows() {
  return db.select().from(memberAuditLogTable).where(and(
    eq(memberAuditLogTable.organizationId, testOrgId),
    eq(memberAuditLogTable.entity, "levy_ledger"),
    eq(memberAuditLogTable.action, "email_pdf"),
  ));
}

beforeAll(async () => {
  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

  const [org] = await db.insert(organizationsTable).values({
    name: `TestOrg_LedgerEmailPdf_${stamp}`,
    slug: `test-ledger-email-pdf-${stamp}`,
  }).returning({ id: organizationsTable.id });
  testOrgId = org.id;

  const [u] = await db.insert(appUsersTable).values({
    replitUserId: `ledger-email-pdf-admin-${stamp}`,
    username: `ledger_email_pdf_admin_${stamp}`,
    email: `ledger_email_pdf_admin_${stamp}@example.com`,
    displayName: "Ledger PDF Admin",
    role: "org_admin",
    organizationId: testOrgId,
  }).returning({ id: appUsersTable.id });
  testUserId = u.id;

  const [memberA] = await db.insert(clubMembersTable).values({
    organizationId: testOrgId,
    firstName: "Alice", lastName: "Auditor",
    memberNumber: `M-A-${stamp}`,
    email: "alice@example.com",
  }).returning({ id: clubMembersTable.id });
  memberAId = memberA.id;

  const [memberB] = await db.insert(clubMembersTable).values({
    organizationId: testOrgId,
    firstName: "Bob", lastName: "Bookkeeper",
    memberNumber: `M-B-${stamp}`,
    email: "bob@example.com",
  }).returning({ id: clubMembersTable.id });
  memberBId = memberB.id;

  const [levy] = await db.insert(memberLeviesTable).values({
    organizationId: testOrgId,
    name: "Annual Subscription",
    amount: "1000.00",
    currency: "INR",
    status: "applied",
    appliedAt: new Date(),
  }).returning({ id: memberLeviesTable.id });
  levyId = levy.id;

  const [chargeA] = await db.insert(memberLevyChargesTable).values({
    levyId, clubMemberId: memberAId,
    amount: "1000.00", status: "paid", paidAmount: "1000.00",
  }).returning({ id: memberLevyChargesTable.id });
  chargeAId = chargeA.id;

  const [chargeB] = await db.insert(memberLevyChargesTable).values({
    levyId, clubMemberId: memberBId,
    amount: "1000.00", status: "partial", paidAmount: "400.00",
  }).returning({ id: memberLevyChargesTable.id });
  chargeBId = chargeB.id;

  await db.insert(memberLevyChargeEventsTable).values([
    {
      chargeId: chargeAId, organizationId: testOrgId, clubMemberId: memberAId,
      eventType: "payment", amount: "1000.00", method: "card",
      processorReference: "pi_test_alice_full", actorName: "Treasurer Tara",
    },
    {
      chargeId: chargeBId, organizationId: testOrgId, clubMemberId: memberBId,
      eventType: "payment", amount: "400.00", method: "cash",
      processorReference: "RCPT-001", actorName: "Treasurer Tara",
    },
    {
      chargeId: chargeBId, organizationId: testOrgId, clubMemberId: memberBId,
      eventType: "refund", amount: "100.00", method: "cash",
      reason: "Overcharge correction", actorName: "Treasurer Tara",
    },
  ]);

  admin = {
    id: testUserId,
    username: `ledger_email_pdf_admin_${stamp}`,
    displayName: "Ledger PDF Admin",
    role: "org_admin",
    organizationId: testOrgId,
  };
  app = createTestApp(admin);
});

afterAll(async () => {
  await db.delete(memberAuditLogTable)
    .where(eq(memberAuditLogTable.organizationId, testOrgId));
  await db.delete(memberLevyChargeEventsTable)
    .where(eq(memberLevyChargeEventsTable.organizationId, testOrgId));
  await db.delete(memberLevyChargesTable)
    .where(inArray(memberLevyChargesTable.id, [chargeAId, chargeBId]));
  await db.delete(memberLeviesTable).where(eq(memberLeviesTable.id, levyId));
  await db.delete(clubMembersTable).where(inArray(clubMembersTable.id, [memberAId, memberBId]));
  if (testUserId) await db.delete(appUsersTable).where(eq(appUsersTable.id, testUserId));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, testOrgId));
});

beforeEach(async () => {
  mailerMock.mockReset();
  mailerMock.mockResolvedValue(undefined);
  // Clean audit rows from previous tests so each `it` starts from zero.
  await db.delete(memberAuditLogTable)
    .where(and(
      eq(memberAuditLogTable.organizationId, testOrgId),
      eq(memberAuditLogTable.entity, "levy_ledger"),
      eq(memberAuditLogTable.action, "email_pdf"),
    ));
});

// ─────────────────────────────────────────────────────────────────────────
// Happy path
// ─────────────────────────────────────────────────────────────────────────
describe("POST /levy-ledger.pdf/email — success", () => {
  it("emails the PDF, returns metadata, and writes a 'sent' audit row", async () => {
    const res = await request(app)
      .post(URL())
      .query({ levyId: String(levyId) })
      .send({
        recipients: ["auditor@example.com", " auditor@example.com ", "second@example.com"],
        message: "  Quarterly review attached  ",
      });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("sent");
    expect(res.body.recipients).toEqual(["auditor@example.com", "second@example.com"]);
    expect(res.body.rowCount).toBe(3);
    expect(res.body.filename).toBe(`levy-ledger-${levyId}.pdf`);
    expect(res.body.totals).toEqual({ payment: 1400, refund: 100, waive: 0 });
    expect(res.body.currency).toBe("INR");

    expect(mailerMock).toHaveBeenCalledTimes(1);
    const arg = mailerMock.mock.calls[0][0];
    expect(arg.to).toEqual(["auditor@example.com", "second@example.com"]);
    expect(arg.filename).toBe(`levy-ledger-${levyId}.pdf`);
    expect(arg.rowCount).toBe(3);
    expect(arg.totals).toEqual({ payment: 1400, refund: 100, waive: 0 });
    expect(arg.currency).toBe("INR");
    expect(arg.levyName).toBe("Annual Subscription");
    expect(arg.message).toBe("Quarterly review attached");
    expect(Buffer.isBuffer(arg.pdf)).toBe(true);
    expect(arg.pdf.subarray(0, 5).toString("ascii")).toBe("%PDF-");

    const audits = await fetchEmailPdfAuditRows();
    expect(audits).toHaveLength(1);
    expect(audits[0].entity).toBe("levy_ledger");
    expect(audits[0].action).toBe("email_pdf");
    expect(audits[0].entityId).toBe(levyId);
    const meta = audits[0].metadata as Record<string, unknown>;
    expect(meta.status).toBe("sent");
    expect(meta.errorMessage).toBeNull();
    expect(meta.recipients).toEqual(["auditor@example.com", "second@example.com"]);
    expect(meta.rowCount).toBe(3);
    expect(meta.filename).toBe(`levy-ledger-${levyId}.pdf`);
    expect(meta.message).toBe("Quarterly review attached");
    expect(meta.totals).toEqual({ payment: 1400, refund: 100, waive: 0 });
    expect(meta.currency).toBe("INR");
    expect((meta.filters as { levyId: number }).levyId).toBe(levyId);
  });

  it("accepts a comma/whitespace-separated recipients string", async () => {
    const res = await request(app)
      .post(URL())
      .query({ levyId: String(levyId) })
      .send({ recipients: "first@example.com, second@example.com  third@example.com" });
    expect(res.status).toBe(200);
    expect(res.body.recipients).toEqual([
      "first@example.com",
      "second@example.com",
      "third@example.com",
    ]);
    expect(mailerMock).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Recipient validation
// ─────────────────────────────────────────────────────────────────────────
describe("POST /levy-ledger.pdf/email — recipient validation", () => {
  it("rejects missing/empty recipients with 400", async () => {
    const res = await request(app).post(URL()).send({});
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/at least one recipient/);
    expect(mailerMock).not.toHaveBeenCalled();
    expect(await fetchEmailPdfAuditRows()).toHaveLength(0);
  });

  it("rejects an invalid recipient email with 400", async () => {
    const res = await request(app)
      .post(URL())
      .send({ recipients: ["good@example.com", "not-an-email"] });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/invalid recipient email/);
    expect(mailerMock).not.toHaveBeenCalled();
    expect(await fetchEmailPdfAuditRows()).toHaveLength(0);
  });

  it("rejects more than 20 recipients with 400", async () => {
    const recipients = Array.from({ length: 21 }, (_, i) => `r${i}@example.com`);
    const res = await request(app).post(URL()).send({ recipients });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/20 recipients/);
    expect(mailerMock).not.toHaveBeenCalled();
    expect(await fetchEmailPdfAuditRows()).toHaveLength(0);
  });

  it("rejects unauthenticated callers with 401", async () => {
    const anon = createTestApp();
    const res = await request(anon)
      .post(URL())
      .send({ recipients: ["a@example.com"] });
    expect(res.status).toBe(401);
    expect(mailerMock).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Filter pass-through (parity with GET /levy-ledger.pdf)
// ─────────────────────────────────────────────────────────────────────────
describe("POST /levy-ledger.pdf/email — filter pass-through", () => {
  it("rejects an invalid levyId with 400", async () => {
    const res = await request(app)
      .post(URL())
      .query({ levyId: "not-a-number" })
      .send({ recipients: ["a@example.com"] });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/invalid levyId/);
    expect(mailerMock).not.toHaveBeenCalled();
  });

  it("rejects an invalid event type with 400", async () => {
    const res = await request(app)
      .post(URL())
      .query({ levyId: String(levyId), type: "bogus" })
      .send({ recipients: ["a@example.com"] });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/invalid type/);
    expect(mailerMock).not.toHaveBeenCalled();
  });

  it("narrows the ledger when levyId/memberId/type/from/to filters are provided", async () => {
    // Member B has 1 payment + 1 refund. type=refund narrows to a single row.
    const res = await request(app)
      .post(URL())
      .query({
        levyId: String(levyId),
        memberId: String(memberBId),
        type: "refund",
        from: "1970-01-01",
        to: "2999-12-31",
      })
      .send({ recipients: ["auditor@example.com"] });
    expect(res.status).toBe(200);
    expect(res.body.rowCount).toBe(1);
    expect(res.body.totals).toEqual({ payment: 0, refund: 100, waive: 0 });

    expect(mailerMock).toHaveBeenCalledTimes(1);
    const arg = mailerMock.mock.calls[0][0];
    expect(arg.rowCount).toBe(1);
    expect(arg.periodStart).toBeInstanceOf(Date);
    expect(arg.periodEnd).toBeInstanceOf(Date);

    const [audit] = await fetchEmailPdfAuditRows();
    const meta = audit.metadata as Record<string, unknown>;
    const filters = meta.filters as Record<string, unknown>;
    expect(filters.levyId).toBe(levyId);
    expect(filters.memberId).toBe(memberBId);
    expect(filters.type).toBe("refund");
    expect(filters.from).toBe(new Date("1970-01-01").toISOString());
    expect(filters.to).toBe(new Date("2999-12-31").toISOString());
    // entityId is the filtered levyId; clubMemberId is the filtered memberId.
    expect(audit.entityId).toBe(levyId);
    expect(audit.clubMemberId).toBe(memberBId);
  });

  it("a far-future date range yields zero rows (filters honored, not silently dropped)", async () => {
    const res = await request(app)
      .post(URL())
      .query({ levyId: String(levyId), from: "2999-01-01", to: "2999-12-31" })
      .send({ recipients: ["auditor@example.com"] });
    expect(res.status).toBe(200);
    expect(res.body.rowCount).toBe(0);
    expect(res.body.totals).toEqual({ payment: 0, refund: 0, waive: 0 });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Mailer failure → 502 + audit row with status='failed'
// ─────────────────────────────────────────────────────────────────────────
describe("POST /levy-ledger.pdf/email — mailer throws", () => {
  it("returns 502 and writes a 'failed' audit row capturing the error", async () => {
    mailerMock.mockRejectedValueOnce(new Error("smtp blew up"));

    const res = await request(app)
      .post(URL())
      .query({ levyId: String(levyId) })
      .send({ recipients: ["auditor@example.com"] });
    expect(res.status).toBe(502);
    expect(res.body.status).toBe("failed");
    expect(res.body.errorMessage).toBe("smtp blew up");
    expect(res.body.recipients).toEqual(["auditor@example.com"]);
    expect(res.body.rowCount).toBe(3);

    const audits = await fetchEmailPdfAuditRows();
    expect(audits).toHaveLength(1);
    expect(audits[0].entity).toBe("levy_ledger");
    expect(audits[0].action).toBe("email_pdf");
    expect(audits[0].entityId).toBe(levyId);
    const meta = audits[0].metadata as Record<string, unknown>;
    expect(meta.status).toBe("failed");
    expect(meta.errorMessage).toBe("smtp blew up");
    expect(meta.recipients).toEqual(["auditor@example.com"]);
    expect(meta.rowCount).toBe(3);
  });
});
