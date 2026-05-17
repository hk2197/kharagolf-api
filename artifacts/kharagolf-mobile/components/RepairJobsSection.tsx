import React from "react";
import { View, Text, TouchableOpacity, StyleSheet } from "react-native";
import { Feather } from "@expo/vector-icons";
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

export interface RepairJob {
  id: number;
  description: string;
  jobType: string;
  status: string;
  technicianName: string | null;
  expectedCompletionDate: string | null;
  notificationSentAt: string | null;
  createdAt: string;
}

const STATUS_COLORS: Record<string, string> = {
  received: "#3b82f6",
  in_progress: "#f59e0b",
  ready_for_pickup: "#22c55e",
  collected: "#6b7280",
};

/**
 * Mobile club-repair-jobs section. Extracted from `app/(tabs)/profile.tsx`
 * (Task #1115) so the empty state, list rows and "ready for pickup"
 * banner can be regression-tested independently.
 *
 * Stable `testID` hooks:
 *   - `repairs-empty`             — empty placeholder
 *   - `repair-row-{id}`           — list row container
 *   - `repair-ready-{id}`         — primary "ready for pickup" banner /
 *                                   pickup-acknowledge action
 */
export function RepairJobsSection({
  jobs,
  onAcknowledgeReady,
}: {
  jobs: RepairJob[];
  onAcknowledgeReady?: (job: RepairJob) => void;
}) {
  const { t } = useTranslation("profile");

  if (jobs.length === 0) {
    return (
      <View style={sectionStyles.section} testID="repairs-section">
        <Text style={sectionStyles.sectionTitle}>{t("repairs.section")}</Text>
        <View
          testID="repairs-empty"
          style={{
            backgroundColor: Colors.surface,
            borderRadius: 12,
            padding: 16,
            borderWidth: 1,
            borderColor: Colors.border,
          }}
        >
          <Text style={{ color: Colors.tabIconDefault, fontSize: 13 }}>
            {t("repairs.empty")}
          </Text>
        </View>
      </View>
    );
  }

  const statusLabels: Record<string, string> = {
    received: t("repairs.status.received"),
    in_progress: t("repairs.status.in_progress"),
    ready_for_pickup: t("repairs.status.ready_for_pickup"),
    collected: t("repairs.status.collected"),
  };
  const jobTypeLabels: Record<string, string> = {
    regrip: t("repairs.type.regrip"),
    reshaft: t("repairs.type.reshaft"),
    loft_lie_adjustment: t("repairs.type.loft_lie_adjustment"),
    cleaning: t("repairs.type.cleaning"),
    other: t("repairs.type.other"),
  };

  return (
    <View style={sectionStyles.section} testID="repairs-section">
      <Text style={sectionStyles.sectionTitle}>{t("repairs.section")}</Text>
      {jobs.map(job => {
        const color = STATUS_COLORS[job.status] ?? "#6b7280";
        const isReady = job.status === "ready_for_pickup";
        const readyBannerStyle = {
          flexDirection: "row" as const,
          alignItems: "center" as const,
          gap: 6,
          marginTop: 8,
          backgroundColor: "#14532d20",
          borderRadius: 8,
          padding: 8,
        };
        return (
          <View
            key={job.id}
            testID={`repair-row-${job.id}`}
            style={{
              backgroundColor: Colors.surface,
              borderRadius: 12,
              padding: 14,
              marginBottom: 8,
              borderWidth: 1,
              borderColor: Colors.border,
            }}
          >
            <View
              style={{
                flexDirection: "row",
                justifyContent: "space-between",
                alignItems: "flex-start",
                marginBottom: 6,
              }}
            >
              <View style={{ flex: 1 }}>
                <Text style={{ color: "#fff", fontWeight: "700", fontSize: 14 }}>
                  {job.description}
                </Text>
                <Text style={{ color: Colors.tabIconDefault, fontSize: 12, marginTop: 2 }}>
                  {jobTypeLabels[job.jobType] ?? job.jobType}
                </Text>
              </View>
              <View
                style={{
                  backgroundColor: `${color}20`,
                  borderRadius: 6,
                  paddingHorizontal: 8,
                  paddingVertical: 3,
                  marginLeft: 8,
                }}
              >
                <Text style={{ color, fontSize: 11, fontWeight: "700" }}>
                  {statusLabels[job.status] ?? job.status}
                </Text>
              </View>
            </View>
            {job.technicianName ? (
              <Text style={{ color: Colors.tabIconDefault, fontSize: 12 }}>
                {t("repairs.technician", { name: job.technicianName })}
              </Text>
            ) : null}
            {job.expectedCompletionDate ? (
              <Text style={{ color: Colors.tabIconDefault, fontSize: 12, marginTop: 2 }}>
                {t("repairs.expected", {
                  date: new Date(job.expectedCompletionDate).toLocaleDateString(getLocale(), {
                    day: "numeric",
                    month: "short",
                    year: "numeric",
                  }),
                })}
              </Text>
            ) : null}
            {isReady ? (
              onAcknowledgeReady ? (
                <TouchableOpacity
                  testID={`repair-ready-${job.id}`}
                  activeOpacity={0.7}
                  onPress={() => onAcknowledgeReady(job)}
                  style={readyBannerStyle}
                >
                  <Feather name="bell" size={14} color="#22c55e" />
                  <Text style={{ color: "#22c55e", fontSize: 12, fontWeight: "600" }}>
                    {t("repairs.readyForPickup")}
                  </Text>
                </TouchableOpacity>
              ) : (
                <View testID={`repair-ready-${job.id}`} style={readyBannerStyle}>
                  <Feather name="bell" size={14} color="#22c55e" />
                  <Text style={{ color: "#22c55e", fontSize: 12, fontWeight: "600" }}>
                    {t("repairs.readyForPickup")}
                  </Text>
                </View>
              )
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

export default RepairJobsSection;
