import { useState, useEffect, useCallback } from 'react';
import { useGetMe } from '@workspace/api-client-react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import {
  FileText, Bell, CalendarDays, Vote, Plus, Upload, Download, Trash2,
  Edit2, Eye, EyeOff, Pin, PinOff, ChevronRight, RefreshCw, Search,
  CheckCircle2, XCircle, Clock, Archive, Shield, FileCheck2, Users,
  List, AlertCircle, ChevronDown, ChevronUp, Lock, Globe, UserCheck,
  ShieldCheck, AlertTriangle, RotateCw,
} from 'lucide-react';
import { Link, useSearch } from 'wouter';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Progress } from '@/components/ui/progress';
import { useToast } from '@/hooks/use-toast';
import { useActiveOrgContext } from '@/context/ActiveOrgContext';

const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');

function api(path: string, opts?: RequestInit) {
  return fetch(`${BASE}/api${path}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(opts?.headers ?? {}) },
    ...opts,
  }).then(async r => {
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`);
    return r.json();
  });
}

const CATEGORY_LABELS: Record<string, string> = {
  constitution: 'Constitution',
  handicap_policy: 'Handicap Policy',
  course_rules: 'Course Rules',
  committee_minutes: 'Committee Minutes',
  agm_documents: 'AGM Documents',
  financial_reports: 'Financial Reports',
  bylaws: 'By-Laws',
  other: 'Other',
};

const ACCESS_LABELS: Record<string, { label: string; icon: React.ComponentType<{ className?: string }>; cls: string }> = {
  public: { label: 'Public', icon: Globe, cls: 'bg-blue-500/20 text-blue-300 border-blue-500/30' },
  all_members: { label: 'All Members', icon: UserCheck, cls: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30' },
  committee_only: { label: 'Committee', icon: Shield, cls: 'bg-amber-500/20 text-amber-300 border-amber-500/30' },
};

const MEETING_STATUS_STYLES: Record<string, { label: string; cls: string }> = {
  scheduled: { label: 'Scheduled', cls: 'bg-blue-500/20 text-blue-300 border-blue-500/30' },
  in_progress: { label: 'In Progress', cls: 'bg-amber-500/20 text-amber-300 border-amber-500/30' },
  completed: { label: 'Completed', cls: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30' },
  cancelled: { label: 'Cancelled', cls: 'bg-red-500/20 text-red-400 border-red-500/30' },
};

const VOTE_STATUS_STYLES: Record<string, { label: string; cls: string }> = {
  draft: { label: 'Draft', cls: 'bg-white/10 text-white/50 border-white/10' },
  open: { label: 'Open', cls: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30' },
  closed: { label: 'Closed', cls: 'bg-slate-500/20 text-slate-300 border-slate-500/30' },
  cancelled: { label: 'Cancelled', cls: 'bg-red-500/20 text-red-400 border-red-500/30' },
};

function formatDate(d: string | null | undefined) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

function formatDateTime(d: string | null | undefined) {
  if (!d) return '—';
  return new Date(d).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function fmtSize(bytes: number | null | undefined) {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ── DOCUMENTS TAB ─────────────────────────────────────────────────────────────

interface DocVersion {
  id: number; versionNumber: number; fileName: string; fileUrl: string;
  fileSizeBytes: number | null; mimeType: string | null; changeNotes: string | null; createdAt: string;
}

interface ClubDoc {
  id: number; title: string; description: string | null; category: string;
  access: string; tags: string[]; currentVersionId: number | null;
  latestVersion: DocVersion | null; createdAt: string; updatedAt: string;
  versions?: DocVersion[];
}

function DocumentsTab({ orgId, isAdmin }: { orgId: number; isAdmin: boolean }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('all');
  const [showUpload, setShowUpload] = useState(false);
  const [showVersions, setShowVersions] = useState<ClubDoc | null>(null);
  const [editDoc, setEditDoc] = useState<ClubDoc | null>(null);
  const [form, setForm] = useState({ title: '', description: '', category: 'other', access: 'all_members', fileUrl: '', fileName: '', changeNotes: '' });

  const { data: docs = [], isLoading } = useQuery<ClubDoc[]>({
    queryKey: ['governance-docs', orgId, category, search],
    queryFn: () => {
      let qs = '';
      if (category !== 'all') qs += `?category=${category}`;
      if (search) qs += (qs ? '&' : '?') + `search=${encodeURIComponent(search)}`;
      return api(`/organizations/${orgId}/governance/documents${qs}`);
    },
    enabled: !!orgId,
  });

  async function handleUpload() {
    if (!form.title || !form.fileUrl || !form.fileName) { toast({ title: 'Missing fields', variant: 'destructive' }); return; }
    try {
      await api(`/organizations/${orgId}/governance/documents`, {
        method: 'POST', body: JSON.stringify({ ...form }),
      });
      toast({ title: 'Document uploaded' });
      qc.invalidateQueries({ queryKey: ['governance-docs', orgId] });
      setShowUpload(false);
      setForm({ title: '', description: '', category: 'other', access: 'all_members', fileUrl: '', fileName: '', changeNotes: '' });
    } catch (e: unknown) { toast({ title: (e as Error).message, variant: 'destructive' }); }
  }

  async function handleEdit() {
    if (!editDoc) return;
    try {
      await api(`/organizations/${orgId}/governance/documents/${editDoc.id}`, {
        method: 'PATCH', body: JSON.stringify({ title: form.title, description: form.description, category: form.category, access: form.access }),
      });
      toast({ title: 'Document updated' });
      qc.invalidateQueries({ queryKey: ['governance-docs', orgId] });
      setEditDoc(null);
    } catch (e: unknown) { toast({ title: (e as Error).message, variant: 'destructive' }); }
  }

  async function handleDelete(id: number) {
    if (!confirm('Archive this document?')) return;
    try {
      await api(`/organizations/${orgId}/governance/documents/${id}`, { method: 'DELETE' });
      toast({ title: 'Document archived' });
      qc.invalidateQueries({ queryKey: ['governance-docs', orgId] });
    } catch (e: unknown) { toast({ title: (e as Error).message, variant: 'destructive' }); }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-40">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search documents…" className="pl-9 bg-white/5 border-white/10" />
        </div>
        <Select value={category} onValueChange={setCategory}>
          <SelectTrigger className="w-44 bg-white/5 border-white/10">
            <SelectValue placeholder="All categories" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Categories</SelectItem>
            {Object.entries(CATEGORY_LABELS).map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}
          </SelectContent>
        </Select>
        {isAdmin && (
          <Button onClick={() => setShowUpload(true)} size="sm" className="bg-primary hover:bg-primary/90">
            <Upload className="w-4 h-4 mr-2" /> Upload
          </Button>
        )}
      </div>

      {isLoading ? (
        <div className="flex justify-center py-8"><RefreshCw className="w-6 h-6 animate-spin text-muted-foreground" /></div>
      ) : docs.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          <FileText className="w-10 h-10 mx-auto mb-3 opacity-30" />
          <p>No documents found</p>
        </div>
      ) : (
        <div className="grid gap-3">
          {docs.map(doc => {
            const acc = ACCESS_LABELS[doc.access];
            const AccIcon = acc.icon;
            return (
              <Card key={doc.id} className="bg-white/5 border-white/10 hover:border-white/20 transition-colors">
                <CardContent className="p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-start gap-3 min-w-0">
                      <div className="mt-0.5 p-2 rounded-lg bg-primary/10">
                        <FileText className="w-4 h-4 text-primary" />
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-medium text-white">{doc.title}</span>
                          <Badge variant="outline" className={`text-xs ${acc.cls}`}>
                            <AccIcon className="w-3 h-3 mr-1" />{acc.label}
                          </Badge>
                          <Badge variant="outline" className="text-xs bg-white/5 text-white/50 border-white/10">
                            {CATEGORY_LABELS[doc.category] ?? doc.category}
                          </Badge>
                        </div>
                        {doc.description && <p className="text-sm text-muted-foreground mt-1 line-clamp-1">{doc.description}</p>}
                        {doc.latestVersion && (
                          <p className="text-xs text-muted-foreground mt-1">
                            v{doc.latestVersion.versionNumber} · {doc.latestVersion.fileName}
                            {doc.latestVersion.fileSizeBytes ? ` · ${fmtSize(doc.latestVersion.fileSizeBytes)}` : ''}
                            · Updated {formatDate(doc.updatedAt)}
                          </p>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-1 flex-shrink-0">
                      {doc.latestVersion && (
                        <Button variant="ghost" size="sm" asChild className="text-muted-foreground hover:text-white">
                          <a href={doc.latestVersion.fileUrl} target="_blank" rel="noopener noreferrer"><Download className="w-4 h-4" /></a>
                        </Button>
                      )}
                      <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-white" onClick={() => setShowVersions(doc)}>
                        <List className="w-4 h-4" />
                      </Button>
                      {isAdmin && (
                        <>
                          <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-white" onClick={() => { setEditDoc(doc); setForm({ ...form, title: doc.title, description: doc.description ?? '', category: doc.category, access: doc.access }); }}>
                            <Edit2 className="w-4 h-4" />
                          </Button>
                          <Button variant="ghost" size="sm" className="text-red-400 hover:text-red-300" onClick={() => handleDelete(doc.id)}>
                            <Trash2 className="w-4 h-4" />
                          </Button>
                        </>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* Upload Dialog */}
      <Dialog open={showUpload} onOpenChange={setShowUpload}>
        <DialogContent className="bg-card border-white/10 max-w-lg">
          <DialogHeader><DialogTitle>Upload Document</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1">
              <Label>Title *</Label>
              <Input value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} className="bg-white/5 border-white/10" />
            </div>
            <div className="space-y-1">
              <Label>Description</Label>
              <Textarea value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} className="bg-white/5 border-white/10" rows={2} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>Category</Label>
                <Select value={form.category} onValueChange={v => setForm(f => ({ ...f, category: v }))}>
                  <SelectTrigger className="bg-white/5 border-white/10"><SelectValue /></SelectTrigger>
                  <SelectContent>{Object.entries(CATEGORY_LABELS).map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label>Access</Label>
                <Select value={form.access} onValueChange={v => setForm(f => ({ ...f, access: v }))}>
                  <SelectTrigger className="bg-white/5 border-white/10"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="public">Public</SelectItem>
                    <SelectItem value="all_members">All Members</SelectItem>
                    <SelectItem value="committee_only">Committee Only</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-1">
              <Label>File URL * <span className="text-xs text-muted-foreground">(paste a direct link or object storage URL)</span></Label>
              <Input value={form.fileUrl} onChange={e => setForm(f => ({ ...f, fileUrl: e.target.value }))} placeholder="https://…" className="bg-white/5 border-white/10" />
            </div>
            <div className="space-y-1">
              <Label>File Name *</Label>
              <Input value={form.fileName} onChange={e => setForm(f => ({ ...f, fileName: e.target.value }))} placeholder="club-constitution.pdf" className="bg-white/5 border-white/10" />
            </div>
          </div>
          <DialogFooter className="mt-4">
            <Button variant="ghost" onClick={() => setShowUpload(false)}>Cancel</Button>
            <Button onClick={handleUpload} className="bg-primary">Upload</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Dialog */}
      <Dialog open={!!editDoc} onOpenChange={() => setEditDoc(null)}>
        <DialogContent className="bg-card border-white/10 max-w-lg">
          <DialogHeader><DialogTitle>Edit Document</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1">
              <Label>Title</Label>
              <Input value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} className="bg-white/5 border-white/10" />
            </div>
            <div className="space-y-1">
              <Label>Description</Label>
              <Textarea value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} className="bg-white/5 border-white/10" rows={2} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>Category</Label>
                <Select value={form.category} onValueChange={v => setForm(f => ({ ...f, category: v }))}>
                  <SelectTrigger className="bg-white/5 border-white/10"><SelectValue /></SelectTrigger>
                  <SelectContent>{Object.entries(CATEGORY_LABELS).map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label>Access</Label>
                <Select value={form.access} onValueChange={v => setForm(f => ({ ...f, access: v }))}>
                  <SelectTrigger className="bg-white/5 border-white/10"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="public">Public</SelectItem>
                    <SelectItem value="all_members">All Members</SelectItem>
                    <SelectItem value="committee_only">Committee Only</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>
          <DialogFooter className="mt-4">
            <Button variant="ghost" onClick={() => setEditDoc(null)}>Cancel</Button>
            <Button onClick={handleEdit} className="bg-primary">Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Version History Dialog */}
      <Dialog open={!!showVersions} onOpenChange={() => setShowVersions(null)}>
        <DialogContent className="bg-card border-white/10 max-w-lg">
          <DialogHeader><DialogTitle>Version History — {showVersions?.title}</DialogTitle></DialogHeader>
          <VersionHistory orgId={orgId} doc={showVersions} isAdmin={isAdmin} onClose={() => setShowVersions(null)} />
        </DialogContent>
      </Dialog>
    </div>
  );
}

function VersionHistory({ orgId, doc, isAdmin, onClose }: { orgId: number; doc: ClubDoc | null; isAdmin: boolean; onClose: () => void }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [showNewVersion, setShowNewVersion] = useState(false);
  const [vForm, setVForm] = useState({ fileUrl: '', fileName: '', changeNotes: '' });

  const { data: versions = [] } = useQuery<DocVersion[]>({
    queryKey: ['doc-versions', orgId, doc?.id],
    queryFn: () => api(`/organizations/${orgId}/governance/documents/${doc!.id}/versions`),
    enabled: !!doc,
  });

  async function handleNewVersion() {
    if (!doc || !vForm.fileUrl || !vForm.fileName) { toast({ title: 'Missing fields', variant: 'destructive' }); return; }
    try {
      await api(`/organizations/${orgId}/governance/documents/${doc.id}/versions`, {
        method: 'POST', body: JSON.stringify(vForm),
      });
      toast({ title: 'New version uploaded' });
      qc.invalidateQueries({ queryKey: ['doc-versions', orgId, doc.id] });
      qc.invalidateQueries({ queryKey: ['governance-docs', orgId] });
      setShowNewVersion(false);
      setVForm({ fileUrl: '', fileName: '', changeNotes: '' });
    } catch (e: unknown) { toast({ title: (e as Error).message, variant: 'destructive' }); }
  }

  return (
    <div className="space-y-3">
      {versions.map(v => (
        <div key={v.id} className="flex items-center justify-between p-3 rounded-lg bg-white/5 border border-white/10">
          <div>
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="text-xs bg-primary/20 text-primary border-primary/30">v{v.versionNumber}</Badge>
              <span className="text-sm font-medium text-white">{v.fileName}</span>
            </div>
            {v.changeNotes && <p className="text-xs text-muted-foreground mt-0.5">{v.changeNotes}</p>}
            <p className="text-xs text-muted-foreground">{formatDate(v.createdAt)}{v.fileSizeBytes ? ` · ${fmtSize(v.fileSizeBytes)}` : ''}</p>
          </div>
          <Button variant="ghost" size="sm" asChild>
            <a href={v.fileUrl} target="_blank" rel="noopener noreferrer"><Download className="w-4 h-4" /></a>
          </Button>
        </div>
      ))}
      {versions.length === 0 && <p className="text-muted-foreground text-sm text-center py-4">No versions</p>}
      {isAdmin && !showNewVersion && (
        <Button size="sm" variant="outline" className="border-white/10 w-full mt-2" onClick={() => setShowNewVersion(true)}>
          <Upload className="w-4 h-4 mr-2" /> Upload New Version
        </Button>
      )}
      {isAdmin && showNewVersion && (
        <div className="space-y-3 border border-white/10 rounded-lg p-3">
          <Input value={vForm.fileUrl} onChange={e => setVForm(f => ({ ...f, fileUrl: e.target.value }))} placeholder="File URL" className="bg-white/5 border-white/10" />
          <Input value={vForm.fileName} onChange={e => setVForm(f => ({ ...f, fileName: e.target.value }))} placeholder="File name" className="bg-white/5 border-white/10" />
          <Input value={vForm.changeNotes} onChange={e => setVForm(f => ({ ...f, changeNotes: e.target.value }))} placeholder="Change notes (optional)" className="bg-white/5 border-white/10" />
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" onClick={() => setShowNewVersion(false)}>Cancel</Button>
            <Button size="sm" className="bg-primary flex-1" onClick={handleNewVersion}>Upload</Button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── NOTICES TAB ───────────────────────────────────────────────────────────────

interface GovernanceNotice {
  id: number; title: string; body: string; isPinned: boolean; access: string;
  expiresAt: string | null; isPublished: boolean; publishedAt: string | null;
  attachmentUrl: string | null; attachmentName: string | null; createdAt: string; updatedAt: string;
}

function NoticesTab({ orgId, isAdmin }: { orgId: number; isAdmin: boolean }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const [editNotice, setEditNotice] = useState<GovernanceNotice | null>(null);
  const [form, setForm] = useState({ title: '', body: '', isPinned: false, access: 'all_members', expiresAt: '' });

  const { data: notices = [], isLoading } = useQuery<GovernanceNotice[]>({
    queryKey: ['governance-notices', orgId],
    queryFn: () => api(`/organizations/${orgId}/governance/notices`),
    enabled: !!orgId,
  });

  async function handleCreate() {
    if (!form.title || !form.body) { toast({ title: 'Missing fields', variant: 'destructive' }); return; }
    try {
      await api(`/organizations/${orgId}/governance/notices`, {
        method: 'POST', body: JSON.stringify({ ...form, expiresAt: form.expiresAt || null }),
      });
      toast({ title: 'Notice created' });
      qc.invalidateQueries({ queryKey: ['governance-notices', orgId] });
      setShowCreate(false);
      setForm({ title: '', body: '', isPinned: false, access: 'all_members', expiresAt: '' });
    } catch (e: unknown) { toast({ title: (e as Error).message, variant: 'destructive' }); }
  }

  async function handleEdit() {
    if (!editNotice) return;
    try {
      await api(`/organizations/${orgId}/governance/notices/${editNotice.id}`, {
        method: 'PATCH', body: JSON.stringify({ ...form, expiresAt: form.expiresAt || null }),
      });
      toast({ title: 'Notice updated' });
      qc.invalidateQueries({ queryKey: ['governance-notices', orgId] });
      setEditNotice(null);
    } catch (e: unknown) { toast({ title: (e as Error).message, variant: 'destructive' }); }
  }

  async function handlePublish(id: number) {
    try {
      await api(`/organizations/${orgId}/governance/notices/${id}/publish`, { method: 'POST' });
      toast({ title: 'Notice published' });
      qc.invalidateQueries({ queryKey: ['governance-notices', orgId] });
    } catch (e: unknown) { toast({ title: (e as Error).message, variant: 'destructive' }); }
  }

  async function handleDelete(id: number) {
    if (!confirm('Delete this notice?')) return;
    try {
      await api(`/organizations/${orgId}/governance/notices/${id}`, { method: 'DELETE' });
      toast({ title: 'Notice deleted' });
      qc.invalidateQueries({ queryKey: ['governance-notices', orgId] });
    } catch (e: unknown) { toast({ title: (e as Error).message, variant: 'destructive' }); }
  }

  const noticeForm = (
    <div className="space-y-4">
      <div className="space-y-1">
        <Label>Title *</Label>
        <Input value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} className="bg-white/5 border-white/10" />
      </div>
      <div className="space-y-1">
        <Label>Body *</Label>
        <Textarea value={form.body} onChange={e => setForm(f => ({ ...f, body: e.target.value }))} className="bg-white/5 border-white/10" rows={4} />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label>Access</Label>
          <Select value={form.access} onValueChange={v => setForm(f => ({ ...f, access: v }))}>
            <SelectTrigger className="bg-white/5 border-white/10"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="public">Public</SelectItem>
              <SelectItem value="all_members">All Members</SelectItem>
              <SelectItem value="committee_only">Committee Only</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label>Expires At</Label>
          <Input type="date" value={form.expiresAt} onChange={e => setForm(f => ({ ...f, expiresAt: e.target.value }))} className="bg-white/5 border-white/10" />
        </div>
      </div>
      <div className="flex items-center gap-2">
        <input type="checkbox" id="pinned" checked={form.isPinned} onChange={e => setForm(f => ({ ...f, isPinned: e.target.checked }))} className="rounded" />
        <label htmlFor="pinned" className="text-sm text-muted-foreground">Pin this notice</label>
      </div>
    </div>
  );

  return (
    <div className="space-y-4">
      {isAdmin && (
        <div className="flex justify-end">
          <Button size="sm" className="bg-primary" onClick={() => setShowCreate(true)}>
            <Plus className="w-4 h-4 mr-2" /> New Notice
          </Button>
        </div>
      )}

      {isLoading ? (
        <div className="flex justify-center py-8"><RefreshCw className="w-6 h-6 animate-spin text-muted-foreground" /></div>
      ) : notices.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          <Bell className="w-10 h-10 mx-auto mb-3 opacity-30" />
          <p>No notices</p>
        </div>
      ) : (
        <div className="grid gap-3">
          {notices.map(n => {
            const acc = ACCESS_LABELS[n.access];
            const AccIcon = acc.icon;
            const expired = n.expiresAt && new Date(n.expiresAt) < new Date();
            return (
              <Card key={n.id} className={`bg-white/5 border-white/10 ${n.isPinned ? 'border-l-2 border-l-amber-400' : ''}`}>
                <CardContent className="p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap mb-1">
                        {n.isPinned && <Pin className="w-3 h-3 text-amber-400" />}
                        <span className="font-medium text-white">{n.title}</span>
                        {!n.isPublished && isAdmin && <Badge variant="outline" className="text-xs bg-white/10 text-white/50 border-white/10">Draft</Badge>}
                        {expired && <Badge variant="outline" className="text-xs bg-red-500/20 text-red-400 border-red-500/30">Expired</Badge>}
                        <Badge variant="outline" className={`text-xs ${acc.cls}`}><AccIcon className="w-3 h-3 mr-1" />{acc.label}</Badge>
                      </div>
                      <p className="text-sm text-muted-foreground line-clamp-2">{n.body}</p>
                      <div className="flex items-center gap-3 mt-2 text-xs text-muted-foreground">
                        <span>{formatDate(n.createdAt)}</span>
                        {n.expiresAt && <span>Expires: {formatDate(n.expiresAt)}</span>}
                      </div>
                    </div>
                    {isAdmin && (
                      <div className="flex items-center gap-1 flex-shrink-0">
                        {!n.isPublished && (
                          <Button variant="ghost" size="sm" className="text-emerald-400 hover:text-emerald-300" onClick={() => handlePublish(n.id)}>
                            <Eye className="w-4 h-4" />
                          </Button>
                        )}
                        <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-white" onClick={() => {
                          setEditNotice(n);
                          setForm({ title: n.title, body: n.body, isPinned: n.isPinned, access: n.access, expiresAt: n.expiresAt ? n.expiresAt.slice(0, 10) : '' });
                        }}>
                          <Edit2 className="w-4 h-4" />
                        </Button>
                        <Button variant="ghost" size="sm" className="text-red-400 hover:text-red-300" onClick={() => handleDelete(n.id)}>
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent className="bg-card border-white/10 max-w-lg">
          <DialogHeader><DialogTitle>New Notice</DialogTitle></DialogHeader>
          {noticeForm}
          <DialogFooter className="mt-4">
            <Button variant="ghost" onClick={() => setShowCreate(false)}>Cancel</Button>
            <Button onClick={handleCreate} className="bg-primary">Create</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!editNotice} onOpenChange={() => setEditNotice(null)}>
        <DialogContent className="bg-card border-white/10 max-w-lg">
          <DialogHeader><DialogTitle>Edit Notice</DialogTitle></DialogHeader>
          {noticeForm}
          <DialogFooter className="mt-4">
            <Button variant="ghost" onClick={() => setEditNotice(null)}>Cancel</Button>
            <Button onClick={handleEdit} className="bg-primary">Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── MEETINGS TAB ──────────────────────────────────────────────────────────────

interface AgendaItem {
  id: number; sortOrder: number; title: string; description: string | null; duration: number | null;
}

interface Meeting {
  id: number; title: string; description: string | null; status: string;
  scheduledAt: string; location: string | null; access: string;
  minutesPublished: boolean; minutesPublishedAt: string | null;
  agendaItems?: AgendaItem[];
  minutes?: { content: string; attendees: string[]; createdAt: string } | null;
  createdAt: string; updatedAt: string;
}

function MeetingsTab({ orgId, isAdmin, isCommittee }: { orgId: number; isAdmin: boolean; isCommittee: boolean }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const [detailMeeting, setDetailMeeting] = useState<Meeting | null>(null);
  const [showMinutes, setShowMinutes] = useState(false);
  const [minutesContent, setMinutesContent] = useState('');
  const [minutesAttendees, setMinutesAttendees] = useState('');
  const [form, setForm] = useState({ title: '', description: '', scheduledAt: '', location: '', access: 'committee_only' });
  const [agendaForm, setAgendaForm] = useState({ title: '', description: '', duration: '' });

  const { data: meetings = [], isLoading } = useQuery<Meeting[]>({
    queryKey: ['governance-meetings', orgId],
    queryFn: () => api(`/organizations/${orgId}/governance/meetings`),
    enabled: !!orgId,
  });

  async function fetchDetail(id: number) {
    const m = await api(`/organizations/${orgId}/governance/meetings/${id}`);
    setDetailMeeting(m);
    if (m.minutes) {
      setMinutesContent(m.minutes.content);
      setMinutesAttendees((m.minutes.attendees ?? []).join(', '));
    } else {
      setMinutesContent('');
      setMinutesAttendees('');
    }
  }

  async function handleCreate() {
    if (!form.title || !form.scheduledAt) { toast({ title: 'Missing fields', variant: 'destructive' }); return; }
    try {
      await api(`/organizations/${orgId}/governance/meetings`, {
        method: 'POST', body: JSON.stringify({ ...form }),
      });
      toast({ title: 'Meeting created' });
      qc.invalidateQueries({ queryKey: ['governance-meetings', orgId] });
      setShowCreate(false);
      setForm({ title: '', description: '', scheduledAt: '', location: '', access: 'committee_only' });
    } catch (e: unknown) { toast({ title: (e as Error).message, variant: 'destructive' }); }
  }

  async function handleAddAgenda() {
    if (!detailMeeting || !agendaForm.title) { toast({ title: 'Title required', variant: 'destructive' }); return; }
    try {
      await api(`/organizations/${orgId}/governance/meetings/${detailMeeting.id}/agenda`, {
        method: 'POST', body: JSON.stringify({ title: agendaForm.title, description: agendaForm.description || null, duration: agendaForm.duration ? parseInt(agendaForm.duration) : null }),
      });
      toast({ title: 'Agenda item added' });
      await fetchDetail(detailMeeting.id);
      setAgendaForm({ title: '', description: '', duration: '' });
    } catch (e: unknown) { toast({ title: (e as Error).message, variant: 'destructive' }); }
  }

  async function handleDeleteAgenda(itemId: number) {
    if (!detailMeeting) return;
    try {
      await api(`/organizations/${orgId}/governance/meetings/${detailMeeting.id}/agenda/${itemId}`, { method: 'DELETE' });
      await fetchDetail(detailMeeting.id);
    } catch (e: unknown) { toast({ title: (e as Error).message, variant: 'destructive' }); }
  }

  async function handleSaveMinutes() {
    if (!detailMeeting) return;
    try {
      await api(`/organizations/${orgId}/governance/meetings/${detailMeeting.id}/minutes`, {
        method: 'POST', body: JSON.stringify({
          content: minutesContent,
          attendees: minutesAttendees.split(',').map(s => s.trim()).filter(Boolean),
        }),
      });
      toast({ title: 'Minutes saved' });
      await fetchDetail(detailMeeting.id);
      setShowMinutes(false);
    } catch (e: unknown) { toast({ title: (e as Error).message, variant: 'destructive' }); }
  }

  async function handlePublishMinutes() {
    if (!detailMeeting) return;
    if (!confirm('Publish minutes? This will mark the meeting as completed.')) return;
    try {
      await api(`/organizations/${orgId}/governance/meetings/${detailMeeting.id}/publish-minutes`, { method: 'POST' });
      toast({ title: 'Minutes published' });
      qc.invalidateQueries({ queryKey: ['governance-meetings', orgId] });
      await fetchDetail(detailMeeting.id);
    } catch (e: unknown) { toast({ title: (e as Error).message, variant: 'destructive' }); }
  }

  async function handleDeleteMeeting(id: number) {
    if (!confirm('Delete this meeting?')) return;
    try {
      await api(`/organizations/${orgId}/governance/meetings/${id}`, { method: 'DELETE' });
      toast({ title: 'Meeting deleted' });
      qc.invalidateQueries({ queryKey: ['governance-meetings', orgId] });
    } catch (e: unknown) { toast({ title: (e as Error).message, variant: 'destructive' }); }
  }

  return (
    <div className="space-y-4">
      {isAdmin && (
        <div className="flex justify-end">
          <Button size="sm" className="bg-primary" onClick={() => setShowCreate(true)}>
            <Plus className="w-4 h-4 mr-2" /> Schedule Meeting
          </Button>
        </div>
      )}

      {isLoading ? (
        <div className="flex justify-center py-8"><RefreshCw className="w-6 h-6 animate-spin text-muted-foreground" /></div>
      ) : meetings.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          <CalendarDays className="w-10 h-10 mx-auto mb-3 opacity-30" />
          <p>No meetings scheduled</p>
        </div>
      ) : (
        <div className="grid gap-3">
          {meetings.map(m => {
            const s = MEETING_STATUS_STYLES[m.status] ?? MEETING_STATUS_STYLES.scheduled;
            const acc = ACCESS_LABELS[m.access];
            const AccIcon = acc.icon;
            return (
              <Card key={m.id} className="bg-white/5 border-white/10 hover:border-white/20 transition-colors cursor-pointer" onClick={() => fetchDetail(m.id)}>
                <CardContent className="p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap mb-1">
                        <span className="font-medium text-white">{m.title}</span>
                        <Badge variant="outline" className={`text-xs ${s.cls}`}>{s.label}</Badge>
                        <Badge variant="outline" className={`text-xs ${acc.cls}`}><AccIcon className="w-3 h-3 mr-1" />{acc.label}</Badge>
                        {m.minutesPublished && <Badge variant="outline" className="text-xs bg-emerald-500/20 text-emerald-300 border-emerald-500/30"><FileCheck2 className="w-3 h-3 mr-1" />Minutes Published</Badge>}
                      </div>
                      <p className="text-sm text-muted-foreground"><CalendarDays className="w-3 h-3 inline mr-1" />{formatDateTime(m.scheduledAt)}{m.location ? ` · ${m.location}` : ''}</p>
                    </div>
                    <div className="flex items-center gap-1 flex-shrink-0" onClick={e => e.stopPropagation()}>
                      {isAdmin && (
                        <Button variant="ghost" size="sm" className="text-red-400 hover:text-red-300" onClick={() => handleDeleteMeeting(m.id)}>
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      )}
                      <ChevronRight className="w-4 h-4 text-muted-foreground" />
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* Create Meeting Dialog */}
      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent className="bg-card border-white/10 max-w-lg">
          <DialogHeader><DialogTitle>Schedule Committee Meeting</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1"><Label>Title *</Label>
              <Input value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} className="bg-white/5 border-white/10" />
            </div>
            <div className="space-y-1"><Label>Description</Label>
              <Textarea value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} className="bg-white/5 border-white/10" rows={2} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1"><Label>Date & Time *</Label>
                <Input type="datetime-local" value={form.scheduledAt} onChange={e => setForm(f => ({ ...f, scheduledAt: e.target.value }))} className="bg-white/5 border-white/10" />
              </div>
              <div className="space-y-1"><Label>Location</Label>
                <Input value={form.location} onChange={e => setForm(f => ({ ...f, location: e.target.value }))} className="bg-white/5 border-white/10" />
              </div>
            </div>
            <div className="space-y-1"><Label>Access</Label>
              <Select value={form.access} onValueChange={v => setForm(f => ({ ...f, access: v }))}>
                <SelectTrigger className="bg-white/5 border-white/10"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="committee_only">Committee Only</SelectItem>
                  <SelectItem value="all_members">All Members</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter className="mt-4">
            <Button variant="ghost" onClick={() => setShowCreate(false)}>Cancel</Button>
            <Button onClick={handleCreate} className="bg-primary">Create</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Meeting Detail Dialog */}
      <Dialog open={!!detailMeeting} onOpenChange={() => setDetailMeeting(null)}>
        <DialogContent className="bg-card border-white/10 max-w-2xl max-h-[85vh] overflow-y-auto">
          {detailMeeting && (
            <>
              <DialogHeader>
                <DialogTitle>{detailMeeting.title}</DialogTitle>
                <p className="text-sm text-muted-foreground">{formatDateTime(detailMeeting.scheduledAt)}{detailMeeting.location ? ` · ${detailMeeting.location}` : ''}</p>
              </DialogHeader>

              <div className="space-y-6">
                {/* Agenda */}
                <div>
                  <h3 className="text-sm font-semibold text-white mb-2 flex items-center gap-2"><List className="w-4 h-4" /> Agenda</h3>
                  {(detailMeeting.agendaItems ?? []).length === 0 ? (
                    <p className="text-muted-foreground text-sm">No agenda items</p>
                  ) : (
                    <div className="space-y-2">
                      {(detailMeeting.agendaItems ?? []).map((item, i) => (
                        <div key={item.id} className="flex items-start justify-between p-2 rounded-lg bg-white/5 border border-white/10">
                          <div>
                            <span className="text-sm font-medium text-white">{i + 1}. {item.title}</span>
                            {item.description && <p className="text-xs text-muted-foreground mt-0.5">{item.description}</p>}
                            {item.duration && <p className="text-xs text-muted-foreground">{item.duration} min</p>}
                          </div>
                          {isAdmin && (
                            <Button variant="ghost" size="sm" className="text-red-400 hover:text-red-300" onClick={() => handleDeleteAgenda(item.id)}>
                              <Trash2 className="w-3 h-3" />
                            </Button>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                  {isAdmin && (
                    <div className="mt-3 flex items-end gap-2 p-3 bg-white/5 rounded-lg border border-white/10">
                      <div className="flex-1 space-y-2">
                        <Input value={agendaForm.title} onChange={e => setAgendaForm(f => ({ ...f, title: e.target.value }))} placeholder="Item title" className="bg-white/5 border-white/10" />
                        <div className="flex gap-2">
                          <Input value={agendaForm.description} onChange={e => setAgendaForm(f => ({ ...f, description: e.target.value }))} placeholder="Description" className="bg-white/5 border-white/10 flex-1" />
                          <Input value={agendaForm.duration} onChange={e => setAgendaForm(f => ({ ...f, duration: e.target.value }))} placeholder="Min" type="number" className="bg-white/5 border-white/10 w-20" />
                        </div>
                      </div>
                      <Button size="sm" onClick={handleAddAgenda} className="bg-primary mb-0.5"><Plus className="w-4 h-4" /></Button>
                    </div>
                  )}
                </div>

                {/* Minutes */}
                <div>
                  <h3 className="text-sm font-semibold text-white mb-2 flex items-center gap-2"><FileCheck2 className="w-4 h-4" /> Minutes</h3>
                  {detailMeeting.minutes ? (
                    <div className="p-3 rounded-lg bg-white/5 border border-white/10">
                      <p className="text-sm text-white whitespace-pre-wrap">{detailMeeting.minutes.content}</p>
                      {(detailMeeting.minutes.attendees ?? []).length > 0 && (
                        <p className="text-xs text-muted-foreground mt-2"><Users className="w-3 h-3 inline mr-1" />{detailMeeting.minutes.attendees.join(', ')}</p>
                      )}
                    </div>
                  ) : (
                    <p className="text-muted-foreground text-sm">No minutes recorded yet</p>
                  )}
                  {isAdmin && (
                    <div className="flex gap-2 mt-2">
                      <Button size="sm" variant="outline" className="border-white/10" onClick={() => setShowMinutes(true)}>
                        <Edit2 className="w-3 h-3 mr-1" /> {detailMeeting.minutes ? 'Edit' : 'Record'} Minutes
                      </Button>
                      {detailMeeting.minutes && !detailMeeting.minutesPublished && (
                        <Button size="sm" className="bg-emerald-600 hover:bg-emerald-700" onClick={handlePublishMinutes}>
                          <Eye className="w-3 h-3 mr-1" /> Publish Minutes
                        </Button>
                      )}
                      {detailMeeting.minutesPublished && (
                        <Badge variant="outline" className="text-xs bg-emerald-500/20 text-emerald-300 border-emerald-500/30 self-center">
                          <CheckCircle2 className="w-3 h-3 mr-1" /> Published {formatDate(detailMeeting.minutesPublishedAt)}
                        </Badge>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Minutes Editor */}
      <Dialog open={showMinutes} onOpenChange={setShowMinutes}>
        <DialogContent className="bg-card border-white/10 max-w-lg">
          <DialogHeader><DialogTitle>Record Minutes</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1">
              <Label>Minutes Content</Label>
              <Textarea value={minutesContent} onChange={e => setMinutesContent(e.target.value)} className="bg-white/5 border-white/10" rows={8} placeholder="Record the meeting minutes here…" />
            </div>
            <div className="space-y-1">
              <Label>Attendees <span className="text-xs text-muted-foreground">(comma-separated)</span></Label>
              <Input value={minutesAttendees} onChange={e => setMinutesAttendees(e.target.value)} className="bg-white/5 border-white/10" placeholder="John Smith, Jane Doe, …" />
            </div>
          </div>
          <DialogFooter className="mt-4">
            <Button variant="ghost" onClick={() => setShowMinutes(false)}>Cancel</Button>
            <Button onClick={handleSaveMinutes} className="bg-primary">Save Minutes</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── VOTING TAB ────────────────────────────────────────────────────────────────

interface CommitteeVote {
  id: number; title: string; description: string | null;
  options: string[]; status: string; access: string;
  deadline: string | null; resultsVisible: boolean; allowAbstain: boolean;
  totalVotes?: number; userHasVoted?: boolean; userChoice?: string | null;
  userAbstained?: boolean; results?: { tally: Record<string, number>; abstainCount: number } | null;
  createdAt: string; updatedAt: string;
}

function VotingTab({ orgId, isAdmin }: { orgId: number; isAdmin: boolean }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const [detailVote, setDetailVote] = useState<CommitteeVote | null>(null);
  const [selectedChoice, setSelectedChoice] = useState('');
  const [form, setForm] = useState({ title: '', description: '', options: ['', ''], access: 'committee_only', deadline: '', allowAbstain: true, resultsVisible: false });

  const { data: votes = [], isLoading } = useQuery<CommitteeVote[]>({
    queryKey: ['governance-votes', orgId],
    queryFn: () => api(`/organizations/${orgId}/governance/votes`),
    enabled: !!orgId,
  });

  async function fetchDetail(id: number) {
    const v = await api(`/organizations/${orgId}/governance/votes/${id}`);
    setDetailVote(v);
    setSelectedChoice(v.userChoice ?? '');
  }

  async function handleCreate() {
    const cleanOptions = form.options.filter(o => o.trim());
    if (!form.title || cleanOptions.length < 2) { toast({ title: 'Title and at least 2 options required', variant: 'destructive' }); return; }
    try {
      await api(`/organizations/${orgId}/governance/votes`, {
        method: 'POST', body: JSON.stringify({ ...form, options: cleanOptions, deadline: form.deadline || null }),
      });
      toast({ title: 'Vote created' });
      qc.invalidateQueries({ queryKey: ['governance-votes', orgId] });
      setShowCreate(false);
      setForm({ title: '', description: '', options: ['', ''], access: 'committee_only', deadline: '', allowAbstain: true, resultsVisible: false });
    } catch (e: unknown) { toast({ title: (e as Error).message, variant: 'destructive' }); }
  }

  async function handleOpenVote(id: number) {
    try {
      await api(`/organizations/${orgId}/governance/votes/${id}/open`, { method: 'POST' });
      toast({ title: 'Voting opened' });
      qc.invalidateQueries({ queryKey: ['governance-votes', orgId] });
      if (detailVote?.id === id) await fetchDetail(id);
    } catch (e: unknown) { toast({ title: (e as Error).message, variant: 'destructive' }); }
  }

  async function handleCloseVote(id: number) {
    if (!confirm('Close voting? Results will be made visible.')) return;
    try {
      await api(`/organizations/${orgId}/governance/votes/${id}/close`, { method: 'POST' });
      toast({ title: 'Voting closed' });
      qc.invalidateQueries({ queryKey: ['governance-votes', orgId] });
      if (detailVote?.id === id) await fetchDetail(id);
    } catch (e: unknown) { toast({ title: (e as Error).message, variant: 'destructive' }); }
  }

  async function handleCastBallot(abstain = false) {
    if (!detailVote) return;
    if (!abstain && !selectedChoice) { toast({ title: 'Please select an option', variant: 'destructive' }); return; }
    try {
      await api(`/organizations/${orgId}/governance/votes/${detailVote.id}/ballot`, {
        method: 'POST', body: JSON.stringify({ choice: abstain ? undefined : selectedChoice, abstain }),
      });
      toast({ title: 'Ballot submitted' });
      await fetchDetail(detailVote.id);
      qc.invalidateQueries({ queryKey: ['governance-votes', orgId] });
    } catch (e: unknown) { toast({ title: (e as Error).message, variant: 'destructive' }); }
  }

  return (
    <div className="space-y-4">
      {isAdmin && (
        <div className="flex justify-end">
          <Button size="sm" className="bg-primary" onClick={() => setShowCreate(true)}>
            <Plus className="w-4 h-4 mr-2" /> New Vote
          </Button>
        </div>
      )}

      {isLoading ? (
        <div className="flex justify-center py-8"><RefreshCw className="w-6 h-6 animate-spin text-muted-foreground" /></div>
      ) : votes.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          <Vote className="w-10 h-10 mx-auto mb-3 opacity-30" />
          <p>No votes</p>
        </div>
      ) : (
        <div className="grid gap-3">
          {votes.map(v => {
            const s = VOTE_STATUS_STYLES[v.status] ?? VOTE_STATUS_STYLES.draft;
            const acc = ACCESS_LABELS[v.access];
            const AccIcon = acc.icon;
            return (
              <Card key={v.id} className="bg-white/5 border-white/10 hover:border-white/20 transition-colors cursor-pointer" onClick={() => fetchDetail(v.id)}>
                <CardContent className="p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap mb-1">
                        <span className="font-medium text-white">{v.title}</span>
                        <Badge variant="outline" className={`text-xs ${s.cls}`}>{s.label}</Badge>
                        <Badge variant="outline" className={`text-xs ${acc.cls}`}><AccIcon className="w-3 h-3 mr-1" />{acc.label}</Badge>
                      </div>
                      {v.description && <p className="text-sm text-muted-foreground line-clamp-1">{v.description}</p>}
                      <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
                        <span>{v.options.length} options</span>
                        {v.deadline && <span>Deadline: {formatDate(v.deadline)}</span>}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      {isAdmin && v.status === 'draft' && (
                        <Button size="sm" variant="outline" className="border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/10" onClick={e => { e.stopPropagation(); handleOpenVote(v.id); }}>
                          Open
                        </Button>
                      )}
                      {isAdmin && v.status === 'open' && (
                        <Button size="sm" variant="outline" className="border-red-500/30 text-red-400 hover:bg-red-500/10" onClick={e => { e.stopPropagation(); handleCloseVote(v.id); }}>
                          Close
                        </Button>
                      )}
                      <ChevronRight className="w-4 h-4 text-muted-foreground" />
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* Create Vote Dialog */}
      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent className="bg-card border-white/10 max-w-lg">
          <DialogHeader><DialogTitle>Create Vote</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1"><Label>Title *</Label>
              <Input value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} className="bg-white/5 border-white/10" />
            </div>
            <div className="space-y-1"><Label>Description</Label>
              <Textarea value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} className="bg-white/5 border-white/10" rows={2} />
            </div>
            <div className="space-y-1">
              <Label>Options * <span className="text-xs text-muted-foreground">(min. 2)</span></Label>
              {form.options.map((opt, i) => (
                <div key={i} className="flex gap-2 mt-1">
                  <Input value={opt} onChange={e => { const o = [...form.options]; o[i] = e.target.value; setForm(f => ({ ...f, options: o })); }} placeholder={`Option ${i + 1}`} className="bg-white/5 border-white/10" />
                  {form.options.length > 2 && (
                    <Button variant="ghost" size="sm" onClick={() => setForm(f => ({ ...f, options: f.options.filter((_, j) => j !== i) }))} className="text-red-400"><Trash2 className="w-4 h-4" /></Button>
                  )}
                </div>
              ))}
              <Button variant="ghost" size="sm" className="mt-1 text-muted-foreground" onClick={() => setForm(f => ({ ...f, options: [...f.options, ''] }))}>
                <Plus className="w-3 h-3 mr-1" /> Add option
              </Button>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1"><Label>Access</Label>
                <Select value={form.access} onValueChange={v => setForm(f => ({ ...f, access: v }))}>
                  <SelectTrigger className="bg-white/5 border-white/10"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="committee_only">Committee Only</SelectItem>
                    <SelectItem value="all_members">All Members</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1"><Label>Deadline</Label>
                <Input type="datetime-local" value={form.deadline} onChange={e => setForm(f => ({ ...f, deadline: e.target.value }))} className="bg-white/5 border-white/10" />
              </div>
            </div>
            <div className="flex gap-4">
              <div className="flex items-center gap-2">
                <input type="checkbox" checked={form.allowAbstain} onChange={e => setForm(f => ({ ...f, allowAbstain: e.target.checked }))} />
                <label className="text-sm text-muted-foreground">Allow abstain</label>
              </div>
              <div className="flex items-center gap-2">
                <input type="checkbox" checked={form.resultsVisible} onChange={e => setForm(f => ({ ...f, resultsVisible: e.target.checked }))} />
                <label className="text-sm text-muted-foreground">Show live results</label>
              </div>
            </div>
          </div>
          <DialogFooter className="mt-4">
            <Button variant="ghost" onClick={() => setShowCreate(false)}>Cancel</Button>
            <Button onClick={handleCreate} className="bg-primary">Create</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Vote Detail Dialog */}
      <Dialog open={!!detailVote} onOpenChange={() => setDetailVote(null)}>
        <DialogContent className="bg-card border-white/10 max-w-lg">
          {detailVote && (
            <>
              <DialogHeader>
                <DialogTitle>{detailVote.title}</DialogTitle>
                <div className="flex items-center gap-2 mt-1">
                  <Badge variant="outline" className={`text-xs ${VOTE_STATUS_STYLES[detailVote.status]?.cls}`}>{VOTE_STATUS_STYLES[detailVote.status]?.label}</Badge>
                  {detailVote.deadline && <span className="text-xs text-muted-foreground">Deadline: {formatDateTime(detailVote.deadline)}</span>}
                </div>
              </DialogHeader>
              <div className="space-y-4">
                {detailVote.description && <p className="text-sm text-muted-foreground">{detailVote.description}</p>}

                {/* Ballot */}
                {detailVote.status === 'open' && !detailVote.userHasVoted && (
                  <div className="space-y-2">
                    <p className="text-sm font-medium text-white">Cast Your Vote</p>
                    {(detailVote.options ?? []).map(opt => (
                      <label key={opt} className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${selectedChoice === opt ? 'bg-primary/20 border-primary/50' : 'bg-white/5 border-white/10 hover:border-white/20'}`}>
                        <input type="radio" name="vote" value={opt} checked={selectedChoice === opt} onChange={() => setSelectedChoice(opt)} className="sr-only" />
                        <div className={`w-4 h-4 rounded-full border-2 flex items-center justify-center ${selectedChoice === opt ? 'border-primary' : 'border-white/30'}`}>
                          {selectedChoice === opt && <div className="w-2 h-2 rounded-full bg-primary" />}
                        </div>
                        <span className="text-sm text-white">{opt}</span>
                      </label>
                    ))}
                    <div className="flex gap-2 pt-1">
                      <Button className="flex-1 bg-primary" onClick={() => handleCastBallot(false)}>Submit Vote</Button>
                      {detailVote.allowAbstain && (
                        <Button variant="outline" className="border-white/10" onClick={() => handleCastBallot(true)}>Abstain</Button>
                      )}
                    </div>
                  </div>
                )}

                {detailVote.userHasVoted && (
                  <div className="p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/30">
                    <p className="text-sm text-emerald-300 flex items-center gap-2">
                      <CheckCircle2 className="w-4 h-4" />
                      {detailVote.userAbstained ? 'You abstained from this vote' : `You voted: ${detailVote.userChoice}`}
                    </p>
                  </div>
                )}

                {/* Results */}
                {detailVote.results && (
                  <div className="space-y-2">
                    <p className="text-sm font-medium text-white">Results ({detailVote.totalVotes} votes cast)</p>
                    {(detailVote.options ?? []).map(opt => {
                      const count = detailVote.results?.tally[opt] ?? 0;
                      const total = detailVote.totalVotes ?? 1;
                      const pct = total > 0 ? Math.round((count / total) * 100) : 0;
                      return (
                        <div key={opt} className="space-y-1">
                          <div className="flex justify-between text-sm">
                            <span className="text-white">{opt}</span>
                            <span className="text-muted-foreground">{count} ({pct}%)</span>
                          </div>
                          <div className="h-2 bg-white/10 rounded-full overflow-hidden">
                            <div className="h-full bg-primary rounded-full transition-all" style={{ width: `${pct}%` }} />
                          </div>
                        </div>
                      );
                    })}
                    {(detailVote.results.abstainCount ?? 0) > 0 && (
                      <p className="text-xs text-muted-foreground">{detailVote.results.abstainCount} abstained</p>
                    )}
                  </div>
                )}

                {isAdmin && (
                  <div className="flex gap-2 pt-2">
                    {detailVote.status === 'draft' && (
                      <Button size="sm" className="bg-emerald-600 hover:bg-emerald-700" onClick={() => handleOpenVote(detailVote.id)}>Open Voting</Button>
                    )}
                    {detailVote.status === 'open' && (
                      <Button size="sm" variant="outline" className="border-red-500/30 text-red-400" onClick={() => handleCloseVote(detailVote.id)}>Close Voting</Button>
                    )}
                  </div>
                )}
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── MAIN PAGE ─────────────────────────────────────────────────────────────────

// Task #1770 — map a `?panel=…` query value (sent by the daily
// stuck-erasure controller digest, the in-app inbox row, and the home
// dashboard backlog widget) to the tab that owns the matching card,
// so deep-links open the right tab on first paint instead of dumping
// the controller on the default Documents tab. The panel value is
// also forwarded to the tab so it can scroll the specific card into
// view (see `PrivacyTab`).
const PANEL_TO_TAB: Record<string, string> = {
  'erasure-storage-failures': 'privacy',
};

export default function GovernancePage() {
  const { data: me } = useGetMe();
  const { org } = useActiveOrgContext();
  const orgId = org?.id ?? (me as unknown as { organizationId?: number })?.organizationId;

  const isAdmin = me?.role === 'org_admin' || me?.role === 'super_admin' || me?.role === 'tournament_director';
  const isCommittee = isAdmin || me?.role === 'committee_member' || me?.role === 'competition_secretary';

  // Read the deep-link `?panel=…` once on mount. We only honour
  // recognised panel ids; an unknown value falls back to the default
  // tab so a stale or hand-edited link doesn't strand the controller
  // on a blank tab.
  const search = useSearch();
  const panel = (() => {
    try {
      return new URLSearchParams(search).get('panel') ?? '';
    } catch {
      return '';
    }
  })();
  const initialTab = PANEL_TO_TAB[panel] ?? 'documents';

  if (!orgId) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] text-muted-foreground">
        <Shield className="w-12 h-12 mb-4 opacity-30" />
        <p>Select an organisation to view governance</p>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white flex items-center gap-2">
          <Shield className="w-6 h-6 text-primary" /> Club Governance
        </h1>
        <p className="text-muted-foreground text-sm mt-1">Documents, notices, committee meetings, and digital voting</p>
      </div>

      <Tabs defaultValue={initialTab} className="space-y-4">
        <TabsList className="bg-white/5 border border-white/10 flex-wrap h-auto gap-1">
          <TabsTrigger value="documents" className="data-[state=active]:bg-primary/20 data-[state=active]:text-primary">
            <FileText className="w-4 h-4 mr-2" /> Documents
          </TabsTrigger>
          <TabsTrigger value="notices" className="data-[state=active]:bg-primary/20 data-[state=active]:text-primary">
            <Bell className="w-4 h-4 mr-2" /> Notices
          </TabsTrigger>
          <TabsTrigger value="meetings" className="data-[state=active]:bg-primary/20 data-[state=active]:text-primary">
            <CalendarDays className="w-4 h-4 mr-2" /> Meetings
          </TabsTrigger>
          <TabsTrigger value="voting" className="data-[state=active]:bg-primary/20 data-[state=active]:text-primary">
            <Vote className="w-4 h-4 mr-2" /> Voting
          </TabsTrigger>
          <TabsTrigger value="privacy" className="data-[state=active]:bg-primary/20 data-[state=active]:text-primary">
            <ShieldCheck className="w-4 h-4 mr-2" /> Privacy
          </TabsTrigger>
        </TabsList>
        <TabsContent value="documents"><DocumentsTab orgId={orgId} isAdmin={isAdmin} /></TabsContent>
        <TabsContent value="notices"><NoticesTab orgId={orgId} isAdmin={isAdmin} /></TabsContent>
        <TabsContent value="meetings"><MeetingsTab orgId={orgId} isAdmin={isAdmin} isCommittee={isCommittee} /></TabsContent>
        <TabsContent value="voting"><VotingTab orgId={orgId} isAdmin={isAdmin} /></TabsContent>
        <TabsContent value="privacy"><PrivacyTab orgId={orgId} initialPanel={panel || undefined} /></TabsContent>
      </Tabs>
    </div>
  );
}

// ─── Privacy / consent-health controller dashboard (Task #381) ────────────
// Shows the club controller (org_admin / membership_secretary) the latest
// consent decision per data category aggregated across all members, plus
// account-deletion requests currently inside the 30-day grace window so the
// controller can intervene before data is erased. DSAR queue depth and
// member-level deep-dive are handled in the Member 360 page.

const CONSENT_CATEGORY_LABELS: Record<string, string> = {
  privacy: 'Privacy policy',
  terms: 'Terms of service',
  marketing: 'Marketing',
  directory: 'Directory listing',
  third_party_share: 'Third-party sharing',
  photo: 'Photography',
  video: 'Video recordings',
  scores: 'Scores & handicap',
  gps: 'On-course GPS',
  health_wellness: 'Health & wellness',
  social: 'Social interactions',
  ai: 'AI personalisation',
};

interface ConsentHealthCategory {
  consentType: string;
  grantedMembers: number;
  withdrawnMembers: number;
  noDecisionMembers: number;
  optInRate: number;
}
interface ConsentHealthResponse {
  totalMembers: number;
  categories: ConsentHealthCategory[];
  accountDeletions: {
    inGrace: number;
    overdue: number;
    rows: Array<{
      id: number; clubMemberId: number; requestedAt: string; dueBy: string | null;
      status: string;
      memberFirstName: string | null; memberLastName: string | null; memberNumber: string | null;
    }>;
  };
  dataExports: {
    pending: number;
    ready: number;
    expired: number;
    failed: number;
    rows: Array<{
      id: number; clubMemberId: number; requestedAt: string; resolvedAt: string | null;
      status: string; artifactUrl: string | null;
      // Task #773: stamped by the daily purge cron when the archive file is
      // actually removed from object storage so the dashboard can show the
      // real removal time, not just the 7-day computed expiry.
      purgedAt: string | null;
      computedStatus: 'pending' | 'ready' | 'expired' | 'failed';
      memberFirstName: string | null; memberLastName: string | null; memberNumber: string | null;
    }>;
  };
}

interface ErasureStorageFailuresResponse {
  count: number;
  totalFailedFiles: number;
  items: Array<{
    clubMemberId: number;
    auditId: number;
    completedAt: string;
    objectStorageFilesFailed: number;
    dataRequestId: number | null;
    memberFirstName: string | null;
    memberLastName: string | null;
    memberNumber: string | null;
    memberDeleted: boolean;
    // Task #1459 — chain of consecutive cron auto-retries for this member's
    // latest failure (resets when a controller manually retries). When
    // `autoRetryExhausted` is true the cron has given up and a controller
    // must act for the cleanup to make progress.
    autoRetryAttempts?: number;
    autoRetryExhausted?: boolean;
    // Task #1795 — true when the latest erasure row is a controller
    // acknowledgement (Task #1460). The carried-forward failed-files
    // count keeps the row on the dashboard but the badge tells
    // controllers a teammate has already triaged it. The reviewer name
    // and free-text note (when present) feed the badge tooltip.
    acknowledged?: boolean;
    acknowledgedAt?: string | null;
    acknowledgedBy?: string | null;
    acknowledgementNote?: string | null;
  }>;
  // Task #973 — retry queue counters surface alongside the per-member list.
  pendingStorageDeletions?: { total: number; exhausted: number };
  // Task #1459 — number of items where the auto-retry chain has hit the cap.
  // Optional so older API revisions still parse cleanly during a rollout.
  autoRetryExhaustedCount?: number;
  // Task #1459 — the cap value the cron + aggregator share, surfaced so the
  // UI can render "n/<cap>" labels without hard-coding the denominator. Falls
  // back to 5 (the current cron value) only if an older API revision omits it.
  autoRetryMaxAttempts?: number;
  // Task #1795 — number of items whose latest erasure row is a controller
  // acknowledgement. Drives the "N hidden" hint next to the toggle and
  // the toggle's default state. Optional so older API revisions still
  // parse cleanly during a rollout.
  acknowledgedCount?: number;
}

// Task #1128 — admin actions on individual stuck pending_storage_deletions rows.
interface PendingStorageDeletionRow {
  id: number;
  clubMemberId: number | null;
  sourceAuditId: number | null;
  path: string;
  attempts: number;
  lastAttemptAt: string | null;
  lastError: string | null;
  nextAttemptAt: string;
  createdAt: string;
  exhausted: boolean;
  // Task #1303 — non-null once the on-call admin alert has fired for this
  // row (Task #1127). Surfaced as an "Alerted at <date>" pill so a
  // triaging admin doesn't re-page the same orphan twice.
  exhaustionNotifiedAt: string | null;
  memberFirstName: string | null;
  memberLastName: string | null;
  memberNumber: string | null;
  memberDeleted: boolean;
}
interface PendingStorageDeletionsResponse {
  count: number;
  onlyExhausted: boolean;
  // Task #1537 — server echoes back the active filters (after trim/cap)
  // so the UI can defensively confirm it's showing the cohort it asked
  // for. Optional so older API revisions still parse cleanly.
  pathPrefix?: string;
  errorContains?: string;
  items: PendingStorageDeletionRow[];
}

// Task #1301 — org-wide audit history of admin force-retry / resolve actions
// on stuck orphan-file rows. Surfaces the trail even after the underlying
// pending_storage_deletions row is gone (resolved) and even when the member
// row was cascade-deleted (clubMemberId null).
interface PendingStorageAuditRow {
  id: number;
  action: 'force_retry' | 'resolve';
  createdAt: string;
  reason: string | null;
  path: string | null;
  attempts: number | null;
  lastError: string | null;
  pendingId: number | null;
  clubMemberId: number | null;
  memberFirstName: string | null;
  memberLastName: string | null;
  memberNumber: string | null;
  memberDeleted: boolean;
  actorUserId: number | null;
  actorName: string | null;
  actorDisplayName: string | null;
  actorUsername: string | null;
  actorEmail: string | null;
  // Task #1893 — true when the row was emitted by one of the bulk
  // admin actions (bulk-retry-now / bulk-resolve). Drives the small
  // "bulk" pill next to the action badge so admins can tell at a
  // glance that a streak of identical-looking rows came from a single
  // bulk click rather than per-row clicks.
  bulk: boolean;
}
// Task #1530 — surfaced alongside the items so the actor dropdown shows
// every admin who has ever performed one of these actions in the org,
// regardless of which filter the admin currently has applied.
interface PendingStorageAuditActor {
  userId: number;
  label: string;
}
interface PendingStorageAuditResponse {
  count: number;
  limit: number;
  items: PendingStorageAuditRow[];
  actors: PendingStorageAuditActor[];
  filters: {
    actorUserId: number | null;
    action: 'force_retry' | 'resolve' | null;
    pathPrefix: string | null;
    from: string | null;
    to: string | null;
  };
  // Task #1894 — opaque cursor of the last (oldest-in-page) row when the
  // first page filled all the way up. Absent / null means there's nothing
  // older to fetch under the current filters. Older API revisions that
  // don't return this field are treated as "no more pages".
  nextCursor?: string | null;
}

// Exported for unit tests (Task #1529) — keeps the rest of the page surface
// private while letting the storage-cleanup audit list be exercised in
// isolation without mounting the whole tabs scaffold.
export function PrivacyTab({ orgId, initialPanel }: { orgId: number; initialPanel?: string }) {
  const { data, isLoading, error, refetch, isFetching } = useQuery<ConsentHealthResponse>({
    queryKey: ['consent-health', orgId],
    queryFn: () => api(`/organizations/${orgId}/members-360/consent-health`),
    enabled: !!orgId,
  });
  // Task #921 — surface members whose erasure left orphan storage files behind.
  // Pulled in parallel with consent health so the warning panel renders even
  // if the consent-health card is still loading.
  const { toast } = useToast();
  const failures = useQuery<ErasureStorageFailuresResponse>({
    queryKey: ['erasure-storage-failures', orgId],
    queryFn: () => api(`/organizations/${orgId}/members-360/erasures/storage-failures`),
    enabled: !!orgId,
  });
  // Task #1795 — controllers can hide acknowledged rows so the dashboard
  // foregrounds members that still need triage. We default to "hidden"
  // so that acknowledged rows (which already have the carry-forward
  // failed-files counter) don't pad the list a controller is scanning
  // for fresh work. The toggle is sticky for the session and the count
  // pill lets the controller see at a glance how many were filtered.
  // Declared at the top of the component so the hook always runs in the
  // same order, even when the early-return loading / error branches below
  // short-circuit the rest of the body.
  const [hideAcknowledged, setHideAcknowledged] = useState(true);
  const retry = useMutation({
    mutationFn: (clubMemberId: number) =>
      api(`/organizations/${orgId}/members-360/${clubMemberId}/erasure-history/retry-storage`, { method: 'POST' }),
    onSuccess: (r: { failed: number; deleted: number; missing: number; storageDisabled: boolean }) => {
      if (r.storageDisabled) {
        toast({ title: 'Object storage not configured', description: 'Cleanup retry skipped — storage backend is unavailable in this environment.', variant: 'destructive' });
      } else if (r.failed > 0) {
        toast({ title: `${r.failed} file${r.failed === 1 ? '' : 's'} still could not be removed`, description: `Cleared ${r.deleted}, ${r.missing} already gone. Check worker logs.`, variant: 'destructive' });
      } else {
        toast({ title: 'Storage cleanup complete', description: `Cleared ${r.deleted} file${r.deleted === 1 ? '' : 's'}, ${r.missing} already gone.` });
      }
      failures.refetch();
      pendingDeletions.refetch();
    },
    onError: (e: Error) => toast({ title: 'Retry failed', description: e.message, variant: 'destructive' }),
  });

  // Task #1128 — fetch the per-row pending_storage_deletions queue so admins
  // can act on individual stuck paths (force retry / mark resolved). Defaults
  // to onlyExhausted=true so the list matches the "exhausted" counter we
  // already surface; the toggle lets an investigating admin see the rest.
  const [showAllPending, setShowAllPending] = useState(false);
  // Task #1537 — admin-driven filters on the stuck-rows list so a bucket
  // migration sweep can target a known prefix (e.g. /objects/migrated-…/)
  // or a specific lastError pattern instead of operating on the full
  // first-500 page. The text inputs are debounced (300ms) into the
  // applied state so each keystroke doesn't trigger a refetch; the
  // queryKey only includes the debounced values so React Query caches
  // them per-cohort. Server-side trim/cap mirrors the client trim, so
  // typing trailing spaces won't poke a fresh request.
  //
  // Task #1903 — persist the applied filters across refreshes by
  // mirroring them into the URL (`?stuckPathPrefix=…&stuckErrorContains=…`)
  // so a multi-day bucket migration doesn't force the admin to retype
  // the same prefix dozens of times. The initial values are seeded from
  // the URL (capped to the same 500 chars the server enforces) and we
  // keep them in sync via `history.replaceState` — the same approach used
  // by the Stripe webhook deliveries filter (Task #1535) so the URL stays
  // shareable without spamming the wouter history stack.
  const initialStuckFilters = (() => {
    if (typeof window === 'undefined') return { pathPrefix: '', errorContains: '' };
    const sp = new URLSearchParams(window.location.search);
    return {
      pathPrefix: (sp.get('stuckPathPrefix') ?? '').slice(0, 500),
      errorContains: (sp.get('stuckErrorContains') ?? '').slice(0, 500),
    };
  })();
  const [pathPrefixInput, setPathPrefixInput] = useState(initialStuckFilters.pathPrefix);
  const [errorContainsInput, setErrorContainsInput] = useState(initialStuckFilters.errorContains);
  const [pathPrefixApplied, setPathPrefixApplied] = useState(initialStuckFilters.pathPrefix.trim());
  const [errorContainsApplied, setErrorContainsApplied] = useState(initialStuckFilters.errorContains.trim());
  useEffect(() => {
    const t = setTimeout(() => {
      setPathPrefixApplied(pathPrefixInput.trim().slice(0, 500));
      setErrorContainsApplied(errorContainsInput.trim().slice(0, 500));
    }, 300);
    return () => clearTimeout(t);
  }, [pathPrefixInput, errorContainsInput]);
  // Mirror the applied filters into the URL so a refresh / shared link
  // reproduces the same view. Drop the param entirely when the filter is
  // empty so the URL stays clean once the admin clicks "Clear filters".
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const sp = new URLSearchParams(window.location.search);
    if (pathPrefixApplied) {
      sp.set('stuckPathPrefix', pathPrefixApplied);
    } else {
      sp.delete('stuckPathPrefix');
    }
    if (errorContainsApplied) {
      sp.set('stuckErrorContains', errorContainsApplied);
    } else {
      sp.delete('stuckErrorContains');
    }
    const qs = sp.toString();
    const newUrl = `${window.location.pathname}${qs ? `?${qs}` : ''}${window.location.hash}`;
    const currentUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (newUrl !== currentUrl) {
      window.history.replaceState(window.history.state, '', newUrl);
    }
  }, [pathPrefixApplied, errorContainsApplied]);
  const pendingDeletions = useQuery<PendingStorageDeletionsResponse>({
    queryKey: ['pending-storage-deletions', orgId, showAllPending, pathPrefixApplied, errorContainsApplied],
    queryFn: () => {
      const params = new URLSearchParams();
      params.set('onlyExhausted', showAllPending ? 'false' : 'true');
      if (pathPrefixApplied) params.set('pathPrefix', pathPrefixApplied);
      if (errorContainsApplied) params.set('errorContains', errorContainsApplied);
      return api(
        `/organizations/${orgId}/members-360/erasures/storage-failures/pending?${params.toString()}`,
      );
    },
    enabled: !!orgId,
  });
  const hasActiveFilter = pathPrefixApplied.length > 0 || errorContainsApplied.length > 0;
  const clearFilters = () => {
    setPathPrefixInput('');
    setErrorContainsInput('');
    setPathPrefixApplied('');
    setErrorContainsApplied('');
  };
  const forceRetry = useMutation({
    mutationFn: (id: number) => api(
      `/organizations/${orgId}/members-360/erasures/storage-failures/pending/${id}/retry-now`,
      { method: 'POST', body: JSON.stringify({}) },
    ),
    onSuccess: () => {
      toast({ title: 'Force-retry scheduled', description: 'The worker will pick up this row on its next tick.' });
      pendingDeletions.refetch();
      failures.refetch();
    },
    onError: (e: Error) => toast({ title: 'Could not force retry', description: e.message, variant: 'destructive' }),
  });
  const [resolveTarget, setResolveTarget] = useState<PendingStorageDeletionRow | null>(null);
  const [resolveReason, setResolveReason] = useState('');
  const resolveMut = useMutation({
    mutationFn: (args: { id: number; reason: string }) => api(
      `/organizations/${orgId}/members-360/erasures/storage-failures/pending/${args.id}/resolve`,
      { method: 'POST', body: JSON.stringify({ reason: args.reason }) },
    ),
    onSuccess: () => {
      toast({ title: 'Stuck row cleared', description: 'Audit trail records who marked it resolved and why.' });
      setResolveTarget(null);
      setResolveReason('');
      pendingDeletions.refetch();
      failures.refetch();
    },
    onError: (e: Error) => toast({ title: 'Could not mark resolved', description: e.message, variant: 'destructive' }),
  });

  // Task #1302 — bulk admin actions on multiple stuck pending_storage_deletions
  // rows. selectedIds is keyed by pending row id; toggling rows that disappear
  // from the list (e.g. after a refetch) is harmless because the bulk mutations
  // intersect with what the server actually sees.
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const visibleRows = pendingDeletions.data?.items ?? [];
  // Reset the selection whenever the underlying items list changes so an
  // admin can't accidentally bulk-resolve a row they couldn't see (e.g.
  // after toggling onlyExhausted or after another admin cleared a row).
  // Depend on the items reference (stable from react-query) rather than
  // the freshly-coalesced array so this effect doesn't run every render.
  const itemsRef = pendingDeletions.data?.items;
  useEffect(() => {
    const visible = new Set((itemsRef ?? []).map(r => r.id));
    setSelectedIds(prev => {
      const next = new Set<number>();
      prev.forEach(id => { if (visible.has(id)) next.add(id); });
      return next.size === prev.size ? prev : next;
    });
  }, [itemsRef]);
  const allVisibleSelected = visibleRows.length > 0
    && visibleRows.every(r => selectedIds.has(r.id));
  const someVisibleSelected = !allVisibleSelected && visibleRows.some(r => selectedIds.has(r.id));
  const toggleRowSelected = (id: number) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const toggleSelectAllVisible = () => {
    setSelectedIds(prev => {
      if (allVisibleSelected) {
        const next = new Set(prev);
        visibleRows.forEach(r => next.delete(r.id));
        return next;
      }
      const next = new Set(prev);
      visibleRows.forEach(r => next.add(r.id));
      return next;
    });
  };
  // Task #1536 — chunked bulk submission so a 500-row sweep doesn't look
  // frozen behind a single multi-second request. We fire BULK_CHUNK_SIZE ids
  // per call sequentially and surface a "X of N done" progress bar in the
  // toolbar / dialog. On a partial failure we keep the un-processed ids
  // selected so the admin can retry only the rest without manually
  // reconstructing which ids made it through.
  const BULK_CHUNK_SIZE = 50;
  type BulkProgress = { processed: number; total: number; action: 'retry' | 'resolve' };
  const [bulkProgress, setBulkProgress] = useState<BulkProgress | null>(null);
  const bulkInFlight = bulkProgress != null;

  const runBulkRetry = useCallback(async (ids: number[]) => {
    if (ids.length === 0 || bulkInFlight) return;
    setBulkProgress({ processed: 0, total: ids.length, action: 'retry' });
    const succeeded: number[] = [];
    let stoppedError: Error | null = null;
    try {
      for (let i = 0; i < ids.length; i += BULK_CHUNK_SIZE) {
        const chunk = ids.slice(i, i + BULK_CHUNK_SIZE);
        const r = await api(
          `/organizations/${orgId}/members-360/erasures/storage-failures/pending/bulk-retry-now`,
          { method: 'POST', body: JSON.stringify({ ids: chunk }) },
        ) as { count: number; ids: number[] };
        succeeded.push(...(r.ids ?? chunk));
        setBulkProgress({ processed: succeeded.length, total: ids.length, action: 'retry' });
      }
    } catch (e) {
      stoppedError = e as Error;
    }
    if (stoppedError) {
      const remaining = ids.filter(id => !succeeded.includes(id));
      toast({
        title: succeeded.length > 0
          ? `Stopped after ${succeeded.length} of ${ids.length} row${ids.length === 1 ? '' : 's'}`
          : 'Could not bulk force-retry',
        description: succeeded.length > 0
          ? `${remaining.length} row${remaining.length === 1 ? '' : 's'} still selected — try again to retry only the rest. (${stoppedError.message})`
          : stoppedError.message,
        variant: 'destructive',
      });
      // Keep failed/un-attempted ids selected so the next click only sweeps those.
      setSelectedIds(new Set(remaining));
    } else {
      toast({
        title: `Force-retry scheduled for ${succeeded.length} row${succeeded.length === 1 ? '' : 's'}`,
        description: 'The worker will pick them up on its next tick.',
      });
      setSelectedIds(new Set());
    }
    setBulkProgress(null);
    pendingDeletions.refetch();
    failures.refetch();
    auditLog.refetch();
  // pendingDeletions/failures/auditLog refetch refs change every render, so
  // we deliberately leave them out of the dep list.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId, toast, bulkInFlight]);

  const [bulkResolveOpen, setBulkResolveOpen] = useState(false);
  const [bulkResolveReason, setBulkResolveReason] = useState('');
  const runBulkResolve = useCallback(async (ids: number[], reason: string) => {
    if (ids.length === 0 || reason.trim().length === 0 || bulkInFlight) return;
    setBulkProgress({ processed: 0, total: ids.length, action: 'resolve' });
    const succeeded: number[] = [];
    let stoppedError: Error | null = null;
    try {
      for (let i = 0; i < ids.length; i += BULK_CHUNK_SIZE) {
        const chunk = ids.slice(i, i + BULK_CHUNK_SIZE);
        const r = await api(
          `/organizations/${orgId}/members-360/erasures/storage-failures/pending/bulk-resolve`,
          { method: 'POST', body: JSON.stringify({ ids: chunk, reason }) },
        ) as { count: number; ids: number[] };
        succeeded.push(...(r.ids ?? chunk));
        setBulkProgress({ processed: succeeded.length, total: ids.length, action: 'resolve' });
      }
    } catch (e) {
      stoppedError = e as Error;
    }
    if (stoppedError) {
      const remaining = ids.filter(id => !succeeded.includes(id));
      toast({
        title: succeeded.length > 0
          ? `Cleared ${succeeded.length} of ${ids.length} row${ids.length === 1 ? '' : 's'}, then stopped`
          : 'Could not bulk mark resolved',
        description: succeeded.length > 0
          ? `${remaining.length} row${remaining.length === 1 ? '' : 's'} still selected — re-open the dialog to mark only the rest. (${stoppedError.message})`
          : stoppedError.message,
        variant: 'destructive',
      });
      // Leave the dialog open with the same reason so the admin can retry
      // immediately. Selection now only contains the un-processed ids.
      setSelectedIds(new Set(remaining));
    } else {
      toast({
        title: `Cleared ${succeeded.length} stuck row${succeeded.length === 1 ? '' : 's'}`,
        description: 'Audit trail records who marked them resolved and why (one entry per row).',
      });
      setBulkResolveOpen(false);
      setBulkResolveReason('');
      setSelectedIds(new Set());
    }
    setBulkProgress(null);
    pendingDeletions.refetch();
    failures.refetch();
    auditLog.refetch();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId, toast, bulkInFlight]);

  // Task #1301 — org-wide history of who force-retried / resolved which row.
  // Refetched whenever an admin successfully runs an action so the audit list
  // updates without a page reload. Collapsed by default; the count badge in
  // the header is visible whether or not the body is expanded.
  const [showAuditLog, setShowAuditLog] = useState(false);
  // Task #1530 — server-side filters so the 50/200-row cap stays meaningful as
  // an org accumulates weeks of activity. Sentinel "all" keeps the Select
  // component happy (Radix Select dislikes empty-string values) and is
  // translated to an absent query param when building the URL.
  const [auditActorFilter, setAuditActorFilter] = useState<string>('all');
  const [auditActionFilter, setAuditActionFilter] = useState<'all' | 'force_retry' | 'resolve'>('all');
  // Path filter has a draft input + a debounced applied value so keystrokes
  // don't fire a request per character. The Apply button (and Enter) both
  // commit the draft.
  const [auditPathDraft, setAuditPathDraft] = useState('');
  const [auditPathFilter, setAuditPathFilter] = useState('');
  // Task #1895 — from/to date range, applied server-side against
  // member_audit_log.created_at. Bare YYYY-MM-DD strings (the native
  // <input type="date"> format); the API treats `from` as start-of-day
  // and `to` as end-of-day in UTC so an admin asking for "last week" gets
  // the whole window inclusive of both endpoints.
  const [auditFromFilter, setAuditFromFilter] = useState('');
  const [auditToFilter, setAuditToFilter] = useState('');
  const auditQueryString = (() => {
    const p = new URLSearchParams();
    p.set('limit', '50');
    if (auditActorFilter !== 'all') p.set('actorUserId', auditActorFilter);
    if (auditActionFilter !== 'all') p.set('action', auditActionFilter);
    if (auditPathFilter.trim().length > 0) p.set('pathPrefix', auditPathFilter.trim());
    if (auditFromFilter.trim().length > 0) p.set('from', auditFromFilter.trim());
    if (auditToFilter.trim().length > 0) p.set('to', auditToFilter.trim());
    return p.toString();
  })();
  const auditFiltersActive = auditActorFilter !== 'all'
    || auditActionFilter !== 'all'
    || auditPathFilter.trim().length > 0
    || auditFromFilter.trim().length > 0
    || auditToFilter.trim().length > 0;
  const auditLog = useQuery<PendingStorageAuditResponse>({
    queryKey: ['pending-storage-audit-log', orgId, auditActorFilter, auditActionFilter, auditPathFilter, auditFromFilter, auditToFilter],
    queryFn: () => api(`/organizations/${orgId}/members-360/erasures/storage-failures/audit-log?${auditQueryString}`),
    enabled: !!orgId,
  });
  // Task #1894 — accumulator for "Load older" pages. We deliberately keep
  // these out of the react-query cache because the older pages are an
  // append-only continuation of the first page (which IS cached) and we
  // want them blown away the moment a filter changes — caching them by a
  // composite key would leak state across filter combinations the admin
  // hasn't asked for. Reset whenever the filter tuple, org, or the first
  // page itself reloads (refetch / refetchOnWindowFocus).
  const [olderAuditItems, setOlderAuditItems] = useState<PendingStorageAuditRow[]>([]);
  const [olderAuditCursor, setOlderAuditCursor] = useState<string | null>(null);
  const [olderAuditLoading, setOlderAuditLoading] = useState(false);
  const [olderAuditError, setOlderAuditError] = useState<string | null>(null);
  // dataUpdatedAt is the react-query "this query was just resolved" stamp.
  // Resetting on it covers refetch() AND background re-fetches (e.g. from
  // a successful mutation calling auditLog.refetch()) so the older list
  // never points at a now-stale cursor.
  const auditFirstPageStamp = auditLog.dataUpdatedAt;
  useEffect(() => {
    setOlderAuditItems([]);
    setOlderAuditCursor(auditLog.data?.nextCursor ?? null);
    setOlderAuditError(null);
  }, [orgId, auditActorFilter, auditActionFilter, auditPathFilter, auditFirstPageStamp, auditLog.data?.nextCursor]);
  const loadOlderAudit = useCallback(async () => {
    if (!orgId || !olderAuditCursor || olderAuditLoading) return;
    setOlderAuditLoading(true);
    setOlderAuditError(null);
    try {
      const p = new URLSearchParams();
      p.set('limit', '50');
      if (auditActorFilter !== 'all') p.set('actorUserId', auditActorFilter);
      if (auditActionFilter !== 'all') p.set('action', auditActionFilter);
      if (auditPathFilter.trim().length > 0) p.set('pathPrefix', auditPathFilter.trim());
      p.set('cursor', olderAuditCursor);
      const r = await api(
        `/organizations/${orgId}/members-360/erasures/storage-failures/audit-log?${p.toString()}`,
      ) as PendingStorageAuditResponse;
      setOlderAuditItems(prev => [...prev, ...r.items]);
      setOlderAuditCursor(r.nextCursor ?? null);
    } catch (e) {
      setOlderAuditError((e as Error).message);
    } finally {
      setOlderAuditLoading(false);
    }
  }, [orgId, olderAuditCursor, olderAuditLoading, auditActorFilter, auditActionFilter, auditPathFilter]);
  const resetAuditFilters = () => {
    setAuditActorFilter('all');
    setAuditActionFilter('all');
    setAuditPathDraft('');
    setAuditPathFilter('');
    setAuditFromFilter('');
    setAuditToFilter('');
  };
  // Tack onto the existing mutations' onSuccess by way of a side-effect: the
  // mutations already call pendingDeletions.refetch(); we mirror that here so
  // freshly-written audit rows show up immediately. The Task #1302 bulk
  // actions (now Task #1536's chunked runners) refetch the audit log
  // themselves once the whole batch finishes.
  useEffect(() => {
    if (forceRetry.isSuccess || resolveMut.isSuccess) {
      auditLog.refetch();
    }
    // Intentionally only react to the success edges.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [forceRetry.isSuccess, resolveMut.isSuccess]);

  // Task #1770 — when the controller arrives via the digest deep link
  // `/privacy?panel=erasure-storage-failures` (also reused by the
  // in-app inbox row and the home dashboard backlog widget), scroll
  // the stuck-erasures card into view as soon as it has rendered. We
  // wait on `failures.isFetched` because the rose card is rendered
  // conditionally on `failures.data.count > 0`; if it's the empty
  // state we skip the scroll entirely (the privacy tab is short
  // enough that there's nothing meaningful to scroll to). We only run
  // this once per mount so manual scrolling later doesn't get yanked
  // back.
  useEffect(() => {
    if (initialPanel !== 'erasure-storage-failures') return;
    if (!failures.isFetched) return;
    if ((failures.data?.count ?? 0) === 0) return;
    // Defer to the next tick so the card has actually attached to
    // the DOM (TabsContent mounts its children lazily on first
    // activation).
    const timer = setTimeout(() => {
      const el = document.querySelector('[data-testid="erasure-storage-failures-card"]');
      if (el && typeof (el as HTMLElement).scrollIntoView === 'function') {
        (el as HTMLElement).scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    }, 0);
    return () => clearTimeout(timer);
    // Intentionally only react to the panel param + first fetch
    // resolution. Re-running on every re-fetch would yank the
    // controller back to the top after they've scrolled away to
    // triage a row.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPanel, failures.isFetched]);

  if (isLoading) {
    return <div className="text-muted-foreground text-sm py-8 text-center">Loading consent health…</div>;
  }
  if (error || !data) {
    return (
      <div className="text-rose-300 text-sm py-8 text-center">
        Could not load consent health.{' '}
        <Button variant="ghost" size="sm" onClick={() => refetch()}>Retry</Button>
      </div>
    );
  }

  const failureItems = failures.data?.items ?? [];
  const acknowledgedCount = failures.data?.acknowledgedCount
    ?? failureItems.reduce((s, i) => s + (i.acknowledged ? 1 : 0), 0);
  const visibleFailureItems = hideAcknowledged
    ? failureItems.filter(i => !i.acknowledged)
    : failureItems;
  return (
    <div className="space-y-6" data-testid="privacy-tab">
      {failures.data && failures.data.count > 0 && (
        <Card
          className="border-rose-500/40 bg-rose-500/10"
          data-testid="erasure-storage-failures-card"
        >
          <CardHeader className="pb-3">
            <CardTitle className="text-white text-base flex items-center justify-between gap-2">
              <span className="flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-rose-300" />
                Erasures with stuck storage cleanup
                <Badge
                  variant="destructive"
                  className="ml-2"
                  data-testid="erasure-storage-failures-count"
                >
                  {failures.data.count}
                </Badge>
              </span>
              <div className="flex items-center gap-2">
                {/* Task #1795 — let controllers hide already-acknowledged
                    members so the dashboard foregrounds rows that still
                    need triage. The toggle only renders when there's
                    something to hide; the count next to the label tells
                    the controller how many are currently filtered out. */}
                {acknowledgedCount > 0 && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setHideAcknowledged(v => !v)}
                    data-testid="erasure-storage-failures-toggle-acknowledged"
                  >
                    {hideAcknowledged
                      ? `Show acknowledged (${acknowledgedCount})`
                      : `Hide acknowledged (${acknowledgedCount})`}
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => failures.refetch()}
                  disabled={failures.isFetching}
                  data-testid="erasure-storage-failures-refresh"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${failures.isFetching ? 'animate-spin' : ''}`} />
                </Button>
              </div>
            </CardTitle>
            <p className="text-xs text-rose-100/80 mt-1">
              {failures.data.totalFailedFiles} object-storage file
              {failures.data.totalFailedFiles === 1 ? '' : 's'} could not be removed during the
              account-erasure cron. Re-run cleanup for each affected member or check the worker logs.
            </p>
            {/* Task #1459 — panel-level banner so a controller scanning the
                privacy tab can see at a glance how many members the
                bounded auto-retry has fully given up on. The banner only
                renders when there's something to escalate; the per-row
                badges below provide the same signal in detail. */}
            {(failures.data.autoRetryExhaustedCount ?? 0) > 0 && (
              <div
                className="mt-3 flex items-center gap-2 rounded-md border border-rose-400/60 bg-rose-500/20 px-3 py-2"
                data-testid="erasure-storage-needs-action-banner"
              >
                <AlertTriangle className="w-4 h-4 text-rose-200 shrink-0" />
                <p className="text-xs text-rose-50">
                  <strong data-testid="erasure-storage-needs-action-count">
                    {failures.data.autoRetryExhaustedCount}
                  </strong>{' '}
                  member{failures.data.autoRetryExhaustedCount === 1 ? '' : 's'} need
                  {failures.data.autoRetryExhaustedCount === 1 ? 's' : ''} your action — auto-retry
                  has been exhausted and the cron will not try again until you manually re-run
                  cleanup.
                </p>
              </div>
            )}
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {visibleFailureItems.length === 0 && acknowledgedCount > 0 && hideAcknowledged && (
                // All remaining rows are acknowledged. Surface a tiny empty
                // state pointing at the toggle so the controller doesn't
                // think the panel is broken when the count badge in the
                // header still shows >0.
                <p
                  className="text-xs text-rose-100/70 italic px-1"
                  data-testid="erasure-storage-failures-all-acknowledged"
                >
                  All {acknowledgedCount} stuck row{acknowledgedCount === 1 ? ' is' : 's are'}{' '}
                  acknowledged. Use “Show acknowledged” above to review them.
                </p>
              )}
              {visibleFailureItems.map(it => {
                const name = [it.memberFirstName, it.memberLastName].filter(Boolean).join(' ')
                  || `Member #${it.clubMemberId}`;
                // Task #1795 — tooltip surfaces the reviewer + their note so
                // the controller can see triage context without leaving the
                // dashboard. Falls back gracefully when the reviewer name or
                // note is missing (older acknowledgements predate the actor
                // capture, and the note is optional).
                const ackTooltip = it.acknowledged
                  ? [
                      it.acknowledgedBy
                        ? `Acknowledged by ${it.acknowledgedBy}`
                        : 'Acknowledged by a controller',
                      it.acknowledgedAt
                        ? `on ${new Date(it.acknowledgedAt).toLocaleString()}`
                        : null,
                      it.acknowledgementNote
                        ? `— ${it.acknowledgementNote}`
                        : null,
                    ].filter(Boolean).join(' ')
                  : undefined;
                return (
                  <div
                    key={it.auditId}
                    className={`flex items-center justify-between gap-3 rounded-lg border p-3 ${
                      it.acknowledged
                        ? 'border-emerald-500/30 bg-emerald-500/5'
                        : 'border-rose-500/30 bg-black/20'
                    }`}
                    data-testid={`erasure-storage-failure-${it.clubMemberId}`}
                    data-acknowledged={it.acknowledged ? 'true' : 'false'}
                  >
                    <div className="text-sm">
                      <div className="text-white font-medium flex items-center gap-2 flex-wrap">
                        {name}
                        {it.memberNumber ? (
                          <span className="text-muted-foreground">#{it.memberNumber}</span>
                        ) : null}
                        {it.memberDeleted && (
                          <Badge variant="outline" className="border-white/20 text-white/60 text-[10px]">
                            row removed
                          </Badge>
                        )}
                        {/* Task #1795 — visual cue that a teammate already
                            triaged this row (tooltip carries the reviewer
                            name + free-text note from the audit row). */}
                        {it.acknowledged && (
                          <Badge
                            variant="outline"
                            className="border-emerald-300/40 text-emerald-100 text-[10px]"
                            title={ackTooltip}
                            data-testid={`erasure-storage-acknowledged-${it.clubMemberId}`}
                          >
                            Acknowledged{it.acknowledgedBy ? ` · ${it.acknowledgedBy}` : ''}
                          </Badge>
                        )}
                        {/* Task #1459 — auto-retry chain status. The cron has
                            either given up (cap reached) and needs a manual
                            re-run to make progress, or it's still walking the
                            backoff schedule between attempts. The badge
                            distinguishes the two so a controller skimming the
                            list can triage exhausted rows first instead of
                            waiting on a digest the next day. */}
                        {it.autoRetryExhausted ? (
                          <Badge
                            variant="destructive"
                            className="text-[10px]"
                            title={`The bounded auto-retry has run ${it.autoRetryAttempts ?? 0} consecutive attempts on this member without success. The cron will not try again until you manually re-run cleanup.`}
                            data-testid={`erasure-storage-auto-retry-exhausted-${it.clubMemberId}`}
                          >
                            auto-retry exhausted — needs your action
                          </Badge>
                        ) : (it.autoRetryAttempts ?? 0) > 0 ? (
                          <Badge
                            variant="outline"
                            className="border-amber-300/40 text-amber-100 text-[10px]"
                            title={`The bounded auto-retry has tried ${it.autoRetryAttempts} time${it.autoRetryAttempts === 1 ? '' : 's'} so far. Another attempt will run automatically once the next backoff window elapses.`}
                            data-testid={`erasure-storage-auto-retry-inflight-${it.clubMemberId}`}
                          >
                            auto-retry in progress ({it.autoRetryAttempts}/{failures.data.autoRetryMaxAttempts ?? 5})
                          </Badge>
                        ) : null}
                      </div>
                      <div className="text-xs text-rose-100/70">
                        Last erased {new Date(it.completedAt).toLocaleString()} ·{' '}
                        {it.objectStorageFilesFailed} file
                        {it.objectStorageFilesFailed === 1 ? '' : 's'} failed
                        {it.dataRequestId ? ` · request #${it.dataRequestId}` : ''}
                      </div>
                      {/* Task #1795 — show the acknowledgement note inline
                          beneath the row so it's visible without hovering
                          the badge tooltip (tooltips don't help on touch
                          devices). Truncated to one line — the full text
                          stays available in the badge's title attribute. */}
                      {it.acknowledged && it.acknowledgementNote && (
                        <div
                          className="text-xs text-emerald-100/80 mt-1 italic truncate max-w-prose"
                          data-testid={`erasure-storage-acknowledged-note-${it.clubMemberId}`}
                          title={it.acknowledgementNote}
                        >
                          “{it.acknowledgementNote}”
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {it.memberDeleted ? (
                        // The club_members row is gone (cascade) so the
                        // per-member API + 360 page would 404 — surface
                        // explicit operator-review text instead of a button
                        // that could only fail.
                        <span
                          className="text-xs text-amber-200 italic whitespace-nowrap"
                          data-testid={`erasure-storage-operator-review-${it.clubMemberId}`}
                        >
                          operator review required
                        </span>
                      ) : (
                        <>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => retry.mutate(it.clubMemberId)}
                            disabled={retry.isPending && retry.variables === it.clubMemberId}
                            data-testid={`erasure-storage-retry-${it.clubMemberId}`}
                          >
                            <RotateCw className={`w-3.5 h-3.5 mr-1 ${retry.isPending && retry.variables === it.clubMemberId ? 'animate-spin' : ''}`} />
                            Re-run cleanup
                          </Button>
                          <Link
                            href={`/member-360/${it.clubMemberId}`}
                            className="text-xs text-sky-300 hover:text-sky-100 underline whitespace-nowrap"
                            data-testid={`erasure-storage-open-${it.clubMemberId}`}
                          >
                            Open
                          </Link>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Task #1128 — per-row admin actions for the orphan-file retry queue. */}
      {pendingDeletions.data && (pendingDeletions.data.count > 0 || showAllPending || hasActiveFilter) && (
        <Card
          className="border-amber-500/40 bg-amber-500/10"
          data-testid="pending-storage-deletions-card"
        >
          <CardHeader className="pb-3">
            <CardTitle className="text-white text-base flex items-center justify-between gap-2">
              <span className="flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-amber-300" />
                Stuck orphan-file rows
                <Badge
                  variant="outline"
                  className="ml-2 border-amber-300/40 text-amber-100"
                  data-testid="pending-storage-deletions-count"
                >
                  {pendingDeletions.data.count}
                </Badge>
              </span>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setShowAllPending(v => !v)}
                  data-testid="pending-storage-deletions-toggle"
                >
                  {showAllPending ? 'Show only exhausted' : 'Show all pending'}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => pendingDeletions.refetch()}
                  disabled={pendingDeletions.isFetching}
                  data-testid="pending-storage-deletions-refresh"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${pendingDeletions.isFetching ? 'animate-spin' : ''}`} />
                </Button>
              </div>
            </CardTitle>
            <p className="text-xs text-amber-100/80 mt-1">
              Each row is one orphan file the auto-retry worker is still chasing. Force-retry resets
              the next-attempt clock so the worker picks it up immediately. Mark resolved if you've
              confirmed the path is genuinely gone (out-of-band delete, bucket migration) — this
              records who cleared it and why in the audit trail.
            </p>
            {/* Task #1537 — search box drives the API filters so an admin
                running a bucket-migration sweep can target a known cohort
                (e.g. /objects/migrated-2026-04/) before pressing the bulk
                action. Bulk actions still operate on the currently
                filtered + selected rows because the selection auto-resets
                whenever the items list reference changes. */}
            <div
              className="mt-3 flex flex-wrap items-end gap-2"
              data-testid="pending-storage-deletions-filters"
            >
              <div className="flex flex-col gap-1 min-w-[16rem] flex-1">
                <Label
                  htmlFor="pending-storage-path-prefix"
                  className="text-xs text-amber-100/70"
                >
                  Path starts with
                </Label>
                <Input
                  id="pending-storage-path-prefix"
                  type="search"
                  placeholder="/objects/migrated-2026-04/"
                  value={pathPrefixInput}
                  onChange={e => setPathPrefixInput(e.target.value)}
                  className="h-8 text-xs font-mono bg-black/30 border-amber-500/30 text-amber-50 placeholder:text-amber-100/40"
                  data-testid="pending-storage-filter-path-prefix"
                  maxLength={500}
                />
              </div>
              <div className="flex flex-col gap-1 min-w-[16rem] flex-1">
                <Label
                  htmlFor="pending-storage-error-contains"
                  className="text-xs text-amber-100/70"
                >
                  Last error contains
                </Label>
                <Input
                  id="pending-storage-error-contains"
                  type="search"
                  placeholder="TimeoutError"
                  value={errorContainsInput}
                  onChange={e => setErrorContainsInput(e.target.value)}
                  className="h-8 text-xs bg-black/30 border-amber-500/30 text-amber-50 placeholder:text-amber-100/40"
                  data-testid="pending-storage-filter-error-contains"
                  maxLength={500}
                />
              </div>
              {hasActiveFilter && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={clearFilters}
                  className="h-8 text-xs text-amber-100/80 hover:text-amber-50"
                  data-testid="pending-storage-filter-clear"
                >
                  Clear filters
                </Button>
              )}
            </div>
          </CardHeader>
          <CardContent>
            {pendingDeletions.data.items.length === 0 ? (
              <p className="text-sm text-amber-100/70" data-testid="pending-storage-deletions-empty">
                No pending rows to show.
              </p>
            ) : (
              <>
                {/* Task #1302 — bulk-action toolbar. Select-all sits in the toolbar
                    (not a table header) because the list is rendered as cards, not
                    a real table; the visible aria-checked state still uses an
                    indeterminate tri-state when only some rows are selected. */}
                <div
                  className="rounded-md border border-amber-500/20 bg-black/30 px-3 py-2 mb-3"
                  data-testid="pending-storage-bulk-toolbar"
                >
                  <div className="flex items-center justify-between gap-2">
                    <label className="flex items-center gap-2 text-xs text-amber-100/90 cursor-pointer">
                      <Checkbox
                        checked={allVisibleSelected ? true : someVisibleSelected ? 'indeterminate' : false}
                        onCheckedChange={() => toggleSelectAllVisible()}
                        disabled={bulkInFlight}
                        data-testid="pending-storage-bulk-select-all"
                        aria-label="Select all visible stuck rows"
                      />
                      <span data-testid="pending-storage-bulk-selected-count">
                        {selectedIds.size} of {visibleRows.length} selected
                      </span>
                    </label>
                    <div className="flex items-center gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={selectedIds.size === 0 || bulkInFlight}
                        onClick={() => runBulkRetry(Array.from(selectedIds))}
                        data-testid="pending-storage-bulk-force-retry"
                      >
                        <RotateCw className={`w-3.5 h-3.5 mr-1 ${bulkProgress?.action === 'retry' ? 'animate-spin' : ''}`} />
                        Force retry selected
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-rose-200 hover:text-rose-100"
                        disabled={selectedIds.size === 0 || bulkInFlight}
                        onClick={() => { setBulkResolveOpen(true); setBulkResolveReason(''); }}
                        data-testid="pending-storage-bulk-resolve"
                      >
                        <Trash2 className="w-3.5 h-3.5 mr-1" />
                        Mark selected resolved
                      </Button>
                    </div>
                  </div>
                  {/* Task #1536 — chunked-progress affordance. Only shows
                      while a bulk action is in-flight; lets an admin watch
                      a 500-row sweep tick across without thinking the UI
                      is frozen. The dialog also embeds its own copy for
                      bulk-resolve so progress is visible without dismissing
                      the modal. */}
                  {bulkProgress && (
                    <div
                      className="mt-2 space-y-1"
                      data-testid={`pending-storage-bulk-progress-${bulkProgress.action}`}
                      role="status"
                      aria-live="polite"
                    >
                      <div className="flex items-center justify-between text-[11px] text-amber-100/90">
                        <span>
                          {bulkProgress.action === 'retry' ? 'Force-retrying' : 'Marking resolved'}
                          {' — '}
                          <span data-testid="pending-storage-bulk-progress-text">
                            {bulkProgress.processed} of {bulkProgress.total} done
                          </span>
                        </span>
                        <span>
                          {Math.round((bulkProgress.processed / Math.max(bulkProgress.total, 1)) * 100)}%
                        </span>
                      </div>
                      <Progress
                        value={(bulkProgress.processed / Math.max(bulkProgress.total, 1)) * 100}
                        className="h-1.5 bg-amber-900/40"
                      />
                    </div>
                  )}
                </div>
              <div className="space-y-2">
                {pendingDeletions.data.items.map(row => {
                  const name = [row.memberFirstName, row.memberLastName].filter(Boolean).join(' ')
                    || (row.clubMemberId != null ? `Member #${row.clubMemberId}` : 'Member row removed');
                  const isRetrying = forceRetry.isPending && forceRetry.variables === row.id;
                  const isSelected = selectedIds.has(row.id);
                  return (
                    <div
                      key={row.id}
                      className="flex items-start justify-between gap-3 rounded-lg border border-amber-500/30 bg-black/20 p-3"
                      data-testid={`pending-storage-row-${row.id}`}
                    >
                      <div className="pt-0.5 shrink-0">
                        <Checkbox
                          checked={isSelected}
                          onCheckedChange={() => toggleRowSelected(row.id)}
                          data-testid={`pending-storage-row-select-${row.id}`}
                          aria-label={`Select row ${row.id}`}
                        />
                      </div>
                      <div className="text-sm min-w-0 flex-1">
                        <div className="text-white font-medium flex items-center gap-2 flex-wrap">
                          <span className="truncate">{name}</span>
                          {row.memberNumber ? (
                            <span className="text-muted-foreground">#{row.memberNumber}</span>
                          ) : null}
                          {row.exhausted && (
                            <Badge
                              variant="destructive"
                              className="text-[10px]"
                              data-testid={`pending-storage-row-exhausted-${row.id}`}
                            >
                              exhausted ({row.attempts} attempts)
                            </Badge>
                          )}
                          {!row.exhausted && (
                            <Badge variant="outline" className="border-white/20 text-white/70 text-[10px]">
                              {row.attempts} attempt{row.attempts === 1 ? '' : 's'}
                            </Badge>
                          )}
                          {row.memberDeleted && (
                            <Badge variant="outline" className="border-white/20 text-white/60 text-[10px]">
                              member row removed
                            </Badge>
                          )}
                          {/* Task #1303 — show that admins were already paged for this row
                              so a second on-call doesn't escalate the same orphan twice. */}
                          {row.exhaustionNotifiedAt && (
                            <Badge
                              variant="outline"
                              className="border-sky-300/40 text-sky-100 text-[10px]"
                              title={`On-call admins were paged when this row first crossed the exhaustion threshold (${new Date(row.exhaustionNotifiedAt).toLocaleString()}).`}
                              data-testid={`pending-storage-row-alerted-${row.id}`}
                            >
                              Alerted at {new Date(row.exhaustionNotifiedAt).toLocaleString()}
                            </Badge>
                          )}
                        </div>
                        <div className="text-xs text-amber-100/80 mt-1 font-mono break-all" data-testid={`pending-storage-row-path-${row.id}`}>
                          {row.path}
                        </div>
                        <div className="text-xs text-amber-100/60 mt-1">
                          Next attempt {new Date(row.nextAttemptAt).toLocaleString()}
                          {row.lastAttemptAt ? ` · last tried ${new Date(row.lastAttemptAt).toLocaleString()}` : ''}
                        </div>
                        {row.lastError && (
                          <div
                            className="text-xs text-rose-200/90 mt-1 break-all"
                            data-testid={`pending-storage-row-error-${row.id}`}
                          >
                            Last error: {row.lastError}
                          </div>
                        )}
                      </div>
                      <div className="flex flex-col items-end gap-2 shrink-0">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => forceRetry.mutate(row.id)}
                          disabled={isRetrying}
                          data-testid={`pending-storage-force-retry-${row.id}`}
                        >
                          <RotateCw className={`w-3.5 h-3.5 mr-1 ${isRetrying ? 'animate-spin' : ''}`} />
                          Force retry now
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-rose-200 hover:text-rose-100"
                          onClick={() => { setResolveTarget(row); setResolveReason(''); }}
                          data-testid={`pending-storage-resolve-${row.id}`}
                        >
                          <Trash2 className="w-3.5 h-3.5 mr-1" />
                          Mark resolved
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
              </>
            )}
          </CardContent>
        </Card>
      )}

      {/* Task #1301 — collapsible org-wide history of admin force-retry / resolve
          actions on stuck orphan-file rows. Always rendered (even when zero) so
          admins can confirm "no recent actions" rather than wondering whether
          the panel is missing. */}
      {auditLog.data && (
        <Card
          className="bg-white/5 border-white/10"
          data-testid="pending-storage-audit-log-card"
        >
          <CardHeader className="pb-3">
            <CardTitle className="text-white text-base flex items-center justify-between gap-2">
              <span className="flex items-center gap-2">
                <Clock className="w-4 h-4 text-sky-300" />
                Recent storage-cleanup admin actions
                {/* Task #1894 — count includes any pages already loaded via
                    "Load older" so the badge reflects what's actually on
                    screen, not just the latest page. */}
                <Badge
                  variant="outline"
                  className="ml-2 border-white/20 text-white/70"
                  data-testid="pending-storage-audit-log-count"
                >
                  {auditLog.data.count + olderAuditItems.length}
                </Badge>
              </span>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => auditLog.refetch()}
                  disabled={auditLog.isFetching}
                  data-testid="pending-storage-audit-log-refresh"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${auditLog.isFetching ? 'animate-spin' : ''}`} />
                </Button>
                {/* Task #1896 — opens the CSV variant of the audit-log
                    endpoint in a new tab so the browser handles the
                    download attachment. We pass the same filter triple
                    the in-page list is using so the CSV is always a
                    faithful export of what the admin is currently
                    looking at. The audit-log endpoint itself enforces
                    auth via the shared session cookie, so the new tab
                    inherits credentials automatically. */}
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    const p = new URLSearchParams();
                    if (auditActorFilter !== 'all') p.set('actorUserId', auditActorFilter);
                    if (auditActionFilter !== 'all') p.set('action', auditActionFilter);
                    if (auditPathFilter.trim().length > 0) p.set('pathPrefix', auditPathFilter.trim());
                    const qs = p.toString();
                    const url = `${BASE}/api/organizations/${orgId}/members-360/erasures/storage-failures/audit-log.csv${qs ? `?${qs}` : ''}`;
                    window.open(url, '_blank', 'noopener');
                  }}
                  data-testid="pending-storage-audit-log-download-csv"
                  title="Download the filtered audit list as CSV"
                >
                  <Download className="w-3.5 h-3.5 mr-1" /> CSV
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setShowAuditLog(v => !v)}
                  data-testid="pending-storage-audit-log-toggle"
                >
                  {showAuditLog ? (
                    <><ChevronUp className="w-3.5 h-3.5 mr-1" /> Hide</>
                  ) : (
                    <><ChevronDown className="w-3.5 h-3.5 mr-1" /> Show</>
                  )}
                </Button>
              </div>
            </CardTitle>
            <p className="text-xs text-muted-foreground mt-1">
              {/* Task #1894 — once the admin pages back, "Last 50" is no
                  longer the whole story; the description grows to reflect
                  that older pages are visible too. */}
              {olderAuditItems.length > 0
                ? `Showing ${auditLog.data.count + olderAuditItems.length} force-retry / resolve actions across the org`
                : `Last ${auditLog.data.limit} force-retry / resolve actions across the org`}
              . Includes actions on rows whose member was already cascade-deleted.
              {auditFiltersActive && (
                <span
                  className="ml-2 text-sky-300"
                  data-testid="pending-storage-audit-log-filtered-note"
                >
                  Filters applied — showing matching subset.
                </span>
              )}
            </p>
          </CardHeader>
          {showAuditLog && (
            <CardContent>
              {/* Task #1530 — server-side filters so admins can confirm
                  patterns (e.g. one admin repeatedly clearing rows from the
                  same migration) without manually scanning the whole list. */}
              <div
                className="flex flex-wrap items-end gap-3 mb-4 p-3 rounded-md border border-white/10 bg-black/20"
                data-testid="pending-storage-audit-log-filters"
              >
                <div className="flex-1 min-w-[180px]">
                  <Label className="text-xs text-muted-foreground mb-1 block">
                    Admin
                  </Label>
                  <Select
                    value={auditActorFilter}
                    onValueChange={setAuditActorFilter}
                  >
                    <SelectTrigger
                      className="bg-white/5 border-white/10 h-9"
                      data-testid="pending-storage-audit-log-filter-actor"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All admins</SelectItem>
                      {auditLog.data.actors.map(a => (
                        <SelectItem
                          key={a.userId}
                          value={String(a.userId)}
                          data-testid={`pending-storage-audit-log-filter-actor-option-${a.userId}`}
                        >
                          {a.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex-1 min-w-[160px]">
                  <Label className="text-xs text-muted-foreground mb-1 block">
                    Action
                  </Label>
                  <Select
                    value={auditActionFilter}
                    onValueChange={(v) => setAuditActionFilter(v as 'all' | 'force_retry' | 'resolve')}
                  >
                    <SelectTrigger
                      className="bg-white/5 border-white/10 h-9"
                      data-testid="pending-storage-audit-log-filter-action"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All actions</SelectItem>
                      <SelectItem value="force_retry">Force retry</SelectItem>
                      <SelectItem value="resolve">Resolved</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex-[2] min-w-[220px]">
                  <Label className="text-xs text-muted-foreground mb-1 block">
                    Path prefix <span className="text-white/40">(matches start of path, case-insensitive)</span>
                  </Label>
                  <div className="flex gap-2">
                    <Input
                      value={auditPathDraft}
                      onChange={e => setAuditPathDraft(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter') setAuditPathFilter(auditPathDraft);
                      }}
                      placeholder="e.g. members/2024-migration/"
                      className="bg-white/5 border-white/10 h-9 font-mono text-xs"
                      data-testid="pending-storage-audit-log-filter-path"
                    />
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setAuditPathFilter(auditPathDraft)}
                      disabled={auditPathDraft === auditPathFilter}
                      data-testid="pending-storage-audit-log-filter-path-apply"
                    >
                      Apply
                    </Button>
                  </div>
                </div>
                {/* Task #1895 — from/to date range. Native date inputs apply
                    immediately on change (no separate Apply button) because
                    the value only changes when a full YYYY-MM-DD is picked,
                    so there's no per-keystroke fetch cost. The server
                    treats `to` as end-of-day so an inclusive range works
                    out of the box. */}
                <div className="min-w-[150px]">
                  <Label className="text-xs text-muted-foreground mb-1 block">
                    From
                  </Label>
                  <Input
                    type="date"
                    value={auditFromFilter}
                    max={auditToFilter || undefined}
                    onChange={e => setAuditFromFilter(e.target.value)}
                    className="bg-white/5 border-white/10 h-9 text-xs"
                    data-testid="pending-storage-audit-log-filter-from"
                  />
                </div>
                <div className="min-w-[150px]">
                  <Label className="text-xs text-muted-foreground mb-1 block">
                    To
                  </Label>
                  <Input
                    type="date"
                    value={auditToFilter}
                    min={auditFromFilter || undefined}
                    onChange={e => setAuditToFilter(e.target.value)}
                    className="bg-white/5 border-white/10 h-9 text-xs"
                    data-testid="pending-storage-audit-log-filter-to"
                  />
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={resetAuditFilters}
                  disabled={!auditFiltersActive}
                  data-testid="pending-storage-audit-log-filter-reset"
                >
                  Clear filters
                </Button>
              </div>
              {auditLog.data.items.length === 0 && olderAuditItems.length === 0 ? (
                <p
                  className="text-sm text-muted-foreground py-2"
                  data-testid="pending-storage-audit-log-empty"
                >
                  {auditFiltersActive
                    ? 'No recent admin actions match the current filters.'
                    : 'No recent admin actions on stuck orphan-file rows.'}
                </p>
              ) : (
                <div className="space-y-2">
                  {[...auditLog.data.items, ...olderAuditItems].map(entry => {
                    const actor = entry.actorDisplayName
                      ?? entry.actorUsername
                      ?? entry.actorEmail
                      ?? entry.actorName
                      ?? (entry.actorUserId != null ? `user #${entry.actorUserId}` : 'system');
                    const memberLabel = [entry.memberFirstName, entry.memberLastName]
                      .filter(Boolean).join(' ')
                      || (entry.clubMemberId != null ? `Member #${entry.clubMemberId}` : null);
                    const actionTone = entry.action === 'resolve'
                      ? 'border-rose-500/30 text-rose-200'
                      : 'border-amber-500/30 text-amber-200';
                    return (
                      <div
                        key={entry.id}
                        className="rounded-lg border border-white/10 bg-black/20 p-3"
                        data-testid={`pending-storage-audit-row-${entry.id}`}
                      >
                        <div className="flex items-start justify-between gap-3 flex-wrap">
                          <div className="text-sm min-w-0 flex-1">
                            <div className="flex items-center gap-2 flex-wrap">
                              <Badge
                                variant="outline"
                                className={`text-[10px] uppercase tracking-wide ${actionTone}`}
                                data-testid={`pending-storage-audit-action-${entry.id}`}
                              >
                                {entry.action === 'resolve' ? 'resolved' : 'force retry'}
                              </Badge>
                              {entry.bulk && (
                                /* Task #1893 — sits next to the action pill so a streak of
                                   identical-looking rows is recognisable as one bulk click
                                   rather than 30 separate per-row clicks. */
                                <Badge
                                  variant="outline"
                                  className="text-[10px] uppercase tracking-wide border-sky-500/40 text-sky-200"
                                  data-testid={`pending-storage-audit-bulk-${entry.id}`}
                                >
                                  bulk
                                </Badge>
                              )}
                              <span className="text-white font-medium" data-testid={`pending-storage-audit-actor-${entry.id}`}>
                                {actor}
                              </span>
                              <span className="text-xs text-muted-foreground">
                                {new Date(entry.createdAt).toLocaleString()}
                              </span>
                            </div>
                            {entry.path && (
                              <div
                                className="text-xs text-amber-100/80 mt-1 font-mono break-all"
                                data-testid={`pending-storage-audit-path-${entry.id}`}
                              >
                                {entry.path}
                              </div>
                            )}
                            <div className="text-xs text-muted-foreground mt-1 flex flex-wrap items-center gap-2">
                              {memberLabel && !entry.memberDeleted ? (
                                <Link
                                  href={`/member-360/${entry.clubMemberId}`}
                                  className="text-sky-300 hover:text-sky-100 underline"
                                  data-testid={`pending-storage-audit-member-link-${entry.id}`}
                                >
                                  {memberLabel}
                                  {entry.memberNumber ? ` #${entry.memberNumber}` : ''}
                                </Link>
                              ) : memberLabel ? (
                                <span data-testid={`pending-storage-audit-member-${entry.id}`}>
                                  {memberLabel}
                                  {entry.memberNumber ? ` #${entry.memberNumber}` : ''}
                                </span>
                              ) : null}
                              {entry.memberDeleted && (
                                <Badge
                                  variant="outline"
                                  className="border-white/20 text-white/60 text-[10px]"
                                  data-testid={`pending-storage-audit-member-deleted-${entry.id}`}
                                >
                                  member row removed
                                </Badge>
                              )}
                              {entry.attempts != null && (
                                <span>{entry.attempts} attempt{entry.attempts === 1 ? '' : 's'}</span>
                              )}
                            </div>
                            {entry.reason && (
                              <div
                                className="text-xs text-white/80 mt-1 italic"
                                data-testid={`pending-storage-audit-reason-${entry.id}`}
                              >
                                “{entry.reason}”
                              </div>
                            )}
                            {entry.lastError && (
                              <div className="text-xs text-rose-200/80 mt-1 break-all">
                                Last error at clear: {entry.lastError}
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
              {/* Task #1894 — "Load older" affordance only renders when the
                  server told us there's at least one more page under the
                  current filters. Once the cursor is exhausted (or never
                  appeared at all) we surface a quiet end-of-history line
                  so admins can tell "we've shown everything" apart from
                  "we just haven't paged back yet". */}
              {olderAuditCursor != null ? (
                <div
                  className="mt-4 flex flex-col items-center gap-2"
                  data-testid="pending-storage-audit-log-pagination"
                >
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={loadOlderAudit}
                    disabled={olderAuditLoading}
                    data-testid="pending-storage-audit-log-load-older"
                  >
                    {olderAuditLoading ? 'Loading…' : 'Load older'}
                  </Button>
                  {olderAuditError && (
                    <p
                      className="text-xs text-rose-300"
                      data-testid="pending-storage-audit-log-load-older-error"
                    >
                      Could not load older entries: {olderAuditError}
                    </p>
                  )}
                </div>
              ) : (auditLog.data.items.length > 0 || olderAuditItems.length > 0) ? (
                <p
                  className="mt-4 text-center text-xs text-muted-foreground"
                  data-testid="pending-storage-audit-log-end"
                >
                  Reached the end of the audit trail.
                </p>
              ) : null}
            </CardContent>
          )}
        </Card>
      )}

      <Dialog
        open={resolveTarget != null}
        onOpenChange={(open) => { if (!open) { setResolveTarget(null); setResolveReason(''); } }}
      >
        <DialogContent data-testid="pending-storage-resolve-dialog">
          <DialogHeader>
            <DialogTitle>Mark stuck orphan-file row resolved</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <p className="text-muted-foreground">
              This deletes the row from the retry queue and writes an audit-trail entry recording
              who cleared it and why. Use this only when you're confident the underlying object is
              genuinely gone from the bucket.
            </p>
            {resolveTarget && (
              <div className="rounded-md border border-white/10 bg-black/20 p-2 text-xs font-mono break-all">
                {resolveTarget.path}
              </div>
            )}
            <Label htmlFor="pending-storage-resolve-reason">Reason (required)</Label>
            <Textarea
              id="pending-storage-resolve-reason"
              data-testid="pending-storage-resolve-reason"
              value={resolveReason}
              onChange={(e) => setResolveReason(e.target.value)}
              placeholder="e.g. confirmed deleted via bucket migration on 2026-04-20"
              rows={3}
            />
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => { setResolveTarget(null); setResolveReason(''); }}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              data-testid="pending-storage-resolve-confirm"
              disabled={resolveMut.isPending || resolveReason.trim().length === 0 || resolveTarget == null}
              onClick={() => {
                if (resolveTarget) resolveMut.mutate({ id: resolveTarget.id, reason: resolveReason.trim() });
              }}
            >
              Mark resolved
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Task #1302 — bulk resolve dialog: one shared reason for the whole batch.
          Each pending row still gets its own audit-log entry server-side so the
          per-row trail is preserved. Task #1536 — embeds the chunked-progress
          bar so admins can watch the sweep tick across without dismissing the
          modal, and we block dismissal while a sweep is in-flight to avoid
          orphaning a partial run. */}
      <Dialog
        open={bulkResolveOpen}
        onOpenChange={(open) => {
          if (open) return;
          if (bulkProgress?.action === 'resolve') return;
          setBulkResolveOpen(false);
          setBulkResolveReason('');
        }}
      >
        <DialogContent data-testid="pending-storage-bulk-resolve-dialog">
          <DialogHeader>
            <DialogTitle>
              Mark {selectedIds.size} stuck row{selectedIds.size === 1 ? '' : 's'} resolved
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <p className="text-muted-foreground">
              This deletes every selected row from the retry queue and writes one audit-trail
              entry per row recording who cleared it and why. Use this only when you're
              confident the underlying objects are genuinely gone from the bucket — for example
              after a known-good bucket migration.
            </p>
            <Label htmlFor="pending-storage-bulk-resolve-reason">Reason (required, applied to all)</Label>
            <Textarea
              id="pending-storage-bulk-resolve-reason"
              data-testid="pending-storage-bulk-resolve-reason"
              value={bulkResolveReason}
              onChange={(e) => setBulkResolveReason(e.target.value)}
              placeholder="e.g. confirmed deleted via bucket migration on 2026-04-20"
              rows={3}
              disabled={bulkProgress?.action === 'resolve'}
            />
            {bulkProgress?.action === 'resolve' && (
              <div
                className="space-y-1"
                data-testid="pending-storage-bulk-resolve-progress"
                role="status"
                aria-live="polite"
              >
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span data-testid="pending-storage-bulk-resolve-progress-text">
                    Marking resolved — {bulkProgress.processed} of {bulkProgress.total} done
                  </span>
                  <span>
                    {Math.round((bulkProgress.processed / Math.max(bulkProgress.total, 1)) * 100)}%
                  </span>
                </div>
                <Progress
                  value={(bulkProgress.processed / Math.max(bulkProgress.total, 1)) * 100}
                  className="h-1.5"
                />
              </div>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              disabled={bulkProgress?.action === 'resolve'}
              onClick={() => { setBulkResolveOpen(false); setBulkResolveReason(''); }}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              data-testid="pending-storage-bulk-resolve-confirm"
              disabled={
                bulkInFlight
                || bulkResolveReason.trim().length === 0
                || selectedIds.size === 0
              }
              onClick={() => runBulkResolve(Array.from(selectedIds), bulkResolveReason.trim())}
            >
              {bulkProgress?.action === 'resolve'
                ? `Marking ${bulkProgress.processed}/${bulkProgress.total}…`
                : `Mark ${selectedIds.size} resolved`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Card className="bg-white/5 border-white/10">
        <CardHeader className="pb-3">
          <CardTitle className="text-white text-base flex items-center justify-between gap-2">
            <span className="flex items-center gap-2"><ShieldCheck className="w-4 h-4 text-emerald-400" /> Consent health</span>
            <Button size="sm" variant="ghost" onClick={() => refetch()} disabled={isFetching}>
              <RefreshCw className={`w-3.5 h-3.5 ${isFetching ? 'animate-spin' : ''}`} />
            </Button>
          </CardTitle>
          <p className="text-xs text-muted-foreground mt-1">
            Latest consent decision per member across {data.totalMembers} member{data.totalMembers === 1 ? '' : 's'}.
          </p>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {data.categories.map(c => {
              const pct = Math.round(c.optInRate * 100);
              const tone = pct >= 75 ? 'bg-emerald-500' : pct >= 40 ? 'bg-amber-500' : 'bg-rose-500';
              return (
                <div key={c.consentType} className="rounded-lg border border-white/10 bg-black/20 p-3" data-testid={`consent-row-${c.consentType}`}>
                  <div className="flex items-center justify-between">
                    <div className="text-sm text-white font-medium">
                      {CONSENT_CATEGORY_LABELS[c.consentType] ?? c.consentType}
                    </div>
                    <div className="text-xs text-muted-foreground">{pct}% opt-in</div>
                  </div>
                  <div className="mt-2 h-1.5 bg-white/10 rounded-full overflow-hidden">
                    <div className={`h-full ${tone}`} style={{ width: `${pct}%` }} />
                  </div>
                  <div className="mt-2 flex items-center gap-3 text-[11px] text-muted-foreground">
                    <span className="text-emerald-300">Granted {c.grantedMembers}</span>
                    <span className="text-rose-300">Withdrawn {c.withdrawnMembers}</span>
                    <span>No decision {c.noDecisionMembers}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      <Card className="bg-white/5 border-white/10">
        <CardHeader className="pb-3">
          <CardTitle className="text-white text-base flex items-center gap-2">
            <Clock className="w-4 h-4 text-amber-400" /> Account deletions in grace period
          </CardTitle>
          <p className="text-xs text-muted-foreground mt-1">
            {data.accountDeletions.inGrace} pending in grace, {data.accountDeletions.overdue} overdue.
            Members can cancel their own deletion until the grace window elapses.
          </p>
        </CardHeader>
        <CardContent>
          {data.accountDeletions.rows.length === 0 ? (
            <div className="text-muted-foreground text-sm py-4 text-center">No pending account deletions.</div>
          ) : (
            <div className="space-y-2">
              {data.accountDeletions.rows.map(d => {
                const overdue = d.dueBy ? new Date(d.dueBy).getTime() <= Date.now() : false;
                return (
                  <div
                    key={d.id}
                    className={`flex items-center justify-between gap-3 rounded-lg border p-3 ${overdue ? 'border-rose-500/40 bg-rose-500/5' : 'border-white/10 bg-black/20'}`}
                    data-testid={`account-deletion-${d.id}`}
                  >
                    <div className="text-sm">
                      <div className="text-white font-medium">
                        {[d.memberFirstName, d.memberLastName].filter(Boolean).join(' ') || `Member #${d.clubMemberId}`}
                        {d.memberNumber ? <span className="text-muted-foreground ml-2">#{d.memberNumber}</span> : null}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        Filed {new Date(d.requestedAt).toLocaleDateString()}
                        {d.dueBy ? ` · ${overdue ? 'overdue since' : 'erases on'} ${new Date(d.dueBy).toLocaleDateString()}` : ''}
                      </div>
                    </div>
                    <Badge variant={overdue ? 'destructive' : 'secondary'} className="capitalize">{d.status.replace('_', ' ')}</Badge>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="bg-white/5 border-white/10" data-testid="data-exports-card">
        <CardHeader className="pb-3">
          <CardTitle className="text-white text-base flex items-center gap-2">
            <Download className="w-4 h-4 text-sky-400" /> Self-serve data exports
          </CardTitle>
          <p className="text-xs text-muted-foreground mt-1">
            {data.dataExports.pending} pending · {data.dataExports.ready} ready to download · {data.dataExports.expired} expired
            {data.dataExports.failed ? ` · ${data.dataExports.failed} failed` : ''}.
            Members can request a JSON archive of their personal data; ready archives expire 7 days after generation.
          </p>
        </CardHeader>
        <CardContent>
          {data.dataExports.rows.length === 0 ? (
            <div className="text-muted-foreground text-sm py-4 text-center">No data exports requested yet.</div>
          ) : (
            <div className="space-y-2">
              {data.dataExports.rows.map(d => {
                const tone =
                  d.computedStatus === 'ready' ? 'border-emerald-500/40 bg-emerald-500/5' :
                  d.computedStatus === 'pending' ? 'border-amber-500/40 bg-amber-500/5' :
                  d.computedStatus === 'failed' ? 'border-rose-500/40 bg-rose-500/5' :
                  'border-white/10 bg-black/20';
                return (
                  <div
                    key={d.id}
                    className={`flex items-center justify-between gap-3 rounded-lg border p-3 ${tone}`}
                    data-testid={`data-export-${d.id}`}
                  >
                    <div className="text-sm">
                      <div className="text-white font-medium">
                        {[d.memberFirstName, d.memberLastName].filter(Boolean).join(' ') || `Member #${d.clubMemberId}`}
                        {d.memberNumber ? <span className="text-muted-foreground ml-2">#{d.memberNumber}</span> : null}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        Requested {new Date(d.requestedAt).toLocaleDateString()}
                        {d.resolvedAt ? ` · ready ${new Date(d.resolvedAt).toLocaleDateString()}` : ''}
                        {d.purgedAt ? ` · removed ${new Date(d.purgedAt).toLocaleDateString()}` : ''}
                      </div>
                    </div>
                    <Badge
                      variant={
                        d.computedStatus === 'ready' ? 'default' :
                        d.computedStatus === 'failed' ? 'destructive' :
                        'secondary'
                      }
                      className="capitalize"
                    >
                      {d.computedStatus}
                    </Badge>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
