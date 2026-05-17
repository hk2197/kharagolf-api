import React, { useCallback } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import Colors from "@/constants/colors";
import type { PlaysLikeBreakdown } from "@/components/HoleMapSheet";

function metersToYards(m: number) {
  return Math.round(m * 1.09361);
}

// Pure helper that builds the {title, message} pair shown by the
// per-target plays-like Alert. Extracted so the F / C / B popup logic
// can be unit-tested without rendering the full scorecard. Mirrors the
// hole-header popup format added in Task #562.
export function buildGpsPLBreakdown(
  label: string,
  bd: PlaysLikeBreakdown,
): { title: string; message: string } {
  const sign = (n: number) => (n > 0 ? `+${n}` : `${n}`);
  const lines: string[] = [
    `Raw: ${bd.rawYards} yds`,
    `Plays like: ${bd.playsLikeYards} yds`,
    "",
  ];
  if (bd.windAdj !== 0) lines.push(`Wind: ${sign(bd.windAdj)} yds`);
  if (bd.elevAdj !== 0) lines.push(`Elevation: ${sign(bd.elevAdj)} yds`);
  if (bd.tempAdj !== 0) lines.push(`Temperature: ${sign(bd.tempAdj)} yds`);
  if (bd.altitudeAdj !== 0) lines.push(`Altitude: ${sign(bd.altitudeAdj)} yds`);
  if (
    bd.windAdj === 0 &&
    bd.elevAdj === 0 &&
    bd.tempAdj === 0 &&
    bd.altitudeAdj === 0
  ) {
    lines.push("Conditions are neutral.");
  }
  return {
    title: `${label} · Plays-like breakdown`,
    message: lines.join("\n"),
  };
}

interface GpsDistanceRowProps {
  distFrontM: number | null;
  distCentreM: number;
  distBackM: number | null;
  plFront: PlaysLikeBreakdown | null;
  plCentre: PlaysLikeBreakdown | null;
  plBack: PlaysLikeBreakdown | null;
  hasPinOffset: boolean;
  /**
   * Task #1160 — when true, the green coordinates feeding these distances
   * came from the cached course bundle (not the live `/holes` endpoint).
   * Surfaces a small "saved course data" pill below the distance row so
   * the player knows the numbers are running off the offline cache.
   */
  usingCachedCourse?: boolean;
}

// F / C / B GPS distance row with tappable plays-like breakdown popups.
// Carved out of HoleCard (app/(tabs)/score.tsx) so the popup behaviour can
// be covered by automated tests.
export default function GpsDistanceRow({
  distFrontM,
  distCentreM,
  distBackM,
  plFront,
  plCentre,
  plBack,
  hasPinOffset,
  usingCachedCourse = false,
}: GpsDistanceRowProps) {
  const showBreakdown = useCallback((label: string, bd: PlaysLikeBreakdown) => {
    const { title, message } = buildGpsPLBreakdown(label, bd);
    Alert.alert(title, message);
  }, []);

  const centreLabel = hasPinOffset ? "PIN" : "CENTRE";
  const centreAlertLabel = hasPinOffset ? "Pin" : "Centre";
  const distCentreYds = metersToYards(distCentreM);

  return (
    <View>
    <View style={styles.gpsDistRow}>
      <View style={styles.gpsDistItem}>
        <Text style={styles.gpsDistLabel}>FRONT</Text>
        <Text style={styles.gpsDistVal}>
          {distFrontM ? metersToYards(distFrontM) : "--"}
        </Text>
        <Text style={styles.gpsDistUnit}>yds</Text>
        {plFront != null &&
          distFrontM != null &&
          plFront.playsLikeYards !== metersToYards(distFrontM) && (
            <Pressable
              onPress={() => showBreakdown("Front", plFront)}
              hitSlop={6}
              accessibilityLabel={`Front plays like ${plFront.playsLikeYards} yards. Tap for wind and elevation breakdown.`}
            >
              <Text style={styles.gpsDistPlaysLike}>
                plays {plFront.playsLikeYards} ⓘ
              </Text>
            </Pressable>
          )}
      </View>
      <View style={[styles.gpsDistItem, styles.gpsDistCentre]}>
        <Text style={[styles.gpsDistLabel, { color: Colors.primary }]}>
          {centreLabel}
        </Text>
        <Text
          style={[
            styles.gpsDistVal,
            { color: Colors.primary, fontSize: 28 },
          ]}
        >
          {distCentreYds}
        </Text>
        <Text style={[styles.gpsDistUnit, { color: Colors.primary }]}>yds</Text>
        {plCentre != null && plCentre.playsLikeYards !== distCentreYds && (
          <Pressable
            onPress={() => showBreakdown(centreAlertLabel, plCentre)}
            hitSlop={6}
            accessibilityLabel={`${centreAlertLabel} plays like ${plCentre.playsLikeYards} yards. Tap for wind and elevation breakdown.`}
          >
            <Text style={[styles.gpsDistPlaysLike, { color: "#FBBF24" }]}>
              plays {plCentre.playsLikeYards} ⓘ
            </Text>
          </Pressable>
        )}
      </View>
      <View style={styles.gpsDistItem}>
        <Text style={styles.gpsDistLabel}>BACK</Text>
        <Text style={styles.gpsDistVal}>
          {distBackM ? metersToYards(distBackM) : "--"}
        </Text>
        <Text style={styles.gpsDistUnit}>yds</Text>
        {plBack != null &&
          distBackM != null &&
          plBack.playsLikeYards !== metersToYards(distBackM) && (
            <Pressable
              onPress={() => showBreakdown("Back", plBack)}
              hitSlop={6}
              accessibilityLabel={`Back plays like ${plBack.playsLikeYards} yards. Tap for wind and elevation breakdown.`}
            >
              <Text style={styles.gpsDistPlaysLike}>
                plays {plBack.playsLikeYards} ⓘ
              </Text>
            </Pressable>
          )}
      </View>
    </View>
      {usingCachedCourse && (
        <View style={styles.cachedPill} accessibilityLabel="Distances using saved offline course data">
          <Text style={styles.cachedPillText}>Offline · saved course data</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  gpsDistRow: {
    flexDirection: "row",
    borderRadius: 14,
    borderWidth: 1,
    borderColor: Colors.primary + "30",
    backgroundColor: Colors.primary + "08",
    overflow: "hidden",
  },
  gpsDistItem: {
    flex: 1,
    alignItems: "center",
    paddingVertical: 10,
    gap: 2,
  },
  gpsDistCentre: {
    borderLeftWidth: 1,
    borderRightWidth: 1,
    borderColor: Colors.primary + "30",
  },
  gpsDistLabel: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 9,
    color: Colors.muted,
    letterSpacing: 1,
  },
  gpsDistVal: {
    fontFamily: "Inter_700Bold",
    fontSize: 22,
    color: Colors.textSecondary,
  },
  gpsDistUnit: {
    fontFamily: "Inter_400Regular",
    fontSize: 10,
    color: Colors.muted,
  },
  gpsDistPlaysLike: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 10,
    color: Colors.muted,
    marginTop: 2,
  },
  cachedPill: {
    alignSelf: "center",
    marginTop: 6,
    paddingHorizontal: 10,
    paddingVertical: 3,
    borderRadius: 10,
    backgroundColor: "rgba(251,191,36,0.15)",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(251,191,36,0.45)",
  },
  cachedPillText: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 10,
    color: "#FBBF24",
    letterSpacing: 0.3,
  },
});
