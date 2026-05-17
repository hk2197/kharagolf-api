/**
 * Tests for buildRevenueByCurrencyScheduleEmailContent (Task #960).
 *
 * Task #824 already pins the CSV bytes the digest cron emails to be
 * byte-identical to the on-demand /revenue-by-currency.csv download, but
 * only at the attachment level. This test pins down the rest of the
 * delivery surface — the subject line, the HTML summary block (period
 * label, cadence, row count, currency count) and the attachment filename
 * — for representative weekly and monthly inputs, so a regression in
 * any of those user-visible fields is caught before it ships.
 *
 * Calls the same helper the cron uses (sendRevenueByCurrencyScheduleEmail
 * delegates to buildRevenueByCurrencyScheduleEmailContent), so any future
 * preview surface that goes through the same builder is covered too.
 */
import { describe, it, expect } from "vitest";
import { buildRevenueByCurrencyScheduleEmailContent } from "../lib/mailer.js";

const fmt = (d: Date | null) =>
  d ? d.toLocaleDateString("en", { year: "numeric", month: "long", day: "numeric" }) : "—";

describe("buildRevenueByCurrencyScheduleEmailContent", () => {
  it("produces a stable weekly subject, summary block and filename", () => {
    const periodStart = new Date("2026-03-09T00:00:00Z");
    const periodEnd = new Date("2026-03-16T00:00:00Z");
    const { subject, html, filename } = buildRevenueByCurrencyScheduleEmailContent({
      orgName: "Acme Golf Club",
      frequency: "weekly",
      periodStart,
      periodEnd,
      rowCount: 12,
      currencyCount: 3,
    });

    expect(subject).toBe("Acme Golf Club — Weekly revenue & tax by currency");
    expect(filename).toBe("revenue-by-currency-2026-03-16.csv");

    // Header / intro mentions the org name (HTML-escaped passthrough for a
    // plain ASCII name).
    expect(html).toContain("Acme Golf Club");
    // Cadence heading distinguishes weekly vs monthly bodies.
    expect(html).toContain("Weekly pivot attached");
    expect(html).not.toContain("Monthly pivot attached");

    // Summary table rows — locked to the exact label + value pairing so a
    // regression in either the label or the value layout is caught.
    const periodLabel = `${fmt(periodStart)} → ${fmt(periodEnd)}`;
    expect(html).toContain(
      `<td style="padding:6px 0;color:#6b7280;font-size:13px;">Period</td><td style="padding:6px 0;text-align:right;color:#fff;font-weight:600;">${periodLabel}</td>`,
    );
    expect(html).toContain(
      `<td style="padding:6px 0;color:#6b7280;font-size:13px;">Cadence</td><td style="padding:6px 0;text-align:right;color:#fff;">weekly</td>`,
    );
    expect(html).toContain(
      `<td style="padding:6px 0;color:#6b7280;font-size:13px;">Currencies in this file</td><td style="padding:6px 0;text-align:right;color:#fff;">3</td>`,
    );
    expect(html).toContain(
      `<td style="padding:6px 0;color:#6b7280;font-size:13px;">Rows in this file</td><td style="padding:6px 0;text-align:right;color:#4ade80;font-weight:700;">12</td>`,
    );
  });

  it("produces a stable monthly subject, summary block and filename", () => {
    const periodStart = new Date("2026-02-01T00:00:00Z");
    const periodEnd = new Date("2026-03-01T00:00:00Z");
    const { subject, html, filename } = buildRevenueByCurrencyScheduleEmailContent({
      orgName: "Riverside CC",
      frequency: "monthly",
      periodStart,
      periodEnd,
      rowCount: 47,
      currencyCount: 5,
    });

    expect(subject).toBe("Riverside CC — Monthly revenue & tax by currency");
    expect(filename).toBe("revenue-by-currency-2026-03-01.csv");

    expect(html).toContain("Riverside CC");
    expect(html).toContain("Monthly pivot attached");
    expect(html).not.toContain("Weekly pivot attached");

    const periodLabel = `${fmt(periodStart)} → ${fmt(periodEnd)}`;
    expect(html).toContain(
      `<td style="padding:6px 0;color:#6b7280;font-size:13px;">Period</td><td style="padding:6px 0;text-align:right;color:#fff;font-weight:600;">${periodLabel}</td>`,
    );
    expect(html).toContain(
      `<td style="padding:6px 0;color:#6b7280;font-size:13px;">Cadence</td><td style="padding:6px 0;text-align:right;color:#fff;">monthly</td>`,
    );
    expect(html).toContain(
      `<td style="padding:6px 0;color:#6b7280;font-size:13px;">Currencies in this file</td><td style="padding:6px 0;text-align:right;color:#fff;">5</td>`,
    );
    expect(html).toContain(
      `<td style="padding:6px 0;color:#6b7280;font-size:13px;">Rows in this file</td><td style="padding:6px 0;text-align:right;color:#4ade80;font-weight:700;">47</td>`,
    );
  });

  it("renders an em-dash placeholder when periodStart is null (first-ever run)", () => {
    const periodEnd = new Date("2026-04-01T00:00:00Z");
    const { html, filename, subject } = buildRevenueByCurrencyScheduleEmailContent({
      orgName: "Acme Golf Club",
      frequency: "weekly",
      periodStart: null,
      periodEnd,
      rowCount: 0,
      currencyCount: 0,
    });

    expect(subject).toBe("Acme Golf Club — Weekly revenue & tax by currency");
    expect(filename).toBe("revenue-by-currency-2026-04-01.csv");
    const periodLabel = `— → ${fmt(periodEnd)}`;
    expect(html).toContain(
      `<td style="padding:6px 0;color:#6b7280;font-size:13px;">Period</td><td style="padding:6px 0;text-align:right;color:#fff;font-weight:600;">${periodLabel}</td>`,
    );
    expect(html).toContain(
      `<td style="padding:6px 0;color:#6b7280;font-size:13px;">Currencies in this file</td><td style="padding:6px 0;text-align:right;color:#fff;">0</td>`,
    );
    expect(html).toContain(
      `<td style="padding:6px 0;color:#6b7280;font-size:13px;">Rows in this file</td><td style="padding:6px 0;text-align:right;color:#4ade80;font-weight:700;">0</td>`,
    );
  });

  it("HTML-escapes org names in the summary body so markup characters can't break the table layout", () => {
    const { html, subject } = buildRevenueByCurrencyScheduleEmailContent({
      orgName: 'A&B "Golf" <Club>',
      frequency: "weekly",
      periodStart: new Date("2026-03-09T00:00:00Z"),
      periodEnd: new Date("2026-03-16T00:00:00Z"),
      rowCount: 1,
      currencyCount: 1,
    });
    // Subject is a plain-text header field — the raw org name flows through.
    expect(subject).toBe('A&B "Golf" <Club> — Weekly revenue & tax by currency');
    // The summary paragraph escapes the org name so &/</>/" can't break the
    // surrounding <strong> tag or the table that follows it.
    expect(html).toContain(
      'for <strong style="color:#fff;">A&amp;B &quot;Golf&quot; &lt;Club&gt;</strong> covering the elapsed period.',
    );
  });
});
