/**
 * Tests for Task #1489 — monthly per-org "member notification
 * preferences" controller digest cron + opt-out plumbing.
 *
 * Covers:
 *   - The cron path: emails every controller (org_admin /
 *     membership_secretary / treasurer) for an org whose
 *     `memberPrefsDigestLastSentOn` watermark lags the current month,
 *     stamps the watermark on success, and writes an audit row
 *     recording the recipients + timing. A second invocation in the
 *     same calendar month is a no-op.
 *   - The opt-out path: a controller with
 *     `userNotificationPrefs.notifyMemberPrefsDigest = false` is
 *     skipped, counted as `suppressed`, and never receives the email,
 *     while other controllers in the same org still receive it.
 *   - The unsubscribe-token round-trip + signature mismatch (signed
 *     with `mpd1:` prefix; tampering / wrong-prefix tokens rejected).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

vi.mock("../lib/mailer.js", async () => {
  return {
    sendMemberPrefsDigestEmail: vi.fn(async () => undefined),
  };
});

import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  orgMembershipsTable,
  memberAuditLogTable,
  userNotificationPrefsTable,
} from "@workspace/db";
import { eq, inArray, sql, and, desc } from "drizzle-orm";
import express from "express";
import request from "supertest";

import { sendMemberPrefsDigest } from "../lib/cron.js";
import { sendMemberPrefsDigestEmail } from "../lib/mailer.js";
import {
  signMemberPrefsDigestOptOutToken,
  verifyMemberPrefsDigestOptOutToken,
} from "../lib/bouncedDigestUnsubscribe.js";
import publicRouter from "../routes/public.js";

const emailMock = vi.mocked(sendMemberPrefsDigestEmail);

const createdOrgIds: number[] = [];
const createdUserIds: number[] = [];

let userSeq = 0;
async function makeOrg(label: string): Promise<number> {
  const tag = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const [org] = await db.insert(organizationsTable).values({
    name: `MemberPrefsDigestTest_${label}_${tag}`,
    slug: `mpd-${label}-${tag}`.toLowerCase(),
  }).returning({ id: organizationsTable.id });
  createdOrgIds.push(org.id);
  return org.id;
}

async function makeUser(opts: { email?: string | null; displayName?: string }): Promise<number> {
  userSeq += 1;
  const tag = `${Date.now()}_${userSeq}_${Math.random().toString(36).slice(2, 6)}`;
  const [u] = await db.insert(appUsersTable).values({
    replitUserId: `mpd-${tag}`,
    username: `mpd_${tag}`,
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

let prevAppBaseUrl: string | undefined;
let prevSessionSecret: string | undefined;
beforeAll(async () => {
  prevAppBaseUrl = process.env.APP_BASE_URL;
  process.env.APP_BASE_URL = "https://test.kharagolf.com";
  prevSessionSecret = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = process.env.SESSION_SECRET ?? "test-session-secret-member-prefs-digest";

  // Test DB is shared across files; defensively (re)create the columns
  // the cron + opt-out endpoints depend on so this file passes even
  // when run in isolation against a partially-migrated test DB.
  await db.execute(sql`ALTER TABLE user_notification_prefs ADD COLUMN IF NOT EXISTS notify_member_prefs_digest boolean NOT NULL DEFAULT true`);
  await db.execute(sql`ALTER TABLE organizations ADD COLUMN IF NOT EXISTS member_prefs_digest_last_sent_on text`);
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
});

function currentYearMonth(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

describe("sendMemberPrefsDigest — cron path", () => {
  it("emails every controller, stamps the watermark, writes the audit row, and is idempotent within the month", async () => {
    const orgId = await makeOrg("cron");
    const adminEmail = `admin-${orgId}@example.com`;
    const secEmail = `sec-${orgId}@example.com`;
    const trsEmail = `trs-${orgId}@example.com`;
    const adminId = await makeController(orgId, "org_admin", adminEmail, "Admin Alice");
    const secId = await makeController(orgId, "membership_secretary", secEmail, "Sec Sue");
    const trsId = await makeController(orgId, "treasurer", trsEmail, "Treasurer Tina");

    // Sanity: the watermark is unset, so the cron must fire.
    const [orgBefore] = await db.select({
      stamp: organizationsTable.memberPrefsDigestLastSentOn,
    }).from(organizationsTable).where(eq(organizationsTable.id, orgId));
    expect(orgBefore?.stamp).toBeNull();

    await sendMemberPrefsDigest();

    // All three controllers received the email.
    const recipients = new Set(
      emailMock.mock.calls
        .map(([arg]) => arg.to)
        .filter((to): to is string => typeof to === "string"),
    );
    expect(recipients.has(adminEmail)).toBe(true);
    expect(recipients.has(secEmail)).toBe(true);
    expect(recipients.has(trsEmail)).toBe(true);

    // Each call carries a per-recipient one-click unsubscribe URL that
    // matches the public endpoint we registered.
    for (const [arg] of emailMock.mock.calls) {
      if (arg.to === adminEmail || arg.to === secEmail || arg.to === trsEmail) {
        expect(arg.unsubscribeUrl).toMatch(
          /\/api\/public\/member-prefs-digest-unsubscribe\?token=/,
        );
        // Each call carries the CSV attachment payload (the cron
        // builds the CSV once per org and re-uses it).
        expect(arg.csv).toContain(`"User ID","Username","Display Name","Email","Role"`);
        expect(arg.filename).toBe(`member-notification-prefs-org-${orgId}.csv`);
      }
    }

    // Watermark stamped to the current calendar month.
    const [orgAfter] = await db.select({
      stamp: organizationsTable.memberPrefsDigestLastSentOn,
    }).from(organizationsTable).where(eq(organizationsTable.id, orgId));
    expect(orgAfter?.stamp).toBe(currentYearMonth());

    // Audit row recording recipients + timing.
    const [audit] = await db.select({
      action: memberAuditLogTable.action,
      reason: memberAuditLogTable.reason,
      metadata: memberAuditLogTable.metadata,
    })
      .from(memberAuditLogTable)
      .where(and(
        eq(memberAuditLogTable.organizationId, orgId),
        eq(memberAuditLogTable.action, "member_prefs_digest_sent"),
      ))
      .orderBy(desc(memberAuditLogTable.id))
      .limit(1);
    expect(audit).toBeDefined();
    expect(audit.action).toBe("member_prefs_digest_sent");
    const meta = audit.metadata as Record<string, unknown>;
    expect(meta.kind).toBe("member_prefs_digest");
    expect(meta.period).toBe(currentYearMonth());
    expect(meta.recipientsEmailed).toBe(3);
    expect(meta.recipientsSuppressed).toBe(0);
    expect(typeof meta.sentAt).toBe("string");
    expect(Array.isArray(meta.recipients)).toBe(true);
    const recordedRecipientIds = new Set(
      (meta.recipients as Array<{ userId: number }>).map(r => r.userId),
    );
    expect(recordedRecipientIds.has(adminId)).toBe(true);
    expect(recordedRecipientIds.has(secId)).toBe(true);
    expect(recordedRecipientIds.has(trsId)).toBe(true);

    // Idempotent within the calendar month — a second call must NOT
    // re-fire the email, because the watermark already matches.
    emailMock.mockReset();
    emailMock.mockResolvedValue(undefined);
    await sendMemberPrefsDigest();
    const reSent = emailMock.mock.calls.filter(([arg]) =>
      arg.to === adminEmail || arg.to === secEmail || arg.to === trsEmail,
    );
    expect(reSent).toHaveLength(0);
  });
});

describe("sendMemberPrefsDigest — transient SMTP failure", () => {
  it("does NOT stamp the watermark when every send fails, so tomorrow's poll retries", async () => {
    const orgId = await makeOrg("smtpfail");
    const adminEmail = `smtpfail-${orgId}@example.com`;
    await makeController(orgId, "org_admin", adminEmail, "Admin Alice");

    // Simulate a global SMTP outage — every send throws.
    emailMock.mockRejectedValue(new Error("smtp-down"));
    await sendMemberPrefsDigest();

    // Watermark must remain unset so the next daily poll re-attempts
    // delivery instead of silencing the whole calendar month.
    const [orgAfter] = await db.select({
      stamp: organizationsTable.memberPrefsDigestLastSentOn,
    }).from(organizationsTable).where(eq(organizationsTable.id, orgId));
    expect(orgAfter?.stamp).toBeNull();

    // Recovery: SMTP comes back, watermark is stamped, recipient is
    // emailed exactly once for the month.
    emailMock.mockReset();
    emailMock.mockResolvedValue(undefined);
    await sendMemberPrefsDigest();
    const adminCalls = emailMock.mock.calls.filter(([arg]) => arg.to === adminEmail);
    expect(adminCalls).toHaveLength(1);
    const [orgAfterRetry] = await db.select({
      stamp: organizationsTable.memberPrefsDigestLastSentOn,
    }).from(organizationsTable).where(eq(organizationsTable.id, orgId));
    expect(orgAfterRetry?.stamp).toBe(currentYearMonth());
  });
});

describe("sendMemberPrefsDigest — opt-out path", () => {
  it("skips controllers with notifyMemberPrefsDigest=false and still emails the rest", async () => {
    const orgId = await makeOrg("optout");
    const optedOutEmail = `optout-${orgId}@example.com`;
    const optedInEmail = `optin-${orgId}@example.com`;
    const optedOutUserId = await makeController(orgId, "treasurer", optedOutEmail, "Treasurer Tina");
    await makeController(orgId, "org_admin", optedInEmail, "Admin Alice");

    // Persist the opt-out before the cron runs.
    await db.insert(userNotificationPrefsTable).values({
      userId: optedOutUserId,
      notifyMemberPrefsDigest: false,
    }).onConflictDoUpdate({
      target: userNotificationPrefsTable.userId,
      set: { notifyMemberPrefsDigest: false, updatedAt: new Date() },
    });

    await sendMemberPrefsDigest();

    const optedOutCalls = emailMock.mock.calls.filter(([arg]) => arg.to === optedOutEmail);
    const optedInCalls = emailMock.mock.calls.filter(([arg]) => arg.to === optedInEmail);
    expect(optedOutCalls).toHaveLength(0);
    expect(optedInCalls).toHaveLength(1);
    expect(optedInCalls[0][0].unsubscribeUrl).toMatch(
      /\/api\/public\/member-prefs-digest-unsubscribe\?token=/,
    );

    // Audit row records the suppression count separately from the
    // delivered count so dashboards can distinguish the two.
    const [audit] = await db.select({
      metadata: memberAuditLogTable.metadata,
    })
      .from(memberAuditLogTable)
      .where(and(
        eq(memberAuditLogTable.organizationId, orgId),
        eq(memberAuditLogTable.action, "member_prefs_digest_sent"),
      ))
      .orderBy(desc(memberAuditLogTable.id))
      .limit(1);
    const meta = audit.metadata as Record<string, unknown>;
    expect(meta.recipientsEmailed).toBe(1);
    expect(meta.recipientsSuppressed).toBe(1);
  });
});

describe("member-prefs-digest-unsubscribe — HMAC token + public endpoint", () => {
  it("round-trips a valid token and rejects tampering / wrong-prefix tokens", () => {
    const token = signMemberPrefsDigestOptOutToken(123, 456);
    expect(verifyMemberPrefsDigestOptOutToken(token)).toEqual({ userId: 123, orgId: 456 });
    expect(verifyMemberPrefsDigestOptOutToken(token + "x")).toBeNull();
    expect(verifyMemberPrefsDigestOptOutToken("not-a-token")).toBeNull();
    // A token signed with the erasure-digest prefix must NOT verify
    // against the member-prefs-digest verifier.
    expect(verifyMemberPrefsDigestOptOutToken(
      Buffer.from("esd1:123:456:badsig", "utf8").toString("base64url"),
    )).toBeNull();
    // Negative ids rejected.
    expect(verifyMemberPrefsDigestOptOutToken(
      Buffer.from("mpd1:0:1:badsig", "utf8").toString("base64url"),
    )).toBeNull();
  });

  it("flips notifyMemberPrefsDigest to false on GET and back to true on resubscribe", async () => {
    const orgId = await makeOrg("endpoint");
    const userId = await makeUser({ email: `endpoint-${orgId}@example.com`, displayName: "Endpoint User" });
    await db.insert(orgMembershipsTable).values({ organizationId: orgId, userId, role: "org_admin" });

    const app = express();
    app.use(express.urlencoded({ extended: false }));
    app.use(express.json());
    app.use("/api/public", publicRouter);

    const token = signMemberPrefsDigestOptOutToken(userId, orgId);

    // Unsubscribe — GET (link click in email).
    const unsubRes = await request(app)
      .get(`/api/public/member-prefs-digest-unsubscribe?token=${encodeURIComponent(token)}`)
      .expect(200);
    expect(unsubRes.text).toMatch(/unsubscribed/i);
    let [pref] = await db.select({ flag: userNotificationPrefsTable.notifyMemberPrefsDigest })
      .from(userNotificationPrefsTable)
      .where(eq(userNotificationPrefsTable.userId, userId));
    expect(pref?.flag).toBe(false);

    // Re-subscribe — restores the default opt-in state.
    const resubRes = await request(app)
      .get(`/api/public/member-prefs-digest-resubscribe?token=${encodeURIComponent(token)}`)
      .expect(200);
    expect(resubRes.text).toMatch(/re-subscribed/i);
    [pref] = await db.select({ flag: userNotificationPrefsTable.notifyMemberPrefsDigest })
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
      .get(`/api/public/member-prefs-digest-unsubscribe?token=garbage`)
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

    const token = signMemberPrefsDigestOptOutToken(userId, orgId);

    await request(app)
      .post(`/api/public/member-prefs-digest-unsubscribe`)
      .type("form")
      .send({ "List-Unsubscribe": "One-Click", token })
      .expect(200);
    const [pref] = await db.select({ flag: userNotificationPrefsTable.notifyMemberPrefsDigest })
      .from(userNotificationPrefsTable)
      .where(eq(userNotificationPrefsTable.userId, userId));
    expect(pref?.flag).toBe(false);
  });
});
