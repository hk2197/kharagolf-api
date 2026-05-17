/**
 * Task #1069 — auto-refund notice i18n.
 *
 * Verifies translation packs cover all 21 supported languages and that
 * locale-aware currency formatting kicks in.
 */
import { describe, it, expect } from "vitest";
import {
  WALLET_REFUND_LANGS,
  formatRefundAmount,
  resolveWalletRefundLang,
  translateWalletRefund,
} from "../walletRefundI18n.js";

describe("walletRefundI18n", () => {
  it("exposes 21 supported languages including hi/ar/zh/ja", () => {
    expect(WALLET_REFUND_LANGS).toHaveLength(21);
    for (const code of ["en", "hi", "ar", "zh", "ja", "es", "fr"]) {
      expect(WALLET_REFUND_LANGS).toContain(code);
    }
  });

  it("falls back to English for unknown / null languages", () => {
    expect(resolveWalletRefundLang(null)).toBe("en");
    expect(resolveWalletRefundLang("klingon")).toBe("en");
    expect(resolveWalletRefundLang("hi")).toBe("hi");
  });

  it("formats INR with the recipient's locale grouping", () => {
    const en = formatRefundAmount(1234.5, "INR", "en", "₹");
    const hi = formatRefundAmount(1234.5, "INR", "hi", "₹");
    expect(en).toMatch(/1,234\.50/);
    // hi-IN uses the Indian lakh grouping (1,234.50 here, but with a
    // narrow no-break space before the symbol on some Node ICU builds).
    expect(hi).toMatch(/1,234\.50/);
  });

  it("formats EUR with German digit grouping & symbol placement", () => {
    const de = formatRefundAmount(1234.5, "EUR", "de", "€");
    expect(de).toMatch(/1\.234,50/);
    expect(de).toContain("€");
  });

  it("falls back to symbol+amount when locale formatting throws", () => {
    // An invalid currency code makes Intl throw RangeError.
    const out = formatRefundAmount(12.3, "??", "en", "X");
    expect(out).toBe("X12.30");
  });

  it("translates push + email + in-app strings into the target language", () => {
    const tx = translateWalletRefund("hi", {
      name: "Asha",
      amount: "₹1,234.50",
      orgName: "KHARAGOLF",
      refundId: "rfnd_123",
    });
    expect(tx.pushTitle).toContain("रिफंड");
    expect(tx.pushBody).toContain("₹1,234.50");
    expect(tx.inAppBody).toContain("रिफंड संदर्भ: rfnd_123");
    expect(tx.emailSubject).toContain("KHARAGOLF");
    expect(tx.emailIntroHtml).toContain("Asha");
    expect(tx.emailIntroHtml).toContain("KHARAGOLF");
    // Footer template should have its {orgName} replaced.
    expect(tx.emailFooter).toContain("KHARAGOLF");
    expect(tx.emailFooter).not.toContain("{orgName}");
  });

  it("produces a non-empty SMS/WhatsApp short body with localized push title + body", () => {
    // Mirrors how walletTopupRefundNotify.ts builds shortBody for the
    // SMS/WhatsApp channels — guards against the previous regression
    // where the SMS body referenced removed `title`/`body` locals.
    const tx = translateWalletRefund("hi", {
      name: "",
      amount: "₹500.00",
      orgName: "",
      refundId: "rfnd_xyz",
    });
    const shortBody = `${tx.pushTitle}\n${tx.inAppBody}`;
    expect(shortBody).toContain("रिफंड");
    expect(shortBody).toContain("₹500.00");
    expect(shortBody).toContain("rfnd_xyz");
    expect(shortBody).not.toMatch(/undefined|\{\w+\}/);
  });

  it("omits the refund-reference suffix when no refund id is present", () => {
    const tx = translateWalletRefund("en", {
      name: "Alex",
      amount: "$25.00",
      orgName: "KHARAGOLF",
      refundId: null,
    });
    expect(tx.inAppBody).not.toContain("Refund reference");
  });

  it("renders structurally complete strings for every supported language", () => {
    for (const code of WALLET_REFUND_LANGS) {
      const tx = translateWalletRefund(code, {
        name: "X",
        amount: "₹100.00",
        orgName: "Org",
        refundId: "r1",
      });
      // Every channel has non-empty copy with no leftover placeholders.
      const fields = [
        tx.pushTitle, tx.pushBody, tx.inAppSubject, tx.inAppBody,
        tx.emailSubject, tx.emailHeaderLabel, tx.emailH2, tx.emailIntroHtml,
        tx.emailLabelAmount, tx.emailLabelCurrency, tx.emailLabelOriginalPayment,
        tx.emailLabelRefundReference, tx.emailFooter,
      ];
      for (const f of fields) {
        expect(f.length).toBeGreaterThan(0);
        expect(f).not.toMatch(/\{name\}|\{amount\}|\{orgName\}|\{days\}|\{refundId\}/);
      }
    }
  });
});
