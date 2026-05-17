import React from "react";
import { View, Text, TouchableOpacity, StyleSheet } from "react-native";
import { Feather } from "@expo/vector-icons";
import { useTranslation } from "react-i18next";
import Colors from "@/constants/colors";

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

export interface LoyaltyAccount {
  pointsBalance: number;
  lifetimePoints: number;
  rollingYearPoints: number;
  currentTier: string;
}

export interface LoyaltyReward {
  id: number;
  name: string;
  description: string | null;
  pointsCost: number;
  rewardType: string;
  minTier: string;
}

/**
 * Mobile Loyalty & Rewards section. Extracted from `app/(tabs)/profile.tsx`
 * (Task #1115) so the rendering of points balance, tier badge and reward
 * catalogue can be regression-tested in isolation.
 *
 * `testID` hooks are stable so end-to-end / interaction tests can target
 * the empty-state placeholder, the points-balance card, and individual
 * reward rows.
 */
export function LoyaltySection({
  account,
  rewards,
  onSelectReward,
}: {
  account: LoyaltyAccount | null;
  rewards: LoyaltyReward[];
  onSelectReward?: (reward: LoyaltyReward) => void;
}) {
  const { t } = useTranslation("profile");

  if (!account) {
    return (
      <View style={sectionStyles.section} testID="loyalty-section">
        <Text style={sectionStyles.sectionTitle}>{t("loyalty.section")}</Text>
        <View
          testID="loyalty-empty"
          style={{
            backgroundColor: Colors.surface,
            borderRadius: 12,
            padding: 16,
            borderWidth: 1,
            borderColor: Colors.border,
          }}
        >
          <Text style={{ color: Colors.tabIconDefault, fontSize: 13 }}>
            {t("loyalty.empty")}
          </Text>
        </View>
      </View>
    );
  }

  const tierColors: Record<string, { bg: string; border: string; fg: string; icon: string }> = {
    platinum: { bg: "#7c3aed20", border: "#7c3aed50", fg: "#a78bfa", icon: "💎" },
    gold: { bg: "#d9770620", border: "#d9770650", fg: "#fbbf24", icon: "🥇" },
    silver: { bg: "#64748b20", border: "#64748b50", fg: "#94a3b8", icon: "🥈" },
  };
  const tier = tierColors[account.currentTier] ?? {
    bg: "#37415120",
    border: "#37415150",
    fg: Colors.tabIconDefault,
    icon: "⬛",
  };

  return (
    <View style={sectionStyles.section} testID="loyalty-section">
      <Text style={sectionStyles.sectionTitle}>{t("loyalty.section")}</Text>
      <View
        testID="loyalty-points"
        style={{
          backgroundColor: Colors.surface,
          borderRadius: 16,
          padding: 16,
          marginBottom: 12,
          borderWidth: 1,
          borderColor: `${Colors.primary}40`,
          overflow: "hidden",
        }}
      >
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
              {t("loyalty.pointsBalance")}
            </Text>
            <Text
              testID="loyalty-points-balance"
              style={{ color: Colors.primary, fontSize: 34, fontWeight: "900", marginTop: 2 }}
            >
              {account.pointsBalance.toLocaleString()}
            </Text>
          </View>
          <View style={{ alignItems: "flex-end" }}>
            <View
              testID="loyalty-tier-badge"
              style={{
                backgroundColor: tier.bg,
                borderRadius: 10,
                paddingHorizontal: 12,
                paddingVertical: 6,
                borderWidth: 1,
                borderColor: tier.border,
              }}
            >
              <Text style={{ fontWeight: "800", fontSize: 13, color: tier.fg }}>
                {tier.icon}{" "}
                {account.currentTier.charAt(0).toUpperCase() + account.currentTier.slice(1)}
              </Text>
            </View>
          </View>
        </View>
        <View style={{ flexDirection: "row", gap: 16 }}>
          <View>
            <Text
              style={{
                color: Colors.tabIconDefault,
                fontSize: 10,
                textTransform: "uppercase",
                letterSpacing: 0.5,
              }}
            >
              {t("loyalty.lifetimeEarned")}
            </Text>
            <Text style={{ color: "#fff", fontSize: 15, fontWeight: "700", marginTop: 2 }}>
              {account.lifetimePoints.toLocaleString()}
            </Text>
          </View>
          <View>
            <Text
              style={{
                color: Colors.tabIconDefault,
                fontSize: 10,
                textTransform: "uppercase",
                letterSpacing: 0.5,
              }}
            >
              {t("loyalty.thisYear")}
            </Text>
            <Text style={{ color: "#fff", fontSize: 15, fontWeight: "700", marginTop: 2 }}>
              {account.rollingYearPoints.toLocaleString()}
            </Text>
          </View>
        </View>
      </View>

      {rewards.length === 0 ? (
        <View
          testID="loyalty-rewards-empty"
          style={{
            backgroundColor: Colors.surface,
            borderRadius: 10,
            padding: 12,
            borderWidth: 1,
            borderColor: Colors.border,
          }}
        >
          <Text style={{ color: Colors.tabIconDefault, fontSize: 12 }}>
            {t("loyalty.noRewards")}
          </Text>
        </View>
      ) : (
        <View>
          <Text
            style={{
              color: Colors.tabIconDefault,
              fontSize: 11,
              textTransform: "uppercase",
              letterSpacing: 0.8,
              marginBottom: 8,
              marginLeft: 2,
            }}
          >
            {t("loyalty.availableRewards")}
          </Text>
          {rewards.map(reward => {
            const canAfford = account.pointsBalance >= reward.pointsCost;
            const rowStyle = {
              flexDirection: "row" as const,
              alignItems: "center" as const,
              backgroundColor: Colors.surface,
              borderRadius: 10,
              padding: 12,
              marginBottom: 8,
              borderWidth: 1,
              borderColor: canAfford ? `${Colors.primary}40` : Colors.border,
              opacity: canAfford ? 1 : 0.6,
            };
            const inner = (
              <>
                <Feather
                  name="gift"
                  size={18}
                  color={canAfford ? Colors.primary : Colors.tabIconDefault}
                  style={{ marginRight: 10 }}
                />
                <View style={{ flex: 1 }}>
                  <Text style={{ color: "#fff", fontSize: 13, fontWeight: "600" }}>
                    {reward.name}
                  </Text>
                  {reward.description ? (
                    <Text style={{ color: Colors.tabIconDefault, fontSize: 11, marginTop: 1 }}>
                      {reward.description}
                    </Text>
                  ) : null}
                </View>
                <View style={{ alignItems: "flex-end" }}>
                  <Text style={{ color: Colors.primary, fontSize: 13, fontWeight: "800" }}>
                    {reward.pointsCost.toLocaleString()} {t("loyalty.pts")}
                  </Text>
                  {!canAfford ? (
                    <Text style={{ color: Colors.tabIconDefault, fontSize: 10, marginTop: 1 }}>
                      {t("loyalty.needMore", {
                        count: (reward.pointsCost - account.pointsBalance).toLocaleString(),
                      })}
                    </Text>
                  ) : null}
                </View>
              </>
            );
            if (onSelectReward) {
              return (
                <TouchableOpacity
                  key={reward.id}
                  testID={`loyalty-reward-${reward.id}`}
                  activeOpacity={0.7}
                  onPress={() => onSelectReward(reward)}
                  style={rowStyle}
                >
                  {inner}
                </TouchableOpacity>
              );
            }
            return (
              <View key={reward.id} testID={`loyalty-reward-${reward.id}`} style={rowStyle}>
                {inner}
              </View>
            );
          })}
        </View>
      )}
    </View>
  );
}

export default LoyaltySection;
