import { useEffect, useState } from "react";
import { Trophy, Lock, Sparkles } from "lucide-react";

type LeaderRow = { id: number; displayName: string; score: number | null; submittedAt: string };

interface Props {
  tournamentId: number;
  surface?: string;
}

export default function PredictionGameWidget({ tournamentId, surface = "web_public" }: Props) {
  const [leaders, setLeaders] = useState<LeaderRow[] | null>(null);
  const [disclosure, setDisclosure] = useState<string>("");
  const [hidden, setHidden] = useState(false);
  const baseUrl = (import.meta.env.BASE_URL ?? "/").replace(/\/$/, "");

  useEffect(() => {
    let cancel = false;
    fetch(`${baseUrl}/api/public/tournaments/${tournamentId}/predictions/leaderboard`)
      .then(async r => {
        if (!r.ok) { setHidden(true); return; }
        const j = await r.json();
        if (cancel) return;
        setLeaders(j.entries ?? []);
        setDisclosure(j.disclosure ?? "");
        fetch(`${baseUrl}/api/public/tournaments/${tournamentId}/odds/telemetry`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ eventType: "impression", widget: "predictions", surface }),
        }).catch(() => {});
      })
      .catch(() => setHidden(true));
    return () => { cancel = true; };
  }, [tournamentId, baseUrl, surface]);

  if (hidden) return null;

  return (
    <section
      className="rounded-xl border border-violet-200 bg-violet-50 p-4 shadow-sm"
      data-testid="prediction-game-widget"
    >
      <header className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Sparkles className="h-5 w-5 text-violet-700" />
          <h3 className="text-base font-semibold text-violet-900">Prediction game</h3>
        </div>
        <span className="rounded-full border border-violet-300 bg-white/60 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-violet-800">
          Free to play · No prizes
        </span>
      </header>

      {leaders && leaders.length > 0 ? (
        <ol className="space-y-1">
          {leaders.slice(0, 10).map((l, i) => (
            <li key={l.id} className="flex items-center justify-between gap-2 rounded bg-white px-2 py-1.5 text-sm">
              <span className="flex items-center gap-2">
                <span className="w-5 text-xs text-slate-400">{i + 1}</span>
                <Trophy className="h-3.5 w-3.5 text-amber-500" />
                <span className="truncate font-medium text-slate-800">{l.displayName}</span>
              </span>
              <span className="font-semibold text-violet-700">
                {l.score == null ? <span className="flex items-center gap-1 text-xs text-slate-500"><Lock className="h-3 w-3" /> pending</span> : l.score}
              </span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="text-sm text-slate-700">
          No predictions submitted yet. Sign in to your club app to make a pick before tee-off.
        </p>
      )}

      {disclosure && (
        <p className="mt-3 text-[11px] leading-snug text-slate-700">{disclosure}</p>
      )}
    </section>
  );
}
