/**
 * Tests for Task #1863 — auto-page on-call when wallet-topup-refund
 * SMS / WhatsApp retry budgets keep burning out.
 *
 * Covers:
 *   - Below per-org threshold → no alert (`below_threshold`).
 *   - At/above per-org threshold → emails every recipient + posts to
 *     Slack + triggers PagerDuty, embedding per-org rollup with
 *     sample provider error strings.
 *   - Multi-org breach → all breached orgs surface in the email payload,
 *     ordered by `rowsExhausted DESC`.
 *   - Stale exhaustions outside the lookback window are excluded.
 *   - In-process cooldown suppresses repeat pages within the cooldown
 *     window; `force` overrides.
 *   - No recipients AND no Slack / PagerDuty configured → returns
 *     `no_recipients_or_chat` without throwing.
 *   - Threshold / window / cooldown / sample size pull from env vars
 *     when callers don't pin them.
 *   - Same-row dedup: a row exhausted on both SMS and WhatsApp counts
 *     once toward `rowsExhausted` but contributes both channels'
 *     samples.
 *   - Sample-error dedup collapses repeated provider error strings.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";

vi.mock("../lib/mailer.js", async () => ({
  sendWalletTopupRefundRetryExhaustionOpsAlertEmail: vi.fn(async () => undefined),
}));

vi.mock("../lib/opsAlertChat.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/opsAlertChat.js")>(
    "../lib/opsAlertChat.js",
  );
  return {
    ...actual,
    postWalletTopupRefundRetryExhaustionOpsAlertSlack: vi.fn(async () => undefined),
    triggerWalletTopupRefundRetryExhaustionOpsAlertPagerDuty: vi.fn(async () => undefined),
  };
});

import {
  appUsersTable,
  db,
  organizationsTable,
  walletTopupRefundNotifyAttemptsTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";

import {
  runWalletTopupRefundRetryExhaustionOpsAlertJob,
  loadWalletTopupRefundRetryExhaustionBreakdown,
  _resetWalletTopupRefundRetryExhaustionOpsAlertDedupForTest,
  DEFAULT_OPS_WALLET_REFUND_RETRY_EXHAUSTION_THRESHOLD,
  DEFAULT_OPS_WALLET_REFUND_RETRY_EXHAUSTION_WINDOW_HOURS,
  DEFAULT_OPS_WALLET_REFUND_RETRY_EXHAUSTION_COOLDOWN_HOURS,
  DEFAULT_OPS_WALLET_REFUND_RETRY_EXHAUSTION_SAMPLE_SIZE,
} from "../lib/walletTopupRefundRetryExhaustionOpsAlert.js";
import { sendWalletTopupRefundRetryExhaustionOpsAlertEmail } from "../lib/mailer.js";
import {
  postWalletTopupRefundRetryExhaustionOpsAlertSlack,
  triggerWalletTopupRefundRetryExhaustionOpsAlertPagerDuty,
} from "../lib/opsAlertChat.js";

const emailMock = vi.mocked(sendWalletTopupRefundRetryExhaustionOpsAlertEmail);
const slackMock = vi.mocked(postWalletTopupRefundRetryExhaustionOpsAlertSlack);
const pagerDutyMock = vi.mocked(triggerWalletTopupRefundRetryExhaustionOpsAlertPagerDuty);

let testOrgAId: number;
let testOrgBId: number;
let testOrgAName: string;
let testOrgBName: string;
let testUserId: number;
const seededAttemptIds: number[] = [];

let paymentSeq = 0;
async function seedAttempt(opts: {
  organizationId: number;
  smsExhaustedAt?: Date | null;
  whatsappExhaustedAt?: Date | null;
  lastSmsError?: string | null;
  lastWhatsappError?: string | null;
}): Promise<number> {
  paymentSeq += 1;
  const [row] = await db
    .insert(walletTopupRefundNotifyAttemptsTable)
    .values({
      paymentId: `wtr_ops_${Date.now()}_${paymentSeq}_${Math.random().toString(36).slice(2, 6)}`,
      organizationId: opts.organizationId,
      userId: testUserId,
      amount: "100.00",
      currency: "INR",
      smsStatus: opts.smsExhaustedAt ? "failed" : null,
      smsAttempts: opts.smsExhaustedAt ? 5 : 0,
      smsRetryExhaustedAt: opts.smsExhaustedAt ?? null,
      lastSmsError: opts.lastSmsError ?? null,
      whatsappStatus: opts.whatsappExhaustedAt ? "failed" : null,
      whatsappAttempts: opts.whatsappExhaustedAt ? 5 : 0,
      whatsappRetryExhaustedAt: opts.whatsappExhaustedAt ?? null,
      lastWhatsappError: opts.lastWhatsappError ?? null,
    })
    .returning({ id: walletTopupRefundNotifyAttemptsTable.id });
  seededAttemptIds.push(row.id);
  return row.id;
}

async function clearSeededAttempts(): Promise<void> {
  if (seededAttemptIds.length > 0) {
    await db
      .delete(walletTopupRefundNotifyAttemptsTable)
      .where(inArray(walletTopupRefundNotifyAttemptsTable.id, seededAttemptIds));
    seededAttemptIds.length = 0;
  }
}

beforeAll(async () => {
  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  testOrgAName = `RefundOpsAlertA_${stamp}`;
  testOrgBName = `RefundOpsAlertB_${stamp}`;
  const [orgA] = await db.insert(organizationsTable).values({
    name: testOrgAName,
    slug: `refund-ops-alert-a-${stamp}`,
  }).returning({ id: organizationsTable.id });
  testOrgAId = orgA.id;
  const [orgB] = await db.insert(organizationsTable).values({
    name: testOrgBName,
    slug: `refund-ops-alert-b-${stamp}`,
  }).returning({ id: organizationsTable.id });
  testOrgBId = orgB.id;
  const [u] = await db.insert(appUsersTable).values({
    replitUserId: `refund-ops-alert-${stamp}`,
    username: `refund_ops_alert_${stamp}`,
    organizationId: orgA.id,
  }).returning({ id: appUsersTable.id });
  testUserId = u.id;
});

afterAll(async () => {
  await clearSeededAttempts();
  if (testUserId) {
    await db.delete(appUsersTable).where(eq(appUsersTable.id, testUserId));
  }
  if (testOrgAId) {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, testOrgAId));
  }
  if (testOrgBId) {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, testOrgBId));
  }
});

beforeEach(async () => {
  emailMock.mockReset();
  emailMock.mockResolvedValue(undefined);
  slackMock.mockReset();
  slackMock.mockResolvedValue(undefined);
  pagerDutyMock.mockReset();
  pagerDutyMock.mockResolvedValue(undefined);
  _resetWalletTopupRefundRetryExhaustionOpsAlertDedupForTest();
  await clearSeededAttempts();
});

afterEach(() => {
  delete process.env.OPS_ALERT_EMAILS;
  delete process.env.OPS_ALERT_SLACK_WEBHOOK;
  delete process.env.OPS_ALERT_PAGERDUTY_ROUTING_KEY;
  delete process.env.OPS_WALLET_REFUND_RETRY_ALERT_SLACK_WEBHOOK;
  delete process.env.OPS_WALLET_REFUND_RETRY_ALERT_PAGERDUTY_ROUTING_KEY;
  delete process.env.OPS_WALLET_REFUND_RETRY_EXHAUSTION_THRESHOLD;
  delete process.env.OPS_WALLET_REFUND_RETRY_EXHAUSTION_WINDOW_HOURS;
  delete process.env.OPS_WALLET_REFUND_RETRY_EXHAUSTION_COOLDOWN_HOURS;
  delete process.env.OPS_WALLET_REFUND_RETRY_EXHAUSTION_SAMPLE_SIZE;
});

describe("runWalletTopupRefundRetryExhaustionOpsAlertJob — below threshold", () => {
  it("does not alert when no org's count meets the threshold", async () => {
    const now = new Date();
    await seedAttempt({ organizationId: testOrgAId, smsExhaustedAt: now, lastSmsError: "Twilio 21610" });
    await seedAttempt({ organizationId: testOrgAId, smsExhaustedAt: now, lastSmsError: "Twilio 21610" });

    const res = await runWalletTopupRefundRetryExhaustionOpsAlertJob({
      threshold: 3,
      windowHours: 1,
      cooldownHours: 1,
      sampleSize: 5,
      recipients: ["ops@example.com"],
      now,
    });

    expect(res.alerted).toBe(false);
    expect(res.reason).toBe("below_threshold");
    expect(res.observedBreakdown).toHaveLength(1);
    expect(res.observedBreakdown[0].rowsExhausted).toBe(2);
    expect(res.breachedBreakdown).toHaveLength(0);
    expect(emailMock).not.toHaveBeenCalled();
    expect(slackMock).not.toHaveBeenCalled();
    expect(pagerDutyMock).not.toHaveBeenCalled();
  });
});

describe("runWalletTopupRefundRetryExhaustionOpsAlertJob — at/above threshold", () => {
  it("emails, posts to Slack and triggers PagerDuty when an org breaches; embeds sample errors", async () => {
    const now = new Date();
    process.env.OPS_ALERT_SLACK_WEBHOOK = "https://hooks.slack.test/wallet-refund";
    process.env.OPS_ALERT_PAGERDUTY_ROUTING_KEY = "pd-test-routing-key";

    await seedAttempt({ organizationId: testOrgAId, smsExhaustedAt: now, lastSmsError: "Twilio 30007: blocked" });
    await seedAttempt({ organizationId: testOrgAId, smsExhaustedAt: now, lastSmsError: "Twilio 30007: blocked" });
    await seedAttempt({ organizationId: testOrgAId, whatsappExhaustedAt: now, lastWhatsappError: "WA: token expired" });

    const res = await runWalletTopupRefundRetryExhaustionOpsAlertJob({
      threshold: 3,
      windowHours: 1,
      cooldownHours: 1,
      sampleSize: 5,
      recipients: ["ops@example.com", "oncall@example.com"],
      now,
    });

    expect(res.alerted).toBe(true);
    expect(res.recipientsAttempted).toBe(2);
    expect(res.recipientsEmailed).toBe(2);
    expect(res.slackAttempted).toBe(true);
    expect(res.slackPosted).toBe(true);
    expect(res.pagerDutyAttempted).toBe(true);
    expect(res.pagerDutyTriggered).toBe(true);
    expect(emailMock).toHaveBeenCalledTimes(2);
    expect(slackMock).toHaveBeenCalledTimes(1);
    expect(pagerDutyMock).toHaveBeenCalledTimes(1);

    const firstEmail = emailMock.mock.calls[0][0];
    expect(firstEmail.to).toBe("ops@example.com");
    expect(firstEmail.threshold).toBe(3);
    expect(firstEmail.windowHours).toBe(1);
    expect(firstEmail.cooldownHours).toBe(1);
    expect(firstEmail.breached).toHaveLength(1);
    expect(firstEmail.breached[0].organizationId).toBe(testOrgAId);
    expect(firstEmail.breached[0].organizationName).toBe(testOrgAName);
    expect(firstEmail.breached[0].smsExhausted).toBe(2);
    expect(firstEmail.breached[0].whatsappExhausted).toBe(1);
    expect(firstEmail.breached[0].rowsExhausted).toBe(3);
    // Distinct provider errors only — repeated "Twilio 30007: blocked"
    // collapses to one sample, plus the WA one.
    const messages = firstEmail.breached[0].sampleErrors.map((s) => s.message);
    expect(messages).toContain("Twilio 30007: blocked");
    expect(messages).toContain("WA: token expired");
    expect(firstEmail.breached[0].sampleErrors.length).toBe(2);
  });

  it("alerts at exactly the threshold (>= comparison, not >)", async () => {
    const now = new Date();
    await seedAttempt({ organizationId: testOrgAId, smsExhaustedAt: now });
    await seedAttempt({ organizationId: testOrgAId, smsExhaustedAt: now });
    await seedAttempt({ organizationId: testOrgAId, smsExhaustedAt: now });

    const res = await runWalletTopupRefundRetryExhaustionOpsAlertJob({
      threshold: 3,
      windowHours: 1,
      recipients: ["ops@example.com"],
      now,
    });

    expect(res.alerted).toBe(true);
    expect(res.breachedBreakdown).toHaveLength(1);
    expect(res.breachedBreakdown[0].rowsExhausted).toBe(3);
  });

  it("a row exhausted on both SMS and WhatsApp counts once toward rowsExhausted but contributes both samples", async () => {
    const now = new Date();
    await seedAttempt({
      organizationId: testOrgAId,
      smsExhaustedAt: now,
      whatsappExhaustedAt: now,
      lastSmsError: "Twilio: hard bounce",
      lastWhatsappError: "WA: 24h window expired",
    });
    await seedAttempt({ organizationId: testOrgAId, smsExhaustedAt: now, lastSmsError: "Twilio: hard bounce" });
    await seedAttempt({ organizationId: testOrgAId, smsExhaustedAt: now, lastSmsError: "Twilio: hard bounce" });

    const res = await runWalletTopupRefundRetryExhaustionOpsAlertJob({
      threshold: 3,
      windowHours: 1,
      recipients: ["ops@example.com"],
      now,
    });

    expect(res.alerted).toBe(true);
    expect(res.breachedBreakdown[0].rowsExhausted).toBe(3);
    expect(res.breachedBreakdown[0].smsExhausted).toBe(3);
    expect(res.breachedBreakdown[0].whatsappExhausted).toBe(1);
    const channels = res.breachedBreakdown[0].sampleErrors.map((s) => s.channel).sort();
    expect(channels).toEqual(["sms", "whatsapp"]);
  });
});

describe("runWalletTopupRefundRetryExhaustionOpsAlertJob — multi-org breach", () => {
  it("includes every breached org, ordered by rowsExhausted DESC", async () => {
    const now = new Date();
    // Org A: 2 rows — does NOT breach.
    await seedAttempt({ organizationId: testOrgAId, smsExhaustedAt: now });
    await seedAttempt({ organizationId: testOrgAId, smsExhaustedAt: now });
    // Org B: 4 rows — breaches.
    for (let i = 0; i < 4; i++) {
      await seedAttempt({ organizationId: testOrgBId, smsExhaustedAt: now, lastSmsError: `err-${i}` });
    }

    const res = await runWalletTopupRefundRetryExhaustionOpsAlertJob({
      threshold: 3,
      windowHours: 1,
      recipients: ["ops@example.com"],
      now,
    });

    expect(res.alerted).toBe(true);
    // Both orgs surface in observedBreakdown (org B first because larger).
    expect(res.observedBreakdown[0].organizationId).toBe(testOrgBId);
    expect(res.observedBreakdown[0].rowsExhausted).toBe(4);
    expect(res.observedBreakdown[1].organizationId).toBe(testOrgAId);
    // Only org B is in breachedBreakdown.
    expect(res.breachedBreakdown).toHaveLength(1);
    expect(res.breachedBreakdown[0].organizationId).toBe(testOrgBId);
  });

  it("two orgs both breaching are both in the email payload", async () => {
    const now = new Date();
    for (let i = 0; i < 3; i++) {
      await seedAttempt({ organizationId: testOrgAId, smsExhaustedAt: now });
    }
    for (let i = 0; i < 5; i++) {
      await seedAttempt({ organizationId: testOrgBId, smsExhaustedAt: now });
    }

    const res = await runWalletTopupRefundRetryExhaustionOpsAlertJob({
      threshold: 3,
      windowHours: 1,
      recipients: ["ops@example.com"],
      now,
    });

    expect(res.alerted).toBe(true);
    expect(res.breachedBreakdown).toHaveLength(2);
    // Larger blast radius first.
    expect(res.breachedBreakdown[0].organizationId).toBe(testOrgBId);
    expect(res.breachedBreakdown[1].organizationId).toBe(testOrgAId);
    const breached = emailMock.mock.calls[0][0].breached;
    expect(breached.map((b) => b.organizationId)).toEqual([testOrgBId, testOrgAId]);
  });
});

describe("runWalletTopupRefundRetryExhaustionOpsAlertJob — lookback window", () => {
  it("excludes exhaustions stamped outside the lookback window", async () => {
    const now = new Date();
    const stale = new Date(now.getTime() - 6 * 60 * 60 * 1000);
    for (let i = 0; i < 5; i++) {
      await seedAttempt({ organizationId: testOrgAId, smsExhaustedAt: stale });
    }

    const res = await runWalletTopupRefundRetryExhaustionOpsAlertJob({
      threshold: 3,
      windowHours: 1,
      recipients: ["ops@example.com"],
      now,
    });

    expect(res.alerted).toBe(false);
    expect(res.observedBreakdown).toHaveLength(0);
    expect(emailMock).not.toHaveBeenCalled();
  });
});

describe("runWalletTopupRefundRetryExhaustionOpsAlertJob — cooldown", () => {
  it("suppresses a second page within the cooldown window; force overrides", async () => {
    const now = new Date();
    for (let i = 0; i < 4; i++) {
      await seedAttempt({ organizationId: testOrgAId, smsExhaustedAt: now });
    }

    const first = await runWalletTopupRefundRetryExhaustionOpsAlertJob({
      threshold: 3,
      windowHours: 1,
      cooldownHours: 1,
      recipients: ["ops@example.com"],
      now,
    });
    expect(first.alerted).toBe(true);
    expect(emailMock).toHaveBeenCalledTimes(1);

    const second = await runWalletTopupRefundRetryExhaustionOpsAlertJob({
      threshold: 3,
      windowHours: 1,
      cooldownHours: 1,
      recipients: ["ops@example.com"],
      now: new Date(now.getTime() + 30 * 60 * 1000),
    });
    expect(second.alerted).toBe(false);
    expect(second.reason).toBe("in_cooldown");
    expect(emailMock).toHaveBeenCalledTimes(1);

    const forced = await runWalletTopupRefundRetryExhaustionOpsAlertJob({
      threshold: 3,
      windowHours: 1,
      cooldownHours: 1,
      recipients: ["ops@example.com"],
      now: new Date(now.getTime() + 30 * 60 * 1000),
      force: true,
    });
    expect(forced.alerted).toBe(true);
    expect(emailMock).toHaveBeenCalledTimes(2);
  });

  it("does not start cooldown and reports all_dispatch_failed when every channel throws", async () => {
    const now = new Date();
    process.env.OPS_WALLET_REFUND_RETRY_ALERT_SLACK_WEBHOOK = "https://hooks.slack.test/dead";
    process.env.OPS_WALLET_REFUND_RETRY_ALERT_PAGERDUTY_ROUTING_KEY = "pd-dead-key";
    for (let i = 0; i < 4; i++) {
      await seedAttempt({ organizationId: testOrgAId, smsExhaustedAt: now });
    }

    emailMock.mockRejectedValueOnce(new Error("smtp down"));
    slackMock.mockRejectedValueOnce(new Error("slack down"));
    pagerDutyMock.mockRejectedValueOnce(new Error("pd down"));

    const first = await runWalletTopupRefundRetryExhaustionOpsAlertJob({
      threshold: 3,
      windowHours: 1,
      cooldownHours: 1,
      recipients: ["ops@example.com"],
      now,
    });
    expect(first.alerted).toBe(false);
    expect(first.reason).toBe("all_dispatch_failed");
    expect(first.recipientsAttempted).toBe(1);
    expect(first.recipientsEmailed).toBe(0);
    expect(first.slackAttempted).toBe(true);
    expect(first.slackPosted).toBe(false);
    expect(first.pagerDutyAttempted).toBe(true);
    expect(first.pagerDutyTriggered).toBe(false);

    // Cooldown was NOT started — the next tick must retry rather than
    // swallow the page for an hour. This time, channels succeed.
    const second = await runWalletTopupRefundRetryExhaustionOpsAlertJob({
      threshold: 3,
      windowHours: 1,
      cooldownHours: 1,
      recipients: ["ops@example.com"],
      now: new Date(now.getTime() + 60 * 1000),
    });
    expect(second.alerted).toBe(true);
    expect(second.reason).toBeUndefined();
    expect(second.recipientsEmailed).toBe(1);
  });
});

describe("runWalletTopupRefundRetryExhaustionOpsAlertJob — no recipients or chat", () => {
  it("returns no_recipients_or_chat without throwing when nothing is configured", async () => {
    const now = new Date();
    for (let i = 0; i < 4; i++) {
      await seedAttempt({ organizationId: testOrgAId, smsExhaustedAt: now });
    }

    const res = await runWalletTopupRefundRetryExhaustionOpsAlertJob({
      threshold: 3,
      windowHours: 1,
      recipients: [],
      now,
    });

    expect(res.alerted).toBe(false);
    expect(res.reason).toBe("no_recipients_or_chat");
    expect(res.breachedBreakdown).toHaveLength(1);
    expect(emailMock).not.toHaveBeenCalled();
    expect(slackMock).not.toHaveBeenCalled();
    expect(pagerDutyMock).not.toHaveBeenCalled();
  });

  it("still alerts via Slack/PagerDuty when only chat targets are configured (no email recipients)", async () => {
    const now = new Date();
    process.env.OPS_WALLET_REFUND_RETRY_ALERT_SLACK_WEBHOOK = "https://hooks.slack.test/dedicated";
    for (let i = 0; i < 3; i++) {
      await seedAttempt({ organizationId: testOrgAId, smsExhaustedAt: now });
    }

    const res = await runWalletTopupRefundRetryExhaustionOpsAlertJob({
      threshold: 3,
      windowHours: 1,
      recipients: [],
      now,
    });

    expect(res.alerted).toBe(true);
    expect(res.recipientsAttempted).toBe(0);
    expect(res.slackAttempted).toBe(true);
    expect(res.slackPosted).toBe(true);
    expect(slackMock).toHaveBeenCalledTimes(1);
    expect(slackMock.mock.calls[0][0].webhookUrl).toBe("https://hooks.slack.test/dedicated");
  });
});

describe("runWalletTopupRefundRetryExhaustionOpsAlertJob — env-driven defaults", () => {
  it("threshold + window + cooldown + sample size fall back to env vars when unset", async () => {
    const now = new Date();
    process.env.OPS_WALLET_REFUND_RETRY_EXHAUSTION_THRESHOLD = "2";
    process.env.OPS_WALLET_REFUND_RETRY_EXHAUSTION_WINDOW_HOURS = "2";
    process.env.OPS_WALLET_REFUND_RETRY_EXHAUSTION_COOLDOWN_HOURS = "4";
    process.env.OPS_WALLET_REFUND_RETRY_EXHAUSTION_SAMPLE_SIZE = "7";
    process.env.OPS_ALERT_EMAILS = "ops@example.com";
    for (let i = 0; i < 2; i++) {
      await seedAttempt({ organizationId: testOrgAId, smsExhaustedAt: now });
    }

    const res = await runWalletTopupRefundRetryExhaustionOpsAlertJob({ now });

    expect(res.alerted).toBe(true);
    expect(res.threshold).toBe(2);
    expect(res.windowHours).toBe(2);
    expect(res.cooldownHours).toBe(4);
    expect(res.sampleSize).toBe(7);
    expect(res.recipientsEmailed).toBe(1);
  });

  it("exposes sane hardcoded defaults when no overrides at all", () => {
    expect(DEFAULT_OPS_WALLET_REFUND_RETRY_EXHAUSTION_THRESHOLD).toBeGreaterThan(0);
    expect(DEFAULT_OPS_WALLET_REFUND_RETRY_EXHAUSTION_WINDOW_HOURS).toBeGreaterThan(0);
    expect(DEFAULT_OPS_WALLET_REFUND_RETRY_EXHAUSTION_COOLDOWN_HOURS).toBeGreaterThan(0);
    expect(DEFAULT_OPS_WALLET_REFUND_RETRY_EXHAUSTION_SAMPLE_SIZE).toBeGreaterThan(0);
  });
});

describe("loadWalletTopupRefundRetryExhaustionBreakdown", () => {
  it("groups by org, joins org name, dedups distinct error samples, caps to sampleSize", async () => {
    const now = new Date();
    await seedAttempt({ organizationId: testOrgAId, smsExhaustedAt: now, lastSmsError: "err-A" });
    await seedAttempt({ organizationId: testOrgAId, smsExhaustedAt: now, lastSmsError: "err-A" });
    await seedAttempt({ organizationId: testOrgAId, smsExhaustedAt: now, lastSmsError: "err-B" });
    await seedAttempt({ organizationId: testOrgAId, smsExhaustedAt: now, lastSmsError: "err-C" });
    await seedAttempt({ organizationId: testOrgBId, whatsappExhaustedAt: now, lastWhatsappError: "wa-1" });

    const since = new Date(now.getTime() - 60 * 60 * 1000);
    const breakdown = await loadWalletTopupRefundRetryExhaustionBreakdown({
      since,
      sampleSize: 2,
    });

    const aRow = breakdown.find((b) => b.organizationId === testOrgAId);
    const bRow = breakdown.find((b) => b.organizationId === testOrgBId);
    expect(aRow).toBeDefined();
    expect(aRow!.organizationName).toBe(testOrgAName);
    expect(aRow!.smsExhausted).toBe(4);
    expect(aRow!.whatsappExhausted).toBe(0);
    expect(aRow!.rowsExhausted).toBe(4);
    // Distinct dedup → 3 distinct errors observed but capped to 2.
    expect(aRow!.sampleErrors).toHaveLength(2);
    expect(aRow!.sampleErrors.every((s) => s.channel === "sms")).toBe(true);

    expect(bRow).toBeDefined();
    expect(bRow!.organizationName).toBe(testOrgBName);
    expect(bRow!.whatsappExhausted).toBe(1);
    expect(bRow!.sampleErrors).toEqual([
      expect.objectContaining({ channel: "whatsapp", message: "wa-1" }),
    ]);
  });
});
