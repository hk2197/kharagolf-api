// Task #1733 — Admin per-event mute ops dashboard.
//
// Lists every admin-only per-event opt-out column on
// `user_notification_prefs` with a live mute count, lets the admin drill
// in to see WHO has muted each alert, and bulk-restores everyone in
// scope with one click. A second panel surfaces recent
// `event_opted_out` rows from `notification_audit_log` so an admin can
// prove "alert was suppressed by user choice, not lost".
//
// Server enforces the role boundary (org_admin sees only users in their
// org; super_admin sees everyone). This page short-circuits non-admin
// roles client-side with the same pattern used by the notification
// audit feed page.
import { useEffect, useState, useCallback, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertCircle, BellOff, RefreshCw, RotateCcw, Users, History, ChevronDown, ChevronRight, BarChart3 } from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";

interface MeResponse { role?: string }
const ADMIN_ROLES = new Set(["org_admin", "super_admin"]);

interface EventSummary {
  id: string;
  label: string;
  description: string;
  category: string;
  columnName: string;
  notificationKeys: string[];
  mutedCount: number;
}

interface SummaryResponse {
  totalUsersInScope: number;
  events: EventSummary[];
}

interface MutedUser {
  userId: number;
  username: string | null;
  displayName: string | null;
  email: string | null;
  role: string | null;
  organizationId: number | null;
  mutedAt: string | null;
}

interface UsersResponse {
  id: string;
  label: string;
  users: MutedUser[];
}

interface AuditEntry {
  id: number;
  notificationKey: string;
  userId: number | null;
  userDisplayName: string | null;
  username: string | null;
  userEmail: string | null;
  channel: string;
  status: string;
  reason: string | null;
  createdAt: string;
}

interface AuditResponse {
  entries: AuditEntry[];
  limit: number;
}

// Task #2177 — per-event mute trend chart data shape returned by
// GET /admin/event-mutes/trend.
interface TrendEventSeries {
  id: string;
  counts: number[];
  total: number;
}
interface TrendResponse {
  sinceDays: number;
  days: string[];        // YYYY-MM-DD UTC, oldest-first, length = sinceDays
  events: TrendEventSeries[];
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

/** Compact `MMM d` x-axis label, mirrors SkipReasonDailyTrendPanel. */
function formatDayLabel(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}

/** Tiny inline bar chart for the per-row sparkline. Recharts'
 *  ResponsiveContainer needs a positioned parent with a fixed height,
 *  so this component renders inside a 32px-tall container. No axes, no
 *  tooltip — the count badge above already shows the totals. */
function MuteSparkline({ days, counts, eventId }: { days: string[]; counts: number[]; eventId: string }) {
  const data = useMemo(
    () => days.map((day, i) => ({ day, count: counts[i] ?? 0 })),
    [days, counts],
  );
  const total = useMemo(() => counts.reduce((a, b) => a + b, 0), [counts]);
  if (total === 0) {
    return (
      <div
        className="text-xs text-muted-foreground italic"
        data-testid={`mute-sparkline-empty-${eventId}`}
      >
        No mutes in the last {days.length} days
      </div>
    );
  }
  return (
    <div
      className="h-8 w-full max-w-xs"
      data-testid={`mute-sparkline-${eventId}`}
      aria-label={`Daily mute trend for the last ${days.length} days, ${total} total`}
      role="img"
    >
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 1, right: 1, left: 1, bottom: 1 }}>
          <Bar dataKey="count" fill="#f59e0b" isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

interface DrillTrendTooltipPayload { value?: number; payload?: { day?: string } }
interface DrillTrendTooltipProps { active?: boolean; label?: string; payload?: DrillTrendTooltipPayload[] }

function DrillTrendTooltip({ active, label, payload }: DrillTrendTooltipProps) {
  if (!active || !payload || payload.length === 0) return null;
  const value = Number(payload[0]?.value ?? 0);
  return (
    <div
      className="rounded-md border border-border bg-card/95 px-3 py-1.5 text-xs shadow-lg backdrop-blur"
      data-testid="event-mute-trend-tooltip"
    >
      <p className="text-white font-medium">{label ? formatDayLabel(label) : ""}</p>
      <p className="text-muted-foreground">
        <span className="text-white font-mono">{value.toLocaleString()}</span> opt-out{value === 1 ? "" : "s"}
      </p>
    </div>
  );
}

/** Larger 90-day chart shown when a row is expanded. Adds axes, grid
 *  lines, tick labels, and a tooltip — all the affordances the
 *  sparkline drops to stay tiny. */
function MuteTrendChart({ trend, eventId }: { trend: TrendResponse | null; eventId: string }) {
  const data = useMemo(() => {
    if (!trend) return [];
    return trend.days.map((day, i) => ({
      day,
      count: trend.events[0]?.counts[i] ?? 0,
    }));
  }, [trend]);
  const total = useMemo(() => {
    if (!trend) return 0;
    return trend.events[0]?.total ?? 0;
  }, [trend]);
  if (!trend) {
    return (
      <div className="text-xs text-muted-foreground" data-testid={`event-mute-trend-loading-${eventId}`}>
        Loading {90}-day trend…
      </div>
    );
  }
  return (
    <div data-testid={`event-mute-trend-chart-${eventId}`}>
      <div className="flex items-center justify-between text-xs text-muted-foreground mb-1.5">
        <span className="flex items-center gap-1.5">
          <BarChart3 className="w-3.5 h-3.5" />
          Daily opt-outs (last {trend.sinceDays} days)
        </span>
        <span>
          Total: <span className="text-white font-mono">{total.toLocaleString()}</span>
        </span>
      </div>
      {total === 0 ? (
        <p
          className="text-xs text-muted-foreground py-6 text-center"
          data-testid={`event-mute-trend-empty-${eventId}`}
        >
          No opt-outs recorded in the last {trend.sinceDays} days.
        </p>
      ) : (
        <div className="h-44 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} margin={{ top: 8, right: 12, left: -8, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" vertical={false} />
              <XAxis
                dataKey="day"
                tick={{ fill: "#94a3b8", fontSize: 11 }}
                tickFormatter={formatDayLabel}
                interval={Math.max(0, Math.floor(data.length / 6) - 1)}
                stroke="#334155"
              />
              <YAxis
                tick={{ fill: "#94a3b8", fontSize: 11 }}
                allowDecimals={false}
                width={32}
                stroke="#334155"
              />
              <RechartsTooltip
                content={<DrillTrendTooltip />}
                cursor={{ fill: "#475569", opacity: 0.2 }}
              />
              <Bar dataKey="count" fill="#f59e0b" isAnimationActive={false} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}

export default function AdminEventMutesPage() {
  const { data: me, isLoading: meLoading, status: meStatus } = useQuery<MeResponse | null>({
    queryKey: ["/api/auth/me"],
    queryFn: async () => {
      const res = await fetch("/api/auth/me", { credentials: "include" });
      if (res.status === 401) return null;
      if (!res.ok) throw new Error(`Auth lookup failed (HTTP ${res.status})`);
      return (await res.json()) as MeResponse;
    },
    retry: false,
    staleTime: 5 * 60_000,
  });

  const isAdmin = !!me && ADMIN_ROLES.has(me.role ?? "");

  const summaryQuery = useQuery<SummaryResponse>({
    queryKey: ["admin-event-mutes-summary"],
    queryFn: async () => {
      const res = await fetch("/api/admin/event-mutes", { credentials: "include" });
      if (!res.ok) throw new Error(`Request failed (HTTP ${res.status})`);
      return (await res.json()) as SummaryResponse;
    },
    enabled: isAdmin,
  });

  const auditQuery = useQuery<AuditResponse>({
    queryKey: ["admin-event-mutes-audit-log"],
    queryFn: async () => {
      const res = await fetch("/api/admin/event-mutes/audit-log?limit=50", { credentials: "include" });
      if (!res.ok) throw new Error(`Request failed (HTTP ${res.status})`);
      return (await res.json()) as AuditResponse;
    },
    enabled: isAdmin,
  });

  // Task #2177 — 30-day daily opt-out counts for every event, used to
  // render a sparkline next to each row's mute count badge. One query
  // returns the whole grid so we don't fan out a separate request per
  // row.
  const trendSummaryQuery = useQuery<TrendResponse>({
    queryKey: ["admin-event-mutes-trend-30d"],
    queryFn: async () => {
      const res = await fetch("/api/admin/event-mutes/trend?days=30", { credentials: "include" });
      if (!res.ok) throw new Error(`Request failed (HTTP ${res.status})`);
      return (await res.json()) as TrendResponse;
    },
    enabled: isAdmin,
  });

  // Drill-down 90-day chart per event id. Lazy: only fetched when a row
  // is expanded, then cached so re-toggling doesn't hit the server again.
  const [trendByEventId, setTrendByEventId] = useState<Record<string, TrendResponse>>({});
  const [trendLoadingId, setTrendLoadingId] = useState<string | null>(null);

  const loadTrend = useCallback(async (eventId: string) => {
    setTrendLoadingId(eventId);
    try {
      const res = await fetch(
        `/api/admin/event-mutes/trend?days=90&id=${encodeURIComponent(eventId)}`,
        { credentials: "include" },
      );
      if (!res.ok) throw new Error(`Request failed (HTTP ${res.status})`);
      const data = (await res.json()) as TrendResponse;
      setTrendByEventId(prev => ({ ...prev, [eventId]: data }));
    } catch {
      // Drill-down chart is non-essential — leave the slot showing the
      // "Loading…" message so the audit info above still renders.
    } finally {
      setTrendLoadingId(null);
    }
  }, []);

  // Per-row drill-down: tracks which event id is expanded and caches the
  // muted-users list for that id. Re-fetched on demand so a restore
  // (which clears the list) shows the current truth.
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [usersByEventId, setUsersByEventId] = useState<Record<string, MutedUser[]>>({});
  const [usersLoadingId, setUsersLoadingId] = useState<string | null>(null);
  const [usersErrorId, setUsersErrorId] = useState<string | null>(null);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  // Task #2178 — per-row "Restore" requests are tracked separately from
  // the bulk button so a single in-flight per-user call doesn't disable
  // the rest of the table. Key is `${eventId}:${userId}`.
  const [restoringUserKey, setRestoringUserKey] = useState<string | null>(null);
  const [restoreToast, setRestoreToast] = useState<string | null>(null);

  // Auto-clear the restore confirmation toast after a few seconds so it
  // doesn't accumulate as the admin works through several events.
  useEffect(() => {
    if (!restoreToast) return;
    const t = setTimeout(() => setRestoreToast(null), 5000);
    return () => clearTimeout(t);
  }, [restoreToast]);

  const loadUsers = useCallback(async (eventId: string) => {
    setUsersLoadingId(eventId);
    setUsersErrorId(null);
    try {
      const res = await fetch(`/api/admin/event-mutes/${encodeURIComponent(eventId)}/users`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error(`Request failed (HTTP ${res.status})`);
      const data = (await res.json()) as UsersResponse;
      setUsersByEventId(prev => ({ ...prev, [eventId]: data.users }));
    } catch {
      setUsersErrorId(eventId);
    } finally {
      setUsersLoadingId(null);
    }
  }, []);

  const handleToggle = useCallback((eventId: string) => {
    setExpandedId(prev => {
      if (prev === eventId) return null;
      // Fire the load when opening; cache means re-toggling won't refetch.
      if (!usersByEventId[eventId]) void loadUsers(eventId);
      // Task #2177 — also fire the 90-day drill-down chart fetch on
      // first expand. Cached the same way so the second toggle is free.
      if (!trendByEventId[eventId]) void loadTrend(eventId);
      return eventId;
    });
  }, [loadUsers, loadTrend, usersByEventId, trendByEventId]);

  // Task #2178 — per-user restore. Removes the row from the cached
  // drill-down list on success so the parent count badge (computed from
  // the same data on the next summary refetch) decrements without a
  // visible flash. The summary is refetched immediately after for
  // consistency with the bulk handler below.
  const handleRestoreUser = useCallback(async (
    eventId: string,
    user: MutedUser,
    eventLabel: string,
  ) => {
    const key = `${eventId}:${user.userId}`;
    if (restoringUserKey === key) return;
    setRestoringUserKey(key);
    const userLabel = user.displayName || user.username || `User #${user.userId}`;
    try {
      const res = await fetch(`/api/admin/event-mutes/${encodeURIComponent(eventId)}/restore-user`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: user.userId }),
      });
      if (!res.ok) throw new Error(`Request failed (HTTP ${res.status})`);
      const data = (await res.json()) as { restored: number };
      if (data.restored > 0) {
        // Drop the row from the cached list so the drill-down updates
        // immediately. The summary refetch will adjust the parent badge.
        setUsersByEventId(prev => {
          const list = prev[eventId];
          if (!list) return prev;
          return { ...prev, [eventId]: list.filter(u => u.userId !== user.userId) };
        });
        setRestoreToast(`Restored ${userLabel} for "${eventLabel}".`);
      } else {
        // Out-of-scope target or already-true row — surface the no-op so
        // the admin isn't left wondering why nothing changed.
        setRestoreToast(`No change for ${userLabel} — already restored or out of scope.`);
      }
      await summaryQuery.refetch();
    } catch {
      setRestoreToast(`Failed to restore ${userLabel}. Please retry.`);
    } finally {
      setRestoringUserKey(null);
    }
  }, [restoringUserKey, summaryQuery]);

  const handleRestoreAll = useCallback(async (eventId: string, label: string) => {
    if (restoringId) return;
    if (!window.confirm(`Restore EVERY user in scope for "${label}"? They will all start receiving this alert again.`)) {
      return;
    }
    setRestoringId(eventId);
    try {
      const res = await fetch(`/api/admin/event-mutes/${encodeURIComponent(eventId)}/restore-all`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) throw new Error(`Request failed (HTTP ${res.status})`);
      const data = (await res.json()) as { restored: number; id: string };
      setRestoreToast(`Restored ${data.restored.toLocaleString()} user${data.restored === 1 ? "" : "s"} for "${label}".`);
      // Invalidate the cache and refetch summary + drill-down.
      setUsersByEventId(prev => ({ ...prev, [eventId]: [] }));
      await Promise.all([
        summaryQuery.refetch(),
        expandedId === eventId ? loadUsers(eventId) : Promise.resolve(),
      ]);
    } catch {
      setRestoreToast(`Failed to restore "${label}". Please retry.`);
    } finally {
      setRestoringId(null);
    }
  }, [expandedId, loadUsers, restoringId, summaryQuery]);

  if (meLoading) {
    return (
      <div className="p-6" data-testid="admin-event-mutes-page">
        <div className="text-sm text-muted-foreground">Loading…</div>
      </div>
    );
  }

  if (!isAdmin) {
    let title = "Admin event mutes";
    let body = "You need an organization or super-admin role to view this page. Contact your club administrator if you believe this is a mistake.";
    let testId = "admin-event-mutes-no-access";
    if (meStatus === "error") {
      title = "Couldn't verify your access";
      body = "We couldn't reach the authentication service to check your role. This usually clears up on its own — please refresh in a moment.";
      testId = "admin-event-mutes-auth-error";
    } else if (!me) {
      title = "Sign in required";
      body = "You need to sign in to view this page.";
      testId = "admin-event-mutes-signin-required";
    }
    return (
      <div className="p-6" data-testid="admin-event-mutes-page">
        <div className="rounded-lg border border-border bg-card p-6 max-w-xl" data-testid={testId}>
          <div className="flex items-start gap-3">
            <AlertCircle className="w-5 h-5 mt-0.5 text-destructive" />
            <div>
              <h1 className="text-lg font-semibold">{title}</h1>
              <p className="text-sm text-muted-foreground mt-1">{body}</p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const summary = summaryQuery.data;
  const audit = auditQuery.data;

  return (
    <div className="p-6 space-y-6" data-testid="admin-event-mutes-page">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Admin alert mute settings</h1>
          <p className="text-sm text-muted-foreground mt-1 max-w-3xl">
            Per-event opt-outs across {summary ? summary.totalUsersInScope.toLocaleString() : "…"} user{summary?.totalUsersInScope === 1 ? "" : "s"} in scope.
            Use this page to see which admin alerts are currently silenced, who silenced them, and to restore everyone with one click during a staffing handover.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            void summaryQuery.refetch();
            void auditQuery.refetch();
            void trendSummaryQuery.refetch();
            // Drop the cached drill-down trends so the next expand
            // re-fetches with the latest data.
            setTrendByEventId({});
          }}
          disabled={summaryQuery.isFetching || auditQuery.isFetching || trendSummaryQuery.isFetching}
          data-testid="button-refresh-event-mutes"
        >
          <RefreshCw className={`w-4 h-4 mr-2 ${summaryQuery.isFetching || auditQuery.isFetching || trendSummaryQuery.isFetching ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {restoreToast && (
        <div
          className="rounded-md border border-border bg-card px-4 py-2 text-sm"
          data-testid="restore-toast"
        >
          {restoreToast}
        </div>
      )}

      <Card data-testid="event-mutes-summary-card">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <BellOff className="w-4 h-4" />
            Alert mute counts
          </CardTitle>
          <CardDescription>
            One row per admin-only event opt-out column. Click a row to see which users have muted it.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {summaryQuery.isLoading ? (
            <div className="text-sm text-muted-foreground">Loading mute counts…</div>
          ) : summaryQuery.isError || !summary ? (
            <div className="text-sm text-destructive" data-testid="summary-error">
              Couldn't load alert mute counts.
            </div>
          ) : (
            <div className="divide-y divide-border" data-testid="event-mutes-list">
              {summary.events.length === 0 ? (
                <div className="py-4 text-sm text-muted-foreground">No admin-event opt-outs registered.</div>
              ) : summary.events.map(event => {
                const expanded = expandedId === event.id;
                const users = usersByEventId[event.id];
                // Task #2177 — find this event's 30-day series for the
                // sparkline. We pull from the trend response by id so a
                // shared notification key (two registry entries → same
                // dispatcher key) still reads the right slot.
                const trendSummary = trendSummaryQuery.data;
                const sparkSeries = trendSummary?.events.find(e => e.id === event.id) ?? null;
                const drillTrend = trendByEventId[event.id] ?? null;
                return (
                  <div key={event.id} className="py-3" data-testid={`event-mute-row-${event.id}`}>
                    <div className="flex items-start justify-between gap-3">
                      <button
                        type="button"
                        className="flex items-start gap-2 text-left flex-1 hover:opacity-90"
                        onClick={() => handleToggle(event.id)}
                        data-testid={`button-toggle-${event.id}`}
                      >
                        {expanded ? (
                          <ChevronDown className="w-4 h-4 mt-0.5 text-muted-foreground" />
                        ) : (
                          <ChevronRight className="w-4 h-4 mt-0.5 text-muted-foreground" />
                        )}
                        <div className="flex-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-medium">{event.label}</span>
                            <Badge variant="outline" className="text-xs">{event.category}</Badge>
                            {event.mutedCount > 0 ? (
                              <Badge
                                variant="outline"
                                className="bg-amber-500/15 text-amber-300 border-amber-500/30"
                                data-testid={`mute-count-${event.id}`}
                              >
                                {event.mutedCount.toLocaleString()} muted
                              </Badge>
                            ) : (
                              <Badge
                                variant="outline"
                                className="bg-emerald-500/15 text-emerald-300 border-emerald-500/30"
                                data-testid={`mute-count-${event.id}`}
                              >
                                0 muted
                              </Badge>
                            )}
                          </div>
                          <p className="text-sm text-muted-foreground mt-1">{event.description}</p>
                          <p className="text-xs text-muted-foreground mt-1 font-mono">
                            user_notification_prefs.{event.columnName}
                          </p>
                          {/* Task #2177 — 30-day mute trend sparkline.
                              Mounted under the description so the row's
                              vertical rhythm stays compact and the chart
                              sits right next to the count badge it
                              contextualises. */}
                          <div className="mt-2">
                            {trendSummaryQuery.isLoading || !trendSummary ? (
                              <div
                                className="text-xs text-muted-foreground italic"
                                data-testid={`mute-sparkline-loading-${event.id}`}
                              >
                                Loading 30-day trend…
                              </div>
                            ) : trendSummaryQuery.isError || !sparkSeries ? (
                              <div
                                className="text-xs text-muted-foreground italic"
                                data-testid={`mute-sparkline-error-${event.id}`}
                              >
                                Trend unavailable
                              </div>
                            ) : (
                              <MuteSparkline
                                eventId={event.id}
                                days={trendSummary.days}
                                counts={sparkSeries.counts}
                              />
                            )}
                          </div>
                        </div>
                      </button>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={event.mutedCount === 0 || restoringId === event.id}
                        onClick={() => void handleRestoreAll(event.id, event.label)}
                        data-testid={`button-restore-${event.id}`}
                      >
                        <RotateCcw className={`w-3.5 h-3.5 mr-2 ${restoringId === event.id ? "animate-spin" : ""}`} />
                        Restore all
                      </Button>
                    </div>

                    {expanded && (
                      <div className="mt-3 ml-6 rounded border border-border bg-muted/30 p-3 space-y-4" data-testid={`drill-${event.id}`}>
                        {/* Task #2177 — 90-day chart drill-down. Sits
                            above the muted-users list so the temporal
                            context loads first; the user list is the
                            "who" and the chart is the "when". */}
                        <div data-testid={`drill-trend-${event.id}`}>
                          {trendLoadingId === event.id && !drillTrend ? (
                            <div
                              className="text-xs text-muted-foreground"
                              data-testid={`event-mute-trend-loading-${event.id}`}
                            >
                              Loading 90-day trend…
                            </div>
                          ) : (
                            <MuteTrendChart trend={drillTrend} eventId={event.id} />
                          )}
                        </div>

                        <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-muted-foreground mb-2">
                          <Users className="w-3.5 h-3.5" />
                          Muted by
                        </div>
                        {usersLoadingId === event.id ? (
                          <div className="text-sm text-muted-foreground">Loading…</div>
                        ) : usersErrorId === event.id ? (
                          <div className="text-sm text-destructive">
                            Couldn't load the muted-users list. <button className="underline" onClick={() => void loadUsers(event.id)}>Retry</button>
                          </div>
                        ) : !users || users.length === 0 ? (
                          <div className="text-sm text-muted-foreground">Nobody in scope has muted this alert.</div>
                        ) : (
                          <ul className="space-y-1.5" data-testid={`muted-user-list-${event.id}`}>
                            {users.map(u => {
                              const userKey = `${event.id}:${u.userId}`;
                              const isRestoringThisUser = restoringUserKey === userKey;
                              return (
                                <li
                                  key={u.userId}
                                  className="text-sm flex flex-wrap items-center gap-2"
                                  data-testid={`muted-user-${event.id}-${u.userId}`}
                                >
                                  <span className="font-medium">
                                    {u.displayName || u.username || `User #${u.userId}`}
                                  </span>
                                  {u.email && <span className="text-muted-foreground">{u.email}</span>}
                                  {u.role && <Badge variant="outline" className="text-xs">{u.role}</Badge>}
                                  <span className="text-xs text-muted-foreground">muted {formatDate(u.mutedAt)}</span>
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    className="ml-auto h-7 px-2 text-xs"
                                    disabled={isRestoringThisUser}
                                    onClick={() => void handleRestoreUser(event.id, u, event.label)}
                                    data-testid={`button-restore-user-${event.id}-${u.userId}`}
                                  >
                                    <RotateCcw className={`w-3 h-3 mr-1.5 ${isRestoringThisUser ? "animate-spin" : ""}`} />
                                    Restore
                                  </Button>
                                </li>
                              );
                            })}
                          </ul>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <Card data-testid="event-mutes-audit-card">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <History className="w-4 h-4" />
            Recent suppressed dispatches
          </CardTitle>
          <CardDescription>
            Latest rows from <code className="text-xs">notification_audit_log</code> where the dispatcher recorded
            <code className="text-xs"> reason=event_opted_out</code> — proof that an alert was suppressed by user choice rather than lost.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {auditQuery.isLoading ? (
            <div className="text-sm text-muted-foreground">Loading audit rows…</div>
          ) : auditQuery.isError || !audit ? (
            <div className="text-sm text-destructive" data-testid="audit-error">
              Couldn't load the audit log.
            </div>
          ) : audit.entries.length === 0 ? (
            <div className="text-sm text-muted-foreground" data-testid="audit-empty">
              No recent suppressed dispatches in scope.
            </div>
          ) : (
            <div className="overflow-x-auto" data-testid="audit-list">
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="py-1.5 pr-3">When</th>
                    <th className="py-1.5 pr-3">Notification key</th>
                    <th className="py-1.5 pr-3">Recipient</th>
                    <th className="py-1.5 pr-3">Channel</th>
                    <th className="py-1.5 pr-3">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {audit.entries.map(e => (
                    <tr key={e.id} data-testid={`audit-row-${e.id}`}>
                      <td className="py-1.5 pr-3 whitespace-nowrap">{formatDate(e.createdAt)}</td>
                      <td className="py-1.5 pr-3 font-mono text-xs">{e.notificationKey}</td>
                      <td className="py-1.5 pr-3">
                        {e.userDisplayName || e.username || `User #${e.userId ?? "?"}`}
                        {e.userEmail && (
                          <span className="text-muted-foreground ml-1">({e.userEmail})</span>
                        )}
                      </td>
                      <td className="py-1.5 pr-3">{e.channel}</td>
                      <td className="py-1.5 pr-3">
                        <Badge variant="outline" className="bg-amber-500/15 text-amber-300 border-amber-500/30">
                          {e.status}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
