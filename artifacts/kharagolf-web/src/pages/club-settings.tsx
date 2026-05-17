import React, { useState, useEffect, useRef } from 'react';
import { useGetMe } from '@workspace/api-client-react';
import { useActiveOrgId } from '@/context/ActiveOrgContext';
import { useToast } from '@/hooks/use-toast';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  FileText, Upload, Download, Trash2, Edit3, Plus, FolderOpen,
  Shield, Users, Eye, Loader2, AlertTriangle, Mail, BellOff
} from 'lucide-react';

const BASE_URL = (import.meta.env.BASE_URL ?? '/').replace(/\/$/, '');
function apiUrl(path: string) { return `${BASE_URL}/api${path}`; }

interface Doc {
  id: number;
  title: string;
  category: string;
  visibility: string;
  filename: string | null;
  contentType: string | null;
  fileSize: number | null;
  objectPath: string;
  createdAt: string;
  updatedAt: string;
}

const CATEGORIES: { value: string; label: string }[] = [
  { value: 'local_rules', label: 'Local Rules' },
  { value: 'pace_of_play', label: 'Pace of Play' },
  { value: 'policy', label: 'Policy' },
  { value: 'general', label: 'General' },
  { value: 'results', label: 'Results' },
  { value: 'notice', label: 'Notice' },
];

const CATEGORY_COLORS: Record<string, string> = {
  local_rules: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30',
  pace_of_play: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
  policy: 'bg-violet-500/20 text-violet-400 border-violet-500/30',
  general: 'bg-gray-500/20 text-gray-400 border-gray-500/30',
  results: 'bg-amber-500/20 text-amber-400 border-amber-500/30',
  notice: 'bg-rose-500/20 text-rose-400 border-rose-500/30',
};

function formatBytes(bytes: number | null): string {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getCategoryLabel(cat: string) {
  return CATEGORIES.find(c => c.value === cat)?.label ?? cat;
}

// ─── Bounced-reminders email digest preferences (Task #274) ──────────────────
// Lets each org pick the cadence (daily / weekday / weekly) and a preferred
// local hour + IANA timezone for the bounced-levy reminders email digest.
// Defaults preserve the legacy "daily, server time" behaviour.
type BouncedDigestPrefs = {
  frequency: 'daily' | 'weekday' | 'weekly';
  hourLocal: number | null;
  timezone: string | null;
  lastSentOn: string | null;
};

const FREQUENCY_OPTIONS: { value: BouncedDigestPrefs['frequency']; label: string; help: string }[] = [
  { value: 'daily', label: 'Daily', help: 'Every day at the chosen hour.' },
  { value: 'weekday', label: 'Weekdays only', help: 'Mon–Fri at the chosen hour.' },
  { value: 'weekly', label: 'Weekly (Mondays)', help: 'Mondays at the chosen hour.' },
];

// Curated short-list of common IANA zones — admins can also paste any other
// IANA name into the field (the API validates it via Intl.DateTimeFormat).
const COMMON_TIMEZONES: string[] = [
  'UTC',
  'Asia/Kolkata', 'Asia/Dubai', 'Asia/Singapore', 'Asia/Tokyo', 'Asia/Bangkok',
  'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Europe/Madrid',
  'Africa/Johannesburg', 'Africa/Lagos',
  'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
  'America/Sao_Paulo', 'Australia/Sydney',
];

// Task #387 — surface who has opted out of the schedule-change heads-up
// emails so org admins know which recipients have silenced just those
// notifications (the regular digest still arrives for them).
type ScheduleChangeOptOut = {
  userId: number;
  email: string | null;
  displayName: string;
  optedOutAt: string;
};

// Task #513 — audit trail of dispatched schedule-change heads-up emails
// (recipients + timestamp) so admins can answer "did Jane get the email?"
// Task #947 — `lastResendAt` + `resendCooldownSeconds` let the UI show a
// precise countdown and disable the per-row Resend button until the
// server-side cooldown elapses (survives page refresh because both fields
// come from the database row).
type ScheduleChangeSend = {
  id: number;
  sentAt: string;
  recipients: Array<{ userId: number; email: string; displayName: string }>;
  lastResendAt: string | null;
  resendCooldownSeconds: number;
  changedBy: { userId: number; displayName: string; email: string | null } | null;
};

// Task #947 — fallback so UI cooldown logic still works against an older
// API server that hasn't started returning `resendCooldownSeconds` yet.
const DEFAULT_RESEND_COOLDOWN_SECONDS = 60;

function resendCooldownRemainingSeconds(send: ScheduleChangeSend, nowMs: number): number {
  if (!send.lastResendAt) return 0;
  const cooldownMs = (send.resendCooldownSeconds || DEFAULT_RESEND_COOLDOWN_SECONDS) * 1000;
  const elapsedMs = nowMs - new Date(send.lastResendAt).getTime();
  if (!Number.isFinite(elapsedMs)) return 0;
  const remainingMs = cooldownMs - elapsedMs;
  if (remainingMs <= 0) return 0;
  return Math.ceil(remainingMs / 1000);
}

function formatSentAt(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

function ScheduleChangeOptOutsCard({ orgId }: { orgId: number }) {
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [allowed, setAllowed] = useState(true);
  const [rows, setRows] = useState<ScheduleChangeOptOut[]>([]);
  const [sends, setSends] = useState<ScheduleChangeSend[]>([]);
  const [resubscribing, setResubscribing] = useState<Record<number, boolean>>({});
  const [resending, setResending] = useState<Record<number, boolean>>({});
  // Task #812 — confirm before re-emailing the original recipient list so
  // admins exploring earlier sends can't fat-finger a fresh broadcast.
  const [confirmResend, setConfirmResend] = useState<ScheduleChangeSend | null>(null);
  // Task #947 — re-render every second while any send is inside the
  // cooldown window so the per-row "Resend available in Ns" label ticks
  // down smoothly. The cooldown itself is server-side; this is purely a
  // display refresh.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!sends.some(s => resendCooldownRemainingSeconds(s, Date.now()) > 0)) return;
    const t = setInterval(() => {
      const next = Date.now();
      setNowMs(next);
      // Stop ticking once every row has cleared its cooldown so we don't
      // re-render the whole card forever after the last countdown ends.
      if (!sends.some(s => resendCooldownRemainingSeconds(s, next) > 0)) {
        clearInterval(t);
      }
    }, 1000);
    return () => clearInterval(t);
  }, [sends]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    Promise.all([
      fetch(apiUrl(`/organizations/${orgId}/bounced-digest-schedule-opt-outs`), { credentials: 'include' })
        .then(async r => {
          if (!alive) return;
          if (r.status === 401 || r.status === 403) { setAllowed(false); return; }
          if (!r.ok) return;
          setRows(await r.json());
        }),
      fetch(apiUrl(`/organizations/${orgId}/bounced-digest-schedule-sends`), { credentials: 'include' })
        .then(async r => {
          if (!alive) return;
          if (r.status === 401 || r.status === 403) { setAllowed(false); return; }
          if (!r.ok) return;
          setSends(await r.json());
        }),
    ]).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [orgId]);

  // Task #512 — admin-side re-subscribe: clear the opt-out row so the next
  // schedule-change notification reaches this user again.
  const resubscribe = async (userId: number, label: string) => {
    setResubscribing(prev => ({ ...prev, [userId]: true }));
    try {
      const res = await fetch(
        apiUrl(`/organizations/${orgId}/bounced-digest-schedule-opt-outs/${userId}`),
        { method: 'DELETE', credentials: 'include' },
      );
      if (!res.ok && res.status !== 204) {
        const err = await res.json().catch(() => ({}));
        toast({ title: err.error ?? 'Failed to re-subscribe', variant: 'destructive' });
        return;
      }
      setRows(prev => prev.filter(r => r.userId !== userId));
      toast({ title: `${label} re-subscribed` });
    } finally {
      setResubscribing(prev => {
        const next = { ...prev };
        delete next[userId];
        return next;
      });
    }
  };

  // Task #655 — admin-triggered re-dispatch of a previous schedule-change
  // heads-up email to its original recipient list. The endpoint writes a
  // fresh audit row but leaves persisted schedule preferences untouched.
  const resend = async (sendId: number) => {
    setResending(prev => ({ ...prev, [sendId]: true }));
    try {
      const res = await fetch(
        apiUrl(`/organizations/${orgId}/bounced-digest-schedule-sends/${sendId}/resend`),
        { method: 'POST', credentials: 'include' },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        // Task #947 — when the server says we're inside the cooldown
        // window, stamp the matching row's `lastResendAt` from the 429
        // payload so the per-row Resend button immediately disables itself
        // and the countdown label takes over (no more retry-and-toast
        // loops). Falls back to a generic toast if the server response
        // didn't include the new fields.
        if (res.status === 429 && (typeof data.retryAfterSeconds === 'number' || typeof data.lastResendAt === 'string')) {
          const cooldownSeconds = typeof data.cooldownSeconds === 'number'
            ? data.cooldownSeconds
            : DEFAULT_RESEND_COOLDOWN_SECONDS;
          const derivedLastResendIso = typeof data.lastResendAt === 'string' && data.lastResendAt
            ? data.lastResendAt
            : new Date(Date.now() - Math.max(0, (cooldownSeconds - (data.retryAfterSeconds ?? cooldownSeconds))) * 1000).toISOString();
          setSends(prev => prev.map(s => s.id === sendId
            ? { ...s, lastResendAt: derivedLastResendIso, resendCooldownSeconds: cooldownSeconds }
            : s));
          setNowMs(Date.now());
          toast({
            title: 'Resend available shortly',
            description: typeof data.retryAfterSeconds === 'number'
              ? `Try again in ${data.retryAfterSeconds}s.`
              : 'Please wait a moment before resending again.',
            variant: 'destructive',
          });
          return;
        }
        toast({ title: data.error ?? 'Failed to resend', variant: 'destructive' });
        return;
      }
      const cooldownSeconds = typeof data.resendCooldownSeconds === 'number'
        ? data.resendCooldownSeconds
        : DEFAULT_RESEND_COOLDOWN_SECONDS;
      const newSend: ScheduleChangeSend = {
        id: data.id,
        sentAt: data.sentAt,
        recipients: data.recipients ?? [],
        lastResendAt: typeof data.lastResendAt === 'string' ? data.lastResendAt : null,
        resendCooldownSeconds: cooldownSeconds,
        changedBy: data.changedBy ?? null,
      };
      // Task #947 — also stamp the originating row so its Resend button
      // disables for the cooldown window. The server returns the exact
      // `last_resend_at` it just claimed, so the countdown is accurate.
      const resentFromIso = typeof data.resentFromLastResendAt === 'string'
        ? data.resentFromLastResendAt
        : new Date().toISOString();
      setSends(prev => [
        newSend,
        ...prev.map(s => s.id === sendId
          ? { ...s, lastResendAt: resentFromIso, resendCooldownSeconds: cooldownSeconds }
          : s),
      ]);
      setNowMs(Date.now());
      toast({
        title: 'Schedule-change email resent',
        description: `${newSend.recipients.length} recipient${newSend.recipients.length === 1 ? '' : 's'} notified.`,
      });
    } finally {
      setResending(prev => {
        const next = { ...prev };
        delete next[sendId];
        return next;
      });
    }
  };

  if (!allowed) return null;

  const lastSend = sends[0] ?? null;

  return (
    <>
      <Card className="glass-card mt-4" data-testid="card-schedule-change-last-send">
        <CardHeader className="pb-3">
          <CardTitle className="text-white flex items-center gap-2 text-sm">
            <Mail className="w-4 h-4 text-amber-400" /> Schedule-change notifications — last sent
          </CardTitle>
          <p className="text-xs text-muted-foreground mt-1">
            Audit trail of the most recent schedule-change heads-up emails. Use this
            to confirm a specific recipient was actually notified.
          </p>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex items-center gap-2 text-muted-foreground py-2 text-xs">
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading…
            </div>
          ) : !lastSend ? (
            <p className="text-xs text-muted-foreground" data-testid="text-no-schedule-sends">
              No schedule-change notification has been sent yet.
            </p>
          ) : (
            <div data-testid="block-schedule-last-send">
              <div className="flex items-center justify-between text-xs mb-2 gap-2">
                <span className="text-white">
                  Last sent <span data-testid="text-last-sent-at">{formatSentAt(lastSend.sentAt)}</span>
                  {lastSend.changedBy ? (
                    <span className="text-muted-foreground"> — triggered by {lastSend.changedBy.displayName}</span>
                  ) : null}
                </span>
                <span className="flex items-center gap-2">
                  <span className="text-muted-foreground" data-testid="text-last-sent-count">
                    {lastSend.recipients.length} recipient{lastSend.recipients.length === 1 ? '' : 's'}
                  </span>
                  {(() => {
                    const remaining = resendCooldownRemainingSeconds(lastSend, nowMs);
                    const onCooldown = remaining > 0;
                    return (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-6 px-2 text-xs"
                        disabled={!!resending[lastSend.id] || onCooldown}
                        onClick={() => setConfirmResend(lastSend)}
                        data-testid={`button-resend-send-${lastSend.id}`}
                        title={onCooldown
                          ? `Resend available in ${remaining}s`
                          : 'Re-dispatch this notification to the same recipient list'}
                      >
                        {resending[lastSend.id]
                          ? <Loader2 className="w-3 h-3 animate-spin" />
                          : onCooldown
                            ? <span data-testid={`text-resend-cooldown-${lastSend.id}`}>Resend in {remaining}s</span>
                            : 'Resend'}
                      </Button>
                    );
                  })()}
                </span>
              </div>
              <ul className="space-y-1.5" data-testid="list-last-sent-recipients">
                {lastSend.recipients.map(r => (
                  <li key={r.userId} className="flex items-center justify-between text-xs">
                    <span className="text-white">{r.displayName}</span>
                    <span className="text-muted-foreground">{r.email}</span>
                  </li>
                ))}
              </ul>
              {sends.length > 1 ? (
                <details className="mt-3 text-xs">
                  <summary className="text-muted-foreground cursor-pointer hover:text-white" data-testid="toggle-earlier-sends">
                    Show {sends.length - 1} earlier send{sends.length - 1 === 1 ? '' : 's'}
                  </summary>
                  <ul className="mt-2 space-y-1.5" data-testid="list-earlier-sends">
                    {sends.slice(1).map(s => {
                      const remaining = resendCooldownRemainingSeconds(s, nowMs);
                      const onCooldown = remaining > 0;
                      return (
                        <li key={s.id} className="flex items-center justify-between text-xs gap-2">
                          <span className="text-white">{formatSentAt(s.sentAt)}</span>
                          <span className="flex items-center gap-2">
                            <span className="text-muted-foreground">
                              {s.recipients.length} recipient{s.recipients.length === 1 ? '' : 's'}
                              {s.changedBy ? ` · ${s.changedBy.displayName}` : ''}
                            </span>
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-6 px-2 text-xs"
                              disabled={!!resending[s.id] || onCooldown}
                              onClick={() => setConfirmResend(s)}
                              data-testid={`button-resend-send-${s.id}`}
                              title={onCooldown
                                ? `Resend available in ${remaining}s`
                                : 'Re-dispatch this notification to the same recipient list'}
                            >
                              {resending[s.id]
                                ? <Loader2 className="w-3 h-3 animate-spin" />
                                : onCooldown
                                  ? <span data-testid={`text-resend-cooldown-${s.id}`}>Resend in {remaining}s</span>
                                  : 'Resend'}
                            </Button>
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </details>
              ) : null}
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="glass-card mt-4" data-testid="card-schedule-change-opt-outs">
        <CardHeader className="pb-3">
          <CardTitle className="text-white flex items-center gap-2 text-sm">
            <Mail className="w-4 h-4 text-amber-400" /> Schedule-change notifications — opted out
          </CardTitle>
          <p className="text-xs text-muted-foreground mt-1">
            These recipients clicked “Unsubscribe from schedule-change emails” in a
            previous notification. They still receive the regular bounced-levy digest.
          </p>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex items-center gap-2 text-muted-foreground py-2 text-xs">
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading…
            </div>
          ) : rows.length === 0 ? (
            <p className="text-xs text-muted-foreground" data-testid="text-no-schedule-opt-outs">
              No one has opted out of schedule-change notifications.
            </p>
          ) : (
            <ul className="space-y-1.5" data-testid="list-schedule-opt-outs">
              {rows.map(r => (
                <li key={r.userId} className="flex items-center justify-between text-xs gap-3">
                  <span className="text-white">
                    {r.displayName}
                    {r.email ? <span className="text-muted-foreground ml-2">{r.email}</span> : null}
                  </span>
                  <span className="flex items-center gap-3">
                    <span className="text-muted-foreground">
                      {new Date(r.optedOutAt).toLocaleDateString()}
                    </span>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-6 px-2 text-xs"
                      disabled={!!resubscribing[r.userId]}
                      onClick={() => resubscribe(r.userId, r.displayName)}
                      data-testid={`button-resubscribe-${r.userId}`}
                    >
                      {resubscribing[r.userId] ? (
                        <Loader2 className="w-3 h-3 animate-spin" />
                      ) : (
                        'Re-subscribe'
                      )}
                    </Button>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <AlertDialog
        open={confirmResend !== null}
        onOpenChange={open => { if (!open) setConfirmResend(null); }}
      >
        <AlertDialogContent data-testid="dialog-confirm-resend">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirmResend
                ? `Resend to ${confirmResend.recipients.length} ${confirmResend.recipients.length === 1 ? 'person' : 'people'}?`
                : 'Resend?'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirmResend ? (
                <>
                  This will re-email everyone on the original recipient list from the
                  send on <span data-testid="text-confirm-resend-sent-at">{formatSentAt(confirmResend.sentAt)}</span>.
                </>
              ) : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-resend">Cancel</AlertDialogCancel>
            <AlertDialogAction
              data-testid="button-confirm-resend"
              disabled={confirmResend ? !!resending[confirmResend.id] : false}
              onClick={() => {
                if (!confirmResend) return;
                const target = confirmResend;
                setConfirmResend(null);
                void resend(target.id);
              }}
            >
              Resend email
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

// Task #1208 — Mirrors ScheduleChangeOptOutsCard above, but for the
// round-robin tie-break required alert email (Task #898 + opt-out toggle
// from Task #1045). Lets an org_admin / tournament_director see which
// directors have unsubscribed from that email and re-subscribe them on
// their behalf when chasing "I never got the tie-break alert" reports.
type TieBreakEmailOptOut = {
  userId: number;
  email: string | null;
  displayName: string;
  optedOutAt: string;
};

function TieBreakEmailOptOutsCard({ orgId }: { orgId: number }) {
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [allowed, setAllowed] = useState(true);
  const [rows, setRows] = useState<TieBreakEmailOptOut[]>([]);
  const [resubscribing, setResubscribing] = useState<Record<number, boolean>>({});

  useEffect(() => {
    let alive = true;
    setLoading(true);
    fetch(apiUrl(`/organizations/${orgId}/tie-break-email-opt-outs`), { credentials: 'include' })
      .then(async r => {
        if (!alive) return;
        if (r.status === 401 || r.status === 403) { setAllowed(false); return; }
        if (!r.ok) return;
        setRows(await r.json());
      })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [orgId]);

  const resubscribe = async (userId: number, label: string) => {
    setResubscribing(prev => ({ ...prev, [userId]: true }));
    try {
      const res = await fetch(
        apiUrl(`/organizations/${orgId}/tie-break-email-opt-outs/${userId}`),
        { method: 'DELETE', credentials: 'include' },
      );
      if (!res.ok && res.status !== 204) {
        const err = await res.json().catch(() => ({}));
        toast({ title: err.error ?? 'Failed to re-subscribe', variant: 'destructive' });
        return;
      }
      setRows(prev => prev.filter(r => r.userId !== userId));
      toast({ title: `${label} re-subscribed` });
    } finally {
      setResubscribing(prev => {
        const next = { ...prev };
        delete next[userId];
        return next;
      });
    }
  };

  if (!allowed) return null;

  return (
    <Card className="glass-card" data-testid="card-tie-break-email-opt-outs">
      <CardHeader className="pb-3">
        <CardTitle className="text-white flex items-center gap-2 text-sm">
          <BellOff className="w-4 h-4 text-amber-400" /> Tie-break alert emails — opted out
        </CardTitle>
        <p className="text-xs text-muted-foreground mt-1">
          These directors clicked “Unsubscribe” in a previous round-robin tie-break alert
          email, so they no longer receive that email for this organization. They still
          receive the in-app inbox and push notifications.
        </p>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="flex items-center gap-2 text-muted-foreground py-2 text-xs">
            <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading…
          </div>
        ) : rows.length === 0 ? (
          <p className="text-xs text-muted-foreground" data-testid="text-no-tie-break-opt-outs">
            No one has opted out of tie-break alert emails.
          </p>
        ) : (
          <ul className="space-y-1.5" data-testid="list-tie-break-opt-outs">
            {rows.map(r => (
              <li key={r.userId} className="flex items-center justify-between text-xs gap-3">
                <span className="text-white">
                  {r.displayName}
                  {r.email ? <span className="text-muted-foreground ml-2">{r.email}</span> : null}
                </span>
                <span className="flex items-center gap-3">
                  <span className="text-muted-foreground">
                    {new Date(r.optedOutAt).toLocaleDateString()}
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-6 px-2 text-xs"
                    disabled={!!resubscribing[r.userId]}
                    onClick={() => resubscribe(r.userId, r.displayName)}
                    data-testid={`button-resubscribe-tie-break-${r.userId}`}
                  >
                    {resubscribing[r.userId] ? (
                      <Loader2 className="w-3 h-3 animate-spin" />
                    ) : (
                      'Re-subscribe'
                    )}
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function BouncedDigestPrefsCard({ orgId }: { orgId: number }) {
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [allowed, setAllowed] = useState(true);
  const [prefs, setPrefs] = useState<BouncedDigestPrefs>({
    frequency: 'daily', hourLocal: null, timezone: null, lastSentOn: null,
  });

  useEffect(() => {
    let alive = true;
    setLoading(true);
    fetch(apiUrl(`/organizations/${orgId}/bounced-digest-prefs`), { credentials: 'include' })
      .then(async r => {
        if (!alive) return;
        if (r.status === 401 || r.status === 403) { setAllowed(false); return; }
        if (!r.ok) return;
        const data = await r.json() as BouncedDigestPrefs;
        setPrefs({
          frequency: (data.frequency ?? 'daily') as BouncedDigestPrefs['frequency'],
          hourLocal: data.hourLocal ?? null,
          timezone: data.timezone ?? null,
          lastSentOn: data.lastSentOn ?? null,
        });
      })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [orgId]);

  if (!allowed) return null;

  const save = async () => {
    setSaving(true);
    try {
      const res = await fetch(apiUrl(`/organizations/${orgId}/bounced-digest-prefs`), {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          frequency: prefs.frequency,
          hourLocal: prefs.hourLocal,
          timezone: prefs.timezone,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast({ title: err.error ?? 'Failed to save preferences', variant: 'destructive' });
        return;
      }
      const updated: BouncedDigestPrefs = await res.json();
      setPrefs({
        frequency: (updated.frequency ?? 'daily') as BouncedDigestPrefs['frequency'],
        hourLocal: updated.hourLocal ?? null,
        timezone: updated.timezone ?? null,
        lastSentOn: updated.lastSentOn ?? null,
      });
      toast({ title: 'Digest schedule updated' });
    } finally {
      setSaving(false);
    }
  };

  const sendPreview = async () => {
    setPreviewing(true);
    try {
      const res = await fetch(apiUrl(`/organizations/${orgId}/bounced-digest-prefs/preview`), {
        method: 'POST',
        credentials: 'include',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast({ title: data.error ?? 'Failed to send preview', variant: 'destructive' });
        return;
      }
      toast({
        title: 'Preview sent',
        description: data.sentTo ? `Check ${data.sentTo} for the digest preview.` : undefined,
      });
    } finally {
      setPreviewing(false);
    }
  };

  return (
    <Card className="glass-card" data-testid="card-bounced-digest-prefs">
      <CardHeader className="pb-3">
        <CardTitle className="text-white flex items-center gap-2">
          <Mail className="w-4 h-4 text-amber-400" /> Bounced-Reminders Email Digest
        </CardTitle>
        <p className="text-xs text-muted-foreground mt-1">
          We email member-admins a summary of unresolved bounced levy reminders.
          Pick the cadence and preferred local hour for your club.
        </p>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="flex items-center gap-2 text-muted-foreground py-4">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading preferences…
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="text-xs text-muted-foreground uppercase tracking-wider">Frequency</label>
              <Select
                value={prefs.frequency}
                onValueChange={v => setPrefs(p => ({ ...p, frequency: v as BouncedDigestPrefs['frequency'] }))}
              >
                <SelectTrigger
                  data-testid="select-digest-frequency"
                  className="mt-1 bg-black/40 border-white/10 text-white"
                ><SelectValue /></SelectTrigger>
                <SelectContent className="bg-[#0a1628] border-white/10 text-white">
                  {FREQUENCY_OPTIONS.map(o => (
                    <SelectItem key={o.value} value={o.value} className="text-white hover:bg-white/5">
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground mt-1">
                {FREQUENCY_OPTIONS.find(o => o.value === prefs.frequency)?.help}
              </p>
            </div>

            <div>
              <label className="text-xs text-muted-foreground uppercase tracking-wider">Local hour</label>
              <Select
                value={prefs.hourLocal == null ? 'any' : String(prefs.hourLocal)}
                onValueChange={v => setPrefs(p => ({ ...p, hourLocal: v === 'any' ? null : parseInt(v, 10) }))}
              >
                <SelectTrigger
                  data-testid="select-digest-hour"
                  className="mt-1 bg-black/40 border-white/10 text-white"
                ><SelectValue /></SelectTrigger>
                <SelectContent className="bg-[#0a1628] border-white/10 text-white max-h-72">
                  <SelectItem value="any" className="text-white hover:bg-white/5">
                    Any time (first cron tick of the day)
                  </SelectItem>
                  {Array.from({ length: 24 }).map((_, h) => (
                    <SelectItem key={h} value={String(h)} className="text-white hover:bg-white/5">
                      {String(h).padStart(2, '0')}:00
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div>
              <label className="text-xs text-muted-foreground uppercase tracking-wider">Timezone</label>
              <Input
                data-testid="input-digest-timezone"
                value={prefs.timezone ?? ''}
                onChange={e => setPrefs(p => ({ ...p, timezone: e.target.value.trim() || null }))}
                placeholder="Asia/Kolkata"
                list="bounced-digest-tz-list"
                className="mt-1 bg-black/40 border-white/10 text-white"
              />
              <datalist id="bounced-digest-tz-list">
                {COMMON_TIMEZONES.map(tz => <option key={tz} value={tz} />)}
              </datalist>
              <p className="text-[11px] text-muted-foreground mt-1">
                IANA timezone name. Leave blank to use server time (UTC).
              </p>
            </div>
          </div>
        )}

        {!loading && (
          <div className="flex items-center justify-between mt-5">
            <p className="text-[11px] text-muted-foreground">
              {prefs.lastSentOn
                ? `Last digest sent on ${prefs.lastSentOn} (local).`
                : 'No digest has been sent under the current schedule yet.'}
            </p>
            <div className="flex items-center gap-2">
              <Button
                data-testid="button-preview-digest-now"
                onClick={sendPreview}
                disabled={previewing || saving}
                variant="outline"
                className="bg-transparent border-amber-500/40 text-amber-200 hover:bg-amber-500/10"
                title="Send a one-off copy of the digest to your own email. Does not affect the regular schedule."
              >
                {previewing ? <><Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" /> Sending…</> : 'Send me a preview now'}
              </Button>
              <Button
                data-testid="button-save-digest-prefs"
                onClick={save}
                disabled={saving}
                className="bg-amber-600 hover:bg-amber-700 text-white"
              >
                {saving ? <><Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" /> Saving…</> : 'Save schedule'}
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// Task #1188 / #1379 / #1673 — Org-wide notification defaults card.
//
// The card is driven by a small registry (`ORG_NOTIFY_DEFAULTS` below)
// of supported org-wide notification toggles. Each entry maps a wire
// key to its UI labels + copy and the API endpoints handle the same
// keys generically (see lib/orgNotificationDefaults.ts on the server).
// To add a new org-wide default in the future:
//   1) Add the org + tournament boolean columns in lib/db.
//   2) Append the key to the API registry.
//   3) Append a UI entry below.
// No new endpoint, no new card layout.
//
// Each toggle row ships its own:
//   - club-wide switch (PATCH /notification-defaults)
//   - inheritance summary ("X of Y match the club default")
//   - "Apply to all (N)" affordance (POST /apply-to-tournaments with that key)
//
// When more than one toggle currently diverges from its club-wide
// default the card additionally surfaces an "Apply all divergent (N)"
// affordance whose confirmation lists every key being changed and
// applies them in a single POST.
//
// The card self-hides when the GET returns 401/403 so non-admins never
// see a settings card they can't actually use.
type OrgNotifyDefaultKey =
  | 'notifyManualEntryAlerts'
  | 'notifyScheduleChanges'
  | 'notifyScoreCorrections';

interface OrgNotifyDefaultUiSpec {
  key: OrgNotifyDefaultKey;
  /** Heading shown above the toggle. */
  label: string;
  /** Body copy under the heading. */
  description: string;
  /** Used in toasts / dialog headlines: "Mute X club-wide?". */
  shortName: string;
  /** Per-tournament badge label when on / muted. */
  enabledBadge: string;
  mutedBadge: string;
  /** Switch aria-label. */
  switchAriaLabel: string;
  /** Toast description copy when the club-wide value flips on/off. */
  enabledToastDescription: string;
  mutedToastDescription: string;
  /** Description for the "Applied to N tournaments" toast. */
  enabledApplyToastDescription: string;
  mutedApplyToastDescription: string;
  /** Inheritance summary verb, e.g. "send manual-entry alerts". */
  summaryVerb: string;
  /** test-id stem so existing e2e selectors continue to work. */
  testIdSlug: string;
}

const ORG_NOTIFY_DEFAULTS: readonly OrgNotifyDefaultUiSpec[] = [
  {
    key: 'notifyManualEntryAlerts',
    label: 'Manual-entry round alerts',
    description:
      'When a round is countersigned with more than 50% of shots entered by hand (rather than from a watch), tournament directors get a push + email so they can review for data quality. Mute here to silence the alert across every tournament in the club — useful for clubs that run lots of casual social events where manual entry is the norm.',
    shortName: 'manual-entry alerts',
    enabledBadge: 'Alerts on',
    mutedBadge: 'Muted',
    switchAriaLabel: 'Send manual-entry alerts club-wide',
    enabledToastDescription:
      'Tournament directors will get a push + email when a round is scored mostly by hand.',
    mutedToastDescription:
      'No manual-entry alerts will be sent for any tournament in this club.',
    enabledApplyToastDescription:
      'Manual-entry alerts are now enabled on the matching tournaments.',
    mutedApplyToastDescription:
      'Manual-entry alerts are now muted on the matching tournaments.',
    summaryVerb: 'send manual-entry alerts',
    testIdSlug: 'manual-entry',
  },
  {
    key: 'notifyScheduleChanges',
    label: 'Schedule-change alerts',
    description:
      'When start/end dates, round times, or registration deadlines shift after a tournament is published, tournament directors get a push + email so they can re-broadcast the change to entrants. Mute here for clubs running standing weekly leagues where minor reschedules are routine and already announced through other channels.',
    shortName: 'schedule-change alerts',
    enabledBadge: 'Alerts on',
    mutedBadge: 'Muted',
    switchAriaLabel: 'Send schedule-change alerts club-wide',
    enabledToastDescription:
      'Tournament directors will get a push + email when a published event\u2019s schedule shifts.',
    mutedToastDescription:
      'No schedule-change alerts will be sent for any tournament in this club.',
    enabledApplyToastDescription:
      'Schedule-change alerts are now enabled on the matching tournaments.',
    mutedApplyToastDescription:
      'Schedule-change alerts are now muted on the matching tournaments.',
    summaryVerb: 'send schedule-change alerts',
    testIdSlug: 'schedule-changes',
  },
  {
    key: 'notifyScoreCorrections',
    label: 'Score-correction alerts',
    description:
      'When an admin edits a previously-finalized scorecard, tournament directors get a push + email so they can audit the change. Mute here for clubs that resolve corrections informally and don\u2019t need a per-edit notification.',
    shortName: 'score-correction alerts',
    enabledBadge: 'Alerts on',
    mutedBadge: 'Muted',
    switchAriaLabel: 'Send score-correction alerts club-wide',
    enabledToastDescription:
      'Tournament directors will get a push + email when a finalized scorecard is edited.',
    mutedToastDescription:
      'No score-correction alerts will be sent for any tournament in this club.',
    enabledApplyToastDescription:
      'Score-correction alerts are now enabled on the matching tournaments.',
    mutedApplyToastDescription:
      'Score-correction alerts are now muted on the matching tournaments.',
    summaryVerb: 'send score-correction alerts',
    testIdSlug: 'score-corrections',
  },
];

// Per-tournament row returned by GET /notification-defaults/tournaments.
// The response carries every registered key as its own boolean column
// per row so the card can pre-compute the per-toggle inheritance
// summary in one round trip.
type NotifyDefaultsTournament = {
  id: number;
  name: string;
  status: 'draft' | 'upcoming' | 'active' | 'suspended';
  startDate: string | null;
} & Record<OrgNotifyDefaultKey, boolean>;

type OrgDefaultsState = Record<OrgNotifyDefaultKey, boolean>;

function defaultDefaultsState(): OrgDefaultsState {
  // Server-side default for every flag is `true` (see schema). Mirror
  // it here so the card renders sensibly during the brief loading window.
  const out = {} as OrgDefaultsState;
  for (const spec of ORG_NOTIFY_DEFAULTS) out[spec.key] = true;
  return out;
}

function OrgNotificationDefaultsCard({ orgId }: { orgId: number }) {
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  // `savingKey` tracks which switch is mid-flight so we can disable just
  // that switch (rather than every switch on the card) during a PATCH.
  const [savingKey, setSavingKey] = useState<OrgNotifyDefaultKey | null>(null);
  const [allowed, setAllowed] = useState(true);
  const [defaults, setDefaults] = useState<OrgDefaultsState>(defaultDefaultsState);
  const [tournaments, setTournaments] = useState<NotifyDefaultsTournament[]>([]);
  // `confirmApply` is either `null` (closed) or a list of keys to apply.
  // A single-key confirmation comes from the per-row "Apply to all"
  // button; a multi-key confirmation comes from the master "Apply all
  // divergent" button — same dialog, same POST, just a different key set.
  const [confirmApply, setConfirmApply] = useState<OrgNotifyDefaultKey[] | null>(null);
  const [applying, setApplying] = useState(false);

  const loadTournaments = async () => {
    const r = await fetch(
      apiUrl(`/organizations/${orgId}/notification-defaults/tournaments`),
      { credentials: 'include' },
    );
    if (!r.ok) return;
    const data = await r.json() as { tournaments?: NotifyDefaultsTournament[] };
    setTournaments(data.tournaments ?? []);
  };

  useEffect(() => {
    let alive = true;
    setLoading(true);
    Promise.all([
      fetch(apiUrl(`/organizations/${orgId}/notification-defaults`), { credentials: 'include' })
        .then(async r => {
          if (!alive) return;
          if (r.status === 401 || r.status === 403) { setAllowed(false); return; }
          if (!r.ok) return;
          const data = await r.json() as Partial<OrgDefaultsState>;
          setDefaults(prev => {
            const next = { ...prev };
            for (const spec of ORG_NOTIFY_DEFAULTS) {
              const v = data[spec.key];
              if (typeof v === 'boolean') next[spec.key] = v;
            }
            return next;
          });
        }),
      fetch(apiUrl(`/organizations/${orgId}/notification-defaults/tournaments`), { credentials: 'include' })
        .then(async r => {
          if (!alive) return;
          if (!r.ok) return;
          const data = await r.json() as { tournaments?: NotifyDefaultsTournament[] };
          setTournaments(data.tournaments ?? []);
        }),
    ]).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [orgId]);

  if (!allowed) return null;

  // Optimistic toggle: flip the local state immediately, persist in
  // the background, revert + toast on failure. Snappy because the
  // toggle has no preview / dependent state to wait on.
  const onToggle = async (spec: OrgNotifyDefaultUiSpec, next: boolean) => {
    const prev = defaults[spec.key];
    setDefaults(d => ({ ...d, [spec.key]: next }));
    setSavingKey(spec.key);
    try {
      const res = await fetch(apiUrl(`/organizations/${orgId}/notification-defaults`), {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [spec.key]: next }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setDefaults(d => ({ ...d, [spec.key]: prev }));
        toast({ title: err.error ?? 'Failed to update setting', variant: 'destructive' });
        return;
      }
      const verb = next ? 'enabled' : 'muted';
      toast({
        title: `${capitalize(spec.shortName)} ${verb} club-wide`,
        description: next ? spec.enabledToastDescription : spec.mutedToastDescription,
      });
    } finally {
      setSavingKey(null);
    }
  };

  // Bulk-apply the supplied keys' org-wide values to every still-
  // relevant tournament. Same POST whether triggered from a per-row
  // button (one key) or the master multi-default confirm.
  const onApplyKeys = async (keys: OrgNotifyDefaultKey[]) => {
    if (keys.length === 0) return;
    setApplying(true);
    try {
      const body: Record<string, boolean> = {};
      for (const k of keys) body[k] = defaults[k];
      const res = await fetch(
        apiUrl(`/organizations/${orgId}/notification-defaults/apply-to-tournaments`),
        {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast({ title: data.error ?? 'Failed to apply to tournaments', variant: 'destructive' });
        return;
      }
      const results = Array.isArray(data.results)
        ? data.results as Array<{ key: OrgNotifyDefaultKey; value: boolean; updatedCount: number }>
        : [];

      // Toast copy: when one key was applied, lean on its on/off body
      // copy. When multiple were applied, summarise the totals.
      if (keys.length === 1) {
        const spec = ORG_NOTIFY_DEFAULTS.find(s => s.key === keys[0])!;
        const r = results.find(r => r.key === keys[0]);
        const count = r?.updatedCount ?? 0;
        toast({
          title: count === 0
            ? 'All tournaments already match the club-wide default'
            : `Applied to ${count} tournament${count === 1 ? '' : 's'}`,
          description: defaults[spec.key]
            ? spec.enabledApplyToastDescription
            : spec.mutedApplyToastDescription,
        });
      } else {
        const totalChanged = results.reduce((acc, r) => acc + r.updatedCount, 0);
        toast({
          title: totalChanged === 0
            ? 'All tournaments already match the club-wide defaults'
            : `Applied ${keys.length} default${keys.length === 1 ? '' : 's'} (${totalChanged} update${totalChanged === 1 ? '' : 's'})`,
          description: results
            .filter(r => r.updatedCount > 0)
            .map(r => {
              const spec = ORG_NOTIFY_DEFAULTS.find(s => s.key === r.key);
              const name = spec?.shortName ?? r.key;
              return `${name}: ${r.updatedCount}`;
            })
            .join(' · ') || 'No tournaments needed updating.',
        });
      }
      await loadTournaments();
    } finally {
      setApplying(false);
    }
  };

  // Pre-compute per-key inheritance buckets so render stays declarative.
  type Bucket = {
    spec: OrgNotifyDefaultUiSpec;
    enabledCount: number;
    mutedCount: number;
    divergentCount: number;
  };
  const totalTournaments = tournaments.length;
  const buckets: Bucket[] = ORG_NOTIFY_DEFAULTS.map(spec => {
    const enabled = tournaments.filter(t => t[spec.key]).length;
    const divergent = tournaments.filter(t => t[spec.key] !== defaults[spec.key]).length;
    return {
      spec,
      enabledCount: enabled,
      mutedCount: totalTournaments - enabled,
      divergentCount: divergent,
    };
  });
  const divergentBuckets = buckets.filter(b => b.divergentCount > 0);
  const totalDivergent = divergentBuckets.reduce((acc, b) => acc + b.divergentCount, 0);

  // The confirmation dialog reuses the same per-key bucket data so its
  // copy and counts always agree with the rendered card.
  const confirmKeys = confirmApply ?? [];
  const confirmBuckets = buckets.filter(b => confirmKeys.includes(b.spec.key));
  const confirmTotal = confirmBuckets.reduce((acc, b) => acc + b.divergentCount, 0);

  // Task #2087 — preview list of every tournament whose value will flip
  // when the admin confirms. Computed once per render (cheap; we already
  // have `tournaments`). Keyed by spec key so the dialog can render a
  // per-default sub-list when multiple defaults are being applied.
  const confirmAffectedByKey: Record<string, NotifyDefaultsTournament[]> = {};
  for (const b of confirmBuckets) {
    confirmAffectedByKey[b.spec.key] = tournaments.filter(
      t => t[b.spec.key] !== defaults[b.spec.key],
    );
  }

  return (
    <Card className="glass-card" data-testid="card-org-notification-defaults">
      <CardHeader className="pb-3">
        <CardTitle className="text-white flex items-center gap-2">
          <BellOff className="w-4 h-4 text-amber-400" /> Club-wide Notification Defaults
        </CardTitle>
        <p className="text-xs text-muted-foreground mt-1">
          Defaults that apply to every tournament in this club. New events
          inherit these at creation time.
        </p>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="flex items-center gap-2 text-muted-foreground py-2">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading defaults…
          </div>
        ) : (
          <div className="space-y-4">
            {ORG_NOTIFY_DEFAULTS.map((spec, idx) => {
              const bucket = buckets[idx];
              const value = defaults[spec.key];
              const dataIdx = spec.testIdSlug;
              return (
                <div
                  key={spec.key}
                  className={idx === 0 ? '' : 'border-t border-white/10 pt-4'}
                  data-testid={`block-org-notify-${dataIdx}`}
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-white">
                        {spec.label}
                      </div>
                      <p className="text-xs text-muted-foreground mt-1">
                        {spec.description}
                      </p>
                    </div>
                    <Switch
                      data-testid={spec.key === 'notifyManualEntryAlerts'
                        ? 'switch-org-notify-manual-entry'
                        : `switch-org-notify-${dataIdx}`}
                      checked={value}
                      onCheckedChange={(next) => onToggle(spec, next)}
                      disabled={savingKey !== null}
                      aria-label={spec.switchAriaLabel}
                    />
                  </div>

                  <div
                    className="mt-3"
                    data-testid={spec.key === 'notifyManualEntryAlerts'
                      ? 'block-tournament-inheritance'
                      : `block-tournament-inheritance-${dataIdx}`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-xs font-medium text-white">
                          Existing tournaments
                        </div>
                        <p className="text-xs text-muted-foreground mt-1">
                          The club-wide toggle only affects new events. Existing
                          tournaments keep whatever per-tournament setting they
                          had — review them here to make sure they match your
                          intent.
                        </p>
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 px-2 text-xs whitespace-nowrap"
                        disabled={applying || savingKey !== null
                          || totalTournaments === 0
                          || bucket.divergentCount === 0}
                        onClick={() => setConfirmApply([spec.key])}
                        data-testid={spec.key === 'notifyManualEntryAlerts'
                          ? 'button-apply-to-tournaments'
                          : `button-apply-to-tournaments-${dataIdx}`}
                        title={totalTournaments === 0
                          ? 'No active tournaments to update'
                          : bucket.divergentCount === 0
                            ? 'Every active tournament already matches the club-wide default'
                            : `Set ${bucket.divergentCount} tournament${bucket.divergentCount === 1 ? '' : 's'} to match the club-wide default`}
                      >
                        {applying
                          ? <Loader2 className="w-3 h-3 animate-spin" />
                          : `Apply to all (${bucket.divergentCount})`}
                      </Button>
                    </div>

                    {totalTournaments === 0 ? (
                      <p
                        className="text-xs text-muted-foreground mt-3"
                        data-testid={spec.key === 'notifyManualEntryAlerts'
                          ? 'text-no-active-tournaments'
                          : `text-no-active-tournaments-${dataIdx}`}
                      >
                        No active tournaments in this club.
                      </p>
                    ) : (
                      <>
                        <div
                          className="flex flex-wrap items-center gap-2 mt-3 text-xs"
                          data-testid={spec.key === 'notifyManualEntryAlerts'
                            ? 'block-inheritance-counts'
                            : `block-inheritance-counts-${dataIdx}`}
                        >
                          <span
                            className="text-white"
                            data-testid={spec.key === 'notifyManualEntryAlerts'
                              ? 'text-inheritance-summary'
                              : `text-inheritance-summary-${dataIdx}`}
                          >
                            <span data-testid={spec.key === 'notifyManualEntryAlerts'
                              ? 'text-inheritance-enabled-count'
                              : `text-inheritance-enabled-count-${dataIdx}`}>{bucket.enabledCount}</span>
                            {' of '}
                            <span data-testid={spec.key === 'notifyManualEntryAlerts'
                              ? 'text-inheritance-total-count'
                              : `text-inheritance-total-count-${dataIdx}`}>{totalTournaments}</span>
                            {' active tournament'}
                            {totalTournaments === 1 ? '' : 's'}
                            {' '}{spec.summaryVerb}
                            {bucket.mutedCount > 0 ? (
                              <>
                                {' ('}
                                <span data-testid={spec.key === 'notifyManualEntryAlerts'
                                  ? 'text-inheritance-muted-count'
                                  : `text-inheritance-muted-count-${dataIdx}`}>{bucket.mutedCount}</span>
                                {' muted)'}
                              </>
                            ) : null}
                            .
                          </span>
                          {bucket.divergentCount > 0 ? (
                            <Badge
                              variant="outline"
                              className="border-amber-500/40 text-amber-300 bg-amber-500/10"
                              data-testid={spec.key === 'notifyManualEntryAlerts'
                                ? 'badge-inheritance-divergent'
                                : `badge-inheritance-divergent-${dataIdx}`}
                            >
                              <AlertTriangle className="w-3 h-3 mr-1" />
                              <span data-testid={spec.key === 'notifyManualEntryAlerts'
                                ? 'text-inheritance-divergent-count'
                                : `text-inheritance-divergent-count-${dataIdx}`}>{bucket.divergentCount}</span>
                              {' '}don’t match
                            </Badge>
                          ) : (
                            <Badge
                              variant="outline"
                              className="border-emerald-500/40 text-emerald-300 bg-emerald-500/10"
                              data-testid={spec.key === 'notifyManualEntryAlerts'
                                ? 'badge-inheritance-aligned'
                                : `badge-inheritance-aligned-${dataIdx}`}
                            >
                              All match
                            </Badge>
                          )}
                        </div>

                        <details
                          className="mt-3 text-xs"
                          data-testid={spec.key === 'notifyManualEntryAlerts'
                            ? 'details-inheritance-list'
                            : `details-inheritance-list-${dataIdx}`}
                        >
                          <summary
                            className="text-muted-foreground cursor-pointer hover:text-white"
                            data-testid={spec.key === 'notifyManualEntryAlerts'
                              ? 'toggle-inheritance-list'
                              : `toggle-inheritance-list-${dataIdx}`}
                          >
                            Show all {totalTournaments} tournament{totalTournaments === 1 ? '' : 's'}
                          </summary>
                          <ul
                            className="mt-2 space-y-1.5 max-h-64 overflow-y-auto pr-1"
                            data-testid={spec.key === 'notifyManualEntryAlerts'
                              ? 'list-inheritance-tournaments'
                              : `list-inheritance-tournaments-${dataIdx}`}
                          >
                            {tournaments.map(t => {
                              const v = t[spec.key];
                              const matches = v === value;
                              const rowKey = spec.key === 'notifyManualEntryAlerts'
                                ? `row-inheritance-tournament-${t.id}`
                                : `row-inheritance-tournament-${dataIdx}-${t.id}`;
                              const stateKey = spec.key === 'notifyManualEntryAlerts'
                                ? `badge-inheritance-tournament-state-${t.id}`
                                : `badge-inheritance-tournament-state-${dataIdx}-${t.id}`;
                              const markerKey = spec.key === 'notifyManualEntryAlerts'
                                ? `marker-inheritance-divergent-${t.id}`
                                : `marker-inheritance-divergent-${dataIdx}-${t.id}`;
                              return (
                                <li
                                  key={t.id}
                                  className="flex items-center justify-between gap-2"
                                  data-testid={rowKey}
                                >
                                  <span className="text-white truncate">
                                    {t.name}
                                    <span className="text-muted-foreground ml-2 capitalize">{t.status}</span>
                                  </span>
                                  <span className="flex items-center gap-2 shrink-0">
                                    <Badge
                                      variant="outline"
                                      className={v
                                        ? 'border-emerald-500/40 text-emerald-300 bg-emerald-500/10'
                                        : 'border-rose-500/40 text-rose-300 bg-rose-500/10'}
                                      data-testid={stateKey}
                                    >
                                      {v ? spec.enabledBadge : spec.mutedBadge}
                                    </Badge>
                                    {!matches ? (
                                      <span
                                        className="text-amber-300"
                                        title="Differs from the club-wide default"
                                        data-testid={markerKey}
                                      >
                                        ≠ club default
                                      </span>
                                    ) : null}
                                  </span>
                                </li>
                              );
                            })}
                          </ul>
                        </details>
                      </>
                    )}
                  </div>
                </div>
              );
            })}

            {divergentBuckets.length > 1 ? (
              <div
                className="border-t border-white/10 pt-3"
                data-testid="block-bulk-apply-all"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-xs font-medium text-white">
                      {divergentBuckets.length} club-wide defaults differ from existing tournaments
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">
                      Apply every divergent club-wide default to its matching
                      tournaments in one click. This brings {totalDivergent}{' '}
                      tournament{totalDivergent === 1 ? '' : 's'} into line at
                      once instead of confirming each toggle separately.
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 px-2 text-xs whitespace-nowrap"
                    disabled={applying || savingKey !== null}
                    onClick={() => setConfirmApply(divergentBuckets.map(b => b.spec.key))}
                    data-testid="button-apply-all-divergent"
                    title={`Apply ${divergentBuckets.length} divergent club-wide default${divergentBuckets.length === 1 ? '' : 's'}`}
                  >
                    {applying
                      ? <Loader2 className="w-3 h-3 animate-spin" />
                      : `Apply all divergent (${totalDivergent})`}
                  </Button>
                </div>
              </div>
            ) : null}
          </div>
        )}
      </CardContent>

      <AlertDialog
        open={confirmApply !== null}
        onOpenChange={open => { if (!open) setConfirmApply(null); }}
      >
        <AlertDialogContent data-testid="dialog-confirm-apply-to-tournaments">
          <AlertDialogHeader>
            <AlertDialogTitle data-testid="text-confirm-dialog-title">
              {confirmKeys.length === 1 ? (() => {
                const b = confirmBuckets[0];
                if (!b) return 'Apply to tournaments?';
                const verb = defaults[b.spec.key] ? 'Enable' : 'Mute';
                return `${verb} ${b.spec.shortName} on ${b.divergentCount} tournament${b.divergentCount === 1 ? '' : 's'}?`;
              })() : (
                `Apply ${confirmBuckets.length} club-wide defaults to ${confirmTotal} tournament${confirmTotal === 1 ? '' : 's'}?`
              )}
            </AlertDialogTitle>
            <AlertDialogDescription>
              This updates every still-active tournament whose per-tournament
              setting differs from the new club-wide default. Completed and
              cancelled events are left untouched. You can still flip the
              per-tournament toggle on any individual event afterwards.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {confirmKeys.length === 1 ? (() => {
            const b = confirmBuckets[0];
            if (!b) return null;
            const affected = confirmAffectedByKey[b.spec.key] ?? [];
            if (affected.length === 0) return null;
            const targetOn = defaults[b.spec.key];
            const fromLabel = targetOn ? b.spec.mutedBadge : b.spec.enabledBadge;
            const toLabel = targetOn ? b.spec.enabledBadge : b.spec.mutedBadge;
            return (
              <div className="mt-1" data-testid="block-confirm-affected-tournaments">
                <div className="text-xs text-muted-foreground mb-2">
                  These tournaments will change:
                </div>
                <ul
                  className="text-xs text-white space-y-1 max-h-64 overflow-y-auto pr-1"
                  data-testid="list-confirm-affected-tournaments"
                >
                  {affected.map(t => (
                    <li
                      key={t.id}
                      className="flex items-center justify-between gap-3"
                      data-testid={`row-confirm-affected-tournament-${t.id}`}
                    >
                      <span className="truncate">
                        {t.name}
                        <span className="text-muted-foreground ml-2 capitalize">{t.status}</span>
                      </span>
                      <span
                        className="text-muted-foreground shrink-0 whitespace-nowrap"
                        data-testid={`text-confirm-affected-tournament-change-${t.id}`}
                      >
                        {fromLabel} → <span className="text-white">{toLabel}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })() : (
            <ul
              className="text-xs text-white space-y-3 mt-1"
              data-testid="list-confirm-defaults"
            >
              {confirmBuckets.map(b => {
                const affected = confirmAffectedByKey[b.spec.key] ?? [];
                const targetOn = defaults[b.spec.key];
                const fromLabel = targetOn ? b.spec.mutedBadge : b.spec.enabledBadge;
                const toLabel = targetOn ? b.spec.enabledBadge : b.spec.mutedBadge;
                return (
                  <li
                    key={b.spec.key}
                    data-testid={`row-confirm-default-${b.spec.testIdSlug}`}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span className="truncate">
                        {targetOn ? 'Enable' : 'Mute'}{' '}
                        <span className="text-muted-foreground">{b.spec.shortName}</span>
                      </span>
                      <span className="text-muted-foreground shrink-0">
                        {b.divergentCount} tournament{b.divergentCount === 1 ? '' : 's'}
                      </span>
                    </div>
                    {affected.length > 0 ? (
                      <ul
                        className="mt-1 ml-3 space-y-0.5 max-h-40 overflow-y-auto pr-1"
                        data-testid={`list-confirm-affected-tournaments-${b.spec.testIdSlug}`}
                      >
                        {affected.map(t => (
                          <li
                            key={t.id}
                            className="flex items-center justify-between gap-3"
                            data-testid={`row-confirm-affected-tournament-${b.spec.testIdSlug}-${t.id}`}
                          >
                            <span className="truncate text-white/90">
                              {t.name}
                              <span className="text-muted-foreground ml-2 capitalize">{t.status}</span>
                            </span>
                            <span
                              className="text-muted-foreground shrink-0 whitespace-nowrap"
                              data-testid={`text-confirm-affected-tournament-change-${b.spec.testIdSlug}-${t.id}`}
                            >
                              {fromLabel} → <span className="text-white">{toLabel}</span>
                            </span>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-apply-to-tournaments">Cancel</AlertDialogCancel>
            <AlertDialogAction
              data-testid="button-confirm-apply-to-tournaments"
              disabled={applying}
              onClick={() => {
                const keys = confirmKeys;
                setConfirmApply(null);
                void onApplyKeys(keys);
              }}
            >
              {confirmKeys.length === 1
                ? `Apply to ${confirmTotal} tournament${confirmTotal === 1 ? '' : 's'}`
                : `Apply ${confirmBuckets.length} default${confirmBuckets.length === 1 ? '' : 's'}`}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1);
}

export default function ClubSettingsPage() {
  const { data: me } = useGetMe();
  const orgId = useActiveOrgId();
  const { toast } = useToast();

  const [docs, setDocs] = useState<Doc[]>([]);
  const [loading, setLoading] = useState(true);

  const [uploadOpen, setUploadOpen] = useState(false);
  const [editDoc, setEditDoc] = useState<Doc | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);

  const [form, setForm] = useState({ title: '', category: 'general', visibility: 'public' });
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploadProgress, setUploadProgress] = useState(0);

  const fetchDocs = async () => {
    if (!orgId) return;
    setLoading(true);
    try {
      const res = await fetch(apiUrl(`/organizations/${orgId}/documents`), { credentials: 'include' });
      if (res.ok) setDocs(await res.json());
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchDocs(); }, [orgId]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] ?? null;
    setSelectedFile(file);
    if (file && !form.title) {
      setForm(f => ({ ...f, title: file.name.replace(/\.[^/.]+$/, '') }));
    }
  };

  const handleUpload = async () => {
    if (!orgId || !selectedFile) { toast({ title: 'Please select a file', variant: 'destructive' }); return; }
    if (!form.title.trim()) { toast({ title: 'Title is required', variant: 'destructive' }); return; }
    setUploading(true);
    setUploadProgress(0);
    try {
      const urlRes = await fetch(apiUrl(`/organizations/${orgId}/documents/upload-url`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ contentType: selectedFile.type, size: selectedFile.size }),
      });
      if (!urlRes.ok) {
        const err = await urlRes.json();
        toast({ title: err.error ?? 'Upload URL failed', variant: 'destructive' }); return;
      }
      const { uploadURL, objectPath, uploadToken } = await urlRes.json();

      setUploadProgress(20);

      const uploadRes = await fetch(uploadURL, {
        method: 'PUT',
        body: selectedFile,
        headers: { 'Content-Type': selectedFile.type },
      });
      if (!uploadRes.ok) { toast({ title: 'File upload failed', variant: 'destructive' }); return; }

      setUploadProgress(80);

      const docRes = await fetch(apiUrl(`/organizations/${orgId}/documents`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          title: form.title.trim(),
          category: form.category,
          visibility: form.visibility,
          objectPath,
          uploadToken,
          filename: selectedFile.name,
          contentType: selectedFile.type,
          fileSize: selectedFile.size,
        }),
      });
      const data = await docRes.json();
      if (!docRes.ok) { toast({ title: data.error ?? 'Failed to save document', variant: 'destructive' }); return; }

      setUploadProgress(100);
      toast({ title: 'Document uploaded', description: form.title });
      setUploadOpen(false);
      setForm({ title: '', category: 'general', visibility: 'public' });
      setSelectedFile(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
      fetchDocs();
    } catch (err) {
      toast({ title: 'Upload failed', variant: 'destructive' });
    } finally {
      setUploading(false);
      setUploadProgress(0);
    }
  };

  const handleEdit = async () => {
    if (!orgId || !editDoc) return;
    if (!form.title.trim()) { toast({ title: 'Title is required', variant: 'destructive' }); return; }
    setSaving(true);
    try {
      const res = await fetch(apiUrl(`/organizations/${orgId}/documents/${editDoc.id}`), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ title: form.title, category: form.category, visibility: form.visibility }),
      });
      if (!res.ok) { toast({ title: 'Update failed', variant: 'destructive' }); return; }
      toast({ title: 'Document updated' });
      setEditDoc(null);
      fetchDocs();
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: number) => {
    if (!orgId) return;
    setDeletingId(id);
    try {
      const res = await fetch(apiUrl(`/organizations/${orgId}/documents/${id}`), {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!res.ok && res.status !== 204) { toast({ title: 'Delete failed', variant: 'destructive' }); return; }
      toast({ title: 'Document deleted' });
      fetchDocs();
    } finally {
      setDeletingId(null);
    }
  };

  const handleDownload = (doc: Doc) => {
    if (!orgId) return;
    window.open(apiUrl(`/organizations/${orgId}/documents/${doc.id}/download`), '_blank');
  };

  const openEdit = (doc: Doc) => {
    setEditDoc(doc);
    setForm({ title: doc.title, category: doc.category, visibility: doc.visibility });
  };

  const isAdmin = ['super_admin', 'org_admin', 'tournament_director'].includes(me?.role ?? '');
  // Authorization for editing the bounced-digest schedule combines an
  // app-level role with the org-membership roles (membership_secretary,
  // treasurer) that the API also accepts. The card itself self-hides if
  // the GET returns 401/403 so member-admins whose `me.role` is e.g.
  // 'player' but who hold a qualifying org membership still get the UI.

  return (
    <div className="min-h-screen bg-background p-4 md:p-8 space-y-6">
      {orgId ? <BouncedDigestPrefsCard orgId={orgId} /> : null}
      {orgId ? <OrgNotificationDefaultsCard orgId={orgId} /> : null}
      {orgId ? <ScheduleChangeOptOutsCard orgId={orgId} /> : null}
      {orgId ? <TieBreakEmailOptOutsCard orgId={orgId} /> : null}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-3">
            <FileText className="w-6 h-6 text-emerald-400" />
            Document Library
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            Upload and manage club documents — local rules, pace of play policies, notices, and more.
          </p>
        </div>
        {isAdmin && (
          <Button
            onClick={() => { setUploadOpen(true); setForm({ title: '', category: 'general', visibility: 'public' }); setSelectedFile(null); }}
            className="bg-emerald-600 hover:bg-emerald-700 text-white gap-2"
          >
            <Plus className="w-4 h-4" /> Upload Document
          </Button>
        )}
      </div>

      <Card className="glass-card">
        <CardHeader className="pb-3">
          <CardTitle className="text-white flex items-center gap-2">
            <FolderOpen className="w-4 h-4 text-emerald-400" /> Club Documents
          </CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex items-center gap-2 text-muted-foreground py-8 justify-center">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading documents…
            </div>
          ) : docs.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              <FileText className="w-12 h-12 mx-auto mb-3 opacity-20" />
              <p className="text-sm">No documents uploaded yet.</p>
              {isAdmin && (
                <Button variant="outline" className="mt-4 border-white/10 text-white hover:bg-white/5" onClick={() => setUploadOpen(true)}>
                  <Plus className="w-3.5 h-3.5 mr-1.5" /> Upload your first document
                </Button>
              )}
            </div>
          ) : (
            <div className="overflow-x-auto rounded-xl">
              <Table>
                <TableHeader>
                  <TableRow className="border-white/5">
                    <TableHead className="text-muted-foreground">Document</TableHead>
                    <TableHead className="text-muted-foreground">Category</TableHead>
                    <TableHead className="text-muted-foreground">Visibility</TableHead>
                    <TableHead className="text-muted-foreground">Size</TableHead>
                    <TableHead className="text-muted-foreground">Uploaded</TableHead>
                    <TableHead className="text-muted-foreground text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {docs.map(doc => (
                    <TableRow key={doc.id} className="border-white/5 hover:bg-white/2">
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <FileText className="w-4 h-4 text-emerald-400 flex-shrink-0" />
                          <div>
                            <p className="text-white text-sm font-medium">{doc.title}</p>
                            {doc.filename && <p className="text-muted-foreground text-xs">{doc.filename}</p>}
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge className={`text-xs ${CATEGORY_COLORS[doc.category] ?? CATEGORY_COLORS.general}`}>
                          {getCategoryLabel(doc.category)}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {doc.visibility === 'public' ? (
                          <span className="flex items-center gap-1 text-xs text-emerald-400">
                            <Eye className="w-3 h-3" /> Public
                          </span>
                        ) : (
                          <span className="flex items-center gap-1 text-xs text-amber-400">
                            <Users className="w-3 h-3" /> Members only
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="text-muted-foreground text-xs">{formatBytes(doc.fileSize)}</TableCell>
                      <TableCell className="text-muted-foreground text-xs">
                        {new Date(doc.createdAt).toLocaleDateString()}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center justify-end gap-1">
                          <button
                            onClick={() => handleDownload(doc)}
                            className="text-muted-foreground hover:text-emerald-400 transition-colors p-1.5 rounded hover:bg-emerald-400/10"
                            title="Download"
                          >
                            <Download className="w-3.5 h-3.5" />
                          </button>
                          {isAdmin && (
                            <>
                              <button
                                onClick={() => openEdit(doc)}
                                className="text-muted-foreground hover:text-blue-400 transition-colors p-1.5 rounded hover:bg-blue-400/10"
                                title="Edit"
                              >
                                <Edit3 className="w-3.5 h-3.5" />
                              </button>
                              <button
                                onClick={() => handleDelete(doc.id)}
                                disabled={deletingId === doc.id}
                                className="text-muted-foreground hover:text-red-400 transition-colors p-1.5 rounded hover:bg-red-400/10 disabled:opacity-50"
                                title="Delete"
                              >
                                {deletingId === doc.id
                                  ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                  : <Trash2 className="w-3.5 h-3.5" />
                                }
                              </button>
                            </>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Upload Dialog */}
      <Dialog open={uploadOpen} onOpenChange={v => { if (!uploading) setUploadOpen(v); }}>
        <DialogContent className="bg-[#0a1628] border border-white/10 text-white max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Upload className="w-4 h-4 text-emerald-400" /> Upload Document
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 mt-2">
            <div>
              <label className="text-xs text-muted-foreground uppercase tracking-wider">File *</label>
              <div
                className="mt-1 border-2 border-dashed border-white/10 rounded-xl p-6 text-center cursor-pointer hover:border-emerald-500/40 transition-colors"
                onClick={() => fileInputRef.current?.click()}
              >
                {selectedFile ? (
                  <div className="flex items-center gap-2 justify-center">
                    <FileText className="w-5 h-5 text-emerald-400" />
                    <div className="text-left">
                      <p className="text-sm text-white">{selectedFile.name}</p>
                      <p className="text-xs text-muted-foreground">{formatBytes(selectedFile.size)}</p>
                    </div>
                  </div>
                ) : (
                  <div>
                    <Upload className="w-8 h-8 mx-auto text-muted-foreground mb-2" />
                    <p className="text-sm text-muted-foreground">Click to select a file</p>
                    <p className="text-xs text-muted-foreground mt-1">PDF, Word, Excel, images — max 50 MB</p>
                  </div>
                )}
                <input
                  ref={fileInputRef}
                  type="file"
                  className="hidden"
                  accept=".pdf,.doc,.docx,.xls,.xlsx,.txt,.jpg,.jpeg,.png,.webp"
                  onChange={handleFileChange}
                />
              </div>
            </div>

            <div>
              <label className="text-xs text-muted-foreground uppercase tracking-wider">Title *</label>
              <Input
                value={form.title}
                onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
                placeholder="e.g. Winter Local Rules 2025"
                className="mt-1 bg-black/40 border-white/10 text-white"
              />
            </div>

            <div>
              <label className="text-xs text-muted-foreground uppercase tracking-wider">Category</label>
              <Select value={form.category} onValueChange={v => setForm(f => ({ ...f, category: v }))}>
                <SelectTrigger className="mt-1 bg-black/40 border-white/10 text-white">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-[#0a1628] border-white/10 text-white">
                  {CATEGORIES.map(c => (
                    <SelectItem key={c.value} value={c.value} className="text-white hover:bg-white/5">{c.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div>
              <label className="text-xs text-muted-foreground uppercase tracking-wider">Visibility</label>
              <Select value={form.visibility} onValueChange={v => setForm(f => ({ ...f, visibility: v }))}>
                <SelectTrigger className="mt-1 bg-black/40 border-white/10 text-white">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-[#0a1628] border-white/10 text-white">
                  <SelectItem value="public" className="text-white hover:bg-white/5">
                    <span className="flex items-center gap-2"><Eye className="w-3.5 h-3.5" /> Public — visible to all players</span>
                  </SelectItem>
                  <SelectItem value="members_only" className="text-white hover:bg-white/5">
                    <span className="flex items-center gap-2"><Shield className="w-3.5 h-3.5" /> Members only</span>
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>

            {uploading && uploadProgress > 0 && (
              <div>
                <div className="h-1.5 bg-white/10 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-emerald-500 transition-all"
                    style={{ width: `${uploadProgress}%` }}
                  />
                </div>
                <p className="text-xs text-muted-foreground mt-1 text-center">{uploadProgress}%</p>
              </div>
            )}

            <div className="flex gap-3 pt-2">
              <Button
                onClick={handleUpload}
                disabled={uploading || !selectedFile}
                className="flex-1 bg-emerald-600 hover:bg-emerald-700 text-white"
              >
                {uploading ? <><Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" /> Uploading…</> : 'Upload'}
              </Button>
              <Button variant="outline" onClick={() => setUploadOpen(false)} disabled={uploading} className="border-white/10 text-white hover:bg-white/5">Cancel</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Edit Dialog */}
      <Dialog open={!!editDoc} onOpenChange={v => { if (!saving) { if (!v) setEditDoc(null); } }}>
        <DialogContent className="bg-[#0a1628] border border-white/10 text-white max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Edit3 className="w-4 h-4 text-blue-400" /> Edit Document
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 mt-2">
            <div>
              <label className="text-xs text-muted-foreground uppercase tracking-wider">Title *</label>
              <Input
                value={form.title}
                onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
                className="mt-1 bg-black/40 border-white/10 text-white"
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground uppercase tracking-wider">Category</label>
              <Select value={form.category} onValueChange={v => setForm(f => ({ ...f, category: v }))}>
                <SelectTrigger className="mt-1 bg-black/40 border-white/10 text-white"><SelectValue /></SelectTrigger>
                <SelectContent className="bg-[#0a1628] border-white/10 text-white">
                  {CATEGORIES.map(c => (
                    <SelectItem key={c.value} value={c.value} className="text-white hover:bg-white/5">{c.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-xs text-muted-foreground uppercase tracking-wider">Visibility</label>
              <Select value={form.visibility} onValueChange={v => setForm(f => ({ ...f, visibility: v }))}>
                <SelectTrigger className="mt-1 bg-black/40 border-white/10 text-white"><SelectValue /></SelectTrigger>
                <SelectContent className="bg-[#0a1628] border-white/10 text-white">
                  <SelectItem value="public" className="text-white hover:bg-white/5">Public</SelectItem>
                  <SelectItem value="members_only" className="text-white hover:bg-white/5">Members only</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex gap-3 pt-2">
              <Button onClick={handleEdit} disabled={saving} className="flex-1 bg-blue-600 hover:bg-blue-700 text-white">
                {saving ? <><Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" /> Saving…</> : 'Save Changes'}
              </Button>
              <Button variant="outline" onClick={() => setEditDoc(null)} disabled={saving} className="border-white/10 text-white hover:bg-white/5">Cancel</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
