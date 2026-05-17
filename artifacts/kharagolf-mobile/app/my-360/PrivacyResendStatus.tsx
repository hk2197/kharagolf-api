import React, { useEffect, useState } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import { Feather } from "@expo/vector-icons";
import Colors from "@/constants/colors";
import {
  CooldownRequest,
  canResend,
  channelNeedsRetry,
  cooldownRemainingMs,
  formatCooldown,
} from "./privacy-cooldown";

export interface PrivacyResendStatusProps {
  request: CooldownRequest;
  resending: boolean;
  onResend: () => void;
}

export function PrivacyResendStatus({ request, resending, onResend }: PrivacyResendStatusProps) {
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const inCooldown = !channelNeedsRetry(request) && cooldownRemainingMs(request, nowMs) > 0;

  useEffect(() => {
    if (!inCooldown) return;
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [inCooldown]);

  if (canResend(request, nowMs)) {
    return (
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel="Resend acknowledgement"
        style={styles.resendBtn}
        onPress={onResend}
        activeOpacity={0.75}
        disabled={resending}
      >
        {resending ? (
          <LoadingSpinner color="#fff" />
        ) : (
          <>
            <Feather name="refresh-cw" size={14} color="#fff" />
            <Text style={styles.resendBtnText}>Resend acknowledgement</Text>
          </>
        )}
      </TouchableOpacity>
    );
  }

  const remaining = cooldownRemainingMs(request, nowMs);
  if (remaining > 0) {
    return (
      <View style={styles.cooldownHint} accessibilityRole="text">
        <Feather name="clock" size={12} color={Colors.tabIconDefault} />
        <Text style={styles.cooldownHintText}>
          Available again in {formatCooldown(remaining)}
        </Text>
      </View>
    );
  }

  return null;
}

const styles = StyleSheet.create({
  resendBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    backgroundColor: Colors.primary,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
    marginTop: 10,
  },
  resendBtnText: { color: "#fff", fontSize: 12, fontWeight: "700" },
  cooldownHint: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    marginTop: 10,
    paddingVertical: 6,
  },
  cooldownHintText: { color: Colors.tabIconDefault, fontSize: 11, fontStyle: "italic" },
});
