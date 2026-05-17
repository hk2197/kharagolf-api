import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useActiveOrgId } from "@/context/ActiveOrgContext";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import { Handshake, Plus, Pencil, Trash2, Send, ChevronDown, ChevronRight, Users, BarChart3 } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";

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

interface Season { id: number; name: string; year: number; description?: string; status: string; }
interface Fixture {
  id: number; opponentName: string; opponentClub?: string;
  fixtureDate?: string; venue?: string; isHome: boolean; format: string;
  status: string; homePoints?: string; awayPoints?: string; result?: string; notes?: string;
  seasonId?: number; roster?: RosterEntry[]; matches?: IndividualMatch[];
}
interface RosterEntry { id: number; side: string; playerName: string; handicapIndex?: string; position: number; }
interface IndividualMatch {
  id: number; matchNumber: number; homePlayerName: string; awayPlayerName: string;
  result: string; homePoints?: string; awayPoints?: string; holesPlayed?: number; notes?: string;
}
interface Standings {
  fixtures: Fixture[];
  opponents: { opponent: string; played: number; won: number; drawn: number; lost: number; pts: number }[];
  summary: { played: number; won: number; drawn: number; lost: number };
}

const STATUS_COLORS: Record<string, string> = {
  scheduled: "secondary",
  in_progress: "default",
  completed: "default",
  cancelled: "destructive",
};

const RESULT_LABELS: Record<string, string> = {
  pending: "Pending",
  home_win: "Home Win",
  away_win: "Away Win",
  halved: "Halved",
};

export default function InterclubPage() {
  const orgId = useActiveOrgId();
  const { toast } = useToast();
  const qc = useQueryClient();

  const [activeTab, setActiveTab] = useState("fixtures");
  const [selectedSeason, setSelectedSeason] = useState<string>("all");
  const [seasonDialogOpen, setSeasonDialogOpen] = useState(false);
  const [fixtureDialogOpen, setFixtureDialogOpen] = useState(false);
  const [editFixture, setEditFixture] = useState<Fixture | null>(null);
  const [expandedFixture, setExpandedFixture] = useState<number | null>(null);
  const [rosterDialogOpen, setRosterDialogOpen] = useState<number | null>(null);
  const [matchDialogOpen, setMatchDialogOpen] = useState<number | null>(null);
  const [editMatch, setEditMatch] = useState<IndividualMatch | null>(null);

  const [seasonForm, setSeasonForm] = useState({ name: "", year: String(new Date().getFullYear()), description: "" });
  const [fixtureForm, setFixtureForm] = useState({ opponentName: "", opponentClub: "", fixtureDate: "", venue: "", isHome: "true", format: "matchplay", seasonId: "", notes: "" });
  const [rosterForm, setRosterForm] = useState({ side: "home", playerName: "", handicapIndex: "", position: "0" });
  const [matchForm, setMatchForm] = useState({ matchNumber: "1", homePlayerName: "", awayPlayerName: "", result: "pending", homePoints: "", awayPoints: "", holesPlayed: "", notes: "" });
  const [scoreForm, setScoreForm] = useState({ homePoints: "", awayPoints: "", result: "", status: "completed" });
  const [scoreDialogOpen, setScoreDialogOpen] = useState<number | null>(null);

  const { data: seasons = [] } = useQuery<Season[]>({
    queryKey: ["interclub-seasons", orgId],
    queryFn: () => api("GET", `/api/organizations/${orgId}/interclub/seasons`).then(r => r.json()),
    enabled: !!orgId,
  });

  const { data: fixtures = [], isLoading } = useQuery<Fixture[]>({
    queryKey: ["interclub-fixtures", orgId, selectedSeason],
    queryFn: () => {
      const params = selectedSeason !== "all" ? `?seasonId=${selectedSeason}` : "";
      return api("GET", `/api/organizations/${orgId}/interclub/fixtures${params}`).then(r => r.json());
    },
    enabled: !!orgId,
  });

  const { data: fixtureDetail } = useQuery<Fixture>({
    queryKey: ["interclub-fixture-detail", expandedFixture],
    queryFn: () => api("GET", `/api/organizations/${orgId}/interclub/fixtures/${expandedFixture}`).then(r => r.json()),
    enabled: !!expandedFixture && !!orgId,
  });

  const { data: standings } = useQuery<Standings>({
    queryKey: ["interclub-standings", orgId, selectedSeason],
    queryFn: () => api("GET", `/api/organizations/${orgId}/interclub/seasons/${selectedSeason}/standings`).then(r => r.json()),
    enabled: !!orgId && selectedSeason !== "all",
  });

  const createSeasonMutation = useMutation({
    mutationFn: (data: typeof seasonForm) => api("POST", `/api/organizations/${orgId}/interclub/seasons`, data).then(r => r.json()),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["interclub-seasons", orgId] }); setSeasonDialogOpen(false); toast({ title: "Season created" }); },
    onError: () => toast({ title: "Error creating season", variant: "destructive" }),
  });

  const createFixtureMutation = useMutation({
    mutationFn: (data: typeof fixtureForm) => api("POST", `/api/organizations/${orgId}/interclub/fixtures`, { ...data, isHome: data.isHome === "true" }).then(r => r.json()),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["interclub-fixtures", orgId, selectedSeason] }); setFixtureDialogOpen(false); toast({ title: "Fixture created" }); },
    onError: () => toast({ title: "Error creating fixture", variant: "destructive" }),
  });

  const updateFixtureMutation = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Partial<Fixture> }) =>
      api("PATCH", `/api/organizations/${orgId}/interclub/fixtures/${id}`, data).then(r => r.json()),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["interclub-fixtures", orgId, selectedSeason] }); qc.invalidateQueries({ queryKey: ["interclub-fixture-detail", expandedFixture] }); setScoreDialogOpen(null); setEditFixture(null); toast({ title: "Fixture updated" }); },
    onError: () => toast({ title: "Error updating fixture", variant: "destructive" }),
  });

  const deleteFixtureMutation = useMutation({
    mutationFn: (id: number) => api("DELETE", `/api/organizations/${orgId}/interclub/fixtures/${id}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["interclub-fixtures", orgId, selectedSeason] }); toast({ title: "Fixture deleted" }); },
    onError: () => toast({ title: "Error deleting fixture", variant: "destructive" }),
  });

  const createRosterMutation = useMutation({
    mutationFn: ({ fixtureId, data }: { fixtureId: number; data: typeof rosterForm }) =>
      api("POST", `/api/organizations/${orgId}/interclub/fixtures/${fixtureId}/roster`, data).then(r => r.json()),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["interclub-fixture-detail", expandedFixture] }); setRosterDialogOpen(null); setRosterForm({ side: "home", playerName: "", handicapIndex: "", position: "0" }); toast({ title: "Player added to roster" }); },
    onError: () => toast({ title: "Error adding to roster", variant: "destructive" }),
  });

  const deleteRosterMutation = useMutation({
    mutationFn: ({ fixtureId, rosterId }: { fixtureId: number; rosterId: number }) =>
      api("DELETE", `/api/organizations/${orgId}/interclub/fixtures/${fixtureId}/roster/${rosterId}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["interclub-fixture-detail", expandedFixture] }); toast({ title: "Player removed" }); },
    onError: () => toast({ title: "Error removing player", variant: "destructive" }),
  });

  const createMatchMutation = useMutation({
    mutationFn: ({ fixtureId, data }: { fixtureId: number; data: typeof matchForm }) =>
      api("POST", `/api/organizations/${orgId}/interclub/fixtures/${fixtureId}/matches`, data).then(r => r.json()),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["interclub-fixture-detail", expandedFixture] }); setMatchDialogOpen(null); setMatchForm({ matchNumber: "1", homePlayerName: "", awayPlayerName: "", result: "pending", homePoints: "", awayPoints: "", holesPlayed: "", notes: "" }); toast({ title: "Match result added" }); },
    onError: () => toast({ title: "Error adding match result", variant: "destructive" }),
  });

  const updateMatchMutation = useMutation({
    mutationFn: ({ fixtureId, matchId, data }: { fixtureId: number; matchId: number; data: Partial<IndividualMatch> }) =>
      api("PATCH", `/api/organizations/${orgId}/interclub/fixtures/${fixtureId}/matches/${matchId}`, data).then(r => r.json()),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["interclub-fixture-detail", expandedFixture] }); setEditMatch(null); toast({ title: "Match updated" }); },
    onError: () => toast({ title: "Error updating match", variant: "destructive" }),
  });

  const deleteMatchMutation = useMutation({
    mutationFn: ({ fixtureId, matchId }: { fixtureId: number; matchId: number }) =>
      api("DELETE", `/api/organizations/${orgId}/interclub/fixtures/${fixtureId}/matches/${matchId}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["interclub-fixture-detail", expandedFixture] }); toast({ title: "Match deleted" }); },
    onError: () => toast({ title: "Error deleting match", variant: "destructive" }),
  });

  const notifyMutation = useMutation({
    mutationFn: (fixtureId: number) => api("POST", `/api/organizations/${orgId}/interclub/fixtures/${fixtureId}/notify`, {}).then(r => r.json()),
    onSuccess: (data) => toast({ title: `Notifications sent to ${data.recipientCount} members` }),
    onError: () => toast({ title: "Error sending notifications", variant: "destructive" }),
  });

  const detail = fixtureDetail ?? fixtures.find(f => f.id === expandedFixture);
  const roster = detail?.roster ?? [];
  const matches = detail?.matches ?? [];

  const homeRoster = roster.filter(r => r.side === "home");
  const awayRoster = roster.filter(r => r.side === "away");

  if (!orgId) return <div className="p-8 text-muted-foreground">No active organisation selected.</div>;

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Handshake className="h-7 w-7 text-primary" />
          <div>
            <h1 className="text-2xl font-bold">Interclub Competitions</h1>
            <p className="text-sm text-muted-foreground">Fixtures, rosters, match results & season standings</p>
          </div>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => setSeasonDialogOpen(true)}>
            <Plus className="h-4 w-4 mr-1" /> New Season
          </Button>
          <Button onClick={() => setFixtureDialogOpen(true)}>
            <Plus className="h-4 w-4 mr-1" /> New Fixture
          </Button>
        </div>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="fixtures">Fixtures</TabsTrigger>
          <TabsTrigger value="standings" disabled={selectedSeason === "all"}>Season Standings</TabsTrigger>
        </TabsList>

        <div className="flex items-center gap-3 mt-3 mb-1">
          <Label className="shrink-0">Filter by Season</Label>
          <Select value={selectedSeason} onValueChange={setSelectedSeason}>
            <SelectTrigger className="w-48"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All fixtures</SelectItem>
              {seasons.map(s => <SelectItem key={s.id} value={String(s.id)}>{s.name} ({s.year})</SelectItem>)}
            </SelectContent>
          </Select>
        </div>

        <TabsContent value="fixtures" className="space-y-3 mt-3">
          {isLoading ? (
            <div className="text-muted-foreground">Loading...</div>
          ) : fixtures.length === 0 ? (
            <Card>
              <CardContent className="flex flex-col items-center justify-center py-16 text-center gap-3">
                <Handshake className="h-12 w-12 text-muted-foreground/40" />
                <p className="font-medium text-muted-foreground">No fixtures yet</p>
                <Button onClick={() => setFixtureDialogOpen(true)} variant="outline">
                  <Plus className="h-4 w-4 mr-1" /> Create First Fixture
                </Button>
              </CardContent>
            </Card>
          ) : (
            fixtures.map(fx => (
              <Collapsible key={fx.id} open={expandedFixture === fx.id} onOpenChange={(open) => setExpandedFixture(open ? fx.id : null)}>
                <Card className="overflow-hidden">
                  <CollapsibleTrigger asChild>
                    <CardHeader className="cursor-pointer hover:bg-muted/30 transition-colors py-3">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          {expandedFixture === fx.id ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
                          <div>
                            <div className="flex items-center gap-2">
                              <span className="font-semibold">vs {fx.opponentName}</span>
                              <Badge variant="outline" className="text-xs">{fx.isHome ? "Home" : "Away"}</Badge>
                              <Badge variant={STATUS_COLORS[fx.status] as any ?? "secondary"} className="text-xs">{fx.status}</Badge>
                            </div>
                            <p className="text-xs text-muted-foreground mt-0.5">
                              {fx.fixtureDate ? new Date(fx.fixtureDate).toLocaleDateString() : "Date TBC"}
                              {fx.venue ? ` · ${fx.venue}` : ""}
                              {fx.format ? ` · ${fx.format}` : ""}
                            </p>
                          </div>
                        </div>
                        <div className="flex items-center gap-2" onClick={e => e.stopPropagation()}>
                          {fx.status === "completed" && fx.homePoints !== null && (
                            <span className="font-bold text-sm">{fx.homePoints} – {fx.awayPoints}</span>
                          )}
                          <Button size="icon" variant="ghost" onClick={() => { setScoreDialogOpen(fx.id); setScoreForm({ homePoints: fx.homePoints ?? "", awayPoints: fx.awayPoints ?? "", result: fx.result ?? "", status: fx.status }); }}>
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button size="icon" variant="ghost" onClick={() => notifyMutation.mutate(fx.id)} disabled={notifyMutation.isPending}>
                            <Send className="h-4 w-4" />
                          </Button>
                          <Button size="icon" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => { if (confirm("Delete this fixture?")) deleteFixtureMutation.mutate(fx.id); }}>
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </div>
                    </CardHeader>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <CardContent className="border-t pt-4 space-y-4">
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div>
                          <div className="flex items-center justify-between mb-2">
                            <h3 className="text-sm font-semibold flex items-center gap-1"><Users className="h-4 w-4" /> Roster</h3>
                            <Button size="sm" variant="outline" onClick={() => setRosterDialogOpen(fx.id)}>
                              <Plus className="h-3 w-3 mr-1" /> Add Player
                            </Button>
                          </div>
                          <div className="grid grid-cols-2 gap-2">
                            <div>
                              <p className="text-xs font-medium text-muted-foreground mb-1">Home</p>
                              {homeRoster.map(r => (
                                <div key={r.id} className="flex items-center justify-between text-xs p-1.5 bg-muted/30 rounded mb-1">
                                  <span>{r.playerName}{r.handicapIndex ? ` (${r.handicapIndex})` : ""}</span>
                                  <Button size="icon" variant="ghost" className="h-5 w-5 text-destructive" onClick={() => deleteRosterMutation.mutate({ fixtureId: fx.id, rosterId: r.id })}>
                                    <Trash2 className="h-3 w-3" />
                                  </Button>
                                </div>
                              ))}
                              {homeRoster.length === 0 && <p className="text-xs text-muted-foreground italic">None</p>}
                            </div>
                            <div>
                              <p className="text-xs font-medium text-muted-foreground mb-1">Away</p>
                              {awayRoster.map(r => (
                                <div key={r.id} className="flex items-center justify-between text-xs p-1.5 bg-muted/30 rounded mb-1">
                                  <span>{r.playerName}{r.handicapIndex ? ` (${r.handicapIndex})` : ""}</span>
                                  <Button size="icon" variant="ghost" className="h-5 w-5 text-destructive" onClick={() => deleteRosterMutation.mutate({ fixtureId: fx.id, rosterId: r.id })}>
                                    <Trash2 className="h-3 w-3" />
                                  </Button>
                                </div>
                              ))}
                              {awayRoster.length === 0 && <p className="text-xs text-muted-foreground italic">None</p>}
                            </div>
                          </div>
                        </div>
                        <div>
                          <div className="flex items-center justify-between mb-2">
                            <h3 className="text-sm font-semibold">Individual Matches</h3>
                            <Button size="sm" variant="outline" onClick={() => setMatchDialogOpen(fx.id)}>
                              <Plus className="h-3 w-3 mr-1" /> Add Match
                            </Button>
                          </div>
                          {matches.length === 0 ? (
                            <p className="text-xs text-muted-foreground italic">No match results yet</p>
                          ) : (
                            <div className="space-y-1">
                              {matches.map(m => (
                                <div key={m.id} className="flex items-center justify-between text-xs p-2 bg-muted/30 rounded">
                                  <div>
                                    <span className="font-medium">{m.homePlayerName}</span>
                                    <span className="text-muted-foreground"> vs </span>
                                    <span className="font-medium">{m.awayPlayerName}</span>
                                    <span className="ml-2 text-muted-foreground">
                                      {m.result !== "pending" ? (
                                        m.homePoints !== null ? `${m.homePoints}–${m.awayPoints}` : m.result
                                      ) : "Pending"}
                                    </span>
                                  </div>
                                  <div className="flex gap-1">
                                    <Button size="icon" variant="ghost" className="h-5 w-5" onClick={() => setEditMatch(m)}>
                                      <Pencil className="h-3 w-3" />
                                    </Button>
                                    <Button size="icon" variant="ghost" className="h-5 w-5 text-destructive" onClick={() => deleteMatchMutation.mutate({ fixtureId: fx.id, matchId: m.id })}>
                                      <Trash2 className="h-3 w-3" />
                                    </Button>
                                  </div>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    </CardContent>
                  </CollapsibleContent>
                </Card>
              </Collapsible>
            ))
          )}
        </TabsContent>

        <TabsContent value="standings" className="mt-3">
          {!standings ? (
            <div className="text-muted-foreground">Select a season to view standings.</div>
          ) : (
            <div className="space-y-4">
              <Card>
                <CardHeader><CardTitle className="text-base flex items-center gap-2"><BarChart3 className="h-4 w-4" /> Season Summary</CardTitle></CardHeader>
                <CardContent>
                  <div className="grid grid-cols-4 gap-3 text-center">
                    {[["Played", standings.summary.played], ["Won", standings.summary.won], ["Drawn", standings.summary.drawn], ["Lost", standings.summary.lost]].map(([label, val]) => (
                      <div key={label} className="bg-muted/30 rounded p-3">
                        <div className="text-2xl font-bold">{val}</div>
                        <div className="text-xs text-muted-foreground">{label}</div>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
              <Card>
                <CardHeader><CardTitle className="text-base">Fixtures</CardTitle></CardHeader>
                <CardContent>
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-left text-muted-foreground text-xs">
                        <th className="pb-2">Opponent</th>
                        <th className="pb-2">Date</th>
                        <th className="pb-2">Venue</th>
                        <th className="pb-2">Score</th>
                        <th className="pb-2">Result</th>
                      </tr>
                    </thead>
                    <tbody>
                      {standings.fixtures.map(f => (
                        <tr key={f.id} className="border-b last:border-b-0">
                          <td className="py-2 font-medium">{f.opponentName}{f.isHome ? " (H)" : " (A)"}</td>
                          <td className="py-2 text-muted-foreground">{f.fixtureDate ? new Date(f.fixtureDate).toLocaleDateString() : "TBC"}</td>
                          <td className="py-2 text-muted-foreground">{f.venue ?? "–"}</td>
                          <td className="py-2">{f.homePoints !== null && f.awayPoints !== null ? `${f.homePoints}–${f.awayPoints}` : "–"}</td>
                          <td className="py-2">
                            <Badge variant={f.status !== "completed" ? "secondary" : (parseFloat(f.homePoints ?? "0") > parseFloat(f.awayPoints ?? "0") ? "default" : "destructive")}>
                              {f.status !== "completed" ? f.status : (parseFloat(f.homePoints ?? "0") > parseFloat(f.awayPoints ?? "0") ? "W" : parseFloat(f.homePoints ?? "0") < parseFloat(f.awayPoints ?? "0") ? "L" : "D")}
                            </Badge>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </CardContent>
              </Card>
            </div>
          )}
        </TabsContent>
      </Tabs>

      {/* Season Dialog */}
      <Dialog open={seasonDialogOpen} onOpenChange={setSeasonDialogOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>New Interclub Season</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div><Label>Name</Label><Input value={seasonForm.name} onChange={e => setSeasonForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Connacht League 2026" /></div>
            <div><Label>Year</Label><Input type="number" value={seasonForm.year} onChange={e => setSeasonForm(f => ({ ...f, year: e.target.value }))} /></div>
            <div><Label>Description (optional)</Label><Textarea value={seasonForm.description} onChange={e => setSeasonForm(f => ({ ...f, description: e.target.value }))} rows={2} /></div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSeasonDialogOpen(false)}>Cancel</Button>
            <Button onClick={() => createSeasonMutation.mutate(seasonForm)} disabled={createSeasonMutation.isPending || !seasonForm.name}>Create</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Fixture Dialog */}
      <Dialog open={fixtureDialogOpen} onOpenChange={setFixtureDialogOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>New Interclub Fixture</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div><Label>Opponent Name</Label><Input value={fixtureForm.opponentName} onChange={e => setFixtureForm(f => ({ ...f, opponentName: e.target.value }))} placeholder="e.g. Galway Golf Club" /></div>
            <div><Label>Opponent Club (optional)</Label><Input value={fixtureForm.opponentClub} onChange={e => setFixtureForm(f => ({ ...f, opponentClub: e.target.value }))} /></div>
            <div className="grid grid-cols-2 gap-3">
              <div><Label>Date</Label><Input type="datetime-local" value={fixtureForm.fixtureDate} onChange={e => setFixtureForm(f => ({ ...f, fixtureDate: e.target.value }))} /></div>
              <div>
                <Label>Home / Away</Label>
                <Select value={fixtureForm.isHome} onValueChange={v => setFixtureForm(f => ({ ...f, isHome: v }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="true">Home</SelectItem>
                    <SelectItem value="false">Away</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div><Label>Venue</Label><Input value={fixtureForm.venue} onChange={e => setFixtureForm(f => ({ ...f, venue: e.target.value }))} /></div>
              <div>
                <Label>Format</Label>
                <Select value={fixtureForm.format} onValueChange={v => setFixtureForm(f => ({ ...f, format: v }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="matchplay">Match Play</SelectItem>
                    <SelectItem value="strokeplay">Stroke Play</SelectItem>
                    <SelectItem value="foursomes">Foursomes</SelectItem>
                    <SelectItem value="greensomes">Greensomes</SelectItem>
                    <SelectItem value="mixed">Mixed</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div>
              <Label>Season (optional)</Label>
              <Select value={fixtureForm.seasonId || "_empty"} onValueChange={v => setFixtureForm(f => ({ ...f, seasonId: v === "_empty" ? "" : v }))}>
                <SelectTrigger><SelectValue placeholder="No season" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="_empty">No season</SelectItem>
                  {seasons.map(s => <SelectItem key={s.id} value={String(s.id)}>{s.name} ({s.year})</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div><Label>Notes (optional)</Label><Textarea value={fixtureForm.notes} onChange={e => setFixtureForm(f => ({ ...f, notes: e.target.value }))} rows={2} /></div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setFixtureDialogOpen(false)}>Cancel</Button>
            <Button onClick={() => createFixtureMutation.mutate(fixtureForm)} disabled={createFixtureMutation.isPending || !fixtureForm.opponentName}>Create</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Score / Status Update Dialog */}
      {scoreDialogOpen && (
        <Dialog open={!!scoreDialogOpen} onOpenChange={() => setScoreDialogOpen(null)}>
          <DialogContent>
            <DialogHeader><DialogTitle>Update Fixture Result</DialogTitle></DialogHeader>
            <div className="space-y-3">
              <div>
                <Label>Status</Label>
                <Select value={scoreForm.status} onValueChange={v => setScoreForm(f => ({ ...f, status: v }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="scheduled">Scheduled</SelectItem>
                    <SelectItem value="in_progress">In Progress</SelectItem>
                    <SelectItem value="completed">Completed</SelectItem>
                    <SelectItem value="cancelled">Cancelled</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div><Label>Home Points</Label><Input type="number" step="0.5" value={scoreForm.homePoints} onChange={e => setScoreForm(f => ({ ...f, homePoints: e.target.value }))} /></div>
                <div><Label>Away Points</Label><Input type="number" step="0.5" value={scoreForm.awayPoints} onChange={e => setScoreForm(f => ({ ...f, awayPoints: e.target.value }))} /></div>
              </div>
              <div><Label>Result Summary (optional)</Label><Input value={scoreForm.result} onChange={e => setScoreForm(f => ({ ...f, result: e.target.value }))} placeholder="e.g. Home win 5.5–2.5" /></div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setScoreDialogOpen(null)}>Cancel</Button>
              <Button onClick={() => updateFixtureMutation.mutate({ id: scoreDialogOpen!, data: { homePoints: scoreForm.homePoints || undefined, awayPoints: scoreForm.awayPoints || undefined, result: scoreForm.result || undefined, status: scoreForm.status } })} disabled={updateFixtureMutation.isPending}>Save Result</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {/* Roster Dialog */}
      <Dialog open={!!rosterDialogOpen} onOpenChange={() => setRosterDialogOpen(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Add Player to Roster</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Side</Label>
              <Select value={rosterForm.side} onValueChange={v => setRosterForm(f => ({ ...f, side: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="home">Home</SelectItem>
                  <SelectItem value="away">Away</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div><Label>Player Name</Label><Input value={rosterForm.playerName} onChange={e => setRosterForm(f => ({ ...f, playerName: e.target.value }))} /></div>
            <div><Label>Handicap Index (optional)</Label><Input type="number" step="0.1" value={rosterForm.handicapIndex} onChange={e => setRosterForm(f => ({ ...f, handicapIndex: e.target.value }))} /></div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRosterDialogOpen(null)}>Cancel</Button>
            <Button onClick={() => rosterDialogOpen && createRosterMutation.mutate({ fixtureId: rosterDialogOpen, data: rosterForm })} disabled={createRosterMutation.isPending || !rosterForm.playerName}>Add</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Match Result Dialog */}
      <Dialog open={!!matchDialogOpen} onOpenChange={() => setMatchDialogOpen(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Add Individual Match</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div><Label>Home Player</Label><Input value={matchForm.homePlayerName} onChange={e => setMatchForm(f => ({ ...f, homePlayerName: e.target.value }))} /></div>
              <div><Label>Away Player</Label><Input value={matchForm.awayPlayerName} onChange={e => setMatchForm(f => ({ ...f, awayPlayerName: e.target.value }))} /></div>
            </div>
            <div>
              <Label>Result</Label>
              <Select value={matchForm.result} onValueChange={v => setMatchForm(f => ({ ...f, result: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="pending">Pending</SelectItem>
                  <SelectItem value="home_win">Home Win</SelectItem>
                  <SelectItem value="away_win">Away Win</SelectItem>
                  <SelectItem value="halved">Halved</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div><Label>Home Points</Label><Input type="number" step="0.5" value={matchForm.homePoints} onChange={e => setMatchForm(f => ({ ...f, homePoints: e.target.value }))} /></div>
              <div><Label>Away Points</Label><Input type="number" step="0.5" value={matchForm.awayPoints} onChange={e => setMatchForm(f => ({ ...f, awayPoints: e.target.value }))} /></div>
            </div>
            <div><Label>Holes Played (optional)</Label><Input type="number" value={matchForm.holesPlayed} onChange={e => setMatchForm(f => ({ ...f, holesPlayed: e.target.value }))} /></div>
            <div><Label>Notes (optional)</Label><Input value={matchForm.notes} onChange={e => setMatchForm(f => ({ ...f, notes: e.target.value }))} /></div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setMatchDialogOpen(null)}>Cancel</Button>
            <Button onClick={() => matchDialogOpen && createMatchMutation.mutate({ fixtureId: matchDialogOpen, data: matchForm })} disabled={createMatchMutation.isPending || !matchForm.homePlayerName || !matchForm.awayPlayerName}>Add Match</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Match Dialog */}
      {editMatch && expandedFixture && (
        <Dialog open={!!editMatch} onOpenChange={() => setEditMatch(null)}>
          <DialogContent>
            <DialogHeader><DialogTitle>Edit Match Result</DialogTitle></DialogHeader>
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div><Label>Home Player</Label><Input value={editMatch.homePlayerName} onChange={e => setEditMatch(m => m ? { ...m, homePlayerName: e.target.value } : m)} /></div>
                <div><Label>Away Player</Label><Input value={editMatch.awayPlayerName} onChange={e => setEditMatch(m => m ? { ...m, awayPlayerName: e.target.value } : m)} /></div>
              </div>
              <div>
                <Label>Result</Label>
                <Select value={editMatch.result} onValueChange={v => setEditMatch(m => m ? { ...m, result: v } : m)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="pending">Pending</SelectItem>
                    <SelectItem value="home_win">Home Win</SelectItem>
                    <SelectItem value="away_win">Away Win</SelectItem>
                    <SelectItem value="halved">Halved</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div><Label>Home Points</Label><Input type="number" step="0.5" value={editMatch.homePoints ?? ""} onChange={e => setEditMatch(m => m ? { ...m, homePoints: e.target.value } : m)} /></div>
                <div><Label>Away Points</Label><Input type="number" step="0.5" value={editMatch.awayPoints ?? ""} onChange={e => setEditMatch(m => m ? { ...m, awayPoints: e.target.value } : m)} /></div>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setEditMatch(null)}>Cancel</Button>
              <Button onClick={() => updateMatchMutation.mutate({ fixtureId: expandedFixture, matchId: editMatch.id, data: editMatch })} disabled={updateMatchMutation.isPending}>Save</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
