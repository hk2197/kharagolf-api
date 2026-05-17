/**
 * Task #1887 — `renderBrandedHeaderHtml` (the shared `headerHtml` helper
 * behind every transactional email's dark-green header strip) must
 * HTML-escape the brand / org name before injecting it into the `<h1>`
 * and the logo `alt` attribute.
 *
 * Without this, a club whose name contains characters like `<`, `>`,
 * `&`, or `"` would render the raw characters as markup in the email
 * header — and could even break out of `alt=""`. The body copy of
 * Task #1522's side-game receipt digest already escapes the same
 * string, so this brings the shared header in line with the body and
 * fixes the regression at the single shared chokepoint instead of
 * patching every per-flow template.
 */
import { describe, it, expect } from "vitest";
import { renderBrandedHeaderHtml } from "../lib/mailer.js";

describe("renderBrandedHeaderHtml — brand-name escaping", () => {
  it("HTML-escapes a hostile org name in both the <h1> and the logo alt attribute", () => {
    const html = renderBrandedHeaderHtml(
      {
        orgName: `<Evil> & "Co"`,
        logoUrl: "https://cdn.example.com/logo.png",
      },
      "Enterprise",
    );

    // `<`, `>`, `&`, `"` must all be escaped wherever the brand name
    // surfaces — the `<h1>` text and the logo `alt` attribute both
    // live in the header strip and both get the same escaping.
    expect(html).toContain(`<h1 style="margin:0;font-size:24px;letter-spacing:4px;font-weight:900;color:#ffffff;">&lt;Evil&gt; &amp; &quot;Co&quot;</h1>`);
    expect(html).toContain(`alt="&lt;Evil&gt; &amp; &quot;Co&quot;"`);

    // And the raw, unescaped form must NOT appear anywhere in the
    // rendered header — otherwise a permissive email client could
    // still parse it as markup.
    expect(html).not.toContain(`<Evil>`);
    expect(html).not.toContain(`& "Co"`);
    // The literal closing-quote followed by a stray attribute would be
    // the canonical `alt=""` break-out vector. Guard against it.
    expect(html).not.toContain(`alt="<Evil>`);
  });

  it("renders the default KHARAGOLF brand name unchanged when no orgName is supplied", () => {
    // The default brand has no escapable characters, so the rendered
    // header must remain byte-for-byte identical to the pre-fix output.
    // This protects every transactional email whose `headerHtml` call
    // omits a custom `orgName` (e.g. signup verification before an org
    // is known) from a stylistic regression.
    const html = renderBrandedHeaderHtml();
    expect(html).toContain(`<h1 style="margin:0;font-size:24px;letter-spacing:4px;font-weight:900;color:#ffffff;">KHARAGOLF</h1>`);
    expect(html).not.toContain("&amp;");
    expect(html).not.toContain("&lt;");
  });

  it("leaves a benign org name intact (no over-escaping of safe characters)", () => {
    // A normal club name with apostrophes and accents must render
    // through escapeHtml without losing its visual form. Apostrophes
    // become the numeric entity `&#39;` (vs the named `&apos;`) so the
    // assertion pins down the exact escape we use.
    const html = renderBrandedHeaderHtml({ orgName: "St. Andrew's Golf Club — São Paulo" });
    expect(html).toContain(`<h1 style="margin:0;font-size:24px;letter-spacing:4px;font-weight:900;color:#ffffff;">St. Andrew&#39;s Golf Club — São Paulo</h1>`);
  });
});
