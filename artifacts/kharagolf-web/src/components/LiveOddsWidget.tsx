import { useEffect, useState } from "react";
import { TrendingUp, TrendingDown, Activity, AlertTriangle } from "lucide-react";

type WinProbabilityRow = {
  playerId: number;
  name: string;
  position: number | null;
  scoreToPar: number | null;
  holesCompleted: number;
  winProbability: number;
};
type ExpectedScoreRow = {
  holeNumber: number;
  par: number;
  expectedStrokes: number;
  scoringAverageVsPar: number;
};
type BiggestSwingRow = {
  playerId: number;
  name: string;
  delta: number;
  holeNumber: number;
  round: number;
  strokes: number;
  par: number;
};
type OddsPayload = {
  tournamentId: number;
  tournamentName: string;
  coursePar: number;
  rounds: number;
  winProbability: WinProbabilityRow[];
  expectedScores: ExpectedScoreRow[];
  biggestSwings: BiggestSwingRow[];
  disclosure: string;
  lastUpdated: string;
};

interface Props {
  tournamentId: number;
  surface?: string;
}

export default function LiveOddsWidget({ tournamentId, surface = "web_public" }: Props) {
  const [data, setData] = useState<OddsPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const baseUrl = (import.meta.env.BASE_URL ?? "/").replace(/\/$/, "");

  useEffect(() => {
    let cancel = false;
    let sse: EventSource | null = null;

    // Initial fetch handles the gating/error case (EventSource hides HTTP
    // status codes); on success we open the SSE stream for live updates.
    async function init() {
      try {
        const r = await fetch(`${baseUrl}/api/public/tournaments/${tournamentId}/odds`);
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          if (!cancel) setError(body?.reason ?? body?.error ?? "Live insights unavailable.");
          return;
        }
        const json = (await r.json()) as OddsPayload;
        if (cancel) return;
        setData(json);
        setError(null);
        // Fire-and-forget impression telemetry
        fetch(`${baseUrl}/api/public/tournaments/${tournamentId}/odds/telemetry`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ eventType: "impression", widget: "win_probability", surface }),
        }).catch(() => {});

        // Subscribe to live updates — server pushes a new payload whenever
        // the leaderboard moves, so no polling interval is needed.
        if (cancel) return;
        sse = new EventSource(`${baseUrl}/api/public/tournaments/${tournamentId}/odds/stream`);
        sse.onmessage = (ev) => {
          try {
            const parsed = JSON.parse(ev.data) as { type?: string; data?: OddsPayload };
            if (parsed?.type === "odds_update" && parsed.data) {
              setData(parsed.data);
            }
          } catch { /* ignore malformed events */ }
        };
        // EventSource auto-reconnects on network errors; nothing to do here.
      } catch {
        if (!cancel) setError("Live insights unavailable.");
      } finally {
        if (!cancel) setLoading(false);
      }
    }

    init();
    return () => {
      cancel = true;
      if (sse) sse.close();
    };
  }, [tournamentId, baseUrl, surface]);

  if (loading) {
    return (
      <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm" data-testid="live-odds-loading">
        <p className="text-sm text-slate-500">Loading live insights…</p>
      </div>
    );
  }
  if (error || !data) {
    return null; // Silent gating per club/region policy.
  }

  const fmtPct = (v: number) => `${(v * 100).toFixed(1)}%`;
  const trackClick = (widget: string) => {
    fetch(`${baseUrl}/api/public/tournaments/${tournamentId}/odds/telemetry`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ eventType: "click", widget, surface }),
    }).catch(() => {});
  };

  const topSwings = data.biggestSwings.slice(0, 5);

  return (
    <section
      className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 shadow-sm"
      data-testid="live-odds-widget"
      aria-label="Live tournament insights"
    >
      <header className="mb-3 flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <Activity className="h-5 w-5 text-emerald-700" />
          <h3 className="text-base font-semibold text-emerald-900">Live insights</h3>
        </div>
        <span className="rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-800">
          Entertainment only — not betting
        </span>
      </header>

      <div className="grid gap-4 lg:grid-cols-3">
        {/* Win probability ladder */}
        <div onMouseEnter={() => trackClick("win_probability")} data-testid="win-prob-card">
          <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-700">
            Win probability ladder
          </h4>
          <ol className="space-y-1.5">
            {data.winProbability.length === 0 ? (
              <li className="text-sm text-slate-500">No active players yet.</li>
            ) : (
              data.winProbability.slice(0, 8).map((p, i) => (
                <li key={p.playerId} className="flex items-center justify-between gap-2 rounded bg-white px-2 py-1.5 text-sm">
                  <span className="flex items-center gap-2 truncate">
                    <span className="w-5 text-xs text-slate-400">{i + 1}</span>
                    <span className="truncate font-medium text-slate-800">{p.name}</span>
                  </span>
                  <span className="flex items-center gap-2">
                    <span className="text-xs text-slate-500">
                      {p.scoreToPar == null ? "—" : p.scoreToPar > 0 ? `+${p.scoreToPar}` : p.scoreToPar === 0 ? "E" : p.scoreToPar}
                    </span>
                    <span className="font-semibold text-emerald-700">{fmtPct(p.winProbability)}</span>
                  </span>
                </li>
              ))
            )}
          </ol>
        </div>

        {/* Expected scores */}
        <div onMouseEnter={() => trackClick("expected_score")} data-testid="expected-score-card">
          <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-700">
            Expected score per hole
          </h4>
          <div className="grid grid-cols-6 gap-1 text-center text-[11px]">
            {data.expectedScores.slice(0, 18).map((h) => {
              const diff = h.scoringAverageVsPar;
              const tone =
                diff > 0.25 ? "bg-rose-100 text-rose-800" :
                diff < -0.25 ? "bg-emerald-100 text-emerald-800" :
                "bg-slate-100 text-slate-700";
              return (
                <div key={h.holeNumber} className={`rounded px-1 py-1 ${tone}`}>
                  <div className="font-semibold">{h.holeNumber}</div>
                  <div className="text-[10px] opacity-70">par {h.par}</div>
                  <div className="font-mono">{h.expectedStrokes.toFixed(2)}</div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Biggest swings */}
        <div onMouseEnter={() => trackClick("biggest_swings")} data-testid="biggest-swings-card">
          <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-700">
            Biggest swings
          </h4>
          <ul className="space-y-1.5">
            {topSwings.length === 0 ? (
              <li className="text-sm text-slate-500">Not enough data yet.</li>
            ) : (
              topSwings.map((s, i) => {
                const lost = s.delta > 0;
                return (
                  <li key={`${s.playerId}-${s.round}-${s.holeNumber}-${i}`} className="flex items-center justify-between gap-2 rounded bg-white px-2 py-1.5 text-sm">
                    <span className="flex items-center gap-2 truncate">
                      {lost ? <TrendingDown className="h-4 w-4 text-rose-500" /> : <TrendingUp className="h-4 w-4 text-emerald-600" />}
                      <span className="truncate font-medium text-slate-800">{s.name}</span>
                    </span>
                    <span className="text-xs text-slate-600">
                      R{s.round} H{s.holeNumber} • {s.strokes}/{s.par}
                      <span className={`ml-2 font-mono font-semibold ${lost ? "text-rose-600" : "text-emerald-700"}`}>
                        {lost ? "+" : ""}{s.delta.toFixed(2)}
                      </span>
                    </span>
                  </li>
                );
              })
            )}
          </ul>
        </div>
      </div>

      <p className="mt-3 flex items-start gap-1.5 text-[11px] leading-snug text-slate-700">
        <AlertTriangle className="mt-0.5 h-3 w-3 flex-shrink-0 text-amber-700" />
        <span>{data.disclosure}</span>
      </p>
    </section>
  );
}
