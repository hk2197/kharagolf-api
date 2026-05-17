/**
 * Unit tests: `sendShopOrderReceiptEmail` and `sendDuesReceiptEmail` skip the
 * mailer when PDF generation throws (Task #1135). The product requirement is
 * that every receipt email carries a PDF attachment, so when
 * `generateItemisedReceiptPDF` fails we must not fall back to a plain-text
 * email.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../pdfReceipt", () => ({
  generateItemisedReceiptPDF: vi.fn(),
  storeReceiptPDF: vi.fn(),
  generateReceiptPDF: vi.fn(),
}));

vi.mock("../mailer", () => ({
  sendShopOrderReceiptMail: vi.fn(),
  sendDuesReceiptMail: vi.fn(),
  sendPaymentReceiptEmail: vi.fn(),
}));

vi.mock("../logger", () => ({
  logger: {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

import { sendShopOrderReceiptEmail, sendDuesReceiptEmail } from "../paymentReceipts.js";
import { generateItemisedReceiptPDF, storeReceiptPDF } from "../pdfReceipt.js";
import { sendShopOrderReceiptMail, sendDuesReceiptMail } from "../mailer.js";

const mockedGenerate = vi.mocked(generateItemisedReceiptPDF);
const mockedStore = vi.mocked(storeReceiptPDF);
const mockedShopMail = vi.mocked(sendShopOrderReceiptMail);
const mockedDuesMail = vi.mocked(sendDuesReceiptMail);

beforeEach(() => {
  vi.clearAllMocks();
  mockedStore.mockResolvedValue("stored://receipt.pdf");
});

describe("sendShopOrderReceiptEmail", () => {
  it("does not call the mailer when generateItemisedReceiptPDF throws", async () => {
    mockedGenerate.mockRejectedValueOnce(new Error("pdfkit blew up"));

    await sendShopOrderReceiptEmail({
      email: "buyer@example.com",
      buyerName: "Asha Patel",
      orderId: 4242,
      lineItems: [{ description: "KHARAGOLF Polo (M)", quantity: 1, totalAmountSubunit: 250000 }],
      totalSubunit: 250000,
      currency: "INR",
      paymentId: "pi_test_abc",
    });

    expect(mockedGenerate).toHaveBeenCalledTimes(1);
    expect(mockedShopMail).not.toHaveBeenCalled();
  });

  it("sends the email with the PDF buffer when generation succeeds", async () => {
    const fakePdf = Buffer.from("%PDF-1.4 fake");
    mockedGenerate.mockResolvedValueOnce(fakePdf);

    await sendShopOrderReceiptEmail({
      email: "buyer@example.com",
      buyerName: "Asha Patel",
      orderId: 4242,
      lineItems: [{ description: "KHARAGOLF Polo (M)", quantity: 1, totalAmountSubunit: 250000 }],
      totalSubunit: 250000,
      currency: "INR",
      paymentId: "pi_test_abc",
    });

    expect(mockedShopMail).toHaveBeenCalledTimes(1);
    expect(mockedShopMail.mock.calls[0]![0]).toMatchObject({
      to: "buyer@example.com",
      pdfBuffer: fakePdf,
      pdfFilename: "receipt_order_4242.pdf",
    });
  });
});

describe("sendDuesReceiptEmail", () => {
  it("does not call the mailer when generateItemisedReceiptPDF throws", async () => {
    mockedGenerate.mockRejectedValueOnce(new Error("pdfkit blew up"));

    await sendDuesReceiptEmail({
      email: "member@example.com",
      memberName: "Ravi Kumar",
      invoiceId: 99,
      invoiceNumber: "INV-2026-001",
      lineItems: [{ description: "Annual dues", quantity: 1, totalAmountSubunit: 1500000 }],
      totalSubunit: 1500000,
      currency: "INR",
      paymentId: "pi_test_def",
    });

    expect(mockedGenerate).toHaveBeenCalledTimes(1);
    expect(mockedDuesMail).not.toHaveBeenCalled();
  });

  it("sends the email with the PDF buffer when generation succeeds", async () => {
    const fakePdf = Buffer.from("%PDF-1.4 fake");
    mockedGenerate.mockResolvedValueOnce(fakePdf);

    await sendDuesReceiptEmail({
      email: "member@example.com",
      memberName: "Ravi Kumar",
      invoiceId: 99,
      invoiceNumber: "INV-2026-001",
      lineItems: [{ description: "Annual dues", quantity: 1, totalAmountSubunit: 1500000 }],
      totalSubunit: 1500000,
      currency: "INR",
      paymentId: "pi_test_def",
    });

    expect(mockedDuesMail).toHaveBeenCalledTimes(1);
    expect(mockedDuesMail.mock.calls[0]![0]).toMatchObject({
      to: "member@example.com",
      pdfBuffer: fakePdf,
      pdfFilename: "receipt_invoice_INV-2026-001.pdf",
    });
  });
});
