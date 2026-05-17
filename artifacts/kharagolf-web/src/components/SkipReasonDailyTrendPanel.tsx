/**
 * Task #2065 — Daily-bucket trend chart for skipped/failed
 * `notifyManualEntryRound` calls. Sits beneath the static
 * `SkipReasonBreakdownPanel` on the super-admin manual-entry alert
 * dashboard so ops can see *whether a reason is trending up* without
 * re-querying the row table or diffing 7d / 30d windows by hand.
 *
 * Renders one stacked area per reason. The legend is interactive —
 * clicking a reason hides/shows it so an operator can isolate one
 * bucket (e.g. "is `org_lookup_failed` the spike I saw in the bar
 * panel?"). The chart's tooltip surfaces the per-day total across
 * the currently visible reasons so isolating a single bucket
 * doesn't lose the overall context.
 *
 * Reuses `humaniseReason` / `REASON_LABELS` from
 * `SkipReasonBreakdownPanel` so a relabel in one place propagates
 * everywhere.
 */
import { useMemo, useState } from "react";
import { LineChart as LineChartIcon } from "lucide-react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from "recharts";
import { humaniseReason } from "./SkipReasonBreakdownPanel";

export interface SkipReasonDailySeriesPoint {
  reason: string;
  isOther: boolean;
  counts: number[];
  total: number;
}

export interface SkipReasonDailySeries {
  sinceDays: number;
  since: string;
  days: string[];
  series: SkipReasonDailySeriesPoint[];
  totalCount: number;
}

// Distinct, accessible colour palette — picked so neighbouring
// stacked areas stay distinguishable on the dark dashboard
// background. The "other" series always gets a muted slate so it
// reads as the catch-all bucket rather than a peer reason.
const REASON_COLOURS = [
  "#60a5fa", // sky-400
  "#f472b6", // pink-400
  "#34d399", // emerald-400
  "#fbbf24", // amber-400
  "#a78bfa", // violet-400
  "#f87171", // red-400
  "#22d3ee", // cyan-400
  "#fb923c", // orange-400
  "#a3e635", // lime-400
  "#facc15", // yellow-400
];
const OTHER_COLOUR = "#94a3b8"; // slate-400

export function colourForReasonIndex(index: number, isOther: boolean): string {
  if (isOther) return OTHER_COLOUR;
  return REASON_COLOURS[index % REASON_COLOURS.length];
}

/**
 * Zip the column-oriented API response into a row-per-day array
 * Recharts can render directly. Empty series (zero across the whole
 * window) are dropped from the chart so the legend stays focused on
 * reasons that actually fired — but we keep the full series list
 * available for the legend's "always-rendered tooltip" use case via
 * the second return value.
 */
export function buildChartRows(
  data: SkipReasonDailySeries,
): { rows: Array<Record<string, number | string>>; activeSeries: SkipReasonDailySeriesPoint[] } {
  // Only chart non-empty series — a flat zero line per canonical
  // reason would drown out the trends we're trying to surface. The
  // bar-breakdown panel already shows "this reason exists with count
  // 0" via its always-rendered bar, so dropping zeros here doesn't
  // hide that affordance from ops.
  const activeSeries = data.series.filter((s) => s.total > 0);
  const rows: Array<Record<string, number | string>> = data.days.map((day, i) => {
    const row: Record<string, number | string> = { day };
    let dayTotal = 0;
    for (const s of activeSeries) {
      const c = s.counts[i] ?? 0;
      row[s.reason] = c;
      dayTotal += c;
    }
    row.__total = dayTotal;
    return row;
  });
  return { rows, activeSeries };
}

/** Compact `MMM d` x-axis label (e.g. "Apr 22"). Keeps the axis
 *  readable across 31 ticks without falling back to numeric dates. */
export function formatDayLabel(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}

interface CustomTooltipPayloadEntry {
  dataKey?: string;
  value?: number;
  color?: string;
  name?: string;
}
interface CustomTooltipProps {
  active?: boolean;
  label?: string;
  payload?: CustomTooltipPayloadEntry[];
}

function ChartTooltip({ active, label, payload }: CustomTooltipProps) {
  if (!active || !payload || payload.length === 0) return null;
  const entries = payload.filter((p) => p.dataKey !== "__total" && Number(p.value ?? 0) > 0);
  const total = entries.reduce((acc, p) => acc + Number(p.value ?? 0), 0);
  return (
    <div
      className="rounded-md border border-border bg-card/95 px-3 py-2 text-xs shadow-lg backdrop-blur"
      data-testid="skip-reason-trend-tooltip"
    >
      <p className="text-white font-medium mb-1">{label ? formatDayLabel(label) : ""}</p>
      {entries.length === 0 ? (
        <p className="text-muted-foreground">No skipped or failed alerts.</p>
      ) : (
        <ul className="space-y-0.5">
          {entries.map((p) => {
            const reason = String(p.dataKey ?? "");
            const { label: human } = humaniseReason(reason);
            return (
              <li key={reason} className="flex items-center gap-2">
                <span
                  className="w-2 h-2 rounded-sm shrink-0"
                  style={{ backgroundColor: p.color ?? "#999" }}
                  aria-hidden
                />
                <span className="text-muted-foreground flex-1">{human}</span>
                <span className="text-white font-mono">{Number(p.value ?? 0).toLocaleString()}</span>
              </li>
            );
          })}
        </ul>
      )}
      <div className="mt-1 pt-1 border-t border-border/50 flex items-center gap-2">
        <span className="text-muted-foreground flex-1">Total</span>
        <span className="text-white font-mono">{total.toLocaleString()}</span>
      </div>
    </div>
  );
}

export function SkipReasonDailyTrendPanel({ data }: { data: SkipReasonDailySeries }) {
  // Track which reasons the operator has hidden via the legend so the
  // chart redraws with that subset stacked. Default = empty (all
  // visible). Hiding every series collapses the chart to "no data"
  // territory; we surface that explicitly rather than rendering an
  // empty plot.
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());

  const { rows, activeSeries } = useMemo(() => buildChartRows(data), [data]);
  const visibleSeries = useMemo(
    () => activeSeries.filter((s) => !hidden.has(s.reason)),
    [activeSeries, hidden],
  );
  const colourFor = useMemo(() => {
    const map = new Map<string, string>();
    let canonicalIdx = 0;
    for (const s of activeSeries) {
      if (s.isOther) {
        map.set(s.reason, OTHER_COLOUR);
      } else {
        map.set(s.reason, REASON_COLOURS[canonicalIdx % REASON_COLOURS.length]);
        canonicalIdx += 1;
      }
    }
    return map;
  }, [activeSeries]);

  const toggleReason = (reason: string) => {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(reason)) next.delete(reason);
      else next.add(reason);
      return next;
    });
  };

  return (
    <div
      className="bg-card border border-border rounded-xl p-5"
      data-testid="panel-skip-reason-trend"
    >
      <h2 className="text-sm font-semibold text-white mb-1 flex items-center gap-2">
        <LineChartIcon className="w-4 h-4 text-primary" />
        Daily skipped/failed trend (last {data.sinceDays} days)
      </h2>
      <p className="text-xs text-muted-foreground mb-4">
        Day-over-day rows in <code className="text-[10px]">manual_entry_notify_skips</code>,
        bucketed by reason. Click a legend entry to hide/show that reason and isolate a spike.
      </p>

      {data.totalCount === 0 || activeSeries.length === 0 ? (
        <p
          className="text-xs text-muted-foreground py-8 text-center"
          data-testid="skip-reason-trend-empty"
        >
          No skipped or failed alerts in the last {data.sinceDays} days.
        </p>
      ) : (
        <>
          <div className="h-64 w-full" data-testid="skip-reason-trend-chart">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={rows} margin={{ top: 8, right: 12, left: -8, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1f2937" vertical={false} />
                <XAxis
                  dataKey="day"
                  tick={{ fill: "#94a3b8", fontSize: 11 }}
                  tickFormatter={formatDayLabel}
                  // Show ~6 evenly-spaced ticks so 31 days don't crash into each other.
                  interval={Math.max(0, Math.floor(rows.length / 6) - 1)}
                  stroke="#334155"
                />
                <YAxis
                  tick={{ fill: "#94a3b8", fontSize: 11 }}
                  allowDecimals={false}
                  width={32}
                  stroke="#334155"
                />
                <RechartsTooltip
                  content={<ChartTooltip />}
                  cursor={{ stroke: "#475569", strokeDasharray: "3 3" }}
                />
                {visibleSeries.map((s) => (
                  <Area
                    key={s.reason}
                    type="monotone"
                    dataKey={s.reason}
                    stackId="reasons"
                    stroke={colourFor.get(s.reason) ?? OTHER_COLOUR}
                    fill={colourFor.get(s.reason) ?? OTHER_COLOUR}
                    fillOpacity={0.55}
                    isAnimationActive={false}
                  />
                ))}
              </AreaChart>
            </ResponsiveContainer>
          </div>

          {/* Custom legend so we can drive its hidden state explicitly
              and add per-reason totals — Recharts' default Legend can
              toggle visibility but doesn't expose totals or test IDs. */}
          <ul
            className="mt-3 flex flex-wrap gap-x-3 gap-y-1.5"
            data-testid="skip-reason-trend-legend"
          >
            {activeSeries.map((s) => {
              const isHidden = hidden.has(s.reason);
              const { label } = humaniseReason(s.reason);
              const colour = colourFor.get(s.reason) ?? OTHER_COLOUR;
              return (
                <li key={s.reason}>
                  <button
                    type="button"
                    onClick={() => toggleReason(s.reason)}
                    className={`inline-flex items-center gap-1.5 text-xs px-1.5 py-0.5 rounded transition-opacity ${
                      isHidden ? "opacity-40 hover:opacity-70" : "opacity-100 hover:opacity-80"
                    }`}
                    aria-pressed={!isHidden}
                    data-testid={`skip-reason-trend-legend-${s.reason}`}
                  >
                    <span
                      className="w-2.5 h-2.5 rounded-sm"
                      style={{ backgroundColor: colour }}
                      aria-hidden
                    />
                    <span className={isHidden ? "line-through text-muted-foreground" : "text-white"}>
                      {label}
                    </span>
                    <span className="text-muted-foreground font-mono">
                      {s.total.toLocaleString()}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>

          {visibleSeries.length === 0 && (
            <p
              className="text-xs text-muted-foreground mt-3 text-center"
              data-testid="skip-reason-trend-all-hidden"
            >
              All reasons hidden — click a legend entry to show one again.
            </p>
          )}
        </>
      )}
    </div>
  );
}
