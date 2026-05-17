/**
 * Task #1524 — guarantee the stuck-receipt digest CSV matches what
 * admins see in the `SideGameReceiptFailuresWidget` dashboard.
 *
 * The cron-emailed CSV (`buildSideGameReceiptDigestCsv`) and the
 * `/api/admin/side-game-receipt-failures` endpoint that powers the
 * widget run two SEPARATE select queries against
 * `side_game_settlement_receipt_attempts`. They are intentionally
 * written to use the same `STUCK_STATUSES` filter and same
 * "exhausted-or-skipped" predicate, but a future change to one and not
 * the other could silently drift them apart — operators would then see
 * a different set of stuck rows in their inbox vs. the dashboard.
 *
 * Task #1290's existing failure-handling test never seeds any
 * `side_game_settlement_receipt_attempts` rows so it cannot catch
 * that drift. This sibling test seeds a representative mix
 * (healthy / exhausted-email / skipped-push / fully-exhausted) and
 * asserts both surfaces report the same row IDs and the same
 * exhausted/skipped counts.
 *
 * The mailer is mocked so the test never touches SMTP; the captured
 * `csv` argument is what we compare against the dashboard response.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

vi.mock("../lib/mailer.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/mailer.js")>();
  return {
    ...actual,
    sendSideGameReceiptDigestEmail: vi.fn(async () => {}),
  };
});

vi.mock("../lib/push.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/push.js")>();
  return {
    ...actual,
    sendPushToUsers: vi.fn(async (uids: number[]) => ({
      attempted: uids.length, sent: uids.length, failed: 0, invalid: 0,
    })),
  };
});

import request from "supertest";
import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  sideGameInstancesTable,
  sideGameSettlementsTable,
  sideGameSettlementReceiptAttemptsTable,
  sideGameReceiptDigestSchedulesTable,
  sideGameReceiptDigestRunsTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { runOneSideGameReceiptDigestSchedule } from "../routes/side-games-v2.js";
import { sendSideGameReceiptDigestEmail } from "../lib/mailer.js";
import { createTestApp, type TestUser, uid } from "./helpers.js";

const sendMock = vi.mocked(sendSideGameReceiptDigestEmail);

let orgId: number;
let adminId: number;
let recipientId: number;
let instanceId: number;
let scheduleId: number;
let app: ReturnType<typeof createTestApp>;

const settlementIds: number[] = [];
const attemptIds: number[] = [];

async function makeSettlement(): Promise<number> {
  const [s] = await db.insert(sideGameSettlementsTable).values({
    instanceId,
    fromName: "Payer",
    toName: "Recipient",
    amount: "150.00",
    currency: "INR",
    status: "paid",
    paidAt: new Date(),
  }).returning({ id: sideGameSettlementsTable.id });
  settlementIds.push(s.id);
  return s.id;
}

async function makeAttempt(opts: {
  settlementId: number;
  emailStatus?: string | null;
  emailAttempts?: number;
  emailRetryExhaustedAt?: Date | null;
  pushStatus?: string | null;
  pushAttempts?: number;
  pushRetryExhaustedAt?: Date | null;
}): Promise<number> {
  const [a] = await db.insert(sideGameSettlementReceiptAttemptsTable).values({
    organizationId: orgId,
    settlementId: opts.settlementId,
    recipientUserId: recipientId,
    payerName: "Payer",
    recipientName: "Recipient",
    recipientEmail: "rec@example.test",
    gameLabel: "Skins",
    currency: "INR",
    amount: "150.00",
    paymentMethod: "wallet",
    paymentRef: `ref-${opts.settlementId}`,
    paidAt: new Date(),
    emailStatus: opts.emailStatus ?? "sent",
    emailAttempts: opts.emailAttempts ?? 1,
    emailRetryExhaustedAt: opts.emailRetryExhaustedAt ?? null,
    pushStatus: opts.pushStatus ?? "sent",
    pushAttempts: opts.pushAttempts ?? 1,
    pushRetryExhaustedAt: opts.pushRetryExhaustedAt ?? null,
  }).returning({ id: sideGameSettlementReceiptAttemptsTable.id });
  attemptIds.push(a.id);
  return a.id;
}

beforeAll(async () => {
  const tag = uid("t1524");
  const [org] = await db.insert(organizationsTable).values({
    name: `T1524 ${tag}`,
    slug: tag,
    contactEmail: `${tag}@example.test`,
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  const [admin] = await db.insert(appUsersTable).values({
    replitUserId: `${tag}-admin`,
    username: `${tag}_admin`,
    email: `admin_${tag}@example.test`,
    displayName: "Receipt Digest Admin",
    role: "org_admin",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  adminId = admin.id;

  const [recipient] = await db.insert(appUsersTable).values({
    replitUserId: `${tag}-recipient`,
    username: `${tag}_recipient`,
    email: `recipient_${tag}@example.test`,
    displayName: "Receipt Recipient",
    role: "player",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  recipientId = recipient.id;

  const [inst] = await db.insert(sideGameInstancesTable).values({
    organizationId: orgId,
    gameType: "skins",
    name: "Digest CSV vs Dashboard",
    status: "completed",
  }).returning({ id: sideGameInstancesTable.id });
  instanceId = inst.id;

  const adminUser: TestUser = {
    id: adminId,
    username: "admin",
    role: "org_admin",
    organizationId: orgId,
  };
  app = createTestApp(adminUser);
});

afterAll(async () => {
  for (const id of attemptIds) {
    await db.delete(sideGameSettlementReceiptAttemptsTable)
      .where(eq(sideGameSettlementReceiptAttemptsTable.id, id));
  }
  for (const id of settlementIds) {
    await db.delete(sideGameSettlementsTable).where(eq(sideGameSettlementsTable.id, id));
  }
  await db.delete(sideGameInstancesTable).where(eq(sideGameInstancesTable.id, instanceId));
  await db.delete(sideGameReceiptDigestRunsTable).where(eq(sideGameReceiptDigestRunsTable.organizationId, orgId));
  await db.delete(sideGameReceiptDigestSchedulesTable).where(eq(sideGameReceiptDigestSchedulesTable.organizationId, orgId));
  await db.delete(appUsersTable).where(inArray(appUsersTable.id, [adminId, recipientId]));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
});

beforeEach(async () => {
  sendMock.mockClear();
  sendMock.mockImplementation(async () => {});
  for (const id of attemptIds.splice(0)) {
    await db.delete(sideGameSettlementReceiptAttemptsTable)
      .where(eq(sideGameSettlementReceiptAttemptsTable.id, id));
  }
  for (const id of settlementIds.splice(0)) {
    await db.delete(sideGameSettlementsTable)
      .where(eq(sideGameSettlementsTable.id, id));
  }
  await db.delete(sideGameReceiptDigestRunsTable).where(eq(sideGameReceiptDigestRunsTable.organizationId, orgId));
  await db.delete(sideGameReceiptDigestSchedulesTable).where(eq(sideGameReceiptDigestSchedulesTable.organizationId, orgId));

  const [s] = await db.insert(sideGameReceiptDigestSchedulesTable).values({
    organizationId: orgId,
    frequency: "weekly",
    recipients: ["support@example.test"],
    nextRunAt: new Date(),
  }).returning({ id: sideGameReceiptDigestSchedulesTable.id });
  scheduleId = s.id;
});

/**
 * Parse a CSV produced by `buildSideGameReceiptDigestCsv` into an
 * array of row objects keyed by header. The builder always quotes
 * every field and escapes embedded quotes by doubling them, so the
 * parser only needs to handle that subset.
 */
function parseDigestCsv(csv: string): Array<Record<string, string>> {
  const lines: string[] = [];
  let buf = "";
  let inQuotes = false;
  for (let i = 0; i < csv.length; i += 1) {
    const ch = csv[i];
    if (ch === '"') {
      if (inQuotes && csv[i + 1] === '"') { buf += '"'; i += 1; continue; }
      inQuotes = !inQuotes;
      continue;
    }
    if (ch === "\n" && !inQuotes) {
      lines.push(buf); buf = ""; continue;
    }
    buf += ch;
  }
  if (buf.length > 0) lines.push(buf);

  const splitRow = (line: string): string[] => {
    const out: string[] = [];
    let cell = "";
    let q = false;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (ch === '"') {
        if (q && line[i + 1] === '"') { cell += '"'; i += 1; continue; }
        q = !q; continue;
      }
      if (ch === "," && !q) { out.push(cell); cell = ""; continue; }
      cell += ch;
    }
    out.push(cell);
    return out;
  };

  if (lines.length === 0) return [];
  const header = splitRow(lines[0]);
  return lines.slice(1).map(line => {
    const cells = splitRow(line);
    const row: Record<string, string> = {};
    header.forEach((h, i) => { row[h] = cells[i] ?? ""; });
    return row;
  });
}

describe("Task #1524 — stuck-receipt digest CSV vs. admin dashboard parity", () => {
  it("emails the same set of stuck rows that the admin dashboard surfaces", async () => {
    // 1 healthy attempt — must NOT appear in either surface.
    const healthySettlement = await makeSettlement();
    await makeAttempt({ settlementId: healthySettlement });

    // 1 exhausted (email retry exhausted, push still healthy).
    const exhaustedEmailSettlement = await makeSettlement();
    const exhaustedEmailId = await makeAttempt({
      settlementId: exhaustedEmailSettlement,
      emailStatus: "failed",
      emailAttempts: 5,
      emailRetryExhaustedAt: new Date(),
    });

    // 1 skipped (push permanently skipped, no exhausted timestamp on
    // either channel — this is the "skipped" bucket per the dashboard's
    // counts.skipped vs. counts.exhausted split).
    const skippedSettlement = await makeSettlement();
    const skippedId = await makeAttempt({
      settlementId: skippedSettlement,
      pushStatus: "skipped",
    });

    // 1 fully exhausted (both channels exhausted) — counted as
    // "exhausted" (the dashboard increments exhausted whenever EITHER
    // retryExhaustedAt is non-null).
    const fullyExhaustedSettlement = await makeSettlement();
    const fullyExhaustedId = await makeAttempt({
      settlementId: fullyExhaustedSettlement,
      emailStatus: "failed",
      emailAttempts: 5,
      emailRetryExhaustedAt: new Date(),
      pushStatus: "failed",
      pushAttempts: 5,
      pushRetryExhaustedAt: new Date(),
    });

    // ── Run the digest end-to-end. The mocked mailer captures the
    //    CSV that would have been emailed to support.
    const result = await runOneSideGameReceiptDigestSchedule(scheduleId);
    expect(result.status).toBe("sent");
    expect(sendMock).toHaveBeenCalledTimes(1);
    const sendArgs = sendMock.mock.calls[0]?.[0];
    expect(sendArgs).toBeDefined();
    expect(typeof sendArgs!.csv).toBe("string");

    const csvRows = parseDigestCsv(sendArgs!.csv);
    const csvSettlementIds = csvRows.map(r => Number(r.settlement_id)).sort((a, b) => a - b);
    const csvExhaustedCount = csvRows.filter(r =>
      r.email_retry_exhausted_at !== "" || r.push_retry_exhausted_at !== "",
    ).length;
    const csvSkippedCount = csvRows.length - csvExhaustedCount;

    // ── Hit the admin dashboard endpoint for the same org.
    const dash = await request(app)
      .get(`/api/admin/side-game-receipt-failures?organizationId=${orgId}`);
    expect(dash.status).toBe(200);
    const body = dash.body as {
      items: Array<{ id: number; settlementId: number }>;
      counts: { total: number; exhausted: number; skipped: number };
    };
    const dashSettlementIds = body.items.map(i => i.settlementId).sort((a, b) => a - b);

    // ── Parity assertions.
    // The healthy attempt is excluded from BOTH surfaces, the three
    // stuck attempts appear in BOTH surfaces, and the
    // exhausted/skipped split agrees.
    const expectedSettlementIds = [
      exhaustedEmailSettlement, skippedSettlement, fullyExhaustedSettlement,
    ].sort((a, b) => a - b);
    expect(dashSettlementIds).toEqual(expectedSettlementIds);
    expect(csvSettlementIds).toEqual(expectedSettlementIds);

    expect(csvRows).toHaveLength(body.items.length);
    expect(csvRows).toHaveLength(3);

    expect(body.counts.total).toBe(3);
    expect(body.counts.exhausted).toBe(2);
    expect(body.counts.skipped).toBe(1);

    expect(sendArgs!.rowCount).toBe(body.counts.total);
    expect(sendArgs!.exhaustedCount).toBe(body.counts.exhausted);
    expect(sendArgs!.skippedCount).toBe(body.counts.skipped);

    expect(csvExhaustedCount).toBe(body.counts.exhausted);
    expect(csvSkippedCount).toBe(body.counts.skipped);

    // Sanity: each stuck attempt id surfaced by the dashboard should
    // map to the same settlement_id we wrote into the CSV.
    const dashIdToSettlement = new Map(body.items.map(i => [i.id, i.settlementId]));
    expect(dashIdToSettlement.get(exhaustedEmailId)).toBe(exhaustedEmailSettlement);
    expect(dashIdToSettlement.get(skippedId)).toBe(skippedSettlement);
    expect(dashIdToSettlement.get(fullyExhaustedId)).toBe(fullyExhaustedSettlement);
  });

  /**
   * Task #1874 — when there are MORE than the dashboard's default page
   * size of 200 stuck rows, the digest CSV must still match the union
   * of every dashboard page (and the org-wide counts the widget shows
   * in the badge / summary). Previously the dashboard hard-capped at
   * 200 rows while the CSV pulled up to 1000, so a real outage with
   * hundreds of stuck rows would silently drift the two surfaces apart
   * — the CSV would show the full list while admins triaging from the
   * dashboard would see only the most recent 200.
   *
   * This test seeds 220 stuck rows, pages through every dashboard page
   * via `?limit=&offset=`, and asserts the union equals the CSV's row
   * set (and that the org-wide counts on every page agree with the
   * CSV's row count and exhausted/skipped split).
   */
  it("dashboard pagination surfaces every stuck row the CSV does, even past 200", async () => {
    const TOTAL_STUCK = 220;
    const PAGE_SIZE = 50;

    // Seed `TOTAL_STUCK` stuck rows. We alternate between "exhausted"
    // and "skipped" so the counts split is non-trivial. A single batch
    // insert keeps the test fast.
    const settlementRows = await db.insert(sideGameSettlementsTable).values(
      Array.from({ length: TOTAL_STUCK }, () => ({
        instanceId,
        fromName: "Payer",
        toName: "Recipient",
        amount: "150.00",
        currency: "INR",
        status: "paid" as const,
        paidAt: new Date(),
      })),
    ).returning({ id: sideGameSettlementsTable.id });
    for (const s of settlementRows) settlementIds.push(s.id);

    const now = new Date();
    const seededAttemptRows = await db.insert(sideGameSettlementReceiptAttemptsTable).values(
      settlementRows.map((s, i) => {
        const exhausted = i % 2 === 0; // half exhausted, half skipped
        return {
          organizationId: orgId,
          settlementId: s.id,
          recipientUserId: recipientId,
          payerName: "Payer",
          recipientName: "Recipient",
          recipientEmail: "rec@example.test",
          gameLabel: "Skins",
          currency: "INR",
          amount: "150.00",
          paymentMethod: "wallet",
          paymentRef: `bulk-${s.id}`,
          paidAt: now,
          emailStatus: exhausted ? "failed" : "sent",
          emailAttempts: exhausted ? 5 : 1,
          emailRetryExhaustedAt: exhausted ? now : null,
          pushStatus: exhausted ? "sent" : "skipped",
          pushAttempts: 1,
          pushRetryExhaustedAt: null,
        };
      }),
    ).returning({ id: sideGameSettlementReceiptAttemptsTable.id });
    for (const a of seededAttemptRows) attemptIds.push(a.id);

    const expectedExhausted = Math.ceil(TOTAL_STUCK / 2);
    const expectedSkipped = TOTAL_STUCK - expectedExhausted;

    // ── Run the digest end-to-end. The mocked mailer captures the CSV
    //    that would have been emailed to support — this is the
    //    authoritative "every stuck row" view.
    const result = await runOneSideGameReceiptDigestSchedule(scheduleId);
    expect(result.status).toBe("sent");
    expect(sendMock).toHaveBeenCalledTimes(1);
    const sendArgs = sendMock.mock.calls[0]?.[0];
    expect(sendArgs).toBeDefined();

    const csvRows = parseDigestCsv(sendArgs!.csv);
    expect(csvRows).toHaveLength(TOTAL_STUCK);
    const csvSettlementIds = new Set(csvRows.map(r => Number(r.settlement_id)));

    // ── Page through the dashboard endpoint.
    const dashSettlementIds = new Set<number>();
    let offset = 0;
    let firstPageCounts: { total: number; exhausted: number; skipped: number } | null = null;
    let safety = 0;
    while (true) {
      safety += 1;
      if (safety > 100) throw new Error("dashboard paging did not terminate");
      const dash = await request(app)
        .get(`/api/admin/side-game-receipt-failures?organizationId=${orgId}&limit=${PAGE_SIZE}&offset=${offset}`);
      expect(dash.status).toBe(200);
      const body = dash.body as {
        items: Array<{ id: number; settlementId: number }>;
        counts: { total: number; exhausted: number; skipped: number };
        pagination: { limit: number; offset: number; hasMore: boolean };
      };
      for (const it of body.items) dashSettlementIds.add(it.settlementId);

      // Org-wide counts must be identical on every page (they are not
      // page-scoped — they describe the full stuck list).
      if (firstPageCounts === null) firstPageCounts = body.counts;
      else expect(body.counts).toEqual(firstPageCounts);

      expect(body.pagination.limit).toBe(PAGE_SIZE);
      expect(body.pagination.offset).toBe(offset);
      if (!body.pagination.hasMore) break;
      offset += PAGE_SIZE;
    }

    // ── Parity assertions.
    // 1) Every stuck settlement the CSV lists must surface across the
    //    paged dashboard responses (and vice-versa) — no row visible
    //    only in one surface.
    expect(dashSettlementIds.size).toBe(TOTAL_STUCK);
    expect(dashSettlementIds.size).toBe(csvSettlementIds.size);
    for (const sid of csvSettlementIds) {
      expect(dashSettlementIds.has(sid)).toBe(true);
    }

    // 2) The dashboard's org-wide counts must agree with the CSV's
    //    row count + exhausted/skipped split.
    expect(firstPageCounts).not.toBeNull();
    expect(firstPageCounts!.total).toBe(TOTAL_STUCK);
    expect(firstPageCounts!.exhausted).toBe(expectedExhausted);
    expect(firstPageCounts!.skipped).toBe(expectedSkipped);
    expect(sendArgs!.rowCount).toBe(firstPageCounts!.total);
    expect(sendArgs!.exhaustedCount).toBe(firstPageCounts!.exhausted);
    expect(sendArgs!.skippedCount).toBe(firstPageCounts!.skipped);

    const csvExhausted = csvRows.filter(r =>
      r.email_retry_exhausted_at !== "" || r.push_retry_exhausted_at !== "",
    ).length;
    expect(csvExhausted).toBe(expectedExhausted);
    expect(csvRows.length - csvExhausted).toBe(expectedSkipped);
  });
});
