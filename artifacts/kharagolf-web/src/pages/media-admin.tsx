import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { useGetMe } from '@workspace/api-client-react';
import {
  Film, AlertTriangle, RefreshCw, Trash2, Send, Loader2, RotateCw, X,
} from 'lucide-react';
import { formatRetryRelative } from '@/lib/formatRetryRelative';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { useActiveOrgContext } from '@/context/ActiveOrgContext';

// Surfaces the rows returned by GET /api/organizations/:orgId/media/unverifiable-videos
// (added in Task #993). The endpoint already enforces admin-only access.
interface UnverifiableVideo {
  id: number;
  objectPath: string;
  thumbnailPath: string | null;
  uploaderName: string | null;
  uploadedByUserId: number | null;
  // Task #1598: surfaced so admins can filter rows by the uploader's
  // email as well as their display name. NULL when the uploader account
  // has no email on file or has been deleted.
  uploaderEmail: string | null;
  tournamentId: number | null;
  leagueId: number | null;
  caption: string | null;
  approved: boolean;
  createdAt: string;
  // Task #1327: timestamp of the most recent on-demand re-probe attempt.
  // NULL until the row has been re-checked at least once via the action
  // below.
  durationLastCheckedAt: string | null;
  // Task #1584: how many times the background `recheckLegacyVideoDurations`
  // cron has already auto-retried this row before giving up. Powers the
  // "auto-retried N times" badge so admins know they don't need to start
  // by clicking Re-check themselves.
  autoRecheckCount: number;
  // Task #1584: why the cron stopped retrying. `object_missing` means the
  // file is gone from storage (so re-upload won't help — usually delete);
  // `permanently_unverifiable` means the file exists but ffprobe still
  // can't read its duration after the retry cap (usually re-upload).
  unverifiableReason: 'object_missing' | 'permanently_unverifiable' | null;
  // Task #1990: most recent re-upload nudge for this row's uploader
  // across all of their rows in this org (MAX(last_reupload_request_at)).
  // Shared across every row owned by the same uploader so the table can
  // disable the per-row "Mark for re-upload" button (and tell the admin
  // when the cooldown lapses) without needing to look at sibling rows.
  // NULL for uploaders we've never nudged or for rows with no uploader
  // on file.
  uploaderLastNudgedAt: string | null;
}

interface UnverifiableResponse {
  count: number;
  items: UnverifiableVideo[];
  truncated: boolean;
  limit: number;
  // Task #1972 — server-supplied per-row re-check cooldown (seconds), so
  // the UI can disable a row's "Re-check" button and show an "available
  // in Ns" hint without hard-coding the policy. Optional for backward
  // compatibility with older API responses; falls back to 60s.
  cooldownSeconds?: number;
  // Task #1990 — server-supplied per-uploader re-upload nudge cooldown
  // (hours). Used by the per-row disabled-state hint and by the bulk
  // confirm dialog so neither has to hard-code the 24h policy. Optional
  // for backward compatibility with older API responses; falls back to
  // REUPLOAD_REQUEST_COOLDOWN_HOURS below.
  reuploadCooldownHours?: number;
}

interface TournamentRow { id: number; name: string }
interface LeagueRow { id: number; name: string }

interface RequestReuploadResult {
  ok: boolean;
  emailed: boolean;
  // Task #1597: 'rate_limited' is set when the uploader was nudged
  // about another (or this same) video within the per-uploader cooldown
  // window — `retryAfterSeconds` tells the UI when the next nudge will
  // be allowed so we can render a friendly countdown.
  reason?: 'no_email' | 'uploader_unknown' | 'rate_limited';
  retryAfterSeconds?: number;
  cooldownHours?: number;
}

// Task #1327: shape returned by the per-row recheck endpoint. Either we
// recovered the duration (and the row drops out of the list on next
// refetch), or we didn't and the reason tells the UI what to say.
// Task #1583: a fourth outcome — we refused to re-probe because the row
// was checked very recently — is surfaced via HTTP 429 and represented
// here as `rateLimited: true`.
type RecheckResult =
  | { ok: true; recovered: true; durationSeconds: number }
  | { ok: true; recovered: false; reason: 'unverifiable' | 'object_missing' | 'probe_error'; error?: string }
  | { rateLimited: true; retryAfterSeconds: number };

interface RecheckAllResult {
  ok: true;
  attempted: number;
  recovered: number;
  stillFailing: number;
  objectMissing: number;
  // Task #1583: rows that were skipped this round because they were
  // probed within the cooldown window. Surfaced in the toast so admins
  // know why fewer rows than expected were re-checked.
  skippedCooldown?: number;
  cooldownSeconds?: number;
  limit: number;
}

interface BulkDeleteResult {
  deletedCount: number;
  errorCount: number;
  action: 'delete';
  deleted: Array<{ id: number }>;
  errors: Array<{ mediaId: number; error: string }>;
}

interface BulkRequestReuploadResult {
  // Number of selected mediaIds covered by an email. With Task #1597's
  // per-uploader de-duplication this is >= uploadersEmailedCount —
  // multiple selected videos for the same uploader collapse into a
  // single email.
  emailedCount: number;
  // Task #1597 — number of distinct emails actually sent (one per
  // uploader). The UI surfaces both so admins see "Emailed N uploaders
  // about M videos" instead of an inflated count.
  uploadersEmailedCount: number;
  skippedCount: number;
  errorCount: number;
  // Task #1597 — the per-uploader rate-limit window the server is
  // enforcing (in hours), so the UI can phrase the cooldown without
  // hard-coding it.
  cooldownHours: number;
  action: 'request-reupload';
  emailed: Array<{ id: number }>;
  // Task #1597 — `rate_limited` rows carry a `retryAfterSeconds` so the
  // UI can show the admin when the same uploader can be nudged again.
  skipped: Array<{
    mediaId: number;
    reason: 'no_email' | 'uploader_unknown' | 'rate_limited';
    retryAfterSeconds?: number;
  }>;
  errors: Array<{ mediaId: number; error: string }>;
}

// Task #1597 — kept in sync with REUPLOAD_REQUEST_COOLDOWN_HOURS in
// artifacts/api-server/src/routes/media.ts. Used by the bulk-action
// confirm dialog (which fires before a response, so it can't pull
// cooldownHours from the server). All other surfaces — the toasts and
// the per-row rate-limited message — still prefer the server-supplied
// `cooldownHours` so the actual policy wins if the two ever drift.
const REUPLOAD_REQUEST_COOLDOWN_HOURS = 24;

// Task #2000 — Allowed values for the "Uploaded older than" filter.
// Kept in sync with the <SelectItem> options below. We validate the URL
// param against this list so a stale or hand-edited link can't poke the
// Select into an unknown value (which Radix would render blank).
const OLDER_THAN_DAYS_OPTIONS = new Set(['any', '7', '30', '90', '180', '365']);

// Task #2000 — Validate the shape of an `event` query value so a stale
// or hand-edited link can't leave the page sitting on an unrecognized
// filter (which would silently match no rows). The accepted shapes
// match what `eventFilterOptions` and the filter logic below produce:
//   - "any"               (no filter)
//   - "none"              (rows with no tournament/league)
//   - "tournament:<int>"  (rows tied to a specific tournament)
//   - "league:<int>"      (rows tied to a specific league)
function isValidEventFilter(value: string): boolean {
  if (value === 'any' || value === 'none') return true;
  const m = value.match(/^(tournament|league):(\d+)$/);
  return !!m && Number.isFinite(Number(m[2]));
}

// Task #2000 — Read the persisted filter values out of the URL on
// initial mount so admins land on (and can share) the same filtered
// view they last had open. We deliberately read from
// `window.location.search` instead of wouter's `useSearch()` so the
// existing wouter mocks in the page's tests don't have to grow a new
// export. Both `older` and `event` are validated so a stale/hand-edited
// link can't poke the page into an undefined state.
// Task #2001 — Allowed values for the `reason` query param. Must stay in
// sync with the <Select> options below and with `unverifiableReason` on
// UnverifiableVideo. Validating against this set means a stale or
// hand-edited link can't poke the filter into an undefined state.
const REASON_FILTER_OPTIONS = new Set(['any', 'object_missing', 'permanently_unverifiable']);

function readFiltersFromUrl(): {
  uploaderQuery: string;
  olderThanDays: string;
  eventFilter: string;
  reasonFilter: string;
} {
  if (typeof window === 'undefined') {
    return { uploaderQuery: '', olderThanDays: 'any', eventFilter: 'any', reasonFilter: 'any' };
  }
  const params = new URLSearchParams(window.location.search);
  const rawOlder = params.get('older') ?? 'any';
  const rawEvent = params.get('event') ?? 'any';
  const rawReason = params.get('reason') ?? 'any';
  return {
    uploaderQuery: params.get('uploader') ?? '',
    olderThanDays: OLDER_THAN_DAYS_OPTIONS.has(rawOlder) ? rawOlder : 'any',
    eventFilter: isValidEventFilter(rawEvent) ? rawEvent : 'any',
    reasonFilter: REASON_FILTER_OPTIONS.has(rawReason) ? rawReason : 'any',
  };
}

// Format a "comes back in X" string for a rate_limited cooldown,
// rounded to the nearest sensible unit so the toast stays readable.
function formatCooldownWait(seconds: number): string {
  if (seconds <= 60) return `${Math.max(1, seconds)} second${seconds === 1 ? '' : 's'}`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.ceil(minutes / 60);
  return `${hours} hour${hours === 1 ? '' : 's'}`;
}

async function j<T = unknown>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({} as { error?: string }));
    throw new Error(body.error ?? res.statusText);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

function formatDate(iso: string): string {
  try { return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }); }
  catch { return iso; }
}

// Task #1972 — Compute how many seconds remain in the per-row re-check
// cooldown given the row's last attempt time and the cooldown window.
// Returns 0 when there's no last attempt or the window has already
// elapsed. Centralised so the button + hint stay in sync.
function recheckCooldownRemainingSeconds(
  lastCheckedAt: string | null,
  cooldownSeconds: number,
  nowMs: number = Date.now(),
): number {
  if (!lastCheckedAt) return 0;
  const t = new Date(lastCheckedAt).getTime();
  if (!Number.isFinite(t)) return 0;
  const elapsed = (nowMs - t) / 1000;
  return Math.max(0, Math.ceil(cooldownSeconds - elapsed));
}

// Task #1983 — Cap how many per-row Re-check requests can be in flight
// against the server at the same time. Each Re-check spawns a server-
// side ffprobe + an object-storage read, so a fast-clicking admin on a
// large backlog used to be able to fan out dozens of parallel requests
// in a heartbeat and saturate the API / egress. The page now keeps at
// most this many running concurrently and queues the rest; queued rows
// drain automatically as in-flight ones finish.
const MAX_CONCURRENT_RECHECKS = 3;

// Task #1972 — Per-row "Re-check" button + cooldown hint. Owns its own
// 1s ticker so only this button re-renders while the cooldown is active
// (the surrounding table doesn't get torn down each second). When the
// row is outside the cooldown window the timer never starts, so idle
// rows stay free. Once the countdown elapses we clear the interval and
// re-enable the button without needing a server refetch — the next
// successful click will refresh durationLastCheckedAt naturally.
//
// Task #1983 — Also renders a "Queued" state for rows that have been
// clicked but are waiting behind the per-page concurrency cap. The
// queued state takes precedence over the cooldown hint (they're
// mutually exclusive — a queued row hasn't been re-probed yet so the
// cooldown can't be active).
function RecheckButton({
  rowId,
  lastCheckedAt,
  cooldownSeconds,
  busy,
  isRechecking,
  isQueued,
  onClick,
}: {
  rowId: number;
  lastCheckedAt: string | null;
  cooldownSeconds: number;
  busy: boolean;
  isRechecking: boolean;
  isQueued: boolean;
  onClick: () => void;
}) {
  const [remaining, setRemaining] = useState<number>(() =>
    recheckCooldownRemainingSeconds(lastCheckedAt, cooldownSeconds),
  );

  useEffect(() => {
    // Re-derive immediately so a fresh row prop (e.g. a refetch that
    // bumped durationLastCheckedAt) takes effect without waiting a tick.
    const initial = recheckCooldownRemainingSeconds(lastCheckedAt, cooldownSeconds);
    setRemaining(initial);
    if (initial <= 0) return;
    const id = setInterval(() => {
      const r = recheckCooldownRemainingSeconds(lastCheckedAt, cooldownSeconds);
      setRemaining(r);
      if (r <= 0) clearInterval(id);
    }, 1000);
    return () => clearInterval(id);
  }, [lastCheckedAt, cooldownSeconds]);

  const inCooldown = remaining > 0;
  return (
    <div className="flex flex-col items-end gap-0.5">
      <Button
        size="sm"
        variant="outline"
        disabled={busy || inCooldown || isQueued || isRechecking}
        onClick={onClick}
        data-testid={`button-recheck-${rowId}`}
      >
        {isRechecking || isQueued
          ? <Loader2 className={`w-3.5 h-3.5 mr-1 ${isRechecking ? 'animate-spin' : 'opacity-60'}`} />
          : <RotateCw className="w-3.5 h-3.5 mr-1" />}
        {isQueued ? 'Queued' : 'Re-check'}
      </Button>
      {isQueued ? (
        <span
          className="text-[10px] text-white/50 leading-none"
          data-testid={`text-recheck-queued-${rowId}`}
        >
          waiting…
        </span>
      ) : inCooldown ? (
        <span
          className="text-[10px] text-white/50 tabular-nums leading-none"
          data-testid={`text-recheck-cooldown-${rowId}`}
        >
          available in {remaining}s
        </span>
      ) : null}
    </div>
  );
}

export default function MediaAdminPage() {
  const { data: user } = useGetMe();
  const { activeOrgId } = useActiveOrgContext();
  const orgId = activeOrgId ?? user?.organizationId;
  const { toast } = useToast();
  const qc = useQueryClient();

  const queryKey = ['media-unverifiable-videos', orgId];

  const { data, isLoading, error, refetch, isFetching } = useQuery<UnverifiableResponse>({
    queryKey,
    enabled: !!orgId,
    queryFn: () => j<UnverifiableResponse>(`/api/organizations/${orgId}/media/unverifiable-videos`),
    refetchInterval: 60 * 1000,
  });

  // Tournament & league name lookups so admins see real names instead of bare ids.
  // Both are best-effort: if either request fails we fall back to "Tournament #12".
  const { data: tournamentsData } = useQuery<TournamentRow[] | { tournaments: TournamentRow[] }>({
    queryKey: ['tournaments-list', orgId],
    enabled: !!orgId,
    queryFn: () => j(`/api/organizations/${orgId}/tournaments`),
    staleTime: 5 * 60 * 1000,
  });

  const { data: leaguesData } = useQuery<LeagueRow[] | { leagues: LeagueRow[] }>({
    queryKey: ['leagues-list', orgId],
    enabled: !!orgId,
    queryFn: () => j(`/api/organizations/${orgId}/leagues`),
    staleTime: 5 * 60 * 1000,
  });

  const tournamentNameMap = useMemo(() => {
    const rows: TournamentRow[] = Array.isArray(tournamentsData)
      ? tournamentsData
      : (tournamentsData?.tournaments ?? []);
    return new Map(rows.map((t) => [t.id, t.name]));
  }, [tournamentsData]);

  const leagueNameMap = useMemo(() => {
    const rows: LeagueRow[] = Array.isArray(leaguesData)
      ? leaguesData
      : (leaguesData?.leagues ?? []);
    return new Map(rows.map((l) => [l.id, l.name]));
  }, [leaguesData]);

  const deleteMutation = useMutation({
    mutationFn: async (mediaId: number) =>
      j(`/api/organizations/${orgId}/media/${mediaId}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast({ title: 'Video deleted' });
      qc.invalidateQueries({ queryKey });
    },
    onError: (err: Error) => toast({ title: 'Delete failed', description: err.message, variant: 'destructive' }),
  });

  const reuploadMutation = useMutation({
    mutationFn: async (mediaId: number) =>
      j<RequestReuploadResult>(`/api/organizations/${orgId}/media/${mediaId}/request-reupload`, {
        method: 'POST',
      }),
    onSuccess: (result) => {
      if (result.emailed) {
        toast({ title: 'Re-upload request sent', description: 'Uploader has been emailed.' });
      } else if (result.reason === 'no_email') {
        toast({
          title: 'Uploader has no email on file',
          description: 'Reach out to them another way, or delete the row.',
          variant: 'destructive',
        });
      } else if (result.reason === 'uploader_unknown') {
        toast({
          title: 'Original uploader is unknown',
          description: 'The uploader account no longer exists — delete the row instead.',
          variant: 'destructive',
        });
      } else if (result.reason === 'rate_limited') {
        // Task #1597 — the per-uploader cooldown also covers the per-row
        // button so a fast-clicking admin can't bypass the bulk
        // protection. Show the wait, not a destructive error: nothing
        // went wrong, the uploader was just nudged recently.
        const wait = formatCooldownWait(result.retryAfterSeconds ?? 0);
        toast({
          title: 'Uploader was just nudged',
          description: `They were already emailed about a video in the last ${result.cooldownHours ?? 24}h. Try again in ${wait}.`,
        });
      }
    },
    onError: (err: Error) => toast({ title: 'Could not notify uploader', description: err.message, variant: 'destructive' }),
  });

  // Task #1983 — Per-page Re-check concurrency cap. The ids waiting
  // for a slot live in `recheckQueue` (FIFO, in click-order) and the
  // ids currently being probed by the server live in
  // `inFlightRecheckIds`. The drain effect below moves ids from the
  // queue into the in-flight set as slots free up. Both are also read
  // by the per-row button to render its "Queued" / spinning state.
  const [recheckQueue, setRecheckQueue] = useState<number[]>([]);
  const [inFlightRecheckIds, setInFlightRecheckIds] = useState<Set<number>>(
    () => new Set(),
  );

  // Task #1327 — per-row "Re-check" action. Re-runs the server-side
  // ffprobe one more time before we bother the uploader; recovers the
  // many rows whose original backfill failed transiently (timeouts,
  // brief storage hiccups). On success the row drops out of the list
  // on next refetch; on failure the row stays with a "last attempted"
  // timestamp so admins can tell it's already been tried.
  const recheckMutation = useMutation({
    // Task #1583: the server rate-limits successive re-checks of the same
    // row to one per cooldown window. A 429 is not a real error from the
    // admin's point of view — it just means "try again in a moment" — so
    // we resolve it as a structured rateLimited result instead of throwing,
    // which keeps the toast variant friendly rather than destructive.
    mutationFn: async (mediaId: number): Promise<RecheckResult> => {
      const res = await fetch(`/api/organizations/${orgId}/media/${mediaId}/recheck-duration`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
      });
      if (res.status === 429) {
        const body = await res.json().catch(() => ({} as { retryAfterSeconds?: number }));
        const retryAfterSeconds = Number(body.retryAfterSeconds ?? res.headers.get('Retry-After') ?? 60) || 60;
        return { rateLimited: true, retryAfterSeconds };
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({} as { error?: string }));
        throw new Error(body.error ?? res.statusText);
      }
      return res.json();
    },
    onSuccess: (result) => {
      if ('rateLimited' in result) {
        const s = result.retryAfterSeconds;
        toast({
          title: 'Tried recently',
          description: `This video was just re-checked. Try again in ${s} second${s === 1 ? '' : 's'}.`,
        });
        // Refetch so the row's "Last re-check" timestamp updates even when
        // the click was bounced.
        qc.invalidateQueries({ queryKey });
        return;
      }
      if (result.recovered) {
        toast({
          title: 'Duration recovered',
          description: `Measured ${result.durationSeconds}s — row removed from list.`,
        });
      } else if (result.reason === 'object_missing') {
        toast({
          title: 'Video file is missing in storage',
          description: 'Re-upload won\'t help — delete the row instead.',
          variant: 'destructive',
        });
      } else {
        toast({
          title: 'Still couldn\'t measure duration',
          description: 'Try again later, or ask the uploader to re-upload.',
          variant: 'destructive',
        });
      }
      qc.invalidateQueries({ queryKey });
    },
    onError: (err: Error) => toast({ title: 'Re-check failed', description: err.message, variant: 'destructive' }),
    // Task #1983 — Whichever way the request settles (success, structured
    // rateLimited, or thrown error) we free this row's slot so the next
    // queued click can dispatch. `variables` is the mediaId that was
    // passed to mutate(), so we can target the right entry without
    // tracking it ourselves.
    onSettled: (_data, _error, mediaId) => {
      setInFlightRecheckIds((prev) => {
        if (!prev.has(mediaId)) return prev;
        const next = new Set(prev);
        next.delete(mediaId);
        return next;
      });
    },
  });

  // Task #1983 — Drain the per-row Re-check queue while there are
  // empty in-flight slots. Runs on every queue/in-flight change: when
  // an admin clicks more rows the queue grows and we top up; when a
  // request settles the in-flight set shrinks and we top up again.
  // Calling `recheckMutation.mutate` per id keeps the existing toast +
  // refetch wiring working unchanged — this hook is purely a scheduler.
  useEffect(() => {
    if (recheckQueue.length === 0) return;
    const free = MAX_CONCURRENT_RECHECKS - inFlightRecheckIds.size;
    if (free <= 0) return;
    const toDispatch = recheckQueue.slice(0, free);
    if (toDispatch.length === 0) return;
    setRecheckQueue((prev) => prev.slice(toDispatch.length));
    setInFlightRecheckIds((prev) => {
      const next = new Set(prev);
      for (const id of toDispatch) next.add(id);
      return next;
    });
    for (const id of toDispatch) {
      recheckMutation.mutate(id);
    }
    // recheckMutation is stable across renders (TanStack Query memoises
    // the returned object's mutate function), so it doesn't need to be
    // a dep — including it would re-run the effect after every settle
    // without changing the inputs we care about.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recheckQueue, inFlightRecheckIds]);

  // Task #1983 — Single entry point for clicking a row's Re-check
  // button. Drops repeats (already queued or already in flight) so a
  // double-click can't double-book the same row.
  const enqueueRecheck = (mediaId: number) => {
    if (inFlightRecheckIds.has(mediaId)) return;
    setRecheckQueue((prev) => (prev.includes(mediaId) ? prev : [...prev, mediaId]));
  };

  const recheckAllMutation = useMutation({
    mutationFn: async () =>
      j<RecheckAllResult>(`/api/organizations/${orgId}/media/recheck-all-durations`, {
        method: 'POST',
      }),
    onSuccess: (result) => {
      const skipped = result.skippedCooldown ?? 0;
      if (result.attempted === 0) {
        if (skipped > 0) {
          // Task #1583 — every remaining row was inside the cooldown window,
          // so nothing was attempted this round. Tell the admin why.
          toast({
            title: 'Skipped — recently re-checked',
            description: `${skipped} video${skipped === 1 ? '' : 's'} were checked in the last minute. Try again shortly.`,
          });
        } else {
          toast({ title: 'Nothing to re-check', description: 'No legacy videos remain.' });
        }
      } else {
        const parts: string[] = [];
        if (result.stillFailing > 0) {
          parts.push(`${result.stillFailing} still couldn\'t be measured${result.objectMissing > 0 ? ` (${result.objectMissing} missing in storage)` : ''}`);
        }
        if (skipped > 0) {
          parts.push(`${skipped} skipped (recently checked)`);
        }
        toast({
          title: `Recovered ${result.recovered} of ${result.attempted}`,
          description: parts.length > 0 ? `${parts.join('; ')}.` : 'All re-checked rows now have a duration.',
        });
      }
      qc.invalidateQueries({ queryKey });
    },
    onError: (err: Error) => toast({ title: 'Re-check all failed', description: err.message, variant: 'destructive' }),
  });

  // Selection state for bulk actions (Task #1326). Mirrors the pattern used
  // in /course-moderation: stale ids that have since been handled by another
  // admin (or filtered out by a refetch) are simply ignored when the bulk
  // action runs, so out-of-band changes don't accidentally re-target rows.
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());

  const bulkDeleteMutation = useMutation({
    mutationFn: async (mediaIds: number[]) =>
      j<BulkDeleteResult>(`/api/organizations/${orgId}/media/unverifiable-videos/bulk-delete`, {
        method: 'POST',
        body: JSON.stringify({ mediaIds }),
      }),
    onSuccess: (result) => {
      if (result.deletedCount > 0) {
        toast({
          title: `Deleted ${result.deletedCount} video${result.deletedCount === 1 ? '' : 's'}`,
          description: result.errorCount > 0
            ? `${result.errorCount} could not be deleted — see below.`
            : undefined,
        });
      }
      if (result.errorCount > 0) {
        const preview = result.errors.slice(0, 3).map((e) => `#${e.mediaId}: ${e.error}`).join('\n');
        const more = result.errors.length > 3 ? `\n…and ${result.errors.length - 3} more.` : '';
        toast({
          title: `${result.errorCount} video${result.errorCount === 1 ? '' : 's'} not deleted`,
          description: preview + more,
          variant: 'destructive',
        });
      }
      // Drop successfully-deleted ids; keep failed ones so the admin can
      // inspect or retry them.
      const handled = new Set(result.deleted.map((d) => d.id));
      setSelectedIds((prev) => {
        const next = new Set<number>();
        for (const id of prev) if (!handled.has(id)) next.add(id);
        return next;
      });
      qc.invalidateQueries({ queryKey });
    },
    onError: (err: Error) => toast({ title: 'Bulk delete failed', description: err.message, variant: 'destructive' }),
  });

  const bulkReuploadMutation = useMutation({
    mutationFn: async (mediaIds: number[]) =>
      j<BulkRequestReuploadResult>(`/api/organizations/${orgId}/media/unverifiable-videos/bulk-request-reupload`, {
        method: 'POST',
        body: JSON.stringify({ mediaIds }),
      }),
    onSuccess: (result) => {
      // Task #1597 — toast copy reflects per-uploader de-duplication:
      // "Emailed 3 uploaders about 12 videos" instead of one toast per
      // mediaId. uploadersEmailedCount is the number of distinct emails
      // that actually went out; emailedCount is the number of selected
      // videos covered by those emails.
      if (result.uploadersEmailedCount > 0) {
        const u = result.uploadersEmailedCount;
        const v = result.emailedCount;
        const desc = u === v
          ? undefined
          : `One email per uploader, listing all of their broken clips.`;
        toast({
          title: `Emailed ${u} uploader${u === 1 ? '' : 's'} about ${v} video${v === 1 ? '' : 's'}`,
          description: desc,
        });
      }
      if (result.skippedCount > 0) {
        const noEmail = result.skipped.filter((s) => s.reason === 'no_email').length;
        const unknown = result.skipped.filter((s) => s.reason === 'uploader_unknown').length;
        const rateLimited = result.skipped.filter((s) => s.reason === 'rate_limited');
        // Task #1597 — surface rate-limited rows separately so the admin
        // knows the skip is intentional (cooldown) rather than a
        // missing-data problem they need to resolve. Friendly tone, not
        // destructive.
        if (rateLimited.length > 0) {
          // Each rate_limited row carries the uploader's remaining
          // cooldown — pick the longest so we don't promise an earlier
          // retry than the slowest uploader allows.
          const maxWait = rateLimited.reduce(
            (m, r) => Math.max(m, r.retryAfterSeconds ?? 0),
            0,
          );
          const wait = formatCooldownWait(maxWait);
          toast({
            title: `${rateLimited.length} skipped — uploader nudged recently`,
            description: `Those uploaders were already emailed in the last ${result.cooldownHours}h. Try again in ${wait}.`,
          });
        }
        const missing: string[] = [];
        if (noEmail > 0) missing.push(`${noEmail} with no email on file`);
        if (unknown > 0) missing.push(`${unknown} with unknown uploader`);
        if (missing.length > 0) {
          toast({
            title: `${noEmail + unknown} uploader${noEmail + unknown === 1 ? '' : 's'} skipped`,
            description: `${missing.join(', ')}. Delete those rows by hand.`,
            variant: 'destructive',
          });
        }
      }
      if (result.errorCount > 0) {
        const preview = result.errors.slice(0, 3).map((e) => `#${e.mediaId}: ${e.error}`).join('\n');
        const more = result.errors.length > 3 ? `\n…and ${result.errors.length - 3} more.` : '';
        toast({
          title: `${result.errorCount} email${result.errorCount === 1 ? '' : 's'} failed`,
          description: preview + more,
          variant: 'destructive',
        });
      }
      // Drop successfully-emailed ids from the selection so the admin can
      // see at a glance which rows still need attention. Rate-limited
      // rows stay selected so the admin can revisit after the cooldown.
      const handled = new Set(result.emailed.map((e) => e.id));
      setSelectedIds((prev) => {
        const next = new Set<number>();
        for (const id of prev) if (!handled.has(id)) next.add(id);
        return next;
      });
      qc.invalidateQueries({ queryKey });
    },
    onError: (err: Error) => toast({ title: 'Bulk re-upload request failed', description: err.message, variant: 'destructive' }),
  });

  const items = data?.items ?? [];
  const count = data?.count ?? 0;
  // Task #1972 — fall back to 60s if the server hasn't surfaced the
  // cooldown yet (e.g. during a rolling deploy). Matches
  // RECHECK_COOLDOWN_SECONDS in artifacts/api-server/src/routes/media.ts.
  const cooldownSeconds = data?.cooldownSeconds ?? 60;
  // Task #1990 — fall back to the local constant when the server hasn't
  // surfaced the per-uploader nudge cooldown yet (rolling deploy). The
  // server value wins when present so the table never disagrees with
  // the bulk-action endpoint about whose cooldown is still active.
  const reuploadCooldownHours = data?.reuploadCooldownHours ?? REUPLOAD_REQUEST_COOLDOWN_HOURS;
  const reuploadCooldownMs = reuploadCooldownHours * 60 * 60 * 1000;

  // Task #1990 — re-derive "now" once a minute so the per-row "Last
  // nudged" relative-time strings and the per-row disabled state both
  // tick down without requiring a refetch. Coarse 60s cadence matches
  // the page's existing refetchInterval and keeps idle pages quiet.
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 60 * 1000);
    return () => clearInterval(id);
  }, []);

  // Task #1990 — given a row's `uploaderLastNudgedAt`, how many ms are
  // left in the per-uploader cooldown. Returns 0 when the row's uploader
  // is outside the cooldown (or has no nudge on file), so the caller can
  // simply check `> 0` to know whether to disable the row.
  const reuploadRemainingMs = (lastNudgedAt: string | null): number => {
    if (!lastNudgedAt) return 0;
    const t = new Date(lastNudgedAt).getTime();
    if (!Number.isFinite(t)) return 0;
    const elapsed = nowMs - t;
    return Math.max(0, reuploadCooldownMs - elapsed);
  };

  // Task #1983 — Snapshot the queue as a Set so per-row lookup in the
  // table render is O(1). The array form is preserved for FIFO ordering
  // in the drain effect.
  const queuedRecheckSet = useMemo(() => new Set(recheckQueue), [recheckQueue]);

  // Task #1598 — Filter controls.
  // Filtering happens client-side over the (capped at 500) result set so we
  // don't have to re-fetch on every keystroke. The same filtered list also
  // scopes the "Select all" checkbox and the bulk action buttons, so an
  // admin who narrows the table to one uploader's batch can act on just
  // those rows without accidentally hitting hidden ones.
  // Task #2000 — Seed initial filter state from the URL so admins working
  // through the backlog over multiple sessions (or after the 60s
  // refetchInterval re-mounts the page) don't have to re-pick the same
  // filters every time, and so a shared link reproduces the view.
  // Task #2001 — Also seeds the new `reasonFilter` from the URL so the
  // "File missing" / "Unreadable file" view persists across reloads
  // and shared links the same way the other filters do.
  const initialFilters = useMemo(() => readFiltersFromUrl(), []);
  const [uploaderQuery, setUploaderQuery] = useState(initialFilters.uploaderQuery);
  const [olderThanDays, setOlderThanDays] = useState<string>(initialFilters.olderThanDays);
  const [eventFilter, setEventFilter] = useState<string>(initialFilters.eventFilter);
  // Task #2001 — Filter by `unverifiableReason` (Task #1584). Lets admins
  // narrow the table to rows the cron has already given up on so they
  // can bulk-delete just the "File missing" backlog (re-upload won't
  // help) or bulk-nudge just the "Unreadable file" rows. Defaults to
  // 'any' so the table looks unchanged until an admin opts in.
  const [reasonFilter, setReasonFilter] = useState<string>(initialFilters.reasonFilter);

  // Task #2000 — Mirror the active filters back into the URL whenever
  // they change so a reload (or a copy-pasted link) restores the same
  // view. We use replaceState rather than pushState so typing in the
  // uploader search box doesn't fill the back-button history with one
  // entry per keystroke. Other query params on the URL (e.g.
  // ?activeOrg=…) are preserved so the link stays portable.
  // Task #2001 — `reason` is mirrored alongside the others so a deep
  // link like `/media-admin?reason=object_missing` opens the page
  // pre-narrowed to just the "File missing" backlog.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const trimmedUploader = uploaderQuery.trim();
    if (trimmedUploader.length > 0) params.set('uploader', trimmedUploader);
    else params.delete('uploader');
    if (olderThanDays !== 'any') params.set('older', olderThanDays);
    else params.delete('older');
    if (eventFilter !== 'any') params.set('event', eventFilter);
    else params.delete('event');
    if (reasonFilter !== 'any') params.set('reason', reasonFilter);
    else params.delete('reason');
    const qs = params.toString();
    const newUrl = `${window.location.pathname}${qs ? `?${qs}` : ''}${window.location.hash}`;
    if (newUrl !== `${window.location.pathname}${window.location.search}${window.location.hash}`) {
      window.history.replaceState(null, '', newUrl);
    }
  }, [uploaderQuery, olderThanDays, eventFilter, reasonFilter]);

  const filteredItems = useMemo(() => {
    const q = uploaderQuery.trim().toLowerCase();
    const days = olderThanDays === 'any' ? null : Number.parseInt(olderThanDays, 10);
    const cutoffMs = days != null && Number.isFinite(days)
      ? Date.now() - days * 24 * 60 * 60 * 1000
      : null;

    return items.filter((row) => {
      if (q.length > 0) {
        const name = row.uploaderName?.toLowerCase() ?? '';
        const email = row.uploaderEmail?.toLowerCase() ?? '';
        if (!name.includes(q) && !email.includes(q)) return false;
      }
      if (cutoffMs != null) {
        const t = new Date(row.createdAt).getTime();
        if (!Number.isFinite(t) || t > cutoffMs) return false;
      }
      if (eventFilter !== 'any') {
        if (eventFilter === 'none') {
          if (row.tournamentId != null || row.leagueId != null) return false;
        } else if (eventFilter.startsWith('tournament:')) {
          const id = Number.parseInt(eventFilter.slice('tournament:'.length), 10);
          if (row.tournamentId !== id) return false;
        } else if (eventFilter.startsWith('league:')) {
          const id = Number.parseInt(eventFilter.slice('league:'.length), 10);
          if (row.leagueId !== id) return false;
        }
      }
      if (reasonFilter !== 'any' && row.unverifiableReason !== reasonFilter) {
        return false;
      }
      return true;
    });
  }, [items, uploaderQuery, olderThanDays, eventFilter, reasonFilter]);

  const filtersActive = uploaderQuery.trim().length > 0
    || olderThanDays !== 'any'
    || eventFilter !== 'any'
    || reasonFilter !== 'any';

  const clearFilters = () => {
    setUploaderQuery('');
    setOlderThanDays('any');
    setEventFilter('any');
    setReasonFilter('any');
  };

  // The set of tournament/league options is derived from the rows we actually
  // have on screen — there's no point offering an event filter that wouldn't
  // match anything. Sorted alphabetically for predictability.
  const eventFilterOptions = useMemo(() => {
    const tournamentIds = new Set<number>();
    const leagueIds = new Set<number>();
    let hasNone = false;
    for (const row of items) {
      if (row.tournamentId != null) tournamentIds.add(row.tournamentId);
      else if (row.leagueId != null) leagueIds.add(row.leagueId);
      else hasNone = true;
    }
    const tournaments = [...tournamentIds]
      .map((id) => ({ value: `tournament:${id}`, label: `🏆 ${tournamentNameMap.get(id) ?? `Tournament #${id}`}` }))
      .sort((a, b) => a.label.localeCompare(b.label));
    const leagues = [...leagueIds]
      .map((id) => ({ value: `league:${id}`, label: `📅 ${leagueNameMap.get(id) ?? `League #${id}`}` }))
      .sort((a, b) => a.label.localeCompare(b.label));
    return { tournaments, leagues, hasNone };
  }, [items, tournamentNameMap, leagueNameMap]);

  // Header checkbox toggles only the rows currently visible (after filters
  // and refresh) and its tri-state mirrors how many of those rows are
  // selected. Bulk actions read the same list so they stay scoped to what
  // the admin can actually see.
  const visibleIds = filteredItems.map((row) => row.id);
  const selectedVisibleCount = visibleIds.reduce((n, id) => (selectedIds.has(id) ? n + 1 : n), 0);
  const allSelected = visibleIds.length > 0 && selectedVisibleCount === visibleIds.length;
  const someSelected = selectedVisibleCount > 0 && !allSelected;

  const toggleAll = (checked: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (checked) for (const id of visibleIds) next.add(id);
      else for (const id of visibleIds) next.delete(id);
      return next;
    });
  };

  const toggleRow = (id: number, checked: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id); else next.delete(id);
      return next;
    });
  };

  const bulkBusy = bulkDeleteMutation.isPending || bulkReuploadMutation.isPending;

  const runBulkDelete = () => {
    const ids = visibleIds.filter((id) => selectedIds.has(id));
    if (ids.length === 0) return;
    if (!window.confirm(`Delete ${ids.length} video${ids.length === 1 ? '' : 's'}? Uploaders will not be notified. This cannot be undone.`)) return;
    bulkDeleteMutation.mutate(ids);
  };

  const runBulkReupload = () => {
    const ids = visibleIds.filter((id) => selectedIds.has(id));
    if (ids.length === 0) return;
    // Task #1597 — preview the per-uploader de-dup so the admin sees
    // ahead of the click how many emails will actually go out (one per
    // uploader, not one per video). We pull uploadedByUserId from the
    // already-loaded list; videos with an unknown uploader and same-id
    // collisions are bucketed naturally by the Set.
    const selectedRows = items.filter((row) => selectedIds.has(row.id));
    const uploaderKeys = new Set<string>();
    for (const row of selectedRows) {
      uploaderKeys.add(row.uploadedByUserId == null ? `m:${row.id}` : `u:${row.uploadedByUserId}`);
    }
    const emailEstimate = uploaderKeys.size;
    // Task #1990 — preview how many of the selected rows will actually
    // be skipped by the per-uploader cooldown. We bucket by uploader
    // (sharing the same `uploaderLastNudgedAt`) so two selected rows for
    // the same in-cooldown uploader count as two skipped, matching what
    // the bulk endpoint will report once it returns.
    let cooldownSkipRows = 0;
    let cooldownSkipUploaders = 0;
    for (const row of selectedRows) {
      if (row.uploadedByUserId == null) continue;
      if (reuploadRemainingMs(row.uploaderLastNudgedAt) > 0) cooldownSkipRows += 1;
    }
    if (cooldownSkipRows > 0) {
      const seen = new Set<number>();
      for (const row of selectedRows) {
        if (row.uploadedByUserId == null) continue;
        if (seen.has(row.uploadedByUserId)) continue;
        if (reuploadRemainingMs(row.uploaderLastNudgedAt) > 0) {
          seen.add(row.uploadedByUserId);
          cooldownSkipUploaders += 1;
        }
      }
    }
    const willEmailRows = ids.length - cooldownSkipRows;
    const summary = emailEstimate === ids.length && cooldownSkipRows === 0
      ? `Send a re-upload email about ${ids.length} video${ids.length === 1 ? '' : 's'}?`
      : `Send up to ${emailEstimate} email${emailEstimate === 1 ? '' : 's'} (one per uploader, listing all of their videos) about ${ids.length} selected videos?`;
    const cooldownNote = cooldownSkipRows > 0
      ? `${cooldownSkipRows} of ${ids.length} selected video${ids.length === 1 ? '' : 's'} (${cooldownSkipUploaders} uploader${cooldownSkipUploaders === 1 ? '' : 's'}) will be skipped — already nudged in the last ${reuploadCooldownHours}h. ${willEmailRows} will be emailed.`
      : `Uploaders nudged in the last ${reuploadCooldownHours} hours will be skipped — you can revisit them after the cooldown.`;
    if (!window.confirm(`${summary}\n\n${cooldownNote}`)) return;
    bulkReuploadMutation.mutate(ids);
  };

  return (
    <div className="container mx-auto px-4 py-6 max-w-6xl" data-testid="media-admin-page">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Film className="w-6 h-6 text-amber-400" />
            Unverifiable videos
          </h1>
          <p className="text-sm text-white/60 mt-1">
            Legacy uploads whose duration we couldn't measure. The background job has
            already auto-retried each row several times — the badge on each row shows
            how many attempts. Rows tagged <span className="font-medium text-white/80">File missing</span>{' '}
            need to be deleted (the storage object is gone, so a re-upload won't help);
            rows tagged <span className="font-medium text-white/80">Unreadable file</span>{' '}
            usually need a fresh upload from the player.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="default"
            size="sm"
            onClick={() => recheckAllMutation.mutate()}
            disabled={recheckAllMutation.isPending || items.length === 0}
            data-testid="button-recheck-all"
          >
            {recheckAllMutation.isPending
              ? <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              : <RotateCw className="w-4 h-4 mr-2" />}
            Re-check all
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => refetch()}
            disabled={isFetching}
            data-testid="button-refresh"
          >
            {isFetching ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <RefreshCw className="w-4 h-4 mr-2" />}
            Refresh
          </Button>
        </div>
      </div>

      <Card className="mb-6">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <AlertTriangle className="w-4 h-4 text-amber-400" />
            Backlog
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-baseline gap-3">
            <span className="text-3xl font-bold tabular-nums" data-testid="text-unverifiable-count">{count}</span>
            <span className="text-sm text-white/60">
              video{count === 1 ? '' : 's'} need attention
            </span>
            {data?.truncated && (
              <Badge variant="outline" className="ml-2">
                Showing first {data.limit}
              </Badge>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Task #1598 — Filter controls. Hidden when there's nothing on screen
          to filter, so the empty state isn't crowded with disabled inputs. */}
      {items.length > 0 && (
        <Card className="mb-4" data-testid="filter-controls">
          <CardContent className="pt-6">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <div className="space-y-1.5">
                <Label htmlFor="filter-uploader" className="text-xs uppercase tracking-wide text-white/60">
                  Uploader (name or email)
                </Label>
                <Input
                  id="filter-uploader"
                  type="search"
                  placeholder="Search by name or email…"
                  value={uploaderQuery}
                  onChange={(e) => setUploaderQuery(e.target.value)}
                  data-testid="input-filter-uploader"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="filter-age" className="text-xs uppercase tracking-wide text-white/60">
                  Uploaded
                </Label>
                <Select value={olderThanDays} onValueChange={setOlderThanDays}>
                  <SelectTrigger id="filter-age" data-testid="select-filter-age">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="any">Any time</SelectItem>
                    <SelectItem value="7">Older than 7 days</SelectItem>
                    <SelectItem value="30">Older than 30 days</SelectItem>
                    <SelectItem value="90">Older than 90 days</SelectItem>
                    <SelectItem value="180">Older than 180 days</SelectItem>
                    <SelectItem value="365">Older than 1 year</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="filter-event" className="text-xs uppercase tracking-wide text-white/60">
                  Tournament / League
                </Label>
                <Select value={eventFilter} onValueChange={setEventFilter}>
                  <SelectTrigger id="filter-event" data-testid="select-filter-event">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="any">All events</SelectItem>
                    {eventFilterOptions.hasNone && (
                      <SelectItem value="none">No event linked</SelectItem>
                    )}
                    {eventFilterOptions.tournaments.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                    ))}
                    {eventFilterOptions.leagues.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {/* Task #2001 — Reason filter. Mirrors the badges rendered
                  on each row (Task #1584) so admins can isolate the
                  "File missing" backlog (delete-only) or the
                  "Unreadable file" backlog (re-upload nudge) and act on
                  just those rows in one bulk pass. */}
              <div className="space-y-1.5">
                <Label htmlFor="filter-reason" className="text-xs uppercase tracking-wide text-white/60">
                  Reason
                </Label>
                <Select value={reasonFilter} onValueChange={setReasonFilter}>
                  <SelectTrigger id="filter-reason" data-testid="select-filter-reason">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="any">All reasons</SelectItem>
                    <SelectItem value="object_missing">File missing (delete only)</SelectItem>
                    <SelectItem value="permanently_unverifiable">Unreadable file (re-upload)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            {filtersActive && (
              <div className="mt-3 flex items-center justify-end">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={clearFilters}
                  data-testid="button-clear-filters"
                >
                  <X className="w-3.5 h-3.5 mr-1.5" />
                  Clear filters
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {error && (
        <Card className="mb-6 border-red-500/30 bg-red-500/5">
          <CardContent className="pt-6 text-sm text-red-300">
            Couldn't load the list: {(error as Error).message}
          </CardContent>
        </Card>
      )}

      {isLoading && (
        <div className="flex items-center justify-center py-12 text-white/60">
          <Loader2 className="w-5 h-5 mr-2 animate-spin" /> Loading…
        </div>
      )}

      {!isLoading && items.length === 0 && !error && (
        <Card>
          <CardContent className="py-12 text-center text-white/60">
            <Film className="w-10 h-10 mx-auto mb-3 text-white/20" />
            <p>Nothing to clean up — every video on file has a known duration.</p>
          </CardContent>
        </Card>
      )}

      {items.length > 0 && (
        <>
          {/* Filtered-count summary above the table. Always shown when there
              are rows on screen so admins know how broad their selection is
              before they hit a bulk action. */}
          <div
            className="mb-3 flex items-center justify-between text-sm text-white/70"
            data-testid="filter-summary"
          >
            <span>
              {filtersActive ? (
                <>
                  Showing{' '}
                  <span className="font-medium tabular-nums text-white" data-testid="text-filtered-count">
                    {filteredItems.length}
                  </span>{' '}
                  of <span className="tabular-nums">{items.length}</span> video{items.length === 1 ? '' : 's'} on this page
                </>
              ) : (
                <>
                  Showing{' '}
                  <span className="font-medium tabular-nums text-white" data-testid="text-filtered-count">
                    {items.length}
                  </span>{' '}
                  video{items.length === 1 ? '' : 's'}
                </>
              )}
            </span>
          </div>

          {filteredItems.length === 0 && (
            <Card data-testid="empty-filtered">
              <CardContent className="py-10 text-center text-white/60">
                <p>No videos match the current filters.</p>
                <Button
                  variant="link"
                  className="mt-2"
                  onClick={clearFilters}
                  data-testid="button-clear-filters-empty"
                >
                  Clear filters
                </Button>
              </CardContent>
            </Card>
          )}

          {selectedVisibleCount > 0 && filteredItems.length > 0 && (
            <div
              className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-white/10 bg-white/5 px-4 py-3"
              data-testid="bulk-action-bar"
            >
              <span className="text-sm text-white/80">
                <span className="font-medium tabular-nums" data-testid="text-selected-count">
                  {selectedVisibleCount}
                </span>{' '}
                selected
              </span>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={runBulkReupload}
                  disabled={bulkBusy}
                  data-testid="button-bulk-reupload"
                >
                  {bulkReuploadMutation.isPending
                    ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                    : <Send className="w-3.5 h-3.5 mr-1.5" />}
                  {bulkReuploadMutation.isPending
                    ? `Emailing ${selectedVisibleCount}…`
                    : `Request re-upload (${selectedVisibleCount})`}
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={runBulkDelete}
                  disabled={bulkBusy}
                  data-testid="button-bulk-delete"
                >
                  {bulkDeleteMutation.isPending
                    ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                    : <Trash2 className="w-3.5 h-3.5 mr-1.5" />}
                  {bulkDeleteMutation.isPending
                    ? `Deleting ${selectedVisibleCount}…`
                    : `Delete selected (${selectedVisibleCount})`}
                </Button>
              </div>
            </div>
          )}

          {filteredItems.length > 0 && (
          <div className="overflow-x-auto rounded-lg border border-white/10">
            <table className="w-full text-sm" data-testid="table-unverifiable-videos">
              <thead className="bg-white/5 text-left text-xs uppercase tracking-wide text-white/60">
                <tr>
                  <th className="px-3 py-2 w-10">
                    <Checkbox
                      checked={allSelected ? true : (someSelected ? 'indeterminate' : false)}
                      onCheckedChange={(c) => toggleAll(c === true)}
                      data-testid="checkbox-select-all"
                      aria-label="Select all visible videos"
                      disabled={bulkBusy}
                    />
                  </th>
                  <th className="px-3 py-2">Uploader</th>
                  <th className="px-3 py-2">Tournament / League</th>
                  <th className="px-3 py-2">Created</th>
                  <th className="px-3 py-2">Last re-check</th>
                  {/* Task #1990 — surface the per-uploader nudge cooldown
                      so admins can see which rows will be skipped before
                      they click. Shared across all of an uploader's rows. */}
                  <th className="px-3 py-2">Last nudged</th>
                  <th className="px-3 py-2">Caption</th>
                  <th className="px-3 py-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {filteredItems.map((row) => {
                  const eventLabel = row.tournamentId
                    ? `🏆 ${tournamentNameMap.get(row.tournamentId) ?? `Tournament #${row.tournamentId}`}`
                    : row.leagueId
                      ? `📅 ${leagueNameMap.get(row.leagueId) ?? `League #${row.leagueId}`}`
                      : '—';
                  const isDeleting = deleteMutation.isPending && deleteMutation.variables === row.id;
                  const isNotifying = reuploadMutation.isPending && reuploadMutation.variables === row.id;
                  // Task #1983 — Per-row Re-check state now reads from the
                  // queue + in-flight tracking we own (instead of
                  // recheckMutation.variables, which only reflects the
                  // latest of however many parallel mutate() calls are
                  // running and would otherwise mis-report state when
                  // multiple rows are being re-checked at once).
                  const isRechecking = inFlightRecheckIds.has(row.id);
                  const isQueuedForRecheck = queuedRecheckSet.has(row.id);
                  const isSelected = selectedIds.has(row.id);
                  const busy = isDeleting || isNotifying || isRechecking || isQueuedForRecheck || recheckAllMutation.isPending || bulkBusy;
                  // Task #1990 — disable the per-row "Mark for re-upload"
                  // button while the uploader is inside the per-uploader
                  // cooldown so admins find out before they click rather
                  // than discovering the skip in the response toast. The
                  // bulk action enforces the same window server-side.
                  const reuploadRemaining = reuploadRemainingMs(row.uploaderLastNudgedAt);
                  const inReuploadCooldown = reuploadRemaining > 0;
                  const reuploadCooldownTitle = inReuploadCooldown
                    ? `This uploader was already nudged ${formatRetryRelative(row.uploaderLastNudgedAt, nowMs) ?? 'recently'}. Available again ${formatRetryRelative(new Date(nowMs + reuploadRemaining).toISOString(), nowMs) ?? `in ${reuploadCooldownHours}h`}.`
                    : undefined;

                  return (
                    <tr
                      key={row.id}
                      data-testid={`row-video-${row.id}`}
                      className={`hover:bg-white/5 ${isSelected ? 'bg-white/5' : ''}`}
                    >
                      <td className="px-3 py-2 align-top">
                        <Checkbox
                          checked={isSelected}
                          onCheckedChange={(c) => toggleRow(row.id, c === true)}
                          data-testid={`checkbox-video-${row.id}`}
                          aria-label={`Select video ${row.id}`}
                          disabled={bulkBusy}
                        />
                      </td>
                      <td className="px-3 py-2">
                        <div className="font-medium">{row.uploaderName ?? 'Unknown'}</div>
                        {row.uploadedByUserId && (
                          <div className="text-xs text-white/40">user #{row.uploadedByUserId}</div>
                        )}
                        {/* Task #1584: surface why the cron stopped retrying
                            this row + how many attempts it already made, so
                            admins can pick the right action (delete vs.
                            re-upload) without clicking Re-check first. */}
                        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                          {row.unverifiableReason === 'object_missing' ? (
                            <Badge
                              variant="destructive"
                              className="text-[10px] font-medium uppercase tracking-wide"
                              data-testid={`badge-reason-${row.id}`}
                              title="The storage object is missing — re-upload won't help. Delete the row."
                            >
                              File missing
                            </Badge>
                          ) : row.unverifiableReason === 'permanently_unverifiable' ? (
                            <Badge
                              variant="outline"
                              className="border-amber-400/50 text-amber-300 text-[10px] font-medium uppercase tracking-wide"
                              data-testid={`badge-reason-${row.id}`}
                              title="The file exists but ffprobe still can't read its duration. Ask the uploader to re-upload."
                            >
                              Unreadable file
                            </Badge>
                          ) : null}
                          {/* Always render the count, even when it's 0,
                              so admins can tell at a glance that this row
                              made it onto the list without the cron ever
                              successfully retrying it (vs. the typical
                              case where the cron exhausted its budget). */}
                          <Badge
                            variant="outline"
                            className="text-[10px] font-medium text-white/70"
                            data-testid={`badge-auto-retried-${row.id}`}
                            title="The background job already retried this row this many times before giving up."
                          >
                            Auto-retried {row.autoRecheckCount}×
                          </Badge>
                        </div>
                      </td>
                      <td className="px-3 py-2">{eventLabel}</td>
                      <td className="px-3 py-2 whitespace-nowrap">{formatDate(row.createdAt)}</td>
                      <td className="px-3 py-2 whitespace-nowrap text-white/70" data-testid={`text-last-recheck-${row.id}`}>
                        {row.durationLastCheckedAt
                          ? formatDate(row.durationLastCheckedAt)
                          : <span className="text-white/30">Never tried</span>}
                      </td>
                      {/* Task #1990 — "Last nudged" column. Mirrors how
                          "Last re-check" is rendered: relative time on
                          the front line (since the per-uploader cooldown
                          is what admins care about) with the absolute
                          timestamp in the title for hover. Shows the
                          remaining cooldown when the row is still inside
                          the window so admins can decide whether to wait
                          or deselect. */}
                      <td className="px-3 py-2 whitespace-nowrap text-white/70" data-testid={`text-uploader-nudged-${row.id}`}>
                        {row.uploaderLastNudgedAt ? (
                          <div className="flex flex-col leading-tight">
                            <span title={formatDate(row.uploaderLastNudgedAt)}>
                              {formatRetryRelative(row.uploaderLastNudgedAt, nowMs) ?? formatDate(row.uploaderLastNudgedAt)}
                            </span>
                            {inReuploadCooldown && (
                              <span
                                className="text-[10px] text-amber-300/80 tabular-nums"
                                data-testid={`text-uploader-cooldown-${row.id}`}
                              >
                                cooldown · available {formatRetryRelative(new Date(nowMs + reuploadRemaining).toISOString(), nowMs) ?? `in ${reuploadCooldownHours}h`}
                              </span>
                            )}
                          </div>
                        ) : (
                          <span className="text-white/30">Never</span>
                        )}
                      </td>
                      <td className="px-3 py-2 max-w-xs truncate text-white/80">{row.caption ?? <span className="text-white/30">—</span>}</td>
                      <td className="px-3 py-2">
                        <div className="flex items-start justify-end gap-2">
                          <RecheckButton
                            rowId={row.id}
                            lastCheckedAt={row.durationLastCheckedAt}
                            cooldownSeconds={cooldownSeconds}
                            busy={busy}
                            isRechecking={isRechecking}
                            isQueued={isQueuedForRecheck}
                            onClick={() => enqueueRecheck(row.id)}
                          />
                          {/* Task #1990 — disable + tooltip while the
                              uploader is inside the per-uploader nudge
                              cooldown. We use a span wrapper so the
                              title still shows on hover even when the
                              underlying button is disabled (most
                              browsers suppress titles on disabled
                              elements). */}
                          <span title={reuploadCooldownTitle} data-testid={`wrap-reupload-${row.id}`}>
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={busy || inReuploadCooldown}
                              onClick={() => reuploadMutation.mutate(row.id)}
                              data-testid={`button-reupload-${row.id}`}
                              aria-disabled={busy || inReuploadCooldown}
                              aria-label={inReuploadCooldown
                                ? `Mark for re-upload (uploader in cooldown — available again in about ${reuploadCooldownHours}h)`
                                : 'Mark for re-upload'}
                            >
                              {isNotifying ? <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" /> : <Send className="w-3.5 h-3.5 mr-1" />}
                              Mark for re-upload
                            </Button>
                          </span>
                          <Button
                            size="sm"
                            variant="destructive"
                            disabled={busy}
                            onClick={() => {
                              if (confirm('Delete this video record? The uploader will not be notified.')) {
                                deleteMutation.mutate(row.id);
                              }
                            }}
                            data-testid={`button-delete-${row.id}`}
                          >
                            {isDeleting ? <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" /> : <Trash2 className="w-3.5 h-3.5 mr-1" />}
                            Delete
                          </Button>
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
