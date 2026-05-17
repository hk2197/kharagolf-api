import Razorpay from "razorpay";
import crypto from "crypto";

// ─── Typed interfaces for Razorpay APIs not yet in the official SDK types ───

export interface RazorpayPaymentLinkCreateOpts {
  amount: number;
  currency: string;
  description?: string;
  customer?: { name?: string; email?: string; contact?: string };
  notify?: { email?: boolean; sms?: boolean };
  reminder_enable?: boolean;
  upi_link?: boolean;
  expire_by?: number;
  callback_url?: string;
  reference_id?: string;
  notes?: Record<string, string>;
}

export interface RazorpayPaymentLinkResponse {
  id: string;
  short_url: string;
}

/** Extended Razorpay client with paymentLink typed methods */
export type RazorpayExtended = Razorpay & {
  paymentLink: {
    create(opts: RazorpayPaymentLinkCreateOpts): Promise<RazorpayPaymentLinkResponse>;
  };
};

/**
 * Cancel a Razorpay subscription.
 * @param subscriptionId  The Razorpay subscription ID (e.g. "sub_xxx").
 * @param atCycleEnd      When true, cancels at the end of the current billing cycle.
 * @throws               Propagates Razorpay API errors — caller must handle.
 */
export async function cancelRazorpaySubscription(
  subscriptionId: string,
  atCycleEnd = true,
): Promise<void> {
  const rz = getRazorpayClient();
  await rz.subscriptions.cancel(subscriptionId, atCycleEnd);
}

export function getRazorpayClient(): RazorpayExtended {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;

  if (!keyId || !keySecret) {
    throw new Error("RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET must be set");
  }

  return new Razorpay({ key_id: keyId, key_secret: keySecret }) as RazorpayExtended;
}

export function getRazorpayKeyId(): string {
  const keyId = process.env.RAZORPAY_KEY_ID;
  if (!keyId) throw new Error("RAZORPAY_KEY_ID is not set");
  return keyId;
}

export function verifyWebhookSignature(body: string, signature: string, secret: string): boolean {
  const expectedSignature = crypto
    .createHmac("sha256", secret)
    .update(body)
    .digest("hex");
  return expectedSignature === signature;
}

// ─── RazorpayX Payouts API ───────────────────────────────────────────────
// The official Razorpay SDK does not yet wrap the RazorpayX Payouts surface
// (contacts / fund accounts / payouts), so we hit the REST API directly with
// HTTP Basic auth using the same key id + secret used for the rest of the
// integration. Requires `RAZORPAYX_ACCOUNT_NUMBER` (the virtual account
// from which money is debited).

export interface RazorpayContact {
  id: string;
  name: string;
  email?: string;
  contact?: string;
  type?: string;
  reference_id?: string;
}

export interface RazorpayFundAccount {
  id: string;
  contact_id: string;
  account_type: "vpa" | "bank_account";
  vpa?: { address: string };
  bank_account?: { name: string; ifsc: string; account_number: string };
}

export interface RazorpayPayout {
  id: string;
  status: "queued" | "pending" | "rejected" | "processing" | "processed" | "cancelled" | "reversed" | "failed";
  reference_id?: string;
  failure_reason?: string;
  utr?: string;
  amount: number;
  fund_account_id: string;
  mode: string;
}

interface RazorpayApiError extends Error { status: number; payload: unknown }

async function razorpayXRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) {
    throw new Error("RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET must be set");
  }
  const auth = Buffer.from(`${keyId}:${keySecret}`).toString("base64");
  const r = await fetch(`https://api.razorpay.com/v1${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Basic ${auth}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json: unknown;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (!r.ok) {
    const errObj = (json as { error?: { description?: string; code?: string } } | undefined)?.error;
    const err = new Error(
      errObj?.description ?? errObj?.code ?? `Razorpay ${method} ${path} failed (${r.status})`,
    ) as RazorpayApiError;
    err.status = r.status;
    err.payload = json;
    throw err;
  }
  return json as T;
}

export async function createRazorpayContact(opts: {
  name: string;
  email?: string;
  contact?: string;
  reference_id?: string;
  type?: string;
  notes?: Record<string, string>;
}): Promise<RazorpayContact> {
  return razorpayXRequest<RazorpayContact>("POST", "/contacts", { type: opts.type ?? "vendor", ...opts });
}

export type CreateFundAccountOpts =
  | { contact_id: string; account_type: "vpa"; vpa: { address: string } }
  | {
      contact_id: string;
      account_type: "bank_account";
      bank_account: { name: string; ifsc: string; account_number: string };
    };

export async function createRazorpayFundAccount(opts: CreateFundAccountOpts): Promise<RazorpayFundAccount> {
  return razorpayXRequest<RazorpayFundAccount>("POST", "/fund_accounts", opts);
}

// ─── Fund-account validation ────────────────────────────────────────────
// Razorpay offers two ways to validate a fund account before payouts:
//   * UPI VPA lookup:  POST /v1/payments/validate/vpa
//   * Bank penny-drop: POST /v1/fund_accounts/validations  (₹1 transfer)
// Penny-drop returns asynchronously; we poll the validation until it is
// either `completed` (with `results.account_status`) or `failed`.

export interface RazorpayVpaValidation {
  vpa: string;
  success: boolean;
  customer_name?: string;
}

export async function validateRazorpayVpa(vpa: string): Promise<RazorpayVpaValidation> {
  return razorpayXRequest<RazorpayVpaValidation>("POST", "/payments/validate/vpa", { vpa });
}

export interface RazorpayFundAccountValidation {
  id: string;
  status: "created" | "completed" | "failed";
  fund_account?: { id: string };
  results?: {
    account_status?: "active" | "invalid";
    registered_name?: string;
  };
  error?: { description?: string; code?: string };
}

/**
 * Initiate a ₹1 penny-drop validation against a previously-created bank
 * fund account, then poll until it is `completed` / `failed` (or the
 * timeout elapses). Returns the final validation record.
 */
export async function validateRazorpayBankFundAccount(
  fundAccountId: string,
  opts: { amountPaise?: number; timeoutMs?: number; pollIntervalMs?: number } = {},
): Promise<RazorpayFundAccountValidation> {
  const accountNumber = process.env.RAZORPAYX_ACCOUNT_NUMBER;
  if (!accountNumber) throw new Error("RAZORPAYX_ACCOUNT_NUMBER must be set to verify bank accounts");
  const created = await razorpayXRequest<RazorpayFundAccountValidation>(
    "POST",
    "/fund_accounts/validations",
    {
      account_number: accountNumber,
      fund_account: { id: fundAccountId },
      amount: opts.amountPaise ?? 100,
      currency: "INR",
      notes: { purpose: "coach_payout_account_verification" },
    },
  );
  if (created.status !== "created") return created;

  const timeoutMs = opts.timeoutMs ?? 8000;
  const pollIntervalMs = opts.pollIntervalMs ?? 750;
  const deadline = Date.now() + timeoutMs;
  let latest = created;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, pollIntervalMs));
    latest = await razorpayXRequest<RazorpayFundAccountValidation>(
      "GET", `/fund_accounts/validations/${created.id}`,
    );
    if (latest.status === "completed" || latest.status === "failed") return latest;
  }
  return latest;
}

export type RazorpayPayoutMode = "UPI" | "IMPS" | "NEFT" | "RTGS";

export async function createRazorpayPayout(opts: {
  fund_account_id: string;
  amount: number;
  mode: RazorpayPayoutMode;
  purpose?: string;
  reference_id?: string;
  narration?: string;
  notes?: Record<string, string>;
  queue_if_low_balance?: boolean;
}): Promise<RazorpayPayout> {
  const accountNumber = process.env.RAZORPAYX_ACCOUNT_NUMBER;
  if (!accountNumber) throw new Error("RAZORPAYX_ACCOUNT_NUMBER must be set to disburse payouts");
  return razorpayXRequest<RazorpayPayout>("POST", "/payouts", {
    account_number: accountNumber,
    currency: "INR",
    purpose: opts.purpose ?? "vendor advance",
    queue_if_low_balance: opts.queue_if_low_balance ?? true,
    ...opts,
  });
}

export function verifyPaymentSignature(orderId: string, paymentId: string, signature: string): boolean {
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keySecret) throw new Error("RAZORPAY_KEY_SECRET is not set");

  const expectedSignature = crypto
    .createHmac("sha256", keySecret)
    .update(`${orderId}|${paymentId}`)
    .digest("hex");
  return expectedSignature === signature;
}
