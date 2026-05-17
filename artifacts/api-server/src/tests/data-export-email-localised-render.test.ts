/**
 * Task #1745 — verify the localised email HTML produced by
 * `sendDataRequestEmail` for the two export-related kinds.
 *
 * The other test (`portal-data-export-notify.test.ts`) mocks
 * `sendDataRequestEmail` to verify the *plumbing* (route → notify →
 * mailer call with the right `lang`). That leaves a small integration
 * gap: nothing exercises the actual mailer template path with a non-
 * English language and asserts that the rendered HTML and subject
 * carry the translated strings. This file fills that gap by stubbing
 * the active mail provider (same pattern as
 * `mailer-org-id-metadata.test.ts`) and capturing the dispatched
 * payload, then asserting against the rendered subject + HTML body
 * for one non-English LTR pack (Hindi) and the only RTL pack (Arabic).
 *
 * If a future refactor wires the wrong arm of the kind switch, drops
 * the `dir`/`lang` HTML attributes, or stops escaping the localised
 * CTA text, this test will fail loudly — without depending on either
 * the route or the notify fan-out.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

import {
  getActiveMailProvider,
  type MailProvider,
  type SendResult,
  type TransactionalEmail,
} from "../lib/email/adapter.js";
import { sendDataRequestEmail } from "../lib/mailer.js";

let captured: TransactionalEmail[] = [];
let originalSend: MailProvider["send"];
let originalConfigured: MailProvider["isConfigured"];

beforeAll(() => {
  const provider = getActiveMailProvider();
  originalSend = provider.send.bind(provider);
  originalConfigured = provider.isConfigured.bind(provider);
  (provider as { isConfigured: MailProvider["isConfigured"] }).isConfigured = () => true;
  (provider as { send: MailProvider["send"] }).send = async (msg) => {
    captured.push(msg);
    return { ok: true, provider: provider.name, messageId: "stub" } satisfies SendResult;
  };
});

afterAll(() => {
  const provider = getActiveMailProvider();
  (provider as { send: MailProvider["send"] }).send = originalSend;
  (provider as { isConfigured: MailProvider["isConfigured"] }).isConfigured = originalConfigured;
});

beforeEach(() => {
  captured = [];
});

describe("sendDataRequestEmail — localised rendered HTML (Task #1745)", () => {
  it("renders the Hindi pack for completed_export end-to-end", async () => {
    await sendDataRequestEmail({
      to: "member@example.test",
      memberName: "Aanya",
      kind: "completed_export",
      requestType: "export",
      requestId: 4242,
      requestedAt: new Date("2026-04-01T10:00:00Z"),
      dueBy: new Date("2026-05-01T10:00:00Z"),
      artifactUrl: "https://storage.example.test/signed?token=abc",
      unsubUrl: "https://app.example.test/data-export-unsub?token=xyz",
      lang: "hi",
      branding: { orgName: "Acme GC", orgId: 99 },
    });

    expect(captured.length).toBe(1);
    const msg = captured[0];

    // Subject is fully translated and carries the reference id.
    expect(msg.subject).toBe("आपका डेटा निर्यात तैयार है (#4242)");

    // Outer block carries lang + dir attrs (Hindi is LTR).
    expect(msg.html).toContain('lang="hi"');
    expect(msg.html).toContain('dir="ltr"');

    // Heading + intro use the Hindi pack's literal copy, with the
    // member name and orgName interpolated.
    expect(msg.html).toContain("आपका डेटा निर्यात डाउनलोड के लिए तैयार है");
    expect(msg.html).toContain("Aanya");
    expect(msg.html).toContain("Acme GC");

    // CTA button + opt-out link both render the Hindi text.
    expect(msg.html).toContain("⬇ मेरा डेटा संग्रह डाउनलोड करें");
    expect(msg.html).toContain("इस डाउनलोड के बारे में मुझे याद न दिलाएँ");

    // The signed download URL is wired into the CTA href, and the
    // one-click opt-out URL is wired into the opt-out anchor.
    expect(msg.html).toContain("https://storage.example.test/signed?token=abc");
    expect(msg.html).toContain("https://app.example.test/data-export-unsub?token=xyz");

    // No leftover English copy from the prior hard-coded template.
    expect(msg.html).not.toContain("Your data export is ready to download");
    expect(msg.html).not.toContain("Don't remind me about this download");

    // Org-id metadata still flows for bounce attribution (Task #1140).
    expect(msg.metadata?.orgId).toBe("99");
  });

  it("renders the Arabic pack for export_expiring with rtl direction", async () => {
    await sendDataRequestEmail({
      to: "member@example.test",
      memberName: "Sara",
      kind: "export_expiring",
      requestType: "export",
      requestId: 7777,
      requestedAt: new Date("2026-04-01T10:00:00Z"),
      dueBy: null,
      artifactUrl: "https://storage.example.test/signed?token=def",
      unsubUrl: "https://app.example.test/data-export-unsub?token=uvw",
      trackingPixelUrl: "https://app.example.test/pixel.gif?token=p1",
      lang: "ar",
      branding: { orgName: "Acme GC", orgId: 11 },
    });

    expect(captured.length).toBe(1);
    const msg = captured[0];

    // Subject is the Arabic reminder string.
    expect(msg.subject).toBe("تذكير: تصدير بياناتك ينتهي قريباً (#7777)");

    // RTL marker is set on the outer block.
    expect(msg.html).toContain('lang="ar"');
    expect(msg.html).toContain('dir="rtl"');

    // Heading + reminder-flavoured opt-out copy from the Arabic pack.
    expect(msg.html).toContain("تصدير بياناتك ينتهي خلال حوالي 24 ساعة");
    expect(msg.html).toContain("توقف عن تذكيري بهذا التنزيل");

    // The reminder uses the amber CTA — pre-existing colour kept after
    // the i18n refactor.
    expect(msg.html).toContain("background:#f59e0b");

    // The 24h-reminder pixel still renders (Task #1124).
    expect(msg.html).toContain("https://app.example.test/pixel.gif?token=p1");
  });

  // ────────────────────────────────────────────────────────────────────
  // Task #2167 — coverage for the four non-export `DataRequestEmailKind`
  // arms that were previously English-only:
  //   filed / in_progress / completed (non-export) / rejected.
  //
  // Same stubbed-provider pattern as the export-related cases above:
  // assert the localised subject + HTML body and the dir/lang HTML
  // attributes so a future refactor that drops the i18n call (or wires
  // the wrong pack) fails loudly.
  // ────────────────────────────────────────────────────────────────────

  it("renders the Hindi pack for the `filed` acknowledgement", async () => {
    await sendDataRequestEmail({
      to: "member@example.test",
      memberName: "Aanya",
      kind: "filed",
      requestType: "access",
      requestId: 5151,
      requestedAt: new Date("2026-04-01T10:00:00Z"),
      dueBy: new Date("2026-05-01T10:00:00Z"),
      lang: "hi",
      branding: { orgName: "Acme GC", orgId: 99 },
    });

    expect(captured.length).toBe(1);
    const msg = captured[0];

    // Subject is fully translated and carries org name + ref id.
    expect(msg.subject).toBe("गोपनीयता अनुरोध प्राप्त हुआ — Acme GC (#5151)");

    // Outer block carries lang + dir attrs (Hindi is LTR).
    expect(msg.html).toContain('lang="hi"');
    expect(msg.html).toContain('dir="ltr"');

    // Heading + intro use the Hindi pack's literal copy with the
    // member name interpolated.
    expect(msg.html).toContain("हमें आपका गोपनीयता अनुरोध मिल गया है");
    expect(msg.html).toContain("Aanya");

    // Due-by sentence is bolded around the localised date label.
    expect(msg.html).toMatch(/<strong[^>]*>[^<]+<\/strong>/);
    expect(msg.html).toContain("लागू डेटा-सुरक्षा नियमों");

    // No leftover English copy from the prior hard-coded template.
    expect(msg.html).not.toContain("We've received your privacy request");
    expect(msg.html).not.toContain("In line with applicable data-protection regulations");
  });

  it("renders the Spanish pack for the `in_progress` update (no due date)", async () => {
    await sendDataRequestEmail({
      to: "member@example.test",
      memberName: "Carmen",
      kind: "in_progress",
      requestType: "erasure",
      requestId: 6262,
      requestedAt: new Date("2026-04-01T10:00:00Z"),
      dueBy: null,
      lang: "es",
      branding: { orgName: "Acme GC", orgId: 99 },
    });

    expect(captured.length).toBe(1);
    const msg = captured[0];

    expect(msg.subject).toBe("Actualización de la solicitud de privacidad — en curso (#6262)");
    expect(msg.html).toContain('lang="es"');
    expect(msg.html).toContain("Tu solicitud de privacidad se está procesando");
    expect(msg.html).toContain("Carmen");
    // No due date → the body sentence is omitted entirely (matches the
    // pre-i18n English template behaviour).
    expect(msg.html).not.toContain("Seguimos con el objetivo");
    expect(msg.html).not.toContain("We still aim to complete it");
  });

  it("renders the French pack for the non-export `completed` notice with a download CTA", async () => {
    await sendDataRequestEmail({
      to: "member@example.test",
      memberName: "Luc",
      kind: "completed",
      requestType: "rectification",
      requestId: 7373,
      requestedAt: new Date("2026-04-01T10:00:00Z"),
      dueBy: null,
      artifactUrl: "https://storage.example.test/response.pdf",
      lang: "fr",
      branding: { orgName: "Acme GC", orgId: 99 },
    });

    expect(captured.length).toBe(1);
    const msg = captured[0];

    expect(msg.subject).toBe("Demande de confidentialité terminée (#7373)");
    expect(msg.html).toContain('lang="fr"');
    expect(msg.html).toContain("Votre demande de confidentialité est terminée");
    expect(msg.html).toContain("Télécharger les documents");
    expect(msg.html).toContain("https://storage.example.test/response.pdf");
    // No leftover English CTA copy.
    expect(msg.html).not.toContain("Download materials");
    expect(msg.html).not.toContain("Your privacy request is complete");
  });

  it("renders the Arabic pack for the `rejected` notice with rtl direction and operator notes", async () => {
    await sendDataRequestEmail({
      to: "member@example.test",
      memberName: "Sara",
      kind: "rejected",
      requestType: "access",
      requestId: 8484,
      requestedAt: new Date("2026-04-01T10:00:00Z"),
      dueBy: null,
      notes: "Identity could not be verified.",
      lang: "ar",
      branding: { orgName: "Acme GC", orgId: 11 },
    });

    expect(captured.length).toBe(1);
    const msg = captured[0];

    expect(msg.subject).toBe("طلب الخصوصية — النتيجة (#8484)");
    expect(msg.html).toContain('lang="ar"');
    expect(msg.html).toContain('dir="rtl"');
    expect(msg.html).toContain("تحديث بشأن طلب الخصوصية الخاص بك");
    // Localised "Reason from our team:" label is bolded above the
    // HTML-escaped operator notes.
    expect(msg.html).toContain("السبب من فريقنا:");
    expect(msg.html).toContain("Identity could not be verified.");
    // No leftover English rejection copy.
    expect(msg.html).not.toContain("Reason from our team:");
    expect(msg.html).not.toContain("Update on your privacy request");
  });

  it("falls back to English for the four non-export kinds when lang is missing or unsupported", async () => {
    await sendDataRequestEmail({
      to: "member@example.test",
      memberName: "Pat",
      kind: "filed",
      requestType: "access",
      requestId: 9999,
      requestedAt: new Date("2026-04-01T10:00:00Z"),
      dueBy: new Date("2026-05-01T10:00:00Z"),
      lang: "xx-not-a-real-language",
      branding: { orgName: "Acme GC", orgId: 1 },
    });

    expect(captured.length).toBe(1);
    const msg = captured[0];

    // Falls back to English — same wording as the pre-i18n template.
    expect(msg.subject).toBe("Privacy request received — Acme GC (#9999)");
    expect(msg.html).toContain('lang="en"');
    expect(msg.html).toContain('dir="ltr"');
    expect(msg.html).toContain("We've received your privacy request");
    expect(msg.html).toContain("In line with applicable data-protection regulations");
  });

  it("falls back to English for the non-export `completed` kind when lang is null", async () => {
    await sendDataRequestEmail({
      to: "member@example.test",
      memberName: "Pat",
      kind: "completed",
      requestType: "rectification",
      requestId: 1234,
      requestedAt: new Date("2026-04-01T10:00:00Z"),
      dueBy: null,
      artifactUrl: "https://storage.example.test/x.pdf",
      lang: null,
      branding: { orgName: "Acme GC", orgId: 1 },
    });

    expect(captured.length).toBe(1);
    const msg = captured[0];
    expect(msg.subject).toBe("Privacy request completed (#1234)");
    expect(msg.html).toContain('lang="en"');
    expect(msg.html).toContain("Your privacy request is complete");
    expect(msg.html).toContain("Download materials");
  });

  it("falls back to English when lang is missing or unsupported", async () => {
    await sendDataRequestEmail({
      to: "member@example.test",
      memberName: "Pat",
      kind: "completed_export",
      requestType: "export",
      requestId: 1,
      requestedAt: new Date("2026-04-01T10:00:00Z"),
      dueBy: null,
      artifactUrl: "https://storage.example.test/signed?token=ghi",
      unsubUrl: "https://app.example.test/data-export-unsub?token=opq",
      lang: "xx-not-a-real-language",
      branding: { orgName: "Acme GC", orgId: 1 },
    });

    expect(captured.length).toBe(1);
    const msg = captured[0];

    // Falls back to the English pack — same wording the template used
    // before the i18n refactor landed.
    expect(msg.subject).toBe("Your data export is ready (#1)");
    expect(msg.html).toContain('lang="en"');
    expect(msg.html).toContain('dir="ltr"');
    expect(msg.html).toContain("Your data export is ready to download");
    expect(msg.html).toContain("⬇ Download my data archive");
    // The CTA text is HTML-escaped before insertion (Don't → Don&#39;t),
    // so we match the apostrophe-free portion that's stable across the
    // escape boundary.
    expect(msg.html).toContain("remind me about this download");
  });
});
