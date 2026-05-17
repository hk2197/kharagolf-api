import { useQuery } from '@tanstack/react-query';

/**
 * Pre-fetches the IDs of users the current viewer already follows so
 * <FollowButton initialFollowing={...}> can hydrate as "Following"
 * instead of flashing "Follow" first (Task #1227).
 *
 * Backed by GET /api/portal/follows (artifacts/api-server/src/routes/
 * follows-status.ts). Shared across member-360, club-members, and the
 * players list so every member-facing surface stays consistent.
 */
export function useFolloweeIds(): number[] {
  const { data } = useQuery<{ followeeIds: number[] }>({
    queryKey: ['portal-follows-list'],
    queryFn: async () => {
      const res = await fetch('/api/portal/follows', { credentials: 'include' });
      if (!res.ok) return { followeeIds: [] };
      return res.json();
    },
    staleTime: 30 * 1000,
  });
  return data?.followeeIds ?? [];
}
