import { useEffect, useState, useCallback, useRef } from 'react';
import DOMPurify from 'dompurify';
import {
  Newspaper, Plus, Pin, PinOff, Eye, Edit2, Trash2, Send,
  Tag, RefreshCw, Search, AlertCircle, CheckCircle2, Clock,
  Archive, Globe, Star, ExternalLink, MousePointerClick,
  X, ChevronDown, ChevronUp, ChevronRight, Image, Loader2, Bell, Link, Upload,
  Bold, Italic, Underline as UnderlineIcon, List, ListOrdered, Heading2,
} from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';
import { useGetMe } from '@workspace/api-client-react';
import { useActiveOrgContext } from '@/context/ActiveOrgContext';

const CATEGORY_COLORS: Record<string, string> = {
  '#C9A84C': 'Gold',
  '#3B82F6': 'Blue',
  '#22C55E': 'Green',
  '#EF4444': 'Red',
  '#A855F7': 'Purple',
  '#F97316': 'Orange',
  '#06B6D4': 'Cyan',
  '#EC4899': 'Pink',
};

const DEFAULT_CATEGORIES = [
  { name: 'News', color: '#3B82F6', icon: 'newspaper' },
  { name: 'Events', color: '#C9A84C', icon: 'calendar' },
  { name: 'Course Notices', color: '#22C55E', icon: 'flag' },
  { name: 'Committee', color: '#A855F7', icon: 'shield' },
  { name: 'Sponsor Content', color: '#F97316', icon: 'star' },
];

interface Category {
  id: number; name: string; color: string; icon: string; sortOrder: number;
}

interface Article {
  id: number;
  title: string;
  body: string;
  imageUrl: string | null;
  isPinned: boolean;
  isImportant: boolean;
  isSponsored: boolean;
  sponsorUrl: string | null;
  status: 'draft' | 'scheduled' | 'published' | 'archived';
  publishAt: string | null;
  publishedAt: string | null;
  authorName: string | null;
  attachments: { name: string; url: string; type: string }[];
  viewCount: number;
  clickCount: number;
  categoryId: number | null;
  categoryName: string | null;
  categoryColor: string | null;
  createdAt: string;
  updatedAt: string;
}

type Tab = 'feed' | 'admin';
type StatusFilter = 'all' | 'published' | 'draft' | 'scheduled' | 'archived';

function timeAgo(dateStr: string | null) {
  if (!dateStr) return '';
  const diff = (Date.now() - new Date(dateStr).getTime()) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return new Date(dateStr).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}

const STATUS_STYLES: Record<string, { label: string; cls: string }> = {
  published: { label: 'Published', cls: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30' },
  draft:     { label: 'Draft',     cls: 'bg-white/10 text-white/50 border-white/10' },
  scheduled: { label: 'Scheduled', cls: 'bg-amber-500/20 text-amber-300 border-amber-500/30' },
  archived:  { label: 'Archived',  cls: 'bg-red-500/20 text-red-400 border-red-500/30' },
};

function stripHtml(html: string) {
  return html.replace(/<[^>]+>/g, '').slice(0, 180);
}

// ── Rich Text Editor ─────────────────────────────────────────────────────────
interface RichTextEditorProps {
  value: string;
  onChange: (html: string) => void;
  placeholder?: string;
}

function RichTextEditor({ value, onChange, placeholder }: RichTextEditorProps) {
  const ref = useRef<HTMLDivElement>(null);
  const isUpdatingRef = useRef(false);

  // Sync external value → innerHTML (only when value changes from outside)
  useEffect(() => {
    if (!ref.current) return;
    if (ref.current.innerHTML !== value) {
      isUpdatingRef.current = true;
      ref.current.innerHTML = value;
      isUpdatingRef.current = false;
    }
  }, [value]);

  const exec = (cmd: string, val?: string) => {
    ref.current?.focus();
    document.execCommand(cmd, false, val);
    if (ref.current) onChange(ref.current.innerHTML);
  };

  const handleInput = () => {
    if (!isUpdatingRef.current && ref.current) onChange(ref.current.innerHTML);
  };

  const insertLink = () => {
    const url = window.prompt('Enter URL:', 'https://');
    if (url) exec('createLink', url);
  };

  const toolbarBtn = (label: React.ReactNode, onClick: () => void, title: string) => (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className="p-1.5 rounded hover:bg-white/10 text-muted-foreground hover:text-white transition-colors"
    >{label}</button>
  );

  return (
    <div className="rounded-xl border border-white/15 bg-black/30 overflow-hidden focus-within:ring-2 focus-within:ring-primary/50">
      {/* Toolbar */}
      <div className="flex items-center gap-0.5 px-2 py-1.5 border-b border-white/10 flex-wrap">
        {toolbarBtn(<Bold className="w-3.5 h-3.5" />, () => exec('bold'), 'Bold')}
        {toolbarBtn(<Italic className="w-3.5 h-3.5" />, () => exec('italic'), 'Italic')}
        {toolbarBtn(<UnderlineIcon className="w-3.5 h-3.5" />, () => exec('underline'), 'Underline')}
        <div className="w-px h-4 bg-white/15 mx-1" />
        {toolbarBtn(<Heading2 className="w-3.5 h-3.5" />, () => exec('formatBlock', 'h2'), 'Heading')}
        {toolbarBtn(<List className="w-3.5 h-3.5" />, () => exec('insertUnorderedList'), 'Bullet List')}
        {toolbarBtn(<ListOrdered className="w-3.5 h-3.5" />, () => exec('insertOrderedList'), 'Numbered List')}
        <div className="w-px h-4 bg-white/15 mx-1" />
        {toolbarBtn(<Link className="w-3.5 h-3.5" />, insertLink, 'Insert Link')}
        {toolbarBtn(<X className="w-3.5 h-3.5" />, () => exec('removeFormat'), 'Clear Formatting')}
      </div>
      {/* Editable area */}
      <div
        ref={ref}
        contentEditable
        suppressContentEditableWarning
        onInput={handleInput}
        data-placeholder={placeholder}
        className="min-h-[200px] max-h-[400px] overflow-y-auto px-4 py-3 text-white text-sm leading-relaxed focus:outline-none [&_h2]:text-base [&_h2]:font-bold [&_h2]:mt-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_a]:text-primary [&_a]:underline empty:before:content-[attr(data-placeholder)] empty:before:text-muted-foreground"
      />
    </div>
  );
}

export default function NoticeBoardPage() {
  const { toast } = useToast();
  const { data: me } = useGetMe();
  const { activeOrgId: orgId } = useActiveOrgContext();
  const isAdmin = me?.role === 'org_admin' || me?.role === 'super_admin' || me?.role === 'tournament_director';

  const [tab, setTab] = useState<Tab>(isAdmin ? 'admin' : 'feed');
  const [articles, setArticles] = useState<Article[]>([]);
  const [feed, setFeed] = useState<(Article & { isRead?: boolean })[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [search, setSearch] = useState('');
  const [catFilter, setCatFilter] = useState<number | null>(null);

  // Article editor state
  const [editing, setEditing] = useState<Partial<Article> | null>(null);
  const [saving, setSaving] = useState(false);
  const [selectedArticle, setSelectedArticle] = useState<(Article & { isRead?: boolean }) | null>(null);
  const [showCatManager, setShowCatManager] = useState(false);
  const [newCatName, setNewCatName] = useState('');
  const [newCatColor, setNewCatColor] = useState('#3B82F6');
  const [attachNewUrl, setAttachNewUrl] = useState('');
  const [attachNewName, setAttachNewName] = useState('');
  const [imageUploading, setImageUploading] = useState(false);
  const imageFileInputRef = useRef<HTMLInputElement>(null);
  const attachFileInputRef = useRef<HTMLInputElement>(null);

  const loadArticles = useCallback(async () => {
    if (!orgId) return;
    setLoading(true);
    try {
      const [artRes, catRes] = await Promise.all([
        fetch(`/api/organizations/${orgId}/notice-board/articles`, { credentials: 'include' }),
        fetch(`/api/organizations/${orgId}/notice-board/categories`, { credentials: 'include' }),
      ]);
      if (artRes.ok) setArticles(await artRes.json());
      if (catRes.ok) setCategories(await catRes.json());
    } catch { /* silent */ }
    finally { setLoading(false); }
  }, [orgId]);

  const loadFeed = useCallback(async () => {
    if (!orgId) return;
    setLoading(true);
    try {
      const [feedRes, catRes] = await Promise.all([
        fetch(`/api/organizations/${orgId}/notice-board/feed?search=${encodeURIComponent(search)}`, { credentials: 'include' }),
        fetch(`/api/organizations/${orgId}/notice-board/categories`, { credentials: 'include' }),
      ]);
      if (feedRes.ok) setFeed(await feedRes.json());
      if (catRes.ok) setCategories(await catRes.json());
    } catch { /* silent */ }
    finally { setLoading(false); }
  }, [orgId, search]);

  useEffect(() => {
    if (tab === 'admin') loadArticles();
    else loadFeed();
  }, [tab, loadArticles, loadFeed]);

  // Seed default categories if none exist
  const seedDefaultCategories = async () => {
    if (!orgId || categories.length > 0) return;
    for (const cat of DEFAULT_CATEGORIES) {
      await fetch(`/api/organizations/${orgId}/notice-board/categories`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cat),
      });
    }
    loadArticles();
  };

  const handleSave = async () => {
    if (!editing || !orgId) return;
    if (!editing.title?.trim() || !editing.body?.trim()) {
      toast({ title: 'Title and content are required', variant: 'destructive' }); return;
    }
    setSaving(true);
    try {
      const isNew = !editing.id;
      const url = isNew
        ? `/api/organizations/${orgId}/notice-board/articles`
        : `/api/organizations/${orgId}/notice-board/articles/${editing.id}`;
      const r = await fetch(url, {
        method: isNew ? 'POST' : 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: editing.title,
          body: editing.body,
          imageUrl: editing.imageUrl || null,
          categoryId: editing.categoryId || null,
          isPinned: editing.isPinned ?? false,
          isImportant: editing.isImportant ?? false,
          isSponsored: editing.isSponsored ?? false,
          sponsorUrl: editing.sponsorUrl || null,
          publishAt: editing.publishAt || null,
          status: editing.status ?? 'draft',
        }),
      });
      if (!r.ok) throw new Error('Save failed');
      toast({ title: isNew ? 'Article created' : 'Article updated' });
      setEditing(null);
      loadArticles();
    } catch {
      toast({ title: 'Failed to save article', variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  const handlePublish = async (article: Article, withPush: boolean) => {
    if (!orgId) return;
    const r = await fetch(`/api/organizations/${orgId}/notice-board/articles/${article.id}/publish`, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sendPush: withPush }),
    });
    if (r.ok) {
      toast({ title: withPush ? 'Published & push sent!' : 'Article published' });
      loadArticles();
    }
  };

  const handlePin = async (article: Article) => {
    if (!orgId) return;
    await fetch(`/api/organizations/${orgId}/notice-board/articles/${article.id}/pin`, {
      method: 'POST', credentials: 'include',
    });
    loadArticles();
  };

  const handleArchive = async (article: Article) => {
    if (!orgId || !window.confirm(`Archive "${article.title}"?`)) return;
    await fetch(`/api/organizations/${orgId}/notice-board/articles/${article.id}`, {
      method: 'DELETE', credentials: 'include',
    });
    toast({ title: 'Article archived' });
    loadArticles();
  };

  const handleOpenArticle = async (article: Article & { isRead?: boolean }) => {
    setSelectedArticle(article);
    if (!article.isRead && orgId) {
      await fetch(`/api/organizations/${orgId}/notice-board/articles/${article.id}/read`, {
        method: 'POST', credentials: 'include',
      });
      setFeed(prev => prev.map(a => a.id === article.id ? { ...a, isRead: true } : a));
    }
  };

  const handleMarkRead = async (articleId: number) => {
    if (!orgId) return;
    await fetch(`/api/organizations/${orgId}/notice-board/articles/${articleId}/read`, {
      method: 'POST', credentials: 'include',
    });
    setFeed(prev => prev.map(a => a.id === articleId ? { ...a, isRead: true } : a));
  };

  const handleImageFileUpload = async (file: File) => {
    if (!orgId) return;
    setImageUploading(true);
    try {
      const r = await fetch(`/api/organizations/${orgId}/notice-board/upload-url`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contentType: file.type }),
      });
      if (!r.ok) { toast({ title: 'Upload error', description: 'Could not get upload URL', variant: 'destructive' }); return; }
      const { uploadUrl, objectUrl } = await r.json() as { uploadUrl: string; objectUrl: string };
      const put = await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': file.type }, body: file });
      if (!put.ok) { toast({ title: 'Upload failed', variant: 'destructive' }); return; }
      setEditing(p => ({ ...p, imageUrl: objectUrl }));
      toast({ title: 'Image uploaded' });
    } catch { toast({ title: 'Upload error', variant: 'destructive' }); }
    finally { setImageUploading(false); }
  };

  const handleAttachmentFileUpload = async (articleId: number, file: File) => {
    if (!orgId) return;
    try {
      const r = await fetch(`/api/organizations/${orgId}/notice-board/upload-url`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contentType: file.type }),
      });
      if (!r.ok) { toast({ title: 'Upload error', variant: 'destructive' }); return; }
      const { uploadUrl, objectUrl } = await r.json() as { uploadUrl: string; objectUrl: string };
      const put = await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': file.type }, body: file });
      if (!put.ok) { toast({ title: 'Upload failed', variant: 'destructive' }); return; }
      // Now add as attachment with the file name and the served URL
      const addR = await fetch(`/api/organizations/${orgId}/notice-board/articles/${articleId}/attachments`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: file.name, url: objectUrl, type: file.type }),
      });
      if (addR.ok) {
        const { attachments } = await addR.json();
        setEditing(p => p ? { ...p, attachments } : p);
        toast({ title: 'Attachment uploaded' });
      }
    } catch { toast({ title: 'Upload error', variant: 'destructive' }); }
  };

  const handleAddAttachment = async (articleId: number) => {
    if (!orgId || !attachNewUrl.trim() || !attachNewName.trim()) return;
    const r = await fetch(`/api/organizations/${orgId}/notice-board/articles/${articleId}/attachments`, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: attachNewName, url: attachNewUrl, type: 'file' }),
    });
    if (r.ok) {
      const { attachments } = await r.json();
      setEditing(p => p ? { ...p, attachments } : p);
      setAttachNewUrl(''); setAttachNewName('');
      toast({ title: 'Attachment added' });
    }
  };

  const handleRemoveAttachment = async (articleId: number, url: string) => {
    if (!orgId) return;
    const r = await fetch(`/api/organizations/${orgId}/notice-board/articles/${articleId}/attachments`, {
      method: 'DELETE', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    if (r.ok) {
      const { attachments } = await r.json();
      setEditing(p => p ? { ...p, attachments } : p);
    }
  };

  const handleSponsorClick = async (article: Article) => {
    if (!orgId) return;
    const r = await fetch(`/api/organizations/${orgId}/notice-board/articles/${article.id}/click`, {
      method: 'POST', credentials: 'include',
    });
    if (r.ok) {
      const { redirectUrl } = await r.json();
      if (redirectUrl) window.open(redirectUrl, '_blank', 'noopener');
    }
  };

  const handleAddCategory = async () => {
    if (!orgId || !newCatName.trim()) return;
    await fetch(`/api/organizations/${orgId}/notice-board/categories`, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newCatName, color: newCatColor }),
    });
    setNewCatName('');
    loadArticles();
  };

  const filteredArticles = articles.filter(a => {
    if (statusFilter !== 'all' && a.status !== statusFilter) return false;
    if (catFilter && a.categoryId !== catFilter) return false;
    if (search && !a.title.toLowerCase().includes(search.toLowerCase()) && !a.body.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  const filteredFeed = feed.filter(a => {
    if (catFilter && a.categoryId !== catFilter) return false;
    return true;
  });

  const unreadCount = feed.filter(a => !a.isRead).length;

  // ── Editor Modal ────────────────────────────────────────────────────────────
  if (editing !== null) {
    return (
      <div className="max-w-3xl mx-auto px-4 py-8 space-y-6">
        <div className="flex items-center gap-3">
          <button onClick={() => setEditing(null)} className="text-muted-foreground hover:text-white transition-colors">
            <X className="w-5 h-5" />
          </button>
          <h1 className="text-xl font-display font-bold text-white">{editing.id ? 'Edit Article' : 'New Article'}</h1>
        </div>

        <Card className="glass-panel border-white/10 p-6 space-y-5">
          {/* Title */}
          <div>
            <label className="block text-sm font-medium text-white mb-1.5">Title <span className="text-red-400">*</span></label>
            <input
              value={editing.title ?? ''}
              onChange={e => setEditing(p => ({ ...p, title: e.target.value }))}
              placeholder="Enter article title..."
              className="w-full h-11 px-4 bg-black/30 border border-white/15 rounded-xl text-white placeholder:text-muted-foreground text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
            />
          </div>

          {/* Body */}
          <div>
            <label className="block text-sm font-medium text-white mb-1.5">Content <span className="text-red-400">*</span></label>
            <RichTextEditor
              value={editing.body ?? ''}
              onChange={body => setEditing(p => ({ ...p, body }))}
              placeholder="Write your article content here..."
            />
          </div>

          {/* Image URL + Upload */}
          <div>
            <label className="block text-sm font-medium text-white mb-1.5 flex items-center gap-1.5"><Image className="w-3.5 h-3.5" /> Cover Image <span className="text-muted-foreground font-normal">(optional)</span></label>
            <div className="flex gap-2">
              <input
                value={editing.imageUrl ?? ''}
                onChange={e => setEditing(p => ({ ...p, imageUrl: e.target.value }))}
                placeholder="Paste URL or upload →"
                className="flex-1 h-11 px-4 bg-black/30 border border-white/15 rounded-xl text-white placeholder:text-muted-foreground text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
              />
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={imageUploading}
                onClick={() => imageFileInputRef.current?.click()}
                className="h-11 px-4 border-white/20 text-muted-foreground hover:text-white gap-2 shrink-0"
              >
                {imageUploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
                Upload
              </Button>
            </div>
            <input
              ref={imageFileInputRef}
              type="file"
              accept="image/jpeg,image/png,image/gif,image/webp"
              className="hidden"
              onChange={e => { const f = e.target.files?.[0]; if (f) void handleImageFileUpload(f); e.target.value = ''; }}
            />
            {editing.imageUrl && (
              <img src={editing.imageUrl} alt="preview" className="mt-2 rounded-xl h-32 object-cover w-full border border-white/10" onError={e => (e.currentTarget.style.display = 'none')} />
            )}
          </div>

          {/* Category + Status row */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-white mb-1.5"><Tag className="w-3.5 h-3.5 inline mr-1" /> Category</label>
              <select
                value={editing.categoryId ?? ''}
                onChange={e => setEditing(p => ({ ...p, categoryId: e.target.value ? parseInt(e.target.value) : null }))}
                className="w-full h-11 px-4 bg-black/30 border border-white/15 rounded-xl text-white text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
              >
                <option value="">No category</option>
                {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-white mb-1.5">Status</label>
              <select
                value={editing.status ?? 'draft'}
                onChange={e => setEditing(p => ({ ...p, status: e.target.value as Article['status'] }))}
                className="w-full h-11 px-4 bg-black/30 border border-white/15 rounded-xl text-white text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
              >
                <option value="draft">Draft</option>
                <option value="scheduled">Scheduled</option>
                <option value="published">Published</option>
              </select>
            </div>
          </div>

          {/* Schedule date (if scheduled) */}
          {editing.status === 'scheduled' && (
            <div>
              <label className="block text-sm font-medium text-white mb-1.5"><Clock className="w-3.5 h-3.5 inline mr-1" /> Publish At</label>
              <input
                type="datetime-local"
                value={editing.publishAt ? new Date(editing.publishAt).toISOString().slice(0, 16) : ''}
                onChange={e => setEditing(p => ({ ...p, publishAt: e.target.value ? new Date(e.target.value).toISOString() : null }))}
                className="w-full h-11 px-4 bg-black/30 border border-white/15 rounded-xl text-white text-sm focus:outline-none focus:ring-2 focus:ring-primary/50 [color-scheme:dark]"
              />
            </div>
          )}

          {/* Flags */}
          <div className="flex flex-wrap gap-4">
            {(
              [
                { key: 'isPinned', label: 'Pin to top', icon: Pin },
                { key: 'isImportant', label: 'Important', icon: AlertCircle },
                { key: 'isSponsored', label: 'Sponsored content', icon: Star },
              ] as { key: keyof Pick<Article, 'isPinned' | 'isImportant' | 'isSponsored'>; label: string; icon: typeof Pin }[]
            ).map(({ key, label, icon: Icon }) => (
              <label key={key} className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={!!editing[key]}
                  onChange={e => setEditing(p => ({ ...p, [key]: e.target.checked }))}
                  className="w-4 h-4 rounded border-white/30 bg-black/30 accent-primary"
                />
                <span className="text-sm text-white flex items-center gap-1.5"><Icon className="w-3.5 h-3.5 text-muted-foreground" />{label}</span>
              </label>
            ))}
          </div>

          {/* Sponsor URL */}
          {editing.isSponsored && (
            <div>
              <label className="block text-sm font-medium text-white mb-1.5">Sponsor Click-Through URL</label>
              <input
                value={editing.sponsorUrl ?? ''}
                onChange={e => setEditing(p => ({ ...p, sponsorUrl: e.target.value }))}
                placeholder="https://sponsor-website.com"
                className="w-full h-11 px-4 bg-black/30 border border-white/15 rounded-xl text-white placeholder:text-muted-foreground text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
              />
            </div>
          )}

          {/* Attachments (for saved articles only) */}
          {editing.id && (
            <div>
              <label className="block text-sm font-medium text-white mb-2">Attachments</label>
              <div className="space-y-2 mb-3">
                {(editing.attachments ?? []).map(att => (
                  <div key={att.url} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-white/5 border border-white/10">
                    <ExternalLink className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                    <a href={att.url} target="_blank" rel="noopener noreferrer" className="flex-1 text-sm text-primary hover:underline truncate">{att.name}</a>
                    <button onClick={() => handleRemoveAttachment(editing.id!, att.url)} className="text-muted-foreground hover:text-red-400 transition-colors">
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
                {(editing.attachments ?? []).length === 0 && (
                  <p className="text-xs text-muted-foreground">No attachments yet.</p>
                )}
              </div>
              <div className="flex gap-2 flex-wrap">
                <input
                  value={attachNewName}
                  onChange={e => setAttachNewName(e.target.value)}
                  placeholder="Name"
                  className="w-28 h-9 px-3 bg-black/30 border border-white/15 rounded-lg text-white text-sm focus:outline-none focus:ring-1 focus:ring-primary/50"
                />
                <input
                  value={attachNewUrl}
                  onChange={e => setAttachNewUrl(e.target.value)}
                  placeholder="Paste URL..."
                  className="flex-1 min-w-0 h-9 px-3 bg-black/30 border border-white/15 rounded-lg text-white text-sm focus:outline-none focus:ring-1 focus:ring-primary/50"
                />
                <Button size="sm" onClick={() => handleAddAttachment(editing.id!)} disabled={!attachNewUrl.trim() || !attachNewName.trim()} className="bg-primary hover:bg-primary/90 text-primary-foreground h-9 shrink-0">
                  <Plus className="w-4 h-4" />
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => attachFileInputRef.current?.click()}
                  className="h-9 px-3 border-white/20 text-muted-foreground hover:text-white gap-1.5 shrink-0"
                  title="Upload file"
                >
                  <Upload className="w-3.5 h-3.5" /> File
                </Button>
                <input
                  ref={attachFileInputRef}
                  type="file"
                  accept="image/jpeg,image/png,image/gif,image/webp,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                  className="hidden"
                  onChange={e => { const f = e.target.files?.[0]; if (f && editing.id) void handleAttachmentFileUpload(editing.id, f); e.target.value = ''; }}
                />
              </div>
            </div>
          )}

          {/* Actions */}
          <div className="flex gap-3 pt-2">
            <Button onClick={() => setEditing(null)} variant="outline" className="border-white/20" disabled={saving}>
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={saving} className="flex-1 bg-primary hover:bg-primary/90 text-primary-foreground">
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <><CheckCircle2 className="w-4 h-4 mr-2" />{editing.id ? 'Update Article' : 'Create Article'}</>}
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  // ── Article Detail Modal ─────────────────────────────────────────────────────
  if (selectedArticle !== null) {
    const art = selectedArticle;
    return (
      <div className="max-w-3xl mx-auto px-4 py-8 space-y-6">
        <div className="flex items-center gap-3">
          <button onClick={() => setSelectedArticle(null)} className="text-muted-foreground hover:text-white transition-colors">
            <X className="w-5 h-5" />
          </button>
          <div className="flex items-center gap-2 flex-wrap">
            {art.isPinned && <Badge className="bg-primary/20 text-primary border-primary/30 border text-[10px]"><Pin className="w-2.5 h-2.5 mr-1" />Pinned</Badge>}
            {art.isImportant && <Badge className="bg-amber-500/20 text-amber-300 border-amber-500/30 border text-[10px]"><AlertCircle className="w-2.5 h-2.5 mr-1" />Important</Badge>}
            {art.isSponsored && <Badge className="bg-orange-500/20 text-orange-300 border-orange-500/30 border text-[10px]"><Star className="w-2.5 h-2.5 mr-1" />Sponsored</Badge>}
            {art.categoryName && (
              <span className="text-[10px] px-2 py-0.5 rounded-full font-medium" style={{ backgroundColor: (art.categoryColor ?? '#C9A84C') + '22', color: art.categoryColor ?? '#C9A84C' }}>
                {art.categoryName}
              </span>
            )}
          </div>
        </div>

        <div>
          <h1 className="text-2xl font-display font-bold text-white leading-snug">{art.title}</h1>
          <div className="flex items-center gap-3 mt-2 text-xs text-muted-foreground">
            {art.authorName && <span>{art.authorName}</span>}
            <span>{timeAgo(art.publishedAt)}</span>
            <span className="flex items-center gap-1"><Eye className="w-3 h-3" /> {art.viewCount} views</span>
          </div>
        </div>

        {art.imageUrl && (
          <img src={art.imageUrl} alt="" className="w-full rounded-xl object-cover border border-white/10 max-h-80" onError={e => (e.currentTarget.style.display = 'none')} />
        )}

        <Card className="glass-panel border-white/10 p-6">
          <div
            className="text-white text-sm leading-relaxed prose-invert [&_h1]:text-xl [&_h1]:font-bold [&_h2]:text-base [&_h2]:font-bold [&_h2]:mt-4 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_a]:text-primary [&_a]:underline [&_strong]:text-white [&_em]:text-white/80 [&_p]:mb-3"
            dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(art.body, { ALLOWED_TAGS: ['p','br','b','strong','i','em','u','h1','h2','h3','ul','ol','li','a','span'], ALLOWED_ATTR: ['href','target','rel','class'] }) }}
          />
        </Card>

        {(art.attachments ?? []).length > 0 && (
          <Card className="glass-panel border-white/10 p-4">
            <h3 className="text-sm font-semibold text-white mb-3 flex items-center gap-2">
              <ExternalLink className="w-4 h-4 text-primary" /> Attachments
            </h3>
            <div className="space-y-2">
              {(art.attachments ?? []).map(att => (
                <a
                  key={att.url}
                  href={att.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-3 px-3 py-2.5 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 transition-colors"
                >
                  <ExternalLink className="w-4 h-4 text-primary shrink-0" />
                  <span className="text-sm text-white">{att.name}</span>
                  <span className="ml-auto text-xs text-muted-foreground">{att.type}</span>
                </a>
              ))}
            </div>
          </Card>
        )}

        {art.isSponsored && art.sponsorUrl && (
          <Button
            className="w-full bg-orange-600/80 hover:bg-orange-600 text-white gap-2"
            onClick={() => handleSponsorClick(art)}
          >
            <ExternalLink className="w-4 h-4" /> Visit Sponsor
          </Button>
        )}
      </div>
    );
  }

  // ── Main Page ───────────────────────────────────────────────────────────────
  return (
    <div className="max-w-5xl mx-auto px-4 py-8 space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-display font-bold text-white flex items-center gap-2">
            <Newspaper className="w-6 h-6 text-primary" /> Notice Board
          </h1>
          <p className="text-muted-foreground text-sm mt-1">Club news, notices, and member communications</p>
        </div>
        <div className="flex items-center gap-2">
          {isAdmin && (
            <Button onClick={seedDefaultCategories} variant="ghost" size="sm" className="text-muted-foreground hover:text-white text-xs" disabled={categories.length > 0}>
              Seed Default Categories
            </Button>
          )}
          {isAdmin && (
            <Button onClick={() => setEditing({ status: 'draft', isPinned: false, isImportant: false, isSponsored: false })} className="bg-primary hover:bg-primary/90 text-primary-foreground gap-2">
              <Plus className="w-4 h-4" /> New Article
            </Button>
          )}
        </div>
      </div>

      {/* Tabs */}
      {isAdmin && (
        <div className="flex items-center gap-1 bg-white/5 rounded-xl p-1 w-fit">
          {[{ key: 'feed', label: 'Member Feed' }, { key: 'admin', label: 'Manage Articles' }].map(t => (
            <button
              key={t.key}
              onClick={() => setTab(t.key as Tab)}
              className={`px-4 py-2 rounded-lg text-sm font-semibold transition-all ${tab === t.key ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-white'}`}
            >
              {t.label}
              {t.key === 'feed' && unreadCount > 0 && (
                <span className="ml-2 bg-red-500 text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full">{unreadCount}</span>
              )}
            </button>
          ))}
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap gap-3 items-center">
        <div className="relative flex-1 min-w-[200px] max-w-xs">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search articles..."
            className="w-full h-10 pl-9 pr-4 bg-black/30 border border-white/15 rounded-xl text-white placeholder:text-muted-foreground text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
          />
        </div>

        {/* Category filter */}
        {categories.length > 0 && (
          <div className="flex gap-1 flex-wrap">
            <button
              onClick={() => setCatFilter(null)}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${!catFilter ? 'bg-primary text-primary-foreground' : 'bg-white/5 text-muted-foreground hover:bg-white/10'}`}
            >All</button>
            {categories.map(c => (
              <button
                key={c.id}
                onClick={() => setCatFilter(catFilter === c.id ? null : c.id)}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors border ${catFilter === c.id ? 'text-white border-transparent' : 'bg-white/5 text-muted-foreground border-white/10 hover:bg-white/10'}`}
                style={catFilter === c.id ? { backgroundColor: c.color + '33', borderColor: c.color + '66', color: c.color } : {}}
              >{c.name}</button>
            ))}
          </div>
        )}

        {tab === 'admin' && (
          <div className="flex gap-1 ml-auto">
            {(['all', 'published', 'draft', 'scheduled', 'archived'] as StatusFilter[]).map(s => (
              <button
                key={s}
                onClick={() => setStatusFilter(s)}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold capitalize transition-colors ${statusFilter === s ? 'bg-white/10 text-white' : 'text-muted-foreground hover:text-white'}`}
              >{s}</button>
            ))}
          </div>
        )}

        <Button size="sm" variant="ghost" onClick={() => tab === 'admin' ? loadArticles() : loadFeed()} className="text-muted-foreground hover:text-white ml-auto">
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
        </Button>
      </div>

      {/* ── ADMIN TAB ── */}
      {tab === 'admin' && isAdmin && (
        <div className="space-y-4">
          {/* Category manager */}
          <div className="rounded-xl border border-white/10 bg-white/[0.02]">
            <button
              onClick={() => setShowCatManager(p => !p)}
              className="w-full flex items-center justify-between px-4 py-3 text-sm font-semibold text-white hover:bg-white/5 rounded-xl transition-colors"
            >
              <span className="flex items-center gap-2"><Tag className="w-4 h-4 text-primary" /> Categories ({categories.length})</span>
              {showCatManager ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            </button>
            {showCatManager && (
              <div className="px-4 pb-4 space-y-3 border-t border-white/5 pt-3">
                <div className="flex flex-wrap gap-2">
                  {categories.map(c => (
                    <div key={c.id} className="flex items-center gap-1.5 px-3 py-1 rounded-lg border text-xs font-medium" style={{ backgroundColor: c.color + '22', borderColor: c.color + '44', color: c.color }}>
                      {c.name}
                    </div>
                  ))}
                </div>
                <div className="flex gap-2 mt-2">
                  <input
                    value={newCatName}
                    onChange={e => setNewCatName(e.target.value)}
                    placeholder="Category name"
                    className="flex-1 h-9 px-3 bg-black/30 border border-white/15 rounded-lg text-white text-sm focus:outline-none focus:ring-1 focus:ring-primary/50"
                  />
                  <div className="flex items-center gap-1">
                    {Object.keys(CATEGORY_COLORS).map(c => (
                      <button key={c} onClick={() => setNewCatColor(c)} className={`w-5 h-5 rounded-full border-2 transition-transform ${newCatColor === c ? 'scale-125 border-white' : 'border-transparent'}`} style={{ backgroundColor: c }} />
                    ))}
                  </div>
                  <Button size="sm" onClick={handleAddCategory} disabled={!newCatName.trim()} className="bg-primary hover:bg-primary/90 text-primary-foreground h-9">
                    <Plus className="w-4 h-4" />
                  </Button>
                </div>
              </div>
            )}
          </div>

          {/* Articles list */}
          {loading ? (
            <div className="flex justify-center py-16"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
          ) : filteredArticles.length === 0 ? (
            <Card className="glass-panel border-white/10 p-12 text-center">
              <Newspaper className="w-10 h-10 text-muted-foreground opacity-30 mx-auto mb-3" />
              <p className="text-muted-foreground text-sm">No articles found.</p>
              <Button onClick={() => setEditing({ status: 'draft', isPinned: false, isImportant: false, isSponsored: false })} className="mt-4 bg-primary hover:bg-primary/90 text-primary-foreground gap-2">
                <Plus className="w-4 h-4" /> Create First Article
              </Button>
            </Card>
          ) : (
            <div className="space-y-3">
              {filteredArticles.map(article => {
                const ss = STATUS_STYLES[article.status] ?? STATUS_STYLES.draft;
                return (
                  <Card key={article.id} className="glass-panel border-white/10 p-4 hover:border-white/20 transition-all">
                    <div className="flex gap-4">
                      {article.imageUrl && (
                        <img src={article.imageUrl} alt="" className="w-16 h-16 rounded-xl object-cover shrink-0 border border-white/10" onError={e => (e.currentTarget.style.display = 'none')} />
                      )}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-start gap-2 flex-wrap">
                          {article.isPinned && <Pin className="w-3.5 h-3.5 text-primary shrink-0 mt-0.5" />}
                          {article.isImportant && <AlertCircle className="w-3.5 h-3.5 text-amber-400 shrink-0 mt-0.5" />}
                          {article.isSponsored && <Star className="w-3.5 h-3.5 text-orange-400 shrink-0 mt-0.5" />}
                          <h3 className="font-semibold text-white text-sm leading-tight flex-1 min-w-0 truncate">{article.title}</h3>
                          <Badge className={`text-[10px] px-2 py-0.5 border ${ss.cls} shrink-0`}>{ss.label}</Badge>
                          {article.categoryName && (
                            <span className="text-[10px] px-2 py-0.5 rounded-full font-medium" style={{ backgroundColor: (article.categoryColor ?? '#C9A84C') + '22', color: article.categoryColor ?? '#C9A84C' }}>
                              {article.categoryName}
                            </span>
                          )}
                        </div>
                        <p className="text-muted-foreground text-xs mt-1 line-clamp-2">{stripHtml(article.body)}</p>
                        <div className="flex items-center gap-4 mt-2 text-xs text-muted-foreground">
                          <span className="flex items-center gap-1"><Eye className="w-3 h-3" /> {article.viewCount}</span>
                          {article.isSponsored && <span className="flex items-center gap-1"><MousePointerClick className="w-3 h-3" /> {article.clickCount}</span>}
                          <span>{article.authorName}</span>
                          <span>{timeAgo(article.updatedAt)}</span>
                        </div>
                      </div>
                      {/* Actions */}
                      <div className="flex flex-col gap-1.5 shrink-0">
                        <Button size="sm" variant="ghost" className="h-7 px-2 text-muted-foreground hover:text-white" onClick={() => setEditing(article)} title="Edit">
                          <Edit2 className="w-3.5 h-3.5" />
                        </Button>
                        <Button size="sm" variant="ghost" className={`h-7 px-2 ${article.isPinned ? 'text-primary' : 'text-muted-foreground hover:text-white'}`} onClick={() => handlePin(article)} title={article.isPinned ? 'Unpin' : 'Pin'}>
                          {article.isPinned ? <Pin className="w-3.5 h-3.5" /> : <PinOff className="w-3.5 h-3.5" />}
                        </Button>
                        {article.status !== 'published' && (
                          <Button
                            size="sm"
                            className="h-7 px-2 bg-emerald-600/80 hover:bg-emerald-600 text-white text-xs"
                            onClick={() => handlePublish(article, article.isImportant)}
                            title="Publish"
                          >
                            <Send className="w-3.5 h-3.5" />
                          </Button>
                        )}
                        {article.status === 'published' && (
                          <Button size="sm" variant="ghost" className="h-7 px-2 text-muted-foreground hover:text-amber-400" onClick={() => handlePublish(article, true)} title="Send push notification">
                            <Bell className="w-3.5 h-3.5" />
                          </Button>
                        )}
                        {article.status !== 'archived' && (
                          <Button size="sm" variant="ghost" className="h-7 px-2 text-muted-foreground hover:text-red-400" onClick={() => handleArchive(article)} title="Archive">
                            <Archive className="w-3.5 h-3.5" />
                          </Button>
                        )}
                      </div>
                    </div>
                  </Card>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ── MEMBER FEED ── */}
      {tab === 'feed' && (
        <div className="space-y-4">
          {loading ? (
            <div className="flex justify-center py-16"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
          ) : filteredFeed.length === 0 ? (
            <Card className="glass-panel border-white/10 p-12 text-center">
              <Newspaper className="w-10 h-10 text-muted-foreground opacity-30 mx-auto mb-3" />
              <p className="text-muted-foreground text-sm">No notices published yet.</p>
            </Card>
          ) : (
            <div className="space-y-4">
              {filteredFeed.map(article => (
                <Card
                  key={article.id}
                  className={`glass-panel border transition-all cursor-pointer hover:border-white/20 ${!article.isRead ? 'border-primary/30 bg-primary/[0.03]' : 'border-white/10'}`}
                  onClick={() => handleOpenArticle(article)}
                >
                  {article.imageUrl && (
                    <img src={article.imageUrl} alt="" className="w-full h-48 object-cover rounded-t-xl border-b border-white/10" onError={e => (e.currentTarget.style.display = 'none')} />
                  )}
                  <div className="p-5">
                    <div className="flex items-start gap-3 mb-3">
                      {!article.isRead && <div className="w-2 h-2 rounded-full bg-primary shrink-0 mt-1.5" />}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap mb-1">
                          {article.isPinned && <Badge className="bg-primary/20 text-primary border-primary/30 border text-[10px]"><Pin className="w-2.5 h-2.5 mr-1" />Pinned</Badge>}
                          {article.isImportant && <Badge className="bg-amber-500/20 text-amber-300 border-amber-500/30 border text-[10px]"><AlertCircle className="w-2.5 h-2.5 mr-1" />Important</Badge>}
                          {article.isSponsored && <Badge className="bg-orange-500/20 text-orange-300 border-orange-500/30 border text-[10px]"><Star className="w-2.5 h-2.5 mr-1" />Sponsored</Badge>}
                          {article.categoryName && (
                            <span className="text-[10px] px-2 py-0.5 rounded-full font-medium" style={{ backgroundColor: (article.categoryColor ?? '#C9A84C') + '22', color: article.categoryColor ?? '#C9A84C' }}>
                              {article.categoryName}
                            </span>
                          )}
                        </div>
                        <h3 className="font-display font-bold text-white text-base leading-snug">{article.title}</h3>
                      </div>
                    </div>

                    <p className="text-muted-foreground text-sm leading-relaxed line-clamp-3">{stripHtml(article.body)}</p>

                    <div className="flex items-center justify-between mt-4 pt-3 border-t border-white/5">
                      <div className="flex items-center gap-3 text-xs text-muted-foreground">
                        {article.authorName && <span>{article.authorName}</span>}
                        <span>{timeAgo(article.publishedAt)}</span>
                        <span className="flex items-center gap-1"><Eye className="w-3 h-3" /> {article.viewCount}</span>
                        {(article.attachments ?? []).length > 0 && (
                          <span className="flex items-center gap-1"><ExternalLink className="w-3 h-3" /> {article.attachments.length} file{article.attachments.length !== 1 ? 's' : ''}</span>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-primary font-semibold">Read more →</span>
                        {article.isSponsored && article.sponsorUrl && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 text-xs border-orange-500/30 text-orange-300 hover:text-orange-200 hover:border-orange-400/50 gap-1"
                            onClick={e => { e.stopPropagation(); handleSponsorClick(article); }}
                          >
                            <ExternalLink className="w-3 h-3" /> Sponsor
                          </Button>
                        )}
                      </div>
                    </div>
                  </div>
                </Card>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
