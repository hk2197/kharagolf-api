import React, { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useActiveOrgId } from "@/context/ActiveOrgContext";
import { useToast } from "@/hooks/use-toast";
import { Plus, Pencil, Trash2, BarChart2, Calendar, Megaphone, Layers, Image as ImageIcon, X } from "lucide-react";

interface Slot {
  id: number; slotKey: string; name: string; description: string | null;
  surface: string; rotationSeconds: number; mediaTypes: string[]; isActive: boolean;
}
interface Creative {
  id: number; sponsorId: number; sponsorName: string | null; sponsorLogoUrl: string | null;
  name: string; mediaType: "image" | "video"; mediaUrl: string;
  clickThroughUrl: string | null; headline: string | null; subheadline: string | null;
  isActive: boolean; createdAt: string;
}
interface Campaign {
  id: number; name: string;
  sponsorId: number; sponsorName: string | null;
  slotId: number; slotKey: string | null; slotName: string | null;
  creativeId: number; creativeName: string | null; creativeMediaUrl: string | null; creativeMediaType: "image" | "video" | null;
  tournamentId: number | null;
  startDate: string; endDate: string;
  weight: number; frequencyCapPerSession: number;
  isActive: boolean; notes: string | null;
}
interface Sponsor { id: number; name: string; }

class ApiError extends Error {
  status: number;
  body: Record<string, unknown> | null;
  constructor(message: string, status: number, body: Record<string, unknown> | null) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function jsonFetch(url: string, init?: RequestInit) {
  const r = await fetch(url, { ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
  if (!r.ok) {
    const text = await r.text();
    let body: Record<string, unknown> | null = null;
    let message = text;
    try {
      const parsed = JSON.parse(text);
      body = parsed;
      const detail = typeof parsed.detail === "string" ? parsed.detail : null;
      const errorMsg = typeof parsed.error === "string" ? parsed.error : null;
      message = detail ?? errorMsg ?? text;
    } catch { /* not JSON */ }
    throw new ApiError(message || `Request failed (${r.status})`, r.status, body);
  }
  return r.json();
}

export default function SponsorCampaignsPage() {
  const orgId = useActiveOrgId();
  const [tab, setTab] = useState<"campaigns" | "creatives" | "slots">("campaigns");

  if (!orgId) {
    return <div className="p-8 text-muted-foreground">Select an organization to manage ad campaigns.</div>;
  }

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Megaphone className="w-6 h-6 text-amber-500" /> Sponsorship Ad Inventory
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Manage ad slots, creative assets, and live campaigns across leaderboards, the TV display, and the player app.
        </p>
      </div>

      <div className="flex gap-2 border-b border-white/10">
        {([
          ["campaigns", "Campaigns", Calendar],
          ["creatives", "Creatives", ImageIcon],
          ["slots", "Slots", Layers],
        ] as const).map(([key, label, Icon]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`flex items-center gap-2 px-4 py-2 -mb-px border-b-2 text-sm font-medium ${
              tab === key ? "border-amber-500 text-amber-400" : "border-transparent text-muted-foreground hover:text-white"
            }`}
          >
            <Icon className="w-4 h-4" /> {label}
          </button>
        ))}
      </div>

      {tab === "campaigns" && <CampaignsTab orgId={orgId} />}
      {tab === "creatives" && <CreativesTab orgId={orgId} />}
      {tab === "slots" && <SlotsTab orgId={orgId} />}
    </div>
  );
}

// ─── Slots Tab ──────────────────────────────────────────────────────────────

function SlotsTab({ orgId }: { orgId: number }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data: slots = [] } = useQuery<Slot[]>({
    queryKey: [`/api/organizations/${orgId}/ad-inventory/slots`],
    queryFn: () => jsonFetch(`/api/organizations/${orgId}/ad-inventory/slots`),
  });

  const update = useMutation({
    mutationFn: ({ slotId, patch }: { slotId: number; patch: Partial<Slot> }) =>
      jsonFetch(`/api/organizations/${orgId}/ad-inventory/slots/${slotId}`, { method: "PATCH", body: JSON.stringify(patch) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/ad-inventory/slots`] });
      toast({ title: "Slot updated" });
    },
  });

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">Slots are created automatically the first time you visit this page. Adjust rotation timing or temporarily disable a surface.</p>
      {slots.map(s => (
        <div key={s.id} className="bg-card border border-white/10 rounded-xl p-4 flex items-center gap-4">
          <div className="flex-1">
            <p className="font-medium">{s.name} <span className="ml-2 text-xs text-muted-foreground font-mono">{s.slotKey}</span></p>
            <p className="text-xs text-muted-foreground mt-0.5">{s.description}</p>
            <p className="text-xs text-muted-foreground mt-1">Surface: <span className="text-white">{s.surface}</span> · Media: {s.mediaTypes.join(", ")}</p>
          </div>
          <label className="flex items-center gap-2 text-xs">
            Rotate every
            <input
              type="number" min={0} defaultValue={s.rotationSeconds}
              onBlur={(e) => {
                const v = parseInt(e.target.value);
                if (!isNaN(v) && v !== s.rotationSeconds) update.mutate({ slotId: s.id, patch: { rotationSeconds: v } });
              }}
              className="w-16 bg-black/30 border border-white/10 rounded px-2 py-1 text-right"
            />
            sec
          </label>
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox" checked={s.isActive}
              onChange={(e) => update.mutate({ slotId: s.id, patch: { isActive: e.target.checked } })}
            />
            Active
          </label>
        </div>
      ))}
    </div>
  );
}

// ─── Creatives Tab ──────────────────────────────────────────────────────────

function CreativesTab({ orgId }: { orgId: number }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [editing, setEditing] = useState<Creative | "new" | null>(null);

  const { data: creatives = [] } = useQuery<Creative[]>({
    queryKey: [`/api/organizations/${orgId}/ad-inventory/creatives`],
    queryFn: () => jsonFetch(`/api/organizations/${orgId}/ad-inventory/creatives`),
  });

  const remove = useMutation({
    mutationFn: (id: number) => jsonFetch(`/api/organizations/${orgId}/ad-inventory/creatives/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/ad-inventory/creatives`] }),
  });

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <button onClick={() => setEditing("new")} className="flex items-center gap-2 bg-amber-500 hover:bg-amber-600 text-black px-3 py-2 rounded text-sm font-medium">
          <Plus className="w-4 h-4" /> New Creative
        </button>
      </div>
      {creatives.length === 0 ? (
        <div className="bg-card border border-white/10 rounded-xl p-8 text-center text-muted-foreground">
          No creatives yet. Upload your first creative to start running campaigns.
        </div>
      ) : (
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
          {creatives.map(c => (
            <div key={c.id} className="bg-card border border-white/10 rounded-xl overflow-hidden">
              <div className="aspect-video bg-black/40 flex items-center justify-center">
                {c.mediaType === "video" ? (
                  <video src={c.mediaUrl} muted loop autoPlay playsInline className="max-h-full max-w-full" />
                ) : (
                  <img src={c.mediaUrl} alt={c.name} className="max-h-full max-w-full object-contain" />
                )}
              </div>
              <div className="p-3 space-y-1">
                <p className="font-medium text-sm">{c.name}</p>
                <p className="text-xs text-muted-foreground">{c.sponsorName} · {c.mediaType}</p>
                {c.clickThroughUrl && <p className="text-xs text-amber-400 truncate">→ {c.clickThroughUrl}</p>}
                <div className="flex items-center justify-between pt-2">
                  <span className={`text-[10px] px-2 py-0.5 rounded-full ${c.isActive ? "bg-green-500/10 text-green-400" : "bg-gray-500/10 text-gray-400"}`}>
                    {c.isActive ? "Active" : "Inactive"}
                  </span>
                  <div className="flex gap-1">
                    <button onClick={() => setEditing(c)} className="p-1.5 hover:bg-white/10 rounded"><Pencil className="w-3.5 h-3.5" /></button>
                    <button onClick={() => { if (confirm("Delete this creative?")) remove.mutate(c.id); }} className="p-1.5 hover:bg-red-500/10 rounded text-red-400"><Trash2 className="w-3.5 h-3.5" /></button>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
      {editing && <CreativeModal orgId={orgId} creative={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); toast({ title: "Saved" }); qc.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/ad-inventory/creatives`] }); }} />}
    </div>
  );
}

function CreativeModal({ orgId, creative, onClose, onSaved }: { orgId: number; creative: Creative | null; onClose: () => void; onSaved: () => void }) {
  const { data: sponsors = [] } = useQuery<Sponsor[]>({
    queryKey: [`/api/organizations/${orgId}/sponsors`],
    queryFn: () => jsonFetch(`/api/organizations/${orgId}/sponsors`),
  });
  const [form, setForm] = useState({
    sponsorId: creative?.sponsorId ?? sponsors[0]?.id ?? 0,
    name: creative?.name ?? "",
    mediaType: creative?.mediaType ?? "image",
    mediaUrl: creative?.mediaUrl ?? "",
    clickThroughUrl: creative?.clickThroughUrl ?? "",
    headline: creative?.headline ?? "",
    subheadline: creative?.subheadline ?? "",
    isActive: creative?.isActive ?? true,
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    setErr(null); setSaving(true);
    try {
      if (creative) {
        await jsonFetch(`/api/organizations/${orgId}/ad-inventory/creatives/${creative.id}`, { method: "PATCH", body: JSON.stringify(form) });
      } else {
        await jsonFetch(`/api/organizations/${orgId}/ad-inventory/creatives`, { method: "POST", body: JSON.stringify(form) });
      }
      onSaved();
    } catch (e) { setErr((e as Error).message); } finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4">
      <div className="bg-card border border-white/10 rounded-xl max-w-lg w-full p-6 space-y-4">
        <div className="flex justify-between items-center">
          <h2 className="font-bold">{creative ? "Edit Creative" : "New Creative"}</h2>
          <button onClick={onClose}><X className="w-5 h-5" /></button>
        </div>
        <div className="space-y-3">
          <Field label="Sponsor">
            <select value={form.sponsorId} onChange={e => setForm({ ...form, sponsorId: parseInt(e.target.value) })} className="w-full bg-black/30 border border-white/10 rounded px-3 py-2">
              <option value="">Select sponsor…</option>
              {sponsors.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </Field>
          <Field label="Name"><input className="input" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} /></Field>
          <Field label="Media Type">
            <select value={form.mediaType} onChange={e => setForm({ ...form, mediaType: e.target.value as "image" | "video" })} className="w-full bg-black/30 border border-white/10 rounded px-3 py-2">
              <option value="image">Image</option>
              <option value="video">Video (mp4/webm)</option>
            </select>
          </Field>
          <Field label="Media URL"><input className="input" value={form.mediaUrl} onChange={e => setForm({ ...form, mediaUrl: e.target.value })} placeholder="https://…" /></Field>
          <Field label="Click-through URL (optional)"><input className="input" value={form.clickThroughUrl ?? ""} onChange={e => setForm({ ...form, clickThroughUrl: e.target.value })} placeholder="https://sponsor.com/promo" /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Headline"><input className="input" value={form.headline ?? ""} onChange={e => setForm({ ...form, headline: e.target.value })} /></Field>
            <Field label="Subheadline"><input className="input" value={form.subheadline ?? ""} onChange={e => setForm({ ...form, subheadline: e.target.value })} /></Field>
          </div>
          <label className="flex gap-2 items-center text-sm">
            <input type="checkbox" checked={form.isActive} onChange={e => setForm({ ...form, isActive: e.target.checked })} /> Active
          </label>
        </div>
        {err && <p className="text-sm text-red-400">{err}</p>}
        <div className="flex gap-2 justify-end">
          <button onClick={onClose} className="px-4 py-2 text-sm">Cancel</button>
          <button onClick={submit} disabled={saving || !form.sponsorId || !form.name || !form.mediaUrl} className="px-4 py-2 bg-amber-500 hover:bg-amber-600 text-black rounded text-sm font-medium disabled:opacity-50">
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
      <style>{`.input{width:100%;background:rgba(0,0,0,.3);border:1px solid rgba(255,255,255,.1);border-radius:6px;padding:8px 12px;font-size:14px;color:white;}`}</style>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block text-sm space-y-1"><span className="text-muted-foreground text-xs">{label}</span>{children}</label>;
}

// ─── Campaigns Tab ──────────────────────────────────────────────────────────

function CampaignsTab({ orgId }: { orgId: number }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [editing, setEditing] = useState<Campaign | "new" | null>(null);

  const { data: campaigns = [] } = useQuery<Campaign[]>({
    queryKey: [`/api/organizations/${orgId}/ad-inventory/campaigns`],
    queryFn: () => jsonFetch(`/api/organizations/${orgId}/ad-inventory/campaigns`),
  });

  const remove = useMutation({
    mutationFn: (id: number) => jsonFetch(`/api/organizations/${orgId}/ad-inventory/campaigns/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/ad-inventory/campaigns`] }),
  });

  const now = Date.now();

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <button onClick={() => setEditing("new")} className="flex items-center gap-2 bg-amber-500 hover:bg-amber-600 text-black px-3 py-2 rounded text-sm font-medium">
          <Plus className="w-4 h-4" /> New Campaign
        </button>
      </div>
      {campaigns.length === 0 ? (
        <div className="bg-card border border-white/10 rounded-xl p-8 text-center text-muted-foreground">
          No campaigns yet. Create your first campaign to schedule sponsor creatives across slots.
        </div>
      ) : (
        <div className="overflow-x-auto bg-card border border-white/10 rounded-xl">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-muted-foreground border-b border-white/10">
                <th className="text-left py-3 px-4">Campaign</th>
                <th className="text-left py-3 px-4">Sponsor</th>
                <th className="text-left py-3 px-4">Slot</th>
                <th className="text-left py-3 px-4">Window</th>
                <th className="text-right py-3 px-4">Weight</th>
                <th className="text-right py-3 px-4">Cap/Session</th>
                <th className="text-left py-3 px-4">Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {campaigns.map(c => {
                const start = new Date(c.startDate).getTime();
                const end = new Date(c.endDate).getTime();
                const live = c.isActive && start <= now && end >= now;
                const upcoming = start > now;
                return (
                  <tr key={c.id} className="border-b border-white/5 last:border-0">
                    <td className="py-3 px-4">
                      <div className="font-medium">{c.name}</div>
                      <div className="text-xs text-muted-foreground">{c.creativeName}</div>
                    </td>
                    <td className="py-3 px-4">{c.sponsorName}</td>
                    <td className="py-3 px-4 font-mono text-xs">{c.slotKey}</td>
                    <td className="py-3 px-4 text-xs text-muted-foreground">
                      {new Date(c.startDate).toLocaleDateString()} – {new Date(c.endDate).toLocaleDateString()}
                    </td>
                    <td className="py-3 px-4 text-right">{c.weight}</td>
                    <td className="py-3 px-4 text-right">{c.frequencyCapPerSession || "—"}</td>
                    <td className="py-3 px-4">
                      <span className={`text-[10px] px-2 py-0.5 rounded-full ${
                        live ? "bg-green-500/10 text-green-400" :
                        upcoming ? "bg-amber-500/10 text-amber-400" :
                        "bg-gray-500/10 text-gray-400"
                      }`}>
                        {live ? "Live" : upcoming ? "Scheduled" : "Ended"}
                      </span>
                    </td>
                    <td className="py-3 px-4 text-right">
                      <CampaignMetricsButton orgId={orgId} campaignId={c.id} />
                      <button onClick={() => setEditing(c)} className="p-1.5 hover:bg-white/10 rounded ml-1"><Pencil className="w-3.5 h-3.5" /></button>
                      <button onClick={() => { if (confirm("Delete campaign?")) remove.mutate(c.id); }} className="p-1.5 hover:bg-red-500/10 rounded text-red-400 ml-1"><Trash2 className="w-3.5 h-3.5" /></button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {editing && (
        <CampaignModal
          orgId={orgId}
          campaign={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); toast({ title: "Saved" }); qc.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/ad-inventory/campaigns`] }); }}
        />
      )}
    </div>
  );
}

function CampaignMetricsButton({ orgId, campaignId }: { orgId: number; campaignId: number }) {
  const [show, setShow] = useState(false);
  const { data } = useQuery<{ impressions: number; clicks: number; ctr: number }>({
    queryKey: [`/api/organizations/${orgId}/ad-inventory/campaigns/${campaignId}/metrics`],
    queryFn: () => jsonFetch(`/api/organizations/${orgId}/ad-inventory/campaigns/${campaignId}/metrics`),
    enabled: show,
  });
  return (
    <span className="relative">
      <button onClick={() => setShow(s => !s)} className="p-1.5 hover:bg-white/10 rounded text-amber-400"><BarChart2 className="w-3.5 h-3.5" /></button>
      {show && data && (
        <span className="absolute right-0 top-full mt-1 bg-black border border-white/10 rounded p-2 text-xs whitespace-nowrap z-10">
          {data.impressions.toLocaleString()} imp · {data.clicks.toLocaleString()} clk · {data.ctr}% CTR
        </span>
      )}
    </span>
  );
}

function CampaignModal({ orgId, campaign, onClose, onSaved }: { orgId: number; campaign: Campaign | null; onClose: () => void; onSaved: () => void }) {
  const { data: sponsors = [] } = useQuery<Sponsor[]>({
    queryKey: [`/api/organizations/${orgId}/sponsors`],
    queryFn: () => jsonFetch(`/api/organizations/${orgId}/sponsors`),
  });
  const { data: slots = [] } = useQuery<Slot[]>({
    queryKey: [`/api/organizations/${orgId}/ad-inventory/slots`],
    queryFn: () => jsonFetch(`/api/organizations/${orgId}/ad-inventory/slots`),
  });
  const { data: creatives = [] } = useQuery<Creative[]>({
    queryKey: [`/api/organizations/${orgId}/ad-inventory/creatives`],
    queryFn: () => jsonFetch(`/api/organizations/${orgId}/ad-inventory/creatives`),
  });

  const today = new Date().toISOString().slice(0, 10);
  const inThirty = new Date(Date.now() + 30 * 86400_000).toISOString().slice(0, 10);

  const [form, setForm] = useState({
    name: campaign?.name ?? "",
    sponsorId: campaign?.sponsorId ?? 0,
    slotId: campaign?.slotId ?? 0,
    creativeId: campaign?.creativeId ?? 0,
    tournamentId: campaign?.tournamentId ?? null as number | null,
    startDate: campaign ? new Date(campaign.startDate).toISOString().slice(0, 10) : today,
    endDate: campaign ? new Date(campaign.endDate).toISOString().slice(0, 10) : inThirty,
    weight: campaign?.weight ?? 50,
    frequencyCapPerSession: campaign?.frequencyCapPerSession ?? 0,
    isActive: campaign?.isActive ?? true,
    notes: campaign?.notes ?? "",
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{ detail: string; conflicts: Array<{ id: number; name: string; weight: number }> } | null>(null);

  const filteredCreatives = useMemo(() => creatives.filter(c => !form.sponsorId || c.sponsorId === form.sponsorId), [creatives, form.sponsorId]);

  const save = async (force = false) => {
    setErr(null); setConflict(null); setSaving(true);
    try {
      const body = { ...form, force };
      if (campaign) {
        await jsonFetch(`/api/organizations/${orgId}/ad-inventory/campaigns/${campaign.id}`, { method: "PATCH", body: JSON.stringify(body) });
      } else {
        await jsonFetch(`/api/organizations/${orgId}/ad-inventory/campaigns`, { method: "POST", body: JSON.stringify(body) });
      }
      onSaved();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && e.body && e.body.error === "campaign weight conflict") {
        setConflict({
          detail: typeof e.body.detail === "string" ? e.body.detail : e.message,
          conflicts: Array.isArray(e.body.conflicts) ? e.body.conflicts as Array<{ id: number; name: string; weight: number }> : [],
        });
      } else {
        setErr((e as Error).message);
      }
    } finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4">
      <div className="bg-card border border-white/10 rounded-xl max-w-2xl w-full p-6 space-y-4 max-h-[90vh] overflow-y-auto">
        <div className="flex justify-between items-center">
          <h2 className="font-bold">{campaign ? "Edit Campaign" : "New Campaign"}</h2>
          <button onClick={onClose}><X className="w-5 h-5" /></button>
        </div>
        <div className="space-y-3">
          <Field label="Name"><input className="input" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Sponsor">
              <select value={form.sponsorId} onChange={e => setForm({ ...form, sponsorId: parseInt(e.target.value), creativeId: 0 })} className="input">
                <option value="">Select…</option>
                {sponsors.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </Field>
            <Field label="Slot">
              <select value={form.slotId} onChange={e => setForm({ ...form, slotId: parseInt(e.target.value) })} className="input">
                <option value="">Select…</option>
                {slots.map(s => <option key={s.id} value={s.id}>{s.name} ({s.slotKey})</option>)}
              </select>
            </Field>
          </div>
          <Field label="Creative">
            <select value={form.creativeId} onChange={e => setForm({ ...form, creativeId: parseInt(e.target.value) })} className="input">
              <option value="">Select…</option>
              {filteredCreatives.map(c => <option key={c.id} value={c.id}>{c.name} ({c.mediaType})</option>)}
            </select>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Start"><input type="date" className="input" value={form.startDate} onChange={e => setForm({ ...form, startDate: e.target.value })} /></Field>
            <Field label="End"><input type="date" className="input" value={form.endDate} onChange={e => setForm({ ...form, endDate: e.target.value })} /></Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Weight (1–100, share of slot)">
              <input type="number" min={1} max={100} className="input" value={form.weight} onChange={e => setForm({ ...form, weight: parseInt(e.target.value) || 0 })} />
            </Field>
            <Field label="Frequency Cap (per session, 0 = unlimited)">
              <input type="number" min={0} className="input" value={form.frequencyCapPerSession} onChange={e => setForm({ ...form, frequencyCapPerSession: parseInt(e.target.value) || 0 })} />
            </Field>
          </div>
          <Field label="Notes (optional)">
            <textarea className="input" rows={2} value={form.notes ?? ""} onChange={e => setForm({ ...form, notes: e.target.value })} />
          </Field>
          <label className="flex gap-2 items-center text-sm">
            <input type="checkbox" checked={form.isActive} onChange={e => setForm({ ...form, isActive: e.target.checked })} /> Active
          </label>
        </div>
        {err && <p className="text-sm text-red-400">{err}</p>}
        {conflict && (
          <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-3 text-xs space-y-2">
            <p className="text-amber-300 font-medium">Weight conflict detected</p>
            <p className="text-muted-foreground">{conflict.detail}</p>
            {conflict.conflicts.length > 0 && (
              <ul className="list-disc pl-5 text-muted-foreground">
                {conflict.conflicts.map(c => <li key={c.id}>{c.name} (weight {c.weight})</li>)}
              </ul>
            )}
            <button onClick={() => save(true)} className="text-amber-400 hover:text-amber-300 underline text-xs">Save anyway</button>
          </div>
        )}
        <div className="flex gap-2 justify-end">
          <button onClick={onClose} className="px-4 py-2 text-sm">Cancel</button>
          <button onClick={() => save(false)} disabled={saving || !form.name || !form.sponsorId || !form.slotId || !form.creativeId} className="px-4 py-2 bg-amber-500 hover:bg-amber-600 text-black rounded text-sm font-medium disabled:opacity-50">
            {saving ? "Saving…" : "Save Campaign"}
          </button>
        </div>
      </div>
      <style>{`.input{width:100%;background:rgba(0,0,0,.3);border:1px solid rgba(255,255,255,.1);border-radius:6px;padding:8px 12px;font-size:14px;color:white;}`}</style>
    </div>
  );
}
