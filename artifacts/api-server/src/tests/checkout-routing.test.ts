/**
 * Task #500 — Unit tests for the multi-currency checkout routing seam.
 *
 * Covers `lib/checkout.ts` end-to-end with the database, Razorpay client,
 * Stripe client and FX helpers all mocked, so the assertions exercise only
 * the routing/derivation logic itself:
 *
 *   - getOrgCurrencyContext: returns the persisted club_currency_profile,
 *     and falls back to INR + getDefaultTaxProfileId() when no row exists.
 *   - resolveOrgTaxes: passes an explicit profile id straight through, and
 *     auto-resolves the org's default tax profile when omitted.
 *   - createCheckoutOrder: routes INR -> Razorpay, USD/EUR -> Stripe,
 *     and honours an explicit payment_processor_configs override.
 *   - createCheckoutPaymentLink: issues a Razorpay payment link for INR,
 *     a Stripe Checkout Session for non-INR, and rejects the manual
 *     processor (which has no notion of an emailable link).
 *   - recordCheckoutSettlement: writes an FX-ledger entry only when the
 *     booked currency differs from the settled currency, and swallows FX
 *     lookup failures so a transient FX outage cannot block settlement.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Hoisted state so vi.mock factories (which run before module-level
// `const`s are initialised) can safely reference the mocks below.
const hoisted = vi.hoisted(() => ({
  dbResults: [] as unknown[][],
  razorpayCreateOrder: vi.fn(),
  razorpayCreatePaymentLink: vi.fn(),
  stripeIntent: vi.fn(),
  stripeSession: vi.fn(),
  stripeVerify: vi.fn(),
  recordFxLedgerMock: vi.fn(),
  getFxRateMock: vi.fn(),
}));

const dbResults = hoisted.dbResults;
function pushDbResult(rows: unknown[]) { dbResults.push(rows); }
const razorpayCreateOrder = hoisted.razorpayCreateOrder;
const razorpayCreatePaymentLink = hoisted.razorpayCreatePaymentLink;
const stripeIntent = hoisted.stripeIntent;
const stripeSession = hoisted.stripeSession;
const stripeVerify = hoisted.stripeVerify;
const recordFxLedgerMock = hoisted.recordFxLedgerMock;
const getFxRateMock = hoisted.getFxRateMock;

vi.mock("@workspace/db", () => {
  const buildSelectChain = () => {
    // Pop one queued result per db.select() call. Cache as a single promise so
    // multiple awaits / `.limit()` / thenable accesses on the same chain do
    // NOT consume additional queue entries.
    const promise = Promise.resolve(hoisted.dbResults.shift() ?? []);
    const chain: Record<string, unknown> = {};
    chain.from = () => chain;
    chain.where = () => chain;
    chain.orderBy = () => chain;
    chain.limit = () => promise;
    chain.then = promise.then.bind(promise);
    chain.catch = promise.catch.bind(promise);
    return chain;
  };
  return {
    db: { select: () => buildSelectChain() },
    clubCurrencyProfilesTable: {},
    paymentProcessorConfigsTable: {},
    taxProfilesTable: {},
    taxRatesTable: {},
    fxRatesTable: {},
    fxLedgerEntriesTable: {},
  };
});

vi.mock("../lib/razorpay", () => ({
  getRazorpayClient: () => ({
    orders: { create: hoisted.razorpayCreateOrder },
    paymentLink: { create: hoisted.razorpayCreatePaymentLink },
  }),
  getRazorpayKeyId: () => "rzp_test_key",
  verifyPaymentSignature: vi.fn(),
}));

vi.mock("../lib/stripeProcessor", () => ({
  createStripePaymentIntent: hoisted.stripeIntent,
  verifyStripeWebhookSignature: vi.fn(),
  isStripeConfigured: () => true,
  getStripePublishableKey: () => "pk_test_xxx",
  createStripeCheckoutSession: hoisted.stripeSession,
  verifyStripePayment: hoisted.stripeVerify,
}));

vi.mock("../lib/fx", () => ({
  recordFxLedger: hoisted.recordFxLedgerMock,
  getFxRate: hoisted.getFxRateMock,
}));

// Import under test AFTER all vi.mock() calls so the mocks are applied.
import {
  getOrgCurrencyContext,
  resolveOrgTaxes,
  createCheckoutOrder,
  createCheckoutPaymentLink,
  recordCheckoutSettlement,
} from "../lib/checkout";

beforeEach(() => {
  dbResults.length = 0;
  razorpayCreateOrder.mockReset();
  razorpayCreatePaymentLink.mockReset();
  stripeIntent.mockReset();
  stripeSession.mockReset();
  stripeVerify.mockReset();
  recordFxLedgerMock.mockReset();
  getFxRateMock.mockReset();
});

describe("getOrgCurrencyContext", () => {
  it("returns the configured base currency uppercased + default tax profile", async () => {
    pushDbResult([{ baseCurrency: "usd", defaultTaxProfileId: 42 }]);
    const ctx = await getOrgCurrencyContext(7);
    expect(ctx).toEqual({ baseCurrency: "USD", defaultTaxProfileId: 42 });
  });

  it("falls back to INR + getDefaultTaxProfileId() when no row exists", async () => {
    pushDbResult([]); // club_currency_profiles miss
    pushDbResult([{ id: 17 }]); // getDefaultTaxProfileId picks an active default
    const ctx = await getOrgCurrencyContext(8);
    expect(ctx).toEqual({ baseCurrency: "INR", defaultTaxProfileId: 17 });
  });

  it("treats a missing default tax profile id as null", async () => {
    pushDbResult([{ baseCurrency: "EUR", defaultTaxProfileId: null }]);
    const ctx = await getOrgCurrencyContext(9);
    expect(ctx).toEqual({ baseCurrency: "EUR", defaultTaxProfileId: null });
  });
});

describe("resolveOrgTaxes", () => {
  it("uses the explicit tax profile id without consulting the org context", async () => {
    pushDbResult([]); // taxProfilesTable lookup → not found → routing "none"
    const result = await resolveOrgTaxes({
      organizationId: 1,
      taxProfileId: 99,
      taxableAmount: 100,
      currency: "USD",
    });
    expect(result.totalTax).toBe(0);
    expect(result.routing).toBe("none");
    expect(result.totalAmount).toBe(100);
  });

  it("auto-resolves the default tax profile id when one is not supplied", async () => {
    pushDbResult([{ baseCurrency: "INR", defaultTaxProfileId: 5 }]); // getOrgCurrencyContext
    pushDbResult([]); // taxProfilesTable lookup
    const result = await resolveOrgTaxes({
      organizationId: 1,
      taxableAmount: 100,
      currency: "INR",
    });
    expect(result.totalTax).toBe(0);
    expect(result.currency).toBe("INR");
  });
});

describe("createCheckoutOrder routing (Task #447 acceptance contract)", () => {
  it("routes INR through Razorpay by default", async () => {
    pushDbResult([]); // paymentProcessorConfigsTable: no override
    razorpayCreateOrder.mockResolvedValue({ id: "order_INR_1", amount: 10000, currency: "INR" });
    const out = await createCheckoutOrder({
      organizationId: 1, amount: 100, currency: "INR", sourceType: "shop",
    });
    expect(out.processor).toBe("razorpay");
    expect(out.orderId).toBe("order_INR_1");
    expect(out.razorpayKeyId).toBe("rzp_test_key");
    expect(out.stripePublishableKey).toBeUndefined();
    expect(razorpayCreateOrder).toHaveBeenCalledWith(expect.objectContaining({
      amount: 10000, currency: "INR",
    }));
    expect(stripeIntent).not.toHaveBeenCalled();
  });

  it("routes USD through Stripe and surfaces the publishable key + client secret", async () => {
    pushDbResult([]);
    stripeIntent.mockResolvedValue({ id: "pi_USD_1", client_secret: "cs_xxx" });
    const out = await createCheckoutOrder({
      organizationId: 1, amount: 50, currency: "USD", sourceType: "shop",
    });
    expect(out.processor).toBe("stripe");
    expect(out.stripePublishableKey).toBe("pk_test_xxx");
    expect(out.razorpayKeyId).toBeUndefined();
    expect(out.clientSecret).toBe("cs_xxx");
    expect(stripeIntent).toHaveBeenCalledWith(expect.objectContaining({
      amountMinor: 5000, currency: "USD",
    }));
    expect(razorpayCreateOrder).not.toHaveBeenCalled();
  });

  it("routes EUR through Stripe", async () => {
    pushDbResult([]);
    stripeIntent.mockResolvedValue({ id: "pi_EUR", client_secret: null });
    const out = await createCheckoutOrder({
      organizationId: 1, amount: 25, currency: "EUR", sourceType: "shop",
    });
    expect(out.processor).toBe("stripe");
    expect(out.currency).toBe("EUR");
    expect(stripeIntent).toHaveBeenCalledWith(expect.objectContaining({
      amountMinor: 2500, currency: "EUR",
    }));
  });

  it("respects an explicit payment_processor_configs override", async () => {
    // Override pins INR -> manual (e.g. cash flow registered against the org).
    pushDbResult([{ processor: "manual", organizationId: 1, currency: "INR", isActive: true }]);
    const out = await createCheckoutOrder({
      organizationId: 1, amount: 100, currency: "INR", sourceType: "shop",
    });
    expect(out.processor).toBe("manual");
    expect(razorpayCreateOrder).not.toHaveBeenCalled();
    expect(stripeIntent).not.toHaveBeenCalled();
  });
});

describe("createCheckoutPaymentLink", () => {
  it("issues a Razorpay payment link for INR", async () => {
    pushDbResult([]);
    razorpayCreatePaymentLink.mockResolvedValue({ id: "plink_inr", short_url: "https://rzp.io/i/abc" });
    const out = await createCheckoutPaymentLink({
      organizationId: 1, amount: 1000, currency: "INR",
      description: "Annual dues", customerEmail: "p@x.com",
      notify: { email: true }, sourceType: "dues",
    });
    expect(out).toMatchObject({ processor: "razorpay", id: "plink_inr", url: "https://rzp.io/i/abc" });
    expect(razorpayCreatePaymentLink).toHaveBeenCalledWith(expect.objectContaining({
      amount: 100000, currency: "INR", description: "Annual dues",
    }));
  });

  it("issues a Stripe Checkout Session for USD", async () => {
    pushDbResult([]);
    stripeSession.mockResolvedValue({ id: "cs_usd", url: "https://checkout.stripe.com/abc" });
    const out = await createCheckoutPaymentLink({
      organizationId: 1, amount: 50, currency: "USD",
      description: "Tournament entry",
      successUrl: "https://app/ok", cancelUrl: "https://app/no",
      sourceType: "tournament_entry",
    });
    expect(out).toMatchObject({ processor: "stripe", id: "cs_usd", url: "https://checkout.stripe.com/abc" });
    expect(stripeSession).toHaveBeenCalledWith(expect.objectContaining({
      amountMinor: 5000, currency: "USD",
      successUrl: "https://app/ok", cancelUrl: "https://app/no",
    }));
  });

  it("rejects the manual processor (no emailable link)", async () => {
    pushDbResult([{ processor: "manual", organizationId: 1, currency: "INR", isActive: true }]);
    await expect(createCheckoutPaymentLink({
      organizationId: 1, amount: 100, currency: "INR",
      description: "x", sourceType: "dues",
    })).rejects.toThrow(/Manual processor/);
  });

  it("throws when Stripe returns no checkout URL", async () => {
    pushDbResult([]);
    stripeSession.mockResolvedValue({ id: "cs_no_url", url: null });
    await expect(createCheckoutPaymentLink({
      organizationId: 1, amount: 25, currency: "USD",
      description: "x", sourceType: "shop",
    })).rejects.toThrow(/no URL/);
  });
});

describe("recordCheckoutSettlement (FX ledger)", () => {
  it("writes an FX-ledger entry when booked != settled currency", async () => {
    // bookedCurrencyOverride supplied → no db.select() needed for org context.
    getFxRateMock.mockResolvedValue({ rate: 0.012, isFallback: false, source: "live" });
    await recordCheckoutSettlement({
      organizationId: 1, processor: "stripe",
      settledCurrency: "USD", settledAmount: 12,
      paymentRef: "pi_xxx", sourceType: "shop", sourceId: "ord_1",
      bookedCurrencyOverride: "INR",
    });
    expect(getFxRateMock).toHaveBeenCalledWith("INR", "USD");
    expect(recordFxLedgerMock).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: 1,
      bookedCurrency: "INR",
      settledCurrency: "USD",
      settledAmount: 12,
      processor: "stripe",
      sourceType: "shop",
      sourceId: "ord_1",
    }));
    // Booked amount is back-derived from settled / rate.
    const args = recordFxLedgerMock.mock.calls[0][0];
    expect(args.bookedAmount).toBeCloseTo(12 / 0.012, 2);
  });

  it("skips the FX ledger when booked == settled currency", async () => {
    await recordCheckoutSettlement({
      organizationId: 1, processor: "razorpay",
      settledCurrency: "INR", settledAmount: 100,
      paymentRef: "pay_xxx", sourceType: "shop",
      bookedCurrencyOverride: "INR",
    });
    expect(getFxRateMock).not.toHaveBeenCalled();
    expect(recordFxLedgerMock).not.toHaveBeenCalled();
  });

  it("swallows FX-rate lookup errors and does not block settlement", async () => {
    getFxRateMock.mockRejectedValue(new Error("fx provider down"));
    await expect(recordCheckoutSettlement({
      organizationId: 1, processor: "stripe",
      settledCurrency: "USD", settledAmount: 10,
      paymentRef: "pi_z", sourceType: "shop",
      bookedCurrencyOverride: "INR",
    })).resolves.toBeUndefined();
    expect(recordFxLedgerMock).not.toHaveBeenCalled();
  });
});
