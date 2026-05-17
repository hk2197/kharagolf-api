import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import {
  Gift, Star, BarChart3, Settings, Plus, Trash2, Edit2, RefreshCw,
  Users, Coins, TrendingUp, Award, ChevronRight, Save, X,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { useToast } from '@/hooks/use-toast';
import { useActiveOrgContext } from '@/context/ActiveOrgContext';

const BASE_URL = import.meta.env.BASE_URL?.replace(/\/$/, '') ?? '';
function API(path: string) { return `${BASE_URL}/api${path}`; }

// ─── Types ────────────────────────────────────────────────────────────────────

type LoyaltyTierValue = 'none' | 'silver' | 'gold' | 'platinum';
type RewardType = 'discount_percent' | 'discount_fixed' | 'free_round' | 'voucher' | 'product' | 'other';

interface LoyaltyProgram {
  id: number;
  organizationId: number;
  isEnabled: boolean;
  pointsName: string;
  baseEarnRate: string;
  categoryRates: Record<string, number>;
  minSpendToEarn: string;
  pointsExpireDays: number | null;
  createdAt: string;
  updatedAt: string;
}

interface LoyaltyTier {
  id: number;
  tier: LoyaltyTierValue;
  label: string;
  minPoints: number;
  multiplier: string;
  perks: string[];
  badgeIcon: string | null;
}

interface LoyaltyReward {
  id: number;
  name: string;
  description: string | null;
  rewardType: RewardType;
  pointsCost: number;
  discountValue: string | null;
  minTier: LoyaltyTierValue;
  isActive: boolean;
  stock: number | null;
  redeemedCount: number;
  validFrom: string | null;
  validUntil: string | null;
}

interface LoyaltyStats {
  totalIssued: number;
  totalRedeemed: number;
  outstanding: number;
  memberCount: number;
  tierBreakdown: { tier: LoyaltyTierValue; memberCount: number }[];
  topRedeemed: { rewardId: number | null; redeemCount: number }[];
}

interface MemberAccount {
  account: {
    id: number;
    userId: number;
    currentTier: LoyaltyTierValue;
    pointsBalance: number;
    lifetimePoints: number;
    rollingYearPoints: number;
  };
  displayName: string | null;
  email: string | null;
  username: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const TIER_COLORS: Record<LoyaltyTierValue, string> = {
  none: 'bg-gray-500/20 text-gray-300 border-gray-500/30',
  silver: 'bg-slate-400/20 text-slate-300 border-slate-400/30',
  gold: 'bg-amber-500/20 text-amber-300 border-amber-500/30',
  platinum: 'bg-purple-500/20 text-purple-300 border-purple-500/30',
};

const TIER_ICONS: Record<LoyaltyTierValue, string> = {
  none: '⬛',
  silver: '🥈',
  gold: '🥇',
  platinum: '💎',
};

const REWARD_TYPE_LABELS: Record<RewardType, string> = {
  discount_percent: 'Discount (%)',
  discount_fixed: 'Discount (Fixed)',
  free_round: 'Free Round',
  voucher: 'Voucher',
  product: 'Product',
  other: 'Other',
};

const SERVICE_CATEGORIES = ['pos', 'fb', 'lesson', 'tee_booking', 'tee_time', 'general'];
const SERVICE_LABELS: Record<string, string> = {
  pos: 'Pro Shop (POS)',
  fb: 'Food & Beverage',
  lesson: 'Lessons',
  tee_booking: 'Tee Bookings',
  tee_time: 'Tee Times',
  general: 'General',
};

// ─── Settings Tab ─────────────────────────────────────────────────────────────

function SettingsTab({ orgId }: { orgId: number }) {
  const { toast } = useToast();
  const qc = useQueryClient();

  const { data: program, isLoading } = useQuery<LoyaltyProgram | null>({
    queryKey: ['loyalty-program', orgId],
    queryFn: async () => {
      const r = await fetch(API(`/organizations/${orgId}/loyalty/program`));
      if (!r.ok) return null;
      return r.json();
    },
  });

  const [form, setForm] = useState<{
    isEnabled: boolean;
    pointsName: string;
    baseEarnRate: string;
    categoryRates: Record<string, string>;
    minSpendToEarn: string;
    pointsExpireDays: string;
  } | null>(null);

  // Initialize form from data
  const currentForm = form ?? {
    isEnabled: program?.isEnabled ?? true,
    pointsName: program?.pointsName ?? 'Points',
    baseEarnRate: program?.baseEarnRate ?? '1',
    categoryRates: Object.fromEntries(
      SERVICE_CATEGORIES.map(c => [c, String(program?.categoryRates?.[c] ?? '')])
    ),
    minSpendToEarn: program?.minSpendToEarn ?? '0',
    pointsExpireDays: program?.pointsExpireDays != null ? String(program.pointsExpireDays) : '',
  };

  const saveMutation = useMutation({
    mutationFn: async () => {
      const catRates: Record<string, number> = {};
      for (const [k, v] of Object.entries(currentForm.categoryRates)) {
        if (v.trim() !== '') catRates[k] = parseFloat(v);
      }
      const r = await fetch(API(`/organizations/${orgId}/loyalty/program`), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          isEnabled: currentForm.isEnabled,
          pointsName: currentForm.pointsName || 'Points',
          baseEarnRate: parseFloat(currentForm.baseEarnRate) || 1,
          categoryRates: catRates,
          minSpendToEarn: parseFloat(currentForm.minSpendToEarn) || 0,
          pointsExpireDays: currentForm.pointsExpireDays.trim() ? parseInt(currentForm.pointsExpireDays) : null,
        }),
      });
      if (!r.ok) throw new Error((await r.json()).error ?? 'Save failed');
      return r.json();
    },
    onSuccess: () => {
      toast({ title: 'Settings saved!' });
      setForm(null);
      qc.invalidateQueries({ queryKey: ['loyalty-program', orgId] });
    },
    onError: (err: Error) => toast({ title: 'Error', description: err.message, variant: 'destructive' }),
  });

  if (isLoading) return <div className="flex justify-center py-12"><RefreshCw className="w-6 h-6 animate-spin text-muted-foreground" /></div>;

  return (
    <div className="space-y-6 max-w-2xl">
      <Card className="bg-card border-white/10">
        <CardHeader><CardTitle className="text-white">Programme Settings</CardTitle></CardHeader>
        <CardContent className="space-y-6">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-white">Enable Loyalty Programme</p>
              <p className="text-xs text-muted-foreground">Members can earn and redeem points when enabled.</p>
            </div>
            <Switch
              checked={currentForm.isEnabled}
              onCheckedChange={v => setForm({ ...currentForm, isEnabled: v })}
            />
          </div>

          <div className="space-y-2">
            <Label className="text-sm text-muted-foreground">Points Name</Label>
            <Input
              value={currentForm.pointsName}
              onChange={e => setForm({ ...currentForm, pointsName: e.target.value })}
              className="bg-background border-white/10 text-white"
              placeholder="e.g. KharaPoints"
            />
          </div>

          <div className="space-y-2">
            <Label className="text-sm text-muted-foreground">Base Earn Rate (points per 1 currency unit)</Label>
            <Input
              type="number"
              min="0"
              step="0.01"
              value={currentForm.baseEarnRate}
              onChange={e => setForm({ ...currentForm, baseEarnRate: e.target.value })}
              className="bg-background border-white/10 text-white"
            />
            <p className="text-xs text-muted-foreground">e.g. 1 = 1 point per ₹1 spent</p>
          </div>

          <div className="space-y-3">
            <Label className="text-sm text-muted-foreground">Category Earn Rates (overrides base rate)</Label>
            <div className="grid grid-cols-2 gap-3">
              {SERVICE_CATEGORIES.map(cat => (
                <div key={cat} className="space-y-1">
                  <Label className="text-xs text-muted-foreground">{SERVICE_LABELS[cat]}</Label>
                  <Input
                    type="number"
                    min="0"
                    step="0.01"
                    value={currentForm.categoryRates[cat] ?? ''}
                    onChange={e => setForm({ ...currentForm, categoryRates: { ...currentForm.categoryRates, [cat]: e.target.value } })}
                    className="bg-background border-white/10 text-white text-sm"
                    placeholder="Use base rate"
                  />
                </div>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <Label className="text-sm text-muted-foreground">Minimum Spend to Earn Points</Label>
            <Input
              type="number"
              min="0"
              value={currentForm.minSpendToEarn}
              onChange={e => setForm({ ...currentForm, minSpendToEarn: e.target.value })}
              className="bg-background border-white/10 text-white"
            />
          </div>

          <div className="space-y-2">
            <Label className="text-sm text-muted-foreground">Points Expiry (days, leave blank for no expiry)</Label>
            <Input
              type="number"
              min="0"
              value={currentForm.pointsExpireDays}
              onChange={e => setForm({ ...currentForm, pointsExpireDays: e.target.value })}
              className="bg-background border-white/10 text-white"
              placeholder="No expiry"
            />
          </div>

          <Button onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending} className="w-full">
            {saveMutation.isPending ? <RefreshCw className="w-4 h-4 animate-spin mr-2" /> : <Save className="w-4 h-4 mr-2" />}
            Save Settings
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Tiers Tab ────────────────────────────────────────────────────────────────

function TiersTab({ orgId }: { orgId: number }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [editTier, setEditTier] = useState<{ tier: LoyaltyTierValue; label: string; minPoints: string; multiplier: string; perks: string; badgeIcon: string } | null>(null);
  const [deletingTier, setDeletingTier] = useState<LoyaltyTierValue | null>(null);

  const { data: tiers = [], isLoading } = useQuery<LoyaltyTier[]>({
    queryKey: ['loyalty-tiers', orgId],
    queryFn: async () => {
      const r = await fetch(API(`/organizations/${orgId}/loyalty/tiers`));
      if (!r.ok) return [];
      return r.json();
    },
  });

  const saveTierMutation = useMutation({
    mutationFn: async (t: typeof editTier) => {
      if (!t) return;
      const r = await fetch(API(`/organizations/${orgId}/loyalty/tiers/${t.tier}`), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          label: t.label,
          minPoints: parseInt(t.minPoints) || 0,
          multiplier: parseFloat(t.multiplier) || 1,
          perks: t.perks.split('\n').map(p => p.trim()).filter(Boolean),
          badgeIcon: t.badgeIcon || null,
        }),
      });
      if (!r.ok) throw new Error((await r.json()).error ?? 'Save failed');
      return r.json();
    },
    onSuccess: () => {
      toast({ title: 'Tier saved!' });
      setEditTier(null);
      qc.invalidateQueries({ queryKey: ['loyalty-tiers', orgId] });
    },
    onError: (err: Error) => toast({ title: 'Error', description: err.message, variant: 'destructive' }),
  });

  const deleteTierMutation = useMutation({
    mutationFn: async (tier: LoyaltyTierValue) => {
      const r = await fetch(API(`/organizations/${orgId}/loyalty/tiers/${tier}`), { method: 'DELETE' });
      if (!r.ok) throw new Error((await r.json()).error ?? 'Delete failed');
    },
    onSuccess: () => {
      toast({ title: 'Tier removed.' });
      setDeletingTier(null);
      qc.invalidateQueries({ queryKey: ['loyalty-tiers', orgId] });
    },
    onError: (err: Error) => toast({ title: 'Error', description: err.message, variant: 'destructive' }),
  });

  const definedTiers = (['silver', 'gold', 'platinum'] as LoyaltyTierValue[]);

  function openEditFor(tier: LoyaltyTierValue) {
    const existing = tiers.find(t => t.tier === tier);
    setEditTier({
      tier,
      label: existing?.label ?? tier.charAt(0).toUpperCase() + tier.slice(1),
      minPoints: existing?.minPoints != null ? String(existing.minPoints) : '',
      multiplier: existing?.multiplier ?? '1',
      perks: (existing?.perks ?? []).join('\n'),
      badgeIcon: existing?.badgeIcon ?? '',
    });
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">Define tier thresholds and benefits. Tier is calculated from rolling 12-month points earned.</p>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {definedTiers.map(tier => {
          const existing = tiers.find(t => t.tier === tier);
          return (
            <Card key={tier} className={`bg-card border-white/10 ${!existing ? 'opacity-60' : ''}`}>
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-xl">{TIER_ICONS[tier]}</span>
                    <CardTitle className="text-white text-base">{existing?.label ?? tier.charAt(0).toUpperCase() + tier.slice(1)}</CardTitle>
                  </div>
                  <Badge className={TIER_COLORS[tier]}>{tier}</Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                {existing ? (
                  <>
                    <div className="flex justify-between text-muted-foreground">
                      <span>Min Points</span>
                      <span className="text-white font-medium">{existing.minPoints.toLocaleString()}</span>
                    </div>
                    <div className="flex justify-between text-muted-foreground">
                      <span>Multiplier</span>
                      <span className="text-white font-medium">{existing.multiplier}×</span>
                    </div>
                    {existing.perks.length > 0 && (
                      <ul className="mt-2 space-y-1">
                        {existing.perks.map((p, i) => (
                          <li key={i} className="text-xs text-muted-foreground flex items-start gap-1">
                            <ChevronRight className="w-3 h-3 text-primary mt-0.5 flex-shrink-0" />
                            {p}
                          </li>
                        ))}
                      </ul>
                    )}
                    <div className="flex gap-2 pt-2">
                      <Button size="sm" variant="outline" className="flex-1 border-white/10" onClick={() => openEditFor(tier)}>
                        <Edit2 className="w-3 h-3 mr-1" />Edit
                      </Button>
                      <Button size="sm" variant="outline" className="border-red-500/30 text-red-400 hover:bg-red-500/10" onClick={() => setDeletingTier(tier)}>
                        <Trash2 className="w-3 h-3" />
                      </Button>
                    </div>
                  </>
                ) : (
                  <div className="text-center py-2">
                    <p className="text-xs text-muted-foreground mb-2">Not configured</p>
                    <Button size="sm" variant="outline" className="border-white/10" onClick={() => openEditFor(tier)}>
                      <Plus className="w-3 h-3 mr-1" />Configure
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Edit Dialog */}
      <Dialog open={!!editTier} onOpenChange={() => setEditTier(null)}>
        <DialogContent className="bg-card border-white/10 text-white max-w-md">
          <DialogHeader>
            <DialogTitle>
              {editTier && <span className="flex items-center gap-2">{TIER_ICONS[editTier.tier]} Edit {editTier.label} Tier</span>}
            </DialogTitle>
          </DialogHeader>
          {editTier && (
            <div className="space-y-4">
              <div className="space-y-1">
                <Label className="text-sm text-muted-foreground">Label</Label>
                <Input
                  value={editTier.label}
                  onChange={e => setEditTier({ ...editTier, label: e.target.value })}
                  className="bg-background border-white/10 text-white"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-sm text-muted-foreground">Minimum Rolling 12-Month Points</Label>
                <Input
                  type="number"
                  min="0"
                  value={editTier.minPoints}
                  onChange={e => setEditTier({ ...editTier, minPoints: e.target.value })}
                  className="bg-background border-white/10 text-white"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-sm text-muted-foreground">Points Multiplier</Label>
                <Input
                  type="number"
                  min="1"
                  step="0.1"
                  value={editTier.multiplier}
                  onChange={e => setEditTier({ ...editTier, multiplier: e.target.value })}
                  className="bg-background border-white/10 text-white"
                />
                <p className="text-xs text-muted-foreground">e.g. 1.5 = 50% bonus points for this tier</p>
              </div>
              <div className="space-y-1">
                <Label className="text-sm text-muted-foreground">Badge Icon (emoji)</Label>
                <Input
                  value={editTier.badgeIcon}
                  onChange={e => setEditTier({ ...editTier, badgeIcon: e.target.value })}
                  className="bg-background border-white/10 text-white"
                  placeholder="🥈"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-sm text-muted-foreground">Perks (one per line)</Label>
                <Textarea
                  value={editTier.perks}
                  onChange={e => setEditTier({ ...editTier, perks: e.target.value })}
                  className="bg-background border-white/10 text-white"
                  placeholder="Priority tee time booking&#10;10% pro shop discount"
                  rows={4}
                />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" className="border-white/10" onClick={() => setEditTier(null)}>Cancel</Button>
            <Button onClick={() => saveTierMutation.mutate(editTier)} disabled={saveTierMutation.isPending}>
              {saveTierMutation.isPending ? <RefreshCw className="w-4 h-4 animate-spin mr-2" /> : <Save className="w-4 h-4 mr-2" />}
              Save Tier
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirm */}
      <Dialog open={!!deletingTier} onOpenChange={() => setDeletingTier(null)}>
        <DialogContent className="bg-card border-white/10 text-white max-w-sm">
          <DialogHeader><DialogTitle>Remove Tier</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground">Remove the {deletingTier} tier definition? Existing member accounts will retain their tier status until recalculated.</p>
          <DialogFooter>
            <Button variant="outline" className="border-white/10" onClick={() => setDeletingTier(null)}>Cancel</Button>
            <Button variant="destructive" onClick={() => deletingTier && deleteTierMutation.mutate(deletingTier)} disabled={deleteTierMutation.isPending}>
              {deleteTierMutation.isPending ? <RefreshCw className="w-4 h-4 animate-spin mr-2" /> : <Trash2 className="w-4 h-4 mr-2" />}
              Remove
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── Rewards Tab ──────────────────────────────────────────────────────────────

function RewardsTab({ orgId }: { orgId: number }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const [editReward, setEditReward] = useState<LoyaltyReward | null>(null);
  const [deleteId, setDeleteId] = useState<number | null>(null);

  const { data: rewards = [], isLoading } = useQuery<LoyaltyReward[]>({
    queryKey: ['loyalty-rewards', orgId, 'admin'],
    queryFn: async () => {
      const r = await fetch(API(`/organizations/${orgId}/loyalty/rewards?admin=true`));
      if (!r.ok) return [];
      return r.json();
    },
  });

  const emptyForm = {
    name: '', description: '', rewardType: 'other' as RewardType, pointsCost: '', discountValue: '',
    minTier: 'none' as LoyaltyTierValue, isActive: true, stock: '', validFrom: '', validUntil: '',
  };
  const [form, setForm] = useState(emptyForm);

  function openCreate() { setForm(emptyForm); setEditReward(null); setShowCreate(true); }
  function openEdit(r: LoyaltyReward) {
    setForm({
      name: r.name, description: r.description ?? '', rewardType: r.rewardType, pointsCost: String(r.pointsCost),
      discountValue: r.discountValue ?? '', minTier: r.minTier, isActive: r.isActive, stock: r.stock != null ? String(r.stock) : '',
      validFrom: r.validFrom ? r.validFrom.slice(0, 10) : '', validUntil: r.validUntil ? r.validUntil.slice(0, 10) : '',
    });
    setEditReward(r);
    setShowCreate(true);
  }

  const saveMutation = useMutation({
    mutationFn: async () => {
      const body = {
        name: form.name,
        description: form.description || null,
        rewardType: form.rewardType,
        pointsCost: parseInt(form.pointsCost) || 0,
        discountValue: form.discountValue ? parseFloat(form.discountValue) : null,
        minTier: form.minTier,
        isActive: form.isActive,
        stock: form.stock.trim() ? parseInt(form.stock) : null,
        validFrom: form.validFrom || null,
        validUntil: form.validUntil || null,
      };
      const url = editReward
        ? API(`/organizations/${orgId}/loyalty/rewards/${editReward.id}`)
        : API(`/organizations/${orgId}/loyalty/rewards`);
      const method = editReward ? 'PATCH' : 'POST';
      const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error((await r.json()).error ?? 'Save failed');
      return r.json();
    },
    onSuccess: () => {
      toast({ title: editReward ? 'Reward updated!' : 'Reward created!' });
      setShowCreate(false);
      qc.invalidateQueries({ queryKey: ['loyalty-rewards', orgId, 'admin'] });
    },
    onError: (err: Error) => toast({ title: 'Error', description: err.message, variant: 'destructive' }),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      const r = await fetch(API(`/organizations/${orgId}/loyalty/rewards/${id}`), { method: 'DELETE' });
      if (!r.ok) throw new Error((await r.json()).error ?? 'Delete failed');
    },
    onSuccess: () => {
      toast({ title: 'Reward deleted.' });
      setDeleteId(null);
      qc.invalidateQueries({ queryKey: ['loyalty-rewards', orgId, 'admin'] });
    },
    onError: (err: Error) => toast({ title: 'Error', description: err.message, variant: 'destructive' }),
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">Define rewards members can redeem with their points.</p>
        <Button onClick={openCreate} size="sm"><Plus className="w-4 h-4 mr-1" />New Reward</Button>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-8"><RefreshCw className="w-5 h-5 animate-spin text-muted-foreground" /></div>
      ) : rewards.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          <Gift className="w-10 h-10 mx-auto mb-3 opacity-30" />
          <p>No rewards defined yet. Create your first reward!</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {rewards.map(reward => (
            <Card key={reward.id} className={`bg-card border-white/10 ${!reward.isActive ? 'opacity-60' : ''}`}>
              <CardContent className="p-4 space-y-2">
                <div className="flex items-start justify-between">
                  <div>
                    <p className="text-sm font-semibold text-white">{reward.name}</p>
                    {reward.description && <p className="text-xs text-muted-foreground mt-0.5">{reward.description}</p>}
                  </div>
                  <Badge className={reward.isActive ? 'bg-green-500/20 text-green-300' : 'bg-gray-500/20 text-gray-400'}>
                    {reward.isActive ? 'Active' : 'Inactive'}
                  </Badge>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Cost</span>
                  <span className="text-amber-400 font-bold">{reward.pointsCost.toLocaleString()} pts</span>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Type</span>
                  <span className="text-white">{REWARD_TYPE_LABELS[reward.rewardType]}</span>
                </div>
                {reward.minTier !== 'none' && (
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">Min Tier</span>
                    <Badge className={TIER_COLORS[reward.minTier]}>{TIER_ICONS[reward.minTier]} {reward.minTier}</Badge>
                  </div>
                )}
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Redeemed</span>
                  <span className="text-white">{reward.redeemedCount}{reward.stock != null ? ` / ${reward.stock}` : ''}</span>
                </div>
                <div className="flex gap-2 pt-1">
                  <Button size="sm" variant="outline" className="flex-1 border-white/10" onClick={() => openEdit(reward)}>
                    <Edit2 className="w-3 h-3 mr-1" />Edit
                  </Button>
                  <Button size="sm" variant="outline" className="border-red-500/30 text-red-400 hover:bg-red-500/10" onClick={() => setDeleteId(reward.id)}>
                    <Trash2 className="w-3 h-3" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Create/Edit Dialog */}
      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent className="bg-card border-white/10 text-white max-w-lg">
          <DialogHeader><DialogTitle>{editReward ? 'Edit Reward' : 'New Reward'}</DialogTitle></DialogHeader>
          <div className="space-y-4 max-h-[65vh] overflow-y-auto pr-1">
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Name *</Label>
              <Input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} className="bg-background border-white/10 text-white" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Description</Label>
              <Textarea value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} className="bg-background border-white/10 text-white" rows={2} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Reward Type</Label>
                <Select value={form.rewardType} onValueChange={v => setForm({ ...form, rewardType: v as RewardType })}>
                  <SelectTrigger className="bg-background border-white/10 text-white"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {Object.entries(REWARD_TYPE_LABELS).map(([k, v]) => (
                      <SelectItem key={k} value={k}>{v}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Points Cost *</Label>
                <Input type="number" min="0" value={form.pointsCost} onChange={e => setForm({ ...form, pointsCost: e.target.value })} className="bg-background border-white/10 text-white" />
              </div>
            </div>
            {['discount_percent', 'discount_fixed'].includes(form.rewardType) && (
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Discount Value {form.rewardType === 'discount_percent' ? '(%)' : '(₹)'}</Label>
                <Input type="number" min="0" value={form.discountValue} onChange={e => setForm({ ...form, discountValue: e.target.value })} className="bg-background border-white/10 text-white" />
              </div>
            )}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Minimum Tier</Label>
                <Select value={form.minTier} onValueChange={v => setForm({ ...form, minTier: v as LoyaltyTierValue })}>
                  <SelectTrigger className="bg-background border-white/10 text-white"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">All Members</SelectItem>
                    <SelectItem value="silver">{TIER_ICONS.silver} Silver+</SelectItem>
                    <SelectItem value="gold">{TIER_ICONS.gold} Gold+</SelectItem>
                    <SelectItem value="platinum">{TIER_ICONS.platinum} Platinum</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Stock (blank = unlimited)</Label>
                <Input type="number" min="0" value={form.stock} onChange={e => setForm({ ...form, stock: e.target.value })} className="bg-background border-white/10 text-white" placeholder="Unlimited" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Valid From</Label>
                <Input type="date" value={form.validFrom} onChange={e => setForm({ ...form, validFrom: e.target.value })} className="bg-background border-white/10 text-white" />
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Valid Until</Label>
                <Input type="date" value={form.validUntil} onChange={e => setForm({ ...form, validUntil: e.target.value })} className="bg-background border-white/10 text-white" />
              </div>
            </div>
            <div className="flex items-center justify-between">
              <Label className="text-sm text-white">Active</Label>
              <Switch checked={form.isActive} onCheckedChange={v => setForm({ ...form, isActive: v })} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" className="border-white/10" onClick={() => setShowCreate(false)}>Cancel</Button>
            <Button onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending || !form.name || !form.pointsCost}>
              {saveMutation.isPending ? <RefreshCw className="w-4 h-4 animate-spin mr-2" /> : <Save className="w-4 h-4 mr-2" />}
              {editReward ? 'Update' : 'Create'} Reward
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirm */}
      <Dialog open={deleteId != null} onOpenChange={() => setDeleteId(null)}>
        <DialogContent className="bg-card border-white/10 text-white max-w-sm">
          <DialogHeader><DialogTitle>Delete Reward</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground">Delete this reward? Existing redemptions are not affected.</p>
          <DialogFooter>
            <Button variant="outline" className="border-white/10" onClick={() => setDeleteId(null)}>Cancel</Button>
            <Button variant="destructive" onClick={() => deleteId && deleteMutation.mutate(deleteId)} disabled={deleteMutation.isPending}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── Admin Dashboard Tab ──────────────────────────────────────────────────────

function DashboardTab({ orgId }: { orgId: number }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [adjustUser, setAdjustUser] = useState<{ id: number; name: string; balance: number } | null>(null);
  const [adjustForm, setAdjustForm] = useState({ points: '', description: '' });

  const { data: stats, isLoading: statsLoading } = useQuery<LoyaltyStats>({
    queryKey: ['loyalty-stats', orgId],
    queryFn: async () => {
      const r = await fetch(API(`/organizations/${orgId}/loyalty/admin/stats`));
      if (!r.ok) throw new Error('Failed to load stats');
      return r.json();
    },
  });

  const { data: membersData, isLoading: membersLoading } = useQuery<{ members: MemberAccount[]; total: number }>({
    queryKey: ['loyalty-members', orgId],
    queryFn: async () => {
      const r = await fetch(API(`/organizations/${orgId}/loyalty/admin/members?limit=50`));
      if (!r.ok) return { members: [], total: 0 };
      return r.json();
    },
  });

  const adjustMutation = useMutation({
    mutationFn: async () => {
      if (!adjustUser) return;
      const r = await fetch(API(`/organizations/${orgId}/loyalty/admin/adjust`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: adjustUser.id,
          points: parseInt(adjustForm.points) || 0,
          description: adjustForm.description || undefined,
        }),
      });
      if (!r.ok) throw new Error((await r.json()).error ?? 'Adjustment failed');
      return r.json();
    },
    onSuccess: () => {
      toast({ title: 'Points adjusted!' });
      setAdjustUser(null);
      setAdjustForm({ points: '', description: '' });
      qc.invalidateQueries({ queryKey: ['loyalty-members', orgId] });
      qc.invalidateQueries({ queryKey: ['loyalty-stats', orgId] });
    },
    onError: (err: Error) => toast({ title: 'Error', description: err.message, variant: 'destructive' }),
  });

  return (
    <div className="space-y-6">
      {/* Stats Cards */}
      {statsLoading ? (
        <div className="flex justify-center py-8"><RefreshCw className="w-5 h-5 animate-spin text-muted-foreground" /></div>
      ) : stats && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[
            { label: 'Points Issued', value: stats.totalIssued.toLocaleString(), icon: Coins, color: 'text-amber-400' },
            { label: 'Points Redeemed', value: stats.totalRedeemed.toLocaleString(), icon: Gift, color: 'text-green-400' },
            { label: 'Outstanding Liability', value: stats.outstanding.toLocaleString(), icon: TrendingUp, color: 'text-red-400' },
            { label: 'Active Members', value: stats.memberCount.toLocaleString(), icon: Users, color: 'text-blue-400' },
          ].map(({ label, value, icon: Icon, color }) => (
            <Card key={label} className="bg-card border-white/10">
              <CardContent className="p-4 flex items-center gap-3">
                <Icon className={`w-8 h-8 ${color} flex-shrink-0`} />
                <div>
                  <p className="text-xs text-muted-foreground">{label}</p>
                  <p className="text-xl font-bold text-white">{value}</p>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Tier Breakdown */}
      {stats && stats.tierBreakdown.length > 0 && (
        <Card className="bg-card border-white/10">
          <CardHeader><CardTitle className="text-white text-sm">Member Tier Distribution</CardTitle></CardHeader>
          <CardContent className="flex flex-wrap gap-3">
            {stats.tierBreakdown.map(({ tier, memberCount: mc }) => (
              <div key={tier} className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border ${TIER_COLORS[tier as LoyaltyTierValue]}`}>
                <span>{TIER_ICONS[tier as LoyaltyTierValue]}</span>
                <span className="text-sm capitalize">{tier}</span>
                <Badge variant="outline" className="text-xs">{mc}</Badge>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Member Table */}
      <Card className="bg-card border-white/10">
        <CardHeader><CardTitle className="text-white text-sm">Member Accounts</CardTitle></CardHeader>
        <CardContent>
          {membersLoading ? (
            <div className="flex justify-center py-4"><RefreshCw className="w-5 h-5 animate-spin text-muted-foreground" /></div>
          ) : !membersData?.members.length ? (
            <p className="text-muted-foreground text-sm text-center py-4">No loyalty accounts yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-white/5 text-muted-foreground">
                    <th className="text-left py-2 px-2">Member</th>
                    <th className="text-left py-2 px-2">Tier</th>
                    <th className="text-right py-2 px-2">Balance</th>
                    <th className="text-right py-2 px-2">Lifetime</th>
                    <th className="text-right py-2 px-2">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {membersData.members.map(({ account, displayName, email, username }) => (
                    <tr key={account.id} className="border-b border-white/5 hover:bg-white/5">
                      <td className="py-2 px-2">
                        <p className="text-white font-medium">{displayName ?? username}</p>
                        {email && <p className="text-xs text-muted-foreground">{email}</p>}
                      </td>
                      <td className="py-2 px-2">
                        <Badge className={TIER_COLORS[account.currentTier]}>
                          {TIER_ICONS[account.currentTier]} {account.currentTier}
                        </Badge>
                      </td>
                      <td className="py-2 px-2 text-right text-amber-400 font-bold">{account.pointsBalance.toLocaleString()}</td>
                      <td className="py-2 px-2 text-right text-muted-foreground">{account.lifetimePoints.toLocaleString()}</td>
                      <td className="py-2 px-2 text-right">
                        <Button
                          size="sm" variant="outline" className="border-white/10 text-xs h-7"
                          onClick={() => {
                            setAdjustUser({ id: account.userId, name: displayName ?? username, balance: account.pointsBalance });
                            setAdjustForm({ points: '', description: '' });
                          }}
                        >
                          Adjust
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Adjust Dialog */}
      <Dialog open={!!adjustUser} onOpenChange={() => setAdjustUser(null)}>
        <DialogContent className="bg-card border-white/10 text-white max-w-sm">
          <DialogHeader><DialogTitle>Adjust Points — {adjustUser?.name}</DialogTitle></DialogHeader>
          <p className="text-xs text-muted-foreground">Current balance: <span className="text-amber-400">{adjustUser?.balance.toLocaleString()}</span></p>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Points Adjustment (use negative to deduct)</Label>
              <Input type="number" value={adjustForm.points} onChange={e => setAdjustForm({ ...adjustForm, points: e.target.value })} className="bg-background border-white/10 text-white" placeholder="+500 or -100" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Reason (optional)</Label>
              <Input value={adjustForm.description} onChange={e => setAdjustForm({ ...adjustForm, description: e.target.value })} className="bg-background border-white/10 text-white" placeholder="Goodwill adjustment" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" className="border-white/10" onClick={() => setAdjustUser(null)}>Cancel</Button>
            <Button onClick={() => adjustMutation.mutate()} disabled={adjustMutation.isPending || !adjustForm.points}>
              {adjustMutation.isPending ? <RefreshCw className="w-4 h-4 animate-spin mr-2" /> : <Save className="w-4 h-4 mr-2" />}
              Apply
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function LoyaltyPage() {
  const { activeOrgId } = useActiveOrgContext();

  if (!activeOrgId) {
    return (
      <div className="p-6 text-center text-muted-foreground">
        <Award className="w-10 h-10 mx-auto mb-3 opacity-30" />
        <p>Please select an organisation to manage loyalty.</p>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6 max-w-6xl">
      <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }}>
        <div className="flex items-center gap-3 mb-1">
          <Award className="w-6 h-6 text-amber-400" />
          <h1 className="text-2xl font-bold text-white">Loyalty & Rewards</h1>
        </div>
        <p className="text-muted-foreground text-sm">Manage your points-based loyalty programme, tiers, and rewards catalogue.</p>
      </motion.div>

      <Tabs defaultValue="dashboard">
        <TabsList className="bg-card border border-white/10">
          <TabsTrigger value="dashboard" className="data-[state=active]:bg-white/10">
            <BarChart3 className="w-4 h-4 mr-1.5" />Dashboard
          </TabsTrigger>
          <TabsTrigger value="rewards" className="data-[state=active]:bg-white/10">
            <Gift className="w-4 h-4 mr-1.5" />Rewards
          </TabsTrigger>
          <TabsTrigger value="tiers" className="data-[state=active]:bg-white/10">
            <Star className="w-4 h-4 mr-1.5" />Tiers
          </TabsTrigger>
          <TabsTrigger value="settings" className="data-[state=active]:bg-white/10">
            <Settings className="w-4 h-4 mr-1.5" />Settings
          </TabsTrigger>
        </TabsList>

        <TabsContent value="dashboard" className="mt-6">
          <DashboardTab orgId={activeOrgId} />
        </TabsContent>
        <TabsContent value="rewards" className="mt-6">
          <RewardsTab orgId={activeOrgId} />
        </TabsContent>
        <TabsContent value="tiers" className="mt-6">
          <TiersTab orgId={activeOrgId} />
        </TabsContent>
        <TabsContent value="settings" className="mt-6">
          <SettingsTab orgId={activeOrgId} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
