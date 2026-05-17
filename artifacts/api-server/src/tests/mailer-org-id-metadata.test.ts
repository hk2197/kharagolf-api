/**
 * Task #1140 — Forward `metadata.orgId` on transactional sends so the
 * Postmark bounce webhook (Task #981) can attribute bounces to a club
 * directly via `Metadata.orgId` instead of scanning campaigns/memberships.
 *
 * This stubs the active mail provider and asserts that representative
 * `send*Email` helpers in `lib/mailer.ts` thread the org id through to
 * `provider.send` as `metadata.orgId` (and as `organizationId` on the
 * transactional envelope so the suppression check stays org-scoped).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

import {
  getActiveMailProvider,
  type MailProvider,
  type SendResult,
  type TransactionalEmail,
} from "../lib/email/adapter.js";
import {
  sendMarketplaceBookingEmail,
  sendTeeCancellationEmail,
  sendTeeReminderEmail,
  sendApplicationRejectedEmail,
  sendSurveyEmail,
} from "../lib/mailer.js";

let captured: TransactionalEmail[] = [];
let originalSend: MailProvider["send"];
let originalConfigured: MailProvider["isConfigured"];

beforeAll(() => {
  const provider = getActiveMailProvider();
  originalSend = provider.send.bind(provider);
  originalConfigured = provider.isConfigured.bind(provider);
  (provider as { isConfigured: MailProvider["isConfigured"] }).isConfigured = () => true;
  (provider as { send: MailProvider["send"] }).send = async (msg) => {
    captured.push(msg);
    return { ok: true, provider: provider.name, messageId: "stub" } satisfies SendResult;
  };
});

afterAll(() => {
  const provider = getActiveMailProvider();
  (provider as { send: MailProvider["send"] }).send = originalSend;
  (provider as { isConfigured: MailProvider["isConfigured"] }).isConfigured = originalConfigured;
});

beforeEach(() => {
  captured = [];
});

describe("mailer forwards metadata.orgId for bounce attribution (Task #1140)", () => {
  it("sendMarketplaceBookingEmail forwards branding.orgId as metadata.orgId", async () => {
    await sendMarketplaceBookingEmail({
      to: "golfer@example.com",
      name: "Golfer",
      orgName: "Acme GC",
      branding: { orgName: "Acme GC", orgId: 4242 },
    });
    expect(captured.length).toBe(1);
    expect(captured[0].metadata?.orgId).toBe("4242");
    expect(captured[0].organizationId).toBe(4242);
  });

  it("sendTeeCancellationEmail forwards branding.orgId", async () => {
    await sendTeeCancellationEmail({
      to: "golfer@example.com",
      name: "Golfer",
      branding: { orgName: "Acme GC", orgId: 7 },
    });
    expect(captured[0].metadata?.orgId).toBe("7");
    expect(captured[0].organizationId).toBe(7);
  });

  it("sendTeeReminderEmail forwards branding.orgId", async () => {
    await sendTeeReminderEmail({
      to: "golfer@example.com",
      name: "Golfer",
      branding: { orgName: "Acme GC", orgId: 9 },
    });
    expect(captured[0].metadata?.orgId).toBe("9");
    expect(captured[0].organizationId).toBe(9);
  });

  it("sendApplicationRejectedEmail forwards branding.orgId (positional branding arg)", async () => {
    await sendApplicationRejectedEmail(
      "applicant@example.com",
      "Pat",
      "Acme GC",
      null,
      { orgName: "Acme GC", orgId: 11 },
    );
    expect(captured[0].metadata?.orgId).toBe("11");
    expect(captured[0].organizationId).toBe(11);
  });

  it("sendSurveyEmail forwards opts.orgId", async () => {
    await sendSurveyEmail({
      to: "golfer@example.com",
      name: "Golfer",
      orgName: "Acme GC",
      surveyTitle: "How was the round?",
      surveyUrl: "https://example.com/survey/1",
      orgId: 99,
    });
    expect(captured[0].metadata?.orgId).toBe("99");
    expect(captured[0].organizationId).toBe(99);
  });

  it("omits metadata.orgId when no org id is available", async () => {
    await sendMarketplaceBookingEmail({
      to: "golfer@example.com",
      name: "Golfer",
      orgName: "Acme GC",
    });
    expect(captured.length).toBe(1);
    expect(captured[0].metadata?.orgId).toBeUndefined();
    expect(captured[0].organizationId).toBeUndefined();
  });
});
