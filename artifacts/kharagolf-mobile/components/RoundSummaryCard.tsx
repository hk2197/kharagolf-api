import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";

export interface HoleResult {
  holeNumber: number;
  par: number;
  strokes: number;
  toPar: number;
}

export interface RoundSummaryCardProps {
  tournamentName: string;
  playerName: string;
  orgName?: string;
  orgColor?: string;
  round: number;
  gross: number;
  net?: number | null;
  toPar: number;
  holesPlayed: number;
  eagles: number;
  birdies: number;
  pars: number;
  bogeys: number;
  doubles: number;
  holeResults: HoleResult[];
  sgTotals?: {
    sgTotal: number;
    sgOTT: number;
    sgApproach: number;
    sgATG: number;
    sgPutting: number;
    puttingEstimated?: boolean;
  } | null;
  sgShotsTracked?: number;
}

const GOLD = "#C9A84C";
const EAGLE_COLOR = "#F5C842";
const BIRDIE_COLOR = "#EF4444";
const PAR_COLOR = "#6B7280";
const BOGEY_COLOR = "#3B82F6";
const DOUBLE_COLOR = "#A855F7";
const BG_DARK = "#0D1117";
const BG_CARD = "#161B22";
const TEXT_WHITE = "#F0F4F8";
const TEXT_MUTED = "#8B949E";

function toParColor(toPar: number): string {
  if (toPar <= -2) return EAGLE_COLOR;
  if (toPar === -1) return BIRDIE_COLOR;
  if (toPar === 0) return "#4B5563";
  if (toPar === 1) return BOGEY_COLOR;
  return DOUBLE_COLOR;
}

function toParLabel(toPar: number): string {
  if (toPar === 0) return "E";
  if (toPar > 0) return `+${toPar}`;
  return `${toPar}`;
}

export default function RoundSummaryCard({
  tournamentName,
  playerName,
  orgName,
  orgColor,
  round,
  gross,
  net,
  toPar,
  holesPlayed,
  eagles,
  birdies,
  pars,
  bogeys,
  doubles,
  holeResults,
  sgTotals,
  sgShotsTracked,
}: RoundSummaryCardProps) {
  const accent = orgColor ?? GOLD;
  const toParStr = toParLabel(toPar);
  const toParClr = toPar < 0 ? BIRDIE_COLOR : toPar > 0 ? BOGEY_COLOR : "#9CA3AF";

  const holesPerRow = Math.ceil(holesPlayed / 2);
  const row1 = holeResults.slice(0, holesPerRow);
  const row2 = holeResults.slice(holesPerRow);

  return (
    <View style={styles.outer}>
      <LinearGradient
        colors={[BG_DARK, "#0A0E14"]}
        style={styles.card}
      >
        {/* Accent bar */}
        <View style={[styles.accentBar, { backgroundColor: accent }]} />

        {/* Header */}
        <LinearGradient
          colors={[`${accent}1F`, "transparent"]}
          style={styles.header}
        >
          <View style={styles.headerLeft}>
            <Ionicons name="trophy" size={22} color={accent} />
            <Text style={[styles.headerTitle, { color: accent }]}>Round Complete</Text>
          </View>
          <View style={styles.headerRight}>
            {orgName && <Text style={styles.orgName}>{orgName}</Text>}
            <View style={{ flexDirection: "row", gap: 4 }}>
              <Text style={styles.roundBadge}>Round {round}</Text>
              <Text style={styles.roundBadge}>{holesPlayed} Holes</Text>
            </View>
          </View>
        </LinearGradient>

        {/* Tournament + Player */}
        <View style={styles.titleSection}>
          <Text style={styles.tournamentName} numberOfLines={1}>{tournamentName}</Text>
          <Text style={styles.playerName}>{playerName}</Text>
        </View>

        {/* Big Score Hero */}
        <View style={styles.scoreHero}>
          <View style={styles.grossBlock}>
            <Text style={styles.grossNumber}>{gross || "—"}</Text>
            <Text style={styles.grossLabel}>Strokes</Text>
          </View>
          <View style={styles.scoreDivider} />
          <View style={styles.toParBlock}>
            <Text style={[styles.toParNumber, { color: toParClr }]}>{gross ? toParStr : "—"}</Text>
            <Text style={styles.toParLabel}>To Par</Text>
          </View>
          {net != null && (
            <>
              <View style={styles.scoreDivider} />
              <View style={styles.netBlock}>
                <Text style={[styles.netNumber, { color: accent }]}>{net}</Text>
                <Text style={styles.netLabel}>Net</Text>
              </View>
            </>
          )}
        </View>

        {/* Scoring Stats */}
        <View style={styles.statsRow}>
          {eagles > 0 && (
            <View style={styles.statPill}>
              <View style={[styles.statDot, { backgroundColor: EAGLE_COLOR }]} />
              <Text style={[styles.statText, { color: EAGLE_COLOR }]}>
                {eagles} Eagle{eagles !== 1 ? "s" : ""}
              </Text>
            </View>
          )}
          {birdies > 0 && (
            <View style={styles.statPill}>
              <View style={[styles.statDot, { backgroundColor: BIRDIE_COLOR }]} />
              <Text style={[styles.statText, { color: BIRDIE_COLOR }]}>
                {birdies} Birdie{birdies !== 1 ? "s" : ""}
              </Text>
            </View>
          )}
          <View style={styles.statPill}>
            <View style={[styles.statDot, { backgroundColor: PAR_COLOR }]} />
            <Text style={[styles.statText, { color: TEXT_MUTED }]}>
              {pars} Par{pars !== 1 ? "s" : ""}
            </Text>
          </View>
          {bogeys > 0 && (
            <View style={styles.statPill}>
              <View style={[styles.statDot, { backgroundColor: BOGEY_COLOR }]} />
              <Text style={[styles.statText, { color: BOGEY_COLOR }]}>
                {bogeys} Bogey{bogeys !== 1 ? "s" : ""}
              </Text>
            </View>
          )}
          {doubles > 0 && (
            <View style={styles.statPill}>
              <View style={[styles.statDot, { backgroundColor: DOUBLE_COLOR }]} />
              <Text style={[styles.statText, { color: DOUBLE_COLOR }]}>
                {doubles} Dbl+
              </Text>
            </View>
          )}
        </View>

        {/* Strokes Gained strip */}
        {sgTotals && (
          <View style={styles.sgStrip}>
            <View style={styles.sgStripHeader}>
              <Ionicons name="trending-up" size={11} color={accent} />
              <Text style={[styles.sgStripTitle, { color: accent }]}>STROKES GAINED</Text>
              {sgShotsTracked != null && sgShotsTracked > 0 && (
                <Text style={styles.sgStripShots}>
                  {sgShotsTracked} shot{sgShotsTracked === 1 ? "" : "s"}
                </Text>
              )}
            </View>
            <View style={styles.sgStripRow}>
              <SGCell label="Total" value={sgTotals.sgTotal} highlight />
              <SGCell label="OTT" value={sgTotals.sgOTT} />
              <SGCell label="App" value={sgTotals.sgApproach} />
              <SGCell label="ATG" value={sgTotals.sgATG} />
              <SGCell label="Putt" value={sgTotals.sgPutting} estimated={sgTotals.puttingEstimated} />
            </View>
            {sgTotals.puttingEstimated && (
              <Text style={styles.sgEstimateNote}>
                ~ Some holes' Putt SG was estimated from your scorecard putt count.
              </Text>
            )}
          </View>
        )}

        {/* Hole Dot Grid */}
        {holeResults.length > 0 && (
          <View style={styles.holeGrid}>
            <Text style={styles.holeGridLabel}>Hole-by-Hole</Text>
            <View style={styles.holeRow}>
              {row1.map(h => (
                <HoleDot key={h.holeNumber} hole={h} />
              ))}
            </View>
            {row2.length > 0 && (
              <View style={styles.holeRow}>
                {row2.map(h => (
                  <HoleDot key={h.holeNumber} hole={h} />
                ))}
              </View>
            )}
          </View>
        )}

        {/* Footer watermark */}
        <View style={styles.footer}>
          <View style={[styles.footerLine, { backgroundColor: accent + "40" }]} />
          <View style={styles.footerContent}>
            <Text style={styles.footerWordmark}>
              <Text style={{ color: TEXT_WHITE }}>KHARA</Text>
              <Text style={{ color: accent }}>GOLF</Text>
              <Text style={styles.footerEnt}> Enterprise</Text>
            </Text>
            <Text style={styles.footerTagline}>Track. Compete. Excel.</Text>
          </View>
        </View>
      </LinearGradient>
    </View>
  );
}

function SGCell({ label, value, highlight, estimated }: { label: string; value: number; highlight?: boolean; estimated?: boolean }) {
  const sign = value > 0 ? "+" : "";
  const baseColor = value > 0.05 ? BIRDIE_COLOR : value < -0.05 ? BOGEY_COLOR : TEXT_MUTED;
  const color = estimated ? TEXT_MUTED : baseColor;
  return (
    <View style={styles.sgCell}>
      <Text style={styles.sgCellLabel}>
        {label}{estimated ? " ~" : ""}
      </Text>
      <Text
        style={[
          styles.sgCellValue,
          { color },
          highlight && { fontSize: 14 },
          estimated && { opacity: 0.7, fontStyle: "italic" },
        ]}
      >
        {estimated ? "~" : ""}{sign}{value.toFixed(2)}
      </Text>
    </View>
  );
}

function HoleDot({ hole }: { hole: HoleResult }) {
  const fill = toParColor(hole.toPar);
  const isEagle = hole.toPar <= -2;
  const isBirdie = hole.toPar === -1;
  const isPar = hole.toPar === 0;

  return (
    <View style={styles.holeDotContainer}>
      <View
        style={[
          styles.holeDot,
          { backgroundColor: isPar ? "transparent" : fill + "30", borderColor: fill },
          isPar && styles.holeDotPar,
        ]}
      >
        <Text style={[styles.holeDotText, { color: isPar ? TEXT_MUTED : fill }]}>
          {hole.strokes}
        </Text>
        {(isEagle || isBirdie) && (
          <View style={[styles.holeDotInner, { borderColor: fill }]} />
        )}
      </View>
      <Text style={styles.holeDotNum}>{hole.holeNumber}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  outer: {
    width: 360,
    borderRadius: 16,
    overflow: "hidden",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.5,
    shadowRadius: 20,
    elevation: 12,
  },
  card: {
    width: 360,
    backgroundColor: BG_DARK,
  },
  accentBar: {
    height: 4,
    width: "100%",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingVertical: 14,
  },
  headerLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  headerTitle: {
    fontSize: 14,
    fontWeight: "700",
    letterSpacing: 0.5,
    textTransform: "uppercase",
  },
  headerRight: {
    alignItems: "flex-end",
    gap: 3,
  },
  orgName: {
    fontSize: 10,
    color: TEXT_MUTED,
    letterSpacing: 0.5,
  },
  roundBadge: {
    fontSize: 11,
    color: TEXT_MUTED,
    fontWeight: "600",
    backgroundColor: "rgba(255,255,255,0.06)",
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 10,
    overflow: "hidden",
  },
  titleSection: {
    paddingHorizontal: 20,
    paddingBottom: 4,
  },
  tournamentName: {
    fontSize: 18,
    fontWeight: "800",
    color: TEXT_WHITE,
    letterSpacing: -0.3,
  },
  playerName: {
    fontSize: 14,
    color: TEXT_MUTED,
    marginTop: 2,
    fontWeight: "500",
  },
  scoreHero: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: BG_CARD,
    marginHorizontal: 20,
    marginVertical: 16,
    borderRadius: 12,
    paddingVertical: 20,
    paddingHorizontal: 16,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.06)",
  },
  grossBlock: {
    alignItems: "center",
    flex: 1,
  },
  grossNumber: {
    fontSize: 52,
    fontWeight: "900",
    color: TEXT_WHITE,
    lineHeight: 58,
  },
  grossLabel: {
    fontSize: 11,
    color: TEXT_MUTED,
    textTransform: "uppercase",
    letterSpacing: 1,
    marginTop: 2,
  },
  scoreDivider: {
    width: 1,
    height: 50,
    backgroundColor: "rgba(255,255,255,0.08)",
    marginHorizontal: 12,
  },
  toParBlock: {
    alignItems: "center",
    flex: 1,
  },
  toParNumber: {
    fontSize: 42,
    fontWeight: "900",
    lineHeight: 48,
  },
  toParLabel: {
    fontSize: 11,
    color: TEXT_MUTED,
    textTransform: "uppercase",
    letterSpacing: 1,
    marginTop: 2,
  },
  netBlock: {
    alignItems: "center",
    flex: 1,
  },
  netNumber: {
    fontSize: 36,
    fontWeight: "800",
    lineHeight: 40,
  },
  netLabel: {
    fontSize: 11,
    color: TEXT_MUTED,
    textTransform: "uppercase",
    letterSpacing: 1,
    marginTop: 2,
  },
  statsRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    paddingHorizontal: 20,
    gap: 6,
    marginBottom: 16,
  },
  statPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    backgroundColor: "rgba(255,255,255,0.04)",
    borderRadius: 20,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.06)",
  },
  statDot: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
  },
  statText: {
    fontSize: 12,
    fontWeight: "600",
  },
  sgStrip: {
    marginHorizontal: 20,
    marginBottom: 16,
    backgroundColor: BG_CARD,
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.06)",
  },
  sgStripHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginBottom: 8,
  },
  sgStripTitle: {
    fontSize: 9,
    fontWeight: "700",
    letterSpacing: 1.2,
    flex: 1,
  },
  sgStripShots: {
    fontSize: 9,
    color: TEXT_MUTED,
    fontWeight: "600",
  },
  sgStripRow: {
    flexDirection: "row",
    justifyContent: "space-between",
  },
  sgCell: {
    alignItems: "center",
    flex: 1,
  },
  sgCellLabel: {
    fontSize: 9,
    color: TEXT_MUTED,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    fontWeight: "600",
    marginBottom: 2,
  },
  sgCellValue: {
    fontSize: 12,
    fontWeight: "700",
  },
  sgEstimateNote: {
    fontSize: 9,
    color: TEXT_MUTED,
    marginTop: 6,
    fontStyle: "italic",
  },
  holeGrid: {
    marginHorizontal: 20,
    marginBottom: 16,
    backgroundColor: BG_CARD,
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 10,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.06)",
  },
  holeGridLabel: {
    fontSize: 9,
    color: TEXT_MUTED,
    textTransform: "uppercase",
    letterSpacing: 1.2,
    marginBottom: 10,
    marginLeft: 4,
    fontWeight: "600",
  },
  holeRow: {
    flexDirection: "row",
    flexWrap: "nowrap",
    justifyContent: "space-around",
    marginBottom: 8,
  },
  holeDotContainer: {
    alignItems: "center",
    width: 28,
  },
  holeDot: {
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 1.5,
    alignItems: "center",
    justifyContent: "center",
    position: "relative",
  },
  holeDotPar: {
    borderColor: "#374151",
  },
  holeDotInner: {
    position: "absolute",
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 1,
    top: 1,
    left: 1,
  },
  holeDotText: {
    fontSize: 10,
    fontWeight: "700",
  },
  holeDotNum: {
    fontSize: 8,
    color: TEXT_MUTED,
    marginTop: 2,
    fontWeight: "500",
  },
  footer: {
    paddingBottom: 16,
  },
  footerLine: {
    height: 1,
    marginHorizontal: 20,
    marginBottom: 12,
  },
  footerContent: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
  },
  footerWordmark: {
    fontSize: 13,
    fontWeight: "800",
    letterSpacing: 0.5,
  },
  footerEnt: {
    fontSize: 11,
    fontWeight: "400",
    color: TEXT_MUTED,
  },
  footerTagline: {
    fontSize: 10,
    color: TEXT_MUTED,
    letterSpacing: 0.5,
    fontStyle: "italic",
  },
});
