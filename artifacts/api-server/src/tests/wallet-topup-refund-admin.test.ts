/**
 * Task #920 — admin dashboard listing auto-refunded wallet top-ups.
 *
 * Verifies the GET /api/admin/wallet-topup-refunds JSON endpoint and the
 * companion .csv export:
 *   - Authorisation: 401 anon, 403 non-admin, 200 for org_admin.
 *   - Filters: organizationId scope, member id, from/to date range.
 *   - Refund amount is read from the structured `audit_amount` column.
 *     Legacy rows (written before Task #1072) are populated by the
 *     Task #1239 backfill migration; this test seeds a NULL-amount row
 *     in the legacy shape and replays the same backfill SQL to prove
 *     it parses correctly.
 *   - CSV export contains the same rows in download form.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  clubWalletsTable,
  clubWalletTxnsTable,
  walletTopupRefundNotifyAttemptsTable,
} from "@workspace/db";
import { eq, inArray, sql } from "drizzle-orm";
import { createTestApp, type TestUser } from "./helpers.js";

let orgId: number;
let otherOrgId: number;
let adminId: number;
let memberAId: number;
let memberBId: number;
let walletAId: number;
let walletBId: number;
let walletOtherOrgId: number;

let admin: TestUser;
let nonAdmin: TestUser;

beforeAll(async () => {
  const ts = Date.now();
  const [org] = await db.insert(organizationsTable).values({
    name: `T920-${ts}`, slug: `t920-${ts}`, contactEmail: `t920-${ts}@example.test`,
  }).returning();
  orgId = org.id;
  const [other] = await db.insert(organizationsTable).values({
    name: `T920-other-${ts}`, slug: `t920-other-${ts}`, contactEmail: `t920-other-${ts}@example.test`,
  }).returning();
  otherOrgId = other.id;

  const [adminRow] = await db.insert(appUsersTable).values({
    replitUserId: `ep_t920_admin_${ts}`,
    username: `t920_admin_${ts}`,
    email: `admin_${ts}@example.test`,
    displayName: "Refund Admin",
    role: "org_admin",
    organizationId: orgId,
  }).returning();
  adminId = adminRow.id;

  const [a] = await db.insert(appUsersTable).values({
    replitUserId: `ep_t920_a_${ts}`, username: `t920_a_${ts}`,
    email: `a_${ts}@example.test`, displayName: "Alice Anderson",
    role: "player", organizationId: orgId,
  }).returning();
  memberAId = a.id;
  const [b] = await db.insert(appUsersTable).values({
    replitUserId: `ep_t920_b_${ts}`, username: `t920_b_${ts}`,
    email: `b_${ts}@example.test`, displayName: "Bob Baker",
    role: "player", organizationId: orgId,
  }).returning();
  memberBId = b.id;

  const [wA] = await db.insert(clubWalletsTable).values({
    organizationId: orgId, userId: memberAId, currency: "INR", balance: "0",
  }).returning();
  walletAId = wA.id;
  const [wB] = await db.insert(clubWalletsTable).values({
    organizationId: orgId, userId: memberBId, currency: "INR", balance: "0",
  }).returning();
  walletBId = wB.id;
  const [wOther] = await db.insert(clubWalletsTable).values({
    organizationId: otherOrgId, userId: memberAId, currency: "INR", balance: "0",
  }).returning();
  walletOtherOrgId = wOther.id;

  // Seed wallet_topup_refund audit rows.
  await db.insert(clubWalletTxnsTable).values([
    {
      // New-style row: refund amount lives in the structured
      // audit_amount column (Task #1072).
      walletId: walletAId, kind: "credit", amount: "0", currency: "INR",
      sourceType: "wallet_topup_refund", sourceId: "order_a1", paymentRef: "pay_a1",
      note: "Auto-refund of failed top-up — bank charged INR 750.00 but wallet credit was not applied",
      balanceAfter: "0",
      auditAmount: "750.00",
      createdAt: new Date("2026-04-10T12:00:00Z"),
    },
    {
      // Legacy-shape row written before audit_amount existed: seeded
      // with NULL audit_amount and then populated by replaying the
      // Task #1239 backfill SQL below, mirroring how the production
      // backfill migration recovers the amount from the note text.
      walletId: walletBId, kind: "credit", amount: "0", currency: "INR",
      sourceType: "wallet_topup_refund", sourceId: "order_b1", paymentRef: "pay_b1",
      note: "Auto-refund of failed top-up (already refunded at Razorpay) — INR 1,250.50",
      balanceAfter: "0",
      createdAt: new Date("2026-04-15T12:00:00Z"),
    },
    {
      // Legacy-shape row whose note doesn't include a parseable amount.
      // The backfill leaves audit_amount NULL, and the dashboard must
      // surface NULL rather than guessing.
      walletId: walletAId, kind: "credit", amount: "0", currency: "INR",
      sourceType: "wallet_topup_refund", sourceId: "order_a3", paymentRef: "pay_a3",
      note: "Auto-refund of failed top-up — bank reversal pending",
      balanceAfter: "0",
      createdAt: new Date("2026-04-08T12:00:00Z"),
    },
    // A non-refund row that must be ignored.
    {
      walletId: walletAId, kind: "credit", amount: "500", currency: "INR",
      sourceType: "wallet_topup_razorpay", sourceId: "order_a2", paymentRef: "pay_a2",
      note: "Top-up", balanceAfter: "500",
      createdAt: new Date("2026-04-12T12:00:00Z"),
    },
    // A refund row in a different org — must not leak into the response.
    {
      walletId: walletOtherOrgId, kind: "credit", amount: "0", currency: "INR",
      sourceType: "wallet_topup_refund", sourceId: "order_other", paymentRef: "pay_other",
      note: "Auto-refund of failed top-up — bank charged INR 99.00 but wallet credit was not applied",
      balanceAfter: "0",
      createdAt: new Date("2026-04-11T12:00:00Z"),
    },
  ]);

  // Replay the Task #1239 backfill SQL against the rows we just
  // inserted. In production this runs once at deploy time via
  // lib/db/drizzle/0103_wallet_topup_refund_audit_amount_backfill.sql;
  // running it here proves the parsing recovers the amount from a
  // legacy-shape note and is a no-op on rows that already carry a
  // structured audit_amount or whose note doesn't match.
  await db.execute(sql`
    UPDATE "club_wallet_txns"
       SET "audit_amount" = REPLACE(
             (regexp_match("note", '[A-Z]{3}[[:space:]]+([0-9,]+(\.[0-9]+)?)'))[1],
             ',', ''
           )::numeric(12, 2)
     WHERE "source_type" = 'wallet_topup_refund'
       AND "audit_amount" IS NULL
       AND "note" IS NOT NULL
       AND "note" ~ '[A-Z]{3}[[:space:]]+[0-9,]+(\.[0-9]+)?'
       AND "wallet_id" IN (${walletAId}, ${walletBId}, ${walletOtherOrgId})
  `);

  admin = { id: adminId, username: `t920_admin_${ts}`, displayName: "Refund Admin", role: "org_admin", organizationId: orgId };
  nonAdmin = { id: memberAId, username: `t920_a_${ts}`, displayName: "Alice", role: "player", organizationId: orgId };
});

afterAll(async () => {
  await db.delete(clubWalletTxnsTable).where(inArray(clubWalletTxnsTable.walletId, [walletAId, walletBId, walletOtherOrgId]));
  await db.delete(clubWalletsTable).where(inArray(clubWalletsTable.id, [walletAId, walletBId, walletOtherOrgId]));
  await db.delete(appUsersTable).where(inArray(appUsersTable.id, [adminId, memberAId, memberBId]));
  await db.delete(organizationsTable).where(inArray(organizationsTable.id, [orgId, otherOrgId]));
});

describe("GET /api/admin/wallet-topup-refunds", () => {
  it("rejects anonymous callers", async () => {
    const app = createTestApp();
    const res = await request(app).get(`/api/admin/wallet-topup-refunds?organizationId=${orgId}`);
    expect(res.status).toBe(401);
  });

  it("rejects non-admin members of the same org", async () => {
    const app = createTestApp(nonAdmin);
    const res = await request(app).get(`/api/admin/wallet-topup-refunds?organizationId=${orgId}`);
    expect(res.status).toBe(403);
  });

  it("returns auto-refund rows scoped to the org with parsed amounts and totals", async () => {
    const app = createTestApp(admin);
    const res = await request(app).get(`/api/admin/wallet-topup-refunds?organizationId=${orgId}`);
    expect(res.status).toBe(200);
    const items = res.body.items as Array<{ id: number; userId: number; memberName: string; amount: number | null; currency: string; paymentRef: string; note: string; refundedAt: string }>;
    expect(items).toHaveLength(3);
    // Sorted newest-first.
    expect(items[0].paymentRef).toBe("pay_b1");
    // Backfill recovered the amount from the legacy note text.
    expect(items[0].amount).toBeCloseTo(1250.5, 2);
    expect(items[0].memberName).toBe("Bob Baker");
    expect(items[1].paymentRef).toBe("pay_a1");
    expect(items[1].amount).toBeCloseTo(750, 2);
    // Legacy row whose note is unparseable surfaces a NULL amount
    // rather than guessing.
    expect(items[2].paymentRef).toBe("pay_a3");
    expect(items[2].amount).toBeNull();
    // Other-org row is excluded.
    expect(items.find(i => i.paymentRef === "pay_other")).toBeUndefined();
    // Non-refund row is excluded.
    expect(items.find(i => i.paymentRef === "pay_a2")).toBeUndefined();

    expect(res.body.totalsByCurrency.INR.count).toBe(3);
    // Unparseable row contributes to the count but not to the amount sum.
    expect(res.body.totalsByCurrency.INR.amount).toBeCloseTo(2000.5, 2);
  });

  it("filters by memberId", async () => {
    const app = createTestApp(admin);
    const res = await request(app).get(`/api/admin/wallet-topup-refunds?organizationId=${orgId}&memberId=${memberAId}`);
    expect(res.status).toBe(200);
    // Alice owns both the new-style row (pay_a1) and the unparseable
    // legacy row (pay_a3). Sorted newest-first.
    expect(res.body.items).toHaveLength(2);
    expect(res.body.items[0].paymentRef).toBe("pay_a1");
    expect(res.body.items[1].paymentRef).toBe("pay_a3");
  });

  it("filters by name or email via the q search box", async () => {
    const app = createTestApp(admin);

    // Partial, case-insensitive name match — Alice owns two refund rows.
    const r1 = await request(app).get(`/api/admin/wallet-topup-refunds?organizationId=${orgId}&q=alice`);
    expect(r1.status).toBe(200);
    expect(r1.body.items).toHaveLength(2);
    expect(r1.body.items[0].paymentRef).toBe("pay_a1");
    expect(r1.body.items[0].memberName).toBe("Alice Anderson");
    expect(r1.body.items[1].paymentRef).toBe("pay_a3");

    // Partial, case-insensitive email match.
    const r2 = await request(app).get(`/api/admin/wallet-topup-refunds?organizationId=${orgId}&q=B_`);
    expect(r2.status).toBe(200);
    expect(r2.body.items).toHaveLength(1);
    expect(r2.body.items[0].paymentRef).toBe("pay_b1");

    // Whitespace-only q is ignored, returning all rows.
    const r3 = await request(app).get(`/api/admin/wallet-topup-refunds?organizationId=${orgId}&q=%20%20`);
    expect(r3.status).toBe(200);
    expect(r3.body.items).toHaveLength(3);

    // No matches => empty list.
    const r4 = await request(app).get(`/api/admin/wallet-topup-refunds?organizationId=${orgId}&q=zzz-no-match`);
    expect(r4.status).toBe(200);
    expect(r4.body.items).toHaveLength(0);
  });

  it("filters by date range", async () => {
    const app = createTestApp(admin);
    const res = await request(app).get(`/api/admin/wallet-topup-refunds?organizationId=${orgId}&from=2026-04-12T00:00:00Z&to=2026-04-20T00:00:00Z`);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].paymentRef).toBe("pay_b1");
  });

  // Task #1862 — admin endpoint folds the matching
  // wallet_topup_refund_notify_attempts row onto each refund as a
  // `delivery` block so support staff can see whether the
  // SMS/WhatsApp alert ever went out, plus the most recent provider
  // error for failed/exhausted rows. This is the admin counterpart
  // to the member-facing `delivery` field on `GET /wallet`, and the
  // admin variant uniquely includes `lastError` on every channel.
  describe("Task #1862 — per-refund delivery status", () => {
    const seededPaymentIds = ["pay_a1", "pay_b1", "pay_a3"];

    beforeAll(async () => {
      // pay_a1 — happy path: every channel sent successfully.
      await db.insert(walletTopupRefundNotifyAttemptsTable).values({
        paymentId: "pay_a1",
        organizationId: orgId,
        userId: memberAId,
        currency: "INR",
        amount: "750.00",
        emailStatus: "sent",
        emailAttempts: 1,
        lastEmailAt: new Date("2026-04-10T12:01:00Z"),
        pushStatus: "sent",
        pushAttempts: 1,
        lastPushAt: new Date("2026-04-10T12:01:01Z"),
        smsStatus: "sent",
        smsAttempts: 1,
        lastSmsAt: new Date("2026-04-10T12:01:02Z"),
        whatsappStatus: "sent",
        whatsappAttempts: 1,
        lastWhatsappAt: new Date("2026-04-10T12:01:03Z"),
      });
      // pay_b1 — mixed: SMS exhausted (with lastError), WhatsApp
      // retrying, push transient-failed, email skipped because the
      // member has no verified address on file.
      await db.insert(walletTopupRefundNotifyAttemptsTable).values({
        paymentId: "pay_b1",
        organizationId: orgId,
        userId: memberBId,
        currency: "INR",
        amount: "1250.50",
        emailStatus: "no_address",
        emailAttempts: 0,
        pushStatus: "failed",
        pushAttempts: 1,
        lastPushAt: new Date("2026-04-15T12:00:01Z"),
        lastPushError: "FCM 500 internal",
        smsStatus: "failed",
        smsAttempts: 5,
        lastSmsAt: new Date("2026-04-15T12:30:00Z"),
        smsRetryExhaustedAt: new Date("2026-04-15T12:30:00Z"),
        lastSmsError: "Twilio code 30007 (carrier filtered)",
        whatsappStatus: "failed",
        whatsappAttempts: 2,
        lastWhatsappAt: new Date("2026-04-15T12:10:00Z"),
        nextWhatsappRetryAt: new Date("2026-04-15T12:25:00Z"),
        lastWhatsappError: "Meta 131026 (undeliverable)",
      });
      // pay_a3 deliberately has NO notify-attempts row — proves the
      // endpoint surfaces `delivery: null` for refunds whose alert
      // pipeline never spun up (e.g. legacy refunds from before the
      // notify table existed).
    });

    afterAll(async () => {
      await db.delete(walletTopupRefundNotifyAttemptsTable)
        .where(inArray(walletTopupRefundNotifyAttemptsTable.paymentId, seededPaymentIds));
    });

    it("includes a four-channel `delivery` block on each row, with `lastError` populated for admins", async () => {
      const app = createTestApp(admin);
      const res = await request(app).get(`/api/admin/wallet-topup-refunds?organizationId=${orgId}`);
      expect(res.status).toBe(200);
      const items = res.body.items as Array<{
        paymentRef: string;
        delivery: {
          email: { status: string | null; attempts: number; lastError: string | null };
          push: { status: string | null; attempts: number; lastError: string | null };
          sms: { status: string | null; attempts: number; lastError: string | null };
          whatsapp: { status: string | null; attempts: number; lastError: string | null };
        } | null;
      }>;

      const a1 = items.find(i => i.paymentRef === "pay_a1");
      expect(a1?.delivery).not.toBeNull();
      expect(a1!.delivery!.email.status).toBe("sent");
      expect(a1!.delivery!.push.status).toBe("sent");
      expect(a1!.delivery!.sms.status).toBe("sent");
      expect(a1!.delivery!.whatsapp.status).toBe("sent");
      // Admin variant always includes lastError, even when null on
      // the happy path — defence in depth so the front-end can tell
      // "no error" from "the field was redacted".
      expect(a1!.delivery!.email.lastError).toBeNull();
      expect(a1!.delivery!.sms.lastError).toBeNull();

      const b1 = items.find(i => i.paymentRef === "pay_b1");
      expect(b1?.delivery).not.toBeNull();
      // Email skipped because the member has no verified address on
      // file — the cron records a `no_address` row rather than a
      // null one so the dashboard can distinguish "skipped" from
      // "we never tried".
      expect(b1!.delivery!.email.status).toBe("skipped");
      expect(b1!.delivery!.push.status).toBe("failed");
      expect(b1!.delivery!.push.lastError).toBe("FCM 500 internal");
      expect(b1!.delivery!.sms.status).toBe("exhausted");
      expect(b1!.delivery!.sms.attempts).toBe(5);
      expect(b1!.delivery!.sms.lastError).toBe("Twilio code 30007 (carrier filtered)");
      expect(b1!.delivery!.whatsapp.status).toBe("retrying");
      expect(b1!.delivery!.whatsapp.lastError).toBe("Meta 131026 (undeliverable)");

      const a3 = items.find(i => i.paymentRef === "pay_a3");
      expect(a3).toBeDefined();
      expect(a3!.delivery).toBeNull();
    });
  });

  it("400s on invalid filter values", async () => {
    const app = createTestApp(admin);
    const r1 = await request(app).get(`/api/admin/wallet-topup-refunds?organizationId=${orgId}&from=not-a-date`);
    expect(r1.status).toBe(400);
    const r2 = await request(app).get(`/api/admin/wallet-topup-refunds?organizationId=${orgId}&memberId=abc`);
    expect(r2.status).toBe(400);
    const r3 = await request(app).get(`/api/admin/wallet-topup-refunds`);
    expect(r3.status).toBe(400);
    const r4 = await request(app).get(`/api/admin/wallet-topup-refunds?organizationId=${orgId}&from=2026-04-20T00:00:00Z&to=2026-04-10T00:00:00Z`);
    expect(r4.status).toBe(400);
    expect(r4.body.error).toMatch(/before/i);
  });
});

describe("GET /api/admin/wallet-topup-refunds.csv", () => {
  it("rejects non-admins", async () => {
    const app = createTestApp(nonAdmin);
    const res = await request(app).get(`/api/admin/wallet-topup-refunds.csv?organizationId=${orgId}`);
    expect(res.status).toBe(403);
  });

  it("downloads a CSV containing the refund rows", async () => {
    const app = createTestApp(admin);
    const res = await request(app).get(`/api/admin/wallet-topup-refunds.csv?organizationId=${orgId}`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/csv/);
    expect(res.headers["content-disposition"]).toMatch(/wallet-topup-refunds-/);
    const body = res.text;
    expect(body).toContain("pay_a1");
    expect(body).toContain("pay_b1");
    expect(body).toContain("Alice Anderson");
    expect(body).toContain("Bob Baker");
    expect(body).toContain("750.00");
    expect(body).toContain("1250.50");
    expect(body).not.toContain("pay_other");
  });

  // Task #2156 — pin the date-stamped filename so the dashboard
  // download lines up with the digest email attachment built by
  // `buildWalletTopupRefundScheduleEmailContent` (also
  // `wallet-topup-refunds-YYYY-MM-DD.csv`). The previous
  // `wallet-topup-refunds-<orgId>.csv` form used the numeric org
  // ID — meaningless to humans and identical across every download,
  // so successive period downloads silently overwrote each other in
  // treasurers' archive folders. With a date range scoped on the
  // request we encode both bounds (`from_to`) so the period still
  // self-describes; without a range we fall back to today's request
  // date, mirroring the digest's single-date convention exactly.
  it("date-stamps the download filename, matching the digest email attachment", async () => {
    const app = createTestApp(admin);
    // The route stamps the filename with `new Date()` per request,
    // so an exact equality check could flake on a UTC-midnight
    // rollover between the test computing `today` and the server
    // computing its stamp. Sample today *before* and *after* each
    // request; either YYYY-MM-DD value is a valid stamp because the
    // request actually happened in that window.
    const today = () => new Date().toISOString().slice(0, 10);
    const acceptable = (before: string, after: string, build: (stamp: string) => string): string[] =>
      Array.from(new Set([before, after])).map(build);

    // No date range → today's request date, single stamp (matches
    // the digest email attachment naming convention exactly).
    const beforeNoRange = today();
    const noRange = await request(app).get(`/api/admin/wallet-topup-refunds.csv?organizationId=${orgId}`);
    const afterNoRange = today();
    expect(noRange.status).toBe(200);
    expect(acceptable(beforeNoRange, afterNoRange, d => `attachment; filename="wallet-topup-refunds-${d}.csv"`))
      .toContain(noRange.headers["content-disposition"]);
    // The numeric org-id suffix (the old format) must not leak back.
    expect(noRange.headers["content-disposition"]).not.toContain(`-${orgId}.csv`);

    // Both bounds set → encode the explicit range so the file name
    // self-describes the period. No `new Date()` involved server-side,
    // so this case is fully deterministic.
    const both = await request(app).get(
      `/api/admin/wallet-topup-refunds.csv?organizationId=${orgId}` +
      `&from=2026-04-01T00:00:00Z&to=2026-04-30T00:00:00Z`,
    );
    expect(both.status).toBe(200);
    expect(both.headers["content-disposition"]).toBe(
      `attachment; filename="wallet-topup-refunds-2026-04-01_2026-04-30.csv"`,
    );

    // Only `from` → close the open end with today so successive
    // open-ended downloads don't all collide on the same name.
    // Same midnight-rollover guard as the no-range case.
    const beforeFromOnly = today();
    const fromOnly = await request(app).get(
      `/api/admin/wallet-topup-refunds.csv?organizationId=${orgId}` +
      `&from=2026-04-01T00:00:00Z`,
    );
    const afterFromOnly = today();
    expect(fromOnly.status).toBe(200);
    expect(acceptable(beforeFromOnly, afterFromOnly, d => `attachment; filename="wallet-topup-refunds-2026-04-01_${d}.csv"`))
      .toContain(fromOnly.headers["content-disposition"]);

    // Only `to` → use that bound directly (digest-style single stamp).
    // No `new Date()` involved server-side, so deterministic.
    const toOnly = await request(app).get(
      `/api/admin/wallet-topup-refunds.csv?organizationId=${orgId}` +
      `&to=2026-04-30T00:00:00Z`,
    );
    expect(toOnly.status).toBe(200);
    expect(toOnly.headers["content-disposition"]).toBe(
      `attachment; filename="wallet-topup-refunds-2026-04-30.csv"`,
    );
  });

  // Task #1744 — pin the localised dashboard CSV column headers for EN
  // (default fallback) and a non-EN locale. The dashboard download used
  // to emit English-only snake_case headers (`refunded_at`, ...) while
  // the email-attached digest CSV (Task #1435) translated them, leading
  // to an inconsistent treasurer experience. Headers now follow the
  // org's `defaultLanguage` via `translateWalletTopupRefundCsvHeaders`,
  // matching the digest. Column *order* stays fixed so any downstream
  // parser that keys off position keeps working.
  it("translates the column headers to the org's defaultLanguage (EN default + Spanish)", async () => {
    const app = createTestApp(admin);

    // EN baseline — `default_language` defaults to "en" on the
    // organisations table (NOT NULL column), and any unsupported code
    // also falls back to English via `translateWalletTopupRefundCsvHeaders`.
    await db.update(organizationsTable)
      .set({ defaultLanguage: "en" })
      .where(eq(organizationsTable.id, orgId));
    const enRes = await request(app).get(`/api/admin/wallet-topup-refunds.csv?organizationId=${orgId}`);
    expect(enRes.status).toBe(200);
    const enHeader = enRes.text.split("\n")[0];
    expect(enHeader).toBe([
      `"Refunded at"`,
      `"Member ID"`,
      `"Member name"`,
      `"Member email"`,
      `"Amount"`,
      `"Currency"`,
      `"Payment ID"`,
      `"Order ID"`,
      `"Note"`,
    ].join(","));

    // Switch the org to Spanish; the header labels translate but the
    // column order is unchanged so position-based parsers still work.
    await db.update(organizationsTable)
      .set({ defaultLanguage: "es" })
      .where(eq(organizationsTable.id, orgId));
    const esRes = await request(app).get(`/api/admin/wallet-topup-refunds.csv?organizationId=${orgId}`);
    expect(esRes.status).toBe(200);
    const esHeader = esRes.text.split("\n")[0];
    expect(esHeader).toBe([
      `"Reembolsado el"`,
      `"ID del miembro"`,
      `"Nombre del miembro"`,
      `"Correo del miembro"`,
      `"Importe"`,
      `"Moneda"`,
      `"ID de pago"`,
      `"ID de pedido"`,
      `"Nota"`,
    ].join(","));

    // Reset for any later tests / re-runs.
    await db.update(organizationsTable)
      .set({ defaultLanguage: "en" })
      .where(eq(organizationsTable.id, orgId));
  });
});
