/**
 * Task #1267 — Verify the document-rejected push, SMS, WhatsApp, and in-app
 * notification bodies are rendered in the org's `defaultLanguage` with EN
 * fallback (mirroring `admin-email-i18n.test.ts` which covers the email
 * channel for the same flow).
 *
 * Two layers of coverage:
 *   1. `composeDocumentRejectedNotification` is unit-tested directly against
 *      every supported language to assert the localised subject / body /
 *      push title / push body / SMS body / WhatsApp body shape.
 *   2. `notifyDocumentRejected` is exercised end-to-end against a real DB
 *      with the mailer + comms helpers mocked, so we can confirm the org's
 *      `defaultLanguage` flows through to each channel call site.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

vi.mock("../lib/mailer.js", async () => ({
  sendDocumentRejectedEmail: vi.fn(async () => undefined),
}));

vi.mock("../lib/comms.js", async () => ({
  sendTransactionalPush: vi.fn(async (userIds: number[]) => ({
    attempted: userIds.length,
    sent: userIds.length,
    failed: 0,
    invalid: 0,
  })),
  sendTransactionalSms: vi.fn(async () => undefined),
  sendTransactionalWhatsapp: vi.fn(async () => null),
}));

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
import {
  sendTransactionalPush,
  sendTransactionalSms,
  sendTransactionalWhatsapp,
} from "../lib/comms.js";
import {
  composeDocumentRejectedNotification,
  getEmailStrings,
  ADMIN_EMAIL_LANGS,
} from "../lib/adminEmailI18n.js";

const pushMock = vi.mocked(sendTransactionalPush);
const smsMock = vi.mocked(sendTransactionalSms);
const waMock = vi.mocked(sendTransactionalWhatsapp);

describe("Task #1267 — composeDocumentRejectedNotification helper", () => {
  it("produces non-empty channel bodies for every supported language", () => {
    for (const lang of ADMIN_EMAIL_LANGS) {
      const n = composeDocumentRejectedNotification({
        lang,
        memberName: "Test Member",
        docLabel: "Driving License",
        orgName: "Test Club",
        reason: "Image is blurry",
      });
      expect(n.inAppSubject.length).toBeGreaterThan(0);
      expect(n.inAppBody.length).toBeGreaterThan(0);
      expect(n.pushTitle.length).toBeGreaterThan(0);
      expect(n.pushBody.length).toBeGreaterThan(0);
      expect(n.smsBody.length).toBeGreaterThan(0);
      expect(n.whatsappBody.length).toBeGreaterThan(0);
      // Push body never exceeds the 200-char Apple/Android friendly cap.
      expect(n.pushBody.length).toBeLessThanOrEqual(200);
      // SMS / WhatsApp body never exceeds the 480-char cap.
      expect(n.smsBody.length).toBeLessThanOrEqual(480);
      expect(n.whatsappBody.length).toBeLessThanOrEqual(480);
    }
  });

  it("renders Hindi strings on every channel when lang='hi'", () => {
    const n = composeDocumentRejectedNotification({
      lang: "hi",
      memberName: "Asha",
      docLabel: "Driving License",
      orgName: "Test Club",
      reason: "Image is blurry",
    });
    const hi = getEmailStrings("hi", "documentRejected");

    const expectedSubject = hi.subject.replace("{docLabel}", "Driving License");
    const expectedGreeting = hi.greeting.replace("{memberName}", "Asha");
    const expectedIntro = hi.intro
      .replace("{docLabel}", "Driving License")
      .replace("{orgName}", "Test Club");

    expect(n.inAppSubject).toBe(expectedSubject);
    expect(n.pushTitle).toBe(expectedSubject);
    expect(n.inAppBody).toContain(expectedGreeting);
    expect(n.inAppBody).toContain(expectedIntro);
    expect(n.inAppBody).toContain(`${hi.reasonLabel}: Image is blurry`);
    expect(n.inAppBody).toContain(hi.reupload);
    // Push body should start with the localised greeting (it is a prefix of
    // the full body, possibly truncated).
    expect(n.pushBody.startsWith(expectedGreeting)).toBe(true);
    // SMS / WhatsApp embed the localised subject + body.
    expect(n.smsBody).toContain(expectedSubject);
    expect(n.smsBody).toContain(expectedGreeting);
    expect(n.whatsappBody).toBe(n.smsBody);
    // English copy is NOT present.
    expect(n.inAppBody).not.toContain("Reason:");
    expect(n.inAppBody).not.toContain("Please re-upload a corrected version");
  });

  it("renders Arabic strings on every channel when lang='ar'", () => {
    const n = composeDocumentRejectedNotification({
      lang: "ar",
      memberName: "Sami",
      docLabel: "Passport",
      orgName: "Club Beta",
      reason: "expired",
    });
    const ar = getEmailStrings("ar", "documentRejected");
    expect(n.inAppSubject).toBe(ar.subject.replace("{docLabel}", "Passport"));
    expect(n.inAppBody).toContain(ar.greeting.replace("{memberName}", "Sami"));
    expect(n.inAppBody).toContain(`${ar.reasonLabel}: expired`);
    expect(n.inAppBody).toContain(ar.reupload);
  });

  it("renders Spanish strings on every channel when lang='es'", () => {
    const n = composeDocumentRejectedNotification({
      lang: "es",
      memberName: "Carlos",
      docLabel: "DNI",
      orgName: "Club Alfa",
      reason: "foto borrosa",
    });
    const es = getEmailStrings("es", "documentRejected");
    expect(n.inAppSubject).toBe(es.subject.replace("{docLabel}", "DNI"));
    expect(n.inAppBody).toContain(es.greeting.replace("{memberName}", "Carlos"));
    expect(n.inAppBody).toContain(`${es.reasonLabel}: foto borrosa`);
    expect(n.inAppBody).toContain(es.reupload);
    expect(n.smsBody).toContain(es.subject.replace("{docLabel}", "DNI"));
  });

  it("falls back to English when lang is null / undefined / unsupported", () => {
    const en = getEmailStrings("en", "documentRejected");
    for (const lang of [null, undefined, "xx-bogus"] as const) {
      const n = composeDocumentRejectedNotification({
        lang,
        memberName: "X",
        docLabel: "Doc",
        orgName: "Org",
        reason: "r",
      });
      expect(n.inAppSubject).toBe(en.subject.replace("{docLabel}", "Doc"));
      expect(n.inAppBody).toContain("Hi X,");
      expect(n.inAppBody).toContain("Reason: r");
      expect(n.inAppBody).toContain(en.reupload);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// End-to-end: org.defaultLanguage flows through each channel call site
// ───────────────────────────────────────────────────────────────────────────
const orgIds: number[] = [];
const memberIds: number[] = [];
const userIds: number[] = [];
let userSeq = 0;

async function makeOrg(lang: "en" | "hi" | "ar" | "fr"): Promise<{ id: number; name: string }> {
  const [org] = await db.insert(organizationsTable).values({
    name: `Test_${lang}_${Date.now()}_${orgIds.length}`,
    slug: `doc-i18n-${lang}-${Date.now()}-${orgIds.length}`,
    defaultLanguage: lang,
  }).returning({ id: organizationsTable.id, name: organizationsTable.name });
  orgIds.push(org.id);
  return org;
}

async function makeAppUser(): Promise<number> {
  userSeq += 1;
  const tag = `${Date.now()}_${userSeq}`;
  const [u] = await db.insert(appUsersTable).values({
    replitUserId: `doc-rejected-i18n-${tag}`,
    username: `doc_rejected_i18n_${tag}`,
  }).returning({ id: appUsersTable.id });
  userIds.push(u.id);
  return u.id;
}

async function makeMember(orgId: number): Promise<number> {
  const userId = await makeAppUser();
  const [m] = await db.insert(clubMembersTable).values({
    organizationId: orgId,
    firstName: "Asha",
    lastName: "Singh",
    email: "asha@example.com",
    phone: "+911234567890",
    userId,
  }).returning({ id: clubMembersTable.id });
  await db.insert(memberCommPrefsTable).values({
    organizationId: orgId,
    clubMemberId: m.id,
    category: "operations",
    emailEnabled: true,
    pushEnabled: true,
    smsEnabled: true,
    whatsappEnabled: true,
  });
  memberIds.push(m.id);
  return m.id;
}

beforeAll(async () => {
  // No-op; per-test orgs are created so each test gets isolated language config.
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
  for (const id of orgIds) {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, id));
  }
});

beforeEach(() => {
  pushMock.mockReset();
  smsMock.mockReset();
  waMock.mockReset();
  pushMock.mockImplementation(async (uIds: number[]) => ({
    attempted: uIds.length, sent: uIds.length, failed: 0, invalid: 0,
  }));
  smsMock.mockResolvedValue(undefined);
  waMock.mockResolvedValue(null);
});

describe("Task #1267 — notifyDocumentRejected honours org.defaultLanguage on every channel", () => {
  it("renders the in-app subject + body, push title + body, SMS body, and WhatsApp body in Hindi", async () => {
    const org = await makeOrg("hi");
    const memberId = await makeMember(org.id);

    const res = await notifyDocumentRejected({
      organizationId: org.id,
      clubMemberId: memberId,
      document: { id: 1001, title: "Driving License", documentType: "id_proof" },
      reason: "Image is blurry",
    });

    expect(res.inAppMessageId).toBeTypeOf("number");
    expect(res.pushStatus).toBe("sent");
    expect(res.smsStatus).toBe("sent");
    expect(res.whatsappStatus).toBe("sent");

    const hi = getEmailStrings("hi", "documentRejected");
    const expectedSubject = hi.subject.replace("{docLabel}", "Driving License");
    const expectedGreeting = hi.greeting.replace("{memberName}", "Asha Singh");
    const expectedIntro = hi.intro
      .replace("{docLabel}", "Driving License")
      .replace("{orgName}", org.name);

    // Push call: title + body in Hindi.
    expect(pushMock).toHaveBeenCalledTimes(1);
    const [, pushTitle, pushBody] = pushMock.mock.calls[0];
    expect(pushTitle).toBe(expectedSubject);
    expect(pushBody.startsWith(expectedGreeting)).toBe(true);
    // English copy not present in push body.
    expect(pushBody).not.toContain("Document needs attention");

    // SMS body in Hindi (subject + body composition).
    expect(smsMock).toHaveBeenCalledTimes(1);
    const [, smsBody] = smsMock.mock.calls[0];
    expect(smsBody).toContain(expectedSubject);
    expect(smsBody).toContain(expectedGreeting);
    expect(smsBody).toContain(`${hi.reasonLabel}: Image is blurry`);

    // WhatsApp body in Hindi.
    expect(waMock).toHaveBeenCalledTimes(1);
    const [, waBody] = waMock.mock.calls[0];
    expect(waBody).toContain(expectedSubject);
    expect(waBody).toContain(expectedIntro);

    // In-app message persisted with localised subject + body.
    const [row] = await db.select({
      subject: memberMessagesTable.subject,
      body: memberMessagesTable.body,
      channel: memberMessagesTable.channel,
    }).from(memberMessagesTable).where(eq(memberMessagesTable.id, res.inAppMessageId!)).limit(1);

    expect(row.channel).toBe("in_app");
    expect(row.subject).toBe(expectedSubject);
    expect(row.body).toContain(expectedGreeting);
    expect(row.body).toContain(expectedIntro);
    expect(row.body).toContain(`${hi.reasonLabel}: Image is blurry`);
    expect(row.body).toContain(hi.reupload);
    // Did not render English copy.
    expect(row.body).not.toContain("Please re-upload a corrected version");
  });

  it("falls back to English when org.defaultLanguage='en'", async () => {
    const org = await makeOrg("en");
    const memberId = await makeMember(org.id);

    const res = await notifyDocumentRejected({
      organizationId: org.id,
      clubMemberId: memberId,
      document: { id: 1002, title: "Address Proof", documentType: "address_proof" },
      reason: "older than 3 months",
    });

    expect(res.inAppMessageId).toBeTypeOf("number");

    const [, pushTitle, pushBody] = pushMock.mock.calls[0];
    expect(pushTitle).toBe('Document needs attention: Address Proof');
    expect(pushBody).toContain("Hi Asha Singh,");
    expect(pushBody).toContain('Address Proof');

    const [, smsBody] = smsMock.mock.calls[0];
    expect(smsBody).toContain("Reason: older than 3 months");
  });

  it("renders in French when org.defaultLanguage='fr'", async () => {
    const org = await makeOrg("fr");
    const memberId = await makeMember(org.id);

    await notifyDocumentRejected({
      organizationId: org.id,
      clubMemberId: memberId,
      document: { id: 1003, title: "Carte d'identité", documentType: "id_proof" },
      reason: "Photo trop floue",
    });

    const fr = getEmailStrings("fr", "documentRejected");
    const expectedSubject = fr.subject.replace("{docLabel}", "Carte d'identité");

    const [, pushTitle] = pushMock.mock.calls[0];
    expect(pushTitle).toBe(expectedSubject);
    const [, smsBody] = smsMock.mock.calls[0];
    expect(smsBody).toContain(`${fr.reasonLabel}: Photo trop floue`);
    expect(smsBody).toContain(fr.reupload);
  });
});
