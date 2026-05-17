import React from "react";
import { Stack } from "expo-router";
import Colors from "@/constants/colors";

export default function My360Layout() {
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: Colors.background },
        headerTintColor: "#fff",
        headerTitleStyle: { fontWeight: "700" },
        contentStyle: { backgroundColor: Colors.background },
      }}
    >
      <Stack.Screen name="index" options={{ title: "My 360°" }} />
      <Stack.Screen name="documents" options={{ title: "My Documents" }} />
      <Stack.Screen name="consents" options={{ title: "Consents" }} />
      <Stack.Screen name="communications" options={{ title: "Communication preferences" }} />
      <Stack.Screen name="notification-audit" options={{ title: "Suppressed notifications" }} />
      <Stack.Screen name="family" options={{ title: "Family Switcher" }} />
      <Stack.Screen name="statement" options={{ title: "Statement" }} />
      <Stack.Screen name="payment-history" options={{ title: "Payment history" }} />
      <Stack.Screen name="milestones" options={{ title: "Milestones" }} />
      <Stack.Screen name="privacy" options={{ title: "Privacy" }} />
    </Stack>
  );
}
