import React from "react";
import { View, Text } from "react-native";
import Colors from "@/constants/colors";
import { PriceWithFx } from "@/components/PriceWithFx";

/**
 * Total row at the bottom of the pro shop cart drawer. Extracted so the
 * FX-aware total can be regression-tested in isolation (Task #955) — the
 * previous incarnation rendered a booked-currency-only `Text` via the
 * local `fmtPrice` helper.
 */
export function ShopCartTotalRow({
  orgId,
  token,
  total,
  currency,
  totalLabel,
}: {
  orgId?: number | null;
  token?: string | null;
  total: number;
  currency: string;
  totalLabel: string;
}) {
  return (
    <View
      style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: 12 }}
      testID="shop-cart-total-row"
    >
      <Text style={{ color: Colors.text, fontSize: 14, fontWeight: "600" }}>{totalLabel}</Text>
      <View style={{ alignItems: "flex-end" }}>
        <PriceWithFx
          orgId={orgId}
          token={token ?? null}
          amount={total}
          currency={currency}
          productClass="shop"
          bookedStyle={{ color: Colors.primary, fontSize: 16, fontWeight: "800" }}
        />
      </View>
    </View>
  );
}

export default ShopCartTotalRow;
