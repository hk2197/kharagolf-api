/**
 * Unit test (Task #1319): the comms abstraction propagates
 * `BroadcastOptions.organizationId` to the email mailer as
 * `branding.orgId`, so the Postmark bounce webhook (Task #981) can
 * attribute hard bounces / complaints / unsubscribes back to the club
 * via `Metadata.orgId` instead of falling back to the slow
 * campaign / membership scan.
 *
 * Mocks the mailer at the module boundary so we don't need SMTP wired
 * up — the assertion is purely on the call shape. Both
 * `sendBroadcastEmail` and `sendInvitationEmail` are called positionally;
 * the `branding` arg sits at the last position (index 5 and 6
 * respectively).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sendBroadcastEmail: vi.fn(async () => undefined),
  sendInvitationEmail: vi.fn(async () => undefined),
}));

vi.mock("../lib/mailer", () => ({
  sendBroadcastEmail: mocks.sendBroadcastEmail,
  sendInvitationEmail: mocks.sendInvitationEmail,
}));

vi.mock("../lib/push", () => ({
  sendPushToUsers: vi.fn(async () => ({ sent: 0, failed: 0, invalid: 0 })),
  registerDeviceToken: vi.fn(),
  unregisterDeviceToken: vi.fn(),
}));

import { sendBroadcast, sendInvite } from "../lib/comms.js";

beforeEach(() => {
  mocks.sendBroadcastEmail.mockClear();
  mocks.sendInvitationEmail.mockClear();
});

describe("comms.sendBroadcast — orgId propagation (Task #1319)", () => {
  it("forwards BroadcastOptions.organizationId to sendBroadcastEmail as branding.orgId", async () => {
    await sendBroadcast(
      [
        {
          email: "member@example.com",
          firstName: "Test",
          lastName: "Member",
          phone: null,
          userId: 42,
        },
      ],
      {
        subject: "Tee time confirmed",
        body: "Your Saturday slot is locked in.",
        channels: ["email"],
        eventName: "Saturday Foursome",
        organizationId: 1234,
        logoUrl: "https://cdn.example.com/logo.png",
        primaryColor: "#0a7d34",
      },
    );

    expect(mocks.sendBroadcastEmail).toHaveBeenCalledTimes(1);
    // sendBroadcastEmail(email, fullName, subject, body, eventName, branding)
    const args = mocks.sendBroadcastEmail.mock.calls[0] as unknown as unknown[];
    const branding = args[5] as
      | { orgId?: number; logoUrl?: string; primaryColor?: string }
      | undefined;
    expect(branding?.orgId).toBe(1234);
    expect(branding?.logoUrl).toBe("https://cdn.example.com/logo.png");
    expect(branding?.primaryColor).toBe("#0a7d34");
  });

  it("does not synthesize branding when organizationId and styling are all omitted", async () => {
    await sendBroadcast(
      [
        {
          email: "member@example.com",
          firstName: "Test",
          lastName: "Member",
          phone: null,
          userId: 42,
        },
      ],
      {
        body: "Plain body — no branding inputs.",
        channels: ["email"],
        eventName: "Generic",
      },
    );

    expect(mocks.sendBroadcastEmail).toHaveBeenCalledTimes(1);
    const args = mocks.sendBroadcastEmail.mock.calls[0] as unknown as unknown[];
    expect(args[5]).toBeUndefined();
  });
});

describe("comms.sendInvite — orgId propagation (Task #1319)", () => {
  it("forwards InviteOptions.organizationId to sendInvitationEmail as branding.orgId", async () => {
    await sendInvite({
      recipientEmail: "invitee@example.com",
      recipientPhone: null,
      recipientName: "Pat Player",
      eventName: "Spring Cup",
      eventType: "tournament",
      inviteUrl: "https://kharagolf.com/i/abc",
      orgName: "Test Club",
      channels: ["email"],
      organizationId: 5678,
    });

    expect(mocks.sendInvitationEmail).toHaveBeenCalledTimes(1);
    // sendInvitationEmail(email, name, eventName, eventType, inviteUrl, orgName, branding)
    const args = mocks.sendInvitationEmail.mock.calls[0] as unknown as unknown[];
    const branding = args[6] as { orgId?: number } | undefined;
    expect(branding?.orgId).toBe(5678);
  });

  it("omits branding when organizationId is not supplied", async () => {
    await sendInvite({
      recipientEmail: "invitee@example.com",
      recipientPhone: null,
      recipientName: "Pat Player",
      eventName: "Spring Cup",
      eventType: "tournament",
      inviteUrl: "https://kharagolf.com/i/abc",
      orgName: "Test Club",
      channels: ["email"],
    });

    expect(mocks.sendInvitationEmail).toHaveBeenCalledTimes(1);
    const args = mocks.sendInvitationEmail.mock.calls[0] as unknown as unknown[];
    expect(args[6]).toBeUndefined();
  });
});
