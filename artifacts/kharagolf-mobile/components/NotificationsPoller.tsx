import { useEffect, useRef } from "react";
import { AppState, type AppStateStatus } from "react-native";
import { useAuth } from "@/context/auth";
import { useUnread } from "@/context/unread";
import { fetchPortal } from "@/utils/api";
import { getExpoNotifications } from "@/utils/expoNotifications";

// Slow safety-net refresh — covers the rare case where a push is dropped
// (silenced by the OS, no network at delivery time, etc.). Real-time
// updates arrive via the expo-notifications listener below, so this
// interval can be very long without making the badge feel stale.
const SAFETY_NET_INTERVAL_MS = 5 * 60_000;

// Push `data.type` values that may change the handicap-committee unread
// count. When one of these arrives we refresh the badge immediately so it
// reflects the new event within ~1s of delivery.
const HANDICAP_PUSH_TYPES = new Set<string>([
  "handicap_case_update",
  "handicap_peer_review",
]);

interface UnreadResponse {
  unreadCount: number;
}

/**
 * Keeps the bottom-tab notifications badge fresh.
 *
 * Real-time path: subscribes to incoming push notifications and refreshes
 * the badge the instant a handicap-committee push lands (foreground or
 * background-delivered while the app is open). This makes the badge
 * update within ~1s of a new event instead of the previous 30s poll.
 *
 * Safety net: a 5-minute background fetch and a refresh on every
 * foreground transition / cold start cover the rare case where a push is
 * silenced or dropped by the OS.
 */
export default function NotificationsPoller() {
  const { token, isAuthenticated } = useAuth();
  const { setNotifUnreadCount } = useUnread();
  const tokenRef = useRef<string | null>(null);
  tokenRef.current = isAuthenticated && token ? token : null;

  useEffect(() => {
    let cancelled = false;

    async function tick() {
      const t = tokenRef.current;
      if (!t) {
        if (!cancelled) setNotifUnreadCount(0);
        return;
      }
      try {
        const json = await fetchPortal<UnreadResponse>("/handicap/notifications", t);
        if (!cancelled) setNotifUnreadCount(json?.unreadCount ?? 0);
      } catch {
        /* network blips: keep last-known badge */
      }
    }

    tick();
    const interval = setInterval(tick, SAFETY_NET_INTERVAL_MS);

    const appStateSub = AppState.addEventListener("change", (state: AppStateStatus) => {
      if (state === "active") tick();
    });

    // Live push channel: refresh the badge as soon as a handicap-committee
    // push arrives. Fires for foreground notifications and (on iOS) for
    // notifications delivered while the app is in the background.
    const Notifications = getExpoNotifications();
    const pushSub = Notifications?.addNotificationReceivedListener((notification) => {
      const data = notification?.request?.content?.data as
        | Record<string, unknown>
        | undefined;
      const type = typeof data?.type === "string" ? (data.type as string) : "";
      if (HANDICAP_PUSH_TYPES.has(type)) tick();
    });

    return () => {
      cancelled = true;
      clearInterval(interval);
      appStateSub.remove();
      pushSub?.remove();
    };
  }, [isAuthenticated, token, setNotifUnreadCount]);

  return null;
}
