/**
 * Task #1522 — `buildSideGameReceiptDigestEmailContent` translates the
 * stuck side-game receipts digest email (Task #1290) into the org's
 * preferred language, falling back to English when no `lang` is supplied
 * or the code is unsupported.
 *
 * Mirrors `wallet-topup-refund-email-content.test.ts` (Task #1232) so a
 * future regression in the mailer's i18n wiring is caught at the mailer
 * level, not just inside the i18n pack module.
 */
import { describe, it, expect } from "vitest";
import { buildSideGameReceiptDigestEmailContent } from "../lib/mailer.js";

const PERIOD_START = new Date("2026-03-09T00:00:00Z");
const PERIOD_END = new Date("2026-03-16T00:00:00Z");

describe("buildSideGameReceiptDigestEmailContent — English fallback", () => {
  it("matches the original Task #1290 subject + footer when lang is omitted", () => {
    const { subject, html, filename } = buildSideGameReceiptDigestEmailContent({
      orgName: "Acme Golf Club",
      frequency: "weekly",
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      rowCount: 4,
      exhaustedCount: 3,
      skippedCount: 1,
    });

    expect(subject).toBe("Weekly stuck side-game receipts — 4 need follow-up (Acme Golf Club)");
    expect(filename).toBe("stuck-side-game-receipts-2026-03-16.csv");
    expect(html).toContain("Weekly stuck-receipt digest");
    // Org name still wrapped in the highlight <strong> the original copy used.
    expect(html).toContain('<strong style="color:#fff;">Acme Golf Club</strong>');
    expect(html).toContain("Period");
    expect(html).toContain("Cadence");
    expect(html).toContain("Retries exhausted");
    expect(html).toContain("Permanently skipped");
    expect(html).toContain("Total stuck rows");
    expect(html).toContain("Stuck side-game receipts");
    expect(html).toContain("This digest is sent on a schedule by KHARAGOLF");
    // English locale formats March 9, 2026 with the long month name.
    expect(html).toContain("March 9, 2026");
    expect(html).toContain("March 16, 2026");
  });

  it("falls back to English when the lang code is unsupported", () => {
    const { subject, html } = buildSideGameReceiptDigestEmailContent({
      orgName: "Acme",
      frequency: "daily",
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      rowCount: 0,
      exhaustedCount: 0,
      skippedCount: 0,
      lang: "klingon",
    });
    // Unknown locale code → English subject + body. Task #1878 prefixes
    // the empty-state subject with `[clean]` so support inboxes can
    // visually distinguish (and email-filter) a clean week from a
    // stuck-row digest.
    expect(subject).toBe("[clean] Daily stuck side-game receipts — none for Acme");
    expect(html).toContain("Daily stuck-receipt digest");
    expect(html).toContain("Good news");
    expect(html).toContain("This digest is sent on a schedule by KHARAGOLF");
  });

  it("falls back to English when lang is null", () => {
    // The runtime may pass either `undefined` (no key) or `null` (org has
    // no `defaultLanguage` configured) — both must resolve to English.
    const { subject } = buildSideGameReceiptDigestEmailContent({
      orgName: "Acme",
      frequency: "weekly",
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      rowCount: 2,
      exhaustedCount: 1,
      skippedCount: 1,
      lang: null,
    });
    expect(subject).toBe("Weekly stuck side-game receipts — 2 need follow-up (Acme)");
  });
});

describe("buildSideGameReceiptDigestEmailContent — translated locale", () => {
  it("renders subject + body in Hindi when lang='hi'", () => {
    const { subject, html, filename } = buildSideGameReceiptDigestEmailContent({
      orgName: "Acme Golf Club",
      frequency: "weekly",
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      rowCount: 5,
      exhaustedCount: 3,
      skippedCount: 2,
      lang: "hi",
    });

    expect(subject).toContain("Acme Golf Club");
    expect(subject).toContain("साप्ताहिक");
    expect(subject).toContain("5");
    // Filename stays English (it's a date-stamped CSV name).
    expect(filename).toBe("stuck-side-game-receipts-2026-03-16.csv");
    // Translated heading + body labels.
    expect(html).toContain("साप्ताहिक अटकी-रसीद डाइजेस्ट");
    expect(html).toContain("अवधि");
    expect(html).toContain("आवृत्ति");
    expect(html).toContain("पुनः-प्रयास समाप्त");
    expect(html).toContain("स्थायी रूप से छोड़ा गया");
    expect(html).toContain("कुल अटकी पंक्तियाँ");
    // Translated cadence value rendered in the cadence row (no longer the
    // raw English "Weekly" word in that cell).
    expect(html).toContain(">साप्ताहिक<");
    // Org name still wrapped in the highlight <strong> inside the
    // translated intro paragraph.
    expect(html).toContain('<strong style="color:#fff;">Acme Golf Club</strong>');
    // Footer translated with the panel-name crumb localised.
    expect(html).toContain("KHARAGOLF");
    expect(html).toContain("अटकी हुई साइड-गेम रसीदें");
  });

  it("HTML-escapes the org name inside the translated intro paragraph", () => {
    const { subject, html } = buildSideGameReceiptDigestEmailContent({
      orgName: "<Evil> & Co",
      frequency: "weekly",
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      rowCount: 1,
      exhaustedCount: 1,
      skippedCount: 0,
      lang: "en",
    });
    // Subject is a plain-text mail header — raw org name passes through.
    expect(subject).toBe("Weekly stuck side-game receipts — 1 need follow-up (<Evil> & Co)");
    // Inside the intro paragraph the org name MUST be HTML-escaped (still
    // wrapped in the highlight <strong>) so a hostile name can't inject
    // markup into the rendered email body. Task #1887 also extended the
    // same escaping to the shared `headerHtml` helper — see
    // `branded-header-html-escape.test.ts` for that side of the fix.
    expect(html).toContain('<strong style="color:#fff;">&lt;Evil&gt; &amp; Co</strong>');
    // The header strip rendered by `headerHtml` now also escapes the
    // brand name, so the same hostile string surfaces inside the
    // header `<h1>` without leaking raw markup.
    expect(html).toContain('>&lt;Evil&gt; &amp; Co</h1>');
    expect(html).not.toMatch(/<h1[^>]*><Evil>/);
  });

  it("uses the empty-state subject + intro when rowCount is zero in a translated locale", () => {
    const { subject, html } = buildSideGameReceiptDigestEmailContent({
      orgName: "Club Demo",
      frequency: "daily",
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      rowCount: 0,
      exhaustedCount: 0,
      skippedCount: 0,
      lang: "es",
    });
    // Spanish empty-day subject — pre-substituted with the org name and
    // prefixed with the universal `[clean]` filter token from Task #1878
    // so admins can sort calm digests apart from stuck-row ones in any
    // locale.
    expect(subject).toBe("[clean] Recibos de juego paralelo atascados — diario, ninguno para Club Demo");
    expect(html).toContain("Resumen diario de recibos atascados");
    expect(html).toContain("Buenas noticias");
  });
});

describe("buildSideGameReceiptDigestEmailContent — Task #1878 clean-vs-stuck tone", () => {
  it("renders a calm reassurance card when rowCount === 0", () => {
    const { subject, html } = buildSideGameReceiptDigestEmailContent({
      orgName: "Acme Golf Club",
      frequency: "weekly",
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      rowCount: 0,
      exhaustedCount: 0,
      skippedCount: 0,
    });
    // Subject is prefixed with `[clean]` — the at-a-glance signal a
    // support inbox can both see and email-filter on.
    expect(subject).toBe("[clean] Weekly stuck side-game receipts — none for Acme Golf Club");
    // Body opts into the clean-week tone: emerald accent border on the
    // info card, sky/emerald heading colour, and a `data-clean-week`
    // hook on the outer wrapper so end-to-end tests can assert the tone
    // without sniffing colours.
    expect(html).toContain('data-clean-week="true"');
    expect(html).toContain("border-left:4px solid #34d399");
    expect(html).toContain("color:#a7f3d0");
    // The empty-state intro paragraph from the i18n pack still drives
    // the reassurance copy (no need to invent a new translated string).
    expect(html).toContain("Good news");
    // Alarming exhausted/skipped/total rows are dropped — their values
    // would all be zero anyway and the red/amber styling reads as a
    // false alarm. The replacement row uses the existing translated
    // `Total stuck rows` label with a green check + 0 instead.
    expect(html).not.toContain("Retries exhausted");
    expect(html).not.toContain("Permanently skipped");
    expect(html).toContain("Total stuck rows");
    expect(html).toContain("✓ 0");
    // Period + cadence rows remain so the digest still documents which
    // window was scanned.
    expect(html).toContain("Period");
    expect(html).toContain("Cadence");
  });

  it("keeps the stuck-row tone (no `[clean]` prefix, red/amber counts) when rowCount > 0", () => {
    const { subject, html } = buildSideGameReceiptDigestEmailContent({
      orgName: "Acme Golf Club",
      frequency: "weekly",
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      rowCount: 4,
      exhaustedCount: 3,
      skippedCount: 1,
    });
    expect(subject).toBe("Weekly stuck side-game receipts — 4 need follow-up (Acme Golf Club)");
    expect(subject).not.toContain("[clean]");
    expect(html).toContain('data-clean-week="false"');
    // No emerald accent strip on the stuck digest — keeps the dark card
    // styling shipped in Task #1290 / #1522.
    expect(html).not.toContain("border-left:4px solid #34d399");
    expect(html).not.toContain("✓ 0");
    // The full counts table is still rendered with its original
    // red/amber emphasis.
    expect(html).toContain("Retries exhausted");
    expect(html).toContain("Permanently skipped");
    expect(html).toContain("Total stuck rows");
    expect(html).toContain("color:#f87171");
    expect(html).toContain("color:#fbbf24");
  });

  it("applies the `[clean]` prefix and emerald body to translated empty digests too", () => {
    // Sanity-check that the tone signals are language-neutral — the
    // wrapper hook + emerald accent + `[clean]` prefix all show up
    // regardless of the org's `defaultLanguage`. Picks Hindi because
    // the existing test surface already exercises Hindi.
    const { subject, html } = buildSideGameReceiptDigestEmailContent({
      orgName: "Acme Golf Club",
      frequency: "weekly",
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      rowCount: 0,
      exhaustedCount: 0,
      skippedCount: 0,
      lang: "hi",
    });
    expect(subject.startsWith("[clean] ")).toBe(true);
    expect(subject).toContain("साप्ताहिक");
    expect(html).toContain('data-clean-week="true"');
    expect(html).toContain("border-left:4px solid #34d399");
    expect(html).toContain("✓ 0");
    // Translated `Total stuck rows` label still surfaces in the green
    // replacement row.
    expect(html).toContain("कुल अटकी पंक्तियाँ");
  });
});
