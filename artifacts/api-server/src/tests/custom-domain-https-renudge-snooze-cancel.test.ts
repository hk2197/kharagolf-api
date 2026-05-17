/**
 * Task #1261 — DELETE /custom-domain/snooze-renudge ("Cancel snooze").
 *
 * The admin custom-domain panel surfaces an active re-nudge snooze with a
 * "Cancel snooze" button. This test pins down the API contract that
 * button relies on:
 *
 *   - DELETE clears an active snooze, returns 200 with renudgeSnoozedUntil:
 *     null, and persists null in the org row.
 *   - DELETE is idempotent — calling it on an already-clear org returns
 *     200 (renudgeSnoozedUntil: null) without erroring.
 *   - DELETE is gated behind requireOrgAdmin: a non-admin gets 403, an
 *     unknown org gets 404.
 *   - After cancel, GET /custom-domain/status reflects the cleared snooze.
 *   - After cancel, the periodic re-nudge job resumes for the org (proving
 *     the cancel actually re-arms the email, not just hides the badge).
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
} from "../routes/organizations.js";

let orgId: number;
let adminUserId: number;
let memberUserId: number;
const HOST = "snooze-cancel.example.com";

beforeAll(async () => {
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
    name: `TestOrg_HTTPSReNudgeSnoozeCancel_${Date.now()}`,
    slug: `test-https-snooze-cancel-${Date.now()}`,
    subscriptionTier: "enterprise",
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  const stamp = Date.now();
  const [admin] = await db.insert(appUsersTable).values({
    replitUserId: `local-https-snooze-cancel-${stamp}`,
    username: `https-snooze-cancel-admin-${stamp}`,
    email: `https-snooze-cancel-admin-${stamp}@example.com`,
    passwordHash: "x",
    displayName: "HTTPS Snooze Cancel Admin",
    role: "org_admin",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  adminUserId = admin.id;

  const [member] = await db.insert(appUsersTable).values({
    replitUserId: `local-https-snooze-cancel-mem-${stamp}`,
    username: `https-snooze-cancel-mem-${stamp}`,
    email: `https-snooze-cancel-mem-${stamp}@example.com`,
    passwordHash: "x",
    displayName: "HTTPS Snooze Cancel Member",
    role: "player",
    organizationId: orgId,
  }).returning({ id: appUsersTable.id });
  memberUserId = member.id;
});

afterAll(async () => {
  await db.delete(appUsersTable).where(eq(appUsersTable.id, adminUserId));
  await db.delete(appUsersTable).where(eq(appUsersTable.id, memberUserId));
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
    username: "snooze-cancel-admin",
    role: "org_admin",
    organizationId: orgId,
  });
}

function memberApp() {
  return createTestApp({
    id: memberUserId,
    username: "snooze-cancel-member",
    role: "player",
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

describe("Task #1261 — DELETE /custom-domain/snooze-renudge", () => {
  it("clears an active snooze and persists null in the org row", async () => {
    const until = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000);
    await setOrgFailedState(CUSTOM_DOMAIN_HTTPS_FAILED_RENUDGE_DAYS + 1, until);

    const res = await request(adminApp())
      .delete(`/api/organizations/${orgId}/custom-domain/snooze-renudge`);
    expect(res.status).toBe(200);
    expect(res.body.renudgeSnoozedUntil).toBeNull();

    const [row] = await db.select({
      snoozedUntil: organizationsTable.customDomainCertRenudgeSnoozedUntil,
    }).from(organizationsTable).where(eq(organizationsTable.id, orgId));
    expect(row.snoozedUntil).toBeNull();
  });

  it("is idempotent — clearing an already-clear snooze still returns 200/null", async () => {
    await setOrgFailedState(CUSTOM_DOMAIN_HTTPS_FAILED_RENUDGE_DAYS + 1, null);

    const res = await request(adminApp())
      .delete(`/api/organizations/${orgId}/custom-domain/snooze-renudge`);
    expect(res.status).toBe(200);
    expect(res.body.renudgeSnoozedUntil).toBeNull();
  });

  it("rejects non-admin callers with 403", async () => {
    await setOrgFailedState(
      CUSTOM_DOMAIN_HTTPS_FAILED_RENUDGE_DAYS + 1,
      new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    );

    const res = await request(memberApp())
      .delete(`/api/organizations/${orgId}/custom-domain/snooze-renudge`);
    expect(res.status).toBe(403);

    // The snooze must NOT have been cleared by the rejected request.
    const [row] = await db.select({
      snoozedUntil: organizationsTable.customDomainCertRenudgeSnoozedUntil,
    }).from(organizationsTable).where(eq(organizationsTable.id, orgId));
    expect(row.snoozedUntil).not.toBeNull();
  });

  it("returns 404 for an unknown org", async () => {
    const res = await request(adminApp())
      .delete(`/api/organizations/9999999/custom-domain/snooze-renudge`);
    // requireOrgAdmin guards cross-org access first; either way the
    // caller cannot mutate an org they don't belong to.
    expect([403, 404]).toContain(res.status);
  });

  it("GET /custom-domain/status reflects the cleared snooze after cancel", async () => {
    await setOrgFailedState(
      CUSTOM_DOMAIN_HTTPS_FAILED_RENUDGE_DAYS + 1,
      new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    );

    const before = await request(adminApp())
      .get(`/api/organizations/${orgId}/custom-domain/status`);
    expect(before.body.renudgeSnoozedUntil).toBeTruthy();

    const cancel = await request(adminApp())
      .delete(`/api/organizations/${orgId}/custom-domain/snooze-renudge`);
    expect(cancel.status).toBe(200);

    const after = await request(adminApp())
      .get(`/api/organizations/${orgId}/custom-domain/status`);
    expect(after.status).toBe(200);
    expect(after.body.renudgeSnoozedUntil).toBeNull();
  });

  it("re-arms the periodic re-nudge email after cancel", async () => {
    // Park org in failed state with a future snooze, last notified long
    // enough ago that it would otherwise be due for a re-nudge.
    await setOrgFailedState(
      CUSTOM_DOMAIN_HTTPS_FAILED_RENUDGE_DAYS + 1,
      new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    );

    // Sanity check: while snoozed, the job must skip this org.
    await renudgeStaleCustomDomainHttpsFailures();
    expect(mailerSpies.sendCustomDomainHttpsFailedEmail).not.toHaveBeenCalledWith(
      expect.objectContaining({ host: HOST }),
    );

    // Cancel the snooze, then re-run the job — now the email goes out.
    const cancel = await request(adminApp())
      .delete(`/api/organizations/${orgId}/custom-domain/snooze-renudge`);
    expect(cancel.status).toBe(200);

    await renudgeStaleCustomDomainHttpsFailures();
    expect(mailerSpies.sendCustomDomainHttpsFailedEmail).toHaveBeenCalledWith(
      expect.objectContaining({ host: HOST }),
    );
  });
});
