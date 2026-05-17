/**
 * Task #667 — Periodic re-check of pending custom-domain certificates.
 *
 * Verifies that the background cron:
 *   - Flips a 'pending' org to 'active' once the ingress provider confirms.
 *   - Flips a 'pending' org to 'failed' (with the provider's error) when the
 *     provider permanently rejects the hostname.
 *   - Honours the per-row backoff so we don't hammer the provider — a row
 *     just-checked is skipped on the next pass.
 *   - Leaves orgs that aren't 'pending' (active, failed, none) untouched.
 *   - Records a transient ingress failure as an error message but keeps the
 *     row in 'pending' so the next backoff window retries.
 *   - The exported backoff helper grows the interval with request age.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { db } from "@workspace/db";
import { organizationsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  recheckPendingCustomDomainCerts,
  customDomainCertNextCheckBackoffMs,
} from "../lib/cron.js";
import { getIngressClient, resetIngressClient } from "../lib/ingressClient.js";

let pendingOrgId: number;
let activeOrgId: number;

beforeAll(async () => {
  const [pending] = await db.insert(organizationsTable).values({
    name: `TestOrg_CDCRecheck_pending_${Date.now()}`,
    slug: `test-cdc-recheck-pending-${Date.now()}`,
    customDomain: "pending.example.com",
    customDomainCertStatus: "pending",
    customDomainCertProvider: "mock",
    customDomainCertRequestedAt: new Date(Date.now() - 60 * 60 * 1000), // 1h old
    customDomainCertCheckedAt: new Date(Date.now() - 60 * 60 * 1000),
  }).returning({ id: organizationsTable.id });
  pendingOrgId = pending.id;

  const [active] = await db.insert(organizationsTable).values({
    name: `TestOrg_CDCRecheck_active_${Date.now()}`,
    slug: `test-cdc-recheck-active-${Date.now()}`,
    customDomain: "already.example.com",
    customDomainCertStatus: "active",
    customDomainCertProvider: "mock",
    customDomainCertRequestedAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
    customDomainCertIssuedAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
    customDomainCertCheckedAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
  }).returning({ id: organizationsTable.id });
  activeOrgId = active.id;
});

afterAll(async () => {
  await db.delete(organizationsTable).where(eq(organizationsTable.id, pendingOrgId));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, activeOrgId));
});

beforeEach(() => {
  process.env.INGRESS_PROVIDER = "mock";
  delete process.env.INGRESS_MOCK_FORCE_STATUS;
  delete process.env.INGRESS_MOCK_FORCE_ERROR;
  resetIngressClient();
});

async function setPending(opts: { requestedAt?: Date; checkedAt?: Date | null } = {}) {
  const now = new Date();
  await db.update(organizationsTable)
    .set({
      customDomainCertStatus: "pending",
      customDomainCertProvider: "mock",
      customDomainCertError: null,
      customDomainCertIssuedAt: null,
      customDomainCertRequestedAt: opts.requestedAt ?? new Date(now.getTime() - 60 * 60 * 1000),
      customDomainCertCheckedAt: opts.checkedAt === undefined
        ? new Date(now.getTime() - 60 * 60 * 1000)
        : opts.checkedAt,
    })
    .where(eq(organizationsTable.id, pendingOrgId));
}

describe("Task #667 — recheckPendingCustomDomainCerts", () => {
  it("flips a pending org to 'active' when the provider confirms", async () => {
    await setPending();
    process.env.INGRESS_MOCK_FORCE_STATUS = "active";
    resetIngressClient();

    await recheckPendingCustomDomainCerts();

    const [row] = await db.select().from(organizationsTable)
      .where(eq(organizationsTable.id, pendingOrgId));
    expect(row.customDomainCertStatus).toBe("active");
    expect(row.customDomainCertIssuedAt).toBeTruthy();
    expect(row.customDomainCertCheckedAt).toBeTruthy();
    expect(row.customDomainCertError).toBeNull();
  });

  it("flips a pending org to 'failed' with the provider's error message", async () => {
    await setPending();
    process.env.INGRESS_MOCK_FORCE_STATUS = "failed";
    process.env.INGRESS_MOCK_FORCE_ERROR = "DNS not pointing to ingress";
    resetIngressClient();

    await recheckPendingCustomDomainCerts();

    const [row] = await db.select().from(organizationsTable)
      .where(eq(organizationsTable.id, pendingOrgId));
    expect(row.customDomainCertStatus).toBe("failed");
    expect(row.customDomainCertError).toContain("DNS not pointing");
    expect(row.customDomainCertIssuedAt).toBeNull();
  });

  it("skips rows that were just checked (per-row backoff)", async () => {
    // requestedAt very recent (< 5 min) → backoff 1 min. checkedAt 10 s ago
    // means the row should be skipped on this pass.
    const now = new Date();
    await setPending({
      requestedAt: new Date(now.getTime() - 30 * 1000),
      checkedAt: new Date(now.getTime() - 10 * 1000),
    });
    process.env.INGRESS_MOCK_FORCE_STATUS = "active";
    resetIngressClient();

    await recheckPendingCustomDomainCerts();

    const [row] = await db.select().from(organizationsTable)
      .where(eq(organizationsTable.id, pendingOrgId));
    // Still pending — the cron must respect backoff and not have polled.
    expect(row.customDomainCertStatus).toBe("pending");
  });

  it("ignores orgs that aren't pending", async () => {
    await setPending();
    process.env.INGRESS_MOCK_FORCE_STATUS = "failed";
    process.env.INGRESS_MOCK_FORCE_ERROR = "should-not-affect-active-org";
    resetIngressClient();

    await recheckPendingCustomDomainCerts();

    const [activeRow] = await db.select().from(organizationsTable)
      .where(eq(organizationsTable.id, activeOrgId));
    expect(activeRow.customDomainCertStatus).toBe("active");
    expect(activeRow.customDomainCertError).toBeNull();
  });

  it("keeps the row 'pending' when the ingress provider call throws (transient)", async () => {
    await setPending();
    process.env.INGRESS_MOCK_FORCE_STATUS = "active";
    resetIngressClient();
    // Spy on the cached client so cron's getIngressClient() returns the same
    // instance whose getHostnameStatus we've mocked to throw.
    const client = getIngressClient();
    const spy = vi.spyOn(client, "getHostnameStatus").mockRejectedValue(
      new Error("ECONNREFUSED ingress.local"),
    );

    await recheckPendingCustomDomainCerts();

    spy.mockRestore();

    const [row] = await db.select().from(organizationsTable)
      .where(eq(organizationsTable.id, pendingOrgId));
    // Row stays pending so the next tick retries; checkedAt + error are
    // bumped so admins see the latest attempt and the backoff timer advances.
    expect(row.customDomainCertStatus).toBe("pending");
    expect(row.customDomainCertError).toContain("ECONNREFUSED");
    expect(row.customDomainCertCheckedAt).toBeTruthy();
    expect(row.customDomainCertIssuedAt).toBeNull();
  });

  it("backoff helper grows the interval with the age of the request", () => {
    expect(customDomainCertNextCheckBackoffMs(0)).toBe(60 * 1000);
    expect(customDomainCertNextCheckBackoffMs(4 * 60 * 1000)).toBe(60 * 1000);
    expect(customDomainCertNextCheckBackoffMs(10 * 60 * 1000)).toBe(5 * 60 * 1000);
    expect(customDomainCertNextCheckBackoffMs(60 * 60 * 1000)).toBe(15 * 60 * 1000);
    expect(customDomainCertNextCheckBackoffMs(6 * 60 * 60 * 1000)).toBe(60 * 60 * 1000);
  });
});
