import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
  useFonts,
} from "@expo-google-fonts/inter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import React, { useEffect } from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { I18nextProvider } from "react-i18next";

import { ErrorBoundary } from "@/components/ErrorBoundary";
import NotificationsPoller from "@/components/NotificationsPoller";
import SponsorSplash from "@/components/SponsorSplash";
import { AuthProvider, useAuth } from "@/context/auth";
import { UnreadProvider } from "@/context/unread";
import { MoreBadgesProvider } from "@/context/moreBadges";
import { ActiveClubProvider } from "@/context/activeClub";
import { ActiveClubThemeProvider } from "@/theme";
import i18n, { applyLanguage, loadSavedLanguage } from "@/i18n";
import { registerBackgroundHealthSync } from "@/utils/backgroundHealthSync";
import { handleNotificationData } from "@/utils/handleNotificationData";
import { getNotificationsModule } from "@/utils/notificationsModule";
import {
  hydratePublicProfileHandleCache,
  subscribePublicProfileHandlePersistence,
} from "@/utils/publicProfileHandlePersistence";
import { reportPushOpened } from "@/utils/reportPushOpened";

// Set API base URL before any components render
// Local dev: point at the PC's Wi-Fi IP so the phone can reach the backend.
// In production this would use EXPO_PUBLIC_DOMAIN instead.
try {
  const { setBaseUrl } = require("@workspace/api-client-react");
  const domain = process.env.EXPO_PUBLIC_DOMAIN;
  if (domain) {
    setBaseUrl(`https://${domain}`);
  } else {
    // Local development — use the PC's LAN IP (backend on port 3001)
    setBaseUrl("http://192.168.1.3:3001");
  }
} catch {}

SplashScreen.preventAutoHideAsync();

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 30000 } },
});

// Exported so __tests__/notification-tap-e2e.test.tsx can mount just the
// notification-listener wiring (Task #1565) without the full provider tree.
export function RootLayoutNav() {
  // Deep-link routing for tapped push notifications lives in
  // `@/utils/handleNotificationData` so it can be unit-tested without
  // mounting the full root layout (see __tests__/handleNotificationData.test.ts).
  //
  // Task #1317 — every tap is also reported to the analytics pipeline via
  // `reportPushOpened` so the admin dashboard's `notification_opened` event
  // reflects mobile reach, not just web/portal in-app opens. Both entry
  // points (cold-start + warm-start) wire it up below.
  const { token } = useAuth();

  // Cold-start: handle the notification tap that launched the app from terminated state
  useEffect(() => {
    const Notifications = getNotificationsModule();
    if (!Notifications) return;
    Notifications.getLastNotificationResponseAsync().then((response) => {
      if (!response) return;
      const data = response.notification.request.content.data as Record<string, unknown> | undefined;
      void reportPushOpened({
        authToken: token,
        data,
        messageId: response.notification.request.identifier,
      });
      // Small delay to let the navigator mount before pushing
      setTimeout(() => handleNotificationData(data), 300);
    }).catch(() => {});
  }, [token]);

  // Warm-start: handle taps while the app is in foreground or background
  useEffect(() => {
    const Notifications = getNotificationsModule();
    if (!Notifications) return;
    const sub = Notifications.addNotificationResponseReceivedListener((response) => {
      const data = response.notification.request.content.data as Record<string, unknown> | undefined;
      void reportPushOpened({
        authToken: token,
        data,
        messageId: response.notification.request.identifier,
      });
      handleNotificationData(data);
    });
    return () => sub.remove();
  }, [token]);

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen name="(auth)" options={{ headerShown: false }} />
      <Stack.Screen name="peer-review/[token]" options={{ headerShown: false }} />
      <Stack.Screen name="ai-caddie" options={{ headerShown: false }} />
      <Stack.Screen name="caddie/pending" options={{ headerShown: false }} />
      <Stack.Screen
        name="badges"
        options={{
          headerShown: true,
          title: "Badges",
          headerStyle: { backgroundColor: "#0a0a0a" },
          headerTintColor: "#fff",
          headerTitleStyle: { fontWeight: "700" },
        }}
      />
      {/* Public profile viewer — also satisfies the kharagolf://profile/<handle>
          deep link advertised by /api/public/p/:handle (Task #1243). */}
      <Stack.Screen name="profile/[handle]" options={{ headerShown: false }} />
      {/* Task #2209 — native stuck-erasure cleanup panel so org-admin
          controllers can triage erasure storage failures without bouncing
          out to the web. Header is configured per-screen so this Stack
          entry inherits the default headerShown:false. */}
      <Stack.Screen name="erasure-cleanup" options={{ headerShown: false }} />
    </Stack>
  );
}

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
  });

  useEffect(() => {
    SplashScreen.hideAsync().catch(() => {});
  }, []);

  useEffect(() => {
    if (fontError) {
      console.warn("Font loading failed, using system fonts:", fontError.message);
    }
  }, [fontError]);

  useEffect(() => {
    loadSavedLanguage().then((lang) => {
      applyLanguage(lang).catch(() => {});
    }).catch(() => {});
  }, []);

  // Schedule the daily Apple Health background refresh once per app launch.
  // The task itself is iOS-only and a no-op when no player is signed in, so
  // it's safe to register unconditionally on boot.
  useEffect(() => {
    registerBackgroundHealthSync().catch(() => {});
  }, []);

  // Task #2235 — Hydrate the userId → public-handle cache from AsyncStorage
  // on cold launch and start mirroring future resolutions back to disk so
  // the next launch is instant too. Hydration runs unawaited; entries land
  // in React Query as soon as AsyncStorage answers, well before the first
  // leaderboard tap can navigate. See
  // utils/publicProfileHandlePersistence.ts for the contract.
  useEffect(() => {
    void hydratePublicProfileHandleCache(queryClient);
    const unsubscribe = subscribePublicProfileHandlePersistence(queryClient);
    return () => unsubscribe();
  }, []);

  return (
    <SafeAreaProvider>
      <ErrorBoundary>
        <I18nextProvider i18n={i18n}>
          <QueryClientProvider client={queryClient}>
            <AuthProvider>
              <ActiveClubProvider>
                <ActiveClubThemeProvider>
                  <UnreadProvider>
                    <MoreBadgesProvider>
                      <NotificationsPoller />
                      <GestureHandlerRootView style={{ flex: 1 }}>
                        <KeyboardProvider>
                          <RootLayoutNav />
                          <SponsorSplash />
                        </KeyboardProvider>
                      </GestureHandlerRootView>
                    </MoreBadgesProvider>
                  </UnreadProvider>
                </ActiveClubThemeProvider>
              </ActiveClubProvider>
            </AuthProvider>
          </QueryClientProvider>
        </I18nextProvider>
      </ErrorBoundary>
    </SafeAreaProvider>
  );
}
