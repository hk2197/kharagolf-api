import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import {
  Calendar, ChevronLeft, Plus, Trash2, Edit2, RefreshCw,
  Clock, Settings, Shield, Users, Eye, AlertTriangle, CheckCircle2,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import { useGetMe } from "@workspace/api-client-react";
import { getLocale } from "@/i18n";

const GOLD = "#C9A84C";
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

async function safeJson(res: Response): Promise<Record<string, string>> {
  try { return await res.json(); } catch { return {}; }
}
const START_TYPES = [
  { value: "normal", label: "Normal (Hole 1)" },
  { value: "split_tee", label: "Split Tee (Holes 1 & 10)" },
  { value: "shotgun", label: "Shotgun (All Holes)" },
];
const BLOCK_REASONS = ["maintenance", "tournament", "private_event", "members_only", "weather", "other"];
const RECURRENCES = [
  { value: "one_off", label: "One-Off" },
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
];
const MEMBERSHIP_TIERS = [
  { value: "full_member", label: "Full Member" },
  { value: "social_member", label: "Social Member" },
  { value: "guest", label: "Guest" },
  { value: "public", label: "Public" },
];

interface Course { id: number; name: string; }
interface Template {
  id: number; name: string; courseId: number; daysOfWeek: number[];
  validFrom: string | null; validUntil: string | null; firstTeeTime: string;
  lastTeeTime: string; intervalMinutes: number; capacity: number;
  startType: string; isActive: boolean;
}
interface BlockRule {
  id: number; name: string; courseId: number | null; blockDate: string | null;
  startTime: string | null; endTime: string | null; reason: string;
  recurrence: string; recurrenceDayOfWeek: number | null; recurrenceDayOfMonth: number | null; isActive: boolean;
}
interface PlayerCountRule {
  id: number; name: string; courseId: number | null; minPlayers: number; maxPlayers: number;
  daysOfWeek: number[] | null; startTime: string | null; endTime: string | null;
  membershipTier: string | null; isActive: boolean;
}
interface BookingWindow { id: number; membershipTier: string; daysAhead: number; }
interface PreviewSlot { time: string; startingHole: number; startType: string; capacity: number; }
interface PreviewDay { date: string; slots: PreviewSlot[]; }

function DayPicker({ selected, onChange }: { selected: number[]; onChange: (d: number[]) => void }) {
  return (
    <div className="flex gap-1 flex-wrap">
      {DAYS.map((d, i) => (
        <button
          key={i}
          type="button"
          onClick={() => onChange(selected.includes(i) ? selected.filter(x => x !== i) : [...selected, i])}
          className={`px-2 py-1 rounded text-xs font-medium border transition-colors ${selected.includes(i) ? "text-black border-transparent" : "text-white/50 border-white/20 hover:border-white/40"}`}
          style={selected.includes(i) ? { background: GOLD } : {}}
        >{d}</button>
      ))}
    </div>
  );
}

function TemplatePreviewGrid({ preview }: { preview: PreviewDay[] }) {
  if (!preview.length) return null;
  const allTimes = Array.from(new Set(preview.flatMap(d => d.slots.map(s => s.time)))).sort();
  return (
    <div className="overflow-x-auto">
      <table className="text-xs w-full border-collapse">
        <thead>
          <tr>
            <th className="text-white/40 text-left px-2 py-1 border-b border-white/10">Time</th>
            {preview.map(d => (
              <th key={d.date} className="text-white/60 px-2 py-1 border-b border-white/10 font-normal">
                {new Date(d.date + "T12:00:00").toLocaleDateString(getLocale(), { weekday: "short", day: "numeric", month: "short" })}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {allTimes.map(time => (
            <tr key={time} className="border-b border-white/5">
              <td className="text-white/50 px-2 py-1 font-mono">{time}</td>
              {preview.map(d => {
                const daySlots = d.slots.filter(s => s.time === time);
                return (
                  <td key={d.date} className="px-2 py-1">
                    {daySlots.length > 0 ? (
                      <div className="flex gap-0.5 flex-wrap">
                        {daySlots.map((s, i) => (
                          <span key={i} className="px-1 rounded text-black text-[10px]" style={{ background: GOLD }}>
                            H{s.startingHole}
                          </span>
                        ))}
                      </div>
                    ) : <span className="text-white/20">—</span>}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function TeeSheetSettingsPage() {
  const [, navigate] = useLocation();
  const { data: user } = useGetMe();
  const orgId = user?.organizationId as number;
  const { toast } = useToast();

  const [courses, setCourses] = useState<Course[]>([]);
  const [selectedCourseId, setSelectedCourseId] = useState<number | null>(null);

  const [templates, setTemplates] = useState<Template[]>([]);
  const [blockRules, setBlockRules] = useState<BlockRule[]>([]);
  const [playerCountRules, setPlayerCountRules] = useState<PlayerCountRule[]>([]);
  const [bookingWindows, setBookingWindows] = useState<BookingWindow[]>([]);

  const [showTemplateForm, setShowTemplateForm] = useState(false);
  const [editTemplate, setEditTemplate] = useState<Template | null>(null);
  const [showBlockForm, setShowBlockForm] = useState(false);
  const [editBlock, setEditBlock] = useState<BlockRule | null>(null);
  const [showPlayerCountForm, setShowPlayerCountForm] = useState(false);
  const [editPlayerCount, setEditPlayerCount] = useState<PlayerCountRule | null>(null);

  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);

  const [previewData, setPreviewData] = useState<PreviewDay[] | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewFrom, setPreviewFrom] = useState(new Date().toISOString().split("T")[0]);
  const [previewTo, setPreviewTo] = useState(() => {
    const d = new Date(); d.setDate(d.getDate() + 6); return d.toISOString().split("T")[0];
  });

  const [regenFrom, setRegenFrom] = useState(new Date().toISOString().split("T")[0]);
  const [regenTo, setRegenTo] = useState(() => {
    const d = new Date(); d.setDate(d.getDate() + 6); return d.toISOString().split("T")[0];
  });
  const [regenLoading, setRegenLoading] = useState(false);

  const templateDefault = {
    name: "", courseId: selectedCourseId ?? 0, daysOfWeek: [0,1,2,3,4,5,6] as number[],
    validFrom: "", validUntil: "", firstTeeTime: "06:00", lastTeeTime: "18:00",
    intervalMinutes: 10, capacity: 4, startType: "normal", isActive: true,
  };
  const [templateForm, setTemplateForm] = useState(templateDefault);

  const blockDefault = {
    name: "", courseId: null as number | null, blockDate: "", startTime: "", endTime: "",
    reason: "maintenance", recurrence: "one_off", recurrenceDayOfWeek: null as number | null,
    recurrenceDayOfMonth: null as number | null, isActive: true,
  };
  const [blockForm, setBlockForm] = useState(blockDefault);

  const playerCountDefault = {
    name: "", courseId: null as number | null, minPlayers: 1, maxPlayers: 4,
    daysOfWeek: null as number[] | null, startTime: "", endTime: "",
    membershipTier: "" as string, isActive: true,
  };
  const [playerCountForm, setPlayerCountForm] = useState(playerCountDefault);

  useEffect(() => {
    if (!orgId) return;
    fetch(`/api/organizations/${orgId}/courses`, { credentials: "include" })
      .then(r => r.ok ? r.json() : [])
      .then((data: Course[]) => {
        setCourses(data);
        if (data.length > 0) setSelectedCourseId(data[0].id);
      });
  }, [orgId]);

  useEffect(() => {
    if (!orgId) return;
    loadAll();
  }, [orgId]);

  async function loadAll() {
    setLoading(true);
    try {
      const [tRes, bRes, pRes, wRes] = await Promise.all([
        fetch(`/api/organizations/${orgId}/tee-rules/templates`, { credentials: "include" }),
        fetch(`/api/organizations/${orgId}/tee-rules/block-rules`, { credentials: "include" }),
        fetch(`/api/organizations/${orgId}/tee-rules/player-count-rules`, { credentials: "include" }),
        fetch(`/api/organizations/${orgId}/tee-rules/booking-windows`, { credentials: "include" }),
      ]);
      if (tRes.ok) setTemplates(await tRes.json());
      if (bRes.ok) setBlockRules(await bRes.json());
      if (pRes.ok) setPlayerCountRules(await pRes.json());
      if (wRes.ok) setBookingWindows(await wRes.json());
    } finally { setLoading(false); }
  }

  async function saveTemplate() {
    setSaving(true);
    try {
      const body = {
        ...templateForm,
        courseId: templateForm.courseId || selectedCourseId,
        validFrom: templateForm.validFrom || null,
        validUntil: templateForm.validUntil || null,
      };
      const url = editTemplate
        ? `/api/organizations/${orgId}/tee-rules/templates/${editTemplate.id}`
        : `/api/organizations/${orgId}/tee-rules/templates`;
      const method = editTemplate ? "PATCH" : "POST";
      const res = await fetch(url, {
        method, credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) { const e = await safeJson(res); toast({ title: e.error ?? "Failed", variant: "destructive" }); return; }
      toast({ title: editTemplate ? "Template updated" : "Template created" });
      setShowTemplateForm(false); setEditTemplate(null);
      loadAll();
    } finally { setSaving(false); }
  }

  async function deleteTemplate(id: number) {
    if (!confirm("Delete this template? Future slot generation will no longer use it.")) return;
    await fetch(`/api/organizations/${orgId}/tee-rules/templates/${id}`, { method: "DELETE", credentials: "include" });
    loadAll();
  }

  async function saveBlock() {
    setSaving(true);
    try {
      const body = {
        ...blockForm,
        blockDate: blockForm.blockDate || null,
        startTime: blockForm.startTime || null,
        endTime: blockForm.endTime || null,
      };
      const url = editBlock
        ? `/api/organizations/${orgId}/tee-rules/block-rules/${editBlock.id}`
        : `/api/organizations/${orgId}/tee-rules/block-rules`;
      const method = editBlock ? "PATCH" : "POST";
      const res = await fetch(url, {
        method, credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) { const e = await safeJson(res); toast({ title: e.error ?? "Failed", variant: "destructive" }); return; }
      toast({ title: editBlock ? "Block rule updated" : "Block rule created" });
      setShowBlockForm(false); setEditBlock(null);
      loadAll();
    } finally { setSaving(false); }
  }

  async function deleteBlock(id: number) {
    if (!confirm("Delete this block rule?")) return;
    await fetch(`/api/organizations/${orgId}/tee-rules/block-rules/${id}`, { method: "DELETE", credentials: "include" });
    loadAll();
  }

  async function savePlayerCount() {
    setSaving(true);
    try {
      const body = {
        ...playerCountForm,
        daysOfWeek: playerCountForm.daysOfWeek?.length ? playerCountForm.daysOfWeek : null,
        startTime: playerCountForm.startTime || null,
        endTime: playerCountForm.endTime || null,
        membershipTier: playerCountForm.membershipTier || null,
      };
      const url = editPlayerCount
        ? `/api/organizations/${orgId}/tee-rules/player-count-rules/${editPlayerCount.id}`
        : `/api/organizations/${orgId}/tee-rules/player-count-rules`;
      const method = editPlayerCount ? "PATCH" : "POST";
      const res = await fetch(url, {
        method, credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) { const e = await safeJson(res); toast({ title: e.error ?? "Failed", variant: "destructive" }); return; }
      toast({ title: editPlayerCount ? "Rule updated" : "Rule created" });
      setShowPlayerCountForm(false); setEditPlayerCount(null);
      loadAll();
    } finally { setSaving(false); }
  }

  async function deletePlayerCount(id: number) {
    if (!confirm("Delete this player count rule?")) return;
    await fetch(`/api/organizations/${orgId}/tee-rules/player-count-rules/${id}`, { method: "DELETE", credentials: "include" });
    loadAll();
  }

  async function upsertBookingWindow(tier: string, daysAhead: number) {
    const res = await fetch(`/api/organizations/${orgId}/tee-rules/booking-windows`, {
      method: "PUT", credentials: "include", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ membershipTier: tier, daysAhead }),
    });
    if (!res.ok) { const e = await res.json(); toast({ title: e.error ?? "Failed", variant: "destructive" }); return; }
    toast({ title: "Booking window saved" });
    loadAll();
  }

  async function runPreview() {
    if (!selectedCourseId) { toast({ title: "Select a course first", variant: "destructive" }); return; }
    setPreviewLoading(true);
    try {
      const res = await fetch(`/api/organizations/${orgId}/tee-rules/templates/preview`, {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ courseId: selectedCourseId, fromDate: previewFrom, toDate: previewTo }),
      });
      if (res.ok) { const data = await res.json(); setPreviewData(data.preview); }
      else { const e = await safeJson(res); toast({ title: e.error ?? "Preview failed", variant: "destructive" }); }
    } finally { setPreviewLoading(false); }
  }

  async function runRegenerate() {
    if (!selectedCourseId) { toast({ title: "Select a course first", variant: "destructive" }); return; }
    if (!confirm("This will regenerate open (unbooked) slots for the selected date range. Slots with bookings will not be touched. Continue?")) return;
    setRegenLoading(true);
    try {
      const res = await fetch(`/api/organizations/${orgId}/tee-rules/templates/regenerate`, {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ courseId: selectedCourseId, fromDate: regenFrom, toDate: regenTo }),
      });
      if (res.ok) {
        const data = await res.json();
        toast({ title: `Re-generation complete: ${data.totalCreated} slots created across ${data.daysProcessed} days` });
      } else {
        const e = await safeJson(res); toast({ title: e.error ?? "Re-generation failed", variant: "destructive" });
      }
    } finally { setRegenLoading(false); }
  }

  const courseName = (id: number | null) => courses.find(c => c.id === id)?.name ?? "All Courses";

  return (
    <div className="min-h-screen bg-[#0a0f1a] text-white p-4 md:p-8">
      <div className="max-w-5xl mx-auto space-y-6">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={() => navigate("/tee-bookings")}>
            <ChevronLeft className="w-5 h-5" />
          </Button>
          <div>
            <h1 className="text-2xl font-bold">Tee Sheet Settings</h1>
            <p className="text-white/50 text-sm">Schedule templates, blackouts, player rules, and booking windows</p>
          </div>
        </div>

        {courses.length > 0 && (
          <div className="flex items-center gap-2">
            <Label className="text-white/40 text-xs">Course:</Label>
            <select
              value={selectedCourseId ?? ""}
              onChange={e => setSelectedCourseId(parseInt(e.target.value))}
              className="bg-[#111827] border border-white/20 text-white rounded-md px-3 py-1.5 text-sm"
            >
              {courses.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
        )}

        {loading ? (
          <div className="flex justify-center py-20"><RefreshCw className="w-8 h-8 animate-spin text-white/30" /></div>
        ) : (
          <Tabs defaultValue="templates">
            <TabsList className="bg-[#111827] border border-white/10">
              <TabsTrigger value="templates" className="data-[state=active]:text-black" style={{ "--tw-bg-opacity": 1 } as React.CSSProperties}>
                <Calendar className="w-4 h-4 mr-1" /> Schedule Templates
              </TabsTrigger>
              <TabsTrigger value="blocks">
                <Shield className="w-4 h-4 mr-1" /> Blackout Rules
              </TabsTrigger>
              <TabsTrigger value="player-count">
                <Users className="w-4 h-4 mr-1" /> Player Count Rules
              </TabsTrigger>
              <TabsTrigger value="windows">
                <Clock className="w-4 h-4 mr-1" /> Booking Windows
              </TabsTrigger>
            </TabsList>

            {/* ── SCHEDULE TEMPLATES TAB ── */}
            <TabsContent value="templates" className="space-y-4 mt-4">
              <div className="flex items-center justify-between">
                <p className="text-white/50 text-sm">Templates drive automated slot generation. The nightly job materialises slots 60 days ahead.</p>
                <Button size="sm" style={{ background: GOLD, color: "#000" }} onClick={() => { setTemplateForm({ ...templateDefault, courseId: selectedCourseId ?? 0 }); setEditTemplate(null); setShowTemplateForm(true); }}>
                  <Plus className="w-4 h-4 mr-1" /> Add Template
                </Button>
              </div>

              {templates.length === 0 && (
                <Card className="bg-[#111827] border-[#1e2d3d] p-8 text-center">
                  <Calendar className="w-8 h-8 mx-auto mb-3 text-white/20" />
                  <p className="text-white/40">No schedule templates yet. Create one to start generating slots automatically.</p>
                </Card>
              )}

              <div className="space-y-3">
                {templates.map(t => (
                  <Card key={t.id} className="bg-[#111827] border-[#1e2d3d]">
                    <CardContent className="pt-4">
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex-1">
                          <div className="flex items-center gap-2 mb-1">
                            <span className="font-semibold text-white">{t.name}</span>
                            {t.isActive
                              ? <Badge className="text-[10px] bg-emerald-500/20 text-emerald-400 border-emerald-500/30">Active</Badge>
                              : <Badge className="text-[10px] bg-white/10 text-white/40">Inactive</Badge>}
                            <Badge className="text-[10px] bg-white/10 text-white/60">{START_TYPES.find(s => s.value === t.startType)?.label ?? t.startType}</Badge>
                          </div>
                          <div className="text-white/50 text-sm space-y-0.5">
                            <div>Course: {courseName(t.courseId)} · Interval: {t.intervalMinutes}min · Capacity: {t.capacity} · {t.firstTeeTime}–{t.lastTeeTime}</div>
                            <div>Days: {(Array.isArray(t.daysOfWeek) ? t.daysOfWeek as number[] : []).map(d => DAYS[d]).join(", ")}</div>
                            {(t.validFrom || t.validUntil) && (
                              <div>Valid: {t.validFrom ? new Date(t.validFrom).toLocaleDateString() : "—"} to {t.validUntil ? new Date(t.validUntil).toLocaleDateString() : "—"}</div>
                            )}
                          </div>
                        </div>
                        <div className="flex gap-2">
                          <Button size="sm" variant="outline" className="border-white/20" onClick={() => { setTemplateForm({ name: t.name, courseId: t.courseId, daysOfWeek: Array.isArray(t.daysOfWeek) ? t.daysOfWeek as number[] : [], validFrom: t.validFrom?.split("T")[0] ?? "", validUntil: t.validUntil?.split("T")[0] ?? "", firstTeeTime: t.firstTeeTime, lastTeeTime: t.lastTeeTime, intervalMinutes: t.intervalMinutes, capacity: t.capacity, startType: t.startType, isActive: t.isActive }); setEditTemplate(t); setShowTemplateForm(true); }}>
                            <Edit2 className="w-3.5 h-3.5" />
                          </Button>
                          <Button size="sm" variant="outline" className="border-red-500/30 text-red-400 hover:text-red-300" onClick={() => deleteTemplate(t.id)}>
                            <Trash2 className="w-3.5 h-3.5" />
                          </Button>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>

              {/* Preview and Re-generation */}
              <Card className="bg-[#111827] border-[#1e2d3d]">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm text-white/60 uppercase tracking-wider flex items-center gap-2">
                    <Eye className="w-4 h-4" /> Template Preview
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex flex-wrap gap-3 items-end">
                    <div>
                      <Label className="text-xs text-white/40">From</Label>
                      <Input type="date" value={previewFrom} onChange={e => setPreviewFrom(e.target.value)} className="bg-white/5 border-white/20 text-white h-8 text-sm w-36" />
                    </div>
                    <div>
                      <Label className="text-xs text-white/40">To</Label>
                      <Input type="date" value={previewTo} onChange={e => setPreviewTo(e.target.value)} className="bg-white/5 border-white/20 text-white h-8 text-sm w-36" />
                    </div>
                    <Button size="sm" variant="outline" className="border-white/20" onClick={runPreview} disabled={previewLoading}>
                      {previewLoading ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Eye className="w-3.5 h-3.5 mr-1" />}
                      Preview
                    </Button>
                  </div>
                  {previewData && <TemplatePreviewGrid preview={previewData} />}
                </CardContent>
              </Card>

              <Card className="bg-[#111827] border-amber-500/20">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm text-amber-400/80 uppercase tracking-wider flex items-center gap-2">
                    <RefreshCw className="w-4 h-4" /> Safe Re-generation
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <p className="text-white/40 text-xs">Re-generates open (unbooked) slots from templates. Slots with existing bookings are never touched.</p>
                  <div className="flex flex-wrap gap-3 items-end">
                    <div>
                      <Label className="text-xs text-white/40">From</Label>
                      <Input type="date" value={regenFrom} onChange={e => setRegenFrom(e.target.value)} className="bg-white/5 border-white/20 text-white h-8 text-sm w-36" />
                    </div>
                    <div>
                      <Label className="text-xs text-white/40">To</Label>
                      <Input type="date" value={regenTo} onChange={e => setRegenTo(e.target.value)} className="bg-white/5 border-white/20 text-white h-8 text-sm w-36" />
                    </div>
                    <Button size="sm" className="border-amber-500/30 text-amber-400 bg-amber-500/10 hover:bg-amber-500/20" variant="outline" onClick={runRegenerate} disabled={regenLoading}>
                      {regenLoading ? <RefreshCw className="w-3.5 h-3.5 animate-spin mr-1" /> : <RefreshCw className="w-3.5 h-3.5 mr-1" />}
                      Re-generate
                    </Button>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            {/* ── BLACKOUT RULES TAB ── */}
            <TabsContent value="blocks" className="space-y-4 mt-4">
              <div className="flex items-center justify-between">
                <p className="text-white/50 text-sm">Block rules prevent slot generation or booking for specific dates, times, or recurring periods.</p>
                <Button size="sm" style={{ background: GOLD, color: "#000" }} onClick={() => { setBlockForm(blockDefault); setEditBlock(null); setShowBlockForm(true); }}>
                  <Plus className="w-4 h-4 mr-1" /> Add Block Rule
                </Button>
              </div>
              {blockRules.length === 0 && (
                <Card className="bg-[#111827] border-[#1e2d3d] p-8 text-center">
                  <Shield className="w-8 h-8 mx-auto mb-3 text-white/20" />
                  <p className="text-white/40">No blackout rules configured.</p>
                </Card>
              )}
              <div className="space-y-3">
                {blockRules.map(r => (
                  <Card key={r.id} className="bg-[#111827] border-[#1e2d3d]">
                    <CardContent className="pt-4">
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex-1">
                          <div className="flex items-center gap-2 mb-1">
                            <span className="font-semibold text-white">{r.name}</span>
                            <Badge className="text-[10px] bg-red-500/20 text-red-400 border-red-500/30 capitalize">{r.reason.replace("_", " ")}</Badge>
                            <Badge className="text-[10px] bg-white/10 text-white/60 capitalize">{r.recurrence.replace("_", " ")}</Badge>
                            {!r.isActive && <Badge className="text-[10px] bg-white/10 text-white/30">Inactive</Badge>}
                          </div>
                          <div className="text-white/50 text-sm">
                            {r.courseId ? `Course: ${courseName(r.courseId)}` : "All Courses"}
                            {r.blockDate && ` · ${new Date(r.blockDate).toLocaleDateString()}`}
                            {r.recurrence === "weekly" && r.recurrenceDayOfWeek != null && ` · Every ${DAYS[r.recurrenceDayOfWeek]}`}
                            {r.recurrence === "monthly" && r.recurrenceDayOfMonth != null && ` · Day ${r.recurrenceDayOfMonth} of month`}
                            {r.startTime && r.endTime && ` · ${r.startTime}–${r.endTime}`}
                          </div>
                        </div>
                        <div className="flex gap-2">
                          <Button size="sm" variant="outline" className="border-white/20" onClick={() => { setBlockForm({ name: r.name, courseId: r.courseId, blockDate: r.blockDate?.split("T")[0] ?? "", startTime: r.startTime ?? "", endTime: r.endTime ?? "", reason: r.reason, recurrence: r.recurrence, recurrenceDayOfWeek: r.recurrenceDayOfWeek, recurrenceDayOfMonth: r.recurrenceDayOfMonth, isActive: r.isActive }); setEditBlock(r); setShowBlockForm(true); }}>
                            <Edit2 className="w-3.5 h-3.5" />
                          </Button>
                          <Button size="sm" variant="outline" className="border-red-500/30 text-red-400 hover:text-red-300" onClick={() => deleteBlock(r.id)}>
                            <Trash2 className="w-3.5 h-3.5" />
                          </Button>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </TabsContent>

            {/* ── PLAYER COUNT RULES TAB ── */}
            <TabsContent value="player-count" className="space-y-4 mt-4">
              <div className="flex items-center justify-between">
                <p className="text-white/50 text-sm">Define min/max players by day, time, and membership tier (e.g. "No singles before noon on weekends").</p>
                <Button size="sm" style={{ background: GOLD, color: "#000" }} onClick={() => { setPlayerCountForm(playerCountDefault); setEditPlayerCount(null); setShowPlayerCountForm(true); }}>
                  <Plus className="w-4 h-4 mr-1" /> Add Rule
                </Button>
              </div>
              {playerCountRules.length === 0 && (
                <Card className="bg-[#111827] border-[#1e2d3d] p-8 text-center">
                  <Users className="w-8 h-8 mx-auto mb-3 text-white/20" />
                  <p className="text-white/40">No player count rules configured.</p>
                </Card>
              )}
              <div className="space-y-3">
                {playerCountRules.map(r => (
                  <Card key={r.id} className="bg-[#111827] border-[#1e2d3d]">
                    <CardContent className="pt-4">
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex-1">
                          <div className="flex items-center gap-2 mb-1">
                            <span className="font-semibold text-white">{r.name}</span>
                            <Badge className="text-[10px] bg-blue-500/20 text-blue-400">{r.minPlayers}–{r.maxPlayers} players</Badge>
                            {r.membershipTier && <Badge className="text-[10px] bg-white/10 text-white/60 capitalize">{r.membershipTier.replace("_", " ")}</Badge>}
                            {!r.isActive && <Badge className="text-[10px] bg-white/10 text-white/30">Inactive</Badge>}
                          </div>
                          <div className="text-white/50 text-sm">
                            {r.courseId ? `Course: ${courseName(r.courseId)}` : "All Courses"}
                            {r.daysOfWeek?.length ? ` · ${(r.daysOfWeek as number[]).map(d => DAYS[d]).join(", ")}` : " · All days"}
                            {r.startTime && r.endTime && ` · ${r.startTime}–${r.endTime}`}
                          </div>
                        </div>
                        <div className="flex gap-2">
                          <Button size="sm" variant="outline" className="border-white/20" onClick={() => { setPlayerCountForm({ name: r.name, courseId: r.courseId, minPlayers: r.minPlayers, maxPlayers: r.maxPlayers, daysOfWeek: Array.isArray(r.daysOfWeek) ? r.daysOfWeek as number[] : null, startTime: r.startTime ?? "", endTime: r.endTime ?? "", membershipTier: r.membershipTier ?? "", isActive: r.isActive }); setEditPlayerCount(r); setShowPlayerCountForm(true); }}>
                            <Edit2 className="w-3.5 h-3.5" />
                          </Button>
                          <Button size="sm" variant="outline" className="border-red-500/30 text-red-400 hover:text-red-300" onClick={() => deletePlayerCount(r.id)}>
                            <Trash2 className="w-3.5 h-3.5" />
                          </Button>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </TabsContent>

            {/* ── BOOKING WINDOWS TAB ── */}
            <TabsContent value="windows" className="space-y-4 mt-4">
              <p className="text-white/50 text-sm">Configure how many days in advance each membership tier can book a tee time.</p>
              <div className="space-y-3">
                {MEMBERSHIP_TIERS.map(tier => {
                  const existing = bookingWindows.find(w => w.membershipTier === tier.value);
                  return <BookingWindowRow key={tier.value} tier={tier} existing={existing} onSave={(days) => upsertBookingWindow(tier.value, days)} />;
                })}
              </div>
            </TabsContent>
          </Tabs>
        )}
      </div>

      {/* ── TEMPLATE FORM DIALOG ── */}
      <Dialog open={showTemplateForm} onOpenChange={setShowTemplateForm}>
        <DialogContent className="bg-[#111827] border-[#1e2d3d] text-white max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editTemplate ? "Edit Template" : "New Schedule Template"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label className="text-xs text-white/50">Template Name *</Label>
              <Input value={templateForm.name} onChange={e => setTemplateForm(f => ({ ...f, name: e.target.value }))} className="bg-white/5 border-white/20 text-white" placeholder="e.g. Weekday Standard" />
            </div>
            <div>
              <Label className="text-xs text-white/50">Course *</Label>
              <select value={templateForm.courseId || ""} onChange={e => setTemplateForm(f => ({ ...f, courseId: parseInt(e.target.value) }))} className="w-full bg-[#0a0f1a] border border-white/20 text-white rounded-md px-3 py-2 text-sm">
                {courses.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div>
              <Label className="text-xs text-white/50">Days of Week</Label>
              <DayPicker selected={templateForm.daysOfWeek} onChange={d => setTemplateForm(f => ({ ...f, daysOfWeek: d }))} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs text-white/50">First Tee Time</Label>
                <Input type="time" value={templateForm.firstTeeTime} onChange={e => setTemplateForm(f => ({ ...f, firstTeeTime: e.target.value }))} className="bg-white/5 border-white/20 text-white" />
              </div>
              <div>
                <Label className="text-xs text-white/50">Last Tee Time</Label>
                <Input type="time" value={templateForm.lastTeeTime} onChange={e => setTemplateForm(f => ({ ...f, lastTeeTime: e.target.value }))} className="bg-white/5 border-white/20 text-white" />
              </div>
              <div>
                <Label className="text-xs text-white/50">Interval (min)</Label>
                <Input type="number" min={5} max={60} value={templateForm.intervalMinutes} onChange={e => setTemplateForm(f => ({ ...f, intervalMinutes: parseInt(e.target.value) }))} className="bg-white/5 border-white/20 text-white" />
              </div>
              <div>
                <Label className="text-xs text-white/50">Capacity per Slot</Label>
                <Input type="number" min={1} max={8} value={templateForm.capacity} onChange={e => setTemplateForm(f => ({ ...f, capacity: parseInt(e.target.value) }))} className="bg-white/5 border-white/20 text-white" />
              </div>
            </div>
            <div>
              <Label className="text-xs text-white/50">Start Type</Label>
              <select value={templateForm.startType} onChange={e => setTemplateForm(f => ({ ...f, startType: e.target.value }))} className="w-full bg-[#0a0f1a] border border-white/20 text-white rounded-md px-3 py-2 text-sm">
                {START_TYPES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs text-white/50">Valid From (optional)</Label>
                <Input type="date" value={templateForm.validFrom} onChange={e => setTemplateForm(f => ({ ...f, validFrom: e.target.value }))} className="bg-white/5 border-white/20 text-white" />
              </div>
              <div>
                <Label className="text-xs text-white/50">Valid Until (optional)</Label>
                <Input type="date" value={templateForm.validUntil} onChange={e => setTemplateForm(f => ({ ...f, validUntil: e.target.value }))} className="bg-white/5 border-white/20 text-white" />
              </div>
            </div>
            <div className="flex items-center gap-2">
              <input type="checkbox" id="tActive" checked={templateForm.isActive} onChange={e => setTemplateForm(f => ({ ...f, isActive: e.target.checked }))} />
              <Label htmlFor="tActive" className="text-sm cursor-pointer">Active (enabled for slot generation)</Label>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => { setShowTemplateForm(false); setEditTemplate(null); }}>Cancel</Button>
            <Button style={{ background: GOLD, color: "#000" }} onClick={saveTemplate} disabled={saving || !templateForm.name}>
              {saving ? <RefreshCw className="w-4 h-4 animate-spin mr-1" /> : null}{editTemplate ? "Update" : "Create"} Template
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── BLOCK RULE FORM DIALOG ── */}
      <Dialog open={showBlockForm} onOpenChange={setShowBlockForm}>
        <DialogContent className="bg-[#111827] border-[#1e2d3d] text-white max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editBlock ? "Edit Block Rule" : "New Blackout Rule"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label className="text-xs text-white/50">Rule Name *</Label>
              <Input value={blockForm.name} onChange={e => setBlockForm(f => ({ ...f, name: e.target.value }))} className="bg-white/5 border-white/20 text-white" placeholder="e.g. Annual Tournament Week" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs text-white/50">Reason</Label>
                <select value={blockForm.reason} onChange={e => setBlockForm(f => ({ ...f, reason: e.target.value }))} className="w-full bg-[#0a0f1a] border border-white/20 text-white rounded-md px-3 py-2 text-sm capitalize">
                  {BLOCK_REASONS.map(r => <option key={r} value={r}>{r.replace("_", " ")}</option>)}
                </select>
              </div>
              <div>
                <Label className="text-xs text-white/50">Recurrence</Label>
                <select value={blockForm.recurrence} onChange={e => setBlockForm(f => ({ ...f, recurrence: e.target.value }))} className="w-full bg-[#0a0f1a] border border-white/20 text-white rounded-md px-3 py-2 text-sm">
                  {RECURRENCES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
                </select>
              </div>
            </div>
            {blockForm.recurrence === "one_off" && (
              <div>
                <Label className="text-xs text-white/50">Date</Label>
                <Input type="date" value={blockForm.blockDate} onChange={e => setBlockForm(f => ({ ...f, blockDate: e.target.value }))} className="bg-white/5 border-white/20 text-white" />
              </div>
            )}
            {blockForm.recurrence === "weekly" && (
              <div>
                <Label className="text-xs text-white/50">Day of Week</Label>
                <select value={blockForm.recurrenceDayOfWeek ?? ""} onChange={e => setBlockForm(f => ({ ...f, recurrenceDayOfWeek: e.target.value !== "" ? parseInt(e.target.value) : null }))} className="w-full bg-[#0a0f1a] border border-white/20 text-white rounded-md px-3 py-2 text-sm">
                  <option value="">Select day</option>
                  {DAYS.map((d, i) => <option key={i} value={i}>{d}</option>)}
                </select>
              </div>
            )}
            {blockForm.recurrence === "monthly" && (
              <div>
                <Label className="text-xs text-white/50">Day of Month (1–31)</Label>
                <Input type="number" min={1} max={31} value={blockForm.recurrenceDayOfMonth ?? ""} onChange={e => setBlockForm(f => ({ ...f, recurrenceDayOfMonth: e.target.value ? parseInt(e.target.value) : null }))} className="bg-white/5 border-white/20 text-white" />
              </div>
            )}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs text-white/50">Start Time (optional, for partial day)</Label>
                <Input type="time" value={blockForm.startTime} onChange={e => setBlockForm(f => ({ ...f, startTime: e.target.value }))} className="bg-white/5 border-white/20 text-white" />
              </div>
              <div>
                <Label className="text-xs text-white/50">End Time (optional)</Label>
                <Input type="time" value={blockForm.endTime} onChange={e => setBlockForm(f => ({ ...f, endTime: e.target.value }))} className="bg-white/5 border-white/20 text-white" />
              </div>
            </div>
            <div>
              <Label className="text-xs text-white/50">Course (leave blank for all courses)</Label>
              <select value={blockForm.courseId ?? ""} onChange={e => setBlockForm(f => ({ ...f, courseId: e.target.value ? parseInt(e.target.value) : null }))} className="w-full bg-[#0a0f1a] border border-white/20 text-white rounded-md px-3 py-2 text-sm">
                <option value="">All Courses</option>
                {courses.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div className="flex items-center gap-2">
              <input type="checkbox" id="bActive" checked={blockForm.isActive} onChange={e => setBlockForm(f => ({ ...f, isActive: e.target.checked }))} />
              <Label htmlFor="bActive" className="text-sm cursor-pointer">Active</Label>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => { setShowBlockForm(false); setEditBlock(null); }}>Cancel</Button>
            <Button style={{ background: GOLD, color: "#000" }} onClick={saveBlock} disabled={saving || !blockForm.name}>
              {saving ? <RefreshCw className="w-4 h-4 animate-spin mr-1" /> : null}{editBlock ? "Update" : "Create"} Block Rule
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── PLAYER COUNT RULE FORM DIALOG ── */}
      <Dialog open={showPlayerCountForm} onOpenChange={setShowPlayerCountForm}>
        <DialogContent className="bg-[#111827] border-[#1e2d3d] text-white max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editPlayerCount ? "Edit Player Count Rule" : "New Player Count Rule"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label className="text-xs text-white/50">Rule Name *</Label>
              <Input value={playerCountForm.name} onChange={e => setPlayerCountForm(f => ({ ...f, name: e.target.value }))} className="bg-white/5 border-white/20 text-white" placeholder="e.g. No Singles Before Noon on Weekends" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs text-white/50">Min Players</Label>
                <Input type="number" min={1} max={8} value={playerCountForm.minPlayers} onChange={e => setPlayerCountForm(f => ({ ...f, minPlayers: parseInt(e.target.value) }))} className="bg-white/5 border-white/20 text-white" />
              </div>
              <div>
                <Label className="text-xs text-white/50">Max Players</Label>
                <Input type="number" min={1} max={8} value={playerCountForm.maxPlayers} onChange={e => setPlayerCountForm(f => ({ ...f, maxPlayers: parseInt(e.target.value) }))} className="bg-white/5 border-white/20 text-white" />
              </div>
            </div>
            <div>
              <Label className="text-xs text-white/50">Days of Week (leave blank for all days)</Label>
              <DayPicker selected={playerCountForm.daysOfWeek ?? []} onChange={d => setPlayerCountForm(f => ({ ...f, daysOfWeek: d.length ? d : null }))} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs text-white/50">Start Time (optional)</Label>
                <Input type="time" value={playerCountForm.startTime} onChange={e => setPlayerCountForm(f => ({ ...f, startTime: e.target.value }))} className="bg-white/5 border-white/20 text-white" />
              </div>
              <div>
                <Label className="text-xs text-white/50">End Time (optional)</Label>
                <Input type="time" value={playerCountForm.endTime} onChange={e => setPlayerCountForm(f => ({ ...f, endTime: e.target.value }))} className="bg-white/5 border-white/20 text-white" />
              </div>
            </div>
            <div>
              <Label className="text-xs text-white/50">Membership Tier (leave blank for all tiers)</Label>
              <select value={playerCountForm.membershipTier} onChange={e => setPlayerCountForm(f => ({ ...f, membershipTier: e.target.value }))} className="w-full bg-[#0a0f1a] border border-white/20 text-white rounded-md px-3 py-2 text-sm">
                <option value="">All Tiers</option>
                {MEMBERSHIP_TIERS.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </div>
            <div>
              <Label className="text-xs text-white/50">Course (leave blank for all courses)</Label>
              <select value={playerCountForm.courseId ?? ""} onChange={e => setPlayerCountForm(f => ({ ...f, courseId: e.target.value ? parseInt(e.target.value) : null }))} className="w-full bg-[#0a0f1a] border border-white/20 text-white rounded-md px-3 py-2 text-sm">
                <option value="">All Courses</option>
                {courses.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div className="flex items-center gap-2">
              <input type="checkbox" id="pcActive" checked={playerCountForm.isActive} onChange={e => setPlayerCountForm(f => ({ ...f, isActive: e.target.checked }))} />
              <Label htmlFor="pcActive" className="text-sm cursor-pointer">Active</Label>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => { setShowPlayerCountForm(false); setEditPlayerCount(null); }}>Cancel</Button>
            <Button style={{ background: GOLD, color: "#000" }} onClick={savePlayerCount} disabled={saving || !playerCountForm.name}>
              {saving ? <RefreshCw className="w-4 h-4 animate-spin mr-1" /> : null}{editPlayerCount ? "Update" : "Create"} Rule
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function BookingWindowRow({ tier, existing, onSave }: { tier: { value: string; label: string }; existing?: BookingWindow; onSave: (days: number) => void }) {
  const [editing, setEditing] = useState(false);
  const [days, setDays] = useState(existing?.daysAhead ?? 30);

  useEffect(() => { if (existing) setDays(existing.daysAhead); }, [existing]);

  return (
    <Card className="bg-[#111827] border-[#1e2d3d]">
      <CardContent className="pt-4">
        <div className="flex items-center justify-between gap-4">
          <div className="flex-1">
            <div className="flex items-center gap-2 mb-1">
              <span className="font-semibold text-white">{tier.label}</span>
              {existing ? (
                <Badge className="text-[10px] bg-emerald-500/20 text-emerald-400">{existing.daysAhead} days ahead</Badge>
              ) : (
                <Badge className="text-[10px] bg-white/10 text-white/40">Not configured (no limit)</Badge>
              )}
            </div>
            <p className="text-white/40 text-xs">{tier.label}s can book tee times up to {existing ? `${existing.daysAhead} days` : "unlimited days"} in advance.</p>
          </div>
          {editing ? (
            <div className="flex items-center gap-2">
              <Input
                type="number" min={1} max={365} value={days}
                onChange={e => setDays(parseInt(e.target.value))}
                className="bg-white/5 border-white/20 text-white w-20 h-8 text-sm"
              />
              <span className="text-white/40 text-sm">days</span>
              <Button size="sm" style={{ background: GOLD, color: "#000" }} onClick={() => { onSave(days); setEditing(false); }}>Save</Button>
              <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
            </div>
          ) : (
            <Button size="sm" variant="outline" className="border-white/20" onClick={() => setEditing(true)}>
              <Edit2 className="w-3.5 h-3.5 mr-1" /> Edit
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
