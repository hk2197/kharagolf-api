import { useEffect, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { useRoute, Link } from 'wouter';
import { useGetMe } from '@workspace/api-client-react';
import {
  ArrowLeft, Shield, FileText, CheckCircle2, AlertCircle, Pause, UserX,
  DollarSign, Clock, Users, Key, Gavel, MessageSquare, Download, Pin, Plus, Trash2,
  Award, Mail, Phone, Activity, CreditCard, Send, XCircle, AlertTriangle,
  MailCheck, MailX, MailWarning, History, ChevronDown, ChevronUp, ChevronRight,
  UserCheck, CheckCheck, Eye,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useToast } from '@/hooks/use-toast';
import { FollowButton } from '@/components/FollowButton';
import { useFolloweeIds } from '@/hooks/useFolloweeIds';
import {
  RejectionDeliveryChips,
  getDocRejectionDelivery,
  type RejectionNotification,
} from '@/components/RejectionDeliveryChips';

const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');

interface BouncedLevyForMember {
  levyId: number;
  name: string;
  currency: string;
  unresolvedFailedCount: number;
  channels: Record<string, number>;
  latestFailureAt: string | null;
  sampleError: string | null;
}

interface Summary360 {
  member: { id: number; userId: number | null; firstName: string; lastName: string; email: string | null; phone: string | null; memberNumber: string | null; tierName?: string | null; subscriptionStatus: string; joinDate: string };
  ext: { id: number; kycStatus: string; isVip: boolean; lifecycleStatus: string; lifecycleStatusUntil: string | null; lifecycleReason: string | null; creditLimit: string; joiningFee: string; refundableDeposit: string; internalTags: string[] | null; twoFactorEnabled: boolean };
  tier: { name: string; annualFee: string; currency: string } | null;
  counts: { documents: number; consents: number; familyLinks: number; openDisciplinary: number; openLevies: number; roundsPlayed: number; tournamentsPlayed: number };
  financial: { outstandingBalance: string; storeCreditBalance: string; loyaltyPoints: number; loyaltyTier: string | null; creditLimit: string };
  locker: { lockerNumber: string; expiryDate: string } | null;
  activeAccessCards: Array<{ id: number; cardNumber: string; cardType: string; cardLabel: string | null }>;
  activeCommittee: Array<{ id: number; committee: string; position: string; termEnd: string | null }>;
}

async function j<T = unknown>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: 'include', headers: { 'Content-Type': 'application/json' }, ...init });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? res.statusText);
  // Handle 204 No Content (delete endpoints) and other empty bodies
  if (res.status === 204 || res.headers.get('content-length') === '0') return undefined as T;
  const text = await res.text();
  if (!text) return undefined as T;
  try { return JSON.parse(text) as T; } catch { return undefined as T; }
}

const statusColor: Record<string, string> = {
  active: 'bg-green-500/20 text-green-400 border-green-500/30',
  frozen: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
  suspended: 'bg-red-500/20 text-red-400 border-red-500/30',
  resigned: 'bg-gray-500/20 text-gray-400 border-gray-500/30',
  deceased: 'bg-gray-500/20 text-gray-400 border-gray-500/30',
  transferred: 'bg-purple-500/20 text-purple-400 border-purple-500/30',
};

export default function Member360Page() {
  const [, params] = useRoute<{ id: string }>('/member-360/:id');
  const memberId = params ? parseInt(params.id) : 0;
  const { data: user } = useGetMe();
  const orgId = user?.organizationId;
  const { toast } = useToast();
  const qc = useQueryClient();
  const initialTab = (() => {
    if (typeof window === 'undefined') return 'overview';
    const sp = new URLSearchParams(window.location.search);
    return sp.get('tab') || 'overview';
  })();
  const [tab, setTab] = useState(initialTab);

  const base = `/api/organizations/${orgId}/members-360/${memberId}`;

  const { data: summary, isLoading } = useQuery<Summary360>({
    queryKey: ['member-360', orgId, memberId],
    enabled: !!orgId && !!memberId,
    queryFn: () => j<Summary360>(base + '/360'),
  });

  // Shared hook so member-360, club-members, and the players list all
  // pre-fetch follow state the same way and reuse the same query cache —
  // see artifacts/kharagolf-web/src/hooks/useFolloweeIds.ts (Task #1227).
  const followeeIds = useFolloweeIds();

  // Per-member bounced levy reminders (Task #243). Reuses the org-wide
  // /levies/bounced-reminders endpoint with a memberId filter so the
  // badge counts match the dashboard banner.
  const { data: bounced } = useQuery<{ levies: BouncedLevyForMember[]; totalBounced: number }>({
    queryKey: ['member-360', orgId, memberId, 'bounced-reminders'],
    enabled: !!orgId && !!memberId,
    queryFn: () => j(`/api/organizations/${orgId}/members-360/levies/bounced-reminders?memberId=${memberId}`),
    staleTime: 60 * 1000,
  });

  if (!orgId) return <div className="p-8 text-white/70">Loading…</div>;
  if (isLoading || !summary) return <div className="p-8 text-white/70">Loading member…</div>;

  const fullName = `${summary.member.firstName} ${summary.member.lastName}`.trim();
  const initials = (summary.member.firstName[0] ?? '') + (summary.member.lastName[0] ?? '');
  const lifecycle = summary.ext.lifecycleStatus;

  const refreshAll = () => {
    qc.invalidateQueries({ queryKey: ['member-360', orgId, memberId] });
    qc.invalidateQueries({ queryKey: ['member-360-tab'] });
  };

  // Task #263: deep link from a privacy "email retries exhausted" alert
  // (rendered in MessagesTab) back to the failing privacy request on the
  // Data tab. We switch tabs and then briefly highlight the request row so
  // the admin's eye lands on the right entry — the messages list and the
  // request live on the same page so a hard navigation would be jarring.
  const openDataRequest = (requestId: number) => {
    setTab('data');
    // The Data tab mounts asynchronously and its request list is fetched
    // on demand, so the target row may not exist on the first frame. Poll
    // briefly (up to ~2s) so a slow render doesn't lose the highlight.
    let attempts = 0;
    const tryHighlight = () => {
      const el = document.querySelector(`[data-testid="data-request-row-${requestId}"]`) as HTMLElement | null;
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.classList.add('ring-2', 'ring-red-500/70');
        setTimeout(() => el.classList.remove('ring-2', 'ring-red-500/70'), 2500);
        return;
      }
      if (attempts++ < 20) setTimeout(tryHighlight, 100);
    };
    setTimeout(tryHighlight, 80);
  };

  // Task #311: deep link from a levy-receipt push/SMS exhaustion alert
  // (rendered in MessagesTab) back to the failing levy charge on the
  // Financial tab. Mirrors {@link openDataRequest}: switch tabs, poll for
  // the target row, then briefly highlight it so the admin's eye lands on
  // the right charge.
  const openLevyCharge = (chargeId: number) => {
    setTab('financial');
    let attempts = 0;
    const tryHighlight = () => {
      const el = document.querySelector(`[data-testid="member-360-levy-charge-row-${chargeId}"]`) as HTMLElement | null;
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.classList.add('ring-2', 'ring-red-500/70');
        setTimeout(() => el.classList.remove('ring-2', 'ring-red-500/70'), 2500);
        return;
      }
      if (attempts++ < 20) setTimeout(tryHighlight, 100);
    };
    setTimeout(tryHighlight, 80);
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-neutral-950 to-black text-white p-6">
      <div className="max-w-7xl mx-auto space-y-6">
        <div className="flex items-center gap-3">
          <Link href={`${BASE}/club-members`}>
            <Button variant="ghost" size="sm"><ArrowLeft className="w-4 h-4 mr-2" />Back</Button>
          </Link>
          <h1 className="text-2xl font-light">Member 360°</h1>
        </div>

        {/* Header card */}
        <Card className="bg-white/5 border-white/10">
          <CardContent className="pt-6">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="flex items-center gap-4">
                <div className="w-16 h-16 rounded-full bg-gradient-to-br from-emerald-500 to-blue-500 flex items-center justify-center text-xl font-semibold">
                  {initials || '?'}
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <h2 className="text-xl font-semibold">{fullName}</h2>
                    {summary.ext.isVip && <Badge className="bg-amber-500/20 text-amber-400 border-amber-500/30">VIP</Badge>}
                    {summary.member.memberNumber && <Badge variant="outline" className="border-white/20">#{summary.member.memberNumber}</Badge>}
                  </div>
                  <div className="flex flex-wrap items-center gap-3 text-sm text-white/60 mt-1">
                    {summary.member.email && <span className="flex items-center gap-1"><Mail className="w-3 h-3" />{summary.member.email}</span>}
                    {summary.member.phone && <span className="flex items-center gap-1"><Phone className="w-3 h-3" />{summary.member.phone}</span>}
                    {summary.tier && <Badge variant="outline" className="border-emerald-500/30 text-emerald-400">{summary.tier.name}</Badge>}
                  </div>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Badge className={statusColor[lifecycle] ?? 'bg-white/10'}>{lifecycle}</Badge>
                <Badge variant="outline" className="border-white/20">KYC: {summary.ext.kycStatus}</Badge>
                {summary.ext.twoFactorEnabled && <Badge className="bg-emerald-500/20 text-emerald-400 border-emerald-500/30"><Shield className="w-3 h-3 mr-1" />2FA</Badge>}
                {summary.member.userId && user?.id !== summary.member.userId && (
                  <FollowButton userId={summary.member.userId} initialFollowing={followeeIds.includes(summary.member.userId)} />
                )}
              </div>
            </div>

            {bounced && bounced.levies.length > 0 && (
              <BouncedLevyRemindersForMember levies={bounced.levies} totalBounced={bounced.totalBounced} memberId={memberId} />
            )}

            {/* KPI grid */}
            <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-3 mt-6">
              <Kpi label="Outstanding" value={`₹${summary.financial.outstandingBalance}`} accent={parseFloat(summary.financial.outstandingBalance) > 0 ? 'text-red-400' : ''} />
              <Kpi label="Store Credit" value={`₹${summary.financial.storeCreditBalance}`} />
              <Kpi label="Loyalty Pts" value={String(summary.financial.loyaltyPoints)} accent={summary.financial.loyaltyTier ? 'text-amber-400' : ''} />
              <Kpi label="Rounds" value={String(summary.counts.roundsPlayed)} />
              <Kpi label="Tournaments" value={String(summary.counts.tournamentsPlayed)} />
              <Kpi label="Documents" value={String(summary.counts.documents)} />
              <Kpi label="Family" value={String(summary.counts.familyLinks)} />
            </div>
          </CardContent>
        </Card>

        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="bg-white/5 border border-white/10 flex-wrap h-auto">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="profile">Profile</TabsTrigger>
            <TabsTrigger value="documents">Docs ({summary.counts.documents})</TabsTrigger>
            <TabsTrigger value="consents">Consents</TabsTrigger>
            <TabsTrigger value="comms">Comms</TabsTrigger>
            <TabsTrigger value="family">Family ({summary.counts.familyLinks})</TabsTrigger>
            <TabsTrigger value="lifecycle">Lifecycle</TabsTrigger>
            <TabsTrigger value="financial">Financial</TabsTrigger>
            <TabsTrigger value="discipline">Discipline{summary.counts.openDisciplinary ? ` (${summary.counts.openDisciplinary})` : ''}</TabsTrigger>
            <TabsTrigger value="notes">Notes</TabsTrigger>
            <TabsTrigger value="access">Access</TabsTrigger>
            <TabsTrigger value="milestones">Milestones</TabsTrigger>
            <TabsTrigger value="messages">Messages</TabsTrigger>
            <TabsTrigger value="data">Data / GDPR</TabsTrigger>
            <TabsTrigger value="audit">Audit</TabsTrigger>
          </TabsList>

          <TabsContent value="overview" className="mt-4"><OverviewTab summary={summary} /></TabsContent>
          <TabsContent value="profile" className="mt-4"><ProfileTab base={base} onChange={refreshAll} /></TabsContent>
          <TabsContent value="documents" className="mt-4"><DocumentsTab base={base} /></TabsContent>
          <TabsContent value="consents" className="mt-4"><ConsentsTab base={base} /></TabsContent>
          <TabsContent value="comms" className="mt-4"><CommsTab base={base} /></TabsContent>
          <TabsContent value="family" className="mt-4"><FamilyTab base={base} orgId={orgId} memberId={memberId} /></TabsContent>
          <TabsContent value="lifecycle" className="mt-4"><LifecycleTab base={base} onChange={refreshAll} /></TabsContent>
          <TabsContent value="financial" className="mt-4"><FinancialTab base={base} /></TabsContent>
          <TabsContent value="discipline" className="mt-4"><DisciplineTab base={base} /></TabsContent>
          <TabsContent value="notes" className="mt-4"><NotesTab base={base} /></TabsContent>
          <TabsContent value="access" className="mt-4"><AccessTab base={base} /></TabsContent>
          <TabsContent value="milestones" className="mt-4"><MilestonesTab base={base} /></TabsContent>
          <TabsContent value="messages" className="mt-4"><MessagesTab base={base} onOpenDataRequest={openDataRequest} onOpenLevyCharge={openLevyCharge} /></TabsContent>
          <TabsContent value="data" className="mt-4"><DataRequestsTab base={base} /></TabsContent>
          <TabsContent value="audit" className="mt-4"><AuditTab base={base} orgId={orgId} memberId={memberId} onOpenDataRequest={openDataRequest} /></TabsContent>
        </Tabs>
      </div>
    </div>
  );
}

/**
 * Per-member bounced levy reminders banner (Task #243). Surfaces an at-a-glance
 * "Levy reminder failed" badge inside Member 360 listing each levy with
 * unresolved failures for this specific member. Each row deep-links to the
 * club-members page with `openLevy=<id>&highlightMember=<memberId>` so the
 * existing levy detail dialog opens with this member's row highlighted.
 */
function BouncedLevyRemindersForMember({
  levies, totalBounced, memberId,
}: { levies: BouncedLevyForMember[]; totalBounced: number; memberId: number }) {
  return (
    <div
      className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3"
      data-testid="member-360-bounced-reminders"
    >
      <div className="flex items-start gap-3">
        <div className="w-8 h-8 rounded-md bg-amber-500/15 border border-amber-500/30 flex items-center justify-center flex-shrink-0">
          <AlertTriangle className="w-4 h-4 text-amber-400" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-2">
              {levies.length === 1 ? (
                // When the member has bounced reminders for exactly one levy,
                // make the badge itself clickable so admins can drill in with
                // a single click — matches the task wording exactly.
                <Link
                  href={`${BASE}/club-members?openLevy=${levies[0].levyId}&highlightMember=${memberId}`}
                  data-testid="badge-levy-reminder-failed-link"
                >
                  <Badge
                    className="bg-amber-500/20 text-amber-300 border-amber-500/30 cursor-pointer hover:bg-amber-500/30"
                    data-testid="badge-levy-reminder-failed"
                  >
                    Levy reminder failed
                  </Badge>
                </Link>
              ) : (
                <Badge
                  className="bg-amber-500/20 text-amber-300 border-amber-500/30"
                  data-testid="badge-levy-reminder-failed"
                >
                  Levy reminder failed
                </Badge>
              )}
              <span className="text-xs text-amber-200/80">
                {totalBounced} unresolved across {levies.length} {levies.length === 1 ? 'levy' : 'levies'}
              </span>
            </div>
          </div>
          <ul className="mt-2 space-y-1">
            {levies.map(l => {
              const channelSummary = Object.entries(l.channels)
                .map(([ch, n]) => `${n} ${ch.replace('_', ' ')}`).join(', ');
              return (
                <li key={l.levyId}>
                  <Link
                    href={`${BASE}/club-members?openLevy=${l.levyId}&highlightMember=${memberId}`}
                    data-testid={`link-bounced-levy-${l.levyId}`}
                  >
                    <div className="flex items-center justify-between gap-3 px-2.5 py-1.5 rounded-md bg-black/30 hover:bg-black/40 border border-white/5 transition-colors cursor-pointer">
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-white truncate">{l.name}</p>
                        <p className="text-[11px] text-amber-200/70 truncate">
                          {l.unresolvedFailedCount} failed{channelSummary ? ` · ${channelSummary}` : ''}
                          {l.sampleError ? ` · ${l.sampleError}` : ''}
                        </p>
                      </div>
                      <span className="text-xs text-amber-300/80 hover:text-amber-200 underline underline-offset-2 flex-shrink-0">Open levy</span>
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </div>
  );
}

function Kpi({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div className="rounded-lg bg-white/5 border border-white/10 px-3 py-2">
      <div className="text-xs text-white/50">{label}</div>
      <div className={`text-lg font-semibold ${accent ?? ''}`}>{value}</div>
    </div>
  );
}

/* ─── OVERVIEW ─── */
function OverviewTab({ summary }: { summary: Summary360 }) {
  return (
    <div className="grid md:grid-cols-2 gap-4">
      <Card className="bg-white/5 border-white/10">
        <CardHeader><CardTitle className="text-base flex items-center gap-2"><Key className="w-4 h-4" />Access & Facilities</CardTitle></CardHeader>
        <CardContent className="space-y-2 text-sm">
          {summary.locker && <div>Locker: <span className="text-white/80">#{summary.locker.lockerNumber}</span> (until {new Date(summary.locker.expiryDate).toLocaleDateString()})</div>}
          {summary.activeAccessCards.length > 0 ? (
            summary.activeAccessCards.map(c => (
              <div key={c.id} className="flex items-center justify-between">
                <span>{c.cardType.toUpperCase()} {c.cardLabel ?? ''}</span>
                <code className="text-xs text-white/60">{c.cardNumber}</code>
              </div>
            ))
          ) : <div className="text-white/40">No active access cards</div>}
        </CardContent>
      </Card>
      <Card className="bg-white/5 border-white/10">
        <CardHeader><CardTitle className="text-base flex items-center gap-2"><Users className="w-4 h-4" />Committee Roles</CardTitle></CardHeader>
        <CardContent className="space-y-2 text-sm">
          {summary.activeCommittee.length > 0 ? (
            summary.activeCommittee.map(c => (
              <div key={c.id}><span className="font-medium">{c.position}</span> — {c.committee}{c.termEnd ? ` (until ${new Date(c.termEnd).toLocaleDateString()})` : ''}</div>
            ))
          ) : <div className="text-white/40">No active committee roles</div>}
        </CardContent>
      </Card>
      <Card className="bg-white/5 border-white/10 md:col-span-2">
        <CardHeader><CardTitle className="text-base">Financial Snapshot</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
          <Stat label="Joining Fee" value={`₹${summary.ext.joiningFee}`} />
          <Stat label="Refundable Deposit" value={`₹${summary.ext.refundableDeposit}`} />
          <Stat label="Credit Limit" value={`₹${summary.ext.creditLimit}`} />
          <Stat label="Open Levies" value={String(summary.counts.openLevies)} />
        </CardContent>
      </Card>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return <div><div className="text-white/50 text-xs">{label}</div><div className="font-semibold">{value}</div></div>;
}

/* ─── PROFILE ─── */
function ProfileTab({ base, onChange }: { base: string; onChange: () => void }) {
  const { data, refetch } = useQuery<Record<string, unknown>>({
    queryKey: ['member-360-tab', 'profile', base],
    queryFn: () => j(base + '/profile-ext'),
  });
  const [form, setForm] = useState<Record<string, string | boolean>>({});
  const { toast } = useToast();
  if (!data) return <Loading />;
  const cur = { ...data, ...form };

  const save = async () => {
    try {
      await j(base + '/profile-ext', { method: 'PATCH', body: JSON.stringify(form) });
      toast({ title: 'Profile saved' });
      setForm({});
      refetch(); onChange();
    } catch (e) { toast({ title: 'Save failed', description: (e as Error).message, variant: 'destructive' }); }
  };

  const set = (k: string, v: string | boolean) => setForm(f => ({ ...f, [k]: v }));
  const g = (k: string) => String(cur[k] ?? '');

  return (
    <Card className="bg-white/5 border-white/10">
      <CardHeader><CardTitle className="text-base">Extended Profile</CardTitle></CardHeader>
      <CardContent className="grid md:grid-cols-3 gap-4">
        {[
          ['middleName', 'Middle name'], ['preferredName', 'Preferred name'], ['salutation', 'Salutation'],
          ['gender', 'Gender'], ['pronouns', 'Pronouns'], ['nationality', 'Nationality'],
          ['occupation', 'Occupation'], ['employer', 'Employer'],
          ['addressLine1', 'Address 1'], ['addressLine2', 'Address 2'],
          ['city', 'City'], ['state', 'State'], ['postalCode', 'Postal code'], ['country', 'Country'],
          ['emergencyContactName', 'Emergency contact'], ['emergencyContactPhone', 'Emergency phone'], ['emergencyContactRelation', 'Relation'],
          ['preferredTee', 'Preferred tee'], ['dominantHand', 'Dominant hand'], ['preferredCart', 'Preferred cart'],
          ['shirtSize', 'Shirt size'], ['shoeSize', 'Shoe size'], ['glovesSize', 'Glove size'],
          ['joiningFee', 'Joining fee'], ['refundableDeposit', 'Refundable deposit'], ['creditLimit', 'Credit limit'],
        ].map(([k, label]) => (
          <div key={k}>
            <Label className="text-xs text-white/60">{label}</Label>
            <Input value={g(k)} onChange={e => set(k, e.target.value)} className="bg-white/5 border-white/10" />
          </div>
        ))}
        <div>
          <Label className="text-xs text-white/60">KYC Status</Label>
          <Select value={g('kycStatus') || 'pending'} onValueChange={v => set('kycStatus', v)}>
            <SelectTrigger className="bg-white/5 border-white/10"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="pending">Pending</SelectItem>
              <SelectItem value="verified">Verified</SelectItem>
              <SelectItem value="rejected">Rejected</SelectItem>
              <SelectItem value="expired">Expired</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-2 mt-6">
          <Switch checked={!!cur.isVip} onCheckedChange={v => set('isVip', v)} />
          <Label>VIP</Label>
        </div>
        <div className="flex items-center gap-2 mt-6">
          <Switch checked={!!cur.twoFactorEnabled} onCheckedChange={v => set('twoFactorEnabled', v)} />
          <Label>2FA enabled</Label>
        </div>
        <div className="md:col-span-3 flex justify-end">
          <Button onClick={save} disabled={Object.keys(form).length === 0}>Save Changes</Button>
        </div>
      </CardContent>
    </Card>
  );
}

/* ─── DOCUMENTS ─── */
interface DocItem {
  id: number;
  documentType: string;
  title: string;
  fileUrl: string;
  isVerified: boolean;
  expiresAt: string | null;
  createdAt: string;
  uploadedByUserId: number | null;
  uploadedByDisplayName: string | null;
  uploadedByUsername: string | null;
  uploadedByEmail: string | null;
  isRejected?: boolean;
  rejectedAt?: string | null;
  rejectedByUserId?: number | null;
  rejectionReason?: string | null;
  rejectedByDisplayName?: string | null;
  rejectedByUsername?: string | null;
  rejectedByEmail?: string | null;
  withdrawnRejection?: {
    withdrawnAt: string;
    withdrawnByUserId: number | null;
    withdrawnByName: string | null;
    previousReason: string | null;
    previousRejectedByUserId: number | null;
    previousRejectedByName: string | null;
    previousRejectedAt: string | null;
    withdrawalNote: string | null;
  } | null;
}
type DocStatusFilter = 'all' | 'verified' | 'pending' | 'rejected';
interface DocVersion {
  id: number;
  title: string;
  fileUrl: string;
  mimeType: string | null;
  fileSize: number | null;
  replacedByUserId: number | null;
  replacedAt: string;
  source: 'replace' | 'restore' | string;
  restoredFromVersionId: number | null;
  replacedByDisplayName: string | null;
  replacedByUsername: string | null;
  replacedByEmail: string | null;
}
function DocVersionsList({ base, docId, onRestored }: { base: string; docId: number; onRestored: () => void }) {
  const { data = [], isLoading, refetch } = useQuery<DocVersion[]>({ queryKey: ['member-360-tab', 'doc-versions', base, docId], queryFn: () => j(base + `/documents/${docId}/versions`) });
  const { toast } = useToast();
  const [restoringId, setRestoringId] = useState<number | null>(null);
  const restore = async (versionId: number) => {
    if (!confirm('Restore this previous version? The currently-live file will be saved to history.')) return;
    setRestoringId(versionId);
    try {
      await j(base + `/documents/${docId}/versions/${versionId}/restore`, { method: 'POST' });
      await refetch();
      onRestored();
      toast({ title: 'Version restored' });
    } catch (e) {
      toast({ title: 'Restore failed', description: e instanceof Error ? e.message : String(e), variant: 'destructive' });
    } finally {
      setRestoringId(null);
    }
  };
  if (isLoading) return <div className="text-xs text-white/40 mt-2">Loading previous versions…</div>;
  if (data.length === 0) return null;
  return (
    <div className="mt-3 pt-3 border-t border-white/10">
      <div className="text-xs uppercase tracking-wide text-white/50 mb-2">Previous versions ({data.length})</div>
      <div className="space-y-1.5">
        {data.map(v => {
          const isRestore = v.source === 'restore';
          const actor = v.replacedByDisplayName || v.replacedByUsername || v.replacedByEmail || (v.replacedByUserId ? `User #${v.replacedByUserId}` : 'Unknown');
          const when = new Date(v.replacedAt).toLocaleString();
          const verb = isRestore ? 'snapshotted by restore' : 'replaced';
          const tooltip = isRestore
            ? `Snapshot of the live file taken when ${actor} restored an older version on ${when}.`
            : `Replaced by ${actor} on ${when}.`;
          return (
            <div key={v.id} className="flex items-center justify-between text-xs text-white/70" title={tooltip}>
              <div className="truncate mr-2 flex items-center gap-2 min-w-0">
                {isRestore && (
                  <Badge
                    className="bg-amber-500/20 text-amber-400 border-amber-500/30 shrink-0"
                    data-testid={`badge-restore-${v.id}`}
                  >
                    Restore
                  </Badge>
                )}
                <span className="truncate">
                  <span className="font-medium">{v.title}</span>
                  <span className="text-white/40"> · {verb} {when}</span>
                  <span className="text-white/40"> · by {actor}</span>
                </span>
              </div>
              <div className="flex items-center gap-3 shrink-0">
                <a href={v.fileUrl} target="_blank" rel="noreferrer" className="text-blue-400 hover:underline">Open</a>
                <button
                  type="button"
                  onClick={() => restore(v.id)}
                  disabled={restoringId === v.id}
                  className="text-amber-400 hover:underline disabled:opacity-50"
                >
                  {restoringId === v.id ? 'Restoring…' : 'Restore'}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
/**
 * Renders a transient per-channel delivery chip row inside a rejection callout
 * when the staff session has a recorded notification result for this document.
 * The data comes from sessionStorage (populated by the pending-documents page
 * when staff actually triggered the rejection), so it appears for the rest of
 * the session after rejecting from the queue and quietly disappears otherwise
 * — no backend changes required for this lightweight surfacing.
 */
function RejectionDeliveryChipsForDoc({ docId }: { docId: number }) {
  const [notification, setNotification] = useState<RejectionNotification | null>(null);
  useEffect(() => {
    setNotification(getDocRejectionDelivery(docId));
  }, [docId]);
  if (!notification) return null;
  return (
    <div className="mt-2">
      <div className="text-[10px] uppercase tracking-wide text-red-300/70 mb-1">Notification delivery</div>
      <RejectionDeliveryChips notification={notification} testIdPrefix={`doc-rejection-delivery-${docId}`} />
    </div>
  );
}

export function DocumentsTab({ base }: { base: string }) {
  const { data = [], refetch } = useQuery<DocItem[]>({ queryKey: ['member-360-tab', 'docs', base], queryFn: () => j(base + '/documents') });
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ documentType: 'id_proof', title: '', fileUrl: '', expiresAt: '' });
  const [statusFilter, setStatusFilter] = useState<DocStatusFilter>('all');
  const [expandedHistory, setExpandedHistory] = useState<Record<string, boolean>>({});
  const { toast } = useToast();
  const toggleHistory = (type: string) => setExpandedHistory(prev => ({ ...prev, [type]: !prev[type] }));

  const counts = {
    all: data.length,
    verified: data.filter(d => d.isVerified).length,
    pending: data.filter(d => !d.isVerified && !d.isRejected).length,
    rejected: data.filter(d => d.isRejected).length,
  };
  const visible = data.filter(d => {
    if (statusFilter === 'verified') return d.isVerified;
    if (statusFilter === 'rejected') return !!d.isRejected;
    if (statusFilter === 'pending') return !d.isVerified && !d.isRejected;
    return true;
  });

  // Group rejected uploads of the same type into a collapsible "Past rejections"
  // section anchored to the active (non-rejected) document of that type. If a
  // type has no active doc, the most recent rejection remains the primary row
  // (so staff can still act on it) and any older rejections collapse. Grouping
  // only applies in the default 'all' view; explicit status filters list every
  // matching row inline so staff can scan them directly.
  type RenderItem =
    | { kind: 'doc'; doc: DocItem }
    | { kind: 'history'; documentType: string; items: DocItem[] };
  const typeLabel = (v: string) => v.replace(/_/g, ' ');
  let renderItems: RenderItem[] = visible.map(d => ({ kind: 'doc', doc: d }));
  if (statusFilter === 'all') {
    const byType = new Map<string, DocItem[]>();
    for (const d of visible) {
      const list = byType.get(d.documentType) ?? [];
      list.push(d);
      byType.set(d.documentType, list);
    }
    const primaryDocs: DocItem[] = [];
    const historyByType = new Map<string, DocItem[]>();
    for (const [type, list] of byType.entries()) {
      const sorted = [...list].sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      );
      const active = sorted.filter(x => !x.isRejected);
      const rejected = sorted.filter(x => x.isRejected);
      if (active.length) {
        primaryDocs.push(...active);
        if (rejected.length) historyByType.set(type, rejected);
      } else if (rejected.length) {
        primaryDocs.push(rejected[0]);
        if (rejected.length > 1) historyByType.set(type, rejected.slice(1));
      }
    }
    primaryDocs.sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
    const lastPrimaryIndexByType = new Map<string, number>();
    primaryDocs.forEach((d, i) => lastPrimaryIndexByType.set(d.documentType, i));
    const grouped: RenderItem[] = [];
    primaryDocs.forEach((d, i) => {
      grouped.push({ kind: 'doc', doc: d });
      if (
        lastPrimaryIndexByType.get(d.documentType) === i &&
        historyByType.has(d.documentType)
      ) {
        grouped.push({
          kind: 'history',
          documentType: d.documentType,
          items: historyByType.get(d.documentType)!,
        });
      }
    });
    renderItems = grouped;
  }

  const create = async () => {
    if (!form.title || !form.fileUrl) { toast({ title: 'Title and file URL required', variant: 'destructive' }); return; }
    await j(base + '/documents', { method: 'POST', body: JSON.stringify(form) });
    setOpen(false); setForm({ documentType: 'id_proof', title: '', fileUrl: '', expiresAt: '' });
    refetch(); toast({ title: 'Document added' });
  };
  const verify = async (id: number) => { await j(base + `/documents/${id}/verify`, { method: 'PATCH' }); refetch(); toast({ title: 'Verified' }); };
  const del = async (id: number) => { await j(base + `/documents/${id}`, { method: 'DELETE' }); refetch(); };
  const [unrejectingId, setUnrejectingId] = useState<number | null>(null);
  const [unrejectReason, setUnrejectReason] = useState('');
  const [unrejectBusy, setUnrejectBusy] = useState(false);
  const submitUnreject = async () => {
    if (unrejectingId == null) return;
    setUnrejectBusy(true);
    try {
      await j(base + `/documents/${unrejectingId}/unreject`, {
        method: 'PATCH',
        body: JSON.stringify({ reason: unrejectReason.trim() || undefined }),
      });
      setUnrejectingId(null);
      setUnrejectReason('');
      refetch();
      toast({ title: 'Rejection withdrawn', description: 'The document is back in the pending queue and the member has been notified.' });
    } catch (e) {
      toast({ title: 'Could not withdraw rejection', description: e instanceof Error ? e.message : String(e), variant: 'destructive' });
    } finally {
      setUnrejectBusy(false);
    }
  };

  return (
    <Card className="bg-white/5 border-white/10">
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-base">Documents & KYC</CardTitle>
        <Button size="sm" onClick={() => setOpen(true)}><Plus className="w-4 h-4 mr-1" />Add</Button>
      </CardHeader>
      <CardContent>
        {data.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 mb-3" data-testid="doc-status-filter">
            {(['all', 'verified', 'pending', 'rejected'] as DocStatusFilter[]).map(s => (
              <Button
                key={s}
                size="sm"
                variant={statusFilter === s ? 'default' : 'outline'}
                onClick={() => setStatusFilter(s)}
                data-testid={`doc-filter-${s}`}
              >
                {s.charAt(0).toUpperCase() + s.slice(1)} ({counts[s]})
              </Button>
            ))}
          </div>
        )}
        {data.length === 0 ? <p className="text-white/40 text-sm">No documents on file.</p>
          : visible.length === 0 ? <p className="text-white/40 text-sm">No documents match this filter.</p> : (
          <div className="space-y-2">
            {renderItems.map(item => {
              if (item.kind === 'history') {
                const expanded = !!expandedHistory[item.documentType];
                return (
                  <div
                    key={`hist-${item.documentType}`}
                    className="rounded-lg border border-white/10 bg-white/[0.03]"
                    data-testid={`doc-history-${item.documentType}`}
                  >
                    <button
                      type="button"
                      onClick={() => toggleHistory(item.documentType)}
                      className="w-full flex items-center justify-between px-3 py-2 text-xs text-white/60 hover:text-white/80"
                      data-testid={`doc-history-toggle-${item.documentType}`}
                    >
                      <span className="flex items-center gap-2">
                        <History className="w-3 h-3" />
                        Past rejections · {typeLabel(item.documentType)} ({item.items.length})
                      </span>
                      {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                    </button>
                    {expanded && (
                      <div className="px-3 pb-3 space-y-2">
                        {item.items.map(h => {
                          const rejecter = h.rejectedByDisplayName || h.rejectedByUsername || h.rejectedByEmail
                            || (h.rejectedByUserId ? `User #${h.rejectedByUserId}` : 'Unknown staff');
                          const when = h.rejectedAt
                            ? new Date(h.rejectedAt).toLocaleString()
                            : new Date(h.createdAt).toLocaleString();
                          return (
                            <div
                              key={h.id}
                              className="p-2.5 rounded-md bg-red-500/10 border border-red-500/20 text-xs"
                              data-testid={`doc-history-row-${h.id}`}
                            >
                              <div className="flex items-center justify-between gap-2">
                                <div className="flex items-center gap-2 min-w-0">
                                  <XCircle className="w-3 h-3 text-red-400 shrink-0" />
                                  <span className="text-white/90 font-medium truncate">{h.title}</span>
                                </div>
                                <a href={h.fileUrl} target="_blank" rel="noreferrer" className="text-blue-400 hover:underline shrink-0">Open</a>
                              </div>
                              <div className="mt-1 text-red-300/80">
                                Rejected by <span className="font-medium text-red-200">{rejecter}</span> · {when}
                              </div>
                              <div className="mt-1 text-red-200/90 whitespace-pre-wrap">
                                {h.rejectionReason || 'No reason provided.'}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              }
              const d = item.doc;
              const uploader = d.uploadedByDisplayName || d.uploadedByUsername || d.uploadedByEmail || (d.uploadedByUserId ? `User #${d.uploadedByUserId}` : null);
              const uploadedAtLabel = d.createdAt ? new Date(d.createdAt).toLocaleString() : null;
              const uploadedLabel = uploader
                ? `uploaded by ${uploader}${uploadedAtLabel ? ` · ${uploadedAtLabel}` : ''}`
                : 'uploader unknown';
              const uploadedTooltip = uploader
                ? `Originally uploaded by ${uploader}${uploadedAtLabel ? ` on ${uploadedAtLabel}` : ''}.`
                : 'Original uploader is not recorded for this document.';
              const rejecter = d.rejectedByDisplayName || d.rejectedByUsername || d.rejectedByEmail
                || (d.rejectedByUserId ? `User #${d.rejectedByUserId}` : 'Unknown staff');
              return (
              <div key={d.id} className="p-3 rounded-lg bg-white/5 border border-white/10" data-testid={`doc-row-${d.id}`}>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <FileText className="w-4 h-4 text-white/60" />
                    <div>
                      <div className="font-medium text-sm">{d.title}</div>
                      <div className="text-xs text-white/50">{d.documentType}{d.expiresAt ? ` · expires ${new Date(d.expiresAt).toLocaleDateString()}` : ''}</div>
                      <div
                        className="text-xs text-white/40"
                        title={uploadedTooltip}
                        aria-label={uploadedTooltip}
                        data-testid={`text-doc-uploader-${d.id}`}
                      >
                        {uploadedLabel}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {d.isVerified ? (
                      <Badge className="bg-green-500/20 text-green-400 border-green-500/30"><CheckCircle2 className="w-3 h-3 mr-1" />Verified</Badge>
                    ) : d.isRejected ? (
                      <Badge
                        className="bg-red-500/20 text-red-400 border-red-500/30"
                        data-testid={`badge-rejected-${d.id}`}
                      >
                        <XCircle className="w-3 h-3 mr-1" />Rejected
                      </Badge>
                    ) : (
                      <Button size="sm" variant="outline" onClick={() => verify(d.id)}>Verify</Button>
                    )}
                    <a href={d.fileUrl} target="_blank" rel="noreferrer" className="text-xs text-blue-400 hover:underline">Open</a>
                    <Button size="sm" variant="ghost" onClick={() => del(d.id)}><Trash2 className="w-4 h-4 text-red-400" /></Button>
                  </div>
                </div>
                {!d.isRejected && d.withdrawnRejection && (
                  <div
                    className="mt-3 p-2.5 rounded-md bg-amber-500/10 border border-amber-500/20 text-xs"
                    data-testid={`doc-withdrawn-rejection-${d.id}`}
                  >
                    <div className="flex items-center gap-2 text-amber-200">
                      <UserCheck className="w-3.5 h-3.5 text-amber-300 shrink-0" />
                      <span className="font-medium">Previously rejected — withdrawn</span>
                      {d.withdrawnRejection.withdrawnByName && (
                        <span className="text-amber-300/80">
                          by {d.withdrawnRejection.withdrawnByName}
                        </span>
                      )}
                      <span className="text-amber-300/60">
                        · {new Date(d.withdrawnRejection.withdrawnAt).toLocaleString()}
                      </span>
                    </div>
                    <div className="mt-1.5 text-amber-100/80">
                      Originally rejected by{' '}
                      <span className="font-medium text-amber-100">
                        {d.withdrawnRejection.previousRejectedByName ?? 'Unknown staff'}
                      </span>
                      {d.withdrawnRejection.previousRejectedAt && (
                        <span className="text-amber-300/70">
                          {' '}on {new Date(d.withdrawnRejection.previousRejectedAt).toLocaleString()}
                        </span>
                      )}
                    </div>
                    {d.withdrawnRejection.previousReason && (
                      <div
                        className="mt-1 text-amber-100/90 whitespace-pre-wrap"
                        data-testid={`doc-withdrawn-original-reason-${d.id}`}
                      >
                        <span className="text-amber-300/70">Original reason: </span>
                        {d.withdrawnRejection.previousReason}
                      </div>
                    )}
                    {d.withdrawnRejection.withdrawalNote && (
                      <div className="mt-1 text-amber-100/90 whitespace-pre-wrap">
                        <span className="text-amber-300/70">Withdrawal note: </span>
                        {d.withdrawnRejection.withdrawalNote}
                      </div>
                    )}
                  </div>
                )}
                {d.isRejected && (
                  <div
                    className="mt-3 p-2.5 rounded-md bg-red-500/10 border border-red-500/20 text-xs"
                    data-testid={`doc-rejection-${d.id}`}
                  >
                    <div className="flex items-start justify-end mb-2">
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 px-2 text-xs border-red-500/30 text-red-200 hover:bg-red-500/20"
                        onClick={() => { setUnrejectingId(d.id); setUnrejectReason(''); }}
                        data-testid={`button-unreject-${d.id}`}
                      >
                        Undo rejection
                      </Button>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      <div
                        className="p-2 rounded bg-white/5 border border-white/10"
                        data-testid={`doc-rejection-uploader-${d.id}`}
                      >
                        <div className="text-[10px] uppercase tracking-wide text-white/50">Uploaded by</div>
                        <div className="text-white/90 font-medium">{uploader ?? 'Unknown'}</div>
                        {uploadedAtLabel && (
                          <div className="text-white/50">{uploadedAtLabel}</div>
                        )}
                      </div>
                      <div
                        className="p-2 rounded bg-red-500/10 border border-red-500/20"
                        data-testid={`doc-rejection-rejecter-${d.id}`}
                      >
                        <div className="text-[10px] uppercase tracking-wide text-red-300/70">Rejected by</div>
                        <div className="text-red-200 font-medium">{rejecter}</div>
                        {d.rejectedAt && (
                          <div className="text-red-300/70">{new Date(d.rejectedAt).toLocaleString()}</div>
                        )}
                      </div>
                    </div>
                    {d.rejectionReason && (
                      <div className="mt-2 text-red-200/90 whitespace-pre-wrap">
                        <span className="text-red-300/70">Reason: </span>{d.rejectionReason}
                      </div>
                    )}
                    <RejectionDeliveryChipsForDoc docId={d.id} />
                  </div>
                )}
                <DocVersionsList base={base} docId={d.id} onRestored={() => refetch()} />
              </div>
              );
            })}
          </div>
        )}
      </CardContent>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="bg-neutral-900 border-white/10">
          <DialogHeader><DialogTitle>Add document</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <Select value={form.documentType} onValueChange={v => setForm(f => ({ ...f, documentType: v }))}>
              <SelectTrigger className="bg-white/5 border-white/10"><SelectValue /></SelectTrigger>
              <SelectContent>
                {['id_proof', 'address_proof', 'age_proof', 'handicap_cert', 'medical', 'contract', 'other'].map(x => <SelectItem key={x} value={x}>{x.replace(/_/g, ' ')}</SelectItem>)}
              </SelectContent>
            </Select>
            <Input placeholder="Title" value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} className="bg-white/5 border-white/10" />
            <Input placeholder="File URL" value={form.fileUrl} onChange={e => setForm(f => ({ ...f, fileUrl: e.target.value }))} className="bg-white/5 border-white/10" />
            <Input type="date" placeholder="Expires" value={form.expiresAt} onChange={e => setForm(f => ({ ...f, expiresAt: e.target.value }))} className="bg-white/5 border-white/10" />
          </div>
          <DialogFooter><Button onClick={create}>Add</Button></DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={unrejectingId != null} onOpenChange={(o) => { if (!o) { setUnrejectingId(null); setUnrejectReason(''); } }}>
        <DialogContent className="bg-neutral-900 border-white/10" data-testid="dialog-unreject">
          <DialogHeader><DialogTitle>Undo rejection</DialogTitle></DialogHeader>
          <div className="space-y-3 text-sm text-white/80">
            <p>This puts the document back into the pending queue and notifies the member that the prior rejection was withdrawn.</p>
            <Label className="text-xs text-white/60">Reason (optional — shared with the member)</Label>
            <Textarea
              value={unrejectReason}
              onChange={e => setUnrejectReason(e.target.value)}
              placeholder="e.g. Rejected in error — your document is fine."
              className="bg-white/5 border-white/10"
              maxLength={1000}
              data-testid="input-unreject-reason"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setUnrejectingId(null); setUnrejectReason(''); }}>Cancel</Button>
            <Button onClick={submitUnreject} disabled={unrejectBusy} data-testid="button-confirm-unreject">
              {unrejectBusy ? 'Withdrawing…' : 'Withdraw rejection'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

/* ─── CONSENTS ─── */
interface Consent { id: number; consentType: string; granted: boolean; version: string | null; grantedAt: string; source: string | null }
function ConsentsTab({ base }: { base: string }) {
  const { data = [], refetch } = useQuery<Consent[]>({ queryKey: ['member-360-tab', 'consents', base], queryFn: () => j(base + '/consents') });
  const { toast } = useToast();
  const types = ['terms', 'privacy_policy', 'marketing', 'image_usage', 'handicap_publication', 'directory_listing'];
  const record = async (consentType: string, granted: boolean) => {
    await j(base + '/consents', { method: 'POST', body: JSON.stringify({ consentType, granted, source: 'web_admin' }) });
    refetch(); toast({ title: 'Consent recorded' });
  };
  const latest = (type: string) => data.find(c => c.consentType === type);
  return (
    <Card className="bg-white/5 border-white/10">
      <CardHeader><CardTitle className="text-base">Consents (GDPR/DPDP)</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        {types.map(t => {
          const cur = latest(t);
          return (
            <div key={t} className="flex items-center justify-between p-3 rounded-lg bg-white/5 border border-white/10">
              <div>
                <div className="font-medium text-sm">{t.replace(/_/g, ' ')}</div>
                {cur && <div className="text-xs text-white/50">Last: {cur.granted ? 'granted' : 'revoked'} on {new Date(cur.grantedAt).toLocaleDateString()}</div>}
              </div>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={() => record(t, true)}>Grant</Button>
                <Button size="sm" variant="outline" onClick={() => record(t, false)}>Revoke</Button>
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

/* ─── COMMS ─── */
interface CommPref { id: number; category: string; emailEnabled: boolean; smsEnabled: boolean; pushEnabled: boolean; whatsappEnabled: boolean; inAppEnabled: boolean }
function CommsTab({ base }: { base: string }) {
  const { data = [], refetch } = useQuery<CommPref[]>({ queryKey: ['member-360-tab', 'comms', base], queryFn: () => j(base + '/comm-prefs') });
  const cats = ['billing', 'events', 'tournaments', 'newsletters', 'marketing', 'operations', 'service', 'social', 'privacy'];
  const cur = (cat: string) => data.find(d => d.category === cat) ?? { category: cat, emailEnabled: true, smsEnabled: false, pushEnabled: true, whatsappEnabled: false, inAppEnabled: true };

  const save = async (cat: string, field: string, value: boolean) => {
    const existing = cur(cat);
    await j(base + `/comm-prefs/${cat}`, { method: 'PUT', body: JSON.stringify({ ...existing, [field]: value }) });
    refetch();
  };

  return (
    <Card className="bg-white/5 border-white/10">
      <CardHeader><CardTitle className="text-base">Communication Preferences</CardTitle></CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <table className="w-full text-sm" data-testid="member-360-comm-prefs">
            <caption className="sr-only">Communication preferences by category and channel</caption>
            <thead className="text-white/50">
              <tr><th scope="col" className="text-left py-2">Category</th><th scope="col">Email</th><th scope="col">SMS</th><th scope="col">WhatsApp</th><th scope="col">Push</th><th scope="col">In-app</th></tr>
            </thead>
            <tbody>
              {cats.map(cat => {
                const p = cur(cat);
                return (
                  <tr key={cat} className="border-t border-white/5">
                    <td className="py-2">{cat.replace(/_/g, ' ')}</td>
                    {(['emailEnabled', 'smsEnabled', 'whatsappEnabled', 'pushEnabled', 'inAppEnabled'] as const).map(f => (
                      <td key={f} className="text-center">
                        <Switch
                          checked={(p as unknown as Record<string, boolean>)[f]}
                          onCheckedChange={v => save(cat, f, v)}
                          data-testid={`switch-${cat}-${f}`}
                        />
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-white/50 mt-3">
          WhatsApp messages are sent from the club&apos;s verified WhatsApp Business number — standard MSG91 carrier rules apply.
        </p>
      </CardContent>
    </Card>
  );
}

/* ─── FAMILY ─── */
interface FamilyLink { link: { id: number; relationship: string; isPrimaryPayer: boolean; canBookOnBehalf: boolean }; member: { id: number; firstName: string; lastName: string; email: string | null } }
function FamilyTab({ base, orgId, memberId }: { base: string; orgId: number; memberId: number }) {
  const { data = [], refetch } = useQuery<FamilyLink[]>({ queryKey: ['member-360-tab', 'family', base], queryFn: () => j(base + '/family') });
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ linkedMemberId: '', relationship: 'spouse', isPrimaryPayer: false, canBookOnBehalf: true });
  const { toast } = useToast();
  const add = async () => {
    if (!form.linkedMemberId) return;
    await j(base + '/family', { method: 'POST', body: JSON.stringify({ ...form, linkedMemberId: parseInt(form.linkedMemberId) }) });
    setOpen(false); refetch(); toast({ title: 'Linked' });
  };
  const remove = async (id: number) => { await j(base + `/family/${id}`, { method: 'DELETE' }); refetch(); };
  return (
    <Card className="bg-white/5 border-white/10">
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-base">Family & Dependents</CardTitle>
        <Button size="sm" onClick={() => setOpen(true)}><Plus className="w-4 h-4 mr-1" />Link</Button>
      </CardHeader>
      <CardContent>
        {data.length === 0 ? <p className="text-white/40 text-sm">No family links.</p> : (
          <div className="space-y-2">
            {data.map(row => (
              <div key={row.link.id} className="flex items-center justify-between p-3 rounded-lg bg-white/5 border border-white/10">
                <div>
                  <div className="font-medium text-sm">{row.member.firstName} {row.member.lastName} <span className="text-white/40">({row.link.relationship})</span></div>
                  <div className="text-xs text-white/50 flex gap-2">
                    {row.link.isPrimaryPayer && <Badge variant="outline" className="border-amber-500/30 text-amber-400">Primary payer</Badge>}
                    {row.link.canBookOnBehalf && <Badge variant="outline" className="border-blue-500/30 text-blue-400">Can book</Badge>}
                  </div>
                </div>
                <Button size="sm" variant="ghost" onClick={() => remove(row.link.id)}><Trash2 className="w-4 h-4 text-red-400" /></Button>
              </div>
            ))}
          </div>
        )}
      </CardContent>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="bg-neutral-900 border-white/10">
          <DialogHeader><DialogTitle>Link family member</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <Input placeholder="Member ID in this club" value={form.linkedMemberId} onChange={e => setForm(f => ({ ...f, linkedMemberId: e.target.value }))} className="bg-white/5 border-white/10" />
            <Select value={form.relationship} onValueChange={v => setForm(f => ({ ...f, relationship: v }))}>
              <SelectTrigger className="bg-white/5 border-white/10"><SelectValue /></SelectTrigger>
              <SelectContent>{['spouse', 'child', 'parent', 'sibling', 'dependent'].map(x => <SelectItem key={x} value={x}>{x}</SelectItem>)}</SelectContent>
            </Select>
            <div className="flex items-center gap-2"><Switch checked={form.isPrimaryPayer} onCheckedChange={v => setForm(f => ({ ...f, isPrimaryPayer: v }))} /><Label>Primary payer</Label></div>
            <div className="flex items-center gap-2"><Switch checked={form.canBookOnBehalf} onCheckedChange={v => setForm(f => ({ ...f, canBookOnBehalf: v }))} /><Label>Can book on behalf</Label></div>
          </div>
          <DialogFooter><Button onClick={add}>Link</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

/* ─── LIFECYCLE ─── */
interface LifecycleEvt { id: number; eventType: string; effectiveFrom: string; effectiveUntil: string | null; fromValue: string | null; toValue: string | null; reason: string | null }
function LifecycleTab({ base, onChange }: { base: string; onChange: () => void }) {
  const { data = [], refetch } = useQuery<LifecycleEvt[]>({ queryKey: ['member-360-tab', 'lifecycle', base], queryFn: () => j(base + '/lifecycle') });
  const [form, setForm] = useState({ eventType: 'freeze', reason: '', effectiveUntil: '' });
  const { toast } = useToast();
  const apply = async () => {
    await j(base + '/lifecycle', { method: 'POST', body: JSON.stringify({ ...form, effectiveUntil: form.effectiveUntil || null }) });
    setForm({ eventType: 'freeze', reason: '', effectiveUntil: '' });
    refetch(); onChange(); toast({ title: 'Event recorded' });
  };
  return (
    <div className="grid md:grid-cols-2 gap-4">
      <Card className="bg-white/5 border-white/10">
        <CardHeader><CardTitle className="text-base">Trigger lifecycle event</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <Select value={form.eventType} onValueChange={v => setForm(f => ({ ...f, eventType: v }))}>
            <SelectTrigger className="bg-white/5 border-white/10"><SelectValue /></SelectTrigger>
            <SelectContent>{['freeze', 'unfreeze', 'suspend', 'reinstate', 'resign', 'deceased', 'transfer'].map(x => <SelectItem key={x} value={x}>{x}</SelectItem>)}</SelectContent>
          </Select>
          <Input type="date" value={form.effectiveUntil} onChange={e => setForm(f => ({ ...f, effectiveUntil: e.target.value }))} placeholder="Effective until" className="bg-white/5 border-white/10" />
          <Textarea value={form.reason} onChange={e => setForm(f => ({ ...f, reason: e.target.value }))} placeholder="Reason / internal notes" className="bg-white/5 border-white/10" />
          <Button onClick={apply} className="w-full">Record Event</Button>
        </CardContent>
      </Card>
      <Card className="bg-white/5 border-white/10">
        <CardHeader><CardTitle className="text-base">History</CardTitle></CardHeader>
        <CardContent>
          {data.length === 0 ? <p className="text-white/40 text-sm">No events.</p> : (
            <div className="space-y-2 max-h-[480px] overflow-y-auto">
              {data.map(e => (
                <div key={e.id} className="p-3 rounded bg-white/5 border border-white/10">
                  <div className="flex items-center justify-between">
                    <span className="font-medium text-sm">{e.eventType}</span>
                    <span className="text-xs text-white/50">{new Date(e.effectiveFrom).toLocaleDateString()}</span>
                  </div>
                  {e.reason && <div className="text-xs text-white/60 mt-1">{e.reason}</div>}
                  {e.fromValue && e.toValue && <div className="text-xs text-white/40 mt-1">{e.fromValue} → {e.toValue}</div>}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/* ─── FINANCIAL ─── */
interface Ledger { accountCharges: Array<{ id: number; amount: string; description: string | null; isSettled: boolean; createdAt: string }>; levyCharges: Array<{ charge: { id: number; amount: string; paid: boolean }; levy: { id: number; name: string; dueDate: string | null } }>; storeCreditHistory: Array<{ id: number; type: string; amountPaise: number; reason: string | null; createdAt: string }>; outstandingBalance: string }
function FinancialTab({ base }: { base: string }) {
  const { data } = useQuery<Ledger>({ queryKey: ['member-360-tab', 'financial', base], queryFn: () => j(base + '/ledger') });
  if (!data) return <Loading />;
  return (
    <div className="grid md:grid-cols-2 gap-4">
      <Card className="bg-white/5 border-white/10">
        <CardHeader><CardTitle className="text-base flex items-center gap-2"><DollarSign className="w-4 h-4" />Outstanding: ₹{data.outstandingBalance}</CardTitle></CardHeader>
        <CardContent>
          <div className="text-sm font-medium mb-2">Account Charges</div>
          <div className="space-y-1 max-h-80 overflow-y-auto text-sm">
            {data.accountCharges.length === 0 ? <p className="text-white/40">None</p> : data.accountCharges.map(c => (
              <div key={c.id} className="flex justify-between p-2 bg-white/5 rounded">
                <span>{c.description ?? 'Charge'}</span>
                <span className={c.isSettled ? 'text-green-400' : 'text-amber-400'}>₹{c.amount} {c.isSettled ? '✓' : ''}</span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
      <Card className="bg-white/5 border-white/10">
        <CardHeader><CardTitle className="text-base">Levies</CardTitle></CardHeader>
        <CardContent>
          <div className="space-y-1 max-h-80 overflow-y-auto text-sm">
            {data.levyCharges.length === 0 ? <p className="text-white/40">None</p> : data.levyCharges.map(r => (
              <div
                key={r.charge.id}
                className="flex justify-between p-2 bg-white/5 rounded"
                data-testid={`member-360-levy-charge-row-${r.charge.id}`}
              >
                <span>{r.levy.name}</span>
                <span className={r.charge.paid ? 'text-green-400' : 'text-amber-400'}>₹{r.charge.amount} {r.charge.paid ? '✓' : ''}</span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
      <Card className="bg-white/5 border-white/10 md:col-span-2">
        <CardHeader><CardTitle className="text-base flex items-center gap-2"><CreditCard className="w-4 h-4" />Store Credit History</CardTitle></CardHeader>
        <CardContent>
          <div className="space-y-1 max-h-60 overflow-y-auto text-sm">
            {data.storeCreditHistory.length === 0 ? <p className="text-white/40">None</p> : data.storeCreditHistory.map(t => (
              <div key={t.id} className="flex justify-between p-2 bg-white/5 rounded">
                <span>{t.type} {t.reason ? `— ${t.reason}` : ''}</span>
                <span>₹{(t.amountPaise / 100).toFixed(2)}</span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

/* ─── DISCIPLINE ─── */
interface DiscItem { id: number; incidentDate: string; category: string; severity: string; description: string; status: string; fineAmount: string | null }
function DisciplineTab({ base }: { base: string }) {
  const { data = [], refetch } = useQuery<DiscItem[]>({ queryKey: ['member-360-tab', 'disc', base], queryFn: () => j(base + '/disciplinary') });
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ incidentDate: new Date().toISOString().slice(0, 10), category: 'dress_code', severity: 'warning', description: '', fineAmount: '' });
  const { toast } = useToast();
  const add = async () => {
    await j(base + '/disciplinary', { method: 'POST', body: JSON.stringify({ ...form, fineAmount: form.fineAmount || undefined }) });
    setOpen(false); refetch(); toast({ title: 'Incident recorded' });
  };
  const close = async (id: number, status: string) => { await j(base + `/disciplinary/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) }); refetch(); };
  return (
    <Card className="bg-white/5 border-white/10">
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-base">Disciplinary & Complaints</CardTitle>
        <Button size="sm" onClick={() => setOpen(true)}><Plus className="w-4 h-4 mr-1" />New</Button>
      </CardHeader>
      <CardContent>
        {data.length === 0 ? <p className="text-white/40 text-sm">No incidents.</p> : (
          <div className="space-y-2">
            {data.map(d => (
              <div key={d.id} className="p-3 rounded bg-white/5 border border-white/10">
                <div className="flex items-start justify-between">
                  <div>
                    <div className="flex items-center gap-2">
                      <Gavel className="w-4 h-4" />
                      <span className="font-medium">{d.category}</span>
                      <Badge className={(d.severity === 'expulsion' || d.severity === 'suspension' || d.severity === 'major') ? 'bg-red-500/20 text-red-400 border-red-500/30' : 'bg-amber-500/20 text-amber-400 border-amber-500/30'}>{d.severity}</Badge>
                      <Badge variant="outline" className="border-white/20">{d.status}</Badge>
                    </div>
                    <div className="text-sm mt-1">{d.description}</div>
                    <div className="text-xs text-white/50 mt-1">{new Date(d.incidentDate).toLocaleDateString()} {d.fineAmount ? `· Fine ₹${d.fineAmount}` : ''}</div>
                  </div>
                  {d.status === 'open' && (
                    <div className="flex gap-1">
                      <Button size="sm" variant="outline" onClick={() => close(d.id, 'resolved')}>Resolve</Button>
                      <Button size="sm" variant="ghost" onClick={() => close(d.id, 'dismissed')}>Dismiss</Button>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="bg-neutral-900 border-white/10">
          <DialogHeader><DialogTitle>Record incident</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <Input type="date" value={form.incidentDate} onChange={e => setForm(f => ({ ...f, incidentDate: e.target.value }))} className="bg-white/5 border-white/10" />
            <Select value={form.category} onValueChange={v => setForm(f => ({ ...f, category: v }))}>
              <SelectTrigger className="bg-white/5 border-white/10"><SelectValue /></SelectTrigger>
              <SelectContent>{['dress_code', 'pace_of_play', 'course_etiquette', 'facility_misuse', 'guest_policy', 'billing', 'harassment', 'safety', 'other'].map(x => <SelectItem key={x} value={x}>{x.replace(/_/g, ' ')}</SelectItem>)}</SelectContent>
            </Select>
            <Select value={form.severity} onValueChange={v => setForm(f => ({ ...f, severity: v }))}>
              <SelectTrigger className="bg-white/5 border-white/10"><SelectValue /></SelectTrigger>
              <SelectContent>{['warning', 'minor', 'major', 'suspension', 'expulsion'].map(x => <SelectItem key={x} value={x}>{x}</SelectItem>)}</SelectContent>
            </Select>
            <Textarea value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} placeholder="Description" className="bg-white/5 border-white/10" />
            <Input value={form.fineAmount} onChange={e => setForm(f => ({ ...f, fineAmount: e.target.value }))} placeholder="Fine amount (optional)" className="bg-white/5 border-white/10" />
          </div>
          <DialogFooter><Button onClick={add}>Record</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

/* ─── NOTES ─── */
interface NoteItem { note: { id: number; body: string; category: string | null; isPinned: boolean; visibility: string; createdAt: string }; authorName: string | null; authorEmail: string | null }
function NotesTab({ base }: { base: string }) {
  const { data = [], refetch } = useQuery<NoteItem[]>({ queryKey: ['member-360-tab', 'notes', base], queryFn: () => j(base + '/notes') });
  const [body, setBody] = useState('');
  const [pin, setPin] = useState(false);
  const add = async () => {
    if (!body.trim()) return;
    await j(base + '/notes', { method: 'POST', body: JSON.stringify({ body, isPinned: pin }) });
    setBody(''); setPin(false); refetch();
  };
  const del = async (id: number) => { await j(base + `/notes/${id}`, { method: 'DELETE' }); refetch(); };
  return (
    <Card className="bg-white/5 border-white/10">
      <CardHeader><CardTitle className="text-base">Internal Staff Notes</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <Textarea value={body} onChange={e => setBody(e.target.value)} placeholder="Add staff-only note…" className="bg-white/5 border-white/10" />
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2"><Switch checked={pin} onCheckedChange={setPin} /><Label>Pin to top</Label></div>
          <Button size="sm" onClick={add}>Add Note</Button>
        </div>
        <div className="space-y-2 max-h-[480px] overflow-y-auto">
          {data.map(n => (
            <div key={n.note.id} className={`p-3 rounded border ${n.note.isPinned ? 'bg-amber-500/10 border-amber-500/30' : 'bg-white/5 border-white/10'}`}>
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  {n.note.isPinned && <Pin className="w-3 h-3 inline mr-1 text-amber-400" />}
                  <span className="text-sm whitespace-pre-wrap">{n.note.body}</span>
                  <div className="text-xs text-white/50 mt-1">{n.authorName ?? n.authorEmail ?? 'staff'} · {new Date(n.note.createdAt).toLocaleString()}</div>
                </div>
                <Button size="sm" variant="ghost" onClick={() => del(n.note.id)}><Trash2 className="w-4 h-4 text-red-400" /></Button>
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

/* ─── ACCESS ─── */
interface AccessCard { id: number; cardType: string; cardNumber: string; cardLabel: string | null; isActive: boolean; issuedAt: string; deactivatedAt: string | null }
interface AccessLog { id: number; cardNumber: string | null; zone: string | null; result: string; occurredAt: string }
function AccessTab({ base }: { base: string }) {
  const cardsQ = useQuery<AccessCard[]>({ queryKey: ['member-360-tab', 'cards', base], queryFn: () => j(base + '/access-cards') });
  const logQ = useQuery<AccessLog[]>({ queryKey: ['member-360-tab', 'access-log', base], queryFn: () => j(base + '/access-log') });
  const [form, setForm] = useState({ cardType: 'rfid', cardNumber: '', cardLabel: '' });
  const { toast } = useToast();
  const issue = async () => {
    if (!form.cardNumber) return;
    try {
      await j(base + '/access-cards', { method: 'POST', body: JSON.stringify(form) });
      setForm({ cardType: 'rfid', cardNumber: '', cardLabel: '' });
      cardsQ.refetch(); toast({ title: 'Card issued' });
    } catch (e) { toast({ title: 'Failed', description: (e as Error).message, variant: 'destructive' }); }
  };
  const deactivate = async (id: number) => { await j(base + `/access-cards/${id}/deactivate`, { method: 'PATCH', body: JSON.stringify({ reason: 'Manual' }) }); cardsQ.refetch(); };
  return (
    <div className="grid md:grid-cols-2 gap-4">
      <Card className="bg-white/5 border-white/10">
        <CardHeader><CardTitle className="text-base flex items-center gap-2"><Key className="w-4 h-4" />Access Cards</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="flex gap-2">
            <Select value={form.cardType} onValueChange={v => setForm(f => ({ ...f, cardType: v }))}>
              <SelectTrigger className="bg-white/5 border-white/10 w-32"><SelectValue /></SelectTrigger>
              <SelectContent>{['rfid', 'nfc', 'barcode', 'qr'].map(x => <SelectItem key={x} value={x}>{x.toUpperCase()}</SelectItem>)}</SelectContent>
            </Select>
            <Input placeholder="Card number" value={form.cardNumber} onChange={e => setForm(f => ({ ...f, cardNumber: e.target.value }))} className="bg-white/5 border-white/10" />
            <Button size="sm" onClick={issue}>Issue</Button>
          </div>
          <div className="space-y-2">
            {(cardsQ.data ?? []).map(c => (
              <div key={c.id} className="flex items-center justify-between p-2 rounded bg-white/5">
                <div className="text-sm">
                  <span className="font-medium">{c.cardType.toUpperCase()}</span> <code className="text-white/60">{c.cardNumber}</code>
                  {c.cardLabel && <span className="text-white/50"> — {c.cardLabel}</span>}
                </div>
                {c.isActive ? <Button size="sm" variant="outline" onClick={() => deactivate(c.id)}>Deactivate</Button>
                  : <Badge variant="outline" className="border-white/20">Inactive</Badge>}
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
      <Card className="bg-white/5 border-white/10">
        <CardHeader><CardTitle className="text-base flex items-center gap-2"><Activity className="w-4 h-4" />Access Log</CardTitle></CardHeader>
        <CardContent>
          {(logQ.data ?? []).length === 0 ? <p className="text-white/40 text-sm">No entries.</p> : (
            <div className="space-y-1 max-h-80 overflow-y-auto text-sm">
              {(logQ.data ?? []).map(l => (
                <div key={l.id} className="flex justify-between p-2 bg-white/5 rounded">
                  <span>{l.zone ?? 'unknown'} <span className="text-white/40">{l.cardNumber}</span></span>
                  <span className={l.result === 'granted' ? 'text-green-400' : 'text-red-400'}>{l.result}</span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/* ─── MILESTONES ─── */
interface Milestone { id: number; milestoneType: string; occurredAt: string; courseName: string | null; holeNumber: number | null; yardage: number | null; club: string | null; witnesses: string | null; verified: boolean }
function MilestonesTab({ base }: { base: string }) {
  const { data = [], refetch } = useQuery<Milestone[]>({ queryKey: ['member-360-tab', 'milestones', base], queryFn: () => j(base + '/milestones') });
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ milestoneType: 'hole_in_one', occurredAt: new Date().toISOString().slice(0, 10), courseName: '', holeNumber: '', yardage: '', club: '', witnesses: '' });
  const { toast } = useToast();
  const add = async () => {
    await j(base + '/milestones', { method: 'POST', body: JSON.stringify({
      ...form,
      holeNumber: form.holeNumber ? parseInt(form.holeNumber) : undefined,
      yardage: form.yardage ? parseInt(form.yardage) : undefined,
    }) });
    setOpen(false); refetch(); toast({ title: 'Milestone recorded' });
  };
  return (
    <Card className="bg-white/5 border-white/10">
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-base flex items-center gap-2"><Award className="w-4 h-4" />Milestones</CardTitle>
        <Button size="sm" onClick={() => setOpen(true)}><Plus className="w-4 h-4 mr-1" />Record</Button>
      </CardHeader>
      <CardContent>
        {data.length === 0 ? <p className="text-white/40 text-sm">No milestones.</p> : (
          <div className="space-y-2">
            {data.map(m => (
              <div key={m.id} className="p-3 rounded bg-white/5 border border-white/10">
                <div className="flex items-center justify-between">
                  <span className="font-medium">{m.milestoneType.replace(/_/g, ' ').toUpperCase()}</span>
                  <span className="text-xs text-white/50">{new Date(m.occurredAt).toLocaleDateString()}</span>
                </div>
                <div className="text-sm text-white/60 mt-1">
                  {m.courseName}{m.holeNumber ? ` · Hole ${m.holeNumber}` : ''}{m.yardage ? ` · ${m.yardage}y` : ''}{m.club ? ` · ${m.club}` : ''}
                </div>
                {m.witnesses && <div className="text-xs text-white/50 mt-1">Witnesses: {m.witnesses}</div>}
              </div>
            ))}
          </div>
        )}
      </CardContent>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="bg-neutral-900 border-white/10">
          <DialogHeader><DialogTitle>Record milestone</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <Select value={form.milestoneType} onValueChange={v => setForm(f => ({ ...f, milestoneType: v }))}>
              <SelectTrigger className="bg-white/5 border-white/10"><SelectValue /></SelectTrigger>
              <SelectContent>{['hole_in_one', 'albatross', 'eagle', 'first_sub_80', 'first_sub_par', 'course_record'].map(x => <SelectItem key={x} value={x}>{x.replace(/_/g, ' ')}</SelectItem>)}</SelectContent>
            </Select>
            <Input type="date" value={form.occurredAt} onChange={e => setForm(f => ({ ...f, occurredAt: e.target.value }))} className="bg-white/5 border-white/10" />
            <Input placeholder="Course name" value={form.courseName} onChange={e => setForm(f => ({ ...f, courseName: e.target.value }))} className="bg-white/5 border-white/10" />
            <div className="grid grid-cols-3 gap-2">
              <Input type="number" placeholder="Hole #" value={form.holeNumber} onChange={e => setForm(f => ({ ...f, holeNumber: e.target.value }))} className="bg-white/5 border-white/10" />
              <Input type="number" placeholder="Yardage" value={form.yardage} onChange={e => setForm(f => ({ ...f, yardage: e.target.value }))} className="bg-white/5 border-white/10" />
              <Input placeholder="Club" value={form.club} onChange={e => setForm(f => ({ ...f, club: e.target.value }))} className="bg-white/5 border-white/10" />
            </div>
            <Input placeholder="Witnesses" value={form.witnesses} onChange={e => setForm(f => ({ ...f, witnesses: e.target.value }))} className="bg-white/5 border-white/10" />
          </div>
          <DialogFooter><Button onClick={add}>Record</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

/* ─── MESSAGES ─── */
interface MsgItem { id: number; channel: string; subject: string | null; body: string; status: string; sentAt: string; errorMessage?: string | null; relatedEntity?: string | null; relatedEntityId?: number | null; linkedChargeId?: number | null; linkedTournamentId?: number | null }
function MessagesTab({ base, onOpenDataRequest, onOpenLevyCharge }: { base: string; onOpenDataRequest: (requestId: number) => void; onOpenLevyCharge: (chargeId: number) => void }) {
  const { data = [], refetch } = useQuery<MsgItem[]>({ queryKey: ['member-360-tab', 'msgs', base], queryFn: () => j(base + '/messages') });
  // Task #263: load privacy requests so we can tell whether a tagged
  // `data_request_email_exhausted` message is still an open alert (the
  // referenced request still has `emailRetryExhaustedAt` set) or has since
  // been resolved by a fresh notice (which `notifyDataRequest` clears).
  // Reusing the same query key as DataRequestsTab dedupes the network call.
  const { data: dataReqResponse } = useQuery<DataReqResponse>({
    queryKey: ['member-360-tab', 'data-req', base],
    queryFn: () => j(base + '/data-requests'),
  });
  const dataReqById = new Map<number, DataReq>();
  for (const r of dataReqResponse?.requests ?? []) dataReqById.set(r.id, r);
  const [form, setForm] = useState({ channel: 'in_app', subject: '', body: '' });
  const { toast } = useToast();
  const send = async () => {
    if (!form.body.trim()) return;
    await j(base + '/messages', { method: 'POST', body: JSON.stringify(form) });
    setForm({ channel: 'in_app', subject: '', body: '' });
    refetch(); toast({ title: 'Sent' });
  };
  return (
    <Card className="bg-white/5 border-white/10">
      <CardHeader><CardTitle className="text-base flex items-center gap-2"><MessageSquare className="w-4 h-4" />Direct Messages</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <div className="grid md:grid-cols-[auto,1fr] gap-2">
          <Select value={form.channel} onValueChange={v => setForm(f => ({ ...f, channel: v }))}>
            <SelectTrigger className="bg-white/5 border-white/10 w-32"><SelectValue /></SelectTrigger>
            <SelectContent>{['in_app', 'email', 'sms', 'whatsapp'].map(x => <SelectItem key={x} value={x}>{x}</SelectItem>)}</SelectContent>
          </Select>
          <Input placeholder="Subject (optional)" value={form.subject} onChange={e => setForm(f => ({ ...f, subject: e.target.value }))} className="bg-white/5 border-white/10" />
        </div>
        <Textarea placeholder="Message…" value={form.body} onChange={e => setForm(f => ({ ...f, body: e.target.value }))} className="bg-white/5 border-white/10" />
        <div className="flex justify-end"><Button size="sm" onClick={send}>Send</Button></div>
        <div className="space-y-2 max-h-[400px] overflow-y-auto">
          {data.map(m => {
            const failed = m.status === 'failed';
            const statusBadgeClass = failed
              ? 'border-red-500/40 text-red-300'
              : m.status === 'sent' || m.status === 'delivered'
                ? 'border-emerald-500/40 text-emerald-300'
                : 'border-white/20 text-white/60';
            // Task #263 / #305: messages tagged
            // `data_request_email_exhausted`, `data_request_push_exhausted`,
            // or `data_request_sms_exhausted` are admin-facing alerts written
            // when a privacy notice retry cap is reached for that channel.
            // We render them with a distinct red treatment + AlertTriangle
            // icon and a deep link back to the failing privacy request on
            // the Data tab. The alert is "resolved" once a fresh
            // `notifyDataRequest` call clears the channel's
            // `*RetryExhaustedAt` timestamp on the matching request — at
            // that point the entry stays in the timeline as a record but
            // loses its urgent treatment so admins aren't chased after the
            // fix.
            const exhaustionMeta: Record<string, { label: string; field: keyof DataReq }> = {
              data_request_email_exhausted: { label: 'Email retries exhausted', field: 'emailRetryExhaustedAt' },
              data_request_push_exhausted: { label: 'Push retries exhausted', field: 'pushRetryExhaustedAt' },
              data_request_sms_exhausted: { label: 'SMS retries exhausted', field: 'smsRetryExhaustedAt' },
            };
            const exhaustionInfo = m.relatedEntity ? exhaustionMeta[m.relatedEntity] : undefined;
            const isExhaustionAlert = !!exhaustionInfo && m.relatedEntityId != null;
            const linkedRequest = isExhaustionAlert ? dataReqById.get(m.relatedEntityId!) : undefined;
            const alertActive = isExhaustionAlert && !!linkedRequest?.[exhaustionInfo!.field];
            const alertResolved = isExhaustionAlert && linkedRequest && !linkedRequest[exhaustionInfo!.field];
            // Task #311: messages tagged `levy_receipt_push_exhausted` /
            // `levy_receipt_sms_exhausted` are admin-facing alerts written by
            // `notifyAdminsOfLevyReceiptRetryExhaustion` once the bounded
            // retry cap on a receipt notification's push or SMS channel is
            // hit. We render them with a distinct red-amber treatment +
            // AlertTriangle icon and a deep link back to the failing levy
            // charge on the Financial tab — mirroring the privacy-email
            // exhaustion pattern above so admins recognise the urgency.
            const isLevyReceiptExhaustion =
              (m.relatedEntity === 'levy_receipt_push_exhausted' ||
                m.relatedEntity === 'levy_receipt_sms_exhausted') &&
              m.relatedEntityId != null;
            const levyReceiptChannel: 'push' | 'sms' | null = !isLevyReceiptExhaustion
              ? null
              : m.relatedEntity === 'levy_receipt_push_exhausted' ? 'push' : 'sms';
            // Task #306: messages tagged `data_request_handler_assigned` are
            // written by `notifyHandlerAssigned` whenever a privacy request is
            // (re)assigned to a handler. We render them with a distinct
            // indigo treatment + UserCheck icon and a deep link back to the
            // assigned privacy request on the Data tab — mirroring the
            // exhaustion-alert pattern so admins can spot assignments
            // quickly. Unlike exhaustion alerts these don't have an
            // active/resolved state — the assignment is informational.
            const isAssignedNotice =
              m.relatedEntity === 'data_request_handler_assigned' && m.relatedEntityId != null;
            const linkedAssignedRequest = isAssignedNotice ? dataReqById.get(m.relatedEntityId!) : undefined;
            const containerClass = alertActive
              ? 'p-3 rounded border bg-red-500/10 border-red-500/50'
              : isLevyReceiptExhaustion
                ? 'p-3 rounded border bg-red-500/10 border-red-500/50'
                : isAssignedNotice
                  ? 'p-3 rounded border bg-indigo-500/10 border-indigo-500/40'
                  : failed
                    ? 'p-3 rounded border bg-red-500/5 border-red-500/30'
                    : 'p-3 rounded border bg-white/5 border-white/10';
            return (
              <div
                key={m.id}
                className={containerClass}
                data-testid={`message-row-${m.id}`}
                data-exhaustion-alert={alertActive ? 'active' : alertResolved ? 'resolved' : undefined}
                data-handler-assigned-notice={isAssignedNotice ? 'true' : undefined}
                data-levy-receipt-exhaustion={levyReceiptChannel ?? undefined}
              >
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <div className="flex items-center gap-2 flex-wrap">
                    {isExhaustionAlert && (
                      <AlertTriangle
                        className={`w-4 h-4 ${alertActive ? 'text-red-400' : 'text-white/40'}`}
                        data-testid={`message-exhaustion-icon-${m.id}`}
                      />
                    )}
                    {isLevyReceiptExhaustion && (
                      <AlertTriangle
                        className="w-4 h-4 text-red-400"
                        data-testid={`message-levy-receipt-exhaustion-icon-${m.id}`}
                      />
                    )}
                    {isAssignedNotice && (
                      <UserCheck
                        className="w-4 h-4 text-indigo-300"
                        data-testid={`message-handler-assigned-icon-${m.id}`}
                      />
                    )}
                    <Badge variant="outline" className="border-white/20">{m.channel}</Badge>
                    <Badge variant="outline" className={statusBadgeClass} data-testid={`message-status-${m.id}`}>{m.status}</Badge>
                    {m.relatedEntity === 'levy' && <Badge variant="outline" className="border-amber-500/30 text-amber-300">levy reminder</Badge>}
                    {isExhaustionAlert && (
                      <Badge
                        variant="outline"
                        className={alertActive
                          ? 'border-red-500/60 bg-red-500/15 text-red-200 font-medium'
                          : 'border-white/20 text-white/50'}
                        data-testid={`message-exhaustion-badge-${m.id}`}
                      >
                        {exhaustionInfo!.label}{alertResolved ? ' · resolved' : ''}
                      </Badge>
                    )}
                    {isLevyReceiptExhaustion && (
                      <Badge
                        variant="outline"
                        className="border-red-500/60 bg-red-500/15 text-red-200 font-medium"
                        data-testid={`message-levy-receipt-exhaustion-badge-${m.id}`}
                      >
                        {levyReceiptChannel === 'push' ? 'Receipt push' : 'Receipt SMS'} retries exhausted
                      </Badge>
                    )}
                    {isAssignedNotice && (
                      <Badge
                        variant="outline"
                        className="border-indigo-500/60 bg-indigo-500/15 text-indigo-200 font-medium"
                        data-testid={`message-handler-assigned-badge-${m.id}`}
                      >
                        Privacy request assigned
                      </Badge>
                    )}
                  </div>
                  <span className="text-xs text-white/50">{new Date(m.sentAt).toLocaleString()}</span>
                </div>
                {m.subject && <div className="font-medium mt-1">{m.subject}</div>}
                <div className="text-sm text-white/80 mt-1 whitespace-pre-wrap">{m.body}</div>
                {isAssignedNotice && (
                  <div className="mt-2">
                    <Button
                      size="sm"
                      variant="outline"
                      className="border-indigo-500/50 text-indigo-200 hover:bg-indigo-500/10"
                      onClick={() => onOpenDataRequest(m.relatedEntityId!)}
                      data-testid={`message-handler-assigned-open-${m.id}`}
                    >
                      <Shield className="w-3.5 h-3.5 mr-1" />
                      View privacy request #{m.relatedEntityId}
                    </Button>
                    {!linkedAssignedRequest && (
                      <span className="ml-2 text-xs text-white/40" data-testid={`message-handler-assigned-unlinked-${m.id}`}>
                        Linked request unavailable.
                      </span>
                    )}
                  </div>
                )}
                {isLevyReceiptExhaustion && (
                  <div className="mt-2">
                    {m.linkedChargeId != null ? (
                      <Button
                        size="sm"
                        variant="outline"
                        className="border-red-500/50 text-red-200 hover:bg-red-500/10"
                        onClick={() => onOpenLevyCharge(m.linkedChargeId!)}
                        data-testid={`message-levy-receipt-exhaustion-open-${m.id}`}
                      >
                        <DollarSign className="w-3.5 h-3.5 mr-1" />
                        View levy charge #{m.linkedChargeId}
                      </Button>
                    ) : (
                      <span className="text-xs text-white/40" data-testid={`message-levy-receipt-exhaustion-unlinked-${m.id}`}>
                        Linked levy charge unavailable.
                      </span>
                    )}
                  </div>
                )}
                {isExhaustionAlert && (
                  <div className="mt-2">
                    <Button
                      size="sm"
                      variant="outline"
                      className={alertActive
                        ? 'border-red-500/50 text-red-200 hover:bg-red-500/10'
                        : 'border-white/20'}
                      onClick={() => onOpenDataRequest(m.relatedEntityId!)}
                      data-testid={`message-exhaustion-open-${m.id}`}
                    >
                      <Shield className="w-3.5 h-3.5 mr-1" />
                      View privacy request #{m.relatedEntityId}
                    </Button>
                    {alertResolved && (
                      <span className="ml-2 text-xs text-emerald-300/80" data-testid={`message-exhaustion-resolved-${m.id}`}>
                        A fresh notice has since been sent — alert resolved.
                      </span>
                    )}
                    {!linkedRequest && (
                      <span className="ml-2 text-xs text-white/40" data-testid={`message-exhaustion-unlinked-${m.id}`}>
                        Linked request unavailable.
                      </span>
                    )}
                  </div>
                )}
                {/* Task #899: tie-break inbox row → bracket page deep-link */}
                {m.relatedEntity === 'round_robin_tie_break' && m.relatedEntityId != null && (
                  <div className="mt-2">
                    {m.linkedTournamentId != null ? (
                      <Button
                        size="sm"
                        variant="outline"
                        className="border-amber-500/40 text-amber-200 hover:bg-amber-500/10"
                        onClick={() => {
                          window.location.assign(
                            `/tournaments/${m.linkedTournamentId}/bracket?match=${m.relatedEntityId}`,
                          );
                        }}
                        data-testid={`message-tie-break-open-${m.id}`}
                      >
                        View tie-break match #{m.relatedEntityId}
                      </Button>
                    ) : (
                      <span className="text-xs text-white/40" data-testid={`message-tie-break-unlinked-${m.id}`}>
                        Linked tie-break match unavailable.
                      </span>
                    )}
                  </div>
                )}
                {failed && m.errorMessage && (
                  <div className="text-xs text-red-300 mt-2" data-testid={`message-error-${m.id}`}>
                    Delivery failed: {m.errorMessage}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

/* ─── DATA / GDPR ─── */
interface DataReq {
  id: number; requestType: string; status: string; requestedAt: string; dueBy: string | null; notes: string | null;
  // Task #1076: surface the signed-URL window so the admin Data tab can show
  // a countdown ("Expires in 2 days") and an amber banner inside the last 24h
  // — matching the daily reminder cron's window the member sees.
  resolvedAt?: string | null; artifactUrl?: string | null;
  // Task #1123: when the daily purge cron auto-deletes an expired archive it
  // stamps purgedAt. The admin Data tab uses it to flip the countdown badge
  // to "Expired on <date>" so the deadline that members see in their portal
  // is mirrored back to staff after the link has stopped working.
  purgedAt?: string | null;
  handlerUserId: number | null;
  handlerDisplayName: string | null; handlerUsername: string | null; handlerEmail: string | null;
  lastNotificationKind: string | null; lastNotifiedAt: string | null;
  lastEmailStatus: string | null; lastEmailAt: string | null; lastEmailError: string | null;
  lastInAppMessageId: number | null; lastInAppAt: string | null;
  lastPushStatus: string | null; lastPushAt: string | null; lastPushError: string | null;
  lastSmsStatus: string | null; lastSmsAt: string | null; lastSmsError: string | null;
  lastWhatsappStatus: string | null; lastWhatsappAt: string | null; lastWhatsappError: string | null;
  emailAttempts?: number | null; lastEmailRetryAt?: string | null; emailRetryExhaustedAt?: string | null;
  pushAttempts?: number | null; lastPushRetryAt?: string | null; pushRetryExhaustedAt?: string | null;
  smsAttempts?: number | null; lastSmsRetryAt?: string | null; smsRetryExhaustedAt?: string | null;
  whatsappAttempts?: number | null; lastWhatsappRetryAt?: string | null; whatsappRetryExhaustedAt?: string | null;
  resendCount: number; lastResendAt: string | null;
}
interface DataReqResponse {
  requests: DataReq[];
  maxPushAttempts: number;
  maxSmsAttempts: number;
  maxWhatsappAttempts: number;
  // Task #1076: server-side data-export validity window (DATA_EXPORT_VALID_DAYS)
  // so the countdown / amber banner doesn't have to hardcode it.
  exportValidForDays?: number;
}
const DEFAULT_MAX_RETRY_ATTEMPTS = 5;
interface PrivacyStaffMember {
  id: number; displayName: string | null; username: string | null; email: string | null; role: string;
}
interface ResendChannelDetail { status: string; at: string | null; error: string | null }
interface ResendHistoryEntry {
  id: number; actorName: string | null; actorRole: string | null; reason: string | null; createdAt: string;
  channels?: {
    email: ResendChannelDetail | null;
    inApp: ResendChannelDetail | null;
    push: ResendChannelDetail | null;
    sms: ResendChannelDetail | null;
  };
  initiatedBy?: 'member' | 'admin' | 'system';
}
/**
 * Human-friendly label for a `lastNotificationKind` value (Task #777).
 * Falls back to the raw kind so unknown future kinds still render.
 */
export function notificationKindLabel(kind: string | null | undefined): string {
  switch (kind) {
    case 'filed': return 'Request filed';
    case 'in_progress': return 'In progress';
    case 'completed': return 'Completed';
    case 'rejected': return 'Rejected';
    case 'completed_export': return 'Export ready';
    case 'export_expiring': return 'Export expiring';
    default: return kind ?? '';
  }
}
export function ResendHistoryPopover({ base, requestId, count, lastAt, kind }: { base: string; requestId: number; count: number; lastAt: string | null; kind?: string | null }) {
  const [open, setOpen] = useState(false);
  const [failedOnly, setFailedOnly] = useState(false);
  const [initiatorFilter, setInitiatorFilter] = useState<'all' | 'member' | 'admin' | 'system'>('all');
  const { data, isLoading } = useQuery<{ count: number; history: ResendHistoryEntry[] }>({
    queryKey: ['member-360-tab', 'data-req', base, 'resend-history', requestId],
    queryFn: () => j(base + '/data-requests/' + requestId + '/resend-history'),
    enabled: open,
  });
  const hasAnyFailure = (h: ResendHistoryEntry) => {
    const ch = h.channels;
    if (!ch) return false;
    return [ch.email, ch.inApp, ch.push, ch.sms].some(d => d != null && d.status !== 'sent');
  };
  const matchesInitiator = (h: ResendHistoryEntry) => {
    if (initiatorFilter === 'all') return true;
    if (initiatorFilter === 'member') return h.initiatedBy === 'member';
    if (initiatorFilter === 'system') return h.initiatedBy === 'system';
    // 'admin' filter: anything that isn't explicitly member or system.
    return h.initiatedBy !== 'member' && h.initiatedBy !== 'system';
  };
  const visibleHistory = data?.history.filter(h => matchesInitiator(h) && (!failedOnly || hasAnyFailure(h))) ?? [];
  const totalCount = data?.history.length ?? 0;
  const hiddenCount = totalCount - visibleHistory.length;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="text-xs text-white/70 hover:text-white border border-white/20 rounded px-2 py-0.5 bg-white/5"
          title={lastAt ? `Last resent ${new Date(lastAt).toLocaleString()}` : 'View resend history'}
        >
          Resent {count} time{count === 1 ? '' : 's'}
          {lastAt && <span className="text-white/40"> · {new Date(lastAt).toLocaleDateString()}</span>}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-80 bg-zinc-900 border-white/10 text-white">
        <div className="space-y-2">
          {kind === 'completed_export' && (
            <div
              className="text-[11px] rounded border border-emerald-500/30 bg-emerald-500/10 text-emerald-200 px-2 py-1"
              data-testid={`resend-history-export-hint-${requestId}`}
            >
              Resending will deliver the <span className="font-medium">"Your data export is ready"</span> notice with a fresh signed download link.
            </div>
          )}
          {kind === 'export_expiring' && (
            <div
              className="text-[11px] rounded border border-amber-500/30 bg-amber-500/10 text-amber-200 px-2 py-1"
              data-testid={`resend-history-export-expiring-hint-${requestId}`}
            >
              Resending will deliver the <span className="font-medium">"Your data export expires soon"</span> reminder with a fresh signed download link.
            </div>
          )}
          <div className="flex items-center justify-between gap-2">
            <div className="text-xs uppercase tracking-wider text-white/50">Resend history</div>
            {!isLoading && totalCount > 0 && (
              <label className="flex items-center gap-1.5 text-xs text-white/70 cursor-pointer select-none">
                <input
                  type="checkbox"
                  className="h-3 w-3 accent-red-400"
                  checked={failedOnly}
                  onChange={(e) => setFailedOnly(e.target.checked)}
                />
                Failed only
              </label>
            )}
          </div>
          {!isLoading && (
            <div
              className="inline-flex rounded border border-white/10 overflow-hidden text-[11px]"
              role="tablist"
              aria-label="Filter resend history by initiator"
              data-testid={`resend-history-initiator-filter-${requestId}`}
            >
              {(['all', 'member', 'admin', 'system'] as const).map(opt => (
                <button
                  key={opt}
                  type="button"
                  role="tab"
                  aria-selected={initiatorFilter === opt}
                  onClick={() => setInitiatorFilter(opt)}
                  className={`px-2 py-0.5 ${initiatorFilter === opt ? 'bg-white/15 text-white' : 'text-white/60 hover:text-white/80'}`}
                  data-testid={`resend-history-initiator-${opt}-${requestId}`}
                >
                  {opt === 'all' ? 'All' : opt === 'member' ? 'By member' : opt === 'admin' ? 'By admin' : 'By system'}
                </button>
              ))}
            </div>
          )}
          {isLoading && <div className="text-xs text-white/50">Loading…</div>}
          {!isLoading && totalCount === 0 && (
            <div className="text-xs text-white/50" data-testid={`resend-history-empty-${requestId}`}>
              No resends recorded yet.
            </div>
          )}
          {!isLoading && totalCount > 0 && visibleHistory.length === 0 && (
            <div className="text-xs text-white/50">
              No matching attempts. {hiddenCount} attempt{hiddenCount === 1 ? '' : 's'} hidden by current filter{hiddenCount === 1 ? '' : 's'}.
            </div>
          )}
          {!isLoading && visibleHistory.length > 0 && (
            <div className="space-y-2 max-h-64 overflow-y-auto">
              {failedOnly && hiddenCount > 0 && (
                <div className="text-[11px] text-white/40">{hiddenCount} successful attempt{hiddenCount === 1 ? '' : 's'} hidden</div>
              )}
              {visibleHistory.map(h => {
                const ch = h.channels;
                const hasChannels = !!ch && (ch.email || ch.inApp || ch.push || ch.sms);
                // Build the per-channel hover tooltip body. We surface the
                // channel timestamp (when the API has it) and the provider
                // error text on failed attempts — that error string is the
                // key debugging clue when push/SMS keep bouncing on the same
                // retry. Older audit rows lack timestamps; we degrade to the
                // status alone so the tooltip stays consistent.
                const renderBadge = (label: string, detail: ResendChannelDetail | null) => {
                  if (!detail) return null;
                  const { status, at, error } = detail;
                  const failed = status === 'failed';
                  const cls = `${channelBadgeColor(status)}${failed ? ' bg-red-500/10 font-medium' : ''}`;
                  const tipLines: string[] = [`${label}: ${status}`];
                  if (at) tipLines.push(`at ${new Date(at).toLocaleString()}`);
                  if (error) tipLines.push(`error: ${error}`);
                  if (!at && !error) tipLines.push('(no timestamp recorded for this attempt)');
                  return (
                    <Badge
                      key={label}
                      variant="outline"
                      className={`${cls} cursor-help`}
                      title={tipLines.join('\n')}
                    >
                      {label}: {status}
                    </Badge>
                  );
                };
                // Task #2245 — when the email pre-flight skipped a send
                // because the recipient address is on the org's
                // bounce/suppression list, `dataRequestNotify` records the
                // outcome as `email.status === "skipped"` with
                // `email.error === "address_suppressed:<reason>"`. Surface a
                // dedicated explanation so controllers don't have to read
                // the badge tooltip to understand why nothing was sent.
                const suppressionReason =
                  ch?.email && ch.email.status === 'skipped'
                    ? parseAddressSuppressedReason(ch.email.error)
                    : null;
                return (
                  <div key={h.id} className="text-xs border-b border-white/5 pb-2 last:border-b-0">
                    <div className="text-white/80 flex items-center gap-1.5">
                      <span>{new Date(h.createdAt).toLocaleString()}</span>
                      {h.initiatedBy === 'member' && (
                        <Badge
                          variant="outline"
                          className="border-sky-500/40 text-sky-300 text-[10px] px-1.5 py-0"
                          title="Resend triggered by the member from their portal"
                        >
                          by member
                        </Badge>
                      )}
                      {h.initiatedBy === 'system' && (
                        <Badge
                          variant="outline"
                          className="border-violet-500/40 text-violet-300 text-[10px] px-1.5 py-0"
                          title="Automatic retry performed by the privacy notification cron"
                          data-testid={`resend-history-system-badge-${h.id}`}
                        >
                          by system
                        </Badge>
                      )}
                    </div>
                    <div className="text-white/50">by {h.actorName ?? 'system'}{h.actorRole ? ` (${h.actorRole})` : ''}</div>
                    {hasChannels ? (
                      <div className="flex flex-wrap gap-1 mt-1">
                        {renderBadge('email', ch!.email)}
                        {renderBadge('in-app', ch!.inApp)}
                        {renderBadge('push', ch!.push)}
                        {renderBadge('sms', ch!.sms)}
                      </div>
                    ) : (
                      h.reason && <div className="text-white/60 break-words mt-0.5">{h.reason}</div>
                    )}
                    {suppressionReason && (
                      <div
                        className="mt-1 text-[11px] rounded border border-amber-500/30 bg-amber-500/10 text-amber-200 px-2 py-1"
                        data-testid={`resend-history-address-suppressed-${h.id}`}
                      >
                        Address is on the organisation's bounce list ({suppressionReason}).{' '}
                        <Link
                          to="/marketing"
                          className="underline hover:text-amber-100"
                          data-testid={`resend-history-address-suppressed-link-${h.id}`}
                        >
                          View suppressions
                        </Link>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
// Task #2245 — friendly labels for the suppression reasons that come back
// inside `address_suppressed:<reason>` on a skipped privacy email row. The
// raw reason strings are emitted by the org email-suppression list (see
// `dataRequestNotify.ts`); we map the well-known ones here and gracefully
// degrade to the underscored value (with underscores swapped for spaces)
// for any future reason the backend introduces.
const ADDRESS_SUPPRESSED_REASON_LABEL: Record<string, string> = {
  hard_bounce: 'hard bounce',
  soft_bounce: 'soft bounce',
  complaint: 'spam complaint',
  spam_complaint: 'spam complaint',
  unsubscribed: 'unsubscribed',
  manual: 'added manually',
};
export function parseAddressSuppressedReason(error: string | null | undefined): string | null {
  if (!error) return null;
  const prefix = 'address_suppressed:';
  if (!error.startsWith(prefix)) return null;
  const raw = error.slice(prefix.length).trim();
  if (!raw) return 'reason unspecified';
  return ADDRESS_SUPPRESSED_REASON_LABEL[raw] ?? raw.replace(/_/g, ' ');
}
function channelBadgeColor(status: string | null): string {
  switch (status) {
    case 'sent': return 'border-emerald-500/40 text-emerald-300';
    // Carrier-confirmed delivery / read states (Task #506) — stronger
    // emerald for `delivered`, cyan for `read` so admins can tell at a
    // glance that the member actually received (or opened) the notice.
    case 'delivered': return 'border-emerald-500/60 text-emerald-200 bg-emerald-500/10';
    case 'read': return 'border-cyan-500/60 text-cyan-200 bg-cyan-500/10';
    case 'failed': return 'border-red-500/40 text-red-300';
    case 'no_address':
    case 'no_user': return 'border-amber-500/40 text-amber-300';
    case 'opted_out':
    case 'skipped': return 'border-white/20 text-white/50';
    default: return 'border-white/20 text-white/60';
  }
}

/** Small carrier-confirmation icon for WhatsApp delivery chips (Task #506). */
function whatsappStatusIcon(status: string | null) {
  if (status === 'read') return <Eye className="w-3 h-3" aria-label="Read by recipient" />;
  if (status === 'delivered') return <CheckCheck className="w-3 h-3" aria-label="Delivered to recipient" />;
  return null;
}
/* ─── Erasure history (Task #776) ───────────────────────────────────────────
 * After the account-erasure cron runs it writes per-table row counts and
 * object-storage outcomes into `member_audit_log.metadata`. Compliance
 * officers reviewing the request need to see exactly what was removed
 * without reading raw JSON, so we surface the breakdown as a card on the
 * privacy panel and offer a regulator-facing CSV export.
 *
 * `objectStorageFilesFailed > 0` is highlighted as a warning — controllers
 * should re-run cleanup until all underlying storage objects are gone.
 */
interface ErasureHistoryEntry {
  auditId: number;
  completedAt: string;
  dataRequestId: number | null;
  source: string | null;
  mediaTablesPurged: Record<string, number>;
  totalMediaRowsPurged: number;
  playerRowsScrubbed: number | null;
  mediaRowsScrubbed: number | null;
  objectStorageFilesDeleted: number | null;
  objectStorageFilesMissing: number | null;
  objectStorageFilesFailed: number | null;
  objectStorageDisabled: boolean | null;
  // Task #1460 — only populated for `controller_acknowledgement` rows.
  acknowledgedAuditId: number | null;
  acknowledgementNote: string | null;
  actorName: string | null;
}

// Friendly labels for the raw DB table names that appear in mediaTablesPurged.
// Falls back to the table name itself if a future table is added without an
// entry here, so the UI keeps rendering useful data.
const ERASURE_TABLE_LABELS: Record<string, string> = {
  media: 'Tournament/league photos & videos',
  highlight_reels: 'Server-rendered highlight reels',
  swing_videos: 'Swing videos',
  swing_annotations: 'Swing annotations (voice-over)',
  swing_comparisons: 'Swing side-by-side comparisons',
  feed_post_media: 'Feed-post photos',
  member_documents: 'KYC / ID documents',
  member_document_versions: 'KYC document version history',
};

export function ErasureHistoryCard({ base }: { base: string }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data } = useQuery<{ entries: ErasureHistoryEntry[] }>({
    queryKey: ['member-360-tab', 'erasure-history', base],
    queryFn: () => j(base + '/erasure-history'),
  });
  const entries = data?.entries ?? [];
  // Task #1460 — controllers can mark a stuck cleanup "reviewed" without
  // running another retry. The dialog captures an optional free-text note
  // that's persisted alongside the audit row so the regulator-facing
  // history can show why the alert was acknowledged.
  const [ackOpen, setAckOpen] = useState(false);
  const [ackNote, setAckNote] = useState('');
  const [ackBusy, setAckBusy] = useState(false);
  const submitAck = async () => {
    setAckBusy(true);
    try {
      await j(base + '/erasure-history/acknowledge', {
        method: 'POST',
        body: JSON.stringify({ note: ackNote || null }),
      });
      toast({ title: 'Stuck-cleanup alert marked reviewed' });
      setAckOpen(false);
      setAckNote('');
      qc.invalidateQueries({ queryKey: ['member-360-tab', 'erasure-history', base] });
    } catch (err) {
      toast({
        title: 'Could not acknowledge',
        description: (err as Error).message,
        variant: 'destructive',
      });
    } finally {
      setAckBusy(false);
    }
  };
  if (entries.length === 0) return null;
  const downloadCsv = () => { window.open(base + '/erasure-history.csv', '_blank'); };
  // Surface the Acknowledge action whenever the most recent entry still
  // shows orphaned files. Hiding it once the count is zero matches the
  // dashboard semantics — there's nothing to acknowledge if the alert
  // already cleared.
  const latestFailed = (entries[0]?.objectStorageFilesFailed ?? 0) > 0;
  // Task #2243 — when the most recent audit row is a controller
  // acknowledgement, mark the failure row it acknowledged with the same
  // green "Acknowledged · {reviewer}" badge the org-wide stuck-cleanup
  // dashboard uses (Task #1795). Controllers viewing a single member can
  // then see the row was waived without cross-referencing the audit log.
  const latestAck = entries[0]?.source === 'controller_acknowledgement' ? entries[0] : null;
  return (
    <Card className="bg-white/5 border-white/10" data-testid="erasure-history-card">
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <History className="w-4 h-4" />Erasure history
          <div className="ml-auto flex items-center gap-2">
            {latestFailed && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setAckOpen(true)}
                data-testid="erasure-history-acknowledge"
              >
                <CheckCircle2 className="w-3.5 h-3.5 mr-1" />Mark reviewed
              </Button>
            )}
            <Button size="sm" variant="outline" onClick={downloadCsv} data-testid="erasure-history-csv">
              <Download className="w-3.5 h-3.5 mr-1" />Export CSV
            </Button>
          </div>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {entries.map(e => {
          const tables = Object.entries(e.mediaTablesPurged).sort((a, b) => a[0].localeCompare(b[0]));
          const failed = e.objectStorageFilesFailed ?? 0;
          const isAck = e.source === 'controller_acknowledgement';
          // Task #2243 — the failure row this entry waived (only set when
          // the latest history row is a controller acknowledgement and the
          // current row is the audit it pointed at). Mirrors the org-wide
          // dashboard in governance.tsx (Task #1795) so controllers see one
          // consistent treatment regardless of where they triage from.
          const ackedByLatest = !isAck && latestAck != null && latestAck.acknowledgedAuditId === e.auditId
            ? latestAck
            : null;
          const ackTooltip = ackedByLatest
            ? [
                ackedByLatest.actorName
                  ? `Acknowledged by ${ackedByLatest.actorName}`
                  : 'Acknowledged by a controller',
                `on ${new Date(ackedByLatest.completedAt).toLocaleString()}`,
                ackedByLatest.acknowledgementNote
                  ? `— ${ackedByLatest.acknowledgementNote}`
                  : null,
              ].filter(Boolean).join(' ')
            : undefined;
          return (
            <div
              key={e.auditId}
              className="p-3 rounded bg-white/5 border border-white/10 space-y-2"
              data-testid={`erasure-history-entry-${e.auditId}`}
              data-acknowledged={ackedByLatest ? 'true' : 'false'}
            >
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div className="text-sm">
                  <div className="font-medium flex items-center gap-2 flex-wrap">
                    <span>
                      {isAck
                        ? `Stuck-cleanup alert acknowledged ${new Date(e.completedAt).toLocaleString()}`
                        : `Account erased ${new Date(e.completedAt).toLocaleString()}`}
                    </span>
                    {ackedByLatest && (
                      <Badge
                        variant="outline"
                        className="border-emerald-300/40 text-emerald-100 text-[10px]"
                        title={ackTooltip}
                        data-testid={`erasure-history-acknowledged-${e.auditId}`}
                      >
                        Acknowledged{ackedByLatest.actorName ? ` · ${ackedByLatest.actorName}` : ''}
                      </Badge>
                    )}
                  </div>
                  <div className="text-xs text-white/50">
                    {e.dataRequestId ? `Request #${e.dataRequestId}` : 'No linked request'}
                    {e.source ? ` · ${e.source}` : ''}
                    {' · '}{e.totalMediaRowsPurged} media row{e.totalMediaRowsPurged === 1 ? '' : 's'} purged
                  </div>
                </div>
              </div>
              {tables.length > 0 ? (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-1 text-xs">
                  {tables.map(([table, count]) => (
                    <div key={table} className="flex items-center justify-between gap-2 px-2 py-1 rounded bg-white/5">
                      <span className="text-white/70">{ERASURE_TABLE_LABELS[table] ?? table}</span>
                      <Badge variant="outline" className="border-white/20" data-testid={`erasure-table-${table}`}>{count}</Badge>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-xs text-white/50">No personal media on file at the time of erasure.</div>
              )}
              <div className="flex flex-wrap items-center gap-2 text-xs pt-1 border-t border-white/5">
                <span className="text-white/40 uppercase tracking-wider">Object storage:</span>
                <Badge variant="outline" className="border-emerald-500/40 text-emerald-200">
                  deleted: {e.objectStorageFilesDeleted ?? 0}
                </Badge>
                <Badge variant="outline" className="border-white/20 text-white/60">
                  already gone: {e.objectStorageFilesMissing ?? 0}
                </Badge>
                <Badge
                  variant="outline"
                  className={failed > 0 ? 'border-red-500/60 text-red-200 bg-red-500/10' : 'border-white/20 text-white/60'}
                  data-testid="erasure-storage-failed"
                >
                  failed: {failed}
                </Badge>
                {e.objectStorageDisabled && (
                  <Badge variant="outline" className="border-amber-500/40 text-amber-300">
                    storage backend not configured
                  </Badge>
                )}
              </div>
              {failed > 0 && !isAck && (
                <div
                  className="flex items-start gap-2 text-xs p-2 rounded bg-red-500/10 border border-red-500/30 text-red-200"
                  data-testid="erasure-failed-warning"
                  role="alert"
                >
                  <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                  <div>
                    {failed} object-storage file{failed === 1 ? '' : 's'} could not be deleted. Re-run the
                    account-erasure cron or check the worker logs to clear this warning.
                  </div>
                </div>
              )}
              {isAck && (
                <div
                  className="text-xs text-white/60 space-y-1"
                  data-testid={`erasure-history-ack-note-${e.auditId}`}
                >
                  <div className="italic">
                    {e.actorName ?? 'Controller'} marked the stuck-cleanup alert reviewed
                    {failed > 0 ? ` (${failed} file${failed === 1 ? '' : 's'} still on file).` : '.'}
                  </div>
                  {e.acknowledgementNote && (
                    <div className="px-2 py-1 rounded bg-white/5 border border-white/10 text-white/70 not-italic">
                      “{e.acknowledgementNote}”
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </CardContent>
      <Dialog open={ackOpen} onOpenChange={setAckOpen}>
        <DialogContent data-testid="erasure-history-acknowledge-dialog">
          <DialogHeader>
            <DialogTitle>Mark stuck-cleanup alert reviewed</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <p className="text-white/70">
              This silences the cap-reached alert for this member without
              attempting another storage delete. The cron will re-arm the
              alert if cleanup keeps failing.
            </p>
            <div className="space-y-1">
              <Label htmlFor="erasure-ack-note">Reason (optional)</Label>
              <Textarea
                id="erasure-ack-note"
                data-testid="erasure-history-acknowledge-note"
                value={ackNote}
                onChange={(ev) => setAckNote(ev.target.value)}
                placeholder="e.g. files retained on legal hold per ticket #1234"
                rows={3}
                maxLength={1000}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setAckOpen(false)} disabled={ackBusy}>
              Cancel
            </Button>
            <Button
              onClick={submitAck}
              disabled={ackBusy}
              data-testid="erasure-history-acknowledge-submit"
            >
              {ackBusy ? 'Saving…' : 'Mark reviewed'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function DataRequestsTab({ base }: { base: string }) {
  const qc = useQueryClient();
  const { data, refetch } = useQuery<DataReqResponse>({ queryKey: ['member-360-tab', 'data-req', base], queryFn: () => j(base + '/data-requests') });
  const requests = data?.requests ?? [];
  // Task #1076: pull the validity window from the server (defaults to 7 if the
  // older API hasn't been deployed yet) so the countdown stays in sync with
  // DATA_EXPORT_VALID_DAYS instead of hardcoding it on the client.
  const exportValidForDays = data?.exportValidForDays ?? 7;
  const maxPushAttempts = data?.maxPushAttempts ?? DEFAULT_MAX_RETRY_ATTEMPTS;
  const maxSmsAttempts = data?.maxSmsAttempts ?? DEFAULT_MAX_RETRY_ATTEMPTS;
  const maxWhatsappAttempts = data?.maxWhatsappAttempts ?? DEFAULT_MAX_RETRY_ATTEMPTS;
  // Task #217: list of admin staff who can be assigned a privacy request.
  // base is `/api/organizations/:orgId/members-360/:memberId`; staff lives one
  // level up at `.../members-360/staff`.
  const staffUrl = base.substring(0, base.lastIndexOf('/')) + '/staff';
  const { data: staff = [] } = useQuery<PrivacyStaffMember[]>({
    queryKey: ['member-360-tab', 'data-req-staff', staffUrl],
    queryFn: () => j(staffUrl),
  });
  const { toast } = useToast();
  const create = async (requestType: string) => {
    await j(base + '/data-requests', { method: 'POST', body: JSON.stringify({ requestType }) });
    refetch(); toast({ title: 'Request logged' });
  };
  const reassign = async (id: number, handlerUserId: number | null) => {
    try {
      await j(base + '/data-requests/' + id, {
        method: 'PATCH',
        body: JSON.stringify({ handlerUserId }),
      });
      toast({ title: handlerUserId ? 'Request assigned' : 'Request unassigned' });
      refetch();
      qc.invalidateQueries({ queryKey: ['member-360-tab', 'audit', base] });
    } catch (err) {
      toast({ title: 'Assign failed', description: err instanceof Error ? err.message : String(err), variant: 'destructive' });
    }
  };
  const staffLabel = (s: PrivacyStaffMember) => s.displayName ?? s.username ?? s.email ?? `user #${s.id}`;
  const exportData = () => { window.open(base + '/export', '_blank'); };
  const resend = async (id: number) => {
    try {
      const res = await j<{ result: { emailStatus: string } }>(base + '/data-requests/' + id + '/resend', { method: 'POST', body: JSON.stringify({}) });
      const status = res?.result?.emailStatus ?? 'sent';
      toast({
        title: status === 'sent' ? 'Notification resent' : 'Notification retried',
        description: status === 'sent' ? 'Email and in-app notice delivered.' : `Email status: ${status}. In-app notice was recorded.`,
        variant: status === 'sent' ? 'default' : 'destructive',
      });
      refetch();
      qc.invalidateQueries({ queryKey: ['member-360-tab', 'data-req', base, 'resend-history', id] });
      qc.invalidateQueries({ queryKey: ['member-360-tab', 'audit', base] });
    } catch (err) {
      toast({ title: 'Resend failed', description: err instanceof Error ? err.message : String(err), variant: 'destructive' });
    }
  };
  const retryChannel = async (id: number, channel: 'push' | 'sms' | 'whatsapp') => {
    try {
      const res = await j<{ result: { status: string; attempts: number; exhausted: boolean; error?: string } }>(
        base + '/data-requests/' + id + '/retry-channel',
        { method: 'POST', body: JSON.stringify({ channel }) },
      );
      const r = res?.result;
      const ok = r?.status === 'sent';
      const cap = channel === 'push' ? maxPushAttempts : channel === 'sms' ? maxSmsAttempts : maxWhatsappAttempts;
      toast({
        title: ok ? `${channel.toUpperCase()} retry sent` : `${channel.toUpperCase()} retry — ${r?.status ?? 'unknown'}`,
        description: r
          ? `Attempt ${r.attempts} of ${cap}${r.exhausted ? ' — retry cap reached' : ''}${r.error ? ` · ${r.error}` : ''}`
          : undefined,
        variant: ok ? 'default' : 'destructive',
      });
      refetch();
      qc.invalidateQueries({ queryKey: ['member-360-tab', 'data-req', base, 'resend-history', id] });
      qc.invalidateQueries({ queryKey: ['member-360-tab', 'audit', base] });
    } catch (err) {
      toast({ title: `${channel.toUpperCase()} retry failed`, description: err instanceof Error ? err.message : String(err), variant: 'destructive' });
    }
  };
  // Task #1076: surface a per-row countdown ("Expires in 2 days") and a
  // top-of-card amber banner when any export's signed URL falls inside the
  // last 24h — matching the daily reminder cron's window. Validity is the
  // server-side DATA_EXPORT_VALID_DAYS (7) starting from resolvedAt.
  const exportCountdowns = requests.map(r => {
    if (r.requestType !== 'access' || r.status !== 'completed' || !r.resolvedAt) {
      return { id: r.id, label: null as string | null, urgent: false, expired: false };
    }
    const expiresMs = new Date(r.resolvedAt).getTime() + exportValidForDays * 24 * 60 * 60 * 1000;
    // Task #1123: once the daily purge cron clears the archive (purgedAt set
    // or the signed artifactUrl removed) the countdown flips to a static
    // "Expired on <date>" so the member-facing deadline keeps its meaning even
    // after the link stops working. Prefer the actual purge timestamp when we
    // have one; otherwise fall back to the computed retention expiry.
    if (r.purgedAt || !r.artifactUrl) {
      const expiredOn = r.purgedAt ? new Date(r.purgedAt) : new Date(expiresMs);
      if (!Number.isFinite(expiredOn.getTime())) {
        return { id: r.id, label: null, urgent: false, expired: false };
      }
      return {
        id: r.id,
        label: `Expired on ${expiredOn.toLocaleDateString()}`,
        urgent: false,
        expired: true,
      };
    }
    const remaining = expiresMs - Date.now();
    if (!Number.isFinite(remaining)) return { id: r.id, label: null, urgent: false, expired: false };
    if (remaining <= 0) {
      return {
        id: r.id,
        label: `Expired on ${new Date(expiresMs).toLocaleDateString()}`,
        urgent: false,
        expired: true,
      };
    }
    const hours = Math.floor(remaining / (60 * 60 * 1000));
    const urgent = hours < 24;
    let label: string;
    if (hours < 1) {
      const minutes = Math.max(1, Math.floor(remaining / (60 * 1000)));
      label = `Expires in ${minutes} minute${minutes === 1 ? '' : 's'}`;
    } else if (hours < 24) {
      label = `Expires in ${hours} hour${hours === 1 ? '' : 's'}`;
    } else {
      const days = Math.floor(hours / 24);
      label = `Expires in ${days} day${days === 1 ? '' : 's'}`;
    }
    return { id: r.id, label, urgent, expired: false };
  });
  const expiringSoon = exportCountdowns.filter(c => c.urgent);
  return (
    <div className="space-y-3">
    <Card className="bg-white/5 border-white/10">
      <CardHeader><CardTitle className="text-base flex items-center gap-2"><Shield className="w-4 h-4" />Data Subject Rights (GDPR / DPDP)</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        {expiringSoon.length > 0 && (
          <div
            className="flex items-start gap-2 rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-amber-200 text-xs"
            role="alert"
            data-testid="data-export-expiring-banner"
          >
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            <div>
              {expiringSoon.length === 1
                ? `Export #${expiringSoon[0].id} expires in less than 24 hours.`
                : `${expiringSoon.length} exports expire in less than 24 hours.`} The download
              link will stop working once the daily purge runs — encourage the member to
              save a copy now.
            </div>
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={exportData}><Download className="w-4 h-4 mr-1" />Export all data (JSON)</Button>
          <Button size="sm" variant="outline" onClick={() => create('access')}>Log access request</Button>
          <Button size="sm" variant="outline" onClick={() => create('rectification')}>Log rectification</Button>
          <Button size="sm" variant="outline" onClick={() => create('erasure')}>Log erasure request</Button>
          <Button size="sm" variant="outline" onClick={() => create('portability')}>Log portability request</Button>
        </div>
        <div className="space-y-2">
          {requests.map(r => {
            const inAppStatus = r.lastInAppMessageId ? 'sent' : 'skipped';
            const channelError = r.lastEmailError || r.lastPushError || r.lastSmsError;
            const countdown = exportCountdowns.find(c => c.id === r.id);
            return (
              <div key={r.id} className="p-3 rounded bg-white/5 border border-white/10 space-y-2" data-testid={`data-request-row-${r.id}`}>
                <div className="flex items-center justify-between">
                  <div>
                    <div className="font-medium text-sm">{r.requestType}</div>
                    <div className="text-xs text-white/50">Requested {new Date(r.requestedAt).toLocaleDateString()}{r.dueBy ? ` · Due ${new Date(r.dueBy).toLocaleDateString()}` : ''}</div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className="border-white/20">{r.status}</Badge>
                    {countdown?.label && (
                      <Badge
                        variant="outline"
                        className={countdown.urgent
                          ? 'border-amber-500/40 bg-amber-500/10 text-amber-200'
                          : countdown.expired
                            ? 'border-white/20 bg-white/5 text-white/50'
                            : 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200'}
                        data-testid={`data-export-countdown-${r.id}`}
                        title="How long the signed download link stays valid"
                      >
                        {countdown.label}
                      </Badge>
                    )}
                    {r.lastNotificationKind === 'completed_export' && (
                      <Badge
                        variant="outline"
                        className="border-emerald-500/40 bg-emerald-500/10 text-emerald-200"
                        data-testid={`data-request-export-ready-badge-${r.id}`}
                        title="Latest notification was the self-serve data export download notice"
                      >
                        <Download className="w-3 h-3 mr-1" />Export ready
                      </Badge>
                    )}
                    {r.lastNotificationKind === 'export_expiring' && (
                      <Badge
                        variant="outline"
                        className="border-amber-500/40 bg-amber-500/10 text-amber-200"
                        data-testid={`data-request-export-expiring-badge-${r.id}`}
                        title="Latest notification was the 'export expires in 24h' reminder"
                      >
                        <Download className="w-3 h-3 mr-1" />Export expiring
                      </Badge>
                    )}
                    {r.resendCount > 0 && (
                      <ResendHistoryPopover base={base} requestId={r.id} count={r.resendCount} lastAt={r.lastResendAt} kind={r.lastNotificationKind} />
                    )}
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => resend(r.id)}
                      title={r.lastEmailStatus === 'failed' || r.lastEmailStatus === 'no_address'
                        ? 'Retry the last notification (email previously failed)'
                        : 'Resend the last notification'}
                    >
                      <Send className="w-3.5 h-3.5 mr-1" />Resend
                    </Button>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2 pt-1 border-t border-white/5 text-xs">
                  <span className="text-white/40 uppercase tracking-wider">Assigned to:</span>
                  <Select
                    value={r.handlerUserId ? String(r.handlerUserId) : 'unassigned'}
                    onValueChange={v => reassign(r.id, v === 'unassigned' ? null : parseInt(v))}
                  >
                    <SelectTrigger className="h-7 w-[220px] text-xs" data-testid={`assign-handler-${r.id}`}>
                      <SelectValue placeholder="Unassigned" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="unassigned">Unassigned</SelectItem>
                      {/* Always include the currently-assigned user even if no longer in the staff list */}
                      {r.handlerUserId && !staff.some(s => s.id === r.handlerUserId) && (
                        <SelectItem value={String(r.handlerUserId)}>
                          {r.handlerDisplayName ?? r.handlerUsername ?? r.handlerEmail ?? `user #${r.handlerUserId}`} (former)
                        </SelectItem>
                      )}
                      {staff.map(s => (
                        <SelectItem key={s.id} value={String(s.id)}>
                          {staffLabel(s)} <span className="text-white/40">· {s.role}</span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                {r.lastNotificationKind && (
                  <div className="flex flex-wrap items-center gap-2 pt-1 border-t border-white/5 text-xs">
                    <span className="text-white/40 uppercase tracking-wider" data-testid={`data-request-last-notice-label-${r.id}`}>
                      Last notice ({notificationKindLabel(r.lastNotificationKind)}):
                    </span>
                    <Badge
                      variant="outline"
                      className={channelBadgeColor(r.lastEmailStatus)}
                      title={[
                        (r.emailAttempts ?? 0) > 0 ? `Attempts: ${r.emailAttempts}` : null,
                        r.lastEmailRetryAt ? `Last retry: ${new Date(r.lastEmailRetryAt).toLocaleString()}` : null,
                        r.emailRetryExhaustedAt ? `Retries exhausted ${new Date(r.emailRetryExhaustedAt).toLocaleString()}` : null,
                      ].filter(Boolean).join(' · ') || undefined}
                    >
                      email: {r.lastEmailStatus ?? 'unknown'}
                      {(r.emailAttempts ?? 0) > 1 && <span className="ml-1 opacity-70">×{r.emailAttempts}</span>}
                      {r.emailRetryExhaustedAt && <span className="ml-1">· retries exhausted</span>}
                    </Badge>
                    <Badge variant="outline" className={channelBadgeColor(inAppStatus)}>in-app: {inAppStatus}</Badge>
                    <Badge
                      variant="outline"
                      className={channelBadgeColor(r.lastPushStatus)}
                      title={[
                        (r.pushAttempts ?? 0) > 0 ? `Attempts: ${r.pushAttempts}/${maxPushAttempts}` : null,
                        r.lastPushRetryAt ? `Last retry: ${new Date(r.lastPushRetryAt).toLocaleString()}` : null,
                        r.pushRetryExhaustedAt ? `Retries exhausted ${new Date(r.pushRetryExhaustedAt).toLocaleString()}` : null,
                      ].filter(Boolean).join(' · ') || undefined}
                    >
                      push: {r.lastPushStatus ?? 'unknown'} · {r.pushAttempts ?? 0}/{maxPushAttempts}
                      {r.pushRetryExhaustedAt && <span className="ml-1">· retries exhausted</span>}
                    </Badge>
                    {r.lastPushRetryAt && (
                      <span className="text-white/40">push retry: {new Date(r.lastPushRetryAt).toLocaleString()}</span>
                    )}
                    <Badge
                      variant="outline"
                      className={channelBadgeColor(r.lastSmsStatus)}
                      title={[
                        (r.smsAttempts ?? 0) > 0 ? `Attempts: ${r.smsAttempts}/${maxSmsAttempts}` : null,
                        r.lastSmsRetryAt ? `Last retry: ${new Date(r.lastSmsRetryAt).toLocaleString()}` : null,
                        r.smsRetryExhaustedAt ? `Retries exhausted ${new Date(r.smsRetryExhaustedAt).toLocaleString()}` : null,
                      ].filter(Boolean).join(' · ') || undefined}
                    >
                      sms: {r.lastSmsStatus ?? 'unknown'} · {r.smsAttempts ?? 0}/{maxSmsAttempts}
                      {r.smsRetryExhaustedAt && <span className="ml-1">· retries exhausted</span>}
                    </Badge>
                    {r.lastSmsRetryAt && (
                      <span className="text-white/40">sms retry: {new Date(r.lastSmsRetryAt).toLocaleString()}</span>
                    )}
                    <Badge
                      variant="outline"
                      className={`${channelBadgeColor(r.lastWhatsappStatus)} inline-flex items-center gap-1`}
                      data-testid={`data-request-whatsapp-${r.id}`}
                      data-whatsapp-status={r.lastWhatsappStatus ?? 'unknown'}
                      title={[
                        r.lastWhatsappStatus === 'delivered' ? 'Carrier confirmed delivery' : null,
                        r.lastWhatsappStatus === 'read' ? 'Recipient opened the message' : null,
                        (r.whatsappAttempts ?? 0) > 0 ? `Attempts: ${r.whatsappAttempts}/${maxWhatsappAttempts}` : null,
                        r.lastWhatsappRetryAt ? `Last retry: ${new Date(r.lastWhatsappRetryAt).toLocaleString()}` : null,
                        r.whatsappRetryExhaustedAt ? `Retries exhausted ${new Date(r.whatsappRetryExhaustedAt).toLocaleString()}` : null,
                      ].filter(Boolean).join(' · ') || undefined}
                    >
                      whatsapp: {r.lastWhatsappStatus ?? 'unknown'}
                      {whatsappStatusIcon(r.lastWhatsappStatus)}
                      <span>· {r.whatsappAttempts ?? 0}/{maxWhatsappAttempts}</span>
                      {r.whatsappRetryExhaustedAt && <span className="ml-1">· retries exhausted</span>}
                    </Badge>
                    {r.lastWhatsappRetryAt && (
                      <span className="text-white/40">whatsapp retry: {new Date(r.lastWhatsappRetryAt).toLocaleString()}</span>
                    )}
                    {r.lastNotifiedAt && (
                      <span className="text-white/40">{new Date(r.lastNotifiedAt).toLocaleString()}</span>
                    )}
                    {channelError && (
                      <span className="text-red-300/70 break-all">· {channelError}</span>
                    )}
                  </div>
                )}
                {(r.lastPushStatus === 'failed' || r.lastSmsStatus === 'failed' || r.lastWhatsappStatus === 'failed') && (
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    {r.lastPushStatus === 'failed' && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={(r.pushAttempts ?? 0) >= maxPushAttempts || !!r.pushRetryExhaustedAt}
                        onClick={() => retryChannel(r.id, 'push')}
                        title={(r.pushAttempts ?? 0) >= maxPushAttempts
                          ? 'Push retry cap reached'
                          : 'Force an immediate push retry'}
                      >
                        <Send className="w-3.5 h-3.5 mr-1" />Retry push now
                      </Button>
                    )}
                    {r.lastSmsStatus === 'failed' && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={(r.smsAttempts ?? 0) >= maxSmsAttempts || !!r.smsRetryExhaustedAt}
                        onClick={() => retryChannel(r.id, 'sms')}
                        title={(r.smsAttempts ?? 0) >= maxSmsAttempts
                          ? 'SMS retry cap reached'
                          : 'Force an immediate SMS retry'}
                      >
                        <Send className="w-3.5 h-3.5 mr-1" />Retry SMS now
                      </Button>
                    )}
                    {r.lastWhatsappStatus === 'failed' && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={(r.whatsappAttempts ?? 0) >= maxWhatsappAttempts || !!r.whatsappRetryExhaustedAt}
                        onClick={() => retryChannel(r.id, 'whatsapp')}
                        title={(r.whatsappAttempts ?? 0) >= maxWhatsappAttempts
                          ? 'WhatsApp retry cap reached'
                          : 'Force an immediate WhatsApp retry'}
                      >
                        <Send className="w-3.5 h-3.5 mr-1" />Retry WhatsApp now
                      </Button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
    <ErasureHistoryCard base={base} />
    </div>
  );
}

/* ─── AUDIT ─── */
interface AuditEntry {
  id: number;
  entity: string;
  entityId: number | null;
  action: string;
  actorName: string | null;
  actorRole: string | null;
  reason: string | null;
  fieldChanges: Record<string, { from: unknown; to: unknown }> | null;
  // Free-form structured metadata. Used by Task #970 to detect cron-sourced
  // audit rows (`metadata.source === "cron"`).
  metadata: Record<string, unknown> | null;
  createdAt: string;
  ipAddress: string | null;
  // Deep-link to the parent levy / charge in the levy ledger (Task #236)
  // so admins can jump from an audit row straight to the charge's Activity
  // timeline. Present only for entity='levy_charge' rows.
  linkedLevyId?: number | null;
  linkedChargeId?: number | null;
  // Deep-link to the parent member_data_requests row in the Data / GDPR
  // tab (Task #1121) so admins can jump from a `data_export` purge audit
  // row straight to the export record. Present only for entity='data_export'
  // rows; null otherwise. `linkedDataRequestType` mirrors the request type
  // (access / erasure / …) so the link copy can be a touch more specific.
  linkedDataRequestId?: number | null;
  linkedDataRequestType?: string | null;
  // Receipt-delivery fields joined from member_levy_charges (Task #253).
  // Present only for entity='levy_charge' rows; null otherwise.
  receiptLevyId: number | null;
  receiptStatus: 'sent' | 'skipped' | 'failed' | null;
  receiptReason: string | null;
  receiptKind: 'payment' | 'partial_payment' | 'refund' | 'waiver' | null;
  receiptAmount: string | null;
  receiptAt: string | null;
  // Task #1928 — populated only on `email_suppression` reenable /
  // reenable_with_replacement rows whose follow-up bounce was found in
  // the suppressions table. Lets the timeline render a "Bounced again on
  // <date>" sub-line so admins reviewing this member see whether the
  // recovery stuck without flipping over to the Marketing → Suppressions
  // list.
  subsequentBounce?: {
    email: string;
    at: string;
    reason: string;
    bounceType: string | null;
    description: string | null;
  } | null;
}
// Task #970: friendly labels for the entity-filter dropdown in the audit
// timeline. Keep this list short — only entities admins commonly drill into
// surface here. Unknown entities still render fine via the raw entity slug.
const AUDIT_ENTITY_FILTERS: { value: string; label: string }[] = [
  { value: 'all', label: 'All entities' },
  { value: 'profile', label: 'Profile' },
  { value: 'document', label: 'Documents' },
  { value: 'consent', label: 'Consents' },
  { value: 'levy_charge', label: 'Levy charges' },
  { value: 'data_export', label: 'Data export' },
  { value: 'note', label: 'Internal notes' },
  { value: 'club_member', label: 'Member account' },
];

export function AuditTab({ base, orgId, memberId, onOpenDataRequest }: { base: string; orgId: number; memberId: number; onOpenDataRequest?: (requestId: number) => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [entityFilter, setEntityFilter] = useState<string>('all');
  const { data = [] } = useQuery<AuditEntry[]>({
    queryKey: ['member-360-tab', 'audit', base, entityFilter],
    queryFn: () => j(`${base}/audit-log?limit=200${entityFilter !== 'all' ? `&entity=${encodeURIComponent(entityFilter)}` : ''}`),
  });
  const [resendingChargeId, setResendingChargeId] = useState<number | null>(null);
  // Task #290: which audit rows have their receipt-attempts trail expanded.
  // Keyed by audit entry id so each row toggles independently.
  const [expandedAuditIds, setExpandedAuditIds] = useState<Set<number>>(new Set());
  const toggleExpanded = (id: number) => {
    setExpandedAuditIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const resendReceipt = async (a: AuditEntry) => {
    if (a.entityId == null || a.receiptLevyId == null) return;
    setResendingChargeId(a.entityId);
    try {
      await j(`/api/organizations/${orgId}/members-360/levies/${a.receiptLevyId}/charges/${memberId}/resend-receipt`, { method: 'POST' });
      toast({ title: 'Receipt resent', description: 'A fresh receipt has been queued.' });
      qc.invalidateQueries({ queryKey: ['member-360-tab', 'audit', base] });
    } catch (e) {
      toast({ title: 'Resend failed', description: (e as Error).message, variant: 'destructive' });
    } finally {
      setResendingChargeId(null);
    }
  };
  return (
    <Card className="bg-white/5 border-white/10">
      <CardHeader>
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <CardTitle className="text-base flex items-center gap-2"><Clock className="w-4 h-4" />Audit Trail</CardTitle>
          <div className="flex items-center gap-2">
            <Label className="text-xs text-white/60">Filter</Label>
            <Select value={entityFilter} onValueChange={setEntityFilter}>
              <SelectTrigger
                className="w-[180px] h-8 bg-white/5 border-white/10 text-sm"
                data-testid="select-audit-entity-filter"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {AUDIT_ENTITY_FILTERS.map(opt => (
                  <SelectItem
                    key={opt.value}
                    value={opt.value}
                    data-testid={`select-audit-entity-option-${opt.value}`}
                  >
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {data.length === 0 ? <p className="text-white/40 text-sm">No audit entries.</p> : (
          <div className="space-y-2 max-h-[600px] overflow-y-auto">
            {data.map(a => {
              // Task #236: levy_charge audit rows deep-link to the charge's
              // Activity timeline in the levy ledger so admins can reverse the
              // entry without hunting through levies. The link is only safe to
              // render once the API has resolved the parent levy id.
              const levyLink = a.entity === 'levy_charge' && a.linkedLevyId
                ? `${BASE}/club-members?openLevy=${a.linkedLevyId}${a.linkedChargeId ? `&openCharge=${a.linkedChargeId}` : ''}`
                : null;
              // Task #253: also surface the latest receipt-delivery outcome
              // alongside the action and offer a resend shortcut for
              // failed/skipped receipts so admins don't have to leave the
              // audit timeline.
              const isLevy = a.entity === 'levy_charge' && a.receiptStatus != null;
              const at = a.receiptAt ? new Date(a.receiptAt) : null;
              const tsLabel = at ? at.toLocaleString() : '';
              const kindLabel = a.receiptKind === 'partial_payment' ? 'partial payment' : (a.receiptKind ?? '');
              const baseTitle = `${kindLabel ? `${kindLabel} receipt — ` : ''}${tsLabel}`;
              const reasonText = a.receiptReason
                ? a.receiptReason === 'no_email' ? 'No email on file'
                : a.receiptReason === 'billing_email_opted_out' ? 'Billing email opt-out'
                : a.receiptReason
                : (a.receiptStatus === 'skipped' ? 'Skipped' : a.receiptStatus === 'failed' ? 'Send failed' : '');
              const canResend = isLevy && (a.receiptStatus === 'failed' || a.receiptStatus === 'skipped') && a.receiptLevyId != null;
              // Task #290: any levy_charge row with a known parent levy can
              // expand to reveal the full per-attempt receipt trail (push +
              // SMS retries) from member_levy_receipt_attempts.
              const canExpandReceipts = a.entity === 'levy_charge' && a.receiptLevyId != null && a.entityId != null;
              const isExpanded = expandedAuditIds.has(a.id);
              // Task #970: render the data-export auto-purge rows with
              // friendly copy ("Your data export was auto-deleted on …")
              // and tag the row with the cron source so members and
              // controllers can see at a glance that the system — not a
              // staffer — wiped the archive.
              const isDataExportPurge = a.entity === 'data_export' && a.action === 'purge';
              const auditMeta = a.metadata as Record<string, unknown> | null | undefined;
              const isCronSource = !!auditMeta && auditMeta.source === 'cron';
              const dataExportSummary = isDataExportPurge
                ? `Data export #${a.entityId ?? '—'} auto-deleted on ${new Date(a.createdAt).toLocaleDateString()} by the system`
                : null;
              const entityLabel =
                a.entity === 'data_export' ? 'Data export'
                : a.entity;
              // Task #1121: data_export audit rows deep-link to the matching
              // member_data_requests row in the Data / GDPR tab so admins
              // don't have to switch tabs and hunt for the export. Mirrors
              // the levy_charge link pattern (Task #236) but stays in-page
              // because the request lives on a sibling tab.
              const dataExportRequestId = a.entity === 'data_export'
                ? (a.linkedDataRequestId ?? a.entityId)
                : null;
              const canOpenDataExport = dataExportRequestId != null && !!onOpenDataRequest;
              return (
                <div key={a.id} className="p-3 rounded bg-white/5 border border-white/10 text-sm" data-testid={`audit-entry-${a.id}`}>
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <span className="flex items-center gap-2 flex-wrap">
                      {canExpandReceipts && (
                        <button
                          type="button"
                          onClick={() => toggleExpanded(a.id)}
                          className="text-white/60 hover:text-white"
                          aria-label={isExpanded ? 'Hide receipt history' : 'Show receipt history'}
                          aria-expanded={isExpanded}
                          title={isExpanded ? 'Hide receipt history' : 'Show full receipt history'}
                          data-testid={`button-audit-toggle-receipts-${a.id}`}
                        >
                          {isExpanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                        </button>
                      )}
                      <Badge variant="outline" className="border-white/20">{a.action}</Badge>
                      {levyLink ? (
                        <Link
                          href={levyLink}
                          className="text-amber-300 hover:text-amber-200 underline underline-offset-2"
                          data-testid={`audit-entry-levy-link-${a.id}`}
                        >
                          {entityLabel}{a.entityId ? `#${a.entityId}` : ''} · view in ledger
                        </Link>
                      ) : canOpenDataExport ? (
                        <button
                          type="button"
                          onClick={() => onOpenDataRequest!(dataExportRequestId!)}
                          className="text-emerald-300 hover:text-emerald-200 underline underline-offset-2"
                          data-testid={`audit-entry-data-export-link-${a.id}`}
                          title="Open this export in the Data / GDPR tab"
                        >
                          {entityLabel}{a.entityId ? `#${a.entityId}` : ''}
                          {a.linkedDataRequestType ? ` · ${a.linkedDataRequestType}` : ''} · view in privacy
                        </button>
                      ) : (
                        <span
                          className="text-white/80"
                          data-testid={`audit-entry-entity-${a.id}`}
                        >
                          {entityLabel}{a.entityId ? `#${a.entityId}` : ''}
                        </span>
                      )}
                      {isCronSource && (
                        <Badge
                          variant="outline"
                          className="border-sky-500/40 text-sky-300 text-[10px] uppercase tracking-wide"
                          title="Recorded by the nightly purge job"
                          data-testid={`audit-source-cron-${a.id}`}
                        >
                          system
                        </Badge>
                      )}
                      {isLevy && a.receiptStatus === 'sent' && (
                        <Badge
                          className="bg-emerald-500/20 text-emerald-300 border-emerald-500/30 border text-xs gap-1"
                          title={baseTitle}
                          data-testid={`audit-receipt-status-${a.id}`}
                        >
                          <MailCheck className="w-3 h-3" /> Receipt sent
                        </Badge>
                      )}
                      {isLevy && a.receiptStatus === 'skipped' && (
                        <Badge
                          className="bg-amber-500/20 text-amber-300 border-amber-500/30 border text-xs gap-1"
                          title={`${baseTitle}${reasonText ? ` — ${reasonText}` : ''}`}
                          data-testid={`audit-receipt-status-${a.id}`}
                        >
                          <MailWarning className="w-3 h-3" /> Receipt skipped
                        </Badge>
                      )}
                      {isLevy && a.receiptStatus === 'failed' && (
                        <Badge
                          className="bg-rose-500/20 text-rose-300 border-rose-500/30 border text-xs gap-1"
                          title={`${baseTitle}${reasonText ? ` — ${reasonText}` : ''}`}
                          data-testid={`audit-receipt-status-${a.id}`}
                        >
                          <MailX className="w-3 h-3" /> Receipt failed
                        </Badge>
                      )}
                    </span>
                    <span className="flex items-center gap-2">
                      {canResend && (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={resendingChargeId === a.entityId}
                          onClick={() => resendReceipt(a)}
                          className="h-6 px-2 text-[11px] text-amber-300 hover:bg-white/5 gap-1"
                          data-testid={`button-audit-resend-receipt-${a.id}`}
                        >
                          <Send className="w-3 h-3" />
                          {resendingChargeId === a.entityId ? 'Sending…' : 'Resend receipt'}
                        </Button>
                      )}
                      <span className="text-xs text-white/50">{new Date(a.createdAt).toLocaleString()}</span>
                    </span>
                  </div>
                  {dataExportSummary && (
                    <div
                      className="text-sm text-white/80 mt-1"
                      data-testid={`audit-data-export-summary-${a.id}`}
                    >
                      {dataExportSummary}.
                    </div>
                  )}
                  <div className="text-xs text-white/60 mt-1">
                    by {a.actorName ?? 'system'}{a.actorRole ? ` (${a.actorRole})` : ''}
                    {a.reason ? ` · ${a.reason}` : ''}
                    {a.ipAddress ? ` · ${a.ipAddress}` : ''}
                  </div>
                  {isLevy && a.receiptStatus !== 'sent' && reasonText && (
                    <div className="text-[11px] text-white/50 mt-1" data-testid={`audit-receipt-reason-${a.id}`}>
                      Receipt: {reasonText}{at ? ` · ${at.toLocaleString()}` : ''}
                    </div>
                  )}
                  {a.subsequentBounce && (
                    <div
                      className="text-[11px] text-rose-300 mt-1 flex items-center gap-1"
                      title={[
                        a.subsequentBounce.email ? `Address: ${a.subsequentBounce.email}` : '',
                        a.subsequentBounce.bounceType ? `Bounce type: ${a.subsequentBounce.bounceType}` : '',
                        a.subsequentBounce.reason ? `Reason: ${a.subsequentBounce.reason}` : '',
                        a.subsequentBounce.description ? a.subsequentBounce.description : '',
                      ].filter(Boolean).join('\n')}
                      data-testid={`audit-subsequent-bounce-${a.id}`}
                    >
                      <AlertTriangle className="w-3 h-3" />
                      Bounced again on {new Date(a.subsequentBounce.at).toLocaleDateString()}
                      {a.subsequentBounce.bounceType ? ` · ${a.subsequentBounce.bounceType}` : ''}
                    </div>
                  )}
                  {a.fieldChanges && Object.keys(a.fieldChanges).length > 0 && (
                    <pre className="text-xs text-white/50 mt-2 overflow-x-auto bg-black/30 p-2 rounded">{JSON.stringify(a.fieldChanges, null, 2)}</pre>
                  )}
                  {canExpandReceipts && isExpanded && (
                    <ReceiptAttemptsPanel
                      orgId={orgId}
                      memberId={memberId}
                      levyId={a.receiptLevyId!}
                      auditId={a.id}
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/* ─── RECEIPT ATTEMPTS (Task #290) ──────────────────────────────────────── */
interface ReceiptAttempt {
  id: number;
  kind: 'payment' | 'partial_payment' | 'refund' | 'waiver' | string;
  transactionAmount: string | null;
  newBalance: string | null;
  note: string | null;
  createdAt: string;
  pushStatus: string | null;
  pushAttempts: number | null;
  lastPushAt: string | null;
  lastPushError: string | null;
  lastPushRetryAt: string | null;
  pushRetryExhaustedAt: string | null;
  smsStatus: string | null;
  smsAttempts: number | null;
  lastSmsAt: string | null;
  lastSmsError: string | null;
  lastSmsRetryAt: string | null;
  smsRetryExhaustedAt: string | null;
  whatsappStatus: string | null;
  whatsappAttempts: number | null;
  lastWhatsappAt: string | null;
  lastWhatsappError: string | null;
  lastWhatsappRetryAt: string | null;
  whatsappRetryExhaustedAt: string | null;
}
interface ReceiptAttemptsResponse {
  chargeId: number;
  currency: string;
  maxPushAttempts: number;
  maxSmsAttempts: number;
  maxWhatsappAttempts: number;
  attempts: ReceiptAttempt[];
}
function ReceiptAttemptsPanel({ orgId, memberId, levyId, auditId }: {
  orgId: number; memberId: number; levyId: number; auditId: number;
}) {
  // The API route is GET /levies/:id/charges/:memberId/receipts — the
  // ":memberId" path segment is the member, not the charge id. The route
  // resolves the charge internally via (levyId, memberId).
  const url = `/api/organizations/${orgId}/members-360/levies/${levyId}/charges/${memberId}/receipts`;
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data, isLoading, error } = useQuery<ReceiptAttemptsResponse>({
    queryKey: ['member-360-tab', 'audit-receipts', orgId, memberId, levyId],
    queryFn: () => j(url),
  });
  // Task #338: per-channel manual retry from the audit timeline. Mirrors the
  // privacy-request and ledger widgets; targets the latest attempt for this
  // charge via the convenience POST /retry-receipt-channel endpoint so the
  // audit row doesn't need to know which attempt id is current.
  const [retryingChannel, setRetryingChannel] = useState<'push' | 'sms' | 'whatsapp' | null>(null);
  const channelLabel = (c: 'push' | 'sms' | 'whatsapp') => c === 'push' ? 'Push' : c === 'sms' ? 'SMS' : 'WhatsApp';
  const retryChannel = async (channel: 'push' | 'sms' | 'whatsapp') => {
    setRetryingChannel(channel);
    try {
      await j(
        `/api/organizations/${orgId}/members-360/levies/${levyId}/charges/${memberId}/retry-receipt-channel`,
        { method: 'POST', body: JSON.stringify({ channel }) },
      );
      toast({ title: `${channelLabel(channel)} retried`, description: 'A fresh attempt has been recorded.' });
      qc.invalidateQueries({ queryKey: ['member-360-tab', 'audit-receipts', orgId, memberId, levyId] });
      qc.invalidateQueries({ queryKey: ['member-360-tab', 'audit'] });
    } catch (e) {
      toast({ title: 'Retry failed', description: (e as Error).message, variant: 'destructive' });
    } finally {
      setRetryingChannel(null);
    }
  };
  const renderChannel = (
    label: 'Push' | 'SMS' | 'WhatsApp',
    status: string | null,
    attempts: number | null,
    cap: number,
    lastAt: string | null,
    lastError: string | null,
    exhaustedAt: string | null,
    retryButton?: ReactNode,
  ) => {
    const cls = channelBadgeColor(status);
    const tipLines: string[] = [`${label}: ${status ?? 'not attempted'}`];
    if (attempts != null) tipLines.push(`Attempt ${attempts} of ${cap}`);
    if (lastAt) tipLines.push(`at ${new Date(lastAt).toLocaleString()}`);
    if (lastError) tipLines.push(`error: ${lastError}`);
    if (exhaustedAt) tipLines.push(`Retries exhausted ${new Date(exhaustedAt).toLocaleString()}`);
    return (
      <div className="flex flex-col gap-0.5">
        <Badge
          variant="outline"
          className={`${cls} cursor-help w-fit`}
          title={tipLines.join('\n')}
          data-testid={`audit-receipt-attempt-${auditId}-${label.toLowerCase()}-status`}
        >
          {label}: {status ?? '—'}
          {attempts != null && (
            <span className="ml-1 text-white/60">{attempts}/{cap}</span>
          )}
        </Badge>
        <div className="text-[11px] text-white/50">
          {lastAt ? new Date(lastAt).toLocaleString() : 'no attempt recorded'}
          {exhaustedAt && (
            <span
              className="ml-1 text-amber-300"
              data-testid={`audit-receipt-attempt-${auditId}-${label.toLowerCase()}-exhausted`}
            >
              · retries exhausted
            </span>
          )}
        </div>
        {lastError && (
          <div className="text-[11px] text-red-300/80 break-words">{lastError}</div>
        )}
        {retryButton}
      </div>
    );
  };
  return (
    <div
      className="mt-2 rounded border border-white/10 bg-black/30 p-2 space-y-2"
      data-testid={`audit-receipt-attempts-${auditId}`}
    >
      <div className="text-[11px] uppercase tracking-wider text-white/50">Receipt delivery history</div>
      {isLoading && <div className="text-xs text-white/50">Loading…</div>}
      {error && (
        <div className="text-xs text-red-300" data-testid={`audit-receipt-attempts-error-${auditId}`}>
          Failed to load receipt history: {(error as Error).message}
        </div>
      )}
      {!isLoading && !error && (data?.attempts.length ?? 0) === 0 && (
        <div
          className="text-xs text-white/50"
          data-testid={`audit-receipt-attempts-empty-${auditId}`}
        >
          No receipt attempts recorded for this charge yet.
        </div>
      )}
      {!isLoading && !error && data && data.attempts.length > 0 && (
        <div className="space-y-2">
          {data.attempts.map((att, idx) => {
            const kindLabel = att.kind === 'partial_payment' ? 'partial payment' : att.kind;
            // Task #338: only the most recent attempt is retryable from the
            // audit panel — older attempts are historical. The convenience
            // endpoint always targets the latest attempt for the charge.
            const isLatest = idx === 0;
            const pushBtn = isLatest ? (
              <Button
                size="sm"
                variant="ghost"
                disabled={
                  retryingChannel === 'push'
                  || att.pushStatus !== 'failed'
                  || !!att.pushRetryExhaustedAt
                  || (att.pushAttempts ?? 0) >= data.maxPushAttempts
                }
                onClick={() => retryChannel('push')}
                className="h-6 px-2 text-[11px] text-amber-300 hover:bg-white/5 gap-1 mt-1 w-fit"
                data-testid={`audit-receipt-attempt-${auditId}-push-retry`}
              >
                <Send className="w-3 h-3" />
                {retryingChannel === 'push' ? 'Retrying…' : 'Retry push'}
              </Button>
            ) : null;
            const smsBtn = isLatest ? (
              <Button
                size="sm"
                variant="ghost"
                disabled={
                  retryingChannel === 'sms'
                  || att.smsStatus !== 'failed'
                  || !!att.smsRetryExhaustedAt
                  || (att.smsAttempts ?? 0) >= data.maxSmsAttempts
                }
                onClick={() => retryChannel('sms')}
                className="h-6 px-2 text-[11px] text-amber-300 hover:bg-white/5 gap-1 mt-1 w-fit"
                data-testid={`audit-receipt-attempt-${auditId}-sms-retry`}
              >
                <Send className="w-3 h-3" />
                {retryingChannel === 'sms' ? 'Retrying…' : 'Retry SMS'}
              </Button>
            ) : null;
            const whatsappBtn = isLatest ? (
              <Button
                size="sm"
                variant="ghost"
                disabled={
                  retryingChannel === 'whatsapp'
                  || att.whatsappStatus !== 'failed'
                  || !!att.whatsappRetryExhaustedAt
                  || (att.whatsappAttempts ?? 0) >= data.maxWhatsappAttempts
                }
                onClick={() => retryChannel('whatsapp')}
                className="h-6 px-2 text-[11px] text-amber-300 hover:bg-white/5 gap-1 mt-1 w-fit"
                data-testid={`audit-receipt-attempt-${auditId}-whatsapp-retry`}
              >
                <Send className="w-3 h-3" />
                {retryingChannel === 'whatsapp' ? 'Retrying…' : 'Retry WhatsApp'}
              </Button>
            ) : null;
            return (
              <div
                key={att.id}
                className="rounded bg-white/5 border border-white/10 p-2"
                data-testid={`audit-receipt-attempt-${auditId}-${att.id}`}
              >
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <span className="text-xs text-white/80 capitalize">{kindLabel} receipt</span>
                  <span className="text-[11px] text-white/50">{new Date(att.createdAt).toLocaleString()}</span>
                </div>
                {att.note && (
                  <div className="text-[11px] text-white/50 mt-0.5 break-words">{att.note}</div>
                )}
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mt-2">
                  {renderChannel('Push', att.pushStatus, att.pushAttempts, data.maxPushAttempts, att.lastPushAt, att.lastPushError, att.pushRetryExhaustedAt, pushBtn)}
                  {renderChannel('SMS', att.smsStatus, att.smsAttempts, data.maxSmsAttempts, att.lastSmsAt, att.lastSmsError, att.smsRetryExhaustedAt, smsBtn)}
                  {renderChannel('WhatsApp', att.whatsappStatus, att.whatsappAttempts, data.maxWhatsappAttempts, att.lastWhatsappAt, att.lastWhatsappError, att.whatsappRetryExhaustedAt, whatsappBtn)}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Loading() { return <div className="p-8 text-white/50">Loading…</div>; }
