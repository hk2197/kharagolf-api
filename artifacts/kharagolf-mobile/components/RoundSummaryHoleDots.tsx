/**
 * RoundSummaryHoleDots — per-hole Strokes Gained dot row rendered on the
 * post-round Round Summary screen.
 *
 * Each dot is a `Pressable` that fires `onPressHole(holeNumber)` when tapped,
 * which the Round Summary screen wires up to open `<HoleShotReviewModal>` for
 * that hole. Extracted from `app/(tabs)/score.tsx` (Task #1085) so the dot's
 * `onPress` wiring can be exercised by an automated test without dragging the
 * full scoring screen's expo-camera / expo-location / background-task imports
 * into the test runner. The companion test
 * `__tests__/round-summary-hole-dot-press.test.tsx` mounts this component
 * with no modal open, fires a press on a `Review shots for hole N` dot, and
 * asserts `<HoleShotReviewModal>` opens with the matching `holeNumber`.
 */
import React from "react";
import { Animated, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import Colors from "@/constants/colors";

export interface RoundSummaryHoleResult {
  holeNumber: number;
  strokes: number;
  par: number;
  toPar: number;
}

export interface RoundSummaryHoleSg {
  holeNumber: number;
  sgTotal: number;
}

export interface RoundSummaryHoleDotsProps {
  holeResults: RoundSummaryHoleResult[];
  sgRound: { shotsTracked: number; holes: RoundSummaryHoleSg[] } | null | undefined;
  onPressHole: (holeNumber: number) => void;
  opacity?: Animated.AnimatedInterpolation<number> | number;
}

export default function RoundSummaryHoleDots({
  holeResults,
  sgRound,
  onPressHole,
  opacity,
}: RoundSummaryHoleDotsProps) {
  if (!sgRound || sgRound.shotsTracked <= 0 || holeResults.length === 0) return null;
  return (
    <Animated.View style={{ opacity, marginTop: 12 }}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.holeDots}
      >
        {holeResults.map((h) => {
          const diff = h.toPar;
          let dotColor: string = Colors.surface;
          if (diff < 0) dotColor = Colors.birdie;
          else if (diff === 0) dotColor = Colors.par;
          else if (diff === 1) dotColor = Colors.bogey;
          else dotColor = Colors.doubleOrWorse;

          const sgHole = sgRound.holes.find((sh) => sh.holeNumber === h.holeNumber);
          const sgTotal = sgHole?.sgTotal ?? 0;
          const showSg = !!sgHole && Math.abs(sgTotal) >= 0.05;
          const sgIndicatorColor = sgTotal > 0 ? Colors.birdie : Colors.doubleOrWorse;

          return (
            <Pressable
              key={h.holeNumber}
              onPress={() => onPressHole(h.holeNumber)}
              style={[
                styles.holeDot,
                { backgroundColor: dotColor, borderColor: Colors.border },
              ]}
              accessibilityLabel={
                showSg
                  ? `Review shots for hole ${h.holeNumber}, strokes gained ${sgTotal > 0 ? "+" : ""}${sgTotal.toFixed(2)}`
                  : `Review shots for hole ${h.holeNumber}`
              }
            >
              <Text style={styles.holeDotText}>{h.holeNumber}</Text>
              {showSg && (
                <View
                  style={[
                    styles.holeDotSgBadge,
                    { backgroundColor: sgIndicatorColor },
                  ]}
                />
              )}
            </Pressable>
          );
        })}
      </ScrollView>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  holeDots: {
    flexDirection: "row",
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 6,
  },
  holeDot: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1.5,
  },
  holeDotText: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 11,
    color: Colors.textSecondary,
  },
  holeDotSgBadge: {
    position: "absolute",
    top: -2,
    right: -2,
    width: 8,
    height: 8,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: Colors.background,
  },
});
