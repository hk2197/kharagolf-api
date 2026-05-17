/**
 * Task #1482 — In-app banner mirroring the snooze-ended email header.
 *
 * Task #1262 added an email header acknowledging an elapsed snooze; this
 * task adds the same acknowledgement to the admin custom-domain status
 * panel so an admin who only checks the dashboard sees it too.
 *
 * The contract verified here:
 *   - When the renudge cron fires for an org whose snooze just elapsed,
 *     it copies that snoozedUntil date into the new
 *     `customDomainCertSnoozeEndedFromUntil` column atomically with the
 *     same UPDATE that nulls the snooze and bumps notifiedAt.
 *   - The threshold-only re-nudge path (no snooze ever set) does NOT
 *     populate the new column.
 *   - GET /custom-domain/status surfaces `snoozeEndedFromUntil` only
 *     while the most recent re-nudge (notifiedAt) is younger than
 *     CUSTOM_DOMAIN_HTTPS_SNOOZE_ENDED_BANNER_TTL_DAYS — once the banner
 *     is older than the TTL the field is hidden so the panel doesn't
 *     keep nagging about an ancient snooze.
 *   - The column is auto-cleared by:
 *       - POST /custom-domain/retry (admin acted)
 *       - DELETE /custom-domain/snooze-renudge (admin acted, even when
 *         no snooze was set — the cancel handler always wipes the
 *         banner now so a stale acknowledgement can't survive a click)
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
  notifyCustomDomainCertTransition,
  renudgeStaleCustomDomainHttpsFailures,
  CUSTOM_DOMAIN_HTTPS_FAILED_RENUDGE_DAYS,
  CUSTOM_DOMAIN_HTTPS_SNOOZE_ENDED_BANNER_TTL_DAYS,
} from "../routes/organizations.js";

let orgId: number;
let adminUserId: number;
const HOST = "snooze-ended-banner.example.com";

beforeAll(async () => {
  // Make sure the enterprise tier allows custom domain so the cancel-snooze
  // / retry routes pass their feature gate.
  const existing = await db.query.subscriptionPlanConfigsTable.findFirst({
    where: eq(subscriptionPlanConfigsTable.tier, "enterprise"),
  });
  if (existing) {
    await db.update(subscriptionPlanConfigsTable).set({ customDomain: true })
      .where(eq(subscriptionPlanConfigsTable.tier, "enterprise"));
  } else {
    await db.insert(subscriptionPlanConfigsTable).values({ tier: "enterprise", customDomain: true });
  }

  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const [org] = await db.insert(organizationsTable).values({
    name: `TestOrg_HTTPSSnoozeEndedBanner_${stamp}`,
    slug: `test-https-snooze-ended-banner-${stamp}`,
    subscriptionTier: "enterprise",
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  const [admin] = await db.insert(appUsersTable).values({
    replitUserId: `local-snooze-ended-banner-${stamp}`,
    username: `snooze-ended-banner-admin-${stamp}`,
    email: `snooze-ended-banner-admin-${stamp}@example.com`,
    passwordHash: "x",
    displayName: "Snooze-Ended Banner Admin",
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
    username: "snooze-ended-banner-admin",
    role: "org_admin",
    organizationId: orgId,
  });
}

async function setOrgFailedState(notifiedAtDaysAgo: number, opts: {
  snoozedUntil?: Date | null;
  snoozeEndedFromUntil?: Date | null;
} = {}) {
  const notifiedAt = new Date(Date.now() - notifiedAtDaysAgo * 24 * 60 * 60 * 1000);
  await db.update(organizationsTable).set({
    customDomain: HOST,
    customDomainCertStatus: "failed",
    customDomainCertError: "DNS not pointing to ingress",
    customDomainCertNotifiedStatus: "failed",
    customDomainCertNotifiedHost: HOST,
    customDomainCertNotifiedAt: notifiedAt,
    customDomainCertRenudgeSnoozedUntil: opts.snoozedUntil ?? null,
    customDomainCertSnoozeEndedFromUntil: opts.snoozeEndedFromUntil ?? null,
  }).where(eq(organizationsTable.id, orgId));
}

describe("Task #1482 — snooze-ended banner column + GET status surface", () => {
  it("renudge job stamps customDomainCertSnoozeEndedFromUntil = elapsed snoozedUntil", async () => {
    const snoozedUntil = new Date(Date.now() - 24 * 60 * 60 * 1000);
    await setOrgFailedState(CUSTOM_DOMAIN_HTTPS_FAILED_RENUDGE_DAYS + 1, { snoozedUntil });

    await renudgeStaleCustomDomainHttpsFailures();

    const [row] = await db
      .select({
        snoozedUntil: organizationsTable.customDomainCertRenudgeSnoozedUntil,
        snoozeEndedFromUntil: organizationsTable.customDomainCertSnoozeEndedFromUntil,
      })
      .from(organizationsTable)
      .where(eq(organizationsTable.id, orgId));
    // Snooze itself was nulled atomically …
    expect(row.snoozedUntil).toBeNull();
    // … and the elapsed snooze date was copied into the banner column.
    expect(row.snoozeEndedFromUntil).toBeInstanceOf(Date);
    expect((row.snoozeEndedFromUntil as Date).getTime()).toBe(snoozedUntil.getTime());
  });

  it("threshold-only renudge (no snooze ever set) leaves the banner column null", async () => {
    await setOrgFailedState(CUSTOM_DOMAIN_HTTPS_FAILED_RENUDGE_DAYS + 1, { snoozedUntil: null });

    await renudgeStaleCustomDomainHttpsFailures();

    const [row] = await db
      .select({
        snoozeEndedFromUntil: organizationsTable.customDomainCertSnoozeEndedFromUntil,
      })
      .from(organizationsTable)
      .where(eq(organizationsTable.id, orgId));
    expect(row.snoozeEndedFromUntil).toBeNull();
  });

  it("initial failed transition does NOT populate the banner column", async () => {
    // Reset to a clean slate first so a previous snooze-ended stamp can't
    // mask a regression in the initial-transition path.
    await db.update(organizationsTable).set({
      customDomain: HOST,
      customDomainCertStatus: "pending",
      customDomainCertNotifiedStatus: null,
      customDomainCertNotifiedAt: null,
      customDomainCertSnoozeEndedFromUntil: null,
    }).where(eq(organizationsTable.id, orgId));

    await notifyCustomDomainCertTransition({
      orgId,
      host: HOST,
      status: "failed",
      errorMessage: "DNS not pointing to ingress",
    });

    const [row] = await db
      .select({
        snoozeEndedFromUntil: organizationsTable.customDomainCertSnoozeEndedFromUntil,
      })
      .from(organizationsTable)
      .where(eq(organizationsTable.id, orgId));
    expect(row.snoozeEndedFromUntil).toBeNull();
  });

  it("GET /custom-domain/status surfaces snoozeEndedFromUntil while within the TTL", async () => {
    const snoozedUntil = new Date(Date.now() - 24 * 60 * 60 * 1000);
    // notifiedAt = 1 day ago → comfortably under the 7-day TTL.
    await setOrgFailedState(1, { snoozeEndedFromUntil: snoozedUntil });

    const res = await request(adminApp())
      .get(`/api/organizations/${orgId}/custom-domain/status`);
    expect(res.status).toBe(200);
    expect(res.body.snoozeEndedFromUntil).toBe(snoozedUntil.toISOString());
  });

  it("GET /custom-domain/status hides snoozeEndedFromUntil once notifiedAt is older than the TTL", async () => {
    const snoozedUntil = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    // notifiedAt = TTL+1 days ago → banner must be hidden.
    const tooOldDays = CUSTOM_DOMAIN_HTTPS_SNOOZE_ENDED_BANNER_TTL_DAYS + 1;
    await setOrgFailedState(tooOldDays, { snoozeEndedFromUntil: snoozedUntil });

    const res = await request(adminApp())
      .get(`/api/organizations/${orgId}/custom-domain/status`);
    expect(res.status).toBe(200);
    expect(res.body.snoozeEndedFromUntil).toBeNull();
  });

  it("POST /custom-domain/retry clears the banner column", async () => {
    const snoozedUntil = new Date(Date.now() - 24 * 60 * 60 * 1000);
    await setOrgFailedState(1, { snoozeEndedFromUntil: snoozedUntil });

    const res = await request(adminApp())
      .post(`/api/organizations/${orgId}/custom-domain/retry`)
      .send({});
    // We don't care about the exact response shape (mock ingress may
    // succeed or fail) — only that the banner column is wiped.
    expect([200, 202]).toContain(res.status);

    const [row] = await db
      .select({
        snoozeEndedFromUntil: organizationsTable.customDomainCertSnoozeEndedFromUntil,
      })
      .from(organizationsTable)
      .where(eq(organizationsTable.id, orgId));
    expect(row.snoozeEndedFromUntil).toBeNull();
  });

  it("DELETE /custom-domain/snooze-renudge clears the banner column even when no snooze is active", async () => {
    // Banner present, snooze NOT active → the cancel-snooze handler
    // would otherwise be a no-op against the snooze field. Task #1482
    // makes the handler always run an UPDATE so the banner is wiped.
    const snoozedUntil = new Date(Date.now() - 24 * 60 * 60 * 1000);
    await setOrgFailedState(1, {
      snoozedUntil: null,
      snoozeEndedFromUntil: snoozedUntil,
    });

    const res = await request(adminApp())
      .delete(`/api/organizations/${orgId}/custom-domain/snooze-renudge`);
    expect(res.status).toBe(200);

    const [row] = await db
      .select({
        snoozeEndedFromUntil: organizationsTable.customDomainCertSnoozeEndedFromUntil,
      })
      .from(organizationsTable)
      .where(eq(organizationsTable.id, orgId));
    expect(row.snoozeEndedFromUntil).toBeNull();
  });
});
