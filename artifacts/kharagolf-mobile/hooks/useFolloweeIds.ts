import { useCallback, useEffect, useState } from "react";
import { fetchPortal } from "@/utils/api";

/**
 * Pre-fetches the IDs of users the current viewer already follows so
 * <FollowButton initialFollowing={...}> can hydrate as "Following"
 * instead of flashing "Follow" first (Task #1227).
 *
 * Backed by GET /api/portal/follows (artifacts/api-server/src/routes/
 * follows-status.ts). Shared between the public member profile screen
 * (app/member/[userId].tsx) and the social feed (app/(tabs)/feed.tsx)
 * so every member-facing surface uses the same pre-fetch pattern.
 *
 * Best-effort: a network failure leaves the list empty so
 * <FollowButton> still works in its un-hydrated state.
 */
export function useFolloweeIds(token: string | null | undefined): {
  followeeIds: number[];
  loading: boolean;
  refresh: () => void;
} {
  const [followeeIds, setFolloweeIds] = useState<number[]>([]);
  const [loading, setLoading] = useState<boolean>(!!token);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    if (!token) {
      setFolloweeIds([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    (async () => {
      try {
        const res = await fetchPortal<{ followeeIds: number[] }>("/follows", token);
        if (!cancelled) setFolloweeIds(res.followeeIds ?? []);
      } catch {
        if (!cancelled) setFolloweeIds([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token, tick]);

  // Keep `refresh` referentially stable so callers can safely include it
  // in useEffect / useFocusEffect dependency arrays without re-firing on
  // every render.
  const refresh = useCallback(() => setTick(t => t + 1), []);

  return { followeeIds, loading, refresh };
}
