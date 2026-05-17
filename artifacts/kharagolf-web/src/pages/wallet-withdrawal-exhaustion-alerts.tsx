// Task #1501 — Admin worklist for wallet-withdrawal alerts whose
// retries gave up. The retry cron in `walletWithdrawalNotify.ts` fires
// a one-shot push to org admins when a notify-attempts row's retries
// exhaust on every channel (or a hard-bounce short-circuits the first
// attempt). That push is easy to dismiss or miss, so this page lists
// every notified-exhausted row that hasn't yet been "manually followed
// up" — admins can read the last error, jump to the affected
// withdrawal, and clear the row off the list once they've reached the
// member out-of-band.
import React, { useMemo } from "react";
import { Link } from "wouter";
import {
  useInfiniteQuery, useMutation, useQuery, useQueryClient,
} from "@tanstack/react-query";
import {
  AlertCircle, AlertTriangle, ArrowUpRight, Bell, Mail, RefreshCw, CheckCircle2,
  UserCheck, ChevronDown, Loader2, Send,
} from "lucide-react";
import { Button } from "@/components/ui/button";

const BASE_URL = (import.meta.env.BASE_URL ?? "/").replace(/\/$/, "");
function API(path: string): string {
  return `${BASE_URL}/api${path}`;
}

interface ExhaustionAlertItem {
  id: number;
  withdrawalId: number;
  organizationId: number;
  userId: number;
  outcome: string;
  amount: number;
  currency: string;
  destination: string;
  utr: string | null;
  reason: string | null;
  createdAt: string;
  adminExhaustionNotifiedAt: string;
  recipientName: string | null;
  recipientEmail: string | null;
  emailStatus: string | null;
  emailAttempts: number;
  lastEmailAt: string | null;
  lastEmailError: string | null;
  emailRetryExhaustedAt: string | null;
  pushStatus: string | null;
  pushAttempts: number;
  lastPushAt: string | null;
  lastPushError: string | null;
  pushRetryExhaustedAt: string | null;
  lastError: string | null;
  // Task #1856 — populated for rows where an admin marked the alert
  // as followed up. Always sent by the API; null on un-acked rows.
  adminFollowupAcknowledgedAt: string | null;
  adminFollowupAcknowledgedBy: number | null;
  acknowledgedByName: string | null;
}

interface ExhaustionAlertResponse {
  items: ExhaustionAlertItem[];
  count: number;
  status?: "open" | "acknowledged" | "all";
  days?: number;
  // Task #1858 — pagination metadata. `total` is the full count of
  // rows matching the filter (independent of page size). `nextCursor`
  // is non-null while there are more rows to fetch, or null on the
  // last page.
  total?: number;
  limit?: number;
  nextCursor?: string | null;
}

interface MeResponse {
  role?: string;
  organizationId?: number | null;
}

const ADMIN_ROLES = new Set(["org_admin", "tournament_director", "super_admin"]);

function formatMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(2)}`;
  }
}

function outcomeLabel(o: string): string {
  if (o === "processed") return "paid";
  if (o === "reversed") return "reversed";
  return "failed";
}

// Task #1856 — render-only card for rows that have already been
// marked as followed up. Shares the same shape as `AlertRow` so the
// audit feed visually echoes the worklist, but swaps the action
// button for an audit stamp ("Followed up by … · timestamp"). Kept
// separate from `AlertRow` so the worklist component stays focused on
// the still-actionable case.
function AcknowledgedAlertRow({ item }: { item: ExhaustionAlertItem }) {
  const emailExhausted = !!item.emailRetryExhaustedAt;
  const pushExhausted = !!item.pushRetryExhaustedAt;
  const acknowledgedAt = item.adminFollowupAcknowledgedAt
    ? new Date(item.adminFollowupAcknowledgedAt)
    : null;
  const acknowledgedByLabel = item.acknowledgedByName
    ?? (item.adminFollowupAcknowledgedBy != null
      ? `Admin #${item.adminFollowupAcknowledgedBy}`
      : "an admin");
  return (
    <div
      className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-4 space-y-3"
      data-testid={`row-ack-exhaustion-alert-${item.id}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span data-testid={`text-ack-exhaustion-notified-at-${item.id}`}>
              Alerted {new Date(item.adminExhaustionNotifiedAt).toLocaleString()}
            </span>
          </div>
          <p
            className="text-sm font-semibold text-white truncate mt-1"
            data-testid={`text-ack-exhaustion-recipient-${item.id}`}
          >
            {item.recipientName ?? `Member #${item.userId}`}
          </p>
          <p className="text-xs text-muted-foreground">
            Withdrawal{" "}
            <Link
              href={`/member-360/${item.userId}#wallet`}
              className="text-sky-300 hover:text-sky-200 inline-flex items-center gap-1"
              data-testid={`link-ack-exhaustion-withdrawal-${item.id}`}
            >
              #{item.withdrawalId} <ArrowUpRight className="w-3 h-3" />
            </Link>
            {" "}· {outcomeLabel(item.outcome)} · {item.destination}
            {item.utr ? ` · UTR ${item.utr}` : ""}
          </p>
        </div>
        <span className="text-base font-semibold text-emerald-200 whitespace-nowrap">
          {formatMoney(item.amount, item.currency)}
        </span>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {emailExhausted && (
          <span
            className="inline-flex items-center gap-1 rounded-md border border-white/10 bg-white/5 px-2 py-0.5 text-[11px] text-white/70"
            data-testid={`badge-ack-exhaustion-email-${item.id}`}
          >
            <Mail className="w-3 h-3" /> Email exhausted ({item.emailAttempts})
          </span>
        )}
        {pushExhausted && (
          <span
            className="inline-flex items-center gap-1 rounded-md border border-white/10 bg-white/5 px-2 py-0.5 text-[11px] text-white/70"
            data-testid={`badge-ack-exhaustion-push-${item.id}`}
          >
            <Bell className="w-3 h-3" /> Push exhausted ({item.pushAttempts})
          </span>
        )}
        {item.recipientEmail && (
          <span className="inline-flex items-center gap-1 rounded-md border border-white/10 bg-white/5 px-2 py-0.5 text-[11px] text-white/70">
            <Mail className="w-3 h-3" /> {item.recipientEmail}
          </span>
        )}
      </div>

      {/*
        Audit stamp — the whole point of Task #1856. Surfaces *who*
        marked the alert as followed up and *when*, so a manager
        scanning the feed can see at a glance that the row has been
        handled (and by whom) before reaching out themselves.
      */}
      <div
        className="flex items-center gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-100"
        data-testid={`text-ack-followup-${item.id}`}
      >
        <UserCheck className="w-4 h-4 text-emerald-300 shrink-0" aria-hidden />
        <span>
          Followed up by{" "}
          <span
            className="font-medium text-white"
            data-testid={`text-ack-followup-name-${item.id}`}
          >
            {acknowledgedByLabel}
          </span>
          {acknowledgedAt && (
            <>
              {" · "}
              <time
                dateTime={item.adminFollowupAcknowledgedAt ?? undefined}
                data-testid={`text-ack-followup-at-${item.id}`}
              >
                {acknowledgedAt.toLocaleString()}
              </time>
            </>
          )}
        </span>
      </div>
    </div>
  );
}

function AlertRow({
  item, onAcknowledge, isAcknowledging, onRetry, isRetrying,
}: {
  item: ExhaustionAlertItem;
  onAcknowledge: (id: number) => void;
  isAcknowledging: boolean;
  onRetry: (id: number) => void;
  isRetrying: boolean;
}) {
  const emailExhausted = !!item.emailRetryExhaustedAt;
  const pushExhausted = !!item.pushRetryExhaustedAt;
  // Retry only makes sense when at least one channel is in the
  // exhausted state — that's the precondition the helper checks
  // (`emailEligible || pushEligible`). Surfacing the button when no
  // channel is eligible would be a no-op so we hide it instead.
  const canRetry = emailExhausted || pushExhausted;
  return (
    <div
      className="rounded-lg border border-white/10 bg-black/30 p-4 space-y-3"
      data-testid={`row-exhaustion-alert-${item.id}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span data-testid={`text-exhaustion-notified-at-${item.id}`}>
              Alerted {new Date(item.adminExhaustionNotifiedAt).toLocaleString()}
            </span>
          </div>
          <p
            className="text-sm font-semibold text-white truncate mt-1"
            data-testid={`text-exhaustion-recipient-${item.id}`}
          >
            {item.recipientName ?? `Member #${item.userId}`}
          </p>
          <p className="text-xs text-muted-foreground">
            Withdrawal{" "}
            <Link
              href={`/member-360/${item.userId}#wallet`}
              className="text-sky-300 hover:text-sky-200 inline-flex items-center gap-1"
              data-testid={`link-exhaustion-withdrawal-${item.id}`}
            >
              #{item.withdrawalId} <ArrowUpRight className="w-3 h-3" />
            </Link>
            {" "}· {outcomeLabel(item.outcome)} · {item.destination}
            {item.utr ? ` · UTR ${item.utr}` : ""}
          </p>
        </div>
        <span className="text-base font-semibold text-amber-300 whitespace-nowrap">
          {formatMoney(item.amount, item.currency)}
        </span>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {emailExhausted && (
          <span
            className="inline-flex items-center gap-1 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-200"
            data-testid={`badge-exhaustion-email-${item.id}`}
          >
            <Mail className="w-3 h-3" /> Email exhausted ({item.emailAttempts})
          </span>
        )}
        {pushExhausted && (
          <span
            className="inline-flex items-center gap-1 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-200"
            data-testid={`badge-exhaustion-push-${item.id}`}
          >
            <Bell className="w-3 h-3" /> Push exhausted ({item.pushAttempts})
          </span>
        )}
        {item.recipientEmail && (
          <span className="inline-flex items-center gap-1 rounded-md border border-white/10 bg-white/5 px-2 py-0.5 text-[11px] text-white/70">
            <Mail className="w-3 h-3" /> {item.recipientEmail}
          </span>
        )}
      </div>

      {item.lastError && (
        <div
          className="rounded-md border border-red-500/20 bg-red-500/5 px-3 py-2 text-[11px] text-red-200/90 font-mono break-all"
          data-testid={`text-exhaustion-last-error-${item.id}`}
        >
          {item.lastError}
        </div>
      )}

      <div className="flex justify-end gap-2">
        {/*
          Task #1857 — Retry delivery. Re-runs the wallet withdrawal
          notify pipeline (with the existing per-channel guards), and
          on a successful re-dispatch the row drops off the worklist
          (matches the "row drops off (just like acknowledge)"
          contract). Hidden when no channel is in the exhausted state
          since the API helper would no-op anyway.
        */}
        {canRetry && (
          <Button
            size="sm"
            variant="outline"
            className="border-sky-500/40 bg-sky-500/10 text-sky-200 hover:bg-sky-500/20 hover:text-sky-100"
            onClick={() => onRetry(item.id)}
            disabled={isRetrying || isAcknowledging}
            data-testid={`button-retry-delivery-${item.id}`}
          >
            <Send className={`w-4 h-4 mr-1.5 ${isRetrying ? "animate-pulse" : ""}`} />
            Retry delivery
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          className="border-emerald-500/40 bg-emerald-500/10 text-emerald-200 hover:bg-emerald-500/20 hover:text-emerald-100"
          onClick={() => onAcknowledge(item.id)}
          disabled={isAcknowledging || isRetrying}
          data-testid={`button-mark-followed-up-${item.id}`}
        >
          <CheckCircle2 className="w-4 h-4 mr-1.5" />
          Mark followed up
        </Button>
      </div>
    </div>
  );
}

export default function WalletWithdrawalExhaustionAlertsPage() {
  const queryClient = useQueryClient();

  const { data: me, isLoading: meLoading, status: meStatus } = useQuery<MeResponse | null>({
    queryKey: ["/api/auth/me"],
    queryFn: async () => {
      const res = await fetch(API("/auth/me"), { credentials: "include" });
      if (res.status === 401) return null;
      if (!res.ok) throw new Error(`Auth lookup failed (HTTP ${res.status})`);
      return (await res.json()) as MeResponse;
    },
    retry: false,
    staleTime: 5 * 60_000,
  });

  const isAdmin = !!me && ADMIN_ROLES.has(me.role ?? "");
  const orgId = me?.organizationId ?? null;

  // Task #1858 — page size matches the API default. Kept small enough
  // that the initial render stays responsive; admins working through a
  // backlog can keep clicking "Load more" to walk the entire queue.
  const PAGE_SIZE = 50;

  const queryKey = useMemo(
    () => ["/api/admin/wallet-withdrawal-exhaustion-alerts", orgId, "open"] as const,
    [orgId],
  );

  // Task #1856 — second query that pulls the recently-acknowledged
  // slice of the same audit table so the page can render an audit
  // feed below the worklist showing who marked each alert as followed
  // up. Bounded to 30 days server-side; the page presents that as
  // "Recently followed up" so the framing is unambiguous.
  const ACK_HISTORY_DAYS = 30;
  const ackQueryKey = useMemo(
    () => ["/api/admin/wallet-withdrawal-exhaustion-alerts", orgId, "acknowledged", ACK_HISTORY_DAYS] as const,
    [orgId],
  );

  // Task #1858 — both lists are paginated server-side, so we use an
  // infinite query for each. The "Load more" button at the bottom of
  // each list calls `fetchNextPage` until `hasNextPage` is false.
  const {
    data, isLoading, isError, error, refetch, isFetching,
    fetchNextPage, hasNextPage, isFetchingNextPage,
  } = useInfiniteQuery<ExhaustionAlertResponse, Error>({
    queryKey,
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }) => {
      const params = new URLSearchParams({
        organizationId: String(orgId),
        limit: String(PAGE_SIZE),
      });
      if (typeof pageParam === "string" && pageParam) {
        params.set("cursor", pageParam);
      }
      const res = await fetch(
        API(`/admin/wallet-withdrawal-exhaustion-alerts?${params.toString()}`),
        { credentials: "include" },
      );
      if (res.status === 401) throw new Error("Sign in required to view exhausted wallet alerts.");
      if (res.status === 403) throw new Error("Admin role required to view exhausted wallet alerts.");
      if (!res.ok) throw new Error(`Request failed (HTTP ${res.status})`);
      return res.json() as Promise<ExhaustionAlertResponse>;
    },
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? null,
    enabled: isAdmin && !!orgId,
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
  });

  const {
    data: ackData,
    isLoading: ackIsLoading,
    isError: ackIsError,
    error: ackQueryError,
    refetch: refetchAck,
    fetchNextPage: fetchNextAckPage,
    hasNextPage: hasNextAckPage,
    isFetchingNextPage: isFetchingNextAckPage,
  } = useInfiniteQuery<ExhaustionAlertResponse, Error>({
    queryKey: ackQueryKey,
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }) => {
      const params = new URLSearchParams({
        organizationId: String(orgId),
        status: "acknowledged",
        days: String(ACK_HISTORY_DAYS),
        limit: String(PAGE_SIZE),
      });
      if (typeof pageParam === "string" && pageParam) {
        params.set("cursor", pageParam);
      }
      const res = await fetch(
        API(`/admin/wallet-withdrawal-exhaustion-alerts?${params.toString()}`),
        { credentials: "include" },
      );
      if (res.status === 401) throw new Error("Sign in required to view followed-up wallet alerts.");
      if (res.status === 403) throw new Error("Admin role required to view followed-up wallet alerts.");
      if (!res.ok) throw new Error(`Request failed (HTTP ${res.status})`);
      return res.json() as Promise<ExhaustionAlertResponse>;
    },
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? null,
    enabled: isAdmin && !!orgId,
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
  });

  const ackMutation = useMutation({
    mutationFn: async (attemptId: number) => {
      const res = await fetch(
        API(`/admin/wallet-withdrawal-exhaustion-alerts/${attemptId}/acknowledge`),
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
        },
      );
      if (!res.ok) {
        let body: { error?: string } = {};
        try { body = (await res.json()) as { error?: string }; } catch { /* ignore */ }
        throw new Error(body.error ?? `Request failed (HTTP ${res.status})`);
      }
      return (await res.json()) as { acknowledgedAt: string };
    },
    onSuccess: () => {
      // Refresh both the worklist (the row should disappear from it)
      // and the audit feed (the row should appear in it with the
      // current admin's name) so the page reflects the new state
      // without a manual refresh.
      void queryClient.invalidateQueries({ queryKey });
      void queryClient.invalidateQueries({ queryKey: ackQueryKey });
    },
  });

  // Task #1857 — retry mutation. Hits the new
  // /retry endpoint which re-runs the wallet withdrawal notify
  // pipeline (respecting the per-channel guards) and, on a successful
  // re-dispatch, server-side stamps `adminFollowupAcknowledgedAt`
  // so the row drops off the worklist. We refresh the same two
  // queries the ack mutation does so the UI converges either way:
  //   - successful retry → row gone from worklist, audit row appears
  //   - no-op retry      → row stays, but the lastError / attempts
  //                        snapshot updates on next refetch
  const retryMutation = useMutation<
    { anySent: boolean; acknowledgedAt: string | null },
    Error,
    number
  >({
    mutationFn: async (attemptId: number) => {
      const res = await fetch(
        API(`/admin/wallet-withdrawal-exhaustion-alerts/${attemptId}/retry`),
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
        },
      );
      if (!res.ok) {
        let body: { error?: string } = {};
        try { body = (await res.json()) as { error?: string }; } catch { /* ignore */ }
        throw new Error(body.error ?? `Request failed (HTTP ${res.status})`);
      }
      return (await res.json()) as { anySent: boolean; acknowledgedAt: string | null };
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey });
      void queryClient.invalidateQueries({ queryKey: ackQueryKey });
    },
  });

  if (meLoading) {
    return (
      <div className="p-6" data-testid="wallet-withdrawal-exhaustion-alerts-page">
        <div className="text-sm text-muted-foreground">Loading…</div>
      </div>
    );
  }

  if (!isAdmin) {
    let title = "Failed wallet alert deliveries";
    let body =
      "You need an organization, tournament-director, or super-admin role to view this page.";
    let testId = "wallet-withdrawal-exhaustion-no-access";
    if (meStatus === "error") {
      title = "Couldn't verify your access";
      body = "We couldn't reach the authentication service to check your role. Please refresh in a moment.";
      testId = "wallet-withdrawal-exhaustion-auth-error";
    } else if (!me) {
      title = "Sign in required";
      body = "You need to sign in to view failed wallet alert deliveries.";
      testId = "wallet-withdrawal-exhaustion-signin-required";
    }
    return (
      <div className="p-6" data-testid="wallet-withdrawal-exhaustion-alerts-page">
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

  // Task #1858 — flatten pages from the infinite query so render code
  // can keep treating `items` as a single array. `total` is taken from
  // the most recent page (every page reports the same up-to-date count
  // for its filter), and falls back to the loaded length when the
  // server hasn't sent it yet (older clients during a deploy).
  const items = useMemo(
    () => data?.pages.flatMap(p => p.items) ?? [],
    [data],
  );
  const ackItems = useMemo(
    () => ackData?.pages.flatMap(p => p.items) ?? [],
    [ackData],
  );
  const totalOpen = data?.pages[data.pages.length - 1]?.total ?? items.length;
  const totalAck = ackData?.pages[ackData.pages.length - 1]?.total ?? ackItems.length;
  const ackingId = ackMutation.isPending ? ackMutation.variables ?? null : null;
  const retryingId = retryMutation.isPending ? retryMutation.variables ?? null : null;

  return (
    <div className="p-6 space-y-6" data-testid="wallet-withdrawal-exhaustion-alerts-page">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Failed wallet alert deliveries
          </h1>
          <p className="text-sm text-muted-foreground mt-1 max-w-3xl">
            Wallet-withdrawal confirmations whose email and/or push retries gave up.
            Each row is the same alert that was pushed to admins once when retries
            exhausted — you can review the affected withdrawal, copy the member's
            email, and dismiss the row once you've reached out manually.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => { void refetch(); void refetchAck(); }}
            disabled={isFetching}
            data-testid="button-refresh-exhaustion-alerts"
          >
            <RefreshCw className={`w-4 h-4 mr-2 ${isFetching ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>
      </div>

      {ackMutation.isError && (
        <div
          className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-200"
          data-testid="ack-error"
        >
          Couldn't mark the row as followed up: {(ackMutation.error as Error).message}
        </div>
      )}

      {retryMutation.isError && (
        <div
          className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-200"
          data-testid="retry-error"
        >
          Couldn't retry delivery: {(retryMutation.error as Error).message}
        </div>
      )}

      {/*
        Surfaces the no-op case (every eligible channel still failed
        / was opted out / had no address) so the admin knows the
        retry actually ran but the row stayed put. Without this the
        success path's silent re-render could read as "nothing
        happened".
      */}
      {retryMutation.isSuccess && retryMutation.data && !retryMutation.data.anySent && (
        <div
          className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-200"
          data-testid="retry-no-op"
        >
          Retry ran but no channel was re-delivered (every eligible channel was
          opted out, missing an address, or still failed). The row remains on
          the worklist — fix the upstream issue and try again, or mark it
          followed up.
        </div>
      )}

      {isLoading && (
        <div
          className="text-sm text-muted-foreground"
          data-testid="exhaustion-alerts-loading"
        >
          Loading exhausted alerts…
        </div>
      )}

      {isError && (
        <div
          className="rounded-lg border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-300"
          data-testid="exhaustion-alerts-error"
        >
          {(error as Error)?.message ?? "Failed to load exhausted alerts."}
        </div>
      )}

      {data && items.length === 0 && (
        <div
          className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-6 text-sm text-emerald-200"
          data-testid="exhaustion-alerts-empty"
        >
          <div className="flex items-start gap-3">
            <CheckCircle2 className="w-5 h-5 mt-0.5 text-emerald-300" />
            <div>
              <h2 className="text-base font-semibold">All clear.</h2>
              <p className="text-sm text-emerald-200/80 mt-1">
                No outstanding wallet-withdrawal alerts have run out of retries.
              </p>
            </div>
          </div>
        </div>
      )}

      {data && items.length > 0 && (
        <>
          <div
            className="text-xs text-muted-foreground"
            data-testid="exhaustion-alerts-summary"
          >
            <AlertTriangle className="w-3.5 h-3.5 inline mr-1 text-amber-300" />
            {/*
              Task #1858 — when more pages are still on the server,
              show "Showing N of M" so admins know the queue is bigger
              than the visible list. Once everything is loaded (or for
              short lists with a single page) we drop back to the
              original "N unresolved alert(s)" wording.
            */}
            {totalOpen > items.length ? (
              <>
                Showing <span data-testid="exhaustion-alerts-loaded-count">{items.length}</span>
                {" of "}
                <span data-testid="exhaustion-alerts-total-count">{totalOpen}</span>
                {" unresolved alert"}{totalOpen === 1 ? "" : "s"}
              </>
            ) : (
              <>
                <span data-testid="exhaustion-alerts-loaded-count">{items.length}</span>
                {" unresolved alert"}{items.length === 1 ? "" : "s"}
              </>
            )}
          </div>
          <div className="space-y-3" data-testid="exhaustion-alerts-list">
            {items.map(item => (
              <AlertRow
                key={item.id}
                item={item}
                onAcknowledge={(id) => ackMutation.mutate(id)}
                isAcknowledging={ackingId === item.id}
                onRetry={(id) => retryMutation.mutate(id)}
                isRetrying={retryingId === item.id}
              />
            ))}
          </div>
          {hasNextPage && (
            <div className="flex justify-center pt-1">
              <Button
                variant="outline"
                size="sm"
                onClick={() => { void fetchNextPage(); }}
                disabled={isFetchingNextPage}
                data-testid="button-load-more-exhaustion-alerts"
              >
                {isFetchingNextPage ? (
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                ) : (
                  <ChevronDown className="w-4 h-4 mr-2" />
                )}
                {isFetchingNextPage ? "Loading…" : "Load more"}
              </Button>
            </div>
          )}
        </>
      )}

      {/*
        Task #1856 — Recently followed up section. Renders the audit
        trail (who marked each alert as followed up, and when) so
        managers can see at a glance that the row is being handled.
        Hidden entirely while the worklist is still loading-from-empty
        and there's nothing to show, so the page doesn't grow extra
        chrome for orgs that have never had a wallet alert.
      */}
      <section
        className="space-y-3 pt-2"
        data-testid="exhaustion-alerts-acknowledged-section"
      >
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-base font-semibold text-white/90">
            Recently followed up
            {/*
              Task #1858 — count summary mirrors the worklist above so
              admins can tell at a glance whether the audit feed has
              more rows behind the "Load more" button.
            */}
            {ackData && ackItems.length > 0 && (
              <span
                className="ml-2 text-xs font-normal text-muted-foreground"
                data-testid="exhaustion-alerts-acknowledged-summary"
              >
                {totalAck > ackItems.length ? (
                  <>
                    Showing{" "}
                    <span data-testid="exhaustion-alerts-acknowledged-loaded-count">
                      {ackItems.length}
                    </span>
                    {" of "}
                    <span data-testid="exhaustion-alerts-acknowledged-total-count">
                      {totalAck}
                    </span>
                  </>
                ) : (
                  <span data-testid="exhaustion-alerts-acknowledged-loaded-count">
                    {ackItems.length}
                  </span>
                )}
              </span>
            )}
          </h2>
          <span
            className="text-[11px] text-muted-foreground"
            data-testid="text-ack-window-label"
          >
            Last {ACK_HISTORY_DAYS} days
          </span>
        </div>

        {ackIsLoading && (
          <div
            className="text-sm text-muted-foreground"
            data-testid="exhaustion-alerts-acknowledged-loading"
          >
            Loading follow-up history…
          </div>
        )}

        {ackIsError && (
          <div
            className="rounded-lg border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-300"
            data-testid="exhaustion-alerts-acknowledged-error"
          >
            {(ackQueryError as Error)?.message ?? "Failed to load follow-up history."}
          </div>
        )}

        {ackData && ackItems.length === 0 && (
          <div
            className="rounded-lg border border-white/10 bg-white/5 p-4 text-sm text-muted-foreground"
            data-testid="exhaustion-alerts-acknowledged-empty"
          >
            No alerts have been marked as followed up in the last {ACK_HISTORY_DAYS} days.
          </div>
        )}

        {ackData && ackItems.length > 0 && (
          <>
            <div
              className="space-y-3"
              data-testid="exhaustion-alerts-acknowledged-list"
            >
              {ackItems.map(item => (
                <AcknowledgedAlertRow key={item.id} item={item} />
              ))}
            </div>
            {hasNextAckPage && (
              <div className="flex justify-center pt-1">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => { void fetchNextAckPage(); }}
                  disabled={isFetchingNextAckPage}
                  data-testid="button-load-more-acknowledged-alerts"
                >
                  {isFetchingNextAckPage ? (
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  ) : (
                    <ChevronDown className="w-4 h-4 mr-2" />
                  )}
                  {isFetchingNextAckPage ? "Loading…" : "Load more"}
                </Button>
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}
