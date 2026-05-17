/**
 * Task #1271 — Verify the side-game settlement receipt email
 * (sendSideGameSettlementReceiptEmail, opt-out footer added by Task #1105)
 * renders its discoverability footer in the recipient's preferred language
 * with an English fallback.
 *
 * Approach mirrors `round-robin-tie-break-email-i18n.test.ts`: mock
 * nodemailer so we can capture the *final* html that would be sent and
 * assert each captured payload contains the localised footer string from
 * `customDomainEmailI18n.ts`.
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

import { sendSideGameSettlementReceiptEmail } from "../lib/mailer.js";
import {
  getCustomDomainEmailStrings,
  CUSTOM_DOMAIN_EMAIL_LANGS,
  fmtTemplate,
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
const COMM_PREFS_URL = "https://example.com/comm-preferences";

const baseOpts = {
  to: "rec@example.com",
  recipientName: "Aanya Kapoor",
  payerName: "Bilal Khan",
  gameLabel: "Wolf",
  currency: "INR",
  currencySymbol: "₹",
  amount: "500.00",
  branding: { orgName: ORG },
  commPrefsUrl: COMM_PREFS_URL,
};

function expectFooterLocalised(mail: CapturedMail, lang: CustomDomainEmailLang) {
  const strings = getCustomDomainEmailStrings(lang);
  // The opt-out template wraps the link label in {linkOpen}/{linkClose};
  // pull out the label and the surrounding copy so we can assert each
  // piece survives interpolation in the rendered html.
  const tpl = strings.sideGameReceipt.optOutFooter;
  const linkLabel = tpl.match(/\{linkOpen\}([\s\S]*?)\{linkClose\}/)?.[1] ?? "";
  const [beforeRaw, afterRaw = ""] = tpl.split(/\{linkOpen\}[\s\S]*?\{linkClose\}/);
  const before = fmtTemplate(beforeRaw, { orgName: ORG }).trim();
  const after = fmtTemplate(afterRaw, { orgName: ORG }).trim();
  expect(linkLabel.length).toBeGreaterThan(0);
  expect(mail.html).toContain(`href="${COMM_PREFS_URL}"`);
  expect(mail.html).toContain(linkLabel);
  if (before.length > 0) expect(mail.html).toContain(before);
  if (after.length > 0) expect(mail.html).toContain(after);
}

describe("Task #1271 — side-game receipt opt-out footer is rendered in the recipient's language", () => {
  it("renders Hindi when lang='hi'", async () => {
    await sendSideGameSettlementReceiptEmail({ ...baseOpts, lang: "hi" });
    const mails = captured();
    expect(mails).toHaveLength(1);
    expectFooterLocalised(mails[0], "hi");
    // Spot-check we did NOT render the English opt-out copy.
    const en = getCustomDomainEmailStrings("en");
    expect(mails[0].html).not.toContain(
      "Turn off side-game receipts in your communication preferences",
    );
    // And we did render the localised link label.
    expect(mails[0].html).toContain(
      "अपनी संचार प्राथमिकताओं में साइड-गेम रसीदें बंद करें",
    );
    // Sanity: en pack is the one missing.
    expect(en.sideGameReceipt.optOutFooter).toContain("Turn off side-game receipts");
  });

  it("renders Spanish when lang='es'", async () => {
    await sendSideGameSettlementReceiptEmail({ ...baseOpts, lang: "es" });
    const mails = captured();
    expect(mails).toHaveLength(1);
    expectFooterLocalised(mails[0], "es");
    expect(mails[0].html).toContain(
      "Desactiva los recibos de juegos paralelos en tus preferencias de comunicación",
    );
    expect(mails[0].html).not.toContain(
      "Turn off side-game receipts in your communication preferences",
    );
  });

  it("falls back to English when lang is null/undefined", async () => {
    await sendSideGameSettlementReceiptEmail({ ...baseOpts, lang: null });
    const mails = captured();
    expect(mails).toHaveLength(1);
    expect(mails[0].html).toContain(
      "Turn off side-game receipts in your communication preferences",
    );
  });

  it("falls back to English for an unsupported language code", async () => {
    await sendSideGameSettlementReceiptEmail({ ...baseOpts, lang: "xx-not-a-real-lang" });
    const mails = captured();
    expect(mails).toHaveLength(1);
    expect(mails[0].html).toContain(
      "Turn off side-game receipts in your communication preferences",
    );
  });

  it("omits the footer entirely when commPrefsUrl is not provided (regardless of lang)", async () => {
    const { commPrefsUrl: _drop, ...withoutCommPrefs } = baseOpts;
    await sendSideGameSettlementReceiptEmail({ ...withoutCommPrefs, lang: "hi" });
    const mails = captured();
    expect(mails).toHaveLength(1);
    expect(mails[0].html).not.toContain("अपनी संचार प्राथमिकताओं में साइड-गेम रसीदें बंद करें");
    expect(mails[0].html).not.toContain(
      "Turn off side-game receipts in your communication preferences",
    );
  });

  it("ships a sideGameReceipt pack for every supported language (no missing translations)", () => {
    expect(CUSTOM_DOMAIN_EMAIL_LANGS.length).toBeGreaterThanOrEqual(21);
    for (const lang of CUSTOM_DOMAIN_EMAIL_LANGS) {
      const strings = getCustomDomainEmailStrings(lang);
      expect(strings.sideGameReceipt.optOutFooter.length).toBeGreaterThan(0);
      // Every translation must keep the {linkOpen}/{linkClose}/{orgName}
      // placeholders so the mailer can splice the link in without losing
      // the surrounding copy.
      expect(strings.sideGameReceipt.optOutFooter).toContain("{linkOpen}");
      expect(strings.sideGameReceipt.optOutFooter).toContain("{linkClose}");
      expect(strings.sideGameReceipt.optOutFooter).toContain("{orgName}");
    }
  });
});

/**
 * Task #1488 — verify the rest of the receipt body (heading, greeting,
 * table column labels, and trailing boilerplate) also renders in the
 * recipient's preferred language with English fallback. Task #1271 only
 * localised the opt-out footer, which left non-English members seeing a
 * footer in their language but the rest of the receipt in English.
 */
describe("Task #1488 — side-game receipt body and table labels are rendered in the recipient's language", () => {
  it("renders the localised heading and greeting when lang='hi'", async () => {
    await sendSideGameSettlementReceiptEmail({ ...baseOpts, lang: "hi" });
    const mails = captured();
    expect(mails).toHaveLength(1);
    const html = mails[0].html;
    const hi = getCustomDomainEmailStrings("hi");
    // Heading rendered in Hindi (and the English heading is gone).
    expect(html).toContain(hi.sideGameReceipt.heading);
    expect(html).not.toContain(">Payment received<");
    // Greeting rendered in Hindi with the player names spliced into the
    // placeholders. Pull the prefix/suffix around {payer} so we can assert
    // the localised wording without depending on the exact <strong> markup.
    const greetingPrefix = hi.sideGameReceipt.greeting.split("{payer}")[0];
    expect(html).toContain(greetingPrefix.replace("{recipient}", baseOpts.recipientName));
    // Boilerplate rendered in Hindi.
    const boilerplatePrefix = hi.sideGameReceipt.boilerplate.split("{orgName}")[0];
    expect(html).toContain(boilerplatePrefix);
    // Spot-check we did NOT render the English copy that was previously hard-coded.
    expect(html).not.toContain(
      "This is a record of a side-game settlement between players",
    );
  });

  it("renders the localised heading and greeting when lang='es'", async () => {
    await sendSideGameSettlementReceiptEmail({ ...baseOpts, lang: "es" });
    const mails = captured();
    expect(mails).toHaveLength(1);
    const html = mails[0].html;
    const es = getCustomDomainEmailStrings("es");
    expect(html).toContain(es.sideGameReceipt.heading); // "Pago recibido"
    const greetingPrefix = es.sideGameReceipt.greeting.split("{payer}")[0];
    expect(html).toContain(greetingPrefix.replace("{recipient}", baseOpts.recipientName));
    expect(html).not.toContain(">Payment received<");
  });

  it("renders the localised table column labels for non-English recipients", async () => {
    await sendSideGameSettlementReceiptEmail({
      ...baseOpts,
      lang: "fr",
      paymentMethod: "bank_transfer",
      paymentRef: "TXN-12345",
      paidAt: new Date("2026-01-15T12:00:00Z"),
    });
    const mails = captured();
    expect(mails).toHaveLength(1);
    const html = mails[0].html;
    const fr = getCustomDomainEmailStrings("fr");
    // All seven column labels render in French. Wrap each in the surrounding
    // table-cell markup so we don't accidentally match the same word inside
    // the value column.
    for (const label of [
      fr.sideGameReceipt.labelSideGame, // Jeu annexe
      fr.sideGameReceipt.labelFrom,     // De
      fr.sideGameReceipt.labelAmount,   // Montant
      fr.sideGameReceipt.labelCurrency, // Devise
      fr.sideGameReceipt.labelMethod,   // Méthode
      fr.sideGameReceipt.labelReference,// Référence
      fr.sideGameReceipt.labelPaidAt,   // Payé le
    ]) {
      expect(html).toContain(`>${label}</td>`);
    }
    // And the English labels are gone.
    expect(html).not.toContain(">Side game</td>");
    expect(html).not.toContain(">Amount</td>");
    expect(html).not.toContain(">Paid at</td>");
  });

  it("falls back to English heading/greeting/labels when lang is null", async () => {
    await sendSideGameSettlementReceiptEmail({
      ...baseOpts,
      lang: null,
      paymentMethod: "upi",
      paymentRef: "REF-1",
      paidAt: new Date("2026-01-15T12:00:00Z"),
    });
    const mails = captured();
    expect(mails).toHaveLength(1);
    const html = mails[0].html;
    expect(html).toContain(">Payment received<");
    expect(html).toContain(`Hi ${baseOpts.recipientName}, `);
    expect(html).toContain(
      "This is a record of a side-game settlement between players",
    );
    expect(html).toContain(">Side game</td>");
    expect(html).toContain(">From</td>");
    expect(html).toContain(">Amount</td>");
    expect(html).toContain(">Currency</td>");
    expect(html).toContain(">Method</td>");
    expect(html).toContain(">Reference</td>");
    expect(html).toContain(">Paid at</td>");
  });

  it("ships heading/greeting/boilerplate/labels for every supported language with required placeholders", () => {
    for (const lang of CUSTOM_DOMAIN_EMAIL_LANGS) {
      const sgr = getCustomDomainEmailStrings(lang).sideGameReceipt;
      expect(sgr.heading.length).toBeGreaterThan(0);
      expect(sgr.greeting.length).toBeGreaterThan(0);
      expect(sgr.boilerplate.length).toBeGreaterThan(0);
      // Greeting must keep all three identity placeholders so the mailer
      // can splice the player names in without losing them.
      expect(sgr.greeting).toContain("{recipient}");
      expect(sgr.greeting).toContain("{payer}");
      expect(sgr.greeting).toContain("{gameLabel}");
      // Boilerplate must keep {orgName} so each translation can address
      // members back to the correct club.
      expect(sgr.boilerplate).toContain("{orgName}");
      // All seven column labels must be non-empty.
      expect(sgr.labelSideGame.length).toBeGreaterThan(0);
      expect(sgr.labelFrom.length).toBeGreaterThan(0);
      expect(sgr.labelAmount.length).toBeGreaterThan(0);
      expect(sgr.labelCurrency.length).toBeGreaterThan(0);
      expect(sgr.labelMethod.length).toBeGreaterThan(0);
      expect(sgr.labelReference.length).toBeGreaterThan(0);
      expect(sgr.labelPaidAt.length).toBeGreaterThan(0);
    }
  });
});

/**
 * Task #1827 — verify the subject line is also localised. Tasks #1271 and
 * #1488 left a hard-coded English subject (`You were paid …`) in the
 * mailer, so non-English members saw an English subject in their inbox
 * preview before opening the (otherwise localised) body.
 */
describe("Task #1827 — side-game receipt subject line is rendered in the recipient's language", () => {
  it("renders the localised subject when lang='hi'", async () => {
    await sendSideGameSettlementReceiptEmail({ ...baseOpts, lang: "hi" });
    const mails = captured();
    expect(mails).toHaveLength(1);
    const hi = getCustomDomainEmailStrings("hi");
    const expected = fmtTemplate(hi.sideGameReceipt.subject, {
      currencySymbol: baseOpts.currencySymbol,
      amount: baseOpts.amount,
      gameLabel: baseOpts.gameLabel,
      orgName: ORG,
    });
    expect(mails[0].subject).toBe(expected);
    // Sanity: the original hard-coded English subject is no longer used.
    expect(mails[0].subject).not.toContain("You were paid");
    // The amount/game/org all survive interpolation.
    expect(mails[0].subject).toContain("₹500.00");
    expect(mails[0].subject).toContain("Wolf");
    expect(mails[0].subject).toContain(ORG);
  });

  it("renders the localised subject when lang='es'", async () => {
    await sendSideGameSettlementReceiptEmail({ ...baseOpts, lang: "es" });
    const mails = captured();
    expect(mails).toHaveLength(1);
    const es = getCustomDomainEmailStrings("es");
    const expected = fmtTemplate(es.sideGameReceipt.subject, {
      currencySymbol: baseOpts.currencySymbol,
      amount: baseOpts.amount,
      gameLabel: baseOpts.gameLabel,
      orgName: ORG,
    });
    expect(mails[0].subject).toBe(expected);
    expect(mails[0].subject).toContain("Recibiste");
    expect(mails[0].subject).not.toContain("You were paid");
  });

  it("falls back to the English subject when lang is null", async () => {
    await sendSideGameSettlementReceiptEmail({ ...baseOpts, lang: null });
    const mails = captured();
    expect(mails).toHaveLength(1);
    expect(mails[0].subject).toBe(
      `You were paid ${baseOpts.currencySymbol}${baseOpts.amount} for ${baseOpts.gameLabel} (${ORG})`,
    );
  });

  it("falls back to the English subject for an unsupported language code", async () => {
    await sendSideGameSettlementReceiptEmail({
      ...baseOpts,
      lang: "xx-not-a-real-lang",
    });
    const mails = captured();
    expect(mails).toHaveLength(1);
    expect(mails[0].subject).toBe(
      `You were paid ${baseOpts.currencySymbol}${baseOpts.amount} for ${baseOpts.gameLabel} (${ORG})`,
    );
  });

  it("ships a non-empty subject with all four placeholders for every supported language", () => {
    for (const lang of CUSTOM_DOMAIN_EMAIL_LANGS) {
      const sgr = getCustomDomainEmailStrings(lang).sideGameReceipt;
      expect(sgr.subject.length).toBeGreaterThan(0);
      // Every translation must keep the four placeholders so the mailer
      // can splice the amount, game, and club name in without losing them.
      expect(sgr.subject).toContain("{currencySymbol}");
      expect(sgr.subject).toContain("{amount}");
      expect(sgr.subject).toContain("{gameLabel}");
      expect(sgr.subject).toContain("{orgName}");
    }
  });
});
