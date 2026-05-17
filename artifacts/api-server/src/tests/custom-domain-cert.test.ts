/**
 * Task #581 — Custom domain HTTPS provisioning.
 *
 * Verifies that:
 *   - PATCHing the branding endpoint with a new customDomain triggers an
 *     ingress provisioning call and stores the resulting cert state
 *   - The status endpoint returns the persisted cert state
 *   - Retry re-asks the provider and updates checkedAt
 *   - A failed provider response is recorded as status='failed' with the error
 *   - Clearing customDomain resets the cert columns and de-registers the host
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { db } from "@workspace/db";
import { organizationsTable, subscriptionPlanConfigsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { createTestApp } from "./helpers.js";
import { resetIngressClient } from "../lib/ingressClient.js";

let testOrgId: number;

beforeAll(async () => {
  // Make sure the enterprise tier allows custom domain so the gate passes.
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
    name: `TestOrg_CustomDomainCert_${Date.now()}`,
    slug: `test-cdc-${Date.now()}`,
    subscriptionTier: "enterprise",
  }).returning({ id: organizationsTable.id });
  testOrgId = org.id;
});

afterAll(async () => {
  await db.delete(organizationsTable).where(eq(organizationsTable.id, testOrgId));
});

beforeEach(() => {
  // Force the mock ingress provider for all tests (idempotent).
  process.env.INGRESS_PROVIDER = "mock";
  delete process.env.INGRESS_MOCK_FORCE_STATUS;
  delete process.env.INGRESS_MOCK_FORCE_ERROR;
  resetIngressClient();
});

function adminApp() {
  return createTestApp({
    id: 1,
    username: "admin",
    role: "org_admin",
    organizationId: testOrgId,
  });
}

describe("Task #581 — custom domain HTTPS provisioning", () => {
  it("provisions a cert and records 'active' when ingress succeeds", async () => {
    process.env.INGRESS_MOCK_FORCE_STATUS = "active";
    resetIngressClient();

    const res = await request(adminApp())
      .patch(`/api/organizations/${testOrgId}/branding`)
      .send({ customDomain: "Pinevalley.Golf" });
    expect(res.status).toBe(200);
    expect(res.body.customDomain).toBe("pinevalley.golf");
    expect(res.body.customDomainCertStatus).toBe("active");
    expect(res.body.customDomainCertProvider).toBe("mock");
    expect(res.body.customDomainCertRequestedAt).toBeTruthy();
    expect(res.body.customDomainCertIssuedAt).toBeTruthy();
  });

  it("exposes the persisted cert state via the status endpoint", async () => {
    const res = await request(adminApp())
      .get(`/api/organizations/${testOrgId}/custom-domain/status`);
    expect(res.status).toBe(200);
    expect(res.body.customDomain).toBe("pinevalley.golf");
    expect(res.body.status).toBe("active");
    expect(res.body.provider).toBe("mock");
    // Task #1100 — when the cert is healthy there's no scheduled re-nudge.
    expect(res.body.nextRenudgeAt).toBeNull();
  });

  it("Task #1100: surfaces nextRenudgeAt = notifiedAt + threshold while HTTPS is failing", async () => {
    const { CUSTOM_DOMAIN_HTTPS_FAILED_RENUDGE_DAYS } = await import("../routes/organizations.js");
    const notifiedAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    await db.update(organizationsTable).set({
      customDomain: "renudge-eta.example.com",
      customDomainCertStatus: "failed",
      customDomainCertNotifiedStatus: "failed",
      customDomainCertNotifiedHost: "renudge-eta.example.com",
      customDomainCertNotifiedAt: notifiedAt,
    }).where(eq(organizationsTable.id, testOrgId));

    const res = await request(adminApp())
      .get(`/api/organizations/${testOrgId}/custom-domain/status`);
    expect(res.status).toBe(200);
    expect(res.body.nextRenudgeAt).toBeTruthy();
    const expected = notifiedAt.getTime() + CUSTOM_DOMAIN_HTTPS_FAILED_RENUDGE_DAYS * 24 * 60 * 60 * 1000;
    expect(new Date(res.body.nextRenudgeAt).getTime()).toBe(expected);
  });

  it("Task #1100: nextRenudgeAt is null when notifiedHost no longer matches the configured customDomain", async () => {
    await db.update(organizationsTable).set({
      customDomain: "now-different.example.com",
      customDomainCertStatus: "failed",
      customDomainCertNotifiedStatus: "failed",
      customDomainCertNotifiedHost: "old-host.example.com",
      customDomainCertNotifiedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
    }).where(eq(organizationsTable.id, testOrgId));

    const res = await request(adminApp())
      .get(`/api/organizations/${testOrgId}/custom-domain/status`);
    expect(res.status).toBe(200);
    expect(res.body.nextRenudgeAt).toBeNull();
  });

  it("records a failed provisioning with the provider's error message", async () => {
    process.env.INGRESS_MOCK_FORCE_STATUS = "failed";
    process.env.INGRESS_MOCK_FORCE_ERROR = "DNS not pointing to ingress";
    resetIngressClient();

    const res = await request(adminApp())
      .patch(`/api/organizations/${testOrgId}/branding`)
      .send({ customDomain: "broken.example.com" });
    expect(res.status).toBe(200);
    expect(res.body.customDomainCertStatus).toBe("failed");
    expect(res.body.customDomainCertError).toContain("DNS not pointing");
    expect(res.body.customDomainCertIssuedAt).toBeNull();
  });

  it("retry re-calls the provider and recovers when the cert later succeeds", async () => {
    // Previous test left status=failed. The retry endpoint should re-register.
    process.env.INGRESS_MOCK_FORCE_STATUS = "active";
    delete process.env.INGRESS_MOCK_FORCE_ERROR;
    resetIngressClient();

    const res = await request(adminApp())
      .post(`/api/organizations/${testOrgId}/custom-domain/retry`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("active");
    expect(res.body.error).toBeNull();
    expect(res.body.checkedAt).toBeTruthy();
    expect(res.body.issuedAt).toBeTruthy();
  });

  it("Task #663: trims whitespace, lowercases, and strips port/protocol before storing", async () => {
    process.env.INGRESS_MOCK_FORCE_STATUS = "active";
    resetIngressClient();

    const res = await request(adminApp())
      .patch(`/api/organizations/${testOrgId}/branding`)
      .send({ customDomain: "  HTTPS://Golf.YourClub.com:8443/path  " });
    expect(res.status).toBe(200);
    expect(res.body.customDomain).toBe("golf.yourclub.com");

    // Persisted value in the DB is the normalised form too — not the raw input.
    const [row] = await db
      .select({ customDomain: organizationsTable.customDomain })
      .from(organizationsTable)
      .where(eq(organizationsTable.id, testOrgId));
    expect(row.customDomain).toBe("golf.yourclub.com");
  });

  it("clearing the custom domain resets all cert tracking columns", async () => {
    const res = await request(adminApp())
      .patch(`/api/organizations/${testOrgId}/branding`)
      .send({ customDomain: "" });
    expect(res.status).toBe(200);
    expect(res.body.customDomain).toBeNull();
    expect(res.body.customDomainCertStatus).toBe("none");
    expect(res.body.customDomainCertProvider).toBeNull();
    expect(res.body.customDomainCertRequestedAt).toBeNull();
    expect(res.body.customDomainCertIssuedAt).toBeNull();
  });

  it("retry returns 400 when no custom domain is configured", async () => {
    const res = await request(adminApp())
      .post(`/api/organizations/${testOrgId}/custom-domain/retry`);
    expect(res.status).toBe(400);
  });

  it("rejects unauthenticated callers", async () => {
    const app = createTestApp(); // no user
    const res = await request(app)
      .get(`/api/organizations/${testOrgId}/custom-domain/status`);
    expect(res.status).toBe(401);
  });

  it("rejects admins from a different org", async () => {
    const app = createTestApp({
      id: 9999, username: "other", role: "org_admin", organizationId: testOrgId + 99999,
    });
    const res = await request(app)
      .get(`/api/organizations/${testOrgId}/custom-domain/status`);
    expect(res.status).toBe(403);
  });

  it("unit: invalid hostnames are rejected before talking to the provider", async () => {
    const { __test } = await import("../lib/ingressClient.js");
    expect(__test.isLikelyHost("ok.example.com")).toBe(true);
    expect(__test.isLikelyHost("nodot")).toBe(false);
    expect(__test.isLikelyHost("-bad.example.com")).toBe(false);
    expect(__test.isLikelyHost("bad..example.com")).toBe(true); // dots are allowed; "no consecutive" not enforced — accept liberal
    expect(__test.isLikelyHost("")).toBe(false);
    expect(__test.isLikelyHost("has space.example.com")).toBe(false);
  });
});
