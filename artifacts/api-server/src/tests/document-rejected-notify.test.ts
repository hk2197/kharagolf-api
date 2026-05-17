/**
 * Unit tests: Document-rejection notification fan-out (Task #346, helper from Task #209)
 *
 * Verifies that `notifyDocumentRejected` honours each member's `operations`
 * communication preferences across email / push / SMS / WhatsApp, and that:
 *   - Defaults apply when no comm-pref row exists (email on, push on, sms off, whatsapp off)
 *   - Each enabled channel attempts independently
 *   - Missing contact info short-circuits its channel without affecting others
 *   - SMS / WhatsApp provider-not-configured maps to `skipped`, not `failed`
 *   - The in-app `member_messages` row is always written
 *
 * The mailer / comms modules are mocked so the tests don't touch real SMTP /
 * push / SMS / WhatsApp providers. The DB is real so we exercise the same
 * member + prefs lookup path the production helper uses.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

vi.mock("../lib/mailer.js", async () => {
  return {
    // Task #1099 — `notifyDocumentRejected` now uses the localised
    // `sendDocumentRejectedEmail` helper instead of the generic broadcast
    // mailer. The previous `sendBroadcastEmail` mock is kept available for
    // any other test importing this module via the same mock factory.
    sendDocumentRejectedEmail: vi.fn(async () => undefined),
    sendBroadcastEmail: vi.fn(async () => undefined),
    // Task #1502 — classifier is consulted in the email-error catch.
    // Default to "transient" so the existing "smtp boom -> failed" tests
    // still flow through the standard `failed` path; individual tests
    // override per-call for the provider-not-configured branch.
    classifyMailerError: vi.fn(() => "transient"),
  };
});

vi.mock("../lib/comms.js", async () => {
  return {
    sendTransactionalPush: vi.fn(async (
      userIds: number[],
      _title: string,
      _body: string,
      _data?: Record<string, unknown>,
    ) => ({
      attempted: userIds.length,
      sent: userIds.length,
      failed: 0,
      invalid: 0,
    })),
    sendTransactionalSms: vi.fn(async () => undefined),
    sendTransactionalWhatsapp: vi.fn(async () => undefined),
  };
});

import { db } from "@workspace/db";
import {
  organizationsTable,
  clubMembersTable,
  memberCommPrefsTable,
  memberMessagesTable,
  appUsersTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { notifyDocumentRejected } from "../lib/documentRejectedNotify.js";
import { sendDocumentRejectedEmail, classifyMailerError } from "../lib/mailer.js";
import {
  sendTransactionalPush,
  sendTransactionalSms,
  sendTransactionalWhatsapp,
} from "../lib/comms.js";

const emailMock = vi.mocked(sendDocumentRejectedEmail);
const pushMock = vi.mocked(sendTransactionalPush);
const smsMock = vi.mocked(sendTransactionalSms);
const waMock = vi.mocked(sendTransactionalWhatsapp);
const classifyMailerErrorMock = vi.mocked(classifyMailerError);

let testOrgId: number;
const memberIds: number[] = [];
const userIds: number[] = [];
let userSeq = 0;

async function makeAppUser(): Promise<number> {
  userSeq += 1;
  const tag = `${Date.now()}_${userSeq}`;
  const [u] = await db.insert(appUsersTable).values({
    replitUserId: `doc-rejected-test-${tag}`,
    username: `doc_rejected_test_${tag}`,
  }).returning({ id: appUsersTable.id });
  userIds.push(u.id);
  return u.id;
}

async function makeMember(opts: {
  email?: string | null;
  phone?: string | null;
  withUser?: boolean;
  prefs?: { email?: boolean; push?: boolean; sms?: boolean; whatsapp?: boolean } | null;
}): Promise<number> {
  const userId = opts.withUser ? await makeAppUser() : null;
  const [m] = await db.insert(clubMembersTable).values({
    organizationId: testOrgId,
    firstName: "Test",
    lastName: "Member",
    email: opts.email ?? null,
    phone: opts.phone ?? null,
    userId,
  }).returning({ id: clubMembersTable.id });
  if (opts.prefs) {
    await db.insert(memberCommPrefsTable).values({
      organizationId: testOrgId,
      clubMemberId: m.id,
      category: "operations",
      emailEnabled: opts.prefs.email ?? true,
      pushEnabled: opts.prefs.push ?? true,
      smsEnabled: opts.prefs.sms ?? false,
      whatsappEnabled: opts.prefs.whatsapp ?? false,
    });
  }
  memberIds.push(m.id);
  return m.id;
}

beforeAll(async () => {
  const [org] = await db.insert(organizationsTable).values({
    name: `TestOrg_DocRejected_${Date.now()}`,
    slug: `test-doc-rejected-${Date.now()}`,
  }).returning({ id: organizationsTable.id });
  testOrgId = org.id;
});

afterAll(async () => {
  for (const id of memberIds) {
    await db.delete(memberMessagesTable).where(eq(memberMessagesTable.clubMemberId, id));
    await db.delete(memberCommPrefsTable)
      .where(and(eq(memberCommPrefsTable.clubMemberId, id), eq(memberCommPrefsTable.category, "operations")));
    await db.delete(clubMembersTable).where(eq(clubMembersTable.id, id));
  }
  for (const id of userIds) {
    await db.delete(appUsersTable).where(eq(appUsersTable.id, id));
  }
  await db.delete(organizationsTable).where(eq(organizationsTable.id, testOrgId));
});

beforeEach(() => {
  emailMock.mockReset();
  pushMock.mockReset();
  smsMock.mockReset();
  waMock.mockReset();
  emailMock.mockResolvedValue(undefined);
  pushMock.mockImplementation(async (userIds: number[]) => ({
    attempted: userIds.length,
    sent: userIds.length,
    failed: 0,
    invalid: 0,
  }));
  smsMock.mockResolvedValue(undefined);
  waMock.mockResolvedValue(null);
});

const baseDoc = {
  id: 12345,
  title: "Driving License",
  documentType: "id_proof",
};

const baseCall = {
  document: baseDoc,
  reason: "The image is blurry; please re-upload a clearer scan.",
};

// ─────────────────────────────────────────────────────────────────────────
// Default preferences (no comm-prefs row): email on, push on, sms off, whatsapp off
// ─────────────────────────────────────────────────────────────────────────
describe("notifyDocumentRejected — default operations preferences (no row)", () => {
  it("sends in-app + email + push; SMS and WhatsApp opted_out by default", async () => {
    const memberId = await makeMember({
      email: "default@example.com",
      phone: "+911234600001",
      withUser: true,
      prefs: null,
    });

    const res = await notifyDocumentRejected({
      organizationId: testOrgId,
      clubMemberId: memberId,
      ...baseCall,
    });

    expect(res.inAppMessageId).toBeTypeOf("number");
    expect(res.emailStatus).toBe("sent");
    expect(res.pushStatus).toBe("sent");
    expect(res.smsStatus).toBe("opted_out");
    expect(res.whatsappStatus).toBe("opted_out");
    expect(emailMock).toHaveBeenCalledTimes(1);
    expect(pushMock).toHaveBeenCalledTimes(1);
    expect(smsMock).not.toHaveBeenCalled();
    expect(waMock).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// All channels enabled
// ─────────────────────────────────────────────────────────────────────────
describe("notifyDocumentRejected — all channels enabled", () => {
  it("dispatches to email, push, SMS, and WhatsApp", async () => {
    const memberId = await makeMember({
      email: "all@example.com",
      phone: "+911234600002",
      withUser: true,
      prefs: { email: true, push: true, sms: true, whatsapp: true },
    });

    const res = await notifyDocumentRejected({
      organizationId: testOrgId,
      clubMemberId: memberId,
      ...baseCall,
    });

    expect(res.emailStatus).toBe("sent");
    expect(res.pushStatus).toBe("sent");
    expect(res.smsStatus).toBe("sent");
    expect(res.whatsappStatus).toBe("sent");
    expect(emailMock).toHaveBeenCalledTimes(1);
    expect(pushMock).toHaveBeenCalledTimes(1);
    expect(smsMock).toHaveBeenCalledTimes(1);
    expect(waMock).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Opted-out matrix
// ─────────────────────────────────────────────────────────────────────────
describe("notifyDocumentRejected — opted-out channels", () => {
  it("all channels opted out: every channel reports opted_out", async () => {
    const memberId = await makeMember({
      email: "none@example.com",
      phone: "+911234600003",
      withUser: true,
      prefs: { email: false, push: false, sms: false, whatsapp: false },
    });

    const res = await notifyDocumentRejected({
      organizationId: testOrgId,
      clubMemberId: memberId,
      ...baseCall,
    });

    expect(res.emailStatus).toBe("opted_out");
    expect(res.pushStatus).toBe("opted_out");
    expect(res.smsStatus).toBe("opted_out");
    expect(res.whatsappStatus).toBe("opted_out");
    expect(emailMock).not.toHaveBeenCalled();
    expect(pushMock).not.toHaveBeenCalled();
    expect(smsMock).not.toHaveBeenCalled();
    expect(waMock).not.toHaveBeenCalled();
    // In-app is always written regardless of opt-ins
    expect(res.inAppMessageId).toBeTypeOf("number");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Missing contact info per channel
// ─────────────────────────────────────────────────────────────────────────
describe("notifyDocumentRejected — missing contact info", () => {
  it("opted-in but no email: emailStatus -> no_address; other channels still attempt", async () => {
    const memberId = await makeMember({
      email: null,
      phone: "+911234600004",
      withUser: true,
      prefs: { email: true, push: true, sms: true, whatsapp: true },
    });

    const res = await notifyDocumentRejected({
      organizationId: testOrgId,
      clubMemberId: memberId,
      ...baseCall,
    });

    expect(res.emailStatus).toBe("no_address");
    expect(res.pushStatus).toBe("sent");
    expect(res.smsStatus).toBe("sent");
    expect(res.whatsappStatus).toBe("sent");
    expect(emailMock).not.toHaveBeenCalled();
  });

  it("opted-in but no app user: pushStatus -> no_user; other channels still attempt", async () => {
    const memberId = await makeMember({
      email: "nouser@example.com",
      phone: "+911234600005",
      withUser: false,
      prefs: { email: true, push: true, sms: true, whatsapp: true },
    });

    const res = await notifyDocumentRejected({
      organizationId: testOrgId,
      clubMemberId: memberId,
      ...baseCall,
    });

    expect(res.emailStatus).toBe("sent");
    expect(res.pushStatus).toBe("no_user");
    expect(res.smsStatus).toBe("sent");
    expect(res.whatsappStatus).toBe("sent");
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("opted-in but no phone: smsStatus and whatsappStatus -> no_address; email/push still attempt", async () => {
    const memberId = await makeMember({
      email: "nophone@example.com",
      phone: null,
      withUser: true,
      prefs: { email: true, push: true, sms: true, whatsapp: true },
    });

    const res = await notifyDocumentRejected({
      organizationId: testOrgId,
      clubMemberId: memberId,
      ...baseCall,
    });

    expect(res.emailStatus).toBe("sent");
    expect(res.pushStatus).toBe("sent");
    expect(res.smsStatus).toBe("no_address");
    expect(res.whatsappStatus).toBe("no_address");
    expect(smsMock).not.toHaveBeenCalled();
    expect(waMock).not.toHaveBeenCalled();
  });

  it("push: no registered devices (attempted === invalid) -> no_address", async () => {
    pushMock.mockResolvedValueOnce({ attempted: 1, sent: 0, failed: 0, invalid: 1 });

    const memberId = await makeMember({
      email: "nodevice@example.com",
      phone: "+911234600006",
      withUser: true,
      prefs: { email: true, push: true, sms: false, whatsapp: false },
    });

    const res = await notifyDocumentRejected({
      organizationId: testOrgId,
      clubMemberId: memberId,
      ...baseCall,
    });

    expect(res.pushStatus).toBe("no_address");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Provider not configured -> skipped (not failed)
// ─────────────────────────────────────────────────────────────────────────
describe("notifyDocumentRejected — provider-not-configured falls through to skipped", () => {
  it("SMS_PROVIDER not configured -> smsStatus skipped with provider_not_configured", async () => {
    smsMock.mockRejectedValueOnce(new Error("SMS_PROVIDER not configured"));

    const memberId = await makeMember({
      email: "smsprov@example.com",
      phone: "+911234600007",
      withUser: true,
      prefs: { email: true, push: true, sms: true, whatsapp: false },
    });

    const res = await notifyDocumentRejected({
      organizationId: testOrgId,
      clubMemberId: memberId,
      ...baseCall,
    });

    expect(res.smsStatus).toBe("skipped");
    expect(res.smsError).toBe("provider_not_configured");
    expect(res.emailStatus).toBe("sent");
    expect(res.pushStatus).toBe("sent");
  });

  it("WHATSAPP_PROVIDER not configured -> whatsappStatus skipped with provider_not_configured (not failed)", async () => {
    waMock.mockRejectedValueOnce(new Error("WHATSAPP_PROVIDER not configured"));

    const memberId = await makeMember({
      email: "waprov@example.com",
      phone: "+911234600008",
      withUser: true,
      prefs: { email: true, push: true, sms: false, whatsapp: true },
    });

    const res = await notifyDocumentRejected({
      organizationId: testOrgId,
      clubMemberId: memberId,
      ...baseCall,
    });

    expect(res.whatsappStatus).toBe("skipped");
    expect(res.whatsappError).toBe("provider_not_configured");
    expect(res.emailStatus).toBe("sent");
    expect(res.pushStatus).toBe("sent");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Real provider failure isolation
// ─────────────────────────────────────────────────────────────────────────
describe("notifyDocumentRejected — failure isolation across channels", () => {
  it("email throws -> emailStatus failed; push/SMS/WhatsApp still attempted", async () => {
    emailMock.mockRejectedValueOnce(new Error("smtp boom"));

    const memberId = await makeMember({
      email: "emailfail@example.com",
      phone: "+911234600009",
      withUser: true,
      prefs: { email: true, push: true, sms: true, whatsapp: true },
    });

    const res = await notifyDocumentRejected({
      organizationId: testOrgId,
      clubMemberId: memberId,
      ...baseCall,
    });

    expect(res.emailStatus).toBe("failed");
    expect(res.emailError).toBe("smtp boom");
    expect(res.pushStatus).toBe("sent");
    expect(res.smsStatus).toBe("sent");
    expect(res.whatsappStatus).toBe("sent");
  });

  it("WhatsApp throws a generic error -> whatsappStatus failed (not skipped)", async () => {
    waMock.mockRejectedValueOnce(new Error("twilio wa rate limited"));

    const memberId = await makeMember({
      email: "wafail@example.com",
      phone: "+911234600010",
      withUser: true,
      prefs: { email: true, push: false, sms: false, whatsapp: true },
    });

    const res = await notifyDocumentRejected({
      organizationId: testOrgId,
      clubMemberId: memberId,
      ...baseCall,
    });

    expect(res.whatsappStatus).toBe("failed");
    expect(res.whatsappError).toBe("twilio wa rate limited");
    expect(res.emailStatus).toBe("sent");
  });

  // Task #1502 / Task #1850 — provider_unconfigured branch (lib line 166).
  // A misconfigured mailer is an env-wide condition, so the helper must
  // map it to terminal `skipped` / `provider_not_configured` rather than
  // `failed`. The other channels (push/SMS/WhatsApp) keep going because
  // the email failure is caught and isolated.
  it("email provider_unconfigured -> emailStatus skipped/provider_not_configured; other channels still attempted", async () => {
    classifyMailerErrorMock.mockReturnValueOnce("provider_unconfigured");
    emailMock.mockRejectedValueOnce(new Error("SMTP host not configured"));

    const memberId = await makeMember({
      email: "envmiss@example.com",
      phone: "+911234699999",
      withUser: true,
      prefs: { email: true, push: true, sms: false, whatsapp: false },
    });

    const res = await notifyDocumentRejected({
      organizationId: testOrgId,
      clubMemberId: memberId,
      ...baseCall,
    });

    expect(res.emailStatus).toBe("skipped");
    expect(res.emailError).toBe("provider_not_configured");
    // Push still ran independently (the email skip does not block other
    // channels — they share no state with the mailer).
    expect(res.pushStatus).toBe("sent");
  });

  it("SMS throws a generic error -> smsStatus failed (not skipped)", async () => {
    smsMock.mockRejectedValueOnce(new Error("twilio sms rate limited"));

    const memberId = await makeMember({
      email: "smsfail@example.com",
      phone: "+911234600011",
      withUser: true,
      prefs: { email: true, push: false, sms: true, whatsapp: false },
    });

    const res = await notifyDocumentRejected({
      organizationId: testOrgId,
      clubMemberId: memberId,
      ...baseCall,
    });

    expect(res.smsStatus).toBe("failed");
    expect(res.smsError).toBe("twilio sms rate limited");
    expect(res.emailStatus).toBe("sent");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// In-app message persistence
// ─────────────────────────────────────────────────────────────────────────
describe("notifyDocumentRejected — in-app message persistence", () => {
  it("writes a member_messages row with the rejection subject and reason in the body", async () => {
    const memberId = await makeMember({
      email: "inapp@example.com",
      phone: "+911234600012",
      withUser: true,
      prefs: { email: false, push: false, sms: false, whatsapp: false },
    });

    const res = await notifyDocumentRejected({
      organizationId: testOrgId,
      clubMemberId: memberId,
      document: { id: 999, title: "Address Proof", documentType: "address_proof" },
      reason: "Document is older than 3 months",
    });

    expect(res.inAppMessageId).toBeTypeOf("number");
    const [row] = await db.select({
      subject: memberMessagesTable.subject,
      body: memberMessagesTable.body,
      channel: memberMessagesTable.channel,
      status: memberMessagesTable.status,
    }).from(memberMessagesTable).where(eq(memberMessagesTable.id, res.inAppMessageId!)).limit(1);

    expect(row.channel).toBe("in_app");
    expect(row.status).toBe("sent");
    expect(row.subject).toContain("Address Proof");
    expect(row.body).toContain("older than 3 months");
  });
});
