/**
 * Unit tests: `generateItemisedReceiptPDF` (Task #976 / Task #831 receipt flow).
 *
 * These exercise the PDF generator in isolation — no DB, no object storage —
 * confirming that the produced bytes are a valid PDF document and that all
 * shop / dues receipt fields survive into the rendered text layer.
 */
import { describe, it, expect } from "vitest";
import { inflateSync } from "zlib";
// Importing the inner module avoids pdf-parse's package index entry which runs
// a debug self-test (reading a fixture file) when not invoked via require().
// @ts-expect-error pdf-parse ships no type declarations for the inner module.
import pdfParse from "pdf-parse/lib/pdf-parse.js";

/**
 * pdf-parse retains module-level state that corrupts after several
 * back-to-back calls in the same process, so for byte-level assertions we
 * decode PDFKit's FlateDecode content streams directly and search the
 * resulting text-drawing operators (Tj / TJ) for the rendered string.
 */
function pdfContainsString(buf: Buffer, needle: string): boolean {
  // PDFKit emits text via Helvetica with WinAnsi encoding using the hex
  // string operator (e.g. `<55534420312E3939> Tj` for "USD 1.99"), so we
  // also search the upper-case hex form of the needle. We tolerate the
  // `[<...> nn <...>] TJ` adjustment splits PDFKit injects between
  // kerning pairs by stripping `>` `n... <` interleaves first.
  const needleHex = Buffer.from(needle, "latin1").toString("hex").toUpperCase();
  const haystack = buf.toString("binary");
  let cursor = 0;
  while (cursor < haystack.length) {
    const streamIdx = haystack.indexOf("stream\n", cursor);
    if (streamIdx === -1) break;
    const endIdx = haystack.indexOf("\nendstream", streamIdx);
    if (endIdx === -1) break;
    const raw = Buffer.from(haystack.slice(streamIdx + "stream\n".length, endIdx), "binary");
    cursor = endIdx + "\nendstream".length;
    try {
      const inflated = inflateSync(raw).toString("latin1");
      if (inflated.includes(needle)) return true;
      // Strip kerning interleaves: `... 4f> 20 <726465 ...` → `... 4f726465 ...`
      const collapsed = inflated.replace(/>\s*-?\d+\s*</g, "");
      if (collapsed.toUpperCase().includes(needleHex)) return true;
    } catch {
      // Not a flate-compressed stream (e.g. raw font data) — skip it.
    }
  }
  return false;
}
import {
  generateItemisedReceiptPDF,
  type ItemisedReceiptInfo,
} from "../pdfReceipt.js";

function baseInfo(overrides: Partial<ItemisedReceiptInfo> = {}): ItemisedReceiptInfo {
  return {
    title: "Order Receipt",
    documentRef: "Order #4242",
    buyerName: "Asha Patel",
    email: "asha@example.com",
    lineItems: [
      { description: "KHARAGOLF Polo (M)", quantity: 2, totalAmountSubunit: 250000 },
      { description: "Pro Shop Cap", quantity: 1, totalAmountSubunit: 125000 },
    ],
    totalSubunit: 375000,
    currency: "INR",
    currencySymbol: "Rs.", // ascii to keep grep predictable in tests
    paymentId: "pi_test_abc123",
    paidAt: new Date("2026-04-22T10:30:00Z"),
    productLine: "Pro Shop",
    footerNote: "Keep this receipt for warranty and returns.",
    orgName: "Test Golf Club",
    ...overrides,
  };
}

describe("generateItemisedReceiptPDF", () => {
  it("returns a non-empty Buffer with a PDF magic header and EOF marker", async () => {
    const buf = await generateItemisedReceiptPDF(baseInfo());

    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(500);

    // PDF spec: file starts with `%PDF-` and the trailer ends with `%%EOF`.
    expect(buf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    const tail = buf.subarray(Math.max(0, buf.length - 32)).toString("latin1");
    expect(tail).toContain("%%EOF");
  });

  it("renders the title, document ref, buyer name, line items, total and payment id", async () => {
    const info = baseInfo();
    const buf = await generateItemisedReceiptPDF(info);
    const parsed = await pdfParse(buf);
    const text = parsed.text;

    // Header / title
    expect(text).toContain(info.title);
    // Org name appears uppercased in the header bar
    expect(text).toContain((info.orgName ?? "").toUpperCase());

    // Meta rows
    expect(text).toContain(info.documentRef);
    expect(text).toContain(info.buyerName);

    // Line item descriptions and quantities
    for (const li of info.lineItems) {
      expect(text).toContain(li.description);
    }

    // Total appears as `Rs.3750.00` (subunit/100, two decimals)
    expect(text).toContain("Rs.3750.00");

    // Currency code + payment id surfaced in metadata box
    expect(text).toContain("INR");
    expect(text).toContain(info.paymentId);

    // Footer note carries through verbatim
    expect(text).toContain(info.footerNote!);
  });

  it("falls back to KHARAGOLF when no orgName is supplied and respects custom productLine", async () => {
    const info = baseInfo({ orgName: null, productLine: "Membership Dues", title: "Dues Receipt", documentRef: "Invoice INV-2026-001" });
    const buf = await generateItemisedReceiptPDF(info);
    const parsed = await pdfParse(buf);
    const text = parsed.text;

    expect(text).toContain("KHARAGOLF");
    expect(text).toContain("MEMBERSHIP DUES");
    expect(text).toContain("Dues Receipt");
    expect(text).toContain("Invoice INV-2026-001");
  });

  it("formats sub-unit totals with two decimal places using the supplied currency symbol", async () => {
    const buf = await generateItemisedReceiptPDF(baseInfo({
      currency: "USD",
      currencySymbol: "USD ",
      lineItems: [{ description: "Single-item charge", quantity: 1, totalAmountSubunit: 199 }],
      totalSubunit: 199,
    }));
    expect(buf.length).toBeGreaterThan(500);
    expect(buf.subarray(0, 5).toString("latin1")).toBe("%PDF-");

    // 199 sub-units → "USD 1.99" (currencySymbol prefix + total/100, two
    // decimals). We deflate the content stream directly because pdf-parse's
    // module-level state corrupts after several back-to-back parses.
    expect(pdfContainsString(buf, "USD 1.99")).toBe(true);
    // Currency code surfaced verbatim in the metadata box.
    expect(pdfContainsString(buf, "USD")).toBe(true);
  });
});
