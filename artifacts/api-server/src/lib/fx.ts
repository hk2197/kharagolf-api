/**
 * Task #373 — Foreign-exchange helper.
 *
 * Provides currency conversion backed by `fxRatesTable` snapshots, with a
 * built-in fallback table so the system stays usable when no rate has been
 * loaded yet. The fallback rates are *intentionally conservative* (slightly
 * old) so that booked amounts are never silently mis-stated as "spot" — the
 * `source` field on the returned record makes it explicit when a fallback
 * was used and the UI surfaces an FX-disclosure badge accordingly.
 */

import { db } from "@workspace/db";
import {
  fxRatesTable,
  fxLedgerEntriesTable,
  clubCurrencyProfilesTable,
  memberLeviesTable,
  memberLevyChargesTable,
} from "@workspace/db";
import { and, desc, eq, isNotNull, lte, sql } from "drizzle-orm";
import { logger } from "./logger";

export interface FxQuote {
  baseCurrency: string;
  quoteCurrency: string;
  rate: number;
  source: string;
  fetchedAt: Date;
  isFallback: boolean;
}

// Fallback rates expressed as 1 unit of base = N units of quote.
// Only used when no FX snapshot exists for a pair. Values are mid-market
// indicative as of late 2024; admins should override via /fx-rates POST.
const FALLBACK_RATES: Record<string, number> = {
  "USD->INR": 84.0,  "INR->USD": 1 / 84.0,
  "EUR->INR": 90.0,  "INR->EUR": 1 / 90.0,
  "GBP->INR": 108.0, "INR->GBP": 1 / 108.0,
  "AED->INR": 22.85, "INR->AED": 1 / 22.85,
  "SGD->INR": 62.5,  "INR->SGD": 1 / 62.5,
  "AUD->INR": 55.0,  "INR->AUD": 1 / 55.0,
  "USD->EUR": 0.93,  "EUR->USD": 1 / 0.93,
  "USD->GBP": 0.78,  "GBP->USD": 1 / 0.78,
  "USD->AED": 3.67,  "AED->USD": 1 / 3.67,
  "USD->SGD": 1.34,  "SGD->USD": 1 / 1.34,
  "USD->AUD": 1.52,  "AUD->USD": 1 / 1.52,
};

function pairKey(base: string, quote: string): string {
  return `${base.toUpperCase()}->${quote.toUpperCase()}`;
}

/**
 * Fetch the most recent rate for a (base, quote) pair. Falls back to the
 * inverse pair, then to a USD-bridged conversion, then to the static table.
 */
export async function getFxRate(
  baseCurrency: string,
  quoteCurrency: string,
): Promise<FxQuote> {
  const base = baseCurrency.toUpperCase();
  const quote = quoteCurrency.toUpperCase();
  const fetchedAt = new Date();

  if (base === quote) {
    return { baseCurrency: base, quoteCurrency: quote, rate: 1, source: "identity", fetchedAt, isFallback: false };
  }

  const [direct] = await db.select().from(fxRatesTable)
    .where(and(eq(fxRatesTable.baseCurrency, base), eq(fxRatesTable.quoteCurrency, quote)))
    .orderBy(desc(fxRatesTable.fetchedAt))
    .limit(1);
  if (direct) {
    return {
      baseCurrency: base, quoteCurrency: quote,
      rate: Number(direct.rate), source: direct.source,
      fetchedAt: direct.fetchedAt, isFallback: false,
    };
  }

  const [inverse] = await db.select().from(fxRatesTable)
    .where(and(eq(fxRatesTable.baseCurrency, quote), eq(fxRatesTable.quoteCurrency, base)))
    .orderBy(desc(fxRatesTable.fetchedAt))
    .limit(1);
  if (inverse) {
    const r = Number(inverse.rate);
    if (r > 0) {
      return {
        baseCurrency: base, quoteCurrency: quote,
        rate: 1 / r, source: `${inverse.source}+inverse`,
        fetchedAt: inverse.fetchedAt, isFallback: false,
      };
    }
  }

  const fallback = FALLBACK_RATES[pairKey(base, quote)];
  if (typeof fallback === "number") {
    return { baseCurrency: base, quoteCurrency: quote, rate: fallback, source: "static-fallback", fetchedAt, isFallback: true };
  }

  // USD-bridge: base -> USD -> quote
  if (base !== "USD" && quote !== "USD") {
    const toUsd = FALLBACK_RATES[pairKey(base, "USD")];
    const fromUsd = FALLBACK_RATES[pairKey("USD", quote)];
    if (toUsd && fromUsd) {
      return {
        baseCurrency: base, quoteCurrency: quote,
        rate: toUsd * fromUsd, source: "static-fallback-usd-bridge",
        fetchedAt, isFallback: true,
      };
    }
  }

  throw new Error(`[fx] No rate available for ${base}->${quote}. Add an entry via /currency-tax/fx-rates.`);
}

/** Convert `amount` from `from` to `to`. Returns the converted amount and FX quote used. */
export async function convertAmount(amount: number, from: string, to: string): Promise<{ amount: number; quote: FxQuote }> {
  const quote = await getFxRate(from, to);
  return { amount: +(amount * quote.rate).toFixed(2), quote };
}

/**
 * Insert an FX-rate snapshot. Used by admin /fx-rates POST and (in future)
 * by an automated rate-refresh cron.
 */
export async function recordFxRate(opts: {
  baseCurrency: string;
  quoteCurrency: string;
  rate: number;
  source?: string;
}): Promise<void> {
  if (!isFinite(opts.rate) || opts.rate <= 0) throw new Error("Invalid rate");
  await db.insert(fxRatesTable).values({
    baseCurrency: opts.baseCurrency.toUpperCase(),
    quoteCurrency: opts.quoteCurrency.toUpperCase(),
    rate: String(opts.rate),
    source: opts.source ?? "manual",
  });
}

/**
 * Record an FX gain/loss entry. Compute `gainLoss` as (settled - bookedEquivalent)
 * in the booked currency. Positive = gain to the org.
 */
export async function recordFxLedger(opts: {
  organizationId: number;
  bookedCurrency: string;
  bookedAmount: number;
  settledCurrency: string;
  settledAmount: number;
  fxRate: number;
  sourceType: string;
  sourceId?: string | null;
  processor?: "razorpay" | "stripe" | "manual" | null;
  notes?: string | null;
  /** Moment the upstream processor confirmed settlement. Defaults to now(). */
  settledAt?: Date | null;
}): Promise<void> {
  const bookedEquivalent = +(opts.settledAmount / (opts.fxRate || 1)).toFixed(2);
  const gainLoss = +(opts.bookedAmount - bookedEquivalent).toFixed(2);
  await db.insert(fxLedgerEntriesTable).values({
    organizationId: opts.organizationId,
    bookedCurrency: opts.bookedCurrency.toUpperCase(),
    bookedAmount: String(opts.bookedAmount),
    settledCurrency: opts.settledCurrency.toUpperCase(),
    settledAmount: String(opts.settledAmount),
    fxRate: String(opts.fxRate),
    gainLoss: String(gainLoss),
    sourceType: opts.sourceType,
    sourceId: opts.sourceId ?? null,
    processor: opts.processor ?? null,
    notes: opts.notes ?? null,
    settledAt: opts.settledAt ?? new Date(),
  });
}

/**
 * Fetch mid-market rates from a free public API (open.er-api.com — no API key
 * required, returns USD-based mid-market rates for all major currencies).
 *
 * Returns a map of `quote -> rate` for each requested quote currency, expressed
 * as `1 unit of base = N units of quote`. The provider returns the rates with
 * the requested base; we filter to only the currencies the caller asked for.
 */
export async function fetchMidMarketRates(
  base: string,
  quotes: string[],
): Promise<Record<string, number>> {
  const baseUp = base.toUpperCase();
  const quotesUp = Array.from(new Set(quotes.map(q => q.toUpperCase()).filter(q => q !== baseUp)));
  if (quotesUp.length === 0) return {};
  const url = `https://open.er-api.com/v6/latest/${encodeURIComponent(baseUp)}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`fx provider HTTP ${res.status}`);
  const body = await res.json() as { result?: string; rates?: Record<string, number>; "error-type"?: string };
  if (body.result !== "success" || !body.rates) {
    throw new Error(`fx provider error: ${body["error-type"] ?? "unknown"}`);
  }
  const out: Record<string, number> = {};
  for (const q of quotesUp) {
    const r = body.rates[q];
    if (typeof r === "number" && isFinite(r) && r > 0) out[q] = r;
  }
  return out;
}

/**
 * Refresh FX snapshots for one organisation: fetches mid-market rates from
 * the free provider for the org's base currency paired against each of its
 * display currencies, and inserts a snapshot row per pair.
 *
 * Returns the number of pairs successfully recorded.
 */
export async function refreshFxRatesForOrg(
  baseCurrency: string,
  displayCurrencies: string[],
): Promise<{ pairs: number; rates: Record<string, number> }> {
  const rates = await fetchMidMarketRates(baseCurrency, displayCurrencies);
  let pairs = 0;
  for (const [quote, rate] of Object.entries(rates)) {
    await recordFxRate({ baseCurrency, quoteCurrency: quote, rate, source: "open.er-api.com" });
    pairs += 1;
  }
  return { pairs, rates };
}

/**
 * Refresh FX snapshots for every organisation that has a currency profile.
 * Designed for the daily cron — failures on individual orgs are logged but
 * never abort the run for other orgs.
 */
export async function refreshAllOrgFxRates(): Promise<{ orgs: number; pairs: number }> {
  const profiles = await db
    .select({
      organizationId: clubCurrencyProfilesTable.organizationId,
      baseCurrency: clubCurrencyProfilesTable.baseCurrency,
      displayCurrencies: clubCurrencyProfilesTable.displayCurrencies,
    })
    .from(clubCurrencyProfilesTable);
  let totalPairs = 0;
  let orgsRefreshed = 0;
  for (const p of profiles) {
    const base = (p.baseCurrency ?? "INR").toUpperCase();
    const displays = ((p.displayCurrencies ?? []) as string[]).map((c: string) => c.toUpperCase()).filter((c: string) => c !== base);
    if (displays.length === 0) continue;
    try {
      const r = await refreshFxRatesForOrg(base, displays);
      totalPairs += r.pairs;
      orgsRefreshed += 1;
      logger.info(
        { orgId: p.organizationId, base, displays, pairs: r.pairs },
        "[fx] refreshed mid-market rates",
      );
    } catch (err) {
      logger.warn({ err, orgId: p.organizationId, base }, "[fx] org rate refresh failed");
    }
  }
  return { orgs: orgsRefreshed, pairs: totalPairs };
}

/** Aggregate FX gain/loss by currency pair for reporting. */
export async function summariseFxGainLoss(organizationId: number, fromDate?: Date, toDate?: Date) {
  const where = [eq(fxLedgerEntriesTable.organizationId, organizationId)];
  if (fromDate) where.push(sql`${fxLedgerEntriesTable.createdAt} >= ${fromDate}`);
  if (toDate) where.push(sql`${fxLedgerEntriesTable.createdAt} <= ${toDate}`);
  const rows = await db.select({
    bookedCurrency: fxLedgerEntriesTable.bookedCurrency,
    settledCurrency: fxLedgerEntriesTable.settledCurrency,
    totalBooked: sql<string>`COALESCE(SUM(${fxLedgerEntriesTable.bookedAmount}), 0)`,
    totalSettled: sql<string>`COALESCE(SUM(${fxLedgerEntriesTable.settledAmount}), 0)`,
    totalGainLoss: sql<string>`COALESCE(SUM(${fxLedgerEntriesTable.gainLoss}), 0)`,
    txCount: sql<number>`COUNT(*)::int`,
  }).from(fxLedgerEntriesTable)
    .where(and(...where))
    .groupBy(fxLedgerEntriesTable.bookedCurrency, fxLedgerEntriesTable.settledCurrency);
  return rows;
}

export interface FxRealisedRow {
  bookedCurrency: string;
  settledCurrency: string;
  totalBooked: string;
  totalSettled: string;
  totalGainLoss: string;
  txCount: number;
}

export interface FxUnrealisedRow {
  /** Currency the open exposure is denominated in (the levy / charge currency). */
  exposureCurrency: string;
  /** Org base currency the exposure is being valued against. */
  baseCurrency: string;
  /** Outstanding amount in the exposure currency across open levy charges. */
  outstandingAmount: number;
  /** FX rate at the moment the earliest unsettled charge was booked. */
  bookedRate: number;
  /** Latest spot rate. */
  currentRate: number;
  /** Source of the spot rate (provider name or fallback marker). */
  currentRateSource: string;
  /** Open base-currency value: outstandingAmount * currentRate. */
  baseValueNow: number;
  /** Booked base-currency value: outstandingAmount * bookedRate. */
  baseValueBooked: number;
  /**
   * Mark-to-market gain/loss on the open position, expressed in the org's
   * base currency. Positive = currency moved in the org's favour since
   * booking, negative = unrealised loss.
   */
  unrealisedGainLoss: number;
  /** Number of open charges that contribute to the exposure. */
  chargeCount: number;
}

/**
 * Realised vs unrealised split for the FX P&L tab.
 *
 * Realised entries come from the `fx_ledger_entries` table: those rows are
 * written when a payment is actually settled by a processor (or hand-recorded
 * by an admin), so the gain/loss is locked in.
 *
 * Unrealised entries are computed at request time from open `member_levy_charges`
 * in any currency that differs from the org's base currency. For each foreign-
 * currency exposure we pick the FX-snapshot at or before the earliest booking
 * as the "booked rate" and compare it to the latest spot to estimate the
 * mark-to-market gain/loss the org would crystallise if every open charge
 * settled today.
 */
export async function summariseFxGainLossSplit(
  organizationId: number,
  fromDate?: Date,
  toDate?: Date,
): Promise<{ realised: FxRealisedRow[]; unrealised: FxUnrealisedRow[] }> {
  const realisedRaw = await summariseFxGainLoss(organizationId, fromDate, toDate);
  const realised: FxRealisedRow[] = realisedRaw.map(r => ({
    bookedCurrency: r.bookedCurrency,
    settledCurrency: r.settledCurrency,
    totalBooked: String(r.totalBooked ?? "0"),
    totalSettled: String(r.totalSettled ?? "0"),
    totalGainLoss: String(r.totalGainLoss ?? "0"),
    txCount: Number(r.txCount ?? 0),
  }));

  // Resolve org base currency
  const [profile] = await db.select({ baseCurrency: clubCurrencyProfilesTable.baseCurrency })
    .from(clubCurrencyProfilesTable)
    .where(eq(clubCurrencyProfilesTable.organizationId, organizationId));
  const baseCurrency = (profile?.baseCurrency ?? "INR").toUpperCase();

  // Open exposures: outstanding levy charges in non-base currencies.
  // outstanding = max(amount - paidAmount - refundedAmount, 0)
  const exposures = await db.select({
    currency: memberLeviesTable.currency,
    outstanding: sql<string>`COALESCE(SUM(GREATEST(${memberLevyChargesTable.amount}::numeric - COALESCE(${memberLevyChargesTable.paidAmount},0)::numeric - COALESCE(${memberLevyChargesTable.refundedAmount},0)::numeric, 0)), 0)::text`,
    chargeCount: sql<number>`COUNT(*)::int`,
    earliestCreatedAt: sql<Date>`MIN(${memberLevyChargesTable.createdAt})`,
  })
    .from(memberLevyChargesTable)
    .innerJoin(memberLeviesTable, eq(memberLeviesTable.id, memberLevyChargesTable.levyId))
    .where(and(
      eq(memberLeviesTable.organizationId, organizationId),
      sql`${memberLevyChargesTable.status} IN ('unpaid','partial')`,
    ))
    .groupBy(memberLeviesTable.currency);

  const unrealised: FxUnrealisedRow[] = [];
  for (const e of exposures) {
    const exposureCurrency = (e.currency ?? "INR").toUpperCase();
    const outstandingAmount = parseFloat(String(e.outstanding ?? "0"));
    if (!isFinite(outstandingAmount) || outstandingAmount <= 0) continue;
    if (exposureCurrency === baseCurrency) continue;

    const currentQuote = await getFxRate(exposureCurrency, baseCurrency);
    const earliest = e.earliestCreatedAt ? new Date(e.earliestCreatedAt) : new Date();

    // Booked rate: latest snapshot at or before the earliest open charge.
    let bookedRate = currentQuote.rate;
    const [snap] = await db.select({ rate: fxRatesTable.rate })
      .from(fxRatesTable)
      .where(and(
        eq(fxRatesTable.baseCurrency, exposureCurrency),
        eq(fxRatesTable.quoteCurrency, baseCurrency),
        lte(fxRatesTable.fetchedAt, earliest),
      ))
      .orderBy(desc(fxRatesTable.fetchedAt))
      .limit(1);
    if (snap) {
      const r = Number(snap.rate);
      if (isFinite(r) && r > 0) bookedRate = r;
    } else {
      // Try the inverse-pair snapshot when no direct one exists.
      const [inv] = await db.select({ rate: fxRatesTable.rate })
        .from(fxRatesTable)
        .where(and(
          eq(fxRatesTable.baseCurrency, baseCurrency),
          eq(fxRatesTable.quoteCurrency, exposureCurrency),
          lte(fxRatesTable.fetchedAt, earliest),
        ))
        .orderBy(desc(fxRatesTable.fetchedAt))
        .limit(1);
      if (inv) {
        const r = Number(inv.rate);
        if (isFinite(r) && r > 0) bookedRate = 1 / r;
      }
    }

    const baseValueNow = +(outstandingAmount * currentQuote.rate).toFixed(2);
    const baseValueBooked = +(outstandingAmount * bookedRate).toFixed(2);
    const unrealisedGainLoss = +(baseValueNow - baseValueBooked).toFixed(2);

    unrealised.push({
      exposureCurrency,
      baseCurrency,
      outstandingAmount: +outstandingAmount.toFixed(2),
      bookedRate: +bookedRate.toFixed(6),
      currentRate: +currentQuote.rate.toFixed(6),
      currentRateSource: currentQuote.source,
      baseValueNow,
      baseValueBooked,
      unrealisedGainLoss,
      chargeCount: Number(e.chargeCount ?? 0),
    });
  }

  // Suppress unused-import warning for isNotNull (kept for potential future use in this module).
  void isNotNull;

  return { realised, unrealised };
}
