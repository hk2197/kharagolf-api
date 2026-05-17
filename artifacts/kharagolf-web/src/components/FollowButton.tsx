import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Loader2, UserPlus, UserCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';

interface FollowButtonProps {
  userId: number;
  initialFollowing?: boolean;
  size?: 'default' | 'sm';
}

export function FollowButton({ userId, initialFollowing = false, size = 'sm' }: FollowButtonProps) {
  const [following, setFollowing] = useState(initialFollowing);
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  useEffect(() => {
    setFollowing(initialFollowing);
  }, [initialFollowing]);

  const toggle = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/portal/follows/${userId}`, {
        method: following ? 'DELETE' : 'POST',
        credentials: 'include',
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      setFollowing(!following);
      // Invalidate the shared portal follow list so every consumer of
      // useFolloweeIds (spectator "Following" section, leaderboard
      // followed-row pill, member-360, players, club-members, my-follows)
      // re-fetches and stays in sync within the same page session — no
      // reload needed (Task #2142).
      queryClient.invalidateQueries({ queryKey: ['portal-follows-list'] });
      // Also invalidate the my-follows page's tab queries so the
      // Following row + per-list count + page-header badge update
      // instantly after Unfollow / Follow, without needing a tab switch
      // or page reload (Task #2183). These keys aren't present on other
      // pages — `invalidateQueries` against a missing key is a no-op,
      // so this is safe to fire from every FollowButton mount.
      queryClient.invalidateQueries({ queryKey: ['/api/portal/follows/list'] });
      queryClient.invalidateQueries({ queryKey: ['/api/portal/followers'] });
    } catch (err) {
      toast({
        title: 'Could not update follow',
        description: err instanceof Error ? err.message : 'Unknown error',
        variant: 'destructive',
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Button
      type="button"
      size={size}
      variant={following ? 'outline' : 'default'}
      onClick={toggle}
      disabled={loading}
      data-testid={`button-follow-${userId}`}
      className="gap-1.5"
    >
      {loading ? (
        <Loader2 className="w-3.5 h-3.5 animate-spin" />
      ) : following ? (
        <UserCheck className="w-3.5 h-3.5" />
      ) : (
        <UserPlus className="w-3.5 h-3.5" />
      )}
      {following ? 'Following' : 'Follow'}
    </Button>
  );
}
