import { useState, useEffect } from "react";
import { useActiveOrgId } from "@/context/ActiveOrgContext";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { Tv, QrCode, Copy, Trash2, Plus, RefreshCw, ExternalLink, Settings2, ChevronUp, ChevronDown } from "lucide-react";

interface DisplayCode {
  id: number;
  code: string;
  organizationId: number;
  tournamentId: number | null;
  label: string | null;
  expiresAt: string | null;
  createdAt: string;
}

interface DisplaySettings {
  organizationId?: number;
  activeTournamentIds: number[];
  rotationSequence: string[];
  rotationIntervalSeconds: number;
  sponsorSlideDurationSeconds: number;
  showSponsorSlides: boolean;
  showSideGames: boolean;
  showTracker: boolean;
}

interface Tournament { id: number; name: string; status: string; }

const SEQUENCE_OPTIONS = [
  { id: "leaderboard", label: "Leaderboard", description: "Overall standings" },
  { id: "tracker", label: "Score Tracker", description: "Hole-by-hole grid" },
  { id: "sidegames", label: "Side Games", description: "Skins, CTP, LD results" },
  { id: "sponsor", label: "Sponsor Slides", description: "Sponsor branding" },
];

export default function DisplaySettingsPage() {
  const orgId = useActiveOrgId();
  const { toast } = useToast();
  const [settings, setSettings] = useState<DisplaySettings>({
    activeTournamentIds: [],
    rotationSequence: ["leaderboard", "tracker", "sidegames", "sponsor"],
    rotationIntervalSeconds: 20,
    sponsorSlideDurationSeconds: 10,
    showSponsorSlides: true,
    showSideGames: true,
    showTracker: true,
  });
  const [codes, setCodes] = useState<DisplayCode[]>([]);
  const [tournaments, setTournaments] = useState<Tournament[]>([]);
  const [saving, setSaving] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [newCodeTournamentId, setNewCodeTournamentId] = useState<string>("");
  const [newCodeLabel, setNewCodeLabel] = useState("");
  const [newCodeExpiry, setNewCodeExpiry] = useState("24");

  const baseUrl = (import.meta.env.BASE_URL ?? "/").replace(/\/$/, "");

  useEffect(() => {
    if (!orgId) return;
    loadSettings();
    loadCodes();
    loadTournaments();
  }, [orgId]);

  async function loadSettings() {
    if (!orgId) return;
    try {
      const res = await fetch(`${baseUrl}/api/organizations/${orgId}/display-settings`, { credentials: "include" });
      if (res.ok) setSettings(await res.json());
    } catch {}
  }

  async function loadCodes() {
    if (!orgId) return;
    try {
      const res = await fetch(`${baseUrl}/api/organizations/${orgId}/display-codes`, { credentials: "include" });
      if (res.ok) setCodes(await res.json());
    } catch {}
  }

  async function loadTournaments() {
    if (!orgId) return;
    try {
      const res = await fetch(`${baseUrl}/api/organizations/${orgId}/tournaments`, { credentials: "include" });
      if (res.ok) {
        const data = await res.json();
        setTournaments(data.filter((t: Tournament) => ["active", "upcoming"].includes(t.status)));
      }
    } catch {}
  }

  async function saveSettings() {
    if (!orgId) return;
    setSaving(true);
    try {
      const res = await fetch(`${baseUrl}/api/organizations/${orgId}/display-settings`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings),
      });
      if (res.ok) {
        toast({ title: "Saved", description: "Display settings updated." });
      } else {
        toast({ title: "Error", description: "Failed to save settings.", variant: "destructive" });
      }
    } catch {
      toast({ title: "Error", description: "Network error.", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  async function generateCode() {
    if (!orgId) return;
    setGenerating(true);
    try {
      const res = await fetch(`${baseUrl}/api/organizations/${orgId}/display-codes`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tournamentId: newCodeTournamentId ? parseInt(newCodeTournamentId) : null,
          label: newCodeLabel || null,
          expiresInHours: newCodeExpiry ? parseInt(newCodeExpiry) : null,
        }),
      });
      if (res.ok) {
        const code = await res.json();
        setCodes(prev => [...prev, code]);
        setNewCodeLabel("");
        setNewCodeTournamentId("");
        toast({ title: "Code Generated", description: `Display code: ${code.code}` });
      } else {
        toast({ title: "Error", description: "Failed to generate code.", variant: "destructive" });
      }
    } catch {
      toast({ title: "Error", description: "Network error.", variant: "destructive" });
    } finally {
      setGenerating(false);
    }
  }

  async function deleteCode(codeId: number) {
    if (!orgId) return;
    try {
      const res = await fetch(`${baseUrl}/api/organizations/${orgId}/display-codes/${codeId}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (res.ok) {
        setCodes(prev => prev.filter(c => c.id !== codeId));
        toast({ title: "Deleted", description: "Display code removed." });
      }
    } catch {}
  }

  function copyToClipboard(text: string) {
    navigator.clipboard.writeText(text).then(() => {
      toast({ title: "Copied!", description: `"${text}" copied to clipboard.` });
    });
  }

  function moveSequenceItem(idx: number, dir: -1 | 1) {
    const seq = [...settings.rotationSequence];
    const newIdx = idx + dir;
    if (newIdx < 0 || newIdx >= seq.length) return;
    [seq[idx], seq[newIdx]] = [seq[newIdx], seq[idx]];
    setSettings(s => ({ ...s, rotationSequence: seq }));
  }

  function toggleSequenceItem(id: string) {
    setSettings(s => {
      const has = s.rotationSequence.includes(id);
      return {
        ...s,
        rotationSequence: has
          ? s.rotationSequence.filter(v => v !== id)
          : [...s.rotationSequence, id],
      };
    });
  }

  function toggleActiveTournament(tid: number) {
    setSettings(s => ({
      ...s,
      activeTournamentIds: s.activeTournamentIds.includes(tid)
        ? s.activeTournamentIds.filter(id => id !== tid)
        : [...s.activeTournamentIds, tid],
    }));
  }

  const displayUrl = `${window.location.origin}/display`;
  const isExpired = (code: DisplayCode) => code.expiresAt ? new Date(code.expiresAt) < new Date() : false;

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-3">
            <Tv className="w-7 h-7 text-primary" />
            TV Display Board
          </h1>
          <p className="text-muted-foreground mt-1">
            Configure what appears on clubhouse TV screens and pair screens using display codes.
          </p>
        </div>
        <Button onClick={() => window.open(displayUrl, "_blank")} variant="outline" className="gap-2">
          <ExternalLink className="w-4 h-4" />
          Open Display
        </Button>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        {/* Rotation Settings */}
        <Card className="glass-card">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Settings2 className="w-5 h-5" />
              Rotation Settings
            </CardTitle>
            <CardDescription>Configure which views are shown and how long each view is displayed.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* Rotation Sequence */}
            <div>
              <Label className="text-sm font-semibold">View Rotation Order</Label>
              <p className="text-xs text-muted-foreground mb-3">Drag to reorder — views rotate in this sequence on the TV.</p>
              <div className="space-y-2">
                {SEQUENCE_OPTIONS.map(opt => {
                  const inSeq = settings.rotationSequence.includes(opt.id);
                  const idx = settings.rotationSequence.indexOf(opt.id);
                  return (
                    <div key={opt.id} className={`flex items-center justify-between p-3 rounded-lg border transition-all ${inSeq ? "border-primary/30 bg-primary/5" : "border-border/40 opacity-50"}`}>
                      <div className="flex items-center gap-3">
                        <Switch
                          checked={inSeq}
                          onCheckedChange={() => toggleSequenceItem(opt.id)}
                        />
                        <div>
                          <div className="font-medium text-sm">{opt.label}</div>
                          <div className="text-xs text-muted-foreground">{opt.description}</div>
                        </div>
                        {inSeq && (
                          <Badge variant="secondary" className="text-xs">{idx + 1}</Badge>
                        )}
                      </div>
                      {inSeq && (
                        <div className="flex gap-1">
                          <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => moveSequenceItem(idx, -1)} disabled={idx === 0}>
                            <ChevronUp className="w-3 h-3" />
                          </Button>
                          <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => moveSequenceItem(idx, 1)} disabled={idx === settings.rotationSequence.length - 1}>
                            <ChevronDown className="w-3 h-3" />
                          </Button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Timing */}
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="interval">View Duration (seconds)</Label>
                <Input
                  id="interval"
                  type="number"
                  min={5}
                  max={120}
                  value={settings.rotationIntervalSeconds}
                  onChange={e => setSettings(s => ({ ...s, rotationIntervalSeconds: parseInt(e.target.value) || 20 }))}
                />
                <p className="text-xs text-muted-foreground">How long each view is shown before rotating</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="sponsorDuration">Sponsor Slide Duration (s)</Label>
                <Input
                  id="sponsorDuration"
                  type="number"
                  min={3}
                  max={30}
                  value={settings.sponsorSlideDurationSeconds}
                  onChange={e => setSettings(s => ({ ...s, sponsorSlideDurationSeconds: parseInt(e.target.value) || 10 }))}
                />
                <p className="text-xs text-muted-foreground">Duration per sponsor when cycling logos</p>
              </div>
            </div>

            {/* Active Tournaments */}
            {tournaments.length > 0 && (
              <div>
                <Label className="text-sm font-semibold">Active Events on Display</Label>
                <p className="text-xs text-muted-foreground mb-3">Select which tournaments appear on the board. Leave blank to auto-detect active events.</p>
                <div className="space-y-2">
                  {tournaments.map(t => (
                    <div key={t.id} className={`flex items-center justify-between p-3 rounded-lg border cursor-pointer transition-all ${settings.activeTournamentIds.includes(t.id) ? "border-primary/30 bg-primary/5" : "border-border/40"}`} onClick={() => toggleActiveTournament(t.id)}>
                      <div className="flex items-center gap-3">
                        <input
                          type="checkbox"
                          checked={settings.activeTournamentIds.includes(t.id)}
                          onChange={() => toggleActiveTournament(t.id)}
                          className="accent-primary"
                        />
                        <span className="text-sm font-medium">{t.name}</span>
                      </div>
                      <Badge variant={t.status === "active" ? "default" : "secondary"} className="capitalize text-xs">{t.status}</Badge>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <Button onClick={saveSettings} disabled={saving} className="w-full">
              {saving ? "Saving..." : "Save Settings"}
            </Button>
          </CardContent>
        </Card>

        {/* Display Code Management */}
        <Card className="glass-card">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <QrCode className="w-5 h-5" />
              Display Codes
            </CardTitle>
            <CardDescription>
              Generate a short code to pair a TV screen to your event — no login required.
              Navigate to <code className="text-xs bg-muted px-1 py-0.5 rounded">{displayUrl}</code> on the TV.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            {/* Generate form */}
            <div className="space-y-3 p-4 rounded-lg border border-border/50 bg-muted/30">
              <Label className="font-semibold text-sm">Generate New Code</Label>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className="text-xs">Label (optional)</Label>
                  <Input
                    placeholder="e.g. Clubhouse TV"
                    value={newCodeLabel}
                    onChange={e => setNewCodeLabel(e.target.value)}
                  />
                </div>
                <div>
                  <Label className="text-xs">Expires in (hours)</Label>
                  <Input
                    type="number"
                    min={1}
                    placeholder="24"
                    value={newCodeExpiry}
                    onChange={e => setNewCodeExpiry(e.target.value)}
                  />
                </div>
              </div>
              {tournaments.length > 0 && (
                <div>
                  <Label className="text-xs">Pin to Tournament (optional)</Label>
                  <select
                    value={newCodeTournamentId}
                    onChange={e => setNewCodeTournamentId(e.target.value)}
                    className="w-full mt-1 px-3 py-2 bg-background border border-input rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  >
                    <option value="">— All active events —</option>
                    {tournaments.map(t => (
                      <option key={t.id} value={t.id}>{t.name}</option>
                    ))}
                  </select>
                </div>
              )}
              <Button onClick={generateCode} disabled={generating} className="w-full gap-2">
                <Plus className="w-4 h-4" />
                {generating ? "Generating..." : "Generate Code"}
              </Button>
            </div>

            {/* Existing codes */}
            {codes.length === 0 ? (
              <div className="text-center text-muted-foreground py-8">
                <QrCode className="w-10 h-10 mx-auto mb-3 opacity-30" />
                <p className="text-sm">No display codes yet. Generate one to pair a TV screen.</p>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <Label className="font-semibold text-sm">{codes.length} Active Code{codes.length !== 1 ? "s" : ""}</Label>
                  <Button variant="ghost" size="sm" onClick={loadCodes} className="gap-1 h-7">
                    <RefreshCw className="w-3 h-3" />
                    Refresh
                  </Button>
                </div>
                {codes.map(code => {
                  const expired = isExpired(code);
                  const tournament = tournaments.find(t => t.id === code.tournamentId);
                  return (
                    <div key={code.id} className={`flex items-center justify-between p-3 rounded-lg border ${expired ? "border-border/30 opacity-50" : "border-primary/20 bg-primary/5"}`}>
                      <div className="flex items-center gap-3">
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="font-mono font-bold text-xl tracking-[0.3em] text-primary">{code.code}</span>
                            {expired && <Badge variant="destructive" className="text-xs">Expired</Badge>}
                          </div>
                          <div className="text-xs text-muted-foreground mt-0.5">
                            {code.label && <span className="mr-2 font-medium">{code.label}</span>}
                            {tournament && <span className="mr-2">→ {tournament.name}</span>}
                            {code.expiresAt && (
                              <span>{expired ? "Expired" : `Expires`} {new Date(code.expiresAt).toLocaleDateString()}</span>
                            )}
                          </div>
                        </div>
                      </div>
                      <div className="flex gap-1">
                        <Button size="sm" variant="ghost" className="h-8 w-8 p-0" onClick={() => copyToClipboard(code.code)} title="Copy code">
                          <Copy className="w-3.5 h-3.5" />
                        </Button>
                        <Button size="sm" variant="ghost" className="h-8 w-8 p-0 text-destructive hover:text-destructive" onClick={() => deleteCode(code.id)} title="Delete code">
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Instructions */}
            <div className="text-xs text-muted-foreground p-3 rounded-lg bg-muted/30 border border-border/40 space-y-1">
              <div className="font-semibold text-foreground/70 mb-2">How to set up a TV display:</div>
              <div>1. Open a browser on your TV or connected device</div>
              <div>2. Navigate to <span className="font-mono text-primary">{displayUrl}</span></div>
              <div>3. Enter the 6-character display code shown above</div>
              <div>4. The screen will automatically pair and start showing live data</div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
