/**
 * Task #897 — Pin the contract for the sponsor portal date-range comparison
 * on `GET /api/sponsor-portal/me`.
 *
 * The comparison feature was added on top of the existing `/me` analytics
 * payload and the underlying delta math (per-period totals + per-slot Δ
 * columns in the UI) is entirely keyed off the optional `comparison` field
 * the endpoint now returns. Without coverage, regressions to:
 *
 *   • the no-params default (must remain `comparison: null` for back-compat),
 *   • `?compare=previous` (auto-computed prior period of equal length,
 *     immediately preceding the primary range),
 *   • explicit `?compareFrom=…&compareTo=…` (custom prior range), or
 *   • the 400 response when the comparison range is malformed,
 *
 * could ship unnoticed and silently break sponsor-facing KPI deltas.
 *
 * Strategy: stand up a real org + sponsor with a portal password, log in
 * through the public POST `/sponsor-portal/login` to obtain a signed token
 * (so we exercise the real auth path), seed `sponsor_events` rows in three
 * disjoint windows (primary, the immediately-preceding "previous" window,
 * and a custom prior window), then assert the shape and totals returned by
 * `/me` for each comparison mode.
 *
 * All seeded events live strictly in the past relative to a UTC midday
 * anchor so the suite is independent of the wall-clock hour at which CI
 * runs.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import bcrypt from "bcryptjs";
import {
  db,
  organizationsTable,
  sponsorsTable,
  sponsorEventsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { createTestApp } from "../../tests/helpers.js";

const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const PASSWORD = "sponsor-cmp-pw-12345";
const EMAIL = `sponsor_cmp_${stamp}@example.com`;
const SLOT = "tv_ticker_top";

let orgId: number;
let sponsorId: number;
let token: string;

// Anchor at today @ 12:00 UTC. All seeded events are at offsets ≥ 1 day so
// they are guaranteed in the past.
const anchor = new Date();
anchor.setUTCHours(12, 0, 0, 0);
const dayMinus = (n: number) => new Date(anchor.getTime() - n * 86_400_000);
const ymd = (d: Date) => d.toISOString().slice(0, 10);

// Ranges used by the tests. PRIMARY covers offsets 1..7 (last 7 days).
//   PRIMARY     : day-7 .. day-1   (covers the auto `?days=7` window)
//   PREVIOUS    : day-14 .. day-8  (the prior 7 days, what compare=previous
//                                   should auto-compute)
//   CUSTOM_PRIOR: day-30 .. day-24 (an arbitrary explicit prior window)
const PRIMARY_FROM = ymd(dayMinus(7));
const PRIMARY_TO = ymd(dayMinus(1));
const PREV_FROM = ymd(dayMinus(14));
const PREV_TO = ymd(dayMinus(8));
const CUSTOM_FROM = ymd(dayMinus(30));
const CUSTOM_TO = ymd(dayMinus(24));

// Per-window event counts. Chosen so the three windows have distinguishable
// totals and so we can verify the comparison payload picks up the right
// rows for each mode.
const PRIMARY_IMPRESSIONS = 12;
const PRIMARY_CLICKS = 3;
const PREV_IMPRESSIONS = 8;
const PREV_CLICKS = 1;
const CUSTOM_IMPRESSIONS = 5;
const CUSTOM_CLICKS = 2;

async function seed(opts: { dayOffset: number; eventType: "impression" | "click"; count: number }) {
  const ts = dayMinus(opts.dayOffset);
  const rows = Array.from({ length: opts.count }, (_, i) => ({
    sponsorId,
    organizationId: orgId,
    eventType: opts.eventType,
    source: SLOT,
    sessionId: `cmp-${stamp}-${opts.eventType}-${opts.dayOffset}-${i}`,
    slotKey: SLOT,
    recordedAt: ts,
  }));
  await db.insert(sponsorEventsTable).values(rows);
}

beforeAll(async () => {
  if (!process.env.SESSION_SECRET) {
    process.env.SESSION_SECRET = "test-session-secret-for-sponsor-comparison";
  }

  const [org] = await db.insert(organizationsTable).values({
    name: `TestOrg_SponsorCmp_${stamp}`,
    slug: `test-spcmp-${stamp}`,
  }).returning({ id: organizationsTable.id });
  orgId = org.id;

  const passwordHash = await bcrypt.hash(PASSWORD, 4);
  const [sp] = await db.insert(sponsorsTable).values({
    organizationId: orgId,
    name: `Comparison Sponsor ${stamp}`,
    tier: "gold",
    contactEmail: EMAIL,
    portalPasswordHash: passwordHash,
  }).returning({ id: sponsorsTable.id });
  sponsorId = sp.id;

  // Primary window — day-4 sits squarely inside day-7..day-1.
  await seed({ dayOffset: 4, eventType: "impression", count: PRIMARY_IMPRESSIONS });
  await seed({ dayOffset: 4, eventType: "click", count: PRIMARY_CLICKS });
  // Previous (auto) window — day-10 sits inside day-14..day-8.
  await seed({ dayOffset: 10, eventType: "impression", count: PREV_IMPRESSIONS });
  await seed({ dayOffset: 10, eventType: "click", count: PREV_CLICKS });
  // Custom prior window — day-27 sits inside day-30..day-24.
  await seed({ dayOffset: 27, eventType: "impression", count: CUSTOM_IMPRESSIONS });
  await seed({ dayOffset: 27, eventType: "click", count: CUSTOM_CLICKS });

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

function getMe(query: string) {
  const app = createTestApp();
  return request(app)
    .get(`/api/sponsor-portal/me${query ? `?${query}` : ""}`)
    .set("Authorization", `Bearer ${token}`);
}

describe("GET /api/sponsor-portal/me — date-range comparison", () => {
  it("returns comparison: null when no compare params are supplied (back-compat)", async () => {
    const res = await getMe("days=7");
    expect(res.status).toBe(200);
    expect(res.body.analytics).toBeTruthy();
    expect(res.body.analytics.days).toBe(7);
    expect(res.body.analytics.impressions).toBe(PRIMARY_IMPRESSIONS);
    expect(res.body.analytics.clicks).toBe(PRIMARY_CLICKS);
    // The key must be present (so the FE can rely on `comparison in payload`)
    // and explicitly null — never undefined or omitted.
    expect("comparison" in res.body).toBe(true);
    expect(res.body.comparison).toBeNull();
  });

  it("?compare=previous returns a prior period of equal length, immediately preceding the primary range", async () => {
    const res = await getMe("days=7&compare=previous");
    expect(res.status).toBe(200);

    expect(res.body.analytics.impressions).toBe(PRIMARY_IMPRESSIONS);
    expect(res.body.analytics.clicks).toBe(PRIMARY_CLICKS);

    const cmp = res.body.comparison;
    expect(cmp).toBeTruthy();

    // Equal length to the primary range (the FE displays "Previous period"
    // and expects the day count to match for an apples-to-apples Δ).
    expect(cmp.days).toBe(res.body.analytics.days);

    // The auto-computed previous window must capture the day-10 events and
    // none of the day-4 (primary) or day-27 (custom prior) events.
    expect(cmp.impressions).toBe(PREV_IMPRESSIONS);
    expect(cmp.clicks).toBe(PREV_CLICKS);

    // It must end on or before the primary range begins (immediately
    // preceding — the timestamps differ by 1 ms, which collapses to the
    // same date string when both are formatted as YYYY-MM-DD).
    expect(cmp.to <= res.body.analytics.from).toBe(true);
    // And the comparison's start must be strictly older than the primary's
    // start (i.e. the comparison really is in the past, not the same range).
    expect(cmp.from < res.body.analytics.from).toBe(true);
  });

  it("honours explicit compareFrom/compareTo for a custom prior range", async () => {
    const res = await getMe(
      `from=${PRIMARY_FROM}&to=${PRIMARY_TO}&compareFrom=${CUSTOM_FROM}&compareTo=${CUSTOM_TO}`,
    );
    expect(res.status).toBe(200);

    // Primary mirrors the explicit window.
    expect(res.body.analytics.from).toBe(PRIMARY_FROM);
    expect(res.body.analytics.to).toBe(PRIMARY_TO);
    expect(res.body.analytics.impressions).toBe(PRIMARY_IMPRESSIONS);
    expect(res.body.analytics.clicks).toBe(PRIMARY_CLICKS);

    // Comparison reflects the explicit custom window — picks up day-27 only.
    const cmp = res.body.comparison;
    expect(cmp).toBeTruthy();
    expect(cmp.from).toBe(CUSTOM_FROM);
    expect(cmp.to).toBe(CUSTOM_TO);
    expect(cmp.impressions).toBe(CUSTOM_IMPRESSIONS);
    expect(cmp.clicks).toBe(CUSTOM_CLICKS);

    // The per-slot breakdown for the comparison range must surface the
    // single seeded slot so the FE can render Δ rows.
    const cmpSlotImps = (cmp.bySlot as Array<{ slotKey: string; eventType: string; total: number }>)
      .filter(r => r.slotKey === SLOT && r.eventType === "impression")
      .reduce((s, r) => s + r.total, 0);
    expect(cmpSlotImps).toBe(CUSTOM_IMPRESSIONS);
  });

  it("returns 400 when the comparison range is invalid (compareFrom > compareTo)", async () => {
    // Swap the bounds so the range is inverted.
    const res = await getMe(
      `from=${PRIMARY_FROM}&to=${PRIMARY_TO}&compareFrom=${CUSTOM_TO}&compareTo=${CUSTOM_FROM}`,
    );
    expect(res.status).toBe(400);
    expect(String(res.body.error || "")).toMatch(/comparison/i);
  });
});
