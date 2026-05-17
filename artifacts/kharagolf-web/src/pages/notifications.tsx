import { useEffect, useState, useCallback, useRef } from 'react';
import { useLocation } from 'wouter';
import { Bell, BellOff, ChevronLeft, CheckCheck, Gavel, RefreshCw, UserPlus } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';

const GOLD = '#C9A84C';

// ── Source-tagged unified item ────────────────────────────────────────
//
// The notifications page now merges two separate per-user feeds into
// one chronological stream:
//
//   • `handicap` — committee review-case lifecycle events served by
//     `/api/portal/handicap/notifications` (caseId / orgName scoped).
//
//   • `inbox` — Task #2159, the generic in-app inbox served by
//     `/api/portal/inbox/notifications`. Currently surfaces
//     `social.follow.new` rows (with deep link to the follower's
//     profile); future engagement / moderation pings can opt in by
//     inserting into `userInboxNotificationsTable` from their dispatch
//     site without any UI change here.
//
// The two backends own different ID spaces, so we tag each merged
// entry with `source` and use a composite key (`source:id`) when
// React renders the list. Mark-as-read routes the call to the right
// backend based on `source`; "Mark all read" fans out to both.

interface HandicapItem {
  source: 'handicap';
  id: number;
  caseId: number;
  organizationId: number;
  orgName: string | null;
  event: 'opened' | 'decided' | 'closed' | 'reopened' | string;
  title: string;
  body: string;
  payload: Record<string, unknown> | null;
  createdAt: string;
  readAt: string | null;
  caseStatus: string | null;
  caseKind: string | null;
  deepLink: string;
}

interface InboxItem {
  source: 'inbox';
  id: number;
  notificationKey: string;
  title: string;
  body: string;
  payload: Record<string, unknown> | null;
  createdAt: string;
  readAt: string | null;
  deepLink: string;
}

type NotifItem = HandicapItem | InboxItem;

interface HandicapResponse {
  unreadCount: number;
  items: Array<Omit<HandicapItem, 'source'>>;
  nextCursor?: number | null;
}

interface InboxResponse {
  unreadCount: number;
  items: Array<{
    id: number;
    notificationKey: string;
    title: string;
    body: string;
    payload: Record<string, unknown> | null;
    createdAt: string;
    readAt: string | null;
    deepLink: string | null;
  }>;
  nextCursor?: number | null;
}

const PAGE_SIZE = 25;
const LOAD_MORE_THRESHOLD_PX = 240;

const EVENT_TONE: Record<string, { bg: string; text: string; ring: string; label: string }> = {
  opened: { bg: 'bg-blue-500/15', text: 'text-blue-300', ring: 'border-blue-500/30', label: 'Case opened' },
  decided: { bg: 'bg-emerald-500/15', text: 'text-emerald-300', ring: 'border-emerald-500/30', label: 'Decision recorded' },
  closed: { bg: 'bg-white/10', text: 'text-white/70', ring: 'border-white/20', label: 'Case closed' },
  reopened: { bg: 'bg-amber-500/15', text: 'text-amber-300', ring: 'border-amber-500/30', label: 'Case reopened' },
};

// Per-key tone for generic inbox rows. Mirrors the EVENT_TONE map shape
// so the renderer below can switch on `source` without a special case.
const INBOX_KEY_TONE: Record<string, { bg: string; text: string; ring: string; label: string; Icon: typeof UserPlus }> = {
  'social.follow.new': {
    bg: 'bg-purple-500/15',
    text: 'text-purple-300',
    ring: 'border-purple-500/30',
    label: 'New follower',
    Icon: UserPlus,
  },
};

const DEFAULT_INBOX_TONE = {
  bg: 'bg-white/10',
  text: 'text-white/70',
  ring: 'border-white/20',
  label: 'Notification',
  Icon: Bell,
};

// Stable composite key — handicap and inbox IDs may collide.
function itemKey(i: NotifItem): string {
  return `${i.source}:${i.id}`;
}

export default function NotificationsPage() {
  const [, navigate] = useLocation();
  const { toast } = useToast();

  const [handicap, setHandicap] = useState<{ items: HandicapItem[]; unread: number; nextCursor: number | null } | null>(null);
  const [inbox, setInbox] = useState<{ items: InboxItem[]; unread: number; nextCursor: number | null } | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const loadingMoreRef = useRef(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [hRes, iRes] = await Promise.all([
        fetch(`/api/portal/handicap/notifications?limit=${PAGE_SIZE}`, { credentials: 'include' }),
        fetch(`/api/portal/inbox/notifications?limit=${PAGE_SIZE}`, { credentials: 'include' }),
      ]);
      if (hRes.status === 401 || iRes.status === 401) {
        toast({ title: 'Sign in required', description: 'Please sign in to view notifications.', variant: 'destructive' });
        setHandicap({ items: [], unread: 0, nextCursor: null });
        setInbox({ items: [], unread: 0, nextCursor: null });
        return;
      }
      // Each feed is independent — degrade gracefully when one errors so
      // a flaky handicap query never hides the user's social pings.
      const hJson: HandicapResponse = hRes.ok
        ? await hRes.json()
        : { unreadCount: 0, items: [], nextCursor: null };
      const iJson: InboxResponse = iRes.ok
        ? await iRes.json()
        : { unreadCount: 0, items: [], nextCursor: null };
      setHandicap({
        items: hJson.items.map(it => ({ ...it, source: 'handicap' as const })),
        unread: hJson.unreadCount,
        nextCursor: hJson.nextCursor ?? null,
      });
      setInbox({
        items: iJson.items.map(it => ({
          ...it,
          source: 'inbox' as const,
          // Falls back to /my-follows so the click-through always
          // lands somewhere useful even if a future inserter forgets
          // to set `payload.deepLink`.
          deepLink: it.deepLink ?? '/my-follows',
        })),
        unread: iJson.unreadCount,
        nextCursor: iJson.nextCursor ?? null,
      });
    } catch (err) {
      toast({ title: 'Failed to load notifications', description: String((err as Error).message ?? err), variant: 'destructive' });
      setHandicap({ items: [], unread: 0, nextCursor: null });
      setInbox({ items: [], unread: 0, nextCursor: null });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { void load(); }, [load]);

  // Lazy-load older items from whichever feed still has a continuation
  // cursor. We deliberately page each feed independently rather than
  // synthesising a unified cursor: the two feeds have unrelated id
  // spaces, the dominant feed for any given user is usually the
  // handicap one, and "load more" doesn't need perfect interleaving —
  // newly-arrived rows from the other feed will still appear at the
  // top once the user refetches.
  const loadMore = useCallback(async () => {
    if (loadingMoreRef.current) return;
    const hCursor = handicap?.nextCursor ?? null;
    const iCursor = inbox?.nextCursor ?? null;
    if (hCursor == null && iCursor == null) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      const reqs: Promise<Response | null>[] = [
        hCursor != null
          ? fetch(`/api/portal/handicap/notifications?limit=${PAGE_SIZE}&before=${hCursor}`, { credentials: 'include' })
          : Promise.resolve(null),
        iCursor != null
          ? fetch(`/api/portal/inbox/notifications?limit=${PAGE_SIZE}&before=${iCursor}`, { credentials: 'include' })
          : Promise.resolve(null),
      ];
      const [hRes, iRes] = await Promise.all(reqs);
      if (hRes && hRes.ok) {
        const page: HandicapResponse = await hRes.json();
        setHandicap(prev => {
          if (!prev) return prev;
          const seen = new Set(prev.items.map(i => i.id));
          const merged = [
            ...prev.items,
            ...page.items.filter(i => !seen.has(i.id)).map(it => ({ ...it, source: 'handicap' as const })),
          ];
          return {
            items: merged,
            unread: page.unreadCount ?? prev.unread,
            nextCursor: page.nextCursor ?? null,
          };
        });
      }
      if (iRes && iRes.ok) {
        const page: InboxResponse = await iRes.json();
        setInbox(prev => {
          if (!prev) return prev;
          const seen = new Set(prev.items.map(i => i.id));
          const merged = [
            ...prev.items,
            ...page.items
              .filter(i => !seen.has(i.id))
              .map(it => ({
                ...it,
                source: 'inbox' as const,
                deepLink: it.deepLink ?? '/my-follows',
              })),
          ];
          return {
            items: merged,
            unread: page.unreadCount ?? prev.unread,
            nextCursor: page.nextCursor ?? null,
          };
        });
      }
    } catch {
      // best-effort
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, [handicap?.nextCursor, inbox?.nextCursor]);

  useEffect(() => {
    const onScroll = () => {
      const scrollTop = window.scrollY || document.documentElement.scrollTop;
      const viewport = window.innerHeight || document.documentElement.clientHeight;
      const full = document.documentElement.scrollHeight;
      const distanceFromBottom = full - (scrollTop + viewport);
      if (distanceFromBottom <= LOAD_MORE_THRESHOLD_PX) {
        void loadMore();
      }
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [loadMore]);

  const markOneRead = useCallback(async (item: NotifItem) => {
    const url = item.source === 'handicap'
      ? `/api/portal/handicap/notifications/${item.id}/read`
      : `/api/portal/inbox/notifications/${item.id}/read`;
    try {
      await fetch(url, { method: 'POST', credentials: 'include' });
      const stamp = new Date().toISOString();
      if (item.source === 'handicap') {
        setHandicap(prev => prev ? {
          ...prev,
          unread: Math.max(0, prev.unread - (prev.items.find(i => i.id === item.id && !i.readAt) ? 1 : 0)),
          items: prev.items.map(i => i.id === item.id && !i.readAt ? { ...i, readAt: stamp } : i),
        } : prev);
      } else {
        setInbox(prev => prev ? {
          ...prev,
          unread: Math.max(0, prev.unread - (prev.items.find(i => i.id === item.id && !i.readAt) ? 1 : 0)),
          items: prev.items.map(i => i.id === item.id && !i.readAt ? { ...i, readAt: stamp } : i),
        } : prev);
      }
    } catch {
      // best-effort
    }
  }, []);

  const markAllRead = useCallback(async () => {
    setBusy(true);
    try {
      // Fan out to both backends in parallel — neither call depends on
      // the other and both are idempotent.
      await Promise.all([
        fetch('/api/portal/handicap/notifications/read-all', { method: 'POST', credentials: 'include' }),
        fetch('/api/portal/inbox/notifications/read-all', { method: 'POST', credentials: 'include' }),
      ]);
      const stamp = new Date().toISOString();
      setHandicap(prev => prev ? {
        ...prev,
        unread: 0,
        items: prev.items.map(i => i.readAt ? i : { ...i, readAt: stamp }),
      } : prev);
      setInbox(prev => prev ? {
        ...prev,
        unread: 0,
        items: prev.items.map(i => i.readAt ? i : { ...i, readAt: stamp }),
      } : prev);
      toast({ title: 'All notifications marked as read' });
    } catch (err) {
      toast({ title: 'Failed to mark all read', variant: 'destructive' });
    } finally {
      setBusy(false);
    }
  }, [toast]);

  const handleOpen = useCallback(async (item: NotifItem) => {
    if (!item.readAt) await markOneRead(item);
    const fallback = item.source === 'handicap' ? '/handicap-profile' : '/my-follows';
    navigate(item.deepLink || fallback);
  }, [markOneRead, navigate]);

  // Merge feeds and sort by createdAt desc so the user sees a single
  // chronological stream regardless of source.
  const items: NotifItem[] = [
    ...(handicap?.items ?? []),
    ...(inbox?.items ?? []),
  ].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  const unread = (handicap?.unread ?? 0) + (inbox?.unread ?? 0);

  return (
    <div className="min-h-screen bg-[#0a0f1a] text-white p-4 md:p-8">
      <div className="max-w-3xl mx-auto space-y-4">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={() => navigate('/portal')} data-testid="button-back">
            <ChevronLeft className="w-5 h-5" />
          </Button>
          <div className="flex-1">
            <h1 className="text-2xl font-bold text-white flex items-center gap-2">
              <Bell className="w-5 h-5" style={{ color: GOLD }} />
              Notifications
              {unread > 0 && (
                <Badge className="bg-blue-500/20 text-blue-300 border-blue-500/30" data-testid="badge-unread">
                  {unread} new
                </Badge>
              )}
            </h1>
            <p className="text-white/50 text-sm">Committee updates, new followers, and other activity on your account</p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={markAllRead}
            disabled={busy || unread === 0}
            data-testid="button-mark-all-read"
            className="border-white/20 text-white/80 hover:bg-white/10"
          >
            <CheckCheck className="w-4 h-4 mr-2" /> Mark all read
          </Button>
        </div>

        {loading ? (
          <div className="flex justify-center py-20">
            <RefreshCw className="w-8 h-8 text-white/30 animate-spin" />
          </div>
        ) : items.length === 0 ? (
          <Card className="bg-[#111827] border-[#1e2d3d] p-10 text-center">
            <BellOff className="w-10 h-10 text-white/20 mx-auto mb-3" />
            <p className="text-white/60">You have no notifications.</p>
            <p className="text-white/40 text-sm mt-1">
              When a handicap review case is opened, a player follows you, or other activity happens on your account it will show up here.
            </p>
          </Card>
        ) : (
          <div className="space-y-2" data-testid="list-notifications">
            {items.map(item => {
              const isUnread = !item.readAt;
              if (item.source === 'handicap') {
                const tone = EVENT_TONE[item.event] ?? EVENT_TONE.opened;
                return (
                  <Card
                    key={itemKey(item)}
                    className={`bg-[#111827] border ${isUnread ? 'border-blue-500/40' : 'border-[#1e2d3d]'} p-4 cursor-pointer hover:bg-white/[0.02] transition-colors`}
                    data-testid={`notification-item-${item.id}`}
                    onClick={() => void handleOpen(item)}
                  >
                    <div className="flex items-start gap-3">
                      <div className={`mt-0.5 p-2 rounded-md ${tone.bg} ${tone.text}`}>
                        <Gavel className="w-4 h-4" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-semibold text-white truncate">{item.title}</span>
                          <Badge variant="outline" className={`text-[10px] uppercase tracking-wide ${tone.ring} ${tone.text}`}>
                            {tone.label}
                          </Badge>
                          {isUnread && (
                            <span className="w-2 h-2 rounded-full bg-blue-400" aria-label="unread" data-testid={`unread-dot-${item.id}`} />
                          )}
                        </div>
                        <p className="text-white/70 text-sm mt-1">{item.body}</p>
                        <div className="flex items-center gap-2 mt-2 text-xs text-white/40">
                          <span>{new Date(item.createdAt).toLocaleString()}</span>
                          {item.orgName && <span>· {item.orgName}</span>}
                          {item.caseKind && <span>· {item.caseKind.replace(/_/g, ' ')}</span>}
                          <span className="ml-auto text-blue-300/80">View handicap profile →</span>
                        </div>
                      </div>
                    </div>
                  </Card>
                );
              }
              // Generic inbox row (Task #2159) — currently `social.follow.new`,
              // open to additional engagement keys without a UI change.
              const tone = INBOX_KEY_TONE[item.notificationKey] ?? DEFAULT_INBOX_TONE;
              const Icon = tone.Icon;
              return (
                <Card
                  key={itemKey(item)}
                  className={`bg-[#111827] border ${isUnread ? 'border-blue-500/40' : 'border-[#1e2d3d]'} p-4 cursor-pointer hover:bg-white/[0.02] transition-colors`}
                  data-testid={`inbox-notification-item-${item.id}`}
                  onClick={() => void handleOpen(item)}
                >
                  <div className="flex items-start gap-3">
                    <div className={`mt-0.5 p-2 rounded-md ${tone.bg} ${tone.text}`}>
                      <Icon className="w-4 h-4" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-semibold text-white truncate">{item.title}</span>
                        <Badge variant="outline" className={`text-[10px] uppercase tracking-wide ${tone.ring} ${tone.text}`}>
                          {tone.label}
                        </Badge>
                        {isUnread && (
                          <span className="w-2 h-2 rounded-full bg-blue-400" aria-label="unread" data-testid={`inbox-unread-dot-${item.id}`} />
                        )}
                      </div>
                      <p className="text-white/70 text-sm mt-1">{item.body}</p>
                      <div className="flex items-center gap-2 mt-2 text-xs text-white/40">
                        <span>{new Date(item.createdAt).toLocaleString()}</span>
                        <span className="ml-auto text-blue-300/80">View profile →</span>
                      </div>
                    </div>
                  </div>
                </Card>
              );
            })}
            {loadingMore ? (
              <div className="flex justify-center py-4" data-testid="notifications-load-more-indicator">
                <RefreshCw className="w-5 h-5 text-white/40 animate-spin" />
              </div>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
