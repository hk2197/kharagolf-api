/**
 * Unit + integration tests for the FX rate auto-refresh cron and the
 * realised / unrealised gain-loss split (Task #495).
 *
 * Covers:
 *   - fetchMidMarketRates: provider response shape parsing, base/self filter,
 *     non-success body handled as an error, malformed numbers dropped.
 *   - refreshAllOrgFxRates: per-org failure isolation — one bad org never
 *     aborts the rest, and snapshots land in fx_rates only for the orgs that
 *     succeeded.
 *   - summariseFxGainLossSplit: open foreign-currency exposure rolls up by
 *     levy currency, the booked rate is taken from the snapshot at-or-before
 *     the earliest open charge, and unrealised gain/loss = outstanding *
 *     (currentRate - bookedRate).
 *   - GET /currency-tax/fx-gain-loss returns both `realised` and `unrealised`
 *     sections with the seeded data the FX P&L tab consumes.
 *
 * The provider is mocked via vi.stubGlobal("fetch", …); the database is real
 * so the SQL aggregates and joins are exercised exactly as in production.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import { db } from "@workspace/db";
import {
  organizationsTable,
  appUsersTable,
  clubMembersTable,
  memberLeviesTable,
  memberLevyChargesTable,
  clubCurrencyProfilesTable,
  fxRatesTable,
  fxLedgerEntriesTable,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import {
  fetchMidMarketRates,
  refreshAllOrgFxRates,
  summariseFxGainLossSplit,
} from "../lib/fx.js";
import { createTestApp, type TestUser } from "./helpers.js";

const stamp = () => `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

const createdOrgIds: number[] = [];
const createdUserIds: number[] = [];
const createdMemberIds: number[] = [];
const createdLevyIds: number[] = [];
const createdProfileOrgIds: number[] = [];

function mockFetchOnce(handler: (url: string) => { ok: boolean; status?: number; body: unknown }) {
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    const r = handler(url);
    return {
      ok: r.ok,
      status: r.status ?? (r.ok ? 200 : 500),
      json: async () => r.body,
      headers: new Map(),
    } as unknown as Response;
  }));
}

afterAll(async () => {
  if (createdLevyIds.length) {
    await db.delete(memberLevyChargesTable).where(inArray(memberLevyChargesTable.levyId, createdLevyIds));
    await db.delete(memberLeviesTable).where(inArray(memberLeviesTable.id, createdLevyIds));
  }
  if (createdMemberIds.length) {
    await db.delete(clubMembersTable).where(inArray(clubMembersTable.id, createdMemberIds));
  }
  if (createdProfileOrgIds.length) {
    await db.delete(clubCurrencyProfilesTable)
      .where(inArray(clubCurrencyProfilesTable.organizationId, createdProfileOrgIds));
  }
  if (createdOrgIds.length) {
    await db.delete(fxLedgerEntriesTable).where(inArray(fxLedgerEntriesTable.organizationId, createdOrgIds));
  }
  if (createdUserIds.length) {
    await db.delete(appUsersTable).where(inArray(appUsersTable.id, createdUserIds));
  }
  if (createdOrgIds.length) {
    await db.delete(organizationsTable).where(inArray(organizationsTable.id, createdOrgIds));
  }
  // Strip every FX snapshot inserted by this suite so we don't leak rows
  // into other suites that read fx_rates. The refresh tests insert with
  // source="open.er-api.com" (the real provider tag the prod cron uses);
  // those rows are scoped to the (USD, INR/EUR) and (GBP, INR) pairs we
  // exercised, so we wipe them by source + pair to avoid touching any
  // snapshots a sibling suite may have legitimately inserted.
  await db.delete(fxRatesTable).where(eq(fxRatesTable.source, "test-fx-cron-and-pnl"));
  await db.delete(fxRatesTable).where(and(
    eq(fxRatesTable.source, "open.er-api.com"),
    inArray(fxRatesTable.baseCurrency, ["USD", "GBP"]),
    inArray(fxRatesTable.quoteCurrency, ["INR", "EUR"]),
  ));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ─── fetchMidMarketRates ───────────────────────────────────────────────────

describe("fetchMidMarketRates", () => {
  it("parses successful provider response and returns only requested quotes", async () => {
    mockFetchOnce(() => ({
      ok: true,
      body: {
        result: "success",
        rates: { USD: 1, INR: 84.5, EUR: 0.93, GBP: 0.78, JPY: 150.2 },
      },
    }));
    const out = await fetchMidMarketRates("USD", ["INR", "EUR", "USD" /* self should be filtered */]);
    expect(out).toEqual({ INR: 84.5, EUR: 0.93 });
  });

  it("throws when the provider returns a non-success body", async () => {
    mockFetchOnce(() => ({ ok: true, body: { result: "error", "error-type": "invalid-key" } }));
    await expect(fetchMidMarketRates("USD", ["INR"])).rejects.toThrow(/invalid-key/);
  });

  it("throws on HTTP failures", async () => {
    mockFetchOnce(() => ({ ok: false, status: 503, body: {} }));
    await expect(fetchMidMarketRates("USD", ["INR"])).rejects.toThrow(/HTTP 503/);
  });

  it("drops non-finite or non-positive rates from the response", async () => {
    mockFetchOnce(() => ({
      ok: true,
      body: {
        result: "success",
        rates: { INR: 84, EUR: 0, GBP: -1, JPY: Number.NaN, AED: 3.67 },
      },
    }));
    const out = await fetchMidMarketRates("USD", ["INR", "EUR", "GBP", "JPY", "AED"]);
    expect(out).toEqual({ INR: 84, AED: 3.67 });
  });

  it("returns {} without calling the provider when no quote currencies are requested", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const out = await fetchMidMarketRates("USD", ["USD"]);
    expect(out).toEqual({});
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ─── refreshAllOrgFxRates ──────────────────────────────────────────────────

describe("refreshAllOrgFxRates", () => {
  let okOrgId: number;
  let badOrgId: number;
  let emptyOrgId: number;

  beforeAll(async () => {
    const t = stamp();
    const [okOrg] = await db.insert(organizationsTable).values({
      name: `FxCronOk_${t}`, slug: `fx-cron-ok-${t}`,
    }).returning({ id: organizationsTable.id });
    const [badOrg] = await db.insert(organizationsTable).values({
      name: `FxCronBad_${t}`, slug: `fx-cron-bad-${t}`,
    }).returning({ id: organizationsTable.id });
    const [emptyOrg] = await db.insert(organizationsTable).values({
      name: `FxCronEmpty_${t}`, slug: `fx-cron-empty-${t}`,
    }).returning({ id: organizationsTable.id });
    okOrgId = okOrg.id; badOrgId = badOrg.id; emptyOrgId = emptyOrg.id;
    createdOrgIds.push(okOrgId, badOrgId, emptyOrgId);

    await db.insert(clubCurrencyProfilesTable).values([
      { organizationId: okOrgId,    baseCurrency: "USD", displayCurrencies: ["INR", "EUR"] },
      { organizationId: badOrgId,   baseCurrency: "GBP", displayCurrencies: ["INR"] },
      { organizationId: emptyOrgId, baseCurrency: "INR", displayCurrencies: ["INR"] }, // self only → skipped
    ]);
    createdProfileOrgIds.push(okOrgId, badOrgId, emptyOrgId);
  });

  beforeEach(async () => {
    // Wipe FX snapshots from previous iterations so assertions are deterministic.
    await db.delete(fxRatesTable).where(eq(fxRatesTable.source, "open.er-api.com"));
  });

  it("isolates per-org failures: a failing org does not abort the rest", async () => {
    mockFetchOnce((url) => {
      if (url.includes("/USD")) {
        return { ok: true, body: { result: "success", rates: { INR: 84, EUR: 0.93 } } };
      }
      if (url.includes("/GBP")) {
        return { ok: false, status: 502, body: {} };
      }
      return { ok: true, body: { result: "success", rates: {} } };
    });

    const result = await refreshAllOrgFxRates();

    // Only the USD-base org should have refreshed; the GBP-base org failed,
    // and the INR-base org has no foreign display currencies to fetch.
    expect(result.orgs).toBe(1);
    expect(result.pairs).toBe(2);

    const usdRates = await db.select().from(fxRatesTable)
      .where(and(eq(fxRatesTable.baseCurrency, "USD"), eq(fxRatesTable.source, "open.er-api.com")));
    const gbpRates = await db.select().from(fxRatesTable)
      .where(and(eq(fxRatesTable.baseCurrency, "GBP"), eq(fxRatesTable.source, "open.er-api.com")));

    expect(usdRates.map(r => r.quoteCurrency).sort()).toEqual(["EUR", "INR"]);
    expect(gbpRates).toHaveLength(0);
  });

  it("counts pairs correctly when every org succeeds", async () => {
    mockFetchOnce((url) => {
      if (url.includes("/USD")) return { ok: true, body: { result: "success", rates: { INR: 84, EUR: 0.93 } } };
      if (url.includes("/GBP")) return { ok: true, body: { result: "success", rates: { INR: 108 } } };
      return { ok: true, body: { result: "success", rates: {} } };
    });
    const result = await refreshAllOrgFxRates();
    expect(result.orgs).toBe(2);
    expect(result.pairs).toBe(3); // 2 (USD) + 1 (GBP)
  });
});

// ─── summariseFxGainLossSplit + GET /fx-gain-loss ──────────────────────────

describe("summariseFxGainLossSplit + FX P&L endpoint", () => {
  let orgId: number;
  let adminUserId: number;
  let memberId: number;
  let levyId: number;
  const earliestChargeAt = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // 30d ago
  const beforeEarliest    = new Date(earliestChargeAt.getTime() - 24 * 60 * 60 * 1000);
  const afterEarliest     = new Date(earliestChargeAt.getTime() + 24 * 60 * 60 * 1000);
  let admin: TestUser;
  let adminApp: ReturnType<typeof createTestApp>;

  beforeAll(async () => {
    const t = stamp();
    const [org] = await db.insert(organizationsTable).values({
      name: `FxPnlOrg_${t}`, slug: `fx-pnl-org-${t}`,
    }).returning({ id: organizationsTable.id });
    orgId = org.id; createdOrgIds.push(orgId);

    const [adminRow] = await db.insert(appUsersTable).values({
      replitUserId: `fx-pnl-admin-${t}`,
      username: `fx_pnl_admin_${t}`,
      email: `fx_pnl_admin_${t}@example.com`,
      displayName: "FX P&L Admin",
      role: "org_admin",
      organizationId: orgId,
    }).returning({ id: appUsersTable.id });
    adminUserId = adminRow.id; createdUserIds.push(adminUserId);

    await db.insert(clubCurrencyProfilesTable).values({
      organizationId: orgId, baseCurrency: "INR", displayCurrencies: ["INR", "USD"],
    });
    createdProfileOrgIds.push(orgId);

    const [member] = await db.insert(clubMembersTable).values({
      organizationId: orgId, firstName: "Open", lastName: "Exposure",
      email: `open_${t}@example.com`,
    }).returning({ id: clubMembersTable.id });
    memberId = member.id; createdMemberIds.push(memberId);

    // USD-denominated levy with one unpaid charge of $200 created 30 days ago.
    const [levy] = await db.insert(memberLeviesTable).values({
      organizationId: orgId,
      name: `Foreign Levy ${t}`,
      amount: "200.00", currency: "USD",
      status: "applied", appliedAt: earliestChargeAt,
    }).returning({ id: memberLeviesTable.id });
    levyId = levy.id; createdLevyIds.push(levyId);

    await db.insert(memberLevyChargesTable).values({
      levyId, clubMemberId: memberId,
      amount: "200.00", status: "unpaid",
      paidAmount: "0", refundedAmount: "0",
      createdAt: earliestChargeAt,
    });

    // FX snapshots: the booked rate is the most recent snapshot at-or-before
    // the earliest open charge (USD->INR @ 80), and the current spot is the
    // newer snapshot (USD->INR @ 84).
    await db.insert(fxRatesTable).values([
      { baseCurrency: "USD", quoteCurrency: "INR", rate: "80.0000000000", source: "test-fx-cron-and-pnl", fetchedAt: beforeEarliest },
      { baseCurrency: "USD", quoteCurrency: "INR", rate: "84.0000000000", source: "test-fx-cron-and-pnl", fetchedAt: afterEarliest },
    ]);

    // Realised entry: a USD-booked, INR-settled payment of 100 USD @ 82 INR
    // — booked-equivalent is 100/82*1 USD i.e. 1.22 INR per USD inverse, so
    // gainLoss = bookedAmount - (settledAmount/fxRate). With fxRate = 82 and
    // settledAmount = 8000 INR, bookedEquivalent = 8000/82 = 97.56 USD, so
    // gainLoss = 100 - 97.56 = 2.44 USD. We just need a row to assert presence.
    await db.insert(fxLedgerEntriesTable).values({
      organizationId: orgId,
      bookedCurrency: "USD", bookedAmount: "100.00",
      settledCurrency: "INR", settledAmount: "8000.00",
      fxRate: "82.0000000000", gainLoss: "2.44",
      sourceType: "test-payment",
    });

    admin = {
      id: adminUserId,
      username: `fx_pnl_admin_${t}`,
      role: "org_admin",
      organizationId: orgId,
    };
    adminApp = createTestApp(admin);
  });

  it("rolls up open foreign-currency exposures into the unrealised section", async () => {
    const split = await summariseFxGainLossSplit(orgId);

    expect(split.unrealised).toHaveLength(1);
    const u = split.unrealised[0];
    expect(u.exposureCurrency).toBe("USD");
    expect(u.baseCurrency).toBe("INR");
    expect(u.outstandingAmount).toBeCloseTo(200, 2);
    expect(u.chargeCount).toBe(1);
    expect(u.bookedRate).toBeCloseTo(80, 4);
    expect(u.currentRate).toBeCloseTo(84, 4);
    expect(u.baseValueBooked).toBeCloseTo(16000, 2);
    expect(u.baseValueNow).toBeCloseTo(16800, 2);
    expect(u.unrealisedGainLoss).toBeCloseTo(800, 2);

    expect(split.realised).toHaveLength(1);
    const r = split.realised[0];
    expect(r.bookedCurrency).toBe("USD");
    expect(r.settledCurrency).toBe("INR");
    expect(Number(r.totalBooked)).toBeCloseTo(100, 2);
    expect(Number(r.totalGainLoss)).toBeCloseTo(2.44, 2);
    expect(r.txCount).toBe(1);
  });

  it("subtracts paid + refunded amounts from the open exposure", async () => {
    // Add a partial payment so outstanding drops from 200 to 150.
    await db.update(memberLevyChargesTable)
      .set({ status: "partial", paidAmount: "50.00" })
      .where(eq(memberLevyChargesTable.levyId, levyId));
    try {
      const split = await summariseFxGainLossSplit(orgId);
      const u = split.unrealised[0];
      expect(u.outstandingAmount).toBeCloseTo(150, 2);
      expect(u.baseValueBooked).toBeCloseTo(150 * 80, 2);
      expect(u.baseValueNow).toBeCloseTo(150 * 84, 2);
      expect(u.unrealisedGainLoss).toBeCloseTo(150 * 4, 2);
    } finally {
      await db.update(memberLevyChargesTable)
        .set({ status: "unpaid", paidAmount: "0" })
        .where(eq(memberLevyChargesTable.levyId, levyId));
    }
  });

  it("excludes fully-settled charges from the unrealised section", async () => {
    await db.update(memberLevyChargesTable)
      .set({ status: "paid", paidAmount: "200.00" })
      .where(eq(memberLevyChargesTable.levyId, levyId));
    try {
      const split = await summariseFxGainLossSplit(orgId);
      expect(split.unrealised).toHaveLength(0);
    } finally {
      await db.update(memberLevyChargesTable)
        .set({ status: "unpaid", paidAmount: "0" })
        .where(eq(memberLevyChargesTable.levyId, levyId));
    }
  });

  it("GET /fx-gain-loss returns realised + unrealised sections to the FX P&L tab", async () => {
    const res = await request(adminApp)
      .get(`/api/organizations/${orgId}/currency-tax/fx-gain-loss`)
      .expect(200);

    expect(res.body).toHaveProperty("realised");
    expect(res.body).toHaveProperty("unrealised");
    expect(res.body).toHaveProperty("recent");
    expect(Array.isArray(res.body.realised)).toBe(true);
    expect(Array.isArray(res.body.unrealised)).toBe(true);

    const realised = res.body.realised as Array<{ bookedCurrency: string; settledCurrency: string; txCount: number }>;
    const unrealised = res.body.unrealised as Array<{ exposureCurrency: string; baseCurrency: string; unrealisedGainLoss: number; outstandingAmount: number }>;

    const realisedRow = realised.find(r => r.bookedCurrency === "USD" && r.settledCurrency === "INR");
    expect(realisedRow, "USD→INR realised row should be present").toBeDefined();
    expect(realisedRow!.txCount).toBeGreaterThanOrEqual(1);

    const exposureRow = unrealised.find(u => u.exposureCurrency === "USD" && u.baseCurrency === "INR");
    expect(exposureRow, "USD→INR unrealised exposure row should be present").toBeDefined();
    expect(exposureRow!.outstandingAmount).toBeCloseTo(200, 2);
    expect(exposureRow!.unrealisedGainLoss).toBeCloseTo(800, 2);

    // `summary` alias kept for back-compat with older clients.
    expect(res.body.summary).toEqual(res.body.realised);
  });

  it("rejects unauthenticated callers with 401", async () => {
    const anon = createTestApp();
    await request(anon)
      .get(`/api/organizations/${orgId}/currency-tax/fx-gain-loss`)
      .expect(401);
  });
});
