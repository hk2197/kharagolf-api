// Task #1510 — Org-wide view of recap share activity.
//
// Companion to the per-player panel on the player portal Year-in-Golf page
// (Task #1281). Surfaces the totals that GET /api/admin/recap-share-stats
// returns for the caller's org (or the whole platform, for super admins),
// plus a top-N players-by-opens list so clubs can see who is driving
// public recap traffic and spot crawler-heavy activity early.
//
// Both `org_admin` and `super_admin` (and `tournament_director`) can view
// this page. Server-side scoping pins org admins to their own organization;
// super admins see platform-wide totals.
import { Fragment, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { RefreshCw, AlertCircle, Share2, Users, ChevronDown, ChevronRight, Download, Bot } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

interface PeriodBucket {
  year: number;
  period: string;
  total: number;
  byAsset: { card_png: number; og: number };
  bySource: {
    copy: number; web_share: number; native_share: number;
    qr_open: number; crawler: number; unknown: number;
  };
}

interface TopPlayer {
  userId: number;
  username: string | null;
  displayName: string | null;
  publicHandle: string | null;
  total: number;
  opens: number;
  // Task #1867 — server-stamped crawler-only abuse signal so the admin
  // panel can call out players whose share traffic is dominated by
  // link-preview crawlers (a clean early signal of bot abuse). The
  // server enforces the threshold so the UI doesn't silently disagree
  // with downstream tooling that consumes the same flag.
  crawlerHits: number;
  crawlerRatio: number;
  crawlerAbuseSuspected: boolean;
}

interface AbuseThresholds {
  minTotalHits: number;
  crawlerRatio: number;
}

interface StatsResponse {
  scope: "org" | "platform";
  organizationId: number | null;
  total: number;
  totalsByAsset: { card_png: number; og: number };
  totalsBySource: {
    copy: number; web_share: number; native_share: number;
    qr_open: number; crawler: number; unknown: number;
  };
  byPeriod: PeriodBucket[];
  topPlayers: TopPlayer[];
  topN: number;
  abuseThresholds: AbuseThresholds;
}

interface PlayerStatsResponse {
  userId: number;
  username: string | null;
  displayName: string | null;
  publicHandle: string | null;
  total: number;
  totalsByAsset: { card_png: number; og: number };
  totalsBySource: {
    copy: number; web_share: number; native_share: number;
    qr_open: number; crawler: number; unknown: number;
  };
  byPeriod: PeriodBucket[];
}

interface MeResponse { role?: string }

const ADMIN_ROLES = new Set(["org_admin", "super_admin", "tournament_director"]);

const PERIOD_LABEL: Record<string, string> = {
  year: "Annual",
  q1: "Q1",
  q2: "Q2",
  q3: "Q3",
  q4: "Q4",
};

const SOURCE_LABEL: Record<string, string> = {
  copy: "Copy link",
  web_share: "Web Share",
  native_share: "Native Share",
  qr_open: "QR open",
  crawler: "Link preview",
  unknown: "Direct / unknown",
};

function formatPeriod(year: number, period: string): string {
  const label = PERIOD_LABEL[period] ?? period;
  return `${label} ${year}`;
}

function describePlayer(p: TopPlayer): string {
  if (p.displayName && p.displayName.trim() !== "") return p.displayName;
  if (p.username && p.username.trim() !== "") return p.username;
  return `User #${p.userId}`;
}

// Drill-down panel for one expanded player row. Lazily fetches the
// per-player breakdown the first time a row is expanded; the response
// is cached by react-query so re-expanding doesn't re-fetch unless the
// caller hits "Refresh" on the parent page (which invalidates a
// different key).
function PlayerDrillDown({ userId }: { userId: number }) {
  const { data, isLoading, isError, error } = useQuery<PlayerStatsResponse>({
    queryKey: ["/api/admin/recap-share-stats/player", userId],
    queryFn: async () => {
      const res = await fetch(
        `/api/admin/recap-share-stats/player/${encodeURIComponent(String(userId))}`,
        { credentials: "include" },
      );
      if (res.status === 401) throw new Error("Sign in required.");
      if (res.status === 403) throw new Error("Admin role required.");
      if (res.status === 404) throw new Error("Player not found in your organization.");
      if (!res.ok) throw new Error(`Request failed (HTTP ${res.status})`);
      return (await res.json()) as PlayerStatsResponse;
    },
    staleTime: 60_000,
  });

  if (isLoading) {
    return (
      <div
        className="px-4 py-3 text-xs text-muted-foreground"
        data-testid={`recap-share-player-drill-loading-${userId}`}
      >
        Loading per-period breakdown…
      </div>
    );
  }
  if (isError || !data) {
    return (
      <div
        className="px-4 py-3 text-xs text-red-300 flex items-center gap-2"
        data-testid={`recap-share-player-drill-error-${userId}`}
      >
        <AlertCircle className="w-3.5 h-3.5" />
        {(error as Error | undefined)?.message ?? "Failed to load breakdown."}
      </div>
    );
  }
  if (data.byPeriod.length === 0) {
    return (
      <div
        className="px-4 py-3 text-xs text-muted-foreground"
        data-testid={`recap-share-player-drill-empty-${userId}`}
      >
        No recap shares recorded for this member yet.
      </div>
    );
  }

  return (
    <div
      className="px-4 py-3 bg-muted/20 border-y border-border"
      data-testid={`recap-share-player-drill-${userId}`}
    >
      <div className="text-xs uppercase tracking-wide text-muted-foreground mb-2">
        Per-period & per-source breakdown
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="text-muted-foreground">
            <tr>
              <th className="px-2 py-1 text-left font-medium">Period</th>
              <th className="px-2 py-1 text-right font-medium">Card PNG</th>
              <th className="px-2 py-1 text-right font-medium">OG link</th>
              {(Object.keys(SOURCE_LABEL) as Array<keyof typeof SOURCE_LABEL>).map((k) => (
                <th key={k} className="px-2 py-1 text-right font-medium">{SOURCE_LABEL[k]}</th>
              ))}
              <th className="px-2 py-1 text-right font-medium">Total</th>
            </tr>
          </thead>
          <tbody>
            {data.byPeriod.map((p) => {
              const key = `${p.year}-${p.period}`;
              return (
                <tr
                  key={key}
                  className="border-t border-border/60"
                  data-testid={`recap-share-player-drill-${userId}-row-${key}`}
                >
                  <td className="px-2 py-1 font-medium">{formatPeriod(p.year, p.period)}</td>
                  <td className="px-2 py-1 text-right font-mono">{p.byAsset.card_png.toLocaleString()}</td>
                  <td className="px-2 py-1 text-right font-mono">{p.byAsset.og.toLocaleString()}</td>
                  {(Object.keys(SOURCE_LABEL) as Array<keyof typeof SOURCE_LABEL>).map((k) => (
                    <td
                      key={k}
                      className="px-2 py-1 text-right font-mono text-muted-foreground"
                      data-testid={`recap-share-player-drill-${userId}-${key}-source-${k}`}
                    >
                      {p.bySource[k as keyof typeof p.bySource].toLocaleString()}
                    </td>
                  ))}
                  <td className="px-2 py-1 text-right font-mono font-semibold">{p.total.toLocaleString()}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function AdminRecapShareStatsPage() {
  const [topN, setTopN] = useState<number>(10);
  // Set of userIds whose drill-down row is expanded. Tracking expansion
  // separately (rather than a single "expandedId") lets admins compare
  // multiple top sharers side-by-side.
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const toggleExpanded = (userId: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId); else next.add(userId);
      return next;
    });
  };

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
  const isSuperAdmin = me?.role === "super_admin";

  const { data, isLoading, isError, error, refetch, isFetching } = useQuery<StatsResponse>({
    queryKey: ["/api/admin/recap-share-stats", topN],
    queryFn: async () => {
      const res = await fetch(
        `/api/admin/recap-share-stats?topN=${encodeURIComponent(String(topN))}`,
        { credentials: "include" },
      );
      if (res.status === 401) throw new Error("Sign in required to view recap share stats.");
      if (res.status === 403) throw new Error("Admin role required to view recap share stats.");
      if (!res.ok) throw new Error(`Request failed (HTTP ${res.status})`);
      return (await res.json()) as StatsResponse;
    },
    enabled: isAdmin,
    staleTime: 60_000,
  });

  if (meLoading) {
    return (
      <div className="p-6" data-testid="recap-share-stats-page">
        <div className="text-sm text-muted-foreground">Loading…</div>
      </div>
    );
  }

  if (!isAdmin) {
    let title = "Recap share stats";
    let body =
      "You need an admin role (organization admin, tournament director, or super admin) to view this page. " +
      "Contact your club administrator if you believe this is a mistake.";
    let testId = "recap-share-stats-no-access";
    if (meStatus === "error") {
      title = "Couldn't verify your access";
      body =
        "We couldn't reach the authentication service to check your role. " +
        "This usually clears up on its own — please refresh in a moment.";
      testId = "recap-share-stats-auth-error";
    } else if (!me) {
      title = "Sign in required";
      body = "You need to sign in to view recap share stats.";
      testId = "recap-share-stats-signin-required";
    }
    return (
      <div className="p-6" data-testid="recap-share-stats-page">
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

  const totalsBySource = data?.totalsBySource;
  const totalsByAsset = data?.totalsByAsset;

  return (
    <div className="p-6 space-y-6" data-testid="recap-share-stats-page">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
            <Share2 className="w-6 h-6 text-primary" />
            Recap share stats
          </h1>
          <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
            Hits to your members' public Year-in-Golf recap links, broken down by asset,
            source, and recap period. {isSuperAdmin
              ? "You're viewing platform-wide totals across every club."
              : "You're viewing totals scoped to your organization."}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <label className="text-xs text-muted-foreground flex items-center gap-2" htmlFor="recap-share-top-n">
            Top sharers
            <select
              id="recap-share-top-n"
              data-testid="recap-share-top-n-select"
              className="rounded border border-border bg-background px-2 py-1 text-xs"
              value={String(topN)}
              onChange={(e) => setTopN(Number(e.target.value))}
            >
              {[5, 10, 20, 50].map(n => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
          </label>
          {/*
            Task #1866 — Plain anchor (not a fetch) so the browser
            handles the file download (with cookies for auth) via the
            response's Content-Disposition header. The CSV endpoint
            mirrors the JSON endpoint's role gate + tenant scope and
            honours the same `topN` query param so the downloaded
            file matches what the admin sees on screen.
          */}
          <Button asChild variant="outline" size="sm">
            <a
              href={`/api/admin/recap-share-stats.csv?topN=${encodeURIComponent(String(topN))}`}
              download
              data-testid="button-download-recap-share-stats-csv"
            >
              <Download className="w-4 h-4 mr-2" />
              CSV
            </a>
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => refetch()}
            disabled={isFetching}
            data-testid="button-refresh-recap-share-stats"
          >
            <RefreshCw className={`w-4 h-4 mr-2 ${isFetching ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>
      </div>

      {isError ? (
        <div
          className="rounded-lg border border-border bg-card p-6 flex items-start gap-3 text-sm text-red-300"
          data-testid="recap-share-stats-error"
        >
          <AlertCircle className="w-5 h-5 flex-shrink-0" />
          <div>
            <div className="font-medium">Could not load recap share stats</div>
            <div className="text-xs text-red-300/80 mt-1">{(error as Error).message}</div>
          </div>
        </div>
      ) : isLoading || !data ? (
        <div
          className="rounded-lg border border-border bg-card p-10 text-center text-sm text-muted-foreground"
          data-testid="recap-share-stats-loading"
        >
          Loading recap share stats…
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="rounded-lg border border-border bg-card p-4" data-testid="recap-share-total-card">
              <div className="text-xs uppercase tracking-wide text-muted-foreground">Total hits</div>
              <div className="text-3xl font-semibold mt-2 font-mono" data-testid="recap-share-total-value">
                {data.total.toLocaleString()}
              </div>
              <div className="text-xs text-muted-foreground mt-1">
                Combined raw events + rolled-up daily aggregates.
              </div>
            </div>
            <div className="rounded-lg border border-border bg-card p-4" data-testid="recap-share-by-asset-card">
              <div className="text-xs uppercase tracking-wide text-muted-foreground">By asset</div>
              <div className="mt-2 space-y-1 text-sm">
                <div className="flex justify-between">
                  <span>Card image (PNG)</span>
                  <span className="font-mono" data-testid="recap-share-asset-card_png">
                    {(totalsByAsset?.card_png ?? 0).toLocaleString()}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>Open Graph (link preview)</span>
                  <span className="font-mono" data-testid="recap-share-asset-og">
                    {(totalsByAsset?.og ?? 0).toLocaleString()}
                  </span>
                </div>
              </div>
            </div>
            <div className="rounded-lg border border-border bg-card p-4" data-testid="recap-share-by-source-card">
              <div className="text-xs uppercase tracking-wide text-muted-foreground">By source</div>
              <div className="mt-2 space-y-1 text-sm">
                {totalsBySource ? (Object.keys(SOURCE_LABEL) as Array<keyof typeof SOURCE_LABEL>).map((k) => (
                  <div key={k} className="flex justify-between">
                    <span>{SOURCE_LABEL[k]}</span>
                    <span className="font-mono" data-testid={`recap-share-source-${k}`}>
                      {totalsBySource[k as keyof typeof totalsBySource].toLocaleString()}
                    </span>
                  </div>
                )) : null}
              </div>
            </div>
          </div>

          <div
            className="rounded-lg border border-border bg-card overflow-hidden"
            data-testid="recap-share-by-period"
          >
            <div className="px-4 py-3 border-b border-border flex items-center justify-between">
              <div>
                <h2 className="text-sm font-semibold">By recap period</h2>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Which Year-in-Golf window is generating the most external traffic.
                </p>
              </div>
            </div>
            {data.byPeriod.length === 0 ? (
              <div className="p-8 text-center text-sm text-muted-foreground" data-testid="recap-share-by-period-empty">
                No recap shares recorded yet.
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead className="bg-muted/40 text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2 text-left font-medium">Period</th>
                    <th className="px-4 py-2 text-right font-medium">Card PNG</th>
                    <th className="px-4 py-2 text-right font-medium">OG link</th>
                    <th className="px-4 py-2 text-right font-medium">Crawler</th>
                    <th className="px-4 py-2 text-right font-medium">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {data.byPeriod.map((p) => {
                    const key = `${p.year}-${p.period}`;
                    return (
                      <tr key={key} className="border-t border-border" data-testid={`recap-share-period-row-${key}`}>
                        <td className="px-4 py-2 font-medium">{formatPeriod(p.year, p.period)}</td>
                        <td className="px-4 py-2 text-right font-mono">{p.byAsset.card_png.toLocaleString()}</td>
                        <td className="px-4 py-2 text-right font-mono">{p.byAsset.og.toLocaleString()}</td>
                        <td className="px-4 py-2 text-right font-mono text-muted-foreground">
                          {p.bySource.crawler.toLocaleString()}
                        </td>
                        <td className="px-4 py-2 text-right font-mono font-semibold">{p.total.toLocaleString()}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>

          <div
            className="rounded-lg border border-border bg-card overflow-hidden"
            data-testid="recap-share-top-players"
          >
            <div className="px-4 py-3 border-b border-border flex items-center justify-between">
              <div>
                <h2 className="text-sm font-semibold flex items-center gap-2">
                  <Users className="w-4 h-4 text-muted-foreground" />
                  Top sharers (by opens)
                </h2>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Ranked by human-driven opens (Copy / Web Share / Native Share / QR / Direct).
                  Link-preview crawler hits are shown for context but don't affect ranking.
                </p>
                {/* Task #1867 — document the crawler-abuse threshold inline so admins
                    don't have to hunt for what "Crawler-heavy" means. */}
                <p
                  className="text-xs text-muted-foreground mt-1"
                  data-testid="recap-share-abuse-threshold-doc"
                >
                  Players are flagged as <span className="font-semibold">Crawler-heavy</span> when
                  link-preview crawlers account for at least{" "}
                  {Math.round(data.abuseThresholds.crawlerRatio * 100)}% of their hits and they
                  have at least {data.abuseThresholds.minTotalHits.toLocaleString()} total hits —
                  a strong early signal of bot abuse.
                </p>
              </div>
              <div className="text-xs text-muted-foreground">
                Showing top {data.topPlayers.length} of up to {data.topN}
              </div>
            </div>
            {data.topPlayers.length === 0 ? (
              <div className="p-8 text-center text-sm text-muted-foreground" data-testid="recap-share-top-players-empty">
                No public recap shares from your members yet.
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead className="bg-muted/40 text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2 text-left font-medium w-8" aria-label="Expand" />
                    <th className="px-4 py-2 text-left font-medium w-10">#</th>
                    <th className="px-4 py-2 text-left font-medium">Player</th>
                    <th className="px-4 py-2 text-left font-medium">Public handle</th>
                    <th className="px-4 py-2 text-right font-medium">Opens</th>
                    <th className="px-4 py-2 text-right font-medium">Total hits</th>
                    <th className="px-4 py-2 text-right font-medium">Crawler %</th>
                  </tr>
                </thead>
                <tbody>
                  {data.topPlayers.map((p, idx) => {
                    const crawler = p.crawlerHits;
                    const crawlerPct = Math.round(p.crawlerRatio * 100);
                    const flagged = p.crawlerAbuseSuspected;
                    const isOpen = expanded.has(p.userId);
                    return (
                      <Fragment key={p.userId}>
                        <tr
                          // Subtle destructive-tinted background for flagged rows.
                          // The badge + icon below carry the same signal so the
                          // tint is purely supportive (accessible without colour).
                          className={
                            "border-t border-border " +
                            (flagged ? "bg-destructive/10" : "")
                          }
                          data-testid={`recap-share-top-player-${p.userId}`}
                          data-crawler-abuse-suspected={flagged ? "true" : "false"}
                        >
                          <td className="px-2 py-2 align-top">
                            <button
                              type="button"
                              onClick={() => toggleExpanded(p.userId)}
                              className="p-1 rounded hover:bg-muted/60 text-muted-foreground"
                              aria-expanded={isOpen}
                              aria-label={isOpen ? "Collapse breakdown" : "Expand breakdown"}
                              data-testid={`button-toggle-recap-share-player-${p.userId}`}
                            >
                              {isOpen
                                ? <ChevronDown className="w-4 h-4" />
                                : <ChevronRight className="w-4 h-4" />}
                            </button>
                          </td>
                          <td className="px-4 py-2 text-muted-foreground font-mono align-top">{idx + 1}</td>
                          <td className="px-4 py-2 align-top">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="font-medium">{describePlayer(p)}</span>
                              {flagged ? (
                                <Badge
                                  variant="destructive"
                                  className="gap-1"
                                  data-testid={`recap-share-top-player-${p.userId}-crawler-flag`}
                                  aria-label={
                                    `Crawler-heavy: ${crawlerPct}% of ${p.total.toLocaleString()} ` +
                                    `hits are link-preview crawlers`
                                  }
                                  title={
                                    `${crawlerPct}% of ${p.total.toLocaleString()} hits are ` +
                                    `link-preview crawlers — likely bot abuse.`
                                  }
                                >
                                  <Bot className="w-3 h-3" aria-hidden="true" />
                                  Crawler-heavy
                                </Badge>
                              ) : null}
                            </div>
                            {p.username && p.displayName ? (
                              <div className="text-xs text-muted-foreground">@{p.username}</div>
                            ) : null}
                          </td>
                          <td className="px-4 py-2 text-xs text-muted-foreground align-top">
                            {p.publicHandle ? `@${p.publicHandle}` : <span className="italic">(none)</span>}
                          </td>
                          <td className="px-4 py-2 text-right font-mono font-semibold align-top">
                            {p.opens.toLocaleString()}
                          </td>
                          <td className="px-4 py-2 text-right font-mono align-top">
                            {p.total.toLocaleString()}
                            {crawler > 0 ? (
                              <span className="ml-1 text-xs text-muted-foreground">
                                (+{crawler.toLocaleString()} crawler)
                              </span>
                            ) : null}
                          </td>
                          <td
                            className={
                              "px-4 py-2 text-right font-mono align-top " +
                              (flagged ? "text-destructive font-semibold" : "text-muted-foreground")
                            }
                            data-testid={`recap-share-top-player-${p.userId}-crawler-ratio`}
                          >
                            {p.total > 0 ? `${crawlerPct}%` : "—"}
                          </td>
                        </tr>
                        {isOpen ? (
                          <tr data-testid={`recap-share-top-player-drill-row-${p.userId}`}>
                            <td colSpan={7} className="p-0">
                              <PlayerDrillDown userId={p.userId} />
                            </td>
                          </tr>
                        ) : null}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </div>
  );
}
