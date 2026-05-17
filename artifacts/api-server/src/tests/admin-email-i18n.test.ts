/**
 * Task #1099 — Verify the rest of the admin transactional emails (bounced
 * levy digest, levy receipts, document-rejected, coach payout-paid) are
 * rendered in the org's `defaultLanguage` with EN fallback.
 *
 * Mirrors the structure of `custom-domain-cert-email-i18n.test.ts`: nodemailer
 * is mocked so we capture the final subject + html for each helper, and we
 * assert the captured payload contains the exact localised strings declared
 * in `adminEmailI18n.ts`. Also verifies fallback behaviour for unsupported
 * language codes.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.hoisted(() => {
  process.env.GMAIL_USER = process.env.GMAIL_USER || "test@example.com";
  process.env.GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD || "test-app-password";
  process.env.EMAIL_PROVIDER = "gmail";
});

const sendMailMock = vi.hoisted(() => vi.fn(async (_opts: { to: string; subject: string; html: string; [k: string]: unknown }) => ({ messageId: "test" })));

vi.mock("nodemailer", () => {
  const transport = { sendMail: sendMailMock };
  return {
    default: { createTransport: () => transport },
    createTransport: () => transport,
  };
});

import {
  sendBouncedLevyDigestEmail,
  sendLevyReceiptEmail,
  sendDocumentRejectedEmail,
  sendCoachPayoutPaidEmail,
} from "../lib/mailer.js";
import {
  getAdminEmailStrings,
  getEmailStrings,
  isSupportedAdminEmailLang,
  type AdminEmailLang,
} from "../lib/adminEmailI18n.js";
import {
  COACH_EARNINGS_TAB_LABEL,
  coachEarningsTabLabel,
} from "@workspace/coach-payout-labels";

interface CapturedMail {
  to: string;
  subject: string;
  html: string;
}

function captured(): CapturedMail[] {
  return sendMailMock.mock.calls.map((c) => ({
    to: c[0]!.to,
    subject: c[0]!.subject,
    html: c[0]!.html,
  }));
}

beforeEach(() => {
  sendMailMock.mockReset();
  sendMailMock.mockResolvedValue({ messageId: "test" });
});

describe("Task #1099 — adminEmailI18n helper", () => {
  it("recognises every supported language code and rejects unknown ones", () => {
    expect(isSupportedAdminEmailLang("en")).toBe(true);
    expect(isSupportedAdminEmailLang("hi")).toBe(true);
    expect(isSupportedAdminEmailLang("zu")).toBe(true);
    expect(isSupportedAdminEmailLang("yo")).toBe(true);
    expect(isSupportedAdminEmailLang("xx")).toBe(false);
    expect(isSupportedAdminEmailLang(null)).toBe(false);
    expect(isSupportedAdminEmailLang(undefined)).toBe(false);
  });

  it("returns the EN pack for unknown / null / undefined language codes without throwing", () => {
    const en = getAdminEmailStrings("en");
    expect(getAdminEmailStrings("xx-not-a-real-lang")).toBe(en);
    expect(getAdminEmailStrings(null)).toBe(en);
    expect(getAdminEmailStrings(undefined)).toBe(en);
    // Same fallback semantics for the per-kind getEmailStrings helper.
    expect(getEmailStrings("xx", "bouncedDigest")).toBe(en.bouncedDigest);
    expect(getEmailStrings(null, "levyReceipt")).toBe(en.levyReceipt);
    expect(getEmailStrings(undefined, "documentRejected")).toBe(en.documentRejected);
    expect(getEmailStrings("xx", "payoutNotify")).toBe(en.payoutNotify);
  });

  it("ships strings for every kind in every language (no missing translations)", () => {
    const langs: AdminEmailLang[] = [
      "en", "hi", "ar", "es", "fr", "de", "pt",
      "ja", "ko", "zh", "th", "ms", "id", "vi",
      "fil", "sw", "af", "am", "ha", "zu", "yo",
    ];
    for (const lang of langs) {
      const pack = getAdminEmailStrings(lang);
      expect(pack.bouncedDigest.heading.length).toBeGreaterThan(0);
      expect(pack.levyReceipt.payment.heading.length).toBeGreaterThan(0);
      expect(pack.levyReceipt.partialPayment.heading.length).toBeGreaterThan(0);
      expect(pack.levyReceipt.refund.heading.length).toBeGreaterThan(0);
      expect(pack.levyReceipt.waiver.heading.length).toBeGreaterThan(0);
      expect(pack.documentRejected.subject.length).toBeGreaterThan(0);
      expect(pack.payoutNotify.heading.length).toBeGreaterThan(0);
    }
  });
});

describe("Task #1099 — sendBouncedLevyDigestEmail renders in lang", () => {
  it("renders Hindi subject + intro + headers when lang='hi'", async () => {
    await sendBouncedLevyDigestEmail({
      to: "admin@example.com",
      staffName: "Asha",
      baseUrl: "https://example.com",
      totalBounced: 3,
      levies: [
        { levyId: 1, name: "Annual subs", currency: "INR", unresolvedFailedCount: 3, channels: { email: 3 }, latestFailureAt: new Date().toISOString(), sampleError: "bounce" },
      ],
      branding: { orgName: "Test Club" },
      lang: "hi",
    });
    const [m] = captured();
    const hi = getEmailStrings("hi", "bouncedDigest");
    expect(m.subject).toBe(hi.subjectMany.replace("{count}", "3").replace("{orgName}", "Test Club"));
    expect(m.html).toContain(hi.heading);
    expect(m.html).toContain(hi.headerTag);
    expect(m.html).toContain(hi.levyHeader);
    expect(m.html).toContain(hi.bouncedHeader);
    // Did NOT render English heading.
    expect(m.html).not.toContain(getEmailStrings("en", "bouncedDigest").heading);
  });

  it("uses the singular subject when totalBounced === 1 (Spanish)", async () => {
    await sendBouncedLevyDigestEmail({
      to: "admin@example.com",
      staffName: "Carlos",
      baseUrl: "https://example.com",
      totalBounced: 1,
      levies: [{ levyId: 1, name: "Cuota", currency: "EUR", unresolvedFailedCount: 1, channels: {}, latestFailureAt: null, sampleError: null }],
      branding: { orgName: "Club Alfa" },
      lang: "es",
    });
    const [m] = captured();
    const es = getEmailStrings("es", "bouncedDigest");
    expect(m.subject).toBe(es.subjectOne.replace("{orgName}", "Club Alfa"));
  });

  it("falls back to English when lang is null or unsupported", async () => {
    await sendBouncedLevyDigestEmail({
      to: "admin@example.com",
      staffName: "Admin",
      baseUrl: "https://example.com",
      totalBounced: 2,
      levies: [{ levyId: 1, name: "X", currency: "USD", unresolvedFailedCount: 2, channels: {}, latestFailureAt: null, sampleError: null }],
      branding: { orgName: "Test Club" },
      lang: "xx-bogus",
    });
    const [m] = captured();
    const en = getEmailStrings("en", "bouncedDigest");
    expect(m.html).toContain(en.heading);
  });
});

describe("Task #1099 — sendLevyReceiptEmail renders in lang per kind", () => {
  for (const kind of ["payment", "partial_payment", "refund", "waiver"] as const) {
    it(`renders Arabic ${kind} receipt`, async () => {
      await sendLevyReceiptEmail({
        to: "member@example.com",
        memberName: "Sami",
        kind,
        levyName: "2026 Annual",
        currency: "USD",
        currencySymbol: "$",
        amount: "100.00",
        newBalance: "0.00",
        note: null,
        branding: { orgName: "Club Beta" },
        lang: "ar",
      });
      const [m] = captured();
      const ar = getEmailStrings("ar", "levyReceipt");
      const ks =
        kind === "payment" ? ar.payment :
        kind === "partial_payment" ? ar.partialPayment :
        kind === "refund" ? ar.refund :
        ar.waiver;
      const expectedSubject = ks.subject.replace("{levyName}", "2026 Annual").replace("{orgName}", "Club Beta");
      expect(m.subject).toBe(expectedSubject);
      expect(m.html).toContain(ks.heading);
      expect(m.html).toContain(ar.headerTag);
      expect(m.html).toContain(ar.levyLabel);
      expect(m.html).toContain(ar.newBalanceLabel);
      expect(m.html).toContain(ar.currencyLabel);
    });
  }

  it("falls back to English for unknown lang", async () => {
    await sendLevyReceiptEmail({
      to: "m@e.com",
      memberName: "X",
      kind: "payment",
      levyName: "L",
      currency: "USD",
      currencySymbol: "$",
      amount: "1.00",
      newBalance: "0.00",
      branding: { orgName: "Org" },
      lang: "qq",
    });
    const [m] = captured();
    expect(m.subject).toContain("Payment receipt");
  });
});

describe("Task #1099 — sendDocumentRejectedEmail renders in lang", () => {
  it("renders French subject + body + reason label", async () => {
    await sendDocumentRejectedEmail({
      to: "member@example.com",
      memberName: "Marie",
      docLabel: "Carte d'identité",
      reason: "Photo trop floue",
      branding: { orgName: "Club Gamma" },
      lang: "fr",
    });
    const [m] = captured();
    const fr = getEmailStrings("fr", "documentRejected");
    expect(m.subject).toContain(fr.subject.replace("{docLabel}", "Carte d'identité"));
    expect(m.html).toContain(fr.reasonLabel);
    expect(m.html).toContain(fr.reupload);
    expect(m.html).toContain(fr.headerTag);
    expect(m.html).toContain("Photo trop floue");
    // EN heading not present.
    expect(m.html).not.toContain(getEmailStrings("en", "documentRejected").reupload);
  });

  it("falls back to English when lang is null", async () => {
    await sendDocumentRejectedEmail({
      to: "m@e.com",
      memberName: "X",
      docLabel: "Driver licence",
      reason: "expired",
      branding: { orgName: "Org" },
      lang: null,
    });
    const [m] = captured();
    expect(m.html).toContain(getEmailStrings("en", "documentRejected").reupload);
  });
});

describe("Task #1484 — payoutNotify footer translates the 'Earnings' tab name", () => {
  // For every non-English language pack the payoutNotify footer must contain
  // a localised label for the Earnings tab, so coaches reading e.g. the Hindi
  // or Japanese version don't see a single bare English word in an otherwise
  // localised email. The English literal "Earnings" is still allowed alongside
  // the translation, so the email continues to match what the coach sees on
  // the (currently English-only) Earnings tab in the coach workspace UI.
  const EXPECTED_LOCALISED_LABEL: Record<Exclude<AdminEmailLang, "en">, string> = {
    hi: "कमाई",
    ar: "الأرباح",
    es: "Ingresos",
    fr: "Revenus",
    de: "Einnahmen",
    pt: "Ganhos",
    ja: "報酬",
    ko: "수익",
    zh: "收益",
    th: "รายได้",
    ms: "Pendapatan",
    id: "Pendapatan",
    vi: "Thu nhập",
    fil: "Kita",
    sw: "Mapato",
    af: "Verdienste",
    am: "ገቢ",
    ha: "Kuɗin Shiga",
    zu: "Inzuzo",
    yo: "Owó-Wíwọlé",
  };

  it("English pack still references the literal 'Earnings' tab", () => {
    const en = getEmailStrings("en", "payoutNotify");
    expect(en.footer).toContain("Earnings");
  });

  for (const [lang, localised] of Object.entries(EXPECTED_LOCALISED_LABEL) as Array<[
    Exclude<AdminEmailLang, "en">,
    string,
  ]>) {
    it(`'${lang}' payoutNotify footer contains the localised tab label '${localised}' before any bare 'Earnings'`, () => {
      const pack = getEmailStrings(lang, "payoutNotify");
      expect(pack.footer).toContain(localised);
      // Guard against a regression where someone "simplifies" the footer back
      // to just the English word "Earnings" — if "Earnings" is present it must
      // appear strictly after the localised label, i.e. as a parenthetical
      // pointer to the (currently English-only) workspace tab, never as the
      // primary label coaches read.
      const localisedIdx = pack.footer.indexOf(localised);
      const englishIdx = pack.footer.indexOf("Earnings");
      expect(localisedIdx).toBeGreaterThanOrEqual(0);
      if (englishIdx >= 0) {
        expect(englishIdx).toBeGreaterThan(localisedIdx);
      }
    });
  }

  it("rendered Hindi payout email contains the localised tab label, not a bare English 'Earnings'", async () => {
    await sendCoachPayoutPaidEmail({
      to: "coach@example.com",
      coachName: "Asha",
      amountPaise: 250000,
      reference: "PAY-HI-1",
      branding: { orgName: "Club Hindi" },
      lang: "hi",
    });
    const [m] = captured();
    const hi = getEmailStrings("hi", "payoutNotify");
    expect(m.html).toContain(hi.footer);
    expect(m.html).toContain("कमाई");
  });

  // Task #1820 — the workspace tab label is now also localised (see
  // `coachEarningsTabLabel` / `COACH_EARNINGS_TAB_LABEL` in
  // `@workspace/coach-payout-labels`). Pin the shared map and the email
  // footer together so a future translation change in one place can't
  // silently drift away from the other.
  describe("Task #1820 — workspace tab label stays in sync with the email footer", () => {
    it("English shared label matches the literal 'Earnings' tab in the EN footer", () => {
      expect(COACH_EARNINGS_TAB_LABEL.en).toBe("Earnings");
      expect(coachEarningsTabLabel("en")).toBe("Earnings");
      const en = getEmailStrings("en", "payoutNotify");
      expect(en.footer).toContain(COACH_EARNINGS_TAB_LABEL.en);
    });

    it("falls back to English for unknown / missing language codes", () => {
      expect(coachEarningsTabLabel(null)).toBe("Earnings");
      expect(coachEarningsTabLabel(undefined)).toBe("Earnings");
      expect(coachEarningsTabLabel("xx")).toBe("Earnings");
    });

    for (const [lang, localised] of Object.entries(EXPECTED_LOCALISED_LABEL) as Array<[
      Exclude<AdminEmailLang, "en">,
      string,
    ]>) {
      it(`'${lang}' shared tab label and email footer share the same localised root '${localised}'`, () => {
        const tabLabel = COACH_EARNINGS_TAB_LABEL[lang];
        // Shared tab label must exist for every language we ship the
        // email in, and must contain the same localised root the email
        // footer uses (so the coach sees "matching" copy in both
        // surfaces). The shared map also keeps the bare English literal
        // as a parenthetical pointer.
        expect(tabLabel).toBeTruthy();
        expect(tabLabel).toContain(localised);
        expect(tabLabel).toContain("Earnings");
        // And the email footer must still contain that same shared
        // localised root — guards against a future translator editing
        // only one of the two surfaces.
        const pack = getEmailStrings(lang, "payoutNotify");
        expect(pack.footer).toContain(localised);
        // Helper resolves to the shared map entry.
        expect(coachEarningsTabLabel(lang)).toBe(tabLabel);
      });
    }
  });
});

describe("Task #1099 — sendCoachPayoutPaidEmail renders in lang", () => {
  it("renders Japanese subject + heading + labels", async () => {
    await sendCoachPayoutPaidEmail({
      to: "coach@example.com",
      coachName: "Yuki",
      amountPaise: 1234500,
      reference: "PAY-XYZ",
      notes: "for review #99",
      branding: { orgName: "Club Delta" },
      lang: "ja",
    });
    const [m] = captured();
    const ja = getEmailStrings("ja", "payoutNotify");
    expect(m.subject).toContain(ja.subject.replace("{amount}", "₹12,345.00").replace("{orgName}", "Club Delta"));
    expect(m.html).toContain(ja.heading);
    expect(m.html).toContain(ja.amountLabel);
    expect(m.html).toContain(ja.referenceLabel);
    expect(m.html).toContain(ja.notesLabel);
    expect(m.html).toContain(ja.eta);
    expect(m.html).toContain(ja.footer);
    expect(m.html).toContain(ja.headerTag);
    // EN heading not rendered.
    expect(m.html).not.toContain(getEmailStrings("en", "payoutNotify").heading);
  });

  it("falls back to English when no lang provided", async () => {
    await sendCoachPayoutPaidEmail({
      to: "coach@example.com",
      coachName: "Yuki",
      amountPaise: 100000,
      reference: "PAY-ABC",
      branding: { orgName: "Club" },
    });
    const [m] = captured();
    expect(m.html).toContain(getEmailStrings("en", "payoutNotify").heading);
  });
});
