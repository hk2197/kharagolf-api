import { useState, useEffect } from 'react';
import { useLocation } from 'wouter';
import {
  TrendingDown, TrendingUp, Minus, Award, Activity, Clock, ChevronLeft,
  ChevronRight, Info, Star, BarChart2, CheckCircle2, AlertTriangle, RefreshCw,
  Gavel, HelpCircle,
} from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';
import { useGetMe } from '@workspace/api-client-react';

interface WhsState {
  totalHolesPosted: number;
  establishmentPhase: number;
  currentHandicapIndex: string | null;
  lowHandicapIndex: string | null;
  lowHandicapIndexDate: string | null;
  isProvisional: boolean;
  lastRecalcAt: string | null;
}

interface ScoreRecord {
  id: number;
  courseId: number | null;
  source: 'tournament' | 'general_play';
  holesPlayed: number;
  is9Hole: boolean;
  grossScore: number | null;
  adjustedGrossScore: number;
  courseRating: string;
  slopeRating: number;
  pccAdjustment: string | null;
  esrAdjustment: string | null;
  differential: string;
  markerName: string | null;
  handicapIndexAfter: string | null;
  playedAt: string;
  courseName: string | null;
  tournamentName: string | null;
  isExceptional: boolean;
}

const GOLD = '#C9A84C';

function HiTrend({ current, prev }: { current: number; prev: number | null }) {
  if (!prev) return null;
  const diff = current - prev;
  if (Math.abs(diff) < 0.1) return <Minus className="w-4 h-4 text-white/50" />;
  if (diff < 0) return <TrendingDown className="w-4 h-4 text-emerald-400" />;
  return <TrendingUp className="w-4 h-4 text-red-400" />;
}

function DiffBar({ diff }: { diff: number }) {
  const clamped = Math.max(-10, Math.min(30, diff));
  const pct = ((clamped + 10) / 40) * 100;
  const color = diff < 0 ? '#34d399' : diff > 10 ? '#f87171' : diff > 5 ? '#fb923c' : GOLD;
  return (
    <div className="flex items-center gap-2 mt-1">
      <div className="flex-1 h-1.5 bg-white/10 rounded-full overflow-hidden">
        <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: color }} />
      </div>
      <span className="text-xs font-mono w-10 text-right" style={{ color }}>
        {diff >= 0 ? '+' : ''}{diff.toFixed(1)}
      </span>
    </div>
  );
}

export default function HandicapProfilePage() {
  const [, navigate] = useLocation();
  const { data: user } = useGetMe();
  const orgId = user?.organizationId;
  const { toast } = useToast();

  const [state, setState] = useState<WhsState | null>(null);
  const [records, setRecords] = useState<ScoreRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);
  const PER_PAGE = 20;

  interface MyCaseAuditEntry {
    id: number; action: string; fromStatus: string | null; toStatus: string | null;
    actorName: string | null; createdAt: string;
  }
  interface MyCase {
    id: number; kind: string; status: string; details: string | null;
    decision: string | null; decisionRationale: string | null;
    orgName: string | null; createdAt: string; updatedAt: string;
    auditLog?: MyCaseAuditEntry[];
  }
  const [myCases, setMyCases] = useState<MyCase[]>([]);
  const [expandedCaseId, setExpandedCaseId] = useState<number | null>(null);

  interface ExplainRow {
    id: number; playedAt: string; courseId: number | null;
    courseRating: string | null; slopeRating: number | null;
    grossScore: number | null; adjustedGrossScore: number | null;
    pccAdjustment: string | null; rawDifferential: string | null;
    esrAdjustment: string | null; finalDifferential: string | null;
    is9Hole: boolean; handicapIndexAfter: string | null;
    usedInIndex: boolean; exceptional: boolean;
  }
  interface ExplainResponse {
    currentIndex: string | null;
    rollingWindow: ExplainRow[];
    used: number; total: number; note: string;
  }
  const [explain, setExplain] = useState<ExplainResponse | null>(null);
  const [explainOpen, setExplainOpen] = useState(false);
  const [explainLoading, setExplainLoading] = useState(false);

  async function loadExplain() {
    if (explain) { setExplainOpen(o => !o); return; }
    setExplainLoading(true);
    try {
      const r = await fetch('/api/portal/handicap/explain', { credentials: 'include' });
      if (!r.ok) throw new Error('Failed to load explanation');
      const d = await r.json();
      setExplain(d);
      setExplainOpen(true);
    } catch (e) {
      toast({ title: 'Could not load handicap explanation', description: String((e as Error).message), variant: 'destructive' });
    } finally {
      setExplainLoading(false);
    }
  }

  useEffect(() => {
    fetch(`/api/portal/handicap/my-cases`, { credentials: 'include' })
      .then(r => r.ok ? r.json() : [])
      .then((data) => setMyCases(Array.isArray(data) ? data : []))
      .catch(() => {});
  }, [orgId]);

  const KIND_LABEL: Record<string, string> = {
    anomalous: 'Anomalous Score',
    not_posted: 'Score Not Posted',
    exceptional: 'Exceptional Score',
    annual: 'Annual Review',
  };
  const STATUS_LABEL: Record<string, string> = {
    open: 'Open', assigned: 'Assigned', awaiting_peer: 'Awaiting Peer', decided: 'Decided', closed: 'Closed',
  };

  useEffect(() => {
    if (!orgId) return;
    setLoading(true);
    Promise.all([
      fetch(`/api/portal/whs/state?organizationId=${orgId}`, { credentials: 'include' }),
      fetch(`/api/portal/whs/records?organizationId=${orgId}&limit=60`, { credentials: 'include' }),
    ]).then(async ([stateRes, recordsRes]) => {
      if (stateRes.ok) setState(await stateRes.json());
      if (recordsRes.ok) setRecords(await recordsRes.json());
    }).catch(() => toast({ title: 'Failed to load handicap data', variant: 'destructive' }))
      .finally(() => setLoading(false));
  }, [orgId]);

  const hi = state?.currentHandicapIndex ? Number(state.currentHandicapIndex) : null;
  const lowHi = state?.lowHandicapIndex ? Number(state.lowHandicapIndex) : null;
  const phase = state?.establishmentPhase ?? 1;

  const paginatedRecords = records.slice(page * PER_PAGE, (page + 1) * PER_PAGE);
  const totalPages = Math.ceil(records.length / PER_PAGE);

  const phaseLabel = phase === 3 ? 'Established (Phase 3)' : phase === 2 ? 'Establishing (Phase 2)' : 'Phase 1 (<3 rounds)';
  const phaseColor = phase === 3 ? 'text-emerald-400' : 'text-amber-400';

  return (
    <div className="min-h-screen bg-[#0a0f1a] text-white p-4 md:p-8">
      <div className="max-w-4xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={() => navigate('/portal')} aria-label="Back to portal">
            <ChevronLeft className="w-5 h-5" />
          </Button>
          <div>
            <h1 className="text-2xl font-bold text-white">Handicap Profile</h1>
            <p className="text-white/50 text-sm">WHS 2024 — {user?.displayName}</p>
          </div>
        </div>

        {loading ? (
          <div className="flex justify-center py-20">
            <RefreshCw className="w-8 h-8 text-white/30 animate-spin" />
          </div>
        ) : (
          <>
            {/* Main H.I. Card */}
            <Card className="bg-[#111827] border-[#1e2d3d] p-6">
              <div className="flex flex-col md:flex-row gap-6">
                <div className="flex-1">
                  <p className="text-white/70 text-sm mb-1">Handicap Index</p>
                  {hi !== null ? (
                    <div className="flex items-end gap-3">
                      <span className="text-6xl font-bold" style={{ color: GOLD }}>
                        {hi >= 0 ? hi.toFixed(1) : `+${Math.abs(hi).toFixed(1)}`}
                      </span>
                      {state?.isProvisional && (
                        <Badge className="mb-2 bg-amber-500/20 text-amber-300 border-amber-500/30 text-xs">
                          Provisional
                        </Badge>
                      )}
                    </div>
                  ) : (
                    <p className="text-3xl text-white/60 font-semibold mt-2">Not yet established</p>
                  )}
                  <p className={`text-sm mt-2 font-medium ${phaseColor}`}>{phaseLabel}</p>
                </div>

                <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                  <div className="bg-white/5 rounded-lg p-3">
                    <p className="text-white/70 text-xs mb-1">Low H.I.</p>
                    <p className="text-lg font-bold" style={{ color: GOLD }}>
                      {lowHi !== null ? lowHi.toFixed(1) : '—'}
                    </p>
                    {state?.lowHandicapIndexDate && (
                      <p className="text-white/60 text-xs mt-0.5">
                        {new Date(state.lowHandicapIndexDate).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' })}
                      </p>
                    )}
                  </div>
                  <div className="bg-white/5 rounded-lg p-3">
                    <p className="text-white/70 text-xs mb-1">Rounds Posted</p>
                    <p className="text-lg font-bold text-white">
                      {Math.floor((state?.totalHolesPosted ?? 0) / 18)}
                    </p>
                    <p className="text-white/60 text-xs mt-0.5">{state?.totalHolesPosted ?? 0} holes</p>
                  </div>
                  <div className="bg-white/5 rounded-lg p-3">
                    <p className="text-white/70 text-xs mb-1">Last Updated</p>
                    <p className="text-sm font-semibold text-white">
                      {state?.lastRecalcAt
                        ? new Date(state.lastRecalcAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
                        : '—'}
                    </p>
                  </div>
                </div>
              </div>

              {/* Why is my index this number? */}
              <div className="mt-4 pt-4 border-t border-white/10">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={loadExplain}
                  data-testid="button-explain-handicap"
                  className="text-xs text-white/70 hover:text-white"
                >
                  <HelpCircle className="w-3.5 h-3.5 mr-1.5" />
                  {explainLoading ? 'Loading…' : explainOpen ? 'Hide explanation' : 'Why is my index this number?'}
                </Button>
                {explainOpen && explain && (
                  <div className="mt-3 rounded-lg border border-white/10 bg-black/30 p-3 space-y-2" data-testid="explain-panel">
                    <p className="text-xs text-white/60">{explain.note}</p>
                    <p className="text-xs text-white/80">
                      Using <strong>{explain.used}</strong> of your last <strong>{explain.total}</strong> differentials
                      {explain.currentIndex != null && <> · current index <strong>{Number(explain.currentIndex).toFixed(1)}</strong></>}
                    </p>
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs">
                        <caption className="sr-only">Rolling differential window — last {explain.total} differentials, with {explain.used} used in the current handicap calculation.</caption>
                        <thead>
                          <tr className="text-white/40 border-b border-white/10">
                            <th scope="col" className="text-left py-1 pr-2">Date</th>
                            <th scope="col" className="text-right py-1 pr-2">AGS</th>
                            <th scope="col" className="text-right py-1 pr-2">Diff</th>
                            <th scope="col" className="text-right py-1 pr-2">PCC</th>
                            <th scope="col" className="text-right py-1 pr-2">ESR</th>
                            <th scope="col" className="text-center py-1">Used?</th>
                          </tr>
                        </thead>
                        <tbody>
                          {explain.rollingWindow.map(r => (
                            <tr key={r.id} className="border-b border-white/5">
                              <td className="py-1 pr-2 text-white/70">
                                {new Date(r.playedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: '2-digit' })}
                                {r.is9Hole && <span className="ml-1 text-amber-400/70">9H</span>}
                              </td>
                              <td className="py-1 pr-2 text-right text-white/70">{r.adjustedGrossScore ?? '—'}</td>
                              <td className="py-1 pr-2 text-right font-mono text-white">{r.finalDifferential != null ? Number(r.finalDifferential).toFixed(1) : '—'}</td>
                              <td className="py-1 pr-2 text-right text-white/60">{r.pccAdjustment && Number(r.pccAdjustment) !== 0 ? Number(r.pccAdjustment).toFixed(1) : '—'}</td>
                              <td className="py-1 pr-2 text-right">
                                {r.exceptional ? <span className="text-amber-300">-{Number(r.esrAdjustment ?? 0).toFixed(1)}</span> : <span className="text-white/40">—</span>}
                              </td>
                              <td className="py-1 text-center">
                                {r.usedInIndex ? (
                                  <Badge className="bg-emerald-500/20 text-emerald-300 border-emerald-500/30 text-[10px]" data-testid={`explain-used-${r.id}`}>used</Badge>
                                ) : (
                                  <span className="text-white/30">—</span>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>

              {/* Soft Cap / Hard Cap info */}
              {lowHi !== null && hi !== null && (
                <div className="mt-4 pt-4 border-t border-white/10 flex gap-6">
                  <div>
                    <p className="text-white/40 text-xs">Soft Cap threshold</p>
                    <p className="text-white text-sm font-medium">{(lowHi + 3.0).toFixed(1)}</p>
                  </div>
                  <div>
                    <p className="text-white/40 text-xs">Hard Cap limit</p>
                    <p className="text-white text-sm font-medium">{(lowHi + 5.0).toFixed(1)}</p>
                  </div>
                  {hi > lowHi + 3.0 && (
                    <div className="flex items-center gap-1.5 text-amber-400 text-xs">
                      <AlertTriangle className="w-3 h-3" />
                      Soft cap applied
                    </div>
                  )}
                </div>
              )}
            </Card>

            {/* Committee Review Cases */}
            {myCases.length > 0 && (
              <Card className="bg-[#111827] border-[#1e2d3d] p-4">
                <div className="flex items-center gap-2 mb-3">
                  <Gavel className="w-4 h-4 text-blue-400" />
                  <span className="text-sm font-medium text-white">Handicap Committee Cases</span>
                  <Badge className="bg-blue-500/20 text-blue-300 border-blue-500/30 text-xs">{myCases.length}</Badge>
                </div>
                <div className="space-y-2">
                  {myCases.slice(0, 5).map(c => (
                    <div key={c.id} className="p-2 bg-white/5 rounded-md text-sm">
                      <div className="flex items-center justify-between gap-2 flex-wrap">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-medium">{KIND_LABEL[c.kind] ?? c.kind}</span>
                          <Badge variant="outline" className="text-xs border-white/20 text-white/70">
                            {STATUS_LABEL[c.status] ?? c.status}
                          </Badge>
                          {c.orgName && <span className="text-white/50 text-xs">· {c.orgName}</span>}
                        </div>
                        <span className="text-white/40 text-xs">{new Date(c.updatedAt).toLocaleDateString()}</span>
                      </div>
                      {c.details && <p className="text-white/60 text-xs mt-1 line-clamp-2">{c.details}</p>}
                      {c.decision && (
                        <p className="text-emerald-400 text-xs mt-1">
                          Decision: <strong>{c.decision.replace(/_/g, ' ')}</strong>
                          {c.decisionRationale && <span className="text-white/60"> — {c.decisionRationale}</span>}
                        </p>
                      )}
                      {c.auditLog && c.auditLog.length > 0 && (
                        <>
                          <button
                            type="button"
                            className="text-xs text-blue-300 hover:underline mt-1"
                            onClick={() => setExpandedCaseId(expandedCaseId === c.id ? null : c.id)}
                          >
                            {expandedCaseId === c.id ? 'Hide' : 'Show'} action history ({c.auditLog.length})
                          </button>
                          {expandedCaseId === c.id && (
                            <ul className="mt-1 space-y-0.5 border-l border-white/10 pl-2">
                              {c.auditLog.map(a => (
                                <li key={a.id} className="text-[11px] text-white/60">
                                  <span className="text-white/40">{new Date(a.createdAt).toLocaleString()}</span>{' '}
                                  <strong className="text-white/80">{a.action}</strong>
                                  {a.fromStatus && a.toStatus && ` (${a.fromStatus} → ${a.toStatus})`}
                                  {a.actorName && ` · ${a.actorName}`}
                                </li>
                              ))}
                            </ul>
                          )}
                        </>
                      )}
                    </div>
                  ))}
                </div>
              </Card>
            )}

            {/* WHS Establishment progress */}
            {phase < 3 && (
              <Card className="bg-[#111827] border-[#1e2d3d] p-4">
                <div className="flex items-center gap-2 mb-3">
                  <Info className="w-4 h-4" style={{ color: GOLD }} />
                  <span className="text-sm font-medium text-white">Establishment Progress</span>
                </div>
                <div className="space-y-2">
                  {[
                    { label: '3 rounds (Phase 2 starts)', holes: 54 },
                    { label: '20 rounds (Phase 3 — full H.I.)', holes: 360 },
                  ].map(({ label, holes }) => {
                    const posted = state?.totalHolesPosted ?? 0;
                    const pct = Math.min(100, (posted / holes) * 100);
                    return (
                      <div key={holes}>
                        <div className="flex justify-between text-xs text-white/50 mb-1">
                          <span>{label}</span>
                          <span>{Math.floor(posted / 18)}/{holes / 18} rounds</span>
                        </div>
                        <div className="h-1.5 bg-white/10 rounded-full overflow-hidden">
                          <div
                            className="h-full rounded-full transition-all"
                            style={{ width: `${pct}%`, background: GOLD }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </Card>
            )}

            {/* Score History Table */}
            <Card className="bg-[#111827] border-[#1e2d3d] overflow-hidden">
              <div className="p-4 border-b border-white/10 flex items-center justify-between">
                <h2 className="font-semibold text-white flex items-center gap-2">
                  <BarChart2 className="w-4 h-4" style={{ color: GOLD }} />
                  Score History ({records.length} rounds)
                </h2>
                <div className="flex items-center gap-2">
                  <Button variant="ghost" size="icon" disabled={page === 0} onClick={() => setPage(p => p - 1)} aria-label="Previous page">
                    <ChevronLeft className="w-4 h-4" />
                  </Button>
                  <span className="text-xs text-white/60">{page + 1}/{Math.max(1, totalPages)}</span>
                  <Button variant="ghost" size="icon" disabled={page >= totalPages - 1} onClick={() => setPage(p => p + 1)} aria-label="Next page">
                    <ChevronRight className="w-4 h-4" />
                  </Button>
                </div>
              </div>

              {records.length === 0 ? (
                <div className="p-12 text-center text-white/60">
                  <Activity className="w-8 h-8 mx-auto mb-3 opacity-60" />
                  <p>No score records yet. Post your first round to start your handicap journey.</p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <caption className="sr-only">Score history — every posted round with the differential it produced and the resulting handicap index.</caption>
                    <thead>
                      <tr className="border-b border-white/10 text-white/40 text-xs">
                        <th scope="col" className="text-left p-3">Date</th>
                        <th scope="col" className="text-right p-3">Gross</th>
                        <th scope="col" className="text-right p-3">AGS</th>
                        <th scope="col" className="text-right p-3">Rating/Slope</th>
                        <th scope="col" className="text-right p-3">PCC</th>
                        <th scope="col" className="text-right p-3">ESR</th>
                        <th scope="col" className="text-right p-3">Differential</th>
                        <th scope="col" className="text-right p-3">H.I. After</th>
                        <th scope="col" className="text-center p-3">Source</th>
                      </tr>
                    </thead>
                    <tbody>
                      {paginatedRecords.map((rec, i) => {
                        const prevHI = i + 1 < paginatedRecords.length ? Number(paginatedRecords[i + 1].handicapIndexAfter ?? 0) : null;
                        const curHI = rec.handicapIndexAfter ? Number(rec.handicapIndexAfter) : null;
                        const diff = Number(rec.differential);
                        const esrApplied = rec.esrAdjustment != null && Number(rec.esrAdjustment) > 0;
                        const label = rec.source === 'tournament'
                          ? (rec.tournamentName ?? 'Tournament')
                          : (rec.courseName ?? (rec.is9Hole ? '9-Hole' : 'General Play'));
                        return (
                          <tr key={rec.id} className="border-b border-white/5 hover:bg-white/5 transition-colors">
                            <td className="p-3">
                              <div className="font-medium text-white">
                                {new Date(rec.playedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}
                              </div>
                              <div className="text-xs text-white/40 max-w-[140px] truncate">{label}</div>
                              {rec.is9Hole && <span className="text-xs text-amber-400/70">9-hole</span>}
                            </td>
                            <td className="p-3 text-right text-white/70">{rec.grossScore ?? '—'}</td>
                            <td className="p-3 text-right text-white">{rec.adjustedGrossScore}</td>
                            <td className="p-3 text-right text-white/60 font-mono text-xs">
                              {Number(rec.courseRating).toFixed(1)}/{rec.slopeRating}
                            </td>
                            <td className="p-3 text-right text-white/60 font-mono text-xs">
                              {rec.pccAdjustment && Number(rec.pccAdjustment) !== 0 ? Number(rec.pccAdjustment).toFixed(1) : '—'}
                            </td>
                            <td className="p-3 text-right">
                              {esrApplied ? (
                                <Badge className="bg-amber-500/20 text-amber-300 border-amber-500/30 text-xs">
                                  -{Number(rec.esrAdjustment).toFixed(1)}
                                </Badge>
                              ) : '—'}
                            </td>
                            <td className="p-3 text-right">
                              <span className={`font-mono font-bold ${diff < 0 ? 'text-emerald-400' : diff > 20 ? 'text-red-400' : diff > 10 ? 'text-amber-400' : ''}`}
                                style={diff >= 0 && diff <= 10 ? { color: GOLD } : {}}>
                                {diff.toFixed(1)}
                              </span>
                            </td>
                            <td className="p-3 text-right">
                              {curHI !== null ? (
                                <div className="flex items-center justify-end gap-1">
                                  <HiTrend current={curHI} prev={prevHI} />
                                  <span className="font-semibold text-white">{curHI.toFixed(1)}</span>
                                </div>
                              ) : '—'}
                            </td>
                            <td className="p-3 text-center">
                              <Badge className={`text-xs ${rec.source === 'tournament' ? 'bg-blue-500/20 text-blue-300 border-blue-500/30' : 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30'}`}>
                                {rec.source === 'tournament' ? 'Competition' : rec.is9Hole ? 'General 9' : 'General Play'}
                              </Badge>
                              {rec.isExceptional && (
                                <span className="ml-1 text-[10px] text-amber-400" title="Exceptional Score Reduction applied">ESR</span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          </>
        )}
      </div>
    </div>
  );
}
