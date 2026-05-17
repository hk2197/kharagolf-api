import { useState, useMemo, useEffect, Fragment } from 'react';
import { Link } from 'wouter';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useGetMe } from '@workspace/api-client-react';
import { useActiveOrgId } from '@/context/ActiveOrgContext';
import {
  LineChart, Line, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer, CartesianGrid,
} from 'recharts';
import {
  Activity, RefreshCw, Download, Loader2, Database, Pencil, Save, X, Palette, RotateCcw, History,
  FolderTree, GripVertical,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Textarea } from '@/components/ui/textarea';

const BASE_URL = (import.meta.env.BASE_URL ?? '/').replace(/\/$/, '');
function API(path: string) { return `${BASE_URL}/api${path}`; }

// Fallback used until the API responds — keeps the UI useful on first paint
// and on degraded networks. The authoritative list comes from /events/names.
const FALLBACK_EVENTS = [
  'player_login',
  'tournament_registration',
  'tee_booking_created',
  'scorecard_submitted',
  'payment_settled',
  // Included so the channel breakdown (push vs in-app) is visible to admins
  // on the first load — without this, `selectedEvents` is set from the
  // fallback before `/events/names` lands and `notification_opened` would
  // stay un-ticked until an admin manually toggled it on.
  'notification_opened',
] as const;

// Stable, named colors for the well-known seed events. Anything new is given
// a deterministic color from the palette below so newly instrumented flows
// always render consistently across reloads.
const EVENT_COLORS: Record<string, string> = {
  player_login: '#3b82f6',
  tournament_registration: '#a855f7',
  tee_booking_created: '#22c55e',
  scorecard_submitted: '#f59e0b',
  payment_settled: '#ef4444',
  lesson_booked: '#06b6d4',
  fb_order_placed: '#f97316',
  shop_checkout_completed: '#84cc16',
  notification_opened: '#ec4899',
};

const FALLBACK_PALETTE = [
  '#14b8a6', '#8b5cf6', '#eab308', '#f43f5e', '#0ea5e9',
  '#22d3ee', '#a3e635', '#fb7185', '#c084fc', '#fbbf24',
];

function defaultColorFor(eventName: string): string {
  if (EVENT_COLORS[eventName]) return EVENT_COLORS[eventName];
  let h = 0;
  for (let i = 0; i < eventName.length; i++) {
    h = (h * 31 + eventName.charCodeAt(i)) >>> 0;
  }
  return FALLBACK_PALETTE[h % FALLBACK_PALETTE.length];
}

// Per-event admin overrides. Task #1318 — admins can give each event a
// friendly label, description, and chart color so the dashboard reads
// naturally as more flows get instrumented.
//
// Task #1570 — also carries the editor's display name + last-edit
// timestamp so the Customize tab can render "Last edited by <name> on
// <date>" beside each customized event.
interface EventMetadata {
  displayName: string | null;
  description: string | null;
  color: string | null;
  // Optional category (Task #1569). Free-text — null/empty groups the
  // event under "Uncategorized" in the dashboard.
  category: string | null;
  updatedAt?: string | null;
  updatedByUserId?: number | null;
  updatedByName?: string | null;
}

type EventMetadataMap = Record<string, EventMetadata>;

const UNCATEGORIZED = 'Uncategorized';

function categoryFor(eventName: string, meta?: EventMetadataMap): string {
  const c = meta?.[eventName]?.category;
  return c && c.length > 0 ? c : UNCATEGORIZED;
}

// Group event names by their assigned category. Uncategorized events
// land in a trailing bucket so they don't get lost when admins haven't
// finished sorting them yet. Within each bucket, events stay in the
// order they were given (which the API already sorts alphabetically).
//
// Task #1959 — when `orderedCategories` is provided, named buckets
// follow that order; categories not in the list (newly created and
// not yet re-ordered) trail in alphabetical order so the dashboard
// still renders deterministically.
function groupByCategory(
  events: string[],
  meta: EventMetadataMap,
  orderedCategories?: string[] | null,
): { category: string; events: string[] }[] {
  const buckets = new Map<string, string[]>();
  for (const evt of events) {
    const cat = categoryFor(evt, meta);
    let list = buckets.get(cat);
    if (!list) { list = []; buckets.set(cat, list); }
    list.push(evt);
  }
  const orderMap = new Map<string, number>();
  if (orderedCategories) {
    for (let i = 0; i < orderedCategories.length; i++) {
      orderMap.set(orderedCategories[i], i);
    }
  }
  const named = Array.from(buckets.entries())
    .filter(([c]) => c !== UNCATEGORIZED)
    .sort(([a], [b]) => {
      const pa = orderMap.has(a) ? orderMap.get(a)! : Number.POSITIVE_INFINITY;
      const pb = orderMap.has(b) ? orderMap.get(b)! : Number.POSITIVE_INFINITY;
      if (pa !== pb) return pa - pb;
      return a.localeCompare(b);
    });
  const uncategorized = buckets.get(UNCATEGORIZED);
  const out = named.map(([category, evts]) => ({ category, events: evts }));
  if (uncategorized) out.push({ category: UNCATEGORIZED, events: uncategorized });
  return out;
}

function labelFor(eventName: string, meta?: EventMetadataMap): string {
  const dn = meta?.[eventName]?.displayName;
  return dn && dn.length > 0 ? dn : eventName;
}

function colorFor(eventName: string, meta?: EventMetadataMap): string {
  const c = meta?.[eventName]?.color;
  if (c && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(c)) return c;
  return defaultColorFor(eventName);
}

interface EventNamesData {
  events: string[];
  // Map from eventName → admin overrides. Optional for backwards compat
  // with older API server responses that haven't been redeployed yet.
  metadata?: EventMetadataMap;
  // Distinct categories already in use across this org's metadata rows
  // (Task #1569). Optional for backwards compat — older API responses
  // omit it. The Customize tab uses it as a datalist of suggestions.
  categories?: string[];
  // Admin-chosen category display order (Task #1959). When present and
  // non-empty, listed categories render in this order across the
  // Customize tab, totals tiles, chart legend, and filter dropdown.
  // Categories not in the list fall back to alphabetical.
  categoryOrder?: string[];
  lookbackDays: number;
}

interface MetadataListRow {
  eventName: string;
  displayName: string | null;
  description: string | null;
  color: string | null;
  category: string | null;
  updatedAt: string;
  updatedByUserId: number | null;
  updatedByName: string | null;
}

interface MetadataListData {
  metadata: MetadataListRow[];
}

interface NotificationOpenedBreakdown {
  totals: { push: number; in_app: number };
  series: Array<{ day: string; push: number; in_app: number }>;
}

// Task #1570 — recent-changes timeline rows for a single event.
interface MetadataHistoryRow {
  id: number;
  action: 'upsert' | 'delete';
  displayName: string | null;
  description: string | null;
  color: string | null;
  changedAt: string;
  changedByUserId: number | null;
  changedByName: string | null;
}

interface MetadataHistoryData {
  eventName: string;
  history: MetadataHistoryRow[];
}

interface SummaryData {
  from: string;
  to: string;
  events: string[];
  totals: Record<string, number>;
  series: ({ day: string } & Record<string, number>)[];
  // Per-channel split for `notification_opened` (Task #1563). Present only
  // when the event is included in the filter and the API server has been
  // upgraded; older servers omit the field entirely.
  breakdowns?: {
    notification_opened?: NotificationOpenedBreakdown;
  };
}

// Synthetic dataKeys used to render the push vs in-app split as separate
// lines/tiles. These keys never appear in `totals` — they're derived from
// the breakdown payload — so they can't collide with a real event name
// (event names are identifier-shaped per EVENT_NAME_RE on the API side).
const NOTIF_PUSH_KEY = 'notification_opened__push';
const NOTIF_IN_APP_KEY = 'notification_opened__in_app';
// Fixed companion color for the in-app channel so it stays visually
// distinct from the existing notification_opened pink reserved for push.
const NOTIF_IN_APP_COLOR = '#818cf8';

interface RenderedTile {
  key: string;          // unique key for the tile + line `dataKey`
  eventName: string;    // underlying event (for testid stability + tooltip)
  label: string;        // user-facing label rendered in the tile/legend
  color: string;
  total: number;
  description?: string | null;
}

interface RawEventRow {
  id: number;
  eventName: string;
  organizationId: number | null;
  userId: number | null;
  surface: string;
  payload: Record<string, unknown>;
  requestId: string | null;
  occurredAt: string;
  userDisplayName: string | null;
  userEmail: string | null;
  userUsername: string | null;
}

interface RawData {
  from: string;
  to: string;
  events: string[];
  total: number;
  limit: number;
  offset: number;
  rows: RawEventRow[];
}

async function apiFetch<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

function isoToLocalInput(iso: string): string {
  return iso.slice(0, 10);
}

function defaultRange(): { from: string; to: string } {
  const now = new Date();
  const past = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  return { from: isoToLocalInput(past.toISOString()), to: isoToLocalInput(now.toISOString()) };
}

export default function AdminAnalyticsPage() {
  const activeOrgId = useActiveOrgId();
  const { data: me } = useGetMe();
  const isSuperAdmin = me?.role === 'super_admin';

  const init = defaultRange();
  const [fromDate, setFromDate] = useState(init.from);
  const [toDate, setToDate] = useState(init.to);
  const [selectedEvents, setSelectedEvents] = useState<string[] | null>(null);
  const [rawLimit] = useState(100);
  const [rawOffset, setRawOffset] = useState(0);
  const [userFilterInput, setUserFilterInput] = useState('');
  const [userFilter, setUserFilter] = useState('');
  // Task #1569 — when set, totals tiles, the trends chart, and the CSV
  // export are filtered to only the events in that category. `null`
  // means "all categories" (the default). Toggling "Group by category"
  // separately reorganizes the totals tiles and chart legend without
  // narrowing the data.
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);
  const [groupByCategoryToggle, setGroupByCategoryToggle] = useState(false);
  // Task #1948 — admins can independently toggle the Push and In-App
  // notification channels. Both default to true so the dashboard reads
  // exactly as it did before the toggle existed (push + in-app combined).
  const [showPushChannel, setShowPushChannel] = useState(true);
  const [showInAppChannel, setShowInAppChannel] = useState(true);

  useEffect(() => {
    const t = setTimeout(() => setUserFilter(userFilterInput.trim()), 300);
    return () => clearTimeout(t);
  }, [userFilterInput]);

  const fromIso = useMemo(() => new Date(`${fromDate}T00:00:00`).toISOString(), [fromDate]);
  const toIso = useMemo(() => new Date(`${toDate}T23:59:59`).toISOString(), [toDate]);

  const eventNamesQuery = useQuery<EventNamesData>({
    queryKey: ['admin-analytics-event-names', activeOrgId],
    queryFn: () => apiFetch(API(`/organizations/${activeOrgId}/analytics/events/names`)),
    enabled: !!activeOrgId,
  });

  const availableEvents = useMemo<string[]>(() => {
    if (eventNamesQuery.data?.events?.length) return eventNamesQuery.data.events;
    return [...FALLBACK_EVENTS];
  }, [eventNamesQuery.data]);

  // Admin-customized labels/colors merged into the dashboard. Falls back
  // to the raw event name and a deterministic palette color when no
  // metadata row exists for an event.
  const eventMetadata = useMemo<EventMetadataMap>(
    () => eventNamesQuery.data?.metadata ?? {},
    [eventNamesQuery.data],
  );

  // Task #1959 — per-org admin-chosen category order. Used everywhere
  // categories are listed so dragging in the Customize tab also
  // re-orders the totals tiles, chart legend, and filter dropdown.
  const categoryOrder = useMemo<string[]>(
    () => eventNamesQuery.data?.categoryOrder ?? [],
    [eventNamesQuery.data],
  );

  // Default-select every available event the first time the API list lands.
  useEffect(() => {
    if (selectedEvents === null && availableEvents.length > 0) {
      setSelectedEvents(availableEvents);
    }
  }, [availableEvents, selectedEvents]);

  const baseSelected = selectedEvents ?? availableEvents;
  // Apply the optional category filter on top of the user's per-event
  // selections. When the filter is set to a category, only events
  // belonging to that category contribute to totals/series/exports.
  // Task #1948 — when both notification channels are toggled off, drop
  // `notification_opened` from the effective selection so the dashboard
  // behaves as if the event was unticked (no tiles, no chart line, no
  // wasted server query).
  const effectiveSelected = useMemo(() => {
    let list = baseSelected;
    if (categoryFilter) {
      list = list.filter((e) => categoryFor(e, eventMetadata) === categoryFilter);
    }
    if (!showPushChannel && !showInAppChannel) {
      list = list.filter((e) => e !== 'notification_opened');
    }
    return list;
  }, [baseSelected, categoryFilter, eventMetadata, showPushChannel, showInAppChannel]);
  const eventsParam = effectiveSelected.length > 0 ? effectiveSelected.join(',') : '';

  // Distinct categories surfaced from the API (or derived locally as a
  // fallback when older API responses don't include the field). Used to
  // populate the category filter dropdown above the totals tiles.
  //
  // Task #1959 — when the API returns the list, it's already sorted
  // by the admin's chosen order (with unranked categories trailing
  // alphabetically). The local fallback applies the same rule using
  // `categoryOrder` so the dropdown order matches the rest of the UI.
  const availableCategories = useMemo<string[]>(() => {
    if (eventNamesQuery.data?.categories?.length) return eventNamesQuery.data.categories;
    const set = new Set<string>();
    for (const evt of availableEvents) {
      const c = eventMetadata[evt]?.category;
      if (c && c.length > 0) set.add(c);
    }
    const orderMap = new Map<string, number>();
    for (let i = 0; i < categoryOrder.length; i++) orderMap.set(categoryOrder[i], i);
    return Array.from(set).sort((a, b) => {
      const pa = orderMap.has(a) ? orderMap.get(a)! : Number.POSITIVE_INFINITY;
      const pb = orderMap.has(b) ? orderMap.get(b)! : Number.POSITIVE_INFINITY;
      if (pa !== pb) return pa - pb;
      return a.localeCompare(b);
    });
  }, [eventNamesQuery.data, availableEvents, eventMetadata, categoryOrder]);

  // Reset to "all categories" if the active filter no longer matches
  // any known category (e.g. the admin just deleted that label).
  useEffect(() => {
    if (categoryFilter && !availableCategories.includes(categoryFilter)) {
      setCategoryFilter(null);
    }
  }, [availableCategories, categoryFilter]);

  // Task #1948 — only forward the channel param when at least one channel
  // is unticked; otherwise leave it off so the cache key (and the API
  // response) stay identical to the pre-#1948 default.
  const channelParam = useMemo(() => {
    if (showPushChannel && showInAppChannel) return '';
    const list: string[] = [];
    if (showPushChannel) list.push('push');
    if (showInAppChannel) list.push('in_app');
    return list.join(',');
  }, [showPushChannel, showInAppChannel]);

  const summaryQuery = useQuery<SummaryData>({
    queryKey: ['admin-analytics-summary', activeOrgId, fromIso, toIso, eventsParam, channelParam],
    queryFn: () => apiFetch(
      API(`/organizations/${activeOrgId}/analytics/events/summary?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}&events=${encodeURIComponent(eventsParam)}${channelParam ? `&channel=${encodeURIComponent(channelParam)}` : ''}`),
    ),
    enabled: !!activeOrgId && effectiveSelected.length > 0,
  });

  const rawQuery = useQuery<RawData>({
    queryKey: ['admin-analytics-raw', activeOrgId, fromIso, toIso, eventsParam, rawLimit, rawOffset, userFilter],
    queryFn: () => apiFetch(
      API(`/organizations/${activeOrgId}/analytics/events/raw?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}&events=${encodeURIComponent(eventsParam)}&limit=${rawLimit}&offset=${rawOffset}${userFilter ? `&user=${encodeURIComponent(userFilter)}` : ''}`),
    ),
    enabled: !!activeOrgId && isSuperAdmin,
  });

  useEffect(() => {
    setRawOffset(0);
  }, [activeOrgId, fromIso, toIso, eventsParam, userFilter]);

  const toggleEvent = (name: string) => {
    setSelectedEvents((prev) => {
      const base = prev ?? availableEvents;
      return base.includes(name) ? base.filter((e) => e !== name) : [...base, name];
    });
  };

  const handleExportCsv = () => {
    if (!activeOrgId) return;
    // The category filter is applied client-side by narrowing
    // `effectiveSelected` (and therefore `eventsParam`) before the
    // export call, so /events/export already only sees the events in
    // the chosen category. No new server-side `?category=` is needed.
    const url = API(
      `/organizations/${activeOrgId}/analytics/events/export?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}&events=${encodeURIComponent(eventsParam)}${userFilter ? `&user=${encodeURIComponent(userFilter)}` : ''}`,
    );
    window.open(url, '_blank');
  };

  if (!activeOrgId) {
    return (
      <div className="p-8 text-center" data-testid="admin-analytics-no-org">
        <p className="text-muted-foreground">Select a club to view analytics events</p>
      </div>
    );
  }

  const totals = summaryQuery.data?.totals ?? {};
  const series = summaryQuery.data?.series ?? [];
  const notifBreakdown = summaryQuery.data?.breakdowns?.notification_opened;

  // Build the rendered tiles + chart series. When the API returns a
  // `notification_opened` breakdown we replace the combined entry with two
  // synthetic entries (push, in-app) so admins can see at a glance whether
  // a spike came from native push or in-app card opens (Task #1563).
  // push + in-app is guaranteed by the API to equal the combined total.
  const renderedTiles = useMemo<RenderedTile[]>(() => {
    return effectiveSelected.flatMap((evt) => {
      if (evt === 'notification_opened' && notifBreakdown) {
        const baseLabel = labelFor(evt, eventMetadata);
        const baseColor = colorFor(evt, eventMetadata);
        const desc = eventMetadata[evt]?.description ?? null;
        const tiles: RenderedTile[] = [];
        // Task #1948 — only render the channel tiles that are toggled on.
        // The API has already zeroed out unselected channels, but hiding
        // their tiles keeps the dashboard from showing confusing "(push) 0"
        // cards when an admin has explicitly turned a channel off.
        if (showPushChannel) {
          tiles.push({
            key: NOTIF_PUSH_KEY,
            eventName: evt,
            label: `${baseLabel} (push)`,
            color: baseColor,
            total: notifBreakdown.totals.push,
            description: desc,
          });
        }
        if (showInAppChannel) {
          tiles.push({
            key: NOTIF_IN_APP_KEY,
            eventName: evt,
            label: `${baseLabel} (in-app)`,
            color: NOTIF_IN_APP_COLOR,
            total: notifBreakdown.totals.in_app,
            description: desc,
          });
        }
        return tiles;
      }
      return [{
        key: evt,
        eventName: evt,
        label: labelFor(evt, eventMetadata),
        color: colorFor(evt, eventMetadata),
        total: totals[evt] ?? 0,
        description: eventMetadata[evt]?.description ?? null,
      }];
    });
  }, [effectiveSelected, eventMetadata, totals, notifBreakdown, showPushChannel, showInAppChannel]);

  // Merge the per-channel breakdown into the day-by-day series so the chart
  // can render the two synthetic dataKeys alongside the real event series.
  const renderedSeries = useMemo(() => {
    if (!notifBreakdown) return series;
    const byDay = new Map<string, { day: string } & Record<string, number>>();
    for (const row of series) {
      // Default both synthetic keys to 0 so days with no notification opens
      // still draw a continuous push/in-app line in the chart instead of
      // breaking when Recharts hits an undefined value.
      byDay.set(row.day, { ...row, [NOTIF_PUSH_KEY]: 0, [NOTIF_IN_APP_KEY]: 0 });
    }
    for (const r of notifBreakdown.series) {
      const existing = byDay.get(r.day) ?? { day: r.day, [NOTIF_PUSH_KEY]: 0, [NOTIF_IN_APP_KEY]: 0 } as { day: string } & Record<string, number>;
      existing[NOTIF_PUSH_KEY] = r.push;
      existing[NOTIF_IN_APP_KEY] = r.in_app;
      byDay.set(r.day, existing);
    }
    return Array.from(byDay.values()).sort((a, b) => a.day.localeCompare(b.day));
  }, [series, notifBreakdown]);

  // Pre-compute the grouped layout for the totals tiles and chart
  // legend so we can render them either flat or grouped without
  // restructuring the markup (Task #1569). When `groupByCategoryToggle`
  // is off, we still render a single bucket so the same JSX is reused.
  const groupedSelected = useMemo(() => {
    if (!groupByCategoryToggle) {
      return [{ category: '', events: effectiveSelected }];
    }
    return groupByCategory(effectiveSelected, eventMetadata, categoryOrder);
  }, [effectiveSelected, eventMetadata, groupByCategoryToggle, categoryOrder]);

  // Per-category totals shown above each grouped block when "Group by
  // category" is on — gives admins a quick read of the bucket size.
  const categoryTotals = useMemo<Record<string, number>>(() => {
    const out: Record<string, number> = {};
    for (const grp of groupedSelected) {
      let sum = 0;
      for (const evt of grp.events) sum += totals[evt] ?? 0;
      out[grp.category] = sum;
    }
    return out;
  }, [groupedSelected, totals]);

  return (
    <div className="p-4 md:p-6 space-y-6 max-w-7xl mx-auto" data-testid="page-admin-analytics">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2">
            <Activity className="w-6 h-6 text-primary" />
            Analytics Events
          </h1>
          <p className="text-muted-foreground text-sm mt-0.5">
            Live feed of instrumented events — signups, bookings, scorecards, and payments.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            className="border-white/10"
            onClick={() => { summaryQuery.refetch(); if (isSuperAdmin) rawQuery.refetch(); }}
            data-testid="button-refresh"
          >
            <RefreshCw className={`w-4 h-4 ${summaryQuery.isFetching ? 'animate-spin' : ''}`} />
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="border-white/10"
            onClick={handleExportCsv}
            data-testid="button-export-csv"
          >
            <Download className="w-4 h-4 mr-1" /> CSV
          </Button>
        </div>
      </div>

      <Card className="glass-card border-none">
        <CardContent className="pt-4 pb-4 space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div>
              <Label className="text-xs text-muted-foreground">From</Label>
              <Input
                type="date"
                value={fromDate}
                onChange={(e) => setFromDate(e.target.value)}
                className="bg-white/5 border-white/10 text-white"
                data-testid="input-from-date"
              />
            </div>
            <div>
              <Label className="text-xs text-muted-foreground">To</Label>
              <Input
                type="date"
                value={toDate}
                onChange={(e) => setToDate(e.target.value)}
                className="bg-white/5 border-white/10 text-white"
                data-testid="input-to-date"
              />
            </div>
            <div>
              <Label className="text-xs text-muted-foreground">Org</Label>
              <Input
                value={String(activeOrgId)}
                disabled
                className="bg-white/5 border-white/10 text-muted-foreground"
              />
            </div>
          </div>
          <div className="flex flex-wrap gap-3 pt-1" data-testid="event-filter-list">
            {availableEvents.map((evt) => (
              <label key={evt} className="flex items-center gap-2 text-sm text-white cursor-pointer" title={eventMetadata[evt]?.description ?? evt}>
                <Checkbox
                  checked={baseSelected.includes(evt)}
                  onCheckedChange={() => toggleEvent(evt)}
                  data-testid={`checkbox-event-${evt}`}
                />
                <span className="inline-block w-2 h-2 rounded-full" style={{ background: colorFor(evt, eventMetadata) }} />
                <span data-testid={`event-label-${evt}`}>{labelFor(evt, eventMetadata)}</span>
                {eventMetadata[evt]?.category && (
                  <span className="text-[10px] text-muted-foreground border border-white/10 rounded px-1 py-0.5">
                    {eventMetadata[evt]?.category}
                  </span>
                )}
              </label>
            ))}
            {eventNamesQuery.isLoading && (
              <span className="text-xs text-muted-foreground">Loading event list…</span>
            )}
          </div>
          {/* Task #1948 — Push / In-App channel toggles for the
              `notification_opened` event. Only shown when the event is
              part of the available list, so admins on stripped-down
              instrumentation don't see dangling controls. */}
          {availableEvents.includes('notification_opened') && (
            <div
              className="flex flex-wrap items-center gap-3 pt-2 border-t border-white/5"
              data-testid="channel-controls"
            >
              <span className="text-xs uppercase tracking-wide text-muted-foreground">
                Notification channels
              </span>
              <label className="flex items-center gap-2 text-sm text-white cursor-pointer">
                <Checkbox
                  checked={showPushChannel}
                  onCheckedChange={(v) => setShowPushChannel(v === true)}
                  data-testid="checkbox-channel-push"
                />
                <span
                  className="inline-block w-2 h-2 rounded-full"
                  style={{ background: colorFor('notification_opened', eventMetadata) }}
                />
                <span>Push</span>
              </label>
              <label className="flex items-center gap-2 text-sm text-white cursor-pointer">
                <Checkbox
                  checked={showInAppChannel}
                  onCheckedChange={(v) => setShowInAppChannel(v === true)}
                  data-testid="checkbox-channel-in-app"
                />
                <span
                  className="inline-block w-2 h-2 rounded-full"
                  style={{ background: NOTIF_IN_APP_COLOR }}
                />
                <span>In-App</span>
              </label>
              {!showPushChannel && !showInAppChannel && (
                <span
                  className="text-[10px] text-amber-300/80"
                  data-testid="channel-controls-warning"
                >
                  Both channels off — notification opens are hidden.
                </span>
              )}
            </div>
          )}
          {(availableCategories.length > 0 || groupByCategoryToggle) && (
            <div className="flex flex-wrap items-center gap-3 pt-2 border-t border-white/5" data-testid="category-controls">
              <FolderTree className="w-4 h-4 text-muted-foreground" />
              <div className="flex items-center gap-2">
                <Label className="text-xs text-muted-foreground" htmlFor="category-filter">Category</Label>
                <select
                  id="category-filter"
                  value={categoryFilter ?? ''}
                  onChange={(e) => setCategoryFilter(e.target.value === '' ? null : e.target.value)}
                  className="h-8 text-xs bg-white/5 border border-white/10 text-white rounded px-2"
                  data-testid="select-category-filter"
                >
                  <option value="">All categories</option>
                  {availableCategories.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                  <option value={UNCATEGORIZED}>{UNCATEGORIZED}</option>
                </select>
              </div>
              <label className="flex items-center gap-2 text-xs text-white cursor-pointer">
                <Checkbox
                  checked={groupByCategoryToggle}
                  onCheckedChange={(v) => setGroupByCategoryToggle(v === true)}
                  data-testid="checkbox-group-by-category"
                />
                Group totals & chart by category
              </label>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="space-y-4" data-testid="event-totals">
        {groupedSelected.map((grp) => {
          const groupEventSet = new Set(grp.events);
          const groupTiles = renderedTiles.filter((t) => groupEventSet.has(t.eventName));
          const groupSum = groupTiles.reduce((acc, t) => acc + t.total, 0);
          return (
            <div key={grp.category || 'flat'} data-testid={`totals-group-${grp.category || 'flat'}`}>
              {groupByCategoryToggle && (
                <div className="flex items-center justify-between mb-2 px-1">
                  <h3
                    className="text-xs uppercase tracking-wide text-muted-foreground font-semibold flex items-center gap-2"
                    data-testid={`totals-group-label-${grp.category}`}
                  >
                    <FolderTree className="w-3 h-3" />
                    {grp.category}
                  </h3>
                  <span
                    className="text-xs text-muted-foreground"
                    data-testid={`totals-group-sum-${grp.category}`}
                  >
                    {groupSum.toLocaleString()}
                  </span>
                </div>
              )}
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
                {groupTiles.map((tile) => (
                  <Card key={tile.key} className="glass-card border-none" title={tile.description ?? undefined}>
                    <CardContent className="pt-4 pb-4">
                      <div className="flex items-center justify-between mb-1">
                        <span
                          className="text-[11px] uppercase tracking-wide text-muted-foreground truncate"
                          data-testid={`tile-label-${tile.key}`}
                        >
                          {tile.label}
                        </span>
                        <span className="inline-block w-2 h-2 rounded-full" style={{ background: tile.color }} />
                      </div>
                      <p className="text-2xl font-bold text-white" data-testid={`total-${tile.key}`}>
                        {tile.total.toLocaleString()}
                      </p>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </div>
          );
        })}
        {effectiveSelected.length === 0 && (
          <p
            className="text-sm text-muted-foreground text-center py-6"
            data-testid="totals-empty"
          >
            No events match the current filters.
          </p>
        )}
      </div>

      <Tabs defaultValue="trends">
        <TabsList className="bg-white/5 border border-white/10">
          <TabsTrigger value="trends">Trends</TabsTrigger>
          {isSuperAdmin && <TabsTrigger value="raw">Raw Events</TabsTrigger>}
          <TabsTrigger value="customize" data-testid="tab-customize">Customize</TabsTrigger>
        </TabsList>

        <TabsContent value="trends" className="mt-4">
          <Card className="glass-card border-none">
            <CardHeader>
              <CardTitle className="text-base text-white">Daily event volume</CardTitle>
            </CardHeader>
            <CardContent>
              {summaryQuery.isLoading ? (
                <div className="flex items-center justify-center py-16">
                  <Loader2 className="w-8 h-8 animate-spin text-primary" />
                </div>
              ) : summaryQuery.isError ? (
                <p className="text-red-400 text-sm py-8 text-center">{(summaryQuery.error as Error).message}</p>
              ) : renderedSeries.length === 0 ? (
                <p className="text-muted-foreground text-sm py-8 text-center">No events in this range</p>
              ) : (
                <ResponsiveContainer width="100%" height={320}>
                  <LineChart data={renderedSeries}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                    <XAxis dataKey="day" tick={{ fill: '#9ca3af', fontSize: 10 }} />
                    <YAxis tick={{ fill: '#9ca3af', fontSize: 10 }} />
                    <Tooltip contentStyle={{ background: '#1a1a2e', border: '1px solid rgba(255,255,255,0.1)' }} />
                    <Legend
                      formatter={(v) => <span className="text-xs text-muted-foreground">{v}</span>}
                    />
                    {/* Render Lines from `renderedTiles` so the
                        notification_opened breakdown (push / in-app)
                        from Task #1563 is preserved. When "Group by
                        category" is on (Task #1569), iterate by group
                        and prefix each line's legend name with its
                        category so the legend reads as buckets. */}
                    {groupedSelected.flatMap((grp) => {
                      const groupEventSet = new Set(grp.events);
                      return renderedTiles
                        .filter((t) => groupEventSet.has(t.eventName))
                        .map((tile) => (
                          <Line
                            key={tile.key}
                            type="monotone"
                            dataKey={tile.key}
                            name={
                              groupByCategoryToggle
                                ? `${grp.category} • ${tile.label}`
                                : tile.label
                            }
                            stroke={tile.color}
                            dot={false}
                            strokeWidth={2}
                          />
                        ));
                    })}
                  </LineChart>
                </ResponsiveContainer>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {isSuperAdmin && (
          <TabsContent value="raw" className="mt-4">
            <Card className="glass-card border-none">
              <CardHeader className="flex flex-row items-center justify-between">
                <CardTitle className="text-base text-white flex items-center gap-2">
                  <Database className="w-4 h-4" /> Raw events
                  <Badge variant="outline" className="ml-2 text-xs border-white/10">super-admin</Badge>
                </CardTitle>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Input
                    type="search"
                    placeholder="Filter by user (name, email, ID)"
                    value={userFilterInput}
                    onChange={(e) => setUserFilterInput(e.target.value)}
                    className="h-7 w-56 text-xs bg-transparent border-white/10"
                    data-testid="input-user-filter"
                  />
                  <span data-testid="raw-total">{rawQuery.data?.total ?? 0} total</span>
                  <Button
                    size="sm"
                    variant="outline"
                    className="border-white/10 h-7"
                    disabled={rawOffset === 0}
                    onClick={() => setRawOffset(Math.max(0, rawOffset - rawLimit))}
                    data-testid="button-raw-prev"
                  >Prev</Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="border-white/10 h-7"
                    disabled={!rawQuery.data || rawOffset + rawLimit >= rawQuery.data.total}
                    onClick={() => setRawOffset(rawOffset + rawLimit)}
                    data-testid="button-raw-next"
                  >Next</Button>
                </div>
              </CardHeader>
              <CardContent>
                {rawQuery.isLoading ? (
                  <div className="flex items-center justify-center py-12">
                    <Loader2 className="w-6 h-6 animate-spin text-primary" />
                  </div>
                ) : rawQuery.isError ? (
                  <p className="text-red-400 text-sm py-8 text-center">{(rawQuery.error as Error).message}</p>
                ) : (rawQuery.data?.rows ?? []).length === 0 ? (
                  <p className="text-muted-foreground text-sm py-8 text-center">No events in this range</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs" data-testid="table-raw-events">
                      <thead>
                        <tr className="text-left text-muted-foreground border-b border-white/10">
                          <th className="px-2 py-2">When</th>
                          <th className="px-2 py-2">Event</th>
                          <th className="px-2 py-2">User</th>
                          <th className="px-2 py-2">Surface</th>
                          <th className="px-2 py-2">Payload</th>
                          <th className="px-2 py-2">Request</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(rawQuery.data?.rows ?? []).map((r) => (
                          <tr key={r.id} className="border-b border-white/5 align-top">
                            <td className="px-2 py-1.5 text-muted-foreground whitespace-nowrap">
                              {new Date(r.occurredAt).toLocaleString()}
                            </td>
                            <td className="px-2 py-1.5">
                              <span
                                className="inline-block w-2 h-2 rounded-full mr-1.5 align-middle"
                                style={{ background: colorFor(r.eventName, eventMetadata) }}
                              />
                              <span className="text-white">{labelFor(r.eventName, eventMetadata)}</span>
                              {labelFor(r.eventName, eventMetadata) !== r.eventName && (
                                <span className="ml-1 text-[10px] text-muted-foreground font-mono">{r.eventName}</span>
                              )}
                            </td>
                            <td className="px-2 py-1.5 text-muted-foreground">
                              {r.userId == null ? (
                                '—'
                              ) : (
                                <Link
                                  href={`/players?user=${r.userId}`}
                                  className="text-primary hover:underline"
                                  data-testid={`link-user-${r.userId}`}
                                >
                                  <span className="text-white">
                                    {r.userDisplayName || r.userUsername || `User #${r.userId}`}
                                  </span>
                                  {r.userEmail && (
                                    <span className="ml-1 text-[10px] text-muted-foreground">
                                      ({r.userEmail})
                                    </span>
                                  )}
                                  <span className="ml-1 text-[10px] text-muted-foreground">
                                    #{r.userId}
                                  </span>
                                </Link>
                              )}
                            </td>
                            <td className="px-2 py-1.5 text-muted-foreground">{r.surface}</td>
                            <td className="px-2 py-1.5 max-w-md">
                              <code className="text-[10px] text-muted-foreground break-all">
                                {JSON.stringify(r.payload)}
                              </code>
                            </td>
                            <td className="px-2 py-1.5 text-muted-foreground font-mono text-[10px]">
                              {r.requestId ?? '—'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        )}

        <TabsContent value="customize" className="mt-4">
          <CustomizeEventsPanel
            orgId={activeOrgId}
            availableEvents={availableEvents}
            metadata={eventMetadata}
            categoryOrder={categoryOrder}
            isLoading={eventNamesQuery.isLoading}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ─── CustomizeEventsPanel ──────────────────────────────────────────────────
//
// Task #1318. Org admins use this panel to give each emitted event a
// friendly display name, description, and chart color. Edits are persisted
// per-org via PUT /events/metadata/:eventName and reset via DELETE.
//
// On a successful save we invalidate the parent's `events/names` cache so
// the totals tiles, checkbox list, raw events table, and trend chart all
// re-render with the new label/color without a manual reload.

interface CustomizeEventsPanelProps {
  orgId: number;
  availableEvents: string[];
  metadata: EventMetadataMap;
  // Task #1959 — admin-chosen category display order. Drives the
  // section ordering in the Customize tab and the drag handles save
  // updates back to the same list.
  categoryOrder: string[];
  isLoading: boolean;
}

const PRESET_COLORS = [
  '#3b82f6', '#a855f7', '#22c55e', '#f59e0b', '#ef4444',
  '#06b6d4', '#f97316', '#84cc16', '#ec4899', '#14b8a6',
  '#8b5cf6', '#eab308', '#f43f5e', '#0ea5e9', '#22d3ee',
];

// Task #1570 — render an absolute timestamp like "Apr 28, 2026 14:32".
function formatLastEdited(updatedAt: string | null | undefined): string {
  if (!updatedAt) return '';
  const d = new Date(updatedAt);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function CustomizeEventsPanel({ orgId, availableEvents, metadata, categoryOrder, isLoading }: CustomizeEventsPanelProps) {
  const queryClient = useQueryClient();
  const [editingEvent, setEditingEvent] = useState<string | null>(null);
  const [draftDisplayName, setDraftDisplayName] = useState('');
  const [draftDescription, setDraftDescription] = useState('');
  const [draftColor, setDraftColor] = useState('');
  const [draftCategory, setDraftCategory] = useState('');
  const [saveError, setSaveError] = useState<string | null>(null);
  // Categories an admin has collapsed in the Customize tab. Stored
  // locally so toggling doesn't trigger a re-fetch (Task #1569).
  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(new Set());
  // Task #1570 — which row's "Recent changes" timeline is expanded.
  // Only one row at a time so the table doesn't get cluttered.
  const [historyEvent, setHistoryEvent] = useState<string | null>(null);
  // Task #1959 — drag-and-drop state for re-ordering category
  // sections. `dragCategory` is the bucket the user is currently
  // dragging; updates land via HTML5 native drop events. We persist
  // the new order through a mutation as soon as a drop completes so
  // the totals tiles, chart legend, and filter dropdown re-render
  // with the new order without an extra "Save" click.
  const [dragCategory, setDragCategory] = useState<string | null>(null);
  const [reorderError, setReorderError] = useState<string | null>(null);

  const startEditing = (evt: string) => {
    const m = metadata[evt];
    setEditingEvent(evt);
    setDraftDisplayName(m?.displayName ?? '');
    setDraftDescription(m?.description ?? '');
    setDraftColor(m?.color ?? '');
    setDraftCategory(m?.category ?? '');
    setSaveError(null);
  };

  // Distinct categories already in use across this org's metadata
  // rows. Used as the suggestion list for the editor's category input.
  const knownCategories = useMemo<string[]>(() => {
    const set = new Set<string>();
    for (const k of Object.keys(metadata)) {
      const c = metadata[k]?.category;
      if (c && c.length > 0) set.add(c);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [metadata]);

  // Group available events by category so the Customize tab renders as
  // labeled, collapsible buckets — the core Task #1569 outcome.
  // Task #1959 — pass the admin-chosen order so dragging in this tab
  // re-arranges the buckets here too.
  const grouped = useMemo(
    () => groupByCategory(availableEvents, metadata, categoryOrder),
    [availableEvents, metadata, categoryOrder],
  );

  const toggleCategoryCollapsed = (category: string) => {
    setCollapsedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(category)) next.delete(category); else next.add(category);
      return next;
    });
  };

  const cancelEditing = () => {
    setEditingEvent(null);
    setSaveError(null);
  };

  const invalidate = () => {
    void queryClient.invalidateQueries({
      queryKey: ['admin-analytics-event-names', orgId],
    });
  };

  const saveMutation = useMutation({
    mutationFn: async ({
      eventName, displayName, description, color, category,
    }: {
      eventName: string;
      displayName: string | null;
      description: string | null;
      color: string | null;
      category: string | null;
    }) => {
      const res = await fetch(
        API(`/organizations/${orgId}/analytics/events/metadata/${encodeURIComponent(eventName)}`),
        {
          method: 'PUT',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ displayName, description, color, category }),
        },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      return res.json() as Promise<{ metadata: MetadataListRow }>;
    },
    onSuccess: () => {
      invalidate();
      setEditingEvent(null);
      setSaveError(null);
    },
    onError: (err: Error) => setSaveError(err.message),
  });

  // Task #1959 — persist a new category order. The mutation rebuilds
  // the full ordered list from the current grouped sections, drops
  // "Uncategorized" (always pinned last server-side), and ships it
  // wholesale. Optimistic invalidation rebroadcasts the new order to
  // every cousin reader (totals tiles, chart legend, filter dropdown).
  const reorderMutation = useMutation({
    mutationFn: async (order: string[]) => {
      const res = await fetch(
        API(`/organizations/${orgId}/analytics/events/categories/order`),
        {
          method: 'PUT',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ order }),
        },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      return res.json() as Promise<{ order: string[] }>;
    },
    onSuccess: () => {
      invalidate();
      setReorderError(null);
    },
    onError: (err: Error) => setReorderError(err.message),
  });

  // Compute and persist the new ordering when the user drops a
  // dragged category onto another one. We pull the named buckets
  // (everything except "Uncategorized") out in their current display
  // order, splice the dragged entry into the target position, and
  // ship the result. Dropping a category onto itself is a no-op.
  const handleCategoryDrop = (target: string) => {
    const source = dragCategory;
    setDragCategory(null);
    if (!source || source === target) return;
    if (source === UNCATEGORIZED || target === UNCATEGORIZED) return;
    const current = grouped
      .map((g) => g.category)
      .filter((c) => c !== UNCATEGORIZED);
    const sourceIdx = current.indexOf(source);
    const targetIdx = current.indexOf(target);
    if (sourceIdx === -1 || targetIdx === -1) return;
    const next = current.slice();
    next.splice(sourceIdx, 1);
    const insertAt = next.indexOf(target);
    next.splice(insertAt, 0, source);
    reorderMutation.mutate(next);
  };

  const resetMutation = useMutation({
    mutationFn: async (eventName: string) => {
      const res = await fetch(
        API(`/organizations/${orgId}/analytics/events/metadata/${encodeURIComponent(eventName)}`),
        { method: 'DELETE', credentials: 'include' },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      return res.json() as Promise<{ ok: true }>;
    },
    onSuccess: () => {
      invalidate();
      setEditingEvent(null);
      setSaveError(null);
    },
    onError: (err: Error) => setSaveError(err.message),
  });

  const handleSave = () => {
    if (!editingEvent) return;
    const trimmedColor = draftColor.trim();
    if (trimmedColor.length > 0 && !/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(trimmedColor)) {
      setSaveError('Color must be a hex code like #3b82f6 or #abc');
      return;
    }
    // Task #1950 — block duplicate colors so two events on the same chart
    // never share a swatch. Compare case-insensitively against every other
    // event's saved color and surface the conflicting event by name in the
    // inline error slot. The API enforces the same rule for defense in
    // depth; this check just spares the round-trip when the conflict is
    // already visible locally.
    if (trimmedColor.length > 0) {
      const myColor = trimmedColor.toLowerCase();
      const conflict = Object.entries(metadata).find(([name, m]) =>
        name !== editingEvent
        && typeof m?.color === 'string'
        && m.color.trim().toLowerCase() === myColor,
      );
      if (conflict) {
        const [conflictEvent, conflictMeta] = conflict;
        const label = (conflictMeta?.displayName?.trim() || conflictEvent);
        setSaveError(`This color is already used by ${label}`);
        return;
      }
    }
    const trimmedCategory = draftCategory.trim();
    if (trimmedCategory.length > 64) {
      setSaveError('Category must be 64 characters or fewer');
      return;
    }
    saveMutation.mutate({
      eventName: editingEvent,
      displayName: draftDisplayName.trim() || null,
      description: draftDescription.trim() || null,
      color: trimmedColor || null,
      category: trimmedCategory || null,
    });
  };

  const customizedCount = Object.keys(metadata).filter((k) => {
    const m = metadata[k];
    return (m?.displayName && m.displayName.length > 0)
      || (m?.description && m.description.length > 0)
      || (m?.color && m.color.length > 0)
      || (m?.category && m.category.length > 0);
  }).length;

  return (
    <Card className="glass-card border-none">
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-base text-white flex items-center gap-2">
          <Palette className="w-4 h-4" /> Customize event labels & colors
          <Badge variant="outline" className="ml-2 text-xs border-white/10" data-testid="customize-count">
            {customizedCount} customized
          </Badge>
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Friendly labels and colors apply to every chart and tile on this page.
        </p>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-6 h-6 animate-spin text-primary" />
          </div>
        ) : availableEvents.length === 0 ? (
          <p className="text-muted-foreground text-sm py-8 text-center">
            No events have been emitted yet for this club.
          </p>
        ) : (
          <div className="overflow-x-auto space-y-6" data-testid="customize-grouped-list">
            {reorderError && (
              <p
                className="text-[11px] text-red-400 px-1"
                data-testid="reorder-error"
              >
                {reorderError}
              </p>
            )}
            {grouped.map((grp) => {
              const isCollapsed = collapsedCategories.has(grp.category);
              // "Uncategorized" is always pinned last and isn't part
              // of the saved order — disabling drag on its row keeps
              // admins from accidentally trying to move it.
              const isDraggable = grp.category !== UNCATEGORIZED;
              const isDragging = isDraggable && dragCategory === grp.category;
              return (
                <div
                  key={grp.category}
                  data-testid={`customize-group-${grp.category}`}
                  onDragOver={isDraggable ? (e) => {
                    if (dragCategory && dragCategory !== grp.category) {
                      e.preventDefault();
                      e.dataTransfer.dropEffect = 'move';
                    }
                  } : undefined}
                  onDrop={isDraggable ? (e) => {
                    e.preventDefault();
                    handleCategoryDrop(grp.category);
                  } : undefined}
                  className={isDragging ? 'opacity-50' : undefined}
                >
                  <div className="flex items-center mb-2">
                    {isDraggable ? (
                      <span
                        draggable
                        onDragStart={(e) => {
                          setDragCategory(grp.category);
                          e.dataTransfer.effectAllowed = 'move';
                          // Some browsers refuse to fire drop unless
                          // dataTransfer carries something — the value
                          // is ignored on drop.
                          e.dataTransfer.setData('text/plain', grp.category);
                        }}
                        onDragEnd={() => setDragCategory(null)}
                        className="cursor-grab active:cursor-grabbing px-1 text-muted-foreground hover:text-white"
                        title={`Drag to re-order ${grp.category}`}
                        aria-label={`Drag handle for ${grp.category}`}
                        data-testid={`drag-handle-${grp.category}`}
                      >
                        <GripVertical className="w-3 h-3" />
                      </span>
                    ) : (
                      <span className="px-1 w-5" />
                    )}
                    <button
                      type="button"
                      onClick={() => toggleCategoryCollapsed(grp.category)}
                      className="flex items-center justify-between flex-1 text-left px-1 py-1 hover:bg-white/5 rounded"
                      data-testid={`customize-group-toggle-${grp.category}`}
                    >
                      <span className="text-xs uppercase tracking-wide text-muted-foreground font-semibold flex items-center gap-2">
                        <FolderTree className="w-3 h-3" />
                        {grp.category}
                        <Badge variant="outline" className="text-[10px] border-white/10 ml-1">
                          {grp.events.length}
                        </Badge>
                      </span>
                      <span className="text-[10px] text-muted-foreground">
                        {isCollapsed ? 'Show' : 'Hide'}
                      </span>
                    </button>
                  </div>
                  {!isCollapsed && (
                    <table className="w-full text-xs" data-testid={`table-customize-events-${grp.category}`}>
                      <thead>
                        <tr className="text-left text-muted-foreground border-b border-white/10">
                          <th className="px-2 py-2">Event</th>
                          <th className="px-2 py-2">Display name</th>
                          <th className="px-2 py-2">Description</th>
                          <th className="px-2 py-2">Color</th>
                          <th className="px-2 py-2">Category</th>
                          <th className="px-2 py-2 w-32 text-right">Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {grp.events.map((evt) => {
                          const m = metadata[evt];
                          const isEditing = editingEvent === evt;
                          const isCustomized = !!(m && (m.displayName || m.description || m.color || m.category));
                          const isHistoryOpen = !isEditing && historyEvent === evt;
                          return (
                          <Fragment key={evt}>
                            <tr className="border-b border-white/5 align-top" data-testid={`row-event-${evt}`}>
                      <td className="px-2 py-2 font-mono text-muted-foreground whitespace-nowrap">
                        {evt}
                      </td>
                      {isEditing ? (
                        <>
                          <td className="px-2 py-2">
                            <Input
                              value={draftDisplayName}
                              onChange={(e) => setDraftDisplayName(e.target.value)}
                              placeholder={evt}
                              className="h-8 text-xs bg-white/5 border-white/10 text-white"
                              data-testid={`input-display-name-${evt}`}
                              maxLength={120}
                            />
                          </td>
                          <td className="px-2 py-2">
                            <Textarea
                              value={draftDescription}
                              onChange={(e) => setDraftDescription(e.target.value)}
                              placeholder="Optional — what does this event mean?"
                              className="text-xs bg-white/5 border-white/10 text-white min-h-[2.25rem]"
                              data-testid={`input-description-${evt}`}
                              rows={2}
                              maxLength={500}
                            />
                          </td>
                          <td className="px-2 py-2">
                            <div className="flex items-center gap-2">
                              <Input
                                type="text"
                                value={draftColor}
                                onChange={(e) => setDraftColor(e.target.value)}
                                placeholder="#3b82f6"
                                className="h-8 w-24 text-xs font-mono bg-white/5 border-white/10 text-white"
                                data-testid={`input-color-${evt}`}
                                maxLength={16}
                              />
                              <span
                                className="inline-block w-5 h-5 rounded border border-white/10"
                                style={{ background: draftColor && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(draftColor.trim()) ? draftColor.trim() : 'transparent' }}
                                data-testid={`color-preview-${evt}`}
                              />
                            </div>
                            <div className="flex flex-wrap gap-1 mt-1.5">
                              {PRESET_COLORS.map((c) => (
                                <button
                                  key={c}
                                  type="button"
                                  onClick={() => setDraftColor(c)}
                                  className="w-4 h-4 rounded border border-white/10"
                                  style={{ background: c }}
                                  aria-label={`Use color ${c}`}
                                  data-testid={`preset-color-${evt}-${c.slice(1)}`}
                                />
                              ))}
                            </div>
                          </td>
                          <td className="px-2 py-2">
                            <Input
                              type="text"
                              value={draftCategory}
                              onChange={(e) => setDraftCategory(e.target.value)}
                              placeholder="e.g. Bookings"
                              list={`category-suggestions-${evt}`}
                              className="h-8 text-xs bg-white/5 border-white/10 text-white"
                              data-testid={`input-category-${evt}`}
                              maxLength={64}
                            />
                            <datalist id={`category-suggestions-${evt}`}>
                              {knownCategories.map((c) => (
                                <option key={c} value={c} />
                              ))}
                            </datalist>
                          </td>
                          <td className="px-2 py-2 text-right">
                            <div className="flex items-center justify-end gap-1">
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-7 border-white/10"
                                onClick={handleSave}
                                disabled={saveMutation.isPending}
                                data-testid={`button-save-${evt}`}
                              >
                                {saveMutation.isPending
                                  ? <Loader2 className="w-3 h-3 animate-spin" />
                                  : <><Save className="w-3 h-3 mr-1" /> Save</>}
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-7"
                                onClick={cancelEditing}
                                data-testid={`button-cancel-${evt}`}
                              >
                                <X className="w-3 h-3" />
                              </Button>
                            </div>
                            {saveError && editingEvent === evt && (
                              <p className="text-[10px] text-red-400 mt-1" data-testid={`error-${evt}`}>{saveError}</p>
                            )}
                          </td>
                        </>
                      ) : (
                        <>
                          <td className="px-2 py-2 text-white" data-testid={`display-display-name-${evt}`}>
                            {m?.displayName || <span className="text-muted-foreground italic">—</span>}
                            {/* Task #1570 — editor attribution under the
                                friendly name so teammates can tell who
                                customized the event without opening a
                                separate audit view. */}
                            {isCustomized && m?.updatedAt && (
                              <div
                                className="text-[10px] text-muted-foreground mt-0.5"
                                data-testid={`last-edited-${evt}`}
                              >
                                Last edited
                                {m.updatedByName ? (
                                  <> by <span className="text-white/80">{m.updatedByName}</span></>
                                ) : (
                                  <> by <span className="italic">unknown</span></>
                                )}
                                {' on '}
                                <span title={m.updatedAt}>{formatLastEdited(m.updatedAt)}</span>
                              </div>
                            )}
                          </td>
                          <td className="px-2 py-2 text-muted-foreground max-w-md" data-testid={`display-description-${evt}`}>
                            {m?.description || <span className="italic">—</span>}
                          </td>
                          <td className="px-2 py-2">
                            <div className="flex items-center gap-2">
                              <span
                                className="inline-block w-4 h-4 rounded border border-white/10"
                                style={{ background: colorFor(evt, metadata) }}
                                data-testid={`display-color-swatch-${evt}`}
                              />
                              <span className="font-mono text-[11px] text-muted-foreground">
                                {m?.color || <span className="italic">auto</span>}
                              </span>
                            </div>
                          </td>
                          <td className="px-2 py-2 text-muted-foreground" data-testid={`display-category-${evt}`}>
                            {m?.category
                              ? <span className="text-white">{m.category}</span>
                              : <span className="italic">—</span>}
                          </td>
                          <td className="px-2 py-2 text-right">
                            <div className="flex items-center justify-end gap-1">
                              {isCustomized && (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="h-7 text-muted-foreground hover:text-white"
                                  onClick={() => setHistoryEvent(historyEvent === evt ? null : evt)}
                                  title={isHistoryOpen ? 'Hide recent changes' : 'Show recent changes'}
                                  data-testid={`button-history-${evt}`}
                                  aria-pressed={isHistoryOpen}
                                >
                                  <History className="w-3 h-3" />
                                </Button>
                              )}
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-7 border-white/10"
                                onClick={() => startEditing(evt)}
                                data-testid={`button-edit-${evt}`}
                              >
                                <Pencil className="w-3 h-3 mr-1" /> Edit
                              </Button>
                              {isCustomized && (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="h-7 text-muted-foreground hover:text-white"
                                  onClick={() => resetMutation.mutate(evt)}
                                  disabled={resetMutation.isPending}
                                  title="Reset to defaults"
                                  data-testid={`button-reset-${evt}`}
                                >
                                  <RotateCcw className="w-3 h-3" />
                                </Button>
                              )}
                            </div>
                          </td>
                        </>
                      )}
                    </tr>
                    {isHistoryOpen && (
                      <tr
                        className="border-b border-white/5 bg-white/[0.02]"
                        data-testid={`row-history-${evt}`}
                      >
                        <td colSpan={6} className="px-4 py-3">
                          <EventMetadataHistoryPanel
                            orgId={orgId}
                            eventName={evt}
                          />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                  );
                        })}
                      </tbody>
                    </table>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ─── EventMetadataHistoryPanel ──────────────────────────────────────────
//
// Task #1570. Lazily fetches the last few audit-log rows for a single
// event and renders them as a compact "Recent changes" timeline below
// the row in the Customize tab. The query is lazy — we only hit the
// API once an admin actually clicks the History button on a row, which
// keeps the Customize tab fast even when an org has dozens of
// customized events.
//
// Each entry shows: who edited it, when, the action (relabel vs. reset
// to defaults), and the new label / color values that were applied.
// We keep the list to the most recent 10 changes — the API caps at the
// same number — since the goal is "find the right person to ask",
// not full forensic timeline.

interface EventMetadataHistoryPanelProps {
  orgId: number;
  eventName: string;
}

function EventMetadataHistoryPanel({
  orgId,
  eventName,
}: EventMetadataHistoryPanelProps) {
  const historyQuery = useQuery<MetadataHistoryData>({
    queryKey: ['admin-analytics-event-metadata-history', orgId, eventName],
    queryFn: () => apiFetch(
      API(`/organizations/${orgId}/analytics/events/metadata/${encodeURIComponent(eventName)}/history`),
    ),
    enabled: !!orgId && !!eventName,
  });

  if (historyQuery.isLoading) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="w-3 h-3 animate-spin" /> Loading recent changes…
      </div>
    );
  }
  if (historyQuery.isError) {
    return (
      <p className="text-[11px] text-red-400" data-testid={`history-error-${eventName}`}>
        {(historyQuery.error as Error).message}
      </p>
    );
  }

  const rows = historyQuery.data?.history ?? [];
  if (rows.length === 0) {
    return (
      <p className="text-[11px] text-muted-foreground italic" data-testid={`history-empty-${eventName}`}>
        No recorded changes yet.
      </p>
    );
  }

  return (
    <div data-testid={`history-list-${eventName}`}>
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1.5">
        Recent changes
      </p>
      <ol className="space-y-1.5">
        {rows.map((r) => (
          <li
            key={r.id}
            className="flex flex-wrap items-baseline gap-x-2 text-[11px] text-muted-foreground"
            data-testid={`history-row-${eventName}-${r.id}`}
          >
            <span className="text-white/80 font-medium">
              {r.changedByName ?? <span className="italic text-muted-foreground">unknown</span>}
            </span>
            <span title={r.changedAt}>{formatLastEdited(r.changedAt)}</span>
            {r.action === 'delete' ? (
              <span className="text-amber-400">reset to defaults</span>
            ) : (
              <span className="text-white/60">
                set
                {r.displayName ? <> name "<span className="text-white">{r.displayName}</span>"</> : ''}
                {r.color ? (
                  <>
                    {r.displayName ? ', ' : ' '}
                    color
                    <span
                      className="inline-block w-2.5 h-2.5 rounded-sm align-middle ml-1 mr-0.5 border border-white/10"
                      style={{ background: r.color }}
                    />
                    <span className="font-mono text-white">{r.color}</span>
                  </>
                ) : ''}
                {!r.displayName && !r.color ? (
                  <> {r.description ? 'description' : 'override'}</>
                ) : ''}
              </span>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}
