/**
 * Task #1269 — wallet withdrawal SMS i18n.
 *
 * Verifies that translation packs cover all 21 supported languages and
 * that processed/failed/reversed bodies render with the expected
 * placeholders filled in.
 */
import { describe, it, expect } from "vitest";
import { WALLET_REFUND_LANGS } from "../walletRefundI18n.js";
import { translateWithdrawalSms } from "../walletWithdrawalI18n.js";

describe("walletWithdrawalI18n", () => {
  it("renders English processed body with UTR appended", () => {
    const tx = translateWithdrawalSms("en", "processed", {
      amount: "₹500.00",
      currency: "INR",
      destination: "UPI alice@upi",
      utr: "UTR123",
    });
    expect(tx.title).toBe("Withdrawal paid: ₹500.00");
    expect(tx.body).toContain("Your withdrawal of ₹500.00 INR");
    expect(tx.body).toContain("UPI alice@upi");
    expect(tx.body).toContain("UTR UTR123.");
  });

  it("renders English failed body with reason and refund clause", () => {
    const tx = translateWithdrawalSms("en", "failed", {
      amount: "₹750.00",
      currency: "INR",
      destination: "bank account ••••1234",
      reason: "Beneficiary bank rejected",
    });
    expect(tx.title).toBe("Withdrawal failed: ₹750.00 refunded");
    expect(tx.body).toContain("could not be processed");
    expect(tx.body).toContain("Reason: Beneficiary bank rejected.");
    expect(tx.body).toMatch(/refunded to your wallet/i);
  });

  it("renders English reversed body using the 'was reversed' verb", () => {
    const tx = translateWithdrawalSms("en", "reversed", {
      amount: "₹620.00",
      currency: "INR",
      destination: "UPI bob@upi",
      reason: "Bank reversed payout",
    });
    expect(tx.title).toBe("Withdrawal reversed: ₹620.00 refunded");
    expect(tx.body).toContain("was reversed");
    expect(tx.body).toContain("Reason: Bank reversed payout.");
  });

  it("translates to Hindi for processed/failed/reversed", () => {
    const processed = translateWithdrawalSms("hi", "processed", {
      amount: "₹500.00",
      currency: "INR",
      destination: "UPI alice@upi",
      utr: "UTR-HI",
    });
    expect(processed.title).toContain("निकासी का भुगतान हुआ");
    expect(processed.body).toContain("₹500.00");
    expect(processed.body).toContain("UTR UTR-HI");

    const failed = translateWithdrawalSms("hi", "failed", {
      amount: "₹750.00",
      currency: "INR",
      destination: "UPI alice@upi",
      reason: "rejected",
    });
    expect(failed.title).toContain("निकासी विफल");
    expect(failed.body).toContain("कारण");

    const reversed = translateWithdrawalSms("hi", "reversed", {
      amount: "₹620.00",
      currency: "INR",
      destination: "UPI alice@upi",
      reason: "reversed",
    });
    expect(reversed.title).toContain("निकासी पलट दी गई");
  });

  it("falls back to English for unknown / null languages", () => {
    const fromUnknown = translateWithdrawalSms("klingon", "processed", {
      amount: "$5.00",
      currency: "USD",
      destination: "bank account ••••0001",
      utr: null,
    });
    const fromNull = translateWithdrawalSms(null, "processed", {
      amount: "$5.00",
      currency: "USD",
      destination: "bank account ••••0001",
      utr: null,
    });
    expect(fromUnknown.title).toBe("Withdrawal paid: $5.00");
    expect(fromNull.title).toBe("Withdrawal paid: $5.00");
  });

  it("omits the UTR / reason suffix when the value is missing", () => {
    const noUtr = translateWithdrawalSms("en", "processed", {
      amount: "₹100.00",
      currency: "INR",
      destination: "UPI x@upi",
      utr: null,
    });
    expect(noUtr.body).not.toMatch(/UTR/);

    const noReason = translateWithdrawalSms("en", "failed", {
      amount: "₹100.00",
      currency: "INR",
      destination: "UPI x@upi",
      reason: null,
    });
    expect(noReason.body).not.toMatch(/Reason/);
  });

  it("uses Ethiopic full stop for the Amharic UTR / reason suffixes", () => {
    const processed = translateWithdrawalSms("am", "processed", {
      amount: "$5.00",
      currency: "USD",
      destination: "bank account ••••0001",
      utr: "UTR-AM",
    });
    expect(processed.body).toContain("UTR UTR-AM።");
    expect(processed.body).not.toMatch(/UTR UTR-AM\./);

    const failed = translateWithdrawalSms("am", "failed", {
      amount: "$5.00",
      currency: "USD",
      destination: "bank account ••••0001",
      reason: "ተቀባዩ ባንክ አልተቀበለውም",
    });
    expect(failed.body).toContain("ምክንያት: ተቀባዩ ባንክ አልተቀበለውም።");
  });

  it("uses gender-neutral plural pronouns and a distinct reversal verb in Hausa", () => {
    const processed = translateWithdrawalSms("ha", "processed", {
      amount: "₦500.00",
      currency: "NGN",
      destination: "bank account ••••0001",
      utr: "UTR-HA",
    });
    expect(processed.body).toContain("kuɗin ku");
    expect(processed.body).toContain("walat ɗinku");
    expect(processed.body).not.toMatch(/kuɗin ka\b/);
    expect(processed.body).not.toMatch(/walat ɗinka\b/);

    const reversed = translateWithdrawalSms("ha", "reversed", {
      amount: "₦500.00",
      currency: "NGN",
      destination: "bank account ••••0001",
      reason: "Bank reversed payout",
    });
    expect(reversed.title).toBe("An soke cire kuɗi: an mayar da ₦500.00");
    expect(reversed.body).toContain("An soke cire kuɗin ku");
    expect(reversed.body).toContain("za ku iya sake gwadawa");
  });

  it("uses a distinct reversal verb (kuhoxisiwe) in Zulu reversed strings", () => {
    const reversed = translateWithdrawalSms("zu", "reversed", {
      amount: "R500.00",
      currency: "ZAR",
      destination: "bank account ••••0001",
      reason: "Bank reversed payout",
    });
    expect(reversed.title).toBe("Ukukhipha kuhoxisiwe: R500.00 kubuyiselwe");
    expect(reversed.body).toContain("kuhoxisiwe.");
    expect(reversed.body).toContain("libuyiselwe esikhwameni sakho");
    expect(reversed.body).not.toMatch(/kubuyiselwe emuva/);
  });

  it("uses 'पलट दी गई' (not 'वापस ली गई') in the Hindi reversed body", () => {
    const reversed = translateWithdrawalSms("hi", "reversed", {
      amount: "₹620.00",
      currency: "INR",
      destination: "UPI alice@upi",
      reason: "Bank reversed payout",
    });
    expect(reversed.body).toContain("पलट दी गई।");
    expect(reversed.body).not.toMatch(/वापस ले ली गई/);
  });

  it("renders structurally complete strings for every supported language", () => {
    for (const code of WALLET_REFUND_LANGS) {
      for (const outcome of ["processed", "failed", "reversed"] as const) {
        const tx = translateWithdrawalSms(code, outcome, {
          amount: "₹100.00",
          currency: "INR",
          destination: "UPI x@upi",
          utr: outcome === "processed" ? "UTR1" : null,
          reason: outcome !== "processed" ? "rejected" : null,
        });
        expect(tx.title.length).toBeGreaterThan(0);
        expect(tx.body.length).toBeGreaterThan(0);
        expect(tx.title).not.toMatch(/\{amount\}|\{currency\}|\{destination\}|\{utr\}|\{reason\}/);
        expect(tx.body).not.toMatch(/\{amount\}|\{currency\}|\{destination\}|\{utr\}|\{reason\}/);
        expect(tx.body).toContain("₹100.00");
      }
    }
  });

  // ─── Task #1826 — WhatsApp channel variants ──────────────────────────
  describe("WhatsApp channel (Task #1826)", () => {
    it("defaults to the SMS variant when channel is omitted", () => {
      const sms = translateWithdrawalSms("en", "failed", {
        amount: "₹500.00",
        currency: "INR",
        destination: "UPI alice@upi",
        reason: "Bank rejected",
      });
      // SMS uses the inline em-dash continuation; no paragraph break.
      expect(sms.body).toContain(" — you can try again");
      expect(sms.body).not.toContain("\n\n");
    });

    it("uses paragraph breaks (no em-dash continuation) on WhatsApp for English failed", () => {
      const wa = translateWithdrawalSms(
        "en",
        "failed",
        {
          amount: "₹500.00",
          currency: "INR",
          destination: "UPI alice@upi",
          reason: "Bank rejected",
        },
        "whatsapp",
      );
      expect(wa.title).toBe("Withdrawal failed: ₹500.00 refunded");
      expect(wa.body).toContain("could not be processed.");
      expect(wa.body).toContain("Reason: Bank rejected.");
      expect(wa.body).toContain("\n\nThe full amount has been refunded");
      expect(wa.body).toContain("You can try again or use a different account.");
      expect(wa.body).not.toMatch(/ — you can try again/);
    });

    it("uses paragraph breaks (no em-dash continuation) on WhatsApp for English reversed", () => {
      const wa = translateWithdrawalSms(
        "en",
        "reversed",
        {
          amount: "₹620.00",
          currency: "INR",
          destination: "UPI bob@upi",
          reason: "Bank reversed payout",
        },
        "whatsapp",
      );
      expect(wa.body).toContain("was reversed.");
      expect(wa.body).toContain("\n\nThe full amount has been refunded");
      expect(wa.body).not.toMatch(/ — you can try again/);
    });

    it("inherits the SMS processed body (already short) on WhatsApp", () => {
      const sms = translateWithdrawalSms("en", "processed", {
        amount: "₹500.00",
        currency: "INR",
        destination: "UPI alice@upi",
        utr: "UTR123",
      });
      const wa = translateWithdrawalSms(
        "en",
        "processed",
        {
          amount: "₹500.00",
          currency: "INR",
          destination: "UPI alice@upi",
          utr: "UTR123",
        },
        "whatsapp",
      );
      expect(wa.body).toBe(sms.body);
      expect(wa.title).toBe(sms.title);
    });

    it("does not change SMS strings — every SMS body is byte-for-byte unchanged when channel='sms'", () => {
      // Snapshot of the SMS bodies as they shipped in Task #1269. Used
      // here to defend against accidentally regressing the SMS pack
      // while editing the WhatsApp overrides.
      const sentinel = translateWithdrawalSms("en", "failed", {
        amount: "₹500.00",
        currency: "INR",
        destination: "UPI alice@upi",
        reason: "Bank rejected",
      });
      expect(sentinel.body).toBe(
        "Your ₹500.00 INR withdrawal to UPI alice@upi could not be processed. Reason: Bank rejected. The full amount has been refunded to your wallet — you can try again or use a different account.",
      );
    });

    it("renders WhatsApp variants for every supported language with no leftover placeholders", () => {
      for (const code of WALLET_REFUND_LANGS) {
        for (const outcome of ["processed", "failed", "reversed"] as const) {
          const tx = translateWithdrawalSms(
            code,
            outcome,
            {
              amount: "₹100.00",
              currency: "INR",
              destination: "UPI x@upi",
              utr: outcome === "processed" ? "UTR1" : null,
              reason: outcome !== "processed" ? "rejected" : null,
            },
            "whatsapp",
          );
          expect(tx.title.length).toBeGreaterThan(0);
          expect(tx.body.length).toBeGreaterThan(0);
          expect(tx.title).not.toMatch(/\{amount\}|\{currency\}|\{destination\}|\{utr\}|\{reason\}/);
          expect(tx.body).not.toMatch(/\{amount\}|\{currency\}|\{destination\}|\{utr\}|\{reason\}/);
          expect(tx.body).toContain("₹100.00");
        }
      }
    });

    it("uses a paragraph break in failed/reversed WhatsApp bodies for every supported language", () => {
      // Native-speaker review universally found the SMS em-dash
      // continuation too terse on WhatsApp; the override should land
      // a paragraph break in every language for failed/reversed.
      for (const code of WALLET_REFUND_LANGS) {
        for (const outcome of ["failed", "reversed"] as const) {
          const tx = translateWithdrawalSms(
            code,
            outcome,
            {
              amount: "₹100.00",
              currency: "INR",
              destination: "UPI x@upi",
              reason: "rejected",
            },
            "whatsapp",
          );
          expect(tx.body).toContain("\n\n");
          // And the SMS-style inline em-dash continuation should be gone.
          expect(tx.body).not.toMatch(/ — /);
          expect(tx.body).not.toMatch(/——/);
        }
      }
    });

    it("falls back to the SMS string when an unknown language is requested via WhatsApp", () => {
      const wa = translateWithdrawalSms(
        "klingon",
        "failed",
        {
          amount: "$5.00",
          currency: "USD",
          destination: "bank account ••••0001",
          reason: "Bank rejected",
        },
        "whatsapp",
      );
      // Resolves to English, then picks the English WhatsApp override.
      expect(wa.body).toContain("\n\nThe full amount has been refunded");
    });

    it("preserves Hindi punctuation (Devanagari danda) in the WhatsApp variant", () => {
      const wa = translateWithdrawalSms(
        "hi",
        "failed",
        {
          amount: "₹500.00",
          currency: "INR",
          destination: "UPI alice@upi",
          reason: "Bank rejected",
        },
        "whatsapp",
      );
      // Failure clause still ends with the danda before the paragraph break.
      expect(wa.body).toMatch(/।\n\n/);
      expect(wa.body).toContain("कारण: Bank rejected।");
    });

    it("preserves Amharic punctuation (Ethiopic full stop) in the WhatsApp variant", () => {
      const wa = translateWithdrawalSms(
        "am",
        "reversed",
        {
          amount: "$5.00",
          currency: "USD",
          destination: "bank account ••••0001",
          reason: "Bank reversed payout",
        },
        "whatsapp",
      );
      expect(wa.body).toMatch(/።\n\n/);
      expect(wa.body).toContain("ምክንያት: Bank reversed payout።");
    });
  });
});
