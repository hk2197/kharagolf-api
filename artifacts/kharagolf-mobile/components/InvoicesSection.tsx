import React from "react";
import { View, Text, TouchableOpacity, StyleSheet } from "react-native";
import { useTranslation } from "react-i18next";
import Colors from "@/constants/colors";
import { PriceWithFx } from "@/components/PriceWithFx";
import { getLocale } from "@/i18n";

const sectionStyles = StyleSheet.create({
  section: { marginHorizontal: 16, marginBottom: 24 },
  sectionTitle: {
    fontSize: 12,
    fontWeight: "700",
    color: Colors.tabIconDefault,
    textTransform: "uppercase",
    letterSpacing: 2,
    marginBottom: 10,
  },
});

export interface MyInvoice {
  id: number;
  invoiceNumber: string;
  status: string;
  totalAmount: string;
  paidAmount: string;
  currency: string;
  dueDate: string | null;
  paidAt: string | null;
  razorpayPaymentLinkUrl: string | null;
  notes: string | null;
  createdAt: string;
}

const STATUS_COLORS: Record<string, string> = {
  draft: "#6b7280",
  sent: "#3b82f6",
  paid: "#22c55e",
  overdue: "#ef4444",
  cancelled: "#6b7280",
  void: "#6b7280",
};

/**
 * Mobile dues-invoices section. Extracted from `app/(tabs)/profile.tsx`
 * (Task #1115) so the empty state, list rows and "Pay now" interaction
 * can be regression-tested independently.
 *
 * Stable `testID` hooks:
 *   - `invoices-empty`            — empty placeholder
 *   - `invoice-row-{id}`          — list row container
 *   - `invoice-pay-{id}`          — primary "Pay Now" action
 */
export function InvoicesSection({
  invoices,
  orgId,
  token,
  onPayInvoice,
}: {
  invoices: MyInvoice[];
  orgId: number | null | undefined;
  token: string | null | undefined;
  onPayInvoice?: (invoice: MyInvoice) => void;
}) {
  const { t } = useTranslation("profile");

  if (invoices.length === 0) {
    return (
      <View style={sectionStyles.section} testID="invoices-section">
        <Text style={sectionStyles.sectionTitle}>{t("invoices.section")}</Text>
        <View
          testID="invoices-empty"
          style={{
            backgroundColor: "#1a1a2e",
            borderRadius: 12,
            padding: 16,
            borderWidth: 1,
            borderColor: "rgba(255,255,255,0.06)",
          }}
        >
          <Text style={{ color: Colors.tabIconDefault, fontSize: 13 }}>
            {t("invoices.empty")}
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View style={sectionStyles.section} testID="invoices-section">
      <Text style={sectionStyles.sectionTitle}>{t("invoices.section")}</Text>
      {invoices.map(inv => {
        const isPaid = inv.status === "paid";
        const isOverdue = inv.status === "overdue";
        const color = STATUS_COLORS[inv.status] ?? "#6b7280";
        return (
          <View
            key={inv.id}
            testID={`invoice-row-${inv.id}`}
            style={{
              backgroundColor: "#1a1a2e",
              borderRadius: 12,
              padding: 14,
              marginBottom: 10,
              borderWidth: 1,
              borderColor: "rgba(255,255,255,0.06)",
            }}
          >
            <View
              style={{
                flexDirection: "row",
                justifyContent: "space-between",
                alignItems: "flex-start",
              }}
            >
              <View style={{ flex: 1 }}>
                <View
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 8,
                    marginBottom: 4,
                  }}
                >
                  <Text style={{ color: "#fff", fontFamily: "monospace", fontSize: 11 }}>
                    {inv.invoiceNumber}
                  </Text>
                  <View
                    style={{
                      backgroundColor: `${color}22`,
                      borderRadius: 6,
                      paddingHorizontal: 6,
                      paddingVertical: 2,
                    }}
                  >
                    <Text style={{ color, fontSize: 10, fontWeight: "700" }}>
                      {t(`invoices.statuses.${inv.status}`) || inv.status}
                    </Text>
                  </View>
                </View>
                <PriceWithFx
                  orgId={orgId ?? null}
                  amount={inv.totalAmount}
                  currency={inv.currency}
                  token={token}
                  productClass="membership_dues"
                  bookedStyle={{ color: "#fff", fontSize: 18, fontWeight: "800" }}
                />
                {inv.dueDate ? (
                  <Text
                    style={{
                      color: isOverdue ? "#ef4444" : Colors.tabIconDefault,
                      fontSize: 12,
                      marginTop: 2,
                    }}
                  >
                    {isOverdue ? t("invoices.overdueSince") : t("invoices.due")}
                    {new Date(inv.dueDate).toLocaleDateString(getLocale(), {
                      day: "numeric",
                      month: "short",
                      year: "numeric",
                    })}
                  </Text>
                ) : null}
                {isPaid && inv.paidAt ? (
                  <Text style={{ color: "#22c55e", fontSize: 12, marginTop: 2 }}>
                    {t("invoices.paid", {
                      date: new Date(inv.paidAt).toLocaleDateString(getLocale(), {
                        day: "numeric",
                        month: "short",
                        year: "numeric",
                      }),
                    })}
                  </Text>
                ) : null}
              </View>
              {inv.razorpayPaymentLinkUrl && !isPaid ? (
                <TouchableOpacity
                  testID={`invoice-pay-${inv.id}`}
                  style={{
                    backgroundColor: "#22c55e",
                    borderRadius: 8,
                    paddingHorizontal: 12,
                    paddingVertical: 8,
                    marginLeft: 8,
                  }}
                  onPress={() => onPayInvoice?.(inv)}
                >
                  <Text style={{ color: "#fff", fontSize: 12, fontWeight: "700" }}>
                    {t("invoices.payNow")}
                  </Text>
                </TouchableOpacity>
              ) : null}
            </View>
          </View>
        );
      })}
    </View>
  );
}

export default InvoicesSection;
