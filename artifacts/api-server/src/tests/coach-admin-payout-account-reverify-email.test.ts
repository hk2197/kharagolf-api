/**
 * Task #1428 — Tests for the coach-side courtesy email that fires when
 * an organisation admin manually re-verifies a coach's payout account.
 *
 * `POST /api/coach-marketplace/admin/coaches/:proId/payout-account/reverify`
 * already records an audit row (Task #1222) and triggers the existing
 * `notifyCoachAccountNeedsAttention` helper when the outcome is bad,
 * but until this task there was no notification at all on the success
 * path and the bad-path notice didn't say *who* triggered the re-check.
 * The new transactional email closes both gaps and is gated on the
 * coach's `billing` comm-prefs opt-out so it's silenceable from the
 * existing per-category preference panel.
 *
 * Razorpay's verify endpoints are mocked so the tests deterministically
 * exercise both outcomes; the mailer is mocked at the helper boundary
 * so we never touch SMTP.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

process.env.SESSION_SECRET ||= "test-session-secret-coach-admin-reverify-email";

const {
  createRazorpayContactMock,
  createRazorpayFundAccountMock,
  validateRazorpayVpaMock,
  validateRazorpayBankFundAccountMock,
  sendCoachPayoutAccountReverifiedByAdminEmailMock,
  sendCoachPayoutAccountNeedsAttentionEmailMock,
} = vi.hoisted(() => ({
  createRazorpayContactMock: vi.fn(),
  createRazorpayFundAccountMock: vi.fn(),
  validateRazorpayVpaMock: vi.fn(),
  validateRazorpayBankFundAccountMock: vi.fn(),
  sendCoachPayoutAccountReverifiedByAdminEmailMock:
    vi.fn<typeof import("../lib/mailer").sendCoachPayoutAccountReverifiedByAdminEmail>(),
  sendCoachPayoutAccountNeedsAttentionEmailMock:
    vi.fn<typeof import("../lib/mailer").sendCoachPayoutAccountNeedsAttentionEmail>(),
}));
vi.mock("../lib/razorpay", async () => {
  const actual = await vi.importActual<typeof import("../lib/razorpay")>("../lib/razorpay");
  return {
    ...actual,
    createRazorpayContact: createRazorpayContactMock,
    createRazorpayFundAccount: createRazorpayFundAccountMock,
    validateRazorpayVpa: validateRazorpayVpaMock,
    validateRazorpayBankFundAccount: validateRazorpayBankFundAccountMock,
  };
});
// Mock just the two mailer entry points we care about; everything else
// (header builders, sendMail, suppression checks) keeps its real
// implementation so this file isn't affected by unrelated mailer
// changes.
vi.mock("../lib/mailer", async () => {
  const actual = await vi.importActual<typeof import("../lib/mailer")>("../lib/mailer");
  return {
    ...actual,
    sendCoachPayoutAccountReverifiedByAdminEmail: sendCoachPayoutAccountReverifiedByAdminEmailMock,
    sendCoachPayoutAccountNeedsAttentionEmail: sendCoachPayoutAccountNeedsAttentionEmailMock,
  };
});

import request from "supertest";
import {
  db,
  organizationsTable,
  appUsersTable,
  orgMembershipsTable,
  teachingProsTable,
  coachMarketplaceProfilesTable,
  coachPayoutAccountHistoryTable,
  clubMembersTable,
  memberCommPrefsTable,
  userNotificationPrefsTable,
} from "@workspace/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { createTestApp, type TestUser } from "./helpers.js";

const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

let orgId: number;
let coachUserId: number;
let adminUserId: number;
let proId: number;
let coachClubMemberId: number;

let coach: TestUser;
let admin: TestUser;

let appAsCoach: ReturnType<typeof createTestApp>;
let appAsAdmin: ReturnType<typeof createTestApp>;

const SAVE_URL = "/api/coach-marketplace/me/payout-account";

beforeAll(async () => {
  // Task #1724 — defensively ensure the new per-event opt-out column
  // exists before any insert/select touches it. Mirrors the pattern in
  // `members-notification-prefs-csv-export.test.ts` so this file does
  // not depend on the test runner having already applied the numbered
  // migration `0132_notify_admin_payout_reverify.sql`.
  await db.execute(sql`ALTER TABLE user_notification_prefs ADD COLUMN IF NOT EXISTS notify_admin_payout_reverify boolean NOT NULL DEFAULT true`);

  const [org] = await db.insert(organizationsTable).values({
    name: `ReverifyEmail_${stamp}`,
    slug: `reverify-email-${stamp}`,
    subscriptionTier: "starter",
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  const [c] = await db.insert(appUsersTable).values({
    replitUserId: `reverify-email-coach-${stamp}`,
    username: `reverify_email_coach_${stamp}`,
    email: `reverify_email_coach_${stamp}@example.com`,
    displayName: "Email Coach",
    role: "player",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  coachUserId = c.id;

  const [a] = await db.insert(appUsersTable).values({
    replitUserId: `reverify-email-admin-${stamp}`,
    username: `reverify_email_admin_${stamp}`,
    email: `reverify_email_admin_${stamp}@example.com`,
    displayName: "Email Admin",
    role: "org_admin",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  adminUserId = a.id;

  await db.insert(orgMembershipsTable).values([
    { organizationId: orgId, userId: coachUserId, role: "player" },
    { organizationId: orgId, userId: adminUserId, role: "org_admin" },
  ]);

  const [p] = await db.insert(teachingProsTable).values({
    organizationId: orgId, userId: coachUserId, displayName: "Email Coach",
  }).returning({ id: teachingProsTable.id });
  proId = p.id;

  // Club member row so the `loadBillingPrefs` lookup in the helper
  // resolves the comm-prefs we seed per-test below.
  const [m] = await db.insert(clubMembersTable).values({
    organizationId: orgId,
    userId: coachUserId,
    firstName: "Email",
    lastName: "Coach",
    email: `reverify_email_coach_${stamp}@example.com`,
  }).returning({ id: clubMembersTable.id });
  coachClubMemberId = m.id;

  coach = {
    id: coachUserId, username: `reverify_email_coach_${stamp}`,
    displayName: "Email Coach", role: "player", organizationId: orgId,
  };
  admin = {
    id: adminUserId, username: `reverify_email_admin_${stamp}`,
    displayName: "Email Admin", role: "org_admin", organizationId: orgId,
  };

  appAsCoach = createTestApp(coach);
  appAsAdmin = createTestApp(admin);
});

afterAll(async () => {
  if (proId) {
    await db.delete(coachPayoutAccountHistoryTable).where(eq(coachPayoutAccountHistoryTable.proId, proId));
    await db.delete(coachMarketplaceProfilesTable).where(eq(coachMarketplaceProfilesTable.proId, proId));
    await db.delete(teachingProsTable).where(eq(teachingProsTable.id, proId));
  }
  if (coachClubMemberId) {
    await db.delete(memberCommPrefsTable).where(eq(memberCommPrefsTable.clubMemberId, coachClubMemberId));
    await db.delete(clubMembersTable).where(eq(clubMembersTable.id, coachClubMemberId));
  }
  const userIds = [coachUserId, adminUserId].filter(Boolean);
  if (userIds.length) {
    // Task #1724 — clean up the per-event opt-out row before the FK to
    // `app_users` cascades it; the schema doesn't currently set ON
    // DELETE CASCADE for this table.
    await db.delete(userNotificationPrefsTable).where(inArray(userNotificationPrefsTable.userId, userIds));
    await db.delete(appUsersTable).where(inArray(appUsersTable.id, userIds));
  }
  if (orgId) await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
});

beforeEach(async () => {
  createRazorpayContactMock.mockReset();
  createRazorpayFundAccountMock.mockReset();
  validateRazorpayVpaMock.mockReset();
  validateRazorpayBankFundAccountMock.mockReset();
  sendCoachPayoutAccountReverifiedByAdminEmailMock.mockReset();
  sendCoachPayoutAccountReverifiedByAdminEmailMock.mockImplementation(async () => {});
  sendCoachPayoutAccountNeedsAttentionEmailMock.mockReset();
  sendCoachPayoutAccountNeedsAttentionEmailMock.mockImplementation(async () => {});
  // Wipe per-test state so tests are independent.
  await db.delete(coachPayoutAccountHistoryTable).where(eq(coachPayoutAccountHistoryTable.proId, proId));
  await db.delete(coachMarketplaceProfilesTable).where(eq(coachMarketplaceProfilesTable.proId, proId));
  await db.delete(memberCommPrefsTable)
    .where(and(
      eq(memberCommPrefsTable.clubMemberId, coachClubMemberId),
      eq(memberCommPrefsTable.category, "billing"),
    ));
  // Task #1724 — also clear the per-event opt-out row between tests so
  // each scenario starts with the schema default (notify=ON) and only
  // the test that explicitly seeds an opt-out sees it take effect.
  await db.delete(userNotificationPrefsTable).where(eq(userNotificationPrefsTable.userId, coachUserId));
});

async function seedSavedUpiAccount(opts: { upiVpa: string; fundAccountId: string; contactId: string }) {
  createRazorpayContactMock.mockResolvedValueOnce({ id: opts.contactId });
  createRazorpayFundAccountMock.mockResolvedValueOnce({
    id: opts.fundAccountId, contact_id: opts.contactId,
    account_type: "vpa", vpa: { address: opts.upiVpa },
  });
  validateRazorpayVpaMock.mockResolvedValueOnce({
    vpa: opts.upiVpa, success: true, customer_name: "EMAIL COACH",
  });
  const verifyRes = await request(appAsCoach).post(SAVE_URL).send({
    method: "upi", upiVpa: opts.upiVpa, accountHolderName: "Email Coach",
  });
  expect(verifyRes.status, verifyRes.text).toBe(200);
  const confirmRes = await request(appAsCoach).post(SAVE_URL).send({
    method: "upi", confirm: true,
    verificationToken: verifyRes.body.verification.verificationToken,
  });
  expect(confirmRes.status, confirmRes.text).toBe(200);
}

describe("POST /coach-marketplace/admin/coaches/:proId/payout-account/reverify — coach courtesy email", () => {
  it("emails the coach a verified-status notice when the admin re-check confirms the account", async () => {
    await seedSavedUpiAccount({
      upiVpa: "alice@upi", contactId: "cont_email_ok", fundAccountId: "fa_email_ok",
    });
    validateRazorpayVpaMock.mockResolvedValueOnce({
      vpa: "alice@upi", success: true, customer_name: "EMAIL COACH",
    });

    const res = await request(appAsAdmin)
      .post(`/api/coach-marketplace/admin/coaches/${proId}/payout-account/reverify`)
      .send({});
    expect(res.status, res.text).toBe(200);
    expect(res.body.outcome).toBe("verified");

    expect(sendCoachPayoutAccountReverifiedByAdminEmailMock).toHaveBeenCalledTimes(1);
    const call = sendCoachPayoutAccountReverifiedByAdminEmailMock.mock.calls[0]![0];
    expect(call.to).toBe(`reverify_email_coach_${stamp}@example.com`);
    expect(call.outcome).toBe("verified");
    expect(call.method).toBe("upi");
    expect(call.reason).toBeNull();
    expect(call.reverifiedAt).toBeInstanceOf(Date);
    // Account label is masked, never the raw VPA.
    expect(call.accountLabel).not.toBe("alice@upi");
    expect(call.accountLabel).toContain("@upi");
    // No needs-attention email on the success path.
    expect(sendCoachPayoutAccountNeedsAttentionEmailMock).not.toHaveBeenCalled();
  });

  it("emails the coach a needs-attention notice with the failure reason when the admin re-check fails", async () => {
    await seedSavedUpiAccount({
      upiVpa: "bob@upi", contactId: "cont_email_bad", fundAccountId: "fa_email_bad",
    });
    validateRazorpayVpaMock.mockResolvedValueOnce({
      vpa: "bob@upi", success: false,
    });

    const res = await request(appAsAdmin)
      .post(`/api/coach-marketplace/admin/coaches/${proId}/payout-account/reverify`)
      .send({});
    expect(res.status, res.text).toBe(200);
    expect(res.body.outcome).toBe("needs_attention");

    expect(sendCoachPayoutAccountReverifiedByAdminEmailMock).toHaveBeenCalledTimes(1);
    const call = sendCoachPayoutAccountReverifiedByAdminEmailMock.mock.calls[0]![0];
    expect(call.outcome).toBe("needs_attention");
    expect(call.reason).toBe("UPI ID is no longer accepting transfers");
    expect(call.method).toBe("upi");
    // The pre-existing needs-attention helper still fires alongside us
    // (cron-style guidance to re-save). The two emails complement each
    // other — see `notifyCoachOfAdminReverify` JSDoc.
    expect(sendCoachPayoutAccountNeedsAttentionEmailMock).toHaveBeenCalledTimes(1);
  });

  it("does NOT email the coach when the per-event `notifyAdminPayoutReverify` flag is false, but still fires the cron-side needs-attention email", async () => {
    // Task #1724 — the per-event opt-out is checked BEFORE the broader
    // billing comm-prefs gate so a coach can mute just the courtesy
    // notice without silencing payout receipts. We assert the bad-path
    // outcome here (rather than verified) so we can also prove the
    // pre-existing `sendCoachPayoutAccountNeedsAttentionEmail` helper
    // still fires — its gating is unrelated and must not regress.
    await seedSavedUpiAccount({
      upiVpa: "erin@upi", contactId: "cont_email_perev_optout", fundAccountId: "fa_email_perev_optout",
    });
    await db.insert(userNotificationPrefsTable).values({
      userId: coachUserId,
      notifyAdminPayoutReverify: false,
    });
    validateRazorpayVpaMock.mockResolvedValueOnce({
      vpa: "erin@upi", success: false,
    });

    const res = await request(appAsAdmin)
      .post(`/api/coach-marketplace/admin/coaches/${proId}/payout-account/reverify`)
      .send({});
    expect(res.status, res.text).toBe(200);
    expect(res.body.outcome).toBe("needs_attention");

    // The courtesy notice is muted by the per-event flag …
    expect(sendCoachPayoutAccountReverifiedByAdminEmailMock).not.toHaveBeenCalled();
    // … but the unrelated needs-attention email still goes out.
    expect(sendCoachPayoutAccountNeedsAttentionEmailMock).toHaveBeenCalledTimes(1);
  });

  it("does NOT email the coach when their billing comm-prefs disable transactional account emails", async () => {
    await seedSavedUpiAccount({
      upiVpa: "carol@upi", contactId: "cont_email_optout", fundAccountId: "fa_email_optout",
    });
    // Coach silenced billing emails — the courtesy notice must respect it.
    await db.insert(memberCommPrefsTable).values({
      organizationId: orgId,
      clubMemberId: coachClubMemberId,
      category: "billing",
      emailEnabled: false,
      pushEnabled: true,
      smsEnabled: false,
    });
    validateRazorpayVpaMock.mockResolvedValueOnce({
      vpa: "carol@upi", success: true, customer_name: "EMAIL COACH",
    });

    const res = await request(appAsAdmin)
      .post(`/api/coach-marketplace/admin/coaches/${proId}/payout-account/reverify`)
      .send({});
    expect(res.status, res.text).toBe(200);
    expect(res.body.outcome).toBe("verified");
    expect(sendCoachPayoutAccountReverifiedByAdminEmailMock).not.toHaveBeenCalled();
  });

  it("passes the coach's preferredLanguage to the mailer so the email is rendered in their language (Task #1723)", async () => {
    await seedSavedUpiAccount({
      upiVpa: "eve@upi", contactId: "cont_email_lang", fundAccountId: "fa_email_lang",
    });
    // Switch the coach's preferred language to a non-default; the
    // helper must propagate it as the `lang` argument so the i18n
    // string lookup picks the right pack.
    await db.update(appUsersTable)
      .set({ preferredLanguage: "fr" })
      .where(eq(appUsersTable.id, coachUserId));
    try {
      validateRazorpayVpaMock.mockResolvedValueOnce({
        vpa: "eve@upi", success: true, customer_name: "EMAIL COACH",
      });

      const res = await request(appAsAdmin)
        .post(`/api/coach-marketplace/admin/coaches/${proId}/payout-account/reverify`)
        .send({});
      expect(res.status, res.text).toBe(200);
      expect(res.body.outcome).toBe("verified");

      expect(sendCoachPayoutAccountReverifiedByAdminEmailMock).toHaveBeenCalledTimes(1);
      const call = sendCoachPayoutAccountReverifiedByAdminEmailMock.mock.calls[0]![0];
      expect(call.lang).toBe("fr");
    } finally {
      await db.update(appUsersTable)
        .set({ preferredLanguage: "en" })
        .where(eq(appUsersTable.id, coachUserId));
    }
  });

  it("still returns 200 to the admin when the courtesy email throws (best-effort)", async () => {
    await seedSavedUpiAccount({
      upiVpa: "dave@upi", contactId: "cont_email_throw", fundAccountId: "fa_email_throw",
    });
    validateRazorpayVpaMock.mockResolvedValueOnce({
      vpa: "dave@upi", success: true, customer_name: "EMAIL COACH",
    });
    sendCoachPayoutAccountReverifiedByAdminEmailMock.mockRejectedValueOnce(
      new Error("simulated SMTP failure"),
    );

    const res = await request(appAsAdmin)
      .post(`/api/coach-marketplace/admin/coaches/${proId}/payout-account/reverify`)
      .send({});
    expect(res.status, res.text).toBe(200);
    expect(res.body.outcome).toBe("verified");
    expect(sendCoachPayoutAccountReverifiedByAdminEmailMock).toHaveBeenCalledTimes(1);
  });
});
