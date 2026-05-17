import { useState, useEffect, useRef } from "react";
import { Calculator, TrendingDown, Info } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";

interface SimResult {
  input: { handicapIndex: number; courseRating: number; courseSlope: number; coursePar: number; handicapAllowance: number; grossScore: number | null };
  result: { courseHandicap: number; playingHandicap: number; netScore: number | null; netToPar: number | null; grossToPar: number | null; projectedHandicapIndex: number | null; netPar: number; parDiff: number };
  simulations: { handicapIndex: number; courseHandicap: number; playingHandicap: number }[];
}

function formatScore(n: number | null) {
  if (n === null) return "—";
  if (n === 0) return "E";
  return n > 0 ? `+${n}` : `${n}`;
}

function ScoreColorClass(n: number | null): string {
  if (n === null) return "text-gray-400";
  if (n <= -2) return "text-amber-400";
  if (n === -1) return "text-red-400";
  if (n === 0) return "text-gray-100";
  if (n === 1) return "text-blue-400";
  return "text-purple-400";
}

function MiniChart({ simulations, currentHI, playingHandicap }: {
  simulations: SimResult["simulations"];
  currentHI: number;
  playingHandicap: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || simulations.length === 0) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const W = canvas.offsetWidth, H = canvas.offsetHeight;
    canvas.width = W; canvas.height = H;
    const pad = { l: 36, r: 8, t: 8, b: 24 };
    const cw = W - pad.l - pad.r, ch = H - pad.t - pad.b;
    const phs = simulations.map(s => s.playingHandicap);
    const minPH = Math.min(...phs), maxPH = Math.max(...phs);
    const phRange = maxPH - minPH || 1;
    const his = simulations.map(s => s.handicapIndex);
    const minHI = Math.min(...his), maxHI = Math.max(...his);
    const hiRange = maxHI - minHI || 1;
    const toX = (hi: number) => pad.l + ((hi - minHI) / hiRange) * cw;
    const toY = (ph: number) => pad.t + ch - ((ph - minPH) / phRange) * ch;

    ctx.clearRect(0, 0, W, H);
    ctx.strokeStyle = "rgba(255,255,255,0.06)";
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = pad.t + (ch / 4) * i;
      ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(W - pad.r, y); ctx.stroke();
      const val = maxPH - (i / 4) * phRange;
      ctx.fillStyle = "rgba(255,255,255,0.3)"; ctx.font = "9px monospace";
      ctx.fillText(Math.round(val).toString(), 2, y + 3);
    }

    ctx.beginPath();
    ctx.strokeStyle = "#22c55e"; ctx.lineWidth = 2;
    simulations.forEach((s, idx) => {
      const x = toX(s.handicapIndex), y = toY(s.playingHandicap);
      if (idx === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();

    const curSim = simulations.find(s => Math.abs(s.handicapIndex - currentHI) < 0.3);
    if (curSim) {
      const cx2 = toX(curSim.handicapIndex), cy2 = toY(curSim.playingHandicap);
      ctx.beginPath();
      ctx.arc(cx2, cy2, 5, 0, Math.PI * 2);
      ctx.fillStyle = "#C9A84C"; ctx.fill();
      ctx.strokeStyle = "#0b1512"; ctx.lineWidth = 1.5; ctx.stroke();
    }
  }, [simulations, currentHI, playingHandicap]);

  return (
    <canvas
      ref={canvasRef}
      className="w-full"
      style={{ height: 120 }}
    />
  );
}

export default function HandicapSimulator() {
  const [handicapIndex, setHandicapIndex] = useState(18);
  const [courseRating, setCourseRating] = useState(72);
  const [courseSlope, setCourseSlope] = useState(113);
  const [coursePar, setCoursePar] = useState(72);
  const [handicapAllowance, setHandicapAllowance] = useState(100);
  const [grossScore, setGrossScore] = useState<string>("");
  const [result, setResult] = useState<SimResult | null>(null);
  const [loading, setLoading] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const baseUrl = (import.meta.env.BASE_URL ?? "/").replace(/\/$/, "");

  async function simulate() {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        handicapIndex: handicapIndex.toString(),
        courseRating: courseRating.toString(),
        courseSlope: courseSlope.toString(),
        coursePar: coursePar.toString(),
        handicapAllowance: handicapAllowance.toString(),
        grossScore: grossScore || "0",
      });
      const res = await fetch(`${baseUrl}/api/portal/handicap/simulate?${params}`);
      if (!res.ok) throw new Error("Failed");
      setResult(await res.json());
    } catch {
      setResult(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => { simulate(); }, 300);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [handicapIndex, courseRating, courseSlope, coursePar, handicapAllowance, grossScore]);

  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-[#C9A84C]/20 flex items-center justify-center">
          <Calculator className="text-[#C9A84C]" size={20} />
        </div>
        <div>
          <h1 className="text-2xl font-display font-bold text-white">Handicap Simulator</h1>
          <p className="text-muted-foreground text-sm">WHS course handicap calculator with playing handicap breakdown</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Inputs */}
        <div className="glass-panel rounded-2xl p-5 space-y-5 border border-white/10">
          <h2 className="font-semibold text-white text-sm uppercase tracking-wider">Parameters</h2>

          {/* Handicap Index Slider */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-muted-foreground text-xs font-medium">Handicap Index</Label>
              <span className="text-white font-bold text-lg tabular-nums">{handicapIndex.toFixed(1)}</span>
            </div>
            <Slider
              min={0} max={54} step={0.1}
              value={[handicapIndex]}
              onValueChange={([v]) => setHandicapIndex(v)}
              className="w-full"
            />
            <div className="flex justify-between text-[10px] text-gray-600">
              <span>0 (scratch)</span><span>54 (max)</span>
            </div>
          </div>

          {/* Course Rating */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-muted-foreground text-xs">Course Rating</Label>
              <Input
                type="number" step="0.1" min={55} max={80}
                value={courseRating}
                onChange={e => setCourseRating(parseFloat(e.target.value) || 72)}
                className="bg-white/5 border-white/10 text-white font-mono"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-muted-foreground text-xs">Slope Rating</Label>
              <Input
                type="number" step="1" min={55} max={155}
                value={courseSlope}
                onChange={e => setCourseSlope(parseInt(e.target.value) || 113)}
                className="bg-white/5 border-white/10 text-white font-mono"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-muted-foreground text-xs">Course Par</Label>
              <Input
                type="number" min={60} max={80}
                value={coursePar}
                onChange={e => setCoursePar(parseInt(e.target.value) || 72)}
                className="bg-white/5 border-white/10 text-white font-mono"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-muted-foreground text-xs">Allowance %</Label>
              <Input
                type="number" min={50} max={100} step={5}
                value={handicapAllowance}
                onChange={e => setHandicapAllowance(parseInt(e.target.value) || 100)}
                className="bg-white/5 border-white/10 text-white font-mono"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label className="text-muted-foreground text-xs">Your Gross Score (optional)</Label>
            <Input
              type="number" min={60} max={130} placeholder="e.g. 85"
              value={grossScore}
              onChange={e => setGrossScore(e.target.value)}
              className="bg-white/5 border-white/10 text-white font-mono"
            />
          </div>
        </div>

        {/* Results */}
        <div className="space-y-4">
          {/* Main result */}
          <div className="glass-panel rounded-2xl p-5 border border-white/10">
            <h2 className="font-semibold text-white text-sm uppercase tracking-wider mb-4">Result</h2>
            {loading ? (
              <div className="flex items-center justify-center py-8">
                <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
              </div>
            ) : result ? (
              <>
                <div className="grid grid-cols-2 gap-4 mb-4">
                  <div className="text-center p-4 rounded-xl bg-[#C9A84C]/10 border border-[#C9A84C]/20">
                    <div className="text-[10px] text-gray-500 uppercase tracking-widest mb-1">Course Handicap</div>
                    <div className="text-4xl font-extrabold text-[#C9A84C] tabular-nums">{result.result.courseHandicap}</div>
                    <div className="text-[10px] text-gray-600 mt-1">HI × (Slope/113) + (CR−Par)</div>
                  </div>
                  <div className="text-center p-4 rounded-xl bg-green-500/10 border border-green-500/20">
                    <div className="text-[10px] text-gray-500 uppercase tracking-widest mb-1">Playing Handicap</div>
                    <div className="text-4xl font-extrabold text-green-400 tabular-nums">{result.result.playingHandicap}</div>
                    <div className="text-[10px] text-gray-600 mt-1">CH × {handicapAllowance}% allowance</div>
                  </div>
                </div>

                {result.result.netScore !== null && (
                  <div className="grid grid-cols-3 gap-3 border-t border-white/5 pt-4">
                    <div className="text-center">
                      <div className="text-[10px] text-gray-600 mb-1">Gross</div>
                      <div className="text-xl font-bold text-white">{result.input.grossScore}</div>
                      <div className={`text-sm font-semibold ${ScoreColorClass(result.result.grossToPar)}`}>{formatScore(result.result.grossToPar)}</div>
                    </div>
                    <div className="text-center border-x border-white/5">
                      <div className="text-[10px] text-gray-600 mb-1">Strokes</div>
                      <div className="text-xl font-bold text-green-400">−{result.result.playingHandicap}</div>
                    </div>
                    <div className="text-center">
                      <div className="text-[10px] text-gray-600 mb-1">Net Score</div>
                      <div className="text-xl font-bold text-white">{result.result.netScore}</div>
                      <div className={`text-sm font-semibold ${ScoreColorClass(result.result.netToPar)}`}>{formatScore(result.result.netToPar)}</div>
                    </div>
                  </div>
                )}

                {result.result.projectedHandicapIndex !== null && (
                  <div className="mt-3 p-3 rounded-xl bg-blue-500/10 border border-blue-500/20 flex items-center justify-between">
                    <div>
                      <div className="text-[10px] text-gray-500 uppercase tracking-widest">Projected New HCP Index</div>
                      <div className="text-xs text-gray-600 mt-0.5">If this gross score were submitted (single-round estimate)</div>
                    </div>
                    <div className="text-2xl font-extrabold text-blue-400 tabular-nums">{result.result.projectedHandicapIndex}</div>
                  </div>
                )}

                <div className="mt-4 p-3 rounded-xl bg-white/3 border border-white/5">
                  <div className="flex items-start gap-2">
                    <Info size={12} className="text-gray-600 mt-0.5 shrink-0" />
                    <p className="text-[11px] text-gray-600 leading-relaxed">
                      WHS formula: CH = {handicapIndex} × ({courseSlope}/113) + ({courseRating}−{coursePar}) = {result.result.courseHandicap} → PH = {result.result.courseHandicap} × {handicapAllowance}% = <strong className="text-gray-400">{result.result.playingHandicap}</strong>
                    </p>
                  </div>
                </div>
              </>
            ) : (
              <p className="text-gray-500 text-center py-8">Enter values to calculate</p>
            )}
          </div>

          {/* Chart */}
          {result && result.simulations.length > 0 && (
            <div className="glass-panel rounded-2xl p-5 border border-white/10">
              <div className="flex items-center gap-2 mb-3">
                <TrendingDown size={14} className="text-green-400" />
                <h2 className="font-semibold text-white text-sm">Playing Handicap vs Handicap Index</h2>
              </div>
              <MiniChart
                simulations={result.simulations}
                currentHI={handicapIndex}
                playingHandicap={result.result.playingHandicap}
              />
              <div className="flex justify-between mt-1 text-[10px] text-gray-600">
                <span>{Math.max(0, Math.min(...result.simulations.map(s => s.handicapIndex))).toFixed(0)} HI</span>
                <span className="text-[#C9A84C]">● Current: {handicapIndex.toFixed(1)} HI → PH {result.result.playingHandicap}</span>
                <span>{Math.max(...result.simulations.map(s => s.handicapIndex)).toFixed(0)} HI</span>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
