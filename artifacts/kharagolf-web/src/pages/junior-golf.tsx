import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useActiveOrgId } from "@/context/ActiveOrgContext";
import {
  Users, Award, BookOpen, Calendar, Plus, ChevronRight, Trash2,
  ClipboardList, Star, BarChart2, GraduationCap, CheckCircle2, XCircle, UserPlus,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { AppLayout } from "@/components/layout";

const BASE_URL = (import.meta.env.BASE_URL ?? "/").replace(/\/$/, "");
function API(path: string) { return `${BASE_URL}/api${path}`; }

const AGE_CATEGORIES = [
  { value: "under_8", label: "Under 8" },
  { value: "under_10", label: "Under 10" },
  { value: "under_12", label: "Under 12" },
  { value: "under_14", label: "Under 14" },
  { value: "under_16", label: "Under 16" },
  { value: "under_18", label: "Under 18" },
];

const PATHWAY_LEVELS = [
  { value: "beginner", label: "Beginner" },
  { value: "intermediate", label: "Intermediate" },
  { value: "advanced", label: "Advanced" },
  { value: "elite", label: "Elite" },
];

const AWARD_TYPES = [
  { value: "monthly_winner", label: "Monthly Winner" },
  { value: "most_improved", label: "Most Improved" },
  { value: "best_attendance", label: "Best Attendance" },
  { value: "spirit_award", label: "Spirit Award" },
  { value: "custom", label: "Custom" },
];

function ageCategoryLabel(val: string) {
  return AGE_CATEGORIES.find(a => a.value === val)?.label ?? val;
}
function pathwayLevelLabel(val: string) {
  return PATHWAY_LEVELS.find(l => l.value === val)?.label ?? val;
}
function levelBadgeColor(level: string) {
  switch (level) {
    case "beginner": return "bg-blue-500/20 text-blue-400 border-blue-500/30";
    case "intermediate": return "bg-yellow-500/20 text-yellow-400 border-yellow-500/30";
    case "advanced": return "bg-orange-500/20 text-orange-400 border-orange-500/30";
    case "elite": return "bg-purple-500/20 text-purple-400 border-purple-500/30";
    default: return "bg-gray-500/20 text-gray-400 border-gray-500/30";
  }
}

interface JuniorProfile {
  id: number;
  firstName: string;
  lastName: string;
  dateOfBirth: string;
  ageCategory: string;
  pathwayLevel: string;
  handicapIndex: string | null;
  isActive: boolean;
}

interface JuniorProgram {
  id: number;
  name: string;
  description: string | null;
  startDate: string | null;
  endDate: string | null;
  maxParticipants: number | null;
  ageCategories: string[];
  isActive: boolean;
  participantCount: number;
}

interface ProgramSession {
  id: number;
  title: string;
  scheduledAt: string;
  durationMinutes: number;
  location: string | null;
  coachName: string | null;
}

interface ProgramParticipant {
  id: number;
  juniorProfileId: number;
  firstName: string;
  lastName: string;
  ageCategory: string;
  pathwayLevel: string;
  handicapIndex: string | null;
}

interface ProgramDetail extends JuniorProgram {
  sessions: ProgramSession[];
  participants: ProgramParticipant[];
}

interface AttendanceRecord {
  id: number;
  juniorProfileId: number;
  attended: boolean;
  firstName: string;
  lastName: string;
  ageCategory: string;
}

interface LeaderboardRow {
  juniorProfileId: number;
  firstName: string;
  lastName: string;
  ageCategory: string;
  pathwayLevel: string;
  handicapIndex: string | null;
  roundsPlayed: number;
  avgGross: number | null;
  bestGross: number | null;
}

interface JuniorAward {
  id: number;
  awardType: string;
  ageCategory: string | null;
  awardLabel: string;
  description: string | null;
  awardedAt: string;
  firstName: string;
  lastName: string;
}

// ─── Add Profile Dialog ───────────────────────────────────────────────────────
function AddProfileDialog({ orgId, onSuccess }: { orgId: number; onSuccess: () => void }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ firstName: "", lastName: "", dateOfBirth: "", ageCategory: "", pathwayLevel: "beginner", handicapIndex: "" });
  const { toast } = useToast();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const res = await fetch(API(`/organizations/${orgId}/junior/profiles`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        ...form,
        handicapIndex: form.handicapIndex ? parseFloat(form.handicapIndex) : null,
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      toast({ title: "Error", description: err.error ?? "Failed to create profile", variant: "destructive" });
      return;
    }
    toast({ title: "Junior profile created" });
    setOpen(false);
    setForm({ firstName: "", lastName: "", dateOfBirth: "", ageCategory: "", pathwayLevel: "beginner", handicapIndex: "" });
    onSuccess();
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" className="bg-primary hover:bg-primary/90">
          <Plus className="w-4 h-4 mr-1" /> Add Junior
        </Button>
      </DialogTrigger>
      <DialogContent className="bg-card border-white/10 text-white max-w-md">
        <DialogHeader>
          <DialogTitle>Add Junior Profile</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-muted-foreground text-xs">First Name</Label>
              <Input value={form.firstName} onChange={e => setForm(f => ({ ...f, firstName: e.target.value }))}
                className="bg-white/5 border-white/10 text-white mt-1" required />
            </div>
            <div>
              <Label className="text-muted-foreground text-xs">Last Name</Label>
              <Input value={form.lastName} onChange={e => setForm(f => ({ ...f, lastName: e.target.value }))}
                className="bg-white/5 border-white/10 text-white mt-1" required />
            </div>
          </div>
          <div>
            <Label className="text-muted-foreground text-xs">Date of Birth</Label>
            <Input type="date" value={form.dateOfBirth} onChange={e => setForm(f => ({ ...f, dateOfBirth: e.target.value }))}
              className="bg-white/5 border-white/10 text-white mt-1" required />
          </div>
          <div>
            <Label className="text-muted-foreground text-xs">Age Category</Label>
            <Select value={form.ageCategory} onValueChange={v => setForm(f => ({ ...f, ageCategory: v }))}>
              <SelectTrigger className="bg-white/5 border-white/10 text-white mt-1"><SelectValue placeholder="Select..." /></SelectTrigger>
              <SelectContent className="bg-card border-white/10">
                {AGE_CATEGORIES.map(a => <SelectItem key={a.value} value={a.value} className="text-white">{a.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-muted-foreground text-xs">Starting Level</Label>
            <Select value={form.pathwayLevel} onValueChange={v => setForm(f => ({ ...f, pathwayLevel: v }))}>
              <SelectTrigger className="bg-white/5 border-white/10 text-white mt-1"><SelectValue /></SelectTrigger>
              <SelectContent className="bg-card border-white/10">
                {PATHWAY_LEVELS.map(l => <SelectItem key={l.value} value={l.value} className="text-white">{l.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-muted-foreground text-xs">Handicap Index (optional)</Label>
            <Input type="number" step="0.1" value={form.handicapIndex} onChange={e => setForm(f => ({ ...f, handicapIndex: e.target.value }))}
              className="bg-white/5 border-white/10 text-white mt-1" placeholder="e.g. 24.5" />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="submit" className="bg-primary hover:bg-primary/90">Create Profile</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ─── Guardian Management Dialog ───────────────────────────────────────────────
function GuardianDialog({ orgId, profile, onClose }: { orgId: number; profile: JuniorProfile; onClose: () => void }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({ guardianName: "", guardianEmail: "", guardianPhone: "", relationship: "parent" });
  const { toast } = useToast();

  const { data: detail } = useQuery({
    queryKey: ["/api/organizations", orgId, "junior", "profile", profile.id],
    queryFn: async () => {
      const res = await fetch(API(`/organizations/${orgId}/junior/profiles/${profile.id}`), { credentials: "include" });
      if (!res.ok) throw new Error("Failed");
      return res.json() as Promise<{ guardians: Array<{ id: number; guardianName: string; guardianEmail: string | null; relationship: string; isPrimary: boolean }> }>;
    },
  });

  async function addGuardian(e: React.FormEvent) {
    e.preventDefault();
    if (!form.guardianName) return;
    const res = await fetch(API(`/organizations/${orgId}/junior/profiles/${profile.id}/guardians`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(form),
    });
    if (!res.ok) { toast({ title: "Error", variant: "destructive" }); return; }
    toast({ title: "Guardian added" });
    setForm({ guardianName: "", guardianEmail: "", guardianPhone: "", relationship: "parent" });
    qc.invalidateQueries({ queryKey: ["/api/organizations", orgId, "junior", "profile", profile.id] });
  }

  async function removeGuardian(guardianId: number) {
    await fetch(API(`/organizations/${orgId}/junior/profiles/${profile.id}/guardians/${guardianId}`), {
      method: "DELETE", credentials: "include",
    });
    qc.invalidateQueries({ queryKey: ["/api/organizations", orgId, "junior", "profile", profile.id] });
    toast({ title: "Guardian removed" });
  }

  return (
    <DialogContent className="bg-card border-white/10 text-white max-w-lg">
      <DialogHeader>
        <DialogTitle>Guardians — {profile.firstName} {profile.lastName}</DialogTitle>
      </DialogHeader>
      <div className="space-y-4">
        {detail?.guardians?.length ? (
          <div className="divide-y divide-white/5">
            {detail.guardians.map(g => (
              <div key={g.id} className="py-2 flex items-center justify-between">
                <div>
                  <p className="text-white text-sm">{g.guardianName} <span className="text-muted-foreground text-xs">({g.relationship})</span></p>
                  {g.guardianEmail && <p className="text-muted-foreground text-xs">{g.guardianEmail}</p>}
                </div>
                <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-red-400 hover:text-red-300"
                  onClick={() => removeGuardian(g.id)}><Trash2 className="w-3.5 h-3.5" /></Button>
              </div>
            ))}
          </div>
        ) : <p className="text-muted-foreground text-sm">No guardians linked yet.</p>}

        <div className="border-t border-white/10 pt-4">
          <p className="text-muted-foreground text-xs font-medium mb-3">Add Guardian</p>
          <form onSubmit={addGuardian} className="space-y-2">
            <Input placeholder="Guardian name *" value={form.guardianName}
              onChange={e => setForm(f => ({ ...f, guardianName: e.target.value }))}
              className="bg-white/5 border-white/10 text-white" required />
            <div className="grid grid-cols-2 gap-2">
              <Input placeholder="Email" value={form.guardianEmail}
                onChange={e => setForm(f => ({ ...f, guardianEmail: e.target.value }))}
                className="bg-white/5 border-white/10 text-white" />
              <Input placeholder="Phone" value={form.guardianPhone}
                onChange={e => setForm(f => ({ ...f, guardianPhone: e.target.value }))}
                className="bg-white/5 border-white/10 text-white" />
            </div>
            <Select value={form.relationship} onValueChange={v => setForm(f => ({ ...f, relationship: v }))}>
              <SelectTrigger className="bg-white/5 border-white/10 text-white"><SelectValue /></SelectTrigger>
              <SelectContent className="bg-card border-white/10">
                {["parent", "guardian", "grandparent", "sibling", "coach", "other"].map(r => (
                  <SelectItem key={r} value={r} className="text-white capitalize">{r}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button type="submit" size="sm" className="bg-primary hover:bg-primary/90 w-full">Add Guardian</Button>
          </form>
        </div>
      </div>
    </DialogContent>
  );
}

// ─── Pathway Progress Dialog ───────────────────────────────────────────────────
function PathwayProgressDialog({ orgId, profile }: { orgId: number; profile: JuniorProfile }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({ pathwayId: "", levelId: "", notes: "" });
  const { toast } = useToast();

  const { data: pathways = [] } = useQuery<Array<{ id: number; name: string; levels: Array<{ id: number; name: string; level: string }> }>>({
    queryKey: ["/api/organizations", orgId, "junior", "pathways"],
    queryFn: async () => {
      const res = await fetch(API(`/organizations/${orgId}/junior/pathways`), { credentials: "include" });
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
  });

  const selectedPathway = pathways.find(p => String(p.id) === form.pathwayId);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const res = await fetch(API(`/organizations/${orgId}/junior/profiles/${profile.id}/progress`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        pathwayId: parseInt(form.pathwayId),
        levelId: form.levelId ? parseInt(form.levelId) : null,
        notes: form.notes || null,
      }),
    });
    if (!res.ok) { toast({ title: "Error", variant: "destructive" }); return; }
    toast({ title: "Progress updated" });
    setForm({ pathwayId: "", levelId: "", notes: "" });
    qc.invalidateQueries({ queryKey: ["/api/organizations", orgId, "junior", "profile", profile.id] });
    qc.invalidateQueries({ queryKey: ["/api/organizations", orgId, "junior", "profiles"] });
  }

  return (
    <DialogContent className="bg-card border-white/10 text-white max-w-md">
      <DialogHeader>
        <DialogTitle>Update Pathway — {profile.firstName} {profile.lastName}</DialogTitle>
      </DialogHeader>
      {pathways.length === 0 ? (
        <p className="text-muted-foreground text-sm">No development pathways configured yet. Create one first in Settings.</p>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <Label className="text-muted-foreground text-xs">Pathway</Label>
            <Select value={form.pathwayId} onValueChange={v => setForm(f => ({ ...f, pathwayId: v, levelId: "" }))}>
              <SelectTrigger className="bg-white/5 border-white/10 text-white mt-1"><SelectValue placeholder="Select pathway..." /></SelectTrigger>
              <SelectContent className="bg-card border-white/10">
                {pathways.map(p => <SelectItem key={p.id} value={String(p.id)} className="text-white">{p.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          {selectedPathway && selectedPathway.levels.length > 0 && (
            <div>
              <Label className="text-muted-foreground text-xs">Level Achieved</Label>
              <Select value={form.levelId} onValueChange={v => setForm(f => ({ ...f, levelId: v }))}>
                <SelectTrigger className="bg-white/5 border-white/10 text-white mt-1"><SelectValue placeholder="Select level..." /></SelectTrigger>
                <SelectContent className="bg-card border-white/10">
                  {selectedPathway.levels.map(l => (
                    <SelectItem key={l.id} value={String(l.id)} className="text-white">{l.name} ({pathwayLevelLabel(l.level)})</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div>
            <Label className="text-muted-foreground text-xs">Notes (optional)</Label>
            <Textarea value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
              className="bg-white/5 border-white/10 text-white mt-1" rows={2} />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="submit" disabled={!form.pathwayId} className="bg-primary hover:bg-primary/90">Save Progress</Button>
          </div>
        </form>
      )}
    </DialogContent>
  );
}

// ─── Add Program Dialog ───────────────────────────────────────────────────────
function AddProgramDialog({ orgId, onSuccess }: { orgId: number; onSuccess: () => void }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: "", description: "", startDate: "", endDate: "", maxParticipants: "" });
  const { toast } = useToast();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const res = await fetch(API(`/organizations/${orgId}/junior/programs`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        name: form.name,
        description: form.description || null,
        startDate: form.startDate || null,
        endDate: form.endDate || null,
        maxParticipants: form.maxParticipants ? parseInt(form.maxParticipants) : null,
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      toast({ title: "Error", description: err.error ?? "Failed to create program", variant: "destructive" });
      return;
    }
    toast({ title: "Program created" });
    setOpen(false);
    setForm({ name: "", description: "", startDate: "", endDate: "", maxParticipants: "" });
    onSuccess();
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" className="bg-primary hover:bg-primary/90">
          <Plus className="w-4 h-4 mr-1" /> New Program
        </Button>
      </DialogTrigger>
      <DialogContent className="bg-card border-white/10 text-white max-w-md">
        <DialogHeader>
          <DialogTitle>Create Junior Program</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <Label className="text-muted-foreground text-xs">Program Name</Label>
            <Input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
              className="bg-white/5 border-white/10 text-white mt-1" required placeholder="e.g. Summer Academy 2026" />
          </div>
          <div>
            <Label className="text-muted-foreground text-xs">Description</Label>
            <Textarea value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
              className="bg-white/5 border-white/10 text-white mt-1" rows={2} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-muted-foreground text-xs">Start Date</Label>
              <Input type="date" value={form.startDate} onChange={e => setForm(f => ({ ...f, startDate: e.target.value }))}
                className="bg-white/5 border-white/10 text-white mt-1" />
            </div>
            <div>
              <Label className="text-muted-foreground text-xs">End Date</Label>
              <Input type="date" value={form.endDate} onChange={e => setForm(f => ({ ...f, endDate: e.target.value }))}
                className="bg-white/5 border-white/10 text-white mt-1" />
            </div>
          </div>
          <div>
            <Label className="text-muted-foreground text-xs">Max Participants</Label>
            <Input type="number" value={form.maxParticipants} onChange={e => setForm(f => ({ ...f, maxParticipants: e.target.value }))}
              className="bg-white/5 border-white/10 text-white mt-1" placeholder="Leave blank for unlimited" />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="submit" className="bg-primary hover:bg-primary/90">Create</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ─── Enroll Junior Dialog ──────────────────────────────────────────────────────
function EnrollJuniorDialog({ orgId, programId, programName, onSuccess }: {
  orgId: number; programId: number; programName: string; onSuccess: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [selectedProfileId, setSelectedProfileId] = useState("");
  const { toast } = useToast();

  const { data: profiles = [] } = useQuery<JuniorProfile[]>({
    queryKey: ["/api/organizations", orgId, "junior", "profiles", "all-for-enroll"],
    queryFn: async () => {
      const res = await fetch(API(`/organizations/${orgId}/junior/profiles?activeOnly=true`), { credentials: "include" });
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
    enabled: open,
  });

  async function handleEnroll(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedProfileId) return;
    const res = await fetch(API(`/organizations/${orgId}/junior/programs/${programId}/participants`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ juniorProfileId: parseInt(selectedProfileId) }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      toast({ title: "Error", description: err.error ?? "Failed to enroll", variant: "destructive" });
      return;
    }
    toast({ title: "Junior enrolled" });
    setOpen(false);
    setSelectedProfileId("");
    onSuccess();
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" className="border-white/20 text-white hover:bg-white/10">
          <UserPlus className="w-4 h-4 mr-1" /> Enroll Junior
        </Button>
      </DialogTrigger>
      <DialogContent className="bg-card border-white/10 text-white max-w-sm">
        <DialogHeader>
          <DialogTitle>Enroll in {programName}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleEnroll} className="space-y-4">
          <div>
            <Label className="text-muted-foreground text-xs">Select Junior</Label>
            <Select value={selectedProfileId} onValueChange={setSelectedProfileId}>
              <SelectTrigger className="bg-white/5 border-white/10 text-white mt-1"><SelectValue placeholder="Choose junior..." /></SelectTrigger>
              <SelectContent className="bg-card border-white/10">
                {profiles.map(p => (
                  <SelectItem key={p.id} value={String(p.id)} className="text-white">
                    {p.firstName} {p.lastName} ({ageCategoryLabel(p.ageCategory)})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="submit" disabled={!selectedProfileId} className="bg-primary hover:bg-primary/90">Enroll</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ─── Attendance Dialog ────────────────────────────────────────────────────────
function AttendanceDialog({ orgId, programId, session, participants }: {
  orgId: number; programId: number; session: ProgramSession; participants: ProgramParticipant[];
}) {
  const qc = useQueryClient();
  const [attended, setAttended] = useState<Record<number, boolean>>({});
  const [open, setOpen] = useState(false);
  const { toast } = useToast();

  const { data: existing = [] } = useQuery<AttendanceRecord[]>({
    queryKey: ["/api/organizations", orgId, "junior", "attendance", session.id],
    queryFn: async () => {
      const res = await fetch(API(`/organizations/${orgId}/junior/programs/${programId}/sessions/${session.id}/attendance`), { credentials: "include" });
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
    enabled: open,
  });

  const attendanceMap = Object.fromEntries(existing.map(r => [r.juniorProfileId, r.attended]));
  const effectiveAttended = { ...attendanceMap, ...attended };

  async function save() {
    const records = participants.map(p => ({
      juniorProfileId: p.juniorProfileId,
      attended: effectiveAttended[p.juniorProfileId] ?? false,
    }));
    const res = await fetch(API(`/organizations/${orgId}/junior/programs/${programId}/sessions/${session.id}/attendance`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify(records),
    });
    if (!res.ok) { toast({ title: "Error", variant: "destructive" }); return; }
    toast({ title: "Attendance saved" });
    qc.invalidateQueries({ queryKey: ["/api/organizations", orgId, "junior", "attendance", session.id] });
    setOpen(false);
    setAttended({});
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-muted-foreground hover:text-white">
          <ClipboardList className="w-3.5 h-3.5 mr-1" /> Attendance
        </Button>
      </DialogTrigger>
      <DialogContent className="bg-card border-white/10 text-white max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base">{session.title}</DialogTitle>
          <p className="text-muted-foreground text-xs">{new Date(session.scheduledAt).toLocaleString()}</p>
        </DialogHeader>
        {participants.length === 0 ? (
          <p className="text-muted-foreground text-sm">No participants enrolled in this program.</p>
        ) : (
          <div className="space-y-2 max-h-72 overflow-y-auto">
            {participants.map(p => {
              const isPresent = effectiveAttended[p.juniorProfileId] ?? false;
              return (
                <div key={p.juniorProfileId} className="flex items-center justify-between py-1.5 border-b border-white/5">
                  <span className="text-white text-sm">{p.firstName} {p.lastName}</span>
                  <button
                    onClick={() => setAttended(prev => ({ ...prev, [p.juniorProfileId]: !isPresent }))}
                    className={`flex items-center gap-1 px-2 py-1 rounded text-xs font-medium transition-colors ${isPresent ? "bg-green-500/20 text-green-400" : "bg-white/5 text-muted-foreground"}`}
                  >
                    {isPresent
                      ? <><CheckCircle2 className="w-3.5 h-3.5" /> Present</>
                      : <><XCircle className="w-3.5 h-3.5" /> Absent</>
                    }
                  </button>
                </div>
              );
            })}
          </div>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={save} className="bg-primary hover:bg-primary/90">Save Attendance</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── Add Award Dialog ─────────────────────────────────────────────────────────
function AddAwardDialog({ orgId, profiles, onSuccess }: { orgId: number; profiles: JuniorProfile[]; onSuccess: () => void }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ juniorProfileId: "", awardType: "", awardLabel: "", ageCategory: "", description: "" });
  const { toast } = useToast();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const res = await fetch(API(`/organizations/${orgId}/junior/awards`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        juniorProfileId: parseInt(form.juniorProfileId),
        awardType: form.awardType,
        awardLabel: form.awardLabel,
        ageCategory: form.ageCategory || null,
        description: form.description || null,
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      toast({ title: "Error", description: err.error ?? "Failed to create award", variant: "destructive" });
      return;
    }
    toast({ title: "Award created" });
    setOpen(false);
    setForm({ juniorProfileId: "", awardType: "", awardLabel: "", ageCategory: "", description: "" });
    onSuccess();
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" className="bg-primary hover:bg-primary/90">
          <Star className="w-4 h-4 mr-1" /> Give Award
        </Button>
      </DialogTrigger>
      <DialogContent className="bg-card border-white/10 text-white max-w-md">
        <DialogHeader>
          <DialogTitle>Give Award</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <Label className="text-muted-foreground text-xs">Junior</Label>
            <Select value={form.juniorProfileId} onValueChange={v => setForm(f => ({ ...f, juniorProfileId: v }))}>
              <SelectTrigger className="bg-white/5 border-white/10 text-white mt-1"><SelectValue placeholder="Select junior..." /></SelectTrigger>
              <SelectContent className="bg-card border-white/10">
                {profiles.map(p => (
                  <SelectItem key={p.id} value={String(p.id)} className="text-white">
                    {p.firstName} {p.lastName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-muted-foreground text-xs">Award Type</Label>
            <Select value={form.awardType} onValueChange={v => setForm(f => ({ ...f, awardType: v }))}>
              <SelectTrigger className="bg-white/5 border-white/10 text-white mt-1"><SelectValue placeholder="Select type..." /></SelectTrigger>
              <SelectContent className="bg-card border-white/10">
                {AWARD_TYPES.map(a => <SelectItem key={a.value} value={a.value} className="text-white">{a.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-muted-foreground text-xs">Award Label</Label>
            <Input value={form.awardLabel} onChange={e => setForm(f => ({ ...f, awardLabel: e.target.value }))}
              className="bg-white/5 border-white/10 text-white mt-1" required placeholder="e.g. April 2026 Monthly Winner" />
          </div>
          <div>
            <Label className="text-muted-foreground text-xs">Age Category (optional)</Label>
            <Select value={form.ageCategory || "_empty"} onValueChange={v => setForm(f => ({ ...f, ageCategory: v === "_empty" ? "" : v }))}>
              <SelectTrigger className="bg-white/5 border-white/10 text-white mt-1"><SelectValue placeholder="All ages" /></SelectTrigger>
              <SelectContent className="bg-card border-white/10">
                <SelectItem value="_empty" className="text-white">All ages</SelectItem>
                {AGE_CATEGORIES.map(a => <SelectItem key={a.value} value={a.value} className="text-white">{a.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-muted-foreground text-xs">Description (optional)</Label>
            <Textarea value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
              className="bg-white/5 border-white/10 text-white mt-1" rows={2} />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="submit" className="bg-primary hover:bg-primary/90">Give Award</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ─── Profiles Tab ─────────────────────────────────────────────────────────────
function ProfilesTab({ orgId }: { orgId: number }) {
  const qc = useQueryClient();
  const [ageFilter, setAgeFilter] = useState("all");
  const [guardianProfile, setGuardianProfile] = useState<JuniorProfile | null>(null);
  const [pathwayProfile, setPathwayProfile] = useState<JuniorProfile | null>(null);
  const { toast } = useToast();

  const { data: profiles = [], isLoading } = useQuery<JuniorProfile[]>({
    queryKey: ["/api/organizations", orgId, "junior", "profiles", ageFilter],
    queryFn: async () => {
      const url = new URL(API(`/organizations/${orgId}/junior/profiles`), location.href);
      if (ageFilter !== "all") url.searchParams.set("ageCategory", ageFilter);
      const res = await fetch(url.toString(), { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load profiles");
      return res.json();
    },
    enabled: !!orgId,
  });

  async function deleteProfile(id: number) {
    if (!confirm("Deactivate this junior profile?")) return;
    await fetch(API(`/organizations/${orgId}/junior/profiles/${id}`), { method: "DELETE", credentials: "include" });
    qc.invalidateQueries({ queryKey: ["/api/organizations", orgId, "junior", "profiles"] });
    toast({ title: "Profile deactivated" });
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <Select value={ageFilter} onValueChange={setAgeFilter}>
          <SelectTrigger className="bg-white/5 border-white/10 text-white w-40 h-8 text-sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="bg-card border-white/10">
            <SelectItem value="all" className="text-white">All Ages</SelectItem>
            {AGE_CATEGORIES.map(a => <SelectItem key={a.value} value={a.value} className="text-white">{a.label}</SelectItem>)}
          </SelectContent>
        </Select>
        <AddProfileDialog orgId={orgId} onSuccess={() => qc.invalidateQueries({ queryKey: ["/api/organizations", orgId, "junior", "profiles"] })} />
      </div>

      {isLoading ? (
        <div className="space-y-2">{[...Array(4)].map((_, i) => <div key={i} className="h-12 bg-white/5 rounded-lg animate-pulse" />)}</div>
      ) : profiles.length === 0 ? (
        <Card className="glass-card border-none">
          <CardContent className="pt-8 pb-8 text-center">
            <GraduationCap className="w-10 h-10 text-muted-foreground mx-auto mb-3" />
            <p className="text-muted-foreground">No junior profiles yet. Add your first junior golfer to get started.</p>
          </CardContent>
        </Card>
      ) : (
        <Card className="glass-card border-none">
          <Table>
            <TableHeader>
              <TableRow className="border-white/10">
                <TableHead className="text-muted-foreground">Name</TableHead>
                <TableHead className="text-muted-foreground">Age Group</TableHead>
                <TableHead className="text-muted-foreground">Level</TableHead>
                <TableHead className="text-muted-foreground">Handicap</TableHead>
                <TableHead className="text-muted-foreground text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {profiles.map(p => (
                <TableRow key={p.id} className="border-white/10 hover:bg-white/5">
                  <TableCell className="text-white font-medium">{p.firstName} {p.lastName}</TableCell>
                  <TableCell>
                    <Badge variant="outline" className="border-primary/40 text-primary text-xs">
                      {ageCategoryLabel(p.ageCategory)}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${levelBadgeColor(p.pathwayLevel)}`}>
                      {pathwayLevelLabel(p.pathwayLevel)}
                    </span>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{p.handicapIndex ?? "—"}</TableCell>
                  <TableCell className="text-right flex items-center justify-end gap-1">
                    <Dialog open={guardianProfile?.id === p.id} onOpenChange={o => setGuardianProfile(o ? p : null)}>
                      <DialogTrigger asChild>
                        <Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-muted-foreground hover:text-white">
                          <Users className="w-3.5 h-3.5 mr-1" /> Guardians
                        </Button>
                      </DialogTrigger>
                      {guardianProfile?.id === p.id && <GuardianDialog orgId={orgId} profile={p} onClose={() => setGuardianProfile(null)} />}
                    </Dialog>
                    <Dialog open={pathwayProfile?.id === p.id} onOpenChange={o => setPathwayProfile(o ? p : null)}>
                      <DialogTrigger asChild>
                        <Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-muted-foreground hover:text-white">
                          <BookOpen className="w-3.5 h-3.5 mr-1" /> Pathway
                        </Button>
                      </DialogTrigger>
                      {pathwayProfile?.id === p.id && <PathwayProgressDialog orgId={orgId} profile={p} />}
                    </Dialog>
                    <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-red-400 hover:text-red-300"
                      onClick={() => deleteProfile(p.id)}>
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
    </div>
  );
}

// ─── Programs Tab ─────────────────────────────────────────────────────────────
function ProgramsTab({ orgId }: { orgId: number }) {
  const qc = useQueryClient();
  const [selectedProgram, setSelectedProgram] = useState<JuniorProgram | null>(null);
  const [addSessionOpen, setAddSessionOpen] = useState(false);
  const [sessionForm, setSessionForm] = useState({ title: "", scheduledAt: "", durationMinutes: "60", location: "", coachName: "" });
  const { toast } = useToast();

  const { data: programs = [], isLoading } = useQuery<JuniorProgram[]>({
    queryKey: ["/api/organizations", orgId, "junior", "programs"],
    queryFn: async () => {
      const res = await fetch(API(`/organizations/${orgId}/junior/programs`), { credentials: "include" });
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
    enabled: !!orgId,
  });

  const { data: programDetail } = useQuery<ProgramDetail>({
    queryKey: ["/api/organizations", orgId, "junior", "program", selectedProgram?.id],
    queryFn: async () => {
      const res = await fetch(API(`/organizations/${orgId}/junior/programs/${selectedProgram!.id}`), { credentials: "include" });
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
    enabled: !!selectedProgram,
  });

  async function deleteProgram(id: number) {
    if (!confirm("Delete this program?")) return;
    await fetch(API(`/organizations/${orgId}/junior/programs/${id}`), { method: "DELETE", credentials: "include" });
    qc.invalidateQueries({ queryKey: ["/api/organizations", orgId, "junior", "programs"] });
    if (selectedProgram?.id === id) setSelectedProgram(null);
    toast({ title: "Program deleted" });
  }

  async function removeParticipant(participantId: number) {
    if (!selectedProgram) return;
    await fetch(API(`/organizations/${orgId}/junior/programs/${selectedProgram.id}/participants/${participantId}`), {
      method: "DELETE", credentials: "include",
    });
    qc.invalidateQueries({ queryKey: ["/api/organizations", orgId, "junior", "program", selectedProgram.id] });
    toast({ title: "Participant removed" });
  }

  async function addSession(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedProgram) return;
    const res = await fetch(API(`/organizations/${orgId}/junior/programs/${selectedProgram.id}/sessions`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        title: sessionForm.title,
        scheduledAt: sessionForm.scheduledAt,
        durationMinutes: parseInt(sessionForm.durationMinutes),
        location: sessionForm.location || null,
        coachName: sessionForm.coachName || null,
      }),
    });
    if (!res.ok) { toast({ title: "Error", variant: "destructive" }); return; }
    toast({ title: "Session added" });
    setAddSessionOpen(false);
    setSessionForm({ title: "", scheduledAt: "", durationMinutes: "60", location: "", coachName: "" });
    qc.invalidateQueries({ queryKey: ["/api/organizations", orgId, "junior", "program", selectedProgram.id] });
  }

  async function deleteSession(sessionId: number) {
    if (!selectedProgram) return;
    await fetch(API(`/organizations/${orgId}/junior/programs/${selectedProgram.id}/sessions/${sessionId}`), {
      method: "DELETE", credentials: "include",
    });
    qc.invalidateQueries({ queryKey: ["/api/organizations", orgId, "junior", "program", selectedProgram.id] });
    toast({ title: "Session removed" });
  }

  if (isLoading) return <div className="h-40 bg-white/5 rounded-lg animate-pulse" />;

  if (selectedProgram) {
    const participants = programDetail?.participants ?? [];
    const sessions = programDetail?.sessions ?? [];

    return (
      <div className="space-y-4">
        <Button variant="ghost" size="sm" onClick={() => setSelectedProgram(null)} className="text-muted-foreground hover:text-white">
          ← Back to Programs
        </Button>
        <div className="flex items-start justify-between">
          <div>
            <h3 className="text-white font-semibold text-lg">{selectedProgram.name}</h3>
            {selectedProgram.description && <p className="text-muted-foreground text-sm">{selectedProgram.description}</p>}
          </div>
          <div className="flex gap-2">
            <EnrollJuniorDialog
              orgId={orgId}
              programId={selectedProgram.id}
              programName={selectedProgram.name}
              onSuccess={() => qc.invalidateQueries({ queryKey: ["/api/organizations", orgId, "junior", "program", selectedProgram.id] })}
            />
            <Dialog open={addSessionOpen} onOpenChange={setAddSessionOpen}>
              <DialogTrigger asChild>
                <Button size="sm" className="bg-primary hover:bg-primary/90"><Plus className="w-4 h-4 mr-1" /> Add Session</Button>
              </DialogTrigger>
              <DialogContent className="bg-card border-white/10 text-white">
                <DialogHeader><DialogTitle>Add Session</DialogTitle></DialogHeader>
                <form onSubmit={addSession} className="space-y-4">
                  <div>
                    <Label className="text-muted-foreground text-xs">Session Title</Label>
                    <Input value={sessionForm.title} onChange={e => setSessionForm(f => ({ ...f, title: e.target.value }))}
                      className="bg-white/5 border-white/10 text-white mt-1" required />
                  </div>
                  <div>
                    <Label className="text-muted-foreground text-xs">Scheduled Date & Time</Label>
                    <Input type="datetime-local" value={sessionForm.scheduledAt} onChange={e => setSessionForm(f => ({ ...f, scheduledAt: e.target.value }))}
                      className="bg-white/5 border-white/10 text-white mt-1" required />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <Label className="text-muted-foreground text-xs">Duration (min)</Label>
                      <Input type="number" value={sessionForm.durationMinutes} onChange={e => setSessionForm(f => ({ ...f, durationMinutes: e.target.value }))}
                        className="bg-white/5 border-white/10 text-white mt-1" />
                    </div>
                    <div>
                      <Label className="text-muted-foreground text-xs">Location</Label>
                      <Input value={sessionForm.location} onChange={e => setSessionForm(f => ({ ...f, location: e.target.value }))}
                        className="bg-white/5 border-white/10 text-white mt-1" />
                    </div>
                  </div>
                  <div>
                    <Label className="text-muted-foreground text-xs">Coach Name</Label>
                    <Input value={sessionForm.coachName} onChange={e => setSessionForm(f => ({ ...f, coachName: e.target.value }))}
                      className="bg-white/5 border-white/10 text-white mt-1" />
                  </div>
                  <div className="flex justify-end gap-2 pt-2">
                    <Button type="button" variant="ghost" onClick={() => setAddSessionOpen(false)}>Cancel</Button>
                    <Button type="submit" className="bg-primary hover:bg-primary/90">Add Session</Button>
                  </div>
                </form>
              </DialogContent>
            </Dialog>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-3">
          <Card className="glass-card border-none">
            <CardContent className="pt-4 pb-4 text-center">
              <p className="text-2xl font-bold text-primary">{participants.length}</p>
              <p className="text-muted-foreground text-xs mt-0.5">Participants</p>
            </CardContent>
          </Card>
          <Card className="glass-card border-none">
            <CardContent className="pt-4 pb-4 text-center">
              <p className="text-2xl font-bold text-white">{sessions.length}</p>
              <p className="text-muted-foreground text-xs mt-0.5">Sessions</p>
            </CardContent>
          </Card>
          <Card className="glass-card border-none">
            <CardContent className="pt-4 pb-4 text-center">
              <p className="text-xs text-white font-medium mt-1">
                {selectedProgram.startDate ? new Date(selectedProgram.startDate).toLocaleDateString() : "—"}
              </p>
              <p className="text-muted-foreground text-xs mt-0.5">Start Date</p>
            </CardContent>
          </Card>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <Card className="glass-card border-none">
            <CardHeader className="pb-3">
              <CardTitle className="text-white text-sm flex items-center gap-2">
                <Calendar className="w-4 h-4 text-primary" /> Sessions
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {sessions.length === 0 ? (
                <p className="text-muted-foreground text-sm px-6 pb-4">No sessions yet.</p>
              ) : (
                <div className="divide-y divide-white/5">
                  {sessions.map(s => (
                    <div key={s.id} className="px-6 py-3 flex items-start justify-between">
                      <div>
                        <p className="text-white text-sm font-medium">{s.title}</p>
                        <p className="text-muted-foreground text-xs mt-0.5">
                          {new Date(s.scheduledAt).toLocaleString()} · {s.durationMinutes} min
                          {s.location ? ` · ${s.location}` : ""}
                          {s.coachName ? ` · ${s.coachName}` : ""}
                        </p>
                      </div>
                      <div className="flex items-center gap-1 shrink-0 ml-2">
                        <AttendanceDialog
                          orgId={orgId}
                          programId={selectedProgram.id}
                          session={s}
                          participants={participants}
                        />
                        <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-red-400 hover:text-red-300"
                          onClick={() => deleteSession(s.id)}>
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="glass-card border-none">
            <CardHeader className="pb-3">
              <CardTitle className="text-white text-sm flex items-center gap-2">
                <Users className="w-4 h-4 text-primary" /> Participants
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {participants.length === 0 ? (
                <p className="text-muted-foreground text-sm px-6 pb-4">No participants enrolled.</p>
              ) : (
                <div className="divide-y divide-white/5">
                  {participants.map(p => (
                    <div key={p.id} className="px-6 py-2.5 flex items-center justify-between">
                      <div>
                        <p className="text-white text-sm">{p.firstName} {p.lastName}</p>
                        <p className="text-muted-foreground text-xs">{ageCategoryLabel(p.ageCategory)} · {pathwayLevelLabel(p.pathwayLevel)}</p>
                      </div>
                      <div className="flex items-center gap-2">
                        {p.handicapIndex && <span className="text-xs text-muted-foreground">HCP {p.handicapIndex}</span>}
                        <Button variant="ghost" size="sm" className="h-6 w-6 p-0 text-red-400 hover:text-red-300"
                          onClick={() => removeParticipant(p.id)}>
                          <Trash2 className="w-3 h-3" />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <AddProgramDialog orgId={orgId} onSuccess={() => qc.invalidateQueries({ queryKey: ["/api/organizations", orgId, "junior", "programs"] })} />
      </div>
      {programs.length === 0 ? (
        <Card className="glass-card border-none">
          <CardContent className="pt-8 pb-8 text-center">
            <BookOpen className="w-10 h-10 text-muted-foreground mx-auto mb-3" />
            <p className="text-muted-foreground">No programs yet. Create a Summer Academy or Holiday Camp to get started.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {programs.map(p => (
            <Card key={p.id} className="glass-card border-none hover:border-primary/30 border border-transparent transition-colors cursor-pointer"
              onClick={() => setSelectedProgram(p)}>
              <CardHeader className="pb-2">
                <div className="flex items-start justify-between">
                  <CardTitle className="text-white text-base">{p.name}</CardTitle>
                  <div className="flex gap-1">
                    <Badge variant="outline" className={`text-xs ${p.isActive ? "border-green-500/40 text-green-400" : "border-gray-500/40 text-gray-400"}`}>
                      {p.isActive ? "Active" : "Inactive"}
                    </Badge>
                    <Button variant="ghost" size="sm" className="h-6 w-6 p-0 text-red-400 hover:text-red-300 ml-1"
                      onClick={e => { e.stopPropagation(); deleteProgram(p.id); }}>
                      <Trash2 className="w-3 h-3" />
                    </Button>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="pb-4">
                {p.description && <p className="text-muted-foreground text-xs mb-3">{p.description}</p>}
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground flex items-center gap-1.5">
                    <Users className="w-3.5 h-3.5" /> {p.participantCount}
                    {p.maxParticipants ? ` / ${p.maxParticipants}` : ""} participants
                  </span>
                  <ChevronRight className="w-4 h-4 text-primary" />
                </div>
                {(p.startDate || p.endDate) && (
                  <p className="text-muted-foreground text-xs mt-2">
                    {p.startDate ? new Date(p.startDate).toLocaleDateString() : "—"} →{" "}
                    {p.endDate ? new Date(p.endDate).toLocaleDateString() : "ongoing"}
                  </p>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Leaderboard Tab ──────────────────────────────────────────────────────────
function LeaderboardTab({ orgId }: { orgId: number }) {
  const [ageFilter, setAgeFilter] = useState("all");

  const { data: lb = [], isLoading } = useQuery<LeaderboardRow[]>({
    queryKey: ["/api/organizations", orgId, "junior", "leaderboard", ageFilter],
    queryFn: async () => {
      const url = new URL(API(`/organizations/${orgId}/junior/leaderboard`), location.href);
      if (ageFilter !== "all") url.searchParams.set("ageCategory", ageFilter);
      const res = await fetch(url.toString(), { credentials: "include" });
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
    enabled: !!orgId,
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Select value={ageFilter} onValueChange={setAgeFilter}>
          <SelectTrigger className="bg-white/5 border-white/10 text-white w-40 h-8 text-sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="bg-card border-white/10">
            <SelectItem value="all" className="text-white">All Age Groups</SelectItem>
            {AGE_CATEGORIES.map(a => <SelectItem key={a.value} value={a.value} className="text-white">{a.label}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      {isLoading ? (
        <div className="h-40 bg-white/5 rounded-lg animate-pulse" />
      ) : lb.length === 0 ? (
        <Card className="glass-card border-none">
          <CardContent className="pt-8 pb-8 text-center">
            <BarChart2 className="w-10 h-10 text-muted-foreground mx-auto mb-3" />
            <p className="text-muted-foreground">No junior golfers in this age group yet.</p>
          </CardContent>
        </Card>
      ) : (
        <Card className="glass-card border-none">
          <Table>
            <TableHeader>
              <TableRow className="border-white/10">
                <TableHead className="text-muted-foreground w-10">#</TableHead>
                <TableHead className="text-muted-foreground">Name</TableHead>
                <TableHead className="text-muted-foreground">Age Group</TableHead>
                <TableHead className="text-muted-foreground">Level</TableHead>
                <TableHead className="text-muted-foreground text-right">HCP</TableHead>
                <TableHead className="text-muted-foreground text-right">Rounds</TableHead>
                <TableHead className="text-muted-foreground text-right">Best Gross</TableHead>
                <TableHead className="text-muted-foreground text-right">Avg Gross</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {lb.map((row, i) => (
                <TableRow key={row.juniorProfileId} className="border-white/10 hover:bg-white/5">
                  <TableCell className="text-muted-foreground text-sm">#{i + 1}</TableCell>
                  <TableCell className="text-white font-medium">{row.firstName} {row.lastName}</TableCell>
                  <TableCell>
                    <Badge variant="outline" className="border-primary/40 text-primary text-xs">
                      {ageCategoryLabel(row.ageCategory)}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${levelBadgeColor(row.pathwayLevel)}`}>
                      {pathwayLevelLabel(row.pathwayLevel)}
                    </span>
                  </TableCell>
                  <TableCell className="text-right text-muted-foreground">{row.handicapIndex ?? "—"}</TableCell>
                  <TableCell className="text-right text-muted-foreground">{row.roundsPlayed}</TableCell>
                  <TableCell className="text-right text-white">{row.bestGross !== null ? row.bestGross : "—"}</TableCell>
                  <TableCell className="text-right text-white">{row.avgGross !== null ? row.avgGross.toFixed(1) : "—"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
    </div>
  );
}

// ─── Awards Tab ───────────────────────────────────────────────────────────────
function AwardsTab({ orgId }: { orgId: number }) {
  const qc = useQueryClient();
  const [ageFilter, setAgeFilter] = useState("all");
  const { toast } = useToast();

  const { data: awards = [], isLoading } = useQuery<JuniorAward[]>({
    queryKey: ["/api/organizations", orgId, "junior", "awards", ageFilter],
    queryFn: async () => {
      const url = new URL(API(`/organizations/${orgId}/junior/awards`), location.href);
      if (ageFilter !== "all") url.searchParams.set("ageCategory", ageFilter);
      const res = await fetch(url.toString(), { credentials: "include" });
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
    enabled: !!orgId,
  });

  const { data: profiles = [] } = useQuery<JuniorProfile[]>({
    queryKey: ["/api/organizations", orgId, "junior", "profiles", "all"],
    queryFn: async () => {
      const res = await fetch(API(`/organizations/${orgId}/junior/profiles`), { credentials: "include" });
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
    enabled: !!orgId,
  });

  async function deleteAward(id: number) {
    if (!confirm("Delete this award?")) return;
    await fetch(API(`/organizations/${orgId}/junior/awards/${id}`), { method: "DELETE", credentials: "include" });
    qc.invalidateQueries({ queryKey: ["/api/organizations", orgId, "junior", "awards"] });
    toast({ title: "Award removed" });
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <Select value={ageFilter} onValueChange={setAgeFilter}>
          <SelectTrigger className="bg-white/5 border-white/10 text-white w-40 h-8 text-sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="bg-card border-white/10">
            <SelectItem value="all" className="text-white">All Ages</SelectItem>
            {AGE_CATEGORIES.map(a => <SelectItem key={a.value} value={a.value} className="text-white">{a.label}</SelectItem>)}
          </SelectContent>
        </Select>
        <AddAwardDialog orgId={orgId} profiles={profiles} onSuccess={() => qc.invalidateQueries({ queryKey: ["/api/organizations", orgId, "junior", "awards"] })} />
      </div>

      {isLoading ? (
        <div className="h-40 bg-white/5 rounded-lg animate-pulse" />
      ) : awards.length === 0 ? (
        <Card className="glass-card border-none">
          <CardContent className="pt-8 pb-8 text-center">
            <Award className="w-10 h-10 text-muted-foreground mx-auto mb-3" />
            <p className="text-muted-foreground">No awards yet. Recognize your juniors' achievements.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {awards.map(a => (
            <Card key={a.id} className="glass-card border-none">
              <CardContent className="pt-4 pb-4">
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-2 mb-2">
                    <Star className="w-4 h-4 text-yellow-400" />
                    <span className="text-yellow-400 text-xs font-medium">
                      {AWARD_TYPES.find(t => t.value === a.awardType)?.label ?? a.awardType}
                    </span>
                  </div>
                  <Button variant="ghost" size="sm" className="h-6 w-6 p-0 text-red-400 hover:text-red-300"
                    onClick={() => deleteAward(a.id)}>
                    <Trash2 className="w-3 h-3" />
                  </Button>
                </div>
                <p className="text-white font-medium text-sm">{a.awardLabel}</p>
                <p className="text-muted-foreground text-xs mt-0.5">{a.firstName} {a.lastName}</p>
                {a.ageCategory && (
                  <Badge variant="outline" className="border-primary/40 text-primary text-xs mt-2">
                    {ageCategoryLabel(a.ageCategory)}
                  </Badge>
                )}
                {a.description && <p className="text-muted-foreground text-xs mt-2">{a.description}</p>}
                <p className="text-muted-foreground text-xs mt-2">{new Date(a.awardedAt).toLocaleDateString()}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────
export default function JuniorGolfPage() {
  const orgId = useActiveOrgId();

  if (!orgId) return (
    <AppLayout>
      <div className="flex items-center justify-center h-64">
        <p className="text-muted-foreground">Select a club to manage junior golf programs.</p>
      </div>
    </AppLayout>
  );

  return (
    <AppLayout>
      <div className="max-w-7xl mx-auto px-4 py-6">
        <div className="flex items-center gap-3 mb-6">
          <div className="p-2.5 rounded-lg bg-primary/10">
            <GraduationCap className="w-6 h-6 text-primary" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-white">Junior Golf</h1>
            <p className="text-muted-foreground text-sm">Manage junior profiles, programs, and development pathways</p>
          </div>
        </div>

        <Tabs defaultValue="profiles">
          <TabsList className="bg-white/5 border border-white/10 h-9 mb-6">
            <TabsTrigger value="profiles" className="data-[state=active]:bg-primary data-[state=active]:text-black text-sm">
              <Users className="w-3.5 h-3.5 mr-1.5" /> Juniors
            </TabsTrigger>
            <TabsTrigger value="programs" className="data-[state=active]:bg-primary data-[state=active]:text-black text-sm">
              <BookOpen className="w-3.5 h-3.5 mr-1.5" /> Programs
            </TabsTrigger>
            <TabsTrigger value="leaderboard" className="data-[state=active]:bg-primary data-[state=active]:text-black text-sm">
              <BarChart2 className="w-3.5 h-3.5 mr-1.5" /> Leaderboard
            </TabsTrigger>
            <TabsTrigger value="awards" className="data-[state=active]:bg-primary data-[state=active]:text-black text-sm">
              <Award className="w-3.5 h-3.5 mr-1.5" /> Awards
            </TabsTrigger>
          </TabsList>

          <TabsContent value="profiles">
            <ProfilesTab orgId={orgId} />
          </TabsContent>
          <TabsContent value="programs">
            <ProgramsTab orgId={orgId} />
          </TabsContent>
          <TabsContent value="leaderboard">
            <LeaderboardTab orgId={orgId} />
          </TabsContent>
          <TabsContent value="awards">
            <AwardsTab orgId={orgId} />
          </TabsContent>
        </Tabs>
      </div>
    </AppLayout>
  );
}
