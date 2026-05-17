/**
 * Task #373 — Pluggable payment-processor abstraction.
 *
 * Selects the right processor for a given (organization, currency) pair.
 * Default policy (Task #447 acceptance criterion):
 *   - INR  -> Razorpay
 *   - any other currency -> Stripe
 *
 * An explicit row in `payment_processor_configs` overrides the default
 * (e.g. an org that wants to keep using Razorpay for USD/GBP via its
 * international Razorpay merchant account).
 *
 * The interface is intentionally narrow — callers only need to create an
 * order, verify a payment signature, and (optionally) cancel a subscription.
 * Processor-specific extras (Razorpay subscription plans, Stripe Checkout
 * sessions) remain in their own libraries; this layer just routes.
 */

import { db } from "@workspace/db";
import { paymentProcessorConfigsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { getRazorpayClient, verifyPaymentSignature as razorpayVerify } from "./razorpay";
import {
  createStripePaymentIntent,
  verifyStripeWebhookSignature,
} from "./stripeProcessor";

export type ProcessorName = "razorpay" | "stripe" | "manual";

export const RAZORPAY_SUPPORTED_CURRENCIES = new Set([
  "INR", "USD", "GBP", "EUR", "AED", "SGD", "AUD",
]);

export interface CreateOrderInput {
  organizationId: number;
  amount: number;          // major units (e.g. 100.00)
  currency: string;
  receipt?: string;
  metadata?: Record<string, string | number | boolean>;
  description?: string;
  customerEmail?: string;
}

export interface CreateOrderResult {
  processor: ProcessorName;
  orderId: string;
  clientSecret?: string;   // Stripe payment intent client secret
  amountMinor: number;
  currency: string;
  raw: unknown;
}

export interface VerifyPaymentInput {
  processor: ProcessorName;
  orderId?: string;
  paymentId?: string;
  signature?: string;
  // Stripe webhook payload (raw body) + sig header
  rawBody?: Buffer | string;
  sigHeader?: string;
  webhookSecret?: string;
}

export interface PaymentProcessor {
  name: ProcessorName;
  createOrder(input: CreateOrderInput): Promise<CreateOrderResult>;
  verifyPayment(input: VerifyPaymentInput): Promise<boolean>;
}

class RazorpayProcessor implements PaymentProcessor {
  name: ProcessorName = "razorpay";
  async createOrder(input: CreateOrderInput): Promise<CreateOrderResult> {
    if (!RAZORPAY_SUPPORTED_CURRENCIES.has(input.currency.toUpperCase())) {
      throw new Error(`Razorpay does not support currency ${input.currency}`);
    }
    const amountMinor = Math.round(input.amount * 100);
    const razorpay = getRazorpayClient();
    const order = await razorpay.orders.create({
      amount: amountMinor,
      currency: input.currency.toUpperCase(),
      receipt: input.receipt,
      notes: input.metadata as Record<string, string> | undefined,
    });
    return {
      processor: "razorpay",
      orderId: order.id,
      amountMinor,
      currency: input.currency.toUpperCase(),
      raw: order,
    };
  }
  async verifyPayment(input: VerifyPaymentInput): Promise<boolean> {
    if (!input.orderId || !input.paymentId || !input.signature) return false;
    return razorpayVerify(input.orderId, input.paymentId, input.signature);
  }
}

class StripeProcessor implements PaymentProcessor {
  name: ProcessorName = "stripe";
  async createOrder(input: CreateOrderInput): Promise<CreateOrderResult> {
    const amountMinor = Math.round(input.amount * 100);
    const intent = await createStripePaymentIntent({
      amountMinor,
      currency: input.currency.toUpperCase(),
      description: input.description,
      receiptEmail: input.customerEmail,
      metadata: input.metadata,
    });
    return {
      processor: "stripe",
      orderId: intent.id,
      clientSecret: intent.client_secret ?? undefined,
      amountMinor,
      currency: input.currency.toUpperCase(),
      raw: intent,
    };
  }
  async verifyPayment(input: VerifyPaymentInput): Promise<boolean> {
    if (!input.rawBody || !input.sigHeader || !input.webhookSecret) return false;
    return verifyStripeWebhookSignature(input.rawBody, input.sigHeader, input.webhookSecret);
  }
}

class ManualProcessor implements PaymentProcessor {
  name: ProcessorName = "manual";
  async createOrder(input: CreateOrderInput): Promise<CreateOrderResult> {
    // Used for cash / bank-transfer / cheque flows. The "order" is just a
    // synthetic id that the operator marks paid out-of-band.
    const id = `manual_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    return {
      processor: "manual",
      orderId: id,
      amountMinor: Math.round(input.amount * 100),
      currency: input.currency.toUpperCase(),
      raw: { id, manual: true, ...input.metadata },
    };
  }
  async verifyPayment(): Promise<boolean> { return true; }
}

const RAZORPAY = new RazorpayProcessor();
const STRIPE = new StripeProcessor();
const MANUAL = new ManualProcessor();

export function getProcessor(name: ProcessorName): PaymentProcessor {
  switch (name) {
    case "razorpay": return RAZORPAY;
    case "stripe":   return STRIPE;
    case "manual":   return MANUAL;
  }
}

/**
 * Pick the processor for (org, currency). Order of precedence:
 *  1. Explicit row in payment_processor_configs (active).
 *  2. INR -> Razorpay.
 *  3. Any other currency -> Stripe.
 *
 * Note: Razorpay technically supports a handful of non-INR currencies on
 * its international merchant account (USD/GBP/EUR/AED/SGD/AUD), but the
 * Task #447 routing contract is INR-only on Razorpay. Orgs that need to
 * keep Razorpay for foreign currencies must register an explicit override
 * in `payment_processor_configs`.
 */
export async function selectProcessor(
  organizationId: number,
  currency: string,
): Promise<PaymentProcessor> {
  const cur = currency.toUpperCase();
  const [cfg] = await db.select().from(paymentProcessorConfigsTable)
    .where(and(
      eq(paymentProcessorConfigsTable.organizationId, organizationId),
      eq(paymentProcessorConfigsTable.currency, cur),
      eq(paymentProcessorConfigsTable.isActive, true),
    ))
    .limit(1);
  if (cfg) return getProcessor(cfg.processor);
  if (cur === "INR") return RAZORPAY;
  return STRIPE;
}
