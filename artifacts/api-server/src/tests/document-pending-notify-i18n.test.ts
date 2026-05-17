/**
 * Task #1909 — Verify the staff "new member document awaiting review"
 * notification is rendered in the org's `defaultLanguage` (with EN fallback)
 * across both the push and email channels.
 *
 * Mirrors `document-rejected-notify-i18n.test.ts` (Task #1267):
 *   1. `composeDocumentPendingStaffNotification` is unit-tested directly
 *      against every supported language to assert non-empty push title /
 *      push body / email subject / email body shapes (and that the push
 *      body never exceeds the 200-char Apple/Android friendly cap).
 *   2. `notifyDocumentPendingStaff` is exercised end-to-end against a real
 *      DB with the mailer + comms helpers mocked, so we can confirm the
 *      org's `defaultLanguage` flows through to the push/email call sites.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

vi.mock("../lib/mailer.js", async () => ({
  sendBroadcastEmail: vi.fn(async () => undefined),
}));

vi.mock("../lib/comms.js", async () => ({
  sendTransactionalPush: vi.fn(async (userIds: number[]) => ({
    attempted: userIds.length,
    sent: userIds.length,
    failed: 0,
    invalid: 0,
  })),
}));

import { db } from "@workspace/db";
import {
  organizationsTable,
  clubMembersTable,
  appUsersTable,
  orgMembershipsTable,
  userNotificationPrefsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { notifyDocumentPendingStaff } from "../lib/documentPendingStaffNotify.js";
import { sendTransactionalPush } from "../lib/comms.js";
import { sendBroadcastEmail } from "../lib/mailer.js";
import {
  composeDocumentPendingStaffNotification,
  getEmailStrings,
  ADMIN_EMAIL_LANGS,
} from "../lib/adminEmailI18n.js";

const pushMock = vi.mocked(sendTransactionalPush);
const emailMock = vi.mocked(sendBroadcastEmail);

describe("Task #1909 — composeDocumentPendingStaffNotification helper", () => {
  it("produces non-empty push + email copy for every supported language", () => {
    for (const lang of ADMIN_EMAIL_LANGS) {
      const n = composeDocumentPendingStaffNotification({
        lang,
        memberName: "Test Member",
        docTypeLabel: "id proof",
        docLabel: "Driving License",
      });
      expect(n.pushTitle.length).toBeGreaterThan(0);
      expect(n.pushBody.length).toBeGreaterThan(0);
      expect(n.emailSubject.length).toBeGreaterThan(0);
      expect(n.emailBody.length).toBeGreaterThan(0);
      // Push body never exceeds the 200-char Apple/Android friendly cap.
      expect(n.pushBody.length).toBeLessThanOrEqual(200);
    }
  });

  it("renders Hindi strings on every channel when lang='hi'", () => {
    const n = composeDocumentPendingStaffNotification({
      lang: "hi",
      memberName: "Asha",
      docTypeLabel: "id proof",
      docLabel: "Driving License",
    });
    const hi = getEmailStrings("hi", "documentPending");

    const expectedBody = hi.body
      .replace("{memberName}", "Asha")
      .replace("{docTypeLabel}", "id proof")
      .replace("{docLabel}", "Driving License");

    expect(n.pushTitle).toBe(hi.pushTitle);
    expect(n.emailSubject).toBe(hi.emailSubject);
    expect(n.emailBody).toBe(expectedBody);
    // English copy is NOT present.
    expect(n.pushTitle).not.toContain("New document awaiting review");
    expect(n.emailSubject).not.toContain("New member document awaiting review");
    expect(n.emailBody).not.toContain("uploaded a new");
  });

  it("renders Arabic strings when lang='ar'", () => {
    const n = composeDocumentPendingStaffNotification({
      lang: "ar",
      memberName: "Sami",
      docTypeLabel: "passport",
      docLabel: "Passport",
    });
    const ar = getEmailStrings("ar", "documentPending");
    expect(n.pushTitle).toBe(ar.pushTitle);
    expect(n.emailSubject).toBe(ar.emailSubject);
    expect(n.emailBody).toBe(
      ar.body
        .replace("{memberName}", "Sami")
        .replace("{docTypeLabel}", "passport")
        .replace("{docLabel}", "Passport"),
    );
  });

  it("renders Spanish strings when lang='es'", () => {
    const n = composeDocumentPendingStaffNotification({
      lang: "es",
      memberName: "Carlos",
      docTypeLabel: "id proof",
      docLabel: "DNI",
    });
    const es = getEmailStrings("es", "documentPending");
    expect(n.pushTitle).toBe(es.pushTitle);
    expect(n.emailSubject).toBe(es.emailSubject);
    expect(n.emailBody).toContain("Carlos");
    expect(n.emailBody).toContain("DNI");
    expect(n.emailBody).toContain("id proof");
  });

  it("falls back to English when lang is null / undefined / unsupported", () => {
    const en = getEmailStrings("en", "documentPending");
    for (const lang of [null, undefined, "xx-bogus"] as const) {
      const n = composeDocumentPendingStaffNotification({
        lang,
        memberName: "X",
        docTypeLabel: "id proof",
        docLabel: "Doc",
      });
      expect(n.pushTitle).toBe(en.pushTitle);
      expect(n.pushTitle).toBe("New document awaiting review");
      expect(n.emailSubject).toBe("New member document awaiting review");
      expect(n.emailBody).toBe(
        'X uploaded a new id proof document ("Doc") for verification.',
      );
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// End-to-end: org.defaultLanguage flows through the push + email call sites
// ───────────────────────────────────────────────────────────────────────────
const orgIds: number[] = [];
const memberIds: number[] = [];
const userIds: number[] = [];
const membershipIds: number[] = [];
const prefsUserIds: number[] = [];
let userSeq = 0;

async function makeOrg(lang: "en" | "hi" | "ar" | "fr"): Promise<{ id: number; name: string }> {
  const [org] = await db.insert(organizationsTable).values({
    name: `TestPending_${lang}_${Date.now()}_${orgIds.length}`,
    slug: `doc-pending-i18n-${lang}-${Date.now()}-${orgIds.length}`,
    defaultLanguage: lang,
  }).returning({ id: organizationsTable.id, name: organizationsTable.name });
  orgIds.push(org.id);
  return org;
}

async function makeAppUser(opts: { email?: string; displayName?: string } = {}): Promise<number> {
  userSeq += 1;
  const tag = `${Date.now()}_${userSeq}`;
  const [u] = await db.insert(appUsersTable).values({
    replitUserId: `doc-pending-i18n-${tag}`,
    username: `doc_pending_i18n_${tag}`,
    email: opts.email ?? null,
    displayName: opts.displayName ?? null,
  }).returning({ id: appUsersTable.id });
  userIds.push(u.id);
  return u.id;
}

async function makeMember(orgId: number): Promise<number> {
  const [m] = await db.insert(clubMembersTable).values({
    organizationId: orgId,
    firstName: "Asha",
    lastName: "Singh",
  }).returning({ id: clubMembersTable.id });
  memberIds.push(m.id);
  return m.id;
}

async function makeStaff(orgId: number, role: "org_admin" | "membership_secretary" = "org_admin"): Promise<number> {
  const userId = await makeAppUser({
    email: `staff_${userSeq}@example.com`,
    displayName: `Staff ${userSeq}`,
  });
  const [m] = await db.insert(orgMembershipsTable).values({
    organizationId: orgId,
    userId,
    role,
  }).returning({ id: orgMembershipsTable.id });
  membershipIds.push(m.id);
  return userId;
}

beforeAll(async () => {
  // No-op; per-test orgs are created so each test gets isolated language config.
});

afterAll(async () => {
  for (const id of memberIds) {
    await db.delete(clubMembersTable).where(eq(clubMembersTable.id, id));
  }
  for (const id of membershipIds) {
    await db.delete(orgMembershipsTable).where(eq(orgMembershipsTable.id, id));
  }
  for (const uid of prefsUserIds) {
    await db.delete(userNotificationPrefsTable).where(eq(userNotificationPrefsTable.userId, uid));
  }
  for (const id of userIds) {
    await db.delete(appUsersTable).where(eq(appUsersTable.id, id));
  }
  for (const id of orgIds) {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, id));
  }
});

beforeEach(() => {
  pushMock.mockReset();
  emailMock.mockReset();
  pushMock.mockImplementation(async (uIds: number[]) => ({
    attempted: uIds.length, sent: uIds.length, failed: 0, invalid: 0,
  }));
  emailMock.mockResolvedValue(undefined);
});

describe("Task #1909 — notifyDocumentPendingStaff honours org.defaultLanguage on every channel", () => {
  it("renders the push title + body and email subject + body in Hindi", async () => {
    const org = await makeOrg("hi");
    const memberId = await makeMember(org.id);
    const staffUserId = await makeStaff(org.id);

    const res = await notifyDocumentPendingStaff({
      organizationId: org.id,
      clubMemberId: memberId,
      documentId: 5001,
      documentType: "id_proof",
      title: "Driving License",
    });

    expect(res.recipients).toBe(1);
    expect(res.pushAttempted).toBe(true);
    expect(res.emailsSent).toBe(1);
    expect(res.emailsFailed).toBe(0);

    const hi = getEmailStrings("hi", "documentPending");
    const expectedBody = hi.body
      .replace("{memberName}", "Asha Singh")
      .replace("{docTypeLabel}", "id proof")
      .replace("{docLabel}", "Driving License");

    // Push call: title + body in Hindi.
    expect(pushMock).toHaveBeenCalledTimes(1);
    const [pushUserIds, pushTitle, pushBody] = pushMock.mock.calls[0];
    expect(pushUserIds).toEqual([staffUserId]);
    expect(pushTitle).toBe(hi.pushTitle);
    expect(pushBody).toBe(expectedBody);
    // English copy not present.
    expect(pushTitle).not.toContain("New document awaiting review");
    expect(pushBody).not.toContain("uploaded a new");

    // Email call: subject + body in Hindi.
    expect(emailMock).toHaveBeenCalledTimes(1);
    const [, , emailSubject, emailBody] = emailMock.mock.calls[0];
    expect(emailSubject).toBe(hi.emailSubject);
    expect(emailBody).toBe(expectedBody);
    expect(emailSubject).not.toContain("New member document awaiting review");
  });

  it("falls back to English when org.defaultLanguage='en'", async () => {
    const org = await makeOrg("en");
    const memberId = await makeMember(org.id);
    await makeStaff(org.id);

    const res = await notifyDocumentPendingStaff({
      organizationId: org.id,
      clubMemberId: memberId,
      documentId: 5002,
      documentType: "address_proof",
      title: "Utility Bill",
    });

    expect(res.recipients).toBe(1);
    expect(res.emailsSent).toBe(1);

    const [, pushTitle, pushBody] = pushMock.mock.calls[0];
    expect(pushTitle).toBe("New document awaiting review");
    expect(pushBody).toBe(
      'Asha Singh uploaded a new address proof document ("Utility Bill") for verification.',
    );

    const [, , emailSubject, emailBody] = emailMock.mock.calls[0];
    expect(emailSubject).toBe("New member document awaiting review");
    expect(emailBody).toBe(
      'Asha Singh uploaded a new address proof document ("Utility Bill") for verification.',
    );
  });

  it("renders in French when org.defaultLanguage='fr'", async () => {
    const org = await makeOrg("fr");
    const memberId = await makeMember(org.id);
    await makeStaff(org.id, "membership_secretary");

    await notifyDocumentPendingStaff({
      organizationId: org.id,
      clubMemberId: memberId,
      documentId: 5003,
      documentType: "id_proof",
      title: "Carte d'identité",
    });

    const fr = getEmailStrings("fr", "documentPending");
    const expectedBody = fr.body
      .replace("{memberName}", "Asha Singh")
      .replace("{docTypeLabel}", "id proof")
      .replace("{docLabel}", "Carte d'identité");

    const [, pushTitle, pushBody] = pushMock.mock.calls[0];
    expect(pushTitle).toBe(fr.pushTitle);
    expect(pushBody).toBe(expectedBody);

    const [, , emailSubject, emailBody] = emailMock.mock.calls[0];
    expect(emailSubject).toBe(fr.emailSubject);
    expect(emailBody).toBe(expectedBody);
  });

  it("respects the per-staff notifyMemberDocuments=false opt-out", async () => {
    const org = await makeOrg("en");
    const memberId = await makeMember(org.id);
    const optedOutUserId = await makeStaff(org.id);
    await db.insert(userNotificationPrefsTable).values({
      userId: optedOutUserId,
      notifyMemberDocuments: false,
    });
    prefsUserIds.push(optedOutUserId);

    const res = await notifyDocumentPendingStaff({
      organizationId: org.id,
      clubMemberId: memberId,
      documentId: 5004,
      documentType: "id_proof",
      title: "ID",
    });

    expect(res.recipients).toBe(0);
    expect(res.pushAttempted).toBe(false);
    expect(res.emailsSent).toBe(0);
    expect(pushMock).not.toHaveBeenCalled();
    expect(emailMock).not.toHaveBeenCalled();
  });
});
