import { useEffect, useState } from 'react';
import {
  Mail, Plus, Send, Calendar, BarChart2, Users, Trash2, Pencil, ChevronRight,
  Play, Clock, CheckCircle2, X, AlertCircle, Repeat, FileText, Eye, Settings,
  Tag, Megaphone, Target, MailCheck, RotateCcw, AlertTriangle, Flag,
} from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';
import { useGetMe } from '@workspace/api-client-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';

const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');
function apiUrl(path: string) { return `${BASE}/api${path}`; }

type Tab = 'campaigns' | 'segments' | 'drip' | 'templates' | 'suppressions';
type CampaignStatus = 'draft' | 'scheduled' | 'sending' | 'sent' | 'cancelled' | 'paused';

interface Campaign {
  id: number;
  name: string;
  subject: string | null;
  subjectVariantB: string | null;
  previewText: string | null;
  bodyHtml: string;
  bodyText: string | null;
  channels: string[];
  status: CampaignStatus;
  type: string;
  scheduledAt: string | null;
  sentAt: string | null;
  segmentId: number | null;
  dripSeriesId: number | null;
  // Task #1555 — id of the saved template the campaign was built from
  // (null when the body was authored from scratch). Forwarded as
  // `Metadata.templateId` on every dispatch so bounces can be
  // attributed back to the template, not just the campaign.
  templateId: number | null;
  totalSent: number;
  totalOpened: number;
  totalClicked: number;
  totalUnsubscribed: number;
  createdAt: string;
}

interface Segment {
  id: number;
  name: string;
  description: string | null;
  rules: Array<{ field: string; operator: string; value: string }>;
  estimatedCount: number;
}

interface DripSeries {
  id: number;
  name: string;
  description: string | null;
  trigger: string;
  isActive: boolean;
  steps: Campaign[];
}

interface Template {
  id: number;
  name: string;
  category: string;
  bodyHtml: string;
  isGlobal: boolean;
}

interface Suppression {
  id: number;
  email: string;
  reason: string;
  bounceType: string | null;
  messageId: string | null;
  description: string | null;
  // Task #1310 — origin of the bouncing send. The campaign id (and
  // joined campaign name) are populated for marketing campaign sends;
  // the flow tag is populated for transactional flows like
  // "dues_receipt" or "password_reset". Both null for legacy /
  // manually-added suppressions.
  triggeredByCampaignId: number | null;
  triggeredByCampaignName: string | null;
  triggeredByFlow: string | null;
  // Task #1555 — id of the saved template that produced the bouncing
  // send (when known). The joined name is populated by the API's
  // org-or-global left-join — null for legacy rows, or for campaigns
  // authored without a saved template. Click-through opens the
  // template editor so admins can fix the typo at source.
  triggeredByTemplateId: number | null;
  triggeredByTemplateName: string | null;
  createdAt: string;
  // Task #1548 — populated when this suppression follows a re-enable
  // attempt within the last 14 days. Lets the UI flag "Re-bounced
  // after re-enable" so admins know the previous fix didn't stick.
  recentReenable: {
    at: string;
    actorName: string | null;
    actorRole: string | null;
    actorUserId: number | null;
    action: 'reenable' | 'reenable_with_replacement' | string;
    replacementEmail: string | null;
  } | null;
}

type SuppressionReasonFilter = 'all' | 'bounced' | 'spam_complaint' | 'unsubscribed' | 'manual';

const SUPPRESSION_REASON_LABEL: Record<string, string> = {
  bounced: 'Bounced',
  spam_complaint: 'Spam complaint',
  unsubscribed: 'Unsubscribed',
  manual: 'Added manually',
};

const SUPPRESSION_REASON_BADGE: Record<string, string> = {
  bounced: 'bg-red-500/15 text-red-300 border-red-500/30',
  spam_complaint: 'bg-orange-500/15 text-orange-300 border-orange-500/30',
  unsubscribed: 'bg-blue-500/15 text-blue-300 border-blue-500/30',
  manual: 'bg-zinc-500/15 text-zinc-300 border-zinc-500/30',
};

const SUPPRESSION_FILTERS: Array<{ id: SuppressionReasonFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'bounced', label: 'Bounced' },
  { id: 'spam_complaint', label: 'Spam' },
  { id: 'unsubscribed', label: 'Unsubscribed' },
  { id: 'manual', label: 'Manual' },
];

// Task #1310 — friendly labels for the transactional flow tags surfaced
// in the Suppressions tab. Anything not in this map falls back to the
// raw flow string so admins still see *something* useful.
const SUPPRESSION_FLOW_LABEL: Record<string, string> = {
  campaign: 'Marketing campaign',
  broadcast: 'Ad-hoc broadcast',
  email_verification: 'Signup verification',
  password_reset: 'Password reset',
  member_invite: 'Member invite',
  tournament_invite: 'Tournament invite',
  league_invite: 'League invite',
  tournament_registration: 'Tournament registration',
  payment_receipt: 'Payment receipt',
  shop_order_receipt: 'Shop order receipt',
  dues_receipt: 'Dues receipt',
};

const STATUS_COLORS: Record<CampaignStatus, string> = {
  draft: 'bg-zinc-500/20 text-zinc-400',
  scheduled: 'bg-blue-500/20 text-blue-400',
  sending: 'bg-yellow-500/20 text-yellow-400',
  sent: 'bg-green-500/20 text-green-400',
  cancelled: 'bg-red-500/20 text-red-400',
  paused: 'bg-orange-500/20 text-orange-400',
};

const SEGMENT_FIELDS = [
  { value: 'role', label: 'Member Role' },
  { value: 'membership_tier', label: 'Membership Tier (ID)' },
];

const DRIP_TRIGGERS = [
  { value: 'new_member', label: 'New Member Onboarding' },
  { value: 'pre_event', label: 'Pre-Event Reminder' },
  { value: 'post_event', label: 'Post-Event Follow-up' },
  { value: 'renewal_due', label: 'Membership Renewal Due' },
  { value: 'inactive', label: 'Inactive Member Re-engagement' },
];

const PRE_BUILT_TEMPLATES = [
  {
    name: 'Welcome New Member',
    category: 'onboarding',
    bodyHtml: `<div style="font-family:Inter,sans-serif;max-width:560px;margin:0 auto;background:#0a0a0a;color:#fff;border-radius:12px;overflow:hidden;">
  <div style="background:#1e4d2b;padding:32px 40px;">
    <h1 style="margin:0;font-size:24px;letter-spacing:4px;font-weight:900;color:#ffffff;">KHARAGOLF</h1>
    <p style="margin:4px 0 0;font-size:11px;letter-spacing:3px;color:#4ade80;text-transform:uppercase;">Member Portal</p>
  </div>
  <div style="padding:40px;">
    <h2 style="margin:0 0 16px;font-size:20px;">Welcome to the Club!</h2>
    <p style="color:#9ca3af;line-height:1.6;margin:0 0 24px;">We're thrilled to have you as a member. Here's everything you need to get started and make the most of your membership.</p>
    <ul style="color:#9ca3af;line-height:2;padding-left:20px;">
      <li>Book tee times via the member portal</li>
      <li>Track your handicap index</li>
      <li>Register for upcoming tournaments</li>
      <li>Access the pro shop with member discounts</li>
    </ul>
    <a href="#" style="display:inline-block;background:#22c55e;color:#fff;text-decoration:none;padding:14px 32px;border-radius:8px;font-weight:700;font-size:15px;margin-top:24px;">Visit Member Portal</a>
  </div>
</div>`,
  },
  {
    name: 'Tournament Registration Open',
    category: 'promotions',
    bodyHtml: `<div style="font-family:Inter,sans-serif;max-width:560px;margin:0 auto;background:#0a0a0a;color:#fff;border-radius:12px;overflow:hidden;">
  <div style="background:#1e4d2b;padding:32px 40px;">
    <h1 style="margin:0;font-size:24px;letter-spacing:4px;font-weight:900;color:#ffffff;">KHARAGOLF</h1>
    <p style="margin:4px 0 0;font-size:11px;letter-spacing:3px;color:#4ade80;text-transform:uppercase;">Tournament Update</p>
  </div>
  <div style="padding:40px;">
    <h2 style="margin:0 0 16px;font-size:20px;">Registrations Now Open</h2>
    <p style="color:#9ca3af;line-height:1.6;margin:0 0 24px;">Don't miss your chance to compete in our upcoming tournament. Limited spots available — register now to secure your place.</p>
    <a href="#" style="display:inline-block;background:#22c55e;color:#fff;text-decoration:none;padding:14px 32px;border-radius:8px;font-weight:700;font-size:15px;">Register Now</a>
  </div>
</div>`,
  },
  {
    name: 'Pro Shop Sale',
    category: 'promotions',
    bodyHtml: `<div style="font-family:Inter,sans-serif;max-width:560px;margin:0 auto;background:#0a0a0a;color:#fff;border-radius:12px;overflow:hidden;">
  <div style="background:#1e4d2b;padding:32px 40px;">
    <h1 style="margin:0;font-size:24px;letter-spacing:4px;font-weight:900;color:#ffffff;">KHARAGOLF</h1>
    <p style="margin:4px 0 0;font-size:11px;letter-spacing:3px;color:#4ade80;text-transform:uppercase;">Pro Shop</p>
  </div>
  <div style="padding:40px;">
    <h2 style="margin:0 0 16px;font-size:20px;">Exclusive Member Sale — Up to 30% Off</h2>
    <p style="color:#9ca3af;line-height:1.6;margin:0 0 24px;">As a valued member, you have early access to our seasonal sale. Browse our selection of premium golf equipment and apparel.</p>
    <a href="#" style="display:inline-block;background:#22c55e;color:#fff;text-decoration:none;padding:14px 32px;border-radius:8px;font-weight:700;font-size:15px;">Shop Now</a>
  </div>
</div>`,
  },
];

// Task #1935 — render the original To / Cc / Bcc lists from the bounced
// Postmark message. Keeps the dialog readable when a broadcast went out
// to dozens of addresses by collapsing past 3 entries behind a
// "+ N more" toggle.
function RecipientList({
  label,
  addresses,
  fallback,
  testId,
}: {
  label: string;
  addresses: Array<{ Email: string; Name?: string }>;
  fallback?: string;
  testId: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const COLLAPSED_LIMIT = 3;
  if (addresses.length === 0) {
    if (!fallback) return null;
    return (
      <>
        <span className="text-muted-foreground uppercase tracking-wide">{label}</span>
        <span className="text-zinc-200 font-mono break-all" data-testid={testId}>{fallback}</span>
      </>
    );
  }
  const format = (a: { Email: string; Name?: string }) =>
    a.Name ? `${a.Name} <${a.Email}>` : a.Email;
  const visible = expanded ? addresses : addresses.slice(0, COLLAPSED_LIMIT);
  const hidden = addresses.length - visible.length;
  return (
    <>
      <span className="text-muted-foreground uppercase tracking-wide">{label}</span>
      <span className="text-zinc-200 font-mono break-all" data-testid={testId}>
        {visible.map(format).join(', ')}
        {hidden > 0 && (
          <>
            {', '}
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="text-sky-300 hover:text-sky-200 underline underline-offset-2 font-sans not-italic"
              data-testid={`${testId}-more`}
            >
              + {hidden} more
            </button>
          </>
        )}
        {expanded && addresses.length > COLLAPSED_LIMIT && (
          <>
            {' '}
            <button
              type="button"
              onClick={() => setExpanded(false)}
              className="text-sky-300 hover:text-sky-200 underline underline-offset-2 font-sans not-italic"
              data-testid={`${testId}-less`}
            >
              show less
            </button>
          </>
        )}
      </span>
    </>
  );
}

export default function MarketingPage() {
  const { data: user } = useGetMe();
  const orgId = user?.organizationId;
  const { toast } = useToast();
  const qc = useQueryClient();

  const [tab, setTab] = useState<Tab>('campaigns');

  const [showCampaignDialog, setShowCampaignDialog] = useState(false);
  const [editingCampaign, setEditingCampaign] = useState<Campaign | null>(null);
  const [campaignForm, setCampaignForm] = useState({
    name: '', subject: '', subjectVariantB: '', previewText: '',
    bodyHtml: '', bodyText: '', channels: ['email'], segmentId: '',
    type: 'one_off', dripSeriesId: '', dripDelayDays: '0', dripOrder: '0',
    // Task #1555 — id of the saved template the body was sourced from.
    // Stored as a string in form state (matches the other id fields)
    // and converted to number|null on save. Cleared automatically
    // when the admin types over the body, but kept when they pick a
    // template from the dropdown so bounces stay attributable.
    templateId: '',
  });

  const [showSegmentDialog, setShowSegmentDialog] = useState(false);
  const [editingSegment, setEditingSegment] = useState<Segment | null>(null);
  const [segmentForm, setSegmentForm] = useState({ name: '', description: '', rules: [{ field: 'role', operator: 'eq', value: 'player' }] });

  const [showDripDialog, setShowDripDialog] = useState(false);
  const [editingDrip, setEditingDrip] = useState<DripSeries | null>(null);
  const [dripForm, setDripForm] = useState({ name: '', description: '', trigger: 'new_member', isActive: true });

  const [showTemplateDialog, setShowTemplateDialog] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<Template | null>(null);
  const [templateForm, setTemplateForm] = useState({ name: '', category: 'general', bodyHtml: '', bodyText: '' });

  const [showSuppressionDialog, setShowSuppressionDialog] = useState(false);
  const [suppressionEmail, setSuppressionEmail] = useState('');
  const [suppressionFilter, setSuppressionFilter] = useState<SuppressionReasonFilter>('all');
  // Task #1310 — source filter. "" = all sources; "campaign:<id>" /
  // "flow:<name>" / "none" mirror the API's `?source=` query param so the
  // dropdown selection round-trips through the URL the server sees.
  const [suppressionSource, setSuppressionSource] = useState<string>('');

  const [reenableTarget, setReenableTarget] = useState<Suppression | null>(null);
  const [reenableReplacement, setReenableReplacement] = useState('');
  const [reenablePreview, setReenablePreview] = useState<{
    matchedMembers: Array<{ id: number; name: string; email: string | null }>;
    matchedUsers: Array<{ id: number; displayName: string | null; email: string | null }>;
  } | null>(null);
  const [reenableSubmitting, setReenableSubmitting] = useState(false);

  const [showScheduleDialog, setShowScheduleDialog] = useState<Campaign | null>(null);
  const [scheduleAt, setScheduleAt] = useState('');

  const [showStatsDialog, setShowStatsDialog] = useState<number | null>(null);
  const [showPreviewDialog, setShowPreviewDialog] = useState<Campaign | null>(null);

  // Task #1556 — Postmark message preview. We track the suppression we
  // are looking up (so the dialog can show "Bounced message — <email>")
  // alongside `message` (the rendered body / headers) and `error`
  // (a friendly explanation when the message has aged out / Postmark is
  // not configured / the suppression has no MessageID).
  interface BouncedMessage {
    messageId: string;
    to: Array<{ Email: string; Name?: string }>;
    cc: Array<{ Email: string; Name?: string }>;
    bcc: Array<{ Email: string; Name?: string }>;
    from: string;
    subject: string;
    htmlBody: string | null;
    textBody: string | null;
    status: string | null;
    receivedAt: string | null;
    tag: string | null;
    metadata: Record<string, string> | null;
    recipients: string[];
  }
  const [messagePreviewSuppression, setMessagePreviewSuppression] = useState<Suppression | null>(null);
  const [messagePreviewLoading, setMessagePreviewLoading] = useState(false);
  const [messagePreviewError, setMessagePreviewError] = useState<string | null>(null);
  const [messagePreviewBody, setMessagePreviewBody] = useState<BouncedMessage | null>(null);
  const [messagePreviewTab, setMessagePreviewTab] = useState<'html' | 'text' | 'headers'>('html');

  // Task #1936 — "Resend to corrected address" inside the bounced-message
  // dialog. Defaults to the original recipient so the admin only has to fix
  // the typo; the server-side gate refuses to resend to the same address
  // when the suppression is still active.
  const [resendTo, setResendTo] = useState('');
  const [resendSubmitting, setResendSubmitting] = useState(false);

  const { data: campaigns = [] } = useQuery<Campaign[]>({
    queryKey: [`/api/organizations/${orgId}/marketing/campaigns`],
    queryFn: () => fetch(apiUrl(`/organizations/${orgId}/marketing/campaigns`), { credentials: 'include' }).then(r => r.json()),
    enabled: !!orgId,
  });

  const { data: segments = [] } = useQuery<Segment[]>({
    queryKey: [`/api/organizations/${orgId}/marketing/segments`],
    queryFn: () => fetch(apiUrl(`/organizations/${orgId}/marketing/segments`), { credentials: 'include' }).then(r => r.json()),
    enabled: !!orgId,
  });

  const { data: dripSeries = [] } = useQuery<DripSeries[]>({
    queryKey: [`/api/organizations/${orgId}/marketing/drip-series`],
    queryFn: () => fetch(apiUrl(`/organizations/${orgId}/marketing/drip-series`), { credentials: 'include' }).then(r => r.json()),
    enabled: !!orgId,
  });

  const { data: templates = [] } = useQuery<Template[]>({
    queryKey: [`/api/organizations/${orgId}/marketing/templates`],
    queryFn: () => fetch(apiUrl(`/organizations/${orgId}/marketing/templates`), { credentials: 'include' }).then(r => r.json()),
    enabled: !!orgId,
  });

  // Task #1557 — bounce-source breakdown for the dashboard chart.
  // Always fetched (independently of the active tab) so the dashboard
  // surfaces chronic offenders without admins having to drill in first.
  // Task #1943 — same endpoint also serves a "spam complaints by source"
  // breakdown via `?reason=spam_complaint`. We fire it as a sibling query
  // so the two charts stay independent (own loading state, own cache key)
  // and one chart's error doesn't blank the other.
  interface SuppressionSource {
    key: string;
    label: string;
    campaignId: number | null;
    flow: string | null;
    count: number;
  }
  interface SuppressionSourceResponse {
    windowDays: number;
    reason: 'bounced' | 'spam_complaint';
    total: number;
    sources: SuppressionSource[];
    truncated: boolean;
  }
  // Task #1942 — selectable time window for the chart. Persisted in
  // sessionStorage so the picked window survives navigation away and
  // back to the dashboard within the same browser session, but doesn't
  // leak across separate sessions / different admins on the same box.
  // Restricted to the values rendered by the dropdown so a stale /
  // hand-edited entry can't request something nonsensical.
  // Task #1943 — the same window selection drives both the bounce and
  // spam-complaint charts so the two side-by-side panels always report
  // on the same time range.
  const BOUNCE_WINDOW_OPTIONS = [7, 30, 90] as const;
  type BounceWindowDays = typeof BOUNCE_WINDOW_OPTIONS[number];
  const BOUNCE_WINDOW_STORAGE_KEY = 'marketing.bounceSources.windowDays';
  function readStoredBounceWindow(): BounceWindowDays {
    if (typeof window === 'undefined') return 30;
    try {
      const raw = window.sessionStorage.getItem(BOUNCE_WINDOW_STORAGE_KEY);
      const parsed = raw ? parseInt(raw, 10) : NaN;
      if (BOUNCE_WINDOW_OPTIONS.includes(parsed as BounceWindowDays)) {
        return parsed as BounceWindowDays;
      }
    } catch {
      // sessionStorage can throw in privacy modes — fall through to default.
    }
    return 30;
  }
  const [bounceWindowDays, setBounceWindowDays] = useState<BounceWindowDays>(readStoredBounceWindow);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.sessionStorage.setItem(BOUNCE_WINDOW_STORAGE_KEY, String(bounceWindowDays));
    } catch {
      // Ignore — the in-memory state is still authoritative for this session.
    }
  }, [bounceWindowDays]);
  const { data: bounceSourceData } = useQuery<SuppressionSourceResponse>({
    // Task #1942 — include the selected window in the query key so the
    // cache stays partitioned per window and switching to "Last 7 days"
    // re-fetches instead of showing a stale 30-day chart.
    queryKey: [`/api/organizations/${orgId}/marketing/bounce-sources`, 'bounced', bounceWindowDays],
    queryFn: () => fetch(apiUrl(`/organizations/${orgId}/marketing/bounce-sources?days=${bounceWindowDays}`), { credentials: 'include' }).then(r => r.json()),
    enabled: !!orgId,
  });
  const { data: spamSourceData } = useQuery<SuppressionSourceResponse>({
    queryKey: [`/api/organizations/${orgId}/marketing/bounce-sources`, 'spam_complaint', bounceWindowDays],
    queryFn: () => fetch(apiUrl(`/organizations/${orgId}/marketing/bounce-sources?reason=spam_complaint&days=${bounceWindowDays}`), { credentials: 'include' }).then(r => r.json()),
    enabled: !!orgId,
  });

  const { data: suppressions = [] } = useQuery<Suppression[]>({
    queryKey: [`/api/organizations/${orgId}/marketing/suppressions`, suppressionFilter, suppressionSource],
    queryFn: () => {
      const params = new URLSearchParams();
      if (suppressionFilter !== 'all') params.set('reason', suppressionFilter);
      if (suppressionSource) params.set('source', suppressionSource);
      const qs = params.toString() ? `?${params.toString()}` : '';
      return fetch(apiUrl(`/organizations/${orgId}/marketing/suppressions${qs}`), { credentials: 'include' }).then(r => r.json());
    },
    enabled: !!orgId,
  });

  const { data: statsData } = useQuery({
    queryKey: [`/api/organizations/${orgId}/marketing/campaigns/${showStatsDialog}/stats`],
    queryFn: () => fetch(apiUrl(`/organizations/${orgId}/marketing/campaigns/${showStatsDialog}/stats`), { credentials: 'include' }).then(r => r.json()),
    enabled: !!orgId && !!showStatsDialog,
  });

  function invalidateCampaigns() { qc.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/marketing/campaigns`] }); }
  function invalidateSegments() { qc.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/marketing/segments`] }); }
  function invalidateDrip() { qc.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/marketing/drip-series`] }); }
  function invalidateTemplates() { qc.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/marketing/templates`] }); }
  function invalidateSuppressions() {
    qc.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/marketing/suppressions`] });
    // Task #1557 / #1943 — keep both dashboard charts in sync when
    // suppressions change (re-enable, manual add, manual delete). The
    // bounce + spam queries share the same key prefix so a single
    // invalidate call covers both.
    qc.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/marketing/bounce-sources`] });
  }

  // Task #1557 — chart bar click → switch to Suppressions tab with the
  // matching `source` filter pre-applied. Mirrors the URL the source
  // dropdown writes so the same query round-trips through the API.
  // Task #1943 — also accept a reason filter so the spam-complaints chart
  // deep-links into "spam complaints from this source" instead of "every
  // suppression from this source". Defaults to 'all' to preserve the
  // existing bounce-chart behaviour.
  function goToSuppressionsForSource(sourceKey: string, reason: SuppressionReasonFilter = 'all') {
    setSuppressionFilter(reason);
    setSuppressionSource(sourceKey);
    setTab('suppressions');
  }

  async function saveCampaign() {
    const url = editingCampaign
      ? apiUrl(`/organizations/${orgId}/marketing/campaigns/${editingCampaign.id}`)
      : apiUrl(`/organizations/${orgId}/marketing/campaigns`);
    const method = editingCampaign ? 'PUT' : 'POST';
    const body = {
      ...campaignForm,
      segmentId: campaignForm.segmentId ? Number(campaignForm.segmentId) : null,
      dripSeriesId: campaignForm.dripSeriesId ? Number(campaignForm.dripSeriesId) : null,
      dripDelayDays: Number(campaignForm.dripDelayDays),
      dripOrder: Number(campaignForm.dripOrder),
      // Task #1555 — '' clears the link (PUT honours `null` as
      // "explicit clear"); a non-empty value carries the template id
      // through to the dispatcher so bounces can be attributed back.
      templateId: campaignForm.templateId ? Number(campaignForm.templateId) : null,
    };
    const res = await fetch(url, { method, credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) { toast({ title: 'Error', description: 'Failed to save campaign', variant: 'destructive' }); return; }
    toast({ title: editingCampaign ? 'Campaign updated' : 'Campaign created' });
    setShowCampaignDialog(false);
    invalidateCampaigns();
  }

  async function deleteCampaign(id: number) {
    await fetch(apiUrl(`/organizations/${orgId}/marketing/campaigns/${id}`), { method: 'DELETE', credentials: 'include' });
    toast({ title: 'Campaign deleted' });
    invalidateCampaigns();
  }

  async function sendCampaign(id: number) {
    const res = await fetch(apiUrl(`/organizations/${orgId}/marketing/campaigns/${id}/send`), { method: 'POST', credentials: 'include' });
    if (!res.ok) { toast({ title: 'Error', description: 'Failed to send campaign', variant: 'destructive' }); return; }
    toast({ title: 'Campaign dispatched', description: 'Emails are being sent to eligible recipients.' });
    invalidateCampaigns();
  }

  async function scheduleCampaign() {
    if (!showScheduleDialog) return;
    const res = await fetch(apiUrl(`/organizations/${orgId}/marketing/campaigns/${showScheduleDialog.id}/schedule`), {
      method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scheduledAt: scheduleAt }),
    });
    if (!res.ok) { toast({ title: 'Error', description: 'Failed to schedule', variant: 'destructive' }); return; }
    toast({ title: 'Campaign scheduled' });
    setShowScheduleDialog(null);
    invalidateCampaigns();
  }

  async function saveSegment() {
    const url = editingSegment
      ? apiUrl(`/organizations/${orgId}/marketing/segments/${editingSegment.id}`)
      : apiUrl(`/organizations/${orgId}/marketing/segments`);
    const method = editingSegment ? 'PUT' : 'POST';
    const res = await fetch(url, { method, credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(segmentForm) });
    if (!res.ok) { toast({ title: 'Error', description: 'Failed to save segment', variant: 'destructive' }); return; }
    toast({ title: editingSegment ? 'Segment updated' : 'Segment created' });
    setShowSegmentDialog(false);
    invalidateSegments();
  }

  async function deleteSegment(id: number) {
    await fetch(apiUrl(`/organizations/${orgId}/marketing/segments/${id}`), { method: 'DELETE', credentials: 'include' });
    toast({ title: 'Segment deleted' });
    invalidateSegments();
  }

  async function saveDrip() {
    const url = editingDrip
      ? apiUrl(`/organizations/${orgId}/marketing/drip-series/${editingDrip.id}`)
      : apiUrl(`/organizations/${orgId}/marketing/drip-series`);
    const method = editingDrip ? 'PUT' : 'POST';
    const res = await fetch(url, { method, credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(dripForm) });
    if (!res.ok) { toast({ title: 'Error', description: 'Failed to save drip series', variant: 'destructive' }); return; }
    toast({ title: editingDrip ? 'Series updated' : 'Drip series created' });
    setShowDripDialog(false);
    invalidateDrip();
  }

  async function deleteDrip(id: number) {
    await fetch(apiUrl(`/organizations/${orgId}/marketing/drip-series/${id}`), { method: 'DELETE', credentials: 'include' });
    toast({ title: 'Drip series deleted' });
    invalidateDrip();
  }

  async function saveTemplate() {
    const url = editingTemplate
      ? apiUrl(`/organizations/${orgId}/marketing/templates/${editingTemplate.id}`)
      : apiUrl(`/organizations/${orgId}/marketing/templates`);
    const method = editingTemplate ? 'PUT' : 'POST';
    const res = await fetch(url, { method, credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(templateForm) });
    if (!res.ok) { toast({ title: 'Error', description: 'Failed to save template', variant: 'destructive' }); return; }
    toast({ title: editingTemplate ? 'Template updated' : 'Template created' });
    setShowTemplateDialog(false);
    invalidateTemplates();
  }

  async function deleteTemplate(id: number) {
    await fetch(apiUrl(`/organizations/${orgId}/marketing/templates/${id}`), { method: 'DELETE', credentials: 'include' });
    toast({ title: 'Template deleted' });
    invalidateTemplates();
  }

  async function addSuppression() {
    if (!suppressionEmail) return;
    await fetch(apiUrl(`/organizations/${orgId}/marketing/suppressions`), {
      method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: suppressionEmail, reason: 'manual' }),
    });
    toast({ title: 'Email suppressed' });
    setSuppressionEmail('');
    setShowSuppressionDialog(false);
    invalidateSuppressions();
  }

  async function removeSuppression(id: number) {
    await fetch(apiUrl(`/organizations/${orgId}/marketing/suppressions/${id}`), { method: 'DELETE', credentials: 'include' });
    toast({ title: 'Suppression removed' });
    invalidateSuppressions();
  }

  /**
   * Task #1556 — open the bounced-message preview dialog and load the
   * rendered HTML / plain-text / headers from the API. The endpoint
   * already enforces that the MessageID belongs to this org's
   * suppression list, so we just surface the response (or a friendly
   * error when Postmark has aged the body out / the suppression has no
   * recorded MessageID / Postmark isn't configured).
   */
  async function openMessagePreview(s: Suppression) {
    setMessagePreviewSuppression(s);
    setMessagePreviewBody(null);
    setMessagePreviewError(null);
    setMessagePreviewTab('html');
    setMessagePreviewLoading(true);
    // Task #1936 — pre-fill the resend input with the original recipient
    // so admins only have to fix the typo (and so re-enabled suppressions
    // resend straight back to the now-valid address with one click).
    setResendTo(s.email);
    setResendSubmitting(false);
    try {
      const res = await fetch(
        apiUrl(`/organizations/${orgId}/marketing/suppressions/${s.id}/message`),
        { credentials: 'include' },
      );
      if (!res.ok) {
        const detail = await res.json().catch(() => ({}));
        setMessagePreviewError(
          detail?.message
            ?? (res.status === 404
              ? 'The bounced message is no longer available in Postmark.'
              : 'Could not load the bounced message preview.'),
        );
      } else {
        const data = await res.json();
        setMessagePreviewBody(data?.message ?? null);
        // Default to plain-text when the message has no HTML (e.g. some
        // ops alerts / digests) so we still show *something* useful.
        if (data?.message && !data.message.htmlBody && data.message.textBody) {
          setMessagePreviewTab('text');
        }
      }
    } catch (err) {
      setMessagePreviewError(err instanceof Error ? err.message : String(err));
    } finally {
      setMessagePreviewLoading(false);
    }
  }

  function closeMessagePreview() {
    setMessagePreviewSuppression(null);
    setMessagePreviewBody(null);
    setMessagePreviewError(null);
    setMessagePreviewLoading(false);
    setResendTo('');
    setResendSubmitting(false);
  }

  /**
   * Task #1936 — resend the bounced message to a corrected recipient.
   * The button is gated client-side: enabled only when the address is
   * valid AND (the suppression has been re-enabled OR the destination
   * differs from the original bounced address). The server enforces the
   * same rule and rejects any bypass with a 409.
   */
  async function submitResend() {
    if (!messagePreviewSuppression) return;
    const trimmed = resendTo.trim();
    if (!trimmed) return;
    setResendSubmitting(true);
    try {
      const res = await fetch(
        apiUrl(`/organizations/${orgId}/marketing/suppressions/${messagePreviewSuppression.id}/message/resend`),
        {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ to: trimmed }),
        },
      );
      if (!res.ok) {
        const detail = await res.json().catch(() => ({}));
        toast({
          title: 'Could not resend',
          description: detail?.message ?? detail?.error ?? 'The email provider refused the resend.',
          variant: 'destructive',
        });
        setResendSubmitting(false);
        return;
      }
      const data = await res.json();
      toast({
        title: 'Message resent',
        description: `Sent to ${data.resentTo ?? trimmed}`,
      });
      setResendSubmitting(false);
      closeMessagePreview();
      // Suppressions tab may show a freshly-cleared row if the destination
      // was the same email that just got re-enabled — refresh both lists.
      invalidateSuppressions();
    } catch (err) {
      toast({ title: 'Could not resend', description: String(err), variant: 'destructive' });
      setResendSubmitting(false);
    }
  }

  function openReenableDialog(s: Suppression) {
    setReenableTarget(s);
    setReenableReplacement('');
    setReenablePreview(null);
  }

  function closeReenableDialog() {
    setReenableTarget(null);
    setReenableReplacement('');
    setReenablePreview(null);
    setReenableSubmitting(false);
  }

  /**
   * Two-step flow:
   *   1. With a replacement and no preview yet → POST { replacementEmail }; backend
   *      returns { requiresConfirmation: true, matchedMembers, matchedUsers } so the
   *      admin can review what will change.
   *   2. After preview, or with no replacement at all → POST { replacementEmail?, confirmed: true }
   *      which actually deletes the suppression and (when applicable) updates the linked
   *      member/user emails. Audit logged on the server.
   */
  async function submitReenable() {
    if (!reenableTarget) return;
    const replacement = reenableReplacement.trim();
    const needsPreview = !!replacement && !reenablePreview;
    setReenableSubmitting(true);
    try {
      const body: Record<string, unknown> = {};
      if (replacement) body.replacementEmail = replacement;
      if (!needsPreview) body.confirmed = true;
      const res = await fetch(
        apiUrl(`/organizations/${orgId}/marketing/suppressions/${reenableTarget.id}/reenable`),
        {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      );
      if (!res.ok) {
        const detail = await res.json().catch(() => ({}));
        toast({ title: 'Could not re-enable', description: detail?.error ?? 'Please try again.', variant: 'destructive' });
        setReenableSubmitting(false);
        return;
      }
      const data = await res.json();
      if (data?.requiresConfirmation) {
        setReenablePreview({
          matchedMembers: data.matchedMembers ?? [],
          matchedUsers: data.matchedUsers ?? [],
        });
        setReenableSubmitting(false);
        return;
      }
      const updatedCount = (data?.updatedMemberIds?.length ?? 0) + (data?.updatedUserIds?.length ?? 0);
      toast({
        title: 'Email re-enabled',
        description: replacement
          ? `Replaced with ${replacement}${updatedCount > 0 ? ` · updated ${updatedCount} record${updatedCount === 1 ? '' : 's'}` : ''}`
          : `${reenableTarget.email} can receive marketing again.`,
      });
      closeReenableDialog();
      invalidateSuppressions();
    } catch (err) {
      toast({ title: 'Could not re-enable', description: String(err), variant: 'destructive' });
      setReenableSubmitting(false);
    }
  }

  function openNewCampaign() {
    setEditingCampaign(null);
    setCampaignForm({ name: '', subject: '', subjectVariantB: '', previewText: '', bodyHtml: '', bodyText: '', channels: ['email'], segmentId: '', type: 'one_off', dripSeriesId: '', dripDelayDays: '0', dripOrder: '0', templateId: '' });
    setShowCampaignDialog(true);
  }

  function openEditCampaign(c: Campaign) {
    setEditingCampaign(c);
    setCampaignForm({
      name: c.name, subject: c.subject ?? '', subjectVariantB: c.subjectVariantB ?? '',
      previewText: c.previewText ?? '', bodyHtml: c.bodyHtml, bodyText: c.bodyText ?? '',
      channels: c.channels, segmentId: c.segmentId ? String(c.segmentId) : '',
      type: c.type, dripSeriesId: c.dripSeriesId ? String(c.dripSeriesId) : '',
      dripDelayDays: String(c.dripDelayDays ?? 0), dripOrder: String(c.dripOrder ?? 0),
      // Task #1555 — preserve the existing template attribution when
      // editing so unrelated edits don't accidentally strip it.
      templateId: c.templateId ? String(c.templateId) : '',
    });
    setShowCampaignDialog(true);
  }

  function applyTemplate(t: Template) {
    // Task #1555 — record which template the body came from so
    // bounces can be attributed all the way back to it.
    setCampaignForm(f => ({ ...f, bodyHtml: t.bodyHtml, bodyText: t.bodyText ?? '', templateId: String(t.id) }));
    toast({ title: `Template "${t.name}" applied` });
  }

  function usePreBuiltTemplate(t: typeof PRE_BUILT_TEMPLATES[0]) {
    // Pre-built templates aren't persisted to `email_templates_marketing`,
    // so they have no id to attribute against — clear `templateId` to
    // be explicit about that (and to avoid leaving a stale id from a
    // previously-applied saved template).
    setCampaignForm(f => ({ ...f, name: t.name, bodyHtml: t.bodyHtml, templateId: '' }));
  }

  const sentCampaigns = campaigns.filter(c => c.status === 'sent');
  const totalSent = sentCampaigns.reduce((s, c) => s + c.totalSent, 0);
  const totalOpened = sentCampaigns.reduce((s, c) => s + c.totalOpened, 0);
  const avgOpenRate = totalSent > 0 ? Math.round((totalOpened / totalSent) * 100) : 0;

  const tabs: { id: Tab; label: string; icon: React.ElementType }[] = [
    { id: 'campaigns', label: 'Campaigns', icon: Megaphone },
    { id: 'segments', label: 'Segments', icon: Target },
    { id: 'drip', label: 'Drip Series', icon: Repeat },
    { id: 'templates', label: 'Templates', icon: FileText },
    { id: 'suppressions', label: 'Suppressions', icon: X },
  ];

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2">
            <Megaphone className="w-6 h-6 text-primary" /> Marketing Campaigns
          </h1>
          <p className="text-muted-foreground text-sm mt-1">Design, send, and track email & push campaigns to members</p>
        </div>
        {tab === 'campaigns' && (
          <Button onClick={openNewCampaign} className="gap-2">
            <Plus className="w-4 h-4" /> New Campaign
          </Button>
        )}
        {tab === 'segments' && (
          <Button onClick={() => { setEditingSegment(null); setSegmentForm({ name: '', description: '', rules: [{ field: 'role', operator: 'eq', value: 'player' }] }); setShowSegmentDialog(true); }} className="gap-2">
            <Plus className="w-4 h-4" /> New Segment
          </Button>
        )}
        {tab === 'drip' && (
          <Button onClick={() => { setEditingDrip(null); setDripForm({ name: '', description: '', trigger: 'new_member', isActive: true }); setShowDripDialog(true); }} className="gap-2">
            <Plus className="w-4 h-4" /> New Drip Series
          </Button>
        )}
        {tab === 'templates' && (
          <Button onClick={() => { setEditingTemplate(null); setTemplateForm({ name: '', category: 'general', bodyHtml: '', bodyText: '' }); setShowTemplateDialog(true); }} className="gap-2">
            <Plus className="w-4 h-4" /> New Template
          </Button>
        )}
        {tab === 'suppressions' && (
          <Button onClick={() => setShowSuppressionDialog(true)} className="gap-2">
            <Plus className="w-4 h-4" /> Add Suppression
          </Button>
        )}
      </div>

      {/* Summary KPI cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card className="p-4 bg-card border-white/5">
          <p className="text-xs text-muted-foreground uppercase tracking-wider">Total Campaigns</p>
          <p className="text-2xl font-bold text-white mt-1">{campaigns.length}</p>
        </Card>
        <Card className="p-4 bg-card border-white/5">
          <p className="text-xs text-muted-foreground uppercase tracking-wider">Emails Sent</p>
          <p className="text-2xl font-bold text-white mt-1">{totalSent.toLocaleString()}</p>
        </Card>
        <Card className="p-4 bg-card border-white/5">
          <p className="text-xs text-muted-foreground uppercase tracking-wider">Avg Open Rate</p>
          <p className="text-2xl font-bold text-white mt-1">{avgOpenRate}%</p>
        </Card>
        <Card className="p-4 bg-card border-white/5">
          <p className="text-xs text-muted-foreground uppercase tracking-wider">Segments</p>
          <p className="text-2xl font-bold text-white mt-1">{segments.length}</p>
        </Card>
      </div>

      {/* Bounces + spam complaints by source — Tasks #1557 / #1942 / #1943.
          Two-column on wide screens so admins see both deliverability
          signals side by side; stacks on narrow viewports. The window
          picker on each card is wired to the same parent state so the
          two charts always report on the same time range. */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <BounceSourcesCard
          data={bounceSourceData}
          flowLabels={SUPPRESSION_FLOW_LABEL}
          onBarClick={(key) => goToSuppressionsForSource(key, 'bounced')}
          windowOptions={BOUNCE_WINDOW_OPTIONS}
          selectedWindowDays={bounceWindowDays}
          onWindowDaysChange={d => {
            // Guard against any future caller passing an out-of-range value;
            // the API clamps too, but keeping the picker in lockstep avoids
            // an unnecessary 30-day fallback round-trip.
            if (BOUNCE_WINDOW_OPTIONS.includes(d as BounceWindowDays)) {
              setBounceWindowDays(d as BounceWindowDays);
            }
          }}
        />
        <BounceSourcesCard
          data={spamSourceData}
          flowLabels={SUPPRESSION_FLOW_LABEL}
          reason="spam_complaint"
          onBarClick={(key) => goToSuppressionsForSource(key, 'spam_complaint')}
          windowOptions={BOUNCE_WINDOW_OPTIONS}
          selectedWindowDays={bounceWindowDays}
          onWindowDaysChange={d => {
            if (BOUNCE_WINDOW_OPTIONS.includes(d as BounceWindowDays)) {
              setBounceWindowDays(d as BounceWindowDays);
            }
          }}
        />
      </div>

      {/* Tabs */}
      <div className="flex gap-1 bg-white/5 p-1 rounded-xl w-fit flex-wrap">
        {tabs.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${tab === t.id ? 'bg-primary text-white' : 'text-muted-foreground hover:text-white'}`}
          >
            <t.icon className="w-3.5 h-3.5" />
            {t.label}
          </button>
        ))}
      </div>

      {/* CAMPAIGNS TAB */}
      {tab === 'campaigns' && (
        <div className="space-y-3">
          {campaigns.length === 0 && (
            <Card className="p-12 bg-card border-white/5 text-center">
              <Megaphone className="w-10 h-10 text-muted-foreground mx-auto mb-3" />
              <p className="text-muted-foreground">No campaigns yet. Create your first one to get started.</p>
            </Card>
          )}
          {campaigns.map(c => (
            <Card key={c.id} className="p-4 bg-card border-white/5">
              <div className="flex items-start gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-semibold text-white">{c.name}</span>
                    <Badge className={`text-[10px] ${STATUS_COLORS[c.status]}`}>{c.status}</Badge>
                    {c.channels.includes('email') && <Badge className="text-[10px] bg-blue-500/20 text-blue-400">Email</Badge>}
                    {c.channels.includes('push') && <Badge className="text-[10px] bg-purple-500/20 text-purple-400">Push</Badge>}
                    {c.subjectVariantB && <Badge className="text-[10px] bg-yellow-500/20 text-yellow-400">A/B Test</Badge>}
                    {/* Task #1953 — surface the originating template (Task #1555
                        wired the link on the data side; this exposes it on the
                        card so admins can see at a glance which template a
                        campaign came from). Click opens the template editor
                        pre-populated, mirroring the Suppressions tab badge. If
                        the template is no longer visible to this org (deleted
                        or a global template that was unpublished), we still
                        render a non-clickable badge with the id so the
                        attribution isn't silently lost. */}
                    {c.templateId ? (() => {
                      const sourceTemplate = templates.find(x => x.id === c.templateId) ?? null;
                      const templateDisplayName = sourceTemplate?.name ?? `#${c.templateId}`;
                      return sourceTemplate ? (
                        <button
                          type="button"
                          onClick={() => {
                            setEditingTemplate(sourceTemplate);
                            setTemplateForm({
                              name: sourceTemplate.name,
                              category: sourceTemplate.category,
                              bodyHtml: sourceTemplate.bodyHtml,
                              bodyText: '',
                            });
                            setShowTemplateDialog(true);
                          }}
                          title="Open template editor"
                          data-testid={`campaign-source-template-${c.id}`}
                          className="text-[10px] uppercase tracking-wide px-2 py-0.5 rounded border bg-violet-500/10 text-violet-300 border-violet-500/30 hover:bg-violet-500/20"
                        >
                          From template: {templateDisplayName}
                        </button>
                      ) : (
                        <span
                          title="Source template is no longer available"
                          data-testid={`campaign-source-template-${c.id}`}
                          className="text-[10px] uppercase tracking-wide px-2 py-0.5 rounded border bg-violet-500/10 text-violet-300/70 border-violet-500/30"
                        >
                          From template: {templateDisplayName}
                        </span>
                      );
                    })() : null}
                  </div>
                  {c.subject && <p className="text-sm text-muted-foreground mt-0.5">Subject: {c.subject}</p>}
                  {c.scheduledAt && c.status === 'scheduled' && (
                    <p className="text-xs text-blue-400 mt-1 flex items-center gap-1">
                      <Clock className="w-3 h-3" /> Scheduled: {new Date(c.scheduledAt).toLocaleString()}
                    </p>
                  )}
                  {c.status === 'sent' && (
                    <div className="flex gap-4 mt-2">
                      <span className="text-xs text-muted-foreground">Sent: <strong className="text-white">{c.totalSent}</strong></span>
                      <span className="text-xs text-muted-foreground">Opened: <strong className="text-green-400">{c.totalSent > 0 ? Math.round((c.totalOpened / c.totalSent) * 100) : 0}%</strong></span>
                      <span className="text-xs text-muted-foreground">Clicked: <strong className="text-blue-400">{c.totalSent > 0 ? Math.round((c.totalClicked / c.totalSent) * 100) : 0}%</strong></span>
                    </div>
                  )}
                </div>
                <div className="flex gap-2 flex-shrink-0 flex-wrap">
                  <Button size="sm" variant="ghost" onClick={() => setShowPreviewDialog(c)} className="h-8 px-2" title="Preview">
                    <Eye className="w-4 h-4" />
                  </Button>
                  {c.status === 'sent' && (
                    <Button size="sm" variant="ghost" onClick={() => setShowStatsDialog(c.id)} className="h-8 px-2 text-green-400">
                      <BarChart2 className="w-4 h-4" />
                    </Button>
                  )}
                  {(c.status === 'draft' || c.status === 'paused') && (
                    <>
                      <Button size="sm" variant="ghost" onClick={() => openEditCampaign(c)} className="h-8 px-2">
                        <Pencil className="w-4 h-4" />
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => { setShowScheduleDialog(c); setScheduleAt(''); }} className="h-8 px-2 text-blue-400">
                        <Calendar className="w-4 h-4" />
                      </Button>
                      <Button size="sm" onClick={() => sendCampaign(c.id)} className="h-8 px-3 gap-1.5 bg-primary hover:bg-primary/90">
                        <Send className="w-3.5 h-3.5" /> Send
                      </Button>
                    </>
                  )}
                  <Button size="sm" variant="ghost" onClick={() => deleteCampaign(c.id)} className="h-8 px-2 text-red-400">
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* SEGMENTS TAB */}
      {tab === 'segments' && (
        <div className="space-y-3">
          {segments.length === 0 && (
            <Card className="p-12 bg-card border-white/5 text-center">
              <Target className="w-10 h-10 text-muted-foreground mx-auto mb-3" />
              <p className="text-muted-foreground">No segments yet. Create one to target specific member groups.</p>
            </Card>
          )}
          {segments.map(s => (
            <Card key={s.id} className="p-4 bg-card border-white/5">
              <div className="flex items-center gap-4">
                <div className="flex-1">
                  <p className="font-semibold text-white">{s.name}</p>
                  {s.description && <p className="text-sm text-muted-foreground">{s.description}</p>}
                  <p className="text-xs text-muted-foreground mt-1">
                    <Users className="w-3 h-3 inline mr-1" />
                    ~{s.estimatedCount} members · {s.rules.length} rule{s.rules.length !== 1 ? 's' : ''}
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button size="sm" variant="ghost" onClick={() => { setEditingSegment(s); setSegmentForm({ name: s.name, description: s.description ?? '', rules: s.rules.length ? s.rules : [{ field: 'role', operator: 'eq', value: 'player' }] }); setShowSegmentDialog(true); }} className="h-8 px-2">
                    <Pencil className="w-4 h-4" />
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => deleteSegment(s.id)} className="h-8 px-2 text-red-400">
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* DRIP SERIES TAB */}
      {tab === 'drip' && (
        <div className="space-y-4">
          {dripSeries.length === 0 && (
            <Card className="p-12 bg-card border-white/5 text-center">
              <Repeat className="w-10 h-10 text-muted-foreground mx-auto mb-3" />
              <p className="text-muted-foreground">No drip series yet. Automate onboarding and event reminder emails.</p>
            </Card>
          )}
          {dripSeries.map(s => (
            <Card key={s.id} className="p-4 bg-card border-white/5">
              <div className="flex items-start gap-4">
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <p className="font-semibold text-white">{s.name}</p>
                    <Badge className={s.isActive ? 'bg-green-500/20 text-green-400 text-[10px]' : 'bg-zinc-500/20 text-zinc-400 text-[10px]'}>
                      {s.isActive ? 'Active' : 'Inactive'}
                    </Badge>
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">
                    Trigger: {DRIP_TRIGGERS.find(t => t.value === s.trigger)?.label ?? s.trigger} · {s.steps.length} step{s.steps.length !== 1 ? 's' : ''}
                  </p>
                  {s.steps.length > 0 && (
                    <div className="mt-3 space-y-1">
                      {s.steps.map((step, i) => (
                        <div key={step.id} className="flex items-center gap-2 text-xs text-muted-foreground">
                          <div className="w-5 h-5 rounded-full bg-primary/20 text-primary flex items-center justify-center text-[10px] font-bold flex-shrink-0">{i + 1}</div>
                          <span className="text-white">{step.name}</span>
                          <span>— Day {step.dripDelayDays ?? 0}</span>
                          <Badge className={`text-[10px] ${STATUS_COLORS[step.status]}`}>{step.status}</Badge>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                <div className="flex gap-2">
                  <Button size="sm" variant="ghost" onClick={() => { setEditingDrip(s); setDripForm({ name: s.name, description: s.description ?? '', trigger: s.trigger, isActive: s.isActive }); setShowDripDialog(true); }} className="h-8 px-2">
                    <Pencil className="w-4 h-4" />
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => deleteDrip(s.id)} className="h-8 px-2 text-red-400">
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* TEMPLATES TAB */}
      {tab === 'templates' && (
        <div className="space-y-4">
          <div>
            <p className="text-sm text-muted-foreground mb-3">Pre-built templates</p>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              {PRE_BUILT_TEMPLATES.map(t => (
                <Card key={t.name} className="p-4 bg-card border-white/5 cursor-pointer hover:border-primary/30 transition-colors">
                  <p className="font-semibold text-white text-sm">{t.name}</p>
                  <Badge className="text-[10px] bg-blue-500/20 text-blue-400 mt-1">{t.category}</Badge>
                  <div className="mt-3 flex gap-2">
                    <Button size="sm" variant="ghost" className="h-7 px-2 text-xs gap-1" onClick={() => { setCampaignForm(f => ({ ...f, name: t.name, bodyHtml: t.bodyHtml })); setShowCampaignDialog(true); }}>
                      <Plus className="w-3 h-3" /> Use
                    </Button>
                  </div>
                </Card>
              ))}
            </div>
          </div>

          <div>
            <p className="text-sm text-muted-foreground mb-3">Custom templates</p>
            {templates.length === 0 && (
              <Card className="p-8 bg-card border-white/5 text-center">
                <FileText className="w-8 h-8 text-muted-foreground mx-auto mb-2" />
                <p className="text-muted-foreground text-sm">No custom templates yet.</p>
              </Card>
            )}
            {templates.filter(t => !t.isGlobal).map(t => (
              <Card key={t.id} className="p-4 bg-card border-white/5 mb-3">
                <div className="flex items-center gap-4">
                  <div className="flex-1">
                    <p className="font-semibold text-white">{t.name}</p>
                    <Badge className="text-[10px] bg-zinc-500/20 text-zinc-400 mt-1">{t.category}</Badge>
                  </div>
                  <div className="flex gap-2">
                    <Button size="sm" variant="ghost" onClick={() => { setEditingTemplate(t); setTemplateForm({ name: t.name, category: t.category, bodyHtml: t.bodyHtml, bodyText: '' }); setShowTemplateDialog(true); }} className="h-8 px-2">
                      <Pencil className="w-4 h-4" />
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => deleteTemplate(t.id)} className="h-8 px-2 text-red-400">
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        </div>
      )}

      {/* SUPPRESSIONS TAB */}
      {tab === 'suppressions' && (
        <div className="space-y-3">
          <Card className="p-4 bg-amber-500/10 border-amber-500/20">
            <p className="text-sm text-amber-400 flex items-center gap-2">
              <AlertCircle className="w-4 h-4 flex-shrink-0" />
              GDPR/CAN-SPAM compliant — suppressed addresses will never receive marketing emails. Members can unsubscribe via the one-click link in every email.
            </p>
          </Card>
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex flex-wrap gap-2" data-testid="suppression-filter-bar">
              {SUPPRESSION_FILTERS.map(f => (
                <Button
                  key={f.id}
                  size="sm"
                  variant={suppressionFilter === f.id ? 'default' : 'ghost'}
                  onClick={() => setSuppressionFilter(f.id)}
                  className="h-8"
                  data-testid={`suppression-filter-${f.id}`}
                >
                  {f.label}
                </Button>
              ))}
            </div>
            {/* Task #1310 — source filter. Lets admins drill into a single
                campaign or transactional flow without scanning the whole
                suppression list. */}
            <div className="flex items-center gap-2">
              <Label className="text-xs text-muted-foreground" htmlFor="suppression-source-filter">Source</Label>
              <select
                id="suppression-source-filter"
                data-testid="suppression-source-filter"
                value={suppressionSource}
                onChange={e => setSuppressionSource(e.target.value)}
                className="h-8 rounded-md border border-white/10 bg-background px-2 text-xs text-white"
              >
                <option value="">All sources</option>
                <option value="none">No source recorded</option>
                {campaigns.length > 0 && (
                  <optgroup label="Marketing campaigns">
                    {campaigns.map(c => (
                      <option key={`c-${c.id}`} value={`campaign:${c.id}`}>{c.name}</option>
                    ))}
                  </optgroup>
                )}
                {/* Task #1555 — drill into "every bounce caused by this
                    template" across whichever campaigns used it. Same
                    UX shape as the campaign group so admins switch
                    between them without re-learning the control. */}
                {templates.length > 0 && (
                  <optgroup label="Email templates">
                    {templates.map(t => (
                      <option key={`t-${t.id}`} value={`template:${t.id}`}>{t.name}</option>
                    ))}
                  </optgroup>
                )}
                <optgroup label="Transactional flows">
                  {Object.entries(SUPPRESSION_FLOW_LABEL)
                    .filter(([flow]) => flow !== 'campaign')
                    .map(([flow, label]) => (
                      <option key={`f-${flow}`} value={`flow:${flow}`}>{label}</option>
                    ))}
                </optgroup>
              </select>
              {suppressionSource && (
                <Button size="sm" variant="ghost" onClick={() => setSuppressionSource('')} className="h-8 px-2 text-xs" data-testid="suppression-source-clear">
                  Clear
                </Button>
              )}
            </div>
          </div>
          {suppressions.length === 0 && (
            <Card className="p-8 bg-card border-white/5 text-center">
              <CheckCircle2 className="w-8 h-8 text-green-400 mx-auto mb-2" />
              <p className="text-muted-foreground text-sm">
                {suppressionFilter === 'all' && !suppressionSource
                  ? 'No suppressions. All eligible members can receive campaigns.'
                  : 'No suppressions match the current filters.'}
              </p>
            </Card>
          )}
          {suppressions.map(s => {
            const reasonLabel = SUPPRESSION_REASON_LABEL[s.reason] ?? s.reason;
            const badgeClass = SUPPRESSION_REASON_BADGE[s.reason] ?? 'bg-zinc-500/15 text-zinc-300 border-zinc-500/30';
            // Task #1310 — resolve the originating campaign, preferring
            // the joined name from the API but falling back to the local
            // campaigns query (covers the rare case where the API failed
            // to join, e.g. a stale FK).
            const sourceCampaign = s.triggeredByCampaignId
              ? (campaigns.find(c => c.id === s.triggeredByCampaignId) ?? null)
              : null;
            const campaignDisplayName = s.triggeredByCampaignName ?? sourceCampaign?.name ?? null;
            const flowLabel = s.triggeredByFlow
              ? (SUPPRESSION_FLOW_LABEL[s.triggeredByFlow] ?? s.triggeredByFlow)
              : null;
            return (
              <Card key={s.id} className="p-3 bg-card border-white/5" data-testid={`suppression-row-${s.id}`}>
                <div className="flex items-start gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm text-white font-mono truncate">{s.email}</p>
                      <span className={`text-[10px] uppercase tracking-wide px-2 py-0.5 rounded border ${badgeClass}`}>
                        {reasonLabel}
                      </span>
                      {s.bounceType && (
                        <span className="text-[10px] uppercase tracking-wide px-2 py-0.5 rounded border bg-white/5 text-zinc-300 border-white/10" title="Postmark bounce sub-type">
                          {s.bounceType}
                        </span>
                      )}
                      {s.triggeredByCampaignId && campaignDisplayName ? (
                        // Click-through opens the campaign preview dialog —
                        // admins can inspect the exact send that produced
                        // the bounce without leaving the Suppressions tab.
                        <button
                          type="button"
                          onClick={() => {
                            if (sourceCampaign) setShowPreviewDialog(sourceCampaign);
                            else setSuppressionSource(`campaign:${s.triggeredByCampaignId}`);
                          }}
                          title="View originating campaign"
                          data-testid={`suppression-source-campaign-${s.id}`}
                          className="text-[10px] uppercase tracking-wide px-2 py-0.5 rounded border bg-emerald-500/10 text-emerald-300 border-emerald-500/30 hover:bg-emerald-500/20"
                        >
                          Campaign: {campaignDisplayName}
                        </button>
                      ) : s.triggeredByFlow ? (
                        // Click-through narrows the source filter to this
                        // exact flow so admins can see every other bounce
                        // from the same template.
                        <button
                          type="button"
                          onClick={() => setSuppressionSource(`flow:${s.triggeredByFlow}`)}
                          title="Filter by this transactional flow"
                          data-testid={`suppression-source-flow-${s.id}`}
                          className="text-[10px] uppercase tracking-wide px-2 py-0.5 rounded border bg-sky-500/10 text-sky-300 border-sky-500/30 hover:bg-sky-500/20"
                        >
                          Flow: {flowLabel}
                        </button>
                      ) : null}
                      {/* Task #1555 — when the bounce was attributed to a
                          saved template, render a second badge that
                          opens the template editor pre-populated with
                          its current contents. One click from "this
                          email bounced" to "fix the typo at source",
                          which is the whole point of the task. We
                          render this *in addition to* the Campaign /
                          Flow badge above so admins see both axes of
                          attribution (the campaign that ran, and the
                          template the campaign was built from). */}
                      {s.triggeredByTemplateId ? (() => {
                        const sourceTemplate = templates.find(x => x.id === s.triggeredByTemplateId) ?? null;
                        const templateDisplayName = s.triggeredByTemplateName ?? sourceTemplate?.name ?? `#${s.triggeredByTemplateId}`;
                        return (
                          <button
                            type="button"
                            onClick={() => {
                              // Prefer opening the editor (most useful
                              // action — admins are here to fix the
                              // typo). If the template can't be loaded
                              // (deleted, or a global template the
                              // current org doesn't have edit rights
                              // on), fall back to filtering the list
                              // by template id so admins can still see
                              // every bounce it caused.
                              if (sourceTemplate) {
                                setEditingTemplate(sourceTemplate);
                                setTemplateForm({
                                  name: sourceTemplate.name,
                                  category: sourceTemplate.category,
                                  bodyHtml: sourceTemplate.bodyHtml,
                                  bodyText: '',
                                });
                                setShowTemplateDialog(true);
                              } else {
                                setSuppressionSource(`template:${s.triggeredByTemplateId}`);
                              }
                            }}
                            title={sourceTemplate ? 'Open template editor' : 'Filter by this template'}
                            data-testid={`suppression-source-template-${s.id}`}
                            className="text-[10px] uppercase tracking-wide px-2 py-0.5 rounded border bg-violet-500/10 text-violet-300 border-violet-500/30 hover:bg-violet-500/20"
                          >
                            Template: {templateDisplayName}
                          </button>
                        );
                      })() : null}
                      {/* Task #1548 — flag suppressions that arrived after a
                          recent admin re-enable so the previous "fix" isn't
                          silently undone. Tooltip surfaces who acted and when
                          (incl. the replacement address, when one was used). */}
                      {s.recentReenable && (() => {
                        const r = s.recentReenable;
                        const when = new Date(r.at).toLocaleString();
                        const actor = r.actorName ?? 'an admin';
                        const role = r.actorRole ? ` (${r.actorRole})` : '';
                        const detail = r.action === 'reenable_with_replacement' && r.replacementEmail
                          ? `Re-enabled ${when} by ${actor}${role} with replacement ${r.replacementEmail} — but the new address bounced again.`
                          : `Re-enabled ${when} by ${actor}${role} — but the address bounced again.`;
                        return (
                          <span
                            className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wide px-2 py-0.5 rounded border bg-amber-500/15 text-amber-300 border-amber-500/40 cursor-help"
                            title={detail}
                            data-testid={`suppression-rebounce-${s.id}`}
                            data-rebounce-actor={actor}
                            data-rebounce-at={r.at}
                          >
                            <AlertTriangle className="w-3 h-3" />
                            Re-bounced after re-enable
                          </span>
                        );
                      })()}
                    </div>
                    {s.description && (
                      <p className="text-xs text-zinc-300 mt-1">{s.description}</p>
                    )}
                    <p className="text-xs text-muted-foreground mt-1">
                      Triggered {new Date(s.createdAt).toLocaleString()}
                      {s.messageId && (
                        <>
                          {' · '}
                          <span className="font-mono" title="Postmark MessageID">msg {s.messageId.slice(0, 8)}…</span>
                        </>
                      )}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {s.messageId && (
                      // Task #1556 — one-click jump from a suppression to
                      // the rendered Postmark message that bounced.
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => openMessagePreview(s)}
                        className="h-8 px-2 text-sky-400 hover:text-sky-300 hover:bg-sky-500/10 gap-1.5"
                        title="View the bounced email body"
                        data-testid={`suppression-view-message-${s.id}`}
                      >
                        <Eye className="w-4 h-4" />
                        <span className="text-xs hidden sm:inline">View message</span>
                      </Button>
                    )}
                    {s.reason === 'bounced' && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => openReenableDialog(s)}
                        className="h-8 px-2 text-emerald-400 hover:text-emerald-300 hover:bg-emerald-500/10 gap-1.5"
                        title="Re-enable this address (e.g. after fixing a typo)"
                        data-testid={`suppression-reenable-${s.id}`}
                      >
                        <RotateCcw className="w-4 h-4" />
                        <span className="text-xs hidden sm:inline">Re-enable</span>
                      </Button>
                    )}
                    <Button size="sm" variant="ghost" onClick={() => removeSuppression(s.id)} className="h-8 px-2 text-red-400">
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {/* ── RE-ENABLE SUPPRESSION DIALOG ── */}
      <Dialog open={!!reenableTarget} onOpenChange={(open) => { if (!open) closeReenableDialog(); }}>
        <DialogContent className="max-w-lg bg-card border-white/10" data-testid="suppression-reenable-dialog">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <MailCheck className="w-5 h-5 text-emerald-400" />
              Re-enable email
            </DialogTitle>
          </DialogHeader>
          {reenableTarget && (
            <div className="space-y-4 py-2">
              <div className="rounded-lg bg-white/5 border border-white/10 p-3">
                <p className="text-xs text-muted-foreground uppercase tracking-wide">Currently suppressed</p>
                <p className="text-sm font-mono text-white mt-1 break-all">{reenableTarget.email}</p>
                <p className="text-xs text-muted-foreground mt-2">
                  {SUPPRESSION_REASON_LABEL[reenableTarget.reason] ?? reenableTarget.reason}
                  {reenableTarget.bounceType && <> · <span className="text-zinc-300">{reenableTarget.bounceType}</span></>}
                </p>
                {reenableTarget.description && (
                  <p className="text-xs text-zinc-300 mt-1">{reenableTarget.description}</p>
                )}
              </div>

              {!reenablePreview && (
                <>
                  <div className="space-y-1.5">
                    <Label htmlFor="reenable-replacement">Corrected email (optional)</Label>
                    <Input
                      id="reenable-replacement"
                      type="email"
                      value={reenableReplacement}
                      onChange={(e) => setReenableReplacement(e.target.value)}
                      placeholder="member@example.com"
                      className="bg-background border-white/10"
                      data-testid="suppression-reenable-replacement-input"
                    />
                    <p className="text-xs text-muted-foreground">
                      Leave blank to simply confirm the original address. Enter a new address (e.g. fixing a typo like
                      {' '}<span className="font-mono text-zinc-300">{reenableTarget.email}</span>) to update the linked
                      member's contact email at the same time.
                    </p>
                  </div>
                </>
              )}

              {reenablePreview && (
                <div className="rounded-lg bg-amber-500/10 border border-amber-500/30 p-3 space-y-2">
                  <p className="text-sm text-amber-300 font-semibold flex items-center gap-1.5">
                    <AlertCircle className="w-4 h-4" />
                    Confirm replacement
                  </p>
                  <p className="text-xs text-zinc-200">
                    The address <span className="font-mono">{reenableTarget.email}</span> will be replaced with{' '}
                    <span className="font-mono text-emerald-300">{reenableReplacement.trim()}</span> on the records below.
                  </p>
                  {reenablePreview.matchedMembers.length === 0 && reenablePreview.matchedUsers.length === 0 && (
                    <p className="text-xs text-zinc-300">
                      No member or user account is currently linked to <span className="font-mono">{reenableTarget.email}</span>.
                      The suppression will be removed but no contact record will change.
                    </p>
                  )}
                  {reenablePreview.matchedMembers.length > 0 && (
                    <div data-testid="suppression-reenable-preview-members">
                      <p className="text-xs text-zinc-400 uppercase tracking-wide mt-1">Members</p>
                      <ul className="text-xs text-white mt-1 space-y-0.5">
                        {reenablePreview.matchedMembers.map(m => (
                          <li key={m.id}>• {m.name || `Member #${m.id}`} <span className="text-zinc-400 font-mono">({m.email})</span></li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {reenablePreview.matchedUsers.length > 0 && (
                    <div data-testid="suppression-reenable-preview-users">
                      <p className="text-xs text-zinc-400 uppercase tracking-wide mt-1">Login accounts</p>
                      <ul className="text-xs text-white mt-1 space-y-0.5">
                        {reenablePreview.matchedUsers.map(u => (
                          <li key={u.id}>• {u.displayName || `User #${u.id}`} <span className="text-zinc-400 font-mono">({u.email})</span></li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={closeReenableDialog} disabled={reenableSubmitting}>Cancel</Button>
            {reenablePreview && (
              <Button
                variant="ghost"
                onClick={() => setReenablePreview(null)}
                disabled={reenableSubmitting}
              >
                Back
              </Button>
            )}
            <Button
              onClick={submitReenable}
              disabled={reenableSubmitting}
              className="bg-emerald-600 hover:bg-emerald-500 text-white"
              data-testid="suppression-reenable-submit"
            >
              {reenableSubmitting
                ? 'Working…'
                : reenablePreview
                  ? 'Confirm & re-enable'
                  : reenableReplacement.trim()
                    ? 'Review change'
                    : 'Re-enable'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── CAMPAIGN DIALOG ── */}
      <Dialog open={showCampaignDialog} onOpenChange={setShowCampaignDialog}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto bg-card border-white/10">
          <DialogHeader>
            <DialogTitle>{editingCampaign ? 'Edit Campaign' : 'New Campaign'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5 col-span-2">
                <Label>Campaign Name *</Label>
                <Input value={campaignForm.name} onChange={e => setCampaignForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Summer Tournament Promo" className="bg-background border-white/10" />
              </div>
              <div className="space-y-1.5">
                <Label>Email Subject (Variant A)</Label>
                <Input value={campaignForm.subject} onChange={e => setCampaignForm(f => ({ ...f, subject: e.target.value }))} placeholder="Subject line…" className="bg-background border-white/10" />
              </div>
              <div className="space-y-1.5">
                <Label>Subject Variant B (A/B Test)</Label>
                <Input value={campaignForm.subjectVariantB} onChange={e => setCampaignForm(f => ({ ...f, subjectVariantB: e.target.value }))} placeholder="Optional alternative subject…" className="bg-background border-white/10" />
              </div>
              <div className="space-y-1.5 col-span-2">
                <Label>Preview Text</Label>
                <Input value={campaignForm.previewText} onChange={e => setCampaignForm(f => ({ ...f, previewText: e.target.value }))} placeholder="Short preview shown in inbox…" className="bg-background border-white/10" />
              </div>
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label>Email Body (HTML)</Label>
                {templates.length > 0 && (
                  <select
                    className="text-xs bg-background border border-white/10 rounded px-2 py-1 text-muted-foreground"
                    onChange={e => { const t = templates.find(x => String(x.id) === e.target.value); if (t) applyTemplate(t); }}
                    defaultValue=""
                  >
                    <option value="">Use a template…</option>
                    {templates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </select>
                )}
              </div>
              <Textarea
                value={campaignForm.bodyHtml}
                onChange={e => setCampaignForm(f => ({ ...f, bodyHtml: e.target.value }))}
                placeholder="<p>Your email content here...</p>"
                className="bg-background border-white/10 font-mono text-xs h-40"
              />
              <p className="text-xs text-muted-foreground">Unsubscribe link and open-tracking pixel are added automatically.</p>
            </div>

            <div className="space-y-1.5">
              <Label>Plain Text Body (optional)</Label>
              <Textarea value={campaignForm.bodyText} onChange={e => setCampaignForm(f => ({ ...f, bodyText: e.target.value }))} placeholder="Plain text version…" className="bg-background border-white/10 h-20 text-sm" />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label>Channels</Label>
                <div className="flex gap-3">
                  {['email', 'push'].map(ch => (
                    <label key={ch} className="flex items-center gap-1.5 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={campaignForm.channels.includes(ch)}
                        onChange={e => setCampaignForm(f => ({ ...f, channels: e.target.checked ? [...f.channels, ch] : f.channels.filter(c => c !== ch) }))}
                        className="rounded"
                      />
                      <span className="text-sm capitalize text-white">{ch}</span>
                    </label>
                  ))}
                </div>
              </div>
              <div className="space-y-1.5">
                <Label>Recipient Segment</Label>
                <select
                  value={campaignForm.segmentId}
                  onChange={e => setCampaignForm(f => ({ ...f, segmentId: e.target.value }))}
                  className="w-full bg-background border border-white/10 rounded-md px-3 py-2 text-sm text-white"
                >
                  <option value="">All eligible members</option>
                  {segments.map(s => <option key={s.id} value={s.id}>{s.name} (~{s.estimatedCount})</option>)}
                </select>
              </div>

              <div className="space-y-1.5">
                <Label>Type</Label>
                <select
                  value={campaignForm.type}
                  onChange={e => setCampaignForm(f => ({ ...f, type: e.target.value }))}
                  className="w-full bg-background border border-white/10 rounded-md px-3 py-2 text-sm text-white"
                >
                  <option value="one_off">One-Off</option>
                  <option value="drip">Drip Step</option>
                </select>
              </div>

              {/* Task #1953 — let admins attach (or change) the source
                  template after the fact without overwriting the body.
                  The "Use a template…" picker above the body editor
                  also sets `templateId` but it overwrites bodyHtml /
                  bodyText (the body-replace flow). This dropdown is
                  the attribution-only flow: pick which template the
                  campaign was originally based on so bounce reports
                  attribute correctly, even when the body was already
                  hand-edited. */}
              <div className="space-y-1.5">
                <Label>Source Template</Label>
                <select
                  value={campaignForm.templateId}
                  onChange={e => setCampaignForm(f => ({ ...f, templateId: e.target.value }))}
                  className="w-full bg-background border border-white/10 rounded-md px-3 py-2 text-sm text-white"
                  data-testid="campaign-source-template-select"
                >
                  <option value="">No source template</option>
                  {templates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
                <p className="text-xs text-muted-foreground">Changes attribution only — body is not modified.</p>
              </div>

              {campaignForm.type === 'drip' && (
                <>
                  <div className="space-y-1.5">
                    <Label>Drip Series</Label>
                    <select
                      value={campaignForm.dripSeriesId}
                      onChange={e => setCampaignForm(f => ({ ...f, dripSeriesId: e.target.value }))}
                      className="w-full bg-background border border-white/10 rounded-md px-3 py-2 text-sm text-white"
                    >
                      <option value="">Select series…</option>
                      {dripSeries.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </select>
                  </div>
                  <div className="space-y-1.5">
                    <Label>Send on Day</Label>
                    <Input type="number" value={campaignForm.dripDelayDays} onChange={e => setCampaignForm(f => ({ ...f, dripDelayDays: e.target.value }))} min={0} className="bg-background border-white/10" />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Step Order</Label>
                    <Input type="number" value={campaignForm.dripOrder} onChange={e => setCampaignForm(f => ({ ...f, dripOrder: e.target.value }))} min={0} className="bg-background border-white/10" />
                  </div>
                </>
              )}
            </div>

            {campaignForm.bodyHtml && (
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Email Preview</Label>
                <div className="border border-white/10 rounded-lg overflow-hidden max-h-48 overflow-y-auto bg-white">
                  <iframe
                    srcDoc={campaignForm.bodyHtml}
                    className="w-full h-48"
                    title="Email preview"
                    sandbox="allow-same-origin"
                  />
                </div>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowCampaignDialog(false)}>Cancel</Button>
            <Button onClick={saveCampaign}>{editingCampaign ? 'Save Changes' : 'Create Campaign'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── SEGMENT DIALOG ── */}
      <Dialog open={showSegmentDialog} onOpenChange={setShowSegmentDialog}>
        <DialogContent className="max-w-xl bg-card border-white/10">
          <DialogHeader>
            <DialogTitle>{editingSegment ? 'Edit Segment' : 'New Segment'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label>Segment Name *</Label>
              <Input value={segmentForm.name} onChange={e => setSegmentForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Full Members" className="bg-background border-white/10" />
            </div>
            <div className="space-y-1.5">
              <Label>Description</Label>
              <Input value={segmentForm.description} onChange={e => setSegmentForm(f => ({ ...f, description: e.target.value }))} placeholder="Optional description…" className="bg-background border-white/10" />
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>Filter Rules</Label>
                <Button size="sm" variant="ghost" onClick={() => setSegmentForm(f => ({ ...f, rules: [...f.rules, { field: 'role', operator: 'eq', value: 'player' }] }))} className="h-7 px-2 text-xs gap-1">
                  <Plus className="w-3 h-3" /> Add Rule
                </Button>
              </div>
              {segmentForm.rules.map((rule, i) => (
                <div key={i} className="flex gap-2 items-center">
                  <select
                    value={rule.field}
                    onChange={e => setSegmentForm(f => ({ ...f, rules: f.rules.map((r, j) => j === i ? { ...r, field: e.target.value } : r) }))}
                    className="flex-1 bg-background border border-white/10 rounded px-2 py-1.5 text-sm text-white"
                  >
                    {SEGMENT_FIELDS.map(sf => <option key={sf.value} value={sf.value}>{sf.label}</option>)}
                  </select>
                  <select
                    value={rule.operator}
                    onChange={e => setSegmentForm(f => ({ ...f, rules: f.rules.map((r, j) => j === i ? { ...r, operator: e.target.value } : r) }))}
                    className="w-20 bg-background border border-white/10 rounded px-2 py-1.5 text-sm text-white"
                  >
                    <option value="eq">is</option>
                    <option value="neq">is not</option>
                  </select>
                  <Input
                    value={rule.value}
                    onChange={e => setSegmentForm(f => ({ ...f, rules: f.rules.map((r, j) => j === i ? { ...r, value: e.target.value } : r) }))}
                    placeholder="Value…"
                    className="flex-1 bg-background border-white/10 text-sm"
                  />
                  <Button size="sm" variant="ghost" onClick={() => setSegmentForm(f => ({ ...f, rules: f.rules.filter((_, j) => j !== i) }))} className="h-8 px-2 text-red-400">
                    <X className="w-3.5 h-3.5" />
                  </Button>
                </div>
              ))}
              <p className="text-xs text-muted-foreground">Segments are refreshed when saved. All rules are applied as AND conditions.</p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowSegmentDialog(false)}>Cancel</Button>
            <Button onClick={saveSegment}>{editingSegment ? 'Save Changes' : 'Create Segment'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── DRIP SERIES DIALOG ── */}
      <Dialog open={showDripDialog} onOpenChange={setShowDripDialog}>
        <DialogContent className="max-w-md bg-card border-white/10">
          <DialogHeader>
            <DialogTitle>{editingDrip ? 'Edit Drip Series' : 'New Drip Series'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label>Series Name *</Label>
              <Input value={dripForm.name} onChange={e => setDripForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. New Member Welcome Series" className="bg-background border-white/10" />
            </div>
            <div className="space-y-1.5">
              <Label>Description</Label>
              <Textarea value={dripForm.description} onChange={e => setDripForm(f => ({ ...f, description: e.target.value }))} className="bg-background border-white/10 h-20 text-sm" />
            </div>
            <div className="space-y-1.5">
              <Label>Trigger</Label>
              <select
                value={dripForm.trigger}
                onChange={e => setDripForm(f => ({ ...f, trigger: e.target.value }))}
                className="w-full bg-background border border-white/10 rounded-md px-3 py-2 text-sm text-white"
              >
                {DRIP_TRIGGERS.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </div>
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={dripForm.isActive} onChange={e => setDripForm(f => ({ ...f, isActive: e.target.checked }))} />
              <span className="text-sm text-white">Active</span>
            </label>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowDripDialog(false)}>Cancel</Button>
            <Button onClick={saveDrip}>{editingDrip ? 'Save Changes' : 'Create Series'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── TEMPLATE DIALOG ── */}
      <Dialog open={showTemplateDialog} onOpenChange={setShowTemplateDialog}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto bg-card border-white/10">
          <DialogHeader>
            <DialogTitle>{editingTemplate ? 'Edit Template' : 'New Template'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label>Template Name *</Label>
                <Input value={templateForm.name} onChange={e => setTemplateForm(f => ({ ...f, name: e.target.value }))} className="bg-background border-white/10" />
              </div>
              <div className="space-y-1.5">
                <Label>Category</Label>
                <Input value={templateForm.category} onChange={e => setTemplateForm(f => ({ ...f, category: e.target.value }))} placeholder="general, promotions, events…" className="bg-background border-white/10" />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>HTML Body *</Label>
              <Textarea value={templateForm.bodyHtml} onChange={e => setTemplateForm(f => ({ ...f, bodyHtml: e.target.value }))} className="bg-background border-white/10 font-mono text-xs h-48" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowTemplateDialog(false)}>Cancel</Button>
            <Button onClick={saveTemplate}>{editingTemplate ? 'Save Changes' : 'Create Template'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── SCHEDULE DIALOG ── */}
      <Dialog open={!!showScheduleDialog} onOpenChange={() => setShowScheduleDialog(null)}>
        <DialogContent className="max-w-sm bg-card border-white/10">
          <DialogHeader>
            <DialogTitle>Schedule Campaign</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <p className="text-sm text-muted-foreground">Choose when to send "{showScheduleDialog?.name}"</p>
            <div className="space-y-1.5">
              <Label>Send At</Label>
              <Input type="datetime-local" value={scheduleAt} onChange={e => setScheduleAt(e.target.value)} className="bg-background border-white/10" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowScheduleDialog(null)}>Cancel</Button>
            <Button onClick={scheduleCampaign}>Schedule</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── ADD SUPPRESSION DIALOG ── */}
      <Dialog open={showSuppressionDialog} onOpenChange={setShowSuppressionDialog}>
        <DialogContent className="max-w-sm bg-card border-white/10">
          <DialogHeader>
            <DialogTitle>Add Suppression</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <p className="text-sm text-muted-foreground">Emails on the suppression list will never receive marketing campaigns.</p>
            <div className="space-y-1.5">
              <Label>Email Address</Label>
              <Input value={suppressionEmail} onChange={e => setSuppressionEmail(e.target.value)} placeholder="member@example.com" className="bg-background border-white/10" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowSuppressionDialog(false)}>Cancel</Button>
            <Button onClick={addSuppression}>Add Suppression</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── STATS DIALOG ── */}
      <Dialog open={!!showStatsDialog} onOpenChange={() => setShowStatsDialog(null)}>
        <DialogContent className="max-w-md bg-card border-white/10">
          <DialogHeader>
            <DialogTitle>Campaign Analytics</DialogTitle>
          </DialogHeader>
          {statsData && (
            <div className="space-y-4 py-2">
              <p className="font-semibold text-white">{statsData.campaign?.name}</p>
              <div className="grid grid-cols-2 gap-3">
                {[
                  { label: 'Total Sent', value: statsData.stats?.totalSent ?? 0, color: 'text-white' },
                  { label: 'Opened', value: `${statsData.stats?.openRate ?? 0}%`, color: 'text-green-400' },
                  { label: 'Clicked', value: `${statsData.stats?.clickRate ?? 0}%`, color: 'text-blue-400' },
                  { label: 'Unsubscribed', value: `${statsData.stats?.unsubscribeRate ?? 0}%`, color: 'text-red-400' },
                ].map(kpi => (
                  <Card key={kpi.label} className="p-3 bg-background border-white/5 text-center">
                    <p className="text-xs text-muted-foreground uppercase">{kpi.label}</p>
                    <p className={`text-xl font-bold mt-1 ${kpi.color}`}>{kpi.value}</p>
                  </Card>
                ))}
              </div>
              <PushDeliveryStatsCard
                totalPushSent={statsData.stats?.totalPushSent}
                totalPushFailed={statsData.stats?.totalPushFailed}
                totalPushAttempted={statsData.stats?.totalPushAttempted}
                pushFailureRate={statsData.stats?.pushFailureRate}
              />

              {statsData.campaign?.sentAt && (
                <p className="text-xs text-muted-foreground">Sent: {new Date(statsData.campaign.sentAt).toLocaleString()}</p>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowStatsDialog(null)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── BOUNCED MESSAGE PREVIEW DIALOG (Task #1556) ── */}
      <Dialog open={!!messagePreviewSuppression} onOpenChange={(open) => { if (!open) closeMessagePreview(); }}>
        <DialogContent className="max-w-3xl max-h-[90vh] bg-card border-white/10" data-testid="bounced-message-dialog">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Mail className="w-5 h-5 text-sky-400" />
              Bounced message {messagePreviewSuppression && <span className="text-muted-foreground font-normal">— {messagePreviewSuppression.email}</span>}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            {messagePreviewLoading && (
              <div className="py-12 text-center text-sm text-muted-foreground" data-testid="bounced-message-loading">
                Loading message from Postmark…
              </div>
            )}
            {!messagePreviewLoading && messagePreviewError && (
              <Card className="p-4 bg-amber-500/10 border-amber-500/30" data-testid="bounced-message-error">
                <p className="text-sm text-amber-300 flex items-start gap-2">
                  <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                  <span>{messagePreviewError}</span>
                </p>
                {messagePreviewSuppression?.messageId && (
                  <p className="text-xs text-muted-foreground mt-2 font-mono">
                    MessageID: {messagePreviewSuppression.messageId}
                  </p>
                )}
              </Card>
            )}
            {!messagePreviewLoading && !messagePreviewError && messagePreviewBody && (
              <>
                <div className="rounded-lg bg-white/5 border border-white/10 p-3 text-xs space-y-1">
                  <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                    <span className="text-muted-foreground uppercase tracking-wide">Subject</span>
                    <span className="text-white font-medium" data-testid="bounced-message-subject">{messagePreviewBody.subject || '(no subject)'}</span>
                    <span className="text-muted-foreground uppercase tracking-wide">From</span>
                    <span className="text-zinc-200 font-mono break-all">{messagePreviewBody.from || '—'}</span>
                    <RecipientList
                      label="To"
                      addresses={messagePreviewBody.to}
                      fallback={messagePreviewBody.recipients.join(', ') || '—'}
                      testId="bounced-message-to"
                    />
                    {messagePreviewBody.cc.length > 0 && (
                      <RecipientList
                        label="Cc"
                        addresses={messagePreviewBody.cc}
                        testId="bounced-message-cc"
                      />
                    )}
                    {messagePreviewBody.bcc.length > 0 && (
                      <RecipientList
                        label="Bcc"
                        addresses={messagePreviewBody.bcc}
                        testId="bounced-message-bcc"
                      />
                    )}
                    {messagePreviewBody.receivedAt && (
                      <>
                        <span className="text-muted-foreground uppercase tracking-wide">Sent</span>
                        <span className="text-zinc-200">{new Date(messagePreviewBody.receivedAt).toLocaleString()}</span>
                      </>
                    )}
                    {messagePreviewBody.status && (
                      <>
                        <span className="text-muted-foreground uppercase tracking-wide">Status</span>
                        <span className="text-zinc-200">{messagePreviewBody.status}</span>
                      </>
                    )}
                    {messagePreviewBody.tag && (
                      <>
                        <span className="text-muted-foreground uppercase tracking-wide">Tag</span>
                        <span className="text-zinc-200">{messagePreviewBody.tag}</span>
                      </>
                    )}
                  </div>
                </div>

                <div className="flex gap-1 border-b border-white/10" data-testid="bounced-message-tabs">
                  <button
                    type="button"
                    onClick={() => setMessagePreviewTab('html')}
                    disabled={!messagePreviewBody.htmlBody}
                    className={`px-3 py-1.5 text-xs uppercase tracking-wide border-b-2 transition ${
                      messagePreviewTab === 'html'
                        ? 'border-sky-400 text-sky-300'
                        : 'border-transparent text-muted-foreground hover:text-zinc-300 disabled:opacity-40 disabled:cursor-not-allowed'
                    }`}
                    data-testid="bounced-message-tab-html"
                  >
                    HTML
                  </button>
                  <button
                    type="button"
                    onClick={() => setMessagePreviewTab('text')}
                    disabled={!messagePreviewBody.textBody}
                    className={`px-3 py-1.5 text-xs uppercase tracking-wide border-b-2 transition ${
                      messagePreviewTab === 'text'
                        ? 'border-sky-400 text-sky-300'
                        : 'border-transparent text-muted-foreground hover:text-zinc-300 disabled:opacity-40 disabled:cursor-not-allowed'
                    }`}
                    data-testid="bounced-message-tab-text"
                  >
                    Plain text
                  </button>
                  <button
                    type="button"
                    onClick={() => setMessagePreviewTab('headers')}
                    className={`px-3 py-1.5 text-xs uppercase tracking-wide border-b-2 transition ${
                      messagePreviewTab === 'headers'
                        ? 'border-sky-400 text-sky-300'
                        : 'border-transparent text-muted-foreground hover:text-zinc-300'
                    }`}
                    data-testid="bounced-message-tab-headers"
                  >
                    Metadata
                  </button>
                </div>

                {messagePreviewTab === 'html' && (
                  messagePreviewBody.htmlBody ? (
                    <div className="overflow-y-auto max-h-[55vh] bg-white rounded-lg" data-testid="bounced-message-html">
                      <iframe
                        srcDoc={messagePreviewBody.htmlBody}
                        className="w-full h-[500px]"
                        title="Bounced message preview"
                        sandbox=""
                      />
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground py-6 text-center">No HTML body recorded for this message.</p>
                  )
                )}
                {messagePreviewTab === 'text' && (
                  messagePreviewBody.textBody ? (
                    <pre className="overflow-auto max-h-[55vh] bg-black/40 rounded-lg p-3 text-xs text-zinc-200 whitespace-pre-wrap font-mono" data-testid="bounced-message-text">
{messagePreviewBody.textBody}
                    </pre>
                  ) : (
                    <p className="text-sm text-muted-foreground py-6 text-center">No plain-text body recorded for this message.</p>
                  )
                )}
                {messagePreviewTab === 'headers' && (
                  <div className="overflow-auto max-h-[55vh] bg-black/40 rounded-lg p-3 text-xs text-zinc-200 font-mono space-y-1" data-testid="bounced-message-headers">
                    <div><span className="text-muted-foreground">MessageID: </span>{messagePreviewBody.messageId}</div>
                    {messagePreviewBody.metadata && Object.keys(messagePreviewBody.metadata).length > 0 ? (
                      Object.entries(messagePreviewBody.metadata).map(([k, v]) => (
                        <div key={k}><span className="text-muted-foreground">{k}: </span>{v}</div>
                      ))
                    ) : (
                      <div className="text-muted-foreground">No metadata recorded.</div>
                    )}
                  </div>
                )}

                {/* Task #1936 — resend the bounced message to a corrected address. */}
                {(() => {
                  const supId = messagePreviewSuppression?.id;
                  const origEmail = messagePreviewSuppression?.email.toLowerCase() ?? '';
                  // The suppression list is the source of truth for "is this
                  // address still suppressed". After /reenable, the row
                  // disappears from the list and the resend is unlocked
                  // even when the destination matches the original recipient.
                  const stillSuppressed = supId !== undefined && suppressions.some(s => s.id === supId);
                  const trimmed = resendTo.trim();
                  const lowerTo = trimmed.toLowerCase();
                  const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed);
                  const isReplacement = !!trimmed && lowerTo !== origEmail;
                  const canResend = !!messagePreviewBody && validEmail && (!stillSuppressed || isReplacement) && !resendSubmitting;
                  const gateHint = stillSuppressed && !isReplacement
                    ? 'Re-enable the address (or enter a different one) before resending.'
                    : null;
                  return (
                    <div className="rounded-lg bg-white/5 border border-white/10 p-3 space-y-2" data-testid="bounced-message-resend">
                      <div className="flex items-center gap-2 text-xs text-zinc-300">
                        <Send className="w-3.5 h-3.5 text-sky-400" />
                        <span className="uppercase tracking-wide font-medium">Resend to corrected address</span>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Re-fires the original payload through the same transactional mailer.
                        {stillSuppressed && (
                          <> The destination must differ from <span className="font-mono text-zinc-300">{origEmail}</span> until the suppression is re-enabled.</>
                        )}
                      </p>
                      <div className="flex flex-col sm:flex-row gap-2">
                        <Input
                          type="email"
                          value={resendTo}
                          onChange={(e) => setResendTo(e.target.value)}
                          placeholder="recipient@example.com"
                          className="flex-1"
                          data-testid="bounced-message-resend-to"
                          disabled={resendSubmitting}
                        />
                        <Button
                          onClick={submitResend}
                          disabled={!canResend}
                          className="gap-2"
                          data-testid="bounced-message-resend-submit"
                        >
                          <Send className="w-4 h-4" />
                          {resendSubmitting ? 'Resending…' : 'Resend'}
                        </Button>
                      </div>
                      {gateHint && (
                        <p className="text-xs text-amber-300 flex items-center gap-1.5" data-testid="bounced-message-resend-gate">
                          <AlertCircle className="w-3.5 h-3.5" />
                          {gateHint}
                        </p>
                      )}
                    </div>
                  );
                })()}
              </>
            )}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={closeMessagePreview} data-testid="bounced-message-close">Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── PREVIEW DIALOG ── */}
      <Dialog open={!!showPreviewDialog} onOpenChange={() => setShowPreviewDialog(null)}>
        <DialogContent className="max-w-2xl max-h-[90vh] bg-card border-white/10">
          <DialogHeader>
            <DialogTitle>Email Preview — {showPreviewDialog?.name}</DialogTitle>
          </DialogHeader>
          <div className="overflow-y-auto max-h-[70vh] bg-white rounded-lg">
            <iframe
              srcDoc={showPreviewDialog?.bodyHtml ?? '<p>No content</p>'}
              className="w-full h-[500px]"
              title="Preview"
              sandbox="allow-same-origin"
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowPreviewDialog(null)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/* ─── Suppression-source breakdown chart — Tasks #1557 / #1943 ─────────
 * Always rendered on the marketing dashboard so chronic offenders surface
 * without admins having to drill into the Suppressions tab. Bars are
 * clickable: a click hands the source key (`campaign:<id>` / `flow:<name>`
 * / `none`) to the parent which switches to Suppressions and applies the
 * matching filter.
 *
 * Task #1943 — the same component now serves both the bounce chart and the
 * spam-complaint chart, switched via the `reason` prop. Spam complaints
 * are arguably more urgent (Postmark/SES will throttle senders that
 * consistently get flagged) so they get their own chart instead of being
 * folded into the bounce numbers.
 */
type SuppressionChartReason = 'bounced' | 'spam_complaint';

interface BounceSourcesCardProps {
  data: {
    windowDays: number;
    /** Task #1943 — generic "total of the requested reason" field. */
    total: number;
    sources: Array<{
      key: string;
      label: string;
      campaignId: number | null;
      flow: string | null;
      count: number;
    }>;
    truncated: boolean;
  } | undefined;
  flowLabels: Record<string, string>;
  onBarClick: (sourceKey: string) => void;
  /** Defaults to 'bounced' to keep existing call-sites unchanged. */
  reason?: SuppressionChartReason;
  // Task #1942 — optional window picker. When omitted, the card renders
  // exactly as before (the existing unit tests rely on this default).
  // When provided, a small dropdown next to the title lets admins switch
  // between the supplied options and the parent re-fetches the chart.
  windowOptions?: ReadonlyArray<number>;
  selectedWindowDays?: number;
  onWindowDaysChange?: (days: number) => void;
}

const BOUNCE_BAR_COLOR_BY_KIND: Record<string, string> = {
  campaign: '#22c55e', // emerald — matches the Suppressions tab campaign chip
  flow: '#38bdf8',     // sky — matches the Suppressions tab flow chip
  none: '#71717a',     // zinc — neutral for unattributed
};

function bounceBarColor(key: string): string {
  if (key.startsWith('campaign:')) return BOUNCE_BAR_COLOR_BY_KIND.campaign;
  if (key.startsWith('flow:')) return BOUNCE_BAR_COLOR_BY_KIND.flow;
  return BOUNCE_BAR_COLOR_BY_KIND.none;
}

/**
 * Reason-specific copy + iconography. Centralised so the loading,
 * empty, and chart states stay consistent and a future third reason
 * (e.g. soft-bounces) only has to add one entry here.
 */
const SUPPRESSION_CHART_COPY: Record<SuppressionChartReason, {
  title: string;
  noun: string;
  pluralNoun: string;
  emptyState: string;
  loading: string;
  testIdPrefix: string;
  Icon: typeof AlertTriangle;
  iconClass: string;
}> = {
  bounced: {
    title: 'Bounces by source',
    noun: 'bounce',
    pluralNoun: 'bounces',
    emptyState: 'No bounces recorded in this window. Healthy deliverability.',
    loading: 'Loading bounce sources…',
    testIdPrefix: 'bounce',
    Icon: AlertTriangle,
    iconClass: 'text-amber-400',
  },
  spam_complaint: {
    title: 'Spam complaints by source',
    noun: 'spam complaint',
    pluralNoun: 'spam complaints',
    emptyState: 'No spam complaints recorded in this window. Sender reputation looks safe.',
    loading: 'Loading spam complaint sources…',
    // Task #1943 — distinct testid prefix so the spam chart can be
    // targeted independently in tests / e2e selectors without clashing
    // with the bounce chart on the same page.
    testIdPrefix: 'spam',
    Icon: Flag,
    iconClass: 'text-rose-400',
  },
};

/**
 * Task #2236 — Renders the per-campaign push fan-out delivery counts on
 * the campaign stats dialog. The marketing API surfaces
 * `totalPushSent`, `totalPushFailed`, `totalPushAttempted`, and
 * `pushFailureRate` (Task #1786) directly off the campaign row, but the
 * stats dialog wasn't rendering them, so failed push deliveries stayed
 * invisible to admins. This card shows the "Push delivered: X / Y · N
 * failed" line and a red failure-rate chip when the rate is non-zero so
 * broken pipelines stand out at a glance. The card hides itself when
 * the campaign has zero push attempts AND zero failures so non-push
 * (e.g. email-only) campaigns stay visually quiet.
 */
export function PushDeliveryStatsCard({
  totalPushSent,
  totalPushFailed,
  totalPushAttempted,
  pushFailureRate,
}: {
  totalPushSent?: number | null;
  totalPushFailed?: number | null;
  totalPushAttempted?: number | null;
  pushFailureRate?: number | null;
}) {
  const pushSent = totalPushSent ?? 0;
  const pushFailed = totalPushFailed ?? 0;
  const pushAttempted = totalPushAttempted ?? (pushSent + pushFailed);
  const failureRate = pushFailureRate ?? 0;
  if (pushAttempted === 0 && pushFailed === 0) return null;
  return (
    <Card className="p-3 bg-background border-white/5" data-testid="push-delivery-stats">
      <div className="flex items-center justify-between gap-2">
        <div className="text-sm">
          <p className="text-xs text-muted-foreground uppercase">Push Delivery</p>
          <p className="text-white mt-1" data-testid="push-delivery-line">
            Push delivered: <span className="font-semibold">{pushSent}</span>
            {' / '}
            <span className="font-semibold">{pushAttempted}</span>
            {' · '}
            <span className={pushFailed > 0 ? 'text-red-400 font-semibold' : 'text-muted-foreground'}>
              {pushFailed} failed
            </span>
          </p>
        </div>
        {failureRate > 0 && (
          <span
            className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium bg-red-500/15 text-red-300 border border-red-500/30 whitespace-nowrap"
            data-testid="push-failure-rate-chip"
            title="Push deliveries are failing — check the notification audit log"
          >
            <AlertTriangle className="w-3 h-3" />
            {failureRate}% failure rate
          </span>
        )}
      </div>
    </Card>
  );
}

export function BounceSourcesCard({
  data,
  flowLabels,
  onBarClick,
  reason = 'bounced',
  windowOptions,
  selectedWindowDays,
  onWindowDaysChange,
}: BounceSourcesCardProps) {
  const copy = SUPPRESSION_CHART_COPY[reason];
  const cardTestId = `${copy.testIdPrefix}-sources-card`;
  const chartTestId = `${copy.testIdPrefix}-sources-chart`;
  const legendTestId = `${copy.testIdPrefix}-sources-legend`;
  const barTestId = (key: string) => `${copy.testIdPrefix}-source-bar-${key}`;
  const legendItemTestId = (key: string) => `${copy.testIdPrefix}-source-legend-${key}`;

  // Task #1942 — prefer the *user's* selection for the title so the
  // subtitle reflects the active window even during the brief refetch
  // gap when the cached data still belongs to the previous window.
  // Falls back to whatever the API echoed back (or 30) when the parent
  // didn't wire a picker (legacy callers / unit-test fixtures).
  const displayWindowDays = selectedWindowDays ?? data?.windowDays ?? 30;
  const showWindowPicker = !!windowOptions && windowOptions.length > 0 && !!onWindowDaysChange;

  // Task #1942 + #1943 — namespace the picker id/testid by reason so the
  // bounce and spam charts can both render their own picker on the same
  // dashboard without colliding on the (unique) `id`/`for` linkage.
  const windowPickerTestId = `${copy.testIdPrefix}-sources-window`;

  function renderWindowPicker() {
    if (!showWindowPicker || !windowOptions || !onWindowDaysChange) return null;
    return (
      <div className="flex items-center gap-2">
        <Label className="text-xs text-muted-foreground" htmlFor={windowPickerTestId}>Window</Label>
        <select
          id={windowPickerTestId}
          data-testid={windowPickerTestId}
          value={selectedWindowDays ?? displayWindowDays}
          onChange={e => onWindowDaysChange(Number(e.target.value))}
          className="h-8 rounded-md border border-white/10 bg-background px-2 text-xs text-white"
        >
          {windowOptions.map(d => (
            <option key={d} value={d}>Last {d} days</option>
          ))}
        </select>
      </div>
    );
  }

  if (!data) {
    return (
      <Card className="p-6 bg-card border-white/5" data-testid={cardTestId}>
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <p className="text-sm text-muted-foreground">{copy.loading}</p>
          {renderWindowPicker()}
        </div>
      </Card>
    );
  }

  if (!data.sources || data.sources.length === 0) {
    return (
      <Card className="p-6 bg-card border-white/5" data-testid={cardTestId}>
        <div className="flex items-start justify-between mb-2 gap-4 flex-wrap">
          <div>
            <p className="text-sm font-semibold text-white flex items-center gap-2">
              <copy.Icon className={`w-4 h-4 ${copy.iconClass}`} />
              {copy.title} — last {displayWindowDays} days
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">{copy.emptyState}</p>
          </div>
          {renderWindowPicker()}
        </div>
      </Card>
    );
  }

  // Friendly labels for the Y-axis (use flow label table where applicable
  // so admins see "Dues receipt" rather than the raw "dues_receipt" tag).
  const chartData = data.sources.map(s => {
    let displayLabel = s.label;
    if (s.flow && flowLabels[s.flow]) displayLabel = flowLabels[s.flow];
    // Truncate long campaign names so the Y-axis stays readable; the full
    // name is still visible in the tooltip.
    const truncated = displayLabel.length > 28 ? displayLabel.slice(0, 27) + '…' : displayLabel;
    return {
      key: s.key,
      label: truncated,
      fullLabel: displayLabel,
      count: s.count,
      campaignId: s.campaignId,
      flow: s.flow,
    };
  });

  // Recharts BarChart height: ~36px per row + padding. Min 200, so even a
  // single bar still looks like a chart and not a stray pixel.
  const chartHeight = Math.max(200, chartData.length * 44 + 40);
  const totalNoun = data.total === 1 ? copy.noun : copy.pluralNoun;

  return (
    <Card className="p-6 bg-card border-white/5" data-testid={cardTestId}>
      <div className="flex items-start justify-between mb-4 gap-4 flex-wrap">
        <div>
          <p className="text-sm font-semibold text-white flex items-center gap-2">
            <copy.Icon className={`w-4 h-4 ${copy.iconClass}`} />
            {copy.title} — last {displayWindowDays} days
          </p>
          <p className="text-xs text-muted-foreground mt-0.5">
            {data.total.toLocaleString()} total {totalNoun}
            {data.truncated ? ' · showing top 5 named sources' : ''}
            {' · click a bar to drill in'}
          </p>
        </div>
        {renderWindowPicker()}
      </div>
      <div style={{ width: '100%', height: chartHeight }} data-testid={chartTestId}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={chartData}
            layout="vertical"
            margin={{ top: 4, right: 24, bottom: 4, left: 8 }}
          >
            <XAxis type="number" allowDecimals={false} stroke="#71717a" fontSize={11} />
            <YAxis
              type="category"
              dataKey="label"
              width={180}
              stroke="#a1a1aa"
              fontSize={11}
              tick={{ fill: '#e4e4e7' }}
            />
            <Tooltip
              cursor={{ fill: 'rgba(255,255,255,0.04)' }}
              contentStyle={{ background: '#18181b', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, fontSize: 12 }}
              labelStyle={{ color: '#fafafa' }}
              formatter={(value: number, _name, ctx) => {
                const full = (ctx?.payload as { fullLabel?: string })?.fullLabel;
                return [value, full ?? copy.pluralNoun];
              }}
              labelFormatter={() => ''}
            />
            <Bar
              dataKey="count"
              radius={[0, 4, 4, 0]}
              cursor="pointer"
              onClick={(data) => {
                // Recharts v3 typed Bar onClick as
                // `(data: BarRectangleItem, index, event) => void`. The
                // underlying row is on `data.payload`, but a top-level
                // `key` is still surfaced on some chart variants — fall
                // through to it as a defensive fallback.
                const entry = data as { key?: string; payload?: { key?: string } } | undefined;
                const k = entry?.payload?.key ?? entry?.key;
                if (k) onBarClick(k);
              }}
            >
              {chartData.map(d => (
                <Cell
                  key={d.key}
                  fill={bounceBarColor(d.key)}
                  data-testid={barTestId(d.key)}
                />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      {/* Click-list fallback — keeps the chart usable in narrow viewports
          where a tiny bar is hard to tap, and gives a keyboard path. */}
      <div className="mt-3 flex flex-wrap gap-2" data-testid={legendTestId}>
        {chartData.map(d => (
          <button
            key={`legend-${d.key}`}
            type="button"
            onClick={() => onBarClick(d.key)}
            className="text-[11px] px-2 py-1 rounded border border-white/10 bg-white/5 hover:bg-white/10 text-zinc-200 flex items-center gap-1.5"
            data-testid={legendItemTestId(d.key)}
          >
            <span
              aria-hidden="true"
              className="w-2.5 h-2.5 rounded-sm"
              style={{ background: bounceBarColor(d.key) }}
            />
            <span className="font-mono text-zinc-400">{d.count}</span>
            <span>{d.fullLabel}</span>
          </button>
        ))}
      </div>
    </Card>
  );
}
