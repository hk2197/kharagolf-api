/**
 * Task #2023 — Regression test for the admin "Send test to me" endpoint.
 *
 * `POST /admin/notification-templates/:key/send-test` is the companion to
 * the preview endpoint added in Task #1631. It renders the canned
 * template for a notification key and dispatches it ONLY to the calling
 * admin via the registry's `defaultChannels`, so admins can verify the
 * live email/push channel works end-to-end without firing the real
 * upstream workflow.
 *
 * This test pins down:
 *   • Auth gating: 401 unauth, 403 for non-admin roles (including
 *     tournament_director, which IS allowed to preview but is NOT
 *     allowed to send real test mail/push to itself).
 *   • Unknown key returns 404 (parity with the preview endpoint).
 *   • Happy path: each channel in `defaultChannels` is attempted, an
 *     audit row is written per channel with `reason: "admin-test"` so
 *     analytics queries can exclude these from real-delivery dashboards,
 *     and the JSON response lists the per-channel outcome.
 *   • Email is targeted ONLY at the calling admin's address, never any
 *     other user's, even when the registry's spec lists recipients.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const auditInsertCalls: { values: unknown }[] = [];
const appUserSelectByIdImpl = vi.fn(
  async (_id: number): Promise<ReadonlyArray<{ email: string | null; displayName: string }>> =>
    [{ email: "admin@example.com", displayName: "Admin User" }],
);

vi.mock("@workspace/db", () => {
  const appUsersTable = {} as Record<string, unknown>;
  const notificationAuditLogTable = {} as Record<string, unknown>;
  return {
    db: {
      select: (_cols?: unknown) => ({
        from: (_table: unknown) => ({
          where: (_w: unknown) => ({
            limit: async (_n: number) => appUserSelectByIdImpl(1),
          }),
        }),
      }),
      insert: (_table: unknown) => ({
        values: (v: unknown) => {
          auditInsertCalls.push({ values: v });
          return Promise.resolve();
        },
      }),
    },
    appUsersTable,
    organizationsTable: {},
    tournamentsTable: {},
    playersTable: {},
    clubCurrencyProfilesTable: { baseCurrency: {}, organizationId: {} },
    stripeWebhookDeliveriesTable: {},
    stripeWebhookSweepRunsTable: {},
    notificationAuditLogTable,
    recapBroadcastsTable: {},
    recapShareEventsTable: { id: {} },
    recapShareDailyAggregatesTable: {},
    wearableReauthWowAcknowledgmentsTable: {},
    swingVideoFpsProbesTable: {},
    orgMembershipsTable: {},
    // adminEventMuteRegistry imports `userNotificationPrefsTable` and
    // reads a handful of column references at module init time. We don't
    // exercise those columns in this suite, but they need to exist as
    // truthy properties so the module doesn't throw while loading.
    userNotificationPrefsTable: {
      notifyWalletRefundDigestFailed: {},
      notifySideGameReceiptDigestFailed: {},
      notifyLevyLedgerDigestFailed: {},
      notifyLevyLedgerOrgDigestFailed: {},
      notifyLevyRemindersDigestFailed: {},
      notifyCoachPayoutAccountChanges: {},
      notifyManualEntryAlerts: {},
      notifyErasureStorageDigest: {},
      notifyErasureStorageDigestPush: {},
      notifyMemberPrefsDigest: {},
      notifyExhaustionAdminDigestFailed: {},
      notifySilentAlertsDigest: {},
    },
  };
});

vi.mock("drizzle-orm", () => ({
  and: () => ({}),
  count: () => ({}),
  desc: () => ({}),
  eq: () => ({}),
  gte: () => ({}),
  ilike: () => ({}),
  inArray: () => ({}),
  lte: () => ({}),
  or: () => ({}),
  sql: () => ({}),
}));

const sendNotificationEmailMock = vi.fn(async (_opts: Record<string, unknown>) => undefined);
vi.mock("../lib/mailer", () => ({
  sendBroadcastEmail: vi.fn(async () => undefined),
  sendNotificationEmail: sendNotificationEmailMock,
  validateMailerConfig: () => true,
}));

const sendPushToUsersMock = vi.fn(async (_userIds: number[], _payload?: unknown) => ({
  attempted: 1,
  sent: 1,
  failed: 0,
  invalid: 0,
}));
vi.mock("../lib/push", () => ({
  sendPushToUsers: sendPushToUsersMock,
  classifyPushDelivery: (r: { sent: number; failed: number }) =>
    r.sent > 0 ? "sent" : r.failed > 0 ? "failed" : "no_address",
}));

vi.mock("../lib/wearables", () => ({
  getLastWellnessSweepResult: async () => null,
  getWellnessSweepHistory: async () => [],
  getWeeklyReauthDriftSnapshot: async () => null,
  getWeeklyReauthDriftHistory: async () => [],
  WELLNESS_REAUTH_ALERT_DEFAULT_MIN_COUNT: 1,
  WELLNESS_REAUTH_ALERT_DEFAULT_MIN_SHARE_PCT: 1,
  WELLNESS_REAUTH_ALERT_DEFAULT_MIN_ATTEMPTED: 1,
}));

vi.mock("../lib/stripeWebhookSweepStatus", () => ({
  getLastStripeWebhookSweepResult: async () => null,
  isStripeWebhookSweepStale: () => false,
  STRIPE_WEBHOOK_SWEEP_STALE_AFTER_MS: 36 * 60 * 60 * 1000,
}));

const previewNotificationTemplateMock = vi.fn(async (key: string, _lang?: string) => {
  if (key === "does.not.exist") return null;
  return {
    key,
    category: "handicap",
    description: `Sample description for ${key}.`,
    digestable: true,
    defaultChannels: ["email", "push"],
    auditRequired: false,
    branded: true,
    lang: "en" as const,
    availableLanguages: ["en"] as const,
    sample: {
      title: "Test title",
      body: "Test body",
      html: "<!doctype html><html><body>Test</body></html>",
    },
  };
});
vi.mock("../lib/notifyDispatch", () => ({
  previewNotificationTemplate: previewNotificationTemplateMock,
}));

vi.mock("../lib/notificationRegistry", () => ({
  listRegistered: () => ["handicap.committee.changed"],
  listRegisteredDetails: async () => [],
}));

const { default: adminRouter } = await import("../routes/admin");

function buildApp(user: { id: number; role: string; organizationId?: number } | null) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (user) {
      req.user = user as Express.User;
      req.isAuthenticated = function (this: typeof req) { return this.user != null; } as typeof req.isAuthenticated;
    } else {
      req.isAuthenticated = function () { return false; } as typeof req.isAuthenticated;
    }
    next();
  });
  app.use(adminRouter);
  return app;
}

describe("POST /admin/notification-templates/:key/send-test (Task #2023)", () => {
  beforeEach(() => {
    auditInsertCalls.length = 0;
    sendNotificationEmailMock.mockClear();
    sendPushToUsersMock.mockClear();
    previewNotificationTemplateMock.mockClear();
    appUserSelectByIdImpl.mockClear();
    appUserSelectByIdImpl.mockImplementation(async () =>
      [{ email: "admin@example.com", displayName: "Admin User" }] as const,
    );
  });

  it("rejects unauthenticated callers with 401", async () => {
    const res = await request(buildApp(null))
      .post("/admin/notification-templates/handicap.committee.changed/send-test");
    expect(res.status).toBe(401);
  });

  it("rejects non-admin members with 403", async () => {
    const res = await request(buildApp({ id: 7, role: "member" }))
      .post("/admin/notification-templates/handicap.committee.changed/send-test");
    expect(res.status).toBe(403);
  });

  it("rejects tournament_director with 403 (test sends are stricter than preview)", async () => {
    // Preview is open to org_admin / tournament_director / super_admin.
    // Sending real mail/push to your own inbox is a heavier action, so
    // tournament_director is intentionally excluded here.
    const res = await request(buildApp({ id: 7, role: "tournament_director" }))
      .post("/admin/notification-templates/handicap.committee.changed/send-test");
    expect(res.status).toBe(403);
  });

  it("returns 404 for an unknown notification key", async () => {
    const res = await request(buildApp({ id: 1, role: "org_admin" }))
      .post("/admin/notification-templates/does.not.exist/send-test");
    expect(res.status).toBe(404);
  });

  it("dispatches each channel to the calling admin and audits with reason 'admin-test'", async () => {
    const res = await request(buildApp({ id: 1, role: "org_admin" }))
      .post("/admin/notification-templates/handicap.committee.changed/send-test");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.key).toBe("handicap.committee.changed");

    // Email leg targeted ONLY at the calling admin's address (the
    // app_users row we stubbed for id=1).
    expect(sendNotificationEmailMock).toHaveBeenCalledTimes(1);
    const emailArgs = sendNotificationEmailMock.mock.calls[0][0] as {
      to: string;
      notificationKey: string;
      preRendered: boolean;
      subject: string;
    };
    expect(emailArgs.to).toBe("admin@example.com");
    expect(emailArgs.notificationKey).toBe("handicap.committee.changed");
    expect(emailArgs.preRendered).toBe(true);
    expect(emailArgs.subject).toBe("Test title");

    // Push leg targeted ONLY at the calling admin's user id.
    expect(sendPushToUsersMock).toHaveBeenCalledTimes(1);
    expect(sendPushToUsersMock.mock.calls[0][0]).toEqual([1]);

    // One audit row per attempted channel, every one tagged
    // `reason: "admin-test"` so analytics can exclude them.
    expect(auditInsertCalls.length).toBe(2);
    const channels = auditInsertCalls.map(
      c => (c.values as { channel: string }).channel,
    );
    expect(channels.sort()).toEqual(["email", "push"]);
    for (const c of auditInsertCalls) {
      const v = c.values as {
        notificationKey: string;
        userId: number;
        reason: string;
        status: string;
        payload: Record<string, unknown>;
      };
      expect(v.notificationKey).toBe("handicap.committee.changed");
      expect(v.userId).toBe(1);
      expect(v.reason).toBe("admin-test");
      expect(v.status).toBe("sent");
      expect(v.payload.adminTest).toBe(true);
    }

    // JSON response surfaces per-channel outcome so the dialog can
    // toast which channels delivered.
    expect(Array.isArray(res.body.channels)).toBe(true);
    expect(res.body.channels).toHaveLength(2);
    const sentChannels = (res.body.channels as { channel: string; status: string }[])
      .filter(c => c.status === "sent")
      .map(c => c.channel)
      .sort();
    expect(sentChannels).toEqual(["email", "push"]);
  });

  it("skips email when the calling admin has no email on file (auditing the skip)", async () => {
    appUserSelectByIdImpl.mockImplementationOnce(async () =>
      [{ email: null, displayName: "Admin User" }] as const,
    );
    const res = await request(buildApp({ id: 1, role: "org_admin" }))
      .post("/admin/notification-templates/handicap.committee.changed/send-test");
    expect(res.status).toBe(200);
    expect(sendNotificationEmailMock).not.toHaveBeenCalled();
    const emailRow = (res.body.channels as { channel: string; status: string; reason?: string }[])
      .find(c => c.channel === "email");
    expect(emailRow?.status).toBe("skipped");
    expect(emailRow?.reason).toBe("no_email_on_file");
    // Audit row still written so the no-op is traceable.
    const emailAudit = auditInsertCalls.find(
      c => (c.values as { channel: string }).channel === "email",
    );
    expect(emailAudit).toBeDefined();
    expect((emailAudit!.values as { reason: string }).reason).toBe("admin-test");
    expect((emailAudit!.values as { status: string }).status).toBe("skipped");
  });

  it("super_admin is also allowed", async () => {
    const res = await request(buildApp({ id: 99, role: "super_admin" }))
      .post("/admin/notification-templates/handicap.committee.changed/send-test");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});
