/**
 * Integration test (Task #889): Sponsor impressions CSV — Per-Day Per-Slot
 * CTR Trend section.
 *
 * The sponsor portal CSV (`GET /api/sponsor-portal/impressions`) emits three
 * sections: raw events, per-slot summary, and per-day per-slot CTR trend.
 * The trend section is brand-new and was previously uncovered, so a refactor
 * could silently break the section header, column order, or per-day CTR
 * aggregation that sponsors plot in their own tools.
 *
 * This suite seeds sponsor_events across multiple UTC days and slots, hits
 * the impressions CSV with a real signed sponsor portal token, and asserts:
 *   - the trend section header is present and uses the requested day window
 *   - the trend column order is exactly: Date,Slot,Impressions,Clicks,CTR (%)
 *   - rows are sorted by (day asc, slotKey asc)
 *   - per-day per-slot impressions/clicks aggregate correctly
 *   - CTR is computed per (day, slot) with one-decimal formatting and 0.0
 *     when there are impressions but no clicks
 *   - rows for slots that only have data on one day do NOT appear on the
 *     other days (i.e. the trend isn't carrying zeros across days)
 *
 * Time-window safety: all seeded events live strictly in the PAST (offsets
 * 1..3 days). The endpoint is queried with explicit from/to anchored to
 * those same UTC days, so the suite is independent of wall-clock time and
 * cannot flake based on what hour CI happens to start at.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import bcrypt from "bcryptjs";
import { db } from "@workspace/db";
import {
  organizationsTable,
  sponsorsTable,
  sponsorEventsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { createTestApp } from "./helpers.js";

const stamp = Date.now();
const SLOT_A = "tv_ticker_top";
const SLOT_B = "leaderboard_bug";
const PASSWORD = "sponsor-trend-pw-12345";
const EMAIL = `sponsor_csv_trend_${stamp}@example.com`;

let orgId: number;
let sponsorId: number;
let token: string;

// Anchor day = today at 12:00 UTC. Seeded events use offsets 1..3 days
// from this anchor, which are guaranteed to be in the past regardless of
// the wall-clock hour at which the suite runs.
const anchor = new Date();
anchor.setUTCHours(12, 0, 0, 0);
const dayMinus = (n: number) => new Date(anchor.getTime() - n * 86_400_000);

function ymd(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// Date range that fully contains seeded events (offsets 1..3) but is itself
// in the past, so we don't depend on `new Date()` at request time.
const FROM = ymd(dayMinus(3));
const TO = ymd(dayMinus(1));
// `days` reported in CSV = round((to+1day - from) / 1day). With from=day-3
// and to=day-1, that's 3.
const EXPECTED_DAYS = 3;

beforeAll(async () => {
  if (!process.env.SESSION_SECRET) {
    process.env.SESSION_SECRET = "test-session-secret-for-sponsor-csv-trend";
  }

  const [org] = await db.insert(organizationsTable).values({
    name: `TestOrg_SponsorCsvTrend_${stamp}`,
    slug: `test-spcsv-${stamp}`,
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  const passwordHash = await bcrypt.hash(PASSWORD, 4);
  const [sp] = await db.insert(sponsorsTable).values({
    organizationId: orgId,
    name: `Trend Sponsor ${stamp}`,
    tier: "gold",
    contactEmail: EMAIL,
    portalPasswordHash: passwordHash,
  }).returning({ id: sponsorsTable.id });
  sponsorId = sp.id;

  // Helper to insert N events of a given type for a given (day, slot).
  async function seed(opts: { dayOffset: number; slotKey: string; eventType: "impression" | "click"; count: number }) {
    const ts = dayMinus(opts.dayOffset);
    const rows = Array.from({ length: opts.count }, (_, i) => ({
      sponsorId,
      organizationId: orgId,
      eventType: opts.eventType,
      source: opts.slotKey,
      sessionId: `csv-trend-${stamp}-${opts.slotKey}-${opts.eventType}-${opts.dayOffset}-${i}`,
      slotKey: opts.slotKey,
      recordedAt: ts,
    }));
    await db.insert(sponsorEventsTable).values(rows);
  }

  // Day -3: SLOT_A → 10 impressions / 2 clicks (CTR 20.0)
  //         SLOT_B → 4 impressions / 1 click   (CTR 25.0)
  await seed({ dayOffset: 3, slotKey: SLOT_A, eventType: "impression", count: 10 });
  await seed({ dayOffset: 3, slotKey: SLOT_A, eventType: "click",      count: 2 });
  await seed({ dayOffset: 3, slotKey: SLOT_B, eventType: "impression", count: 4 });
  await seed({ dayOffset: 3, slotKey: SLOT_B, eventType: "click",      count: 1 });

  // Day -2: SLOT_A → 5 impressions / 0 clicks (CTR 0.0)
  //         SLOT_B has no events on this day — must NOT appear in trend.
  await seed({ dayOffset: 2, slotKey: SLOT_A, eventType: "impression", count: 5 });

  // Day -1: SLOT_B → 8 impressions / 4 clicks (CTR 50.0)
  //         SLOT_A has no events on this day — must NOT appear in trend.
  await seed({ dayOffset: 1, slotKey: SLOT_B, eventType: "impression", count: 8 });
  await seed({ dayOffset: 1, slotKey: SLOT_B, eventType: "click",      count: 4 });

  // Comparison window (day -7..-5, outside the primary from/to). Used by the
  // comparison-mode trend test only; the default trend tests above never
  // include these days because their from/to is day-3..day-1.
  // Day -7: SLOT_A → 6 impressions / 3 clicks (CTR 50.0)
  // Day -5: SLOT_B → 2 impressions / 0 clicks (CTR 0.0)
  await seed({ dayOffset: 7, slotKey: SLOT_A, eventType: "impression", count: 6 });
  await seed({ dayOffset: 7, slotKey: SLOT_A, eventType: "click",      count: 3 });
  await seed({ dayOffset: 5, slotKey: SLOT_B, eventType: "impression", count: 2 });

  const app = createTestApp();
  const loginRes = await request(app)
    .post("/api/sponsor-portal/login")
    .send({ email: EMAIL, password: PASSWORD });
  expect(loginRes.status).toBe(200);
  expect(typeof loginRes.body.token).toBe("string");
  token = loginRes.body.token;
});

afterAll(async () => {
  if (sponsorId) {
    await db.delete(sponsorEventsTable).where(eq(sponsorEventsTable.sponsorId, sponsorId));
    await db.delete(sponsorsTable).where(eq(sponsorsTable.id, sponsorId));
  }
  if (orgId) await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
});

function expectedTrendRows(): string[] {
  const day1 = ymd(dayMinus(1));
  const day2 = ymd(dayMinus(2));
  const day3 = ymd(dayMinus(3));
  // Per-day rows are sorted by slotKey ascending. Compute the slot order
  // dynamically so the assertion stays correct if SLOT_A/SLOT_B are renamed.
  const aFirst = SLOT_A.localeCompare(SLOT_B) < 0;
  const rows: string[] = [];
  if (aFirst) {
    rows.push(`${day3},${SLOT_A},10,2,20.0`);
    rows.push(`${day3},${SLOT_B},4,1,25.0`);
  } else {
    rows.push(`${day3},${SLOT_B},4,1,25.0`);
    rows.push(`${day3},${SLOT_A},10,2,20.0`);
  }
  rows.push(`${day2},${SLOT_A},5,0,0.0`);
  rows.push(`${day1},${SLOT_B},8,4,50.0`);
  return rows;
}

function getCsv(): Promise<{ status: number; headers: Record<string, string>; text: string }> {
  const app = createTestApp();
  return request(app)
    .get(`/api/sponsor-portal/impressions?from=${FROM}&to=${TO}`)
    .set("Authorization", `Bearer ${token}`)
    .then(r => ({ status: r.status, headers: r.headers as Record<string, string>, text: r.text }));
}

describe("sponsor portal CSV — Per-Day Per-Slot CTR Trend", () => {
  it("emits the trend section with correct headers, ordering, aggregation, and CTR", async () => {
    const res = await getCsv();

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/csv/);
    expect(res.headers["content-disposition"]).toContain(
      `sponsor_impressions_${EXPECTED_DAYS}d.csv`,
    );

    const lines = res.text.split("\n");

    // Locate the trend section header.
    const trendHeaderIdx = lines.findIndex(l => l.startsWith("Per-Day Per-Slot CTR Trend"));
    expect(trendHeaderIdx, "trend section header should be present").toBeGreaterThan(-1);
    expect(lines[trendHeaderIdx]).toBe(
      `Per-Day Per-Slot CTR Trend (last ${EXPECTED_DAYS} days)`,
    );

    // Column header immediately follows the section header.
    expect(lines[trendHeaderIdx + 1]).toBe("Date,Slot,Impressions,Clicks,CTR (%)");

    // Collect trend data rows up to EOF or next blank/section.
    const trendRows: string[] = [];
    for (let i = trendHeaderIdx + 2; i < lines.length; i++) {
      const line = lines[i];
      if (line === "") break;
      trendRows.push(line);
    }

    expect(trendRows).toEqual(expectedTrendRows());
  });

  it("returns identical trend rows when the same range is requested twice", async () => {
    const [a, b] = await Promise.all([getCsv(), getCsv()]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);

    function trendRowsOf(text: string): string[] {
      const lines = text.split("\n");
      const headerIdx = lines.findIndex(l => l === "Date,Slot,Impressions,Clicks,CTR (%)");
      expect(headerIdx).toBeGreaterThan(-1);
      const rows: string[] = [];
      for (let i = headerIdx + 1; i < lines.length; i++) {
        if (lines[i] === "") break;
        rows.push(lines[i]);
      }
      return rows;
    }

    const rowsA = trendRowsOf(a.text);
    const rowsB = trendRowsOf(b.text);
    expect(rowsA).toEqual(rowsB);
    // 4 expected rows: 2 (day -3) + 1 (day -2) + 1 (day -1).
    expect(rowsA).toHaveLength(4);
  });

  it("emits a comparison-mode trend section with parallel comparison columns and zero-fills missing rows", async () => {
    const compareFrom = ymd(dayMinus(7));
    const compareTo = ymd(dayMinus(5));
    const app = createTestApp();
    const res = await request(app)
      .get(`/api/sponsor-portal/impressions?from=${FROM}&to=${TO}&compareFrom=${compareFrom}&compareTo=${compareTo}`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    const lines = res.text.split("\n");

    const headerIdx = lines.findIndex(l => l.startsWith("Per-Day Per-Slot CTR Trend ("));
    expect(headerIdx).toBeGreaterThan(-1);
    expect(lines[headerIdx]).toBe(
      `Per-Day Per-Slot CTR Trend (${FROM} to ${TO} vs ${compareFrom} to ${compareTo})`,
    );
    expect(lines[headerIdx + 1]).toBe(
      "Date,Slot,Impressions,Clicks,CTR (%),Comparison Impressions,Comparison Clicks,Comparison CTR (%),% Change",
    );

    const trendRows: string[] = [];
    for (let i = headerIdx + 2; i < lines.length; i++) {
      if (lines[i] === "") break;
      trendRows.push(lines[i]);
    }

    const day1 = ymd(dayMinus(1));
    const day2 = ymd(dayMinus(2));
    const day3 = ymd(dayMinus(3));
    const day5 = ymd(dayMinus(5));
    const day7 = ymd(dayMinus(7));

    // Primary-only rows (comparison side zero-filled).
    expect(trendRows).toContain(`${day3},${SLOT_A},10,2,20.0,0,0,0.0,new`);
    expect(trendRows).toContain(`${day3},${SLOT_B},4,1,25.0,0,0,0.0,new`);
    expect(trendRows).toContain(`${day2},${SLOT_A},5,0,0.0,0,0,0.0,new`);
    expect(trendRows).toContain(`${day1},${SLOT_B},8,4,50.0,0,0,0.0,new`);
    // Comparison-only rows (primary side zero-filled).
    expect(trendRows).toContain(`${day7},${SLOT_A},0,0,0.0,6,3,50.0,-100.0%`);
    expect(trendRows).toContain(`${day5},${SLOT_B},0,0,0.0,2,0,0.0,-100.0%`);
    expect(trendRows).toHaveLength(6);

    // Rows are sorted ascending by (day, slot).
    const dayCol = trendRows.map(r => r.split(",")[0]);
    const sorted = [...dayCol].sort();
    expect(dayCol).toEqual(sorted);
  });
});
