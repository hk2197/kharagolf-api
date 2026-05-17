import {
  sendPaymentReceiptEmail,
  sendShopOrderReceiptMail,
  sendDuesReceiptMail,
  type EmailBranding,
} from "./mailer";
import {
  generateReceiptPDF,
  generateItemisedReceiptPDF,
  storeReceiptPDF,
  type ReceiptLineItem,
} from "./pdfReceipt";
import { logger } from "./logger";

const CURRENCY_SYMBOLS: Record<string, string> = {
  INR: "₹", USD: "$", GBP: "£", AED: "د.إ", EUR: "€", SGD: "S$", AUD: "A$",
};

export function currencySymbol(code: string): string {
  return CURRENCY_SYMBOLS[code] ?? code;
}

/**
 * Generates a PDF receipt (best-effort, stored in object storage) and emails
 * it to the buyer. Used by both the inline post-verify path
 * (routes/payments.ts) and the Stripe settlement webhook
 * (routes/webhooks.ts) so non-INR clubs get the same receipt as Razorpay
 * payers.
 */
export async function sendReceiptEmail(opts: {
  email: string;
  name: string;
  eventName: string;
  eventType: "tournament" | "league";
  amountSubunit: number;
  currency: string;
  paymentId: string;
  entityId?: number;
  receiptBaseUrl?: string;
  branding?: EmailBranding;
}): Promise<void> {
  const { email, name, eventName, eventType, amountSubunit, currency, paymentId, entityId, receiptBaseUrl, branding } = opts;
  if (!email) return;

  let receiptUrl: string | undefined;

  if (entityId !== undefined) {
    try {
      const pdfBuffer = await generateReceiptPDF({
        playerName: name, email, eventName, eventType,
        amountSubunit, currency, currencySymbol: currencySymbol(currency),
        paymentId, paidAt: new Date(),
        orgName: branding?.orgName ?? undefined,
        orgLogoUrl: branding?.logoUrl ?? undefined,
      });
      const kind = eventType === "tournament" ? "player" : "league_member";
      await storeReceiptPDF(pdfBuffer, kind, entityId);
      if (receiptBaseUrl && entityId !== undefined) {
        const segment = eventType === "tournament" ? "tournament-player" : "league-member";
        receiptUrl = `${receiptBaseUrl}/api/payments/${segment}/${entityId}/receipt`;
      }
    } catch {
      // PDF generation failure should not block the email
    }
  }

  try {
    await sendPaymentReceiptEmail({
      to: email, name, eventName, eventType,
      amountSubunit, currency, currencySymbol: currencySymbol(currency),
      paymentId, receiptUrl, branding,
    });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error({ email, eventName, errMsg }, "[paymentReceipts] Failed to send receipt email");
  }
}

/**
 * Generates a PDF receipt for a paid shop-order group, stores it in object
 * storage (best-effort), and emails it to the buyer with the PDF attached.
 * Used by both the Razorpay verify-cart path and the Stripe settlement webhook
 * so every shop buyer receives the same downloadable receipt.
 */
export async function sendShopOrderReceiptEmail(opts: {
  email: string;
  buyerName: string;
  /** Primary order id used for the storage filename + receipt header. */
  orderId: number;
  lineItems: ReceiptLineItem[];
  totalSubunit: number;
  currency: string;
  paymentId: string;
  paidAt?: Date;
  branding?: EmailBranding;
}): Promise<void> {
  const { email, buyerName, orderId, lineItems, totalSubunit, currency, paymentId, paidAt, branding } = opts;
  if (!email) return;

  const sym = currencySymbol(currency);
  const orderRef = `Order #${orderId}`;
  const totalDisplay = `${sym}${(totalSubunit / 100).toFixed(2)}`;

  let pdfBuffer: Buffer | null = null;
  try {
    pdfBuffer = await generateItemisedReceiptPDF({
      title: "Order Receipt",
      documentRef: orderRef,
      buyerName,
      email,
      lineItems,
      totalSubunit,
      currency,
      currencySymbol: sym,
      paymentId,
      paidAt: paidAt ?? new Date(),
      productLine: "Pro Shop",
      footerNote: "Keep this receipt for warranty, returns, and expense reporting.",
      orgName: branding?.orgName ?? undefined,
      orgLogoUrl: branding?.logoUrl ?? undefined,
    });
    await storeReceiptPDF(pdfBuffer, "shop_order", orderId).catch((err) =>
      logger.warn({ err, orderId }, "[paymentReceipts] shop receipt storage failed (non-fatal)"),
    );
  } catch (err) {
    logger.warn({ err, orderId }, "[paymentReceipts] shop receipt PDF generation failed");
  }

  if (!pdfBuffer) return; // task requires a PDF — skip email when generation fails

  try {
    await sendShopOrderReceiptMail({
      to: email,
      buyerName,
      orderRef,
      lineItems: lineItems.map((li) => ({ description: li.description, quantity: li.quantity ?? 1 })),
      totalDisplay,
      paymentId,
      pdfBuffer,
      pdfFilename: `receipt_order_${orderId}.pdf`,
      branding,
    });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error({ email, orderId, errMsg }, "[paymentReceipts] Failed to send shop order receipt email");
  }
}

/**
 * Generates a PDF receipt for a paid dues invoice, stores it in object
 * storage (best-effort), and emails it to the member with the PDF attached.
 * Used by both the Razorpay/manual verify path and the Stripe settlement
 * webhook so every member receives the same downloadable receipt.
 */
export async function sendDuesReceiptEmail(opts: {
  email: string;
  memberName: string;
  invoiceId: number;
  invoiceNumber: string;
  lineItems: ReceiptLineItem[];
  totalSubunit: number;
  currency: string;
  paymentId: string;
  paidAt?: Date;
  branding?: EmailBranding;
}): Promise<void> {
  const { email, memberName, invoiceId, invoiceNumber, lineItems, totalSubunit, currency, paymentId, paidAt, branding } = opts;
  if (!email) return;

  const sym = currencySymbol(currency);
  const totalDisplay = `${sym}${(totalSubunit / 100).toFixed(2)}`;

  let pdfBuffer: Buffer | null = null;
  try {
    pdfBuffer = await generateItemisedReceiptPDF({
      title: "Dues Receipt",
      documentRef: `Invoice ${invoiceNumber}`,
      buyerName: memberName,
      email,
      lineItems,
      totalSubunit,
      currency,
      currencySymbol: sym,
      paymentId,
      paidAt: paidAt ?? new Date(),
      productLine: "Membership Dues",
      footerNote: "Retain this receipt for your records and expense reports.",
      orgName: branding?.orgName ?? undefined,
      orgLogoUrl: branding?.logoUrl ?? undefined,
    });
    await storeReceiptPDF(pdfBuffer, "dues_invoice", invoiceId).catch((err) =>
      logger.warn({ err, invoiceId }, "[paymentReceipts] dues receipt storage failed (non-fatal)"),
    );
  } catch (err) {
    logger.warn({ err, invoiceId }, "[paymentReceipts] dues receipt PDF generation failed");
  }

  if (!pdfBuffer) return;

  try {
    await sendDuesReceiptMail({
      to: email,
      memberName,
      invoiceNumber,
      totalDisplay,
      paymentId,
      pdfBuffer,
      pdfFilename: `receipt_invoice_${invoiceNumber}.pdf`,
      branding,
    });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error({ email, invoiceId, errMsg }, "[paymentReceipts] Failed to send dues receipt email");
  }
}
