/**
 * Unit tests for `sendOrgLevyLedgerScheduleEmail` itself (Task #322 / #390).
 *
 * The schedule-runner integration tests in
 * `levy-ledger-org-email-delivery-format.test.ts` mock the mailer to assert
 * that the route hands it the right inputs. This file complements them by
 * mocking nodemailer's transport directly and asserting the *final* email
 * payload that lands at SMTP for each delivery format:
 *
 *   - "combined"     → exactly one CSV attachment with the right
 *     `filename` (`levy-ledger-all-<YYYY-MM-DD>.csv`) and
 *     `contentType` (`text/csv; charset=utf-8`); body labels the format
 *     and copies the right intro line.
 *   - "per_levy_zip" → exactly one ZIP attachment with the right
 *     `filename` (`levy-ledger-per-levy-<YYYY-MM-DD>.zip`) and
 *     `contentType` (`application/zip`); body labels the format and
 *     copies the right intro line.
 *   - "both"         → BOTH attachments present with the right filenames
 *     and content-types; body labels the combined "Combined CSV +
 *     per-levy ZIP" format.
 *   - Default       → omitting `deliveryFormat` falls back to "combined".
 *   - Misuse guards → "combined"/"both" without csv, and
 *     "per_levy_zip"/"both" without zip, throw before sendMail is called.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// Set Gmail env vars BEFORE mailer.ts is imported so its module-level
// `isGmailConfigured` check passes and `sendMail` actually invokes the
// (mocked) transport instead of throwing on the credentials guard.
vi.hoisted(() => {
  process.env.GMAIL_USER = process.env.GMAIL_USER || "test@example.com";
  process.env.GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD || "test-app-password";
});

const sendMailMock = vi.hoisted(() => vi.fn(async (_opts: Record<string, unknown>) => ({ messageId: "test" })));

vi.mock("nodemailer", () => {
  const transport = { sendMail: sendMailMock };
  return {
    default: { createTransport: () => transport },
    createTransport: () => transport,
  };
});

import { sendOrgLevyLedgerScheduleEmail } from "../lib/mailer.js";

interface CapturedAttachment {
  filename: string;
  content: string | Buffer;
  contentType: string;
}
interface CapturedMail {
  to: string | string[];
  subject: string;
  html: string;
  attachments: CapturedAttachment[];
}

function lastMail(): CapturedMail {
  expect(sendMailMock).toHaveBeenCalled();
  const args = sendMailMock.mock.calls[sendMailMock.mock.calls.length - 1]![0] as unknown as CapturedMail;
  return args;
}

const PERIOD_END = new Date(Date.UTC(2026, 3, 17, 7, 0, 0)); // 2026-04-17
const DATESTAMP = "2026-04-17";
const PERIOD_START = new Date(Date.UTC(2026, 3, 10, 7, 0, 0));

beforeEach(() => {
  sendMailMock.mockReset();
  sendMailMock.mockResolvedValue({ messageId: "test" });
});

describe("sendOrgLevyLedgerScheduleEmail — combined", () => {
  it("attaches one CSV with the right filename + contentType and labels the body", async () => {
    await sendOrgLevyLedgerScheduleEmail({
      to: ["treasurer@example.com"],
      orgName: "Acme Golf Club",
      frequency: "weekly",
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      rowCount: 12,
      levyCount: 3,
      csv: "date,levy,amount\n2026-04-15,Annual,100\n",
      deliveryFormat: "combined",
    });

    const mail = lastMail();
    expect(mail.to).toEqual(["treasurer@example.com"]);
    expect(mail.subject).toContain("Weekly");
    expect(mail.subject).toContain("club-wide levy ledger");

    expect(mail.attachments).toHaveLength(1);
    const csvAtt = mail.attachments[0];
    expect(csvAtt.filename).toBe(`levy-ledger-all-${DATESTAMP}.csv`);
    expect(csvAtt.contentType).toBe("text/csv; charset=utf-8");
    expect(typeof csvAtt.content).toBe("string");

    // Body labels the format and copies the combined-specific intro line.
    expect(mail.html).toContain("Combined CSV");
    expect(mail.html).toContain("combined ledger covering every active levy");
    expect(mail.html).toContain("Acme Golf Club");
    // Per-row count label uses "Rows in this file" for combined.
    expect(mail.html).toContain("Rows in this file");
  });

  it("defaults to 'combined' when deliveryFormat is omitted", async () => {
    await sendOrgLevyLedgerScheduleEmail({
      to: "treasurer@example.com",
      orgName: "Acme",
      frequency: "monthly",
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      rowCount: 1,
      levyCount: 1,
      csv: "date\n2026-04-15\n",
    });
    const mail = lastMail();
    expect(mail.attachments).toHaveLength(1);
    expect(mail.attachments[0].filename).toBe(`levy-ledger-all-${DATESTAMP}.csv`);
    expect(mail.attachments[0].contentType).toBe("text/csv; charset=utf-8");
    expect(mail.html).toContain("Combined CSV");
  });

  it("throws and skips sendMail when csv is missing for combined", async () => {
    await expect(
      sendOrgLevyLedgerScheduleEmail({
        to: ["t@example.com"],
        orgName: "Acme",
        frequency: "weekly",
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        rowCount: 0,
        levyCount: 0,
        deliveryFormat: "combined",
      }),
    ).rejects.toThrow(/csv is required/);
    expect(sendMailMock).not.toHaveBeenCalled();
  });
});

describe("sendOrgLevyLedgerScheduleEmail — per_levy_zip", () => {
  it("attaches one ZIP with the right filename + contentType and labels the body", async () => {
    const zip = Buffer.from("PK\x03\x04 fake-zip-bytes");
    await sendOrgLevyLedgerScheduleEmail({
      to: ["treasurer@example.com"],
      orgName: "Acme Golf Club",
      frequency: "monthly",
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      rowCount: 7,
      levyCount: 4,
      zip,
      deliveryFormat: "per_levy_zip",
    });

    const mail = lastMail();
    expect(mail.attachments).toHaveLength(1);
    const zipAtt = mail.attachments[0];
    expect(zipAtt.filename).toBe(`levy-ledger-per-levy-${DATESTAMP}.zip`);
    expect(zipAtt.contentType).toBe("application/zip");
    expect(Buffer.isBuffer(zipAtt.content)).toBe(true);
    expect((zipAtt.content as Buffer).equals(zip)).toBe(true);

    expect(mail.html).toContain("Per-levy CSV pack (ZIP)");
    expect(mail.html).toContain("ZIP containing one CSV per levy");
    // Counter label switches to "Rows in this digest" when no combined CSV is attached.
    expect(mail.html).toContain("Rows in this digest");
    expect(mail.html).not.toContain("levy-ledger-all-");
  });

  it("throws and skips sendMail when zip is missing for per_levy_zip", async () => {
    await expect(
      sendOrgLevyLedgerScheduleEmail({
        to: ["t@example.com"],
        orgName: "Acme",
        frequency: "weekly",
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        rowCount: 0,
        levyCount: 0,
        deliveryFormat: "per_levy_zip",
      }),
    ).rejects.toThrow(/zip is required/);
    expect(sendMailMock).not.toHaveBeenCalled();
  });
});

describe("sendOrgLevyLedgerScheduleEmail — both", () => {
  it("attaches BOTH the combined CSV and the per-levy ZIP with correct metadata", async () => {
    const zip = Buffer.from("PK\x03\x04 fake-zip-bytes");
    await sendOrgLevyLedgerScheduleEmail({
      to: ["treasurer@example.com"],
      orgName: "Acme",
      frequency: "weekly",
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      rowCount: 11,
      levyCount: 5,
      csv: "date,levy,amount\n",
      zip,
      deliveryFormat: "both",
    });

    const mail = lastMail();
    expect(mail.attachments).toHaveLength(2);

    const csvAtt = mail.attachments.find((a) => a.filename.endsWith(".csv"))!;
    const zipAtt = mail.attachments.find((a) => a.filename.endsWith(".zip"))!;
    expect(csvAtt.filename).toBe(`levy-ledger-all-${DATESTAMP}.csv`);
    expect(csvAtt.contentType).toBe("text/csv; charset=utf-8");
    expect(zipAtt.filename).toBe(`levy-ledger-per-levy-${DATESTAMP}.zip`);
    expect(zipAtt.contentType).toBe("application/zip");

    expect(mail.html).toContain("Combined CSV + per-levy ZIP");
    expect(mail.html).toContain("Both the combined ledger and a ZIP with one CSV per levy");
  });

  it("throws when csv is missing for 'both'", async () => {
    await expect(
      sendOrgLevyLedgerScheduleEmail({
        to: ["t@example.com"],
        orgName: "Acme",
        frequency: "weekly",
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        rowCount: 0,
        levyCount: 0,
        zip: Buffer.from("zip"),
        deliveryFormat: "both",
      }),
    ).rejects.toThrow(/csv is required/);
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it("throws when zip is missing for 'both'", async () => {
    await expect(
      sendOrgLevyLedgerScheduleEmail({
        to: ["t@example.com"],
        orgName: "Acme",
        frequency: "weekly",
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        rowCount: 0,
        levyCount: 0,
        csv: "date\n",
        deliveryFormat: "both",
      }),
    ).rejects.toThrow(/zip is required/);
    expect(sendMailMock).not.toHaveBeenCalled();
  });
});
