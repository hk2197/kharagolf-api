/**
 * Unit tests: Levy receipt fan-out (Tasks #207, #223, #248)
 *
 * Verifies that `sendLevyReceipt` honours each member's billing
 * communication preferences across email / push / SMS, and that:
 *   - Defaults apply when no comm-pref row exists
 *   - Each enabled channel attempts independently
 *   - Missing contact info short-circuits its channel without affecting others
 *   - A failure on one channel does not prevent the others from being tried
 *   - SMS provider-not-configured maps to `skipped`, not `failed`
 *
 * The mailer / comms modules are mocked so the tests don't touch real
 * SMTP / push / SMS providers. The DB is real so we exercise the same
 * member + prefs lookup path the production helper uses.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

// Mock the side-effecting modules BEFORE importing the unit under test.
vi.mock("../lib/mailer.js", async () => {
  return {
    sendLevyReceiptEmail: vi.fn(async () => undefined),
    // Task #1502 — classifier is consulted in the email-error catch.
    // Default to "transient" so generic SMTP errors continue to flow
    // through the standard `failed` path; individual tests override
    // per-call for the provider-not-configured branch.
    classifyMailerError: vi.fn(() => "transient"),
  };
});

vi.mock("../lib/comms.js", async () => {
  return {
    sendTransactionalPush: vi.fn(async (userIds: number[]) => ({
      attempted: userIds.length,
      sent: userIds.length,
      failed: 0,
      invalid: 0,
    })),
    sendTransactionalSms: vi.fn(async () => undefined),
  };
});

import { db } from "@workspace/db";
import {
  organizationsTable,
  clubMembersTable,
  memberCommPrefsTable,
  appUsersTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { sendLevyReceipt } from "../lib/levyReceiptNotify.js";
import { sendLevyReceiptEmail, classifyMailerError } from "../lib/mailer.js";
import { sendTransactionalPush, sendTransactionalSms } from "../lib/comms.js";

const emailMock = vi.mocked(sendLevyReceiptEmail);
const pushMock = vi.mocked(sendTransactionalPush);
const smsMock = vi.mocked(sendTransactionalSms);
const classifyMailerErrorMock = vi.mocked(classifyMailerError);

let testOrgId: number;
const memberIds: number[] = [];
const userIds: number[] = [];
let userSeq = 0;

async function makeAppUser(): Promise<number> {
  userSeq += 1;
  const tag = `${Date.now()}_${userSeq}`;
  const [u] = await db.insert(appUsersTable).values({
    replitUserId: `levy-receipt-test-${tag}`,
    username: `levy_receipt_test_${tag}`,
  }).returning({ id: appUsersTable.id });
  userIds.push(u.id);
  return u.id;
}

async function makeMember(opts: {
  email?: string | null;
  phone?: string | null;
  /** When true, creates a real app_user row and links it. */
  withUser?: boolean;
  prefs?: { email?: boolean; push?: boolean; sms?: boolean } | null;
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
      category: "billing",
      emailEnabled: opts.prefs.email ?? true,
      pushEnabled: opts.prefs.push ?? true,
      smsEnabled: opts.prefs.sms ?? false,
    });
  }
  memberIds.push(m.id);
  return m.id;
}

beforeAll(async () => {
  const [org] = await db.insert(organizationsTable).values({
    name: `TestOrg_LevyReceipt_${Date.now()}`,
    slug: `test-levy-receipt-${Date.now()}`,
  }).returning({ id: organizationsTable.id });
  testOrgId = org.id;
});

afterAll(async () => {
  for (const id of memberIds) {
    await db.delete(memberCommPrefsTable)
      .where(and(eq(memberCommPrefsTable.clubMemberId, id), eq(memberCommPrefsTable.category, "billing")));
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
  // Default: success
  emailMock.mockResolvedValue(undefined);
  pushMock.mockImplementation(async (userIds: number[]) => ({
    attempted: userIds.length,
    sent: userIds.length,
    failed: 0,
    invalid: 0,
  }));
  smsMock.mockResolvedValue(undefined);
});

const baseCall = {
  levyName: "Annual Subscription",
  currency: "INR",
  kind: "payment" as const,
  transactionAmount: 1000,
  newBalance: 0,
};

// ─────────────────────────────────────────────────────────────────────────
// Default preferences (no comm-prefs row)
// ─────────────────────────────────────────────────────────────────────────
describe("sendLevyReceipt — default preferences (no comm-prefs row)", () => {
  it("sends email + push, marks SMS opted_out (schema defaults)", async () => {
    const memberId = await makeMember({
      email: "default@example.com",
      phone: "+911234500001",
      withUser: true,
      prefs: null,
    });

    const res = await sendLevyReceipt({
      organizationId: testOrgId,
      clubMemberId: memberId,
      ...baseCall,
    });

    expect(res.email.status).toBe("sent");
    expect(res.push.status).toBe("sent");
    expect(res.sms.status).toBe("opted_out");
    expect(res.status).toBe("sent");
    expect(emailMock).toHaveBeenCalledTimes(1);
    expect(pushMock).toHaveBeenCalledTimes(1);
    expect(smsMock).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// All channels enabled
// ─────────────────────────────────────────────────────────────────────────
describe("sendLevyReceipt — all channels enabled", () => {
  it("dispatches to email, push, and SMS", async () => {
    const memberId = await makeMember({
      email: "all@example.com",
      phone: "+911234500002",
      withUser: true,
      prefs: { email: true, push: true, sms: true },
    });

    const res = await sendLevyReceipt({
      organizationId: testOrgId,
      clubMemberId: memberId,
      ...baseCall,
    });

    expect(res.email.status).toBe("sent");
    expect(res.push.status).toBe("sent");
    expect(res.sms.status).toBe("sent");
    expect(res.status).toBe("sent");
    expect(emailMock).toHaveBeenCalledTimes(1);
    expect(pushMock).toHaveBeenCalledTimes(1);
    expect(smsMock).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Single-channel preferences
// ─────────────────────────────────────────────────────────────────────────
describe("sendLevyReceipt — single-channel preferences", () => {
  it("email-only: only email is sent; push/SMS opted_out", async () => {
    const memberId = await makeMember({
      email: "email-only@example.com",
      phone: "+911234500003",
      withUser: true,
      prefs: { email: true, push: false, sms: false },
    });

    const res = await sendLevyReceipt({
      organizationId: testOrgId,
      clubMemberId: memberId,
      ...baseCall,
    });

    expect(res.email.status).toBe("sent");
    expect(res.push.status).toBe("opted_out");
    expect(res.sms.status).toBe("opted_out");
    expect(res.status).toBe("sent");
    expect(emailMock).toHaveBeenCalledTimes(1);
    expect(pushMock).not.toHaveBeenCalled();
    expect(smsMock).not.toHaveBeenCalled();
  });

  it("push-only: only push is sent; email/SMS opted_out", async () => {
    const memberId = await makeMember({
      email: "push-only@example.com",
      phone: "+911234500004",
      withUser: true,
      prefs: { email: false, push: true, sms: false },
    });

    const res = await sendLevyReceipt({
      organizationId: testOrgId,
      clubMemberId: memberId,
      ...baseCall,
    });

    expect(res.email.status).toBe("opted_out");
    expect(res.push.status).toBe("sent");
    expect(res.sms.status).toBe("opted_out");
    expect(res.status).toBe("sent");
    expect(emailMock).not.toHaveBeenCalled();
    expect(pushMock).toHaveBeenCalledTimes(1);
    expect(smsMock).not.toHaveBeenCalled();
  });

  it("sms-only: only SMS is sent; email/push opted_out", async () => {
    const memberId = await makeMember({
      email: "sms-only@example.com",
      phone: "+911234500005",
      withUser: true,
      prefs: { email: false, push: false, sms: true },
    });

    const res = await sendLevyReceipt({
      organizationId: testOrgId,
      clubMemberId: memberId,
      ...baseCall,
    });

    expect(res.email.status).toBe("opted_out");
    expect(res.push.status).toBe("opted_out");
    expect(res.sms.status).toBe("sent");
    expect(res.status).toBe("sent");
    expect(smsMock).toHaveBeenCalledTimes(1);
  });

  it("all disabled: every channel is opted_out and aggregate is skipped", async () => {
    const memberId = await makeMember({
      email: "none@example.com",
      phone: "+911234500006",
      withUser: true,
      prefs: { email: false, push: false, sms: false },
    });

    const res = await sendLevyReceipt({
      organizationId: testOrgId,
      clubMemberId: memberId,
      ...baseCall,
    });

    expect(res.email.status).toBe("opted_out");
    expect(res.push.status).toBe("opted_out");
    expect(res.sms.status).toBe("opted_out");
    expect(res.status).toBe("skipped");
    expect(emailMock).not.toHaveBeenCalled();
    expect(pushMock).not.toHaveBeenCalled();
    expect(smsMock).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Per-channel skipping when contact info is missing
// ─────────────────────────────────────────────────────────────────────────
describe("sendLevyReceipt — missing contact info", () => {
  it("opted-in but no email: email -> no_address; other channels still attempt", async () => {
    const memberId = await makeMember({
      email: null,
      phone: "+911234500007",
      withUser: true,
      prefs: { email: true, push: true, sms: true },
    });

    const res = await sendLevyReceipt({
      organizationId: testOrgId,
      clubMemberId: memberId,
      ...baseCall,
    });

    expect(res.email.status).toBe("no_address");
    expect(res.push.status).toBe("sent");
    expect(res.sms.status).toBe("sent");
    expect(res.status).toBe("sent");
    expect(emailMock).not.toHaveBeenCalled();
  });

  it("opted-in but no phone: sms -> no_address; other channels still attempt", async () => {
    const memberId = await makeMember({
      email: "nophone@example.com",
      phone: null,
      withUser: true,
      prefs: { email: true, push: true, sms: true },
    });

    const res = await sendLevyReceipt({
      organizationId: testOrgId,
      clubMemberId: memberId,
      ...baseCall,
    });

    expect(res.email.status).toBe("sent");
    expect(res.push.status).toBe("sent");
    expect(res.sms.status).toBe("no_address");
    expect(res.status).toBe("sent");
    expect(smsMock).not.toHaveBeenCalled();
  });

  it("opted-in but no app user: push -> no_user; other channels still attempt", async () => {
    const memberId = await makeMember({
      email: "nouser@example.com",
      phone: "+911234500009",
      withUser: false,
      prefs: { email: true, push: true, sms: true },
    });

    const res = await sendLevyReceipt({
      organizationId: testOrgId,
      clubMemberId: memberId,
      ...baseCall,
    });

    expect(res.email.status).toBe("sent");
    expect(res.push.status).toBe("no_user");
    expect(res.sms.status).toBe("sent");
    expect(res.status).toBe("sent");
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("push: no registered devices -> no_address (push.attempted === push.invalid)", async () => {
    pushMock.mockResolvedValueOnce({ attempted: 1, sent: 0, failed: 0, invalid: 1 });

    const memberId = await makeMember({
      email: "nodevice@example.com",
      phone: "+911234500010",
      withUser: true,
      prefs: { email: true, push: true, sms: false },
    });

    const res = await sendLevyReceipt({
      organizationId: testOrgId,
      clubMemberId: memberId,
      ...baseCall,
    });

    expect(res.email.status).toBe("sent");
    expect(res.push.status).toBe("no_address");
    expect(res.status).toBe("sent");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Channel isolation: failure on one channel never blocks the others
// ─────────────────────────────────────────────────────────────────────────
describe("sendLevyReceipt — failure isolation across channels", () => {
  it("email throws → email failed; push and SMS still attempted and sent", async () => {
    emailMock.mockRejectedValueOnce(new Error("smtp boom"));

    const memberId = await makeMember({
      email: "emailfail@example.com",
      phone: "+911234500011",
      withUser: true,
      prefs: { email: true, push: true, sms: true },
    });

    const res = await sendLevyReceipt({
      organizationId: testOrgId,
      clubMemberId: memberId,
      ...baseCall,
    });

    expect(res.email.status).toBe("failed");
    expect(res.email.error).toBe("smtp boom");
    expect(res.push.status).toBe("sent");
    expect(res.sms.status).toBe("sent");
    // Aggregate is `sent` because at least one channel delivered.
    expect(res.status).toBe("sent");
    expect(pushMock).toHaveBeenCalledTimes(1);
    expect(smsMock).toHaveBeenCalledTimes(1);
  });

  it("push throws → push failed; email and SMS still attempted and sent", async () => {
    pushMock.mockRejectedValueOnce(new Error("push boom"));

    const memberId = await makeMember({
      email: "pushfail@example.com",
      phone: "+911234500012",
      withUser: true,
      prefs: { email: true, push: true, sms: true },
    });

    const res = await sendLevyReceipt({
      organizationId: testOrgId,
      clubMemberId: memberId,
      ...baseCall,
    });

    expect(res.push.status).toBe("failed");
    expect(res.push.error).toBe("push boom");
    expect(res.email.status).toBe("sent");
    expect(res.sms.status).toBe("sent");
    expect(res.status).toBe("sent");
  });

  it("sms throws → sms failed; email and push still attempted and sent", async () => {
    smsMock.mockRejectedValueOnce(new Error("twilio boom"));

    const memberId = await makeMember({
      email: "smsfail@example.com",
      phone: "+911234500013",
      withUser: true,
      prefs: { email: true, push: true, sms: true },
    });

    const res = await sendLevyReceipt({
      organizationId: testOrgId,
      clubMemberId: memberId,
      ...baseCall,
    });

    expect(res.sms.status).toBe("failed");
    expect(res.sms.error).toBe("twilio boom");
    expect(res.email.status).toBe("sent");
    expect(res.push.status).toBe("sent");
    expect(res.status).toBe("sent");
  });

  it("all three channels fail → aggregate is failed and reason is surfaced", async () => {
    emailMock.mockRejectedValueOnce(new Error("smtp down"));
    pushMock.mockRejectedValueOnce(new Error("fcm down"));
    smsMock.mockRejectedValueOnce(new Error("twilio down"));

    const memberId = await makeMember({
      email: "allfail@example.com",
      phone: "+911234500014",
      withUser: true,
      prefs: { email: true, push: true, sms: true },
    });

    const res = await sendLevyReceipt({
      organizationId: testOrgId,
      clubMemberId: memberId,
      ...baseCall,
    });

    expect(res.email.status).toBe("failed");
    expect(res.push.status).toBe("failed");
    expect(res.sms.status).toBe("failed");
    expect(res.status).toBe("failed");
    expect(res.reason).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Email provider not configured → skipped (not failed)  — Task #1502 / #1850
// ─────────────────────────────────────────────────────────────────────────
describe("sendLevyReceipt — email provider not configured", () => {
  // A misconfigured mailer is an env-wide condition, not a per-recipient
  // bounce. The helper must classify it via `classifyMailerError` and
  // map the catch to terminal `skipped`/`provider_not_configured` so
  // every receipt send doesn't log a duplicate "Failed to send receipt
  // email" error line for the same env issue. Push + SMS fan out
  // independently because the email failure is caught and isolated.
  it("maps mailer-not-configured to skipped/provider_not_configured; push + SMS still attempted", async () => {
    classifyMailerErrorMock.mockReturnValueOnce("provider_unconfigured");
    emailMock.mockRejectedValueOnce(new Error("SMTP host not configured"));

    const memberId = await makeMember({
      email: "envmiss@example.com",
      phone: "+911234599991",
      withUser: true,
      prefs: { email: true, push: true, sms: true },
    });

    const res = await sendLevyReceipt({
      organizationId: testOrgId,
      clubMemberId: memberId,
      ...baseCall,
    });

    expect(res.email.status).toBe("skipped");
    expect(res.email.error).toBe("provider_not_configured");
    expect(res.push.status).toBe("sent");
    expect(res.sms.status).toBe("sent");
    // Aggregate is `sent` because at least one channel delivered.
    expect(res.status).toBe("sent");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// SMS provider not configured → skipped (not failed)
// ─────────────────────────────────────────────────────────────────────────
describe("sendLevyReceipt — SMS provider not configured", () => {
  it("maps SMS_PROVIDER-not-configured to skipped, not failed", async () => {
    smsMock.mockRejectedValueOnce(new Error("SMS_PROVIDER not configured"));

    const memberId = await makeMember({
      email: "noprov@example.com",
      phone: "+911234500015",
      withUser: true,
      prefs: { email: true, push: true, sms: true },
    });

    const res = await sendLevyReceipt({
      organizationId: testOrgId,
      clubMemberId: memberId,
      ...baseCall,
    });

    expect(res.sms.status).toBe("skipped");
    expect(res.sms.error).toBe("provider_not_configured");
    // Email + push still delivered → aggregate sent, NOT failed.
    expect(res.email.status).toBe("sent");
    expect(res.push.status).toBe("sent");
    expect(res.status).toBe("sent");
  });

  it("SMS-only member with provider not configured → aggregate is skipped, not failed", async () => {
    smsMock.mockRejectedValueOnce(new Error("SMS_PROVIDER not configured"));

    const memberId = await makeMember({
      email: "smsonlyprov@example.com",
      phone: "+911234500016",
      withUser: true,
      prefs: { email: false, push: false, sms: true },
    });

    const res = await sendLevyReceipt({
      organizationId: testOrgId,
      clubMemberId: memberId,
      ...baseCall,
    });

    expect(res.email.status).toBe("opted_out");
    expect(res.push.status).toBe("opted_out");
    expect(res.sms.status).toBe("skipped");
    expect(res.status).toBe("skipped");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Member not found
// ─────────────────────────────────────────────────────────────────────────
describe("sendLevyReceipt — member not found", () => {
  it("returns skipped with member_not_found reason and triggers no providers", async () => {
    const res = await sendLevyReceipt({
      organizationId: testOrgId,
      clubMemberId: 999_999_999,
      ...baseCall,
    });
    expect(res.status).toBe("skipped");
    expect(res.reason).toBe("member_not_found");
    expect(emailMock).not.toHaveBeenCalled();
    expect(pushMock).not.toHaveBeenCalled();
    expect(smsMock).not.toHaveBeenCalled();
  });
});
