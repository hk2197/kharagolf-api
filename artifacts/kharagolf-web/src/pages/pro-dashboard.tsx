import { useState, useEffect } from 'react';
import { useLocation } from 'wouter';
import {
  ChevronLeft, ChevronRight, User, Clock, Calendar,
  RefreshCw, CheckCircle2, X, BookOpen, FileText, Save,
} from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';
import { useGetMe } from '@workspace/api-client-react';

const GOLD = '#C9A84C';

interface Pro {
  id: number;
  displayName: string;
}

interface Booking {
  id: number;
  proId: number;
  lessonTypeId: number;
  userId: number | null;
  memberName: string;
  memberEmail: string | null;
  scheduledAt: string;
  durationMinutes: number;
  status: string;
  paymentStatus: string;
  amountPaise: number;
  lessonTypeName?: string;
  notes: string | null;
  cancelledAt: string | null;
}

interface Note {
  id: number;
  content: string;
  createdAt: string;
  updatedAt: string;
}

const STATUS_COLOR: Record<string, string> = {
  pending: 'bg-amber-500/20 text-amber-300 border-amber-500/30',
  confirmed: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30',
  cancelled: 'bg-red-500/20 text-red-300 border-red-500/30',
  completed: 'bg-blue-500/20 text-blue-300 border-blue-500/30',
  no_show: 'bg-white/10 text-white/50',
};

function formatDateLong(iso: string): string {
  return new Date(iso).toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
}

function formatPrice(paise: number): string {
  if (paise === 0) return 'Free';
  return `₹${(paise / 100).toLocaleString('en-IN')}`;
}

function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function toDateStr(d: Date): string {
  return d.toISOString().split('T')[0];
}

export default function ProDashboardPage() {
  const [, navigate] = useLocation();
  const { data: user } = useGetMe();
  const orgId = user?.organizationId as number;
  const { toast } = useToast();

  const [myPro, setMyPro] = useState<Pro | null | 'not_found'>('not_found');
  const [weekStart, setWeekStart] = useState<Date>(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - d.getDay());
    return d;
  });
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [loading, setLoading] = useState(false);
  const [noteDialog, setNoteDialog] = useState(false);
  const [selectedBooking, setSelectedBooking] = useState<Booking | null>(null);
  const [noteContent, setNoteContent] = useState('');
  const [existingNote, setExistingNote] = useState<Note | null>(null);
  const [savingNote, setSavingNote] = useState(false);
  const [completing, setCompleting] = useState<number | null>(null);

  useEffect(() => {
    if (!orgId) return;
    // Fetch only the pro profile linked to this user account
    fetch(`/api/organizations/${orgId}/lessons/pros/me`, { credentials: 'include' })
      .then(async (r) => {
        if (r.status === 404) { setMyPro(null); return; }
        if (!r.ok) { setMyPro(null); return; }
        const pro = await r.json() as Pro;
        setMyPro(pro);
      }).catch(() => setMyPro(null));
  }, [orgId]);

  const activePro = myPro && myPro !== 'not_found' ? myPro : null;

  useEffect(() => {
    if (!activePro || !orgId) return;
    loadSchedule();
  }, [activePro, weekStart, orgId]);

  async function loadSchedule() {
    if (!activePro || !orgId) return;
    setLoading(true);
    const from = toDateStr(weekStart);
    const to = toDateStr(addDays(weekStart, 6));
    try {
      const r = await fetch(
        `/api/organizations/${orgId}/lessons/pros/${activePro.id}/schedule?from=${from}T00:00:00Z&to=${to}T23:59:59Z`,
        { credentials: 'include' }
      );
      if (r.ok) setBookings(await r.json());
    } finally { setLoading(false); }
  }

  async function openNoteDialog(bk: Booking) {
    setSelectedBooking(bk);
    setNoteContent('');
    setExistingNote(null);
    setNoteDialog(true);
    try {
      const r = await fetch(`/api/organizations/${orgId}/lessons/bookings/${bk.id}/note`, { credentials: 'include' });
      if (r.ok) {
        const note = await r.json();
        setExistingNote(note);
        setNoteContent(note?.content ?? '');
      }
    } catch {}
  }

  async function saveNote() {
    if (!selectedBooking || !orgId) return;
    setSavingNote(true);
    try {
      const r = await fetch(`/api/organizations/${orgId}/lessons/bookings/${selectedBooking.id}/note`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ content: noteContent }),
      });
      if (r.ok) {
        toast({ title: 'Coaching note saved' });
        setNoteDialog(false);
      } else {
        const d = await r.json();
        toast({ title: d.error ?? 'Failed to save note', variant: 'destructive' });
      }
    } finally { setSavingNote(false); }
  }

  async function markCompleted(bk: Booking) {
    if (!orgId) return;
    setCompleting(bk.id);
    try {
      const r = await fetch(`/api/organizations/${orgId}/lessons/bookings/${bk.id}/complete`, {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
      });
      if (r.ok) { toast({ title: 'Lesson marked as completed' }); loadSchedule(); }
      else { const d = await r.json(); toast({ title: d.error ?? 'Failed', variant: 'destructive' }); }
    } finally { setCompleting(null); }
  }

  const weekDays = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));

  // Group bookings by date
  const grouped: Record<string, Booking[]> = {};
  for (const bk of bookings) {
    const d = toDateStr(new Date(bk.scheduledAt));
    if (!grouped[d]) grouped[d] = [];
    grouped[d].push(bk);
  }

  if (!orgId) return null;

  return (
    <div className="min-h-screen bg-[#0a0f1a] text-white p-4 md:p-8">
      <div className="max-w-4xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={() => navigate('/')}>
            <ChevronLeft className="w-5 h-5" />
          </Button>
          <div>
            <h1 className="text-2xl font-bold text-white">Pro Dashboard</h1>
            <p className="text-white/50 text-sm">Your upcoming teaching schedule</p>
          </div>
        </div>

        {/* Not a linked pro */}
        {myPro === null && (
          <Card className="bg-[#111827] border-[#1e2d3d] p-12 text-center">
            <User className="w-8 h-8 mx-auto mb-3 text-white/20" />
            <p className="text-white/50 text-sm">Your account is not linked to a teaching pro profile.</p>
            <p className="text-white/30 text-xs mt-1">Contact an administrator to link your profile.</p>
          </Card>
        )}

        {/* Week navigator — only shown for linked pros */}
        {activePro && <Card className="bg-[#111827] border-[#1e2d3d] p-4">
          <div className="flex items-center justify-between">
            <Button variant="ghost" size="icon" onClick={() => setWeekStart(w => addDays(w, -7))}>
              <ChevronLeft className="w-5 h-5" />
            </Button>
            <div className="text-center">
              <div className="text-xs text-white/50 mb-0.5">{activePro.displayName}</div>
              <div className="font-semibold text-white">
                {weekDays[0].toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })} –{' '}
                {weekDays[6].toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}
              </div>
              <div className="text-xs text-white/40 mt-0.5">{bookings.filter(b => b.status !== 'cancelled').length} bookings this week</div>
            </div>
            <Button variant="ghost" size="icon" onClick={() => setWeekStart(w => addDays(w, 7))}>
              <ChevronRight className="w-5 h-5" />
            </Button>
          </div>
        </Card>}

        {/* Schedule — only shown for linked pros */}
        {activePro && loading ? (
          <div className="flex justify-center py-16">
            <RefreshCw className="w-8 h-8 text-white/30 animate-spin" />
          </div>
        ) : activePro && Object.keys(grouped).length === 0 ? (
          <Card className="bg-[#111827] border-[#1e2d3d] p-12 text-center">
            <Calendar className="w-8 h-8 mx-auto mb-3 text-white/20" />
            <p className="text-white/40">No bookings this week.</p>
          </Card>
        ) : activePro ? (
          <div className="space-y-4">
            {weekDays.filter(d => grouped[toDateStr(d)]?.length > 0).map(d => {
              const ds = toDateStr(d);
              const dayBookings = grouped[ds] ?? [];
              return (
                <Card key={ds} className="bg-[#111827] border-[#1e2d3d]">
                  <div className="px-4 py-3 border-b border-white/5 flex items-center justify-between">
                    <div>
                      <span className="font-semibold text-white">
                        {d.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })}
                      </span>
                    </div>
                    <span className="text-xs text-white/40">{dayBookings.length} session{dayBookings.length !== 1 ? 's' : ''}</span>
                  </div>
                  <div className="divide-y divide-white/5">
                    {dayBookings.sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt)).map(bk => (
                      <div key={bk.id} className="p-4 flex items-start justify-between gap-4">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-medium text-white text-sm">{formatTime(bk.scheduledAt)}</span>
                            <span className="text-white/40 text-sm">·</span>
                            <span className="text-white/70 text-sm">{bk.memberName}</span>
                          </div>
                          <div className="text-xs text-white/40 mt-0.5">
                            {bk.lessonTypeName ?? 'Lesson'} · {bk.durationMinutes} min · {formatPrice(bk.amountPaise)}
                          </div>
                          {bk.notes && <p className="text-xs text-white/40 mt-1 italic">"{bk.notes}"</p>}
                        </div>
                        <div className="flex items-center gap-1.5 flex-shrink-0">
                          <Badge className={`text-xs capitalize ${STATUS_COLOR[bk.status] ?? ''}`}>{bk.status}</Badge>
                          {['confirmed', 'pending'].includes(bk.status) && (
                            <Button
                              size="sm" variant="ghost"
                              className="h-7 px-2 text-xs text-emerald-400 hover:text-emerald-300"
                              onClick={() => markCompleted(bk)}
                              disabled={completing === bk.id}
                            >
                              <CheckCircle2 className="w-3.5 h-3.5" />
                            </Button>
                          )}
                          {['confirmed', 'completed'].includes(bk.status) && (
                            <Button
                              size="sm" variant="ghost"
                              className="h-7 px-2 text-xs text-white/40 hover:text-white"
                              onClick={() => openNoteDialog(bk)}
                            >
                              <FileText className="w-3.5 h-3.5" />
                            </Button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </Card>
              );
            })}
          </div>
        ) : null}
      </div>

      {/* Coaching Note Dialog */}
      <Dialog open={noteDialog} onOpenChange={setNoteDialog}>
        <DialogContent className="bg-[#111827] border-[#1e2d3d] text-white">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <BookOpen className="w-4 h-4" style={{ color: GOLD }} />
              Coaching Notes
            </DialogTitle>
          </DialogHeader>
          {selectedBooking && (
            <div className="py-2 text-sm text-white/50">
              {selectedBooking.memberName} · {formatDateLong(selectedBooking.scheduledAt)}
            </div>
          )}
          <Textarea
            value={noteContent}
            onChange={e => setNoteContent(e.target.value)}
            placeholder="Enter private coaching notes for this session..."
            className="bg-white/5 border-white/20 text-white placeholder:text-white/30 min-h-[160px] resize-none"
          />
          {existingNote && (
            <p className="text-xs text-white/30">
              Last updated: {new Date(existingNote.updatedAt).toLocaleString('en-IN')}
            </p>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setNoteDialog(false)}>
              <X className="w-4 h-4 mr-1" /> Cancel
            </Button>
            <Button onClick={saveNote} disabled={savingNote || !noteContent.trim()} style={{ background: GOLD, color: '#000' }}>
              <Save className="w-4 h-4 mr-1" />
              {savingNote ? 'Saving...' : 'Save Note'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
