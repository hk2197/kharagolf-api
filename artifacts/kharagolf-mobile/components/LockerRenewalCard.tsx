import React from "react";
import { View, Text, TouchableOpacity, Linking } from "react-native";
import { Feather } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import Colors from "@/constants/colors";
import { PriceWithFx } from "@/components/PriceWithFx";
import { getLocale } from "@/i18n";

export interface LockerCardAssignment {
  id: number;
  lockerNumber: string;
  bay: string | null;
  expiryDate: string;
  startDate?: string;
  annualFee: string;
  currency: string;
  paymentStatus: string;
  paymentLinkUrl: string | null;
}

/**
 * Mobile equivalent of the web `LockerRenewalCard` (Task #820). Extracted
 * from the 2300-line profile screen so the converted-price row can be
 * regression-tested in isolation — previously the annual fee rendered as a
 * booked-currency-only `Text`, this card mounts `<PriceWithFx>` so members
 * with a different preferred display currency see the "Approx." line.
 */
export function LockerRenewalCard({
  assignment,
  orgId,
  token,
}: {
  assignment: LockerCardAssignment;
  orgId: number | null | undefined;
  token: string | null | undefined;
}) {
  const { t } = useTranslation("profile");
  const expiry = new Date(assignment.expiryDate);
  const daysLeft = Math.ceil(
    (expiry.getTime() - Date.now()) / (1000 * 60 * 60 * 24),
  );
  const expiryStr = expiry.toLocaleDateString(getLocale(), {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  const isPaid = assignment.paymentStatus === "paid";

  return (
    <View
      testID="locker-renewal-card"
      style={{
        backgroundColor: `${Colors.primary}15`,
        borderRadius: 12,
        padding: 16,
        borderWidth: 1,
        borderColor: `${Colors.primary}30`,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", marginBottom: 12 }}>
        <Feather name="lock" size={20} color={Colors.primary} />
        <Text style={{ color: "#fff", fontSize: 18, fontWeight: "800", marginLeft: 8 }}>
          {t("locker.lockerTitle", { number: assignment.lockerNumber })}
        </Text>
        {assignment.bay && (
          <Text style={{ color: Colors.tabIconDefault, fontSize: 12, marginLeft: 6 }}>
            {t("locker.bay", { number: assignment.bay })}
          </Text>
        )}
      </View>
      <View style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: 8 }}>
        <View>
          <Text style={{ color: Colors.tabIconDefault, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5 }}>
            {t("locker.renewalDate")}
          </Text>
          <Text style={{ color: "#fff", fontSize: 14, fontWeight: "600", marginTop: 2 }}>
            {expiryStr}
          </Text>
        </View>
        <View style={{ alignItems: "flex-end" }} testID="locker-renewal-fee">
          <Text style={{ color: Colors.tabIconDefault, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5 }}>
            {t("locker.annualFee")}
          </Text>
          <PriceWithFx
            orgId={orgId ?? null}
            amount={assignment.annualFee}
            currency={assignment.currency}
            token={token}
            productClass="locker_rental"
            bookedStyle={{ color: "#fff", fontSize: 14, fontWeight: "600", marginTop: 2 }}
          />
        </View>
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
          <Feather
            name={isPaid ? "check-circle" : "alert-circle"}
            size={13}
            color={isPaid ? "#22c55e" : "#f59e0b"}
          />
          <Text style={{ color: isPaid ? "#22c55e" : "#f59e0b", fontSize: 12, fontWeight: "600" }}>
            {isPaid ? t("locker.paymentComplete") : t("locker.paymentPending")}
          </Text>
        </View>
        <Text
          style={{
            color: daysLeft <= 7 ? "#ef4444" : daysLeft <= 30 ? "#f59e0b" : Colors.tabIconDefault,
            fontSize: 12,
            fontWeight: "600",
          }}
        >
          {daysLeft <= 0 ? t("locker.expired") : t("locker.daysLeft", { count: daysLeft })}
        </Text>
      </View>
      {assignment.paymentLinkUrl && !isPaid && (
        <TouchableOpacity
          style={{
            marginTop: 12,
            backgroundColor: Colors.primary,
            borderRadius: 8,
            paddingVertical: 10,
            alignItems: "center",
          }}
          onPress={() => {
            const url = assignment.paymentLinkUrl;
            if (url) Linking.openURL(url);
          }}
        >
          <Text style={{ color: "#fff", fontWeight: "700", fontSize: 14 }}>
            {t("locker.payRenewal")}
          </Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

export default LockerRenewalCard;
