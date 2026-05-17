/**
 * Integration tests: Levy ledger PDF export (Task #272)
 *
 * Covers the on-demand `/levy-ledger.pdf` endpoint added in Task #231.
 * Asserts:
 *   - Happy path with seeded events: 200, application/pdf, %PDF- prefix,
 *     filename header includes the levyId.
 *   - Empty-result case (filters that match no events): still a valid PDF
 *     beginning with %PDF-.
 *   - Filters mirror the CSV endpoint: a memberId filter narrows the result
 *     and an invalid levyId is rejected with 400.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { db } from "@workspace/db";
import {
  organizationsTable,
  clubMembersTable,
  memberLeviesTable,
  memberLevyChargesTable,
  memberLevyChargeEventsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { createTestApp } from "./helpers.js";
// pdfkit emits text as hex-encoded TJ operands inside FlateDecoded content
// streams, so the rendered strings are not findable in the raw PDF bytes.
// Decode with pdf-parse to assert on the human-readable text instead.
// @ts-expect-error — pdf-parse ships no type declarations
import pdfParse from "pdf-parse/lib/pdf-parse.js";

let testOrgId: number;
let memberAId: number;
let memberBId: number;
let levyId: number;
let chargeAId: number;
let chargeBId: number;

beforeAll(async () => {
  const tag = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

  const [org] = await db.insert(organizationsTable).values({
    name: `TestOrg_LevyLedgerPdf_${tag}`,
    slug: `test-levy-ledger-pdf-${tag}`,
  }).returning({ id: organizationsTable.id });
  testOrgId = org.id;

  const [memberA] = await db.insert(clubMembersTable).values({
    organizationId: testOrgId,
    firstName: "Alice",
    lastName: "Auditor",
    memberNumber: `M-A-${tag}`,
    email: "alice@example.com",
  }).returning({ id: clubMembersTable.id });
  memberAId = memberA.id;

  const [memberB] = await db.insert(clubMembersTable).values({
    organizationId: testOrgId,
    firstName: "Bob",
    lastName: "Bookkeeper",
    memberNumber: `M-B-${tag}`,
    email: "bob@example.com",
  }).returning({ id: clubMembersTable.id });
  memberBId = memberB.id;

  const [levy] = await db.insert(memberLeviesTable).values({
    organizationId: testOrgId,
    name: "Annual Subscription",
    amount: "1000.00",
    currency: "INR",
    status: "applied",
  }).returning({ id: memberLeviesTable.id });
  levyId = levy.id;

  const [chargeA] = await db.insert(memberLevyChargesTable).values({
    levyId,
    clubMemberId: memberAId,
    amount: "1000.00",
    status: "paid",
    paidAmount: "1000.00",
  }).returning({ id: memberLevyChargesTable.id });
  chargeAId = chargeA.id;

  const [chargeB] = await db.insert(memberLevyChargesTable).values({
    levyId,
    clubMemberId: memberBId,
    amount: "1000.00",
    status: "partial",
    paidAmount: "400.00",
  }).returning({ id: memberLevyChargesTable.id });
  chargeBId = chargeB.id;

  await db.insert(memberLevyChargeEventsTable).values([
    {
      chargeId: chargeAId,
      organizationId: testOrgId,
      clubMemberId: memberAId,
      eventType: "payment",
      amount: "1000.00",
      method: "card",
      processorReference: "pi_test_alice_full",
      note: "Paid in full",
      actorName: "Treasurer Tara",
    },
    {
      chargeId: chargeBId,
      organizationId: testOrgId,
      clubMemberId: memberBId,
      eventType: "payment",
      amount: "400.00",
      method: "cash",
      processorReference: "RCPT-001",
      note: "Part payment",
      actorName: "Treasurer Tara",
    },
    {
      chargeId: chargeBId,
      organizationId: testOrgId,
      clubMemberId: memberBId,
      eventType: "refund",
      amount: "100.00",
      method: "cash",
      reason: "Overcharge correction",
      actorName: "Treasurer Tara",
    },
  ]);
});

afterAll(async () => {
  await db.delete(memberLevyChargeEventsTable)
    .where(eq(memberLevyChargeEventsTable.organizationId, testOrgId));
  await db.delete(memberLevyChargesTable).where(eq(memberLevyChargesTable.levyId, levyId));
  await db.delete(memberLeviesTable).where(eq(memberLeviesTable.id, levyId));
  await db.delete(clubMembersTable).where(eq(clubMembersTable.id, memberAId));
  await db.delete(clubMembersTable).where(eq(clubMembersTable.id, memberBId));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, testOrgId));
});

const adminUser = () => ({
  id: 1,
  username: "ledger_admin",
  displayName: "Ledger Admin",
  role: "super_admin",
});

/**
 * Supertest's default body parser only handles JSON/text; PDFs come back as
 * binary streams, so every test that needs the body collects chunks itself.
 * Factored here to keep each test focused on its assertions.
 */
function fetchPdf(query: Record<string, string> = {}) {
  const app = createTestApp(adminUser());
  return request(app)
    .get(`/api/organizations/${testOrgId}/members-360/levy-ledger.pdf`)
    .query(query)
    .buffer(true)
    .parse((response, cb) => {
      const chunks: Buffer[] = [];
      response.on("data", (c: Buffer) => chunks.push(c));
      response.on("end", () => cb(null, Buffer.concat(chunks)));
    });
}

describe("GET /levy-ledger.pdf — happy path", () => {
  it("returns a valid PDF for the seeded events with levyId in the filename", async () => {
    const res = await fetchPdf({ levyId: String(levyId) });
    expect(res.status).toBe(200);
    expect(String(res.headers["content-type"])).toMatch(/application\/pdf/i);
    const disposition = String(res.headers["content-disposition"] ?? "");
    expect(disposition).toMatch(/attachment/i);
    expect(disposition).toContain(`levy-ledger-${levyId}.pdf`);

    const body = res.body as Buffer;
    expect(Buffer.isBuffer(body)).toBe(true);
    expect(body.length).toBeGreaterThan(100);
    expect(body.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    // PDF documents end with %%EOF — confirms the pdfkit stream finished cleanly.
    expect(body.subarray(-6).toString("ascii")).toMatch(/%%EOF/);
  });
});

describe("GET /levy-ledger.pdf — empty result set", () => {
  it("still returns a valid PDF when no events match the filters", async () => {
    // Filter to a date range in the far future so no seeded event matches.
    const res = await fetchPdf({
      levyId: String(levyId),
      from: "2999-01-01",
      to: "2999-12-31",
    });

    expect(res.status).toBe(200);
    expect(String(res.headers["content-type"])).toMatch(/application\/pdf/i);
    expect(String(res.headers["content-disposition"] ?? ""))
      .toContain(`levy-ledger-${levyId}.pdf`);

    const body = res.body as Buffer;
    expect(Buffer.isBuffer(body)).toBe(true);
    expect(body.length).toBeGreaterThan(100);
    expect(body.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    expect(body.subarray(-6).toString("ascii")).toMatch(/%%EOF/);
  });
});

describe("GET /levy-ledger.pdf — filters mirror the CSV endpoint", () => {
  it("accepts memberId/type/from/to filters and produces a valid PDF", async () => {
    const res = await fetchPdf({
      levyId: String(levyId),
      memberId: String(memberBId),
      type: "payment",
      from: "1970-01-01",
    });

    expect(res.status).toBe(200);
    expect(String(res.headers["content-type"])).toMatch(/application\/pdf/i);
    const body = res.body as Buffer;
    expect(body.subarray(0, 5).toString("ascii")).toBe("%PDF-");
  });

  it("narrows ledger contents when filters are applied", async () => {
    // Seeded events for this levy:
    //   memberA: 1 payment   (chargeA)
    //   memberB: 1 payment + 1 refund (chargeB)
    // Filtering by memberId / type must change which rows the PDF embeds, so
    // the resulting byte streams must differ — proves filters aren't ignored.
    const [allRes, memberAOnly, memberBOnly, refundsOnly, emptyRes] =
      await Promise.all([
        fetchPdf({ levyId: String(levyId) }),
        fetchPdf({ levyId: String(levyId), memberId: String(memberAId) }),
        fetchPdf({ levyId: String(levyId), memberId: String(memberBId) }),
        fetchPdf({ levyId: String(levyId), type: "refund" }),
        fetchPdf({
          levyId: String(levyId),
          from: "2999-01-01",
          to: "2999-12-31",
        }),
      ]);

    for (const r of [allRes, memberAOnly, memberBOnly, refundsOnly, emptyRes]) {
      expect(r.status).toBe(200);
      expect((r.body as Buffer).subarray(0, 5).toString("ascii")).toBe("%PDF-");
    }

    const sizes = {
      all: (allRes.body as Buffer).length,
      a: (memberAOnly.body as Buffer).length,
      b: (memberBOnly.body as Buffer).length,
      refunds: (refundsOnly.body as Buffer).length,
      empty: (emptyRes.body as Buffer).length,
    };

    // memberId filter actually narrows the result: per-member PDFs are smaller
    // than the unfiltered one, and member B (2 events) yields a larger PDF
    // than member A (1 event).
    expect(sizes.a).toBeLessThan(sizes.all);
    expect(sizes.b).toBeLessThan(sizes.all);
    expect(sizes.b).toBeGreaterThan(sizes.a);
    // type filter is honored: refunds-only excludes both payments.
    expect(sizes.refunds).toBeLessThan(sizes.all);
    // Date filter that matches nothing produces the smallest PDF of all.
    expect(sizes.empty).toBeLessThan(sizes.a);
  });

  it("returns 400 for an invalid levyId", async () => {
    const app = createTestApp(adminUser());
    const res = await request(app)
      .get(`/api/organizations/${testOrgId}/members-360/levy-ledger.pdf`)
      .query({ levyId: "not-a-number" });
    expect(res.status).toBe(400);
  });

  it("returns 400 for an invalid event type", async () => {
    const app = createTestApp(adminUser());
    const res = await request(app)
      .get(`/api/organizations/${testOrgId}/members-360/levy-ledger.pdf`)
      .query({ levyId: String(levyId), type: "bogus" });
    expect(res.status).toBe(400);
  });

  it("omits the levyId from the filename when no levyId filter is provided", async () => {
    const res = await fetchPdf();

    expect(res.status).toBe(200);
    const disposition = String(res.headers["content-disposition"] ?? "");
    expect(disposition).toContain(`levy-ledger.pdf`);
    expect(disposition).not.toContain(`levy-ledger-${levyId}.pdf`);
  });

  /**
   * Task #341 — running balance column propagates into the printable PDF and
   * the CSV export. Sequence on a single charge:
   *   amount = 1000
   *   t1: payment 600   -> paid  600 / refunded   0 / balance 400
   *   t2: refund  100   -> paid  600 / refunded 100 / balance 300
   *   t3: payment 500   -> paid 1100 / refunded 100 / balance   0  (clamped at 0)
   *   t4: reversal of t3 -> paid  600 / refunded 100 / balance 300
   * Convention matches the per-charge events API
   * (runningBalance = max(0, chargeAmount - paid - refunded)).
   * The CSV must have the new running_* columns with these exact values; the
   * PDF must embed the post-reversal balance string so treasurers can see
   * the running outstanding amount after each row.
   */
  it("includes the running balance column for a payment + refund + reversal sequence", async () => {
    const tag = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const [member] = await db.insert(clubMembersTable).values({
      organizationId: testOrgId,
      firstName: "Cleo", lastName: "Carry",
      memberNumber: `M-C-${tag}`, email: "cleo@example.com",
    }).returning({ id: clubMembersTable.id });
    const [scLevy] = await db.insert(memberLeviesTable).values({
      organizationId: testOrgId,
      name: "Special Levy",
      amount: "1000.00", currency: "INR", status: "applied",
    }).returning({ id: memberLeviesTable.id });
    const [scCharge] = await db.insert(memberLevyChargesTable).values({
      levyId: scLevy.id, clubMemberId: member.id,
      amount: "1000.00", status: "partial", paidAmount: "600.00",
    }).returning({ id: memberLevyChargesTable.id });

    const t1 = new Date("2025-01-01T10:00:00Z");
    const t2 = new Date("2025-01-02T10:00:00Z");
    const t3 = new Date("2025-01-03T10:00:00Z");
    const t4 = new Date("2025-01-04T10:00:00Z");

    await db.insert(memberLevyChargeEventsTable).values({
      chargeId: scCharge.id, organizationId: testOrgId, clubMemberId: member.id,
      eventType: "payment", amount: "600.00", method: "card",
      occurredAt: t1, actorName: "Treasurer Tara",
    });
    await db.insert(memberLevyChargeEventsTable).values({
      chargeId: scCharge.id, organizationId: testOrgId, clubMemberId: member.id,
      eventType: "refund", amount: "100.00", method: "cash",
      occurredAt: t2, reason: "Goodwill credit",
    });
    const [payB] = await db.insert(memberLevyChargeEventsTable).values({
      chargeId: scCharge.id, organizationId: testOrgId, clubMemberId: member.id,
      eventType: "payment", amount: "500.00", method: "bank_transfer",
      occurredAt: t3,
    }).returning({ id: memberLevyChargeEventsTable.id });
    await db.insert(memberLevyChargeEventsTable).values({
      chargeId: scCharge.id, organizationId: testOrgId, clubMemberId: member.id,
      eventType: "reversal", amount: "500.00",
      reversesEventId: payB.id,
      occurredAt: t4, reason: "Duplicate payment refunded out-of-band",
    });

    try {
      // CSV — assert headers and per-row running totals.
      const app = createTestApp(adminUser());
      const csvRes = await request(app)
        .get(`/api/organizations/${testOrgId}/members-360/levy-ledger.csv`)
        .query({ levyId: String(scLevy.id), memberId: String(member.id) });
      expect(csvRes.status).toBe(200);
      const csv = String(csvRes.text);
      const lines = csv.split("\n");
      expect(lines[0]).toContain("running_paid");
      expect(lines[0]).toContain("running_refunded");
      expect(lines[0]).toContain("running_balance");

      // The CSV emits every event chronologically; pluck the trailing 3
      // running columns from each data row to verify the rolling totals.
      const dataRows = lines.slice(1).filter(l => l.length > 0);
      expect(dataRows).toHaveLength(4);
      const lastThreeOf = (line: string): [string, string, string] => {
        // Each cell is double-quoted so split on `","` — first/last cells need
        // their leading/trailing quote stripped.
        const cells = line.split(`","`);
        const n = cells.length;
        const strip = (s: string) => s.replace(/^"/, "").replace(/"$/, "");
        return [strip(cells[n - 3]), strip(cells[n - 2]), strip(cells[n - 1])];
      };
      expect(lastThreeOf(dataRows[0])).toEqual(["600.00", "0.00", "400.00"]);
      expect(lastThreeOf(dataRows[1])).toEqual(["600.00", "100.00", "300.00"]);
      expect(lastThreeOf(dataRows[2])).toEqual(["1100.00", "100.00", "0.00"]);
      expect(lastThreeOf(dataRows[3])).toEqual(["600.00", "100.00", "300.00"]);

      // PDF — must contain a "Balance" header and embed the running balance
      // strings (400.00 after the first payment, 300.00 after the reversal).
      const pdfRes = await fetchPdf({
        levyId: String(scLevy.id),
        memberId: String(member.id),
      });
      expect(pdfRes.status).toBe(200);
      const pdf = pdfRes.body as Buffer;
      expect(pdf.subarray(0, 5).toString("ascii")).toBe("%PDF-");
      const pdfText = (await pdfParse(pdf)).text;
      expect(pdfText).toContain("Balance");
      expect(pdfText).toContain("400.00");
      expect(pdfText).toContain("300.00");
    } finally {
      await db.delete(memberLevyChargeEventsTable)
        .where(eq(memberLevyChargeEventsTable.chargeId, scCharge.id));
      await db.delete(memberLevyChargesTable).where(eq(memberLevyChargesTable.id, scCharge.id));
      await db.delete(memberLeviesTable).where(eq(memberLeviesTable.id, scLevy.id));
      await db.delete(clubMembersTable).where(eq(clubMembersTable.id, member.id));
    }
  });

  it("rejects unauthenticated callers with 401", async () => {
    const app = createTestApp();
    const res = await request(app)
      .get(`/api/organizations/${testOrgId}/members-360/levy-ledger.pdf`)
      .query({ levyId: String(levyId) });
    expect(res.status).toBe(401);
  });
});
