import { useState } from "react";
import { useActiveOrgContext } from "@/context/ActiveOrgContext";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import {
  Gift, Plus, Search, RefreshCw, Send, Ban, CreditCard, Users,
  ChevronRight, History, Loader2, Tag, CircleDollarSign,
} from "lucide-react";
import { getLocale } from "@/i18n";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

type GiftCard = {
  id: number;
  code: string;
  type: "physical" | "digital";
  status: "active" | "redeemed" | "expired" | "cancelled";
  initialBalancePaise: number;
  currentBalancePaise: number;
  currency: string;
  recipientName: string | null;
  recipientEmail: string | null;
  purchaserName: string | null;
  message: string | null;
  expiresAt: string | null;
  emailSentAt: string | null;
  createdAt: string;
};

type StoreCreditAccount = {
  id: number;
  memberId: number;
  balancePaise: number;
  currency: string;
  memberFirstName: string | null;
  memberLastName: string | null;
  memberEmail: string | null;
  memberNumber: string | null;
  updatedAt: string;
};

type Member = {
  id: number;
  memberNumber: string | null;
  firstName: string;
  lastName: string;
  email: string | null;
};

function fmt(paise: number) {
  return `₹${(paise / 100).toFixed(2)}`;
}

function statusBadge(status: GiftCard["status"]) {
  const map: Record<GiftCard["status"], string> = {
    active: "bg-green-500/10 text-green-400 border-green-500/20",
    redeemed: "bg-blue-500/10 text-blue-400 border-blue-500/20",
    expired: "bg-orange-500/10 text-orange-400 border-orange-500/20",
    cancelled: "bg-red-500/10 text-red-400 border-red-500/20",
  };
  return (
    <Badge className={`border ${map[status]} capitalize`}>{status}</Badge>
  );
}

export default function GiftCardsPage() {
  const { activeOrgId } = useActiveOrgContext();
  const { toast } = useToast();
  const qc = useQueryClient();

  const [tab, setTab] = useState<"gift-cards" | "store-credit">("gift-cards");
  const [statusFilter, setStatusFilter] = useState("all");
  const [searchQ, setSearchQ] = useState("");
  const [showIssueDialog, setShowIssueDialog] = useState(false);
  const [showRedeemDialog, setShowRedeemDialog] = useState<GiftCard | null>(null);
  const [showHistoryDialog, setShowHistoryDialog] = useState<GiftCard | null>(null);
  const [showLookupDialog, setShowLookupDialog] = useState(false);
  const [showCreditDialog, setShowCreditDialog] = useState<"issue" | "adjust" | null>(null);
  const [selectedMember, setSelectedMember] = useState<StoreCreditAccount | null>(null);

  const [issueForm, setIssueForm] = useState({
    type: "digital" as "physical" | "digital",
    amountRupees: "",
    recipientName: "",
    recipientEmail: "",
    recipientPhone: "",
    purchaserName: "",
    message: "",
    expiryDays: "365",
  });

  const [redeemAmountRupees, setRedeemAmountRupees] = useState("");
  const [lookupCode, setLookupCode] = useState("");
  const [lookupResult, setLookupResult] = useState<{ valid: boolean; reason?: string; card: GiftCard } | null>(null);
  const [creditAmount, setCreditAmount] = useState("");
  const [creditReason, setCreditReason] = useState("");
  const [memberSearchQ, setMemberSearchQ] = useState("");

  const cardsQuery = useQuery({
    queryKey: ["gift-cards", activeOrgId, statusFilter, searchQ],
    queryFn: async () => {
      if (!activeOrgId) return { cards: [], total: 0 };
      const params = new URLSearchParams();
      if (statusFilter !== "all") params.set("status", statusFilter);
      if (searchQ.trim()) params.set("q", searchQ.trim());
      const r = await fetch(`${BASE}/api/organizations/${activeOrgId}/gift-cards?${params}`, { credentials: "include" });
      if (!r.ok) throw new Error("Failed to load gift cards");
      return r.json() as Promise<{ cards: GiftCard[]; total: number }>;
    },
    enabled: !!activeOrgId && tab === "gift-cards",
  });

  const statsQuery = useQuery({
    queryKey: ["gift-cards-stats", activeOrgId],
    queryFn: async () => {
      if (!activeOrgId) return null;
      const r = await fetch(`${BASE}/api/organizations/${activeOrgId}/gift-cards/stats`, { credentials: "include" });
      if (!r.ok) return null;
      return r.json() as Promise<{ activeCount: number; activeTotalBalancePaise: number; redeemedCount: number }>;
    },
    enabled: !!activeOrgId,
  });

  const creditAccountsQuery = useQuery({
    queryKey: ["store-credit", activeOrgId],
    queryFn: async () => {
      if (!activeOrgId) return [];
      const r = await fetch(`${BASE}/api/organizations/${activeOrgId}/store-credit`, { credentials: "include" });
      if (!r.ok) return [];
      return r.json() as Promise<StoreCreditAccount[]>;
    },
    enabled: !!activeOrgId && tab === "store-credit",
  });

  const membersSearchQuery = useQuery({
    queryKey: ["pos-member-search", activeOrgId, memberSearchQ],
    queryFn: async () => {
      if (!activeOrgId || memberSearchQ.length < 2) return [];
      const r = await fetch(`${BASE}/api/organizations/${activeOrgId}/pos/members/search?q=${encodeURIComponent(memberSearchQ)}`, { credentials: "include" });
      if (!r.ok) return [];
      return r.json() as Promise<Member[]>;
    },
    enabled: !!activeOrgId && memberSearchQ.length >= 2,
  });

  const historyQuery = useQuery({
    queryKey: ["gift-card-history", showHistoryDialog?.id],
    queryFn: async () => {
      if (!activeOrgId || !showHistoryDialog) return [];
      const r = await fetch(`${BASE}/api/organizations/${activeOrgId}/gift-cards/${showHistoryDialog.id}/redemptions`, { credentials: "include" });
      if (!r.ok) return [];
      return r.json();
    },
    enabled: !!showHistoryDialog && !!activeOrgId,
  });

  const issueMutation = useMutation({
    mutationFn: async () => {
      const r = await fetch(`${BASE}/api/organizations/${activeOrgId}/gift-cards`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(issueForm),
      });
      if (!r.ok) { const e = await r.json(); throw new Error(e.error ?? "Failed"); }
      return r.json();
    },
    onSuccess: () => {
      toast({ title: "Gift card issued", description: "The gift card has been created successfully." });
      setShowIssueDialog(false);
      setIssueForm({ type: "digital", amountRupees: "", recipientName: "", recipientEmail: "", recipientPhone: "", purchaserName: "", message: "", expiryDays: "365" });
      qc.invalidateQueries({ queryKey: ["gift-cards", activeOrgId] });
      qc.invalidateQueries({ queryKey: ["gift-cards-stats", activeOrgId] });
    },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const redeemMutation = useMutation({
    mutationFn: async () => {
      if (!showRedeemDialog) return;
      const r = await fetch(`${BASE}/api/organizations/${activeOrgId}/gift-cards/${showRedeemDialog.id}/redeem`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ amountRupees: redeemAmountRupees }),
      });
      if (!r.ok) { const e = await r.json(); throw new Error(e.error ?? "Failed"); }
      return r.json();
    },
    onSuccess: (data) => {
      toast({ title: "Redeemed", description: `${fmt(data.amountRedeemedPaise)} redeemed. Remaining: ${fmt(data.remainingBalancePaise)}` });
      setShowRedeemDialog(null);
      setRedeemAmountRupees("");
      qc.invalidateQueries({ queryKey: ["gift-cards", activeOrgId] });
      qc.invalidateQueries({ queryKey: ["gift-cards-stats", activeOrgId] });
    },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const cancelMutation = useMutation({
    mutationFn: async (cardId: number) => {
      const r = await fetch(`${BASE}/api/organizations/${activeOrgId}/gift-cards/${cardId}/cancel`, {
        method: "PATCH",
        credentials: "include",
      });
      if (!r.ok) { const e = await r.json(); throw new Error(e.error ?? "Failed"); }
    },
    onSuccess: () => {
      toast({ title: "Gift card cancelled" });
      qc.invalidateQueries({ queryKey: ["gift-cards", activeOrgId] });
      qc.invalidateQueries({ queryKey: ["gift-cards-stats", activeOrgId] });
    },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const resendMutation = useMutation({
    mutationFn: async (cardId: number) => {
      const r = await fetch(`${BASE}/api/organizations/${activeOrgId}/gift-cards/${cardId}/resend-email`, {
        method: "POST",
        credentials: "include",
      });
      if (!r.ok) { const e = await r.json(); throw new Error(e.error ?? "Failed"); }
    },
    onSuccess: () => toast({ title: "Email resent" }),
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const issueCreditMutation = useMutation({
    mutationFn: async ({ memberId, amount, reason, type }: { memberId: number; amount: string; reason: string; type: "issue" | "adjust" }) => {
      const endpoint = type === "adjust" ? "adjust" : "issue";
      const r = await fetch(`${BASE}/api/organizations/${activeOrgId}/store-credit/members/${memberId}/${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ amountRupees: amount, reason }),
      });
      if (!r.ok) { const e = await r.json(); throw new Error(e.error ?? "Failed"); }
      return r.json();
    },
    onSuccess: (data) => {
      toast({ title: "Store credit updated", description: `New balance: ${fmt(data.newBalancePaise)}` });
      setShowCreditDialog(null);
      setCreditAmount("");
      setCreditReason("");
      qc.invalidateQueries({ queryKey: ["store-credit", activeOrgId] });
    },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const handleLookup = async () => {
    if (!lookupCode.trim() || !activeOrgId) return;
    try {
      const r = await fetch(`${BASE}/api/organizations/${activeOrgId}/gift-cards/lookup?code=${encodeURIComponent(lookupCode.trim())}`, { credentials: "include" });
      const data = await r.json();
      if (r.ok) {
        setLookupResult(data);
      } else {
        toast({ title: "Not found", description: data.error, variant: "destructive" });
      }
    } catch {
      toast({ title: "Error", description: "Lookup failed", variant: "destructive" });
    }
  };

  const cards = cardsQuery.data?.cards ?? [];
  const creditAccounts = creditAccountsQuery.data ?? [];

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Gift className="w-6 h-6 text-primary" />
            Gift Cards & Store Credit
          </h1>
          <p className="text-muted-foreground text-sm mt-0.5">Issue gift cards, manage balances, and track redemptions</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => setShowLookupDialog(true)}>
            <Search className="w-4 h-4 mr-1.5" /> Lookup Code
          </Button>
          {tab === "gift-cards" && (
            <Button onClick={() => setShowIssueDialog(true)}>
              <Plus className="w-4 h-4 mr-1.5" /> Issue Gift Card
            </Button>
          )}
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card>
          <CardContent className="pt-5">
            <div className="flex items-center gap-3">
              <Tag className="w-8 h-8 text-green-400 bg-green-500/10 rounded-lg p-1.5" />
              <div>
                <p className="text-xs text-muted-foreground">Active Gift Cards</p>
                <p className="text-2xl font-bold">{statsQuery.data?.activeCount ?? 0}</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-5">
            <div className="flex items-center gap-3">
              <CircleDollarSign className="w-8 h-8 text-blue-400 bg-blue-500/10 rounded-lg p-1.5" />
              <div>
                <p className="text-xs text-muted-foreground">Outstanding Balance</p>
                <p className="text-2xl font-bold">{fmt(statsQuery.data?.activeTotalBalancePaise ?? 0)}</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-5">
            <div className="flex items-center gap-3">
              <CreditCard className="w-8 h-8 text-purple-400 bg-purple-500/10 rounded-lg p-1.5" />
              <div>
                <p className="text-xs text-muted-foreground">Fully Redeemed</p>
                <p className="text-2xl font-bold">{statsQuery.data?.redeemedCount ?? 0}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as "gift-cards" | "store-credit")}>
        <TabsList>
          <TabsTrigger value="gift-cards"><Gift className="w-4 h-4 mr-1.5" /> Gift Cards</TabsTrigger>
          <TabsTrigger value="store-credit"><Users className="w-4 h-4 mr-1.5" /> Store Credit</TabsTrigger>
        </TabsList>

        {/* ─── GIFT CARDS TAB ─── */}
        <TabsContent value="gift-cards" className="space-y-4 mt-4">
          <div className="flex gap-3">
            <div className="relative flex-1 max-w-sm">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                className="pl-9"
                placeholder="Search code, name, email..."
                value={searchQ}
                onChange={(e) => setSearchQ(e.target.value)}
              />
            </div>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Status</SelectItem>
                <SelectItem value="active">Active</SelectItem>
                <SelectItem value="redeemed">Redeemed</SelectItem>
                <SelectItem value="expired">Expired</SelectItem>
                <SelectItem value="cancelled">Cancelled</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {cardsQuery.isLoading ? (
            <div className="flex items-center gap-2 text-muted-foreground py-8 justify-center">
              <Loader2 className="w-5 h-5 animate-spin" /> Loading...
            </div>
          ) : (
            <Card>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Code</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Recipient</TableHead>
                    <TableHead>Initial</TableHead>
                    <TableHead>Remaining</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Expires</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {cards.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={8} className="text-center text-muted-foreground py-10">
                        No gift cards found
                      </TableCell>
                    </TableRow>
                  ) : cards.map((card) => (
                    <TableRow key={card.id}>
                      <TableCell className="font-mono text-sm font-semibold tracking-wider">{card.code}</TableCell>
                      <TableCell className="capitalize">{card.type}</TableCell>
                      <TableCell>
                        <div className="text-sm">
                          {card.recipientName && <p>{card.recipientName}</p>}
                          {card.recipientEmail && <p className="text-muted-foreground text-xs">{card.recipientEmail}</p>}
                        </div>
                      </TableCell>
                      <TableCell>{fmt(card.initialBalancePaise)}</TableCell>
                      <TableCell className="font-semibold">{fmt(card.currentBalancePaise)}</TableCell>
                      <TableCell>{statusBadge(card.status)}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {card.expiresAt ? new Date(card.expiresAt).toLocaleDateString(getLocale()) : "—"}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1">
                          {card.status === "active" && (
                            <Button size="sm" variant="outline" onClick={() => { setShowRedeemDialog(card); setRedeemAmountRupees(""); }}>
                              <CreditCard className="w-3.5 h-3.5 mr-1" /> Redeem
                            </Button>
                          )}
                          <Button size="sm" variant="ghost" onClick={() => setShowHistoryDialog(card)}>
                            <History className="w-3.5 h-3.5" />
                          </Button>
                          {card.type === "digital" && card.recipientEmail && card.status === "active" && (
                            <Button size="sm" variant="ghost" onClick={() => resendMutation.mutate(card.id)} title="Resend email">
                              <Send className="w-3.5 h-3.5" />
                            </Button>
                          )}
                          {card.status === "active" && (
                            <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => {
                              if (confirm("Cancel this gift card?")) cancelMutation.mutate(card.id);
                            }}>
                              <Ban className="w-3.5 h-3.5" />
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Card>
          )}
        </TabsContent>

        {/* ─── STORE CREDIT TAB ─── */}
        <TabsContent value="store-credit" className="space-y-4 mt-4">
          {/* Member search for credit issuance */}
          <div className="flex gap-3 items-start">
            <div className="relative flex-1 max-w-sm">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                className="pl-9"
                placeholder="Search member to issue credit..."
                value={memberSearchQ}
                onChange={(e) => setMemberSearchQ(e.target.value)}
              />
              {membersSearchQuery.data && membersSearchQuery.data.length > 0 && memberSearchQ.length >= 2 && (
                <div className="absolute top-full left-0 right-0 z-50 bg-card border border-white/10 rounded-xl shadow-xl mt-1 max-h-60 overflow-y-auto">
                  {membersSearchQuery.data.map(m => (
                    <button
                      key={m.id}
                      className="w-full text-left px-4 py-2.5 hover:bg-white/5 text-sm flex items-center gap-2"
                      onClick={() => {
                        const existing = creditAccounts.find(a => a.memberId === m.id);
                        setSelectedMember(existing ?? {
                          id: 0,
                          memberId: m.id,
                          balancePaise: 0,
                          currency: "INR",
                          memberFirstName: m.firstName,
                          memberLastName: m.lastName,
                          memberEmail: m.email,
                          memberNumber: m.memberNumber,
                          updatedAt: new Date().toISOString(),
                        });
                        setShowCreditDialog("issue");
                        setMemberSearchQ("");
                      }}
                    >
                      <span className="font-medium">{m.firstName} {m.lastName}</span>
                      {m.memberNumber && <span className="text-muted-foreground">#{m.memberNumber}</span>}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {creditAccountsQuery.isLoading ? (
            <div className="flex items-center gap-2 text-muted-foreground py-8 justify-center">
              <Loader2 className="w-5 h-5 animate-spin" /> Loading...
            </div>
          ) : (
            <Card>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Member</TableHead>
                    <TableHead>Member #</TableHead>
                    <TableHead>Email</TableHead>
                    <TableHead>Balance</TableHead>
                    <TableHead>Last Activity</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {creditAccounts.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={6} className="text-center text-muted-foreground py-10">
                        No store credit accounts yet. Search for a member above to issue credit.
                      </TableCell>
                    </TableRow>
                  ) : creditAccounts.map((acc) => (
                    <TableRow key={acc.id}>
                      <TableCell className="font-medium">{acc.memberFirstName} {acc.memberLastName}</TableCell>
                      <TableCell className="text-muted-foreground">{acc.memberNumber ?? "—"}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">{acc.memberEmail ?? "—"}</TableCell>
                      <TableCell>
                        <span className={`font-semibold ${acc.balancePaise > 0 ? "text-green-400" : "text-muted-foreground"}`}>
                          {fmt(acc.balancePaise)}
                        </span>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {new Date(acc.updatedAt).toLocaleDateString(getLocale())}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1">
                          <Button size="sm" variant="outline" onClick={() => { setSelectedMember(acc); setShowCreditDialog("issue"); setCreditAmount(""); setCreditReason(""); }}>
                            <Plus className="w-3.5 h-3.5 mr-1" /> Add
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => { setSelectedMember(acc); setShowCreditDialog("adjust"); setCreditAmount(""); setCreditReason(""); }}>
                            <RefreshCw className="w-3.5 h-3.5 mr-1" /> Adjust
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Card>
          )}
        </TabsContent>
      </Tabs>

      {/* ─── ISSUE GIFT CARD DIALOG ─── */}
      <Dialog open={showIssueDialog} onOpenChange={setShowIssueDialog}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Gift className="w-5 h-5 text-primary" /> Issue Gift Card
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>Type</Label>
                <Select value={issueForm.type} onValueChange={(v) => setIssueForm(f => ({ ...f, type: v as "physical" | "digital" }))}>
                  <SelectTrigger className="mt-1.5">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="digital">Digital (email)</SelectItem>
                    <SelectItem value="physical">Physical (printed)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Amount (₹)</Label>
                <Input
                  type="number"
                  min="1"
                  step="0.01"
                  className="mt-1.5"
                  placeholder="e.g. 2000"
                  value={issueForm.amountRupees}
                  onChange={(e) => setIssueForm(f => ({ ...f, amountRupees: e.target.value }))}
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>Recipient Name</Label>
                <Input
                  className="mt-1.5"
                  value={issueForm.recipientName}
                  onChange={(e) => setIssueForm(f => ({ ...f, recipientName: e.target.value }))}
                />
              </div>
              <div>
                <Label>Recipient Email</Label>
                <Input
                  type="email"
                  className="mt-1.5"
                  value={issueForm.recipientEmail}
                  onChange={(e) => setIssueForm(f => ({ ...f, recipientEmail: e.target.value }))}
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>Purchaser Name</Label>
                <Input
                  className="mt-1.5"
                  value={issueForm.purchaserName}
                  onChange={(e) => setIssueForm(f => ({ ...f, purchaserName: e.target.value }))}
                />
              </div>
              <div>
                <Label>Expiry (days)</Label>
                <Input
                  type="number"
                  min="0"
                  className="mt-1.5"
                  placeholder="365 (0 = no expiry)"
                  value={issueForm.expiryDays}
                  onChange={(e) => setIssueForm(f => ({ ...f, expiryDays: e.target.value }))}
                />
              </div>
            </div>
            <div>
              <Label>Personal Message (optional)</Label>
              <Textarea
                className="mt-1.5"
                rows={2}
                value={issueForm.message}
                onChange={(e) => setIssueForm(f => ({ ...f, message: e.target.value }))}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowIssueDialog(false)}>Cancel</Button>
            <Button
              onClick={() => issueMutation.mutate()}
              disabled={issueMutation.isPending || !issueForm.amountRupees}
            >
              {issueMutation.isPending ? <><Loader2 className="w-4 h-4 mr-1.5 animate-spin" /> Issuing...</> : "Issue Gift Card"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ─── REDEEM DIALOG ─── */}
      <Dialog open={!!showRedeemDialog} onOpenChange={() => setShowRedeemDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Redeem Gift Card</DialogTitle>
          </DialogHeader>
          {showRedeemDialog && (
            <div className="space-y-4 py-2">
              <div className="bg-muted/50 rounded-lg p-4 space-y-1">
                <p className="text-sm font-mono font-bold tracking-wider">{showRedeemDialog.code}</p>
                <p className="text-sm text-muted-foreground">Available: <span className="text-foreground font-semibold">{fmt(showRedeemDialog.currentBalancePaise)}</span></p>
              </div>
              <div>
                <Label>Amount to Redeem (₹)</Label>
                <Input
                  type="number"
                  min="0.01"
                  step="0.01"
                  max={(showRedeemDialog.currentBalancePaise / 100).toFixed(2)}
                  className="mt-1.5"
                  value={redeemAmountRupees}
                  onChange={(e) => setRedeemAmountRupees(e.target.value)}
                />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowRedeemDialog(null)}>Cancel</Button>
            <Button onClick={() => redeemMutation.mutate()} disabled={redeemMutation.isPending || !redeemAmountRupees}>
              {redeemMutation.isPending ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : null}
              Redeem
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ─── HISTORY DIALOG ─── */}
      <Dialog open={!!showHistoryDialog} onOpenChange={() => setShowHistoryDialog(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <History className="w-4 h-4" /> Redemption History — {showHistoryDialog?.code}
            </DialogTitle>
          </DialogHeader>
          <div className="max-h-96 overflow-y-auto">
            {historyQuery.isLoading ? (
              <div className="flex items-center justify-center py-8"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>
            ) : historyQuery.data?.length === 0 ? (
              <p className="text-center text-muted-foreground py-8">No redemptions yet.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>Amount</TableHead>
                    <TableHead>Before</TableHead>
                    <TableHead>After</TableHead>
                    <TableHead>Notes</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(historyQuery.data ?? []).map((r: {
                    id: number;
                    createdAt: string;
                    amountPaise: number;
                    balanceBeforePaise: number;
                    balanceAfterPaise: number;
                    notes: string | null;
                  }) => (
                    <TableRow key={r.id}>
                      <TableCell className="text-sm">{new Date(r.createdAt).toLocaleString(getLocale())}</TableCell>
                      <TableCell className="font-semibold text-green-400">{fmt(r.amountPaise)}</TableCell>
                      <TableCell className="text-muted-foreground">{fmt(r.balanceBeforePaise)}</TableCell>
                      <TableCell>{fmt(r.balanceAfterPaise)}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">{r.notes ?? "—"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* ─── BALANCE LOOKUP DIALOG ─── */}
      <Dialog open={showLookupDialog} onOpenChange={(v) => { setShowLookupDialog(v); if (!v) { setLookupCode(""); setLookupResult(null); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Search className="w-4 h-4" /> Gift Card Balance Lookup
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="flex gap-2">
              <Input
                className="font-mono uppercase"
                placeholder="GC-XXXX-XXXX-XXXX"
                value={lookupCode}
                onChange={(e) => setLookupCode(e.target.value.toUpperCase())}
                onKeyDown={(e) => { if (e.key === "Enter") handleLookup(); }}
              />
              <Button onClick={handleLookup}>Check</Button>
            </div>
            {lookupResult && (
              <div className={`rounded-lg p-4 border ${lookupResult.valid ? "border-green-500/20 bg-green-500/5" : "border-red-500/20 bg-red-500/5"}`}>
                {lookupResult.valid ? (
                  <>
                    <p className="text-green-400 font-semibold mb-2">✓ Valid gift card</p>
                    <div className="space-y-1 text-sm">
                      <p>Balance: <span className="font-bold text-xl">{fmt(lookupResult.card.currentBalancePaise)}</span></p>
                      <p className="text-muted-foreground">Initial: {fmt(lookupResult.card.initialBalancePaise)}</p>
                      {lookupResult.card.recipientName && <p className="text-muted-foreground">Recipient: {lookupResult.card.recipientName}</p>}
                      {lookupResult.card.expiresAt && (
                        <p className="text-muted-foreground">Expires: {new Date(lookupResult.card.expiresAt).toLocaleDateString(getLocale())}</p>
                      )}
                    </div>
                  </>
                ) : (
                  <p className="text-red-400 font-semibold">
                    {lookupResult.reason === "expired" ? "⚠ Gift card has expired" :
                      lookupResult.reason === "cancelled" ? "✗ Gift card is cancelled" :
                        lookupResult.reason === "zero_balance" ? "✗ No remaining balance" :
                          "✗ Invalid gift card"}
                  </p>
                )}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* ─── STORE CREDIT DIALOG ─── */}
      <Dialog open={!!showCreditDialog} onOpenChange={(v) => { if (!v) { setShowCreditDialog(null); setSelectedMember(null); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {showCreditDialog === "adjust" ? "Adjust Store Credit" : "Issue Store Credit"}
            </DialogTitle>
          </DialogHeader>
          {selectedMember && (
            <div className="space-y-4 py-2">
              <div className="bg-muted/50 rounded-lg p-3">
                <p className="font-semibold">{selectedMember.memberFirstName} {selectedMember.memberLastName}</p>
                <p className="text-sm text-muted-foreground">Current balance: <span className="text-foreground font-semibold">{fmt(selectedMember.balancePaise)}</span></p>
              </div>
              <div>
                <Label>Amount (₹) {showCreditDialog === "adjust" && <span className="text-muted-foreground font-normal">(negative to deduct)</span>}</Label>
                <Input
                  type="number"
                  step="0.01"
                  className="mt-1.5"
                  value={creditAmount}
                  onChange={(e) => setCreditAmount(e.target.value)}
                />
              </div>
              <div>
                <Label>Reason</Label>
                <Input className="mt-1.5" placeholder="e.g. Refund for cancelled booking" value={creditReason} onChange={(e) => setCreditReason(e.target.value)} />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => { setShowCreditDialog(null); setSelectedMember(null); }}>Cancel</Button>
            <Button
              onClick={() => {
                if (!selectedMember || !creditAmount || !showCreditDialog) return;
                issueCreditMutation.mutate({
                  memberId: selectedMember.memberId,
                  amount: creditAmount,
                  reason: creditReason,
                  type: showCreditDialog,
                });
              }}
              disabled={issueCreditMutation.isPending || !creditAmount}
            >
              {issueCreditMutation.isPending ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : null}
              {showCreditDialog === "adjust" ? "Apply Adjustment" : "Issue Credit"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
