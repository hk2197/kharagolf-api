/**
 * Integration tests: Levy ledger CSV export (Task #334)
 *
 * Covers the on-demand `/levy-ledger.csv` endpoint, which shares its filter
 * parsing (levyId / memberId / type / from / to) with the PDF route already
 * covered by Task #272. The CSV format itself is consumed directly by
 * auditors — a regression in escaping or column order would ship silently
 * to whoever pulls spreadsheets — so we assert on:
 *   - 200 + text/csv content type, filename header includes the levyId
 *   - header row matches the documented columns
 *   - seeded rows appear with the right amounts/types
 *   - empty-result filter still yields just the header row
 *   - invalid levyId / type return 400 (matching the PDF route)
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

let testOrgId: number;
let memberAId: number;
let memberBId: number;
let levyId: number;
let chargeAId: number;
let chargeBId: number;

beforeAll(async () => {
  const tag = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

  const [org] = await db.insert(organizationsTable).values({
    name: `TestOrg_LevyLedgerCsv_${tag}`,
    slug: `test-levy-ledger-csv-${tag}`,
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
    // Embedded comma + double-quote so the CSV escaping is actually exercised.
    lastName: 'Bookkeeper, "Jr."',
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

function fetchCsv(query: Record<string, string> = {}) {
  const app = createTestApp(adminUser());
  return request(app)
    .get(`/api/organizations/${testOrgId}/members-360/levy-ledger.csv`)
    .query(query);
}

/**
 * Minimal CSV parser tuned to the exact format `buildLevyLedgerCsv` emits:
 * every cell is wrapped in double-quotes and any embedded `"` is doubled.
 * Rows are separated by a single LF. Returning a 2D array of cell strings
 * lets each test assert on header columns and individual rows directly.
 */
function parseCsv(csv: string): string[][] {
  const rows: string[][] = [];
  let cur: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < csv.length; i++) {
    const ch = csv[i];
    if (inQuotes) {
      if (ch === '"') {
        if (csv[i + 1] === '"') { cell += '"'; i++; }
        else { inQuotes = false; }
      } else {
        cell += ch;
      }
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ",") { cur.push(cell); cell = ""; }
      else if (ch === "\n") { cur.push(cell); rows.push(cur); cur = []; cell = ""; }
      else cell += ch;
    }
  }
  if (cell.length > 0 || cur.length > 0) { cur.push(cell); rows.push(cur); }
  return rows;
}

const EXPECTED_HEADER = [
  "date", "member_number", "member", "email",
  "levy", "currency", "type", "amount",
  "method", "processor_reference", "note_or_reason", "actor",
  // Per-row running totals added in Task #341 so treasurers can reconcile
  // the CSV row-by-row against bank statements.
  "running_paid", "running_refunded", "running_balance",
];

describe("GET /levy-ledger.csv — happy path", () => {
  it("returns text/csv with the levyId in the filename and the documented header", async () => {
    const res = await fetchCsv({ levyId: String(levyId) });
    expect(res.status).toBe(200);
    expect(String(res.headers["content-type"])).toMatch(/text\/csv/i);
    const disposition = String(res.headers["content-disposition"] ?? "");
    expect(disposition).toMatch(/attachment/i);
    expect(disposition).toContain(`levy-ledger-${levyId}.csv`);

    const rows = parseCsv(res.text);
    expect(rows[0]).toEqual(EXPECTED_HEADER);
  });

  it("emits one CSV row per seeded event with the correct amounts and types", async () => {
    const res = await fetchCsv({ levyId: String(levyId) });
    expect(res.status).toBe(200);
    const rows = parseCsv(res.text);

    // header + 3 seeded events
    expect(rows.length).toBe(4);
    const dataRows = rows.slice(1);

    const typeIdx = EXPECTED_HEADER.indexOf("type");
    const amountIdx = EXPECTED_HEADER.indexOf("amount");
    const memberIdx = EXPECTED_HEADER.indexOf("member");
    const levyNameIdx = EXPECTED_HEADER.indexOf("levy");
    const currencyIdx = EXPECTED_HEADER.indexOf("currency");
    const noteIdx = EXPECTED_HEADER.indexOf("note_or_reason");

    // Every row references the seeded levy + currency.
    for (const r of dataRows) {
      expect(r[levyNameIdx]).toBe("Annual Subscription");
      expect(r[currencyIdx]).toBe("INR");
    }

    const aliceFull = dataRows.find(r =>
      r[memberIdx] === "Alice Auditor" && r[typeIdx] === "payment");
    expect(aliceFull).toBeDefined();
    expect(parseFloat(aliceFull![amountIdx])).toBeCloseTo(1000);
    expect(aliceFull![noteIdx]).toBe("Paid in full");

    // Bob's last name has a comma + embedded quotes — the round-trip through
    // CSV escaping must preserve them exactly.
    const bobPart = dataRows.find(r =>
      r[memberIdx].startsWith("Bob") && r[typeIdx] === "payment");
    expect(bobPart).toBeDefined();
    expect(bobPart![memberIdx]).toBe('Bob Bookkeeper, "Jr."');
    expect(parseFloat(bobPart![amountIdx])).toBeCloseTo(400);

    const bobRefund = dataRows.find(r =>
      r[memberIdx].startsWith("Bob") && r[typeIdx] === "refund");
    expect(bobRefund).toBeDefined();
    expect(parseFloat(bobRefund![amountIdx])).toBeCloseTo(100);
    // Refund events surface their `reason` field in the note_or_reason column.
    expect(bobRefund![noteIdx]).toBe("Overcharge correction");
  });
});

describe("GET /levy-ledger.csv — filters", () => {
  it("returns just the header when no events match the filters", async () => {
    const res = await fetchCsv({
      levyId: String(levyId),
      from: "2999-01-01",
      to: "2999-12-31",
    });
    expect(res.status).toBe(200);
    expect(String(res.headers["content-type"])).toMatch(/text\/csv/i);
    const rows = parseCsv(res.text);
    expect(rows.length).toBe(1);
    expect(rows[0]).toEqual(EXPECTED_HEADER);
  });

  it("narrows ledger contents when memberId / type filters are applied", async () => {
    const [memberAOnly, memberBOnly, refundsOnly] = await Promise.all([
      fetchCsv({ levyId: String(levyId), memberId: String(memberAId) }),
      fetchCsv({ levyId: String(levyId), memberId: String(memberBId) }),
      fetchCsv({ levyId: String(levyId), type: "refund" }),
    ]);

    for (const r of [memberAOnly, memberBOnly, refundsOnly]) {
      expect(r.status).toBe(200);
    }

    // memberA: 1 payment row → header + 1 = 2 rows
    expect(parseCsv(memberAOnly.text).length).toBe(2);
    // memberB: 1 payment + 1 refund → header + 2 = 3 rows
    expect(parseCsv(memberBOnly.text).length).toBe(3);
    // refunds-only across both members: header + 1 refund row
    const refundRows = parseCsv(refundsOnly.text);
    expect(refundRows.length).toBe(2);
    expect(refundRows[1][EXPECTED_HEADER.indexOf("type")]).toBe("refund");
  });

  it("omits the levyId from the filename when no levyId filter is provided", async () => {
    const res = await fetchCsv();
    expect(res.status).toBe(200);
    const disposition = String(res.headers["content-disposition"] ?? "");
    expect(disposition).toContain(`levy-ledger.csv`);
    expect(disposition).not.toContain(`levy-ledger-${levyId}.csv`);
  });
});

describe("GET /levy-ledger.csv — validation mirrors the PDF route", () => {
  it("returns 400 for an invalid levyId", async () => {
    const res = await fetchCsv({ levyId: "not-a-number" });
    expect(res.status).toBe(400);
  });

  it("returns 400 for an invalid memberId", async () => {
    const res = await fetchCsv({ memberId: "not-a-number" });
    expect(res.status).toBe(400);
  });

  it("returns 400 for an invalid event type", async () => {
    const res = await fetchCsv({ levyId: String(levyId), type: "bogus" });
    expect(res.status).toBe(400);
  });

  it("returns 400 for an invalid from date", async () => {
    const res = await fetchCsv({ levyId: String(levyId), from: "not-a-date" });
    expect(res.status).toBe(400);
  });

  it("rejects unauthenticated callers with 401", async () => {
    const app = createTestApp();
    const res = await request(app)
      .get(`/api/organizations/${testOrgId}/members-360/levy-ledger.csv`)
      .query({ levyId: String(levyId) });
    expect(res.status).toBe(401);
  });
});
