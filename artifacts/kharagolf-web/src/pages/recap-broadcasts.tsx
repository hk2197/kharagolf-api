// Task #1276 — Read-only history of Year-in-Golf launch / reminder pushes.
//
// Surfaces rows from `recap_broadcasts` (Task #450) so admins can confirm
// the launch cron actually fired, when it ran, and how many recipients
// each push covered. Recap sends are owned by the cron, not by humans —
// this page is intentionally read-only.
//
// Both `org_admin` and `super_admin` can view this page. Recap broadcasts
// are platform-wide (the cron sends to every opted-in user across every
// club), so neither role sees a different slice of the data.
//
// Task #1496 — Each broadcast row can be expanded to reveal the
// per-recipient dispatch records the cron wrote to notification_audit_log
// for that (year, period, day) tuple. Super admins additionally get a
// dropdown to scope the recipient list to a single club; org admins are
// auto-scoped to their own organization on the server side.
import { Fragment, useEffect, useState } from "react";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { RefreshCw, AlertCircle, CalendarClock, ChevronLeft, ChevronRight, ChevronDown, Users, Download } from "lucide-react";
import { Button } from "@/components/ui/button";

interface RecapBroadcast {
  year: number;
  period: string; // "year" | "q1" | "q2" | "q3" | "q4"
  day: number;
  recipients: number;
  sentAt: string;
}

interface RecapBroadcastsResponse {
  broadcasts: RecapBroadcast[];
  limit: number;
}

interface RecipientRow {
  id: number;
  userId: number | null;
  username: string | null;
  displayName: string | null;
  email: string | null;
  organizationId: number | null;
  organizationName: string | null;
  channel: string;
  status: string;
  reason: string | null;
  createdAt: string;
}

interface RecipientsResponse {
  year: number;
  period: string;
  day: number;
  organizationId: number | null;
  recipients: RecipientRow[];
  limit: number;
  // Task #1839 — page is 1-based; total is the un-paginated row count
  // for this (broadcast, org) pair so the panel can render the real
  // upper bound instead of a misleading "capped at 1000" hint.
  page: number;
  total: number;
}

interface OrgListItem { id: number; name: string }

interface MeResponse { role?: string }

const ADMIN_ROLES = new Set(["org_admin", "super_admin", "tournament_director"]);

const PERIOD_LABEL: Record<string, string> = {
  year: "Annual",
  q1: "Q1",
  q2: "Q2",
  q3: "Q3",
  q4: "Q4",
};

function formatPeriod(year: number, period: string): string {
  const label = PERIOD_LABEL[period] ?? period;
  return `${label} ${year}`;
}

// The cron only sends on launch day + reminder days (1, 4, 7) within each
// 7- or 10-day window. Day 1 is the launch broadcast; later days are
// reminders. We mirror that wording so admins can tell the two apart at
// a glance instead of decoding a bare integer.
function formatDayKind(day: number): string {
  if (day === 1) return "Launch";
  return `Reminder · day ${day}`;
}

function rowKeyFor(row: RecapBroadcast): string {
  // Composite key matches the recipients endpoint's required (year, period, day) tuple.
  return `${row.year}|${row.period}|${row.day}`;
}

interface RecipientPanelProps {
  broadcast: RecapBroadcast;
  organizationId: number | null; // super_admin org filter (null = all)
  isSuperAdmin: boolean;
}

// Server cap on rows-per-request. Mirrors the route's `Math.min(rawLimit, 1000)`
// — we ask for a full page worth of rows so the pagination math (and the
// "Showing X–Y of N" footer) match what the server returned.
const RECIPIENT_PAGE_SIZE = 1000;

function RecipientPanel({ broadcast, organizationId, isSuperAdmin }: RecipientPanelProps) {
  // Task #1839 — pagination state lives per-panel so each expanded row
  // remembers its current page independently. We reset to page 1 whenever
  // the broadcast or org filter changes so a super admin switching clubs
  // doesn't get stranded on (e.g.) page 12 of a club with only 5 pages.
  const [page, setPage] = useState(1);
  useEffect(() => {
    setPage(1);
  }, [organizationId, broadcast.year, broadcast.period, broadcast.day]);

  const queryString = (() => {
    const params = new URLSearchParams({
      year: String(broadcast.year),
      period: broadcast.period,
      day: String(broadcast.day),
      page: String(page),
      limit: String(RECIPIENT_PAGE_SIZE),
    });
    if (isSuperAdmin && organizationId !== null) {
      params.set("organizationId", String(organizationId));
    }
    return params.toString();
  })();
  const url = `/api/admin/recap-broadcasts/recipients?${queryString}`;
  // Sibling CSV export (Task #1838) — same auth + scope as the JSON
  // panel above, but exports every recipient (no row cap) so admins
  // can attach the file to a support ticket or hand it to a club
  // manager. The browser triggers the download via the
  // Content-Disposition header on the response.
  const csvUrl = `/api/admin/recap-broadcasts/recipients.csv?${queryString}`;

  const { data, isLoading, isError, error, refetch, isFetching } = useQuery<RecipientsResponse>({
    // Include the org filter + page in the cache key so a super admin
    // switching clubs / pages doesn't see a stale recipient list flash
    // before refetch.
    queryKey: ["/api/admin/recap-broadcasts/recipients", broadcast.year, broadcast.period, broadcast.day, organizationId ?? "__all__", page],
    queryFn: async () => {
      const res = await fetch(url, { credentials: "include" });
      if (res.status === 401) throw new Error("Sign in required to view recipients.");
      if (res.status === 403) throw new Error("Admin role required to view recipients.");
      if (!res.ok) throw new Error(`Request failed (HTTP ${res.status})`);
      return (await res.json()) as RecipientsResponse;
    },
    // While paging, keep the previous page's rows visible during the
    // fetch so the table doesn't collapse to a "Loading…" placeholder
    // every click. The "Loading recipients…" branch below only fires
    // for the *first* fetch (when there's no prior data to keep).
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });

  const testKey = `${broadcast.year}-${broadcast.period}-${broadcast.day}`;

  if (isLoading) {
    return (
      <div className="px-6 py-4 text-sm text-muted-foreground" data-testid={`recap-broadcast-recipients-loading-${testKey}`}>
        Loading recipients…
      </div>
    );
  }
  if (isError) {
    return (
      <div className="px-6 py-4 flex items-start gap-2 text-sm text-red-300" data-testid={`recap-broadcast-recipients-error-${testKey}`}>
        <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
        <div>
          <div className="font-medium">Couldn't load recipients</div>
          <div className="text-xs text-red-300/80 mt-1">{(error as Error).message}</div>
          <Button variant="outline" size="sm" className="mt-2" onClick={() => refetch()} disabled={isFetching}>
            Retry
          </Button>
        </div>
      </div>
    );
  }
  // No data at all (very first fetch) — and no recipients on page 1.
  // Once we know `total === 0` for page 1, we can be confident the
  // broadcast genuinely has no recorded recipients (vs. just paged off
  // the end, which we handle separately further down).
  if (!data || (data.total === 0 && data.page === 1)) {
    return (
      <div className="px-6 py-4 text-sm text-muted-foreground" data-testid={`recap-broadcast-recipients-empty-${testKey}`}>
        No per-recipient records found for this broadcast.
        {/* Old broadcasts (before per-recipient logging shipped) won't have
            audit rows. We make that benign-empty state explicit so admins
            don't read it as "the broadcast didn't go out". */}
        <div className="text-xs mt-1 opacity-80">
          Broadcasts sent before per-recipient logging was enabled won't appear here, even though the push itself fired.
        </div>
      </div>
    );
  }

  // Group by organization name so the panel reads as "Club A: alice, bob;
  // Club B: carol" — the server already orders by org → display name, so
  // a simple sequential walk preserves that.
  const groups: { orgName: string; rows: RecipientRow[] }[] = [];
  let current: { orgName: string; rows: RecipientRow[] } | null = null;
  for (const r of data.recipients) {
    const orgName = r.organizationName ?? "(no organization)";
    if (!current || current.orgName !== orgName) {
      current = { orgName, rows: [] };
      groups.push(current);
    }
    current.rows.push(r);
  }

  // Pagination math. `totalPages` is at least 1 even when total is 0 so
  // the footer reads "Page 1 of 1" instead of "Page 1 of 0" in the
  // no-results-on-this-page edge case.
  const totalPages = Math.max(1, Math.ceil(data.total / data.limit));
  const rangeStart = data.recipients.length === 0 ? 0 : (data.page - 1) * data.limit + 1;
  const rangeEnd = (data.page - 1) * data.limit + data.recipients.length;
  const hasPrev = data.page > 1;
  const hasNext = data.page < totalPages;

  return (
    <div className="px-6 py-4 space-y-4" data-testid={`recap-broadcast-recipients-${testKey}`}>
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="text-xs text-muted-foreground flex items-center gap-2 flex-wrap">
          <Users className="w-3.5 h-3.5" />
          {/* Task #1839 — show the real total so super admins viewing
              platform-wide annual recaps know there are more pages
              behind the current view, instead of a misleading
              "(capped at 1000)" hint. */}
          <span data-testid={`recap-broadcast-recipients-summary-${testKey}`}>
            Showing {rangeStart.toLocaleString()}–{rangeEnd.toLocaleString()} of {data.total.toLocaleString()} dispatch{data.total === 1 ? "" : "es"}
          </span>
          {data.organizationId !== null ? <span>· scoped to org #{data.organizationId}</span> : null}
        </div>
        {/* Task #1838 — plain anchor (not fetch) so the browser handles
            the Content-Disposition header and triggers a save dialog.
            The CSV endpoint streams every matching row, not just the
            current page the panel renders. */}
        <a
          href={csvUrl}
          download
          className="inline-flex items-center gap-1.5 text-xs font-medium rounded border border-border px-2.5 py-1 hover:bg-muted/40"
          data-testid={`recap-broadcast-recipients-download-csv-${testKey}`}
        >
          <Download className="w-3.5 h-3.5" />
          Download CSV
        </a>
      </div>

      {data.recipients.length === 0 ? (
        // Paged past the end (e.g. total shrank between visits). Show a
        // gentle nudge instead of an empty list — the controls below
        // still let the admin walk back to a valid page.
        <div className="text-xs text-muted-foreground italic" data-testid={`recap-broadcast-recipients-page-empty-${testKey}`}>
          No recipients on this page. Use the controls below to navigate to a valid page.
        </div>
      ) : (
        groups.map((g) => (
          <div key={g.orgName} className="space-y-1">
            <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">{g.orgName}</div>
            <ul className="rounded border border-border divide-y divide-border bg-background/40">
              {g.rows.map((r) => {
                const name = r.displayName ?? r.username ?? (r.email ?? `User #${r.userId ?? "—"}`);
                const subtitle = [r.username && `@${r.username}`, r.email].filter(Boolean).join(" · ");
                return (
                  <li
                    key={r.id}
                    className="px-3 py-2 flex items-center justify-between gap-3"
                    data-testid={`recap-broadcast-recipient-${testKey}-user-${r.userId ?? "null"}`}
                  >
                    <div className="min-w-0">
                      <div className="text-sm font-medium truncate">{name}</div>
                      {subtitle ? <div className="text-xs text-muted-foreground truncate">{subtitle}</div> : null}
                    </div>
                    <div className="text-xs text-muted-foreground whitespace-nowrap font-mono">
                      {r.channel} · {r.status}
                      {r.reason ? <span className="ml-1 opacity-70">({r.reason})</span> : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        ))
      )}

      {/* Pagination controls. We render them whenever `total > limit` so
          super admins viewing platform-wide annual recaps (which can
          dispatch to tens of thousands of members) can browse the full
          list instead of being silently truncated at page 1. The buttons
          stay mounted while a fetch is in flight and only disable to
          prevent double-clicks during the transition. */}
      {totalPages > 1 && (
        <div
          className="flex items-center justify-between gap-3 pt-2 border-t border-border/60"
          data-testid={`recap-broadcast-recipients-pagination-${testKey}`}
        >
          <div className="text-xs text-muted-foreground">
            Page <span data-testid={`recap-broadcast-recipients-page-${testKey}`}>{data.page.toLocaleString()}</span> of {totalPages.toLocaleString()}
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage(p => Math.max(1, p - 1))}
              disabled={!hasPrev || isFetching}
              data-testid={`recap-broadcast-recipients-prev-${testKey}`}
            >
              <ChevronLeft className="w-4 h-4 mr-1" />
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage(p => Math.min(totalPages, p + 1))}
              disabled={!hasNext || isFetching}
              data-testid={`recap-broadcast-recipients-next-${testKey}`}
            >
              Next
              <ChevronRight className="w-4 h-4 ml-1" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function RecapBroadcastsPage() {
  // Mirror the gating pattern used by the notification audit page so
  // non-admins see a friendly message instead of a row of failing requests.
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

  const { data, isLoading, isError, error, refetch, isFetching } = useQuery<RecapBroadcastsResponse>({
    queryKey: ["/api/admin/recap-broadcasts"],
    queryFn: async () => {
      const res = await fetch("/api/admin/recap-broadcasts", { credentials: "include" });
      if (res.status === 401) throw new Error("Sign in required to view recap broadcasts.");
      if (res.status === 403) throw new Error("Admin role required to view recap broadcasts.");
      if (!res.ok) throw new Error(`Request failed (HTTP ${res.status})`);
      return (await res.json()) as RecapBroadcastsResponse;
    },
    enabled: isAdmin,
    staleTime: 60_000,
  });

  // Org list — only loaded for super admins, since they're the only role
  // allowed to scope recipients across other clubs. org_admin / TD see no
  // dropdown at all (the server pins them to their own org regardless).
  const { data: orgs } = useQuery<OrgListItem[]>({
    queryKey: ["/api/organizations", "for-recap-broadcasts-filter"],
    queryFn: async () => {
      const res = await fetch("/api/organizations", { credentials: "include" });
      if (!res.ok) throw new Error(`Request failed (HTTP ${res.status})`);
      const raw = (await res.json()) as Array<{ id: number; name: string }>;
      return raw.map(o => ({ id: o.id, name: o.name }));
    },
    enabled: isAdmin && isSuperAdmin,
    staleTime: 5 * 60_000,
  });

  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [orgFilter, setOrgFilter] = useState<number | null>(null);

  if (meLoading) {
    return (
      <div className="p-6" data-testid="recap-broadcasts-page">
        <div className="text-sm text-muted-foreground">Loading…</div>
      </div>
    );
  }

  if (!isAdmin) {
    let title = "Recap broadcast history";
    let body =
      "You need an admin role (organization admin, tournament director, or super admin) to view this page. " +
      "Contact your club administrator if you believe this is a mistake.";
    let testId = "recap-broadcasts-no-access";
    if (meStatus === "error") {
      title = "Couldn't verify your access";
      body =
        "We couldn't reach the authentication service to check your role. " +
        "This usually clears up on its own — please refresh in a moment.";
      testId = "recap-broadcasts-auth-error";
    } else if (!me) {
      title = "Sign in required";
      body = "You need to sign in to view the recap broadcast history.";
      testId = "recap-broadcasts-signin-required";
    }
    return (
      <div className="p-6" data-testid="recap-broadcasts-page">
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

  return (
    <div className="p-6 space-y-6" data-testid="recap-broadcasts-page">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
            <CalendarClock className="w-6 h-6 text-primary" />
            Year-in-Golf launch history
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Every Year-in-Golf launch and reminder push the cron has fired, in reverse-chronological order.
            Each row records when the broadcast went out and how many opted-in recipients it covered.
            Click a row to see exactly which members received it.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => refetch()}
          disabled={isFetching}
          data-testid="button-refresh-recap-broadcasts"
        >
          <RefreshCw className={`w-4 h-4 mr-2 ${isFetching ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {isSuperAdmin && (
        <div className="flex items-center gap-2 text-sm" data-testid="recap-broadcasts-org-filter">
          <label htmlFor="recap-broadcasts-org-select" className="text-muted-foreground">
            Filter recipients by club:
          </label>
          <select
            id="recap-broadcasts-org-select"
            data-testid="recap-broadcasts-org-select"
            className="rounded border border-border bg-background px-2 py-1 text-sm"
            value={orgFilter === null ? "" : String(orgFilter)}
            onChange={(e) => {
              const v = e.target.value;
              setOrgFilter(v === "" ? null : Number(v));
            }}
          >
            <option value="">All clubs</option>
            {(orgs ?? []).map((o) => (
              <option key={o.id} value={o.id}>{o.name}</option>
            ))}
          </select>
          {orgFilter !== null && (
            <button
              type="button"
              onClick={() => setOrgFilter(null)}
              className="text-xs text-muted-foreground hover:text-foreground underline"
              data-testid="recap-broadcasts-org-clear"
            >
              Clear
            </button>
          )}
        </div>
      )}

      <div className="rounded-lg border border-border bg-card overflow-hidden">
        {isError ? (
          <div className="p-6 flex items-start gap-3 text-sm text-red-300" data-testid="recap-broadcasts-error">
            <AlertCircle className="w-5 h-5 flex-shrink-0" />
            <div>
              <div className="font-medium">Could not load recap broadcasts</div>
              <div className="text-xs text-red-300/80 mt-1">{(error as Error).message}</div>
            </div>
          </div>
        ) : isLoading ? (
          <div className="p-10 text-center text-sm text-muted-foreground" data-testid="recap-broadcasts-loading">
            Loading recap broadcast history…
          </div>
        ) : !data || data.broadcasts.length === 0 ? (
          <div className="p-10 text-center text-sm text-muted-foreground" data-testid="recap-broadcasts-empty">
            No recap broadcasts have been fired yet. The annual launch runs Jan 1–10; quarterly launches run on the 1st–7th of Apr / Jul / Oct / Jan.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-4 py-2 text-left font-medium w-8" aria-label="Expand"></th>
                <th className="px-4 py-2 text-left font-medium">Sent</th>
                <th className="px-4 py-2 text-left font-medium">Recap period</th>
                <th className="px-4 py-2 text-left font-medium">Day</th>
                <th className="px-4 py-2 text-right font-medium">Recipients</th>
              </tr>
            </thead>
            <tbody>
              {data.broadcasts.map((row) => {
                // The DB primary key is (year, period, day), so that triple
                // is already unique per row today. We append `sentAt` to the
                // React key as a defensive belt-and-braces — if the schema
                // ever grows to allow repeats (e.g. a manual re-fire) the
                // key will still be unique and reconciliation stays stable.
                const reactKey = `${row.year}-${row.period}-${row.day}-${row.sentAt}`;
                const testKey = `${row.year}-${row.period}-${row.day}`;
                const drillKey = rowKeyFor(row);
                const isExpanded = expandedKey === drillKey;
                return (
                  <Fragment key={reactKey}>
                    <tr
                      className="border-t border-border cursor-pointer hover:bg-muted/30"
                      data-testid={`recap-broadcast-row-${testKey}`}
                      onClick={() => setExpandedKey(isExpanded ? null : drillKey)}
                    >
                      <td className="px-4 py-3 align-top">
                        <button
                          type="button"
                          aria-expanded={isExpanded}
                          aria-label={isExpanded ? "Collapse recipients" : "Expand recipients"}
                          className="text-muted-foreground hover:text-foreground"
                          data-testid={`recap-broadcast-toggle-${testKey}`}
                          onClick={(e) => {
                            // Prevent the row's onClick from also firing.
                            e.stopPropagation();
                            setExpandedKey(isExpanded ? null : drillKey);
                          }}
                        >
                          {isExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                        </button>
                      </td>
                      <td className="px-4 py-3 align-top whitespace-nowrap text-xs text-muted-foreground">
                        {new Date(row.sentAt).toLocaleString()}
                      </td>
                      <td className="px-4 py-3 align-top font-medium">
                        {formatPeriod(row.year, row.period)}
                      </td>
                      <td className="px-4 py-3 align-top text-xs text-muted-foreground">
                        {formatDayKind(row.day)}
                      </td>
                      <td
                        className="px-4 py-3 align-top text-right font-mono"
                        data-testid={`recap-broadcast-recipients-${reactKey}`}
                      >
                        {row.recipients.toLocaleString()}
                      </td>
                    </tr>
                    {isExpanded && (
                      <tr className="border-t border-border bg-muted/10">
                        <td colSpan={5} className="p-0">
                          <RecipientPanel
                            broadcast={row}
                            organizationId={isSuperAdmin ? orgFilter : null}
                            isSuperAdmin={isSuperAdmin}
                          />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        )}

        {data && data.broadcasts.length > 0 && (
          <div className="border-t border-border bg-muted/20 px-4 py-2 text-xs text-muted-foreground">
            Showing {data.broadcasts.length.toLocaleString()} most recent broadcast{data.broadcasts.length === 1 ? "" : "s"} (capped at {data.limit}).
          </div>
        )}
      </div>
    </div>
  );
}
