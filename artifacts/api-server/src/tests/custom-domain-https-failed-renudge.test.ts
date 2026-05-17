/**
 * Task #951 — Re-nudge admins when a custom-domain HTTPS issue stays
 * unresolved.
 *
 * Verifies that the scheduled job:
 *   - Re-sends the "HTTPS failed" email to admins when an org's cert has
 *     been in 'failed' state and the last admin notification is older than
 *     the threshold; advances customDomainCertNotifiedAt so the admin UI
 *     line stays accurate and the next re-nudge holds off another window.
 *   - Does NOT re-nudge when the last notification is recent.
 *   - Does NOT re-nudge once the cert has flipped to 'active'.
 *   - Does NOT re-nudge once the custom domain is cleared.
 *   - Does NOT re-nudge when the customDomain has been changed to a
 *     different host since the last notification.
 *   - Is restart-safe: a second call inside the same window doesn't
 *     re-send (DB-backed claim).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

const mailerSpies = vi.hoisted(() => ({
  sendCustomDomainHttpsFailedEmail: vi.fn(async () => undefined),
  sendCustomDomainHttpsActiveEmail: vi.fn(async () => undefined),
}));
const { sendCustomDomainHttpsFailedEmail, sendCustomDomainHttpsActiveEmail } = mailerSpies;

vi.mock("../lib/mailer.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../lib/mailer.js")>();
  return {
    ...orig,
    sendCustomDomainHttpsFailedEmail: mailerSpies.sendCustomDomainHttpsFailedEmail,
    sendCustomDomainHttpsActiveEmail: mailerSpies.sendCustomDomainHttpsActiveEmail,
  };
});

import { db } from "@workspace/db";
import { organizationsTable, appUsersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  renudgeStaleCustomDomainHttpsFailures,
  CUSTOM_DOMAIN_HTTPS_FAILED_RENUDGE_DAYS,
} from "../routes/organizations.js";

let orgId: number;
let adminUserId: number;
const HOST = "renudge.example.com";

beforeAll(async () => {
  const [org] = await db.insert(organizationsTable).values({
    name: `TestOrg_HTTPSReNudge_${Date.now()}`,
    slug: `test-https-renudge-${Date.now()}`,
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  const stamp = Date.now();
  const [admin] = await db.insert(appUsersTable).values({
    replitUserId: `local-https-renudge-${stamp}`,
    username: `https-renudge-admin-${stamp}`,
    email: `https-renudge-admin-${stamp}@example.com`,
    passwordHash: "x",
    displayName: "HTTPS Re-nudge Admin",
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
  sendCustomDomainHttpsFailedEmail.mockClear();
  sendCustomDomainHttpsActiveEmail.mockClear();
});

async function setOrgState(patch: {
  status: "failed" | "active" | "none" | "pending";
  customDomain: string | null;
  notifiedStatus: "failed" | "active" | null;
  notifiedHost: string | null;
  notifiedAtDaysAgo: number | null;
  error?: string | null;
}) {
  const notifiedAt = patch.notifiedAtDaysAgo === null
    ? null
    : new Date(Date.now() - patch.notifiedAtDaysAgo * 24 * 60 * 60 * 1000);
  await db.update(organizationsTable).set({
    customDomain: patch.customDomain,
    customDomainCertStatus: patch.status,
    customDomainCertError: patch.error ?? null,
    customDomainCertNotifiedStatus: patch.notifiedStatus,
    customDomainCertNotifiedHost: patch.notifiedHost,
    customDomainCertNotifiedAt: notifiedAt,
  }).where(eq(organizationsTable.id, orgId));
}

describe("Task #951 — renudgeStaleCustomDomainHttpsFailures", () => {
  it("re-sends the failed email and advances notifiedAt when notification is older than the threshold", async () => {
    await setOrgState({
      status: "failed",
      customDomain: HOST,
      notifiedStatus: "failed",
      notifiedHost: HOST,
      notifiedAtDaysAgo: CUSTOM_DOMAIN_HTTPS_FAILED_RENUDGE_DAYS + 1,
      error: "DNS not pointing to ingress",
    });
    const before = Date.now();

    const result = await renudgeStaleCustomDomainHttpsFailures();

    expect(result.candidates).toBeGreaterThanOrEqual(1);
    expect(result.renudged).toBeGreaterThanOrEqual(1);
    expect(sendCustomDomainHttpsFailedEmail).toHaveBeenCalledTimes(1);
    const call = (sendCustomDomainHttpsFailedEmail.mock.calls[0] as unknown as [{ host: string; errorMessage: string | null }])[0];
    expect(call.host).toBe(HOST);
    expect(call.errorMessage).toBe("DNS not pointing to ingress");

    const [row] = await db.select({
      notifiedAt: organizationsTable.customDomainCertNotifiedAt,
    }).from(organizationsTable).where(eq(organizationsTable.id, orgId));
    expect(row.notifiedAt).toBeTruthy();
    expect(row.notifiedAt!.getTime()).toBeGreaterThanOrEqual(before);
  });

  it("does NOT re-nudge twice within the same window (restart-safe atomic claim)", async () => {
    await setOrgState({
      status: "failed",
      customDomain: HOST,
      notifiedStatus: "failed",
      notifiedHost: HOST,
      notifiedAtDaysAgo: CUSTOM_DOMAIN_HTTPS_FAILED_RENUDGE_DAYS + 1,
      error: "still bad",
    });

    const r1 = await renudgeStaleCustomDomainHttpsFailures();
    expect(r1.renudged).toBeGreaterThanOrEqual(1);
    expect(sendCustomDomainHttpsFailedEmail).toHaveBeenCalledTimes(1);

    // Simulate a second cron tick (e.g. after a server restart) right after.
    // notifiedAt was advanced to "now" by the first call, so this pass must
    // see the org as not-yet-due and send no further emails.
    const r2 = await renudgeStaleCustomDomainHttpsFailures();
    expect(r2.renudged).toBe(0);
    expect(sendCustomDomainHttpsFailedEmail).toHaveBeenCalledTimes(1);
  });

  it("does NOT re-nudge when notifiedAt is recent (within the window)", async () => {
    await setOrgState({
      status: "failed",
      customDomain: HOST,
      notifiedStatus: "failed",
      notifiedHost: HOST,
      notifiedAtDaysAgo: 1,
      error: "still bad",
    });

    const result = await renudgeStaleCustomDomainHttpsFailures();
    expect(result.renudged).toBe(0);
    expect(sendCustomDomainHttpsFailedEmail).not.toHaveBeenCalled();
  });

  it("stops re-nudging once the cert flips to 'active'", async () => {
    await setOrgState({
      status: "active",
      customDomain: HOST,
      notifiedStatus: "failed",
      notifiedHost: HOST,
      notifiedAtDaysAgo: CUSTOM_DOMAIN_HTTPS_FAILED_RENUDGE_DAYS + 1,
    });

    const result = await renudgeStaleCustomDomainHttpsFailures();
    expect(result.renudged).toBe(0);
    expect(sendCustomDomainHttpsFailedEmail).not.toHaveBeenCalled();
  });

  it("stops re-nudging once the custom domain is cleared", async () => {
    await setOrgState({
      status: "none",
      customDomain: null,
      notifiedStatus: "failed",
      notifiedHost: HOST,
      notifiedAtDaysAgo: CUSTOM_DOMAIN_HTTPS_FAILED_RENUDGE_DAYS + 1,
    });

    const result = await renudgeStaleCustomDomainHttpsFailures();
    expect(result.renudged).toBe(0);
    expect(sendCustomDomainHttpsFailedEmail).not.toHaveBeenCalled();
  });

  it("does NOT re-nudge when the customDomain has changed since the last notification", async () => {
    await setOrgState({
      status: "failed",
      customDomain: "newhost.example.com",
      notifiedStatus: "failed",
      notifiedHost: HOST, // mismatch
      notifiedAtDaysAgo: CUSTOM_DOMAIN_HTTPS_FAILED_RENUDGE_DAYS + 1,
    });

    const result = await renudgeStaleCustomDomainHttpsFailures();
    expect(result.renudged).toBe(0);
    expect(sendCustomDomainHttpsFailedEmail).not.toHaveBeenCalled();
  });
});
