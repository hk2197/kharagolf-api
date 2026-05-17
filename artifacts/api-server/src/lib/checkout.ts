/**
 * Task #447 — Unified checkout helpers.
 *
 * Provides a thin wrapper that routes shop / dues / tournament / league /
 * POS checkout flows through the new payment-processor abstraction
 * (`selectProcessor`) and the multi-jurisdiction tax engine
 * (`resolveTaxes`). Also records FX-ledger entries when the booked
 * currency differs from the org's base currency.
 *
 * The GST invoice path (createGstInvoice / resolveGstTax) is intentionally
 * left untouched — Indian-jurisdiction profiles continue to flow through
 * `resolveTaxes` -> `resolveGstTax` so CGST/SGST/IGST behaviour is
 * canonical, and `createGstInvoice` callers in the routes are not changed.
 */

import { db } from "@workspace/db";
import { clubCurrencyProfilesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { selectProcessor, type CreateOrderInput, type CreateOrderResult, type ProcessorName } from "./paymentProcessor";
import { resolveTaxes, type TaxComputationInput, type TaxComputationResult, getDefaultTaxProfileId } from "./taxEngine";
import { recordFxLedger, getFxRate } from "./fx";
import { getRazorpayClient, getRazorpayKeyId, type RazorpayPaymentLinkCreateOpts } from "./razorpay";
import { createStripeCheckoutSession, getStripePublishableKey, verifyStripePayment } from "./stripeProcessor";
import { logger } from "./logger";

export type { ProcessorName } from "./paymentProcessor";

export interface OrgCurrencyContext {
  baseCurrency: string;
  defaultTaxProfileId: number | null;
}

/** Resolve the org's base currency + default tax profile id, with sensible fallbacks. */
export async function getOrgCurrencyContext(organizationId: number): Promise<OrgCurrencyContext> {
  const [profile] = await db.select({
    baseCurrency: clubCurrencyProfilesTable.baseCurrency,
    defaultTaxProfileId: clubCurrencyProfilesTable.defaultTaxProfileId,
  })
    .from(clubCurrencyProfilesTable)
    .where(eq(clubCurrencyProfilesTable.organizationId, organizationId));
  if (profile) {
    return {
      baseCurrency: (profile.baseCurrency ?? "INR").toUpperCase(),
      defaultTaxProfileId: profile.defaultTaxProfileId ?? null,
    };
  }
  // Fall back to any default tax profile defined on the org.
  const taxProfileId = await getDefaultTaxProfileId(organizationId).catch(() => null);
  return { baseCurrency: "INR", defaultTaxProfileId: taxProfileId };
}

/** Convenience wrapper around resolveTaxes that auto-resolves the default tax profile. */
export async function resolveOrgTaxes(
  args: Omit<TaxComputationInput, "taxProfileId"> & { taxProfileId?: number | null },
): Promise<TaxComputationResult> {
  let profileId = args.taxProfileId ?? null;
  if (profileId == null) {
    const ctx = await getOrgCurrencyContext(args.organizationId);
    profileId = ctx.defaultTaxProfileId;
  }
  return resolveTaxes({ ...args, taxProfileId: profileId });
}

export interface CheckoutOrderInput extends CreateOrderInput {
  /** Source type for FX ledger entries (e.g. "shop", "dues", "tournament_entry"). */
  sourceType: string;
  /** Source id for FX ledger entries (order id, invoice id, player id). */
  sourceId?: string | number | null;
  /** Override base currency lookup (test hook); normally resolved from clubCurrencyProfilesTable. */
  baseCurrencyOverride?: string;
}

export interface CheckoutOrderResult extends CreateOrderResult {
  processor: ProcessorName;
  /** Razorpay key id (only set when the selected processor is Razorpay). */
  razorpayKeyId?: string;
  /** Stripe publishable key (only set when the selected processor is Stripe). */
  stripePublishableKey?: string;
}

/**
 * Create a checkout order via the right processor for (org, currency).
 * Routes INR to Razorpay and any other currency to Stripe (per Task #447);
 * an explicit payment_processor_configs override can pin a different processor.
 *
 * NOTE: FX-ledger entries are NOT recorded here — they are recorded on
 * settlement (verify endpoint / webhook success handler) via
 * `recordCheckoutSettlement` so abandoned/failed payments don't pollute the
 * ledger.
 */
export async function createCheckoutOrder(input: CheckoutOrderInput): Promise<CheckoutOrderResult> {
  const processor = await selectProcessor(input.organizationId, input.currency);
  const order = await processor.createOrder(input);

  return {
    ...order,
    processor: order.processor,
    razorpayKeyId: order.processor === "razorpay" ? getRazorpayKeyId() : undefined,
    stripePublishableKey: order.processor === "stripe" ? getStripePublishableKey() : undefined,
  };
}

export interface CheckoutPaymentLinkInput {
  organizationId: number;
  amount: number;
  currency: string;
  description: string;
  customerName?: string;
  customerEmail?: string;
  customerPhone?: string;
  successUrl?: string;
  cancelUrl?: string;
  notify?: { email?: boolean; sms?: boolean };
  expireAtUnix?: number;
  referenceId?: string;
  notes?: Record<string, string | number | boolean>;
  sourceType: string;
  sourceId?: string | number | null;
}

export interface CheckoutPaymentLinkResult {
  processor: ProcessorName;
  id: string;
  url: string;
}

/**
 * Create an emailable payment link via the right processor for (org, currency).
 * - INR gets a Razorpay Payment Link.
 * - Any other currency gets a Stripe Checkout Session redirect URL.
 * - An active payment_processor_configs row overrides the default routing.
 *
 * NOTE: FX ledger entries are recorded on settlement (verify / webhook),
 * not here — see `recordCheckoutSettlement`.
 */
export async function createCheckoutPaymentLink(input: CheckoutPaymentLinkInput): Promise<CheckoutPaymentLinkResult> {
  const processor = await selectProcessor(input.organizationId, input.currency);
  const amountMinor = Math.round(input.amount * 100);
  const currency = input.currency.toUpperCase();

  let result: CheckoutPaymentLinkResult;
  if (processor.name === "razorpay") {
    const opts: RazorpayPaymentLinkCreateOpts = {
      amount: amountMinor,
      currency,
      description: input.description,
      customer: {
        name: input.customerName ?? "",
        email: input.customerEmail,
        contact: input.customerPhone,
      },
      notify: { email: !!(input.notify?.email && input.customerEmail), sms: !!(input.notify?.sms && input.customerPhone) },
      reminder_enable: true,
      ...(input.expireAtUnix ? { expire_by: input.expireAtUnix } : {}),
      ...(input.referenceId ? { reference_id: input.referenceId } : {}),
      notes: input.notes as Record<string, string> | undefined,
    };
    const link = await getRazorpayClient().paymentLink.create(opts);
    result = { processor: "razorpay", id: link.id, url: link.short_url };
  } else if (processor.name === "stripe") {
    const successUrl = input.successUrl ?? `${process.env.API_BASE_URL ?? ""}/payments/callback?status=success`;
    const cancelUrl = input.cancelUrl ?? `${process.env.API_BASE_URL ?? ""}/payments/callback?status=cancelled`;
    const session = await createStripeCheckoutSession({
      amountMinor,
      currency,
      description: input.description,
      customerEmail: input.customerEmail,
      successUrl,
      cancelUrl,
      metadata: input.notes,
    });
    if (!session.url) throw new Error("[checkout] Stripe Checkout Session returned no URL");
    result = { processor: "stripe", id: session.id, url: session.url };
  } else {
    throw new Error(`[checkout] Manual processor cannot issue payment links`);
  }

  return result;
}

/**
 * Record settlement of a confirmed payment. Called from verify endpoints
 * (and webhook handlers) AFTER the processor has confirmed the funds were
 * captured. Writes an FX-ledger entry when the booked currency
 * (the org's base) differs from the settled currency. Idempotency is the
 * caller's responsibility — typically the verify endpoint guards against
 * double-marking-paid.
 */
export interface CheckoutSettlementInput {
  organizationId: number;
  processor: ProcessorName;
  settledCurrency: string;
  settledAmount: number;
  paymentRef: string;
  sourceType: string;
  sourceId?: string | number | null;
  bookedCurrencyOverride?: string;
  /**
   * Moment the upstream processor confirmed settlement. Optional — defaults
   * to now() inside `recordFxLedger`. Webhook handlers should pass the event
   * timestamp so the ledger reflects when the funds actually moved, not when
   * we processed the webhook.
   */
  settledAt?: Date;
}

export async function recordCheckoutSettlement(input: CheckoutSettlementInput): Promise<void> {
  const settledCurrency = input.settledCurrency.toUpperCase();
  const bookedCurrency = (input.bookedCurrencyOverride
    ?? (await getOrgCurrencyContext(input.organizationId)).baseCurrency).toUpperCase();
  if (bookedCurrency === settledCurrency) return;
  try {
    const quote = await getFxRate(bookedCurrency, settledCurrency);
    await recordFxLedger({
      organizationId: input.organizationId,
      bookedCurrency,
      bookedAmount: +(input.settledAmount / (quote.rate || 1)).toFixed(2),
      settledCurrency,
      settledAmount: input.settledAmount,
      fxRate: quote.rate,
      sourceType: input.sourceType,
      sourceId: input.sourceId != null ? String(input.sourceId) : null,
      processor: input.processor,
      notes: quote.isFallback ? `fx-source:${quote.source};payment_ref:${input.paymentRef}` : `payment_ref:${input.paymentRef}`,
      settledAt: input.settledAt ?? new Date(),
    });
  } catch (err) {
    logger.warn({ err, bookedCurrency, settledCurrency, paymentRef: input.paymentRef }, "[checkout] FX ledger entry skipped on settlement");
  }
}

/**
 * Verify a checkout payment using the right processor. For Stripe payments,
 * accepts a payment_intent id or checkout_session id and confirms the
 * payment is settled. For Razorpay, this is a no-op stub — callers continue
 * to use `verifyPaymentSignature` from lib/razorpay directly to preserve
 * the existing signature-validation flow.
 */
export async function verifyCheckoutPayment(opts: {
  processor: ProcessorName;
  stripePaymentIntentId?: string;
  stripeCheckoutSessionId?: string;
}): Promise<{
  paid: boolean;
  amountMinor: number;
  currency: string;
  paymentRef: string;
  objectId: string;
  metadata: Record<string, string>;
}> {
  if (opts.processor !== "stripe") {
    throw new Error(`[checkout] verifyCheckoutPayment only handles Stripe; use lib/razorpay.verifyPaymentSignature for Razorpay`);
  }
  const r = await verifyStripePayment({
    paymentIntentId: opts.stripePaymentIntentId,
    checkoutSessionId: opts.stripeCheckoutSessionId,
  });
  return {
    paid: r.paid,
    amountMinor: r.amountMinor,
    currency: r.currency,
    paymentRef: r.paymentRef,
    objectId: r.objectId,
    metadata: r.metadata,
  };
}
