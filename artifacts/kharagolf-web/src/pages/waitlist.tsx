import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useGetMe } from '@workspace/api-client-react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Users, Clock, CheckCircle2, XCircle, AlertCircle, Search,
  ChevronRight, MessageSquare, ArrowRight, Trash2, FileText,
  BarChart2, Timer, Filter, ExternalLink, Plus, CalendarDays,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useToast } from '@/hooks/use-toast';

const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');

interface Application {
  id: number;
  referenceCode: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string | null;
  stage: string;
  stageUpdatedAt: string;
  submittedAt: string;
  tierId: number | null;
  tierName: string | null;
  currentHandicap: string | null;
  previousClub: string | null;
  createdMemberId: number | null;
  adminNotes: string | null;
  rejectionReason: string | null;
}

interface ApplicationDetail extends Application {
  dateOfBirth: string | null;
  address: string | null;
  golfBackground: string | null;
  yearsPlaying: number | null;
  proposerName: string | null;
  proposerMemberNumber: string | null;
  seconderName: string | null;
  seconderMemberNumber: string | null;
  tierCurrency: string | null;
  tierAnnualFee: string | null;
  attachments: { name: string; url: string; uploadedAt: string }[];
  notes: {
    id: number;
    body: string;
    isInternal: boolean;
    createdAt: string;
    authorUsername: string | null;
    authorDisplayName: string | null;
  }[];
}

interface Stats {
  stageCounts: Record<string, number>;
  avgWaitDays: number;
}

const STAGES: { key: string; label: string; color: string; bgColor: string; icon: React.ElementType }[] = [
  { key: 'applied', label: 'Applied', color: 'text-blue-400', bgColor: 'bg-blue-500/10 border-blue-500/20', icon: FileText },
  { key: 'under_review', label: 'Under Review', color: 'text-yellow-400', bgColor: 'bg-yellow-500/10 border-yellow-500/20', icon: AlertCircle },
  { key: 'pending_committee', label: 'Pending Committee', color: 'text-purple-400', bgColor: 'bg-purple-500/10 border-purple-500/20', icon: Users },
  { key: 'approved', label: 'Approved', color: 'text-green-400', bgColor: 'bg-green-500/10 border-green-500/20', icon: CheckCircle2 },
  { key: 'rejected', label: 'Rejected', color: 'text-red-400', bgColor: 'bg-red-500/10 border-red-500/20', icon: XCircle },
];

const NEXT_STAGES: Record<string, string[]> = {
  applied: ['under_review', 'approved', 'rejected'],
  under_review: ['pending_committee', 'approved', 'rejected'],
  pending_committee: ['approved', 'rejected'],
  approved: [],
  rejected: [],
};

const currencySymbol: Record<string, string> = { INR: '₹', USD: '$', GBP: '£', EUR: '€' };

function daysSince(date: string) {
  return Math.floor((Date.now() - new Date(date).getTime()) / 86400000);
}

export default function WaitlistPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: user } = useGetMe();
  const orgId = user?.organizationId;

  const [search, setSearch] = useState('');
  const [stageFilter, setStageFilter] = useState('all');
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [noteBody, setNoteBody] = useState('');
  const [adminNotes, setAdminNotes] = useState('');
  const [rejectReason, setRejectReason] = useState('');
  const [confirmStage, setConfirmStage] = useState<{ appId: number; stage: string } | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<number | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['waitlist', orgId, stageFilter, search],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (stageFilter !== 'all') params.set('stage', stageFilter);
      if (search) params.set('search', search);
      const res = await fetch(`${BASE}/api/organizations/${orgId}/waitlist?${params}`);
      if (!res.ok) throw new Error('Failed to load waitlist');
      return res.json() as Promise<{ applications: Application[]; stats: Stats }>;
    },
    enabled: Boolean(orgId),
  });

  const { data: detail } = useQuery({
    queryKey: ['waitlist-detail', selectedId],
    queryFn: async () => {
      const res = await fetch(`${BASE}/api/organizations/${orgId}/waitlist/${selectedId}`);
      if (!res.ok) throw new Error('Failed to load application');
      return res.json() as Promise<ApplicationDetail>;
    },
    enabled: Boolean(selectedId && orgId),
  });

  const stageMutation = useMutation({
    mutationFn: async ({ appId, stage, rejectionReason }: { appId: number; stage: string; rejectionReason?: string }) => {
      const res = await fetch(`${BASE}/api/organizations/${orgId}/waitlist/${appId}/stage`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stage, rejectionReason }),
      });
      if (!res.ok) throw new Error('Failed to update stage');
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['waitlist', orgId] });
      queryClient.invalidateQueries({ queryKey: ['waitlist-detail', selectedId] });
      setConfirmStage(null);
      setRejectReason('');
      toast({ title: 'Stage updated', description: 'Application status has been updated.' });
    },
    onError: (e: Error) => toast({ title: 'Error', description: e.message, variant: 'destructive' }),
  });

  const noteMutation = useMutation({
    mutationFn: async (body: string) => {
      const res = await fetch(`${BASE}/api/organizations/${orgId}/waitlist/${selectedId}/notes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body, isInternal: true }),
      });
      if (!res.ok) throw new Error('Failed to add note');
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['waitlist-detail', selectedId] });
      setNoteBody('');
      toast({ title: 'Note added' });
    },
    onError: (e: Error) => toast({ title: 'Error', description: e.message, variant: 'destructive' }),
  });

  const updateNotesMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`${BASE}/api/organizations/${orgId}/waitlist/${selectedId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ adminNotes }),
      });
      if (!res.ok) throw new Error('Failed to save notes');
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['waitlist', orgId] });
      queryClient.invalidateQueries({ queryKey: ['waitlist-detail', selectedId] });
      toast({ title: 'Notes saved' });
    },
    onError: (e: Error) => toast({ title: 'Error', description: e.message, variant: 'destructive' }),
  });

  const deleteMutation = useMutation({
    mutationFn: async (appId: number) => {
      const res = await fetch(`${BASE}/api/organizations/${orgId}/waitlist/${appId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete application');
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['waitlist', orgId] });
      setDeleteConfirm(null);
      if (selectedId === deleteConfirm) setSelectedId(null);
      toast({ title: 'Application deleted' });
    },
    onError: (e: Error) => toast({ title: 'Error', description: e.message, variant: 'destructive' }),
  });

  const apps = data?.applications ?? [];
  const stats = data?.stats;

  const stageInfo = (key: string) => STAGES.find(s => s.key === key) ?? STAGES[0];

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Member Waitlist</h1>
          <p className="text-gray-400 text-sm mt-1">Application pipeline & membership approvals</p>
        </div>
        <Button
          variant="outline"
          className="border-white/10 text-gray-300 hover:bg-white/5 gap-2"
          onClick={() => {
            const slug = (user as any)?.orgSlug;
            if (slug) window.open(`/${slug}/apply`, '_blank');
            else toast({ title: 'No org slug found', description: 'Check organization settings.', variant: 'destructive' });
          }}
        >
          <ExternalLink className="w-4 h-4" />
          Public Application Form
        </Button>
      </div>

      {/* Stats Row */}
      <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
        {STAGES.map(s => {
          const cnt = stats?.stageCounts?.[s.key] ?? 0;
          const Icon = s.icon;
          return (
            <Card key={s.key}
              className={`border cursor-pointer transition-all ${stageFilter === s.key ? s.bgColor : 'bg-white/5 border-white/10 hover:bg-white/8'}`}
              onClick={() => setStageFilter(prev => prev === s.key ? 'all' : s.key)}
            >
              <CardContent className="p-4">
                <div className="flex items-center gap-2 mb-1">
                  <Icon className={`w-4 h-4 ${s.color}`} />
                  <span className={`text-2xl font-bold ${s.color}`}>{cnt}</span>
                </div>
                <p className="text-gray-500 text-xs">{s.label}</p>
              </CardContent>
            </Card>
          );
        })}
        <Card className="bg-white/5 border-white/10 col-span-2 md:col-span-1">
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-1">
              <Timer className="w-4 h-4 text-gray-400" />
              <span className="text-2xl font-bold text-white">{stats?.avgWaitDays ?? 0}d</span>
            </div>
            <p className="text-gray-500 text-xs">Avg. Wait</p>
          </CardContent>
        </Card>
      </div>

      {/* Filters */}
      <div className="flex gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
          <Input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search by name, email, or reference…"
            className="pl-9 bg-white/5 border-white/10 text-white placeholder:text-gray-600" />
        </div>
        {stageFilter !== 'all' && (
          <Button variant="outline" size="sm" onClick={() => setStageFilter('all')}
            className="border-white/10 text-gray-400 hover:bg-white/5">
            Clear filter
          </Button>
        )}
      </div>

      {/* Applications List */}
      <div className="grid grid-cols-1 gap-3">
        {isLoading && (
          <div className="text-center py-16 text-gray-500">Loading applications…</div>
        )}
        {!isLoading && apps.length === 0 && (
          <div className="text-center py-16">
            <Users className="w-12 h-12 text-gray-700 mx-auto mb-3" />
            <p className="text-gray-500">No applications found</p>
            <p className="text-gray-600 text-sm mt-1">Share the public application form link to get started.</p>
          </div>
        )}
        {apps.map(app => {
          const s = stageInfo(app.stage);
          const Icon = s.icon;
          const days = daysSince(app.submittedAt);
          return (
            <motion.div
              key={app.id}
              layout
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className={`bg-white/5 border border-white/10 rounded-xl p-4 hover:bg-white/8 cursor-pointer transition-all
                ${selectedId === app.id ? 'ring-1 ring-green-500/50' : ''}`}
              onClick={() => {
                setSelectedId(app.id);
                setAdminNotes(app.adminNotes ?? '');
              }}
            >
              <div className="flex items-center gap-4">
                <div className="w-10 h-10 rounded-full bg-gradient-to-br from-green-700 to-green-900 flex items-center justify-center flex-shrink-0">
                  <span className="text-white text-sm font-bold">
                    {app.firstName[0]}{app.lastName[0]}
                  </span>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-white font-medium">{app.firstName} {app.lastName}</span>
                    <Badge variant="outline" className={`text-xs border ${s.bgColor} ${s.color} border-current/30`}>
                      <Icon className="w-3 h-3 mr-1" />{s.label}
                    </Badge>
                    {app.tierName && (
                      <Badge variant="outline" className="text-xs border-white/10 text-gray-400">{app.tierName}</Badge>
                    )}
                  </div>
                  <p className="text-gray-500 text-sm truncate">{app.email}</p>
                </div>
                <div className="text-right flex-shrink-0">
                  <p className="text-gray-400 text-xs font-mono">{app.referenceCode}</p>
                  <p className="text-gray-600 text-xs mt-0.5">
                    <CalendarDays className="w-3 h-3 inline mr-1" />
                    {days === 0 ? 'Today' : `${days}d ago`}
                  </p>
                </div>
              </div>
            </motion.div>
          );
        })}
      </div>

      {/* Application Detail Dialog */}
      <Dialog open={Boolean(selectedId)} onOpenChange={open => { if (!open) setSelectedId(null); }}>
        <DialogContent className="bg-[#0f0f1a] border-white/10 text-white max-w-2xl max-h-[90vh] overflow-y-auto">
          {detail && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-3">
                  <span>{detail.firstName} {detail.lastName}</span>
                  <span className="font-mono text-sm text-gray-400">{detail.referenceCode}</span>
                  {(() => {
                    const s = stageInfo(detail.stage);
                    const Icon = s.icon;
                    return (
                      <Badge className={`${s.bgColor} ${s.color} border border-current/20`}>
                        <Icon className="w-3 h-3 mr-1" />{s.label}
                      </Badge>
                    );
                  })()}
                </DialogTitle>
              </DialogHeader>

              <Tabs defaultValue="details" className="mt-2">
                <TabsList className="bg-white/5 border border-white/10">
                  <TabsTrigger value="details" className="text-gray-400 data-[state=active]:text-white data-[state=active]:bg-white/10">Details</TabsTrigger>
                  <TabsTrigger value="pipeline" className="text-gray-400 data-[state=active]:text-white data-[state=active]:bg-white/10">Pipeline</TabsTrigger>
                  <TabsTrigger value="notes" className="text-gray-400 data-[state=active]:text-white data-[state=active]:bg-white/10">
                    Notes {detail.notes.length > 0 && <span className="ml-1 text-xs bg-white/10 px-1.5 rounded-full">{detail.notes.length}</span>}
                  </TabsTrigger>
                </TabsList>

                {/* Details Tab */}
                <TabsContent value="details" className="mt-4 space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <p className="text-xs text-gray-500 uppercase tracking-widest mb-2">Contact</p>
                      <div className="space-y-1 text-sm">
                        <p><span className="text-gray-500">Email:</span> <span className="text-white ml-2">{detail.email}</span></p>
                        {detail.phone && <p><span className="text-gray-500">Phone:</span> <span className="text-white ml-2">{detail.phone}</span></p>}
                        {detail.dateOfBirth && <p><span className="text-gray-500">DOB:</span> <span className="text-white ml-2">{new Date(detail.dateOfBirth).toLocaleDateString()}</span></p>}
                        {detail.address && <p><span className="text-gray-500">Address:</span> <span className="text-white ml-2">{detail.address}</span></p>}
                      </div>
                    </div>
                    <div>
                      <p className="text-xs text-gray-500 uppercase tracking-widest mb-2">Golf Background</p>
                      <div className="space-y-1 text-sm">
                        {detail.currentHandicap && <p><span className="text-gray-500">HCP:</span> <span className="text-white ml-2">{detail.currentHandicap}</span></p>}
                        {detail.yearsPlaying && <p><span className="text-gray-500">Years:</span> <span className="text-white ml-2">{detail.yearsPlaying}</span></p>}
                        {detail.previousClub && <p><span className="text-gray-500">Club:</span> <span className="text-white ml-2">{detail.previousClub}</span></p>}
                        {detail.tierName && (
                          <p><span className="text-gray-500">Category:</span> <span className="text-white ml-2">{detail.tierName}
                            {detail.tierAnnualFee && detail.tierCurrency && (
                              <span className="text-gray-400 text-xs ml-1">({currencySymbol[detail.tierCurrency]}{Number(detail.tierAnnualFee).toLocaleString()}/yr)</span>
                            )}
                          </span></p>
                        )}
                      </div>
                    </div>
                  </div>

                  {detail.golfBackground && (
                    <div>
                      <p className="text-xs text-gray-500 uppercase tracking-widest mb-2">Background Statement</p>
                      <p className="text-gray-300 text-sm bg-white/5 rounded-lg p-3 leading-relaxed">{detail.golfBackground}</p>
                    </div>
                  )}

                  {(detail.proposerName || detail.seconderName) && (
                    <div>
                      <p className="text-xs text-gray-500 uppercase tracking-widest mb-2">Proposer & Seconder</p>
                      <div className="grid grid-cols-2 gap-3 text-sm">
                        {detail.proposerName && (
                          <div className="bg-white/5 rounded-lg p-3">
                            <p className="text-gray-500 text-xs mb-1">Proposer</p>
                            <p className="text-white font-medium">{detail.proposerName}</p>
                            {detail.proposerMemberNumber && <p className="text-gray-400 text-xs">{detail.proposerMemberNumber}</p>}
                          </div>
                        )}
                        {detail.seconderName && (
                          <div className="bg-white/5 rounded-lg p-3">
                            <p className="text-gray-500 text-xs mb-1">Seconder</p>
                            <p className="text-white font-medium">{detail.seconderName}</p>
                            {detail.seconderMemberNumber && <p className="text-gray-400 text-xs">{detail.seconderMemberNumber}</p>}
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {detail.createdMemberId && (
                    <div className="bg-green-500/10 border border-green-500/20 rounded-lg p-3 flex items-center gap-2">
                      <CheckCircle2 className="w-4 h-4 text-green-400" />
                      <span className="text-green-300 text-sm">Member account created (ID: {detail.createdMemberId})</span>
                    </div>
                  )}

                  <div>
                    <Label className="text-gray-400 text-xs uppercase tracking-widest">Admin Notes</Label>
                    <Textarea
                      value={adminNotes}
                      onChange={e => setAdminNotes(e.target.value)}
                      className="bg-white/5 border-white/10 text-white resize-none mt-2"
                      rows={3}
                      placeholder="Internal admin notes (not shared with applicant)…"
                    />
                    <Button size="sm" onClick={() => updateNotesMutation.mutate()}
                      disabled={updateNotesMutation.isPending}
                      className="mt-2 bg-white/10 hover:bg-white/15 text-white">
                      Save Notes
                    </Button>
                  </div>
                </TabsContent>

                {/* Pipeline Tab */}
                <TabsContent value="pipeline" className="mt-4 space-y-4">
                  <div>
                    <p className="text-xs text-gray-500 uppercase tracking-widest mb-3">Move Application</p>
                    <div className="space-y-2">
                      {NEXT_STAGES[detail.stage]?.length === 0 && (
                        <p className="text-gray-500 text-sm">This application is in a final state ({detail.stage}).</p>
                      )}
                      {NEXT_STAGES[detail.stage]?.map(nextStage => {
                        const s = stageInfo(nextStage);
                        const Icon = s.icon;
                        return (
                          <Button
                            key={nextStage}
                            variant="outline"
                            className={`w-full justify-start gap-3 border ${s.bgColor} ${s.color} hover:opacity-80`}
                            onClick={() => setConfirmStage({ appId: detail.id, stage: nextStage })}
                          >
                            <Icon className="w-4 h-4" />
                            Move to {s.label}
                            <ArrowRight className="w-4 h-4 ml-auto" />
                          </Button>
                        );
                      })}
                    </div>
                  </div>

                  <Separator className="bg-white/10" />

                  <div>
                    <p className="text-xs text-gray-500 uppercase tracking-widest mb-3">Timeline</p>
                    <div className="space-y-2 text-sm">
                      <div className="flex justify-between">
                        <span className="text-gray-400">Submitted</span>
                        <span className="text-white">{new Date(detail.submittedAt).toLocaleDateString()}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-400">Last Updated</span>
                        <span className="text-white">{new Date(detail.stageUpdatedAt).toLocaleDateString()}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-gray-400">Days Waiting</span>
                        <span className="text-white">{daysSince(detail.submittedAt)}d</span>
                      </div>
                    </div>
                  </div>

                  <Separator className="bg-white/10" />

                  <div>
                    <Button variant="outline" size="sm"
                      className="border-red-500/30 text-red-400 hover:bg-red-500/10 gap-2"
                      onClick={() => setDeleteConfirm(detail.id)}>
                      <Trash2 className="w-4 h-4" />
                      Delete Application
                    </Button>
                  </div>
                </TabsContent>

                {/* Notes Tab */}
                <TabsContent value="notes" className="mt-4 space-y-4">
                  <div>
                    <Label className="text-gray-400">Add Note</Label>
                    <Textarea
                      value={noteBody}
                      onChange={e => setNoteBody(e.target.value)}
                      className="bg-white/5 border-white/10 text-white resize-none mt-2"
                      rows={3}
                      placeholder="Add an internal note about this application…"
                    />
                    <Button size="sm" onClick={() => noteMutation.mutate(noteBody)}
                      disabled={noteMutation.isPending || !noteBody.trim()}
                      className="mt-2 bg-green-600 hover:bg-green-700 text-white">
                      <Plus className="w-4 h-4 mr-1" />
                      Add Note
                    </Button>
                  </div>

                  <div className="space-y-3">
                    {detail.notes.length === 0 && (
                      <p className="text-gray-500 text-sm text-center py-4">No notes yet</p>
                    )}
                    {detail.notes.map(note => (
                      <div key={note.id} className="bg-white/5 rounded-lg p-3">
                        <div className="flex items-center justify-between mb-2">
                          <span className="text-white text-sm font-medium">
                            {note.authorDisplayName ?? note.authorUsername ?? 'Unknown'}
                          </span>
                          <span className="text-gray-500 text-xs">{new Date(note.createdAt).toLocaleString()}</span>
                        </div>
                        <p className="text-gray-300 text-sm leading-relaxed">{note.body}</p>
                      </div>
                    ))}
                  </div>
                </TabsContent>
              </Tabs>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Stage Change Confirmation Dialog */}
      <Dialog open={Boolean(confirmStage)} onOpenChange={open => { if (!open) { setConfirmStage(null); setRejectReason(''); } }}>
        <DialogContent className="bg-[#0f0f1a] border-white/10 text-white max-w-md">
          <DialogHeader>
            <DialogTitle>Confirm Stage Change</DialogTitle>
          </DialogHeader>
          {confirmStage && (() => {
            const s = stageInfo(confirmStage.stage);
            const Icon = s.icon;
            return (
              <div className="space-y-4">
                <p className="text-gray-400 text-sm">
                  Move this application to <strong className={s.color}>{s.label}</strong>?
                  {confirmStage.stage === 'approved' && ' This will automatically create a member record.'}
                  {confirmStage.stage !== 'approved' && confirmStage.stage !== 'rejected' && ' The applicant will receive an email notification.'}
                </p>

                {confirmStage.stage === 'rejected' && (
                  <div className="space-y-1.5">
                    <Label className="text-gray-400">Rejection Reason (optional)</Label>
                    <Textarea
                      value={rejectReason}
                      onChange={e => setRejectReason(e.target.value)}
                      className="bg-white/5 border-white/10 text-white resize-none"
                      rows={3}
                      placeholder="Provide a reason for the rejection…"
                    />
                  </div>
                )}

                <DialogFooter>
                  <Button variant="outline" onClick={() => { setConfirmStage(null); setRejectReason(''); }}
                    className="border-white/10 text-gray-300">Cancel</Button>
                  <Button
                    onClick={() => stageMutation.mutate({ appId: confirmStage.appId, stage: confirmStage.stage, rejectionReason: rejectReason })}
                    disabled={stageMutation.isPending}
                    className={`${confirmStage.stage === 'approved' ? 'bg-green-600 hover:bg-green-700' : confirmStage.stage === 'rejected' ? 'bg-red-600 hover:bg-red-700' : 'bg-blue-600 hover:bg-blue-700'} text-white`}
                  >
                    <Icon className="w-4 h-4 mr-2" />
                    Confirm
                  </Button>
                </DialogFooter>
              </div>
            );
          })()}
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <Dialog open={Boolean(deleteConfirm)} onOpenChange={open => { if (!open) setDeleteConfirm(null); }}>
        <DialogContent className="bg-[#0f0f1a] border-white/10 text-white max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete Application</DialogTitle>
          </DialogHeader>
          <p className="text-gray-400 text-sm">This will permanently delete the application and all notes. This action cannot be undone.</p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteConfirm(null)} className="border-white/10 text-gray-300">Cancel</Button>
            <Button onClick={() => deleteConfirm && deleteMutation.mutate(deleteConfirm)}
              disabled={deleteMutation.isPending}
              className="bg-red-600 hover:bg-red-700 text-white">
              <Trash2 className="w-4 h-4 mr-2" />
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
