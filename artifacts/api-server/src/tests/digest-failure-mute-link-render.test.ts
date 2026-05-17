/**
 * Task #2155 — Smoke test that the per-recipient "Mute this alert" footer
 * link survives the dispatcher → mailer hand-off for both digest-failure
 * keys (`wallet.refund.digest.failed` and `side_game.receipt.digest.failed`).
 *
 * The end-to-end mute endpoint contract is already covered by
 * `event-mute-link.test.ts` (token round-trip + GET flips the prefs
 * column). What was missing is a test that asserts the rendered email
 * actually CARRIES a per-recipient mute URL and the RFC 2369 / 8058
 * `List-Unsubscribe` headers — without that assertion, a regression
 * that drops `eventMuteOrgId` from one of the dispatch sites in
 * `routes/side-games-v2.ts` (or stops forwarding `unsubscribeUrl` from
 * the dispatcher to the mailer) silently disables the mute link in
 * production.
 *
 * Strategy: stub the active mail provider's `send()` so we can capture
 * the rendered envelope (subject / html / text / extraHeaders), then
 * dispatch each digest-failure key through the real
 * `dispatchNotification` and assert:
 *   1. The plain-text body and the HTML body each contain a footer link
 *      to `/api/public/notification-event-mute?token=…`.
 *   2. The token verifies and decodes back to (recipient userId, the
 *      correct slug `wrdf` / `srdf`, dispatching org id).
 *   3. The `List-Unsubscribe` and `List-Unsubscribe-Post` headers are
 *      attached.
 *
 * `lib/push.js` is mocked so the suite never tries to talk to Expo.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

// SESSION_SECRET must be set BEFORE the dispatcher's signing helper is
// imported; otherwise `signEventMuteToken` throws and the dispatcher
// silently skips the mute link, defeating the point of this test.
process.env.SESSION_SECRET ||= "test-session-secret-for-digest-failure-mute-link-render";

vi.mock("../lib/push.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/push.js")>();
  return {
    ...actual,
    sendPushToUsers: vi.fn(async (uids: number[]) => ({
      attempted: uids.length, sent: uids.length, failed: 0, invalid: 0,
    })),
  };
});

import {
  db,
  appUsersTable,
  organizationsTable,
  notificationAuditLogTable,
  userNotificationPrefsTable,
} from "@workspace/db";
import { eq, inArray, sql } from "drizzle-orm";
import {
  getActiveMailProvider,
  type MailProvider,
  type SendResult,
  type TransactionalEmail,
} from "../lib/email/adapter.js";
import {
  dispatchNotification,
  _clearSpecCacheForTests,
} from "../lib/notifyDispatch.js";
import { hydrate as hydrateRegistry } from "../lib/notificationRegistry.js";
import { verifyEventMuteToken } from "../lib/bouncedDigestUnsubscribe.js";
import { uid } from "./helpers.js";

let captured: TransactionalEmail[] = [];
let originalSend: MailProvider["send"];
let originalConfigured: MailProvider["isConfigured"];

let orgId: number;
let walletUserId: number;
let receiptUserId: number;

beforeAll(async () => {
  // Defensive — keep in lockstep with `event-mute-link.test.ts`. The
  // dispatcher's `loadPrefs()` SELECTs the per-event opt-out columns
  // for these two keys, and a missing column 42703s the whole select.
  const cols = [
    "prefer_email", "prefer_push", "prefer_sms", "prefer_whatsapp",
    "notify_wallet_refund_digest_failed",
    "notify_side_game_receipt_digest_failed",
  ];
  for (const c of cols) {
    await db.execute(sql.raw(`ALTER TABLE user_notification_prefs ADD COLUMN IF NOT EXISTS ${c} boolean NOT NULL DEFAULT true`));
  }
  await db.execute(sql`ALTER TABLE user_notification_prefs ADD COLUMN IF NOT EXISTS digest_mode text NOT NULL DEFAULT 'individual'`);

  // Stub the active mail provider so every send is captured in-memory.
  const provider = getActiveMailProvider();
  originalSend = provider.send.bind(provider);
  originalConfigured = provider.isConfigured.bind(provider);
  (provider as { isConfigured: MailProvider["isConfigured"] }).isConfigured = () => true;
  (provider as { send: MailProvider["send"] }).send = async (msg) => {
    captured.push(msg);
    return { ok: true, provider: provider.name, messageId: "stub" } satisfies SendResult;
  };

  const tag = uid("t2155");
  const [org] = await db.insert(organizationsTable).values({
    name: `T2155 ${tag}`,
    slug: tag,
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  const [u1] = await db.insert(appUsersTable).values({
    replitUserId: `${tag}-wallet`,
    username: `${tag}_wallet`,
    displayName: "Wallet Refund Admin",
    email: `${tag}-wallet@example.test`,
    role: "org_admin",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  walletUserId = u1.id;

  const [u2] = await db.insert(appUsersTable).values({
    replitUserId: `${tag}-receipt`,
    username: `${tag}_receipt`,
    displayName: "Side Game Receipt Admin",
    email: `${tag}-receipt@example.test`,
    role: "org_admin",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  receiptUserId = u2.id;

  await hydrateRegistry();
  _clearSpecCacheForTests();
});

afterAll(async () => {
  // Restore the live mail provider before any other suite runs.
  const provider = getActiveMailProvider();
  (provider as { send: MailProvider["send"] }).send = originalSend;
  (provider as { isConfigured: MailProvider["isConfigured"] }).isConfigured = originalConfigured;

  if (walletUserId || receiptUserId) {
    const ids = [walletUserId, receiptUserId].filter(Boolean);
    await db.delete(notificationAuditLogTable).where(inArray(notificationAuditLogTable.userId, ids));
    await db.delete(userNotificationPrefsTable).where(inArray(userNotificationPrefsTable.userId, ids));
    await db.delete(appUsersTable).where(inArray(appUsersTable.id, ids));
  }
  if (orgId) {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
  }
});

function muteUrlFromText(text: string | undefined | null): URL | null {
  if (!text) return null;
  const match = text.match(/https?:\/\/[^\s"'<>]+\/api\/public\/notification-event-mute\?token=[A-Za-z0-9_=\-]+/);
  return match ? new URL(match[0]) : null;
}

function muteUrlFromHtml(html: string): URL | null {
  // Pull the href out of the footer anchor; tolerate either single or
  // double-quoted attribute styling.
  const match = html.match(/href=["'](https?:\/\/[^"']+\/api\/public\/notification-event-mute\?token=[A-Za-z0-9_=\-]+)["']/);
  return match ? new URL(match[1]) : null;
}

describe("Task #2155 — digest-failure emails render the per-recipient mute footer link", () => {
  it("wallet.refund.digest.failed: HTML body, plain-text body, and List-Unsubscribe headers all carry the per-recipient mute URL", async () => {
    captured = [];
    await dispatchNotification("wallet.refund.digest.failed", [walletUserId], {
      title: "Wallet refund digest failed",
      body: "The mailer rejected the send for schedule 1.",
      emailSubject: "Wallet refund digest failed",
      emailHtml: "<p>The mailer rejected the send for schedule 1.</p>",
      data: { scheduleId: 1, organizationId: orgId },
      branding: { orgName: "Test Club", orgId },
      eventMuteOrgId: orgId,
    });

    expect(captured).toHaveLength(1);
    const msg = captured[0];

    // 1. Plain-text body carries the mute URL.
    const textUrl = muteUrlFromText(msg.text);
    expect(textUrl, "plain-text body must contain the mute URL").not.toBeNull();

    // 2. HTML body carries the mute URL via an explicit <a href>.
    const htmlUrl = muteUrlFromHtml(msg.html);
    expect(htmlUrl, "HTML body must contain a footer <a> to the mute URL").not.toBeNull();
    expect(msg.html).toMatch(/Mute this alert/i);

    // The two URLs must point at the same per-recipient token, otherwise
    // the inbox-rendered link and the text-only fallback would mute
    // different keys.
    expect(htmlUrl!.href).toBe(textUrl!.href);

    // 3. Token verifies and decodes to (walletUserId, "wrdf", orgId).
    const token = htmlUrl!.searchParams.get("token");
    expect(token, "URL must carry a `token` query param").toBeTruthy();
    const decoded = verifyEventMuteToken(token!);
    expect(decoded).not.toBeNull();
    expect(decoded!.userId).toBe(walletUserId);
    expect(decoded!.slug).toBe("wrdf");
    expect(decoded!.orgId).toBe(orgId);

    // 4. RFC 2369 + RFC 8058 headers are attached, and the
    //    List-Unsubscribe header wraps the SAME per-recipient URL.
    expect(msg.extraHeaders).toBeDefined();
    expect(msg.extraHeaders!["List-Unsubscribe"]).toBe(`<${htmlUrl!.href}>`);
    expect(msg.extraHeaders!["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
  });

  it("side_game.receipt.digest.failed: HTML body, plain-text body, and List-Unsubscribe headers all carry the per-recipient mute URL", async () => {
    captured = [];
    await dispatchNotification("side_game.receipt.digest.failed", [receiptUserId], {
      title: "Side-game receipts digest failed",
      body: "Every recipient is on the suppression list.",
      emailSubject: "Side-game receipts digest failed",
      emailHtml: "<p>Every recipient is on the suppression list.</p>",
      data: { scheduleId: 2, organizationId: orgId },
      branding: { orgName: "Test Club", orgId },
      eventMuteOrgId: orgId,
    });

    expect(captured).toHaveLength(1);
    const msg = captured[0];

    const textUrl = muteUrlFromText(msg.text);
    expect(textUrl, "plain-text body must contain the mute URL").not.toBeNull();
    const htmlUrl = muteUrlFromHtml(msg.html);
    expect(htmlUrl, "HTML body must contain a footer <a> to the mute URL").not.toBeNull();
    expect(msg.html).toMatch(/Mute this alert/i);
    expect(htmlUrl!.href).toBe(textUrl!.href);

    const token = htmlUrl!.searchParams.get("token");
    expect(token).toBeTruthy();
    const decoded = verifyEventMuteToken(token!);
    expect(decoded).not.toBeNull();
    // The slug embedded in the per-recipient token is what the public
    // mute endpoint uses to route back to the correct prefs column.
    // Drifting it from `srdf` would silently mute the wrong key.
    expect(decoded!.userId).toBe(receiptUserId);
    expect(decoded!.slug).toBe("srdf");
    expect(decoded!.orgId).toBe(orgId);

    expect(msg.extraHeaders).toBeDefined();
    expect(msg.extraHeaders!["List-Unsubscribe"]).toBe(`<${htmlUrl!.href}>`);
    expect(msg.extraHeaders!["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
  });
});
