import { useEffect, useState } from "react";
import { Link } from "wouter";
import { Loader2, Mail, ArrowLeft, AlertCircle } from "lucide-react";

interface SubscriptionRow {
  orgId: number;
  orgName: string;
  emailType: string;
  emailTypeLabel: string;
  emailTypeDescription: string;
  optedOut: boolean;
  optedOutAt: string | null;
}

interface EmailType {
  key: string;
  label: string;
  description: string;
}

interface EmailSubscriptionsResponse {
  types: EmailType[];
  subscriptions: SubscriptionRow[];
}

const API = "/api";

export default function PortalEmailPreferencesPage() {
  const [data, setData] = useState<EmailSubscriptionsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<Date | null>(null);

  async function reload() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API}/portal/email-subscriptions`, { credentials: "include" });
      if (res.status === 401) {
        setError("You must be signed in to manage email preferences.");
        return;
      }
      if (!res.ok) {
        setError("Failed to load email preferences.");
        return;
      }
      setData(await res.json());
    } catch {
      setError("Failed to load email preferences.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void reload(); }, []);

  // Bi-directional toggle: subscribed ↔ unsubscribed. Optimistic update with
  // server-side confirmation; rolled back on failure.
  async function toggle(row: SubscriptionRow) {
    const key = `${row.orgId}:${row.emailType}`;
    setPending(key);
    setError(null);

    const targetOptedOut = !row.optedOut;
    const path = targetOptedOut ? "unsubscribe" : "resubscribe";

    // Optimistic update
    setData(prev => prev ? {
      ...prev,
      subscriptions: prev.subscriptions.map(r =>
        r.orgId === row.orgId && r.emailType === row.emailType
          ? { ...r, optedOut: targetOptedOut, optedOutAt: targetOptedOut ? new Date().toISOString() : null }
          : r),
    } : prev);

    try {
      const res = await fetch(`${API}/portal/email-subscriptions/${path}`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orgId: row.orgId, emailType: row.emailType }),
      });
      if (!res.ok && res.status !== 204) {
        // Roll back optimistic update
        setData(prev => prev ? {
          ...prev,
          subscriptions: prev.subscriptions.map(r =>
            r.orgId === row.orgId && r.emailType === row.emailType
              ? { ...r, optedOut: row.optedOut, optedOutAt: row.optedOutAt }
              : r),
        } : prev);
        setError("Failed to update subscription. Please try again.");
        return;
      }
      setSavedAt(new Date());
    } finally {
      setPending(null);
    }
  }

  const subs = data?.subscriptions ?? [];
  const hasAnyOptOut = subs.some(s => s.optedOut);

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white" data-testid="page-email-preferences">
      <div className="max-w-3xl mx-auto px-4 py-10">
        <Link href="/portal" data-testid="link-back-to-portal">
          <a className="inline-flex items-center gap-2 text-sm text-blue-400 hover:text-blue-300 mb-6">
            <ArrowLeft className="w-4 h-4" /> Back to portal
          </a>
        </Link>

        <div className="flex items-center gap-3 mb-2">
          <Mail className="w-6 h-6 text-primary" />
          <h1 className="text-2xl font-semibold">Email preferences</h1>
        </div>
        <p className="text-sm text-muted-foreground mb-8">
          Choose which optional notification emails you receive from each of your clubs.
          Toggle a row off to silence that email type for that club, or back on to start
          receiving it again — no admin help or token link needed.
        </p>

        {error && (
          <div className="mb-6 flex items-start gap-2 rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-300" role="alert">
            <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {loading ? (
          <div className="flex items-center gap-2 text-muted-foreground py-8">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading your subscriptions…
          </div>
        ) : subs.length === 0 ? (
          <div
            className="rounded-lg border border-white/10 bg-white/[0.02] p-8 text-center text-sm text-muted-foreground"
            data-testid="text-no-subscriptions"
          >
            <Mail className="w-8 h-8 mx-auto mb-3 text-muted-foreground/60" />
            <p className="text-white font-medium mb-1">No optional emails to manage yet</p>
            <p>You&apos;re not currently a member of any club that sends opt-outable notification emails.</p>
          </div>
        ) : (
          <div className="space-y-3" data-testid="list-subscriptions">
            {subs.map((row) => {
              const key = `${row.orgId}:${row.emailType}`;
              const isPending = pending === key;
              const isOn = !row.optedOut; // "On" = subscribed
              return (
                <div
                  key={key}
                  className="flex items-start justify-between gap-4 rounded-lg border border-white/10 bg-white/[0.03] p-4"
                  data-testid={`row-subscription-${row.orgId}-${row.emailType}`}
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="text-white font-medium text-sm" data-testid={`text-org-${row.orgId}`}>
                        {row.orgName}
                      </p>
                      {!isOn && (
                        <span className="text-[10px] uppercase tracking-wider text-amber-400 font-semibold" data-testid={`badge-unsubscribed-${row.orgId}-${row.emailType}`}>
                          Unsubscribed
                        </span>
                      )}
                    </div>
                    <p className="text-white/80 text-sm mt-1">{row.emailTypeLabel}</p>
                    <p className="text-muted-foreground text-xs mt-1 leading-relaxed">
                      {row.emailTypeDescription}
                    </p>
                    {row.optedOutAt && !isOn && (
                      <p className="text-muted-foreground/70 text-[11px] mt-2">
                        Opted out {new Date(row.optedOutAt).toLocaleDateString()}
                      </p>
                    )}
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={isOn}
                    aria-label={isOn ? `Unsubscribe from ${row.emailTypeLabel} for ${row.orgName}` : `Subscribe to ${row.emailTypeLabel} for ${row.orgName}`}
                    disabled={isPending}
                    onClick={() => void toggle(row)}
                    className={`flex-shrink-0 relative w-11 h-6 rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 focus:ring-offset-[#0a0a0a] ${isOn ? 'bg-primary' : 'bg-white/20'} ${isPending ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
                    data-testid={`toggle-subscription-${row.orgId}-${row.emailType}`}
                  >
                    <span
                      className={`block w-4 h-4 rounded-full bg-white shadow transition-transform absolute top-1 ${isOn ? 'translate-x-6' : 'translate-x-1'}`}
                    />
                    {isPending && (
                      <Loader2 className="absolute inset-0 m-auto w-3 h-3 animate-spin text-white" />
                    )}
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {savedAt && (
          <p className="text-xs text-emerald-400 mt-4" data-testid="text-saved-at">
            Updated at {savedAt.toLocaleTimeString()}
          </p>
        )}

        {!loading && subs.length > 0 && !hasAnyOptOut && (
          <p className="text-xs text-muted-foreground mt-4">
            You&apos;re subscribed to every optional email from every club you belong to.
          </p>
        )}
      </div>
    </div>
  );
}
