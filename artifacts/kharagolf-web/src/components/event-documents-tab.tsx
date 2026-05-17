import React, { useState, useEffect, useRef } from 'react';
import { useToast } from '@/hooks/use-toast';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  FileText, Upload, Download, Trash2, Plus, FolderOpen, Loader2, Eye, Users, Shield, Link2
} from 'lucide-react';

const BASE_URL = (import.meta.env.BASE_URL ?? '/').replace(/\/$/, '');
function apiUrl(path: string) { return `${BASE_URL}/api${path}`; }

interface Doc {
  eventDocumentId: number;
  documentId: number;
  title: string;
  category: string;
  visibility: string;
  filename: string | null;
  contentType: string | null;
  fileSize: number | null;
  objectPath: string;
  createdAt: string;
}

interface LibraryDoc {
  id: number;
  title: string;
  category: string;
  visibility: string;
  filename: string | null;
}

const CATEGORIES: { value: string; label: string }[] = [
  { value: 'local_rules', label: 'Local Rules' },
  { value: 'pace_of_play', label: 'Pace of Play' },
  { value: 'policy', label: 'Policy' },
  { value: 'general', label: 'General' },
  { value: 'results', label: 'Results' },
  { value: 'notice', label: 'Notice' },
];

const CATEGORY_COLORS: Record<string, string> = {
  local_rules: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30',
  pace_of_play: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
  policy: 'bg-violet-500/20 text-violet-400 border-violet-500/30',
  general: 'bg-gray-500/20 text-gray-400 border-gray-500/30',
  results: 'bg-amber-500/20 text-amber-400 border-amber-500/30',
  notice: 'bg-rose-500/20 text-rose-400 border-rose-500/30',
};

function formatBytes(bytes: number | null): string {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getCategoryLabel(cat: string) {
  return CATEGORIES.find(c => c.value === cat)?.label ?? cat;
}

interface Props {
  orgId: number;
  eventType: 'tournament' | 'league';
  eventId: number;
  isAdmin: boolean;
}

export function EventDocumentsTab({ orgId, eventType, eventId, isAdmin }: Props) {
  const { toast } = useToast();
  const [docs, setDocs] = useState<Doc[]>([]);
  const [loading, setLoading] = useState(true);
  const [attachOpen, setAttachOpen] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [detachingId, setDetachingId] = useState<number | null>(null);
  const [libraryDocs, setLibraryDocs] = useState<LibraryDoc[]>([]);
  const [selectedLibraryDocId, setSelectedLibraryDocId] = useState('');
  const [attaching, setAttaching] = useState(false);

  const [form, setForm] = useState({ title: '', category: 'general', visibility: 'public' });
  const [uploading, setUploading] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const eventApiBase = eventType === 'tournament'
    ? `/organizations/${orgId}/tournaments/${eventId}`
    : `/organizations/${orgId}/leagues/${eventId}`;

  const fetchDocs = async () => {
    setLoading(true);
    try {
      const res = await fetch(apiUrl(`${eventApiBase}/documents`), { credentials: 'include' });
      if (res.ok) setDocs(await res.json());
    } finally {
      setLoading(false);
    }
  };

  const fetchLibrary = async () => {
    const res = await fetch(apiUrl(`/organizations/${orgId}/documents`), { credentials: 'include' });
    if (res.ok) setLibraryDocs(await res.json());
  };

  useEffect(() => { fetchDocs(); }, [orgId, eventId, eventType]);

  const openAttach = async () => {
    await fetchLibrary();
    setSelectedLibraryDocId('');
    setAttachOpen(true);
  };

  const handleAttach = async () => {
    if (!selectedLibraryDocId) { toast({ title: 'Select a document', variant: 'destructive' }); return; }
    setAttaching(true);
    try {
      const res = await fetch(apiUrl(`${eventApiBase}/documents`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ documentId: parseInt(selectedLibraryDocId) }),
      });
      const data = await res.json();
      if (!res.ok) { toast({ title: data.error ?? 'Failed to attach', variant: 'destructive' }); return; }
      toast({ title: 'Document attached' });
      setAttachOpen(false);
      fetchDocs();
    } finally {
      setAttaching(false);
    }
  };

  const handleUpload = async () => {
    if (!selectedFile) { toast({ title: 'Please select a file', variant: 'destructive' }); return; }
    if (!form.title.trim()) { toast({ title: 'Title is required', variant: 'destructive' }); return; }
    setUploading(true);
    try {
      const urlRes = await fetch(apiUrl(`/organizations/${orgId}/documents/upload-url`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ contentType: selectedFile.type, size: selectedFile.size }),
      });
      if (!urlRes.ok) { const e = await urlRes.json(); toast({ title: e.error ?? 'Upload URL failed', variant: 'destructive' }); return; }
      const { uploadURL, objectPath, uploadToken } = await urlRes.json();

      const putRes = await fetch(uploadURL, { method: 'PUT', body: selectedFile, headers: { 'Content-Type': selectedFile.type } });
      if (!putRes.ok) { toast({ title: 'File upload failed', variant: 'destructive' }); return; }

      const attachRes = await fetch(apiUrl(`${eventApiBase}/documents`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          title: form.title.trim(),
          category: form.category,
          visibility: form.visibility,
          objectPath,
          uploadToken,
          filename: selectedFile.name,
          contentType: selectedFile.type,
          fileSize: selectedFile.size,
        }),
      });
      const data = await attachRes.json();
      if (!attachRes.ok) { toast({ title: data.error ?? 'Failed to attach', variant: 'destructive' }); return; }
      toast({ title: 'Document uploaded and attached' });
      setUploadOpen(false);
      setForm({ title: '', category: 'general', visibility: 'public' });
      setSelectedFile(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
      fetchDocs();
    } finally {
      setUploading(false);
    }
  };

  const handleDetach = async (eventDocId: number) => {
    setDetachingId(eventDocId);
    try {
      await fetch(apiUrl(`${eventApiBase}/documents/${eventDocId}`), { method: 'DELETE', credentials: 'include' });
      toast({ title: 'Document removed from event' });
      fetchDocs();
    } finally {
      setDetachingId(null);
    }
  };

  const handleDownload = (doc: Doc) => {
    window.open(apiUrl(`/organizations/${orgId}/documents/${doc.documentId}/download`), '_blank');
  };

  return (
    <div className="space-y-4">
      <Card className="glass-card">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-white flex items-center gap-2">
              <FileText className="w-4 h-4 text-emerald-400" /> Event Documents
            </CardTitle>
            {isAdmin && (
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={openAttach} className="border-white/10 text-white hover:bg-white/5 text-xs gap-1.5">
                  <Link2 className="w-3.5 h-3.5" /> From Library
                </Button>
                <Button size="sm" onClick={() => { setUploadOpen(true); setForm({ title: '', category: 'general', visibility: 'public' }); setSelectedFile(null); }} className="bg-emerald-600 hover:bg-emerald-700 text-white text-xs gap-1.5">
                  <Upload className="w-3.5 h-3.5" /> Upload New
                </Button>
              </div>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex items-center gap-2 text-muted-foreground py-6 justify-center">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading…
            </div>
          ) : docs.length === 0 ? (
            <div className="text-center py-10 text-muted-foreground">
              <FileText className="w-10 h-10 mx-auto mb-2 opacity-20" />
              <p className="text-sm">No documents attached to this event yet.</p>
              {isAdmin && (
                <div className="flex gap-3 justify-center mt-4">
                  <Button variant="outline" size="sm" onClick={openAttach} className="border-white/10 text-white hover:bg-white/5 text-xs">
                    <Link2 className="w-3 h-3 mr-1.5" /> Attach from library
                  </Button>
                  <Button size="sm" onClick={() => setUploadOpen(true)} className="bg-emerald-600 hover:bg-emerald-700 text-white text-xs">
                    <Upload className="w-3 h-3 mr-1.5" /> Upload new
                  </Button>
                </div>
              )}
            </div>
          ) : (
            <div className="overflow-x-auto rounded-xl">
              <Table>
                <TableHeader>
                  <TableRow className="border-white/5">
                    <TableHead className="text-muted-foreground">Document</TableHead>
                    <TableHead className="text-muted-foreground">Category</TableHead>
                    <TableHead className="text-muted-foreground">Visibility</TableHead>
                    <TableHead className="text-muted-foreground text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {docs.map(doc => (
                    <TableRow key={doc.eventDocumentId} className="border-white/5">
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <FileText className="w-4 h-4 text-emerald-400 flex-shrink-0" />
                          <div>
                            <p className="text-white text-sm font-medium">{doc.title}</p>
                            {doc.filename && <p className="text-muted-foreground text-xs">{doc.filename} {doc.fileSize ? `· ${formatBytes(doc.fileSize)}` : ''}</p>}
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge className={`text-xs ${CATEGORY_COLORS[doc.category] ?? CATEGORY_COLORS.general}`}>
                          {getCategoryLabel(doc.category)}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {doc.visibility === 'public' ? (
                          <span className="flex items-center gap-1 text-xs text-emerald-400">
                            <Eye className="w-3 h-3" /> Public
                          </span>
                        ) : (
                          <span className="flex items-center gap-1 text-xs text-amber-400">
                            <Users className="w-3 h-3" /> Members only
                          </span>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center justify-end gap-1">
                          <button
                            onClick={() => handleDownload(doc)}
                            className="text-muted-foreground hover:text-emerald-400 transition-colors p-1.5 rounded hover:bg-emerald-400/10"
                            title="Download"
                          >
                            <Download className="w-3.5 h-3.5" />
                          </button>
                          {isAdmin && (
                            <button
                              onClick={() => handleDetach(doc.eventDocumentId)}
                              disabled={detachingId === doc.eventDocumentId}
                              className="text-muted-foreground hover:text-red-400 transition-colors p-1.5 rounded hover:bg-red-400/10"
                              title="Remove from event"
                            >
                              {detachingId === doc.eventDocumentId
                                ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                : <Trash2 className="w-3.5 h-3.5" />}
                            </button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Attach from library dialog */}
      <Dialog open={attachOpen} onOpenChange={v => { if (!attaching) setAttachOpen(v); }}>
        <DialogContent className="bg-[#0a1628] border border-white/10 text-white max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Link2 className="w-4 h-4 text-emerald-400" /> Attach from Club Library
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 mt-2">
            {libraryDocs.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-4">No documents in the club library yet. Upload one from the Documents page.</p>
            ) : (
              <div>
                <label className="text-xs text-muted-foreground uppercase tracking-wider">Select Document</label>
                <Select value={selectedLibraryDocId} onValueChange={setSelectedLibraryDocId}>
                  <SelectTrigger className="mt-1 bg-black/40 border-white/10 text-white">
                    <SelectValue placeholder="Choose a document…" />
                  </SelectTrigger>
                  <SelectContent className="bg-[#0a1628] border-white/10 text-white">
                    {libraryDocs.map(d => (
                      <SelectItem key={d.id} value={String(d.id)} className="text-white hover:bg-white/5">
                        {d.title} <span className="text-muted-foreground text-xs ml-1">({getCategoryLabel(d.category)})</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="flex gap-3 pt-2">
              <Button onClick={handleAttach} disabled={attaching || !selectedLibraryDocId || libraryDocs.length === 0} className="flex-1 bg-emerald-600 hover:bg-emerald-700 text-white">
                {attaching ? <><Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" /> Attaching…</> : 'Attach Document'}
              </Button>
              <Button variant="outline" onClick={() => setAttachOpen(false)} className="border-white/10 text-white hover:bg-white/5">Cancel</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Upload new document dialog */}
      <Dialog open={uploadOpen} onOpenChange={v => { if (!uploading) setUploadOpen(v); }}>
        <DialogContent className="bg-[#0a1628] border border-white/10 text-white max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Upload className="w-4 h-4 text-emerald-400" /> Upload Event Document
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 mt-2">
            <div>
              <label className="text-xs text-muted-foreground uppercase tracking-wider">File *</label>
              <div
                className="mt-1 border-2 border-dashed border-white/10 rounded-xl p-5 text-center cursor-pointer hover:border-emerald-500/40 transition-colors"
                onClick={() => fileInputRef.current?.click()}
              >
                {selectedFile ? (
                  <div className="flex items-center gap-2 justify-center">
                    <FileText className="w-5 h-5 text-emerald-400" />
                    <div className="text-left">
                      <p className="text-sm text-white">{selectedFile.name}</p>
                      <p className="text-xs text-muted-foreground">{formatBytes(selectedFile.size)}</p>
                    </div>
                  </div>
                ) : (
                  <div>
                    <Upload className="w-7 h-7 mx-auto text-muted-foreground mb-1" />
                    <p className="text-sm text-muted-foreground">Click to select a file</p>
                    <p className="text-xs text-muted-foreground mt-0.5">PDF, Word, Excel, images — max 50 MB</p>
                  </div>
                )}
                <input
                  ref={fileInputRef}
                  type="file"
                  className="hidden"
                  accept=".pdf,.doc,.docx,.xls,.xlsx,.txt,.jpg,.jpeg,.png,.webp"
                  onChange={e => {
                    const f = e.target.files?.[0] ?? null;
                    setSelectedFile(f);
                    if (f && !form.title) setForm(fm => ({ ...fm, title: f.name.replace(/\.[^/.]+$/, '') }));
                  }}
                />
              </div>
            </div>
            <div>
              <label className="text-xs text-muted-foreground uppercase tracking-wider">Title *</label>
              <Input value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} placeholder="e.g. Event Local Rules" className="mt-1 bg-black/40 border-white/10 text-white" />
            </div>
            <div>
              <label className="text-xs text-muted-foreground uppercase tracking-wider">Category</label>
              <Select value={form.category} onValueChange={v => setForm(f => ({ ...f, category: v }))}>
                <SelectTrigger className="mt-1 bg-black/40 border-white/10 text-white"><SelectValue /></SelectTrigger>
                <SelectContent className="bg-[#0a1628] border-white/10 text-white">
                  {CATEGORIES.map(c => <SelectItem key={c.value} value={c.value} className="text-white hover:bg-white/5">{c.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-xs text-muted-foreground uppercase tracking-wider">Visibility</label>
              <Select value={form.visibility} onValueChange={v => setForm(f => ({ ...f, visibility: v }))}>
                <SelectTrigger className="mt-1 bg-black/40 border-white/10 text-white"><SelectValue /></SelectTrigger>
                <SelectContent className="bg-[#0a1628] border-white/10 text-white">
                  <SelectItem value="public" className="text-white hover:bg-white/5">Public — visible to all players</SelectItem>
                  <SelectItem value="members_only" className="text-white hover:bg-white/5">Members only</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex gap-3 pt-2">
              <Button onClick={handleUpload} disabled={uploading || !selectedFile} className="flex-1 bg-emerald-600 hover:bg-emerald-700 text-white">
                {uploading ? <><Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" /> Uploading…</> : 'Upload & Attach'}
              </Button>
              <Button variant="outline" onClick={() => setUploadOpen(false)} disabled={uploading} className="border-white/10 text-white hover:bg-white/5">Cancel</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
