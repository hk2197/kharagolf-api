/**
 * Task #373 — Multi-currency & multi-tax admin + player API.
 *
 * Mounted under /organizations/:orgId/currency-tax (admin) and
 * /currency-tax/me (player). Exposes:
 *
 *   Currency profile
 *     GET  /profile               — read club currency profile
 *     PUT  /profile               — upsert club currency profile
 *
 *   Tax profiles & rates
 *     GET    /tax-profiles
 *     POST   /tax-profiles
 *     PATCH  /tax-profiles/:id
 *     DELETE /tax-profiles/:id
 *     POST   /tax-profiles/:id/rates
 *     DELETE /tax-profiles/:id/rates/:rateId
 *
 *   FX rates
 *     GET  /fx-rates              — list snapshots
 *     POST /fx-rates              — record a manual snapshot
 *     GET  /fx-rates/quote        — quote a conversion
 *
 *   Processor configs
 *     GET    /processor-configs
 *     PUT    /processor-configs   — upsert (org, currency) -> processor
 *     DELETE /processor-configs/:id
 *
 *   Quoting & reporting
 *     POST /quote                 — compute price + tax + display currency
 *     GET  /fx-gain-loss          — settlement-currency FX P&L
 *
 *   Player preference
 *     GET  /currency-tax/me/preferred-currency
 *     PUT  /currency-tax/me/preferred-currency
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import {
  clubCurrencyProfilesTable,
  taxProfilesTable,
  taxRatesTable,
  fxRatesTable,
  paymentProcessorConfigsTable,
  userCurrencyPreferencesTable,
  fxLedgerEntriesTable,
  orgMembershipsTable,
} from "@workspace/db";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { resolveTaxes, getDefaultTaxProfileId } from "../lib/taxEngine";
import {
  convertAmount,
  getFxRate,
  recordFxRate,
  summariseFxGainLoss,
  summariseFxGainLossSplit,
  refreshFxRatesForOrg,
} from "../lib/fx";
import { selectProcessor, RAZORPAY_SUPPORTED_CURRENCIES } from "../lib/paymentProcessor";

export const router: IRouter = Router({ mergeParams: true });

// ── Auth helpers ───────────────────────────────────────────────────────────

async function requireOrgAdmin(req: Request, res: Response, orgId: number): Promise<boolean> {
  if (!req.isAuthenticated()) { res.status(401).json({ error: "Authentication required" }); return false; }
  const user = req.user as { id: number; role?: string; organizationId?: number };
  if (user.role === "super_admin") return true;
  if ((user.role === "org_admin" || user.role === "treasurer") && Number(user.organizationId) === orgId) return true;
  const [m] = await db.select({ id: orgMembershipsTable.id }).from(orgMembershipsTable)
    .where(and(
      eq(orgMembershipsTable.organizationId, orgId),
      eq(orgMembershipsTable.userId, user.id),
      inArray(orgMembershipsTable.role, ["org_admin", "treasurer"]),
    ));
  if (!m) { res.status(403).json({ error: "Admin access required" }); return false; }
  return true;
}

function requireUser(req: Request, res: Response): { id: number } | null {
  if (!req.isAuthenticated()) { res.status(401).json({ error: "Authentication required" }); return null; }
  return req.user as { id: number };
}

function isIso4217(s: unknown): s is string {
  return typeof s === "string" && /^[A-Z]{3}$/.test(s.toUpperCase());
}

// ── Currency profile ───────────────────────────────────────────────────────

router.get("/profile", async (req, res) => {
  const orgId = parseInt((req.params as unknown as { orgId: string }).orgId);
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const [row] = await db.select().from(clubCurrencyProfilesTable)
    .where(eq(clubCurrencyProfilesTable.organizationId, orgId));
  res.json(row ?? {
    organizationId: orgId, baseCurrency: "INR", displayCurrencies: ["INR"],
    allowPlayerPreferredCurrency: false, defaultTaxProfileId: null, fxMarkupPct: "0",
  });
});

router.put("/profile", async (req, res) => {
  const orgId = parseInt((req.params as unknown as { orgId: string }).orgId);
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const body = req.body as {
    baseCurrency?: string; displayCurrencies?: string[];
    allowPlayerPreferredCurrency?: boolean; defaultTaxProfileId?: number | null;
    fxMarkupPct?: number | string;
  };
  const baseCurrency = (body.baseCurrency ?? "INR").toUpperCase();
  if (!isIso4217(baseCurrency)) { { res.status(400).json({ error: "baseCurrency must be ISO-4217" }); return; } }
  const displayCurrencies = Array.isArray(body.displayCurrencies) && body.displayCurrencies.length > 0
    ? body.displayCurrencies.map((c) => c.toUpperCase()).filter(isIso4217)
    : [baseCurrency];
  if (!displayCurrencies.includes(baseCurrency)) displayCurrencies.unshift(baseCurrency);
  const fxMarkupPct = String(body.fxMarkupPct ?? "0");
  const values = {
    organizationId: orgId,
    baseCurrency,
    displayCurrencies,
    allowPlayerPreferredCurrency: !!body.allowPlayerPreferredCurrency,
    defaultTaxProfileId: body.defaultTaxProfileId ?? null,
    fxMarkupPct,
    updatedAt: new Date(),
  };
  const [existing] = await db.select({ id: clubCurrencyProfilesTable.id })
    .from(clubCurrencyProfilesTable)
    .where(eq(clubCurrencyProfilesTable.organizationId, orgId));
  if (existing) {
    await db.update(clubCurrencyProfilesTable).set(values)
      .where(eq(clubCurrencyProfilesTable.id, existing.id));
  } else {
    await db.insert(clubCurrencyProfilesTable).values(values);
  }
  const [row] = await db.select().from(clubCurrencyProfilesTable)
    .where(eq(clubCurrencyProfilesTable.organizationId, orgId));
  res.json(row);
});

// ── Tax profiles & rates ───────────────────────────────────────────────────

router.get("/tax-profiles", async (req, res) => {
  const orgId = parseInt((req.params as unknown as { orgId: string }).orgId);
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const profiles = await db.select().from(taxProfilesTable)
    .where(eq(taxProfilesTable.organizationId, orgId))
    .orderBy(asc(taxProfilesTable.name));
  const rates = profiles.length === 0 ? [] : await db.select().from(taxRatesTable)
    .where(inArray(taxRatesTable.taxProfileId, profiles.map((p) => p.id)))
    .orderBy(asc(taxRatesTable.taxProfileId), asc(taxRatesTable.sortOrder));
  res.json(profiles.map((p) => ({ ...p, rates: rates.filter((r) => r.taxProfileId === p.id) })));
});

router.post("/tax-profiles", async (req, res) => {
  const orgId = parseInt((req.params as unknown as { orgId: string }).orgId);
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const b = req.body as Record<string, unknown>;
  if (typeof b.name !== "string" || !b.name) { { res.status(400).json({ error: "name required" }); return; } }
  const [row] = await db.insert(taxProfilesTable).values({
    organizationId: orgId,
    name: b.name,
    jurisdictionKind: (b.jurisdictionKind as "gst" | "vat" | "sales_tax" | "none") ?? "none",
    country: typeof b.country === "string" ? b.country.toUpperCase() : "IN",
    region: typeof b.region === "string" ? b.region : null,
    invoiceLabel: typeof b.invoiceLabel === "string" ? b.invoiceLabel : null,
    isDefault: !!b.isDefault,
    isActive: b.isActive === false ? false : true,
    exemptionRules: (b.exemptionRules as Record<string, unknown>) ?? {},
  }).returning();
  if (row?.isDefault) {
    await db.update(taxProfilesTable).set({ isDefault: false })
      .where(and(eq(taxProfilesTable.organizationId, orgId), sql`${taxProfilesTable.id} <> ${row.id}`));
  }
  res.status(201).json(row);
});

router.patch("/tax-profiles/:id", async (req, res) => {
  const orgId = parseInt((req.params as unknown as { orgId: string }).orgId);
  const id = parseInt((req.params as { id: string }).id);
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const b = req.body as Record<string, unknown>;
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (typeof b.name === "string") updates.name = b.name;
  if (typeof b.jurisdictionKind === "string") updates.jurisdictionKind = b.jurisdictionKind;
  if (typeof b.country === "string") updates.country = b.country.toUpperCase();
  if ("region" in b) updates.region = b.region ?? null;
  if ("invoiceLabel" in b) updates.invoiceLabel = b.invoiceLabel ?? null;
  if (typeof b.isDefault === "boolean") updates.isDefault = b.isDefault;
  if (typeof b.isActive === "boolean") updates.isActive = b.isActive;
  if (b.exemptionRules && typeof b.exemptionRules === "object") updates.exemptionRules = b.exemptionRules;
  const [row] = await db.update(taxProfilesTable).set(updates)
    .where(and(eq(taxProfilesTable.id, id), eq(taxProfilesTable.organizationId, orgId)))
    .returning();
  if (!row) { { res.status(404).json({ error: "Not found" }); return; } }
  if (row.isDefault) {
    await db.update(taxProfilesTable).set({ isDefault: false })
      .where(and(eq(taxProfilesTable.organizationId, orgId), sql`${taxProfilesTable.id} <> ${row.id}`));
  }
  res.json(row);
});

router.delete("/tax-profiles/:id", async (req, res) => {
  const orgId = parseInt((req.params as unknown as { orgId: string }).orgId);
  const id = parseInt((req.params as { id: string }).id);
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const result = await db.delete(taxProfilesTable)
    .where(and(eq(taxProfilesTable.id, id), eq(taxProfilesTable.organizationId, orgId)))
    .returning({ id: taxProfilesTable.id });
  if (result.length === 0) { { res.status(404).json({ error: "Not found" }); return; } }
  res.status(204).end();
});

router.post("/tax-profiles/:id/rates", async (req, res) => {
  const orgId = parseInt((req.params as unknown as { orgId: string }).orgId);
  const profileId = parseInt((req.params as { id: string }).id);
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const [profile] = await db.select({ id: taxProfilesTable.id }).from(taxProfilesTable)
    .where(and(eq(taxProfilesTable.id, profileId), eq(taxProfilesTable.organizationId, orgId)));
  if (!profile) { { res.status(404).json({ error: "Profile not found" }); return; } }
  const b = req.body as Record<string, unknown>;
  if (typeof b.componentName !== "string" || !b.componentName) { { res.status(400).json({ error: "componentName required" }); return; } }
  const ratePct = Number(b.ratePct ?? 0);
  if (!isFinite(ratePct) || ratePct < 0) { { res.status(400).json({ error: "ratePct must be >= 0" }); return; } }
  const [row] = await db.insert(taxRatesTable).values({
    taxProfileId: profileId,
    componentName: b.componentName,
    ratePct: String(ratePct),
    productClass: typeof b.productClass === "string" ? b.productClass : null,
    customerClass: typeof b.customerClass === "string" ? b.customerClass : null,
    minTaxableAmount: b.minTaxableAmount != null ? String(b.minTaxableAmount) : null,
    maxTaxableAmount: b.maxTaxableAmount != null ? String(b.maxTaxableAmount) : null,
    sortOrder: typeof b.sortOrder === "number" ? b.sortOrder : 0,
  }).returning();
  res.status(201).json(row);
});

router.delete("/tax-profiles/:id/rates/:rateId", async (req, res) => {
  const orgId = parseInt((req.params as unknown as { orgId: string }).orgId);
  const profileId = parseInt((req.params as { id: string }).id);
  const rateId = parseInt((req.params as { rateId: string }).rateId);
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const [profile] = await db.select({ id: taxProfilesTable.id }).from(taxProfilesTable)
    .where(and(eq(taxProfilesTable.id, profileId), eq(taxProfilesTable.organizationId, orgId)));
  if (!profile) { { res.status(404).json({ error: "Profile not found" }); return; } }
  const result = await db.delete(taxRatesTable)
    .where(and(eq(taxRatesTable.id, rateId), eq(taxRatesTable.taxProfileId, profileId)))
    .returning({ id: taxRatesTable.id });
  if (result.length === 0) { { res.status(404).json({ error: "Not found" }); return; } }
  res.status(204).end();
});

// ── FX rates ───────────────────────────────────────────────────────────────

router.get("/fx-rates", async (req, res) => {
  const orgId = parseInt((req.params as unknown as { orgId: string }).orgId);
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const rows = await db.select().from(fxRatesTable)
    .orderBy(desc(fxRatesTable.fetchedAt))
    .limit(200);
  res.json(rows);
});

router.post("/fx-rates", async (req, res) => {
  const orgId = parseInt((req.params as unknown as { orgId: string }).orgId);
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const b = req.body as { baseCurrency?: string; quoteCurrency?: string; rate?: number | string; source?: string };
  if (!isIso4217(b.baseCurrency) || !isIso4217(b.quoteCurrency)) {
    res.status(400).json({ error: "baseCurrency / quoteCurrency must be ISO-4217" }); return;
  }
  const rate = Number(b.rate);
  if (!isFinite(rate) || rate <= 0) { { res.status(400).json({ error: "rate must be > 0" }); return; } }
  await recordFxRate({
    baseCurrency: b.baseCurrency,
    quoteCurrency: b.quoteCurrency,
    rate,
    source: b.source ?? "manual",
  });
  res.status(201).json({ ok: true });
});

router.get("/fx-rates/quote", async (req, res) => {
  const orgId = parseInt((req.params as unknown as { orgId: string }).orgId);
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const from = String(req.query.from ?? "").toUpperCase();
  const to = String(req.query.to ?? "").toUpperCase();
  if (!isIso4217(from) || !isIso4217(to)) { { res.status(400).json({ error: "from/to required" }); return; } }
  try {
    const quote = await getFxRate(from, to);
    res.json(quote);
  } catch (e) {
    res.status(404).json({ error: (e as Error).message });
  }
});

// ── Processor configs ──────────────────────────────────────────────────────

router.get("/processor-configs", async (req, res) => {
  const orgId = parseInt((req.params as unknown as { orgId: string }).orgId);
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const rows = await db.select().from(paymentProcessorConfigsTable)
    .where(eq(paymentProcessorConfigsTable.organizationId, orgId))
    .orderBy(asc(paymentProcessorConfigsTable.currency));
  res.json({
    configs: rows,
    razorpaySupportedCurrencies: Array.from(RAZORPAY_SUPPORTED_CURRENCIES),
  });
});

router.put("/processor-configs", async (req, res) => {
  const orgId = parseInt((req.params as unknown as { orgId: string }).orgId);
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const b = req.body as { currency?: string; processor?: "razorpay" | "stripe" | "manual"; isActive?: boolean; accountRef?: string; publicKeyHint?: string };
  if (!isIso4217(b.currency) || !b.processor) { { res.status(400).json({ error: "currency + processor required" }); return; } }
  if (b.processor === "razorpay" && !RAZORPAY_SUPPORTED_CURRENCIES.has(b.currency.toUpperCase())) {
    res.status(400).json({ error: `Razorpay does not support ${b.currency}` }); return;
  }
  const currency = b.currency.toUpperCase();
  const [existing] = await db.select({ id: paymentProcessorConfigsTable.id })
    .from(paymentProcessorConfigsTable)
    .where(and(
      eq(paymentProcessorConfigsTable.organizationId, orgId),
      eq(paymentProcessorConfigsTable.currency, currency),
    ));
  if (existing) {
    const [row] = await db.update(paymentProcessorConfigsTable).set({
      processor: b.processor,
      isActive: b.isActive !== false,
      accountRef: b.accountRef ?? null,
      publicKeyHint: b.publicKeyHint ?? null,
      updatedAt: new Date(),
    }).where(eq(paymentProcessorConfigsTable.id, existing.id)).returning();
    res.json(row);
  } else {
    const [row] = await db.insert(paymentProcessorConfigsTable).values({
      organizationId: orgId,
      currency,
      processor: b.processor,
      isActive: b.isActive !== false,
      accountRef: b.accountRef ?? null,
      publicKeyHint: b.publicKeyHint ?? null,
    }).returning();
    res.status(201).json(row);
  }
});

router.delete("/processor-configs/:id", async (req, res) => {
  const orgId = parseInt((req.params as unknown as { orgId: string }).orgId);
  const id = parseInt((req.params as { id: string }).id);
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const result = await db.delete(paymentProcessorConfigsTable)
    .where(and(eq(paymentProcessorConfigsTable.id, id), eq(paymentProcessorConfigsTable.organizationId, orgId)))
    .returning({ id: paymentProcessorConfigsTable.id });
  if (result.length === 0) { { res.status(404).json({ error: "Not found" }); return; } }
  res.status(204).end();
});

// ── Quote (price + tax + display currency) ─────────────────────────────────

router.post("/quote", async (req, res) => {
  const orgId = parseInt((req.params as unknown as { orgId: string }).orgId);
  if (!req.isAuthenticated()) { { res.status(401).json({ error: "Authentication required" }); return; } }
  const user = req.user as { id: number };
  const b = req.body as {
    amount?: number; currency?: string; displayCurrency?: string;
    taxProfileId?: number; productClass?: string; customerClass?: string;
    sellerStateCode?: string; buyerStateCode?: string; buyerCountry?: string;
    buyerExempt?: boolean;
  };
  const amount = Number(b.amount);
  if (!isFinite(amount) || amount < 0) { { res.status(400).json({ error: "amount required" }); return; } }
  const currency = (b.currency ?? "INR").toUpperCase();

  const [profile] = await db.select().from(clubCurrencyProfilesTable)
    .where(eq(clubCurrencyProfilesTable.organizationId, orgId));
  const baseCurrency = (profile?.baseCurrency ?? currency).toUpperCase();
  const fxMarkupPct = Number(profile?.fxMarkupPct ?? 0);

  const taxProfileId = b.taxProfileId ?? profile?.defaultTaxProfileId ?? await getDefaultTaxProfileId(orgId);
  const tax = await resolveTaxes({
    organizationId: orgId,
    taxProfileId: taxProfileId ?? null,
    taxableAmount: amount,
    currency,
    productClass: b.productClass ?? null,
    customerClass: b.customerClass ?? null,
    sellerStateCode: b.sellerStateCode ?? null,
    buyerStateCode: b.buyerStateCode ?? null,
    buyerCountry: b.buyerCountry ?? null,
    buyerExempt: !!b.buyerExempt,
  });

  // Resolve display currency — caller request > player preference > base.
  let displayCurrency = (b.displayCurrency ?? "").toUpperCase();
  if (!displayCurrency) {
    const [pref] = await db.select().from(userCurrencyPreferencesTable)
      .where(eq(userCurrencyPreferencesTable.userId, user.id));
    displayCurrency = pref?.preferredCurrency?.toUpperCase() ?? baseCurrency;
  }
  if (!profile?.allowPlayerPreferredCurrency && displayCurrency !== baseCurrency &&
      !(profile?.displayCurrencies ?? [baseCurrency]).includes(displayCurrency)) {
    displayCurrency = baseCurrency;
  }

  const processor = await selectProcessor(orgId, currency);

  let display: {
    currency: string;
    totalAmount: number;
    fxRate: number;
    fxSource: string;
    isFallback: boolean;
    fxMarkupPct: number;
  } | null = null;
  if (displayCurrency !== currency) {
    const conv = await convertAmount(tax.totalAmount, currency, displayCurrency);
    const markedUp = +(conv.amount * (1 + fxMarkupPct / 100)).toFixed(2);
    display = {
      currency: displayCurrency,
      totalAmount: markedUp,
      fxRate: conv.quote.rate,
      fxSource: conv.quote.source,
      isFallback: conv.quote.isFallback,
      fxMarkupPct,
    };
  }

  res.json({
    booking: {
      currency,
      taxableAmount: tax.taxableAmount,
      totalTax: tax.totalTax,
      totalAmount: tax.totalAmount,
      tax,
    },
    display,
    processor: processor.name,
    baseCurrency,
  });
});

// ── FX gain/loss report ────────────────────────────────────────────────────

router.get("/fx-gain-loss", async (req, res) => {
  const orgId = parseInt((req.params as unknown as { orgId: string }).orgId);
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const from = req.query.from ? new Date(String(req.query.from)) : undefined;
  const to = req.query.to ? new Date(String(req.query.to)) : undefined;
  const split = await summariseFxGainLossSplit(orgId, from, to);
  const recent = await db.select().from(fxLedgerEntriesTable)
    .where(eq(fxLedgerEntriesTable.organizationId, orgId))
    .orderBy(desc(fxLedgerEntriesTable.createdAt))
    .limit(50);
  // `summary` is preserved as an alias for `realised` so existing clients
  // keep working while new clients consume the realised/unrealised split.
  res.json({
    summary: split.realised,
    realised: split.realised,
    unrealised: split.unrealised,
    recent,
  });
});

// Manually trigger an FX rate refresh for this org. Same provider the daily
// cron uses (open.er-api.com) — handy when an admin updates display currencies
// and wants to populate snapshots immediately.
router.post("/fx-rates/refresh", async (req, res) => {
  const orgId = parseInt((req.params as unknown as { orgId: string }).orgId);
  if (!await requireOrgAdmin(req, res, orgId)) return;
  const [profile] = await db.select().from(clubCurrencyProfilesTable)
    .where(eq(clubCurrencyProfilesTable.organizationId, orgId));
  const base = (profile?.baseCurrency ?? "INR").toUpperCase();
  const displays = ((profile?.displayCurrencies ?? []) as string[]).map((c: string) => c.toUpperCase()).filter((c: string) => c !== base);
  if (displays.length === 0) {
    res.json({ ok: true, pairs: 0, rates: {}, baseCurrency: base, message: "No display currencies configured." });
    return;
  }
  try {
    const r = await refreshFxRatesForOrg(base, displays);
    res.json({ ok: true, pairs: r.pairs, rates: r.rates, baseCurrency: base, source: "open.er-api.com" });
  } catch (e) {
    res.status(502).json({ error: (e as Error).message });
  }
});

// Quiet "summariseFxGainLoss kept for back-compat" — keep direct export referenced.
void summariseFxGainLoss;

// ── Player preferred-currency endpoints (mounted separately) ───────────────

export const playerPrefRouter: IRouter = Router();

playerPrefRouter.get("/me/preferred-currency", async (req, res) => {
  const user = requireUser(req, res); if (!user) return;
  const [row] = await db.select().from(userCurrencyPreferencesTable)
    .where(eq(userCurrencyPreferencesTable.userId, user.id));
  res.json(row ?? { userId: user.id, preferredCurrency: null });
});

playerPrefRouter.put("/me/preferred-currency", async (req, res) => {
  const user = requireUser(req, res); if (!user) return;
  const b = req.body as { preferredCurrency?: string | null };
  // null / empty string clears the preference and reverts to the club's default currency.
  const reset = b.preferredCurrency === null || b.preferredCurrency === "";
  if (!reset && !isIso4217(b.preferredCurrency)) {
    res.status(400).json({ error: "preferredCurrency must be ISO-4217 or null" }); return;
  }
  if (reset) {
    // Schema marks preferred_currency as NOT NULL, so clearing means deleting the row.
    await db.delete(userCurrencyPreferencesTable)
      .where(eq(userCurrencyPreferencesTable.userId, user.id));
    res.json({ userId: user.id, preferredCurrency: null });
    return;
  }
  const cur = (b.preferredCurrency as string).toUpperCase();
  const [existing] = await db.select({ userId: userCurrencyPreferencesTable.userId })
    .from(userCurrencyPreferencesTable)
    .where(eq(userCurrencyPreferencesTable.userId, user.id));
  if (existing) {
    await db.update(userCurrencyPreferencesTable).set({ preferredCurrency: cur, updatedAt: new Date() })
      .where(eq(userCurrencyPreferencesTable.userId, user.id));
  } else {
    await db.insert(userCurrencyPreferencesTable).values({ userId: user.id, preferredCurrency: cur });
  }
  res.json({ userId: user.id, preferredCurrency: cur });
});

export default router;
