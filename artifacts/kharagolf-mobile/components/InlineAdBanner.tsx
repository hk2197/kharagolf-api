import React, { useState } from "react";
import { View, StyleSheet, type StyleProp, type ViewStyle } from "react-native";
import AdSlot from "./AdSlot";

/**
 * Inline sponsor banner used inside mid-round screens (leaderboard footer,
 * scorecard banner, etc.). Reserves no space until a real creative loads, so
 * empty deliveries don't leave a blank strip in the UI. Tracks impressions
 * and clicks through the underlying `AdSlot`.
 */
export default function InlineAdBanner({
  orgId,
  slotKey,
  tournamentId,
  height = 64,
  style,
}: {
  orgId: number;
  slotKey: string;
  tournamentId?: number;
  height?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const [loaded, setLoaded] = useState(false);

  return (
    <View
      // Only apply caller-supplied margins/padding once a creative is
      // actually rendered, so empty deliveries don't reserve any space
      // (height OR margin) in the surrounding layout.
      style={[
        styles.wrap,
        loaded ? style : null,
        { height: loaded ? height : 0 },
      ]}
      pointerEvents={loaded ? "auto" : "none"}
    >
      <AdSlot
        orgId={orgId}
        slotKey={slotKey}
        tournamentId={tournamentId}
        onLoaded={() => setLoaded(true)}
        onEmpty={() => setLoaded(false)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    width: "100%",
    overflow: "hidden",
    backgroundColor: "transparent",
  },
});
