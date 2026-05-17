import React, { useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, Alert } from "react-native";
import { Feather } from "@expo/vector-icons";
import Colors from "@/constants/colors";
import { useAuth } from "@/context/auth";
import { postPortal, deletePortal } from "@/utils/api";

interface FollowButtonProps {
  userId: number;
  initialFollowing?: boolean;
  size?: "sm" | "md";
}

export function FollowButton({ userId, initialFollowing = false, size = "sm" }: FollowButtonProps) {
  const { token } = useAuth();
  const [following, setFollowing] = useState(initialFollowing);
  const [loading, setLoading] = useState(false);

  useEffect(() => { setFollowing(initialFollowing); }, [initialFollowing]);

  const toggle = async () => {
    if (!token) {
      Alert.alert("Sign in required", "Please sign in to follow other members.");
      return;
    }
    setLoading(true);
    try {
      if (following) {
        await deletePortal(`/follows/${userId}`, token);
        setFollowing(false);
      } else {
        await postPortal(`/follows/${userId}`, token, {});
        setFollowing(true);
      }
    } catch (e) {
      Alert.alert("Could not update follow", e instanceof Error ? e.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  };

  const isSm = size === "sm";
  return (
    <TouchableOpacity
      onPress={toggle}
      disabled={loading}
      testID={`follow-button-${userId}`}
      style={[
        styles.btn,
        isSm ? styles.sm : styles.md,
        following ? styles.outline : styles.solid,
      ]}
    >
      {loading ? (
        <ActivityIndicator size="small" color={following ? Colors.primary : "#fff"} />
      ) : (
        <Feather
          name={following ? "user-check" : "user-plus"}
          size={isSm ? 14 : 18}
          color={following ? Colors.primary : "#fff"}
        />
      )}
      <Text style={[styles.label, isSm && styles.labelSm, following ? styles.labelOutline : styles.labelSolid]}>
        {following ? "Following" : "Follow"}
      </Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  btn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center",
    gap: 6, borderRadius: 999, borderWidth: 1,
  },
  sm: { paddingHorizontal: 10, paddingVertical: 5 },
  md: { paddingHorizontal: 16, paddingVertical: 9 },
  solid: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  outline: { backgroundColor: "transparent", borderColor: Colors.primary },
  label: { fontWeight: "600" },
  labelSm: { fontSize: 12 },
  labelSolid: { color: "#fff" },
  labelOutline: { color: Colors.primary },
});
