// Task #1304 — In-app history view for the daily ops-alert
// (notification retry-exhaustion) data the cron in
// `notifyExhaustionOpsAlert.ts` (Task #1130) emails out.
//
// Surfaces the same per-pipeline / per-channel windowed counts so admins
// can scan recent days without grepping email, and click into a day to
// see the affected coach-payout / levy-receipt rows for triage. Admin
// roles only — gated client-side here for UX and re-checked by the API.
import React, { useCallback, useMemo, useState } from "react";
import { Link } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  RefreshCw, AlertCircle, Bell, Smartphone, ChevronDown, ChevronRight,
  AlertTriangle, ArrowUpRight, Mail, Send, Eraser,
} from "lucide-react";
import { Button } from "@/components/ui/button";

interface ExhaustionCounts {
  push: number;
  sms: number;
  rows: number;
}

interface ExhaustionDailyBucket {
  date: string;
  coachPayout: ExhaustionCounts;
  levyReceipt: ExhaustionCounts;
  totalRows: number;
  alerted: boolean;
}

interface RecipientsInfo {
  emails: string[];
  /**
   * Where the recipient list comes from. `"env"` means the list was
   * parsed from `OPS_ALERT_EMAILS`; `"org_override"` means a super
   * admin set a DB-backed override via the super-admin UI (Task #1910).
   * The override is the floor — saving an empty list resolves back to
   * env, so this can flip env→org_override→env over time.
   */
  source: "env" | "org_override";
  /** Name of the env var the list was parsed from, when source is env. */
  envVar?: string;
  /**
   * Task #1910 — when `source === "org_override"`, this is what the
   * recipient list would fall back to if the override were cleared
   * (i.e. the parsed `OPS_ALERT_EMAILS` value). Surfaced so admins can
   * see at a glance what "Reset to inherit" would restore.
   */
  envFallbackEmails?: string[];
}

interface HistoryResponse {
  days: number;
  buckets: ExhaustionDailyBucket[];
  recipients?: RecipientsInfo;
}

interface ExhaustionRow {
  id: number;
  organizationId: number;
  exhaustedAt: string;
  date: string;
  payoutId?: number;
  proId?: number;
  reference?: string | null;
  chargeId?: number;
  clubMemberId?: number;
  levyName?: string | null;
}

interface RowsResponse {
  pipeline: "coach_payout" | "levy_receipt";
  channel: "push" | "sms";
  date: string;
  rows: ExhaustionRow[];
}

interface MeResponse { role?: string }

const ADMIN_ROLES = new Set(["org_admin", "tournament_director", "super_admin"]);

type Pipeline = "coach_payout" | "levy_receipt";
type Channel = "push" | "sms";

interface DrillKey { date: string; pipeline: Pipeline; channel: Channel }

function drillKeyId(k: DrillKey): string {
  return `${k.date}|${k.pipeline}|${k.channel}`;
}

function formatDateLabel(date: string): string {
  // `date` is YYYY-MM-DD (UTC). Render as short locale date for human
  // scanning, but keep the ISO string visible so admins can correlate
  // with the email subject lines that include UTC dates.
  const d = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return date;
  return d.toLocaleDateString(undefined, {
    weekday: "short", year: "numeric", month: "short", day: "numeric",
  });
}

function ChannelCell({
  count, channel, dimmed,
}: { count: number; channel: Channel; dimmed: boolean }) {
  const Icon = channel === "push" ? Bell : Smartphone;
  return (
    <span
      className={`inline-flex items-center gap-1 font-mono text-xs ${
        dimmed ? "text-muted-foreground" : count > 0 ? "text-amber-300" : "text-white/70"
      }`}
      data-testid={`cell-${channel}`}
    >
      <Icon className="w-3.5 h-3.5" aria-hidden /> {count}
    </span>
  );
}

interface ExhaustionActionResponse {
  pipeline: Pipeline;
  channel: Channel;
  attemptId: number;
  action: "retry" | "clear";
  noopReason?: string | null;
  retryResult?: {
    channel: Channel;
    status: string;
    attempts: number;
    exhausted: boolean;
    error?: string;
  } | null;
}

interface ExhaustionActionVars {
  attemptId: number;
  action: "retry" | "clear";
}

function DrillDownPanel({ drill }: { drill: DrillKey }) {
  const params = new URLSearchParams({
    pipeline: drill.pipeline, channel: drill.channel, date: drill.date,
  });
  const queryClient = useQueryClient();
  const rowsKey = ["notify-exhaustion-rows", drill.pipeline, drill.channel, drill.date] as const;
  const { data, isLoading, isError, error } = useQuery<RowsResponse>({
    queryKey: rowsKey,
    queryFn: async () => {
      const res = await fetch(`/api/admin/notify-exhaustion-rows?${params.toString()}`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error(`Request failed (HTTP ${res.status})`);
      return res.json() as Promise<RowsResponse>;
    },
  });

  // One mutation per drill panel; we track the active row + action so
  // the inline status copy beside the row stays in lock-step with the
  // most recent click. After a successful action we invalidate both
  // the day-level history and this panel's rows so the cell counts
  // and the affected-row table refresh from the server (this is what
  // makes "Clear" make the row disappear from the list).
  const [feedback, setFeedback] = useState<{
    rowId: number; action: "retry" | "clear"; kind: "ok" | "error"; text: string;
  } | null>(null);

  const mutation = useMutation<ExhaustionActionResponse, Error, ExhaustionActionVars>({
    mutationFn: async (vars) => {
      const res = await fetch("/api/admin/notify-exhaustion-action", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pipeline: drill.pipeline,
          channel: drill.channel,
          attemptId: vars.attemptId,
          action: vars.action,
        }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(detail || `Request failed (HTTP ${res.status})`);
      }
      return res.json() as Promise<ExhaustionActionResponse>;
    },
    onSuccess: async (resp, vars) => {
      // Build a short user-facing summary. For retry we include the
      // dispatch outcome so the admin can tell whether the channel
      // actually went out (e.g. "sent") vs short-circuited because the
      // recipient has no token / phone any more (e.g. "no_address").
      let text: string;
      if (vars.action === "clear") {
        text = "Exhaustion stamp cleared.";
      } else if (resp.retryResult) {
        text = `Retry queued — ${resp.retryResult.status}`
          + (resp.retryResult.exhausted ? " (exhausted again)" : "");
      } else {
        text = "Reset, but the channel helper declined to dispatch.";
      }
      setFeedback({ rowId: vars.attemptId, action: vars.action, kind: "ok", text });
      // Refresh both the day-level totals and this drill-down so the
      // row disappears from the list (clear) or its status updates
      // (retry).
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: rowsKey }),
        queryClient.invalidateQueries({ queryKey: ["notify-exhaustion-history"] }),
      ]);
    },
    onError: (err, vars) => {
      setFeedback({
        rowId: vars.attemptId,
        action: vars.action,
        kind: "error",
        text: err.message || "Action failed",
      });
    },
  });

  if (isLoading) {
    return (
      <div className="px-4 py-3 text-xs text-muted-foreground" data-testid="drilldown-loading">
        Loading rows…
      </div>
    );
  }
  if (isError) {
    return (
      <div className="px-4 py-3 text-xs text-red-300" data-testid="drilldown-error">
        Couldn't load affected rows: {(error as Error)?.message ?? "unknown error"}
      </div>
    );
  }
  if (!data || data.rows.length === 0) {
    return (
      <div className="px-4 py-3 text-xs text-muted-foreground italic" data-testid="drilldown-empty">
        No affected rows in this window.
      </div>
    );
  }

  return (
    <div
      className="px-4 py-3 border-t border-white/5"
      data-testid={`drilldown-${drill.pipeline}-${drill.channel}-${drill.date}`}
    >
      <div className="text-xs text-muted-foreground mb-2">
        {data.rows.length} affected{" "}
        {drill.pipeline === "coach_payout" ? "coach payout" : "levy receipt"}{" "}
        row{data.rows.length === 1 ? "" : "s"} ({drill.channel.toUpperCase()})
      </div>
      <div className="overflow-x-auto rounded-md border border-white/10">
        <table className="w-full text-[11px]">
          <thead className="bg-white/[0.03] text-muted-foreground">
            <tr>
              <th className="text-left font-medium px-2 py-1.5">Exhausted at</th>
              <th className="text-left font-medium px-2 py-1.5">
                {drill.pipeline === "coach_payout" ? "Payout / Pro" : "Charge / Member"}
              </th>
              <th className="text-left font-medium px-2 py-1.5">Reference</th>
              <th className="text-left font-medium px-2 py-1.5">Triage</th>
              <th className="text-left font-medium px-2 py-1.5">Actions</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map(row => {
              const triageHref = drill.pipeline === "coach_payout" && row.proId != null
                ? `/coach-admin?coach=${row.proId}#payout-history`
                : drill.pipeline === "levy_receipt" && row.clubMemberId != null
                  ? `/member-360/${row.clubMemberId}`
                  : null;
              const isPending = mutation.isPending && mutation.variables?.attemptId === row.id;
              const rowFeedback = feedback?.rowId === row.id ? feedback : null;
              return (
                <tr
                  key={`${drill.pipeline}-${row.id}`}
                  className="border-t border-white/5"
                  data-testid={`drilldown-row-${drill.pipeline}-${row.id}`}
                >
                  <td className="px-2 py-1.5 text-white/80 whitespace-nowrap">
                    {new Date(row.exhaustedAt).toLocaleString()}
                  </td>
                  <td className="px-2 py-1.5 font-mono text-white/80 whitespace-nowrap">
                    {drill.pipeline === "coach_payout"
                      ? `payout #${row.payoutId ?? "?"} · pro #${row.proId ?? "?"}`
                      : `charge #${row.chargeId ?? "?"} · member #${row.clubMemberId ?? "?"}`}
                  </td>
                  <td className="px-2 py-1.5 text-muted-foreground">
                    {drill.pipeline === "coach_payout"
                      ? (row.reference ?? "—")
                      : (row.levyName ?? "—")}
                  </td>
                  <td className="px-2 py-1.5">
                    {triageHref ? (
                      <Link
                        href={triageHref}
                        className="inline-flex items-center gap-1 text-sky-300 hover:text-sky-200"
                        data-testid={`triage-link-${drill.pipeline}-${row.id}`}
                      >
                        Triage <ArrowUpRight className="w-3 h-3" />
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="px-2 py-1.5">
                    <div className="flex flex-col gap-1">
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          disabled={isPending}
                          onClick={() => {
                            setFeedback(null);
                            mutation.mutate({ attemptId: row.id, action: "retry" });
                          }}
                          className="inline-flex items-center gap-1 rounded border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 text-emerald-200 hover:bg-emerald-500/20 disabled:opacity-50 disabled:cursor-not-allowed"
                          data-testid={`btn-retry-${drill.pipeline}-${row.id}`}
                          title={`Retry ${drill.channel.toUpperCase()} channel for this row`}
                        >
                          <Send className="w-3 h-3" /> Retry
                        </button>
                        <button
                          type="button"
                          disabled={isPending}
                          onClick={() => {
                            setFeedback(null);
                            mutation.mutate({ attemptId: row.id, action: "clear" });
                          }}
                          className="inline-flex items-center gap-1 rounded border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-amber-200 hover:bg-amber-500/20 disabled:opacity-50 disabled:cursor-not-allowed"
                          data-testid={`btn-clear-${drill.pipeline}-${row.id}`}
                          title={`Clear the ${drill.channel.toUpperCase()} exhaustion stamp without re-sending`}
                        >
                          <Eraser className="w-3 h-3" /> Clear
                        </button>
                      </div>
                      {isPending && (
                        <span
                          className="text-[10px] text-muted-foreground"
                          data-testid={`action-pending-${drill.pipeline}-${row.id}`}
                        >
                          Working…
                        </span>
                      )}
                      {rowFeedback && !isPending && (
                        <span
                          className={`text-[10px] ${rowFeedback.kind === "ok" ? "text-emerald-300" : "text-red-300"}`}
                          data-testid={`action-feedback-${drill.pipeline}-${row.id}`}
                        >
                          {rowFeedback.text}
                        </span>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function NotifyExhaustionHistoryPage() {
  // Mirrors notification-audit.tsx: gate on /api/auth/me so non-admins see
  // a friendly message instead of a permanent 403 banner. The server still
  // enforces the role boundary.
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

  const [days, setDays] = useState<number>(30);
  const [drills, setDrills] = useState<Set<string>>(new Set());

  const isAdmin = !!me && ADMIN_ROLES.has(me.role ?? "");

  const { data, isLoading, isError, error, refetch, isFetching } = useQuery<HistoryResponse>({
    queryKey: ["notify-exhaustion-history", days],
    queryFn: async () => {
      const res = await fetch(`/api/admin/notify-exhaustion-history?days=${days}`, {
        credentials: "include",
      });
      if (res.status === 401) throw new Error("Sign in required to view ops alert history.");
      if (res.status === 403) throw new Error("Admin role required to view ops alert history.");
      if (!res.ok) throw new Error(`Request failed (HTTP ${res.status})`);
      return res.json() as Promise<HistoryResponse>;
    },
    enabled: isAdmin,
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
  });

  const toggleDrill = useCallback((k: DrillKey) => {
    const id = drillKeyId(k);
    setDrills(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  // Newest day first so a fresh outage is at the top of the table.
  const buckets = useMemo<ExhaustionDailyBucket[]>(
    () => (data?.buckets ?? []).slice().reverse(),
    [data],
  );

  const alertedCount = useMemo(
    () => buckets.filter(b => b.alerted).length,
    [buckets],
  );

  if (meLoading) {
    return (
      <div className="p-6" data-testid="notify-exhaustion-history-page">
        <div className="text-sm text-muted-foreground">Loading…</div>
      </div>
    );
  }

  if (!isAdmin) {
    let title = "Ops alert history";
    let body =
      "You need an organization, tournament-director, or super-admin role to view this page.";
    let testId = "notify-exhaustion-no-access";
    if (meStatus === "error") {
      title = "Couldn't verify your access";
      body = "We couldn't reach the authentication service to check your role. Please refresh in a moment.";
      testId = "notify-exhaustion-auth-error";
    } else if (!me) {
      title = "Sign in required";
      body = "You need to sign in to view ops alert history.";
      testId = "notify-exhaustion-signin-required";
    }
    return (
      <div className="p-6" data-testid="notify-exhaustion-history-page">
        <div
          className="rounded-lg border border-border bg-card p-6 max-w-xl"
          data-testid={testId}
        >
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

  return (
    <div className="p-6 space-y-6" data-testid="notify-exhaustion-history-page">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Notification ops alert history</h1>
          <p className="text-sm text-muted-foreground mt-1 max-w-3xl">
            Daily totals of coach-payout and levy-receipt notifications whose push or SMS retries were exhausted.
            Days flagged <span className="text-amber-300">alerted</span> match the rolling-window count the daily
            ops-alert email uses, so you can see at a glance whether a fix has driven the count back below the
            alert threshold.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={days}
            onChange={(e) => setDays(parseInt(e.target.value, 10))}
            className="bg-background border border-border rounded-md text-sm px-2 py-1.5"
            data-testid="select-days"
          >
            <option value={7}>Last 7 days</option>
            <option value={14}>Last 14 days</option>
            <option value={30}>Last 30 days</option>
            <option value={60}>Last 60 days</option>
            <option value={90}>Last 90 days</option>
          </select>
          <Button
            variant="outline"
            size="sm"
            onClick={() => refetch()}
            disabled={isFetching}
            data-testid="button-refresh-history"
          >
            <RefreshCw className={`w-4 h-4 mr-2 ${isFetching ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>
      </div>

      {isLoading && (
        <div className="text-sm text-muted-foreground" data-testid="history-loading">Loading history…</div>
      )}
      {isError && (
        <div
          className="rounded-lg border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-300"
          data-testid="history-error"
        >
          {(error as Error)?.message ?? "Failed to load history."}
        </div>
      )}

      {data && (
        <>
          {/*
            Task #1541 — show the configured ops-alert recipients
            inline on the history page so admins viewing a flagged day
            can immediately see who would have received the email,
            without bouncing to the env-var config or grepping deploy
            logs. Source today is the OPS_ALERT_EMAILS env var; when a
            future per-org override ships the same line will surface
            it via `recipients.source === "org_override"`.
          */}
          {data.recipients && (
            <div
              className="rounded-md border border-white/10 bg-white/[0.02] px-3 py-2 text-xs"
              data-testid="ops-alert-recipients"
            >
              <div className="flex items-center gap-2 text-white/80">
                <Mail className="w-3.5 h-3.5 text-muted-foreground" aria-hidden />
                <span className="font-medium">Ops alert recipients:</span>
                {data.recipients.emails.length === 0 ? (
                  <span
                    className="text-amber-300"
                    data-testid="ops-alert-recipients-empty"
                  >
                    none configured — breach emails will be skipped
                  </span>
                ) : (
                  <span
                    className="font-mono text-white/90 break-all"
                    data-testid="ops-alert-recipients-list"
                  >
                    {data.recipients.emails.join(", ")}
                  </span>
                )}
              </div>
              <div
                className="mt-1 text-[11px] text-muted-foreground"
                data-testid="ops-alert-recipients-source"
              >
                {data.recipients.source === "org_override" ? (
                  <>
                    Configured by a super-admin override (Task #1910).
                    {data.recipients.envFallbackEmails !== undefined
                      && data.recipients.envFallbackEmails.length > 0 && (
                      <>
                        {" "}Reset to inherit would restore{" "}
                        <span
                          className="font-mono text-white/80 break-all"
                          data-testid="ops-alert-recipients-env-fallback"
                        >
                          {data.recipients.envFallbackEmails.join(", ")}
                        </span>
                        {" "}from{" "}
                        <code className="text-amber-300/80">
                          {data.recipients.envVar ?? "OPS_ALERT_EMAILS"}
                        </code>.
                      </>
                    )}
                  </>
                ) : (
                  <>Configured via the{" "}
                    <code className="text-amber-300/80">
                      {data.recipients.envVar ?? "OPS_ALERT_EMAILS"}
                    </code>{" "}
                    environment variable.
                  </>
                )}
              </div>
            </div>
          )}

          <div className="text-xs text-muted-foreground" data-testid="history-summary">
            Showing {buckets.length} day{buckets.length === 1 ? "" : "s"};{" "}
            <span className={alertedCount > 0 ? "text-amber-300" : "text-white/70"}>
              {alertedCount}
            </span>{" "}
            day{alertedCount === 1 ? "" : "s"} crossed the alert threshold.
          </div>

          <div className="overflow-x-auto rounded-lg border border-white/10">
            <table className="w-full text-xs">
              <thead className="bg-white/[0.03] text-muted-foreground">
                <tr>
                  <th className="text-left font-medium px-3 py-2">Day (UTC)</th>
                  <th className="text-left font-medium px-3 py-2" colSpan={2}>Coach payout</th>
                  <th className="text-left font-medium px-3 py-2" colSpan={2}>Levy receipt</th>
                  <th className="text-left font-medium px-3 py-2">Total rows</th>
                  <th className="text-left font-medium px-3 py-2">Alerted</th>
                </tr>
              </thead>
              <tbody>
                {buckets.map(bucket => {
                  const cells: Array<{ pipeline: Pipeline; channel: Channel; count: number }> = [
                    { pipeline: "coach_payout", channel: "push", count: bucket.coachPayout.push },
                    { pipeline: "coach_payout", channel: "sms", count: bucket.coachPayout.sms },
                    { pipeline: "levy_receipt", channel: "push", count: bucket.levyReceipt.push },
                    { pipeline: "levy_receipt", channel: "sms", count: bucket.levyReceipt.sms },
                  ];
                  return (
                    <React.Fragment key={bucket.date}>
                      <tr
                        className={`border-t border-white/5 ${bucket.alerted ? "bg-amber-500/5" : ""}`}
                        data-testid={`row-day-${bucket.date}`}
                      >
                        <td className="px-3 py-2 whitespace-nowrap">
                          <span className="font-mono text-white/90">{bucket.date}</span>
                          <span className="text-muted-foreground ml-2">{formatDateLabel(bucket.date)}</span>
                        </td>
                        {cells.map(c => {
                          const k: DrillKey = { date: bucket.date, pipeline: c.pipeline, channel: c.channel };
                          const id = drillKeyId(k);
                          const open = drills.has(id);
                          return (
                            <td key={`${c.pipeline}-${c.channel}`} className="px-3 py-2">
                              <button
                                type="button"
                                disabled={c.count === 0}
                                onClick={() => toggleDrill(k)}
                                className={`inline-flex items-center gap-1 ${
                                  c.count > 0 ? "hover:underline" : "cursor-default"
                                }`}
                                data-testid={`btn-drill-${c.pipeline}-${c.channel}-${bucket.date}`}
                              >
                                <ChannelCell
                                  count={c.count}
                                  channel={c.channel}
                                  dimmed={c.count === 0}
                                />
                                {c.count > 0 && (open
                                  ? <ChevronDown className="w-3 h-3 text-muted-foreground" />
                                  : <ChevronRight className="w-3 h-3 text-muted-foreground" />)}
                              </button>
                            </td>
                          );
                        })}
                        <td
                          className="px-3 py-2 font-mono text-white/90"
                          data-testid={`cell-total-${bucket.date}`}
                        >
                          {bucket.totalRows}
                        </td>
                        <td className="px-3 py-2">
                          {bucket.alerted ? (
                            <span
                              className="inline-flex items-center gap-1 text-amber-300"
                              data-testid={`cell-alerted-${bucket.date}`}
                            >
                              <AlertTriangle className="w-3.5 h-3.5" /> alerted
                            </span>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                      </tr>
                      {cells.map(c => {
                        const k: DrillKey = { date: bucket.date, pipeline: c.pipeline, channel: c.channel };
                        const id = drillKeyId(k);
                        if (!drills.has(id) || c.count === 0) return null;
                        return (
                          <tr key={`${id}-drill`} className="bg-black/20">
                            <td colSpan={7} className="p-0">
                              <DrillDownPanel drill={k} />
                            </td>
                          </tr>
                        );
                      })}
                    </React.Fragment>
                  );
                })}
                {buckets.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-3 py-4 text-center text-muted-foreground italic">
                      No history rows.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
