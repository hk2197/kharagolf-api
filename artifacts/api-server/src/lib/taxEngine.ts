/**
 * Task #373 — Multi-jurisdiction tax engine.
 *
 * Computes tax for a transaction given a tax profile (GST, VAT, sales tax)
 * and the buyer/product context. For Indian GST profiles this delegates to
 * the existing `resolveGstTax` so the GST invoice path remains canonical
 * (CGST/SGST split, IGST inter-state, zero-rated exports). For other
 * jurisdictions it iterates the profile's component rates and applies them
 * with optional product-class / customer-class filters and exemption rules.
 */

import { db } from "@workspace/db";
import { taxProfilesTable, taxRatesTable } from "@workspace/db";
import { and, asc, eq } from "drizzle-orm";
import { resolveGstTax } from "./gstInvoice";

export interface TaxComputationInput {
  organizationId: number;
  taxProfileId?: number | null;
  taxableAmount: number;
  currency: string;
  productClass?: string | null;
  customerClass?: string | null;
  // Buyer geography — used by GST routing and by export-zero-rated rules.
  sellerStateCode?: string | null;
  buyerStateCode?: string | null;
  buyerCountry?: string | null;
  // When true, the buyer claims a tax-exempt status (e.g. registered NGO).
  buyerExempt?: boolean;
}

export interface TaxComponentResult {
  componentName: string;
  ratePct: number;
  amount: number;
}

export interface TaxComputationResult {
  taxableAmount: number;
  totalTax: number;
  totalAmount: number;
  currency: string;
  jurisdictionKind: "gst" | "vat" | "sales_tax" | "none";
  components: TaxComponentResult[];
  routing: "cgst_sgst" | "igst" | "zero_rated" | "vat" | "sales_tax" | "exempt" | "none";
  exemptionReason?: string;
  // Free-text for invoice display (e.g. "GST 18% (CGST 9% + SGST 9%)").
  invoiceLabel?: string;
}

interface ExemptionRules {
  exemptCustomerClasses?: string[];
  exemptProductClasses?: string[];
  thresholdAmount?: number;
  thresholdCurrency?: string;
  b2bReverseCharge?: boolean;
  exportZeroRated?: boolean;
}

function checkExemption(
  rules: ExemptionRules,
  input: TaxComputationInput,
): string | null {
  if (input.buyerExempt) return "Buyer flagged tax-exempt";
  if (rules.exemptCustomerClasses?.length && input.customerClass &&
      rules.exemptCustomerClasses.includes(input.customerClass)) {
    return `Customer class "${input.customerClass}" is exempt`;
  }
  if (rules.exemptProductClasses?.length && input.productClass &&
      rules.exemptProductClasses.includes(input.productClass)) {
    return `Product class "${input.productClass}" is exempt`;
  }
  if (typeof rules.thresholdAmount === "number" && input.taxableAmount < rules.thresholdAmount &&
      (!rules.thresholdCurrency || rules.thresholdCurrency.toUpperCase() === input.currency.toUpperCase())) {
    return `Below tax threshold of ${rules.thresholdAmount} ${rules.thresholdCurrency ?? input.currency}`;
  }
  const country = (input.buyerCountry ?? "").trim().toUpperCase();
  // Export zero-rating only applies if profile country differs from buyer country.
  if (rules.exportZeroRated && country && country !== "IN" && country !== "INDIA") {
    return "Export zero-rated";
  }
  return null;
}

function applyComponent(taxable: number, ratePct: number): number {
  return +(taxable * ratePct / 100).toFixed(2);
}

/**
 * Resolve taxes for a transaction. Returns a structured breakdown with one
 * `components` entry per applied rate. Callers should persist `totalTax`
 * against the ledger and `components` against the invoice.
 */
export async function resolveTaxes(input: TaxComputationInput): Promise<TaxComputationResult> {
  const taxable = +input.taxableAmount.toFixed(2);
  const currency = input.currency.toUpperCase();

  if (!input.taxProfileId) {
    return {
      taxableAmount: taxable, totalTax: 0, totalAmount: taxable, currency,
      jurisdictionKind: "none", components: [], routing: "none",
    };
  }

  const [profile] = await db.select().from(taxProfilesTable)
    .where(and(
      eq(taxProfilesTable.id, input.taxProfileId),
      eq(taxProfilesTable.organizationId, input.organizationId),
    ));
  if (!profile || !profile.isActive) {
    return {
      taxableAmount: taxable, totalTax: 0, totalAmount: taxable, currency,
      jurisdictionKind: "none", components: [], routing: "none",
      exemptionReason: "Tax profile inactive or not found",
    };
  }

  const exemptionReason = checkExemption(profile.exemptionRules as ExemptionRules, input);
  if (exemptionReason) {
    return {
      taxableAmount: taxable, totalTax: 0, totalAmount: taxable, currency,
      jurisdictionKind: profile.jurisdictionKind, components: [], routing: "exempt",
      exemptionReason, invoiceLabel: profile.invoiceLabel ?? undefined,
    };
  }

  const rates = await db.select().from(taxRatesTable)
    .where(eq(taxRatesTable.taxProfileId, profile.id))
    .orderBy(asc(taxRatesTable.sortOrder), asc(taxRatesTable.id));

  // Filter by product/customer class and amount thresholds.
  const applicableRates = rates.filter((r) => {
    if (r.productClass && input.productClass && r.productClass !== input.productClass) return false;
    if (r.customerClass && input.customerClass && r.customerClass !== input.customerClass) return false;
    if (r.minTaxableAmount && taxable < Number(r.minTaxableAmount)) return false;
    if (r.maxTaxableAmount && taxable > Number(r.maxTaxableAmount)) return false;
    return true;
  });

  // ── GST: defer to the canonical Indian GST router for CGST/SGST/IGST split.
  if (profile.jurisdictionKind === "gst") {
    const aggregateRate = applicableRates.reduce((s, r) => s + Number(r.ratePct), 0);
    const gst = resolveGstTax({
      sellerStateCode: input.sellerStateCode ?? profile.region ?? null,
      buyerStateCode: input.buyerStateCode,
      buyerCountry: input.buyerCountry,
      taxableValue: taxable,
      gstRate: aggregateRate,
    });
    const components: TaxComponentResult[] = [];
    if (gst.routing === "cgst_sgst") {
      const half = aggregateRate / 2;
      components.push({ componentName: "CGST", ratePct: half, amount: gst.cgst });
      components.push({ componentName: "SGST", ratePct: half, amount: gst.sgst });
    } else if (gst.routing === "igst") {
      components.push({ componentName: "IGST", ratePct: aggregateRate, amount: gst.igst });
    }
    const totalTax = +(gst.cgst + gst.sgst + gst.igst).toFixed(2);
    return {
      taxableAmount: taxable, totalTax, totalAmount: +(taxable + totalTax).toFixed(2),
      currency, jurisdictionKind: "gst", components, routing: gst.routing,
      invoiceLabel: profile.invoiceLabel ?? `GST ${aggregateRate}%`,
    };
  }

  // ── VAT / sales tax: apply each component rate independently.
  const components: TaxComponentResult[] = applicableRates.map((r) => ({
    componentName: r.componentName,
    ratePct: Number(r.ratePct),
    amount: applyComponent(taxable, Number(r.ratePct)),
  }));
  const totalTax = +components.reduce((s, c) => s + c.amount, 0).toFixed(2);
  const routing: TaxComputationResult["routing"] =
    profile.jurisdictionKind === "vat" ? "vat" :
    profile.jurisdictionKind === "sales_tax" ? "sales_tax" : "none";
  const labelParts = components.map((c) => `${c.componentName} ${c.ratePct}%`).join(" + ");
  return {
    taxableAmount: taxable, totalTax, totalAmount: +(taxable + totalTax).toFixed(2),
    currency, jurisdictionKind: profile.jurisdictionKind, components, routing,
    invoiceLabel: profile.invoiceLabel ?? labelParts,
  };
}

/** Convenience: resolve the org's default tax profile id. */
export async function getDefaultTaxProfileId(organizationId: number): Promise<number | null> {
  const [profile] = await db.select({ id: taxProfilesTable.id }).from(taxProfilesTable)
    .where(and(
      eq(taxProfilesTable.organizationId, organizationId),
      eq(taxProfilesTable.isDefault, true),
      eq(taxProfilesTable.isActive, true),
    )).limit(1);
  return profile?.id ?? null;
}
