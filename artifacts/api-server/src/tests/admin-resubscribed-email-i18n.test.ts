/**
 * Task #2114 — Verify the admin re-subscribed alert email
 * (`sendAdminResubscribedAlertEmail`, mailer.ts) is rendered in the
 * recipient's `appUsersTable.preferredLanguage` for both flows
 * (`tie_break_admin_resubscribed` and
 * `bounced_digest_schedule_admin_resubscribed`), with English as the
 * canonical fallback.
 *
 * Approach mirrors `round-robin-tie-break-email-i18n.test.ts`: mock
 * nodemailer so we can capture the final subject + html that would be
 * sent and assert each captured payload contains the localised strings
 * from the `notificationEmailI18n` bundles authored for these keys.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

// Set Gmail env vars BEFORE the email adapter is imported so its
// module-level credential check passes and `sendMail` actually invokes the
// (mocked) transport instead of throwing on the credentials guard.
vi.hoisted(() => {
  process.env.GMAIL_USER = process.env.GMAIL_USER || "test@example.com";
  process.env.GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD || "test-app-password";
  process.env.EMAIL_PROVIDER = "gmail";
});

const sendMailMock = vi.hoisted(() => vi.fn(async () => ({ messageId: "test" })));

vi.mock("nodemailer", () => {
  const transport = { sendMail: sendMailMock };
  return {
    default: { createTransport: () => transport },
    createTransport: () => transport,
  };
});

import { sendAdminResubscribedAlertEmail } from "../lib/mailer.js";
import {
  getNotificationEmailBundle,
  fmtNotificationEmail,
} from "../lib/notificationEmailI18n.js";

interface CapturedMail {
  to: string;
  subject: string;
  html: string;
}

function captured(): CapturedMail[] {
  return sendMailMock.mock.calls.map(
    (c) => (c as unknown as [CapturedMail])[0],
  );
}

beforeAll(() => {
  process.env.INGRESS_PROVIDER = "mock";
});

beforeEach(() => {
  sendMailMock.mockReset();
  sendMailMock.mockResolvedValue({ messageId: "test" });
});

const ORG = "Acme Golf Club";
const ACTOR = "Priya Patel";
const RECIPIENT = "Aanya Kapoor";
const UNSUB_URL = "https://example.com/api/public/tie-break-email-unsubscribe?token=abc.def";

const TIE_BREAK_FLOW = "tie_break_admin_resubscribed" as const;
const BOUNCED_FLOW = "bounced_digest_schedule_admin_resubscribed" as const;
const TIE_BREAK_KEY = "admin.resubscribed.tie_break";
const BOUNCED_KEY = "admin.resubscribed.bounced_digest_schedule";

// English fallback bundles for negative assertions ("not English copy").
const TIE_BREAK_EN = getNotificationEmailBundle("en", TIE_BREAK_KEY)!;
const BOUNCED_EN = getNotificationEmailBundle("en", BOUNCED_KEY)!;

function expectLocalised(
  mail: CapturedMail,
  key: string,
  lang: string,
) {
  const bundle = getNotificationEmailBundle(lang, key);
  expect(bundle, `bundle missing for (${lang}, ${key})`).not.toBeNull();
  const kb = bundle!.key;
  // Subject is rendered through fmtNotificationEmail with the same vars.
  const expectedSubject = fmtNotificationEmail(kb.subject, {
    actor: ACTOR,
    club: ORG,
    recipient: RECIPIENT,
  });
  expect(mail.subject).toBe(expectedSubject);
  // Heading (h2) — falls back to subject when labels.heading is absent.
  expect(mail.html).toContain(kb.labels?.heading ?? kb.subject);
  // Subtitle banner ("Notification preferences" in English).
  expect(mail.html).toContain(kb.subtitle);
  // CTA button label.
  expect(mail.html).toContain(kb.ctaLabel);
  // Footer link label.
  expect(mail.html).toContain(kb.labels?.footerLinkLabel ?? "Unsubscribe with one click");
  // Unsub URL is preserved in the body verbatim.
  expect(mail.html).toContain(UNSUB_URL);
}

describe("Task #2114 — admin re-subscribed alert email is rendered in the recipient's language", () => {
  it("tie-break flow renders Spanish when preferredLanguage='es'", async () => {
    await sendAdminResubscribedAlertEmail({
      to: "dir@example.com",
      recipientName: RECIPIENT,
      actorName: ACTOR,
      orgName: ORG,
      alertSentence: "turned the round-robin tie-break required email back on for you.",
      heading: "Tie-break alert emails turned back on",
      subject: "Tie-break alert emails turned back on",
      unsubscribeUrl: UNSUB_URL,
      flow: TIE_BREAK_FLOW,
      preferredLanguage: "es",
    });

    const mails = captured();
    expect(mails).toHaveLength(1);
    expectLocalised(mails[0], TIE_BREAK_KEY, "es");
    // Spot-check the English subject and heading do NOT appear.
    expect(mails[0].subject).not.toBe(TIE_BREAK_EN.key.subject);
    expect(mails[0].html).not.toContain(TIE_BREAK_EN.key.subject);
    expect(mails[0].html).not.toContain(TIE_BREAK_EN.key.ctaLabel);
  });

  it("tie-break flow renders Hindi when preferredLanguage='hi'", async () => {
    await sendAdminResubscribedAlertEmail({
      to: "dir@example.com",
      recipientName: RECIPIENT,
      actorName: ACTOR,
      orgName: ORG,
      alertSentence: "turned the round-robin tie-break required email back on for you.",
      heading: "Tie-break alert emails turned back on",
      subject: "Tie-break alert emails turned back on",
      unsubscribeUrl: UNSUB_URL,
      flow: TIE_BREAK_FLOW,
      preferredLanguage: "hi",
    });

    const mails = captured();
    expect(mails).toHaveLength(1);
    expectLocalised(mails[0], TIE_BREAK_KEY, "hi");
    expect(mails[0].html).not.toContain(TIE_BREAK_EN.key.subject);
  });

  it("bounced-digest flow renders French when preferredLanguage='fr'", async () => {
    await sendAdminResubscribedAlertEmail({
      to: "dir@example.com",
      recipientName: RECIPIENT,
      actorName: ACTOR,
      orgName: ORG,
      alertSentence: "turned the bounced-reminders digest schedule-change emails back on for you.",
      heading: "Bounced-reminders schedule emails turned back on",
      subject: "Bounced-reminders schedule emails turned back on",
      unsubscribeUrl: UNSUB_URL,
      flow: BOUNCED_FLOW,
      preferredLanguage: "fr",
    });

    const mails = captured();
    expect(mails).toHaveLength(1);
    expectLocalised(mails[0], BOUNCED_KEY, "fr");
    expect(mails[0].subject).not.toBe(BOUNCED_EN.key.subject);
    expect(mails[0].html).not.toContain(BOUNCED_EN.key.subject);
    expect(mails[0].html).not.toContain(BOUNCED_EN.key.ctaLabel);
  });

  it("bounced-digest flow renders Japanese when preferredLanguage='ja'", async () => {
    await sendAdminResubscribedAlertEmail({
      to: "dir@example.com",
      recipientName: RECIPIENT,
      actorName: ACTOR,
      orgName: ORG,
      alertSentence: "turned the bounced-reminders digest schedule-change emails back on for you.",
      heading: "Bounced-reminders schedule emails turned back on",
      subject: "Bounced-reminders schedule emails turned back on",
      unsubscribeUrl: UNSUB_URL,
      flow: BOUNCED_FLOW,
      preferredLanguage: "ja",
    });

    const mails = captured();
    expect(mails).toHaveLength(1);
    expectLocalised(mails[0], BOUNCED_KEY, "ja");
    expect(mails[0].html).not.toContain(BOUNCED_EN.key.subject);
  });

  it("falls back to English when preferredLanguage is null", async () => {
    await sendAdminResubscribedAlertEmail({
      to: "dir@example.com",
      recipientName: RECIPIENT,
      actorName: ACTOR,
      orgName: ORG,
      alertSentence: "turned the round-robin tie-break required email back on for you.",
      heading: "Tie-break alert emails turned back on",
      subject: "Tie-break alert emails turned back on",
      unsubscribeUrl: UNSUB_URL,
      flow: TIE_BREAK_FLOW,
      preferredLanguage: null,
    });

    const mails = captured();
    expect(mails).toHaveLength(1);
    expectLocalised(mails[0], TIE_BREAK_KEY, "en");
    expect(mails[0].subject).toBe(TIE_BREAK_EN.key.subject);
  });

  it("falls back to English when preferredLanguage is unsupported", async () => {
    await sendAdminResubscribedAlertEmail({
      to: "dir@example.com",
      recipientName: RECIPIENT,
      actorName: ACTOR,
      orgName: ORG,
      alertSentence: "turned the bounced-reminders digest schedule-change emails back on for you.",
      heading: "Bounced-reminders schedule emails turned back on",
      subject: "Bounced-reminders schedule emails turned back on",
      unsubscribeUrl: UNSUB_URL,
      flow: BOUNCED_FLOW,
      preferredLanguage: "xx-not-a-real-lang",
    });

    const mails = captured();
    expect(mails).toHaveLength(1);
    expectLocalised(mails[0], BOUNCED_KEY, "en");
  });
});
