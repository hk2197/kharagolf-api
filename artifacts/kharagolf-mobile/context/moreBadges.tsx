import AsyncStorage from "@react-native-async-storage/async-storage";
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AppState, type AppStateStatus } from "react-native";
import { useAuth } from "@/context/auth";
import { useActiveClub } from "@/context/activeClub";
import { getExpoNotifications } from "@/utils/expoNotifications";

const BASE_URL = process.env.EXPO_PUBLIC_DOMAIN
  ? `https://${process.env.EXPO_PUBLIC_DOMAIN}`
  : "";

// Slow safety-net poll. Real-time updates arrive via the
// expo-notifications listener below — a relevant push refreshes the
// counts within ~1s of delivery — so the polling interval only needs
// to cover the rare case where a push is silenced/dropped by the OS
// or the count was changed by something that does *not* emit a push
// (e.g. a new feed post). Mirrors the cadence used by
// `NotificationsPoller` for the bottom-tab notifications badge.
const POLL_INTERVAL_MS = 5 * 60_000;

const ANNOUNCEMENTS_LAST_SEEN_KEY = "kharagolf_updates_last_seen";
const FEED_LAST_SEEN_KEY = "kharagolf_feed_last_seen";

// Push `data.type` values that may change one of the badge counts
// returned by `/api/portal/badge-counts`. When one of these arrives we
// refetch immediately so the badge updates within ~1s of the push
// landing instead of waiting up to `POLL_INTERVAL_MS` for the next
// safety-net tick.
//
// Anything not in this set is ignored — incoming pushes for shop
// orders, score events, scheduled tee times, etc. would otherwise
// trigger pointless badge refetches that don't actually change the
// counts.
const BADGE_PUSH_TYPES = new Set<string>([
  // Handicap-committee notifications inbox (`notifications` count) and
  // peer-review invites (`peerInvites`, rolled into `updates`).
  "handicap_case_update",
  "handicap_peer_review",
  "handicap_peer_response",
  // Notice-board article published (`notices`, rolled into `updates`).
  "notice_board",
  // Tournament announcement broadcast — `sendBroadcast()` tags pushes
  // with `type:"broadcast"` when posting a tournament announcement,
  // which bumps `announcements` (rolled into `updates`).
  "broadcast",
  // Wallet-pending withdrawals & payout-account attention
  // (`walletPending`).
  "wallet_withdrawal_processed",
  "wallet_withdrawal_failed",
  "wallet_payout_account_needs_attention",
  "wallet_topup_auto_refund",
  // New social-feed post (`feed`). Task #1697 — the API server now fans
  // out a `feed_post` push to every other org member when a teammate
  // publishes a new post via `POST /organizations/:orgId/feed/posts`,
  // so the red dot on the Feed row appears within ~1s instead of
  // waiting up to 5 minutes for the next safety-net poll.
  "feed_post",
]);

export interface MoreBadgeCounts {
  notifications: number;
  feed: number;
  updates: number;
  wallet: number;
}

interface MoreBadgesContextValue {
  counts: MoreBadgeCounts;
  total: number;
  refresh: () => void;
  markFeedSeen: () => Promise<void>;
  /**
   * Register the calling component as an "active viewer" of the badge
   * counts. The provider only polls `/api/portal/badge-counts` while
   * at least one viewer is registered. Returns a cleanup that
   * deregisters. Prefer the `useBadgePolling()` hook which wires this
   * into a component's mount/unmount lifecycle for you.
   */
  subscribe: () => () => void;
}

const ZERO: MoreBadgeCounts = { notifications: 0, feed: 0, updates: 0, wallet: 0 };

const MoreBadgesContext = createContext<MoreBadgesContextValue | null>(null);

interface BadgeCountsResponse {
  notifications?: number;
  announcements?: number;
  peerInvites?: number;
  notices?: number;
  feedSinceTs?: number;
  walletPending?: number;
}

async function safeJson<T>(res: Response): Promise<T | null> {
  if (!res.ok) return null;
  try {
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export function MoreBadgesProvider({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, token, user } = useAuth();
  const { activeOrgId } = useActiveClub();
  const orgId = activeOrgId ?? user?.organizationId ?? null;

  const [counts, setCounts] = useState<MoreBadgeCounts>(ZERO);
  // Number of mounted components that actually display a badge value.
  // Polling is gated on this being > 0 so an idle device with no
  // visible badges does not hit `/api/portal/badge-counts` on every
  // safety-net tick.
  const [subscriberCount, setSubscriberCount] = useState(0);
  const tickRef = useRef(0);

  const fetchAll = useCallback(async () => {
    if (!isAuthenticated || !token) {
      setCounts(ZERO);
      return;
    }
    const myTick = ++tickRef.current;

    // Read both client-side last-seen markers up front and forward them so
    // the server can compute "new since" counts in the same round-trip.
    const [annLastSeenRaw, feedLastSeenRaw] = await Promise.all([
      AsyncStorage.getItem(ANNOUNCEMENTS_LAST_SEEN_KEY).catch(() => null),
      AsyncStorage.getItem(FEED_LAST_SEEN_KEY).catch(() => null),
    ]);
    const annLastSeen = annLastSeenRaw ? parseInt(annLastSeenRaw, 10) || 0 : 0;
    const feedLastSeen = feedLastSeenRaw ? parseInt(feedLastSeenRaw, 10) || 0 : 0;

    const params = new URLSearchParams();
    if (orgId) params.set("orgId", String(orgId));
    if (annLastSeen > 0) params.set("announcementsSince", String(annLastSeen));
    if (feedLastSeen > 0) params.set("feedSince", String(feedLastSeen));
    const qs = params.toString();
    const url = `${BASE_URL}/api/portal/badge-counts${qs ? `?${qs}` : ""}`;

    const json = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => safeJson<BadgeCountsResponse>(r))
      .catch(() => null);

    // If a newer fetch started while this one was in flight, drop our result.
    if (myTick !== tickRef.current) return;

    if (!json) {
      setCounts(ZERO);
      return;
    }

    const notifications = Math.max(0, json.notifications ?? 0);
    const announcements = Math.max(0, json.announcements ?? 0);
    const peerInvites = Math.max(0, json.peerInvites ?? 0);
    const notices = Math.max(0, json.notices ?? 0);
    const feed = Math.max(0, json.feedSinceTs ?? 0);
    const wallet = Math.max(0, json.walletPending ?? 0);

    setCounts({
      notifications,
      feed,
      updates: announcements + peerInvites + notices,
      wallet,
    });
  }, [isAuthenticated, token, orgId]);

  // Reset to zero the moment auth goes away — covers logout while
  // there are still subscribers mounted.
  useEffect(() => {
    if (!isAuthenticated || !token) setCounts(ZERO);
  }, [isAuthenticated, token]);

  // Poll while signed in AND at least one component is actually
  // rendering a badge value. Otherwise an idle device sitting on the
  // login screen, in a modal, or backgrounded would still hit the
  // endpoint on every interval tick.
  //
  // Real-time path: while subscribed we also listen on the
  // expo-notifications channel and refetch the moment a
  // badge-relevant push lands (see `BADGE_PUSH_TYPES`). That makes
  // new notifications, peer invites, announcements, notice-board
  // articles, and wallet events surface within ~1s instead of
  // waiting up to `POLL_INTERVAL_MS` for the next tick.
  useEffect(() => {
    if (!isAuthenticated || !token) return;
    if (subscriberCount <= 0) return;

    // First subscribe (or auth/orgId change) — fetch immediately so
    // navigating to the More menu shows fresh counts without waiting
    // for the next interval tick.
    void fetchAll();

    const id = setInterval(() => { void fetchAll(); }, POLL_INTERVAL_MS);
    const sub = AppState.addEventListener("change", (s: AppStateStatus) => {
      if (s === "active") void fetchAll();
    });

    // Live push channel: refresh the badge as soon as a
    // badge-relevant push arrives. Fires for foreground notifications
    // and (on iOS) for notifications delivered while the app is in
    // the background. Mirrors the pattern in `NotificationsPoller`.
    // The lazy accessor returns `null` in environments where
    // expo-notifications is unavailable (e.g. Android Expo Go), in
    // which case we just skip the listener and fall back to polling.
    const Notifications = getExpoNotifications();
    const pushSub = Notifications?.addNotificationReceivedListener((notification) => {
      const data = notification?.request?.content?.data as
        | Record<string, unknown>
        | undefined;
      const type = typeof data?.type === "string" ? (data.type as string) : "";
      if (BADGE_PUSH_TYPES.has(type)) void fetchAll();
    });

    return () => {
      clearInterval(id);
      sub.remove();
      pushSub?.remove();
    };
  }, [fetchAll, isAuthenticated, token, subscriberCount]);

  const subscribe = useCallback(() => {
    setSubscriberCount((n) => n + 1);
    return () => setSubscriberCount((n) => Math.max(0, n - 1));
  }, []);

  const markFeedSeen = useCallback(async () => {
    const now = Date.now();
    try { await AsyncStorage.setItem(FEED_LAST_SEEN_KEY, String(now)); } catch {}
    setCounts((c) => (c.feed === 0 ? c : { ...c, feed: 0 }));
  }, []);

  // Stable identity so consumers (e.g. useFocusEffect callbacks that depend
  // on this) don't re-fire whenever counts/total change.
  const refresh = useCallback(() => { void fetchAll(); }, [fetchAll]);

  const total = counts.notifications + counts.feed + counts.updates + counts.wallet;

  const value = useMemo<MoreBadgesContextValue>(() => ({
    counts,
    total,
    refresh,
    markFeedSeen,
    subscribe,
  }), [counts, total, refresh, markFeedSeen, subscribe]);

  return <MoreBadgesContext.Provider value={value}>{children}</MoreBadgesContext.Provider>;
}

export function useMoreBadges(): MoreBadgesContextValue {
  const ctx = useContext(MoreBadgesContext);
  if (!ctx) throw new Error("useMoreBadges must be used inside MoreBadgesProvider");
  return ctx;
}

/**
 * Mark the calling component as a viewer of the badge counts.
 *
 * The `MoreBadgesProvider` only polls `/api/portal/badge-counts` while
 * at least one viewer is mounted. Call this from any screen that
 * actually renders a badge value (the bottom tab bar, the More menu),
 * not from screens that only call `refresh` or `markFeedSeen`.
 *
 * Polling starts immediately on the first subscriber (so the More
 * menu shows up-to-date counts the moment the user opens it) and
 * stops as soon as the last subscriber unmounts.
 */
export function useBadgePolling(): void {
  // Depend on the stable `subscribe` reference (created once via
  // useCallback in the provider) rather than the whole context value,
  // which rebuilds every time the badge counts update. Otherwise the
  // effect would tear down and re-subscribe on every successful fetch
  // — harmless but noisy.
  const subscribe = useContext(MoreBadgesContext)?.subscribe;
  useEffect(() => {
    if (!subscribe) return;
    return subscribe();
  }, [subscribe]);
}
