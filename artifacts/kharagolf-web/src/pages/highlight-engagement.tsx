import { useEffect, useMemo, useState } from 'react';
import { useSearch } from 'wouter';
import { Loader2, Download, Share2, Film, ArrowUpDown, X, RefreshCw, ExternalLink } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';
import { useActiveOrgId } from '@/context/ActiveOrgContext';

const API_BASE = (import.meta.env.BASE_URL || '/').replace(/\/$/, '');
const apiUrl = (path: string) => `${API_BASE}/api${path}`;

interface ReelRow {
  id: number;
  title: string | null;
  status: string;
  createdAt: string;
  userId: number | null;
  tournamentId: number | null;
  outputUrl: string | null;
  thumbnailUrl: string | null;
  downloadCount: number;
  shareCount: number;
}

interface EngagementEvent {
  id: number;
  eventType: string;
  userId: number | null;
  source: string | null;
  createdAt: string;
}

interface EngagementDetail {
  reelId: number;
  downloadCount: number;
  shareCount: number;
  recent: EngagementEvent[];
}

type SortKey = 'total' | 'downloads' | 'shares' | 'created';

interface TournamentOption {
  id: number;
  name: string | null;
}

function fmtDate(s: string) {
  try { return new Date(s).toLocaleString(); } catch { return s; }
}

// Pull initial filter values out of the URL so admins can land on (and share)
// pre-filtered views.
function readFiltersFromUrl(search: string) {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  return {
    tournamentId: params.get('tournamentId') ?? '',
    since: params.get('since') ?? '',
    until: params.get('until') ?? '',
  };
}

export default function HighlightEngagementPage() {
  const { toast } = useToast();
  const activeOrgId = useActiveOrgId();
  const search = useSearch();
  const initialFilters = useMemo(() => readFiltersFromUrl(search), []);

  const [loading, setLoading] = useState(true);
  const [reels, setReels] = useState<ReelRow[]>([]);
  const [tournaments, setTournaments] = useState<TournamentOption[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>('total');
  const [selected, setSelected] = useState<ReelRow | null>(null);
  const [detail, setDetail] = useState<EngagementDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [tournamentId, setTournamentId] = useState<string>(initialFilters.tournamentId);
  const [since, setSince] = useState<string>(initialFilters.since);
  const [until, setUntil] = useState<string>(initialFilters.until);

  // Mirror the active filters into the URL (replaceState so the back button
  // isn't polluted with every keystroke), keeping the activeOrg query param if
  // present so the link is portable across orgs.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (tournamentId) params.set('tournamentId', tournamentId); else params.delete('tournamentId');
    if (since) params.set('since', since); else params.delete('since');
    if (until) params.set('until', until); else params.delete('until');
    const qs = params.toString();
    const newUrl = `${window.location.pathname}${qs ? `?${qs}` : ''}${window.location.hash}`;
    window.history.replaceState(null, '', newUrl);
  }, [tournamentId, since, until]);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (activeOrgId) params.set('organizationId', String(activeOrgId));
      if (tournamentId) params.set('tournamentId', tournamentId);
      if (since) {
        // <input type="date"> gives YYYY-MM-DD — anchor to start-of-day UTC.
        const d = new Date(`${since}T00:00:00.000Z`);
        if (!isNaN(d.getTime())) params.set('since', d.toISOString());
      }
      if (until) {
        // Inclusive end-of-day so "until 2026-04-21" includes that whole day.
        const d = new Date(`${until}T23:59:59.999Z`);
        if (!isNaN(d.getTime())) params.set('until', d.toISOString());
      }
      const qs = params.toString();
      const r = await fetch(apiUrl(`/portal/highlights/admin/list${qs ? `?${qs}` : ''}`), { credentials: 'include' });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body?.error || `Request failed (${r.status})`);
      }
      const data = await r.json();
      setReels(Array.isArray(data?.reels) ? data.reels : []);
      setTournaments(Array.isArray(data?.tournaments) ? data.tournaments : []);
    } catch (e: any) {
      setError(e?.message || 'Failed to load highlight reels');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [activeOrgId, tournamentId, since, until]);

  const clearFilters = () => { setTournamentId(''); setSince(''); setUntil(''); };
  const hasFilters = !!(tournamentId || since || until);

  // Format a Date as YYYY-MM-DD in local time so it matches what an admin
  // would type into <input type="date">.
  const toDateInput = (d: Date) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };

  type PresetKey = 'last7' | 'last30' | 'last90' | 'thisMonth' | 'all';
  const presets: { key: PresetKey; label: string }[] = [
    { key: 'last7', label: 'Last 7 days' },
    { key: 'last30', label: 'Last 30 days' },
    { key: 'last90', label: 'Last 90 days' },
    { key: 'thisMonth', label: 'This month' },
    { key: 'all', label: 'All time' },
  ];

  const computePreset = (key: PresetKey): { since: string; until: string } => {
    const today = new Date();
    if (key === 'all') return { since: '', until: '' };
    const until = toDateInput(today);
    if (key === 'thisMonth') {
      const first = new Date(today.getFullYear(), today.getMonth(), 1);
      return { since: toDateInput(first), until };
    }
    const days = key === 'last7' ? 6 : key === 'last30' ? 29 : 89;
    const start = new Date(today);
    start.setDate(start.getDate() - days);
    return { since: toDateInput(start), until };
  };

  const activePreset: PresetKey | null = useMemo(() => {
    for (const p of presets) {
      const { since: s, until: u } = computePreset(p.key);
      if (s === since && u === until) return p.key;
    }
    return null;
  }, [since, until]);

  const applyPreset = (key: PresetKey) => {
    const { since: s, until: u } = computePreset(key);
    setSince(s);
    setUntil(u);
  };

  const sorted = useMemo(() => {
    const rows = [...reels];
    rows.sort((a, b) => {
      switch (sortKey) {
        case 'downloads': return b.downloadCount - a.downloadCount;
        case 'shares': return b.shareCount - a.shareCount;
        case 'created':
          return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
        case 'total':
        default:
          return (b.downloadCount + b.shareCount) - (a.downloadCount + a.shareCount);
      }
    });
    return rows;
  }, [reels, sortKey]);

  const totals = useMemo(() => {
    return reels.reduce(
      (acc, r) => ({
        downloads: acc.downloads + r.downloadCount,
        shares: acc.shares + r.shareCount,
      }),
      { downloads: 0, shares: 0 },
    );
  }, [reels]);

  const topEngagement = useMemo(() => {
    if (!reels.length) return 0;
    return Math.max(...reels.map(r => r.downloadCount + r.shareCount));
  }, [reels]);

  const openDetail = async (reel: ReelRow) => {
    setSelected(reel);
    setDetail(null);
    setDetailLoading(true);
    try {
      const r = await fetch(apiUrl(`/portal/highlights/${reel.id}/engagement`), { credentials: 'include' });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error(body?.error || `Request failed (${r.status})`);
      }
      setDetail(await r.json());
    } catch (e: any) {
      toast({
        title: 'Could not load engagement timeline',
        description: e?.message || 'Unknown error',
        variant: 'destructive',
      });
    } finally {
      setDetailLoading(false);
    }
  };

  const closeDetail = () => { setSelected(null); setDetail(null); };

  const SortBtn = ({ keyName, label }: { keyName: SortKey; label: string }) => (
    <button
      onClick={() => setSortKey(keyName)}
      className={`inline-flex items-center gap-1 px-2 py-1 rounded text-xs transition-colors ${
        sortKey === keyName
          ? 'bg-primary/15 text-primary border border-primary/30'
          : 'bg-white/5 text-muted-foreground hover:text-foreground border border-white/5'
      }`}
    >
      <ArrowUpDown className="w-3 h-3" />
      {label}
    </button>
  );

  return (
    <div className="space-y-6 p-6">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <Film className="w-6 h-6 text-primary" />
            Highlight Reel Engagement
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Downloads and shares for every highlight reel produced by your club.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={load} disabled={loading}>
          <RefreshCw className={`w-4 h-4 me-2 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card className="p-4">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">Reels</div>
          <div className="text-2xl font-semibold mt-1">{reels.length}</div>
        </Card>
        <Card className="p-4">
          <div className="text-xs uppercase tracking-wide text-muted-foreground flex items-center gap-1">
            <Download className="w-3 h-3" /> Total downloads
          </div>
          <div className="text-2xl font-semibold mt-1">{totals.downloads}</div>
        </Card>
        <Card className="p-4">
          <div className="text-xs uppercase tracking-wide text-muted-foreground flex items-center gap-1">
            <Share2 className="w-3 h-3" /> Total shares
          </div>
          <div className="text-2xl font-semibold mt-1">{totals.shares}</div>
        </Card>
      </div>

      {/* Filters */}
      <Card className="p-4 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs uppercase tracking-wide text-muted-foreground me-1">
            Quick range:
          </span>
          {presets.map((p) => {
            const isActive = activePreset === p.key;
            return (
              <button
                key={p.key}
                type="button"
                onClick={() => applyPreset(p.key)}
                data-testid={`filter-preset-${p.key}`}
                className={`px-2.5 py-1 rounded-full text-xs border transition-colors ${
                  isActive
                    ? 'bg-primary/15 text-primary border-primary/30'
                    : 'bg-white/5 text-muted-foreground hover:text-foreground border-white/10'
                }`}
              >
                {p.label}
              </button>
            );
          })}
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <label htmlFor="filter-tournament" className="text-xs uppercase tracking-wide text-muted-foreground">
              Tournament
            </label>
            <select
              id="filter-tournament"
              data-testid="filter-tournament"
              value={tournamentId}
              onChange={(e) => setTournamentId(e.target.value)}
              className="bg-white/5 border border-white/10 rounded-md px-3 py-2 text-sm min-w-[12rem]"
            >
              <option value="">All tournaments</option>
              {tournaments.map((t) => (
                <option key={t.id} value={String(t.id)}>
                  {t.name || `Tournament #${t.id}`}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="filter-since" className="text-xs uppercase tracking-wide text-muted-foreground">
              From
            </label>
            <input
              id="filter-since"
              data-testid="filter-since"
              type="date"
              value={since}
              onChange={(e) => setSince(e.target.value)}
              className="bg-white/5 border border-white/10 rounded-md px-3 py-2 text-sm"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="filter-until" className="text-xs uppercase tracking-wide text-muted-foreground">
              To
            </label>
            <input
              id="filter-until"
              data-testid="filter-until"
              type="date"
              value={until}
              onChange={(e) => setUntil(e.target.value)}
              className="bg-white/5 border border-white/10 rounded-md px-3 py-2 text-sm"
            />
          </div>
          {hasFilters && (
            <Button
              variant="ghost"
              size="sm"
              onClick={clearFilters}
              data-testid="filter-clear"
            >
              <X className="w-3 h-3 me-1" /> Clear filters
            </Button>
          )}
        </div>
      </Card>

      {/* Sort controls */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground me-1">Sort by:</span>
        <SortBtn keyName="total" label="Total engagement" />
        <SortBtn keyName="downloads" label="Downloads" />
        <SortBtn keyName="shares" label="Shares" />
        <SortBtn keyName="created" label="Newest" />
      </div>

      {/* Table */}
      <Card className="overflow-hidden">
        {loading ? (
          <div className="p-12 flex items-center justify-center text-muted-foreground">
            <Loader2 className="w-5 h-5 animate-spin me-2" /> Loading reels…
          </div>
        ) : error ? (
          <div className="p-8 text-center text-sm text-red-400">{error}</div>
        ) : sorted.length === 0 ? (
          <div className="p-12 text-center text-muted-foreground text-sm">
            No highlight reels have been produced yet.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-white/5 text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="text-start px-4 py-2 font-medium">Reel</th>
                  <th className="text-start px-4 py-2 font-medium">Status</th>
                  <th className="text-end px-4 py-2 font-medium">Downloads</th>
                  <th className="text-end px-4 py-2 font-medium">Shares</th>
                  <th className="text-end px-4 py-2 font-medium">Total</th>
                  <th className="text-start px-4 py-2 font-medium">Created</th>
                  <th className="px-4 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((reel) => {
                  const total = reel.downloadCount + reel.shareCount;
                  const isTop = topEngagement > 0 && total === topEngagement;
                  return (
                    <tr
                      key={reel.id}
                      data-testid={`reel-row-${reel.id}`}
                      className={`border-t border-white/5 hover:bg-white/5 transition-colors ${
                        isTop ? 'bg-primary/5' : ''
                      }`}
                    >
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-3">
                          {reel.thumbnailUrl ? (
                            <img
                              src={reel.thumbnailUrl}
                              alt=""
                              className="w-12 h-12 rounded object-cover bg-black/30 flex-shrink-0"
                            />
                          ) : (
                            <div className="w-12 h-12 rounded bg-white/5 flex items-center justify-center flex-shrink-0">
                              <Film className="w-5 h-5 text-muted-foreground" />
                            </div>
                          )}
                          <div className="min-w-0">
                            <div className="font-medium truncate flex items-center gap-2">
                              {reel.title || `Reel #${reel.id}`}
                              {isTop && (
                                <Badge variant="default" className="text-[10px] py-0 px-1.5">
                                  Top
                                </Badge>
                              )}
                            </div>
                            <div className="text-xs text-muted-foreground">ID #{reel.id}</div>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <Badge variant="outline" className="text-xs capitalize">
                          {reel.status}
                        </Badge>
                      </td>
                      <td className="px-4 py-3 text-end tabular-nums">{reel.downloadCount}</td>
                      <td className="px-4 py-3 text-end tabular-nums">{reel.shareCount}</td>
                      <td className="px-4 py-3 text-end tabular-nums font-semibold">{total}</td>
                      <td className="px-4 py-3 text-xs text-muted-foreground">
                        {fmtDate(reel.createdAt)}
                      </td>
                      <td className="px-4 py-3 text-end">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => openDetail(reel)}
                          data-testid={`reel-detail-btn-${reel.id}`}
                        >
                          Timeline
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Detail drawer */}
      {selected && (
        <div className="fixed inset-0 z-50 flex">
          <div
            className="absolute inset-0 bg-black/60"
            onClick={closeDetail}
            aria-hidden="true"
          />
          <div className="relative ms-auto h-full w-full max-w-md bg-background border-l border-white/10 shadow-2xl flex flex-col">
            <div className="flex items-start justify-between p-4 border-b border-white/10">
              <div className="min-w-0">
                <div className="text-xs text-muted-foreground">Engagement timeline</div>
                <div className="font-semibold truncate">
                  {selected.title || `Reel #${selected.id}`}
                </div>
              </div>
              <button
                onClick={closeDetail}
                className="p-1 rounded hover:bg-white/10"
                aria-label="Close"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-4 space-y-4 overflow-y-auto flex-1">
              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-lg bg-white/5 p-3">
                  <div className="text-xs text-muted-foreground flex items-center gap-1">
                    <Download className="w-3 h-3" /> Downloads
                  </div>
                  <div className="text-xl font-semibold mt-0.5 tabular-nums">
                    {detail?.downloadCount ?? selected.downloadCount}
                  </div>
                </div>
                <div className="rounded-lg bg-white/5 p-3">
                  <div className="text-xs text-muted-foreground flex items-center gap-1">
                    <Share2 className="w-3 h-3" /> Shares
                  </div>
                  <div className="text-xl font-semibold mt-0.5 tabular-nums">
                    {detail?.shareCount ?? selected.shareCount}
                  </div>
                </div>
              </div>

              {selected.outputUrl && (
                <a
                  href={selected.outputUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                >
                  <ExternalLink className="w-3 h-3" /> Open reel
                </a>
              )}

              <div>
                <div className="text-xs uppercase tracking-wide text-muted-foreground mb-2">
                  Recent activity
                </div>
                {detailLoading ? (
                  <div className="flex items-center text-sm text-muted-foreground py-6">
                    <Loader2 className="w-4 h-4 animate-spin me-2" /> Loading…
                  </div>
                ) : !detail || detail.recent.length === 0 ? (
                  <div className="text-sm text-muted-foreground py-6 text-center">
                    No engagement events yet.
                  </div>
                ) : (
                  <ul className="space-y-2">
                    {detail.recent.map((ev) => (
                      <li
                        key={ev.id}
                        className="flex items-start gap-2 text-sm border border-white/5 rounded-md px-3 py-2"
                      >
                        {ev.eventType === 'download' ? (
                          <Download className="w-4 h-4 text-primary mt-0.5 flex-shrink-0" />
                        ) : (
                          <Share2 className="w-4 h-4 text-primary mt-0.5 flex-shrink-0" />
                        )}
                        <div className="min-w-0 flex-1">
                          <div className="capitalize">
                            {ev.eventType}
                            {ev.source ? (
                              <span className="text-muted-foreground"> · {ev.source}</span>
                            ) : null}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {fmtDate(ev.createdAt)}
                            {ev.userId ? ` · user #${ev.userId}` : ''}
                          </div>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
