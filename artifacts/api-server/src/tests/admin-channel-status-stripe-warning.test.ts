/**
 * Task #830 — Regression test for the Stripe-misconfigured admin warning.
 *
 * The admin settings UI surfaces a warning banner / "Action required" badge
 * when the org's base currency is non-INR (so checkout would route through
 * Stripe) AND STRIPE_WEBHOOK_SECRET is unset. This test pins down the
 * GET /admin/channel-status contract that the banner reads from:
 *
 *   - non-INR base + secret unset  → payments.stripe.warning === true
 *   - non-INR base + secret set    → payments.stripe.warning === false
 *   - INR  base + secret unset     → payments.stripe.warning === false
 *
 * The DB is mocked so the test exercises only the routing/derivation logic
 * in routes/admin.ts; lib side-effects (mailer / wearables) are stubbed to
 * keep import-time work inert.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";

const hoisted = vi.hoisted(() => ({
  dbResults: [] as unknown[][],
}));

vi.mock("@workspace/db", () => {
  const buildSelectChain = () => {
    const promise = Promise.resolve(hoisted.dbResults.shift() ?? []);
    const chain: Record<string, unknown> = {};
    chain.from = () => chain;
    chain.where = () => chain;
    chain.orderBy = () => chain;
    chain.limit = () => promise;
    chain.then = promise.then.bind(promise);
    chain.catch = promise.catch.bind(promise);
    return chain;
  };
  return {
    db: { select: () => buildSelectChain() },
    organizationsTable: {},
    tournamentsTable: { status: {} },
    playersTable: {},
    appUsersTable: {},
    clubCurrencyProfilesTable: { baseCurrency: {}, organizationId: {} },
  };
});

vi.mock("../lib/mailer", () => ({
  sendBroadcastEmail: vi.fn(async () => undefined),
  validateMailerConfig: () => true,
}));

vi.mock("../lib/wearables", () => ({
  getLastWellnessSweepResult: async () => null,
  getWellnessSweepHistory: async () => [],
}));

// Imported AFTER mocks so the module picks them up.
const { default: adminRouter } = await import("../routes/admin");

function buildApp(user: { id: number; role: string; organizationId?: number }) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = user as Express.User;
    req.isAuthenticated = function (this: typeof req) { return this.user != null; } as typeof req.isAuthenticated;
    next();
  });
  app.use(adminRouter);
  return app;
}

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  hoisted.dbResults.length = 0;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("GET /admin/channel-status — Stripe webhook warning", () => {
  it("warns when org baseCurrency is non-INR and STRIPE_WEBHOOK_SECRET is unset", async () => {
    delete process.env.STRIPE_WEBHOOK_SECRET;
    hoisted.dbResults.push([{ baseCurrency: "USD" }]);

    const app = buildApp({ id: 1, role: "org_admin", organizationId: 42 });
    const res = await request(app).get("/admin/channel-status");

    expect(res.status).toBe(200);
    expect(res.body.payments.stripe.baseCurrency).toBe("USD");
    expect(res.body.payments.stripe.usesStripe).toBe(true);
    expect(res.body.payments.stripe.webhookSecretConfigured).toBe(false);
    expect(res.body.payments.stripe.warning).toBe(true);
    expect(res.body.payments.stripe.setupInstructions).toMatch(/STRIPE_WEBHOOK_SECRET/);
  });

  it("does not warn when STRIPE_WEBHOOK_SECRET is set, even for non-INR orgs", async () => {
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_xxx";
    hoisted.dbResults.push([{ baseCurrency: "EUR" }]);

    const app = buildApp({ id: 1, role: "org_admin", organizationId: 42 });
    const res = await request(app).get("/admin/channel-status");

    expect(res.status).toBe(200);
    expect(res.body.payments.stripe.baseCurrency).toBe("EUR");
    expect(res.body.payments.stripe.usesStripe).toBe(true);
    expect(res.body.payments.stripe.webhookSecretConfigured).toBe(true);
    expect(res.body.payments.stripe.warning).toBe(false);
    expect(res.body.payments.stripe.setupInstructions).toBeNull();
  });

  it("does not warn for INR-base orgs even when STRIPE_WEBHOOK_SECRET is unset", async () => {
    delete process.env.STRIPE_WEBHOOK_SECRET;
    hoisted.dbResults.push([{ baseCurrency: "INR" }]);

    const app = buildApp({ id: 1, role: "org_admin", organizationId: 42 });
    const res = await request(app).get("/admin/channel-status");

    expect(res.status).toBe(200);
    expect(res.body.payments.stripe.baseCurrency).toBe("INR");
    expect(res.body.payments.stripe.usesStripe).toBe(false);
    expect(res.body.payments.stripe.webhookSecretConfigured).toBe(false);
    // INR clubs route through Razorpay, so the missing Stripe webhook secret
    // is not a misconfiguration for them — the banner must stay hidden.
    expect(res.body.payments.stripe.warning).toBe(false);
  });

  it("treats a missing club_currency_profiles row as INR (no warning)", async () => {
    delete process.env.STRIPE_WEBHOOK_SECRET;
    hoisted.dbResults.push([]); // no profile row → falls back to INR

    const app = buildApp({ id: 1, role: "org_admin", organizationId: 42 });
    const res = await request(app).get("/admin/channel-status");

    expect(res.status).toBe(200);
    expect(res.body.payments.stripe.baseCurrency).toBe("INR");
    expect(res.body.payments.stripe.warning).toBe(false);
  });
});
