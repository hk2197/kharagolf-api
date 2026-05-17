import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useGetMe } from '@workspace/api-client-react';
import { Link } from 'wouter';
import { Users, UserPlus, Loader2, ArrowLeft } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { FollowButton } from '@/components/FollowButton';
import { useFolloweeIds } from '@/hooks/useFolloweeIds';

const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');

interface FollowListItem {
  userId: number;
  username: string;
  displayName: string | null;
  profileImage: string | null;
  followedAt: string;
}

interface FollowListResponse {
  items: FollowListItem[];
  total: number;
  limit: number;
  offset: number;
}

const PAGE_SIZE = 50;

function initialsOf(name: string | null, username: string): string {
  const source = (name ?? username ?? '').trim();
  if (!source) return '?';
  const parts = source.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function FollowList({
  endpoint,
  emptyTitle,
  emptyHint,
  showUnfollowOnly,
  followeeIds,
  testIdPrefix,
}: {
  endpoint: string;
  emptyTitle: string;
  emptyHint: string;
  showUnfollowOnly: boolean;
  followeeIds: number[];
  testIdPrefix: string;
}) {
  const [page, setPage] = useState(0);
  const offset = page * PAGE_SIZE;

  const { data, isLoading, isError, error } = useQuery<FollowListResponse>({
    queryKey: [endpoint, offset, PAGE_SIZE],
    queryFn: async () => {
      const url = `${endpoint}?limit=${PAGE_SIZE}&offset=${offset}`;
      const res = await fetch(url, { credentials: 'include' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        <Loader2 className="w-5 h-5 animate-spin mr-2" />
        Loading…
      </div>
    );
  }
  if (isError) {
    return (
      <div className="py-12 text-center text-sm text-destructive">
        Could not load list: {error instanceof Error ? error.message : 'unknown error'}
      </div>
    );
  }

  const items = data?.items ?? [];
  const total = data?.total ?? 0;

  if (items.length === 0) {
    return (
      <div className="py-12 text-center">
        <Users className="w-10 h-10 mx-auto text-muted-foreground/40 mb-3" />
        <div className="text-base font-medium">{emptyTitle}</div>
        <div className="text-sm text-muted-foreground mt-1">{emptyHint}</div>
      </div>
    );
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="space-y-2">
      <div className="text-xs text-muted-foreground px-1">
        {total} {total === 1 ? 'person' : 'people'}
      </div>
      <ul className="divide-y divide-border rounded-lg border border-border bg-card">
        {items.map(item => {
          const name = item.displayName?.trim() || item.username;
          // For "Followers" tab we still want to show the right Follow/Following
          // state (mutual follow), so we hydrate from the same followeeIds list.
          const isFollowing = showUnfollowOnly ? true : followeeIds.includes(item.userId);
          return (
            <li
              key={item.userId}
              data-testid={`${testIdPrefix}-row-${item.userId}`}
              className="flex items-center gap-3 px-3 py-2.5"
            >
              <Avatar className="h-10 w-10">
                {item.profileImage ? <AvatarImage src={item.profileImage} alt={name} /> : null}
                <AvatarFallback>{initialsOf(item.displayName, item.username)}</AvatarFallback>
              </Avatar>
              <div className="flex-1 min-w-0">
                <div className="font-medium truncate">{name}</div>
                {item.displayName && item.displayName !== item.username ? (
                  <div className="text-xs text-muted-foreground truncate">@{item.username}</div>
                ) : null}
              </div>
              <FollowButton userId={item.userId} initialFollowing={isFollowing} />
            </li>
          );
        })}
      </ul>
      {totalPages > 1 ? (
        <div className="flex items-center justify-between pt-2">
          <Button
            variant="outline"
            size="sm"
            disabled={page === 0}
            onClick={() => setPage(p => Math.max(0, p - 1))}
            data-testid={`${testIdPrefix}-prev`}
          >
            Previous
          </Button>
          <div className="text-xs text-muted-foreground">
            Page {page + 1} of {totalPages}
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= totalPages - 1}
            onClick={() => setPage(p => p + 1)}
            data-testid={`${testIdPrefix}-next`}
          >
            Next
          </Button>
        </div>
      ) : null}
    </div>
  );
}

export default function MyFollowsPage() {
  const { data: me, isLoading: meLoading } = useGetMe();
  const followeeIds = useFolloweeIds();
  const [tab, setTab] = useState<'following' | 'followers'>('following');

  // FollowButton itself invalidates the my-follows queries
  // (`/api/portal/follows/list`, `/api/portal/followers`) and the shared
  // `portal-follows-list` key after every successful Follow / Unfollow,
  // so the page-header badge ({followeeIds.length}), the per-tab "X
  // people" count line, and the row list all update instantly without
  // any extra useEffect-on-followeeIds.length workaround here (Task #2183).

  if (meLoading) {
    return (
      <div className="flex items-center justify-center py-24 text-muted-foreground">
        <Loader2 className="w-5 h-5 animate-spin mr-2" />
        Loading…
      </div>
    );
  }

  if (!me) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center p-6">
        <Users className="w-10 h-10 text-muted-foreground/40 mb-3" />
        <div className="text-base font-medium">Sign in to manage your follows</div>
        <div className="text-sm text-muted-foreground mt-1 text-center max-w-sm">
          Your following and followers list shows up here once you're signed in.
        </div>
        <Link href="/login">
          <Button variant="default" size="sm" className="mt-4">Sign in</Button>
        </Link>
      </div>
    );
  }

  // Players/spectators land back in /portal; everyone else goes home (/).
  // Without this the back link would dump a player into the admin shell
  // they don't have access to and immediately bounce them out via the
  // AuthGuard role check.
  const backHref = me.role === 'player' || me.role === 'spectator' ? `${BASE}/portal` : `${BASE}/`;

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-2xl mx-auto p-4 md:p-6 space-y-4">
      <div className="flex items-center gap-2">
        <Link href={backHref}>
          <Button variant="ghost" size="sm" className="gap-1.5" data-testid="button-back">
            <ArrowLeft className="w-4 h-4" />
            Back
          </Button>
        </Link>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2">
            <UserPlus className="w-5 h-5 text-primary" />
            My follows
            <Badge
              variant="secondary"
              className="ml-1"
              data-testid="badge-followee-count"
            >
              {followeeIds.length}
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Tabs value={tab} onValueChange={v => setTab(v as 'following' | 'followers')}>
            <TabsList className="grid grid-cols-2 mb-4">
              <TabsTrigger value="following" data-testid="tab-following">Following</TabsTrigger>
              <TabsTrigger value="followers" data-testid="tab-followers">Followers</TabsTrigger>
            </TabsList>
            <TabsContent value="following">
              <FollowList
                endpoint="/api/portal/follows/list"
                emptyTitle="You aren't following anyone yet"
                emptyHint="Tap Follow on member rows or player profiles to start building your list."
                showUnfollowOnly
                followeeIds={followeeIds}
                testIdPrefix="following"
              />
            </TabsContent>
            <TabsContent value="followers">
              <FollowList
                endpoint="/api/portal/followers"
                emptyTitle="No one is following you yet"
                emptyHint="As other members tap Follow on your profile, they'll show up here."
                showUnfollowOnly={false}
                followeeIds={followeeIds}
                testIdPrefix="followers"
              />
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
      </div>
    </div>
  );
}
