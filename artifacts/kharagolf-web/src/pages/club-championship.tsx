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
import { useToast } from "@/hooks/use-toast";
import { Trophy, Plus, Pencil, Trash2, Send, Eye, EyeOff, ChevronDown, ChevronRight, Award, Star } from "lucide-react";
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

interface Tournament { id: number; name: string; status: string; startDate?: string; }
interface ChampFlight { id: number; name: string; description?: string; scoreType: string; displayOrder: number; flightId?: number; flightName?: string; }
interface ChampWinner { id: number; flightId?: number; playerName: string; score?: string; notes?: string; position: number; }
interface Championship {
  id: number;
  year: number;
  title: string;
  notes?: string;
  isPublished: boolean;
  tournamentId: number;
  tournamentName?: string;
  tournamentStatus?: string;
  flights?: ChampFlight[];
  winners?: ChampWinner[];
}

function WinnersByFlight({ flights, winners }: { flights: ChampFlight[]; winners: ChampWinner[] }) {
  const ungrouped = winners.filter(w => !w.flightId);
  const grouped = flights.map(f => ({ flight: f, winners: winners.filter(w => w.flightId === f.id) }));

  return (
    <div className="space-y-3">
      {ungrouped.length > 0 && (
        <div>
          <p className="text-sm font-medium text-muted-foreground mb-1">Overall</p>
          {ungrouped.map(w => (
            <div key={w.id} className="flex items-center gap-2 text-sm">
              {w.position === 1 && <Star className="h-3 w-3 text-yellow-500 fill-yellow-500" />}
              <span className="font-medium">{w.playerName}</span>
              {w.score && <span className="text-muted-foreground">({w.score})</span>}
            </div>
          ))}
        </div>
      )}
      {grouped.map(({ flight, winners: fw }) => fw.length > 0 && (
        <div key={flight.id}>
          <p className="text-sm font-medium text-muted-foreground mb-1">{flight.name}</p>
          {fw.map(w => (
            <div key={w.id} className="flex items-center gap-2 text-sm">
              {w.position === 1 && <Star className="h-3 w-3 text-yellow-500 fill-yellow-500" />}
              <span className="font-medium">{w.playerName}</span>
              {w.score && <span className="text-muted-foreground">({w.score})</span>}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

export default function ClubChampionshipPage() {
  const orgId = useActiveOrgId();
  const { toast } = useToast();
  const qc = useQueryClient();

  const [createOpen, setCreateOpen] = useState(false);
  const [editChamp, setEditChamp] = useState<Championship | null>(null);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [flightDialogOpen, setFlightDialogOpen] = useState<number | null>(null);
  const [winnerDialogOpen, setWinnerDialogOpen] = useState<number | null>(null);
  const [editWinner, setEditWinner] = useState<ChampWinner | null>(null);
  const [editFlight, setEditFlight] = useState<ChampFlight | null>(null);

  const [form, setForm] = useState({ tournamentId: "", year: String(new Date().getFullYear()), title: "Club Championship", notes: "" });
  const [flightForm, setFlightForm] = useState({ name: "", description: "", scoreType: "net", displayOrder: "0" });
  const [winnerForm, setWinnerForm] = useState({ flightId: "", playerName: "", score: "", notes: "", position: "1" });

  const { data: championships = [], isLoading } = useQuery<Championship[]>({
    queryKey: ["club-championships", orgId],
    queryFn: () => api("GET", `/api/organizations/${orgId}/club-championships`).then(r => r.json()),
    enabled: !!orgId,
  });

  const { data: champDetail } = useQuery<Championship>({
    queryKey: ["club-championship-detail", expandedId],
    queryFn: () => api("GET", `/api/organizations/${orgId}/club-championships/${expandedId}`).then(r => r.json()),
    enabled: !!expandedId && !!orgId,
  });

  const { data: tournaments = [] } = useQuery<Tournament[]>({
    queryKey: ["tournaments-list", orgId],
    queryFn: () => api("GET", `/api/organizations/${orgId}/tournaments`).then(r => r.json()),
    enabled: !!orgId,
  });

  const createMutation = useMutation({
    mutationFn: (data: typeof form) => api("POST", `/api/organizations/${orgId}/club-championships`, data).then(r => r.json()),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["club-championships", orgId] }); setCreateOpen(false); toast({ title: "Championship created" }); },
    onError: () => toast({ title: "Error creating championship", variant: "destructive" }),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Partial<Championship> }) =>
      api("PATCH", `/api/organizations/${orgId}/club-championships/${id}`, data).then(r => r.json()),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["club-championships", orgId] }); qc.invalidateQueries({ queryKey: ["club-championship-detail", expandedId] }); setEditChamp(null); toast({ title: "Championship updated" }); },
    onError: () => toast({ title: "Error updating championship", variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => api("DELETE", `/api/organizations/${orgId}/club-championships/${id}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["club-championships", orgId] }); toast({ title: "Championship deleted" }); },
    onError: () => toast({ title: "Error deleting championship", variant: "destructive" }),
  });

  const notifyMutation = useMutation({
    mutationFn: (id: number) => api("POST", `/api/organizations/${orgId}/club-championships/${id}/notify`, {}).then(r => r.json()),
    onSuccess: (data) => toast({ title: `Notifications sent to ${data.recipientCount} recipients` }),
    onError: () => toast({ title: "Error sending notifications", variant: "destructive" }),
  });

  const createFlightMutation = useMutation({
    mutationFn: ({ id, data }: { id: number; data: typeof flightForm }) =>
      api("POST", `/api/organizations/${orgId}/club-championships/${id}/flights`, data).then(r => r.json()),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["club-championship-detail", expandedId] }); setFlightDialogOpen(null); setFlightForm({ name: "", description: "", scoreType: "net", displayOrder: "0" }); toast({ title: "Flight added" }); },
    onError: () => toast({ title: "Error adding flight", variant: "destructive" }),
  });

  const deleteFlightMutation = useMutation({
    mutationFn: ({ champId, flightId }: { champId: number; flightId: number }) =>
      api("DELETE", `/api/organizations/${orgId}/club-championships/${champId}/flights/${flightId}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["club-championship-detail", expandedId] }); toast({ title: "Flight removed" }); },
    onError: () => toast({ title: "Error removing flight", variant: "destructive" }),
  });

  const createWinnerMutation = useMutation({
    mutationFn: ({ id, data }: { id: number; data: typeof winnerForm }) =>
      api("POST", `/api/organizations/${orgId}/club-championships/${id}/winners`, data).then(r => r.json()),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["club-championship-detail", expandedId] }); setWinnerDialogOpen(null); setWinnerForm({ flightId: "", playerName: "", score: "", notes: "", position: "1" }); toast({ title: "Winner recorded" }); },
    onError: () => toast({ title: "Error recording winner", variant: "destructive" }),
  });

  const updateWinnerMutation = useMutation({
    mutationFn: ({ champId, winnerId, data }: { champId: number; winnerId: number; data: Partial<ChampWinner> }) =>
      api("PATCH", `/api/organizations/${orgId}/club-championships/${champId}/winners/${winnerId}`, data).then(r => r.json()),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["club-championship-detail", expandedId] }); setEditWinner(null); toast({ title: "Winner updated" }); },
    onError: () => toast({ title: "Error updating winner", variant: "destructive" }),
  });

  const deleteWinnerMutation = useMutation({
    mutationFn: ({ champId, winnerId }: { champId: number; winnerId: number }) =>
      api("DELETE", `/api/organizations/${orgId}/club-championships/${champId}/winners/${winnerId}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["club-championship-detail", expandedId] }); toast({ title: "Winner removed" }); },
    onError: () => toast({ title: "Error removing winner", variant: "destructive" }),
  });

  const togglePublish = (ch: Championship) => updateMutation.mutate({ id: ch.id, data: { isPublished: !ch.isPublished } });

  const detail = champDetail ?? championships.find(c => c.id === expandedId);
  const flights = detail?.flights ?? [];
  const winners = detail?.winners ?? [];

  if (!orgId) return <div className="p-8 text-muted-foreground">No active organisation selected.</div>;

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Trophy className="h-7 w-7 text-primary" />
          <div>
            <h1 className="text-2xl font-bold">Club Championships</h1>
            <p className="text-sm text-muted-foreground">Annual championship tracking & honours board management</p>
          </div>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="h-4 w-4 mr-1" /> New Championship
        </Button>
      </div>

      {isLoading ? (
        <div className="text-muted-foreground">Loading...</div>
      ) : championships.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16 text-center gap-3">
            <Trophy className="h-12 w-12 text-muted-foreground/40" />
            <p className="font-medium text-muted-foreground">No championships yet</p>
            <p className="text-sm text-muted-foreground">Create a Club Championship to start tracking annual winners.</p>
            <Button onClick={() => setCreateOpen(true)} variant="outline">
              <Plus className="h-4 w-4 mr-1" /> Create Championship
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {championships.map(ch => (
            <Collapsible key={ch.id} open={expandedId === ch.id} onOpenChange={(open) => setExpandedId(open ? ch.id : null)}>
              <Card className="overflow-hidden">
                <CollapsibleTrigger asChild>
                  <CardHeader className="cursor-pointer hover:bg-muted/30 transition-colors">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        {expandedId === ch.id ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
                        <div>
                          <CardTitle className="text-base">{ch.title} {ch.year}</CardTitle>
                          <p className="text-sm text-muted-foreground">{ch.tournamentName ?? "No tournament linked"}</p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2" onClick={e => e.stopPropagation()}>
                        <Badge variant={ch.isPublished ? "default" : "secondary"}>
                          {ch.isPublished ? "Published" : "Draft"}
                        </Badge>
                        <Button size="icon" variant="ghost" onClick={() => togglePublish(ch)} title={ch.isPublished ? "Unpublish" : "Publish to Honours Board"}>
                          {ch.isPublished ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                        </Button>
                        <Button size="icon" variant="ghost" onClick={() => { setEditChamp(ch); }}>
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button size="icon" variant="ghost" onClick={() => notifyMutation.mutate(ch.id)} disabled={notifyMutation.isPending}>
                          <Send className="h-4 w-4" />
                        </Button>
                        <Button size="icon" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => { if (confirm("Delete this championship?")) deleteMutation.mutate(ch.id); }}>
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
                          <h3 className="text-sm font-semibold">Flights / Categories</h3>
                          <Button size="sm" variant="outline" onClick={() => setFlightDialogOpen(ch.id)}>
                            <Plus className="h-3 w-3 mr-1" /> Add Flight
                          </Button>
                        </div>
                        {flights.length === 0 ? (
                          <p className="text-xs text-muted-foreground">No flights defined. Winners will be recorded for the overall championship.</p>
                        ) : (
                          <div className="space-y-1">
                            {flights.map(f => (
                              <div key={f.id} className="flex items-center justify-between text-sm p-2 bg-muted/30 rounded">
                                <div>
                                  <span className="font-medium">{f.name}</span>
                                  <span className="text-xs text-muted-foreground ml-2">({f.scoreType})</span>
                                </div>
                                <Button size="icon" variant="ghost" className="h-6 w-6 text-destructive" onClick={() => deleteFlightMutation.mutate({ champId: ch.id, flightId: f.id })}>
                                  <Trash2 className="h-3 w-3" />
                                </Button>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                      <div>
                        <div className="flex items-center justify-between mb-2">
                          <h3 className="text-sm font-semibold">Winners</h3>
                          <Button size="sm" variant="outline" onClick={() => setWinnerDialogOpen(ch.id)}>
                            <Plus className="h-3 w-3 mr-1" /> Add Winner
                          </Button>
                        </div>
                        {winners.length === 0 ? (
                          <p className="text-xs text-muted-foreground">No winners recorded yet.</p>
                        ) : (
                          <div className="space-y-1">
                            {winners.map(w => (
                              <div key={w.id} className="flex items-center justify-between text-sm p-2 bg-muted/30 rounded">
                                <div className="flex items-center gap-1.5">
                                  {w.position === 1 && <Award className="h-3 w-3 text-yellow-500" />}
                                  <span className="font-medium">{w.playerName}</span>
                                  {w.score && <span className="text-xs text-muted-foreground">({w.score})</span>}
                                  {w.flightId && <span className="text-xs text-muted-foreground">· {flights.find(f => f.id === w.flightId)?.name}</span>}
                                </div>
                                <div className="flex gap-1">
                                  <Button size="icon" variant="ghost" className="h-6 w-6" onClick={() => setEditWinner(w)}>
                                    <Pencil className="h-3 w-3" />
                                  </Button>
                                  <Button size="icon" variant="ghost" className="h-6 w-6 text-destructive" onClick={() => deleteWinnerMutation.mutate({ champId: ch.id, winnerId: w.id })}>
                                    <Trash2 className="h-3 w-3" />
                                  </Button>
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                    {ch.notes && <p className="text-sm text-muted-foreground">{ch.notes}</p>}
                  </CardContent>
                </CollapsibleContent>
              </Card>
            </Collapsible>
          ))}
        </div>
      )}

      {/* Create Championship Dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>New Club Championship</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Year</Label>
              <Input type="number" value={form.year} onChange={e => setForm(f => ({ ...f, year: e.target.value }))} />
            </div>
            <div>
              <Label>Title</Label>
              <Input value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} />
            </div>
            <div>
              <Label>Tournament</Label>
              <Select value={form.tournamentId} onValueChange={v => setForm(f => ({ ...f, tournamentId: v }))}>
                <SelectTrigger><SelectValue placeholder="Select tournament" /></SelectTrigger>
                <SelectContent>
                  {tournaments.map(t => <SelectItem key={t.id} value={String(t.id)}>{t.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Notes (optional)</Label>
              <Textarea value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} rows={2} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button onClick={() => createMutation.mutate(form)} disabled={createMutation.isPending || !form.tournamentId}>Create</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Championship Dialog */}
      {editChamp && (
        <Dialog open={!!editChamp} onOpenChange={() => setEditChamp(null)}>
          <DialogContent>
            <DialogHeader><DialogTitle>Edit Championship</DialogTitle></DialogHeader>
            <div className="space-y-3">
              <div>
                <Label>Title</Label>
                <Input value={editChamp.title} onChange={e => setEditChamp(c => c ? ({ ...c, title: e.target.value }) : c)} />
              </div>
              <div>
                <Label>Notes</Label>
                <Textarea value={editChamp.notes ?? ""} onChange={e => setEditChamp(c => c ? ({ ...c, notes: e.target.value }) : c)} rows={2} />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setEditChamp(null)}>Cancel</Button>
              <Button onClick={() => updateMutation.mutate({ id: editChamp.id, data: { title: editChamp.title, notes: editChamp.notes } })} disabled={updateMutation.isPending}>Save</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {/* Add Flight Dialog */}
      <Dialog open={!!flightDialogOpen} onOpenChange={() => setFlightDialogOpen(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Add Flight / Category</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Name (e.g. Men's Open, Ladies, Seniors)</Label>
              <Input value={flightForm.name} onChange={e => setFlightForm(f => ({ ...f, name: e.target.value }))} />
            </div>
            <div>
              <Label>Score Type</Label>
              <Select value={flightForm.scoreType} onValueChange={v => setFlightForm(f => ({ ...f, scoreType: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="net">Net</SelectItem>
                  <SelectItem value="gross">Gross</SelectItem>
                  <SelectItem value="stableford">Stableford</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Description (optional)</Label>
              <Input value={flightForm.description} onChange={e => setFlightForm(f => ({ ...f, description: e.target.value }))} />
            </div>
            <div>
              <Label>Display Order</Label>
              <Input type="number" value={flightForm.displayOrder} onChange={e => setFlightForm(f => ({ ...f, displayOrder: e.target.value }))} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setFlightDialogOpen(null)}>Cancel</Button>
            <Button
              onClick={() => flightDialogOpen && createFlightMutation.mutate({ id: flightDialogOpen, data: flightForm })}
              disabled={createFlightMutation.isPending || !flightForm.name}
            >Add Flight</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add Winner Dialog */}
      <Dialog open={!!winnerDialogOpen} onOpenChange={() => setWinnerDialogOpen(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Record Winner</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Player Name</Label>
              <Input value={winnerForm.playerName} onChange={e => setWinnerForm(f => ({ ...f, playerName: e.target.value }))} />
            </div>
            <div>
              <Label>Flight (optional)</Label>
              <Select value={winnerForm.flightId || "_empty"} onValueChange={v => setWinnerForm(f => ({ ...f, flightId: v === "_empty" ? "" : v }))}>
                <SelectTrigger><SelectValue placeholder="Overall / no flight" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="_empty">Overall</SelectItem>
                  {flights.map(f => <SelectItem key={f.id} value={String(f.id)}>{f.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Score (optional)</Label>
              <Input value={winnerForm.score} onChange={e => setWinnerForm(f => ({ ...f, score: e.target.value }))} placeholder="e.g. 68 net, 36 pts" />
            </div>
            <div>
              <Label>Position</Label>
              <Input type="number" value={winnerForm.position} onChange={e => setWinnerForm(f => ({ ...f, position: e.target.value }))} min={1} />
            </div>
            <div>
              <Label>Notes (optional)</Label>
              <Input value={winnerForm.notes} onChange={e => setWinnerForm(f => ({ ...f, notes: e.target.value }))} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setWinnerDialogOpen(null)}>Cancel</Button>
            <Button
              onClick={() => winnerDialogOpen && createWinnerMutation.mutate({ id: winnerDialogOpen, data: winnerForm })}
              disabled={createWinnerMutation.isPending || !winnerForm.playerName}
            >Record Winner</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Winner Dialog */}
      {editWinner && expandedId && (
        <Dialog open={!!editWinner} onOpenChange={() => setEditWinner(null)}>
          <DialogContent>
            <DialogHeader><DialogTitle>Edit Winner</DialogTitle></DialogHeader>
            <div className="space-y-3">
              <div>
                <Label>Player Name</Label>
                <Input value={editWinner.playerName} onChange={e => setEditWinner(w => w ? { ...w, playerName: e.target.value } : w)} />
              </div>
              <div>
                <Label>Score (optional)</Label>
                <Input value={editWinner.score ?? ""} onChange={e => setEditWinner(w => w ? { ...w, score: e.target.value } : w)} />
              </div>
              <div>
                <Label>Position</Label>
                <Input type="number" value={editWinner.position} onChange={e => setEditWinner(w => w ? { ...w, position: parseInt(e.target.value) } : w)} min={1} />
              </div>
              <div>
                <Label>Notes (optional)</Label>
                <Input value={editWinner.notes ?? ""} onChange={e => setEditWinner(w => w ? { ...w, notes: e.target.value } : w)} />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setEditWinner(null)}>Cancel</Button>
              <Button onClick={() => updateWinnerMutation.mutate({ champId: expandedId, winnerId: editWinner.id, data: editWinner })} disabled={updateWinnerMutation.isPending}>Save</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
