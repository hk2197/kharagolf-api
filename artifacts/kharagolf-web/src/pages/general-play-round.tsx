import { useState, useEffect, useCallback } from 'react';
import { useRoute, useLocation } from 'wouter';
import {
  ChevronLeft, ChevronRight, CheckCircle2, Clock, AlertCircle,
  Minus, Plus, Users, Send, RefreshCw, Flag, RotateCcw, Crosshair, PlusCircle, ChevronDown, ChevronUp,
} from 'lucide-react';

import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { useGetMe } from '@workspace/api-client-react';
import HoleMapPanel from '@/components/HoleMapPanel';
import { ShotSourceBadges, type ShotSourceBreakdown } from '@/components/ShotSourceBadges';

const GOLD = '#C9A84C';
const STANDARD_CLUBS = ["Dr","3W","5W","7W","2H","3H","4H","5H","3I","4I","5I","6I","7I","8I","9I","PW","GW","SW","LW","Putter"];
const MISS_DIRECTIONS = ["Left","Right","Short","Long","On Target"];
const LIE_TYPES = ["Tee","Fairway","Rough","Bunker","Hazard","Green"];
const SHOT_SHAPES = ["Draw","Straight","Fade"];
const PENALTY_REASONS = ["OB","Water","Unplayable","Other"];
const SHOT_TYPES = ["tee","fairway","approach","chip","sand","putt"];

interface CourseHole {
  holeNumber: number;
  par: number;
  handicap: number | null;
  distance: number | null;
}

interface HoleScore {
  holeNumber: number;
  par: number | null;
  strokeIndex: number | null;
  strokes: number;
  putts: number | null;
  cappedStrokes: number | null;
  fairwayHit: string | null;
  gir: boolean | null;
  sandSave: boolean | null;
  upAndDown: boolean | null;
  penalties: number | null;
  penaltyReason: string | null;
}

interface Marker {
  id: number;
  markerName: string;
  markerGhinNumber: string | null;
  confirmationStatus: string;
  disputeNote: string | null;
}

interface RoundDetail {
  round: {
    id: number;
    courseId: number;
    holesPlayed: number;
    status: string;
    grossScore: number | null;
    scoreDifferential: string | null;
    playedAt: string;
    submittedAt: string | null;
    markerDeadlineAt: string | null;
    notes: string | null;
  };
  holes: HoleScore[];
  markers: Marker[];
  courseHoles: CourseHole[];
}

function ScoreButton({ value, onChange, min = 1, max = 20 }: { value: number; onChange: (v: number) => void; min?: number; max?: number }) {
  return (
    <div className="flex items-center gap-3">
      <Button
        variant="outline"
        size="icon"
        className="w-10 h-10 rounded-full border-white/20 text-white hover:bg-white/10"
        onClick={() => onChange(Math.max(min, value - 1))}
        disabled={value <= min}
      >
        <Minus className="w-4 h-4" />
      </Button>
      <span className="text-3xl font-bold text-white w-12 text-center">{value}</span>
      <Button
        variant="outline"
        size="icon"
        className="w-10 h-10 rounded-full border-white/20 text-white hover:bg-white/10"
        onClick={() => onChange(Math.min(max, value + 1))}
        disabled={value >= max}
      >
        <Plus className="w-4 h-4" />
      </Button>
    </div>
  );
}

function SmallCounter({ value, onChange, min = 0, max = 8 }: { value: number; onChange: (v: number) => void; min?: number; max?: number }) {
  return (
    <div className="flex items-center gap-2">
      <button
        className="w-7 h-7 rounded-full border border-white/20 text-white text-sm flex items-center justify-center hover:bg-white/10 disabled:opacity-30"
        onClick={() => onChange(Math.max(min, value - 1))}
        disabled={value <= min}
      >
        <Minus className="w-3 h-3" />
      </button>
      <span className="text-lg font-bold text-white w-6 text-center">{value}</span>
      <button
        className="w-7 h-7 rounded-full border border-white/20 text-white text-sm flex items-center justify-center hover:bg-white/10 disabled:opacity-30"
        onClick={() => onChange(Math.min(max, value + 1))}
        disabled={value >= max}
      >
        <Plus className="w-3 h-3" />
      </button>
    </div>
  );
}

function ToggleChip({ label, active, onClick, color = 'bg-emerald-500/30 text-emerald-200 border-emerald-500/40' }: {
  label: string; active: boolean; onClick: () => void; color?: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors ${
        active ? color : 'bg-white/5 text-white/40 border-white/10 hover:bg-white/10'
      }`}
    >
      {label}
    </button>
  );
}

function toPar(strokes: number, par: number) {
  return strokes - par;
}

function toParBadge(tp: number) {
  if (tp <= -2) return <Badge className="bg-amber-500/30 text-amber-200 border-amber-400/40">Eagle</Badge>;
  if (tp === -1) return <Badge className="bg-red-500/25 text-red-200 border-red-400/30">Birdie</Badge>;
  if (tp === 0) return <Badge className="bg-white/10 text-white/60">Par</Badge>;
  if (tp === 1) return <Badge className="bg-blue-500/20 text-blue-200 border-blue-400/30">Bogey</Badge>;
  if (tp === 2) return <Badge className="bg-purple-500/20 text-purple-200 border-purple-400/30">Double</Badge>;
  return <Badge className="bg-purple-600/20 text-purple-200 border-purple-400/30">+{tp}</Badge>;
}

function computeAutoGir(strokes: number, par: number): boolean {
  return strokes <= par - 2;
}

export default function GeneralPlayRoundPage() {
  const [, params] = useRoute('/general-play/:id');
  const [, navigate] = useLocation();
  const roundId = params?.id;
  const { data: user } = useGetMe();
  const { toast } = useToast();

  const [detail, setDetail] = useState<RoundDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [currentHole, setCurrentHole] = useState(1);
  const [strokes, setStrokes] = useState(4);
  const [saving, setSaving] = useState(false);
  const [showSubmit, setShowSubmit] = useState(false);
  const [showScorecard, setShowScorecard] = useState(false);

  // Per-hole stat state
  // putts stays null until the user opens More Stats, preventing fabricated averages
  const [putts, setPutts] = useState<number | null>(null);
  const [fairwayHit, setFairwayHit] = useState<'left' | 'hit' | 'right' | null>(null);
  const [girOverride, setGirOverride] = useState<boolean | null>(null);
  const [sandSave, setSandSave] = useState<boolean | null>(null);
  const [upAndDown, setUpAndDown] = useState<boolean | null>(null);
  const [penalties, setPenalties] = useState<number>(0);
  const [penaltyReason, setPenaltyReason] = useState<string | null>(null);
  const [showMoreStats, setShowMoreStats] = useState(false);
  // True once the user has opened More Stats on this hole — gates stat submission
  const [statsEnteredThisHole, setStatsEnteredThisHole] = useState(false);

  const [markerName, setMarkerName] = useState('');
  const [markerEmail, setMarkerEmail] = useState('');
  const [markerGhin, setMarkerGhin] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Shot tracking
  const [showShotPanel, setShowShotPanel] = useState(false);
  const [shotsByHole, setShotsByHole] = useState<Record<number, number>>({});
  const [selectedShotType, setSelectedShotType] = useState('fairway');
  const [selectedClub, setSelectedClub] = useState<string | null>(null);
  const [selectedMissDir, setSelectedMissDir] = useState<string | null>(null);
  const [selectedLieType, setSelectedLieType] = useState<string | null>(null);
  const [selectedShotShape, setSelectedShotShape] = useState<string | null>(null);
  const [selectedPenaltyReason, setSelectedPenaltyReason] = useState<string | null>(null);
  const [clubProfile, setClubProfile] = useState<{ club: string; avgDistance: number }[]>([]);
  // Task #709 — counts of shots tagged from each capture source for this round.
  // Drives the "78% watch / 18% phone / 4% manual" badges in the summary so
  // the player can see how trustworthy their tracking was.
  const [sourceBreakdown, setSourceBreakdown] = useState<ShotSourceBreakdown | null>(null);

  useEffect(() => {
    if (!roundId) return;
    loadRound();
    loadShotCounts();
    loadClubProfile();
    loadSourceBreakdown();
  }, [roundId]);

  // Task #709 — keep the source-breakdown badges in sync with live shot edits.
  // shotsByHole is updated by the watch websocket and by manual shot logging,
  // so refreshing the breakdown whenever the per-hole counts change keeps the
  // percentages current without polling.
  const totalLoggedShots = Object.values(shotsByHole).reduce((s, n) => s + n, 0);
  useEffect(() => {
    if (!roundId) return;
    loadSourceBreakdown();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [totalLoggedShots]);

  // Reset shot selections when hole changes
  useEffect(() => {
    setSelectedClub(null);
    setSelectedMissDir(null);
    setSelectedLieType(null);
    setSelectedShotShape(null);
    setSelectedPenaltyReason(null);
    setShowShotPanel(false);
  }, [currentHole]);

  const handleLogShot = useCallback(async () => {
    if (!roundId) return;
    const shotCount = shotsByHole[currentHole] ?? 0;
    const shotNum = shotCount + 1;
    try {
      const res = await fetch('/api/portal/watch/submit-shot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          generalPlayRoundId: parseInt(roundId),
          round: 1,
          holeNumber: currentHole,
          shotNumber: shotNum,
          shotType: selectedShotType,
          club: selectedClub,
          missDirection: selectedMissDir,
          lieType: selectedLieType,
          shotShape: selectedShotShape,
          penaltyReason: selectedPenaltyReason,
        }),
      });
      if (!res.ok) throw new Error('Failed');
      setShotsByHole(prev => ({ ...prev, [currentHole]: shotNum }));
      setSelectedClub(null);
      setSelectedMissDir(null);
      setSelectedLieType(null);
      setSelectedShotShape(null);
      setSelectedPenaltyReason(null);
      toast({ title: `Shot ${shotNum} logged${selectedClub ? ` · ${selectedClub}` : ''}` });
    } catch {
      toast({ title: 'Shot not saved', variant: 'destructive' });
    }
  }, [roundId, currentHole, shotsByHole, selectedShotType, selectedClub, selectedMissDir, selectedLieType, selectedShotShape, selectedPenaltyReason, toast]);

  async function loadShotCounts() {
    if (!roundId) return;
    try {
      const res = await fetch(`/api/portal/rounds/1/shots?generalPlayRoundId=${roundId}`, { credentials: 'include' });
      if (!res.ok) return;
      // API returns [{ hole: number, shots: Shot[] }]
      const groups: { hole: number; shots: unknown[] }[] = await res.json();
      const counts: Record<number, number> = {};
      for (const g of groups) {
        if (g.hole && Array.isArray(g.shots)) counts[g.hole] = g.shots.length;
      }
      setShotsByHole(counts);
    } catch { /* non-critical */ }
  }

  async function loadSourceBreakdown() {
    if (!roundId) return;
    try {
      const res = await fetch(`/api/portal/rounds/1/source-breakdown?generalPlayRoundId=${roundId}`, { credentials: 'include' });
      if (!res.ok) return;
      const data: ShotSourceBreakdown = await res.json();
      setSourceBreakdown(data);
    } catch { /* non-critical */ }
  }

  async function loadClubProfile() {
    try {
      const res = await fetch('/api/portal/club-profile', { credentials: 'include' });
      if (!res.ok) return;
      const data = await res.json();
      if (Array.isArray(data)) setClubProfile(data.filter((e: { club: string | null; avgDistance: number | null }) => e.club && e.avgDistance));
    } catch { /* non-critical */ }
  }

  async function loadRound() {
    setLoading(true);
    try {
      const res = await fetch(`/api/portal/general-play/${roundId}`, { credentials: 'include' });
      if (!res.ok) { navigate('/general-play'); return; }
      const data: RoundDetail = await res.json();
      setDetail(data);

      const scored = new Set(data.holes.map(h => h.holeNumber));
      const totalHoles = data.round.holesPlayed;
      for (let h = 1; h <= totalHoles; h++) {
        if (!scored.has(h)) { setCurrentHole(h); break; }
      }

      const currentCH = data.courseHoles.find(h => h.holeNumber === (currentHole || 1));
      if (currentCH) setStrokes(currentCH.par);
    } finally { setLoading(false); }
  }

  const currentCourseHole = detail?.courseHoles.find(h => h.holeNumber === currentHole);
  const existingScore = detail?.holes.find(h => h.holeNumber === currentHole);

  // AI club suggestion for web (distance-based, no GPS — use hole distance as target)
  const suggestedClubWeb = (() => {
    const dist = currentCourseHole?.distance; // metres
    if (!dist || clubProfile.length === 0) return null;
    const targetYds = Math.round(dist * 1.09361);
    let best = clubProfile[0];
    let bestDiff = Math.abs((best.avgDistance ?? 0) - targetYds);
    for (const e of clubProfile) {
      const d = Math.abs((e.avgDistance ?? 0) - targetYds);
      if (d < bestDiff) { bestDiff = d; best = e; }
    }
    if (bestDiff > 60) return null;
    return best.club;
  })();
  const totalHoles = detail?.round.holesPlayed ?? 18;

  const isParThree = currentCourseHole?.par === 3;

  const autoGir = currentCourseHole ? computeAutoGir(strokes, currentCourseHole.par) : false;
  const effectiveGir = girOverride !== null ? girOverride : autoGir;

  useEffect(() => {
    if (existingScore) {
      // This hole has been scored before — restore all its stats
      const hasStats = existingScore.putts !== null;
      setStrokes(existingScore.strokes);
      setPutts(existingScore.putts);
      setFairwayHit((existingScore.fairwayHit as 'left' | 'hit' | 'right' | null) ?? null);
      setGirOverride(existingScore.gir !== null ? existingScore.gir : null);
      setSandSave(existingScore.sandSave ?? null);
      setUpAndDown(existingScore.upAndDown ?? null);
      setPenalties(existingScore.penalties ?? 0);
      setPenaltyReason(existingScore.penaltyReason ?? null);
      // Show stats panel if this hole has stats recorded; gate further saves behind it
      setStatsEnteredThisHole(hasStats);
      setShowMoreStats(hasStats);
    } else if (currentCourseHole) {
      // New hole — reset all stat state to null/empty
      setStrokes(currentCourseHole.par);
      setPutts(null);
      setFairwayHit(null);
      setGirOverride(null);
      setSandSave(null);
      setUpAndDown(null);
      setPenalties(0);
      setPenaltyReason(null);
      setStatsEnteredThisHole(false);
      // Auto-expand if the PREVIOUS hole had stats skipped:
      // putts === null means stats were never entered; putts === 0 catches
      // legacy records where skipped stats defaulted to 0.
      const prevScore = detail?.holes.find(h => h.holeNumber === currentHole - 1);
      const prevSkippedStats = currentHole > 1 && prevScore != null
        && (prevScore.putts === null || prevScore.putts === 0);
      setShowMoreStats(prevSkippedStats);
    }
  }, [currentHole, existingScore?.strokes, currentCourseHole?.par]);

  function handleToggleMoreStats() {
    const opening = !showMoreStats;
    setShowMoreStats(opening);
    if (opening && !statsEnteredThisHole) {
      // First time user opens More Stats on this hole — mark as entered and
      // initialize putts to a sensible default if not already set.
      setStatsEnteredThisHole(true);
      if (putts === null) setPutts(2);
    }
  }

  async function saveHole() {
    if (!detail) return;
    setSaving(true);
    try {
      // Only send optional stats if the user has explicitly opened the More Stats panel
      const sendStats = statsEnteredThisHole;
      const body: Record<string, unknown> = {
        holeNumber: currentHole,
        strokes,
        par: currentCourseHole?.par ?? null,
        strokeIndex: currentCourseHole?.handicap ?? null,
        putts: sendStats ? putts : null,
        gir: sendStats ? (girOverride !== null ? girOverride : effectiveGir) : null,
        sandSave: sendStats ? sandSave : null,
        upAndDown: sendStats ? upAndDown : null,
        penalties: sendStats && penalties > 0 ? penalties : null,
        penaltyReason: sendStats && penalties > 0 ? penaltyReason : null,
      };

      if (!isParThree) {
        body.fairwayHit = sendStats ? fairwayHit : null;
      }

      const res = await fetch(`/api/portal/general-play/${roundId}/hole`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
      });
      if (!res.ok) { toast({ title: 'Failed to save hole score', variant: 'destructive' }); return; }

      const saved: HoleScore = await res.json();

      setDetail(prev => {
        if (!prev) return prev;
        const updated = prev.holes.filter(h => h.holeNumber !== currentHole);
        updated.push(saved);
        return { ...prev, holes: updated };
      });

      if (currentHole < totalHoles) setCurrentHole(h => h + 1);
      else toast({ title: 'All holes scored! Review and submit when ready.' });
    } finally { setSaving(false); }
  }

  async function submitRound() {
    if (!markerName.trim()) { toast({ title: 'Marker name is required', variant: 'destructive' }); return; }
    setSubmitting(true);
    try {
      const res = await fetch(`/api/portal/general-play/${roundId}/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ markerName: markerName.trim(), markerEmail: markerEmail.trim() || null, markerGhinNumber: markerGhin.trim() || null }),
      });
      if (!res.ok) { toast({ title: 'Failed to submit round', variant: 'destructive' }); return; }
      toast({ title: 'Round submitted to marker for countersign!' });
      setShowSubmit(false);
      loadRound();
    } finally { setSubmitting(false); }
  }

  const scoredCount = detail?.holes.length ?? 0;
  const allScored = scoredCount >= totalHoles;
  const isEditable = detail?.round.status === 'draft' || detail?.round.status === 'in_progress';

  const frontNine = detail?.holes.filter(h => h.holeNumber <= 9) ?? [];
  const backNine = detail?.holes.filter(h => h.holeNumber > 9) ?? [];
  const totalGross = detail?.holes.reduce((s, h) => s + h.strokes, 0) ?? 0;
  const totalPar = detail?.courseHoles.slice(0, totalHoles).reduce((s, h) => s + h.par, 0) ?? 0;

  if (loading) {
    return (
      <div className="min-h-screen bg-[#0a0f1a] flex items-center justify-center">
        <RefreshCw className="w-8 h-8 text-white/30 animate-spin" />
      </div>
    );
  }

  if (!detail) return null;

  return (
    <div className="min-h-screen bg-[#0a0f1a] text-white">
      {/* Header */}
      <div className="sticky top-0 z-10 bg-[#0a0f1a]/95 backdrop-blur border-b border-white/10 px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={() => navigate('/general-play')}>
            <ChevronLeft className="w-5 h-5" />
          </Button>
          <div>
            <p className="text-xs text-white/40">
              {new Date(detail.round.playedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}
              {' · '}{totalHoles} holes
            </p>
            <div className="flex items-center gap-2">
              <Badge className={`text-xs ${detail.round.status === 'confirmed' ? 'bg-emerald-500/20 text-emerald-300' : detail.round.status === 'pending_marker' ? 'bg-amber-500/20 text-amber-300' : 'bg-blue-500/20 text-blue-300'}`}>
                {detail.round.status.replace('_', ' ')}
              </Badge>
              <span className="text-sm text-white/60">{scoredCount}/{totalHoles} holes</span>
            </div>
          </div>
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" className="text-xs text-white/60" onClick={() => setShowScorecard(true)}>
            Scorecard
          </Button>
          {isEditable && allScored && (
            <Button size="sm" style={{ background: GOLD, color: '#000' }} onClick={() => setShowSubmit(true)}>
              <Send className="w-3 h-3 mr-1" /> Submit
            </Button>
          )}
        </div>
      </div>

      {/* Status banners */}
      {detail.round.status === 'pending_marker' && (
        <div className="bg-amber-500/10 border-b border-amber-500/20 px-4 py-3 text-center">
          <div className="flex items-center justify-center gap-2 text-amber-300">
            <Clock className="w-4 h-4" />
            <span className="text-sm">Awaiting marker countersign</span>
            {detail.round.markerDeadlineAt && (
              <span className="text-xs text-amber-300/60">
                · Deadline: {new Date(detail.round.markerDeadlineAt).toLocaleDateString('en-IN')}
              </span>
            )}
          </div>
        </div>
      )}
      {detail.round.status === 'confirmed' && (
        <div className="bg-emerald-500/10 border-b border-emerald-500/20 px-4 py-3 text-center">
          <div className="flex items-center justify-center gap-2 text-emerald-300">
            <CheckCircle2 className="w-4 h-4" />
            <span className="text-sm">Round confirmed · Differential: {Number(detail.round.scoreDifferential ?? 0).toFixed(1)}</span>
          </div>
        </div>
      )}

      {isEditable ? (
        <div className="p-4 max-w-md mx-auto">
          {/* Hole navigation */}
          <div className="flex items-center justify-between mb-6 mt-2">
            <Button variant="ghost" size="icon" onClick={() => setCurrentHole(h => Math.max(1, h - 1))} disabled={currentHole <= 1}>
              <ChevronLeft className="w-5 h-5" />
            </Button>
            <div className="text-center">
              <div className="text-xs text-white/40 uppercase tracking-wider mb-1">Hole</div>
              <div className="text-4xl font-bold" style={{ color: GOLD }}>{currentHole}</div>
              {currentCourseHole && (
                <div className="flex items-center gap-3 mt-1 text-xs text-white/40">
                  <span>Par {currentCourseHole.par}</span>
                  {currentCourseHole.handicap && <span>SI {currentCourseHole.handicap}</span>}
                  {currentCourseHole.distance && <span>{currentCourseHole.distance}m</span>}
                </div>
              )}
            </div>
            <Button variant="ghost" size="icon" onClick={() => setCurrentHole(h => Math.min(totalHoles, h + 1))} disabled={currentHole >= totalHoles}>
              <ChevronRight className="w-5 h-5" />
            </Button>
          </div>

          {/* Hole Map Panel */}
          {detail.round.courseId && roundId && (
            <HoleMapPanel
              courseId={detail.round.courseId}
              roundId={roundId}
              currentHole={currentHole}
              par={currentCourseHole?.par}
              mode="general-play"
            />
          )}

          {/* Score entry */}
          <Card className="bg-[#111827] border-[#1e2d3d] p-6">
            <div className="text-center mb-6">
              <p className="text-white/40 text-sm mb-4">Strokes</p>
              <ScoreButton value={strokes} onChange={setStrokes} min={1} max={20} />
              {currentCourseHole && (
                <div className="mt-4">
                  {toParBadge(toPar(strokes, currentCourseHole.par))}
                </div>
              )}
            </div>

            {/* More Stats Toggle */}
            <button
              onClick={handleToggleMoreStats}
              className="w-full flex items-center justify-center gap-2 text-xs text-white/40 hover:text-white/70 py-2 mb-3 border border-white/10 rounded-lg hover:bg-white/5 transition-colors"
            >
              {showMoreStats ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
              {showMoreStats ? 'Hide stats' : 'More stats (putts, GIR, fairway…)'}
            </button>

            {showMoreStats && (
              <div className="space-y-4 mb-5 border border-white/10 rounded-xl p-4 bg-white/2">

                {/* Putts */}
                <div className="flex items-center justify-between">
                  <span className="text-sm text-white/60">Putts</span>
                  <SmallCounter value={putts ?? 2} onChange={v => setPutts(v)} min={0} max={8} />
                </div>

                {/* Fairway (hidden for par 3s) */}
                {!isParThree && (
                  <div>
                    <p className="text-sm text-white/60 mb-2">Fairway</p>
                    <div className="flex gap-2">
                      <ToggleChip
                        label="◀ Left"
                        active={fairwayHit === 'left'}
                        onClick={() => setFairwayHit(fairwayHit === 'left' ? null : 'left')}
                        color="bg-orange-500/30 text-orange-200 border-orange-500/40"
                      />
                      <ToggleChip
                        label="✓ Hit"
                        active={fairwayHit === 'hit'}
                        onClick={() => setFairwayHit(fairwayHit === 'hit' ? null : 'hit')}
                        color="bg-emerald-500/30 text-emerald-200 border-emerald-500/40"
                      />
                      <ToggleChip
                        label="▶ Right"
                        active={fairwayHit === 'right'}
                        onClick={() => setFairwayHit(fairwayHit === 'right' ? null : 'right')}
                        color="bg-orange-500/30 text-orange-200 border-orange-500/40"
                      />
                    </div>
                  </div>
                )}

                {/* GIR */}
                <div className="flex items-center justify-between">
                  <div>
                    <span className="text-sm text-white/60">GIR</span>
                    <span className="text-xs text-white/30 ml-2">(auto: {effectiveGir ? 'Yes' : 'No'})</span>
                  </div>
                  <div className="flex gap-2">
                    <ToggleChip
                      label="Yes"
                      active={effectiveGir === true && girOverride !== null}
                      onClick={() => setGirOverride(girOverride === true ? null : true)}
                      color="bg-emerald-500/30 text-emerald-200 border-emerald-500/40"
                    />
                    <ToggleChip
                      label="No"
                      active={effectiveGir === false && girOverride !== null}
                      onClick={() => setGirOverride(girOverride === false ? null : false)}
                      color="bg-red-500/30 text-red-200 border-red-500/40"
                    />
                  </div>
                </div>
                {girOverride === null && (
                  <p className="text-xs text-white/25 -mt-2">Auto-calculated from strokes vs par. Tap to override.</p>
                )}

                {/* Sand Save */}
                <div className="flex items-center justify-between">
                  <span className="text-sm text-white/60">Sand Save</span>
                  <div className="flex gap-2">
                    <ToggleChip
                      label="Yes"
                      active={sandSave === true}
                      onClick={() => setSandSave(sandSave === true ? null : true)}
                      color="bg-amber-500/30 text-amber-200 border-amber-500/40"
                    />
                    <ToggleChip
                      label="No"
                      active={sandSave === false}
                      onClick={() => setSandSave(sandSave === false ? null : false)}
                      color="bg-red-500/30 text-red-200 border-red-500/40"
                    />
                  </div>
                </div>

                {/* Up & Down */}
                <div className="flex items-center justify-between">
                  <span className="text-sm text-white/60">Up & Down</span>
                  <div className="flex gap-2">
                    <ToggleChip
                      label="Yes"
                      active={upAndDown === true}
                      onClick={() => setUpAndDown(upAndDown === true ? null : true)}
                      color="bg-emerald-500/30 text-emerald-200 border-emerald-500/40"
                    />
                    <ToggleChip
                      label="No"
                      active={upAndDown === false}
                      onClick={() => setUpAndDown(upAndDown === false ? null : false)}
                      color="bg-red-500/30 text-red-200 border-red-500/40"
                    />
                  </div>
                </div>

                {/* Penalties */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-sm text-white/60">Penalties</span>
                    <SmallCounter value={penalties} onChange={setPenalties} min={0} max={5} />
                  </div>
                  {penalties > 0 && (
                    <div className="flex gap-2 flex-wrap">
                      {PENALTY_REASONS.map(r => (
                        <ToggleChip
                          key={r}
                          label={r}
                          active={penaltyReason === r}
                          onClick={() => setPenaltyReason(penaltyReason === r ? null : r)}
                          color="bg-red-500/30 text-red-200 border-red-500/40"
                        />
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}

            <Button
              className="w-full h-12 text-base font-semibold"
              style={{ background: GOLD, color: '#000' }}
              onClick={saveHole}
              disabled={saving}
            >
              {saving ? 'Saving...' : existingScore ? 'Update Score' : 'Save & Next'}
            </Button>

            {/* Shot tracking toggle */}
            <button
              onClick={() => setShowShotPanel(p => !p)}
              className="mt-3 w-full flex items-center justify-center gap-2 py-2 rounded-lg border border-white/10 text-xs text-white/50 hover:bg-white/5 transition"
            >
              <Crosshair className="w-3.5 h-3.5" />
              Track Shot{(shotsByHole[currentHole] ?? 0) > 0 ? ` (${shotsByHole[currentHole]} logged)` : ''}
            </button>
          </Card>

          {/* Shot detail panel — tied to currentHole */}
          {showShotPanel && (
            <Card className="bg-[#111827] border-[#1e2d3d] p-4 mt-3">
              <div className="flex items-center justify-between mb-3">
                <span className="text-xs font-bold text-white/60 uppercase tracking-widest">Shot Detail — Hole {currentHole}</span>
                <button onClick={() => setShowShotPanel(false)} className="text-white/30 hover:text-white/60">✕</button>
              </div>
              {/* Shot type */}
              <p className="text-[10px] text-white/30 uppercase tracking-widest font-bold mb-2">Shot Type</p>
              <div className="flex flex-wrap gap-1.5 mb-3">
                {SHOT_TYPES.map(t => (
                  <button key={t} onClick={() => setSelectedShotType(t)}
                    className={`px-3 py-1 rounded-full text-xs font-semibold border transition ${selectedShotType === t ? 'border-[#C9A84C] text-[#C9A84C] bg-[#C9A84C]/10' : 'border-white/10 text-white/40 hover:bg-white/5'}`}>
                    {t.charAt(0).toUpperCase() + t.slice(1)}
                  </button>
                ))}
              </div>
              {/* Club picker (dropdown sourced from club profile, falling back to standard list) */}
              <p className="text-[10px] text-white/30 uppercase tracking-widest font-bold mb-2">
                CLUB{suggestedClubWeb && !selectedClub ? <span className="ml-2 text-[#C9A84C] normal-case font-normal">· AI suggests {suggestedClubWeb}</span> : ''}
              </p>
              <div className="mb-3">
                {(() => {
                  // Build ordered club list: profile clubs first (sorted by avgDistance desc), then remaining standard clubs
                  const profileClubs = clubProfile.map(e => e.club);
                  const remaining = STANDARD_CLUBS.filter(c => !profileClubs.includes(c));
                  const allClubs = [...profileClubs, ...remaining];
                  const effectiveClub = selectedClub ?? suggestedClubWeb;
                  return (
                    <Select value={effectiveClub ?? ''} onValueChange={v => setSelectedClub(v || null)}>
                      <SelectTrigger className="w-full bg-[#0a0f1a] border-white/10 text-white">
                        <SelectValue placeholder="Select club…" />
                      </SelectTrigger>
                      <SelectContent className="bg-[#111827] border-white/10 text-white max-h-60">
                        {suggestedClubWeb && (
                          <SelectItem value={suggestedClubWeb} className="text-[#C9A84C]">
                            {suggestedClubWeb} ✦ AI suggested
                          </SelectItem>
                        )}
                        {allClubs.filter(c => c !== suggestedClubWeb).map(club => (
                          <SelectItem key={club} value={club} className="text-white/80">
                            {club}{profileClubs.includes(club) ? ' ·' : ''}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  );
                })()}
              </div>
              {/* Miss direction */}
              <p className="text-[10px] text-white/30 uppercase tracking-widest font-bold mb-2">Miss Direction</p>
              <div className="flex flex-wrap gap-1.5 mb-3">
                {MISS_DIRECTIONS.map(d => (
                  <button key={d} onClick={() => setSelectedMissDir(selectedMissDir === d ? null : d)}
                    className={`px-3 py-1 rounded-full text-xs font-semibold border transition ${selectedMissDir === d ? 'border-[#C9A84C] text-[#C9A84C] bg-[#C9A84C]/10' : 'border-white/10 text-white/40 hover:bg-white/5'}`}>
                    {d}
                  </button>
                ))}
              </div>
              {/* Lie */}
              <p className="text-[10px] text-white/30 uppercase tracking-widest font-bold mb-2">Lie</p>
              <div className="flex flex-wrap gap-1.5 mb-3">
                {LIE_TYPES.map(l => (
                  <button key={l} onClick={() => setSelectedLieType(selectedLieType === l ? null : l)}
                    className={`px-3 py-1 rounded-full text-xs font-semibold border transition ${selectedLieType === l ? 'border-[#C9A84C] text-[#C9A84C] bg-[#C9A84C]/10' : 'border-white/10 text-white/40 hover:bg-white/5'}`}>
                    {l}
                  </button>
                ))}
              </div>
              {/* Shape */}
              <p className="text-[10px] text-white/30 uppercase tracking-widest font-bold mb-2">Shape</p>
              <div className="flex flex-wrap gap-1.5 mb-3">
                {SHOT_SHAPES.map(s => (
                  <button key={s} onClick={() => setSelectedShotShape(selectedShotShape === s ? null : s)}
                    className={`px-3 py-1 rounded-full text-xs font-semibold border transition ${selectedShotShape === s ? 'border-[#C9A84C] text-[#C9A84C] bg-[#C9A84C]/10' : 'border-white/10 text-white/40 hover:bg-white/5'}`}>
                    {s}
                  </button>
                ))}
              </div>
              {/* Penalty */}
              <p className="text-[10px] text-white/30 uppercase tracking-widest font-bold mb-2">Penalty</p>
              <div className="flex flex-wrap gap-1.5 mb-4">
                {PENALTY_REASONS.map(r => (
                  <button key={r} onClick={() => setSelectedPenaltyReason(selectedPenaltyReason === r ? null : r)}
                    className={`px-3 py-1 rounded-full text-xs font-semibold border transition ${selectedPenaltyReason === r ? 'border-red-400 text-red-400 bg-red-400/10' : 'border-white/10 text-white/40 hover:bg-white/5'}`}>
                    {r}
                  </button>
                ))}
              </div>
              <Button
                className="w-full font-semibold"
                style={{ background: GOLD, color: '#000' }}
                onClick={handleLogShot}
              >
                <PlusCircle className="w-4 h-4 mr-2" />
                Log Shot{selectedClub ? ` · ${selectedClub}` : ''}
              </Button>
            </Card>
          )}

          {/* Hole dots */}
          <div className="mt-4 flex flex-wrap gap-1.5 justify-center">
            {Array.from({ length: totalHoles }, (_, i) => i + 1).map(h => {
              const sc = detail.holes.find(s => s.holeNumber === h);
              const ch = detail.courseHoles.find(c => c.holeNumber === h);
              const tp = sc && ch ? toPar(sc.strokes, ch.par) : null;
              const isActive = h === currentHole;
              return (
                <button
                  key={h}
                  onClick={() => setCurrentHole(h)}
                  className={`w-8 h-8 rounded-full text-xs font-bold transition-all ${
                    isActive ? 'ring-2 ring-offset-1 ring-offset-[#0a0f1a]' : ''
                  } ${
                    sc
                      ? tp !== null && tp <= -1 ? 'bg-red-500/70 text-white' : tp === 0 ? 'bg-white/20 text-white' : 'bg-blue-500/40 text-white'
                      : 'bg-white/10 text-white/40'
                  }`}
                  style={isActive ? { outlineColor: GOLD } : undefined}
                >
                  {h}
                </button>
              );
            })}
          </div>

          {/* Running totals */}
          {scoredCount > 0 && (
            <Card className="bg-[#111827] border-[#1e2d3d] p-4 mt-4">
              <div className="flex justify-between text-sm">
                <span className="text-white/50">Running Total ({scoredCount} holes)</span>
                <span className="font-bold text-white">
                  {totalGross}
                  {totalPar > 0 && (
                    <span className={`ml-2 text-xs ${totalGross - (totalPar * scoredCount / totalHoles) > 0 ? 'text-blue-400' : 'text-red-400'}`}>
                      ({totalGross - Math.round(totalPar * scoredCount / totalHoles) > 0 ? '+' : ''}{totalGross - Math.round(totalPar * scoredCount / totalHoles)})
                    </span>
                  )}
                </span>
              </div>
              {/* Mini stats summary */}
              {detail.holes.some(h => h.putts !== null) && (
                <div className="flex gap-4 mt-2 text-xs text-white/40">
                  {(() => {
                    const puttHoles = detail.holes.filter(h => h.putts !== null);
                    const avgPutts = puttHoles.length > 0
                      ? (puttHoles.reduce((s, h) => s + (h.putts ?? 0), 0) / puttHoles.length).toFixed(1)
                      : null;
                    const girHoles = detail.holes.filter(h => h.gir !== null);
                    const girCount = girHoles.filter(h => h.gir).length;
                    const fwHoles = detail.holes.filter(h => h.fairwayHit !== null);
                    const fwHit = fwHoles.filter(h => h.fairwayHit === 'hit').length;
                    return (
                      <>
                        {avgPutts && <span>Putts: {avgPutts}/hole</span>}
                        {girHoles.length > 0 && <span>GIR: {girCount}/{girHoles.length}</span>}
                        {fwHoles.length > 0 && <span>FW: {fwHit}/{fwHoles.length}</span>}
                      </>
                    );
                  })()}
                </div>
              )}
              <ShotSourceBadges breakdown={sourceBreakdown} />
            </Card>
          )}
        </div>
      ) : (
        /* Read-only summary for completed/pending rounds */
        <div className="p-4 max-w-md mx-auto">
          <Card className="bg-[#111827] border-[#1e2d3d] p-6 text-center">
            <div className="text-5xl font-bold mb-2" style={{ color: GOLD }}>{totalGross}</div>
            <p className="text-white/50 text-sm mb-4">Gross Score</p>
            {detail.round.scoreDifferential && (
              <div>
                <p className="text-white/40 text-xs mb-1">Score Differential</p>
                <p className="text-2xl font-bold text-white">{Number(detail.round.scoreDifferential).toFixed(1)}</p>
              </div>
            )}
          </Card>

          {/* Stats summary for completed rounds */}
          {detail.holes.some(h => h.putts !== null) && (() => {
            const puttHoles = detail.holes.filter(h => h.putts !== null);
            const avgPutts = puttHoles.length > 0
              ? (puttHoles.reduce((s, h) => s + (h.putts ?? 0), 0) / puttHoles.length).toFixed(1)
              : null;
            const girHoles = detail.holes.filter(h => h.gir !== null);
            const girCount = girHoles.filter(h => h.gir).length;
            const fwHoles = detail.holes.filter(h => h.fairwayHit !== null);
            const fwHit = fwHoles.filter(h => h.fairwayHit === 'hit').length;
            const totalPutts = puttHoles.reduce((s, h) => s + (h.putts ?? 0), 0);
            return (
              <Card className="bg-[#111827] border-[#1e2d3d] p-4 mt-4 grid grid-cols-3 gap-3">
                {avgPutts && (
                  <div className="text-center">
                    <p className="text-lg font-bold text-purple-300">{totalPutts}</p>
                    <p className="text-xs text-white/40">Total Putts</p>
                  </div>
                )}
                {girHoles.length > 0 && (
                  <div className="text-center">
                    <p className="text-lg font-bold text-emerald-300">{girCount}/{girHoles.length}</p>
                    <p className="text-xs text-white/40">GIR</p>
                  </div>
                )}
                {fwHoles.length > 0 && (
                  <div className="text-center">
                    <p className="text-lg font-bold text-green-300">{fwHit}/{fwHoles.length}</p>
                    <p className="text-xs text-white/40">Fairways</p>
                  </div>
                )}
              </Card>
            );
          })()}

          {/* Task #709 — shot source breakdown for completed rounds. */}
          {sourceBreakdown && sourceBreakdown.total > 0 && (
            <Card className="bg-[#111827] border-[#1e2d3d] p-4 mt-4">
              <p className="text-xs text-white/40 mb-2">Shot Tracking ({sourceBreakdown.total} shots)</p>
              <ShotSourceBadges breakdown={sourceBreakdown} />
            </Card>
          )}
        </div>
      )}

      {/* Scorecard Modal */}
      <Dialog open={showScorecard} onOpenChange={setShowScorecard}>
        <DialogContent className="bg-[#111827] border-[#1e2d3d] text-white max-w-2xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Scorecard</DialogTitle>
          </DialogHeader>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/10 text-white/40 text-xs">
                  <th className="text-left p-2">Hole</th>
                  <th className="text-center p-2">Par</th>
                  <th className="text-center p-2">SI</th>
                  <th className="text-center p-2">Score</th>
                  <th className="text-center p-2">+/-</th>
                  <th className="text-center p-2">Putts</th>
                  <th className="text-center p-2">GIR</th>
                  <th className="text-center p-2">FW</th>
                </tr>
              </thead>
              <tbody>
                {detail.courseHoles.slice(0, totalHoles).map(ch => {
                  const sc = detail.holes.find(h => h.holeNumber === ch.holeNumber);
                  const tp = sc ? toPar(sc.strokes, ch.par) : null;
                  return (
                    <tr key={ch.holeNumber} className="border-b border-white/5">
                      <td className="p-2 font-medium text-white">{ch.holeNumber}</td>
                      <td className="p-2 text-center text-white/60">{ch.par}</td>
                      <td className="p-2 text-center text-white/40">{ch.handicap ?? '—'}</td>
                      <td className="p-2 text-center">
                        {sc ? <span className="font-bold text-white">{sc.strokes}</span> : <span className="text-white/20">—</span>}
                      </td>
                      <td className="p-2 text-center">
                        {tp !== null && (
                          <span className={`font-medium ${tp < 0 ? 'text-red-400' : tp > 0 ? 'text-blue-400' : 'text-white/40'}`}>
                            {tp > 0 ? `+${tp}` : tp === 0 ? 'E' : tp}
                          </span>
                        )}
                      </td>
                      <td className="p-2 text-center text-white/60">
                        {sc?.putts != null ? sc.putts : <span className="text-white/20">—</span>}
                      </td>
                      <td className="p-2 text-center">
                        {sc?.gir != null ? (
                          <span className={sc.gir ? 'text-emerald-400' : 'text-red-400/60'}>{sc.gir ? '✓' : '✗'}</span>
                        ) : <span className="text-white/20">—</span>}
                      </td>
                      <td className="p-2 text-center">
                        {ch.par === 3 ? <span className="text-white/20">—</span> : (
                          sc?.fairwayHit ? (
                            <span className={sc.fairwayHit === 'hit' ? 'text-emerald-400' : 'text-orange-400'}>
                              {sc.fairwayHit === 'hit' ? '✓' : sc.fairwayHit === 'left' ? 'L' : 'R'}
                            </span>
                          ) : <span className="text-white/20">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {scoredCount > 0 && (
                  <tr className="border-t-2 border-white/20 font-bold">
                    <td className="p-2 text-white">Total</td>
                    <td className="p-2 text-center text-white/60">{totalPar}</td>
                    <td className="p-2" />
                    <td className="p-2 text-center text-white">{totalGross}</td>
                    <td className="p-2 text-center">
                      <span className={totalGross - totalPar > 0 ? 'text-blue-400' : 'text-red-400'}>
                        {totalGross - totalPar > 0 ? `+${totalGross - totalPar}` : totalGross - totalPar === 0 ? 'E' : totalGross - totalPar}
                      </span>
                    </td>
                    <td className="p-2 text-center text-white/60">
                      {(() => {
                        const ph = detail.holes.filter(h => h.putts !== null);
                        return ph.length > 0 ? ph.reduce((s, h) => s + (h.putts ?? 0), 0) : '—';
                      })()}
                    </td>
                    <td className="p-2 text-center text-white/60">
                      {(() => {
                        const gh = detail.holes.filter(h => h.gir !== null);
                        return gh.length > 0 ? `${gh.filter(h => h.gir).length}/${gh.length}` : '—';
                      })()}
                    </td>
                    <td className="p-2 text-center text-white/60">
                      {(() => {
                        const fh = detail.holes.filter(h => h.fairwayHit !== null);
                        return fh.length > 0 ? `${fh.filter(h => h.fairwayHit === 'hit').length}/${fh.length}` : '—';
                      })()}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </DialogContent>
      </Dialog>

      {/* Submit Modal */}
      <Dialog open={showSubmit} onOpenChange={setShowSubmit}>
        <DialogContent className="bg-[#111827] border-[#1e2d3d] text-white">
          <DialogHeader>
            <DialogTitle>Submit for Marker Countersign</DialogTitle>
          </DialogHeader>
          <p className="text-white/50 text-sm">Your marker will receive a notification to review and confirm your scorecard. Your score cannot be changed after submission.</p>
          <div className="space-y-4 py-4">
            <div>
              <Label className="text-white/60 text-sm">Marker Name *</Label>
              <Input
                value={markerName}
                onChange={e => setMarkerName(e.target.value)}
                placeholder="Full name of your marker"
                className="mt-1 bg-white/5 border-white/20 text-white placeholder:text-white/30"
              />
            </div>
            <div>
              <Label className="text-white/60 text-sm">Marker Email (optional)</Label>
              <Input
                type="email"
                value={markerEmail}
                onChange={e => setMarkerEmail(e.target.value)}
                placeholder="For email confirmation"
                className="mt-1 bg-white/5 border-white/20 text-white placeholder:text-white/30"
              />
            </div>
            <div>
              <Label className="text-white/60 text-sm">Marker GHIN Number (optional)</Label>
              <Input
                value={markerGhin}
                onChange={e => setMarkerGhin(e.target.value)}
                placeholder="GHIN ID if known"
                className="mt-1 bg-white/5 border-white/20 text-white placeholder:text-white/30"
              />
            </div>

            <div className="bg-white/5 rounded-lg p-3 flex justify-between">
              <span className="text-white/50 text-sm">Gross Score</span>
              <span className="font-bold text-white">{totalGross}</span>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowSubmit(false)}>Cancel</Button>
            <Button onClick={submitRound} disabled={submitting} style={{ background: GOLD, color: '#000' }}>
              {submitting ? 'Submitting...' : 'Submit for Countersign'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
