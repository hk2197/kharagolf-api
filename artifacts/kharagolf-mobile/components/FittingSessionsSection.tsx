import React from "react";
import { View, Text, TouchableOpacity, StyleSheet } from "react-native";
import { useTranslation } from "react-i18next";
import Colors from "@/constants/colors";
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

export interface FittingSession {
  id: number;
  scheduledAt: string;
  status: string;
  technicianName: string | null;
  recommendedSpecs: Record<string, string>;
  notes: string | null;
}

const STATUS_COLORS: Record<string, string> = {
  booked: "#3b82f6",
  completed: "#22c55e",
  cancelled: "#ef4444",
};

/**
 * Mobile club-fitting-sessions section. Extracted from
 * `app/(tabs)/profile.tsx` (Task #1115) so the empty state, list rows
 * and "view session" interaction can be regression-tested independently.
 *
 * Stable `testID` hooks:
 *   - `fittings-empty`            — empty placeholder
 *   - `fitting-row-{id}`          — list row container (acts as the
 *                                   primary "open session details" action
 *                                   when `onSelectSession` is provided)
 */
export function FittingSessionsSection({
  sessions,
  onSelectSession,
}: {
  sessions: FittingSession[];
  onSelectSession?: (session: FittingSession) => void;
}) {
  const { t } = useTranslation("profile");

  if (sessions.length === 0) {
    return (
      <View style={sectionStyles.section} testID="fittings-section">
        <Text style={sectionStyles.sectionTitle}>{t("fittingSessions.section")}</Text>
        <View
          testID="fittings-empty"
          style={{
            backgroundColor: Colors.surface,
            borderRadius: 12,
            padding: 16,
            borderWidth: 1,
            borderColor: Colors.border,
          }}
        >
          <Text style={{ color: Colors.tabIconDefault, fontSize: 13 }}>
            {t("fittingSessions.empty")}
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View style={sectionStyles.section} testID="fittings-section">
      <Text style={sectionStyles.sectionTitle}>{t("fittingSessions.section")}</Text>
      {sessions.map(session => {
        const color = STATUS_COLORS[session.status] ?? "#6b7280";
        const specs = session.recommendedSpecs ?? {};
        const specKeys = Object.keys(specs).filter(k => k !== "notes" && specs[k]);
        const rowStyle = {
          backgroundColor: Colors.surface,
          borderRadius: 12,
          padding: 14,
          marginBottom: 8,
          borderWidth: 1,
          borderColor: Colors.border,
        };
        const inner = (
          <>
            <View
              style={{
                flexDirection: "row",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: 8,
              }}
            >
              <View>
                <Text style={{ color: "#fff", fontWeight: "700", fontSize: 14 }}>
                  {new Date(session.scheduledAt).toLocaleDateString(getLocale(), {
                    day: "numeric",
                    month: "short",
                    year: "numeric",
                  })}
                </Text>
                <Text style={{ color: Colors.tabIconDefault, fontSize: 12 }}>
                  {new Date(session.scheduledAt).toLocaleTimeString(getLocale(), {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                  {session.technicianName ? ` · ${session.technicianName}` : ""}
                </Text>
              </View>
              <View
                style={{
                  backgroundColor: `${color}20`,
                  borderRadius: 6,
                  paddingHorizontal: 8,
                  paddingVertical: 3,
                }}
              >
                <Text style={{ color, fontSize: 11, fontWeight: "700" }}>
                  {t(`fittingSessions.statuses.${session.status}`) || session.status}
                </Text>
              </View>
            </View>
            {specKeys.length > 0 ? (
              <View
                style={{ backgroundColor: Colors.background, borderRadius: 8, padding: 10 }}
              >
                <Text
                  style={{
                    color: Colors.tabIconDefault,
                    fontSize: 11,
                    fontWeight: "700",
                    marginBottom: 6,
                    textTransform: "uppercase",
                    letterSpacing: 0.5,
                  }}
                >
                  {t("fittingSessions.recommendedSpecs")}
                </Text>
                {specKeys.map(k => (
                  <Text key={k} style={{ color: "#fff", fontSize: 12, marginBottom: 2 }}>
                    <Text style={{ color: Colors.tabIconDefault }}>
                      {k.replace(/([A-Z])/g, " $1").trim()}:{" "}
                    </Text>
                    {specs[k]}
                  </Text>
                ))}
                {specs.notes ? (
                  <Text
                    style={{
                      color: Colors.tabIconDefault,
                      fontSize: 12,
                      marginTop: 4,
                      fontStyle: "italic",
                    }}
                  >
                    {specs.notes}
                  </Text>
                ) : null}
              </View>
            ) : null}
            {session.notes ? (
              <Text
                style={{
                  color: Colors.tabIconDefault,
                  fontSize: 12,
                  marginTop: 6,
                  fontStyle: "italic",
                }}
              >
                {session.notes}
              </Text>
            ) : null}
          </>
        );
        if (onSelectSession) {
          return (
            <TouchableOpacity
              key={session.id}
              testID={`fitting-row-${session.id}`}
              activeOpacity={0.7}
              onPress={() => onSelectSession(session)}
              style={rowStyle}
            >
              {inner}
            </TouchableOpacity>
          );
        }
        return (
          <View key={session.id} testID={`fitting-row-${session.id}`} style={rowStyle}>
            {inner}
          </View>
        );
      })}
    </View>
  );
}

export default FittingSessionsSection;
