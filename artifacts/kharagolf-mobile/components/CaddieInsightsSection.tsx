import React from "react";
import { View, Text, TouchableOpacity, StyleSheet } from "react-native";
import { Feather } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import Colors from "@/constants/colors";
import { translateLieType } from "@/i18n/lieType";

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

export interface CaddieInsightsData {
  total: number;
  accepted: number;
  overridden: number;
  pending: number;
  acceptanceRate: number | null;
  avgProximityAccepted: number | null;
  avgProximityOverridden: number | null;
  proximityAcceptedSamples: number;
  proximityOverriddenSamples: number;
  mostOverriddenClubs: Array<{
    club: string;
    overridden: number;
    total: number;
    overrideRate: number;
  }>;
  perClub: Array<{
    club: string;
    total: number;
    accepted: number;
    overridden: number;
    acceptanceRate: number;
    avgProximityAccepted: number | null;
    avgProximityOverridden: number | null;
  }>;
  perLie?: Array<{
    lie: string;
    total: number;
    accepted: number;
    overridden: number;
    acceptanceRate: number;
    avgProximityAccepted: number | null;
    avgProximityOverridden: number | null;
  }>;
}

interface Props {
  insights: CaddieInsightsData | null;
  consentBlocked: boolean;
  onOpenConsents: () => void;
  onOpenPending: () => void;
}

/**
 * Extracted from `profile.tsx` (Task #1113) — mirrors the LockerRenewalCard
 * pattern so the AI Caddie acceptance-rate, override breakdown, proximity
 * comparison, per-club / per-lie tables, and the pending-review CTA can be
 * regression-tested in isolation.
 */
export function CaddieInsightsSection({
  insights,
  consentBlocked,
  onOpenConsents,
  onOpenPending,
}: Props) {
  const { t } = useTranslation("profile");

  if (consentBlocked) {
    return (
      <View
        testID="caddie-insights-section-blocked"
        style={sectionStyles.section}
      >
        <Text style={sectionStyles.sectionTitle}>
          {t("caddieInsights.section")}
        </Text>
        <View
          style={{
            backgroundColor: Colors.surface,
            borderRadius: 16,
            padding: 16,
            borderWidth: 1,
            borderColor: `${Colors.primary}40`,
            alignItems: "center",
          }}
        >
          <Text
            style={{
              color: Colors.text,
              fontWeight: "600",
              marginBottom: 6,
              textAlign: "center",
            }}
          >
            AI Caddie is turned off
          </Text>
          <Text
            style={{
              color: Colors.textSecondary,
              fontSize: 13,
              textAlign: "center",
              marginBottom: 12,
            }}
          >
            Re-enable AI consent to see your acceptance trends and recommendations.
          </Text>
          <TouchableOpacity
            onPress={onOpenConsents}
            style={{
              backgroundColor: Colors.primary,
              paddingHorizontal: 16,
              paddingVertical: 10,
              borderRadius: 10,
            }}
          >
            <Text style={{ color: "#000", fontWeight: "700" }}>
              Open Consent Settings
            </Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  if (!insights || insights.total <= 0) {
    return null;
  }

  return (
    <View testID="caddie-insights-section" style={sectionStyles.section}>
      <Text style={sectionStyles.sectionTitle}>
        {t("caddieInsights.section")}
      </Text>
      <View
        style={{
          backgroundColor: Colors.surface,
          borderRadius: 16,
          padding: 16,
          borderWidth: 1,
          borderColor: `${Colors.primary}40`,
        }}
      >
        {/* Acceptance rate */}
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 12,
          }}
        >
          <View>
            <Text
              style={{
                color: Colors.tabIconDefault,
                fontSize: 11,
                textTransform: "uppercase",
                letterSpacing: 0.8,
              }}
            >
              {t("caddieInsights.acceptanceRate")}
            </Text>
            <Text
              style={{
                color: Colors.primary,
                fontSize: 30,
                fontWeight: "900",
                marginTop: 2,
              }}
            >
              {insights.acceptanceRate != null
                ? `${Math.round(insights.acceptanceRate * 100)}%`
                : "—"}
            </Text>
            <Text
              style={{ color: Colors.tabIconDefault, fontSize: 11, marginTop: 2 }}
            >
              {t("caddieInsights.accVsOver", {
                accepted: insights.accepted,
                total: insights.accepted + insights.overridden,
              })}
            </Text>
          </View>
          <View
            style={{
              width: 48,
              height: 48,
              borderRadius: 24,
              backgroundColor: `${Colors.primary}20`,
              alignItems: "center",
              justifyContent: "center",
              borderWidth: 1,
              borderColor: `${Colors.primary}40`,
            }}
          >
            <Feather name="cpu" size={22} color={Colors.primary} />
          </View>
        </View>

        {/* Task #617 — Accepted / Overridden / Pending breakdown */}
        <View style={{ flexDirection: "row", gap: 8, marginBottom: 12 }}>
          <View
            style={{
              flex: 1,
              backgroundColor: Colors.background,
              borderRadius: 10,
              padding: 10,
              borderWidth: 1,
              borderColor: `${Colors.primary}30`,
              alignItems: "center",
            }}
          >
            <Feather name="check-circle" size={14} color={Colors.primary} />
            <Text
              style={{
                color: "#fff",
                fontSize: 18,
                fontWeight: "800",
                marginTop: 4,
              }}
            >
              {insights.accepted}
            </Text>
            <Text
              style={{
                color: Colors.tabIconDefault,
                fontSize: 10,
                textTransform: "uppercase",
                letterSpacing: 0.5,
                marginTop: 2,
              }}
            >
              {t("caddieInsights.acceptedLabel")}
            </Text>
          </View>
          <View
            style={{
              flex: 1,
              backgroundColor: Colors.background,
              borderRadius: 10,
              padding: 10,
              borderWidth: 1,
              borderColor: "#f59e0b40",
              alignItems: "center",
            }}
          >
            <Feather name="rotate-ccw" size={14} color="#f59e0b" />
            <Text
              style={{
                color: "#fff",
                fontSize: 18,
                fontWeight: "800",
                marginTop: 4,
              }}
            >
              {insights.overridden}
            </Text>
            <Text
              style={{
                color: Colors.tabIconDefault,
                fontSize: 10,
                textTransform: "uppercase",
                letterSpacing: 0.5,
                marginTop: 2,
              }}
            >
              {t("caddieInsights.overriddenLabel")}
            </Text>
          </View>
          <TouchableOpacity
            testID="caddie-insights-pending-cta"
            activeOpacity={insights.pending > 0 ? 0.7 : 1}
            onPress={() => {
              if (insights.pending > 0) onOpenPending();
            }}
            style={{
              flex: 1,
              backgroundColor: Colors.background,
              borderRadius: 10,
              padding: 10,
              borderWidth: 1,
              borderColor:
                insights.pending > 0 ? `${Colors.primary}60` : Colors.border,
              alignItems: "center",
            }}
          >
            <Feather
              name="clock"
              size={14}
              color={insights.pending > 0 ? Colors.primary : Colors.tabIconDefault}
            />
            <Text
              style={{
                color: insights.pending > 0 ? "#fff" : Colors.tabIconDefault,
                fontSize: 18,
                fontWeight: "800",
                marginTop: 4,
              }}
            >
              {insights.pending}
            </Text>
            <Text
              style={{
                color: Colors.tabIconDefault,
                fontSize: 10,
                textTransform: "uppercase",
                letterSpacing: 0.5,
                marginTop: 2,
              }}
            >
              {t("caddieInsights.pendingLabel")}
            </Text>
            {insights.pending > 0 && (
              <Text
                style={{
                  color: Colors.primary,
                  fontSize: 9,
                  fontWeight: "700",
                  marginTop: 3,
                  textTransform: "uppercase",
                  letterSpacing: 0.5,
                }}
              >
                {t("caddieInsights.pendingReview")}
              </Text>
            )}
          </TouchableOpacity>
        </View>

        {/* Proximity comparison */}
        {(insights.avgProximityAccepted != null ||
          insights.avgProximityOverridden != null) && (
          <>
            <View style={{ flexDirection: "row", gap: 10, marginBottom: 10 }}>
              <View
                style={{
                  flex: 1,
                  backgroundColor: Colors.background,
                  borderRadius: 10,
                  padding: 12,
                  borderWidth: 1,
                  borderColor: Colors.border,
                }}
              >
                <Text
                  style={{
                    color: Colors.tabIconDefault,
                    fontSize: 10,
                    textTransform: "uppercase",
                    letterSpacing: 0.5,
                  }}
                >
                  {t("caddieInsights.avgProxAccepted")}
                </Text>
                <Text
                  style={{
                    color: "#fff",
                    fontSize: 18,
                    fontWeight: "800",
                    marginTop: 4,
                  }}
                >
                  {insights.avgProximityAccepted != null
                    ? `${insights.avgProximityAccepted} ${t("caddieInsights.yds")}`
                    : "—"}
                </Text>
                <Text
                  style={{
                    color: Colors.tabIconDefault,
                    fontSize: 10,
                    marginTop: 2,
                  }}
                >
                  {t("caddieInsights.samples", {
                    count: insights.proximityAcceptedSamples,
                  })}
                </Text>
              </View>
              <View
                style={{
                  flex: 1,
                  backgroundColor: Colors.background,
                  borderRadius: 10,
                  padding: 12,
                  borderWidth: 1,
                  borderColor: Colors.border,
                }}
              >
                <Text
                  style={{
                    color: Colors.tabIconDefault,
                    fontSize: 10,
                    textTransform: "uppercase",
                    letterSpacing: 0.5,
                  }}
                >
                  {t("caddieInsights.avgProxOverridden")}
                </Text>
                <Text
                  style={{
                    color: "#fff",
                    fontSize: 18,
                    fontWeight: "800",
                    marginTop: 4,
                  }}
                >
                  {insights.avgProximityOverridden != null
                    ? `${insights.avgProximityOverridden} ${t("caddieInsights.yds")}`
                    : "—"}
                </Text>
                <Text
                  style={{
                    color: Colors.tabIconDefault,
                    fontSize: 10,
                    marginTop: 2,
                  }}
                >
                  {t("caddieInsights.samples", {
                    count: insights.proximityOverriddenSamples,
                  })}
                </Text>
              </View>
            </View>
            {insights.avgProximityAccepted != null &&
              insights.avgProximityOverridden != null &&
              (() => {
                const delta =
                  Math.round(
                    (insights.avgProximityOverridden -
                      insights.avgProximityAccepted) *
                      10,
                  ) / 10;
                const aiCloser = delta > 0;
                const tied = delta === 0;
                const color = aiCloser
                  ? Colors.primary
                  : tied
                    ? Colors.tabIconDefault
                    : "#f59e0b";
                return (
                  <View
                    style={{
                      backgroundColor: `${color}15`,
                      borderRadius: 10,
                      padding: 10,
                      borderWidth: 1,
                      borderColor: `${color}40`,
                      marginBottom:
                        insights.mostOverriddenClubs.length > 0 ? 14 : 0,
                      flexDirection: "row",
                      alignItems: "center",
                    }}
                  >
                    <Feather
                      name={
                        aiCloser
                          ? "trending-down"
                          : tied
                            ? "minus"
                            : "trending-up"
                      }
                      size={16}
                      color={color}
                      style={{ marginRight: 8 }}
                    />
                    <Text style={{ color: "#fff", fontSize: 12, flex: 1 }}>
                      {tied
                        ? t("caddieInsights.deltaTied")
                        : aiCloser
                          ? t("caddieInsights.deltaAiCloser", {
                              yards: Math.abs(delta),
                            })
                          : t("caddieInsights.deltaYouCloser", {
                              yards: Math.abs(delta),
                            })}
                    </Text>
                  </View>
                );
              })()}
          </>
        )}

        {/* Most overridden clubs */}
        {insights.mostOverriddenClubs.length > 0 && (
          <View>
            <Text
              style={{
                color: Colors.tabIconDefault,
                fontSize: 11,
                textTransform: "uppercase",
                letterSpacing: 0.8,
                marginBottom: 8,
              }}
            >
              {t("caddieInsights.mostOverridden")}
            </Text>
            {insights.mostOverriddenClubs.map((c) => (
              <View
                key={c.club}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  backgroundColor: Colors.background,
                  borderRadius: 10,
                  padding: 10,
                  marginBottom: 6,
                  borderWidth: 1,
                  borderColor: Colors.border,
                }}
              >
                <Feather
                  name="rotate-ccw"
                  size={16}
                  color="#f59e0b"
                  style={{ marginRight: 10 }}
                />
                <View style={{ flex: 1 }}>
                  <Text
                    style={{ color: "#fff", fontSize: 13, fontWeight: "700" }}
                  >
                    {c.club}
                  </Text>
                  <Text
                    style={{
                      color: Colors.tabIconDefault,
                      fontSize: 11,
                      marginTop: 1,
                    }}
                  >
                    {t("caddieInsights.overriddenCount", {
                      overridden: c.overridden,
                      total: c.total,
                    })}
                  </Text>
                </View>
                <Text
                  style={{ color: "#f59e0b", fontSize: 14, fontWeight: "800" }}
                >
                  {Math.round(c.overrideRate * 100)}%
                </Text>
              </View>
            ))}
          </View>
        )}

        {/* Task #488 — Per-lie breakdown */}
        {insights.perLie && insights.perLie.length > 0 && (
          <View style={{ marginTop: 14 }}>
            <Text
              style={{
                color: Colors.tabIconDefault,
                fontSize: 11,
                textTransform: "uppercase",
                letterSpacing: 0.8,
                marginBottom: 8,
              }}
            >
              {t("caddieInsights.perLie")}
            </Text>
            {insights.perLie.map((l) => {
              const decided = l.accepted + l.overridden;
              const lieLabel = translateLieType(t, l.lie);
              return (
                <View
                  key={l.lie}
                  style={{
                    backgroundColor: Colors.background,
                    borderRadius: 10,
                    padding: 10,
                    marginBottom: 6,
                    borderWidth: 1,
                    borderColor: Colors.border,
                  }}
                >
                  <View
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      justifyContent: "space-between",
                    }}
                  >
                    <View style={{ flex: 1, paddingRight: 8 }}>
                      <Text
                        style={{
                          color: "#fff",
                          fontSize: 13,
                          fontWeight: "700",
                          textTransform: "capitalize",
                        }}
                      >
                        {lieLabel}
                      </Text>
                      <Text
                        style={{
                          color: Colors.tabIconDefault,
                          fontSize: 11,
                          marginTop: 1,
                        }}
                      >
                        {t("caddieInsights.lieSummary", {
                          accepted: l.accepted,
                          decided,
                        })}
                      </Text>
                    </View>
                    <Text
                      style={{
                        color: Colors.primary,
                        fontSize: 14,
                        fontWeight: "800",
                      }}
                    >
                      {Math.round(l.acceptanceRate * 100)}%
                    </Text>
                  </View>
                  {(l.avgProximityAccepted != null ||
                    l.avgProximityOverridden != null) && (
                    <View style={{ flexDirection: "row", marginTop: 6 }}>
                      {l.avgProximityAccepted != null && (
                        <Text
                          style={{
                            color: Colors.tabIconDefault,
                            fontSize: 11,
                            marginRight: 12,
                          }}
                        >
                          {t("caddieInsights.avgProxAccepted")}:{" "}
                          <Text style={{ color: "#fff" }}>
                            {l.avgProximityAccepted} {t("caddieInsights.yds")}
                          </Text>
                        </Text>
                      )}
                      {l.avgProximityOverridden != null && (
                        <Text
                          style={{ color: Colors.tabIconDefault, fontSize: 11 }}
                        >
                          {t("caddieInsights.avgProxOverridden")}:{" "}
                          <Text style={{ color: "#fff" }}>
                            {l.avgProximityOverridden} {t("caddieInsights.yds")}
                          </Text>
                        </Text>
                      )}
                    </View>
                  )}
                </View>
              );
            })}
          </View>
        )}

        {insights.pending > 0 && (
          <Text
            style={{
              color: Colors.tabIconDefault,
              fontSize: 11,
              marginTop: 10,
              fontStyle: "italic",
            }}
          >
            {t("caddieInsights.pendingNote", { count: insights.pending })}
          </Text>
        )}
      </View>
    </View>
  );
}

export default CaddieInsightsSection;
