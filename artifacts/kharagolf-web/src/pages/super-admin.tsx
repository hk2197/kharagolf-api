import { useEffect, useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useGetMe } from '@workspace/api-client-react';
import { useLocation } from 'wouter';
import {
  Building2, Users, Trophy, TrendingUp, Search, Filter,
  Crown, Star, Zap, Shield, AlertCircle, Check, X, ChevronRight,
  BarChart3, Globe, Plus, RefreshCw, Loader2, Ban, CheckCircle, Edit, Calendar,
  Settings, Save, Sliders, History, ArrowRight, Undo2,
  Bot, Watch, Trash2, Mail, MousePointerClick, BellRing, Share2, MapPin,
  Clock, ChevronLeft, Film, ExternalLink,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
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
import { Label } from '@/components/ui/label';
import { useToast } from '@/hooks/use-toast';
// Task #2057 — shared "Slack ✓ / PagerDuty ✗ + Send test page" panel +
// hook, mirroring the watch-GPS pattern from Task #1653 across every
// ops-alert dashboard so future alerts inherit it for free.
import {
  OpsAlertWiringPanel,
  type OpsAlertChatTargetsStatus,
} from '@/components/OpsAlertWiringPanel';
import { useOpsAlertTestPageMutation } from '@/hooks/use-ops-alert-test-page';
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend,
  BarChart, Bar,
} from 'recharts';

const TIER_ICONS: Record<string, React.ReactNode> = {
  free: <Shield className="w-4 h-4" />,
  starter: <Zap className="w-4 h-4" />,
  pro: <Star className="w-4 h-4" />,
  enterprise: <Crown className="w-4 h-4" />,
};

const TIER_BADGE: Record<string, string> = {
  free: 'bg-muted text-muted-foreground border-border',
  starter: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
  pro: 'bg-primary/20 text-primary border-primary/30',
  enterprise: 'bg-purple-500/20 text-purple-400 border-purple-500/30',
};

interface Club {
  id: number;
  name: string;
  slug: string;
  logoUrl: string | null;
  primaryColor: string | null;
  subscriptionTier: string;
  isActive: boolean;
  contactEmail: string | null;
  memberCount: number;
  tournamentCount: number;
  activeTournaments: number;
  createdAt: string;
}

interface DashboardStats {
  totalClubs: number;
  activeClubs: number;
  totalUsers: number;
  totalTournaments: number;
  activeTournaments: number;
  tierBreakdown: Record<string, number>;
  estimatedMrr: number;
  bookingsThisMonth: number;
  bookingRevenueThisMonth: number;
  bookingsByClub: { organizationId: number; orgName: string | null; count: number; revenue: string }[];
}

interface PlanConfig {
  tier: string;
  label: string;
  currency: string;
  description: string;
  priceMonthly: number;
  maxActiveTournaments: number | null;
  maxMembers: number | null;
  maxLeagues: number | null;
  sponsorLogos: boolean;
  advancedAnalytics: boolean;
  prioritySupport: boolean;
  mobileApp: boolean;
  marketplace: boolean;
  aiRulesAssistant: boolean;
  whsScoring: boolean;
  duesBilling: boolean;
  shopLockerAccess: boolean;
  whiteLabel: boolean;
  customDomain: boolean;
}

interface OrgOverride {
  id: number;
  organizationId: number;
  overrideMaxTournaments: number | null;
  overrideMaxMembers: number | null;
  overrideMaxLeagues: number | null;
  overrideSponsorLogos: boolean | null;
  overrideAdvancedAnalytics: boolean | null;
  overridePrioritySupport: boolean | null;
  overrideMobileApp: boolean | null;
  overrideMarketplace: boolean | null;
  overrideAiRulesAssistant: boolean | null;
  overrideWhsScoring: boolean | null;
  overrideDuesBilling: boolean | null;
  overrideShopLockerAccess: boolean | null;
  overrideWhiteLabel: boolean | null;
  overrideCustomDomain: boolean | null;
  overrideReason: string | null;
  overrideExpiresAt: string | null;
}

type View = 'dashboard' | 'clubs' | 'create-club' | 'plans' | 'plan-migrations';

// Task #1906 — categorical trigger so the panel chip + email subject
// can distinguish genuine paid-plan churn from a slug-mapping bug
// without forcing a click into the row's free-text reason. Mirrors the
// PlanMigrationTriggerReason union in
// artifacts/api-server/src/lib/planMigrationDigest.ts.
type PlanMigrationTriggerReason = 'cancelled' | 'unknown_tier' | 'manual';

interface PlanMigrationEntry {
  id: number;
  organizationId: number;
  orgName: string | null;
  orgSlug: string | null;
  currentTier: string | null;
  fromTier: string | null;
  toTier: string | null;
  reason: string | null;
  createdAt: string;
  acknowledged: boolean;
  acknowledgedAt: string | null;
  acknowledgedByUserId: number | null;
  acknowledgedByName: string | null;
  acknowledgedVia: 'email' | 'dashboard' | null;
  // Task #1550 — ISO timestamp of the first digest dispatch that surfaced
  // this row to super admins (Task #1313). `null` until the row has been
  // included in at least one dispatched digest. The panel renders a
  // "first surfaced X ago" age cue using this when present, falling back
  // to `createdAt` so newly-created rows still get an age cue.
  firstDigestedAt: string | null;
  // Task #1906 — categorical trigger persisted alongside the audit row.
  // `null` for legacy rows that pre-date the metadata field; the chip is
  // simply omitted in that case rather than guessing a category.
  triggerReason: PlanMigrationTriggerReason | null;
}

/**
 * Task #1906 — visual mapping for the trigger chip. Colours are picked to
 * match the email's per-row chip in
 * `artifacts/api-server/src/lib/mailer.ts` (`renderTriggerReasonChip`)
 * so inbox-triage and panel-triage carry the same signal.
 */
export const PLAN_MIGRATION_TRIGGER_BADGE: Record<
  PlanMigrationTriggerReason,
  { label: string; tone: string; title: string }
> = {
  cancelled: {
    label: 'Cancellation',
    tone: 'border-red-500/40 text-red-300 bg-red-500/10',
    title: 'A paying customer cancelled their plan — genuine churn, not a slug-mapping bug.',
  },
  unknown_tier: {
    label: 'Unknown tier',
    tone: 'border-amber-500/40 text-amber-300 bg-amber-500/10',
    title: 'Stripe/Razorpay sent us a tier slug we did not recognise; the club was auto-reset to Free.',
  },
  manual: {
    label: 'Manual',
    tone: 'border-blue-500/40 text-blue-300 bg-blue-500/10',
    title: 'A super admin re-ran the plan migration helper for this club.',
  },
};

/**
 * Task #1550 — Bucket + colour helper for the "first surfaced X ago" age
 * cue rendered next to each unacknowledged Plan Migration row. Mirrors the
 * thresholds and colour ramp used by the daily digest email
 * (`renderFirstSurfacedLine` in `artifacts/api-server/src/lib/mailer.ts`)
 * so super admins triaging from the panel see the same priority signal as
 * those triaging from the inbox.
 *
 * Buckets:
 *   - <1h           → "first surfaced just now"   (grey)
 *   - <24h          → "first surfaced N hours ago"(grey)
 *   - <7 days       → "first surfaced N days ago" (amber — needs triage)
 *   - >=7 days      → "first surfaced N days ago" (red — clearly stale)
 *
 * Returns `null` when the input timestamp is missing or unparseable so the
 * caller can suppress the line entirely (we don't show "first surfaced
 * NaN" if metadata is corrupted).
 */
export function planMigrationFirstSurfaced(
  iso: string | null | undefined,
  nowMs: number = Date.now(),
): { label: string; toneClass: string } | null {
  if (!iso) return null;
  const ts = new Date(iso).getTime();
  if (!Number.isFinite(ts)) return null;
  const diffMs = Math.max(0, nowMs - ts);
  const oneHour = 60 * 60 * 1000;
  const oneDay = 24 * oneHour;

  let label: string;
  if (diffMs < oneHour) {
    label = 'first surfaced just now';
  } else if (diffMs < oneDay) {
    const hours = Math.floor(diffMs / oneHour);
    label = `first surfaced ${hours} hour${hours === 1 ? '' : 's'} ago`;
  } else {
    const days = Math.floor(diffMs / oneDay);
    label = `first surfaced ${days} day${days === 1 ? '' : 's'} ago`;
  }

  const toneClass =
    diffMs >= 7 * oneDay
      ? 'text-red-400'
      : diffMs >= oneDay
        ? 'text-amber-400'
        : 'text-gray-400';

  return { label, toneClass };
}

const RECOGNISED_TIERS = ['free', 'starter', 'pro', 'enterprise'] as const;
type RecognisedTier = typeof RECOGNISED_TIERS[number];

interface LegacySlugMapping {
  slug: string;
  tier: RecognisedTier;
  notes: string | null;
  createdByUserId: number | null;
  updatedByUserId: number | null;
  // Editor/creator audit info (Task #1299) — surfaced in the Plan Migrations
  // page so support staff can see at a glance who curated each suggestion.
  createdByDisplayName: string | null;
  createdByUsername: string | null;
  createdByEmail: string | null;
  updatedByDisplayName: string | null;
  updatedByUsername: string | null;
  updatedByEmail: string | null;
  createdAt: string;
  updatedAt: string;
}

// Pick the best available identifier for a mapping editor — display name
// first, then username, then email. Returns null when the mapping was made
// by an unknown actor (e.g. seeded defaults) so the UI can show a placeholder.
export function legacySlugEditorLabel(
  displayName: string | null,
  username: string | null,
  email: string | null,
): string | null {
  return displayName?.trim() || username?.trim() || email?.trim() || null;
}

interface RestoreTierSuggestion {
  tier: RecognisedTier;
  isGuess: boolean;
}

// Resolved ops alert config returned by GET /super-admin/ops-alert-settings.
// `dbThreshold` / `dbWindowHours` are the explicit overrides stored in
// the singleton settings row (null when no override). `threshold` /
// `windowHours` are the effective values the cron will actually use,
// after the env-var and hardcoded-default fallbacks. `source.*` says
// which layer the effective value came from so the UI can label it.
type OpsAlertSource = 'db' | 'env' | 'default';

// Task #1664 — manual-entry alert health tunables (rate threshold %,
// min sample, consecutive zero count, cooldown hours). Same DB →
// env → default precedence and per-field provenance as the
// retry-exhaustion fields above.
interface OpsAlertManualEntryConfig {
  rateThresholdPct: number;
  minSample: number;
  consecutiveZero: number;
  cooldownHours: number;
  // Task #2081 — three additional tunables: muted-skip pile-up
  // lookback window, dry-run flag, recipient lookup limit.
  lookbackHours: number;
  dryRun: boolean;
  recipientLookupLimit: number;
  source: {
    rateThresholdPct: OpsAlertSource;
    minSample: OpsAlertSource;
    consecutiveZero: OpsAlertSource;
    cooldownHours: OpsAlertSource;
    lookbackHours: OpsAlertSource;
    dryRun: OpsAlertSource;
    recipientLookupLimit: OpsAlertSource;
  };
  dbRateThresholdPct: number | null;
  dbMinSample: number | null;
  dbConsecutiveZero: number | null;
  dbCooldownHours: number | null;
  dbLookbackHours: number | null;
  dbDryRun: boolean | null;
  dbRecipientLookupLimit: number | null;
  envRateThresholdPct: number | null;
  envMinSample: number | null;
  envConsecutiveZero: number | null;
  envCooldownHours: number | null;
  envLookbackHours: number | null;
  envDryRun: boolean | null;
  envRecipientLookupLimit: number | null;
  defaultRateThresholdPct: number;
  defaultMinSample: number;
  defaultConsecutiveZero: number;
  defaultCooldownHours: number;
  defaultLookbackHours: number;
  defaultDryRun: boolean;
  defaultRecipientLookupLimit: number;
}

// Task #1910 — resolved recipient list for the retry-exhaustion ops
// alert. `effective` is what the cron will actually email. `dbList` is
// the explicit DB override (null = no override stored, [] = an admin
// stored an empty list — both fall back to env at resolve time so the
// UI can call out the env list as the floor). `source` mirrors the
// per-tunable provenance shape so the card can render the same
// "stored in database" / "inheriting from env" label.
interface OpsAlertRecipientsConfig {
  effective: string[];
  source: 'org_override' | 'env';
  dbList: string[] | null;
  envList: string[];
  envVar: string;
}

interface OpsAlertConfig {
  threshold: number;
  windowHours: number;
  source: { threshold: OpsAlertSource; windowHours: OpsAlertSource };
  dbThreshold: number | null;
  dbWindowHours: number | null;
  envThreshold: number | null;
  envWindowHours: number | null;
  defaultThreshold: number;
  defaultWindowHours: number;
  manualEntry: OpsAlertManualEntryConfig;
  // Task #1910 — DB-or-env recipient list for the retry-exhaustion
  // ops alert. Editable from this same card; the resolver lives
  // server-side so the cron and the admin UI never disagree.
  recipients: OpsAlertRecipientsConfig;
  updatedAt: string | null;
  updatedByUserId: number | null;
  // Task #1923 — friendly name + username for the user who last edited
  // the singleton, joined server-side from `app_users`. Mirrors the
  // enrichment the audit endpoint already exposes so the "Last edited
  // by …" line on the card stops showing bare numeric IDs.
  updatedByDisplayName: string | null;
  updatedByUsername: string | null;
  // Task #1916 — last successful "Send test alert" delivery metadata.
  // Surfaced next to the Send-test button so admins can tell at a
  // glance whether a fresh test is needed (and stop firing duplicate
  // tests at on-call inboxes).
  lastTestSentAt: string | null;
  lastTestSentByUserId: number | null;
  lastTestSentByDisplayName: string | null;
  lastTestSentByUsername: string | null;
  lastTestRecipientCount: number | null;
  // Task #2057 — sanitized chat-target config for the notify-retry
  // exhaustion alert. Same shape as the watch-GPS panel uses, so the
  // shared `OpsAlertWiringPanel` can render it without conversion.
  chatTargets?: {
    slackConfigured: boolean;
    pagerDutyConfigured: boolean;
  };
}

// Task #2055 — sanitised view of which Slack / PagerDuty chat-channels
// are wired up for an ops-alert flow. Mirrors `OpsAlertChatTargetsStatus`
// on the API. Secret values are never returned; only whether each
// channel resolved and which env var carried it.
type OpsAlertChatChannelStatus = {
  status: 'configured' | 'missing';
  source: 'dedicated' | 'shared' | null;
  dedicatedEnvVar: string;
  sharedEnvVar: string;
};
type OpsAlertChatTargetsStatus = {
  slack: OpsAlertChatChannelStatus;
  pagerDuty: OpsAlertChatChannelStatus;
};
interface OpsAlertChatTargetsResponse {
  flows: {
    notifyRetryExhaustion: OpsAlertChatTargetsStatus;
    watchGps: OpsAlertChatTargetsStatus;
  };
}

// Task #1546 — one entry in the ops alert tunables audit log.
// `prev*` / `new*` are the DB-stored override values before/after the
// PATCH (null = "inheriting from env / default at that time").
interface OpsAlertHistoryEntry {
  id: number;
  changedAt: string;
  changedByUserId: number | null;
  changedByDisplayName: string | null;
  changedByUsername: string | null;
  prevThreshold: number | null;
  newThreshold: number | null;
  prevWindowHours: number | null;
  newWindowHours: number | null;
  // Task #1664 — same prev/new pattern for the four manual-entry knobs.
  prevManualEntryRateThresholdPct: number | null;
  newManualEntryRateThresholdPct: number | null;
  prevManualEntryMinSample: number | null;
  newManualEntryMinSample: number | null;
  prevManualEntryConsecutiveZero: number | null;
  newManualEntryConsecutiveZero: number | null;
  prevManualEntryCooldownHours: number | null;
  newManualEntryCooldownHours: number | null;
  // Task #2081 — three additional manual-entry tunable prev/new pairs.
  // Same NULL-on-either-side convention ("inheriting at that point").
  prevManualEntryLookbackHours: number | null;
  newManualEntryLookbackHours: number | null;
  prevManualEntryDryRun: boolean | null;
  newManualEntryDryRun: boolean | null;
  prevManualEntryRecipientLookupLimit: number | null;
  newManualEntryRecipientLookupLimit: number | null;
  // Task #1910 — prev/new recipient list for the retry-exhaustion ops
  // alert. NULL on either side means the override was unset (cron
  // was inheriting from OPS_ALERT_EMAILS at that time).
  prevNotifyExhaustionRecipients: string[] | null;
  newNotifyExhaustionRecipients: string[] | null;
}

// Format a timestamp as a short relative string ("2m ago", "3h ago",
// "5d ago", or the absolute date for >30d). Inlined here because the
// only consumer is the ops alert history list and we don't want to
// pull in a date library just for one card.
function formatRelativeTime(iso: string, nowMs: number = Date.now()): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return iso;
  const diffSec = Math.max(0, Math.round((nowMs - t) / 1000));
  if (diffSec < 5) return 'just now';
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.round(diffHr / 24);
  if (diffDay < 30) return `${diffDay}d ago`;
  return new Date(t).toLocaleDateString();
}

// Task #1546 — render one row of the ops alert audit log. Extracted
// so the dashboard "Recent changes" list and the Task #1924 paginated
// "Show all" dialog share the exact same rendering (a postmortem
// reader will compare the two and shouldn't see different formats).
// Each row only renders the tunables that actually moved in that
// PATCH; the full prev/new payload is read from `entry`.
function OpsAlertHistoryRow({ entry }: { entry: OpsAlertHistoryEntry }) {
  const fmt = (v: number | null, suffix = '') => v === null ? 'inherit' : `${v}${suffix}`;
  const author = entry.changedByDisplayName
    || entry.changedByUsername
    || (entry.changedByUserId !== null ? `user #${entry.changedByUserId}` : 'system');
  const fields: Array<{
    label: string;
    prev: number | null;
    next: number | null;
    suffix?: string;
    testId: string;
  }> = [
    { label: 'threshold', prev: entry.prevThreshold, next: entry.newThreshold, testId: 'threshold' },
    { label: 'window', prev: entry.prevWindowHours, next: entry.newWindowHours, suffix: 'h', testId: 'window' },
    { label: 'me-rate', prev: entry.prevManualEntryRateThresholdPct, next: entry.newManualEntryRateThresholdPct, suffix: '%', testId: 'me-rate' },
    { label: 'me-min-sample', prev: entry.prevManualEntryMinSample, next: entry.newManualEntryMinSample, testId: 'me-min-sample' },
    { label: 'me-consec-zero', prev: entry.prevManualEntryConsecutiveZero, next: entry.newManualEntryConsecutiveZero, testId: 'me-consec-zero' },
    { label: 'me-cooldown', prev: entry.prevManualEntryCooldownHours, next: entry.newManualEntryCooldownHours, suffix: 'h', testId: 'me-cooldown' },
    // Task #2081 — three new tunable diffs render alongside the four
    // legacy ones. Dry-run is boolean so it has its own diff block
    // below; lookback + recipient lookup limit reuse the numeric row
    // shape with their natural suffixes.
    { label: 'me-lookback', prev: entry.prevManualEntryLookbackHours, next: entry.newManualEntryLookbackHours, suffix: 'h', testId: 'me-lookback' },
    { label: 'me-recipient-limit', prev: entry.prevManualEntryRecipientLookupLimit, next: entry.newManualEntryRecipientLookupLimit, testId: 'me-recipient-limit' },
  ];
  const changed = fields.filter(f => f.prev !== f.next);
  // Task #2081 — dry-run boolean diff. Rendered separately because
  // the numeric `fmt` above doesn't take booleans; we still want the
  // same "inherit / on / off" labelling so the row reads naturally.
  const fmtDry = (v: boolean | null): string => v === null ? 'inherit' : v ? 'on' : 'off';
  const dryRunChanged = entry.prevManualEntryDryRun !== entry.newManualEntryDryRun;
  // Task #1910 — render the recipients diff inline alongside the
  // numeric tunables. Compared by canonical join (sorted, lowercased)
  // so a list re-ordered without semantic change doesn't appear as a
  // phantom edit. NULL → "inherit".
  const fmtRecipients = (v: string[] | null): string =>
    v === null ? 'inherit' : v.length === 0 ? '(empty → inherit)' : v.join(', ');
  const recipKey = (v: string[] | null): string =>
    v === null ? '<null>' : [...v].map(s => s.toLowerCase()).sort().join(',');
  const recipChanged = recipKey(entry.prevNotifyExhaustionRecipients) !== recipKey(entry.newNotifyExhaustionRecipients);
  return (
    <li
      className="text-[11px] text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-0.5"
      data-testid={`row-ops-alert-history-${entry.id}`}
    >
      <span
        className="text-white"
        title={new Date(entry.changedAt).toLocaleString()}
        data-testid={`text-ops-alert-history-when-${entry.id}`}
      >
        {formatRelativeTime(entry.changedAt)}
      </span>
      <span data-testid={`text-ops-alert-history-author-${entry.id}`}>
        by <span className="text-white">{author}</span>
      </span>
      {changed.length === 0 && !recipChanged && !dryRunChanged ? (
        <>
          <span>·</span>
          <span data-testid={`text-ops-alert-history-noop-${entry.id}`} className="italic">
            (no tunable changes)
          </span>
        </>
      ) : (
        <>
          {changed.map(f => (
            <span key={f.testId} className="flex items-center gap-x-2">
              <span>·</span>
              <span data-testid={`text-ops-alert-history-${f.testId}-${entry.id}`}>
                {f.label}{' '}
                <span>{fmt(f.prev, f.suffix)}</span>
                {' → '}
                <span className="text-white font-medium">{fmt(f.next, f.suffix)}</span>
              </span>
            </span>
          ))}
          {dryRunChanged && (
            <span className="flex items-center gap-x-2">
              <span>·</span>
              <span data-testid={`text-ops-alert-history-me-dry-run-${entry.id}`}>
                me-dry-run{' '}
                <span>{fmtDry(entry.prevManualEntryDryRun)}</span>
                {' → '}
                <span className="text-white font-medium">{fmtDry(entry.newManualEntryDryRun)}</span>
              </span>
            </span>
          )}
          {recipChanged && (
            <span className="flex items-center gap-x-2">
              <span>·</span>
              <span data-testid={`text-ops-alert-history-recipients-${entry.id}`}>
                recipients{' '}
                <span>{fmtRecipients(entry.prevNotifyExhaustionRecipients)}</span>
                {' → '}
                <span className="text-white font-medium">{fmtRecipients(entry.newNotifyExhaustionRecipients)}</span>
              </span>
            </span>
          )}
        </>
      )}
    </li>
  );
}

// Resolve a stored legacy plan slug to a recognised tier using the editable
// mapping fetched from the server (Task #1131). Standard tier slugs are
// returned as-is; non-standard ones look the slug up in the mapping table.
// Exported so unit tests (Task #1132) can exercise the matching logic
// directly without rendering the whole super-admin page.
export function mapToRecognisedTier(
  raw: unknown,
  mappings: Record<string, RecognisedTier>,
): RestoreTierSuggestion | null {
  if (typeof raw !== 'string') return null;
  const slug = raw.trim().toLowerCase();
  if (!slug) return null;
  if ((RECOGNISED_TIERS as readonly string[]).includes(slug)) {
    return { tier: slug as RecognisedTier, isGuess: false };
  }
  const guess = mappings[slug];
  if (guess) return { tier: guess, isGuess: true };
  return null;
}

const FEATURE_LABELS: Record<string, string> = {
  sponsorLogos: 'Sponsor Logos',
  advancedAnalytics: 'Advanced Analytics',
  prioritySupport: 'Priority Support',
  mobileApp: 'Mobile App',
  marketplace: 'Tee Time Marketplace',
  aiRulesAssistant: 'AI Rules Assistant',
  whsScoring: 'WHS Scoring',
  duesBilling: 'Dues & Billing',
  shopLockerAccess: 'Shop & Lockers',
  whiteLabel: 'White Label',
  customDomain: 'Custom Domain',
};

const BOOLEAN_FEATURES = Object.keys(FEATURE_LABELS);

// Task #1675 — small SVG scatter visual for the "Recent watch positions"
// dialog. The existing table is great for inspecting individual rows, but
// ops mostly want to eyeball at a glance whether the watch is stuck on one
// coordinate, jittering inside a small radius, or jumping implausibly. The
// scatter renders the buffered samples in chronological order with a faint
// trajectory polyline (oldest → newest) and markers that fade from old to
// opaque-newest, making the temporal order obvious without per-marker labels.
//
// Projection: equirectangular approximation centred on the sample bounds,
// scaled to fit the SVG box while preserving real-world aspect ratio (so a
// long thin walk reads as long-and-thin, not stretched). At the per-session
// scale (a single golf course at most) this is plenty accurate for an
// eyeballing visual.
//
// Stuck case: if the total real-world span is < ~0.5 m (well below typical
// GPS jitter), all markers collapse onto each other, so we instead render a
// single emphasised marker and an "all positions identical" label rather
// than a misleading dot cloud.
interface WatchPositionsScatterSample {
  timestamp: string;
  lat: number;
  lng: number;
  batteryMode: boolean;
}

// Task #2076 — cross-highlight a watch position on the map when its row is
// hovered (and vice versa). We tag every sample with a "position cluster key"
// that the table and the scatter both compare against the currently-hovered
// key. In the stuck case every sample collapses onto one marker, so they all
// share the sentinel "stuck" key (any hover lights up the whole group). In
// the trajectory case the key encodes the displayed lat/lng to 6 dp, which
// matches what the table renders — so two rows landing on the same marker
// (e.g. the watch sat still for two adjacent samples mid-walk) still light
// up together, satisfying the "multiple rows map to the same marker, all
// rows highlight" requirement.
const WATCH_POSITION_STUCK_KEY = 'stuck';

function isStuckPositionCluster(samples: WatchPositionsScatterSample[]): boolean {
  if (samples.length === 0) return false;
  const lats = samples.map((s) => s.lat);
  const lngs = samples.map((s) => s.lng);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);
  const latMid = (minLat + maxLat) / 2;
  const M_PER_LAT = 110540;
  const M_PER_LNG = 111320 * Math.cos((latMid * Math.PI) / 180);
  const widthM = (maxLng - minLng) * M_PER_LNG;
  const heightM = (maxLat - minLat) * M_PER_LAT;
  return Math.max(widthM, heightM) < 0.5;
}

function watchPositionHighlightKey(
  sample: WatchPositionsScatterSample,
  stuck: boolean,
): string {
  return stuck
    ? WATCH_POSITION_STUCK_KEY
    : `${sample.lat.toFixed(6)},${sample.lng.toFixed(6)}`;
}

export function WatchPositionsScatter({
  samples,
  hoveredKey = null,
  onHoverKey,
}: {
  samples: WatchPositionsScatterSample[];
  hoveredKey?: string | null;
  onHoverKey?: (key: string | null) => void;
}) {
  if (samples.length === 0) return null;

  // The API returns samples newest-first; reverse so iteration goes
  // oldest → newest, which is what the polyline + opacity gradient assume.
  const points = [...samples].reverse();

  const W = 360;
  const H = 180;
  const PAD = 12;
  const innerW = W - 2 * PAD;
  const innerH = H - 2 * PAD;

  const lats = points.map((p) => p.lat);
  const lngs = points.map((p) => p.lng);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);
  const latMid = (minLat + maxLat) / 2;
  // Equirectangular metres-per-degree at the cluster's latitude.
  const M_PER_LAT = 110540;
  const M_PER_LNG = 111320 * Math.cos((latMid * Math.PI) / 180);
  const widthM = (maxLng - minLng) * M_PER_LNG;
  const heightM = (maxLat - minLat) * M_PER_LAT;
  const spanM = Math.max(widthM, heightM);
  const isStuck = spanM < 0.5;

  let projected: { x: number; y: number; sample: WatchPositionsScatterSample }[];
  if (isStuck) {
    projected = points.map((p) => ({ x: W / 2, y: H / 2, sample: p }));
  } else {
    const scale = Math.min(
      innerW / Math.max(widthM, 1e-6),
      innerH / Math.max(heightM, 1e-6),
    );
    const drawnW = widthM * scale;
    const drawnH = heightM * scale;
    const offsetX = PAD + (innerW - drawnW) / 2;
    const offsetY = PAD + (innerH - drawnH) / 2;
    projected = points.map((p) => ({
      x: offsetX + (p.lng - minLng) * M_PER_LNG * scale,
      // SVG y grows downward; latitude grows northward, so flip.
      y: offsetY + drawnH - (p.lat - minLat) * M_PER_LAT * scale,
      sample: p,
    }));
  }

  let spanLabel: string;
  if (isStuck) {
    spanLabel = 'span: ~0 m (stuck on one coordinate)';
  } else if (spanM < 10) {
    spanLabel = `span: ${spanM.toFixed(1)} m`;
  } else if (spanM < 1000) {
    spanLabel = `span: ${Math.round(spanM)} m`;
  } else {
    spanLabel = `span: ${(spanM / 1000).toFixed(2)} km`;
  }

  const polylinePoints =
    !isStuck && projected.length > 1
      ? projected.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ')
      : null;

  // Task #2077 — give ops a one-click jump to Google Maps so they can tell
  // whether "stuck" / "jittering" is on the 9th green, in the parking lot,
  // or 200 m off-course, without copy-pasting coordinates by hand.
  //
  // `samples` is newest-first (matches the table's #1-is-newest numbering),
  // so `samples[0]` is the freshest known position. Google Maps' documented
  // `?api=1&query=lat,lng` URL drops a pin at that coordinate on the real
  // basemap so the surrounding context is immediately obvious.
  const newest = samples[0];
  const newestMapsUrl = `https://www.google.com/maps/search/?api=1&query=${newest.lat},${newest.lng}`;

  // Trajectory link: Google Maps Directions URLs accept origin +
  // destination + up to 8 intermediate waypoints (10 points total). When
  // the buffer holds more, sub-sample evenly while keeping the oldest and
  // newest endpoints so the route still spans the full session.
  const MAX_TRAJECTORY_POINTS = 10;
  const trajectorySamples =
    points.length <= MAX_TRAJECTORY_POINTS
      ? points
      : Array.from({ length: MAX_TRAJECTORY_POINTS }, (_, i) =>
          points[Math.round((i * (points.length - 1)) / (MAX_TRAJECTORY_POINTS - 1))],
        );
  let trajectoryUrl: string | null = null;
  if (!isStuck && trajectorySamples.length >= 2) {
    const origin = `${trajectorySamples[0].lat},${trajectorySamples[0].lng}`;
    const destination = `${trajectorySamples[trajectorySamples.length - 1].lat},${trajectorySamples[trajectorySamples.length - 1].lng}`;
    const waypoints = trajectorySamples
      .slice(1, -1)
      .map((p) => `${p.lat},${p.lng}`)
      .join('|');
    const params = new URLSearchParams({
      api: '1',
      origin,
      destination,
      travelmode: 'walking',
    });
    if (waypoints) params.set('waypoints', waypoints);
    trajectoryUrl = `https://www.google.com/maps/dir/?${params.toString()}`;
  }
  const trajectoryTrimmed = points.length > MAX_TRAJECTORY_POINTS;

  return (
    <div
      className="rounded-lg border border-border bg-background/40 p-3 mb-3 text-primary"
      data-testid="watch-positions-scatter"
    >
      <div className="flex items-center justify-between text-[11px] text-muted-foreground mb-1.5">
        <span>Trajectory · oldest faded → newest highlighted</span>
        <span data-testid="text-watch-positions-span">{spanLabel}</span>
      </div>
      <svg
        width="100%"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`Scatter plot of ${points.length} recent watch positions, oldest faded to newest opaque`}
        className="block"
      >
        <line x1={0} y1={H / 2} x2={W} y2={H / 2} stroke="currentColor" strokeOpacity={0.06} />
        <line x1={W / 2} y1={0} x2={W / 2} y2={H} stroke="currentColor" strokeOpacity={0.06} />
        {polylinePoints ? (
          <polyline
            points={polylinePoints}
            fill="none"
            stroke="currentColor"
            strokeOpacity={0.35}
            strokeWidth={1.25}
            data-testid="scatter-trajectory"
          />
        ) : null}
        {isStuck ? (
          <>
            {/* Task #2076 — when the matching row is hovered (or this marker
                itself is), draw a faint halo behind the dot so the link is
                obvious without changing the marker's natural size much. */}
            {hoveredKey === WATCH_POSITION_STUCK_KEY ? (
              <circle
                cx={W / 2}
                cy={H / 2}
                r={12}
                fill="currentColor"
                fillOpacity={0.2}
                data-testid="scatter-stuck-marker-halo"
              />
            ) : null}
            <circle
              cx={W / 2}
              cy={H / 2}
              r={hoveredKey === WATCH_POSITION_STUCK_KEY ? 9 : 7}
              fill="currentColor"
              fillOpacity={0.95}
              stroke="white"
              strokeWidth={hoveredKey === WATCH_POSITION_STUCK_KEY ? 2 : 1.25}
              data-testid="scatter-stuck-marker"
              className="cursor-pointer"
              onMouseEnter={() => onHoverKey?.(WATCH_POSITION_STUCK_KEY)}
              onMouseLeave={() => onHoverKey?.(null)}
            />
            <text
              x={W / 2}
              y={H / 2 + 22}
              textAnchor="middle"
              className="fill-amber-400"
              fontSize={11}
              data-testid="text-watch-positions-stuck"
            >
              All {projected.length} positions identical
            </text>
          </>
        ) : (
          projected.map((p, i) => {
            const isNewest = i === projected.length - 1;
            // Fade older → newer across [0.25, 0.95].
            const t = projected.length === 1 ? 1 : i / (projected.length - 1);
            const op = 0.25 + t * 0.7;
            // #1 in the table is the newest sample; mirror that numbering
            // here so the tooltip lines up with table row indices.
            const tableIndex = projected.length - 1 - i;
            const key = watchPositionHighlightKey(p.sample, false);
            const isHighlighted = hoveredKey != null && hoveredKey === key;
            const r = isHighlighted ? (isNewest ? 7 : 6) : isNewest ? 5 : 3;
            return (
              <g key={i}>
                {isHighlighted ? (
                  <circle
                    cx={p.x}
                    cy={p.y}
                    r={r + 4}
                    fill="currentColor"
                    fillOpacity={0.2}
                    data-testid={`scatter-point-${tableIndex}-halo`}
                  />
                ) : null}
                <circle
                  cx={p.x}
                  cy={p.y}
                  r={r}
                  fill="currentColor"
                  fillOpacity={isHighlighted ? 1 : op}
                  stroke={isHighlighted || isNewest ? 'white' : 'none'}
                  strokeWidth={isHighlighted ? 1.5 : isNewest ? 1.25 : 0}
                  data-testid={`scatter-point-${tableIndex}`}
                  className="cursor-pointer"
                  onMouseEnter={() => onHoverKey?.(key)}
                  onMouseLeave={() => onHoverKey?.(null)}
                >
                  <title>
                    #{tableIndex + 1} · {new Date(p.sample.timestamp).toLocaleString()} ·{' '}
                    {p.sample.lat.toFixed(6)}, {p.sample.lng.toFixed(6)}
                  </title>
                </circle>
              </g>
            );
          })
        )}
      </svg>
      <div className="flex items-center justify-between text-[10px] text-muted-foreground mt-1">
        <span className="flex items-center gap-2">
          <span className="flex items-center gap-1">
            <span className="inline-block w-2 h-2 rounded-full bg-primary opacity-25" /> oldest
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block w-2.5 h-2.5 rounded-full bg-primary border border-white" /> newest
          </span>
        </span>
        <span>{projected.length} pt{projected.length === 1 ? '' : 's'}</span>
      </div>
      {/* Task #2077 — escape hatch from the abstract scatter into a real
          basemap. The scatter is great for relative motion ("is this a
          tight loop or a wide drift?") but has no real-world context —
          ops can't tell if "stuck" means stuck on a green vs. in the
          parking lot. These links jump straight into Google Maps so the
          surrounding terrain answers that question without coordinate
          copy-paste. Both are `target="_blank"` with
          `rel="noopener noreferrer"` so they don't leak `window.opener`
          or referrer to maps.google.com. The component already returns
          `null` when `samples` is empty, so the "no positions" empty
          state degrades gracefully. */}
      <div
        className="flex flex-wrap items-center gap-3 text-[11px] mt-2 pt-2 border-t border-border/50"
        data-testid="watch-positions-map-actions"
      >
        <a
          href={newestMapsUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-primary hover:underline"
          data-testid="link-watch-positions-open-newest-in-maps"
          title={`Open the newest sample (${newest.lat.toFixed(6)}, ${newest.lng.toFixed(6)}) in Google Maps`}
        >
          <ExternalLink className="w-3 h-3" />
          Open newest in Google Maps
        </a>
        {trajectoryUrl ? (
          <a
            href={trajectoryUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-primary hover:underline"
            data-testid="link-watch-positions-view-trajectory-in-maps"
            title={
              trajectoryTrimmed
                ? `View trajectory in Google Maps (sub-sampled to ${MAX_TRAJECTORY_POINTS} of ${points.length} buffered points)`
                : `View trajectory in Google Maps (${points.length} points)`
            }
          >
            <ExternalLink className="w-3 h-3" />
            View trajectory in Google Maps
            {trajectoryTrimmed ? (
              <span
                className="text-muted-foreground"
                data-testid="text-watch-positions-trajectory-trimmed"
              >
                {' '}({MAX_TRAJECTORY_POINTS} of {points.length})
              </span>
            ) : null}
          </a>
        ) : null}
      </div>
    </div>
  );
}

export default function SuperAdminPage() {
  const { data: user } = useGetMe();
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [view, setView] = useState<View>('dashboard');
  // Task #1661 — remember the clubs-list search box and the tier/status
  // filters between visits. Same friction we fixed for the watch GPS
  // window (Task #1383): every refresh used to wipe the selection back to
  // defaults, so ops triaging "show me only Pro clubs that are inactive"
  // had to re-pick the filters every time, and there was no way to share
  // a deep-link to a filtered view. We seed the initial values from the
  // URL (`?q=…&tier=…&status=…`) so direct links work, fall back to
  // `super-admin:clubs*` localStorage entries for the last visit, and
  // mirror selections back to both stores via a single replaceState
  // effect below. Defaults ('all' / empty) are stripped from the URL so
  // we don't pin `?tier=all` on otherwise-clean links forever.
  const SEARCH_STORAGE_KEY = 'super-admin:clubsSearch';
  const TIER_FILTER_STORAGE_KEY = 'super-admin:clubsTierFilter';
  const STATUS_FILTER_STORAGE_KEY = 'super-admin:clubsStatusFilter';
  const isTierFilterValue = (v: unknown): v is 'all' | 'free' | 'starter' | 'pro' | 'enterprise' =>
    v === 'all' || v === 'free' || v === 'starter' || v === 'pro' || v === 'enterprise';
  const isStatusFilterValue = (v: unknown): v is 'all' | 'active' | 'suspended' =>
    v === 'all' || v === 'active' || v === 'suspended';
  const [search, setSearch] = useState<string>(() => {
    if (typeof window === 'undefined') return '';
    const fromUrl = new URLSearchParams(window.location.search).get('q');
    if (fromUrl != null) return fromUrl;
    try {
      return window.localStorage.getItem(SEARCH_STORAGE_KEY) ?? '';
    } catch {
      return '';
    }
  });
  const [tierFilter, setTierFilter] = useState<string>(() => {
    if (typeof window === 'undefined') return 'all';
    const fromUrl = new URLSearchParams(window.location.search).get('tier');
    if (isTierFilterValue(fromUrl)) return fromUrl;
    try {
      const stored = window.localStorage.getItem(TIER_FILTER_STORAGE_KEY);
      if (isTierFilterValue(stored)) return stored;
    } catch {
      // ignore
    }
    return 'all';
  });
  const [statusFilter, setStatusFilter] = useState<string>(() => {
    if (typeof window === 'undefined') return 'all';
    const fromUrl = new URLSearchParams(window.location.search).get('status');
    if (isStatusFilterValue(fromUrl)) return fromUrl;
    try {
      const stored = window.localStorage.getItem(STATUS_FILTER_STORAGE_KEY);
      if (isStatusFilterValue(stored)) return stored;
    } catch {
      // ignore
    }
    return 'all';
  });
  const [selectedClub, setSelectedClub] = useState<Club | null>(null);
  const [showTierChange, setShowTierChange] = useState(false);
  const [showOverrides, setShowOverrides] = useState(false);
  const [newTier, setNewTier] = useState('');
  // Task #1575 — admin-triggered re-run of the plan migration helper.
  // Opens a Dialog from the per-club detail view so support staff can
  // POST /api/super-admin/clubs/:orgId/re-migrate without curl. The
  // helper persists the tier change AND fans out the realtime email + push
  // (unlike PATCH /tier, which is intentionally silent).
  const [showReMigrate, setShowReMigrate] = useState(false);
  const [reMigrateTier, setReMigrateTier] = useState<RecognisedTier>('free');
  const [reMigrateReason, setReMigrateReason] = useState('');
  // Task #1957 — context for the open Re-run dialog. The dialog can be
  // opened either from the per-club detail sheet (auditEntryId === null)
  // or from a row in the Plan Migration Audit panel (auditEntryId set to
  // the row id). Submitting from an audit row also acknowledges that row,
  // mirroring how the row-level Restore button behaves.
  const [reMigrateContext, setReMigrateContext] = useState<{
    auditEntryId: number | null;
    orgId: number;
    orgName: string;
    currentTier: string;
  } | null>(null);
  // Task #1956 — gate downgrades behind a confirm step. The Re-run plan
  // migration helper persists the tier change AND fans out a "downgraded"
  // alert to every super admin, so a fat-fingered drop from Pro → Free
  // has to be undone via the Restore button. Whenever the chosen target
  // tier is strictly *below* the club's current tier, the first submit
  // click flips this flag to surface an inline warning + "Yes, downgrade"
  // confirmation; the second click actually fires the mutation. Same-tier
  // and upgrade selections submit on the first click as before. Reset on
  // dialog open and whenever the operator changes the target tier so a
  // post-warning re-pick of an upgrade or same-tier option is one click.
  const [confirmingDowngrade, setConfirmingDowngrade] = useState(false);
  const [createForm, setCreateForm] = useState({
    name: '', slug: '', description: '', contactEmail: '', subscriptionTier: 'free',
  });

  // Plans editor state
  const [planDrafts, setPlanDrafts] = useState<Record<string, Partial<PlanConfig>>>({});

  // Plan migration audit panel
  // Reviewer + via filters (Task #1314) + the "Show acknowledged" toggle.
  // 'all' / 'any' = no filter applied. Persisted to URL (?reviewer=… /
  // ?via=… / ?showAcknowledged=1) and mirrored to localStorage so a
  // refresh, shared link, or new tab keeps the same selection
  // (Task #1552 for reviewer/via, Task #1921 for showAcknowledged).
  const REVIEWER_FILTER_STORAGE_KEY = 'super-admin:planMigrationsReviewerFilter';
  const VIA_FILTER_STORAGE_KEY = 'super-admin:planMigrationsViaFilter';
  const SHOW_ACKNOWLEDGED_STORAGE_KEY = 'super-admin:planMigrationsShowAcknowledged';
  // Task #1929 — persisted sort order. Default 'oldest' so the colour ramp
  // added by Task #1550 actually drives triage order; 'newest' is the
  // legacy createdAt-DESC view for occasional chronological scans.
  const SORT_STORAGE_KEY = 'super-admin:planMigrationsSort';
  const isViaFilterValue = (v: unknown): v is 'any' | 'email' | 'dashboard' =>
    v === 'any' || v === 'email' || v === 'dashboard';
  const isSortValue = (v: unknown): v is 'oldest' | 'newest' =>
    v === 'oldest' || v === 'newest';
  const parseReviewerFilter = (raw: string | null | undefined): 'all' | number => {
    if (!raw || raw === 'all') return 'all';
    const n = Number(raw);
    return Number.isInteger(n) && n > 0 ? n : 'all';
  };
  // Treat '1' / 'true' as on, anything else (including '0' / missing) as
  // off. Keeping it strict means a stray ?showAcknowledged=foo URL falls
  // back to the next source rather than silently flipping the toggle.
  const parseShowAcknowledged = (raw: string | null | undefined): boolean | null => {
    if (raw == null) return null;
    if (raw === '1' || raw === 'true') return true;
    if (raw === '0' || raw === 'false') return false;
    return null;
  };
  const [includeAcknowledged, setIncludeAcknowledged] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    const fromUrl = parseShowAcknowledged(
      new URLSearchParams(window.location.search).get('showAcknowledged'),
    );
    if (fromUrl !== null) return fromUrl;
    try {
      const fromStorage = parseShowAcknowledged(
        window.localStorage.getItem(SHOW_ACKNOWLEDGED_STORAGE_KEY),
      );
      if (fromStorage !== null) return fromStorage;
    } catch {
      // ignore privacy-mode failures
    }
    return false;
  });
  const [reviewerFilter, setReviewerFilter] = useState<'all' | number>(() => {
    if (typeof window === 'undefined') return 'all';
    const fromUrl = new URLSearchParams(window.location.search).get('reviewer');
    if (fromUrl != null) return parseReviewerFilter(fromUrl);
    try {
      return parseReviewerFilter(window.localStorage.getItem(REVIEWER_FILTER_STORAGE_KEY));
    } catch {
      return 'all';
    }
  });
  const [viaFilter, setViaFilter] = useState<'any' | 'email' | 'dashboard'>(() => {
    if (typeof window === 'undefined') return 'any';
    const fromUrl = new URLSearchParams(window.location.search).get('via');
    if (isViaFilterValue(fromUrl)) return fromUrl;
    try {
      const stored = window.localStorage.getItem(VIA_FILTER_STORAGE_KEY);
      if (isViaFilterValue(stored)) return stored;
    } catch {
      // ignore
    }
    return 'any';
  });
  // Task #1929 — sort toggle. Default 'oldest' so the colour ramp from
  // Task #1550 actually drives triage order on first load. URL + storage
  // hydration mirrors the reviewer/via filters so a refresh or shared
  // link keeps the same ordering.
  const [sort, setSort] = useState<'oldest' | 'newest'>(() => {
    if (typeof window === 'undefined') return 'oldest';
    const fromUrl = new URLSearchParams(window.location.search).get('sort');
    if (isSortValue(fromUrl)) return fromUrl;
    try {
      const stored = window.localStorage.getItem(SORT_STORAGE_KEY);
      if (isSortValue(stored)) return stored;
    } catch {
      // ignore
    }
    return 'oldest';
  });

  // Mirror reviewer/via/show-acknowledged filter selections back to the URL
  // + localStorage so a hard refresh or shared deep-link keeps the same
  // view (Task #1552 for reviewer/via, Task #1921 for showAcknowledged).
  // We use replaceState so toggling filters doesn't pollute browser history.
  // Defaults ('all' / 'any' / off) are intentionally cleared from both
  // sinks so the URL stays clean and a never-toggled session doesn't pin
  // `?showAcknowledged=0` forever.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      if (reviewerFilter === 'all') {
        window.localStorage.removeItem(REVIEWER_FILTER_STORAGE_KEY);
      } else {
        window.localStorage.setItem(REVIEWER_FILTER_STORAGE_KEY, String(reviewerFilter));
      }
      if (viaFilter === 'any') {
        window.localStorage.removeItem(VIA_FILTER_STORAGE_KEY);
      } else {
        window.localStorage.setItem(VIA_FILTER_STORAGE_KEY, viaFilter);
      }
      if (includeAcknowledged) {
        window.localStorage.setItem(SHOW_ACKNOWLEDGED_STORAGE_KEY, '1');
      } else {
        window.localStorage.removeItem(SHOW_ACKNOWLEDGED_STORAGE_KEY);
      }
      // Task #1929 — persist sort like the other filters; only write when
      // it differs from the default so a never-toggled session doesn't
      // pin `?sort=oldest` forever.
      if (sort === 'newest') {
        window.localStorage.setItem(SORT_STORAGE_KEY, 'newest');
      } else {
        window.localStorage.removeItem(SORT_STORAGE_KEY);
      }
    } catch {
      // ignore quota / privacy-mode failures
    }
    const sp = new URLSearchParams(window.location.search);
    if (reviewerFilter === 'all') {
      sp.delete('reviewer');
    } else {
      sp.set('reviewer', String(reviewerFilter));
    }
    if (viaFilter === 'any') {
      sp.delete('via');
    } else {
      sp.set('via', viaFilter);
    }
    if (includeAcknowledged) {
      sp.set('showAcknowledged', '1');
    } else {
      sp.delete('showAcknowledged');
    }
    if (sort === 'newest') {
      sp.set('sort', 'newest');
    } else {
      sp.delete('sort');
    }
    const qs = sp.toString();
    const newUrl = `${window.location.pathname}${qs ? `?${qs}` : ''}${window.location.hash}`;
    const currentUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (newUrl !== currentUrl) {
      window.history.replaceState(window.history.state, '', newUrl);
    }
  }, [reviewerFilter, viaFilter, includeAcknowledged, sort]);

  // Overrides form state
  const [overrideForm, setOverrideForm] = useState<Partial<Record<string, unknown>>>({});

  if (!user || user.role !== 'super_admin') {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] p-8 text-center">
        <AlertCircle className="w-12 h-12 text-red-400 mb-4" />
        <h2 className="text-xl font-bold text-white mb-2">Access Denied</h2>
        <p className="text-muted-foreground">This section requires super admin access.</p>
      </div>
    );
  }

  const { data: stats, isLoading: statsLoading } = useQuery<DashboardStats>({
    queryKey: ['/api/super-admin/dashboard'],
    queryFn: () => fetch('/api/super-admin/dashboard').then(r => r.json()),
    staleTime: 30000,
  });

  // Task #1930 — lightweight summary used by the "Plan Migrations" nav button
  // to render a stale-row badge so admins notice from any super-admin page
  // (dashboard, clubs, plans, …) that there are >=24h-unacknowledged rows
  // needing triage. The endpoint counts only rows in the amber/red bucket of
  // the panel's own age cue (`planMigrationFirstSurfaced`) so the badge and
  // the in-panel cue stay in sync. Polled every minute and refetched on
  // window focus so an admin coming back from triage sees the badge clear
  // promptly without a manual refresh.
  const { data: planMigrationStaleSummary } = useQuery<{ staleCount: number }>({
    queryKey: ['/api/super-admin/plan-migration-audit/stale-summary'],
    queryFn: () => fetch('/api/super-admin/plan-migration-audit/stale-summary').then(r => r.json()),
    staleTime: 30_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });
  const planMigrationStaleCount = planMigrationStaleSummary?.staleCount ?? 0;

  interface CaddiePromptMetric {
    ts: number;
    userId: number;
    contextMode: 'shots' | 'rounds';
    estimatedInputTokens: number;
    totalTrackedShots: number;
    roundCount: number;
    shotLineCount: number;
  }
  interface CaddiePromptMetricsSummary {
    total: number;
    windowStart: string | null;
    windowEnd: string | null;
    byMode: { shots: number; rounds: number };
    avgEstimatedInputTokens: number;
    p50EstimatedInputTokens: number;
    p95EstimatedInputTokens: number;
    maxEstimatedInputTokens: number;
    avgTotalTrackedShots: number;
    avgRoundCount: number;
    recent: CaddiePromptMetric[];
  }

  const {
    data: caddieMetrics,
    isLoading: caddieMetricsLoading,
    isFetching: caddieMetricsFetching,
    error: caddieMetricsError,
    refetch: refetchCaddieMetrics,
  } = useQuery<CaddiePromptMetricsSummary, Error>({
    queryKey: ['/api/super-admin/caddie-prompt-metrics'],
    queryFn: async () => {
      const r = await fetch('/api/super-admin/caddie-prompt-metrics?recent=20');
      if (!r.ok) {
        const text = await r.text().catch(() => '');
        throw new Error(`Failed to load AI Caddie metrics (${r.status}${text ? `: ${text.slice(0, 120)}` : ''})`);
      }
      return r.json();
    },
    enabled: view === 'dashboard',
    refetchInterval: view === 'dashboard' ? 30000 : false,
    staleTime: 15000,
    retry: 1,
  });

  // Watch GPS position-rate metrics (Task #877)
  interface WatchPositionWindow {
    totalMessages: number;
    bucketCount: number;
    activeSessionCount: number;
    avgMessagesPerSessionMinute: number;
    p50MessagesPerSessionMinute: number;
    p95MessagesPerSessionMinute: number;
    maxMessagesPerSessionMinute: number;
  }
  interface WatchPositionRecent {
    bucketMinute: string;
    sessionId: string;
    userId: number;
    tournamentId: number | null;
    batteryMode: boolean;
    positionCount: number;
  }
  interface WatchPositionSeriesPoint {
    bucket: string;
    sampleCount: number;
    avg: number;
    p95: number;
    max: number;
    batteryAvg: number | null;
    batterySampleCount: number;
    normalAvg: number | null;
    normalSampleCount: number;
  }
  // Task #2057 — these previously lived inline; they're now part of the
  // shared `OpsAlertWiringPanel` API so the watch-GPS panel and every
  // future ops-alert dashboard share one type for the chat-target
  // status struct.
  type WatchGpsOpsAlertChatTargetsStatus = OpsAlertChatTargetsStatus;
  interface WatchPositionMetricsSummary {
    windows: { '24h': WatchPositionWindow; '7d': WatchPositionWindow; '30d': WatchPositionWindow };
    seriesByWindow: { '24h': WatchPositionSeriesPoint[]; '7d': WatchPositionSeriesPoint[]; '30d': WatchPositionSeriesPoint[] };
    seriesBucketSeconds: { '24h': number; '7d': number; '30d': number };
    recent: WatchPositionRecent[];
    // Task #1653 — sanitized chat-target config so the dashboard can show
    // Slack ✓ / PagerDuty ✗ before ops fires the test page.
    chatTargets?: WatchGpsOpsAlertChatTargetsStatus;
  }
  // Task #2056 — audit log of past "Send test page" clicks so leadership
  // can prove the wiring is exercised regularly and chart its cadence.
  // Task #2057 — `WatchOpsAlertChatTest{Channel}Result` interfaces were
  // removed because the shared `useOpsAlertTestPageMutation` hook owns
  // its own `OpsAlertWiringTestResult` type now; only the history-panel
  // shapes remain here since they're still consumed by the inline
  // history `<div>` and `<BarChart>` below.
  interface WatchOpsAlertChatTestHistoryLast {
    firedAt: string;
    actorUserId: number | null;
    actorName: string | null;
    slack: { attempted: boolean; ok: boolean; error: string | null };
    pagerDuty: { attempted: boolean; ok: boolean; error: string | null };
  }
  interface WatchOpsAlertChatTestHistoryDayPoint {
    date: string;
    count: number;
  }
  interface WatchOpsAlertChatTestHistory {
    last: WatchOpsAlertChatTestHistoryLast | null;
    dailySeries: WatchOpsAlertChatTestHistoryDayPoint[];
    totalLast30Days: number;
  }
  // Task #1678 — active mute list surfaced in the watch panel.
  interface WatchMutedSession {
    sessionId: string;
    userId: number | null;
    tournamentId: number | null;
    mutedByUserId: number | null;
    mutedByName: string | null;
    mutedByRole: string | null;
    mutedAt: string | null;
    expiresAt: string;
    remainingMs: number;
  }
  interface WatchMutedSessionsResponse {
    sessions: WatchMutedSession[];
  }
  type WatchWindowKey = '24h' | '7d' | '30d';
  // Task #1383 — remember the chosen window between visits. Reset-to-"24h"
  // on every refresh forced ops to re-pick the trend they were looking at
  // moments ago, and broke deep-link sharing of the panel. We seed the
  // initial value from `?watchWindow=` (so direct links work) and fall
  // back to a `super-admin:watchWindow` localStorage entry written on the
  // last visit, before defaulting to "24h".
  const WATCH_WINDOW_STORAGE_KEY = 'super-admin:watchWindow';
  const isWatchWindowKey = (v: unknown): v is WatchWindowKey =>
    v === '24h' || v === '7d' || v === '30d';
  const [watchWindow, setWatchWindow] = useState<WatchWindowKey>(() => {
    if (typeof window === 'undefined') return '24h';
    const fromUrl = new URLSearchParams(window.location.search).get('watchWindow');
    if (isWatchWindowKey(fromUrl)) return fromUrl;
    try {
      const stored = window.localStorage.getItem(WATCH_WINDOW_STORAGE_KEY);
      if (isWatchWindowKey(stored)) return stored;
    } catch {
      // localStorage can throw in private-mode / sandboxed iframes;
      // silently fall through to the default.
    }
    return '24h';
  });

  // Persist the chosen window so a refresh / tab-switch keeps the
  // selection, and mirror it into the URL so the page can be deep-linked
  // (`?watchWindow=7d`) directly to a non-default window. We use
  // `replaceState` (not navigate) to avoid spamming wouter's history
  // every time the admin toggles the window.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(WATCH_WINDOW_STORAGE_KEY, watchWindow);
    } catch {
      // ignore quota / privacy-mode failures
    }
    const sp = new URLSearchParams(window.location.search);
    if (watchWindow === '24h') {
      // Default value — keep the URL clean instead of pinning ?watchWindow=24h.
      sp.delete('watchWindow');
    } else {
      sp.set('watchWindow', watchWindow);
    }
    const qs = sp.toString();
    const newUrl = `${window.location.pathname}${qs ? `?${qs}` : ''}${window.location.hash}`;
    const currentUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (newUrl !== currentUrl) {
      window.history.replaceState(window.history.state, '', newUrl);
    }
  }, [watchWindow]);

  // Task #1661 — mirror the clubs-list search box and tier/status filters
  // back to the URL + localStorage on every change, so a refresh, a fresh
  // tab, or a shared link keeps the same view. Mirrors only this page's
  // own keys (`q`, `tier`, `status`) so it composes safely with the
  // watchWindow / reviewer / via mirrors above without trampling them.
  // Defaults strip the key from the URL ("clean ?tier=all up") rather
  // than pinning it forever.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      if (search) {
        window.localStorage.setItem(SEARCH_STORAGE_KEY, search);
      } else {
        window.localStorage.removeItem(SEARCH_STORAGE_KEY);
      }
      if (tierFilter === 'all') {
        window.localStorage.removeItem(TIER_FILTER_STORAGE_KEY);
      } else {
        window.localStorage.setItem(TIER_FILTER_STORAGE_KEY, tierFilter);
      }
      if (statusFilter === 'all') {
        window.localStorage.removeItem(STATUS_FILTER_STORAGE_KEY);
      } else {
        window.localStorage.setItem(STATUS_FILTER_STORAGE_KEY, statusFilter);
      }
    } catch {
      // ignore quota / privacy-mode failures
    }
    const sp = new URLSearchParams(window.location.search);
    if (search) {
      sp.set('q', search);
    } else {
      sp.delete('q');
    }
    if (tierFilter === 'all') {
      sp.delete('tier');
    } else {
      sp.set('tier', tierFilter);
    }
    if (statusFilter === 'all') {
      sp.delete('status');
    } else {
      sp.set('status', statusFilter);
    }
    const qs = sp.toString();
    const newUrl = `${window.location.pathname}${qs ? `?${qs}` : ''}${window.location.hash}`;
    const currentUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (newUrl !== currentUrl) {
      window.history.replaceState(window.history.state, '', newUrl);
    }
  }, [search, tierFilter, statusFilter]);

  const {
    data: watchMetrics,
    isLoading: watchMetricsLoading,
    isFetching: watchMetricsFetching,
    error: watchMetricsError,
    refetch: refetchWatchMetrics,
  } = useQuery<WatchPositionMetricsSummary, Error>({
    queryKey: ['/api/super-admin/watch-position-metrics'],
    queryFn: async () => {
      const r = await fetch('/api/super-admin/watch-position-metrics?recent=20');
      if (!r.ok) {
        const text = await r.text().catch(() => '');
        throw new Error(`Failed to load watch position metrics (${r.status}${text ? `: ${text.slice(0, 120)}` : ''})`);
      }
      return r.json();
    },
    enabled: view === 'dashboard',
    refetchInterval: view === 'dashboard' ? 30000 : false,
    staleTime: 15000,
    retry: 1,
  });

  // Task #1195 — drill-down state for the Watch GPS chart. When the admin
  // clicks a point we open a dialog that lists the top sessions whose
  // minute-rows fell inside that bucket.
  interface WatchTopSession {
    sessionId: string;
    userId: number;
    tournamentId: number | null;
    positionCount: number;
    bucketCount: number;
    batteryMode: boolean;
  }
  interface WatchTopSessionsResponse {
    bucketStart: string;
    bucketEnd: string;
    sessions: WatchTopSession[];
  }
  const [watchDrillBucketMs, setWatchDrillBucketMs] = useState<number | null>(null);

  // Task #1392 — secondary drill: from a top-session row, open a panel that
  // lists the raw position payloads the watch session has emitted recently.
  // Backed by a per-replica in-process ring buffer on the api-server side, so
  // ops can decide whether the watch is stuck in a tight loop, drifting, or
  // being faked, without grepping logs.
  interface WatchPositionSamplePayload {
    timestamp: string;
    lat: number;
    lng: number;
    accuracy: number | null;
    batteryMode: boolean;
  }
  interface WatchPositionSamplesResponse {
    sessionId: string;
    samples: WatchPositionSamplePayload[];
    totalSamples: number;
    ringSize: number;
    ttlSeconds: number;
  }
  const [watchPositionsSessionId, setWatchPositionsSessionId] = useState<string | null>(null);
  // Task #2076 — shared hover key for cross-highlighting between the
  // "Recent watch positions" table and the WatchPositionsScatter visual.
  const [watchPositionsHoveredKey, setWatchPositionsHoveredKey] = useState<string | null>(null);
  const {
    data: watchPositionsData,
    isLoading: watchPositionsLoading,
    error: watchPositionsError,
    refetch: refetchWatchPositions,
    isFetching: watchPositionsFetching,
  } = useQuery<WatchPositionSamplesResponse, Error>({
    queryKey: ['/api/super-admin/watch-position-metrics/session', watchPositionsSessionId],
    queryFn: async () => {
      const sid = encodeURIComponent(watchPositionsSessionId as string);
      const r = await fetch(`/api/super-admin/watch-position-metrics/session/${sid}?limit=50`);
      if (!r.ok) {
        const text = await r.text().catch(() => '');
        throw new Error(`Failed to load positions (${r.status}${text ? `: ${text.slice(0, 120)}` : ''})`);
      }
      return r.json();
    },
    enabled: watchPositionsSessionId != null,
    staleTime: 5000,
    retry: 1,
  });

  const watchDrillBucketSeconds = watchMetrics?.seriesBucketSeconds[watchWindow] ?? 60;
  const {
    data: watchDrillData,
    isLoading: watchDrillLoading,
    error: watchDrillError,
  } = useQuery<WatchTopSessionsResponse, Error>({
    queryKey: ['/api/super-admin/watch-position-metrics/top-sessions', watchDrillBucketMs, watchDrillBucketSeconds],
    queryFn: async () => {
      const startIso = new Date(watchDrillBucketMs as number).toISOString();
      const url = `/api/super-admin/watch-position-metrics/top-sessions?bucketStart=${encodeURIComponent(startIso)}&bucketSeconds=${watchDrillBucketSeconds}&limit=10`;
      const r = await fetch(url);
      if (!r.ok) {
        const text = await r.text().catch(() => '');
        throw new Error(`Failed to load top sessions (${r.status}${text ? `: ${text.slice(0, 120)}` : ''})`);
      }
      return r.json();
    },
    enabled: watchDrillBucketMs != null && !!watchMetrics,
    staleTime: 15000,
    retry: 1,
  });

  // Task #1393 — One-click mute for a runaway watch session. The server
  // adds the sessionId to a short-lived block list so further `position`
  // WS messages from that session are dropped (and not counted in
  // metrics) until the mute's TTL expires. The mute is persisted to
  // `watch_session_mutes` (Task #1679) and every other api-server
  // replica picks it up on its next periodic resync tick (Task #2090 /
  // #2120, ≈5s default), so the watch's WebSocket no longer has to
  // drop and reconnect for the silence to take effect across the
  // fleet. We track the in-flight sessionId so we can disable just
  // that row's button (mutation.isPending fires for any pending mute,
  // so it would grey out every button in the dialog without this).
  const [mutingSessionId, setMutingSessionId] = useState<string | null>(null);
  const muteWatchSessionMutation = useMutation({
    mutationFn: async (sessionId: string) => {
      const r = await fetch(
        `/api/super-admin/watch-position-metrics/sessions/${encodeURIComponent(sessionId)}/mute`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
      );
      if (!r.ok) {
        const text = await r.text().catch(() => '');
        throw new Error(text || `Failed to mute session (${r.status})`);
      }
      return r.json() as Promise<{ ok: true; sessionId: string; expiresAt: string; ttlMs: number }>;
    },
    onMutate: (sessionId) => { setMutingSessionId(sessionId); },
    onSuccess: (data) => {
      const minutes = Math.max(1, Math.round(data.ttlMs / 60_000));
      toast({
        title: 'Session muted',
        description: `Position messages from ${data.sessionId.slice(0, 12)}… will be dropped for ~${minutes} min.`,
      });
      // Refresh the drill-down + the headline metrics so the operator
      // immediately sees the rate start to fall on the next refetch tick.
      // Also invalidate the active-mutes panel (Task #1678) so the
      // freshly-muted session shows up there and the drill-down badge
      // flips to "Muted · expires in Xm" without waiting for the 30s
      // poll tick to elapse.
      queryClient.invalidateQueries({ queryKey: ['/api/super-admin/watch-position-metrics/top-sessions'] });
      queryClient.invalidateQueries({ queryKey: ['/api/super-admin/watch-position-metrics'] });
      queryClient.invalidateQueries({ queryKey: ['/api/super-admin/watch-position-metrics/muted-sessions'] });
    },
    onError: (err: Error) => {
      toast({ title: 'Mute failed', description: err.message, variant: 'destructive' });
    },
    onSettled: () => { setMutingSessionId(null); },
  });

  // Task #1678 — list every watch session currently in the in-process
  // mute list on the api-server replica handling the request, so ops can
  // see what's muted without grepping the audit log and lift a mute early
  // when they catch a wrong-watch click. Refetched on the same cadence as
  // the headline metrics so expired entries quietly fall out of the list
  // without needing a manual refresh.
  const {
    data: mutedSessionsData,
    isLoading: mutedSessionsLoading,
    isFetching: mutedSessionsFetching,
    error: mutedSessionsError,
  } = useQuery<WatchMutedSessionsResponse, Error>({
    queryKey: ['/api/super-admin/watch-position-metrics/muted-sessions'],
    queryFn: async () => {
      const r = await fetch('/api/super-admin/watch-position-metrics/muted-sessions');
      if (!r.ok) {
        const text = await r.text().catch(() => '');
        throw new Error(`Failed to load muted sessions (${r.status}${text ? `: ${text.slice(0, 120)}` : ''})`);
      }
      return r.json();
    },
    enabled: view === 'dashboard',
    refetchInterval: view === 'dashboard' ? 30000 : false,
    staleTime: 15000,
    retry: 1,
  });

  // Task #2091 — tick a counter every 15s while the dashboard is open so
  // the "expires in Xm/Ys" labels recompute from `expiresAt` between the
  // 30s react-query refetches. Without this the countdown stays frozen
  // at the value the server returned, so a mute showing "1m" can linger
  // visibly past its actual expiry. We deliberately tick on a 15s cadence
  // (twice per refetch interval) so labels stay close to real time
  // without spending a render every second.
  const [mutedNowTick, setMutedNowTick] = useState(() => Date.now());
  useEffect(() => {
    if (view !== 'dashboard') return;
    // Snap the tick to "now" the moment ops returns to the dashboard so
    // any countdown labels rendered from cached query data don't sit
    // stale for up to 15s waiting for the first interval fire.
    setMutedNowTick(Date.now());
    const id = window.setInterval(() => {
      setMutedNowTick(Date.now());
    }, 15000);
    return () => window.clearInterval(id);
  }, [view]);

  // Recompute remainingMs from `expiresAt` against the live tick so the
  // panel and drill-down badges count down between server refetches, and
  // drop entries whose mute has expired client-side so a stale row
  // doesn't sit there with "0s" until the next refetch arrives.
  const liveMutedSessions = useMemo(() => {
    const sessions = mutedSessionsData?.sessions ?? [];
    if (sessions.length === 0) return [] as WatchMutedSession[];
    return sessions
      .map((m) => {
        const expiresMs = new Date(m.expiresAt).getTime();
        const remaining = Number.isFinite(expiresMs)
          ? Math.max(0, expiresMs - mutedNowTick)
          : Math.max(0, m.remainingMs);
        return { ...m, remainingMs: remaining };
      })
      .filter((m) => m.remainingMs > 0);
  }, [mutedSessionsData, mutedNowTick]);

  // Look up the active mute for a sessionId so the drill-down dialog can
  // swap the per-row "Mute" button for a "Muted · expires in Xm" badge
  // when ops re-opens the same bucket without first refreshing the panel.
  // Built from `liveMutedSessions` so client-side expiries also drop the
  // badge from the drill-down without waiting for the next refetch.
  const mutedSessionLookup = useMemo(
    () => new Map(liveMutedSessions.map((m) => [m.sessionId, m] as const)),
    [liveMutedSessions],
  );

  // Track which sessionId is mid-unmute so we disable just that row's
  // button instead of greying out every row in the dialog.
  const [unmutingSessionId, setUnmutingSessionId] = useState<string | null>(null);
  // Task #2092 — instead of firing the DELETE on the row's button click,
  // we stash the row that was clicked and pop a confirmation dialog. A
  // stray click in the Active mutes panel used to immediately re-open
  // the firehose; the dialog forces a deliberate "Yes, lift it" plus an
  // optional free-text "why" we forward to the audit row.
  const [pendingUnmuteSession, setPendingUnmuteSession] = useState<WatchMutedSession | null>(null);
  const [unmuteReasonDraft, setUnmuteReasonDraft] = useState('');
  const unmuteWatchSessionMutation = useMutation({
    mutationFn: async (vars: { sessionId: string; reason: string }) => {
      const trimmed = vars.reason.trim();
      const r = await fetch(
        `/api/super-admin/watch-position-metrics/sessions/${encodeURIComponent(vars.sessionId)}/mute`,
        {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          // Always send a JSON body so the server's body parser fires
          // the same way regardless of whether ops typed a reason.
          body: JSON.stringify(trimmed.length > 0 ? { reason: trimmed } : {}),
        },
      );
      if (!r.ok) {
        const text = await r.text().catch(() => '');
        throw new Error(text || `Failed to unmute session (${r.status})`);
      }
      return r.json() as Promise<{ ok: true; sessionId: string }>;
    },
    onMutate: (vars) => { setUnmutingSessionId(vars.sessionId); },
    onSuccess: (data) => {
      toast({
        title: 'Mute lifted',
        description: `${data.sessionId.slice(0, 12)}… can resume sending position messages.`,
      });
      queryClient.invalidateQueries({ queryKey: ['/api/super-admin/watch-position-metrics/muted-sessions'] });
      queryClient.invalidateQueries({ queryKey: ['/api/super-admin/watch-position-metrics/top-sessions'] });
      queryClient.invalidateQueries({ queryKey: ['/api/super-admin/watch-position-metrics'] });
      // Close the confirm dialog + reset the draft only on success;
      // failures keep the dialog open so the operator can retry without
      // re-typing whatever justification they wrote.
      setPendingUnmuteSession(null);
      setUnmuteReasonDraft('');
    },
    onError: (err: Error) => {
      toast({ title: 'Unmute failed', description: err.message, variant: 'destructive' });
    },
    onSettled: () => { setUnmutingSessionId(null); },
  });
  // Mirror the audit-side cap so the helper text + maxLength match what
  // the server will actually persist. Keep these in sync if you change
  // UNMUTE_REASON_MAX_LENGTH on the API.
  const UNMUTE_REASON_MAX_LENGTH = 500;

  // Task #1653 — fire a clearly-labelled test page through the same Slack
  // / PagerDuty senders the real watch-GPS spike alert uses, so a typo in
  // the env vars surfaces NOW instead of silently swallowing a real spike.
  // Task #2057 — extracted into a shared hook; the previous bespoke
  // useMutation lived here verbatim for ~50 lines and is now reused
  // across every ops-alert dashboard. Task #2056 — also refresh the
  // audit-history query on success so the "Last test page: 3h ago by …"
  // line and the 30-day chart pick up this click immediately, without
  // waiting for the next 30s poll.
  const sendOpsAlertTestPage = useOpsAlertTestPageMutation({
    endpoint: '/api/super-admin/watch-position-metrics/test-ops-alert-chat',
    invalidateQueryKeys: [
      ['/api/super-admin/watch-position-metrics'],
      ['/api/super-admin/watch-position-metrics/test-ops-alert-chat-history'],
    ],
    slackEnvVar: 'OPS_WATCH_GPS_ALERT_SLACK_WEBHOOK',
    pagerDutyEnvVar: 'OPS_WATCH_GPS_ALERT_PAGERDUTY_ROUTING_KEY',
  });

  // Task #2057 — same Slack-/PagerDuty-test-page pattern, but for the
  // notification retry-exhaustion ops alert. Mounted inside the
  // existing "Ops alert tunables" card next to the "Send test alert"
  // (email) button so an admin can verify the chat side too without
  // hopping between dashboards.
  const sendNotifyRetryOpsAlertTestPage = useOpsAlertTestPageMutation({
    endpoint: '/api/super-admin/ops-alert-settings/test-ops-alert-chat',
    // Inline literal here (not the `opsAlertSettingsQueryKey` const)
    // because that const is declared further down the component and
    // hoisting through `const` is a TDZ trap; the literal keeps the
    // dependency direction one-way.
    invalidateQueryKeys: [['/api/super-admin/ops-alert-settings']],
    slackEnvVar: 'OPS_NOTIFY_RETRY_ALERT_SLACK_WEBHOOK',
    pagerDutyEnvVar: 'OPS_NOTIFY_RETRY_ALERT_PAGERDUTY_ROUTING_KEY',
  });

  // Task #2056 — load the audit history of past "Send test page" clicks
  // so the panel can render "Last test page: 3h ago by …" plus a small
  // 30-day frequency chart under the wiring badges. Polls on the same
  // 30s cadence as the parent metrics query so a click on another
  // replica's super-admin tab is reflected here.
  const {
    data: opsAlertTestPageHistory,
  } = useQuery<WatchOpsAlertChatTestHistory, Error>({
    queryKey: ['/api/super-admin/watch-position-metrics/test-ops-alert-chat-history'],
    queryFn: async () => {
      const r = await fetch('/api/super-admin/watch-position-metrics/test-ops-alert-chat-history');
      if (!r.ok) {
        const text = await r.text().catch(() => '');
        throw new Error(`Failed to load test page history (${r.status}${text ? `: ${text.slice(0, 120)}` : ''})`);
      }
      return r.json();
    },
    enabled: view === 'dashboard',
    refetchInterval: view === 'dashboard' ? 30000 : false,
    staleTime: 15000,
    retry: 1,
  });

  // Task #1962 — legacy video duration backfill, surfaced as a dashboard
  // tile + button. Tasks #1323 and #1574 mean videos with NULL
  // `duration_seconds` silently lose the highlight editor's trim slider;
  // the backfill script existed since Task #855 but only the platform
  // team could run it from the shell. The producer can now drain the
  // backlog from here without leaving the dashboard.
  const legacyVideoCountQueryKey = ['/api/super-admin/legacy-videos/un-measured-count'] as const;
  const {
    data: legacyVideoCountData,
    isLoading: legacyVideoCountLoading,
    isFetching: legacyVideoCountFetching,
    refetch: refetchLegacyVideoCount,
  } = useQuery<{ count: number; batchSize: number }, Error>({
    queryKey: legacyVideoCountQueryKey,
    queryFn: async () => {
      const r = await fetch('/api/super-admin/legacy-videos/un-measured-count');
      if (!r.ok) {
        const text = await r.text().catch(() => '');
        throw new Error(text || `Failed to load count (${r.status})`);
      }
      return r.json();
    },
    enabled: view === 'dashboard',
    staleTime: 15000,
  });

  const legacyVideoBackfillMutation = useMutation<
    {
      ok: true;
      attempted: number;
      recovered: number;
      stillFailing: number;
      objectMissing: number;
      remaining: number;
      batchSize: number;
    },
    Error,
    void
  >({
    mutationFn: async () => {
      const r = await fetch('/api/super-admin/legacy-videos/probe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      if (!r.ok) {
        const text = await r.text().catch(() => '');
        throw new Error(text || `Re-probe failed (${r.status})`);
      }
      return r.json();
    },
    onSuccess: (data) => {
      // Refresh the count so the producer sees the backlog tick down.
      queryClient.invalidateQueries({ queryKey: legacyVideoCountQueryKey });
      if (data.attempted === 0) {
        toast({
          title: 'Nothing to re-probe',
          description: 'No legacy videos remain in the un-measured queue.',
        });
        return;
      }
      const parts = [
        `Tried ${data.attempted}`,
        `${data.recovered} recovered`,
        `${data.stillFailing} still failing`,
      ];
      if (data.objectMissing > 0) parts.push(`${data.objectMissing} object missing`);
      if (data.remaining > 0) parts.push(`${data.remaining} remaining`);
      toast({
        title: 'Legacy videos re-probed',
        description: parts.join(' · '),
      });
    },
    onError: (err) => {
      toast({ title: 'Re-probe failed', description: err.message, variant: 'destructive' });
    },
  });

  const params = new URLSearchParams();
  if (search) params.set('search', search);
  if (tierFilter !== 'all') params.set('tier', tierFilter);
  if (statusFilter !== 'all') params.set('status', statusFilter);

  const { data: clubsData, isLoading: clubsLoading, refetch: refetchClubs } = useQuery<{ clubs: Club[]; total: number }>({
    queryKey: ['/api/super-admin/clubs', search, tierFilter, statusFilter],
    queryFn: () => fetch(`/api/super-admin/clubs?${params.toString()}`).then(r => r.json()),
    staleTime: 10000,
  });

  const { data: plansData, isLoading: plansLoading } = useQuery<PlanConfig[]>({
    queryKey: ['/api/super-admin/plans'],
    queryFn: () => fetch('/api/super-admin/plans').then(r => r.json()),
    staleTime: 30000,
    enabled: view === 'plans',
  });

  const planMigrationsQueryKey = [
    '/api/super-admin/plan-migration-audit',
    includeAcknowledged,
    reviewerFilter,
    viaFilter,
    sort,
  ] as const;
  const { data: planMigrations, isLoading: planMigrationsLoading } = useQuery<{
    entries: PlanMigrationEntry[];
    total: number;
    page: number;
    limit: number;
    reviewerStats?: { userId: number; name: string; count: number }[];
  }>({
    queryKey: planMigrationsQueryKey,
    queryFn: () => {
      const params = new URLSearchParams({ limit: '500' });
      if (includeAcknowledged) params.set('includeAcknowledged', '1');
      if (reviewerFilter !== 'all') params.set('acknowledgedByUserId', String(reviewerFilter));
      if (viaFilter !== 'any') params.set('acknowledgedVia', viaFilter);
      // Task #1929 — only send sort=newest; the server already defaults to
      // 'oldest' so we keep the URL clean for the common case.
      if (sort === 'newest') params.set('sort', 'newest');
      return fetch(`/api/super-admin/plan-migration-audit?${params.toString()}`).then(r => r.json());
    },
    enabled: view === 'plan-migrations',
    staleTime: 15000,
  });

  // Distinct reviewers used to populate the "Acknowledged by …" dropdown
  // (Task #1314). The server returns an all-time aggregate (Task #1553) so
  // each option carries the total number of rows that reviewer has ack'd —
  // independent of the current filters. Falling back to the current page's
  // entries keeps the dropdown working on older API responses, and we always
  // keep the currently-selected reviewer in the list even if they have no
  // rows yet — otherwise the dropdown would visually "lose" the selection.
  // Task #1941 — sort by count descending (so the heaviest reviewers float to
  // the top and zero-count entries fall to the bottom), with name ascending
  // as a tie-breaker.
  const reviewerOptions = (() => {
    const sortByCountThenName = (
      a: { name: string; count: number },
      b: { name: string; count: number },
    ) => b.count - a.count || a.name.localeCompare(b.name);
    const stats = planMigrations?.reviewerStats;
    if (stats && stats.length > 0) {
      const list = stats.map(s => ({ id: s.userId, name: s.name, count: s.count }));
      if (typeof reviewerFilter === 'number' && !list.some(o => o.id === reviewerFilter)) {
        list.push({ id: reviewerFilter, name: `User #${reviewerFilter}`, count: 0 });
      }
      return list.sort(sortByCountThenName);
    }
    const seen = new Map<number, { name: string; count: number }>();
    for (const e of planMigrations?.entries ?? []) {
      if (e.acknowledgedByUserId == null) continue;
      const existing = seen.get(e.acknowledgedByUserId);
      if (existing) {
        existing.count += 1;
      } else {
        seen.set(e.acknowledgedByUserId, {
          name: e.acknowledgedByName ?? `User #${e.acknowledgedByUserId}`,
          count: 1,
        });
      }
    }
    if (typeof reviewerFilter === 'number' && !seen.has(reviewerFilter)) {
      seen.set(reviewerFilter, { name: `User #${reviewerFilter}`, count: 0 });
    }
    return Array.from(seen.entries())
      .map(([id, v]) => ({ id, name: v.name, count: v.count }))
      .sort(sortByCountThenName);
  })();

  // Editable mapping of legacy plan slugs → recognised tiers (Task #1131).
  // Replaces the previously hardcoded LEGACY_SLUG_TIER_GUESSES so support
  // staff can add/edit entries without a code deploy.
  const legacySlugMappingsQueryKey = ['/api/super-admin/legacy-slug-mappings'] as const;
  const { data: legacySlugMappingsData, isLoading: legacySlugMappingsLoading, error: legacySlugMappingsError } = useQuery<{ mappings: LegacySlugMapping[] }, Error>({
    queryKey: legacySlugMappingsQueryKey,
    queryFn: async () => {
      const r = await fetch('/api/super-admin/legacy-slug-mappings');
      if (!r.ok) {
        const text = await r.text().catch(() => '');
        throw new Error(`Failed to load slug mappings (${r.status}${text ? `: ${text.slice(0, 120)}` : ''})`);
      }
      return r.json();
    },
    enabled: view === 'plan-migrations',
    staleTime: 60000,
    retry: 1,
  });
  const legacySlugMappings: LegacySlugMapping[] = legacySlugMappingsData?.mappings ?? [];
  const legacySlugMap: Record<string, RecognisedTier> = {};
  for (const m of legacySlugMappings) legacySlugMap[m.slug] = m.tier;

  const [newSlug, setNewSlug] = useState('');
  const [newSlugTier, setNewSlugTier] = useState<RecognisedTier>('starter');
  const [newSlugNotes, setNewSlugNotes] = useState('');

  // Ops alert tunables (Task #1305) — admin-editable threshold + window
  // for the retry-exhaustion ops alert. Empty inputs mean "fall back to
  // env / default", which the API encodes as null.
  const opsAlertSettingsQueryKey = ['/api/super-admin/ops-alert-settings'] as const;
  const { data: opsAlertSettingsData, isLoading: opsAlertSettingsLoading } =
    useQuery<{ config: OpsAlertConfig }, Error>({
      queryKey: opsAlertSettingsQueryKey,
      queryFn: async () => {
        const r = await fetch('/api/super-admin/ops-alert-settings');
        if (!r.ok) {
          const text = await r.text().catch(() => '');
          throw new Error(`Failed to load ops alert settings (${r.status}${text ? `: ${text.slice(0, 120)}` : ''})`);
        }
        return r.json();
      },
      enabled: view === 'dashboard',
      staleTime: 30000,
    });
  const opsAlertConfig = opsAlertSettingsData?.config ?? null;
  const [opsThresholdDraft, setOpsThresholdDraft] = useState<string>('');
  const [opsWindowDraft, setOpsWindowDraft] = useState<string>('');
  // Reset drafts when the server's stored DB values change (initial load
  // + after a successful save). We key off the stored override values +
  // updatedAt rather than the resolved values so an env-var fallback
  // doesn't pre-fill the input — a blank input means "inherit".
  // Task #1664 — also seed/reset the four manual-entry alert tunable
  // drafts off the same key. Empty string means "inherit"; the key
  // includes every db* override + updatedAt so a save round-trip
  // re-syncs every input.
  const [opsMeRateDraft, setOpsMeRateDraft] = useState<string>('');
  const [opsMeMinSampleDraft, setOpsMeMinSampleDraft] = useState<string>('');
  const [opsMeConsecZeroDraft, setOpsMeConsecZeroDraft] = useState<string>('');
  const [opsMeCooldownDraft, setOpsMeCooldownDraft] = useState<string>('');
  // Task #2081 — three additional manual-entry tunables. Numeric
  // drafts (string for empty-state) plus a tri-state dry-run draft
  // ('' = inherit, 'true' / 'false' = explicit override) so a user can
  // clear an override without unchecking → toggling. Mirrors the rest
  // of this card's "blank input == inherit" semantics.
  const [opsMeLookbackDraft, setOpsMeLookbackDraft] = useState<string>('');
  const [opsMeRecipientLookupLimitDraft, setOpsMeRecipientLookupLimitDraft] = useState<string>('');
  const [opsMeDryRunDraft, setOpsMeDryRunDraft] = useState<'' | 'true' | 'false'>('');
  // Task #1910 — DB-backed override for the retry-exhaustion ops alert
  // recipient list. Stored as a free-form textarea (one per line or
  // comma-separated) so admins can paste a distribution list without
  // having to use a tag/chip widget; we lowercase / dedupe / validate
  // server-side. Empty draft = clear the override and inherit from env.
  const [opsRecipientsDraft, setOpsRecipientsDraft] = useState<string>('');
  const opsConfigKey = opsAlertConfig
    ? [
        opsAlertConfig.dbThreshold ?? '',
        opsAlertConfig.dbWindowHours ?? '',
        opsAlertConfig.manualEntry?.dbRateThresholdPct ?? '',
        opsAlertConfig.manualEntry?.dbMinSample ?? '',
        opsAlertConfig.manualEntry?.dbConsecutiveZero ?? '',
        opsAlertConfig.manualEntry?.dbCooldownHours ?? '',
        // Task #2081 — three additional manual-entry overrides need to
        // be in the cache key so a save that only touches one of them
        // still re-syncs the input drafts.
        opsAlertConfig.manualEntry?.dbLookbackHours ?? '',
        opsAlertConfig.manualEntry?.dbDryRun === null || opsAlertConfig.manualEntry?.dbDryRun === undefined
          ? ''
          : opsAlertConfig.manualEntry.dbDryRun ? 'true' : 'false',
        opsAlertConfig.manualEntry?.dbRecipientLookupLimit ?? '',
        // Recipients dbList serialised so a save round-trip re-syncs
        // the textarea even when only the recipient override changed.
        opsAlertConfig.recipients?.dbList === null ? '<null>' : (opsAlertConfig.recipients?.dbList ?? []).join(','),
        opsAlertConfig.updatedAt ?? '',
      ].join('|')
    : '';
  useEffect(() => {
    if (!opsAlertConfig) return;
    setOpsThresholdDraft(opsAlertConfig.dbThreshold !== null ? String(opsAlertConfig.dbThreshold) : '');
    setOpsWindowDraft(opsAlertConfig.dbWindowHours !== null ? String(opsAlertConfig.dbWindowHours) : '');
    const me = opsAlertConfig.manualEntry;
    if (me) {
      setOpsMeRateDraft(me.dbRateThresholdPct !== null ? String(me.dbRateThresholdPct) : '');
      setOpsMeMinSampleDraft(me.dbMinSample !== null ? String(me.dbMinSample) : '');
      setOpsMeConsecZeroDraft(me.dbConsecutiveZero !== null ? String(me.dbConsecutiveZero) : '');
      setOpsMeCooldownDraft(me.dbCooldownHours !== null ? String(me.dbCooldownHours) : '');
      // Task #2081 — same blank-means-inherit semantics for the new
      // three. dryRun is tri-state ('' | 'true' | 'false') so an
      // explicit `false` override stays distinguishable from "no
      // override stored, inheriting the default of false".
      setOpsMeLookbackDraft(me.dbLookbackHours !== null ? String(me.dbLookbackHours) : '');
      setOpsMeRecipientLookupLimitDraft(me.dbRecipientLookupLimit !== null ? String(me.dbRecipientLookupLimit) : '');
      setOpsMeDryRunDraft(me.dbDryRun === null || me.dbDryRun === undefined ? '' : me.dbDryRun ? 'true' : 'false');
    }
    const r = opsAlertConfig.recipients;
    if (r) {
      // dbList === null → no override → blank textarea (placeholder shows env list).
      // dbList === [] → admin explicitly cleared → also blank, since the
      // resolver collapses [] back to env. Storing an empty draft keeps
      // the input semantically equivalent to "inherit from env".
      setOpsRecipientsDraft(r.dbList && r.dbList.length > 0 ? r.dbList.join('\n') : '');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opsConfigKey]);

  // Task #1546 — audit trail of ops alert tunable changes. Newest 10
  // entries; refetched whenever a save bumps the settings query so the
  // "Recent changes" list lights up immediately after a save.
  // Task #1924 — the same endpoint now also serves the paginated
  // "Show all" browser further down, so we share one queryKey prefix
  // and let the second call vary it via filter / page params.
  const opsAlertHistoryQueryKey = ['/api/super-admin/ops-alert-settings/history'] as const;
  const { data: opsAlertHistoryData, isLoading: opsAlertHistoryLoading } =
    useQuery<{ entries: OpsAlertHistoryEntry[]; total: number; limit: number; offset: number }, Error>({
      queryKey: opsAlertHistoryQueryKey,
      queryFn: async () => {
        const r = await fetch('/api/super-admin/ops-alert-settings/history?limit=10');
        if (!r.ok) {
          const text = await r.text().catch(() => '');
          throw new Error(`Failed to load ops alert history (${r.status}${text ? `: ${text.slice(0, 120)}` : ''})`);
        }
        return r.json();
      },
      enabled: view === 'dashboard',
      staleTime: 30000,
    });
  const opsAlertHistory = opsAlertHistoryData?.entries ?? [];
  const opsAlertHistoryTotal = opsAlertHistoryData?.total ?? 0;

  // Task #2055 — fetch the sanitised Slack / PagerDuty chat-target
  // status for the retry-exhaustion ops alert (and the watch GPS
  // spike alert for completeness) so the card can render
  // "Slack ✓ (shared) / PagerDuty ✗" badges next to the email
  // recipient list. Lets admins tell BEFORE pressing "Send test alert"
  // whether chat will fire — and which env var to set when a channel
  // is missing — without grepping server logs.
  const opsAlertChatTargetsQueryKey = ['/api/super-admin/ops-alert-settings/chat-targets'] as const;
  const {
    data: opsAlertChatTargetsData,
    isLoading: opsAlertChatTargetsLoading,
    error: opsAlertChatTargetsError,
  } = useQuery<OpsAlertChatTargetsResponse, Error>({
    queryKey: opsAlertChatTargetsQueryKey,
    queryFn: async () => {
      const r = await fetch('/api/super-admin/ops-alert-settings/chat-targets');
      if (!r.ok) {
        const text = await r.text().catch(() => '');
        throw new Error(`Failed to load ops alert chat targets (${r.status}${text ? `: ${text.slice(0, 120)}` : ''})`);
      }
      return r.json();
    },
    enabled: view === 'dashboard',
    staleTime: 30000,
  });
  const opsAlertChatTargets = opsAlertChatTargetsData?.flows.notifyRetryExhaustion ?? null;

  // Task #1924 — "Show all" paginated browser. Date-range + editor
  // filters live as draft state so admins can tune them before
  // hitting Apply (avoids a fetch storm while typing). The applied
  // filters drive both the fetch and the query key so going Prev/Next
  // keeps the same scope. We re-derive `editorOptions` from whatever
  // entries we've seen across the dashboard list + dialog pages so
  // ops can filter by anyone whose change is currently visible.
  const OPS_ALERT_HISTORY_PAGE_SIZE = 25;
  const [opsHistoryDialogOpen, setOpsHistoryDialogOpen] = useState(false);
  const [opsHistoryFromDraft, setOpsHistoryFromDraft] = useState('');
  const [opsHistoryToDraft, setOpsHistoryToDraft] = useState('');
  const [opsHistoryEditorDraft, setOpsHistoryEditorDraft] = useState<string>('all');
  const [opsHistoryAppliedFrom, setOpsHistoryAppliedFrom] = useState('');
  const [opsHistoryAppliedTo, setOpsHistoryAppliedTo] = useState('');
  const [opsHistoryAppliedEditor, setOpsHistoryAppliedEditor] = useState<string>('all');
  const [opsHistoryPage, setOpsHistoryPage] = useState(0);

  // Translate the draft "yyyy-MM-ddThh:mm" datetime-local input into
  // an ISO timestamp the server can parse. Empty => undefined.
  const opsHistoryFilterParams: { from?: string; to?: string; editorId?: string } = {};
  if (opsHistoryAppliedFrom) {
    const d = new Date(opsHistoryAppliedFrom);
    if (!Number.isNaN(d.getTime())) opsHistoryFilterParams.from = d.toISOString();
  }
  if (opsHistoryAppliedTo) {
    const d = new Date(opsHistoryAppliedTo);
    if (!Number.isNaN(d.getTime())) opsHistoryFilterParams.to = d.toISOString();
  }
  if (opsHistoryAppliedEditor === 'none') {
    opsHistoryFilterParams.editorId = 'none';
  } else if (opsHistoryAppliedEditor !== 'all') {
    opsHistoryFilterParams.editorId = opsHistoryAppliedEditor;
  }

  const opsHistoryFullQueryKey = [
    '/api/super-admin/ops-alert-settings/history',
    'paginated',
    opsHistoryPage,
    opsHistoryFilterParams.from ?? '',
    opsHistoryFilterParams.to ?? '',
    opsHistoryFilterParams.editorId ?? '',
  ] as const;
  const { data: opsAlertHistoryFullData, isLoading: opsAlertHistoryFullLoading, isFetching: opsAlertHistoryFullFetching, error: opsAlertHistoryFullError } =
    useQuery<{ entries: OpsAlertHistoryEntry[]; total: number; limit: number; offset: number }, Error>({
      queryKey: opsHistoryFullQueryKey,
      queryFn: async () => {
        const params = new URLSearchParams();
        params.set('limit', String(OPS_ALERT_HISTORY_PAGE_SIZE));
        params.set('offset', String(opsHistoryPage * OPS_ALERT_HISTORY_PAGE_SIZE));
        if (opsHistoryFilterParams.from) params.set('from', opsHistoryFilterParams.from);
        if (opsHistoryFilterParams.to) params.set('to', opsHistoryFilterParams.to);
        if (opsHistoryFilterParams.editorId) params.set('editorId', opsHistoryFilterParams.editorId);
        const r = await fetch(`/api/super-admin/ops-alert-settings/history?${params.toString()}`);
        if (!r.ok) {
          const text = await r.text().catch(() => '');
          throw new Error(`Failed to load ops alert history (${r.status}${text ? `: ${text.slice(0, 160)}` : ''})`);
        }
        return r.json();
      },
      enabled: opsHistoryDialogOpen,
      staleTime: 15000,
    });
  const opsAlertHistoryFullEntries = opsAlertHistoryFullData?.entries ?? [];
  const opsAlertHistoryFullTotal = opsAlertHistoryFullData?.total ?? 0;
  const opsAlertHistoryFullPageCount = Math.max(
    1,
    Math.ceil(opsAlertHistoryFullTotal / OPS_ALERT_HISTORY_PAGE_SIZE),
  );

  // Build the editor dropdown options from all editors we've already
  // observed across the dashboard list + the currently-loaded dialog
  // page. There is no separate "list of editors" endpoint — the audit
  // table itself is the source of truth, and showing only known
  // editors keeps the dropdown short and meaningful (anyone who has
  // never edited can't appear in history anyway). De-duplicate by
  // user id so the same editor isn't listed twice.
  const opsHistoryEditorOptions: Array<{ id: number; label: string }> = [];
  {
    const seen = new Set<number>();
    const addFrom = (entries: OpsAlertHistoryEntry[]) => {
      for (const e of entries) {
        if (e.changedByUserId === null) continue;
        if (seen.has(e.changedByUserId)) continue;
        seen.add(e.changedByUserId);
        const label = e.changedByDisplayName
          || e.changedByUsername
          || `user #${e.changedByUserId}`;
        opsHistoryEditorOptions.push({ id: e.changedByUserId, label });
      }
    };
    addFrom(opsAlertHistory);
    addFrom(opsAlertHistoryFullEntries);
    opsHistoryEditorOptions.sort((a, b) => a.label.localeCompare(b.label));
  }

  const updateOpsAlertSettingsMutation = useMutation({
    mutationFn: async (input: {
      notifyExhaustionThreshold?: number | null;
      notifyExhaustionWindowHours?: number | null;
      manualEntryRateThresholdPct?: number | null;
      manualEntryMinSample?: number | null;
      manualEntryConsecutiveZero?: number | null;
      manualEntryCooldownHours?: number | null;
      // Task #2081 — three additional manual-entry knobs. `null`
      // clears any DB override and lets the resolver fall back to
      // env / default. `undefined` (field omitted) leaves the existing
      // override untouched.
      manualEntryLookbackHours?: number | null;
      manualEntryDryRun?: boolean | null;
      manualEntryRecipientLookupLimit?: number | null;
      // Task #1910 — recipient list override. `null` clears the
      // override (fall back to env). `string[]` sets it; an empty
      // array is also accepted server-side and resolves the same as
      // null (env list is the floor — see lib/opsAlertSettings.ts).
      notifyExhaustionRecipients?: string[] | null;
    }) => {
      const r = await fetch('/api/super-admin/ops-alert-settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Failed to save ops alert settings');
      return d;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: opsAlertSettingsQueryKey });
      // Both the dashboard "Recent changes" list and the Task #1924
      // paginated "Show all" dialog read from the same endpoint, so
      // bust every variant of the query key (queryClient matches on
      // the prefix when an exact key isn't supplied).
      queryClient.invalidateQueries({ queryKey: opsAlertHistoryQueryKey });
      toast({ title: 'Ops alert settings saved', description: 'The cron will pick up the change on its next run.' });
    },
    onError: (err: Error) => toast({ title: 'Error', description: err.message, variant: 'destructive' }),
  });

  // Task #1547 — manual delivery check. Confirm dialog gates the click
  // because the email lands in the live OPS_ALERT_EMAILS inbox(es).
  // Task #1917 — the dialog also exposes an optional override recipient
  // so an admin can preview the email on their own inbox without
  // paging the live ops list.
  const [opsTestConfirmOpen, setOpsTestConfirmOpen] = useState(false);
  const [opsTestOverrideEmail, setOpsTestOverrideEmail] = useState('');
  const sendOpsAlertTestMutation = useMutation({
    mutationFn: async (input: { overrideRecipient?: string }) => {
      const body = input.overrideRecipient
        ? JSON.stringify({ overrideRecipient: input.overrideRecipient })
        : undefined;
      const r = await fetch('/api/super-admin/ops-alert-settings/test', {
        method: 'POST',
        ...(body ? { headers: { 'Content-Type': 'application/json' }, body } : {}),
      });
      let d: { ok?: boolean; recipients?: number; overrideRecipient?: string; error?: string; reason?: string } = {};
      try { d = await r.json(); } catch { /* empty body */ }
      if (!r.ok) {
        const err = new Error(d.error || `Failed to send test alert (HTTP ${r.status})`) as Error & { reason?: string };
        err.reason = d.reason;
        throw err;
      }
      return d as { ok: true; recipients: number; overrideRecipient?: string };
    },
    onSuccess: (d) => {
      setOpsTestConfirmOpen(false);
      setOpsTestOverrideEmail('');
      // Task #1916 — refresh the settings query so the "Last test sent
      // … ago to N recipient(s)" line next to the button updates
      // immediately (the POST stamps the singleton row server-side).
      queryClient.invalidateQueries({ queryKey: opsAlertSettingsQueryKey });
      // Task #1917 + #1910 — when the admin used the per-send override
      // recipient, surface that exact address in the toast so they
      // know the live ops list (env or DB-backed) was bypassed. For
      // the normal path, the recipients can come from either
      // OPS_ALERT_EMAILS (env) or the new DB-backed override (Task
      // #1910), so we keep the wording generic ("ops-alert
      // recipient") rather than naming a specific source.
      const description = d.overrideRecipient
        ? `Delivered only to ${d.overrideRecipient} (the live ops-alert recipient list was bypassed). Check that inbox to confirm receipt.`
        : `Delivered to ${d.recipients} ops-alert recipient${d.recipients === 1 ? '' : 's'}. Check the inbox to confirm receipt.`;
      toast({ title: 'Test alert sent', description });
    },
    onError: (err: Error & { reason?: string }) => {
      const isInvalidOverride = err.reason === 'invalid_override_recipient';
      const isNoRecipients = err.reason === 'no_recipients';
      // Keep the dialog open on input-validation errors so the admin
      // can fix the override value without re-opening the dialog.
      if (!isInvalidOverride) setOpsTestConfirmOpen(false);
      toast({
        title: isInvalidOverride
          ? 'Invalid override email'
          : isNoRecipients
            ? 'No recipients configured'
            : 'Test alert failed',
        description: isInvalidOverride
          ? err.message
          : isNoRecipients
            // Task #1910 — recipients can now come from the DB-backed
            // override section above OR OPS_ALERT_EMAILS, so the
            // remediation message points at both.
            ? 'Add at least one recipient in the Recipient list section above (or set OPS_ALERT_EMAILS in the API server environment), then try again.'
            : err.message,
        variant: 'destructive',
      });
    },
  });

  const upsertSlugMutation = useMutation({
    mutationFn: async ({ slug, tier, notes }: { slug: string; tier: RecognisedTier; notes?: string }) => {
      const r = await fetch(`/api/super-admin/legacy-slug-mappings/${encodeURIComponent(slug)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tier, notes: notes ?? null }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Failed to save mapping');
      return d;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: legacySlugMappingsQueryKey });
      toast({ title: 'Mapping saved', description: 'Plan slug suggestions updated.' });
      setNewSlug(''); setNewSlugNotes('');
    },
    onError: (err: Error) => toast({ title: 'Error', description: err.message, variant: 'destructive' }),
  });

  const deleteSlugMutation = useMutation({
    mutationFn: async (slug: string) => {
      const r = await fetch(`/api/super-admin/legacy-slug-mappings/${encodeURIComponent(slug)}`, { method: 'DELETE' });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Failed to remove mapping');
      return d;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: legacySlugMappingsQueryKey });
      toast({ title: 'Mapping removed' });
    },
    onError: (err: Error) => toast({ title: 'Error', description: err.message, variant: 'destructive' }),
  });

  const acknowledgeMigrationMutation = useMutation({
    mutationFn: (id: number) =>
      fetch(`/api/super-admin/plan-migration-audit/${id}/acknowledge`, {
        method: 'POST',
      }).then(async r => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || 'Failed');
        return d;
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/super-admin/plan-migration-audit'] });
      // Task #1930 — also refresh the nav badge so it reflects the
      // acknowledgement immediately rather than waiting for the next 60s
      // poll. Same key the badge query uses on initial mount.
      queryClient.invalidateQueries({ queryKey: ['/api/super-admin/plan-migration-audit/stale-summary'] });
      toast({ title: 'Acknowledged', description: 'Migration entry marked as reviewed.' });
    },
    onError: (err: Error) => {
      toast({ title: 'Error', description: err.message, variant: 'destructive' });
    },
  });

  const restoreMigrationMutation = useMutation({
    mutationFn: async ({ id, orgId, tier }: { id: number; orgId: number; tier: RecognisedTier }) => {
      const tierRes = await fetch(`/api/super-admin/clubs/${orgId}/tier`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscriptionTier: tier }),
      });
      const tierData = await tierRes.json();
      if (!tierRes.ok) {
        const err = new Error(tierData.error || 'Failed to restore tier') as Error & { tierApplied?: boolean };
        err.tierApplied = false;
        throw err;
      }

      const ackRes = await fetch(`/api/super-admin/plan-migration-audit/${id}/acknowledge`, {
        method: 'POST',
      });
      const ackData = await ackRes.json();
      if (!ackRes.ok) {
        const err = new Error(ackData.error || 'Tier restored but failed to mark row reviewed') as Error & { tierApplied?: boolean };
        err.tierApplied = true;
        throw err;
      }
      return { tier };
    },
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({ queryKey: ['/api/super-admin/plan-migration-audit'] });
      // Task #1930 — restoring the tier also acknowledges the row, so the
      // nav badge needs the same refresh to drop this entry from its count.
      queryClient.invalidateQueries({ queryKey: ['/api/super-admin/plan-migration-audit/stale-summary'] });
      queryClient.invalidateQueries({ queryKey: ['/api/super-admin/clubs'] });
      queryClient.invalidateQueries({ queryKey: ['/api/super-admin/dashboard'] });
      toast({ title: 'Plan restored', description: `Club is back on the ${vars.tier} plan.` });
    },
    onError: (err: Error & { tierApplied?: boolean }) => {
      // If the tier update already landed but acknowledge failed, refresh
      // the same caches so the UI doesn't show stale tier/audit data.
      if (err.tierApplied) {
        queryClient.invalidateQueries({ queryKey: ['/api/super-admin/plan-migration-audit'] });
        queryClient.invalidateQueries({ queryKey: ['/api/super-admin/plan-migration-audit/stale-summary'] });
        queryClient.invalidateQueries({ queryKey: ['/api/super-admin/clubs'] });
        queryClient.invalidateQueries({ queryKey: ['/api/super-admin/dashboard'] });
      }
      toast({ title: 'Error', description: err.message, variant: 'destructive' });
    },
  });

  // Task #1575 — admin-triggered re-run of the plan migration. Hits the
  // dedicated endpoint added by Task #1308 (NOT PATCH /tier) so the audit
  // row is recorded and the realtime email + push fans out to every super
  // admin, mirroring the legacy SQL migration and the Stripe webhook path.
  const reMigrateMutation = useMutation({
    mutationFn: async ({ orgId, targetTier, reason, auditEntryId }: {
      orgId: number;
      targetTier: RecognisedTier;
      reason: string;
      // Task #1957 — when the dialog was opened from a row in the
      // Plan Migration Audit panel, also acknowledge that source row
      // after the re-run lands so the panel queue stays clean
      // (mirrors restoreMigrationMutation's behaviour).
      auditEntryId?: number | null;
    }) => {
      const r = await fetch(`/api/super-admin/clubs/${orgId}/re-migrate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetTier, reason: reason.trim() || undefined }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Failed to re-run plan migration');

      // Task #1957 — acknowledge the source audit row after the re-run.
      // The migrate already succeeded by this point and a fresh "manual"
      // audit row was written, so this just clears the row that prompted
      // the re-run from the unacknowledged queue. We surface a typed
      // error if the ack fails so onError can still refresh the audit
      // caches even though the migrate landed.
      if (auditEntryId != null) {
        const ackRes = await fetch(`/api/super-admin/plan-migration-audit/${auditEntryId}/acknowledge`, {
          method: 'POST',
        });
        if (!ackRes.ok) {
          const ackData = await ackRes.json().catch(() => ({} as { error?: string }));
          const err = new Error(
            ackData?.error
              || 'Migration re-run, but failed to mark the source audit row reviewed',
          ) as Error & { migrateApplied?: boolean; migrateResult?: typeof d };
          err.migrateApplied = true;
          err.migrateResult = d;
          throw err;
        }
      }

      return d as {
        ok: true;
        organizationId: number;
        fromTier: string | null;
        toTier: string;
        auditRecorded: boolean;
        recipientsAttempted: number;
        recipientsEmailed: number;
        pushAttempted: number;
        pushSent: number;
      };
    },
    onSuccess: (d) => {
      // Reflect the new tier in the open detail modal immediately so the
      // tier badge updates without a full refetch round-trip.
      setSelectedClub(prev => (prev && prev.id === d.organizationId ? { ...prev, subscriptionTier: d.toTier } : prev));
      // Refresh both the audit panel (new "migrate" row) and the org's
      // tier badge / dashboard counts so every surface stays in sync.
      queryClient.invalidateQueries({ queryKey: ['/api/super-admin/plan-migration-audit'] });
      // Task #1930 — a re-migrate creates a fresh unack'd audit row. It
      // won't enter the stale bucket for 24h, but invalidating the badge
      // query keeps the cache honest if the previous fetch happened to be
      // mid-flight when a stale row was just acknowledged elsewhere.
      queryClient.invalidateQueries({ queryKey: ['/api/super-admin/plan-migration-audit/stale-summary'] });
      queryClient.invalidateQueries({ queryKey: ['/api/super-admin/clubs'] });
      queryClient.invalidateQueries({ queryKey: ['/api/super-admin/dashboard'] });
      setShowReMigrate(false);
      setReMigrateContext(null);
      setReMigrateReason('');
      const fanout = d.recipientsEmailed > 0 || d.pushSent > 0
        ? ` Notified ${d.recipientsEmailed} super admin${d.recipientsEmailed === 1 ? '' : 's'} by email${d.pushSent > 0 ? ` and ${d.pushSent} by push` : ''}.`
        : '';
      toast({
        title: 'Plan migration re-run',
        description: `Tier set to ${d.toTier}${d.fromTier ? ` (was ${d.fromTier})` : ''}.${fanout}`,
      });
    },
    onError: (err: Error & { migrateApplied?: boolean; migrateResult?: { organizationId: number; toTier: string } }) => {
      // Task #1957 — if the re-migrate succeeded but the follow-up ack
      // failed, the new "manual" audit row + tier change still landed on
      // the server. Refresh the same caches the success path would so the
      // UI doesn't show stale tier/audit data, then surface a warning so
      // the operator knows to manually acknowledge the source row.
      if (err.migrateApplied) {
        if (err.migrateResult) {
          setSelectedClub(prev => (
            prev && err.migrateResult && prev.id === err.migrateResult.organizationId
              ? { ...prev, subscriptionTier: err.migrateResult.toTier }
              : prev
          ));
        }
        queryClient.invalidateQueries({ queryKey: ['/api/super-admin/plan-migration-audit'] });
        queryClient.invalidateQueries({ queryKey: ['/api/super-admin/plan-migration-audit/stale-summary'] });
        queryClient.invalidateQueries({ queryKey: ['/api/super-admin/clubs'] });
        queryClient.invalidateQueries({ queryKey: ['/api/super-admin/dashboard'] });
      }
      toast({ title: 'Error', description: err.message, variant: 'destructive' });
    },
  });

  const { data: overrideData, isLoading: overrideLoading } = useQuery<{ override: OrgOverride | null; tierDefaults: PlanConfig | null }>({
    queryKey: ['/api/super-admin/clubs', selectedClub?.id, 'overrides'],
    queryFn: () => fetch(`/api/super-admin/clubs/${selectedClub!.id}/overrides`).then(r => r.json()),
    enabled: !!selectedClub && showOverrides,
    staleTime: 10000,
  });

  const suspendMutation = useMutation({
    mutationFn: ({ orgId, suspend }: { orgId: number; suspend: boolean }) =>
      fetch(`/api/super-admin/clubs/${orgId}/suspend`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ suspend }),
      }).then(r => r.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/super-admin/clubs'] });
      queryClient.invalidateQueries({ queryKey: ['/api/super-admin/dashboard'] });
      setSelectedClub(null);
      toast({ title: 'Club updated', description: 'Status changed successfully.' });
    },
  });

  const changeTierMutation = useMutation({
    mutationFn: ({ orgId, tier }: { orgId: number; tier: string }) =>
      fetch(`/api/super-admin/clubs/${orgId}/tier`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscriptionTier: tier }),
      }).then(r => r.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/super-admin/clubs'] });
      queryClient.invalidateQueries({ queryKey: ['/api/super-admin/dashboard'] });
      setShowTierChange(false);
      setSelectedClub(null);
      toast({ title: 'Tier updated', description: 'Subscription tier changed successfully.' });
    },
  });

  const savePlanMutation = useMutation({
    mutationFn: ({ tier, data }: { tier: string; data: Partial<PlanConfig> }) =>
      fetch(`/api/super-admin/plans/${tier}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      }).then(async r => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || 'Failed');
        return d;
      }),
    onSuccess: (_, { tier }) => {
      queryClient.invalidateQueries({ queryKey: ['/api/super-admin/plans'] });
      setPlanDrafts(p => { const n = { ...p }; delete n[tier]; return n; });
      toast({ title: 'Plan saved', description: `${tier} plan updated successfully.` });
    },
    onError: (err: Error) => {
      toast({ title: 'Error', description: err.message, variant: 'destructive' });
    },
  });

  const saveOverrideMutation = useMutation({
    mutationFn: ({ orgId, data }: { orgId: number; data: Record<string, unknown> }) =>
      fetch(`/api/super-admin/clubs/${orgId}/overrides`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      }).then(async r => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || 'Failed');
        return d;
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/super-admin/clubs', selectedClub?.id, 'overrides'] });
      toast({ title: 'Overrides saved', description: 'Club overrides updated.' });
    },
    onError: (err: Error) => {
      toast({ title: 'Error', description: err.message, variant: 'destructive' });
    },
  });

  const clearOverrideMutation = useMutation({
    mutationFn: (orgId: number) =>
      fetch(`/api/super-admin/clubs/${orgId}/overrides`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clearAll: true }),
      }).then(r => r.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/super-admin/clubs', selectedClub?.id, 'overrides'] });
      setOverrideForm({});
      toast({ title: 'Overrides cleared', description: 'All custom overrides have been removed.' });
    },
  });

  const createClubMutation = useMutation({
    mutationFn: (body: typeof createForm) =>
      fetch('/api/super-admin/clubs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }).then(async r => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || 'Failed');
        return d;
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/super-admin/clubs'] });
      queryClient.invalidateQueries({ queryKey: ['/api/super-admin/dashboard'] });
      setView('clubs');
      setCreateForm({ name: '', slug: '', description: '', contactEmail: '', subscriptionTier: 'free' });
      toast({ title: 'Club created', description: 'New club has been created successfully.' });
    },
    onError: (err: Error) => {
      toast({ title: 'Error', description: err.message, variant: 'destructive' });
    },
  });

  const StatCard = ({ icon, label, value, sub }: { icon: React.ReactNode; label: string; value: string | number; sub?: string }) => (
    <div className="bg-card border border-border rounded-xl p-5">
      <div className="flex items-center gap-3 mb-3">
        <div className="p-2 bg-primary/10 rounded-lg text-primary">{icon}</div>
        <span className="text-sm text-muted-foreground">{label}</span>
      </div>
      <div className="text-2xl font-bold text-white">{value}</div>
      {sub && <p className="text-xs text-muted-foreground mt-1">{sub}</p>}
    </div>
  );

  const getPlanDraftValue = (tier: string, key: string, original: PlanConfig) => {
    const draft = planDrafts[tier];
    if (draft && key in draft) return (draft as Record<string, unknown>)[key];
    return (original as Record<string, unknown>)[key];
  };

  const updatePlanDraft = (tier: string, key: string, value: unknown) => {
    setPlanDrafts(p => ({ ...p, [tier]: { ...p[tier], [key]: value } }));
  };

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Crown className="w-5 h-5 text-purple-400" />
            <h1 className="text-xl font-bold text-white">Super Admin</h1>
          </div>
          <p className="text-sm text-muted-foreground">Platform-wide management and oversight</p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <Button variant={view === 'dashboard' ? 'default' : 'outline'} size="sm" onClick={() => setView('dashboard')}>
            <BarChart3 className="w-4 h-4 mr-1.5" />Dashboard
          </Button>
          <Button variant={view === 'clubs' ? 'default' : 'outline'} size="sm" onClick={() => setView('clubs')}>
            <Building2 className="w-4 h-4 mr-1.5" />Clubs
          </Button>
          <Button variant={view === 'plans' ? 'default' : 'outline'} size="sm" onClick={() => setView('plans')}>
            <Settings className="w-4 h-4 mr-1.5" />Plans
          </Button>
          <Button
            variant={view === 'plan-migrations' ? 'default' : 'outline'}
            size="sm"
            onClick={() => setView('plan-migrations')}
            className="relative"
            data-testid="button-nav-plan-migrations"
          >
            <History className="w-4 h-4 mr-1.5" />Plan Migrations
            {/* Task #1930 — stale-row badge. Only renders when there are
                unacknowledged rows >=24h old (amber/red bucket). The number
                is capped at 99+ so the pill never blows out the button width
                on backlogs. `aria-label` reads the full count for screen
                readers because the visible "99+" is approximate. */}
            {planMigrationStaleCount > 0 && (
              <span
                data-testid="badge-plan-migrations-stale"
                aria-label={`${planMigrationStaleCount} stale plan migration row${planMigrationStaleCount === 1 ? '' : 's'}`}
                title={`${planMigrationStaleCount} unacknowledged plan migration row${planMigrationStaleCount === 1 ? '' : 's'} have been waiting at least 24 hours`}
                className="ml-1.5 inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1.5 rounded-full bg-red-500 text-white text-[10px] font-semibold leading-none"
              >
                {planMigrationStaleCount > 99 ? '99+' : planMigrationStaleCount}
              </span>
            )}
          </Button>
          <Button variant="outline" size="sm" onClick={() => navigate('/super-admin/manual-entry-alerts')} data-testid="button-nav-manual-entry-alerts">
            <BellRing className="w-4 h-4 mr-1.5" />Alert Health
          </Button>
          <Button variant="outline" size="sm" onClick={() => navigate('/super-admin/share-rollups')} data-testid="button-nav-share-rollups">
            <Share2 className="w-4 h-4 mr-1.5" />Share Rollups
          </Button>
          <Button variant="outline" size="sm" onClick={() => setView('create-club')}>
            <Plus className="w-4 h-4 mr-1.5" />New Club
          </Button>
        </div>
      </div>

      {/* Dashboard View */}
      {view === 'dashboard' && (
        <div className="space-y-6">
          {statsLoading ? (
            <div className="flex items-center justify-center py-20"><Loader2 className="w-6 h-6 animate-spin text-primary" /></div>
          ) : stats ? (
            <>
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                <StatCard icon={<Building2 className="w-5 h-5" />} label="Total Clubs" value={stats.totalClubs} sub={`${stats.activeClubs} active`} />
                <StatCard icon={<Users className="w-5 h-5" />} label="Total Users" value={stats.totalUsers.toLocaleString()} />
                <StatCard icon={<Trophy className="w-5 h-5" />} label="Tournaments" value={stats.totalTournaments.toLocaleString()} sub={`${stats.activeTournaments} active`} />
                <StatCard icon={<TrendingUp className="w-5 h-5" />} label="Est. MRR" value={`₹${stats.estimatedMrr.toLocaleString('en-IN')}`} sub="INR/month" />
              </div>
              <div className="bg-card border border-border rounded-xl p-5">
                <h2 className="text-sm font-semibold text-white mb-4">Clubs by Plan</h2>
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                  {['free', 'starter', 'pro', 'enterprise'].map(tier => (
                    <div key={tier} className={`p-4 rounded-xl border ${TIER_BADGE[tier]}`}>
                      <div className="flex items-center gap-2 mb-1">
                        {TIER_ICONS[tier]}
                        <span className="text-sm font-medium capitalize">{tier}</span>
                      </div>
                      <div className="text-2xl font-bold">{stats.tierBreakdown[tier] ?? 0}</div>
                      <div className="text-xs opacity-70">clubs</div>
                    </div>
                  ))}
                </div>
              </div>
              <div className="bg-card border border-border rounded-xl p-5">
                <h2 className="text-sm font-semibold text-white mb-4 flex items-center gap-2">
                  <Calendar className="w-4 h-4 text-primary" />Tee Bookings — This Month
                </h2>
                <div className="grid grid-cols-2 gap-4 mb-4">
                  <div className="bg-primary/10 border border-primary/20 rounded-xl p-4">
                    <p className="text-xs text-muted-foreground mb-1">Total Bookings</p>
                    <p className="text-2xl font-bold text-white">{(stats.bookingsThisMonth ?? 0).toLocaleString()}</p>
                  </div>
                  <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-xl p-4">
                    <p className="text-xs text-muted-foreground mb-1">Revenue</p>
                    <p className="text-2xl font-bold text-white">₹{(stats.bookingRevenueThisMonth ?? 0).toLocaleString('en-IN')}</p>
                  </div>
                </div>
                {stats.bookingsByClub && stats.bookingsByClub.length > 0 && (
                  <div className="space-y-2">
                    <p className="text-xs text-muted-foreground font-medium">Top Clubs by Bookings</p>
                    {stats.bookingsByClub.slice(0, 5).map(bc => (
                      <div key={bc.organizationId} className="flex items-center justify-between py-1 border-b border-border last:border-0">
                        <span className="text-sm text-white">{bc.orgName ?? `Org #${bc.organizationId}`}</span>
                        <div className="flex items-center gap-3">
                          {parseFloat(bc.revenue) > 0 && (
                            <span className="text-xs text-emerald-400 font-medium">₹{parseFloat(bc.revenue).toLocaleString('en-IN')}</span>
                          )}
                          <span className="text-sm font-semibold text-primary">{bc.count} booking{bc.count !== 1 ? "s" : ""}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Task #1962 — Legacy video duration backfill panel.
                  Surfaces the count of videos uploaded before the
                  duration-probe schema landed (durationSeconds IS NULL,
                  durationLastCheckedAt IS NULL) and offers a one-click
                  re-probe so the highlight editor's trim slider works
                  for those clips too. */}
              <div className="bg-card border border-border rounded-xl p-5" data-testid="panel-legacy-video-backfill">
                <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
                  <h2 className="text-sm font-semibold text-white flex items-center gap-2">
                    <Film className="w-4 h-4 text-primary" />Legacy videos — duration backfill
                  </h2>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => refetchLegacyVideoCount()}
                      disabled={legacyVideoCountFetching}
                      data-testid="button-refresh-legacy-video-count"
                    >
                      {legacyVideoCountFetching
                        ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
                        : <RefreshCw className="w-4 h-4 mr-1.5" />}
                      Refresh
                    </Button>
                    <Button
                      variant="default"
                      size="sm"
                      onClick={() => legacyVideoBackfillMutation.mutate()}
                      disabled={
                        legacyVideoBackfillMutation.isPending ||
                        legacyVideoCountLoading ||
                        (legacyVideoCountData?.count ?? 0) === 0
                      }
                      data-testid="button-run-legacy-video-backfill"
                      title={
                        (legacyVideoCountData?.count ?? 0) === 0
                          ? 'No legacy videos remain in the un-measured queue.'
                          : `Re-probe up to ${legacyVideoCountData?.batchSize ?? 50} legacy video${(legacyVideoCountData?.batchSize ?? 50) === 1 ? '' : 's'} now.`
                      }
                    >
                      {legacyVideoBackfillMutation.isPending
                        ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
                        : <Film className="w-4 h-4 mr-1.5" />}
                      Re-probe legacy videos
                    </Button>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground mb-3">
                  Videos uploaded before the duration-probe schema landed silently lose the highlight
                  editor's trim slider until they're re-measured. Clicking the button picks up to{' '}
                  {legacyVideoCountData?.batchSize ?? 50} rows, runs ffprobe, and writes the duration so
                  the trim window works again. Failures are stamped so the same row isn't tried twice.
                </p>
                {legacyVideoCountLoading ? (
                  <div className="flex justify-center py-4"><Loader2 className="w-5 h-5 animate-spin text-primary" /></div>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div className="bg-primary/10 border border-primary/20 rounded-xl p-4">
                      <p className="text-xs text-muted-foreground mb-1">Legacy videos still un-measured</p>
                      <p
                        className="text-2xl font-bold text-white"
                        data-testid="text-legacy-video-unmeasured-count"
                      >
                        {(legacyVideoCountData?.count ?? 0).toLocaleString()}
                      </p>
                    </div>
                    {legacyVideoBackfillMutation.data && (
                      <div
                        className="bg-card border border-border rounded-xl p-4"
                        data-testid="panel-legacy-video-backfill-last-result"
                      >
                        <p className="text-xs text-muted-foreground mb-1">Last sweep</p>
                        <p className="text-sm text-white">
                          Tried <span className="font-semibold">{legacyVideoBackfillMutation.data.attempted}</span> ·{' '}
                          <span className="text-emerald-400 font-semibold">{legacyVideoBackfillMutation.data.recovered}</span> recovered ·{' '}
                          <span className="text-amber-400 font-semibold">{legacyVideoBackfillMutation.data.stillFailing}</span> still failing
                          {legacyVideoBackfillMutation.data.objectMissing > 0 && (
                            <> · <span className="text-red-400 font-semibold">{legacyVideoBackfillMutation.data.objectMissing}</span> object missing</>
                          )}
                        </p>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* AI Caddie prompt size panel */}
              <div className="bg-card border border-border rounded-xl p-5" data-testid="panel-caddie-prompt-metrics">
                <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
                  <h2 className="text-sm font-semibold text-white flex items-center gap-2">
                    <Bot className="w-4 h-4 text-primary" />AI Caddie prompt size
                    {caddieMetrics && (
                      <span className="text-xs text-muted-foreground font-normal">
                        ({caddieMetrics.total} sample{caddieMetrics.total === 1 ? '' : 's'} in window)
                      </span>
                    )}
                  </h2>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => refetchCaddieMetrics()}
                    disabled={caddieMetricsFetching}
                    data-testid="button-refresh-caddie-metrics"
                  >
                    {caddieMetricsFetching
                      ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
                      : <RefreshCw className="w-4 h-4 mr-1.5" />}
                    Refresh
                  </Button>
                </div>
                {caddieMetricsLoading ? (
                  <div className="flex justify-center py-8"><Loader2 className="w-5 h-5 animate-spin text-primary" /></div>
                ) : caddieMetricsError && !caddieMetrics ? (
                  <div
                    className="flex items-start gap-2 text-sm text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg p-3"
                    data-testid="text-caddie-metrics-error"
                  >
                    <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                    <span>Couldn’t load AI Caddie prompt metrics: {caddieMetricsError.message}</span>
                  </div>
                ) : !caddieMetrics
                    || caddieMetrics.total === 0
                    // Defensive: if the backend returns an unexpected
                    // shape (e.g. the windowed `{ windows: {...} }`
                    // payload that this card hasn't been updated to
                    // consume yet), the renderer below would crash on
                    // `undefined.toLocaleString()` and take the entire
                    // super-admin page down. Treat any missing
                    // expected aggregate as "no data" so the rest of
                    // the page (Ops Alert card, etc.) stays usable.
                    || typeof caddieMetrics.avgEstimatedInputTokens !== 'number' ? (
                  <p className="text-sm text-muted-foreground py-6 text-center">No AI Caddie prompts have been recorded yet.</p>
                ) : (
                  <>
                    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
                      <div className="bg-primary/10 border border-primary/20 rounded-xl p-3">
                        <p className="text-xs text-muted-foreground mb-1">Avg input tokens</p>
                        <p className="text-xl font-bold text-white" data-testid="text-caddie-avg-tokens">
                          {caddieMetrics.avgEstimatedInputTokens.toLocaleString()}
                        </p>
                      </div>
                      <div className="bg-card border border-border rounded-xl p-3">
                        <p className="text-xs text-muted-foreground mb-1">p50 / p95</p>
                        <p className="text-xl font-bold text-white" data-testid="text-caddie-percentiles">
                          {caddieMetrics.p50EstimatedInputTokens.toLocaleString()}
                          <span className="text-muted-foreground text-base"> / </span>
                          {caddieMetrics.p95EstimatedInputTokens.toLocaleString()}
                        </p>
                      </div>
                      <div className="bg-card border border-border rounded-xl p-3">
                        <p className="text-xs text-muted-foreground mb-1">Max tokens</p>
                        <p className="text-xl font-bold text-white" data-testid="text-caddie-max-tokens">
                          {caddieMetrics.maxEstimatedInputTokens.toLocaleString()}
                        </p>
                      </div>
                      <div className="bg-card border border-border rounded-xl p-3">
                        <p className="text-xs text-muted-foreground mb-1">Avg shots / rounds</p>
                        <p className="text-xl font-bold text-white" data-testid="text-caddie-avg-context">
                          {caddieMetrics.avgTotalTrackedShots.toLocaleString()}
                          <span className="text-muted-foreground text-base"> / </span>
                          {caddieMetrics.avgRoundCount}
                        </p>
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-3 mb-4">
                      <div className="bg-blue-500/10 border border-blue-500/20 rounded-xl p-3">
                        <p className="text-xs text-muted-foreground mb-1">Shots-context calls</p>
                        <p className="text-lg font-semibold text-white" data-testid="text-caddie-mode-shots">
                          {caddieMetrics.byMode.shots.toLocaleString()}
                          <span className="text-xs text-muted-foreground ml-2">
                            ({caddieMetrics.total > 0 ? Math.round((caddieMetrics.byMode.shots / caddieMetrics.total) * 100) : 0}%)
                          </span>
                        </p>
                      </div>
                      <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-xl p-3">
                        <p className="text-xs text-muted-foreground mb-1">Rounds-context calls</p>
                        <p className="text-lg font-semibold text-white" data-testid="text-caddie-mode-rounds">
                          {caddieMetrics.byMode.rounds.toLocaleString()}
                          <span className="text-xs text-muted-foreground ml-2">
                            ({caddieMetrics.total > 0 ? Math.round((caddieMetrics.byMode.rounds / caddieMetrics.total) * 100) : 0}%)
                          </span>
                        </p>
                      </div>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground font-medium mb-2">Recent samples</p>
                      <div className="overflow-x-auto">
                        <table className="w-full text-xs" data-testid="table-caddie-recent">
                          <thead>
                            <tr className="text-left text-muted-foreground border-b border-border">
                              <th className="py-1.5 pr-3 font-medium">Time</th>
                              <th className="py-1.5 pr-3 font-medium">User</th>
                              <th className="py-1.5 pr-3 font-medium">Mode</th>
                              <th className="py-1.5 pr-3 font-medium text-right">Tokens</th>
                              <th className="py-1.5 pr-3 font-medium text-right">Shots</th>
                              <th className="py-1.5 pr-3 font-medium text-right">Rounds</th>
                              <th className="py-1.5 font-medium text-right">Lines</th>
                            </tr>
                          </thead>
                          <tbody>
                            {caddieMetrics.recent.map((m, i) => (
                              <tr key={`${m.ts}-${m.userId}-${i}`} className="border-b border-border/50 last:border-0">
                                <td className="py-1.5 pr-3 text-white whitespace-nowrap">{new Date(m.ts).toLocaleTimeString()}</td>
                                <td className="py-1.5 pr-3 text-white">#{m.userId}</td>
                                <td className="py-1.5 pr-3">
                                  <Badge variant="outline" className={m.contextMode === 'shots' ? 'text-blue-400 border-blue-500/30' : 'text-emerald-400 border-emerald-500/30'}>
                                    {m.contextMode}
                                  </Badge>
                                </td>
                                <td className="py-1.5 pr-3 text-white text-right font-mono">{m.estimatedInputTokens.toLocaleString()}</td>
                                <td className="py-1.5 pr-3 text-muted-foreground text-right">{m.totalTrackedShots}</td>
                                <td className="py-1.5 pr-3 text-muted-foreground text-right">{m.roundCount}</td>
                                <td className="py-1.5 text-muted-foreground text-right">{m.shotLineCount}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                    {caddieMetrics.windowStart && caddieMetrics.windowEnd && (
                      <p className="text-xs text-muted-foreground mt-3">
                        Window: {new Date(caddieMetrics.windowStart).toLocaleString()} → {new Date(caddieMetrics.windowEnd).toLocaleString()}
                      </p>
                    )}
                  </>
                )}
              </div>

              {/* Watch GPS position-rate panel (Task #877) */}
              <div className="bg-card border border-border rounded-xl p-5" data-testid="panel-watch-position-metrics">
                <div className="flex items-center justify-between mb-1 flex-wrap gap-2">
                  <h2 className="text-sm font-semibold text-white flex items-center gap-2">
                    <Watch className="w-4 h-4 text-primary" />Watch GPS position rate
                    {watchMetrics && (
                      <span className="text-xs text-muted-foreground font-normal">
                        ({watchMetrics.windows[watchWindow].bucketCount} session-min{watchMetrics.windows[watchWindow].bucketCount === 1 ? '' : 's'} in last {watchWindow})
                      </span>
                    )}
                  </h2>
                  <div className="flex items-center gap-2">
                    <div className="inline-flex items-center rounded-lg border border-border bg-card p-0.5" role="tablist" aria-label="Window">
                      {(['24h', '7d', '30d'] as const).map((w) => (
                        <button
                          key={w}
                          type="button"
                          role="tab"
                          aria-selected={watchWindow === w}
                          onClick={() => setWatchWindow(w)}
                          className={`text-xs px-2.5 py-1 rounded-md transition-colors ${
                            watchWindow === w
                              ? 'bg-primary/20 text-primary'
                              : 'text-muted-foreground hover:text-white'
                          }`}
                          data-testid={`button-watch-window-${w}`}
                        >
                          {w}
                        </button>
                      ))}
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => refetchWatchMetrics()}
                      disabled={watchMetricsFetching}
                      data-testid="button-refresh-watch-metrics"
                    >
                      {watchMetricsFetching
                        ? <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
                        : <RefreshCw className="w-4 h-4 mr-1.5" />}
                      Refresh
                    </Button>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground mb-3">
                  Position messages received per active watch session per minute.
                  Use to confirm the volume drop from the watch debounce, and to spot regressions.
                </p>
                {/* Task #1653 — ops alert wiring status + test page button. Shows
                    which chat channels are configured so a missing env var is
                    visible BEFORE the next spike, and lets ops fire a test
                    page through the same Slack/PagerDuty senders the real
                    alert uses. */}
                {/*
                  Task #2057 — moved to the shared `OpsAlertWiringPanel`.
                  Test-id naming is preserved (`panel-watch-ops-alert-wiring`,
                  `status-watch-ops-alert-{slack,pagerduty,none}`,
                  `button-watch-ops-alert-test-page`) via the
                  `testIdPrefix='watch-ops-alert'` prop, so existing
                  E2E selectors keep working.
                */}
                <OpsAlertWiringPanel
                  chatTargets={watchMetrics?.chatTargets}
                  label="Spike alert"
                  slackEnvVar="OPS_WATCH_GPS_ALERT_SLACK_WEBHOOK"
                  pagerDutyEnvVar="OPS_WATCH_GPS_ALERT_PAGERDUTY_ROUTING_KEY"
                  isSending={sendOpsAlertTestPage.isPending}
                  onSendTestPage={() => sendOpsAlertTestPage.mutate()}
                  testIdPrefix="watch-ops-alert"
                />
                {/* Task #2056 — surface the most recent test-page click and a
                    small 30-day frequency chart so leadership can prove the
                    paging wiring is exercised regularly during incident
                    reviews, and ops can spot a long quiet stretch at a
                    glance. The history endpoint returns a dense series
                    (one entry per UTC day, zero-filled) so the chart has
                    an even X axis with no client-side gap-filling. */}
                {opsAlertTestPageHistory && (
                  <div
                    className="mb-4 rounded-lg border border-border bg-card/40 px-3 py-2 text-xs"
                    data-testid="panel-watch-ops-alert-test-page-history"
                  >
                    <div className="flex items-center justify-between gap-3 flex-wrap">
                      <div className="flex items-center gap-2 text-muted-foreground">
                        <Clock className="w-3.5 h-3.5" />
                        {opsAlertTestPageHistory.last ? (
                          <span data-testid="text-watch-ops-alert-test-page-last">
                            Last test page:{' '}
                            <span className="text-foreground font-medium">
                              {formatRelativeTime(opsAlertTestPageHistory.last.firedAt)}
                            </span>
                            {opsAlertTestPageHistory.last.actorName && (
                              <>
                                {' '}by{' '}
                                <span className="text-foreground font-medium">
                                  {opsAlertTestPageHistory.last.actorName}
                                </span>
                              </>
                            )}
                            {(() => {
                              const parts: string[] = [];
                              const s = opsAlertTestPageHistory.last.slack;
                              const p = opsAlertTestPageHistory.last.pagerDuty;
                              if (s.attempted) parts.push(`Slack ${s.ok ? '✓' : '✗'}`);
                              if (p.attempted) parts.push(`PagerDuty ${p.ok ? '✓' : '✗'}`);
                              if (!parts.length) return null;
                              return <span className="ml-1 text-muted-foreground">({parts.join(' · ')})</span>;
                            })()}
                          </span>
                        ) : (
                          <span data-testid="text-watch-ops-alert-test-page-empty">
                            No test pages have been fired yet — click "Send test page" above to verify wiring.
                          </span>
                        )}
                      </div>
                      <span className="text-muted-foreground">
                        <span
                          className="text-foreground font-semibold"
                          data-testid="text-watch-ops-alert-test-page-30d-count"
                        >
                          {opsAlertTestPageHistory.totalLast30Days}
                        </span>
                        {' '}in last 30 days
                      </span>
                    </div>
                    {opsAlertTestPageHistory.dailySeries.length > 0 && (
                      <div
                        className="mt-2 -mx-1"
                        data-testid="chart-watch-ops-alert-test-page-history"
                      >
                        <ResponsiveContainer width="100%" height={60}>
                          <BarChart
                            data={opsAlertTestPageHistory.dailySeries}
                            margin={{ top: 4, right: 4, left: 4, bottom: 0 }}
                          >
                            <XAxis
                              dataKey="date"
                              tick={{ fontSize: 9, fill: '#94a3b8' }}
                              stroke="rgba(148,163,184,0.3)"
                              minTickGap={40}
                              tickFormatter={(d: string) => {
                                const dt = new Date(`${d}T00:00:00Z`);
                                return Number.isFinite(dt.getTime())
                                  ? dt.toLocaleDateString([], { month: 'short', day: 'numeric' })
                                  : d;
                              }}
                            />
                            <YAxis
                              hide
                              allowDecimals={false}
                              domain={[0, (max: number) => Math.max(1, max)]}
                            />
                            <Tooltip
                              cursor={{ fill: 'rgba(148,163,184,0.1)' }}
                              contentStyle={{
                                background: '#0f172a',
                                border: '1px solid rgba(148,163,184,0.3)',
                                borderRadius: 6,
                                fontSize: 11,
                              }}
                              labelFormatter={(d: string) => {
                                const dt = new Date(`${d}T00:00:00Z`);
                                return Number.isFinite(dt.getTime())
                                  ? dt.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })
                                  : d;
                              }}
                              formatter={(value: number) => [`${value}`, 'Test pages']}
                            />
                            <Bar dataKey="count" fill="#a78bfa" radius={[2, 2, 0, 0]} />
                          </BarChart>
                        </ResponsiveContainer>
                      </div>
                    )}
                  </div>
                )}
                {watchMetricsLoading ? (
                  <div className="flex justify-center py-8"><Loader2 className="w-5 h-5 animate-spin text-primary" /></div>
                ) : watchMetricsError && !watchMetrics ? (
                  <div
                    className="flex items-start gap-2 text-sm text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg p-3"
                    data-testid="text-watch-metrics-error"
                  >
                    <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                    <span>Couldn’t load watch GPS metrics: {watchMetricsError.message}</span>
                  </div>
                ) : !watchMetrics || watchMetrics.windows[watchWindow].bucketCount === 0 ? (
                  <p className="text-sm text-muted-foreground py-6 text-center" data-testid="text-watch-empty">
                    No watch GPS messages have been recorded in the last {watchWindow}.
                  </p>
                ) : (
                  <>
                    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
                      <div className="bg-primary/10 border border-primary/20 rounded-xl p-3">
                        <p className="text-xs text-muted-foreground mb-1">Avg msgs / session-min</p>
                        <p className="text-xl font-bold text-white" data-testid="text-watch-avg-rate">
                          {watchMetrics.windows[watchWindow].avgMessagesPerSessionMinute.toLocaleString()}
                        </p>
                      </div>
                      <div className="bg-card border border-border rounded-xl p-3">
                        <p className="text-xs text-muted-foreground mb-1">p50 / p95</p>
                        <p className="text-xl font-bold text-white" data-testid="text-watch-percentiles">
                          {watchMetrics.windows[watchWindow].p50MessagesPerSessionMinute.toLocaleString()}
                          <span className="text-muted-foreground text-base"> / </span>
                          {watchMetrics.windows[watchWindow].p95MessagesPerSessionMinute.toLocaleString()}
                        </p>
                      </div>
                      <div className="bg-card border border-border rounded-xl p-3">
                        <p className="text-xs text-muted-foreground mb-1">Max in any minute</p>
                        <p className="text-xl font-bold text-white" data-testid="text-watch-max-rate">
                          {watchMetrics.windows[watchWindow].maxMessagesPerSessionMinute.toLocaleString()}
                        </p>
                      </div>
                      <div className="bg-card border border-border rounded-xl p-3">
                        <p className="text-xs text-muted-foreground mb-1">Active sessions ({watchWindow})</p>
                        <p className="text-xl font-bold text-white" data-testid="text-watch-sessions">
                          {watchMetrics.windows[watchWindow].activeSessionCount.toLocaleString()}
                        </p>
                      </div>
                    </div>
                    <div className="bg-card border border-border rounded-xl p-3 mb-4" data-testid="chart-watch-position-rate">
                      {(() => {
                        const series = watchMetrics.seriesByWindow[watchWindow];
                        const bucketSec = watchMetrics.seriesBucketSeconds[watchWindow];
                        const bucketLabel = bucketSec === 60
                          ? 'minute'
                          : bucketSec === 3600
                            ? 'hour'
                            : `${Math.round(bucketSec / 3600)}h`;
                        if (series.length === 0) {
                          return (
                            <p className="text-xs text-muted-foreground py-6 text-center">
                              No data points to plot in this window.
                            </p>
                          );
                        }
                        const data = series.map((p) => ({
                          t: new Date(p.bucket).getTime(),
                          avg: p.avg,
                          p95: p.p95,
                          batteryAvg: p.batteryAvg,
                          normalAvg: p.normalAvg,
                          batterySamples: p.batterySampleCount,
                          normalSamples: p.normalSampleCount,
                        }));
                        const fmtTick = (ms: number) => {
                          const d = new Date(ms);
                          if (watchWindow === '24h') {
                            return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                          }
                          return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
                        };
                        return (
                          <>
                            <div className="flex items-center justify-between mb-2">
                              <p className="text-xs text-muted-foreground font-medium">
                                Messages per session-{bucketLabel}
                              </p>
                              <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
                                <span className="flex items-center gap-1">
                                  <span className="inline-block w-2.5 h-0.5 bg-blue-400" />normal
                                </span>
                                <span className="flex items-center gap-1">
                                  <span className="inline-block w-2.5 h-0.5 bg-amber-400" />battery
                                </span>
                                <span className="flex items-center gap-1">
                                  <span className="inline-block w-2.5 h-0.5 bg-primary opacity-70 border-dashed" style={{ borderTop: '1px dashed currentColor' }} />p95
                                </span>
                              </div>
                            </div>
                            <ResponsiveContainer width="100%" height={180}>
                              <LineChart
                                data={data}
                                margin={{ top: 4, right: 8, left: -16, bottom: 0 }}
                                onClick={(state: { activeLabel?: number | string } | null) => {
                                  // Recharts fires this with the X-axis value (epoch ms) for the
                                  // nearest data point. Open the drill-down dialog for that bucket.
                                  const raw = state?.activeLabel;
                                  const ms = typeof raw === 'number' ? raw : raw != null ? Number(raw) : NaN;
                                  if (Number.isFinite(ms)) setWatchDrillBucketMs(ms);
                                }}
                                style={{ cursor: 'pointer' }}
                              >
                                <CartesianGrid strokeDasharray="3 3" stroke="rgba(148,163,184,0.15)" />
                                <XAxis
                                  dataKey="t"
                                  type="number"
                                  domain={["dataMin", "dataMax"]}
                                  scale="time"
                                  tickFormatter={fmtTick}
                                  tick={{ fontSize: 10, fill: '#94a3b8' }}
                                  stroke="rgba(148,163,184,0.3)"
                                  minTickGap={32}
                                />
                                <YAxis
                                  tick={{ fontSize: 10, fill: '#94a3b8' }}
                                  stroke="rgba(148,163,184,0.3)"
                                  width={40}
                                />
                                <Tooltip
                                  contentStyle={{ background: '#0f172a', border: '1px solid #1e293b', borderRadius: 8, fontSize: 12 }}
                                  labelFormatter={(ms) => new Date(ms as number).toLocaleString()}
                                  formatter={(value, name) => {
                                    const nameStr = String(name ?? '');
                                    if (value == null) return ['—', nameStr];
                                    return [Number(value).toLocaleString(), nameStr];
                                  }}
                                />
                                <Legend wrapperStyle={{ display: 'none' }} />
                                <Line type="monotone" dataKey="normalAvg" name="normal avg" stroke="#60a5fa" strokeWidth={2} dot={false} connectNulls isAnimationActive={false} />
                                <Line type="monotone" dataKey="batteryAvg" name="battery avg" stroke="#fbbf24" strokeWidth={2} dot={false} connectNulls isAnimationActive={false} />
                                <Line type="monotone" dataKey="p95" name="p95 (overall)" stroke="#a78bfa" strokeWidth={1.5} strokeDasharray="4 3" dot={false} isAnimationActive={false} />
                              </LineChart>
                            </ResponsiveContainer>
                            <p className="text-[10px] text-muted-foreground mt-1.5 flex items-center gap-1">
                              <MousePointerClick className="w-3 h-3" />
                              Click a point to see the top sessions in that bucket.
                            </p>
                          </>
                        );
                      })()}
                    </div>
                    <div className="grid grid-cols-3 gap-3 mb-4">
                      {(['24h', '7d', '30d'] as const).map((win) => (
                        <div
                          key={win}
                          className={`rounded-xl p-3 border ${
                            watchWindow === win
                              ? 'bg-primary/10 border-primary/30'
                              : 'bg-card border-border'
                          }`}
                        >
                          <p className="text-xs text-muted-foreground mb-1">Total messages ({win})</p>
                          <p className="text-lg font-semibold text-white" data-testid={`text-watch-total-${win}`}>
                            {watchMetrics.windows[win].totalMessages.toLocaleString()}
                            <span className="text-xs text-muted-foreground ml-2">
                              avg {watchMetrics.windows[win].avgMessagesPerSessionMinute.toLocaleString()}/min
                            </span>
                          </p>
                        </div>
                      ))}
                    </div>
                    {/* Active mutes panel (Task #1678). Lists every watch
                        session currently muted across the api-server fleet
                        (Task #2090 — reads from the persisted store, so the
                        same answer comes back regardless of which replica
                        handled the request), with an "Unmute" button that
                        lifts the mute early via DELETE. Lifting from one
                        replica propagates to the rest within a few seconds
                        via the periodic mute-resync. */}
                    <div className="mb-4" data-testid="panel-watch-active-mutes">
                      <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
                        <p className="text-xs text-muted-foreground font-medium flex items-center gap-2">
                          <Ban className="w-3.5 h-3.5 text-amber-400" />
                          Active mutes
                          {mutedSessionsData && (
                            <span className="text-muted-foreground font-normal">
                              ({liveMutedSessions.length} across all servers)
                            </span>
                          )}
                          {mutedSessionsFetching && (
                            <Loader2 className="w-3 h-3 animate-spin text-muted-foreground" />
                          )}
                        </p>
                      </div>
                      {mutedSessionsLoading ? (
                        <div className="flex justify-center py-4">
                          <Loader2 className="w-4 h-4 animate-spin text-primary" />
                        </div>
                      ) : mutedSessionsError ? (
                        <div
                          className="flex items-start gap-2 text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg p-2.5"
                          data-testid="text-watch-muted-sessions-error"
                        >
                          <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                          <span>Couldn’t load active mutes: {mutedSessionsError.message}</span>
                        </div>
                      ) : !mutedSessionsData || liveMutedSessions.length === 0 ? (
                        <p
                          className="text-xs text-muted-foreground py-3 text-center bg-card/40 border border-dashed border-border rounded-lg"
                          data-testid="text-watch-muted-sessions-empty"
                        >
                          No watch sessions are currently muted.
                        </p>
                      ) : (
                        <div className="overflow-x-auto">
                          <table className="w-full text-xs" data-testid="table-watch-muted-sessions">
                            <thead>
                              <tr className="text-left text-muted-foreground border-b border-border">
                                <th className="py-1.5 pr-3 font-medium">Session</th>
                                <th className="py-1.5 pr-3 font-medium">User</th>
                                <th className="py-1.5 pr-3 font-medium">Tournament</th>
                                <th className="py-1.5 pr-3 font-medium">Muted by</th>
                                <th className="py-1.5 pr-3 font-medium">Expires</th>
                                <th className="py-1.5 font-medium text-right">Action</th>
                              </tr>
                            </thead>
                            <tbody>
                              {liveMutedSessions.map((m) => {
                                const remainingMin = Math.max(0, Math.round(m.remainingMs / 60_000));
                                const remainingSec = Math.max(0, Math.round(m.remainingMs / 1000));
                                const remainingLabel = remainingMin >= 1
                                  ? `${remainingMin}m`
                                  : `${remainingSec}s`;
                                return (
                                  <tr
                                    key={m.sessionId}
                                    className="border-b border-border/50 last:border-0"
                                    data-testid={`row-watch-muted-session-${m.sessionId}`}
                                  >
                                    <td className="py-1.5 pr-3 text-white font-mono text-[11px]" title={m.sessionId}>
                                      {m.sessionId.length > 16 ? `${m.sessionId.slice(0, 16)}…` : m.sessionId}
                                    </td>
                                    <td className="py-1.5 pr-3">
                                      {m.userId == null ? (
                                        <span className="text-muted-foreground">—</span>
                                      ) : (
                                        <button
                                          type="button"
                                          className="text-primary hover:underline"
                                          onClick={() => navigate(`/member-360/${m.userId}`)}
                                          data-testid={`link-watch-muted-user-${m.userId}`}
                                        >
                                          #{m.userId}
                                        </button>
                                      )}
                                    </td>
                                    <td className="py-1.5 pr-3 text-muted-foreground">
                                      {m.tournamentId == null ? (
                                        '—'
                                      ) : (
                                        <button
                                          type="button"
                                          className="text-primary hover:underline"
                                          onClick={() => navigate(`/tournaments/${m.tournamentId}`)}
                                          data-testid={`link-watch-muted-tournament-${m.tournamentId}`}
                                        >
                                          #{m.tournamentId}
                                        </button>
                                      )}
                                    </td>
                                    <td className="py-1.5 pr-3 text-muted-foreground" title={m.mutedAt ?? undefined}>
                                      {m.mutedByName ?? (m.mutedByUserId != null ? `#${m.mutedByUserId}` : 'unknown')}
                                    </td>
                                    <td
                                      className="py-1.5 pr-3 text-amber-400 whitespace-nowrap"
                                      title={new Date(m.expiresAt).toLocaleString()}
                                    >
                                      <span className="inline-flex items-center gap-1">
                                        <Clock className="w-3 h-3" />
                                        {remainingLabel}
                                      </span>
                                    </td>
                                    <td className="py-1.5 text-right">
                                      <Button
                                        type="button"
                                        size="sm"
                                        variant="outline"
                                        className="h-7 text-xs text-emerald-400 border-emerald-500/30 hover:bg-emerald-500/10 hover:text-emerald-300"
                                        disabled={
                                          unmutingSessionId === m.sessionId ||
                                          unmuteWatchSessionMutation.isPending
                                        }
                                        onClick={() => {
                                          // Task #2092 — open the confirm
                                          // dialog instead of firing the
                                          // DELETE inline. Keeping the
                                          // draft tied to the row that's
                                          // currently being asked about,
                                          // so cancelling and re-opening
                                          // gives ops a fresh field.
                                          setPendingUnmuteSession(m);
                                          setUnmuteReasonDraft('');
                                        }}
                                        data-testid={`button-unmute-watch-session-${m.sessionId}`}
                                        title="Lift the mute early so this session can resume sending position messages"
                                      >
                                        {unmutingSessionId === m.sessionId ? (
                                          <Loader2 className="w-3 h-3 animate-spin" />
                                        ) : (
                                          <>
                                            <CheckCircle className="w-3 h-3 mr-1" />
                                            Unmute
                                          </>
                                        )}
                                      </Button>
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                    {/* Task #2092 — confirmation dialog for the Unmute
                        button. Lifting a mute can re-open a runaway
                        watch session that immediately floods position
                        data, so we force a deliberate confirm + offer a
                        free-text "why" that we forward into the audit
                        row's reason. Mounted once at the panel level so
                        it doesn't multiply when the mute list grows. */}
                    <AlertDialog
                      open={pendingUnmuteSession !== null}
                      onOpenChange={(open) => {
                        if (!open && !unmuteWatchSessionMutation.isPending) {
                          setPendingUnmuteSession(null);
                          setUnmuteReasonDraft('');
                        }
                      }}
                    >
                      <AlertDialogContent
                        className="bg-card border-border"
                        data-testid="dialog-confirm-unmute-watch-session"
                      >
                        <AlertDialogHeader>
                          <AlertDialogTitle className="text-white">
                            Lift this watch session mute?
                          </AlertDialogTitle>
                          <AlertDialogDescription className="text-muted-foreground">
                            {pendingUnmuteSession ? (
                              <>
                                This will let session{' '}
                                <span className="font-mono text-white" data-testid="text-unmute-confirm-session-id">
                                  {pendingUnmuteSession.sessionId.length > 24
                                    ? `${pendingUnmuteSession.sessionId.slice(0, 24)}…`
                                    : pendingUnmuteSession.sessionId}
                                </span>{' '}
                                resume sending position updates immediately,
                                even though the original mute was set to expire
                                automatically. Continue?
                              </>
                            ) : null}
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <div className="space-y-2">
                          <Label
                            htmlFor="input-unmute-reason"
                            className="text-xs text-muted-foreground"
                          >
                            Reason (optional, recorded in the audit log)
                          </Label>
                          <Textarea
                            id="input-unmute-reason"
                            value={unmuteReasonDraft}
                            onChange={(e) => setUnmuteReasonDraft(e.target.value.slice(0, UNMUTE_REASON_MAX_LENGTH))}
                            placeholder="e.g. False positive — high-cadence drill, safe to resume"
                            maxLength={UNMUTE_REASON_MAX_LENGTH}
                            rows={3}
                            disabled={unmuteWatchSessionMutation.isPending}
                            data-testid="input-unmute-reason"
                            className="text-sm bg-background"
                          />
                          <p className="text-[11px] text-muted-foreground text-right">
                            {unmuteReasonDraft.length}/{UNMUTE_REASON_MAX_LENGTH}
                          </p>
                        </div>
                        <AlertDialogFooter>
                          <AlertDialogCancel
                            disabled={unmuteWatchSessionMutation.isPending}
                            data-testid="button-cancel-unmute-watch-session"
                          >
                            Cancel
                          </AlertDialogCancel>
                          <AlertDialogAction
                            // Wire the action manually instead of letting
                            // the Radix default close the dialog: we want
                            // it to stay open if the DELETE fails so the
                            // operator can retry without re-typing the
                            // reason. The onSuccess handler closes it.
                            onClick={(e) => {
                              e.preventDefault();
                              if (!pendingUnmuteSession) return;
                              unmuteWatchSessionMutation.mutate({
                                sessionId: pendingUnmuteSession.sessionId,
                                reason: unmuteReasonDraft,
                              });
                            }}
                            disabled={unmuteWatchSessionMutation.isPending}
                            data-testid="button-confirm-unmute-watch-session"
                            className="bg-emerald-600 hover:bg-emerald-500 text-white"
                          >
                            {unmuteWatchSessionMutation.isPending ? (
                              <>
                                <Loader2 className="w-3 h-3 mr-2 animate-spin" />
                                Lifting…
                              </>
                            ) : (
                              <>
                                <CheckCircle className="w-3 h-3 mr-2" />
                                Yes, lift the mute
                              </>
                            )}
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                    <div>
                      <p className="text-xs text-muted-foreground font-medium mb-2">Recent buckets</p>
                      <div className="overflow-x-auto">
                        <table className="w-full text-xs" data-testid="table-watch-recent">
                          <thead>
                            <tr className="text-left text-muted-foreground border-b border-border">
                              <th className="py-1.5 pr-3 font-medium">Minute</th>
                              <th className="py-1.5 pr-3 font-medium">User</th>
                              <th className="py-1.5 pr-3 font-medium">Tournament</th>
                              <th className="py-1.5 pr-3 font-medium">Mode</th>
                              <th className="py-1.5 font-medium text-right">Position msgs</th>
                            </tr>
                          </thead>
                          <tbody>
                            {watchMetrics.recent.map((b) => (
                              <tr key={`${b.sessionId}-${b.bucketMinute}`} className="border-b border-border/50 last:border-0">
                                <td className="py-1.5 pr-3 text-white whitespace-nowrap">{new Date(b.bucketMinute).toLocaleString()}</td>
                                <td className="py-1.5 pr-3 text-white">#{b.userId}</td>
                                <td className="py-1.5 pr-3 text-muted-foreground">{b.tournamentId ?? '—'}</td>
                                <td className="py-1.5 pr-3">
                                  <Badge variant="outline" className={b.batteryMode ? 'text-amber-400 border-amber-500/30' : 'text-blue-400 border-blue-500/30'}>
                                    {b.batteryMode ? 'battery' : 'normal'}
                                  </Badge>
                                </td>
                                <td className="py-1.5 text-white text-right font-mono">{b.positionCount.toLocaleString()}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </>
                )}
              </div>

              {/* Watch GPS chart drill-down dialog (Task #1195) */}
              <Dialog
                open={watchDrillBucketMs != null}
                onOpenChange={(open) => { if (!open) setWatchDrillBucketMs(null); }}
              >
                <DialogContent
                  className="max-w-2xl bg-card border-border text-white"
                  data-testid="dialog-watch-drilldown"
                >
                  <DialogHeader>
                    <DialogTitle className="flex items-center gap-2 text-white">
                      <Watch className="w-4 h-4 text-primary" />
                      Top sessions in this bucket
                    </DialogTitle>
                    <DialogDescription className="text-muted-foreground">
                      {watchDrillBucketMs != null && watchMetrics ? (() => {
                        const start = new Date(watchDrillBucketMs);
                        const end = new Date(watchDrillBucketMs + watchDrillBucketSeconds * 1000);
                        return (
                          <>
                            {start.toLocaleString()} → {end.toLocaleString()}
                          </>
                        );
                      })() : null}
                    </DialogDescription>
                  </DialogHeader>
                  {watchDrillLoading ? (
                    <div className="flex justify-center py-8">
                      <Loader2 className="w-5 h-5 animate-spin text-primary" />
                    </div>
                  ) : watchDrillError ? (
                    <div
                      className="flex items-start gap-2 text-sm text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg p-3"
                      data-testid="text-watch-drilldown-error"
                    >
                      <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                      <span>Couldn’t load top sessions: {watchDrillError.message}</span>
                    </div>
                  ) : !watchDrillData || watchDrillData.sessions.length === 0 ? (
                    <p
                      className="text-sm text-muted-foreground py-6 text-center"
                      data-testid="text-watch-drilldown-empty"
                    >
                      No watch sessions recorded in this bucket.
                    </p>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs" data-testid="table-watch-drilldown">
                        <thead>
                          <tr className="text-left text-muted-foreground border-b border-border">
                            <th className="py-1.5 pr-3 font-medium">Session</th>
                            <th className="py-1.5 pr-3 font-medium">User</th>
                            <th className="py-1.5 pr-3 font-medium">Tournament</th>
                            <th className="py-1.5 pr-3 font-medium">Mode</th>
                            <th className="py-1.5 pr-3 font-medium text-right">Mins</th>
                            <th className="py-1.5 pr-3 font-medium text-right">Position msgs</th>
                            <th className="py-1.5 pr-3 font-medium text-right">Inspect</th>
                            <th className="py-1.5 font-medium text-right">Action</th>
                          </tr>
                        </thead>
                        <tbody>
                          {watchDrillData.sessions.map((s) => (
                            <tr
                              key={s.sessionId}
                              className="border-b border-border/50 last:border-0"
                              data-testid={`row-watch-drilldown-${s.sessionId}`}
                            >
                              <td className="py-1.5 pr-3 text-white font-mono text-[11px]" title={s.sessionId}>
                                {s.sessionId.length > 16 ? `${s.sessionId.slice(0, 16)}…` : s.sessionId}
                              </td>
                              <td className="py-1.5 pr-3">
                                <button
                                  type="button"
                                  className="text-primary hover:underline"
                                  onClick={() => {
                                    setWatchDrillBucketMs(null);
                                    navigate(`/member-360/${s.userId}`);
                                  }}
                                  data-testid={`link-watch-drilldown-user-${s.userId}`}
                                >
                                  #{s.userId}
                                </button>
                              </td>
                              <td className="py-1.5 pr-3 text-muted-foreground">
                                {s.tournamentId == null ? (
                                  '—'
                                ) : (
                                  <button
                                    type="button"
                                    className="text-primary hover:underline"
                                    onClick={() => {
                                      setWatchDrillBucketMs(null);
                                      navigate(`/tournaments/${s.tournamentId}`);
                                    }}
                                    data-testid={`link-watch-drilldown-tournament-${s.tournamentId}`}
                                  >
                                    #{s.tournamentId}
                                  </button>
                                )}
                              </td>
                              <td className="py-1.5 pr-3">
                                <Badge variant="outline" className={s.batteryMode ? 'text-amber-400 border-amber-500/30' : 'text-blue-400 border-blue-500/30'}>
                                  {s.batteryMode ? 'battery' : 'normal'}
                                </Badge>
                              </td>
                              <td className="py-1.5 pr-3 text-muted-foreground text-right">{s.bucketCount}</td>
                              <td className="py-1.5 pr-3 text-white text-right font-mono">{s.positionCount.toLocaleString()}</td>
                              <td className="py-1.5 pr-3 text-right">
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  className="h-7 px-2 text-xs"
                                  onClick={() => setWatchPositionsSessionId(s.sessionId)}
                                  data-testid={`button-watch-drilldown-positions-${s.sessionId}`}
                                >
                                  <MapPin className="w-3 h-3 mr-1" />
                                  View positions
                                </Button>
                              </td>
                              <td className="py-1.5 text-right">
                                {(() => {
                                  // Task #1678 — if this session is already
                                  // in the in-process mute list, swap the
                                  // Mute button for a non-clickable badge so
                                  // ops can see at a glance the click took
                                  // hold. Lifting it lives in the dedicated
                                  // Active mutes panel above to keep the
                                  // drill-down focused on diagnosis.
                                  const muted = mutedSessionLookup.get(s.sessionId);
                                  if (muted) {
                                    const remainingMin = Math.max(0, Math.round(muted.remainingMs / 60_000));
                                    const remainingSec = Math.max(0, Math.round(muted.remainingMs / 1000));
                                    const remainingLabel = remainingMin >= 1
                                      ? `${remainingMin}m`
                                      : `${remainingSec}s`;
                                    return (
                                      <Badge
                                        variant="outline"
                                        className="h-7 text-xs text-amber-400 border-amber-500/30 bg-amber-500/10 inline-flex items-center gap-1 px-2"
                                        title={`Mute expires at ${new Date(muted.expiresAt).toLocaleString()}`}
                                        data-testid={`badge-muted-watch-session-${s.sessionId}`}
                                      >
                                        <Ban className="w-3 h-3" />
                                        Muted · expires in {remainingLabel}
                                      </Badge>
                                    );
                                  }
                                  return (
                                    <Button
                                      type="button"
                                      size="sm"
                                      variant="outline"
                                      className="h-7 text-xs text-amber-400 border-amber-500/30 hover:bg-amber-500/10 hover:text-amber-300"
                                      disabled={mutingSessionId === s.sessionId || muteWatchSessionMutation.isPending}
                                      onClick={() => muteWatchSessionMutation.mutate(s.sessionId)}
                                      data-testid={`button-mute-watch-session-${s.sessionId}`}
                                      title="Drop further position messages from this session across every api-server replica until the mute expires"
                                    >
                                      {mutingSessionId === s.sessionId ? (
                                        <Loader2 className="w-3 h-3 animate-spin" />
                                      ) : (
                                        <>
                                          <Ban className="w-3 h-3 mr-1" />
                                          Mute
                                        </>
                                      )}
                                    </Button>
                                  );
                                })()}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                  <DialogFooter>
                    <Button variant="outline" size="sm" onClick={() => setWatchDrillBucketMs(null)}>
                      Close
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>

              {/* Raw watch position payloads (Task #1392). Opened from a row's
                  "View positions" button — shows the most recent lat/lng/
                  accuracy/timestamps for the chosen session, sourced from a
                  short-lived per-session ring buffer on the api-server. */}
              <Dialog
                open={watchPositionsSessionId != null}
                onOpenChange={(open) => {
                  if (!open) {
                    setWatchPositionsSessionId(null);
                    // Task #2076 — drop any stale hover highlight when the
                    // dialog closes so re-opening starts neutral.
                    setWatchPositionsHoveredKey(null);
                  }
                }}
              >
                <DialogContent
                  className="max-w-3xl bg-card border-border text-white"
                  data-testid="dialog-watch-positions"
                >
                  <DialogHeader>
                    <DialogTitle className="flex items-center gap-2 text-white">
                      <MapPin className="w-4 h-4 text-primary" />
                      Recent watch positions
                    </DialogTitle>
                    <DialogDescription className="text-muted-foreground break-all">
                      {watchPositionsSessionId ? (
                        <>
                          Session <span className="font-mono">{watchPositionsSessionId}</span>
                        </>
                      ) : null}
                    </DialogDescription>
                  </DialogHeader>
                  {watchPositionsLoading ? (
                    <div className="flex justify-center py-8">
                      <Loader2 className="w-5 h-5 animate-spin text-primary" />
                    </div>
                  ) : watchPositionsError ? (
                    <div
                      className="flex items-start gap-2 text-sm text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg p-3"
                      data-testid="text-watch-positions-error"
                    >
                      <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                      <span>Couldn’t load positions: {watchPositionsError.message}</span>
                    </div>
                  ) : !watchPositionsData || watchPositionsData.samples.length === 0 ? (
                    <p
                      className="text-sm text-muted-foreground py-6 text-center"
                      data-testid="text-watch-positions-empty"
                    >
                      No recent position payloads for this session. The buffer is per-replica
                      and evicts entries older than {watchPositionsData
                        ? Math.round(watchPositionsData.ttlSeconds / 60)
                        : 30} minutes — try the live replica or refresh once the watch reconnects.
                    </p>
                  ) : (
                    <>
                      <div className="flex items-center justify-between text-xs text-muted-foreground">
                        <span data-testid="text-watch-positions-summary">
                          Showing {watchPositionsData.samples.length} of {watchPositionsData.totalSamples} buffered
                          {' '}(ring holds up to {watchPositionsData.ringSize}, TTL{' '}
                          {Math.round(watchPositionsData.ttlSeconds / 60)}m)
                        </span>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="h-7 px-2 text-xs"
                          onClick={() => refetchWatchPositions()}
                          disabled={watchPositionsFetching}
                          data-testid="button-watch-positions-refresh"
                        >
                          <RefreshCw className={`w-3 h-3 mr-1 ${watchPositionsFetching ? 'animate-spin' : ''}`} />
                          Refresh
                        </Button>
                      </div>
                      {/* Task #1675 — small scatter visual alongside the table
                          so ops can eyeball stuck loops / jitter / jumps in
                          seconds, instead of scanning rows.
                          Task #2076 — share a hover key so hovering a row
                          emphasises the matching marker (and vice versa). */}
                      <WatchPositionsScatter
                        samples={watchPositionsData.samples}
                        hoveredKey={watchPositionsHoveredKey}
                        onHoverKey={setWatchPositionsHoveredKey}
                      />
                      {(() => {
                        // Task #2076 — compute the stuck flag once for the
                        // whole table so each row's highlight key matches the
                        // scatter's marker keys (stuck → all rows share one
                        // sentinel key; trajectory → key encodes the rendered
                        // lat/lng so duplicate-coord rows still light up
                        // together with their shared marker).
                        const tableStuck = isStuckPositionCluster(
                          watchPositionsData.samples,
                        );
                        return (
                      <div className="overflow-x-auto max-h-96 overflow-y-auto">
                        <table className="w-full text-xs" data-testid="table-watch-positions">
                          <thead className="sticky top-0 bg-card">
                            <tr className="text-left text-muted-foreground border-b border-border">
                              <th className="py-1.5 pr-3 font-medium">Timestamp</th>
                              <th className="py-1.5 pr-3 font-medium text-right">Lat</th>
                              <th className="py-1.5 pr-3 font-medium text-right">Lon</th>
                              <th className="py-1.5 pr-3 font-medium text-right">Accuracy (m)</th>
                              <th className="py-1.5 font-medium">Mode</th>
                            </tr>
                          </thead>
                          <tbody>
                            {watchPositionsData.samples.map((p, i) => {
                              const rowKey = watchPositionHighlightKey(p, tableStuck);
                              const isHighlighted =
                                watchPositionsHoveredKey != null &&
                                watchPositionsHoveredKey === rowKey;
                              return (
                              <tr
                                key={`${p.timestamp}-${i}`}
                                className={`border-b border-border/50 last:border-0 cursor-pointer transition-colors ${
                                  isHighlighted ? 'bg-primary/15' : 'hover:bg-muted/30'
                                }`}
                                data-testid={`row-watch-positions-${i}`}
                                data-highlighted={isHighlighted ? 'true' : 'false'}
                                onMouseEnter={() => setWatchPositionsHoveredKey(rowKey)}
                                onMouseLeave={() => setWatchPositionsHoveredKey(null)}
                              >
                                <td className="py-1.5 pr-3 text-muted-foreground font-mono text-[11px]">
                                  {new Date(p.timestamp).toLocaleString()}
                                </td>
                                <td className="py-1.5 pr-3 text-white text-right font-mono">
                                  {p.lat.toFixed(6)}
                                </td>
                                <td className="py-1.5 pr-3 text-white text-right font-mono">
                                  {p.lng.toFixed(6)}
                                </td>
                                <td className="py-1.5 pr-3 text-muted-foreground text-right font-mono">
                                  {p.accuracy == null ? '—' : p.accuracy.toFixed(1)}
                                </td>
                                <td className="py-1.5">
                                  <Badge variant="outline" className={p.batteryMode ? 'text-amber-400 border-amber-500/30' : 'text-blue-400 border-blue-500/30'}>
                                    {p.batteryMode ? 'battery' : 'normal'}
                                  </Badge>
                                </td>
                              </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                        );
                      })()}
                    </>
                  )}
                  <DialogFooter>
                    <Button variant="outline" size="sm" onClick={() => setWatchPositionsSessionId(null)}>
                      Close
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </>
          ) : null}

          {/* Ops alert tunables (Tasks #1305 + #1664) — admin-editable
              tunables for the two ops-paging crons. Cron picks up changes
              on its next run, so ops can silence noisy days or re-tune
              sensitivity without a redeploy. One card hosts both sub-
              sections so a single Save/Reset action covers all six knobs. */}
          <div className="bg-card border border-border rounded-xl p-5 space-y-4" data-testid="card-ops-alert-settings">
            <div className="flex items-center gap-2">
              <BellRing className="w-4 h-4 text-primary" />
              <h2 className="text-sm font-semibold text-white">Ops alert tunables</h2>
              <span className="text-xs text-muted-foreground">
                Thresholds, windows, and cooldowns for the two ops-paging crons. Leave any field blank to inherit from env / default.
              </span>
            </div>

            {opsAlertSettingsLoading || !opsAlertConfig ? (
              <div className="flex justify-center py-6"><Loader2 className="w-5 h-5 animate-spin text-primary" /></div>
            ) : (
              <>
                {/*
                  Task #2057 — Slack/PagerDuty wiring badges + test-page
                  button for the notify-retry exhaustion alert. Sits at
                  the top of the card so the chat-channel state is
                  visible before an admin starts editing thresholds.
                */}
                <OpsAlertWiringPanel
                  chatTargets={opsAlertConfig.chatTargets}
                  label="Retry-exhaustion alert"
                  slackEnvVar="OPS_NOTIFY_RETRY_ALERT_SLACK_WEBHOOK"
                  pagerDutyEnvVar="OPS_NOTIFY_RETRY_ALERT_PAGERDUTY_ROUTING_KEY"
                  isSending={sendNotifyRetryOpsAlertTestPage.isPending}
                  onSendTestPage={() => sendNotifyRetryOpsAlertTestPage.mutate()}
                  testIdPrefix="notify-retry-ops-alert"
                />
                <div className="space-y-2">
                  <p className="text-xs font-medium text-white">Retry-exhaustion ops alert</p>
                  <p className="text-[11px] text-muted-foreground -mt-1">
                    Daily ops email when combined notification retries hit their cap.
                  </p>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <label className="text-xs text-muted-foreground" htmlFor="ops-alert-threshold">
                      Alert threshold (combined exhausted rows)
                    </label>
                    <Input
                      id="ops-alert-threshold"
                      type="number"
                      min={1}
                      step={1}
                      placeholder={`Inherit (${opsAlertConfig.threshold})`}
                      value={opsThresholdDraft}
                      onChange={e => setOpsThresholdDraft(e.target.value)}
                      className="bg-background border-border text-white"
                      data-testid="input-ops-alert-threshold"
                    />
                    <p className="text-[11px] text-muted-foreground">
                      Effective: <span className="text-white font-medium">{opsAlertConfig.threshold}</span>
                      {' · '}
                      {opsAlertConfig.source.threshold === 'db'
                        ? 'override stored in database'
                        : opsAlertConfig.source.threshold === 'env'
                          ? `inheriting from OPS_NOTIFY_EXHAUSTION_THRESHOLD env var (${opsAlertConfig.envThreshold})`
                          : `inheriting from hardcoded default (${opsAlertConfig.defaultThreshold})`}
                      {'. Leave blank to inherit.'}
                    </p>
                  </div>

                  <div className="space-y-1.5">
                    <label className="text-xs text-muted-foreground" htmlFor="ops-alert-window">
                      Lookback window (hours)
                    </label>
                    <Input
                      id="ops-alert-window"
                      type="number"
                      min={1}
                      step={1}
                      placeholder={`Inherit (${opsAlertConfig.windowHours})`}
                      value={opsWindowDraft}
                      onChange={e => setOpsWindowDraft(e.target.value)}
                      className="bg-background border-border text-white"
                      data-testid="input-ops-alert-window"
                    />
                    <p className="text-[11px] text-muted-foreground">
                      Effective: <span className="text-white font-medium">{opsAlertConfig.windowHours}h</span>
                      {' · '}
                      {opsAlertConfig.source.windowHours === 'db'
                        ? 'override stored in database'
                        : opsAlertConfig.source.windowHours === 'env'
                          ? `inheriting from OPS_NOTIFY_EXHAUSTION_WINDOW_HOURS env var (${opsAlertConfig.envWindowHours})`
                          : `inheriting from hardcoded default (${opsAlertConfig.defaultWindowHours})`}
                      {'. Leave blank to inherit.'}
                    </p>
                  </div>
                  </div>
                </div>

                {/* Task #2055 — sanitised Slack / PagerDuty chat-target
                    status for the retry-exhaustion ops alert. Sits next to
                    the email recipient list because POST
                    /super-admin/ops-alert-settings/test fires both an
                    email AND (when configured) a Slack / PagerDuty test
                    page — admins should be able to tell BEFORE pressing
                    Send which channels will fire, and which env var to
                    set when one is missing. Secret values themselves
                    are never returned by the GET endpoint. */}
                <div className="space-y-2 border-t border-border pt-4" data-testid="section-ops-alert-chat-targets">
                  <p className="text-xs font-medium text-white">Chat paging (Slack / PagerDuty)</p>
                  <p className="text-[11px] text-muted-foreground -mt-1">
                    Pressing "Send test alert" also fires a clearly-labelled test page on every chat channel that is configured. Edits to the env vars below take effect on the next restart.
                  </p>
                  {opsAlertChatTargetsError ? (
                    <div
                      className="flex items-start gap-2 text-[11px] text-rose-300 rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2"
                      data-testid="text-ops-alert-chat-targets-error"
                    >
                      <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                      <span>
                        Couldn't load chat-paging configuration: {opsAlertChatTargetsError.message}
                      </span>
                    </div>
                  ) : opsAlertChatTargetsLoading || !opsAlertChatTargets ? (
                    <div className="flex items-center gap-2 text-[11px] text-muted-foreground py-1" data-testid="text-ops-alert-chat-targets-loading">
                      <Loader2 className="w-3 h-3 animate-spin" />
                      Checking chat-paging configuration…
                    </div>
                  ) : (() => {
                    const t = opsAlertChatTargets;
                    const noneConfigured = t.slack.status === 'missing' && t.pagerDuty.status === 'missing';
                    const renderRow = (
                      label: 'Slack' | 'PagerDuty',
                      ch: OpsAlertChatChannelStatus,
                      testId: string,
                    ) => {
                      const isConfigured = ch.status === 'configured';
                      const sourceLabel = ch.source === 'dedicated'
                        ? `dedicated env var (${ch.dedicatedEnvVar})`
                        : ch.source === 'shared'
                          ? `shared fallback (${ch.sharedEnvVar})`
                          : null;
                      return (
                        <div className="flex items-center gap-2 text-[11px]" data-testid={testId}>
                          <span
                            className={`flex items-center gap-1 font-medium ${isConfigured ? 'text-emerald-400' : 'text-muted-foreground'}`}
                            title={isConfigured
                              ? `Configured via ${ch.source === 'dedicated' ? ch.dedicatedEnvVar : ch.sharedEnvVar}`
                              : `Set ${ch.dedicatedEnvVar} or the shared ${ch.sharedEnvVar} env var`}
                          >
                            {isConfigured
                              ? <Check className="w-3.5 h-3.5" />
                              : <X className="w-3.5 h-3.5" />}
                            {label}
                          </span>
                          <span className="text-muted-foreground">
                            {isConfigured ? (
                              <>configured · {sourceLabel}</>
                            ) : (
                              <>missing · set <span className="text-white font-mono">{ch.dedicatedEnvVar}</span> or shared <span className="text-white font-mono">{ch.sharedEnvVar}</span></>
                            )}
                          </span>
                        </div>
                      );
                    };
                    return (
                      <div className="rounded-lg border border-border bg-card/60 px-3 py-2 space-y-1.5" data-testid="panel-ops-alert-chat-targets">
                        {renderRow('Slack', t.slack, 'status-ops-alert-chat-slack')}
                        {renderRow('PagerDuty', t.pagerDuty, 'status-ops-alert-chat-pagerduty')}
                        {noneConfigured && (
                          <div className="flex items-center gap-1 text-[11px] text-amber-400 pt-1" data-testid="status-ops-alert-chat-none">
                            <AlertCircle className="w-3.5 h-3.5" />
                            No chat channels configured — only the email recipient list will be paged.
                          </div>
                        )}
                      </div>
                    );
                  })()}
                </div>

                {/* Task #1910 — DB-backed override for the retry-exhaustion
                    ops alert recipient list. Lives next to the threshold +
                    window because they are the same alert. The textarea
                    accepts one address per line or a comma-separated list;
                    server lowercases / dedupes / validates. Empty save
                    resolves back to OPS_ALERT_EMAILS so a cleared field
                    can never accidentally silence the breach email. */}
                <div className="space-y-2 border-t border-border pt-4" data-testid="section-ops-alert-recipients">
                  <p className="text-xs font-medium text-white">Recipient list</p>
                  <p className="text-[11px] text-muted-foreground -mt-1">
                    Email addresses paged when the retry-exhaustion threshold breaches. Edits take effect on the next cron run — no redeploy required.
                  </p>
                  <Textarea
                    id="ops-alert-recipients"
                    rows={3}
                    placeholder={
                      opsAlertConfig.recipients.envList.length > 0
                        ? `Inherit from OPS_ALERT_EMAILS (${opsAlertConfig.recipients.envList.join(', ')})`
                        : 'No recipients configured — set OPS_ALERT_EMAILS or add at least one address here.'
                    }
                    value={opsRecipientsDraft}
                    onChange={e => setOpsRecipientsDraft(e.target.value)}
                    className="bg-background border-border text-white font-mono text-xs"
                    data-testid="input-ops-alert-recipients"
                  />
                  <p className="text-[11px] text-muted-foreground" data-testid="text-ops-alert-recipients-effective">
                    {opsAlertConfig.recipients.effective.length === 0 ? (
                      <>
                        Effective: <span className="text-white font-medium">none</span>
                        {' · '}
                        no DB override and OPS_ALERT_EMAILS is unset — breach emails will be skipped until at least one recipient is configured.
                      </>
                    ) : (
                      <>
                        Effective: <span className="text-white font-medium">{opsAlertConfig.recipients.effective.join(', ')}</span>
                        {' · '}
                        {opsAlertConfig.recipients.source === 'org_override'
                          ? 'override stored in database'
                          : `inheriting from ${opsAlertConfig.recipients.envVar} env var`}
                        {'. Leave blank to inherit from env (the env list is the floor).'}
                      </>
                    )}
                  </p>
                </div>

                {/* Task #1664 — Manual-entry alert health auto-page tunables. */}
                <div className="space-y-2 border-t border-border pt-4" data-testid="section-ops-alert-manual-entry">
                  <p className="text-xs font-medium text-white">Manual-entry alert health auto-page</p>
                  <p className="text-[11px] text-muted-foreground -mt-1">
                    Hourly cron that pages super-admins + on-call when manual-entry alert delivery health drops.
                  </p>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                      <label className="text-xs text-muted-foreground" htmlFor="ops-me-rate">
                        Rate threshold (% of 7-day alerts requiring manual entry)
                      </label>
                      <Input
                        id="ops-me-rate"
                        type="number"
                        min={1}
                        max={100}
                        step={1}
                        placeholder={`Inherit (${opsAlertConfig.manualEntry.rateThresholdPct}%)`}
                        value={opsMeRateDraft}
                        onChange={e => setOpsMeRateDraft(e.target.value)}
                        className="bg-background border-border text-white"
                        data-testid="input-ops-me-rate"
                      />
                      <p className="text-[11px] text-muted-foreground">
                        Effective: <span className="text-white font-medium">{opsAlertConfig.manualEntry.rateThresholdPct}%</span>
                        {' · '}
                        {opsAlertConfig.manualEntry.source.rateThresholdPct === 'db'
                          ? 'override stored in database'
                          : opsAlertConfig.manualEntry.source.rateThresholdPct === 'env'
                            ? `inheriting from OPS_MANUAL_ENTRY_ALERT_RATE_THRESHOLD_PCT env var (${opsAlertConfig.manualEntry.envRateThresholdPct}%)`
                            : `inheriting from hardcoded default (${opsAlertConfig.manualEntry.defaultRateThresholdPct}%)`}
                        {'. Leave blank to inherit.'}
                      </p>
                    </div>

                    <div className="space-y-1.5">
                      <label className="text-xs text-muted-foreground" htmlFor="ops-me-min-sample">
                        Min 7-day alert sample size
                      </label>
                      <Input
                        id="ops-me-min-sample"
                        type="number"
                        min={1}
                        step={1}
                        placeholder={`Inherit (${opsAlertConfig.manualEntry.minSample})`}
                        value={opsMeMinSampleDraft}
                        onChange={e => setOpsMeMinSampleDraft(e.target.value)}
                        className="bg-background border-border text-white"
                        data-testid="input-ops-me-min-sample"
                      />
                      <p className="text-[11px] text-muted-foreground">
                        Effective: <span className="text-white font-medium">{opsAlertConfig.manualEntry.minSample}</span>
                        {' · '}
                        {opsAlertConfig.manualEntry.source.minSample === 'db'
                          ? 'override stored in database'
                          : opsAlertConfig.manualEntry.source.minSample === 'env'
                            ? `inheriting from OPS_MANUAL_ENTRY_ALERT_MIN_SAMPLE env var (${opsAlertConfig.manualEntry.envMinSample})`
                            : `inheriting from hardcoded default (${opsAlertConfig.manualEntry.defaultMinSample})`}
                        {'. Leave blank to inherit.'}
                      </p>
                    </div>

                    <div className="space-y-1.5">
                      <label className="text-xs text-muted-foreground" htmlFor="ops-me-consec-zero">
                        Consecutive zero-delivery alerts trigger
                      </label>
                      <Input
                        id="ops-me-consec-zero"
                        type="number"
                        min={1}
                        step={1}
                        placeholder={`Inherit (${opsAlertConfig.manualEntry.consecutiveZero})`}
                        value={opsMeConsecZeroDraft}
                        onChange={e => setOpsMeConsecZeroDraft(e.target.value)}
                        className="bg-background border-border text-white"
                        data-testid="input-ops-me-consec-zero"
                      />
                      <p className="text-[11px] text-muted-foreground">
                        Effective: <span className="text-white font-medium">{opsAlertConfig.manualEntry.consecutiveZero}</span>
                        {' · '}
                        {opsAlertConfig.manualEntry.source.consecutiveZero === 'db'
                          ? 'override stored in database'
                          : opsAlertConfig.manualEntry.source.consecutiveZero === 'env'
                            ? `inheriting from OPS_MANUAL_ENTRY_ALERT_CONSECUTIVE_ZERO env var (${opsAlertConfig.manualEntry.envConsecutiveZero})`
                            : `inheriting from hardcoded default (${opsAlertConfig.manualEntry.defaultConsecutiveZero})`}
                        {'. Leave blank to inherit.'}
                      </p>
                    </div>

                    <div className="space-y-1.5">
                      <label className="text-xs text-muted-foreground" htmlFor="ops-me-cooldown">
                        Cooldown between repeat pages (hours)
                      </label>
                      <Input
                        id="ops-me-cooldown"
                        type="number"
                        min={1}
                        step={1}
                        placeholder={`Inherit (${opsAlertConfig.manualEntry.cooldownHours}h)`}
                        value={opsMeCooldownDraft}
                        onChange={e => setOpsMeCooldownDraft(e.target.value)}
                        className="bg-background border-border text-white"
                        data-testid="input-ops-me-cooldown"
                      />
                      <p className="text-[11px] text-muted-foreground">
                        Effective: <span className="text-white font-medium">{opsAlertConfig.manualEntry.cooldownHours}h</span>
                        {' · '}
                        {opsAlertConfig.manualEntry.source.cooldownHours === 'db'
                          ? 'override stored in database'
                          : opsAlertConfig.manualEntry.source.cooldownHours === 'env'
                            ? `inheriting from OPS_MANUAL_ENTRY_ALERT_COOLDOWN_HOURS env var (${opsAlertConfig.manualEntry.envCooldownHours}h)`
                            : `inheriting from hardcoded default (${opsAlertConfig.manualEntry.defaultCooldownHours}h)`}
                        {'. Leave blank to inherit.'}
                      </p>
                    </div>

                    {/* Task #2081 — muted-skip pile-up lookback hours.
                        Default 168h (= 7d) matches the legacy hard-coded
                        `since7d` window the cron used before this knob
                        existed; tightening it (e.g. 72h / 36h) makes the
                        pile-up detector more aggressive. */}
                    <div className="space-y-1.5">
                      <label className="text-xs text-muted-foreground" htmlFor="ops-me-lookback">
                        Muted-skip pile-up lookback (hours)
                      </label>
                      <Input
                        id="ops-me-lookback"
                        type="number"
                        min={1}
                        step={1}
                        placeholder={`Inherit (${opsAlertConfig.manualEntry.lookbackHours}h)`}
                        value={opsMeLookbackDraft}
                        onChange={e => setOpsMeLookbackDraft(e.target.value)}
                        className="bg-background border-border text-white"
                        data-testid="input-ops-me-lookback"
                      />
                      <p className="text-[11px] text-muted-foreground">
                        Effective: <span className="text-white font-medium">{opsAlertConfig.manualEntry.lookbackHours}h</span>
                        {' · '}
                        {opsAlertConfig.manualEntry.source.lookbackHours === 'db'
                          ? 'override stored in database'
                          : opsAlertConfig.manualEntry.source.lookbackHours === 'env'
                            ? `inheriting from OPS_MANUAL_ENTRY_ALERT_LOOKBACK_HOURS env var (${opsAlertConfig.manualEntry.envLookbackHours}h)`
                            : `inheriting from hardcoded default (${opsAlertConfig.manualEntry.defaultLookbackHours}h)`}
                        {'. Leave blank to inherit.'}
                      </p>
                    </div>

                    {/* Task #2081 — recipient lookup limit. Caps the
                        deduplicated super_admin + OPS_ALERT_EMAILS list
                        before the cron's send loop so a misconfigured
                        sweep can't fan out to hundreds of inboxes. */}
                    <div className="space-y-1.5">
                      <label className="text-xs text-muted-foreground" htmlFor="ops-me-recipient-limit">
                        Recipient lookup limit (max emailed per page)
                      </label>
                      <Input
                        id="ops-me-recipient-limit"
                        type="number"
                        min={1}
                        step={1}
                        placeholder={`Inherit (${opsAlertConfig.manualEntry.recipientLookupLimit})`}
                        value={opsMeRecipientLookupLimitDraft}
                        onChange={e => setOpsMeRecipientLookupLimitDraft(e.target.value)}
                        className="bg-background border-border text-white"
                        data-testid="input-ops-me-recipient-limit"
                      />
                      <p className="text-[11px] text-muted-foreground">
                        Effective: <span className="text-white font-medium">{opsAlertConfig.manualEntry.recipientLookupLimit}</span>
                        {' · '}
                        {opsAlertConfig.manualEntry.source.recipientLookupLimit === 'db'
                          ? 'override stored in database'
                          : opsAlertConfig.manualEntry.source.recipientLookupLimit === 'env'
                            ? `inheriting from OPS_MANUAL_ENTRY_ALERT_RECIPIENT_LOOKUP_LIMIT env var (${opsAlertConfig.manualEntry.envRecipientLookupLimit})`
                            : `inheriting from hardcoded default (${opsAlertConfig.manualEntry.defaultRecipientLookupLimit})`}
                        {'. Leave blank to inherit.'}
                      </p>
                    </div>

                    {/* Task #2081 — dry-run flag. When on, the cron
                        evaluates the breach but skips the chat dispatch,
                        the email loop, the page_history insert and the
                        cooldown stamp. Tri-state select so an explicit
                        `false` override stays distinguishable from "no
                        override stored, inheriting the default of false". */}
                    <div className="space-y-1.5">
                      <label className="text-xs text-muted-foreground" htmlFor="ops-me-dry-run">
                        Dry-run (skip email + chat dispatch)
                      </label>
                      <select
                        id="ops-me-dry-run"
                        value={opsMeDryRunDraft}
                        onChange={e => setOpsMeDryRunDraft(e.target.value as '' | 'true' | 'false')}
                        className="w-full h-9 rounded-md border border-border bg-background px-3 py-1 text-sm text-white"
                        data-testid="select-ops-me-dry-run"
                      >
                        <option value="">Inherit ({opsAlertConfig.manualEntry.dryRun ? 'on' : 'off'})</option>
                        <option value="true">On — skip email + chat</option>
                        <option value="false">Off — page on breach</option>
                      </select>
                      <p className="text-[11px] text-muted-foreground">
                        Effective: <span className="text-white font-medium">{opsAlertConfig.manualEntry.dryRun ? 'on' : 'off'}</span>
                        {' · '}
                        {opsAlertConfig.manualEntry.source.dryRun === 'db'
                          ? 'override stored in database'
                          : opsAlertConfig.manualEntry.source.dryRun === 'env'
                            ? `inheriting from OPS_MANUAL_ENTRY_ALERT_DRY_RUN env var (${opsAlertConfig.manualEntry.envDryRun ? 'on' : 'off'})`
                            : `inheriting from hardcoded default (${opsAlertConfig.manualEntry.defaultDryRun ? 'on' : 'off'})`}
                        {'. Inherit clears the override.'}
                      </p>
                    </div>
                  </div>
                </div>

                <div className="flex items-center justify-between flex-wrap gap-2">
                  <div className="space-y-0.5">
                    <p className="text-[11px] text-muted-foreground" data-testid="text-ops-alert-last-edited">
                      {opsAlertConfig.updatedAt
                        ? (() => {
                            // Task #1923 — prefer the joined display name /
                            // username over the bare numeric ID so the line
                            // matches the friendly labels in the "Recent
                            // changes" list directly below. Fall back to
                            // "user #X" only when the joined names are
                            // missing (deleted user, or row predates the
                            // app_users join), and tooltip the underlying
                            // ID either way so admins can still copy it
                            // when they need to dig into logs.
                            const friendly = opsAlertConfig.updatedByDisplayName?.trim()
                              || opsAlertConfig.updatedByUsername?.trim()
                              || null;
                            const editorLabel = friendly
                              ?? (opsAlertConfig.updatedByUserId !== null
                                ? `user #${opsAlertConfig.updatedByUserId}`
                                : null);
                            const editorTitle = opsAlertConfig.updatedByUserId !== null
                              ? `User ID #${opsAlertConfig.updatedByUserId}`
                              : undefined;
                            return (
                              <>
                                Last edited {new Date(opsAlertConfig.updatedAt).toLocaleString()}
                                {editorLabel ? (
                                  <>
                                    {' by '}
                                    <span title={editorTitle} data-testid="text-ops-alert-last-editor">{editorLabel}</span>
                                  </>
                                ) : ''}
                                .
                              </>
                            );
                          })()
                        : <>No overrides stored yet — every tunable is inheriting its fallback.</>}
                    </p>
                    {/* Task #1916 — surface the last successful "Send
                        test alert" delivery so admins can see at a
                        glance whether a fresh test is needed (and stop
                        re-testing "just in case", filling on-call
                        inboxes with duplicate test emails). */}
                    {opsAlertConfig.lastTestSentAt ? (
                      <p
                        className="text-[11px] text-muted-foreground"
                        data-testid="text-ops-alert-last-test"
                      >
                        Last test sent{' '}
                        <span
                          className="text-white"
                          title={new Date(opsAlertConfig.lastTestSentAt).toLocaleString()}
                          data-testid="text-ops-alert-last-test-when"
                        >
                          {formatRelativeTime(opsAlertConfig.lastTestSentAt)}
                        </span>
                        {opsAlertConfig.lastTestRecipientCount !== null ? (
                          <>
                            {' to '}
                            <span
                              className="text-white"
                              data-testid="text-ops-alert-last-test-recipients"
                            >
                              {opsAlertConfig.lastTestRecipientCount} recipient{opsAlertConfig.lastTestRecipientCount === 1 ? '' : 's'}
                            </span>
                          </>
                        ) : null}
                        {(() => {
                          const author = opsAlertConfig.lastTestSentByDisplayName
                            || opsAlertConfig.lastTestSentByUsername
                            || (opsAlertConfig.lastTestSentByUserId !== null
                              ? `user #${opsAlertConfig.lastTestSentByUserId}`
                              : null);
                          return author
                            ? <> by <span className="text-white" data-testid="text-ops-alert-last-test-author">{author}</span></>
                            : null;
                        })()}
                        .
                      </p>
                    ) : (
                      <p
                        className="text-[11px] text-muted-foreground"
                        data-testid="text-ops-alert-last-test-empty"
                      >
                        No test alert has been sent yet.
                      </p>
                    )}
                  </div>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={updateOpsAlertSettingsMutation.isPending || (
                        opsAlertConfig.dbThreshold === null
                        && opsAlertConfig.dbWindowHours === null
                        && opsAlertConfig.manualEntry.dbRateThresholdPct === null
                        && opsAlertConfig.manualEntry.dbMinSample === null
                        && opsAlertConfig.manualEntry.dbConsecutiveZero === null
                        && opsAlertConfig.manualEntry.dbCooldownHours === null
                        // Task #2081 — also require the three new
                        // overrides to be unset before the reset
                        // button shows as a no-op.
                        && opsAlertConfig.manualEntry.dbLookbackHours === null
                        && opsAlertConfig.manualEntry.dbDryRun === null
                        && opsAlertConfig.manualEntry.dbRecipientLookupLimit === null
                        && opsAlertConfig.recipients.dbList === null
                      )}
                      onClick={() => updateOpsAlertSettingsMutation.mutate({
                        notifyExhaustionThreshold: null,
                        notifyExhaustionWindowHours: null,
                        manualEntryRateThresholdPct: null,
                        manualEntryMinSample: null,
                        manualEntryConsecutiveZero: null,
                        manualEntryCooldownHours: null,
                        // Task #2081 — also clear the new three so
                        // "Reset to inherit" really resets every knob
                        // on this card in one click.
                        manualEntryLookbackHours: null,
                        manualEntryDryRun: null,
                        manualEntryRecipientLookupLimit: null,
                        // Task #1910 — clearing the override falls
                        // the recipient list back to OPS_ALERT_EMAILS.
                        notifyExhaustionRecipients: null,
                      })}
                      title="Clear every override and fall back to env / default"
                      data-testid="button-ops-alert-reset"
                    >
                      <Undo2 className="w-3 h-3 mr-1" />Reset to inherit
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={sendOpsAlertTestMutation.isPending}
                      onClick={() => { setOpsTestOverrideEmail(''); setOpsTestConfirmOpen(true); }}
                      title="Send a clearly-labelled TEST email to OPS_ALERT_EMAILS (or to a one-off override address) to confirm delivery"
                      data-testid="button-ops-alert-send-test"
                    >
                      {sendOpsAlertTestMutation.isPending
                        ? <><Loader2 className="w-3 h-3 mr-1 animate-spin" />Sending…</>
                        : <><Mail className="w-3 h-3 mr-1" />Send test alert</>}
                    </Button>
                    <Button
                      size="sm"
                      disabled={updateOpsAlertSettingsMutation.isPending}
                      onClick={() => {
                        // Generic positive-int parser. Empty input means
                        // "clear the override and fall back to env / default".
                        const parse = (raw: string): number | null | 'invalid' => {
                          const trimmed = raw.trim();
                          if (trimmed === '') return null;
                          const n = Number(trimmed);
                          if (!Number.isInteger(n) || n <= 0) return 'invalid';
                          return n;
                        };
                        // Rate threshold has the same rule plus a 1-100
                        // cap (matches the singleton's CHECK constraint).
                        const parseRate = (raw: string): number | null | 'invalid' => {
                          const v = parse(raw);
                          if (v === 'invalid' || v === null) return v;
                          return v <= 100 ? v : 'invalid';
                        };
                        const t = parse(opsThresholdDraft);
                        const w = parse(opsWindowDraft);
                        const meRate = parseRate(opsMeRateDraft);
                        const meMinSample = parse(opsMeMinSampleDraft);
                        const meConsecZero = parse(opsMeConsecZeroDraft);
                        const meCooldown = parse(opsMeCooldownDraft);
                        // Task #2081 — three new fields. Lookback +
                        // recipient lookup limit reuse the positive-int
                        // parser; dry-run is a tri-state select so the
                        // empty option maps to `null` (clear override)
                        // and the other two map to true/false.
                        const meLookback = parse(opsMeLookbackDraft);
                        const meRecipientLookupLimit = parse(opsMeRecipientLookupLimitDraft);
                        const meDryRun: boolean | null =
                          opsMeDryRunDraft === '' ? null : opsMeDryRunDraft === 'true';
                        if (
                          t === 'invalid'
                          || w === 'invalid'
                          || meMinSample === 'invalid'
                          || meConsecZero === 'invalid'
                          || meCooldown === 'invalid'
                          || meLookback === 'invalid'
                          || meRecipientLookupLimit === 'invalid'
                        ) {
                          toast({ title: 'Invalid value', description: 'All numeric fields must be positive whole numbers (or blank to inherit).', variant: 'destructive' });
                          return;
                        }
                        if (meRate === 'invalid') {
                          toast({ title: 'Invalid value', description: 'Manual-entry rate threshold must be a whole number between 1 and 100 (or blank to inherit).', variant: 'destructive' });
                          return;
                        }
                        // Task #1910 — parse the recipients textarea.
                        // Empty/blank textarea → null (clear override and
                        // inherit from env). Otherwise split on
                        // commas/newlines/whitespace, trim, and pass an
                        // array; the server still re-validates and
                        // de-duplicates so we don't need to be exhaustive
                        // client-side. Client-side check is just a
                        // sanity guard so an obvious typo gets a better
                        // error than the server's generic one.
                        const recipientsRaw = opsRecipientsDraft.trim();
                        let recipientsField: string[] | null;
                        if (recipientsRaw === '') {
                          recipientsField = null;
                        } else {
                          const parts = recipientsRaw
                            .split(/[\s,\n]+/)
                            .map(s => s.trim())
                            .filter(Boolean);
                          const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
                          const bad = parts.find(p => !emailRe.test(p));
                          if (bad) {
                            toast({
                              title: 'Invalid recipient',
                              description: `"${bad}" is not a valid email address. Use one address per line or comma-separated.`,
                              variant: 'destructive',
                            });
                            return;
                          }
                          recipientsField = parts;
                        }
                        updateOpsAlertSettingsMutation.mutate({
                          notifyExhaustionThreshold: t,
                          notifyExhaustionWindowHours: w,
                          manualEntryRateThresholdPct: meRate,
                          manualEntryMinSample: meMinSample,
                          manualEntryConsecutiveZero: meConsecZero,
                          manualEntryCooldownHours: meCooldown,
                          // Task #2081 — three new tunables.
                          manualEntryLookbackHours: meLookback,
                          manualEntryDryRun: meDryRun,
                          manualEntryRecipientLookupLimit: meRecipientLookupLimit,
                          notifyExhaustionRecipients: recipientsField,
                        });
                      }}
                      data-testid="button-ops-alert-save"
                    >
                      {updateOpsAlertSettingsMutation.isPending
                        ? <Loader2 className="w-3 h-3 animate-spin" />
                        : <><Save className="w-3 h-3 mr-1" />Save</>}
                    </Button>
                  </div>
                </div>

                {/* Task #1546 — audit trail of recent tunable changes so
                    ops can reconstruct decisions during postmortems.
                    Task #1924 — only the latest 10 are shown inline;
                    a "Show all" affordance opens a paginated dialog
                    with date-range / editor filters for the full
                    history. */}
                <div className="border-t border-border pt-3" data-testid="section-ops-alert-history">
                  <div className="flex items-center justify-between mb-2 gap-2 flex-wrap">
                    <p className="text-xs font-medium text-white">Recent changes</p>
                    {opsAlertHistoryTotal > opsAlertHistory.length ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 px-2 text-[11px] text-primary hover:text-primary"
                        onClick={() => {
                          // Reset paging + draft filters to a clean
                          // slate when the dialog opens — last
                          // session's filters could be unrelated to
                          // the current incident.
                          setOpsHistoryPage(0);
                          setOpsHistoryFromDraft('');
                          setOpsHistoryToDraft('');
                          setOpsHistoryEditorDraft('all');
                          setOpsHistoryAppliedFrom('');
                          setOpsHistoryAppliedTo('');
                          setOpsHistoryAppliedEditor('all');
                          setOpsHistoryDialogOpen(true);
                        }}
                        data-testid="button-ops-alert-history-show-all"
                      >
                        Show all ({opsAlertHistoryTotal})
                      </Button>
                    ) : null}
                  </div>
                  {opsAlertHistoryLoading ? (
                    <div className="flex justify-center py-3">
                      <Loader2 className="w-4 h-4 animate-spin text-primary" />
                    </div>
                  ) : opsAlertHistory.length === 0 ? (
                    <p className="text-[11px] text-muted-foreground" data-testid="text-ops-alert-history-empty">
                      No changes recorded yet — every save will appear here.
                    </p>
                  ) : (
                    <ul className="space-y-1.5" data-testid="list-ops-alert-history">
                      {opsAlertHistory.map(entry => (
                        <OpsAlertHistoryRow key={entry.id} entry={entry} />
                      ))}
                    </ul>
                  )}
                </div>
              </>
            )}

            {/* Task #1924 — paginated "Show all" browser. Pulls from
                the same endpoint as the dashboard card but sends
                limit/offset + optional date-range / editor filters so
                ops can comb through the full audit log during a
                postmortem instead of being capped at the latest 10. */}
            <Dialog open={opsHistoryDialogOpen} onOpenChange={setOpsHistoryDialogOpen}>
              <DialogContent className="max-w-3xl" data-testid="dialog-ops-alert-history-full">
                <DialogHeader>
                  <DialogTitle className="flex items-center gap-2 text-white">
                    <History className="w-4 h-4" />
                    Ops alert change history
                  </DialogTitle>
                  <DialogDescription>
                    Page through every recorded tunable change. Use the filters to scope the result
                    set when writing up a postmortem.
                  </DialogDescription>
                </DialogHeader>

                <div className="space-y-3">
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                    <div className="space-y-1">
                      <label className="text-[11px] text-muted-foreground" htmlFor="ops-history-from">
                        From
                      </label>
                      <Input
                        id="ops-history-from"
                        type="datetime-local"
                        value={opsHistoryFromDraft}
                        onChange={e => setOpsHistoryFromDraft(e.target.value)}
                        className="h-8 text-xs bg-background border-border text-white"
                        data-testid="input-ops-alert-history-from"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-[11px] text-muted-foreground" htmlFor="ops-history-to">
                        To
                      </label>
                      <Input
                        id="ops-history-to"
                        type="datetime-local"
                        value={opsHistoryToDraft}
                        onChange={e => setOpsHistoryToDraft(e.target.value)}
                        className="h-8 text-xs bg-background border-border text-white"
                        data-testid="input-ops-alert-history-to"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-[11px] text-muted-foreground" htmlFor="ops-history-editor">
                        Editor
                      </label>
                      <Select
                        value={opsHistoryEditorDraft}
                        onValueChange={setOpsHistoryEditorDraft}
                      >
                        <SelectTrigger
                          id="ops-history-editor"
                          className="h-8 text-xs bg-background border-border text-white"
                          data-testid="select-ops-alert-history-editor"
                        >
                          <SelectValue placeholder="All editors" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">All editors</SelectItem>
                          <SelectItem value="none">System / unattributed</SelectItem>
                          {opsHistoryEditorOptions.map(opt => (
                            <SelectItem key={opt.id} value={String(opt.id)}>
                              {opt.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      onClick={() => {
                        setOpsHistoryAppliedFrom(opsHistoryFromDraft);
                        setOpsHistoryAppliedTo(opsHistoryToDraft);
                        setOpsHistoryAppliedEditor(opsHistoryEditorDraft);
                        setOpsHistoryPage(0);
                      }}
                      data-testid="button-ops-alert-history-apply"
                    >
                      <Filter className="w-3 h-3 mr-1" />
                      Apply filters
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setOpsHistoryFromDraft('');
                        setOpsHistoryToDraft('');
                        setOpsHistoryEditorDraft('all');
                        setOpsHistoryAppliedFrom('');
                        setOpsHistoryAppliedTo('');
                        setOpsHistoryAppliedEditor('all');
                        setOpsHistoryPage(0);
                      }}
                      data-testid="button-ops-alert-history-clear"
                    >
                      Clear
                    </Button>
                  </div>

                  <div className="border-t border-border pt-3 max-h-[55vh] overflow-y-auto">
                    {opsAlertHistoryFullError ? (
                      <p
                        className="text-xs text-destructive"
                        data-testid="text-ops-alert-history-error"
                      >
                        {opsAlertHistoryFullError.message}
                      </p>
                    ) : opsAlertHistoryFullLoading ? (
                      <div className="flex justify-center py-6">
                        <Loader2 className="w-5 h-5 animate-spin text-primary" />
                      </div>
                    ) : opsAlertHistoryFullEntries.length === 0 ? (
                      <p
                        className="text-xs text-muted-foreground py-4 text-center"
                        data-testid="text-ops-alert-history-full-empty"
                      >
                        No changes match these filters.
                      </p>
                    ) : (
                      <ul className="space-y-1.5" data-testid="list-ops-alert-history-full">
                        {opsAlertHistoryFullEntries.map(entry => (
                          <OpsAlertHistoryRow key={entry.id} entry={entry} />
                        ))}
                      </ul>
                    )}
                  </div>
                </div>

                <DialogFooter className="flex-col sm:flex-row gap-2 sm:items-center sm:justify-between">
                  <p
                    className="text-[11px] text-muted-foreground"
                    data-testid="text-ops-alert-history-pageinfo"
                  >
                    {opsAlertHistoryFullTotal === 0
                      ? 'No matching entries'
                      : `Showing ${opsHistoryPage * OPS_ALERT_HISTORY_PAGE_SIZE + 1}–${Math.min(
                          opsAlertHistoryFullTotal,
                          opsHistoryPage * OPS_ALERT_HISTORY_PAGE_SIZE + opsAlertHistoryFullEntries.length,
                        )} of ${opsAlertHistoryFullTotal}`}
                    {opsAlertHistoryFullFetching && opsAlertHistoryFullEntries.length > 0 ? (
                      <span className="ml-2 italic">refreshing…</span>
                    ) : null}
                  </p>
                  <div className="flex items-center gap-1">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setOpsHistoryPage(p => Math.max(0, p - 1))}
                      disabled={opsHistoryPage === 0 || opsAlertHistoryFullLoading}
                      data-testid="button-ops-alert-history-prev"
                    >
                      <ChevronLeft className="w-3 h-3 mr-1" />
                      Prev
                    </Button>
                    <span
                      className="text-[11px] text-muted-foreground px-2"
                      data-testid="text-ops-alert-history-page"
                    >
                      Page {opsHistoryPage + 1} / {opsAlertHistoryFullPageCount}
                    </span>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setOpsHistoryPage(p => p + 1)}
                      disabled={
                        opsAlertHistoryFullLoading
                        || opsHistoryPage + 1 >= opsAlertHistoryFullPageCount
                      }
                      data-testid="button-ops-alert-history-next"
                    >
                      Next
                      <ChevronRight className="w-3 h-3 ml-1" />
                    </Button>
                  </div>
                </DialogFooter>
              </DialogContent>
            </Dialog>

            {/* Task #1547 — confirm dialog before sending the test email
                so a stray click doesn't surprise on-call inboxes.
                Task #1917 — optional "Send to (override)" input lets the
                admin route the test email to a one-off address (their
                own inbox) instead of the live OPS_ALERT_EMAILS list. */}
            <Dialog open={opsTestConfirmOpen} onOpenChange={open => {
              if (!sendOpsAlertTestMutation.isPending) setOpsTestConfirmOpen(open);
            }}>
              <DialogContent data-testid="dialog-ops-alert-send-test">
                <DialogHeader>
                  <DialogTitle>Send a test ops alert?</DialogTitle>
                  <DialogDescription>
                    This will deliver a clearly-labelled <span className="font-medium text-white">[TEST]</span> email
                    to every address in <code className="text-amber-400">OPS_ALERT_EMAILS</code> so you can confirm
                    the recipient list and provider are wired correctly. The email uses a synthetic summary —
                    no real exhaustions are reported, and today's daily dedup is left untouched so a real
                    alert can still fire later.
                  </DialogDescription>
                </DialogHeader>
                <div className="space-y-1.5 py-2">
                  <label className="text-xs text-muted-foreground" htmlFor="ops-test-override-email">
                    Send to (override) — optional
                  </label>
                  <Input
                    id="ops-test-override-email"
                    type="email"
                    autoComplete="off"
                    placeholder="me@example.com"
                    value={opsTestOverrideEmail}
                    onChange={e => setOpsTestOverrideEmail(e.target.value)}
                    disabled={sendOpsAlertTestMutation.isPending}
                    className="bg-background border-border text-white"
                    data-testid="input-ops-alert-test-override"
                  />
                  <p className="text-[11px] text-muted-foreground">
                    Leave blank to send to <code className="text-amber-400">OPS_ALERT_EMAILS</code> as usual.
                    When set, the email is delivered <span className="text-white">only</span> to this address
                    and Slack / PagerDuty pages are skipped — useful for previewing the email on your own
                    inbox without paging the on-call team.
                  </p>
                </div>
                <DialogFooter>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setOpsTestConfirmOpen(false)}
                    disabled={sendOpsAlertTestMutation.isPending}
                    data-testid="button-ops-alert-test-cancel"
                  >
                    Cancel
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => {
                      const trimmed = opsTestOverrideEmail.trim();
                      sendOpsAlertTestMutation.mutate(
                        trimmed ? { overrideRecipient: trimmed } : {},
                      );
                    }}
                    disabled={sendOpsAlertTestMutation.isPending}
                    data-testid="button-ops-alert-test-confirm"
                  >
                    {sendOpsAlertTestMutation.isPending
                      ? <><Loader2 className="w-3 h-3 mr-1 animate-spin" />Sending…</>
                      : <><Mail className="w-3 h-3 mr-1" />
                          {opsTestOverrideEmail.trim() ? 'Send to override' : 'Send test email'}
                        </>}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>
        </div>
      )}

      {/* Plans Editor View */}
      {view === 'plans' && (
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <Settings className="w-5 h-5 text-primary" />
            <h2 className="text-lg font-semibold text-white">Plan Configuration</h2>
            <span className="text-xs text-muted-foreground ml-2">Changes apply immediately to all clubs on each tier.</span>
          </div>
          {plansLoading ? (
            <div className="flex justify-center py-16"><Loader2 className="w-6 h-6 animate-spin text-primary" /></div>
          ) : plansData ? (
            <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-4 gap-4">
              {plansData.map(plan => {
                const hasDraft = !!planDrafts[plan.tier];
                return (
                  <div key={plan.tier} className={`bg-card border rounded-xl p-5 space-y-4 ${hasDraft ? 'border-amber-500/40' : 'border-border'}`}>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className={`${plan.tier === 'free' ? 'text-muted-foreground' : plan.tier === 'starter' ? 'text-blue-400' : plan.tier === 'pro' ? 'text-primary' : 'text-purple-400'}`}>
                          {TIER_ICONS[plan.tier]}
                        </span>
                        <span className="font-semibold text-white capitalize">{plan.tier}</span>
                      </div>
                      {hasDraft && <span className="text-[10px] text-amber-400 border border-amber-500/30 rounded px-1.5 py-0.5">Unsaved</span>}
                    </div>

                    {/* Price */}
                    <div>
                      <label className="text-xs text-muted-foreground block mb-1">Monthly Price (INR)</label>
                      <Input
                        type="number"
                        value={String(getPlanDraftValue(plan.tier, 'priceMonthly', plan) ?? plan.priceMonthly)}
                        onChange={e => updatePlanDraft(plan.tier, 'priceMonthly', parseInt(e.target.value) || 0)}
                        className="bg-background border-border text-white text-sm h-8"
                      />
                    </div>

                    {/* Limits */}
                    <div className="space-y-2">
                      <label className="text-xs text-muted-foreground uppercase tracking-wider">Limits (blank = unlimited)</label>
                      {[
                        { key: 'maxActiveTournaments', label: 'Tournaments' },
                        { key: 'maxMembers', label: 'Members' },
                        { key: 'maxLeagues', label: 'Leagues' },
                      ].map(({ key, label }) => (
                        <div key={key}>
                          <label className="text-xs text-muted-foreground block mb-1">{label}</label>
                          <Input
                            type="number"
                            placeholder="Unlimited"
                            value={getPlanDraftValue(plan.tier, key, plan) === null ? '' : String(getPlanDraftValue(plan.tier, key, plan) ?? (plan as Record<string, unknown>)[key] ?? '')}
                            onChange={e => updatePlanDraft(plan.tier, key, e.target.value === '' ? null : parseInt(e.target.value))}
                            className="bg-background border-border text-white text-sm h-8"
                          />
                        </div>
                      ))}
                    </div>

                    {/* Feature Flags */}
                    <div className="space-y-2">
                      <label className="text-xs text-muted-foreground uppercase tracking-wider">Features</label>
                      {BOOLEAN_FEATURES.map(feat => {
                        const val = getPlanDraftValue(plan.tier, feat, plan) as boolean;
                        return (
                          <div key={feat} className="flex items-center justify-between">
                            <span className="text-xs text-muted-foreground">{FEATURE_LABELS[feat]}</span>
                            <button
                              onClick={() => updatePlanDraft(plan.tier, feat, !val)}
                              className={`w-9 h-5 rounded-full transition-colors flex items-center px-0.5 ${val ? 'bg-primary' : 'bg-muted'}`}
                            >
                              <span className={`w-4 h-4 rounded-full bg-white shadow transition-transform ${val ? 'translate-x-4' : 'translate-x-0'}`} />
                            </button>
                          </div>
                        );
                      })}
                    </div>

                    <Button
                      size="sm"
                      className="w-full bg-primary hover:bg-primary/90"
                      disabled={!hasDraft || savePlanMutation.isPending}
                      onClick={() => savePlanMutation.mutate({ tier: plan.tier, data: planDrafts[plan.tier] })}
                    >
                      {savePlanMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <><Save className="w-3 h-3 mr-1.5" />Save {plan.label}</>}
                    </Button>
                  </div>
                );
              })}
            </div>
          ) : null}
        </div>
      )}

      {/* Plan Migrations Audit View */}
      {view === 'plan-migrations' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div className="flex items-center gap-2">
              <History className="w-5 h-5 text-primary" />
              <h2 className="text-lg font-semibold text-white">Plan Migration Audit</h2>
              <span className="text-xs text-muted-foreground ml-2">
                Clubs that were auto-reset to Free because their stored plan slug wasn't recognised.
              </span>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked={includeAcknowledged}
                  onChange={e => setIncludeAcknowledged(e.target.checked)}
                  className="rounded border-border"
                />
                Show acknowledged
              </label>
              {/* Reviewer filter (Task #1314). Hidden when no reviewers
                  appear in the result set — typically because "Show
                  acknowledged" is off and nothing has been ack'd yet. */}
              {(reviewerOptions.length > 0 || reviewerFilter !== 'all') && (
                <Select
                  value={reviewerFilter === 'all' ? 'all' : String(reviewerFilter)}
                  onValueChange={v => setReviewerFilter(v === 'all' ? 'all' : Number(v))}
                >
                  <SelectTrigger
                    className="h-8 w-[200px] text-xs"
                    data-testid="select-reviewer-filter"
                    title="Filter by who acknowledged the row"
                  >
                    <SelectValue placeholder="Acknowledged by …" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All reviewers</SelectItem>
                    {reviewerOptions.map(opt => (
                      <SelectItem key={opt.id} value={String(opt.id)}>
                        {opt.name} — {opt.count}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              {/* Source segmented control (Task #1314). */}
              <div
                className="inline-flex rounded-md border border-border overflow-hidden"
                role="group"
                aria-label="Filter by acknowledgement source"
              >
                {(['any', 'email', 'dashboard'] as const).map(opt => (
                  <button
                    key={opt}
                    type="button"
                    onClick={() => setViaFilter(opt)}
                    data-testid={`button-via-${opt}`}
                    className={`px-2 py-1 text-xs capitalize transition-colors ${
                      viaFilter === opt
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-transparent text-muted-foreground hover:bg-white/5'
                    }`}
                    title={
                      opt === 'any'
                        ? 'Show rows acknowledged from any source'
                        : opt === 'email'
                          ? 'Only rows acknowledged via the digest email link'
                          : 'Only rows acknowledged from the dashboard'
                    }
                  >
                    {opt}
                  </button>
                ))}
              </div>
              {/* Sort segmented control (Task #1929). Default 'oldest' so
                  the grey → amber → red age cue from Task #1550 actually
                  drives triage order — admins open the panel and see the
                  reddest rows up top instead of being pushed down by a
                  freshly-written entry. */}
              <div
                className="inline-flex rounded-md border border-border overflow-hidden"
                role="group"
                aria-label="Sort order"
                title="Sort by age — 'Oldest' uses the same first-surfaced timestamp as the colour ramp"
              >
                {(['oldest', 'newest'] as const).map(opt => (
                  <button
                    key={opt}
                    type="button"
                    onClick={() => setSort(opt)}
                    data-testid={`button-sort-${opt}`}
                    className={`px-2 py-1 text-xs capitalize transition-colors ${
                      sort === opt
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-transparent text-muted-foreground hover:bg-white/5'
                    }`}
                    title={
                      opt === 'oldest'
                        ? 'Surface the oldest unacknowledged rows first so the red colour cue drives triage order'
                        : 'Show the most recent migrations first (legacy view)'
                    }
                  >
                    {opt} first
                  </button>
                ))}
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => queryClient.invalidateQueries({ queryKey: ['/api/super-admin/plan-migration-audit'] })}
                title="Refresh"
              >
                <RefreshCw className="w-4 h-4" />
              </Button>
            </div>
          </div>

          {planMigrationsLoading ? (
            <div className="flex justify-center py-16"><Loader2 className="w-6 h-6 animate-spin text-primary" /></div>
          ) : planMigrations && planMigrations.entries.length > 0 ? (
            <div className="bg-card border border-border rounded-xl overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border">
                    <th className="text-left px-4 py-3 text-muted-foreground font-medium">Club</th>
                    <th className="text-left px-4 py-3 text-muted-foreground font-medium">Plan Change</th>
                    <th className="text-left px-4 py-3 text-muted-foreground font-medium hidden md:table-cell">Current Tier</th>
                    <th className="text-left px-4 py-3 text-muted-foreground font-medium hidden lg:table-cell">When</th>
                    <th className="text-right px-4 py-3 text-muted-foreground font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {planMigrations.entries.map(entry => (
                    <tr key={entry.id} className={`border-b border-border/50 hover:bg-white/5 transition-colors ${entry.acknowledged ? 'opacity-60' : ''}`}>
                      <td className="px-4 py-3">
                        <div className="font-medium text-white">{entry.orgName ?? `Org #${entry.organizationId}`}</div>
                        {entry.orgSlug && (
                          <button
                            onClick={() => navigate(`/clubs/${entry.orgSlug}`)}
                            className="text-xs text-primary hover:underline"
                          >
                            /{entry.orgSlug}
                          </button>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2 text-xs flex-wrap">
                          <code className="px-1.5 py-0.5 rounded bg-muted text-muted-foreground border border-border">
                            {String(entry.fromTier ?? '—')}
                          </code>
                          <ArrowRight className="w-3 h-3 text-muted-foreground" />
                          <Badge className={`text-xs border ${TIER_BADGE[String(entry.toTier ?? 'free')]}`}>
                            <span className="flex items-center gap-1">
                              {TIER_ICONS[String(entry.toTier ?? 'free')]}
                              {String(entry.toTier ?? 'free')}
                            </span>
                          </Badge>
                          {/* Task #1906 — categorical trigger chip so super
                              admins can tell churn (Cancellation) from a
                              slug-mapping bug (Unknown tier) at a glance
                              without reading the free-text reason field. */}
                          {entry.triggerReason && (() => {
                            const trigger = PLAN_MIGRATION_TRIGGER_BADGE[entry.triggerReason];
                            return (
                              <Badge
                                variant="outline"
                                className={`text-[10px] h-5 px-1.5 border ${trigger.tone}`}
                                title={trigger.title}
                                data-testid={`trigger-reason-${entry.id}`}
                              >
                                {trigger.label}
                              </Badge>
                            );
                          })()}
                        </div>
                        {entry.reason && (
                          <p className="text-[11px] text-muted-foreground mt-1">{entry.reason}</p>
                        )}
                      </td>
                      <td className="px-4 py-3 hidden md:table-cell">
                        {entry.currentTier && (
                          <Badge className={`text-xs border ${TIER_BADGE[entry.currentTier]}`}>
                            <span className="flex items-center gap-1">
                              {TIER_ICONS[entry.currentTier]}
                              {entry.currentTier}
                            </span>
                          </Badge>
                        )}
                      </td>
                      <td className="px-4 py-3 hidden lg:table-cell text-xs text-muted-foreground">
                        <div>{new Date(entry.createdAt).toLocaleString()}</div>
                        {/* Task #1550 — show how long this row has been
                            unacknowledged since the first digest dispatch
                            (or since creation if it has never been digested).
                            Buckets / colour ramp match the daily digest
                            email so panel-triagers see the same priority
                            cue as inbox-triagers. Hidden on acknowledged
                            rows since the age is no longer actionable. */}
                        {!entry.acknowledged && (() => {
                          const surfaced = planMigrationFirstSurfaced(
                            entry.firstDigestedAt ?? entry.createdAt,
                          );
                          if (!surfaced) return null;
                          return (
                            <div
                              className={`mt-0.5 inline-flex items-center gap-1 ${surfaced.toneClass}`}
                              data-testid={`first-surfaced-${entry.id}`}
                              title={
                                entry.firstDigestedAt
                                  ? `First included in a super-admin digest at ${new Date(entry.firstDigestedAt).toLocaleString()}`
                                  : 'Not yet included in a digest — measured from when the row was created'
                              }
                            >
                              <Clock className="w-3 h-3" />
                              <span>{surfaced.label}</span>
                            </div>
                          );
                        })()}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {entry.acknowledged ? (
                          <div className="flex flex-col items-end gap-1 text-xs text-muted-foreground">
                            <span className="inline-flex items-center gap-1">
                              <Check className="w-3 h-3" />Reviewed
                              {entry.acknowledgedVia === 'email' ? (
                                <Badge
                                  variant="outline"
                                  className="ml-1 h-5 px-1.5 text-[10px] gap-1 border-blue-500/40 text-blue-300 bg-blue-500/10"
                                  title="Acknowledged from the one-click link in the digest email"
                                >
                                  <Mail className="w-3 h-3" />Email
                                </Badge>
                              ) : entry.acknowledgedVia === 'dashboard' ? (
                                <Badge
                                  variant="outline"
                                  className="ml-1 h-5 px-1.5 text-[10px] gap-1 border-border text-muted-foreground bg-muted/30"
                                  title="Acknowledged from inside the Plan Migration Audit panel"
                                >
                                  <MousePointerClick className="w-3 h-3" />Dashboard
                                </Badge>
                              ) : null}
                            </span>
                            {(entry.acknowledgedByName || entry.acknowledgedAt) && (
                              <span className="text-[11px]">
                                {entry.acknowledgedByName
                                  ? `by ${entry.acknowledgedByName}`
                                  : entry.acknowledgedByUserId
                                    ? `by user #${entry.acknowledgedByUserId}`
                                    : ''}
                                {entry.acknowledgedAt && (
                                  <> · {new Date(entry.acknowledgedAt).toLocaleString()}</>
                                )}
                              </span>
                            )}
                          </div>
                        ) : (() => {
                          const suggestion = mapToRecognisedTier(entry.fromTier, legacySlugMap);
                          const restoreTier = suggestion?.tier ?? null;
                          const isGuess = suggestion?.isGuess ?? false;
                          const isRestoring =
                            restoreMigrationMutation.isPending &&
                            restoreMigrationMutation.variables?.id === entry.id;
                          const isAcking =
                            acknowledgeMigrationMutation.isPending &&
                            acknowledgeMigrationMutation.variables === entry.id;
                          const sameAsCurrent = !!restoreTier && entry.currentTier === restoreTier;
                          const handleRestoreClick = () => {
                            if (!restoreTier) return;
                            if (isGuess) {
                              const ok = window.confirm(
                                `The original plan slug "${entry.fromTier}" isn't a standard tier. ` +
                                  `Best guess is "${restoreTier}". Restore this club to ${restoreTier}?`,
                              );
                              if (!ok) return;
                            }
                            restoreMigrationMutation.mutate({
                              id: entry.id,
                              orgId: entry.organizationId,
                              tier: restoreTier,
                            });
                          };
                          return (
                            <div className="flex items-center justify-end gap-2 flex-wrap">
                              {restoreTier && !sameAsCurrent && (
                                <Button
                                  size="sm"
                                  className={isGuess ? 'bg-amber-500 hover:bg-amber-500/90 text-black' : 'bg-primary hover:bg-primary/90'}
                                  disabled={isRestoring || isAcking}
                                  title={
                                    isGuess
                                      ? `Original slug "${entry.fromTier}" isn't a standard tier — ${restoreTier} is our best guess. You'll be asked to confirm before it's applied.`
                                      : `Set this club's plan back to ${restoreTier} and mark this row reviewed.`
                                  }
                                  onClick={handleRestoreClick}
                                >
                                  {isRestoring ? (
                                    <Loader2 className="w-3 h-3 animate-spin" />
                                  ) : (
                                    <>
                                      <Undo2 className="w-3 h-3 mr-1" />
                                      Restore to {restoreTier}{isGuess ? ' (best guess)' : ''}
                                    </>
                                  )}
                                </Button>
                              )}
                              {/* Task #1957 — open the same Re-run dialog
                                  used by the per-club detail sheet, but
                                  pre-seeded with this row's org id +
                                  current tier and tagged with the audit
                                  row id so submitting also acknowledges
                                  this row (mirrors how Restore behaves).
                                  This saves triagers the click into the
                                  per-club page just to fire a re-run. */}
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={isAcking || isRestoring}
                                data-testid={`button-row-re-migrate-${entry.id}`}
                                title="Re-run the plan migration helper for this club without leaving the audit list"
                                onClick={() => {
                                  const current = entry.currentTier
                                    && (RECOGNISED_TIERS as readonly string[]).includes(entry.currentTier)
                                    ? (entry.currentTier as RecognisedTier)
                                    : 'free';
                                  setReMigrateTier(current);
                                  setReMigrateReason('');
                                  setReMigrateContext({
                                    auditEntryId: entry.id,
                                    orgId: entry.organizationId,
                                    orgName: entry.orgName ?? `Org #${entry.organizationId}`,
                                    currentTier: entry.currentTier ?? 'free',
                                  });
                                  setShowReMigrate(true);
                                }}
                              >
                                <History className="w-3 h-3 mr-1" />Re-run migration…
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={isAcking || isRestoring}
                                onClick={() => acknowledgeMigrationMutation.mutate(entry.id)}
                              >
                                {isAcking ? (
                                  <Loader2 className="w-3 h-3 animate-spin" />
                                ) : (
                                  <><Check className="w-3 h-3 mr-1" />Acknowledge</>
                                )}
                              </Button>
                            </div>
                          );
                        })()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="px-4 py-3 border-t border-border text-xs text-muted-foreground">
                Showing {planMigrations.entries.length} of {planMigrations.total} entr{planMigrations.total !== 1 ? 'ies' : 'y'}
                {!includeAcknowledged && ' awaiting review'}
                {planMigrations.total > planMigrations.entries.length && ' — narrow with the filter to see older rows'}
              </div>
            </div>
          ) : (
            <div className="bg-card border border-border rounded-xl p-12 text-center">
              <CheckCircle className="w-10 h-10 text-green-400 mx-auto mb-3" />
              <p className="text-sm text-white font-medium">No plan migrations to review</p>
              <p className="text-xs text-muted-foreground mt-1">
                {reviewerFilter !== 'all' || viaFilter !== 'any'
                  ? 'No rows match the current filters — try clearing the reviewer or source filter.'
                  : includeAcknowledged
                    ? 'No legacy plan slug migrations have been recorded yet.'
                    : 'All recorded migrations have been acknowledged.'}
              </p>
            </div>
          )}

          {/* Editable legacy slug → tier mapping (Task #1131) */}
          <div className="bg-card border border-border rounded-xl p-4 space-y-4">
            <div className="flex items-center gap-2">
              <Sliders className="w-4 h-4 text-primary" />
              <h3 className="text-sm font-semibold text-white">Legacy plan slug suggestions</h3>
              <span className="text-xs text-muted-foreground">
                When an audit row's original plan slug isn't a standard tier, the panel suggests a restore tier from this list.
              </span>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-[1fr_160px_1fr_auto] gap-2 items-center">
              <Input
                placeholder="Legacy slug (e.g. premium_v3)"
                value={newSlug}
                onChange={e => setNewSlug(e.target.value)}
                className="bg-background border-border text-white"
              />
              <Select value={newSlugTier} onValueChange={(v) => setNewSlugTier(v as RecognisedTier)}>
                <SelectTrigger className="bg-background border-border text-white">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-card border-border text-white">
                  {RECOGNISED_TIERS.map(t => (
                    <SelectItem key={t} value={t}>{t}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                placeholder="Notes (optional)"
                value={newSlugNotes}
                onChange={e => setNewSlugNotes(e.target.value)}
                className="bg-background border-border text-white"
              />
              <Button
                size="sm"
                disabled={!newSlug.trim() || upsertSlugMutation.isPending}
                onClick={() => upsertSlugMutation.mutate({ slug: newSlug.trim().toLowerCase(), tier: newSlugTier, notes: newSlugNotes.trim() || undefined })}
              >
                {upsertSlugMutation.isPending
                  ? <Loader2 className="w-3 h-3 animate-spin" />
                  : <><Plus className="w-3 h-3 mr-1" />Add / update</>}
              </Button>
            </div>

            {legacySlugMappingsError ? (
              <div className="flex items-center gap-2 text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded-md p-2">
                <AlertCircle className="w-4 h-4" />
                <span>{legacySlugMappingsError.message}</span>
              </div>
            ) : null}

            {legacySlugMappingsLoading ? (
              <div className="flex justify-center py-6"><Loader2 className="w-5 h-5 animate-spin text-primary" /></div>
            ) : legacySlugMappings.length === 0 ? (
              <p className="text-xs text-muted-foreground">No mappings yet — non-standard slugs won't get a suggestion.</p>
            ) : (
              <div className="overflow-hidden border border-border rounded-lg">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border bg-muted/30">
                      <th className="text-left px-3 py-2 text-muted-foreground font-medium">Slug</th>
                      <th className="text-left px-3 py-2 text-muted-foreground font-medium">Suggested tier</th>
                      <th className="text-left px-3 py-2 text-muted-foreground font-medium hidden md:table-cell">Notes</th>
                      <th className="text-left px-3 py-2 text-muted-foreground font-medium hidden lg:table-cell">Last edited by</th>
                      <th className="text-left px-3 py-2 text-muted-foreground font-medium hidden lg:table-cell">Updated</th>
                      <th className="text-right px-3 py-2 text-muted-foreground font-medium">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {legacySlugMappings.map(m => {
                      const isSavingThis = upsertSlugMutation.isPending && upsertSlugMutation.variables?.slug === m.slug;
                      const isDeletingThis = deleteSlugMutation.isPending && deleteSlugMutation.variables === m.slug;
                      // Task #1299 — surface the audit trail. The "Last edited by"
                      // column shows who most recently saved the row (or "Seeded
                      // default" when no user is recorded), and the row's hover
                      // title also reveals the original creator so support staff
                      // can trace handovers without opening the database.
                      const editorLabel = legacySlugEditorLabel(
                        m.updatedByDisplayName,
                        m.updatedByUsername,
                        m.updatedByEmail,
                      );
                      const creatorLabel = legacySlugEditorLabel(
                        m.createdByDisplayName,
                        m.createdByUsername,
                        m.createdByEmail,
                      );
                      const updatedAtLocal = new Date(m.updatedAt).toLocaleString();
                      const createdAtLocal = new Date(m.createdAt).toLocaleString();
                      const hoverTitle = [
                        creatorLabel
                          ? `Created by ${creatorLabel} on ${createdAtLocal}`
                          : `Created (seeded default) on ${createdAtLocal}`,
                        editorLabel
                          ? `Last edited by ${editorLabel} on ${updatedAtLocal}`
                          : `Last edited (seeded default) on ${updatedAtLocal}`,
                      ].join('\n');
                      return (
                        <tr
                          key={m.slug}
                          className="border-b border-border/50 hover:bg-white/5"
                          title={hoverTitle}
                        >
                          <td className="px-3 py-2">
                            <code className="px-1.5 py-0.5 rounded bg-muted text-muted-foreground border border-border text-xs">
                              {m.slug}
                            </code>
                          </td>
                          <td className="px-3 py-2">
                            <Select
                              value={m.tier}
                              onValueChange={(v) => upsertSlugMutation.mutate({ slug: m.slug, tier: v as RecognisedTier, notes: m.notes ?? undefined })}
                            >
                              <SelectTrigger className="w-32 bg-background border-border text-white h-8 text-xs">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent className="bg-card border-border text-white">
                                {RECOGNISED_TIERS.map(t => (
                                  <SelectItem key={t} value={t}>{t}</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </td>
                          <td className="px-3 py-2 hidden md:table-cell text-xs text-muted-foreground">
                            {m.notes ?? '—'}
                          </td>
                          <td
                            className="px-3 py-2 hidden lg:table-cell text-xs text-muted-foreground"
                            title={
                              creatorLabel
                                ? `Originally created by ${creatorLabel} on ${createdAtLocal}`
                                : `Originally seeded as a default on ${createdAtLocal}`
                            }
                          >
                            {editorLabel ?? <span className="italic">Seeded default</span>}
                          </td>
                          <td className="px-3 py-2 hidden lg:table-cell text-xs text-muted-foreground">
                            {new Date(m.updatedAt).toLocaleDateString()}
                          </td>
                          <td className="px-3 py-2 text-right">
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={isDeletingThis || isSavingThis}
                              onClick={() => {
                                if (window.confirm(`Remove the suggestion for "${m.slug}"?`)) {
                                  deleteSlugMutation.mutate(m.slug);
                                }
                              }}
                              title="Remove this mapping"
                            >
                              {isDeletingThis ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
                            </Button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Clubs List View */}
      {view === 'clubs' && (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-3">
            <div className="relative flex-1 min-w-48">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search clubs..."
                className="pl-9 bg-background border-border text-white"
                data-testid="input-clubs-search"
              />
            </div>
            <Select value={tierFilter} onValueChange={setTierFilter}>
              <SelectTrigger className="w-36 bg-background border-border text-white" data-testid="select-clubs-tier">
                <Filter className="w-3 h-3 mr-1" />
                <SelectValue placeholder="All tiers" />
              </SelectTrigger>
              <SelectContent className="bg-card border-border text-white">
                <SelectItem value="all">All tiers</SelectItem>
                <SelectItem value="free">Free</SelectItem>
                <SelectItem value="starter">Starter</SelectItem>
                <SelectItem value="pro">Pro</SelectItem>
                <SelectItem value="enterprise">Enterprise</SelectItem>
              </SelectContent>
            </Select>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-36 bg-background border-border text-white" data-testid="select-clubs-status">
                <SelectValue placeholder="All status" />
              </SelectTrigger>
              <SelectContent className="bg-card border-border text-white">
                <SelectItem value="all">All status</SelectItem>
                <SelectItem value="active">Active</SelectItem>
                <SelectItem value="suspended">Suspended</SelectItem>
              </SelectContent>
            </Select>
            <Button variant="outline" size="sm" onClick={() => refetchClubs()} title="Refresh">
              <RefreshCw className="w-4 h-4" />
            </Button>
          </div>

          {clubsLoading ? (
            <div className="flex justify-center py-16"><Loader2 className="w-6 h-6 animate-spin text-primary" /></div>
          ) : (
            <div className="bg-card border border-border rounded-xl overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border">
                    <th className="text-left px-4 py-3 text-muted-foreground font-medium">Club</th>
                    <th className="text-left px-4 py-3 text-muted-foreground font-medium">Plan</th>
                    <th className="text-center px-4 py-3 text-muted-foreground font-medium hidden md:table-cell">Members</th>
                    <th className="text-center px-4 py-3 text-muted-foreground font-medium hidden lg:table-cell">Tournaments</th>
                    <th className="text-center px-4 py-3 text-muted-foreground font-medium">Status</th>
                    <th className="text-right px-4 py-3 text-muted-foreground font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {clubsData?.clubs?.map((club) => (
                    <tr key={club.id} className="border-b border-border/50 hover:bg-white/5 transition-colors">
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-3">
                          {club.logoUrl ? (
                            <img src={club.logoUrl} alt="" className="w-8 h-8 rounded-lg object-contain bg-white/10 p-0.5" />
                          ) : (
                            <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
                              <Building2 className="w-4 h-4 text-primary" />
                            </div>
                          )}
                          <div>
                            <div className="font-medium text-white">{club.name}</div>
                            <div className="text-xs text-muted-foreground">{club.slug}</div>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <Badge className={`text-xs border ${TIER_BADGE[club.subscriptionTier]}`}>
                          <span className="flex items-center gap-1">
                            {TIER_ICONS[club.subscriptionTier]}
                            {club.subscriptionTier}
                          </span>
                        </Badge>
                      </td>
                      <td className="px-4 py-3 text-center hidden md:table-cell text-muted-foreground">{club.memberCount}</td>
                      <td className="px-4 py-3 text-center hidden lg:table-cell text-muted-foreground">
                        {club.activeTournaments > 0 ? (
                          <span className="text-primary font-medium">{club.activeTournaments}</span>
                        ) : club.tournamentCount}
                      </td>
                      <td className="px-4 py-3 text-center">
                        {club.isActive ? (
                          <span className="inline-flex items-center gap-1 text-xs text-green-400">
                            <CheckCircle className="w-3 h-3" />Active
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-xs text-red-400">
                            <Ban className="w-3 h-3" />Suspended
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => { setSelectedClub(club); setNewTier(club.subscriptionTier); setShowOverrides(false); setOverrideForm({}); }}
                          className="text-muted-foreground hover:text-white"
                        >
                          <ChevronRight className="w-4 h-4" />
                        </Button>
                      </td>
                    </tr>
                  ))}
                  {(!clubsData?.clubs?.length) && (
                    <tr>
                      <td colSpan={6} className="text-center py-12 text-muted-foreground">No clubs found</td>
                    </tr>
                  )}
                </tbody>
              </table>
              {clubsData?.total !== undefined && (
                <div className="px-4 py-3 border-t border-border text-xs text-muted-foreground">
                  {clubsData.total} club{clubsData.total !== 1 ? 's' : ''} total
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Create Club View */}
      {view === 'create-club' && (
        <div className="max-w-lg">
          <div className="bg-card border border-border rounded-xl p-6 space-y-4">
            <div>
              <h2 className="text-lg font-bold text-white mb-1">Create Club</h2>
              <p className="text-sm text-muted-foreground">Manually onboard an enterprise client.</p>
            </div>
            <div>
              <label className="block text-sm text-muted-foreground mb-1.5">Club Name *</label>
              <Input
                value={createForm.name}
                onChange={e => setCreateForm(p => ({ ...p, name: e.target.value, slug: p.slug || e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '-') }))}
                placeholder="e.g. Delhi Golf Club"
                className="bg-background border-border text-white"
              />
            </div>
            <div>
              <label className="block text-sm text-muted-foreground mb-1.5">URL Slug *</label>
              <Input
                value={createForm.slug}
                onChange={e => setCreateForm(p => ({ ...p, slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-') }))}
                placeholder="delhi-golf-club"
                className="bg-background border-border text-white"
              />
            </div>
            <div>
              <label className="block text-sm text-muted-foreground mb-1.5">Contact Email</label>
              <Input
                type="email"
                value={createForm.contactEmail}
                onChange={e => setCreateForm(p => ({ ...p, contactEmail: e.target.value }))}
                placeholder="admin@club.com"
                className="bg-background border-border text-white"
              />
            </div>
            <div>
              <label className="block text-sm text-muted-foreground mb-1.5">Subscription Tier</label>
              <Select value={createForm.subscriptionTier} onValueChange={v => setCreateForm(p => ({ ...p, subscriptionTier: v }))}>
                <SelectTrigger className="bg-background border-border text-white">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-card border-border text-white">
                  <SelectItem value="free">Free</SelectItem>
                  <SelectItem value="starter">Starter</SelectItem>
                  <SelectItem value="pro">Pro</SelectItem>
                  <SelectItem value="enterprise">Enterprise</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex gap-3 pt-2">
              <Button variant="outline" onClick={() => setView('clubs')} className="flex-1">Cancel</Button>
              <Button
                onClick={() => createClubMutation.mutate(createForm)}
                disabled={!createForm.name || !createForm.slug || createClubMutation.isPending}
                className="flex-1 bg-primary hover:bg-primary/90"
              >
                {createClubMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Create Club'}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Club Detail Sheet */}
      {selectedClub && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onClick={() => { setSelectedClub(null); setShowTierChange(false); setShowOverrides(false); setShowReMigrate(false); }}>
          <div className="bg-card border border-border rounded-2xl p-6 w-full max-w-md shadow-2xl max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-5">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
                  <Building2 className="w-5 h-5 text-primary" />
                </div>
                <div>
                  <h3 className="font-bold text-white">{selectedClub.name}</h3>
                  <p className="text-xs text-muted-foreground">{selectedClub.slug}</p>
                </div>
              </div>
              <button onClick={() => { setSelectedClub(null); setShowTierChange(false); setShowOverrides(false); setShowReMigrate(false); }} className="text-muted-foreground hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="grid grid-cols-3 gap-3 mb-5">
              <div className="bg-background rounded-lg p-3 text-center">
                <div className="text-lg font-bold text-white">{selectedClub.memberCount}</div>
                <div className="text-xs text-muted-foreground">Members</div>
              </div>
              <div className="bg-background rounded-lg p-3 text-center">
                <div className="text-lg font-bold text-white">{selectedClub.tournamentCount}</div>
                <div className="text-xs text-muted-foreground">Tournaments</div>
              </div>
              <div className="bg-background rounded-lg p-3 text-center">
                <div className="text-lg font-bold text-white">{selectedClub.activeTournaments}</div>
                <div className="text-xs text-muted-foreground">Active</div>
              </div>
            </div>

            {/* Plan row */}
            <div className="flex items-center justify-between py-3 border-t border-border">
              <span className="text-sm text-muted-foreground">Plan</span>
              <div className="flex items-center gap-2">
                <Badge className={`border ${TIER_BADGE[selectedClub.subscriptionTier]}`}>
                  {TIER_ICONS[selectedClub.subscriptionTier]} <span className="ml-1 capitalize">{selectedClub.subscriptionTier}</span>
                </Badge>
                <Button size="sm" variant="ghost" onClick={() => setShowTierChange(!showTierChange)}>
                  <Edit className="w-3 h-3" />
                </Button>
              </div>
            </div>

            {showTierChange && (
              <div className="py-3 border-b border-border space-y-2">
                <Select value={newTier} onValueChange={setNewTier}>
                  <SelectTrigger className="bg-background border-border text-white">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="bg-card border-border text-white">
                    <SelectItem value="free">Free</SelectItem>
                    <SelectItem value="starter">Starter</SelectItem>
                    <SelectItem value="pro">Pro</SelectItem>
                    <SelectItem value="enterprise">Enterprise</SelectItem>
                  </SelectContent>
                </Select>
                <Button
                  size="sm"
                  className="w-full bg-primary hover:bg-primary/90"
                  disabled={newTier === selectedClub.subscriptionTier || changeTierMutation.isPending}
                  onClick={() => changeTierMutation.mutate({ orgId: selectedClub.id, tier: newTier })}
                >
                  {changeTierMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Save Tier Change'}
                </Button>
              </div>
            )}

            {/* Status row */}
            <div className="flex items-center justify-between py-3 border-t border-border">
              <span className="text-sm text-muted-foreground">Status</span>
              <span className={`text-sm font-medium ${selectedClub.isActive ? 'text-green-400' : 'text-red-400'}`}>
                {selectedClub.isActive ? '● Active' : '● Suspended'}
              </span>
            </div>

            {/* Custom Overrides toggle */}
            <div className="border-t border-border mt-2">
              <button
                onClick={() => setShowOverrides(o => !o)}
                className="w-full flex items-center justify-between py-3 text-sm text-muted-foreground hover:text-white transition-colors"
              >
                <span className="flex items-center gap-2">
                  <Sliders className="w-4 h-4" /> Custom Overrides
                </span>
                <ChevronRight className={`w-4 h-4 transition-transform ${showOverrides ? 'rotate-90' : ''}`} />
              </button>

              {showOverrides && (
                <div className="pb-4 space-y-4">
                  {overrideLoading ? (
                    <div className="flex justify-center py-4"><Loader2 className="w-5 h-5 animate-spin text-primary" /></div>
                  ) : (
                    <>
                      {(() => {
                        // Expiry check: overrides are only "active" when non-expired
                        const overrideIsExpired = overrideData?.override?.overrideExpiresAt
                          ? new Date(overrideData.override.overrideExpiresAt) < new Date()
                          : false;
                        const hasActiveOverride = !!overrideData?.override && !overrideIsExpired;

                        return (
                          <>
                            {overrideData?.override && (
                              <div className={`border rounded-lg p-3 text-xs flex items-center gap-2 ${overrideIsExpired ? 'bg-muted/20 border-border text-muted-foreground' : 'bg-amber-500/10 border-amber-500/30 text-amber-400'}`}>
                                <Sliders className="w-3 h-3 flex-shrink-0" />
                                {overrideIsExpired ? 'Overrides exist but have expired — fields show previous values.' : 'Active overrides — this club has customised plan settings.'}
                                {overrideData.override.overrideExpiresAt && (
                                  <span className="ml-auto">
                                    {overrideIsExpired ? 'Expired: ' : 'Expires: '}
                                    {new Date(overrideData.override.overrideExpiresAt).toLocaleDateString()}
                                  </span>
                                )}
                              </div>
                            )}

                            <p className="text-xs text-muted-foreground">Leave blank to use tier default. Amber = active (non-expired) override.</p>

                            {/* Limit overrides */}
                            <div className="space-y-2">
                              <p className="text-xs text-muted-foreground uppercase tracking-wider font-medium">Limits</p>
                              {[
                                { key: 'overrideMaxTournaments', label: 'Max Tournaments', tierKey: 'maxActiveTournaments' },
                                { key: 'overrideMaxMembers', label: 'Max Members', tierKey: 'maxMembers' },
                                { key: 'overrideMaxLeagues', label: 'Max Leagues', tierKey: 'maxLeagues' },
                              ].map(({ key, label, tierKey }) => {
                                const fieldHasValue = overrideData?.override && (overrideData.override as Record<string, unknown>)[key] !== null && (overrideData.override as Record<string, unknown>)[key] !== undefined;
                                const isOverridden = hasActiveOverride && !!fieldHasValue;
                                const currentOverride = (overrideData?.override as Record<string, unknown> | null)?.[key];
                                const tierDefault = overrideData?.tierDefaults ? (overrideData.tierDefaults as Record<string, unknown>)[tierKey] : null;
                                return (
                                  <div key={key} className={`rounded-lg p-2 ${isOverridden ? 'bg-amber-500/10 border border-amber-500/20' : 'bg-background'}`}>
                                    <label className="text-xs text-muted-foreground block mb-1">
                                      {label} <span className="text-muted-foreground/60">(tier default: {tierDefault ?? 'Unlimited'})</span>
                                    </label>
                                    <Input
                                      type="number"
                                      placeholder="Use tier default"
                                      value={(key in overrideForm ? overrideForm[key] : currentOverride) !== null && (key in overrideForm ? overrideForm[key] : currentOverride) !== undefined ? String(key in overrideForm ? overrideForm[key] : currentOverride) : ''}
                                      onChange={e => setOverrideForm(f => ({ ...f, [key]: e.target.value === '' ? null : parseInt(e.target.value) }))}
                                      className="bg-background border-border text-white text-xs h-7"
                                    />
                                  </div>
                                );
                              })}
                            </div>

                            {/* Feature overrides */}
                            <div className="space-y-2">
                              <p className="text-xs text-muted-foreground uppercase tracking-wider font-medium">Feature Flags</p>
                              {BOOLEAN_FEATURES.map(feat => {
                                const overrideKey = `override${feat.charAt(0).toUpperCase()}${feat.slice(1)}`;
                                const fieldHasValue = overrideData?.override && (overrideData.override as Record<string, unknown>)[overrideKey] !== null && (overrideData.override as Record<string, unknown>)[overrideKey] !== undefined;
                                const isOverridden = hasActiveOverride && !!fieldHasValue;
                                const overrideVal = (overrideData?.override as Record<string, unknown> | null)?.[overrideKey];
                                const tierVal = overrideData?.tierDefaults ? (overrideData.tierDefaults as Record<string, unknown>)[feat] : null;
                                const formVal = overrideKey in overrideForm ? overrideForm[overrideKey] : undefined;
                                const displayVal = formVal !== undefined ? formVal : (isOverridden ? overrideVal : null);
                          return (
                            <div key={feat} className={`flex items-center justify-between rounded-lg p-2 ${isOverridden ? 'bg-amber-500/10 border border-amber-500/20' : 'bg-background'}`}>
                              <div>
                                <span className="text-xs text-white">{FEATURE_LABELS[feat]}</span>
                                <span className="text-[10px] text-muted-foreground ml-2">tier: {tierVal ? '✓' : '✗'}</span>
                              </div>
                              <div className="flex items-center gap-1">
                                {displayVal !== null && displayVal !== undefined && (
                                  <button
                                    className="text-[10px] text-amber-400 mr-1"
                                    onClick={() => setOverrideForm(f => { const n = { ...f }; delete n[overrideKey]; n[overrideKey] = null; return n; })}
                                    title="Clear override"
                                  >
                                    Clear
                                  </button>
                                )}
                                <Select
                                  value={displayVal === null || displayVal === undefined ? 'default' : String(displayVal)}
                                  onValueChange={v => setOverrideForm(f => ({ ...f, [overrideKey]: v === 'default' ? null : v === 'true' }))}
                                >
                                  <SelectTrigger className="w-24 h-7 text-[11px] bg-background border-border text-white">
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent className="bg-card border-border text-white text-xs">
                                    <SelectItem value="default">Default</SelectItem>
                                    <SelectItem value="true">Enabled</SelectItem>
                                    <SelectItem value="false">Disabled</SelectItem>
                                  </SelectContent>
                                </Select>
                              </div>
                            </div>
                          );
                        })}
                            </div>

                            {/* Reason + expiry */}
                            <div className="space-y-2">
                              <div>
                                <label className="text-xs text-muted-foreground block mb-1">Reason / Note</label>
                                <Input
                                  placeholder="e.g. Trial for enterprise negotiation"
                                  value={String(overrideForm.overrideReason ?? overrideData?.override?.overrideReason ?? '')}
                                  onChange={e => setOverrideForm(f => ({ ...f, overrideReason: e.target.value }))}
                                  className="bg-background border-border text-white text-xs h-7"
                                />
                              </div>
                              <div>
                                <label className="text-xs text-muted-foreground block mb-1">Expiry Date (optional)</label>
                                <Input
                                  type="date"
                                  value={String(overrideForm.overrideExpiresAt ?? (overrideData?.override?.overrideExpiresAt ? overrideData.override.overrideExpiresAt.slice(0, 10) : '') ?? '')}
                                  onChange={e => setOverrideForm(f => ({ ...f, overrideExpiresAt: e.target.value || null }))}
                                  className="bg-background border-border text-white text-xs h-7"
                                />
                              </div>
                            </div>

                            <div className="flex gap-2">
                              <Button
                                size="sm"
                                className="flex-1 bg-primary hover:bg-primary/90"
                                disabled={saveOverrideMutation.isPending}
                                onClick={() => saveOverrideMutation.mutate({ orgId: selectedClub.id, data: overrideForm as Record<string, unknown> })}
                              >
                                {saveOverrideMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Save Overrides'}
                              </Button>
                              {overrideData?.override && (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="text-red-400 border-red-500/30 hover:bg-red-500/10"
                                  disabled={clearOverrideMutation.isPending}
                                  onClick={() => clearOverrideMutation.mutate(selectedClub.id)}
                                >
                                  {clearOverrideMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Clear All'}
                                </Button>
                              )}
                            </div>
                          </>
                        );
                      })()}
                    </>
                  )}
                </div>
              )}
            </div>

            {/* Task #1575 — open the "Re-run plan migration" dialog. Pre-seed
                the target tier with the club's current tier so the most common
                case (re-applying the same tier to re-fire the alert) is one
                click. The reason field is reset on every open. */}
            <div className="mt-4">
              <Button
                variant="outline"
                size="sm"
                className="w-full"
                data-testid="button-open-re-migrate"
                onClick={() => {
                  const current = (RECOGNISED_TIERS as readonly string[]).includes(selectedClub.subscriptionTier)
                    ? (selectedClub.subscriptionTier as RecognisedTier)
                    : 'free';
                  setReMigrateTier(current);
                  setReMigrateReason('');
                  // Task #1957 — opened from the per-club detail sheet, so
                  // the dialog operates on the selected club and there is
                  // no source audit row to acknowledge on submit.
                  setReMigrateContext({
                    auditEntryId: null,
                    orgId: selectedClub.id,
                    orgName: selectedClub.name,
                    currentTier: selectedClub.subscriptionTier,
                  });
                  // Task #1956 — clear any leftover downgrade-confirm flag
                  // so a fresh open always starts on the one-click path.
                  setConfirmingDowngrade(false);
                  setShowReMigrate(true);
                }}
                title="Re-run the plan migration helper (writes an audit row and notifies super admins)"
              >
                <History className="w-4 h-4 mr-1.5" /> Re-run plan migration…
              </Button>
            </div>

            <div className="flex gap-2 mt-4">
              <Button
                variant="outline"
                size="sm"
                className="flex-1"
                onClick={() => { window.open(`/clubs/${selectedClub.slug}`, '_blank'); }}
              >
                <Globe className="w-4 h-4 mr-1.5" /> View Page
              </Button>
              <Button
                size="sm"
                variant={selectedClub.isActive ? 'destructive' : 'outline'}
                className="flex-1"
                disabled={suspendMutation.isPending}
                onClick={() => suspendMutation.mutate({ orgId: selectedClub.id, suspend: selectedClub.isActive })}
              >
                {suspendMutation.isPending ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : selectedClub.isActive ? (
                  <><Ban className="w-4 h-4 mr-1.5" />Suspend</>
                ) : (
                  <><CheckCircle className="w-4 h-4 mr-1.5" />Unsuspend</>
                )}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Task #1575 — Re-run plan migration dialog. Lives outside the detail
          sheet so it stays mounted while the click-outside handler closes the
          sheet's backdrop wouldn't capture the dialog's clicks anyway.
          Task #1957 — driven by `reMigrateContext` rather than `selectedClub`
          so the same dialog can be opened from either the per-club detail
          sheet or a row in the Plan Migration Audit panel. When opened from
          a row, `auditEntryId` is set and submitting also acknowledges that
          source row. */}
      <Dialog
        open={showReMigrate && !!reMigrateContext}
        onOpenChange={open => {
          if (!open) {
            setShowReMigrate(false);
            setReMigrateContext(null);
          }
        }}
      >
        <DialogContent data-testid="dialog-re-migrate" onClick={e => e.stopPropagation()}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-white">
              <History className="w-5 h-5 text-primary" />
              Re-run plan migration
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {reMigrateContext ? (
                <>
                  Force-apply a tier to <span className="text-white">{reMigrateContext.orgName}</span> and
                  notify all super admins. Use this when a club's tier has drifted or to re-fire the
                  alert after a mapping fix. This writes a Plan Migration audit row.
                  {reMigrateContext.auditEntryId != null && (
                    <>
                      {' '}
                      <span
                        className="text-amber-300"
                        data-testid="text-re-migrate-from-audit-row"
                      >
                        Submitting will also acknowledge the audit row this was opened from.
                      </span>
                    </>
                  )}
                </>
              ) : null}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div>
              <label className="text-xs text-muted-foreground block mb-1">Target tier</label>
              <Select
                value={reMigrateTier}
                onValueChange={v => {
                  setReMigrateTier(v as RecognisedTier);
                  // Task #1956 — picking a different tier resets the
                  // confirm step so flipping back to an upgrade or
                  // same-tier selection submits on the first click.
                  setConfirmingDowngrade(false);
                }}
              >
                <SelectTrigger className="bg-background border-border text-white" data-testid="select-re-migrate-tier">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-card border-border text-white">
                  {RECOGNISED_TIERS.map(t => (
                    <SelectItem key={t} value={t} className="capitalize">{t}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {reMigrateContext && (
                <p className="text-[11px] text-muted-foreground mt-1">
                  Currently on <span className="capitalize text-white">{reMigrateContext.currentTier}</span>.
                </p>
              )}
            </div>

            {/* Task #1956 — inline warning whenever the chosen target tier
                is strictly below the club's current tier. The first submit
                click flips the button into a "Yes, downgrade" confirm; this
                banner stays up so the operator always sees the from→to
                framing. Same-tier and upgrade selections render nothing.
                Driven by `reMigrateContext` so the gate fires whether the
                dialog was opened from the per-club detail sheet or from a
                row in the Plan Migration Audit panel (Task #1957). */}
            {reMigrateContext && (() => {
              const currentTier = (RECOGNISED_TIERS as readonly string[]).includes(reMigrateContext.currentTier)
                ? (reMigrateContext.currentTier as RecognisedTier)
                : null;
              const currentRank = currentTier ? RECOGNISED_TIERS.indexOf(currentTier) : -1;
              const targetRank = RECOGNISED_TIERS.indexOf(reMigrateTier);
              const isDowngrade = currentRank >= 0 && targetRank >= 0 && targetRank < currentRank;
              if (!isDowngrade || !currentTier) return null;
              return (
                <div
                  className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-100"
                  data-testid="warning-re-migrate-downgrade"
                >
                  <AlertCircle className="w-4 h-4 mt-0.5 shrink-0 text-amber-300" />
                  <div className="space-y-1">
                    <p className="font-medium text-amber-100">
                      You're about to downgrade {reMigrateContext.orgName} from{' '}
                      <span className="capitalize">{currentTier}</span> to{' '}
                      <span className="capitalize">{reMigrateTier}</span>.
                    </p>
                    <p className="text-amber-100/80">
                      This persists immediately and pages every super admin. If you didn't mean to drop the tier,
                      pick a higher one above or cancel — otherwise click "Yes, downgrade" to confirm.
                    </p>
                  </div>
                </div>
              );
            })()}

            <div>
              <label className="text-xs text-muted-foreground block mb-1">
                Reason <span className="text-muted-foreground/60">(optional — included in the audit row and the alert email)</span>
              </label>
              <Textarea
                placeholder="e.g. Drifted from Stripe — manual reset"
                value={reMigrateReason}
                onChange={e => setReMigrateReason(e.target.value)}
                rows={3}
                className="bg-background border-border text-white text-sm"
                data-testid="textarea-re-migrate-reason"
              />
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setShowReMigrate(false);
                setReMigrateContext(null);
              }}
              disabled={reMigrateMutation.isPending}
            >
              Cancel
            </Button>
            {(() => {
              // Task #1956 — derive isDowngrade once for the submit button
              // so the label, variant, and click handler stay in sync with
              // the inline warning banner above. Same-tier and upgrade
              // paths submit on the first click as before; downgrades need
              // a second "Yes, downgrade" click. Source of truth is the
              // open dialog's `reMigrateContext` (Task #1957) so the gate
              // works whether the dialog was opened from the per-club
              // detail sheet or a Plan Migration Audit row.
              const currentTier = reMigrateContext
                && (RECOGNISED_TIERS as readonly string[]).includes(reMigrateContext.currentTier)
                ? (reMigrateContext.currentTier as RecognisedTier)
                : null;
              const currentRank = currentTier ? RECOGNISED_TIERS.indexOf(currentTier) : -1;
              const targetRank = RECOGNISED_TIERS.indexOf(reMigrateTier);
              const isDowngrade = currentRank >= 0 && targetRank >= 0 && targetRank < currentRank;
              const needsConfirm = isDowngrade && !confirmingDowngrade;
              return (
                <Button
                  size="sm"
                  className={
                    isDowngrade && confirmingDowngrade
                      ? 'bg-red-600 hover:bg-red-600/90 text-white'
                      : 'bg-primary hover:bg-primary/90'
                  }
                  data-testid="button-submit-re-migrate"
                  disabled={!reMigrateContext || reMigrateMutation.isPending}
                  onClick={() => {
                    if (!reMigrateContext) return;
                    if (needsConfirm) {
                      setConfirmingDowngrade(true);
                      return;
                    }
                    reMigrateMutation.mutate({
                      orgId: reMigrateContext.orgId,
                      targetTier: reMigrateTier,
                      reason: reMigrateReason,
                      auditEntryId: reMigrateContext.auditEntryId,
                    });
                  }}
                >
                  {reMigrateMutation.isPending ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : isDowngrade && confirmingDowngrade ? (
                    <>Yes, downgrade</>
                  ) : (
                    <>Re-run migration</>
                  )}
                </Button>
              );
            })()}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
