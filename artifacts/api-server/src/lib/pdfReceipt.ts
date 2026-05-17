/**
 * PDF Receipt generator for KHARAGOLF payment confirmations.
 * Uses PDFKit to produce a professional A4 receipt stored in object storage.
 */

import PDFDocument from "pdfkit";
import { Readable } from "stream";
import { objectStorageClient } from "./objectStorage";

function parseObjectPath(fullPath: string): { bucketName: string; objectName: string } {
  const withoutScheme = fullPath.replace(/^gs:\/\//, "");
  const slashIdx = withoutScheme.indexOf("/");
  if (slashIdx === -1) return { bucketName: withoutScheme, objectName: "" };
  return { bucketName: withoutScheme.slice(0, slashIdx), objectName: withoutScheme.slice(slashIdx + 1) };
}

export interface ReceiptInfo {
  playerName: string;
  email: string;
  eventName: string;
  eventType: "tournament" | "league";
  amountSubunit: number;
  currency: string;
  currencySymbol: string;
  paymentId: string;
  paidAt: Date;
  orgName?: string | null;
  orgLogoUrl?: string | null;
}

function isSafeReceiptUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return false;
    const host = u.hostname.toLowerCase();
    if (host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0" || host === "::1") return false;
    if (host === "169.254.169.254") return false;
    if (host === "metadata.google.internal" || host.startsWith("metadata.")) return false;
    if (/^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;
    if (host.endsWith(".local") || host.endsWith(".internal")) return false;
    return true;
  } catch {
    return false;
  }
}

async function fetchReceiptLogo(url: string | null | undefined): Promise<Buffer | null> {
  if (!url || !isSafeReceiptUrl(url)) return null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(4000), redirect: "error" });
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") ?? "";
    if (!ct.startsWith("image/")) return null;
    const ab = await res.arrayBuffer();
    if (ab.byteLength > 1 * 1024 * 1024) return null;
    return Buffer.from(ab);
  } catch {
    return null;
  }
}

/**
 * Generates a PDF receipt buffer using PDFKit.
 */
export async function generateReceiptPDF(info: ReceiptInfo): Promise<Buffer> {
  const logoBuffer = await fetchReceiptLogo(info.orgLogoUrl);
  const displayOrgName = info.orgName ?? "KHARAGOLF";

  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 50 });
    const chunks: Buffer[] = [];

    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const amountDisplay = `${info.currencySymbol}${(info.amountSubunit / 100).toFixed(2)}`;
    const dateStr = info.paidAt.toLocaleString("en-US", {
      year: "numeric", month: "long", day: "numeric",
      hour: "2-digit", minute: "2-digit", timeZone: "UTC",
    }) + " UTC";

    // ── Header bar ───────────────────────────────────────────────────────────
    doc.rect(0, 0, doc.page.width, 80).fill("#1e4d2b");
    let headerX = 50;
    if (logoBuffer) {
      try {
        doc.image(logoBuffer, 50, 14, { height: 50 });
        headerX = 110;
      } catch { /* skip if invalid */ }
    }
    doc.fillColor("#ffffff").fontSize(22).font("Helvetica-Bold")
      .text(displayOrgName.toUpperCase(), headerX, 20, { lineBreak: false });
    doc.fillColor("#4ade80").fontSize(9).font("Helvetica")
      .text("ENTERPRISE", headerX, 48, { lineBreak: false });
    doc.fillColor("#9ca3af").fontSize(10)
      .text("Payment Receipt", doc.page.width - 200, 32, { width: 150, align: "right" });

    // ── Title ─────────────────────────────────────────────────────────────────
    doc.moveDown(4);
    doc.fillColor("#111827").fontSize(20).font("Helvetica-Bold")
      .text("Payment Confirmed", { align: "center" });
    doc.moveDown(0.4);
    doc.fillColor("#6b7280").fontSize(12).font("Helvetica")
      .text(dateStr, { align: "center" });

    // ── Receipt box ──────────────────────────────────────────────────────────
    const boxTop = doc.y + 24;
    const boxLeft = 50;
    const boxWidth = doc.page.width - 100;
    doc.roundedRect(boxLeft, boxTop, boxWidth, 178, 6)
      .lineWidth(1).stroke("#e5e7eb");

    const rowY = (n: number) => boxTop + 20 + n * 36;

    function row(label: string, value: string, n: number, highlight = false) {
      doc.fillColor("#6b7280").fontSize(11).font("Helvetica")
        .text(label, boxLeft + 20, rowY(n));
      doc.fillColor(highlight ? "#16a34a" : "#111827")
        .fontSize(highlight ? 16 : 12)
        .font(highlight ? "Helvetica-Bold" : "Helvetica")
        .text(value, boxLeft, rowY(n), { align: "right", width: boxWidth - 20 });
    }

    const label = info.eventType === "tournament" ? "Tournament" : "League";
    row(label, info.eventName, 0);
    row("Participant", info.playerName, 1);
    row("Amount Paid", amountDisplay, 2, true);
    row("Currency", info.currency, 3);
    row("Payment ID", info.paymentId, 4);

    // ── Divider ──────────────────────────────────────────────────────────────
    doc.moveTo(50, boxTop + 178 + 24).lineTo(doc.page.width - 50, boxTop + 178 + 24)
      .stroke("#e5e7eb");

    // ── Footer note ──────────────────────────────────────────────────────────
    doc.fillColor("#9ca3af").fontSize(10).font("Helvetica")
      .text(
        "This receipt is automatically generated by KHARAGOLF Enterprise. " +
        "Please retain it for your records. For queries, contact your tournament organiser.",
        50, boxTop + 210, { width: doc.page.width - 100, align: "center" },
      );

    doc.end();
  });
}

// ─── Shop order + dues invoice receipts ──────────────────────────────────────

export interface ReceiptLineItem {
  description: string;
  quantity?: number;
  unitAmountSubunit?: number;
  totalAmountSubunit: number;
}

export interface ItemisedReceiptInfo {
  /** "Receipt" or "Order Confirmation" — shown as the centre title. */
  title: string;
  /** Document reference (e.g. "Order #12345" or invoice number). */
  documentRef: string;
  buyerName: string;
  email: string;
  lineItems: ReceiptLineItem[];
  totalSubunit: number;
  currency: string;
  currencySymbol: string;
  paymentId: string;
  paidAt: Date;
  /** Subtitle under the org name (e.g. "Pro Shop", "Membership Dues"). */
  productLine?: string;
  /** Footer note shown below the receipt box. */
  footerNote?: string;
  orgName?: string | null;
  orgLogoUrl?: string | null;
}

/**
 * Generates a multi-line-item PDF receipt — used for shop orders and dues
 * invoices, both of which can have several charges in one settlement.
 */
export async function generateItemisedReceiptPDF(info: ItemisedReceiptInfo): Promise<Buffer> {
  const logoBuffer = await fetchReceiptLogo(info.orgLogoUrl);
  const displayOrgName = info.orgName ?? "KHARAGOLF";
  const productLine = info.productLine ?? "ENTERPRISE";

  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 50 });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const sym = info.currencySymbol;
    const fmt = (subunit: number) => `${sym}${(subunit / 100).toFixed(2)}`;
    const totalDisplay = fmt(info.totalSubunit);
    const dateStr = info.paidAt.toLocaleString("en-US", {
      year: "numeric", month: "long", day: "numeric",
      hour: "2-digit", minute: "2-digit", timeZone: "UTC",
    }) + " UTC";

    // Header bar
    doc.rect(0, 0, doc.page.width, 80).fill("#1e4d2b");
    let headerX = 50;
    if (logoBuffer) {
      try { doc.image(logoBuffer, 50, 14, { height: 50 }); headerX = 110; } catch { /* skip */ }
    }
    doc.fillColor("#ffffff").fontSize(22).font("Helvetica-Bold")
      .text(displayOrgName.toUpperCase(), headerX, 20, { lineBreak: false });
    doc.fillColor("#4ade80").fontSize(9).font("Helvetica")
      .text(productLine.toUpperCase(), headerX, 48, { lineBreak: false });
    doc.fillColor("#9ca3af").fontSize(10)
      .text(info.title, doc.page.width - 200, 32, { width: 150, align: "right" });

    // Title
    doc.moveDown(4);
    doc.fillColor("#111827").fontSize(20).font("Helvetica-Bold")
      .text(info.title, { align: "center" });
    doc.moveDown(0.4);
    doc.fillColor("#6b7280").fontSize(12).font("Helvetica")
      .text(dateStr, { align: "center" });

    // Meta rows (document ref + buyer)
    doc.moveDown(1.5);
    const metaLeft = 50;
    const metaRight = doc.page.width - 50;
    doc.fillColor("#6b7280").fontSize(11).font("Helvetica")
      .text(info.documentRef, metaLeft, doc.y, { lineBreak: false });
    doc.fillColor("#6b7280").fontSize(11)
      .text(info.buyerName, metaLeft, doc.y, { width: metaRight - metaLeft, align: "right" });

    // Line items table
    doc.moveDown(1);
    const tableTop = doc.y;
    doc.lineWidth(1).moveTo(metaLeft, tableTop).lineTo(metaRight, tableTop).stroke("#e5e7eb");
    doc.moveDown(0.4);
    doc.fillColor("#6b7280").fontSize(10).font("Helvetica-Bold")
      .text("DESCRIPTION", metaLeft, doc.y, { lineBreak: false });
    doc.text("QTY", metaLeft + 300, doc.y - doc.currentLineHeight(), { width: 50, align: "right", lineBreak: false });
    doc.text("AMOUNT", metaRight - 100, doc.y - doc.currentLineHeight(), { width: 100, align: "right" });
    doc.moveDown(0.3);
    doc.moveTo(metaLeft, doc.y).lineTo(metaRight, doc.y).stroke("#e5e7eb");
    doc.moveDown(0.4);

    doc.fillColor("#111827").fontSize(11).font("Helvetica");
    for (const item of info.lineItems) {
      const rowY = doc.y;
      doc.text(item.description, metaLeft, rowY, { width: 280 });
      const usedHeight = doc.y - rowY;
      const qty = item.quantity ?? 1;
      doc.text(String(qty), metaLeft + 300, rowY, { width: 50, align: "right", lineBreak: false });
      doc.text(fmt(item.totalAmountSubunit), metaRight - 100, rowY, { width: 100, align: "right", lineBreak: false });
      doc.y = rowY + Math.max(usedHeight, doc.currentLineHeight()) + 4;
    }

    doc.moveDown(0.4);
    doc.moveTo(metaLeft, doc.y).lineTo(metaRight, doc.y).stroke("#e5e7eb");
    doc.moveDown(0.6);

    // Total row
    doc.fillColor("#6b7280").fontSize(11).font("Helvetica")
      .text("Total Paid", metaLeft, doc.y, { lineBreak: false });
    doc.fillColor("#16a34a").fontSize(16).font("Helvetica-Bold")
      .text(totalDisplay, metaLeft, doc.y - doc.currentLineHeight(), { width: metaRight - metaLeft, align: "right" });

    // Payment metadata box
    doc.moveDown(1.2);
    const metaBoxTop = doc.y;
    doc.roundedRect(metaLeft, metaBoxTop, metaRight - metaLeft, 60, 6).lineWidth(1).stroke("#e5e7eb");
    doc.fillColor("#6b7280").fontSize(11).font("Helvetica")
      .text("Currency", metaLeft + 16, metaBoxTop + 14, { lineBreak: false });
    doc.fillColor("#111827").fontSize(11)
      .text(info.currency, metaLeft, metaBoxTop + 14, { width: metaRight - metaLeft - 16, align: "right" });
    doc.fillColor("#6b7280").fontSize(11)
      .text("Payment ID", metaLeft + 16, metaBoxTop + 36, { lineBreak: false });
    doc.fillColor("#111827").fontSize(10)
      .text(info.paymentId, metaLeft, metaBoxTop + 36, { width: metaRight - metaLeft - 16, align: "right" });

    // Footer
    doc.fillColor("#9ca3af").fontSize(10).font("Helvetica")
      .text(
        info.footerNote ?? `This receipt is automatically generated by ${displayOrgName}. Please retain it for your records.`,
        50, metaBoxTop + 80, { width: doc.page.width - 100, align: "center" },
      );

    doc.end();
  });
}

/**
 * Stores a receipt PDF in object storage and returns its object path.
 * Key format: receipts/{kind}_{id}_{timestamp}.pdf
 */
export async function storeReceiptPDF(
  pdfBuffer: Buffer,
  kind: "player" | "league_member" | "shop_order" | "dues_invoice",
  entityId: number,
): Promise<string> {
  const privateDir = process.env.PRIVATE_OBJECT_DIR;
  if (!privateDir) throw new Error("PRIVATE_OBJECT_DIR not configured");

  const timestamp = Date.now();
  const objectKey = `receipts/${kind}_${entityId}_${timestamp}.pdf`;
  const fullPath = `${privateDir}/${objectKey}`;
  const { bucketName, objectName } = parseObjectPath(fullPath);
  const bucket = objectStorageClient.bucket(bucketName);
  const file = bucket.file(objectName);

  await file.save(pdfBuffer, { contentType: "application/pdf", resumable: false });

  return fullPath;
}
