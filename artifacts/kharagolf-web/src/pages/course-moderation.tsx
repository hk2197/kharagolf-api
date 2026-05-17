import { useMemo, useState } from 'react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { useGetMe } from '@workspace/api-client-react';
import {
  Shield, RefreshCw, CheckCircle2, XCircle, Trash2, AlertTriangle,
  Star, Image as ImageIcon, ExternalLink, Flag, MessageSquare,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Textarea } from '@/components/ui/textarea';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { useToast } from '@/hooks/use-toast';
import { useActiveOrgContext } from '@/context/ActiveOrgContext';

interface PendingReview {
  id: number;
  courseId: number;
  rating: number;
  title: string | null;
  body: string | null;
  reviewerDisplayName: string | null;
  reviewerEmail: string | null;
  displayMode: string | null;
  status: string;
  abuseReportCount: number;
  createdAt: string;
  adminReply: string | null;
  adminReplyAt: string | null;
}

interface PendingPhoto {
  id: number;
  courseId: number;
  objectPath: string;
  thumbnailPath: string | null;
  caption: string | null;
  holeNumber: number | null;
  isHero: boolean;
  mediaType: string | null;
  uploaderName: string | null;
  approved: boolean;
  createdAt: string;
}

interface CourseRow {
  id: number;
  name: string;
}

interface BulkReviewResult {
  updatedCount: number;
  errorCount: number;
  status: 'approved' | 'rejected' | 'hidden';
  updated: Array<{ id: number; courseId: number; status: string }>;
  errors: Array<{ reviewId: number; error: string }>;
}

interface BulkPhotoResult {
  updatedCount: number;
  errorCount: number;
  action: 'approve' | 'reject';
  updated: Array<{ id: number; courseId: number | null }>;
  errors: Array<{ photoId: number; error: string }>;
}

async function j<T = unknown>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? res.statusText);
  if (res.status === 204) return undefined as T;
  return res.json();
}

function formatDate(iso: string): string {
  try { return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }); }
  catch { return iso; }
}

function StarRating({ rating }: { rating: number }) {
  return (
    <span className="inline-flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map((n) => (
        <Star
          key={n}
          className={`w-3.5 h-3.5 ${n <= rating ? 'fill-amber-400 text-amber-400' : 'text-white/20'}`}
        />
      ))}
    </span>
  );
}

export default function CourseModerationPage() {
  const { data: user } = useGetMe();
  const { activeOrgId } = useActiveOrgContext();
  const orgId = activeOrgId ?? user?.organizationId;
  const { toast } = useToast();
  const qc = useQueryClient();

  const [tab, setTab] = useState<'reviews' | 'photos' | 'data'>('reviews');
  const [reviewStatus, setReviewStatus] = useState<'pending' | 'approved'>('pending');
  const [replyDrafts, setReplyDrafts] = useState<Record<number, string>>({});

  const reviewsKey = ['course-moderation-reviews', orgId, reviewStatus];
  const photosKey = ['course-moderation-photos', orgId];

  const { data: reviews, isLoading: reviewsLoading, error: reviewsError, refetch: refetchReviews, isFetching: reviewsFetching } = useQuery<PendingReview[]>({
    queryKey: reviewsKey,
    enabled: !!orgId,
    queryFn: () => j<PendingReview[]>(`/api/organizations/${orgId}/marketing-site/course-reviews?status=${reviewStatus}`),
    refetchInterval: 60 * 1000,
  });

  const { data: photos, isLoading: photosLoading, error: photosError, refetch: refetchPhotos, isFetching: photosFetching } = useQuery<PendingPhoto[]>({
    queryKey: photosKey,
    enabled: !!orgId,
    queryFn: () => j<PendingPhoto[]>(`/api/organizations/${orgId}/marketing-site/course-photos?status=pending`),
    refetchInterval: 60 * 1000,
  });

  // Course name lookup so admins see "Riverbend #3" instead of bare ids.
  const { data: coursesData } = useQuery<{ courses: CourseRow[] } | CourseRow[]>({
    queryKey: ['courses-list', orgId],
    enabled: !!orgId,
    queryFn: () => j(`/api/organizations/${orgId}/courses`),
    staleTime: 5 * 60 * 1000,
  });

  const courseNameMap = useMemo(() => {
    const rows: CourseRow[] = Array.isArray(coursesData)
      ? coursesData
      : (coursesData?.courses ?? []);
    return new Map(rows.map((c) => [c.id, c.name]));
  }, [coursesData]);

  const courseLabel = (id: number) => courseNameMap.get(id) ?? `Course #${id}`;

  const reviewMutation = useMutation({
    mutationFn: async ({ id, status }: { id: number; status: 'approved' | 'rejected' | 'hidden' }) =>
      j(`/api/organizations/${orgId}/marketing-site/course-reviews/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
      }),
    onSuccess: (_d, vars) => {
      toast({ title: `Review ${vars.status}` });
      qc.invalidateQueries({ queryKey: reviewsKey });
      qc.invalidateQueries({ queryKey: ['course-moderation-count', orgId] });
    },
    onError: (err: Error) => toast({ title: 'Action failed', description: err.message, variant: 'destructive' }),
  });

  const replyMutation = useMutation({
    mutationFn: async ({ id, reply }: { id: number; reply: string | null }) =>
      j(`/api/organizations/${orgId}/marketing-site/course-reviews/${id}/reply`, {
        method: 'PUT',
        body: JSON.stringify({ reply }),
      }),
    onSuccess: (_d, vars) => {
      toast({ title: vars.reply ? 'Reply posted' : 'Reply removed' });
      setReplyDrafts((d) => { const n = { ...d }; delete n[vars.id]; return n; });
      qc.invalidateQueries({ queryKey: ['course-moderation-reviews', orgId] });
    },
    onError: (err: Error) => toast({ title: 'Reply failed', description: err.message, variant: 'destructive' }),
  });

  const photoApproveMutation = useMutation({
    mutationFn: async (id: number) =>
      j(`/api/organizations/${orgId}/marketing-site/course-photos/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ approved: true }),
      }),
    onSuccess: () => {
      toast({ title: 'Photo approved' });
      qc.invalidateQueries({ queryKey: photosKey });
      qc.invalidateQueries({ queryKey: ['course-moderation-count', orgId] });
    },
    onError: (err: Error) => toast({ title: 'Approve failed', description: err.message, variant: 'destructive' }),
  });

  const photoDeleteMutation = useMutation({
    mutationFn: async (id: number) =>
      j(`/api/organizations/${orgId}/marketing-site/course-photos/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast({ title: 'Photo deleted' });
      qc.invalidateQueries({ queryKey: photosKey });
      qc.invalidateQueries({ queryKey: ['course-moderation-count', orgId] });
    },
    onError: (err: Error) => toast({ title: 'Delete failed', description: err.message, variant: 'destructive' }),
  });

  // Selection state for bulk actions (Task #629). Keyed by row id and kept
  // independently for reviews vs. photos so switching tabs doesn't leak
  // selection across queues. Stale ids (rows that have since been handled by
  // someone else or filtered out) are simply ignored when the bulk action runs.
  const [selectedReviewIds, setSelectedReviewIds] = useState<Set<number>>(new Set());
  const [selectedPhotoIds, setSelectedPhotoIds] = useState<Set<number>>(new Set());

  const bulkReviewMutation = useMutation({
    mutationFn: async ({ reviewIds, status }: { reviewIds: number[]; status: 'approved' | 'rejected' }) =>
      j<BulkReviewResult>(`/api/organizations/${orgId}/marketing-site/course-reviews/moderate-bulk`, {
        method: 'POST',
        body: JSON.stringify({ reviewIds, status }),
      }),
    onSuccess: (result) => {
      if (result.updatedCount > 0) {
        toast({
          title: `${result.status === 'approved' ? 'Approved' : 'Rejected'} ${result.updatedCount} review${result.updatedCount === 1 ? '' : 's'}`,
          description: result.errorCount > 0
            ? `${result.errorCount} could not be updated — see below.`
            : undefined,
        });
      }
      if (result.errorCount > 0) {
        const preview = result.errors.slice(0, 3).map((e) => `#${e.reviewId}: ${e.error}`).join('\n');
        const more = result.errors.length > 3 ? `\n…and ${result.errors.length - 3} more.` : '';
        toast({
          title: `${result.errorCount} review${result.errorCount === 1 ? '' : 's'} not updated`,
          description: preview + more,
          variant: 'destructive',
        });
      }
      // Drop successfully-handled ids from the selection; keep failed ones so
      // staff can retry or inspect them.
      const handled = new Set(result.updated.map((r) => r.id));
      setSelectedReviewIds((prev) => {
        const next = new Set<number>();
        for (const id of prev) if (!handled.has(id)) next.add(id);
        return next;
      });
      qc.invalidateQueries({ queryKey: reviewsKey });
      qc.invalidateQueries({ queryKey: ['course-moderation-count', orgId] });
    },
    onError: (err: Error) => toast({ title: 'Bulk action failed', description: err.message, variant: 'destructive' }),
  });

  const bulkPhotoMutation = useMutation({
    mutationFn: async ({ photoIds, action }: { photoIds: number[]; action: 'approve' | 'reject' }) =>
      j<BulkPhotoResult>(`/api/organizations/${orgId}/marketing-site/course-photos/moderate-bulk`, {
        method: 'POST',
        body: JSON.stringify({ photoIds, action }),
      }),
    onSuccess: (result) => {
      if (result.updatedCount > 0) {
        toast({
          title: `${result.action === 'approve' ? 'Approved' : 'Deleted'} ${result.updatedCount} photo${result.updatedCount === 1 ? '' : 's'}`,
          description: result.errorCount > 0
            ? `${result.errorCount} could not be updated — see below.`
            : undefined,
        });
      }
      if (result.errorCount > 0) {
        const preview = result.errors.slice(0, 3).map((e) => `#${e.photoId}: ${e.error}`).join('\n');
        const more = result.errors.length > 3 ? `\n…and ${result.errors.length - 3} more.` : '';
        toast({
          title: `${result.errorCount} photo${result.errorCount === 1 ? '' : 's'} not updated`,
          description: preview + more,
          variant: 'destructive',
        });
      }
      const handled = new Set(result.updated.map((p) => p.id));
      setSelectedPhotoIds((prev) => {
        const next = new Set<number>();
        for (const id of prev) if (!handled.has(id)) next.add(id);
        return next;
      });
      qc.invalidateQueries({ queryKey: photosKey });
      qc.invalidateQueries({ queryKey: ['course-moderation-count', orgId] });
    },
    onError: (err: Error) => toast({ title: 'Bulk action failed', description: err.message, variant: 'destructive' }),
  });

  if (!orgId) return <div className="p-8 text-white/70">Loading…</div>;

  const reviewsCount = reviews?.length ?? 0;
  const photosCount = photos?.length ?? 0;

  // Selection helpers — header checkbox toggles only the rows currently
  // visible (after refresh / filter), and its tri-state mirrors how many of
  // those visible rows are selected.
  const visibleReviewIds = (reviews ?? []).map((r) => r.id);
  const selectedVisibleReviewCount = visibleReviewIds.reduce((n, id) => (selectedReviewIds.has(id) ? n + 1 : n), 0);
  const allReviewsSelected = visibleReviewIds.length > 0 && selectedVisibleReviewCount === visibleReviewIds.length;
  const someReviewsSelected = selectedVisibleReviewCount > 0 && !allReviewsSelected;
  const toggleAllReviews = (checked: boolean) => {
    setSelectedReviewIds((prev) => {
      const next = new Set(prev);
      if (checked) for (const id of visibleReviewIds) next.add(id);
      else for (const id of visibleReviewIds) next.delete(id);
      return next;
    });
  };
  const toggleReview = (id: number, checked: boolean) => {
    setSelectedReviewIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id); else next.delete(id);
      return next;
    });
  };
  const runBulkReviews = (status: 'approved' | 'rejected') => {
    const ids = visibleReviewIds.filter((id) => selectedReviewIds.has(id));
    if (ids.length === 0) return;
    bulkReviewMutation.mutate({ reviewIds: ids, status });
  };

  const visiblePhotoIds = (photos ?? []).map((p) => p.id);
  const selectedVisiblePhotoCount = visiblePhotoIds.reduce((n, id) => (selectedPhotoIds.has(id) ? n + 1 : n), 0);
  const allPhotosSelected = visiblePhotoIds.length > 0 && selectedVisiblePhotoCount === visiblePhotoIds.length;
  const somePhotosSelected = selectedVisiblePhotoCount > 0 && !allPhotosSelected;
  const toggleAllPhotos = (checked: boolean) => {
    setSelectedPhotoIds((prev) => {
      const next = new Set(prev);
      if (checked) for (const id of visiblePhotoIds) next.add(id);
      else for (const id of visiblePhotoIds) next.delete(id);
      return next;
    });
  };
  const togglePhoto = (id: number, checked: boolean) => {
    setSelectedPhotoIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id); else next.delete(id);
      return next;
    });
  };
  const runBulkPhotos = (action: 'approve' | 'reject') => {
    const ids = visiblePhotoIds.filter((id) => selectedPhotoIds.has(id));
    if (ids.length === 0) return;
    if (action === 'reject' && !window.confirm(`Delete ${ids.length} photo${ids.length === 1 ? '' : 's'}? This cannot be undone.`)) return;
    bulkPhotoMutation.mutate({ photoIds: ids, action });
  };

  const reviewBulkPending = bulkReviewMutation.isPending;
  const photoBulkPending = bulkPhotoMutation.isPending;

  return (
    <div className="min-h-screen bg-gradient-to-b from-neutral-950 to-black text-white p-6">
      <div className="max-w-7xl mx-auto space-y-6">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-2xl font-light flex items-center gap-3">
              <Shield className="w-6 h-6 text-primary" />
              Course Moderation
              {(reviewsCount + photosCount) > 0 && (
                <Badge className="bg-primary/20 text-primary border-primary/30">
                  {reviewsCount + photosCount}
                </Badge>
              )}
            </h1>
            <p className="text-sm text-white/60 mt-1">
              Review and approve member-submitted course reviews and photos before they appear on your public course pages.
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => { refetchReviews(); refetchPhotos(); }}
            disabled={reviewsFetching || photosFetching}
            data-testid="button-refresh-moderation"
          >
            <RefreshCw className={`w-4 h-4 mr-2 ${(reviewsFetching || photosFetching) ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        </div>

        <Tabs value={tab} onValueChange={(v) => setTab(v as 'reviews' | 'photos' | 'data')}>
          <TabsList className="bg-white/5 border border-white/10">
            <TabsTrigger value="reviews" data-testid="tab-reviews" className="data-[state=active]:bg-primary/20">
              Reviews
              {reviewsCount > 0 && (
                <Badge className="ml-2 bg-primary/20 text-primary border-primary/30">{reviewsCount}</Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="photos" data-testid="tab-photos" className="data-[state=active]:bg-primary/20">
              Photos
              {photosCount > 0 && (
                <Badge className="ml-2 bg-primary/20 text-primary border-primary/30">{photosCount}</Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="data" data-testid="tab-data-corrections" className="data-[state=active]:bg-primary/20">
              Data corrections
            </TabsTrigger>
          </TabsList>

          <TabsContent value="data" className="mt-4">
            <DataCorrectionsTab orgId={orgId} />
          </TabsContent>

          <TabsContent value="reviews" className="mt-4">
            <Card className="bg-white/5 border-white/10">
              <CardHeader className="flex flex-row items-center justify-between gap-3 flex-wrap">
                <div>
                  <CardTitle className="text-base font-normal text-white/80">
                    {reviewsLoading
                      ? 'Loading…'
                      : reviewStatus === 'pending'
                        ? `${reviewsCount} review${reviewsCount === 1 ? '' : 's'} awaiting moderation`
                        : `${reviewsCount} approved review${reviewsCount === 1 ? '' : 's'}`}
                  </CardTitle>
                  <p className="text-xs text-white/50">
                    {reviewStatus === 'pending'
                      ? 'Sorted by abuse report count, then most recent.'
                      : 'Reply publicly to give your club\u2019s side on any review.'}
                  </p>
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  {reviewStatus === 'pending' && selectedVisibleReviewCount > 0 && (
                    <div className="inline-flex items-center gap-2">
                      <Button
                        size="sm"
                        onClick={() => runBulkReviews('approved')}
                        disabled={reviewBulkPending}
                        data-testid="button-approve-selected-reviews"
                        className="bg-primary text-primary-foreground hover:bg-primary/90"
                      >
                        <CheckCircle2 className="w-3.5 h-3.5 mr-1.5" />
                        {reviewBulkPending
                          ? `Working on ${selectedVisibleReviewCount}…`
                          : `Approve selected (${selectedVisibleReviewCount})`}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => runBulkReviews('rejected')}
                        disabled={reviewBulkPending}
                        data-testid="button-reject-selected-reviews"
                        className="border-red-500/40 text-red-300 hover:bg-red-500/10 hover:text-red-200"
                      >
                        <XCircle className="w-3.5 h-3.5 mr-1.5" />
                        {reviewBulkPending
                          ? `Working on ${selectedVisibleReviewCount}…`
                          : `Reject selected (${selectedVisibleReviewCount})`}
                      </Button>
                    </div>
                  )}
                  <div className="inline-flex rounded-md border border-white/10 overflow-hidden text-xs">
                    <button
                      type="button"
                      onClick={() => {
                        setReviewStatus('pending');
                        setSelectedReviewIds(new Set());
                      }}
                      data-testid="filter-reviews-pending"
                      className={`px-3 py-1.5 ${reviewStatus === 'pending' ? 'bg-primary/20 text-primary' : 'text-white/60 hover:bg-white/5'}`}
                    >
                      Pending
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setReviewStatus('approved');
                        setSelectedReviewIds(new Set());
                      }}
                      data-testid="filter-reviews-approved"
                      className={`px-3 py-1.5 border-l border-white/10 ${reviewStatus === 'approved' ? 'bg-primary/20 text-primary' : 'text-white/60 hover:bg-white/5'}`}
                    >
                      Approved
                    </button>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                {reviewsError ? (
                  <div className="text-center py-12 text-red-300" data-testid="reviews-error">
                    <AlertTriangle className="w-10 h-10 mx-auto mb-3 text-red-400/60" />
                    <p>Couldn't load pending reviews.</p>
                    <p className="text-xs text-white/50 mt-1">{(reviewsError as Error).message}</p>
                    <Button size="sm" variant="outline" className="mt-3" onClick={() => refetchReviews()}>Retry</Button>
                  </div>
                ) : !reviewsLoading && reviewsCount === 0 ? (
                  <div className="text-center py-12 text-white/40">
                    <CheckCircle2 className="w-10 h-10 mx-auto mb-3 text-emerald-500/40" />
                    <p>No pending reviews. You're all caught up.</p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    <div className="flex items-center gap-3 px-1 pb-1 border-b border-white/5">
                      <Checkbox
                        checked={allReviewsSelected ? true : (someReviewsSelected ? 'indeterminate' : false)}
                        onCheckedChange={(c) => toggleAllReviews(c === true)}
                        data-testid="checkbox-select-all-reviews"
                        aria-label="Select all visible reviews"
                      />
                      <span className="text-xs text-white/50">
                        {selectedVisibleReviewCount > 0
                          ? `${selectedVisibleReviewCount} selected`
                          : 'Select all'}
                      </span>
                    </div>
                    {(reviews ?? []).map((r) => (
                      <div
                        key={r.id}
                        data-testid={`review-row-${r.id}`}
                        className="rounded-lg border border-white/10 bg-black/30 p-4 space-y-3"
                      >
                        <div className="flex items-start gap-3">
                          <Checkbox
                            checked={selectedReviewIds.has(r.id)}
                            onCheckedChange={(c) => toggleReview(r.id, c === true)}
                            data-testid={`checkbox-review-${r.id}`}
                            aria-label={`Select review ${r.id}`}
                            className="mt-1"
                          />
                          <div className="space-y-1.5 min-w-0 flex-1">
                            <div className="flex items-center gap-2 flex-wrap">
                              <StarRating rating={r.rating} />
                              <span className="text-xs text-white/40">·</span>
                              <span className="text-xs text-white/60">{courseLabel(r.courseId)}</span>
                              {r.abuseReportCount > 0 && (
                                <Badge
                                  className="bg-red-500/20 text-red-300 border-red-500/30"
                                  data-testid={`review-abuse-${r.id}`}
                                >
                                  <Flag className="w-3 h-3 mr-1" />
                                  {r.abuseReportCount} report{r.abuseReportCount === 1 ? '' : 's'}
                                </Badge>
                              )}
                            </div>
                            {r.title && <h3 className="font-semibold text-white truncate">{r.title}</h3>}
                            {r.body && <p className="text-sm text-white/80 whitespace-pre-wrap">{r.body}</p>}
                            <div className="text-xs text-white/40 flex items-center gap-2 flex-wrap">
                              <span>
                                {r.displayMode === 'anonymous'
                                  ? 'Anonymous reviewer'
                                  : (r.reviewerDisplayName?.trim() || 'Unnamed reviewer')}
                              </span>
                              {r.reviewerEmail && (
                                <>
                                  <span>·</span>
                                  <span className="truncate">{r.reviewerEmail}</span>
                                </>
                              )}
                              <span>·</span>
                              <span>{formatDate(r.createdAt)}</span>
                            </div>
                          </div>
                        </div>
                        <div className="flex items-center gap-2 flex-wrap">
                          {r.status !== 'approved' && (
                            <Button
                              size="sm"
                              onClick={() => reviewMutation.mutate({ id: r.id, status: 'approved' })}
                              disabled={reviewMutation.isPending || reviewBulkPending}
                              data-testid={`button-approve-review-${r.id}`}
                              className="bg-primary text-primary-foreground hover:bg-primary/90"
                            >
                              <CheckCircle2 className="w-3.5 h-3.5 mr-1.5" />
                              Approve
                            </Button>
                          )}
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => reviewMutation.mutate({ id: r.id, status: 'rejected' })}
                            disabled={reviewMutation.isPending || reviewBulkPending}
                            data-testid={`button-reject-review-${r.id}`}
                            className="border-red-500/40 text-red-300 hover:bg-red-500/10 hover:text-red-200"
                          >
                            <XCircle className="w-3.5 h-3.5 mr-1.5" />
                            Reject
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => reviewMutation.mutate({ id: r.id, status: 'hidden' })}
                            disabled={reviewMutation.isPending || reviewBulkPending}
                            data-testid={`button-hide-review-${r.id}`}
                            className="text-white/60 hover:text-white"
                          >
                            <AlertTriangle className="w-3.5 h-3.5 mr-1.5" />
                            Hide
                          </Button>
                        </div>

                        {r.status === 'approved' && (() => {
                          const draft = replyDrafts[r.id];
                          const editing = draft !== undefined;
                          const value = editing ? draft : (r.adminReply ?? '');
                          const dirty = editing && (draft.trim() !== (r.adminReply ?? '').trim());
                          return (
                            <div className="border-t border-white/10 pt-3 space-y-2">
                              <div className="flex items-center gap-2 text-xs text-white/60">
                                <MessageSquare className="w-3.5 h-3.5" />
                                <span>Public reply from your club</span>
                                {r.adminReplyAt && !editing && (
                                  <span className="text-white/40">· posted {formatDate(r.adminReplyAt)}</span>
                                )}
                              </div>
                              {!editing && r.adminReply ? (
                                <div className="rounded-md bg-emerald-500/10 border border-emerald-500/20 p-3 text-sm text-white/90 whitespace-pre-wrap" data-testid={`review-reply-${r.id}`}>
                                  {r.adminReply}
                                </div>
                              ) : null}
                              {editing ? (
                                <Textarea
                                  value={value}
                                  onChange={(e) => setReplyDrafts((d) => ({ ...d, [r.id]: e.target.value }))}
                                  placeholder="Write a public reply visible under this review on the course page…"
                                  rows={3}
                                  maxLength={2000}
                                  data-testid={`textarea-reply-${r.id}`}
                                  className="bg-black/40 border-white/10 text-sm"
                                />
                              ) : null}
                              <div className="flex items-center gap-2 flex-wrap">
                                {!editing ? (
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={() => setReplyDrafts((d) => ({ ...d, [r.id]: r.adminReply ?? '' }))}
                                    data-testid={`button-edit-reply-${r.id}`}
                                  >
                                    <MessageSquare className="w-3.5 h-3.5 mr-1.5" />
                                    {r.adminReply ? 'Edit reply' : 'Write a reply'}
                                  </Button>
                                ) : (
                                  <>
                                    <Button
                                      size="sm"
                                      onClick={() => replyMutation.mutate({ id: r.id, reply: draft.trim() })}
                                      disabled={!dirty || draft.trim().length === 0 || replyMutation.isPending}
                                      data-testid={`button-save-reply-${r.id}`}
                                      className="bg-primary text-primary-foreground hover:bg-primary/90"
                                    >
                                      Save reply
                                    </Button>
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      onClick={() => setReplyDrafts((d) => { const n = { ...d }; delete n[r.id]; return n; })}
                                      disabled={replyMutation.isPending}
                                      data-testid={`button-cancel-reply-${r.id}`}
                                      className="text-white/60 hover:text-white"
                                    >
                                      Cancel
                                    </Button>
                                  </>
                                )}
                                {r.adminReply && !editing && (
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    onClick={() => replyMutation.mutate({ id: r.id, reply: null })}
                                    disabled={replyMutation.isPending}
                                    data-testid={`button-remove-reply-${r.id}`}
                                    className="text-red-300 hover:text-red-200 hover:bg-red-500/10"
                                  >
                                    <Trash2 className="w-3.5 h-3.5 mr-1.5" />
                                    Remove reply
                                  </Button>
                                )}
                              </div>
                            </div>
                          );
                        })()}
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="photos" className="mt-4">
            <Card className="bg-white/5 border-white/10">
              <CardHeader className="flex flex-row items-center justify-between gap-3 flex-wrap">
                <CardTitle className="text-base font-normal text-white/80">
                  {photosLoading ? 'Loading…' : `${photosCount} photo${photosCount === 1 ? '' : 's'} awaiting approval`}
                </CardTitle>
                {selectedVisiblePhotoCount > 0 && (
                  <div className="inline-flex items-center gap-2">
                    <Button
                      size="sm"
                      onClick={() => runBulkPhotos('approve')}
                      disabled={photoBulkPending}
                      data-testid="button-approve-selected-photos"
                      className="bg-primary text-primary-foreground hover:bg-primary/90"
                    >
                      <CheckCircle2 className="w-3.5 h-3.5 mr-1.5" />
                      {photoBulkPending
                        ? `Working on ${selectedVisiblePhotoCount}…`
                        : `Approve selected (${selectedVisiblePhotoCount})`}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => runBulkPhotos('reject')}
                      disabled={photoBulkPending}
                      data-testid="button-reject-selected-photos"
                      className="border-red-500/40 text-red-300 hover:bg-red-500/10 hover:text-red-200"
                    >
                      <Trash2 className="w-3.5 h-3.5 mr-1.5" />
                      {photoBulkPending
                        ? `Working on ${selectedVisiblePhotoCount}…`
                        : `Reject selected (${selectedVisiblePhotoCount})`}
                    </Button>
                  </div>
                )}
              </CardHeader>
              <CardContent>
                {photosError ? (
                  <div className="text-center py-12 text-red-300" data-testid="photos-error">
                    <AlertTriangle className="w-10 h-10 mx-auto mb-3 text-red-400/60" />
                    <p>Couldn't load pending photos.</p>
                    <p className="text-xs text-white/50 mt-1">{(photosError as Error).message}</p>
                    <Button size="sm" variant="outline" className="mt-3" onClick={() => refetchPhotos()}>Retry</Button>
                  </div>
                ) : !photosLoading && photosCount === 0 ? (
                  <div className="text-center py-12 text-white/40">
                    <ImageIcon className="w-10 h-10 mx-auto mb-3 text-emerald-500/40" />
                    <p>No pending photos. You're all caught up.</p>
                  </div>
                ) : (
                  <>
                    <div className="flex items-center gap-3 px-1 pb-3 mb-3 border-b border-white/5">
                      <Checkbox
                        checked={allPhotosSelected ? true : (somePhotosSelected ? 'indeterminate' : false)}
                        onCheckedChange={(c) => toggleAllPhotos(c === true)}
                        data-testid="checkbox-select-all-photos"
                        aria-label="Select all visible photos"
                      />
                      <span className="text-xs text-white/50">
                        {selectedVisiblePhotoCount > 0
                          ? `${selectedVisiblePhotoCount} selected`
                          : 'Select all'}
                      </span>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                      {(photos ?? []).map((p) => {
                        const src = `/api/storage${p.thumbnailPath || p.objectPath}`;
                        const fullSrc = `/api/storage${p.objectPath}`;
                        return (
                          <div
                            key={p.id}
                            data-testid={`photo-row-${p.id}`}
                            className="rounded-lg border border-white/10 bg-black/30 overflow-hidden flex flex-col relative"
                          >
                            <div className="absolute top-2 left-2 z-10 bg-black/70 rounded p-1">
                              <Checkbox
                                checked={selectedPhotoIds.has(p.id)}
                                onCheckedChange={(c) => togglePhoto(p.id, c === true)}
                                data-testid={`checkbox-photo-${p.id}`}
                                aria-label={`Select photo ${p.id}`}
                              />
                            </div>
                            <a
                              href={fullSrc}
                              target="_blank"
                              rel="noreferrer"
                              className="block aspect-video bg-black/60 relative group"
                            >
                              {p.mediaType === 'video' ? (
                                <video
                                  src={fullSrc}
                                  className="w-full h-full object-contain"
                                  muted
                                  playsInline
                                  preload="metadata"
                                />
                              ) : (
                                <img
                                  src={src}
                                  alt={p.caption ?? `Pending photo ${p.id}`}
                                  className="w-full h-full object-cover"
                                  loading="lazy"
                                />
                              )}
                              <span className="absolute top-2 right-2 inline-flex items-center gap-1 bg-black/70 text-[10px] text-white/80 px-2 py-0.5 rounded-md opacity-0 group-hover:opacity-100 transition-opacity">
                                Open <ExternalLink className="w-3 h-3" />
                              </span>
                            </a>
                            <div className="p-3 space-y-2 flex-1 flex flex-col">
                              <div className="text-xs text-white/60 flex items-center gap-2 flex-wrap">
                                <span>{courseLabel(p.courseId)}</span>
                                {p.holeNumber != null && (
                                  <Badge className="bg-white/10 text-white/80 border-white/10">
                                    Hole {p.holeNumber}
                                  </Badge>
                                )}
                                {p.isHero && (
                                  <Badge className="bg-amber-500/20 text-amber-300 border-amber-500/30">
                                    Hero
                                  </Badge>
                                )}
                              </div>
                              {p.caption && (
                                <p className="text-sm text-white/80 line-clamp-3">{p.caption}</p>
                              )}
                              <div className="text-[11px] text-white/40">
                                {p.uploaderName?.trim() || 'Unknown uploader'} · {formatDate(p.createdAt)}
                              </div>
                              <div className="flex items-center gap-2 mt-auto pt-2">
                                <Button
                                  size="sm"
                                  onClick={() => photoApproveMutation.mutate(p.id)}
                                  disabled={photoApproveMutation.isPending || photoDeleteMutation.isPending || photoBulkPending}
                                  data-testid={`button-approve-photo-${p.id}`}
                                  className="bg-primary text-primary-foreground hover:bg-primary/90 flex-1"
                                >
                                  <CheckCircle2 className="w-3.5 h-3.5 mr-1.5" />
                                  Approve
                                </Button>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() => {
                                    if (window.confirm('Delete this photo? This cannot be undone.')) {
                                      photoDeleteMutation.mutate(p.id);
                                    }
                                  }}
                                  disabled={photoApproveMutation.isPending || photoDeleteMutation.isPending || photoBulkPending}
                                  data-testid={`button-delete-photo-${p.id}`}
                                  className="border-red-500/40 text-red-300 hover:bg-red-500/10 hover:text-red-200"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </Button>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}

// ─── Course-data corrections moderation ────────────────────────────────
interface DataCorrection {
  id: number;
  courseId: number;
  organizationId: number;
  holeNumber: number | null;
  fieldName: string;
  currentValue: string | null;
  proposedValue: string;
  reason: string | null;
  status: 'open' | 'accepted' | 'rejected';
  reviewNotes: string | null;
  createdAt: string;
  reviewedAt: string | null;
}

function DataCorrectionsTab({ orgId }: { orgId: number | undefined }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [status, setStatus] = useState<'open' | 'accepted' | 'rejected'>('open');
  const [notes, setNotes] = useState<Record<number, string>>({});

  const key = ['course-data-corrections', orgId, status];
  const { data, isLoading, refetch, isFetching, error } = useQuery<{ corrections: DataCorrection[] }>({
    queryKey: key,
    enabled: !!orgId,
    queryFn: () => j(`/api/organizations/${orgId}/course-corrections?status=${status}`),
    refetchInterval: 60 * 1000,
  });

  const resolveMutation = useMutation({
    mutationFn: async ({ id, decision, reviewNotes }: { id: number; decision: 'accepted' | 'rejected'; reviewNotes?: string }) =>
      j(`/api/organizations/${orgId}/course-corrections/${id}/resolve`, {
        method: 'POST',
        body: JSON.stringify({ decision, reviewNotes }),
      }),
    onSuccess: (_d, vars) => {
      toast({ title: `Correction ${vars.decision}` });
      setNotes(n => { const x = { ...n }; delete x[vars.id]; return x; });
      qc.invalidateQueries({ queryKey: key });
    },
    onError: (err: Error) => toast({ title: 'Action failed', description: err.message, variant: 'destructive' }),
  });

  const corrections = data?.corrections ?? [];

  return (
    <Card className="bg-white/5 border-white/10">
      <CardHeader className="flex flex-row items-center justify-between gap-3 flex-wrap">
        <div>
          <CardTitle className="text-base font-normal text-white/80">
            {isLoading ? 'Loading…' : `${corrections.length} ${status} report${corrections.length === 1 ? '' : 's'}`}
          </CardTitle>
          <p className="text-xs text-white/50">Player-submitted course/hole data fixes. Accept to apply, reject to dismiss.</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="inline-flex rounded-md border border-white/10 overflow-hidden text-xs">
            {(['open', 'accepted', 'rejected'] as const).map(s => (
              <button
                key={s}
                type="button"
                onClick={() => setStatus(s)}
                data-testid={`filter-corrections-${s}`}
                className={`px-3 py-1.5 ${status === s ? 'bg-primary/20 text-primary' : 'text-white/60 hover:bg-white/5'} ${s !== 'open' ? 'border-l border-white/10' : ''}`}
              >
                {s.charAt(0).toUpperCase() + s.slice(1)}
              </button>
            ))}
          </div>
          <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching} data-testid="button-refresh-corrections">
            <RefreshCw className={`w-3.5 h-3.5 ${isFetching ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {error ? (
          <div className="text-center py-12 text-red-300">
            <AlertTriangle className="w-10 h-10 mx-auto mb-3 text-red-400/60" />
            <p>Couldn't load corrections.</p>
            <p className="text-xs text-white/50 mt-1">{(error as Error).message}</p>
          </div>
        ) : !isLoading && corrections.length === 0 ? (
          <div className="text-center py-12 text-white/40">
            <CheckCircle2 className="w-10 h-10 mx-auto mb-3 text-emerald-500/40" />
            <p>No {status} corrections.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {corrections.map(c => (
              <div key={c.id} data-testid={`correction-row-${c.id}`} className="rounded-lg border border-white/10 bg-black/30 p-4 space-y-2">
                <div className="flex items-center gap-2 flex-wrap">
                  <Badge variant="outline" className="border-white/20 text-white/70">Course #{c.courseId}</Badge>
                  {c.holeNumber != null && <Badge variant="outline" className="border-white/20 text-white/70">Hole {c.holeNumber}</Badge>}
                  <Badge className="bg-primary/20 text-primary border-primary/30">{c.fieldName}</Badge>
                  <span className="text-xs text-white/40 ml-auto">{formatDate(c.createdAt)}</span>
                </div>
                <p className="text-sm text-white/80">
                  {c.currentValue ? <>Was <strong>{c.currentValue}</strong> · </> : null}
                  Suggested: <strong className="text-emerald-300">{c.proposedValue}</strong>
                </p>
                {c.reason && <p className="text-xs text-white/60">{c.reason}</p>}
                {c.status === 'open' ? (
                  <div className="flex items-center gap-2 pt-1">
                    <Textarea
                      value={notes[c.id] ?? ''}
                      onChange={e => setNotes(n => ({ ...n, [c.id]: e.target.value }))}
                      rows={1}
                      placeholder="Reviewer note (optional)"
                      data-testid={`notes-correction-${c.id}`}
                      className="bg-black/40 border-white/10 text-white text-xs flex-1 min-h-[36px]"
                    />
                    <Button
                      size="sm"
                      onClick={() => resolveMutation.mutate({ id: c.id, decision: 'accepted', reviewNotes: notes[c.id] })}
                      disabled={resolveMutation.isPending}
                      data-testid={`button-accept-correction-${c.id}`}
                      className="bg-primary text-primary-foreground hover:bg-primary/90"
                    >
                      <CheckCircle2 className="w-3.5 h-3.5 mr-1" /> Accept
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => resolveMutation.mutate({ id: c.id, decision: 'rejected', reviewNotes: notes[c.id] })}
                      disabled={resolveMutation.isPending}
                      data-testid={`button-reject-correction-${c.id}`}
                      className="border-red-500/40 text-red-300 hover:bg-red-500/10 hover:text-red-200"
                    >
                      <XCircle className="w-3.5 h-3.5 mr-1" /> Reject
                    </Button>
                  </div>
                ) : (
                  <p className="text-xs text-white/40">
                    {c.status === 'accepted' ? 'Accepted' : 'Rejected'}
                    {c.reviewedAt && ` ${formatDate(c.reviewedAt)}`}
                    {c.reviewNotes && ` — ${c.reviewNotes}`}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
