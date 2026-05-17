// Task #2018 — Admin dashboard for email CTA click-through rates.
//
// The CTR data is collected by `lib/emailCtaTracking.ts` and exposed at
// `GET /api/admin/notification-cta-stats`. Until now staff had to query
// the JSON endpoint directly with curl/Postman to inspect it. This
// page wraps the same endpoint with a sortable table + a "last N days"
// window selector so super-admins can spot underperforming notification
// keys at a glance.
//
// Role-gating mirrors the API endpoint (super_admin only) — there's no
// per-org scoping on the CTR data, so showing it to org admins would
// leak cross-tenant engagement.
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useGetMe } from "@workspace/api-client-react";
import {
  RefreshCw,
  AlertCircle,
  MousePointerClick,
  ArrowUp,
  ArrowDown,
} from "lucide-react";
import { Button } from "@/components/ui/button";

interface CtaStatsRow {
  notificationKey: string;
  sendCount: number;
  clickCount: number;
  /** clickCount / sendCount, in the range [0, 1]. `null` when sendCount is 0. */
  clickThroughRate: number | null;
  lastClickAt: string | null;
  lastSentAt: string | null;
}

interface CtaStatsResponse {
  /** Echoes the `?sinceDays=N` filter that produced this report. */
  sinceDays: number | null;
  rows: CtaStatsRow[];
}

// "all" sentinel maps to "no sinceDays param" (running totals).
type WindowChoice = "7" | "30" | "90" | "all";

const WINDOW_OPTIONS: Array<{ value: WindowChoice; label: string }> = [
  { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" },
  { value: "all", label: "All time" },
];

// Columns the user can sort by. Keep this list small — sorting by
// timestamp string would be misleading when half the rows are `null`,
// and notification key sorting is just the API's default order.
type SortKey = "ctr" | "clicks" | "sends";
type SortDir = "asc" | "desc";

const SORT_LABEL: Record<SortKey, string> = {
  ctr: "CTR",
  clicks: "Clicks",
  sends: "Sends",
};

function formatPct(ctr: number | null): string {
  if (ctr == null) return "—";
  // Two decimals at low CTRs (typical for email) so a 0.5% row doesn't
  // collapse to "1%".
  const pct = ctr * 100;
  if (pct >= 10) return `${pct.toFixed(1)}%`;
  return `${pct.toFixed(2)}%`;
}

function formatTimestamp(iso: string | null): string {
  if (!iso) return "Never";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "Never";
  return d.toLocaleString();
}

/**
 * Sort rows in place-safe (returns a new array).
 *
 * For CTR specifically, rows with `null` CTR (zero sends) always sink
 * to the bottom regardless of direction — they have no meaningful
 * value and would otherwise dominate the "ascending" view as 0%.
 */
function sortRows(rows: CtaStatsRow[], key: SortKey, dir: SortDir): CtaStatsRow[] {
  const sign = dir === "asc" ? 1 : -1;
  const next = [...rows];
  next.sort((a, b) => {
    if (key === "ctr") {
      const aNull = a.clickThroughRate == null;
      const bNull = b.clickThroughRate == null;
      if (aNull && bNull) return a.notificationKey.localeCompare(b.notificationKey);
      if (aNull) return 1;
      if (bNull) return -1;
      return sign * ((a.clickThroughRate ?? 0) - (b.clickThroughRate ?? 0));
    }
    const av = key === "clicks" ? a.clickCount : a.sendCount;
    const bv = key === "clicks" ? b.clickCount : b.sendCount;
    if (av === bv) return a.notificationKey.localeCompare(b.notificationKey);
    return sign * (av - bv);
  });
  return next;
}

export default function AdminEmailCtaStatsPage() {
  const [windowChoice, setWindowChoice] = useState<WindowChoice>("30");
  const [sortKey, setSortKey] = useState<SortKey>("ctr");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  const { data: me, isLoading: meLoading } = useGetMe();
  const role = (me as { role?: string } | undefined)?.role;
  const isSuperAdmin = role === "super_admin";

  const sinceDaysParam = windowChoice === "all" ? null : windowChoice;

  const { data, isLoading, isError, error, refetch, isFetching } = useQuery<CtaStatsResponse>({
    queryKey: ["/api/admin/notification-cta-stats", sinceDaysParam],
    queryFn: async () => {
      const url = sinceDaysParam
        ? `/api/admin/notification-cta-stats?sinceDays=${encodeURIComponent(sinceDaysParam)}`
        : "/api/admin/notification-cta-stats";
      const res = await fetch(url, { credentials: "include" });
      if (res.status === 401) throw new Error("Sign in required to view email CTA stats.");
      if (res.status === 403) throw new Error("Super admin access required to view email CTA stats.");
      if (!res.ok) throw new Error(`Request failed (HTTP ${res.status})`);
      return (await res.json()) as CtaStatsResponse;
    },
    enabled: isSuperAdmin,
    staleTime: 60_000,
  });

  const sortedRows = useMemo(
    () => (data ? sortRows(data.rows, sortKey, sortDir) : []),
    [data, sortKey, sortDir],
  );

  // Headline tile values. Sends are running totals from the server (see
  // `getCtaStats` docstring); the server reuses that asymmetry across
  // every windowed view so we surface it inline below the tiles.
  const totals = useMemo(() => {
    if (!data) return { keys: 0, sends: 0, clicks: 0, ctr: null as number | null };
    let sends = 0;
    let clicks = 0;
    for (const r of data.rows) {
      sends += r.sendCount;
      clicks += r.clickCount;
    }
    return {
      keys: data.rows.length,
      sends,
      clicks,
      ctr: sends > 0 ? clicks / sends : null,
    };
  }, [data]);

  const onHeaderClick = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      // Default to descending — admins almost always want to see the
      // highest performers first when they switch sort columns.
      setSortDir("desc");
    }
  };

  if (meLoading) {
    return (
      <div className="p-6" data-testid="email-cta-stats-page">
        <div className="text-sm text-muted-foreground">Loading…</div>
      </div>
    );
  }

  if (!isSuperAdmin) {
    return (
      <div className="p-6" data-testid="email-cta-stats-page">
        <div
          className="rounded-lg border border-border bg-card p-6 max-w-xl"
          data-testid="email-cta-stats-no-access"
        >
          <div className="flex items-start gap-3">
            <AlertCircle className="w-5 h-5 mt-0.5 text-destructive" />
            <div>
              <h1 className="text-lg font-semibold">Super admin access required</h1>
              <p className="text-sm text-muted-foreground mt-1">
                Email click-through rates are only visible to platform super admins. Contact a
                super admin if you need to inspect these numbers.
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6" data-testid="email-cta-stats-page">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
            <MousePointerClick className="w-6 h-6 text-primary" />
            Email click-through rates
          </h1>
          <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
            Per-notification-key sends, clicks and CTR for branded notification emails.
            Sort by CTR or clicks to spot underperforming templates, and use the window
            selector to compare recent activity against the running totals.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <label className="text-xs text-muted-foreground flex items-center gap-2" htmlFor="email-cta-window">
            Window
            <select
              id="email-cta-window"
              data-testid="email-cta-window-select"
              className="rounded border border-border bg-background px-2 py-1 text-xs"
              value={windowChoice}
              onChange={(e) => setWindowChoice(e.target.value as WindowChoice)}
            >
              {WINDOW_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </label>
          <Button
            variant="outline"
            size="sm"
            onClick={() => refetch()}
            disabled={isFetching}
            data-testid="button-refresh-email-cta-stats"
          >
            <RefreshCw className={`w-4 h-4 mr-2 ${isFetching ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>
      </div>

      {isError ? (
        <div
          className="rounded-lg border border-border bg-card p-6 flex items-start gap-3 text-sm text-red-300"
          data-testid="email-cta-stats-error"
        >
          <AlertCircle className="w-5 h-5 flex-shrink-0" />
          <div>
            <div className="font-medium">Could not load email CTA stats</div>
            <div className="text-xs text-red-300/80 mt-1">{(error as Error).message}</div>
          </div>
        </div>
      ) : isLoading || !data ? (
        <div
          className="rounded-lg border border-border bg-card p-10 text-center text-sm text-muted-foreground"
          data-testid="email-cta-stats-loading"
        >
          Loading email CTA stats…
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div className="rounded-lg border border-border bg-card p-4" data-testid="email-cta-tile-keys">
              <div className="text-xs uppercase tracking-wide text-muted-foreground">Notification keys</div>
              <div className="text-3xl font-semibold mt-2 font-mono">
                {totals.keys.toLocaleString()}
              </div>
              <div className="text-xs text-muted-foreground mt-1">
                Keys with at least one send or click.
              </div>
            </div>
            <div className="rounded-lg border border-border bg-card p-4" data-testid="email-cta-tile-sends">
              <div className="text-xs uppercase tracking-wide text-muted-foreground">Total sends</div>
              <div className="text-3xl font-semibold mt-2 font-mono">
                {totals.sends.toLocaleString()}
              </div>
              <div className="text-xs text-muted-foreground mt-1">
                Running total — not narrowed by the window above.
              </div>
            </div>
            <div className="rounded-lg border border-border bg-card p-4" data-testid="email-cta-tile-clicks">
              <div className="text-xs uppercase tracking-wide text-muted-foreground">Total clicks</div>
              <div className="text-3xl font-semibold mt-2 font-mono">
                {totals.clicks.toLocaleString()}
              </div>
              <div className="text-xs text-muted-foreground mt-1">
                {windowChoice === "all"
                  ? "All clicks ever recorded."
                  : `Clicks in the last ${windowChoice} days.`}
              </div>
            </div>
            <div className="rounded-lg border border-border bg-card p-4" data-testid="email-cta-tile-ctr">
              <div className="text-xs uppercase tracking-wide text-muted-foreground">Aggregate CTR</div>
              <div className="text-3xl font-semibold mt-2 font-mono">
                {formatPct(totals.ctr)}
              </div>
              <div className="text-xs text-muted-foreground mt-1">
                Total clicks ÷ total sends.
              </div>
            </div>
          </div>

          {/*
            Inline caveat about the click/send window asymmetry. The server
            doesn't store per-send rows, so click counts honour `sinceDays`
            but send counts are the lifetime total. Calling that out
            keeps admins from misreading suspiciously high CTRs in narrow
            windows.
          */}
          {windowChoice !== "all" && (
            <div
              className="rounded-md border border-border bg-muted/30 px-4 py-2 text-xs text-muted-foreground"
              data-testid="email-cta-window-caveat"
            >
              Click counts and "Last clicked" are limited to the last {windowChoice} days; send
              counts and "Last sent" remain running totals (no per-send history is stored).
            </div>
          )}

          <div
            className="rounded-lg border border-border bg-card overflow-hidden"
            data-testid="email-cta-stats-table"
          >
            <div className="px-4 py-3 border-b border-border flex items-center justify-between">
              <div>
                <h2 className="text-sm font-semibold">Per-notification CTR</h2>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Click a sortable column header to reorder. Currently sorted by{" "}
                  <span className="font-semibold">{SORT_LABEL[sortKey]}</span>{" "}
                  ({sortDir === "asc" ? "ascending" : "descending"}).
                </p>
              </div>
              <div className="text-xs text-muted-foreground">
                {sortedRows.length} {sortedRows.length === 1 ? "key" : "keys"}
              </div>
            </div>
            {sortedRows.length === 0 ? (
              <div className="p-8 text-center text-sm text-muted-foreground" data-testid="email-cta-stats-empty">
                No notification email activity recorded for this window yet.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-muted/40 text-xs uppercase text-muted-foreground">
                    <tr>
                      <th className="px-4 py-2 text-left font-medium">Notification key</th>
                      <SortHeader
                        label="Sends"
                        active={sortKey === "sends"}
                        dir={sortDir}
                        onClick={() => onHeaderClick("sends")}
                        testId="email-cta-sort-sends"
                      />
                      <SortHeader
                        label="Clicks"
                        active={sortKey === "clicks"}
                        dir={sortDir}
                        onClick={() => onHeaderClick("clicks")}
                        testId="email-cta-sort-clicks"
                      />
                      <SortHeader
                        label="CTR"
                        active={sortKey === "ctr"}
                        dir={sortDir}
                        onClick={() => onHeaderClick("ctr")}
                        testId="email-cta-sort-ctr"
                      />
                      <th className="px-4 py-2 text-left font-medium">Last sent</th>
                      <th className="px-4 py-2 text-left font-medium">Last clicked</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedRows.map((r) => (
                      <tr
                        key={r.notificationKey}
                        className="border-t border-border"
                        data-testid={`email-cta-row-${r.notificationKey}`}
                      >
                        <td className="px-4 py-2 font-mono text-xs">{r.notificationKey}</td>
                        <td
                          className="px-4 py-2 text-right font-mono"
                          data-testid={`email-cta-row-${r.notificationKey}-sends`}
                        >
                          {r.sendCount.toLocaleString()}
                        </td>
                        <td
                          className="px-4 py-2 text-right font-mono"
                          data-testid={`email-cta-row-${r.notificationKey}-clicks`}
                        >
                          {r.clickCount.toLocaleString()}
                        </td>
                        <td
                          className="px-4 py-2 text-right font-mono font-semibold"
                          data-testid={`email-cta-row-${r.notificationKey}-ctr`}
                        >
                          {formatPct(r.clickThroughRate)}
                        </td>
                        <td className="px-4 py-2 text-muted-foreground">
                          {formatTimestamp(r.lastSentAt)}
                        </td>
                        <td className="px-4 py-2 text-muted-foreground">
                          {formatTimestamp(r.lastClickAt)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function SortHeader({
  label,
  active,
  dir,
  onClick,
  testId,
}: {
  label: string;
  active: boolean;
  dir: SortDir;
  onClick: () => void;
  testId: string;
}) {
  return (
    <th className="px-4 py-2 text-right font-medium">
      <button
        type="button"
        onClick={onClick}
        data-testid={testId}
        data-active-sort={active ? "true" : "false"}
        data-sort-dir={active ? dir : "none"}
        className={
          "inline-flex items-center gap-1 select-none hover:text-foreground transition-colors " +
          (active ? "text-foreground" : "")
        }
        aria-label={`Sort by ${label}${active ? ` (currently ${dir})` : ""}`}
      >
        <span>{label}</span>
        {active ? (
          dir === "asc" ? (
            <ArrowUp className="w-3 h-3" aria-hidden />
          ) : (
            <ArrowDown className="w-3 h-3" aria-hidden />
          )
        ) : (
          <ArrowUp className="w-3 h-3 opacity-20" aria-hidden />
        )}
      </button>
    </th>
  );
}
