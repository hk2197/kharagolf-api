import React, { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useActiveOrgContext } from '@/context/ActiveOrgContext';
import { useToast } from '@/hooks/use-toast';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  AlertTriangle, CheckCircle2, RefreshCw, Award, Search, TrendingUp, TrendingDown,
  CalendarClock, Shield, FileDown, Stamp,
} from 'lucide-react';

const GOLD = '#C9A84C';

interface PlayerWHSState {
  playerId: number;
  playerName: string;
  email: string | null;
  ghinNumber: string | null;
  handicapIndex: string | null;
  lowHandicapIndex: string | null;
  scoringRecordCount: number;
  phase: number;
  softCapApplied: boolean;
  hardCapApplied: boolean;
  lastCalculatedAt: string | null;
  establishedAt: string | null;
  eligible: boolean;
}

const phaseLabel: Record<number, { label: string; color: string }> = {
  0: { label: 'Not Started', color: 'text-muted-foreground' },
  1: { label: 'Initialisation', color: 'text-amber-400' },
  2: { label: 'Soft Cap', color: 'text-blue-400' },
  3: { label: 'Established', color: 'text-emerald-400' },
};

export default function AnnualHandicapReviewPage() {
  const { activeOrgId: orgId } = useActiveOrgContext();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [recalcingAll, setRecalcingAll] = useState(false);
  const [runningReview, setRunningReview] = useState(false);
  const [reviewStamp, setReviewStamp] = useState<{ reviewCompletedAt: string | null } | null>(null);

  const { data: players = [], isLoading } = useQuery<PlayerWHSState[]>({
    queryKey: ['/api/organizations/whs-states', orgId],
    queryFn: () =>
      fetch(`/api/organizations/${orgId}/whs/states`, { credentials: 'include' })
        .then(r => { if (!r.ok) throw new Error('Failed'); return r.json(); }),
    enabled: !!orgId,
    staleTime: 30_000,
  });

  useEffect(() => {
    if (!orgId) return;
    fetch(`/api/organizations/${orgId}/whs/review-status`, { credentials: 'include' })
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (data) setReviewStamp(data); })
      .catch(() => undefined);
  }, [orgId]);

  async function recalcAll() {
    if (!orgId) return;
    setRecalcingAll(true);
    try {
      const res = await fetch(`/api/organizations/${orgId}/whs/recalc-all`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!res.ok) throw new Error('Failed');
      const data = await res.json();
      toast({ title: `Recalculated ${data.processed ?? '...'} handicap indexes` });
      qc.invalidateQueries({ queryKey: ['/api/organizations/whs-states', orgId] });
    } catch {
      toast({ title: 'Recalculation failed', variant: 'destructive' });
    } finally { setRecalcingAll(false); }
  }

  async function runAnnualReview() {
    if (!orgId) return;
    setRunningReview(true);
    try {
      const res = await fetch(`/api/organizations/${orgId}/whs/annual-review`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ year: new Date().getFullYear() }),
      });
      if (!res.ok) throw new Error('Failed');
      const data = await res.json();
      toast({
        title: `2026 Annual Handicap Review complete`,
        description: `${data.updated ?? '...'} players' Low H.I. reset for new season`,
      });
      if (data.reviewedAt) setReviewStamp({ reviewCompletedAt: data.reviewedAt });
      qc.invalidateQueries({ queryKey: ['/api/organizations/whs-states', orgId] });
    } catch {
      toast({ title: 'Annual review failed', variant: 'destructive' });
    } finally { setRunningReview(false); }
  }

  function exportPdf() {
    if (!orgId) return;
    window.open(`/api/organizations/${orgId}/whs/annual-review/pdf`, '_blank');
  }

  const filtered = players.filter(p =>
    !search ||
    p.playerName.toLowerCase().includes(search.toLowerCase()) ||
    (p.email?.toLowerCase().includes(search.toLowerCase())) ||
    (p.ghinNumber?.includes(search))
  );

  const established = players.filter(p => p.phase === 3).length;
  const softCapCount = players.filter(p => p.softCapApplied).length;
  const hardCapCount = players.filter(p => p.hardCapApplied).length;
  const avgHI = players
    .filter(p => p.handicapIndex != null)
    .map(p => parseFloat(p.handicapIndex!));
  const avgHIVal = avgHI.length > 0 ? (avgHI.reduce((a, b) => a + b, 0) / avgHI.length).toFixed(1) : '—';

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-7xl mx-auto p-6 space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <div className="flex items-center gap-2">
              <Shield className="w-6 h-6" style={{ color: GOLD }} />
              <h1 className="text-2xl font-bold">2026 Annual Handicap Review</h1>
            </div>
            <p className="text-sm text-muted-foreground mt-1">
              Review and manage WHS Handicap Indexes for all club members. Run the annual review to reset Low H.I. for the new season.
            </p>
          </div>
          <div className="flex gap-2 flex-wrap">
            <Button
              variant="outline"
              size="sm"
              onClick={recalcAll}
              disabled={recalcingAll}
              className="gap-2"
            >
              <RefreshCw className={`w-4 h-4 ${recalcingAll ? 'animate-spin' : ''}`} />
              {recalcingAll ? 'Recalculating...' : 'Recalc All H.I.'}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={exportPdf}
              className="gap-2"
            >
              <FileDown className="w-4 h-4" />
              Export Report
            </Button>
            <Button
              size="sm"
              onClick={runAnnualReview}
              disabled={runningReview}
              className="gap-2 text-black"
              style={{ backgroundColor: GOLD }}
            >
              <CalendarClock className="w-4 h-4" />
              {runningReview ? 'Running...' : 'Run Annual Review'}
            </Button>
          </div>
        </div>

        {/* Review Completed Stamp */}
        {reviewStamp?.reviewCompletedAt && (
          <div className="flex items-center gap-2 p-3 rounded-lg border border-emerald-500/30 bg-emerald-500/5">
            <CheckCircle2 className="w-4 h-4 text-emerald-400 flex-shrink-0" />
            <p className="text-sm text-emerald-400 font-medium">
              Annual Review Completed —{' '}
              <span className="font-normal text-muted-foreground">
                {new Date(reviewStamp.reviewCompletedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
              </span>
            </p>
          </div>
        )}

        {/* Stats */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          {[
            { label: 'Total Players', value: players.length, icon: <Award className="w-4 h-4" style={{ color: GOLD }} /> },
            { label: 'Established H.I.', value: established, icon: <CheckCircle2 className="w-4 h-4 text-emerald-400" /> },
            { label: 'Soft Cap Applied', value: softCapCount, icon: <TrendingDown className="w-4 h-4 text-amber-400" /> },
            { label: 'Club Avg H.I.', value: avgHIVal, icon: <TrendingUp className="w-4 h-4 text-blue-400" /> },
          ].map(({ label, value, icon }) => (
            <div key={label} className="bg-card border border-border rounded-lg p-4">
              <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1">
                {icon}
                <span>{label}</span>
              </div>
              <p className="text-2xl font-bold">{value}</p>
            </div>
          ))}
        </div>

        {/* Soft/Hard cap warning */}
        {(softCapCount > 0 || hardCapCount > 0) && (
          <div className="flex items-start gap-2 p-3 rounded-lg border border-amber-500/30 bg-amber-500/5">
            <AlertTriangle className="w-4 h-4 text-amber-400 mt-0.5 flex-shrink-0" />
            <p className="text-sm text-amber-300">
              {softCapCount} player{softCapCount !== 1 ? 's' : ''} with soft cap applied
              {hardCapCount > 0 ? `, ${hardCapCount} with hard cap` : ''}.
              Caps limit upward movement in H.I. per WHS §5.8. Run the Annual Review to reset Low H.I. for the new season.
            </p>
          </div>
        )}

        {/* Search */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="Search player, email, or GHIN number..."
            className="pl-9"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>

        {/* Table */}
        <div className="rounded-lg border border-border overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Player</TableHead>
                <TableHead>GHIN #</TableHead>
                <TableHead>H.I.</TableHead>
                <TableHead>Low H.I.</TableHead>
                <TableHead>Phase</TableHead>
                <TableHead>Scores</TableHead>
                <TableHead>Caps</TableHead>
                <TableHead>Last Calculated</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={8} className="text-center text-muted-foreground py-8">
                    Loading handicap data...
                  </TableCell>
                </TableRow>
              ) : filtered.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="text-center text-muted-foreground py-8">
                    {search ? 'No players match your search' : 'No players found'}
                  </TableCell>
                </TableRow>
              ) : (
                filtered.map(p => {
                  const phase = phaseLabel[p.phase] ?? { label: 'Unknown', color: 'text-muted-foreground' };
                  const hiNum = p.handicapIndex ? parseFloat(p.handicapIndex) : null;
                  const lowNum = p.lowHandicapIndex ? parseFloat(p.lowHandicapIndex) : null;
                  const drift = hiNum != null && lowNum != null ? hiNum - lowNum : null;
                  return (
                    <TableRow key={p.playerId}>
                      <TableCell>
                        <div>
                          <p className="font-medium text-sm">{p.playerName}</p>
                          {p.email && <p className="text-xs text-muted-foreground">{p.email}</p>}
                        </div>
                      </TableCell>
                      <TableCell>
                        {p.ghinNumber
                          ? <span className="text-xs font-mono bg-emerald-500/10 text-emerald-400 px-2 py-0.5 rounded">{p.ghinNumber}</span>
                          : <span className="text-xs text-muted-foreground">—</span>
                        }
                      </TableCell>
                      <TableCell>
                        {hiNum != null ? (
                          <span className="text-base font-bold" style={{ color: GOLD }}>{hiNum.toFixed(1)}</span>
                        ) : (
                          <span className="text-muted-foreground text-sm">N/A</span>
                        )}
                      </TableCell>
                      <TableCell>
                        {lowNum != null ? (
                          <div className="flex items-center gap-1">
                            <span className="text-sm font-semibold">{lowNum.toFixed(1)}</span>
                            {drift != null && drift > 0 && (
                              <span className="text-xs text-amber-400">+{drift.toFixed(1)}</span>
                            )}
                          </div>
                        ) : (
                          <span className="text-muted-foreground text-sm">—</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <span className={`text-xs font-medium ${phase.color}`}>{phase.label}</span>
                      </TableCell>
                      <TableCell>
                        <span className="text-sm">{p.scoringRecordCount}</span>
                      </TableCell>
                      <TableCell>
                        <div className="flex gap-1">
                          {p.softCapApplied && (
                            <Badge variant="outline" className="text-amber-400 border-amber-500/30 text-xs">Soft Cap</Badge>
                          )}
                          {p.hardCapApplied && (
                            <Badge variant="outline" className="text-red-400 border-red-500/30 text-xs">Hard Cap</Badge>
                          )}
                          {!p.softCapApplied && !p.hardCapApplied && (
                            <span className="text-xs text-muted-foreground">None</span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        {p.lastCalculatedAt ? (
                          <span className="text-xs text-muted-foreground">
                            {new Date(p.lastCalculatedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}
                          </span>
                        ) : (
                          <span className="text-xs text-muted-foreground">Never</span>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </div>

        <p className="text-xs text-muted-foreground">
          WHS 2024 compliant. Handicap Index calculated per §5.3 (best 8 of 20 differentials), subject to §5.8 Soft/Hard Caps and §5.9 Exceptional Score Reduction.
          Annual review resets Low H.I. to current H.I. for the new season, removing any cap penalties from prior year.
        </p>
      </div>
    </div>
  );
}
