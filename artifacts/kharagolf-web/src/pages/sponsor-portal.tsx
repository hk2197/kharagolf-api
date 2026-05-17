import React, { useState, useEffect } from "react";
import {
  Handshake, LogOut, Upload, Download, BarChart2,
  Eye, EyeOff, CheckCircle2, AlertCircle, Globe, Link as LinkIcon,
  Clock, XCircle, Image, ImageIcon, TrendingUp, MousePointerClick,
  CalendarRange, LineChart as LineChartIcon,
} from "lucide-react";
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer,
  CartesianGrid, Legend,
} from "recharts";
import { useToast } from "@/hooks/use-toast";

// ─── Types ───────────────────────────────────────────────────────────────────

interface SponsorData {
  id: number;
  name: string;
  tier: string;
  logoUrl: string | null;
  bannerUrl: string | null;
  pendingLogoUrl: string | null;
  pendingBannerUrl: string | null;
  assetRejectionFeedback: string | null;
  websiteUrl: string | null;
  contactEmail: string | null;
  contactName: string | null;
  contactPhone: string | null;
  pipelineStatus: string;
  organizationId: number;
}

interface Assignment {
  id: number;
  assignmentType: string;
  holeNumber: number | null;
  tournamentId: number | null;
  tournamentName: string | null;
  packageId: number | null;
  packageName: string | null;
}

interface Invoice {
  id: number;
  invoiceNumber: string;
  amount: string;
  currency: string;
  paymentStatus: string;
  razorpayPaymentLinkUrl: string | null;
  dueDate: string | null;
  paidAt: string | null;
  createdAt: string;
}

interface Analytics {
  impressions: number;
  clicks: number;
  ctr: number;
  days: number;
  from?: string;
  to?: string;
  bySource?: Array<{ source: string; eventType: string; total: number }>;
  byTournament?: Array<{ tournamentId: number | null; tournamentName: string | null; eventType: string; total: number }>;
  bySlot?: Array<{ slotKey: string | null; eventType: string; total: number }>;
  byDaySlot?: Array<{ day: string; slotKey: string | null; eventType: string; total: number }>;
  byAdCampaign?: Array<{
    campaignId: number | null;
    campaignName: string | null;
    slotKey: string | null;
    slotName: string | null;
    creativeId: number | null;
    creativeName: string | null;
    eventType: string;
    total: number;
  }>;
}

const PORTAL_TOKEN_KEY = "sponsor_portal_token";
// sessionStorage key for the Per-Slot CTR Trend chart's per-slot mute state.
// Scoped to sessionStorage (not localStorage) so the toggle resets when the
// browser tab closes — sponsors expect a fresh chart at the start of each
// session, not a stale "everything hidden" state from a previous visit.
const TREND_HIDDEN_SLOTS_KEY = "sponsor_portal_trend_hidden_slots";

// ─── Claim Invite Page ────────────────────────────────────────────────────────

function ClaimInvitePage({ inviteToken, onClaimed }: { inviteToken: string; onClaimed: (token: string) => void }) {
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const { toast } = useToast();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password !== confirmPassword) { setError("Passwords do not match"); return; }
    if (password.length < 8) { setError("Password must be at least 8 characters"); return; }
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/sponsor-portal/claim-invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: inviteToken, password }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error ?? "Failed to set up account");
      }
      const data = await res.json();
      localStorage.setItem(PORTAL_TOKEN_KEY, data.token);
      toast({ title: "Account set up successfully! Welcome to your sponsor portal." });
      onClaimed(data.token);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="flex items-center justify-center gap-3 mb-8">
          <div className="w-12 h-12 bg-amber-500/10 rounded-xl flex items-center justify-center">
            <Handshake className="w-6 h-6 text-amber-400" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-white">Sponsor Portal</h1>
            <p className="text-sm text-muted-foreground">KHARAGOLF</p>
          </div>
        </div>

        <div className="bg-card border border-white/10 rounded-2xl p-8">
          <h2 className="text-lg font-semibold text-white mb-2">Set up your account</h2>
          <p className="text-sm text-muted-foreground mb-6">You've been invited to the sponsor portal. Create a password to get started.</p>

          {error && (
            <div className="flex items-center gap-2 bg-red-500/10 border border-red-500/20 rounded-lg p-3 mb-4 text-sm text-red-400">
              <AlertCircle className="w-4 h-4 shrink-0" /> {error}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-muted-foreground mb-1">New Password</label>
              <div className="relative">
                <input
                  type={showPassword ? "text" : "password"}
                  required
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  className="w-full bg-background border border-white/10 rounded-lg px-4 py-3 pr-10 text-white text-sm focus:outline-none focus:border-amber-500/50"
                  placeholder="At least 8 characters"
                  autoComplete="new-password"
                />
                <button type="button" onClick={() => setShowPassword(v => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-white">
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-muted-foreground mb-1">Confirm Password</label>
              <input
                type="password"
                required
                value={confirmPassword}
                onChange={e => setConfirmPassword(e.target.value)}
                className="w-full bg-background border border-white/10 rounded-lg px-4 py-3 text-white text-sm focus:outline-none focus:border-amber-500/50"
                placeholder="Repeat password"
                autoComplete="new-password"
              />
            </div>

            <button type="submit" disabled={loading}
              className="w-full bg-amber-500 hover:bg-amber-600 disabled:opacity-50 text-black font-semibold py-3 rounded-lg text-sm">
              {loading ? "Setting up..." : "Create account & sign in"}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}

// ─── Login Form ────────────────────────────────────────────────────────────────

function LoginForm({ onLogin }: { onLogin: (token: string) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/sponsor-portal/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error ?? "Login failed");
      }
      const data = await res.json();
      localStorage.setItem(PORTAL_TOKEN_KEY, data.token);
      onLogin(data.token);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="flex items-center justify-center gap-3 mb-8">
          <div className="w-12 h-12 bg-amber-500/10 rounded-xl flex items-center justify-center">
            <Handshake className="w-6 h-6 text-amber-400" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-white">Sponsor Portal</h1>
            <p className="text-sm text-muted-foreground">KHARAGOLF</p>
          </div>
        </div>

        <div className="bg-card border border-white/10 rounded-2xl p-8">
          <h2 className="text-lg font-semibold text-white mb-6">Sign in to your portal</h2>

          {error && (
            <div className="flex items-center gap-2 bg-red-500/10 border border-red-500/20 rounded-lg p-3 mb-4 text-sm text-red-400">
              <AlertCircle className="w-4 h-4 shrink-0" /> {error}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-muted-foreground mb-1">Email</label>
              <input
                type="email"
                required
                value={email}
                onChange={e => setEmail(e.target.value)}
                className="w-full bg-background border border-white/10 rounded-lg px-4 py-3 text-white text-sm focus:outline-none focus:border-amber-500/50"
                placeholder="contact@company.com"
                autoComplete="email"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-muted-foreground mb-1">Password</label>
              <div className="relative">
                <input
                  type={showPassword ? "text" : "password"}
                  required
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  className="w-full bg-background border border-white/10 rounded-lg px-4 py-3 pr-10 text-white text-sm focus:outline-none focus:border-amber-500/50"
                  placeholder="••••••••"
                  autoComplete="current-password"
                />
                <button type="button" onClick={() => setShowPassword(v => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-white">
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            <button type="submit" disabled={loading}
              className="w-full bg-amber-500 hover:bg-amber-600 disabled:opacity-50 text-black font-semibold py-3 rounded-lg text-sm">
              {loading ? "Signing in..." : "Sign in"}
            </button>
          </form>

          <p className="text-xs text-muted-foreground text-center mt-6">
            Contact your golf club administrator if you need access or have forgotten your password.
          </p>
        </div>
      </div>
    </div>
  );
}

// ─── Asset Upload Panel ────────────────────────────────────────────────────────

function AssetUploadPanel({
  token,
  assetType,
  label,
  currentUrl,
  pendingUrl,
  rejectionFeedback,
  onUploaded,
}: {
  token: string;
  assetType: "logo" | "banner";
  label: string;
  currentUrl: string | null;
  pendingUrl: string | null;
  rejectionFeedback: string | null;
  onUploaded: () => void;
}) {
  const [url, setUrl] = useState("");
  const [uploading, setUploading] = useState(false);
  const { toast } = useToast();

  const handleUpload = async () => {
    if (!url.trim()) return;
    setUploading(true);
    try {
      const res = await fetch("/api/sponsor-portal/upload-asset", {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ assetType, url: url.trim() }),
      });
      if (!res.ok) throw new Error("Upload failed");
      toast({ title: `${label} submitted for approval`, description: "Your club administrator will review it shortly." });
      setUrl("");
      onUploaded();
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="bg-card border border-white/10 rounded-xl p-6 space-y-4">
      <div className="flex items-center gap-2">
        {assetType === "logo" ? <ImageIcon className="w-4 h-4 text-amber-400" /> : <Image className="w-4 h-4 text-amber-400" />}
        <h3 className="font-semibold text-white">{label}</h3>
      </div>

      {/* Current asset */}
      {currentUrl && (
        <div>
          <p className="text-xs text-muted-foreground mb-2 flex items-center gap-1">
            <CheckCircle2 className="w-3 h-3 text-green-400" /> Current (live)
          </p>
          <img src={currentUrl} alt={`Current ${label}`}
            className={`rounded-lg object-contain bg-white/5 border border-white/10 ${assetType === "logo" ? "w-24 h-24 p-2" : "w-full max-h-24"}`} />
        </div>
      )}

      {/* Pending asset */}
      {pendingUrl && (
        <div className="bg-yellow-500/5 border border-yellow-500/20 rounded-lg p-3">
          <p className="text-xs text-yellow-400 font-medium mb-2 flex items-center gap-1">
            <Clock className="w-3 h-3" /> Pending admin approval
          </p>
          <img src={pendingUrl} alt={`Pending ${label}`}
            className={`rounded-lg object-contain bg-white/5 ${assetType === "logo" ? "w-20 h-20 p-1" : "w-full max-h-20"}`} />
        </div>
      )}

      {/* Rejection feedback */}
      {rejectionFeedback && !pendingUrl && (
        <div className="bg-red-500/5 border border-red-500/20 rounded-lg p-3">
          <p className="text-xs text-red-400 font-medium mb-1 flex items-center gap-1">
            <XCircle className="w-3 h-3" /> Previous submission rejected
          </p>
          <p className="text-xs text-muted-foreground">{rejectionFeedback}</p>
        </div>
      )}

      {/* Upload form */}
      <div>
        <label className="block text-xs font-medium text-muted-foreground mb-1.5">
          Submit new {label.toLowerCase()} URL
          {assetType === "logo" ? " (PNG, SVG, or JPEG, square preferred)" : " (PNG or JPEG, 3:1 ratio recommended)"}
        </label>
        <div className="flex gap-2">
          <input
            type="url"
            value={url}
            onChange={e => setUrl(e.target.value)}
            placeholder={`https://your-website.com/${assetType}.png`}
            className="flex-1 bg-background border border-white/10 rounded-lg px-3 py-2.5 text-white text-sm focus:outline-none focus:border-amber-500/50"
          />
          <button onClick={handleUpload} disabled={uploading || !url.trim()}
            className="flex items-center gap-2 bg-amber-500 hover:bg-amber-600 disabled:opacity-50 text-black text-sm font-semibold px-4 py-2.5 rounded-lg whitespace-nowrap">
            <Upload className="w-4 h-4" /> {uploading ? "Submitting..." : "Submit"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Portal Dashboard ──────────────────────────────────────────────────────────

type RangePreset = "7d" | "30d" | "90d" | "custom";
type ComparePreset = "off" | "previous" | "custom";

export function PortalDashboard({ token, onLogout }: { token: string; onLogout: () => void }) {
  const [data, setData] = useState<{ sponsor: SponsorData; assignments: Assignment[]; invoices: Invoice[]; analytics: Analytics; comparison: Analytics | null } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [downloadingImpressions, setDownloadingImpressions] = useState(false);
  const [downloadingBadge, setDownloadingBadge] = useState<number | null>(null);
  const [rangePreset, setRangePreset] = useState<RangePreset>("30d");
  const todayStr = new Date().toISOString().slice(0, 10);
  const defaultFrom = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);
  const defaultCompareFrom = new Date(Date.now() - 60 * 86400_000).toISOString().slice(0, 10);
  const defaultCompareTo = new Date(Date.now() - 31 * 86400_000).toISOString().slice(0, 10);
  const [customFrom, setCustomFrom] = useState(defaultFrom);
  const [customTo, setCustomTo] = useState(todayStr);
  const [comparePreset, setComparePreset] = useState<ComparePreset>("off");
  const [compareFrom, setCompareFrom] = useState(defaultCompareFrom);
  const [compareTo, setCompareTo] = useState(defaultCompareTo);
  // Slot keys the sponsor has muted in the Per-Slot CTR Trend chart by
  // clicking their legend entry. Persisted to sessionStorage so the toggle
  // state survives navigating away from the dashboard and back within the
  // same browser session (the chart is the only thing in the portal that
  // unmounts and remounts on logout/relogin or route changes).
  const [hiddenTrendSlots, setHiddenTrendSlots] = useState<Set<string>>(() => {
    try {
      const raw = sessionStorage.getItem(TREND_HIDDEN_SLOTS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return new Set(parsed.filter((k): k is string => typeof k === "string"));
      }
    } catch {}
    return new Set();
  });
  useEffect(() => {
    try {
      // When nothing is muted, drop the storage entry entirely instead of
      // leaving a stale "[]" behind — keeps the per-session state clean and
      // matches what `resetHiddenTrendSlots` writes when invoked directly.
      if (hiddenTrendSlots.size === 0) {
        sessionStorage.removeItem(TREND_HIDDEN_SLOTS_KEY);
      } else {
        sessionStorage.setItem(TREND_HIDDEN_SLOTS_KEY, JSON.stringify(Array.from(hiddenTrendSlots)));
      }
    } catch {}
  }, [hiddenTrendSlots]);
  const toggleTrendSlot = (slotKey: string) => {
    setHiddenTrendSlots(prev => {
      const next = new Set(prev);
      if (next.has(slotKey)) next.delete(slotKey);
      else next.add(slotKey);
      return next;
    });
  };
  const resetHiddenTrendSlots = () => {
    setHiddenTrendSlots(new Set());
    try {
      sessionStorage.removeItem(TREND_HIDDEN_SLOTS_KEY);
    } catch {}
  };
  const { toast } = useToast();

  // Build the query string for the currently selected range. Returns null if
  // the custom range is invalid so callers can short-circuit.
  const buildRangeQuery = (includeComparison = true): string | null => {
    let q: string;
    if (rangePreset === "custom") {
      if (!customFrom || !customTo) return null;
      if (customFrom > customTo) return null;
      q = `from=${encodeURIComponent(customFrom)}&to=${encodeURIComponent(customTo)}`;
    } else {
      const days = rangePreset === "7d" ? 7 : rangePreset === "90d" ? 90 : 30;
      q = `days=${days}`;
    }
    if (includeComparison) {
      if (comparePreset === "previous") {
        q += `&compare=previous`;
      } else if (comparePreset === "custom") {
        if (!compareFrom || !compareTo || compareFrom > compareTo) return null;
        q += `&compareFrom=${encodeURIComponent(compareFrom)}&compareTo=${encodeURIComponent(compareTo)}`;
      }
    }
    return q;
  };

  const fetchData = async () => {
    const query = buildRangeQuery();
    if (query === null) {
      setError("Please pick a valid date range (from must be on or before to).");
      setLoading(false);
      return;
    }
    setError("");
    setLoading(true);
    try {
      const res = await fetch(`/api/sponsor-portal/me?${query}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        if (res.status === 401) { onLogout(); return; }
        throw new Error("Failed to load data");
      }
      setData(await res.json());
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchData(); }, [rangePreset, customFrom, customTo, comparePreset, compareFrom, compareTo]);

  const handleDownloadImpressions = async () => {
    const query = buildRangeQuery();
    if (query === null) {
      toast({ title: "Invalid date range", description: "Please pick a valid from/to range.", variant: "destructive" });
      return;
    }
    setDownloadingImpressions(true);
    try {
      const res = await fetch(`/api/sponsor-portal/impressions?${query}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error("Failed to download");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const suffix = rangePreset === "custom" ? `${customFrom}_to_${customTo}` : rangePreset;
      a.href = url; a.download = `impressions_${suffix}.csv`; a.click();
      URL.revokeObjectURL(url);
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally {
      setDownloadingImpressions(false);
    }
  };

  const handleDownloadBadge = async (tournamentId: number) => {
    setDownloadingBadge(tournamentId);
    try {
      const res = await fetch(`/api/sponsor-portal/badge/${tournamentId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error("Failed to download badge");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = "sponsor_badge.svg"; a.click();
      URL.revokeObjectURL(url);
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    } finally {
      setDownloadingBadge(null);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="animate-spin w-8 h-8 border-2 border-amber-400 border-t-transparent rounded-full" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center text-red-400">
        <p>{error || "Could not load sponsor data"}</p>
      </div>
    );
  }

  const { sponsor, assignments, invoices, analytics, comparison } = data;

  // Format a delta vs the comparison period as a signed % string (or "—" when
  // the previous value is zero, since percent change is undefined).
  const formatDelta = (current: number, previous: number): { label: string; positive: boolean | null } => {
    if (previous === 0) {
      if (current === 0) return { label: "no change", positive: null };
      return { label: "new", positive: true };
    }
    const pct = ((current - previous) / previous) * 100;
    const sign = pct > 0 ? "+" : "";
    return { label: `${sign}${pct.toFixed(1)}%`, positive: pct === 0 ? null : pct > 0 };
  };

  const deltaClass = (positive: boolean | null) =>
    positive === null ? "text-muted-foreground" : positive ? "text-green-400" : "text-red-400";
  const paidInvoices = invoices.filter(i => i.paymentStatus === "paid");
  const unpaidInvoices = invoices.filter(i => i.paymentStatus !== "paid" && i.paymentStatus !== "refunded");
  const tournamentsWithAssignments = Array.from(
    new Map(assignments.filter(a => a.tournamentId).map(a => [a.tournamentId!, a])).values()
  );

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b border-white/10 bg-card/50 backdrop-blur-xl px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          {sponsor.logoUrl ? (
            <img src={sponsor.logoUrl} alt={sponsor.name} className="w-10 h-10 rounded-lg object-contain bg-white/5 p-1" />
          ) : (
            <div className="w-10 h-10 rounded-lg bg-amber-500/10 flex items-center justify-center text-amber-400 font-bold text-lg">
              {sponsor.name.charAt(0)}
            </div>
          )}
          <div>
            <h1 className="font-bold text-white">{sponsor.name}</h1>
            <p className="text-xs text-muted-foreground capitalize">{sponsor.tier} Sponsor</p>
          </div>
        </div>
        <button onClick={onLogout} className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-white">
          <LogOut className="w-4 h-4" /> Sign out
        </button>
      </header>

      <div className="max-w-5xl mx-auto px-6 py-8 space-y-8">
        {/* Date range filter */}
        <div className="bg-card border border-white/10 rounded-xl p-4 flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2 text-sm text-muted-foreground mr-2">
            <CalendarRange className="w-4 h-4 text-amber-400" />
            <span className="font-medium text-white">Report range:</span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {(["7d", "30d", "90d", "custom"] as RangePreset[]).map((p) => (
              <button
                key={p}
                onClick={() => setRangePreset(p)}
                className={`text-xs font-medium px-3 py-1.5 rounded-lg border ${
                  rangePreset === p
                    ? "bg-amber-500 text-black border-amber-500"
                    : "bg-transparent text-muted-foreground border-white/10 hover:text-white"
                }`}
              >
                {p === "7d" ? "Last 7 days" : p === "30d" ? "Last 30 days" : p === "90d" ? "Last 90 days" : "Custom"}
              </button>
            ))}
          </div>
          {rangePreset === "custom" && (
            <div className="flex flex-wrap items-center gap-2 ml-auto">
              <input
                type="date"
                value={customFrom}
                max={customTo || todayStr}
                onChange={(e) => setCustomFrom(e.target.value)}
                className="bg-background border border-white/10 rounded-lg px-3 py-1.5 text-white text-xs focus:outline-none focus:border-amber-500/50"
              />
              <span className="text-xs text-muted-foreground">to</span>
              <input
                type="date"
                value={customTo}
                min={customFrom}
                max={todayStr}
                onChange={(e) => setCustomTo(e.target.value)}
                className="bg-background border border-white/10 rounded-lg px-3 py-1.5 text-white text-xs focus:outline-none focus:border-amber-500/50"
              />
            </div>
          )}
          {data?.analytics.from && data.analytics.to && (
            <p className="text-xs text-muted-foreground ml-auto">
              Showing {data.analytics.from} → {data.analytics.to}
            </p>
          )}
        </div>

        {/* Comparison range filter */}
        <div className="bg-card border border-white/10 rounded-xl p-4 flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2 text-sm text-muted-foreground mr-2">
            <CalendarRange className="w-4 h-4 text-purple-400" />
            <span className="font-medium text-white">Compare to:</span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {([
              { v: "off", label: "Off" },
              { v: "previous", label: "Previous period" },
              { v: "custom", label: "Custom range" },
            ] as Array<{ v: ComparePreset; label: string }>).map(({ v, label }) => (
              <button
                key={v}
                onClick={() => setComparePreset(v)}
                className={`text-xs font-medium px-3 py-1.5 rounded-lg border ${
                  comparePreset === v
                    ? "bg-purple-500 text-black border-purple-500"
                    : "bg-transparent text-muted-foreground border-white/10 hover:text-white"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          {comparePreset === "custom" && (
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="date"
                value={compareFrom}
                max={compareTo || todayStr}
                onChange={(e) => setCompareFrom(e.target.value)}
                className="bg-background border border-white/10 rounded-lg px-3 py-1.5 text-white text-xs focus:outline-none focus:border-purple-500/50"
              />
              <span className="text-xs text-muted-foreground">to</span>
              <input
                type="date"
                value={compareTo}
                min={compareFrom}
                max={todayStr}
                onChange={(e) => setCompareTo(e.target.value)}
                className="bg-background border border-white/10 rounded-lg px-3 py-1.5 text-white text-xs focus:outline-none focus:border-purple-500/50"
              />
            </div>
          )}
          {comparePreset !== "off" && data?.comparison?.from && data.comparison.to && (
            <p className="text-xs text-muted-foreground ml-auto">
              vs {data.comparison.from} → {data.comparison.to}
            </p>
          )}
        </div>

        {/* Quick Stats */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <div className="bg-card border border-white/10 rounded-xl p-5">
            <p className="text-sm text-muted-foreground">Placements</p>
            <p className="text-3xl font-bold text-white mt-1">{assignments.length}</p>
          </div>
          <div className="bg-card border border-white/10 rounded-xl p-5">
            <div className="flex items-center gap-1.5 mb-1">
              <TrendingUp className="w-4 h-4 text-amber-400" />
              <p className="text-sm text-muted-foreground">Impressions</p>
            </div>
            <p className="text-3xl font-bold text-amber-400">{analytics.impressions.toLocaleString()}</p>
            {comparison ? (() => {
              const d = formatDelta(analytics.impressions, comparison.impressions);
              return (
                <p className="text-xs mt-0.5">
                  <span className={deltaClass(d.positive)}>{d.label}</span>
                  <span className="text-muted-foreground"> vs {comparison.impressions.toLocaleString()}</span>
                </p>
              );
            })() : (
              <p className="text-xs text-muted-foreground mt-0.5">last {analytics.days} days</p>
            )}
          </div>
          <div className="bg-card border border-white/10 rounded-xl p-5">
            <div className="flex items-center gap-1.5 mb-1">
              <MousePointerClick className="w-4 h-4 text-blue-400" />
              <p className="text-sm text-muted-foreground">Clicks</p>
            </div>
            <p className="text-3xl font-bold text-blue-400">{analytics.clicks.toLocaleString()}</p>
            {comparison ? (() => {
              const d = formatDelta(analytics.clicks, comparison.clicks);
              const ctrDelta = formatDelta(analytics.ctr, comparison.ctr);
              return (
                <p className="text-xs mt-0.5">
                  <span className={deltaClass(d.positive)}>{d.label}</span>
                  <span className="text-muted-foreground"> · CTR {analytics.ctr}% (</span>
                  <span className={deltaClass(ctrDelta.positive)}>{ctrDelta.label}</span>
                  <span className="text-muted-foreground">)</span>
                </p>
              );
            })() : (
              <p className="text-xs text-muted-foreground mt-0.5">CTR: {analytics.ctr}%</p>
            )}
          </div>
          <div className="bg-card border border-white/10 rounded-xl p-5">
            <p className="text-sm text-muted-foreground">Outstanding</p>
            <p className="text-3xl font-bold text-amber-400 mt-1">{unpaidInvoices.length}</p>
            <p className="text-xs text-muted-foreground mt-0.5">{paidInvoices.length} paid</p>
          </div>
        </div>

        {/* Placements */}
        <section>
          <h2 className="text-lg font-bold text-white mb-4">Your Sponsorship Placements</h2>
          {assignments.length === 0 ? (
            <div className="bg-card border border-white/10 rounded-xl p-8 text-center text-muted-foreground">
              <Handshake className="w-8 h-8 mx-auto mb-2 opacity-30" />
              <p>No placements assigned yet. Contact your club administrator.</p>
            </div>
          ) : (
            <div className="space-y-3">
              {assignments.map(a => (
                <div key={a.id} className="bg-card border border-white/10 rounded-xl p-4 flex items-center gap-4">
                  <div className="w-10 h-10 bg-amber-500/10 rounded-lg flex items-center justify-center shrink-0">
                    <Handshake className="w-5 h-5 text-amber-400" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-white capitalize">
                      {a.assignmentType === "hole" ? `Hole ${a.holeNumber} Sponsorship` : `${a.assignmentType} Sponsorship`}
                    </p>
                    <div className="flex items-center gap-3 mt-0.5 text-xs text-muted-foreground">
                      {a.tournamentName && <span>Tournament: {a.tournamentName}</span>}
                      {a.packageName && <span className="text-amber-400">{a.packageName}</span>}
                    </div>
                  </div>
                  {a.tournamentId && (
                    <button
                      onClick={() => handleDownloadBadge(a.tournamentId!)}
                      disabled={downloadingBadge === a.tournamentId}
                      className="flex items-center gap-1.5 text-xs text-emerald-400 hover:text-emerald-300 border border-emerald-400/20 rounded-lg px-3 py-1.5 whitespace-nowrap disabled:opacity-50"
                    >
                      <Download className="w-3.5 h-3.5" />
                      {downloadingBadge === a.tournamentId ? "Downloading..." : "Badge"}
                    </button>
                  )}
                  <span className="text-xs bg-green-400/10 text-green-400 px-2 py-1 rounded-full shrink-0">Active</span>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Assets */}
        <section>
          <h2 className="text-lg font-bold text-white mb-4">Brand Assets</h2>
          <div className="grid md:grid-cols-2 gap-4">
            <AssetUploadPanel
              token={token}
              assetType="logo"
              label="Logo"
              currentUrl={sponsor.logoUrl}
              pendingUrl={sponsor.pendingLogoUrl}
              rejectionFeedback={sponsor.assetRejectionFeedback}
              onUploaded={fetchData}
            />
            <AssetUploadPanel
              token={token}
              assetType="banner"
              label="Banner"
              currentUrl={sponsor.bannerUrl}
              pendingUrl={sponsor.pendingBannerUrl}
              rejectionFeedback={sponsor.assetRejectionFeedback}
              onUploaded={fetchData}
            />
          </div>
        </section>

        {/* Analytics */}
        <section>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-bold text-white">Impressions Summary</h2>
            <button onClick={handleDownloadImpressions} disabled={downloadingImpressions}
              className="flex items-center gap-2 bg-white/10 hover:bg-white/20 disabled:opacity-50 text-white text-xs font-medium px-3 py-2 rounded-lg">
              <Download className="w-3.5 h-3.5" /> {downloadingImpressions ? "Preparing..." : "Download CSV"}
            </button>
          </div>
          <div className="bg-card border border-white/10 rounded-xl p-6">
            <div className="grid grid-cols-3 gap-6 text-center">
              <div>
                <div className="flex items-center justify-center gap-1.5 mb-1">
                  <TrendingUp className="w-4 h-4 text-amber-400" />
                  <p className="text-sm text-muted-foreground">Impressions</p>
                </div>
                <p className="text-3xl font-bold text-amber-400">{analytics.impressions.toLocaleString()}</p>
              </div>
              <div>
                <div className="flex items-center justify-center gap-1.5 mb-1">
                  <MousePointerClick className="w-4 h-4 text-blue-400" />
                  <p className="text-sm text-muted-foreground">Clicks</p>
                </div>
                <p className="text-3xl font-bold text-blue-400">{analytics.clicks.toLocaleString()}</p>
              </div>
              <div>
                <div className="flex items-center justify-center gap-1.5 mb-1">
                  <BarChart2 className="w-4 h-4 text-green-400" />
                  <p className="text-sm text-muted-foreground">CTR</p>
                </div>
                <p className="text-3xl font-bold text-green-400">{analytics.ctr}%</p>
              </div>
            </div>
            <p className="text-xs text-center text-muted-foreground mt-4">Last {analytics.days} days across all placements</p>
          </div>
        </section>

        {/* Per-slot breakdown (covers every event tagged with a slot, including
            non-campaign placements like leaderboard bug or scorecard footer) */}
        {analytics.bySlot && analytics.bySlot.length > 0 && (() => {
          type Row = { slotKey: string; impressions: number; clicks: number };
          const aggregate = (rows: NonNullable<Analytics["bySlot"]>): Map<string, Row> => {
            const map = new Map<string, Row>();
            for (const r of rows) {
              if (!r.slotKey) continue;
              const row = map.get(r.slotKey) ?? { slotKey: r.slotKey, impressions: 0, clicks: 0 };
              if (r.eventType === "impression") row.impressions += r.total;
              if (r.eventType === "click") row.clicks += r.total;
              map.set(r.slotKey, row);
            }
            return map;
          };
          const primaryMap = aggregate(analytics.bySlot!);
          const compareMap = comparison?.bySlot ? aggregate(comparison.bySlot) : new Map<string, Row>();
          // Union keys so slots that dropped to zero in the primary period
          // still appear (otherwise sponsors lose visibility into negative
          // movement when a placement disappears entirely).
          const allKeys = new Set<string>([...primaryMap.keys(), ...compareMap.keys()]);
          const rows = Array.from(allKeys).map(k => primaryMap.get(k) ?? { slotKey: k, impressions: 0, clicks: 0 })
            .sort((a, b) => b.impressions - a.impressions || (compareMap.get(b.slotKey)?.impressions ?? 0) - (compareMap.get(a.slotKey)?.impressions ?? 0));
          if (rows.length === 0) return null;
          const formatSlot = (k: string) => k.split("_").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
          return (
            <section>
              <h2 className="text-lg font-bold text-white mb-4">Performance by Ad Slot</h2>
              <div className="bg-card border border-white/10 rounded-xl overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-white/5 text-xs uppercase tracking-wide text-muted-foreground">
                    <tr>
                      <th className="text-left px-4 py-2.5">Slot</th>
                      <th className="text-right px-4 py-2.5">Impressions</th>
                      <th className="text-right px-4 py-2.5">Clicks</th>
                      <th className="text-right px-4 py-2.5">CTR</th>
                      {comparison && <th className="text-right px-4 py-2.5">Δ Impressions</th>}
                      {comparison && <th className="text-right px-4 py-2.5">Δ Clicks</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => {
                      const ctr = r.impressions > 0 ? ((r.clicks / r.impressions) * 100).toFixed(1) : "0.0";
                      const prev = compareMap.get(r.slotKey);
                      const dImp = comparison ? formatDelta(r.impressions, prev?.impressions ?? 0) : null;
                      const dClk = comparison ? formatDelta(r.clicks, prev?.clicks ?? 0) : null;
                      return (
                        <tr key={r.slotKey} className="border-t border-white/5">
                          <td className="px-4 py-2.5 text-white">{formatSlot(r.slotKey)}</td>
                          <td className="px-4 py-2.5 text-right text-amber-400 font-semibold">{r.impressions.toLocaleString()}</td>
                          <td className="px-4 py-2.5 text-right text-blue-400 font-semibold">{r.clicks.toLocaleString()}</td>
                          <td className="px-4 py-2.5 text-right text-green-400 font-semibold">{ctr}%</td>
                          {dImp && (
                            <td className={`px-4 py-2.5 text-right font-medium ${deltaClass(dImp.positive)}`}>
                              {dImp.label}
                              <span className="text-muted-foreground font-normal"> ({(prev?.impressions ?? 0).toLocaleString()})</span>
                            </td>
                          )}
                          {dClk && (
                            <td className={`px-4 py-2.5 text-right font-medium ${deltaClass(dClk.positive)}`}>
                              {dClk.label}
                              <span className="text-muted-foreground font-normal"> ({(prev?.clicks ?? 0).toLocaleString()})</span>
                            </td>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="text-xs text-muted-foreground mt-2">
                Impressions and clicks per ad slot, last {analytics.days} days.
                {comparison && ` Δ columns compare against the prior period (${comparison.from} → ${comparison.to}).`}
              </p>
            </section>
          );
        })()}

        {/* Per-tournament breakdown — aggregates impression/click totals by
            tournament so sponsors can see which events drove their numbers.
            Mirrors the per-slot table's comparison treatment: when a
            comparison range is active we add Δ Impressions and Δ Clicks
            columns, and a tournament that had zero impressions in the prior
            period renders the literal "new" label. */}
        {analytics.byTournament && analytics.byTournament.length > 0 && (() => {
          type Row = { key: string; tournamentId: number | null; tournamentName: string | null; impressions: number; clicks: number };
          const aggregate = (rows: NonNullable<Analytics["byTournament"]>): Map<string, Row> => {
            const map = new Map<string, Row>();
            for (const r of rows) {
              const key = r.tournamentId != null ? `t:${r.tournamentId}` : `n:${r.tournamentName ?? ""}`;
              const row = map.get(key) ?? { key, tournamentId: r.tournamentId, tournamentName: r.tournamentName, impressions: 0, clicks: 0 };
              if (r.eventType === "impression") row.impressions += r.total;
              if (r.eventType === "click") row.clicks += r.total;
              map.set(key, row);
            }
            return map;
          };
          const primaryMap = aggregate(analytics.byTournament!);
          const compareMap = comparison?.byTournament ? aggregate(comparison.byTournament) : new Map<string, Row>();
          // Union keys so tournaments that had activity in the prior period
          // but none in the primary still appear (matching the per-slot
          // table's behaviour for negative movement).
          const allKeys = new Set<string>([...primaryMap.keys(), ...compareMap.keys()]);
          const rows = Array.from(allKeys).map(k => {
            const p = primaryMap.get(k);
            if (p) return p;
            const c = compareMap.get(k)!;
            return { key: k, tournamentId: c.tournamentId, tournamentName: c.tournamentName, impressions: 0, clicks: 0 };
          }).sort((a, b) => b.impressions - a.impressions || (compareMap.get(b.key)?.impressions ?? 0) - (compareMap.get(a.key)?.impressions ?? 0));
          if (rows.length === 0) return null;
          return (
            <section>
              <h2 className="text-lg font-bold text-white mb-4">Performance by Tournament</h2>
              <div className="bg-card border border-white/10 rounded-xl overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-white/5 text-xs uppercase tracking-wide text-muted-foreground">
                    <tr>
                      <th className="text-left px-4 py-2.5">Tournament</th>
                      <th className="text-right px-4 py-2.5">Impressions</th>
                      <th className="text-right px-4 py-2.5">Clicks</th>
                      <th className="text-right px-4 py-2.5">CTR</th>
                      {comparison && <th className="text-right px-4 py-2.5">Δ Impressions</th>}
                      {comparison && <th className="text-right px-4 py-2.5">Δ Clicks</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => {
                      const ctr = r.impressions > 0 ? ((r.clicks / r.impressions) * 100).toFixed(1) : "0.0";
                      const prev = compareMap.get(r.key);
                      const dImp = comparison ? formatDelta(r.impressions, prev?.impressions ?? 0) : null;
                      const dClk = comparison ? formatDelta(r.clicks, prev?.clicks ?? 0) : null;
                      return (
                        <tr key={r.key} className="border-t border-white/5">
                          <td className="px-4 py-2.5 text-white">{r.tournamentName ?? "—"}</td>
                          <td className="px-4 py-2.5 text-right text-amber-400 font-semibold">{r.impressions.toLocaleString()}</td>
                          <td className="px-4 py-2.5 text-right text-blue-400 font-semibold">{r.clicks.toLocaleString()}</td>
                          <td className="px-4 py-2.5 text-right text-green-400 font-semibold">{ctr}%</td>
                          {dImp && (
                            <td className={`px-4 py-2.5 text-right font-medium ${deltaClass(dImp.positive)}`}>
                              {dImp.label}
                              <span className="text-muted-foreground font-normal"> ({(prev?.impressions ?? 0).toLocaleString()})</span>
                            </td>
                          )}
                          {dClk && (
                            <td className={`px-4 py-2.5 text-right font-medium ${deltaClass(dClk.positive)}`}>
                              {dClk.label}
                              <span className="text-muted-foreground font-normal"> ({(prev?.clicks ?? 0).toLocaleString()})</span>
                            </td>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="text-xs text-muted-foreground mt-2">
                Impressions and clicks per tournament, last {analytics.days} days.
                {comparison && ` Δ columns compare against the prior period (${comparison.from} → ${comparison.to}).`}
              </p>
            </section>
          );
        })()}

        {/* Per-slot CTR trend chart — same data as the per-day per-slot
            section in the impressions CSV, rendered as a line per slot. When
            a comparison range is active we overlay a dashed companion line
            per slot (same colour, lower opacity) aligned by day index, so
            sponsors get the same prior-period read the CSV's per-day
            per-slot rollup already provides. Slots present in only one of
            the two ranges still show, with zeros in the missing range. */}
        {((analytics.byDaySlot?.length ?? 0) > 0 ||
          (comparison?.byDaySlot?.length ?? 0) > 0) && (() => {
          type DayAgg = { day: string; impressions: number; clicks: number };
          const buildSlotMap = (rows: NonNullable<Analytics["byDaySlot"]>) => {
            const slots = new Map<string, Map<string, DayAgg>>();
            const dayKeys = new Set<string>();
            for (const r of rows) {
              if (!r.slotKey) continue;
              dayKeys.add(r.day);
              const inner = slots.get(r.slotKey) ?? new Map<string, DayAgg>();
              const agg = inner.get(r.day) ?? { day: r.day, impressions: 0, clicks: 0 };
              if (r.eventType === "impression") agg.impressions += r.total;
              else if (r.eventType === "click") agg.clicks += r.total;
              inner.set(r.day, agg);
              slots.set(r.slotKey, inner);
            }
            return { slots, dayKeys };
          };
          const primary = analytics.byDaySlot?.length
            ? buildSlotMap(analytics.byDaySlot)
            : { slots: new Map<string, Map<string, DayAgg>>(), dayKeys: new Set<string>() };
          const compare = comparison?.byDaySlot?.length
            ? buildSlotMap(comparison.byDaySlot)
            : { slots: new Map<string, Map<string, DayAgg>>(), dayKeys: new Set<string>() };
          if (primary.slots.size === 0 && compare.slots.size === 0) return null;
          const primaryDays = Array.from(primary.dayKeys).sort();
          const comparisonDays = Array.from(compare.dayKeys).sort();
          const formatSlot = (k: string) => k.split("_").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
          // Pick the top slots by total impressions across both ranges so a
          // slot that only had volume in the comparison period is still
          // visible (matches the per-slot table's union behaviour).
          const allSlotKeys = new Set<string>([...primary.slots.keys(), ...compare.slots.keys()]);
          const slotTotals = Array.from(allSlotKeys).map(slotKey => {
            let imp = 0;
            for (const a of primary.slots.get(slotKey)?.values() ?? []) imp += a.impressions;
            for (const a of compare.slots.get(slotKey)?.values() ?? []) imp += a.impressions;
            return { slotKey, imp };
          }).sort((a, b) => b.imp - a.imp);
          // Same top-6 cap as before so we don't change the slot count
          // sponsors are used to seeing in the trend chart.
          const topSlots = slotTotals.slice(0, 6).map(s => s.slotKey);
          // Index-align the two ranges so day i of primary sits next to day
          // i of comparison on the same x-axis position. Days/slots present
          // in only one range still appear with zeros in the missing range,
          // matching the CSV's per-day per-slot rollup.
          // Only render the dashed companion lines when the comparison
          // payload actually carries per-day per-slot rows — gating on
          // `comparison` alone would draw flat zero lines if the backend
          // ever returned a comparison block without `byDaySlot`.
          const showCompare = !!comparison && (comparison.byDaySlot?.length ?? 0) > 0;
          const positionCount = Math.max(primaryDays.length, comparisonDays.length);
          const chartData = Array.from({ length: positionCount }, (_, i) => {
            const day = primaryDays[i] ?? comparisonDays[i] ?? "";
            const cmpDay = comparisonDays[i] ?? "";
            const row: Record<string, number | string> = { day, cmpDay };
            for (const slotKey of topSlots) {
              const pDay = primaryDays[i];
              const pAgg = pDay ? primary.slots.get(slotKey)?.get(pDay) : undefined;
              row[slotKey] = pAgg && pAgg.impressions > 0
                ? Number(((pAgg.clicks / pAgg.impressions) * 100).toFixed(2))
                : 0;
              if (showCompare) {
                const cDay = comparisonDays[i];
                const cAgg = cDay ? compare.slots.get(slotKey)?.get(cDay) : undefined;
                row[`${slotKey}__cmp`] = cAgg && cAgg.impressions > 0
                  ? Number(((cAgg.clicks / cAgg.impressions) * 100).toFixed(2))
                  : 0;
              }
            }
            return row;
          });
          const palette = ["#fbbf24", "#60a5fa", "#34d399", "#f472b6", "#a78bfa", "#fb923c"];
          return (
            <section>
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-3">
                  <h2 className="text-lg font-bold text-white">Per-Slot CTR Trend</h2>
                  {hiddenTrendSlots.size > 0 && (
                    <button
                      type="button"
                      onClick={resetHiddenTrendSlots}
                      data-testid="reset-hidden-trend-slots"
                      className="text-xs font-medium text-amber-400 hover:text-amber-300 underline-offset-2 hover:underline focus:outline-none focus:ring-1 focus:ring-amber-400/60 rounded"
                      title="Show every slot in the chart again"
                    >
                      Show all slots ({hiddenTrendSlots.size} hidden)
                    </button>
                  )}
                </div>
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <LineChartIcon className="w-3.5 h-3.5 text-amber-400" />
                  <span>{positionCount} day{positionCount === 1 ? "" : "s"}</span>
                </div>
              </div>
              <div className="bg-card border border-white/10 rounded-xl p-4">
                <div className="w-full h-64">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={chartData} margin={{ top: 8, right: 16, left: 0, bottom: 4 }}>
                      <CartesianGrid stroke="rgba(255,255,255,0.06)" vertical={false} />
                      <XAxis
                        dataKey="day"
                        tick={{ fill: "#9ca3af", fontSize: 11 }}
                        tickFormatter={(d: string) => d ? d.slice(5) : ""}
                        stroke="rgba(255,255,255,0.1)"
                      />
                      <YAxis
                        tick={{ fill: "#9ca3af", fontSize: 11 }}
                        tickFormatter={(v: number) => `${v}%`}
                        stroke="rgba(255,255,255,0.1)"
                        width={48}
                      />
                      <Tooltip
                        contentStyle={{ background: "#0b0b0b", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8, fontSize: 12 }}
                        labelStyle={{ color: "#fff" }}
                        labelFormatter={(label, payload) => {
                          // recharts v3 widens the payload param to a
                          // readonly array of generic Payload entries; the
                          // nested `payload` is typed as `any`. Narrow to
                          // the cmpDay field we actually rendered.
                          const cmp = (payload?.[0]?.payload as { cmpDay?: string } | undefined)?.cmpDay;
                          const labelStr = typeof label === "string" || typeof label === "number" ? String(label) : "";
                          return comparison && cmp ? `${labelStr || "—"} · vs ${cmp}` : (labelStr || "—");
                        }}
                        formatter={(value: number, name: string) => {
                          const isCmp = name.endsWith("__cmp");
                          const slotKey = isCmp ? name.slice(0, -"__cmp".length) : name;
                          return [`${value}%`, `${formatSlot(slotKey)}${isCmp ? " (vs prior)" : ""}`];
                        }}
                      />
                      <Legend
                        wrapperStyle={{ fontSize: 11, paddingTop: 8, cursor: "pointer" }}
                        formatter={(value: string) => {
                          const label = formatSlot(value);
                          // Recharts greys the legend swatch when a Line has
                          // hide=true, but the text colour stays the same. Dim
                          // the label too so muted slots read clearly.
                          return hiddenTrendSlots.has(value)
                            ? <span style={{ opacity: 0.45, textDecoration: "line-through" }}>{label}</span>
                            : <span>{label}</span>;
                        }}
                        onClick={(payload) => {
                          // Recharts types `dataKey` loosely (it accepts a
                          // function for derived series); narrow to the string
                          // case our slot keys actually use.
                          const raw = (payload as { dataKey?: unknown; value?: unknown });
                          const key = typeof raw.dataKey === "string"
                            ? raw.dataKey
                            : (typeof raw.value === "string" ? raw.value : null);
                          // Dashed companions carry legendType="none" so they
                          // never appear in the legend, but guard anyway in
                          // case a future Recharts version surfaces them.
                          if (key && !key.endsWith("__cmp")) toggleTrendSlot(key);
                        }}
                      />
                      {topSlots.flatMap((slotKey, idx) => {
                        // Flatten the primary + dashed companion <Line> pair
                        // into a flat array instead of wrapping them in
                        // React.Fragment. Recharts 2 walks its children with
                        // `react-is@18`'s `isFragment`, which under React 19
                        // returns false for fragments (the element
                        // `$$typeof` switched to `react.transitional.element`)
                        // and silently swallows everything inside. Returning
                        // the Lines directly keeps recharts' child traversal
                        // happy across React versions.
                        const muted = hiddenTrendSlots.has(slotKey);
                        const nodes: React.ReactNode[] = [
                          <Line
                            key={slotKey}
                            type="monotone"
                            dataKey={slotKey}
                            stroke={palette[idx % palette.length]}
                            strokeWidth={2}
                            dot={false}
                            activeDot={{ r: 4 }}
                            isAnimationActive={false}
                            hide={muted}
                          />,
                        ];
                        if (showCompare) {
                          nodes.push(
                            <Line
                              key={`${slotKey}__cmp`}
                              type="monotone"
                              dataKey={`${slotKey}__cmp`}
                              stroke={palette[idx % palette.length]}
                              strokeWidth={2}
                              strokeDasharray="4 3"
                              strokeOpacity={0.65}
                              dot={false}
                              activeDot={{ r: 3 }}
                              isAnimationActive={false}
                              legendType="none"
                              hide={muted}
                            />,
                          );
                        }
                        return nodes;
                      })}
                    </LineChart>
                  </ResponsiveContainer>
                </div>
                <p className="text-xs text-muted-foreground mt-3">
                  Daily CTR per ad slot for the selected date range
                  {slotTotals.length > topSlots.length && ` (top ${topSlots.length} of ${slotTotals.length} slots by impressions)`}.
                  {showCompare
                    ? ` Dashed lines show the comparison range (${comparison!.from} → ${comparison!.to}), aligned by day index.`
                    : " Same data as the Per-Day Per-Slot CTR Trend section in the CSV download."}
                </p>
              </div>
            </section>
          );
        })()}

        {/* Ad-campaign performance breakdown */}
        {analytics.byAdCampaign && analytics.byAdCampaign.length > 0 && (() => {
          type Row = { key: string; campaignId: number | null; campaignName: string | null; slotName: string | null; slotKey: string | null; creativeId: number | null; creativeName: string | null; impressions: number; clicks: number };
          const aggregate = (rows: NonNullable<Analytics["byAdCampaign"]>): Map<string, Row> => {
            const map = new Map<string, Row>();
            for (const r of rows) {
              const key = `${r.campaignId}:${r.creativeId}`;
              const row = map.get(key) ?? { key, campaignId: r.campaignId, campaignName: r.campaignName, slotName: r.slotName, slotKey: r.slotKey, creativeId: r.creativeId, creativeName: r.creativeName, impressions: 0, clicks: 0 };
              if (r.eventType === "impression") row.impressions += r.total;
              if (r.eventType === "click") row.clicks += r.total;
              map.set(key, row);
            }
            return map;
          };
          const primaryMap = aggregate(analytics.byAdCampaign!);
          const compareMap = comparison?.byAdCampaign ? aggregate(comparison.byAdCampaign) : new Map<string, Row>();
          // Union keys so campaigns/creatives that disappeared in the primary
          // period still surface, otherwise sponsors can't see negative drops.
          const allKeys = new Set<string>([...primaryMap.keys(), ...compareMap.keys()]);
          const rows = Array.from(allKeys).map(k => primaryMap.get(k) ?? { ...(compareMap.get(k) as Row), impressions: 0, clicks: 0 })
            .sort((a, b) => b.impressions - a.impressions || (compareMap.get(b.key)?.impressions ?? 0) - (compareMap.get(a.key)?.impressions ?? 0));
          return (
            <section>
              <h2 className="text-lg font-bold text-white mb-4">Ad Campaign Performance</h2>
              <div className="bg-card border border-white/10 rounded-xl overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-white/5 text-xs uppercase tracking-wide text-muted-foreground">
                    <tr>
                      <th className="text-left px-4 py-2.5">Campaign</th>
                      <th className="text-left px-4 py-2.5">Slot</th>
                      <th className="text-left px-4 py-2.5">Creative</th>
                      <th className="text-right px-4 py-2.5">Impressions</th>
                      <th className="text-right px-4 py-2.5">Clicks</th>
                      <th className="text-right px-4 py-2.5">CTR</th>
                      {comparison && <th className="text-right px-4 py-2.5">Δ Impressions</th>}
                      {comparison && <th className="text-right px-4 py-2.5">Δ Clicks</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => {
                      const ctr = r.impressions > 0 ? ((r.clicks / r.impressions) * 100).toFixed(1) : "0.0";
                      const prev = compareMap.get(r.key);
                      const dImp = comparison ? formatDelta(r.impressions, prev?.impressions ?? 0) : null;
                      const dClk = comparison ? formatDelta(r.clicks, prev?.clicks ?? 0) : null;
                      return (
                        <tr key={r.key} className="border-t border-white/5">
                          <td className="px-4 py-2.5 text-white">{r.campaignName ?? "—"}</td>
                          <td className="px-4 py-2.5 text-muted-foreground">{r.slotName ?? r.slotKey ?? "—"}</td>
                          <td className="px-4 py-2.5 text-muted-foreground">{r.creativeName ?? "—"}</td>
                          <td className="px-4 py-2.5 text-right text-amber-400 font-semibold">{r.impressions.toLocaleString()}</td>
                          <td className="px-4 py-2.5 text-right text-blue-400 font-semibold">{r.clicks.toLocaleString()}</td>
                          <td className="px-4 py-2.5 text-right text-green-400 font-semibold">{ctr}%</td>
                          {dImp && (
                            <td className={`px-4 py-2.5 text-right font-medium ${deltaClass(dImp.positive)}`}>
                              {dImp.label}
                              <span className="text-muted-foreground font-normal"> ({(prev?.impressions ?? 0).toLocaleString()})</span>
                            </td>
                          )}
                          {dClk && (
                            <td className={`px-4 py-2.5 text-right font-medium ${deltaClass(dClk.positive)}`}>
                              {dClk.label}
                              <span className="text-muted-foreground font-normal"> ({(prev?.clicks ?? 0).toLocaleString()})</span>
                            </td>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="text-xs text-muted-foreground mt-2">
                Live metrics, last {analytics.days} days. Use Download CSV above for a full per-day export.
                {comparison && ` Δ columns compare against ${comparison.from} → ${comparison.to}.`}
              </p>
            </section>
          );
        })()}

        {/* Co-branded badge download (per tournament) */}
        {tournamentsWithAssignments.length > 0 && (
          <section>
            <h2 className="text-lg font-bold text-white mb-4">Co-Branded Marketing Assets</h2>
            <div className="space-y-3">
              {tournamentsWithAssignments.map(a => (
                <div key={a.tournamentId} className="bg-card border border-white/10 rounded-xl p-4 flex items-center justify-between gap-4">
                  <div>
                    <p className="font-medium text-white">"Official Sponsor of {a.tournamentName}" Badge</p>
                    <p className="text-xs text-muted-foreground mt-0.5">SVG badge for use in email signatures, social media, and marketing materials</p>
                  </div>
                  <button
                    onClick={() => handleDownloadBadge(a.tournamentId!)}
                    disabled={downloadingBadge === a.tournamentId}
                    className="flex items-center gap-2 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 text-sm font-medium px-4 py-2.5 rounded-lg border border-emerald-500/20 whitespace-nowrap disabled:opacity-50"
                  >
                    <Download className="w-4 h-4" />
                    {downloadingBadge === a.tournamentId ? "Downloading..." : "Download Badge"}
                  </button>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Invoices */}
        <section>
          <h2 className="text-lg font-bold text-white mb-4">Invoices</h2>
          {invoices.length === 0 ? (
            <div className="bg-card border border-white/10 rounded-xl p-8 text-center text-muted-foreground">
              No invoices on file yet.
            </div>
          ) : (
            <div className="overflow-x-auto bg-card border border-white/10 rounded-xl">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs text-muted-foreground border-b border-white/10">
                    <th className="text-left py-3 px-4 font-medium">Invoice #</th>
                    <th className="text-left py-3 px-4 font-medium">Amount</th>
                    <th className="text-left py-3 px-4 font-medium">Status</th>
                    <th className="text-left py-3 px-4 font-medium">Due Date</th>
                    <th className="text-left py-3 px-4 font-medium">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {invoices.map(inv => (
                    <tr key={inv.id} className="border-b border-white/5 last:border-0">
                      <td className="py-3 px-4 font-mono text-xs text-muted-foreground">{inv.invoiceNumber}</td>
                      <td className="py-3 px-4 text-white font-semibold">{inv.currency} {Number(inv.amount).toLocaleString()}</td>
                      <td className="py-3 px-4">
                        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                          inv.paymentStatus === "paid" ? "text-green-400 bg-green-400/10" :
                          inv.paymentStatus === "pending" ? "text-yellow-400 bg-yellow-400/10" :
                          "text-red-400 bg-red-400/10"
                        }`}>
                          {inv.paymentStatus.charAt(0).toUpperCase() + inv.paymentStatus.slice(1)}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-muted-foreground text-xs">
                        {inv.dueDate ? new Date(inv.dueDate).toLocaleDateString() : "—"}
                      </td>
                      <td className="py-3 px-4">
                        {inv.razorpayPaymentLinkUrl && inv.paymentStatus !== "paid" ? (
                          <a href={inv.razorpayPaymentLinkUrl} target="_blank" rel="noopener noreferrer"
                            className="flex items-center gap-1 text-xs text-amber-400 hover:text-amber-300 font-medium">
                            <LinkIcon className="w-3.5 h-3.5" /> Pay Now
                          </a>
                        ) : inv.paymentStatus === "paid" ? (
                          <span className="flex items-center gap-1 text-xs text-green-400">
                            <CheckCircle2 className="w-3.5 h-3.5" /> Paid {inv.paidAt ? `on ${new Date(inv.paidAt).toLocaleDateString()}` : ""}
                          </span>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

// ─── Main Page ─────────────────────────────────────────────────────────────────

export default function SponsorPortalPage() {
  const [token, setToken] = useState<string | null>(() => {
    try { return localStorage.getItem(PORTAL_TOKEN_KEY); } catch { return null; }
  });

  const params = new URLSearchParams(typeof window !== "undefined" ? window.location.search : "");
  const inviteToken = params.get("invite");

  const handleLogin = (t: string) => setToken(t);
  const handleClaimed = (t: string) => {
    setToken(t);
    window.history.replaceState({}, "", "/sponsor-portal");
  };

  const handleLogout = () => {
    try { localStorage.removeItem(PORTAL_TOKEN_KEY); } catch {}
    setToken(null);
  };

  if (inviteToken && !token) return <ClaimInvitePage inviteToken={inviteToken} onClaimed={handleClaimed} />;
  if (!token) return <LoginForm onLogin={handleLogin} />;
  return <PortalDashboard token={token} onLogout={handleLogout} />;
}
