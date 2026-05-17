import React, { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useActiveOrgContext } from "@/context/ActiveOrgContext";
import {
  Plus, Pencil, Trash2, Package, FileText, Link as LinkIcon, CheckCircle2,
  Clock, AlertCircle, ChevronDown, ChevronUp, Globe, Mail, Phone, User,
  RefreshCw, Download, BarChart2, X, Eye, EyeOff, Handshake,
  Send, ImageIcon, ThumbsUp, ThumbsDown, Image,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";

// ─── Types ───────────────────────────────────────────────────────────────────

type PipelineStatus = "prospect" | "negotiating" | "signed" | "active" | "expired" | "churned";

interface Sponsor {
  id: number;
  organizationId: number;
  name: string;
  tier: string;
  logoUrl: string | null;
  bannerUrl: string | null;
  pendingLogoUrl: string | null;
  pendingBannerUrl: string | null;
  assetRejectionFeedback: string | null;
  websiteUrl: string | null;
  description: string | null;
  contactEmail: string | null;
  contactName: string | null;
  contactPhone: string | null;
  pipelineStatus: PipelineStatus;
  renewalDate: string | null;
  notes: string | null;
  isActive: boolean;
  invoiceSummary?: {
    total: number;
    paid: number;
    outstanding: number;
    totalAmount: number;
    paidAmount: number;
  };
  assignments?: Array<{
    id: number;
    assignmentType: string;
    tournamentId: number | null;
    holeNumber: number | null;
    packageId: number | null;
  }>;
  analytics?: {
    impressions: number;
    clicks: number;
    ctr: number;
    days: number;
    bySource?: Array<{ source: string; eventType: string; total: number }>;
  };
}

interface SponsorshipPackage {
  id: number;
  name: string;
  description: string | null;
  price: string;
  currency: string;
  deliverables: string[];
  packageType: string;
  isActive: boolean;
  displayOrder: number;
}

interface SponsorInvoice {
  id: number;
  sponsorId: number;
  invoiceNumber: string;
  amount: string;
  currency: string;
  paymentStatus: "unpaid" | "pending" | "paid" | "refunded";
  razorpayPaymentLinkUrl: string | null;
  dueDate: string | null;
  paidAt: string | null;
  createdAt: string;
  sponsorName: string | null;
  sponsorContactEmail: string | null;
  notes: string | null;
}

interface SponsorshipAssignment {
  id: number;
  sponsorId: number;
  packageId: number | null;
  tournamentId: number | null;
  holeNumber: number | null;
  assignmentType: string;
  notes: string | null;
  sponsorName: string | null;
  sponsorLogoUrl: string | null;
  tournamentName: string | null;
  packageName: string | null;
}

// ─── Pipeline status config ───────────────────────────────────────────────────

const PIPELINE_STATUSES: { value: PipelineStatus; label: string; color: string }[] = [
  { value: "prospect", label: "Prospect", color: "text-slate-400 bg-slate-400/10" },
  { value: "negotiating", label: "Negotiating", color: "text-yellow-400 bg-yellow-400/10" },
  { value: "signed", label: "Signed", color: "text-blue-400 bg-blue-400/10" },
  { value: "active", label: "Active", color: "text-green-400 bg-green-400/10" },
  { value: "expired", label: "Expired", color: "text-orange-400 bg-orange-400/10" },
  { value: "churned", label: "Churned", color: "text-red-400 bg-red-400/10" },
];

function PipelineBadge({ status }: { status: PipelineStatus }) {
  const cfg = PIPELINE_STATUSES.find(s => s.value === status) ?? PIPELINE_STATUSES[0];
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${cfg.color}`}>
      {cfg.label}
    </span>
  );
}

function PaymentStatusBadge({ status }: { status: string }) {
  const cfg: Record<string, string> = {
    paid: "text-green-400 bg-green-400/10",
    unpaid: "text-red-400 bg-red-400/10",
    pending: "text-yellow-400 bg-yellow-400/10",
    refunded: "text-slate-400 bg-slate-400/10",
  };
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${cfg[status] ?? "text-slate-400 bg-slate-400/10"}`}>
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </span>
  );
}

// ─── Sponsor Form Modal ───────────────────────────────────────────────────────

function SponsorModal({
  sponsor,
  orgId,
  onClose,
}: {
  sponsor: Sponsor | null;
  orgId: number;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [form, setForm] = useState({
    name: sponsor?.name ?? "",
    tier: sponsor?.tier ?? "gold",
    logoUrl: sponsor?.logoUrl ?? "",
    websiteUrl: sponsor?.websiteUrl ?? "",
    description: sponsor?.description ?? "",
    contactName: sponsor?.contactName ?? "",
    contactEmail: sponsor?.contactEmail ?? "",
    contactPhone: sponsor?.contactPhone ?? "",
    pipelineStatus: sponsor?.pipelineStatus ?? "prospect",
    renewalDate: sponsor?.renewalDate ? sponsor.renewalDate.slice(0, 10) : "",
    notes: sponsor?.notes ?? "",
  });
  const [showPasswordField, setShowPasswordField] = useState(false);
  const [portalPassword, setPortalPassword] = useState("");
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const url = sponsor
        ? `/api/organizations/${orgId}/sponsors/${sponsor.id}`
        : `/api/organizations/${orgId}/sponsors`;
      const method = sponsor ? "PUT" : "POST";

      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          renewalDate: form.renewalDate || undefined,
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error ?? "Save failed");
      }
      const saved = await res.json();

      if (showPasswordField && portalPassword) {
        await fetch(`/api/organizations/${orgId}/sponsors/${saved.id}/set-portal-password`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password: portalPassword }),
        });
      }

      queryClient.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/sponsors`] });
      toast({ title: sponsor ? "Sponsor updated" : "Sponsor created" });
      onClose();
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="bg-card border border-white/10 rounded-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto p-6">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-lg font-bold text-white">{sponsor ? "Edit Sponsor" : "Add Sponsor"}</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-white"><X className="w-5 h-5" /></button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="col-span-2">
              <label className="block text-sm font-medium text-muted-foreground mb-1">Company Name *</label>
              <input
                required
                value={form.name}
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                className="w-full bg-background border border-white/10 rounded-lg px-3 py-2 text-white text-sm"
                placeholder="Acme Corporation"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-muted-foreground mb-1">Tier</label>
              <select
                value={form.tier}
                onChange={e => setForm(f => ({ ...f, tier: e.target.value }))}
                className="w-full bg-background border border-white/10 rounded-lg px-3 py-2 text-white text-sm"
              >
                {["title", "platinum", "gold", "silver", "bronze"].map(t => (
                  <option key={t} value={t}>{t.charAt(0).toUpperCase() + t.slice(1)}</option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-muted-foreground mb-1">Pipeline Status</label>
              <select
                value={form.pipelineStatus}
                onChange={e => setForm(f => ({ ...f, pipelineStatus: e.target.value as PipelineStatus }))}
                className="w-full bg-background border border-white/10 rounded-lg px-3 py-2 text-white text-sm"
              >
                {PIPELINE_STATUSES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select>
            </div>

            <div className="col-span-2">
              <label className="block text-sm font-medium text-muted-foreground mb-1">Logo URL</label>
              <input
                value={form.logoUrl}
                onChange={e => setForm(f => ({ ...f, logoUrl: e.target.value }))}
                className="w-full bg-background border border-white/10 rounded-lg px-3 py-2 text-white text-sm"
                placeholder="https://example.com/logo.png"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-muted-foreground mb-1">Website</label>
              <input
                value={form.websiteUrl}
                onChange={e => setForm(f => ({ ...f, websiteUrl: e.target.value }))}
                className="w-full bg-background border border-white/10 rounded-lg px-3 py-2 text-white text-sm"
                placeholder="https://example.com"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-muted-foreground mb-1">Renewal Date</label>
              <input
                type="date"
                value={form.renewalDate}
                onChange={e => setForm(f => ({ ...f, renewalDate: e.target.value }))}
                className="w-full bg-background border border-white/10 rounded-lg px-3 py-2 text-white text-sm"
              />
            </div>

            <div className="col-span-2 border-t border-white/10 pt-4">
              <p className="text-sm font-semibold text-white mb-3">Contact Details</p>
              <div className="grid grid-cols-3 gap-3">
                <input
                  value={form.contactName}
                  onChange={e => setForm(f => ({ ...f, contactName: e.target.value }))}
                  className="bg-background border border-white/10 rounded-lg px-3 py-2 text-white text-sm"
                  placeholder="Contact name"
                />
                <input
                  value={form.contactEmail}
                  onChange={e => setForm(f => ({ ...f, contactEmail: e.target.value }))}
                  className="bg-background border border-white/10 rounded-lg px-3 py-2 text-white text-sm"
                  placeholder="Email"
                  type="email"
                />
                <input
                  value={form.contactPhone}
                  onChange={e => setForm(f => ({ ...f, contactPhone: e.target.value }))}
                  className="bg-background border border-white/10 rounded-lg px-3 py-2 text-white text-sm"
                  placeholder="Phone"
                />
              </div>
            </div>

            <div className="col-span-2">
              <label className="block text-sm font-medium text-muted-foreground mb-1">Notes</label>
              <textarea
                rows={2}
                value={form.notes}
                onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
                className="w-full bg-background border border-white/10 rounded-lg px-3 py-2 text-white text-sm resize-none"
                placeholder="Internal notes..."
              />
            </div>

            {/* Sponsor portal password */}
            <div className="col-span-2 border-t border-white/10 pt-4">
              <button
                type="button"
                className="text-sm text-amber-400 hover:text-amber-300 flex items-center gap-1"
                onClick={() => setShowPasswordField(v => !v)}
              >
                {showPasswordField ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                {showPasswordField ? "Hide" : "Set"} sponsor portal password
              </button>
              {showPasswordField && (
                <input
                  type="password"
                  value={portalPassword}
                  onChange={e => setPortalPassword(e.target.value)}
                  className="mt-2 w-full bg-background border border-white/10 rounded-lg px-3 py-2 text-white text-sm"
                  placeholder="Portal password (min 8 chars)"
                  minLength={8}
                />
              )}
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-muted-foreground hover:text-white border border-white/10 rounded-lg">Cancel</button>
            <button type="submit" disabled={saving} className="px-5 py-2 text-sm bg-amber-500 hover:bg-amber-600 text-black font-semibold rounded-lg disabled:opacity-50">
              {saving ? "Saving..." : sponsor ? "Update" : "Create"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Package Form Modal ───────────────────────────────────────────────────────

function PackageModal({ pkg, orgId, onClose }: { pkg: SponsorshipPackage | null; orgId: number; onClose: () => void }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [form, setForm] = useState({
    name: pkg?.name ?? "",
    description: pkg?.description ?? "",
    price: pkg?.price ?? "",
    currency: pkg?.currency ?? "INR",
    packageType: pkg?.packageType ?? "event",
    deliverables: pkg?.deliverables?.join("\n") ?? "",
  });
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const url = pkg
        ? `/api/organizations/${orgId}/sponsorship-packages/${pkg.id}`
        : `/api/organizations/${orgId}/sponsorship-packages`;
      const method = pkg ? "PUT" : "POST";
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          price: parseFloat(form.price),
          deliverables: form.deliverables.split("\n").filter(Boolean),
        }),
      });
      if (!res.ok) throw new Error("Save failed");
      queryClient.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/sponsorship-packages`] });
      toast({ title: pkg ? "Package updated" : "Package created" });
      onClose();
    } catch {
      toast({ title: "Error", description: "Failed to save package", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="bg-card border border-white/10 rounded-xl w-full max-w-lg p-6">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-lg font-bold text-white">{pkg ? "Edit Package" : "New Package"}</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-white"><X className="w-5 h-5" /></button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-muted-foreground mb-1">Name *</label>
            <input required value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
              className="w-full bg-background border border-white/10 rounded-lg px-3 py-2 text-white text-sm" placeholder="Hole Sponsor" />
          </div>
          <div>
            <label className="block text-sm font-medium text-muted-foreground mb-1">Description</label>
            <textarea rows={2} value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
              className="w-full bg-background border border-white/10 rounded-lg px-3 py-2 text-white text-sm resize-none" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-muted-foreground mb-1">Price *</label>
              <input required type="number" step="0.01" min="0" value={form.price} onChange={e => setForm(f => ({ ...f, price: e.target.value }))}
                className="w-full bg-background border border-white/10 rounded-lg px-3 py-2 text-white text-sm" placeholder="50000" />
            </div>
            <div>
              <label className="block text-sm font-medium text-muted-foreground mb-1">Currency</label>
              <select value={form.currency} onChange={e => setForm(f => ({ ...f, currency: e.target.value }))}
                className="w-full bg-background border border-white/10 rounded-lg px-3 py-2 text-white text-sm">
                {["INR", "USD", "GBP", "EUR"].map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-muted-foreground mb-1">Package Type</label>
            <select value={form.packageType} onChange={e => setForm(f => ({ ...f, packageType: e.target.value }))}
              className="w-full bg-background border border-white/10 rounded-lg px-3 py-2 text-white text-sm">
              {["hole", "event", "leaderboard", "scorecard", "title"].map(t => (
                <option key={t} value={t}>{t.charAt(0).toUpperCase() + t.slice(1)}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-muted-foreground mb-1">Deliverables (one per line)</label>
            <textarea rows={4} value={form.deliverables} onChange={e => setForm(f => ({ ...f, deliverables: e.target.value }))}
              className="w-full bg-background border border-white/10 rounded-lg px-3 py-2 text-white text-sm resize-none"
              placeholder="Logo on scorecards&#10;Logo on leaderboard&#10;Hole signage" />
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-muted-foreground hover:text-white border border-white/10 rounded-lg">Cancel</button>
            <button type="submit" disabled={saving} className="px-5 py-2 text-sm bg-amber-500 hover:bg-amber-600 text-black font-semibold rounded-lg disabled:opacity-50">
              {saving ? "Saving..." : pkg ? "Update" : "Create"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Invoice Form Modal ───────────────────────────────────────────────────────

function InvoiceModal({ sponsors, packages, orgId, onClose }: {
  sponsors: Sponsor[];
  packages: SponsorshipPackage[];
  orgId: number;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [form, setForm] = useState({
    sponsorId: "",
    packageId: "",
    amount: "",
    currency: "INR",
    dueDate: "",
    notes: "",
    createPaymentLink: true,
  });
  const [saving, setSaving] = useState(false);

  const handleSponsorChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const sid = e.target.value;
    setForm(f => ({ ...f, sponsorId: sid }));
  };

  const handlePackageChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const pid = e.target.value;
    const pkg = packages.find(p => String(p.id) === pid);
    setForm(f => ({ ...f, packageId: pid, amount: pkg ? pkg.price : f.amount, currency: pkg ? pkg.currency : f.currency }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.sponsorId || !form.amount) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/organizations/${orgId}/sponsor-invoices`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          amount: parseFloat(form.amount),
          createPaymentLink: form.createPaymentLink,
          dueDate: form.dueDate || undefined,
          packageId: form.packageId || undefined,
        }),
      });
      if (!res.ok) throw new Error("Failed to create invoice");
      queryClient.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/sponsor-invoices`] });
      queryClient.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/sponsors`] });
      toast({ title: "Invoice created" });
      onClose();
    } catch {
      toast({ title: "Error", description: "Failed to create invoice", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="bg-card border border-white/10 rounded-xl w-full max-w-lg p-6">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-lg font-bold text-white">New Sponsorship Invoice</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-white"><X className="w-5 h-5" /></button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-muted-foreground mb-1">Sponsor *</label>
            <select required value={form.sponsorId} onChange={handleSponsorChange}
              className="w-full bg-background border border-white/10 rounded-lg px-3 py-2 text-white text-sm">
              <option value="">Select sponsor...</option>
              {sponsors.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-muted-foreground mb-1">Package (auto-fills amount)</label>
            <select value={form.packageId} onChange={handlePackageChange}
              className="w-full bg-background border border-white/10 rounded-lg px-3 py-2 text-white text-sm">
              <option value="">Select package...</option>
              {packages.filter(p => p.isActive).map(p => (
                <option key={p.id} value={p.id}>{p.name} — {p.currency} {Number(p.price).toLocaleString()}</option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-muted-foreground mb-1">Amount *</label>
              <input required type="number" step="0.01" min="0" value={form.amount} onChange={e => setForm(f => ({ ...f, amount: e.target.value }))}
                className="w-full bg-background border border-white/10 rounded-lg px-3 py-2 text-white text-sm" />
            </div>
            <div>
              <label className="block text-sm font-medium text-muted-foreground mb-1">Currency</label>
              <select value={form.currency} onChange={e => setForm(f => ({ ...f, currency: e.target.value }))}
                className="w-full bg-background border border-white/10 rounded-lg px-3 py-2 text-white text-sm">
                {["INR", "USD", "GBP", "EUR"].map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-muted-foreground mb-1">Due Date</label>
            <input type="date" value={form.dueDate} onChange={e => setForm(f => ({ ...f, dueDate: e.target.value }))}
              className="w-full bg-background border border-white/10 rounded-lg px-3 py-2 text-white text-sm" />
          </div>

          <div>
            <label className="block text-sm font-medium text-muted-foreground mb-1">Notes</label>
            <textarea rows={2} value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
              className="w-full bg-background border border-white/10 rounded-lg px-3 py-2 text-white text-sm resize-none" />
          </div>

          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={form.createPaymentLink} onChange={e => setForm(f => ({ ...f, createPaymentLink: e.target.checked }))}
              className="rounded" />
            <span className="text-sm text-muted-foreground">Create Razorpay payment link</span>
          </label>

          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-muted-foreground hover:text-white border border-white/10 rounded-lg">Cancel</button>
            <button type="submit" disabled={saving} className="px-5 py-2 text-sm bg-amber-500 hover:bg-amber-600 text-black font-semibold rounded-lg disabled:opacity-50">
              {saving ? "Creating..." : "Create Invoice"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

type Tab = "pipeline" | "packages" | "invoices" | "assignments";

export default function SponsorsPage() {
  const { activeOrg } = useActiveOrgContext();
  const orgId = activeOrg?.id;
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [tab, setTab] = useState<Tab>("pipeline");
  const [showSponsorModal, setShowSponsorModal] = useState(false);
  const [editSponsor, setEditSponsor] = useState<Sponsor | null>(null);
  const [showPackageModal, setShowPackageModal] = useState(false);
  const [editPackage, setEditPackage] = useState<SponsorshipPackage | null>(null);
  const [showInvoiceModal, setShowInvoiceModal] = useState(false);
  const [expandedSponsor, setExpandedSponsor] = useState<number | null>(null);

  const { data: sponsors = [], isLoading: sponsorsLoading } = useQuery<Sponsor[]>({
    queryKey: [`/api/organizations/${orgId}/sponsors`],
    queryFn: () => fetch(`/api/organizations/${orgId}/sponsors`).then(r => r.json()),
    enabled: !!orgId,
  });

  const { data: packages = [], isLoading: pkgsLoading } = useQuery<SponsorshipPackage[]>({
    queryKey: [`/api/organizations/${orgId}/sponsorship-packages`],
    queryFn: () => fetch(`/api/organizations/${orgId}/sponsorship-packages`).then(r => r.json()),
    enabled: !!orgId,
  });

  const { data: invoices = [], isLoading: invoicesLoading } = useQuery<SponsorInvoice[]>({
    queryKey: [`/api/organizations/${orgId}/sponsor-invoices`],
    queryFn: () => fetch(`/api/organizations/${orgId}/sponsor-invoices`).then(r => r.json()),
    enabled: !!orgId,
  });

  const { data: assignments = [] } = useQuery<SponsorshipAssignment[]>({
    queryKey: [`/api/organizations/${orgId}/sponsorship-assignments`],
    queryFn: () => fetch(`/api/organizations/${orgId}/sponsorship-assignments`).then(r => r.json()),
    enabled: !!orgId,
  });

  const { data: pendingAssets } = useQuery<{ count: number }>({
    queryKey: [`/api/organizations/${orgId}/sponsors/pending-asset-count`],
    queryFn: () => fetch(`/api/organizations/${orgId}/sponsors/pending-asset-count`).then(r => r.json()),
    enabled: !!orgId,
    refetchInterval: 30000,
  });

  const [generatingInvite, setGeneratingInvite] = useState<number | null>(null);
  const [approvingAsset, setApprovingAsset] = useState<string | null>(null);
  const [rejectingAsset, setRejectingAsset] = useState<{ sponsorId: number; assetType: string } | null>(null);
  const [rejectFeedback, setRejectFeedback] = useState("");

  const [visibleInviteLink, setVisibleInviteLink] = useState<{ sponsorId: number; link: string } | null>(null);

  const handleGenerateInvite = async (sponsorId: number, e: React.MouseEvent) => {
    e.stopPropagation();
    setGeneratingInvite(sponsorId);
    try {
      const res = await fetch(`/api/organizations/${orgId}/sponsors/${sponsorId}/generate-invite`, { method: "POST" });
      if (!res.ok) throw new Error("Failed to generate invite");
      const data = await res.json();
      const link = `${window.location.origin}${data.invitePath}`;
      try {
        await navigator.clipboard.writeText(link);
        toast({ title: "Invite link copied!", description: "Valid for 72 hours. Send it to the sponsor." });
      } catch {
        // Clipboard unavailable — show the link so admin can copy manually
        setVisibleInviteLink({ sponsorId, link });
        toast({ title: "Invite link ready", description: "Clipboard unavailable — link shown below for manual copy." });
      }
    } catch {
      toast({ title: "Error", description: "Failed to generate invite link", variant: "destructive" });
    } finally {
      setGeneratingInvite(null);
    }
  };

  const handleApproveAsset = async (sponsorId: number, assetType: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setApprovingAsset(`${sponsorId}-${assetType}`);
    try {
      const res = await fetch(`/api/organizations/${orgId}/sponsors/${sponsorId}/approve-asset`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assetType }),
      });
      if (!res.ok) throw new Error("Failed to approve");
      queryClient.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/sponsors`] });
      queryClient.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/sponsors/pending-asset-count`] });
      toast({ title: `${assetType === "banner" ? "Banner" : "Logo"} approved and is now live.` });
    } catch {
      toast({ title: "Error", description: "Failed to approve asset", variant: "destructive" });
    } finally {
      setApprovingAsset(null);
    }
  };

  const handleRejectAsset = async () => {
    if (!rejectingAsset) return;
    const { sponsorId, assetType } = rejectingAsset;
    try {
      const res = await fetch(`/api/organizations/${orgId}/sponsors/${sponsorId}/reject-asset`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assetType, feedback: rejectFeedback }),
      });
      if (!res.ok) throw new Error("Failed to reject");
      queryClient.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/sponsors`] });
      queryClient.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/sponsors/pending-asset-count`] });
      toast({ title: "Asset rejected.", description: rejectFeedback ? "Feedback sent to sponsor." : undefined });
      setRejectingAsset(null);
      setRejectFeedback("");
    } catch {
      toast({ title: "Error", description: "Failed to reject asset", variant: "destructive" });
    }
  };

  const deleteSponsor = async (id: number) => {
    if (!confirm("Delete this sponsor?")) return;
    await fetch(`/api/organizations/${orgId}/sponsors/${id}`, { method: "DELETE" });
    queryClient.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/sponsors`] });
    toast({ title: "Sponsor deleted" });
  };

  const deletePackage = async (id: number) => {
    if (!confirm("Delete this package?")) return;
    await fetch(`/api/organizations/${orgId}/sponsorship-packages/${id}`, { method: "DELETE" });
    queryClient.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/sponsorship-packages`] });
    toast({ title: "Package deleted" });
  };

  const deleteInvoice = async (id: number) => {
    if (!confirm("Delete this invoice?")) return;
    await fetch(`/api/organizations/${orgId}/sponsor-invoices/${id}`, { method: "DELETE" });
    queryClient.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/sponsor-invoices`] });
    toast({ title: "Invoice deleted" });
  };

  const markInvoicePaid = async (id: number) => {
    await fetch(`/api/organizations/${orgId}/sponsor-invoices/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paymentStatus: "paid" }),
    });
    queryClient.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/sponsor-invoices`] });
    queryClient.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/sponsors`] });
    toast({ title: "Invoice marked as paid" });
  };

  const TABS = [
    { id: "pipeline" as Tab, label: "Pipeline", icon: BarChart2 },
    { id: "packages" as Tab, label: "Packages", icon: Package },
    { id: "invoices" as Tab, label: "Invoices", icon: FileText },
    { id: "assignments" as Tab, label: "Assignments", icon: LinkIcon },
  ];

  // Calculate renewal reminders
  const today = new Date();
  const renewalSoon = sponsors.filter(s => {
    if (!s.renewalDate) return false;
    const rd = new Date(s.renewalDate);
    const diff = (rd.getTime() - today.getTime()) / 86400_000;
    return diff >= 0 && diff <= 30;
  });

  if (!orgId) {
    return (
      <div className="flex items-center justify-center h-64 text-muted-foreground">
        <p>Select an organization to manage sponsors.</p>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-amber-500/10 rounded-xl flex items-center justify-center">
            <Handshake className="w-5 h-5 text-amber-400" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-white">Sponsor Management</h1>
            <p className="text-sm text-muted-foreground">CRM pipeline, packages, invoices & portal access</p>
          </div>
        </div>
        <div className="flex gap-2">
          <a href={`${(import.meta.env.BASE_URL ?? "/").replace(/\/$/, "")}/sponsor-campaigns`}
            className="flex items-center gap-1.5 bg-white/5 hover:bg-white/10 border border-white/10 text-white text-sm font-medium px-4 py-2 rounded-lg">
            <BarChart2 className="w-4 h-4" /> Manage Ad Campaigns
          </a>
          {tab === "pipeline" && (
            <button onClick={() => { setEditSponsor(null); setShowSponsorModal(true); }}
              className="flex items-center gap-1.5 bg-amber-500 hover:bg-amber-600 text-black text-sm font-semibold px-4 py-2 rounded-lg">
              <Plus className="w-4 h-4" /> Add Sponsor
            </button>
          )}
          {tab === "packages" && (
            <button onClick={() => { setEditPackage(null); setShowPackageModal(true); }}
              className="flex items-center gap-1.5 bg-amber-500 hover:bg-amber-600 text-black text-sm font-semibold px-4 py-2 rounded-lg">
              <Plus className="w-4 h-4" /> New Package
            </button>
          )}
          {tab === "invoices" && (
            <button onClick={() => setShowInvoiceModal(true)}
              className="flex items-center gap-1.5 bg-amber-500 hover:bg-amber-600 text-black text-sm font-semibold px-4 py-2 rounded-lg">
              <Plus className="w-4 h-4" /> New Invoice
            </button>
          )}
        </div>
      </div>

      {/* Pending asset approvals banner */}
      {pendingAssets && pendingAssets.count > 0 && (
        <div className="bg-amber-400/10 border border-amber-400/20 rounded-lg p-4 flex items-start gap-3">
          <ImageIcon className="w-5 h-5 text-amber-400 mt-0.5 flex-shrink-0" />
          <div>
            <p className="text-sm font-semibold text-amber-300">
              {pendingAssets.count} Pending Asset {pendingAssets.count === 1 ? "Approval" : "Approvals"}
            </p>
            <p className="text-sm text-muted-foreground mt-0.5">
              Sponsors have submitted new logo or banner images. Review and approve them in the pipeline below.
            </p>
          </div>
        </div>
      )}

      {/* Renewal reminder banner */}
      {renewalSoon.length > 0 && (
        <div className="bg-orange-400/10 border border-orange-400/20 rounded-lg p-4 flex items-start gap-3">
          <AlertCircle className="w-5 h-5 text-orange-400 mt-0.5 flex-shrink-0" />
          <div>
            <p className="text-sm font-semibold text-orange-300">Renewal Reminders</p>
            <p className="text-sm text-muted-foreground mt-0.5">
              {renewalSoon.map(s => s.name).join(", ")} {renewalSoon.length === 1 ? "is" : "are"} due for renewal within 30 days.
            </p>
          </div>
        </div>
      )}

      {/* Stats */}
      <div className="grid grid-cols-4 gap-4">
        {[
          { label: "Total Sponsors", value: sponsors.length, color: "text-white" },
          { label: "Active", value: sponsors.filter(s => s.pipelineStatus === "active").length, color: "text-green-400" },
          { label: "Invoiced", value: invoices.length, color: "text-blue-400" },
          { label: "Collected", value: `₹${invoices.filter(i => i.paymentStatus === "paid").reduce((a, i) => a + parseFloat(i.amount), 0).toLocaleString()}`, color: "text-amber-400" },
        ].map(stat => (
          <div key={stat.label} className="bg-card border border-white/5 rounded-xl p-4">
            <p className="text-sm text-muted-foreground">{stat.label}</p>
            <p className={`text-2xl font-bold mt-1 ${stat.color}`}>{stat.value}</p>
          </div>
        ))}
      </div>

      {/* Tabs */}
      <div className="flex gap-1 bg-white/5 rounded-xl p-1">
        {TABS.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`flex items-center gap-1.5 flex-1 justify-center py-2 px-3 text-sm font-medium rounded-lg transition-colors ${tab === t.id ? "bg-amber-500/20 text-amber-400" : "text-muted-foreground hover:text-white"}`}>
            <t.icon className="w-4 h-4" /> {t.label}
          </button>
        ))}
      </div>

      {/* Pipeline Tab */}
      {tab === "pipeline" && (
        <div className="space-y-3">
          {sponsorsLoading ? (
            <div className="flex items-center justify-center h-32 text-muted-foreground">Loading sponsors...</div>
          ) : sponsors.length === 0 ? (
            <div className="text-center py-16 text-muted-foreground">
              <Handshake className="w-10 h-10 mx-auto mb-3 opacity-30" />
              <p className="font-medium">No sponsors yet</p>
              <p className="text-sm mt-1">Add your first sponsor to start building your CRM pipeline.</p>
            </div>
          ) : (
            sponsors.map(s => (
              <div key={s.id} className="bg-card border border-white/10 rounded-xl overflow-hidden">
                <div className="flex items-center gap-4 p-4 cursor-pointer" onClick={() => setExpandedSponsor(expandedSponsor === s.id ? null : s.id)}>
                  {s.logoUrl ? (
                    <img src={s.logoUrl} alt={s.name} className="w-12 h-12 rounded-lg object-contain bg-white/5 p-1" />
                  ) : (
                    <div className="w-12 h-12 rounded-lg bg-amber-500/10 flex items-center justify-center text-amber-400 font-bold text-lg">
                      {s.name.charAt(0)}
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="font-semibold text-white">{s.name}</p>
                      <span className="text-xs text-muted-foreground capitalize bg-white/5 px-2 py-0.5 rounded">{s.tier}</span>
                      <PipelineBadge status={s.pipelineStatus} />
                      {(s.pendingLogoUrl || s.pendingBannerUrl) && (
                        <span className="text-xs bg-amber-500/10 text-amber-400 border border-amber-500/20 px-2 py-0.5 rounded-full flex items-center gap-1">
                          <Clock className="w-3 h-3" /> Asset pending
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-4 mt-1 text-xs text-muted-foreground">
                      {s.contactEmail && <span className="flex items-center gap-1"><Mail className="w-3 h-3" /> {s.contactEmail}</span>}
                      {s.contactPhone && <span className="flex items-center gap-1"><Phone className="w-3 h-3" /> {s.contactPhone}</span>}
                      {s.renewalDate && <span className="flex items-center gap-1"><Clock className="w-3 h-3" /> Renewal: {new Date(s.renewalDate).toLocaleDateString()}</span>}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {s.invoiceSummary && s.invoiceSummary.total > 0 && (
                      <div className="text-right hidden md:block">
                        <p className="text-xs text-muted-foreground">Invoiced</p>
                        <p className="text-sm font-semibold text-white">₹{Number(s.invoiceSummary.paidAmount).toLocaleString()} / ₹{Number(s.invoiceSummary.totalAmount).toLocaleString()}</p>
                      </div>
                    )}
                    <button onClick={(e) => { e.stopPropagation(); setEditSponsor(s); setShowSponsorModal(true); }}
                      className="p-2 hover:bg-white/5 rounded-lg text-muted-foreground hover:text-white">
                      <Pencil className="w-4 h-4" />
                    </button>
                    <button onClick={(e) => { e.stopPropagation(); deleteSponsor(s.id); }}
                      className="p-2 hover:bg-white/5 rounded-lg text-muted-foreground hover:text-red-400">
                      <Trash2 className="w-4 h-4" />
                    </button>
                    {expandedSponsor === s.id ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
                  </div>
                </div>

                {expandedSponsor === s.id && (
                  <div className="border-t border-white/10 p-4 bg-white/2 space-y-4">
                    {s.notes && <p className="text-sm text-muted-foreground italic">{s.notes}</p>}
                    {s.websiteUrl && (
                      <a href={s.websiteUrl} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-sm text-blue-400 hover:underline">
                        <Globe className="w-3.5 h-3.5" /> {s.websiteUrl}
                      </a>
                    )}
                    {s.assignments && s.assignments.length > 0 && (
                      <div>
                        <p className="text-xs font-medium text-muted-foreground mb-1">ASSIGNMENTS</p>
                        <div className="flex flex-wrap gap-2">
                          {s.assignments.map(a => (
                            <span key={a.id} className="text-xs bg-white/5 px-2 py-1 rounded">
                              {a.assignmentType === "hole" ? `Hole ${a.holeNumber}` : a.assignmentType}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Analytics summary */}
                    {s.analytics && (
                      <div className="bg-white/2 border border-white/10 rounded-lg p-3">
                        <p className="text-xs font-semibold text-muted-foreground mb-2 flex items-center gap-1.5">
                          <BarChart2 className="w-3.5 h-3.5" /> Impressions (last {s.analytics.days} days)
                        </p>
                        <div className="flex items-center gap-4 text-sm flex-wrap">
                          <span className="flex items-center gap-1">
                            <Eye className="w-3.5 h-3.5 text-amber-400" />
                            <span className="font-semibold text-white">{s.analytics.impressions.toLocaleString()}</span>
                            <span className="text-muted-foreground text-xs">views</span>
                          </span>
                          <span className="flex items-center gap-1">
                            <LinkIcon className="w-3.5 h-3.5 text-green-400" />
                            <span className="font-semibold text-white">{s.analytics.clicks.toLocaleString()}</span>
                            <span className="text-muted-foreground text-xs">clicks</span>
                          </span>
                          <span className="flex items-center gap-1">
                            <span className="font-semibold text-white">{s.analytics.ctr}%</span>
                            <span className="text-muted-foreground text-xs">CTR</span>
                          </span>
                        </div>
                        {s.analytics.bySource && s.analytics.bySource.filter(r => r.eventType === "impression").length > 0 && (
                          <div className="mt-2 flex flex-wrap gap-1.5">
                            {s.analytics.bySource
                              .filter(r => r.eventType === "impression")
                              .map(r => (
                                <span key={`${r.source}-${r.eventType}`} className="text-xs bg-white/5 text-muted-foreground px-2 py-0.5 rounded">
                                  {r.source}: {Number(r.total).toLocaleString()}
                                </span>
                              ))
                            }
                          </div>
                        )}
                      </div>
                    )}

                    {/* Pending asset approvals */}
                    {(s.pendingLogoUrl || s.pendingBannerUrl) && (
                      <div className="bg-amber-500/5 border border-amber-500/20 rounded-lg p-3 space-y-3">
                        <p className="text-xs font-semibold text-amber-400 flex items-center gap-1.5">
                          <Clock className="w-3.5 h-3.5" /> Pending Asset Approvals
                        </p>
                        {s.pendingLogoUrl && (
                          <div className="flex items-center gap-3">
                            <div>
                              <p className="text-xs text-muted-foreground mb-1">New Logo</p>
                              <img src={s.pendingLogoUrl} alt="Pending logo" className="w-16 h-16 object-contain bg-white/5 rounded-lg p-1 border border-white/10" />
                            </div>
                            <div className="flex gap-2">
                              <button
                                onClick={(e) => handleApproveAsset(s.id, "logo", e)}
                                disabled={approvingAsset === `${s.id}-logo`}
                                className="flex items-center gap-1.5 text-xs bg-green-500/10 hover:bg-green-500/20 text-green-400 border border-green-500/20 px-3 py-1.5 rounded-lg disabled:opacity-50"
                              >
                                <ThumbsUp className="w-3.5 h-3.5" /> {approvingAsset === `${s.id}-logo` ? "Approving..." : "Approve"}
                              </button>
                              <button
                                onClick={(e) => { e.stopPropagation(); setRejectingAsset({ sponsorId: s.id, assetType: "logo" }); setRejectFeedback(""); }}
                                className="flex items-center gap-1.5 text-xs bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/20 px-3 py-1.5 rounded-lg"
                              >
                                <ThumbsDown className="w-3.5 h-3.5" /> Reject
                              </button>
                            </div>
                          </div>
                        )}
                        {s.pendingBannerUrl && (
                          <div>
                            <p className="text-xs text-muted-foreground mb-1">New Banner</p>
                            <div className="flex items-start gap-3">
                              <img src={s.pendingBannerUrl} alt="Pending banner" className="max-h-16 max-w-48 object-contain bg-white/5 rounded-lg border border-white/10" />
                              <div className="flex gap-2">
                                <button
                                  onClick={(e) => handleApproveAsset(s.id, "banner", e)}
                                  disabled={approvingAsset === `${s.id}-banner`}
                                  className="flex items-center gap-1.5 text-xs bg-green-500/10 hover:bg-green-500/20 text-green-400 border border-green-500/20 px-3 py-1.5 rounded-lg disabled:opacity-50"
                                >
                                  <ThumbsUp className="w-3.5 h-3.5" /> {approvingAsset === `${s.id}-banner` ? "Approving..." : "Approve"}
                                </button>
                                <button
                                  onClick={(e) => { e.stopPropagation(); setRejectingAsset({ sponsorId: s.id, assetType: "banner" }); setRejectFeedback(""); }}
                                  className="flex items-center gap-1.5 text-xs bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/20 px-3 py-1.5 rounded-lg"
                                >
                                  <ThumbsDown className="w-3.5 h-3.5" /> Reject
                                </button>
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    )}

                    <div className="flex flex-wrap gap-2 pt-1">
                      <button onClick={() => { setShowInvoiceModal(true); }}
                        className="flex items-center gap-1 text-xs bg-white/5 hover:bg-white/10 text-muted-foreground hover:text-white px-3 py-1.5 rounded-lg">
                        <FileText className="w-3.5 h-3.5" /> Create Invoice
                      </button>
                      {s.contactEmail && (
                        <button
                          onClick={(e) => handleGenerateInvite(s.id, e)}
                          disabled={generatingInvite === s.id}
                          className="flex items-center gap-1.5 text-xs bg-amber-500/10 hover:bg-amber-500/20 text-amber-400 border border-amber-500/20 px-3 py-1.5 rounded-lg disabled:opacity-50"
                        >
                          <Send className="w-3.5 h-3.5" /> {generatingInvite === s.id ? "Generating..." : "Generate Invite Link"}
                        </button>
                      )}
                    </div>
                    {visibleInviteLink?.sponsorId === s.id && (
                      <div className="mt-2 flex items-center gap-2 bg-white/5 border border-white/10 rounded-lg px-3 py-2">
                        <LinkIcon className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                        <span className="text-xs text-white break-all font-mono select-all flex-1">{visibleInviteLink.link}</span>
                        <button onClick={() => setVisibleInviteLink(null)} className="text-muted-foreground hover:text-white shrink-0">
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      )}

      {/* Packages Tab */}
      {tab === "packages" && (
        <div className="space-y-3">
          {pkgsLoading ? (
            <div className="flex items-center justify-center h-32 text-muted-foreground">Loading packages...</div>
          ) : packages.length === 0 ? (
            <div className="text-center py-16 text-muted-foreground">
              <Package className="w-10 h-10 mx-auto mb-3 opacity-30" />
              <p className="font-medium">No packages yet</p>
              <p className="text-sm mt-1">Create sponsorship packages to offer structured deals.</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {packages.map(p => (
                <div key={p.id} className="bg-card border border-white/10 rounded-xl p-5">
                  <div className="flex items-start justify-between mb-3">
                    <div>
                      <p className="font-semibold text-white">{p.name}</p>
                      <p className="text-xs text-muted-foreground capitalize mt-0.5">{p.packageType} sponsorship</p>
                    </div>
                    <div className="flex gap-1">
                      <button onClick={() => { setEditPackage(p); setShowPackageModal(true); }}
                        className="p-1.5 hover:bg-white/5 rounded text-muted-foreground hover:text-white">
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                      <button onClick={() => deletePackage(p.id)}
                        className="p-1.5 hover:bg-white/5 rounded text-muted-foreground hover:text-red-400">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                  <p className="text-2xl font-bold text-amber-400">{p.currency} {Number(p.price).toLocaleString()}</p>
                  {p.description && <p className="text-sm text-muted-foreground mt-2">{p.description}</p>}
                  {p.deliverables && p.deliverables.length > 0 && (
                    <ul className="mt-3 space-y-1">
                      {p.deliverables.map((d, i) => (
                        <li key={i} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                          <CheckCircle2 className="w-3.5 h-3.5 text-green-400 shrink-0" /> {d}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Invoices Tab */}
      {tab === "invoices" && (
        <div>
          {invoicesLoading ? (
            <div className="flex items-center justify-center h-32 text-muted-foreground">Loading invoices...</div>
          ) : invoices.length === 0 ? (
            <div className="text-center py-16 text-muted-foreground">
              <FileText className="w-10 h-10 mx-auto mb-3 opacity-30" />
              <p className="font-medium">No invoices yet</p>
              <p className="text-sm mt-1">Create your first sponsorship invoice.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs text-muted-foreground border-b border-white/10">
                    <th className="text-left py-3 px-4 font-medium">Invoice #</th>
                    <th className="text-left py-3 px-4 font-medium">Sponsor</th>
                    <th className="text-left py-3 px-4 font-medium">Amount</th>
                    <th className="text-left py-3 px-4 font-medium">Status</th>
                    <th className="text-left py-3 px-4 font-medium">Due Date</th>
                    <th className="text-left py-3 px-4 font-medium">Created</th>
                    <th className="text-right py-3 px-4 font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {invoices.map(inv => (
                    <tr key={inv.id} className="border-b border-white/5 hover:bg-white/2">
                      <td className="py-3 px-4 font-mono text-xs text-muted-foreground">{inv.invoiceNumber}</td>
                      <td className="py-3 px-4 text-white">{inv.sponsorName}</td>
                      <td className="py-3 px-4 text-white font-semibold">{inv.currency} {Number(inv.amount).toLocaleString()}</td>
                      <td className="py-3 px-4"><PaymentStatusBadge status={inv.paymentStatus} /></td>
                      <td className="py-3 px-4 text-muted-foreground">{inv.dueDate ? new Date(inv.dueDate).toLocaleDateString() : "—"}</td>
                      <td className="py-3 px-4 text-muted-foreground">{new Date(inv.createdAt).toLocaleDateString()}</td>
                      <td className="py-3 px-4">
                        <div className="flex items-center justify-end gap-1">
                          {inv.razorpayPaymentLinkUrl && (
                            <a href={inv.razorpayPaymentLinkUrl} target="_blank" rel="noopener noreferrer"
                              className="p-1.5 hover:bg-white/5 rounded text-blue-400" title="Payment link">
                              <LinkIcon className="w-3.5 h-3.5" />
                            </a>
                          )}
                          {inv.paymentStatus !== "paid" && (
                            <button onClick={() => markInvoicePaid(inv.id)}
                              className="p-1.5 hover:bg-white/5 rounded text-green-400" title="Mark as paid">
                              <CheckCircle2 className="w-3.5 h-3.5" />
                            </button>
                          )}
                          <button onClick={() => deleteInvoice(inv.id)}
                            className="p-1.5 hover:bg-white/5 rounded text-muted-foreground hover:text-red-400">
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Assignments Tab */}
      {tab === "assignments" && (
        <div>
          {assignments.length === 0 ? (
            <div className="text-center py-16 text-muted-foreground">
              <LinkIcon className="w-10 h-10 mx-auto mb-3 opacity-30" />
              <p className="font-medium">No assignments yet</p>
              <p className="text-sm mt-1">Assign sponsors to tournaments or holes from the tournament sponsor tab.</p>
            </div>
          ) : (
            <div className="space-y-2">
              {assignments.map(a => (
                <div key={a.id} className="flex items-center justify-between bg-card border border-white/10 rounded-lg p-4">
                  <div className="flex items-center gap-4">
                    {a.sponsorLogoUrl ? (
                      <img src={a.sponsorLogoUrl} alt="" className="w-10 h-10 rounded object-contain bg-white/5 p-1" />
                    ) : (
                      <div className="w-10 h-10 rounded bg-amber-500/10 flex items-center justify-center text-amber-400 font-bold">
                        {a.sponsorName?.charAt(0) ?? "?"}
                      </div>
                    )}
                    <div>
                      <p className="font-semibold text-white text-sm">{a.sponsorName}</p>
                      <div className="flex items-center gap-2 mt-0.5 text-xs text-muted-foreground">
                        <span className="capitalize">{a.assignmentType}</span>
                        {a.holeNumber && <span>· Hole {a.holeNumber}</span>}
                        {a.tournamentName && <span>· {a.tournamentName}</span>}
                        {a.packageName && <span className="text-amber-400">· {a.packageName}</span>}
                      </div>
                    </div>
                  </div>
                  <button onClick={async () => {
                    if (!confirm("Remove this assignment?")) return;
                    await fetch(`/api/organizations/${orgId}/sponsorship-assignments/${a.id}`, { method: "DELETE" });
                    queryClient.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/sponsorship-assignments`] });
                    toast({ title: "Assignment removed" });
                  }} className="p-2 hover:bg-white/5 rounded text-muted-foreground hover:text-red-400">
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Modals */}
      {showSponsorModal && (
        <SponsorModal
          sponsor={editSponsor}
          orgId={orgId}
          onClose={() => { setShowSponsorModal(false); setEditSponsor(null); }}
        />
      )}

      {showPackageModal && (
        <PackageModal
          pkg={editPackage}
          orgId={orgId}
          onClose={() => { setShowPackageModal(false); setEditPackage(null); }}
        />
      )}

      {showInvoiceModal && (
        <InvoiceModal
          sponsors={sponsors}
          packages={packages}
          orgId={orgId}
          onClose={() => setShowInvoiceModal(false)}
        />
      )}

      {/* Reject asset modal */}
      {rejectingAsset && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="bg-card border border-white/10 rounded-xl w-full max-w-md p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-bold text-white">Reject {rejectingAsset.assetType === "banner" ? "Banner" : "Logo"}</h2>
              <button onClick={() => setRejectingAsset(null)} className="text-muted-foreground hover:text-white"><X className="w-5 h-5" /></button>
            </div>
            <p className="text-sm text-muted-foreground mb-4">Optionally add feedback for the sponsor explaining why the asset was rejected.</p>
            <textarea
              rows={3}
              value={rejectFeedback}
              onChange={e => setRejectFeedback(e.target.value)}
              className="w-full bg-background border border-white/10 rounded-lg px-3 py-2 text-white text-sm resize-none mb-4"
              placeholder="e.g. Please use a transparent background PNG format..."
            />
            <div className="flex justify-end gap-2">
              <button onClick={() => setRejectingAsset(null)} className="px-4 py-2 text-sm text-muted-foreground hover:text-white border border-white/10 rounded-lg">Cancel</button>
              <button onClick={handleRejectAsset} className="px-5 py-2 text-sm bg-red-500 hover:bg-red-600 text-white font-semibold rounded-lg">
                Reject & Notify
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
