/**
 * Spot-check test (Task #1952) — verifies that the dues-invoice "send"
 * endpoint dispatches a real broadcast through the documented
 * `BroadcastOptions` shape (`{ subject, body, channels, eventName, ... }`)
 * so the email/SMS/WhatsApp adapters in `comms.sendBroadcast` actually fire
 * for a member with an email on file.
 *
 * Background: a previous version of this route called `sendBroadcast` with
 * an in-app push shape (`{ title, body, data }`) which silently bypassed
 * every external channel — the broadcast looked successful but never reached
 * the email adapter and the `organizationId` tag added in Task #1566 had
 * nowhere to land. This test pins the corrected shape so the regression
 * cannot reappear.
 *
 * Endpoint exercised:
 *   POST /api/organizations/:orgId/dues-billing/invoices/:id/send
 *
 * Asserts:
 *   - `sendBroadcast` is invoked exactly once.
 *   - The recipient list carries the member's email.
 *   - The options use the documented `BroadcastOptions` keys (`subject`,
 *     `body`, `channels`, `eventName`) — NOT the legacy push-only
 *     `{ title, body, data }` shape.
 *   - `channels` includes `"email"` so the email adapter actually runs.
 *   - `organizationId === org.id` so the Postmark bounce webhook
 *     (Task #981) can attribute hard bounces back to this club instantly.
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

// The send endpoint will try to lazily create a payment link via the
// payment-processor abstraction when one isn't already on the invoice. We
// pre-populate `razorpayPaymentLinkUrl` below so this branch is skipped, but
// stub the module anyway so the import doesn't reach into Razorpay/Stripe
// SDKs during the test.
vi.mock("../lib/checkout", async () => {
  const actual = await vi.importActual<typeof import("../lib/checkout")>("../lib/checkout");
  return {
    ...actual,
    createCheckoutPaymentLink: vi.fn(
      async () => ({ id: "stub_link", url: "https://example.test/pay/stub" }),
    ),
    resolveOrgTaxes: vi.fn(async () => ({ taxableAmount: 0, totalTax: 0, lines: [] })),
  };
});

import request from "supertest";
import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  orgMembershipsTable,
  clubMembersTable,
  memberInvoicesTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { createTestApp, uid, type TestUser } from "./helpers.js";

let orgId: number;
let adminId: number;
let memberUserId: number;
let invoiceId: number;
let memberEmail: string;

beforeAll(async () => {
  const tag = uid("dues-notify");

  const [org] = await db.insert(organizationsTable).values({
    name: `Dues Notify Org ${tag}`,
    slug: tag,
    // duesBilling is gated behind pro/enterprise tiers — the route mounts
    // `gateFeature("duesBilling")` at the top of dues-billing.ts.
    subscriptionTier: "pro",
    subscriptionStatus: "active",
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

  // The member who will receive the dues invoice notification. We need
  // `userId` set so the route's `if (invoice.userId)` guard fires, and an
  // `email` so the broadcast recipient carries an address that the email
  // adapter would normally deliver to.
  const [memberUser] = await db.insert(appUsersTable).values({
    replitUserId: `${tag}-member`,
    username: `${tag}_member`,
    displayName: "Dues Member",
    email: `${tag}-member@example.com`,
    role: "player",
  }).returning({ id: appUsersTable.id });
  memberUserId = memberUser.id;

  memberEmail = `${tag}-member-on-invoice@example.com`;
  const [member] = await db.insert(clubMembersTable).values({
    organizationId: orgId,
    userId: memberUserId,
    firstName: "Dues",
    lastName: "Member",
    email: memberEmail,
    memberNumber: `M-${tag}`,
    subscriptionStatus: "active",
  }).returning({ id: clubMembersTable.id });

  // Pre-populate `razorpayPaymentLinkUrl` so the send route skips the
  // payment-link creation branch and goes straight to dispatching the
  // notification.
  const [invoice] = await db.insert(memberInvoicesTable).values({
    organizationId: orgId,
    clubMemberId: member.id,
    invoiceNumber: `INV-${tag}`,
    status: "draft",
    totalAmount: "5000.00",
    currency: "INR",
    razorpayPaymentLinkId: "plink_existing",
    razorpayPaymentLinkUrl: "https://example.test/pay/existing",
  }).returning({ id: memberInvoicesTable.id });
  invoiceId = invoice.id;
});

afterAll(async () => {
  // Best-effort cleanup; cascade handles the rest.
  await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId)).catch(() => {});
});

beforeEach(() => {
  sendBroadcastMock.mockClear();
});

describe("POST /dues-billing/invoices/:id/send → broadcast shape (Task #1952)", () => {
  it("dispatches sendBroadcast with the documented BroadcastOptions shape so the email channel actually delivers", async () => {
    const adminUser: TestUser = {
      id: adminId,
      username: "admin",
      role: "org_admin",
      organizationId: orgId,
    };
    const app = createTestApp(adminUser);

    const res = await request(app)
      .post(`/api/organizations/${orgId}/dues-billing/invoices/${invoiceId}/send`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("sent");

    expect(sendBroadcastMock).toHaveBeenCalledTimes(1);
    const [recipients, opts] = sendBroadcastMock.mock.calls[0]! as [
      Array<{ email?: string | null; userId?: number | null; firstName?: string; lastName?: string }>,
      Record<string, unknown>,
    ];

    // Recipient carries the member's email so the email adapter has an
    // address to deliver to.
    expect(recipients).toHaveLength(1);
    expect(recipients[0]!.email).toBe(memberEmail);
    expect(recipients[0]!.userId).toBe(memberUserId);

    // Documented BroadcastOptions shape — these are the keys the comms
    // adapter actually reads. The legacy `{ title, body, data }` push-only
    // shape would silently bypass every external channel; this assertion
    // pins the regression.
    expect(opts).toMatchObject({
      subject: expect.any(String),
      body: expect.any(String),
      channels: expect.any(Array),
      eventName: expect.any(String),
    });

    // Email channel must be requested so a member with an email on file
    // actually receives the dues invoice notification.
    expect(opts.channels as string[]).toContain("email");

    // The body must reference the invoice number so the recipient can tell
    // which invoice is being announced.
    expect(opts.body as string).toContain("INV-");

    // Task #1566 — originating org id must be propagated so the bounce
    // webhook can tag bounces back to this club.
    expect(opts.organizationId).toBe(orgId);

    // Defence-in-depth: the deprecated push-only keys must NOT be present.
    expect(opts).not.toHaveProperty("title");
    expect(opts).not.toHaveProperty("data");
  });
});
