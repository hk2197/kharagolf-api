// Super-admin share-rollup storage-savings dashboard.
//
// Originally added in Task #1260 for the badge-share rollup
// (`pruneAndRollupBadgeShareEvents`, Task #1096). Task #1474 extended
// the panel to also surface the sibling profile-share rollup
// (`pruneAndRollupProfileShareEvents`, Task #1259) so admins can see
// both in one place. Each rollup gets the same pair of cards (current
// table sizes + most recent run) plus a stale-cron warning banner.
import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { useGetMe } from "@workspace/api-client-react";
import { useLocation } from "wouter";
import {
  AlertCircle, AlertTriangle, ArrowLeft, BellRing, Crown, Database, HardDrive, HelpCircle,
  Layers, Loader2, RefreshCw, Share2, TrendingDown, UserSquare2,
} from "lucide-react";
import {
  Line, LineChart, ResponsiveContainer,
  Tooltip as RechartsTooltip, XAxis, YAxis,
} from "recharts";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
// Task #2057 — shared "Slack ✓ / PagerDuty ✗ + Send test page" panel,
// mirroring the watch-GPS pattern from Task #1653 across every
// ops-alert dashboard.
import { OpsAlertWiringPanel } from "@/components/OpsAlertWiringPanel";
import { useOpsAlertTestPageMutation } from "@/hooks/use-ops-alert-test-page";

// Task #1821 — One sample on the storage-savings sparkline. Mirrors
// `BadgeShareRollupHistoryPoint` on the API.
interface ShareRollupHistoryPoint {
  ranAt: string;
  savingsPercent: number | null;
  savingsRatio: number | null;
}

interface ShareRollupAdminSummary {
  lastRun: {
    ranAt: string;
    rolledUpEvents: number;
    upsertedAggregateRows: number;
    prunedAggregateRows: number;
  } | null;
  currentRawEventCount: number;
  currentAggregateRowCount: number;
  storageSavings: {
    aggregatedEventCount: number;
    estimatedRowsSaved: number;
    estimatedBytesSaved: number;
    estimatedBytesPerRawRow: number;
    // Task #1479 — row-count compression KPIs ("X% smaller than raw"
    // / "raw events would be N× larger without rollup"). Both null
    // until the rollup has collapsed at least one event.
    savingsPercent: number | null;
    savingsRatio: number | null;
  };
  // Task #1821 — Per-run trend points for the sparkline (badge-share
  // variant only at the moment; the profile-share endpoint omits
  // these fields so both keys are optional).
  history?: ShareRollupHistoryPoint[];
  historyDays?: number;
  isStale: boolean;
  staleThresholdMs: number;
  rollupAgeMs: number;
  // Task #1814 — Auto-pager (Task #1478) state. Only the badge-share
  // rollup endpoint populates these fields today; the profile-share
  // sibling endpoint omits them (a follow-up task tracks adding the
  // auto-pager there). Optional on the shared interface so a missing
  // field gracefully renders as "no recent ops alert".
  lastOpsAlertAt?: string | null;
  opsAlertCooldownMs?: number;
  // Task #2057 — sanitized Slack/PagerDuty chat-channel config so the
  // panel can render `Slack ✓ / PagerDuty ✗` badges + a "Send test
  // page" button alongside the email auto-pager state. Booleans only;
  // never carries the webhook URL or routing key. Optional because
  // only the badge-share rollup endpoint populates this today (the
  // profile-share sibling has no auto-pager).
  chatTargets?: {
    slackConfigured: boolean;
    pagerDutyConfigured: boolean;
  };
  generatedAt: string;
}

interface ShareRollupVariant {
  key: string;
  title: string;
  description: string;
  rawTableName: string;
  aggregateTableName: string;
  endpoint: string;
  testIdSuffix: string;
  // Task #2261 — env var name shown in the cooldown tooltip so each
  // variant points operators at the right override knob (badge-share
  // and profile-share have separate cooldown envs).
  cooldownEnvVar: string;
  // Task #2261 — when set, the panel renders a "Recent ops alerts"
  // disclosure under the rollup-health row, paginating against this
  // endpoint. Profile-share variant has it; badge-share variant does
  // not yet (still on the singleton-cooldown table from Task #1814).
  pageHistoryEndpoint?: string;
}

const VARIANTS: ShareRollupVariant[] = [
  {
    key: "badge",
    title: "Badge-share rollup",
    description: "badge_share_events",
    rawTableName: "badge_share_events",
    aggregateTableName: "badge_share_daily_aggregates",
    endpoint: "/api/super-admin/badge-share-rollup/summary",
    testIdSuffix: "badge-share",
    cooldownEnvVar: "OPS_BADGE_SHARE_ROLLUP_STALE_COOLDOWN_HOURS",
  },
  {
    key: "profile",
    title: "Profile-share rollup",
    description: "profile_share_events",
    rawTableName: "profile_share_events",
    aggregateTableName: "profile_share_daily_aggregates",
    endpoint: "/api/super-admin/profile-share-rollup/summary",
    testIdSuffix: "profile-share",
    cooldownEnvVar: "OPS_PROFILE_SHARE_ROLLUP_STALE_COOLDOWN_HOURS",
    pageHistoryEndpoint: "/api/super-admin/profile-share-rollup/page-history",
  },
];

function formatRelative(iso: string, nowMs: number): string {
  const diffMs = nowMs - new Date(iso).getTime();
  if (!Number.isFinite(diffMs) || diffMs < 0) return "just now";
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 48) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

function formatHours(ms: number): string {
  return `${Math.round(ms / (60 * 60 * 1000))}h`;
}

function formatDays(ms: number): string {
  return `${Math.round(ms / (24 * 60 * 60 * 1000))}d`;
}

/**
 * Render a byte count in the largest unit that keeps the value readable
 * (B / KB / MB / GB). Matches how the panel labels storage savings.
 */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIdx = 0;
  while (value >= 1024 && unitIdx < units.length - 1) {
    value /= 1024;
    unitIdx += 1;
  }
  const decimals = value >= 100 || unitIdx === 0 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(decimals)} ${units[unitIdx]}`;
}

// Task #1821 — 7-day savings sparkline. Pulls per-run history out of
// `BadgeShareRollupAdminSummary.history` and plots `savingsPercent`
// over time. Falls back to an explanatory empty state until the rollup
// has accumulated >= 2 non-null data points (a single point isn't a
// trend; an all-null history would just be a flat zero line).
interface SavingsSparklineProps {
  variant: ShareRollupVariant;
  history: ShareRollupHistoryPoint[] | undefined;
  historyDays: number | undefined;
}

interface SparklineDatum {
  ranAt: string;
  ts: number;
  savingsPercent: number | null;
  savingsRatio: number | null;
}

function SparklineTooltip(props: {
  active?: boolean;
  // recharts v3 hands content callbacks a ReadonlyArray of payload entries
  // whose `payload` field is `any` — accept the structural shape we need
  // (each entry carries the original SparklineDatum row in `payload`) so
  // we can read it without casting at the call site.
  payload?: ReadonlyArray<{ payload?: SparklineDatum }>;
  testIdSuffix: string;
}) {
  if (!props.active || !props.payload || props.payload.length === 0) return null;
  const point = props.payload[0].payload;
  if (!point) return null;
  const date = new Date(point.ranAt);
  return (
    <div
      className="rounded-md border border-border bg-popover px-2.5 py-1.5 text-[11px] shadow-md"
      data-testid={`tooltip-savings-sparkline-${props.testIdSuffix}`}
    >
      <p className="font-semibold text-white">
        {date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}
        <span className="text-muted-foreground font-normal ml-1.5">
          {date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
        </span>
      </p>
      {point.savingsPercent !== null ? (
        <p className="text-emerald-400">
          {/* Stored precision is numeric(6,3) / numeric(12,3) — surface
              all 3 decimals in the tooltip so admins see the exact
              recorded value rather than a display-rounded approximation. */}
          {point.savingsPercent.toFixed(3)}% smaller
          {point.savingsRatio !== null && (
            <span className="text-muted-foreground ml-1.5">
              ({point.savingsRatio.toFixed(3)}× larger raw)
            </span>
          )}
        </p>
      ) : (
        <p className="text-muted-foreground">No savings recorded</p>
      )}
    </div>
  );
}

function SavingsSparkline({ variant, history, historyDays }: SavingsSparklineProps) {
  // The profile-share endpoint doesn't (yet) return per-run history,
  // so the sparkline simply doesn't render for that variant.
  if (!history) return null;

  const data: SparklineDatum[] = history.map((p) => ({
    ranAt: p.ranAt,
    ts: new Date(p.ranAt).getTime(),
    savingsPercent: p.savingsPercent,
    savingsRatio: p.savingsRatio,
  }));

  const usableCount = data.filter((d) => d.savingsPercent !== null).length;

  if (usableCount < 2) {
    return (
      <p
        className="text-[11px] text-muted-foreground italic pt-1"
        data-testid={`text-sparkline-empty-${variant.testIdSuffix}`}
      >
        Trend chart will appear once the rollup has at least two days of
        history. Currently captured: {usableCount} run{usableCount === 1 ? "" : "s"}.
      </p>
    );
  }

  // Compute a tight Y-axis domain so small movement near 100 % is
  // legible — Recharts' default would clamp to [0, 100] and flatten
  // the line at the top.
  const values = data
    .map((d) => d.savingsPercent)
    .filter((v): v is number => v !== null);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const pad = Math.max(0.1, (max - min) * 0.2);
  const yMin = Math.max(0, Math.floor((min - pad) * 10) / 10);
  const yMax = Math.min(100, Math.ceil((max + pad) * 10) / 10);

  return (
    <div
      className="space-y-1 pt-2"
      data-testid={`panel-savings-sparkline-${variant.testIdSuffix}`}
    >
      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
        <span data-testid={`label-sparkline-${variant.testIdSuffix}`}>
          Trend over last {historyDays ?? 7} day{(historyDays ?? 7) === 1 ? "" : "s"}{" "}
          ({usableCount} run{usableCount === 1 ? "" : "s"})
        </span>
        <span>Smaller-than-raw %</span>
      </div>
      <div className="h-16 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
            <XAxis dataKey="ts" hide type="number" domain={["dataMin", "dataMax"]} />
            <YAxis hide domain={[yMin, yMax]} />
            <RechartsTooltip
              cursor={{ stroke: "rgba(255,255,255,0.1)", strokeWidth: 1 }}
              content={(p) => (
                <SparklineTooltip
                  active={p.active}
                  payload={p.payload}
                  testIdSuffix={variant.testIdSuffix}
                />
              )}
            />
            <Line
              type="monotone"
              dataKey="savingsPercent"
              stroke="#34d399"
              strokeWidth={1.75}
              dot={{ r: 2.5, fill: "#34d399", strokeWidth: 0 }}
              activeDot={{ r: 4, fill: "#34d399", strokeWidth: 0 }}
              isAnimationActive={false}
              connectNulls
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

/**
 * Task #1814 — Compact "last ops alert" line rendered between the
 * stale-cron banner and the storage-savings panel.
 *
 *   - "Last ops alert: 2h ago — won't re-page for another 4h"  (paged)
 *   - "Never paged on-call about a stale rollup."              (clean)
 *
 * The cooldown explainer is appended directly so a sustained outage
 * doesn't leave admins wondering why no follow-up email arrived after
 * the first one. Tooltip provides the longer "why" without cluttering
 * the line.
 */
interface RecentOpsAlertLineProps {
  lastOpsAlertAt: string | null;
  cooldownMs: number;
  nowMs: number;
  testIdSuffix: string;
  // Task #2261 — variant-specific override env var name shown in the
  // tooltip so profile-share admins aren't told to twiddle the
  // badge-share env var.
  cooldownEnvVar: string;
}

function RecentOpsAlertLine({
  lastOpsAlertAt,
  cooldownMs,
  nowMs,
  testIdSuffix,
  cooldownEnvVar,
}: RecentOpsAlertLineProps) {
  const lastAlertedMs = lastOpsAlertAt
    ? new Date(lastOpsAlertAt).getTime()
    : null;
  const sinceLastMs = lastAlertedMs != null ? nowMs - lastAlertedMs : null;
  const inCooldown =
    sinceLastMs != null && cooldownMs > 0 && sinceLastMs < cooldownMs;
  const remainingCooldownMs =
    inCooldown && sinceLastMs != null ? cooldownMs - sinceLastMs : 0;

  return (
    <div
      className="flex items-start gap-2 text-xs text-muted-foreground bg-muted/20 border border-border/60 rounded-lg px-3 py-2"
      data-testid={`row-last-ops-alert-${testIdSuffix}`}
    >
      <BellRing className="w-3.5 h-3.5 mt-0.5 shrink-0 text-muted-foreground" />
      <div className="flex-1">
        {lastOpsAlertAt ? (
          <p data-testid={`text-last-ops-alert-at-${testIdSuffix}`}>
            <span className="text-white">Last ops alert:</span>{" "}
            <span
              className="text-white font-medium"
              data-testid={`text-last-ops-alert-relative-${testIdSuffix}`}
            >
              {formatRelative(lastOpsAlertAt, nowMs)}
            </span>
            {" "}
            <span className="text-muted-foreground">
              ({new Date(lastOpsAlertAt).toLocaleString()})
            </span>
            {cooldownMs > 0 && (
              <>
                {" — "}
                {inCooldown ? (
                  <span data-testid={`text-ops-alert-cooldown-remaining-${testIdSuffix}`}>
                    won&rsquo;t re-page for another{" "}
                    {formatHours(remainingCooldownMs)}
                    {" "}
                    <TooltipProvider delayDuration={150}>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            className="inline-flex align-middle text-muted-foreground hover:text-white transition-colors"
                            aria-label="Why isn't on-call being re-paged?"
                            data-testid={`button-ops-alert-cooldown-help-${testIdSuffix}`}
                          >
                            <HelpCircle className="w-3 h-3" />
                          </button>
                        </TooltipTrigger>
                        <TooltipContent
                          side="top"
                          className="max-w-xs bg-popover text-popover-foreground border border-border"
                          data-testid={`tooltip-ops-alert-cooldown-${testIdSuffix}`}
                        >
                          <p className="font-semibold mb-1">
                            Why no follow-up page?
                          </p>
                          <p className="leading-relaxed">
                            The auto-pager honours a{" "}
                            {formatHours(cooldownMs)} cooldown between
                            repeat pages for the same sustained outage,
                            so on-call only gets one email per window
                            instead of one per hour. Override with the{" "}
                            <code className="text-[10px] bg-muted/40 px-1 py-0.5 rounded">
                              {cooldownEnvVar}
                            </code>{" "}
                            env var.
                          </p>
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  </span>
                ) : (
                  <span data-testid={`text-ops-alert-cooldown-clear-${testIdSuffix}`}>
                    cooldown ({formatHours(cooldownMs)}) cleared — the next
                    stale poll will page on-call again
                  </span>
                )}
              </>
            )}
          </p>
        ) : (
          <p data-testid={`text-last-ops-alert-never-${testIdSuffix}`}>
            <span className="text-white">Last ops alert:</span>{" "}
            <span className="italic">
              never paged on-call about a stale rollup on this database
            </span>
            {cooldownMs > 0 && (
              <>
                {" "}
                <span className="text-muted-foreground/80">
                  (cooldown when paged: {formatHours(cooldownMs)})
                </span>
              </>
            )}
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * Task #2261 — Paginated "Recent ops alerts" feed for the
 * profile-share rollup auto-pager. Each row is one historic page
 * loaded from the `profile_share_rollup_ops_alerts` audit log
 * (Task #1813), most recent first, with simple "Show more" pagination
 * that grows the page size in steps of 10 (capped at 100, the
 * server-side clamp) so a long history doesn't flood the panel.
 *
 * Mirrors the manual-entry-alert page-history pattern (Task #1665):
 * each row shows when the page fired, how stale the rollup was at
 * that moment, how many raw events were waiting, and the recipient
 * count + emails so support can confirm a specific address received
 * the page without rerunning the lookup.
 */
interface RecentOpsAlertsListProps {
  endpoint: string;
  testIdSuffix: string;
  enabled: boolean;
  nowMs: number;
}

interface ProfileShareRollupOpsAlertHistoryRow {
  id: number;
  pagedAt: string;
  lastRunRanAt: string | null;
  rollupAgeMs: number;
  staleThresholdMs: number;
  currentRawEventCount: number;
  currentAggregateRowCount: number;
  cooldownHours: number;
  recipientCount: number;
  recipientEmails: string[];
}

interface RecentOpsAlertsResponse {
  rows: ProfileShareRollupOpsAlertHistoryRow[];
  limit: number;
  offset: number;
}

const RECENT_OPS_ALERTS_PAGE_SIZE = 10;
const RECENT_OPS_ALERTS_MAX_LIMIT = 100;

function RecentOpsAlertsList({
  endpoint,
  testIdSuffix,
  enabled,
  nowMs,
}: RecentOpsAlertsListProps) {
  const [limit, setLimit] = React.useState(RECENT_OPS_ALERTS_PAGE_SIZE);

  const historyQuery = useQuery<RecentOpsAlertsResponse, Error>({
    queryKey: [endpoint, limit],
    queryFn: async () => {
      const r = await fetch(`${endpoint}?limit=${limit}&offset=0`);
      if (!r.ok) {
        const text = await r.text().catch(() => "");
        throw new Error(
          `Failed to load page history (${r.status}${text ? `: ${text.slice(0, 120)}` : ""})`,
        );
      }
      return r.json();
    },
    enabled,
    staleTime: 15000,
    refetchInterval: 60000,
    retry: 1,
  });

  const data = historyQuery.data;
  const rows = data?.rows ?? [];

  return (
    <div
      className="bg-card border border-border rounded-xl p-5 space-y-3"
      data-testid={`panel-recent-ops-alerts-${testIdSuffix}`}
    >
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="text-sm font-semibold text-white flex items-center gap-2">
          <BellRing className="w-4 h-4 text-amber-400" />
          Recent ops alerts
        </h3>
        <p className="text-[11px] text-muted-foreground">
          Historic pages from the stale-rollup auto-pager
        </p>
      </div>

      {historyQuery.isLoading && !data ? (
        <div className="flex items-center justify-center py-6">
          <Loader2 className="w-5 h-5 animate-spin text-primary" />
        </div>
      ) : historyQuery.error && !data ? (
        <div
          className="flex items-start gap-2 text-sm text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg p-3"
          data-testid={`text-recent-ops-alerts-error-${testIdSuffix}`}
        >
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>Couldn’t load recent ops alerts: {historyQuery.error.message}</span>
        </div>
      ) : rows.length === 0 ? (
        <p
          className="text-sm text-muted-foreground italic py-2"
          data-testid={`text-recent-ops-alerts-empty-${testIdSuffix}`}
        >
          No ops alerts have fired for this rollup on this database.
        </p>
      ) : (
        <ul
          className="divide-y divide-border/60"
          data-testid={`list-recent-ops-alerts-${testIdSuffix}`}
        >
          {rows.map((row) => (
            <li
              key={row.id}
              className="py-2.5 first:pt-0 last:pb-0 text-xs"
              data-testid={`row-recent-ops-alert-${testIdSuffix}-${row.id}`}
            >
              <div className="flex items-baseline justify-between gap-3 flex-wrap">
                <p className="text-white">
                  <span
                    className="font-medium"
                    data-testid={`text-recent-ops-alert-relative-${testIdSuffix}-${row.id}`}
                  >
                    {formatRelative(row.pagedAt, nowMs)}
                  </span>{" "}
                  <span className="text-muted-foreground">
                    ({new Date(row.pagedAt).toLocaleString()})
                  </span>
                </p>
                <p
                  className="text-muted-foreground"
                  data-testid={`text-recent-ops-alert-recipients-${testIdSuffix}-${row.id}`}
                >
                  Paged{" "}
                  <span className="text-white font-medium">
                    {row.recipientCount}
                  </span>{" "}
                  recipient{row.recipientCount === 1 ? "" : "s"}
                </p>
              </div>
              <p
                className="text-muted-foreground mt-1"
                data-testid={`text-recent-ops-alert-context-${testIdSuffix}-${row.id}`}
              >
                Rollup was{" "}
                <span className="text-white">
                  {formatHours(row.rollupAgeMs)} stale
                </span>{" "}
                (threshold {formatHours(row.staleThresholdMs)}) with{" "}
                <span className="text-white">
                  {row.currentRawEventCount.toLocaleString()}
                </span>{" "}
                raw event{row.currentRawEventCount === 1 ? "" : "s"} waiting
                {row.lastRunRanAt && (
                  <>
                    {"; last successful run "}
                    {formatRelative(row.lastRunRanAt, new Date(row.pagedAt).getTime())}
                    {" before the page"}
                  </>
                )}
                .
              </p>
              {row.recipientEmails.length > 0 && (
                <p
                  className="text-muted-foreground/80 mt-0.5 break-all"
                  data-testid={`text-recent-ops-alert-emails-${testIdSuffix}-${row.id}`}
                >
                  {row.recipientEmails.join(", ")}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}

      {/*
        Show-more pagination — grows the page size in steps so admins
        can keep scanning further back without us pre-fetching the
        whole audit log. Hidden once we hit the server clamp or the
        latest fetch came back with fewer rows than requested (i.e. we
        already have everything).
      */}
      {data &&
        rows.length > 0 &&
        rows.length === limit &&
        limit < RECENT_OPS_ALERTS_MAX_LIMIT && (
          <div className="flex justify-center pt-1">
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                setLimit((prev) =>
                  Math.min(
                    RECENT_OPS_ALERTS_MAX_LIMIT,
                    prev + RECENT_OPS_ALERTS_PAGE_SIZE,
                  ),
                )
              }
              disabled={historyQuery.isFetching}
              data-testid={`button-recent-ops-alerts-show-more-${testIdSuffix}`}
            >
              {historyQuery.isFetching ? (
                <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
              ) : null}
              Show more
            </Button>
          </div>
        )}
    </div>
  );
}

interface RollupVariantPanelProps {
  variant: ShareRollupVariant;
  enabled: boolean;
  nowMs: number;
}

function RollupVariantPanel({ variant, enabled, nowMs }: RollupVariantPanelProps) {
  const summaryQuery = useQuery<ShareRollupAdminSummary, Error>({
    queryKey: [variant.endpoint],
    queryFn: async () => {
      const r = await fetch(variant.endpoint);
      if (!r.ok) {
        const text = await r.text().catch(() => "");
        throw new Error(`Failed to load summary (${r.status}${text ? `: ${text.slice(0, 120)}` : ""})`);
      }
      return r.json();
    },
    enabled,
    staleTime: 15000,
    refetchInterval: 60000,
    retry: 1,
  });

  const summary = summaryQuery.data;
  const Icon = variant.key === "profile" ? UserSquare2 : Share2;

  // Task #2057 — "Send test page" mutation, gated by the variant. Only
  // the badge-share rollup endpoint exposes `chatTargets` today; the
  // profile-share sibling has no chat auto-pager so the panel below
  // will render nothing for it. The hook is still called
  // unconditionally because of the rules of hooks — the endpoint URL
  // is harmless when never .mutate()'d.
  const sendOpsAlertTestPage = useOpsAlertTestPageMutation({
    endpoint: variant.endpoint.replace(/\/summary$/, "/test-ops-alert-chat"),
    invalidateQueryKeys: [[variant.endpoint]],
    slackEnvVar: "OPS_BADGE_SHARE_ROLLUP_ALERT_SLACK_WEBHOOK",
    pagerDutyEnvVar: "OPS_BADGE_SHARE_ROLLUP_ALERT_PAGERDUTY_ROUTING_KEY",
  });

  return (
    <section
      className="space-y-4"
      data-testid={`section-${variant.testIdSuffix}-rollup`}
    >
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Icon className="w-4 h-4 text-purple-400" />
            <h2 className="text-base font-semibold text-white">{variant.title}</h2>
          </div>
          <p className="text-xs text-muted-foreground">
            Daily job that summarises old{" "}
            <code className="text-xs bg-muted/40 px-1 py-0.5 rounded">{variant.description}</code>{" "}
            into per-day aggregates so the raw-event table stays bounded.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => summaryQuery.refetch()}
          disabled={summaryQuery.isFetching || !enabled}
          data-testid={`button-refresh-${variant.testIdSuffix}`}
        >
          {summaryQuery.isFetching
            ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
            : <RefreshCw className="w-4 h-4 mr-1.5" />}
          Refresh
        </Button>
      </div>

      {summaryQuery.isLoading && !summary ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-6 h-6 animate-spin text-primary" />
        </div>
      ) : summaryQuery.error && !summary ? (
        <div
          className="flex items-start gap-2 text-sm text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg p-3"
          data-testid={`text-summary-error-${variant.testIdSuffix}`}
        >
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>Couldn’t load summary: {summaryQuery.error.message}</span>
        </div>
      ) : summary ? (
        <>
          {summary.isStale && (
            <div
              className="flex items-start gap-2 text-sm text-amber-300 bg-amber-500/10 border border-amber-500/40 rounded-lg p-3"
              data-testid={`banner-stale-run-${variant.testIdSuffix}`}
            >
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
              <div>
                <p className="font-semibold">
                  {summary.lastRun
                    ? `Last successful run was ${formatRelative(summary.lastRun.ranAt, nowMs)} — older than the ${formatHours(summary.staleThresholdMs)} threshold.`
                    : `The ${variant.title.toLowerCase()} has never recorded a successful run on this database.`}
                </p>
                <p className="text-amber-300/80 mt-1">
                  The cron may have stopped firing. Check the API server is running
                  and that the daily interval timer hasn’t crashed.
                </p>
              </div>
            </div>
          )}

          {/*
            Task #1814 — Recent ops alert disclosure. The auto-pager
            (Task #1478) emails super-admins + on-call when the rollup
            goes stale; surfacing "last alert: 2h ago" here lets admins
            confirm the alert pipeline is working and correlate the
            stale-cron banner above with the email they (should have)
            received, without grepping inboxes or logs. The cooldown
            window is shown alongside so admins also understand why a
            sustained outage isn't re-paging them every hour.

            Only rendered when the endpoint actually populates the
            field (badge-share rollup today; the profile-share sibling
            doesn't have an auto-pager yet).
          */}
          {summary.lastOpsAlertAt !== undefined && (
            <RecentOpsAlertLine
              lastOpsAlertAt={summary.lastOpsAlertAt}
              cooldownMs={summary.opsAlertCooldownMs ?? 0}
              nowMs={nowMs}
              testIdSuffix={variant.testIdSuffix}
              cooldownEnvVar={variant.cooldownEnvVar}
            />
          )}

          {/*
            Task #2261 — Paginated "Recent ops alerts" feed for the
            profile-share rollup auto-pager. The summary line above
            answers "was anyone paged about this outage?"; this feed
            answers "...and what about the previous outages?" so a
            super-admin can spot a re-flapping pattern (cron failing
            every other day after a deploy regression, etc.) without
            tailing logs. Only renders for variants that expose a
            page-history endpoint (profile-share today; the badge-share
            sibling still uses the singleton-cooldown table).
          */}
          {variant.pageHistoryEndpoint && (
            <RecentOpsAlertsList
              endpoint={variant.pageHistoryEndpoint}
              testIdSuffix={variant.testIdSuffix}
              enabled={enabled}
              nowMs={nowMs}
            />
          )}

          {/*
            Task #2057 — Slack/PagerDuty wiring badges + a "Send test
            page" button for the badge-share rollup auto-pager. Renders
            nothing for the profile-share variant (no `chatTargets`
            field on that endpoint) so the same `RollupVariantPanel`
            stays usable for both. Test-id prefix is per-variant so the
            two panels never collide.
          */}
          <OpsAlertWiringPanel
            chatTargets={summary.chatTargets}
            label="Stale-rollup alert"
            slackEnvVar="OPS_BADGE_SHARE_ROLLUP_ALERT_SLACK_WEBHOOK"
            pagerDutyEnvVar="OPS_BADGE_SHARE_ROLLUP_ALERT_PAGERDUTY_ROUTING_KEY"
            isSending={sendOpsAlertTestPage.isPending}
            onSendTestPage={() => sendOpsAlertTestPage.mutate()}
            testIdPrefix={`${variant.testIdSuffix}-ops-alert`}
          />

          <div
            className="bg-card border border-border rounded-xl p-5 space-y-3"
            data-testid={`panel-storage-savings-${variant.testIdSuffix}`}
          >
            <h3 className="text-sm font-semibold text-white flex items-center gap-2">
              <HardDrive className="w-4 h-4 text-emerald-400" />Estimated storage savings
            </h3>
            <p className="text-xs text-muted-foreground">
              How much the rollup has shrunk the raw-event table over its lifetime.
              Numbers are estimates: per-row sizes are derived from the live table’s
              footprint (heap + indexes + TOAST) divided by current row count.
            </p>

            {/*
              Task #1479 — Compression KPIs derived from row counts. Surfaces
              the savings as a percentage and "N× larger without rollup"
              ratio so admins can see the impact at a glance, with a tooltip
              explaining the math.
            */}
            {summary.storageSavings.savingsPercent !== null &&
            summary.storageSavings.savingsRatio !== null ? (
              <div
                className="flex items-start justify-between gap-3 rounded-lg bg-emerald-500/5 border border-emerald-500/20 p-3"
                data-testid={`panel-savings-compression-${variant.testIdSuffix}`}
              >
                <div className="flex items-start gap-3 flex-wrap">
                  <div data-testid={`stat-storage-savings-percent-${variant.testIdSuffix}`}>
                    <p className="text-[11px] uppercase tracking-wide text-muted-foreground flex items-center gap-1">
                      <TrendingDown className="w-3 h-3" />Smaller than raw
                    </p>
                    <p className="text-2xl font-bold text-emerald-400">
                      {summary.storageSavings.savingsPercent.toFixed(
                        summary.storageSavings.savingsPercent >= 99.95 ? 2 : 1,
                      )}%
                    </p>
                  </div>
                  <div
                    className="border-l border-border pl-3"
                    data-testid={`stat-storage-savings-ratio-${variant.testIdSuffix}`}
                  >
                    <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                      Without rollup
                    </p>
                    <p className="text-2xl font-bold text-white">
                      {summary.storageSavings.savingsRatio.toFixed(
                        summary.storageSavings.savingsRatio >= 100 ? 0 : 1,
                      )}× larger
                    </p>
                    <p
                      className="text-[11px] text-muted-foreground"
                      data-testid={`text-savings-breakdown-${variant.testIdSuffix}`}
                    >
                      {(
                        summary.currentRawEventCount + summary.storageSavings.aggregatedEventCount
                      ).toLocaleString()}{" "}
                      raw vs{" "}
                      {(
                        summary.currentRawEventCount + summary.currentAggregateRowCount
                      ).toLocaleString()}{" "}
                      stored rows
                    </p>
                  </div>
                </div>
                <TooltipProvider delayDuration={150}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        className="text-muted-foreground hover:text-white transition-colors"
                        aria-label="How is the savings percentage calculated?"
                        data-testid={`button-savings-help-${variant.testIdSuffix}`}
                      >
                        <HelpCircle className="w-4 h-4" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent
                      side="left"
                      className="max-w-xs bg-popover text-popover-foreground border border-border"
                      data-testid={`tooltip-savings-explanation-${variant.testIdSuffix}`}
                    >
                      <p className="font-semibold mb-1">How this is calculated</p>
                      <p className="leading-relaxed">
                        Each aggregate row stores a <code>count</code> of how many
                        raw events it represents. Summing those counts gives the
                        raw-event volume the rollup has folded down. The percentage
                        compares stored rows (raw + aggregates) against what we’d be
                        storing without the rollup (raw + folded events).
                      </p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>
            ) : (
              <p
                className="text-xs text-muted-foreground italic"
                data-testid={`text-savings-empty-${variant.testIdSuffix}`}
              >
                No savings to report yet — the rollup hasn’t collapsed any events
                on this database.
              </p>
            )}

            {/*
              Task #1821 — 7-day savings sparkline. The lifetime KPI above
              is a single point-in-time number; this chart catches slow
              regressions (e.g. raw events growing faster than the rollup
              can fold) by trending the savings percent over the last
              week. Hovering a point shows the run's date plus the exact
              percent / ratio at that run.

              Only renders when the API returned at least two data points
              with a non-null `savingsPercent` — a single point isn't a
              trend, and an all-null history (cron has run but never
              collapsed anything) would just be a flat bottom line.
            */}
            <SavingsSparkline
              variant={variant}
              history={summary.history}
              historyDays={summary.historyDays}
            />

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-1">
              <div data-testid={`stat-rows-saved-${variant.testIdSuffix}`}>
                <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                  Est. rows saved
                </p>
                <p className="text-2xl font-bold text-emerald-400">
                  {summary.storageSavings.estimatedRowsSaved.toLocaleString()}
                </p>
                <p className="text-[11px] text-muted-foreground">
                  raw rows folded into{" "}
                  {summary.currentAggregateRowCount.toLocaleString()} aggregates
                </p>
              </div>
              <div data-testid={`stat-bytes-saved-${variant.testIdSuffix}`}>
                <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                  Est. bytes saved
                </p>
                <p className="text-2xl font-bold text-emerald-400">
                  {formatBytes(summary.storageSavings.estimatedBytesSaved)}
                </p>
                <p className="text-[11px] text-muted-foreground">
                  ≈ {formatBytes(summary.storageSavings.estimatedBytesPerRawRow)} / row
                </p>
              </div>
              <div data-testid={`stat-aggregated-events-${variant.testIdSuffix}`}>
                <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                  Events folded
                </p>
                <p className="text-2xl font-bold text-white">
                  {summary.storageSavings.aggregatedEventCount.toLocaleString()}
                </p>
                <p className="text-[11px] text-muted-foreground">
                  total raw events represented in aggregates
                </p>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div
              className="bg-card border border-border rounded-xl p-5 space-y-3"
              data-testid={`panel-current-row-counts-${variant.testIdSuffix}`}
            >
              <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                <Database className="w-4 h-4 text-primary" />Current table sizes
              </h3>
              <p className="text-xs text-muted-foreground">
                Live row counts. Events older than {formatDays(summary.rollupAgeMs)} are rolled up;
                everything newer stays in the raw table.
              </p>
              <div className="grid grid-cols-2 gap-3 pt-1">
                <div data-testid={`stat-raw-events-${variant.testIdSuffix}`}>
                  <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Raw events</p>
                  <p className="text-2xl font-bold text-white">
                    {summary.currentRawEventCount.toLocaleString()}
                  </p>
                  <p className="text-[11px] text-muted-foreground">{variant.rawTableName}</p>
                </div>
                <div data-testid={`stat-aggregate-rows-${variant.testIdSuffix}`}>
                  <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Aggregate rows</p>
                  <p className="text-2xl font-bold text-white">
                    {summary.currentAggregateRowCount.toLocaleString()}
                  </p>
                  <p className="text-[11px] text-muted-foreground">{variant.aggregateTableName}</p>
                </div>
              </div>
            </div>

            <div
              className="bg-card border border-border rounded-xl p-5 space-y-3"
              data-testid={`panel-last-run-${variant.testIdSuffix}`}
            >
              <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                <Layers className="w-4 h-4 text-primary" />Most recent run
              </h3>
              {summary.lastRun ? (
                <>
                  <p className="text-xs text-muted-foreground" data-testid={`text-last-run-at-${variant.testIdSuffix}`}>
                    Ran <span className="text-white font-medium">{formatRelative(summary.lastRun.ranAt, nowMs)}</span>{" "}
                    ({new Date(summary.lastRun.ranAt).toLocaleString()})
                  </p>
                  <div className="grid grid-cols-3 gap-3 pt-1">
                    <div data-testid={`stat-rolled-up-events-${variant.testIdSuffix}`}>
                      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Rolled up</p>
                      <p className="text-xl font-bold text-white">
                        {summary.lastRun.rolledUpEvents.toLocaleString()}
                      </p>
                      <p className="text-[11px] text-muted-foreground">events deleted</p>
                    </div>
                    <div data-testid={`stat-upserted-aggregate-rows-${variant.testIdSuffix}`}>
                      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Upserted</p>
                      <p className="text-xl font-bold text-white">
                        {summary.lastRun.upsertedAggregateRows.toLocaleString()}
                      </p>
                      <p className="text-[11px] text-muted-foreground">aggregate rows</p>
                    </div>
                    <div data-testid={`stat-pruned-aggregate-rows-${variant.testIdSuffix}`}>
                      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Pruned</p>
                      <p className="text-xl font-bold text-white">
                        {summary.lastRun.prunedAggregateRows.toLocaleString()}
                      </p>
                      <p className="text-[11px] text-muted-foreground">expired aggregates</p>
                    </div>
                  </div>
                </>
              ) : (
                <p className="text-sm text-muted-foreground py-4 text-center" data-testid={`text-no-runs-${variant.testIdSuffix}`}>
                  The rollup has not yet completed on this database. The cron runs once
                  every 24 hours; the first successful run will populate this panel.
                </p>
              )}
            </div>
          </div>

          <p className="text-[11px] text-muted-foreground text-right" data-testid={`text-generated-at-${variant.testIdSuffix}`}>
            Refreshed {new Date(summary.generatedAt).toLocaleTimeString()}
          </p>
        </>
      ) : null}
    </section>
  );
}

export default function SuperAdminShareRollupsPage() {
  const { data: me, isLoading: meLoading } = useGetMe();
  const [, navigate] = useLocation();

  const isSuperAdmin = me?.role === "super_admin";
  const nowMs = Date.now();

  if (meLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="w-6 h-6 animate-spin text-primary" />
      </div>
    );
  }

  if (!isSuperAdmin) {
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <div className="bg-card border border-border rounded-xl p-6 text-center">
          <Crown className="w-8 h-8 text-purple-400 mx-auto mb-3" />
          <h1 className="text-lg font-semibold text-white mb-1">Super-admin only</h1>
          <p className="text-sm text-muted-foreground">
            This dashboard is restricted to platform super-admins.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-8" data-testid="page-share-rollups">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Share2 className="w-5 h-5 text-purple-400" />
            <h1 className="text-xl font-bold text-white">Share rollups</h1>
          </div>
          <p className="text-sm text-muted-foreground">
            Storage-savings panels for the daily share-event rollup jobs.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => navigate("/super-admin")} data-testid="button-back-super-admin">
          <ArrowLeft className="w-4 h-4 mr-1.5" />Super Admin
        </Button>
      </div>

      {VARIANTS.map((variant) => (
        <RollupVariantPanel
          key={variant.key}
          variant={variant}
          enabled={isSuperAdmin}
          nowMs={nowMs}
        />
      ))}
    </div>
  );
}
