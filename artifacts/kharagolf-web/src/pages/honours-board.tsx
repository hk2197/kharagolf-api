import { useQuery } from "@tanstack/react-query";
import { useParams } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Trophy, Star, Award, Medal } from "lucide-react";

async function api(method: string, url: string, body?: unknown) {
  const res = await fetch(url, {
    method,
    credentials: "include",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok && res.status !== 204) throw new Error(`Request failed: ${res.status}`);
  return res;
}

interface Flight { id: number; name: string; scoreType: string; displayOrder: number; }
interface Winner { id: number; flightId?: number; playerName: string; score?: string; notes?: string; position: number; }
interface Championship { id: number; year: number; title: string; notes?: string; tournamentName?: string; flights: Flight[]; winners: Winner[]; }
interface HonoursData { org: { id: number; name: string; logoUrl?: string; primaryColor?: string }; championships: Championship[]; }

const POSITION_ICONS: Record<number, React.ReactNode> = {
  1: <Trophy className="h-4 w-4 text-yellow-500" />,
  2: <Medal className="h-4 w-4 text-slate-400" />,
  3: <Award className="h-4 w-4 text-amber-600" />,
};

function ChampionshipCard({ ch }: { ch: Championship }) {
  const byFlight: Record<string, Winner[]> = {};
  const ungrouped: Winner[] = [];

  for (const w of ch.winners) {
    if (!w.flightId) {
      ungrouped.push(w);
    } else {
      const key = String(w.flightId);
      if (!byFlight[key]) byFlight[key] = [];
      byFlight[key].push(w);
    }
  }

  const groupedFlights = ch.flights.map(f => ({ flight: f, winners: byFlight[String(f.id)] ?? [] }))
    .filter(({ winners }) => winners.length > 0);

  return (
    <Card className="overflow-hidden">
      <CardHeader className="bg-primary/5 border-b">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-lg">{ch.year}</CardTitle>
            <p className="text-sm text-muted-foreground">{ch.title}</p>
          </div>
          {ch.tournamentName && (
            <Badge variant="secondary" className="text-xs">{ch.tournamentName}</Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="pt-4 space-y-4">
        {ch.winners.length === 0 ? (
          <p className="text-sm text-muted-foreground italic">No winners recorded</p>
        ) : (
          <>
            {ungrouped.length > 0 && (
              <div>
                {ch.flights.length > 0 && (
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">Overall</p>
                )}
                <div className="space-y-1.5">
                  {ungrouped.sort((a, b) => a.position - b.position).map(w => (
                    <div key={w.id} className="flex items-center gap-2.5">
                      <span className="w-5 flex-shrink-0">
                        {POSITION_ICONS[w.position] ?? <span className="text-xs text-muted-foreground">{w.position}</span>}
                      </span>
                      <span className="font-medium">{w.playerName}</span>
                      {w.score && <span className="text-sm text-muted-foreground">({w.score})</span>}
                    </div>
                  ))}
                </div>
              </div>
            )}
            {groupedFlights.map(({ flight, winners }) => (
              <div key={flight.id}>
                <div className="flex items-center gap-2 mb-2">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{flight.name}</p>
                  <Badge variant="outline" className="text-xs">{flight.scoreType}</Badge>
                </div>
                <div className="space-y-1.5">
                  {winners.sort((a, b) => a.position - b.position).map(w => (
                    <div key={w.id} className="flex items-center gap-2.5">
                      <span className="w-5 flex-shrink-0">
                        {POSITION_ICONS[w.position] ?? <span className="text-xs text-muted-foreground">{w.position}</span>}
                      </span>
                      <span className="font-medium">{w.playerName}</span>
                      {w.score && <span className="text-sm text-muted-foreground">({w.score})</span>}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </>
        )}
        {ch.notes && (
          <p className="text-xs text-muted-foreground border-t pt-2 mt-2">{ch.notes}</p>
        )}
      </CardContent>
    </Card>
  );
}

export default function HonoursBoardPage() {
  const params = useParams<{ orgId: string }>();
  const orgId = params.orgId;

  const { data, isLoading, error } = useQuery<HonoursData>({
    queryKey: ["honours-board", orgId],
    queryFn: () => api("GET", `/api/public/orgs/${orgId}/honours-board`).then(r => r.json()),
    enabled: !!orgId,
  });

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="animate-spin h-8 w-8 border-4 border-primary border-t-transparent rounded-full" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center gap-3">
        <Trophy className="h-16 w-16 text-muted-foreground/30" />
        <h1 className="text-xl font-semibold text-muted-foreground">Honours Board not found</h1>
        <p className="text-sm text-muted-foreground">This club's honours board may not be publicly available.</p>
      </div>
    );
  }

  const { org, championships } = data;

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-4xl mx-auto px-4 py-8">
        {/* Header */}
        <div className="text-center mb-10">
          {org.logoUrl && (
            <img src={org.logoUrl} alt={org.name} className="h-16 w-16 object-contain mx-auto mb-4 rounded-full" />
          )}
          <h1 className="text-3xl font-bold">{org.name}</h1>
          <div className="flex items-center justify-center gap-2 mt-2">
            <Trophy className="h-5 w-5 text-yellow-500" />
            <p className="text-xl text-muted-foreground font-medium">Club Champions Honours Board</p>
          </div>
        </div>

        {championships.length === 0 ? (
          <div className="text-center py-16">
            <Trophy className="h-16 w-16 text-muted-foreground/30 mx-auto mb-4" />
            <p className="text-muted-foreground font-medium">No published championships yet</p>
          </div>
        ) : (
          <>
            {/* Latest champion highlight */}
            {championships[0] && championships[0].winners.some(w => w.position === 1) && (
              <div className="mb-8 bg-gradient-to-r from-yellow-500/10 to-amber-500/10 border border-yellow-500/20 rounded-xl p-6 text-center">
                <div className="flex items-center justify-center gap-2 mb-1">
                  <Star className="h-5 w-5 text-yellow-500 fill-yellow-500" />
                  <span className="text-sm font-medium text-yellow-700 dark:text-yellow-400">Current Champion – {championships[0].year}</span>
                  <Star className="h-5 w-5 text-yellow-500 fill-yellow-500" />
                </div>
                {championships[0].winners.filter(w => w.position === 1).map(w => (
                  <div key={w.id} className="mt-1">
                    <p className="text-2xl font-bold">{w.playerName}</p>
                    {w.score && <p className="text-muted-foreground text-sm">{w.score}</p>}
                    {w.flightId && <p className="text-xs text-muted-foreground">{championships[0].flights.find(f => f.id === w.flightId)?.name}</p>}
                  </div>
                ))}
              </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {championships.map(ch => (
                <ChampionshipCard key={ch.id} ch={ch} />
              ))}
            </div>
          </>
        )}

        <div className="text-center mt-8 text-xs text-muted-foreground">
          Powered by KharaGolf
        </div>
      </div>
    </div>
  );
}
