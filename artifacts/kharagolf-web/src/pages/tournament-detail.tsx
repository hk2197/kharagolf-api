import React, { useState, useEffect, useCallback } from 'react';
import { BarChart, Bar, LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { useParams } from 'wouter';
import { 
  useGetMe, useGetTournament, useListPlayers, useListTeeTimes, useListCourses,
  useGeneratePairings, usePublishTournament, useUpdateTournament,
  useRegisterPlayer, useRemovePlayer, useCheckInPlayer,
  getGetTournamentQueryKey, getListTeeTimesQueryKey, getListCoursesQueryKey,
  getGetCourseQueryOptions,
  type TournamentDetail, type CreateTournamentInputFormat, type TeeTimePlayersItem, type TeeTime,
  type CourseWithHoles,
} from '@workspace/api-client-react';

/**
 * Extended shape that the tournaments API actually returns beyond the generated schema.
 * The generated OpenAPI schema (TournamentDetail) only has course/flights, but the
 * server endpoint also returns these extra fields.  We use Omit<> on entryFee because
 * Drizzle's numeric column returns a string at runtime despite the schema saying number.
 * Using a type alias (not interface) avoids extends-conflict checking against Tournament.
 */
type TournamentDetailExt = Omit<TournamentDetail, 'entryFee'> & {
  selfPosting?: boolean;
  markerValidation?: boolean;
  checkInCutoffAt?: string | null;
  cutLine?: number | null;
  cutAfterRound?: number | null;
  cutPosition?: string | null;
  maxScoreCap?: number | null;
  stablefordPointsConfig?: {
    eagle?: number; birdie?: number; par?: number;
    bogey?: number; double?: number; worse?: number;
    bestOf?: number;
  } | null;
  handicapAllowance?: number | null;
  entryFee?: string | null;
  currency?: string | null;
  reminderDaysBefore?: number | null;
  mediaModerationEnabled?: boolean;
  tiebreakerMethod?: string | null;
  leaderboardType?: string | null;
  localRules?: string | null;
  courseConditions?: string | null;
  eventType?: string | null;
  localRulesConfig?: Record<string, unknown> | null;
  oddsWidgetsEnabled?: boolean;
  predictionsEnabled?: boolean;
};
import { useLiveLeaderboard } from '@/hooks/use-live';
import { PriceWithFx } from '@/components/PriceWithFx';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tooltip as UITooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Trophy, Users, Calendar, MapPin, Activity, ShieldCheck, Shield, Settings, UserPlus, Trash2, CheckCircle2, Upload, Download, Link2, BarChart2, Monitor, Flag, Plus, X, UserCheck, FileDown, Cloud, Wind, Printer, GitBranch, Shuffle, Layers, ArrowRight, Keyboard, Send, MessageSquare, Bell, Copy, RefreshCw, Eye, Image, Camera, MessageCircle, VolumeX, Star, Award, ExternalLink, KeyRound, ShieldAlert, ClipboardCopy, Globe, AlertTriangle, CheckCircle, XCircle, RotateCcw, Edit3, Loader2, Map as MapIcon, Lock, LockOpen, Play, Pause, Gavel, Timer, Briefcase, Heart, Building2, Target, FileText } from 'lucide-react';
import { EventDocumentsTab } from '@/components/event-documents-tab';
import { FlaggedRoundsBanner, type DataQualityRow } from '@/components/FlaggedRoundsBanner';
import { HoleReplayMap } from '@/components/hole-replay-map';
import { AutomationRulesPanel } from '@/components/AutomationRulesPanel';
import { ScorerGrid } from '@/components/scorer-grid';
import { LiveMessagePanel } from '@/components/live-message-panel';
import { RegistrationFormTab, SurveyTab } from '@/components/event-form-builder';
import { useQueryClient, useQuery, useQueries, useMutation } from '@tanstack/react-query';
import { useToast } from '@/hooks/use-toast';
import { useRef } from 'react';

function WeatherWidget() {
  const [weather, setWeather] = useState<{ temperature: number; windSpeed: number; windDirection: number; precipitation: number; weatherCode: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchWeather = useCallback(() => {
    if (!navigator.geolocation) { setError('Geolocation not supported'); return; }
    setLoading(true);
    navigator.geolocation.getCurrentPosition(async (pos) => {
      try {
        const { latitude, longitude } = pos.coords;
        const res = await fetch(`/api/public/weather?lat=${latitude}&lng=${longitude}`);
        if (!res.ok) throw new Error('Weather unavailable');
        const data = await res.json();
        setWeather(data);
      } catch { setError('Could not load weather'); } finally { setLoading(false); }
    }, () => { setError('Location denied'); setLoading(false); });
  }, []);

  const weatherIcon = (code: number) => {
    if (code === 0) return '☀️'; if (code <= 2) return '⛅'; if (code <= 48) return '🌫️';
    if (code <= 67) return '🌧️'; if (code <= 82) return '🌦️'; return '⛈️';
  };
  const windCompass = (deg: number) => ['N','NE','E','SE','S','SW','W','NW'][Math.round(deg / 45) % 8];

  return (
    <Card className="glass-card">
      <CardHeader className="pb-2">
        <CardTitle className="text-white flex items-center gap-2">
          <Cloud className="w-4 h-4 text-emerald-400" /> Course Weather
        </CardTitle>
      </CardHeader>
      <CardContent>
        {weather ? (
          <div className="space-y-3">
            <div className="flex items-center gap-3">
              <span className="text-4xl">{weatherIcon(weather.weatherCode)}</span>
              <div>
                <p className="text-3xl font-bold text-white">{Math.round(weather.temperature)}°C</p>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div className="flex items-center gap-2 text-muted-foreground">
                <Wind className="w-4 h-4 text-emerald-400" />
                <span>{Math.round(weather.windSpeed)} km/h {windCompass(weather.windDirection)}</span>
              </div>
              {weather.precipitation > 0 && (
                <div className="text-muted-foreground">💧 {weather.precipitation}mm rain</div>
              )}
            </div>
            <button onClick={fetchWeather} aria-label="Refresh weather" className="text-xs text-muted-foreground hover:text-white">↻ Refresh</button>
          </div>
        ) : loading ? (
          <div className="flex items-center gap-2 text-muted-foreground"><div className="w-4 h-4 rounded-full border-2 border-emerald-400 border-t-transparent animate-spin" /> Loading weather...</div>
        ) : error ? (
          <div className="space-y-2"><p className="text-sm text-muted-foreground">{error}</p><button onClick={fetchWeather} className="text-xs text-primary hover:underline">Try again</button></div>
        ) : (
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">Get real-time weather at the course location.</p>
            <button onClick={fetchWeather} className="text-sm text-primary hover:underline flex items-center gap-1"><Cloud className="w-3.5 h-3.5" /> Load Weather</button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

const FORMATS = [
  { value: 'stroke_play', label: 'Stroke Play' },
  { value: 'net_stroke', label: 'Net Stroke Play' },
  { value: 'stableford', label: 'Stableford' },
  { value: 'team_stableford', label: 'Team Stableford' },
  { value: 'maximum_score', label: 'Maximum Score (Stableford)' },
  { value: 'par_bogey', label: 'Par / Bogey' },
  { value: 'match_play', label: 'Match Play' },
  { value: 'match_play_bracket', label: 'Match Play Bracket' },
  { value: 'ryder_cup', label: 'Ryder Cup / Presidents Cup' },
  { value: 'scramble', label: 'Scramble' },
  { value: 'best_ball', label: 'Best Ball' },
  { value: 'skins', label: 'Skins' },
];

interface TournamentStaffMember {
  id: number;
  email: string;
  displayName: string | null;
  role: string;
  createdAt: string;
}

function TournamentStaffTab({ tournamentId }: { tournamentId: number }) {
  const { toast } = useToast();
  const [staff, setStaff] = useState<TournamentStaffMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [form, setForm] = useState({ email: '', role: 'live_scorer', displayName: '' });
  const [saving, setSaving] = useState(false);

  const fetchStaff = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/tournaments/${tournamentId}/staff`);
      if (res.ok) setStaff(await res.json());
    } finally { setLoading(false); }
  };

  useEffect(() => { fetchStaff(); }, [tournamentId]);

  const invite = async () => {
    if (!form.email) { toast({ title: 'Email is required', variant: 'destructive' }); return; }
    setSaving(true);
    try {
      const res = await fetch(`/api/tournaments/${tournamentId}/staff`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (!res.ok) { toast({ title: data.error || 'Failed to invite', variant: 'destructive' }); return; }
      toast({ title: 'Staff member added', description: `${form.email} added as ${form.role.replace(/_/g, ' ')}` });
      setInviteOpen(false);
      setForm({ email: '', role: 'live_scorer', displayName: '' });
      fetchStaff();
    } finally { setSaving(false); }
  };

  const revoke = async (id: number) => {
    await fetch(`/api/tournaments/${tournamentId}/staff/${id}`, { method: 'DELETE' });
    fetchStaff();
    toast({ title: 'Access revoked' });
  };

  const ROLE_LABELS: Record<string, string> = {
    tournament_admin: 'Tournament Admin',
    live_scorer: 'Live Scorer',
    volunteer: 'Volunteer',
  };

  return (
    <div className="space-y-4">
      <Card className="glass-card">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-white flex items-center gap-2">
              <ShieldAlert className="w-4 h-4 text-violet-400" /> Tournament Staff
            </CardTitle>
            <Button size="sm" onClick={() => setInviteOpen(true)} className="bg-violet-600 hover:bg-violet-700 text-white">
              <UserPlus className="w-3.5 h-3.5 mr-1.5" /> Invite Staff
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="text-muted-foreground text-sm py-4 text-center">Loading…</div>
          ) : staff.length === 0 ? (
            <div className="text-muted-foreground text-sm py-8 text-center">
              No staff assigned yet. Invite someone to help manage this tournament.
            </div>
          ) : (
            <div className="overflow-x-auto rounded-xl relative">
              <div className="pointer-events-none absolute top-0 right-0 bottom-0 w-8 bg-gradient-to-l from-black/40 to-transparent z-10" />
              <Table>
                <TableHeader>
                  <TableRow className="border-white/5 sticky top-0 z-10 bg-[#0a1628]">
                    <TableHead className="text-muted-foreground sticky left-0 z-10 bg-[#0a1628]">Name / Email</TableHead>
                    <TableHead className="text-muted-foreground">Role</TableHead>
                    <TableHead className="text-muted-foreground">Added</TableHead>
                    <TableHead className="text-muted-foreground text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {staff.map(s => (
                    <TableRow key={s.id} className="border-white/5">
                      <TableCell className="sticky left-0 z-10 bg-[#0a1628]">
                        <div>
                          {s.displayName && <p className="text-white text-sm font-medium">{s.displayName}</p>}
                          <p className="text-muted-foreground text-xs">{s.email}</p>
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge className="bg-violet-500/20 text-violet-400 border-violet-500/30 text-xs">
                          {ROLE_LABELS[s.role] || s.role}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-muted-foreground text-xs">
                        {new Date(s.createdAt).toLocaleDateString()}
                      </TableCell>
                      <TableCell className="text-right">
                        <button onClick={() => revoke(s.id)} aria-label="Revoke share link" className="text-muted-foreground hover:text-red-400 transition-colors p-1 rounded hover:bg-red-400/10">
                          <Trash2 aria-hidden="true" className="w-3.5 h-3.5" />
                        </button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={inviteOpen} onOpenChange={setInviteOpen}>
        <DialogContent className="bg-[#0a1628] border border-white/10 text-white max-w-md">
          <DialogHeader><DialogTitle>Invite Staff Member</DialogTitle></DialogHeader>
          <div className="space-y-4 mt-2">
            <div>
              <label className="text-xs text-muted-foreground uppercase tracking-wider">Email Address *</label>
              <Input value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
                placeholder="staff@example.com" className="mt-1 bg-black/40 border-white/10 text-white" />
            </div>
            <div>
              <label className="text-xs text-muted-foreground uppercase tracking-wider">Display Name</label>
              <Input value={form.displayName} onChange={e => setForm(f => ({ ...f, displayName: e.target.value }))}
                placeholder="Optional" className="mt-1 bg-black/40 border-white/10 text-white" />
            </div>
            <div>
              <label className="text-xs text-muted-foreground uppercase tracking-wider">Role *</label>
              <Select value={form.role} onValueChange={v => setForm(f => ({ ...f, role: v }))}>
                <SelectTrigger className="mt-1 bg-black/40 border-white/10 text-white"><SelectValue /></SelectTrigger>
                <SelectContent className="bg-[#0a1628] border-white/10 text-white">
                  <SelectItem value="tournament_admin" className="text-white hover:bg-white/5">Tournament Admin</SelectItem>
                  <SelectItem value="live_scorer" className="text-white hover:bg-white/5">Live Scorer</SelectItem>
                  <SelectItem value="volunteer" className="text-white hover:bg-white/5">Volunteer</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex gap-3 pt-2">
              <Button onClick={invite} disabled={saving} className="flex-1 bg-violet-600 hover:bg-violet-700 text-white">
                {saving ? 'Adding…' : 'Add Staff Member'}
              </Button>
              <Button variant="outline" onClick={() => setInviteOpen(false)} className="border-white/10 text-white hover:bg-white/5">Cancel</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/* ─── WHS / GHIN Score Posting Tab ──────────────────────────────── */

interface WhsPlayerRow {
  playerId: number;
  firstName: string;
  lastName: string;
  ghinNumber: string | null;
  grossScore: number | null;
  adjustedGrossScore: number | null;
  status: 'pending' | 'posted' | 'failed' | 'no_ghin';
  errorMessage: string | null;
  postedAt: string | null;
  postingId: number | null;
}

interface WhsStatusData {
  round: number;
  courseName: string | null;
  courseRating: number | null;
  slope: number | null;
  ghinConfigured: boolean;
  players: WhsPlayerRow[];
}

function WhsPostingTab({ orgId, tournamentId, rounds }: { orgId: number; tournamentId: number; rounds: number }) {
  const { toast } = useToast();
  const [selectedRound, setSelectedRound] = useState(1);
  const [data, setData] = useState<WhsStatusData | null>(null);
  const [loading, setLoading] = useState(false);
  const [posting, setPosting] = useState(false);
  const [retryingId, setRetryingId] = useState<number | null>(null);
  const [editingGhin, setEditingGhin] = useState<Record<number, string>>({});
  const [savingGhin, setSavingGhin] = useState<number | null>(null);

  // Editable course rating/slope overrides (null = use API value)
  const [ratingOverride, setRatingOverride] = useState<string>('');
  const [slopeOverride, setSlopeOverride] = useState<string>('');
  const [editingCourse, setEditingCourse] = useState(false);

  const fetchStatus = async (round: number) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/organizations/${orgId}/tournaments/${tournamentId}/rounds/${round}/post-whs`, { credentials: 'include' });
      if (res.ok) {
        const d = await res.json();
        setData(d);
        if (!editingCourse) {
          setRatingOverride(d.courseRating != null ? String(d.courseRating) : '');
          setSlopeOverride(d.slope != null ? String(d.slope) : '');
        }
      }
    } catch { /* ignore */ } finally { setLoading(false); }
  };

  useEffect(() => { fetchStatus(selectedRound); }, [orgId, tournamentId, selectedRound]);

  const postAll = async () => {
    setPosting(true);
    try {
      const ratingNum = ratingOverride ? parseFloat(ratingOverride) : null;
      const slopeNum = slopeOverride ? parseInt(slopeOverride) : null;
      const body: Record<string, unknown> = {};
      if (ratingNum !== null && !isNaN(ratingNum)) body.courseRating = ratingNum;
      if (slopeNum !== null && !isNaN(slopeNum)) body.slope = slopeNum;

      const res = await fetch(`/api/organizations/${orgId}/tournaments/${tournamentId}/rounds/${selectedRound}/post-whs`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const result = await res.json();
      if (!res.ok) { toast({ title: result.error ?? 'Posting failed', variant: 'destructive' }); return; }
      toast({ title: `Posted ${result.posted} score${result.posted !== 1 ? 's' : ''}`, description: result.failed > 0 ? `${result.failed} failed, ${result.noGhin} missing GHIN` : undefined });
      fetchStatus(selectedRound);
    } catch { toast({ title: 'Posting failed', variant: 'destructive' }); }
    finally { setPosting(false); }
  };

  const retryPlayer = async (playerId: number) => {
    setRetryingId(playerId);
    try {
      const res = await fetch(`/api/organizations/${orgId}/tournaments/${tournamentId}/rounds/${selectedRound}/players/${playerId}/retry-whs`, {
        method: 'POST', credentials: 'include',
      });
      const result = await res.json();
      if (!res.ok) { toast({ title: result.error ?? 'Retry failed', variant: 'destructive' }); return; }
      if (result.status === 'posted') {
        toast({ title: 'Score posted successfully' });
      } else {
        toast({ title: `Retry: ${result.status}`, description: result.error, variant: 'destructive' });
      }
      fetchStatus(selectedRound);
    } catch { toast({ title: 'Retry failed', variant: 'destructive' }); }
    finally { setRetryingId(null); }
  };

  const saveGhin = async (playerId: number) => {
    const ghinNumber = editingGhin[playerId];
    if (!ghinNumber?.trim()) { toast({ title: 'GHIN number required', variant: 'destructive' }); return; }
    setSavingGhin(playerId);
    try {
      const res = await fetch(`/api/organizations/${orgId}/tournaments/${tournamentId}/players/${playerId}/ghin`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ghinNumber: ghinNumber.trim() }),
      });
      if (!res.ok) { toast({ title: 'Save failed', variant: 'destructive' }); return; }
      toast({ title: 'GHIN number saved' });
      setEditingGhin(prev => { const n = { ...prev }; delete n[playerId]; return n; });
      fetchStatus(selectedRound);
    } catch { toast({ title: 'Save failed', variant: 'destructive' }); }
    finally { setSavingGhin(null); }
  };

  const statusBadge = (status: WhsPlayerRow['status']) => {
    switch (status) {
      case 'posted': return <Badge className="bg-emerald-500/20 text-emerald-400 border-emerald-500/30 text-xs flex items-center gap-1"><CheckCircle className="w-3 h-3" /> Posted</Badge>;
      case 'failed': return <Badge className="bg-red-500/20 text-red-400 border-red-500/30 text-xs flex items-center gap-1"><XCircle className="w-3 h-3" /> Failed</Badge>;
      case 'no_ghin': return <Badge className="bg-yellow-500/20 text-yellow-400 border-yellow-500/30 text-xs flex items-center gap-1"><AlertTriangle className="w-3 h-3" /> No GHIN</Badge>;
      default: return <Badge className="bg-gray-500/20 text-gray-400 border-gray-500/30 text-xs">Pending</Badge>;
    }
  };

  const players = data?.players ?? [];
  const postedCount = players.filter(p => p.status === 'posted').length;
  const failedCount = players.filter(p => p.status === 'failed').length;
  const noGhinCount = players.filter(p => p.status === 'no_ghin').length;
  const pendingCount = players.filter(p => p.status === 'pending').length;

  return (
    <div className="space-y-6">
      <Card className="glass-card">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <CardTitle className="text-white flex items-center gap-2">
              <Globe className="w-4 h-4 text-emerald-400" /> WHS / GHIN Score Posting
            </CardTitle>
            {rounds > 1 && (
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground font-medium">Round:</span>
                {Array.from({ length: rounds }, (_, i) => i + 1).map(r => (
                  <button key={r} onClick={() => setSelectedRound(r)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-bold border transition-all ${selectedRound === r ? 'bg-emerald-500/30 text-emerald-300 border-emerald-500/40' : 'bg-white/5 text-muted-foreground border-white/10 hover:text-white'}`}>
                    R{r}
                  </button>
                ))}
              </div>
            )}
            <Button onClick={postAll} disabled={posting || loading} className="bg-emerald-600 hover:bg-emerald-700 text-white gap-2">
              {posting ? <><div className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" /> Posting…</> : <><Globe className="w-3.5 h-3.5" /> Post All Scores</>}
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {!data?.ghinConfigured && (
            <div className="mb-4 p-3 rounded-xl bg-red-500/10 border border-red-500/20 flex items-start gap-3">
              <AlertTriangle className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-semibold text-red-400">GHIN credentials not configured</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  WHS score posting is disabled. Go to <strong className="text-white">Settings → GHIN / WHS</strong> to configure your organization's GHIN API credentials.
                  Posting scores without credentials will fail.
                </p>
              </div>
            </div>
          )}

          {data && (
            <div className="mb-4 p-3 rounded-xl bg-black/30 border border-white/5">
              <div className="flex items-center justify-between mb-2">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Round Parameters</p>
                <button
                  onClick={() => setEditingCourse(v => !v)}
                  className="text-xs text-muted-foreground hover:text-white transition-colors"
                >
                  {editingCourse ? 'Done' : 'Edit'}
                </button>
              </div>
              {editingCourse ? (
                <div className="grid grid-cols-3 gap-3">
                  <div className="space-y-1">
                    <label className="text-[10px] text-muted-foreground uppercase">Course</label>
                    <p className="text-sm text-white truncate">{data.courseName ?? '—'}</p>
                  </div>
                  <div className="space-y-1">
                    <label className="text-[10px] text-muted-foreground uppercase">Course Rating</label>
                    <Input
                      value={ratingOverride}
                      onChange={e => setRatingOverride(e.target.value)}
                      placeholder="e.g. 72.1"
                      className="bg-black/50 border-white/10 text-white h-7 text-xs"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[10px] text-muted-foreground uppercase">Slope</label>
                    <Input
                      value={slopeOverride}
                      onChange={e => setSlopeOverride(e.target.value)}
                      placeholder="e.g. 113"
                      className="bg-black/50 border-white/10 text-white h-7 text-xs"
                    />
                  </div>
                </div>
              ) : (
                <div className="flex gap-6 text-sm">
                  <div className="text-muted-foreground">Course: <span className="text-white">{data.courseName ?? '—'}</span></div>
                  {ratingOverride && <div className="text-muted-foreground">Rating: <span className="text-white">{ratingOverride}</span></div>}
                  {slopeOverride && <div className="text-muted-foreground">Slope: <span className="text-white">{slopeOverride}</span></div>}
                </div>
              )}
            </div>
          )}

          <div className="grid grid-cols-4 gap-3 mb-4">
            {[
              { label: 'Posted', value: postedCount, color: 'text-emerald-400' },
              { label: 'Pending', value: pendingCount, color: 'text-gray-400' },
              { label: 'Failed', value: failedCount, color: 'text-red-400' },
              { label: 'No GHIN', value: noGhinCount, color: 'text-yellow-400' },
            ].map(s => (
              <div key={s.label} className="glass-panel rounded-xl p-3 text-center">
                <p className={`text-xl font-bold ${s.color}`}>{s.value}</p>
                <p className="text-xs text-muted-foreground">{s.label}</p>
              </div>
            ))}
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-12">
              <div className="w-6 h-6 border-2 border-emerald-400 border-t-transparent rounded-full animate-spin" />
            </div>
          ) : players.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              <Globe className="w-10 h-10 mx-auto mb-3 opacity-30" />
              <p>No players registered for this tournament.</p>
            </div>
          ) : (
            <div className="overflow-x-auto rounded-xl relative">
              <div className="pointer-events-none absolute top-0 right-0 bottom-0 w-8 bg-gradient-to-l from-black/40 to-transparent z-10" />
            <Table>
              <TableHeader>
                <TableRow className="border-white/5 sticky top-0 z-10 bg-[#0a1628]">
                  <TableHead className="text-muted-foreground sticky left-0 z-10 bg-[#0a1628]">Player</TableHead>
                  <TableHead className="text-muted-foreground">GHIN Number</TableHead>
                  <TableHead className="text-muted-foreground text-right">Gross</TableHead>
                  <TableHead className="text-muted-foreground text-right">AGS</TableHead>
                  <TableHead className="text-muted-foreground">Status</TableHead>
                  <TableHead className="text-muted-foreground">Error / Info</TableHead>
                  <TableHead className="text-muted-foreground text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {players.map(p => {
                  const isEditing = p.playerId in editingGhin;
                  return (
                    <TableRow key={p.playerId} className="border-white/5">
                      <TableCell className="text-white font-medium sticky left-0 z-10 bg-[#0a1628]">{p.firstName} {p.lastName}</TableCell>
                      <TableCell>
                        {isEditing ? (
                          <div className="flex items-center gap-2">
                            <Input
                              value={editingGhin[p.playerId] ?? ''}
                              onChange={e => setEditingGhin(prev => ({ ...prev, [p.playerId]: e.target.value }))}
                              placeholder="Enter GHIN #"
                              className="bg-black/40 border-white/10 text-white h-8 w-32 text-sm"
                            />
                            <button onClick={() => saveGhin(p.playerId)} disabled={savingGhin === p.playerId}
                              className="text-emerald-400 hover:text-emerald-300 text-xs font-semibold disabled:opacity-50">
                              {savingGhin === p.playerId ? '…' : 'Save'}
                            </button>
                            <button onClick={() => setEditingGhin(prev => { const n = { ...prev }; delete n[p.playerId]; return n; })}
                              className="text-muted-foreground hover:text-white text-xs">
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <div className="flex items-center gap-2">
                            <span className={p.ghinNumber ? 'text-white font-mono text-sm' : 'text-muted-foreground text-sm italic'}>
                              {p.ghinNumber ?? 'Not set'}
                            </span>
                            <button onClick={() => setEditingGhin(prev => ({ ...prev, [p.playerId]: p.ghinNumber ?? '' }))}
                              className="text-muted-foreground hover:text-white p-0.5 rounded hover:bg-white/5">
                              <Edit3 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="text-right text-white font-mono text-sm">{p.grossScore ?? '—'}</TableCell>
                      <TableCell className="text-right text-white font-mono text-sm">{p.adjustedGrossScore ?? '—'}</TableCell>
                      <TableCell>{statusBadge(p.status)}</TableCell>
                      <TableCell className="text-xs text-muted-foreground max-w-[200px] truncate">
                        {p.status === 'posted' && p.postedAt ? `Posted ${new Date(p.postedAt).toLocaleDateString()}` : (p.errorMessage ?? '—')}
                      </TableCell>
                      <TableCell className="text-right">
                        {(p.status === 'failed' || p.status === 'no_ghin') && p.ghinNumber && (
                          <button onClick={() => retryPlayer(p.playerId)} disabled={retryingId === p.playerId}
                            className="text-muted-foreground hover:text-emerald-400 transition-colors p-1 rounded hover:bg-emerald-400/10 disabled:opacity-50"
                            title="Retry posting">
                            {retryingId === p.playerId ? <div className="w-3.5 h-3.5 border border-emerald-400/50 border-t-emerald-400 rounded-full animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />}
                          </button>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

interface ScorerPin {
  id: number;
  pin: string;
  label: string;
  expiresAt: string | null;
  isRevoked: boolean;
  createdAt: string;
}

/* ─── Signing Status Tab ─────────────────────────────────────────────────── */
interface SigningRow {
  playerId: number;
  firstName: string;
  lastName: string;
  handicapIndex: string | null;
  submissionId: number | null;
  round: number | null;
  status: string | null;
  totalStrokes: number | null;
  submittedAt: string | null;
  reviewedAt: string | null;
  rejectionReason: string | null;
  markerCode: string | null;
}

function SigningStatusTab({ orgId, tournamentId, rounds }: { orgId: number; tournamentId: number; rounds: number }) {
  const [rows, setRows] = useState<SigningRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterRound, setFilterRound] = useState(1);
  const { toast } = useToast();

  useEffect(() => { loadData(); }, [tournamentId]);

  async function loadData() {
    setLoading(true);
    try {
      const res = await fetch(`/api/organizations/${orgId}/tournaments/${tournamentId}/signing-status`, { credentials: 'include' });
      if (res.ok) setRows(await res.json());
    } catch { /**/ } finally { setLoading(false); }
  }

  const filtered = rows.filter(r => !r.round || r.round === filterRound);
  const approved = filtered.filter(r => r.status === 'countersigned' || r.status === 'overridden' || r.status === 'approved').length;
  const pending = filtered.filter(r => r.status === 'pending').length;
  const rejected = filtered.filter(r => r.status === 'disputed' || r.status === 'outstanding' || r.status === 'rejected').length;
  const notSubmitted = filtered.filter(r => !r.status).length;

  const submitted = filtered.filter(r => r.status === 'submitted').length;
  const overdueReview = filtered.filter(r => r.status === 'overdue_review').length;

  const STATUS_CELL: Record<string, { label: string; cls: string }> = {
    countersigned: { label: 'Counter-Signed', cls: 'bg-emerald-500/20 text-emerald-300' },
    approved: { label: 'Counter-Signed', cls: 'bg-emerald-500/20 text-emerald-300' },
    overridden: { label: 'Committee Override', cls: 'bg-blue-500/20 text-blue-300' },
    submitted: { label: 'Player Signed — Awaiting Marker', cls: 'bg-green-500/15 text-green-300' },
    pending:  { label: 'Awaiting Player Signature', cls: 'bg-amber-500/20 text-amber-300' },
    disputed: { label: 'Disputed', cls: 'bg-red-500/20 text-red-400' },
    rejected: { label: 'Disputed', cls: 'bg-red-500/20 text-red-400' },
    outstanding: { label: 'Outstanding (Past Deadline)', cls: 'bg-orange-500/20 text-orange-300' },
    overdue_review: { label: 'Overdue — Committee Review', cls: 'bg-rose-600/20 text-rose-300' },
  };

  return (
    <div className="space-y-4">
      {/* Summary bar */}
      <div className="flex flex-wrap gap-3">
        {[
          { label: 'Not Submitted', val: notSubmitted, cls: 'bg-white/5 text-white/50' },
          { label: 'Awaiting Signature', val: pending, cls: 'bg-amber-500/20 text-amber-300' },
          ...(submitted > 0 ? [{ label: 'Awaiting Marker', val: submitted, cls: 'bg-green-500/15 text-green-300' }] : []),
          ...(overdueReview > 0 ? [{ label: '⚠ Overdue Review', val: overdueReview, cls: 'bg-rose-600/20 text-rose-300 ring-1 ring-rose-500/40' }] : []),
          { label: 'Counter-Signed', val: approved, cls: 'bg-emerald-500/20 text-emerald-300' },
          { label: 'Disputed', val: rejected, cls: 'bg-red-500/20 text-red-400' },
        ].map(s => (
          <div key={s.label} className={`rounded-xl px-4 py-2 text-sm font-semibold ${s.cls}`}>
            {s.val} {s.label}
          </div>
        ))}
        <div className="flex-1" />
        {rounds > 1 && (
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">Round</span>
            <div className="flex gap-1">
              {Array.from({ length: rounds }, (_, i) => i + 1).map(r => (
                <button
                  key={r}
                  onClick={() => setFilterRound(r)}
                  className={`w-7 h-7 rounded-full text-xs font-bold transition-colors ${filterRound === r ? 'bg-cyan-500 text-white' : 'bg-white/10 text-white/60 hover:bg-white/20'}`}
                >
                  {r}
                </button>
              ))}
            </div>
          </div>
        )}
        <Button size="sm" variant="ghost" onClick={loadData} className="text-white/50 hover:text-white">
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
        </Button>
      </div>

      {/* Admin Escalation — overdue uncountersigned cards (submitted > 2 hours without countersign) */}
      {(() => {
        const overdueRows = filtered.filter(r =>
          (r.status === 'submitted' || r.status === 'pending') && r.submittedAt &&
          (Date.now() - new Date(r.submittedAt).getTime()) > 2 * 60 * 60 * 1000
        );
        if (overdueRows.length === 0) return null;
        return (
          <div className="rounded-xl border border-orange-500/30 bg-orange-500/10 p-4 space-y-3">
            <div className="flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-orange-400" />
              <p className="text-orange-300 font-semibold text-sm">{overdueRows.length} Uncountersigned Card{overdueRows.length > 1 ? 's' : ''} — Escalation Required</p>
            </div>
            <p className="text-xs text-orange-300/70">The following players submitted their round more than 2 hours ago without marker sign-off. As a Tournament Committee member, you may force-approve these cards.</p>
            <div className="space-y-2">
              {overdueRows.map(row => {
                const hrs = Math.floor((Date.now() - new Date(row.submittedAt!).getTime()) / 3600000);
                return (
                  <div key={row.playerId} className="flex items-center gap-3 px-3 py-2 rounded-lg bg-black/20">
                    <div className="flex-1">
                      <p className="text-white text-sm font-medium">{row.firstName} {row.lastName}</p>
                      <p className="text-xs text-muted-foreground">Round {row.round} · {row.totalStrokes ?? '—'} strokes · Waiting {hrs}h</p>
                    </div>
                    <Button
                      size="sm"
                      className="h-7 px-3 text-xs bg-orange-600 hover:bg-orange-500 text-white"
                      onClick={async () => {
                        if (!window.confirm(`Force-approve ${row.firstName} ${row.lastName}'s scorecard? This overrides the marker countersign requirement.`)) return;
                        await fetch(`/api/portal/submissions/${row.submissionId}/override`, {
                          method: 'POST', credentials: 'include',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ action: 'overridden', note: 'Committee override — scorecard deadline exceeded' }),
                        });
                        toast({ title: `${row.firstName}'s round approved by committee override`, description: 'Scores are now verified.' });
                        loadData();
                      }}
                    >Force Approve</Button>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })()}

      {/* Status Matrix */}
      {loading ? (
        <div className="flex justify-center py-12"><Loader2 className="w-6 h-6 text-muted-foreground animate-spin" /></div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground text-sm">No players found for this tournament.</div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-white/10 relative">
          <div className="pointer-events-none absolute top-0 right-0 bottom-0 w-8 bg-gradient-to-l from-black/40 to-transparent z-10" />
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/10 bg-[#0a1628] sticky top-0 z-10">
                <th className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider sticky left-0 z-20 bg-[#0a1628]">Player</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">H.I.</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">Score</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">Signing Status</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">Marker Code</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">Submitted</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {filtered.map(row => {
                const sc = row.status ? (STATUS_CELL[row.status] ?? { label: row.status, cls: 'bg-white/10 text-white/60' }) : { label: 'Not Submitted', cls: 'bg-white/5 text-white/30' };
                return (
                  <tr key={row.playerId} className="hover:bg-white/5 transition-colors">
                    <td className="px-4 py-3 font-medium text-white sticky left-0 z-10 bg-[#0a1628]">{row.firstName} {row.lastName}</td>
                    <td className="px-4 py-3 text-muted-foreground">{row.handicapIndex ? Number(row.handicapIndex).toFixed(1) : '—'}</td>
                    <td className="px-4 py-3 font-bold text-white">{row.totalStrokes ?? '—'}</td>
                    <td className="px-4 py-3">
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${sc.cls}`}>{sc.label}</span>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-muted-foreground">{row.markerCode ?? '—'}</td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">
                      {row.submittedAt ? new Date(row.submittedAt).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'}
                    </td>
                    <td className="px-4 py-3">
                      {(row.status === 'pending' || row.status === 'submitted') && row.submissionId && (
                        <div className="flex gap-1.5">
                          <Button
                            size="sm"
                            className="h-6 px-2 text-xs bg-emerald-600 hover:bg-emerald-500 text-white"
                            onClick={async () => {
                              if (!window.confirm(`Committee counter-sign ${row.firstName} ${row.lastName}'s scorecard?`)) return;
                              await fetch(`/api/portal/submissions/${row.submissionId}/override`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ action: 'overridden', note: 'Counter-signed by committee' }) });
                              toast({ title: 'Submission counter-signed by committee' });
                              loadData();
                            }}
                          >Counter-Sign</Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-6 px-2 text-xs text-amber-400 hover:text-amber-300 hover:bg-amber-500/10"
                            onClick={async () => {
                              const reason = window.prompt('Dispute reason:');
                              if (!reason) return;
                              await fetch(`/api/portal/submissions/${row.submissionId}/override`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ action: 'outstanding', note: reason }) });
                              toast({ title: 'Submission flagged as outstanding by committee' });
                              loadData();
                            }}
                          >Dispute</Button>
                        </div>
                      )}
                      {(row.status === 'rejected' || row.status === 'disputed' || row.status === 'outstanding') && row.submissionId && (
                        <div className="flex items-center gap-2">
                          {row.rejectionReason && <span className="text-xs text-red-400/70 italic truncate max-w-32">"{row.rejectionReason}"</span>}
                          <Button
                            size="sm"
                            className="h-6 px-2 text-xs bg-emerald-600 hover:bg-emerald-500 text-white shrink-0"
                            onClick={async () => {
                              const note = window.prompt('Committee override note (dispute resolved):') ?? 'Dispute resolved by committee';
                              await fetch(`/api/portal/submissions/${row.submissionId}/override`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ action: 'overridden', note }) });
                              toast({ title: 'Dispute resolved — scorecard overridden by committee' });
                              loadData();
                            }}
                          >Override</Button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ScorerPinsTab({ tournamentId }: { tournamentId: number }) {
  const { toast } = useToast();
  const [pins, setPins] = useState<ScorerPin[]>([]);
  const [loading, setLoading] = useState(true);
  const [addOpen, setAddOpen] = useState(false);
  const [form, setForm] = useState({ label: '', expiresAt: '' });
  const [saving, setSaving] = useState(false);

  const fetchPins = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/tournaments/${tournamentId}/scorer-pins`);
      if (res.ok) setPins(await res.json());
    } finally { setLoading(false); }
  };

  useEffect(() => { fetchPins(); }, [tournamentId]);

  const generate = async () => {
    if (!form.label) { toast({ title: 'Label is required', variant: 'destructive' }); return; }
    setSaving(true);
    try {
      const body: Record<string, string> = { label: form.label };
      if (form.expiresAt) body.expiresAt = form.expiresAt;
      const res = await fetch(`/api/tournaments/${tournamentId}/scorer-pins`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) { toast({ title: data.error || 'Failed to generate PIN', variant: 'destructive' }); return; }
      toast({ title: 'Scorer PIN generated', description: `PIN: ${data.pin}` });
      setAddOpen(false);
      setForm({ label: '', expiresAt: '' });
      fetchPins();
    } finally { setSaving(false); }
  };

  const revoke = async (id: number) => {
    await fetch(`/api/tournaments/${tournamentId}/scorer-pins/${id}`, { method: 'DELETE' });
    fetchPins();
    toast({ title: 'PIN revoked' });
  };

  const copyPin = (pin: string) => {
    navigator.clipboard.writeText(pin);
    toast({ title: 'PIN copied to clipboard' });
  };

  const isExpired = (expiresAt: string | null) => expiresAt && new Date(expiresAt) < new Date();

  return (
    <div className="space-y-4">
      <Card className="glass-card">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-white flex items-center gap-2">
              <KeyRound className="w-4 h-4 text-teal-400" /> Scorer PINs
            </CardTitle>
            <Button size="sm" onClick={() => setAddOpen(true)} className="bg-teal-600 hover:bg-teal-700 text-white">
              <Plus className="w-3.5 h-3.5 mr-1.5" /> Generate PIN
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground mb-4">
            Scorer PINs allow tournament-day scorers to access the scoring interface without a full admin account.
            Share a PIN to <code className="bg-white/5 px-1 rounded">/scorer</code>.
          </p>
          {loading ? (
            <div className="text-muted-foreground text-sm py-4 text-center">Loading…</div>
          ) : pins.length === 0 ? (
            <div className="text-muted-foreground text-sm py-8 text-center">
              No PINs generated yet. Create one for each scoring station.
            </div>
          ) : (
            <div className="space-y-2">
              {pins.map(p => {
                const expired = isExpired(p.expiresAt);
                const inactive = p.isRevoked || expired;
                return (
                  <div key={p.id} className={`flex items-center justify-between p-3 rounded-xl border ${inactive ? 'border-white/5 bg-white/2 opacity-60' : 'border-white/10 bg-white/5'}`}>
                    <div className="flex items-center gap-3">
                      <div className={`font-mono text-lg font-bold tracking-widest ${inactive ? 'text-muted-foreground' : 'text-teal-400'}`}>
                        {p.pin}
                      </div>
                      <div>
                        <p className="text-white text-sm font-medium">{p.label}</p>
                        <div className="flex items-center gap-2 mt-0.5">
                          {p.isRevoked && <Badge className="bg-red-500/20 text-red-400 border-red-500/30 text-xs">Revoked</Badge>}
                          {expired && !p.isRevoked && <Badge className="bg-orange-500/20 text-orange-400 border-orange-500/30 text-xs">Expired</Badge>}
                          {!inactive && <Badge className="bg-teal-500/20 text-teal-400 border-teal-500/30 text-xs">Active</Badge>}
                          {p.expiresAt && (
                            <span className="text-xs text-muted-foreground">
                              Expires {new Date(p.expiresAt).toLocaleDateString()}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5">
                      {!inactive && (
                        <button onClick={() => copyPin(p.pin)} className="text-muted-foreground hover:text-teal-400 transition-colors p-1.5 rounded hover:bg-teal-400/10" title="Copy PIN">
                          <ClipboardCopy className="w-3.5 h-3.5" />
                        </button>
                      )}
                      {!p.isRevoked && (
                        <button onClick={() => revoke(p.id)} className="text-muted-foreground hover:text-red-400 transition-colors p-1.5 rounded hover:bg-red-400/10" title="Revoke PIN">
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="bg-[#0a1628] border border-white/10 text-white max-w-md">
          <DialogHeader><DialogTitle>Generate Scorer PIN</DialogTitle></DialogHeader>
          <div className="space-y-4 mt-2">
            <div>
              <label className="text-xs text-muted-foreground uppercase tracking-wider">Label *</label>
              <Input value={form.label} onChange={e => setForm(f => ({ ...f, label: e.target.value }))}
                placeholder="e.g. Starter's Table, Hole 9 Kiosk" className="mt-1 bg-black/40 border-white/10 text-white" />
            </div>
            <div>
              <label className="text-xs text-muted-foreground uppercase tracking-wider">Expires At (optional)</label>
              <Input type="datetime-local" value={form.expiresAt} onChange={e => setForm(f => ({ ...f, expiresAt: e.target.value }))}
                className="mt-1 bg-black/40 border-white/10 text-white" />
            </div>
            <div className="flex gap-3 pt-2">
              <Button onClick={generate} disabled={saving} className="flex-1 bg-teal-600 hover:bg-teal-700 text-white">
                {saving ? 'Generating…' : 'Generate PIN'}
              </Button>
              <Button variant="outline" onClick={() => setAddOpen(false)} className="border-white/10 text-white hover:bg-white/5">Cancel</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

type ScoringEvent = {
  tournamentId: number;
  playerName: string;
  holeNumber: number;
  strokes: number;
  par: number;
  toPar: number;
  eventType: 'hole_in_one' | 'eagle' | 'birdie';
  occurredAt: string;
};

function LiveActivityStrip({ tournamentId }: { tournamentId: number }) {
  const [events, setEvents] = useState<ScoringEvent[]>([]);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    const base = import.meta.env.BASE_URL?.replace('/kharagolf-web', '') || '';
    const url = `${base}/api/sse/leaderboard/${tournamentId}`;
    const es = new EventSource(url);

    es.onmessage = (e: MessageEvent) => {
      try {
        const msg = JSON.parse(e.data) as { type: string; data: ScoringEvent };
        if (msg.type === 'scoring_event') {
          setEvents((prev) => [msg.data, ...prev].slice(0, 10));
        }
      } catch { /* ignore */ }
    };

    es.onerror = () => {};
    return () => { es.close(); };
  }, [tournamentId]);

  const eventColor = (type: ScoringEvent['eventType']) =>
    type === 'hole_in_one' ? '#F5C842' : type === 'eagle' ? '#F5C842' : '#EF4444';
  const eventLabel = (ev: ScoringEvent) =>
    ev.eventType === 'hole_in_one' ? '⛳ Hole-in-One!' :
    ev.eventType === 'eagle' ? '🦅 Eagle' : '🐦 Birdie';
  const relTime = (iso: string) => {
    const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
    return m < 1 ? 'just now' : m < 60 ? `${m}m ago` : `${Math.floor(m / 60)}h ago`;
  };

  return (
    <div className="border border-white/10 rounded-xl overflow-hidden bg-black/30">
      <button
        onClick={() => setCollapsed((c) => !c)}
        className="w-full flex items-center justify-between px-4 py-3 bg-black/20 hover:bg-black/30 transition-colors"
      >
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-white">Live Activity</span>
          {events.length > 0 && (
            <span className="text-xs bg-red-500 text-white rounded-full px-1.5 py-0.5 font-bold animate-pulse">
              {events.length}
            </span>
          )}
          <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
        </div>
        <span className="text-muted-foreground text-xs">{collapsed ? '▼ Show' : '▲ Hide'}</span>
      </button>
      {!collapsed && (
        events.length === 0 ? (
          <div className="px-4 py-6 text-center">
            <p className="text-muted-foreground text-sm">Listening for birdies, eagles &amp; hole-in-ones…</p>
            <p className="text-muted-foreground text-xs mt-1 opacity-60">Events will appear here as scores are submitted.</p>
          </div>
        ) : (
          <div className="divide-y divide-white/5 max-h-72 overflow-y-auto">
            {events.map((ev, i) => (
              <div key={i} className="flex items-center gap-3 px-4 py-2.5">
                <div
                  className="shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-sm"
                  style={{ background: `${eventColor(ev.eventType)}22` }}
                >
                  {ev.eventType === 'hole_in_one' ? '⛳' : ev.eventType === 'eagle' ? '🦅' : '🐦'}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-white font-medium leading-tight">
                    <span style={{ color: eventColor(ev.eventType) }}>{eventLabel(ev)}</span>
                    {' — '}{ev.playerName}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Hole {ev.holeNumber} · {ev.strokes} strokes (par {ev.par})
                  </p>
                </div>
                <span className="text-xs text-muted-foreground shrink-0">{relTime(ev.occurredAt)}</span>
              </div>
            ))}
          </div>
        )
      )}
    </div>
  );
}

type SurveyAggregate =
  | { id: string; label: string; type: 'rating'; count: number; average: number | null; distribution: Record<string, number> }
  | { id: string; label: string; type: 'boolean'; count: number; yes: number; no: number }
  | { id: string; label: string; type: 'text'; count: number; answers: Array<{ text: string; respondent: string; submittedAt: string }> };

interface SurveyResponsesData {
  survey: { id: number; sentAt: string | null; reminderSentAt: string | null; closesAt: string | null; questions: unknown } | null;
  totalResponses: number;
  // Task #1626 — number of registered players in the tournament; the
  // denominator for the response-rate display.
  eligiblePlayers: number;
  aggregates: SurveyAggregate[];
}

export function PostEventSurveyResponsesPanel({ orgId, tournamentId }: { orgId: number; tournamentId: number }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data, isLoading, error, refetch, isFetching } = useQuery<SurveyResponsesData>({
    queryKey: [`/api/organizations/${orgId}/tournaments/${tournamentId}/survey/responses`],
    queryFn: async () => {
      const r = await fetch(`/api/organizations/${orgId}/tournaments/${tournamentId}/survey/responses`, { credentials: 'include' });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? 'Failed to load responses');
      return r.json() as Promise<SurveyResponsesData>;
    },
    enabled: !!orgId && !!tournamentId,
  });

  // Task #1634 — let admins scope the CSV export to a date window. Date inputs
  // produce YYYY-MM-DD strings; we widen 'to' to end-of-day so the picker
  // intuitively means "include responses on this day" rather than "midnight".
  //
  // Task #2029 — admins who export "last week's responses" for a recurring
  // committee meeting were re-typing both dates on every visit. Persist the
  // last-used range in localStorage, scoped per tournament so different events
  // don't bleed into each other. The matching "Clear" button below resets the
  // pickers and removes the saved value.
  const exportRangeStorageKey = `tournament-detail.exportRange.${orgId}.${tournamentId}`;
  const readStoredExportRange = (): { from: string; to: string } => {
    if (typeof window === 'undefined') return { from: '', to: '' };
    try {
      const raw = window.localStorage.getItem(exportRangeStorageKey);
      if (!raw) return { from: '', to: '' };
      const parsed = JSON.parse(raw) as { from?: unknown; to?: unknown };
      const from = typeof parsed.from === 'string' ? parsed.from : '';
      const to = typeof parsed.to === 'string' ? parsed.to : '';
      return { from, to };
    } catch {
      return { from: '', to: '' };
    }
  };
  const [exportFrom, setExportFrom] = useState<string>(() => readStoredExportRange().from);
  const [exportTo, setExportTo] = useState<string>(() => readStoredExportRange().to);
  // The storage key is derived from props, so re-hydrate when the admin
  // navigates between tournaments without unmounting the panel.
  useEffect(() => {
    const stored = readStoredExportRange();
    setExportFrom(stored.from);
    setExportTo(stored.to);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exportRangeStorageKey]);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!exportFrom && !exportTo) {
      window.localStorage.removeItem(exportRangeStorageKey);
      return;
    }
    window.localStorage.setItem(
      exportRangeStorageKey,
      JSON.stringify({ from: exportFrom, to: exportTo }),
    );
  }, [exportRangeStorageKey, exportFrom, exportTo]);
  const exportRangeInvalid = !!exportFrom && !!exportTo && exportFrom > exportTo;
  const exportRangeSet = !!exportFrom || !!exportTo;
  const handleClearExportRange = () => {
    setExportFrom('');
    setExportTo('');
    if (typeof window !== 'undefined') {
      window.localStorage.removeItem(exportRangeStorageKey);
    }
  };

  // Task #2028 — translate the YYYY-MM-DD picker values into the same ISO
  // strings we send to the CSV endpoint, so the windowed-count hint and the
  // eventual export agree on which responses fall inside the window.
  const exportFromIso = exportFrom ? new Date(`${exportFrom}T00:00:00.000Z`).toISOString() : '';
  const exportToIso = exportTo ? new Date(`${exportTo}T23:59:59.999Z`).toISOString() : '';

  const handleExportCsv = () => {
    const params = new URLSearchParams();
    if (exportFromIso) params.set('from', exportFromIso);
    if (exportToIso) params.set('to', exportToIso);
    const qs = params.toString();
    window.location.href = `/api/organizations/${orgId}/tournaments/${tournamentId}/survey/responses.csv${qs ? `?${qs}` : ''}`;
  };

  // Task #2028 — show "X of Y responses in window" so admins can sanity-check
  // a tight date window before exporting. We hit a lightweight count
  // endpoint (rather than recomputing client-side) because the aggregates
  // feed only carries timestamps for text answers — rating/boolean answers
  // don't expose per-response submission times. The query is gated on a
  // valid range with at least one picker set, so the hint clears
  // automatically when both pickers are empty.
  const exportRangeActive = (!!exportFrom || !!exportTo) && !exportRangeInvalid && !!data?.survey;
  const windowedCountQuery = useQuery<{ count: number }>({
    queryKey: [
      `/api/organizations/${orgId}/tournaments/${tournamentId}/survey/responses/count`,
      exportFromIso,
      exportToIso,
    ],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (exportFromIso) params.set('from', exportFromIso);
      if (exportToIso) params.set('to', exportToIso);
      const r = await fetch(
        `/api/organizations/${orgId}/tournaments/${tournamentId}/survey/responses/count?${params.toString()}`,
        { credentials: 'include' },
      );
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? 'Failed to count responses');
      return r.json() as Promise<{ count: number }>;
    },
    enabled: exportRangeActive,
  });

  // Task #2010 — let admins fire the post-event survey reminder from the
  // responses screen. The endpoint is idempotent (one reminder per survey),
  // so the button disables once the API surfaces a `reminderSentAt` stamp,
  // and we refetch the responses query so the timestamp shows up immediately.
  const sendReminder = useMutation({
    mutationFn: async (): Promise<{ remindersSent: number; reminderSentAt: string | null; note?: string }> => {
      const r = await fetch(
        `/api/organizations/${orgId}/tournaments/${tournamentId}/survey/remind`,
        { method: 'POST', credentials: 'include' },
      );
      const body = await r.json().catch(() => ({}));
      if (!r.ok) {
        const err = new Error(body.error ?? `HTTP ${r.status}`) as Error & { status?: number; reminderSentAt?: string | null };
        err.status = r.status;
        if (body.reminderSentAt) err.reminderSentAt = body.reminderSentAt;
        throw err;
      }
      return body as { remindersSent: number; reminderSentAt: string | null; note?: string };
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({
        queryKey: [`/api/organizations/${orgId}/tournaments/${tournamentId}/survey/responses`],
      });
      if (result.remindersSent === 0) {
        // Every registered player either submitted already or has no linked
        // account — the API leaves `reminderSentAt` untouched in this case.
        toast({
          title: 'No reminders to send',
          description: 'Every registered player has already submitted or has no linked account.',
        });
        return;
      }
      toast({
        title: 'Reminder sent',
        description: `Reminded ${result.remindersSent} ${result.remindersSent === 1 ? 'player' : 'players'}.`,
      });
    },
    onError: (err: Error & { status?: number; reminderSentAt?: string | null }) => {
      // 409 → another admin already fired it. Refresh so the disabled state
      // and timestamp render correctly instead of leaving the button live.
      if (err.status === 409) {
        queryClient.invalidateQueries({
          queryKey: [`/api/organizations/${orgId}/tournaments/${tournamentId}/survey/responses`],
        });
        toast({
          title: 'Reminder already sent',
          description: err.reminderSentAt
            ? `Sent on ${new Date(err.reminderSentAt).toLocaleString()}.`
            : 'A reminder has already been sent for this survey.',
        });
        return;
      }
      // 410 → survey closed. Refresh so the button hides on the next render.
      if (err.status === 410) {
        queryClient.invalidateQueries({
          queryKey: [`/api/organizations/${orgId}/tournaments/${tournamentId}/survey/responses`],
        });
        toast({
          title: 'Survey is closed',
          description: 'Reminders can only be sent while the survey is still accepting responses.',
          variant: 'destructive',
        });
        return;
      }
      toast({
        title: 'Could not send reminder',
        description: err.message,
        variant: 'destructive',
      });
    },
  });

  if (isLoading) {
    return (
      <Card className="glass-card" data-testid="survey-responses-loading">
        <CardContent className="py-12 flex items-center justify-center text-muted-foreground">
          <Loader2 className="w-5 h-5 mr-2 animate-spin" /> Loading survey responses…
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card className="glass-card" data-testid="survey-responses-error">
        <CardContent className="py-8 text-center space-y-3">
          <AlertTriangle className="w-8 h-8 text-amber-400 mx-auto" />
          <p className="text-white">Could not load survey responses.</p>
          <p className="text-xs text-muted-foreground">{(error as Error).message}</p>
          <Button size="sm" variant="outline" onClick={() => refetch()}>Retry</Button>
        </CardContent>
      </Card>
    );
  }

  if (!data?.survey) {
    return (
      <Card className="glass-card" data-testid="survey-responses-empty">
        <CardHeader>
          <CardTitle className="text-white flex items-center gap-2">
            <BarChart2 className="w-4 h-4 text-purple-300" /> Survey responses
          </CardTitle>
        </CardHeader>
        <CardContent className="py-8 text-center space-y-3">
          <MessageSquare className="w-10 h-10 text-muted-foreground mx-auto" />
          <p className="text-white font-medium">No survey has been sent yet.</p>
          <p className="text-sm text-muted-foreground">Use the “Send survey” button above to invite registered players for feedback.</p>
        </CardContent>
      </Card>
    );
  }

  const sentAt = data.survey.sentAt ? new Date(data.survey.sentAt).toLocaleString() : 'Not yet sent';
  const closesAt = data.survey.closesAt ? new Date(data.survey.closesAt).toLocaleString() : null;

  // Task #2010 — surface the existing reminder timestamp in the header and gate
  // the "Send reminder" button. We treat `closesAt` strictly in the past as
  // "closed" to mirror the API's 410 condition.
  const reminderSentAtIso = data.survey.reminderSentAt;
  const reminderSentAtLabel = reminderSentAtIso ? new Date(reminderSentAtIso).toLocaleString() : null;
  const surveyClosed = !!data.survey.closesAt && new Date(data.survey.closesAt).getTime() <= Date.now();

  return (
    <div className="space-y-4" data-testid="survey-responses-panel">
      <Card className="glass-card">
        <CardHeader className="flex flex-row items-start justify-between gap-4">
          <div>
            <CardTitle className="text-white flex items-center gap-2">
              <BarChart2 className="w-4 h-4 text-purple-300" /> Survey responses
            </CardTitle>
            <div className="text-xs text-muted-foreground mt-2 space-x-3">
              <span>Sent: <span className="text-white">{sentAt}</span></span>
              {closesAt && <span>Closes: <span className="text-white">{closesAt}</span></span>}
              {reminderSentAtLabel && (
                <span data-testid="survey-reminder-sent-at">
                  Reminder sent: <span className="text-white">{reminderSentAtLabel}</span>
                </span>
              )}
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className="text-right">
              {/* Task #1626 — Show "12 / 48 (25%)" so admins can read 12 responses
                  as a great showing or a disaster instead of a number with no
                  denominator. Falls back to just the count when no players are
                  registered yet (avoids "12 / 0 (NaN%)"). */}
              <div className="text-3xl font-bold text-white" data-testid="survey-total-responses">
                {data.totalResponses}
                {data.eligiblePlayers > 0 && (
                  <>
                    <span className="text-muted-foreground"> / </span>
                    <span data-testid="survey-eligible-players">{data.eligiblePlayers}</span>
                    <span
                      className="ml-2 text-base font-semibold text-purple-300"
                      data-testid="survey-response-rate"
                    >
                      ({Math.min(100, Math.round((data.totalResponses / data.eligiblePlayers) * 100))}%)
                    </span>
                  </>
                )}
              </div>
              <div className="text-xs text-muted-foreground uppercase tracking-wider">
                {data.eligiblePlayers > 0 ? 'Response rate' : 'Responses'}
              </div>
            </div>
            <div className="flex flex-col gap-1">
              <div className="flex items-end gap-2">
                <div className="flex flex-col">
                  <label htmlFor="export-from" className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">From</label>
                  <Input
                    id="export-from"
                    type="date"
                    value={exportFrom}
                    onChange={(e) => setExportFrom(e.target.value)}
                    className="h-9 w-36"
                    data-testid="input-export-from"
                  />
                </div>
                <div className="flex flex-col">
                  <label htmlFor="export-to" className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">To</label>
                  <Input
                    id="export-to"
                    type="date"
                    value={exportTo}
                    onChange={(e) => setExportTo(e.target.value)}
                    className="h-9 w-36"
                    data-testid="input-export-to"
                  />
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleExportCsv}
                  disabled={data.totalResponses === 0 || exportRangeInvalid}
                  data-testid="button-export-responses-csv"
                  title={
                    exportRangeInvalid
                      ? "'From' must be on or before 'To'"
                      : data.totalResponses === 0
                        ? 'No responses to export yet'
                        : 'Download responses as a CSV spreadsheet'
                  }
                >
                  <FileDown className="w-3.5 h-3.5 mr-1.5" /> Export CSV
                </Button>
                {/* Task #2029 — small companion to the persisted pickers: clears
                    both inputs and the saved range for this tournament. Only
                    rendered when at least one date is set so it doesn't add
                    visual noise when there's nothing to clear. */}
                {exportRangeSet && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={handleClearExportRange}
                    data-testid="button-clear-export-range"
                    title="Clear the saved date range for this tournament"
                  >
                    <X className="w-3.5 h-3.5 mr-1.5" /> Clear
                  </Button>
                )}
              </div>
              {/* Task #2028 — "X of Y responses in window" hint, only shown
                  while at least one date picker is set and the range is
                  valid. Lets admins picking a tight window confirm whether
                  the export will contain 1 row or 100 before downloading. */}
              {exportRangeInvalid ? (
                <p className="text-[11px] text-rose-300 text-right" data-testid="export-range-error">
                  'From' must be on or before 'To'
                </p>
              ) : exportRangeActive ? (
                <p
                  className="text-[11px] text-muted-foreground text-right"
                  data-testid="export-window-count"
                >
                  {windowedCountQuery.isLoading || windowedCountQuery.isFetching
                    ? 'Counting responses in window…'
                    : windowedCountQuery.error
                      ? 'Could not count responses in window'
                      : (
                        <>
                          <span className="text-white font-medium" data-testid="export-window-count-numerator">
                            {windowedCountQuery.data?.count ?? 0}
                          </span>
                          {' of '}
                          <span data-testid="export-window-count-denominator">{data.totalResponses}</span>
                          {` ${data.totalResponses === 1 ? 'response' : 'responses'} in window`}
                        </>
                      )}
                </p>
              ) : null}
            </div>
            {/* Task #2010 — admin-only "Send reminder" affordance. Hidden once
                the survey has closed (the API would 410), and disabled once a
                reminder has fired (one reminder per survey is the agreed
                window — surfaced via a tooltip with the timestamp). */}
            {!surveyClosed && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => sendReminder.mutate()}
                disabled={!!reminderSentAtIso || sendReminder.isPending}
                data-testid="button-send-survey-reminder"
                title={
                  reminderSentAtLabel
                    ? `Reminder already sent on ${reminderSentAtLabel}`
                    : 'Nudge registered players who have not responded yet'
                }
              >
                <Bell className={`w-3.5 h-3.5 mr-1.5 ${sendReminder.isPending ? 'animate-pulse' : ''}`} />
                {sendReminder.isPending
                  ? 'Sending…'
                  : reminderSentAtLabel
                    ? `Reminder sent ${reminderSentAtLabel}`
                    : 'Send reminder'}
              </Button>
            )}
            <Button size="sm" variant="outline" onClick={() => refetch()} disabled={isFetching} data-testid="button-refresh-responses">
              <RefreshCw className={`w-3.5 h-3.5 mr-1.5 ${isFetching ? 'animate-spin' : ''}`} /> Refresh
            </Button>
          </div>
        </CardHeader>
      </Card>

      {data.aggregates.length === 0 && (
        <Card className="glass-card">
          <CardContent className="py-8 text-center text-muted-foreground text-sm">
            This survey has no questions configured.
          </CardContent>
        </Card>
      )}

      {data.aggregates.map((agg) => (
        <Card key={agg.id} className="glass-card" data-testid={`survey-question-${agg.id}`}>
          <CardHeader className="pb-3">
            <CardTitle className="text-white text-base flex items-center justify-between gap-3">
              <span className="flex items-center gap-2">
                {agg.type === 'rating' && <Star className="w-4 h-4 text-yellow-400" />}
                {agg.type === 'boolean' && <CheckCircle2 className="w-4 h-4 text-emerald-400" />}
                {agg.type === 'text' && <MessageSquare className="w-4 h-4 text-cyan-400" />}
                {agg.label}
              </span>
              <Badge variant="outline" className="border-white/20 text-muted-foreground text-xs">
                {agg.count} {agg.count === 1 ? 'answer' : 'answers'}
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {agg.type === 'rating' && (
              <div className="space-y-3">
                <div className="flex items-baseline gap-3">
                  <span className="text-3xl font-bold text-white" data-testid={`rating-average-${agg.id}`}>
                    {agg.average != null ? agg.average.toFixed(2) : '—'}
                  </span>
                  <span className="text-xs text-muted-foreground">average rating</span>
                </div>
                {agg.count > 0 && (
                  <div className="space-y-1">
                    {[5, 4, 3, 2, 1].map((star) => {
                      const cnt = agg.distribution[String(star)] ?? 0;
                      const pct = agg.count > 0 ? (cnt / agg.count) * 100 : 0;
                      return (
                        <div key={star} className="flex items-center gap-2 text-xs">
                          <span className="w-6 text-muted-foreground">{star}★</span>
                          <div className="flex-1 h-2 bg-white/5 rounded overflow-hidden">
                            <div className="h-full bg-yellow-400/70" style={{ width: `${pct}%` }} />
                          </div>
                          <span className="w-10 text-right text-muted-foreground">{cnt}</span>
                        </div>
                      );
                    })}
                  </div>
                )}
                {agg.count === 0 && <p className="text-xs text-muted-foreground">No ratings yet.</p>}
              </div>
            )}

            {agg.type === 'boolean' && (
              <div className="flex items-center gap-6">
                <div className="text-center">
                  <div className="text-2xl font-bold text-emerald-400" data-testid={`boolean-yes-${agg.id}`}>{agg.yes}</div>
                  <div className="text-xs text-muted-foreground uppercase tracking-wider">Yes</div>
                </div>
                <div className="text-center">
                  <div className="text-2xl font-bold text-rose-400" data-testid={`boolean-no-${agg.id}`}>{agg.no}</div>
                  <div className="text-xs text-muted-foreground uppercase tracking-wider">No</div>
                </div>
                {agg.count > 0 && (
                  <div className="flex-1 h-2 bg-white/5 rounded overflow-hidden flex">
                    <div className="h-full bg-emerald-400/70" style={{ width: `${(agg.yes / agg.count) * 100}%` }} />
                    <div className="h-full bg-rose-400/70" style={{ width: `${(agg.no / agg.count) * 100}%` }} />
                  </div>
                )}
              </div>
            )}

            {agg.type === 'text' && (
              agg.answers.length === 0 ? (
                <p className="text-xs text-muted-foreground">No comments submitted.</p>
              ) : (
                <ul className="space-y-2 max-h-80 overflow-y-auto pr-1" data-testid={`text-answers-${agg.id}`}>
                  {agg.answers.map((a, i) => {
                    // Task #2027 — surface the respondent's name (or "Anonymous"
                    // for users without a linked account) so admins can follow
                    // up on a specific comment without downloading the CSV.
                    const respondent = a.respondent ?? 'Anonymous';
                    const isAnonymous = respondent === 'Anonymous';
                    return (
                      <li key={i} className="rounded-lg bg-white/5 border border-white/5 px-3 py-2 text-sm text-white">
                        <p className="whitespace-pre-wrap">{a.text}</p>
                        <p
                          className="text-[10px] text-muted-foreground mt-1 flex items-center gap-2 flex-wrap"
                          data-testid={`text-answer-meta-${agg.id}-${i}`}
                        >
                          <span
                            className={isAnonymous ? 'italic' : 'text-white/80 font-medium'}
                            data-testid={`text-answer-respondent-${agg.id}-${i}`}
                            aria-label={`Respondent: ${respondent}`}
                            title={isAnonymous ? 'Submitted without a linked account' : `Submitted by ${respondent}`}
                          >
                            {respondent}
                          </span>
                          <span aria-hidden="true">·</span>
                          <span>{new Date(a.submittedAt).toLocaleString()}</span>
                        </p>
                      </li>
                    );
                  })}
                </ul>
              )
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

// ─── SEND SURVEY DIALOG ──────────────────────────────────────────────────────

type SurveyQuestionType = 'rating' | 'boolean' | 'text';
interface DraftSurveyQuestion {
  id: string;
  type: SurveyQuestionType;
  prompt: string;
}

const DEFAULT_SURVEY_QUESTIONS: DraftSurveyQuestion[] = [
  { id: 'overall', type: 'rating', prompt: 'Overall experience' },
  { id: 'course', type: 'rating', prompt: 'Course condition' },
  { id: 'comments', type: 'text', prompt: 'Any comments?' },
];

function makeQuestionId(): string {
  return `q_${Math.random().toString(36).slice(2, 9)}`;
}

// Task #1636 — convert an ISO timestamp into the `YYYY-MM-DDTHH:mm` format
// expected by `<input type="datetime-local">`, in the viewer's local zone.
export function isoToLocalDatetimeInput(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Task #1636 — coerce the API's stored questions array (typed `unknown`) into
// the dialog's `DraftSurveyQuestion` shape. Returns `null` when the saved
// payload has no usable questions so callers can fall back to defaults.
export function savedQuestionsToDraft(saved: unknown): DraftSurveyQuestion[] | null {
  if (!Array.isArray(saved) || saved.length === 0) return null;
  const allowed: SurveyQuestionType[] = ['rating', 'boolean', 'text'];
  const draft: DraftSurveyQuestion[] = [];
  for (const raw of saved) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as { id?: unknown; type?: unknown; prompt?: unknown; label?: unknown };
    const type = allowed.includes(r.type as SurveyQuestionType) ? (r.type as SurveyQuestionType) : 'text';
    const prompt = typeof r.prompt === 'string' ? r.prompt : typeof r.label === 'string' ? r.label : '';
    const id = typeof r.id === 'string' && r.id.length > 0 ? r.id : makeQuestionId();
    draft.push({ id, type, prompt });
  }
  return draft.length > 0 ? draft : null;
}

// Task #1637 — shape of a saved survey template returned by
// GET /api/organizations/:orgId/survey-templates.
// Task #2035 — also surfaces who created it (joined display name; null if the
// account was deleted) so admins can answer "did Sarah set this up last
// season, or is this the new one we agreed on yesterday?" before sending.
interface SavedSurveyTemplate {
  id: number;
  name: string;
  questions: Array<{ id: string; prompt: string; type: SurveyQuestionType }>;
  createdAt: string;
  updatedAt: string;
  createdByUserId: number | null;
  createdByName: string | null;
}

// Task #2035 — let admins sort the picker by most-recently-updated as well as
// alphabetically. Default stays "name" so the dropdown order doesn't change
// out from under returning admins.
type SurveyTemplateSort = 'name' | 'recent';

// Task #2035 — short, locale-aware "X minutes/hours/days ago" label so the
// picker stays scannable. Falls back to a full date string after ~30 days.
function formatRelativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const diffMs = Date.now() - then;
  const sec = Math.round(diffMs / 1000);
  if (sec < 60) return 'just now';
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} minute${min === 1 ? '' : 's'} ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} hour${hr === 1 ? '' : 's'} ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day} day${day === 1 ? '' : 's'} ago`;
  return new Date(iso).toLocaleDateString();
}

export function SendSurveyDialog({
  open,
  onOpenChange,
  orgId,
  tournamentId,
  onSent,
  userRole,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  orgId: number;
  tournamentId: number;
  onSent: () => void;
  /** Caller's role — gates the "Save as template"/"Delete" affordances. */
  userRole?: string;
}) {
  const { toast } = useToast();
  const [questions, setQuestions] = useState<DraftSurveyQuestion[]>(DEFAULT_SURVEY_QUESTIONS);
  const [closesAt, setClosesAt] = useState<string>('');
  const [sending, setSending] = useState(false);

  // Task #1636 — pull any previously sent survey for this tournament so we can
  // prefill the dialog with the admin's last-saved questions and close date
  // instead of resetting to the three hardcoded defaults every time.
  const existingSurveyQuery = useQuery<SurveyResponsesData>({
    queryKey: [`/api/organizations/${orgId}/tournaments/${tournamentId}/survey/responses`],
    queryFn: async () => {
      const r = await fetch(`/api/organizations/${orgId}/tournaments/${tournamentId}/survey/responses`, { credentials: 'include' });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? 'Failed to load existing survey');
      return r.json() as Promise<SurveyResponsesData>;
    },
    enabled: open && !!orgId && !!tournamentId,
  });

  // ── Templates (Task #1637) ──────────────────────────────────────────────
  // Only org_admin / super_admin can curate the shared library; tournament
  // directors can still load from it. The picker uses string ids since the
  // shadcn Select binds to string values.
  const canManageTemplates = userRole === 'org_admin' || userRole === 'super_admin';
  const [templates, setTemplates] = useState<SavedSurveyTemplate[]>([]);
  const [templatesLoading, setTemplatesLoading] = useState(false);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>('');
  const [saveTemplateOpen, setSaveTemplateOpen] = useState(false);
  const [saveTemplateName, setSaveTemplateName] = useState('');
  const [savingTemplate, setSavingTemplate] = useState(false);
  // Task #2034 — inline rename for the currently selected template.
  const [renameTemplateOpen, setRenameTemplateOpen] = useState(false);
  const [renameTemplateName, setRenameTemplateName] = useState('');
  const [renamingTemplate, setRenamingTemplate] = useState(false);
  // Task #2035 — admin can flip the dropdown order between A→Z (the original
  // behaviour, which the API already returns) and "most recently updated".
  const [templateSort, setTemplateSort] = useState<SurveyTemplateSort>('name');

  const refreshTemplates = useCallback(async () => {
    if (!orgId) return;
    setTemplatesLoading(true);
    try {
      const r = await fetch(`/api/organizations/${orgId}/survey-templates`, { credentials: 'include' });
      if (!r.ok) throw new Error('failed to load templates');
      const d = await r.json();
      setTemplates(Array.isArray(d.templates) ? d.templates : []);
    } catch {
      // Soft-fail: the dialog still works without templates loaded.
      setTemplates([]);
    } finally {
      setTemplatesLoading(false);
    }
  }, [orgId]);

  // Reset whenever the dialog is opened so prior edits don't linger. Prefer the
  // saved questions/closesAt from the API (Task #1636); fall back to defaults
  // if the tournament has never had a survey sent. Also reset the template
  // picker UI and refresh the list (Task #1637).
  useEffect(() => {
    if (!open) return;
    setSending(false);
    const saved = existingSurveyQuery.data?.survey;
    const draft = saved ? savedQuestionsToDraft(saved.questions) : null;
    setQuestions(draft ?? DEFAULT_SURVEY_QUESTIONS.map(q => ({ ...q })));
    setClosesAt(saved ? isoToLocalDatetimeInput(saved.closesAt) : '');
    setSelectedTemplateId('');
    setSaveTemplateOpen(false);
    setSaveTemplateName('');
    setRenameTemplateOpen(false);
    setRenameTemplateName('');
    void refreshTemplates();
  }, [open, existingSurveyQuery.data, refreshTemplates]);

  const loadTemplate = (templateId: string) => {
    setSelectedTemplateId(templateId);
    if (!templateId) return;
    const tpl = templates.find(t => String(t.id) === templateId);
    if (!tpl) return;
    // Snapshot the template's questions; user can still tweak them before sending.
    setQuestions(tpl.questions.map(q => ({ id: q.id, prompt: q.prompt, type: q.type })));
    toast({ title: 'Template loaded', description: `Loaded "${tpl.name}".` });
  };

  const handleSaveTemplate = async () => {
    const trimmedName = saveTemplateName.trim();
    if (!trimmedName) {
      toast({ title: 'Template name is required', variant: 'destructive' });
      return;
    }
    const trimmedQuestions = questions
      .map(q => ({ id: q.id, prompt: q.prompt.trim(), type: q.type }))
      .filter(q => q.prompt.length > 0);
    if (trimmedQuestions.length === 0) {
      toast({ title: 'Add at least one question before saving', variant: 'destructive' });
      return;
    }
    setSavingTemplate(true);
    try {
      const r = await fetch(`/api/organizations/${orgId}/survey-templates`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmedName, questions: trimmedQuestions }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? 'Save failed');
      toast({ title: 'Template saved', description: `"${trimmedName}" is available to all admins.` });
      setSaveTemplateOpen(false);
      setSaveTemplateName('');
      await refreshTemplates();
      if (d.template?.id) setSelectedTemplateId(String(d.template.id));
    } catch (e) {
      toast({ title: 'Could not save template', description: (e as Error).message, variant: 'destructive' });
    } finally {
      setSavingTemplate(false);
    }
  };

  // Task #2034 — rename the currently selected template via PATCH so we
  // keep its createdByUserId / createdAt provenance instead of doing a
  // delete-and-recreate dance.
  const handleRenameTemplate = async () => {
    if (!selectedTemplateId) return;
    const tpl = templates.find(t => String(t.id) === selectedTemplateId);
    if (!tpl) return;
    const trimmed = renameTemplateName.trim();
    if (!trimmed) {
      toast({ title: 'Template name is required', variant: 'destructive' });
      return;
    }
    if (trimmed === tpl.name) {
      // No-op — just close the editor.
      setRenameTemplateOpen(false);
      return;
    }
    setRenamingTemplate(true);
    try {
      const r = await fetch(`/api/organizations/${orgId}/survey-templates/${tpl.id}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        if (r.status === 409) {
          toast({
            title: 'Name already in use',
            description: 'Another template in your club already has that name.',
            variant: 'destructive',
          });
          return;
        }
        throw new Error(d.error ?? 'Rename failed');
      }
      toast({ title: 'Template renamed', description: `"${tpl.name}" is now "${trimmed}".` });
      setRenameTemplateOpen(false);
      setRenameTemplateName('');
      await refreshTemplates();
    } catch (e) {
      toast({ title: 'Could not rename template', description: (e as Error).message, variant: 'destructive' });
    } finally {
      setRenamingTemplate(false);
    }
  };

  const handleDeleteTemplate = async () => {
    if (!selectedTemplateId) return;
    const tpl = templates.find(t => String(t.id) === selectedTemplateId);
    if (!tpl) return;
    if (!window.confirm(`Delete the template "${tpl.name}"? Surveys already sent will not be affected.`)) return;
    try {
      const r = await fetch(`/api/organizations/${orgId}/survey-templates/${tpl.id}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw new Error(d.error ?? 'Delete failed');
      }
      toast({ title: 'Template deleted' });
      setSelectedTemplateId('');
      await refreshTemplates();
    } catch (e) {
      toast({ title: 'Could not delete template', description: (e as Error).message, variant: 'destructive' });
    }
  };

  const updateQuestion = (idx: number, patch: Partial<DraftSurveyQuestion>) => {
    setQuestions(prev => prev.map((q, i) => (i === idx ? { ...q, ...patch } : q)));
  };

  const addQuestion = () => {
    setQuestions(prev => [...prev, { id: makeQuestionId(), type: 'rating', prompt: '' }]);
  };

  const removeQuestion = (idx: number) => {
    setQuestions(prev => prev.filter((_, i) => i !== idx));
  };

  const handleSend = async () => {
    const trimmed = questions
      .map(q => ({ ...q, prompt: q.prompt.trim() }))
      .filter(q => q.prompt.length > 0);
    if (trimmed.length === 0) {
      toast({ title: 'Add at least one question', variant: 'destructive' });
      return;
    }
    // Ensure ids are unique; regenerate any duplicates so aggregation keys stay distinct.
    const seen = new Set<string>();
    const finalQuestions = trimmed.map(q => {
      let id = q.id || makeQuestionId();
      while (seen.has(id)) id = makeQuestionId();
      seen.add(id);
      return { id, type: q.type, prompt: q.prompt, label: q.prompt };
    });

    let closesAtIso: string | null = null;
    if (closesAt) {
      const d = new Date(closesAt);
      if (Number.isNaN(d.getTime())) {
        toast({ title: 'Invalid close date', variant: 'destructive' });
        return;
      }
      closesAtIso = d.toISOString();
    }

    setSending(true);
    try {
      const r = await fetch(`/api/organizations/${orgId}/tournaments/${tournamentId}/survey/send`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          questions: finalQuestions,
          closesAt: closesAtIso,
        }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? 'Send failed');
      toast({ title: 'Survey sent', description: 'Players will receive an invite shortly.' });
      onOpenChange(false);
      onSent();
    } catch (e) {
      toast({ title: 'Could not send survey', description: (e as Error).message, variant: 'destructive' });
    } finally {
      setSending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="bg-[#0a1628] border border-white/10 text-white max-w-2xl max-h-[85vh] overflow-y-auto"
        data-testid="dialog-send-survey"
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Send className="w-4 h-4 text-purple-300" /> Customise post-event survey
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 mt-2">
          <p className="text-xs text-muted-foreground">
            Edit, add or remove questions before sending. All registered players will receive an invite to this survey.
          </p>

          {/* Task #2030 — let the admin know whether they're editing an existing
              survey (and when it was last sent) or starting from the defaults.
              Pulls sentAt from the same /survey/responses payload that powers
              the existing-survey prefill above. */}
          {(() => {
            const sentAtIso = existingSurveyQuery.data?.survey?.sentAt ?? null;
            if (existingSurveyQuery.isLoading) return null;
            if (sentAtIso) {
              const sentLabel = new Date(sentAtIso).toLocaleString();
              return (
                <div
                  className="rounded-md border border-purple-400/30 bg-purple-500/10 px-3 py-2 text-xs text-purple-100"
                  data-testid="survey-last-sent-banner"
                >
                  Editing the survey sent on <span className="font-medium text-white">{sentLabel}</span>.
                </div>
              );
            }
            return (
              <div
                className="rounded-md border border-white/10 bg-white/5 px-3 py-2 text-xs text-muted-foreground"
                data-testid="survey-last-sent-banner"
              >
                No survey sent yet — these are the defaults.
              </div>
            );
          })()}

          {/* Task #1637 — load from / save to the org's template library.
              Task #2035 — also expose a sort toggle and surface the
              author/last-updated timestamp for the chosen template. */}
          <div className="rounded-lg border border-white/10 bg-white/5 p-3 space-y-3" data-testid="survey-templates-panel">
            <div className="flex items-center justify-between gap-2">
              <label className="text-xs text-muted-foreground uppercase tracking-wider">Load from template</label>
              {canManageTemplates && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setSaveTemplateOpen(v => !v);
                    setSaveTemplateName('');
                  }}
                  className="h-7 px-2 text-purple-300 hover:bg-purple-500/10"
                  data-testid="button-toggle-save-template"
                >
                  <Plus className="w-3.5 h-3.5 mr-1" /> Save as template
                </Button>
              )}
            </div>
            <div className="flex items-center gap-2">
              <div className="flex-1">
                {/* Task #2035 — sort the list before rendering. The API
                    returns rows alphabetically so we only need to re-sort
                    when the admin chooses "recent". */}
                {(() => {
                  const sortedTemplates = templateSort === 'recent'
                    ? [...templates].sort((a, b) =>
                        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
                    : templates;
                  return (
                    <Select
                      value={selectedTemplateId || 'none'}
                      onValueChange={v => loadTemplate(v === 'none' ? '' : v)}
                      disabled={templatesLoading || templates.length === 0}
                    >
                      <SelectTrigger
                        className="bg-black/40 border-white/10 text-white"
                        data-testid="select-survey-template"
                      >
                        <SelectValue placeholder={
                          templatesLoading
                            ? 'Loading templates…'
                            : templates.length === 0
                              ? 'No templates saved yet'
                              : 'Choose a template…'
                        } />
                      </SelectTrigger>
                      <SelectContent className="bg-[#0a1628] border-white/10 text-white">
                        <SelectItem value="none" className="text-white">— None —</SelectItem>
                        {sortedTemplates.map(t => (
                          <SelectItem key={t.id} value={String(t.id)} className="text-white">
                            <span className="flex flex-col">
                              <span>{t.name}</span>
                              <span className="text-[10px] text-muted-foreground">
                                {t.createdByName ?? 'Unknown author'} · updated {formatRelativeTime(t.updatedAt)}
                              </span>
                            </span>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  );
                })()}
              </div>
              {/* Task #2035 — sort toggle. Disabled when there are no templates
                  so it doesn't look interactive on a fresh org. */}
              <Select
                value={templateSort}
                onValueChange={v => setTemplateSort(v as SurveyTemplateSort)}
                disabled={templates.length === 0}
              >
                <SelectTrigger
                  className="w-[150px] h-9 bg-black/40 border-white/10 text-white text-xs"
                  data-testid="select-survey-template-sort"
                  aria-label="Sort templates"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-[#0a1628] border-white/10 text-white">
                  <SelectItem value="name" className="text-white text-xs">Name (A–Z)</SelectItem>
                  <SelectItem value="recent" className="text-white text-xs">Recently updated</SelectItem>
                </SelectContent>
              </Select>
              {canManageTemplates && selectedTemplateId && (
                <>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      const tpl = templates.find(t => String(t.id) === selectedTemplateId);
                      setRenameTemplateName(tpl?.name ?? '');
                      setRenameTemplateOpen(v => !v);
                    }}
                    className="h-9 px-2 text-purple-300 hover:bg-purple-500/10"
                    data-testid="button-rename-survey-template"
                    aria-label="Rename selected template"
                  >
                    <Edit3 className="w-4 h-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleDeleteTemplate}
                    className="h-9 px-2 text-rose-300 hover:bg-rose-500/10"
                    data-testid="button-delete-survey-template"
                    aria-label="Delete selected template"
                  >
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </>
              )}
            </div>
            {renameTemplateOpen && canManageTemplates && selectedTemplateId && (
              <div
                className="rounded-md border border-purple-400/30 bg-purple-500/5 p-3 space-y-2"
                data-testid="rename-template-row"
              >
                <label className="text-[10px] text-muted-foreground uppercase tracking-wider">New name</label>
                <Input
                  value={renameTemplateName}
                  onChange={e => setRenameTemplateName(e.target.value)}
                  placeholder="Rename this template"
                  className="bg-black/40 border-white/10 text-white"
                  data-testid="input-rename-template-name"
                  maxLength={120}
                />
                <p className="text-[10px] text-muted-foreground">
                  Renaming keeps this template's history (who saved it and when). Choose a name no other template in your club uses.
                </p>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => { setRenameTemplateOpen(false); setRenameTemplateName(''); }}
                    disabled={renamingTemplate}
                    className="border-white/10 text-white hover:bg-white/5"
                    data-testid="button-cancel-rename-template"
                  >
                    Cancel
                  </Button>
                  <Button
                    size="sm"
                    onClick={handleRenameTemplate}
                    disabled={renamingTemplate || !renameTemplateName.trim()}
                    className="flex-1 bg-purple-600 hover:bg-purple-700 text-white"
                    data-testid="button-confirm-rename-template"
                  >
                    {renamingTemplate ? (
                      <><Loader2 className="w-3.5 h-3.5 mr-2 animate-spin" /> Renaming…</>
                    ) : (
                      'Save new name'
                    )}
                  </Button>
                </div>
              </div>
            )}
            {/* Task #2035 — show the selected template's author + timestamps
                so admins can confirm "yes, this is the one Sarah saved
                yesterday" before sending it to every player. */}
            {selectedTemplateId && (() => {
              const tpl = templates.find(t => String(t.id) === selectedTemplateId);
              if (!tpl) return null;
              const author = tpl.createdByName ?? 'Unknown';
              const updatedLabel = formatRelativeTime(tpl.updatedAt);
              const createdLabel = new Date(tpl.createdAt).toLocaleDateString();
              const updatedTitle = new Date(tpl.updatedAt).toLocaleString();
              return (
                <div
                  className="rounded-md border border-white/10 bg-black/30 px-3 py-2 text-[11px] text-muted-foreground"
                  data-testid="selected-template-meta"
                >
                  Created by <span className="text-white font-medium">{author}</span>
                  {' '}on {createdLabel}
                  {' · '}
                  <span title={updatedTitle}>updated {updatedLabel}</span>
                </div>
              );
            })()}
            {saveTemplateOpen && canManageTemplates && (
              <div
                className="rounded-md border border-purple-400/30 bg-purple-500/5 p-3 space-y-2"
                data-testid="save-template-row"
              >
                <label className="text-[10px] text-muted-foreground uppercase tracking-wider">Template name</label>
                <Input
                  value={saveTemplateName}
                  onChange={e => setSaveTemplateName(e.target.value)}
                  placeholder='e.g. "Standard post-round survey"'
                  className="bg-black/40 border-white/10 text-white"
                  data-testid="input-save-template-name"
                  maxLength={120}
                />
                <p className="text-[10px] text-muted-foreground">
                  Saving with an existing name will overwrite that template's questions. Templates are shared with everyone in your club.
                </p>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => { setSaveTemplateOpen(false); setSaveTemplateName(''); }}
                    disabled={savingTemplate}
                    className="border-white/10 text-white hover:bg-white/5"
                    data-testid="button-cancel-save-template"
                  >
                    Cancel
                  </Button>
                  <Button
                    size="sm"
                    onClick={handleSaveTemplate}
                    disabled={savingTemplate || !saveTemplateName.trim()}
                    className="flex-1 bg-purple-600 hover:bg-purple-700 text-white"
                    data-testid="button-confirm-save-template"
                  >
                    {savingTemplate ? (
                      <><Loader2 className="w-3.5 h-3.5 mr-2 animate-spin" /> Saving…</>
                    ) : (
                      'Save template'
                    )}
                  </Button>
                </div>
              </div>
            )}
          </div>

          <div className="space-y-3" data-testid="survey-questions-list">
            {questions.length === 0 && (
              <div className="text-sm text-muted-foreground border border-dashed border-white/10 rounded-lg px-4 py-6 text-center">
                No questions yet. Add one to send the survey.
              </div>
            )}
            {questions.map((q, idx) => (
              <div
                key={q.id}
                className="rounded-lg border border-white/10 bg-white/5 p-3 space-y-2"
                data-testid={`survey-question-row-${idx}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs text-muted-foreground uppercase tracking-wider">Question {idx + 1}</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => removeQuestion(idx)}
                    className="h-7 px-2 text-rose-300 hover:bg-rose-500/10"
                    data-testid={`button-remove-question-${idx}`}
                    aria-label={`Remove question ${idx + 1}`}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                  <div className="sm:col-span-2">
                    <label className="text-[10px] text-muted-foreground uppercase tracking-wider">Prompt</label>
                    <Input
                      value={q.prompt}
                      onChange={e => updateQuestion(idx, { prompt: e.target.value })}
                      placeholder="e.g. How was the food?"
                      className="mt-1 bg-black/40 border-white/10 text-white"
                      data-testid={`input-question-prompt-${idx}`}
                    />
                  </div>
                  <div>
                    <label className="text-[10px] text-muted-foreground uppercase tracking-wider">Type</label>
                    <Select
                      value={q.type}
                      onValueChange={v => updateQuestion(idx, { type: v as SurveyQuestionType })}
                    >
                      <SelectTrigger
                        className="mt-1 bg-black/40 border-white/10 text-white"
                        data-testid={`select-question-type-${idx}`}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className="bg-[#0a1628] border-white/10 text-white">
                        <SelectItem value="rating" className="text-white">Rating (1–5)</SelectItem>
                        <SelectItem value="boolean" className="text-white">Yes / No</SelectItem>
                        <SelectItem value="text" className="text-white">Free text</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </div>
            ))}
          </div>

          <Button
            variant="outline"
            onClick={addQuestion}
            className="w-full border-dashed border-white/15 bg-white/5 hover:bg-white/10 text-white"
            data-testid="button-add-question"
          >
            <Plus className="w-4 h-4 mr-2" /> Add question
          </Button>

          <div>
            <label className="text-xs text-muted-foreground uppercase tracking-wider">Closes at (optional)</label>
            <Input
              type="datetime-local"
              value={closesAt}
              onChange={e => setClosesAt(e.target.value)}
              className="mt-1 bg-black/40 border-white/10 text-white"
              data-testid="input-survey-closes-at"
            />
            <p className="text-[10px] text-muted-foreground mt-1">
              Leave blank to keep the survey open indefinitely.
            </p>
          </div>

          <div className="flex gap-3 pt-2">
            <Button
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={sending}
              className="border-white/10 text-white hover:bg-white/5"
              data-testid="button-cancel-send-survey"
            >
              Cancel
            </Button>
            <Button
              onClick={handleSend}
              disabled={sending || questions.length === 0}
              className="flex-1 bg-purple-600 hover:bg-purple-700 text-white"
              data-testid="button-confirm-send-survey"
            >
              {sending ? (
                <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Sending…</>
              ) : (
                <><Send className="w-4 h-4 mr-2" /> Send survey</>
              )}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default function TournamentDetail() {
  const { id } = useParams();
  const tId = parseInt(id || '0');
  const { data: user } = useGetMe();
  const orgId = user?.organizationId as number;
  const isAdmin = ['super_admin', 'org_admin', 'tournament_director'].includes(user?.role ?? '');
  const currentUserName = user?.displayName || user?.username;
  
  const queryClient = useQueryClient();
  const { data: _tournamentRaw, isLoading } = useGetTournament(orgId, tId, { query: { enabled: !!orgId && !!tId, queryKey: getGetTournamentQueryKey(orgId, tId) } });
  const isTeamFormat = ['scramble', 'texas_scramble', 'best_ball', 'shamble', 'four_ball', 'foursomes', 'alliance', 'stroke_play'].includes(_tournamentRaw?.format ?? '');
  // Cast once here; TournamentDetailExt extends TournamentDetail with extra server fields
  const tournament = _tournamentRaw as TournamentDetailExt | undefined;
  const { data: _outerTeeTimes } = useListTeeTimes(orgId, tId, { query: { enabled: !!orgId && !!tId, queryKey: getListTeeTimesQueryKey(orgId, tId) } });
  const outerTeeTimes = (_outerTeeTimes ?? []) as Array<{ id: number; round?: number }>;
  const [psRound, setPsRound] = useState(1);
  const roundTeeTimes = outerTeeTimes.filter(tt => (tt.round ?? 1) === psRound);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [chatPanelOpen, setChatPanelOpen] = useState(false);
  const [sendSurveyOpen, setSendSurveyOpen] = useState(false);
  const { toast } = useToast();

  if (isLoading) return <div className="animate-pulse h-screen bg-card/20 rounded-xl" />;
  if (!tournament) return <div className="text-white p-8">Tournament not found.</div>;

  const courseName = tournament.courseName || tournament.course?.name || 'No course selected';

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      {/* Header */}
      <div className="glass-panel rounded-3xl p-8 relative overflow-hidden">
        <div className="absolute top-0 right-0 w-64 h-64 bg-primary/10 rounded-full blur-[80px]" />
        
        <div className="relative z-10 flex flex-col md:flex-row md:items-end justify-between gap-6">
          <div>
            <div className="flex items-center gap-3 mb-3">
              <Badge className={tournament.status === 'active' ? 'bg-primary/20 text-emerald-200 animate-pulse border-emerald-300/60' : 'bg-white/10 text-white'}>
                {tournament.status.toUpperCase()}
              </Badge>
              <Badge variant="outline" className="border-white/20 text-muted-foreground">
                {tournament.format.replace(/_/g, ' ').toUpperCase()}
              </Badge>
            </div>
            <h1 className="text-4xl md:text-5xl font-display font-bold text-white tracking-tight mb-4">
              {tournament.name}
            </h1>
            <div className="flex flex-wrap items-center gap-6 text-sm text-muted-foreground font-medium">
              <span className="flex items-center gap-2"><MapPin className="w-4 h-4 text-primary" /> {courseName}</span>
              <span className="flex items-center gap-2"><Calendar className="w-4 h-4 text-emerald-400" /> {tournament.startDate ? new Date(tournament.startDate).toLocaleDateString() : 'Dates TBD'}</span>
              <span className="flex items-center gap-2"><Users className="w-4 h-4 text-orange-400" /> {tournament.playerCount ?? 0} Players</span>
            </div>
          </div>
          
          <div className="flex flex-wrap gap-3">
            {tournament.status === 'draft' && (
              <PublishButton orgId={orgId} tournamentId={tId} />
            )}
            <Button
              variant="outline"
              onClick={() => {
                const base = import.meta.env.BASE_URL?.replace(/\/$/, '') || '';
                const url = `${window.location.origin}${base}/register/${orgId}/${tId}`;
                navigator.clipboard.writeText(url);
                // toast is unavailable here (parent component), use alert
                alert('Registration link copied to clipboard!\n\n' + url);
              }}
              className="bg-white/5 border-white/10 hover:bg-white/10 text-white"
            >
              <Link2 className="w-4 h-4 mr-2" /> Share Registration Link
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                const base = import.meta.env.BASE_URL?.replace(/\/$/, '') || '';
                const url = `${window.location.origin}${base}/leaderboard/${tId}`;
                navigator.clipboard.writeText(url).catch(() => {});
                window.open(url, '_blank');
              }}
              className="bg-green-500/10 border-green-500/30 hover:bg-green-500/20 text-green-400"
            >
              <BarChart2 className="w-4 h-4 mr-2" /> Live Leaderboard
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                const base = import.meta.env.BASE_URL?.replace(/\/$/, '') || '';
                const url = `${window.location.origin}${base}/leaderboard/${tId}/display`;
                window.open(url, '_blank');
              }}
              className="bg-white/5 border-white/10 hover:bg-white/10 text-white"
            >
              <Monitor className="w-4 h-4 mr-2" /> Big Screen
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                const base = import.meta.env.BASE_URL?.replace(/\/$/, '') || '';
                const apiBase = base.replace('/kharagolf-web', '');
                window.open(`${apiBase}/api/organizations/${orgId}/tournaments/${tId}/export/scores.csv`, '_blank');
              }}
              className="bg-emerald-500/10 border-emerald-500/30 hover:bg-emerald-500/20 text-emerald-400"
            >
              <FileDown className="w-4 h-4 mr-2" /> Export CSV
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                const base = import.meta.env.BASE_URL?.replace(/\/$/, '') || '';
                const url = `${window.location.origin}${base}/orgs/${orgId}/tournaments/${tId}/print-scorecards`;
                window.open(url, '_blank');
              }}
              className="bg-white/5 border-white/10 hover:bg-white/10 text-white"
            >
              <Printer className="w-4 h-4 mr-2" /> Print Scorecards
            </Button>
            {(tournament.format as string) === 'match_play_bracket' && (
              <Button
                variant="outline"
                onClick={() => {
                  const base = import.meta.env.BASE_URL?.replace(/\/$/, '') || '';
                  window.location.href = `${base}/tournaments/${tId}/bracket`;
                }}
                className="bg-emerald-500/10 border-emerald-500/30 hover:bg-emerald-500/20 text-emerald-400"
              >
                <GitBranch className="w-4 h-4 mr-2" /> Manage Bracket
              </Button>
            )}
            {(tournament.format as string) === 'ryder_cup' && (
              <Button
                variant="outline"
                onClick={() => {
                  const base = import.meta.env.BASE_URL?.replace(/\/$/, '') || '';
                  window.location.href = `${base}/tournaments/${tId}/ryder-cup`;
                }}
                className="bg-blue-500/10 border-blue-500/30 hover:bg-blue-500/20 text-blue-400"
              >
                <Shield className="w-4 h-4 mr-2" /> Ryder Cup Scoreboard
              </Button>
            )}
            <TooltipProvider>
              <div className="flex items-center gap-1">
                {(tournament.rounds ?? 1) > 1 && (
                  <select
                    value={psRound}
                    onChange={e => setPsRound(Number(e.target.value))}
                    className="h-9 rounded-lg bg-black/50 border border-white/10 text-white text-xs px-2 cursor-pointer"
                  >
                    {Array.from({ length: tournament.rounds ?? 1 }, (_, i) => i + 1).map(r => (
                      <option key={r} value={r}>R{r}</option>
                    ))}
                  </select>
                )}
                <UITooltip>
                  <TooltipTrigger asChild>
                    <span className={roundTeeTimes.length === 0 ? 'cursor-not-allowed' : ''}>
                      <Button
                        variant="outline"
                        disabled={roundTeeTimes.length === 0}
                        onClick={() => {
                          const base = import.meta.env.BASE_URL?.replace(/\/$/, '') || '';
                          const url = `${window.location.origin}${base}/orgs/${orgId}/tournaments/${tId}/pocket-scorecards?round=${psRound}`;
                          window.open(url, '_blank');
                        }}
                        className="bg-white/5 border-white/10 hover:bg-white/10 text-white disabled:opacity-40 disabled:pointer-events-none"
                      >
                        <Printer className="w-4 h-4 mr-2" /> Pocket Scorecards
                      </Button>
                    </span>
                  </TooltipTrigger>
                  {roundTeeTimes.length === 0 && (
                    <TooltipContent side="bottom">
                      No draw for Round {psRound} — generate the draw first
                    </TooltipContent>
                  )}
                </UITooltip>
              </div>
            </TooltipProvider>
            <Button
              variant="outline"
              onClick={() => {
                const base = import.meta.env.BASE_URL?.replace(/\/$/, '') || '';
                const apiBase = base.replace('/kharagolf-web', '');
                const a = document.createElement('a');
                a.href = `${apiBase}/api/public/orgs/${orgId}/tournaments/${tId}/calendar.ics`;
                a.download = '';
                a.click();
              }}
              className="bg-emerald-500/10 border-emerald-500/30 hover:bg-emerald-500/20 text-emerald-400"
            >
              <Calendar className="w-4 h-4 mr-2" /> Add to Calendar
            </Button>
            <Button
              variant="outline"
              onClick={() => setSettingsOpen(true)}
              className="bg-white/5 border-white/10 hover:bg-white/10 text-white"
            >
              <Settings className="w-4 h-4 mr-2" /> Settings
            </Button>
            {isAdmin && (
              <>
                <Button
                  variant="outline"
                  data-testid="button-apply-cut"
                  onClick={async () => {
                    const raw = window.prompt('Apply cut after which round?', '2');
                    if (raw == null) return;
                    const throughRound = parseInt(raw, 10);
                    if (!Number.isFinite(throughRound) || throughRound < 1) {
                      toast({ title: 'Invalid round number', variant: 'destructive' });
                      return;
                    }
                    try {
                      const r = await fetch(`/api/organizations/${orgId}/tournaments/${tId}/cut`, {
                        method: 'POST', credentials: 'include',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ throughRound }),
                      });
                      const d = await r.json();
                      if (!r.ok) throw new Error(d.error ?? 'Cut failed');
                      const advancedCount = Array.isArray(d.survivors) ? d.survivors.length : (d.advanced ?? 0);
                      const cutCount = Array.isArray(d.cut) ? d.cut.length : (d.cutCount ?? 0);
                      const cutScore = d.cutLineStrokes ?? d.cutScore;
                      toast({ title: 'Cut applied', description: `${cutScore != null ? 'Score: ' + cutScore + ' · ' : ''}${advancedCount} advanced, ${cutCount} cut` });
                    } catch (e) {
                      toast({ title: 'Could not apply cut', description: (e as Error).message, variant: 'destructive' });
                    }
                  }}
                  className="bg-amber-500/10 border-amber-500/30 hover:bg-amber-500/20 text-amber-300"
                >
                  <Gavel className="w-4 h-4 mr-2" /> Apply cut
                </Button>
                <Button
                  variant="outline"
                  data-testid="button-send-survey"
                  onClick={() => setSendSurveyOpen(true)}
                  className="bg-purple-500/10 border-purple-500/30 hover:bg-purple-500/20 text-purple-300"
                >
                  <Send className="w-4 h-4 mr-2" /> Send survey
                </Button>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Tabs */}
      <Tabs defaultValue="leaderboard" className="w-full">
        <TabsList className="bg-black/40 border border-white/5 p-1 rounded-xl w-full flex overflow-x-auto justify-start h-auto">
          <TabsTrigger value="overview" className="rounded-lg data-[state=active]:bg-primary/20 data-[state=active]:text-white px-6 py-3 font-semibold">Overview</TabsTrigger>
          <TabsTrigger value="leaderboard" aria-label="Live Leaderboard" className="rounded-lg data-[state=active]:bg-primary/20 data-[state=active]:text-white px-6 py-3 font-semibold flex items-center gap-2">
            <Activity className="w-4 h-4" /> Live Leaderboard
          </TabsTrigger>
          <TabsTrigger value="players" className="rounded-lg data-[state=active]:bg-white/10 data-[state=active]:text-white px-6 py-3 font-semibold">Players</TabsTrigger>
          <TabsTrigger value="flights" className="rounded-lg data-[state=active]:bg-white/10 data-[state=active]:text-white px-6 py-3 font-semibold flex items-center gap-2"><Flag className="w-3.5 h-3.5" /> Flights</TabsTrigger>
          <TabsTrigger value="draw" className="rounded-lg data-[state=active]:bg-white/10 data-[state=active]:text-white px-6 py-3 font-semibold flex items-center gap-2"><GitBranch className="w-3.5 h-3.5" /> Draw</TabsTrigger>
          <TabsTrigger value="scorer" className="rounded-lg data-[state=active]:bg-orange-500/20 data-[state=active]:text-orange-400 px-6 py-3 font-semibold flex items-center gap-2"><Keyboard className="w-3.5 h-3.5" /> Scorer</TabsTrigger>
          <TabsTrigger value="side-games" className="rounded-lg data-[state=active]:bg-yellow-500/20 data-[state=active]:text-yellow-400 px-6 py-3 font-semibold flex items-center gap-2"><Trophy className="w-3.5 h-3.5" /> Side Games</TabsTrigger>
          <TabsTrigger value="comms" className="rounded-lg data-[state=active]:bg-emerald-500/20 data-[state=active]:text-emerald-400 px-6 py-3 font-semibold flex items-center gap-2"><MessageSquare className="w-3.5 h-3.5" /> Communications</TabsTrigger>
          <TabsTrigger value="gallery" className="rounded-lg data-[state=active]:bg-purple-500/20 data-[state=active]:text-purple-400 px-6 py-3 font-semibold flex items-center gap-2"><Image className="w-3.5 h-3.5" /> Gallery</TabsTrigger>
          <TabsTrigger value="chat" className="rounded-lg data-[state=active]:bg-cyan-500/20 data-[state=active]:text-cyan-400 px-6 py-3 font-semibold flex items-center gap-2"><MessageCircle className="w-3.5 h-3.5" /> Chat</TabsTrigger>
          <TabsTrigger value="sponsors" className="rounded-lg data-[state=active]:bg-amber-500/20 data-[state=active]:text-amber-400 px-6 py-3 font-semibold flex items-center gap-2"><Star className="w-3.5 h-3.5" /> Sponsors</TabsTrigger>
          <TabsTrigger value="prizes" className="rounded-lg data-[state=active]:bg-rose-500/20 data-[state=active]:text-rose-400 px-6 py-3 font-semibold flex items-center gap-2"><Award className="w-3.5 h-3.5" /> Prizes</TabsTrigger>
          <TabsTrigger value="replay" className="rounded-lg data-[state=active]:bg-sky-500/20 data-[state=active]:text-sky-400 px-6 py-3 font-semibold flex items-center gap-2"><MapIcon className="w-3.5 h-3.5" /> Replay</TabsTrigger>
          {isAdmin && <TabsTrigger value="staff" className="rounded-lg data-[state=active]:bg-violet-500/20 data-[state=active]:text-violet-400 px-6 py-3 font-semibold flex items-center gap-2"><ShieldAlert className="w-3.5 h-3.5" /> Staff</TabsTrigger>}
          {isAdmin && <TabsTrigger value="scorer-pins" className="rounded-lg data-[state=active]:bg-teal-500/20 data-[state=active]:text-teal-400 px-6 py-3 font-semibold flex items-center gap-2"><KeyRound className="w-3.5 h-3.5" /> Scorer PINs</TabsTrigger>}
          {isAdmin && <TabsTrigger value="signing" className="rounded-lg data-[state=active]:bg-cyan-500/20 data-[state=active]:text-cyan-400 px-6 py-3 font-semibold flex items-center gap-2"><ShieldCheck className="w-3.5 h-3.5" /> Signing</TabsTrigger>}
          {isAdmin && <TabsTrigger value="whs" className="rounded-lg data-[state=active]:bg-emerald-500/20 data-[state=active]:text-emerald-400 px-6 py-3 font-semibold flex items-center gap-2"><Globe className="w-3.5 h-3.5" /> WHS / GHIN</TabsTrigger>}
          {isTeamFormat && <TabsTrigger value="teams" className="rounded-lg data-[state=active]:bg-indigo-500/20 data-[state=active]:text-indigo-400 px-6 py-3 font-semibold flex items-center gap-2"><Users className="w-3.5 h-3.5" /> Teams</TabsTrigger>}
          {isAdmin && <TabsTrigger value="rulings" className="rounded-lg data-[state=active]:bg-red-500/20 data-[state=active]:text-red-400 px-6 py-3 font-semibold flex items-center gap-2"><Gavel className="w-3.5 h-3.5" /> Rulings</TabsTrigger>}
          {isAdmin && <TabsTrigger value="pace" className="rounded-lg data-[state=active]:bg-blue-500/20 data-[state=active]:text-blue-400 px-6 py-3 font-semibold flex items-center gap-2"><Timer className="w-3.5 h-3.5" /> Pace</TabsTrigger>}
          {(tournament?.eventType === 'corporate' || isAdmin) && <TabsTrigger value="corporate" className="rounded-lg data-[state=active]:bg-blue-600/20 data-[state=active]:text-blue-300 px-6 py-3 font-semibold flex items-center gap-2"><Briefcase className="w-3.5 h-3.5" /> Corporate</TabsTrigger>}
          {(tournament?.eventType === 'charity' || isAdmin) && <TabsTrigger value="charity" className="rounded-lg data-[state=active]:bg-rose-600/20 data-[state=active]:text-rose-300 px-6 py-3 font-semibold flex items-center gap-2"><Heart className="w-3.5 h-3.5" /> Charity</TabsTrigger>}
          <TabsTrigger value="documents" className="rounded-lg data-[state=active]:bg-emerald-500/20 data-[state=active]:text-emerald-400 px-6 py-3 font-semibold flex items-center gap-2"><FileText className="w-3.5 h-3.5" /> Documents</TabsTrigger>
          {isAdmin && <TabsTrigger value="reg-form" className="rounded-lg data-[state=active]:bg-emerald-500/20 data-[state=active]:text-emerald-400 px-6 py-3 font-semibold flex items-center gap-2"><Target className="w-3.5 h-3.5" /> Reg Form</TabsTrigger>}
          {isAdmin && <TabsTrigger value="survey" className="rounded-lg data-[state=active]:bg-sky-500/20 data-[state=active]:text-sky-400 px-6 py-3 font-semibold flex items-center gap-2"><Building2 className="w-3.5 h-3.5" /> Survey</TabsTrigger>}
          {isAdmin && <TabsTrigger value="survey-responses" className="rounded-lg data-[state=active]:bg-purple-500/20 data-[state=active]:text-purple-300 px-6 py-3 font-semibold flex items-center gap-2" data-testid="tab-survey-responses"><BarChart2 className="w-3.5 h-3.5" /> Survey responses</TabsTrigger>}
        </TabsList>

        <div className="mt-6">
          <TabsContent value="overview">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              <Card className="glass-card md:col-span-2">
                <CardHeader><CardTitle className="text-white">Tournament Details</CardTitle></CardHeader>
                <CardContent className="space-y-3 text-sm">
                  <p className="text-muted-foreground">{tournament.description || 'No description provided.'}</p>
                  <div className="grid grid-cols-2 gap-4 pt-2">
                    <div><p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Format</p><p className="text-white font-medium">{tournament.format.replace(/_/g, ' ')}</p></div>
                    <div><p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Rounds</p><p className="text-white font-medium">{tournament.rounds ?? 1}</p></div>
                    <div><p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Max Players</p><p className="text-white font-medium">{tournament.maxPlayers ?? 'Unlimited'}</p></div>
                    <div data-testid="tournament-entry-fee"><p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Entry Fee</p>{tournament.entryFee && parseFloat(tournament.entryFee) > 0 ? (
                      <PriceWithFx
                        orgId={orgId}
                        amount={tournament.entryFee}
                        currency={tournament.currency ?? 'INR'}
                        productClass="tournament_entry"
                        bookedClassName="text-white font-medium"
                      />
                    ) : (<p className="text-white font-medium">Free</p>)}</div>
                  </div>
                  {isAdmin && (
                    <div className="flex flex-wrap gap-2 pt-4 border-t border-white/5">
                      {tournament.status === 'active' ? (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={async () => {
                            const reason = prompt('Reason for suspension:');
                            if (!reason) return;
                            const res = await fetch(`/api/organizations/${orgId}/tournaments/${tId}/suspend`, {
                              method: 'POST',
                              headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify({ reason }),
                            });
                            if (res.ok) queryClient.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/tournaments/${tId}`] });
                          }}
                          className="bg-yellow-500/10 border-yellow-500/30 text-yellow-400 hover:bg-yellow-500/20"
                        >
                          <Pause className="w-3.5 h-3.5 mr-1.5" /> Suspend Play
                        </Button>
                      ) : (tournament.status as string) === 'suspended' ? (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={async () => {
                            const res = await fetch(`/api/organizations/${orgId}/tournaments/${tId}/resume`, { method: 'POST' });
                            if (res.ok) queryClient.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/tournaments/${tId}`] });
                          }}
                          className="bg-emerald-500/10 border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/20"
                        >
                          <Play className="w-3.5 h-3.5 mr-1.5" /> Resume Play
                        </Button>
                      ) : null}
                    </div>
                  )}
                </CardContent>
              </Card>
              <div className="flex flex-col gap-6">
                <Card className="glass-card">
                  <CardHeader><CardTitle className="text-white">Course Info</CardTitle></CardHeader>
                  <CardContent>
                    {tournament.course ? (
                      <div className="space-y-4">
                        <div><p className="text-sm text-muted-foreground">Course</p><p className="text-white font-medium">{courseName}</p></div>
                        <div><p className="text-sm text-muted-foreground">Holes</p><p className="text-white font-medium">{tournament.course.holes ?? 18}</p></div>
                        <div><p className="text-sm text-muted-foreground">Par</p><p className="text-white font-medium">{tournament.course.par ?? 72}</p></div>
                      </div>
                    ) : <p className="text-muted-foreground text-sm">No course set. Use Settings to assign a course.</p>}
                  </CardContent>
                </Card>
                <WeatherWidget />
                {tournament.status === 'active' && (
                  <LiveActivityStrip tournamentId={tId} />
                )}
              </div>
            </div>
          </TabsContent>

          <TabsContent value="leaderboard">
            <LeaderboardTab orgId={orgId} tournamentId={tId} />
          </TabsContent>

          <TabsContent value="players">
            <PlayersTab orgId={orgId} tournamentId={tId} checkInCutoffAt={tournament.checkInCutoffAt ?? null} />
          </TabsContent>

          <TabsContent value="flights">
            <FlightsTab orgId={orgId} tournamentId={tId} />
          </TabsContent>

          <TabsContent value="draw">
            <DrawTab orgId={orgId} tournamentId={tId} format={tournament.format} />
          </TabsContent>

          <TabsContent value="scorer">
            <ScorerTab orgId={orgId} tournamentId={tId} courseId={tournament.courseId ?? null} coursePar={tournament.course?.par ?? 72} rounds={tournament.rounds ?? 1} isAdmin={isAdmin} currentUserName={currentUserName} courseConditions={tournament.courseConditions} />
          </TabsContent>

          <TabsContent value="side-games">
            <SideGamesTab orgId={orgId} tournamentId={tId} />
          </TabsContent>

          <TabsContent value="comms">
            <TournamentCommsTab orgId={orgId} tournamentId={tId} />
          </TabsContent>

          <TabsContent value="gallery">
            <GalleryTab orgId={orgId} tournamentId={tId} isAdmin={isAdmin} moderationEnabled={tournament.mediaModerationEnabled !== false} />
          </TabsContent>

          <TabsContent value="chat">
            <ChatTab orgId={orgId} type="tournament" entityId={tId} isAdmin={isAdmin} currentUserName={currentUserName} />
          </TabsContent>

          <TabsContent value="sponsors">
            <SponsorsTab orgId={orgId} tournamentId={tId} isAdmin={isAdmin} />
          </TabsContent>

          <TabsContent value="prizes">
            <PrizesTab orgId={orgId} tournamentId={tId} isAdmin={isAdmin} />
          </TabsContent>

          <TabsContent value="replay">
            <ReplayTab orgId={orgId} tournamentId={tId} tournament={tournament} />
          </TabsContent>

          {isAdmin && (
            <TabsContent value="staff">
              <TournamentStaffTab tournamentId={tId} />
            </TabsContent>
          )}

          {isAdmin && (
            <TabsContent value="scorer-pins">
              <ScorerPinsTab tournamentId={tId} />
            </TabsContent>
          )}

          {isAdmin && (
            <TabsContent value="signing">
              <SigningStatusTab orgId={orgId} tournamentId={tId} rounds={tournament.rounds ?? 1} />
            </TabsContent>
          )}

          {isAdmin && (
            <TabsContent value="whs">
              <WhsPostingTab orgId={orgId} tournamentId={tId} rounds={tournament.rounds ?? 1} />
            </TabsContent>
          )}

          {isTeamFormat && (
            <TabsContent value="teams">
              <TeamsTab tournamentId={tId} />
            </TabsContent>
          )}

          {isAdmin && (
            <TabsContent value="rulings">
              <RulingsTab tournamentId={tId} players={tournament.playerCount ?? 0} />
            </TabsContent>
          )}

          {isAdmin && (
            <TabsContent value="pace">
              <PaceTab tournamentId={tId} />
            </TabsContent>
          )}

          <TabsContent value="corporate">
            <CorporateEventTab orgId={orgId} tournamentId={tId} isAdmin={isAdmin} players={tournament as any} />
          </TabsContent>

          <TabsContent value="charity">
            <CharityEventTab orgId={orgId} tournamentId={tId} isAdmin={isAdmin} currency={(tournament as any)?.currency ?? 'GBP'} />
          </TabsContent>

          <TabsContent value="documents">
            <EventDocumentsTab orgId={orgId} eventType="tournament" eventId={tId} isAdmin={isAdmin} />
          </TabsContent>

          {isAdmin && (
            <TabsContent value="reg-form">
              <RegistrationFormTab orgId={orgId} eventId={tId} eventType="tournament" />
            </TabsContent>
          )}

          {isAdmin && (
            <TabsContent value="survey">
              <SurveyTab orgId={orgId} eventId={tId} eventType="tournament" />
            </TabsContent>
          )}

          {isAdmin && (
            <TabsContent value="survey-responses">
              <PostEventSurveyResponsesPanel orgId={orgId} tournamentId={tId} />
            </TabsContent>
          )}
        </div>
      </Tabs>

      {/* Settings Dialog */}
      <TournamentSettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        tournament={tournament}
        orgId={orgId}
        tournamentId={tId}
      />

      {/* Send Survey Dialog */}
      <SendSurveyDialog
        open={sendSurveyOpen}
        onOpenChange={setSendSurveyOpen}
        orgId={orgId}
        tournamentId={tId}
        userRole={user?.role}
        onSent={() => queryClient.invalidateQueries({
          queryKey: [`/api/organizations/${orgId}/tournaments/${tId}/survey/responses`],
        })}
      />

      {/* Dockable Chat Panel — fixed right-side overlay, available from any tab */}
      <div className="fixed bottom-6 right-6 z-50 flex flex-col items-end gap-3">
        {chatPanelOpen && (
          <div className="w-[360px] h-[520px] glass-panel rounded-2xl border border-white/10 shadow-2xl flex flex-col overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 border-b border-white/10 bg-white/5 flex-shrink-0">
              <div className="flex items-center gap-2">
                <MessageCircle className="w-4 h-4 text-cyan-400" />
                <span className="text-sm font-semibold text-white">Tournament Chat</span>
              </div>
              <button onClick={() => setChatPanelOpen(false)} className="text-muted-foreground hover:text-white p-1 rounded">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="flex-1 overflow-hidden">
              <ChatTab orgId={orgId} type="tournament" entityId={tId} isAdmin={isAdmin} currentUserName={currentUserName} />
            </div>
          </div>
        )}
        <button
          onClick={() => setChatPanelOpen(v => !v)}
          title={chatPanelOpen ? 'Close chat' : 'Open tournament chat'}
          className="w-14 h-14 rounded-full bg-cyan-500 hover:bg-cyan-400 text-white shadow-lg flex items-center justify-center transition-all hover:scale-105"
        >
          {chatPanelOpen ? <X className="w-6 h-6" /> : <MessageCircle className="w-6 h-6" />}
        </button>
      </div>
    </div>
  );
}

/* ─── Scorer Tab ─────────────────────────────────────────────────── */

type ScorerPlayerRow = { id: number; playerName: string; handicapIndex: number; flights: string[]; holeScores: Array<{ hole: number; strokes: number; par: number; toPar: number }>; startingHole?: number };

function ScorerTab({ orgId, tournamentId, courseId, coursePar, rounds, isAdmin, currentUserName, courseConditions }: { orgId: number; tournamentId: number; courseId: number | null; coursePar: number; rounds: number; isAdmin?: boolean; currentUserName?: string; courseConditions?: string | null }) {
  const queryClient = useQueryClient();
  const [holeData, setHoleData] = useState<Array<{ holeNumber: number; par: number; handicap?: number | null }>>([]);
  const [players, setPlayers] = useState<ScorerPlayerRow[]>([]);
  const [loadingHoles, setLoadingHoles] = useState(true);
  const [loadingPlayers, setLoadingPlayers] = useState(true);
  const [sortBy, setSortBy] = useState<'name' | 'score-to-par' | 'handicap' | 'hole'>('name');
  const [startingHoleMap, setStartingHoleMap] = useState<Record<number, number>>({});
  const [selectedRound, setSelectedRound] = useState(1);

  // Fetch tee times to build playerId → startingHole map
  useEffect(() => {
    fetch(`/api/organizations/${orgId}/tournaments/${tournamentId}/tee-times`, { credentials: 'include' })
      .then(r => r.ok ? r.json() : [])
      .then((teeTimes: Array<{ hole?: number; players?: Array<{ id: number }> }>) => {
        const map: Record<number, number> = {};
        for (const tt of teeTimes) {
          for (const p of tt.players ?? []) {
            if (p.id && tt.hole) map[p.id] = tt.hole;
          }
        }
        setStartingHoleMap(map);
      })
      .catch(() => {});
  }, [orgId, tournamentId]);

  // Fetch course hole details
  useEffect(() => {
    if (!courseId) { setLoadingHoles(false); return; }
    fetch(`/api/organizations/${orgId}/courses/${courseId}`, { credentials: 'include' })
      .then(r => { if (!r.ok) throw new Error(`${r.status}`); return r.json(); })
      .then((data: { holeDetails?: Array<{ holeNumber: number; par: number; handicap?: number | null }> }) => {
        if (data.holeDetails?.length) {
          setHoleData(data.holeDetails.map(h => ({ holeNumber: h.holeNumber, par: h.par, handicap: h.handicap })));
        }
      })
      .catch((err) => console.warn('[ScorerTab] course fetch error:', err))
      .finally(() => setLoadingHoles(false));
  }, [orgId, courseId]);

  // Fetch per-round scores — uses the /scores?round=N endpoint
  const fetchPlayers = useCallback(() => {
    setLoadingPlayers(true);
    Promise.all([
      fetch(`/api/organizations/${orgId}/tournaments/${tournamentId}/scores?round=${selectedRound}`, { credentials: 'include' })
        .then(r => r.ok ? r.json() : { players: [] }),
      fetch(`/api/organizations/${orgId}/tournaments/${tournamentId}/leaderboard`, { credentials: 'include' })
        .then(r => r.ok ? r.json() : { entries: [] }),
    ])
      .then(([scoreData, lbData]: [
        { players: Array<{ playerId: number; playerName: string; handicapIndex: number; holeScores: Array<{ hole: number; strokes: number }> }> },
        { entries?: Array<{ playerId: number; flights?: string[] }> }
      ]) => {
        // Build flights map from leaderboard
        const flightsMap: Record<number, string[]> = {};
        for (const e of (lbData.entries ?? [])) flightsMap[e.playerId] = e.flights ?? [];

        // Build course hole par map for toPar calculation
        const parMap: Record<number, number> = {};
        for (const h of holeData) parMap[h.holeNumber] = h.par;

        setPlayers(scoreData.players.map(p => ({
          id: p.playerId,
          playerName: p.playerName,
          handicapIndex: p.handicapIndex ?? 0,
          flights: flightsMap[p.playerId] ?? [],
          holeScores: p.holeScores.map(hs => ({
            hole: hs.hole,
            strokes: hs.strokes,
            par: parMap[hs.hole] ?? 4,
            toPar: hs.strokes - (parMap[hs.hole] ?? 4),
          })),
          startingHole: undefined,
        })));
      })
      .catch(err => console.warn('[ScorerTab] scores fetch error:', err))
      .finally(() => setLoadingPlayers(false));
  }, [orgId, tournamentId, selectedRound, holeData]);

  useEffect(() => { fetchPlayers(); }, [fetchPlayers]);

  const loading = loadingHoles || loadingPlayers;

  // Merge startingHole from tee-time map into player rows
  const playersWithHole = players.map(p => ({
    ...p,
    startingHole: startingHoleMap[p.id] ?? p.startingHole,
  }));

  // Sort players
  const sortedPlayers = [...playersWithHole].sort((a, b) => {
    if (sortBy === 'name') return a.playerName.localeCompare(b.playerName);
    if (sortBy === 'handicap') return a.handicapIndex - b.handicapIndex;
    if (sortBy === 'hole') {
      const aH = a.startingHole ?? 999;
      const bH = b.startingHole ?? 999;
      return aH !== bH ? aH - bH : a.playerName.localeCompare(b.playerName);
    }
    // score-to-par: sum toPar across all played holes; no-score players last
    const aToPar = a.holeScores.length > 0 ? a.holeScores.reduce((s, h) => s + h.toPar, 0) : null;
    const bToPar = b.holeScores.length > 0 ? b.holeScores.reduce((s, h) => s + h.toPar, 0) : null;
    if (aToPar === null && bToPar === null) return 0;
    if (aToPar === null) return 1;
    if (bToPar === null) return -1;
    return aToPar - bToPar;
  });

  if (loading) return (
    <div className="flex items-center justify-center py-16">
      <div className="w-6 h-6 border-2 border-orange-400 border-t-transparent rounded-full animate-spin" />
    </div>
  );

  return (
    <div className="space-y-6">
      {courseConditions && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 flex items-start gap-3">
          <span className="text-amber-400 text-sm font-semibold shrink-0">Course Conditions</span>
          <p className="text-amber-200/80 text-sm whitespace-pre-line">{courseConditions}</p>
        </div>
      )}
      <div className="glass-card rounded-2xl p-6">
        <div className="flex items-center justify-between gap-3 mb-6 flex-wrap">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-orange-500/20 flex items-center justify-center">
              <Keyboard className="w-5 h-5 text-orange-400" />
            </div>
            <div>
              <h2 className="font-display font-bold text-white text-lg">Score Entry</h2>
              <p className="text-xs text-muted-foreground">{players.length} players · {holeData.length || 18} holes · Tab/Enter to navigate</p>
            </div>
          </div>
          {rounds > 1 && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground font-medium">Round:</span>
              {Array.from({ length: rounds }, (_, i) => i + 1).map(r => (
                <button
                  key={r}
                  onClick={() => setSelectedRound(r)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold border transition-all ${
                    selectedRound === r
                      ? 'bg-orange-500/30 text-orange-300 border-orange-500/40'
                      : 'bg-white/5 text-muted-foreground border-white/10 hover:text-white'
                  }`}
                >
                  R{r}
                </button>
              ))}
            </div>
          )}
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground font-medium">Sort:</span>
            {([
              { key: 'name', label: 'Name' },
              { key: 'hole', label: 'Starting Hole' },
              { key: 'score-to-par', label: 'Score-to-Par' },
              { key: 'handicap', label: 'Handicap' },
            ] as const).map(({ key, label }) => (
              <button
                key={key}
                onClick={() => setSortBy(key)}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition-all ${
                  sortBy === key ? 'bg-orange-500/20 text-orange-400 border-orange-500/30' : 'bg-white/5 text-muted-foreground border-white/10 hover:text-white'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {players.length === 0 ? (
          <div className="text-center py-12">
            <Keyboard className="w-10 h-10 text-muted-foreground/30 mx-auto mb-3" />
            <p className="text-muted-foreground font-medium">No players registered yet.</p>
            <p className="text-xs text-muted-foreground/60 mt-1">Add players in the Players tab to start entering scores.</p>
          </div>
        ) : (
          <div className="flex gap-4 items-start">
            <div className="flex-1 overflow-hidden">
              <ScorerGrid
                orgId={orgId}
                tournamentId={tournamentId}
                round={selectedRound}
                players={sortedPlayers}
                holeData={holeData}
                coursePar={coursePar}
                isAdmin={isAdmin}
                currentUserName={currentUserName}
                onScoreSaved={() => {
                  queryClient.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/tournaments/${tournamentId}/leaderboard`] });
                  fetchPlayers();
                }}
              />
            </div>
            <LiveMessagePanel
              streamUrl={`/api/organizations/${orgId}/tournaments/${tournamentId}/announcements/stream`}
              postUrl={`/api/organizations/${orgId}/tournaments/${tournamentId}/announcements`}
              authorName={currentUserName ?? 'Admin'}
              isAdmin={isAdmin}
            />
          </div>
        )}
      </div>
    </div>
  );
}

/* ─── Publish Button ─────────────────────────────────────────────── */

function PublishButton({ orgId, tournamentId }: { orgId: number, tournamentId: number }) {
  const queryClient = useQueryClient();
  const { mutate, isPending } = usePublishTournament({
    mutation: {
      onSuccess: () => queryClient.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/tournaments/${tournamentId}`] })
    }
  });

  return (
    <Button 
      onClick={() => mutate({ orgId, tournamentId })} 
      disabled={isPending}
      className="bg-primary hover:bg-primary/90 text-primary-foreground shadow-[0_0_15px_rgba(34,197,94,0.4)]"
    >
      <ShieldCheck className="w-4 h-4 mr-2" />
      {isPending ? 'Activating...' : 'Publish Event'}
    </Button>
  );
}

/* ─── Cut Line Preview ───────────────────────────────────────────── */

/**
 * Live "= N strokes" preview for the cut-line input. Mirrors the par
 * resolution that `applyCut` uses on the server (Task #1599 / #1989) so
 * admins don't have to add up "+5 over par" against each round's actual
 * course in their head, especially for multi-course events.
 *
 * Per-round par is computed as: prefer the sum of hole_details.par when
 * the seeded hole count equals courses.holes, otherwise fall back to
 * courses.par; rounds with no resolvable course contribute 72.
 */
export function CutPreview({ orgId, courseId, roundCourses, cutLine, cutAfterRound, rounds }: {
  orgId: number;
  courseId: string;
  roundCourses: Record<number, string>;
  cutLine: string;
  cutAfterRound: string;
  rounds: string;
}) {
  const DEFAULT_PAR_PER_ROUND = 72;
  const cutLineNum = cutLine.trim() === '' ? NaN : Number(cutLine);
  const totalRounds = Math.max(1, parseInt(rounds) || 1);
  const isMultiRound = totalRounds >= 2;

  // For single-round events, "after round" is implicitly 1. For
  // multi-round events the admin picks it; if blank, we can't preview.
  let afterRound: number | null;
  if (isMultiRound) {
    const n = parseInt(cutAfterRound);
    afterRound = Number.isFinite(n) && n >= 1 ? Math.min(n, totalRounds) : null;
  } else {
    afterRound = 1;
  }

  const defaultCourseId = courseId ? parseInt(courseId) : null;
  const perRound: Array<number | null> = [];
  if (afterRound != null) {
    for (let r = 1; r <= afterRound; r++) {
      const override = roundCourses[r];
      if (override != null && override !== '') {
        const id = parseInt(override);
        perRound.push(Number.isFinite(id) ? id : defaultCourseId);
      } else {
        perRound.push(defaultCourseId);
      }
    }
  }
  const uniqueIds = Array.from(new Set(perRound.filter((id): id is number => id != null)));

  const queries = useQueries({
    queries: uniqueIds.map(id => ({
      ...getGetCourseQueryOptions(orgId, id),
      enabled: !!orgId,
    })),
  });

  if (Number.isNaN(cutLineNum)) return null;

  if (afterRound == null) {
    return (
      <p className="text-xs text-orange-300/80" data-testid="text-cutline-absolute-strokes-hint">
        Set "Cut After Round" below to see the absolute strokes.
      </p>
    );
  }

  const anyLoading = queries.some(q => q.isLoading);
  const allResolved = queries.every(q => q.data != null);
  if (uniqueIds.length > 0 && !allResolved && anyLoading) {
    return <p className="text-xs text-muted-foreground">Calculating absolute strokes…</p>;
  }

  // If any of the courses we need failed to load (network blip, deleted
  // course, etc.) we'd otherwise silently fall back to par=72 for that
  // round — which would render a confidently wrong absolute number.
  // Surface a clear error state instead so admins know the preview
  // can't be trusted until the page is retried.
  const anyError = queries.some(q => q.isError || (!q.isLoading && q.data == null));
  if (uniqueIds.length > 0 && anyError) {
    return (
      <p className="text-xs text-orange-300/80" data-testid="text-cutline-absolute-strokes-error">
        Couldn't load course par — refresh to recalculate the absolute strokes preview.
      </p>
    );
  }

  const dataById = new Map<number, CourseWithHoles>();
  for (let i = 0; i < uniqueIds.length; i++) {
    const data = queries[i].data as CourseWithHoles | undefined;
    if (data) dataById.set(uniqueIds[i], data);
  }

  const parForCourse = (id: number | null): number => {
    if (id == null) return DEFAULT_PAR_PER_ROUND;
    const c = dataById.get(id);
    if (!c) return DEFAULT_PAR_PER_ROUND;
    const expectedHoles = c.holes ?? 18;
    const holes = c.holeDetails ?? [];
    if (holes.length === expectedHoles && holes.length > 0) {
      return holes.reduce((sum, h) => sum + (h.par ?? 0), 0);
    }
    return c.par ?? DEFAULT_PAR_PER_ROUND;
  };

  const totalPar = perRound.reduce<number>((sum, id) => sum + parForCourse(id), 0);
  const absolute = totalPar + cutLineNum;
  const signed = cutLineNum >= 0 ? `+${cutLineNum}` : String(cutLineNum);

  return (
    <p className="text-xs text-primary/80" data-testid="text-cutline-absolute-strokes">
      = <span className="font-semibold text-primary">{absolute} strokes</span>
      {' '}(par {totalPar} {signed}, after round {afterRound})
    </p>
  );
}

/* ─── Settings Dialog ────────────────────────────────────────────── */

function TournamentSettingsDialog({ open, onClose, tournament, orgId, tournamentId }: {
  open: boolean; onClose: () => void;
  tournament: TournamentDetailExt; orgId: number; tournamentId: number;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: courses } = useListCourses(orgId, { query: { enabled: !!orgId, queryKey: getListCoursesQueryKey(orgId) } });

  const [name, setName] = useState(tournament.name ?? '');
  const [description, setDescription] = useState(tournament.description ?? '');
  const [format, setFormat] = useState(tournament.format ?? 'stroke_play');
  const [courseId, setCourseId] = useState(String(tournament.courseId ?? ''));
  const [startDate, setStartDate] = useState(tournament.startDate ? tournament.startDate.split('T')[0] : '');
  const [endDate, setEndDate] = useState(tournament.endDate ? tournament.endDate.split('T')[0] : '');
  const [maxPlayers, setMaxPlayers] = useState(String(tournament.maxPlayers ?? ''));
  const [rounds, setRounds] = useState(String(tournament.rounds ?? 1));
  const [selfPosting, setSelfPosting] = useState(tournament.selfPosting ?? false);
  const [markerValidation, setMarkerValidation] = useState(tournament.markerValidation ?? false);
  const [scoringCloseTime, setScoringCloseTime] = useState((tournament as { scoringCloseTime?: string }).scoringCloseTime ?? '');
  const [correctionWindowHours, setCorrectionWindowHours] = useState(String((tournament as { correctionWindowHours?: number }).correctionWindowHours ?? 24));
  const [checkInCutoffAt, setCheckInCutoffAt] = useState(tournament.checkInCutoffAt ? tournament.checkInCutoffAt.slice(0, 16) : '');
  const [cutLine, setCutLine] = useState(tournament.cutLine != null ? String(tournament.cutLine) : '');
  const [cutAfterRound, setCutAfterRound] = useState(tournament.cutAfterRound != null ? String(tournament.cutAfterRound) : '');
  const [cutPosition, setCutPosition] = useState(tournament.cutPosition ?? '');
  const [maxScoreCap, setMaxScoreCap] = useState(tournament.maxScoreCap != null ? String(tournament.maxScoreCap) : '');
  const [stablefordConfig, setStablefordConfig] = useState<{ eagle?: number; birdie?: number; par?: number; bogey?: number; double?: number; worse?: number; bestOf?: number } | null>(tournament.stablefordPointsConfig ?? null);
  const [showStablefordConfig, setShowStablefordConfig] = useState(false);
  const [handicapAllowance, setHandicapAllowance] = useState(String(tournament.handicapAllowance ?? 100));
  const [entryFee, setEntryFee] = useState(tournament.entryFee ? String(tournament.entryFee) : '');
  const [currency, setCurrency] = useState(tournament.currency ?? 'INR');
  const [reminderDaysBefore, setReminderDaysBefore] = useState(tournament.reminderDaysBefore != null ? String(tournament.reminderDaysBefore) : '');
  const [localRulesConfig, setLocalRulesConfig] = useState(tournament.localRulesConfig || {});
  const [tiebreakerMethod, setTiebreakerMethod] = useState(tournament.tiebreakerMethod ?? 'countback');
  const [leaderboardType, setLeaderboardType] = useState(tournament.leaderboardType ?? 'both');
  const [localRules, setLocalRules] = useState(tournament.localRules ?? '');
  const [courseConditions, setCourseConditions] = useState(tournament.courseConditions ?? '');
  const [oddsWidgetsEnabled, setOddsWidgetsEnabled] = useState(tournament.oddsWidgetsEnabled ?? true);
  const [predictionsEnabled, setPredictionsEnabled] = useState(tournament.predictionsEnabled ?? true);
  const [roundCourses, setRoundCourses] = useState<Record<number, string>>({});
  const [savingRounds, setSavingRounds] = useState(false);

  useEffect(() => {
    if (parseInt(rounds) < 2) return;
    fetch(`/api/organizations/${orgId}/tournaments/${tournamentId}/rounds`, { credentials: 'include' })
      .then(r => r.json())
      .then((data: { roundNumber: number; courseId: number | null }[]) => {
        const map: Record<number, string> = {};
        for (const row of data) map[row.roundNumber] = String(row.courseId ?? '');
        setRoundCourses(map);
      }).catch(() => {});
  }, [orgId, tournamentId, rounds]);

  const saveRoundCourses = async () => {
    setSavingRounds(true);
    try {
      const promises = Object.entries(roundCourses).map(([rn, cId]) =>
        fetch(`/api/organizations/${orgId}/tournaments/${tournamentId}/rounds/${rn}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
          body: JSON.stringify({ courseId: cId ? parseInt(cId) : null }),
        })
      );
      await Promise.all(promises);
      toast({ title: 'Round course assignments saved' });
    } catch { toast({ title: 'Failed to save round assignments', variant: 'destructive' }); }
    finally { setSavingRounds(false); }
  };

  const { mutate: updateTournament, isPending } = useUpdateTournament({
    mutation: {
      onSuccess: () => {
        toast({ title: 'Tournament updated successfully' });
        queryClient.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/tournaments/${tournamentId}`] });
        queryClient.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/tournaments`] });
        onClose();
      },
      onError: () => toast({ title: 'Failed to update tournament', variant: 'destructive' }),
    }
  });

  const [savingTemplate, setSavingTemplate] = useState(false);

  const handleSaveAsTemplate = async () => {
    setSavingTemplate(true);
    try {
      const templateName = `${name} Template`;
      const res = await fetch(`/api/organizations/${orgId}/tournament-templates/from-tournament/${tournamentId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ templateName }),
      });
      if (!res.ok) throw new Error('Failed');
      toast({ title: `Template "${templateName}" saved!` });
    } catch {
      toast({ title: 'Failed to save template', variant: 'destructive' });
    } finally {
      setSavingTemplate(false);
    }
  };

  const handleSave = () => {
    if (!name.trim()) { toast({ title: 'Tournament name is required', variant: 'destructive' }); return; }
    updateTournament({
      orgId,
      tournamentId,
      data: {
        name: name.trim(),
        description: description.trim() || undefined,
        format: format as CreateTournamentInputFormat,
        courseId: courseId ? parseInt(courseId) : undefined,
        startDate: startDate || undefined,
        endDate: endDate || undefined,
        maxPlayers: maxPlayers ? parseInt(maxPlayers) : undefined,
        rounds: rounds ? parseInt(rounds) : 1,
        selfPosting,
        markerValidation,
        checkInCutoffAt: checkInCutoffAt || undefined,
        cutLine: cutLine !== '' ? parseInt(cutLine) : null,
        cutAfterRound: cutAfterRound !== '' ? parseInt(cutAfterRound) : null,
        cutPosition: cutPosition || null,
        maxScoreCap: maxScoreCap !== '' ? parseInt(maxScoreCap) : null,
        stablefordPointsConfig: stablefordConfig ?? null,
        handicapAllowance: handicapAllowance ? parseInt(handicapAllowance) : 100,
        entryFee: entryFee ? entryFee : undefined,
        currency: currency || 'INR',
        reminderDaysBefore: reminderDaysBefore !== '' ? parseInt(reminderDaysBefore) : null,
        tiebreakerMethod: tiebreakerMethod || 'countback',
        leaderboardType: leaderboardType || 'both',
        localRules: localRules.trim() || null,
        localRulesConfig,
        courseConditions: courseConditions.trim() || null,
        scoringCloseTime: scoringCloseTime || null,
        correctionWindowHours: correctionWindowHours ? parseInt(correctionWindowHours) : 24,
        oddsWidgetsEnabled,
        predictionsEnabled,
      // Cast needed: TournamentDetail settings omit isPublic/allowSpectators (server defaults them)
      } as unknown as Parameters<typeof updateTournament>[0]['data'],
    });
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="glass-panel border-white/10 sm:max-w-[560px] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-2xl font-display text-white flex items-center gap-2">
            <Settings className="w-5 h-5 text-primary" /> Tournament Settings
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 mt-2">
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-white">Tournament Name *</label>
            <Input value={name} onChange={e => setName(e.target.value)} className="bg-black/50 border-white/10 text-white" />
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium text-white">Description</label>
            <Input value={description} onChange={e => setDescription(e.target.value)} placeholder="Optional description..." className="bg-black/50 border-white/10 text-white" />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-white">Format</label>
              <Select value={format} onValueChange={(v) => setFormat(v as typeof format)}>
                <SelectTrigger className="bg-black/50 border-white/10 text-white">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-card border-white/10 text-white">
                  {FORMATS.map(f => <SelectItem key={f.value} value={f.value}>{f.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <label className="text-sm font-medium text-white">Course</label>
              <Select value={courseId} onValueChange={setCourseId}>
                <SelectTrigger className="bg-black/50 border-white/10 text-white">
                  <SelectValue placeholder="Select course..." />
                </SelectTrigger>
                <SelectContent className="bg-card border-white/10 text-white">
                  {courses?.map(c => <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-white">Start Date</label>
              <Input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} className="bg-black/50 border-white/10 text-white" />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-white">End Date</label>
              <Input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} className="bg-black/50 border-white/10 text-white" />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-white">Max Players</label>
              <Input type="number" value={maxPlayers} onChange={e => setMaxPlayers(e.target.value)} placeholder="Unlimited" min={1} className="bg-black/50 border-white/10 text-white" />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-white">Rounds</label>
              <Input type="number" value={rounds} onChange={e => setRounds(e.target.value)} min={1} max={4} className="bg-black/50 border-white/10 text-white" />
            </div>
          </div>

          {parseInt(rounds) > 1 && (
            <div className="border border-blue-500/20 rounded-lg p-3 space-y-2 bg-blue-500/5">
              <div className="flex items-center justify-between">
                <p className="text-xs text-blue-400 font-semibold uppercase tracking-wider flex items-center gap-1.5">
                  <Layers className="w-3 h-3" /> Multi-Course Round Assignment
                </p>
                <Button size="sm" onClick={saveRoundCourses} disabled={savingRounds} className="h-6 text-xs bg-blue-600/30 hover:bg-blue-600/50 text-blue-300 border border-blue-500/30 px-2">
                  {savingRounds ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Save Rounds'}
                </Button>
              </div>
              {Array.from({ length: parseInt(rounds) }, (_, i) => i + 1).map(rn => (
                <div key={rn} className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground w-16 flex-shrink-0">Round {rn}</span>
                  <Select value={roundCourses[rn] || '_empty'} onValueChange={v => setRoundCourses(rc => ({ ...rc, [rn]: v === '_empty' ? '' : v }))}>
                    <SelectTrigger className="flex-1 bg-black/40 border-white/10 text-white h-7 text-xs">
                      <SelectValue placeholder="Same as tournament course" />
                    </SelectTrigger>
                    <SelectContent className="bg-card border-white/10 text-white">
                      <SelectItem value="_empty" className="text-muted-foreground text-xs">Same as tournament course</SelectItem>
                      {courses?.map(c => <SelectItem key={c.id} value={String(c.id)} className="text-white text-xs">{c.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              ))}
            </div>
          )}

          <div className="border-t border-white/10 pt-4 space-y-3">
            <p className="text-xs text-muted-foreground uppercase tracking-wider font-semibold">Check-In</p>
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-white">Check-In Cut-Off Time</label>
              <Input
                type="datetime-local"
                value={checkInCutoffAt}
                onChange={e => setCheckInCutoffAt(e.target.value)}
                className="bg-black/50 border-white/10 text-white"
              />
              <p className="text-xs text-muted-foreground">Players not checked in after this time can be bulk-marked as DNS (Did Not Start).</p>
            </div>
          </div>

          <div className="border-t border-white/10 pt-4 space-y-3">
            <p className="text-xs text-muted-foreground uppercase tracking-wider font-semibold">Scoring Options</p>
            <label className="flex items-center justify-between gap-3 cursor-pointer group">
              <div>
                <p className="text-sm font-medium text-white">Allow Self-Posting</p>
                <p className="text-xs text-muted-foreground">Players can submit their own scores via the mobile app</p>
              </div>
              <button
                type="button"
                onClick={() => setSelfPosting(v => !v)}
                className={`relative w-11 h-6 rounded-full transition-colors ${selfPosting ? 'bg-primary' : 'bg-white/10'}`}
              >
                <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${selfPosting ? 'translate-x-5' : ''}`} />
              </button>
            </label>

            {selfPosting && (
              <label className="flex items-center justify-between gap-3 cursor-pointer pl-4 border-l border-primary/30">
                <div>
                  <p className="text-sm font-medium text-white">Require Marker Validation</p>
                  <p className="text-xs text-muted-foreground">Scores need a playing partner to approve before they count</p>
                </div>
                <button
                  type="button"
                  onClick={() => setMarkerValidation(v => !v)}
                  className={`relative w-11 h-6 rounded-full transition-colors ${markerValidation ? 'bg-primary' : 'bg-white/10'}`}
                >
                  <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${markerValidation ? 'translate-x-5' : ''}`} />
                </button>
              </label>
            )}
            {selfPosting && (
              <div className="pl-4 border-l border-primary/30 space-y-3">
                <div className="space-y-1.5">
                  <label className="text-sm font-medium text-white">Scoring Deadline (time of day)</label>
                  <Input
                    type="time"
                    value={scoringCloseTime}
                    onChange={e => setScoringCloseTime(e.target.value)}
                    className="bg-black/50 border-white/10 text-white w-36"
                  />
                  <p className="text-xs text-muted-foreground">Scorecards must be countersigned by this time. Shown as a countdown timer to players.</p>
                </div>
                <div className="space-y-1.5">
                  <label className="text-sm font-medium text-white">Marker Review Window (hours)</label>
                  <Input
                    type="number"
                    min="1"
                    max="168"
                    value={correctionWindowHours}
                    onChange={e => setCorrectionWindowHours(e.target.value)}
                    className="bg-black/50 border-white/10 text-white w-24"
                  />
                  <p className="text-xs text-muted-foreground">How long the marker has to countersign after the player submits (WHS default: 24h). Cards not countersigned within this window are escalated to the committee.</p>
                </div>
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-white">Cut Line <span className="text-muted-foreground font-normal">(score-to-par)</span></label>
              <Input
                type="number"
                placeholder="e.g. 36 (blank = no cut)"
                value={cutLine}
                onChange={e => setCutLine(e.target.value)}
                className="bg-black/50 border-white/10 text-white"
                data-testid="input-cut-line"
              />
              <p className="text-xs text-muted-foreground">Players above this score-to-par are cut.</p>
              <CutPreview
                orgId={orgId}
                courseId={courseId}
                roundCourses={roundCourses}
                cutLine={cutLine}
                cutAfterRound={cutAfterRound}
                rounds={rounds}
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-white">Handicap Allowance (%)</label>
              <Input
                type="number"
                min="0"
                max="100"
                value={handicapAllowance}
                onChange={e => setHandicapAllowance(e.target.value)}
                className="bg-black/50 border-white/10 text-white"
              />
              <p className="text-xs text-muted-foreground">% of course handicap applied. 100 = full handicap.</p>
            </div>
          </div>

          {/* Cut-line automation for multi-round events */}
          {parseInt(rounds) >= 2 && (
            <div className="bg-white/5 rounded-xl p-3 space-y-3 border border-white/10">
              <p className="text-xs text-muted-foreground uppercase tracking-wider font-semibold">Cut Automation</p>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <label className="text-sm font-medium text-white">Cut After Round</label>
                  <Input
                    type="number"
                    min={1}
                    max={parseInt(rounds) - 1 || 1}
                    placeholder={`1–${Math.max(1, parseInt(rounds) - 1)}`}
                    value={cutAfterRound}
                    onChange={e => setCutAfterRound(e.target.value)}
                    className="bg-black/50 border-white/10 text-white"
                  />
                  <p className="text-xs text-muted-foreground">Which round triggers the cut.</p>
                </div>
                <div className="space-y-1.5">
                  <label className="text-sm font-medium text-white">Cut Position</label>
                  <Select value={cutPosition || 'none'} onValueChange={v => setCutPosition(v === 'none' ? '' : v)}>
                    <SelectTrigger className="bg-black/50 border-white/10 text-white">
                      <SelectValue placeholder="No position cut" />
                    </SelectTrigger>
                    <SelectContent className="bg-card border-white/10 text-white">
                      <SelectItem value="none">None (score-to-par only)</SelectItem>
                      <SelectItem value="top50">Top 50</SelectItem>
                      <SelectItem value="top50_ties">Top 50 + Ties</SelectItem>
                      <SelectItem value="top65">Top 65</SelectItem>
                      <SelectItem value="top65_ties">Top 65 + Ties</SelectItem>
                      <SelectItem value="top70">Top 70</SelectItem>
                      <SelectItem value="top70_ties">Top 70 + Ties</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">Position-based cut (overrides score-to-par).</p>
                </div>
              </div>
            </div>
          )}

          {/* Maximum Score cap — only for maximum_score format */}
          {format === 'maximum_score' && (
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-white">Max Score Cap <span className="text-muted-foreground font-normal">(strokes over par)</span></label>
              <Input
                type="number"
                min={1}
                max={10}
                placeholder="e.g. 2 (double bogey cap)"
                value={maxScoreCap}
                onChange={e => setMaxScoreCap(e.target.value)}
                className="bg-black/50 border-white/10 text-white"
              />
              <p className="text-xs text-muted-foreground">Each hole score is capped at par + this value before stableford calculation.</p>
            </div>
          )}

          {/* Stableford points configuration */}
          {(format === 'stableford' || format === 'team_stableford') && (
            <div className="bg-white/5 rounded-xl p-3 space-y-3 border border-white/10">
              <div className="flex items-center justify-between">
                <p className="text-xs text-muted-foreground uppercase tracking-wider font-semibold">Stableford Points Table</p>
                <button
                  type="button"
                  onClick={() => setShowStablefordConfig(v => !v)}
                  className="text-xs text-primary hover:underline"
                >
                  {showStablefordConfig ? 'Hide' : 'Customise'}
                </button>
              </div>
              {!showStablefordConfig ? (
                <p className="text-xs text-muted-foreground">
                  {stablefordConfig
                    ? `Custom: Eagle ${stablefordConfig.eagle ?? 4}, Birdie ${stablefordConfig.birdie ?? 3}, Par ${stablefordConfig.par ?? 2}, Bogey ${stablefordConfig.bogey ?? 1}, Double+ ${stablefordConfig.double ?? 0}`
                    : 'WHS Standard: Eagle 4, Birdie 3, Par 2, Bogey 1, Double+ 0'}
                </p>
              ) : (
                <div className="grid grid-cols-3 gap-2">
                  {(['eagle', 'birdie', 'par', 'bogey', 'double', 'worse'] as const).map(key => (
                    <div key={key} className="space-y-1">
                      <label className="text-xs text-muted-foreground capitalize">{key === 'worse' ? 'Triple+' : key}</label>
                      <Input
                        type="number"
                        min={0}
                        max={10}
                        placeholder={key === 'eagle' ? '4' : key === 'birdie' ? '3' : key === 'par' ? '2' : key === 'bogey' ? '1' : '0'}
                        value={stablefordConfig?.[key] !== undefined ? String(stablefordConfig[key]) : ''}
                        onChange={e => {
                          const val = e.target.value === '' ? undefined : parseInt(e.target.value);
                          setStablefordConfig(prev => ({ ...prev, [key]: val }));
                        }}
                        className="bg-black/50 border-white/10 text-white text-sm"
                      />
                    </div>
                  ))}
                </div>
              )}
              {showStablefordConfig && (
                <button
                  type="button"
                  onClick={() => setStablefordConfig(null)}
                  className="text-xs text-red-400 hover:underline"
                >
                  Reset to WHS defaults
                </button>
              )}
              {/* Best-of count for Team Stableford */}
              {format === 'team_stableford' && (
                <div className="space-y-1 border-t border-white/10 pt-3">
                  <label className="text-xs text-muted-foreground uppercase tracking-wider font-semibold">Best N Players Per Hole</label>
                  <Input
                    type="number"
                    min={1}
                    max={8}
                    placeholder="Auto (half team)"
                    value={stablefordConfig?.bestOf !== undefined ? String(stablefordConfig.bestOf) : ''}
                    onChange={e => {
                      const val = e.target.value === '' ? undefined : parseInt(e.target.value);
                      setStablefordConfig(prev => ({ ...prev, bestOf: val }));
                    }}
                    className="bg-black/50 border-white/10 text-white text-sm"
                  />
                  <p className="text-xs text-muted-foreground">How many players' Stableford points count per hole. Default: half the team size.</p>
                </div>
              )}
            </div>
          )}

          <div className="border-t border-white/10 pt-4 space-y-3">
            <p className="text-xs text-muted-foreground uppercase tracking-wider font-semibold">Payment</p>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <label className="text-sm font-medium text-white">Entry Fee</label>
                <Input
                  type="number"
                  min={0}
                  step="0.01"
                  placeholder="Leave blank for free"
                  value={entryFee}
                  onChange={e => setEntryFee(e.target.value)}
                  className="bg-black/50 border-white/10 text-white"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium text-white">Currency</label>
                <select
                  value={currency}
                  onChange={e => setCurrency(e.target.value)}
                  className="w-full h-9 rounded-md border border-white/10 bg-black/50 text-white px-3 text-sm focus:outline-none"
                >
                  {[['INR','₹ Indian Rupee'],['USD','$ US Dollar'],['GBP','£ British Pound'],['EUR','€ Euro'],['AED','د.إ UAE Dirham'],['SGD','S$ Singapore Dollar'],['AUD','A$ Australian Dollar']].map(([v,l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </div>
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-white">Payment Reminder (days before)</label>
              <Input
                type="number"
                min={1}
                max={90}
                placeholder="e.g. 7 (leave blank to disable)"
                value={reminderDaysBefore}
                onChange={e => setReminderDaysBefore(e.target.value)}
                className="bg-black/50 border-white/10 text-white"
              />
              <p className="text-xs text-muted-foreground">Send unpaid players a reminder email this many days before the tournament.</p>
            </div>
          </div>

          <div className="border-t border-white/10 pt-4 space-y-3">
            <p className="text-xs text-muted-foreground uppercase tracking-wider font-semibold">Scoring Rules</p>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <label className="text-sm font-medium text-white">Tie-Breaker Method</label>
                <Select value={tiebreakerMethod} onValueChange={setTiebreakerMethod}>
                  <SelectTrigger className="bg-black/50 border-white/10 text-white">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="bg-card border-white/10 text-white">
                    <SelectItem value="countback">Countback (last 9/6/3/1)</SelectItem>
                    <SelectItem value="multi_round_countback">Multi-Round Countback</SelectItem>
                    <SelectItem value="net_countback">Net Countback</SelectItem>
                    <SelectItem value="lower_handicap">Lower Handicap</SelectItem>
                    <SelectItem value="no_tiebreaker">No Tie-Breaker</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium text-white">Leaderboard Type</label>
                <Select value={leaderboardType} onValueChange={setLeaderboardType}>
                  <SelectTrigger className="bg-black/50 border-white/10 text-white">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="bg-card border-white/10 text-white">
                    <SelectItem value="both">Gross &amp; Net</SelectItem>
                    <SelectItem value="gross">Gross Only</SelectItem>
                    <SelectItem value="net">Net Only</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>

          <div className="border-t border-white/10 pt-4 space-y-3">
            <p className="text-xs text-muted-foreground uppercase tracking-wider font-semibold">Public Fan Engagement</p>
            <label className="flex items-center justify-between gap-3 cursor-pointer group">
              <div>
                <p className="text-sm font-medium text-white">Live Odds Widgets</p>
                <p className="text-xs text-muted-foreground">Show fan-friendly live insights on public pages</p>
              </div>
              <button
                type="button"
                onClick={() => setOddsWidgetsEnabled(v => !v)}
                className={`relative w-11 h-6 rounded-full transition-colors ${oddsWidgetsEnabled ? 'bg-primary' : 'bg-white/10'}`}
                aria-label="Toggle live odds widgets"
                data-testid="toggle-odds-widgets"
              >
                <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${oddsWidgetsEnabled ? 'translate-x-5' : ''}`} />
              </button>
            </label>
            <label className="flex items-center justify-between gap-3 cursor-pointer group">
              <div>
                <p className="text-sm font-medium text-white">Predictions Game</p>
                <p className="text-xs text-muted-foreground">Show fan-friendly prediction game on public pages</p>
              </div>
              <button
                type="button"
                onClick={() => setPredictionsEnabled(v => !v)}
                className={`relative w-11 h-6 rounded-full transition-colors ${predictionsEnabled ? 'bg-primary' : 'bg-white/10'}`}
                aria-label="Toggle predictions game"
                data-testid="toggle-predictions"
              >
                <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${predictionsEnabled ? 'translate-x-5' : ''}`} />
              </button>
            </label>
          </div>

          <div className="border-t border-white/10 pt-4 space-y-3">
            <p className="text-xs text-muted-foreground uppercase tracking-wider font-semibold flex items-center gap-2">
              <ShieldCheck className="w-3.5 h-3.5" /> Local Rules Configuration
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <label className="flex items-center justify-between gap-3 p-3 rounded-xl bg-black/30 border border-white/5 cursor-pointer">
                <div>
                  <p className="text-sm font-medium text-white">Preferred Lies</p>
                  <p className="text-[10px] text-muted-foreground">"Winter rules" in effect</p>
                </div>
                <button type="button" onClick={() => setLocalRulesConfig((prev: any) => ({ ...prev, preferredLies: !prev.preferredLies }))}
                  className={`relative w-10 h-5 rounded-full transition-colors ${localRulesConfig.preferredLies ? 'bg-primary' : 'bg-white/10'}`}>
                  <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${localRulesConfig.preferredLies ? 'translate-x-5' : ''}`} />
                </button>
              </label>

              <label className="flex items-center justify-between gap-3 p-3 rounded-xl bg-black/30 border border-white/5 cursor-pointer">
                <div>
                  <p className="text-sm font-medium text-white">Lift, Clean & Place</p>
                  <p className="text-[10px] text-muted-foreground">Ball can be cleaned</p>
                </div>
                <button type="button" onClick={() => setLocalRulesConfig((prev: any) => ({ ...prev, liftCleanPlace: !prev.liftCleanPlace }))}
                  className={`relative w-10 h-5 rounded-full transition-colors ${localRulesConfig.liftCleanPlace ? 'bg-primary' : 'bg-white/10'}`}>
                  <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${localRulesConfig.liftCleanPlace ? 'translate-x-5' : ''}`} />
                </button>
              </label>
            </div>

            <div className="space-y-1.5">
              <label className="text-sm font-medium text-white">Drop Zones / Specific Rules</label>
              <Input value={(localRulesConfig.dropZones as string) || ''} onChange={e => setLocalRulesConfig((prev: any) => ({ ...prev, dropZones: e.target.value }))}
                placeholder="e.g. Drop zone at 14th hole pond" className="bg-black/50 border-white/10 text-white" />
            </div>
          </div>

          <div className="border-t border-white/10 pt-4 space-y-3">
            <p className="text-xs text-muted-foreground uppercase tracking-wider font-semibold">Local Rules (Pocket Scorecards)</p>
            <div className="space-y-1.5">
              <textarea
                value={localRules}
                onChange={e => setLocalRules(e.target.value)}
                placeholder="e.g. White stakes = OOB. Red stakes = Penalty Area. Preferred lies in effect."
                rows={4}
                className="w-full rounded-md border border-white/10 bg-black/50 text-white px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary resize-y"
              />
              <p className="text-xs text-muted-foreground">This text appears on the back panel of printed pocket scorecards.</p>
            </div>
          </div>

          <div className="border-t border-white/10 pt-4 space-y-3">
            <p className="text-xs text-muted-foreground uppercase tracking-wider font-semibold">Course Conditions</p>
            <div className="space-y-1.5">
              <textarea
                value={courseConditions}
                onChange={e => setCourseConditions(e.target.value)}
                placeholder="e.g. Fairways firm. Greens running at 10.5 on the stimp. Wind 15 mph NW."
                rows={3}
                className="w-full rounded-md border border-white/10 bg-black/50 text-white px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary resize-y"
              />
              <p className="text-xs text-muted-foreground">Printed on each player's pocket scorecard below the player info.</p>
            </div>
          </div>

          <div className="flex flex-col sm:flex-row justify-between gap-3 pt-2">
            <Button variant="outline" onClick={handleSaveAsTemplate} disabled={savingTemplate} className="border-white/10 text-muted-foreground hover:text-white hover:bg-white/5 text-xs">
              {savingTemplate ? 'Saving...' : '📋 Save as Template'}
            </Button>
            <div className="flex gap-3">
              <Button variant="ghost" onClick={onClose} className="hover:bg-white/5 text-white">Cancel</Button>
              <Button onClick={handleSave} disabled={isPending} className="bg-primary hover:bg-primary/90 text-primary-foreground">
                {isPending ? 'Saving...' : 'Save Changes'}
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ─── Leaderboard Tab ────────────────────────────────────────────── */

function LeaderboardTab({ orgId, tournamentId }: { orgId: number, tournamentId: number }) {
  const { data, isLoading, isConnected } = useLiveLeaderboard(orgId, tournamentId);
  const [selectedRound, setSelectedRound] = useState(0); // 0 = Total
  const [viewMode, setViewMode] = useState<'individual' | 'teams'>('individual');
  const [scoreMode, setScoreMode] = useState<'gross' | 'net' | 'stableford'>('gross');
  const [tableVisible, setTableVisible] = useState(true);

  const handleScoreModeChange = (v: 'gross' | 'net' | 'stableford') => {
    setTableVisible(false);
    setTimeout(() => { setScoreMode(v); setTableVisible(true); }, 180);
  };
  const [roundData, setRoundData] = useState<{ round: number; totalRounds: number; players: Array<{ playerId: number; playerName: string; holeScores: Array<{ hole: number; strokes: number; round: number }> }> } | null>(null);
  const [roundLoading, setRoundLoading] = useState(false);

  const baseUrl = (import.meta.env.BASE_URL ?? '/').replace(/\/$/, '');
  const totalRounds = (data?.rounds ?? 1) as number;
  const cutLine = (data as { cutLine?: number | null } | undefined)?.cutLine ?? null;
  const dataExt = data as (typeof data & { teamEntries?: any[]; isTeamFormat?: boolean; teamCount?: number; netEntries?: any[]; stablefordEntries?: any[]; availableViews?: string[]; leaderboardType?: string | null }) | undefined;
  const teamEntries: any[] = dataExt?.teamEntries ?? [];
  // Show team view toggle when teams exist: use teamCount from payload when available,
  // falling back to teamEntries.length so the toggle appears as soon as team data arrives.
  const hasTeams = !!(dataExt?.isTeamFormat && ((dataExt.teamCount ?? 0) > 0 || teamEntries.length > 0));
  const adminAvailableViews: Array<'gross' | 'net' | 'stableford'> = (dataExt?.availableViews?.filter(
    (v): v is 'gross' | 'net' | 'stableford' => ['gross', 'net', 'stableford'].includes(v)
  )) ?? (
    dataExt?.leaderboardType === 'net' ? ['net'] :
    dataExt?.leaderboardType === 'stableford' ? ['stableford'] :
    ['gross', 'net']
  );

  // Normalize scoreMode against availableViews when data loads
  useEffect(() => {
    if (adminAvailableViews.length > 0) {
      setScoreMode(prev => adminAvailableViews.includes(prev) ? prev : adminAvailableViews[0]);
    }
  }, [adminAvailableViews.join(",")]);

  // Fetch per-round data when a specific round is selected
  useEffect(() => {
    if (selectedRound === 0 || !orgId || !tournamentId) { setRoundData(null); return; }
    setRoundLoading(true);
    fetch(`${baseUrl}/api/organizations/${orgId}/tournaments/${tournamentId}/scores?round=${selectedRound}`, { credentials: 'include' })
      .then(r => r.ok ? r.json() : null)
      .then(d => setRoundData(d))
      .catch(() => setRoundData(null))
      .finally(() => setRoundLoading(false));
  }, [selectedRound, orgId, tournamentId, baseUrl]);

  const getScoreColor = (score: number | null) => {
    if (score === null) return "text-muted-foreground";
    if (score <= -2) return "bg-amber-500/25 text-amber-300 font-bold px-2 py-0.5 rounded border border-amber-500/45";
    if (score === -1) return "text-red-400 font-bold";
    if (score === 0) return "text-white font-medium";
    if (score === 1) return "bg-blue-500/15 text-blue-300 px-2 py-0.5 rounded font-bold border border-blue-500/30";
    return "bg-purple-500/15 text-purple-300 px-2 py-0.5 rounded font-bold border border-purple-500/30";
  };

  const formatScore = (score: number | null) => {
    if (score === null) return "-";
    if (score === 0) return "E";
    return score > 0 ? `+${score}` : `${score}`;
  };

  type LeaderboardEntryExt = { playerId: number; playerName: string; positionDisplay: string; flight?: string | null; thru?: string; grossScore?: number | null; netScore?: number | null; scoreToPar?: number | null; netToPar?: number | null; stablefordPoints?: number | null; madeCut?: boolean | null; roundScores?: Array<{ round: number; grossScore: number; scoreToPar: number; netScore?: number | null; stablefordPoints?: number | null }> };

  if (isLoading) return <div className="h-64 flex items-center justify-center"><div className="w-8 h-8 rounded-full border-4 border-primary border-t-transparent animate-spin" /></div>;

  // Choose base entries based on scoreMode
  const baseEntries: LeaderboardEntryExt[] = (() => {
    if (scoreMode === 'net') return (dataExt?.netEntries ?? data?.entries ?? []) as LeaderboardEntryExt[];
    if (scoreMode === 'stableford') return (dataExt?.stablefordEntries ?? data?.entries ?? []) as LeaderboardEntryExt[];
    return (data?.entries ?? []) as LeaderboardEntryExt[];
  })();

  // Build per-round leaderboard when a round is selected (mode-aware)
  const displayEntries: LeaderboardEntryExt[] = (() => {
    const base = baseEntries;
    if (selectedRound === 0 || !roundData) return base;
    // Build a gross-score map per player for the selected round
    const scoreMap = new Map<number, number>();
    for (const p of roundData.players) {
      const total = p.holeScores.reduce((a, h) => a + h.strokes, 0);
      if (total > 0) scoreMap.set(p.playerId, total);
    }
    const mapped = base.map(e => {
      const rs = e.roundScores?.find(r => r.round === selectedRound);
      const grossScore = rs?.grossScore ?? scoreMap.get(e.playerId) ?? null;
      return {
        ...e,
        grossScore,
        netScore: rs?.netScore ?? null,
        stablefordPoints: rs?.stablefordPoints ?? null,
        scoreToPar: rs?.scoreToPar ?? null,
        netToPar: rs?.netScore !== null && rs?.netScore !== undefined ? rs.netScore - (data?.coursePar ?? 72) : null,
      };
    });
    if (scoreMode === 'stableford') {
      return mapped
        .sort((a, b) => (b.stablefordPoints ?? 0) - (a.stablefordPoints ?? 0))
        .map((e, i) => ({ ...e, positionDisplay: `${i + 1}` }));
    }
    if (scoreMode === 'net') {
      return mapped
        .sort((a, b) => {
          if (a.netScore === null && b.netScore === null) return 0;
          if (a.netScore === null) return 1;
          if (b.netScore === null) return -1;
          return a.netScore - b.netScore;
        })
        .map((e, i) => ({ ...e, positionDisplay: `${i + 1}` }));
    }
    return mapped
      .sort((a, b) => {
        if (a.grossScore === null && b.grossScore === null) return 0;
        if (a.grossScore === null) return 1;
        if (b.grossScore === null) return -1;
        return a.grossScore - b.grossScore;
      })
      .map((e, i) => ({ ...e, positionDisplay: `${i + 1}` }));
  })();

  // Determine cut line insertion index: first entry where madeCut === false
  const cutInsertIdx = displayEntries.findIndex(e => e.madeCut === false);
  const hasCutLine = cutInsertIdx !== -1;

  return (
    <Card className="glass-panel border-none overflow-hidden">
      <div className="p-4 border-b border-white/5 bg-black/20 flex justify-between items-center flex-wrap gap-3">
        <h2 className="font-display font-bold text-white text-lg flex items-center gap-2">
          {isConnected ? <span className="w-2.5 h-2.5 rounded-full bg-primary animate-pulse shadow-[0_0_8px_rgba(34,197,94,0.8)]" /> : <span className="w-2.5 h-2.5 rounded-full bg-red-500" />}
          Live Leaderboard
        </h2>
        <div className="flex items-center gap-3 flex-wrap">
          {viewMode === 'individual' && adminAvailableViews.length > 1 && (
            <div className="flex items-center gap-1 bg-black/30 rounded-lg p-1 border border-white/10">
              {adminAvailableViews.map(v => (
                <button
                  key={v}
                  onClick={() => handleScoreModeChange(v)}
                  className={`px-3 py-1 text-xs font-semibold rounded-md transition-colors ${scoreMode === v ? v === 'stableford' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-primary/20 text-primary' : 'text-muted-foreground hover:text-white'}`}
                >
                  {v === 'gross' ? 'Gross' : v === 'net' ? 'Net' : 'Stableford'}
                </button>
              ))}
            </div>
          )}
          {hasTeams && (
            <div className="flex items-center gap-1 bg-black/30 rounded-lg p-1 border border-white/10">
              <button
                onClick={() => setViewMode('individual')}
                className={`px-3 py-1 text-xs font-semibold rounded-md transition-colors ${viewMode === 'individual' ? 'bg-primary/20 text-primary' : 'text-muted-foreground hover:text-white'}`}
              >
                Individual
              </button>
              <button
                onClick={() => setViewMode('teams')}
                className={`px-3 py-1 text-xs font-semibold rounded-md transition-colors ${viewMode === 'teams' ? 'bg-indigo-500/20 text-indigo-400' : 'text-muted-foreground hover:text-white'}`}
              >
                Teams
              </button>
            </div>
          )}
          {viewMode === 'individual' && totalRounds > 1 && (
            <div className="flex items-center gap-1 bg-black/30 rounded-lg p-1 border border-white/10">
              <button
                onClick={() => setSelectedRound(0)}
                className={`px-3 py-1 text-xs font-semibold rounded-md transition-colors ${selectedRound === 0 ? 'bg-primary/20 text-primary' : 'text-muted-foreground hover:text-white'}`}
              >
                Total
              </button>
              {Array.from({ length: totalRounds }, (_, i) => i + 1).map(r => (
                <button
                  key={r}
                  onClick={() => setSelectedRound(r)}
                  className={`px-3 py-1 text-xs font-semibold rounded-md transition-colors ${selectedRound === r ? 'bg-primary/20 text-primary' : 'text-muted-foreground hover:text-white'}`}
                >
                  R{r}
                </button>
              ))}
            </div>
          )}
          {data?.lastUpdated && <p className="text-xs text-muted-foreground">Updated: {new Date(data.lastUpdated as string).toLocaleTimeString()}</p>}
        </div>
      </div>
      {roundLoading && viewMode === 'individual' && <div className="py-2 px-4 text-xs text-muted-foreground animate-pulse">Loading round {selectedRound} scores…</div>}

      {/* Teams leaderboard view */}
      {viewMode === 'teams' && (
        <div className="overflow-x-auto relative">
          <div className="pointer-events-none absolute top-0 right-0 bottom-0 w-8 bg-gradient-to-l from-black/40 to-transparent z-10" />
          <Table>
            <TableHeader className="bg-black/40 hover:bg-black/40">
              <TableRow className="border-white/5 sticky top-0 z-10 bg-black/60 backdrop-blur-sm">
                <TableHead className="w-16 text-center text-muted-foreground font-semibold sticky left-0 z-10 bg-black/60">POS</TableHead>
                <TableHead className="text-muted-foreground font-semibold">TEAM</TableHead>
                <TableHead className="text-center text-muted-foreground font-semibold">THRU</TableHead>
                <TableHead className="text-center text-muted-foreground font-semibold">SCORE</TableHead>
                <TableHead className="text-right text-muted-foreground font-semibold pr-6">TO PAR</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {teamEntries.length === 0 ? (
                <TableRow className="border-none hover:bg-transparent">
                  <TableCell colSpan={5} className="text-center py-12 text-muted-foreground">No team scores yet.</TableCell>
                </TableRow>
              ) : (
                teamEntries.map((team: any) => {
                  const pos = team.position ?? 99;
                  const isGold = pos === 1;
                  const isSilver = pos === 2;
                  const isBronze = pos === 3;
                  const thru = team.holesCompleted > 0 ? (team.holesCompleted >= 18 ? 'F' : String(team.holesCompleted)) : '-';
                  return (
                    <TableRow key={team.teamId} className={`border-white/5 transition-colors
                      ${isGold ? 'bg-amber-500/8 border-l-2 border-l-amber-500/60 hover:bg-amber-500/12' : ''}
                      ${isSilver ? 'bg-slate-400/5 hover:bg-slate-400/8' : ''}
                      ${isBronze ? 'bg-orange-700/6 hover:bg-orange-700/9' : ''}
                      ${!isGold && !isSilver && !isBronze ? 'hover:bg-white/[0.02]' : ''}
                    `}>
                      <TableCell className="text-center font-display font-bold text-white/70 sticky left-0 z-10 bg-black/60">
                        {isGold ? <span className="flex items-center justify-center gap-1"><span>🏆</span><span className="text-amber-400 font-extrabold">1</span></span> : team.positionDisplay ?? pos}
                      </TableCell>
                      <TableCell className={`font-semibold ${isGold ? 'text-amber-100 font-extrabold' : isSilver ? 'text-slate-200 font-bold' : isBronze ? 'text-orange-200 font-bold' : 'text-white'}`}>
                        <div className="flex items-center gap-2">
                          {team.teamColour && <div className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: team.teamColour }} />}
                          {team.teamName}
                        </div>
                        {team.members && team.members.length > 0 && (
                          <div className="text-xs text-muted-foreground font-normal mt-0.5">{team.members.map((m: any) => m.playerName).join(', ')}</div>
                        )}
                      </TableCell>
                      <TableCell className="text-center text-muted-foreground font-medium">{thru}</TableCell>
                      <TableCell className="text-center text-white font-display font-semibold">
                        {team.netToPar != null ? (team.netScore ?? '-') : (team.grossScore ?? '-')}
                      </TableCell>
                      <TableCell className="text-right pr-6">
                        <span className={`${getScoreColor(team.netToPar != null ? team.netToPar : (team.scoreToPar ?? null))} !text-[24px] !font-extrabold tabular-nums`}>
                          {formatScore(team.netToPar != null ? team.netToPar : (team.scoreToPar ?? null))}
                        </span>
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </div>
      )}

      {/* Individual leaderboard view */}
      {viewMode === 'individual' && (
      <div className={`overflow-x-auto relative transition-opacity duration-200 ${tableVisible ? 'opacity-100' : 'opacity-0'}`}>
        <div className="pointer-events-none absolute top-0 right-0 bottom-0 w-8 bg-gradient-to-l from-black/40 to-transparent z-10" />
        <Table>
          <TableHeader className="bg-black/40 hover:bg-black/40">
            <TableRow className="border-white/5 sticky top-0 z-10 bg-black/60 backdrop-blur-sm">
              <TableHead className="w-16 text-center text-muted-foreground font-semibold sticky left-0 z-10 bg-black/60">POS</TableHead>
              <TableHead className="text-muted-foreground font-semibold">PLAYER</TableHead>
              <TableHead className="text-center text-muted-foreground font-semibold">THRU</TableHead>
              <TableHead className="text-center text-muted-foreground font-semibold">{selectedRound > 0 ? `R${selectedRound}` : 'TOTAL'}</TableHead>
              <TableHead className="text-right text-muted-foreground font-semibold pr-6">{scoreMode === 'stableford' ? 'PTS' : 'TO PAR'}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {!displayEntries.length ? (
              <TableRow className="border-none hover:bg-transparent">
                <TableCell colSpan={5} className="text-center py-12 text-muted-foreground">No scores recorded yet.</TableCell>
              </TableRow>
            ) : (
              displayEntries.map((entry, idx) => {
                const isMC = entry.madeCut === false;
                const rows: React.ReactNode[] = [];
                if (hasCutLine && idx === cutInsertIdx) {
                  rows.push(
                    <TableRow key="cut-line" className="border-none hover:bg-transparent">
                      <TableCell colSpan={5} className="py-2 px-4">
                        <div className="flex items-center gap-2">
                          <div className="flex-1 h-px bg-red-500/40" />
                          <span className="text-xs text-red-400 font-semibold uppercase tracking-widest whitespace-nowrap">— Cut Line —</span>
                          <div className="flex-1 h-px bg-red-500/40" />
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                }
                const pos = parseInt(entry.positionDisplay ?? '99', 10);
                const isGold = pos === 1 && !isMC;
                const isSilver = pos === 2 && !isMC;
                const isBronze = pos === 3 && !isMC;
                rows.push(
                  <TableRow key={entry.playerId} className={`border-white/5 transition-colors ${isMC ? 'opacity-50' : ''}
                    ${isGold ? 'bg-amber-500/8 border-l-2 border-l-amber-500/60 hover:bg-amber-500/12' : ''}
                    ${isSilver ? 'bg-slate-400/5 hover:bg-slate-400/8' : ''}
                    ${isBronze ? 'bg-orange-700/6 hover:bg-orange-700/9' : ''}
                    ${!isGold && !isSilver && !isBronze ? 'hover:bg-white/[0.02]' : ''}
                  `}>
                    <TableCell className="text-center font-display font-bold text-white/70 sticky left-0 z-10 bg-black/60">
                      {isMC ? <Badge className="bg-red-500/20 text-red-400 border-red-500/30 text-xs px-1">MC</Badge>
                        : isGold ? <span className="flex items-center justify-center gap-1"><span>🏆</span><span className="text-amber-400 font-extrabold">1</span></span>
                        : entry.positionDisplay}
                    </TableCell>
                    <TableCell className={`font-semibold ${isGold ? 'text-amber-100 font-extrabold' : isSilver ? 'text-slate-200 font-bold' : isBronze ? 'text-orange-200 font-bold' : 'text-white'}`}>
                      {entry.playerName}
                      {entry.flight && <span className="ml-2 text-xs font-normal text-muted-foreground bg-white/5 px-2 py-0.5 rounded">{entry.flight}</span>}
                    </TableCell>
                    <TableCell className="text-center text-muted-foreground font-medium">{entry.thru || '18'}</TableCell>
                    <TableCell className="text-center text-white font-display font-semibold">
                      {scoreMode === 'net' ? (entry.netScore ?? '-') : scoreMode === 'stableford' ? (entry.stablefordPoints ?? '-') : (entry.grossScore ?? '-')}
                    </TableCell>
                    <TableCell className="text-right pr-6">
                      {scoreMode === 'stableford' ? (
                        <span className="text-emerald-400 !text-[24px] !font-extrabold tabular-nums">
                          {entry.stablefordPoints !== null && entry.stablefordPoints !== undefined ? `${entry.stablefordPoints}` : '-'}
                        </span>
                      ) : (
                        <span className={`${getScoreColor(scoreMode === 'net' ? (entry.netToPar ?? null) : (entry.scoreToPar ?? null))} !text-[24px] !font-extrabold tabular-nums`}>
                          {formatScore(scoreMode === 'net' ? (entry.netToPar ?? null) : (entry.scoreToPar ?? null))}
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                );
                return rows;
              })
            )}
          </TableBody>
        </Table>
      </div>
      )}
    </Card>
  );
}

/* ─── Players Tab ────────────────────────────────────────────────── */

function PlayersTab({ orgId, tournamentId, checkInCutoffAt }: { orgId: number, tournamentId: number, checkInCutoffAt: string | null }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: playersRaw, isLoading } = useListPlayers(orgId, tournamentId);
  type PlayerItem = NonNullable<typeof playersRaw>[number] & { handicapOverride?: string | number | null; dns?: boolean; notifPrefs?: { preferEmail: boolean; preferPush: boolean; preferSms: boolean; preferWhatsapp: boolean; notifySideGameReceipts: boolean } | null };
  const players = playersRaw as PlayerItem[] | undefined;
  const [addOpen, setAddOpen] = useState(false);
  const [bulkLinking, setBulkLinking] = useState(false);
  const [remindingPlayers, setRemindingPlayers] = useState(false);
  const [selectedPlayerIds, setSelectedPlayerIds] = useState<Set<number>>(new Set());
  const [bulkPlayerLoading, setBulkPlayerLoading] = useState(false);

  const cutoffPassed = checkInCutoffAt ? new Date(checkInCutoffAt) < new Date() : false;
  const [importing, setImporting] = useState(false);
  const [waitlist, setWaitlist] = useState<Array<{ id: number; firstName: string; lastName: string; email: string; position: number; registeredAt: string }>>([]);
  const [waitlistLoading, setWaitlistLoading] = useState(false);
  type WithdrawalRecord = { id: number; playerName: string; playerEmail: string; flight: string | null; teeBox: string | null; paymentStatus: string | null; refundStatus: string; refundReference: string | null; refundNotes: string | null; withdrawnAt: string; actorName: string | null };
  const [withdrawals, setWithdrawals] = useState<WithdrawalRecord[]>([]);
  const [withdrawalsLoading, setWithdrawalsLoading] = useState(false);
  const [updatingRefund, setUpdatingRefund] = useState<number | null>(null);
  const [editingHcp, setEditingHcp] = useState<number | null>(null);
  const [hcpEditVal, setHcpEditVal] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const baseUrl = (import.meta.env.BASE_URL ?? '/').replace(/\/$/, '');

  // Task #709 — flag rounds whose shot data is mostly hand-keyed. Helps the TD
  // spot players whose SG / dispersion stats can't be trusted. Banner UI and
  // DataQualityRow type live in `@/components/FlaggedRoundsBanner` so they can
  // be tested in isolation (see `flagged-rounds-banner.test.tsx`).
  const [dataQuality, setDataQuality] = useState<DataQualityRow[] | null>(null);
  useEffect(() => {
    fetch(`${baseUrl}/api/organizations/${orgId}/tournaments/${tournamentId}/players/data-quality`, { credentials: 'include' })
      .then(r => r.ok ? r.json() : [])
      .then((rows: DataQualityRow[]) => Array.isArray(rows) ? setDataQuality(rows) : setDataQuality([]))
      .catch(() => setDataQuality([]));
  }, [orgId, tournamentId, baseUrl]);
  const flaggedRounds = (dataQuality ?? []).filter(r => r.flagged);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/tournaments/${tournamentId}/players`] });

  const handleBulkPayLinks = async () => {
    const unpaidCount = players?.filter(p => p.paymentStatus !== 'paid').length ?? 0;
    if (!unpaidCount) { toast({ title: 'All players have been paid' }); return; }
    if (!confirm(`Generate payment links for ${unpaidCount} unpaid players and notify them by email?`)) return;
    setBulkLinking(true);
    try {
      const res = await fetch(`/api/payments/bulk-payment-links`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orgId, entityType: 'tournament', entityId: tournamentId }),
      });
      type BulkResult = { created: number; skipped: number; errors?: string[] };
      type BulkError = { error: string };
      const body = await res.json() as BulkResult | BulkError;
      if (res.ok) {
        const result = body as BulkResult;
        toast({ title: `${result.created} payment link(s) created`, description: result.skipped ? `${result.skipped} already had links` : undefined });
        invalidate();
      } else {
        toast({ title: (body as BulkError).error ?? 'Failed to generate links', variant: 'destructive' });
      }
    } finally { setBulkLinking(false); }
  };

  const handleRemindUnpaidPlayers = async () => {
    const unpaidCount = players?.filter(p => p.paymentStatus !== 'paid').length ?? 0;
    if (!unpaidCount) { toast({ title: 'All players have been paid' }); return; }
    if (!confirm(`Send payment reminders to ${unpaidCount} unpaid player(s) for this tournament?`)) return;
    setRemindingPlayers(true);
    try {
      const res = await fetch('/api/payments/remind-unpaid', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orgId, tournamentId }),
      });
      const result = await res.json() as { sent?: number; total?: number; error?: string };
      if (res.ok) {
        toast({ title: `Reminders sent to ${result.sent ?? 0} of ${result.total ?? 0} unpaid players` });
      } else {
        toast({ title: result.error ?? 'Failed to send reminders', variant: 'destructive' });
      }
    } finally { setRemindingPlayers(false); }
  };

  const handleBulkCheckIn = async () => {
    const toCheckIn = Array.from(selectedPlayerIds).filter(id => !players?.find(p => p.id === id)?.checkedIn && !players?.find(p => p.id === id)?.dns);
    if (!toCheckIn.length) { toast({ title: 'No eligible players to check in' }); return; }
    if (!confirm(`Check in ${toCheckIn.length} player(s)?`)) return;
    setBulkPlayerLoading(true);
    try {
      const results = await Promise.all(toCheckIn.map(id =>
        fetch(`${baseUrl}/api/organizations/${orgId}/tournaments/${tournamentId}/players/${id}/checkin`, { method: 'POST', credentials: 'include' })
      ));
      const failed = results.filter(r => !r.ok).length;
      const succeeded = toCheckIn.length - failed;
      if (failed > 0) {
        toast({ title: `${succeeded} checked in, ${failed} failed`, variant: 'destructive' });
      } else {
        toast({ title: `${toCheckIn.length} player(s) checked in` });
      }
      setSelectedPlayerIds(new Set());
      invalidate();
    } finally { setBulkPlayerLoading(false); }
  };

  const handleBulkMarkDns = async () => {
    const ids = Array.from(selectedPlayerIds);
    if (!confirm(`Mark ${ids.length} selected player(s) as DNS?`)) return;
    setBulkPlayerLoading(true);
    try {
      const results = await Promise.all(ids.map(id =>
        fetch(`${baseUrl}/api/organizations/${orgId}/tournaments/${tournamentId}/players/${id}/dns`, {
          method: 'PATCH', credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dns: true }),
        })
      ));
      const failed = results.filter(r => !r.ok).length;
      const succeeded = ids.length - failed;
      if (failed > 0) {
        toast({ title: `${succeeded} marked as DNS, ${failed} failed`, variant: 'destructive' });
      } else {
        toast({ title: `${ids.length} player(s) marked as DNS` });
      }
      setSelectedPlayerIds(new Set());
      invalidate();
    } finally { setBulkPlayerLoading(false); }
  };

  const handleBulkMarkPaidSelected = async () => {
    const unpaid = Array.from(selectedPlayerIds).filter(id => players?.find(p => p.id === id)?.paymentStatus !== 'paid');
    if (!unpaid.length) { toast({ title: 'All selected players already paid' }); return; }
    if (!confirm(`Mark ${unpaid.length} player(s) as paid?`)) return;
    setBulkPlayerLoading(true);
    try {
      const results = await Promise.all(unpaid.map(id =>
        fetch(`/api/payments/tournament-player/${id}/mark-paid`, { method: 'POST', credentials: 'include' })
      ));
      const failed = results.filter(r => !r.ok).length;
      const succeeded = unpaid.length - failed;
      if (failed > 0) {
        toast({ title: `${succeeded} marked as paid, ${failed} failed`, variant: 'destructive' });
      } else {
        toast({ title: `${unpaid.length} player(s) marked as paid` });
      }
      setSelectedPlayerIds(new Set());
      invalidate();
    } finally { setBulkPlayerLoading(false); }
  };

  const fetchWaitlist = async () => {
    setWaitlistLoading(true);
    try {
      const res = await fetch(`${baseUrl}/api/organizations/${orgId}/tournaments/${tournamentId}/waitlist`, { credentials: 'include' });
      if (res.ok) setWaitlist(await res.json());
    } catch { /* ignore */ } finally { setWaitlistLoading(false); }
  };

  const fetchWithdrawals = async () => {
    setWithdrawalsLoading(true);
    try {
      const res = await fetch(`${baseUrl}/api/organizations/${orgId}/tournaments/${tournamentId}/players/withdrawals`, { credentials: 'include' });
      if (res.ok) setWithdrawals(await res.json());
    } catch { /* ignore */ } finally { setWithdrawalsLoading(false); }
  };

  useEffect(() => { fetchWaitlist(); fetchWithdrawals(); }, [orgId, tournamentId]);

  const handleWithdraw = async (playerId: number) => {
    if (!confirm('Withdraw this player? The first player on the waitlist will be auto-promoted.')) return;
    const res = await fetch(`${baseUrl}/api/organizations/${orgId}/tournaments/${tournamentId}/players/${playerId}/withdraw`, { method: 'DELETE', credentials: 'include' });
    if (res.ok) {
      toast({ title: 'Player withdrawn. Waitlist updated.' });
      invalidate();
      fetchWaitlist();
      fetchWithdrawals();
    } else {
      toast({ title: 'Failed to withdraw player', variant: 'destructive' });
    }
  };

  const handleMarkRefund = async (withdrawalId: number, refundStatus: string, refundReference?: string, refundNotes?: string) => {
    setUpdatingRefund(withdrawalId);
    try {
      const res = await fetch(`${baseUrl}/api/organizations/${orgId}/tournaments/${tournamentId}/players/withdrawals/${withdrawalId}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refundStatus, refundReference, refundNotes }),
      });
      if (res.ok) {
        const updated = await res.json();
        setWithdrawals(prev => prev.map(w => w.id === withdrawalId ? { ...w, ...updated } : w));
        toast({ title: `Refund status updated to "${refundStatus}"` });
      } else {
        toast({ title: 'Failed to update refund status', variant: 'destructive' });
      }
    } finally { setUpdatingRefund(null); }
  };

  const handleHcpOverride = async (playerId: number) => {
    const val = parseFloat(hcpEditVal);
    if (isNaN(val) || val < -10 || val > 54) {
      toast({ title: 'Invalid handicap (−10 to 54)', variant: 'destructive' }); return;
    }
    const res = await fetch(`${baseUrl}/api/organizations/${orgId}/tournaments/${tournamentId}/players/${playerId}/handicap-override`, {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ handicapOverride: val }),
    });
    if (res.ok) {
      toast({ title: `Handicap override set to ${val}` });
      setEditingHcp(null);
      invalidate();
    } else {
      toast({ title: 'Failed to update handicap', variant: 'destructive' });
    }
  };

  const { mutate: removePlayer } = useRemovePlayer({
    mutation: { onSuccess: () => { toast({ title: 'Player removed' }); invalidate(); }, onError: () => toast({ title: 'Failed to remove player', variant: 'destructive' }) }
  });

  const { mutate: checkIn } = useCheckInPlayer({
    mutation: { onSuccess: () => { toast({ title: 'Player checked in' }); invalidate(); }, onError: () => toast({ title: 'Failed to check in player', variant: 'destructive' }) }
  });

  const handleDownloadTemplate = () => {
    window.location.href = `/api/organizations/${orgId}/tournaments/${tournamentId}/players/template`;
  };

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImporting(true);
    try {
      const csvContent = await file.text();
      const res = await fetch(`/api/organizations/${orgId}/tournaments/${tournamentId}/players/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ csvContent }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast({ title: 'Import failed', description: data.error, variant: 'destructive' });
      } else {
        toast({ title: `Imported ${data.imported} player${data.imported !== 1 ? 's' : ''}`, description: data.errors?.length ? `${data.errors.length} rows skipped` : undefined });
        invalidate();
      }
    } catch {
      toast({ title: 'Import failed', description: 'Could not read the file', variant: 'destructive' });
    } finally {
      setImporting(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const [markingDns, setMarkingDns] = useState(false);
  const [checkInMode, setCheckInMode] = useState(false);
  const [showPlayerQR, setShowPlayerQR] = useState(false);

  // Auto-refresh player list every 10 seconds when in check-in mode
  useEffect(() => {
    if (!checkInMode) return;
    const timer = setInterval(() => invalidate(), 10000);
    return () => clearInterval(timer);
  }, [checkInMode]);

  const handleMarkDnsCutoff = async () => {
    const notCheckedIn = (players ?? []).filter(p => !p.checkedIn && !p.dns).length;
    if (notCheckedIn === 0) { toast({ title: 'All players already checked in or marked DNS' }); return; }
    if (!confirm(`Mark ${notCheckedIn} unchecked player(s) as DNS (Did Not Start)?`)) return;
    setMarkingDns(true);
    try {
      const res = await fetch(`${baseUrl}/api/organizations/${orgId}/tournaments/${tournamentId}/players/mark-dns`, { method: 'POST', credentials: 'include' });
      const data = await res.json();
      toast({ title: data.message ?? 'DNS cutoff applied' });
      invalidate();
    } catch { toast({ title: 'Failed to mark DNS', variant: 'destructive' }); }
    finally { setMarkingDns(false); }
  };

  if (checkInMode) {
    const sorted = [...(players ?? [])].sort((a, b) => `${a.firstName} ${a.lastName}`.localeCompare(`${b.firstName} ${b.lastName}`));
    const checkedInCount = sorted.filter(p => p.checkedIn).length;
    const totalCount = sorted.length;
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h2 className="text-2xl font-bold text-white flex items-center gap-3">
              <ShieldCheck className="w-7 h-7 text-primary" /> Check-In Mode
            </h2>
            <p className="text-muted-foreground text-sm mt-1">{checkedInCount} of {totalCount} players checked in · auto-refreshes every 10s</p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowPlayerQR(v => !v)}
              className="bg-white/5 border-white/10 hover:bg-white/10 text-white text-xs"
            >
              <Camera className="w-3.5 h-3.5 mr-1.5" /> {showPlayerQR ? 'Hide QR Codes' : 'Show QR Codes'}
            </Button>
            <Button variant="outline" onClick={() => setCheckInMode(false)} className="bg-white/5 border-white/10 hover:bg-white/10 text-white">
              <X className="w-4 h-4 mr-2" /> Exit Check-In Mode
            </Button>
          </div>
        </div>
        {/* Progress bar */}
        <div className="w-full bg-white/10 rounded-full h-2">
          <div className="bg-primary h-2 rounded-full transition-all duration-500" style={{ width: totalCount > 0 ? `${(checkedInCount / totalCount) * 100}%` : '0%' }} />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {sorted.map(p => {
            const isDns = p.dns;
            const isChecked = p.checkedIn;
            const qrPayload = `KHGF:ci:${orgId}:${tournamentId}:${p.id}`;
            const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=80x80&data=${encodeURIComponent(qrPayload)}&bgcolor=0b1512&color=C9A84C&format=png`;
            return (
              <div
                key={p.id}
                className={`rounded-xl border p-4 flex items-center justify-between gap-3 transition-all duration-200 ${
                  isDns ? 'border-red-500/30 bg-red-500/5 opacity-60' :
                  isChecked ? 'border-primary/40 bg-primary/10' :
                  'border-white/10 bg-white/5 hover:bg-white/8'
                }`}
              >
                <div className="flex items-center gap-3 min-w-0">
                  {showPlayerQR && (
                    <img src={qrUrl} alt="Player QR" className="w-10 h-10 rounded shrink-0" />
                  )}
                  <div className="min-w-0">
                    <p className="font-semibold text-white text-base truncate">{p.firstName} {p.lastName}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      HCP {(p.handicapOverride ?? p.handicapIndex) ?? 'N/A'}
                      {p.flight ? ` · ${p.flight}` : ''}
                    </p>
                  </div>
                </div>
                {isDns ? (
                  <span className="text-red-400 text-sm font-semibold flex items-center gap-1.5 shrink-0">
                    <Flag className="w-4 h-4" /> DNS
                  </span>
                ) : isChecked ? (
                  <span className="text-primary text-sm font-semibold flex items-center gap-1.5 shrink-0">
                    <CheckCircle2 className="w-5 h-5" /> In
                  </span>
                ) : (
                  <Button
                    size="lg"
                    onClick={() => checkIn({ orgId, tournamentId, playerId: p.id })}
                    className="bg-primary hover:bg-primary/90 text-primary-foreground font-bold shrink-0 h-12 px-6 text-base"
                  >
                    <ShieldCheck className="w-5 h-5 mr-2" /> Check In
                  </Button>
                )}
              </div>
            );
          })}
        </div>
        {sorted.length === 0 && (
          <p className="text-center text-muted-foreground py-12">No players registered yet.</p>
        )}
        {showPlayerQR && totalCount > 0 && (
          <p className="text-xs text-muted-foreground text-center">
            QR codes encode player check-in data. Scan with the mobile app's Check-In Scanner to mark attendance.
          </p>
        )}
      </div>
    );
  }

  return (
    <>
      <input ref={fileInputRef} type="file" accept=".csv,text/csv" className="hidden" onChange={handleImport} />
      <Card className="glass-panel border-none">
        <div className="p-6 flex flex-wrap justify-between items-center gap-3 border-b border-white/5">
          <CardTitle className="text-white">
            Registered Players ({players?.length ?? 0})
            {players && players.filter(p => p.checkedIn).length > 0 && (
              <span className="ml-2 text-xs text-primary font-normal">
                {players.filter(p => p.checkedIn).length} checked in
              </span>
            )}
          </CardTitle>
          <div className="flex gap-2 flex-wrap">
            <Button size="sm" variant="outline" onClick={() => setCheckInMode(true)} className="bg-primary/10 border-primary/30 hover:bg-primary/20 text-primary text-xs">
              <ShieldCheck className="w-3.5 h-3.5 mr-1" /> Check-In Mode
            </Button>
            <Button size="sm" variant="outline" onClick={handleMarkDnsCutoff} disabled={markingDns} className="bg-red-500/10 border-red-500/30 hover:bg-red-500/20 text-red-400 text-xs" title="Mark all unchecked players as DNS (Did Not Start)">
              <Flag className="w-3.5 h-3.5 mr-1" /> {markingDns ? 'Applying...' : 'DNS Cutoff'}
            </Button>
            <Button size="sm" variant="outline" onClick={handleBulkPayLinks} disabled={bulkLinking} className="bg-blue-500/10 border-blue-500/30 hover:bg-blue-500/20 text-blue-400 text-xs" title="Generate payment links for all unpaid players">
              <Link2 className="w-3.5 h-3.5 mr-1" /> {bulkLinking ? 'Linking...' : 'Bulk Pay Links'}
            </Button>
            {(players?.filter(p => p.paymentStatus !== 'paid').length ?? 0) > 0 && (
              <Button size="sm" variant="outline" onClick={handleRemindUnpaidPlayers} disabled={remindingPlayers} className="bg-yellow-500/10 border-yellow-500/30 hover:bg-yellow-500/20 text-yellow-400 text-xs" title="Send payment reminders to unpaid players">
                <Bell className="w-3.5 h-3.5 mr-1" /> {remindingPlayers ? 'Sending...' : `Remind Unpaid (${players?.filter(p => p.paymentStatus !== 'paid').length ?? 0})`}
              </Button>
            )}
            <Button size="sm" variant="outline" onClick={handleDownloadTemplate} className="bg-white/5 border-white/10 hover:bg-white/10 text-white text-xs">
              <Download className="w-3.5 h-3.5 mr-1" /> Template
            </Button>
            <Button size="sm" variant="outline" onClick={() => fileInputRef.current?.click()} disabled={importing} className="bg-white/5 border-white/10 hover:bg-white/10 text-white text-xs">
              <Upload className="w-3.5 h-3.5 mr-1" /> {importing ? 'Importing...' : 'Import CSV'}
            </Button>
            <Button size="sm" onClick={() => setAddOpen(true)} className="bg-primary hover:bg-primary/90 text-primary-foreground">
              <UserPlus className="w-4 h-4 mr-2" /> Add Player
            </Button>
          </div>
        </div>
        {cutoffPassed && players && players.some(p => !p.checkedIn && !p.dns) && (
          <div className="mx-6 mt-4 rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 flex items-center justify-between gap-3">
            <div>
              <p className="text-red-400 font-semibold text-sm">Check-In Cut-Off Has Passed</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {players.filter(p => !p.checkedIn && !p.dns).length} player(s) are still unchecked. Click to mark them DNS.
              </p>
            </div>
            <Button size="sm" onClick={handleMarkDnsCutoff} disabled={markingDns} className="bg-red-500/20 border border-red-500/40 text-red-400 hover:bg-red-500/30 shrink-0">
              <Flag className="w-3.5 h-3.5 mr-1" /> Apply DNS
            </Button>
          </div>
        )}
        {checkInCutoffAt && !cutoffPassed && (
          <div className="mx-6 mt-4 rounded-lg border border-yellow-500/20 bg-yellow-500/5 px-4 py-2.5 flex items-center gap-2">
            <Flag className="w-3.5 h-3.5 text-yellow-400 shrink-0" />
            <p className="text-xs text-yellow-400">Check-in cut-off: <strong>{new Date(checkInCutoffAt).toLocaleString()}</strong> — unchecked players will be eligible for DNS after this time.</p>
          </div>
        )}
        <FlaggedRoundsBanner flaggedRounds={flaggedRounds} />
        {isLoading ? (
          <div className="p-8 flex justify-center"><div className="w-6 h-6 rounded-full border-4 border-primary border-t-transparent animate-spin" /></div>
        ) : (
          <>
          {selectedPlayerIds.size > 0 && (
            <div className="flex items-center gap-2 flex-wrap bg-primary/20 border border-primary/40 rounded-lg px-3 py-2 mx-4 mt-3 mb-1">
              <span className="text-xs text-emerald-200 font-medium">{selectedPlayerIds.size} selected</span>
              <Button size="sm" onClick={handleBulkCheckIn} disabled={bulkPlayerLoading}
                className="h-7 px-2 text-xs bg-primary/20 hover:bg-primary/30 text-emerald-200 border border-emerald-300/40">
                <ShieldCheck className="w-3 h-3 mr-1" /> Check In
              </Button>
              <Button size="sm" onClick={handleBulkMarkDns} disabled={bulkPlayerLoading}
                className="h-7 px-2 text-xs bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/30">
                <Flag className="w-3 h-3 mr-1" /> Mark DNS
              </Button>
              <Button size="sm" onClick={handleBulkMarkPaidSelected} disabled={bulkPlayerLoading}
                className="h-7 px-2 text-xs bg-yellow-500/10 hover:bg-yellow-500/20 text-yellow-400 border border-yellow-500/30">
                <CheckCircle2 className="w-3 h-3 mr-1" /> Mark Paid
              </Button>
              <button className="text-muted-foreground hover:text-white text-xs ml-1"
                onClick={() => setSelectedPlayerIds(new Set())}>Clear</button>
            </div>
          )}
          <div className="overflow-x-auto relative">
            <div className="pointer-events-none absolute top-0 right-0 bottom-0 w-8 bg-gradient-to-l from-black/40 to-transparent z-10" />
          <Table>
            <TableHeader>
              <TableRow className="border-white/5 border-b sticky top-0 z-10 bg-card/90 backdrop-blur-sm">
                <TableHead className="w-8 sticky left-0 z-10 bg-card/90">
                  <input type="checkbox"
                    checked={!!players?.length && selectedPlayerIds.size === players.length}
                    onChange={e => setSelectedPlayerIds(e.target.checked ? new Set(players?.map(p => p.id) ?? []) : new Set())}
                    className="accent-primary w-4 h-4 cursor-pointer"
                  />
                </TableHead>
                <TableHead className="text-muted-foreground sticky left-8 z-10 bg-card/90">Name</TableHead>
                <TableHead className="text-muted-foreground">Handicap</TableHead>
                <TableHead className="text-muted-foreground">Flight</TableHead>
                <TableHead className="text-muted-foreground">Payment</TableHead>
                <TableHead className="text-muted-foreground">Status</TableHead>
                <TableHead className="text-muted-foreground text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {!players?.length ? (
                <TableRow className="border-none hover:bg-transparent">
                  <TableCell colSpan={7} className="text-center py-12 text-muted-foreground">No players registered yet. Click "Add Player" to get started.</TableCell>
                </TableRow>
              ) : players.map(p => (
                <TableRow key={p.id} className="border-white/5 hover:bg-white/5">
                  <TableCell className="sticky left-0 z-10 bg-card/90 w-8">
                    <input type="checkbox"
                      checked={selectedPlayerIds.has(p.id)}
                      onChange={e => {
                        const next = new Set(selectedPlayerIds);
                        if (e.target.checked) next.add(p.id); else next.delete(p.id);
                        setSelectedPlayerIds(next);
                      }}
                      className="accent-primary w-4 h-4 cursor-pointer"
                    />
                  </TableCell>
                  <TableCell className="font-medium text-white sticky left-8 z-10 bg-card/90">
                    <div>{p.firstName} {p.lastName}</div>
                    {p.notifPrefs && (
                      <div className="flex gap-1 mt-0.5">
                        {p.notifPrefs.preferEmail && <span className="text-[10px] px-1 py-0.5 rounded bg-emerald-500/15 text-emerald-400 border border-emerald-500/25">Email</span>}
                        {p.notifPrefs.preferPush && <span className="text-[10px] px-1 py-0.5 rounded bg-primary/15 text-primary border border-primary/25">Push</span>}
                        {p.notifPrefs.preferSms && <span className="text-[10px] px-1 py-0.5 rounded bg-green-500/15 text-green-400 border border-green-500/25">SMS</span>}
                        {p.notifPrefs.preferWhatsapp && <span className="text-[10px] px-1 py-0.5 rounded bg-emerald-500/15 text-emerald-400 border border-emerald-500/25">WhatsApp</span>}
                        {!p.notifPrefs.notifySideGameReceipts && (
                          <span
                            data-testid={`player-notif-side-game-receipts-opt-out-${p.id}`}
                            title="Member opted out of side-game receipt emails"
                            className="text-[10px] px-1 py-0.5 rounded bg-amber-500/15 text-amber-400 border border-amber-500/25"
                          >
                            No side-game receipts
                          </span>
                        )}
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {editingHcp === p.id ? (
                      <div className="flex items-center gap-1">
                        <Input
                          type="number"
                          value={hcpEditVal}
                          onChange={e => setHcpEditVal(e.target.value)}
                          onKeyDown={e => { if (e.key === 'Enter') handleHcpOverride(p.id); if (e.key === 'Escape') setEditingHcp(null); }}
                          className="h-6 w-16 text-xs bg-black/50 border-white/20 text-white px-1"
                          step="0.1" min="0" max="54" autoFocus
                        />
                        <Button size="sm" variant="ghost" className="h-6 px-1.5 text-xs text-primary" onClick={() => handleHcpOverride(p.id)}>✓</Button>
                        <Button size="sm" variant="ghost" className="h-6 px-1.5 text-xs text-muted-foreground" onClick={() => setEditingHcp(null)}>✕</Button>
                      </div>
                    ) : (
                      <button
                        className="text-left hover:text-white hover:underline underline-offset-2 decoration-dashed cursor-pointer transition-colors"
                        title={p.handicapOverride != null ? `Override active (base: ${p.handicapIndex ?? 'N/A'}). Click to change.` : "Click to override handicap for this tournament"}
                        onClick={() => { setEditingHcp(p.id); setHcpEditVal(String((p.handicapOverride ?? p.handicapIndex) ?? '')); }}
                      >
                        {(p.handicapOverride ?? p.handicapIndex) != null ? (p.handicapOverride ?? p.handicapIndex) : 'N/A'}
                        {p.handicapOverride != null && <span className="text-xs text-yellow-400/70 ml-1">*</span>}
                        <span className="text-xs text-muted-foreground/50 ml-1">✎</span>
                      </button>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{p.flight || '-'}</TableCell>
                  <TableCell>
                    <Badge className={p.paymentStatus === 'paid' ? 'bg-green-500/20 text-green-400 border-green-500/30' : 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30'}>
                      {p.paymentStatus?.toUpperCase()}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {p.dns
                      ? <span className="text-red-400 text-sm flex items-center gap-1"><Flag className="w-3.5 h-3.5" /> DNS</span>
                      : p.checkedIn
                      ? <span className="text-primary text-sm flex items-center gap-1"><CheckCircle2 className="w-3.5 h-3.5" /> Checked In</span>
                      : <span className="text-muted-foreground text-sm">Pending</span>}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-2">
                      {p.paymentStatus !== 'paid' && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={async () => {
                            await fetch(`/api/payments/tournament-player/${p.id}/mark-paid`, {
                              method: 'POST', credentials: 'include',
                              headers: { 'Content-Type': 'application/json' },
                            });
                            invalidate();
                          }}
                          className="h-7 px-2 text-xs text-yellow-400 hover:bg-yellow-500/10"
                        >
                          Mark Paid
                        </Button>
                      )}
                      {p.paymentStatus !== 'paid' && p.email && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={async () => {
                            const res = await fetch(`/api/payments/tournament-player/${p.id}/payment-link`, {
                              method: 'POST', credentials: 'include',
                              headers: { 'Content-Type': 'application/json' },
                            });
                            if (res.ok) {
                              const { url } = await res.json() as { url: string };
                              navigator.clipboard.writeText(url);
                              toast({ title: 'Payment link copied to clipboard', description: url });
                            } else {
                              toast({ title: 'Failed to create payment link', variant: 'destructive' });
                            }
                          }}
                          className="h-7 px-2 text-xs text-blue-400 hover:bg-blue-500/10"
                          title="Create & copy Razorpay payment link"
                        >
                          <Link2 className="w-3 h-3 mr-1" /> Pay Link
                        </Button>
                      )}
                      {p.paymentStatus === 'paid' && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={async () => {
                            const amtStr = window.prompt(`Refund ${p.firstName} ${p.lastName}\n\nEnter refund amount (leave blank for full entry fee):`);
                            if (amtStr === null) return;
                            const res = await fetch(`/api/payments/tournament-player/${p.id}/refund`, {
                              method: 'POST', credentials: 'include',
                              headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify({ amount: amtStr || undefined }),
                            });
                            if (res.ok) {
                              toast({ title: 'Refund initiated' });
                              invalidate();
                            } else {
                              const e = await res.json() as { error: string };
                              toast({ title: e.error ?? 'Refund failed', variant: 'destructive' });
                            }
                          }}
                          className="h-7 px-2 text-xs text-purple-400 hover:bg-purple-500/10"
                          title="Issue Razorpay refund (blank = full entry fee)"
                        >
                          Refund
                        </Button>
                      )}
                      {!p.checkedIn && !p.dns && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => checkIn({ orgId, tournamentId, playerId: p.id })}
                          className="h-7 px-2 text-xs text-primary hover:bg-primary/10"
                        >
                          <ShieldCheck className="w-3.5 h-3.5 mr-1" /> Check In
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={async () => {
                          const isDns = p.dns;
                          await fetch(`${baseUrl}/api/organizations/${orgId}/tournaments/${tournamentId}/players/${p.id}/dns`, {
                            method: 'PATCH', credentials: 'include',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ dns: !isDns }),
                          });
                          invalidate();
                        }}
                        className={`h-7 px-2 text-xs ${p.dns ? 'text-muted-foreground hover:bg-white/5' : 'text-red-400 hover:bg-red-500/10'}`}
                        title={p.dns ? 'Clear DNS status' : 'Mark as DNS (Did Not Start)'}
                      >
                        <Flag className="w-3.5 h-3.5 mr-1" /> {p.dns ? 'Clear DNS' : 'DNS'}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => handleWithdraw(p.id)}
                        className="h-7 px-2 text-orange-400 hover:bg-orange-500/10"
                        title="Withdraw player (auto-promotes waitlist)"
                      >
                        <ArrowRight className="w-3.5 h-3.5 mr-1" /> Withdraw
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => removePlayer({ orgId, tournamentId, playerId: p.id })}
                        className="h-7 px-2 text-destructive hover:bg-destructive/10"
                        title="Permanently remove player"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          </div>
          </>
        )}
      </Card>

      {/* Waitlist Section */}
      {(waitlist.length > 0 || waitlistLoading) && (
        <Card className="glass-panel border-none mt-6">
          <div className="p-6 flex justify-between items-center border-b border-white/5">
            <CardTitle className="text-white flex items-center gap-2">
              <Users className="w-4 h-4 text-yellow-400" />
              Waitlist ({waitlist.length})
            </CardTitle>
            <Button size="sm" variant="ghost" onClick={fetchWaitlist} className="text-xs text-muted-foreground hover:text-white">↻ Refresh</Button>
          </div>
          {waitlistLoading ? (
            <div className="p-6 flex justify-center"><div className="w-5 h-5 rounded-full border-4 border-yellow-400 border-t-transparent animate-spin" /></div>
          ) : (
            <div className="overflow-x-auto relative">
              <div className="pointer-events-none absolute top-0 right-0 bottom-0 w-8 bg-gradient-to-l from-black/40 to-transparent z-10" />
            <Table>
              <TableHeader>
                <TableRow className="border-white/5 sticky top-0 z-10 bg-[#0a1628]">
                  <TableHead className="text-muted-foreground w-12">#</TableHead>
                  <TableHead className="text-muted-foreground sticky left-0 z-10 bg-[#0a1628]">Name</TableHead>
                  <TableHead className="text-muted-foreground">Email</TableHead>
                  <TableHead className="text-muted-foreground">Registered</TableHead>
                  <TableHead className="text-muted-foreground text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {waitlist.map(w => (
                  <TableRow key={w.id} className="border-white/5 hover:bg-white/5">
                    <TableCell className="text-yellow-400 font-bold">{w.position}</TableCell>
                    <TableCell className="text-white font-medium sticky left-0 z-10 bg-[#0a1628]">{w.firstName} {w.lastName}</TableCell>
                    <TableCell className="text-muted-foreground">{w.email}</TableCell>
                    <TableCell className="text-muted-foreground text-sm">{new Date(w.registeredAt).toLocaleDateString()}</TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-2">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={async () => {
                            const res = await fetch(`${baseUrl}/api/organizations/${orgId}/tournaments/${tournamentId}/waitlist/${w.id}/promote`, { method: 'POST', credentials: 'include' });
                            if (res.ok) { toast({ title: `${w.firstName} ${w.lastName} promoted to registered` }); invalidate(); fetchWaitlist(); }
                            else { toast({ title: 'Failed to promote', variant: 'destructive' }); }
                          }}
                          className="h-7 px-2 text-xs text-primary hover:bg-primary/10"
                          title="Promote this player to registered"
                        >
                          <ArrowRight className="w-3.5 h-3.5 mr-1" /> Promote
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={async () => {
                            if (!confirm(`Remove ${w.firstName} ${w.lastName} from the waitlist?`)) return;
                            const res = await fetch(`${baseUrl}/api/organizations/${orgId}/tournaments/${tournamentId}/waitlist/${w.id}`, { method: 'DELETE', credentials: 'include' });
                            if (res.ok) { toast({ title: 'Removed from waitlist' }); fetchWaitlist(); }
                            else { toast({ title: 'Failed to remove', variant: 'destructive' }); }
                          }}
                          className="h-7 px-2 text-xs text-destructive hover:bg-destructive/10"
                          title="Remove from waitlist"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            </div>
          )}
        </Card>
      )}

      {/* Withdrawn Players Section */}
      {(withdrawals.length > 0 || withdrawalsLoading) && (
        <Card className="glass-panel border-none mt-6">
          <div className="p-6 flex justify-between items-center border-b border-white/5">
            <CardTitle className="text-white flex items-center gap-2">
              <ArrowRight className="w-4 h-4 text-orange-400" />
              Withdrawn Players ({withdrawals.length})
            </CardTitle>
            <Button size="sm" variant="ghost" onClick={fetchWithdrawals} className="text-xs text-muted-foreground hover:text-white">↻ Refresh</Button>
          </div>
          {withdrawalsLoading ? (
            <div className="p-6 flex justify-center"><div className="w-5 h-5 rounded-full border-4 border-orange-400 border-t-transparent animate-spin" /></div>
          ) : (
            <div className="overflow-x-auto relative">
              <div className="pointer-events-none absolute top-0 right-0 bottom-0 w-8 bg-gradient-to-l from-black/40 to-transparent z-10" />
            <Table>
              <TableHeader>
                <TableRow className="border-white/5 sticky top-0 z-10 bg-[#0a1628]">
                  <TableHead className="text-muted-foreground sticky left-0 z-10 bg-[#0a1628]">Player</TableHead>
                  <TableHead className="text-muted-foreground">Email</TableHead>
                  <TableHead className="text-muted-foreground">Payment</TableHead>
                  <TableHead className="text-muted-foreground">Refund Status</TableHead>
                  <TableHead className="text-muted-foreground">Withdrawn</TableHead>
                  <TableHead className="text-muted-foreground">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {withdrawals.map(w => (
                  <TableRow key={w.id} className="border-white/5 hover:bg-white/5">
                    <TableCell className="text-white font-medium sticky left-0 z-10 bg-[#0a1628]">{w.playerName}</TableCell>
                    <TableCell className="text-muted-foreground text-sm">{w.playerEmail}</TableCell>
                    <TableCell>
                      <span className={`text-xs px-2 py-0.5 rounded font-medium ${
                        w.paymentStatus === 'paid' ? 'bg-green-500/20 text-green-400' : 'bg-white/10 text-muted-foreground'
                      }`}>{w.paymentStatus ?? 'unpaid'}</span>
                    </TableCell>
                    <TableCell>
                      <span className={`text-xs px-2 py-0.5 rounded font-medium ${
                        w.refundStatus === 'refunded' ? 'bg-blue-500/20 text-blue-400' :
                        w.refundStatus === 'pending' ? 'bg-yellow-500/20 text-yellow-400' :
                        w.refundStatus === 'waived' ? 'bg-purple-500/20 text-purple-400' :
                        'bg-white/10 text-muted-foreground'
                      }`}>{w.refundStatus}</span>
                      {w.refundReference && <span className="ml-1 text-xs text-muted-foreground">#{w.refundReference}</span>}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-sm">
                      {new Date(w.withdrawnAt).toLocaleDateString()}{w.actorName ? ` by ${w.actorName}` : ''}
                    </TableCell>
                    <TableCell>
                      {w.refundStatus !== 'refunded' && w.refundStatus !== 'not_applicable' && (
                        <div className="flex gap-1">
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={updatingRefund === w.id}
                            onClick={() => {
                              const ref = prompt('Enter refund reference (optional):', w.refundReference ?? '');
                              handleMarkRefund(w.id, 'refunded', ref ?? undefined);
                            }}
                            className="h-7 px-2 text-xs text-blue-400 hover:bg-blue-500/10"
                          >
                            Mark Refunded
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={updatingRefund === w.id}
                            onClick={() => handleMarkRefund(w.id, 'waived')}
                            className="h-7 px-2 text-xs text-purple-400 hover:bg-purple-500/10"
                          >
                            Waive
                          </Button>
                        </div>
                      )}
                      {w.refundStatus === 'refunded' && (
                        <span className="text-xs text-muted-foreground">✓ Refunded</span>
                      )}
                      {w.refundStatus === 'not_applicable' && (
                        <span className="text-xs text-muted-foreground">N/A</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            </div>
          )}
        </Card>
      )}

      <AddPlayerDialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        orgId={orgId}
        tournamentId={tournamentId}
        onSuccess={() => { setAddOpen(false); invalidate(); }}
      />
    </>
  );
}

/* ─── Add Player Dialog ──────────────────────────────────────────── */

function AddPlayerDialog({ open, onClose, orgId, tournamentId, onSuccess }: {
  open: boolean; onClose: () => void;
  orgId: number; tournamentId: number; onSuccess: () => void;
}) {
  const { toast } = useToast();
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [handicap, setHandicap] = useState('');
  const [flight, setFlight] = useState('');
  const [teeBox, setTeeBox] = useState('white');
  const [ghinNumber, setGhinNumber] = useState('');
  const [ghinLookupLoading, setGhinLookupLoading] = useState(false);
  const [ghinVerified, setGhinVerified] = useState<{ name: string; handicap: number | null; club: string | null } | null>(null);

  const { mutate: addPlayer, isPending } = useRegisterPlayer({
    mutation: {
      onSuccess: () => { toast({ title: `${firstName} ${lastName} added!` }); onSuccess(); },
      onError: () => toast({ title: 'Failed to add player', variant: 'destructive' }),
    }
  });

  const lookupGhin = async () => {
    if (!ghinNumber.trim()) return;
    setGhinLookupLoading(true);
    setGhinVerified(null);
    try {
      const res = await fetch(`/api/organizations/${orgId}/courses/ghin/player/${encodeURIComponent(ghinNumber.trim())}`, { credentials: 'include' });
      const data = await res.json() as { firstName?: string; lastName?: string; handicapIndex?: number | null; homeClub?: string | null; error?: string; code?: string };
      if (!res.ok) {
        if (data.code === 'NO_CREDENTIALS') {
          toast({ title: 'GHIN not configured', description: 'Go to Settings → GHIN / WHS to add credentials.', variant: 'destructive' });
        } else if (data.code === 'NOT_FOUND') {
          toast({ title: 'GHIN number not found', description: 'No golfer found with that GHIN number.', variant: 'destructive' });
        } else {
          toast({ title: data.error ?? 'Lookup failed', variant: 'destructive' });
        }
        return;
      }
      setFirstName(data.firstName ?? '');
      setLastName(data.lastName ?? '');
      if (data.handicapIndex != null) setHandicap(String(data.handicapIndex));
      setGhinVerified({ name: `${data.firstName ?? ''} ${data.lastName ?? ''}`.trim(), handicap: data.handicapIndex ?? null, club: data.homeClub ?? null });
      toast({ title: 'GHIN verified', description: `Auto-filled: ${data.firstName} ${data.lastName}` });
    } catch {
      toast({ title: 'GHIN lookup failed', variant: 'destructive' });
    } finally {
      setGhinLookupLoading(false);
    }
  };

  const handleAdd = () => {
    if (!firstName.trim() || !lastName.trim()) {
      toast({ title: 'First and last name are required', variant: 'destructive' });
      return;
    }
    addPlayer({
      orgId,
      tournamentId,
      data: {
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        email: email.trim() || undefined,
        handicapIndex: handicap ? parseFloat(handicap) : undefined,
        ghinNumber: ghinNumber.trim() || undefined,
        flight: flight.trim() || undefined,
        teeBox,
      },
    });
  };

  const resetAndClose = () => {
    setFirstName(''); setLastName(''); setEmail(''); setHandicap(''); setFlight(''); setTeeBox('white');
    setGhinNumber(''); setGhinVerified(null);
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && resetAndClose()}>
      <DialogContent className="glass-panel border-white/10 sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle className="text-xl font-display text-white flex items-center gap-2">
            <UserPlus className="w-5 h-5 text-primary" /> Add Player
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 mt-2">
          {/* GHIN Auto-fill */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-white flex items-center gap-1.5">
              <Globe className="w-3.5 h-3.5 text-primary" /> GHIN Number
              <span className="text-xs text-muted-foreground font-normal">(auto-fills name & handicap)</span>
            </label>
            <div className="flex gap-2">
              <Input
                value={ghinNumber}
                onChange={e => { setGhinNumber(e.target.value); setGhinVerified(null); }}
                placeholder="e.g. 1234567"
                className="bg-black/50 border-white/10 text-white font-mono"
                onKeyDown={e => { if (e.key === 'Enter') lookupGhin(); }}
              />
              <Button
                variant="outline"
                onClick={lookupGhin}
                disabled={ghinLookupLoading || !ghinNumber.trim()}
                className="border-white/10 text-muted-foreground hover:text-white shrink-0 gap-1.5"
              >
                {ghinLookupLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                Lookup
              </Button>
            </div>
            {ghinVerified && (
              <div className="flex items-center gap-2 bg-primary/5 border border-primary/20 rounded-lg px-3 py-2">
                <CheckCircle className="w-3.5 h-3.5 text-primary flex-shrink-0" />
                <div className="text-xs text-white">
                  <span className="font-semibold">{ghinVerified.name}</span>
                  {ghinVerified.handicap != null && <span className="text-muted-foreground ml-2">HCP {ghinVerified.handicap.toFixed(1)}</span>}
                  {ghinVerified.club && <span className="text-muted-foreground ml-2">· {ghinVerified.club}</span>}
                </div>
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-white">First Name *</label>
              <Input value={firstName} onChange={e => setFirstName(e.target.value)} placeholder="John" className="bg-black/50 border-white/10 text-white" />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-white">Last Name *</label>
              <Input value={lastName} onChange={e => setLastName(e.target.value)} placeholder="Smith" className="bg-black/50 border-white/10 text-white" />
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium text-white">Email</label>
            <Input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="john@example.com" className="bg-black/50 border-white/10 text-white" />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-white">Handicap Index</label>
              <Input type="number" value={handicap} onChange={e => setHandicap(e.target.value)} placeholder="e.g. 12.4" step="0.1" min="0" max="54" className="bg-black/50 border-white/10 text-white" />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-white">Flight</label>
              <Input value={flight} onChange={e => setFlight(e.target.value)} placeholder="A, B, Senior..." className="bg-black/50 border-white/10 text-white" />
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium text-white">Tee Box</label>
            <Select value={teeBox} onValueChange={setTeeBox}>
              <SelectTrigger className="bg-black/50 border-white/10 text-white">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="bg-card border-white/10 text-white">
                <SelectItem value="black">Black (Championship)</SelectItem>
                <SelectItem value="blue">Blue (Men's+)</SelectItem>
                <SelectItem value="white">White (Men's)</SelectItem>
                <SelectItem value="gold">Gold (Senior/Junior)</SelectItem>
                <SelectItem value="red">Red (Ladies)</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex justify-end gap-3 pt-1">
            <Button variant="ghost" onClick={resetAndClose} className="hover:bg-white/5 text-white">Cancel</Button>
            <Button onClick={handleAdd} disabled={isPending} className="bg-primary hover:bg-primary/90 text-primary-foreground">
              {isPending ? 'Adding...' : 'Add Player'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ─── Flights Tab ────────────────────────────────────────────────── */

type FlightWithPlayers = {
  id: number; tournamentId: number; name: string; description: string | null;
  handicapMin: string | null; handicapMax: string | null; teeBox: string | null;
  maxPlayers: number | null; tiebreakerMethod: string | null; createdAt: string;
  players: { playerId: number; firstName: string; lastName: string; handicapIndex: string | null; checkedIn: boolean }[];
};

type HcpDistributionPlayer = { id: number; firstName: string; lastName: string; handicapIndex: string | null };
type HcpBucket = { hcp: number; count: number };

type WizardMethod = 'split_evenly' | 'split_by_handicap' | 'manual';
type NamingConvention = 'abc' | 'descriptive' | 'custom';

interface ProposedFlight {
  name: string;
  description: string;
  handicapMin: number | null;
  handicapMax: number | null;
  teeBox: string;
  maxPlayers: string;
  tiebreakerMethod: string;
}

const NAMING_PRESETS: Record<NamingConvention, string[]> = {
  abc: ['A Flight', 'B Flight', 'C Flight', 'D Flight', 'E Flight', 'F Flight'],
  descriptive: ['Championship', 'First', 'Second', 'Third', 'Fourth', 'Fifth'],
  custom: [],
};

/**
 * Partition players into flights using first-match-wins semantics to ensure
 * each player appears in exactly one flight. Flights are checked in order;
 * intermediate bands use half-open [min, max) to prevent boundary ambiguity,
 * while the final flight uses a closed [min, max] to capture the maximum.
 */
function partitionPlayersToFlights(
  flights: ProposedFlight[],
  players: HcpDistributionPlayer[],
): Map<number, HcpDistributionPlayer[]> {
  const result = new Map<number, HcpDistributionPlayer[]>(
    flights.map((_, i) => [i, []]),
  );
  const assignedIds = new Set<number>();

  for (const player of players) {
    if (player.handicapIndex == null) continue;
    const hcp = parseFloat(player.handicapIndex);
    for (let i = 0; i < flights.length; i++) {
      const f = flights[i];
      if (f.handicapMin == null || f.handicapMax == null) continue;
      const isLast = i === flights.length - 1;
      const inRange = isLast
        ? hcp >= f.handicapMin && hcp <= f.handicapMax
        : hcp >= f.handicapMin && hcp < f.handicapMax;
      if (inRange && !assignedIds.has(player.id)) {
        result.get(i)!.push(player);
        assignedIds.add(player.id);
        break;
      }
    }
  }
  return result;
}

function getPlayersForFlight(
  flight: ProposedFlight,
  players: HcpDistributionPlayer[],
  allFlights: ProposedFlight[],
): HcpDistributionPlayer[] {
  const idx = allFlights.indexOf(flight);
  if (idx === -1) return [];
  const partitioned = partitionPlayersToFlights(allFlights, players);
  return partitioned.get(idx) ?? [];
}

function getUnassignedFromFlights(
  flights: ProposedFlight[],
  players: HcpDistributionPlayer[],
): HcpDistributionPlayer[] {
  const partitioned = partitionPlayersToFlights(flights, players);
  const assigned = new Set<number>();
  for (const pList of partitioned.values()) {
    pList.forEach(p => assigned.add(p.id));
  }
  // Include players without a handicap — they can never be auto-assigned and
  // must remain unassigned (or be placed manually after creation).
  return players.filter(p => !assigned.has(p.id));
}

function buildEvenBands(
  players: HcpDistributionPlayer[],
  numFlights: number,
): { min: number; max: number }[] {
  if (numFlights <= 0) return [];

  const hcps = players
    .map(p => (p.handicapIndex != null ? parseFloat(p.handicapIndex) : null))
    .filter((h): h is number => h != null)
    .sort((a, b) => a - b);

  const globalMin = hcps.length > 0 ? Math.floor(hcps[0]) : 0;
  const globalMax = hcps.length > 0 ? Math.ceil(hcps[hcps.length - 1]) : 36;
  const range = Math.max(globalMax - globalMin, 1);
  const bandSize = range / numFlights;

  return Array.from({ length: numFlights }, (_, i) => ({
    min: parseFloat((globalMin + i * bandSize).toFixed(1)),
    max: i === numFlights - 1
      ? globalMax
      : parseFloat((globalMin + (i + 1) * bandSize).toFixed(1)),
  }));
}

function buildNaturalBreaks(
  buckets: HcpBucket[],
  numBreaks: number,
): number[] {
  if (buckets.length < 2 || numBreaks <= 0) return [];
  const sortedBuckets = [...buckets].sort((a, b) => a.hcp - b.hcp);
  const breaks: { idx: number; gap: number }[] = [];
  for (let i = 1; i < sortedBuckets.length; i++) {
    breaks.push({ idx: i, gap: sortedBuckets[i].hcp - sortedBuckets[i - 1].hcp });
  }
  breaks.sort((a, b) => b.gap - a.gap);
  return breaks
    .slice(0, numBreaks)
    .map(b => (sortedBuckets[b.idx - 1].hcp + sortedBuckets[b.idx].hcp) / 2)
    .sort((a, b) => a - b);
}

function FlightWizardModal({
  open, onClose, orgId, tournamentId, onComplete,
}: {
  open: boolean; onClose: () => void;
  orgId: number; tournamentId: number;
  onComplete: () => void;
}) {
  const { toast } = useToast();
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [method, setMethod] = useState<WizardMethod>('split_evenly');
  const [numFlights, setNumFlights] = useState(3);
  const [namingConvention, setNamingConvention] = useState<NamingConvention>('abc');
  const [distribution, setDistribution] = useState<{ players: HcpDistributionPlayer[]; buckets: HcpBucket[] } | null>(null);
  const [distLoading, setDistLoading] = useState(false);
  const [distError, setDistError] = useState(false);
  const [proposals, setProposals] = useState<ProposedFlight[]>([]);
  const [boundaries, setBoundaries] = useState<number[]>([]);
  const [confirming, setConfirming] = useState(false);

  const hasPlayers = (distribution?.players.length ?? 0) > 0;
  const hasBuckets = (distribution?.buckets.length ?? 0) > 0;

  const minHcp = distribution?.players.length
    ? Math.min(...distribution.players.map(p => p.handicapIndex != null ? parseFloat(p.handicapIndex) : Infinity))
    : 0;
  const maxHcp = distribution?.players.length
    ? Math.max(...distribution.players.map(p => p.handicapIndex != null ? parseFloat(p.handicapIndex) : -Infinity))
    : 36;

  const fetchDistribution = async () => {
    setDistLoading(true);
    setDistError(false);
    try {
      const res = await fetch(`/api/organizations/${orgId}/tournaments/${tournamentId}/flights/handicap-distribution`);
      if (res.ok) {
        setDistribution(await res.json());
      } else {
        setDistError(true);
      }
    } catch {
      setDistError(true);
    } finally { setDistLoading(false); }
  };

  useEffect(() => {
    if (open) {
      setStep(1); setMethod('split_evenly'); setNumFlights(3);
      setNamingConvention('abc'); setProposals([]); setBoundaries([]);
      setDistribution(null); setDistError(false);
      fetchDistribution();
    }
  }, [open]);

  const getDefaultName = (idx: number, conv: NamingConvention) => {
    const preset = NAMING_PRESETS[conv];
    return preset[idx] ?? `Flight ${idx + 1}`;
  };

  const buildProposalsFromBands = (
    bands: { min: number; max: number }[],
    names?: string[],
    existing?: ProposedFlight[],
  ): ProposedFlight[] => {
    return bands.map((band, i) => {
      const existingFlight = existing?.[i];
      return {
        name: names?.[i] ?? existingFlight?.name ?? getDefaultName(i, namingConvention),
        description: existingFlight?.description ?? '',
        handicapMin: band.min,
        handicapMax: band.max,
        teeBox: existingFlight?.teeBox ?? '',
        maxPlayers: existingFlight?.maxPlayers ?? '',
        tiebreakerMethod: existingFlight?.tiebreakerMethod ?? '',
      };
    });
  };

  const handleStep1Next = () => {
    if (method === 'manual') {
      const newProposals: ProposedFlight[] = [{
        name: getDefaultName(0, namingConvention),
        description: '',
        handicapMin: null, handicapMax: null,
        teeBox: '', maxPlayers: '', tiebreakerMethod: '',
      }];
      setProposals(newProposals);
      setStep(2);
      return;
    }

    if (method === 'split_evenly' && distribution) {
      const bands = buildEvenBands(distribution.players, numFlights);
      setProposals(buildProposalsFromBands(bands, undefined, proposals));
      setStep(2);
      return;
    }

    if (method === 'split_by_handicap' && distribution) {
      const naturalBreaks = buildNaturalBreaks(distribution.buckets, numFlights - 1);
      // Use actual player handicap values (not integer bucket keys) so decimal
      // handicaps at the extremes (e.g. 18.9) are not truncated.
      const playerHcps = distribution.players
        .map(p => (p.handicapIndex != null ? parseFloat(p.handicapIndex) : null))
        .filter((h): h is number => h != null)
        .sort((a, b) => a - b);
      const globalMin = playerHcps.length > 0 ? playerHcps[0] : 0;
      const globalMax = playerHcps.length > 0 ? playerHcps[playerHcps.length - 1] : 36;
      // If we can't find enough natural breaks, fall back to even distribution
      if (naturalBreaks.length < numFlights - 1) {
        const evenBands = buildEvenBands(distribution.players, numFlights);
        const evenBoundaries = evenBands.slice(0, -1).map(b => b.max);
        setBoundaries(evenBoundaries);
        setProposals(buildProposalsFromBands(evenBands, undefined, proposals));
      } else {
        setBoundaries(naturalBreaks);
        const bands = boundariesToBands([...naturalBreaks], globalMin, globalMax);
        setProposals(buildProposalsFromBands(bands, undefined, proposals));
      }
      setStep(2);
      return;
    }
  };

  const boundariesToBands = (
    bounds: number[],
    globalMin: number,
    globalMax: number,
  ) => {
    const sorted = [...bounds].sort((a, b) => a - b);
    const points = [globalMin, ...sorted, globalMax];
    return points.slice(0, -1).map((min, i) => ({
      min: parseFloat(min.toFixed(1)),
      max: parseFloat(points[i + 1].toFixed(1)),
    }));
  };

  const handleBoundaryChange = (idx: number, val: number) => {
    const newBounds = [...boundaries];
    newBounds[idx] = val;
    newBounds.sort((a, b) => a - b);
    setBoundaries(newBounds);
    // Use player handicap floats (not integer bucket keys) to avoid truncating decimal extremes.
    const hcpFloats = (distribution?.players ?? [])
      .map(p => (p.handicapIndex != null ? parseFloat(p.handicapIndex) : null))
      .filter((h): h is number => h != null)
      .sort((a, b) => a - b);
    const sortedBucketsLocal = [...(distribution?.buckets ?? [])].sort((a, b) => a.hcp - b.hcp);
    const bMin = hcpFloats.length > 0 ? hcpFloats[0] : (sortedBucketsLocal[0]?.hcp ?? 0);
    const bMax = hcpFloats.length > 0
      ? hcpFloats[hcpFloats.length - 1]
      : (sortedBucketsLocal[sortedBucketsLocal.length - 1]?.hcp ?? 36);
    const bands = boundariesToBands(newBounds, bMin, bMax);
    setProposals(prev => buildProposalsFromBands(bands, prev.map(p => p.name), prev));
  };

  const handleStep2Next = () => {
    setStep(3);
  };

  const rollbackFlights = async (ids: number[]) => {
    await Promise.allSettled(
      ids.map(id =>
        fetch(`/api/organizations/${orgId}/tournaments/${tournamentId}/flights/${id}`, { method: 'DELETE' }),
      ),
    );
  };

  const handleConfirm = async () => {
    setConfirming(true);
    try {
      // Step 1: Create each flight sequentially; capture the returned ID for each.
      // On any creation failure, roll back previously created flights so the tournament
      // is not left in a partially-created state.
      const createdFlightIds: number[] = [];
      for (const proposal of proposals) {
        const res = await fetch(`/api/organizations/${orgId}/tournaments/${tournamentId}/flights`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: proposal.name,
            description: proposal.description || undefined,
            handicapMin: proposal.handicapMin ?? undefined,
            handicapMax: proposal.handicapMax ?? undefined,
            teeBox: proposal.teeBox || undefined,
            maxPlayers: proposal.maxPlayers ? parseInt(proposal.maxPlayers) : undefined,
            tiebreakerMethod: proposal.tiebreakerMethod || undefined,
          }),
        });
        if (!res.ok) {
          const d = await res.json().catch(() => ({}));
          // Roll back any flights created before this one.
          await rollbackFlights(createdFlightIds);
          toast({ title: d.error ?? `Failed to create flight "${proposal.name}" — rolled back`, variant: 'destructive' });
          setConfirming(false);
          return;
        }
        const created = await res.json() as { id: number };
        createdFlightIds.push(created.id);
      }

      // Step 2: Assign players using the exact IDs returned from creation (no name-matching).
      let totalAssigned = 0;
      let assignFailed = 0;
      if (distribution && method !== 'manual') {
        const partitioned = partitionPlayersToFlights(proposals, distribution.players);
        for (let i = 0; i < proposals.length; i++) {
          const flightId = createdFlightIds[i];
          const assignablePlayers = partitioned.get(i) ?? [];
          if (assignablePlayers.length === 0) continue;
          const assignRes = await fetch(
            `/api/organizations/${orgId}/tournaments/${tournamentId}/flights/${flightId}/players/bulk`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ playerIds: assignablePlayers.map(p => p.id) }),
            },
          );
          if (assignRes.ok) {
            const data = await assignRes.json() as { assigned: number };
            totalAssigned += data.assigned;
          } else {
            assignFailed++;
          }
        }
      }

      const totalCreated = proposals.length;
      if (assignFailed > 0) {
        // Partial success: flights were created but some assignment batches failed.
        // Show a distinct warning-style toast so the admin knows to check assignments.
        toast({
          title: `${totalCreated} flight${totalCreated !== 1 ? 's' : ''} created — partial assignment`,
          description: `${totalAssigned} player${totalAssigned !== 1 ? 's' : ''} assigned, but ${assignFailed} batch${assignFailed !== 1 ? 'es' : ''} failed. Use the drag-and-drop panel to assign remaining players.`,
          variant: 'destructive',
        });
      } else {
        toast({
          title: `${totalCreated} flight${totalCreated !== 1 ? 's' : ''} created`,
          description: totalAssigned > 0 ? `${totalAssigned} player${totalAssigned !== 1 ? 's' : ''} assigned` : undefined,
        });
      }
      onComplete();
      onClose();
    } finally {
      setConfirming(false);
    }
  };

  const previewUnassigned = distribution && method !== 'manual'
    ? getUnassignedFromFlights(proposals, distribution.players)
    : [];

  const histogramMax = Math.max(...(distribution?.buckets.map(b => b.count) ?? [1]), 1);

  const sortedBuckets = [...(distribution?.buckets ?? [])].sort((a, b) => a.hcp - b.hcp);
  // Use raw player handicap floats (not integer bucket keys) so decimal extremes
  // (e.g. 18.9) are not truncated when positioning histogram bars and boundary sliders.
  const playerHcpFloats = (distribution?.players ?? [])
    .map(p => (p.handicapIndex != null ? parseFloat(p.handicapIndex) : null))
    .filter((h): h is number => h != null)
    .sort((a, b) => a - b);
  const gMin = playerHcpFloats.length > 0 ? playerHcpFloats[0] : (sortedBuckets[0]?.hcp ?? 0);
  const gMax = playerHcpFloats.length > 0
    ? playerHcpFloats[playerHcpFloats.length - 1]
    : (sortedBuckets[sortedBuckets.length - 1]?.hcp ?? 36);
  const hcpRange = gMax - gMin || 1;

  return (
    <Dialog open={open} onOpenChange={v => { if (!v) onClose(); }}>
      <DialogContent className="bg-[#0a1628] border border-white/10 text-white max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-white">
            <Flag className="w-4 h-4 text-primary" />
            Create Flights Wizard
            <span className="ml-auto text-xs text-muted-foreground font-normal">Step {step} of 3</span>
          </DialogTitle>
        </DialogHeader>

        {/* Progress */}
        <div className="flex gap-1.5 mb-4">
          {[1, 2, 3].map(s => (
            <div key={s} className={`h-1.5 flex-1 rounded-full transition-all ${s <= step ? 'bg-primary' : 'bg-white/10'}`} />
          ))}
        </div>

        {/* Step 1: Method */}
        {step === 1 && (
          <div className="space-y-4">
            <div>
              <p className="text-sm font-medium text-white mb-1">How would you like to create flights?</p>
              <p className="text-xs text-muted-foreground mb-3">Choose a method to distribute your {distribution?.players.length ?? 0} registered players.</p>
            </div>
            <div className="grid grid-cols-1 gap-3">
              {[
                {
                  id: 'split_evenly' as WizardMethod,
                  icon: <Layers className="w-5 h-5 text-emerald-400" />,
                  label: 'Split Evenly',
                  desc: 'Choose how many flights and the system proposes equal-sized handicap bands automatically.',
                },
                {
                  id: 'split_by_handicap' as WizardMethod,
                  icon: <BarChart2 className="w-5 h-5 text-blue-400" />,
                  label: 'Split by Handicap',
                  desc: 'See a histogram of the field\'s handicaps and drag the boundary lines to define custom bands.',
                },
                {
                  id: 'manual' as WizardMethod,
                  icon: <Edit3 className="w-5 h-5 text-amber-400" />,
                  label: 'Manual',
                  desc: 'Enter a single flight\'s name, handicap band and settings yourself.',
                },
              ].map(opt => (
                <button
                  key={opt.id}
                  onClick={() => setMethod(opt.id)}
                  className={`flex items-start gap-3 p-4 rounded-xl border text-left transition-all ${method === opt.id ? 'border-primary/60 bg-primary/10' : 'border-white/10 bg-white/5 hover:bg-white/8'}`}
                >
                  <div className="mt-0.5 shrink-0">{opt.icon}</div>
                  <div>
                    <p className="text-sm font-semibold text-white">{opt.label}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">{opt.desc}</p>
                  </div>
                  {method === opt.id && <CheckCircle2 className="w-4 h-4 text-primary ml-auto shrink-0 mt-0.5" />}
                </button>
              ))}
            </div>

            {method === 'split_evenly' && (
              <div className="mt-2 p-3 rounded-xl bg-white/5 border border-white/10">
                <label className="text-xs text-muted-foreground uppercase tracking-wider block mb-2">Number of Flights</label>
                <div className="flex items-center gap-3">
                  <input
                    type="range" min={2} max={8} value={numFlights}
                    onChange={e => setNumFlights(parseInt(e.target.value))}
                    className="flex-1 accent-primary"
                  />
                  <span className="text-white font-bold text-lg w-8 text-center">{numFlights}</span>
                </div>
                {hasPlayers && (
                  <p className="text-xs text-muted-foreground mt-2">
                    ~{Math.round((distribution?.players.length ?? 0) / numFlights)} players per flight
                  </p>
                )}
              </div>
            )}

            {method === 'split_by_handicap' && (
              <div className="mt-2 p-3 rounded-xl bg-white/5 border border-white/10">
                <label className="text-xs text-muted-foreground uppercase tracking-wider block mb-2">Number of Flights</label>
                <div className="flex items-center gap-3">
                  <input
                    type="range" min={2} max={6} value={numFlights}
                    onChange={e => setNumFlights(parseInt(e.target.value))}
                    className="flex-1 accent-primary"
                  />
                  <span className="text-white font-bold text-lg w-8 text-center">{numFlights}</span>
                </div>
                <p className="text-xs text-muted-foreground mt-1">You'll be able to drag the boundary lines in the next step.</p>
              </div>
            )}

            {distError && (
              <div className="flex items-center gap-2 p-3 rounded-xl bg-red-500/10 border border-red-500/30">
                <AlertTriangle className="w-4 h-4 text-red-400 shrink-0" />
                <span className="text-xs text-red-400">Could not load player handicap data.{' '}
                  <button onClick={fetchDistribution} className="underline hover:text-red-300">Retry</button>
                  {' '}or switch to Manual mode to proceed without it.
                </span>
              </div>
            )}
            <div className="flex justify-end gap-3 pt-2">
              <Button variant="outline" onClick={onClose} className="border-white/10 text-white hover:bg-white/5">Cancel</Button>
              <Button
                onClick={handleStep1Next}
                disabled={distLoading || (distError && method !== 'manual')}
                className="bg-primary hover:bg-primary/90 text-primary-foreground"
              >
                {distLoading ? <><Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />Loading...</> : <>Next <ArrowRight className="w-3.5 h-3.5 ml-1.5" /></>}
              </Button>
            </div>
          </div>
        )}

        {/* Step 2: Configure */}
        {step === 2 && (
          <div className="space-y-4">
            <div>
              <p className="text-sm font-medium text-white mb-1">Configure Flights</p>
              <p className="text-xs text-muted-foreground mb-3">Name each flight, set tee box, player cap, and tiebreaker.</p>
            </div>

            {/* Naming convention selector (not for manual) */}
            {method !== 'manual' && (
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs text-muted-foreground">Name style:</span>
                {(['abc', 'descriptive', 'custom'] as NamingConvention[]).map(conv => (
                  <button
                    key={conv}
                    onClick={() => {
                      setNamingConvention(conv);
                      if (conv !== 'custom') {
                        setProposals(prev => prev.map((p, i) => ({ ...p, name: getDefaultName(i, conv) })));
                      }
                    }}
                    className={`text-xs px-3 py-1 rounded-full border transition-all ${namingConvention === conv ? 'border-primary/60 bg-primary/15 text-primary' : 'border-white/10 text-muted-foreground hover:text-white'}`}
                  >
                    {conv === 'abc' ? 'A / B / C' : conv === 'descriptive' ? 'Championship / First / Second' : 'Custom'}
                  </button>
                ))}
              </div>
            )}

            {/* Histogram with draggable boundaries for split_by_handicap */}
            {method === 'split_by_handicap' && hasBuckets && (
              <div className="p-3 rounded-xl bg-white/5 border border-white/10">
                <p className="text-xs text-muted-foreground mb-2">Drag boundary lines to adjust flight breaks</p>
                <div className="relative h-20 flex items-end gap-px select-none" style={{ userSelect: 'none' }}>
                  {sortedBuckets.map((b, i) => {
                    const heightPct = (b.count / histogramMax) * 100;
                    const positionPct = ((b.hcp - gMin) / hcpRange) * 100;
                    return (
                      <div
                        key={i}
                        className="absolute bottom-0 bg-primary/50 rounded-t-sm"
                        style={{
                          left: `${positionPct}%`,
                          width: `${Math.max(100 / sortedBuckets.length, 4)}%`,
                          height: `${heightPct}%`,
                          minHeight: '4px',
                        }}
                        title={`HCP ${b.hcp}: ${b.count} player${b.count !== 1 ? 's' : ''}`}
                      />
                    );
                  })}
                  {/* Boundary lines */}
                  {boundaries.map((b, i) => {
                    const leftPct = ((b - gMin) / hcpRange) * 100;
                    return (
                      <div
                        key={i}
                        className="absolute top-0 bottom-0 flex flex-col items-center cursor-col-resize z-10"
                        style={{ left: `${leftPct}%`, transform: 'translateX(-50%)' }}
                        title={`Boundary: HCP ${b.toFixed(1)}`}
                      >
                        <div className="w-0.5 h-full bg-amber-400/80" />
                        <input
                          type="range"
                          min={gMin} max={gMax} step={0.5}
                          value={b}
                          onChange={e => handleBoundaryChange(i, parseFloat(e.target.value))}
                          className="absolute inset-0 opacity-0 cursor-col-resize"
                          style={{ writingMode: 'horizontal-tb' }}
                        />
                      </div>
                    );
                  })}
                </div>
                <div className="flex justify-between text-xs text-muted-foreground mt-1">
                  <span>HCP {gMin}</span>
                  <span className="text-amber-400 text-center flex-1">
                    {boundaries.length > 0 ? `Boundaries: ${boundaries.map(b => b.toFixed(1)).join(', ')}` : 'No boundaries set'}
                  </span>
                  <span>HCP {gMax}</span>
                </div>
                {/* Fine-tune boundaries */}
                <div className="mt-3 grid grid-cols-2 gap-2">
                  {boundaries.map((b, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground w-16 shrink-0">Break {i + 1}:</span>
                      <input
                        type="number"
                        min={gMin} max={gMax} step={0.5}
                        value={b.toFixed(1)}
                        onChange={e => handleBoundaryChange(i, parseFloat(e.target.value) || b)}
                        className="h-7 rounded border border-white/10 bg-black/40 text-white px-2 text-xs flex-1 focus:outline-none focus:border-primary/50 w-20"
                      />
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Per-flight configuration */}
            <div className="space-y-3">
              {proposals.map((p, i) => (
                <div key={i} className="p-3 rounded-xl bg-white/5 border border-white/10 space-y-2">
                  <div className="flex items-center gap-2">
                    <div className="w-5 h-5 rounded-full bg-primary/20 border border-primary/40 flex items-center justify-center text-xs text-primary font-bold shrink-0">
                      {i + 1}
                    </div>
                    <Input
                      value={p.name}
                      onChange={e => setProposals(prev => prev.map((x, j) => j === i ? { ...x, name: e.target.value } : x))}
                      placeholder="Flight name"
                      className="bg-black/40 border-white/10 text-white h-8 text-sm flex-1"
                    />
                    {(p.handicapMin != null || p.handicapMax != null) && (
                      <span className="text-xs text-muted-foreground bg-white/5 border border-white/10 rounded px-2 py-1 shrink-0">
                        HCP {p.handicapMin ?? '?'}–{p.handicapMax ?? '?'}
                      </span>
                    )}
                  </div>
                  <Input
                    value={p.description}
                    onChange={e => setProposals(prev => prev.map((x, j) => j === i ? { ...x, description: e.target.value } : x))}
                    placeholder="Description (optional)"
                    className="bg-black/40 border-white/10 text-white h-7 text-xs"
                  />
                  <div className="grid grid-cols-3 gap-2">
                    <div>
                      <label className="text-xs text-muted-foreground block mb-1">Tee Box</label>
                      <select
                        value={p.teeBox}
                        onChange={e => setProposals(prev => prev.map((x, j) => j === i ? { ...x, teeBox: e.target.value } : x))}
                        className="h-7 w-full rounded border border-white/10 bg-black/40 text-white px-2 text-xs focus:outline-none"
                      >
                        <option value="">Any</option>
                        <option value="blue">Blue</option>
                        <option value="white">White</option>
                        <option value="red">Red</option>
                        <option value="gold">Gold</option>
                        <option value="black">Black</option>
                      </select>
                    </div>
                    <div>
                      <label className="text-xs text-muted-foreground block mb-1">Max Players</label>
                      <input
                        type="number" min={1} placeholder="No limit"
                        value={p.maxPlayers}
                        onChange={e => setProposals(prev => prev.map((x, j) => j === i ? { ...x, maxPlayers: e.target.value } : x))}
                        className="h-7 w-full rounded border border-white/10 bg-black/40 text-white px-2 text-xs focus:outline-none"
                      />
                    </div>
                    <div>
                      <label className="text-xs text-muted-foreground block mb-1">Tiebreaker</label>
                      <select
                        value={p.tiebreakerMethod}
                        onChange={e => setProposals(prev => prev.map((x, j) => j === i ? { ...x, tiebreakerMethod: e.target.value } : x))}
                        className="h-7 w-full rounded border border-white/10 bg-black/40 text-white px-2 text-xs focus:outline-none"
                      >
                        <option value="">Inherit</option>
                        <option value="countback">Countback</option>
                        <option value="net_countback">Net Countback</option>
                        <option value="multi_round_countback">Multi-Round</option>
                        <option value="lower_handicap">Lower Handicap</option>
                        <option value="no_tiebreaker">None</option>
                      </select>
                    </div>
                  </div>
                  {/* For manual, show handicap band inputs */}
                  {method === 'manual' && (
                    <div className="grid grid-cols-2 gap-2 mt-1">
                      <div>
                        <label className="text-xs text-muted-foreground block mb-1">Min HCP</label>
                        <input
                          type="number" step={0.1} placeholder="e.g. 0"
                          value={p.handicapMin ?? ''}
                          onChange={e => setProposals(prev => prev.map((x, j) => j === i ? { ...x, handicapMin: e.target.value !== '' ? parseFloat(e.target.value) : null } : x))}
                          className="h-7 w-full rounded border border-white/10 bg-black/40 text-white px-2 text-xs focus:outline-none"
                        />
                      </div>
                      <div>
                        <label className="text-xs text-muted-foreground block mb-1">Max HCP</label>
                        <input
                          type="number" step={0.1} placeholder="e.g. 36"
                          value={p.handicapMax ?? ''}
                          onChange={e => setProposals(prev => prev.map((x, j) => j === i ? { ...x, handicapMax: e.target.value !== '' ? parseFloat(e.target.value) : null } : x))}
                          className="h-7 w-full rounded border border-white/10 bg-black/40 text-white px-2 text-xs focus:outline-none"
                        />
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>

            <div className="flex justify-between gap-3 pt-2">
              <Button variant="outline" onClick={() => setStep(1)} className="border-white/10 text-white hover:bg-white/5">Back</Button>
              <Button
                onClick={handleStep2Next}
                disabled={proposals.some(p => !p.name.trim())}
                className="bg-primary hover:bg-primary/90 text-primary-foreground"
              >
                Preview <ArrowRight className="w-3.5 h-3.5 ml-1.5" />
              </Button>
            </div>
          </div>
        )}

        {/* Step 3: Preview */}
        {step === 3 && (
          <div className="space-y-4">
            <div>
              <p className="text-sm font-medium text-white mb-1">Preview Flight Assignments</p>
              <p className="text-xs text-muted-foreground mb-3">Review the proposed flights before creating them. No changes have been made yet.</p>
            </div>

            {previewUnassigned.length > 0 && (
              <div className="flex items-start gap-3 p-3 rounded-xl bg-amber-500/10 border border-amber-500/30">
                <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-semibold text-amber-400">
                    {previewUnassigned.length} player{previewUnassigned.length !== 1 ? 's' : ''} will remain unassigned
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {previewUnassigned.map(p => `${p.firstName} ${p.lastName}${p.handicapIndex != null ? ` (HCP ${p.handicapIndex})` : ' (no handicap)'}`).join(', ')}
                  </p>
                  {previewUnassigned.some(p => p.handicapIndex == null) && (
                    <p className="text-xs text-amber-400/70 mt-1">Players without a handicap index cannot be auto-assigned and must be placed manually after creation.</p>
                  )}
                </div>
              </div>
            )}

            <div className="space-y-3">
              {proposals.map((proposal, i) => {
                const flightPlayers = distribution && method !== 'manual'
                  ? getPlayersForFlight(proposal, distribution.players, proposals)
                  : [];
                return (
                  <div key={i} className="p-3 rounded-xl bg-white/5 border border-white/10">
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <div className="w-5 h-5 rounded-full bg-primary/20 border border-primary/40 flex items-center justify-center text-xs text-primary font-bold">
                          {i + 1}
                        </div>
                        <span className="text-white font-semibold text-sm">{proposal.name}</span>
                        {proposal.handicapMin != null && (
                          <span className="text-xs text-muted-foreground bg-white/5 border border-white/10 rounded px-1.5 py-0.5">
                            HCP {proposal.handicapMin}–{proposal.handicapMax}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        {proposal.teeBox && (
                          <span className="text-xs text-muted-foreground capitalize">{proposal.teeBox} tees</span>
                        )}
                        <Badge className="bg-primary/20 text-primary border-primary/30 text-xs">
                          {flightPlayers.length} player{flightPlayers.length !== 1 ? 's' : ''}
                          {proposal.maxPlayers ? `/${proposal.maxPlayers}` : ''}
                        </Badge>
                      </div>
                    </div>
                    {flightPlayers.length > 0 ? (
                      <ul className="grid grid-cols-2 gap-1 max-h-32 overflow-y-auto">
                        {flightPlayers.map(p => (
                          <li key={p.id} className="text-xs text-muted-foreground flex items-center gap-1">
                            <UserCheck className="w-3 h-3 text-primary/60 shrink-0" />
                            {p.firstName} {p.lastName}
                            {p.handicapIndex != null && <span className="text-muted-foreground/60">({p.handicapIndex})</span>}
                          </li>
                        ))}
                      </ul>
                    ) : method === 'manual' ? (
                      <p className="text-xs text-muted-foreground italic">Players can be assigned after creation.</p>
                    ) : (
                      <p className="text-xs text-muted-foreground italic">No players match this handicap range.</p>
                    )}
                  </div>
                );
              })}
            </div>

            <div className="flex justify-between gap-3 pt-2">
              <Button variant="outline" onClick={() => setStep(2)} className="border-white/10 text-white hover:bg-white/5">Back</Button>
              <Button
                onClick={handleConfirm}
                disabled={confirming}
                className="bg-emerald-600 hover:bg-emerald-700 text-white"
              >
                {confirming ? (
                  <><Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />Creating…</>
                ) : (
                  <><CheckCircle2 className="w-3.5 h-3.5 mr-1.5" />Confirm &amp; Create Flights</>
                )}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function FlightsTab({ orgId, tournamentId }: { orgId: number; tournamentId: number }) {
  const { toast } = useToast();
  const { data: allPlayers } = useListPlayers(orgId, tournamentId);
  const [flights, setFlights] = useState<FlightWithPlayers[]>([]);
  const [loading, setLoading] = useState(true);
  const [assignOpen, setAssignOpen] = useState<number | null>(null);
  const [flightTiebreakerEdits, setFlightTiebreakerEdits] = useState<Record<number, string>>({});
  const [savingFlightTiebreaker, setSavingFlightTiebreaker] = useState<number | null>(null);

  // Wizard state
  const [wizardOpen, setWizardOpen] = useState(false);

  // Bulk multi-select state
  const [selectedPlayerIds, setSelectedPlayerIds] = useState<Set<number>>(new Set());
  const [bulkTargetFlightId, setBulkTargetFlightId] = useState<string>('');
  const [bulkAssigning, setBulkAssigning] = useState(false);

  // Auto-assign state
  const [autoAssigning, setAutoAssigning] = useState<number | 'all' | null>(null);

  // Unassigned panel collapsed state
  const [unassignedPanelOpen, setUnassignedPanelOpen] = useState(true);

  // Drag-and-drop state
  const [draggedPlayer, setDraggedPlayer] = useState<{ playerId: number; fromFlightId: number | null; firstName: string; lastName: string } | null>(null);
  const [dragOverFlightId, setDragOverFlightId] = useState<number | 'unassigned' | null>(null);

  const loadFlights = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/organizations/${orgId}/tournaments/${tournamentId}/flights`);
      if (res.ok) {
        const data: FlightWithPlayers[] = await res.json();
        setFlights(data);
        const initEdits: Record<number, string> = {};
        for (const f of data) initEdits[f.id] = f.tiebreakerMethod ?? '';
        setFlightTiebreakerEdits(initEdits);
      }
    } finally {
      setLoading(false);
    }
  };

  const updateFlightTiebreaker = async (flightId: number, flightName: string) => {
    setSavingFlightTiebreaker(flightId);
    try {
      const tb = flightTiebreakerEdits[flightId] ?? '';
      const res = await fetch(`/api/organizations/${orgId}/tournaments/${tournamentId}/flights/${flightId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tiebreakerMethod: tb || null }),
      });
      if (res.ok) {
        setFlights(prev => prev.map(f => f.id === flightId ? { ...f, tiebreakerMethod: tb || null } : f));
        toast({ title: `Tiebreaker updated for "${flightName}"` });
      } else {
        const d = await res.json() as { error?: string };
        toast({ title: d.error ?? 'Failed to update tiebreaker', variant: 'destructive' });
      }
    } finally {
      setSavingFlightTiebreaker(null);
    }
  };

  useEffect(() => { loadFlights(); }, [orgId, tournamentId]);

  const deleteFlight = async (flightId: number, flightName: string) => {
    if (!confirm(`Delete flight "${flightName}"? All player assignments will be removed.`)) return;
    const res = await fetch(`/api/organizations/${orgId}/tournaments/${tournamentId}/flights/${flightId}`, { method: 'DELETE' });
    if (res.ok) {
      setFlights(f => f.filter(x => x.id !== flightId));
      toast({ title: `Flight "${flightName}" deleted` });
    }
  };

  const assignPlayer = async (flightId: number, playerId: number) => {
    const res = await fetch(`/api/organizations/${orgId}/tournaments/${tournamentId}/flights/${flightId}/players`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerId }),
    });
    if (res.ok) {
      await loadFlights();
      toast({ title: 'Player assigned to flight' });
    } else {
      const d = await res.json();
      toast({ title: d.error || 'Failed to assign player', variant: 'destructive' });
    }
    setAssignOpen(null);
  };

  const removeFromFlight = async (flightId: number, playerId: number) => {
    const res = await fetch(`/api/organizations/${orgId}/tournaments/${tournamentId}/flights/${flightId}/players/${playerId}`, { method: 'DELETE' });
    if (res.ok) {
      setFlights(prev => prev.map(f => f.id === flightId ? { ...f, players: f.players.filter(p => p.playerId !== playerId) } : f));
    }
  };

  const getUnassignedToFlight = (flightId: number) => {
    const assigned = new Set(flights.find(f => f.id === flightId)?.players.map(p => p.playerId) ?? []);
    return (allPlayers ?? []).filter(p => !assigned.has(p.id));
  };

  // Players not assigned to ANY flight
  const getGloballyUnassigned = () => {
    const assignedToAny = new Set(flights.flatMap(f => f.players.map(p => p.playerId)));
    return (allPlayers ?? []).filter(p => !assignedToAny.has(p.id));
  };

  // Auto-assign for one flight or all flights
  const handleAutoAssign = async (flightId?: number) => {
    setAutoAssigning(flightId ?? 'all');
    try {
      const body = flightId != null ? { flightId } : {};
      const res = await fetch(`/api/organizations/${orgId}/tournaments/${tournamentId}/flights/auto-assign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        const data = await res.json() as { results: { flightId: number; flightName: string; assigned: number; skipped: number }[] };
        const totalAssigned = data.results.reduce((sum, r) => sum + r.assigned, 0);
        if (totalAssigned === 0) {
          toast({ title: 'No players were placed', description: 'Check that flights have handicap ranges and there are unassigned players whose handicap falls in range.' });
        } else {
          const summary = data.results.filter(r => r.assigned > 0).map(r => `${r.flightName}: ${r.assigned}`).join(', ');
          toast({ title: `Auto-assigned ${totalAssigned} player${totalAssigned !== 1 ? 's' : ''}`, description: summary });
        }
        await loadFlights();
      } else {
        const d = await res.json() as { error?: string };
        toast({ title: d.error ?? 'Auto-assign failed', variant: 'destructive' });
      }
    } finally {
      setAutoAssigning(null);
    }
  };

  // Bulk assign selected players to a flight
  const handleBulkAssign = async () => {
    if (!bulkTargetFlightId || selectedPlayerIds.size === 0) return;
    const flightId = parseInt(bulkTargetFlightId);
    setBulkAssigning(true);
    try {
      const res = await fetch(`/api/organizations/${orgId}/tournaments/${tournamentId}/flights/${flightId}/players/bulk`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ playerIds: Array.from(selectedPlayerIds) }),
      });
      if (res.ok) {
        const data = await res.json() as { assigned: number; skipped: number };
        toast({ title: `Assigned ${data.assigned} player${data.assigned !== 1 ? 's' : ''} to flight${data.skipped > 0 ? ` (${data.skipped} already assigned)` : ''}` });
        setSelectedPlayerIds(new Set());
        setBulkTargetFlightId('');
        await loadFlights();
      } else {
        const d = await res.json() as { error?: string };
        toast({ title: d.error ?? 'Bulk assign failed', variant: 'destructive' });
      }
    } finally {
      setBulkAssigning(false);
    }
  };

  // Drag-and-drop handlers
  const handleDragStart = (playerId: number, fromFlightId: number | null, firstName: string, lastName: string) => {
    setDraggedPlayer({ playerId, fromFlightId, firstName, lastName });
  };

  const handleDragEnd = () => {
    setDraggedPlayer(null);
    setDragOverFlightId(null);
  };

  const handleDropOnFlight = async (toFlightId: number) => {
    if (!draggedPlayer) return;
    const { playerId, fromFlightId } = draggedPlayer;
    if (fromFlightId === toFlightId) { setDragOverFlightId(null); return; }

    // Add to target flight FIRST — if this fails, the player stays in the source flight (no data loss)
    const addRes = await fetch(`/api/organizations/${orgId}/tournaments/${tournamentId}/flights/${toFlightId}/players`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerId }),
    });
    if (!addRes.ok) {
      const d = await addRes.json() as { error?: string };
      toast({ title: d.error ?? 'Could not move player', variant: 'destructive' });
      setDragOverFlightId(null);
      return;
    }

    // Only remove from source flight after successful add to target
    if (fromFlightId != null) {
      await fetch(`/api/organizations/${orgId}/tournaments/${tournamentId}/flights/${fromFlightId}/players/${playerId}`, { method: 'DELETE' });
    }

    toast({ title: `Moved ${draggedPlayer.firstName} ${draggedPlayer.lastName}` });
    await loadFlights();
    setDragOverFlightId(null);
  };

  const handleDropOnUnassigned = async () => {
    if (!draggedPlayer || draggedPlayer.fromFlightId == null) { setDragOverFlightId(null); return; }
    const { playerId, fromFlightId } = draggedPlayer;
    await fetch(`/api/organizations/${orgId}/tournaments/${tournamentId}/flights/${fromFlightId}/players/${playerId}`, { method: 'DELETE' });
    setFlights(prev => prev.map(f => f.id === fromFlightId ? { ...f, players: f.players.filter(p => p.playerId !== playerId) } : f));
    toast({ title: `Removed ${draggedPlayer.firstName} ${draggedPlayer.lastName} from flight` });
    setDragOverFlightId(null);
  };

  if (loading) return <div className="h-64 flex items-center justify-center"><div className="w-8 h-8 rounded-full border-4 border-primary border-t-transparent animate-spin" /></div>;

  const globallyUnassigned = getGloballyUnassigned();
  const flightsWithRanges = flights.filter(f => f.handicapMin != null && f.handicapMax != null);

  return (
    <div className="space-y-6">
      {/* Unassigned players banner */}
      {flights.length > 0 && globallyUnassigned.length > 0 && (
        <div className="flex items-center gap-3 p-4 rounded-xl bg-amber-500/10 border border-amber-500/30">
          <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-amber-400">
              {globallyUnassigned.length} player{globallyUnassigned.length !== 1 ? 's' : ''} not assigned to any flight
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">
              {globallyUnassigned.slice(0, 5).map(p => `${p.firstName} ${p.lastName}`).join(', ')}
              {globallyUnassigned.length > 5 ? ` +${globallyUnassigned.length - 5} more` : ''}
            </p>
          </div>
          <Button
            size="sm"
            onClick={() => setWizardOpen(true)}
            className="bg-amber-500/20 hover:bg-amber-500/30 text-amber-400 border border-amber-500/30 text-xs shrink-0"
            variant="outline"
          >
            <Flag className="w-3.5 h-3.5 mr-1.5" /> Open Wizard
          </Button>
        </div>
      )}

      {/* Create flight */}
      <Card className="glass-card">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <CardTitle className="text-white flex items-center gap-2"><Flag className="w-4 h-4 text-primary" /> Create New Flight</CardTitle>
            <div className="flex items-center gap-2 flex-wrap">
              <Button
                size="sm"
                onClick={() => setWizardOpen(true)}
                className="bg-primary hover:bg-primary/90 text-primary-foreground text-xs"
              >
                <Layers className="w-3.5 h-3.5 mr-1.5" /> Create Flights Wizard
              </Button>
              {flightsWithRanges.length > 0 && (
                <Button
                  size="sm"
                  onClick={() => handleAutoAssign()}
                  disabled={autoAssigning === 'all'}
                  className="bg-primary/20 hover:bg-primary/40 text-primary border border-primary/30 text-xs"
                  variant="outline"
                >
                  {autoAssigning === 'all' ? <><div className="w-3.5 h-3.5 rounded-full border-2 border-primary border-t-transparent animate-spin mr-1.5" />Auto-assigning...</> : <><Shuffle className="w-3.5 h-3.5 mr-1.5" />Auto-assign all flights by handicap</>}
                </Button>
              )}
            </div>
          </div>
        </CardHeader>
      </Card>

      {/* Unassigned Players Panel */}
      {(allPlayers ?? []).length > 0 && (
        <Card
          className={`glass-card transition-all ${dragOverFlightId === 'unassigned' ? 'ring-2 ring-primary/60 bg-primary/5' : ''}`}
          onDragOver={e => { e.preventDefault(); setDragOverFlightId('unassigned'); }}
          onDragLeave={() => { if (dragOverFlightId === 'unassigned') setDragOverFlightId(null); }}
          onDrop={e => { e.preventDefault(); handleDropOnUnassigned(); }}
        >
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <button
                className="flex items-center gap-2 text-white font-semibold text-sm"
                onClick={() => setUnassignedPanelOpen(o => !o)}
              >
                <Users className="w-4 h-4 text-muted-foreground" />
                Unassigned Players
                <span className="bg-white/10 text-muted-foreground text-xs rounded-full px-2 py-0.5">{globallyUnassigned.length}</span>
                <span className="text-muted-foreground text-xs ml-1">{unassignedPanelOpen ? '▲' : '▼'}</span>
              </button>
              {dragOverFlightId === 'unassigned' && (
                <span className="text-xs text-primary animate-pulse">Drop to unassign</span>
              )}
            </div>
          </CardHeader>
          {unassignedPanelOpen && (
            <CardContent className="pt-0">
              {globallyUnassigned.length === 0 ? (
                <p className="text-xs text-muted-foreground italic py-1">All players have been assigned to a flight.</p>
              ) : (
                <>
                  <ul className="space-y-1.5 max-h-60 overflow-y-auto mb-3">
                    {globallyUnassigned.map(p => (
                      <li
                        key={p.id}
                        draggable
                        onDragStart={() => handleDragStart(p.id, null, p.firstName, p.lastName)}
                        onDragEnd={handleDragEnd}
                        className="flex items-center gap-3 text-sm bg-white/5 rounded-lg px-3 py-1.5 cursor-grab active:cursor-grabbing select-none"
                      >
                        <input
                          type="checkbox"
                          checked={selectedPlayerIds.has(p.id)}
                          onChange={e => {
                            const next = new Set(selectedPlayerIds);
                            if (e.target.checked) next.add(p.id); else next.delete(p.id);
                            setSelectedPlayerIds(next);
                          }}
                          className="accent-primary w-4 h-4 shrink-0"
                          onClick={e => e.stopPropagation()}
                        />
                        <span className="text-white font-medium flex-1">{p.firstName} {p.lastName}</span>
                        {p.handicapIndex != null && <span className="text-xs text-muted-foreground">HCP {p.handicapIndex}</span>}
                        <span className="text-muted-foreground/40 text-xs select-none" title="Drag to a flight">⠿</span>
                      </li>
                    ))}
                  </ul>

                  {/* Bulk assign sticky bar */}
                  {selectedPlayerIds.size > 0 && (
                    <div className="flex items-center gap-2 flex-wrap bg-primary/10 border border-primary/20 rounded-lg px-3 py-2">
                      <span className="text-xs text-primary font-medium">{selectedPlayerIds.size} selected</span>
                      <span className="text-muted-foreground text-xs">→ Assign to:</span>
                      <select
                        value={bulkTargetFlightId}
                        onChange={e => setBulkTargetFlightId(e.target.value)}
                        className="h-7 rounded border border-white/10 bg-black/50 text-white px-2 text-xs focus:outline-none flex-1 min-w-[140px]"
                      >
                        <option value="">Select flight...</option>
                        {flights.map(f => (
                          <option key={f.id} value={String(f.id)}>
                            {f.name}{f.maxPlayers != null ? ` (${f.players.length}/${f.maxPlayers})` : ` (${f.players.length})`}
                          </option>
                        ))}
                      </select>
                      <Button
                        size="sm"
                        onClick={handleBulkAssign}
                        disabled={!bulkTargetFlightId || bulkAssigning}
                        className="bg-primary hover:bg-primary/90 text-primary-foreground text-xs h-7 px-3 shrink-0"
                      >
                        {bulkAssigning ? <><div className="w-3 h-3 rounded-full border-2 border-white border-t-transparent animate-spin mr-1" />Assigning...</> : 'Assign'}
                      </Button>
                      <button
                        className="text-muted-foreground hover:text-white text-xs"
                        onClick={() => setSelectedPlayerIds(new Set())}
                      >Clear</button>
                    </div>
                  )}
                </>
              )}
            </CardContent>
          )}
        </Card>
      )}

      {/* Flights list */}
      {flights.length === 0 ? (
        <Card className="glass-panel border-dashed text-center p-12">
          <Flag className="w-12 h-12 text-muted-foreground mx-auto mb-4 opacity-40" />
          <h2 className="text-xl font-display text-white mb-2">No Flights Yet</h2>
          <p className="text-muted-foreground text-sm mb-4">Use the wizard to create flights and assign players automatically. Choose Manual mode in the wizard to configure each flight individually.</p>
          <Button onClick={() => setWizardOpen(true)} className="bg-primary hover:bg-primary/90 text-primary-foreground mx-auto">
            <Layers className="w-4 h-4 mr-2" /> Create Flights Wizard
          </Button>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {flights.map(flight => {
            const unassigned = getUnassignedToFlight(flight.id);
            const isDropTarget = dragOverFlightId === flight.id;
            const hasRange = flight.handicapMin != null && flight.handicapMax != null;
            return (
              <Card
                key={flight.id}
                className={`glass-card overflow-hidden transition-all ${isDropTarget ? 'ring-2 ring-primary/60 bg-primary/5' : ''}`}
                onDragOver={e => { e.preventDefault(); setDragOverFlightId(flight.id); }}
                onDragLeave={() => { if (dragOverFlightId === flight.id) setDragOverFlightId(null); }}
                onDrop={e => { e.preventDefault(); handleDropOnFlight(flight.id); }}
              >
                <div className="h-1 bg-gradient-to-r from-primary/50 to-primary/10" />
                <CardHeader className="pb-3 flex flex-row items-start justify-between">
                  <div className="flex-1 min-w-0">
                    <CardTitle className="text-white text-lg">{flight.name}</CardTitle>
                    {flight.description && <p className="text-xs text-muted-foreground mt-0.5">{flight.description}</p>}
                    <div className="flex items-center gap-2 flex-wrap mt-1">
                      <p className="text-xs text-muted-foreground">
                        {flight.players.length}{flight.maxPlayers != null ? `/${flight.maxPlayers}` : ''} player{flight.players.length !== 1 ? 's' : ''}
                      </p>
                      {hasRange && (
                        <span className="text-xs text-muted-foreground bg-white/5 border border-white/10 rounded px-1.5 py-0.5">
                          HCP {flight.handicapMin}–{flight.handicapMax}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 mt-2 flex-wrap">
                      <select
                        value={flightTiebreakerEdits[flight.id] ?? ''}
                        onChange={e => setFlightTiebreakerEdits(prev => ({ ...prev, [flight.id]: e.target.value }))}
                        className="h-7 rounded border border-white/10 bg-black/50 text-white px-2 text-xs focus:outline-none"
                      >
                        <option value="">Inherit from tournament</option>
                        <option value="countback">Countback</option>
                        <option value="net_countback">Net Countback</option>
                        <option value="multi_round_countback">Multi-Round Countback</option>
                        <option value="lower_handicap">Lower Handicap</option>
                        <option value="no_tiebreaker">No Tiebreaker</option>
                      </select>
                      <button
                        onClick={() => updateFlightTiebreaker(flight.id, flight.name)}
                        disabled={savingFlightTiebreaker === flight.id}
                        className="text-xs bg-primary/20 hover:bg-primary/40 text-primary border border-primary/30 rounded px-2 py-1 disabled:opacity-50"
                      >
                        {savingFlightTiebreaker === flight.id ? '…' : 'Save'}
                      </button>
                      {hasRange && (
                        <button
                          onClick={() => handleAutoAssign(flight.id)}
                          disabled={autoAssigning === flight.id}
                          title={`Auto-fill from HCP ${flight.handicapMin}–${flight.handicapMax}`}
                          className="text-xs bg-primary/20 hover:bg-primary/40 text-primary border border-primary/30 rounded px-2 py-1 disabled:opacity-50 flex items-center gap-1"
                        >
                          {autoAssigning === flight.id
                            ? <><div className="w-3 h-3 rounded-full border-2 border-primary border-t-transparent animate-spin" />Filling...</>
                            : <><Shuffle className="w-3 h-3" />Auto-fill</>
                          }
                        </button>
                      )}
                    </div>
                  </div>
                  <Button size="sm" variant="ghost" onClick={() => deleteFlight(flight.id, flight.name)} className="text-destructive hover:bg-destructive/10 h-7 w-7 p-0 ml-2 shrink-0">
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                </CardHeader>
                <CardContent className="pt-0 space-y-2">
                  {isDropTarget && draggedPlayer && (
                    <div className="text-xs text-primary text-center py-1 animate-pulse">
                      Drop to move {draggedPlayer.firstName} {draggedPlayer.lastName} here
                    </div>
                  )}
                  {flight.players.length === 0 ? (
                    <p className="text-xs text-muted-foreground italic py-2">No players assigned yet.</p>
                  ) : (
                    <ul className="space-y-1.5">
                      {flight.players.map(p => (
                        <li
                          key={p.playerId}
                          draggable
                          onDragStart={() => handleDragStart(p.playerId, flight.id, p.firstName, p.lastName)}
                          onDragEnd={handleDragEnd}
                          className="flex items-center justify-between gap-2 text-sm bg-white/5 rounded-lg px-3 py-1.5 cursor-grab active:cursor-grabbing select-none"
                        >
                          <div className="flex items-center gap-2">
                            <UserCheck className="w-3.5 h-3.5 text-primary shrink-0" />
                            <span className="text-white font-medium">{p.firstName} {p.lastName}</span>
                            {p.handicapIndex != null && <span className="text-xs text-muted-foreground">HCP {p.handicapIndex}</span>}
                          </div>
                          <button onClick={() => removeFromFlight(flight.id, p.playerId)} className="text-muted-foreground hover:text-destructive transition-colors">
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  {/* Assign player dropdown */}
                  {assignOpen === flight.id ? (
                    <div className="space-y-2">
                      <Select onValueChange={val => assignPlayer(flight.id, parseInt(val))}>
                        <SelectTrigger className="bg-black/50 border-white/10 text-white text-sm">
                          <SelectValue placeholder="Select a player to assign..." />
                        </SelectTrigger>
                        <SelectContent className="bg-card border-white/10 text-white">
                          {unassigned.length === 0
                            ? <SelectItem value="-" disabled>All players assigned</SelectItem>
                            : unassigned.map(p => <SelectItem key={p.id} value={String(p.id)}>{p.firstName} {p.lastName}{p.handicapIndex != null ? ` (HCP ${p.handicapIndex})` : ''}</SelectItem>)
                          }
                        </SelectContent>
                      </Select>
                      <Button size="sm" variant="ghost" onClick={() => setAssignOpen(null)} className="text-muted-foreground hover:text-white w-full text-xs">Cancel</Button>
                    </div>
                  ) : (
                    <Button size="sm" variant="outline" onClick={() => setAssignOpen(flight.id)} className="w-full border-white/10 bg-white/5 hover:bg-white/10 text-white text-xs mt-1">
                      <UserPlus className="w-3 h-3 mr-1.5" /> Assign Player
                    </Button>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <FlightWizardModal
        open={wizardOpen}
        onClose={() => setWizardOpen(false)}
        orgId={orgId}
        tournamentId={tournamentId}
        onComplete={() => { loadFlights(); }}
      />
    </div>
  );
}

/* ─── Draw Tab ───────────────────────────────────────────────────── */

const DRAW_MODES = [
  { value: 'manual', label: 'Manual', icon: '✏️', desc: 'Build groups by hand — drag & drop or type names directly' },
  { value: 'random', label: 'Random', icon: '🔀', desc: 'Randomly shuffle all players into groups' },
  { value: 'handicap', label: 'Handicap Balanced', icon: '⚖️', desc: 'Mix low/high handicaps in each group for even competition' },
  { value: 'by_flight', label: 'By Flight', icon: '✈️', desc: 'Keep players grouped within their assigned flight' },
  { value: 'sequential', label: 'Sequential', icon: '🔢', desc: 'Registration order — first in, first out' },
  { value: 'abcd', label: 'A/B/C/D Draw', icon: '🎯', desc: 'Balanced scramble groups: one player per handicap band (A=low, D=high)' },
  { value: 'by_results', label: 'By Previous Results', icon: '🏆', desc: 'Order by leaderboard position — leaders in the final group' },
  { value: 'copy_round', label: 'Copy Previous Round', icon: '📋', desc: 'Duplicate exact groups & tee times from a prior round' },
  { value: 'csv_upload', label: 'CSV Upload', icon: '📄', desc: 'Import groups from a spreadsheet — download template first' },
];

type DrawPlayer = TeeTimePlayersItem & { handicapIndex?: string | number | null };
type DrawTeeTime = Omit<TeeTime, 'players'> & { players: DrawPlayer[]; isManual?: boolean };

function DrawTab({ orgId, tournamentId, format }: { orgId: number; tournamentId: number; format: string }) {
  const { toast } = useToast();
  const { data: rawTeeTimes, refetch } = useListTeeTimes(orgId, tournamentId);
  const teeTimes = rawTeeTimes as DrawTeeTime[] | undefined;
  const { data: allPlayersRaw } = useListPlayers(orgId, tournamentId);
  const allPlayers = (allPlayersRaw as { id: number; firstName: string; lastName: string; handicapIndex?: string | number | null; flight?: string | null }[] | undefined) ?? [];
  const [subTab, setSubTab] = useState<'teesheet' | 'bracket'>('teesheet');
  const [mode, setMode] = useState('random');
  const [round, setRound] = useState('1');
  const [startTime, setStartTime] = useState('08:00');
  const [intervalMinutes, setIntervalMinutes] = useState('10');
  const [groupSize, setGroupSize] = useState('4');
  const [startingHole, setStartingHole] = useState('1');
  // Split-tee / multi-hole start mode
  const [startMode, setStartMode] = useState<'sequential' | 'shotgun' | 'split_tee' | 'multi_hole'>('sequential');
  const [splitHole1, setSplitHole1] = useState('1');
  const [splitHole2, setSplitHole2] = useState('10');
  const [multiHoles, setMultiHoles] = useState<number[]>([1, 7, 10]);
  const [teeSheetView, setTeeSheetView] = useState<'time' | 'hole'>('time');
  const [generating, setGenerating] = useState(false);
  const [generatingAll, setGeneratingAll] = useState(false);
  const [showConfirmGenerateAll, setShowConfirmGenerateAll] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [publishedAt, setPublishedAt] = useState<string | null>(null);
  // Drag-and-drop draw builder state
  const [draggedPlayerId, setDraggedPlayerId] = useState<number | null>(null);
  const [dragSourceTeeTimeId, setDragSourceTeeTimeId] = useState<number | null>(null);
  const [dragOverTeeTimeId, setDragOverTeeTimeId] = useState<number | null>(null);
  const [dragOverPlayerId, setDragOverPlayerId] = useState<number | null>(null);
  const [dragOverPool, setDragOverPool] = useState(false);
  const [poolSearch, setPoolSearch] = useState('');
  const [poolFlightFilter, setPoolFlightFilter] = useState('');
  // Optimistic local state (null = use server data)
  const [localTeeTimes, setLocalTeeTimes] = useState<DrawTeeTime[] | null>(null);
  // Clear Draw dialog
  const [showClearDialog, setShowClearDialog] = useState(false);
  const [clearScope, setClearScope] = useState<'round' | 'all'>('round');
  // New pairing methods
  const [sourceRound, setSourceRound] = useState('1');
  const [tiebreakerMethod, setTiebreakerMethod] = useState<'alphabetical' | 'random' | 'previous_tee_time'>('alphabetical');
  const [swapHoles, setSwapHoles] = useState(false);
  const [reverseTimes, setReverseTimes] = useState(false);
  const [csvText, setCsvText] = useState('');
  const [csvErrors, setCsvErrors] = useState<string[]>([]);
  const [csvImporting, setCsvImporting] = useState(false);
  const [addingGroup, setAddingGroup] = useState(false);
  // Per-group inline time/hole editing
  const [editingTeeTimeId, setEditingTeeTimeId] = useState<number | null>(null);
  const [editTimeValue, setEditTimeValue] = useState('');
  const [editHoleValue, setEditHoleValue] = useState('');
  const [savingTeeTimeEdit, setSavingTeeTimeEdit] = useState(false);

  const handleStartEditTeeTime = (tt: DrawTeeTime) => {
    setEditingTeeTimeId(tt.id);
    setEditTimeValue(new Date(tt.teeTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }));
    setEditHoleValue(String(tt.hole ?? 1));
  };
  const handleSaveTeeTimeEdit = async (ttId: number) => {
    setSavingTeeTimeEdit(true);
    try {
      const [h, m] = editTimeValue.split(':').map(Number);
      const d = new Date(); d.setHours(h || 0, m || 0, 0, 0);
      await fetch(`/api/organizations/${orgId}/tournaments/${tournamentId}/tee-times/${ttId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ startingHole: parseInt(editHoleValue) || 1, teeTime: d.toISOString() }),
      });
      setEditingTeeTimeId(null);
      refetch();
    } finally {
      setSavingTeeTimeEdit(false);
    }
  };

  // Tee-time assignment step
  const [showSetTeeTimes, setShowSetTeeTimes] = useState(false);
  const [bulkFirstTime, setBulkFirstTime] = useState('08:00');
  const [bulkInterval, setBulkInterval] = useState('10');
  const [bulkStartingHole, setBulkStartingHole] = useState('1');
  const [bulkApplying, setBulkApplying] = useState(false);

  const handlePublishPairings = async () => {
    if (publishedAt) { toast({ title: 'Pairings already published', description: `Published at ${new Date(publishedAt).toLocaleString()}` }); return; }
    setPublishing(true);
    try {
      const res = await fetch(`/api/organizations/${orgId}/tournaments/${tournamentId}/publish-pairings`, { method: 'POST', credentials: 'include' });
      const data = await res.json();
      if (!res.ok) { toast({ title: data.error || 'Failed to publish', variant: 'destructive' }); return; }
      if (data.alreadyPublished) {
        setPublishedAt(data.publishedAt);
        toast({ title: 'Already published', description: `Pairings were published at ${new Date(data.publishedAt).toLocaleString()}` });
      } else {
        setPublishedAt(data.publishedAt);
        toast({ title: `⛳ Pairings published!`, description: `${data.notified} player(s) notified via push & email.` });
      }
    } catch {
      toast({ title: 'Failed to publish', variant: 'destructive' });
    } finally {
      setPublishing(false);
    }
  };

  // Auto-set shotgun start mode when shotgun pairing mode is selected
  React.useEffect(() => {
    if (mode === 'shotgun') setStartMode('shotgun');
  }, [mode]);

  const handleClearAll = () => {
    setClearScope('round');
    setShowClearDialog(true);
  };

  const handleClearConfirm = async () => {
    setShowClearDialog(false);
    setClearing(true);
    try {
      const url = clearScope === 'round'
        ? `/api/organizations/${orgId}/tournaments/${tournamentId}/tee-times?round=${round}`
        : `/api/organizations/${orgId}/tournaments/${tournamentId}/tee-times`;
      const res = await fetch(url, { method: 'DELETE', credentials: 'include' });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        toast({ title: d.error || 'Failed to clear tee times', variant: 'destructive' });
        return;
      }
      const d = await res.json();
      const scopeLabel = clearScope === 'round' ? `Round ${round}` : 'all rounds';
      toast({ title: `Cleared ${d.deleted} tee time${d.deleted !== 1 ? 's' : ''} (${scopeLabel})` });
      setLocalTeeTimes(null);
      refetch();
    } catch {
      toast({ title: 'Failed to clear tee times', variant: 'destructive' });
    } finally {
      setClearing(false);
    }
  };

  const handleFillRemaining = async () => {
    setGenerating(true);
    try {
      const effectiveStartMode: 'sequential' | 'shotgun' | 'split_tee' | 'multi_hole' = startMode;
      let startingHolesPayload: number[] | undefined;
      if (effectiveStartMode === 'split_tee') {
        const h1 = parseInt(splitHole1);
        const h2 = parseInt(splitHole2);
        if (h1 === h2) { toast({ title: 'Split-tee holes must be different', variant: 'destructive' }); setGenerating(false); return; }
        startingHolesPayload = [h1, h2];
      } else if (effectiveStartMode === 'multi_hole') {
        if (multiHoles.length < 3) { toast({ title: 'Custom multi-hole requires at least 3 holes', variant: 'destructive' }); setGenerating(false); return; }
        startingHolesPayload = multiHoles;
      }
      const res = await fetch(`/api/organizations/${orgId}/tournaments/${tournamentId}/generate-pairings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          round: parseInt(round), startTime: (() => { const d = new Date(); const [h, m] = startTime.split(':'); d.setHours(parseInt(h), parseInt(m), 0, 0); return d.toISOString(); })(),
          intervalMinutes: parseInt(intervalMinutes), groupSize: parseInt(groupSize), startingHole: parseInt(startingHole),
          shotgunStart: effectiveStartMode === 'shotgun', startMode: effectiveStartMode, startingHoles: startingHolesPayload,
          mode, preserveLocked: true,
        }),
      });
      if (!res.ok) {
        const d = await res.json();
        toast({ title: d.error || 'Failed to generate', variant: 'destructive' });
      } else {
        toast({ title: `Filled remaining slots for Round ${round}!` });
        refetch();
      }
    } catch { toast({ title: 'Generation failed', variant: 'destructive' }); }
    finally { setGenerating(false); }
  };

  const handleGenerateAll = async () => {
    setGeneratingAll(true);
    setShowConfirmGenerateAll(false);
    try {
      const effectiveStartMode: 'sequential' | 'shotgun' | 'split_tee' | 'multi_hole' = startMode;
      let startingHolesPayload: number[] | undefined;
      if (effectiveStartMode === 'split_tee') {
        const h1 = parseInt(splitHole1);
        const h2 = parseInt(splitHole2);
        if (h1 === h2) { toast({ title: 'Split-tee holes must be different', variant: 'destructive' }); setGeneratingAll(false); return; }
        startingHolesPayload = [h1, h2];
      } else if (effectiveStartMode === 'multi_hole') {
        if (multiHoles.length < 3) { toast({ title: 'Custom multi-hole requires at least 3 holes', variant: 'destructive' }); setGeneratingAll(false); return; }
        startingHolesPayload = multiHoles;
      }
      const res = await fetch(`/api/organizations/${orgId}/tournaments/${tournamentId}/generate-pairings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          round: parseInt(round), startTime: (() => { const d = new Date(); const [h, m] = startTime.split(':'); d.setHours(parseInt(h), parseInt(m), 0, 0); return d.toISOString(); })(),
          intervalMinutes: parseInt(intervalMinutes), groupSize: parseInt(groupSize), startingHole: parseInt(startingHole),
          shotgunStart: effectiveStartMode === 'shotgun', startMode: effectiveStartMode, startingHoles: startingHolesPayload,
          mode, preserveLocked: false,
        }),
      });
      if (!res.ok) {
        const d = await res.json();
        toast({ title: d.error || 'Failed to generate', variant: 'destructive' });
      } else {
        toast({ title: `Full draw generated for Round ${round}!` });
        refetch();
      }
    } catch { toast({ title: 'Generation failed', variant: 'destructive' }); }
    finally { setGeneratingAll(false); }
  };

  const handlePlayerDragStart = (playerId: number, sourceTeeTimeId: number | null) => {
    setDraggedPlayerId(playerId);
    setDragSourceTeeTimeId(sourceTeeTimeId);
  };

  // Optimistically apply a player move in local state (pool → group, group → group, or group → pool)
  const applyOptimisticMove = (
    pid: number,
    sourceId: number | null,
    targetId: number | null,
    playerInfo: { firstName: string; lastName: string; flight?: string | null; handicapIndex?: string | number | null },
  ) => {
    const base = localTeeTimes ?? (teeTimes as DrawTeeTime[] | undefined) ?? [];
    const updated = base.map(tt => {
      let players = [...tt.players];
      if (sourceId != null && tt.id === sourceId) {
        players = players.filter(p => p.playerId !== pid);
      }
      if (targetId != null && tt.id === targetId) {
        if (!players.find(p => p.playerId === pid)) {
          players = [...players, { playerId: pid, firstName: playerInfo.firstName, lastName: playerInfo.lastName, flight: playerInfo.flight ?? null, handicapIndex: playerInfo.handicapIndex ?? null }];
        }
        return { ...tt, players, isManual: true };
      }
      return { ...tt, players };
    });
    setLocalTeeTimes(updated);
  };

  const handleDropOnTeeTime = async (targetTeeTimeId: number) => {
    if (draggedPlayerId == null) return;
    setDragOverTeeTimeId(null);
    const pid = draggedPlayerId;
    const sourceId = dragSourceTeeTimeId;
    setDraggedPlayerId(null);
    setDragSourceTeeTimeId(null);

    if (sourceId === targetTeeTimeId) return;

    // Find player info for optimistic update
    const allDisplayTeeTimes = localTeeTimes ?? (teeTimes as DrawTeeTime[] | undefined) ?? [];
    let playerInfo: { firstName: string; lastName: string; flight?: string | null; handicapIndex?: string | number | null } = { firstName: '', lastName: '' };
    if (sourceId != null) {
      const srcGroup = allDisplayTeeTimes.find(tt => tt.id === sourceId);
      const srcPlayer = srcGroup?.players.find(p => p.playerId === pid);
      if (srcPlayer) playerInfo = srcPlayer;
    } else {
      const poolPlayer = allPlayers.find(p => p.id === pid);
      if (poolPlayer) playerInfo = poolPlayer;
    }

    // Apply optimistic update immediately
    applyOptimisticMove(pid, sourceId, targetTeeTimeId, playerInfo);

    try {
      const body = sourceId != null
        ? { action: 'move', playerId: pid, sourceTeeTimeId: sourceId }
        : { action: 'add', playerId: pid };
      const res = await fetch(`/api/organizations/${orgId}/tournaments/${tournamentId}/tee-times/${targetTeeTimeId}/players`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        toast({ title: d.error || 'Failed to move player', variant: 'destructive' });
        setLocalTeeTimes(null);
      }
      refetch().then(() => setLocalTeeTimes(null));
    } catch {
      toast({ title: 'Failed to move player', variant: 'destructive' });
      setLocalTeeTimes(null);
      refetch();
    }
  };

  const handleDropOnPool = async () => {
    setDragOverPool(false);
    if (draggedPlayerId == null || dragSourceTeeTimeId == null) { setDraggedPlayerId(null); setDragSourceTeeTimeId(null); return; }
    const pid = draggedPlayerId;
    const sourceId = dragSourceTeeTimeId;
    setDraggedPlayerId(null);
    setDragSourceTeeTimeId(null);

    // Apply optimistic update immediately (remove from source group)
    applyOptimisticMove(pid, sourceId, null, { firstName: '', lastName: '' });

    try {
      const res = await fetch(`/api/organizations/${orgId}/tournaments/${tournamentId}/tee-times/${sourceId}/players`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ action: 'remove', playerId: pid }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        toast({ title: d.error || 'Failed to return player to pool', variant: 'destructive' });
        setLocalTeeTimes(null);
      }
      refetch().then(() => setLocalTeeTimes(null));
    } catch {
      toast({ title: 'Failed to return player to pool', variant: 'destructive' });
      setLocalTeeTimes(null);
      refetch();
    }
  };

  // Drop onto a specific player chip: swap (group→group) or displace-to-pool (pool→group)
  const handleDropOnPlayerChip = async (targetTeeTimeId: number, targetPlayerId: number) => {
    if (draggedPlayerId == null) return;
    setDragOverPlayerId(null);
    setDragOverTeeTimeId(null);
    const pid = draggedPlayerId;
    const sourceId = dragSourceTeeTimeId;
    setDraggedPlayerId(null);
    setDragSourceTeeTimeId(null);

    // Same player or same group → let the row handler resolve
    if (pid === targetPlayerId) return;
    if (sourceId === targetTeeTimeId) return;

    // Find player info for optimistic updates
    const allDisplayTeeTimes = localTeeTimes ?? (teeTimes as DrawTeeTime[] | undefined) ?? [];
    let draggedInfo: { firstName: string; lastName: string; flight?: string | null; handicapIndex?: string | number | null } = { firstName: '', lastName: '' };
    let targetInfo: { firstName: string; lastName: string; flight?: string | null; handicapIndex?: string | number | null } = { firstName: '', lastName: '' };

    if (sourceId != null) {
      const srcGroup = allDisplayTeeTimes.find(tt => tt.id === sourceId);
      const fp = srcGroup?.players.find(p => p.playerId === pid);
      if (fp) draggedInfo = fp;
    } else {
      const fp = allPlayers.find(p => p.id === pid);
      if (fp) draggedInfo = fp;
    }
    const tgtGroup = allDisplayTeeTimes.find(tt => tt.id === targetTeeTimeId);
    const fp = tgtGroup?.players.find(p => p.playerId === targetPlayerId);
    if (fp) targetInfo = fp;

    if (sourceId != null) {
      // Group→group swap: optimistically swap both players
      const base = localTeeTimes ?? (teeTimes as DrawTeeTime[] | undefined) ?? [];
      const updated = base.map(tt => {
        let players = [...tt.players];
        if (tt.id === sourceId) {
          players = players.filter(p => p.playerId !== pid);
          if (!players.find(p => p.playerId === targetPlayerId)) {
            players = [...players, { ...targetInfo, playerId: targetPlayerId }];
          }
          return { ...tt, players, isManual: true };
        }
        if (tt.id === targetTeeTimeId) {
          players = players.filter(p => p.playerId !== targetPlayerId);
          if (!players.find(p => p.playerId === pid)) {
            players = [...players, { ...draggedInfo, playerId: pid }];
          }
          return { ...tt, players, isManual: true };
        }
        return tt;
      });
      setLocalTeeTimes(updated);

      try {
        const res = await fetch(`/api/organizations/${orgId}/tournaments/${tournamentId}/tee-times/${targetTeeTimeId}/players`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
          body: JSON.stringify({ action: 'swap', playerId: pid, sourceTeeTimeId: sourceId, swapPlayerId: targetPlayerId }),
        });
        if (!res.ok) {
          const d = await res.json().catch(() => ({}));
          toast({ title: d.error || 'Failed to swap players', variant: 'destructive' });
          setLocalTeeTimes(null);
        }
        refetch().then(() => setLocalTeeTimes(null));
      } catch {
        toast({ title: 'Failed to swap players', variant: 'destructive' });
        setLocalTeeTimes(null);
        refetch();
      }
    } else {
      // Pool→group: displace target player to pool, add dragged player
      const base = localTeeTimes ?? (teeTimes as DrawTeeTime[] | undefined) ?? [];
      const updated = base.map(tt => {
        if (tt.id === targetTeeTimeId) {
          const players = tt.players.filter(p => p.playerId !== targetPlayerId);
          players.push({ ...draggedInfo, playerId: pid });
          return { ...tt, players, isManual: true };
        }
        return tt;
      });
      setLocalTeeTimes(updated);

      try {
        const res = await fetch(`/api/organizations/${orgId}/tournaments/${tournamentId}/tee-times/${targetTeeTimeId}/players`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
          body: JSON.stringify({ action: 'displace', playerId: pid, swapPlayerId: targetPlayerId }),
        });
        if (!res.ok) {
          const d = await res.json().catch(() => ({}));
          toast({ title: d.error || 'Failed to place player', variant: 'destructive' });
          setLocalTeeTimes(null);
        }
        refetch().then(() => setLocalTeeTimes(null));
      } catch {
        toast({ title: 'Failed to place player', variant: 'destructive' });
        setLocalTeeTimes(null);
        refetch();
      }
    }
  };

  const handleToggleLock = async (teeTimeId: number) => {
    try {
      const res = await fetch(`/api/organizations/${orgId}/tournaments/${tournamentId}/tee-times/${teeTimeId}`, {
        method: 'PATCH',
        credentials: 'include',
      });
      if (!res.ok) {
        const d = await res.json();
        toast({ title: d.error || 'Failed to toggle lock', variant: 'destructive' });
        return;
      }
      refetch();
    } catch {
      toast({ title: 'Failed to toggle lock', variant: 'destructive' });
    }
  };

  const handlePrint = () => {
    const printWin = window.open('', '_blank', 'width=1123,height=794');
    if (!printWin) { window.print(); return; }
    const allTimes = [...(teeTimes ?? [])].sort((a, b) => new Date(a.teeTime).getTime() - new Date(b.teeTime).getTime());
    const uniquePrintHoles = [...new Set(allTimes.map(tt => tt.hole ?? 1))].sort((a, b) => a - b);
    const hasMultiPrintHoles = uniquePrintHoles.length > 1;

    const makeRow = (tt: DrawTeeTime) => `
      <tr>
        <td style="font-weight:700;font-family:monospace;border:1px solid #ccc;padding:6px 10px;">
          ${new Date(tt.teeTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </td>
        <td style="border:1px solid #ccc;padding:6px 10px;text-align:center;font-weight:600;">Hole ${tt.hole}</td>
        <td style="border:1px solid #ccc;padding:6px 10px;">
          ${tt.players.map(p => `${p.firstName} ${p.lastName}${p.flight ? ` (${p.flight})` : ''}`).join('<br/>')}
        </td>
        <td style="border:1px solid #ccc;padding:6px 10px;text-align:center;color:#555;font-size:12px;">
          ${tt.players.map(p => p.handicapIndex != null ? Number(p.handicapIndex).toFixed(1) : '—').join('<br/>')}
        </td>
      </tr>
    `;

    let rows: string;
    if (hasMultiPrintHoles) {
      rows = uniquePrintHoles.map(holeNum => {
        const holeRows = allTimes.filter(tt => (tt.hole ?? 1) === holeNum).map(makeRow).join('');
        return `
          <tr>
            <td colspan="4" style="background:#111;color:#fff;padding:6px 10px;font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;">
              ── Hole ${holeNum} ──────────────────────────────────────────
            </td>
          </tr>
          ${holeRows}
        `;
      }).join('');
    } else {
      rows = allTimes.map(makeRow).join('');
    }

    printWin.document.write(`<!DOCTYPE html><html><head><title>Tee Sheet</title>
      <style>
        @page { size: A4 landscape; margin: 15mm; }
        body { font-family: Arial, sans-serif; font-size: 13px; color: #000; }
        .header { display: flex; justify-content: space-between; align-items: flex-end; margin-bottom: 12px; border-bottom: 2px solid #000; padding-bottom: 8px; }
        .club { font-size: 22px; font-weight: 800; letter-spacing: 2px; }
        .meta { text-align: right; font-size: 12px; color: #444; }
        table { width: 100%; border-collapse: collapse; }
        th { background: #111; color: #fff; padding: 7px 10px; text-align: left; font-size: 12px; letter-spacing: 1px; }
        tr:nth-child(even) { background: #f7f7f7; }
        .footer { margin-top: 10px; font-size: 10px; color: #888; text-align: center; }
      </style></head><body>
      <div class="header">
        <div class="club">⛳ KHARA<span style="color:#C9A84C">GOLF</span></div>
        <div class="meta">
          <div style="font-size:16px;font-weight:700;">Official Tee Sheet — Round ${round}${hasMultiPrintHoles ? ` · Split-Tee (${uniquePrintHoles.map(h => `Hole ${h}`).join(' / ')})` : ''}</div>
          <div>${new Date().toLocaleDateString('en-GB', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</div>
          <div>${allTimes.length} groups · Generated ${new Date().toLocaleTimeString()}</div>
        </div>
      </div>
      <table>
        <thead><tr>
          <th style="width:90px;">Time</th>
          <th style="width:70px;text-align:center;">Hole</th>
          <th>Players</th>
          <th style="width:80px;text-align:center;">HCP</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="footer">KHARA<span style="color:#C9A84C">GOLF</span> <span style="color:#C9A84C">Elysium</span><span style="color:#ffffff">OS</span> · Confidential · For official use only</div>
    </body></html>`);
    printWin.document.close();
    printWin.focus();
    setTimeout(() => { printWin.print(); printWin.close(); }, 300);
  };

  // Manual mode: add a blank group slot
  const handleAddManualGroup = async () => {
    setAddingGroup(true);
    try {
      const teeTimeDate = new Date();
      const [h, m] = startTime.split(':');
      // Use last group's time + interval, or configured start time
      const allDisplayTimes = (localTeeTimes ?? teeTimes) as DrawTeeTime[] | undefined;
      const existingRoundTimes = (allDisplayTimes ?? []).filter(tt => String(tt.round) === String(round));
      if (existingRoundTimes.length > 0) {
        const sorted = [...existingRoundTimes].sort((a, b) => new Date(a.teeTime).getTime() - new Date(b.teeTime).getTime());
        const lastTime = new Date(sorted[sorted.length - 1].teeTime);
        teeTimeDate.setTime(lastTime.getTime() + parseInt(intervalMinutes) * 60 * 1000);
      } else {
        teeTimeDate.setHours(parseInt(h), parseInt(m), 0, 0);
      }
      const res = await fetch(`/api/organizations/${orgId}/tournaments/${tournamentId}/tee-times`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ teeTime: teeTimeDate.toISOString(), hole: parseInt(startingHole), round: parseInt(round), playerIds: [] }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        toast({ title: d.error || 'Failed to add group', variant: 'destructive' });
        return;
      }
      await refetch();
    } catch {
      toast({ title: 'Failed to add group', variant: 'destructive' });
    } finally {
      setAddingGroup(false);
    }
  };

  // By Previous Results: generate pairings ordered by prior round leaderboard
  const handleByResults = async (preserveLocked: boolean) => {
    // "Fill Remaining" uses generating; "Generate All" uses generatingAll to correctly gate its button
    if (preserveLocked) setGenerating(true); else setGeneratingAll(true);
    try {
      const res = await fetch(`/api/organizations/${orgId}/tournaments/${tournamentId}/generate-pairings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          round: parseInt(round),
          startTime: (() => { const d = new Date(); const [h, m] = startTime.split(':'); d.setHours(parseInt(h), parseInt(m), 0, 0); return d.toISOString(); })(),
          intervalMinutes: parseInt(intervalMinutes),
          groupSize: parseInt(groupSize),
          startingHole: parseInt(startingHole),
          shotgunStart: false,
          startMode: startMode,
          mode: 'by_results',
          sourceRound: parseInt(sourceRound),
          tiebreaker: tiebreakerMethod,
          preserveLocked,
        }),
      });
      if (!res.ok) {
        const d = await res.json();
        toast({ title: d.error || 'Failed to generate', variant: 'destructive' });
      } else {
        toast({ title: `Draw generated by Round ${sourceRound} results!` });
        refetch();
      }
    } catch { toast({ title: 'Generation failed', variant: 'destructive' }); }
    finally { if (preserveLocked) setGenerating(false); else setGeneratingAll(false); }
  };

  // Copy Previous Round
  const handleCopyRound = async () => {
    setGenerating(true);
    try {
      const res = await fetch(`/api/organizations/${orgId}/tournaments/${tournamentId}/copy-round`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ sourceRound: parseInt(sourceRound), targetRound: parseInt(round), swapHoles, reverseTimes }),
      });
      if (!res.ok) {
        const d = await res.json();
        toast({ title: d.error || 'Failed to copy round', variant: 'destructive' });
      } else {
        toast({ title: `Round ${sourceRound} copied to Round ${round}!` });
        refetch();
      }
    } catch { toast({ title: 'Copy failed', variant: 'destructive' }); }
    finally { setGenerating(false); }
  };

  // CSV Upload
  const handleCsvUpload = async () => {
    if (!csvText.trim()) { toast({ title: 'No CSV data provided', variant: 'destructive' }); return; }
    setCsvImporting(true);
    setCsvErrors([]);
    try {
      const res = await fetch(`/api/organizations/${orgId}/tournaments/${tournamentId}/import-pairings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ csv: csvText, round: parseInt(round) }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (data.unrecognised) {
          setCsvErrors(data.unrecognised);
          toast({ title: `${data.unrecognised.length} unrecognised player name(s)`, variant: 'destructive' });
        } else {
          toast({ title: data.error || 'Import failed', variant: 'destructive' });
        }
        return;
      }
      toast({ title: `Imported ${data.imported} group(s) for Round ${round}!` });
      setCsvText('');
      refetch();
    } catch { toast({ title: 'Import failed', variant: 'destructive' }); }
    finally { setCsvImporting(false); }
  };

  const handleCsvFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (evt) => { setCsvText(String(evt.target?.result ?? '')); };
    reader.readAsText(file);
  };

  // Bulk set tee times
  const handleBulkSetTimes = async () => {
    setBulkApplying(true);
    try {
      const teeTimeDate = new Date();
      const [h, m] = bulkFirstTime.split(':');
      teeTimeDate.setHours(parseInt(h), parseInt(m), 0, 0);
      const res = await fetch(`/api/organizations/${orgId}/tournaments/${tournamentId}/bulk-set-times`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ round: parseInt(round), startTime: teeTimeDate.toISOString(), intervalMinutes: parseInt(bulkInterval), startingHole: parseInt(bulkStartingHole) }),
      });
      if (!res.ok) {
        const d = await res.json();
        toast({ title: d.error || 'Failed to set tee times', variant: 'destructive' });
      } else {
        toast({ title: `Tee times updated for Round ${round}!` });
        setShowSetTeeTimes(false);
        refetch();
      }
    } catch { toast({ title: 'Failed to set tee times', variant: 'destructive' }); }
    finally { setBulkApplying(false); }
  };

  const isMatchPlay = format === 'match_play';

  // Use optimistic local state if available, otherwise use server data
  const displayTeeTimes = (localTeeTimes ?? teeTimes) as DrawTeeTime[] | undefined;

  // Tee sheet derived state
  const lockedGroupCount = (displayTeeTimes ?? []).filter(tt => tt.isManual).length;

  // Compute unassigned players for the player pool (players not in any tee time for the current round)
  const roundTeeTimes = (displayTeeTimes ?? []).filter(tt => String(tt.round) === String(round));
  const assignedPlayerIds = new Set(roundTeeTimes.flatMap(tt => tt.players.map(p => p.playerId)));
  const uniqueFlights = [...new Set(allPlayers.map(p => p.flight).filter(Boolean) as string[])].sort();
  const unassignedPlayers = allPlayers.filter(p => !assignedPlayerIds.has(p.id));
  const filteredPoolPlayers = unassignedPlayers.filter(p => {
    const matchesSearch = poolSearch === '' || `${p.firstName} ${p.lastName}`.toLowerCase().includes(poolSearch.toLowerCase());
    const matchesFlight = poolFlightFilter === '' || p.flight === poolFlightFilter;
    return matchesSearch && matchesFlight;
  });

  const teeSheetSorted = [...roundTeeTimes].sort((a, b) => {
    if (teeSheetView === 'hole') {
      const holeDiff = (a.hole ?? 1) - (b.hole ?? 1);
      if (holeDiff !== 0) return holeDiff;
      return new Date(a.teeTime).getTime() - new Date(b.teeTime).getTime();
    }
    return new Date(a.teeTime).getTime() - new Date(b.teeTime).getTime();
  });
  const teeSheetUniqueHoles = [...new Set(roundTeeTimes.map(tt => tt.hole ?? 1))].sort((a, b) => a - b);
  const teeSheetHasMultipleHoles = teeSheetUniqueHoles.length > 1;

  return (
    <div className="space-y-6">
      {/* Sub-tab selector */}
      {isMatchPlay && (
        <div className="flex gap-1 p-1 bg-black/40 border border-white/5 rounded-xl w-fit">
          <button onClick={() => setSubTab('teesheet')} className={`px-4 py-2 rounded-lg text-sm font-medium transition-all flex items-center gap-2 ${subTab === 'teesheet' ? 'bg-white/10 text-white' : 'text-muted-foreground hover:text-white'}`}>
            <Layers className="w-3.5 h-3.5" /> Tee Sheet
          </button>
          <button onClick={() => setSubTab('bracket')} className={`px-4 py-2 rounded-lg text-sm font-medium transition-all flex items-center gap-2 ${subTab === 'bracket' ? 'bg-white/10 text-white' : 'text-muted-foreground hover:text-white'}`}>
            <GitBranch className="w-3.5 h-3.5" /> Match Bracket
          </button>
        </div>
      )}

      {subTab === 'teesheet' && (
        <>
          {/* Generate Panel */}
          <Card className="glass-card">
            <CardHeader className="pb-3">
              <CardTitle className="text-white flex items-center gap-2"><Shuffle className="w-4 h-4 text-primary" /> Generate Draw</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Mode picker */}
              <div>
                <p className="text-xs text-muted-foreground uppercase tracking-wider mb-2 font-semibold">Pairing Mode</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                  {DRAW_MODES.map(m => (
                    <button
                      key={m.value}
                      onClick={() => setMode(m.value)}
                      className={`flex items-start gap-3 p-3 rounded-xl border text-left transition-all ${
                        mode === m.value
                          ? 'border-primary/50 bg-primary/10 text-white'
                          : 'border-white/10 bg-white/3 text-muted-foreground hover:border-white/20 hover:text-white'
                      }`}
                    >
                      <span className="text-lg shrink-0">{m.icon}</span>
                      <div>
                        <p className="text-sm font-semibold leading-tight">{m.label}</p>
                        <p className="text-xs opacity-70 mt-0.5">{m.desc}</p>
                      </div>
                    </button>
                  ))}
                </div>
              </div>

              {/* Start Mode selector */}
              <div>
                  <p className="text-xs text-muted-foreground uppercase tracking-wider mb-2 font-semibold">Start Mode</p>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    {[
                      { value: 'sequential', label: 'Sequential', desc: 'All groups from one hole in order' },
                      { value: 'shotgun', label: 'Shotgun', desc: 'All groups start simultaneously from different holes' },
                      { value: 'split_tee', label: 'Split-Tee', desc: 'Two simultaneous starting holes (e.g. 1 & 10)' },
                      { value: 'multi_hole', label: 'Multi-Hole', desc: '3–6 simultaneous starting holes' },
                    ].map(sm => (
                      <button
                        key={sm.value}
                        onClick={() => setStartMode(sm.value as 'sequential' | 'shotgun' | 'split_tee' | 'multi_hole')}
                        className={`flex flex-col gap-0.5 p-3 rounded-xl border text-left transition-all ${
                          startMode === sm.value
                            ? 'border-primary/50 bg-primary/10 text-white'
                            : 'border-white/10 bg-white/3 text-muted-foreground hover:border-white/20 hover:text-white'
                        }`}
                      >
                        <span className="text-sm font-semibold">{sm.label}</span>
                        <span className="text-xs opacity-70">{sm.desc}</span>
                      </button>
                    ))}
                  </div>
                  {/* Split-tee hole pickers */}
                  {startMode === 'split_tee' && (
                    <div className="flex gap-3 mt-3 items-end">
                      <div className="space-y-1">
                        <label className="text-xs text-muted-foreground font-medium">First Tee</label>
                        <select value={splitHole1} onChange={e => setSplitHole1(e.target.value)} className="bg-black/50 border border-white/10 text-white text-sm h-9 rounded-md px-2">
                          {Array.from({ length: 18 }, (_, i) => i + 1).map(h => (
                            <option key={h} value={h}>Hole {h}</option>
                          ))}
                        </select>
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs text-muted-foreground font-medium">Second Tee</label>
                        <select value={splitHole2} onChange={e => setSplitHole2(e.target.value)} className="bg-black/50 border border-white/10 text-white text-sm h-9 rounded-md px-2">
                          {Array.from({ length: 18 }, (_, i) => i + 1).map(h => (
                            <option key={h} value={h}>Hole {h}</option>
                          ))}
                        </select>
                      </div>
                      <p className="text-xs text-muted-foreground pb-2">Groups alternate between these two holes</p>
                    </div>
                  )}
                  {/* Multi-hole chip input */}
                  {startMode === 'multi_hole' && (
                    <div className="mt-3">
                      <p className="text-xs text-muted-foreground font-medium mb-2">Select 3–6 starting holes</p>
                      <div className="flex flex-wrap gap-2">
                        {Array.from({ length: 18 }, (_, i) => i + 1).map(h => {
                          const selected = multiHoles.includes(h);
                          return (
                            <button
                              key={h}
                              onClick={() => {
                                if (selected) {
                                  if (multiHoles.length > 3) setMultiHoles(multiHoles.filter(x => x !== h));
                                } else {
                                  if (multiHoles.length < 6) setMultiHoles([...multiHoles, h].sort((a, b) => a - b));
                                }
                              }}
                              className={`w-9 h-9 rounded-lg text-sm font-semibold border transition-all ${
                                selected
                                  ? 'bg-primary text-primary-foreground border-primary'
                                  : 'bg-white/5 text-muted-foreground border-white/10 hover:border-white/30 hover:text-white'
                              }`}
                            >
                              {h}
                            </button>
                          );
                        })}
                      </div>
                      <p className="text-xs text-muted-foreground mt-1">{multiHoles.length} holes selected: {multiHoles.join(', ')}</p>
                    </div>
                  )}
                </div>

              {/* Options grid */}
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
                <div className="space-y-1">
                  <label className="text-xs text-muted-foreground font-medium">Round</label>
                  <Input type="number" value={round} onChange={e => setRound(e.target.value)} min={1} max={8} className="bg-black/50 border-white/10 text-white text-sm h-9" />
                </div>
                <div className="space-y-1">
                  <label className="text-xs text-muted-foreground font-medium">Start Time</label>
                  <Input type="time" value={startTime} onChange={e => setStartTime(e.target.value)} className="bg-black/50 border-white/10 text-white text-sm h-9" />
                </div>
                {startMode !== 'shotgun' && (
                  <div className="space-y-1">
                    <label className="text-xs text-muted-foreground font-medium">Interval (min)</label>
                    <Input type="number" value={intervalMinutes} onChange={e => setIntervalMinutes(e.target.value)} min={5} max={30} className="bg-black/50 border-white/10 text-white text-sm h-9" />
                  </div>
                )}
                <div className="space-y-1">
                  <label className="text-xs text-muted-foreground font-medium">Group Size</label>
                  <Input type="number" value={groupSize} onChange={e => setGroupSize(e.target.value)} min={2} max={5} className="bg-black/50 border-white/10 text-white text-sm h-9" />
                </div>
                {startMode === 'sequential' && (
                  <div className="space-y-1">
                    <label className="text-xs text-muted-foreground font-medium">Starting Hole</label>
                    <Input type="number" value={startingHole} onChange={e => setStartingHole(e.target.value)} min={1} max={18} className="bg-black/50 border-white/10 text-white text-sm h-9" />
                  </div>
                )}
              </div>

              {startMode === 'shotgun' && (
                <p className="text-xs text-amber-400/80 bg-amber-400/10 border border-amber-400/20 rounded-md px-3 py-2">
                  <strong>Shotgun Start:</strong> All groups tee off simultaneously from assigned starting holes — no tee-time interval is used. Each group's starting hole is distributed evenly across the course.
                </p>
              )}

              {lockedGroupCount > 0 && (
                <p className="text-xs text-amber-400/90 bg-amber-400/10 border border-amber-400/20 rounded-md px-3 py-2 flex items-center gap-2">
                  <Lock className="w-3.5 h-3.5 shrink-0" />
                  <span><strong>{lockedGroupCount} manually-placed group{lockedGroupCount !== 1 ? 's' : ''}</strong> will be preserved during re-generate. Only unplaced players will be re-drawn.</span>
                </p>
              )}

              {/* Mode-specific config panels */}
              {(mode === 'by_results') && (
                <div className="space-y-3 p-4 rounded-xl border border-primary/20 bg-primary/5">
                  <p className="text-xs font-semibold text-primary uppercase tracking-wider">By Previous Results — Configuration</p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <label className="text-xs text-muted-foreground font-medium">Source Round (prior round to read leaderboard from)</label>
                      <Input type="number" value={sourceRound} onChange={e => setSourceRound(e.target.value)} min={1} max={8} className="bg-black/50 border-white/10 text-white text-sm h-9" />
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs text-muted-foreground font-medium">Tie-breaking Method</label>
                      <select value={tiebreakerMethod} onChange={e => setTiebreakerMethod(e.target.value as typeof tiebreakerMethod)} className="w-full h-9 rounded-md border border-white/10 bg-black/50 text-white px-2 text-sm">
                        <option value="alphabetical">Alphabetical</option>
                        <option value="random">Random</option>
                        <option value="previous_tee_time">Previous Tee Time Order</option>
                      </select>
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground">Players are ordered by Round {sourceRound} score. Leaders (best scores) are placed in the final group. Players without scores go first.</p>
                </div>
              )}

              {(mode === 'copy_round') && (
                <div className="space-y-3 p-4 rounded-xl border border-blue-500/20 bg-blue-500/5">
                  <p className="text-xs font-semibold text-blue-400 uppercase tracking-wider">Copy Previous Round — Configuration</p>
                  <div className="space-y-1">
                    <label className="text-xs text-muted-foreground font-medium">Source Round (to copy from)</label>
                    <Input type="number" value={sourceRound} onChange={e => setSourceRound(e.target.value)} min={1} max={8} className="bg-black/50 border-white/10 text-white text-sm h-9 w-32" />
                  </div>
                  <div className="flex flex-wrap gap-4">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input type="checkbox" checked={swapHoles} onChange={e => setSwapHoles(e.target.checked)} className="accent-blue-400 w-4 h-4" />
                      <span className="text-sm text-white">Swap starting holes (Hole 1 ↔ Hole 10)</span>
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input type="checkbox" checked={reverseTimes} onChange={e => setReverseTimes(e.target.checked)} className="accent-blue-400 w-4 h-4" />
                      <span className="text-sm text-white">Reverse tee time order (last group goes first)</span>
                    </label>
                  </div>
                  <p className="text-xs text-muted-foreground">All groups and their player assignments from Round {sourceRound} will be duplicated into Round {round}.</p>
                </div>
              )}

              {(mode === 'csv_upload') && (
                <div className="space-y-3 p-4 rounded-xl border border-emerald-500/20 bg-emerald-500/5">
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-semibold text-emerald-400 uppercase tracking-wider">CSV Upload — Import Pairings</p>
                    <a
                      href={`/api/organizations/${orgId}/tournaments/${tournamentId}/import-pairings/template`}
                      download="pairings-template.csv"
                      className="text-xs text-emerald-400 hover:text-emerald-300 flex items-center gap-1 border border-emerald-500/30 px-2 py-1 rounded-md hover:bg-emerald-500/10 transition-colors"
                    >
                      <Download className="w-3 h-3" /> Download Template
                    </a>
                  </div>
                  <div className="space-y-2">
                    <label className="text-xs text-muted-foreground font-medium">Upload CSV file</label>
                    <input type="file" accept=".csv,text/csv" onChange={handleCsvFileChange} className="block text-xs text-muted-foreground file:text-xs file:font-medium file:bg-emerald-600 file:text-white file:border-0 file:rounded file:px-3 file:py-1.5 file:mr-2 file:cursor-pointer hover:file:bg-emerald-700 cursor-pointer" />
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs text-muted-foreground font-medium">Or paste CSV content directly</label>
                    <textarea
                      value={csvText}
                      onChange={e => setCsvText(e.target.value)}
                      rows={5}
                      placeholder={`group_number,tee_time,starting_hole,player_name\n1,2024-01-01T08:00:00,1,John Smith\n1,2024-01-01T08:00:00,1,Jane Doe`}
                      className="w-full rounded-lg border border-white/10 bg-black/50 text-white text-xs px-3 py-2 font-mono resize-y focus:outline-none focus:border-emerald-500/50"
                    />
                  </div>
                  {csvErrors.length > 0 && (
                    <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20">
                      <p className="text-xs font-semibold text-red-400 mb-1">Unrecognised player names ({csvErrors.length}):</p>
                      <ul className="text-xs text-red-300 space-y-0.5">
                        {csvErrors.map((name, i) => <li key={i}>• {name}</li>)}
                      </ul>
                      <p className="text-xs text-muted-foreground mt-1">Check spelling against registered players and try again.</p>
                    </div>
                  )}
                  <p className="text-xs text-muted-foreground">Required columns: <code className="text-emerald-400">group_number</code>, <code className="text-emerald-400">player_name</code>. Optional: <code className="text-emerald-400">tee_time</code>, <code className="text-emerald-400">starting_hole</code>.</p>
                </div>
              )}

              {/* Action buttons — mode-aware */}
              <div className="flex flex-wrap gap-3 pt-1">
                {mode === 'manual' && (
                  <Button onClick={handleAddManualGroup} disabled={addingGroup} className="bg-primary hover:bg-primary/90 text-primary-foreground">
                    <Plus className="w-4 h-4 mr-2" /> {addingGroup ? 'Adding…' : 'Add Group Slot'}
                  </Button>
                )}
                {mode === 'copy_round' && (
                  <Button onClick={handleCopyRound} disabled={generating} className="bg-blue-600 hover:bg-blue-700 text-white">
                    <Copy className="w-4 h-4 mr-2" /> {generating ? 'Copying…' : `Copy Round ${sourceRound} → Round ${round}`}
                  </Button>
                )}
                {mode === 'csv_upload' && (
                  <Button onClick={handleCsvUpload} disabled={csvImporting || !csvText.trim()} className="bg-emerald-600 hover:bg-emerald-700 text-white">
                    <Upload className="w-4 h-4 mr-2" /> {csvImporting ? 'Importing…' : 'Import Pairings'}
                  </Button>
                )}
                {mode === 'by_results' && (
                  <>
                    <Button onClick={() => handleByResults(true)} disabled={generating} className="bg-primary hover:bg-primary/90 text-primary-foreground">
                      <Shuffle className="w-4 h-4 mr-2" /> {generating ? 'Generating…' : 'Fill Remaining by Results'}
                    </Button>
                    <Button onClick={() => roundTeeTimes.length > 0 ? setShowConfirmGenerateAll(true) : handleByResults(false)} disabled={generatingAll} variant="outline" className="bg-white/5 border-white/10 hover:bg-white/10 text-white">
                      <RefreshCw className="w-4 h-4 mr-2" /> {generatingAll ? 'Generating…' : 'Generate All by Results'}
                    </Button>
                  </>
                )}
                {!['manual', 'copy_round', 'csv_upload', 'by_results'].includes(mode) && (
                  <>
                    <Button onClick={handleFillRemaining} disabled={generating} className="bg-primary hover:bg-primary/90 text-primary-foreground">
                      <Shuffle className="w-4 h-4 mr-2" /> {generating ? 'Generating...' : 'Fill Remaining'}
                    </Button>
                    <Button
                      onClick={() => roundTeeTimes.length > 0 ? setShowConfirmGenerateAll(true) : handleGenerateAll()}
                      disabled={generatingAll}
                      variant="outline"
                      className="bg-white/5 border-white/10 hover:bg-white/10 text-white"
                    >
                      <RefreshCw className="w-4 h-4 mr-2" /> {generatingAll ? 'Generating...' : 'Generate All'}
                    </Button>
                  </>
                )}
                {roundTeeTimes.length > 0 && (
                  <>
                    <Button
                      onClick={() => setShowSetTeeTimes(v => !v)}
                      variant="outline"
                      className={showSetTeeTimes ? "bg-primary/10 border-primary/30 text-primary" : "bg-white/5 border-white/10 hover:bg-white/10 text-white"}
                    >
                      <Timer className="w-4 h-4 mr-2" /> Set Tee Times
                    </Button>
                    <Button
                      onClick={handlePublishPairings}
                      disabled={publishing || !!publishedAt}
                      variant="outline"
                      className={publishedAt ? "bg-green-500/10 border-green-500/30 text-green-400" : "bg-amber-500/10 border-amber-500/30 hover:bg-amber-500/20 text-amber-400"}
                    >
                      {publishing ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Publishing…</> : publishedAt ? <><CheckCircle className="w-4 h-4 mr-2" /> Published</> : <><Bell className="w-4 h-4 mr-2" /> Publish & Notify Players</>}
                    </Button>
                    <Button onClick={handlePrint} variant="outline" className="bg-white/5 border-white/10 hover:bg-white/10 text-white">
                      <Printer className="w-4 h-4 mr-2" /> Print Tee Sheet
                    </Button>
                    <Button onClick={handleClearAll} disabled={clearing} variant="ghost" className="text-destructive hover:bg-destructive/10">
                      <Trash2 className="w-4 h-4 mr-2" /> {clearing ? 'Clearing...' : 'Clear Draw'}
                    </Button>
                  </>
                )}
              </div>

              {/* Set Tee Times panel */}
              {showSetTeeTimes && roundTeeTimes.length > 0 && (
                <div className="p-4 rounded-xl border border-primary/20 bg-primary/5 space-y-3">
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-semibold text-primary uppercase tracking-wider flex items-center gap-2"><Timer className="w-3.5 h-3.5" /> Bulk Set Tee Times</p>
                    <button onClick={() => setShowSetTeeTimes(false)} className="text-muted-foreground hover:text-white p-1 rounded"><X className="w-3.5 h-3.5" /></button>
                  </div>
                  <p className="text-xs text-muted-foreground">Set a first tee time and interval — this applies sequential times to all {roundTeeTimes.length} group(s) in Round {round} in their current order.</p>
                  <div className="grid grid-cols-3 gap-3">
                    <div className="space-y-1">
                      <label className="text-xs text-muted-foreground font-medium">First Time</label>
                      <Input type="time" value={bulkFirstTime} onChange={e => setBulkFirstTime(e.target.value)} className="bg-black/50 border-white/10 text-white text-sm h-9" />
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs text-muted-foreground font-medium">Interval (min)</label>
                      <Input type="number" value={bulkInterval} onChange={e => setBulkInterval(e.target.value)} min={1} max={60} className="bg-black/50 border-white/10 text-white text-sm h-9" />
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs text-muted-foreground font-medium">Starting Hole</label>
                      <Input type="number" value={bulkStartingHole} onChange={e => setBulkStartingHole(e.target.value)} min={1} max={18} className="bg-black/50 border-white/10 text-white text-sm h-9" />
                    </div>
                  </div>
                  <Button onClick={handleBulkSetTimes} disabled={bulkApplying} className="bg-primary hover:bg-primary/90 text-primary-foreground">
                    <Timer className="w-4 h-4 mr-2" /> {bulkApplying ? 'Applying…' : `Apply to All ${roundTeeTimes.length} Groups`}
                  </Button>
                </div>
              )}

              {publishedAt && (
                <p className="text-xs text-green-400/70 mt-1">Tee times published on {new Date(publishedAt).toLocaleString()} — notifications sent to all players.</p>
              )}
            </CardContent>
          </Card>

          {/* Confirm Generate All dialog */}
          {showConfirmGenerateAll && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => setShowConfirmGenerateAll(false)}>
              <div className="bg-card border border-white/10 rounded-2xl p-6 max-w-sm w-full mx-4 shadow-2xl" onClick={e => e.stopPropagation()}>
                <h3 className="font-display font-bold text-white text-lg mb-2">Regenerate Full Draw?</h3>
                <p className="text-sm text-muted-foreground mb-4">This will delete all existing tee times for Round {round} — including any manually-placed (locked) groups — and generate a fresh draw for all players.</p>
                <div className="flex gap-3 justify-end">
                  <Button variant="ghost" onClick={() => setShowConfirmGenerateAll(false)} className="text-muted-foreground">Cancel</Button>
                  <Button
                    onClick={() => {
                      setShowConfirmGenerateAll(false);
                      if (mode === 'by_results') handleByResults(false);
                      else handleGenerateAll();
                    }}
                    disabled={generatingAll}
                    className="bg-destructive hover:bg-destructive/90 text-destructive-foreground"
                  >
                    {generatingAll ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Generating...</> : 'Yes, Regenerate All'}
                  </Button>
                </div>
              </div>
            </div>
          )}

          {/* Clear Draw dialog with scope selector */}
          {showClearDialog && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => setShowClearDialog(false)}>
              <div className="bg-card border border-white/10 rounded-2xl p-6 max-w-sm w-full mx-4 shadow-2xl" onClick={e => e.stopPropagation()}>
                <h3 className="font-display font-bold text-white text-lg mb-2 flex items-center gap-2"><Trash2 className="w-5 h-5 text-destructive" /> Clear Draw</h3>
                <p className="text-sm text-muted-foreground mb-4">Choose which tee times to delete. This cannot be undone.</p>
                <div className="space-y-2 mb-5">
                  <label className="flex items-start gap-3 p-3 rounded-xl border cursor-pointer transition-all border-white/10 hover:border-white/20">
                    <input type="radio" name="clearScope" value="round" checked={clearScope === 'round'} onChange={() => setClearScope('round')} className="mt-0.5 accent-primary" />
                    <div>
                      <p className="text-sm font-semibold text-white">Round {round} only</p>
                      <p className="text-xs text-muted-foreground">Delete all tee times for the currently selected round.</p>
                    </div>
                  </label>
                  <label className="flex items-start gap-3 p-3 rounded-xl border cursor-pointer transition-all border-white/10 hover:border-white/20">
                    <input type="radio" name="clearScope" value="all" checked={clearScope === 'all'} onChange={() => setClearScope('all')} className="mt-0.5 accent-primary" />
                    <div>
                      <p className="text-sm font-semibold text-white">All rounds</p>
                      <p className="text-xs text-muted-foreground">Delete every tee time for this tournament across all rounds.</p>
                    </div>
                  </label>
                </div>
                <div className="flex gap-3 justify-end">
                  <Button variant="ghost" onClick={() => setShowClearDialog(false)} className="text-muted-foreground">Cancel</Button>
                  <Button onClick={handleClearConfirm} disabled={clearing} className="bg-destructive hover:bg-destructive/90 text-destructive-foreground">
                    {clearing ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Clearing...</> : 'Clear Draw'}
                  </Button>
                </div>
              </div>
            </div>
          )}

          {/* Two-Panel Draw Builder */}
          <div className="grid grid-cols-1 lg:grid-cols-[280px_1fr] gap-4 items-start">
            {/* Left Panel: Player Pool */}
            <Card
              className={`glass-card sticky top-4 transition-all ${dragOverPool ? 'ring-2 ring-primary/60 bg-primary/5' : ''}`}
              onDragOver={e => { e.preventDefault(); setDragOverPool(true); }}
              onDragLeave={() => setDragOverPool(false)}
              onDrop={e => { e.preventDefault(); handleDropOnPool(); }}
            >
              <CardHeader className="pb-2">
                <CardTitle className="text-white text-sm flex items-center justify-between">
                  <span className="flex items-center gap-2"><Users className="w-4 h-4 text-primary" /> Player Pool</span>
                  <span className="text-xs font-normal text-muted-foreground">{unassignedPlayers.length} unassigned</span>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 pt-0">
                <Input
                  placeholder="Search players…"
                  value={poolSearch}
                  onChange={e => setPoolSearch(e.target.value)}
                  className="bg-black/50 border-white/10 text-white text-xs h-8"
                />
                {uniqueFlights.length > 0 && (
                  <select
                    value={poolFlightFilter}
                    onChange={e => setPoolFlightFilter(e.target.value)}
                    className="w-full h-8 rounded-md border border-white/10 bg-black/50 text-white px-2 text-xs focus:outline-none"
                  >
                    <option value="">All flights</option>
                    {uniqueFlights.map(f => <option key={f} value={f}>{f}</option>)}
                  </select>
                )}
                {dragOverPool && dragSourceTeeTimeId != null && (
                  <div className="text-xs text-primary text-center py-1 animate-pulse">Drop to return to pool</div>
                )}
                <div className="space-y-1 max-h-[520px] overflow-y-auto pr-1">
                  {filteredPoolPlayers.length === 0 ? (
                    <p className="text-xs text-muted-foreground italic text-center py-4">
                      {unassignedPlayers.length === 0 ? 'All players are assigned' : 'No players match filter'}
                    </p>
                  ) : (
                    filteredPoolPlayers.map(p => (
                      <div
                        key={p.id}
                        draggable
                        onDragStart={() => handlePlayerDragStart(p.id, null)}
                        onDragEnd={() => { setDraggedPlayerId(null); setDragSourceTeeTimeId(null); }}
                        className="flex items-center gap-2 text-sm bg-white/5 hover:bg-white/10 rounded-lg px-3 py-1.5 cursor-grab active:cursor-grabbing select-none border border-white/5 hover:border-white/15 transition-all"
                      >
                        <span className="text-white font-medium flex-1 min-w-0 truncate">{p.firstName} {p.lastName}</span>
                        {p.flight && <span className="text-xs text-primary bg-primary/10 px-1.5 py-0.5 rounded shrink-0">{p.flight}</span>}
                        {p.handicapIndex != null && <span className="text-xs text-muted-foreground font-mono shrink-0">{Number(p.handicapIndex).toFixed(1)}</span>}
                        <span className="text-muted-foreground/40 text-xs select-none shrink-0">⠿</span>
                      </div>
                    ))
                  )}
                </div>
              </CardContent>
            </Card>

            {/* Right Panel: Tee Sheet */}
            <div className="space-y-3">
              {/* Header bar */}
              <div className="flex flex-wrap justify-between items-center gap-3">
                <div>
                  <h2 className="font-display font-bold text-white text-lg">Official Tee Sheet</h2>
                  <p className="text-xs text-muted-foreground">Round {round} · {roundTeeTimes.length} groups{teeSheetHasMultipleHoles ? ` · ${teeSheetUniqueHoles.length} starting holes` : ''}</p>
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  {mode === 'manual' && roundTeeTimes.length > 0 && (
                    <Button size="sm" onClick={handleAddManualGroup} disabled={addingGroup} className="bg-primary hover:bg-primary/90 text-primary-foreground text-xs h-8">
                      <Plus className="w-3.5 h-3.5 mr-1.5" /> {addingGroup ? 'Adding…' : 'Add Group'}
                    </Button>
                  )}
                  {lockedGroupCount > 0 && (
                    <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-amber-400 bg-amber-400/10 border border-amber-400/20 px-2.5 py-1 rounded-full">
                      <Lock className="w-3 h-3" />{lockedGroupCount} group{lockedGroupCount !== 1 ? 's' : ''} locked
                    </span>
                  )}
                  {teeSheetHasMultipleHoles && (
                    <div className="flex gap-1 p-1 bg-black/40 border border-white/5 rounded-lg">
                      <button onClick={() => setTeeSheetView('time')} className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all ${teeSheetView === 'time' ? 'bg-white/10 text-white' : 'text-muted-foreground hover:text-white'}`}>By Time</button>
                      <button onClick={() => setTeeSheetView('hole')} className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all ${teeSheetView === 'hole' ? 'bg-white/10 text-white' : 'text-muted-foreground hover:text-white'}`}>By Hole</button>
                    </div>
                  )}
                </div>
              </div>

              {roundTeeTimes.length === 0 ? (
                <Card className="glass-panel border-dashed text-center p-12">
                  <GitBranch className="w-12 h-12 text-muted-foreground mx-auto mb-4 opacity-40" />
                  <h2 className="text-xl font-display text-white mb-2">No Draw Generated Yet</h2>
                  {mode === 'manual' ? (
                    <div className="space-y-3">
                      <p className="text-muted-foreground text-sm">Click "Add Group Slot" to create empty group slots, then drag players from the pool into them.</p>
                      <Button onClick={handleAddManualGroup} disabled={addingGroup} className="bg-primary hover:bg-primary/90 text-primary-foreground mx-auto">
                        <Plus className="w-4 h-4 mr-2" /> {addingGroup ? 'Adding…' : 'Add First Group Slot'}
                      </Button>
                    </div>
                  ) : (
                    <p className="text-muted-foreground text-sm">Drag players from the pool into groups, or use the method picker above to auto-generate.</p>
                  )}
                </Card>
              ) : (
                <Card className="glass-panel border-none overflow-hidden print:shadow-none print:border print:border-gray-300">
                  <div className="overflow-x-auto relative">
                    <div className="pointer-events-none absolute top-0 right-0 bottom-0 w-8 bg-gradient-to-l from-black/40 to-transparent z-10 print:hidden" />
                    <Table>
                      <TableHeader className="bg-black/40 hover:bg-black/40 print:bg-gray-100">
                        <TableRow className="border-white/5 sticky top-0 z-10 bg-[#0a1628] backdrop-blur-sm">
                          <TableHead className="text-muted-foreground font-semibold w-28 sticky left-0 z-10 bg-[#0a1628]">
                            <span className="print:hidden">Time <span className="text-xs font-normal opacity-60">(click to edit)</span></span>
                            <span className="hidden print:inline">Time</span>
                          </TableHead>
                          <TableHead className="text-muted-foreground font-semibold w-20">Hole</TableHead>
                          <TableHead className="text-muted-foreground font-semibold">Players (drag to rearrange)</TableHead>
                          <TableHead className="text-muted-foreground font-semibold w-14 text-center print:hidden">Lock</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {teeSheetView === 'hole' && teeSheetHasMultipleHoles
                          ? teeSheetUniqueHoles.map(holeNum => {
                              const holeGroups = teeSheetSorted.filter(tt => (tt.hole ?? 1) === holeNum);
                              return (
                                <React.Fragment key={`hole-section-${holeNum}`}>
                                  <TableRow className="border-white/5 bg-primary/5">
                                    <TableCell colSpan={4} className="py-2 px-4">
                                      <div className="flex items-center gap-2">
                                        <div className="h-px flex-1 bg-primary/20" />
                                        <span className="text-xs font-bold text-primary uppercase tracking-widest">Hole {holeNum}</span>
                                        <div className="h-px flex-1 bg-primary/20" />
                                      </div>
                                    </TableCell>
                                  </TableRow>
                                  {holeGroups.map((tt, idx) => (
                                    <TableRow
                                      key={tt.id}
                                      className={`border-white/5 transition-all ${dragOverTeeTimeId === tt.id ? 'bg-primary/10 ring-1 ring-inset ring-primary/40' : tt.isManual ? 'bg-amber-500/5 hover:bg-amber-500/10' : idx % 2 === 0 ? 'hover:bg-white/[0.02]' : 'bg-white/[0.01] hover:bg-white/[0.03]'}`}
                                      onDragOver={e => { e.preventDefault(); setDragOverTeeTimeId(tt.id); }}
                                      onDragLeave={() => { if (dragOverTeeTimeId === tt.id) setDragOverTeeTimeId(null); }}
                                      onDrop={e => { e.preventDefault(); handleDropOnTeeTime(tt.id); }}
                                    >
                                      <TableCell className="font-mono font-semibold text-white">
                                        <span className="hidden print:inline">{new Date(tt.teeTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                                        <span className="print:hidden">
                                          {editingTeeTimeId === tt.id ? (
                                            <span className="flex items-center gap-1">
                                              <input aria-label="Tee time" type="time" value={editTimeValue} onChange={e => setEditTimeValue(e.target.value)} className="bg-white/10 border border-white/20 rounded px-1.5 py-0.5 text-xs text-white font-mono w-24" />
                                              <button aria-label="Save tee time" onClick={() => handleSaveTeeTimeEdit(tt.id)} disabled={savingTeeTimeEdit} className="text-emerald-300 hover:text-emerald-200 text-xs px-1"><span aria-hidden="true">✓</span></button>
                                              <button aria-label="Cancel tee time edit" onClick={() => setEditingTeeTimeId(null)} className="text-muted-foreground hover:text-white text-xs px-1"><span aria-hidden="true">✕</span></button>
                                            </span>
                                          ) : (
                                            <button aria-label={`Edit tee time (currently ${new Date(tt.teeTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })})`} onClick={() => handleStartEditTeeTime(tt)} title="Click to edit time" className="font-mono font-semibold text-white hover:text-primary transition-colors group">
                                              {new Date(tt.teeTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                              <span aria-hidden="true" className="text-muted-foreground/0 group-hover:text-muted-foreground/60 text-xs ml-1">✎</span>
                                            </button>
                                          )}
                                        </span>
                                      </TableCell>
                                      <TableCell>
                                        {editingTeeTimeId === tt.id ? (
                                          <span className="flex items-center gap-1 print:hidden">
                                            <input aria-label="Starting hole" type="number" min={1} max={18} value={editHoleValue} onChange={e => setEditHoleValue(e.target.value)} className="bg-white/10 border border-white/20 rounded px-1.5 py-0.5 text-xs text-white w-16" />
                                          </span>
                                        ) : (
                                          <button aria-label={`Edit starting hole (currently hole ${tt.hole})`} onClick={() => handleStartEditTeeTime(tt)} title="Click to edit hole" className="hover:opacity-80 transition-opacity print:cursor-default">
                                            <Badge variant="outline" className="border-primary/30 text-primary bg-primary/10 w-14 justify-center">Hole {tt.hole}</Badge>
                                          </button>
                                        )}
                                      </TableCell>
                                      <TableCell>
                                        <div className="flex flex-wrap gap-1.5 min-h-[32px] items-center">
                                          {(tt.players?.length ?? 0) === 0 && dragOverTeeTimeId !== tt.id && (
                                            <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground/60 px-3 py-1.5 border border-dashed border-white/10 rounded-lg italic">
                                              <Users className="w-3 h-3" /> Empty slot — drag players here
                                            </span>
                                          )}
                                          {tt.players?.map((p) => (
                                            <span
                                              key={p.playerId}
                                              draggable
                                              onDragStart={() => handlePlayerDragStart(p.playerId, tt.id)}
                                              onDragEnd={() => { setDraggedPlayerId(null); setDragSourceTeeTimeId(null); setDragOverPlayerId(null); }}
                                              onDragOver={e => { e.preventDefault(); e.stopPropagation(); if (draggedPlayerId != null && draggedPlayerId !== p.playerId && dragSourceTeeTimeId !== tt.id) setDragOverPlayerId(p.playerId); }}
                                              onDragLeave={() => { if (dragOverPlayerId === p.playerId) setDragOverPlayerId(null); }}
                                              onDrop={e => { e.preventDefault(); e.stopPropagation(); handleDropOnPlayerChip(tt.id, p.playerId); }}
                                              className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-sm font-medium text-white border cursor-grab active:cursor-grabbing select-none transition-all ${dragOverPlayerId === p.playerId ? 'bg-primary/20 border-primary/60 ring-1 ring-primary/40 scale-105' : 'bg-white/8 hover:bg-white/15 border-white/8'}`}
                                            >
                                              {p.firstName} {p.lastName}
                                              {p.flight && <span className="text-xs text-primary bg-primary/10 px-1 py-0.5 rounded">{p.flight}</span>}
                                              {p.handicapIndex != null && <span className="text-xs text-muted-foreground font-mono">{Number(p.handicapIndex).toFixed(1)}</span>}
                                              {dragOverPlayerId === p.playerId && <span className="text-xs text-primary font-semibold">⇄</span>}
                                            </span>
                                          ))}
                                          {dragOverTeeTimeId === tt.id && draggedPlayerId != null && dragSourceTeeTimeId !== tt.id && dragOverPlayerId == null && (
                                            <span className="inline-flex items-center text-xs text-primary animate-pulse px-2 py-1 border border-dashed border-primary/40 rounded-lg">Drop here</span>
                                          )}
                                          {tt.isManual && <span className="inline-flex items-center gap-1 text-xs font-semibold text-amber-400 bg-amber-400/10 border border-amber-400/20 px-2 py-0.5 rounded-full print:hidden ml-1"><Lock className="w-2.5 h-2.5" />Manual</span>}
                                        </div>
                                      </TableCell>
                                      <TableCell className="text-center print:hidden">
                                        <div className="flex items-center justify-center gap-1">
                                          <button
                                            onClick={() => handleToggleLock(tt.id)}
                                            title={tt.isManual ? 'Unlock group (allow re-draw)' : 'Lock group (preserve on re-draw)'}
                                            className={`p-1.5 rounded-md transition-all ${tt.isManual ? 'text-amber-400 bg-amber-400/10 hover:bg-amber-400/20' : 'text-muted-foreground hover:text-white hover:bg-white/10'}`}
                                          >
                                            {tt.isManual ? <Lock className="w-3.5 h-3.5" /> : <LockOpen className="w-3.5 h-3.5" />}
                                          </button>
                                          {(tt.players?.length ?? 0) === 0 && (
                                            <button
                                              onClick={async () => {
                                                const res = await fetch(`/api/organizations/${orgId}/tournaments/${tournamentId}/tee-times/${tt.id}`, { method: 'DELETE', credentials: 'include' });
                                                if (res.ok) refetch();
                                              }}
                                              title="Delete empty group slot"
                                              className="p-1.5 rounded-md transition-all text-muted-foreground hover:text-red-400 hover:bg-red-400/10"
                                            >
                                              <Trash2 className="w-3.5 h-3.5" />
                                            </button>
                                          )}
                                        </div>
                                      </TableCell>
                                    </TableRow>
                                  ))}
                                </React.Fragment>
                              );
                            })
                          : teeSheetSorted.map((tt, idx) => (
                              <TableRow
                                key={tt.id}
                                className={`border-white/5 transition-all ${dragOverTeeTimeId === tt.id ? 'bg-primary/10 ring-1 ring-inset ring-primary/40' : tt.isManual ? 'bg-amber-500/5 hover:bg-amber-500/10' : idx % 2 === 0 ? 'hover:bg-white/[0.02]' : 'bg-white/[0.01] hover:bg-white/[0.03]'}`}
                                onDragOver={e => { e.preventDefault(); setDragOverTeeTimeId(tt.id); }}
                                onDragLeave={() => { if (dragOverTeeTimeId === tt.id) setDragOverTeeTimeId(null); }}
                                onDrop={e => { e.preventDefault(); handleDropOnTeeTime(tt.id); }}
                              >
                                <TableCell className="font-mono font-semibold text-white">
                                  <span className="hidden print:inline">{new Date(tt.teeTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                                  <span className="print:hidden">
                                    {editingTeeTimeId === tt.id ? (
                                      <span className="flex items-center gap-1">
                                        <input aria-label="Tee time" type="time" value={editTimeValue} onChange={e => setEditTimeValue(e.target.value)} className="bg-white/10 border border-white/20 rounded px-1.5 py-0.5 text-xs text-white font-mono w-24" />
                                        <button aria-label="Save tee time" onClick={() => handleSaveTeeTimeEdit(tt.id)} disabled={savingTeeTimeEdit} className="text-emerald-300 hover:text-emerald-200 text-xs px-1"><span aria-hidden="true">✓</span></button>
                                        <button aria-label="Cancel tee time edit" onClick={() => setEditingTeeTimeId(null)} className="text-muted-foreground hover:text-white text-xs px-1"><span aria-hidden="true">✕</span></button>
                                      </span>
                                    ) : (
                                      <button aria-label={`Edit tee time (currently ${new Date(tt.teeTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })})`} onClick={() => handleStartEditTeeTime(tt)} title="Click to edit time" className="font-mono font-semibold text-white hover:text-primary transition-colors group">
                                        {new Date(tt.teeTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                        <span aria-hidden="true" className="text-muted-foreground/0 group-hover:text-muted-foreground/60 text-xs ml-1">✎</span>
                                      </button>
                                    )}
                                  </span>
                                </TableCell>
                                <TableCell>
                                  {editingTeeTimeId === tt.id ? (
                                    <span className="flex items-center gap-1 print:hidden">
                                      <input aria-label="Starting hole" type="number" min={1} max={18} value={editHoleValue} onChange={e => setEditHoleValue(e.target.value)} className="bg-white/10 border border-white/20 rounded px-1.5 py-0.5 text-xs text-white w-16" />
                                    </span>
                                  ) : (
                                    <button aria-label={`Edit starting hole (currently hole ${tt.hole})`} onClick={() => handleStartEditTeeTime(tt)} title="Click to edit hole" className="hover:opacity-80 transition-opacity print:cursor-default">
                                      <Badge variant="outline" className="border-primary/30 text-primary bg-primary/10 w-14 justify-center">Hole {tt.hole}</Badge>
                                    </button>
                                  )}
                                </TableCell>
                                <TableCell>
                                  <div className="flex flex-wrap gap-1.5 min-h-[32px] items-center">
                                    {(tt.players?.length ?? 0) === 0 && dragOverTeeTimeId !== tt.id && (
                                      <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground/60 px-3 py-1.5 border border-dashed border-white/10 rounded-lg italic">
                                        <Users className="w-3 h-3" /> Empty slot — drag players here
                                      </span>
                                    )}
                                    {tt.players?.map((p) => (
                                      <span
                                        key={p.playerId}
                                        draggable
                                        onDragStart={() => handlePlayerDragStart(p.playerId, tt.id)}
                                        onDragEnd={() => { setDraggedPlayerId(null); setDragSourceTeeTimeId(null); setDragOverPlayerId(null); }}
                                        onDragOver={e => { e.preventDefault(); e.stopPropagation(); if (draggedPlayerId != null && draggedPlayerId !== p.playerId && dragSourceTeeTimeId !== tt.id) setDragOverPlayerId(p.playerId); }}
                                        onDragLeave={() => { if (dragOverPlayerId === p.playerId) setDragOverPlayerId(null); }}
                                        onDrop={e => { e.preventDefault(); e.stopPropagation(); handleDropOnPlayerChip(tt.id, p.playerId); }}
                                        className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-sm font-medium text-white border cursor-grab active:cursor-grabbing select-none transition-all ${dragOverPlayerId === p.playerId ? 'bg-primary/20 border-primary/60 ring-1 ring-primary/40 scale-105' : 'bg-white/8 hover:bg-white/15 border-white/8'}`}
                                      >
                                        {p.firstName} {p.lastName}
                                        {p.flight && <span className="text-xs text-primary bg-primary/10 px-1 py-0.5 rounded">{p.flight}</span>}
                                        {p.handicapIndex != null && <span className="text-xs text-muted-foreground font-mono">{Number(p.handicapIndex).toFixed(1)}</span>}
                                        {dragOverPlayerId === p.playerId && <span className="text-xs text-primary font-semibold">⇄</span>}
                                      </span>
                                    ))}
                                    {dragOverTeeTimeId === tt.id && draggedPlayerId != null && dragSourceTeeTimeId !== tt.id && dragOverPlayerId == null && (
                                      <span className="inline-flex items-center text-xs text-primary animate-pulse px-2 py-1 border border-dashed border-primary/40 rounded-lg">Drop here</span>
                                    )}
                                    {tt.isManual && <span className="inline-flex items-center gap-1 text-xs font-semibold text-amber-400 bg-amber-400/10 border border-amber-400/20 px-2 py-0.5 rounded-full print:hidden ml-1"><Lock className="w-2.5 h-2.5" />Manual</span>}
                                  </div>
                                </TableCell>
                                <TableCell className="text-center print:hidden">
                                  <div className="flex items-center justify-center gap-1">
                                    <button
                                      onClick={() => handleToggleLock(tt.id)}
                                      title={tt.isManual ? 'Unlock group (allow re-draw)' : 'Lock group (preserve on re-draw)'}
                                      className={`p-1.5 rounded-md transition-all ${tt.isManual ? 'text-amber-400 bg-amber-400/10 hover:bg-amber-400/20' : 'text-muted-foreground hover:text-white hover:bg-white/10'}`}
                                    >
                                      {tt.isManual ? <Lock className="w-3.5 h-3.5" /> : <LockOpen className="w-3.5 h-3.5" />}
                                    </button>
                                    {(tt.players?.length ?? 0) === 0 && (
                                      <button
                                        onClick={async () => {
                                          const res = await fetch(`/api/organizations/${orgId}/tournaments/${tournamentId}/tee-times/${tt.id}`, { method: 'DELETE', credentials: 'include' });
                                          if (res.ok) refetch();
                                        }}
                                        title="Delete empty group slot"
                                        className="p-1.5 rounded-md transition-all text-muted-foreground hover:text-red-400 hover:bg-red-400/10"
                                      >
                                        <Trash2 className="w-3.5 h-3.5" />
                                      </button>
                                    )}
                                  </div>
                                </TableCell>
                              </TableRow>
                            ))
                        }
                      </TableBody>
                    </Table>
                  </div>
                </Card>
              )}
            </div>
          </div>
        </>
      )}

      {subTab === 'bracket' && isMatchPlay && (
        <MatchBracketTab orgId={orgId} tournamentId={tournamentId} />
      )}
    </div>
  );
}

/* ─── Match Bracket Tab ──────────────────────────────────────────── */

type MatchPlayer = { id: number; firstName: string; lastName: string };
type MatchResult = {
  id: number; tournamentId: number; round: number;
  player1Id: number; player2Id: number; winnerId: number | null;
  result: string | null; player1Holes: number | null; player2Holes: number | null;
  notes: string | null; isComplete: boolean;
  player1?: MatchPlayer | null; player2?: MatchPlayer | null; winner?: MatchPlayer | null;
};

function MatchBracketTab({ orgId, tournamentId }: { orgId: number; tournamentId: number }) {
  const { toast } = useToast();
  const [matches, setMatches] = useState<MatchResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [round, setRound] = useState(1);
  const [generating, setGenerating] = useState(false);
  const [editMatch, setEditMatch] = useState<MatchResult | null>(null);
  const [editWinner, setEditWinner] = useState('');
  const [editResult, setEditResult] = useState('');
  const [editP1H, setEditP1H] = useState('');
  const [editP2H, setEditP2H] = useState('');
  const [saving, setSaving] = useState(false);

  const loadMatches = async (r?: number) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/organizations/${orgId}/tournaments/${tournamentId}/match-results?round=${r ?? round}`, { credentials: 'include' });
      if (res.ok) setMatches(await res.json());
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadMatches(); }, [round]);

  const handleGenerate = async () => {
    setGenerating(true);
    try {
      const res = await fetch(`/api/organizations/${orgId}/tournaments/${tournamentId}/match-results/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ round }),
      });
      if (!res.ok) {
        const d = await res.json();
        toast({ title: d.error || 'Failed to generate bracket', variant: 'destructive' });
      } else {
        toast({ title: `Round ${round} bracket generated!` });
        loadMatches();
      }
    } catch {
      toast({ title: 'Failed to generate', variant: 'destructive' });
    } finally {
      setGenerating(false);
    }
  };

  const openEdit = (match: MatchResult) => {
    setEditMatch(match);
    setEditWinner(match.winnerId ? String(match.winnerId) : '');
    setEditResult(match.result ?? '');
    setEditP1H(match.player1Holes != null ? String(match.player1Holes) : '');
    setEditP2H(match.player2Holes != null ? String(match.player2Holes) : '');
  };

  const handleSaveResult = async () => {
    if (!editMatch) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/organizations/${orgId}/tournaments/${tournamentId}/match-results/${editMatch.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          winnerId: editWinner ? parseInt(editWinner) : null,
          result: editResult || null,
          player1Holes: editP1H ? parseInt(editP1H) : null,
          player2Holes: editP2H ? parseInt(editP2H) : null,
        }),
      });
      if (!res.ok) throw new Error();
      const data = await res.json();
      if (data.nextRound?.length > 0) {
        toast({ title: `Round ${editMatch.round + 1} bracket generated automatically!` });
        const nextR = editMatch.round + 1;
        setRound(nextR);
        setEditMatch(null);
        loadMatches(nextR);
      } else {
        toast({ title: 'Match result saved' });
        setEditMatch(null);
        loadMatches();
      }
    } catch {
      toast({ title: 'Failed to save result', variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-2">
          <label className="text-sm text-muted-foreground font-medium">Round</label>
          <div className="flex gap-1">
            {[1, 2, 3, 4, 5].map(r => (
              <button
                key={r}
                onClick={() => setRound(r)}
                className={`w-8 h-8 rounded-lg text-sm font-semibold transition-colors ${round === r ? 'bg-primary text-primary-foreground' : 'bg-white/5 text-muted-foreground hover:bg-white/10 hover:text-white'}`}
              >
                {r}
              </button>
            ))}
          </div>
        </div>
        <Button onClick={handleGenerate} disabled={generating} className="bg-primary hover:bg-primary/90 text-primary-foreground">
          <GitBranch className="w-4 h-4 mr-2" /> {generating ? 'Generating...' : 'Generate Bracket'}
        </Button>
        <p className="text-xs text-muted-foreground">Seeds players by handicap (lowest vs highest)</p>
      </div>

      {loading ? (
        <div className="h-32 flex items-center justify-center">
          <div className="w-6 h-6 rounded-full border-4 border-primary border-t-transparent animate-spin" />
        </div>
      ) : matches.length === 0 ? (
        <Card className="glass-panel border-dashed text-center p-12">
          <GitBranch className="w-12 h-12 text-muted-foreground mx-auto mb-4 opacity-40" />
          <h2 className="text-xl font-display text-white mb-2">No Bracket for Round {round}</h2>
          <p className="text-muted-foreground text-sm">Click "Generate Bracket" to seed matches from player handicaps.</p>
        </Card>
      ) : (
        <div className="space-y-3">
          <div className="flex justify-between items-center">
            <p className="text-sm text-muted-foreground">{matches.length} matches · Round {round}</p>
            <p className="text-xs text-muted-foreground">{matches.filter(m => m.isComplete).length} complete</p>
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            {matches.map((match, idx) => (
              <Card key={match.id} className={`glass-card overflow-hidden ${match.isComplete ? 'border-primary/20' : ''}`}>
                <div className="p-4">
                  <div className="flex items-center justify-between mb-3">
                    <span className="text-xs text-muted-foreground font-semibold uppercase tracking-wider">Match {idx + 1}</span>
                    {match.isComplete ? (
                      <Badge className="bg-primary/20 text-primary border-primary/30">Complete</Badge>
                    ) : (
                      <Badge className="bg-white/10 text-muted-foreground border-white/10">Pending</Badge>
                    )}
                  </div>
                  <div className="space-y-2">
                    {[
                      { player: match.player1, holes: match.player1Holes, isWinner: match.winnerId === match.player1Id },
                      { player: match.player2, holes: match.player2Holes, isWinner: match.winnerId === match.player2Id },
                    ].map(({ player, holes, isWinner }, pi) => (
                      <div key={pi} className={`flex items-center justify-between px-3 py-2 rounded-lg ${isWinner ? 'bg-primary/15 border border-primary/30' : 'bg-white/5'}`}>
                        <div className="flex items-center gap-2">
                          {isWinner && <Trophy className="w-3.5 h-3.5 text-primary shrink-0" />}
                          <span className={`font-medium text-sm ${isWinner ? 'text-primary' : 'text-white'}`}>
                            {player ? `${player.firstName} ${player.lastName}` : 'Unknown'}
                          </span>
                        </div>
                        {holes != null && (
                          <span className={`text-sm font-bold ${isWinner ? 'text-primary' : 'text-muted-foreground'}`}>{holes}&nbsp;up</span>
                        )}
                      </div>
                    ))}
                  </div>
                  {match.result && (
                    <p className="text-xs text-muted-foreground mt-2 text-center capitalize">{match.result.replace(/_/g, ' ')}</p>
                  )}
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => openEdit(match)}
                    className="w-full mt-3 border-white/10 bg-white/5 hover:bg-white/10 text-white text-xs"
                  >
                    {match.isComplete ? 'Edit Result' : 'Record Result'}
                  </Button>
                </div>
              </Card>
            ))}
          </div>
        </div>
      )}

      {/* Edit match dialog */}
      <Dialog open={!!editMatch} onOpenChange={v => !v && setEditMatch(null)}>
        <DialogContent className="glass-panel border-white/10 sm:max-w-[400px]">
          <DialogHeader>
            <DialogTitle className="text-white font-display">Record Match Result</DialogTitle>
          </DialogHeader>
          {editMatch && (
            <div className="space-y-4 mt-2">
              <div className="space-y-1.5">
                <label className="text-sm font-medium text-white">Winner</label>
                <Select value={editWinner || '__none__'} onValueChange={(v) => setEditWinner(v === '__none__' ? '' : v)}>
                  <SelectTrigger className="bg-black/50 border-white/10 text-white">
                    <SelectValue placeholder="Select winner..." />
                  </SelectTrigger>
                  <SelectContent className="bg-card border-white/10 text-white">
                    <SelectItem value="__none__">No winner (pending)</SelectItem>
                    {editMatch.player1 && <SelectItem value={String(editMatch.player1Id)}>{editMatch.player1.firstName} {editMatch.player1.lastName}</SelectItem>}
                    {editMatch.player2 && <SelectItem value={String(editMatch.player2Id)}>{editMatch.player2.firstName} {editMatch.player2.lastName}</SelectItem>}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium text-white">Result Type</label>
                <Select value={editResult} onValueChange={setEditResult}>
                  <SelectTrigger className="bg-black/50 border-white/10 text-white">
                    <SelectValue placeholder="Select result..." />
                  </SelectTrigger>
                  <SelectContent className="bg-card border-white/10 text-white">
                    <SelectItem value="won">Won outright</SelectItem>
                    <SelectItem value="conceded">Conceded</SelectItem>
                    <SelectItem value="halved">Halved (tied)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <label className="text-xs text-muted-foreground font-medium">{editMatch.player1?.firstName} Holes Up</label>
                  <Input type="number" value={editP1H} onChange={e => setEditP1H(e.target.value)} min={0} max={18} placeholder="e.g. 3" className="bg-black/50 border-white/10 text-white" />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs text-muted-foreground font-medium">{editMatch.player2?.firstName} Holes Up</label>
                  <Input type="number" value={editP2H} onChange={e => setEditP2H(e.target.value)} min={0} max={18} placeholder="e.g. 0" className="bg-black/50 border-white/10 text-white" />
                </div>
              </div>
              <div className="flex justify-end gap-3 pt-1">
                <Button variant="ghost" onClick={() => setEditMatch(null)} className="text-white hover:bg-white/5">Cancel</Button>
                <Button onClick={handleSaveResult} disabled={saving} className="bg-primary hover:bg-primary/90 text-primary-foreground">
                  {saving ? 'Saving...' : 'Save Result'}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

/* ─── Side Games Tab ──────────────────────────────────────────────── */

type SideGameConfig = {
  skinsEnabled: boolean; ctpEnabled: boolean; ldEnabled: boolean; greeniesEnabled: boolean;
  skinsPrize: number | null; ctpPrize: number | null; ldPrize: number | null; greeniesPrize: number | null;
  ctpHoles: number[]; ldHoles: number[];
  ctpSponsorId: number | null; ldSponsorId: number | null;
};
type SideGameResult = { id: number; gameType: string; holeNumber: number | null; playerId: number; firstName?: string | null; lastName?: string | null; prize: number | null; notes: string | null };
type SkinResult = { hole: number; round: number; winnerId: number | null; winnerName: string | null; winnerScore: number | null; tied: boolean; carriedFrom: number | null };

type CourseHole = { holeNumber: number; par: number; handicap?: number | null };

function SideGamesTab({ orgId, tournamentId }: { orgId: number; tournamentId: number }) {
  const { toast } = useToast();
  const baseUrl = (import.meta.env.BASE_URL ?? '/').replace(/\/$/, '');
  const [config, setConfig] = useState<SideGameConfig>({ skinsEnabled: false, ctpEnabled: false, ldEnabled: false, greeniesEnabled: false, skinsPrize: null, ctpPrize: null, ldPrize: null, greeniesPrize: null, ctpHoles: [], ldHoles: [], ctpSponsorId: null, ldSponsorId: null });
  const [results, setResults] = useState<SideGameResult[]>([]);
  const [skins, setSkins] = useState<SkinResult[]>([]);
  const [players, setPlayers] = useState<Array<{ id: number; firstName: string; lastName: string }>>([]);
  const [courseHoles, setCourseHoles] = useState<CourseHole[]>([]);
  const [sponsors, setSponsors] = useState<Array<{ id: number; name: string; tier: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [awardType, setAwardType] = useState<'ctp' | 'ld' | 'greenie'>('ctp');
  const [awardHole, setAwardHole] = useState('');
  const [awardPlayer, setAwardPlayer] = useState('');
  const [awardNotes, setAwardNotes] = useState('');

  const load = async () => {
    setLoading(true);
    try {
      const [cfgRes, resRes, plRes, tmtRes, spRes] = await Promise.all([
        fetch(`${baseUrl}/api/organizations/${orgId}/tournaments/${tournamentId}/side-games/config`, { credentials: 'include' }),
        fetch(`${baseUrl}/api/organizations/${orgId}/tournaments/${tournamentId}/side-games/results`, { credentials: 'include' }),
        fetch(`${baseUrl}/api/organizations/${orgId}/tournaments/${tournamentId}/players`, { credentials: 'include' }),
        fetch(`${baseUrl}/api/organizations/${orgId}/tournaments/${tournamentId}`, { credentials: 'include' }),
        fetch(`${baseUrl}/api/organizations/${orgId}/tournaments/${tournamentId}/side-games/config/sponsors`, { credentials: 'include' }),
      ]);
      if (cfgRes.ok) { const d = await cfgRes.json(); setConfig(prev => ({ ...prev, ...d, ctpSponsorId: d.ctpSponsorId ?? null, ldSponsorId: d.ldSponsorId ?? null })); }
      if (resRes.ok) { const d = await resRes.json(); setResults(d.manual ?? []); setSkins(d.skins ?? []); }
      if (plRes.ok) { const d = await plRes.json(); setPlayers(d); }
      if (spRes.ok) { const d = await spRes.json(); setSponsors(d); }
      if (tmtRes.ok) {
        const tmt = await tmtRes.json();
        if (tmt.courseId) {
          const crsRes = await fetch(`${baseUrl}/api/organizations/${orgId}/courses/${tmt.courseId}`, { credentials: 'include' });
          if (crsRes.ok) {
            const crs = await crsRes.json();
            if (crs.holeDetails?.length) setCourseHoles(crs.holeDetails);
          }
        }
      }
    } catch { /* ignore */ } finally { setLoading(false); }
  };

  useEffect(() => { load(); }, [orgId, tournamentId]);

  const saveConfig = async () => {
    setSaving(true);
    const res = await fetch(`${baseUrl}/api/organizations/${orgId}/tournaments/${tournamentId}/side-games/config`, {
      method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(config),
    });
    setSaving(false);
    if (res.ok) toast({ title: 'Side games config saved' });
    else toast({ title: 'Failed to save config', variant: 'destructive' });
  };

  const awardResult = async () => {
    if (!awardPlayer) { toast({ title: 'Select a player', variant: 'destructive' }); return; }
    const res = await fetch(`${baseUrl}/api/organizations/${orgId}/tournaments/${tournamentId}/side-games/results`, {
      method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gameType: awardType, holeNumber: awardHole ? parseInt(awardHole) : null, playerId: parseInt(awardPlayer), notes: awardNotes || null }),
    });
    if (res.ok) { toast({ title: 'Award recorded' }); setAwardPlayer(''); setAwardHole(''); setAwardNotes(''); load(); }
    else toast({ title: 'Failed to record award', variant: 'destructive' });
  };

  const deleteResult = async (id: number) => {
    await fetch(`${baseUrl}/api/organizations/${orgId}/tournaments/${tournamentId}/side-games/results/${id}`, { method: 'DELETE', credentials: 'include' });
    load();
  };

  if (loading) return <div className="flex justify-center py-16"><div className="w-8 h-8 rounded-full border-4 border-yellow-400 border-t-transparent animate-spin" /></div>;

  const ctpResults = results.filter(r => r.gameType === 'ctp');
  const ldResults = results.filter(r => r.gameType === 'ld');
  const greenieResults = results.filter(r => r.gameType === 'greenie');

  return (
    <div className="space-y-6">
      <Card className="glass-panel border-none">
        <div className="p-6 border-b border-white/5 flex items-center justify-between">
          <CardTitle className="text-white flex items-center gap-2"><Trophy className="w-4 h-4 text-yellow-400" /> Side Games Configuration</CardTitle>
          <Button size="sm" onClick={saveConfig} disabled={saving} className="bg-yellow-500/20 hover:bg-yellow-500/30 text-yellow-400 border border-yellow-500/30">
            {saving ? 'Saving...' : 'Save Config'}
          </Button>
        </div>
        <div className="p-6 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          {([
            { key: 'skinsEnabled' as const, prizeKey: 'skinsPrize' as const, label: 'Skins', desc: 'Auto-calculated per hole. Ties carry over.', holesKey: null, sponsorKey: null },
            { key: 'ctpEnabled' as const, prizeKey: 'ctpPrize' as const, label: 'Closest to Pin', desc: 'Award CTP winner per par-3 only.', holesKey: 'ctpHoles' as const, sponsorKey: 'ctpSponsorId' as const },
            { key: 'ldEnabled' as const, prizeKey: 'ldPrize' as const, label: 'Longest Drive', desc: 'Award LD winner per designated hole.', holesKey: 'ldHoles' as const, sponsorKey: 'ldSponsorId' as const },
            { key: 'greeniesEnabled' as const, prizeKey: 'greeniesPrize' as const, label: 'Greenie', desc: 'GIR on a par-3 closest to pin + 1-putt.', holesKey: null, sponsorKey: null },
          ]).map(({ key, prizeKey, label, desc, holesKey, sponsorKey }) => {
            const eligibleHoles = holesKey === 'ctpHoles'
              ? courseHoles.filter(h => h.par === 3)
              : courseHoles;
            const selectedHoles: number[] = holesKey ? (config[holesKey] ?? []) : [];
            const toggleHole = (holeNum: number) => {
              if (!holesKey) return;
              setConfig(c => {
                const cur = (c[holesKey] ?? []) as number[];
                return { ...c, [holesKey]: cur.includes(holeNum) ? cur.filter(h => h !== holeNum) : [...cur, holeNum].sort((a, b) => a - b) };
              });
            };
            return (
            <div key={key} className={`rounded-xl p-4 border transition-all ${config[key] ? 'border-yellow-500/40 bg-yellow-500/5' : 'border-white/5 bg-white/5'}`}>
              <div className="flex items-center justify-between mb-2">
                <span className="font-semibold text-white text-sm">{label}</span>
                <button
                  onClick={() => setConfig(c => ({ ...c, [key]: !c[key] }))}
                  className={`w-10 h-5 rounded-full transition-colors relative ${config[key] ? 'bg-yellow-500' : 'bg-white/10'}`}
                >
                  <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform shadow ${config[key] ? 'translate-x-5' : 'translate-x-0.5'}`} />
                </button>
              </div>
              <p className="text-xs text-muted-foreground mb-3">{desc}</p>
              {config[key] && (
                <div className="space-y-2">
                  <div>
                    <label className="text-xs text-muted-foreground">Prize (₹)</label>
                    <Input type="number" min={0} placeholder="0" value={config[prizeKey] ?? ''}
                      onChange={e => setConfig(c => ({ ...c, [prizeKey]: e.target.value ? Number(e.target.value) : null }))}
                      className="mt-1 h-8 bg-black/50 border-white/10 text-white text-sm" />
                  </div>
                  {sponsorKey && sponsors.length > 0 && (
                    <div>
                      <label className="text-xs text-muted-foreground block mb-1">Sponsor</label>
                      <select
                        value={config[sponsorKey] ?? ''}
                        onChange={e => setConfig(c => ({ ...c, [sponsorKey]: e.target.value ? Number(e.target.value) : null }))}
                        className="w-full bg-black/50 border border-white/10 text-white text-xs rounded px-2 py-1"
                      >
                        <option value="">None</option>
                        {sponsors.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                      </select>
                    </div>
                  )}
                  {holesKey && eligibleHoles.length > 0 && (
                    <div>
                      <label className="text-xs text-muted-foreground block mb-1">
                        Eligible Holes {selectedHoles.length > 0 ? `(${selectedHoles.join(', ')})` : '(all)'}
                      </label>
                      <div className="flex flex-wrap gap-1">
                        {eligibleHoles.map(h => (
                          <button
                            key={h.holeNumber}
                            onClick={() => toggleHole(h.holeNumber)}
                            className={`w-7 h-7 rounded text-xs font-bold transition-colors ${selectedHoles.includes(h.holeNumber) ? 'bg-yellow-500 text-black' : 'bg-white/10 text-muted-foreground hover:bg-white/20'}`}
                          >
                            {h.holeNumber}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
            );
          })}
        </div>
      </Card>

      {config.skinsEnabled && (
        <Card className="glass-panel border-none">
          <div className="p-6 border-b border-white/5"><CardTitle className="text-white flex items-center gap-2"><Layers className="w-4 h-4 text-yellow-400" /> Skins Results (Auto-Calculated)</CardTitle></div>
          {skins.length === 0 ? (
            <div className="p-8 text-center text-muted-foreground text-sm">No scores entered yet — skins will appear once scorecards are filled in.</div>
          ) : (
            <div className="overflow-x-auto relative">
              <div className="pointer-events-none absolute top-0 right-0 bottom-0 w-8 bg-gradient-to-l from-black/40 to-transparent z-10" />
            <Table>
              <TableHeader>
                <TableRow className="border-white/5 sticky top-0 z-10 bg-[#0a1628]">
                  <TableHead className="text-muted-foreground sticky left-0 z-10 bg-[#0a1628]">Hole</TableHead>
                  <TableHead className="text-muted-foreground">Winner</TableHead>
                  <TableHead className="text-muted-foreground">Score</TableHead>
                  <TableHead className="text-muted-foreground">Status</TableHead>
                  {config.skinsPrize && <TableHead className="text-muted-foreground text-right">Pot</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {skins.map(s => (
                  <TableRow key={s.hole} className="border-white/5 hover:bg-white/5">
                    <TableCell className="font-bold text-white">Hole {s.hole}</TableCell>
                    <TableCell className={s.winnerName ? 'text-yellow-400 font-semibold' : 'text-muted-foreground'}>
                      {s.winnerName ?? (s.tied ? '— Tied (carry over)' : '—')}
                    </TableCell>
                    <TableCell className="text-white">{s.winnerScore ?? '—'}</TableCell>
                    <TableCell>
                      {s.tied
                        ? <Badge className="bg-orange-500/20 text-orange-400 border-orange-500/30">Carryover</Badge>
                        : s.winnerName
                          ? <Badge className="bg-yellow-500/20 text-yellow-400 border-yellow-500/30">{s.carriedFrom ? `Won (carried from H${s.carriedFrom})` : 'Won'}</Badge>
                          : <Badge className="bg-white/10 text-muted-foreground border-white/10">No score</Badge>}
                    </TableCell>
                    {config.skinsPrize && <TableCell className="text-right text-yellow-400 font-semibold">{s.winnerName ? `₹${config.skinsPrize}` : '—'}</TableCell>}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            </div>
          )}
        </Card>
      )}

      {(config.ctpEnabled || config.ldEnabled || config.greeniesEnabled) && (
        <Card className="glass-panel border-none">
          <div className="p-6 border-b border-white/5"><CardTitle className="text-white flex items-center gap-2"><Plus className="w-4 h-4 text-green-400" /> Record Award</CardTitle></div>
          <div className="p-6 flex flex-wrap gap-4 items-end">
            <div className="flex-1 min-w-[140px]">
              <label className="text-xs text-muted-foreground mb-1 block">Game Type</label>
              <Select value={awardType} onValueChange={v => { setAwardType(v as 'ctp' | 'ld' | 'greenie'); setAwardHole(''); }}>
                <SelectTrigger className="bg-black/50 border-white/10 text-white h-9"><SelectValue /></SelectTrigger>
                <SelectContent className="bg-card border-white/10 text-white">
                  {config.ctpEnabled && <SelectItem value="ctp">Closest to Pin</SelectItem>}
                  {config.ldEnabled && <SelectItem value="ld">Longest Drive</SelectItem>}
                  {config.greeniesEnabled && <SelectItem value="greenie">Greenie</SelectItem>}
                </SelectContent>
              </Select>
            </div>
            <div className="w-36">
              <label className="text-xs text-muted-foreground mb-1 block">
                Hole {awardType === 'ctp' ? '(configured par-3 holes)' : awardType === 'ld' ? '(configured LD holes)' : awardType === 'greenie' ? '(par-3 only)' : ''}
              </label>
              {courseHoles.length > 0 ? (
                <Select value={awardHole} onValueChange={setAwardHole}>
                  <SelectTrigger className="bg-black/50 border-white/10 text-white h-9"><SelectValue placeholder="Select hole..." /></SelectTrigger>
                  <SelectContent className="bg-card border-white/10 text-white">
                    {courseHoles
                      .filter(h => {
                        if (awardType === 'ctp') {
                          const configuredCtpHoles = config.ctpHoles ?? [];
                          return configuredCtpHoles.length > 0 ? configuredCtpHoles.includes(h.holeNumber) : h.par === 3;
                        }
                        if (awardType === 'ld') {
                          const configuredLdHoles = config.ldHoles ?? [];
                          return configuredLdHoles.length > 0 ? configuredLdHoles.includes(h.holeNumber) : true;
                        }
                        if (awardType === 'greenie') return h.par === 3;
                        return true;
                      })
                      .map(h => (
                        <SelectItem key={h.holeNumber} value={String(h.holeNumber)}>
                          Hole {h.holeNumber} (Par {h.par}{h.handicap != null ? `, SI ${h.handicap}` : ''})
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              ) : (
                <Input type="number" min={1} max={18} placeholder="e.g. 7" value={awardHole} onChange={e => setAwardHole(e.target.value)} className="h-9 bg-black/50 border-white/10 text-white" />
              )}
            </div>
            <div className="flex-1 min-w-[180px]">
              <label className="text-xs text-muted-foreground mb-1 block">Winner</label>
              <Select value={awardPlayer} onValueChange={setAwardPlayer}>
                <SelectTrigger className="bg-black/50 border-white/10 text-white h-9"><SelectValue placeholder="Select player..." /></SelectTrigger>
                <SelectContent className="bg-card border-white/10 text-white">
                  {players.map(p => <SelectItem key={p.id} value={String(p.id)}>{p.firstName} {p.lastName}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="flex-1 min-w-[150px]">
              <label className="text-xs text-muted-foreground mb-1 block">Notes (optional)</label>
              <Input placeholder="e.g. 4 feet" value={awardNotes} onChange={e => setAwardNotes(e.target.value)} className="h-9 bg-black/50 border-white/10 text-white" />
            </div>
            <Button onClick={awardResult} className="bg-green-500/20 hover:bg-green-500/30 text-green-400 border border-green-500/30 h-9">
              <Plus className="w-4 h-4 mr-1" /> Record
            </Button>
          </div>
          {(ctpResults.length > 0 || ldResults.length > 0 || greenieResults.length > 0) && (
            <div className="px-6 pb-6 space-y-4">
              {[
                { label: 'Closest to Pin', data: ctpResults },
                { label: 'Longest Drive', data: ldResults },
                { label: 'Greenie', data: greenieResults },
              ].filter(g => g.data.length > 0).map(({ label, data }) => (
                <div key={label}>
                  <h3 className="text-sm font-semibold text-white mb-2">{label}</h3>
                  <div className="space-y-2">
                    {data.map(r => {
                      const winner = players.find(p => p.id === r.playerId);
                      const winnerName = r.firstName && r.lastName ? `${r.firstName} ${r.lastName}` : winner ? `${winner.firstName} ${winner.lastName}` : `Player #${r.playerId}`;
                      return (
                        <div key={r.id} className="flex items-center justify-between p-3 rounded-lg bg-white/5 border border-white/10">
                          <div>
                            <span className="text-white font-medium">{winnerName}</span>
                            {r.holeNumber && <span className="ml-2 text-muted-foreground text-sm">· Hole {r.holeNumber}</span>}
                            {r.notes && <span className="ml-2 text-muted-foreground text-xs">· {r.notes}</span>}
                          </div>
                          <Button size="sm" variant="ghost" onClick={() => deleteResult(r.id)} className="h-7 px-2 text-destructive hover:bg-destructive/10"><X className="w-3.5 h-3.5" /></Button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      )}

      {!config.skinsEnabled && !config.ctpEnabled && !config.ldEnabled && !config.greeniesEnabled && (
        <Card className="glass-panel border-dashed border-white/10 text-center p-12">
          <Trophy className="w-12 h-12 text-muted-foreground mx-auto mb-4 opacity-40" />
          <h2 className="text-xl font-display text-white mb-2">No Side Games Active</h2>
          <p className="text-muted-foreground text-sm">Enable skins, CTP, longest drive, or greenies in the configuration above.</p>
        </Card>
      )}
    </div>
  );
}

/* ─── Tournament Communications Tab ─────────────────────────── */

interface Announcement { id: number; body: string; type: string; authorName: string | null; sentAt: string }
interface TournamentInvitation { id: number; recipientEmail: string | null; recipientName: string | null; status: string; channels: string[]; createdAt: string; sentAt: string | null; expiresAt: string; token: string; tournamentId: number | null; leagueId: number | null; organizationId: number }
interface ReadReceipt { userId: number; readAt: string; username: string | null; displayName: string | null }

function TournamentCommsTab({ orgId, tournamentId }: { orgId: number; tournamentId: number }) {
  const { toast } = useToast();
  const [activeTab, setActiveTab] = useState<'announcements' | 'invitations' | 'broadcast' | 'automation'>('announcements');
  const [automation, setAutomation] = useState({ autoWelcome: true, autoReminder: true, autoResults: false, autoPostWhs: false, notifyManualEntryAlerts: true });
  const [autoSaving, setAutoSaving] = useState(false);
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [invitations, setInvitations] = useState<TournamentInvitation[]>([]);
  const [loading, setLoading] = useState(true);

  const [annBody, setAnnBody] = useState('');
  const [annType, setAnnType] = useState('general');
  const [annPosting, setAnnPosting] = useState(false);

  const [invName, setInvName] = useState('');
  const [invEmail, setInvEmail] = useState('');
  const [invPhone, setInvPhone] = useState('');
  const [invChannels, setInvChannels] = useState(['email']);
  const [invSendNow, setInvSendNow] = useState(true);
  const [invPosting, setInvPosting] = useState(false);

  const [bSubject, setBSubject] = useState('');
  const [bBody, setBBody] = useState('');
  const [bChannels, setBChannels] = useState(['email']);
  const [bSending, setBSending] = useState(false);

  const [expandedReceiptId, setExpandedReceiptId] = useState<number | null>(null);
  const [receiptData, setReceiptData] = useState<Record<number, ReadReceipt[]>>({});
  const [receiptLoading, setReceiptLoading] = useState<number | null>(null);

  const toggleReceipts = useCallback(async (annId: number) => {
    if (expandedReceiptId === annId) { setExpandedReceiptId(null); return; }
    setExpandedReceiptId(annId);
    if (receiptData[annId]) return;
    setReceiptLoading(annId);
    try {
      const r = await fetch(`/api/organizations/${orgId}/tournaments/${tournamentId}/announcements/${annId}/read-receipts`, { credentials: 'include' });
      const data = r.ok ? await r.json() : { receipts: [] };
      setReceiptData(prev => ({ ...prev, [annId]: data.receipts ?? [] }));
    } finally {
      setReceiptLoading(null);
    }
  }, [expandedReceiptId, receiptData, orgId, tournamentId]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [anns, invs, t] = await Promise.all([
        fetch(`/api/organizations/${orgId}/tournaments/${tournamentId}/announcements`, { credentials: 'include' }).then(r => r.ok ? r.json() : []),
        fetch(`/api/organizations/${orgId}/invitations?tournamentId=${tournamentId}`, { credentials: 'include' }).then(r => r.ok ? r.json() : []),
        fetch(`/api/organizations/${orgId}/tournaments/${tournamentId}`, { credentials: 'include' }).then(r => r.ok ? r.json() : null),
      ]);
      setAnnouncements([...anns].reverse());
      setInvitations(invs);
      if (t) setAutomation({ autoWelcome: t.autoWelcome ?? true, autoReminder: t.autoReminder ?? true, autoResults: t.autoResults ?? false, autoPostWhs: t.autoPostWhs ?? false, notifyManualEntryAlerts: t.notifyManualEntryAlerts ?? true });
    } finally {
      setLoading(false);
    }
  }, [orgId, tournamentId]);

  const saveAutomation = async (key: string, value: boolean) => {
    setAutomation(prev => ({ ...prev, [key]: value }));
    setAutoSaving(true);
    try {
      await fetch(`/api/organizations/${orgId}/tournaments/${tournamentId}/automation`, {
        method: 'PATCH', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [key]: value }),
      });
      toast({ title: 'Automation settings saved' });
    } catch {
      toast({ title: 'Failed to save', variant: 'destructive' });
    } finally {
      setAutoSaving(false);
    }
  };

  useEffect(() => { load(); }, [load]);

  const postAnnouncement = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!annBody.trim()) return;
    setAnnPosting(true);
    try {
      const res = await fetch(`/api/organizations/${orgId}/tournaments/${tournamentId}/announcements`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: annBody, type: annType }),
      });
      if (!res.ok) throw new Error();
      toast({ title: 'Announcement posted!' });
      setAnnBody('');
      load();
    } catch {
      toast({ title: 'Failed to post announcement', variant: 'destructive' });
    } finally {
      setAnnPosting(false);
    }
  };

  const deleteAnnouncement = async (id: number) => {
    await fetch(`/api/organizations/${orgId}/tournaments/${tournamentId}/announcements/${id}`, { method: 'DELETE', credentials: 'include' });
    setAnnouncements(prev => prev.filter(a => a.id !== id));
    toast({ title: 'Announcement deleted' });
  };

  const postInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!invEmail && !invPhone) return;
    setInvPosting(true);
    try {
      const res = await fetch(`/api/organizations/${orgId}/invitations`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tournamentId,
          recipientName: invName || undefined,
          recipientEmail: invEmail || undefined,
          recipientPhone: invPhone || undefined,
          channels: invChannels,
          sendNow: invSendNow,
        }),
      });
      if (!res.ok) throw new Error();
      toast({ title: invSendNow ? 'Invitation sent!' : 'Invitation created' });
      setInvName(''); setInvEmail(''); setInvPhone(''); setInvChannels(['email']);
      load();
    } catch {
      toast({ title: 'Failed to send invitation', variant: 'destructive' });
    } finally {
      setInvPosting(false);
    }
  };

  const sendBroadcast = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!bBody.trim()) return;
    setBSending(true);
    try {
      const res = await fetch(`/api/organizations/${orgId}/messages/broadcast`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tournamentId, subject: bSubject || undefined, body: bBody, channels: bChannels }),
      });
      if (!res.ok) throw new Error();
      const data = await res.json();
      toast({ title: `Message sent to ${data.recipientCount} players` });
      setBSubject(''); setBBody('');
    } catch {
      toast({ title: 'Failed to send', variant: 'destructive' });
    } finally {
      setBSending(false);
    }
  };

  const revokeInvite = async (id: number) => {
    await fetch(`/api/organizations/${orgId}/invitations/${id}`, { method: 'DELETE', credentials: 'include' });
    toast({ title: 'Invitation revoked' });
    load();
  };

  const copyInviteLink = (inv: TournamentInvitation) => {
    const base = window.location.origin + (import.meta.env.BASE_URL?.replace(/\/$/, '') || '');
    const url = inv.leagueId
      ? `${base}/leagues?orgId=${inv.organizationId}&invite=${inv.token}`
      : `${base}/register/${inv.organizationId}/${inv.tournamentId}?invite=${inv.token}`;
    navigator.clipboard.writeText(url).then(() => toast({ title: 'Invite link copied!' }));
  };

  const annTypeColors: Record<string, string> = {
    general: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/30',
    delay: 'text-yellow-400 bg-yellow-500/10 border-yellow-500/30',
    rule: 'text-orange-400 bg-orange-500/10 border-orange-500/30',
    results: 'text-green-400 bg-green-500/10 border-green-500/30',
  };

  return (
    <div className="space-y-6">
      <div className="flex gap-1 bg-black/40 border border-white/5 p-1 rounded-xl w-fit">
        {(['announcements', 'invitations', 'broadcast', 'automation'] as const).map(t => (
          <button
            key={t}
            onClick={() => setActiveTab(t)}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${
              activeTab === t ? 'bg-emerald-500/20 text-emerald-400' : 'text-muted-foreground hover:text-white'
            }`}
          >
            {t === 'announcements' ? '📢 Announcements' : t === 'invitations' ? '📧 Invitations' : t === 'broadcast' ? '📣 Broadcast' : '⚙️ Automation'}
          </button>
        ))}
      </div>

      {activeTab === 'announcements' && (
        <div className="space-y-6">
          <Card className="glass-card">
            <CardHeader><CardTitle className="text-white flex items-center gap-2"><Bell className="w-4 h-4 text-emerald-400" /> Post Live Announcement</CardTitle></CardHeader>
            <CardContent>
              <form onSubmit={postAnnouncement} className="space-y-4">
                <div className="flex gap-2 flex-wrap">
                  {(['general', 'delay', 'rule', 'results'] as const).map(t => (
                    <button key={t} type="button" onClick={() => setAnnType(t)}
                      className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition-all capitalize ${
                        annType === t ? annTypeColors[t] : 'bg-white/5 text-muted-foreground border-white/10'
                      }`}
                    >{t}</button>
                  ))}
                </div>
                <textarea
                  value={annBody} onChange={e => setAnnBody(e.target.value)}
                  required rows={3}
                  placeholder="Type your announcement to all players watching the live leaderboard..."
                  className="w-full bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-white text-sm resize-none focus:outline-none focus:border-emerald-500/50 placeholder:text-muted-foreground"
                />
                <div className="flex items-center justify-end gap-3">
                  <p className="text-xs text-muted-foreground">Push notification sent automatically to enrolled players</p>
                  <Button type="submit" disabled={annPosting || !annBody.trim()} className="bg-emerald-600 hover:bg-emerald-700 text-white">
                    {annPosting ? 'Posting...' : <><Bell className="w-4 h-4 mr-2" /> Post Announcement</>}
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>

          <Card className="glass-card">
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="text-white">Recent Announcements ({announcements.length})</CardTitle>
                <Button size="sm" variant="ghost" onClick={load} className="text-muted-foreground hover:text-white"><RefreshCw className="w-4 h-4" /></Button>
              </div>
            </CardHeader>
            <CardContent>
              {loading ? (
                <div className="space-y-3">{[1,2,3].map(i => <div key={i} className="h-14 glass-panel rounded-xl animate-pulse" />)}</div>
              ) : announcements.length === 0 ? (
                <div className="text-center py-8">
                  <Bell className="w-10 h-10 text-muted-foreground opacity-30 mx-auto mb-2" />
                  <p className="text-muted-foreground text-sm">No announcements yet. Post one above to notify players.</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {announcements.map(ann => (
                    <div key={ann.id} className="glass-panel rounded-xl overflow-hidden">
                      <div className="flex items-start justify-between gap-3 p-4">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1 flex-wrap">
                            <Badge className={`text-[10px] px-1.5 py-0 border ${annTypeColors[ann.type] ?? annTypeColors.general}`}>{ann.type}</Badge>
                            <span className="text-xs text-muted-foreground">{ann.authorName}</span>
                            <span className="text-xs text-muted-foreground">{new Date(ann.sentAt).toLocaleString()}</span>
                          </div>
                          <p className="text-white text-sm">{ann.body}</p>
                          <button
                            onClick={() => toggleReceipts(ann.id)}
                            className="mt-2 flex items-center gap-1.5 text-xs text-emerald-400 hover:text-emerald-300 transition-colors"
                          >
                            <Eye className="w-3 h-3" />
                            {expandedReceiptId === ann.id ? 'Hide read receipts' : 'View read receipts'}
                          </button>
                        </div>
                        <Button size="icon" variant="ghost" onClick={() => deleteAnnouncement(ann.id)} className="w-8 h-8 text-red-400 hover:text-red-300 shrink-0">
                          <X className="w-3.5 h-3.5" />
                        </Button>
                      </div>
                      {expandedReceiptId === ann.id && (
                        <div className="border-t border-white/5 bg-black/20 px-4 py-3">
                          {receiptLoading === ann.id ? (
                            <p className="text-xs text-muted-foreground animate-pulse">Loading receipts…</p>
                          ) : (receiptData[ann.id]?.length ?? 0) === 0 ? (
                            <p className="text-xs text-muted-foreground">No players have read this yet.</p>
                          ) : (
                            <>
                              <p className="text-xs text-muted-foreground mb-2 font-medium">{receiptData[ann.id].length} player{receiptData[ann.id].length !== 1 ? 's' : ''} seen</p>
                              <div className="flex flex-wrap gap-2">
                                {receiptData[ann.id].map(r => (
                                  <div key={r.userId} className="flex items-center gap-1.5 bg-white/5 rounded-md px-2 py-1">
                                    <div className="w-5 h-5 rounded-full bg-green-500/20 flex items-center justify-center">
                                      <span className="text-[9px] text-green-400 font-bold">{(r.displayName ?? r.username ?? '?')[0].toUpperCase()}</span>
                                    </div>
                                    <span className="text-xs text-white">{r.displayName ?? r.username}</span>
                                    <span className="text-[10px] text-muted-foreground">{new Date(r.readAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                                  </div>
                                ))}
                              </div>
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {activeTab === 'invitations' && (
        <div className="space-y-6">
          <Card className="glass-card">
            <CardHeader><CardTitle className="text-white flex items-center gap-2"><Link2 className="w-4 h-4 text-emerald-400" /> Invite a Player</CardTitle></CardHeader>
            <CardContent>
              <form onSubmit={postInvite} className="space-y-4">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs text-muted-foreground uppercase tracking-wider mb-1.5 block">Name (optional)</label>
                    <Input value={invName} onChange={e => setInvName(e.target.value)} placeholder="Player name" className="bg-black/40 border-white/10 text-white" />
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground uppercase tracking-wider mb-1.5 block">Email</label>
                    <Input type="email" value={invEmail} onChange={e => setInvEmail(e.target.value)} placeholder="player@email.com" className="bg-black/40 border-white/10 text-white" />
                  </div>
                </div>
                <div>
                  <label className="text-xs text-muted-foreground uppercase tracking-wider mb-1.5 block">Phone (for SMS / WhatsApp)</label>
                  <Input type="tel" value={invPhone} onChange={e => setInvPhone(e.target.value)} placeholder="+91 98765 43210" className="bg-black/40 border-white/10 text-white" />
                  <p className="text-xs text-muted-foreground mt-1">Email or phone required.</p>
                </div>
                <div>
                  <label className="text-xs text-muted-foreground uppercase tracking-wider mb-1.5 block">Channels</label>
                  <div className="flex gap-2 flex-wrap">
                    {[
                      { key: 'email', label: '📧 Email', needsEmail: true },
                      { key: 'sms', label: '💬 SMS', needsPhone: true },
                      { key: 'whatsapp', label: '📱 WhatsApp', needsPhone: true },
                    ].map(ch => {
                      const isDisabled = (ch.needsEmail && !invEmail) || (ch.needsPhone && !invPhone);
                      return (
                        <button key={ch.key} type="button" disabled={isDisabled}
                          onClick={() => setInvChannels(prev => prev.includes(ch.key) ? prev.filter(c => c !== ch.key) : [...prev, ch.key])}
                          className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition-all ${
                            invChannels.includes(ch.key)
                              ? 'bg-primary/20 text-primary border-primary/40'
                              : isDisabled
                              ? 'bg-white/5 text-muted-foreground/40 border-white/5 cursor-not-allowed'
                              : 'bg-white/5 text-muted-foreground border-white/10'
                          }`}
                        >{ch.label}</button>
                      );
                    })}
                  </div>
                </div>
                <div className="flex items-center justify-between flex-wrap gap-3">
                  <label className="flex items-center gap-2 text-sm text-white cursor-pointer">
                    <input type="checkbox" checked={invSendNow} onChange={e => setInvSendNow(e.target.checked)} className="accent-primary" />
                    Send invitation immediately
                  </label>
                  <Button type="submit" disabled={invPosting || (!invEmail && !invPhone)} className="bg-primary hover:bg-primary/90 text-primary-foreground">
                    {invPosting ? 'Sending...' : <><Send className="w-4 h-4 mr-2" /> {invSendNow ? 'Send Invite' : 'Create Invite'}</>}
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>

          <Card className="glass-card">
            <CardHeader><CardTitle className="text-white">Sent Invitations ({invitations.length})</CardTitle></CardHeader>
            <CardContent>
              {invitations.length === 0 ? (
                <p className="text-muted-foreground text-sm text-center py-6">No invitations sent for this tournament.</p>
              ) : (
                <div className="space-y-3">
                  {invitations.map(inv => (
                    <div key={inv.id} className="flex items-center justify-between gap-3 glass-panel rounded-xl p-4">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap mb-1">
                          <p className="text-white text-sm font-medium">{inv.recipientName || inv.recipientEmail}</p>
                          <Badge className={`text-[10px] px-1.5 py-0 ${
                            inv.status === 'accepted' ? 'bg-green-500/20 text-green-300 border-green-500/30' :
                            inv.status === 'pending' ? 'bg-yellow-500/20 text-yellow-300 border-yellow-500/30' :
                            'bg-red-500/20 text-red-300 border-red-500/30'
                          }`}>{inv.status}</Badge>
                        </div>
                        <p className="text-xs text-muted-foreground">{inv.recipientEmail} · Expires {new Date(inv.expiresAt).toLocaleDateString()}</p>
                      </div>
                      <div className="flex gap-1.5 shrink-0">
                        <Button size="icon" variant="ghost" onClick={() => copyInviteLink(inv)} className="w-8 h-8 text-muted-foreground hover:text-white" title="Copy link">
                          <Copy className="w-3.5 h-3.5" />
                        </Button>
                        {inv.status === 'pending' && (
                          <Button size="icon" variant="ghost" onClick={() => revokeInvite(inv.id)} className="w-8 h-8 text-red-400 hover:text-red-300" title="Revoke">
                            <X className="w-3.5 h-3.5" />
                          </Button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {activeTab === 'automation' && (
        <AutomationRulesPanel
          orgId={orgId}
          tournamentId={tournamentId}
          automation={automation}
          autoSaving={autoSaving}
          saveAutomation={saveAutomation}
          // Task #1674 — restore-my-preference flow updates the value
          // server-side; this callback keeps the parent's local toggle
          // in sync without firing a redundant PATCH.
          onAutomationLocallyUpdated={(key, value) => setAutomation(prev => ({ ...prev, [key]: value }))}
        />
      )}

      {activeTab === 'broadcast' && (
        <Card className="glass-card">
          <CardHeader><CardTitle className="text-white flex items-center gap-2"><MessageSquare className="w-4 h-4 text-primary" /> Broadcast to All Players</CardTitle></CardHeader>
          <CardContent>
            <form onSubmit={sendBroadcast} className="space-y-4">
              <div>
                <label className="text-xs text-muted-foreground uppercase tracking-wider mb-1.5 block">Channels</label>
                <div className="flex gap-2">
                  {['email', 'push'].map(ch => (
                    <button key={ch} type="button"
                      onClick={() => setBChannels(prev => prev.includes(ch) ? prev.filter(c => c !== ch) : [...prev, ch])}
                      className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition-all ${
                        bChannels.includes(ch) ? 'bg-primary/20 text-primary border-primary/40' : 'bg-white/5 text-muted-foreground border-white/10'
                      }`}
                    >
                      {ch === 'email' ? '📧 Email' : '🔔 Push'}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label className="text-xs text-muted-foreground uppercase tracking-wider mb-1.5 block">Subject</label>
                <Input value={bSubject} onChange={e => setBSubject(e.target.value)} placeholder="e.g. Tournament Update" className="bg-black/40 border-white/10 text-white" />
              </div>
              <div>
                <label className="text-xs text-muted-foreground uppercase tracking-wider mb-1.5 block">Message</label>
                <textarea
                  value={bBody} onChange={e => setBBody(e.target.value)} required rows={5}
                  placeholder="Message to all registered players in this tournament..."
                  className="w-full bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-white text-sm resize-none focus:outline-none focus:border-primary/50 placeholder:text-muted-foreground"
                />
              </div>
              <div className="flex justify-end">
                <Button type="submit" disabled={bSending || !bBody.trim()} className="bg-primary hover:bg-primary/90 text-primary-foreground">
                  {bSending ? 'Sending...' : <><Send className="w-4 h-4 mr-2" /> Send to All Players</>}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

/* ─── Pace Tab ────────────────────────────────────────────────────── */

function PaceTab({ tournamentId }: { tournamentId: number }) {
  const { toast } = useToast();
  const [groups, setGroups] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchPace = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/tournaments/${tournamentId}/pace-of-play`);
      if (res.ok) setGroups(await res.json());
    } finally { setLoading(false); }
  };

  useEffect(() => { fetchPace(); }, [tournamentId]);

  const sendWarning = async (groupId: number) => {
    const res = await fetch(`/api/tournaments/${tournamentId}/groups/${groupId}/pace-warning`, { method: 'POST' });
    if (res.ok) toast({ title: 'Pace warning sent' });
  };

  const applyPenalty = async (groupId: number) => {
    const res = await fetch(`/api/tournaments/${tournamentId}/groups/${groupId}/pace-penalty`, { method: 'POST' });
    if (res.ok) {
      toast({ title: 'Pace penalty applied (+2 strokes)' });
      fetchPace();
    }
  };

  return (
    <Card className="glass-card">
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-white flex items-center gap-2">
            <Timer className="w-5 h-5 text-blue-400" /> Pace of Play
          </CardTitle>
          <Button size="sm" variant="outline" onClick={fetchPace} className="border-white/10 text-white">
            <RefreshCw className="w-3.5 h-3.5 mr-2" /> Refresh
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="text-center py-8 text-muted-foreground">Loading pace data...</div>
        ) : groups.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">No groups found or pace tracking not active.</div>
        ) : (
          <div className="overflow-x-auto relative">
            <div className="pointer-events-none absolute top-0 right-0 bottom-0 w-8 bg-gradient-to-l from-black/40 to-transparent z-10" />
          <Table>
            <TableHeader>
              <TableRow className="border-white/5 sticky top-0 z-10 bg-[#0a1628]">
                <TableHead className="text-muted-foreground sticky left-0 z-10 bg-[#0a1628]">Group</TableHead>
                <TableHead className="text-muted-foreground">Current Hole</TableHead>
                <TableHead className="text-muted-foreground">Status</TableHead>
                <TableHead className="text-muted-foreground">Behind</TableHead>
                <TableHead className="text-muted-foreground text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {groups.map(g => (
                <TableRow key={g.id} className="border-white/5">
                  <TableCell className="text-white font-medium sticky left-0 z-10 bg-[#0a1628]">Group {g.id}</TableCell>
                  <TableCell className="text-muted-foreground">Hole {g.currentHole ?? '—'}</TableCell>
                  <TableCell>
                    <Badge className={g.behindMinutes > 10 ? 'bg-red-500/20 text-red-400' : g.behindMinutes > 0 ? 'bg-yellow-500/20 text-yellow-400' : 'bg-emerald-500/20 text-emerald-400'}>
                      {g.behindMinutes > 10 ? 'Slow' : g.behindMinutes > 0 ? 'Behind' : 'On Pace'}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{g.behindMinutes} min</TableCell>
                  <TableCell className="text-right flex gap-2 justify-end">
                    <Button size="sm" variant="outline" onClick={() => sendWarning(g.id)} className="border-yellow-500/30 text-yellow-400 hover:bg-yellow-500/10 h-7 text-xs">
                      Warning
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => applyPenalty(g.id)} className="border-red-500/30 text-red-400 hover:bg-red-500/10 h-7 text-xs">
                      Penalty
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/* ─── Rulings Tab ─────────────────────────────────────────────────── */

function RulingsTab({ tournamentId, players }: { tournamentId: number, players: number }) {
  const { toast } = useToast();
  const [rulings, setRulings] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState({ playerId: '', holeNumber: '', ruleRef: '', decision: '', penaltyStrokes: '0', officialName: '' });
  const [tournamentPlayers, setTournamentPlayers] = useState<any[]>([]);

  const fetchRulings = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/tournaments/${tournamentId}/rulings`);
      if (res.ok) setRulings(await res.json());
    } finally { setLoading(false); }
  };

  useEffect(() => {
    fetchRulings();
    fetch(`/api/tournaments/${tournamentId}/players`)
      .then(r => r.json())
      .then(data => setTournamentPlayers(data));
  }, [tournamentId]);

  const submitRuling = async () => {
    if (!form.playerId) { toast({ title: 'Select a player', variant: 'destructive' }); return; }
    const res = await fetch(`/api/tournaments/${tournamentId}/rulings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...form,
        playerId: parseInt(form.playerId),
        holeNumber: form.holeNumber ? parseInt(form.holeNumber) : null,
        penaltyStrokes: parseInt(form.penaltyStrokes) || 0
      }),
    });
    if (res.ok) {
      toast({ title: 'Ruling logged' });
      setFormOpen(false);
      setForm({ playerId: '', holeNumber: '', ruleRef: '', decision: '', penaltyStrokes: '0', officialName: '' });
      fetchRulings();
    }
  };

  const deleteRuling = async (id: number) => {
    const res = await fetch(`/api/tournaments/${tournamentId}/rulings/${id}`, { method: 'DELETE' });
    if (res.ok) {
      toast({ title: 'Ruling removed' });
      fetchRulings();
    }
  };

  return (
    <div className="space-y-4">
      <Card className="glass-card">
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-white flex items-center gap-2">
              <Gavel className="w-5 h-5 text-red-400" /> Tournament Rulings
            </CardTitle>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={() => {
                const csv = rulings.map(r => `${r.playerName},Hole ${r.holeNumber},${r.ruleRef},${r.decision},${r.penaltyStrokes},${r.officialName}`).join('\n');
                const blob = new Blob([`Player,Hole,Rule,Decision,Penalty,Official\n${csv}`], { type: 'text/csv' });
                const url = window.URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `rulings_${tournamentId}.csv`;
                a.click();
              }} className="border-white/10 text-white">
                <Download className="w-3.5 h-3.5 mr-2" /> Export CSV
              </Button>
              <Button size="sm" onClick={() => setFormOpen(true)} className="bg-red-600 hover:bg-red-700 text-white">
                <Plus className="w-3.5 h-3.5 mr-2" /> New Ruling
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="text-center py-8 text-muted-foreground">Loading rulings...</div>
          ) : rulings.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">No rulings logged yet.</div>
          ) : (
            <div className="overflow-x-auto relative">
              <div className="pointer-events-none absolute top-0 right-0 bottom-0 w-8 bg-gradient-to-l from-black/40 to-transparent z-10" />
            <Table>
              <TableHeader>
                <TableRow className="border-white/5 sticky top-0 z-10 bg-[#0a1628]">
                  <TableHead className="text-muted-foreground sticky left-0 z-10 bg-[#0a1628]">Player</TableHead>
                  <TableHead className="text-muted-foreground">Hole</TableHead>
                  <TableHead className="text-muted-foreground">Rule</TableHead>
                  <TableHead className="text-muted-foreground">Penalty</TableHead>
                  <TableHead className="text-muted-foreground">Official</TableHead>
                  <TableHead className="text-muted-foreground text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rulings.map(r => (
                  <TableRow key={r.id} className="border-white/5">
                    <TableCell className="text-white font-medium sticky left-0 z-10 bg-[#0a1628]">{r.playerName}</TableCell>
                    <TableCell className="text-muted-foreground">Hole {r.holeNumber ?? '—'}</TableCell>
                    <TableCell className="text-muted-foreground">{r.ruleRef}</TableCell>
                    <TableCell>
                      {r.penaltyStrokes > 0 ? (
                        <Badge className="bg-red-500/20 text-red-400">+{r.penaltyStrokes}</Badge>
                      ) : (
                        <Badge variant="outline" className="border-white/10 text-muted-foreground">None</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{r.officialName}</TableCell>
                    <TableCell className="text-right">
                      <button onClick={() => deleteRuling(r.id)} className="text-muted-foreground hover:text-red-400 p-1">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={formOpen} onOpenChange={setFormOpen}>
        <DialogContent className="bg-[#0a1628] border border-white/10 text-white max-w-md">
          <DialogHeader><DialogTitle>Log Tournament Ruling</DialogTitle></DialogHeader>
          <div className="space-y-4 mt-2">
            <div>
              <label className="text-xs text-muted-foreground uppercase tracking-wider">Player *</label>
              <Select value={form.playerId} onValueChange={v => setForm(f => ({ ...f, playerId: v }))}>
                <SelectTrigger className="mt-1 bg-black/40 border-white/10 text-white"><SelectValue placeholder="Select player" /></SelectTrigger>
                <SelectContent className="bg-[#0a1628] border-white/10 text-white">
                  {tournamentPlayers.map(p => (
                    <SelectItem key={p.id} value={String(p.id)} className="text-white">{p.firstName} {p.lastName}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-xs text-muted-foreground uppercase tracking-wider">Hole #</label>
                <Input type="number" value={form.holeNumber} onChange={e => setForm(f => ({ ...f, holeNumber: e.target.value }))} className="mt-1 bg-black/40 border-white/10 text-white" />
              </div>
              <div>
                <label className="text-xs text-muted-foreground uppercase tracking-wider">Penalty Strokes</label>
                <Input type="number" value={form.penaltyStrokes} onChange={e => setForm(f => ({ ...f, penaltyStrokes: e.target.value }))} className="mt-1 bg-black/40 border-white/10 text-white" />
              </div>
            </div>
            <div>
              <label className="text-xs text-muted-foreground uppercase tracking-wider">Rule Reference</label>
              <Input value={form.ruleRef} onChange={e => setForm(f => ({ ...f, ruleRef: e.target.value }))} placeholder="e.g. Rule 16.1b" className="mt-1 bg-black/40 border-white/10 text-white" />
            </div>
            <div>
              <label className="text-xs text-muted-foreground uppercase tracking-wider">Decision / Notes</label>
              <textarea value={form.decision} onChange={e => setForm(f => ({ ...f, decision: e.target.value }))} className="w-full mt-1 bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-white text-sm" rows={3} />
            </div>
            <div>
              <label className="text-xs text-muted-foreground uppercase tracking-wider">Official Name</label>
              <Input value={form.officialName} onChange={e => setForm(f => ({ ...f, officialName: e.target.value }))} className="mt-1 bg-black/40 border-white/10 text-white" />
            </div>
            <div className="flex gap-3 pt-2">
              <Button onClick={submitRuling} className="flex-1 bg-red-600 hover:bg-red-700 text-white">Log Ruling</Button>
              <Button variant="outline" onClick={() => setFormOpen(false)} className="border-white/10 text-white">Cancel</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/* ─── Teams Tab ───────────────────────────────────────────────────── */

function TeamsTab({ tournamentId }: { tournamentId: number }) {
  const { toast } = useToast();
  const [teams, setTeams] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [drawOpen, setDrawOpen] = useState(false);
  const [teamSize, setTeamSize] = useState('2');
  const [teamStandings, setTeamStandings] = useState<any[]>([]);

  const fetchTeams = async () => {
    setLoading(true);
    try {
      const [teamsRes, lbRes] = await Promise.all([
        fetch(`/api/tournaments/${tournamentId}/teams`),
        fetch(`/api/tournaments/${tournamentId}/scores/leaderboard/teams`),
      ]);
      if (teamsRes.ok) setTeams(await teamsRes.json());
      if (lbRes.ok) {
        const lbData = await lbRes.json();
        setTeamStandings(lbData.teamEntries ?? []);
      }
    } finally { setLoading(false); }
  };

  useEffect(() => { fetchTeams(); }, [tournamentId]);

  const autoDraw = async () => {
    const res = await fetch(`/api/tournaments/${tournamentId}/teams/auto-draw`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ teamSize: parseInt(teamSize) }),
    });
    if (res.ok) {
      toast({ title: 'Teams generated', description: `Balanced draw by handicap completed.` });
      setDrawOpen(false);
      fetchTeams();
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <h2 className="text-lg font-bold text-white">Tournament Teams</h2>
        <Button onClick={() => setDrawOpen(true)} className="bg-indigo-600 hover:bg-indigo-700 text-white">
          <Shuffle className="w-4 h-4 mr-2" /> Auto-Draw Teams
        </Button>
      </div>

      {loading ? (
        <div className="text-center py-8 text-muted-foreground">Loading teams...</div>
      ) : teams.length === 0 ? (
        <div className="text-center py-16 glass-card rounded-2xl border border-dashed border-white/10">
          <Users className="w-12 h-12 text-muted-foreground opacity-30 mx-auto mb-3" />
          <p className="text-muted-foreground">No teams created yet.</p>
          <Button variant="link" onClick={() => setDrawOpen(true)} className="text-indigo-400 mt-2">Generate teams automatically</Button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {teams.map(team => {
            const standing = teamStandings.find((s: any) => s.teamId === team.id);
            return (
              <Card key={team.id} className="glass-card">
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-white flex items-center gap-2">
                      <div className="w-3 h-3 rounded-full" style={{ backgroundColor: team.colour }} />
                      {team.name}
                    </CardTitle>
                    <Badge variant="outline" className="border-white/10 text-muted-foreground text-[10px]">
                      Avg HI: {(team.combinedHandicap / (team.members?.length || 1)).toFixed(1)}
                    </Badge>
                  </div>
                  {standing && (
                    <div className="flex items-center gap-3 mt-2 pt-2 border-t border-white/10">
                      <span className="text-xs text-muted-foreground">Position:</span>
                      <span className="text-sm font-bold text-white">
                        {standing.positionDisplay ?? standing.position ?? '—'}
                      </span>
                      {(standing.netToPar != null || standing.scoreToPar != null) && (() => {
                        const displayPar = standing.netToPar ?? standing.scoreToPar;
                        return (
                          <>
                            <span className="text-xs text-muted-foreground ml-1">{standing.netToPar != null ? 'Net:' : 'Score:'}</span>
                            <span className={`text-sm font-bold ${displayPar < 0 ? 'text-red-400' : displayPar === 0 ? 'text-white' : 'text-blue-400'}`}>
                              {displayPar === 0 ? 'E' : displayPar > 0 ? `+${displayPar}` : `${displayPar}`}
                            </span>
                          </>
                        );
                      })()}
                      {standing.grossScore != null && (
                        <>
                          <span className="text-xs text-muted-foreground ml-1">({standing.grossScore})</span>
                        </>
                      )}
                    </div>
                  )}
                </CardHeader>
                <CardContent>
                  <div className="space-y-2">
                    {team.members?.map((m: any) => (
                      <div key={m.playerId} className="flex items-center justify-between text-sm py-1 border-b border-white/5 last:border-0">
                        <span className="text-white">{m.firstName} {m.lastName}</span>
                        <span className="text-muted-foreground text-xs">{m.handicapIndex}</span>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <Dialog open={drawOpen} onOpenChange={setDrawOpen}>
        <DialogContent className="bg-[#0a1628] border border-white/10 text-white max-sm">
          <DialogHeader><DialogTitle>Auto-Draw Teams</DialogTitle></DialogHeader>
          <div className="space-y-4 mt-2">
            <p className="text-xs text-muted-foreground">This will clear existing teams and re-assign all registered players into balanced teams based on their handicap index.</p>
            <div>
              <label className="text-xs text-muted-foreground uppercase tracking-wider">Team Size</label>
              <Select value={teamSize} onValueChange={setTeamSize}>
                <SelectTrigger className="mt-1 bg-black/40 border-white/10 text-white"><SelectValue /></SelectTrigger>
                <SelectContent className="bg-[#0a1628] border-white/10 text-white">
                  <SelectItem value="2">2 Players (Pairs)</SelectItem>
                  <SelectItem value="3">3 Players (Trios)</SelectItem>
                  <SelectItem value="4">4 Players (Quads)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button onClick={autoDraw} className="w-full bg-indigo-600 hover:bg-indigo-700 text-white mt-2">Generate Balanced Teams</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────── */
/* Gallery Tab                                                         */
/* ─────────────────────────────────────────────────────────────────── */

interface MediaItem {
  id: number;
  organizationId: number;
  tournamentId: number | null;
  leagueId: number | null;
  uploadedByUserId: number | null;
  uploaderName: string | null;
  objectPath: string;
  thumbnailPath: string | null;
  mediaType: string;
  caption: string | null;
  approved: boolean;
  createdAt: string;
}

function GalleryTab({ orgId, tournamentId, isAdmin, moderationEnabled: initialModeration = true }: { orgId: number; tournamentId: number; isAdmin: boolean; moderationEnabled?: boolean }) {
  const { toast } = useToast();
  const [items, setItems] = useState<MediaItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [caption, setCaption] = useState('');
  const [lightbox, setLightbox] = useState<MediaItem | null>(null);
  const [moderationEnabled, setModerationEnabled] = useState(initialModeration);
  const fileRef = useRef<HTMLInputElement>(null);

  const toggleModeration = async () => {
    const r = await fetch(`/api/organizations/${orgId}/tournaments/${tournamentId}/media-moderation`, {
      method: 'PATCH', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: !moderationEnabled }),
    });
    if (r.ok) {
      const data = await r.json() as { mediaModerationEnabled: boolean };
      setModerationEnabled(data.mediaModerationEnabled);
      toast({ title: data.mediaModerationEnabled ? 'Moderation enabled — all uploads require approval' : 'Moderation disabled — uploads auto-approved' });
    }
  };

  const fetchGallery = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`/api/organizations/${orgId}/media?tournamentId=${tournamentId}`, { credentials: 'include' });
      if (r.ok) setItems(await r.json());
    } finally { setLoading(false); }
  }, [orgId, tournamentId]);

  useEffect(() => { fetchGallery(); }, [fetchGallery]);

  const checkVideoDuration = (file: File): Promise<number> =>
    new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const vid = document.createElement('video');
      vid.preload = 'metadata';
      vid.onloadedmetadata = () => { URL.revokeObjectURL(url); resolve(vid.duration); };
      vid.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read video')); };
      vid.src = url;
    });

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const MAX_SIZE = 100 * 1024 * 1024; // 100 MB
    if (file.size > MAX_SIZE) {
      toast({ title: 'File too large. Maximum size is 100 MB.', variant: 'destructive' });
      if (fileRef.current) fileRef.current.value = '';
      return;
    }
    const ALLOWED_TYPES = ['image/jpeg','image/png','image/gif','image/webp','video/mp4','video/quicktime','video/x-m4v','video/webm'];
    if (!ALLOWED_TYPES.includes(file.type)) {
      toast({ title: 'Unsupported file type. Use JPEG, PNG, GIF, WebP, MP4, MOV, or WebM.', variant: 'destructive' });
      if (fileRef.current) fileRef.current.value = '';
      return;
    }
    if (file.type.startsWith('video/')) {
      try {
        const duration = await checkVideoDuration(file);
        if (duration > 60) {
          toast({ title: 'Video must be 60 seconds or shorter.', variant: 'destructive' });
          if (fileRef.current) fileRef.current.value = '';
          return;
        }
      } catch {
        toast({ title: 'Could not verify video duration. Please try a different file.', variant: 'destructive' });
        if (fileRef.current) fileRef.current.value = '';
        return;
      }
    }
    setUploading(true);
    try {
      const urlRes = await fetch(`/api/organizations/${orgId}/media/upload-url`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tournamentId, name: file.name, size: file.size, contentType: file.type }),
      });
      if (!urlRes.ok) throw new Error('Failed to get upload URL');
      const { uploadURL, objectPath, uploadToken } = await urlRes.json() as { uploadURL: string; objectPath: string; uploadToken: string };

      const uploadRes = await fetch(uploadURL, { method: 'PUT', body: file, headers: { 'Content-Type': file.type } });
      if (!uploadRes.ok) throw new Error('Upload failed');

      const regRes = await fetch(`/api/organizations/${orgId}/media`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tournamentId, objectPath, uploadToken, mediaType: file.type.startsWith('video/') ? 'video' : 'image', caption: caption || null }),
      });
      if (!regRes.ok) throw new Error('Failed to register media');
      toast({ title: 'Photo uploaded!' });
      setCaption('');
      if (fileRef.current) fileRef.current.value = '';
      fetchGallery();
    } catch (err) {
      toast({ title: String(err), variant: 'destructive' });
    } finally { setUploading(false); }
  };

  const approve = async (id: number) => {
    await fetch(`/api/organizations/${orgId}/media/${id}/approve`, { method: 'PATCH', credentials: 'include' });
    fetchGallery();
    toast({ title: 'Photo approved' });
  };

  const remove = async (id: number) => {
    await fetch(`/api/organizations/${orgId}/media/${id}`, { method: 'DELETE', credentials: 'include' });
    setItems(prev => prev.filter(i => i.id !== id));
    toast({ title: 'Photo removed' });
  };

  const thumbUrl = (item: MediaItem) =>
    item.mediaType === 'video' && item.thumbnailPath
      ? `/api/storage${item.thumbnailPath}`
      : `/api/storage${item.objectPath}`;
  const imgUrl = (item: MediaItem) => `/api/storage${item.objectPath}`;

  const shareToChat = async (item: MediaItem) => {
    try {
      const r = await fetch(`/api/organizations/${orgId}/chat/tournament/${tournamentId}/messages`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          body: item.caption ? `📸 ${item.caption}` : '📸 Shared a photo from the gallery',
          messageType: 'gallery-share',
          mediaId: item.id,
        }),
      });
      if (r.ok) toast({ title: 'Shared to chat' });
      else toast({ title: 'Chat is not enabled for this tournament', variant: 'destructive' });
    } catch {
      toast({ title: 'Failed to share to chat', variant: 'destructive' });
    }
  };

  return (
    <div className="space-y-6">
      <Card className="glass-card">
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-white flex items-center gap-2"><Camera className="w-5 h-5 text-purple-400" /> Tournament Gallery</CardTitle>
            {isAdmin && (
              <Button size="sm" variant="outline" onClick={toggleModeration}
                className={moderationEnabled ? 'border-yellow-500/30 text-yellow-400 hover:bg-yellow-500/10 text-xs' : 'border-green-500/30 text-green-400 hover:bg-green-500/10 text-xs'}>
                {moderationEnabled ? '🔒 Moderation On' : '🔓 Moderation Off'}
              </Button>
            )}
          </div>
          {isAdmin && (
            <p className="text-xs text-muted-foreground mt-1">
              {moderationEnabled ? 'All uploads require admin approval before appearing publicly.' : 'All uploads are auto-approved and immediately visible.'}
            </p>
          )}
        </CardHeader>
        <CardContent>
          <div className="flex gap-3 items-end mb-6">
            <div className="flex-1">
              <label className="text-xs text-muted-foreground uppercase tracking-wider mb-1.5 block">Caption (optional)</label>
              <Input value={caption} onChange={e => setCaption(e.target.value)} placeholder="Add a caption..." className="bg-black/40 border-white/10 text-white" />
            </div>
            <div>
              <input ref={fileRef} type="file" accept="image/*,video/*" className="hidden" onChange={handleUpload} />
              <Button onClick={() => fileRef.current?.click()} disabled={uploading} className="bg-purple-600 hover:bg-purple-700 text-white">
                {uploading ? 'Uploading...' : <><Upload className="w-4 h-4 mr-2" /> Upload Photo</>}
              </Button>
            </div>
          </div>

          {loading ? (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {[1,2,3,4].map(i => <div key={i} className="aspect-square rounded-xl bg-white/5 animate-pulse" />)}
            </div>
          ) : items.length === 0 ? (
            <div className="text-center py-16 rounded-2xl border border-dashed border-white/10">
              <Camera className="w-12 h-12 text-muted-foreground opacity-40 mx-auto mb-3" />
              <p className="text-muted-foreground">No photos yet. Be the first to upload!</p>
            </div>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {items.map(item => (
                <div key={item.id} className="group relative aspect-square rounded-xl overflow-hidden border border-white/10 bg-black/30">
                  {/* Use thumbnail for videos in grid; full video only in lightbox */}
                  <img
                    src={thumbUrl(item)}
                    alt={item.caption ?? (item.mediaType === 'video' ? 'Video thumbnail' : 'Gallery photo')}
                    className="w-full h-full object-cover cursor-pointer hover:scale-105 transition-transform duration-300"
                    onClick={() => setLightbox(item)}
                    onError={e => { (e.target as HTMLImageElement).src = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>'; }}
                  />
                  {item.mediaType === 'video' && (
                    <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                      <div className="bg-black/50 rounded-full w-10 h-10 flex items-center justify-center">
                        <span className="text-white text-lg pl-0.5">▶</span>
                      </div>
                    </div>
                  )}
                  {!item.approved && (
                    <div className="absolute inset-0 bg-black/60 flex items-center justify-center">
                      <span className="text-xs text-yellow-400 font-semibold bg-yellow-400/20 px-2 py-1 rounded-full border border-yellow-400/40">Pending</span>
                    </div>
                  )}
                  <div className="absolute top-2 right-2 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button
                      title="Copy link"
                      onClick={async e => {
                        e.stopPropagation();
                        const url = `${window.location.origin}${imgUrl(item)}`;
                        await navigator.clipboard.writeText(url);
                        toast({ title: 'Link copied to clipboard' });
                      }}
                      className="p-1.5 bg-black/60 rounded-lg text-white hover:bg-black/80"
                    >
                      <Link2 className="w-3.5 h-3.5" />
                    </button>
                    {item.approved && (
                      <button
                        title="Share to chat"
                        onClick={async e => { e.stopPropagation(); await shareToChat(item); }}
                        className="p-1.5 bg-cyan-500/80 rounded-lg text-white hover:bg-cyan-500"
                      >
                        <MessageCircle className="w-3.5 h-3.5" />
                      </button>
                    )}
                    {isAdmin && !item.approved && (
                      <button onClick={() => approve(item.id)} className="p-1.5 bg-primary rounded-lg text-black hover:bg-primary/80">
                        <CheckCircle2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                    {isAdmin && (
                      <button onClick={() => remove(item.id)} className="p-1.5 bg-red-500/80 rounded-lg text-white hover:bg-red-500">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                  {item.caption && (
                    <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 p-2">
                      <p className="text-xs text-white line-clamp-2">{item.caption}</p>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Lightbox */}
      {lightbox && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={lightbox.caption ? `Media: ${lightbox.caption}` : 'Media viewer'}
          tabIndex={-1}
          onKeyDown={e => { if (e.key === 'Escape') setLightbox(null); }}
          ref={el => { el?.focus(); }}
          className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center p-4 outline-none"
          onClick={() => setLightbox(null)}
        >
          <div className="max-w-4xl max-h-full" onClick={e => e.stopPropagation()}>
            <div className="flex justify-between items-center mb-3">
              <div>
                {lightbox.caption && <p className="text-white font-medium">{lightbox.caption}</p>}
                <p className="text-sm text-muted-foreground">{lightbox.uploaderName} · {new Date(lightbox.createdAt).toLocaleDateString()}</p>
              </div>
              <button
                onClick={() => setLightbox(null)}
                aria-label="Close media viewer"
                className="text-muted-foreground hover:text-white p-2"
              ><X aria-hidden="true" className="w-5 h-5" /></button>
            </div>
            {lightbox.mediaType === 'video' ? (
              <video src={imgUrl(lightbox)} controls autoPlay className="max-w-full max-h-[75vh] rounded-xl" />
            ) : (
              <img src={imgUrl(lightbox)} alt={lightbox.caption ?? ''} className="max-w-full max-h-[75vh] rounded-xl object-contain" />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────── */
/* Chat Tab                                                            */
/* ─────────────────────────────────────────────────────────────────── */

interface ChatRoom { id: number; enabled: boolean; type: string; entityId: number; mutedUserIds: number[]; organizationId: number; }
interface ChatMessage { id: number; roomId: number; userId: number | null; displayName: string; body: string; messageType: string; mediaId: number | null; reactions: Record<string, number[]>; isPinned: boolean; createdAt: string; }

function ChatTab({ orgId, type, entityId, isAdmin, currentUserName }: {
  orgId: number; type: string; entityId: number; isAdmin: boolean; currentUserName?: string;
}) {
  const { toast } = useToast();
  const [room, setRoom] = useState<ChatRoom | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const esRef = useRef<EventSource | null>(null);

  const fetchRoom = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`/api/organizations/${orgId}/chat/${type}/${entityId}`, { credentials: 'include' });
      if (r.ok) {
        const data = await r.json() as { room: ChatRoom; messages: ChatMessage[] };
        setRoom(data.room);
        setMessages(data.messages);
      }
    } finally { setLoading(false); }
  }, [orgId, type, entityId]);

  useEffect(() => { fetchRoom(); }, [fetchRoom]);

  useEffect(() => {
    if (!room) return;
    esRef.current?.close();
    const es = new EventSource(`/api/sse/chat/${room.id}`);
    es.onmessage = (e) => {
      try {
        const { type: evType, data } = JSON.parse(e.data) as { type: string; data: ChatMessage };
        if (evType === 'chat_message') {
          setMessages(prev => {
            const idx = prev.findIndex(m => m.id === data.id);
            if (idx >= 0) { const next = [...prev]; next[idx] = data; return next; }
            return [...prev, data];
          });
        }
      } catch { /* ignore parse errors */ }
    };
    esRef.current = es;
    return () => { es.close(); };
  }, [room?.id]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!body.trim() || !room) return;
    setSending(true);
    try {
      const r = await fetch(`/api/organizations/${orgId}/chat/${type}/${entityId}/messages`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: body.trim() }),
      });
      if (!r.ok) throw new Error('Send failed');
      setBody('');
    } catch {
      toast({ title: 'Failed to send message', variant: 'destructive' });
    } finally { setSending(false); }
  };

  const togglePin = async (msg: ChatMessage) => {
    await fetch(`/api/organizations/${orgId}/chat/messages/${msg.id}/pin`, {
      method: 'PATCH', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pinned: !msg.isPinned }),
    });
    fetchRoom();
  };

  const deleteMsg = async (id: number) => {
    await fetch(`/api/organizations/${orgId}/chat/messages/${id}`, { method: 'DELETE', credentials: 'include' });
    setMessages(prev => prev.filter(m => m.id !== id));
  };

  const reactToMsg = async (msg: ChatMessage, emoji: string) => {
    const r = await fetch(`/api/organizations/${orgId}/chat/messages/${msg.id}/react`, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ emoji }),
    });
    if (r.ok) {
      const updated = await r.json() as ChatMessage;
      setMessages(prev => prev.map(m => m.id === updated.id ? updated : m));
    }
  };

  const toggleRoom = async () => {
    if (!room) return;
    const r = await fetch(`/api/organizations/${orgId}/chat/${type}/${entityId}/toggle`, {
      method: 'PATCH', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: !room.enabled }),
    });
    if (r.ok) { const updated = await r.json(); setRoom(updated); }
  };

  const clearChat = async () => {
    if (!confirm('Clear all chat messages? This cannot be undone.')) return;
    await fetch(`/api/organizations/${orgId}/chat/${type}/${entityId}/messages`, { method: 'DELETE', credentials: 'include' });
    setMessages([]);
    toast({ title: 'Chat cleared' });
  };

  const toggleMute = async (msg: ChatMessage) => {
    if (!msg.userId || !room) return;
    const isMuted = (room.mutedUserIds ?? []).includes(msg.userId);
    const method = isMuted ? 'DELETE' : 'POST';
    const r = await fetch(`/api/organizations/${orgId}/chat/${type}/${entityId}/mute/${msg.userId}`, {
      method, credentials: 'include',
    });
    if (r.ok) {
      const data = await r.json() as { mutedUserIds: number[] };
      setRoom(prev => prev ? { ...prev, mutedUserIds: data.mutedUserIds } : prev);
      toast({ title: isMuted ? `${msg.displayName} unmuted` : `${msg.displayName} muted` });
    }
  };

  const pinnedMessages = messages.filter(m => m.isPinned);

  if (loading) return <div className="flex items-center justify-center h-64"><div className="w-8 h-8 border-2 border-cyan-400/30 border-t-cyan-400 rounded-full animate-spin" /></div>;

  return (
    <Card className="glass-card">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-white flex items-center gap-2"><MessageCircle className="w-5 h-5 text-cyan-400" /> Tournament Chat</CardTitle>
          {isAdmin && room && (
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={clearChat} className="border-red-500/30 text-red-400 hover:bg-red-500/10">
                <Trash2 className="w-3.5 h-3.5 mr-1" /> Clear
              </Button>
              <Button size="sm" variant="outline" onClick={toggleRoom}
                className={room.enabled ? 'border-red-500/30 text-red-400 hover:bg-red-500/10' : 'border-primary/30 text-primary hover:bg-primary/10'}>
                {room.enabled ? 'Disable Chat' : 'Enable Chat'}
              </Button>
            </div>
          )}
        </div>
        {room && !room.enabled && (
          <p className="text-sm text-yellow-400 bg-yellow-400/10 border border-yellow-400/20 rounded-lg px-3 py-2 mt-2">Chat is currently disabled for this tournament.</p>
        )}
      </CardHeader>
      <CardContent className="p-0">
        {pinnedMessages.length > 0 && (
          <div className="mx-4 mb-3 p-3 rounded-xl bg-yellow-400/10 border border-yellow-400/20">
            <p className="text-xs text-yellow-400 font-semibold uppercase tracking-wider mb-2">📌 Pinned</p>
            {pinnedMessages.map(m => (
              <p key={m.id} className="text-sm text-white"><span className="text-yellow-400 font-medium">{m.displayName}:</span> {m.body}</p>
            ))}
          </div>
        )}

        <div className="h-96 overflow-y-auto px-4 space-y-3 py-3">
          {messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-center">
              <MessageCircle className="w-12 h-12 text-muted-foreground opacity-30 mb-3" />
              <p className="text-muted-foreground">No messages yet. Start the conversation!</p>
            </div>
          ) : (
            messages.map(msg => {
              const msgReactions = msg.reactions ?? {};
              const reactionEntries = Object.entries(msgReactions);
              const QUICK_EMOJIS = ['👍', '❤️', '😂', '🎉', '🏌️'];
              return (
                <div key={msg.id} className={`flex gap-3 group ${msg.isPinned ? 'opacity-60' : ''}`}>
                  <div className="w-8 h-8 rounded-full bg-gradient-to-br from-cyan-500/30 to-primary/30 flex items-center justify-center flex-shrink-0 border border-white/10">
                    <span className="text-xs font-bold text-white">{msg.displayName[0]?.toUpperCase()}</span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className="text-xs font-semibold text-cyan-400">{msg.displayName}</span>
                      <span className="text-xs text-muted-foreground">{new Date(msg.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                      {msg.isPinned && <span className="text-xs text-yellow-400">📌</span>}
                      {isAdmin && msg.userId && (room?.mutedUserIds ?? []).includes(msg.userId) && (
                        <span className="text-xs text-orange-400 bg-orange-400/10 px-1.5 py-0.5 rounded">muted</span>
                      )}
                    </div>
                    {msg.messageType === 'gallery-share' ? (
                      <div className="flex items-center gap-2 p-2 rounded-lg bg-cyan-500/10 border border-cyan-500/20">
                        <span className="text-lg">🖼️</span>
                        <p className="text-sm text-white/90 break-words">{msg.body}</p>
                      </div>
                    ) : (
                      <p className="text-sm text-white/90 break-words">{msg.body}</p>
                    )}
                    {/* Reaction display */}
                    {reactionEntries.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-1">
                        {reactionEntries.map(([emoji, uids]) => (
                          <button key={emoji} onClick={() => reactToMsg(msg, emoji)}
                            className="flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-white/5 hover:bg-white/10 text-xs text-white/80 border border-white/10">
                            {emoji} <span className="text-white/50">{uids.length}</span>
                          </button>
                        ))}
                      </div>
                    )}
                    {/* Quick emoji picker (visible on hover) */}
                    <div className="flex gap-0.5 mt-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      {QUICK_EMOJIS.map(e => (
                        <button key={e} onClick={() => reactToMsg(msg, e)}
                          className="text-xs px-1 py-0.5 rounded hover:bg-white/10 text-white/50 hover:text-white">
                          {e}
                        </button>
                      ))}
                    </div>
                  </div>
                  {isAdmin && (
                    <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
                      <button onClick={() => togglePin(msg)} aria-label={msg.isPinned ? 'Unpin message' : 'Pin message'} title="Pin message" className="p-1 rounded hover:bg-yellow-400/10 text-muted-foreground hover:text-yellow-400">
                        <Bell aria-hidden="true" className="w-3.5 h-3.5" />
                      </button>
                      {msg.userId && (
                        <button onClick={() => toggleMute(msg)}
                          aria-label={(room?.mutedUserIds ?? []).includes(msg.userId!) ? 'Unmute player' : 'Mute player'}
                          title={(room?.mutedUserIds ?? []).includes(msg.userId!) ? 'Unmute player' : 'Mute player'}
                          className={`p-1 rounded transition-colors ${(room?.mutedUserIds ?? []).includes(msg.userId!) ? 'text-orange-400 hover:text-orange-300' : 'text-muted-foreground hover:text-orange-400 hover:bg-orange-400/10'}`}>
                          <VolumeX aria-hidden="true" className="w-3.5 h-3.5" />
                        </button>
                      )}
                      <button onClick={() => deleteMsg(msg.id)} aria-label="Delete message" title="Delete message" className="p-1 rounded hover:bg-red-500/10 text-muted-foreground hover:text-red-400">
                        <Trash2 aria-hidden="true" className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  )}
                </div>
              );
            })
          )}
          <div ref={bottomRef} />
        </div>

        {(!room || room.enabled) && (
          <form onSubmit={send} className="flex gap-2 p-4 border-t border-white/10">
            <Input
              value={body}
              onChange={e => setBody(e.target.value)}
              placeholder="Type a message..."
              className="bg-black/40 border-white/10 text-white flex-1"
              maxLength={1000}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(e as unknown as React.FormEvent); } }}
            />
            <Button type="submit" disabled={sending || !body.trim()} className="bg-cyan-600 hover:bg-cyan-700 text-white">
              <Send className="w-4 h-4" />
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}

// ─── SPONSORS TAB ─────────────────────────────────────────────────────────────

interface SponsorAnalytics {
  impressions: number; clicks: number; ctr: number; days: number;
  bySource: { source: string; eventType: string; total: number }[];
  byDay: { day: string; eventType: string; total: number }[];
  from: string; to: string; allTournaments: boolean;
}

function SponsorAnalyticsPanel({ orgId, tournamentId, sponsorId, sponsorName }: { orgId: number; tournamentId: number; sponsorId: number; sponsorName: string }) {
  const today = new Date().toISOString().slice(0, 10);
  const thirtyAgo = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);

  const [preset, setPreset] = useState<7 | 30 | 90 | 'custom'>(30);
  const [fromDate, setFromDate] = useState(thirtyAgo);
  const [toDate, setToDate] = useState(today);
  const [allTournaments, setAllTournaments] = useState(false);
  const [data, setData] = useState<SponsorAnalytics | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    let url: string;
    if (preset === 'custom') {
      url = `/api/organizations/${orgId}/tournaments/${tournamentId}/sponsors/analytics/${sponsorId}?from=${fromDate}&to=${toDate}&allTournaments=${allTournaments}`;
    } else {
      url = `/api/organizations/${orgId}/tournaments/${tournamentId}/sponsors/analytics/${sponsorId}?days=${preset}&allTournaments=${allTournaments}`;
    }
    fetch(url, { credentials: 'include' })
      .then(r => r.ok ? r.json() : null)
      .then(d => setData(d))
      .finally(() => setLoading(false));
  }, [orgId, tournamentId, sponsorId, preset, fromDate, toDate, allTournaments]);

  const exportCsv = () => {
    if (!data) return;
    const rows = [
      ['Date', 'Event Type', 'Count'],
      ...data.byDay.map(r => [r.day, r.eventType, String(r.total)]),
    ];
    const csv = rows.map(r => r.join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${sponsorName.replace(/\s+/g, '_')}_analytics.csv`;
    a.click();
  };

  const sourceData = (() => {
    if (!data) return [];
    const sources = Array.from(new Set(data.bySource.map(r => r.source)));
    return sources.map(src => ({
      source: src,
      impressions: data.bySource.filter(r => r.source === src && r.eventType === 'impression').reduce((a, r) => a + Number(r.total), 0),
      clicks: data.bySource.filter(r => r.source === src && r.eventType === 'click').reduce((a, r) => a + Number(r.total), 0),
    }));
  })();

  const trendData = (() => {
    if (!data) return [];
    const dayMap = new Map<string, { impressions: number; clicks: number }>();
    for (const r of data.byDay) {
      const entry = dayMap.get(r.day) ?? { impressions: 0, clicks: 0 };
      if (r.eventType === 'impression') entry.impressions += Number(r.total);
      else entry.clicks += Number(r.total);
      dayMap.set(r.day, entry);
    }
    return Array.from(dayMap.entries()).map(([day, v]) => ({ day: day.slice(5), ...v }));
  })();

  return (
    <Card className="glass-card border-amber-500/20 mt-6">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <CardTitle className="text-white flex items-center gap-2">
            <BarChart2 className="w-4 h-4 text-amber-400" /> Analytics · {sponsorName}
          </CardTitle>
          <div className="flex items-center gap-2 flex-wrap">
            {/* Preset buttons */}
            {([7, 30, 90] as const).map(d => (
              <button key={d} onClick={() => setPreset(d)}
                className={`px-2.5 py-1 rounded text-xs font-semibold transition-all ${preset === d ? 'bg-amber-500/30 text-amber-300 border border-amber-500/40' : 'bg-white/5 text-muted-foreground border border-white/10 hover:text-white'}`}>
                {d}d
              </button>
            ))}
            <button onClick={() => setPreset('custom')}
              className={`px-2.5 py-1 rounded text-xs font-semibold transition-all ${preset === 'custom' ? 'bg-amber-500/30 text-amber-300 border border-amber-500/40' : 'bg-white/5 text-muted-foreground border border-white/10 hover:text-white'}`}>
              Custom
            </button>
            {/* Tournament scope toggle */}
            <button onClick={() => setAllTournaments(v => !v)}
              className={`px-2.5 py-1 rounded text-xs font-semibold transition-all ${allTournaments ? 'bg-blue-500/30 text-blue-300 border border-blue-500/40' : 'bg-white/5 text-muted-foreground border border-white/10 hover:text-white'}`}>
              {allTournaments ? 'All Tournaments' : 'This Tournament'}
            </button>
            <button onClick={exportCsv} disabled={!data} className="flex items-center gap-1.5 px-2.5 py-1 rounded text-xs bg-white/5 border border-white/10 text-muted-foreground hover:text-white transition-colors">
              <FileDown className="w-3.5 h-3.5" /> CSV
            </button>
          </div>
        </div>
        {/* Custom date range pickers */}
        {preset === 'custom' && (
          <div className="flex items-center gap-3 mt-3">
            <div className="flex items-center gap-2">
              <label className="text-xs text-muted-foreground">From</label>
              <input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)} max={toDate}
                className="bg-black/40 border border-white/10 text-white text-xs rounded px-2 py-1" />
            </div>
            <div className="flex items-center gap-2">
              <label className="text-xs text-muted-foreground">To</label>
              <input type="date" value={toDate} onChange={e => setToDate(e.target.value)} min={fromDate} max={today}
                className="bg-black/40 border border-white/10 text-white text-xs rounded px-2 py-1" />
            </div>
          </div>
        )}
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="flex items-center justify-center h-32 text-muted-foreground text-sm">Loading analytics…</div>
        ) : !data ? (
          <div className="text-muted-foreground text-sm text-center py-8">No analytics data available</div>
        ) : (
          <div className="space-y-6">
            {/* KPI row */}
            <div className="grid grid-cols-3 gap-4">
              {[
                { label: 'Impressions', value: data.impressions.toLocaleString(), color: 'text-amber-400', icon: '👁' },
                { label: 'Clicks', value: data.clicks.toLocaleString(), color: 'text-emerald-400', icon: '🖱' },
                { label: 'CTR', value: `${data.ctr}%`, color: 'text-cyan-400', icon: '📊' },
              ].map(kpi => (
                <div key={kpi.label} className="rounded-xl bg-black/30 border border-white/5 p-4 text-center">
                  <div className="text-xl mb-1">{kpi.icon}</div>
                  <div className={`text-2xl font-bold ${kpi.color}`}>{kpi.value}</div>
                  <div className="text-xs text-muted-foreground mt-1">{kpi.label}</div>
                </div>
              ))}
            </div>

            {/* Source breakdown bar chart */}
            {sourceData.length > 0 && (
              <div>
                <p className="text-xs text-muted-foreground uppercase tracking-wider mb-3 font-semibold">By Source</p>
                <ResponsiveContainer width="100%" height={180}>
                  <BarChart data={sourceData} barSize={20}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                    <XAxis dataKey="source" tick={{ fill: '#6b7280', fontSize: 11 }} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fill: '#6b7280', fontSize: 11 }} axisLine={false} tickLine={false} />
                    <Tooltip contentStyle={{ background: '#0a1628', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, color: '#fff', fontSize: 12 }} />
                    <Bar dataKey="impressions" fill="#C9A84C" radius={[3, 3, 0, 0]} name="Impressions" />
                    <Bar dataKey="clicks" fill="#22c55e" radius={[3, 3, 0, 0]} name="Clicks" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}

            {/* Daily trend line chart */}
            {trendData.length > 0 && (
              <div>
                <p className="text-xs text-muted-foreground uppercase tracking-wider mb-3 font-semibold">
                  Trend · {data.from} → {data.to}
                </p>
                <ResponsiveContainer width="100%" height={160}>
                  <LineChart data={trendData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                    <XAxis dataKey="day" tick={{ fill: '#6b7280', fontSize: 10 }} axisLine={false} tickLine={false} interval="preserveStartEnd" />
                    <YAxis tick={{ fill: '#6b7280', fontSize: 10 }} axisLine={false} tickLine={false} />
                    <Tooltip contentStyle={{ background: '#0a1628', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, color: '#fff', fontSize: 12 }} />
                    <Line type="monotone" dataKey="impressions" stroke="#C9A84C" strokeWidth={2} dot={false} name="Impressions" />
                    <Line type="monotone" dataKey="clicks" stroke="#22c55e" strokeWidth={2} dot={false} name="Clicks" />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}

            {data.impressions === 0 && data.clicks === 0 && (
              <div className="text-center py-4 text-muted-foreground text-sm">
                No events recorded in this period. Impressions are tracked when sponsor logos appear on public leaderboards, scorecards, and display screens.
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function SponsorsTab({ orgId, tournamentId, isAdmin }: { orgId: number; tournamentId: number; isAdmin: boolean }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [addOpen, setAddOpen] = useState(false);
  const [form, setForm] = useState({ name: '', tier: 'gold', logoUrl: '', websiteUrl: '', description: '' });
  const [saving, setSaving] = useState(false);
  const [analyticsId, setAnalyticsId] = useState<number | null>(null);

  const { data: sponsors = [], isLoading } = useQuery({
    queryKey: [`/api/organizations/${orgId}/tournaments/${tournamentId}/sponsors`],
    queryFn: () => fetch(`/api/organizations/${orgId}/tournaments/${tournamentId}/sponsors`).then(r => { if (!r.ok) throw new Error('Request failed'); return r.json(); }),
  }) as { data: Array<{ id: number; name: string; tier: string; logoUrl: string | null; websiteUrl: string | null; description: string | null; isActive: boolean; holeNumbers: number[] }>, isLoading: boolean };

  const tierColors: Record<string, string> = {
    title: 'bg-amber-500/20 text-amber-400 border-amber-500/30',
    gold: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30',
    silver: 'bg-slate-400/20 text-slate-300 border-slate-400/30',
    bronze: 'bg-orange-700/20 text-orange-400 border-orange-700/30',
    hole: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30',
    prize: 'bg-rose-500/20 text-rose-400 border-rose-500/30',
  };

  const save = async () => {
    if (!form.name.trim()) { toast({ title: "Name required", variant: "destructive" }); return; }
    setSaving(true);
    try {
      const res = await fetch(`/api/organizations/${orgId}/tournaments/${tournamentId}/sponsors`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      if (!res.ok) throw new Error((await res.json()).error);
      await queryClient.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/tournaments/${tournamentId}/sponsors`] });
      setAddOpen(false);
      setForm({ name: '', tier: 'gold', logoUrl: '', websiteUrl: '', description: '' });
      toast({ title: "Sponsor added" });
    } catch (e) {
      toast({ title: "Failed", description: (e as Error).message, variant: "destructive" });
    } finally { setSaving(false); }
  };

  const deleteSponsor = async (id: number) => {
    if (analyticsId === id) setAnalyticsId(null);
    await fetch(`/api/organizations/${orgId}/tournaments/${tournamentId}/sponsors/${id}`, { method: 'DELETE' });
    queryClient.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/tournaments/${tournamentId}/sponsors`] });
    toast({ title: "Sponsor removed" });
  };

  if (isLoading) return <div className="flex items-center justify-center h-48 text-muted-foreground">Loading sponsors...</div>;

  const analyticsSelected = analyticsId !== null ? sponsors.find(s => s.id === analyticsId) : null;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-display font-bold text-white">Tournament Sponsors</h2>
          <p className="text-sm text-muted-foreground mt-0.5">Manage sponsors displayed on leaderboards and scorecards</p>
        </div>
        {isAdmin && (
          <Button onClick={() => setAddOpen(true)} className="bg-amber-600 hover:bg-amber-700 text-white gap-2">
            <Plus className="w-4 h-4" /> Add Sponsor
          </Button>
        )}
      </div>

      {sponsors.length === 0 ? (
        <Card className="glass-card">
          <CardContent className="flex flex-col items-center justify-center py-16 text-center">
            <Star className="w-12 h-12 text-amber-500/40 mb-4" />
            <p className="text-white font-semibold mb-1">No sponsors yet</p>
            <p className="text-muted-foreground text-sm">Add your first sponsor to display logos on leaderboards and printed scorecards.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {sponsors.map(s => (
            <Card key={s.id} className={`glass-card cursor-pointer transition-all ${analyticsId === s.id ? 'ring-1 ring-amber-500/60' : 'hover:border-white/10'}`}
              onClick={() => setAnalyticsId(analyticsId === s.id ? null : s.id)}>
              <CardContent className="p-5">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-3 min-w-0">
                    {s.logoUrl ? (
                      <img src={s.logoUrl} alt={s.name} className="w-12 h-12 object-contain rounded bg-white/5 p-1 flex-shrink-0" />
                    ) : (
                      <div className="w-12 h-12 rounded bg-white/5 flex items-center justify-center flex-shrink-0">
                        <Star className="w-5 h-5 text-amber-400" />
                      </div>
                    )}
                    <div className="min-w-0">
                      <div className="font-semibold text-white truncate">{s.name}</div>
                      <Badge className={`text-xs mt-1 border ${tierColors[s.tier] ?? tierColors.gold}`}>{s.tier.toUpperCase()}</Badge>
                    </div>
                  </div>
                  <div className="flex items-center gap-1 flex-shrink-0">
                    <button onClick={e => { e.stopPropagation(); setAnalyticsId(analyticsId === s.id ? null : s.id); }}
                      className={`p-1.5 rounded transition-colors ${analyticsId === s.id ? 'text-amber-400 bg-amber-500/10' : 'text-muted-foreground hover:text-amber-400 hover:bg-amber-500/10'}`}
                      title="View analytics">
                      <BarChart2 className="w-3.5 h-3.5" />
                    </button>
                    {isAdmin && (
                      <button onClick={e => { e.stopPropagation(); deleteSponsor(s.id); }} className="p-1.5 rounded text-muted-foreground hover:text-destructive transition-colors">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                </div>
                {s.description && <p className="text-muted-foreground text-xs mt-3">{s.description}</p>}
                {s.websiteUrl && (
                  <a href={s.websiteUrl} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()} className="flex items-center gap-1.5 text-xs text-primary hover:underline mt-2">
                    <ExternalLink className="w-3 h-3" /> {s.websiteUrl.replace(/^https?:\/\//, '')}
                  </a>
                )}
                {s.holeNumbers && s.holeNumbers.length > 0 && (
                  <div className="mt-3 flex flex-wrap gap-1">
                    {s.holeNumbers.map(h => <span key={h} className="bg-emerald-500/20 text-emerald-400 text-xs px-1.5 py-0.5 rounded">Hole {h}</span>)}
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {analyticsSelected && (
        <SponsorAnalyticsPanel
          orgId={orgId}
          tournamentId={tournamentId}
          sponsorId={analyticsSelected.id}
          sponsorName={analyticsSelected.name}
        />
      )}

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="bg-[#0a1628] border border-white/10 text-white max-w-lg">
          <DialogHeader><DialogTitle>Add Sponsor</DialogTitle></DialogHeader>
          <div className="space-y-4 mt-2">
            <div><label className="text-xs text-muted-foreground uppercase tracking-wider">Sponsor Name *</label>
              <Input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} className="mt-1 bg-black/40 border-white/10 text-white" /></div>
            <div><label className="text-xs text-muted-foreground uppercase tracking-wider">Tier</label>
              <Select value={form.tier} onValueChange={v => setForm(f => ({ ...f, tier: v }))}>
                <SelectTrigger className="mt-1 bg-black/40 border-white/10 text-white"><SelectValue /></SelectTrigger>
                <SelectContent className="bg-[#0a1628] border-white/10 text-white">
                  {['title', 'gold', 'silver', 'bronze', 'hole', 'prize'].map(t => <SelectItem key={t} value={t} className="text-white hover:bg-white/5">{t.charAt(0).toUpperCase() + t.slice(1)}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div><label className="text-xs text-muted-foreground uppercase tracking-wider">Logo URL</label>
              <Input value={form.logoUrl} onChange={e => setForm(f => ({ ...f, logoUrl: e.target.value }))} placeholder="https://..." className="mt-1 bg-black/40 border-white/10 text-white" /></div>
            <div><label className="text-xs text-muted-foreground uppercase tracking-wider">Website URL</label>
              <Input value={form.websiteUrl} onChange={e => setForm(f => ({ ...f, websiteUrl: e.target.value }))} placeholder="https://..." className="mt-1 bg-black/40 border-white/10 text-white" /></div>
            <div><label className="text-xs text-muted-foreground uppercase tracking-wider">Description</label>
              <Input value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} className="mt-1 bg-black/40 border-white/10 text-white" /></div>
            <div className="flex gap-3 pt-2">
              <Button onClick={save} disabled={saving} className="flex-1 bg-amber-600 hover:bg-amber-700 text-white">{saving ? 'Saving…' : 'Add Sponsor'}</Button>
              <Button variant="outline" onClick={() => setAddOpen(false)} className="border-white/10 text-white hover:bg-white/5">Cancel</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── PRIZES TAB ───────────────────────────────────────────────────────────────
const PAYOUT_PRESETS: Record<string, { position: number; percentage: number }[]> = {
  'Top 3': [{ position: 1, percentage: 50 }, { position: 2, percentage: 30 }, { position: 3, percentage: 20 }],
  'Top 5': [{ position: 1, percentage: 40 }, { position: 2, percentage: 25 }, { position: 3, percentage: 15 }, { position: 4, percentage: 12 }, { position: 5, percentage: 8 }],
  'Top 10': [{ position: 1, percentage: 30 }, { position: 2, percentage: 20 }, { position: 3, percentage: 13 }, { position: 4, percentage: 10 }, { position: 5, percentage: 8 }, { position: 6, percentage: 6 }, { position: 7, percentage: 5 }, { position: 8, percentage: 4 }, { position: 9, percentage: 3 }, { position: 10, percentage: 1 }],
  'Winner Only': [{ position: 1, percentage: 100 }],
  'Top 2': [{ position: 1, percentage: 60 }, { position: 2, percentage: 40 }],
  'Net/Gross Split': [{ position: 1, percentage: 30 }, { position: 2, percentage: 20 }, { position: 3, percentage: 13 }, { position: 4, percentage: 10 }, { position: 5, percentage: 7 }],
};

// ─── Replay Tab ─────────────────────────────────────────────────────────────

function ReplayTab({ orgId, tournamentId, tournament }: { orgId: number; tournamentId: number; tournament: { rounds?: number | null } }) {
  const rounds = tournament.rounds ?? 1;
  const [selectedPlayerId, setSelectedPlayerId] = useState<number | null>(null);
  const BASE_URL = (import.meta.env.BASE_URL ?? '/').replace(/\/$/, '');

  const { data: players = [] } = useQuery<{ id: number; name: string; teamName: string | null }[]>({
    queryKey: ['replay-players', orgId, tournamentId],
    queryFn: async () => {
      const res = await fetch(`${BASE_URL}/api/organizations/${orgId}/tournaments/${tournamentId}/players`, { credentials: 'include' });
      if (!res.ok) return [];
      const data = await res.json();
      return Array.isArray(data) ? data : (data.players ?? []);
    },
  });

  const selectedPlayer = players.find(p => p.id === selectedPlayerId);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-white font-bold text-xl mb-1">Round Replay</h2>
        <p className="text-sm text-muted-foreground">Visualise shot-by-shot tracking data for any player's round</p>
      </div>

      {/* Player selector */}
      <div className="max-w-sm">
        <Select value={selectedPlayerId?.toString() ?? ''} onValueChange={v => setSelectedPlayerId(parseInt(v))}>
          <SelectTrigger className="bg-white/5 border-white/10 text-white">
            <SelectValue placeholder="Select a player to replay…" />
          </SelectTrigger>
          <SelectContent>
            {players.map(p => (
              <SelectItem key={p.id} value={p.id.toString()}>{p.name || p.teamName || `Player #${p.id}`}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {selectedPlayer && selectedPlayerId ? (
        <HoleReplayMap
          orgId={orgId}
          tournamentId={tournamentId}
          playerId={selectedPlayerId}
          playerName={selectedPlayer.name || selectedPlayer.teamName || `Player #${selectedPlayerId}`}
          rounds={rounds}
        />
      ) : (
        <Card className="glass-panel p-12 text-center border-dashed">
          <MapIcon className="w-12 h-12 text-muted-foreground mx-auto mb-3 opacity-40" />
          <p className="text-white font-medium">Select a player to view their round replay</p>
          <p className="text-sm text-muted-foreground mt-1">Shot tracking data from GPS wearables and GPX uploads is displayed hole by hole.</p>
        </Card>
      )}
    </div>
  );
}

type PayoutPreviewItem = { position: number; percentage: number; grossAmount: number; currency: string; playerId: number | null; playerName: string | null; grossScore: number | null };

function PrizesTab({ orgId, tournamentId, isAdmin }: { orgId: number; tournamentId: number; isAdmin: boolean }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [addCatOpen, setAddCatOpen] = useState(false);
  const [awardOpen, setAwardOpen] = useState<number | null>(null);
  const [catForm, setCatForm] = useState({ name: '', description: '', prizeValue: '', currency: 'INR' });
  const [awardForm, setAwardForm] = useState({ playerName: '', notes: '' });
  const [saving, setSaving] = useState(false);
  const [calcOpen, setCalcOpen] = useState(false);
  const [payoutRows, setPayoutRows] = useState<{ position: number; percentage: number }[]>(PAYOUT_PRESETS['Top 3']);
  const [preview, setPreview] = useState<{ prizePool: number; currency: string; paidCount: number; preview: PayoutPreviewItem[] } | null>(null);
  const [calculating, setCalculating] = useState(false);
  const [assigning, setAssigning] = useState(false);
  const [assigned, setAssigned] = useState(false);
  const [alreadyDistributed, setAlreadyDistributed] = useState(false);

  const { data: prizesData, isLoading } = useQuery({
    queryKey: [`/api/organizations/${orgId}/tournaments/${tournamentId}/prizes`],
    queryFn: () => fetch(`/api/organizations/${orgId}/tournaments/${tournamentId}/prizes`).then(r => { if (!r.ok) throw new Error('Request failed'); return r.json(); }),
  }) as {
    data: { prizeDistributionStatus: string | null; categories: Array<{ id: number; name: string; description: string | null; prizeValue: string | null; currency: string; awards: Array<{ id: number; playerName: string; awardAmount: string | null; awardCurrency: string | null; notes: string | null }> }> } | undefined,
    isLoading: boolean
  };
  const categories = prizesData?.categories ?? [];

  // Proactively set distributed state from API response on load
  useEffect(() => {
    if (prizesData?.prizeDistributionStatus === 'distributed') {
      setAlreadyDistributed(true);
    }
  }, [prizesData?.prizeDistributionStatus]);

  const saveCat = async () => {
    if (!catForm.name.trim()) { toast({ title: "Name required", variant: "destructive" }); return; }
    setSaving(true);
    try {
      const res = await fetch(`/api/organizations/${orgId}/tournaments/${tournamentId}/prizes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(catForm),
      });
      if (!res.ok) throw new Error((await res.json()).error);
      await queryClient.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/tournaments/${tournamentId}/prizes`] });
      setAddCatOpen(false);
      setCatForm({ name: '', description: '', prizeValue: '', currency: 'INR' });
      toast({ title: "Prize category added" });
    } catch (e) { toast({ title: "Failed", description: (e as Error).message, variant: "destructive" }); }
    finally { setSaving(false); }
  };

  const saveAward = async (prizeId: number) => {
    if (!awardForm.playerName.trim()) { toast({ title: "Player name required", variant: "destructive" }); return; }
    setSaving(true);
    try {
      const res = await fetch(`/api/organizations/${orgId}/tournaments/${tournamentId}/prizes/${prizeId}/award`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(awardForm),
      });
      if (!res.ok) throw new Error((await res.json()).error);
      await queryClient.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/tournaments/${tournamentId}/prizes`] });
      setAwardOpen(null);
      setAwardForm({ playerName: '', notes: '' });
      toast({ title: "Prize awarded!" });
    } catch (e) { toast({ title: "Failed", description: (e as Error).message, variant: "destructive" }); }
    finally { setSaving(false); }
  };

  const deleteCat = async (id: number) => {
    await fetch(`/api/organizations/${orgId}/tournaments/${tournamentId}/prizes/${id}`, { method: 'DELETE' });
    queryClient.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/tournaments/${tournamentId}/prizes`] });
    toast({ title: "Prize category removed" });
  };

  const downloadCertificate = (prizeId: number, awardId: number) => {
    window.open(`/api/organizations/${orgId}/tournaments/${tournamentId}/prizes/${prizeId}/award/${awardId}/certificate`, '_blank');
  };

  const currencySymbol: Record<string, string> = { INR: '₹', USD: '$', GBP: '£', EUR: '€', AED: 'د.إ' };

  const savePayout = async (): Promise<boolean> => {
    const total = payoutRows.reduce((s, r) => s + r.percentage, 0);
    if (Math.abs(total - 100) > 0.01) { toast({ title: `Percentages must sum to 100% (currently ${total.toFixed(1)}%)`, variant: 'destructive' }); return false; }
    const res = await fetch(`/api/organizations/${orgId}/tournaments/${tournamentId}/prizes/payout-structure`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ payoutStructure: payoutRows }), credentials: 'include',
    });
    if (!res.ok) { toast({ title: 'Failed to save structure', variant: 'destructive' }); return false; }
    toast({ title: 'Payout structure saved' });
    return true;
  };

  const calculatePreview = async () => {
    setCalculating(true); setPreview(null);
    try {
      const saved = await savePayout();
      if (!saved) return;
      const res = await fetch(`/api/organizations/${orgId}/tournaments/${tournamentId}/prizes/calculate-payouts`, {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
      });
      if (!res.ok) { const e = await res.json(); toast({ title: e.error ?? 'Calculation failed', variant: 'destructive' }); return; }
      setPreview(await res.json());
    } finally { setCalculating(false); }
  };

  const autoAssign = async (force = false) => {
    if (!preview) return;
    setAssigning(true);
    try {
      const res = await fetch(`/api/organizations/${orgId}/tournaments/${tournamentId}/prizes/auto-assign-awards`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ preview: preview.preview, forceReassign: force || undefined }), credentials: 'include',
      });
      if (res.status === 409) {
        setAlreadyDistributed(true);
        toast({ title: 'Prizes already distributed', description: 'Click "Force Re-assign" to override.', variant: 'destructive' });
        return;
      }
      if (!res.ok) { toast({ title: 'Failed to assign prizes', variant: 'destructive' }); return; }
      setAssigned(true);
      setAlreadyDistributed(false);
      queryClient.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/tournaments/${tournamentId}/prizes`] });
      toast({ title: 'Prize awards assigned!', description: 'Tournament prize distribution status: Distributed' });
    } finally { setAssigning(false); }
  };

  const exportCsv = () => {
    window.open(`/api/organizations/${orgId}/tournaments/${tournamentId}/prizes/export-payouts.csv`, '_blank');
  };

  const totalPct = payoutRows.reduce((s, r) => s + r.percentage, 0);

  if (isLoading) return <div className="flex items-center justify-center h-48 text-muted-foreground">Loading prizes...</div>;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-display font-bold text-white">Prize Management</h2>
          <p className="text-sm text-muted-foreground mt-0.5">Define prize categories, award winners, and generate certificates</p>
        </div>
        {isAdmin && (
          <Button onClick={() => setAddCatOpen(true)} className="bg-rose-600 hover:bg-rose-700 text-white gap-2">
            <Plus className="w-4 h-4" /> Add Prize Category
          </Button>
        )}
      </div>

      {isAdmin && (
        <Card className="glass-card border-yellow-500/20">
          <CardContent className="p-0">
            <button onClick={() => setCalcOpen(o => !o)} className="w-full flex items-center justify-between p-4 hover:bg-white/[0.02] transition-colors">
              <div className="flex items-center gap-2">
                <Trophy className="w-4 h-4 text-[#C9A84C]" />
                <span className="font-semibold text-white text-sm">Prize Calculator</span>
                <Badge className="bg-yellow-500/10 text-yellow-400 border border-yellow-500/20 text-xs">Auto-Assign</Badge>
              </div>
              <span className="text-muted-foreground text-xs">{calcOpen ? '▲ Hide' : '▼ Show'}</span>
            </button>
            {calcOpen && (
              <div className="px-4 pb-4 border-t border-white/5 pt-4 space-y-4">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-xs text-muted-foreground">Preset:</span>
                  {Object.keys(PAYOUT_PRESETS).map(p => (
                    <button key={p} onClick={() => { setPayoutRows(PAYOUT_PRESETS[p]); setPreview(null); setAssigned(false); }}
                      className="text-xs px-2 py-1 rounded bg-white/5 hover:bg-white/10 text-muted-foreground hover:text-white transition-colors border border-white/10">{p}</button>
                  ))}
                  <button onClick={() => { setPayoutRows(r => [...r, { position: r.length + 1, percentage: 0 }]); setPreview(null); }} className="text-xs px-2 py-1 rounded bg-white/5 hover:bg-white/10 text-muted-foreground hover:text-white border border-white/10">+ Add Row</button>
                </div>
                <div className="space-y-2">
                  {payoutRows.map((row, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground w-16">Position {row.position}</span>
                      <Input type="number" min={0} max={100} step={0.1} value={row.percentage}
                        onChange={e => { const v = parseFloat(e.target.value) || 0; setPayoutRows(r => r.map((x, j) => j === i ? { ...x, percentage: v } : x)); setPreview(null); }}
                        className="w-20 h-7 text-xs bg-black/40 border-white/10 text-white" />
                      <span className="text-xs text-muted-foreground">%</span>
                      <button onClick={() => setPayoutRows(r => r.filter((_, j) => j !== i))} className="text-muted-foreground hover:text-destructive ml-auto"><X className="w-3 h-3" /></button>
                    </div>
                  ))}
                </div>
                <div className={`text-xs font-mono ${Math.abs(totalPct - 100) < 0.01 ? 'text-green-400' : 'text-yellow-400'}`}>Total: {totalPct.toFixed(1)}%</div>
                <Button onClick={calculatePreview} disabled={calculating || Math.abs(totalPct - 100) > 0.01} size="sm"
                  className="bg-[#C9A84C] hover:bg-[#b8943d] text-black font-semibold gap-1">
                  {calculating ? <Loader2 className="w-3 h-3 animate-spin" /> : <BarChart2 className="w-3 h-3" />}
                  {calculating ? 'Calculating…' : 'Calculate & Preview'}
                </Button>
                {preview && (
                  <div className="space-y-3">
                    <div className="text-xs text-muted-foreground">Prize Pool: <span className="text-white font-semibold">{currencySymbol[preview.currency] ?? '₹'}{preview.prizePool.toLocaleString()}</span> from {preview.paidCount} paid players</div>
                    <div className="overflow-x-auto relative">
                      <div className="pointer-events-none absolute top-0 right-0 bottom-0 w-8 bg-gradient-to-l from-black/40 to-transparent z-10" />
                    <Table>
                      <TableHeader>
                        <TableRow className="border-white/5 sticky top-0 z-10 bg-[#0a1628]">
                          <TableHead className="text-muted-foreground text-xs sticky left-0 z-10 bg-[#0a1628]">Pos</TableHead>
                          <TableHead className="text-muted-foreground text-xs">Player</TableHead>
                          <TableHead className="text-muted-foreground text-xs">Score</TableHead>
                          <TableHead className="text-muted-foreground text-xs text-right">%</TableHead>
                          <TableHead className="text-muted-foreground text-xs text-right">Amount</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {preview.preview.map(item => (
                          <TableRow key={item.position} className="border-white/5">
                            <TableCell className="text-white text-xs font-bold sticky left-0 z-10 bg-[#0a1628]">{item.position}</TableCell>
                            <TableCell className="text-white text-xs">{item.playerName ?? <span className="text-muted-foreground italic">TBD</span>}</TableCell>
                            <TableCell className="text-muted-foreground text-xs">{item.grossScore ?? '—'}</TableCell>
                            <TableCell className="text-muted-foreground text-xs text-right">{item.percentage}%</TableCell>
                            <TableCell className="text-[#C9A84C] text-xs text-right font-semibold">{currencySymbol[item.currency] ?? '₹'}{item.grossAmount.toLocaleString()}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                    </div>
                    <div className="flex gap-2 flex-wrap items-center">
                      {alreadyDistributed ? (
                        <>
                          <Badge className="bg-green-500/10 text-green-400 border border-green-500/30 text-xs gap-1">
                            <CheckCircle2 className="w-3 h-3" /> Distributed
                          </Badge>
                          <Button onClick={() => autoAssign(true)} disabled={assigning} size="sm"
                            className="bg-yellow-700 hover:bg-yellow-600 text-white gap-1">
                            {assigning ? <Loader2 className="w-3 h-3 animate-spin" /> : <RotateCcw className="w-3 h-3" />}
                            {assigning ? 'Re-assigning…' : 'Force Re-assign'}
                          </Button>
                        </>
                      ) : (
                        <Button onClick={() => autoAssign(false)} disabled={assigning || assigned} size="sm"
                          className="bg-green-700 hover:bg-green-600 text-white gap-1">
                          {assigning ? <Loader2 className="w-3 h-3 animate-spin" /> : <CheckCircle2 className="w-3 h-3" />}
                          {assigned ? 'Awards Assigned ✓' : (assigning ? 'Assigning…' : 'Auto-Assign Awards')}
                        </Button>
                      )}
                      <Button onClick={exportCsv} size="sm" variant="outline" className="border-white/10 text-white hover:bg-white/5 gap-1">
                        <Download className="w-3 h-3" /> Export CSV
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {categories.length === 0 ? (
        <Card className="glass-card">
          <CardContent className="flex flex-col items-center justify-center py-16 text-center">
            <Award className="w-12 h-12 text-rose-500/40 mb-4" />
            <p className="text-white font-semibold mb-1">No prizes defined</p>
            <p className="text-muted-foreground text-sm">Create prize categories like "Winner", "Runner-up", "Nearest the Pin", etc.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4">
          {categories.map(cat => (
            <Card key={cat.id} className="glass-card">
              <CardContent className="p-5">
                <div className="flex items-start justify-between gap-3 mb-4">
                  <div>
                    <div className="flex items-center gap-2">
                      <Award className="w-5 h-5 text-rose-400" />
                      <span className="font-semibold text-white">{cat.name}</span>
                      {cat.prizeValue && (
                        <Badge className="bg-rose-500/20 text-rose-400 border border-rose-500/30 text-xs">
                          {currencySymbol[cat.currency] ?? '₹'}{parseFloat(cat.prizeValue).toLocaleString()}
                        </Badge>
                      )}
                    </div>
                    {cat.description && <p className="text-muted-foreground text-xs mt-1">{cat.description}</p>}
                  </div>
                  <div className="flex gap-2 flex-shrink-0">
                    {isAdmin && (
                      <>
                        <Button size="sm" onClick={() => { setAwardOpen(cat.id); setAwardForm({ playerName: '', notes: '' }); }}
                          className="bg-rose-600/20 hover:bg-rose-600/40 text-rose-300 border border-rose-500/30 text-xs gap-1">
                          <Plus className="w-3 h-3" /> Award
                        </Button>
                        <button onClick={() => deleteCat(cat.id)} className="text-muted-foreground hover:text-destructive transition-colors">
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </>
                    )}
                  </div>
                </div>

                {cat.awards.length > 0 ? (
                  <div className="space-y-2">
                    {cat.awards.map(a => {
                      const sym = currencySymbol[a.awardCurrency ?? cat.currency] ?? '₹';
                      const amount = a.awardAmount ? parseFloat(a.awardAmount) : null;
                      return (
                        <div key={a.id} className="flex items-center justify-between bg-white/[0.03] rounded-lg px-3 py-2">
                          <div className="flex items-center gap-2">
                            <span className="text-white text-sm font-medium">{a.playerName}</span>
                            {amount != null && (
                              <Badge className="bg-[#C9A84C]/10 text-[#C9A84C] border border-[#C9A84C]/30 text-xs">
                                {sym}{amount.toLocaleString()}
                              </Badge>
                            )}
                            {a.notes && <span className="text-muted-foreground text-xs">— {a.notes}</span>}
                          </div>
                          <Button size="sm" variant="ghost" onClick={() => downloadCertificate(cat.id, a.id)}
                            className="text-muted-foreground hover:text-white h-7 gap-1 text-xs">
                            <FileDown className="w-3 h-3" /> Certificate
                          </Button>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <p className="text-muted-foreground text-xs">No winners assigned yet.</p>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={addCatOpen} onOpenChange={setAddCatOpen}>
        <DialogContent className="bg-[#0a1628] border border-white/10 text-white max-w-md">
          <DialogHeader><DialogTitle>Add Prize Category</DialogTitle></DialogHeader>
          <div className="space-y-4 mt-2">
            <div><label className="text-xs text-muted-foreground uppercase tracking-wider">Category Name *</label>
              <Input value={catForm.name} onChange={e => setCatForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Gross Winner, Nearest the Pin" className="mt-1 bg-black/40 border-white/10 text-white" /></div>
            <div><label className="text-xs text-muted-foreground uppercase tracking-wider">Description</label>
              <Input value={catForm.description} onChange={e => setCatForm(f => ({ ...f, description: e.target.value }))} className="mt-1 bg-black/40 border-white/10 text-white" /></div>
            <div className="flex gap-3">
              <div className="flex-1"><label className="text-xs text-muted-foreground uppercase tracking-wider">Prize Value</label>
                <Input type="number" value={catForm.prizeValue} onChange={e => setCatForm(f => ({ ...f, prizeValue: e.target.value }))} className="mt-1 bg-black/40 border-white/10 text-white" /></div>
              <div className="w-28"><label className="text-xs text-muted-foreground uppercase tracking-wider">Currency</label>
                <Select value={catForm.currency} onValueChange={v => setCatForm(f => ({ ...f, currency: v }))}>
                  <SelectTrigger className="mt-1 bg-black/40 border-white/10 text-white"><SelectValue /></SelectTrigger>
                  <SelectContent className="bg-[#0a1628] border-white/10 text-white">
                    {['INR', 'USD', 'GBP', 'EUR', 'AED'].map(c => <SelectItem key={c} value={c} className="text-white hover:bg-white/5">{c}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="flex gap-3 pt-2">
              <Button onClick={saveCat} disabled={saving} className="flex-1 bg-rose-600 hover:bg-rose-700 text-white">{saving ? 'Saving…' : 'Add Category'}</Button>
              <Button variant="outline" onClick={() => setAddCatOpen(false)} className="border-white/10 text-white hover:bg-white/5">Cancel</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={awardOpen !== null} onOpenChange={o => { if (!o) setAwardOpen(null); }}>
        <DialogContent className="bg-[#0a1628] border border-white/10 text-white max-w-md">
          <DialogHeader><DialogTitle>Award Prize</DialogTitle></DialogHeader>
          <div className="space-y-4 mt-2">
            <div><label className="text-xs text-muted-foreground uppercase tracking-wider">Player Name *</label>
              <Input value={awardForm.playerName} onChange={e => setAwardForm(f => ({ ...f, playerName: e.target.value }))} className="mt-1 bg-black/40 border-white/10 text-white" /></div>
            <div><label className="text-xs text-muted-foreground uppercase tracking-wider">Notes</label>
              <Input value={awardForm.notes} onChange={e => setAwardForm(f => ({ ...f, notes: e.target.value }))} placeholder="Optional" className="mt-1 bg-black/40 border-white/10 text-white" /></div>
            <div className="flex gap-3 pt-2">
              <Button onClick={() => awardOpen !== null && saveAward(awardOpen)} disabled={saving} className="flex-1 bg-rose-600 hover:bg-rose-700 text-white">{saving ? 'Saving…' : 'Award Prize'}</Button>
              <Button variant="outline" onClick={() => setAwardOpen(null)} className="border-white/10 text-white hover:bg-white/5">Cancel</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── Corporate Event Tab ──────────────────────────────────────────────────────

interface CorporateProfile {
  id: number; companyName: string; contactName: string | null; contactEmail: string | null;
  contactPhone: string | null; logoUrl: string | null; primaryColor: string | null; secondaryColor: string | null;
  invoiceAddress: string | null; vatNumber: string | null; purchaseOrderRef: string | null; invoiceNotes: string | null;
}

interface CorporateTeamData {
  id: number; teamName: string; companyName: string; colour: string | null;
  members: Array<{ playerId: number; firstName: string; lastName: string; handicapIndex: string | null }>;
}

interface CorporateLeaderboardEntry {
  position: number; team: { id: number; teamName: string; companyName: string; colour: string | null };
  totalGross: number; totalNet: number; avgGross: number; avgNet: number;
  members: Array<{ playerId: number; firstName: string; lastName: string; gross: number; net: number; holes: number }>;
}

function CorporateEventTab({ orgId, tournamentId, isAdmin }: { orgId: number; tournamentId: number; isAdmin: boolean; players?: any }) {
  const { toast } = useToast();
  const [profile, setProfile] = useState<CorporateProfile | null>(null);
  const [teams, setTeams] = useState<CorporateTeamData[]>([]);
  const [leaderboard, setLeaderboard] = useState<CorporateLeaderboardEntry[]>([]);
  const [availablePlayers, setAvailablePlayers] = useState<Array<{ id: number; firstName: string; lastName: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editingProfile, setEditingProfile] = useState(false);
  const [profileForm, setProfileForm] = useState<Partial<CorporateProfile>>({});
  const [newTeamForm, setNewTeamForm] = useState({ companyName: '', teamName: '', colour: '#22c55e' });
  const [addTeamOpen, setAddTeamOpen] = useState(false);
  const [addMemberTeamId, setAddMemberTeamId] = useState<number | null>(null);
  const [addMemberPlayerId, setAddMemberPlayerId] = useState('');

  useEffect(() => {
    if (!orgId || !tournamentId) return;
    Promise.all([
      fetch(`/api/organizations/${orgId}/tournaments/${tournamentId}/corporate-profile`).then(r => r.json()),
      fetch(`/api/organizations/${orgId}/tournaments/${tournamentId}/corporate-teams`).then(r => r.json()),
      fetch(`/api/organizations/${orgId}/tournaments/${tournamentId}/corporate-leaderboard`).then(r => r.json()).catch(() => []),
      fetch(`/api/organizations/${orgId}/tournaments/${tournamentId}/players`).then(r => r.json()).catch(() => []),
    ]).then(([prof, teamsData, lb, playersData]) => {
      setProfile(prof);
      setTeams(teamsData ?? []);
      setLeaderboard(lb ?? []);
      setAvailablePlayers(playersData ?? []);
    }).finally(() => setLoading(false));
  }, [orgId, tournamentId]);

  const saveProfile = async () => {
    setSaving(true);
    try {
      const res = await fetch(`/api/organizations/${orgId}/tournaments/${tournamentId}/corporate-profile`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(profileForm),
      });
      if (!res.ok) throw new Error();
      const updated = await res.json();
      setProfile(updated);
      setEditingProfile(false);
      toast({ title: 'Corporate profile saved' });
    } catch { toast({ title: 'Failed to save profile', variant: 'destructive' }); }
    finally { setSaving(false); }
  };

  const createTeam = async () => {
    if (!newTeamForm.companyName || !newTeamForm.teamName) return;
    const res = await fetch(`/api/organizations/${orgId}/tournaments/${tournamentId}/corporate-teams`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(newTeamForm),
    });
    if (res.ok) {
      const t = await res.json();
      setTeams(prev => [...prev, { ...t, members: [] }]);
      setNewTeamForm({ companyName: '', teamName: '', colour: '#22c55e' });
      setAddTeamOpen(false);
      toast({ title: 'Team created' });
    } else toast({ title: 'Failed to create team', variant: 'destructive' });
  };

  const deleteTeam = async (teamId: number) => {
    await fetch(`/api/organizations/${orgId}/tournaments/${tournamentId}/corporate-teams/${teamId}`, { method: 'DELETE' });
    setTeams(prev => prev.filter(t => t.id !== teamId));
    toast({ title: 'Team removed' });
  };

  const addMember = async (teamId: number) => {
    if (!addMemberPlayerId) return;
    const res = await fetch(`/api/organizations/${orgId}/tournaments/${tournamentId}/corporate-teams/${teamId}/members`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ playerId: parseInt(addMemberPlayerId) }),
    });
    if (res.ok) {
      const player = availablePlayers.find(p => p.id === parseInt(addMemberPlayerId));
      if (player) {
        setTeams(prev => prev.map(t => t.id === teamId ? {
          ...t, members: [...t.members, { playerId: player.id, firstName: player.firstName, lastName: player.lastName, handicapIndex: null }]
        } : t));
      }
      setAddMemberTeamId(null);
      setAddMemberPlayerId('');
      toast({ title: 'Player added to team' });
    } else toast({ title: 'Failed to add player', variant: 'destructive' });
  };

  const removeMember = async (teamId: number, playerId: number) => {
    await fetch(`/api/organizations/${orgId}/tournaments/${tournamentId}/corporate-teams/${teamId}/members/${playerId}`, { method: 'DELETE' });
    setTeams(prev => prev.map(t => t.id === teamId ? { ...t, members: t.members.filter(m => m.playerId !== playerId) } : t));
  };

  if (loading) return <div className="flex justify-center py-16"><div className="w-8 h-8 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" /></div>;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-blue-600/20 flex items-center justify-center">
            <Building2 className="w-5 h-5 text-blue-400" />
          </div>
          <div>
            <h2 className="text-xl font-bold text-white">Corporate Event</h2>
            <p className="text-sm text-muted-foreground">Branding, team groupings, and invoice</p>
          </div>
        </div>
        {isAdmin && (
          <Button size="sm" variant="outline" onClick={() => window.open(`/api/organizations/${orgId}/tournaments/${tournamentId}/corporate-invoice`, '_blank')} className="border-blue-500/30 text-blue-300 hover:bg-blue-500/10">
            <FileDown className="w-3.5 h-3.5 mr-1.5" /> Download Invoice
          </Button>
        )}
      </div>

      <Card className="glass-card border-blue-500/10">
        <CardHeader className="flex flex-row items-center justify-between pb-3">
          <CardTitle className="text-white text-base flex items-center gap-2"><Briefcase className="w-4 h-4 text-blue-400" /> Company Profile</CardTitle>
          {isAdmin && !editingProfile && (
            <Button size="sm" variant="ghost" onClick={() => { setEditingProfile(true); setProfileForm(profile ?? {}); }} className="text-blue-400 hover:text-blue-300 hover:bg-blue-500/10">
              <Edit3 className="w-3.5 h-3.5 mr-1" /> {profile ? 'Edit' : 'Set Up'}
            </Button>
          )}
        </CardHeader>
        <CardContent>
          {editingProfile ? (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div><label className="text-xs text-muted-foreground uppercase tracking-wider">Company Name *</label>
                  <Input value={profileForm.companyName ?? ''} onChange={e => setProfileForm(f => ({ ...f, companyName: e.target.value }))} className="mt-1 bg-black/40 border-white/10 text-white" /></div>
                <div><label className="text-xs text-muted-foreground uppercase tracking-wider">Contact Name</label>
                  <Input value={profileForm.contactName ?? ''} onChange={e => setProfileForm(f => ({ ...f, contactName: e.target.value }))} className="mt-1 bg-black/40 border-white/10 text-white" /></div>
                <div><label className="text-xs text-muted-foreground uppercase tracking-wider">Contact Email</label>
                  <Input value={profileForm.contactEmail ?? ''} onChange={e => setProfileForm(f => ({ ...f, contactEmail: e.target.value }))} className="mt-1 bg-black/40 border-white/10 text-white" /></div>
                <div><label className="text-xs text-muted-foreground uppercase tracking-wider">VAT Number</label>
                  <Input value={profileForm.vatNumber ?? ''} onChange={e => setProfileForm(f => ({ ...f, vatNumber: e.target.value }))} className="mt-1 bg-black/40 border-white/10 text-white" /></div>
                <div><label className="text-xs text-muted-foreground uppercase tracking-wider">Primary Colour</label>
                  <Input type="color" value={profileForm.primaryColor ?? '#1e4d2b'} onChange={e => setProfileForm(f => ({ ...f, primaryColor: e.target.value }))} className="mt-1 h-10 bg-black/40 border-white/10 cursor-pointer" /></div>
                <div><label className="text-xs text-muted-foreground uppercase tracking-wider">PO Reference</label>
                  <Input value={profileForm.purchaseOrderRef ?? ''} onChange={e => setProfileForm(f => ({ ...f, purchaseOrderRef: e.target.value }))} className="mt-1 bg-black/40 border-white/10 text-white" /></div>
              </div>
              <div><label className="text-xs text-muted-foreground uppercase tracking-wider">Invoice Address</label>
                <Input value={profileForm.invoiceAddress ?? ''} onChange={e => setProfileForm(f => ({ ...f, invoiceAddress: e.target.value }))} className="mt-1 bg-black/40 border-white/10 text-white" /></div>
              <div><label className="text-xs text-muted-foreground uppercase tracking-wider">Logo URL</label>
                <Input value={profileForm.logoUrl ?? ''} onChange={e => setProfileForm(f => ({ ...f, logoUrl: e.target.value }))} className="mt-1 bg-black/40 border-white/10 text-white" placeholder="https://..." /></div>
              <div><label className="text-xs text-muted-foreground uppercase tracking-wider">Invoice Notes</label>
                <Input value={profileForm.invoiceNotes ?? ''} onChange={e => setProfileForm(f => ({ ...f, invoiceNotes: e.target.value }))} className="mt-1 bg-black/40 border-white/10 text-white" /></div>
              <div className="flex gap-3 pt-2">
                <Button onClick={saveProfile} disabled={saving} className="bg-blue-600 hover:bg-blue-700 text-white">{saving ? 'Saving...' : 'Save Profile'}</Button>
                <Button variant="outline" onClick={() => setEditingProfile(false)} className="border-white/10 text-white hover:bg-white/5">Cancel</Button>
              </div>
            </div>
          ) : profile ? (
            <div className="grid grid-cols-2 md:grid-cols-3 gap-4 text-sm">
              <div><p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Company</p><p className="text-white font-medium">{profile.companyName}</p></div>
              {profile.contactName && <div><p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Contact</p><p className="text-white">{profile.contactName}</p></div>}
              {profile.contactEmail && <div><p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Email</p><p className="text-white">{profile.contactEmail}</p></div>}
              {profile.vatNumber && <div><p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">VAT No.</p><p className="text-white">{profile.vatNumber}</p></div>}
              {profile.purchaseOrderRef && <div><p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">PO Ref</p><p className="text-white">{profile.purchaseOrderRef}</p></div>}
              {profile.primaryColor && <div><p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Brand Colour</p><div className="flex items-center gap-2"><div className="w-5 h-5 rounded" style={{ background: profile.primaryColor }} /><p className="text-white font-mono text-xs">{profile.primaryColor}</p></div></div>}
            </div>
          ) : (
            <div className="text-center py-8 text-muted-foreground">
              <Building2 className="w-10 h-10 mx-auto mb-2 opacity-30" />
              <p className="text-sm">No corporate profile set up yet.</p>
              {isAdmin && <p className="text-xs mt-1 opacity-70">Click "Set Up" to configure company branding and invoice details.</p>}
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card className="glass-card border-blue-500/10">
          <CardHeader className="flex flex-row items-center justify-between pb-3">
            <CardTitle className="text-white text-base flex items-center gap-2"><Users className="w-4 h-4 text-blue-400" /> Company Teams</CardTitle>
            {isAdmin && (
              <Button size="sm" variant="outline" onClick={() => setAddTeamOpen(true)} className="border-blue-500/30 text-blue-300 hover:bg-blue-500/10">
                <Plus className="w-3.5 h-3.5 mr-1" /> Add Team
              </Button>
            )}
          </CardHeader>
          <CardContent>
            {teams.length === 0 ? (
              <div className="text-center py-6 text-muted-foreground"><Users className="w-8 h-8 mx-auto mb-2 opacity-30" /><p className="text-sm">No teams created yet.</p></div>
            ) : (
              <div className="space-y-3">
                {teams.map(team => (
                  <div key={team.id} className="p-3 bg-black/30 rounded-xl border border-white/5">
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <div className="w-3 h-3 rounded-full" style={{ background: team.colour ?? '#22c55e' }} />
                        <span className="font-semibold text-white text-sm">{team.teamName}</span>
                        <span className="text-xs text-muted-foreground">({team.companyName})</span>
                      </div>
                      {isAdmin && (
                        <div className="flex gap-1">
                          <Button size="sm" variant="ghost" onClick={() => { setAddMemberTeamId(team.id); setAddMemberPlayerId(''); }} className="h-6 px-2 text-blue-400 hover:text-blue-300 hover:bg-blue-500/10"><Plus className="w-3 h-3" /></Button>
                          <Button size="sm" variant="ghost" onClick={() => deleteTeam(team.id)} className="h-6 px-2 text-red-400 hover:text-red-300 hover:bg-red-500/10"><Trash2 className="w-3 h-3" /></Button>
                        </div>
                      )}
                    </div>
                    {team.members.length > 0 ? (
                      <div className="flex flex-wrap gap-1">
                        {team.members.map(m => (
                          <div key={m.playerId} className="flex items-center gap-1 px-2 py-0.5 bg-white/5 rounded-full text-xs text-white">
                            {m.firstName} {m.lastName}
                            {isAdmin && <button onClick={() => removeMember(team.id, m.playerId)} className="text-red-400 hover:text-red-300 ml-1"><X className="w-2.5 h-2.5" /></button>}
                          </div>
                        ))}
                      </div>
                    ) : <p className="text-xs text-muted-foreground">No players assigned</p>}
                    {addMemberTeamId === team.id && (
                      <div className="mt-2 flex gap-2">
                        <Select value={addMemberPlayerId} onValueChange={setAddMemberPlayerId}>
                          <SelectTrigger className="bg-black/50 border-white/10 text-white text-xs h-8 flex-1"><SelectValue placeholder="Select player..." /></SelectTrigger>
                          <SelectContent className="bg-card border-white/10 text-white">
                            {availablePlayers.map(p => <SelectItem key={p.id} value={String(p.id)}>{p.firstName} {p.lastName}</SelectItem>)}
                          </SelectContent>
                        </Select>
                        <Button size="sm" onClick={() => addMember(team.id)} className="h-8 bg-blue-600 hover:bg-blue-700 text-white">Add</Button>
                        <Button size="sm" variant="ghost" onClick={() => setAddMemberTeamId(null)} className="h-8 text-muted-foreground hover:text-white">Cancel</Button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="glass-card border-blue-500/10">
          <CardHeader className="pb-3"><CardTitle className="text-white text-base flex items-center gap-2"><Trophy className="w-4 h-4 text-blue-400" /> Corporate Leaderboard</CardTitle></CardHeader>
          <CardContent>
            {leaderboard.length === 0 ? (
              <div className="text-center py-6 text-muted-foreground"><Trophy className="w-8 h-8 mx-auto mb-2 opacity-30" /><p className="text-sm">No scores recorded yet.</p></div>
            ) : (
              <div className="space-y-2">
                {leaderboard.map((entry) => (
                  <div key={entry.team.id} className="flex items-center gap-3 p-3 bg-black/30 rounded-xl border border-white/5">
                    <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold ${entry.position === 1 ? 'bg-yellow-500/20 text-yellow-400' : 'bg-white/5 text-muted-foreground'}`}>{entry.position}</div>
                    <div className="w-3 h-3 rounded-full flex-shrink-0" style={{ background: entry.team.colour ?? '#22c55e' }} />
                    <div className="flex-1 min-w-0">
                      <p className="text-white font-medium text-sm">{entry.team.teamName}</p>
                      <p className="text-xs text-muted-foreground">{entry.team.companyName}</p>
                    </div>
                    <div className="text-right">
                      <p className="text-white font-bold text-sm">{entry.totalNet}</p>
                      <p className="text-xs text-muted-foreground">net total</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {addTeamOpen && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4" onClick={() => setAddTeamOpen(false)}>
          <div className="glass-panel border border-white/10 rounded-2xl p-6 w-full max-w-sm" onClick={e => e.stopPropagation()}>
            <h3 className="text-white font-bold mb-4">Add Company Team</h3>
            <div className="space-y-3">
              <div><label className="text-xs text-muted-foreground uppercase tracking-wider">Company Name *</label>
                <Input value={newTeamForm.companyName} onChange={e => setNewTeamForm(f => ({ ...f, companyName: e.target.value }))} className="mt-1 bg-black/40 border-white/10 text-white" /></div>
              <div><label className="text-xs text-muted-foreground uppercase tracking-wider">Team Name *</label>
                <Input value={newTeamForm.teamName} onChange={e => setNewTeamForm(f => ({ ...f, teamName: e.target.value }))} className="mt-1 bg-black/40 border-white/10 text-white" /></div>
              <div><label className="text-xs text-muted-foreground uppercase tracking-wider">Team Colour</label>
                <Input type="color" value={newTeamForm.colour} onChange={e => setNewTeamForm(f => ({ ...f, colour: e.target.value }))} className="mt-1 h-10 bg-black/40 border-white/10 cursor-pointer" /></div>
              <div className="flex gap-3 pt-2">
                <Button onClick={createTeam} className="flex-1 bg-blue-600 hover:bg-blue-700 text-white">Create Team</Button>
                <Button variant="outline" onClick={() => setAddTeamOpen(false)} className="border-white/10 text-white hover:bg-white/5">Cancel</Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Charity Event Tab ────────────────────────────────────────────────────────

interface CharityProfile {
  id: number; charityName: string; charityLogoUrl: string | null; targetAmount: string | null;
  raisedAmount: string; currency: string; justgivingUrl: string | null; gofundmeUrl: string | null; donationPageUrl: string | null;
}

interface CharityChallengeData {
  id: number; name: string; description: string | null; challengeType: string;
  holeNumber: number | null; unit: string | null; donationPerUnit: string | null;
  currency: string; fixedDonation: string | null; targetAmount: string | null; displayOrder: number;
  result: { id: number; winnerName: string | null; achievedValue: string | null; donationAmount: string | null; notes: string | null } | null;
}

function CharityEventTab({ orgId, tournamentId, isAdmin, currency: defaultCurrency }: { orgId: number; tournamentId: number; isAdmin: boolean; currency: string }) {
  const { toast } = useToast();
  const [profile, setProfile] = useState<CharityProfile | null>(null);
  const [challenges, setChallenges] = useState<CharityChallengeData[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editingProfile, setEditingProfile] = useState(false);
  const [profileForm, setProfileForm] = useState<Partial<CharityProfile>>({});
  const [addChallengeOpen, setAddChallengeOpen] = useState(false);
  const [newChallenge, setNewChallenge] = useState({ name: '', challengeType: 'longest_drive', holeNumber: '', donationPerUnit: '', currency: defaultCurrency, unit: 'metres', fixedDonation: '', targetAmount: '' });
  const [recordingResult, setRecordingResult] = useState<number | null>(null);
  const [resultForm, setResultForm] = useState({ winnerName: '', achievedValue: '', donationAmount: '', notes: '' });
  const raisedInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!orgId || !tournamentId) return;
    Promise.all([
      fetch(`/api/organizations/${orgId}/tournaments/${tournamentId}/charity-profile`).then(r => r.json()),
      fetch(`/api/organizations/${orgId}/tournaments/${tournamentId}/charity-challenges`).then(r => r.json()).catch(() => []),
    ]).then(([prof, chals]) => {
      setProfile(prof);
      setChallenges(chals ?? []);
    }).finally(() => setLoading(false));
  }, [orgId, tournamentId]);

  const saveProfile = async () => {
    setSaving(true);
    try {
      const res = await fetch(`/api/organizations/${orgId}/tournaments/${tournamentId}/charity-profile`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(profileForm),
      });
      if (!res.ok) throw new Error();
      const updated = await res.json();
      setProfile(updated);
      setEditingProfile(false);
      toast({ title: 'Charity profile saved' });
    } catch { toast({ title: 'Failed to save profile', variant: 'destructive' }); }
    finally { setSaving(false); }
  };

  const updateRaised = async (amount: string) => {
    if (!profile) return;
    const res = await fetch(`/api/organizations/${orgId}/tournaments/${tournamentId}/charity-profile`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...profile, raisedAmount: amount }),
    });
    if (res.ok) { const u = await res.json(); setProfile(u); toast({ title: 'Raised amount updated' }); }
  };

  const addChallenge = async () => {
    if (!newChallenge.name) return;
    const res = await fetch(`/api/organizations/${orgId}/tournaments/${tournamentId}/charity-challenges`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(newChallenge),
    });
    if (res.ok) {
      const c = await res.json();
      setChallenges(prev => [...prev, { ...c, result: null }]);
      setAddChallengeOpen(false);
      setNewChallenge({ name: '', challengeType: 'longest_drive', holeNumber: '', donationPerUnit: '', currency: defaultCurrency, unit: 'metres', fixedDonation: '', targetAmount: '' });
      toast({ title: 'Challenge added' });
    } else toast({ title: 'Failed to add challenge', variant: 'destructive' });
  };

  const deleteChallenge = async (id: number) => {
    await fetch(`/api/organizations/${orgId}/tournaments/${tournamentId}/charity-challenges/${id}`, { method: 'DELETE' });
    setChallenges(prev => prev.filter(c => c.id !== id));
    toast({ title: 'Challenge removed' });
  };

  const saveResult = async (challengeId: number) => {
    const res = await fetch(`/api/organizations/${orgId}/tournaments/${tournamentId}/charity-challenges/${challengeId}/result`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(resultForm),
    });
    if (res.ok) {
      const result = await res.json();
      setChallenges(prev => prev.map(c => c.id === challengeId ? { ...c, result } : c));
      const prof = await fetch(`/api/organizations/${orgId}/tournaments/${tournamentId}/charity-profile`).then(r => r.json());
      setProfile(prof);
      setRecordingResult(null);
      setResultForm({ winnerName: '', achievedValue: '', donationAmount: '', notes: '' });
      toast({ title: 'Result recorded' });
    } else toast({ title: 'Failed to record result', variant: 'destructive' });
  };

  if (loading) return <div className="flex justify-center py-16"><div className="w-8 h-8 border-2 border-rose-400 border-t-transparent rounded-full animate-spin" /></div>;

  const raised = Number(profile?.raisedAmount ?? 0);
  const target = profile?.targetAmount ? Number(profile.targetAmount) : null;
  const pct = target ? Math.min(100, Math.round((raised / target) * 100)) : null;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-rose-600/20 flex items-center justify-center">
            <Heart className="w-5 h-5 text-rose-400" />
          </div>
          <div>
            <h2 className="text-xl font-bold text-white">Charity Event</h2>
            <p className="text-sm text-muted-foreground">Fundraising challenges and donation tracking</p>
          </div>
        </div>
        {isAdmin && (
          <Button size="sm" variant="outline" onClick={() => window.open(`/api/organizations/${orgId}/tournaments/${tournamentId}/charity-report`, '_blank')} className="border-rose-500/30 text-rose-300 hover:bg-rose-500/10">
            <FileDown className="w-3.5 h-3.5 mr-1.5" /> Donation Report
          </Button>
        )}
      </div>

      {profile && (
        <Card className="glass-card border-rose-500/20 overflow-hidden">
          <div className="bg-gradient-to-r from-rose-900/40 to-rose-800/20 p-5">
            <div className="flex items-center justify-between mb-3">
              <div>
                <h3 className="text-white font-bold text-lg">{profile.charityName}</h3>
                {profile.donationPageUrl && (
                  <a href={profile.donationPageUrl} target="_blank" rel="noopener noreferrer" className="text-rose-300 text-xs flex items-center gap-1 mt-0.5">
                    <ExternalLink className="w-3 h-3" /> Donation Page
                  </a>
                )}
              </div>
              <div className="text-right">
                <p className="text-3xl font-bold text-white">{profile.currency} {raised.toFixed(2)}</p>
                {target && <p className="text-sm text-rose-300">of {profile.currency} {target.toFixed(2)} target</p>}
              </div>
            </div>
            {pct !== null && (
              <div>
                <div className="h-3 bg-black/30 rounded-full overflow-hidden">
                  <div className="h-full bg-rose-500 rounded-full transition-all" style={{ width: `${pct}%` }} />
                </div>
                <p className="text-xs text-rose-300 mt-1 text-right">{pct}% of target</p>
              </div>
            )}
            <div className="flex gap-2 mt-3">
              {profile.justgivingUrl && <a href={profile.justgivingUrl} target="_blank" rel="noopener noreferrer" className="text-xs bg-orange-500/20 text-orange-300 px-2 py-1 rounded-full border border-orange-500/30 flex items-center gap-1"><ExternalLink className="w-2.5 h-2.5" /> JustGiving</a>}
              {profile.gofundmeUrl && <a href={profile.gofundmeUrl} target="_blank" rel="noopener noreferrer" className="text-xs bg-green-500/20 text-green-300 px-2 py-1 rounded-full border border-green-500/30 flex items-center gap-1"><ExternalLink className="w-2.5 h-2.5" /> GoFundMe</a>}
            </div>
            {isAdmin && (
              <div className="mt-3 flex items-center gap-2">
                <Input ref={raisedInputRef} type="number" step="0.01" placeholder="Update raised amount..." className="bg-black/40 border-white/10 text-white text-sm h-8 w-40" />
                <Button size="sm" onClick={() => { if (raisedInputRef.current?.value) updateRaised(raisedInputRef.current.value); }} className="h-8 bg-rose-600 hover:bg-rose-700 text-white text-xs">Update</Button>
                <Button size="sm" variant="ghost" onClick={() => { setEditingProfile(true); setProfileForm(profile); }} className="h-8 text-xs text-rose-400 hover:text-rose-300 hover:bg-rose-500/10"><Edit3 className="w-3 h-3 mr-1" /> Edit Profile</Button>
              </div>
            )}
          </div>
        </Card>
      )}

      {(!profile || editingProfile) && (
        <Card className="glass-card border-rose-500/10">
          <CardHeader className="pb-3"><CardTitle className="text-white text-base">Charity Profile</CardTitle></CardHeader>
          <CardContent>
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div><label className="text-xs text-muted-foreground uppercase tracking-wider">Charity Name *</label>
                  <Input value={profileForm.charityName ?? ''} onChange={e => setProfileForm(f => ({ ...f, charityName: e.target.value }))} className="mt-1 bg-black/40 border-white/10 text-white" /></div>
                <div><label className="text-xs text-muted-foreground uppercase tracking-wider">Currency</label>
                  <Input value={profileForm.currency ?? 'GBP'} onChange={e => setProfileForm(f => ({ ...f, currency: e.target.value }))} className="mt-1 bg-black/40 border-white/10 text-white" /></div>
                <div><label className="text-xs text-muted-foreground uppercase tracking-wider">Target Amount</label>
                  <Input type="number" value={profileForm.targetAmount ?? ''} onChange={e => setProfileForm(f => ({ ...f, targetAmount: e.target.value }))} className="mt-1 bg-black/40 border-white/10 text-white" /></div>
                <div><label className="text-xs text-muted-foreground uppercase tracking-wider">JustGiving URL</label>
                  <Input value={profileForm.justgivingUrl ?? ''} onChange={e => setProfileForm(f => ({ ...f, justgivingUrl: e.target.value }))} className="mt-1 bg-black/40 border-white/10 text-white" placeholder="https://justgiving.com/..." /></div>
                <div><label className="text-xs text-muted-foreground uppercase tracking-wider">GoFundMe URL</label>
                  <Input value={profileForm.gofundmeUrl ?? ''} onChange={e => setProfileForm(f => ({ ...f, gofundmeUrl: e.target.value }))} className="mt-1 bg-black/40 border-white/10 text-white" placeholder="https://gofundme.com/..." /></div>
                <div><label className="text-xs text-muted-foreground uppercase tracking-wider">Donation Page URL</label>
                  <Input value={profileForm.donationPageUrl ?? ''} onChange={e => setProfileForm(f => ({ ...f, donationPageUrl: e.target.value }))} className="mt-1 bg-black/40 border-white/10 text-white" placeholder="https://..." /></div>
              </div>
              <div className="flex gap-3 pt-2">
                <Button onClick={saveProfile} disabled={saving} className="bg-rose-600 hover:bg-rose-700 text-white">{saving ? 'Saving...' : 'Save Charity Profile'}</Button>
                {profile && <Button variant="outline" onClick={() => setEditingProfile(false)} className="border-white/10 text-white hover:bg-white/5">Cancel</Button>}
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      <Card className="glass-card border-rose-500/10">
        <CardHeader className="flex flex-row items-center justify-between pb-3">
          <CardTitle className="text-white text-base flex items-center gap-2"><Target className="w-4 h-4 text-rose-400" /> On-Course Challenges</CardTitle>
          {isAdmin && (
            <Button size="sm" variant="outline" onClick={() => setAddChallengeOpen(true)} className="border-rose-500/30 text-rose-300 hover:bg-rose-500/10">
              <Plus className="w-3.5 h-3.5 mr-1" /> Add Challenge
            </Button>
          )}
        </CardHeader>
        <CardContent>
          {challenges.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <Target className="w-10 h-10 mx-auto mb-2 opacity-30" />
              <p className="text-sm">No challenges configured yet.</p>
              {isAdmin && <p className="text-xs mt-1 opacity-70">Add challenges like Longest Drive, Closest to Pin, etc.</p>}
            </div>
          ) : (
            <div className="space-y-3">
              {challenges.map(challenge => (
                <div key={challenge.id} className="p-4 bg-black/30 rounded-xl border border-white/5">
                  <div className="flex items-start justify-between mb-2">
                    <div>
                      <p className="text-white font-medium text-sm">{challenge.name}</p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {challenge.challengeType.replace(/_/g, ' ')}
                        {challenge.holeNumber ? ` · Hole ${challenge.holeNumber}` : ''}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      {challenge.donationPerUnit && (
                        <div className="text-xs bg-rose-500/10 text-rose-300 px-2 py-1 rounded-full border border-rose-500/20">
                          {challenge.currency} {challenge.donationPerUnit} / {challenge.unit}
                        </div>
                      )}
                      {isAdmin && (
                        <div className="flex gap-1">
                          <Button size="sm" variant="ghost" onClick={() => { setRecordingResult(challenge.id); setResultForm({ winnerName: challenge.result?.winnerName ?? '', achievedValue: challenge.result?.achievedValue ?? '', donationAmount: challenge.result?.donationAmount ?? '', notes: challenge.result?.notes ?? '' }); }} className="h-6 px-2 text-rose-400 hover:text-rose-300 hover:bg-rose-500/10 text-xs">
                            {challenge.result ? 'Edit' : 'Record'}
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => deleteChallenge(challenge.id)} className="h-6 px-2 text-red-400 hover:text-red-300 hover:bg-red-500/10">
                            <Trash2 className="w-3 h-3" />
                          </Button>
                        </div>
                      )}
                    </div>
                  </div>
                  {challenge.result && (
                    <div className="mt-2 p-2 bg-rose-500/5 border border-rose-500/10 rounded-lg">
                      <div className="flex items-center justify-between text-xs">
                        <span className="text-rose-300">Winner: {challenge.result.winnerName ?? 'TBC'}</span>
                        {challenge.result.achievedValue && <span className="text-muted-foreground">{challenge.result.achievedValue} {challenge.unit}</span>}
                        {challenge.result.donationAmount && <span className="text-rose-300 font-semibold">{(profile?.currency ?? challenge.currency)} {Number(challenge.result.donationAmount).toFixed(2)} raised</span>}
                      </div>
                    </div>
                  )}
                  {recordingResult === challenge.id && (
                    <div className="mt-3 space-y-2">
                      <div className="grid grid-cols-2 gap-2">
                        <div><label className="text-xs text-muted-foreground">Winner Name</label>
                          <Input value={resultForm.winnerName} onChange={e => setResultForm(f => ({ ...f, winnerName: e.target.value }))} className="mt-1 bg-black/40 border-white/10 text-white text-xs h-8" /></div>
                        <div><label className="text-xs text-muted-foreground">Result ({challenge.unit})</label>
                          <Input type="number" value={resultForm.achievedValue} onChange={e => setResultForm(f => ({ ...f, achievedValue: e.target.value }))} className="mt-1 bg-black/40 border-white/10 text-white text-xs h-8" /></div>
                        <div><label className="text-xs text-muted-foreground">Donation ({profile?.currency ?? 'GBP'})</label>
                          <Input type="number" value={resultForm.donationAmount} onChange={e => setResultForm(f => ({ ...f, donationAmount: e.target.value }))} className="mt-1 bg-black/40 border-white/10 text-white text-xs h-8" /></div>
                        <div><label className="text-xs text-muted-foreground">Notes</label>
                          <Input value={resultForm.notes} onChange={e => setResultForm(f => ({ ...f, notes: e.target.value }))} className="mt-1 bg-black/40 border-white/10 text-white text-xs h-8" /></div>
                      </div>
                      <div className="flex gap-2">
                        <Button size="sm" onClick={() => saveResult(challenge.id)} className="bg-rose-600 hover:bg-rose-700 text-white h-8 text-xs">Save</Button>
                        <Button size="sm" variant="ghost" onClick={() => setRecordingResult(null)} className="h-8 text-xs text-muted-foreground hover:text-white">Cancel</Button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {addChallengeOpen && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4" onClick={() => setAddChallengeOpen(false)}>
          <div className="glass-panel border border-white/10 rounded-2xl p-6 w-full max-w-md" onClick={e => e.stopPropagation()}>
            <h3 className="text-white font-bold mb-4">Add On-Course Challenge</h3>
            <div className="space-y-3">
              <div><label className="text-xs text-muted-foreground uppercase tracking-wider">Challenge Name *</label>
                <Input value={newChallenge.name} onChange={e => setNewChallenge(f => ({ ...f, name: e.target.value }))} className="mt-1 bg-black/40 border-white/10 text-white" placeholder="e.g. Longest Drive - Hole 7" /></div>
              <div><label className="text-xs text-muted-foreground uppercase tracking-wider">Type</label>
                <Select value={newChallenge.challengeType} onValueChange={v => setNewChallenge(f => ({ ...f, challengeType: v }))}>
                  <SelectTrigger className="mt-1 bg-black/50 border-white/10 text-white"><SelectValue /></SelectTrigger>
                  <SelectContent className="bg-card border-white/10 text-white">
                    <SelectItem value="longest_drive">Longest Drive</SelectItem>
                    <SelectItem value="closest_to_pin">Closest to Pin</SelectItem>
                    <SelectItem value="most_accurate">Most Accurate Drive</SelectItem>
                    <SelectItem value="putting">Putting Challenge</SelectItem>
                    <SelectItem value="custom">Custom</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div><label className="text-xs text-muted-foreground uppercase tracking-wider">Hole Number</label>
                  <Input type="number" value={newChallenge.holeNumber} onChange={e => setNewChallenge(f => ({ ...f, holeNumber: e.target.value }))} className="mt-1 bg-black/40 border-white/10 text-white" min={1} max={18} /></div>
                <div><label className="text-xs text-muted-foreground uppercase tracking-wider">Unit</label>
                  <Input value={newChallenge.unit} onChange={e => setNewChallenge(f => ({ ...f, unit: e.target.value }))} className="mt-1 bg-black/40 border-white/10 text-white" placeholder="metres" /></div>
                <div><label className="text-xs text-muted-foreground uppercase tracking-wider">Donation per Unit</label>
                  <Input type="number" value={newChallenge.donationPerUnit} onChange={e => setNewChallenge(f => ({ ...f, donationPerUnit: e.target.value }))} className="mt-1 bg-black/40 border-white/10 text-white" placeholder="200" /></div>
                <div><label className="text-xs text-muted-foreground uppercase tracking-wider">Currency</label>
                  <Input value={newChallenge.currency} onChange={e => setNewChallenge(f => ({ ...f, currency: e.target.value }))} className="mt-1 bg-black/40 border-white/10 text-white" placeholder="GBP" /></div>
              </div>
              <div className="flex gap-3 pt-2">
                <Button onClick={addChallenge} className="flex-1 bg-rose-600 hover:bg-rose-700 text-white">Add Challenge</Button>
                <Button variant="outline" onClick={() => setAddChallengeOpen(false)} className="border-white/10 text-white hover:bg-white/5">Cancel</Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
