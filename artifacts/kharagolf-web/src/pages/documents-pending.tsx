import { useEffect, useMemo, useState } from 'react';
import { Link } from 'wouter';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { useGetMe } from '@workspace/api-client-react';
import { FileText, CheckCircle2, ExternalLink, RefreshCw, User, X, XCircle } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';
import { useActiveOrgContext } from '@/context/ActiveOrgContext';
import {
  RejectionDeliveryChips,
  recordDocRejectionDelivery,
  type RejectionNotification,
} from '@/components/RejectionDeliveryChips';

const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');

interface PendingDoc {
  id: number;
  clubMemberId: number;
  documentType: string;
  title: string;
  fileUrl: string;
  mimeType: string | null;
  fileSize: number | null;
  expiresAt: string | null;
  uploadedByUserId: number | null;
  uploadedByDisplayName: string | null;
  uploadedByUsername: string | null;
  uploadedByEmail: string | null;
  createdAt: string;
  memberFirstName: string | null;
  memberLastName: string | null;
  memberNumber: string | null;
}

interface UploaderOption {
  userId: number;
  displayName: string | null;
  username: string | null;
  email: string | null;
}

interface PendingResponse {
  count: number;
  documents: PendingDoc[];
  uploaders: UploaderOption[];
}

async function j<T = unknown>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: 'include', headers: { 'Content-Type': 'application/json' }, ...init });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? res.statusText);
  if (res.status === 204) return undefined as T;
  return res.json();
}

function formatBytes(bytes: number | null): string {
  if (!bytes) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }); }
  catch { return iso; }
}

// Relative "waiting" age for the pending-documents queue. We pick the largest
// sensible unit (minutes/hours/days) so stale items read naturally at a glance.
function formatWaitingAge(iso: string, now: number = Date.now()): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const diffMs = Math.max(0, now - then);
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'}`;
}

// Tiered emphasis so stale items jump out without applying the age filter:
// quiet for fresh items, amber once over a week, red once over two.
function waitingAgeTone(iso: string, now: number = Date.now()): 'fresh' | 'warn' | 'stale' {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 'fresh';
  const days = (now - then) / 86_400_000;
  if (days >= 14) return 'stale';
  if (days >= 7) return 'warn';
  return 'fresh';
}

export default function DocumentsPendingPage() {
  const { data: user } = useGetMe();
  const { activeOrgId } = useActiveOrgContext();
  const orgId = activeOrgId ?? user?.organizationId;
  const { toast } = useToast();
  const qc = useQueryClient();

  // Filter state is synced to the URL query string so refreshes, shares, and
  // browser back/forward all preserve the staff member's view (Task 255 made
  // this explicit; previously filters were only in component state).
  const initialParams = useMemo(() => {
    if (typeof window === 'undefined') return new URLSearchParams();
    return new URLSearchParams(window.location.search);
  }, []);

  const [documentType, setDocumentType] = useState<string>(initialParams.get('documentType') || 'all');
  const [memberSearch, setMemberSearch] = useState<string>(initialParams.get('memberSearch') || '');
  const [uploadedFrom, setUploadedFrom] = useState<string>(initialParams.get('uploadedFrom') || '');
  const [uploadedTo, setUploadedTo] = useState<string>(initialParams.get('uploadedTo') || '');
  // "Waiting longer than" age preset (Task 224) — narrows the queue to docs
  // whose createdAt is older than the chosen threshold. 'any' means no filter.
  const [waitingLongerThan, setWaitingLongerThan] = useState<string>(initialParams.get('waitingLongerThan') || 'any');
  // Uploader filter (Task 255) — narrows the queue to documents uploaded by a
  // single staff/front-desk user. Stored as the user id so it survives display
  // name changes; 'all' means no filter.
  const [uploadedByUserId, setUploadedByUserId] = useState<string>(initialParams.get('uploadedByUserId') || 'all');
  // Sort toggle (Task 246) — defaults to newest-first to match historical
  // behaviour. Sent to the API so paginated queues sort server-side rather
  // than only re-ordering the current page.
  const [sortOrder, setSortOrder] = useState<'newest' | 'oldest'>(
    initialParams.get('sort') === 'oldest' ? 'oldest' : 'newest',
  );

  // Push filter state into the URL whenever it changes so the page is
  // refresh- and share-friendly. Uses replaceState so we don't pollute the
  // back-button history with one entry per keystroke / filter change.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams();
    if (documentType && documentType !== 'all') params.set('documentType', documentType);
    if (memberSearch.trim()) params.set('memberSearch', memberSearch.trim());
    if (uploadedFrom) params.set('uploadedFrom', uploadedFrom);
    if (uploadedTo) params.set('uploadedTo', uploadedTo);
    if (waitingLongerThan && waitingLongerThan !== 'any') params.set('waitingLongerThan', waitingLongerThan);
    if (uploadedByUserId && uploadedByUserId !== 'all') params.set('uploadedByUserId', uploadedByUserId);
    if (sortOrder === 'oldest') params.set('sort', 'oldest');
    const qs = params.toString();
    const nextSearch = qs ? `?${qs}` : '';
    if (window.location.search === nextSearch) return;
    window.history.replaceState(null, '', window.location.pathname + nextSearch + window.location.hash);
  }, [documentType, memberSearch, uploadedFrom, uploadedTo, waitingLongerThan, uploadedByUserId, sortOrder]);

  const queryKey = ['documents-pending', orgId, documentType, memberSearch, uploadedFrom, uploadedTo, waitingLongerThan, uploadedByUserId, sortOrder];
  const { data, isLoading, isError, refetch, isFetching } = useQuery<PendingResponse>({
    queryKey,
    enabled: !!orgId,
    queryFn: () => {
      const params = new URLSearchParams();
      if (documentType && documentType !== 'all') params.set('documentType', documentType);
      if (memberSearch.trim()) params.set('memberSearch', memberSearch.trim());
      if (uploadedFrom) params.set('uploadedFrom', uploadedFrom);
      if (uploadedTo) params.set('uploadedTo', uploadedTo);
      if (waitingLongerThan && waitingLongerThan !== 'any') params.set('waitingLongerThan', waitingLongerThan);
      if (uploadedByUserId && uploadedByUserId !== 'all') params.set('uploadedByUserId', uploadedByUserId);
      if (sortOrder === 'oldest') params.set('sort', 'oldest');
      const qs = params.toString();
      return j<PendingResponse>(`/api/organizations/${orgId}/members-360/documents/pending${qs ? `?${qs}` : ''}`);
    },
    refetchInterval: 30 * 1000,
  });

  const hasFilters =
    documentType !== 'all' ||
    memberSearch.trim() !== '' ||
    uploadedFrom !== '' ||
    uploadedTo !== '' ||
    waitingLongerThan !== 'any' ||
    uploadedByUserId !== 'all';
  const clearFilters = () => {
    setDocumentType('all');
    setMemberSearch('');
    setUploadedFrom('');
    setUploadedTo('');
    setWaitingLongerThan('any');
    setUploadedByUserId('all');
  };

  const verifyMutation = useMutation({
    mutationFn: async (doc: PendingDoc) =>
      j(`/api/organizations/${orgId}/members-360/${doc.clubMemberId}/documents/${doc.id}/verify`, { method: 'PATCH' }),
    onSuccess: () => {
      toast({ title: 'Document verified' });
      qc.invalidateQueries({ queryKey });
      qc.invalidateQueries({ queryKey: ['documents-pending-count', orgId] });
    },
    onError: (err: Error) => toast({ title: 'Verify failed', description: err.message, variant: 'destructive' }),
  });

  // Row selection for bulk verify (Task 225). The set is keyed by document id
  // so it's safe across re-renders when the queue refreshes — any selected ids
  // that are no longer in the visible queue (e.g. because filters changed or
  // someone else handled them) are simply ignored when the bulk action runs.
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());

  const bulkVerifyMutation = useMutation({
    mutationFn: async (documentIds: number[]) =>
      j<{
        verifiedCount: number;
        errorCount: number;
        verified: Array<{ id: number; clubMemberId: number }>;
        errors: Array<{ documentId: number; error: string }>;
      }>(`/api/organizations/${orgId}/members-360/documents/verify-bulk`, {
        method: 'POST',
        body: JSON.stringify({ documentIds }),
      }),
    onSuccess: (result) => {
      // Surface successes and per-row failures separately so staff know which
      // documents still need attention rather than seeing a single opaque toast.
      if (result.verifiedCount > 0) {
        toast({
          title: `Verified ${result.verifiedCount} document${result.verifiedCount === 1 ? '' : 's'}`,
          description: result.errorCount > 0
            ? `${result.errorCount} could not be verified — see below.`
            : undefined,
        });
      }
      if (result.errorCount > 0) {
        const preview = result.errors.slice(0, 3)
          .map((e) => `#${e.documentId}: ${e.error}`)
          .join('\n');
        const more = result.errors.length > 3 ? `\n…and ${result.errors.length - 3} more.` : '';
        toast({
          title: `${result.errorCount} document${result.errorCount === 1 ? '' : 's'} not verified`,
          description: preview + more,
          variant: 'destructive',
        });
      }
      // Drop successfully-verified ids from the selection; keep failed ones
      // selected so staff can retry or inspect them.
      const verifiedSet = new Set(result.verified.map((v) => v.id));
      setSelectedIds((prev) => {
        const next = new Set<number>();
        for (const id of prev) if (!verifiedSet.has(id)) next.add(id);
        return next;
      });
      qc.invalidateQueries({ queryKey });
      qc.invalidateQueries({ queryKey: ['documents-pending-count', orgId] });
    },
    onError: (err: Error) => toast({ title: 'Bulk verify failed', description: err.message, variant: 'destructive' }),
  });

  // Reject flow — opens a dialog asking staff for the reason that will be
  // surfaced to the member in the rejection notification.
  const [rejectTarget, setRejectTarget] = useState<PendingDoc | null>(null);
  const [rejectReason, setRejectReason] = useState('');

  // Bulk-reject flow (Task #264) — same dialog UX as the per-row reject, but
  // applies a single reason to every currently-selected visible row. Per-row
  // failures are surfaced individually so the batch never aborts on a stale
  // row, mirroring the bulk-verify contract.
  const [bulkRejectOpen, setBulkRejectOpen] = useState(false);
  const [bulkRejectReason, setBulkRejectReason] = useState('');

  const bulkRejectMutation = useMutation({
    mutationFn: async ({ documentIds, reason }: { documentIds: number[]; reason: string }) =>
      j<{
        rejectedCount: number;
        errorCount: number;
        rejected: Array<{ id: number; clubMemberId: number; notification?: RejectionNotification }>;
        errors: Array<{ documentId: number; error: string }>;
      }>(`/api/organizations/${orgId}/members-360/documents/reject-bulk`, {
        method: 'POST',
        body: JSON.stringify({ documentIds, reason }),
      }),
    onSuccess: (result) => {
      // Persist each doc's delivery info for the Member 360 callout chip and
      // aggregate per-channel counts so staff can see at-a-glance how many of
      // the bulk rejection notifications actually went out per channel.
      const totals: Record<'in-app' | 'email' | 'push' | 'sms' | 'whatsapp', { sent: number; failed: number; skipped: number }> = {
        'in-app': { sent: 0, failed: 0, skipped: 0 },
        email: { sent: 0, failed: 0, skipped: 0 },
        push: { sent: 0, failed: 0, skipped: 0 },
        sms: { sent: 0, failed: 0, skipped: 0 },
        whatsapp: { sent: 0, failed: 0, skipped: 0 },
      };
      for (const r of result.rejected) {
        if (!r.notification) continue;
        recordDocRejectionDelivery(r.id, r.notification);
        // In-app is "sent" iff the helper persisted a member_messages row.
        if (r.notification.inAppMessageId) totals['in-app'].sent += 1;
        else totals['in-app'].failed += 1;
        for (const key of ['email', 'push', 'sms', 'whatsapp'] as const) {
          const status = r.notification[`${key}Status`];
          const error = r.notification[`${key}Error`];
          const providerNotConfigured = error === 'provider_not_configured';
          if (status === 'sent') totals[key].sent += 1;
          else if (status === 'failed' && !providerNotConfigured) totals[key].failed += 1;
          else totals[key].skipped += 1;
        }
      }
      const channelSummary = (['in-app', 'email', 'push', 'sms', 'whatsapp'] as const)
        .map((k) => `${k}: ${totals[k].sent} sent${totals[k].failed ? `, ${totals[k].failed} failed` : ''}${totals[k].skipped ? `, ${totals[k].skipped} skipped` : ''}`)
        .join(' · ');
      if (result.rejectedCount > 0) {
        toast({
          title: `Rejected ${result.rejectedCount} document${result.rejectedCount === 1 ? '' : 's'}`,
          description: (
            <div className="space-y-1">
              <div>
                {result.errorCount > 0
                  ? `${result.errorCount} could not be rejected — see below.`
                  : 'Notifications were sent to each affected member.'}
              </div>
              <div className="text-xs text-white/70" data-testid="bulk-reject-channel-summary">{channelSummary}</div>
            </div>
          ),
        });
      }
      if (result.errorCount > 0) {
        const preview = result.errors.slice(0, 3)
          .map((e) => `#${e.documentId}: ${e.error}`)
          .join('\n');
        const more = result.errors.length > 3 ? `\n…and ${result.errors.length - 3} more.` : '';
        toast({
          title: `${result.errorCount} document${result.errorCount === 1 ? '' : 's'} not rejected`,
          description: preview + more,
          variant: 'destructive',
        });
      }
      // Drop successfully-rejected ids from selection; keep failed ones so
      // staff can retry or inspect them.
      const rejectedSet = new Set(result.rejected.map((r) => r.id));
      setSelectedIds((prev) => {
        const next = new Set<number>();
        for (const id of prev) if (!rejectedSet.has(id)) next.add(id);
        return next;
      });
      setBulkRejectOpen(false);
      setBulkRejectReason('');
      qc.invalidateQueries({ queryKey });
      qc.invalidateQueries({ queryKey: ['documents-pending-count', orgId] });
    },
    onError: (err: Error) => toast({ title: 'Bulk reject failed', description: err.message, variant: 'destructive' }),
  });

  const submitBulkReject = () => {
    const reason = bulkRejectReason.trim();
    if (!reason) {
      toast({ title: 'Reason required', description: 'Tell the members what needs fixing.', variant: 'destructive' });
      return;
    }
    const ids = (data?.documents ?? []).map((d) => d.id).filter((id) => selectedIds.has(id));
    if (ids.length === 0) return;
    bulkRejectMutation.mutate({ documentIds: ids, reason });
  };

  const rejectMutation = useMutation({
    mutationFn: async ({ doc, reason }: { doc: PendingDoc; reason: string }) =>
      j<{ id: number; notification?: RejectionNotification }>(
        `/api/organizations/${orgId}/members-360/${doc.clubMemberId}/documents/${doc.id}/reject`,
        {
          method: 'PATCH',
          body: JSON.stringify({ reason }),
        },
      ),
    onSuccess: (result, vars) => {
      const docId = result?.id ?? vars.doc.id;
      // Persist per-channel delivery info so the Member 360 callout can show a
      // matching chip when staff navigates to it after rejecting from the queue.
      if (result?.notification) recordDocRejectionDelivery(docId, result.notification);
      toast({
        title: 'Document rejected',
        description: (
          <div className="space-y-1.5">
            <div>The member has been notified with your reason.</div>
            <RejectionDeliveryChips notification={result?.notification ?? null} testIdPrefix={`toast-rej-${docId}`} />
          </div>
        ),
      });
      setRejectTarget(null);
      setRejectReason('');
      qc.invalidateQueries({ queryKey });
      qc.invalidateQueries({ queryKey: ['documents-pending-count', orgId] });
    },
    onError: (err: Error) => toast({ title: 'Reject failed', description: err.message, variant: 'destructive' }),
  });

  const submitReject = () => {
    if (!rejectTarget) return;
    const reason = rejectReason.trim();
    if (!reason) {
      toast({ title: 'Reason required', description: 'Tell the member what needs fixing.', variant: 'destructive' });
      return;
    }
    rejectMutation.mutate({ doc: rejectTarget, reason });
  };

  const docs = data?.documents ?? [];
  const total = data?.count ?? 0;

  // Selection helpers for the bulk-verify checkboxes (Task 225). Header
  // checkbox toggles only the documents currently visible (after filters), and
  // its tri-state mirrors how many of those visible rows are selected.
  const visibleIds = useMemo(() => docs.map((d) => d.id), [docs]);
  const selectedVisibleCount = useMemo(
    () => visibleIds.reduce((n, id) => (selectedIds.has(id) ? n + 1 : n), 0),
    [visibleIds, selectedIds],
  );
  const allVisibleSelected = visibleIds.length > 0 && selectedVisibleCount === visibleIds.length;
  const someVisibleSelected = selectedVisibleCount > 0 && !allVisibleSelected;
  const toggleAllVisible = (checked: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (checked) for (const id of visibleIds) next.add(id);
      else for (const id of visibleIds) next.delete(id);
      return next;
    });
  };
  const toggleOne = (id: number, checked: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id); else next.delete(id);
      return next;
    });
  };
  const runBulkVerify = () => {
    // Only send ids that are still in the visible queue — selections from a
    // previous filter view are stale and would just produce per-row errors.
    const ids = visibleIds.filter((id) => selectedIds.has(id));
    if (ids.length === 0) return;
    bulkVerifyMutation.mutate(ids);
  };

  const documentTypeOptions = useMemo(() => {
    const set = new Set<string>();
    for (const d of docs) if (d.documentType) set.add(d.documentType);
    if (documentType && documentType !== 'all') set.add(documentType);
    return Array.from(set).sort();
  }, [docs, documentType]);

  // Uploader options come from the API (computed against the queue ignoring
  // the uploader filter) so the dropdown remains stable while the user
  // switches between uploaders.
  const uploaderOptions = data?.uploaders ?? [];
  const uploaderLabel = (u: UploaderOption) =>
    u.displayName?.trim() || u.username?.trim() || u.email?.trim() || `User #${u.userId}`;

  if (!orgId) return <div className="p-8 text-white/70">Loading…</div>;

  return (
    <div className="min-h-screen bg-gradient-to-b from-neutral-950 to-black text-white p-6">
      <div className="max-w-7xl mx-auto space-y-6">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-2xl font-light flex items-center gap-3">
              <FileText className="w-6 h-6 text-primary" />
              Documents pending verification
              {total > 0 && (
                <Badge className="bg-primary/20 text-primary border-primary/30">{total}</Badge>
              )}
            </h1>
            <p className="text-sm text-white/60 mt-1">
              All member-uploaded documents awaiting staff review for this club.
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
            <RefreshCw className={`w-4 h-4 mr-2 ${isFetching ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        </div>

        <Card className="bg-white/5 border-white/10">
          <CardHeader className="flex flex-row items-center justify-between gap-3 flex-wrap">
            <CardTitle className="text-base font-normal text-white/80">
              {isLoading ? 'Loading…' : `${total} document${total === 1 ? '' : 's'} waiting for review`}
            </CardTitle>
            {selectedVisibleCount > 0 && (
              <div className="inline-flex items-center gap-2">
                <Button
                  size="sm"
                  onClick={runBulkVerify}
                  disabled={bulkVerifyMutation.isPending || bulkRejectMutation.isPending}
                  data-testid="button-verify-selected"
                  className="bg-primary text-primary-foreground hover:bg-primary/90"
                >
                  <CheckCircle2 className="w-3.5 h-3.5 mr-1.5" />
                  {bulkVerifyMutation.isPending
                    ? `Verifying ${selectedVisibleCount}…`
                    : `Verify selected (${selectedVisibleCount})`}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => { setBulkRejectReason(''); setBulkRejectOpen(true); }}
                  disabled={bulkVerifyMutation.isPending || bulkRejectMutation.isPending}
                  data-testid="button-reject-selected"
                  className="border-red-500/40 text-red-300 hover:bg-red-500/10 hover:text-red-200"
                >
                  <XCircle className="w-3.5 h-3.5 mr-1.5" />
                  {bulkRejectMutation.isPending
                    ? `Rejecting ${selectedVisibleCount}…`
                    : `Reject selected (${selectedVisibleCount})`}
                </Button>
              </div>
            )}
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-7 gap-3 mb-5 pb-5 border-b border-white/10">
              <div className="space-y-1.5">
                <Label htmlFor="filter-type" className="text-xs text-white/60">Document type</Label>
                <Select value={documentType} onValueChange={setDocumentType}>
                  <SelectTrigger id="filter-type" data-testid="filter-document-type" className="bg-white/5 border-white/10 text-white">
                    <SelectValue placeholder="All types" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All types</SelectItem>
                    {documentTypeOptions.map((t) => (
                      <SelectItem key={t} value={t}>{t}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5 lg:col-span-2">
                <Label htmlFor="filter-member" className="text-xs text-white/60">Member</Label>
                <Input
                  id="filter-member"
                  data-testid="filter-member-search"
                  placeholder="Name or member number…"
                  value={memberSearch}
                  onChange={(e) => setMemberSearch(e.target.value)}
                  className="bg-white/5 border-white/10 text-white placeholder:text-white/40"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="filter-from" className="text-xs text-white/60">Uploaded from</Label>
                <Input
                  id="filter-from"
                  data-testid="filter-uploaded-from"
                  type="date"
                  value={uploadedFrom}
                  onChange={(e) => setUploadedFrom(e.target.value)}
                  className="bg-white/5 border-white/10 text-white"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="filter-to" className="text-xs text-white/60">Uploaded to</Label>
                <Input
                  id="filter-to"
                  data-testid="filter-uploaded-to"
                  type="date"
                  value={uploadedTo}
                  onChange={(e) => setUploadedTo(e.target.value)}
                  className="bg-white/5 border-white/10 text-white"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="filter-waiting" className="text-xs text-white/60">Waiting longer than</Label>
                <Select value={waitingLongerThan} onValueChange={setWaitingLongerThan}>
                  <SelectTrigger id="filter-waiting" data-testid="filter-waiting-longer-than" className="bg-white/5 border-white/10 text-white">
                    <SelectValue placeholder="Any age" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="any">Any age</SelectItem>
                    <SelectItem value="24h">24 hours</SelectItem>
                    <SelectItem value="3d">3 days</SelectItem>
                    <SelectItem value="7d">7 days</SelectItem>
                    <SelectItem value="14d">14 days</SelectItem>
                    <SelectItem value="30d">30 days</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="filter-uploader" className="text-xs text-white/60">Uploaded by</Label>
                <Select value={uploadedByUserId} onValueChange={setUploadedByUserId}>
                  <SelectTrigger id="filter-uploader" data-testid="filter-uploaded-by" className="bg-white/5 border-white/10 text-white">
                    <SelectValue placeholder="Anyone" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Anyone</SelectItem>
                    {uploaderOptions.map((u) => (
                      <SelectItem key={u.userId} value={String(u.userId)} data-testid={`uploader-option-${u.userId}`}>
                        {uploaderLabel(u)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="filter-sort" className="text-xs text-white/60">Sort by uploaded</Label>
                <Select value={sortOrder} onValueChange={(v) => setSortOrder(v as 'newest' | 'oldest')}>
                  <SelectTrigger id="filter-sort" data-testid="filter-sort-order" className="bg-white/5 border-white/10 text-white">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="newest">Newest first</SelectItem>
                    <SelectItem value="oldest">Oldest first</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {hasFilters && (
                <div className="sm:col-span-2 lg:col-span-7 flex justify-end">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={clearFilters}
                    data-testid="clear-filters"
                    className="text-white/60 hover:text-white"
                  >
                    <X className="w-3.5 h-3.5 mr-1" />
                    Clear filters
                  </Button>
                </div>
              )}
            </div>
            {isLoading ? (
              <p className="text-white/50 text-sm">Loading pending documents…</p>
            ) : isError ? (
              <p className="text-red-400 text-sm">Failed to load pending documents.</p>
            ) : docs.length === 0 ? (
              <div className="text-center py-12">
                <CheckCircle2 className="w-12 h-12 text-emerald-500 mx-auto mb-3" />
                <p className="text-white/70">All caught up — no documents waiting for review.</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-xs uppercase tracking-wider text-white/50 border-b border-white/10">
                    <tr>
                      <th className="py-2 pr-3 w-8">
                        <Checkbox
                          checked={allVisibleSelected ? true : someVisibleSelected ? 'indeterminate' : false}
                          onCheckedChange={(v) => toggleAllVisible(v === true)}
                          aria-label="Select all visible documents"
                          data-testid="checkbox-select-all"
                          className="border-white/40 data-[state=checked]:bg-primary data-[state=checked]:border-primary"
                        />
                      </th>
                      <th className="py-2 pr-3">Member</th>
                      <th className="py-2 pr-3">Type</th>
                      <th className="py-2 pr-3">Title</th>
                      <th className="py-2 pr-3">Uploaded</th>
                      <th className="py-2 pr-3">Waiting</th>
                      <th className="py-2 pr-3">Expires</th>
                      <th className="py-2 pr-3">Size</th>
                      <th className="py-2 pr-3">File</th>
                      <th className="py-2 pr-3 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {docs.map((d) => {
                      const memberName = `${d.memberFirstName ?? ''} ${d.memberLastName ?? ''}`.trim() || 'Member';
                      const isSelected = selectedIds.has(d.id);
                      return (
                        <tr key={d.id} className={`border-b border-white/5 hover:bg-white/5 ${isSelected ? 'bg-primary/5' : ''}`}>
                          <td className="py-3 pr-3">
                            <Checkbox
                              checked={isSelected}
                              onCheckedChange={(v) => toggleOne(d.id, v === true)}
                              aria-label={`Select document ${d.title}`}
                              data-testid={`checkbox-select-${d.id}`}
                              className="border-white/40 data-[state=checked]:bg-primary data-[state=checked]:border-primary"
                            />
                          </td>
                          <td className="py-3 pr-3">
                            <Link href={`${BASE}/member-360/${d.clubMemberId}`} className="flex items-center gap-2 text-white hover:text-primary">
                              <User className="w-3.5 h-3.5 text-white/40" />
                              <div>
                                <div className="font-medium">{memberName}</div>
                                {d.memberNumber && <div className="text-xs text-white/50">#{d.memberNumber}</div>}
                              </div>
                            </Link>
                          </td>
                          <td className="py-3 pr-3">
                            <Badge variant="outline" className="text-white/80 border-white/20">{d.documentType}</Badge>
                          </td>
                          <td className="py-3 pr-3 text-white/80">{d.title}</td>
                          <td className="py-3 pr-3 text-white/70">
                            <div>{formatDate(d.createdAt)}</div>
                            {d.uploadedByUserId && (
                              <div className="text-xs text-white/50" data-testid={`uploaded-by-${d.id}`}>
                                by {d.uploadedByDisplayName?.trim() || d.uploadedByUsername?.trim() || `User #${d.uploadedByUserId}`}
                              </div>
                            )}
                          </td>
                          <td className="py-3 pr-3">
                            {(() => {
                              const tone = waitingAgeTone(d.createdAt);
                              const label = formatWaitingAge(d.createdAt);
                              const cls =
                                tone === 'stale'
                                  ? 'border-red-500/40 bg-red-500/10 text-red-300'
                                  : tone === 'warn'
                                  ? 'border-amber-500/40 bg-amber-500/10 text-amber-300'
                                  : 'border-white/15 bg-white/5 text-white/70';
                              return (
                                <Badge
                                  variant="outline"
                                  className={cls}
                                  data-testid={`waiting-age-${d.id}`}
                                  data-tone={tone}
                                  title={`Uploaded ${formatDate(d.createdAt)}`}
                                >
                                  {label}
                                </Badge>
                              );
                            })()}
                          </td>
                          <td className="py-3 pr-3 text-white/70">{formatDate(d.expiresAt)}</td>
                          <td className="py-3 pr-3 text-white/60">{formatBytes(d.fileSize)}</td>
                          <td className="py-3 pr-3">
                            <a href={d.fileUrl} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline inline-flex items-center gap-1">
                              Open <ExternalLink className="w-3 h-3" />
                            </a>
                          </td>
                          <td className="py-3 pr-3 text-right">
                            <div className="inline-flex items-center gap-2">
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => verifyMutation.mutate(d)}
                                disabled={verifyMutation.isPending}
                                data-testid={`button-verify-${d.id}`}
                              >
                                <CheckCircle2 className="w-3.5 h-3.5 mr-1" />
                                Verify
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                className="border-red-500/40 text-red-300 hover:bg-red-500/10 hover:text-red-200"
                                onClick={() => { setRejectTarget(d); setRejectReason(''); }}
                                disabled={rejectMutation.isPending}
                                data-testid={`button-reject-${d.id}`}
                              >
                                <XCircle className="w-3.5 h-3.5 mr-1" />
                                Reject
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
          </CardContent>
        </Card>
      </div>

      <Dialog
        open={rejectTarget !== null}
        onOpenChange={(open) => {
          if (!open && !rejectMutation.isPending) {
            setRejectTarget(null);
            setRejectReason('');
          }
        }}
      >
        <DialogContent className="bg-neutral-900 border-white/10 text-white">
          <DialogHeader>
            <DialogTitle>Reject document</DialogTitle>
            <DialogDescription className="text-white/60">
              {rejectTarget ? (
                <>
                  Send <span className="text-white/80">{rejectTarget.title}</span> back to the member with a reason.
                  They will be notified via their preferred channel.
                </>
              ) : null}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <label className="text-xs uppercase tracking-wider text-white/50">
              Reason (shown to the member)
            </label>
            <Textarea
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              placeholder="e.g. The photo is blurry — please re-upload a clearer scan."
              maxLength={1000}
              rows={4}
              className="bg-white/5 border-white/10"
              data-testid="textarea-reject-reason"
            />
            <div className="text-xs text-white/40 text-right">{rejectReason.length}/1000</div>
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => { setRejectTarget(null); setRejectReason(''); }}
              disabled={rejectMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={submitReject}
              disabled={rejectMutation.isPending || rejectReason.trim().length === 0}
              data-testid="button-confirm-reject"
            >
              {rejectMutation.isPending ? 'Rejecting…' : 'Reject document'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={bulkRejectOpen}
        onOpenChange={(open) => {
          if (!open && !bulkRejectMutation.isPending) {
            setBulkRejectOpen(false);
            setBulkRejectReason('');
          }
        }}
      >
        <DialogContent className="bg-neutral-900 border-white/10 text-white">
          <DialogHeader>
            <DialogTitle>Reject selected documents</DialogTitle>
            <DialogDescription className="text-white/60">
              Send {selectedVisibleCount} document{selectedVisibleCount === 1 ? '' : 's'} back to
              {' '}{selectedVisibleCount === 1 ? 'the member' : 'their members'} with the same reason.
              Each affected member will be notified via their preferred channel.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <label className="text-xs uppercase tracking-wider text-white/50">
              Reason (shown to every selected member)
            </label>
            <Textarea
              value={bulkRejectReason}
              onChange={(e) => setBulkRejectReason(e.target.value)}
              placeholder="e.g. The photos are blurry — please re-upload clearer scans."
              maxLength={1000}
              rows={4}
              className="bg-white/5 border-white/10"
              data-testid="textarea-bulk-reject-reason"
            />
            <div className="text-xs text-white/40 text-right">{bulkRejectReason.length}/1000</div>
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => { setBulkRejectOpen(false); setBulkRejectReason(''); }}
              disabled={bulkRejectMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={submitBulkReject}
              disabled={bulkRejectMutation.isPending || bulkRejectReason.trim().length === 0 || selectedVisibleCount === 0}
              data-testid="button-confirm-bulk-reject"
            >
              {bulkRejectMutation.isPending
                ? `Rejecting ${selectedVisibleCount}…`
                : `Reject ${selectedVisibleCount} document${selectedVisibleCount === 1 ? '' : 's'}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
