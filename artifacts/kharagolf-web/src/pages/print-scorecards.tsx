import { useEffect, useState, useMemo } from 'react';
import { useParams } from 'wouter';
import { trackImpression } from '@/lib/trackSponsor';

interface HoleScore {
  hole: number; par: number; handicap: number | null; strokes: number | null;
  toPar: number | null; stablefordPoints: number | null; isVerified: boolean;
}
interface ScorecardEntry {
  playerId: number; playerName: string; flight: string | null; teeBox: string | null;
  handicapIndex: number; playingHandicap: number; checkedIn: boolean;
  grossScore: number | null; netScore: number | null; stablefordPoints: number | null;
  outScore: number; inScore: number; outPar: number; inPar: number;
  holeScores: HoleScore[];
}
interface SponsorEntry {
  id: number; name: string; logoUrl: string | null; tier: string | null;
  websiteUrl: string | null; displayOrder: number | null;
}
interface ScorecardData {
  tournamentName: string; format: string; courseName: string | null; coursePar: number;
  holeCount: number; scorecards: ScorecardEntry[];
  organizationName: string | null;
  organizationLogoUrl: string | null;
  organizationPrimaryColor: string | null;
  sponsors: SponsorEntry[];
}

function scoreClass(toPar: number | null) {
  if (toPar === null) return '';
  if (toPar <= -2) return 'score-eagle';
  if (toPar === -1) return 'score-birdie';
  if (toPar === 1) return 'score-bogey';
  if (toPar >= 2) return 'score-double';
  return '';
}

function formatScore(n: number | null) {
  if (n === null) return '-';
  if (n === 0) return 'E';
  return n > 0 ? `+${n}` : `${n}`;
}

const isStableford = (format: string) =>
  format.toLowerCase().includes('stableford');
const isNetFormat = (format: string) =>
  format.toLowerCase().includes('net') || format.toLowerCase().includes('stableford');

export default function PrintScorecards() {
  const params = useParams<{ orgId: string; tournamentId: string }>();
  const orgId = params.orgId;
  const tournamentId = params.tournamentId;
  const [data, setData] = useState<ScorecardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [flightFilter, setFlightFilter] = useState<string>('all');

  const baseUrl = (import.meta.env.BASE_URL ?? '/').replace(/\/$/, '');

  useEffect(() => {
    fetch(`${baseUrl}/api/organizations/${orgId}/tournaments/${tournamentId}/scorecards`, {
      credentials: 'include',
    })
      .then(r => { if (!r.ok) throw new Error('Failed to load scorecards'); return r.json(); })
      .then((d: ScorecardData) => {
        setData(d);
        setLoading(false);
        // Apply org primary color as CSS variable for white-label branding
        const orgPrimary = d.organizationPrimaryColor ?? "#22c55e";
        document.documentElement.style.setProperty("--org-primary", orgPrimary);
      })
      .catch(e => { setError(e.message); setLoading(false); });
  }, [orgId, tournamentId]);

  const flights = useMemo(() => {
    if (!data) return [];
    const s = new Set<string>();
    for (const sc of data.scorecards) {
      if (sc.flight) s.add(sc.flight);
    }
    return Array.from(s).sort();
  }, [data]);

  const displayed = useMemo(() => {
    if (!data) return [];
    if (flightFilter === 'all') return data.scorecards;
    return data.scorecards.filter(sc => sc.flight === flightFilter);
  }, [data, flightFilter]);

  if (loading) return (
    <div style={{ padding: 40, fontFamily: 'Arial, sans-serif', textAlign: 'center' }}>
      <p>Loading scorecards...</p>
    </div>
  );
  if (error || !data) return (
    <div style={{ padding: 40, fontFamily: 'Arial, sans-serif', textAlign: 'center', color: 'red' }}>
      <p>{error ?? 'Failed to load scorecards'}</p>
    </div>
  );

  const front9 = Array.from({ length: Math.min(9, data.holeCount) }, (_, i) => i + 1);
  const back9 = Array.from({ length: Math.max(0, data.holeCount - 9) }, (_, i) => i + 10);
  const showNet = isNetFormat(data.format);
  const showStableford = isStableford(data.format);

  return (
    <>
      <style>{`
        @page { size: A4 landscape; margin: 10mm; }
        body { font-family: Arial, Helvetica, sans-serif; font-size: 10px; color: #000; background: #fff; }
        .no-print { display: flex; gap: 12px; padding: 16px; background: #1a1a2e; align-items: center; flex-wrap: wrap; }
        .no-print button { padding: 8px 20px; border: none; border-radius: 6px; cursor: pointer; font-weight: bold; font-size: 14px; }
        .btn-print { background: var(--org-primary, #22c55e); color: #000; }
        .btn-close { background: #374151; color: #fff; }
        .flight-select { background: #374151; color: #fff; border: 1px solid #4b5563; border-radius: 6px; padding: 7px 12px; font-size: 13px; cursor: pointer; }
        @media print { .no-print { display: none !important; } }
        .scorecard { page-break-after: always; margin-bottom: 10mm; }
        .scorecard:last-child { page-break-after: auto; }
        .sc-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 4px; border-bottom: 2px solid var(--org-primary, #166534); padding-bottom: 3px; }
        .sc-title { font-size: 13px; font-weight: bold; color: var(--org-primary, #166534); }
        .sc-sub { font-size: 9px; color: #555; margin-top: 2px; }
        .sc-player { font-size: 11px; font-weight: bold; }
        .sc-meta { font-size: 9px; color: #444; margin-top: 1px; }
        table { width: 100%; border-collapse: collapse; margin-bottom: 3px; }
        th { background: #166534; color: #fff; padding: 2px 3px; text-align: center; font-size: 9px; font-weight: bold; border: 0.5px solid #0f4020; }
        td { padding: 2px 3px; text-align: center; font-size: 9px; border: 0.5px solid #ccc; }
        .hole-num { font-weight: bold; background: #f0fdf4; }
        .par-row { background: #f0fdf4; color: #166534; font-weight: bold; }
        .hcp-row { background: #fff; color: #888; }
        .score-cell { font-weight: bold; min-width: 18px; }
        .score-eagle { border: 2px solid #d97706; background: #fef3c7; border-radius: 50%; }
        .score-birdie { border: 1.5px solid #dc2626; background: #fee2e2; border-radius: 50%; }
        .score-bogey { border: 1px solid #2563eb; }
        .score-double { border: 2px solid #7c3aed; }
        .totals-row td { font-weight: bold; background: #f0fdf4; color: #166534; border-top: 1.5px solid #166534; }
        .net-row td { font-weight: bold; background: #eff6ff; color: #1d4ed8; border-top: 1px solid #93c5fd; }
        .stableford-row td { font-weight: bold; background: #fefce8; color: #854d0e; border-top: 1px solid #fde68a; }
        .legend { display: flex; gap: 12px; font-size: 8px; color: #555; margin-top: 2px; align-items: center; }
        .legend-item { display: flex; align-items: center; gap: 4px; }
        .legend-dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
        .sig-row { display: flex; gap: 24px; margin-top: 4px; font-size: 9px; }
        .sig-box { flex: 1; border-top: 1px solid #999; padding-top: 2px; color: #555; }
        .empty-score { color: #bbb; }
      `}</style>

      <div className="no-print">
        <button className="btn-print" onClick={() => window.print()}>🖨️ Print All Scorecards</button>
        <button className="btn-close" onClick={() => window.close()}>✕ Close</button>
        {flights.length > 0 && (
          <select
            className="flight-select"
            value={flightFilter}
            onChange={e => setFlightFilter(e.target.value)}
          >
            <option value="all">All Flights ({data.scorecards.length} players)</option>
            {flights.map(f => (
              <option key={f} value={f}>
                Flight {f} ({data.scorecards.filter(sc => sc.flight === f).length} players)
              </option>
            ))}
          </select>
        )}
        <span style={{ color: '#9ca3af', fontSize: 13, display: 'flex', alignItems: 'center', marginLeft: 8 }}>
          {displayed.length} player{displayed.length !== 1 ? 's' : ''} · {data.tournamentName}
        </span>
      </div>

      {displayed.map((sc) => (
        <div key={sc.playerId} className="scorecard">
          <div className="sc-header">
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <img
                src={data.organizationLogoUrl ?? '/logo.png'}
                alt={data.organizationName ?? 'KharaGolf'}
                style={{ height: 32, width: 'auto', objectFit: 'contain' }}
              />
              <div>
                <div className="sc-title">{data.tournamentName}</div>
                <div className="sc-sub">
                  {data.organizationName ? `${data.organizationName} · ` : ''}
                  {data.courseName ? `${data.courseName} · ` : ''}
                  {data.format.replace(/_/g, ' ')} · Par {data.coursePar}
                </div>
              </div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div className="sc-player">{sc.playerName}</div>
              <div className="sc-meta">
                HCP {sc.handicapIndex} (Playing HCP {sc.playingHandicap}) · {sc.teeBox ?? 'White'} Tees
                {sc.flight ? ` · Flight: ${sc.flight}` : ''}
                {sc.checkedIn ? ' · ✓ Checked In' : ''}
              </div>
            </div>
          </div>

          <table>
            <thead>
              <tr>
                <th style={{ textAlign: 'left', width: 40 }}>Hole</th>
                {front9.map(h => <th key={h}>{h}</th>)}
                <th>OUT</th>
                {back9.map(h => <th key={h}>{h}</th>)}
                {back9.length > 0 && <th>IN</th>}
                <th>TOT</th>
                <th>+/-</th>
              </tr>
            </thead>
            <tbody>
              <tr className="par-row">
                <td style={{ textAlign: 'left', fontWeight: 'bold' }}>Par</td>
                {front9.map(h => <td key={h}>{sc.holeScores.find(hs => hs.hole === h)?.par ?? '-'}</td>)}
                <td>{sc.outPar}</td>
                {back9.map(h => <td key={h}>{sc.holeScores.find(hs => hs.hole === h)?.par ?? '-'}</td>)}
                {back9.length > 0 && <td>{sc.inPar}</td>}
                <td>{sc.outPar + sc.inPar}</td>
                <td>—</td>
              </tr>
              <tr className="hcp-row">
                <td style={{ textAlign: 'left' }}>HCP</td>
                {front9.map(h => <td key={h}>{sc.holeScores.find(hs => hs.hole === h)?.handicap ?? ''}</td>)}
                <td>—</td>
                {back9.map(h => <td key={h}>{sc.holeScores.find(hs => hs.hole === h)?.handicap ?? ''}</td>)}
                {back9.length > 0 && <td>—</td>}
                <td>—</td>
                <td>—</td>
              </tr>
              <tr>
                <td style={{ textAlign: 'left', fontWeight: 'bold' }}>Gross</td>
                {front9.map(h => {
                  const hs = sc.holeScores.find(x => x.hole === h);
                  return (
                    <td key={h} className={`score-cell ${scoreClass(hs?.toPar ?? null)}`}>
                      {hs?.strokes ?? <span className="empty-score">·</span>}
                    </td>
                  );
                })}
                <td className="score-cell">{sc.outScore > 0 ? sc.outScore : '—'}</td>
                {back9.map(h => {
                  const hs = sc.holeScores.find(x => x.hole === h);
                  return (
                    <td key={h} className={`score-cell ${scoreClass(hs?.toPar ?? null)}`}>
                      {hs?.strokes ?? <span className="empty-score">·</span>}
                    </td>
                  );
                })}
                {back9.length > 0 && <td className="score-cell">{sc.inScore > 0 ? sc.inScore : '—'}</td>}
                <td className="score-cell">{sc.grossScore ?? '—'}</td>
                <td className="score-cell">
                  {sc.grossScore !== null ? formatScore(sc.grossScore - (sc.outPar + sc.inPar)) : '—'}
                </td>
              </tr>
              {showNet && (
                <tr className="net-row">
                  <td style={{ textAlign: 'left' }}>Net</td>
                  {front9.map(h => <td key={h}>—</td>)}
                  <td>—</td>
                  {back9.map(h => <td key={h}>—</td>)}
                  {back9.length > 0 && <td>—</td>}
                  <td>{sc.netScore ?? '—'}</td>
                  <td>
                    {sc.netScore !== null ? formatScore(sc.netScore - (sc.outPar + sc.inPar)) : '—'}
                  </td>
                </tr>
              )}
              {showStableford && (
                <tr className="stableford-row">
                  <td style={{ textAlign: 'left' }}>Stableford</td>
                  {front9.map(h => {
                    const pts = sc.holeScores.find(x => x.hole === h)?.stablefordPoints;
                    return <td key={h}>{pts ?? '—'}</td>;
                  })}
                  <td>{front9.reduce((a, h) => a + (sc.holeScores.find(x => x.hole === h)?.stablefordPoints ?? 0), 0) || '—'}</td>
                  {back9.map(h => {
                    const pts = sc.holeScores.find(x => x.hole === h)?.stablefordPoints;
                    return <td key={h}>{pts ?? '—'}</td>;
                  })}
                  {back9.length > 0 && (
                    <td>{back9.reduce((a, h) => a + (sc.holeScores.find(x => x.hole === h)?.stablefordPoints ?? 0), 0) || '—'}</td>
                  )}
                  <td>{sc.stablefordPoints ?? '—'}</td>
                  <td>—</td>
                </tr>
              )}
            </tbody>
          </table>

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end' }}>
            <div className="legend">
              <span>Score Legend:</span>
              <span className="legend-item"><span className="legend-dot" style={{ border: '2px solid #d97706', background: '#fef3c7' }}></span>Eagle or better</span>
              <span className="legend-item"><span className="legend-dot" style={{ border: '1.5px solid #dc2626', background: '#fee2e2' }}></span>Birdie</span>
              <span className="legend-item"><span style={{ border: '1px solid #2563eb', padding: '0 4px', fontSize: 8 }}>5</span>Bogey</span>
              <span className="legend-item"><span style={{ border: '2px solid #7c3aed', padding: '0 3px', fontSize: 8 }}>6</span>Double+</span>
            </div>
            <div className="sig-row">
              <div className="sig-box">Player signature: ________________________</div>
              <div className="sig-box">Marker signature: ________________________</div>
              <div className="sig-box">Date: ________________</div>
            </div>
          </div>

          {data.sponsors && data.sponsors.length > 0 && (() => {
            data.sponsors.forEach(s => trackImpression(s.id, 'scorecard'));
            return (
              <div style={{ marginTop: 8, paddingTop: 6, borderTop: '1px solid #e5e7eb', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 8, color: '#9ca3af', fontStyle: 'italic', whiteSpace: 'nowrap' }}>Presented by</span>
                {data.sponsors.map(s => (
                  s.logoUrl
                    ? <img key={s.id} src={s.logoUrl} alt={s.name} title={s.name} style={{ height: 20, width: 'auto', objectFit: 'contain' }} />
                    : <span key={s.id} style={{ fontSize: 9, fontWeight: 600, color: '#374151' }}>{s.name}</span>
                ))}
              </div>
            );
          })()}
        </div>
      ))}
    </>
  );
}
