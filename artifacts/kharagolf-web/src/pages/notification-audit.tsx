// Task #1172 — Live audit feed for every notification the system sent.
//
// Browses rows from `notification_audit_log`. Org admins see only rows for
// recipients in their org; super admins see everything. The page is gated
// both server-side (the API responds 401/403) and client-side here (we look
// up `/api/auth/me` and short-circuit non-admin internal roles with a
// friendly notice rather than letting them watch the table render with a
// permanent error banner).
import React, { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearch } from "wouter";
import {
  RefreshCw, Filter, ChevronLeft, ChevronRight, AlertCircle, Download,
  Inbox, Loader2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  ChannelStatusBadge,
  NOTIFICATION_CHANNEL_ICON,
} from "@/lib/notification-channel-status";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

// Task #1624 — Anything bigger than this triggers a one-tap confirmation
// before the browser starts the download, so admins don't accidentally
// pull a multi-megabyte file. Sized for "obviously large" rather than
// "technically expensive": ~10k rows of audit data is roughly 1–2 MB and
// the point at which "click and wait" stops being instant.
const LARGE_CSV_ROW_THRESHOLD = 10_000;

interface AuditEntry {
  id: number;
  notificationKey: string;
  userId: number | null;
  userDisplayName: string | null;
  username: string | null;
  userEmail: string | null;
  channel: string;
  status: string;
  reason: string | null;
  payload: Record<string, unknown> | null;
  createdAt: string;
}

interface AuditResponse {
  entries: AuditEntry[];
  total: number;
  page: number;
  limit: number;
  facets: {
    keys: string[];
    channels: string[];
    statuses: string[];
  };
  // Task #2007 — Optional size-estimate hint for the CSV export. The
  // server samples the page rows it just returned to compute
  // `avgRowBytes`; the client multiplies by `total` and adds
  // `headerBytes` to render an "~X MB" affordance next to the row
  // count. Optional so older server builds (or empty-scope short-
  // circuits without a sample) still parse cleanly.
  csvEstimate?: {
    avgRowBytes: number | null;
    headerBytes: number;
  };
}

// Task #2007 — Render a byte count in the largest unit that keeps the
// number readable (B / KB / MB / GB). Mirrors the helper used on the
// share-rollups admin page so the formatting matches across admin
// surfaces. Used for the "~480 KB" / "~12 MB" hint on the Download
// CSV button and confirmation dialog.
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

// Task #2007 — Compute an estimated CSV download size in bytes from
// the server-supplied per-row hint. Returns null when we don't have
// enough information to make a useful estimate (no hint, no row
// sample, or no matching rows) so the caller can simply omit the
// "~X MB" suffix in that case rather than show a misleading "0 B".
function estimateCsvBytes(data: AuditResponse | undefined): number | null {
  if (!data || data.total <= 0) return null;
  const hint = data.csvEstimate;
  if (!hint || hint.avgRowBytes == null) return null;
  return hint.headerBytes + hint.avgRowBytes * data.total;
}

// Task #2015 — Pull the server-provided filename out of a
// `Content-Disposition: attachment; filename="..."` header so the
// downloaded blob keeps the same name the browser would have used for
// a direct anchor download. Falls back to a generic name when the
// header is missing or malformed (legacy server, proxy stripped it,
// etc.) — we'd rather give the file *a* name than fail the download.
function parseFilenameFromContentDisposition(header: string | null): string | null {
  if (!header) return null;
  // Prefer the RFC 5987 `filename*` form (UTF-8) when present so we
  // don't mangle non-ASCII filenames.
  const star = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(header);
  if (star && star[2]) {
    try { return decodeURIComponent(star[2].trim()); }
    catch { /* fall through to plain filename */ }
  }
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(header);
  if (plain && plain[1]) return plain[1].trim();
  return null;
}

// Task #2015 — Count newline bytes in a chunk. The CSV stream uses
// `\n` as its row terminator (the audit endpoint emits LF-only rows),
// so each newline corresponds to exactly one written line. The first
// line is the header, so the caller subtracts 1 from the running
// total when surfacing "data rows received so far".
function countNewlines(chunk: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < chunk.length; i++) {
    if (chunk[i] === 0x0a) n++;
  }
  return n;
}

const ALL = "__all__";

interface MeResponse { role?: string }

const ADMIN_ROLES = new Set(["org_admin", "super_admin"]);

export default function NotificationAuditPage() {
  // Look up the current user's role and short-circuit non-admins client-side
  // with a polite "no access" panel. The server still enforces the role
  // boundary; this just gives a better UX than rendering the full table
  // shell only to flash a 403 in every panel.
  //
  // We deliberately distinguish between "not signed in" (status 401),
  // "couldn't reach the auth endpoint" (network/5xx — `meStatus === "error"`),
  // and "signed in but not an admin" (200 with non-admin role) so the user
  // sees an accurate explanation rather than a generic "no access".
  const { data: me, isLoading: meLoading, status: meStatus } = useQuery<MeResponse | null>({
    queryKey: ["/api/auth/me"],
    queryFn: async () => {
      const res = await fetch("/api/auth/me", { credentials: "include" });
      if (res.status === 401) return null; // anonymous — fall through to "sign in" panel
      if (!res.ok) throw new Error(`Auth lookup failed (HTTP ${res.status})`);
      return (await res.json()) as MeResponse;
    },
    retry: false,
    staleTime: 5 * 60_000,
  });

  // Task #1361 — accept `?key=<key>` from the URL so other admin
  // surfaces (notification template registry, channel status, etc.) can
  // deep-link straight into the dispatch history for a specific key
  // instead of forcing the admin to re-pick it from the dropdown.
  // We seed the filter from the URL on first render and also re-sync
  // whenever the search string changes (e.g. wouter Link navigation
  // between two `?key=` deep-links without remounting the page).
  const search = useSearch();
  const urlKeyFilter = useMemo(() => {
    const params = new URLSearchParams(search);
    const k = params.get("key");
    return k && k.length > 0 ? k : ALL;
  }, [search]);

  const [page, setPage] = useState(1);
  const [limit] = useState(50);
  const [keyFilter, setKeyFilter] = useState<string>(urlKeyFilter);
  const [channelFilter, setChannelFilter] = useState<string>(ALL);
  const [statusFilter, setStatusFilter] = useState<string>(ALL);
  const [userQuery, setUserQuery] = useState("");
  const [userQueryDraft, setUserQueryDraft] = useState("");
  const [since, setSince] = useState("");
  const [until, setUntil] = useState("");
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  // Reset to first page whenever filters change.
  useEffect(() => { setPage(1); }, [keyFilter, channelFilter, statusFilter, userQuery, since, until]);

  // Task #1361 — re-sync the key filter when the URL changes (e.g. the
  // admin clicks a different "View audit" deep-link from the registry
  // without the page remounting).
  useEffect(() => { setKeyFilter(urlKeyFilter); }, [urlKeyFilter]);

  const queryString = useMemo(() => {
    const params = new URLSearchParams();
    params.set("page", String(page));
    params.set("limit", String(limit));
    if (keyFilter !== ALL) params.set("key", keyFilter);
    if (channelFilter !== ALL) params.set("channel", channelFilter);
    if (statusFilter !== ALL) params.set("status", statusFilter);
    if (userQuery.trim()) params.set("userQuery", userQuery.trim());
    if (since) params.set("since", new Date(since).toISOString());
    if (until) params.set("until", new Date(until).toISOString());
    return params.toString();
  }, [page, limit, keyFilter, channelFilter, statusFilter, userQuery, since, until]);

  // Task #1360 — CSV export URL mirrors the JSON list filters so the
  // downloaded file always matches what the admin sees on screen. The
  // server ignores `page` / `limit` for CSV (it exports every matching
  // row), but we leave them in the query string so the URL contract
  // stays identical between the two endpoints.
  const csvHref = `/api/admin/notification-audit.csv?${queryString}`;

  // Task #1624 — Gate the download behind a one-tap confirmation when
  // the matching count is "obviously large" so admins aren't surprised
  // by a multi-megabyte file. We only ever know the count after the
  // JSON list endpoint has answered, so the gate is a no-op on first
  // render or while filters are still loading.
  const [confirmLargeDownload, setConfirmLargeDownload] = useState(false);

  // Task #2015 — In-page progress indicator for the streaming CSV
  // download. The endpoint flushes the CSV header byte-1, then row-
  // by-row via chunked transfer-encoding, so a "year of dispatch
  // history" download can spend many seconds in flight even though
  // the browser already accepted the response. Without feedback the
  // admin can't tell whether the click registered, so we drive the
  // download ourselves via fetch + a streaming reader and surface a
  // running byte / row tally next to the button. When the stream
  // completes we hand the assembled blob to the browser via a
  // synthesized anchor click so it still saves like a normal
  // download — Content-Disposition filename and all.
  type DownloadStatus = "idle" | "downloading" | "error";
  const [downloadStatus, setDownloadStatus] = useState<DownloadStatus>("idle");
  const [downloadBytes, setDownloadBytes] = useState(0);
  const [downloadRows, setDownloadRows] = useState(0);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  // Hold the in-flight AbortController so a route change / page
  // unmount can cancel the fetch instead of leaving it (and the
  // server-side cursor) running until the browser tears down the
  // request socket.
  const downloadAbortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    return () => {
      const ctrl = downloadAbortRef.current;
      if (ctrl) {
        try { ctrl.abort(); } catch { /* best-effort */ }
        downloadAbortRef.current = null;
      }
    };
  }, []);

  const startCsvDownload = useCallback(async () => {
    // Guard against double-fires (rapid double-clicks, dialog +
    // small-button race) — the disabled prop on the trigger is the
    // primary defense but we belt-and-brace here too in case a
    // synthetic event sneaks through during the React render that
    // flips the disabled state.
    if (downloadAbortRef.current) return;
    setConfirmLargeDownload(false);
    setDownloadStatus("downloading");
    setDownloadBytes(0);
    setDownloadRows(0);
    setDownloadError(null);
    const controller = new AbortController();
    downloadAbortRef.current = controller;
    try {
      const res = await fetch(csvHref, {
        credentials: "include",
        signal: controller.signal,
      });
      if (res.status === 401) {
        throw new Error("Sign in required to download the audit CSV.");
      }
      if (res.status === 403) {
        throw new Error("Admin role required to download the audit CSV.");
      }
      if (!res.ok) {
        throw new Error(`Server responded ${res.status} ${res.statusText || ""}`.trim());
      }
      if (!res.body) {
        throw new Error("Your browser does not support streaming downloads.");
      }
      const filename = parseFilenameFromContentDisposition(
        res.headers.get("content-disposition"),
      ) ?? "notification-audit.csv";
      const reader = res.body.getReader();
      const chunks: BlobPart[] = [];
      let received = 0;
      let newlineTotal = 0;
      // Stream the response chunk-by-chunk so the running tally
      // updates as the server flushes rows. We accumulate the
      // chunks into an in-memory list for the eventual Blob — the
      // export is fundamentally the same shape the browser would
      // have buffered anyway, so peak memory is unchanged vs. the
      // anchor-based path it replaced.
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.length > 0) {
          chunks.push(value);
          received += value.length;
          newlineTotal += countNewlines(value);
          setDownloadBytes(received);
          setDownloadRows(Math.max(0, newlineTotal - 1));
        }
      }
      const blob = new Blob(chunks, { type: "text/csv;charset=utf-8" });
      const objectUrl = URL.createObjectURL(blob);
      try {
        const a = document.createElement("a");
        a.href = objectUrl;
        a.download = filename;
        a.rel = "noopener";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      } finally {
        // Defer revoke so Safari has a chance to actually start the
        // download from the object URL before we yank it.
        setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
      }
      setDownloadStatus("idle");
    } catch (err) {
      const e = err as Error & { name?: string };
      if (e?.name === "AbortError") {
        // Cancellation is expected on unmount — go quietly back to
        // idle so a re-mount doesn't see a stale "error" banner.
        setDownloadStatus("idle");
        return;
      }
      const message = e?.message?.trim()
        ? e.message
        : "Download failed. Please try again.";
      setDownloadError(message);
      setDownloadStatus("error");
    } finally {
      downloadAbortRef.current = null;
    }
  }, [csvHref]);

  const dismissDownloadError = useCallback(() => {
    setDownloadStatus("idle");
    setDownloadError(null);
  }, []);

  const isDownloading = downloadStatus === "downloading";

  const isAdmin = !!me && ADMIN_ROLES.has(me.role ?? "");

  // Refresh on a 15-second interval so the page genuinely reflects a "live"
  // dispatch trail without forcing the admin to mash the refresh button.
  // Pauses when the browser tab is hidden so we don't poll in the background.
  // Disabled entirely for non-admins so we don't even fire the request.
  const { data, isLoading, isError, error, refetch, isFetching } = useQuery<AuditResponse>({
    queryKey: ["notification-audit", queryString],
    queryFn: async () => {
      const res = await fetch(`/api/admin/notification-audit?${queryString}`, { credentials: "include" });
      if (res.status === 401) throw new Error("Sign in required to view notification audit.");
      if (res.status === 403) throw new Error("Admin role required to view notification audit.");
      if (!res.ok) throw new Error(`Request failed (HTTP ${res.status})`);
      return res.json() as Promise<AuditResponse>;
    },
    enabled: isAdmin,
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
  });

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.limit)) : 1;

  const toggleExpanded = useCallback((id: number) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const submitUserQuery = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    setUserQuery(userQueryDraft);
  }, [userQueryDraft]);

  const clearAllFilters = useCallback(() => {
    setKeyFilter(ALL);
    setChannelFilter(ALL);
    setStatusFilter(ALL);
    setUserQuery("");
    setUserQueryDraft("");
    setSince("");
    setUntil("");
  }, []);

  // Wait for the auth lookup to settle before deciding what to render — we
  // don't want to flash the access-denied panel while `me` is still loading.
  if (meLoading) {
    return (
      <div className="p-6" data-testid="notification-audit-page">
        <div className="text-sm text-muted-foreground">Loading…</div>
      </div>
    );
  }

  if (!isAdmin) {
    // Three distinguishable states so the user sees an accurate reason
    // instead of a generic "no access" wall:
    //   • meStatus === "error"  → /api/auth/me itself failed (network /
    //                             5xx). Surface a retry rather than
    //                             implying they're not allowed in.
    //   • !me                   → 401 from /api/auth/me — signed out.
    //   • me with non-admin role → genuinely not authorized.
    let title = "Notification audit feed";
    let body =
      "You need an organization or super-admin role to view this page. " +
      "Contact your club administrator if you believe this is a mistake.";
    let testId = "notification-audit-no-access";
    if (meStatus === "error") {
      title = "Couldn't verify your access";
      body =
        "We couldn't reach the authentication service to check your role. " +
        "This usually clears up on its own — please refresh in a moment.";
      testId = "notification-audit-auth-error";
    } else if (!me) {
      title = "Sign in required";
      body = "You need to sign in to view the notification audit feed.";
      testId = "notification-audit-signin-required";
    }
    return (
      <div className="p-6" data-testid="notification-audit-page">
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
    <div className="p-6 space-y-6" data-testid="notification-audit-page">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Notification audit feed</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Every notification dispatched by the system for keys flagged with audit logging.
            Filter by key, recipient, channel, status, or date range.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/*
            Task #1360 — Plain anchor (not a fetch) so the browser
            handles the file download (with cookies for auth) via the
            response's Content-Disposition header. `download` hints the
            browser to save rather than navigate; the server-side
            filename in the header still wins.

            Task #1624 — Surface the matching row count in the label
            once we know it (the JSON list endpoint already returned
            `data.total`). This lets admins see "Download CSV (1,243
            rows)" before clicking, instead of finding out after the
            file lands. For very large counts we intercept the click
            and prompt for confirmation; the dialog's confirm button
            re-uses the same href so the browser still does the actual
            download with the right cookies + headers.
          */}
          {(() => {
            // Task #2007 — Build the "Download CSV (1,243 rows · ~480 KB)"
            // label once so both the inline button and the large-export
            // gate render the same affordance. The size suffix is
            // omitted when the server hasn't supplied a per-row hint
            // (e.g. empty scope, or while data is still loading) so
            // we never show a misleading "0 B".
            const estBytes = estimateCsvBytes(data);
            const suffix = data
              ? `${data.total.toLocaleString()} ${data.total === 1 ? "row" : "rows"}` +
                (estBytes != null ? ` · ~${formatBytes(estBytes)}` : "")
              : null;
            const baseLabel = suffix ? `Download CSV (${suffix})` : "Download CSV";
            // Task #2015 — While the stream is in flight the same
            // button reads "Downloading…" and is disabled, so the
            // admin can't accidentally double-fire by clicking again
            // mid-export.
            const label = isDownloading ? "Downloading…" : baseLabel;
            const isLarge = !!(data && data.total > LARGE_CSV_ROW_THRESHOLD);
            const onClick = isLarge
              ? () => setConfirmLargeDownload(true)
              : startCsvDownload;
            return (
              <Button
                variant="outline"
                size="sm"
                onClick={onClick}
                disabled={isDownloading}
                data-testid="button-download-audit-csv"
              >
                {isDownloading ? (
                  <Loader2
                    className="w-4 h-4 mr-2 animate-spin"
                    data-testid="icon-download-audit-csv-spinner"
                  />
                ) : (
                  <Download className="w-4 h-4 mr-2" />
                )}
                <span data-testid="text-download-audit-csv-label">{label}</span>
              </Button>
            );
          })()}
          <Button
            variant="outline"
            size="sm"
            onClick={() => refetch()}
            disabled={isFetching}
            data-testid="button-refresh-audit"
          >
            <RefreshCw className={`w-4 h-4 mr-2 ${isFetching ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>
      </div>

      {/*
        Task #2015 — Live progress banner for the streaming CSV export.
        Renders only while a download is in flight (or after one
        failed). For very large exports this is the difference between
        "did anything happen?" and "5,431 rows · 2.1 MB so far"; for
        small ones it flashes briefly then disappears, which is fine.
        The error variant exposes a "Try again" button so a transient
        network blip doesn't force the admin to re-find the original
        Download button hidden among the page chrome.
      */}
      {downloadStatus === "downloading" && (
        <div
          className="rounded-lg border border-sky-500/30 bg-sky-500/10 p-4 flex items-center gap-3 text-sm"
          data-testid="audit-download-progress"
          role="status"
          aria-live="polite"
        >
          <Loader2 className="w-4 h-4 animate-spin text-sky-300 flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="font-medium text-sky-100">Preparing your export…</div>
            <div className="text-xs text-sky-200/80 mt-0.5">
              {downloadRows > 0 ? (
                <>
                  <span data-testid="text-download-progress-rows">
                    {downloadRows.toLocaleString()}
                  </span>{" "}
                  {downloadRows === 1 ? "row" : "rows"}
                  {downloadBytes > 0 ? (
                    <>
                      {" · "}
                      <span data-testid="text-download-progress-bytes">
                        {formatBytes(downloadBytes)}
                      </span>{" "}
                      received
                    </>
                  ) : null}
                </>
              ) : downloadBytes > 0 ? (
                <>
                  <span data-testid="text-download-progress-bytes">
                    {formatBytes(downloadBytes)}
                  </span>{" "}
                  received
                </>
              ) : (
                <>Streaming from the server…</>
              )}
            </div>
          </div>
        </div>
      )}
      {downloadStatus === "error" && (
        <div
          className="rounded-lg border border-red-500/40 bg-red-500/10 p-4 flex items-start gap-3 text-sm"
          data-testid="audit-download-error"
          role="alert"
        >
          <AlertCircle className="w-5 h-5 text-red-300 flex-shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <div className="font-medium text-red-100">CSV download failed</div>
            <div
              className="text-xs text-red-200/90 mt-1 break-words"
              data-testid="text-download-error-message"
            >
              {downloadError ?? "Download failed. Please try again."}
            </div>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <Button
              size="sm"
              variant="outline"
              onClick={startCsvDownload}
              data-testid="button-retry-download"
            >
              <RefreshCw className="w-3.5 h-3.5 mr-1.5" /> Try again
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={dismissDownloadError}
              data-testid="button-dismiss-download-error"
            >
              Dismiss
            </Button>
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="rounded-lg border border-border bg-card p-4 space-y-3">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Filter className="w-4 h-4" /> Filters
        </div>
        <div className="grid gap-3 md:grid-cols-3 lg:grid-cols-6">
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Notification key</label>
            <Select value={keyFilter} onValueChange={setKeyFilter}>
              <SelectTrigger data-testid="filter-key"><SelectValue placeholder="All keys" /></SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All keys</SelectItem>
                {(data?.facets.keys ?? []).map(k => (
                  <SelectItem key={k} value={k}>{k}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Channel</label>
            <Select value={channelFilter} onValueChange={setChannelFilter}>
              <SelectTrigger data-testid="filter-channel"><SelectValue placeholder="All channels" /></SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All channels</SelectItem>
                {(data?.facets.channels ?? []).map(c => (
                  <SelectItem key={c} value={c}>{c}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Status</label>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger data-testid="filter-status"><SelectValue placeholder="All statuses" /></SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>All statuses</SelectItem>
                {(data?.facets.statuses ?? []).map(s => (
                  <SelectItem key={s} value={s}>{s}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <form onSubmit={submitUserQuery}>
            <label className="text-xs text-muted-foreground mb-1 block">Recipient (name / email)</label>
            <Input
              value={userQueryDraft}
              onChange={(e) => setUserQueryDraft(e.target.value)}
              placeholder="Search…"
              data-testid="filter-user-query"
            />
          </form>
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">From</label>
            <Input
              type="datetime-local"
              value={since}
              onChange={(e) => setSince(e.target.value)}
              data-testid="filter-since"
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">To</label>
            <Input
              type="datetime-local"
              value={until}
              onChange={(e) => setUntil(e.target.value)}
              data-testid="filter-until"
            />
          </div>
        </div>
        <div className="flex items-center justify-between pt-2">
          <div className="text-xs text-muted-foreground">
            {data ? `${data.total.toLocaleString()} matching event${data.total === 1 ? "" : "s"}` : "—"}
          </div>
          <Button variant="ghost" size="sm" onClick={clearAllFilters} data-testid="button-clear-filters">
            Clear filters
          </Button>
        </div>
      </div>

      {/* Results */}
      <div className="rounded-lg border border-border bg-card overflow-hidden">
        {isError ? (
          <div className="p-6 flex items-start gap-3 text-sm text-red-300">
            <AlertCircle className="w-5 h-5 flex-shrink-0" />
            <div>
              <div className="font-medium">Could not load notification audit</div>
              <div className="text-xs text-red-300/80 mt-1">{(error as Error).message}</div>
            </div>
          </div>
        ) : isLoading ? (
          <div className="p-10 text-center text-sm text-muted-foreground" data-testid="audit-loading">
            Loading audit log…
          </div>
        ) : !data || data.entries.length === 0 ? (
          <div className="p-10 text-center text-sm text-muted-foreground" data-testid="audit-empty">
            No audit rows match the current filters.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-4 py-2 text-left font-medium">When</th>
                <th className="px-4 py-2 text-left font-medium">Notification key</th>
                <th className="px-4 py-2 text-left font-medium">Recipient</th>
                <th className="px-4 py-2 text-left font-medium">Channel</th>
                <th className="px-4 py-2 text-left font-medium">Status</th>
                <th className="px-4 py-2 text-left font-medium">Reason</th>
                <th className="px-4 py-2 text-right font-medium">Payload</th>
              </tr>
            </thead>
            <tbody>
              {data.entries.map((row) => {
                const isOpen = expanded.has(row.id);
                const recipient = row.userDisplayName || row.username || row.userEmail
                  || (row.userId == null ? "—" : `User #${row.userId}`);
                return (
                  <React.Fragment key={row.id}>
                    <tr className="border-t border-border" data-testid={`audit-row-${row.id}`}>
                      <td className="px-4 py-3 align-top whitespace-nowrap text-xs text-muted-foreground">
                        {new Date(row.createdAt).toLocaleString()}
                      </td>
                      <td className="px-4 py-3 align-top">
                        <code className="text-xs bg-muted/60 rounded px-1.5 py-0.5">{row.notificationKey}</code>
                      </td>
                      <td className="px-4 py-3 align-top">
                        <div className="font-medium" data-testid={`audit-recipient-${row.id}`}>{recipient}</div>
                        {row.userEmail && row.userEmail !== recipient && (
                          <div className="text-xs text-muted-foreground">{row.userEmail}</div>
                        )}
                      </td>
                      <td className="px-4 py-3 align-top">
                        <Badge variant="outline" className="gap-1 capitalize">
                          {NOTIFICATION_CHANNEL_ICON[row.channel] ?? <Inbox className="w-3.5 h-3.5" />}
                          {row.channel}
                        </Badge>
                      </td>
                      <td className="px-4 py-3 align-top">
                        <ChannelStatusBadge status={row.status} data-testid={`audit-status-${row.id}`} />
                      </td>
                      <td className="px-4 py-3 align-top text-xs text-muted-foreground max-w-xs">
                        {row.reason ?? "—"}
                      </td>
                      <td className="px-4 py-3 align-top text-right">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => toggleExpanded(row.id)}
                          data-testid={`audit-toggle-payload-${row.id}`}
                        >
                          {isOpen ? "Hide" : "View"}
                        </Button>
                      </td>
                    </tr>
                    {isOpen && (
                      <tr className="bg-muted/20 border-t border-border">
                        <td colSpan={7} className="px-4 py-3">
                          <pre className="text-xs whitespace-pre-wrap break-words bg-background border border-border rounded p-3 max-h-96 overflow-auto" data-testid={`audit-payload-${row.id}`}>
                            {JSON.stringify(row.payload ?? {}, null, 2)}
                          </pre>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        )}

        {data && data.total > 0 && (
          <div className="flex items-center justify-between border-t border-border bg-muted/20 px-4 py-2 text-xs text-muted-foreground">
            <div>
              Page {data.page} of {totalPages} · {data.total.toLocaleString()} total
            </div>
            <div className="flex items-center gap-1">
              <Button
                size="sm"
                variant="outline"
                disabled={data.page <= 1 || isFetching}
                onClick={() => setPage(p => Math.max(1, p - 1))}
                data-testid="button-prev-page"
              >
                <ChevronLeft className="w-4 h-4" />
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={data.page >= totalPages || isFetching}
                onClick={() => setPage(p => p + 1)}
                data-testid="button-next-page"
              >
                <ChevronRight className="w-4 h-4" />
              </Button>
            </div>
          </div>
        )}
      </div>

      {/*
        Task #1624 — Confirmation gate for "obviously large" downloads.
        We only render the dialog when we have a count to talk about
        (`data` is non-null) so the user never sees an empty/placeholder
        warning.

        Task #2015 — Confirming hands the download off to the same
        fetch + streaming-progress flow the small-file path uses, so
        the in-page progress banner appears instead of a silent,
        opaque browser download for the very exports that take
        longest to stream. The browser still gets a real save dialog
        at the end via the synthesized anchor click in
        `startCsvDownload`.
      */}
      {data && (() => {
        // Task #2007 — Show the estimated download size in the confirm
        // dialog too so admins can decide "should I download this on
        // coffee-shop wifi?" without starting the download. Falls back
        // to the row-only phrasing when the server hasn't supplied a
        // per-row hint yet.
        const estBytes = estimateCsvBytes(data);
        return (
        <AlertDialog
          open={confirmLargeDownload}
          onOpenChange={setConfirmLargeDownload}
        >
          <AlertDialogContent data-testid="dialog-confirm-large-csv">
            <AlertDialogHeader>
              <AlertDialogTitle>
                Download {data.total.toLocaleString()} rows
                {estBytes != null ? (
                  <>
                    {" "}(<span data-testid="text-confirm-csv-size">
                      ~{formatBytes(estBytes)}
                    </span>)
                  </>
                ) : null}
                ?
              </AlertDialogTitle>
              <AlertDialogDescription>
                This export matches{" "}
                <span data-testid="text-confirm-csv-row-count">
                  {data.total.toLocaleString()}
                </span>{" "}
                rows
                {estBytes != null ? (
                  <> (estimated ~{formatBytes(estBytes)})</>
                ) : null}
                {" "}and may take a moment to download. Narrow the
                filters first if you only need a slice of the data.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel data-testid="button-cancel-large-csv">
                Cancel
              </AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  // Task #2015 — fire the same fetch-with-progress
                  // path the small-file button uses; the dialog
                  // closes itself inside `startCsvDownload` so the
                  // progress banner becomes the next thing the
                  // admin sees.
                  void startCsvDownload();
                }}
                disabled={isDownloading}
                data-testid="button-confirm-large-csv"
              >
                Download anyway
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
        );
      })()}
    </div>
  );
}
