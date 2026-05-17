/**
 * Public ladder page (Task #376) — accessible by share slug, no auth required.
 */
import { useQuery } from "@tanstack/react-query";
import { useRoute } from "wouter";

interface PublicLadder {
  id: number;
  name: string;
  description: string | null;
  scope: string;
  format: string;
  status: string;
  region: string | null;
  seasonStart: string;
  seasonEnd: string;
  shareSlug: string;
  clubs: Array<{ organizationId: number; orgName: string | null; orgSlug: string | null }>;
  standings: Array<{
    id: number;
    playerName: string;
    division: number;
    totalPoints: number;
    roundsCounted: number;
    position: number | null;
    previousPosition: number | null;
    orgName: string | null;
  }>;
  recentResults: Array<{
    id: number;
    entryId: number;
    roundDate: string;
    pointsAwarded: number;
    countedTowardTotal: boolean;
  }>;
}

export default function LadderPublicPage() {
  const [, params] = useRoute("/ladder/:slug");
  const slug = params?.slug;
  const { data, isLoading, error } = useQuery<PublicLadder>({
    queryKey: ["/api/public/cross-club-ladders", slug],
    queryFn: () => fetch(`/api/public/cross-club-ladders/${slug}`).then(r => {
      if (!r.ok) throw new Error("Ladder not found");
      return r.json();
    }),
    enabled: !!slug,
  });

  if (isLoading) return <div className="min-h-screen bg-slate-950 text-white p-6" data-testid="text-loading">Loading…</div>;
  if (error || !data) return <div className="min-h-screen bg-slate-950 text-white p-6" data-testid="text-error">Ladder not found.</div>;

  const standingsByDiv = new Map<number, PublicLadder["standings"]>();
  for (const s of data.standings) {
    const arr = standingsByDiv.get(s.division) ?? [];
    arr.push(s);
    standingsByDiv.set(s.division, arr);
  }

  return (
    <div className="min-h-screen bg-slate-950 text-white p-6" data-testid="page-ladder-public">
      <div className="max-w-5xl mx-auto">
        <header className="mb-6">
          <p className="text-emerald-400 text-xs uppercase tracking-wider">{data.scope} {data.format}</p>
          <h1 className="text-3xl font-bold mt-1" data-testid="text-ladder-name">{data.name}</h1>
          {data.description ? <p className="text-slate-400 mt-2">{data.description}</p> : null}
          <p className="text-xs text-slate-500 mt-2">
            Season {new Date(data.seasonStart).toLocaleDateString()} – {new Date(data.seasonEnd).toLocaleDateString()}
            {data.region ? ` • ${data.region}` : ""} • Status: <span className="capitalize">{data.status}</span>
          </p>
        </header>

        <section className="mb-6">
          <h2 className="text-sm font-semibold text-slate-300 mb-2">Participating clubs ({data.clubs.length})</h2>
          <div className="flex flex-wrap gap-2">
            {data.clubs.map(c => (
              <span key={c.organizationId} className="px-2 py-1 bg-slate-800 rounded text-xs" data-testid={`club-${c.organizationId}`}>
                {c.orgName ?? `Club #${c.organizationId}`}
              </span>
            ))}
            {data.clubs.length === 0 && <span className="text-slate-500 text-xs">No clubs yet.</span>}
          </div>
        </section>

        {[...standingsByDiv.entries()].sort((a, b) => a[0] - b[0]).map(([div, list]) => (
          <section key={div} className="mb-6 bg-slate-900 border border-slate-800 rounded overflow-hidden" data-testid={`division-${div}`}>
            <div className="bg-slate-800 px-4 py-2 text-sm font-semibold">Division {div}</div>
            <table className="w-full text-sm">
              <thead className="text-xs text-slate-400 border-b border-slate-800">
                <tr>
                  <th className="text-left px-4 py-2">#</th>
                  <th className="text-left px-4 py-2">Player</th>
                  <th className="text-left px-4 py-2">Club</th>
                  <th className="text-right px-4 py-2">Rounds</th>
                  <th className="text-right px-4 py-2">Points</th>
                  <th className="text-right px-4 py-2">Δ</th>
                </tr>
              </thead>
              <tbody>
                {list.map(s => {
                  const delta = s.previousPosition != null && s.position != null ? s.previousPosition - s.position : null;
                  return (
                    <tr key={s.id} className="border-b border-slate-800/50" data-testid={`standing-${s.id}`}>
                      <td className="px-4 py-2 font-semibold">{s.position ?? "—"}</td>
                      <td className="px-4 py-2">{s.playerName}</td>
                      <td className="px-4 py-2 text-slate-400">{s.orgName ?? "—"}</td>
                      <td className="px-4 py-2 text-right">{s.roundsCounted}</td>
                      <td className="px-4 py-2 text-right font-semibold text-emerald-400">{s.totalPoints}</td>
                      <td className="px-4 py-2 text-right">
                        {delta == null ? "—" : delta > 0 ? <span className="text-emerald-400">▲ {delta}</span> : delta < 0 ? <span className="text-rose-400">▼ {Math.abs(delta)}</span> : "–"}
                      </td>
                    </tr>
                  );
                })}
                {list.length === 0 && (
                  <tr><td colSpan={6} className="px-4 py-4 text-center text-slate-500">No standings yet.</td></tr>
                )}
              </tbody>
            </table>
          </section>
        ))}

        {data.standings.length === 0 && (
          <div className="bg-slate-900 border border-slate-800 rounded p-8 text-center text-slate-400" data-testid="text-no-standings">
            No standings yet. The ladder will populate as qualifying rounds are posted.
          </div>
        )}
      </div>
    </div>
  );
}
