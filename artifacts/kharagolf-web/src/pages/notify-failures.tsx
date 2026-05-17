// Task #1854 — In-app dashboard for the daily admin digest of
// exhausted wallet auto-refund / coach payout-account-change notify
// retries (Task #1507).
//
// Lists every wallet-refund and coach-payout-account-change attempt
// row whose email or push retry counter has run out, joined with the
// affected member/coach metadata. A "Resend now" action re-runs the
// channel-specific retry helpers so admins can nudge a stuck delivery
// without waiting for the cron's next tick or for tomorrow's digest.
//
// Admin-gated client-side for UX (the API re-checks the role).
import React, { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  RefreshCw,
  AlertCircle,
  Bell,
  Mail,
  Send,
  Wallet,
  UserCog,
} from "lucide-react";
import { Button } from "@/components/ui/button";

type Pipeline = "wallet_refund" | "coach_payout_account_change";
type Channel = "email" | "push";

interface WalletMeta {
  paymentId: string;
  refundId: string | null;
  currency: string;
  amount: string;
  userId: number;
  memberName: string | null;
  memberEmail: string | null;
}

interface CoachMeta {
  historyId: number;
  proId: number;
  coachUserId: number;
  coachName: string | null;
  coachEmail: string | null;
  changeKind: string;
  method: string;
}

interface NotifyFailureRow {
  pipeline: Pipeline;
  attemptId: number;
  organizationId: number;
  organizationName: string | null;
  channels: Channel[];
  lastError: string | null;
  exhaustedAt: string;
  digestedAt: string | null;
  walletRefund?: WalletMeta;
  coachPayoutAccountChange?: CoachMeta;
}

interface NotifyFailuresResponse {
  rows: NotifyFailureRow[];
  limit: number;
}

interface ResendChannelOutcome {
  channel: Channel;
  reset: boolean;
  retryResult: { channel: string; status: string; attempts: number; exhausted: boolean; error?: string } | null;
  noopReason?: string;
}

interface ResendResponse {
  pipeline: Pipeline;
  attemptId: number;
  outcomes: ResendChannelOutcome[];
}

interface MeResponse {
  role?: string;
}

const ADMIN_ROLES = new Set(["org_admin", "tournament_director", "super_admin"]);

function rowKey(row: NotifyFailureRow): string {
  return `${row.pipeline}:${row.attemptId}`;
}

function formatTimestamp(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

function ChannelBadge({ channel }: { channel: Channel }) {
  const Icon = channel === "email" ? Mail : Bell;
  return (
    <span
      className="inline-flex items-center gap-1 rounded border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[11px] text-amber-200"
      data-testid={`channel-badge-${channel}`}
    >
      <Icon className="w-3 h-3" />
      {channel}
    </span>
  );
}

function PipelineBadge({ pipeline }: { pipeline: Pipeline }) {
  const isWallet = pipeline === "wallet_refund";
  const Icon = isWallet ? Wallet : UserCog;
  const label = isWallet ? "Wallet refund" : "Coach payout account change";
  return (
    <span
      className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] ${
        isWallet
          ? "border-sky-500/30 bg-sky-500/10 text-sky-200"
          : "border-violet-500/30 bg-violet-500/10 text-violet-200"
      }`}
      data-testid={`pipeline-badge-${pipeline}`}
    >
      <Icon className="w-3 h-3" />
      {label}
    </span>
  );
}

function summarizeOutcomes(resp: ResendResponse): string {
  if (resp.outcomes.length === 0) {
    return "No exhausted channels — nothing to resend.";
  }
  const parts = resp.outcomes.map((o) => {
    if (!o.retryResult) {
      return `${o.channel}: reset, ${o.noopReason ?? "no dispatch"}`;
    }
    const exhaustedAgain = o.retryResult.exhausted ? " (exhausted again)" : "";
    return `${o.channel}: ${o.retryResult.status}${exhaustedAgain}`;
  });
  return `Resend complete — ${parts.join("; ")}.`;
}

function AffectedCell({ row }: { row: NotifyFailureRow }) {
  if (row.walletRefund) {
    const wr = row.walletRefund;
    return (
      <div className="text-xs leading-tight">
        <div
          className="font-medium text-white/90"
          data-testid={`affected-name-${rowKey(row)}`}
        >
          {wr.memberName ?? `User #${wr.userId}`}
        </div>
        <div className="text-[11px] text-muted-foreground font-mono">
          {wr.memberEmail ?? "no email"}
        </div>
        <div className="text-[11px] text-muted-foreground font-mono">
          {wr.currency} {wr.amount} · payment {wr.paymentId}
        </div>
      </div>
    );
  }
  if (row.coachPayoutAccountChange) {
    const cm = row.coachPayoutAccountChange;
    return (
      <div className="text-xs leading-tight">
        <div
          className="font-medium text-white/90"
          data-testid={`affected-name-${rowKey(row)}`}
        >
          {cm.coachName ?? `Coach #${cm.proId}`}
        </div>
        <div className="text-[11px] text-muted-foreground font-mono">
          {cm.coachEmail ?? "no email"}
        </div>
        <div className="text-[11px] text-muted-foreground font-mono">
          {cm.changeKind} · {cm.method} · history #{cm.historyId}
        </div>
      </div>
    );
  }
  return <span className="text-muted-foreground">—</span>;
}

export default function NotifyFailuresPage() {
  // Mirrors notify-exhaustion-history.tsx: gate on /api/auth/me so
  // non-admins see a friendly message instead of a permanent 403
  // banner. The server still enforces the role boundary.
  const {
    data: me,
    isLoading: meLoading,
    status: meStatus,
  } = useQuery<MeResponse | null>({
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
  const queryClient = useQueryClient();
  const listKey = ["admin-notify-failures"] as const;

  const { data, isLoading, isError, error, refetch, isFetching } =
    useQuery<NotifyFailuresResponse>({
      queryKey: listKey,
      queryFn: async () => {
        const res = await fetch("/api/admin/notify-failures", {
          credentials: "include",
        });
        if (res.status === 401) {
          throw new Error("Sign in required to view exhausted notify retries.");
        }
        if (res.status === 403) {
          throw new Error("Admin role required to view exhausted notify retries.");
        }
        if (!res.ok) throw new Error(`Request failed (HTTP ${res.status})`);
        return (await res.json()) as NotifyFailuresResponse;
      },
      enabled: isAdmin,
      refetchInterval: 60_000,
      refetchIntervalInBackground: false,
    });

  const [feedback, setFeedback] = useState<{
    rowKey: string;
    kind: "ok" | "error";
    text: string;
  } | null>(null);

  const resendMutation = useMutation<
    ResendResponse,
    Error,
    { row: NotifyFailureRow }
  >({
    mutationFn: async ({ row }) => {
      const res = await fetch("/api/admin/notify-failures/resend", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pipeline: row.pipeline,
          attemptId: row.attemptId,
        }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(detail || `Request failed (HTTP ${res.status})`);
      }
      return (await res.json()) as ResendResponse;
    },
    onSuccess: async (resp, vars) => {
      setFeedback({
        rowKey: rowKey(vars.row),
        kind: "ok",
        text: summarizeOutcomes(resp),
      });
      // Refresh the list so the row drops out (or its channels list
      // updates) once the exhaustion stamps have been cleared.
      await queryClient.invalidateQueries({ queryKey: listKey });
    },
    onError: (err, vars) => {
      setFeedback({
        rowKey: rowKey(vars.row),
        kind: "error",
        text: err.message || "Resend failed",
      });
    },
  });

  const rows = useMemo<NotifyFailureRow[]>(() => data?.rows ?? [], [data]);
  const pendingCount = useMemo(
    () => rows.filter((r) => r.digestedAt == null).length,
    [rows],
  );
  const digestedCount = rows.length - pendingCount;

  if (meLoading) {
    return (
      <div className="p-6" data-testid="notify-failures-page">
        <div className="text-sm text-muted-foreground">Loading…</div>
      </div>
    );
  }

  if (!isAdmin) {
    let title = "Exhausted notify retries";
    let body =
      "You need an organization, tournament-director, or super-admin role to view this page.";
    let testId = "notify-failures-no-access";
    if (meStatus === "error") {
      title = "Couldn't verify your access";
      body =
        "We couldn't reach the authentication service to check your role. Please refresh in a moment.";
      testId = "notify-failures-auth-error";
    } else if (!me) {
      title = "Sign in required";
      body = "You need to sign in to view exhausted notify retries.";
      testId = "notify-failures-signin-required";
    }
    return (
      <div className="p-6" data-testid="notify-failures-page">
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
    <div className="p-6 space-y-6" data-testid="notify-failures-page">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Exhausted notify retries
          </h1>
          <p className="text-sm text-muted-foreground mt-1 max-w-3xl">
            Wallet auto-refund and coach payout-account-change notifications
            whose email or push retry counter has run out. The same rows are
            included in the daily admin digest, but you can review them here
            without waiting for tomorrow's email — and use{" "}
            <span className="text-emerald-300">Resend now</span> to clear the
            exhaustion stamps and re-trigger delivery.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => refetch()}
            disabled={isFetching}
            data-testid="button-refresh-failures"
          >
            <RefreshCw
              className={`w-4 h-4 mr-2 ${isFetching ? "animate-spin" : ""}`}
            />
            Refresh
          </Button>
        </div>
      </div>

      {isLoading && (
        <div
          className="text-sm text-muted-foreground"
          data-testid="failures-loading"
        >
          Loading exhausted rows…
        </div>
      )}
      {isError && (
        <div
          className="rounded-lg border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-300"
          data-testid="failures-error"
        >
          {(error as Error)?.message ?? "Failed to load exhausted rows."}
        </div>
      )}

      {data && (
        <>
          <div
            className="text-xs text-muted-foreground"
            data-testid="failures-summary"
          >
            Showing {rows.length} exhausted row{rows.length === 1 ? "" : "s"};{" "}
            <span
              className={pendingCount > 0 ? "text-amber-300" : "text-white/70"}
              data-testid="failures-pending-count"
            >
              {pendingCount}
            </span>{" "}
            pending digest,{" "}
            <span data-testid="failures-digested-count" className="text-white/70">
              {digestedCount}
            </span>{" "}
            already digested.
          </div>

          {rows.length === 0 ? (
            <div
              className="rounded-lg border border-white/10 bg-white/[0.02] px-4 py-6 text-sm text-muted-foreground"
              data-testid="failures-empty"
            >
              No exhausted notify retries — every row has either been delivered
              or is still within its bounded retry window.
            </div>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-white/10">
              <table className="w-full text-xs">
                <thead className="bg-white/[0.03] text-muted-foreground">
                  <tr>
                    <th className="text-left font-medium px-3 py-2">Pipeline</th>
                    <th className="text-left font-medium px-3 py-2">Affected</th>
                    <th className="text-left font-medium px-3 py-2">Channels</th>
                    <th className="text-left font-medium px-3 py-2">
                      Last error
                    </th>
                    <th className="text-left font-medium px-3 py-2">
                      Exhausted at
                    </th>
                    <th className="text-left font-medium px-3 py-2">Digest</th>
                    <th className="text-left font-medium px-3 py-2">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    const k = rowKey(row);
                    const isPending =
                      resendMutation.isPending
                      && resendMutation.variables?.row
                      && rowKey(resendMutation.variables.row) === k;
                    const fb = feedback?.rowKey === k ? feedback : null;
                    return (
                      <tr
                        key={k}
                        className="border-t border-white/5 align-top"
                        data-testid={`failure-row-${k}`}
                      >
                        <td className="px-3 py-2">
                          <PipelineBadge pipeline={row.pipeline} />
                          <div className="text-[11px] text-muted-foreground mt-1">
                            {row.organizationName ?? `Org #${row.organizationId}`}
                          </div>
                        </td>
                        <td className="px-3 py-2">
                          <AffectedCell row={row} />
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex flex-wrap gap-1">
                            {row.channels.map((c) => (
                              <ChannelBadge key={c} channel={c} />
                            ))}
                          </div>
                        </td>
                        <td className="px-3 py-2">
                          <span
                            className="font-mono text-[11px] text-white/80 break-all"
                            data-testid={`last-error-${k}`}
                          >
                            {row.lastError ?? "—"}
                          </span>
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap text-white/80">
                          {formatTimestamp(row.exhaustedAt)}
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap">
                          {row.digestedAt ? (
                            <span
                              className="text-white/70"
                              data-testid={`digest-status-${k}`}
                            >
                              digested {formatTimestamp(row.digestedAt)}
                            </span>
                          ) : (
                            <span
                              className="text-amber-300"
                              data-testid={`digest-status-${k}`}
                            >
                              pending
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex flex-col gap-1">
                            <button
                              type="button"
                              disabled={isPending}
                              onClick={() => {
                                setFeedback(null);
                                resendMutation.mutate({ row });
                              }}
                              className="inline-flex items-center gap-1 rounded border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-emerald-200 hover:bg-emerald-500/20 disabled:opacity-50 disabled:cursor-not-allowed"
                              data-testid={`btn-resend-${k}`}
                              title="Clear exhaustion stamps and re-attempt delivery"
                            >
                              <Send className="w-3 h-3" /> Resend now
                            </button>
                            {isPending && (
                              <span
                                className="text-[10px] text-muted-foreground"
                                data-testid={`resend-pending-${k}`}
                              >
                                Working…
                              </span>
                            )}
                            {fb && !isPending && (
                              <span
                                className={`text-[10px] ${fb.kind === "ok" ? "text-emerald-300" : "text-red-300"}`}
                                data-testid={`resend-feedback-${k}`}
                              >
                                {fb.text}
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
          )}
        </>
      )}
    </div>
  );
}
