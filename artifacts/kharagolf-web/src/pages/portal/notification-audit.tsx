// Task #1775 — Player-portal "Suppressed notifications" view.
//
// Surfaces the rows that `notification_audit_log` records when the dispatcher
// short-circuits delivery for the signed-in user. Without this page, a
// controller who muted both the email and the in-app/push channel for an
// alert (e.g. `privacy.erasure.storage_failures.controller_digest`) had no
// way to discover that the cron tried to reach them — the only trace was a
// `skipped/event_opted_out` row in the database.
//
// Each row is tagged either "you muted this" (`kind === 'user_muted'`) or
// "system suppressed" (everything else, e.g. `no_address`,
// `no_email_on_file`, `all_channels_opted_out`). User-muted rows include a
// "Re-enable in settings" deep-link back to the comm-prefs Card so closing
// the loop is one click.
import { useEffect, useState } from 'react';
import { Link } from 'wouter';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, BellOff, Settings, RefreshCw, ChevronDown } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

const API = (path: string) => `/api${path}`;

interface AuditEntry {
  id: number;
  notificationKey: string;
  category: string | null;
  description: string | null;
  channel: string;
  status: string;
  reason: string | null;
  kind: 'user_muted' | 'system_suppressed';
  payload: Record<string, unknown>;
  createdAt: string;
}

interface AuditResponse {
  entries: AuditEntry[];
  windowDays: number;
  limit: number;
  hasMore: boolean;
  nextBefore: string | null;
}

const WINDOW_OPTIONS = [7, 30, 90] as const;

export function PortalNotificationAudit() {
  const { t } = useTranslation('portal');
  const [windowDays, setWindowDays] = useState<number>(30);
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [hasMore, setHasMore] = useState<boolean>(false);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [loadingMore, setLoadingMore] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  async function loadFirstPage(days: number) {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(API(`/portal/notification-audit?days=${days}`), { credentials: 'include' });
      if (!res.ok) {
        setEntries([]);
        setHasMore(false);
        setNextBefore(null);
        setError(res.status === 401 ? t('notificationAudit.errors.signedOut') : t('notificationAudit.errors.loadFailed'));
        return;
      }
      const data = (await res.json()) as AuditResponse;
      setEntries(Array.isArray(data.entries) ? data.entries : []);
      setHasMore(Boolean(data.hasMore));
      setNextBefore(data.nextBefore ?? null);
    } catch {
      setError(t('notificationAudit.errors.loadFailed'));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadFirstPage(windowDays);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [windowDays]);

  async function loadMore() {
    if (!nextBefore || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await fetch(
        API(`/portal/notification-audit?days=${windowDays}&before=${encodeURIComponent(nextBefore)}`),
        { credentials: 'include' },
      );
      if (!res.ok) return;
      const data = (await res.json()) as AuditResponse;
      const more = Array.isArray(data.entries) ? data.entries : [];
      setEntries(prev => [...prev, ...more]);
      setHasMore(Boolean(data.hasMore));
      setNextBefore(data.nextBefore ?? null);
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <div className="min-h-screen bg-background text-white py-8 px-4 sm:px-6 lg:px-8">
      <div className="max-w-4xl mx-auto space-y-6">
        <header className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight" data-testid="heading-notification-audit">
              {t('notificationAudit.heading')}
            </h1>
            <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
              {t('notificationAudit.intro')}
            </p>
          </div>
          <Link href="/portal#comm-prefs">
            <Button variant="outline" size="sm" data-testid="link-comm-prefs">
              <Settings className="w-4 h-4 mr-2" />
              {t('notificationAudit.openCommPrefs')}
            </Button>
          </Link>
        </header>

        <Card className="glass-panel border-white/10 p-4">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-2">
              <span className="text-xs uppercase tracking-wide text-muted-foreground">
                {t('notificationAudit.windowLabel')}
              </span>
              <div className="inline-flex rounded-md overflow-hidden border border-white/10" role="group">
                {WINDOW_OPTIONS.map(d => {
                  const active = d === windowDays;
                  return (
                    <button
                      key={d}
                      type="button"
                      onClick={() => setWindowDays(d)}
                      aria-pressed={active}
                      data-testid={`btn-window-${d}`}
                      className={`px-3 py-1 text-xs transition-colors ${
                        active
                          ? 'bg-primary text-white'
                          : 'bg-transparent text-white/60 hover:text-white/90'
                      }`}
                    >
                      {t('notificationAudit.windowDays', { count: d })}
                    </button>
                  );
                })}
              </div>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void loadFirstPage(windowDays)}
              disabled={loading}
              data-testid="btn-refresh"
            >
              <RefreshCw className={`w-4 h-4 mr-2 ${loading ? 'animate-spin' : ''}`} />
              {t('notificationAudit.refresh')}
            </Button>
          </div>
        </Card>

        {error ? (
          <Card className="glass-panel border-red-500/30 p-4 text-sm text-red-300" data-testid="audit-error">
            {error}
          </Card>
        ) : loading ? (
          <Card className="glass-panel border-white/10 p-8 text-center text-sm text-muted-foreground" data-testid="audit-loading">
            {t('notificationAudit.loading')}
          </Card>
        ) : entries.length === 0 ? (
          <Card className="glass-panel border-white/10 p-8 text-center" data-testid="audit-empty">
            <BellOff className="w-8 h-8 mx-auto text-muted-foreground mb-2" />
            <p className="text-sm text-white/80">{t('notificationAudit.empty.title')}</p>
            <p className="text-xs text-muted-foreground mt-1">
              {t('notificationAudit.empty.subtitle', { days: windowDays })}
            </p>
          </Card>
        ) : (
          <div className="space-y-3" data-testid="audit-list">
            {entries.map(entry => {
              const muted = entry.kind === 'user_muted';
              const when = new Date(entry.createdAt);
              const whenLabel = Number.isFinite(when.getTime())
                ? when.toLocaleString()
                : entry.createdAt;
              return (
                <Card
                  key={entry.id}
                  className="glass-panel border-white/10 p-4"
                  data-testid={`audit-row-${entry.id}`}
                  data-kind={entry.kind}
                >
                  <div className="flex items-start justify-between gap-3 flex-wrap">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        {muted ? (
                          <Badge
                            variant="outline"
                            className="bg-amber-500/15 text-amber-300 border-amber-500/30 gap-1"
                            data-testid={`badge-kind-${entry.id}`}
                          >
                            <BellOff className="w-3 h-3" />
                            {t('notificationAudit.kind.userMuted')}
                          </Badge>
                        ) : (
                          <Badge
                            variant="outline"
                            className="bg-sky-500/15 text-sky-300 border-sky-500/30 gap-1"
                            data-testid={`badge-kind-${entry.id}`}
                          >
                            <AlertTriangle className="w-3 h-3" />
                            {t('notificationAudit.kind.systemSuppressed')}
                          </Badge>
                        )}
                        {entry.category && (
                          <Badge
                            variant="outline"
                            className="bg-white/5 text-white/70 border-white/10"
                          >
                            {entry.category}
                          </Badge>
                        )}
                        <span className="text-xs text-muted-foreground">{entry.channel}</span>
                      </div>
                      <div className="mt-2 text-sm text-white/90">
                        {entry.description ?? entry.notificationKey}
                      </div>
                      <div className="text-[11px] text-muted-foreground mt-1 font-mono break-all">
                        {entry.notificationKey}
                      </div>
                      {entry.reason && (
                        <div className="text-xs text-muted-foreground mt-1">
                          {t('notificationAudit.reasonLabel')}:{' '}
                          <span className="font-mono text-white/70">{entry.reason}</span>
                        </div>
                      )}
                    </div>
                    <div className="shrink-0 text-right flex flex-col items-end gap-2">
                      <span className="text-xs text-muted-foreground" data-testid={`audit-when-${entry.id}`}>
                        {whenLabel}
                      </span>
                      {muted && (
                        <Link href="/portal#comm-prefs">
                          <Button
                            variant="outline"
                            size="sm"
                            data-testid={`btn-reenable-${entry.id}`}
                          >
                            {t('notificationAudit.reenable')}
                          </Button>
                        </Link>
                      )}
                    </div>
                  </div>
                </Card>
              );
            })}
            {hasMore && (
              <div className="text-center pt-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void loadMore()}
                  disabled={loadingMore}
                  data-testid="btn-load-more"
                >
                  <ChevronDown className={`w-4 h-4 mr-2 ${loadingMore ? 'animate-bounce' : ''}`} />
                  {loadingMore ? t('notificationAudit.loadingMore') : t('notificationAudit.loadMore')}
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default PortalNotificationAudit;
