/**
 * Regression tests for the mobile <InvoicesSection /> (Task #1115 / Task #1285).
 *
 * The dues-invoices block was extracted from `app/(tabs)/profile.tsx` so
 * the empty placeholder, list rows and "Pay Now" interaction can be
 * exercised in isolation. We mock <PriceWithFx /> to a plain text node
 * — its FX behaviour already has dedicated coverage in the locker tests.
 */
import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/components/PriceWithFx", async () => {
  const React = await import("react");
  const RN = await import("react-native");
  const PriceWithFx = (props: { amount: string; currency: string }) =>
    React.createElement(
      RN.Text,
      { testID: "mock-price-with-fx" },
      `${props.currency} ${props.amount}`,
    );
  return { PriceWithFx, default: PriceWithFx };
});

vi.mock("@/i18n", () => ({
  getLocale: () => "en-US",
}));

import {
  InvoicesSection,
  type MyInvoice,
} from "../components/InvoicesSection";

afterEach(() => {
  cleanup();
});

const PAYABLE: MyInvoice = {
  id: 1,
  invoiceNumber: "INV-001",
  status: "sent",
  totalAmount: "1500.00",
  paidAmount: "0.00",
  currency: "USD",
  dueDate: new Date("2026-05-15T00:00:00Z").toISOString(),
  paidAt: null,
  razorpayPaymentLinkUrl: "https://rzp.io/l/abc",
  notes: null,
  createdAt: new Date("2026-04-15T00:00:00Z").toISOString(),
};

const PAID: MyInvoice = {
  id: 2,
  invoiceNumber: "INV-002",
  status: "paid",
  totalAmount: "750.00",
  paidAmount: "750.00",
  currency: "USD",
  dueDate: null,
  paidAt: new Date("2026-04-01T00:00:00Z").toISOString(),
  razorpayPaymentLinkUrl: null,
  notes: null,
  createdAt: new Date("2026-03-15T00:00:00Z").toISOString(),
};

describe("<InvoicesSection />", () => {
  it("renders the empty placeholder when there are no invoices", () => {
    render(
      <InvoicesSection invoices={[]} orgId={42} token="t" />,
    );

    expect(screen.getByTestId("invoices-section")).toBeInTheDocument();
    expect(screen.getByTestId("invoices-empty")).toBeInTheDocument();
    expect(screen.queryByTestId("invoice-row-1")).not.toBeInTheDocument();
  });

  it("renders rows with status badges and only shows Pay Now for unpaid invoices with a payment link", () => {
    render(
      <InvoicesSection
        invoices={[PAYABLE, PAID]}
        orgId={42}
        token="t"
      />,
    );

    expect(screen.queryByTestId("invoices-empty")).not.toBeInTheDocument();

    const payable = screen.getByTestId("invoice-row-1");
    expect(payable).toHaveTextContent("INV-001");
    expect(payable).toHaveTextContent(/USD\s+1500\.00/);
    // Pay Now button only on the unpaid row that has a Razorpay link.
    expect(screen.getByTestId("invoice-pay-1")).toBeInTheDocument();

    const paid = screen.getByTestId("invoice-row-2");
    expect(paid).toHaveTextContent("INV-002");
    // Paid row must not show a pay action even if a stale link existed.
    expect(screen.queryByTestId("invoice-pay-2")).not.toBeInTheDocument();
  });

  it("invokes onPayInvoice with the matching invoice when Pay Now is pressed", () => {
    const onPayInvoice = vi.fn();
    render(
      <InvoicesSection
        invoices={[PAYABLE]}
        orgId={42}
        token="t"
        onPayInvoice={onPayInvoice}
      />,
    );

    fireEvent.click(screen.getByTestId("invoice-pay-1"));

    expect(onPayInvoice).toHaveBeenCalledTimes(1);
    expect(onPayInvoice.mock.calls[0][0]).toMatchObject({
      id: 1,
      invoiceNumber: "INV-001",
      razorpayPaymentLinkUrl: "https://rzp.io/l/abc",
    });
  });
});
