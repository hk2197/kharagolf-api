/**
 * Task #1044 — Verify the round-robin tie-break director email
 * (sendRoundRobinTieBreakAlertEmail, originally added by Task #898) is
 * rendered in the recipient's preferred language with an English fallback.
 *
 * Approach mirrors `custom-domain-cert-email-i18n.test.ts`: mock nodemailer
 * so we can capture the *final* subject + html that would be sent and assert
 * each captured payload contains the localised strings defined in
 * `customDomainEmailI18n.ts` (where the tie-break translations live).
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

import { sendRoundRobinTieBreakAlertEmail } from "../lib/mailer.js";
import {
  getCustomDomainEmailStrings,
  CUSTOM_DOMAIN_EMAIL_LANGS,
  type CustomDomainEmailLang,
} from "../lib/customDomainEmailI18n.js";

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
const TOURNAMENT = "Spring Round Robin";
const RECIPIENT = "Aanya Kapoor";
const MATCH_URL = "https://example.com/tournaments/1/brackets/2/matches/3";

function expectLocalised(mail: CapturedMail, lang: CustomDomainEmailLang) {
  const strings = getCustomDomainEmailStrings(lang);
  const expectedSubject = strings.tieBreak.subject
    .replace("{orgName}", ORG)
    .replace("{tournamentName}", TOURNAMENT);
  expect(mail.subject).toBe(expectedSubject);
  // Heading is rendered verbatim into an <h2>.
  expect(mail.html).toContain(strings.tieBreak.heading);
  // CTA, header tag, and the localised tournament name appear in the body.
  expect(mail.html).toContain(strings.tieBreak.cta);
  expect(mail.html).toContain(strings.tieBreak.headerTag);
  expect(mail.html).toContain(TOURNAMENT);
  // The deep-link to the tie-break match is preserved.
  expect(mail.html).toContain(MATCH_URL);
}

describe("Task #1044 — round-robin tie-break email is rendered in the director's language", () => {
  it("renders Hindi when lang='hi'", async () => {
    await sendRoundRobinTieBreakAlertEmail({
      to: "dir@example.com",
      recipientName: RECIPIENT,
      tournamentName: TOURNAMENT,
      matchUrl: MATCH_URL,
      branding: { orgName: ORG },
      lang: "hi",
    });

    const mails = captured();
    expect(mails).toHaveLength(1);
    expectLocalised(mails[0], "hi");
    // Spot-check we did NOT render the English heading.
    const en = getCustomDomainEmailStrings("en");
    expect(mails[0].html).not.toContain(en.tieBreak.heading);
  });

  it("renders Spanish when lang='es'", async () => {
    await sendRoundRobinTieBreakAlertEmail({
      to: "dir@example.com",
      recipientName: RECIPIENT,
      tournamentName: TOURNAMENT,
      matchUrl: MATCH_URL,
      branding: { orgName: ORG },
      lang: "es",
    });
    const mails = captured();
    expect(mails).toHaveLength(1);
    expectLocalised(mails[0], "es");
    const en = getCustomDomainEmailStrings("en");
    expect(mails[0].html).not.toContain(en.tieBreak.heading);
  });

  it("falls back to English when lang is null/undefined", async () => {
    await sendRoundRobinTieBreakAlertEmail({
      to: "dir@example.com",
      recipientName: RECIPIENT,
      tournamentName: TOURNAMENT,
      matchUrl: MATCH_URL,
      branding: { orgName: ORG },
      lang: null,
    });
    const mails = captured();
    expect(mails).toHaveLength(1);
    expectLocalised(mails[0], "en");
  });

  it("falls back to English for an unsupported language code", async () => {
    await sendRoundRobinTieBreakAlertEmail({
      to: "dir@example.com",
      recipientName: RECIPIENT,
      tournamentName: TOURNAMENT,
      matchUrl: MATCH_URL,
      branding: { orgName: ORG },
      lang: "xx-not-a-real-lang",
    });
    const mails = captured();
    expect(mails).toHaveLength(1);
    expectLocalised(mails[0], "en");
  });

  it("ships a tieBreak pack for every supported language (no missing translations)", () => {
    // Use the canonical list exported by the i18n module so this test cannot
    // drift if a new locale is added.
    expect(CUSTOM_DOMAIN_EMAIL_LANGS.length).toBeGreaterThanOrEqual(21);
    for (const lang of CUSTOM_DOMAIN_EMAIL_LANGS) {
      const strings = getCustomDomainEmailStrings(lang);
      expect(strings.tieBreak.subject.length).toBeGreaterThan(0);
      expect(strings.tieBreak.heading.length).toBeGreaterThan(0);
      expect(strings.tieBreak.greeting.length).toBeGreaterThan(0);
      expect(strings.tieBreak.cta.length).toBeGreaterThan(0);
      expect(strings.tieBreak.footer.length).toBeGreaterThan(0);
      expect(strings.tieBreak.headerTag.length).toBeGreaterThan(0);
      // Subject must contain placeholders so callers can interpolate.
      expect(strings.tieBreak.subject).toContain("{orgName}");
      expect(strings.tieBreak.subject).toContain("{tournamentName}");
      expect(strings.tieBreak.greeting).toContain("{recipient}");
      expect(strings.tieBreak.greeting).toContain("{tournamentName}");
      expect(strings.tieBreak.footer).toContain("{orgName}");
    }
  });
});
