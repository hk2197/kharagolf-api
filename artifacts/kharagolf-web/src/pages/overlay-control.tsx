import { useEffect, useMemo, useState } from "react";
import { useActiveOrgId } from "@/context/ActiveOrgContext";
import { useGetMe, getGetMeQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { Copy, ExternalLink, PictureInPicture2, Radio, Tv2, ListMusic, Save, Pencil, Trash2, Play, RefreshCw } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  type OverlayType,
  type OverlayState,
  type SponsorPosition,
  type PanelTeeGroup,
  type PanelPlayer,
  type PanelTournament,
  isSponsorPosition,
} from "@/lib/overlay-types";

const OVERLAY_LABELS: Record<OverlayType, { label: string; description: string }> = {
  leaderboard: { label: "Leaderboard", description: "Top N standings, updates live" },
  "lower-third": { label: "Lower Third", description: "One-line caption with logo" },
  "current-group": { label: "Current Group", description: "Players in the active tee group" },
  "player-card": { label: "Player Card", description: "Profile + position for one player" },
  hole: { label: "Hole / Flyover", description: "Yardage, par, scoring distribution" },
  "sponsor-bug": { label: "Sponsor Bug", description: "Rotating sponsor logos" },
};

interface OverlayTemplate {
  id: number;
  name: string;
  state: OverlayState;
  createdByUserId: number | null;
  createdAt: string;
  updatedAt: string;
}

interface CueBody {
  type: "active" | "hole" | "group" | "player" | "sponsor" | "lower-third" | "clear-all";
  value?: string | number | null;
  overlay?: OverlayType;
  on?: boolean;
}

export default function OverlayControlPage() {
  const orgId = useActiveOrgId();
  const { data: currentUser } = useGetMe({ query: { retry: false, queryKey: getGetMeQueryKey() } });
  const { toast } = useToast();
  const baseUrl = (import.meta.env.BASE_URL ?? "/").replace(/\/$/, "");
  const absoluteBase = window.location.origin + baseUrl;

  const [tournaments, setTournaments] = useState<PanelTournament[]>([]);
  const [tournamentId, setTournamentId] = useState<number | null>(null);
  const [state, setState] = useState<OverlayState | null>(null);
  const [groups, setGroups] = useState<PanelTeeGroup[]>([]);
  const [players, setPlayers] = useState<PanelPlayer[]>([]);
  const [templates, setTemplates] = useState<OverlayTemplate[]>([]);
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  const [confirmRefreshTpl, setConfirmRefreshTpl] = useState<OverlayTemplate | null>(null);
  const [newTemplateName, setNewTemplateName] = useState("");
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [refreshingTemplateId, setRefreshingTemplateId] = useState<number | null>(null);

  useEffect(() => {
    if (!orgId) return;
    (async () => {
      const r = await fetch(`${baseUrl}/api/organizations/${orgId}/tournaments`, { credentials: "include" });
      if (r.ok) {
        const data = (await r.json()) as PanelTournament[];
        const filtered = data.filter((t) => ["active", "upcoming"].includes(t.status));
        setTournaments(filtered);
        if (filtered.length && !tournamentId) setTournamentId(filtered[0].id);
      }
    })();
  }, [orgId, baseUrl]);

  async function loadState() {
    if (!orgId || !tournamentId) return;
    const r = await fetch(`${baseUrl}/api/organizations/${orgId}/tournaments/${tournamentId}/overlay-state`, { credentials: "include" });
    if (r.ok) setState((await r.json()) as OverlayState);
  }

  async function loadRefs() {
    if (!orgId || !tournamentId) return;
    const [groupsRes, playersRes] = await Promise.all([
      fetch(`${baseUrl}/api/organizations/${orgId}/tournaments/${tournamentId}/tee-times`, { credentials: "include" }),
      fetch(`${baseUrl}/api/organizations/${orgId}/tournaments/${tournamentId}/players`, { credentials: "include" }),
    ]);
    if (groupsRes.ok) {
      const raw = (await groupsRes.json()) as Array<{
        id: number;
        teeTime: string;
        startingHole?: number | null;
        hole?: number | null;
        round: number;
        players: Array<{ playerId: number; firstName: string; lastName: string }>;
      }>;
      setGroups(raw.map((g) => ({
        id: g.id,
        teeTime: g.teeTime,
        hole: g.hole ?? g.startingHole ?? 1,
        round: g.round,
        players: g.players,
      })));
    }
    if (playersRes.ok) {
      const raw = (await playersRes.json()) as Array<{ id: number; firstName: string; lastName: string }>;
      setPlayers(raw.map((p) => ({ playerId: p.id, firstName: p.firstName, lastName: p.lastName })));
    }
  }

  async function loadTemplates() {
    if (!orgId || !tournamentId) { setTemplates([]); return; }
    const r = await fetch(`${baseUrl}/api/organizations/${orgId}/tournaments/${tournamentId}/overlay-templates`, { credentials: "include" });
    if (r.ok) {
      const data = (await r.json()) as { templates: OverlayTemplate[] };
      setTemplates(data.templates ?? []);
    }
  }

  useEffect(() => { loadState(); loadRefs(); loadTemplates(); }, [orgId, tournamentId]);

  useEffect(() => {
    if (!tournamentId) return;
    const sse = new EventSource(`${baseUrl}/api/public/overlays/${tournamentId}/stream`);
    sse.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data) as { type: string; data: OverlayState };
        if (msg.type === "overlay_state") setState(msg.data);
      } catch { /* ignore */ }
    };
    return () => sse.close();
  }, [tournamentId, baseUrl]);

  async function pushUpdate(patch: Partial<OverlayState>) {
    if (!orgId || !tournamentId) return;
    const r = await fetch(`${baseUrl}/api/organizations/${orgId}/tournaments/${tournamentId}/overlay-state`, {
      method: "PUT",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (r.ok) setState((await r.json()) as OverlayState);
  }

  async function sendCue(cue: CueBody) {
    if (!orgId || !tournamentId) return;
    const r = await fetch(`${baseUrl}/api/organizations/${orgId}/tournaments/${tournamentId}/overlay-cue`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cue),
    });
    if (r.ok) setState((await r.json()) as OverlayState);
  }

  async function saveCurrentAsTemplate() {
    if (!orgId || !tournamentId) return;
    const name = newTemplateName.trim();
    if (!name) {
      toast({ title: "Name required", description: "Give the cue sheet a name first.", variant: "destructive" });
      return;
    }
    setSavingTemplate(true);
    try {
      const r = await fetch(`${baseUrl}/api/organizations/${orgId}/tournaments/${tournamentId}/overlay-templates`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (r.status === 409) {
        toast({ title: "Name already used", description: "A cue sheet with that name already exists for this tournament.", variant: "destructive" });
        return;
      }
      if (!r.ok) {
        const err = await r.json().catch(() => ({} as { error?: string }));
        toast({ title: "Could not save", description: err.error ?? "Something went wrong.", variant: "destructive" });
        return;
      }
      setNewTemplateName("");
      await loadTemplates();
      toast({ title: "Cue sheet saved", description: `"${name}" captured the current overlay state.` });
    } finally {
      setSavingTemplate(false);
    }
  }

  const REFRESH_STALE_MS = 5 * 60 * 1000;

  function shouldConfirmRefresh(tpl: OverlayTemplate): boolean {
    const ageMs = Date.now() - new Date(tpl.updatedAt).getTime();
    if (Number.isFinite(ageMs) && ageMs > REFRESH_STALE_MS) return true;
    if (tpl.createdByUserId !== null) {
      if (currentUser?.id === undefined) return true;
      if (tpl.createdByUserId !== currentUser.id) return true;
    }
    return false;
  }

  function handleRefreshClick(tpl: OverlayTemplate) {
    if (!state) return;
    if (shouldConfirmRefresh(tpl)) {
      setConfirmRefreshTpl(tpl);
      return;
    }
    void refreshTemplateFromCurrent(tpl);
  }

  async function refreshTemplateFromCurrent(tpl: OverlayTemplate) {
    if (!orgId || !tournamentId || !state) return;
    setRefreshingTemplateId(tpl.id);
    try {
      const r = await fetch(`${baseUrl}/api/organizations/${orgId}/tournaments/${tournamentId}/overlay-templates/${tpl.id}`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state }),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({} as { error?: string }));
        toast({ title: "Could not update", description: err.error ?? "Something went wrong.", variant: "destructive" });
        return;
      }
      await loadTemplates();
      toast({ title: "Cue sheet updated", description: `"${tpl.name}" now matches the current overlay state.` });
    } finally {
      setRefreshingTemplateId(null);
    }
  }

  async function loadTemplate(tpl: OverlayTemplate) {
    if (!orgId || !tournamentId) return;
    const r = await fetch(`${baseUrl}/api/organizations/${orgId}/tournaments/${tournamentId}/overlay-templates/${tpl.id}/load`, {
      method: "POST",
      credentials: "include",
    });
    if (r.ok) {
      setState((await r.json()) as OverlayState);
      toast({ title: "On-air", description: `Loaded "${tpl.name}".` });
    } else {
      toast({ title: "Could not load", description: "Cue sheet failed to load.", variant: "destructive" });
    }
  }

  function startRename(tpl: OverlayTemplate) {
    setRenamingId(tpl.id);
    setRenameValue(tpl.name);
  }

  async function commitRename() {
    if (!orgId || !tournamentId || renamingId === null) return;
    const name = renameValue.trim();
    if (!name) {
      toast({ title: "Name required", variant: "destructive" });
      return;
    }
    const r = await fetch(`${baseUrl}/api/organizations/${orgId}/tournaments/${tournamentId}/overlay-templates/${renamingId}`, {
      method: "PUT",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (r.status === 409) {
      toast({ title: "Name already used", description: "A cue sheet with that name already exists for this tournament.", variant: "destructive" });
      return;
    }
    if (!r.ok) {
      toast({ title: "Could not rename", variant: "destructive" });
      return;
    }
    setRenamingId(null);
    setRenameValue("");
    await loadTemplates();
  }

  async function deleteTemplate(id: number) {
    if (!orgId || !tournamentId) return;
    const r = await fetch(`${baseUrl}/api/organizations/${orgId}/tournaments/${tournamentId}/overlay-templates/${id}`, {
      method: "DELETE",
      credentials: "include",
    });
    setConfirmDeleteId(null);
    if (r.ok) {
      await loadTemplates();
      toast({ title: "Cue sheet deleted" });
    } else {
      toast({ title: "Could not delete", variant: "destructive" });
    }
  }

  const overlayUrls = useMemo<Record<OverlayType, string>>(() => {
    const out = {
      leaderboard: "", "lower-third": "", "current-group": "",
      "player-card": "", hole: "", "sponsor-bug": "",
    } as Record<OverlayType, string>;
    if (!tournamentId) return out;
    (Object.keys(OVERLAY_LABELS) as OverlayType[]).forEach((t) => {
      out[t] = `${absoluteBase}/overlay/${tournamentId}?type=${t}`;
    });
    return out;
  }, [tournamentId, absoluteBase]);

  const compositeUrl = tournamentId ? `${absoluteBase}/overlay/${tournamentId}` : "";
  const previewUrl = tournamentId ? `${absoluteBase}/overlay/${tournamentId}?safe=1080&preview=1` : "";

  function copy(text: string) {
    navigator.clipboard.writeText(text);
    toast({ title: "Copied", description: text });
  }

  function popOutPreview() {
    if (!previewUrl) return;
    const width = 1280;
    const height = 720;
    const left = Math.max(0, (window.screen.availWidth - width) / 2);
    const top = Math.max(0, (window.screen.availHeight - height) / 2);
    const features = [
      `width=${width}`,
      `height=${height}`,
      `left=${Math.round(left)}`,
      `top=${Math.round(top)}`,
      "menubar=no",
      "toolbar=no",
      "location=no",
      "status=no",
      "resizable=yes",
      "scrollbars=no",
    ].join(",");
    const win = window.open(previewUrl, `overlay-preview-${tournamentId}`, features);
    if (!win) {
      toast({
        title: "Popup blocked",
        description: "Allow popups for this site to open the preview window.",
        variant: "destructive",
      });
      return;
    }
    win.focus();
  }

  if (!orgId) return <div className="p-6 text-muted-foreground">Select an organization first.</div>;

  return (
    <div className="p-6 space-y-6 max-w-6xl">
      <div>
        <h1 className="text-3xl font-bold flex items-center gap-2"><Radio className="w-7 h-7 text-red-500" /> Broadcast Overlays</h1>
        <p className="text-muted-foreground mt-1">
          Transparent browser sources for OBS, vMix and similar broadcast tools. Set them as a Browser Source and they update live.
        </p>
      </div>

      <Card>
        <CardHeader><CardTitle>Active Tournament</CardTitle></CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-2">
            {tournaments.length === 0 && <div className="text-sm text-muted-foreground">No active or upcoming tournaments.</div>}
            {tournaments.map((t) => (
              <Button key={t.id} size="sm" variant={tournamentId === t.id ? "default" : "outline"} onClick={() => setTournamentId(t.id)}>
                {t.name} <Badge variant="secondary" className="ml-2">{t.status}</Badge>
              </Button>
            ))}
          </div>
        </CardContent>
      </Card>

      {tournamentId && state && (
        <>
          <Card>
            <CardHeader>
              <div className="flex items-start justify-between gap-4">
                <div>
                  <CardTitle className="flex items-center gap-2"><Tv2 className="w-5 h-5" /> Live Preview</CardTitle>
                  <CardDescription>
                    Composite of all active overlays with safe-area guides on. Updates instantly when you toggle overlays or push cues.
                  </CardDescription>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={popOutPreview}
                  data-testid="button-popout-preview"
                  title="Open the preview in its own 16:9 window"
                >
                  <PictureInPicture2 className="w-4 h-4 mr-2" />
                  Pop out
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              <div className="relative w-full bg-black rounded-md overflow-hidden border" style={{ aspectRatio: "16 / 9" }}>
                <iframe
                  key={previewUrl}
                  src={previewUrl}
                  title="Overlay live preview"
                  className="absolute inset-0 w-full h-full"
                  style={{ border: 0 }}
                  data-testid="iframe-overlay-preview"
                />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><Tv2 className="w-5 h-5" /> Browser Source URLs</CardTitle>
              <CardDescription>Add these as Browser Source in OBS / vMix. Resolution: 1920×1080 (or 3840×2160). Background must remain transparent.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              <UrlRow label="Composite (all active overlays)" url={compositeUrl} onCopy={copy} />
              {(Object.keys(OVERLAY_LABELS) as OverlayType[]).map((t) => (
                <UrlRow key={t} label={OVERLAY_LABELS[t].label} url={overlayUrls[t]} onCopy={copy} />
              ))}
              <div className="text-xs text-muted-foreground pt-2">
                Append <code>?safe=1080</code> or <code>?safe=4k</code> to display safe-area guides for production framing.
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>Active Overlays</CardTitle></CardHeader>
            <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {(Object.keys(OVERLAY_LABELS) as OverlayType[]).map((t) => (
                <div key={t} className="flex items-start justify-between gap-4 p-3 border rounded-md">
                  <div>
                    <div className="font-semibold">{OVERLAY_LABELS[t].label}</div>
                    <div className="text-xs text-muted-foreground">{OVERLAY_LABELS[t].description}</div>
                  </div>
                  <Switch
                    checked={state.active[t]}
                    onCheckedChange={(on) => sendCue({ type: "active", overlay: t, on })}
                    data-testid={`switch-overlay-${t}`}
                  />
                </div>
              ))}
              <div className="md:col-span-2">
                <Button variant="outline" size="sm" onClick={() => sendCue({ type: "clear-all" })}>Hide all overlays</Button>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>Live Cues</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <div>
                <Label>Lower-third caption (e.g. "Now showing: Hole 17")</Label>
                <div className="flex gap-2 mt-1">
                  <Input
                    placeholder="Now showing: Hole 17"
                    defaultValue={state.lowerThirdText ?? ""}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") sendCue({ type: "lower-third", value: (e.target as HTMLInputElement).value });
                    }}
                    data-testid="input-lower-third"
                  />
                  <Button onClick={() => sendCue({ type: "lower-third", value: "" })} variant="outline">Clear</Button>
                </div>
                <div className="text-xs text-muted-foreground mt-1">Press Enter to push live.</div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div>
                  <Label>Current hole</Label>
                  <Input
                    type="number"
                    min={1}
                    max={18}
                    defaultValue={state.currentHole ?? ""}
                    onBlur={(e) => sendCue({ type: "hole", value: e.target.value ? parseInt(e.target.value) : null })}
                    data-testid="input-current-hole"
                  />
                </div>

                <div>
                  <Label>Current group</Label>
                  <select
                    className="w-full border rounded-md p-2 mt-1 bg-background"
                    value={state.currentGroupId ?? ""}
                    onChange={(e) => sendCue({ type: "group", value: e.target.value ? parseInt(e.target.value) : null })}
                    data-testid="select-current-group"
                  >
                    <option value="">— none —</option>
                    {groups.map((g) => (
                      <option key={g.id} value={g.id}>
                        R{g.round} · {new Date(g.teeTime).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · Tee {g.hole} · {g.players.map((p) => `${p.firstName} ${p.lastName[0] ?? ""}.`).join(", ")}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <Label>Featured player</Label>
                  <select
                    className="w-full border rounded-md p-2 mt-1 bg-background"
                    value={state.currentPlayerId ?? ""}
                    onChange={(e) => sendCue({ type: "player", value: e.target.value ? parseInt(e.target.value) : null })}
                    data-testid="select-current-player"
                  >
                    <option value="">— none —</option>
                    {players.map((p) => (
                      <option key={p.playerId} value={p.playerId}>{p.firstName} {p.lastName}</option>
                    ))}
                  </select>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><ListMusic className="w-5 h-5" /> Cue sheets</CardTitle>
              <CardDescription>Snapshot the current overlay state as a named template (e.g. "Sunday final round", "Hole 17 amen corner") and load it back on-air with one click.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex gap-2">
                <Input
                  placeholder="Name this cue sheet…"
                  value={newTemplateName}
                  onChange={(e) => setNewTemplateName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") saveCurrentAsTemplate(); }}
                  data-testid="input-new-template-name"
                  maxLength={120}
                />
                <Button onClick={saveCurrentAsTemplate} disabled={savingTemplate || !newTemplateName.trim()} data-testid="button-save-template">
                  <Save className="w-4 h-4 mr-2" />
                  Save current as template
                </Button>
              </div>

              {templates.length === 0 ? (
                <div className="text-sm text-muted-foreground py-4 text-center border rounded-md">
                  No cue sheets saved yet. Set up your overlays above, then save them here so you can recall the look in one click.
                </div>
              ) : (
                <div className="divide-y border rounded-md" data-testid="list-templates">
                  {templates.map((tpl) => (
                    <div key={tpl.id} className="flex items-center gap-2 p-3" data-testid={`row-template-${tpl.id}`}>
                      {renamingId === tpl.id ? (
                        <>
                          <Input
                            value={renameValue}
                            onChange={(e) => setRenameValue(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") commitRename();
                              if (e.key === "Escape") { setRenamingId(null); setRenameValue(""); }
                            }}
                            autoFocus
                            maxLength={120}
                            data-testid={`input-rename-${tpl.id}`}
                          />
                          <Button size="sm" onClick={commitRename} data-testid={`button-rename-save-${tpl.id}`}>Save</Button>
                          <Button size="sm" variant="ghost" onClick={() => { setRenamingId(null); setRenameValue(""); }}>Cancel</Button>
                        </>
                      ) : (
                        <>
                          <div className="flex-1 min-w-0">
                            <div className="font-medium truncate">{tpl.name}</div>
                            <div className="text-xs text-muted-foreground">
                              Updated {new Date(tpl.updatedAt).toLocaleString()}
                            </div>
                          </div>
                          <Button size="sm" variant="default" onClick={() => loadTemplate(tpl)} data-testid={`button-load-${tpl.id}`}>
                            <Play className="w-4 h-4 mr-2" />
                            Load
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => handleRefreshClick(tpl)}
                            disabled={refreshingTemplateId === tpl.id || !state}
                            title="Replace this cue sheet's saved state with the current overlay state"
                            data-testid={`button-refresh-${tpl.id}`}
                          >
                            <RefreshCw className={`w-4 h-4 mr-2 ${refreshingTemplateId === tpl.id ? "animate-spin" : ""}`} />
                            Update from current
                          </Button>
                          <Button size="icon" variant="ghost" onClick={() => startRename(tpl)} title="Rename" data-testid={`button-rename-${tpl.id}`}>
                            <Pencil className="w-4 h-4" />
                          </Button>
                          <Button size="icon" variant="ghost" onClick={() => setConfirmDeleteId(tpl.id)} title="Delete" data-testid={`button-delete-${tpl.id}`}>
                            <Trash2 className="w-4 h-4 text-destructive" />
                          </Button>
                        </>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <AlertDialog open={confirmDeleteId !== null} onOpenChange={(open) => { if (!open) setConfirmDeleteId(null); }}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete this cue sheet?</AlertDialogTitle>
                <AlertDialogDescription>
                  This removes the saved overlay template. The live broadcast is not affected.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => { if (confirmDeleteId !== null) deleteTemplate(confirmDeleteId); }}
                  data-testid="button-confirm-delete-template"
                >
                  Delete
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>

          <AlertDialog open={confirmRefreshTpl !== null} onOpenChange={(open) => { if (!open) setConfirmRefreshTpl(null); }}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Overwrite "{confirmRefreshTpl?.name}"?</AlertDialogTitle>
                <AlertDialogDescription>
                  {confirmRefreshTpl ? (
                    <>
                      This will replace the saved state of <strong>"{confirmRefreshTpl.name}"</strong> with whatever is currently on-air.
                      {" "}It was last updated {new Date(confirmRefreshTpl.updatedAt).toLocaleString()}
                      {confirmRefreshTpl.createdByUserId !== null
                        && (currentUser?.id === undefined
                          || confirmRefreshTpl.createdByUserId !== currentUser.id)
                        ? " by another user." : "."}
                      {" "}This cannot be undone.
                    </>
                  ) : null}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel data-testid="button-cancel-refresh-template">Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => {
                    const tpl = confirmRefreshTpl;
                    setConfirmRefreshTpl(null);
                    if (tpl) void refreshTemplateFromCurrent(tpl);
                  }}
                  data-testid="button-confirm-refresh-template"
                >
                  Overwrite
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>

          <Card>
            <CardHeader>
              <CardTitle>Theme</CardTitle>
              <CardDescription>Override club branding for this broadcast. Defaults pull from your organization profile.</CardDescription>
            </CardHeader>
            <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <Label>Logo URL</Label>
                <Input
                  defaultValue={state.theme.logoUrl ?? ""}
                  onBlur={(e) => pushUpdate({ theme: { ...state.theme, logoUrl: e.target.value || null } })}
                  data-testid="input-theme-logo"
                />
              </div>
              <div>
                <Label>Primary color</Label>
                <Input
                  type="color"
                  defaultValue={state.theme.primaryColor}
                  onBlur={(e) => pushUpdate({ theme: { ...state.theme, primaryColor: e.target.value } })}
                  data-testid="input-theme-primary"
                />
              </div>
              <div>
                <Label>Accent color</Label>
                <Input
                  type="color"
                  defaultValue={state.theme.accentColor}
                  onBlur={(e) => pushUpdate({ theme: { ...state.theme, accentColor: e.target.value } })}
                  data-testid="input-theme-accent"
                />
              </div>
              <div>
                <Label>Sponsor bug position</Label>
                <select
                  className="w-full border rounded-md p-2 mt-1 bg-background"
                  value={state.theme.sponsorPosition}
                  onChange={(e) => {
                    const v = e.target.value;
                    if (isSponsorPosition(v)) {
                      const sponsorPosition: SponsorPosition = v;
                      pushUpdate({ theme: { ...state.theme, sponsorPosition } });
                    }
                  }}
                >
                  <option value="top-left">Top left</option>
                  <option value="top-right">Top right</option>
                  <option value="bottom-left">Bottom left</option>
                  <option value="bottom-right">Bottom right</option>
                </select>
              </div>
              <div>
                <Label>Leaderboard rows</Label>
                <Input
                  type="number"
                  min={1}
                  max={20}
                  defaultValue={state.leaderboardLimit}
                  onBlur={(e) => pushUpdate({ leaderboardLimit: parseInt(e.target.value || "10") })}
                />
              </div>
              <div className="flex items-center gap-3 pt-6">
                <Switch
                  checked={state.theme.showSafeArea}
                  onCheckedChange={(v) => pushUpdate({ theme: { ...state.theme, showSafeArea: v } })}
                  data-testid="switch-safe-area"
                />
                <Label>Show 1080p / 4K safe-area guides</Label>
              </div>
            </CardContent>
          </Card>

          <div className="text-xs text-muted-foreground">Last updated: {new Date(state.updatedAt).toLocaleTimeString()}</div>
        </>
      )}
    </div>
  );
}

function UrlRow({ label, url, onCopy }: { label: string; url: string; onCopy: (s: string) => void }) {
  return (
    <div className="flex items-center gap-2 py-1">
      <div className="w-44 text-sm font-medium shrink-0">{label}</div>
      <Input readOnly value={url} className="font-mono text-xs" />
      <Button size="icon" variant="ghost" onClick={() => onCopy(url)} title="Copy"><Copy className="w-4 h-4" /></Button>
      <Button size="icon" variant="ghost" asChild title="Open"><a href={url} target="_blank" rel="noreferrer"><ExternalLink className="w-4 h-4" /></a></Button>
    </div>
  );
}

