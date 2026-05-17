/**
 * Tests for Task #1734 — one-click "Mute this alert" footer link on
 * the two new digest-failure alert emails.
 *
 * Covers:
 *   - HMAC token round-trip + TTL rejection (sign / verify).
 *   - GET /api/public/notification-event-mute flips the matching
 *     `userNotificationPrefs` column to false AND writes a
 *     `notification_audit_log` row with reason
 *     `event_opted_out_via_email_link` and direction `unsubscribe`.
 *     The re-subscribe path writes a row with reason
 *     `event_opted_in_via_email_link` for audit/analytics clarity.
 *   - GET /api/public/notification-event-resubscribe flips the column
 *     back to true AND writes a second audit row with direction
 *     `resubscribe`.
 *   - Invalid / forged tokens 400 without touching the prefs row.
 *   - Both supported slugs (`wrdf` → wallet, `srdf` → side-game) hit
 *     their own column.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import express from "express";
import {
  db,
  appUsersTable,
  organizationsTable,
  userNotificationPrefsTable,
  notificationAuditLogTable,
} from "@workspace/db";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  signEventMuteToken,
  verifyEventMuteToken,
  EVENT_MUTE_TOKEN_DEFAULT_TTL_SECONDS,
} from "../lib/bouncedDigestUnsubscribe.js";
import publicRouter from "../routes/public.js";

const createdOrgIds: number[] = [];
const createdUserIds: number[] = [];

let walletUserId: number;
let receiptUserId: number;
let orgId: number;

beforeAll(async () => {
  // Defensive — schema columns added in pre-1734 migrations may not
  // exist on the local test db when this file runs in isolation. The
  // upsert in the route inserts the full schema column list (with
  // `default` for everything except the dynamic field), so any
  // missing column 42703s the whole statement.
  const cols = [
    "prefer_email", "prefer_push", "prefer_sms", "prefer_whatsapp",
    "notify_member_documents", "notify_committee_peer_digest",
    "notify_side_game_receipts", "notify_manual_entry_alerts",
    "notify_coach_payout_account_changes", "notify_admin_payout_reverify",
    "notify_data_export_expiring", "notify_erasure_storage_digest",
    "notify_erasure_storage_digest_push", "notify_member_prefs_digest",
    "notify_wallet_refund_digest_failed", "notify_side_game_receipt_digest_failed",
    "notify_silent_alerts_digest",
  ];
  for (const c of cols) {
    await db.execute(sql.raw(`ALTER TABLE user_notification_prefs ADD COLUMN IF NOT EXISTS ${c} boolean NOT NULL DEFAULT true`));
  }
  await db.execute(sql`ALTER TABLE user_notification_prefs ADD COLUMN IF NOT EXISTS digest_mode text NOT NULL DEFAULT 'individual'`);
  await db.execute(sql`ALTER TABLE user_notification_prefs ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now()`);
  // Some installs of `prefer_sms` / `prefer_whatsapp` default false rather
  // than true — re-set defaults so the columns added above match the
  // schema's actual defaults. Idempotent on subsequent runs.
  await db.execute(sql`ALTER TABLE user_notification_prefs ALTER COLUMN prefer_sms SET DEFAULT false`);
  await db.execute(sql`ALTER TABLE user_notification_prefs ALTER COLUMN prefer_whatsapp SET DEFAULT false`);

  const tag = `event-mute-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const [org] = await db.insert(organizationsTable).values({
    name: `Event Mute Org ${tag}`,
    slug: tag,
  }).returning({ id: organizationsTable.id });
  orgId = org.id;
  createdOrgIds.push(org.id);

  const [u1] = await db.insert(appUsersTable).values({
    replitUserId: `${tag}-wallet`,
    username: `${tag}_wallet`,
    displayName: "Wallet Admin",
    email: `${tag}-wallet@example.com`,
    role: "org_admin",
  }).returning({ id: appUsersTable.id });
  walletUserId = u1.id;
  createdUserIds.push(u1.id);

  const [u2] = await db.insert(appUsersTable).values({
    replitUserId: `${tag}-receipt`,
    username: `${tag}_receipt`,
    displayName: "Receipt Admin",
    email: `${tag}-receipt@example.com`,
    role: "org_admin",
  }).returning({ id: appUsersTable.id });
  receiptUserId = u2.id;
  createdUserIds.push(u2.id);
});

afterAll(async () => {
  if (createdUserIds.length) {
    await db.delete(notificationAuditLogTable).where(inArray(notificationAuditLogTable.userId, createdUserIds));
    await db.delete(userNotificationPrefsTable).where(inArray(userNotificationPrefsTable.userId, createdUserIds));
    await db.delete(appUsersTable).where(inArray(appUsersTable.id, createdUserIds));
  }
  if (createdOrgIds.length) {
    await db.delete(organizationsTable).where(inArray(organizationsTable.id, createdOrgIds));
  }
});

function buildPublicApp() {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());
  app.use("/api/public", publicRouter);
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const cause = (err as Error & { cause?: Error }).cause;
    // eslint-disable-next-line no-console
    console.error("[event-mute test] route threw:", err.message);
    if (cause) {
      // eslint-disable-next-line no-console
      console.error("[event-mute test] cause:", cause.message, JSON.stringify(cause));
    }
    res.status(500).type("text").send(err.message);
  });
  return app;
}

describe("Task #1734 — event-mute token sign/verify", () => {
  it("round-trips userId, slug, orgId, iat", () => {
    const issuedAt = new Date("2025-01-01T00:00:00Z");
    const token = signEventMuteToken(42, "wrdf", 7, issuedAt);
    const parsed = verifyEventMuteToken(token, { now: issuedAt });
    expect(parsed).toEqual({
      userId: 42,
      slug: "wrdf",
      orgId: 7,
      iat: Math.floor(issuedAt.getTime() / 1000),
    });
  });

  it("rejects tokens older than the TTL", () => {
    const issuedAt = new Date("2025-01-01T00:00:00Z");
    const token = signEventMuteToken(1, "srdf", 1, issuedAt);
    // 1 second past the default TTL → reject.
    const tooLate = new Date(issuedAt.getTime() + (EVENT_MUTE_TOKEN_DEFAULT_TTL_SECONDS + 1) * 1000);
    expect(verifyEventMuteToken(token, { now: tooLate })).toBeNull();
    // Inside the TTL → accept.
    const stillFresh = new Date(issuedAt.getTime() + (EVENT_MUTE_TOKEN_DEFAULT_TTL_SECONDS - 1) * 1000);
    expect(verifyEventMuteToken(token, { now: stillFresh })).not.toBeNull();
  });

  it("rejects malformed and tampered tokens", () => {
    expect(verifyEventMuteToken("")).toBeNull();
    expect(verifyEventMuteToken("not-a-real-token")).toBeNull();
    const good = signEventMuteToken(5, "wrdf", 1);
    // Flip the last byte of the signature.
    const decoded = Buffer.from(good, "base64url").toString("utf8");
    const tampered = Buffer.from(decoded.slice(0, -1) + (decoded.slice(-1) === "A" ? "B" : "A"), "utf8").toString("base64url");
    expect(verifyEventMuteToken(tampered)).toBeNull();
  });

  it("rejects slugs outside the allowed character set at sign time", () => {
    expect(() => signEventMuteToken(1, "WRDF", 1)).toThrow();
    expect(() => signEventMuteToken(1, "has-dash", 1)).toThrow();
    expect(() => signEventMuteToken(1, "", 1)).toThrow();
  });
});

describe("Task #1734 — public mute endpoint flips the prefs column + audits", () => {
  it("wallet.refund.digest.failed: GET mute flips notifyWalletRefundDigestFailed=false and audits", async () => {
    const app = buildPublicApp();
    const token = signEventMuteToken(walletUserId, "wrdf", orgId);

    const res = await request(app)
      .get(`/api/public/notification-event-mute?token=${encodeURIComponent(token)}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain("This alert is muted");

    const [prefs] = await db
      .select({ flag: userNotificationPrefsTable.notifyWalletRefundDigestFailed })
      .from(userNotificationPrefsTable)
      .where(eq(userNotificationPrefsTable.userId, walletUserId));
    expect(prefs?.flag).toBe(false);

    const auditRows = await db
      .select({
        notificationKey: notificationAuditLogTable.notificationKey,
        userId: notificationAuditLogTable.userId,
        channel: notificationAuditLogTable.channel,
        status: notificationAuditLogTable.status,
        reason: notificationAuditLogTable.reason,
        payload: notificationAuditLogTable.payload,
      })
      .from(notificationAuditLogTable)
      .where(and(
        eq(notificationAuditLogTable.userId, walletUserId),
        eq(notificationAuditLogTable.notificationKey, "wallet.refund.digest.failed"),
      ))
      .orderBy(desc(notificationAuditLogTable.createdAt));
    expect(auditRows).toHaveLength(1);
    const row = auditRows[0];
    expect(row.channel).toBe("email");
    expect(row.status).toBe("skipped");
    expect(row.reason).toBe("event_opted_out_via_email_link");
    expect(row.payload).toMatchObject({
      source: "email_mute_link",
      direction: "unsubscribe",
      orgId,
      previousFlag: true,
    });
  });

  it("re-subscribe flips the same column back to true and writes a second audit row", async () => {
    const app = buildPublicApp();
    const token = signEventMuteToken(walletUserId, "wrdf", orgId);

    const res = await request(app)
      .get(`/api/public/notification-event-resubscribe?token=${encodeURIComponent(token)}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain("re-subscribed");

    const [prefs] = await db
      .select({ flag: userNotificationPrefsTable.notifyWalletRefundDigestFailed })
      .from(userNotificationPrefsTable)
      .where(eq(userNotificationPrefsTable.userId, walletUserId));
    expect(prefs?.flag).toBe(true);

    const auditRows = await db
      .select({ payload: notificationAuditLogTable.payload, reason: notificationAuditLogTable.reason })
      .from(notificationAuditLogTable)
      .where(and(
        eq(notificationAuditLogTable.userId, walletUserId),
        eq(notificationAuditLogTable.notificationKey, "wallet.refund.digest.failed"),
      ))
      .orderBy(desc(notificationAuditLogTable.createdAt));
    expect(auditRows.length).toBeGreaterThanOrEqual(2);
    const newest = auditRows[0];
    expect(newest.reason).toBe("event_opted_in_via_email_link");
    expect(newest.payload).toMatchObject({
      source: "email_mute_link",
      direction: "resubscribe",
      previousFlag: false,
    });
  });

  it("side_game.receipt.digest.failed: GET mute flips notifySideGameReceiptDigestFailed=false", async () => {
    const app = buildPublicApp();
    const token = signEventMuteToken(receiptUserId, "srdf", orgId);

    const res = await request(app)
      .get(`/api/public/notification-event-mute?token=${encodeURIComponent(token)}`);
    expect(res.status).toBe(200);

    const [prefs] = await db
      .select({ flag: userNotificationPrefsTable.notifySideGameReceiptDigestFailed })
      .from(userNotificationPrefsTable)
      .where(eq(userNotificationPrefsTable.userId, receiptUserId));
    expect(prefs?.flag).toBe(false);

    // The wallet column on this user must be untouched (different
    // recipient + different key).
    const [walletPrefs] = await db
      .select({ flag: userNotificationPrefsTable.notifyWalletRefundDigestFailed })
      .from(userNotificationPrefsTable)
      .where(eq(userNotificationPrefsTable.userId, receiptUserId));
    // No insert should have happened for wallet on this user; either
    // the row doesn't exist yet, or if it was created it should still
    // default to true.
    expect(walletPrefs?.flag ?? true).toBe(true);
  });

  it("invalid token returns 400 without touching prefs", async () => {
    const app = buildPublicApp();
    const before = await db
      .select({ flag: userNotificationPrefsTable.notifyWalletRefundDigestFailed })
      .from(userNotificationPrefsTable)
      .where(eq(userNotificationPrefsTable.userId, walletUserId));
    const res = await request(app)
      .get(`/api/public/notification-event-mute?token=not-a-real-token`);
    expect(res.status).toBe(400);
    expect(res.text).toContain("Invalid mute link");
    const after = await db
      .select({ flag: userNotificationPrefsTable.notifyWalletRefundDigestFailed })
      .from(userNotificationPrefsTable)
      .where(eq(userNotificationPrefsTable.userId, walletUserId));
    expect(after?.[0]?.flag ?? true).toBe(before?.[0]?.flag ?? true);
  });
});
