/**
 * Task #1538 — Verify the document-unrejected push, SMS, WhatsApp, and
 * in-app notification bodies are rendered in the org's `defaultLanguage`
 * with EN fallback (mirrors `document-rejected-notify-i18n.test.ts` which
 * covers the sibling rejection flow).
 *
 * Two layers of coverage:
 *   1. `composeDocumentUnrejectedNotification` is unit-tested directly
 *      against every supported language to assert the localised subject /
 *      body / push title / push body / SMS body / WhatsApp body shape.
 *   2. `notifyDocumentUnrejected` is exercised end-to-end against a real DB
 *      with the mailer + comms helpers mocked, so we can confirm the org's
 *      `defaultLanguage` flows through to each channel call site.
 */
import { describe, it, expect, afterAll, beforeEach, vi } from "vitest";

vi.mock("../lib/mailer.js", async () => ({
  sendBroadcastEmail: vi.fn(async () => undefined),
  classifyMailerError: vi.fn(() => "other"),
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
import { notifyDocumentUnrejected } from "../lib/documentUnrejectedNotify.js";
import {
  sendTransactionalPush,
  sendTransactionalSms,
  sendTransactionalWhatsapp,
} from "../lib/comms.js";
import { sendBroadcastEmail, classifyMailerError } from "../lib/mailer.js";
import {
  composeDocumentUnrejectedNotification,
  getEmailStrings,
  ADMIN_EMAIL_LANGS,
} from "../lib/adminEmailI18n.js";

const pushMock = vi.mocked(sendTransactionalPush);
const smsMock = vi.mocked(sendTransactionalSms);
const waMock = vi.mocked(sendTransactionalWhatsapp);
const emailMock = vi.mocked(sendBroadcastEmail);
const classifyMailerErrorMock = vi.mocked(classifyMailerError);

describe("Task #1538 — composeDocumentUnrejectedNotification helper", () => {
  it("produces non-empty channel bodies for every supported language", () => {
    for (const lang of ADMIN_EMAIL_LANGS) {
      const n = composeDocumentUnrejectedNotification({
        lang,
        memberName: "Test Member",
        docLabel: "Driving License",
        orgName: "Test Club",
        reason: "Rejected by mistake",
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
    const n = composeDocumentUnrejectedNotification({
      lang: "hi",
      memberName: "Asha",
      docLabel: "Driving License",
      orgName: "Test Club",
      reason: "Rejected by mistake",
    });
    const hi = getEmailStrings("hi", "documentUnrejected");

    const expectedSubject = hi.subject.replace("{docLabel}", "Driving License");
    const expectedGreeting = hi.greeting.replace("{memberName}", "Asha");
    const expectedIntro = hi.intro
      .replace("{docLabel}", "Driving License")
      .replace("{orgName}", "Test Club");

    expect(n.inAppSubject).toBe(expectedSubject);
    expect(n.pushTitle).toBe(expectedSubject);
    expect(n.inAppBody).toContain(expectedGreeting);
    expect(n.inAppBody).toContain(expectedIntro);
    expect(n.inAppBody).toContain(`${hi.noteLabel}: Rejected by mistake`);
    // Push body should start with the localised greeting.
    expect(n.pushBody.startsWith(expectedGreeting)).toBe(true);
    // SMS / WhatsApp embed the localised subject + body.
    expect(n.smsBody).toContain(expectedSubject);
    expect(n.smsBody).toContain(expectedGreeting);
    expect(n.whatsappBody).toBe(n.smsBody);
    // English copy is NOT present.
    expect(n.inAppBody).not.toContain("Rejection withdrawn");
    expect(n.inAppBody).not.toContain("Note from staff:");
  });

  it("renders Arabic strings on every channel when lang='ar'", () => {
    const n = composeDocumentUnrejectedNotification({
      lang: "ar",
      memberName: "Sami",
      docLabel: "Passport",
      orgName: "Club Beta",
      reason: "خطأ في المراجعة",
    });
    const ar = getEmailStrings("ar", "documentUnrejected");
    expect(n.inAppSubject).toBe(ar.subject.replace("{docLabel}", "Passport"));
    expect(n.inAppBody).toContain(ar.greeting.replace("{memberName}", "Sami"));
    expect(n.inAppBody).toContain(`${ar.noteLabel}: خطأ في المراجعة`);
  });

  it("renders Spanish strings on every channel when lang='es'", () => {
    const n = composeDocumentUnrejectedNotification({
      lang: "es",
      memberName: "Carlos",
      docLabel: "DNI",
      orgName: "Club Alfa",
      reason: "rechazo por error",
    });
    const es = getEmailStrings("es", "documentUnrejected");
    expect(n.inAppSubject).toBe(es.subject.replace("{docLabel}", "DNI"));
    expect(n.inAppBody).toContain(es.greeting.replace("{memberName}", "Carlos"));
    expect(n.inAppBody).toContain(`${es.noteLabel}: rechazo por error`);
    expect(n.smsBody).toContain(es.subject.replace("{docLabel}", "DNI"));
  });

  it("omits the note line when no reason is supplied", () => {
    const n = composeDocumentUnrejectedNotification({
      lang: "en",
      memberName: "Bob",
      docLabel: "Passport",
      orgName: "Club",
    });
    expect(n.inAppBody).not.toContain("Note from staff:");
    // Empty/whitespace reason is also treated as no reason.
    const n2 = composeDocumentUnrejectedNotification({
      lang: "en",
      memberName: "Bob",
      docLabel: "Passport",
      orgName: "Club",
      reason: "   ",
    });
    expect(n2.inAppBody).not.toContain("Note from staff:");
  });

  it("falls back to English when lang is null / undefined / unsupported", () => {
    const en = getEmailStrings("en", "documentUnrejected");
    for (const lang of [null, undefined, "xx-bogus"] as const) {
      const n = composeDocumentUnrejectedNotification({
        lang,
        memberName: "X",
        docLabel: "Doc",
        orgName: "Org",
        reason: "r",
      });
      expect(n.inAppSubject).toBe(en.subject.replace("{docLabel}", "Doc"));
      expect(n.inAppBody).toContain("Hi X,");
      expect(n.inAppBody).toContain("Note from staff: r");
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
    name: `TestU_${lang}_${Date.now()}_${orgIds.length}`,
    slug: `doc-u-i18n-${lang}-${Date.now()}-${orgIds.length}`,
    defaultLanguage: lang,
  }).returning({ id: organizationsTable.id, name: organizationsTable.name });
  orgIds.push(org.id);
  return org;
}

async function makeAppUser(): Promise<number> {
  userSeq += 1;
  const tag = `${Date.now()}_${userSeq}`;
  const [u] = await db.insert(appUsersTable).values({
    replitUserId: `doc-unrejected-i18n-${tag}`,
    username: `doc_unrejected_i18n_${tag}`,
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
  emailMock.mockReset();
  pushMock.mockImplementation(async (uIds: number[]) => ({
    attempted: uIds.length, sent: uIds.length, failed: 0, invalid: 0,
  }));
  smsMock.mockResolvedValue(undefined);
  waMock.mockResolvedValue(null);
  emailMock.mockResolvedValue(undefined);
});

describe("Task #1538 — notifyDocumentUnrejected honours org.defaultLanguage on every channel", () => {
  it("renders the in-app subject + body, push title + body, SMS body, and WhatsApp body in Hindi", async () => {
    const org = await makeOrg("hi");
    const memberId = await makeMember(org.id);

    const res = await notifyDocumentUnrejected({
      organizationId: org.id,
      clubMemberId: memberId,
      document: { id: 2001, title: "Driving License", documentType: "id_proof" },
      reason: "Rejected by mistake",
    });

    expect(res.inAppMessageId).toBeTypeOf("number");
    expect(res.pushStatus).toBe("sent");
    expect(res.smsStatus).toBe("sent");
    expect(res.whatsappStatus).toBe("sent");

    const hi = getEmailStrings("hi", "documentUnrejected");
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
    expect(pushBody).not.toContain("Rejection withdrawn");

    // SMS body in Hindi (subject + body composition).
    expect(smsMock).toHaveBeenCalledTimes(1);
    const [, smsBody] = smsMock.mock.calls[0];
    expect(smsBody).toContain(expectedSubject);
    expect(smsBody).toContain(expectedGreeting);
    expect(smsBody).toContain(`${hi.noteLabel}: Rejected by mistake`);

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
    expect(row.body).toContain(`${hi.noteLabel}: Rejected by mistake`);
    // Did not render English copy.
    expect(row.body).not.toContain("Note from staff:");
    expect(row.body).not.toContain("Rejection withdrawn");
  });

  it("falls back to English when org.defaultLanguage='en'", async () => {
    const org = await makeOrg("en");
    const memberId = await makeMember(org.id);

    const res = await notifyDocumentUnrejected({
      organizationId: org.id,
      clubMemberId: memberId,
      document: { id: 2002, title: "Address Proof", documentType: "address_proof" },
      reason: "rejection was incorrect",
    });

    expect(res.inAppMessageId).toBeTypeOf("number");

    const [, pushTitle, pushBody] = pushMock.mock.calls[0];
    expect(pushTitle).toBe('Rejection withdrawn: Address Proof');
    expect(pushBody).toContain("Hi Asha Singh,");
    expect(pushBody).toContain('Address Proof');

    const [, smsBody] = smsMock.mock.calls[0];
    expect(smsBody).toContain("Note from staff: rejection was incorrect");
  });

  it("renders in French when org.defaultLanguage='fr'", async () => {
    const org = await makeOrg("fr");
    const memberId = await makeMember(org.id);

    await notifyDocumentUnrejected({
      organizationId: org.id,
      clubMemberId: memberId,
      document: { id: 2003, title: "Carte d'identité", documentType: "id_proof" },
      reason: "Rejet par erreur",
    });

    const fr = getEmailStrings("fr", "documentUnrejected");
    const expectedSubject = fr.subject.replace("{docLabel}", "Carte d'identité");

    const [, pushTitle] = pushMock.mock.calls[0];
    expect(pushTitle).toBe(expectedSubject);
    const [, smsBody] = smsMock.mock.calls[0];
    expect(smsBody).toContain(`${fr.noteLabel}: Rejet par erreur`);
  });

  // Task #1502 / Task #1850 — provider_unconfigured branch (lib line 165).
  // A misconfigured mailer is an env-wide condition; the helper must map
  // it to terminal `skipped` / `provider_not_configured` instead of
  // `failed` so the audit log isn't polluted on every send. Push / SMS /
  // WhatsApp continue independently because the email failure is caught
  // and isolated.
  it("provider_unconfigured: emailStatus skipped/provider_not_configured; push/SMS/WhatsApp still run", async () => {
    classifyMailerErrorMock.mockReturnValueOnce("provider_unconfigured");
    emailMock.mockRejectedValueOnce(new Error("RESEND_API_KEY not set"));

    const org = await makeOrg("en");
    const memberId = await makeMember(org.id);

    const res = await notifyDocumentUnrejected({
      organizationId: org.id,
      clubMemberId: memberId,
      document: { id: 2099, title: "Driving License", documentType: "id_proof" },
      reason: "Rejection withdrawn by mistake",
    });

    expect(res.emailStatus).toBe("skipped");
    expect(res.emailError).toBe("provider_not_configured");
    expect(res.pushStatus).toBe("sent");
    expect(res.smsStatus).toBe("sent");
    expect(res.whatsappStatus).toBe("sent");
  });

  it("omits the note line when no reason is supplied", async () => {
    const org = await makeOrg("en");
    const memberId = await makeMember(org.id);

    const res = await notifyDocumentUnrejected({
      organizationId: org.id,
      clubMemberId: memberId,
      document: { id: 2004, title: "Insurance", documentType: "insurance" },
      reason: null,
    });

    const [row] = await db.select({
      body: memberMessagesTable.body,
    }).from(memberMessagesTable).where(eq(memberMessagesTable.id, res.inAppMessageId!)).limit(1);

    expect(row.body).not.toContain("Note from staff:");
  });
});
