// Super-admin manual-entry alert delivery-health dashboard (Task #1193).
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useGetMe } from "@workspace/api-client-react";
import { useLocation } from "wouter";
import {
  AlertCircle, ArrowLeft, BellRing, Building2, ChevronDown, ChevronRight,
  Crown, Download, Filter, Loader2, Mail, PhoneCall, RefreshCw, Send, Smartphone, Trophy, UserRound, X,
} from "lucide-react";
import {
  SkipReasonBreakdownPanel,
  type SkipReasonBreakdown,
} from "@/components/SkipReasonBreakdownPanel";
import {
  SkipReasonDailyTrendPanel,
  type SkipReasonDailySeries,
} from "@/components/SkipReasonDailyTrendPanel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
// Task #2057 — shared "Slack ✓ / PagerDuty ✗ + Send test page" panel +
// hook, mirroring the watch-GPS pattern from Task #1653 across every
// ops-alert dashboard so future alerts inherit it for free.
import { OpsAlertWiringPanel } from "@/components/OpsAlertWiringPanel";
import { useOpsAlertTestPageMutation } from "@/hooks/use-ops-alert-test-page";

interface AlertWindow {
  alertCount: number;
  recipientTotal: number;
  pushAttemptedTotal: number;
  pushSentTotal: number;
  emailAttemptedTotal: number;
  emailSentTotal: number;
  pushDeliveryRate: number;
  emailDeliveryRate: number;
  anyDeliveryRate: number;
  zeroDeliveryCount: number;
  silentRecipientTotal: number;
}

interface TopTournament {
  tournamentId: number;
  tournamentName: string | null;
  organizationId: number | null;
  organizationName: string | null;
  alertCount: number;
  zeroDeliveryCount: number;
  silentRecipientTotal: number;
}

interface TopPlayer {
  playerId: number;
  playerName: string | null;
  alertCount: number;
  zeroDeliveryCount: number;
}

interface TopSilentOrg {
  organizationId: number | null;
  organizationName: string | null;
  zeroDeliveryAlertCount: number;
  silentRecipientTotal: number;
}

interface ManualEntryAlertHealthSummary {
  windows: { "7d": AlertWindow; "30d": AlertWindow };
  topTournaments7d: TopTournament[];
  topZeroDeliveryTournaments30d: TopTournament[];
  topPlayers30d: TopPlayer[];
  topSilentRecipientOrgs30d: TopSilentOrg[];
  skipReasonBreakdown: SkipReasonBreakdown;
  // Task #2065 — daily-bucket time-series for the trend chart that
  // sits beneath the static skip-reason breakdown.
  skipReasonDailySeries: SkipReasonDailySeries;
  // Task #2057 — sanitized chat-channel config for the manual-entry
  // alert-health auto-pager so the dashboard can render the
  // `Slack ✓ / PagerDuty ✗` badges + a "Send test page" button. Booleans
  // only; the underlying webhook URL / routing key never crosses the
  // wire.
  chatTargets?: {
    slackConfigured: boolean;
    pagerDutyConfigured: boolean;
  };
  generatedAt: string;
}

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
  // Task #1658 — outcome of the notify call. The dashboard now lists
  // skip rows alongside successful alerts so support can answer "why
  // didn't this fire?" without leaving the page.
  status: "sent" | "skipped" | "failed";
  reason: string | null;
  sentAt: string;
}

type ManualEntryAlertStatusFilter = "all" | "sent" | "skipped" | "failed";

interface RowsResponse {
  rows: ManualEntryAlertRow[];
  total: number;
  limit: number;
  offset: number;
}

interface SilentRecipient {
  userId: number | null;
  displayName: string | null;
  username: string | null;
  email: string | null;
  channel: "push" | "email";
  status: "failed" | "no_address" | "no_email" | "opted_out";
  errorMessage: string | null;
  createdAt: string;
  /**
   * Task #2075 — true when the row was synthesized by the Task #1672
   * backfill from aggregate alert counts rather than recorded at
   * delivery time. The dashboard renders a "(reconstructed)" pill so
   * ops doesn't mistake bucket-assigned attribution for real per-user
   * delivery data.
   */
  reconstructed: boolean;
}

const RECONSTRUCTED_TOOLTIP =
  "This row was reconstructed by the Task #1672 backfill from the alert's "
  + "aggregate counts. The push/email/opt-out bucket is correct in aggregate, "
  + "but the per-user mapping was inferred from the org's current director "
  + "roster in deterministic slot order — not recorded at delivery time. "
  + "Don't treat it as confirmation that this specific person got nothing.";

interface SilentRecipientsResponse {
  alertId: number;
  silentRecipients: SilentRecipient[];
  totalRecipientRows: number;
}

// Task #1665 — durable record of every on-call page sent by the
// auto-page job (Task #1387). The dashboard renders the most recent
// row as a banner so super-admins can tell if on-call has already
// been notified before DM'ing them about a current outage.
interface PageHistoryRow {
  id: number;
  pagedAt: string;
  breachKinds: string[];
  recipientCount: number;
  recipientEmails: string[];
  thresholdPct: number;
  cooldownHours: number;
  alertCount7d: number;
  anyDeliveryRate7d: number;
  zeroDeliveryCount7d: number;
  // Task #2079 — true for synthetic rows fired by the dashboard's
  // "Send test page" button. The banner / history list label these
  // distinctly so a wiring test isn't mistaken for a real outage.
  isTest: boolean;
}

// Task #2079 — POST /super-admin/manual-entry-alerts/test-page
// response. `recipients` echoes the resolved on-call list so the
// toast can show *who* the page actually reached.
interface TestPageResponse {
  ok: boolean;
  reason?: "no_recipients" | "send_failed";
  recipientsAttempted: number;
  recipientsEmailed: number;
  recipients: string[];
  pageHistoryId: number | null;
}

interface PageHistoryResponse {
  rows: PageHistoryRow[];
}

// Task #2078 — combined snapshot of "is on-call paging currently muted
// by an active cooldown AND a fresh breach is firing?". The dashboard
// uses this to render a "cooldown active" pill on the page-history
// banner so admins can tell silence on the dashboard means "problem
// detected, paging suppressed" rather than "no problem".
interface CooldownStatusResponse {
  active: boolean;
  latestPagedAt: string | null;
  cooldownHours: number | null;
  nextPageEligibleAt: string | null;
  breachKinds: string[];
  thresholdPct: number;
}

const ROW_LIMIT = 100;
const PAGE_HISTORY_LIMIT = 10;

const BREACH_KIND_LABEL: Record<string, string> = {
  delivery_rate: "delivery rate",
  consecutive_zero: "consecutive silent",
};

function formatRelative(iso: string, now = Date.now()): string {
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return iso;
  const diffMs = now - ts;
  if (diffMs < 0) return "just now";
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 14) return `${day}d ago`;
  return new Date(ts).toLocaleDateString();
}

// Task #1663 — Parse the page's initial filter state from URL query
// params so the weekly silent-failures email digest can deep-link
// directly to a pre-filtered view (the email's CTA links to
// `/super-admin/manual-entry-alerts?sinceDays=7&zeroDeliveryOnly=1`).
// Falls back to the page defaults when a param is missing or invalid
// so a typo in a shared link never blanks the dashboard.
function readInitialFilters(): {
  tournamentFilter: string;
  playerFilter: string;
  organizationFilter: string;
  zeroOnly: boolean;
  statusFilter: ManualEntryAlertStatusFilter;
  sinceDays: 7 | 30;
} {
  const defaults = {
    tournamentFilter: "",
    playerFilter: "",
    organizationFilter: "",
    zeroOnly: false,
    statusFilter: "all" as ManualEntryAlertStatusFilter,
    sinceDays: 30 as 7 | 30,
  };
  if (typeof window === "undefined") return defaults;
  try {
    const sp = new URLSearchParams(window.location.search);
    const sinceDaysRaw = sp.get("sinceDays");
    const sinceDays: 7 | 30 = sinceDaysRaw === "7" ? 7 : sinceDaysRaw === "30" ? 30 : defaults.sinceDays;
    const zeroOnlyRaw = sp.get("zeroDeliveryOnly");
    const zeroOnly = zeroOnlyRaw === "1" || zeroOnlyRaw === "true";
    const statusRaw = sp.get("status");
    const statusFilter: ManualEntryAlertStatusFilter =
      statusRaw === "sent" || statusRaw === "skipped" || statusRaw === "failed" || statusRaw === "all"
        ? statusRaw
        : defaults.statusFilter;
    return {
      tournamentFilter: sp.get("tournamentId")?.trim() ?? "",
      playerFilter: sp.get("playerId")?.trim() ?? "",
      organizationFilter: sp.get("organizationId")?.trim() ?? "",
      zeroOnly,
      statusFilter,
      sinceDays,
    };
  } catch {
    return defaults;
  }
}

export default function ManualEntryAlertsPage() {
  const { data: me, isLoading: meLoading } = useGetMe();
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  // Lazy initializers seed first render from the URL so the weekly
  // silent-failures email deep-link (Task #1663) arrives with the
  // right filter set on the very first query — no double-fetch / flash
  // of unfiltered data. Includes Task #1658's status filter so a
  // future deep-link can also pre-select the skipped/failed view.
  const initialFilters = useState(readInitialFilters)[0];
  const [tournamentFilter, setTournamentFilter] = useState(initialFilters.tournamentFilter);
  const [playerFilter, setPlayerFilter] = useState(initialFilters.playerFilter);
  const [organizationFilter, setOrganizationFilter] = useState(initialFilters.organizationFilter);
  const [zeroOnly, setZeroOnly] = useState(initialFilters.zeroOnly);
  // Task #1658 — status filter (all/sent/skipped/failed). Default is
  // 'all' so the page mirrors the audit table verbatim; ops can switch
  // to 'skipped' to triage org_muted/below_threshold rows specifically.
  const [statusFilter, setStatusFilter] = useState<ManualEntryAlertStatusFilter>(initialFilters.statusFilter);
  const [sinceDays, setSinceDays] = useState<7 | 30>(initialFilters.sinceDays);
  const [expandedAlertIds, setExpandedAlertIds] = useState<Set<number>>(() => new Set());

  const toggleAlertExpanded = (id: number) => {
    setExpandedAlertIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const isSuperAdmin = me?.role === "super_admin";

  // Task #2057 — fire a clearly-labelled test page through the same
  // Slack / PagerDuty senders the real manual-entry alert-health
  // breach uses. Mounted just under the page-history banner so the
  // chat-channel state is visible the moment the dashboard loads.
  const sendOpsAlertTestPage = useOpsAlertTestPageMutation({
    endpoint: "/api/super-admin/manual-entry-alerts/test-ops-alert-chat",
    invalidateQueryKeys: [["/api/super-admin/manual-entry-alerts/summary"]],
    slackEnvVar: "OPS_MANUAL_ENTRY_ALERT_SLACK_WEBHOOK",
    pagerDutyEnvVar: "OPS_MANUAL_ENTRY_ALERT_PAGERDUTY_ROUTING_KEY",
  });

  const summaryQuery = useQuery<ManualEntryAlertHealthSummary, Error>({
    queryKey: ["/api/super-admin/manual-entry-alerts/summary"],
    queryFn: async () => {
      const r = await fetch("/api/super-admin/manual-entry-alerts/summary");
      if (!r.ok) {
        const text = await r.text().catch(() => "");
        throw new Error(`Failed to load summary (${r.status}${text ? `: ${text.slice(0, 120)}` : ""})`);
      }
      return r.json();
    },
    enabled: isSuperAdmin,
    staleTime: 15000,
    refetchInterval: 60000,
    retry: 1,
  });

  // Task #1665 — most recent on-call pages from the auto-page job. The
  // first row drives the "Last paged" banner so super-admins can tell
  // whether on-call has already been notified about a current outage.
  const pageHistoryQuery = useQuery<PageHistoryResponse, Error>({
    queryKey: ["/api/super-admin/manual-entry-alerts/page-history"],
    queryFn: async () => {
      const r = await fetch(
        `/api/super-admin/manual-entry-alerts/page-history?limit=${PAGE_HISTORY_LIMIT}`,
      );
      if (!r.ok) {
        const text = await r.text().catch(() => "");
        throw new Error(`Failed to load page history (${r.status}${text ? `: ${text.slice(0, 120)}` : ""})`);
      }
      return r.json();
    },
    enabled: isSuperAdmin,
    staleTime: 15000,
    refetchInterval: 60000,
    retry: 1,
  });
  // Task #2078 — sibling query for the cooldown-active signal. Polled
  // on the same 60s cadence as page-history; failures are tolerated
  // silently because the existing banner is the primary surface and
  // the pill is purely additional context.
  const cooldownStatusQuery = useQuery<CooldownStatusResponse, Error>({
    queryKey: ["/api/super-admin/manual-entry-alerts/cooldown-status"],
    queryFn: async () => {
      const r = await fetch("/api/super-admin/manual-entry-alerts/cooldown-status");
      if (!r.ok) {
        const text = await r.text().catch(() => "");
        throw new Error(
          `Failed to load cooldown status (${r.status}${text ? `: ${text.slice(0, 120)}` : ""})`,
        );
      }
      return r.json();
    },
    enabled: isSuperAdmin,
    staleTime: 15000,
    refetchInterval: 60000,
    retry: 1,
  });
  const [pageHistoryExpanded, setPageHistoryExpanded] = useState(false);

  // Task #2079 — fire a synthetic on-call page through the same email
  // wiring the auto-page job uses. Lets super-admins verify routing
  // (distribution list, Resend config, OPS_ALERT_EMAILS env) without
  // waiting for a real silent-alert breach. The mutation invalidates
  // the page-history query so the new test row pops into the banner /
  // history list immediately.
  const testPageMutation = useMutation<TestPageResponse, Error, void>({
    mutationFn: async () => {
      const r = await fetch("/api/super-admin/manual-entry-alerts/test-page", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      if (!r.ok) {
        const text = await r.text().catch(() => "");
        throw new Error(`Failed to send test page (${r.status}${text ? `: ${text.slice(0, 120)}` : ""})`);
      }
      return r.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/super-admin/manual-entry-alerts/page-history"] });
      if (data.ok) {
        toast({
          title: "Test page sent",
          description:
            data.recipientsEmailed === data.recipientsAttempted
              ? `Emailed ${data.recipientsEmailed} recipient${data.recipientsEmailed === 1 ? "" : "s"} (${data.recipients.join(", ")}).`
              : `Emailed ${data.recipientsEmailed}/${data.recipientsAttempted} recipients — check the API logs for the failures.`,
        });
      } else if (data.reason === "no_recipients") {
        toast({
          title: "No recipients configured",
          description:
            "Set OPS_ALERT_EMAILS or add a super_admin email so the auto-page job has someone to reach.",
          variant: "destructive",
        });
      } else {
        toast({
          title: "Test page failed",
          description: `All ${data.recipientsAttempted} email sends failed — check the API logs and Resend status.`,
          variant: "destructive",
        });
      }
    },
    onError: (err) => {
      toast({
        title: "Test page failed",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  // Build the row-filter query params once so the JSON fetch and the CSV
  // download URL stay in lock-step (Task #1388: download mirrors active filters).
  const rowFilterParams = useMemo(() => {
    const params = new URLSearchParams();
    if (tournamentFilter.trim()) params.set("tournamentId", tournamentFilter.trim());
    if (playerFilter.trim()) params.set("playerId", playerFilter.trim());
    if (organizationFilter.trim()) params.set("organizationId", organizationFilter.trim());
    if (zeroOnly) params.set("zeroDeliveryOnly", "1");
    if (statusFilter !== "all") params.set("status", statusFilter);
    params.set("sinceDays", String(sinceDays));
    return params;
  }, [tournamentFilter, playerFilter, organizationFilter, zeroOnly, statusFilter, sinceDays]);

  const csvHref = useMemo(() => {
    const p = new URLSearchParams(rowFilterParams);
    return `/api/super-admin/manual-entry-alerts/rows.csv?${p.toString()}`;
  }, [rowFilterParams]);

  const rowsQuery = useQuery<RowsResponse, Error>({
    queryKey: [
      "/api/super-admin/manual-entry-alerts/rows",
      tournamentFilter, playerFilter, organizationFilter, zeroOnly, statusFilter, sinceDays,
    ],
    queryFn: async () => {
      const params = new URLSearchParams(rowFilterParams);
      params.set("limit", String(ROW_LIMIT));
      const r = await fetch(`/api/super-admin/manual-entry-alerts/rows?${params.toString()}`);
      if (!r.ok) {
        const text = await r.text().catch(() => "");
        throw new Error(`Failed to load rows (${r.status}${text ? `: ${text.slice(0, 120)}` : ""})`);
      }
      return r.json();
    },
    enabled: isSuperAdmin,
    staleTime: 10000,
    retry: 1,
  });

  const summary = summaryQuery.data;
  const filtersActive = useMemo(
    () => Boolean(
      tournamentFilter.trim() || playerFilter.trim() || organizationFilter.trim() ||
      zeroOnly || statusFilter !== "all",
    ),
    [tournamentFilter, playerFilter, organizationFilter, zeroOnly, statusFilter],
  );

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
    <div className="p-6 max-w-7xl mx-auto space-y-6" data-testid="page-manual-entry-alerts">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <BellRing className="w-5 h-5 text-purple-400" />
            <h1 className="text-xl font-bold text-white">Manual-entry alert health</h1>
          </div>
          <p className="text-sm text-muted-foreground">
            Delivery rates and silent-failure triage for manual-entry round alerts.
          </p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <Button variant="outline" size="sm" onClick={() => navigate("/super-admin")} data-testid="button-back-super-admin">
            <ArrowLeft className="w-4 h-4 mr-1.5" />Super Admin
          </Button>
          {/* Task #2079 — fire a synthetic page through the same email
              wiring the auto-page job uses. Confirm dialog so a stray
              click doesn't surprise on-call. */}
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              if (testPageMutation.isPending) return;
              const ok = window.confirm(
                "Send a TEST page to the on-call email distribution? " +
                "This emails every super_admin and OPS_ALERT_EMAILS recipient with a clearly-labelled [TEST] message and writes a row to the page history.",
              );
              if (!ok) return;
              testPageMutation.mutate();
            }}
            disabled={testPageMutation.isPending}
            data-testid="button-send-test-page"
          >
            {testPageMutation.isPending
              ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
              : <Send className="w-4 h-4 mr-1.5" />}
            Send test page
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              summaryQuery.refetch();
              rowsQuery.refetch();
              pageHistoryQuery.refetch();
            }}
            disabled={summaryQuery.isFetching || rowsQuery.isFetching || pageHistoryQuery.isFetching}
            data-testid="button-refresh"
          >
            {summaryQuery.isFetching || rowsQuery.isFetching || pageHistoryQuery.isFetching
              ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
              : <RefreshCw className="w-4 h-4 mr-1.5" />}
            Refresh
          </Button>
        </div>
      </div>

      <PageHistoryBanner
        query={pageHistoryQuery}
        cooldownStatus={cooldownStatusQuery.data}
        expanded={pageHistoryExpanded}
        onToggleExpanded={() => setPageHistoryExpanded((v) => !v)}
      />

      {/*
        Task #2057 — Slack/PagerDuty wiring badges + a "Send test page"
        button for the manual-entry alert-health auto-pager. Sits right
        under the page-history banner so the chat-channel state is
        visible the moment the dashboard loads, before any of the
        7d/30d window cards. Renders nothing until the summary query
        resolves with the `chatTargets` field.
      */}
      <OpsAlertWiringPanel
        chatTargets={summary?.chatTargets}
        label="Delivery-health alert"
        slackEnvVar="OPS_MANUAL_ENTRY_ALERT_SLACK_WEBHOOK"
        pagerDutyEnvVar="OPS_MANUAL_ENTRY_ALERT_PAGERDUTY_ROUTING_KEY"
        isSending={sendOpsAlertTestPage.isPending}
        onSendTestPage={() => sendOpsAlertTestPage.mutate()}
        testIdPrefix="manual-entry-ops-alert"
      />

      {summaryQuery.isLoading && !summary ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="w-6 h-6 animate-spin text-primary" />
        </div>
      ) : summaryQuery.error && !summary ? (
        <div
          className="flex items-start gap-2 text-sm text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg p-3"
          data-testid="text-summary-error"
        >
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>Couldn’t load summary: {summaryQuery.error.message}</span>
        </div>
      ) : summary ? (
        <>
          {(["7d", "30d"] as const).map((win) => (
            <WindowCard key={win} label={win} data={summary.windows[win]} />
          ))}

          <SkipReasonBreakdownPanel breakdown={summary.skipReasonBreakdown} />

          <SkipReasonDailyTrendPanel data={summary.skipReasonDailySeries} />

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="bg-card border border-border rounded-xl p-5" data-testid="panel-top-tournaments-7d">
              <h2 className="text-sm font-semibold text-white mb-3 flex items-center gap-2">
                <Trophy className="w-4 h-4 text-primary" />Top tournaments (last 7 days)
              </h2>
              {summary.topTournaments7d.length === 0 ? (
                <p className="text-sm text-muted-foreground py-4 text-center">No alerts fired in the last 7 days.</p>
              ) : (
                <ul className="space-y-2">
                  {summary.topTournaments7d.map((t) => (
                    <li
                      key={t.tournamentId}
                      className="flex items-center justify-between gap-3 py-1 border-b border-border last:border-0"
                    >
                      <div className="min-w-0">
                        <button
                          type="button"
                          className="text-sm text-white text-left hover:text-primary transition-colors truncate"
                          onClick={() => { setTournamentFilter(String(t.tournamentId)); setPlayerFilter(""); }}
                          data-testid={`button-filter-tournament-${t.tournamentId}`}
                        >
                          {t.tournamentName ?? `Tournament #${t.tournamentId}`}
                        </button>
                        {t.organizationName && (
                          <p className="text-xs text-muted-foreground truncate">{t.organizationName}</p>
                        )}
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        {t.zeroDeliveryCount > 0 && (
                          <Badge variant="outline" className="text-amber-400 border-amber-500/30">
                            {t.zeroDeliveryCount} silent
                          </Badge>
                        )}
                        <span className="text-sm font-semibold text-primary">{t.alertCount}</span>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="bg-card border border-border rounded-xl p-5" data-testid="panel-zero-delivery-30d">
              <h2 className="text-sm font-semibold text-white mb-3 flex items-center gap-2">
                <AlertCircle className="w-4 h-4 text-amber-400" />Silent failures (last 30 days)
              </h2>
              {summary.topZeroDeliveryTournaments30d.length === 0 ? (
                <p className="text-sm text-muted-foreground py-4 text-center">
                  Every alert reached at least one recipient. Nice.
                </p>
              ) : (
                <ul className="space-y-2">
                  {summary.topZeroDeliveryTournaments30d.map((t) => (
                    <li
                      key={t.tournamentId}
                      className="flex items-center justify-between gap-3 py-1 border-b border-border last:border-0"
                    >
                      <div className="min-w-0">
                        <button
                          type="button"
                          className="text-sm text-white text-left hover:text-primary transition-colors truncate"
                          onClick={() => {
                            setTournamentFilter(String(t.tournamentId));
                            setPlayerFilter("");
                            setZeroOnly(true);
                            setSinceDays(30);
                          }}
                          data-testid={`button-filter-zero-tournament-${t.tournamentId}`}
                        >
                          {t.tournamentName ?? `Tournament #${t.tournamentId}`}
                        </button>
                        {t.organizationName && (
                          <p className="text-xs text-muted-foreground truncate">{t.organizationName}</p>
                        )}
                      </div>
                      <span className="text-sm font-semibold text-amber-400">{t.zeroDeliveryCount}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          <div className="bg-card border border-border rounded-xl p-5" data-testid="panel-silent-recipient-orgs-30d">
            <h2 className="text-sm font-semibold text-white mb-3 flex items-center gap-2">
              <Building2 className="w-4 h-4 text-amber-400" />Recipients with zero successful deliveries (last 30 days)
            </h2>
            <p className="text-xs text-muted-foreground mb-3">
              Organizations whose recipient inboxes most often received nothing on a manual-entry alert.
              Counts sum the alert's recipientCount across silent alerts (proxy until per-recipient delivery is tracked).
            </p>
            {summary.topSilentRecipientOrgs30d.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4 text-center">
                Every alert reached at least one recipient in the last 30 days.
              </p>
            ) : (
              <ul className="space-y-2">
                {summary.topSilentRecipientOrgs30d.map((o) => (
                  <li
                    key={o.organizationId ?? "unknown"}
                    className="flex items-center justify-between gap-3 py-1 border-b border-border last:border-0"
                  >
                    <div className="min-w-0">
                      {o.organizationId != null ? (
                        <button
                          type="button"
                          className="text-sm text-white text-left hover:text-primary transition-colors truncate"
                          onClick={() => {
                            setTournamentFilter("");
                            setPlayerFilter("");
                            setOrganizationFilter(String(o.organizationId));
                            setZeroOnly(true);
                            setSinceDays(30);
                          }}
                          data-testid={`button-filter-silent-org-${o.organizationId}`}
                        >
                          {o.organizationName ?? `Org #${o.organizationId}`}
                        </button>
                      ) : (
                        <span className="text-sm text-muted-foreground italic">Unattributed</span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <Badge variant="outline" className="text-amber-400 border-amber-500/30">
                        {o.zeroDeliveryAlertCount} silent alert{o.zeroDeliveryAlertCount === 1 ? "" : "s"}
                      </Badge>
                      <span className="text-sm font-semibold text-amber-400">{o.silentRecipientTotal}</span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="bg-card border border-border rounded-xl p-5" data-testid="panel-top-players-30d">
            <h2 className="text-sm font-semibold text-white mb-3 flex items-center gap-2">
              <UserRound className="w-4 h-4 text-primary" />Players triggering most alerts (last 30 days)
            </h2>
            {summary.topPlayers30d.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4 text-center">No alerts fired in the last 30 days.</p>
            ) : (
              <ul className="space-y-2">
                {summary.topPlayers30d.map((p) => (
                  <li
                    key={p.playerId}
                    className="flex items-center justify-between gap-3 py-1 border-b border-border last:border-0"
                  >
                    <button
                      type="button"
                      className="text-sm text-white text-left hover:text-primary transition-colors truncate"
                      onClick={() => { setPlayerFilter(String(p.playerId)); setTournamentFilter(""); }}
                      data-testid={`button-filter-player-${p.playerId}`}
                    >
                      {p.playerName ?? `Player #${p.playerId}`}
                    </button>
                    <div className="flex items-center gap-2 shrink-0">
                      {p.zeroDeliveryCount > 0 && (
                        <Badge variant="outline" className="text-amber-400 border-amber-500/30">
                          {p.zeroDeliveryCount} silent
                        </Badge>
                      )}
                      <span className="text-sm font-semibold text-primary">{p.alertCount}</span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      ) : null}

      {/* Drill-down table */}
      <div className="bg-card border border-border rounded-xl p-5" data-testid="panel-rows">
        <div className="flex items-start justify-between flex-wrap gap-3 mb-4">
          <h2 className="text-sm font-semibold text-white flex items-center gap-2">
            <Filter className="w-4 h-4 text-primary" />Alert rows
            {rowsQuery.data && (
              <span className="text-xs text-muted-foreground font-normal">
                ({rowsQuery.data.total.toLocaleString()} match{rowsQuery.data.total === 1 ? "" : "es"}
                {rowsQuery.data.total > rowsQuery.data.rows.length ? `, showing first ${rowsQuery.data.rows.length}` : ""})
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
            <Input
              type="text"
              inputMode="numeric"
              placeholder="Tournament ID"
              value={tournamentFilter}
              onChange={(e) => setTournamentFilter(e.target.value.replace(/[^0-9]/g, ""))}
              className="h-8 w-32 text-xs"
              data-testid="input-tournament-filter"
            />
            <Input
              type="text"
              inputMode="numeric"
              placeholder="Player ID"
              value={playerFilter}
              onChange={(e) => setPlayerFilter(e.target.value.replace(/[^0-9]/g, ""))}
              className="h-8 w-28 text-xs"
              data-testid="input-player-filter"
            />
            <Input
              type="text"
              inputMode="numeric"
              placeholder="Org ID"
              value={organizationFilter}
              onChange={(e) => setOrganizationFilter(e.target.value.replace(/[^0-9]/g, ""))}
              className="h-8 w-24 text-xs"
              data-testid="input-organization-filter"
            />
            <button
              type="button"
              onClick={() => setZeroOnly(z => !z)}
              className={`text-xs px-2.5 py-1 rounded-md border transition-colors ${
                zeroOnly
                  ? "border-amber-500/40 text-amber-400 bg-amber-500/10"
                  : "border-border text-muted-foreground hover:text-white"
              }`}
              data-testid="button-zero-only"
            >
              Silent only
            </button>
            {/*
              Task #1658 — status segmented control. We render it as four
              buttons so the active filter is obvious (a `<select>` would
              hide the available choices behind a click). The order
              matches the dashboard's mental model: most-common first.
            */}
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
            {filtersActive && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setTournamentFilter("");
                  setPlayerFilter("");
                  setOrganizationFilter("");
                  setZeroOnly(false);
                  setStatusFilter("all");
                }}
                data-testid="button-clear-filters"
              >
                <X className="w-3.5 h-3.5 mr-1" />Clear
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              asChild
              data-testid="button-download-csv"
            >
              <a href={csvHref} download>
                <Download className="w-3.5 h-3.5 mr-1" />Download CSV
              </a>
            </Button>
          </div>
        </div>

        {rowsQuery.isLoading && !rowsQuery.data ? (
          <div className="flex justify-center py-8"><Loader2 className="w-5 h-5 animate-spin text-primary" /></div>
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
                  <th className="py-1.5 pr-2 font-medium w-6"></th>
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
                {rowsQuery.data.rows.flatMap((row) => {
                  const isExpanded = expandedAlertIds.has(row.id);
                  const baseRow = (
                    <tr
                      key={`row-${row.id}`}
                      className={`border-b border-border/50 ${isExpanded ? "" : "last:border-0"} ${row.zeroDelivery ? "bg-amber-500/5" : ""}`}
                      data-testid={`row-alert-${row.id}`}
                    >
                      <td className="py-1.5 pr-2 align-top">
                        <button
                          type="button"
                          onClick={() => toggleAlertExpanded(row.id)}
                          className="text-muted-foreground hover:text-white transition-colors p-0.5 -ml-0.5 rounded"
                          aria-label={isExpanded ? "Hide silent recipients" : "Show silent recipients"}
                          data-testid={`button-expand-alert-${row.id}`}
                        >
                          {isExpanded
                            ? <ChevronDown className="w-3.5 h-3.5" />
                            : <ChevronRight className="w-3.5 h-3.5" />}
                        </button>
                      </td>
                      <td className="py-1.5 pr-3 text-white whitespace-nowrap">{new Date(row.sentAt).toLocaleString()}</td>
                      <td className="py-1.5 pr-3 text-white">
                        <button
                          type="button"
                          className="hover:text-primary transition-colors text-left"
                          onClick={() => setTournamentFilter(String(row.tournamentId))}
                        >
                          {row.tournamentName ?? `#${row.tournamentId}`}
                        </button>
                        {row.organizationName && (
                          <p className="text-[10px] text-muted-foreground">{row.organizationName}</p>
                        )}
                      </td>
                      <td className="py-1.5 pr-3 text-white">
                        <button
                          type="button"
                          className="hover:text-primary transition-colors text-left"
                          onClick={() => setPlayerFilter(String(row.playerId))}
                        >
                          {row.playerName ?? `#${row.playerId}`}
                        </button>
                      </td>
                      <td className="py-1.5 pr-3 text-muted-foreground text-right">{row.round}</td>
                      <td className="py-1.5 pr-3 text-muted-foreground text-right font-mono">{row.manualPct.toFixed(1)}%</td>
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
                      {/*
                        Task #1658 — the Status cell now distinguishes
                        four shapes:
                          - status='sent' + zeroDelivery → "silent"
                            (existing semantic: fired but reached nobody).
                          - status='sent' + delivered    → "delivered".
                          - status='skipped'             → "skipped" + reason
                            (org_muted / below_threshold / …).
                          - status='failed'              → "failed" + reason.
                      */}
                      <td className="py-1.5">
                        {row.status === "sent" ? (
                          row.zeroDelivery ? (
                            <Badge variant="outline" className="text-amber-400 border-amber-500/30">silent</Badge>
                          ) : (
                            <Badge variant="outline" className="text-emerald-400 border-emerald-500/30">delivered</Badge>
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
                  );
                  if (!isExpanded) return [baseRow];
                  return [
                    baseRow,
                    <tr
                      key={`expand-${row.id}`}
                      className="border-b border-border/50 last:border-0 bg-muted/20"
                      data-testid={`row-alert-${row.id}-expanded`}
                    >
                      <td></td>
                      <td colSpan={9} className="py-3 pr-3">
                        <SilentRecipientsPanel alertId={row.id} />
                      </td>
                    </tr>,
                  ];
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {summary?.generatedAt && (
        <p className="text-xs text-muted-foreground text-right">
          Summary generated {new Date(summary.generatedAt).toLocaleString()}
        </p>
      )}
    </div>
  );
}

// Task #1665 — surfaces "Last paged: <when> — <breach kinds> — <N
// recipients>" so super-admins can tell whether on-call has already
// been notified about a current outage. Only renders when at least
// one row exists in `manual_entry_alert_page_history`; while the
// query is in-flight or errors out we collapse to a single line that
// still gives ops a hint that the data is loading / unavailable
// rather than silently disappearing the whole banner.
// Task #2078 — render the relative future delta until `iso` ("in 1h
// 12m"), mirroring `formatRelative` for past timestamps. Returns
// "now" for any non-positive delta so a stale cooldown that just
// expired between the server response and render reads sensibly.
function formatRelativeFuture(iso: string, now = Date.now()): string {
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return iso;
  const diffMs = ts - now;
  if (diffMs <= 0) return "now";
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return `in ${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `in ${min}m`;
  const hr = Math.floor(min / 60);
  const remM = min % 60;
  if (hr < 24) return remM > 0 ? `in ${hr}h ${remM}m` : `in ${hr}h`;
  const day = Math.floor(hr / 24);
  const remH = hr % 24;
  return remH > 0 ? `in ${day}d ${remH}h` : `in ${day}d`;
}

function PageHistoryBanner({
  query,
  cooldownStatus,
  expanded,
  onToggleExpanded,
}: {
  query: ReturnType<typeof useQuery<PageHistoryResponse, Error>>;
  cooldownStatus: CooldownStatusResponse | undefined;
  expanded: boolean;
  onToggleExpanded: () => void;
}) {
  if (query.isLoading && !query.data) {
    return (
      <div
        className="flex items-center gap-2 text-xs text-muted-foreground bg-card border border-border rounded-xl px-4 py-2"
        data-testid="banner-page-history-loading"
      >
        <Loader2 className="w-3.5 h-3.5 animate-spin" />
        Loading on-call page history…
      </div>
    );
  }
  if (query.error && !query.data) {
    return (
      <div
        className="flex items-start gap-2 text-xs text-amber-400 bg-amber-500/10 border border-amber-500/30 rounded-xl px-4 py-2"
        data-testid="banner-page-history-error"
      >
        <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
        <span>Couldn’t load on-call page history: {query.error.message}</span>
      </div>
    );
  }
  const rows = query.data?.rows ?? [];
  if (rows.length === 0) {
    return (
      <div
        className="flex items-center gap-2 text-xs text-muted-foreground bg-card border border-border rounded-xl px-4 py-2"
        data-testid="banner-page-history-empty"
      >
        <PhoneCall className="w-3.5 h-3.5 text-muted-foreground" />
        On-call has not been auto-paged about manual-entry alert health yet.
      </div>
    );
  }
  const latest = rows[0];
  const breachLabels = latest.breachKinds.length === 0
    ? ["unspecified"]
    : latest.breachKinds.map((k) => BREACH_KIND_LABEL[k] ?? k);
  const recipientLabel = `${latest.recipientCount} recipient${latest.recipientCount === 1 ? "" : "s"}`;
  const absolute = new Date(latest.pagedAt).toLocaleString();
  // Task #2078 — only render the cooldown-active pill when the API
  // tells us BOTH conditions hold (inside the cooldown window AND a
  // breach is currently firing). Server-side gating keeps the UI logic
  // trivial and lets us evolve the breach evaluator without touching
  // the dashboard.
  const cooldownPillBreachLabels =
    cooldownStatus && cooldownStatus.active
      ? cooldownStatus.breachKinds.length === 0
        ? ["unspecified"]
        : cooldownStatus.breachKinds.map((k) => BREACH_KIND_LABEL[k] ?? k)
      : [];
  return (
    <div
      className="bg-amber-500/10 border border-amber-500/30 rounded-xl"
      data-testid="banner-page-history"
      data-test-page={latest.isTest ? "true" : "false"}
    >
      <div className="flex items-start gap-3 p-3 flex-wrap">
        <PhoneCall className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap text-sm text-amber-100">
            <span className="font-semibold">
              {latest.isTest ? "Last test page sent:" : "Last paged on-call:"}
            </span>
            {/* Task #2079 — distinguish synthetic test pages so a wiring
                check doesn't read as a real outage notification. */}
            {latest.isTest && (
              <Badge
                variant="outline"
                className="border-sky-400/60 bg-sky-500/15 text-sky-200 text-[10px] uppercase tracking-wide px-1.5 py-0"
                data-testid="badge-page-history-test"
              >
                Test
              </Badge>
            )}
            <span data-testid="text-page-history-when" title={absolute}>
              {formatRelative(latest.pagedAt)}
            </span>
            <span className="text-amber-300/60">·</span>
            <span data-testid="text-page-history-breaches">
              {breachLabels.join(", ")} breach{breachLabels.length === 1 ? "" : "es"}
            </span>
            <span className="text-amber-300/60">·</span>
            <span data-testid="text-page-history-recipients">{recipientLabel}</span>
          </div>
          {cooldownStatus && cooldownStatus.active && cooldownStatus.nextPageEligibleAt && (
            <div
              className="mt-1.5 inline-flex items-center gap-1.5 rounded-md bg-amber-500/20 border border-amber-500/40 text-amber-100 text-[11px] font-medium px-2 py-0.5"
              data-testid="pill-cooldown-active"
              title={new Date(cooldownStatus.nextPageEligibleAt).toLocaleString()}
            >
              <AlertCircle className="w-3 h-3" />
              <span data-testid="text-cooldown-active-label">
                Cooldown active — {cooldownPillBreachLabels.join(", ")} breach{cooldownPillBreachLabels.length === 1 ? "" : "es"} would page on-call, suppressed.
              </span>
              <span className="text-amber-200/80">·</span>
              <span data-testid="text-cooldown-next-eligible">
                Next page eligible {formatRelativeFuture(cooldownStatus.nextPageEligibleAt)}
              </span>
            </div>
          )}
          <p className="text-[11px] text-amber-200/70 mt-0.5">
            Cooldown {latest.cooldownHours}h ·{" "}
            7d delivery {latest.anyDeliveryRate7d.toFixed(1)}% (threshold {latest.thresholdPct}%, {latest.zeroDeliveryCount7d} silent of {latest.alertCount7d})
          </p>
        </div>
        <button
          type="button"
          onClick={onToggleExpanded}
          className="text-xs text-amber-300 hover:text-amber-200 underline-offset-2 hover:underline shrink-0"
          data-testid="button-toggle-page-history"
        >
          {expanded ? "Hide history" : `View history (${rows.length})`}
        </button>
      </div>
      {expanded && (
        <div className="border-t border-amber-500/30 p-3 space-y-2" data-testid="list-page-history">
          {rows.map((row, idx) => {
            const labels = row.breachKinds.length === 0
              ? ["unspecified"]
              : row.breachKinds.map((k) => BREACH_KIND_LABEL[k] ?? k);
            return (
              <div
                key={row.id}
                className="flex items-start justify-between gap-3 text-xs text-amber-100/90 border-b border-amber-500/20 last:border-0 pb-2 last:pb-0"
                data-testid={`row-page-history-${idx}`}
                data-test-page={row.isTest ? "true" : "false"}
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium" title={new Date(row.pagedAt).toLocaleString()}>
                      {formatRelative(row.pagedAt)}
                    </span>
                    {/* Task #2079 — surface synthetic test rows so they
                        don't get conflated with real on-call pages. */}
                    {row.isTest && (
                      <Badge
                        variant="outline"
                        className="border-sky-400/60 bg-sky-500/15 text-sky-200 text-[9px] uppercase tracking-wide px-1 py-0"
                        data-testid={`badge-row-page-history-test-${idx}`}
                      >
                        Test
                      </Badge>
                    )}
                    <span className="text-amber-300/60">·</span>
                    <span>{labels.join(", ")}</span>
                    <span className="text-amber-300/60">·</span>
                    <span>{row.recipientCount} recipient{row.recipientCount === 1 ? "" : "s"}</span>
                  </div>
                  {row.recipientEmails.length > 0 && (
                    <p className="text-[10px] text-amber-200/60 mt-0.5 break-all">
                      {row.recipientEmails.join(", ")}
                    </p>
                  )}
                </div>
                <div className="text-[10px] text-amber-200/60 shrink-0 text-right">
                  <div>7d {row.anyDeliveryRate7d.toFixed(1)}%</div>
                  <div>{row.zeroDeliveryCount7d}/{row.alertCount7d} silent</div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function WindowCard({ label, data }: { label: "7d" | "30d"; data: AlertWindow }) {
  return (
    <div className="bg-card border border-border rounded-xl p-5" data-testid={`panel-window-${label}`}>
      <h2 className="text-sm font-semibold text-white mb-4">
        Last {label === "7d" ? "7 days" : "30 days"}
      </h2>
      <div className="grid grid-cols-2 lg:grid-cols-6 gap-3">
        <Stat label="Alerts fired" value={data.alertCount.toLocaleString()} testId={`stat-alerts-${label}`} />
        <Stat label="Push delivery" value={`${data.pushDeliveryRate.toFixed(1)}%`} sub={`${data.pushSentTotal}/${data.pushAttemptedTotal} sent`} testId={`stat-push-${label}`} />
        <Stat label="Email delivery" value={`${data.emailDeliveryRate.toFixed(1)}%`} sub={`${data.emailSentTotal}/${data.emailAttemptedTotal} sent`} testId={`stat-email-${label}`} />
        <Stat label="Any channel" value={`${data.anyDeliveryRate.toFixed(1)}%`} testId={`stat-any-${label}`} />
        <Stat
          label="Silent alerts"
          value={data.zeroDeliveryCount.toLocaleString()}
          accent={data.zeroDeliveryCount > 0 ? "amber" : undefined}
          testId={`stat-zero-${label}`}
        />
        <Stat
          label="Silent recipients"
          value={data.silentRecipientTotal.toLocaleString()}
          sub="recipient slots that got nothing"
          accent={data.silentRecipientTotal > 0 ? "amber" : undefined}
          testId={`stat-silent-recipients-${label}`}
        />
      </div>
    </div>
  );
}

function SilentRecipientsPanel({ alertId }: { alertId: number }) {
  // Lazy-loaded: only fetched when the row is expanded.
  const { data, isLoading, error } = useQuery<SilentRecipientsResponse, Error>({
    queryKey: ["/api/super-admin/manual-entry-alerts/silent-recipients", alertId],
    queryFn: async () => {
      const r = await fetch(`/api/super-admin/manual-entry-alerts/${alertId}/silent-recipients`);
      if (!r.ok) {
        const text = await r.text().catch(() => "");
        throw new Error(`Failed to load (${r.status}${text ? `: ${text.slice(0, 120)}` : ""})`);
      }
      return r.json();
    },
    staleTime: 30000,
    retry: 1,
  });

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground" data-testid={`silent-recipients-loading-${alertId}`}>
        <Loader2 className="w-3.5 h-3.5 animate-spin" />Loading silent recipients…
      </div>
    );
  }
  if (error) {
    return (
      <div
        className="flex items-start gap-2 text-xs text-red-400"
        data-testid={`silent-recipients-error-${alertId}`}
      >
        <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
        <span>{error.message}</span>
      </div>
    );
  }
  if (!data) return null;

  if (data.totalRecipientRows === 0) {
    // Pre-Task #1386 alerts don't have per-recipient rows yet — be honest
    // about that rather than silently showing an empty "all delivered" UI.
    return (
      <p className="text-xs text-muted-foreground" data-testid={`silent-recipients-empty-${alertId}`}>
        No per-recipient delivery records exist for this alert (likely fired before per-recipient tracking was enabled).
      </p>
    );
  }

  if (data.silentRecipients.length === 0) {
    return (
      <p className="text-xs text-emerald-400" data-testid={`silent-recipients-all-delivered-${alertId}`}>
        All {data.totalRecipientRows} recipient delivery attempts succeeded.
      </p>
    );
  }

  // Task #1670: collapse the per-(user, channel) failures into one row per
  // person so ops sees the unique-people problem at a glance. A user who got
  // nothing on push *and* nothing on email is one row with two channel badges.
  const groups = groupSilentRecipientsByUser(data.silentRecipients);

  // Task #2075 — a group is "all reconstructed" when every failure row
  // belonging to that user originated from the Task #1672 backfill.
  // Renders a row-level pill so ops sees the provenance at the user
  // level even before expanding the per-channel failures, and dims the
  // row slightly so it's visually distinct from real per-user data.
  const groupIsReconstructed = (g: GroupedSilentRecipient): boolean =>
    g.failures.length > 0 && g.failures.every((f) => f.reconstructed);

  return (
    <div className="space-y-2" data-testid={`silent-recipients-list-${alertId}`}>
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
          Silent recipients ({groups.length} {groups.length === 1 ? "person" : "people"},{" "}
          {data.silentRecipients.length} of {data.totalRecipientRows} attempts failed)
        </p>
        {/* Task #2075 — CSV export carries the same `reconstructed` flag
            so off-dashboard analyses (spreadsheet, BI, ad-hoc grep)
            don't lose the provenance signal. */}
        <a
          href={`/api/super-admin/manual-entry-alerts/${alertId}/silent-recipients.csv`}
          download
          className="inline-flex items-center gap-1 text-[10px] text-muted-foreground hover:text-white underline-offset-2 hover:underline"
          data-testid={`silent-recipients-csv-${alertId}`}
        >
          <Download className="w-3 h-3" />Download CSV
        </a>
      </div>
      <ul className="space-y-1.5">
        {groups.map((g, idx) => {
          const name = g.displayName || g.username || (g.userId != null ? `User #${g.userId}` : "Unknown user");
          const reconstructed = groupIsReconstructed(g);
          return (
            <li
              key={`${alertId}-${g.key}`}
              className={`rounded-md bg-card/60 border border-border/50 px-2.5 py-1.5${reconstructed ? " opacity-75" : ""}`}
              data-testid={`silent-recipient-${alertId}-${idx}`}
              data-user-id={g.userId ?? ""}
              data-reconstructed={reconstructed ? "true" : "false"}
            >
              <div className="flex items-center gap-1.5 text-white flex-wrap">
                <UserRound className="w-3 h-3 text-muted-foreground shrink-0" />
                <span className="truncate">{name}</span>
                {g.email && (
                  <span className="text-[10px] text-muted-foreground truncate">({g.email})</span>
                )}
                {reconstructed && (
                  <Badge
                    variant="outline"
                    className="text-[10px] text-slate-300 border-slate-500/40 bg-slate-500/10 shrink-0"
                    title={RECONSTRUCTED_TOOLTIP}
                    data-testid={`silent-recipient-reconstructed-${alertId}-${idx}`}
                  >
                    reconstructed — best-effort attribution
                  </Badge>
                )}
              </div>
              {/* Pair each channel badge with its own error message so it's
                  unambiguous which channel produced which error. */}
              <ul className="mt-1 space-y-1 pl-4">
                {g.failures.map((f, fIdx) => (
                  <li
                    key={`${f.channel}-${fIdx}`}
                    className="flex items-start gap-2 flex-wrap"
                    data-testid={`silent-recipient-failure-${alertId}-${idx}-${f.channel}`}
                    data-reconstructed={f.reconstructed ? "true" : "false"}
                  >
                    <Badge
                      variant="outline"
                      className="text-amber-400 border-amber-500/30 shrink-0 inline-flex items-center gap-1"
                      data-testid={`silent-recipient-status-${alertId}-${idx}-${f.channel}`}
                    >
                      {f.channel === "push"
                        ? <Smartphone className="w-3 h-3" />
                        : <Mail className="w-3 h-3" />}
                      <span>{f.channel}: {f.status}</span>
                    </Badge>
                    {f.errorMessage && !f.reconstructed && (
                      <span
                        className="text-[10px] text-red-300 break-all"
                        data-testid={`silent-recipient-error-${alertId}-${idx}-${f.channel}`}
                      >
                        {f.errorMessage}
                      </span>
                    )}
                    {f.reconstructed && (
                      // Per-channel provenance footnote — explains *why*
                      // there's no real error message and lines up with
                      // the row-level pill so a user reading just one
                      // channel still sees the caveat.
                      <span
                        className="text-[10px] text-slate-400 italic break-words"
                        title={RECONSTRUCTED_TOOLTIP}
                        data-testid={`silent-recipient-reconstructed-note-${alertId}-${idx}-${f.channel}`}
                      >
                        reconstructed — per-user mapping inferred from aggregate counts
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export interface GroupedSilentRecipient {
  key: string;
  userId: number | null;
  displayName: string | null;
  username: string | null;
  email: string | null;
  failures: SilentRecipient[];
}

export type { SilentRecipient };

export function groupSilentRecipientsByUser(recipients: SilentRecipient[]): GroupedSilentRecipient[] {
  // Group per user; everything with a null userId collapses into one
  // "Unknown" bucket so we don't show the same anonymous slot twice.
  const groups = new Map<string, GroupedSilentRecipient>();
  for (const r of recipients) {
    const key = r.userId == null ? "__unknown__" : `u:${r.userId}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        userId: r.userId,
        displayName: r.displayName,
        username: r.username,
        email: r.email,
        failures: [],
      };
      groups.set(key, group);
    } else {
      // Prefer any non-null display info we discover later in the list.
      if (!group.displayName && r.displayName) group.displayName = r.displayName;
      if (!group.username && r.username) group.username = r.username;
      if (!group.email && r.email) group.email = r.email;
    }
    group.failures.push(r);
  }
  // Stable per-channel ordering (push before email) so the badges don't jump
  // around when the API happens to return them in a different order.
  const channelRank: Record<SilentRecipient["channel"], number> = { push: 0, email: 1 };
  for (const g of groups.values()) {
    g.failures.sort((a, b) => channelRank[a.channel] - channelRank[b.channel]);
  }
  // Worst cases first: most failed channels, then by name for stability.
  const list = Array.from(groups.values());
  list.sort((a, b) => {
    if (b.failures.length !== a.failures.length) return b.failures.length - a.failures.length;
    const an = a.displayName || a.username || (a.userId != null ? `User #${a.userId}` : "Unknown user");
    const bn = b.displayName || b.username || (b.userId != null ? `User #${b.userId}` : "Unknown user");
    return an.localeCompare(bn);
  });
  return list;
}

function Stat({ label, value, sub, accent, testId }: { label: string; value: string; sub?: string; accent?: "amber"; testId?: string }) {
  const wrap = accent === "amber"
    ? "bg-amber-500/10 border-amber-500/30"
    : "bg-primary/10 border-primary/20";
  const text = accent === "amber" ? "text-amber-400" : "text-white";
  return (
    <div className={`rounded-xl border p-3 ${wrap}`} data-testid={testId}>
      <p className="text-xs text-muted-foreground mb-1">{label}</p>
      <p className={`text-xl font-bold ${text}`}>{value}</p>
      {sub && <p className="text-[10px] text-muted-foreground mt-0.5">{sub}</p>}
    </div>
  );
}
