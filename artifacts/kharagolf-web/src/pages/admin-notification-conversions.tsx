// Task #2020 — Per-key clicks → conversions admin view.
//
// Companion to the existing CTR view (Task #1622): instead of asking
// "how many people clicked the link?" this page asks "of the people
// who clicked, how many actually completed the action the email was
// driving?" — a tee booking, a tournament registration, a highlight
// play, etc.
//
// Server endpoint: GET /api/admin/notification-conversion-stats
// (super_admin only). Same `?sinceDays=N` filter shape as the CTR
// endpoint so an admin who flips between the two pages keeps the same
// mental model.
//
// We deliberately surface the per-conversion-type breakdown inline —
// most notification keys map cleanly to one conversion type, but the
// few that drive multiple destinations (e.g. a club digest with both
// a tee-booking CTA and a tournament-register CTA) deserve to show
// each event count separately rather than collapsing to a single
// "conversions" number.
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertCircle, RefreshCw, Target } from "lucide-react";
import { Button } from "@/components/ui/button";

interface ConversionRow {
  notificationKey: string;
  clickCount: number;
  conversionCount: number;
  conversionsByType: Record<string, number>;
  conversionRate: number | null;
  lastConversionAt: string | null;
}

interface ConversionStatsResponse {
  sinceDays: number | null;
  attributionWindowMs: number;
  rows: ConversionRow[];
}

interface MeResponse { role?: string }

const SINCE_OPTIONS: Array<{ label: string; value: number | null }> = [
  { label: "All time", value: null },
  { label: "Last 7 days", value: 7 },
  { label: "Last 30 days", value: 30 },
  { label: "Last 90 days", value: 90 },
];

function formatRate(rate: number | null): string {
  if (rate == null) return "—";
  return `${(rate * 100).toFixed(1)}%`;
}

function formatTimestamp(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString();
}

function formatHours(ms: number): string {
  const h = Math.round(ms / (60 * 60 * 1000));
  if (h <= 48) return `${h} hours`;
  return `${Math.round(h / 24)} days`;
}

export default function AdminNotificationConversionsPage() {
  const [sinceDays, setSinceDays] = useState<number | null>(null);

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

  const isSuperAdmin = me?.role === "super_admin";

  const { data, isLoading, isError, error, refetch, isFetching } = useQuery<ConversionStatsResponse>({
    queryKey: ["/api/admin/notification-conversion-stats", sinceDays],
    queryFn: async () => {
      const qs = sinceDays != null ? `?sinceDays=${encodeURIComponent(String(sinceDays))}` : "";
      const res = await fetch(`/api/admin/notification-conversion-stats${qs}`, { credentials: "include" });
      if (res.status === 401) throw new Error("Sign in required to view conversion stats.");
      if (res.status === 403) throw new Error("Super admin role required to view conversion stats.");
      if (!res.ok) throw new Error(`Request failed (HTTP ${res.status})`);
      return (await res.json()) as ConversionStatsResponse;
    },
    enabled: isSuperAdmin,
    staleTime: 60_000,
  });

  // Sort by conversion count desc so the highest-impact keys float to
  // the top — but keep keys with clicks-but-no-conversions visible at
  // the bottom (they're the ones an admin most needs to investigate).
  const sortedRows = useMemo(() => {
    if (!data?.rows) return [] as ConversionRow[];
    const rows = [...data.rows];
    rows.sort((a, b) => {
      if (b.conversionCount !== a.conversionCount) return b.conversionCount - a.conversionCount;
      return b.clickCount - a.clickCount;
    });
    return rows;
  }, [data?.rows]);

  if (meLoading) {
    return (
      <div className="p-6" data-testid="notification-conversions-page">
        <div className="text-sm text-muted-foreground">Loading…</div>
      </div>
    );
  }

  if (!isSuperAdmin) {
    let title = "Notification conversions";
    let body =
      "You need the super admin role to view per-key click → conversion stats. " +
      "Contact a platform admin if you believe this is a mistake.";
    let testId = "notification-conversions-no-access";
    if (meStatus === "error") {
      title = "Couldn't verify your access";
      body =
        "We couldn't reach the authentication service to check your role. " +
        "This usually clears up on its own — please refresh in a moment.";
      testId = "notification-conversions-auth-error";
    } else if (!me) {
      title = "Sign in required";
      body = "You need to sign in to view notification conversion stats.";
      testId = "notification-conversions-signin-required";
    }
    return (
      <div className="p-6" data-testid="notification-conversions-page">
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

  const attributionWindowLabel = data
    ? formatHours(data.attributionWindowMs)
    : "24 hours";

  return (
    <div className="p-6 space-y-6" data-testid="notification-conversions-page">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
            <Target className="w-6 h-6 text-primary" />
            Notification conversions
          </h1>
          <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
            For each notification key, how many of the recipients who clicked the email
            CTA went on to actually complete the action — booking a tee time, registering
            for a tournament, watching a highlight reel, etc. Conversions are credited to
            a click for up to {attributionWindowLabel} after it happens.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <label className="text-xs text-muted-foreground flex items-center gap-2" htmlFor="conversion-since-select">
            Window
            <select
              id="conversion-since-select"
              data-testid="conversion-since-select"
              className="rounded border border-border bg-background px-2 py-1 text-xs"
              value={sinceDays == null ? "all" : String(sinceDays)}
              onChange={(e) => {
                const v = e.target.value;
                setSinceDays(v === "all" ? null : Number(v));
              }}
            >
              {SINCE_OPTIONS.map((o) => (
                <option key={o.label} value={o.value == null ? "all" : String(o.value)}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <Button
            variant="outline"
            size="sm"
            onClick={() => refetch()}
            disabled={isFetching}
            data-testid="button-refresh-conversion-stats"
          >
            <RefreshCw className={`w-4 h-4 mr-2 ${isFetching ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>
      </div>

      {isError ? (
        <div
          className="rounded-lg border border-border bg-card p-6 flex items-start gap-3 text-sm text-red-300"
          data-testid="notification-conversions-error"
        >
          <AlertCircle className="w-5 h-5 flex-shrink-0" />
          <div>
            <div className="font-medium">Could not load conversion stats</div>
            <div className="text-xs text-red-300/80 mt-1">{(error as Error).message}</div>
          </div>
        </div>
      ) : isLoading || !data ? (
        <div
          className="rounded-lg border border-border bg-card p-10 text-center text-sm text-muted-foreground"
          data-testid="notification-conversions-loading"
        >
          Loading conversion stats…
        </div>
      ) : sortedRows.length === 0 ? (
        <div
          className="rounded-lg border border-border bg-card p-10 text-center text-sm text-muted-foreground"
          data-testid="notification-conversions-empty"
        >
          No clicks or conversions recorded
          {sinceDays != null ? ` in the last ${sinceDays} days.` : " yet."}
        </div>
      ) : (
        <div
          className="rounded-lg border border-border bg-card overflow-hidden"
          data-testid="notification-conversions-table"
        >
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-4 py-2 text-left font-medium">Notification key</th>
                <th className="px-4 py-2 text-right font-medium">Clicks</th>
                <th className="px-4 py-2 text-right font-medium">Conversions</th>
                <th className="px-4 py-2 text-right font-medium">Rate</th>
                <th className="px-4 py-2 text-left font-medium">Conversion types</th>
                <th className="px-4 py-2 text-right font-medium">Last conversion</th>
              </tr>
            </thead>
            <tbody>
              {sortedRows.map((r) => {
                const types = Object.entries(r.conversionsByType);
                return (
                  <tr
                    key={r.notificationKey}
                    className="border-t border-border"
                    data-testid={`notification-conversion-row-${r.notificationKey}`}
                  >
                    <td className="px-4 py-2 font-mono text-xs">{r.notificationKey}</td>
                    <td
                      className="px-4 py-2 text-right font-mono"
                      data-testid={`conversion-clicks-${r.notificationKey}`}
                    >
                      {r.clickCount.toLocaleString()}
                    </td>
                    <td
                      className="px-4 py-2 text-right font-mono font-semibold"
                      data-testid={`conversion-count-${r.notificationKey}`}
                    >
                      {r.conversionCount.toLocaleString()}
                    </td>
                    <td
                      className="px-4 py-2 text-right font-mono"
                      data-testid={`conversion-rate-${r.notificationKey}`}
                    >
                      {formatRate(r.conversionRate)}
                    </td>
                    <td className="px-4 py-2 text-xs text-muted-foreground">
                      {types.length === 0 ? (
                        <span className="italic">none</span>
                      ) : (
                        <div className="flex flex-wrap gap-1.5">
                          {types.map(([type, count]) => (
                            <span
                              key={type}
                              className="rounded border border-border bg-muted/30 px-1.5 py-0.5 font-mono"
                              data-testid={`conversion-type-${r.notificationKey}-${type}`}
                            >
                              {type}: {count.toLocaleString()}
                            </span>
                          ))}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-2 text-right text-xs text-muted-foreground">
                      {formatTimestamp(r.lastConversionAt)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
