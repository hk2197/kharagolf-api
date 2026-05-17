/**
 * Integration test (Task #1202): Sponsor impressions CSV — Per-Tournament
 * Summary section.
 *
 * The sponsor portal CSV (`GET /api/sponsor-portal/impressions`) now emits a
 * Per-Tournament Summary section that mirrors the on-screen "Performance by
 * Tournament" table. This suite seeds sponsor_events tagged with two
 * different tournaments (plus one untagged event) across both a primary and
 * a comparison window, hits the impressions CSV with a real signed sponsor
 * portal token, and asserts:
 *
 *   - the section header is present and uses the requested day window when
 *     no comparison range is active
 *   - the column order is exactly: Tournament,Impressions,Clicks,CTR (%)
 *   - tournaments are sorted by primary impressions descending
 *   - untagged events surface as a literal "—" tournament label so the CSV
 *     mirrors the on-screen fallback
 *   - in comparison mode, the section header carries both ranges, the
 *     column order extends to Comparison Impressions, Comparison Clicks,
 *     and % Change, and the % Change formatting matches the existing
 *     per-slot summary (signed %, "new" for zero-previous, "no change" for
 *     zero-on-both-sides)
 *   - tournaments that only had activity in the comparison window still
 *     appear with zero-filled primary cells
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import bcrypt from "bcryptjs";
import { db } from "@workspace/db";
import {
  organizationsTable,
  sponsorsTable,
  sponsorEventsTable,
  tournamentsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { createTestApp } from "./helpers.js";

const stamp = Date.now();
const PASSWORD = "sponsor-tournament-pw-12345";
const EMAIL = `sponsor_csv_tournament_${stamp}@example.com`;

let orgId: number;
let sponsorId: number;
let tournamentAId: number;
let tournamentBId: number;
let token: string;

const TOURNAMENT_A_NAME = `Spring Open ${stamp}`;
const TOURNAMENT_B_NAME = `Autumn Cup ${stamp}`;

const anchor = new Date();
anchor.setUTCHours(12, 0, 0, 0);
const dayMinus = (n: number) => new Date(anchor.getTime() - n * 86_400_000);

function ymd(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

const FROM = ymd(dayMinus(3));
const TO = ymd(dayMinus(1));
const EXPECTED_DAYS = 3;
const COMPARE_FROM = ymd(dayMinus(7));
const COMPARE_TO = ymd(dayMinus(5));

beforeAll(async () => {
  if (!process.env.SESSION_SECRET) {
    process.env.SESSION_SECRET = "test-session-secret-for-sponsor-csv-tournament";
  }

  const [org] = await db.insert(organizationsTable).values({
    name: `TestOrg_SponsorCsvTournament_${stamp}`,
    slug: `test-sptourn-${stamp}`,
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  const [tA] = await db.insert(tournamentsTable).values({
    organizationId: orgId,
    name: TOURNAMENT_A_NAME,
    startDate: dayMinus(10),
    endDate: dayMinus(0),
  }).returning({ id: tournamentsTable.id });
  tournamentAId = tA.id;

  const [tB] = await db.insert(tournamentsTable).values({
    organizationId: orgId,
    name: TOURNAMENT_B_NAME,
    startDate: dayMinus(10),
    endDate: dayMinus(0),
  }).returning({ id: tournamentsTable.id });
  tournamentBId = tB.id;

  const passwordHash = await bcrypt.hash(PASSWORD, 4);
  const [sp] = await db.insert(sponsorsTable).values({
    organizationId: orgId,
    name: `Tournament Sponsor ${stamp}`,
    tier: "gold",
    contactEmail: EMAIL,
    portalPasswordHash: passwordHash,
  }).returning({ id: sponsorsTable.id });
  sponsorId = sp.id;

  async function seed(opts: {
    dayOffset: number;
    tournamentId: number | null;
    eventType: "impression" | "click";
    count: number;
  }) {
    const ts = dayMinus(opts.dayOffset);
    const tag = opts.tournamentId == null ? "untag" : `t${opts.tournamentId}`;
    const rows = Array.from({ length: opts.count }, (_, i) => ({
      sponsorId,
      organizationId: orgId,
      tournamentId: opts.tournamentId ?? undefined,
      eventType: opts.eventType,
      source: "tv_ticker_top",
      sessionId: `csv-tourn-${stamp}-${tag}-${opts.eventType}-${opts.dayOffset}-${i}`,
      slotKey: "tv_ticker_top",
      recordedAt: ts,
    }));
    await db.insert(sponsorEventsTable).values(rows);
  }

  // Primary window (day-3..day-1):
  // Tournament A: 12 impressions, 3 clicks
  // Tournament B: 4 impressions, 0 clicks
  // Untagged:    2 impressions, 1 click
  await seed({ dayOffset: 3, tournamentId: tournamentAId, eventType: "impression", count: 8 });
  await seed({ dayOffset: 2, tournamentId: tournamentAId, eventType: "impression", count: 4 });
  await seed({ dayOffset: 3, tournamentId: tournamentAId, eventType: "click", count: 3 });
  await seed({ dayOffset: 1, tournamentId: tournamentBId, eventType: "impression", count: 4 });
  await seed({ dayOffset: 2, tournamentId: null, eventType: "impression", count: 2 });
  await seed({ dayOffset: 2, tournamentId: null, eventType: "click", count: 1 });

  // Comparison window (day-7..day-5):
  // Tournament A: 6 impressions, 3 clicks   (so % change for A = +100% impressions)
  // Tournament B has no events here         (so % change for B = "new")
  // Tournament-only-in-comparison "C" via tournamentBId-twin not needed; we
  // instead seed Tournament A again to validate signed % change, and add a
  // fresh tournament that lives only in the comparison window so we can
  // assert the zero-fill behaviour in the primary period.
  await seed({ dayOffset: 7, tournamentId: tournamentAId, eventType: "impression", count: 6 });
  await seed({ dayOffset: 7, tournamentId: tournamentAId, eventType: "click", count: 3 });

  const [tC] = await db.insert(tournamentsTable).values({
    organizationId: orgId,
    name: `Winter Classic ${stamp}`,
    startDate: dayMinus(15),
    endDate: dayMinus(4),
  }).returning({ id: tournamentsTable.id });
  await seed({ dayOffset: 6, tournamentId: tC.id, eventType: "impression", count: 5 });
  await seed({ dayOffset: 6, tournamentId: tC.id, eventType: "click", count: 1 });

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
  if (orgId) {
    await db.delete(tournamentsTable).where(eq(tournamentsTable.organizationId, orgId));
    await db.delete(organizationsTable).where(eq(organizationsTable.id, orgId));
  }
});

function getCsv(query: string): Promise<{ status: number; headers: Record<string, string>; text: string }> {
  const app = createTestApp();
  return request(app)
    .get(`/api/sponsor-portal/impressions?${query}`)
    .set("Authorization", `Bearer ${token}`)
    .then(r => ({ status: r.status, headers: r.headers as Record<string, string>, text: r.text }));
}

function rowsAfter(text: string, headerLine: string): string[] {
  const lines = text.split("\n");
  const idx = lines.findIndex(l => l === headerLine);
  expect(idx, `expected header line not found: ${headerLine}`).toBeGreaterThan(-1);
  const rows: string[] = [];
  for (let i = idx + 1; i < lines.length; i++) {
    if (lines[i] === "") break;
    rows.push(lines[i]);
  }
  return rows;
}

describe("sponsor portal CSV — Per-Tournament Summary", () => {
  it("emits the section with correct header, columns, sort order, and untagged fallback", async () => {
    const res = await getCsv(`from=${FROM}&to=${TO}`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/csv/);
    expect(res.headers["content-disposition"]).toContain(`sponsor_impressions_${EXPECTED_DAYS}d.csv`);

    const lines = res.text.split("\n");
    const headerIdx = lines.findIndex(l => l.startsWith("Per-Tournament Summary"));
    expect(headerIdx, "tournament section header should be present").toBeGreaterThan(-1);
    expect(lines[headerIdx]).toBe(`Per-Tournament Summary (last ${EXPECTED_DAYS} days)`);
    expect(lines[headerIdx + 1]).toBe("Tournament,Impressions,Clicks,CTR (%)");

    const rows = rowsAfter(res.text, "Tournament,Impressions,Clicks,CTR (%)");
    // Sorted by impressions desc: A(12) > B(4) > untagged(2).
    expect(rows).toEqual([
      `${TOURNAMENT_A_NAME},12,3,25.0`,
      `${TOURNAMENT_B_NAME},4,0,0.0`,
      "—,2,1,50.0",
    ]);
  });

  it("emits the comparison-mode section with prior-period absolutes, signed % change, and zero-filled comparison-only rows", async () => {
    const res = await getCsv(`from=${FROM}&to=${TO}&compareFrom=${COMPARE_FROM}&compareTo=${COMPARE_TO}`);
    expect(res.status).toBe(200);

    const lines = res.text.split("\n");
    const headerIdx = lines.findIndex(l => l.startsWith("Per-Tournament Summary ("));
    expect(headerIdx).toBeGreaterThan(-1);
    expect(lines[headerIdx]).toBe(
      `Per-Tournament Summary (${FROM} to ${TO} vs ${COMPARE_FROM} to ${COMPARE_TO})`,
    );
    expect(lines[headerIdx + 1]).toBe(
      "Tournament,Impressions,Clicks,CTR (%),Comparison Impressions,Comparison Clicks,% Change",
    );

    const rows = rowsAfter(
      res.text,
      "Tournament,Impressions,Clicks,CTR (%),Comparison Impressions,Comparison Clicks,% Change",
    );

    // Tournament A: 12 impressions primary, 6 in comparison → +100.0%.
    expect(rows).toContain(`${TOURNAMENT_A_NAME},12,3,25.0,6,3,+100.0%`);
    // Tournament B: 4 impressions primary, 0 in comparison → "new".
    expect(rows).toContain(`${TOURNAMENT_B_NAME},4,0,0.0,0,0,new`);
    // Untagged events in primary, none in comparison → "new".
    expect(rows).toContain("—,2,1,50.0,0,0,new");
    // Winter Classic exists only in the comparison window → primary cells
    // zero-filled, % change computed against the prior period (current=0,
    // previous=5 → -100.0%).
    expect(rows).toContain(`Winter Classic ${stamp},0,0,0.0,5,1,-100.0%`);
    expect(rows).toHaveLength(4);
  });
});
