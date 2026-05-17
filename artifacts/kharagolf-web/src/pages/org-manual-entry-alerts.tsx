// Task #2068 — per-organization rollup of skipped/failed manual-entry
// alerts. Mirrors a stripped-down slice of the super-admin dashboard
// (`/super-admin/manual-entry-alerts`) so org admins can triage their
// own club's alerts without needing platform access.
//
// Data scope:
//   - org_admin / tournament_director: sees their own org only.
//   - super_admin: sees the active org from `useActiveOrgId()` (the
//     OrgSwitcher dropdown picks which club to inspect).
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useGetMe } from "@workspace/api-client-react";
import { useLocation } from "wouter";
import {
  AlertCircle, ArrowLeft, BellRing, Filter, Loader2, Mail, RefreshCw, Smartphone,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useActiveOrgId } from "@/context/ActiveOrgContext";

interface ManualEntryAlertRow {
  id: number;
  submissionId: number;
  tournamentId: number;
  tournamentName: string | null;
  organizationId: number | null;
  organizationName: string | null;
  playerId: number;
  playerName: string | null;
  round: number;
  manualPct: number;
  manualShots: number;
  totalShots: number;
  recipientCount: number;
  pushAttempted: number;
  pushSent: number;
  emailAttempted: number;
  emailSent: number;
  zeroDelivery: boolean;
  status: "sent" | "skipped" | "failed";
  reason: string | null;
  sentAt: string;
}

type StatusFilter = "all" | "sent" | "skipped" | "failed";

interface RowsResponse {
  rows: ManualEntryAlertRow[];
  total: number;
  limit: number;
  offset: number;
}

const ROW_LIMIT = 100;

export default function OrgManualEntryAlertsPage() {
  const { data: me, isLoading: meLoading } = useGetMe();
  const [, navigate] = useLocation();
  const activeOrgId = useActiveOrgId();

  const [statusFilter, setStatusFilter] = useState<StatusFilter>("skipped");
  const [sinceDays, setSinceDays] = useState<7 | 30>(30);

  // Permission gate: any club admin or platform super-admin can use the
  // page. `requireOrgAdmin` on the API enforces the same rule, so the
  // client-side check is just to avoid firing a request that's
  // guaranteed to 403.
  const isAuthorized =
    me?.role === "super_admin"
    || me?.role === "org_admin"
    || me?.role === "tournament_director";

  const queryParams = useMemo(() => {
    const params = new URLSearchParams();
    if (statusFilter !== "all") params.set("status", statusFilter);
    params.set("sinceDays", String(sinceDays));
    params.set("limit", String(ROW_LIMIT));
    return params;
  }, [statusFilter, sinceDays]);

  const rowsQuery = useQuery<RowsResponse, Error>({
    queryKey: [
      "/api/organizations/manual-entry-alerts/rows",
      activeOrgId, statusFilter, sinceDays,
    ],
    queryFn: async () => {
      if (activeOrgId == null) {
        throw new Error("No active organization selected.");
      }
      const r = await fetch(
        `/api/organizations/${activeOrgId}/manual-entry-alerts/rows?${queryParams.toString()}`,
      );
      if (!r.ok) {
        const text = await r.text().catch(() => "");
        throw new Error(`Failed to load rows (${r.status}${text ? `: ${text.slice(0, 120)}` : ""})`);
      }
      return r.json();
    },
    enabled: isAuthorized && activeOrgId != null,
    staleTime: 10000,
    retry: 1,
  });

  if (meLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="w-6 h-6 animate-spin text-primary" />
      </div>
    );
  }

  if (!isAuthorized) {
    return (
      <div className="p-6 max-w-3xl mx-auto" data-testid="page-org-manual-entry-alerts-forbidden">
        <div className="bg-card border border-border rounded-xl p-6 text-center">
          <AlertCircle className="w-8 h-8 text-amber-400 mx-auto mb-3" />
          <h1 className="text-lg font-semibold text-white mb-1">Admin only</h1>
          <p className="text-sm text-muted-foreground">
            This page is restricted to club admins and tournament directors.
          </p>
        </div>
      </div>
    );
  }

  if (activeOrgId == null) {
    return (
      <div className="p-6 max-w-3xl mx-auto" data-testid="page-org-manual-entry-alerts-no-org">
        <div className="bg-card border border-border rounded-xl p-6 text-center">
          <AlertCircle className="w-8 h-8 text-amber-400 mx-auto mb-3" />
          <h1 className="text-lg font-semibold text-white mb-1">No active organization</h1>
          <p className="text-sm text-muted-foreground">
            Pick a club from the organization switcher to view manual-entry alerts.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      className="p-6 max-w-7xl mx-auto space-y-6"
      data-testid="page-org-manual-entry-alerts"
    >
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <BellRing className="w-5 h-5 text-purple-400" />
            <h1 className="text-xl font-bold text-white">Manual-entry alerts</h1>
          </div>
          <p className="text-sm text-muted-foreground">
            Recent skipped or failed manual-entry alerts for this club.
          </p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <Button
            variant="outline"
            size="sm"
            onClick={() => navigate("/admin")}
            data-testid="button-back-admin"
          >
            <ArrowLeft className="w-4 h-4 mr-1.5" />Admin
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => rowsQuery.refetch()}
            disabled={rowsQuery.isFetching}
            data-testid="button-refresh"
          >
            {rowsQuery.isFetching
              ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
              : <RefreshCw className="w-4 h-4 mr-1.5" />}
            Refresh
          </Button>
        </div>
      </div>

      <div className="bg-card border border-border rounded-xl p-5" data-testid="panel-rows">
        <div className="flex items-start justify-between flex-wrap gap-3 mb-4">
          <h2 className="text-sm font-semibold text-white flex items-center gap-2">
            <Filter className="w-4 h-4 text-primary" />Alert rows
            {rowsQuery.data && (
              <span className="text-xs text-muted-foreground font-normal">
                ({rowsQuery.data.total.toLocaleString()} match{rowsQuery.data.total === 1 ? "" : "es"}
                {rowsQuery.data.total > rowsQuery.data.rows.length
                  ? `, showing first ${rowsQuery.data.rows.length}`
                  : ""})
              </span>
            )}
          </h2>
          <div className="flex items-center gap-2 flex-wrap">
            <div className="inline-flex items-center rounded-lg border border-border bg-card p-0.5">
              {([7, 30] as const).map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => setSinceDays(d)}
                  className={`text-xs px-2.5 py-1 rounded-md transition-colors ${
                    sinceDays === d ? "bg-primary/20 text-primary" : "text-muted-foreground hover:text-white"
                  }`}
                  data-testid={`button-since-${d}`}
                >
                  {d}d
                </button>
              ))}
            </div>
            <div className="inline-flex items-center rounded-lg border border-border bg-card p-0.5">
              {(["all", "sent", "skipped", "failed"] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setStatusFilter(s)}
                  className={`text-xs px-2.5 py-1 rounded-md transition-colors capitalize ${
                    statusFilter === s ? "bg-primary/20 text-primary" : "text-muted-foreground hover:text-white"
                  }`}
                  data-testid={`button-status-${s}`}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        </div>

        {rowsQuery.isLoading && !rowsQuery.data ? (
          <div className="flex justify-center py-8">
            <Loader2 className="w-5 h-5 animate-spin text-primary" />
          </div>
        ) : rowsQuery.error && !rowsQuery.data ? (
          <div
            className="flex items-start gap-2 text-sm text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg p-3"
            data-testid="text-rows-error"
          >
            <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
            <span>Couldn’t load alert rows: {rowsQuery.error.message}</span>
          </div>
        ) : !rowsQuery.data || rowsQuery.data.rows.length === 0 ? (
          <p className="text-sm text-muted-foreground py-6 text-center" data-testid="text-rows-empty">
            No alert rows match the current filters.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs" data-testid="table-rows">
              <thead>
                <tr className="text-left text-muted-foreground border-b border-border">
                  <th className="py-1.5 pr-3 font-medium">Sent</th>
                  <th className="py-1.5 pr-3 font-medium">Tournament</th>
                  <th className="py-1.5 pr-3 font-medium">Player</th>
                  <th className="py-1.5 pr-3 font-medium text-right">Round</th>
                  <th className="py-1.5 pr-3 font-medium text-right">Manual %</th>
                  <th className="py-1.5 pr-3 font-medium text-right">Recipients</th>
                  <th className="py-1.5 pr-3 font-medium text-right">
                    <span className="inline-flex items-center gap-1"><Smartphone className="w-3 h-3" />Push</span>
                  </th>
                  <th className="py-1.5 pr-3 font-medium text-right">
                    <span className="inline-flex items-center gap-1"><Mail className="w-3 h-3" />Email</span>
                  </th>
                  <th className="py-1.5 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {rowsQuery.data.rows.map((row) => (
                  <tr
                    key={`row-${row.id}`}
                    className={`border-b border-border/50 last:border-0 ${row.zeroDelivery ? "bg-amber-500/5" : ""}`}
                    data-testid={`row-alert-${row.id}`}
                  >
                    <td className="py-1.5 pr-3 text-white whitespace-nowrap">
                      {new Date(row.sentAt).toLocaleString()}
                    </td>
                    <td className="py-1.5 pr-3 text-white">
                      {row.tournamentName ?? `#${row.tournamentId}`}
                    </td>
                    <td className="py-1.5 pr-3 text-white">
                      {row.playerName ?? `#${row.playerId}`}
                    </td>
                    <td className="py-1.5 pr-3 text-muted-foreground text-right">{row.round}</td>
                    <td className="py-1.5 pr-3 text-muted-foreground text-right font-mono">
                      {row.manualPct.toFixed(1)}%
                    </td>
                    <td className="py-1.5 pr-3 text-muted-foreground text-right">{row.recipientCount}</td>
                    <td className="py-1.5 pr-3 text-right font-mono">
                      <span className={row.pushSent > 0 ? "text-emerald-400" : "text-muted-foreground"}>
                        {row.pushSent}
                      </span>
                      <span className="text-muted-foreground">/{row.pushAttempted}</span>
                    </td>
                    <td className="py-1.5 pr-3 text-right font-mono">
                      <span className={row.emailSent > 0 ? "text-emerald-400" : "text-muted-foreground"}>
                        {row.emailSent}
                      </span>
                      <span className="text-muted-foreground">/{row.emailAttempted}</span>
                    </td>
                    <td className="py-1.5">
                      {row.status === "sent" ? (
                        row.zeroDelivery ? (
                          <Badge variant="outline" className="text-amber-400 border-amber-500/30">
                            silent
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="text-emerald-400 border-emerald-500/30">
                            delivered
                          </Badge>
                        )
                      ) : (
                        <div
                          className="flex items-center gap-1.5 flex-wrap"
                          data-testid={`row-alert-${row.id}-status-skip`}
                        >
                          <Badge
                            variant="outline"
                            className={
                              row.status === "failed"
                                ? "text-red-400 border-red-500/30"
                                : "text-amber-300 border-amber-400/30"
                            }
                          >
                            {row.status}
                          </Badge>
                          {row.reason && (
                            <span
                              className="text-[10px] text-muted-foreground"
                              data-testid={`row-alert-${row.id}-reason`}
                            >
                              {row.reason.replace(/_/g, " ")}
                            </span>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
