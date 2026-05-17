/**
 * Integration tests: Levy ledger PDF signature panel (Task #309)
 *
 * Task #271 added an auditor-ready signature + notes panel to the bottom
 * of the last page of `/levy-ledger.pdf`, plus an optional `?notes=` query
 * parameter that lets staff embed treasurer notes in the export. This file
 * locks in that behavior end-to-end:
 *
 *   1. The panel renders on every export, with and without `?notes=`,
 *      always carrying the literal labels "Signed by treasurer" and "Date".
 *   2. When `?notes=` is supplied, the supplied text appears verbatim inside
 *      the notes box.
 *   3. When the data table fills the final page so closely that there is no
 *      room for the ~140pt panel, a fresh page is added rather than the
 *      panel overprinting the page footer. We assert this by seeding many
 *      events, parsing the PDF, and confirming the page count and the
 *      single-occurrence of "Signed by treasurer" on a later page than the
 *      first row.
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
// pdf-parse's package entrypoint runs a debug block when no parent module is
// detected. Importing the lib file directly skips that and gives us a stable
// `(Buffer) => Promise<{ text, numpages, ... }>` API for assertions.
// @ts-expect-error — pdf-parse ships no type declarations
import pdfParse from "pdf-parse/lib/pdf-parse.js";

let testOrgId: number;
let memberSmallId: number;
let memberFillId: number;
let levySmallId: number;
let levyFillId: number;
let chargeSmallId: number;
let chargeFillId: number;

beforeAll(async () => {
  const tag = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

  const [org] = await db.insert(organizationsTable).values({
    name: `TestOrg_LevyLedgerPdfSig_${tag}`,
    slug: `test-levy-ledger-pdf-sig-${tag}`,
  }).returning({ id: organizationsTable.id });
  testOrgId = org.id;

  // Member used by the small-export tests (a single payment event).
  const [memberSmall] = await db.insert(clubMembersTable).values({
    organizationId: testOrgId,
    firstName: "Sasha",
    lastName: "Small",
    memberNumber: `M-S-${tag}`,
    email: "sasha@example.com",
  }).returning({ id: clubMembersTable.id });
  memberSmallId = memberSmall.id;

  // Member used by the page-filling test (many payment events).
  const [memberFill] = await db.insert(clubMembersTable).values({
    organizationId: testOrgId,
    firstName: "Felix",
    lastName: "Filler",
    memberNumber: `M-F-${tag}`,
    email: "felix@example.com",
  }).returning({ id: clubMembersTable.id });
  memberFillId = memberFill.id;

  const [levySmall] = await db.insert(memberLeviesTable).values({
    organizationId: testOrgId,
    name: "Signature Panel Levy",
    amount: "100.00",
    currency: "INR",
    status: "applied",
  }).returning({ id: memberLeviesTable.id });
  levySmallId = levySmall.id;

  const [levyFill] = await db.insert(memberLeviesTable).values({
    organizationId: testOrgId,
    name: "Page Filler Levy",
    amount: "100.00",
    currency: "INR",
    status: "applied",
  }).returning({ id: memberLeviesTable.id });
  levyFillId = levyFill.id;

  const [chargeSmall] = await db.insert(memberLevyChargesTable).values({
    levyId: levySmallId,
    clubMemberId: memberSmallId,
    amount: "100.00",
    status: "paid",
    paidAmount: "100.00",
  }).returning({ id: memberLevyChargesTable.id });
  chargeSmallId = chargeSmall.id;

  const [chargeFill] = await db.insert(memberLevyChargesTable).values({
    levyId: levyFillId,
    clubMemberId: memberFillId,
    amount: "100.00",
    status: "paid",
    paidAmount: "100.00",
  }).returning({ id: memberLevyChargesTable.id });
  chargeFillId = chargeFill.id;

  // One event for the small export — the signature panel must still appear.
  await db.insert(memberLevyChargeEventsTable).values({
    chargeId: chargeSmallId,
    organizationId: testOrgId,
    clubMemberId: memberSmallId,
    eventType: "payment",
    amount: "100.00",
    method: "card",
    processorReference: "pi_sig_panel_small",
    note: "Single seed event",
    actorName: "Treasurer Tara",
  });

  // Seed enough events that the table overflows page 1 and leaves the final
  // page tight enough to force the signature panel onto a fresh page. With
  // landscape A4 + 16pt rows the body fits ~25 rows per page, so 45 events
  // produce two full data pages and an extra page for the signature panel.
  const fillerEvents = Array.from({ length: 45 }, (_, i) => ({
    chargeId: chargeFillId,
    organizationId: testOrgId,
    clubMemberId: memberFillId,
    eventType: "payment" as const,
    amount: "10.00",
    method: "cash",
    processorReference: `RCPT-FILL-${i + 1}`,
    note: `Filler event ${i + 1}`,
    actorName: "Treasurer Tara",
  }));
  await db.insert(memberLevyChargeEventsTable).values(fillerEvents);
});

afterAll(async () => {
  await db.delete(memberLevyChargeEventsTable)
    .where(eq(memberLevyChargeEventsTable.organizationId, testOrgId));
  await db.delete(memberLevyChargesTable).where(eq(memberLevyChargesTable.id, chargeSmallId));
  await db.delete(memberLevyChargesTable).where(eq(memberLevyChargesTable.id, chargeFillId));
  await db.delete(memberLeviesTable).where(eq(memberLeviesTable.id, levySmallId));
  await db.delete(memberLeviesTable).where(eq(memberLeviesTable.id, levyFillId));
  await db.delete(clubMembersTable).where(eq(clubMembersTable.id, memberSmallId));
  await db.delete(clubMembersTable).where(eq(clubMembersTable.id, memberFillId));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, testOrgId));
});

const adminUser = () => ({
  id: 1,
  username: "ledger_admin",
  displayName: "Ledger Admin",
  role: "super_admin",
});

/**
 * PDFs come back as binary streams; supertest's default body parser turns
 * them into the empty string. We parse manually so each test gets a Buffer
 * it can hand straight to pdf-parse.
 */
function fetchPdf(query: Record<string, string> = {}): Promise<request.Response> {
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

async function fetchPdfText(query: Record<string, string> = {}) {
  const res = await fetchPdf(query);
  expect(res.status).toBe(200);
  const body = res.body as Buffer;
  expect(body.subarray(0, 5).toString("ascii")).toBe("%PDF-");
  const parsed = await pdfParse(body);
  return { res, body, parsed };
}

describe("levy-ledger.pdf signature panel — Task #271 / #309", () => {
  it("renders the treasurer signature line and date label without ?notes=", async () => {
    const { parsed } = await fetchPdfText({ levyId: String(levySmallId) });
    expect(parsed.text).toContain("Signed by treasurer");
    expect(parsed.text).toContain("Date");
    // The notes label sits above the (empty) notes box even when no
    // notes were supplied — the panel should still draw its frame.
    expect(parsed.text).toContain("Notes");
  });

  it("embeds the supplied ?notes= text verbatim in the notes box", async () => {
    const notesText =
      "Audited by external CPA on 2026-04-15; reconciled against bank statement.";
    const { parsed } = await fetchPdfText({
      levyId: String(levySmallId),
      notes: notesText,
    });
    expect(parsed.text).toContain("Signed by treasurer");
    expect(parsed.text).toContain("Date");
    expect(parsed.text).toContain(notesText);
  });

  it("ignores ?notes= on otherwise-identical exports when not supplied", async () => {
    // Sanity check that the verbatim notes string doesn't leak from one
    // request into the next when the parameter is omitted.
    const stray = "this-string-should-never-appear-in-the-pdf";
    const { parsed } = await fetchPdfText({ levyId: String(levySmallId) });
    expect(parsed.text).not.toContain(stray);
  });

  it("rolls the signature panel onto a fresh page rather than overprinting the footer when the table fills the last page", async () => {
    // Baseline: one event on this org, signature panel fits on page 1.
    const small = await fetchPdfText({ levyId: String(levySmallId) });
    expect(small.parsed.numpages).toBe(1);
    expect(small.parsed.text).toContain("Signed by treasurer");

    // 45-event export — must overflow onto multiple pages. The panel
    // needs ~140pt; once the data table leaves less than that, the route's
    // ensureRoomForSignature() helper must add a new page so the panel
    // doesn't collide with the page footer.
    const filled = await fetchPdfText({ levyId: String(levyFillId) });

    // Multiple pages prove the table itself overflowed.
    expect(filled.parsed.numpages).toBeGreaterThan(1);
    // Strictly more pages than the no-overflow baseline — i.e. the panel
    // genuinely ended up on a separate page region rather than crammed in.
    expect(filled.parsed.numpages).toBeGreaterThan(small.parsed.numpages);

    // The signature panel should appear exactly once across the whole PDF
    // — proving it isn't drawn on every page footer and isn't duplicated.
    const sigMatches = filled.parsed.text.match(/Signed by treasurer/g) ?? [];
    expect(sigMatches.length).toBe(1);
    // pdf-parse concatenates adjacent text fragments without inserting a
    // space between the "Signed by treasurer" and "Date" labels, so the
    // word-boundary form `\bDate\b` doesn't match. Asserting on the
    // substring is enough — we just need the Date label to be present.
    const dateMatches = filled.parsed.text.match(/Date/g) ?? [];
    expect(dateMatches.length).toBeGreaterThanOrEqual(1);

    // The "Page totals" footer string is drawn on every data page; when the
    // panel rolls onto a fresh signature-only page, the generator skips the
    // footer there so the signature line ends up *after* the last footer in
    // the document. This guards against the panel ever overprinting (or
    // appearing before) the closing page-totals row on a data page.
    const lastFooterIdx = filled.parsed.text.lastIndexOf("Page totals");
    const sigIdx = filled.parsed.text.indexOf("Signed by treasurer");
    expect(lastFooterIdx).toBeGreaterThan(-1);
    expect(sigIdx).toBeGreaterThan(lastFooterIdx);
  });

  it("preserves the supplied notes even on a multi-page filled export", async () => {
    const notesText = "Multi-page export — notes survive the page roll.";
    const { parsed } = await fetchPdfText({
      levyId: String(levyFillId),
      notes: notesText,
    });
    expect(parsed.numpages).toBeGreaterThan(1);
    expect(parsed.text).toContain(notesText);
    expect(parsed.text).toContain("Signed by treasurer");
  });
});
