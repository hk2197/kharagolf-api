/**
 * Task #1657 — tests for the per-reason "why did rounds get skipped?"
 * breakdown that powers the new super-admin dashboard chart.
 *
 * Two surfaces are covered here:
 *   1. The aggregation in `getManualEntryAlertHealthSummary` — it must
 *      always emit one bucket per `MANUAL_ENTRY_NOTIFY_REASONS` value
 *      (even at count 0, so the chart never silently classifies a
 *      known reason as "other"), it must split the row counts by
 *      `status='skipped'` vs `status='failed'`, and it must respect
 *      the 7d / 30d window boundary.
 *   2. The `buildLogSearchUrl` deep-link template wiring — when the
 *      env var is set every canonical bucket gets a URL with `{reason}`
 *      and `{sinceDays}` substituted; when unset every bucket's URL is
 *      null.
 *   3. End-to-end persistence — calling `notifyManualEntryRound` for a
 *      muted org writes one row to `manual_entry_notify_skips` so the
 *      aggregation has data to read.
 *
 * The push and mailer transports are mocked so the suite never touches
 * Expo / SMTP. Postgres is real (matches the rest of the api-server
 * integration test suite).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";

// Mailer / push are mocked at the module boundary so notifyManualEntryRound
// can run end-to-end without a network. Hoisted via vi.hoisted so the mock
// factories can be referenced before the test module is evaluated.
const { sendPushToUsersMock, sendManualEntryAlertEmailMock } = vi.hoisted(() => ({
  sendPushToUsersMock: vi.fn(async (
    userIds: number[],
    _title: string,
    _body: string,
    _data?: Record<string, unknown>,
  ) => ({ attempted: userIds.length, sent: userIds.length, failed: 0, invalid: 0 })),
  sendManualEntryAlertEmailMock: vi.fn(async (_args: unknown) => {}),
}));

vi.mock("../push.js", () => ({ sendPushToUsers: sendPushToUsersMock }));
vi.mock("../mailer.js", () => ({
  sendManualEntryAlertEmail: sendManualEntryAlertEmailMock,
  classifyMailerError: () => "transient",
}));

import {
  db,
  manualEntryNotifySkipsTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import {
  notifyManualEntryRound,
  MANUAL_ENTRY_NOTIFY_REASONS,
} from "../manualEntryNotify.js";
import { getManualEntryAlertHealthSummary } from "../manualEntryAlertHealth.js";

const createdSkipRowIds: number[] = [];

beforeAll(async () => {
  // Wipe any lingering rows from previous runs so window aggregations
  // start clean (other tests don't write to this table).
  await db.delete(manualEntryNotifySkipsTable);
});

afterEach(() => {
  sendPushToUsersMock.mockClear();
  sendManualEntryAlertEmailMock.mockClear();
});

afterAll(async () => {
  if (createdSkipRowIds.length > 0) {
    await db
      .delete(manualEntryNotifySkipsTable)
      .where(inArray(manualEntryNotifySkipsTable.id, createdSkipRowIds));
  }
  // Defence in depth — also wipe anything our notify calls inserted via
  // the production code path so a re-run doesn't accumulate state.
  await db.delete(manualEntryNotifySkipsTable);
});

// `submission_id` has no FK constraint (the table just records the
// id we observed at notify time), so seeding with a synthetic value
// is fine for aggregation tests — we don't care which submission
// the row points at, only that the row exists.
let fakeSubmissionCounter = 9_900_000;
async function seedSkipRow(opts: {
  reason: string;
  status?: "skipped" | "failed";
  daysAgo?: number;
}): Promise<number> {
  const createdAt = opts.daysAgo == null
    ? undefined
    : new Date(Date.now() - opts.daysAgo * 24 * 60 * 60 * 1000);
  const [row] = await db.insert(manualEntryNotifySkipsTable).values({
    submissionId: ++fakeSubmissionCounter,
    status: opts.status ?? "skipped",
    reason: opts.reason,
    ...(createdAt ? { createdAt } : {}),
  }).returning({ id: manualEntryNotifySkipsTable.id });
  createdSkipRowIds.push(row.id);
  return row.id;
}

describe("manualEntryAlertHealth — skipReasonBreakdown", () => {
  beforeEach(async () => {
    // Each test owns a clean breakdown table.
    await db.delete(manualEntryNotifySkipsTable);
  });

  it("always emits one bucket per canonical reason, even at count 0", async () => {
    const summary = await getManualEntryAlertHealthSummary();

    for (const win of ["7d", "30d"] as const) {
      const window = summary.skipReasonBreakdown[win];
      expect(window.totalCount).toBe(0);
      // Every canonical reason MUST appear — the chart relies on this so
      // it never silently buckets a known reason into "other".
      const canonical = window.buckets.filter((b) => !b.isOther).map((b) => b.reason);
      expect(canonical.sort()).toEqual([...MANUAL_ENTRY_NOTIFY_REASONS].sort());
      // No "other" bucket when there are zero unknown rows.
      expect(window.buckets.some((b) => b.isOther)).toBe(false);
      for (const b of window.buckets) {
        expect(b.count).toBe(0);
        expect(b.skippedCount).toBe(0);
        expect(b.failedCount).toBe(0);
      }
    }
  });

  it("counts rows per reason, splits by status, and respects the 7d / 30d window boundary", async () => {
    // 7d window: 2x org_muted (skipped), 1x org_lookup_failed (failed),
    //            1x below_threshold (skipped, but 8 days old → 30d only).
    await seedSkipRow({ reason: "org_muted", status: "skipped", daysAgo: 1 });
    await seedSkipRow({ reason: "org_muted", status: "skipped", daysAgo: 3 });
    await seedSkipRow({ reason: "org_lookup_failed", status: "failed", daysAgo: 2 });
    await seedSkipRow({ reason: "below_threshold", status: "skipped", daysAgo: 8 });

    const summary = await getManualEntryAlertHealthSummary();

    const w7 = summary.skipReasonBreakdown["7d"];
    const w30 = summary.skipReasonBreakdown["30d"];

    // 7d totals — 8d-old below_threshold row is excluded.
    expect(w7.totalCount).toBe(3);
    const muted7 = w7.buckets.find((b) => b.reason === "org_muted")!;
    expect(muted7.count).toBe(2);
    expect(muted7.skippedCount).toBe(2);
    expect(muted7.failedCount).toBe(0);

    const lookup7 = w7.buckets.find((b) => b.reason === "org_lookup_failed")!;
    expect(lookup7.count).toBe(1);
    expect(lookup7.skippedCount).toBe(0);
    expect(lookup7.failedCount).toBe(1);

    const below7 = w7.buckets.find((b) => b.reason === "below_threshold")!;
    expect(below7.count).toBe(0);

    // 30d totals — picks up everything.
    expect(w30.totalCount).toBe(4);
    const below30 = w30.buckets.find((b) => b.reason === "below_threshold")!;
    expect(below30.count).toBe(1);
    expect(below30.skippedCount).toBe(1);
  });

  it("surfaces an 'other' bucket only when an unknown reason value is present", async () => {
    await seedSkipRow({ reason: "org_muted", status: "skipped", daysAgo: 1 });
    await seedSkipRow({ reason: "totally_made_up", status: "failed", daysAgo: 1 });

    const summary = await getManualEntryAlertHealthSummary();
    const other = summary.skipReasonBreakdown["7d"].buckets.find((b) => b.isOther);
    expect(other).toBeDefined();
    expect(other!.reason).toBe("other");
    expect(other!.count).toBe(1);
    expect(other!.failedCount).toBe(1);
    // Unknown buckets never get a deep-link — the log query can't filter
    // on "anything not in this set".
    expect(other!.logSearchUrl).toBeNull();

    // Crucially, the canonical bucket for the known reason is NOT
    // collapsed into "other" — it stays its own row.
    const muted = summary.skipReasonBreakdown["7d"].buckets.find((b) => b.reason === "org_muted")!;
    expect(muted.isOther).toBe(false);
    expect(muted.count).toBe(1);
  });

  describe("logSearchUrl template", () => {
    const ORIG = process.env.MANUAL_ENTRY_NOTIFY_LOG_SEARCH_URL_TEMPLATE;
    afterEach(() => {
      if (ORIG === undefined) delete process.env.MANUAL_ENTRY_NOTIFY_LOG_SEARCH_URL_TEMPLATE;
      else process.env.MANUAL_ENTRY_NOTIFY_LOG_SEARCH_URL_TEMPLATE = ORIG;
    });

    it("returns null logSearchUrl on every bucket when the env template is unset", async () => {
      delete process.env.MANUAL_ENTRY_NOTIFY_LOG_SEARCH_URL_TEMPLATE;
      const summary = await getManualEntryAlertHealthSummary();
      for (const b of summary.skipReasonBreakdown["7d"].buckets) {
        expect(b.logSearchUrl).toBeNull();
      }
    });

    it("substitutes {reason} (URL-encoded) and {sinceDays} into the configured template", async () => {
      process.env.MANUAL_ENTRY_NOTIFY_LOG_SEARCH_URL_TEMPLATE =
        "https://logs.example.com/?q=reason%3D{reason}&from=now-{sinceDays}d";
      const summary = await getManualEntryAlertHealthSummary();
      const muted7 = summary.skipReasonBreakdown["7d"].buckets.find((b) => b.reason === "org_muted")!;
      expect(muted7.logSearchUrl).toBe(
        "https://logs.example.com/?q=reason%3Dorg_muted&from=now-7d",
      );
      const muted30 = summary.skipReasonBreakdown["30d"].buckets.find((b) => b.reason === "org_muted")!;
      expect(muted30.logSearchUrl).toBe(
        "https://logs.example.com/?q=reason%3Dorg_muted&from=now-30d",
      );
    });
  });
});

describe("manualEntryAlertHealth — skipReasonDailySeries (Task #2065)", () => {
  beforeEach(async () => {
    await db.delete(manualEntryNotifySkipsTable);
  });

  it("emits a dense 31-entry day axis (30d window + today, inclusive) and one canonical series per known reason", async () => {
    const summary = await getManualEntryAlertHealthSummary();
    const series = summary.skipReasonDailySeries;

    expect(series.sinceDays).toBe(30);
    // [since, today] inclusive — exactly 31 day labels.
    expect(series.days).toHaveLength(31);
    // Day labels are unique, sorted oldest → newest, and `YYYY-MM-DD`.
    for (const d of series.days) expect(d).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect([...series.days].sort()).toEqual(series.days);
    expect(new Set(series.days).size).toBe(series.days.length);

    // Every canonical reason MUST be represented as its own series so
    // the chart legend never silently buckets a known reason into
    // "other" (mirrors the bar-breakdown rule).
    const canonical = series.series.filter((s) => !s.isOther).map((s) => s.reason);
    expect(canonical.sort()).toEqual([...MANUAL_ENTRY_NOTIFY_REASONS].sort());
    // No "other" series until an unknown reason value shows up.
    expect(series.series.some((s) => s.isOther)).toBe(false);

    // Each canonical series is zero-filled to the day axis length.
    for (const s of series.series) {
      expect(s.counts).toHaveLength(series.days.length);
      expect(s.total).toBe(0);
      for (const c of s.counts) expect(c).toBe(0);
    }
    expect(series.totalCount).toBe(0);
  });

  it("buckets rows by their UTC day, splits across reasons, and excludes rows older than the 30d window", async () => {
    // Two rows on day-1, one on day-2 (different reason), one on day-5
    // (same reason as day-1), and an out-of-window row 35 days back.
    await seedSkipRow({ reason: "org_muted", status: "skipped", daysAgo: 1 });
    await seedSkipRow({ reason: "org_muted", status: "skipped", daysAgo: 1 });
    await seedSkipRow({ reason: "org_lookup_failed", status: "failed", daysAgo: 2 });
    await seedSkipRow({ reason: "org_muted", status: "skipped", daysAgo: 5 });
    await seedSkipRow({ reason: "org_muted", status: "skipped", daysAgo: 35 });

    const summary = await getManualEntryAlertHealthSummary();
    const series = summary.skipReasonDailySeries;

    // Out-of-window row is dropped — totalCount counts only the 4
    // in-window rows.
    expect(series.totalCount).toBe(4);

    const muted = series.series.find((s) => s.reason === "org_muted")!;
    const lookup = series.series.find((s) => s.reason === "org_lookup_failed")!;
    expect(muted.total).toBe(3);
    expect(lookup.total).toBe(1);

    // Day index of "1 day ago" / "2 days ago" / "5 days ago" — derived
    // from the same UTC day-aligned axis the aggregator emits, so we
    // compare against `series.days` directly rather than re-deriving
    // the date math here.
    const dayOf = (daysAgo: number): number => {
      const t = new Date();
      const utcDay = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate() - daysAgo))
        .toISOString().slice(0, 10);
      const idx = series.days.indexOf(utcDay);
      expect(idx).toBeGreaterThanOrEqual(0);
      return idx;
    };
    expect(muted.counts[dayOf(1)]).toBe(2);
    expect(muted.counts[dayOf(5)]).toBe(1);
    expect(muted.counts[dayOf(2)]).toBe(0);
    expect(lookup.counts[dayOf(2)]).toBe(1);
    expect(lookup.counts[dayOf(1)]).toBe(0);

    // Other (uncharted) reasons stay zero-filled.
    const below = series.series.find((s) => s.reason === "below_threshold")!;
    expect(below.total).toBe(0);
    for (const c of below.counts) expect(c).toBe(0);
  });

  it("appends a single 'other' series only when an unrecognised reason value appears", async () => {
    await seedSkipRow({ reason: "totally_made_up", status: "failed", daysAgo: 1 });
    await seedSkipRow({ reason: "another_unknown", status: "skipped", daysAgo: 2 });
    await seedSkipRow({ reason: "org_muted", status: "skipped", daysAgo: 1 });

    const summary = await getManualEntryAlertHealthSummary();
    const series = summary.skipReasonDailySeries;

    // Exactly one "other" series — both unrecognised reasons collapse
    // into it (the chart can't render a separate line per arbitrary
    // string from the wild).
    const others = series.series.filter((s) => s.isOther);
    expect(others).toHaveLength(1);
    expect(others[0].reason).toBe("other");
    expect(others[0].total).toBe(2);

    // Canonical org_muted stays its own series — never collapsed.
    const muted = series.series.find((s) => s.reason === "org_muted" && !s.isOther)!;
    expect(muted.total).toBe(1);

    // totalCount sums both known and "other".
    expect(series.totalCount).toBe(3);
  });

  it("matches the 30d bar-breakdown total exactly so the two panels never disagree", async () => {
    await seedSkipRow({ reason: "org_muted", status: "skipped", daysAgo: 0 });
    await seedSkipRow({ reason: "org_muted", status: "skipped", daysAgo: 12 });
    await seedSkipRow({ reason: "org_lookup_failed", status: "failed", daysAgo: 28 });
    await seedSkipRow({ reason: "no_recipients", status: "skipped", daysAgo: 6 });

    const summary = await getManualEntryAlertHealthSummary();
    expect(summary.skipReasonDailySeries.totalCount)
      .toBe(summary.skipReasonBreakdown["30d"].totalCount);

    // Per-reason totals also agree with the bar bucket counts so the
    // legend's "X in 30d" and the bar bucket label can't drift.
    for (const bucket of summary.skipReasonBreakdown["30d"].buckets.filter((b) => !b.isOther)) {
      const seriesEntry = summary.skipReasonDailySeries.series
        .find((s) => s.reason === bucket.reason && !s.isOther)!;
      expect(seriesEntry.total).toBe(bucket.count);
    }
  });
});

describe("notifyManualEntryRound — skip persistence (Task #1657)", () => {
  beforeEach(async () => {
    await db.delete(manualEntryNotifySkipsTable);
  });

  it("persists exactly one manual_entry_notify_skips row per non-delivery call", async () => {
    // Pick a submission id that definitely doesn't exist — the function
    // returns `submission_not_found` and persists a row. This exercises
    // the production INSERT without needing a full org/tournament/
    // shots fixture (and without depending on transports running).
    const phantomSubmissionId = 999_999_999;
    const result = await notifyManualEntryRound(phantomSubmissionId);
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("submission_not_found");
    expect(sendPushToUsersMock).not.toHaveBeenCalled();
    expect(sendManualEntryAlertEmailMock).not.toHaveBeenCalled();

    const rows = await db
      .select()
      .from(manualEntryNotifySkipsTable)
      .where(eq(manualEntryNotifySkipsTable.submissionId, phantomSubmissionId));
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("skipped");
    expect(rows[0].reason).toBe("submission_not_found");

    // The row flows through to the aggregation under its canonical bucket
    // (NOT "other") — no silent classification of a known reason.
    const summary = await getManualEntryAlertHealthSummary();
    const bucket = summary.skipReasonBreakdown["7d"].buckets
      .find((b) => b.reason === "submission_not_found")!;
    expect(bucket.isOther).toBe(false);
    expect(bucket.count).toBeGreaterThanOrEqual(1);
    expect(bucket.skippedCount).toBeGreaterThanOrEqual(1);
  });
});
