/**
 * GST Invoice Service
 *
 * Handles:
 *  - Thread-safe sequential invoice number generation per org/channel
 *  - Multi-state GST routing (CGST+SGST vs IGST vs zero-rated export)
 *  - GST-compliant PDF generation (PDFKit)
 *  - Object storage upload
 *  - Invoice email delivery with PDF attachment
 */

import PDFDocument from "pdfkit";
import { db } from "@workspace/db";
import {
  invoiceSequencesTable,
  gstInvoicesTable,
  shopStoreSettingsTable,
} from "@workspace/db";
import { eq, and, sql } from "drizzle-orm";
import { objectStorageClient } from "./objectStorage";
import nodemailer from "nodemailer";
import { logger } from "./logger";

// ─── Retry Utility ─────────────────────────────────────────────────────────────

async function withRetry<T>(
  fn: () => Promise<T>,
  { maxAttempts = 3, delayMs = 500, label = "operation" }: { maxAttempts?: number; delayMs?: number; label?: string } = {},
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts) {
        logger.warn({ err, attempt, label }, `[gstInvoice] ${label} failed — retrying (${attempt}/${maxAttempts})`);
        await new Promise(r => setTimeout(r, delayMs * attempt));
      }
    }
  }
  throw lastErr;
}

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface GstLineItem {
  description: string;
  hsnSacCode?: string;
  quantity: number;
  unitPrice: number;
  gstRate: number;
}

export interface GstInvoiceRequest {
  organizationId: number;
  channel: "shop" | "pos" | "tournament" | "league";
  buyerName: string;
  buyerEmail?: string;
  buyerGstin?: string;
  buyerAddress?: string;
  buyerState?: string;
  buyerStateCode?: string;
  buyerCountry?: string;
  lineItems: GstLineItem[];
  currency?: string;
  lut?: string;
  shopOrderId?: number;
  posTransactionId?: number;
  tournamentPlayerId?: number;
  leagueMemberId?: number;
}

export interface GstTaxResult {
  taxableValue: number;
  cgst: number;
  sgst: number;
  igst: number;
  routing: "cgst_sgst" | "igst" | "zero_rated";
}

// ─── Indian State Code Lookup ──────────────────────────────────────────────────

/** Maps both state names and their 2-digit GST codes for lookup.
 * Accepts state names, abbreviations, or 2-digit codes and normalises to 2-digit GST code. */
const STATE_CODE_MAP: Record<string, string> = {
  // 2-digit codes → themselves
  "01": "01", "02": "02", "03": "03", "04": "04", "05": "05", "06": "06", "07": "07", "08": "08",
  "09": "09", "10": "10", "11": "11", "12": "12", "13": "13", "14": "14", "15": "15", "16": "16",
  "17": "17", "18": "18", "19": "19", "20": "20", "21": "21", "22": "22", "23": "23", "24": "24",
  "25": "25", "26": "26", "27": "27", "28": "28", "29": "29", "30": "30", "31": "31", "32": "32",
  "33": "33", "34": "34", "35": "35", "36": "36", "37": "37", "38": "38",
  // State names → 2-digit code
  "jammu and kashmir": "01", "j&k": "01", "jk": "01",
  "himachal pradesh": "02", "hp": "02",
  "punjab": "03", "pb": "03",
  "chandigarh": "04",
  "uttarakhand": "05", "uk": "05",
  "haryana": "06", "hr": "06",
  "delhi": "07", "dl": "07", "new delhi": "07",
  "rajasthan": "08", "rj": "08",
  "uttar pradesh": "09", "up": "09",
  "bihar": "10", "br": "10",
  "sikkim": "11", "sk": "11",
  "arunachal pradesh": "12", "ar": "12",
  "nagaland": "13", "nl": "13",
  "manipur": "14", "mn": "14",
  "mizoram": "15", "mz": "15",
  "tripura": "16", "tr": "16",
  "meghalaya": "17", "ml": "17",
  "assam": "18", "as": "18",
  "west bengal": "19", "wb": "19",
  "jharkhand": "20", "jh": "20",
  "odisha": "21", "od": "21", "orissa": "21",
  "chhattisgarh": "22", "ct": "22", "chattisgarh": "22",
  "madhya pradesh": "23", "mp": "23",
  "gujarat": "24", "gj": "24",
  "dadra and nagar haveli and daman and diu": "26", "dnh": "26",
  "maharashtra": "27", "mh": "27",
  "andhra pradesh": "37", "ap": "37",  // post-2014 Andhra Pradesh (Seemandhra/Amaravati) = 37
  "karnataka": "29", "ka": "29",
  "goa": "30", "ga": "30",
  "lakshadweep": "31",
  "kerala": "32", "kl": "32",
  "tamil nadu": "33", "tn": "33",
  "puducherry": "34", "py": "34", "pondicherry": "34",
  "andaman and nicobar islands": "35", "an": "35",
  "telangana": "36", "ts": "36",
  "andhra pradesh (new)": "37",
  "ladakh": "38",
};

/**
 * Resolves a raw state input (state name, abbreviation, or 2-digit code)
 * to the standard 2-digit Indian GST state code, or returns empty string if unknown.
 */
export function resolveIndianStateCode(raw: string | null | undefined): string {
  if (!raw) return "";
  const normalised = raw.trim().toLowerCase().replace(/\s+/g, " ");
  return STATE_CODE_MAP[normalised] ?? "";
}

/**
 * Reverse lookup: 2-digit GST state code → canonical full state name (Title Case).
 * Only indexes full state names (length > 4, non-numeric), so abbreviations like
 * "mh" or "ka" never overwrite canonical names like "Maharashtra" / "Karnataka".
 */
const STATE_NAME_MAP: Record<string, string> = {};
for (const [name, code] of Object.entries(STATE_CODE_MAP)) {
  if (name.length > 4 && !/^\d+$/.test(name)) {
    STATE_NAME_MAP[code] = name.replace(/\b\w/g, c => c.toUpperCase());
  }
}

export function resolveIndianStateName(code: string | null | undefined): string {
  if (!code) return "";
  return STATE_NAME_MAP[code.trim()] ?? "";
}

// ─── GST Routing Logic ─────────────────────────────────────────────────────────

/**
 * Extracts the 2-digit state code from an Indian GSTIN.
 * GSTIN format: 2-digit state code + 13 alphanumeric chars (total 15).
 * Returns empty string for invalid/missing GSTIN.
 */
export function parseGstinStateCode(gstin: string | null | undefined): string {
  if (!gstin || gstin.length < 2) return "";
  const digits = gstin.slice(0, 2);
  const code = parseInt(digits, 10);
  if (isNaN(code) || code < 1 || code > 38) return "";
  return digits.padStart(2, "0");
}

/**
 * Determines CGST+SGST (intra-state) vs IGST (inter-state) vs zero-rated (export).
 * Uses 2-digit state codes per GST India standard.
 */
export function resolveGstTax(opts: {
  sellerStateCode?: string | null;
  buyerStateCode?: string | null;
  buyerCountry?: string | null;
  taxableValue: number;
  gstRate: number;
}): GstTaxResult {
  const { sellerStateCode, buyerStateCode, buyerCountry, taxableValue, gstRate } = opts;

  const country = (buyerCountry ?? "IN").trim().toUpperCase();
  const isExport = country !== "IN" && country !== "INDIA";

  if (isExport) {
    return { taxableValue, cgst: 0, sgst: 0, igst: 0, routing: "zero_rated" };
  }

  const sellerCode = (sellerStateCode ?? "").trim();
  const buyerCode = (buyerStateCode ?? "").trim();

  const isIntraState = sellerCode && buyerCode && sellerCode === buyerCode;

  const halfRate = gstRate / 2;
  const totalTax = +(taxableValue * gstRate / 100).toFixed(2);

  if (isIntraState) {
    const halfTax = +(taxableValue * halfRate / 100).toFixed(2);
    return {
      taxableValue,
      cgst: halfTax,
      sgst: +(totalTax - halfTax).toFixed(2),
      igst: 0,
      routing: "cgst_sgst",
    };
  }

  return { taxableValue, cgst: 0, sgst: 0, igst: totalTax, routing: "igst" };
}

// ─── Invoice Number Generator ─────────────────────────────────────────────────

const CHANNEL_DEFAULTS: Record<string, { prefix: string }> = {
  shop: { prefix: "SHOP" },
  pos: { prefix: "POS" },
  tournament: { prefix: "TRN" },
  league: { prefix: "LGE" },
};

/**
 * Thread-safe sequential invoice number.
 * Format: {PREFIX}-{YEAR}-{NNNN} e.g. SHOP-2026-0001
 */
export async function getNextInvoiceNumber(
  organizationId: number,
  channel: string,
  customPrefix?: string,
): Promise<string> {
  const year = new Date().getFullYear();
  const defaultPrefix = customPrefix ?? CHANNEL_DEFAULTS[channel]?.prefix ?? "INV";

  // Atomic upsert: INSERT … ON CONFLICT DO UPDATE eliminates the first-write race
  // condition where concurrent requests both see no row and both try to INSERT.
  const result = await db.execute<{ last_seq: number; prefix: string }>(sql`
    INSERT INTO invoice_sequences (organization_id, channel, prefix, last_seq, updated_at)
    VALUES (${organizationId}, ${channel}, ${defaultPrefix}, 1, NOW())
    ON CONFLICT (organization_id, channel) DO UPDATE
      SET last_seq   = invoice_sequences.last_seq + 1,
          updated_at = NOW()
    RETURNING last_seq, prefix
  `);

  const row = result.rows[0];
  if (!row) throw new Error(`[gstInvoice] Failed to obtain invoice sequence for org=${organizationId} channel=${channel}`);
  const seq = Number(row.last_seq);
  const prefix = row.prefix ?? defaultPrefix;
  return `${prefix}-${year}-${String(seq).padStart(4, "0")}`;
}

// ─── PDF Generation ────────────────────────────────────────────────────────────

interface PdfInvoiceData {
  invoiceNumber: string;
  invoiceDate: Date;
  channel: string;
  sellerName?: string;
  sellerGstin?: string;
  sellerAddress?: string;
  sellerState?: string;
  buyerName: string;
  buyerEmail?: string;
  buyerGstin?: string;
  buyerAddress?: string;
  buyerState?: string;
  buyerCountry?: string;
  lineItems: Array<{
    description: string;
    hsnSacCode?: string;
    quantity: number;
    unitPrice: number;
    taxableValue: number;
    gstRate: number;
    cgst?: number;
    sgst?: number;
    igst?: number;
    lineTotal: number;
  }>;
  taxableAmount: number;
  cgstAmount: number;
  sgstAmount: number;
  igstAmount: number;
  totalAmount: number;
  currency: string;
  gstRouting: "cgst_sgst" | "igst" | "zero_rated";
  lut?: string;
}

function formatCurrency(amount: number, currency: string): string {
  const sym = currency === "INR" ? "₹" : currency;
  return `${sym}${amount.toFixed(2)}`;
}

export async function generateGstInvoicePdf(data: PdfInvoiceData): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 45, compress: true });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const PRI = "#1e4d2b";
    const LIGHT = "#f0f9f4";
    const GRAY = "#6b7280";
    const W = 505;

    // ── Header block ──────────────────────────────────────────────────────────
    doc.rect(45, 40, W, 72).fill(PRI);
    doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(18).text("TAX INVOICE", 55, 55);
    doc.font("Helvetica").fontSize(9).fillColor("#a3d9b8").text("GST COMPLIANT — INDIA", 55, 78);

    const channelLabel: Record<string, string> = { shop: "ONLINE SHOP", pos: "PRO SHOP POS", tournament: "TOURNAMENT", league: "LEAGUE" };
    doc.text(channelLabel[data.channel] ?? data.channel.toUpperCase(), 55, 92);

    // Invoice details top-right
    doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(9)
      .text(`Invoice #: ${data.invoiceNumber}`, 320, 55, { width: 220, align: "right" });
    doc.font("Helvetica").fontSize(8).fillColor("#a3d9b8")
      .text(`Date: ${data.invoiceDate.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })}`, 320, 70, { width: 220, align: "right" })
      .text(`Currency: ${data.currency}`, 320, 84, { width: 220, align: "right" });

    doc.fillColor("#000000");
    let y = 125;

    // ── Seller & Buyer ────────────────────────────────────────────────────────
    const colW = 240;

    doc.rect(45, y, colW, 10).fill(PRI);
    doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(8).text("SELLER / SUPPLIER", 50, y + 1.5);

    doc.rect(300, y, colW + 5, 10).fill(PRI);
    doc.fillColor("#ffffff").text("BUYER / RECIPIENT", 305, y + 1.5);

    y += 14;
    const sellerLines = [
      data.sellerName ?? "—",
      ...(data.sellerGstin ? [`GSTIN: ${data.sellerGstin}`] : []),
      ...(data.sellerAddress ? [data.sellerAddress] : []),
      ...(data.sellerState ? [data.sellerState] : []),
    ];
    const buyerLines = [
      data.buyerName,
      ...(data.buyerGstin ? [`GSTIN: ${data.buyerGstin}`] : []),
      ...(data.buyerEmail ? [data.buyerEmail] : []),
      ...(data.buyerAddress ? [data.buyerAddress] : []),
      ...(data.buyerState ? [data.buyerState] : []),
      ...(data.buyerCountry && data.buyerCountry !== "IN" ? [data.buyerCountry] : []),
    ];

    doc.fillColor("#111827").font("Helvetica").fontSize(8);
    sellerLines.forEach((l, i) => {
      if (i === 0) doc.font("Helvetica-Bold");
      doc.text(l, 50, y + i * 12, { width: colW - 10 });
      if (i === 0) doc.font("Helvetica");
    });
    buyerLines.forEach((l, i) => {
      if (i === 0) doc.font("Helvetica-Bold");
      doc.text(l, 305, y + i * 12, { width: colW });
      if (i === 0) doc.font("Helvetica");
    });

    y += Math.max(sellerLines.length, buyerLines.length) * 12 + 10;

    // ── Line items table ──────────────────────────────────────────────────────
    const showHsn = data.lineItems.some(l => l.hsnSacCode);
    const isCgstSgst = data.gstRouting === "cgst_sgst";
    const isZeroRated = data.gstRouting === "zero_rated";

    // Column widths
    const descW = showHsn ? 160 : 185;
    const hsnW = 55;
    const qtyW = 35;
    const rateW = 60;
    const taxW = isCgstSgst ? 60 : 70;
    const totalW = 60;

    let cx = 45;
    const headerH = 20;
    doc.rect(cx, y, W, headerH).fill(PRI);
    doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(7.5);

    const headers = [
      { text: "DESCRIPTION", w: descW },
      ...(showHsn ? [{ text: "HSN/SAC", w: hsnW }] : []),
      { text: "QTY", w: qtyW },
      { text: "RATE (₹)", w: rateW },
      { text: "TAXABLE", w: taxW },
      ...(isCgstSgst
        ? [{ text: "CGST", w: taxW }, { text: "SGST", w: taxW }]
        : !isZeroRated ? [{ text: "IGST", w: taxW }] : []),
      { text: "TOTAL", w: totalW },
    ];

    let hx = cx + 5;
    headers.forEach(h => {
      doc.text(h.text, hx, y + 6, { width: h.w - 5, align: h.text === "DESCRIPTION" ? "left" : "right" });
      hx += h.w;
    });

    y += headerH;
    doc.fillColor("#000000").font("Helvetica").fontSize(8);

    data.lineItems.forEach((item, idx) => {
      const rowH = 22;
      if (idx % 2 === 0) doc.rect(cx, y, W, rowH).fill(LIGHT);
      doc.fillColor("#111827");

      let lx = cx + 5;
      const cols = [
        { text: item.description, w: descW, align: "left" },
        ...(showHsn ? [{ text: item.hsnSacCode ?? "—", w: hsnW, align: "center" as const }] : []),
        { text: String(item.quantity), w: qtyW, align: "right" as const },
        { text: item.unitPrice.toFixed(2), w: rateW, align: "right" as const },
        { text: item.taxableValue.toFixed(2), w: taxW, align: "right" as const },
        ...(isCgstSgst
          ? [
              { text: `${item.cgst?.toFixed(2) ?? "0.00"}\n(${item.gstRate / 2}%)`, w: taxW, align: "right" as const },
              { text: `${item.sgst?.toFixed(2) ?? "0.00"}\n(${item.gstRate / 2}%)`, w: taxW, align: "right" as const },
            ]
          : !isZeroRated
            ? [{ text: `${item.igst?.toFixed(2) ?? "0.00"}\n(${item.gstRate}%)`, w: taxW, align: "right" as const }]
            : []),
        { text: item.lineTotal.toFixed(2), w: totalW, align: "right" as const },
      ];

      cols.forEach(col => {
        doc.text(col.text, lx, y + 4, { width: col.w - 5, align: col.align as "left" | "right" | "center" });
        lx += col.w;
      });
      y += rowH;
    });

    // ── Totals ────────────────────────────────────────────────────────────────
    y += 5;
    doc.moveTo(cx, y).lineTo(cx + W, y).strokeColor("#d1d5db").lineWidth(0.5).stroke();
    y += 8;

    const totalsX = 350;
    const totalsLabelW = 110;
    const totalsValW = 90;

    const totalsRows: Array<[string, number, boolean?]> = [
      ["Taxable Amount:", data.taxableAmount],
      ...(isCgstSgst
        ? [["CGST:", data.cgstAmount] as [string, number], ["SGST:", data.sgstAmount] as [string, number]]
        : !isZeroRated
          ? [["IGST:", data.igstAmount] as [string, number]]
          : [["GST (Zero-rated):", 0] as [string, number]]),
      ["TOTAL:", data.totalAmount, true],
    ];

    totalsRows.forEach(([label, amount, bold]) => {
      if (bold) {
        doc.rect(totalsX - 5, y - 2, totalsLabelW + totalsValW + 15, 18).fill(PRI);
        doc.fillColor("#ffffff").font("Helvetica-Bold");
      } else {
        doc.fillColor("#374151").font("Helvetica");
      }
      doc.fontSize(9).text(label as string, totalsX, y, { width: totalsLabelW, align: "right" });
      doc.text(formatCurrency(amount as number, data.currency), totalsX + totalsLabelW + 5, y, { width: totalsValW, align: "right" });
      doc.fillColor("#000000");
      y += 18;
    });

    // ── Notes / LUT ───────────────────────────────────────────────────────────
    y += 10;
    if (isZeroRated) {
      doc.font("Helvetica").fontSize(8).fillColor(GRAY)
        .text(`Zero-rated supply — Export under LUT/Bond${data.lut ? ` (Ref: ${data.lut})` : ""}`, 45, y);
      y += 14;
    }
    doc.fillColor(GRAY).fontSize(7.5)
      .text("This is a computer-generated invoice and does not require a physical signature.", 45, y);

    // ── Footer ────────────────────────────────────────────────────────────────
    doc.rect(45, 790, W, 2).fill(PRI);
    doc.fillColor(GRAY).fontSize(7).text("KHARAGOLF — GST Invoice System", 45, 795, { align: "center", width: W });

    doc.end();
  });
}

// ─── Object Storage ────────────────────────────────────────────────────────────

const BUCKET_NAME = process.env.OBJECT_STORAGE_BUCKET ?? "kharagolf-uploads";

export async function storeGstInvoicePdf(
  buffer: Buffer,
  organizationId: number,
  invoiceNumber: string,
): Promise<string> {
  const safe = invoiceNumber.replace(/[^a-zA-Z0-9\-_]/g, "_");
  const objectPath = `gst-invoices/${organizationId}/${safe}.pdf`;
  const bucket = objectStorageClient.bucket(BUCKET_NAME);
  const file = bucket.file(objectPath);
  await withRetry(
    () => file.save(buffer, { contentType: "application/pdf", resumable: false }),
    { maxAttempts: 3, delayMs: 600, label: "pdf-storage-upload" },
  );
  return `gs://${BUCKET_NAME}/${objectPath}`;
}

export async function getGstInvoicePdfBuffer(pdfPath: string): Promise<Buffer> {
  const withoutScheme = pdfPath.replace(/^gs:\/\//, "");
  const slashIdx = withoutScheme.indexOf("/");
  const bucketName = withoutScheme.slice(0, slashIdx);
  const objectName = withoutScheme.slice(slashIdx + 1);
  const [buffer] = await objectStorageClient.bucket(bucketName).file(objectName).download();
  return buffer;
}

// ─── Email Delivery ────────────────────────────────────────────────────────────

export async function sendGstInvoiceEmail(opts: {
  to: string;
  buyerName: string;
  invoiceNumber: string;
  invoiceDate: Date;
  totalAmount: number;
  currency: string;
  channel: string;
  orgName?: string;
  pdfBuffer?: Buffer;
}): Promise<void> {
  const { to, buyerName, invoiceNumber, invoiceDate, totalAmount, currency, channel, orgName, pdfBuffer } = opts;

  const gmailUser = process.env.GMAIL_USER;
  const gmailPass = process.env.GMAIL_APP_PASSWORD;
  if (!gmailUser || !gmailPass) {
    logger.warn("[gstInvoice] Gmail credentials not configured — skipping invoice email");
    return;
  }

  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: gmailUser, pass: gmailPass },
  });

  const channelLabel: Record<string, string> = { shop: "Online Shop", pos: "Pro Shop", tournament: "Tournament Entry", league: "League Entry" };
  const sym = currency === "INR" ? "₹" : currency;

  const mailOptions: Parameters<typeof transporter.sendMail>[0] = {
    from: `"${orgName ?? "KHARAGOLF"}" <${gmailUser}>`,
    to,
    subject: `Tax Invoice ${invoiceNumber} — ${channelLabel[channel] ?? channel}`,
    html: `
      <div style="font-family:sans-serif;max-width:600px;margin:auto">
        <div style="background:#1e4d2b;padding:28px 32px">
          <h1 style="margin:0;color:#fff;font-size:20px;letter-spacing:3px">${orgName ?? "KHARAGOLF"}</h1>
          <p style="margin:4px 0 0;color:#a3d9b8;font-size:11px;letter-spacing:2px;text-transform:uppercase">TAX INVOICE</p>
        </div>
        <div style="padding:28px 32px;background:#fff">
          <p style="color:#374151">Dear <strong>${buyerName}</strong>,</p>
          <p style="color:#374151">Please find your GST-compliant tax invoice attached for your recent ${channelLabel[channel] ?? channel.toLowerCase()} transaction.</p>
          <table style="width:100%;border-collapse:collapse;margin:16px 0">
            <tr style="background:#f0f9f4">
              <td style="padding:10px 14px;color:#6b7280;font-size:13px">Invoice Number</td>
              <td style="padding:10px 14px;font-weight:bold;font-size:13px">${invoiceNumber}</td>
            </tr>
            <tr>
              <td style="padding:10px 14px;color:#6b7280;font-size:13px">Invoice Date</td>
              <td style="padding:10px 14px;font-size:13px">${invoiceDate.toLocaleDateString("en-IN", { day: "2-digit", month: "long", year: "numeric" })}</td>
            </tr>
            <tr style="background:#f0f9f4">
              <td style="padding:10px 14px;color:#6b7280;font-size:13px">Amount</td>
              <td style="padding:10px 14px;font-weight:bold;font-size:15px;color:#1e4d2b">${sym}${totalAmount.toFixed(2)}</td>
            </tr>
          </table>
          <p style="color:#6b7280;font-size:12px">This invoice has been generated automatically. Please retain it for your GST records.</p>
        </div>
        <div style="background:#f9fafb;padding:16px 32px;text-align:center">
          <p style="color:#9ca3af;font-size:11px;margin:0">KHARAGOLF — Club Management Platform</p>
        </div>
      </div>
    `,
    attachments: pdfBuffer
      ? [{ filename: `${invoiceNumber}.pdf`, content: pdfBuffer, contentType: "application/pdf" }]
      : [],
  };

  await withRetry(
    () => transporter.sendMail(mailOptions),
    { maxAttempts: 2, delayMs: 1000, label: "invoice-email-send" },
  );
}

// ─── Main Entry Point ─────────────────────────────────────────────────────────

export interface CreateGstInvoiceOpts extends GstInvoiceRequest {
  sellerGstin?: string;
  sellerName?: string;
  sellerAddress?: string;
  sellerState?: string;
  sellerStateCode?: string;
  orgName?: string;
}

/**
 * Creates a complete GST invoice: generates number, resolves tax routing,
 * builds PDF, stores in object storage, saves to DB, and emails to buyer.
 * Always returns the created invoice record (best-effort — errors are logged not thrown).
 */
export async function createGstInvoice(opts: CreateGstInvoiceOpts): Promise<typeof gstInvoicesTable.$inferSelect | null> {
  try {
    const {
      organizationId, channel, buyerName, buyerEmail, buyerGstin,
      buyerAddress, buyerState, buyerStateCode, buyerCountry = "IN",
      lineItems, currency = "INR", lut,
      shopOrderId, posTransactionId, tournamentPlayerId, leagueMemberId,
      sellerGstin, sellerName, sellerAddress, sellerState, sellerStateCode,
      orgName,
    } = opts;

    // ── Idempotency guard: skip if invoice already exists for this source ──────
    {
      const sourceCol = shopOrderId ? gstInvoicesTable.shopOrderId
        : posTransactionId ? gstInvoicesTable.posTransactionId
        : tournamentPlayerId ? gstInvoicesTable.tournamentPlayerId
        : leagueMemberId ? gstInvoicesTable.leagueMemberId
        : null;
      const sourceId = shopOrderId ?? posTransactionId ?? tournamentPlayerId ?? leagueMemberId ?? null;
      if (sourceCol && sourceId != null) {
        const [existing] = await db.select()
          .from(gstInvoicesTable)
          .where(and(
            eq(gstInvoicesTable.organizationId, organizationId),
            eq(sourceCol as Parameters<typeof eq>[0], sourceId),
          ))
          .limit(1);
        if (existing) {
          logger.info({ invoiceId: existing.id, channel, sourceId }, "[gstInvoice] invoice already exists for this source — skipping");
          return existing;
        }
      }
    }

    const invoiceNumber = await getNextInvoiceNumber(organizationId, channel);
    const invoiceDate = new Date();

    // Canonical buyer state code precedence:
    // 1. Explicit buyerStateCode passed by caller
    // 2. Parsed from buyerGstin first 2 digits (e.g. "27" = Maharashtra)
    // 3. Resolved from buyerState name via lookup table
    // 4. Empty string → resolveGstTax treats as unknown → defaults to IGST (safe for compliance)
    const effectiveBuyerStateCode: string =
      (buyerStateCode?.trim()) ||
      (buyerGstin ? parseGstinStateCode(buyerGstin) : "") ||
      resolveIndianStateCode(buyerState) ||
      "";

    let totalTaxableAmount = 0;
    let totalCgst = 0;
    let totalSgst = 0;
    let totalIgst = 0;
    let overallRouting: "cgst_sgst" | "igst" | "zero_rated" = "igst";

    const resolvedLineItems = lineItems.map(li => {
      const taxableValue = +(li.unitPrice * li.quantity).toFixed(2);
      const taxResult = resolveGstTax({
        sellerStateCode,
        buyerStateCode: effectiveBuyerStateCode,
        buyerCountry,
        taxableValue,
        gstRate: li.gstRate,
      });

      totalTaxableAmount += taxableValue;
      totalCgst += taxResult.cgst;
      totalSgst += taxResult.sgst;
      totalIgst += taxResult.igst;
      overallRouting = taxResult.routing;

      const lineTotal = +(taxableValue + taxResult.cgst + taxResult.sgst + taxResult.igst).toFixed(2);

      return {
        description: li.description,
        hsnSacCode: li.hsnSacCode,
        quantity: li.quantity,
        unitPrice: li.unitPrice,
        taxableValue,
        gstRate: li.gstRate,
        cgst: taxResult.cgst,
        sgst: taxResult.sgst,
        igst: taxResult.igst,
        lineTotal,
      };
    });

    const totalAmount = +(totalTaxableAmount + totalCgst + totalSgst + totalIgst).toFixed(2);

    const pdfData: PdfInvoiceData = {
      invoiceNumber, invoiceDate, channel,
      sellerName, sellerGstin, sellerAddress, sellerState,
      buyerName, buyerEmail, buyerGstin, buyerAddress, buyerState,
      buyerCountry,
      lineItems: resolvedLineItems,
      taxableAmount: +totalTaxableAmount.toFixed(2),
      cgstAmount: +totalCgst.toFixed(2),
      sgstAmount: +totalSgst.toFixed(2),
      igstAmount: +totalIgst.toFixed(2),
      totalAmount,
      currency,
      gstRouting: overallRouting,
      lut,
    };

    let pdfPath: string | undefined;
    let pdfBuffer: Buffer | undefined;
    try {
      pdfBuffer = await generateGstInvoicePdf(pdfData);
      pdfPath = await storeGstInvoicePdf(pdfBuffer, organizationId, invoiceNumber);
    } catch (pdfErr) {
      logger.warn({ pdfErr, invoiceNumber }, "[gstInvoice] PDF generation/storage failed");
    }

    // Attempt insert; handle 23505 unique constraint violation from concurrent requests atomically
    let savedInvoice: typeof gstInvoicesTable.$inferSelect;
    try {
      const [inserted] = await db.insert(gstInvoicesTable).values({
        organizationId,
        invoiceNumber,
        channel,
        shopOrderId: shopOrderId ?? null,
        posTransactionId: posTransactionId ?? null,
        tournamentPlayerId: tournamentPlayerId ?? null,
        leagueMemberId: leagueMemberId ?? null,
        buyerName,
        buyerEmail: buyerEmail ?? null,
        buyerGstin: buyerGstin ?? null,
        buyerAddress: buyerAddress ?? null,
        buyerState: buyerState ?? null,
        buyerStateCode: effectiveBuyerStateCode || null,
        buyerCountry,
        sellerGstin: sellerGstin ?? null,
        sellerName: sellerName ?? null,
        sellerAddress: sellerAddress ?? null,
        sellerState: sellerState ?? null,
        sellerStateCode: sellerStateCode ?? null,
        lineItems: resolvedLineItems,
        taxableAmount: totalTaxableAmount.toFixed(2),
        cgstAmount: totalCgst.toFixed(2),
        sgstAmount: totalSgst.toFixed(2),
        igstAmount: totalIgst.toFixed(2),
        totalAmount: totalAmount.toFixed(2),
        currency,
        gstRouting: overallRouting,
        // stateOfSupply: explicit buyer state name → GSTIN-derived state name → seller state → null
        stateOfSupply: buyerState || resolveIndianStateName(effectiveBuyerStateCode) || sellerState || null,
        lut: lut ?? null,
        pdfPath: pdfPath ?? null,
        invoiceDate,
      }).returning();
      savedInvoice = inserted;
    } catch (insertErr: unknown) {
      // 23505 = PostgreSQL unique_violation — concurrent request already inserted this source's invoice
      if (insertErr && typeof insertErr === "object" && (insertErr as { code?: string }).code === "23505") {
        logger.warn({ invoiceNumber, channel }, "[gstInvoice] concurrent insert detected — fetching existing invoice");
        const sourceCol = shopOrderId ? gstInvoicesTable.shopOrderId
          : posTransactionId ? gstInvoicesTable.posTransactionId
          : tournamentPlayerId ? gstInvoicesTable.tournamentPlayerId
          : leagueMemberId ? gstInvoicesTable.leagueMemberId
          : null;
        const sourceId = shopOrderId ?? posTransactionId ?? tournamentPlayerId ?? leagueMemberId ?? null;
        if (sourceCol && sourceId != null) {
          const [conflicting] = await db.select()
            .from(gstInvoicesTable)
            .where(and(
              eq(gstInvoicesTable.organizationId, organizationId),
              eq(sourceCol as Parameters<typeof eq>[0], sourceId),
            ))
            .limit(1);
          if (conflicting) return conflicting;
        }
      }
      throw insertErr;
    }

    if (buyerEmail && pdfBuffer) {
      try {
        await sendGstInvoiceEmail({
          to: buyerEmail, buyerName, invoiceNumber, invoiceDate,
          totalAmount, currency, channel, orgName, pdfBuffer,
        });
        await db.update(gstInvoicesTable)
          .set({ emailedAt: new Date() })
          .where(eq(gstInvoicesTable.id, savedInvoice.id));
      } catch (emailErr) {
        logger.warn({ emailErr, invoiceNumber }, "[gstInvoice] Invoice email failed");
      }
    }

    return savedInvoice;
  } catch (err) {
    logger.error({ err }, "[gstInvoice] createGstInvoice failed");
    return null;
  }
}

/**
 * Fetches org GST settings from shop_store_settings for use in invoice creation.
 */
export async function getOrgGstSettings(organizationId: number) {
  const [settings] = await db.select({
    gstin: shopStoreSettingsTable.gstin,
    sellerName: shopStoreSettingsTable.sellerName,
    sellerAddress: shopStoreSettingsTable.sellerAddress,
    sellerState: shopStoreSettingsTable.sellerState,
    sellerStateCode: shopStoreSettingsTable.sellerStateCode,
    defaultSacCode: shopStoreSettingsTable.defaultSacCode,
  }).from(shopStoreSettingsTable)
    .where(eq(shopStoreSettingsTable.organizationId, organizationId));
  return settings ?? null;
}
