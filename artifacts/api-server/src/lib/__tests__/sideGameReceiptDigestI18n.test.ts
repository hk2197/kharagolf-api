/**
 * Task #1522 — Stuck side-game receipt digest email i18n.
 *
 * Verifies the translation pack (used by
 * `buildSideGameReceiptDigestEmailContent` in `mailer.ts`) covers all 21
 * supported languages, falls back to English for unknown codes, and
 * substitutes the `{orgName}` / `{count}` placeholders consistently.
 *
 * Mirrors `walletTopupRefundDigestI18n.test.ts` (Task #1232) so the two
 * digests share their pack-coverage contract.
 */
import { describe, it, expect } from "vitest";
import {
  SIDE_GAME_RECEIPT_DIGEST_LANGS,
  resolveSideGameReceiptDigestLang,
  translateSideGameReceiptDigest,
} from "../sideGameReceiptDigestI18n.js";

describe("sideGameReceiptDigestI18n", () => {
  it("exposes 21 supported languages including hi/ar/zh/ja", () => {
    expect(SIDE_GAME_RECEIPT_DIGEST_LANGS).toHaveLength(21);
    for (const code of ["en", "hi", "ar", "zh", "ja", "es", "fr", "de", "pt"]) {
      expect(SIDE_GAME_RECEIPT_DIGEST_LANGS).toContain(code);
    }
  });

  it("falls back to English for unknown / null languages", () => {
    expect(resolveSideGameReceiptDigestLang(null)).toBe("en");
    expect(resolveSideGameReceiptDigestLang(undefined)).toBe("en");
    expect(resolveSideGameReceiptDigestLang("klingon")).toBe("en");
    expect(resolveSideGameReceiptDigestLang("hi")).toBe("hi");
  });

  it("renders the original English subject + footer when lang is unknown", () => {
    const tx = translateSideGameReceiptDigest("klingon", {
      orgName: "Acme Golf Club",
      frequency: "weekly",
      rowCount: 3,
    });
    expect(tx.subject).toBe("Weekly stuck side-game receipts — 3 need follow-up (Acme Golf Club)");
    expect(tx.heading).toBe("Weekly stuck-receipt digest");
    expect(tx.headerLabel).toBe("Stuck side-game receipts");
    expect(tx.cadenceLabel).toBe("Weekly");
    expect(tx.labelExhausted).toBe("Retries exhausted");
    expect(tx.labelSkipped).toBe("Permanently skipped");
    expect(tx.labelTotal).toBe("Total stuck rows");
    expect(tx.footer).toContain("KHARAGOLF");
    expect(tx.footer).toContain("Stuck side-game receipts");
    expect(tx.dateLocale).toBe("en-US");
  });

  it("uses the empty subject variant when rowCount is zero", () => {
    const tx = translateSideGameReceiptDigest("en", {
      orgName: "Acme",
      frequency: "daily",
      rowCount: 0,
    });
    expect(tx.subject).toBe("Daily stuck side-game receipts — none for Acme");
    // Empty intro template (still has the `{orgName}` placeholder for the
    // mailer to wrap) reflects the "good news" copy.
    expect(tx.introTemplate).toContain("Good news");
    expect(tx.introTemplate).toContain("{orgName}");
  });

  it("switches all visible strings + date locale when lang resolves", () => {
    const tx = translateSideGameReceiptDigest("hi", {
      orgName: "Acme Golf Club",
      frequency: "weekly",
      rowCount: 5,
    });
    // Subject pre-substitutes the raw org name + count (it's a plain-text header).
    expect(tx.subject).toContain("Acme Golf Club");
    expect(tx.subject).toContain("साप्ताहिक");
    expect(tx.subject).toContain("5");
    expect(tx.heading).toBe("साप्ताहिक अटकी-रसीद डाइजेस्ट");
    expect(tx.cadenceLabel).toBe("साप्ताहिक");
    // Intro template keeps the {orgName} placeholder intact so the mailer
    // can HTML-escape the surrounding text and re-wrap the org in <strong>.
    expect(tx.introTemplate).toContain("{orgName}");
    expect(tx.labelPeriod).toBe("अवधि");
    expect(tx.labelExhausted).toBe("पुनः-प्रयास समाप्त");
    expect(tx.dateLocale).toBe("hi-IN");
  });

  it("uses the daily subject + heading when frequency is daily", () => {
    const tx = translateSideGameReceiptDigest("es", {
      orgName: "Club Demo",
      frequency: "daily",
      rowCount: 7,
    });
    expect(tx.subject).toBe("Recibos de juego paralelo atascados — diario, 7 requieren seguimiento (Club Demo)");
    expect(tx.heading).toBe("Resumen diario de recibos atascados");
    expect(tx.cadenceLabel).toBe("diario");
  });

  it("uses the weekly subject + heading when frequency is weekly", () => {
    const tx = translateSideGameReceiptDigest("fr", {
      orgName: "Club Demo",
      frequency: "weekly",
      rowCount: 2,
    });
    expect(tx.subject).toBe("Reçus de side-game bloqués — hebdomadaire, 2 à traiter (Club Demo)");
    expect(tx.heading).toBe("Récapitulatif hebdomadaire des reçus bloqués");
    expect(tx.cadenceLabel).toBe("hebdomadaire");
  });

  it("renders structurally complete strings for every supported language", () => {
    for (const code of SIDE_GAME_RECEIPT_DIGEST_LANGS) {
      for (const frequency of ["daily", "weekly"] as const) {
        for (const rowCount of [0, 4]) {
          const tx = translateSideGameReceiptDigest(code, {
            orgName: "Acme",
            frequency,
            rowCount,
          });
          // Resolved strings must not contain any leftover placeholders.
          const resolved = [
            tx.subject, tx.headerLabel, tx.heading,
            tx.labelPeriod, tx.labelCadence, tx.cadenceLabel,
            tx.labelExhausted, tx.labelSkipped, tx.labelTotal,
            tx.footer, tx.dateLocale,
          ];
          for (const f of resolved) {
            expect(f.length).toBeGreaterThan(0);
            expect(f).not.toMatch(/\{orgName\}|\{frequency\}|\{count\}/);
          }
          // Subject must mention the org (it's pre-substituted).
          expect(tx.subject).toContain("Acme");
          if (rowCount > 0) {
            // Non-empty subject mentions the count.
            expect(tx.subject).toContain(String(rowCount));
          }
          // Intro template must still contain the {orgName} placeholder so
          // the mailer can do its safe substitution + <strong> wrap.
          expect(tx.introTemplate.length).toBeGreaterThan(0);
          expect(tx.introTemplate).toContain("{orgName}");
        }
      }
    }
  });
});
