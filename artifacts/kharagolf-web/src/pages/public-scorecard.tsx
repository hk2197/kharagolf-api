import React, { useEffect, useRef, useState } from 'react';
import { useRoute } from 'wouter';
import { Loader2, Trophy, FileDown, Target, Image as ImageIcon, CalendarPlus, Award, Share2, Copy, Check, QrCode } from 'lucide-react';
import { KharaGolfWordmark } from '@/components/kharagolf-brand';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { toPng } from 'html-to-image';
import QRCode from 'qrcode';
import AdSlot from '@/components/AdSlot';
import { ShotSourceBadges, type ShotSourceBreakdown } from '@/components/ShotSourceBadges';

interface HoleScore {
  holeNumber: number;
  par: number;
  strokes: number;
  toPar: number;
  putts: number | null;
  fairwayHit: boolean | null;
  girHit: boolean | null;
}

interface RoundData {
  round: number;
  gross: number;
  net: number | null;
  toPar: number;
  holes: HoleScore[];
  fairwayPct: number | null;
  girPct: number | null;
  totalPutts: number | null;
}

interface PrizeAwardItem {
  awardId: number;
  categoryName: string;
  description: string | null;
  prizeValue: number | null;
  currency: string;
  notes: string | null;
  awardedAt: string;
}

interface ScorecardData {
  player: { id: number; firstName: string; lastName: string; handicapIndex: number | null; teeBox: string };
  tournament: { id: number; name: string; format: string; startDate: string | null; rounds: number; organizationId: number };
  organization: { name: string; logoUrl: string | null; primaryColor: string | null };
  courseName: string | null;
  rounds: RoundData[];
  prizeAwards: PrizeAwardItem[];
}

function toParColor(toPar: number): string {
  if (toPar <= -2) return 'bg-amber-500/25 text-amber-300 border border-amber-500/40';
  if (toPar === -1) return 'bg-red-700/30 text-red-300 border border-red-600/40';
  if (toPar === 0) return 'bg-white/8 text-white border border-white/10';
  if (toPar === 1) return 'bg-blue-700/30 text-blue-300 border border-blue-600/40';
  return 'bg-purple-800/30 text-purple-300 border border-purple-600/40';
}

export default function PublicScorecardPage() {
  const [, params] = useRoute('/scorecard/:shareToken');
  const shareToken = params?.shareToken;

  const [data, setData] = useState<ScorecardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // Task #1017 — same Watch/Phone/Scorer/Manual % badges shown in the player's
  // tournament round detail, fetched per round via the public source-breakdown endpoint.
  const [sourceBreakdowns, setSourceBreakdowns] = useState<Record<number, ShotSourceBreakdown>>({});
  const [downloadingCard, setDownloadingCard] = useState(false);
  const [downloadError, setDownloadError] = useState('');
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!shareToken) return;
    fetch(`/api/public/scorecard/${shareToken}`)
      .then(r => {
        if (!r.ok) throw new Error('Scorecard not found or link has expired.');
        return r.json();
      })
      .then((d: ScorecardData) => {
        setData(d);
        // Task #1017 — fetch shot source breakdown per round in parallel.
        Promise.all(d.rounds.map(async r => {
          try {
            const res = await fetch(`/api/public/scorecard/${shareToken}/source-breakdown/${r.round}`);
            if (!res.ok) return null;
            const b: ShotSourceBreakdown = await res.json();
            return [r.round, b] as const;
          } catch { return null; }
        })).then(results => {
          const next: Record<number, ShotSourceBreakdown> = {};
          for (const entry of results) if (entry) next[entry[0]] = entry[1];
          setSourceBreakdowns(next);
        });
      })
      .catch(e => setError(e.message ?? 'Failed to load scorecard'))
      .finally(() => setLoading(false));
  }, [shareToken]);

  const handleDownloadCard = async () => {
    if (!cardRef.current || !data) return;
    setDownloadingCard(true);
    setDownloadError('');
    try {
      const dataUrl = await toPng(cardRef.current, { pixelRatio: 2, cacheBust: true });
      const link = document.createElement('a');
      link.download = `${data.player.firstName}-${data.player.lastName}-${data.tournament.name.replace(/\s+/g, '-')}.png`;
      link.href = dataUrl;
      link.click();
    } catch {
      setDownloadError('Failed to generate card. Please try again.');
    } finally {
      setDownloadingCard(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center gap-4">
        <Target className="w-12 h-12 text-muted-foreground opacity-30" />
        <p className="text-muted-foreground">{error || 'Scorecard not found.'}</p>
        <p className="text-xs text-muted-foreground">This link may have expired or been removed.</p>
      </div>
    );
  }

  const formattedDate = data.tournament.startDate
    ? new Date(data.tournament.startDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
    : null;

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-white/10 bg-black/60 backdrop-blur-sm sticky top-0 z-50">
        <div className="max-w-4xl mx-auto px-4 h-14 flex items-center gap-3">
          <img src="/logo.png" alt="KharaGolf" className="h-8 w-8 object-contain" />
          <KharaGolfWordmark className="text-lg" />
          {data.organization.name && (
            <Badge className="bg-white/5 text-muted-foreground border-white/10 border text-[10px] tracking-wider">
              {data.organization.name}
            </Badge>
          )}
          <div className="ml-auto flex items-center gap-2">
            {data && (
              <a
                href={`/api/public/tournaments/${data.tournament.id}/calendar.ics`}
                download
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs border border-emerald-500/40 hover:border-emerald-400/70 text-emerald-400/80 hover:text-emerald-300 transition-colors"
              >
                <CalendarPlus className="w-3.5 h-3.5" /> Calendar
              </a>
            )}
            <div className="flex flex-col items-end gap-0.5">
              <button
                onClick={handleDownloadCard}
                disabled={downloadingCard || !data}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs border border-amber-500/40 hover:border-amber-400/70 text-amber-400/80 hover:text-amber-300 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {downloadingCard ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <ImageIcon className="w-3.5 h-3.5" />
                )}
                Card
              </button>
              {downloadError && (
                <span className="text-[10px] text-red-400">{downloadError}</span>
              )}
            </div>
            <a
              href={`/api/public/scorecard/${shareToken}/pdf`}
              download
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs border border-white/20 hover:border-primary/50 text-muted-foreground hover:text-white transition-colors"
            >
              <FileDown className="w-3.5 h-3.5" /> PDF
            </a>
          </div>
        </div>
      </header>

      <ShareScorecardSection
        shareToken={shareToken!}
        playerName={`${data.player.firstName} ${data.player.lastName}`}
        tournamentName={data.tournament.name}
      />

      <div className="max-w-4xl mx-auto px-4 py-8 space-y-6">
        <div>
          <h1 className="text-2xl font-display font-bold text-white">{data.tournament.name}</h1>
          <p className="text-muted-foreground text-sm mt-1">
            {data.player.firstName} {data.player.lastName}
            {data.player.handicapIndex != null && ` · HCP ${data.player.handicapIndex}`}
            {data.player.teeBox && ` · ${data.player.teeBox} tees`}
            {formattedDate && ` · ${formattedDate}`}
            {data.courseName && ` · ${data.courseName}`}
          </p>
        </div>

        {data.rounds.length === 0 ? (
          <Card className="glass-panel border-white/10 p-12 text-center">
            <Trophy className="w-10 h-10 text-muted-foreground opacity-30 mx-auto mb-3" />
            <p className="text-muted-foreground">No scores recorded yet.</p>
          </Card>
        ) : (
          <div className="space-y-6">
            {data.rounds.map(round => (
              <Card key={round.round} className="glass-panel border-white/10 overflow-hidden">
                <div className="p-4 border-b border-white/5 flex items-center justify-between gap-3 flex-wrap">
                  <div className="flex items-center gap-3 flex-wrap">
                    <h2 className="font-semibold text-white">Round {round.round}</h2>
                    <ShotSourceBadges breakdown={sourceBreakdowns[round.round] ?? null} className="" />
                  </div>
                  <div className="flex items-center gap-3">
                    {round.fairwayPct != null && (
                      <span className="text-xs text-muted-foreground">FW {round.fairwayPct}%</span>
                    )}
                    {round.girPct != null && (
                      <span className="text-xs text-muted-foreground">GIR {round.girPct}%</span>
                    )}
                    {round.totalPutts != null && (
                      <span className="text-xs text-muted-foreground">{round.totalPutts} putts</span>
                    )}
                    <Badge className={`text-sm font-bold px-3 border ${round.toPar < 0 ? 'bg-red-700/20 text-red-300 border-red-600/30' : round.toPar === 0 ? 'bg-white/5 text-white border-white/20' : 'bg-blue-700/20 text-blue-300 border-blue-600/30'}`}>
                      {round.gross} ({round.toPar >= 0 ? '+' : ''}{round.toPar})
                    </Badge>
                  </div>
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-white/5 bg-black/20">
                        <th className="text-left px-4 py-2 text-xs text-muted-foreground font-semibold uppercase tracking-wider w-16">Hole</th>
                        <th className="text-center px-2 py-2 text-xs text-muted-foreground font-semibold uppercase tracking-wider w-12">Par</th>
                        <th className="text-center px-2 py-2 text-xs text-muted-foreground font-semibold uppercase tracking-wider w-16">Score</th>
                        <th className="text-center px-2 py-2 text-xs text-muted-foreground font-semibold uppercase tracking-wider w-16">±Par</th>
                        {round.holes.some(h => h.putts != null) && (
                          <th className="text-center px-2 py-2 text-xs text-muted-foreground font-semibold uppercase tracking-wider">Putts</th>
                        )}
                        {round.holes.some(h => h.fairwayHit != null) && (
                          <th className="text-center px-2 py-2 text-xs text-muted-foreground font-semibold uppercase tracking-wider">FW</th>
                        )}
                        {round.holes.some(h => h.girHit != null) && (
                          <th className="text-center px-2 py-2 text-xs text-muted-foreground font-semibold uppercase tracking-wider">GIR</th>
                        )}
                      </tr>
                    </thead>
                    <tbody>
                      {round.holes.sort((a, b) => a.holeNumber - b.holeNumber).map(h => (
                        <tr key={h.holeNumber} className="border-b border-white/[0.03] hover:bg-white/[0.02]">
                          <td className="px-4 py-2.5 font-medium text-white">
                            <span className="w-7 h-7 rounded-full bg-white/5 inline-flex items-center justify-center text-xs font-bold">
                              {h.holeNumber}
                            </span>
                          </td>
                          <td className="px-2 py-2.5 text-center text-muted-foreground">{h.par}</td>
                          <td className="px-2 py-2.5 text-center">
                            <span className={`inline-flex items-center justify-center w-8 h-8 rounded-full text-sm font-bold ${toParColor(h.toPar)}`}>
                              {h.strokes}
                            </span>
                          </td>
                          <td className="px-2 py-2.5 text-center">
                            <span className={`text-xs font-semibold ${h.toPar <= -2 ? 'text-amber-400' : h.toPar === -1 ? 'text-red-400' : h.toPar === 0 ? 'text-white/50' : h.toPar === 1 ? 'text-blue-400' : 'text-purple-400'}`}>
                              {h.toPar === 0 ? 'E' : h.toPar > 0 ? `+${h.toPar}` : `${h.toPar}`}
                            </span>
                          </td>
                          {round.holes.some(hh => hh.putts != null) && (
                            <td className="px-2 py-2.5 text-center text-muted-foreground">{h.putts ?? '—'}</td>
                          )}
                          {round.holes.some(hh => hh.fairwayHit != null) && (
                            <td className="px-2 py-2.5 text-center">
                              {h.fairwayHit == null ? <span className="text-muted-foreground">—</span> :
                                h.fairwayHit ? <span className="text-green-400">✓</span> : <span className="text-red-400">✗</span>}
                            </td>
                          )}
                          {round.holes.some(hh => hh.girHit != null) && (
                            <td className="px-2 py-2.5 text-center">
                              {h.girHit == null ? <span className="text-muted-foreground">—</span> :
                                h.girHit ? <span className="text-green-400">✓</span> : <span className="text-red-400">✗</span>}
                            </td>
                          )}
                        </tr>
                      ))}
                      <tr className="bg-white/[0.03] font-bold">
                        <td className="px-4 py-3 text-white text-sm uppercase tracking-wider">Total</td>
                        <td className="px-2 py-3 text-center text-muted-foreground text-sm">
                          {round.holes.reduce((a, h) => a + h.par, 0)}
                        </td>
                        <td className="px-2 py-3 text-center">
                          <span className="text-primary text-base font-bold">{round.gross}</span>
                        </td>
                        <td className="px-2 py-3 text-center">
                          <span className={`text-sm font-bold ${round.toPar < 0 ? 'text-red-400' : round.toPar === 0 ? 'text-white/60' : 'text-blue-400'}`}>
                            {round.toPar === 0 ? 'E' : round.toPar > 0 ? `+${round.toPar}` : `${round.toPar}`}
                          </span>
                        </td>
                        {round.holes.some(h => h.putts != null) && (
                          <td className="px-2 py-3 text-center text-muted-foreground">{round.totalPutts ?? '—'}</td>
                        )}
                        {round.holes.some(h => h.fairwayHit != null) && <td />}
                        {round.holes.some(h => h.girHit != null) && <td />}
                      </tr>
                    </tbody>
                  </table>
                </div>
              </Card>
            ))}
          </div>
        )}

        {data.prizeAwards && data.prizeAwards.length > 0 && (
          <Card className="glass-panel border-[#C9A84C]/30 overflow-hidden">
            <div className="p-4 border-b border-[#C9A84C]/20 flex items-center gap-2" style={{ background: 'rgba(201,168,76,0.07)' }}>
              <Trophy className="w-4 h-4 text-[#C9A84C]" />
              <h2 className="font-semibold text-[#C9A84C]">Prize Awards</h2>
              <Badge className="bg-[#C9A84C]/10 text-[#C9A84C] border border-[#C9A84C]/30 text-xs">{data.prizeAwards.length}</Badge>
            </div>
            <div className="divide-y divide-white/[0.04]">
              {data.prizeAwards.map(award => {
                const currencySymbol: Record<string, string> = { INR: '₹', USD: '$', GBP: '£', EUR: '€', AED: 'د.إ' };
                const sym = currencySymbol[award.currency] ?? award.currency;
                return (
                  <div key={award.awardId} className="flex items-center justify-between px-4 py-3 hover:bg-white/[0.02] transition-colors">
                    <div className="flex items-center gap-3">
                      <Award className="w-4 h-4 text-[#C9A84C] flex-shrink-0" />
                      <div>
                        <p className="text-white font-semibold text-sm">{award.categoryName}</p>
                        {award.description && <p className="text-muted-foreground text-xs mt-0.5">{award.description}</p>}
                        {award.notes && <p className="text-muted-foreground text-xs mt-0.5 italic">{award.notes}</p>}
                      </div>
                    </div>
                    {award.prizeValue != null && (
                      <span className="text-[#C9A84C] font-bold text-base tabular-nums ml-4 flex-shrink-0">
                        {sym}{award.prizeValue.toLocaleString()}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </Card>
        )}

        <div className="text-center pt-4">
          <p className="text-xs text-muted-foreground/50">
            Powered by KHARA<span style={{ color: '#C9A84C' }}>GOLF</span>{' '}
            <span style={{ color: '#C9A84C' }}>Elysium</span><span style={{ color: '#ffffff' }}>OS</span>
            {' '}· {data.organization.name}
          </p>
        </div>
      </div>

      {/* Off-screen card element for image capture — ref lives here, not on the child */}
      <div ref={cardRef} style={{ position: 'fixed', left: '-9999px', top: '-9999px', zIndex: -1 }}>
        <ScorecardShareCard data={data} sourceBreakdowns={sourceBreakdowns} />
      </div>
    </div>
  );
}

interface ScorecardShareCardProps {
  data: ScorecardData;
  // Task #1181 — same Watch/Phone/Scorer/Manual breakdown shown on the page
  // is rendered in the downloadable card image so the data-quality signal
  // survives sharing/printing.
  sourceBreakdowns?: Record<number, ShotSourceBreakdown>;
}

const ScorecardShareCard = ({ data, sourceBreakdowns }: ScorecardShareCardProps) => {
  const round = data.rounds.length > 0 ? data.rounds[data.rounds.length - 1] : null;
  const breakdown = round ? sourceBreakdowns?.[round.round] ?? null : null;
  const eagles = round ? round.holes.filter(h => h.toPar <= -2).length : 0;
  const birdies = round ? round.holes.filter(h => h.toPar === -1).length : 0;
  const pars = round ? round.holes.filter(h => h.toPar === 0).length : 0;
  const bogeys = round ? round.holes.filter(h => h.toPar === 1).length : 0;
  const doubles = round ? round.holes.filter(h => h.toPar >= 2).length : 0;
  const toParStr = !round ? '—' : round.toPar === 0 ? 'E' : round.toPar > 0 ? `+${round.toPar}` : `${round.toPar}`;
  const toParClr = !round ? '#9CA3AF' : round.toPar < 0 ? '#EF4444' : round.toPar > 0 ? '#3B82F6' : '#9CA3AF';
  const GOLD = '#C9A84C';
  const rawColor = data.organization.primaryColor ?? GOLD;
  const accent = /^#[0-9A-Fa-f]{6}$/.test(rawColor) ? rawColor : GOLD;
  const holesPlayed = round ? round.holes.length : 0;
  const formattedDate = data.tournament.startDate
    ? new Date(data.tournament.startDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
    : null;

  const holeResults = round ? [...round.holes].sort((a, b) => a.holeNumber - b.holeNumber) : [];
  const mid = Math.ceil(holeResults.length / 2);
  const row1 = holeResults.slice(0, mid);
  const row2 = holeResults.slice(mid);

  function holeDotStyle(toPar: number): { border: string; bg: string; color: string } {
    if (toPar <= -2) return { border: '#F5C842', bg: 'rgba(245,200,66,0.15)', color: '#F5C842' };
    if (toPar === -1) return { border: '#EF4444', bg: 'rgba(239,68,68,0.15)', color: '#EF4444' };
    if (toPar === 0) return { border: '#374151', bg: 'transparent', color: '#6B7280' };
    if (toPar === 1) return { border: '#3B82F6', bg: 'rgba(59,130,246,0.15)', color: '#3B82F6' };
    return { border: '#A855F7', bg: 'rgba(168,85,247,0.15)', color: '#A855F7' };
  }

  return (
    <div style={{ width: 420, background: '#0D1117', borderRadius: 16, overflow: 'hidden', fontFamily: 'system-ui, -apple-system, sans-serif' }}>
      {/* Accent bar */}
      <div style={{ height: 4, background: accent }} />

      {/* Header */}
      <div style={{ background: `rgba(${parseInt(accent.slice(1,3),16)},${parseInt(accent.slice(3,5),16)},${parseInt(accent.slice(5,7),16)},0.08)`, padding: '14px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ color: accent, fontSize: 20 }}>🏆</span>
          <span style={{ color: accent, fontWeight: 700, fontSize: 13, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Round Complete</span>
        </div>
        <div style={{ textAlign: 'right' }}>
          {data.organization.name && (
            <div style={{ color: '#6B7280', fontSize: 10, marginBottom: 3 }}>{data.organization.name}</div>
          )}
          {round && (
            <div style={{ display: 'flex', gap: 4 }}>
              <div style={{ background: 'rgba(255,255,255,0.06)', color: '#6B7280', fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 10 }}>
                Round {round.round}
              </div>
              {holesPlayed > 0 && (
                <div style={{ background: 'rgba(255,255,255,0.06)', color: '#6B7280', fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 10 }}>
                  {holesPlayed} Holes
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Tournament + Player */}
      <div style={{ padding: '12px 20px 4px' }}>
        <div style={{ color: '#F0F4F8', fontWeight: 800, fontSize: 20, letterSpacing: '-0.02em' }}>{data.tournament.name}</div>
        <div style={{ color: '#8B949E', fontSize: 14, marginTop: 4 }}>
          {data.player.firstName} {data.player.lastName}
          {data.player.handicapIndex != null ? ` · HCP ${data.player.handicapIndex}` : ''}
          {formattedDate ? ` · ${formattedDate}` : ''}
        </div>
      </div>

      {/* Score Hero */}
      {round && (
        <div style={{ margin: '16px 20px', background: '#161B22', borderRadius: 12, padding: '20px 16px', display: 'flex', alignItems: 'center', border: '1px solid rgba(255,255,255,0.06)' }}>
          <div style={{ flex: 1, textAlign: 'center' }}>
            <div style={{ color: '#F0F4F8', fontWeight: 900, fontSize: 52, lineHeight: 1.1 }}>{round.gross}</div>
            <div style={{ color: '#6B7280', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.1em', marginTop: 2 }}>Strokes</div>
          </div>
          <div style={{ width: 1, height: 50, background: 'rgba(255,255,255,0.08)', margin: '0 12px' }} />
          <div style={{ flex: 1, textAlign: 'center' }}>
            <div style={{ color: toParClr, fontWeight: 900, fontSize: 42, lineHeight: 1.1 }}>{toParStr}</div>
            <div style={{ color: '#6B7280', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.1em', marginTop: 2 }}>To Par</div>
          </div>
          {round.net != null && (
            <>
              <div style={{ width: 1, height: 50, background: 'rgba(255,255,255,0.08)', margin: '0 12px' }} />
              <div style={{ flex: 1, textAlign: 'center' }}>
                <div style={{ color: accent, fontWeight: 800, fontSize: 36, lineHeight: 1.1 }}>{round.net}</div>
                <div style={{ color: '#6B7280', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.1em', marginTop: 2 }}>Net</div>
              </div>
            </>
          )}
        </div>
      )}

      {/* Stats Row */}
      {round && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: '0 20px 16px' }}>
          {eagles > 0 && <StatPill count={eagles} label={`Eagle${eagles !== 1 ? 's' : ''}`} color="#F5C842" />}
          {birdies > 0 && <StatPill count={birdies} label={`Birdie${birdies !== 1 ? 's' : ''}`} color="#EF4444" />}
          <StatPill count={pars} label={`Par${pars !== 1 ? 's' : ''}`} color="#6B7280" />
          {bogeys > 0 && <StatPill count={bogeys} label={`Bogey${bogeys !== 1 ? 's' : ''}`} color="#3B82F6" />}
          {doubles > 0 && <StatPill count={doubles} label="Dbl+" color="#A855F7" />}
        </div>
      )}

      {/* Task #1181 — tracking source breakdown (Watch/Phone/Scorer/Manual %) */}
      {round && breakdown && breakdown.total > 0 && (
        <div style={{ padding: '0 20px 16px' }}>
          <div style={{ color: '#6B7280', fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.12em', fontWeight: 600, marginBottom: 6 }}>Tracking Source</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {(['watch','phone','scorer','manual'] as const).map(src => {
              const n = breakdown.counts[src];
              if (n === 0) return null;
              const pct = Math.round((n / breakdown.total) * 100);
              const palette: Record<typeof src, { label: string; color: string; bg: string; border: string }> = {
                watch:  { label: 'Watch',  color: '#7DD3FC', bg: 'rgba(14,165,233,0.18)',  border: 'rgba(14,165,233,0.35)' },
                phone:  { label: 'Phone',  color: '#D8B4FE', bg: 'rgba(168,85,247,0.18)',  border: 'rgba(168,85,247,0.35)' },
                scorer: { label: 'Scorer', color: '#FCD34D', bg: 'rgba(245,158,11,0.18)',  border: 'rgba(245,158,11,0.35)' },
                manual: { label: 'Manual', color: '#D1D5DB', bg: 'rgba(107,114,128,0.22)', border: 'rgba(107,114,128,0.40)' },
              };
              const p = palette[src];
              return (
                <div key={src} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: p.bg, border: `1px solid ${p.border}`, borderRadius: 10, padding: '3px 8px' }}>
                  <span style={{ color: p.color, fontSize: 10, fontWeight: 700, letterSpacing: '0.02em' }}>{p.label}</span>
                  <span style={{ color: p.color, fontSize: 10, fontWeight: 700, opacity: 0.85 }}>{pct}%</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Hole grid */}
      {holeResults.length > 0 && (
        <div style={{ margin: '0 20px 16px', background: '#161B22', borderRadius: 10, padding: '12px 10px', border: '1px solid rgba(255,255,255,0.06)' }}>
          <div style={{ color: '#6B7280', fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.12em', fontWeight: 600, marginBottom: 10, marginLeft: 4 }}>Hole by Hole</div>
          <HoleRow holes={row1} holeDotStyle={holeDotStyle} />
          {row2.length > 0 && <HoleRow holes={row2} holeDotStyle={holeDotStyle} />}
        </div>
      )}

      {/* Sponsor ad — scorecard_footer slot */}
      {data.tournament.organizationId != null && (
        <div style={{ margin: '0 20px 12px' }}>
          <AdSlot
            orgId={data.tournament.organizationId}
            slotKey="scorecard_footer"
            tournamentId={data.tournament.id}
            style={{ width: '100%', aspectRatio: '6 / 1', borderRadius: 10, overflow: 'hidden', background: '#161B22', border: '1px solid rgba(255,255,255,0.06)' }}
          />
        </div>
      )}

      {/* Footer */}
      <div style={{ borderTop: `1px solid ${accent}40`, margin: '0 20px', paddingTop: 12, paddingBottom: 16, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ fontWeight: 800, fontSize: 13, letterSpacing: '0.03em' }}>
          <span style={{ color: '#F0F4F8' }}>KHARA</span>
          <span style={{ color: accent }}>GOLF</span>
          <span style={{ color: '#C9A84C', fontWeight: 600, fontSize: 11 }}> Elysium</span><span style={{ color: '#ffffff', fontWeight: 600, fontSize: 11 }}>OS</span>
        </div>
        <div style={{ color: '#4B5563', fontSize: 10, letterSpacing: '0.05em', fontStyle: 'italic' }}>Track. Compete. Excel.</div>
      </div>
    </div>
  );
};

function StatPill({ count, label, color }: { count: number; label: string; color: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 5, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 20, padding: '5px 10px' }}>
      <div style={{ width: 7, height: 7, borderRadius: '50%', background: color }} />
      <span style={{ color, fontSize: 12, fontWeight: 600 }}>{count} {label}</span>
    </div>
  );
}

function HoleRow({ holes, holeDotStyle }: { holes: HoleScore[]; holeDotStyle: (toPar: number) => { border: string; bg: string; color: string } }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-around', marginBottom: 8 }}>
      {holes.map(h => {
        const s = holeDotStyle(h.toPar);
        return (
          <div key={h.holeNumber} style={{ textAlign: 'center', width: 30 }}>
            <div style={{ width: 24, height: 24, borderRadius: '50%', border: `1.5px solid ${s.border}`, background: s.bg, display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto' }}>
              <span style={{ color: s.color, fontSize: 10, fontWeight: 700 }}>{h.strokes}</span>
            </div>
            <div style={{ color: '#6B7280', fontSize: 8, marginTop: 2, fontWeight: 500 }}>{h.holeNumber}</div>
          </div>
        );
      })}
    </div>
  );
}

interface ShareScorecardSectionProps {
  shareToken: string;
  playerName: string;
  tournamentName: string;
}

function ShareScorecardSection({ shareToken, playerName, tournamentName }: ShareScorecardSectionProps) {
  const [copied, setCopied] = useState(false);
  const [shareError, setShareError] = useState<string | null>(null);
  const [showQr, setShowQr] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const scorecardUrl = typeof window !== 'undefined'
    ? `${window.location.origin}/scorecard/${shareToken}`
    : `/scorecard/${shareToken}`;
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';

  useEffect(() => {
    setQrDataUrl(null);
    setShowQr(false);
    setCopied(false);
    setShareError(null);
  }, [shareToken]);

  useEffect(() => {
    if (!showQr || qrDataUrl) return;
    QRCode.toDataURL(scorecardUrl, { margin: 1, width: 220, color: { dark: '#0D1117', light: '#ffffff' } })
      .then(setQrDataUrl)
      .catch(() => setShareError('Could not generate QR code.'));
  }, [showQr, qrDataUrl, scorecardUrl]);

  async function copy() {
    setShareError(null);
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(scorecardUrl);
      } else {
        const ta = document.createElement('textarea');
        ta.value = scorecardUrl;
        ta.setAttribute('readonly', '');
        ta.style.position = 'absolute';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setShareError('Could not copy link.');
    }
  }

  async function nativeShare() {
    setShareError(null);
    try {
      await navigator.share({
        title: `${playerName} — ${tournamentName}`,
        text: `Check out ${playerName}'s scorecard from ${tournamentName} on KHARAGOLF.`,
        url: scorecardUrl,
      });
    } catch (err) {
      if ((err as DOMException)?.name !== 'AbortError') {
        setShareError('Share was cancelled or failed.');
      }
    }
  }

  return (
    <section className="border-b border-white/10 bg-black/40" data-testid="share-scorecard-section">
      <div className="max-w-4xl mx-auto px-4 py-3 flex flex-wrap items-center gap-3 justify-between">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Share2 className="w-4 h-4 text-emerald-400" />
          <span>Share this scorecard</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={copy}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs border border-white/20 hover:border-emerald-400/70 text-white/80 hover:text-emerald-300 transition-colors"
            data-testid="share-copy"
          >
            {copied ? <><Check className="w-3.5 h-3.5" />Copied!</> : <><Copy className="w-3.5 h-3.5" />Copy link</>}
          </button>
          {canShare && (
            <button
              type="button"
              onClick={nativeShare}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs border border-emerald-500/40 hover:border-emerald-400/70 text-emerald-400/80 hover:text-emerald-300 transition-colors"
              data-testid="share-native"
            >
              <Share2 className="w-3.5 h-3.5" />Share…
            </button>
          )}
          <button
            type="button"
            onClick={() => setShowQr(v => !v)}
            aria-expanded={showQr}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs border border-white/20 hover:border-primary/50 text-muted-foreground hover:text-white transition-colors"
            data-testid="share-qr-toggle"
          >
            <QrCode className="w-3.5 h-3.5" />{showQr ? 'Hide QR' : 'QR code'}
          </button>
        </div>
      </div>
      {showQr && (
        <div className="max-w-4xl mx-auto px-4 pb-4 flex flex-col items-center sm:items-start gap-2" data-testid="share-qr-panel">
          {qrDataUrl ? (
            <img src={qrDataUrl} alt={`QR code for ${scorecardUrl}`} className="w-40 h-40 border border-white/10 rounded-md bg-white p-1" data-testid="share-qr-image" />
          ) : (
            <div className="w-40 h-40 border border-white/10 rounded-md flex items-center justify-center text-muted-foreground">
              <Loader2 className="w-5 h-5 animate-spin" />
            </div>
          )}
          <div className="text-xs text-muted-foreground break-all">{scorecardUrl}</div>
        </div>
      )}
      {shareError && (
        <div className="max-w-4xl mx-auto px-4 pb-3 text-xs text-red-400" data-testid="share-error">{shareError}</div>
      )}
    </section>
  );
}
