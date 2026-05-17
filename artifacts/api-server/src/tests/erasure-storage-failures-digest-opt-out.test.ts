/**
 * Tests for Task #1242 — per-user opt-out for the daily controller
 * "stuck erasure cleanup" digest (Task #1078).
 *
 * Covers:
 *   - A controller with `userNotificationPrefs.notifyErasureStorageDigest
 *     = false` is skipped, counted as `suppressed`, and never receives
 *     the email.
 *   - Other controllers in the same org still receive the digest.
 *   - The dispatched email carries a one-click unsubscribe link in both
 *     the body and the RFC 2369 `List-Unsubscribe` header.
 *   - The signed unsubscribe token round-trips through the public
 *     endpoint and flips the user's preference to false; tampering is
 *     rejected.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

// We use `importActual` + spread (rather than returning only the mocked
// names) because Task #1776's tests mount the full portal router via
// `createTestApp`, which transitively imports many other mailer
// functions (`sendBroadcastEmail`, `sendWithdrawalConfirmationEmail`,
// …) that would otherwise resolve to `undefined`. The three we DO mock
// are the only ones the test bodies need to assert against — every
// other mailer call from unrelated portal routes keeps its real
// implementation, but those routes are never hit in this suite.
vi.mock("../lib/mailer.js", async (importActual) => {
  const actual = await importActual<typeof import("../lib/mailer.js")>();
  return {
    ...actual,
    sendErasureStorageFailuresDigestEmail: vi.fn(async () => undefined),
    sendBouncedLevyDigestEmail: vi.fn(async () => undefined),
    // Task #1776 — confirmation email sent when a controller mutes the
    // stuck-erasure digest from the in-portal toggle. Mocked so the
    // tests can assert call args without invoking the real Postmark
    // adapter, which has no transport configured under vitest.
    sendErasureStorageDigestMutedConfirmationEmail: vi.fn(async () => undefined),
  };
});

import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  orgMembershipsTable,
  clubMembersTable,
  memberAuditLogTable,
  userNotificationPrefsTable,
  notificationAuditLogTable,
} from "@workspace/db";
import { eq, inArray, sql } from "drizzle-orm";
import express from "express";
import request from "supertest";

import { sendErasureStorageFailuresDigest } from "../lib/cron.js";
import { hydrate as hydrateRegistry } from "../lib/notificationRegistry.js";
import {
  sendErasureStorageFailuresDigestEmail,
  sendErasureStorageDigestMutedConfirmationEmail,
} from "../lib/mailer.js";
import {
  signErasureStorageDigestOptOutToken,
  verifyErasureStorageDigestOptOutToken,
  signErasureDigestMuteRevertToken,
  verifyErasureDigestMuteRevertToken,
} from "../lib/bouncedDigestUnsubscribe.js";
import publicRouter from "../routes/public.js";
import { createTestApp } from "./helpers.js";
import { ERASURE_DIGEST_MUTE_CONFIRMATION_THROTTLE_MS } from "../routes/portal.js";

const emailMock = vi.mocked(sendErasureStorageFailuresDigestEmail);
// Task #1776 — typed handle on the new mute-confirmation mailer so the
// tests can assert call args (channels, recipient, revert URL).
const muteConfirmMock = vi.mocked(sendErasureStorageDigestMutedConfirmationEmail);

const createdOrgIds: number[] = [];
const createdUserIds: number[] = [];
const createdMemberIds: number[] = [];

let userSeq = 0;
async function makeOrg(label: string): Promise<number> {
  const tag = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const [org] = await db.insert(organizationsTable).values({
    name: `ErasureOptOutTest_${label}_${tag}`,
    slug: `erasure-optout-${label}-${tag}`.toLowerCase(),
  }).returning({ id: organizationsTable.id });
  createdOrgIds.push(org.id);
  return org.id;
}

async function makeUser(opts: { email?: string | null; displayName?: string }): Promise<number> {
  userSeq += 1;
  const tag = `${Date.now()}_${userSeq}_${Math.random().toString(36).slice(2, 6)}`;
  const [u] = await db.insert(appUsersTable).values({
    replitUserId: `erasure-optout-${tag}`,
    username: `erasure_optout_${tag}`,
    email: opts.email ?? null,
    displayName: opts.displayName ?? null,
  }).returning({ id: appUsersTable.id });
  createdUserIds.push(u.id);
  return u.id;
}

async function makeController(
  orgId: number,
  role: "org_admin" | "membership_secretary" | "treasurer",
  email: string,
  displayName: string,
): Promise<number> {
  const userId = await makeUser({ email, displayName });
  await db.insert(orgMembershipsTable).values({ organizationId: orgId, userId, role });
  return userId;
}

async function makeMember(orgId: number, firstName = "Stuck"): Promise<number> {
  const [m] = await db.insert(clubMembersTable).values({
    organizationId: orgId, firstName, lastName: "Member",
  }).returning({ id: clubMembersTable.id });
  createdMemberIds.push(m.id);
  return m.id;
}

async function recordStuckErasure(orgId: number, memberId: number, failed: number) {
  await db.insert(memberAuditLogTable).values({
    organizationId: orgId, clubMemberId: memberId,
    entity: "club_member", entityId: memberId, action: "delete",
    actorName: "system", reason: "auto-erasure (cron)",
    metadata: {
      source: "cron", autoErasure: true, dataRequestId: 42,
      mediaTablesPurged: { media: 1 },
      objectStorageFilesDeleted: 0,
      objectStorageFilesMissing: 0,
      objectStorageFilesFailed: failed,
      objectStorageFilesFailedPaths: Array.from({ length: failed }, (_, i) => `/objects/${memberId}-${i}`),
      objectStorageDisabled: false,
    },
  });
}

let prevAppBaseUrl: string | undefined;
let prevSessionSecret: string | undefined;
beforeAll(async () => {
  prevAppBaseUrl = process.env.APP_BASE_URL;
  process.env.APP_BASE_URL = "https://test.kharagolf.com";
  prevSessionSecret = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = process.env.SESSION_SECRET ?? "test-session-secret-erasure-optout";

  await db.execute(sql`ALTER TABLE org_memberships ADD COLUMN IF NOT EXISTS vendor_operator_id integer`);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS member_audit_log (
      id serial PRIMARY KEY,
      club_member_id integer REFERENCES club_members(id) ON DELETE CASCADE,
      organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      actor_user_id integer REFERENCES app_users(id) ON DELETE SET NULL,
      actor_name text,
      actor_role text,
      entity text NOT NULL,
      entity_id integer,
      action text NOT NULL,
      field_changes jsonb,
      reason text,
      metadata jsonb,
      ip_address text,
      user_agent text,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`ALTER TABLE organizations ADD COLUMN IF NOT EXISTS erasure_storage_digest_last_sent_on text`);
  await db.execute(sql`ALTER TABLE user_notification_prefs ADD COLUMN IF NOT EXISTS notify_erasure_storage_digest boolean NOT NULL DEFAULT true`);
  // Task #1449 — split push-side opt-out for the same digest. Email
  // path keeps using `notify_erasure_storage_digest`; the
  // dispatcher's per-event opt-out moves to this new column so a
  // controller can mute push without losing the email (or vice versa).
  await db.execute(sql`ALTER TABLE user_notification_prefs ADD COLUMN IF NOT EXISTS notify_erasure_storage_digest_push boolean NOT NULL DEFAULT true`);
  // Task #1776 — rate-limit watermark for the in-portal mute confirmation
  // email. Nullable so a fresh row reads as "never sent" and the first
  // mute always emits a confirmation.
  await db.execute(sql`ALTER TABLE user_notification_prefs ADD COLUMN IF NOT EXISTS notify_erasure_storage_digest_mute_confirmation_last_sent_at timestamptz`);

  // Task #1449 — `dispatchNotification` asserts the key is registered;
  // because Vitest isolates each file with a fresh module graph, the
  // server-startup hydrate hook in `index.ts` doesn't run here. Hydrate
  // the registry explicitly so the cron's call to
  // `dispatchNotification("privacy.erasure.storage_failures.controller_digest", ...)`
  // can record the per-event opt-out audit rows the new test asserts on.
  await hydrateRegistry();
});

afterAll(async () => {
  if (prevAppBaseUrl === undefined) delete process.env.APP_BASE_URL;
  else process.env.APP_BASE_URL = prevAppBaseUrl;
  if (prevSessionSecret === undefined) delete process.env.SESSION_SECRET;
  else process.env.SESSION_SECRET = prevSessionSecret;

  if (createdUserIds.length) {
    await db.delete(userNotificationPrefsTable).where(inArray(userNotificationPrefsTable.userId, createdUserIds));
  }
  if (createdOrgIds.length) {
    await db.delete(memberAuditLogTable).where(inArray(memberAuditLogTable.organizationId, createdOrgIds));
  }
  if (createdMemberIds.length) {
    await db.delete(clubMembersTable).where(inArray(clubMembersTable.id, createdMemberIds));
  }
  if (createdUserIds.length) {
    await db.delete(orgMembershipsTable).where(inArray(orgMembershipsTable.userId, createdUserIds));
    await db.delete(appUsersTable).where(inArray(appUsersTable.id, createdUserIds));
  }
  if (createdOrgIds.length) {
    await db.delete(organizationsTable).where(inArray(organizationsTable.id, createdOrgIds));
  }
});

beforeEach(() => {
  emailMock.mockReset();
  emailMock.mockResolvedValue(undefined);
  muteConfirmMock.mockReset();
  muteConfirmMock.mockResolvedValue(undefined);
});

describe("sendErasureStorageFailuresDigest — per-user opt-out", () => {
  it("skips controllers with notifyErasureStorageDigest=false and still emails the rest", async () => {
    const orgId = await makeOrg("skip");
    const memberId = await makeMember(orgId);
    await recordStuckErasure(orgId, memberId, 2);

    const optedOutEmail = `optout-${orgId}@example.com`;
    const optedInEmail = `optin-${orgId}@example.com`;
    const optedOutUserId = await makeController(orgId, "treasurer", optedOutEmail, "Treasurer Tina");
    await makeController(orgId, "org_admin", optedInEmail, "Admin Alice");

    // Persist the opt-out before the cron runs.
    await db.insert(userNotificationPrefsTable).values({
      userId: optedOutUserId,
      notifyErasureStorageDigest: false,
    }).onConflictDoUpdate({
      target: userNotificationPrefsTable.userId,
      set: { notifyErasureStorageDigest: false, updatedAt: new Date() },
    });

    await sendErasureStorageFailuresDigest();

    const optedOutCalls = emailMock.mock.calls.filter(([arg]) => arg.to === optedOutEmail);
    const optedInCalls = emailMock.mock.calls.filter(([arg]) => arg.to === optedInEmail);
    expect(optedOutCalls).toHaveLength(0);
    expect(optedInCalls).toHaveLength(1);
    expect(optedInCalls[0][0].unsubscribeUrl).toMatch(
      /\/api\/public\/erasure-digest-unsubscribe\?token=/,
    );
  });

  // Task #1449 — independent per-channel mute. Pre-#1449 the cron and the
  // dispatcher both keyed on `notifyErasureStorageDigest`, so a controller
  // who silenced one channel implicitly silenced the other. After splitting
  // off `notifyErasureStorageDigestPush`, each channel can be muted
  // independently and the watermark must still burn so we don't re-poll
  // the same org later in the day.
  it("splits per-channel mute: email-on/push-off still emails but suppresses the in-app dispatch, and watermark stamps regardless", async () => {
    const orgId = await makeOrg("split");
    const memberId = await makeMember(orgId);
    await recordStuckErasure(orgId, memberId, 3);

    const emailOnlyAddr = `email-only-${orgId}@example.com`;
    const pushOnlyAddr = `push-only-${orgId}@example.com`;
    const allMutedAddr = `all-muted-${orgId}@example.com`;
    const emailOnlyId = await makeController(orgId, "treasurer", emailOnlyAddr, "Email Only");
    const pushOnlyId  = await makeController(orgId, "membership_secretary", pushOnlyAddr, "Push Only");
    const allMutedId  = await makeController(orgId, "org_admin", allMutedAddr, "All Muted");

    // email-on / push-off
    await db.insert(userNotificationPrefsTable).values({
      userId: emailOnlyId,
      notifyErasureStorageDigest: true,
      notifyErasureStorageDigestPush: false,
    }).onConflictDoUpdate({
      target: userNotificationPrefsTable.userId,
      set: { notifyErasureStorageDigest: true, notifyErasureStorageDigestPush: false, updatedAt: new Date() },
    });
    // email-off / push-on
    await db.insert(userNotificationPrefsTable).values({
      userId: pushOnlyId,
      notifyErasureStorageDigest: false,
      notifyErasureStorageDigestPush: true,
    }).onConflictDoUpdate({
      target: userNotificationPrefsTable.userId,
      set: { notifyErasureStorageDigest: false, notifyErasureStorageDigestPush: true, updatedAt: new Date() },
    });
    // both off
    await db.insert(userNotificationPrefsTable).values({
      userId: allMutedId,
      notifyErasureStorageDigest: false,
      notifyErasureStorageDigestPush: false,
    }).onConflictDoUpdate({
      target: userNotificationPrefsTable.userId,
      set: { notifyErasureStorageDigest: false, notifyErasureStorageDigestPush: false, updatedAt: new Date() },
    });

    await sendErasureStorageFailuresDigest();

    // Email-side: only the email-on controller is mailed; the email-off
    // controllers are skipped because the cron's email path keeps
    // honouring `notifyErasureStorageDigest`.
    expect(emailMock.mock.calls.filter(([a]) => a.to === emailOnlyAddr)).toHaveLength(1);
    expect(emailMock.mock.calls.filter(([a]) => a.to === pushOnlyAddr)).toHaveLength(0);
    expect(emailMock.mock.calls.filter(([a]) => a.to === allMutedAddr)).toHaveLength(0);

    // Push-side: dispatcher logs `event_opted_out` for the two
    // push-off controllers and `delivered`/`sent` for the push-on one.
    // We check the audit log because the inbox table is the dispatcher's
    // private storage; the audit row is the public contract that proves
    // the suppression was a deliberate per-user mute, not a lost message.
    const auditRows = await db.select({
      userId: notificationAuditLogTable.userId,
      status: notificationAuditLogTable.status,
      reason: notificationAuditLogTable.reason,
    }).from(notificationAuditLogTable)
      .where(inArray(notificationAuditLogTable.userId, [emailOnlyId, pushOnlyId, allMutedId]));

    const optedOutAudit = auditRows.filter(r => r.reason === "event_opted_out");
    const optedOutUserIds = new Set(optedOutAudit.map(r => r.userId));
    expect(optedOutUserIds.has(emailOnlyId)).toBe(true);
    expect(optedOutUserIds.has(allMutedId)).toBe(true);
    expect(optedOutUserIds.has(pushOnlyId)).toBe(false);

    // Watermark stamps regardless — even for the all-muted org we must
    // burn it so the next poll today doesn't re-attempt and grow the
    // suppression audit indefinitely.
    const [stamped] = await db.select({ stamp: organizationsTable.erasureStorageDigestLastSentOn })
      .from(organizationsTable).where(eq(organizationsTable.id, orgId));
    expect(stamped.stamp).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("sendErasureStorageFailuresDigestEmail — unsubscribe rendering", () => {
  it("emits a List-Unsubscribe header and footer link when an unsubscribeUrl is provided", async () => {
    vi.resetModules();
    vi.doMock("../lib/mailer.js", async (importActual) => {
      const actual = await importActual<typeof import("../lib/mailer.js")>();
      return actual;
    });
    const sendTxnMock = vi.fn(async () => ({ ok: true, provider: "test", messageId: "abc" }));
    vi.doMock("../lib/email/adapter.js", async (importActual) => {
      const actual = await importActual<typeof import("../lib/email/adapter.js")>();
      return {
        ...actual,
        sendTransactionalEmail: sendTxnMock,
        getActiveMailProvider: () => ({ name: "test", isConfigured: () => true }),
      };
    });

    const mailer = await import("../lib/mailer.js");
    await mailer.sendErasureStorageFailuresDigestEmail({
      to: "unsub@example.com",
      staffName: "Unsub Controller",
      baseUrl: "https://test.kharagolf.com",
      count: 1,
      totalFailedFiles: 2,
      items: [{
        clubMemberId: 7,
        auditId: 1,
        completedAt: new Date().toISOString(),
        objectStorageFilesFailed: 2,
        memberFirstName: "Unsub",
        memberLastName: "Member",
        memberNumber: "M-7",
        memberDeleted: false,
      }],
      unsubscribeUrl: "https://test.kharagolf.com/api/public/erasure-digest-unsubscribe?token=abc",
    });

    expect(sendTxnMock).toHaveBeenCalledTimes(1);
    const sendArg = (sendTxnMock.mock.calls[0] as unknown as Array<{
      html: string;
      extraHeaders?: Record<string, string>;
    }>)[0];
    expect(sendArg.html).toContain("erasure-digest-unsubscribe?token=abc");
    expect(sendArg.html).toContain("Unsubscribe with one click");
    expect(sendArg.extraHeaders?.["List-Unsubscribe"]).toBe(
      "<https://test.kharagolf.com/api/public/erasure-digest-unsubscribe?token=abc>",
    );
    expect(sendArg.extraHeaders?.["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");

    vi.doUnmock("../lib/email/adapter.js");
    vi.doUnmock("../lib/mailer.js");
    vi.resetModules();
  });
});

describe("erasure-digest-unsubscribe — HMAC token + public endpoint", () => {
  it("round-trips a valid token and rejects tampering", () => {
    const token = signErasureStorageDigestOptOutToken(123, 456);
    expect(verifyErasureStorageDigestOptOutToken(token)).toEqual({ userId: 123, orgId: 456 });
    expect(verifyErasureStorageDigestOptOutToken(token + "x")).toBeNull();
    expect(verifyErasureStorageDigestOptOutToken("not-a-token")).toBeNull();
    // A token signed with a different prefix (the bounced-digest schedule
    // token format) must not be accepted by the erasure verifier.
    expect(verifyErasureStorageDigestOptOutToken(
      Buffer.from("v1:123:456:badsig", "utf8").toString("base64url"),
    )).toBeNull();
  });

  it("flips notifyErasureStorageDigest to false on GET and back to true on resubscribe", async () => {
    const orgId = await makeOrg("endpoint");
    const userId = await makeUser({ email: `endpoint-${orgId}@example.com`, displayName: "Endpoint User" });
    await db.insert(orgMembershipsTable).values({ organizationId: orgId, userId, role: "org_admin" });

    const app = express();
    app.use(express.urlencoded({ extended: false }));
    app.use(express.json());
    app.use("/api/public", publicRouter);

    const token = signErasureStorageDigestOptOutToken(userId, orgId);

    // Unsubscribe — accepts GET (link click in email).
    const unsubRes = await request(app)
      .get(`/api/public/erasure-digest-unsubscribe?token=${encodeURIComponent(token)}`)
      .expect(200);
    expect(unsubRes.text).toMatch(/unsubscribed/i);
    let [pref] = await db.select({ flag: userNotificationPrefsTable.notifyErasureStorageDigest })
      .from(userNotificationPrefsTable)
      .where(eq(userNotificationPrefsTable.userId, userId));
    expect(pref?.flag).toBe(false);

    // Re-subscribe — restores the default opt-in state.
    const resubRes = await request(app)
      .get(`/api/public/erasure-digest-resubscribe?token=${encodeURIComponent(token)}`)
      .expect(200);
    expect(resubRes.text).toMatch(/re-subscribed/i);
    [pref] = await db.select({ flag: userNotificationPrefsTable.notifyErasureStorageDigest })
      .from(userNotificationPrefsTable)
      .where(eq(userNotificationPrefsTable.userId, userId));
    expect(pref?.flag).toBe(true);
  });

  it("rejects a malformed token with a 400 confirmation page", async () => {
    const app = express();
    app.use(express.urlencoded({ extended: false }));
    app.use(express.json());
    app.use("/api/public", publicRouter);

    const res = await request(app)
      .get(`/api/public/erasure-digest-unsubscribe?token=garbage`)
      .expect(400);
    expect(res.text).toMatch(/invalid/i);
  });

  it("accepts POST with token in the body for RFC 8058 one-click unsubscribe", async () => {
    const orgId = await makeOrg("oneclick");
    const userId = await makeUser({
      email: `oneclick-${orgId}@example.com`,
      displayName: "One-Click User",
    });
    await db.insert(orgMembershipsTable).values({ organizationId: orgId, userId, role: "org_admin" });

    const app = express();
    app.use(express.urlencoded({ extended: false }));
    app.use(express.json());
    app.use("/api/public", publicRouter);

    const token = signErasureStorageDigestOptOutToken(userId, orgId);

    await request(app)
      .post(`/api/public/erasure-digest-unsubscribe`)
      .type("form")
      .send({ "List-Unsubscribe": "One-Click", token })
      .expect(200);
    const [pref] = await db.select({ flag: userNotificationPrefsTable.notifyErasureStorageDigest })
      .from(userNotificationPrefsTable)
      .where(eq(userNotificationPrefsTable.userId, userId));
    expect(pref?.flag).toBe(false);
  });
});

// =====================================================================
// Task #1776 — In-portal mute confirmation email + signed revert link.
//
// The PATCH /portal/notification-preferences handler was the only path
// that could silence the daily controller "stuck erasure cleanup"
// digest (Task #1078) without leaving any visible record — it just
// flipped the row. After Task #1776 the same PATCH emits a one-time
// confirmation email (rate-limited) carrying a 7-day signed revert
// link. These tests cover the per-channel transition detection, the
// rate-limit watermark, and the public revert handler that flips the
// muted channels back without requiring a session.
// =====================================================================

describe("Task #1776 — PATCH /portal/notification-preferences mute confirmation email", () => {
  it("emits a confirmation email with channels='e' when only the email channel is muted true→false", async () => {
    const orgId = await makeOrg("mute-email");
    const userId = await makeController(orgId, "org_admin", `mute-email-${orgId}@example.com`, "Email Muter");
    const app = createTestApp({ id: userId, username: "u", role: "org_admin", organizationId: orgId });

    // Pre-condition: ensure the row exists with both channels on so the
    // PATCH below is a clean true→false on email only.
    await db.insert(userNotificationPrefsTable).values({
      userId,
      notifyErasureStorageDigest: true,
      notifyErasureStorageDigestPush: true,
    }).onConflictDoUpdate({
      target: userNotificationPrefsTable.userId,
      set: {
        notifyErasureStorageDigest: true,
        notifyErasureStorageDigestPush: true,
        notifyErasureStorageDigestMuteConfirmationLastSentAt: null,
        updatedAt: new Date(),
      },
    });

    const res = await request(app)
      .patch("/api/portal/notification-preferences")
      .send({ notifyErasureStorageDigest: false });
    expect(res.status).toBe(200);
    expect(res.body.notifyErasureStorageDigest).toBe(false);
    expect(res.body.notifyErasureStorageDigestPush).toBe(true);

    expect(muteConfirmMock).toHaveBeenCalledTimes(1);
    const arg = muteConfirmMock.mock.calls[0][0];
    expect(arg.to).toBe(`mute-email-${orgId}@example.com`);
    expect(arg.mutedChannels).toEqual({ email: true, push: false });
    // The revert URL must point at the public revert handler and carry
    // a token that decodes to (userId, channels="e") — that's the
    // contract the public handler relies on to know which channel(s)
    // to flip back.
    expect(arg.revertUrl).toMatch(/\/api\/public\/erasure-digest-portal-mute-revert\?token=/);
    const tokenInUrl = new URL(arg.revertUrl).searchParams.get("token") ?? "";
    const decoded = verifyErasureDigestMuteRevertToken(tokenInUrl);
    expect(decoded?.userId).toBe(userId);
    expect(decoded?.channels).toBe("e");

    // Watermark must stamp on a successful send so the rate-limit can
    // suppress an immediate re-mute (covered in a separate test).
    const [stamped] = await db.select({
      ts: userNotificationPrefsTable.notifyErasureStorageDigestMuteConfirmationLastSentAt,
    }).from(userNotificationPrefsTable).where(eq(userNotificationPrefsTable.userId, userId));
    expect(stamped.ts).toBeInstanceOf(Date);
  });

  it("emits a confirmation email with channels='p' when only the push channel is muted true→false", async () => {
    const orgId = await makeOrg("mute-push");
    const userId = await makeController(orgId, "membership_secretary", `mute-push-${orgId}@example.com`, "Push Muter");
    const app = createTestApp({ id: userId, username: "u", role: "membership_secretary", organizationId: orgId });

    await db.insert(userNotificationPrefsTable).values({
      userId,
      notifyErasureStorageDigest: true,
      notifyErasureStorageDigestPush: true,
    }).onConflictDoUpdate({
      target: userNotificationPrefsTable.userId,
      set: {
        notifyErasureStorageDigest: true,
        notifyErasureStorageDigestPush: true,
        notifyErasureStorageDigestMuteConfirmationLastSentAt: null,
        updatedAt: new Date(),
      },
    });

    const res = await request(app)
      .patch("/api/portal/notification-preferences")
      .send({ notifyErasureStorageDigestPush: false });
    expect(res.status).toBe(200);
    expect(res.body.notifyErasureStorageDigest).toBe(true);
    expect(res.body.notifyErasureStorageDigestPush).toBe(false);

    expect(muteConfirmMock).toHaveBeenCalledTimes(1);
    const arg = muteConfirmMock.mock.calls[0][0];
    expect(arg.mutedChannels).toEqual({ email: false, push: true });
    const tokenInUrl = new URL(arg.revertUrl).searchParams.get("token") ?? "";
    expect(verifyErasureDigestMuteRevertToken(tokenInUrl)?.channels).toBe("p");
  });

  it("emits a single combined confirmation with channels='b' when both channels are muted in one PATCH", async () => {
    const orgId = await makeOrg("mute-both");
    const userId = await makeController(orgId, "treasurer", `mute-both-${orgId}@example.com`, "Both Muter");
    const app = createTestApp({ id: userId, username: "u", role: "treasurer", organizationId: orgId });

    await db.insert(userNotificationPrefsTable).values({
      userId,
      notifyErasureStorageDigest: true,
      notifyErasureStorageDigestPush: true,
    }).onConflictDoUpdate({
      target: userNotificationPrefsTable.userId,
      set: {
        notifyErasureStorageDigest: true,
        notifyErasureStorageDigestPush: true,
        notifyErasureStorageDigestMuteConfirmationLastSentAt: null,
        updatedAt: new Date(),
      },
    });

    const res = await request(app)
      .patch("/api/portal/notification-preferences")
      .send({ notifyErasureStorageDigest: false, notifyErasureStorageDigestPush: false });
    expect(res.status).toBe(200);
    expect(res.body.notifyErasureStorageDigest).toBe(false);
    expect(res.body.notifyErasureStorageDigestPush).toBe(false);

    // A single combined email — NOT two — so the recipient sees one
    // confirmation that names both channels rather than racing
    // duplicates from a per-channel emit.
    expect(muteConfirmMock).toHaveBeenCalledTimes(1);
    const arg = muteConfirmMock.mock.calls[0][0];
    expect(arg.mutedChannels).toEqual({ email: true, push: true });
    const tokenInUrl = new URL(arg.revertUrl).searchParams.get("token") ?? "";
    expect(verifyErasureDigestMuteRevertToken(tokenInUrl)?.channels).toBe("b");
  });

  it("does not send a confirmation when the channel value did not transition true→false", async () => {
    const orgId = await makeOrg("no-transition");
    const userId = await makeController(orgId, "org_admin", `no-trans-${orgId}@example.com`, "No-Trans");
    const app = createTestApp({ id: userId, username: "u", role: "org_admin", organizationId: orgId });

    // Already muted before the PATCH.
    await db.insert(userNotificationPrefsTable).values({
      userId,
      notifyErasureStorageDigest: false,
      notifyErasureStorageDigestPush: true,
    }).onConflictDoUpdate({
      target: userNotificationPrefsTable.userId,
      set: {
        notifyErasureStorageDigest: false,
        notifyErasureStorageDigestPush: true,
        notifyErasureStorageDigestMuteConfirmationLastSentAt: null,
        updatedAt: new Date(),
      },
    });

    // Re-PATCHing the same false value is a no-op transition: there's
    // nothing the controller just decided to silence so no confirmation
    // should fire.
    const res = await request(app)
      .patch("/api/portal/notification-preferences")
      .send({ notifyErasureStorageDigest: false });
    expect(res.status).toBe(200);
    expect(muteConfirmMock).not.toHaveBeenCalled();

    // And re-enabling (false→true) must also not trigger the mute email.
    muteConfirmMock.mockReset();
    muteConfirmMock.mockResolvedValue(undefined);
    const res2 = await request(app)
      .patch("/api/portal/notification-preferences")
      .send({ notifyErasureStorageDigest: true });
    expect(res2.status).toBe(200);
    expect(muteConfirmMock).not.toHaveBeenCalled();
  });

  it("rate-limits a quick toggle off→on→off so a controller is not spammed", async () => {
    const orgId = await makeOrg("rate-limit");
    const userId = await makeController(orgId, "org_admin", `rate-${orgId}@example.com`, "Rate Limited");
    const app = createTestApp({ id: userId, username: "u", role: "org_admin", organizationId: orgId });

    await db.insert(userNotificationPrefsTable).values({
      userId,
      notifyErasureStorageDigest: true,
      notifyErasureStorageDigestPush: true,
    }).onConflictDoUpdate({
      target: userNotificationPrefsTable.userId,
      set: {
        notifyErasureStorageDigest: true,
        notifyErasureStorageDigestPush: true,
        notifyErasureStorageDigestMuteConfirmationLastSentAt: null,
        updatedAt: new Date(),
      },
    });

    // First mute: confirmation fires, watermark stamps.
    await request(app)
      .patch("/api/portal/notification-preferences")
      .send({ notifyErasureStorageDigest: false })
      .expect(200);
    expect(muteConfirmMock).toHaveBeenCalledTimes(1);

    // Re-enable (false→true): no new confirmation.
    await request(app)
      .patch("/api/portal/notification-preferences")
      .send({ notifyErasureStorageDigest: true })
      .expect(200);
    expect(muteConfirmMock).toHaveBeenCalledTimes(1);

    // Re-mute IMMEDIATELY (true→false again): suppressed by the rate
    // limit because the watermark is fresh. The mute itself still
    // applied (we assert the row's flag below).
    await request(app)
      .patch("/api/portal/notification-preferences")
      .send({ notifyErasureStorageDigest: false })
      .expect(200);
    expect(muteConfirmMock).toHaveBeenCalledTimes(1);

    const [pref] = await db.select({
      flag: userNotificationPrefsTable.notifyErasureStorageDigest,
    }).from(userNotificationPrefsTable).where(eq(userNotificationPrefsTable.userId, userId));
    expect(pref?.flag).toBe(false);

    // Now backdate the watermark beyond the throttle window and PATCH
    // a fresh re-mute (we re-enable + re-mute) to prove the gate opens
    // again once the window has elapsed.
    const oldEnough = new Date(Date.now() - ERASURE_DIGEST_MUTE_CONFIRMATION_THROTTLE_MS - 60_000);
    await db.update(userNotificationPrefsTable)
      .set({ notifyErasureStorageDigestMuteConfirmationLastSentAt: oldEnough })
      .where(eq(userNotificationPrefsTable.userId, userId));
    await request(app)
      .patch("/api/portal/notification-preferences")
      .send({ notifyErasureStorageDigest: true })
      .expect(200);
    await request(app)
      .patch("/api/portal/notification-preferences")
      .send({ notifyErasureStorageDigest: false })
      .expect(200);
    expect(muteConfirmMock).toHaveBeenCalledTimes(2);
  });

  it("does not stamp the watermark when the mailer throws so a transient outage doesn't poison the next attempt", async () => {
    const orgId = await makeOrg("mailer-fail");
    const userId = await makeController(orgId, "org_admin", `fail-${orgId}@example.com`, "Mailer Fails");
    const app = createTestApp({ id: userId, username: "u", role: "org_admin", organizationId: orgId });

    await db.insert(userNotificationPrefsTable).values({
      userId,
      notifyErasureStorageDigest: true,
      notifyErasureStorageDigestPush: true,
    }).onConflictDoUpdate({
      target: userNotificationPrefsTable.userId,
      set: {
        notifyErasureStorageDigest: true,
        notifyErasureStorageDigestPush: true,
        notifyErasureStorageDigestMuteConfirmationLastSentAt: null,
        updatedAt: new Date(),
      },
    });

    muteConfirmMock.mockRejectedValueOnce(new Error("postmark down"));

    // PATCH still returns 200 — the toggle is the user's primary intent
    // and a downstream confirmation outage must not surface to the
    // portal UI as a save failure.
    await request(app)
      .patch("/api/portal/notification-preferences")
      .send({ notifyErasureStorageDigest: false })
      .expect(200);

    const [pref] = await db.select({
      flag: userNotificationPrefsTable.notifyErasureStorageDigest,
      ts: userNotificationPrefsTable.notifyErasureStorageDigestMuteConfirmationLastSentAt,
    }).from(userNotificationPrefsTable).where(eq(userNotificationPrefsTable.userId, userId));
    expect(pref?.flag).toBe(false);
    expect(pref?.ts).toBeNull();
  });
});

describe("Task #1776 — signErasureDigestMuteRevertToken HMAC + TTL", () => {
  it("round-trips per-channel payloads and rejects tampering / wrong prefix", () => {
    for (const ch of ["e", "p", "b"] as const) {
      const tok = signErasureDigestMuteRevertToken(123, 456, ch);
      const parsed = verifyErasureDigestMuteRevertToken(tok);
      expect(parsed?.userId).toBe(123);
      expect(parsed?.orgId).toBe(456);
      expect(parsed?.channels).toBe(ch);
      // Tamper by flipping a character INSIDE the payload (rather than
      // appending — base64url decoding silently drops trailing junk so
      // an appended char is not a real tampering signal).
      const tampered = tok.slice(0, 6) + (tok[6] === "A" ? "B" : "A") + tok.slice(7);
      expect(verifyErasureDigestMuteRevertToken(tampered)).toBeNull();
    }
    // A token signed with a different prefix (the unsubscribe token
    // format) must not be accepted by the revert verifier — otherwise a
    // leaked unsubscribe link could be replayed against the revert
    // endpoint to flip the channels back on.
    const wrongPrefix = signErasureStorageDigestOptOutToken(123, 456);
    expect(verifyErasureDigestMuteRevertToken(wrongPrefix)).toBeNull();
  });

  it("rejects tokens older than the 7-day TTL", () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    const stale = signErasureDigestMuteRevertToken(1, 2, "b", eightDaysAgo);
    expect(verifyErasureDigestMuteRevertToken(stale)).toBeNull();
    // Same token with the TTL check disabled still parses — this
    // confirms the rejection above was the freshness gate, not a
    // signature failure.
    expect(verifyErasureDigestMuteRevertToken(stale, { ttlSeconds: 0 })?.userId).toBe(1);
  });
});

describe("Task #1776 — /api/public/erasure-digest-portal-mute-revert handler", () => {
  it("flips only the channel(s) named in the token back to true on GET", async () => {
    const orgId = await makeOrg("revert-email");
    const userId = await makeUser({ email: `revert-e-${orgId}@example.com`, displayName: "Revert E" });
    await db.insert(orgMembershipsTable).values({ organizationId: orgId, userId, role: "org_admin" });

    // Pre-condition: both channels muted (mirrors a controller who
    // muted only email via the portal but had previously also muted
    // push for unrelated reasons). The revert link for "e" must NOT
    // touch push.
    await db.insert(userNotificationPrefsTable).values({
      userId,
      notifyErasureStorageDigest: false,
      notifyErasureStorageDigestPush: false,
    }).onConflictDoUpdate({
      target: userNotificationPrefsTable.userId,
      set: { notifyErasureStorageDigest: false, notifyErasureStorageDigestPush: false, updatedAt: new Date() },
    });

    const app = express();
    app.use(express.urlencoded({ extended: false }));
    app.use(express.json());
    app.use("/api/public", publicRouter);

    const token = signErasureDigestMuteRevertToken(userId, orgId, "e");
    const res = await request(app)
      .get(`/api/public/erasure-digest-portal-mute-revert?token=${encodeURIComponent(token)}`)
      .expect(200);
    expect(res.text).toMatch(/re-?enabled/i);

    const [pref] = await db.select({
      email: userNotificationPrefsTable.notifyErasureStorageDigest,
      push: userNotificationPrefsTable.notifyErasureStorageDigestPush,
    }).from(userNotificationPrefsTable).where(eq(userNotificationPrefsTable.userId, userId));
    expect(pref?.email).toBe(true);
    expect(pref?.push).toBe(false); // untouched — that's the contract
  });

  it("flips both channels back when channels='b'", async () => {
    const orgId = await makeOrg("revert-both");
    const userId = await makeUser({ email: `revert-b-${orgId}@example.com`, displayName: "Revert B" });
    await db.insert(orgMembershipsTable).values({ organizationId: orgId, userId, role: "org_admin" });

    await db.insert(userNotificationPrefsTable).values({
      userId,
      notifyErasureStorageDigest: false,
      notifyErasureStorageDigestPush: false,
    }).onConflictDoUpdate({
      target: userNotificationPrefsTable.userId,
      set: { notifyErasureStorageDigest: false, notifyErasureStorageDigestPush: false, updatedAt: new Date() },
    });

    const app = express();
    app.use(express.urlencoded({ extended: false }));
    app.use(express.json());
    app.use("/api/public", publicRouter);

    const token = signErasureDigestMuteRevertToken(userId, orgId, "b");
    await request(app)
      .post(`/api/public/erasure-digest-portal-mute-revert`)
      .type("form")
      .send({ "List-Unsubscribe": "One-Click", token })
      .expect(200);

    const [pref] = await db.select({
      email: userNotificationPrefsTable.notifyErasureStorageDigest,
      push: userNotificationPrefsTable.notifyErasureStorageDigestPush,
    }).from(userNotificationPrefsTable).where(eq(userNotificationPrefsTable.userId, userId));
    expect(pref?.email).toBe(true);
    expect(pref?.push).toBe(true);
  });

  it("rejects a malformed or expired token with the 400 confirmation page", async () => {
    const app = express();
    app.use(express.urlencoded({ extended: false }));
    app.use(express.json());
    app.use("/api/public", publicRouter);
    const res = await request(app)
      .get(`/api/public/erasure-digest-portal-mute-revert?token=garbage`)
      .expect(400);
    expect(res.text).toMatch(/invalid revert link/i);
  });
});
