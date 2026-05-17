import { useState, useEffect } from 'react';
import { formatDistanceToNow } from 'date-fns';
import { useLocation, useSearch } from 'wouter';
import { useGetMe } from '@workspace/api-client-react';
import { useQuery, useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Shield, AlertCircle, CheckCircle2, XCircle,
  Users, TrendingUp, Download, Plus, RefreshCw, Filter,
  Gavel, UserPlus, Send, Lock, Unlock, ScanLine, Calendar, Bell, MessageSquare,
} from 'lucide-react';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useToast } from '@/hooks/use-toast';

const apiUrl = (path: string) => `/api${path}`;

/* ─── Types ──────────────────────────────────────────────────────── */

interface ESRFlag {
  id: number;
  playerId: number;
  firstName: string;
  lastName: string;
  email: string | null;
  tournamentId: number | null;
  tournamentName: string | null;
  tournamentStartDate: string | null;
  round: number | null;
  scoreDifferential: number;
  previousHandicapIndex: number | null;
  projectedHandicapIndex: number | null;
  adjustedHandicapIndex: number | null;
  status: string;
  notes: string | null;
  reviewerName: string | null;
  flaggedAt: string;
  reviewedAt: string | null;
  postingId: number | null;
  grossScore: number | null;
  adjustedGrossScore: number | null;
  postingCourseRating: number | null;
  postingSlope: number | null;
  postedAt: string | null;
}

interface Adjustment {
  id: number;
  playerId: number;
  firstName: string;
  lastName: string;
  email: string | null;
  previousHandicapIndex: number | null;
  newHandicapIndex: number;
  adjustmentReason: string;
  committeeNotes: string | null;
  adjusterName: string | null;
  tournamentName: string | null;
  adjustedAt: string;
}

interface CommitteeStats {
  pendingESR: number;
  totalAdjustments: number;
  totalPlayers: number;
  withOverride: number;
  avgHcp: number | null;
}

interface PlayerSearchResult {
  id: number;
  firstName: string;
  lastName: string;
  email: string | null;
  handicapIndex: number | null;
  handicapOverride: number | null;
}

type CaseKind = 'anomalous' | 'not_posted' | 'exceptional' | 'annual';
type CaseStatus = 'open' | 'assigned' | 'awaiting_peer' | 'decided' | 'closed';
type CaseDecision = 'no_action' | 'soft_cap' | 'hard_cap' | 'index_adjustment';

interface ReviewCase {
  id: number;
  organizationId: number;
  subjectUserId: number;
  subjectName: string | null;
  subjectEmail: string | null;
  kind: CaseKind;
  status: CaseStatus;
  playerId: number | null;
  flagId: number | null;
  periodLabel: string | null;
  details: string | null;
  assigneeUserId: number | null;
  decision: CaseDecision | null;
  decisionRationale: string | null;
  decisionAt: string | null;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface PeerReview {
  id: number;
  caseId: number;
  reviewerUserId: number | null;
  reviewerName: string | null;
  reviewerEmail: string | null;
  recommendation: 'confirm' | 'dispute' | 'insufficient_info' | null;
  comment: string | null;
  invitedAt: string;
  seenAt: string | null;
  respondedAt: string | null;
  expiresAt: string | null;
}

interface AuditEntry {
  id: number;
  caseId: number;
  actorUserId: number | null;
  actorName: string | null;
  action: string;
  fromStatus: string | null;
  toStatus: string | null;
  payload: unknown;
  createdAt: string;
}

interface CaseDetail extends ReviewCase {
  peerReviews: PeerReview[];
  auditLog: AuditEntry[];
}

interface CaseStats {
  total: number;
  byKind: Record<string, number>;
  byStatus: Record<string, number>;
}

interface OrgMember {
  userId: number;
  displayName: string | null;
  email: string | null;
  role: string;
}

const CASE_KINDS: CaseKind[] = ['anomalous', 'not_posted', 'exceptional', 'annual'];
const CASE_STATUSES: CaseStatus[] = ['open', 'assigned', 'awaiting_peer', 'decided', 'closed'];
const CASE_DECISIONS: CaseDecision[] = ['no_action', 'soft_cap', 'hard_cap', 'index_adjustment'];

const KIND_LABEL: Record<CaseKind, string> = {
  anomalous: 'Anomalous Score',
  not_posted: 'Score Not Posted',
  exceptional: 'Exceptional Score',
  annual: 'Annual Review',
};
const STATUS_LABEL: Record<CaseStatus, string> = {
  open: 'Open',
  assigned: 'Assigned',
  awaiting_peer: 'Awaiting Peer',
  decided: 'Decided',
  closed: 'Closed',
};
const STATUS_COLOR: Record<CaseStatus, 'default' | 'destructive' | 'secondary' | 'outline'> = {
  open: 'destructive',
  assigned: 'default',
  awaiting_peer: 'default',
  decided: 'secondary',
  closed: 'outline',
};
const DECISION_LABEL: Record<CaseDecision, string> = {
  no_action: 'No action',
  soft_cap: 'Soft cap',
  hard_cap: 'Hard cap',
  index_adjustment: 'Index adjustment',
};

/* ─── Helpers ────────────────────────────────────────────────────── */

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; variant: 'default' | 'destructive' | 'secondary' | 'outline' }> = {
    pending: { label: 'Pending', variant: 'default' },
    applied: { label: 'Applied', variant: 'secondary' },
    dismissed: { label: 'Dismissed', variant: 'outline' },
  };
  const cfg = map[status] ?? { label: status, variant: 'outline' };
  return <Badge variant={cfg.variant}>{cfg.label}</Badge>;
}

/* ─── Main Component ─────────────────────────────────────────────── */

interface CommitteeNotification {
  id: number;
  caseId: number;
  organizationId: number;
  orgName: string | null;
  event: string;
  title: string;
  body: string;
  payload: Record<string, unknown> | null;
  createdAt: string;
  readAt: string | null;
  caseStatus: string | null;
  caseKind: string | null;
  deepLink: string;
}

interface NotificationsResponse {
  unreadCount: number;
  items: CommitteeNotification[];
  // Cursor pagination (Task #1685): id of the last item in the page when
  // older items may exist, otherwise null. Older API revisions that don't
  // page may omit this field, in which case we treat the inbox as fully
  // loaded.
  nextCursor?: number | null;
}

// Page size for the committee notifications widget. Matches the API's
// new default (Task #1685) so the dashboard's first render fetches a
// small payload instead of the entire backlog.
const COMMITTEE_NOTIFICATIONS_PAGE_SIZE = 25;

function parseCaseIdFromDeepLink(deepLink: string | null | undefined): number | null {
  if (!deepLink) return null;
  const m = deepLink.match(/[?&]caseId=(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

export default function HandicapCommitteePage() {
  const { data: me } = useGetMe();
  const orgId = me?.organizationId ?? null;
  const qc = useQueryClient();
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const search = useSearch();

  // ── ESR queue state ──────────────────────────────────────────
  const [esrStatus, setEsrStatus] = useState<'pending' | 'applied' | 'dismissed' | 'all'>('pending');
  const [applyDialog, setApplyDialog] = useState<ESRFlag | null>(null);
  const [dismissDialog, setDismissDialog] = useState<ESRFlag | null>(null);
  const [applyStrokes, setApplyStrokes] = useState('');
  const [applyReason, setApplyReason] = useState('');
  const [applyNotes, setApplyNotes] = useState('');
  const [dismissNotes, setDismissNotes] = useState('');

  // ── Adjustments list state ───────────────────────────────────
  const [adjFrom, setAdjFrom] = useState('');
  const [adjTo, setAdjTo] = useState('');

  // ── Manual adjustment state ──────────────────────────────────
  const [manualDialog, setManualDialog] = useState(false);
  const [playerSearch, setPlayerSearch] = useState('');
  const [selectedPlayer, setSelectedPlayer] = useState<PlayerSearchResult | null>(null);
  const [manualStrokes, setManualStrokes] = useState('');
  const [manualReason, setManualReason] = useState('');
  const [manualNotes, setManualNotes] = useState('');

  // ── Manual ESR flag (manual create/unflag) state ─────────────
  const [flagDialog, setFlagDialog] = useState(false);
  const [flagSearch, setFlagSearch] = useState('');
  const [flagPlayer, setFlagPlayer] = useState<PlayerSearchResult | null>(null);
  const [flagDifferential, setFlagDifferential] = useState('');
  const [flagNotes, setFlagNotes] = useState('');

  // ── Review cases state ────────────────────────────────────────
  const [caseStatusFilter, setCaseStatusFilter] = useState<CaseStatus | 'all'>('open');
  const [caseKindFilter, setCaseKindFilter] = useState<CaseKind | 'all'>('all');
  const [openCaseId, setOpenCaseId] = useState<number | null>(null);
  const [decideOpen, setDecideOpen] = useState(false);
  const [decideDecision, setDecideDecision] = useState<CaseDecision | ''>('');
  const [decideRationale, setDecideRationale] = useState('');
  const [decideStrokes, setDecideStrokes] = useState('');
  const [decideCapValue, setDecideCapValue] = useState('');
  const [decideAdjNotes, setDecideAdjNotes] = useState('');
  const [peerInviteOpen, setPeerInviteOpen] = useState(false);
  const [peerInviteUserId, setPeerInviteUserId] = useState<number | null>(null);
  const [peerFilter, setPeerFilter] = useState<'all' | 'opened_unresponded' | 'unopened' | 'responded'>('all');
  const [peerSort, setPeerSort] = useState<'invited' | 'seen' | 'responded'>('invited');
  const [assignOpen, setAssignOpen] = useState(false);
  const [assignUserId, setAssignUserId] = useState<number | null>(null);
  const [annualYear, setAnnualYear] = useState(String(new Date().getFullYear()));

  /* ── Queries ─────────────────────────────────────────────── */

  const statsQ = useQuery<CommitteeStats>({
    queryKey: ['handicap-stats', orgId],
    queryFn: () => fetch(apiUrl(`/organizations/${orgId}/handicap/stats`), { credentials: 'include' }).then(r => r.json()),
    enabled: !!orgId,
  });

  const esrQ = useQuery<ESRFlag[]>({
    queryKey: ['exceptional-scores', orgId, esrStatus],
    queryFn: () => fetch(apiUrl(`/organizations/${orgId}/handicap/exceptional-scores?status=${esrStatus}`), { credentials: 'include' }).then(r => r.json()),
    enabled: !!orgId,
  });

  const adjQ = useQuery<Adjustment[]>({
    queryKey: ['handicap-adjustments', orgId, adjFrom, adjTo],
    queryFn: () => {
      const params = new URLSearchParams();
      if (adjFrom) params.set('from', adjFrom);
      if (adjTo) params.set('to', adjTo);
      return fetch(apiUrl(`/organizations/${orgId}/handicap/adjustments?${params}`), { credentials: 'include' }).then(r => r.json());
    },
    enabled: !!orgId,
  });

  const playerSearchQ = useQuery<PlayerSearchResult[]>({
    queryKey: ['player-search', orgId, playerSearch],
    queryFn: () => fetch(apiUrl(`/organizations/${orgId}/players?search=${encodeURIComponent(playerSearch)}&limit=20`), { credentials: 'include' }).then(r => r.json()),
    enabled: !!orgId && playerSearch.length > 1,
  });

  const flagSearchQ = useQuery<PlayerSearchResult[]>({
    queryKey: ['player-search-flag', orgId, flagSearch],
    queryFn: () => fetch(apiUrl(`/organizations/${orgId}/players?search=${encodeURIComponent(flagSearch)}&limit=20`), { credentials: 'include' }).then(r => r.json()),
    enabled: !!orgId && flagSearch.length > 1,
  });

  /* ── Mutations ───────────────────────────────────────────── */

  const applyESR = useMutation({
    mutationFn: async ({ flagId, adjustmentStrokes, reason, notes }: { flagId: number; adjustmentStrokes: number; reason: string; notes?: string }) => {
      const r = await fetch(apiUrl(`/organizations/${orgId}/handicap/exceptional-scores/${flagId}/apply`), {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ adjustmentStrokes, reason, notes }),
      });
      if (!r.ok) { const e = await r.json(); throw new Error(e.error ?? 'Failed'); }
      return r.json();
    },
    onSuccess: (data) => {
      toast({
        title: 'Adjustment recorded',
        description: `+${data.adjustmentStrokes} strokes applied. Resulting HI: ${data.resultingHandicapIndex?.toFixed(1)}. Update player HI manually.`,
      });
      qc.invalidateQueries({ queryKey: ['exceptional-scores', orgId] });
      qc.invalidateQueries({ queryKey: ['handicap-adjustments', orgId] });
      qc.invalidateQueries({ queryKey: ['handicap-stats', orgId] });
      setApplyDialog(null); setApplyStrokes(''); setApplyReason(''); setApplyNotes('');
    },
    onError: (e: Error) => toast({ title: 'Error', description: e.message, variant: 'destructive' }),
  });

  const dismissESR = useMutation({
    mutationFn: async ({ flagId, notes }: { flagId: number; notes: string }) => {
      const r = await fetch(apiUrl(`/organizations/${orgId}/handicap/exceptional-scores/${flagId}/dismiss`), {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notes }),
      });
      if (!r.ok) { const e = await r.json(); throw new Error(e.error ?? 'Failed'); }
      return r.json();
    },
    onSuccess: () => {
      toast({ title: 'Flag dismissed' });
      qc.invalidateQueries({ queryKey: ['exceptional-scores', orgId] });
      qc.invalidateQueries({ queryKey: ['handicap-stats', orgId] });
      setDismissDialog(null); setDismissNotes('');
    },
    onError: (e: Error) => toast({ title: 'Error', description: e.message, variant: 'destructive' }),
  });

  const createFlag = useMutation({
    mutationFn: async () => {
      if (!flagPlayer) throw new Error('Select a player');
      const diff = parseFloat(flagDifferential);
      if (isNaN(diff)) throw new Error('Enter a valid score differential');
      const r = await fetch(apiUrl(`/organizations/${orgId}/handicap/exceptional-scores`), {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ playerId: flagPlayer.id, scoreDifferential: diff, notes: flagNotes || undefined }),
      });
      if (!r.ok) { const e = await r.json(); throw new Error(e.error ?? 'Failed'); }
      return r.json();
    },
    onSuccess: () => {
      toast({ title: 'Score flagged', description: 'ESR flag created and added to the review queue.' });
      qc.invalidateQueries({ queryKey: ['exceptional-scores', orgId] });
      qc.invalidateQueries({ queryKey: ['handicap-stats', orgId] });
      setFlagDialog(false); setFlagPlayer(null); setFlagSearch(''); setFlagDifferential(''); setFlagNotes('');
    },
    onError: (e: Error) => toast({ title: 'Error', description: e.message, variant: 'destructive' }),
  });

  const unflagESR = useMutation({
    mutationFn: async (flagId: number) => {
      const r = await fetch(apiUrl(`/organizations/${orgId}/handicap/exceptional-scores/${flagId}`), {
        method: 'DELETE', credentials: 'include',
      });
      if (!r.ok) { const e = await r.json(); throw new Error(e.error ?? 'Failed'); }
      return r.json();
    },
    onSuccess: () => {
      toast({ title: 'Flag removed' });
      qc.invalidateQueries({ queryKey: ['exceptional-scores', orgId] });
      qc.invalidateQueries({ queryKey: ['handicap-stats', orgId] });
    },
    onError: (e: Error) => toast({ title: 'Error', description: e.message, variant: 'destructive' }),
  });

  const manualAdjust = useMutation({
    mutationFn: async () => {
      if (!selectedPlayer) throw new Error('Select a player');
      const strokes = parseFloat(manualStrokes);
      if (isNaN(strokes) || strokes <= 0) throw new Error('Enter a positive number of adjustment strokes');
      if (!manualReason.trim()) throw new Error('Reason is required');
      const r = await fetch(apiUrl(`/organizations/${orgId}/handicap/adjustments`), {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ playerId: selectedPlayer.id, adjustmentStrokes: strokes, adjustmentReason: manualReason.trim(), committeeNotes: manualNotes || undefined }),
      });
      if (!r.ok) { const e = await r.json(); throw new Error(e.error ?? 'Failed'); }
      return r.json();
    },
    onSuccess: (data) => {
      toast({
        title: 'Committee adjustment recorded',
        description: `+${data.adjustmentStrokes} strokes. Resulting HI: ${data.resultingHandicapIndex?.toFixed(1)}. Update player HI manually.`,
      });
      qc.invalidateQueries({ queryKey: ['handicap-adjustments', orgId] });
      qc.invalidateQueries({ queryKey: ['handicap-stats', orgId] });
      setManualDialog(false); setSelectedPlayer(null); setPlayerSearch(''); setManualStrokes(''); setManualReason(''); setManualNotes('');
    },
    onError: (e: Error) => toast({ title: 'Error', description: e.message, variant: 'destructive' }),
  });

  /* ── Committee notifications (peer responses) ───────────── */

  // Cursor-paginated peer-response feed (Task #2094). The dashboard
  // previously hard-coded `?limit=100` to keep its existing UX after
  // Task #1685 reduced the API's default page size to 25; for committees
  // that accumulate hundreds of peer responses over a season that turned
  // every dashboard render into a large payload. We now fetch a small
  // first page and let the user load older items in via the API's
  // cursor (`?before=<id>`), the same approach the mobile inbox uses.
  const notificationsQ = useInfiniteQuery<NotificationsResponse>({
    queryKey: ['committee-notifications', me?.id],
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ limit: String(COMMITTEE_NOTIFICATIONS_PAGE_SIZE) });
      if (typeof pageParam === 'number') params.set('before', String(pageParam));
      return fetch(`/api/portal/handicap/notifications?${params.toString()}`, { credentials: 'include' })
        .then(r => r.json());
    },
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: !!me?.id,
    // Only the first page polls — older pages are stable history. React
    // Query refetches the first page on this interval and we discard the
    // subsequent pages, but that's fine because the user's loaded
    // history is rebuilt by re-paging on demand.
    refetchInterval: 60_000,
  });

  const markNotificationRead = useMutation({
    mutationFn: async (id: number) => {
      const r = await fetch(`/api/portal/handicap/notifications/${id}/read`, { method: 'POST', credentials: 'include' });
      if (!r.ok) throw new Error('Failed to mark read');
      return r.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['committee-notifications', me?.id] }),
  });

  // Flatten every loaded page and filter to peer-response events. The API
  // returns mixed events (opened/decided/closed/peer_responded/...) so a
  // single page may contribute zero or more rows to this widget; the
  // "Load older" button below lets the committee fetch the next page on
  // demand instead of front-loading the entire backlog.
  const allLoadedNotifications = (notificationsQ.data?.pages ?? []).flatMap(p => p.items);
  const peerResponseNotifications = allLoadedNotifications.filter(n => n.event === 'peer_responded');
  const unreadPeerResponses = peerResponseNotifications.filter(n => !n.readAt);

  /* ── Read ?caseId=N from URL and open the case dialog ───── */
  useEffect(() => {
    const params = new URLSearchParams(search ?? '');
    const cidStr = params.get('caseId');
    if (!cidStr) return;
    const cid = parseInt(cidStr, 10);
    if (!Number.isFinite(cid)) return;
    setOpenCaseId(prev => (prev === cid ? prev : cid));
  }, [search]);

  function openCaseFromNotification(n: CommitteeNotification) {
    const cid = parseCaseIdFromDeepLink(n.deepLink) ?? n.caseId;
    if (!n.readAt) markNotificationRead.mutate(n.id);
    if (cid) {
      setOpenCaseId(cid);
      const params = new URLSearchParams(search ?? '');
      params.set('caseId', String(cid));
      navigate(`/handicap-committee?${params.toString()}`, { replace: true });
    }
  }

  function clearCaseIdFromUrl() {
    const params = new URLSearchParams(search ?? '');
    if (!params.has('caseId')) return;
    params.delete('caseId');
    const qs = params.toString();
    navigate(qs ? `/handicap-committee?${qs}` : '/handicap-committee', { replace: true });
  }

  /* ── Review-cases queries & mutations ───────────────────── */

  const casesQ = useQuery<ReviewCase[]>({
    queryKey: ['handicap-cases', orgId, caseStatusFilter, caseKindFilter],
    queryFn: () => {
      const p = new URLSearchParams();
      p.set('status', caseStatusFilter);
      p.set('kind', caseKindFilter);
      return fetch(apiUrl(`/organizations/${orgId}/handicap/cases?${p}`), { credentials: 'include' }).then(r => r.json());
    },
    enabled: !!orgId,
  });

  const caseStatsQ = useQuery<CaseStats>({
    queryKey: ['handicap-case-stats', orgId],
    queryFn: () => fetch(apiUrl(`/organizations/${orgId}/handicap/cases/stats`), { credentials: 'include' }).then(r => r.json()),
    enabled: !!orgId,
  });

  const caseDetailQ = useQuery<CaseDetail>({
    queryKey: ['handicap-case', orgId, openCaseId],
    queryFn: () => fetch(apiUrl(`/organizations/${orgId}/handicap/cases/${openCaseId}`), { credentials: 'include' }).then(r => r.json()),
    enabled: !!orgId && !!openCaseId,
  });

  const orgMembersQ = useQuery<OrgMember[]>({
    queryKey: ['org-members', orgId],
    queryFn: () => fetch(apiUrl(`/organizations/${orgId}/members?role=committee_member,org_admin,super_admin`), { credentials: 'include' })
      .then(r => r.ok ? r.json() : []),
    enabled: !!orgId,
  });

  const invalidateCases = () => {
    qc.invalidateQueries({ queryKey: ['handicap-cases', orgId] });
    qc.invalidateQueries({ queryKey: ['handicap-case-stats', orgId] });
    if (openCaseId) qc.invalidateQueries({ queryKey: ['handicap-case', orgId, openCaseId] });
  };

  const scanCases = useMutation({
    mutationFn: async () => {
      const r = await fetch(apiUrl(`/organizations/${orgId}/handicap/cases/scan`), { method: 'POST', credentials: 'include' });
      if (!r.ok) throw new Error((await r.json()).error ?? 'Scan failed');
      return r.json();
    },
    onSuccess: (data) => {
      toast({ title: 'Scan complete', description: `${data.total} new cases (anomalous: ${data.anomalous}, not posted: ${data.notPosted}, ESR: ${data.fromFlags})` });
      invalidateCases();
    },
    onError: (e: Error) => toast({ title: 'Scan failed', description: e.message, variant: 'destructive' }),
  });

  const generateAnnual = useMutation({
    mutationFn: async () => {
      const r = await fetch(apiUrl(`/organizations/${orgId}/handicap/cases/generate-annual`), {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ year: parseInt(annualYear) || new Date().getFullYear() }),
      });
      if (!r.ok) throw new Error((await r.json()).error ?? 'Failed');
      return r.json();
    },
    onSuccess: (data) => {
      toast({ title: 'Annual reviews generated', description: `${data.casesCreated} cases created for ${data.year}` });
      invalidateCases();
    },
    onError: (e: Error) => toast({ title: 'Failed', description: e.message, variant: 'destructive' }),
  });

  const assignCase = useMutation({
    mutationFn: async ({ caseId, assigneeUserId }: { caseId: number; assigneeUserId: number }) => {
      const r = await fetch(apiUrl(`/organizations/${orgId}/handicap/cases/${caseId}/assign`), {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assigneeUserId }),
      });
      if (!r.ok) throw new Error((await r.json()).error ?? 'Failed');
      return r.json();
    },
    onSuccess: () => { toast({ title: 'Case assigned' }); setAssignOpen(false); setAssignUserId(null); invalidateCases(); },
    onError: (e: Error) => toast({ title: 'Failed', description: e.message, variant: 'destructive' }),
  });

  const invitePeer = useMutation({
    mutationFn: async ({ caseId, reviewerUserId }: { caseId: number; reviewerUserId: number }) => {
      const r = await fetch(apiUrl(`/organizations/${orgId}/handicap/cases/${caseId}/peer-invite`), {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reviewerUserId }),
      });
      if (!r.ok) throw new Error((await r.json()).error ?? 'Failed');
      return r.json();
    },
    onSuccess: () => { toast({ title: 'Peer reviewer invited', description: 'Email + push notification sent.' }); setPeerInviteOpen(false); setPeerInviteUserId(null); invalidateCases(); },
    onError: (e: Error) => toast({ title: 'Failed', description: e.message, variant: 'destructive' }),
  });

  const decideCase = useMutation({
    mutationFn: async ({ caseId, decision, rationale, createAdjustment }: {
      caseId: number;
      decision: CaseDecision;
      rationale: string;
      createAdjustment?: { adjustmentStrokes?: number; capValue?: number; notes?: string };
    }) => {
      const r = await fetch(apiUrl(`/organizations/${orgId}/handicap/cases/${caseId}/decide`), {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision, rationale, createAdjustment }),
      });
      if (!r.ok) throw new Error((await r.json()).error ?? 'Failed');
      return r.json();
    },
    onSuccess: () => {
      toast({ title: 'Decision recorded' });
      setDecideOpen(false); setDecideDecision(''); setDecideRationale('');
      setDecideStrokes(''); setDecideCapValue(''); setDecideAdjNotes('');
      invalidateCases();
    },
    onError: (e: Error) => toast({ title: 'Failed', description: e.message, variant: 'destructive' }),
  });

  const closeCase = useMutation({
    mutationFn: async (caseId: number) => {
      const r = await fetch(apiUrl(`/organizations/${orgId}/handicap/cases/${caseId}/close`), { method: 'POST', credentials: 'include' });
      if (!r.ok) throw new Error((await r.json()).error ?? 'Failed');
      return r.json();
    },
    onSuccess: () => { toast({ title: 'Case closed' }); invalidateCases(); },
    onError: (e: Error) => toast({ title: 'Failed', description: e.message, variant: 'destructive' }),
  });

  const reopenCase = useMutation({
    mutationFn: async (caseId: number) => {
      const r = await fetch(apiUrl(`/organizations/${orgId}/handicap/cases/${caseId}/reopen`), { method: 'POST', credentials: 'include' });
      if (!r.ok) throw new Error((await r.json()).error ?? 'Failed');
      return r.json();
    },
    onSuccess: () => { toast({ title: 'Case reopened' }); invalidateCases(); },
    onError: (e: Error) => toast({ title: 'Failed', description: e.message, variant: 'destructive' }),
  });

  /* ── CSV Export ──────────────────────────────────────────── */

  function exportCsv() {
    const params = new URLSearchParams();
    if (adjFrom) params.set('from', adjFrom);
    if (adjTo) params.set('to', adjTo);
    window.open(apiUrl(`/organizations/${orgId}/handicap/adjustments/export.csv?${params}`), '_blank');
  }

  /* ── Derived ─────────────────────────────────────────────── */

  const stats = statsQ.data;
  const flags = esrQ.data ?? [];
  const adjustments = adjQ.data ?? [];

  /* ── Render ──────────────────────────────────────────────── */

  return (
    <div className="p-6 space-y-6 max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Shield className="h-7 w-7 text-[#C9A84C]" />
          <div>
            <h1 className="text-2xl font-bold">Handicap Committee</h1>
            <p className="text-sm text-muted-foreground">ESR queue, audit trail, and committee adjustments</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Button
              variant="outline"
              size="sm"
              onClick={() => navigate('/notifications')}
              data-testid="button-committee-notifications"
              title="View all committee notifications"
            >
              <Bell className="h-4 w-4 mr-2" />
              Notifications
              {unreadPeerResponses.length > 0 && (
                <Badge variant="destructive" className="ml-2 h-5 px-1.5 text-xs" data-testid="badge-committee-unread">
                  {unreadPeerResponses.length}
                </Badge>
              )}
            </Button>
          </div>
          <Button variant="outline" size="sm" onClick={() => {
            qc.invalidateQueries({ queryKey: ['handicap-stats', orgId] });
            qc.invalidateQueries({ queryKey: ['committee-notifications', me?.id] });
          }}>
            <RefreshCw className="h-4 w-4 mr-2" /> Refresh
          </Button>
        </div>
      </div>

      {/* New peer responses panel.
          We render whenever the loaded pages contain at least one
          peer-response item OR the server still has older pages we
          haven't fetched. The API pages mixed events, so a page can
          legitimately come back with zero peer-responded rows while
          still reporting a `nextCursor` — in that case we still need
          to surface the "Load older" button so the committee can page
          through to the older peer responses. */}
      {(peerResponseNotifications.length > 0 || notificationsQ.hasNextPage) && (
        <Card className="border-l-4 border-l-blue-500" data-testid="card-peer-responses">
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <MessageSquare className="h-4 w-4 text-blue-500" />
              New Peer Responses
              {unreadPeerResponses.length > 0 && (
                <Badge variant="destructive" className="ml-1 h-5 px-1.5 text-xs">{unreadPeerResponses.length} unread</Badge>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <div className="space-y-2 max-h-72 overflow-y-auto">
              {peerResponseNotifications.length === 0 && notificationsQ.hasNextPage && (
                <p
                  className="text-xs text-muted-foreground px-1 py-2"
                  data-testid="peer-responses-empty-page"
                >
                  No peer responses on this page. Load older to see earlier responses.
                </p>
              )}
              {peerResponseNotifications.map(n => {
                const isUnread = !n.readAt;
                return (
                  <div
                    key={n.id}
                    className={`flex items-start justify-between gap-3 p-3 rounded border cursor-pointer hover:bg-muted/50 transition-colors ${isUnread ? 'border-blue-500/40 bg-blue-500/5' : 'border-border'}`}
                    onClick={() => openCaseFromNotification(n)}
                    data-testid={`peer-response-${n.id}`}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-medium">{n.title}</span>
                        {isUnread && <span className="w-2 h-2 rounded-full bg-blue-500" aria-label="unread" />}
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5">{n.body}</p>
                      <p className="text-[11px] text-muted-foreground mt-1">
                        {new Date(n.createdAt).toLocaleString()}
                        {n.orgName && ` · ${n.orgName}`}
                        {' · Case #'}{parseCaseIdFromDeepLink(n.deepLink) ?? n.caseId}
                      </p>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      {isUnread && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={(e) => { e.stopPropagation(); markNotificationRead.mutate(n.id); }}
                          data-testid={`button-mark-read-${n.id}`}
                          title="Mark as read"
                        >
                          <CheckCircle2 className="h-4 w-4" />
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={(e) => { e.stopPropagation(); openCaseFromNotification(n); }}
                        data-testid={`button-open-case-${n.id}`}
                      >
                        Open case
                      </Button>
                    </div>
                  </div>
                );
              })}
              {/* Older-page affordance (Task #2094). The API pages mixed
                  notification events; the button is shown whenever the
                  server reports a continuation cursor, even if no new
                  peer-responded items came back in the last page. */}
              {notificationsQ.hasNextPage && (
                <div className="flex justify-center pt-1">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => notificationsQ.fetchNextPage()}
                    disabled={notificationsQ.isFetchingNextPage}
                    data-testid="button-load-older-peer-responses"
                  >
                    {notificationsQ.isFetchingNextPage ? 'Loading…' : 'Load older'}
                  </Button>
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Stats row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-5">
            <div className="flex items-center gap-3">
              <AlertCircle className="h-8 w-8 text-amber-500" />
              <div>
                <p className="text-2xl font-bold">{stats?.pendingESR ?? '—'}</p>
                <p className="text-xs text-muted-foreground">Pending ESR Flags</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-5">
            <div className="flex items-center gap-3">
              <TrendingUp className="h-8 w-8 text-blue-500" />
              <div>
                <p className="text-2xl font-bold">{stats?.totalAdjustments ?? '—'}</p>
                <p className="text-xs text-muted-foreground">Total Adjustments</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-5">
            <div className="flex items-center gap-3">
              <Users className="h-8 w-8 text-green-500" />
              <div>
                <p className="text-2xl font-bold">{stats?.withOverride ?? '—'}</p>
                <p className="text-xs text-muted-foreground">With Override</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-5">
            <div className="flex items-center gap-3">
              <Shield className="h-8 w-8 text-[#C9A84C]" />
              <div>
                <p className="text-2xl font-bold">{stats?.avgHcp?.toFixed(1) ?? '—'}</p>
                <p className="text-xs text-muted-foreground">Avg HCP Index</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Tabs */}
      <Tabs defaultValue="esr">
        <TabsList>
          <TabsTrigger value="esr">
            ESR Queue {(stats?.pendingESR ?? 0) > 0 && <Badge variant="destructive" className="ml-2 h-5 px-1.5 text-xs">{stats!.pendingESR}</Badge>}
          </TabsTrigger>
          <TabsTrigger value="cases">
            Review Cases {(caseStatsQ.data?.byStatus.open ?? 0) > 0 && <Badge variant="destructive" className="ml-2 h-5 px-1.5 text-xs">{caseStatsQ.data!.byStatus.open}</Badge>}
          </TabsTrigger>
          <TabsTrigger value="adjustments">Adjustment History</TabsTrigger>
          <TabsTrigger value="manual">Manual Adjustment</TabsTrigger>
        </TabsList>

        {/* ── ESR Queue ─────────────────────────────────────────── */}
        <TabsContent value="esr" className="space-y-4 mt-4">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-3">
              <Filter className="h-4 w-4 text-muted-foreground" />
              <div className="flex gap-2">
                {(['pending', 'applied', 'dismissed', 'all'] as const).map(s => (
                  <Button key={s} size="sm" variant={esrStatus === s ? 'default' : 'outline'} onClick={() => setEsrStatus(s)}>
                    {s.charAt(0).toUpperCase() + s.slice(1)}
                  </Button>
                ))}
              </div>
            </div>
            <Button size="sm" onClick={() => setFlagDialog(true)}>
              <Plus className="h-4 w-4 mr-2" /> Flag a Score Manually
            </Button>
          </div>

          {esrQ.isLoading && <div className="text-center py-8 text-muted-foreground">Loading…</div>}
          {!esrQ.isLoading && flags.length === 0 && (
            <Card><CardContent className="py-12 text-center text-muted-foreground">
              <CheckCircle2 className="h-10 w-10 mx-auto mb-3 text-green-400" />
              No {esrStatus === 'all' ? '' : esrStatus} exceptional score flags.
            </CardContent></Card>
          )}

          <div className="space-y-3">
            {flags.map(flag => (
              <Card key={flag.id} className="border-l-4 border-l-amber-400">
                <CardContent className="pt-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="space-y-1 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-semibold">{flag.firstName} {flag.lastName}</span>
                        <StatusBadge status={flag.status} />
                        {flag.tournamentName && <Badge variant="outline" className="text-xs">{flag.tournamentName}{flag.round ? ` R${flag.round}` : ''}</Badge>}
                      </div>
                      <div className="text-sm text-muted-foreground grid grid-cols-3 gap-4 pt-1">
                        <span>Differential: <strong className="text-red-500">{flag.scoreDifferential.toFixed(1)}</strong></span>
                        <span>Previous HI: <strong>{flag.previousHandicapIndex?.toFixed(1) ?? '—'}</strong></span>
                        <span>Projected HI: <strong className="text-amber-600">{flag.projectedHandicapIndex?.toFixed(1) ?? '—'}</strong></span>
                      </div>
                      {/* Round score context from WHS posting */}
                      {flag.postingId && (
                        <div className="text-xs text-muted-foreground grid grid-cols-4 gap-3 pt-1 bg-muted/50 rounded px-2 py-1">
                          <span>Gross: <strong>{flag.grossScore ?? '—'}</strong></span>
                          <span>Adj Gross: <strong>{flag.adjustedGrossScore ?? '—'}</strong></span>
                          <span>CR/Slope: <strong>{flag.postingCourseRating != null ? `${flag.postingCourseRating}/${flag.postingSlope}` : '—'}</strong></span>
                          <span>Posted: <strong>{flag.postedAt ? new Date(flag.postedAt).toLocaleDateString() : '—'}</strong></span>
                        </div>
                      )}
                      {flag.adjustedHandicapIndex != null && (
                        <p className="text-xs text-green-600">Committee set to {flag.adjustedHandicapIndex.toFixed(1)}</p>
                      )}
                      {flag.notes && <p className="text-xs italic text-muted-foreground">"{flag.notes}"</p>}
                      <p className="text-xs text-muted-foreground mt-1">
                        Flagged {new Date(flag.flaggedAt).toLocaleDateString()}
                        {flag.reviewedAt && ` · Reviewed ${new Date(flag.reviewedAt).toLocaleDateString()}`}
                        {flag.reviewerName && ` by ${flag.reviewerName}`}
                      </p>
                    </div>
                    {flag.status === 'pending' && (
                      <div className="flex gap-2 shrink-0 flex-wrap">
                        <Button size="sm" onClick={() => { setApplyDialog(flag); setApplyStrokes(''); }}>
                          <CheckCircle2 className="h-3.5 w-3.5 mr-1" /> Apply
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => setDismissDialog(flag)}>
                          <XCircle className="h-3.5 w-3.5 mr-1" /> Dismiss
                        </Button>
                        <Button size="sm" variant="outline" className="text-red-500 hover:text-red-400"
                          onClick={() => { if (confirm('Remove this ESR flag entirely?')) unflagESR.mutate(flag.id); }}>
                          Remove Flag
                        </Button>
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </TabsContent>

        {/* ── Review Cases ──────────────────────────────────────── */}
        <TabsContent value="cases" className="space-y-4 mt-4">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-3 flex-wrap">
              <Filter className="h-4 w-4 text-muted-foreground" />
              <div className="flex gap-1.5 flex-wrap">
                {(['open', 'assigned', 'awaiting_peer', 'decided', 'closed', 'all'] as const).map(s => (
                  <Button key={s} size="sm" variant={caseStatusFilter === s ? 'default' : 'outline'} onClick={() => setCaseStatusFilter(s)}>
                    {s === 'all' ? 'All' : STATUS_LABEL[s as CaseStatus]}
                    {caseStatsQ.data && s !== 'all' && (caseStatsQ.data.byStatus[s] ?? 0) > 0 && (
                      <Badge variant="secondary" className="ml-1.5 h-4 px-1 text-xs">{caseStatsQ.data.byStatus[s]}</Badge>
                    )}
                  </Button>
                ))}
              </div>
              <select
                className="border rounded-md text-sm px-2 py-1 bg-background"
                value={caseKindFilter}
                onChange={e => setCaseKindFilter(e.target.value as CaseKind | 'all')}
              >
                <option value="all">All kinds</option>
                {CASE_KINDS.map(k => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
              </select>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <Button size="sm" variant="outline" disabled={scanCases.isPending} onClick={() => scanCases.mutate()}>
                <ScanLine className="h-3.5 w-3.5 mr-1.5" /> {scanCases.isPending ? 'Scanning…' : 'Run Scan'}
              </Button>
              <div className="flex items-center gap-1">
                <Input className="w-20 h-8" type="number" value={annualYear} onChange={e => setAnnualYear(e.target.value)} />
                <Button size="sm" variant="outline" disabled={generateAnnual.isPending} onClick={() => generateAnnual.mutate()}>
                  <Calendar className="h-3.5 w-3.5 mr-1.5" /> Generate Annual
                </Button>
              </div>
            </div>
          </div>

          {casesQ.isLoading && <div className="text-center py-8 text-muted-foreground">Loading…</div>}
          {!casesQ.isLoading && (casesQ.data?.length ?? 0) === 0 && (
            <Card><CardContent className="py-12 text-center text-muted-foreground">
              <CheckCircle2 className="h-10 w-10 mx-auto mb-3 text-green-400" />
              No cases match these filters.
            </CardContent></Card>
          )}

          <div className="space-y-3">
            {(casesQ.data ?? []).map(c => (
              <Card key={c.id} className="border-l-4 border-l-blue-400 hover:border-l-blue-500 cursor-pointer" onClick={() => setOpenCaseId(c.id)}>
                <CardContent className="pt-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="space-y-1 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-semibold">{c.subjectName ?? `User #${c.subjectUserId}`}</span>
                        <Badge variant={STATUS_COLOR[c.status]}>{STATUS_LABEL[c.status]}</Badge>
                        <Badge variant="outline" className="text-xs">{KIND_LABEL[c.kind]}</Badge>
                        {c.periodLabel && <Badge variant="outline" className="text-xs">{c.periodLabel}</Badge>}
                      </div>
                      {c.details && <p className="text-sm text-muted-foreground line-clamp-2">{c.details}</p>}
                      {c.decision && (
                        <p className="text-xs text-green-600">
                          Decision: <strong>{DECISION_LABEL[c.decision]}</strong>
                          {c.decisionRationale && <span className="text-muted-foreground"> — {c.decisionRationale}</span>}
                        </p>
                      )}
                      <p className="text-xs text-muted-foreground">
                        Opened {new Date(c.createdAt).toLocaleDateString()}
                        {c.assigneeUserId && ` · Assignee #${c.assigneeUserId}`}
                        {c.closedAt && ` · Closed ${new Date(c.closedAt).toLocaleDateString()}`}
                      </p>
                    </div>
                    <Gavel className="h-5 w-5 text-blue-400 shrink-0" />
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </TabsContent>

        {/* ── Adjustment History ─────────────────────────────────── */}
        <TabsContent value="adjustments" className="space-y-4 mt-4">
          <div className="flex items-center gap-3 flex-wrap">
            <div className="flex items-center gap-2">
              <label className="text-sm font-medium">From</label>
              <Input type="date" className="w-40" value={adjFrom} onChange={e => setAdjFrom(e.target.value)} />
            </div>
            <div className="flex items-center gap-2">
              <label className="text-sm font-medium">To</label>
              <Input type="date" className="w-40" value={adjTo} onChange={e => setAdjTo(e.target.value)} />
            </div>
            <Button size="sm" variant="outline" onClick={exportCsv}>
              <Download className="h-3.5 w-3.5 mr-1.5" /> Export CSV
            </Button>
          </div>

          {adjQ.isLoading && <div className="text-center py-8 text-muted-foreground">Loading…</div>}
          {!adjQ.isLoading && adjustments.length === 0 && (
            <Card><CardContent className="py-12 text-center text-muted-foreground">No adjustments found for this period.</CardContent></Card>
          )}

          <div className="space-y-3">
            {adjustments.map(adj => (
              <Card key={adj.id}>
                <CardContent className="pt-4">
                  <div className="flex items-center justify-between gap-4">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{adj.firstName} {adj.lastName}</span>
                        {adj.tournamentName && <Badge variant="outline" className="text-xs">{adj.tournamentName}</Badge>}
                      </div>
                      <div className="text-sm text-muted-foreground">
                        {adj.previousHandicapIndex?.toFixed(1) ?? '—'} → <strong className="text-green-600">{adj.newHandicapIndex.toFixed(1)}</strong>
                        {adj.previousHandicapIndex != null && (
                          <span className="text-blue-500 ml-2">+{(adj.newHandicapIndex - adj.previousHandicapIndex).toFixed(1)}</span>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Reason: <em>{adj.adjustmentReason}</em>
                        {adj.committeeNotes && ` · ${adj.committeeNotes}`}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {new Date(adj.adjustedAt).toLocaleDateString()}
                        {adj.adjusterName && ` by ${adj.adjusterName}`}
                      </p>
                    </div>
                    <TrendingUp className="h-6 w-6 text-blue-400 shrink-0" />
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </TabsContent>

        {/* ── Manual Adjustment ─────────────────────────────────── */}
        <TabsContent value="manual" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Issue Committee Adjustment</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground mb-6">
                Handicap committee adjustments are <strong>upward-only</strong> — they raise a player's index to reflect their playing ability. All adjustments require a mandatory reason and are permanently recorded in the audit trail.
              </p>
              <Button onClick={() => setManualDialog(true)}>
                <Plus className="h-4 w-4 mr-2" /> New Manual Adjustment
              </Button>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* ── Case Detail Dialog ───────────────────────────────────── */}
      <Dialog open={!!openCaseId} onOpenChange={open => { if (!open) { setOpenCaseId(null); setDecideOpen(false); setPeerInviteOpen(false); setAssignOpen(false); clearCaseIdFromUrl(); } }}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Case #{openCaseId} {caseDetailQ.data && <Badge variant={STATUS_COLOR[caseDetailQ.data.status]} className="ml-2">{STATUS_LABEL[caseDetailQ.data.status]}</Badge>}</DialogTitle>
          </DialogHeader>
          {caseDetailQ.isLoading && <div className="py-6 text-center text-muted-foreground">Loading…</div>}
          {caseDetailQ.data && (() => {
            const c = caseDetailQ.data;
            const canAssign = c.status === 'open' || c.status === 'assigned' || c.status === 'awaiting_peer';
            const canPeer = c.status === 'assigned' || c.status === 'awaiting_peer';
            const canDecide = c.status === 'assigned' || c.status === 'awaiting_peer';
            const canClose = c.status === 'decided';
            const canReopen = c.status === 'closed' || c.status === 'decided';
            return (
              <div className="space-y-4 pt-2 text-sm">
                <div className="space-y-1">
                  <p><strong>Subject:</strong> {c.subjectName ?? '—'} {c.subjectEmail && <span className="text-muted-foreground">({c.subjectEmail})</span>}</p>
                  <p><strong>Kind:</strong> {KIND_LABEL[c.kind]}</p>
                  {c.periodLabel && <p><strong>Period:</strong> {c.periodLabel}</p>}
                  {c.details && <div className="p-2 bg-muted rounded text-xs whitespace-pre-wrap">{c.details}</div>}
                </div>

                {c.decision && (
                  <div className="p-3 bg-green-500/10 border border-green-500/30 rounded space-y-1">
                    <p className="font-medium text-green-700">Decision: {DECISION_LABEL[c.decision]}</p>
                    {c.decisionRationale && <p className="text-xs italic">"{c.decisionRationale}"</p>}
                    {c.decisionAt && <p className="text-xs text-muted-foreground">Decided {new Date(c.decisionAt).toLocaleString()}</p>}
                  </div>
                )}

                {/* Action buttons */}
                <div className="flex flex-wrap gap-2">
                  {canAssign && <Button size="sm" variant="outline" onClick={() => setAssignOpen(true)}><UserPlus className="h-3.5 w-3.5 mr-1.5" /> Assign</Button>}
                  {canPeer && <Button size="sm" variant="outline" onClick={() => setPeerInviteOpen(true)}><Send className="h-3.5 w-3.5 mr-1.5" /> Invite Peer Reviewer</Button>}
                  {canDecide && <Button size="sm" onClick={() => setDecideOpen(true)}><Gavel className="h-3.5 w-3.5 mr-1.5" /> Record Decision</Button>}
                  {canClose && <Button size="sm" variant="outline" onClick={() => closeCase.mutate(c.id)}><Lock className="h-3.5 w-3.5 mr-1.5" /> Close</Button>}
                  {canReopen && <Button size="sm" variant="outline" onClick={() => reopenCase.mutate(c.id)}><Unlock className="h-3.5 w-3.5 mr-1.5" /> Reopen</Button>}
                </div>

                {/* Peer reviews */}
                {(() => {
                  const filteredPeers = c.peerReviews.filter(p => {
                    if (peerFilter === 'all') return true;
                    if (peerFilter === 'responded') return !!p.respondedAt;
                    if (peerFilter === 'opened_unresponded') return !!p.seenAt && !p.respondedAt;
                    if (peerFilter === 'unopened') return !p.seenAt && !p.respondedAt;
                    return true;
                  });
                  const sortedPeers = [...filteredPeers].sort((a, b) => {
                    const key = peerSort === 'seen' ? 'seenAt' : peerSort === 'responded' ? 'respondedAt' : 'invitedAt';
                    const av = a[key as 'seenAt' | 'respondedAt' | 'invitedAt'];
                    const bv = b[key as 'seenAt' | 'respondedAt' | 'invitedAt'];
                    if (!av && !bv) return 0;
                    if (!av) return 1;
                    if (!bv) return -1;
                    return new Date(bv).getTime() - new Date(av).getTime();
                  });
                  const openedPeers = c.peerReviews.filter(p => !!p.seenAt);
                  const unopenedPeers = c.peerReviews.filter(p => !p.seenAt);
                  const reviewerLabel = (p: PeerReview) => p.reviewerName ?? p.reviewerEmail ?? `User #${p.reviewerUserId}`;
                  const openedTooltip = c.peerReviews.length === 0
                    ? 'No reviewers invited yet'
                    : [
                        openedPeers.length > 0
                          ? `Opened (${openedPeers.length}):\n${openedPeers.map(p => `  • ${reviewerLabel(p)}`).join('\n')}`
                          : 'Opened: none',
                        unopenedPeers.length > 0
                          ? `Not yet opened (${unopenedPeers.length}):\n${unopenedPeers.map(p => `  • ${reviewerLabel(p)}`).join('\n')}`
                          : 'Not yet opened: none',
                      ].join('\n\n');
                  return (
                    <div>
                      <div className="flex items-center justify-between gap-2 mb-2 flex-wrap">
                        <div className="flex items-center gap-2 flex-wrap">
                          <h4 className="font-medium">Peer Reviews ({c.peerReviews.length})</h4>
                          {c.peerReviews.length > 0 && (
                            <Badge
                              variant={openedPeers.length === c.peerReviews.length ? 'secondary' : 'outline'}
                              data-testid={`peer-opened-summary-${c.id}`}
                              title={openedTooltip}
                            >
                              {openedPeers.length} of {c.peerReviews.length} opened
                            </Badge>
                          )}
                        </div>
                        {c.peerReviews.length > 0 && (
                          <div className="flex items-center gap-2 text-xs">
                            <label className="text-muted-foreground">Filter:</label>
                            <select
                              data-testid="peer-filter"
                              className="border rounded px-1.5 py-0.5 bg-background"
                              value={peerFilter}
                              onChange={e => setPeerFilter(e.target.value as typeof peerFilter)}
                            >
                              <option value="all">All</option>
                              <option value="opened_unresponded">Opened, no response</option>
                              <option value="unopened">Not yet opened</option>
                              <option value="responded">Responded</option>
                            </select>
                            <label className="text-muted-foreground">Sort:</label>
                            <select
                              data-testid="peer-sort"
                              className="border rounded px-1.5 py-0.5 bg-background"
                              value={peerSort}
                              onChange={e => setPeerSort(e.target.value as typeof peerSort)}
                            >
                              <option value="invited">Invited</option>
                              <option value="seen">Seen</option>
                              <option value="responded">Responded</option>
                            </select>
                          </div>
                        )}
                      </div>
                      {c.peerReviews.length === 0 && <p className="text-xs text-muted-foreground">No peer reviewers invited yet.</p>}
                      {c.peerReviews.length > 0 && sortedPeers.length === 0 && (
                        <p className="text-xs text-muted-foreground">No reviewers match this filter.</p>
                      )}
                      <div className="space-y-2">
                        {sortedPeers.map(p => {
                          const seenLabel = p.seenAt
                            ? `Seen ${formatDistanceToNow(new Date(p.seenAt), { addSuffix: true })}`
                            : 'Not yet opened';
                          const seenVariant: 'secondary' | 'outline' = p.seenAt ? 'secondary' : 'outline';
                          return (
                            <div key={p.id} className="p-2 border rounded" data-testid={`peer-review-${p.id}`}>
                              <div className="flex items-center justify-between gap-2 flex-wrap">
                                <span className="text-sm font-medium">{p.reviewerName ?? p.reviewerEmail ?? `User #${p.reviewerUserId}`}</span>
                                <div className="flex items-center gap-1.5">
                                  <Badge variant={seenVariant} data-testid={`peer-seen-${p.id}`} title={p.seenAt ? new Date(p.seenAt).toLocaleString() : 'Reviewer has not opened the invitation yet'}>
                                    {seenLabel}
                                  </Badge>
                                  <Badge variant={p.respondedAt ? 'secondary' : 'outline'}>
                                    {p.respondedAt ? 'responded' : 'pending'}
                                    {p.recommendation ? ` · ${p.recommendation.replace('_', ' ')}` : ''}
                                  </Badge>
                                </div>
                              </div>
                              {p.comment && <p className="text-xs italic mt-1">"{p.comment}"</p>}
                              <p className="text-xs text-muted-foreground mt-1">
                                Invited {new Date(p.invitedAt).toLocaleDateString()}
                                {p.respondedAt && ` · Responded ${new Date(p.respondedAt).toLocaleDateString()}`}
                              </p>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })()}

                {/* Audit log */}
                <div>
                  <h4 className="font-medium mb-2">Audit Log</h4>
                  <div className="space-y-1 max-h-48 overflow-y-auto">
                    {c.auditLog.map(a => (
                      <div key={a.id} className="text-xs flex items-start gap-2 border-b pb-1">
                        <span className="text-muted-foreground shrink-0">{new Date(a.createdAt).toLocaleString()}</span>
                        <span><strong>{a.action}</strong>{a.fromStatus && ` (${a.fromStatus} → ${a.toStatus})`} {a.actorName && `· ${a.actorName}`}</span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Inline assign form */}
                {assignOpen && (
                  <div className="p-3 border rounded space-y-2">
                    <label className="text-xs font-medium">Assign to committee member</label>
                    <select className="w-full border rounded px-2 py-1 text-sm bg-background" value={assignUserId ?? ''} onChange={e => setAssignUserId(e.target.value ? parseInt(e.target.value) : null)}>
                      <option value="">Select…</option>
                      {(orgMembersQ.data ?? []).map(m => <option key={m.userId} value={m.userId}>{m.displayName ?? m.email} ({m.role})</option>)}
                    </select>
                    <div className="flex gap-2">
                      <Button size="sm" disabled={!assignUserId || assignCase.isPending} onClick={() => assignCase.mutate({ caseId: c.id, assigneeUserId: assignUserId! })}>Assign</Button>
                      <Button size="sm" variant="outline" onClick={() => setAssignOpen(false)}>Cancel</Button>
                    </div>
                  </div>
                )}

                {/* Inline peer-invite form */}
                {peerInviteOpen && (
                  <div className="p-3 border rounded space-y-2">
                    <label className="text-xs font-medium">Invite a peer reviewer (committee member)</label>
                    <select className="w-full border rounded px-2 py-1 text-sm bg-background" value={peerInviteUserId ?? ''} onChange={e => setPeerInviteUserId(e.target.value ? parseInt(e.target.value) : null)}>
                      <option value="">Select…</option>
                      {(orgMembersQ.data ?? []).filter(m => m.userId !== c.subjectUserId).map(m => <option key={m.userId} value={m.userId}>{m.displayName ?? m.email} ({m.role})</option>)}
                    </select>
                    <div className="flex gap-2">
                      <Button size="sm" disabled={!peerInviteUserId || invitePeer.isPending} onClick={() => invitePeer.mutate({ caseId: c.id, reviewerUserId: peerInviteUserId! })}>Send Invite</Button>
                      <Button size="sm" variant="outline" onClick={() => setPeerInviteOpen(false)}>Cancel</Button>
                    </div>
                  </div>
                )}

                {/* Inline decide form */}
                {decideOpen && (() => {
                  const isIndexAdj = decideDecision === 'index_adjustment';
                  const isCap = decideDecision === 'soft_cap' || decideDecision === 'hard_cap';
                  const strokesNum = parseFloat(decideStrokes);
                  const capNum = parseFloat(decideCapValue);
                  const strokesValid = isIndexAdj && !isNaN(strokesNum) && strokesNum > 0;
                  const capValid = isCap && !isNaN(capNum) && capNum >= 0 && capNum <= 54;
                  const canSubmit = !!decideDecision && decideRationale.trim().length > 0
                    && !decideCase.isPending
                    && (isIndexAdj ? strokesValid : isCap ? capValid : true);
                  return (
                    <div className="p-3 border rounded space-y-2">
                      <label className="text-xs font-medium">Decision</label>
                      <select className="w-full border rounded px-2 py-1 text-sm bg-background" value={decideDecision} onChange={e => { setDecideDecision(e.target.value as CaseDecision); setDecideStrokes(''); setDecideCapValue(''); }}>
                        <option value="">Select…</option>
                        {CASE_DECISIONS.map(d => <option key={d} value={d}>{DECISION_LABEL[d]}</option>)}
                      </select>
                      <label className="text-xs font-medium">Rationale (required)</label>
                      <Textarea rows={3} value={decideRationale} onChange={e => setDecideRationale(e.target.value)} placeholder="Explain the basis for this decision…" />
                      {isIndexAdj && (
                        <div className="space-y-1 p-2 bg-muted/40 rounded">
                          <label className="text-xs font-medium">Upward Adjustment Strokes <span className="text-red-500">*</span></label>
                          <Input type="number" step="0.1" min="0.1" max="54" value={decideStrokes} onChange={e => setDecideStrokes(e.target.value)} placeholder="e.g. 2.5" />
                          <p className="text-[11px] text-muted-foreground">A handicap adjustment will be created and linked to this case in one step.</p>
                        </div>
                      )}
                      {isCap && (
                        <div className="space-y-1 p-2 bg-muted/40 rounded">
                          <label className="text-xs font-medium">Cap Value (Handicap Index) <span className="text-red-500">*</span></label>
                          <Input type="number" step="0.1" min="0" max="54" value={decideCapValue} onChange={e => setDecideCapValue(e.target.value)} placeholder="e.g. 18.0" />
                          <p className="text-[11px] text-muted-foreground">The player's HI will be set to this cap. A handicap adjustment will be created and linked to this case.</p>
                        </div>
                      )}
                      {(isIndexAdj || isCap) && (
                        <div>
                          <label className="text-xs font-medium">Adjustment Notes (optional)</label>
                          <Input value={decideAdjNotes} onChange={e => setDecideAdjNotes(e.target.value)} placeholder="Additional context for the adjustment record" />
                        </div>
                      )}
                      <div className="flex gap-2">
                        <Button size="sm" disabled={!canSubmit}
                          onClick={() => {
                            const payload: { caseId: number; decision: CaseDecision; rationale: string; createAdjustment?: { adjustmentStrokes?: number; capValue?: number; notes?: string } } = {
                              caseId: c.id,
                              decision: decideDecision as CaseDecision,
                              rationale: decideRationale.trim(),
                            };
                            if (isIndexAdj) {
                              payload.createAdjustment = { adjustmentStrokes: strokesNum, notes: decideAdjNotes || undefined };
                            } else if (isCap) {
                              payload.createAdjustment = { capValue: capNum, notes: decideAdjNotes || undefined };
                            }
                            decideCase.mutate(payload);
                          }}>
                          Record Decision
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => setDecideOpen(false)}>Cancel</Button>
                      </div>
                    </div>
                  );
                })()}
              </div>
            );
          })()}
        </DialogContent>
      </Dialog>

      {/* ── Apply ESR Dialog ─────────────────────────────────────── */}
      <Dialog open={!!applyDialog} onOpenChange={open => { if (!open) { setApplyDialog(null); setApplyStrokes(''); setApplyReason(''); setApplyNotes(''); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Apply Committee Adjustment</DialogTitle>
          </DialogHeader>
          {applyDialog && (
            <div className="space-y-4 pt-2">
              <div className="text-sm p-3 bg-muted rounded-lg space-y-1">
                <p><strong>Player:</strong> {applyDialog.firstName} {applyDialog.lastName}</p>
                <p><strong>Score differential:</strong> {applyDialog.scoreDifferential.toFixed(1)}</p>
                <p><strong>Current HI:</strong> {applyDialog.previousHandicapIndex?.toFixed(1) ?? '—'}</p>
                <p><strong>Projected HI (WHS):</strong> {applyDialog.projectedHandicapIndex?.toFixed(1) ?? '—'}</p>
                {applyStrokes && !isNaN(parseFloat(applyStrokes)) && applyDialog.previousHandicapIndex != null && (
                  <p className="text-amber-600 font-semibold">
                    Resulting HI: {Math.min(54, applyDialog.previousHandicapIndex + parseFloat(applyStrokes)).toFixed(1)}
                  </p>
                )}
              </div>
              <div>
                <label className="text-sm font-medium mb-1.5 block">
                  Upward Adjustment Strokes <span className="text-red-500">*</span>
                </label>
                <Input
                  type="number" step="0.1" min="0.1" max="54"
                  value={applyStrokes} onChange={e => setApplyStrokes(e.target.value)}
                  placeholder="e.g. 2.5 (strokes to add to current HI)"
                />
                <p className="text-xs text-muted-foreground mt-1">Enter positive strokes. Committee adjustments are upward-only. Resulting HI is shown above.</p>
              </div>
              <div>
                <label className="text-sm font-medium mb-1.5 block">Reason <span className="text-red-500">*</span></label>
                <Input value={applyReason} onChange={e => setApplyReason(e.target.value)} placeholder="e.g. Exceptional score review — score significantly below expected level" />
              </div>
              <div>
                <label className="text-sm font-medium mb-1.5 block">Committee Notes (optional)</label>
                <Input value={applyNotes} onChange={e => setApplyNotes(e.target.value)} placeholder="Additional context" />
              </div>
              <p className="text-xs text-amber-600">Note: The adjustment will be recorded for audit. Update the player's handicap index manually.</p>
              <div className="flex gap-3 pt-2">
                <Button
                  className="flex-1"
                  disabled={applyESR.isPending || !applyStrokes || !applyReason}
                  onClick={() => {
                    const strokes = parseFloat(applyStrokes);
                    if (isNaN(strokes) || strokes <= 0) { toast({ title: 'Strokes must be a positive number', variant: 'destructive' }); return; }
                    applyESR.mutate({ flagId: applyDialog.id, adjustmentStrokes: strokes, reason: applyReason, notes: applyNotes || undefined });
                  }}
                >
                  {applyESR.isPending ? 'Applying…' : 'Record Adjustment'}
                </Button>
                <Button variant="outline" onClick={() => setApplyDialog(null)}>Cancel</Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* ── Dismiss ESR Dialog ───────────────────────────────────── */}
      <Dialog open={!!dismissDialog} onOpenChange={open => { if (!open) { setDismissDialog(null); setDismissNotes(''); } }}>
        <DialogContent>
          <DialogHeader><DialogTitle>Dismiss ESR Flag</DialogTitle></DialogHeader>
          {dismissDialog && (
            <div className="space-y-4 pt-2">
              <p className="text-sm text-muted-foreground">
                Dismissing marks this flag as reviewed with no action. You must provide a reason.
              </p>
              <div>
                <label className="text-sm font-medium mb-1.5 block">Reason for dismissal <span className="text-red-500">*</span></label>
                <Input value={dismissNotes} onChange={e => setDismissNotes(e.target.value)} placeholder="e.g. Score verified as legitimate, no adjustment warranted" />
              </div>
              <div className="flex gap-3">
                <Button
                  variant="destructive" className="flex-1"
                  disabled={dismissESR.isPending || !dismissNotes.trim()}
                  onClick={() => dismissESR.mutate({ flagId: dismissDialog.id, notes: dismissNotes })}
                >
                  {dismissESR.isPending ? 'Dismissing…' : 'Dismiss Flag'}
                </Button>
                <Button variant="outline" onClick={() => setDismissDialog(null)}>Cancel</Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* ── Manual Flag Dialog ───────────────────────────────────── */}
      <Dialog open={flagDialog} onOpenChange={open => { if (!open) { setFlagDialog(false); setFlagPlayer(null); setFlagSearch(''); setFlagDifferential(''); setFlagNotes(''); } }}>
        <DialogContent>
          <DialogHeader><DialogTitle>Flag a Score Manually</DialogTitle></DialogHeader>
          <div className="space-y-4 pt-2">
            <p className="text-sm text-muted-foreground">Manually create an Exceptional Score Review flag for a player. The flag will appear in the ESR queue for committee review.</p>
            <div>
              <label className="text-sm font-medium mb-1.5 block">Search Player <span className="text-red-500">*</span></label>
              <Input
                value={flagSearch}
                onChange={e => { setFlagSearch(e.target.value); setFlagPlayer(null); }}
                placeholder="Type player name or email…"
              />
              {flagSearchQ.data && !flagPlayer && flagSearchQ.data.length > 0 && (
                <div className="border rounded-md mt-1 divide-y max-h-48 overflow-y-auto">
                  {flagSearchQ.data.map(p => (
                    <div key={p.id} className="px-3 py-2 hover:bg-muted cursor-pointer text-sm"
                      onClick={() => { setFlagPlayer(p); setFlagSearch(`${p.firstName} ${p.lastName}`); }}>
                      <span className="font-medium">{p.firstName} {p.lastName}</span>
                      <span className="text-muted-foreground ml-2">HI: {(p.handicapOverride ?? p.handicapIndex)?.toFixed(1) ?? '—'}</span>
                    </div>
                  ))}
                </div>
              )}
              {flagPlayer && <p className="text-xs text-green-600 mt-1">Selected: {flagPlayer.firstName} {flagPlayer.lastName}</p>}
            </div>
            <div>
              <label className="text-sm font-medium mb-1.5 block">Score Differential <span className="text-red-500">*</span></label>
              <Input type="number" step="0.1" value={flagDifferential} onChange={e => setFlagDifferential(e.target.value)} placeholder="e.g. 7.8" />
              <p className="text-xs text-muted-foreground mt-1">The handicap differential for this round. ESR is triggered when ≥7 differentials above player's Handicap Index.</p>
            </div>
            <div>
              <label className="text-sm font-medium mb-1.5 block">Notes</label>
              <Input value={flagNotes} onChange={e => setFlagNotes(e.target.value)} placeholder="Reason for manual flag…" />
            </div>
            <div className="flex gap-3 pt-2">
              <Button className="flex-1" disabled={createFlag.isPending || !flagPlayer || !flagDifferential}
                onClick={() => createFlag.mutate()}>
                {createFlag.isPending ? 'Flagging…' : 'Create ESR Flag'}
              </Button>
              <Button variant="outline" onClick={() => setFlagDialog(false)}>Cancel</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Manual Adjustment Dialog ─────────────────────────────── */}
      <Dialog open={manualDialog} onOpenChange={setManualDialog}>
        <DialogContent>
          <DialogHeader><DialogTitle>Manual Committee Adjustment</DialogTitle></DialogHeader>
          <div className="space-y-4 pt-2">
            <div>
              <label className="text-sm font-medium mb-1.5 block">Search Player <span className="text-red-500">*</span></label>
              <Input
                value={playerSearch}
                onChange={e => { setPlayerSearch(e.target.value); setSelectedPlayer(null); }}
                placeholder="Type player name or email…"
              />
              {playerSearchQ.data && !selectedPlayer && playerSearchQ.data.length > 0 && (
                <div className="border rounded-md mt-1 divide-y max-h-48 overflow-y-auto">
                  {playerSearchQ.data.map(p => (
                    <div
                      key={p.id}
                      className="px-3 py-2 hover:bg-muted cursor-pointer text-sm"
                      onClick={() => {
                        setSelectedPlayer(p);
                        setPlayerSearch(`${p.firstName} ${p.lastName}`);
                        setManualStrokes('');
                      }}
                    >
                      <span className="font-medium">{p.firstName} {p.lastName}</span>
                      <span className="text-muted-foreground ml-2">HI: {(p.handicapOverride ?? p.handicapIndex)?.toFixed(1) ?? '—'}</span>
                    </div>
                  ))}
                </div>
              )}
              {selectedPlayer && (
                <p className="text-xs text-green-600 mt-1">
                  Selected: {selectedPlayer.firstName} {selectedPlayer.lastName} (current HI: {(selectedPlayer.handicapOverride ?? selectedPlayer.handicapIndex)?.toFixed(1) ?? '—'})
                </p>
              )}
            </div>
            <div>
              <label className="text-sm font-medium mb-1.5 block">Upward Adjustment Strokes <span className="text-red-500">*</span></label>
              <Input
                type="number" step="0.1" min="0.1" max="54"
                value={manualStrokes} onChange={e => setManualStrokes(e.target.value)}
                placeholder="e.g. 2.5 (strokes to add to current HI)"
              />
              {selectedPlayer && manualStrokes && !isNaN(parseFloat(manualStrokes)) && (() => {
                const cur = selectedPlayer.handicapOverride ?? selectedPlayer.handicapIndex ?? 0;
                const strokes = parseFloat(manualStrokes);
                const result = Math.min(54, cur + strokes);
                return <p className="text-xs text-green-600 mt-1">Resulting HI: {result.toFixed(1)} (current: {cur.toFixed(1)} + {strokes.toFixed(1)} strokes)</p>;
              })()}
              <p className="text-xs text-amber-600 mt-1">Committee adjustments are upward-only. HI update must be applied manually to player record.</p>
            </div>
            <div>
              <label className="text-sm font-medium mb-1.5 block">Reason <span className="text-red-500">*</span></label>
              <Input value={manualReason} onChange={e => setManualReason(e.target.value)} placeholder="e.g. General play does not reflect current index" />
            </div>
            <div>
              <label className="text-sm font-medium mb-1.5 block">Committee Notes (optional)</label>
              <Input value={manualNotes} onChange={e => setManualNotes(e.target.value)} placeholder="Additional context or resolution" />
            </div>
            <div className="flex gap-3">
              <Button
                className="flex-1"
                disabled={manualAdjust.isPending || !selectedPlayer || !manualStrokes || !manualReason.trim()}
                onClick={() => manualAdjust.mutate()}
              >
                {manualAdjust.isPending ? 'Applying…' : 'Record Adjustment'}
              </Button>
              <Button variant="outline" onClick={() => setManualDialog(false)}>Cancel</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
