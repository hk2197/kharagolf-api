import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ChevronLeft, ChevronRight, Map } from 'lucide-react';

import { motion, AnimatePresence } from 'framer-motion';

const BASE_URL = (import.meta.env.BASE_URL ?? '/').replace(/\/$/, '');

type Shot = {
  id: number;
  holeNumber: number;
  shotNumber: number;
  shotType: string | null;
  distanceToPin: number | null;
  distanceCarried: number | null;
  club: string | null;
  lie: string | null;
  outcome: string | null;
  latitude: string | null;
  longitude: string | null;
};

type HoleGroup = { hole: number; shots: Shot[] };

const SHOT_TYPE_COLOR: Record<string, string> = {
  tee: '#C9A84C',
  approach: '#3B82F6',
  chip: '#10B981',
  putt: '#A855F7',
  penalty: '#EF4444',
  other: '#6B7280',
};

function getShotColor(type: string | null): string {
  return SHOT_TYPE_COLOR[type ?? 'other'] ?? '#6B7280';
}

function normalize(val: number, min: number, max: number, out: number): number {
  if (max === min) return out / 2;
  return ((val - min) / (max - min)) * out;
}

function SVGHoleDiagram({ shots, hole, par }: { shots: Shot[]; hole: number; par?: number }) {
  const W = 300, H = 400;
  const PADDING = 32;

  const hasGPS = shots.some(s => s.latitude && s.longitude);
  const hasDistance = shots.some(s => s.distanceToPin !== null);

  if (!hasGPS && !hasDistance && shots.length === 0) {
    return (
      <div className="flex items-center justify-center h-48 text-muted-foreground text-sm">
        No shot position data for this hole
      </div>
    );
  }

  let pts: Array<{ x: number; y: number; shot: Shot }> = [];

  if (hasGPS) {
    const lats = shots.filter(s => s.latitude).map(s => parseFloat(s.latitude!));
    const lngs = shots.filter(s => s.longitude).map(s => parseFloat(s.longitude!));
    const minLat = Math.min(...lats), maxLat = Math.max(...lats);
    const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
    pts = shots.filter(s => s.latitude && s.longitude).map(s => ({
      x: normalize(parseFloat(s.longitude!), minLng, maxLng, W - PADDING * 2) + PADDING,
      y: H - PADDING - normalize(parseFloat(s.latitude!), minLat, maxLat, H - PADDING * 2),
      shot: s,
    }));
  } else if (hasDistance) {
    const sorted = [...shots].sort((a, b) => a.shotNumber - b.shotNumber);
    const maxDist = Math.max(...sorted.map(s => s.distanceToPin ?? 0), 1);
    pts = sorted.map((s, i) => {
      const angle = (i / Math.max(sorted.length - 1, 1)) * Math.PI * 0.6 - Math.PI * 0.3;
      const dist = s.distanceToPin ?? 0;
      const r = normalize(dist, 0, maxDist, H * 0.7);
      return {
        x: W / 2 + Math.sin(angle) * r * 0.5,
        y: H - PADDING - r,
        shot: s,
      };
    });
    const holePt = { x: W / 2, y: PADDING + 10 };
    pts = [holePt as unknown as typeof pts[0], ...pts];
  } else {
    pts = shots.map((s, i) => ({
      x: PADDING + (i / Math.max(shots.length - 1, 1)) * (W - PADDING * 2),
      y: H / 2,
      shot: s,
    }));
  }

  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);
  const shotPts = hasDistance && !hasGPS ? pts.slice(1) : pts;
  const flagPt = hasDistance && !hasGPS ? pts[0] : null;

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full max-h-96 rounded-xl" style={{ background: 'rgba(0,60,20,0.3)' }}>
        {/* Fairway texture */}
        <ellipse cx={W / 2} cy={H * 0.55} rx={W * 0.38} ry={H * 0.4} fill="rgba(0,100,30,0.25)" />
        {/* Green */}
        <ellipse cx={flagPt?.x ?? W / 2} cy={flagPt?.y ?? PADDING + 20} rx={28} ry={20} fill="rgba(0,160,50,0.35)" />
        {/* Tee box */}
        <rect x={W / 2 - 14} y={H - PADDING - 14} width={28} height={20} rx={4} fill="rgba(180,120,20,0.4)" />

        {/* Shot path */}
        {shotPts.length > 1 && shotPts.slice(1).map((pt, i) => (
          <line key={i}
            x1={shotPts[i].x} y1={shotPts[i].y}
            x2={pt.x} y2={pt.y}
            stroke="rgba(255,255,255,0.2)" strokeWidth={1.5} strokeDasharray="4 3"
          />
        ))}
        {flagPt && shotPts.length > 0 && (
          <line x1={shotPts[shotPts.length - 1].x} y1={shotPts[shotPts.length - 1].y}
            x2={flagPt.x} y2={flagPt.y}
            stroke="rgba(255,255,255,0.12)" strokeWidth={1} strokeDasharray="3 4" />
        )}

        {/* Flag */}
        {flagPt && (
          <g>
            <line x1={flagPt.x} y1={flagPt.y - 4} x2={flagPt.x} y2={flagPt.y - 18} stroke="#fff" strokeWidth={1.5} />
            <polygon points={`${flagPt.x},${flagPt.y - 18} ${flagPt.x + 8},${flagPt.y - 14} ${flagPt.x},${flagPt.y - 10}`} fill="#EF4444" />
            <circle cx={flagPt.x} cy={flagPt.y} r={4} fill="#EF4444" />
          </g>
        )}

        {/* Shot circles */}
        {shotPts.map((pt, i) => {
          const color = getShotColor(pt.shot?.shotType);
          const isHovered = hoveredIdx === i;
          return (
            <g key={i} onMouseEnter={() => setHoveredIdx(i)} onMouseLeave={() => setHoveredIdx(null)}
              style={{ cursor: 'pointer' }}>
              <circle cx={pt.x} cy={pt.y} r={isHovered ? 13 : 10} fill={color} fillOpacity={0.15} />
              <circle cx={pt.x} cy={pt.y} r={isHovered ? 9 : 7} fill={color} />
              <text x={pt.x} y={pt.y + 0.5} textAnchor="middle" dominantBaseline="middle"
                fontSize={9} fontWeight="bold" fill="#fff">{i + 1}</text>
            </g>
          );
        })}

        {/* Tooltip */}
        {hoveredIdx !== null && shotPts[hoveredIdx]?.shot && (() => {
          const s = shotPts[hoveredIdx].shot;
          const px = Math.min(shotPts[hoveredIdx].x, W - 120);
          const py = Math.max(shotPts[hoveredIdx].y - 60, 4);
          return (
            <g>
              <rect x={px} y={py} width={120} height={52} rx={6} fill="#0f172a" fillOpacity={0.95} />
              <text x={px + 8} y={py + 14} fontSize={10} fontWeight="bold" fill="#C9A84C">{s.club ?? s.shotType ?? `Shot ${hoveredIdx + 1}`}</text>
              {s.distanceCarried && <text x={px + 8} y={py + 26} fontSize={9} fill="#9ca3af">Carry: {s.distanceCarried}yds</text>}
              {s.distanceToPin && <text x={px + 8} y={py + 37} fontSize={9} fill="#9ca3af">To pin: {s.distanceToPin}yds</text>}
              {s.outcome && <text x={px + 8} y={py + 48} fontSize={9} fill="#6b7280">{s.outcome}</text>}
            </g>
          );
        })()}

        {/* Hole number label */}
        <text x={PADDING / 2} y={PADDING / 2 + 4} fontSize={11} fill="rgba(255,255,255,0.5)" fontWeight="bold">H{hole}{par ? ` (Par ${par})` : ''}</text>
      </svg>

      {/* Shot legend */}
      <div className="flex flex-wrap gap-x-3 gap-y-1 mt-2 px-1">
        {shotPts.map((pt, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <span className="w-4 h-4 rounded-full text-[9px] font-bold flex items-center justify-center text-white"
              style={{ background: getShotColor(pt.shot?.shotType) }}>{i + 1}</span>
            <span className="text-xs text-muted-foreground">{pt.shot?.club ?? pt.shot?.shotType ?? 'Shot'}{pt.shot?.distanceCarried ? ` · ${pt.shot.distanceCarried}y` : ''}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

interface Props {
  orgId: number;
  tournamentId: number;
  playerId: number;
  playerName: string;
  rounds?: number;
}

export function HoleReplayMap({ orgId, tournamentId, playerId, playerName, rounds = 1 }: Props) {
  const [selectedRound, setSelectedRound] = useState(1);
  const [currentHole, setCurrentHole] = useState(0);

  const { data: shotData, isLoading } = useQuery<{ hole: number; shots: Shot[] }[]>({
    queryKey: ['round-shots', orgId, tournamentId, playerId, selectedRound],
    queryFn: async () => {
      const res = await fetch(`${BASE_URL}/api/organizations/${orgId}/tournaments/${tournamentId}/players/${playerId}/rounds/${selectedRound}/shots`, { credentials: 'include' });
      if (!res.ok) return [];
      const json = await res.json();
      // API returns { tournamentId, playerId, round, holes: [{ holeNumber, shotCount, shots }] }
      const rawHoles: { holeNumber: number; shots: Shot[] }[] = Array.isArray(json) ? json : (json.holes ?? []);
      return rawHoles.map((h) => ({ hole: h.holeNumber, shots: h.shots ?? [] }));
    },
  });

  const holes: HoleGroup[] = shotData ?? [];
  const totalHoles = holes.length;
  const hole = holes[currentHole];

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-3 justify-between">
        <div>
          <p className="text-white font-semibold">{playerName}</p>
          <p className="text-xs text-muted-foreground">Shot-by-shot replay</p>
        </div>
        {rounds > 1 && (
          <div className="flex gap-1">
            {Array.from({ length: rounds }, (_, i) => i + 1).map(r => (
              <Button key={r} size="sm" variant={selectedRound === r ? 'default' : 'outline'}
                onClick={() => { setSelectedRound(r); setCurrentHole(0); }}
                className={selectedRound === r ? 'bg-[#C9A84C] text-black' : 'border-white/10 text-muted-foreground'}>
                R{r}
              </Button>
            ))}
          </div>
        )}
      </div>

      {isLoading ? (
        <div className="h-48 glass-card rounded-2xl animate-pulse" />
      ) : holes.length === 0 ? (
        <Card className="glass-panel p-10 text-center border-dashed">
          <Map className="w-10 h-10 text-muted-foreground mx-auto mb-3 opacity-40" />
          <p className="text-white font-medium">No shot data available</p>
          <p className="text-sm text-muted-foreground mt-1">Shot tracking data is collected via GPX upload or a connected wearable.</p>
        </Card>
      ) : (
        <Card className="glass-card border-none">
          <CardContent className="pt-4 pb-6 space-y-4">
            {/* Hole navigation */}
            <div className="flex items-center justify-between">
              <Button size="sm" variant="ghost" disabled={currentHole === 0} onClick={() => setCurrentHole(h => h - 1)}>
                <ChevronLeft className="w-4 h-4" />
              </Button>
              <div className="flex gap-1 flex-wrap justify-center">
                {holes.map((h, i) => (
                  <button key={i} onClick={() => setCurrentHole(i)}
                    className={`w-7 h-7 rounded-full text-xs font-bold transition-colors ${currentHole === i ? 'bg-[#C9A84C] text-black' : 'bg-white/5 text-muted-foreground hover:bg-white/10'}`}>
                    {h.hole}
                  </button>
                ))}
              </div>
              <Button size="sm" variant="ghost" disabled={currentHole === totalHoles - 1} onClick={() => setCurrentHole(h => h + 1)}>
                <ChevronRight className="w-4 h-4" />
              </Button>
            </div>

            {/* SVG Hole Diagram */}
            <AnimatePresence mode="wait">
              {hole && (
                <motion.div key={`${selectedRound}-${currentHole}`}
                  initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }}>
                  <div className="flex items-center gap-2 mb-3">
                    <span className="text-white font-bold text-lg">Hole {hole.hole}</span>
                    <Badge className="bg-white/10 text-muted-foreground border-0">{hole.shots.length} shot{hole.shots.length !== 1 ? 's' : ''}</Badge>
                  </div>
                  <SVGHoleDiagram shots={hole.shots} hole={hole.hole} />
                </motion.div>
              )}
            </AnimatePresence>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
