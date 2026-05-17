/**
 * Task #1657 — "Why did rounds get skipped?" breakdown panel for the
 * super-admin manual-entry alert dashboard
 * (`/super-admin/manual-entry-alerts`).
 *
 * Renders one bar per canonical reason (always present, even at
 * count 0) so the chart never silently buckets a known reason as
 * "Other". A defensive "Other" bucket only surfaces when the backend
 * actually returned an unrecognised reason value.
 *
 * Each bar drills through to the structured-log search system when the
 * server has `MANUAL_ENTRY_NOTIFY_LOG_SEARCH_URL_TEMPLATE` configured
 * (the URL is pre-rendered server-side, so the client doesn't need to
 * know the template).
 *
 * Extracted from `pages/manual-entry-alerts.tsx` so it can be tested in
 * isolation (mirrors the `FlaggedRoundsBanner` split-out pattern).
 */
import { useMemo } from "react";
import { BarChart3, ExternalLink } from "lucide-react";
import { Badge } from "./ui/badge";

export interface SkipReasonBucket {
  reason: string;
  isOther: boolean;
  count: number;
  skippedCount: number;
  failedCount: number;
  logSearchUrl: string | null;
}

export interface SkipReasonBreakdownWindow {
  totalCount: number;
  buckets: SkipReasonBucket[];
}

export interface SkipReasonBreakdown {
  "7d": SkipReasonBreakdownWindow;
  "30d": SkipReasonBreakdownWindow;
}

// Human-friendly bucket labels mirroring `MANUAL_ENTRY_NOTIFY_REASONS`
// in `manualEntryNotify.ts`. Kept in the UI layer (not fetched) so the
// chart still labels every canonical reason even when the backend
// returns count: 0 for it. New reasons ship with a fallback label
// derived from the snake_case key, so a missing entry here is a
// cosmetic regression — never a silent "other" catch-all.
export const REASON_LABELS: Record<string, { label: string; description: string }> = {
  submission_not_found: {
    label: "Submission not found",
    description: "Round submission row missing when the alert tried to fire.",
  },
  no_shots_captured: {
    label: "No shots captured",
    description: "Round had zero shots, so manual % is undefined.",
  },
  below_threshold: {
    label: "Below 50% manual",
    description: "Healthy data quality — round didn't cross the alert threshold.",
  },
  tournament_not_found: {
    label: "Tournament not found",
    description: "Tournament row missing when the alert tried to fire.",
  },
  tournament_muted: {
    label: "Tournament muted",
    description: "Per-tournament manual-entry alert toggle is off.",
  },
  org_lookup_failed: {
    label: "Org lookup failed",
    description: "Couldn't load the org row — alert suppressed fail-closed.",
  },
  org_muted: {
    label: "Org muted",
    description: "Org-wide manual-entry alert toggle is off.",
  },
  no_recipients: {
    label: "No recipients",
    description: "Org has no directors / committee / admins to alert.",
  },
  all_recipients_opted_out: {
    label: "All recipients opted out",
    description: "Every eligible director disabled this alert in their prefs.",
  },
  other: {
    label: "Other",
    description: "Unrecognised reason value (defensive backstop).",
  },
};

export function humaniseReason(reason: string): { label: string; description: string } {
  const known = REASON_LABELS[reason];
  if (known) return known;
  // Fallback: turn `something_unexpected` into "Something unexpected".
  const label = reason.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
  return { label, description: `Reason: ${reason}` };
}

export function SkipReasonBreakdownPanel({ breakdown }: { breakdown: SkipReasonBreakdown }) {
  return (
    <div className="bg-card border border-border rounded-xl p-5" data-testid="panel-skip-reason-breakdown">
      <h2 className="text-sm font-semibold text-white mb-1 flex items-center gap-2">
        <BarChart3 className="w-4 h-4 text-primary" />Why rounds got skipped
      </h2>
      <p className="text-xs text-muted-foreground mb-4">
        Counts of <code className="text-[10px]">notifyManualEntryRound</code> calls that didn't fan out, bucketed
        by reason. Successful sends are tracked separately above.
      </p>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {(["7d", "30d"] as const).map((win) => (
          <SkipReasonWindowChart key={win} label={win} data={breakdown[win]} />
        ))}
      </div>
    </div>
  );
}

export function SkipReasonWindowChart({
  label, data,
}: { label: "7d" | "30d"; data: SkipReasonBreakdownWindow }) {
  // Sort buckets by count desc, but keep zero-count canonical buckets
  // visible at the bottom so ops can still see "yes, no rows in this
  // bucket" instead of guessing whether the reason exists.
  const sorted = useMemo(() => {
    const copy = [...data.buckets];
    copy.sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      // Within ties, "Other" always last; otherwise alphabetical.
      if (a.isOther !== b.isOther) return a.isOther ? 1 : -1;
      return a.reason.localeCompare(b.reason);
    });
    return copy;
  }, [data.buckets]);
  const max = useMemo(
    () => sorted.reduce((m, b) => (b.count > m ? b.count : m), 0),
    [sorted],
  );

  return (
    <div className="rounded-lg border border-border bg-card/40 p-4" data-testid={`skip-reason-window-${label}`}>
      <div className="flex items-baseline justify-between mb-3">
        <h3 className="text-xs font-semibold text-white uppercase tracking-wide">
          Last {label === "7d" ? "7 days" : "30 days"}
        </h3>
        <span
          className="text-xs text-muted-foreground"
          data-testid={`skip-reason-total-${label}`}
        >
          {data.totalCount.toLocaleString()} non-deliver{data.totalCount === 1 ? "y" : "ies"}
        </span>
      </div>
      {data.totalCount === 0 ? (
        <p
          className="text-xs text-muted-foreground py-4 text-center"
          data-testid={`skip-reason-empty-${label}`}
        >
          No skipped or failed alerts in this window — every triggering round delivered.
        </p>
      ) : null}
      <ul className="space-y-2">
        {sorted.map((b) => (
          <SkipReasonBar
            key={`${label}-${b.reason}`}
            window={label}
            bucket={b}
            maxCount={max}
          />
        ))}
      </ul>
    </div>
  );
}

export function SkipReasonBar({
  window: win, bucket, maxCount,
}: { window: "7d" | "30d"; bucket: SkipReasonBucket; maxCount: number }) {
  const { label, description } = humaniseReason(bucket.reason);
  // Width is relative to the largest bucket in the window — a 0-count
  // bucket renders an empty track so ops can see the bucket exists.
  const widthPct = maxCount > 0 ? Math.max(0, (bucket.count / maxCount) * 100) : 0;
  // Empty buckets render in muted grey; populated buckets in primary;
  // failure-heavy buckets (most rows came in via `status='failed'`)
  // render in amber to draw attention without losing the per-reason split.
  const failureHeavy = bucket.failedCount > 0 && bucket.failedCount >= bucket.skippedCount;
  const barColour =
    bucket.count === 0
      ? "bg-muted-foreground/20"
      : failureHeavy
        ? "bg-amber-500/60"
        : "bg-primary/60";
  const labelTextColour = bucket.count === 0 ? "text-muted-foreground" : "text-white";

  const testId = `skip-reason-bar-${win}-${bucket.reason}`;

  const labelNode = (
    <span className="flex items-center gap-1.5 min-w-0">
      <span className={`text-xs font-medium truncate ${labelTextColour}`}>{label}</span>
      {bucket.isOther && (
        <Badge variant="outline" className="text-[9px] py-0 px-1 text-muted-foreground border-border">
          fallback
        </Badge>
      )}
    </span>
  );

  return (
    <li className="space-y-1" title={description} data-testid={testId}>
      <div className="flex items-center justify-between gap-3">
        {bucket.logSearchUrl ? (
          <a
            href={bucket.logSearchUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 hover:text-primary transition-colors min-w-0"
            data-testid={`skip-reason-link-${win}-${bucket.reason}`}
          >
            {labelNode}
            <ExternalLink className="w-3 h-3 text-muted-foreground shrink-0" />
          </a>
        ) : (
          labelNode
        )}
        <span
          className={`text-xs font-mono shrink-0 ${bucket.count === 0 ? "text-muted-foreground" : "text-white"}`}
          data-testid={`skip-reason-count-${win}-${bucket.reason}`}
        >
          {bucket.count.toLocaleString()}
          {bucket.count > 0 && bucket.failedCount > 0 && (
            <span className="text-amber-400/80 text-[10px] ml-1">
              ({bucket.failedCount} failed)
            </span>
          )}
        </span>
      </div>
      <div className="h-1.5 w-full rounded-full bg-muted/40 overflow-hidden">
        <div
          className={`h-full ${barColour} transition-all`}
          style={{ width: `${widthPct}%` }}
          aria-hidden="true"
        />
      </div>
    </li>
  );
}
