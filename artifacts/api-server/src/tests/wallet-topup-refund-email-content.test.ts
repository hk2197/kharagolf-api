/**
 * Task #1232 — `buildWalletTopupRefundScheduleEmailContent` translates the
 * wallet auto-refund digest email (Task #1073) into the org's preferred
 * language, falling back to English when no `lang` is supplied or the code
 * is unsupported.
 *
 * Pinpoints the rendered subject, body labels, and period date formatting
 * for both the EN-fallback and a translated locale (Hindi) so a future
 * regression in the i18n wiring is caught at the mailer level.
 */
import { describe, it, expect } from "vitest";
import { buildWalletTopupRefundScheduleEmailContent } from "../lib/mailer.js";
import { translateWalletTopupRefundCsvHeaders } from "../lib/walletTopupRefundDigestI18n.js";

const PERIOD_START = new Date("2026-03-09T00:00:00Z");
const PERIOD_END = new Date("2026-03-16T00:00:00Z");

describe("buildWalletTopupRefundScheduleEmailContent — English fallback", () => {
  it("matches the original Task #1073 subject + footer when lang is omitted", () => {
    const { subject, html, filename } = buildWalletTopupRefundScheduleEmailContent({
      orgName: "Acme Golf Club",
      frequency: "weekly",
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      rowCount: 3,
      currencyCount: 2,
    });

    expect(subject).toBe("Acme Golf Club — Weekly wallet auto-refund digest");
    expect(filename).toBe("wallet-topup-refunds-2026-03-16.csv");
    expect(html).toContain("Weekly digest attached");
    // Org name still wrapped in the highlight <strong> the original copy used.
    expect(html).toContain('<strong style="color:#fff;">Acme Golf Club</strong>');
    expect(html).toContain("Period");
    expect(html).toContain("Cadence");
    expect(html).toContain("Currencies in this file");
    expect(html).toContain("Refunds in this file");
    expect(html).toContain("Generated automatically by KHARAGOLF");
    expect(html).toContain("Finance → Auto-refunded wallet top-ups");
    // English locale formats March 9, 2026 with the long month name.
    expect(html).toContain("March 9, 2026");
    expect(html).toContain("March 16, 2026");
  });

  it("renders the CSV column headers in English when lang is omitted or unsupported", () => {
    // Task #1435 — the digest's attached
    // `wallet-topup-refunds-YYYY-MM-DD.csv` ships translated column header
    // labels. The EN pack is also the fallback for unsupported codes,
    // matching the email body's `resolveWalletTopupRefundDigestLang`
    // behaviour. Column *order* must stay stable for downstream parsers.
    const expected = [
      "Refunded at",
      "Member ID",
      "Member name",
      "Member email",
      "Amount",
      "Currency",
      "Payment ID",
      "Order ID",
      "Note",
    ];
    expect(translateWalletTopupRefundCsvHeaders(null)).toEqual(expected);
    expect(translateWalletTopupRefundCsvHeaders("en")).toEqual(expected);
    expect(translateWalletTopupRefundCsvHeaders("klingon")).toEqual(expected);
  });

  it("falls back to English when the lang code is unsupported", () => {
    const { subject, html } = buildWalletTopupRefundScheduleEmailContent({
      orgName: "Acme",
      frequency: "monthly",
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      rowCount: 0,
      currencyCount: 0,
      lang: "klingon",
    });
    expect(subject).toBe("Acme — Monthly wallet auto-refund digest");
    expect(html).toContain("Monthly digest attached");
  });
});

describe("buildWalletTopupRefundScheduleEmailContent — translated locale", () => {
  it("renders subject + body in Hindi when lang='hi'", () => {
    const { subject, html, filename } = buildWalletTopupRefundScheduleEmailContent({
      orgName: "Acme Golf Club",
      frequency: "monthly",
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      rowCount: 5,
      currencyCount: 3,
      lang: "hi",
    });

    expect(subject).toContain("Acme Golf Club");
    expect(subject).toContain("मासिक");
    expect(subject).toContain("वॉलेट ऑटो-रिफंड डाइजेस्ट");
    // Filename stays English (it's a date-stamped CSV name).
    expect(filename).toBe("wallet-topup-refunds-2026-03-16.csv");
    // Translated heading + labels.
    expect(html).toContain("मासिक डाइजेस्ट संलग्न है");
    expect(html).toContain("अवधि");
    expect(html).toContain("आवृत्ति");
    expect(html).toContain("इस फ़ाइल में मुद्राएँ");
    expect(html).toContain("इस फ़ाइल में रिफंड");
    // Translated cadence value rendered in the cadence row (no longer the
    // raw English "monthly" word).
    expect(html).toContain(">मासिक<");
    expect(html).not.toContain(">monthly<");
    // Org name still wrapped in the highlight strong inside the translated
    // intro paragraph.
    expect(html).toContain('<strong style="color:#fff;">Acme Golf Club</strong>');
    // Footer translated with the Finance → … crumb localised.
    expect(html).toContain("KHARAGOLF");
    expect(html).toContain("ऑटो-रिफंड किए गए वॉलेट टॉप-अप");
  });

  it("renders the CSV column headers in Hindi when lang='hi'", () => {
    // Task #1435 — the digest's attached
    // `wallet-topup-refunds-YYYY-MM-DD.csv` ships translated column header
    // labels alongside the localised email body. Column *order* is fixed so
    // any downstream parser that keys off position keeps working.
    const headers = translateWalletTopupRefundCsvHeaders("hi");
    expect(headers).toEqual([
      "रिफंड तिथि",
      "सदस्य आईडी",
      "सदस्य का नाम",
      "सदस्य ईमेल",
      "राशि",
      "मुद्रा",
      "भुगतान आईडी",
      "ऑर्डर आईडी",
      "टिप्पणी",
    ]);
  });

  it("HTML-escapes the org name inside the translated intro paragraph", () => {
    const { subject, html } = buildWalletTopupRefundScheduleEmailContent({
      orgName: "<Evil> & Co",
      frequency: "weekly",
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      rowCount: 1,
      currencyCount: 1,
      lang: "en",
    });
    // Subject is a plain-text mail header — raw org name passes through.
    expect(subject).toBe("<Evil> & Co — Weekly wallet auto-refund digest");
    // Inside the intro paragraph the org name MUST be HTML-escaped (still
    // wrapped in the highlight <strong>) so a hostile name can't inject
    // markup into the rendered email body.
    expect(html).toContain('<strong style="color:#fff;">&lt;Evil&gt; &amp; Co</strong>');
  });
});
