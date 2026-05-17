/**
 * Task #1101 — Let admins snooze the HTTPS-failed re-nudge while they fix DNS.
 *
 * Verifies that:
 *   - POST /custom-domain/snooze-renudge records a future snooze-until on
 *     the org row (default 14 days; custom days accepted within bounds).
 *   - It rejects invalid days and rejects when the cert isn't 'failed'.
 *   - The re-nudge job skips orgs whose snooze-until is in the future and
 *     resumes once the snooze elapses.
 *   - The snooze auto-clears when the cert flips to 'active' (PATCH
 *     /branding, retry endpoint, and the pending-recheck cron path).
 *   - The snooze auto-clears when the custom domain is cleared.
 *   - GET /custom-domain/status surfaces the current snooze.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";

const mailerSpies = vi.hoisted(() => ({
  sendCustomDomainHttpsFailedEmail: vi.fn(async () => undefined),
  sendCustomDomainHttpsActiveEmail: vi.fn(async () => undefined),
}));
vi.mock("../lib/mailer.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../lib/mailer.js")>();
  return {
    ...orig,
    sendCustomDomainHttpsFailedEmail: mailerSpies.sendCustomDomainHttpsFailedEmail,
    sendCustomDomainHttpsActiveEmail: mailerSpies.sendCustomDomainHttpsActiveEmail,
  };
});

import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  subscriptionPlanConfigsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { createTestApp } from "./helpers.js";
import { resetIngressClient } from "../lib/ingressClient.js";
import {
  renudgeStaleCustomDomainHttpsFailures,
  CUSTOM_DOMAIN_HTTPS_FAILED_RENUDGE_DAYS,
  CUSTOM_DOMAIN_HTTPS_RENUDGE_SNOOZE_DEFAULT_DAYS,
  CUSTOM_DOMAIN_HTTPS_RENUDGE_SNOOZE_MAX_DAYS,
} from "../routes/organizations.js";
import { recheckPendingCustomDomainCerts } from "../lib/cron.js";

let orgId: number;
let adminUserId: number;
const HOST = "snooze.example.com";

beforeAll(async () => {
  // Make sure the enterprise tier allows custom domain so the gate passes
  // for the PATCH /branding paths exercised below.
  const existing = await db.query.subscriptionPlanConfigsTable.findFirst({
    where: eq(subscriptionPlanConfigsTable.tier, "enterprise"),
  });
  if (existing) {
    await db.update(subscriptionPlanConfigsTable).set({ customDomain: true })
      .where(eq(subscriptionPlanConfigsTable.tier, "enterprise"));
  } else {
    await db.insert(subscriptionPlanConfigsTable).values({ tier: "enterprise", customDomain: true });
  }

  const [org] = await db.insert(organizationsTable).values({
    name: `TestOrg_HTTPSReNudgeSnooze_${Date.now()}`,
    slug: `test-https-snooze-${Date.now()}`,
    subscriptionTier: "enterprise",
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  const stamp = Date.now();
  const [admin] = await db.insert(appUsersTable).values({
    replitUserId: `local-https-snooze-${stamp}`,
    username: `https-snooze-admin-${stamp}`,
    email: `https-snooze-admin-${stamp}@example.com`,
    passwordHash: "x",
    displayName: "HTTPS Snooze Admin",
    role: "org_admin",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  adminUserId = admin.id;
});

afterAll(async () => {
  await db.delete(appUsersTable).where(eq(appUsersTable.id, adminUserId));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
});

beforeEach(() => {
  mailerSpies.sendCustomDomainHttpsFailedEmail.mockClear();
  mailerSpies.sendCustomDomainHttpsActiveEmail.mockClear();
  process.env.INGRESS_PROVIDER = "mock";
  delete process.env.INGRESS_MOCK_FORCE_STATUS;
  delete process.env.INGRESS_MOCK_FORCE_ERROR;
  resetIngressClient();
});

function adminApp() {
  return createTestApp({
    id: adminUserId,
    username: "snooze-admin",
    role: "org_admin",
    organizationId: orgId,
  });
}

async function setOrgFailedState(notifiedAtDaysAgo: number, snoozedUntil: Date | null = null) {
  const notifiedAt = new Date(Date.now() - notifiedAtDaysAgo * 24 * 60 * 60 * 1000);
  await db.update(organizationsTable).set({
    customDomain: HOST,
    customDomainCertStatus: "failed",
    customDomainCertError: "DNS not pointing to ingress",
    customDomainCertNotifiedStatus: "failed",
    customDomainCertNotifiedHost: HOST,
    customDomainCertNotifiedAt: notifiedAt,
    customDomainCertRenudgeSnoozedUntil: snoozedUntil,
  }).where(eq(organizationsTable.id, orgId));
}

describe("Task #1101 — re-nudge snooze endpoint", () => {
  it("records a default 14-day snooze when no body is provided", async () => {
    await setOrgFailedState(CUSTOM_DOMAIN_HTTPS_FAILED_RENUDGE_DAYS + 1);
    const before = Date.now();

    const res = await request(adminApp())
      .post(`/api/organizations/${orgId}/custom-domain/snooze-renudge`)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.days).toBe(CUSTOM_DOMAIN_HTTPS_RENUDGE_SNOOZE_DEFAULT_DAYS);
    const until = new Date(res.body.renudgeSnoozedUntil).getTime();
    const expected = before + CUSTOM_DOMAIN_HTTPS_RENUDGE_SNOOZE_DEFAULT_DAYS * 24 * 60 * 60 * 1000;
    expect(until).toBeGreaterThanOrEqual(expected - 5_000);
    expect(until).toBeLessThanOrEqual(expected + 60_000);
  });

  it("accepts a custom days value within bounds", async () => {
    await setOrgFailedState(CUSTOM_DOMAIN_HTTPS_FAILED_RENUDGE_DAYS + 1);
    const res = await request(adminApp())
      .post(`/api/organizations/${orgId}/custom-domain/snooze-renudge`)
      .send({ days: 3 });
    expect(res.status).toBe(200);
    expect(res.body.days).toBe(3);
  });

  it("rejects invalid days values", async () => {
    await setOrgFailedState(CUSTOM_DOMAIN_HTTPS_FAILED_RENUDGE_DAYS + 1);
    for (const days of [0, -1, 1.5, CUSTOM_DOMAIN_HTTPS_RENUDGE_SNOOZE_MAX_DAYS + 1, "x"]) {
      const res = await request(adminApp())
        .post(`/api/organizations/${orgId}/custom-domain/snooze-renudge`)
        .send({ days });
      expect(res.status).toBe(400);
    }
  });

  it("rejects snoozing when the cert isn't in 'failed' state", async () => {
    await db.update(organizationsTable).set({
      customDomain: HOST,
      customDomainCertStatus: "active",
      customDomainCertRenudgeSnoozedUntil: null,
    }).where(eq(organizationsTable.id, orgId));

    const res = await request(adminApp())
      .post(`/api/organizations/${orgId}/custom-domain/snooze-renudge`)
      .send({});
    expect(res.status).toBe(400);
  });

  it("surfaces the active snooze via /custom-domain/status", async () => {
    const until = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
    await setOrgFailedState(CUSTOM_DOMAIN_HTTPS_FAILED_RENUDGE_DAYS + 1, until);

    const res = await request(adminApp())
      .get(`/api/organizations/${orgId}/custom-domain/status`);
    expect(res.status).toBe(200);
    expect(res.body.renudgeSnoozedUntil).toBeTruthy();
    expect(new Date(res.body.renudgeSnoozedUntil).getTime()).toBeCloseTo(until.getTime(), -3);
  });
});

describe("Task #1101 — re-nudge job honours the snooze", () => {
  it("skips orgs whose snooze is still in the future", async () => {
    const until = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
    await setOrgFailedState(CUSTOM_DOMAIN_HTTPS_FAILED_RENUDGE_DAYS + 1, until);

    const result = await renudgeStaleCustomDomainHttpsFailures();
    // Other tests in the suite may produce unrelated failed-cert candidates
    // for their own orgs, so we only assert this org wasn't re-nudged.
    expect(mailerSpies.sendCustomDomainHttpsFailedEmail).not.toHaveBeenCalledWith(
      expect.objectContaining({ host: HOST }),
    );

    const [row] = await db.select({
      notifiedAt: organizationsTable.customDomainCertNotifiedAt,
    }).from(organizationsTable).where(eq(organizationsTable.id, orgId));
    // notifiedAt must NOT have been advanced for the snoozed org.
    expect(row.notifiedAt!.getTime()).toBeLessThan(Date.now() - CUSTOM_DOMAIN_HTTPS_FAILED_RENUDGE_DAYS * 24 * 60 * 60 * 1000);
    void result;
  });

  it("resumes re-nudging once the snooze has elapsed", async () => {
    const past = new Date(Date.now() - 24 * 60 * 60 * 1000);
    await setOrgFailedState(CUSTOM_DOMAIN_HTTPS_FAILED_RENUDGE_DAYS + 1, past);

    await renudgeStaleCustomDomainHttpsFailures();
    expect(mailerSpies.sendCustomDomainHttpsFailedEmail).toHaveBeenCalledWith(
      expect.objectContaining({ host: HOST }),
    );
  });
});

describe("Task #1101 — snooze auto-clears", () => {
  it("clears when the custom domain is cleared via PATCH /branding", async () => {
    await setOrgFailedState(1, new Date(Date.now() + 7 * 24 * 60 * 60 * 1000));

    const res = await request(adminApp())
      .patch(`/api/organizations/${orgId}/branding`)
      .send({ customDomain: "" });
    expect(res.status).toBe(200);

    const [row] = await db.select({
      snoozedUntil: organizationsTable.customDomainCertRenudgeSnoozedUntil,
    }).from(organizationsTable).where(eq(organizationsTable.id, orgId));
    expect(row.snoozedUntil).toBeNull();
  });

  it("clears when the custom domain is changed via PATCH /branding", async () => {
    process.env.INGRESS_MOCK_FORCE_STATUS = "failed";
    process.env.INGRESS_MOCK_FORCE_ERROR = "still bad";
    resetIngressClient();
    await setOrgFailedState(1, new Date(Date.now() + 7 * 24 * 60 * 60 * 1000));

    const res = await request(adminApp())
      .patch(`/api/organizations/${orgId}/branding`)
      .send({ customDomain: "different-host.example.com" });
    expect(res.status).toBe(200);

    const [row] = await db.select({
      snoozedUntil: organizationsTable.customDomainCertRenudgeSnoozedUntil,
    }).from(organizationsTable).where(eq(organizationsTable.id, orgId));
    expect(row.snoozedUntil).toBeNull();
  });

  it("clears when the retry endpoint flips the cert to 'active'", async () => {
    // Set a failed state with snooze, pointed at the host the retry will use.
    await setOrgFailedState(1, new Date(Date.now() + 7 * 24 * 60 * 60 * 1000));
    process.env.INGRESS_MOCK_FORCE_STATUS = "active";
    delete process.env.INGRESS_MOCK_FORCE_ERROR;
    resetIngressClient();

    const res = await request(adminApp())
      .post(`/api/organizations/${orgId}/custom-domain/retry`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("active");

    const [row] = await db.select({
      snoozedUntil: organizationsTable.customDomainCertRenudgeSnoozedUntil,
    }).from(organizationsTable).where(eq(organizationsTable.id, orgId));
    expect(row.snoozedUntil).toBeNull();
  });

  it("clears when the pending-recheck cron flips the cert to 'active'", async () => {
    // Park the org in pending state with a still-active snooze, then make
    // the mock provider report 'active' on the recheck.
    await db.update(organizationsTable).set({
      customDomain: HOST,
      customDomainCertStatus: "pending",
      customDomainCertProvider: "mock",
      customDomainCertRequestedAt: new Date(Date.now() - 6 * 60 * 60 * 1000),
      customDomainCertCheckedAt: new Date(Date.now() - 6 * 60 * 60 * 1000),
      customDomainCertRenudgeSnoozedUntil: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    }).where(eq(organizationsTable.id, orgId));

    process.env.INGRESS_MOCK_FORCE_STATUS = "active";
    delete process.env.INGRESS_MOCK_FORCE_ERROR;
    resetIngressClient();

    await recheckPendingCustomDomainCerts();

    const [row] = await db.select({
      status: organizationsTable.customDomainCertStatus,
      snoozedUntil: organizationsTable.customDomainCertRenudgeSnoozedUntil,
    }).from(organizationsTable).where(eq(organizationsTable.id, orgId));
    expect(row.status).toBe("active");
    expect(row.snoozedUntil).toBeNull();
  });
});
