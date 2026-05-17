import React, { createContext, useContext, useEffect, useState, useCallback } from "react";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
import { applyLanguage, type SupportedLanguage } from "@/i18n";
import { clearActingMemberId } from "@/app/my-360/_shared";
import { registerBackgroundHealthSync, unregisterBackgroundHealthSync } from "@/utils/backgroundHealthSync";
import { clearAllCoachDrawingClipboards } from "@/utils/coachDrawingClipboard";

// expo-notifications is removed from Expo Go on Android (SDK 53+).
// Lazy-load to avoid invariant violations in Expo Go.
type NotificationsType = typeof import("expo-notifications");
let NotificationsModule: NotificationsType | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  NotificationsModule = require("expo-notifications");
  // Configure how notifications appear when the app is foregrounded.
  // Guard with try/catch because setNotificationHandler may also throw on unsupported runtimes.
  try {
    NotificationsModule.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowAlert: true,
        shouldPlaySound: true,
        shouldSetBadge: false,
        shouldShowBanner: true,
        shouldShowList: true,
      }),
    });
  } catch { /* handler setup unavailable */ }
} catch { /* expo-notifications unavailable in Expo Go on Android SDK 53+ */ }

const TOKEN_KEY = "kharagolf_player_token";
const USER_KEY = "kharagolf_player_user";

const BASE_URL = process.env.EXPO_PUBLIC_DOMAIN
  ? `https://${process.env.EXPO_PUBLIC_DOMAIN}`
  : "";

export interface PlayerUser {
  id: number;
  email?: string;
  displayName?: string;
  username: string;
  profileImage?: string;
  role: string;
  organizationId?: number;
  /**
   * Org ids in which this user has a membership-derived member-admin
   * role (org_admin / membership_secretary / treasurer in
   * `org_memberships`). Server-supplied on `/portal/me` so the home
   * screen's stuck-erasure backlog widget (Task #2210) — and any
   * future member-360 controller surface — can gate via the shared
   * `@workspace/member-admin-roles` `isMemberAdmin` helper instead of
   * relying on the widget's 401/403 self-hide. Optional so cached
   * `me` payloads from older server builds don't break typing.
   */
  memberAdminOrgIds?: number[];
  emailVerified?: boolean;
  isLocalAuth?: boolean;
  preferredLanguage?: string;
}

interface AuthContextValue {
  token: string | null;
  user: PlayerUser | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  login: (email: string, password: string) => Promise<void>;
  loginWithGoogle: (idToken: string) => Promise<void>;
  loginWithApple: (identityToken: string, fullName?: { givenName?: string | null; familyName?: string | null }) => Promise<void>;
  register: (firstName: string, lastName: string, email: string, password: string) => Promise<{ message: string; emailDelivered?: boolean }>;
  logout: () => Promise<void>;
  forgotPassword: (email: string) => Promise<{ message: string }>;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

async function secureSet(key: string, value: string) {
  if (Platform.OS === "web") {
    localStorage.setItem(key, value);
  } else {
    await SecureStore.setItemAsync(key, value);
  }
}

async function secureGet(key: string): Promise<string | null> {
  if (Platform.OS === "web") {
    return localStorage.getItem(key);
  }
  return SecureStore.getItemAsync(key);
}

async function secureDelete(key: string) {
  if (Platform.OS === "web") {
    localStorage.removeItem(key);
  } else {
    await SecureStore.deleteItemAsync(key);
  }
}

async function apiFetch<T>(path: string, options?: RequestInit, token?: string): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-client-type": "mobile",
    ...(options?.headers as Record<string, string>),
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(`${BASE_URL}/api${path}`, { ...options, headers });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? `API error ${res.status}`);
  return data as T;
}

/**
 * Request notification permissions and register the Expo push token with the backend.
 * Safe to call multiple times — silently no-ops on web or permission denial.
 */
const PUSH_TOKEN_KEY = "kharagolf_push_token";

async function registerPushToken(authToken: string): Promise<void> {
  if (Platform.OS === "web" || !NotificationsModule) return;
  try {
    const { status: existingStatus } = await NotificationsModule.getPermissionsAsync();
    let finalStatus = existingStatus;
    if (existingStatus !== "granted") {
      const { status } = await NotificationsModule.requestPermissionsAsync();
      finalStatus = status;
    }
    if (finalStatus !== "granted") return;

    const pushToken = await NotificationsModule.getExpoPushTokenAsync();
    const res = await fetch(`${BASE_URL}/api/portal/push/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
        "x-client-type": "mobile",
      },
      body: JSON.stringify({ token: pushToken.data, platform: "expo" }),
    });
    if (!res.ok) {
      console.warn("[push] Push token registration failed with status", res.status);
      return;
    }
    await secureSet(PUSH_TOKEN_KEY, pushToken.data);
  } catch (err) {
    console.warn("[push] Failed to register push token:", err);
  }
}

async function unregisterPushToken(authToken: string): Promise<void> {
  if (Platform.OS === "web") return;
  try {
    const storedPushToken = await secureGet(PUSH_TOKEN_KEY);
    if (!storedPushToken) return;
    const unregRes = await fetch(`${BASE_URL}/api/portal/push/unregister`, {
      method: "DELETE",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
        "x-client-type": "mobile",
      },
      body: JSON.stringify({ token: storedPushToken }),
    });
    if (!unregRes.ok) {
      console.warn("[push] Push token unregister responded with status", unregRes.status);
    }
    // Always clear locally — the token is invalidated on logout regardless of server response
    await secureDelete(PUSH_TOKEN_KEY);
  } catch (err) {
    console.warn("[push] Failed to unregister push token:", err);
  }
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<PlayerUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const refreshUser = useCallback(async () => {
    const storedToken = await secureGet(TOKEN_KEY);
    if (!storedToken) return;
    try {
      const me = await apiFetch<PlayerUser>("/portal/me", undefined, storedToken);
      setUser(me);
      await secureSet(USER_KEY, JSON.stringify(me));
    } catch {
      // Token may be expired — clear it
      await secureDelete(TOKEN_KEY);
      await secureDelete(USER_KEY);
      await clearActingMemberId();
      setToken(null);
      setUser(null);
    }
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const storedToken = await secureGet(TOKEN_KEY);
        const storedUser = await secureGet(USER_KEY);
        if (storedToken) {
          setToken(storedToken);
          if (storedUser) setUser(JSON.parse(storedUser));
          // Validate token is still alive
          try {
            const me = await apiFetch<PlayerUser>("/portal/me", undefined, storedToken);
            setUser(me);
            await secureSet(USER_KEY, JSON.stringify(me));
            // Apply user's language preference on boot
            if (me.preferredLanguage) {
              void applyLanguage(me.preferredLanguage as SupportedLanguage);
            }
            // Re-register push token on each app boot (token may change)
            void registerPushToken(storedToken);
          } catch {
            await secureDelete(TOKEN_KEY);
            await secureDelete(USER_KEY);
            await clearActingMemberId();
            setToken(null);
            setUser(null);
          }
        }
      } finally {
        setIsLoading(false);
      }
    })();
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const data = await apiFetch<{ token: string; user: PlayerUser }>("/auth/player-login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    await secureSet(TOKEN_KEY, data.token);
    await secureSet(USER_KEY, JSON.stringify(data.user));
    setToken(data.token);
    setUser(data.user);
    // Apply user's language preference on login
    if (data.user.preferredLanguage) {
      void applyLanguage(data.user.preferredLanguage as SupportedLanguage);
    }
    // Request notification permission and register push token after login
    void registerPushToken(data.token);
    // Re-arm the daily Apple Health background refresh — covers the case
    // where the player logs out and back in without relaunching the app.
    void registerBackgroundHealthSync();
  }, []);

  const finishSocialLogin = useCallback(async (data: { token: string; user: PlayerUser }) => {
    await secureSet(TOKEN_KEY, data.token);
    await secureSet(USER_KEY, JSON.stringify(data.user));
    setToken(data.token);
    setUser(data.user);
    if (data.user.preferredLanguage) {
      void applyLanguage(data.user.preferredLanguage as SupportedLanguage);
    }
    void registerPushToken(data.token);
    void registerBackgroundHealthSync();
  }, []);

  const loginWithGoogle = useCallback(async (idToken: string) => {
    const data = await apiFetch<{ token: string; user: PlayerUser }>("/auth/google", {
      method: "POST",
      body: JSON.stringify({ idToken }),
    });
    await finishSocialLogin(data);
  }, [finishSocialLogin]);

  const loginWithApple = useCallback(async (
    identityToken: string,
    fullName?: { givenName?: string | null; familyName?: string | null },
  ) => {
    const data = await apiFetch<{ token: string; user: PlayerUser }>("/auth/apple", {
      method: "POST",
      body: JSON.stringify({
        identityToken,
        fullName: fullName
          ? { givenName: fullName.givenName ?? undefined, familyName: fullName.familyName ?? undefined }
          : undefined,
      }),
    });
    await finishSocialLogin(data);
  }, [finishSocialLogin]);

  const register = useCallback(async (firstName: string, lastName: string, email: string, password: string) => {
    return apiFetch<{ message: string; emailDelivered?: boolean }>("/auth/player-register", {
      method: "POST",
      body: JSON.stringify({ firstName, lastName, email, password }),
    });
  }, []);

  const logout = useCallback(async () => {
    const storedToken = await secureGet(TOKEN_KEY);
    if (storedToken) {
      try {
        await unregisterPushToken(storedToken);
      } catch { /* ignore */ }
      try {
        await apiFetch("/auth/player-logout", { method: "POST" }, storedToken);
      } catch { /* ignore */ }
    }
    await secureDelete(TOKEN_KEY);
    await secureDelete(USER_KEY);
    await clearActingMemberId();
    // Task #2130 — wipe every persisted coach drawing clipboard so a
    // shared phone does not leave one coach's callout pattern on disk
    // for the next coach who logs in.
    try {
      await clearAllCoachDrawingClipboards();
    } catch { /* best-effort */ }
    // Stop waking the app for HealthKit syncs once the player is signed out.
    void unregisterBackgroundHealthSync();
    setToken(null);
    setUser(null);
  }, []);

  const forgotPassword = useCallback(async (email: string) => {
    return apiFetch<{ message: string }>("/auth/forgot-password", {
      method: "POST",
      body: JSON.stringify({ email }),
    });
  }, []);

  return (
    <AuthContext.Provider value={{ token, user, isLoading, isAuthenticated: !!token && !!user, login, loginWithGoogle, loginWithApple, register, logout, forgotPassword, refreshUser }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
