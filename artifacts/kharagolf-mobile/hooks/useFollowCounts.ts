import { useQuery } from "@tanstack/react-query";
import { fetchPortal } from "@/utils/api";

/**
 * Task #2153 — Aggregate follower / following counts for an arbitrary
 * member, surfaced on the in-app authenticated member profile screen
 * (`app/member/[userId].tsx`) alongside the existing Follow button.
 *
 * Backed by `GET /api/portal/follows/count/:userId` which returns
 * `{ userId, followerCount, followingCount }`. When the viewer is the
 * profile owner the counts match what `/my-follows` shows them.
 *
 * The query is disabled (and therefore never fires) when the userId or
 * auth token are missing — same defensive behaviour the FollowButton
 * uses to avoid hitting the API for malformed route params.
 */
const STALE_TIME_MS = 60 * 1000; // 1 minute — keeps repeat profile taps snappy

export interface FollowCounts {
  userId: number;
  followerCount: number;
  followingCount: number;
}

export function followCountsQueryKey(userId: number) {
  return ["portal-follows-count", userId] as const;
}

export function useFollowCounts(userId: number, token: string | null | undefined) {
  const enabled = Number.isFinite(userId) && userId > 0 && !!token;
  return useQuery({
    queryKey: followCountsQueryKey(userId),
    queryFn: async () => {
      const json = await fetchPortal<Partial<FollowCounts>>(
        `/follows/count/${userId}`,
        token as string,
      );
      return {
        userId: Number(json.userId) || userId,
        followerCount: Number(json.followerCount) || 0,
        followingCount: Number(json.followingCount) || 0,
      } as FollowCounts;
    },
    enabled,
    staleTime: STALE_TIME_MS,
    retry: false,
  });
}
