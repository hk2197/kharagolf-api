/**
 * Task #1632 — Regression test for the admin notification-templates list endpoint.
 *
 * The "Notification template registry" panel on /admin reads from
 * `GET /admin/notification-templates`. The endpoint used to return only
 * `{ keys: string[] }`. After Task #1632 each entry must include the
 * key's category, human description, default channels, and audit-required
 * flag so admins can see what each key actually does without grepping.
 *
 * This test pins down:
 *   • Auth gating: 401 unauthenticated, 403 for non-admin roles.
 *   • Successful response shape: each entry carries the metadata fields.
 *   • Tournament directors and super admins are also allowed (matching
 *     the existing role allowlist).
 */
import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("@workspace/db", () => ({
  db: { select: () => ({ from: () => Promise.resolve([]) }) },
  organizationsTable: {},
  tournamentsTable: {},
  playersTable: {},
  appUsersTable: {},
  clubCurrencyProfilesTable: {},
  stripeWebhookDeliveriesTable: {},
  stripeWebhookSweepRunsTable: {},
  notificationAuditLogTable: {},
  recapBroadcastsTable: {},
  recapShareEventsTable: {},
  recapShareDailyAggregatesTable: {},
  wearableReauthWowAcknowledgmentsTable: {},
}));

vi.mock("../lib/mailer", () => ({
  sendBroadcastEmail: vi.fn(async () => undefined),
  validateMailerConfig: () => true,
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

vi.mock("../lib/notifyDispatch", () => ({
  previewNotificationTemplate: async () => null,
}));

vi.mock("../lib/notificationRegistry", () => ({
  listRegistered: () => [
    "booking.confirmed",
    "handicap.committee.changed",
  ],
  listRegisteredDetails: async () => [
    {
      key: "booking.confirmed",
      category: "tee",
      description: "Tee-time booking confirmed",
      defaultChannels: ["email", "push"],
      auditRequired: false,
    },
    {
      key: "handicap.committee.changed",
      category: "handicap",
      description: "Committee changed your handicap index",
      defaultChannels: ["email", "push"],
      auditRequired: true,
    },
  ],
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

describe("GET /admin/notification-templates (Task #1632)", () => {
  it("rejects unauthenticated callers with 401", async () => {
    const res = await request(buildApp(null)).get("/admin/notification-templates");
    expect(res.status).toBe(401);
  });

  it("rejects non-admin members with 403", async () => {
    const res = await request(buildApp({ id: 7, role: "member", organizationId: 1 }))
      .get("/admin/notification-templates");
    expect(res.status).toBe(403);
  });

  it("returns each registered key with category, description, defaultChannels and auditRequired", async () => {
    const res = await request(buildApp({ id: 1, role: "org_admin", organizationId: 1 }))
      .get("/admin/notification-templates");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      keys: [
        {
          key: "booking.confirmed",
          category: "tee",
          description: "Tee-time booking confirmed",
          defaultChannels: ["email", "push"],
          auditRequired: false,
        },
        {
          key: "handicap.committee.changed",
          category: "handicap",
          description: "Committee changed your handicap index",
          defaultChannels: ["email", "push"],
          auditRequired: true,
        },
      ],
    });
  });

  it("allows tournament directors and super admins", async () => {
    for (const role of ["tournament_director", "super_admin"]) {
      const res = await request(buildApp({ id: 1, role, organizationId: 1 }))
        .get("/admin/notification-templates");
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.keys)).toBe(true);
      expect(res.body.keys[0]).toHaveProperty("description");
      expect(res.body.keys[0]).toHaveProperty("defaultChannels");
      expect(res.body.keys[1]).toHaveProperty("auditRequired", true);
    }
  });
});
