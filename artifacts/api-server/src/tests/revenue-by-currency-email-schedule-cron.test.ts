/**
 * Tests for the revenue-by-currency digest cron (Task #824).
 *
 * The per-currency revenue pivot mirrors the org-wide levy-ledger digest
 * pattern: a cron poller calls `runDueRevenueByCurrencyEmailSchedules`,
 * which delegates to `runOneRevenueByCurrencyEmailSchedule` for every
 * enabled+due row. The org-ledger cron already has comprehensive coverage
 * in `levy-ledger-org-email-schedule-cron.test.ts`; this file pins down
 * the equivalent guarantees for the revenue-by-currency path so a
 * regression in `buildRevenueByCurrencyCsv` or the cron loop cannot
 * silently ship.
 *
 * Concretely it asserts:
 *   - `runDueRevenueByCurrencyEmailSchedules` only picks up enabled rows
 *     whose `next_run_at` has elapsed; paused (enabled=false) and
 *     future-scheduled rows are left strictly untouched.
 *   - On success a 'sent' history row is recorded with accurate row /
 *     currency counts, recipients, and the period span. The schedule's
 *     `lastSentAt` advances to the run time and `nextRunAt` rolls forward
 *     by ~7 days (weekly) anchored to 07:00 UTC.
 *   - On mailer failure a 'failed' history row is written with the error
 *     message, but the cadence STILL advances so a broken inbox doesn't
 *     get hammered every poll cycle.
 *   - The CSV body the cron actually mails is byte-identical to what the
 *     on-demand `/revenue-by-currency.csv` endpoint returns for the same
 *     period — the on-demand contract and the digest contract must not
 *     drift apart.
 *
 * The mailer is mocked so no SMTP traffic happens; the database is real.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

vi.mock("../lib/mailer.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/mailer.js")>("../lib/mailer.js");
  return {
    ...actual,
    sendRevenueByCurrencyScheduleEmail: vi.fn(async () => undefined),
  };
});

import request from "supertest";
import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  financialLedgerTable,
  revenueByCurrencyEmailSchedulesTable,
  revenueByCurrencyEmailRunsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { createTestApp, type TestUser } from "./helpers.js";
import {
  runOneRevenueByCurrencyEmailSchedule,
  runDueRevenueByCurrencyEmailSchedules,
} from "../routes/member-360.js";
import { sendRevenueByCurrencyScheduleEmail } from "../lib/mailer.js";

const mailerMock = vi.mocked(sendRevenueByCurrencyScheduleEmail);

let testOrgId: number;
let adminUserId: number;
let admin: TestUser;
let appAsAdmin: ReturnType<typeof createTestApp>;

const BASE = () => `/api/organizations/${testOrgId}/members-360`;

async function clearActivity() {
  await db.delete(financialLedgerTable)
    .where(eq(financialLedgerTable.organizationId, testOrgId));
  await db.delete(revenueByCurrencyEmailSchedulesTable)
    .where(eq(revenueByCurrencyEmailSchedulesTable.organizationId, testOrgId));
}

/**
 * Insert one financial_ledger row dated `daysAgo` days before now so we can
 * deterministically place activity inside or outside a given period window.
 */
async function makeLedger(opts: {
  currency: string;
  eventType: "pos_sale" | "booking_fee" | "membership_due" | "lesson_fee";
  amount: string;
  tax?: string;
  daysAgo?: number;
  orgId?: number;
}) {
  const when = new Date(Date.now() - (opts.daysAgo ?? 1) * 24 * 60 * 60 * 1000);
  await db.insert(financialLedgerTable).values({
    organizationId: opts.orgId ?? testOrgId,
    eventType: opts.eventType,
    sourceModule: "test",
    description: `${opts.eventType} ${opts.currency}`,
    amount: opts.amount,
    currency: opts.currency,
    taxAmount: opts.tax ?? "0",
    transactionDate: when.toISOString(),
  });
}

beforeAll(async () => {
  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const [org] = await db.insert(organizationsTable).values({
    name: `TestOrg_RevByCurrencyCron_${stamp}`,
    slug: `test-org-rev-currency-cron-${stamp}`,
  }).returning({ id: organizationsTable.id });
  testOrgId = org.id;

  const [a] = await db.insert(appUsersTable).values({
    replitUserId: `test-rev-currency-cron-admin-${stamp}`,
    username: `rev_currency_cron_admin_${stamp}`,
    email: `rev_currency_admin_${stamp}@example.com`,
    displayName: "Rev Currency Admin",
    role: "org_admin",
    organizationId: testOrgId,
  }).returning({ id: appUsersTable.id });
  adminUserId = a.id;

  admin = {
    id: adminUserId,
    username: `rev_currency_cron_admin_${stamp}`,
    displayName: "Rev Currency Admin",
    role: "org_admin",
    organizationId: testOrgId,
  };
  appAsAdmin = createTestApp(admin);
});

afterAll(async () => {
  await clearActivity();
  if (adminUserId) {
    await db.delete(appUsersTable).where(eq(appUsersTable.id, adminUserId));
  }
  if (testOrgId) {
    await db.delete(organizationsTable).where(eq(organizationsTable.id, testOrgId));
  }
});

beforeEach(async () => {
  mailerMock.mockReset();
  mailerMock.mockResolvedValue(undefined);
  await clearActivity();
});

// ─────────────────────────────────────────────────────────────────────────
// runOneRevenueByCurrencyEmailSchedule — success
// ─────────────────────────────────────────────────────────────────────────
describe("runOneRevenueByCurrencyEmailSchedule — success", () => {
  it("writes a 'sent' history row, advances cadence, and emits a CSV that matches the on-demand endpoint", async () => {
    // Three currencies × a few event types inside the period, plus one
    // very old row that must NOT show up — locks the period filter in.
    await makeLedger({ currency: "INR", eventType: "pos_sale",       amount: "100.00", tax: "18.00", daysAgo: 1 });
    await makeLedger({ currency: "INR", eventType: "booking_fee",    amount: "50.00",  tax: "9.00",  daysAgo: 2 });
    await makeLedger({ currency: "USD", eventType: "pos_sale",       amount: "20.00",  tax: "0.00",  daysAgo: 1 });
    await makeLedger({ currency: "EUR", eventType: "membership_due", amount: "75.00",  tax: "0.00",  daysAgo: 3 });
    // Outside period: lastSentAt is 5 days ago, this row is 30 days ago.
    await makeLedger({ currency: "INR", eventType: "pos_sale",       amount: "999.00", tax: "0.00",  daysAgo: 30 });

    // Insert the schedule directly so we can pin lastSentAt to a known
    // value — the cron uses lastSentAt as periodStart and `now` as
    // periodEnd, and we need to know periodStart to call the on-demand
    // endpoint with the same window for the byte-equality check.
    const lastSent = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
    const [schedule] = await db.insert(revenueByCurrencyEmailSchedulesTable).values({
      organizationId: testOrgId,
      frequency: "weekly",
      recipients: ["treasurer@example.com"],
      enabled: true,
      lastSentAt: lastSent,
      nextRunAt: new Date(Date.now() - 60 * 60 * 1000),
    }).returning();

    const result = await runOneRevenueByCurrencyEmailSchedule(schedule.id);
    expect(result.status).toBe("sent");
    expect(result.recipients).toEqual(["treasurer@example.com"]);
    // 3 currencies × the event types we used inside the period:
    //   INR: pos_sale + booking_fee = 2
    //   USD: pos_sale                = 1
    //   EUR: membership_due          = 1
    // Total grouped rows = 4, distinct currencies = 3.
    expect(result.rowCount).toBe(4);
    expect(result.currencyCount).toBe(3);

    expect(mailerMock).toHaveBeenCalledTimes(1);
    const arg = mailerMock.mock.calls[0][0];
    expect(arg.to).toEqual(["treasurer@example.com"]);
    expect(arg.frequency).toBe("weekly");
    expect(arg.rowCount).toBe(4);
    expect(arg.currencyCount).toBe(3);
    expect(typeof arg.csv).toBe("string");

    // Header + 4 data rows. Trailing newline produces an empty entry
    // when split on \n, so filter empties before counting.
    const lines = (arg.csv as string).split(/\r?\n/).filter((l) => l.length > 0);
    expect(lines.length).toBe(1 + 4);
    expect(lines[0]).toBe("currency,event_type,revenue,tax,event_count");

    // History row matches what was sent.
    const [run] = await db.select().from(revenueByCurrencyEmailRunsTable)
      .where(eq(revenueByCurrencyEmailRunsTable.scheduleId, schedule.id));
    expect(run.status).toBe("sent");
    expect(run.errorMessage).toBeNull();
    expect(run.rowCount).toBe(4);
    expect(run.currencyCount).toBe(3);
    expect(run.recipients).toEqual(["treasurer@example.com"]);
    expect(run.periodStart).not.toBeNull();
    expect(run.periodEnd).not.toBeNull();
    // periodStart is the original lastSentAt we pinned.
    expect(new Date(run.periodStart!).getTime()).toBe(lastSent.getTime());

    // Cadence advanced ~7 days into the future, anchored to 07:00 UTC.
    const [sched] = await db.select().from(revenueByCurrencyEmailSchedulesTable)
      .where(eq(revenueByCurrencyEmailSchedulesTable.id, schedule.id));
    expect(sched.lastSentAt).not.toBeNull();
    expect(new Date(sched.lastSentAt!).getTime()).toBeGreaterThan(lastSent.getTime());
    expect(new Date(sched.nextRunAt!).getTime()).toBeGreaterThan(Date.now() + 6 * 24 * 60 * 60 * 1000);
    expect(new Date(sched.nextRunAt!).getUTCHours()).toBe(7);

    // CSV body equals what the on-demand endpoint returns for the same
    // window. Use the periodStart/periodEnd recorded in history so the
    // window is identical to what the cron actually used.
    const fromIso = new Date(run.periodStart!).toISOString();
    const toIso = new Date(run.periodEnd!).toISOString();
    const onDemand = await request(appAsAdmin)
      .get(`${BASE()}/revenue-by-currency.csv`)
      .query({ from: fromIso, to: toIso });
    expect(onDemand.status).toBe(200);
    expect(onDemand.text).toBe(arg.csv);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// runOneRevenueByCurrencyEmailSchedule — failure
// ─────────────────────────────────────────────────────────────────────────
describe("runOneRevenueByCurrencyEmailSchedule — failure", () => {
  it("records 'failed' with the error and STILL advances the cadence", async () => {
    mailerMock.mockRejectedValueOnce(new Error("smtp blew up"));

    await makeLedger({ currency: "INR", eventType: "pos_sale", amount: "10.00", daysAgo: 1 });

    const past = new Date(Date.now() - 60 * 60 * 1000);
    const [schedule] = await db.insert(revenueByCurrencyEmailSchedulesTable).values({
      organizationId: testOrgId,
      frequency: "weekly",
      recipients: ["t@example.com"],
      enabled: true,
      nextRunAt: past,
    }).returning();

    const result = await runOneRevenueByCurrencyEmailSchedule(schedule.id);
    expect(result.status).toBe("failed");
    expect(result.errorMessage).toBe("smtp blew up");

    const [run] = await db.select().from(revenueByCurrencyEmailRunsTable)
      .where(eq(revenueByCurrencyEmailRunsTable.scheduleId, schedule.id));
    expect(run.status).toBe("failed");
    expect(run.errorMessage).toBe("smtp blew up");
    // Counts are still recorded — the CSV was built before the mailer
    // rejected, so we shouldn't lose that signal in history.
    expect(run.rowCount).toBe(1);
    expect(run.currencyCount).toBe(1);

    const [sched] = await db.select().from(revenueByCurrencyEmailSchedulesTable)
      .where(eq(revenueByCurrencyEmailSchedulesTable.id, schedule.id));
    expect(sched.lastSentAt).not.toBeNull();
    // Weekly cadence still advances ~7 days even on failure so we don't
    // hammer a broken inbox every poll cycle.
    expect(new Date(sched.nextRunAt!).getTime()).toBeGreaterThan(Date.now() + 6 * 24 * 60 * 60 * 1000);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// runDueRevenueByCurrencyEmailSchedules — selection
// ─────────────────────────────────────────────────────────────────────────
describe("runDueRevenueByCurrencyEmailSchedules — selection", () => {
  it("processes only enabled+due rows; paused and future rows are untouched", async () => {
    // Each schedule needs its own org because the table has
    // UNIQUE (organization_id) — only one schedule per org.
    const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const [pausedOrg] = await db.insert(organizationsTable).values({
      name: `TestOrg_RevByCurrencyCron_Paused_${stamp}`,
      slug: `test-org-rev-currency-cron-paused-${stamp}`,
    }).returning({ id: organizationsTable.id });
    const [futureOrg] = await db.insert(organizationsTable).values({
      name: `TestOrg_RevByCurrencyCron_Future_${stamp}`,
      slug: `test-org-rev-currency-cron-future-${stamp}`,
    }).returning({ id: organizationsTable.id });

    try {
      // Seed activity in each org so the digest has rows to count.
      await makeLedger({ currency: "INR", eventType: "pos_sale", amount: "10.00", daysAgo: 1, orgId: testOrgId });
      await makeLedger({ currency: "INR", eventType: "pos_sale", amount: "10.00", daysAgo: 1, orgId: pausedOrg.id });
      await makeLedger({ currency: "INR", eventType: "pos_sale", amount: "10.00", daysAgo: 1, orgId: futureOrg.id });

      const past = new Date(Date.now() - 60 * 60 * 1000);
      const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

      const [dueSched] = await db.insert(revenueByCurrencyEmailSchedulesTable).values({
        organizationId: testOrgId,
        frequency: "weekly",
        recipients: ["due@example.com"],
        enabled: true,
        nextRunAt: past,
      }).returning();
      const [pausedSched] = await db.insert(revenueByCurrencyEmailSchedulesTable).values({
        organizationId: pausedOrg.id,
        frequency: "weekly",
        recipients: ["paused@example.com"],
        enabled: false,
        nextRunAt: past,
      }).returning();
      const [futureSched] = await db.insert(revenueByCurrencyEmailSchedulesTable).values({
        organizationId: futureOrg.id,
        frequency: "weekly",
        recipients: ["future@example.com"],
        enabled: true,
        nextRunAt: future,
      }).returning();

      await runDueRevenueByCurrencyEmailSchedules();

      // Only the 'due' schedule fires. Row-scope by filtering mailer
      // calls to OUR test's recipients (Task #1808 / #2266) — the cron
      // sweeps schedules globally, so a sibling test leaking a due
      // schedule could otherwise bump the total count.
      const ourRecipients = new Set(["due@example.com", "paused@example.com", "future@example.com"]);
      const ourCalls = mailerMock.mock.calls.filter((c) => {
        const to = (c[0] as { to: string[] }).to;
        return to.some((addr) => ourRecipients.has(addr));
      });
      expect(ourCalls).toHaveLength(1);
      expect((ourCalls[0][0] as { to: string[] }).to).toEqual(["due@example.com"]);

      const dueRuns = await db.select().from(revenueByCurrencyEmailRunsTable)
        .where(eq(revenueByCurrencyEmailRunsTable.scheduleId, dueSched.id));
      expect(dueRuns).toHaveLength(1);
      expect(dueRuns[0].status).toBe("sent");

      const pausedRuns = await db.select().from(revenueByCurrencyEmailRunsTable)
        .where(eq(revenueByCurrencyEmailRunsTable.scheduleId, pausedSched.id));
      expect(pausedRuns).toHaveLength(0);

      const futureRuns = await db.select().from(revenueByCurrencyEmailRunsTable)
        .where(eq(revenueByCurrencyEmailRunsTable.scheduleId, futureSched.id));
      expect(futureRuns).toHaveLength(0);

      // Paused schedule still paused, cadence untouched.
      const [pausedAfter] = await db.select().from(revenueByCurrencyEmailSchedulesTable)
        .where(eq(revenueByCurrencyEmailSchedulesTable.id, pausedSched.id));
      expect(pausedAfter.enabled).toBe(false);
      expect(pausedAfter.lastSentAt).toBeNull();
      expect(new Date(pausedAfter.nextRunAt!).getTime()).toBe(past.getTime());

      // Future schedule's nextRunAt preserved exactly.
      const [futureAfter] = await db.select().from(revenueByCurrencyEmailSchedulesTable)
        .where(eq(revenueByCurrencyEmailSchedulesTable.id, futureSched.id));
      expect(futureAfter.lastSentAt).toBeNull();
      expect(new Date(futureAfter.nextRunAt!).getTime()).toBe(future.getTime());
    } finally {
      // Cleanup the extra orgs (cascades wipe schedules, runs, and ledger rows).
      await db.delete(organizationsTable).where(eq(organizationsTable.id, pausedOrg.id));
      await db.delete(organizationsTable).where(eq(organizationsTable.id, futureOrg.id));
    }
  });
});
