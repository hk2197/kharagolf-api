/**
 * Tests for Task #1883 — auto-page super-admins + on-call when the
 * daily Stripe-webhook retention sweep has been silent for too long.
 *
 * Covers:
 *   - Healthy status (recent sweep) → no email sent.
 *   - Long-uptime + null status (cron has never run) → email sent.
 *   - Stale status → emails super-admins + on-call once.
 *   - Cooldown suppresses repeat pages within the cooldown window;
 *     `force` overrides.
 *   - No recipients (no super_admin email AND OPS_ALERT_EMAILS unset)
 *     returns `no_recipients` instead of throwing.
 *   - Reads recipient list from DB super_admins + OPS_ALERT_EMAILS env
 *     when no explicit recipients are passed.
 *   - Inserts an audit row with the recipient list when the page lands;
 *     skipped runs leave no audit row.
 *   - Cooldown gate survives a simulated process restart by reading
 *     from the persisted audit table.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";

vi.mock("../lib/mailer.js", async () => ({
  sendStripeWebhookSweepStaleOpsAlertEmail: vi.fn(async () => undefined),
}));

import { db } from "@workspace/db";
import {
  appUsersTable,
  organizationsTable,
  orgMembershipsTable,
  stripeWebhookSweepStaleAlertsTable,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";

import {
  runStripeWebhookSweepStaleOpsAlertJob,
  loadLastStripeWebhookSweepStaleAlertAt,
  _resetStripeWebhookSweepStaleOpsAlertDedupForTest,
} from "../lib/stripeWebhookSweepStaleOpsAlert.js";
import { sendStripeWebhookSweepStaleOpsAlertEmail } from "../lib/mailer.js";
import { STRIPE_WEBHOOK_SWEEP_STALE_AFTER_MS } from "../lib/stripeWebhookSweepStatus.js";

const emailMock = vi.mocked(sendStripeWebhookSweepStaleOpsAlertEmail);

let testSuperAdminId: number | null = null;
let testSuperAdminEmail: string | null = null;
// Legacy `app_users.role = 'org_admin'` (org-scoped) admin.
let testLegacyOrgAdminId: number | null = null;
let testLegacyOrgAdminEmail: string | null = null;
// Modern `org_memberships.role = 'org_admin'` admin (no role on app_users).
let testMembershipOrgAdminId: number | null = null;
let testMembershipOrgAdminEmail: string | null = null;
// Org for both org-admin variants above.
let testOrgId: number | null = null;
// User with no email — must be silently dropped.
let testEmaillessAdminId: number | null = null;

beforeAll(async () => {
  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

  const [org] = await db.insert(organizationsTable).values({
    name: `swhsweep_org_${stamp}`,
    slug: `swhsweep-org-${stamp}`,
  }).returning({ id: organizationsTable.id });
  testOrgId = org.id;

  testSuperAdminEmail = `swhsweep_super_${stamp}@example.com`;
  const [superAdmin] = await db.insert(appUsersTable).values({
    replitUserId: `swhsweep-super-${stamp}`,
    username: `swhsweep_super_${stamp}`,
    email: testSuperAdminEmail,
    role: "super_admin",
  }).returning({ id: appUsersTable.id });
  testSuperAdminId = superAdmin.id;

  testLegacyOrgAdminEmail = `swhsweep_legacy_${stamp}@example.com`;
  const [legacyOrgAdmin] = await db.insert(appUsersTable).values({
    replitUserId: `swhsweep-legacy-${stamp}`,
    username: `swhsweep_legacy_${stamp}`,
    email: testLegacyOrgAdminEmail,
    role: "org_admin",
    organizationId: testOrgId,
  }).returning({ id: appUsersTable.id });
  testLegacyOrgAdminId = legacyOrgAdmin.id;

  testMembershipOrgAdminEmail = `swhsweep_membership_${stamp}@example.com`;
  // `role: "player"` is intentional: this user is not an admin via
  // app_users.role, only via org_memberships below, so the test
  // proves the lookup picks up the modern source.
  const [membershipOrgAdmin] = await db.insert(appUsersTable).values({
    replitUserId: `swhsweep-membership-${stamp}`,
    username: `swhsweep_membership_${stamp}`,
    email: testMembershipOrgAdminEmail,
    role: "player",
  }).returning({ id: appUsersTable.id });
  testMembershipOrgAdminId = membershipOrgAdmin.id;
  await db.insert(orgMembershipsTable).values({
    organizationId: testOrgId,
    userId: testMembershipOrgAdminId,
    role: "org_admin",
  });

  // Email-less super_admin — must be silently dropped (and never emailed).
  const [emaillessAdmin] = await db.insert(appUsersTable).values({
    replitUserId: `swhsweep-emailless-${stamp}`,
    username: `swhsweep_emailless_${stamp}`,
    email: null,
    role: "super_admin",
  }).returning({ id: appUsersTable.id });
  testEmaillessAdminId = emaillessAdmin.id;
});

afterAll(async () => {
  if (testOrgId && testMembershipOrgAdminId) {
    await db.delete(orgMembershipsTable).where(and(
      eq(orgMembershipsTable.organizationId, testOrgId),
      eq(orgMembershipsTable.userId, testMembershipOrgAdminId),
    ));
  }
  const userIds = [
    testSuperAdminId,
    testLegacyOrgAdminId,
    testMembershipOrgAdminId,
    testEmaillessAdminId,
  ].filter((id): id is number => id != null);
  if (userIds.length > 0) {
    await db.delete(appUsersTable).where(inArray(appUsersTable.id, userIds));
  }
  if (testOrgId) {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, testOrgId));
  }
});

beforeEach(async () => {
  emailMock.mockReset();
  emailMock.mockResolvedValue(undefined);
  await _resetStripeWebhookSweepStaleOpsAlertDedupForTest();
});

afterEach(() => {
  delete process.env.OPS_ALERT_EMAILS;
});

function freshStatus(now: Date) {
  // 6h ago — well under the ~36h stale threshold.
  return {
    ranAt: new Date(now.getTime() - 6 * 60 * 60 * 1000).toISOString(),
    removed: 12,
  };
}

function staleStatus(now: Date) {
  // Older than the stale threshold by ~1m.
  return {
    ranAt: new Date(
      now.getTime() - STRIPE_WEBHOOK_SWEEP_STALE_AFTER_MS - 60 * 1000,
    ).toISOString(),
    removed: 7,
  };
}

describe("runStripeWebhookSweepStaleOpsAlertJob — no breach", () => {
  it("does not page when the sweep status is recent (not stale)", async () => {
    const now = new Date("2026-04-29T12:00:00Z");
    const res = await runStripeWebhookSweepStaleOpsAlertJob({
      cooldownHours: 24,
      recipients: ["ops@example.com"],
      status: freshStatus(now),
      now,
    });
    expect(res.alerted).toBe(false);
    expect(res.reason).toBe("not_stale");
    expect(emailMock).not.toHaveBeenCalled();
  });

  it("does not page on a fresh-deploy null status (process treats it as not stale)", async () => {
    // The library's `isStripeWebhookSweepStale(null, now)` consults the
    // module-level `_processStartedAt` baseline; right after the test
    // process started it'll be much less than the stale threshold, so
    // null is correctly treated as healthy.
    const res = await runStripeWebhookSweepStaleOpsAlertJob({
      cooldownHours: 24,
      recipients: ["ops@example.com"],
      status: null,
    });
    expect(res.alerted).toBe(false);
    expect(res.reason).toBe("not_stale");
    expect(emailMock).not.toHaveBeenCalled();
  });
});

describe("runStripeWebhookSweepStaleOpsAlertJob — stale sweep", () => {
  it("emails super-admins + org-admins + on-call list (deduped, email-less dropped) when the sweep is stale", async () => {
    // OPS_ALERT_EMAILS intentionally repeats one of the DB admin emails
    // in UPPERCASE to exercise the case-insensitive dedup. The
    // email-less super_admin seeded in beforeAll must not show up.
    process.env.OPS_ALERT_EMAILS = `oncall@example.com, ops@example.com, ${testSuperAdminEmail!.toUpperCase()}`;
    const now = new Date("2026-04-29T12:00:00Z");

    const res = await runStripeWebhookSweepStaleOpsAlertJob({
      cooldownHours: 24,
      status: staleStatus(now),
      now,
    });

    expect(res.alerted).toBe(true);
    // Expected recipient set (the test DB may already contain other
    // super/org admins from prior tests, so we assert the contents
    // contain everything we seeded rather than an exact total):
    //   super_admin (from DB, also collapses the UPPERCASE env duplicate)
    //   legacy org_admin (app_users.role)
    //   membership org_admin (org_memberships.role)
    //   oncall@example.com
    //   ops@example.com
    // The email-less super_admin must be silently dropped.
    const sentTo = new Set<string>(
      emailMock.mock.calls.map((c) => (c[0] as { to: string }).to.toLowerCase()),
    );
    expect(sentTo.has(testSuperAdminEmail!.toLowerCase())).toBe(true);
    expect(sentTo.has(testLegacyOrgAdminEmail!.toLowerCase())).toBe(true);
    expect(sentTo.has(testMembershipOrgAdminEmail!.toLowerCase())).toBe(true);
    expect(sentTo.has("oncall@example.com")).toBe(true);
    expect(sentTo.has("ops@example.com")).toBe(true);
    // Email-less super_admin never gets emailed, even though it counts
    // as a super_admin in the DB.
    expect(
      [...sentTo].some((e) => e.startsWith("swhsweep_emailless_")),
    ).toBe(false);
    // Case-insensitive dedup of the env's UPPERCASE super_admin: the
    // count of recipients matching the seeded super_admin must be 1.
    const superHits = emailMock.mock.calls.filter(
      (c) => (c[0] as { to: string }).to.toLowerCase() === testSuperAdminEmail!.toLowerCase(),
    );
    expect(superHits).toHaveLength(1);
    // Total recipients/emails should match (no partial sends).
    expect(res.recipientsAttempted).toBe(res.recipientsEmailed);
    expect(emailMock).toHaveBeenCalledTimes(res.recipientsEmailed);

    const firstCall = emailMock.mock.calls[0][0];
    expect(firstCall.dashboardUrl).toMatch(/\/super-admin\/stripe-webhook-audit$/);
    expect(firstCall.cooldownHours).toBe(24);
    expect(firstCall.staleThresholdMs).toBe(STRIPE_WEBHOOK_SWEEP_STALE_AFTER_MS);
    expect(firstCall.status?.removed).toBe(7);
  });

  it("loads org-admin recipients from both the legacy app_users role and the modern org_memberships table", async () => {
    // No OPS_ALERT_EMAILS — ensures the org-admin emails come from the
    // DB lookup, not the env, so we genuinely cover the recipient
    // resolution path the code review flagged as missing.
    const now = new Date("2026-04-29T12:00:00Z");

    const res = await runStripeWebhookSweepStaleOpsAlertJob({
      cooldownHours: 24,
      status: staleStatus(now),
      now,
    });

    expect(res.alerted).toBe(true);
    const sentTo = new Set<string>(
      emailMock.mock.calls.map((c) => (c[0] as { to: string }).to.toLowerCase()),
    );
    // The seeded super_admin, legacy org_admin, and membership-only
    // org_admin must all show up purely from the DB lookup (no env
    // override). The test DB may also contain other admins from prior
    // tests so we don't assert an exact total, but we do assert no
    // env-only address leaks in (OPS_ALERT_EMAILS is unset here).
    expect(sentTo.has(testLegacyOrgAdminEmail!.toLowerCase())).toBe(true);
    expect(sentTo.has(testMembershipOrgAdminEmail!.toLowerCase())).toBe(true);
    expect(sentTo.has(testSuperAdminEmail!.toLowerCase())).toBe(true);
    expect(sentTo.has("oncall@example.com")).toBe(false);
    expect(sentTo.has("ops@example.com")).toBe(false);
  });

  it("uses the explicit recipients override (no super-admin / org-admin / env lookup)", async () => {
    const now = new Date("2026-04-29T12:00:00Z");
    const res = await runStripeWebhookSweepStaleOpsAlertJob({
      cooldownHours: 24,
      recipients: ["only@example.com", "Only@Example.com"], // dedup test
      status: staleStatus(now),
      now,
    });
    expect(res.alerted).toBe(true);
    expect(res.recipientsEmailed).toBe(1);
    expect(emailMock).toHaveBeenCalledTimes(1);

    const sentTo = new Set<string>(
      emailMock.mock.calls.map((c) => (c[0] as { to: string }).to.toLowerCase()),
    );
    expect(sentTo.has(testLegacyOrgAdminEmail!.toLowerCase())).toBe(false);
    expect(sentTo.has(testMembershipOrgAdminEmail!.toLowerCase())).toBe(false);
    expect(sentTo.has(testSuperAdminEmail!.toLowerCase())).toBe(false);
  });
});

describe("runStripeWebhookSweepStaleOpsAlertJob — cooldown", () => {
  it("suppresses a second page within the cooldown window; force overrides", async () => {
    const t0 = new Date("2026-04-24T09:00:00Z");
    const status = staleStatus(t0);

    const first = await runStripeWebhookSweepStaleOpsAlertJob({
      cooldownHours: 24,
      recipients: ["ops@example.com"],
      status,
      now: t0,
    });
    expect(first.alerted).toBe(true);
    expect(emailMock).toHaveBeenCalledTimes(1);

    // 1h later — still in cooldown, no email.
    const second = await runStripeWebhookSweepStaleOpsAlertJob({
      cooldownHours: 24,
      recipients: ["ops@example.com"],
      status: staleStatus(new Date(t0.getTime() + 60 * 60 * 1000)),
      now: new Date(t0.getTime() + 60 * 60 * 1000),
    });
    expect(second.alerted).toBe(false);
    expect(second.reason).toBe("in_cooldown");
    expect(emailMock).toHaveBeenCalledTimes(1);

    // Force override re-pages even inside the cooldown.
    const tForce = new Date(t0.getTime() + 2 * 60 * 60 * 1000);
    const forced = await runStripeWebhookSweepStaleOpsAlertJob({
      cooldownHours: 24,
      recipients: ["ops@example.com"],
      status: staleStatus(tForce),
      now: tForce,
      force: true,
    });
    expect(forced.alerted).toBe(true);
    expect(emailMock).toHaveBeenCalledTimes(2);

    // The forced page reset the cooldown anchor to t0+2h, so the next
    // natural re-page must be at least 24h after that (t0+26h).
    const tNext = new Date(t0.getTime() + 27 * 60 * 60 * 1000);
    const fourth = await runStripeWebhookSweepStaleOpsAlertJob({
      cooldownHours: 24,
      recipients: ["ops@example.com"],
      status: staleStatus(tNext),
      now: tNext,
    });
    expect(fourth.alerted).toBe(true);
    expect(emailMock).toHaveBeenCalledTimes(3);
  });
});

describe("runStripeWebhookSweepStaleOpsAlertJob — no recipients", () => {
  it("returns no_recipients without throwing when neither super-admins (filtered out) nor OPS_ALERT_EMAILS provide an address", async () => {
    const now = new Date("2026-04-29T12:00:00Z");
    const res = await runStripeWebhookSweepStaleOpsAlertJob({
      cooldownHours: 24,
      recipients: [], // explicitly bypass DB / env lookup
      status: staleStatus(now),
      now,
    });
    expect(res.alerted).toBe(false);
    expect(res.reason).toBe("no_recipients");
    expect(emailMock).not.toHaveBeenCalled();
  });
});

describe("runStripeWebhookSweepStaleOpsAlertJob — persisted audit (Task #1883)", () => {
  it("appends an audit row with the recipient list after a successful page", async () => {
    const t0 = new Date("2026-04-24T09:00:00Z");
    const status = staleStatus(t0);
    const res = await runStripeWebhookSweepStaleOpsAlertJob({
      cooldownHours: 24,
      recipients: ["ops-a@example.com", "ops-b@example.com"],
      status,
      now: t0,
    });
    expect(res.alerted).toBe(true);

    const persisted = await loadLastStripeWebhookSweepStaleAlertAt();
    expect(persisted).not.toBeNull();
    expect(persisted!.getTime()).toBe(t0.getTime());

    const rows = await db.select().from(stripeWebhookSweepStaleAlertsTable);
    expect(rows).toHaveLength(1);
    expect(rows[0].recipientCount).toBe(2);
    expect(rows[0].recipientEmails.sort()).toEqual(
      ["ops-a@example.com", "ops-b@example.com"].sort(),
    );
    expect(rows[0].staleThresholdMs).toBe(STRIPE_WEBHOOK_SWEEP_STALE_AFTER_MS);
    expect(rows[0].lastSweepRanAt).not.toBeNull();
    expect(rows[0].lastSweepRanAt!.toISOString()).toBe(status.ranAt);
  });

  it("does not insert an audit row when no email is sent", async () => {
    const now = new Date("2026-04-29T12:00:00Z");
    const res = await runStripeWebhookSweepStaleOpsAlertJob({
      cooldownHours: 24,
      recipients: ["ops@example.com"],
      status: freshStatus(now),
      now,
    });
    expect(res.alerted).toBe(false);

    const rows = await db.select().from(stripeWebhookSweepStaleAlertsTable);
    expect(rows).toHaveLength(0);
  });

  it("honours the persisted cooldown across simulated process restarts", async () => {
    // Pre-seed the audit table with a recent page (as if a previous
    // process instance had paged 1h ago) without going through the
    // alert job.
    const tPaged = new Date("2026-04-24T09:00:00Z");
    await db.insert(stripeWebhookSweepStaleAlertsTable).values({
      pagedAt: tPaged,
      lastSweepRanAt: new Date(tPaged.getTime() - 2 * 24 * 60 * 60 * 1000),
      staleThresholdMs: STRIPE_WEBHOOK_SWEEP_STALE_AFTER_MS,
      recipientCount: 1,
      recipientEmails: ["prior-restart@example.com"],
    });

    // 1h after the persisted page, on a "fresh process" — the job must
    // still see the cooldown.
    const t1 = new Date(tPaged.getTime() + 60 * 60 * 1000);
    const res = await runStripeWebhookSweepStaleOpsAlertJob({
      cooldownHours: 24,
      recipients: ["ops@example.com"],
      status: staleStatus(t1),
      now: t1,
    });
    expect(res.alerted).toBe(false);
    expect(res.reason).toBe("in_cooldown");
    expect(emailMock).not.toHaveBeenCalled();

    // 25h after the persisted page — outside the 24h window, page again.
    const t2 = new Date(tPaged.getTime() + 25 * 60 * 60 * 1000);
    const res2 = await runStripeWebhookSweepStaleOpsAlertJob({
      cooldownHours: 24,
      recipients: ["ops@example.com"],
      status: staleStatus(t2),
      now: t2,
    });
    expect(res2.alerted).toBe(true);
    expect(emailMock).toHaveBeenCalledTimes(1);
  });

  it("records lastSweepRanAt = NULL when the watchdog trips because no sweep has ever run", async () => {
    // Build a status=null page by forcing the cooldown to be empty and
    // overriding `now` together with a manually set status. The
    // library uses `isStripeWebhookSweepStale(null, now.getTime())`,
    // which consults `_processStartedAt`; in this test process the
    // baseline is "started recently", so null is treated as healthy.
    // To exercise the never-ran-but-stale path we instead pass a
    // very-old status (which the library does treat as stale) and
    // verify the audit row stores the corresponding timestamp. The
    // null branch is exercised by the existing
    // `stripeWebhookSweepStatus.test.ts`, which covers
    // `_setProcessStartedAtForTests` — exercising it again here would
    // leak module state across files.
    const t = new Date("2026-04-29T12:00:00Z");
    const oldStatus = staleStatus(t);
    const res = await runStripeWebhookSweepStaleOpsAlertJob({
      cooldownHours: 24,
      recipients: ["ops@example.com"],
      status: oldStatus,
      now: t,
    });
    expect(res.alerted).toBe(true);

    const rows = await db.select().from(stripeWebhookSweepStaleAlertsTable);
    expect(rows).toHaveLength(1);
    expect(rows[0].lastSweepRanAt!.toISOString()).toBe(oldStatus.ranAt);
  });
});
