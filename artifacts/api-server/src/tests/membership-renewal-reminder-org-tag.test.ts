/**
 * Spot-check test (Task #1566) — verifies that the bulk membership renewal
 * reminder broadcast is tagged with `organizationId` so the Postmark bounce
 * webhook (Task #981) can attribute hard bounces back to the originating
 * club instantly without falling through to the slow campaign / membership
 * scan fallback.
 *
 * Mirrors `stripe-webhook-shop-receipt.test.ts` (which asserts
 * `branding.orgId === org.id` on the receipt mailer call) at the
 * `comms.sendBroadcast` boundary — which is where the route surface area
 * propagates `organizationId` into the email's `branding.orgId` →
 * `flowHints` → `metadata.orgId` chain.
 *
 * Endpoint exercised:
 *   POST /api/organizations/:orgId/club-members/members/bulk-renew-reminder
 *
 * One spot-check is sufficient because every other call site in this task
 * follows the same pattern (`{ ..., organizationId: orgId }`); the
 * `comms.sendBroadcast` adapter is what actually transforms the field into
 * `branding.orgId` and is already covered by Task #1319's adapter tests.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

const { sendBroadcastMock } = vi.hoisted(() => ({
  sendBroadcastMock: vi.fn(
    async (
      _recipients: unknown,
      _opts: Record<string, unknown>,
    ) => ({}),
  ),
}));

vi.mock("../lib/comms.js", () => ({
  sendBroadcast: sendBroadcastMock,
  sendInvite: vi.fn(async () => ({})),
  sendTransactionalPush: vi.fn(async () => undefined),
  sendTransactionalSms: vi.fn(async () => undefined),
  sendTransactionalWhatsapp: vi.fn(async () => undefined),
}));

import request from "supertest";
import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  orgMembershipsTable,
  clubMembersTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { createTestApp, uid } from "./helpers.js";

let orgId: number;
let adminId: number;

beforeAll(async () => {
  const tag = uid("memb-renew-org-tag");

  const [org] = await db.insert(organizationsTable).values({
    name: `Org ${tag}`,
    slug: tag,
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  const [admin] = await db.insert(appUsersTable).values({
    replitUserId: `${tag}-admin`,
    username: `${tag}_admin`,
    displayName: "Admin",
    email: `${tag}-admin@example.com`,
    role: "org_admin",
  }).returning({ id: appUsersTable.id });
  adminId = admin.id;

  await db.insert(orgMembershipsTable).values({
    organizationId: orgId,
    userId: adminId,
    role: "org_admin",
  });

  // One club member with a renewal date inside the 30-day reminder window
  // and a real email so they make it through the recipients filter.
  const renewalDate = new Date();
  renewalDate.setDate(renewalDate.getDate() + 7);
  await db.insert(clubMembersTable).values({
    organizationId: orgId,
    firstName: "Member",
    lastName: "Due",
    email: `${tag}-member@example.com`,
    renewalDate,
  });
});

afterAll(async () => {
  // Best-effort cleanup; cascade handles the rest.
  await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId)).catch(() => {});
});

beforeEach(() => {
  sendBroadcastMock.mockClear();
});

describe("Bulk membership renewal reminder → broadcast org tag (Task #1566)", () => {
  it("calls sendBroadcast with organizationId === org.id so the bounce webhook can attribute bounces back to the club", async () => {
    const app = createTestApp({
      id: adminId,
      username: "admin",
      role: "org_admin",
      organizationId: orgId,
    });

    const res = await request(app)
      .post(`/api/organizations/${orgId}/club-members/members/bulk-renew-reminder`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.sent).toBeGreaterThan(0);

    expect(sendBroadcastMock).toHaveBeenCalledTimes(1);
    const [recipients, opts] = sendBroadcastMock.mock.calls[0]! as [
      Array<{ email?: string }>,
      {
        channels: string[];
        subject: string;
        body: string;
        eventName: string;
        organizationId?: number;
      },
    ];
    expect(recipients.length).toBeGreaterThan(0);
    expect(opts.channels).toContain("email");
    // Task #1566 — the originating org id MUST be propagated so
    // `comms.sendBroadcast` can build `branding.orgId` and the Postmark
    // bounce webhook (Task #981) can attribute hard bounces back to this
    // club instantly.
    expect(opts.organizationId).toBe(orgId);
  });
});
