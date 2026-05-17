import { Badge } from '@/components/ui/badge';

export type ChannelStatus =
  | 'sent'
  | 'failed'
  | 'no_address'
  | 'no_user'
  | 'opted_out'
  | 'skipped';

export interface RejectionNotification {
  inAppMessageId?: number | null;
  emailStatus: ChannelStatus;
  emailError?: string;
  pushStatus: ChannelStatus;
  pushError?: string;
  smsStatus: ChannelStatus;
  smsError?: string;
  whatsappStatus: ChannelStatus;
  whatsappError?: string;
}

const CHANNEL_LABELS: Array<{ key: 'email' | 'push' | 'sms' | 'whatsapp'; label: string }> = [
  { key: 'email', label: 'Email' },
  { key: 'push', label: 'Push' },
  { key: 'sms', label: 'SMS' },
  { key: 'whatsapp', label: 'WhatsApp' },
];

function statusLabel(status: ChannelStatus, providerNotConfigured: boolean): string {
  if (providerNotConfigured) return 'skipped';
  switch (status) {
    case 'sent': return 'sent';
    case 'failed': return 'failed';
    case 'no_address': return 'no address';
    case 'no_user': return 'no app user';
    case 'opted_out': return 'opted out';
    case 'skipped': return 'skipped';
  }
}

function toneClass(status: ChannelStatus, providerNotConfigured: boolean): string {
  // Provider-not-configured renders as neutral skipped, never red.
  if (providerNotConfigured) return 'border-white/20 bg-white/5 text-white/60';
  switch (status) {
    case 'sent': return 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300';
    case 'failed': return 'border-red-500/40 bg-red-500/10 text-red-300';
    default: return 'border-white/20 bg-white/5 text-white/60';
  }
}

interface Props {
  notification: RejectionNotification | null | undefined;
  /** Compact strips channel "in-app" mention; used inside transient toast. */
  className?: string;
  testIdPrefix?: string;
}

export function RejectionDeliveryChips({ notification, className, testIdPrefix = 'rej-delivery' }: Props) {
  if (!notification) return null;
  return (
    <div className={`flex flex-wrap gap-1 ${className ?? ''}`} data-testid={`${testIdPrefix}-chips`}>
      <Badge
        variant="outline"
        className="border-emerald-500/40 bg-emerald-500/10 text-emerald-300 text-[10px]"
        data-testid={`${testIdPrefix}-inapp`}
      >
        In-app: {notification.inAppMessageId ? 'sent' : 'failed'}
      </Badge>
      {CHANNEL_LABELS.map(({ key, label }) => {
        const status = notification[`${key}Status` as keyof RejectionNotification] as ChannelStatus;
        const error = notification[`${key}Error` as keyof RejectionNotification] as string | undefined;
        const providerNotConfigured = error === 'provider_not_configured';
        const cls = toneClass(status, providerNotConfigured);
        const title = error && !providerNotConfigured ? `${label}: ${error}` : undefined;
        return (
          <Badge
            key={key}
            variant="outline"
            className={`${cls} text-[10px]`}
            title={title}
            data-testid={`${testIdPrefix}-${key}`}
            data-status={providerNotConfigured ? 'skipped' : status}
          >
            {label}: {statusLabel(status, providerNotConfigured)}
          </Badge>
        );
      })}
    </div>
  );
}

const STORAGE_KEY = 'kg.docRejectionDelivery.v1';
const MAX_ENTRIES = 50;

interface StoredEntry {
  notification: RejectionNotification;
  rejectedAt: string;
}

type StoredMap = Record<string, StoredEntry>;

function readStore(): StoredMap {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed as StoredMap : {};
  } catch {
    return {};
  }
}

function writeStore(map: StoredMap): void {
  if (typeof window === 'undefined') return;
  try {
    const entries = Object.entries(map);
    if (entries.length > MAX_ENTRIES) {
      entries.sort((a, b) => (b[1].rejectedAt.localeCompare(a[1].rejectedAt)));
      const trimmed: StoredMap = {};
      for (const [k, v] of entries.slice(0, MAX_ENTRIES)) trimmed[k] = v;
      window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
      return;
    }
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    /* ignore quota errors — chip is a best-effort enhancement */
  }
}

export function recordDocRejectionDelivery(docId: number, notification: RejectionNotification): void {
  const map = readStore();
  map[String(docId)] = { notification, rejectedAt: new Date().toISOString() };
  writeStore(map);
}

export function getDocRejectionDelivery(docId: number): RejectionNotification | null {
  const map = readStore();
  const entry = map[String(docId)];
  return entry ? entry.notification : null;
}
