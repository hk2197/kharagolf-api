/**
 * Task #1232 — Wallet auto-refund digest email i18n.
 *
 * Verifies the new translation pack (used by
 * `buildWalletTopupRefundScheduleEmailContent` in `mailer.ts`) covers all
 * 21 supported languages, falls back to English for unknown codes, and
 * substitutes the `{orgName}` placeholder consistently.
 */
import { describe, it, expect } from "vitest";
import {
  WALLET_TOPUP_REFUND_DIGEST_LANGS,
  resolveWalletTopupRefundDigestLang,
  translateWalletTopupRefundDigest,
} from "../walletTopupRefundDigestI18n.js";

describe("walletTopupRefundDigestI18n", () => {
  it("exposes 21 supported languages including hi/ar/zh/ja", () => {
    expect(WALLET_TOPUP_REFUND_DIGEST_LANGS).toHaveLength(21);
    for (const code of ["en", "hi", "ar", "zh", "ja", "es", "fr", "de", "pt"]) {
      expect(WALLET_TOPUP_REFUND_DIGEST_LANGS).toContain(code);
    }
  });

  it("falls back to English for unknown / null languages", () => {
    expect(resolveWalletTopupRefundDigestLang(null)).toBe("en");
    expect(resolveWalletTopupRefundDigestLang(undefined)).toBe("en");
    expect(resolveWalletTopupRefundDigestLang("klingon")).toBe("en");
    expect(resolveWalletTopupRefundDigestLang("hi")).toBe("hi");
  });

  it("renders the original English subject and footer when lang is unknown", () => {
    const tx = translateWalletTopupRefundDigest("klingon", {
      orgName: "Acme Golf Club",
      frequency: "weekly",
    });
    expect(tx.subject).toBe("Acme Golf Club — Weekly wallet auto-refund digest");
    expect(tx.heading).toBe("Weekly digest attached");
    expect(tx.headerLabel).toBe("Wallet auto-refunds");
    expect(tx.cadenceLabel).toBe("weekly");
    expect(tx.footer).toContain("Generated automatically by KHARAGOLF");
    expect(tx.footer).toContain("Finance → Auto-refunded wallet top-ups");
    expect(tx.dateLocale).toBe("en-US");
  });

  it("switches all visible strings + date locale when lang resolves", () => {
    const tx = translateWalletTopupRefundDigest("hi", {
      orgName: "Acme Golf Club",
      frequency: "monthly",
    });
    // Subject pre-substitutes the raw org name (it's a plain-text header).
    expect(tx.subject).toContain("Acme Golf Club");
    expect(tx.subject).toContain("मासिक");
    expect(tx.heading).toBe("मासिक डाइजेस्ट संलग्न है");
    expect(tx.cadenceLabel).toBe("मासिक");
    // Intro template keeps the {orgName} placeholder intact so the mailer
    // can HTML-escape the surrounding text and re-wrap the org in <strong>.
    expect(tx.introTemplate).toContain("{orgName}");
    expect(tx.labelPeriod).toBe("अवधि");
    expect(tx.labelCurrencies).toBe("इस फ़ाइल में मुद्राएँ");
    expect(tx.labelRefunds).toBe("इस फ़ाइल में रिफंड");
    expect(tx.dateLocale).toBe("hi-IN");
  });

  it("uses the weekly subject + heading when frequency is weekly", () => {
    const tx = translateWalletTopupRefundDigest("es", {
      orgName: "Club Demo",
      frequency: "weekly",
    });
    expect(tx.subject).toBe("Club Demo — Resumen semanal de reembolsos automáticos de billetera");
    expect(tx.heading).toBe("Resumen semanal adjunto");
    expect(tx.cadenceLabel).toBe("semanal");
  });

  it("uses the monthly subject + heading when frequency is monthly", () => {
    const tx = translateWalletTopupRefundDigest("fr", {
      orgName: "Club Demo",
      frequency: "monthly",
    });
    expect(tx.subject).toBe("Club Demo — Récapitulatif mensuel des remboursements automatiques de portefeuille");
    expect(tx.heading).toBe("Récapitulatif mensuel en pièce jointe");
    expect(tx.cadenceLabel).toBe("mensuel");
  });

  it("renders structurally complete strings for every supported language", () => {
    for (const code of WALLET_TOPUP_REFUND_DIGEST_LANGS) {
      for (const frequency of ["weekly", "monthly"] as const) {
        const tx = translateWalletTopupRefundDigest(code, {
          orgName: "Acme",
          frequency,
        });
        // Resolved strings must not contain any leftover placeholders.
        const resolved = [
          tx.subject, tx.headerLabel, tx.heading,
          tx.labelPeriod, tx.labelCadence, tx.cadenceLabel,
          tx.labelCurrencies, tx.labelRefunds, tx.footer, tx.dateLocale,
        ];
        for (const f of resolved) {
          expect(f.length).toBeGreaterThan(0);
          expect(f).not.toMatch(/\{orgName\}|\{frequency\}/);
        }
        // Subject must mention the org (it's pre-substituted).
        expect(tx.subject).toContain("Acme");
        // Intro template must still contain the {orgName} placeholder so
        // the mailer can do its safe substitution + <strong> wrap.
        expect(tx.introTemplate.length).toBeGreaterThan(0);
        expect(tx.introTemplate).toContain("{orgName}");
      }
    }
  });
});
