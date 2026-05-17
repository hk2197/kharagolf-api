import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation } from 'wouter';
import {
  ArrowLeft, Plus, Loader2, Star, Zap, Trash2, Pencil, Send, Play,
  Image as ImageIcon, Video as VideoIcon, X, Check, ArrowUp, ArrowDown,
  BarChart3, Trophy, GitCompare,
} from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';

const BASE_URL = (import.meta.env.BASE_URL ?? '/').replace(/\/$/, '');
const API = (path: string) => `${BASE_URL}/api${path}`;
const absUrl = (u: string | null) => (u ? (u.startsWith('http') ? u : `${BASE_URL}${u}`) : '');

interface Reel {
  id: number;
  title: string;
  templateId: string;
  status: 'queued' | 'rendering' | 'ready' | 'failed' | string;
  outputUrl: string | null;
  thumbnailUrl: string | null;
  errorMessage: string | null;
  createdAt: string;
  durationSeconds: number | null;
  tournamentId: number | null;
  feedPostId: number | null;
  options: { caption?: string; clips?: { mediaId: number; caption?: string; startSec?: number; durationSec?: number }[] } | null;
  attempts?: number | null;
  maxAttempts?: number | null;
  // Task #544 / #708 — engagement counts surfaced by the API. Default to
  // 0 server-side so the chart can render without null-checking.
  downloadCount?: number;
  shareCount?: number;
  viewCount?: number;
  feedShareCount?: number;
  // Task #1011 — hour (0-23) with the most engagement in the producer's
  // local time over the trailing 30 days. Null when there's no data yet.
  bestHour?: number | null;
}

interface TimeseriesPoint {
  date: string;
  download: number;
  share: number;
  view: number;
  feed_share: number;
}

interface HourlyPoint {
  hour: number;
  download: number;
  share: number;
  view: number;
  feed_share: number;
  total: number;
}

// Format an hour-of-day (0-23) as "7pm" / "12am" — matches the
// callout copy producers see in the engagement panel.
function formatHourLabel(hour: number): string {
  const h = ((hour % 24) + 24) % 24;
  if (h === 0) return '12am';
  if (h === 12) return '12pm';
  if (h < 12) return `${h}am`;
  return `${h - 12}pm`;
}

// Local-timezone offset in minutes following the JS convention
// `-getTimezoneOffset()` so positive values mean east of UTC. Memoized
// per-mount so we send a stable value with each list/heatmap fetch.
const LOCAL_TZ_OFFSET_MIN = -new Date().getTimezoneOffset();

interface Template {
  id: string;
  name: string;
  description: string;
  durationSeconds: number;
  primaryColor: string;
}

interface Tournament { tournamentId: number; tournamentName: string }

interface Quota { monthlyLimit: number; usedThisMonth: number; remaining: number }

interface CaptionSuggestion {
  text: string;
  pattern: string;
  tokenKeys: string[];
  tokens: Record<string, string | number>;
  isFavorite: boolean;
  templateId: number | null;
}

interface CandidateMedia {
  id: number;
  mediaType: 'image' | 'video' | string;
  caption: string | null;
  holeNumber: number | null;
  thumbnailUrl: string | null;
  url: string | null;
  durationSeconds?: number | null;
  suggestedCaptions?: string[];
  suggestedCaptionTemplates?: CaptionSuggestion[];
}

interface ClipDraft {
  mediaId: number;
  caption: string;
}

// Compact 4-bar chart for the producer-facing highlights gallery
// (Task #863). Renders downloads / shares / views / re-shares side by
// side so producers can see at a glance which engagement type a reel is
// actually pulling — and not just a flat sum.
const ENGAGEMENT_BARS: Array<{ key: 'view' | 'feed_share' | 'share' | 'download'; label: string; color: string }> = [
  { key: 'view',       label: 'Views',     color: '#3b82f6' },
  { key: 'feed_share', label: 'Re-shares', color: '#a855f7' },
  { key: 'share',      label: 'Shares',    color: '#22c55e' },
  { key: 'download',   label: 'Downloads', color: '#f97316' },
];

function EngagementMiniChart({
  reelId, downloadCount, shareCount, viewCount, feedShareCount,
}: {
  reelId: number;
  downloadCount: number;
  shareCount: number;
  viewCount: number;
  feedShareCount: number;
}) {
  const values: Record<string, number> = {
    view: viewCount, feed_share: feedShareCount, share: shareCount, download: downloadCount,
  };
  const max = Math.max(1, ...Object.values(values));
  return (
    <div
      className="flex items-end gap-3 h-16 px-2 py-1 rounded bg-muted/30 border border-border/40"
      data-testid={`engagement-chart-${reelId}`}
      aria-label="Engagement breakdown"
    >
      {ENGAGEMENT_BARS.map(b => {
        const v = values[b.key];
        return (
          <div key={b.key} className="flex-1 flex flex-col items-center justify-end h-full" data-testid={`bar-${b.key}-${reelId}`}>
            <div className="text-[10px] tabular-nums leading-none mb-0.5" style={{ color: b.color }}>{v}</div>
            <div
              className="w-full rounded-t transition-all"
              style={{
                height: `${(v / max) * 80}%`,
                minHeight: 2,
                backgroundColor: b.color,
                opacity: v === 0 ? 0.25 : 1,
              }}
            />
            <div className="text-[9px] text-muted-foreground mt-1 leading-none">{b.label}</div>
          </div>
        );
      })}
    </div>
  );
}

// Tiny SVG sparkline that overlays daily Views vs Re-shares for the
// trend window (default 7 days). Lets producers see which reels keep
// pulling traction days after they were posted.
// 24-cell hour-of-day heatmap (Task #1011). Each cell's blue intensity
// scales with that hour's share of total engagement so producers can
// glance and see when their audience is most active.
function HourHeatmap({ hourly, bestHour }: { hourly: HourlyPoint[]; bestHour: number | null }) {
  const max = Math.max(1, ...hourly.map(h => h.total));
  return (
    <div className="mt-2" data-testid="hour-heatmap">
      <div className="grid grid-cols-24 gap-[2px]" style={{ gridTemplateColumns: 'repeat(24, minmax(0, 1fr))' }}>
        {hourly.map(h => {
          const intensity = h.total / max;
          const isBest = bestHour === h.hour;
          return (
            <div
              key={h.hour}
              className="h-5 rounded-sm border"
              style={{
                backgroundColor: `rgba(59, 130, 246, ${0.1 + intensity * 0.85})`,
                borderColor: isBest ? '#a855f7' : 'transparent',
                borderWidth: isBest ? 1.5 : 1,
              }}
              title={`${formatHourLabel(h.hour)} · ${h.total} event${h.total === 1 ? '' : 's'}`}
              data-testid={`heatmap-hour-${h.hour}`}
            />
          );
        })}
      </div>
      <div className="flex justify-between text-[9px] text-muted-foreground mt-1">
        <span>12am</span><span>6am</span><span>12pm</span><span>6pm</span><span>11pm</span>
      </div>
    </div>
  );
}

function TrendSparkline({ series, width = 220, height = 48 }: { series: TimeseriesPoint[]; width?: number; height?: number }) {
  if (series.length === 0) return null;
  const max = Math.max(1, ...series.map(p => Math.max(p.view, p.feed_share)));
  const stepX = series.length > 1 ? width / (series.length - 1) : 0;
  const toY = (v: number) => height - (v / max) * (height - 4) - 2;
  const buildPath = (key: 'view' | 'feed_share') =>
    series
      .map((p, i) => `${i === 0 ? 'M' : 'L'}${(i * stepX).toFixed(2)},${toY(p[key]).toFixed(2)}`)
      .join(' ');
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="block">
      <path d={buildPath('view')}       stroke="#3b82f6" strokeWidth={1.5} fill="none" />
      <path d={buildPath('feed_share')} stroke="#a855f7" strokeWidth={1.5} fill="none" strokeDasharray="3 2" />
    </svg>
  );
}

export default function PortalHighlightsPage() {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const { t } = useTranslation('portal');

  const [reels, setReels] = useState<Reel[]>([]);
  const [quota, setQuota] = useState<Quota | null>(null);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [tournaments, setTournaments] = useState<Tournament[]>([]);
  const [loading, setLoading] = useState(true);

  // Task #1012 — Top-performers sort + side-by-side compare. The sort
  // chip is sent to the API so the ranking matches the engagement
  // numbers the API itself surfaces. Compare mode lets a producer pick
  // 2-3 reels and open a modal that puts their charts next to each other.
  type SortMode = 'recent' | 'top' | 'reshared';
  const [sortMode, setSortMode] = useState<SortMode>('recent');
  const [compareMode, setCompareMode] = useState(false);
  const [compareIds, setCompareIds] = useState<number[]>([]);
  const [compareOpen, setCompareOpen] = useState(false);
  const MAX_COMPARE = 3;

  const [creatorOpen, setCreatorOpen] = useState(false);
  const [editorReel, setEditorReel] = useState<Reel | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [draftTitle, setDraftTitle] = useState('Round Highlights');
  const [draftTemplate, setDraftTemplate] = useState('classic');
  const [draftCaption, setDraftCaption] = useState('');
  const [draftTournamentId, setDraftTournamentId] = useState<number | null>(null);
  const [draftClips, setDraftClips] = useState<ClipDraft[]>([]);
  const [clipsTouched, setClipsTouched] = useState(false);

  const [candidates, setCandidates] = useState<CandidateMedia[]>([]);
  const [candidatesLoading, setCandidatesLoading] = useState(false);

  // Task #863 — per-reel engagement trend. Lazily fetched the first time
  // a producer expands the trend on a row, then cached so re-toggles are
  // instant. `trendDays` is the same window for every reel on the page.
  const [trendOpen, setTrendOpen] = useState<Record<number, boolean>>({});
  // Cache is keyed by `${reelId}:${days}` so switching the 7d/30d chip
  // while a row is closed doesn't leave stale data behind for that row.
  const [trendData, setTrendData] = useState<Record<string, TimeseriesPoint[]>>({});
  const [trendLoading, setTrendLoading] = useState<Record<number, boolean>>({});
  const [trendDays, setTrendDays] = useState<7 | 30>(7);
  const trendKey = (reelId: number, days: number) => `${reelId}:${days}`;
  // Task #1011 — hour-of-day heatmap data, lazy-loaded the first time a
  // trend panel is opened. Cached per (reelId, days) so re-toggles are
  // instant. The "Best hour" badge on the card uses the bestHour field
  // already returned by the list endpoint.
  const [hourlyData, setHourlyData] = useState<Record<string, { hourly: HourlyPoint[]; bestHour: number | null }>>({});

  const loadTrend = useCallback(async (reelId: number, days: number) => {
    setTrendLoading(prev => ({ ...prev, [reelId]: true }));
    try {
      const [tr, hr] = await Promise.all([
        fetch(API(`/portal/highlights/${reelId}/engagement-timeseries?days=${days}`), { credentials: 'include' }),
        fetch(API(`/portal/highlights/${reelId}/engagement-hourly?days=${days}&tzOffsetMinutes=${LOCAL_TZ_OFFSET_MIN}`), { credentials: 'include' }),
      ]);
      if (tr.ok) {
        const d = await tr.json();
        setTrendData(prev => ({ ...prev, [trendKey(reelId, days)]: Array.isArray(d?.series) ? d.series : [] }));
      }
      if (hr.ok) {
        const d = await hr.json();
        setHourlyData(prev => ({
          ...prev,
          [trendKey(reelId, days)]: {
            hourly: Array.isArray(d?.hourly) ? d.hourly : [],
            bestHour: typeof d?.bestHour === 'number' ? d.bestHour : null,
          },
        }));
      }
    } finally {
      setTrendLoading(prev => ({ ...prev, [reelId]: false }));
    }
  }, []);

  const toggleTrend = (reelId: number) => {
    const willOpen = !trendOpen[reelId];
    setTrendOpen(prev => ({ ...prev, [reelId]: willOpen }));
    if (willOpen && !trendData[trendKey(reelId, trendDays)]) loadTrend(reelId, trendDays);
  };

  // When the window selector changes, refetch every currently-open trend
  // so the sparklines stay consistent with the chip the user just picked.
  useEffect(() => {
    Object.entries(trendOpen).forEach(([id, open]) => {
      const reelId = Number(id);
      if (open && !trendData[trendKey(reelId, trendDays)]) loadTrend(reelId, trendDays);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trendDays]);

  const editorOpen = creatorOpen || editorReel != null;
  const candidateById = useMemo(() => {
    const m = new Map<number, CandidateMedia>();
    candidates.forEach(c => m.set(c.id, c));
    return m;
  }, [candidates]);

  const fetchAll = useCallback(async () => {
    try {
      const [r1, r2, r3] = await Promise.all([
        fetch(API(`/portal/highlights?sort=${sortMode}&tzOffsetMinutes=${LOCAL_TZ_OFFSET_MIN}`), { credentials: 'include' }),
        fetch(API('/portal/highlights/templates'), { credentials: 'include' }),
        fetch(API('/portal/my-tournaments'), { credentials: 'include' }),
      ]);
      if (r1.ok) {
        const d = await r1.json();
        setReels(d.reels ?? []);
        setQuota(d.quota ?? null);
      }
      if (r2.ok) {
        const d = await r2.json();
        setTemplates(d.templates ?? []);
      }
      if (r3.ok) {
        const raw: unknown = await r3.json();
        const list: unknown[] = Array.isArray(raw)
          ? raw
          : Array.isArray((raw as { tournaments?: unknown[] })?.tournaments)
            ? (raw as { tournaments: unknown[] }).tournaments
            : [];
        const parsed: Tournament[] = [];
        for (const item of list) {
          if (!item || typeof item !== 'object') continue;
          const o = item as Record<string, unknown>;
          const idVal = typeof o.tournamentId === 'number' ? o.tournamentId
            : typeof o.id === 'number' ? o.id : null;
          if (idVal == null) continue;
          const nameVal = typeof o.tournamentName === 'string' ? o.tournamentName
            : typeof o.name === 'string' ? o.name : `Tournament #${idVal}`;
          parsed.push({ tournamentId: idVal, tournamentName: nameVal });
        }
        setTournaments(parsed);
      }
    } finally {
      setLoading(false);
    }
  }, [sortMode]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  // Poll while pending
  useEffect(() => {
    const pending = reels.some(r => r.status === 'queued' || r.status === 'rendering');
    if (!pending) return;
    const t = setInterval(() => fetchAll(), 3000);
    return () => clearInterval(t);
  }, [reels, fetchAll]);

  const loadCandidates = useCallback(async (tournamentId: number | null) => {
    setCandidatesLoading(true);
    try {
      const qs = tournamentId ? `?tournamentId=${tournamentId}` : '';
      const r = await fetch(API(`/portal/highlights/candidate-media${qs}`), { credentials: 'include' });
      if (r.ok) {
        const d = await r.json();
        setCandidates(Array.isArray(d.media) ? d.media : []);
      } else {
        setCandidates([]);
      }
    } catch {
      setCandidates([]);
    } finally {
      setCandidatesLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!editorOpen) return;
    const tId = editorReel ? editorReel.tournamentId : draftTournamentId;
    loadCandidates(tId ?? null);
  }, [editorOpen, draftTournamentId, editorReel, loadCandidates]);

  const toggleClip = (mediaId: number) => {
    setClipsTouched(true);
    setDraftClips(prev => {
      const idx = prev.findIndex(c => c.mediaId === mediaId);
      if (idx >= 0) return prev.filter((_, i) => i !== idx);
      return [...prev, { mediaId, caption: '' }];
    });
  };

  const moveClip = (mediaId: number, dir: -1 | 1) => {
    setClipsTouched(true);
    setDraftClips(prev => {
      const idx = prev.findIndex(c => c.mediaId === mediaId);
      if (idx < 0) return prev;
      const target = idx + dir;
      if (target < 0 || target >= prev.length) return prev;
      const next = prev.slice();
      const [item] = next.splice(idx, 1);
      next.splice(target, 0, item);
      return next;
    });
  };

  const setClipCaption = (mediaId: number, caption: string) => {
    setClipsTouched(true);
    setDraftClips(prev => prev.map(c => c.mediaId === mediaId ? { ...c, caption } : c));
  };

  // Task #698 / #857 — favorite/unfavorite a caption-style template,
  // optimistic UI matched to the mobile editor. Reverts on failure.
  const toggleSuggestionFavorite = useCallback(async (mediaId: number, suggestion: CaptionSuggestion) => {
    const wasFavorite = suggestion.isFavorite;

    setCandidates(prev => prev.map(c => {
      if (c.id !== mediaId) return c;
      const next = (c.suggestedCaptionTemplates ?? []).map(s =>
        s.pattern === suggestion.pattern
          ? { ...s, isFavorite: !wasFavorite, templateId: wasFavorite ? null : s.templateId }
          : s,
      );
      return { ...c, suggestedCaptionTemplates: next };
    }));

    try {
      if (wasFavorite && suggestion.templateId != null) {
        const r = await fetch(API(`/portal/highlights/caption-templates/${suggestion.templateId}`), {
          method: 'DELETE',
          credentials: 'include',
        });
        if (!r.ok) throw new Error('delete failed');
        setCandidates(prev => prev.map(c => ({
          ...c,
          suggestedCaptionTemplates: (c.suggestedCaptionTemplates ?? []).map(s =>
            s.pattern === suggestion.pattern ? { ...s, isFavorite: false, templateId: null } : s,
          ),
        })));
      } else {
        const r = await fetch(API('/portal/highlights/caption-templates'), {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            pattern: suggestion.pattern,
            tokenKeys: suggestion.tokenKeys,
            sampleCaption: suggestion.text,
          }),
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error || 'save failed');
        const tplId = d?.template?.id ?? null;
        setCandidates(prev => prev.map(c => ({
          ...c,
          suggestedCaptionTemplates: (c.suggestedCaptionTemplates ?? []).map(s =>
            s.pattern === suggestion.pattern ? { ...s, isFavorite: true, templateId: tplId } : s,
          ),
        })));
      }
    } catch (e) {
      setCandidates(prev => prev.map(c => {
        if (c.id !== mediaId) return c;
        const next = (c.suggestedCaptionTemplates ?? []).map(s =>
          s.pattern === suggestion.pattern
            ? { ...s, isFavorite: wasFavorite, templateId: suggestion.templateId }
            : s,
        );
        return { ...c, suggestedCaptionTemplates: next };
      }));
      toast({
        title: "Couldn't update favorite",
        description: e instanceof Error ? e.message : 'Please try again.',
        variant: 'destructive',
      });
    }
  }, [toast]);

  const buildOptions = () => {
    const opts: { caption: string; clips?: { mediaId: number; caption?: string }[] } = {
      caption: draftCaption,
    };
    if (clipsTouched) {
      opts.clips = draftClips.slice(0, 12).map(c => ({
        mediaId: c.mediaId,
        caption: c.caption.trim() || undefined,
      }));
    }
    return opts;
  };

  const resetDraft = () => {
    setDraftTitle('Round Highlights');
    setDraftTemplate('classic');
    setDraftCaption('');
    setDraftTournamentId(null);
    setDraftClips([]);
    setClipsTouched(false);
  };

  const createReel = async () => {
    setSubmitting(true);
    try {
      const r = await fetch(API('/portal/highlights'), {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: draftTitle.trim() || 'Round Highlights',
          templateId: draftTemplate,
          tournamentId: draftTournamentId,
          options: buildOptions(),
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        toast({ title: 'Cannot create reel', description: d.error || 'Please try again', variant: 'destructive' });
      } else {
        setCreatorOpen(false);
        resetDraft();
        await fetchAll();
      }
    } finally {
      setSubmitting(false);
    }
  };

  const reRender = async (reel: Reel) => {
    setSubmitting(true);
    try {
      const r = await fetch(API(`/portal/highlights/${reel.id}`), {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: draftTitle.trim() || reel.title,
          templateId: draftTemplate,
          options: buildOptions(),
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) toast({ title: 'Cannot re-render', description: d.error || 'Please try again', variant: 'destructive' });
      else { setEditorReel(null); resetDraft(); await fetchAll(); }
    } finally { setSubmitting(false); }
  };

  const deleteReel = async (reel: Reel) => {
    if (!window.confirm(`Delete reel "${reel.title}"?`)) return;
    await fetch(API(`/portal/highlights/${reel.id}`), { method: 'DELETE', credentials: 'include' });
    fetchAll();
  };

  const postToFeed = async (reel: Reel) => {
    const r = await fetch(API(`/portal/highlights/${reel.id}/post-to-feed`), {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: reel.title, privacy: 'all_members' }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) toast({ title: 'Cannot post', description: d.error || 'Please try again', variant: 'destructive' });
    else {
      toast({ title: 'Posted', description: 'Your highlight reel is now in the feed.' });
      fetchAll();
    }
  };

  const openEdit = (reel: Reel) => {
    setDraftTitle(reel.title);
    setDraftTemplate(reel.templateId);
    setDraftCaption(reel.options?.caption ?? '');
    const hadClips = Array.isArray(reel.options?.clips);
    const seeded = hadClips
      ? reel.options!.clips!.map(c => ({ mediaId: Number(c.mediaId), caption: c.caption ?? '' }))
      : [];
    setDraftClips(seeded);
    setClipsTouched(hadClips);
    setEditorReel(reel);
  };

  const closeEditor = () => {
    setCreatorOpen(false);
    setEditorReel(null);
    resetDraft();
  };

  const statusVariant = (s: Reel['status']): 'default' | 'secondary' | 'destructive' => {
    if (s === 'ready') return 'default';
    if (s === 'failed') return 'destructive';
    return 'secondary';
  };

  // Task #1012 — compare-mode helpers. Selecting more than MAX_COMPARE
  // reels just no-ops with a toast so producers can't accidentally pile
  // a dozen videos into the modal.
  const totalEngagement = (r: Reel) =>
    (r.viewCount ?? 0) + (r.feedShareCount ?? 0) + (r.shareCount ?? 0) + (r.downloadCount ?? 0);
  const toggleCompareId = (id: number) => {
    setCompareIds(prev => {
      if (prev.includes(id)) return prev.filter(x => x !== id);
      if (prev.length >= MAX_COMPARE) {
        toast({ title: `Pick up to ${MAX_COMPARE} reels`, description: 'Deselect one to add another.' });
        return prev;
      }
      return [...prev, id];
    });
  };
  const exitCompareMode = () => {
    setCompareMode(false);
    setCompareIds([]);
  };
  const compareReels = useMemo(
    () => {
      // Task #1649 — Sort columns by total engagement (descending) so the
      // "Top" reel is always the leftmost column and producers can scan the
      // gap deltas as a clean ladder. Array.prototype.sort is stable, so
      // ties naturally fall back to the order the producer ticked the
      // checkboxes (the order preserved in compareIds).
      const selected = compareIds
        .map(id => reels.find(r => r.id === id))
        .filter((r): r is Reel => !!r);
      return [...selected].sort(
        (a, b) => totalEngagement(b) - totalEngagement(a),
      );
    },
    [compareIds, reels],
  );

  return (
    <div className="min-h-screen bg-background">
      <div className="border-b">
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={() => navigate('/portal')} aria-label="Back to portal">
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <h1 className="text-lg font-semibold flex-1">Highlight Reels</h1>
          <Button onClick={() => { resetDraft(); setCreatorOpen(true); }} data-testid="btn-new-reel">
            <Plus className="h-4 w-4 mr-1" />
            New reel
          </Button>
        </div>
        {quota && (
          <div className="max-w-5xl mx-auto px-4 pb-3 text-xs text-muted-foreground">
            {quota.monthlyLimit >= 9999
              ? `${quota.usedThisMonth} renders this month · Unlimited`
              : `${quota.usedThisMonth} of ${quota.monthlyLimit} renders used this month`}
          </div>
        )}
      </div>

      <div className="max-w-5xl mx-auto px-4 py-6">
        {/* Task #1012 — sort + compare toolbar. Hidden when there are no
            reels yet so the empty state stays uncluttered. */}
        {!loading && reels.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 mb-4" data-testid="highlights-toolbar">
            <span className="text-xs text-muted-foreground mr-1">Sort:</span>
            {([
              { id: 'recent',  label: 'Newest' },
              { id: 'top',     label: 'Top performing', icon: <Trophy className="h-3 w-3 mr-1" /> },
              { id: 'reshared',label: 'Most re-shared' },
            ] as Array<{ id: SortMode; label: string; icon?: React.ReactNode }>).map(opt => (
              <button
                key={opt.id}
                type="button"
                onClick={() => setSortMode(opt.id)}
                className={`text-xs px-2.5 py-1 rounded-full border inline-flex items-center ${sortMode === opt.id ? 'bg-primary text-primary-foreground border-primary' : 'border-border hover:bg-muted'}`}
                data-testid={`btn-sort-${opt.id}`}
              >
                {opt.icon}{opt.label}
              </button>
            ))}
            <div className="flex-1" />
            {compareMode ? (
              <>
                <span className="text-xs text-muted-foreground" data-testid="compare-count">
                  {compareIds.length} of {MAX_COMPARE} selected
                </span>
                <Button
                  size="sm"
                  onClick={() => setCompareOpen(true)}
                  disabled={compareIds.length < 2}
                  data-testid="btn-open-compare"
                >
                  Compare
                </Button>
                <Button size="sm" variant="ghost" onClick={exitCompareMode} data-testid="btn-cancel-compare">
                  Cancel
                </Button>
              </>
            ) : (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setCompareMode(true)}
                data-testid="btn-start-compare"
              >
                <GitCompare className="h-3.5 w-3.5 mr-1" />
                Compare reels
              </Button>
            )}
          </div>
        )}

        {loading ? (
          <div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
        ) : reels.length === 0 ? (
          <Card className="p-10 text-center">
            <VideoIcon className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
            <p className="font-semibold mb-1">No reels yet</p>
            <p className="text-sm text-muted-foreground mb-4">Generate a highlight video from your latest round.</p>
            <Button onClick={() => { resetDraft(); setCreatorOpen(true); }}>Create your first reel</Button>
          </Card>
        ) : (
          <div className="grid gap-3">
            {reels.map((item, idx) => {
              const isSelectedForCompare = compareIds.includes(item.id);
              const showRank = sortMode !== 'recent';
              return (
              <Card
                key={item.id}
                className={`p-4 ${isSelectedForCompare ? 'ring-2 ring-primary' : ''}`}
                data-testid={`reel-card-${item.id}`}
              >
                <div className="flex items-center gap-3 mb-2">
                  {compareMode && (
                    <button
                      type="button"
                      onClick={() => toggleCompareId(item.id)}
                      className={`h-5 w-5 rounded border flex items-center justify-center ${isSelectedForCompare ? 'bg-primary border-primary text-primary-foreground' : 'border-border'}`}
                      aria-label={isSelectedForCompare ? 'Remove from compare' : 'Add to compare'}
                      data-testid={`btn-compare-toggle-${item.id}`}
                    >
                      {isSelectedForCompare && <Check className="h-3 w-3" />}
                    </button>
                  )}
                  {showRank && (
                    <div
                      className="h-6 w-6 rounded-full bg-primary/10 text-primary text-xs font-bold flex items-center justify-center shrink-0"
                      data-testid={`rank-${item.id}`}
                      aria-label={`Rank ${idx + 1}`}
                    >
                      {idx + 1}
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="font-semibold truncate">{item.title}</p>
                    <p className="text-xs text-muted-foreground">
                      {item.templateId} · {new Date(item.createdAt).toLocaleDateString()}
                      {item.durationSeconds ? ` · ${item.durationSeconds}s` : ''}
                    </p>
                  </div>
                  <Badge variant={statusVariant(item.status)}>{item.status}</Badge>
                </div>

                {item.status === 'ready' && item.outputUrl && (
                  <video
                    src={absUrl(item.outputUrl)}
                    poster={item.thumbnailUrl ? absUrl(item.thumbnailUrl) : undefined}
                    controls
                    className="w-full max-h-72 rounded bg-black"
                  />
                )}
                {(item.status === 'queued' || item.status === 'rendering') && (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    {item.status === 'rendering' ? 'Rendering your highlights…' : 'Queued · waiting to render'}
                  </div>
                )}
                {item.status === 'failed' && (
                  <p className="text-xs text-destructive">{item.errorMessage || 'Render failed'}</p>
                )}

                {/* Task #1011 — best-hour badge so producers know when to
                    schedule new posts. Hidden until the reel has events. */}
                {item.bestHour != null && (
                  <div className="mt-2">
                    <Badge
                      variant="outline"
                      className="text-xs"
                      data-testid={`best-hour-${item.id}`}
                    >
                      Best hour: {formatHourLabel(item.bestHour)}
                    </Badge>
                  </div>
                )}

                {/* Task #863 — engagement breakdown chart + trend toggle.
                    Rendered for every row (even when all counts are zero) so
                    producers can see at a glance which reels are actually
                    pulling vs. only getting the obligatory owner download. */}
                <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_auto] items-stretch">
                  <EngagementMiniChart
                    reelId={item.id}
                    downloadCount={item.downloadCount ?? 0}
                    shareCount={item.shareCount ?? 0}
                    viewCount={item.viewCount ?? 0}
                    feedShareCount={item.feedShareCount ?? 0}
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => toggleTrend(item.id)}
                    data-testid={`btn-trend-${item.id}`}
                    className="self-end"
                  >
                    <BarChart3 className="h-3.5 w-3.5 mr-1" />
                    {trendOpen[item.id] ? 'Hide trend' : 'Trend'}
                  </Button>
                </div>
                {trendOpen[item.id] && (
                  <div className="mt-2 p-3 rounded border border-border/40 bg-muted/20" data-testid={`trend-panel-${item.id}`}>
                    <div className="flex items-center justify-between mb-2">
                      <div className="text-xs text-muted-foreground">
                        Last {trendDays} days · <span className="text-blue-500">Views</span> vs <span className="text-purple-500">Re-shares</span>
                      </div>
                      <div className="flex gap-1">
                        {([7, 30] as const).map(d => (
                          <button
                            key={d}
                            type="button"
                            onClick={() => setTrendDays(d)}
                            className={`text-xs px-2 py-0.5 rounded border ${trendDays === d ? 'bg-primary text-primary-foreground border-primary' : 'border-border'}`}
                            data-testid={`btn-trend-${item.id}-${d}d`}
                          >
                            {d}d
                          </button>
                        ))}
                      </div>
                    </div>
                    {trendLoading[item.id] ? (
                      <div className="flex items-center text-xs text-muted-foreground py-3">
                        <Loader2 className="h-3.5 w-3.5 animate-spin mr-2" /> Loading trend…
                      </div>
                    ) : trendData[trendKey(item.id, trendDays)] && trendData[trendKey(item.id, trendDays)].length > 0 ? (
                      <TrendSparkline series={trendData[trendKey(item.id, trendDays)]} />
                    ) : (
                      <div className="text-xs text-muted-foreground py-3">No engagement events in this window yet.</div>
                    )}
                    {/* Task #1011 — hour-of-day heatmap, rendered alongside
                        the daily sparkline so producers can see both "which
                        days" and "which hours" their reel pulls traction. */}
                    {hourlyData[trendKey(item.id, trendDays)] && (
                      <div className="mt-3 pt-3 border-t border-border/40">
                        <div className="text-xs text-muted-foreground mb-1">
                          Hour of day{hourlyData[trendKey(item.id, trendDays)].bestHour != null && (
                            <> · Peak <span className="text-purple-500">{formatHourLabel(hourlyData[trendKey(item.id, trendDays)].bestHour!)}</span></>
                          )}
                        </div>
                        <HourHeatmap
                          hourly={hourlyData[trendKey(item.id, trendDays)].hourly}
                          bestHour={hourlyData[trendKey(item.id, trendDays)].bestHour}
                        />
                      </div>
                    )}
                  </div>
                )}

                <div className="flex flex-wrap gap-2 mt-3">
                  {item.status === 'ready' && !item.feedPostId && (
                    <Button size="sm" variant="secondary" onClick={() => postToFeed(item)}>
                      <Send className="h-3.5 w-3.5 mr-1" /> Post to feed
                    </Button>
                  )}
                  {item.feedPostId && (
                    <Badge variant="outline" className="self-center">Posted</Badge>
                  )}
                  {!item.feedPostId && item.status !== 'rendering' && (
                    <Button size="sm" variant="outline" onClick={() => openEdit(item)} data-testid={`btn-edit-${item.id}`}>
                      <Pencil className="h-3.5 w-3.5 mr-1" /> Edit & re-render
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" onClick={() => deleteReel(item)}>
                    <Trash2 className="h-3.5 w-3.5 text-destructive" />
                  </Button>
                </div>
              </Card>
              );
            })}
          </div>
        )}
      </div>

      {/* Task #1012 — Compare modal. Lays out 2-3 selected reels side by
          side so producers can eyeball which one is winning each
          engagement category. Uses the existing EngagementMiniChart so
          the bars match the per-row chart 1:1. */}
      <Dialog open={compareOpen} onOpenChange={(open) => { if (!open) setCompareOpen(false); }}>
        <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto" data-testid="compare-modal">
          <DialogHeader>
            <DialogTitle>{t('compareModal.title')}</DialogTitle>
          </DialogHeader>
          {compareReels.length < 2 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">
              {t('compareModal.empty')}
            </p>
          ) : (() => {
            // Task #1376 — pre-compute the winner once so every non-winning
            // column can render its per-metric gap to that winner. We treat
            // the column with the highest TOTAL engagement as the reference
            // (matches the "Top" badge logic above) and only surface the
            // gap section when there is a real top performer (total > 0).
            const winner = compareReels.reduce(
              (m, c) => totalEngagement(c) > totalEngagement(m) ? c : m,
              compareReels[0],
            );
            const winnerTotal = totalEngagement(winner);
            const gapMetrics: { key: 'views' | 'feedShares' | 'shares' | 'downloads'; label: string; get: (x: Reel) => number }[] = [
              { key: 'views',      label: t('compareModal.views'),      get: x => x.viewCount ?? 0 },
              { key: 'feedShares', label: t('compareModal.feedShares'), get: x => x.feedShareCount ?? 0 },
              { key: 'shares',     label: t('compareModal.shares'),     get: x => x.shareCount ?? 0 },
              { key: 'downloads',  label: t('compareModal.downloads'),  get: x => x.downloadCount ?? 0 },
            ];
            return (
            <div className={`grid gap-4 ${compareReels.length === 3 ? 'sm:grid-cols-3' : 'sm:grid-cols-2'}`}>
              {compareReels.map(r => {
                const total = totalEngagement(r);
                const isWinner = r.id === winner.id && total > 0;
                const showGap = !isWinner && winnerTotal > 0;
                return (
                  <div key={r.id} className="border rounded-lg p-3 flex flex-col gap-2" data-testid={`compare-col-${r.id}`}>
                    <div className="flex items-center gap-2">
                      <p className="font-semibold text-sm flex-1 truncate">{r.title}</p>
                      {isWinner && (
                        <Badge className="bg-yellow-400 text-black hover:bg-yellow-400" data-testid={`compare-winner-${r.id}`}>
                          <Trophy className="h-3 w-3 mr-1" /> {t('compareModal.top')}
                        </Badge>
                      )}
                    </div>
                    <p className="text-[11px] text-muted-foreground">
                      {r.templateId} · {new Date(r.createdAt).toLocaleDateString()}
                    </p>
                    {r.status === 'ready' && r.thumbnailUrl ? (
                      <img
                        src={absUrl(r.thumbnailUrl)}
                        alt=""
                        className="w-full aspect-video object-cover rounded bg-black"
                      />
                    ) : (
                      <div className="w-full aspect-video rounded bg-muted flex items-center justify-center">
                        <VideoIcon className="h-6 w-6 text-muted-foreground" />
                      </div>
                    )}
                    <EngagementMiniChart
                      reelId={r.id}
                      downloadCount={r.downloadCount ?? 0}
                      shareCount={r.shareCount ?? 0}
                      viewCount={r.viewCount ?? 0}
                      feedShareCount={r.feedShareCount ?? 0}
                    />
                    <div className="text-xs text-muted-foreground" data-testid={`compare-total-${r.id}`}>
                      {t('compareModal.totalEngagementLabel')} <span className="font-semibold text-foreground">{total}</span>
                    </div>
                    {showGap && (
                      // Task #1376 — per-metric gap to the "Top" reel so
                      // producers don't have to mentally subtract totals
                      // when deciding which reel to push to the feed.
                      <div
                        className="border-t pt-2 mt-1 flex flex-col gap-0.5 text-[11px]"
                        data-testid={`compare-gap-${r.id}`}
                      >
                        <p className="text-muted-foreground">{t('compareModal.gapTo', { winner: winner.title })}</p>
                        {gapMetrics.map(m => {
                          const diff = m.get(r) - m.get(winner);
                          const tied = diff === 0;
                          return (
                            <div
                              key={m.key}
                              className="flex justify-between"
                              data-testid={`compare-gap-${r.id}-${m.key}`}
                            >
                              <span className="text-muted-foreground">{m.label}</span>
                              <span className={tied ? 'text-muted-foreground' : 'text-destructive font-medium'}>
                                {tied ? t('compareModal.tied') : diff > 0 ? `+${diff}` : `${diff}`}
                              </span>
                            </div>
                          );
                        })}
                        <div
                          className="flex justify-between border-t pt-0.5 mt-0.5"
                          data-testid={`compare-gap-${r.id}-total`}
                        >
                          <span className="text-muted-foreground">{t('compareModal.total')}</span>
                          <span className={total === winnerTotal ? 'text-muted-foreground' : 'text-destructive font-semibold'}>
                            {total === winnerTotal ? t('compareModal.tied') : `${total - winnerTotal}`}
                          </span>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            );
          })()}
          <DialogFooter>
            <Button variant="outline" onClick={() => setCompareOpen(false)}>{t('compareModal.close')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Editor Modal */}
      <Dialog open={editorOpen} onOpenChange={(open) => { if (!open) closeEditor(); }}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editorReel ? 'Edit & re-render' : 'New highlight reel'}</DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium mb-1 block">Title</label>
              <Input value={draftTitle} onChange={e => setDraftTitle(e.target.value)} placeholder="Round Highlights" />
            </div>

            <div>
              <label className="text-sm font-medium mb-1 block">Caption (optional)</label>
              <Textarea
                value={draftCaption}
                onChange={e => setDraftCaption(e.target.value)}
                placeholder="Tell the club about your round…"
                rows={2}
              />
            </div>

            {!editorReel && tournaments.length > 0 && (
              <div>
                <label className="text-sm font-medium mb-1 block">Tournament (optional)</label>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => setDraftTournamentId(null)}
                    className={`px-3 py-1 rounded-full text-xs border ${draftTournamentId == null ? 'bg-primary text-primary-foreground border-primary' : 'bg-background'}`}
                  >
                    None
                  </button>
                  {tournaments.slice(0, 8).map(t => (
                    <button
                      key={t.tournamentId}
                      type="button"
                      onClick={() => setDraftTournamentId(t.tournamentId)}
                      className={`px-3 py-1 rounded-full text-xs border ${draftTournamentId === t.tournamentId ? 'bg-primary text-primary-foreground border-primary' : 'bg-background'}`}
                    >
                      {t.tournamentName}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div>
              <label className="text-sm font-medium mb-1 block">Clips & photos</label>
              <p className="text-xs text-muted-foreground mb-2">
                Pick which photos and shot videos appear in your reel and add a caption to each. Use the arrows to reorder.
              </p>

              {draftClips.length > 0 && (
                <div className="space-y-3 mb-3">
                  {draftClips.map((c, i) => {
                    const m = candidateById.get(c.mediaId);
                    const rich = m?.suggestedCaptionTemplates ?? [];
                    const fallback: CaptionSuggestion[] = (m?.suggestedCaptions ?? []).map(t => ({
                      text: t, pattern: t, tokenKeys: [], tokens: {}, isFavorite: false, templateId: null,
                    }));
                    const list = rich.length > 0 ? rich : fallback;
                    return (
                      <div key={c.mediaId} className="flex gap-3 p-2 border rounded">
                        <div className="text-xs font-semibold w-6 text-center pt-2">{i + 1}</div>
                        {m?.thumbnailUrl ? (
                          <img src={absUrl(m.thumbnailUrl)} alt="" className="w-16 h-16 object-cover rounded" />
                        ) : (
                          <div className="w-16 h-16 rounded bg-muted flex items-center justify-center">
                            {m?.mediaType === 'video' ? <VideoIcon className="h-5 w-5 text-muted-foreground" /> : <ImageIcon className="h-5 w-5 text-muted-foreground" />}
                          </div>
                        )}
                        <div className="flex-1 min-w-0">
                          <Input
                            value={c.caption}
                            onChange={e => setClipCaption(c.mediaId, e.target.value)}
                            placeholder="Caption (optional)"
                            maxLength={140}
                            className="h-8 text-sm"
                            data-testid={`input-caption-${c.mediaId}`}
                          />
                          {list.length > 0 && (
                            <div className="flex flex-wrap gap-1 mt-1.5" data-testid={`suggestions-${c.mediaId}`}>
                              {list.map((s, si) => {
                                const canFavorite = s.tokenKeys.length > 0;
                                return (
                                  <span
                                    key={si}
                                    className={`inline-flex items-center gap-1 rounded-full border text-xs pl-2 ${s.isFavorite ? 'border-yellow-400 bg-yellow-400/10' : 'border-border'}`}
                                  >
                                    <button
                                      type="button"
                                      onClick={() => setClipCaption(c.mediaId, s.text)}
                                      className="inline-flex items-center gap-1 py-0.5"
                                      data-testid={`suggestion-${c.mediaId}-${si}`}
                                    >
                                      <Zap className={`h-3 w-3 ${s.isFavorite ? 'text-yellow-500' : 'text-primary'}`} />
                                      <span className="truncate max-w-[180px]">{s.text}</span>
                                    </button>
                                    {canFavorite && (
                                      <button
                                        type="button"
                                        onClick={() => toggleSuggestionFavorite(c.mediaId, s)}
                                        className="px-1.5 py-0.5 rounded-r-full hover:bg-muted"
                                        aria-label={s.isFavorite ? 'Unfavorite caption style' : 'Favorite caption style'}
                                        data-testid={`star-${c.mediaId}-${si}`}
                                      >
                                        <Star
                                          className={`h-3 w-3 ${s.isFavorite ? 'fill-yellow-400 text-yellow-500' : 'text-muted-foreground'}`}
                                        />
                                      </button>
                                    )}
                                  </span>
                                );
                              })}
                            </div>
                          )}
                          <p className="text-[10px] text-muted-foreground mt-1">
                            {m?.mediaType === 'video' ? 'Video' : 'Photo'}{m?.holeNumber ? ` · Hole ${m.holeNumber}` : ''}
                          </p>
                        </div>
                        <div className="flex flex-col gap-1">
                          <Button size="icon" variant="outline" className="h-7 w-7" disabled={i === 0} onClick={() => moveClip(c.mediaId, -1)}>
                            <ArrowUp className="h-3 w-3" />
                          </Button>
                          <Button size="icon" variant="outline" className="h-7 w-7" disabled={i === draftClips.length - 1} onClick={() => moveClip(c.mediaId, 1)}>
                            <ArrowDown className="h-3 w-3" />
                          </Button>
                          <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => toggleClip(c.mediaId)}>
                            <X className="h-3 w-3 text-destructive" />
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {candidatesLoading ? (
                <div className="flex justify-center py-4"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>
              ) : candidates.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No photos or videos available yet{draftTournamentId ? ' for this tournament' : ''}. Upload media to your round and they will show up here.
                </p>
              ) : (
                <div className="flex gap-2 overflow-x-auto pb-2">
                  {candidates.map(m => {
                    const selected = draftClips.some(c => c.mediaId === m.id);
                    return (
                      <button
                        key={m.id}
                        type="button"
                        onClick={() => toggleClip(m.id)}
                        className={`relative shrink-0 w-20 h-20 rounded overflow-hidden border-2 ${selected ? 'border-primary' : 'border-transparent'}`}
                        data-testid={`candidate-${m.id}`}
                      >
                        {m.thumbnailUrl ? (
                          <img src={absUrl(m.thumbnailUrl)} alt="" className="w-full h-full object-cover" />
                        ) : (
                          <div className="w-full h-full bg-muted flex items-center justify-center">
                            {m.mediaType === 'video' ? <VideoIcon className="h-5 w-5" /> : <ImageIcon className="h-5 w-5" />}
                          </div>
                        )}
                        {m.mediaType === 'video' && (
                          <div className="absolute bottom-1 left-1 bg-black/60 text-white rounded p-0.5">
                            <Play className="h-2.5 w-2.5" />
                          </div>
                        )}
                        {selected && (
                          <div className="absolute top-1 right-1 bg-primary text-primary-foreground rounded-full p-0.5">
                            <Check className="h-3 w-3" />
                          </div>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            <div>
              <label className="text-sm font-medium mb-1 block">Template</label>
              <div className="space-y-2">
                {templates.map(tpl => (
                  <button
                    key={tpl.id}
                    type="button"
                    onClick={() => setDraftTemplate(tpl.id)}
                    className={`w-full text-left flex items-center gap-3 p-3 border rounded ${draftTemplate === tpl.id ? 'border-primary' : ''}`}
                  >
                    <div className="w-3 h-10 rounded" style={{ backgroundColor: tpl.primaryColor }} />
                    <div className="flex-1">
                      <p className="font-medium text-sm">{tpl.name}</p>
                      <p className="text-xs text-muted-foreground">{tpl.description}</p>
                      <p className="text-[10px] text-muted-foreground">{tpl.durationSeconds}s</p>
                    </div>
                    {draftTemplate === tpl.id && <Check className="h-4 w-4 text-primary" />}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={closeEditor}>Cancel</Button>
            <Button
              onClick={() => editorReel ? reRender(editorReel) : createReel()}
              disabled={submitting}
              data-testid="btn-submit-reel"
            >
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : (editorReel ? 'Re-render' : 'Generate')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
