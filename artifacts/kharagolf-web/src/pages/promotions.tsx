import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Tag, Plus, Edit2, Trash2, BarChart3, Link2, Gift, Zap,
  Users, Settings, RefreshCw, X, Save, Copy, ChevronDown, ChevronUp,
  Percent, DollarSign, Calendar, ShoppingBag, TrendingUp,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';
import { useActiveOrgContext } from '@/context/ActiveOrgContext';

const BASE_URL = import.meta.env.BASE_URL?.replace(/\/$/, '') ?? '';
function API(path: string) { return `${BASE_URL}/api${path}`; }

// ─── Types ────────────────────────────────────────────────────────────────────

interface Promotion {
  id: number;
  code: string;
  description: string | null;
  discountType: 'percentage' | 'fixed';
  discountValue: string;
  minOrderValue: string;
  usageLimit: number | null;
  usedCount: number;
  scope: 'all' | 'category' | 'product';
  scopeValues: string[] | null;
  validFrom: string | null;
  validTo: string | null;
  isActive: boolean;
  singleUsePerUser: boolean;
  createdAt: string;
}

interface AffiliateCode {
  id: number;
  code: string;
  description: string | null;
  ownerName: string | null;
  ownerEmail: string | null;
  commissionType: 'percentage' | 'fixed';
  commissionValue: string;
  buyerDiscountType: 'percentage' | 'fixed';
  buyerDiscountValue: string;
  totalOrders: number;
  totalDiscountGiven: string;
  totalCommissionEarned: string;
  isActive: boolean;
  validFrom: string | null;
  validTo: string | null;
}

interface BundleDeal {
  id: number;
  name: string;
  description: string | null;
  dealType: 'multi_product' | 'category_quantity';
  requiredProductIds: number[] | null;
  targetCategory: string | null;
  minQuantity: number;
  discountType: 'percentage' | 'fixed';
  discountValue: string;
  cheapestItemFree: boolean;
  isActive: boolean;
  validFrom: string | null;
  validTo: string | null;
}

interface FlashSaleProduct {
  id: number;
  name: string;
  markupPrice: string;
  salePrice: string | null;
  saleStart: string | null;
  saleEnd: string | null;
  category: string;
  isActive: boolean;
}

interface MembershipTierDiscount {
  id: number;
  name: string;
  shopDiscountPct: string;
  shopCategoryDiscounts: Record<string, number> | null;
  isActive: boolean;
}

interface StackingPolicy {
  discountStackingPolicy: string;
  stackingPriority: string[] | null;
  stackingMaxLayers: number | null;
  loyaltyPointsPerCurrencyUnit: number;
  loyaltyMaxRedemptionPct: number;
}

interface CategoryFlashSale {
  id: number;
  organizationId: number;
  category: string;
  label: string | null;
  discountPct: string;
  saleStart: string;
  saleEnd: string;
  isActive: boolean;
}

interface PromoStats {
  activePromotions: Promotion[];
  totalRedemptions: number;
  totalDiscountGiven: number;
  affiliates: AffiliateCode[];
  revenueImpact?: {
    grossRevenue: number;
    netRevenue: number;
    totalDiscountFromOrders: number;
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt(amount: string | number, currency = '₹') {
  const n = typeof amount === 'string' ? parseFloat(amount) : amount;
  return `${currency}${n.toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

function fmtDate(d: string | null) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

function isExpired(validTo: string | null) {
  if (!validTo) return false;
  return new Date(validTo) < new Date();
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function PromotionsPage() {
  const { activeOrg } = useActiveOrgContext();
  const orgId = activeOrg?.id;
  const { toast } = useToast();
  const qc = useQueryClient();

  const [activeTab, setActiveTab] = useState('overview');
  const [promoDialog, setPromoDialog] = useState(false);
  const [editingPromo, setEditingPromo] = useState<Promotion | null>(null);
  const [affiliateDialog, setAffiliateDialog] = useState(false);
  const [editingAffiliate, setEditingAffiliate] = useState<AffiliateCode | null>(null);
  const [bundleDialog, setBundleDialog] = useState(false);
  const [editingBundle, setEditingBundle] = useState<BundleDeal | null>(null);
  const [flashDialog, setFlashDialog] = useState<FlashSaleProduct | null>(null);
  const [categoryFlashDialog, setCategoryFlashDialog] = useState<CategoryFlashSale | null | 'new'>(null);
  const [stackingDialog, setStackingDialog] = useState(false);
  const [tierDialog, setTierDialog] = useState<MembershipTierDiscount | null>(null);
  const [tierPricingProduct, setTierPricingProduct] = useState<{ id: number; name: string; markupPrice: string; tierPricing: Record<string, number> | null } | null>(null);
  const [tierPricingForm, setTierPricingForm] = useState<Record<string, string>>({});

  // ─── Queries ─────────────────────────────────────────────────────────────────

  const { data: stats, isLoading: statsLoading } = useQuery<PromoStats>({
    queryKey: ['promo-stats', orgId],
    queryFn: () => fetch(API(`/organizations/${orgId}/shop/promotions/stats`), { credentials: 'include' }).then(r => r.json()),
    enabled: !!orgId,
  });

  const { data: promotions = [], isLoading: promosLoading } = useQuery<Promotion[]>({
    queryKey: ['promotions', orgId],
    queryFn: () => fetch(API(`/organizations/${orgId}/shop/promotions`), { credentials: 'include' }).then(r => r.json()),
    enabled: !!orgId,
  });

  const { data: affiliates = [] } = useQuery<AffiliateCode[]>({
    queryKey: ['affiliates', orgId],
    queryFn: () => fetch(API(`/organizations/${orgId}/shop/promotions/affiliates`), { credentials: 'include' }).then(r => r.json()),
    enabled: !!orgId,
  });

  const { data: bundles = [] } = useQuery<BundleDeal[]>({
    queryKey: ['bundles', orgId],
    queryFn: () => fetch(API(`/organizations/${orgId}/shop/promotions/bundles`), { credentials: 'include' }).then(r => r.json()),
    enabled: !!orgId,
  });

  const { data: flashSales = [] } = useQuery<FlashSaleProduct[]>({
    queryKey: ['flash-sales', orgId],
    queryFn: () => fetch(API(`/organizations/${orgId}/shop/promotions/flash-sales`), { credentials: 'include' }).then(r => r.json()),
    enabled: !!orgId,
  });

  const { data: categoryFlashSales = [] } = useQuery<CategoryFlashSale[]>({
    queryKey: ['category-flash-sales', orgId],
    queryFn: () => fetch(API(`/organizations/${orgId}/shop/promotions/category-flash-sales`), { credentials: 'include' }).then(r => r.json()),
    enabled: !!orgId,
  });

  const { data: tierDiscounts = [] } = useQuery<MembershipTierDiscount[]>({
    queryKey: ['tier-discounts', orgId],
    queryFn: () => fetch(API(`/organizations/${orgId}/shop/promotions/tier-discounts`), { credentials: 'include' }).then(r => r.json()),
    enabled: !!orgId,
  });

  const { data: shopProducts = [] } = useQuery<Array<{ id: number; name: string; markupPrice: string; isActive: boolean; tierPricing: Record<string, number> | null }>>({
    queryKey: ['shop-products-admin', orgId],
    queryFn: () => fetch(API(`/organizations/${orgId}/shop/products`), { credentials: 'include' }).then(r => r.json()),
    enabled: !!orgId && activeTab === 'tiers',
  });

  const { data: stackingPolicy } = useQuery<StackingPolicy>({
    queryKey: ['stacking-policy', orgId],
    queryFn: () => fetch(API(`/organizations/${orgId}/shop/promotions/stacking-policy`), { credentials: 'include' }).then(r => r.json()),
    enabled: !!orgId,
  });

  // ─── Mutations ────────────────────────────────────────────────────────────────

  const savePromo = useMutation({
    mutationFn: async (data: Record<string, unknown>) => {
      const method = editingPromo ? 'PUT' : 'POST';
      const url = editingPromo
        ? API(`/organizations/${orgId}/shop/promotions/${editingPromo.id}`)
        : API(`/organizations/${orgId}/shop/promotions`);
      const r = await fetch(url, { method, credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
      if (!r.ok) throw new Error((await r.json()).error);
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['promotions', orgId] });
      qc.invalidateQueries({ queryKey: ['promo-stats', orgId] });
      toast({ title: editingPromo ? 'Promotion updated' : 'Promotion created' });
      setPromoDialog(false);
      setEditingPromo(null);
    },
    onError: (e: Error) => toast({ title: 'Error', description: e.message, variant: 'destructive' }),
  });

  const deletePromo = useMutation({
    mutationFn: (id: number) => fetch(API(`/organizations/${orgId}/shop/promotions/${id}`), { method: 'DELETE', credentials: 'include' }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['promotions', orgId] }); toast({ title: 'Promotion deactivated' }); },
  });

  const saveAffiliate = useMutation({
    mutationFn: async (data: Record<string, unknown>) => {
      const method = editingAffiliate ? 'PUT' : 'POST';
      const url = editingAffiliate
        ? API(`/organizations/${orgId}/shop/promotions/affiliates/${editingAffiliate.id}`)
        : API(`/organizations/${orgId}/shop/promotions/affiliates`);
      const r = await fetch(url, { method, credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
      if (!r.ok) throw new Error((await r.json()).error);
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['affiliates', orgId] });
      toast({ title: editingAffiliate ? 'Affiliate updated' : 'Affiliate created' });
      setAffiliateDialog(false);
      setEditingAffiliate(null);
    },
    onError: (e: Error) => toast({ title: 'Error', description: e.message, variant: 'destructive' }),
  });

  const deleteAffiliate = useMutation({
    mutationFn: (id: number) => fetch(API(`/organizations/${orgId}/shop/promotions/affiliates/${id}`), { method: 'DELETE', credentials: 'include' }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['affiliates', orgId] }); toast({ title: 'Affiliate deactivated' }); },
  });

  const saveBundle = useMutation({
    mutationFn: async (data: Record<string, unknown>) => {
      const method = editingBundle ? 'PUT' : 'POST';
      const url = editingBundle
        ? API(`/organizations/${orgId}/shop/promotions/bundles/${editingBundle.id}`)
        : API(`/organizations/${orgId}/shop/promotions/bundles`);
      const r = await fetch(url, { method, credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
      if (!r.ok) throw new Error((await r.json()).error);
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['bundles', orgId] });
      toast({ title: editingBundle ? 'Bundle updated' : 'Bundle created' });
      setBundleDialog(false);
      setEditingBundle(null);
    },
    onError: (e: Error) => toast({ title: 'Error', description: e.message, variant: 'destructive' }),
  });

  const saveFlashSale = useMutation({
    mutationFn: async (data: { salePrice: string; saleStart: string; saleEnd: string }) => {
      if (!flashDialog) return;
      const r = await fetch(API(`/organizations/${orgId}/shop/promotions/flash-sales/${flashDialog.id}`), {
        method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
      });
      if (!r.ok) throw new Error((await r.json()).error);
      return r.json();
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['flash-sales', orgId] }); toast({ title: 'Flash sale updated' }); setFlashDialog(null); },
    onError: (e: Error) => toast({ title: 'Error', description: e.message, variant: 'destructive' }),
  });

  const saveCategoryFlashSale = useMutation({
    mutationFn: async (data: Record<string, unknown>) => {
      const isEdit = categoryFlashDialog && categoryFlashDialog !== 'new';
      const url = isEdit
        ? API(`/organizations/${orgId}/shop/promotions/category-flash-sales/${(categoryFlashDialog as CategoryFlashSale).id}`)
        : API(`/organizations/${orgId}/shop/promotions/category-flash-sales`);
      const r = await fetch(url, {
        method: isEdit ? 'PUT' : 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (!r.ok) throw new Error((await r.json()).error);
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['category-flash-sales', orgId] });
      toast({ title: 'Category flash sale saved' });
      setCategoryFlashDialog(null);
    },
    onError: (e: Error) => toast({ title: 'Error', description: e.message, variant: 'destructive' }),
  });

  const deleteCategoryFlashSale = useMutation({
    mutationFn: (id: number) => fetch(API(`/organizations/${orgId}/shop/promotions/category-flash-sales/${id}`), { method: 'DELETE', credentials: 'include' }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['category-flash-sales', orgId] }); toast({ title: 'Category flash sale deleted' }); },
  });

  const saveStackingPolicy = useMutation({
    mutationFn: (data: Record<string, unknown>) =>
      fetch(API(`/organizations/${orgId}/shop/promotions/stacking-policy`), {
        method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
      }).then(r => r.json()),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['stacking-policy', orgId] }); toast({ title: 'Stacking policy saved' }); setStackingDialog(false); },
    onError: (e: Error) => toast({ title: 'Error', description: String(e.message), variant: 'destructive' }),
  });

  const saveTierDiscount = useMutation({
    mutationFn: async (data: Record<string, unknown>) => {
      if (!tierDialog) return;
      const r = await fetch(API(`/organizations/${orgId}/shop/promotions/tier-discounts/${tierDialog.id}`), {
        method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
      });
      if (!r.ok) throw new Error((await r.json()).error);
      return r.json();
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['tier-discounts', orgId] }); toast({ title: 'Tier discount saved' }); setTierDialog(null); },
    onError: (e: Error) => toast({ title: 'Error', description: e.message, variant: 'destructive' }),
  });

  const saveTierPricing = useMutation({
    mutationFn: async () => {
      if (!tierPricingProduct) return;
      const tierPricing: Record<string, number> = {};
      for (const [tid, val] of Object.entries(tierPricingForm)) {
        const n = parseFloat(val);
        if (!isNaN(n) && n >= 0) tierPricing[tid] = n;
      }
      const r = await fetch(API(`/organizations/${orgId}/shop/products/${tierPricingProduct.id}/tier-pricing`), {
        method: 'PATCH', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tierPricing }),
      });
      if (!r.ok) throw new Error((await r.json()).error);
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['shop-products-admin', orgId] });
      toast({ title: 'Tier pricing saved' });
      setTierPricingProduct(null);
    },
    onError: (e: Error) => toast({ title: 'Error', description: e.message, variant: 'destructive' }),
  });

  if (!orgId) return <div className="p-8 text-muted-foreground">No organization selected.</div>;

  const policyLabels: Record<string, string> = {
    none: 'No Stacking (highest only)',
    promo_member: 'Promo + Member (default)',
    all: 'All Discounts Stack',
    custom: 'Custom Priority Order',
  };

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><Tag className="h-6 w-6 text-emerald-600" /> Promotions & Discounts</h1>
          <p className="text-sm text-muted-foreground mt-1">Manage promo codes, affiliates, bundles, flash sales, and discount stacking rules</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => { qc.invalidateQueries({ queryKey: ['promotions', orgId] }); qc.invalidateQueries({ queryKey: ['promo-stats', orgId] }); }}>
          <RefreshCw className="h-4 w-4 mr-1" /> Refresh
        </Button>
      </div>

      {/* Stats Overview */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-4">
            <div className="text-sm text-muted-foreground">Active Promos</div>
            <div className="text-2xl font-bold text-emerald-600">{stats?.activePromotions?.length ?? 0}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <div className="text-sm text-muted-foreground">Total Redemptions</div>
            <div className="text-2xl font-bold">{stats?.totalRedemptions ?? 0}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <div className="text-sm text-muted-foreground">Total Discount Given</div>
            <div className="text-2xl font-bold text-orange-600">{fmt(stats?.totalDiscountGiven ?? 0)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <div className="text-sm text-muted-foreground">Active Affiliates</div>
            <div className="text-2xl font-bold">{affiliates.filter(a => a.isActive).length}</div>
          </CardContent>
        </Card>
      </div>

      {/* Revenue Impact */}
      {stats?.revenueImpact && (
        <div className="grid grid-cols-3 gap-4">
          <Card>
            <CardContent className="pt-4">
              <div className="text-sm text-muted-foreground">Gross Revenue (list price)</div>
              <div className="text-xl font-bold">{fmt(stats.revenueImpact.grossRevenue)}</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4">
              <div className="text-sm text-muted-foreground">Net Revenue (after discounts)</div>
              <div className="text-xl font-bold text-emerald-600">{fmt(stats.revenueImpact.netRevenue)}</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4">
              <div className="text-sm text-muted-foreground">Revenue Impact (discounts)</div>
              <div className="text-xl font-bold text-orange-600">−{fmt(stats.revenueImpact.totalDiscountFromOrders)}</div>
            </CardContent>
          </Card>
        </div>
      )}

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="flex-wrap">
          <TabsTrigger value="overview"><BarChart3 className="h-4 w-4 mr-1" />Overview</TabsTrigger>
          <TabsTrigger value="promos"><Tag className="h-4 w-4 mr-1" />Promo Codes</TabsTrigger>
          <TabsTrigger value="affiliates"><Link2 className="h-4 w-4 mr-1" />Affiliates</TabsTrigger>
          <TabsTrigger value="bundles"><Gift className="h-4 w-4 mr-1" />Bundles</TabsTrigger>
          <TabsTrigger value="flash"><Zap className="h-4 w-4 mr-1" />Flash Sales</TabsTrigger>
          <TabsTrigger value="tiers"><Users className="h-4 w-4 mr-1" />Member Tiers</TabsTrigger>
          <TabsTrigger value="stacking"><Settings className="h-4 w-4 mr-1" />Stacking Policy</TabsTrigger>
        </TabsList>

        {/* ─── OVERVIEW ─── */}
        <TabsContent value="overview" className="space-y-4">
          <Card>
            <CardHeader><CardTitle className="text-base">Active Promotions</CardTitle></CardHeader>
            <CardContent>
              {statsLoading ? (
                <div className="text-sm text-muted-foreground">Loading…</div>
              ) : (stats?.activePromotions ?? []).length === 0 ? (
                <div className="text-sm text-muted-foreground text-center py-4">No active promotions. Create one in the Promo Codes tab.</div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Code</TableHead>
                      <TableHead>Discount</TableHead>
                      <TableHead>Uses</TableHead>
                      <TableHead>Expires</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(stats?.activePromotions ?? []).map(p => (
                      <TableRow key={p.id}>
                        <TableCell><span className="font-mono font-bold">{p.code}</span></TableCell>
                        <TableCell>{p.discountType === 'percentage' ? `${p.discountValue}%` : fmt(p.discountValue)} off</TableCell>
                        <TableCell>{p.usedCount}{p.usageLimit ? ` / ${p.usageLimit}` : ''}</TableCell>
                        <TableCell className={isExpired(p.validTo) ? 'text-red-500' : ''}>{fmtDate(p.validTo)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle className="text-base">Affiliate Performance</CardTitle></CardHeader>
            <CardContent>
              {affiliates.length === 0 ? (
                <div className="text-sm text-muted-foreground text-center py-4">No affiliates yet.</div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Code</TableHead>
                      <TableHead>Owner</TableHead>
                      <TableHead>Orders</TableHead>
                      <TableHead>Discount Given</TableHead>
                      <TableHead>Commission Earned</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {affiliates.map(a => (
                      <TableRow key={a.id}>
                        <TableCell><span className="font-mono font-bold">{a.code}</span></TableCell>
                        <TableCell>{a.ownerName ?? '—'}</TableCell>
                        <TableCell>{a.totalOrders}</TableCell>
                        <TableCell className="text-orange-600">{fmt(a.totalDiscountGiven)}</TableCell>
                        <TableCell className="text-emerald-600">{fmt(a.totalCommissionEarned)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ─── PROMO CODES ─── */}
        <TabsContent value="promos" className="space-y-4">
          <div className="flex justify-end">
            <Button onClick={() => { setEditingPromo(null); setPromoDialog(true); }}><Plus className="h-4 w-4 mr-1" /> New Promo Code</Button>
          </div>
          {promosLoading ? (
            <div className="text-sm text-muted-foreground">Loading…</div>
          ) : promotions.length === 0 ? (
            <div className="text-center text-muted-foreground py-12">No promo codes yet.</div>
          ) : (
            <div className="space-y-3">
              {promotions.map(p => (
                <Card key={p.id} className={!p.isActive || isExpired(p.validTo) ? 'opacity-60' : ''}>
                  <CardContent className="flex flex-col md:flex-row md:items-center gap-3 pt-4">
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-mono font-bold text-lg">{p.code}</span>
                        <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => { navigator.clipboard.writeText(p.code); toast({ title: 'Copied!' }); }}>
                          <Copy className="h-3 w-3" />
                        </Button>
                        {!p.isActive && <Badge variant="secondary">Inactive</Badge>}
                        {isExpired(p.validTo) && <Badge variant="destructive">Expired</Badge>}
                      </div>
                      <div className="text-sm text-muted-foreground mt-1">{p.description ?? 'No description'}</div>
                      <div className="flex flex-wrap gap-2 mt-2">
                        <Badge variant="outline">{p.discountType === 'percentage' ? `${p.discountValue}% off` : `${fmt(p.discountValue)} off`}</Badge>
                        {parseFloat(p.minOrderValue) > 0 && <Badge variant="outline">Min: {fmt(p.minOrderValue)}</Badge>}
                        <Badge variant="outline">{p.usedCount}{p.usageLimit ? `/${p.usageLimit}` : ''} uses</Badge>
                        <Badge variant="outline">{p.scope === 'all' ? 'All products' : p.scope}</Badge>
                        {p.validFrom && <Badge variant="outline">From {fmtDate(p.validFrom)}</Badge>}
                        {p.validTo && <Badge variant={isExpired(p.validTo) ? 'destructive' : 'outline'}>Until {fmtDate(p.validTo)}</Badge>}
                        {p.singleUsePerUser && <Badge>Single use / member</Badge>}
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <Button variant="outline" size="sm" onClick={() => { setEditingPromo(p); setPromoDialog(true); }}><Edit2 className="h-4 w-4" /></Button>
                      <Button variant="outline" size="sm" onClick={() => deletePromo.mutate(p.id)}><Trash2 className="h-4 w-4" /></Button>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>

        {/* ─── AFFILIATES ─── */}
        <TabsContent value="affiliates" className="space-y-4">
          <div className="flex justify-end">
            <Button onClick={() => { setEditingAffiliate(null); setAffiliateDialog(true); }}><Plus className="h-4 w-4 mr-1" /> New Affiliate Code</Button>
          </div>
          {affiliates.length === 0 ? (
            <div className="text-center text-muted-foreground py-12">No affiliate codes yet.</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Code</TableHead>
                  <TableHead>Owner</TableHead>
                  <TableHead>Buyer Discount</TableHead>
                  <TableHead>Commission</TableHead>
                  <TableHead>Orders</TableHead>
                  <TableHead>Commission Earned</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {affiliates.map(a => (
                  <TableRow key={a.id}>
                    <TableCell><span className="font-mono font-bold">{a.code}</span></TableCell>
                    <TableCell>{a.ownerName ?? '—'}<br /><span className="text-xs text-muted-foreground">{a.ownerEmail ?? ''}</span></TableCell>
                    <TableCell>{a.buyerDiscountType === 'percentage' ? `${a.buyerDiscountValue}%` : fmt(a.buyerDiscountValue)} off</TableCell>
                    <TableCell>{a.commissionType === 'percentage' ? `${a.commissionValue}%` : fmt(a.commissionValue)} / order</TableCell>
                    <TableCell>{a.totalOrders}</TableCell>
                    <TableCell className="text-emerald-600 font-semibold">{fmt(a.totalCommissionEarned)}</TableCell>
                    <TableCell>{a.isActive ? <Badge className="bg-emerald-600">Active</Badge> : <Badge variant="secondary">Inactive</Badge>}</TableCell>
                    <TableCell>
                      <div className="flex gap-1">
                        <Button variant="ghost" size="icon" onClick={() => { setEditingAffiliate(a); setAffiliateDialog(true); }}><Edit2 className="h-4 w-4" /></Button>
                        <Button variant="ghost" size="icon" onClick={() => deleteAffiliate.mutate(a.id)}><Trash2 className="h-4 w-4" /></Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </TabsContent>

        {/* ─── BUNDLES ─── */}
        <TabsContent value="bundles" className="space-y-4">
          <div className="flex justify-end">
            <Button onClick={() => { setEditingBundle(null); setBundleDialog(true); }}><Plus className="h-4 w-4 mr-1" /> New Bundle Deal</Button>
          </div>
          {bundles.length === 0 ? (
            <div className="text-center text-muted-foreground py-12">No bundle deals yet.</div>
          ) : (
            <div className="space-y-3">
              {bundles.map(b => (
                <Card key={b.id} className={!b.isActive ? 'opacity-60' : ''}>
                  <CardContent className="flex items-center justify-between pt-4">
                    <div>
                      <div className="font-semibold">{b.name}</div>
                      <div className="text-sm text-muted-foreground">{b.description ?? ''}</div>
                      <div className="flex gap-2 mt-2 flex-wrap">
                        <Badge variant="outline">{b.dealType === 'multi_product' ? 'Multi-product' : 'Category quantity'}</Badge>
                        {b.cheapestItemFree
                          ? <Badge variant="outline">Cheapest item free</Badge>
                          : <Badge variant="outline">{b.discountType === 'percentage' ? `${b.discountValue}% off` : `${fmt(b.discountValue)} off`}</Badge>}
                        {b.targetCategory && <Badge variant="outline">Category: {b.targetCategory}</Badge>}
                        {b.minQuantity > 1 && <Badge variant="outline">Min qty: {b.minQuantity}</Badge>}
                        {!b.isActive && <Badge variant="secondary">Inactive</Badge>}
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <Button variant="outline" size="sm" onClick={() => { setEditingBundle(b); setBundleDialog(true); }}><Edit2 className="h-4 w-4" /></Button>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>

        {/* ─── FLASH SALES ─── */}
        <TabsContent value="flash" className="space-y-6">
          <p className="text-sm text-muted-foreground">Flash sales show a badge in the shop and automatically apply the sale price. When a sale is active, a push notification is sent to opted-in users.</p>

          {/* Per-product flash sales */}
          <div>
            <h3 className="font-semibold text-sm mb-2">Product Flash Sales</h3>
            {flashSales.length === 0 ? (
              <div className="text-center text-muted-foreground py-8 border rounded">No flash sales configured. You can set a sale price on any product.</div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Product</TableHead>
                    <TableHead>Regular Price</TableHead>
                    <TableHead>Sale Price</TableHead>
                    <TableHead>Start</TableHead>
                    <TableHead>End</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {flashSales.map(p => {
                    const now = new Date();
                    const active = p.saleStart && p.saleEnd && now >= new Date(p.saleStart) && now <= new Date(p.saleEnd);
                    return (
                      <TableRow key={p.id}>
                        <TableCell className="font-medium">{p.name}</TableCell>
                        <TableCell>{fmt(p.markupPrice)}</TableCell>
                        <TableCell className="text-red-600 font-semibold">{p.salePrice ? fmt(p.salePrice) : '—'}</TableCell>
                        <TableCell>{fmtDate(p.saleStart)}</TableCell>
                        <TableCell>{fmtDate(p.saleEnd)}</TableCell>
                        <TableCell>{active ? <Badge className="bg-red-500">LIVE</Badge> : <Badge variant="outline">Scheduled</Badge>}</TableCell>
                        <TableCell>
                          <Button variant="ghost" size="icon" onClick={() => setFlashDialog(p)}><Edit2 className="h-4 w-4" /></Button>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </div>

          {/* Category flash sales */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <h3 className="font-semibold text-sm">Category Flash Sales</h3>
              <Button size="sm" onClick={() => setCategoryFlashDialog('new')}><Plus className="h-3.5 w-3.5 mr-1" />New Category Sale</Button>
            </div>
            <p className="text-xs text-muted-foreground mb-3">Apply a percentage discount to all products in a category during the sale window.</p>
            {categoryFlashSales.length === 0 ? (
              <div className="text-center text-muted-foreground py-8 border rounded">No category flash sales yet.</div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Category</TableHead>
                    <TableHead>Label</TableHead>
                    <TableHead>Discount</TableHead>
                    <TableHead>Start</TableHead>
                    <TableHead>End</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {categoryFlashSales.map(s => {
                    const now = new Date();
                    const active = s.isActive && now >= new Date(s.saleStart) && now <= new Date(s.saleEnd);
                    return (
                      <TableRow key={s.id}>
                        <TableCell className="font-medium capitalize">{s.category}</TableCell>
                        <TableCell className="text-muted-foreground">{s.label ?? '—'}</TableCell>
                        <TableCell className="text-red-600 font-semibold">{parseFloat(s.discountPct)}% off</TableCell>
                        <TableCell>{fmtDate(s.saleStart)}</TableCell>
                        <TableCell>{fmtDate(s.saleEnd)}</TableCell>
                        <TableCell>
                          {!s.isActive ? <Badge variant="outline" className="text-muted-foreground">Inactive</Badge>
                            : active ? <Badge className="bg-red-500">LIVE</Badge>
                            : <Badge variant="outline">Scheduled</Badge>}
                        </TableCell>
                        <TableCell className="flex gap-1">
                          <Button variant="ghost" size="icon" onClick={() => setCategoryFlashDialog(s)}><Edit2 className="h-4 w-4" /></Button>
                          <Button variant="ghost" size="icon" className="text-red-500 hover:text-red-600" onClick={() => deleteCategoryFlashSale.mutate(s.id)}><Trash2 className="h-4 w-4" /></Button>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </div>
        </TabsContent>

        {/* ─── MEMBER TIERS ─── */}
        <TabsContent value="tiers" className="space-y-6">
          <div>
            <p className="text-sm text-muted-foreground mb-3">Configure shop discounts per membership tier. These are automatically applied at checkout for active members.</p>
            {tierDiscounts.length === 0 ? (
              <div className="text-center text-muted-foreground py-12">No membership tiers found. Create tiers in the Members section first.</div>
            ) : (
              <div className="space-y-3">
                {tierDiscounts.map(t => (
                  <Card key={t.id}>
                    <CardContent className="flex items-center justify-between pt-4">
                      <div>
                        <div className="font-semibold">{t.name}</div>
                        <div className="flex gap-2 mt-1 flex-wrap">
                          <Badge variant="outline" className="text-emerald-700">{t.shopDiscountPct}% global shop discount</Badge>
                          {t.shopCategoryDiscounts && Object.entries(t.shopCategoryDiscounts).map(([cat, pct]) => (
                            <Badge key={cat} variant="outline">{cat}: {pct}%</Badge>
                          ))}
                        </div>
                      </div>
                      <Button variant="outline" size="sm" onClick={() => setTierDialog(t)}><Edit2 className="h-4 w-4 mr-1" /> Edit</Button>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </div>

          {/* Per-product tier pricing overrides */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <div>
                <h3 className="font-semibold text-sm">Per-Product Tier Price Overrides</h3>
                <p className="text-xs text-muted-foreground">Set specific prices for products per tier, overriding the tier's global discount.</p>
              </div>
            </div>
            {shopProducts.filter(p => p.isActive).length === 0 ? (
              <div className="text-center text-muted-foreground py-8 text-sm">No active products found.</div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Product</TableHead>
                    <TableHead>List Price</TableHead>
                    <TableHead>Tier Overrides</TableHead>
                    <TableHead className="text-right">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {shopProducts.filter(p => p.isActive).map(p => (
                    <TableRow key={p.id}>
                      <TableCell className="font-medium">{p.name}</TableCell>
                      <TableCell>₹{parseFloat(p.markupPrice).toLocaleString('en-IN')}</TableCell>
                      <TableCell>
                        {p.tierPricing && Object.keys(p.tierPricing).length > 0 ? (
                          <div className="flex gap-1 flex-wrap">
                            {Object.entries(p.tierPricing).map(([tid, price]) => {
                              const tier = tierDiscounts.find(t => String(t.id) === tid);
                              return (
                                <Badge key={tid} variant="secondary" className="text-xs">
                                  {tier?.name ?? `Tier ${tid}`}: ₹{Number(price).toLocaleString('en-IN')}
                                </Badge>
                              );
                            })}
                          </div>
                        ) : <span className="text-xs text-muted-foreground">Using tier % discount</span>}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button variant="ghost" size="sm" onClick={() => {
                          setTierPricingProduct({ id: p.id, name: p.name, markupPrice: p.markupPrice, tierPricing: p.tierPricing });
                          const form: Record<string, string> = {};
                          tierDiscounts.forEach(t => { form[String(t.id)] = String(p.tierPricing?.[String(t.id)] ?? ''); });
                          setTierPricingForm(form);
                        }}><Edit2 className="h-3 w-3 mr-1" />Set Prices</Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>
        </TabsContent>

        {/* ─── STACKING POLICY ─── */}
        <TabsContent value="stacking" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center justify-between">
                Current Stacking Policy
                <Button size="sm" onClick={() => setStackingDialog(true)}><Edit2 className="h-4 w-4 mr-1" /> Edit</Button>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center gap-3 p-3 bg-muted/50 rounded-lg">
                <Settings className="h-5 w-5 text-muted-foreground" />
                <div>
                  <div className="font-semibold">{policyLabels[stackingPolicy?.discountStackingPolicy ?? 'promo_member'] ?? stackingPolicy?.discountStackingPolicy}</div>
                  {stackingPolicy?.discountStackingPolicy === 'custom' && stackingPolicy.stackingPriority && (
                    <div className="text-sm text-muted-foreground">Priority: {stackingPolicy.stackingPriority.join(' → ')}</div>
                  )}
                  {stackingPolicy?.stackingMaxLayers && (
                    <div className="text-sm text-muted-foreground">Max layers: {stackingPolicy.stackingMaxLayers}</div>
                  )}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div className="p-3 bg-muted/30 rounded">
                  <div className="text-muted-foreground">Loyalty Points Rate</div>
                  <div className="font-semibold">{stackingPolicy?.loyaltyPointsPerCurrencyUnit ?? 100} pts = ₹1</div>
                </div>
                <div className="p-3 bg-muted/30 rounded">
                  <div className="text-muted-foreground">Max Loyalty Redemption</div>
                  <div className="font-semibold">{stackingPolicy?.loyaltyMaxRedemptionPct ?? 20}% of order value</div>
                </div>
              </div>
              <div className="space-y-2 text-sm">
                <div className="font-semibold text-muted-foreground">Policy Options:</div>
                {Object.entries(policyLabels).map(([key, label]) => (
                  <div key={key} className={`flex items-center gap-2 p-2 rounded ${stackingPolicy?.discountStackingPolicy === key ? 'bg-emerald-50 border border-emerald-200' : 'text-muted-foreground'}`}>
                    <div className={`w-2 h-2 rounded-full ${stackingPolicy?.discountStackingPolicy === key ? 'bg-emerald-500' : 'bg-gray-300'}`} />
                    <span className="font-medium">{key}:</span> {label}
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* ─── PROMO CODE DIALOG ─── */}
      <PromoDialog
        open={promoDialog}
        onClose={() => { setPromoDialog(false); setEditingPromo(null); }}
        initialData={editingPromo}
        onSave={(data) => savePromo.mutate(data)}
        saving={savePromo.isPending}
      />

      {/* ─── AFFILIATE DIALOG ─── */}
      <AffiliateDialog
        open={affiliateDialog}
        onClose={() => { setAffiliateDialog(false); setEditingAffiliate(null); }}
        initialData={editingAffiliate}
        onSave={(data) => saveAffiliate.mutate(data)}
        saving={saveAffiliate.isPending}
      />

      {/* ─── BUNDLE DIALOG ─── */}
      <BundleDialog
        open={bundleDialog}
        onClose={() => { setBundleDialog(false); setEditingBundle(null); }}
        initialData={editingBundle}
        onSave={(data) => saveBundle.mutate(data)}
        saving={saveBundle.isPending}
      />

      {/* ─── FLASH SALE DIALOG ─── */}
      {flashDialog && (
        <FlashSaleDialog
          product={flashDialog}
          onClose={() => setFlashDialog(null)}
          onSave={(data) => saveFlashSale.mutate(data)}
          saving={saveFlashSale.isPending}
        />
      )}

      {/* ─── CATEGORY FLASH SALE DIALOG ─── */}
      {categoryFlashDialog && (
        <CategoryFlashSaleDialog
          open={true}
          initialData={categoryFlashDialog === 'new' ? null : categoryFlashDialog}
          onClose={() => setCategoryFlashDialog(null)}
          onSave={(data) => saveCategoryFlashSale.mutate(data)}
          saving={saveCategoryFlashSale.isPending}
        />
      )}

      {/* ─── STACKING DIALOG ─── */}
      {stackingDialog && stackingPolicy && (
        <StackingPolicyDialog
          current={stackingPolicy}
          onClose={() => setStackingDialog(false)}
          onSave={(data) => saveStackingPolicy.mutate(data)}
          saving={saveStackingPolicy.isPending}
        />
      )}

      {/* ─── TIER DISCOUNT DIALOG ─── */}
      {tierDialog && (
        <TierDiscountDialog
          tier={tierDialog}
          onClose={() => setTierDialog(null)}
          onSave={(data) => saveTierDiscount.mutate(data)}
          saving={saveTierDiscount.isPending}
        />
      )}

      {/* ─── PER-PRODUCT TIER PRICING DIALOG ─── */}
      <Dialog open={!!tierPricingProduct} onOpenChange={open => { if (!open) setTierPricingProduct(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Set Tier Prices — {tierPricingProduct?.name}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <p className="text-xs text-muted-foreground">
              List price: ₹{tierPricingProduct ? parseFloat(tierPricingProduct.markupPrice).toLocaleString('en-IN') : 0}.
              Leave blank to use tier percentage discount.
            </p>
            {tierDiscounts.map(tier => (
              <div key={tier.id} className="flex items-center gap-3">
                <Label className="w-32 text-sm">{tier.name}</Label>
                <Input
                  type="number"
                  placeholder={`e.g. ${(parseFloat(tierPricingProduct?.markupPrice ?? '0') * (1 - parseFloat(tier.shopDiscountPct) / 100)).toFixed(0)}`}
                  value={tierPricingForm[String(tier.id)] ?? ''}
                  onChange={e => setTierPricingForm(f => ({ ...f, [String(tier.id)]: e.target.value }))}
                  className="flex-1"
                  min={0}
                />
                {tierPricingForm[String(tier.id)] && (
                  <span className="text-xs text-muted-foreground">
                    {(100 - parseFloat(tierPricingForm[String(tier.id)]) / parseFloat(tierPricingProduct?.markupPrice ?? '1') * 100).toFixed(1)}% off
                  </span>
                )}
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTierPricingProduct(null)}>Cancel</Button>
            <Button onClick={() => saveTierPricing.mutate()} disabled={saveTierPricing.isPending}>
              <Save className="h-4 w-4 mr-1" />{saveTierPricing.isPending ? 'Saving…' : 'Save Prices'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── Sub-Dialogs ──────────────────────────────────────────────────────────────

function PromoDialog({ open, onClose, initialData, onSave, saving }: {
  open: boolean;
  onClose: () => void;
  initialData: Promotion | null;
  onSave: (data: Record<string, unknown>) => void;
  saving: boolean;
}) {
  const [code, setCode] = useState(initialData?.code ?? '');
  const [description, setDescription] = useState(initialData?.description ?? '');
  const [discountType, setDiscountType] = useState<'percentage' | 'fixed'>(initialData?.discountType ?? 'percentage');
  const [discountValue, setDiscountValue] = useState(initialData?.discountValue ?? '');
  const [minOrderValue, setMinOrderValue] = useState(initialData?.minOrderValue ?? '0');
  const [usageLimit, setUsageLimit] = useState(String(initialData?.usageLimit ?? ''));
  const [scope, setScope] = useState<'all' | 'category' | 'product'>(initialData?.scope ?? 'all');
  const [scopeValues, setScopeValues] = useState((initialData?.scopeValues ?? []).join(', '));
  const [validFrom, setValidFrom] = useState(initialData?.validFrom ? initialData.validFrom.slice(0, 10) : '');
  const [validTo, setValidTo] = useState(initialData?.validTo ? initialData.validTo.slice(0, 10) : '');
  const [singleUsePerUser, setSingleUsePerUser] = useState(initialData?.singleUsePerUser ?? false);
  const [isActive, setIsActive] = useState(initialData?.isActive ?? true);

  useEffect(() => {
    setCode(initialData?.code ?? '');
    setDescription(initialData?.description ?? '');
    setDiscountType(initialData?.discountType ?? 'percentage');
    setDiscountValue(initialData?.discountValue ?? '');
    setMinOrderValue(initialData?.minOrderValue ?? '0');
    setUsageLimit(String(initialData?.usageLimit ?? ''));
    setScope(initialData?.scope ?? 'all');
    setScopeValues((initialData?.scopeValues ?? []).join(', '));
    setValidFrom(initialData?.validFrom ? initialData.validFrom.slice(0, 10) : '');
    setValidTo(initialData?.validTo ? initialData.validTo.slice(0, 10) : '');
    setSingleUsePerUser(initialData?.singleUsePerUser ?? false);
    setIsActive(initialData?.isActive ?? true);
  }, [initialData?.id]);

  const handleSave = () => {
    onSave({
      code: code.toUpperCase().trim(),
      description: description || null,
      discountType,
      discountValue: parseFloat(discountValue),
      minOrderValue: parseFloat(minOrderValue || '0'),
      usageLimit: usageLimit ? parseInt(usageLimit) : null,
      scope,
      scopeValues: scopeValues ? scopeValues.split(',').map(s => s.trim()).filter(Boolean) : null,
      validFrom: validFrom || null,
      validTo: validTo || null,
      singleUsePerUser,
      isActive,
    });
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{initialData ? 'Edit Promo Code' : 'New Promo Code'}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Code *</Label>
              <Input value={code} onChange={e => setCode(e.target.value.toUpperCase())} placeholder="SUMMER20" />
            </div>
            <div>
              <Label>Discount Type</Label>
              <Select value={discountType} onValueChange={(v: 'percentage' | 'fixed') => setDiscountType(v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="percentage">Percentage (%)</SelectItem>
                  <SelectItem value="fixed">Fixed Amount (₹)</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Discount Value *</Label>
              <Input type="number" value={discountValue} onChange={e => setDiscountValue(e.target.value)} placeholder={discountType === 'percentage' ? '20' : '500'} />
            </div>
            <div>
              <Label>Min Order Value</Label>
              <Input type="number" value={minOrderValue} onChange={e => setMinOrderValue(e.target.value)} placeholder="0" />
            </div>
          </div>
          <div>
            <Label>Description</Label>
            <Input value={description} onChange={e => setDescription(e.target.value)} placeholder="Summer discount for all members" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Usage Limit (blank = unlimited)</Label>
              <Input type="number" value={usageLimit} onChange={e => setUsageLimit(e.target.value)} placeholder="100" />
            </div>
            <div>
              <Label>Scope</Label>
              <Select value={scope} onValueChange={(v: 'all' | 'category' | 'product') => setScope(v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Products</SelectItem>
                  <SelectItem value="category">Specific Categories</SelectItem>
                  <SelectItem value="product">Specific Products (IDs)</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          {scope !== 'all' && (
            <div>
              <Label>{scope === 'category' ? 'Categories (comma separated)' : 'Product IDs (comma separated)'}</Label>
              <Input value={scopeValues} onChange={e => setScopeValues(e.target.value)} placeholder={scope === 'category' ? 'apparel, equipment' : '1, 2, 3'} />
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Valid From</Label>
              <Input type="date" value={validFrom} onChange={e => setValidFrom(e.target.value)} />
            </div>
            <div>
              <Label>Valid Until</Label>
              <Input type="date" value={validTo} onChange={e => setValidTo(e.target.value)} />
            </div>
          </div>
          <div className="flex items-center gap-6">
            <div className="flex items-center gap-2">
              <Switch checked={singleUsePerUser} onCheckedChange={setSingleUsePerUser} />
              <Label>Single use per member</Label>
            </div>
            {initialData && (
              <div className="flex items-center gap-2">
                <Switch checked={isActive} onCheckedChange={setIsActive} />
                <Label>Active</Label>
              </div>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={handleSave} disabled={saving || !code || !discountValue}>
            <Save className="h-4 w-4 mr-1" />{saving ? 'Saving…' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AffiliateDialog({ open, onClose, initialData, onSave, saving }: {
  open: boolean;
  onClose: () => void;
  initialData: AffiliateCode | null;
  onSave: (data: Record<string, unknown>) => void;
  saving: boolean;
}) {
  const [code, setCode] = useState(initialData?.code ?? '');
  const [description, setDescription] = useState(initialData?.description ?? '');
  const [ownerName, setOwnerName] = useState(initialData?.ownerName ?? '');
  const [ownerEmail, setOwnerEmail] = useState(initialData?.ownerEmail ?? '');
  const [commissionType, setCommissionType] = useState<'percentage' | 'fixed'>(initialData?.commissionType ?? 'percentage');
  const [commissionValue, setCommissionValue] = useState(initialData?.commissionValue ?? '5');
  const [buyerDiscountType, setBuyerDiscountType] = useState<'percentage' | 'fixed'>(initialData?.buyerDiscountType ?? 'percentage');
  const [buyerDiscountValue, setBuyerDiscountValue] = useState(initialData?.buyerDiscountValue ?? '10');
  const [validFrom, setValidFrom] = useState(initialData?.validFrom ? initialData.validFrom.slice(0, 10) : '');
  const [validTo, setValidTo] = useState(initialData?.validTo ? initialData.validTo.slice(0, 10) : '');
  const [isActive, setIsActive] = useState(initialData?.isActive ?? true);

  useEffect(() => {
    setCode(initialData?.code ?? '');
    setDescription(initialData?.description ?? '');
    setOwnerName(initialData?.ownerName ?? '');
    setOwnerEmail(initialData?.ownerEmail ?? '');
    setCommissionType(initialData?.commissionType ?? 'percentage');
    setCommissionValue(initialData?.commissionValue ?? '5');
    setBuyerDiscountType(initialData?.buyerDiscountType ?? 'percentage');
    setBuyerDiscountValue(initialData?.buyerDiscountValue ?? '10');
    setValidFrom(initialData?.validFrom ? initialData.validFrom.slice(0, 10) : '');
    setValidTo(initialData?.validTo ? initialData.validTo.slice(0, 10) : '');
    setIsActive(initialData?.isActive ?? true);
  }, [initialData?.id]);

  const handleSave = () => {
    onSave({ code, description: description || null, ownerName: ownerName || null, ownerEmail: ownerEmail || null, commissionType, commissionValue: parseFloat(commissionValue), buyerDiscountType, buyerDiscountValue: parseFloat(buyerDiscountValue), validFrom: validFrom || null, validTo: validTo || null, isActive });
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>{initialData ? 'Edit Affiliate Code' : 'New Affiliate Code'}</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Code *</Label>
              <Input value={code} onChange={e => setCode(e.target.value.toUpperCase())} placeholder="JOHNDOE2024" />
            </div>
            <div>
              <Label>Description</Label>
              <Input value={description} onChange={e => setDescription(e.target.value)} placeholder="John Doe referral" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Owner Name</Label>
              <Input value={ownerName} onChange={e => setOwnerName(e.target.value)} placeholder="John Doe" />
            </div>
            <div>
              <Label>Owner Email</Label>
              <Input type="email" value={ownerEmail} onChange={e => setOwnerEmail(e.target.value)} placeholder="john@example.com" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Buyer Discount Type</Label>
              <Select value={buyerDiscountType} onValueChange={(v: 'percentage' | 'fixed') => setBuyerDiscountType(v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="percentage">Percentage</SelectItem>
                  <SelectItem value="fixed">Fixed Amount</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Buyer Discount Value</Label>
              <Input type="number" value={buyerDiscountValue} onChange={e => setBuyerDiscountValue(e.target.value)} placeholder="10" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Commission Type</Label>
              <Select value={commissionType} onValueChange={(v: 'percentage' | 'fixed') => setCommissionType(v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="percentage">Percentage of order</SelectItem>
                  <SelectItem value="fixed">Fixed per order</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Commission Value</Label>
              <Input type="number" value={commissionValue} onChange={e => setCommissionValue(e.target.value)} placeholder="5" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Valid From</Label>
              <Input type="date" value={validFrom} onChange={e => setValidFrom(e.target.value)} />
            </div>
            <div>
              <Label>Valid Until</Label>
              <Input type="date" value={validTo} onChange={e => setValidTo(e.target.value)} />
            </div>
          </div>
          {initialData && (
            <div className="flex items-center gap-2">
              <Switch checked={isActive} onCheckedChange={setIsActive} />
              <Label>Active</Label>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={handleSave} disabled={saving || !code}>
            <Save className="h-4 w-4 mr-1" />{saving ? 'Saving…' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function BundleDialog({ open, onClose, initialData, onSave, saving }: {
  open: boolean;
  onClose: () => void;
  initialData: BundleDeal | null;
  onSave: (data: Record<string, unknown>) => void;
  saving: boolean;
}) {
  const [name, setName] = useState(initialData?.name ?? '');
  const [description, setDescription] = useState(initialData?.description ?? '');
  const [dealType, setDealType] = useState<'multi_product' | 'category_quantity'>(initialData?.dealType ?? 'multi_product');
  const [requiredProductIds, setRequiredProductIds] = useState((initialData?.requiredProductIds ?? []).join(', '));
  const [targetCategory, setTargetCategory] = useState(initialData?.targetCategory ?? '');
  const [minQuantity, setMinQuantity] = useState(String(initialData?.minQuantity ?? 2));
  const [discountType, setDiscountType] = useState<'percentage' | 'fixed'>(initialData?.discountType ?? 'percentage');
  const [discountValue, setDiscountValue] = useState(initialData?.discountValue ?? '10');
  const [cheapestItemFree, setCheapestItemFree] = useState(initialData?.cheapestItemFree ?? false);
  const [isActive, setIsActive] = useState(initialData?.isActive ?? true);

  useEffect(() => {
    setName(initialData?.name ?? '');
    setDescription(initialData?.description ?? '');
    setDealType(initialData?.dealType ?? 'multi_product');
    setRequiredProductIds((initialData?.requiredProductIds ?? []).join(', '));
    setTargetCategory(initialData?.targetCategory ?? '');
    setMinQuantity(String(initialData?.minQuantity ?? 2));
    setDiscountType(initialData?.discountType ?? 'percentage');
    setDiscountValue(initialData?.discountValue ?? '10');
    setCheapestItemFree(initialData?.cheapestItemFree ?? false);
    setIsActive(initialData?.isActive ?? true);
  }, [initialData?.id]);

  const handleSave = () => {
    onSave({
      name, description: description || null, dealType,
      requiredProductIds: requiredProductIds ? requiredProductIds.split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n)) : null,
      targetCategory: targetCategory || null,
      minQuantity: parseInt(minQuantity),
      discountType, discountValue: parseFloat(discountValue),
      cheapestItemFree, isActive,
    });
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>{initialData ? 'Edit Bundle Deal' : 'New Bundle Deal'}</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <div>
            <Label>Name *</Label>
            <Input value={name} onChange={e => setName(e.target.value)} placeholder="Buy 2 Shirts, Get 20% Off" />
          </div>
          <div>
            <Label>Description</Label>
            <Input value={description} onChange={e => setDescription(e.target.value)} placeholder="Optional description" />
          </div>
          <div>
            <Label>Deal Type</Label>
            <Select value={dealType} onValueChange={(v: 'multi_product' | 'category_quantity') => setDealType(v)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="multi_product">Buy specific products together</SelectItem>
                <SelectItem value="category_quantity">Buy N from a category</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {dealType === 'multi_product' ? (
            <div>
              <Label>Required Product IDs (comma separated)</Label>
              <Input value={requiredProductIds} onChange={e => setRequiredProductIds(e.target.value)} placeholder="1, 5, 12" />
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Category</Label>
                <Input value={targetCategory} onChange={e => setTargetCategory(e.target.value)} placeholder="apparel" />
              </div>
              <div>
                <Label>Min Quantity</Label>
                <Input type="number" value={minQuantity} onChange={e => setMinQuantity(e.target.value)} placeholder="3" />
              </div>
            </div>
          )}
          <div className="flex items-center gap-2">
            <Switch checked={cheapestItemFree} onCheckedChange={setCheapestItemFree} />
            <Label>Cheapest item free (overrides discount value)</Label>
          </div>
          {!cheapestItemFree && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Discount Type</Label>
                <Select value={discountType} onValueChange={(v: 'percentage' | 'fixed') => setDiscountType(v)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="percentage">Percentage</SelectItem>
                    <SelectItem value="fixed">Fixed Amount</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Discount Value</Label>
                <Input type="number" value={discountValue} onChange={e => setDiscountValue(e.target.value)} placeholder="10" />
              </div>
            </div>
          )}
          {initialData && (
            <div className="flex items-center gap-2">
              <Switch checked={isActive} onCheckedChange={setIsActive} />
              <Label>Active</Label>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={handleSave} disabled={saving || !name}>
            <Save className="h-4 w-4 mr-1" />{saving ? 'Saving…' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function FlashSaleDialog({ product, onClose, onSave, saving }: {
  product: FlashSaleProduct;
  onClose: () => void;
  onSave: (data: { salePrice: string; saleStart: string; saleEnd: string }) => void;
  saving: boolean;
}) {
  const [salePrice, setSalePrice] = useState(product.salePrice ?? '');
  const [saleStart, setSaleStart] = useState(product.saleStart ? product.saleStart.slice(0, 16) : '');
  const [saleEnd, setSaleEnd] = useState(product.saleEnd ? product.saleEnd.slice(0, 16) : '');

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader><DialogTitle>Flash Sale: {product.name}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="text-sm text-muted-foreground">Regular price: {parseFloat(product.markupPrice).toLocaleString('en-IN', { style: 'currency', currency: 'INR' })}</div>
          <div>
            <Label>Sale Price (₹) *</Label>
            <Input type="number" value={salePrice} onChange={e => setSalePrice(e.target.value)} placeholder="1999" />
          </div>
          <div>
            <Label>Sale Start *</Label>
            <Input type="datetime-local" value={saleStart} onChange={e => setSaleStart(e.target.value)} />
          </div>
          <div>
            <Label>Sale End *</Label>
            <Input type="datetime-local" value={saleEnd} onChange={e => setSaleEnd(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => onSave({ salePrice, saleStart, saleEnd })} disabled={saving || !salePrice || !saleStart || !saleEnd}>
            <Zap className="h-4 w-4 mr-1" />{saving ? 'Saving…' : 'Set Flash Sale'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function StackingPolicyDialog({ current, onClose, onSave, saving }: {
  current: StackingPolicy;
  onClose: () => void;
  onSave: (data: Record<string, unknown>) => void;
  saving: boolean;
}) {
  const [policy, setPolicy] = useState(current.discountStackingPolicy);
  const [customPriority, setCustomPriority] = useState((current.stackingPriority ?? ['member', 'promo', 'loyalty', 'bundle', 'affiliate']).join(', '));
  const [maxLayers, setMaxLayers] = useState(String(current.stackingMaxLayers ?? ''));
  const [pointsRate, setPointsRate] = useState(String(current.loyaltyPointsPerCurrencyUnit ?? 100));
  const [maxLoyaltyPct, setMaxLoyaltyPct] = useState(String(current.loyaltyMaxRedemptionPct ?? 20));

  const handleSave = () => {
    onSave({
      discountStackingPolicy: policy,
      stackingPriority: policy === 'custom' ? customPriority.split(',').map(s => s.trim()).filter(Boolean) : null,
      stackingMaxLayers: maxLayers ? parseInt(maxLayers) : null,
      loyaltyPointsPerCurrencyUnit: parseInt(pointsRate),
      loyaltyMaxRedemptionPct: parseInt(maxLoyaltyPct),
    });
  };

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>Discount Stacking Policy</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <div>
            <Label>Stacking Policy</Label>
            <Select value={policy} onValueChange={setPolicy}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No Stacking (highest only)</SelectItem>
                <SelectItem value="promo_member">Promo + Member (default)</SelectItem>
                <SelectItem value="all">All Discounts Stack</SelectItem>
                <SelectItem value="custom">Custom Priority Order</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {policy === 'custom' && (
            <>
              <div>
                <Label>Priority Order (comma separated)</Label>
                <Input value={customPriority} onChange={e => setCustomPriority(e.target.value)} placeholder="member, promo, loyalty, bundle, affiliate" />
                <p className="text-xs text-muted-foreground mt-1">Discount types: member, promo, loyalty, bundle, affiliate, flash_sale</p>
              </div>
              <div>
                <Label>Max Discount Layers (blank = all)</Label>
                <Input type="number" value={maxLayers} onChange={e => setMaxLayers(e.target.value)} placeholder="2" />
              </div>
            </>
          )}
          <div className="border-t pt-4 space-y-3">
            <div className="font-semibold text-sm">Loyalty Points Settings</div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Points per ₹1</Label>
                <Input type="number" value={pointsRate} onChange={e => setPointsRate(e.target.value)} placeholder="100" />
                <p className="text-xs text-muted-foreground mt-1">e.g. 100 = 100 points = ₹1</p>
              </div>
              <div>
                <Label>Max Redemption %</Label>
                <Input type="number" value={maxLoyaltyPct} onChange={e => setMaxLoyaltyPct(e.target.value)} placeholder="20" />
                <p className="text-xs text-muted-foreground mt-1">% of order value redeemable</p>
              </div>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={handleSave} disabled={saving}>
            <Save className="h-4 w-4 mr-1" />{saving ? 'Saving…' : 'Save Policy'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TierDiscountDialog({ tier, onClose, onSave, saving }: {
  tier: MembershipTierDiscount;
  onClose: () => void;
  onSave: (data: Record<string, unknown>) => void;
  saving: boolean;
}) {
  const [globalPct, setGlobalPct] = useState(tier.shopDiscountPct ?? '0');
  const [categoryDiscounts, setCategoryDiscounts] = useState(
    Object.entries(tier.shopCategoryDiscounts ?? {}).map(([cat, pct]) => ({ cat, pct: String(pct) }))
  );

  const addCategory = () => setCategoryDiscounts(c => [...c, { cat: '', pct: '0' }]);
  const removeCategory = (i: number) => setCategoryDiscounts(c => c.filter((_, idx) => idx !== i));
  const updateCategory = (i: number, field: 'cat' | 'pct', val: string) => setCategoryDiscounts(c => c.map((e, idx) => idx === i ? { ...e, [field]: val } : e));

  const handleSave = () => {
    const catDiscounts = categoryDiscounts.reduce((acc, { cat, pct }) => {
      if (cat.trim()) acc[cat.trim()] = parseFloat(pct);
      return acc;
    }, {} as Record<string, number>);
    onSave({
      shopDiscountPct: parseFloat(globalPct),
      shopCategoryDiscounts: Object.keys(catDiscounts).length > 0 ? catDiscounts : null,
    });
  };

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>Discounts for {tier.name}</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <div>
            <Label>Global Shop Discount (%)</Label>
            <Input type="number" value={globalPct} onChange={e => setGlobalPct(e.target.value)} placeholder="15" />
            <p className="text-xs text-muted-foreground mt-1">Applied to all product categories unless a category-specific override is set below.</p>
          </div>
          <div>
            <div className="flex items-center justify-between mb-2">
              <Label>Category-specific Discounts</Label>
              <Button variant="outline" size="sm" onClick={addCategory}><Plus className="h-3 w-3 mr-1" /> Add</Button>
            </div>
            {categoryDiscounts.map((cd, i) => (
              <div key={i} className="flex gap-2 mb-2">
                <Input value={cd.cat} onChange={e => updateCategory(i, 'cat', e.target.value)} placeholder="apparel" className="flex-1" />
                <Input type="number" value={cd.pct} onChange={e => updateCategory(i, 'pct', e.target.value)} placeholder="20" className="w-20" />
                <Button variant="ghost" size="icon" onClick={() => removeCategory(i)}><X className="h-4 w-4" /></Button>
              </div>
            ))}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={handleSave} disabled={saving}>
            <Save className="h-4 w-4 mr-1" />{saving ? 'Saving…' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const SHOP_CATEGORIES = ['apparel', 'equipment', 'accessories', 'footwear', 'balls', 'bags', 'training', 'other'];

function CategoryFlashSaleDialog({ open, initialData, onClose, onSave, saving }: {
  open: boolean;
  initialData: CategoryFlashSale | null;
  onClose: () => void;
  onSave: (data: Record<string, unknown>) => void;
  saving: boolean;
}) {
  const [category, setCategory] = useState(initialData?.category ?? '');
  const [label, setLabel] = useState(initialData?.label ?? '');
  const [discountPct, setDiscountPct] = useState(initialData?.discountPct ?? '10');
  const [saleStart, setSaleStart] = useState(initialData?.saleStart ? new Date(initialData.saleStart).toISOString().slice(0, 16) : '');
  const [saleEnd, setSaleEnd] = useState(initialData?.saleEnd ? new Date(initialData.saleEnd).toISOString().slice(0, 16) : '');
  const [isActive, setIsActive] = useState(initialData?.isActive ?? true);

  useEffect(() => {
    setCategory(initialData?.category ?? '');
    setLabel(initialData?.label ?? '');
    setDiscountPct(initialData?.discountPct ?? '10');
    setSaleStart(initialData?.saleStart ? new Date(initialData.saleStart).toISOString().slice(0, 16) : '');
    setSaleEnd(initialData?.saleEnd ? new Date(initialData.saleEnd).toISOString().slice(0, 16) : '');
    setIsActive(initialData?.isActive ?? true);
  }, [initialData?.id]);

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>{initialData ? 'Edit Category Flash Sale' : 'New Category Flash Sale'}</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <div>
            <Label>Category *</Label>
            <select className="w-full mt-1 border rounded px-2 py-1.5 text-sm" value={category} onChange={e => setCategory(e.target.value)}>
              <option value="">— Select category —</option>
              {SHOP_CATEGORIES.map(c => <option key={c} value={c} className="capitalize">{c}</option>)}
            </select>
          </div>
          <div>
            <Label>Label (shown in discount breakdown)</Label>
            <Input value={label} onChange={e => setLabel(e.target.value)} placeholder="e.g. Summer Sale — Apparel" />
          </div>
          <div>
            <Label>Discount % *</Label>
            <Input type="number" min="1" max="100" value={discountPct} onChange={e => setDiscountPct(e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Start *</Label>
              <Input type="datetime-local" value={saleStart} onChange={e => setSaleStart(e.target.value)} />
            </div>
            <div>
              <Label>End *</Label>
              <Input type="datetime-local" value={saleEnd} onChange={e => setSaleEnd(e.target.value)} />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <input type="checkbox" id="catFlashActive" checked={isActive} onChange={e => setIsActive(e.target.checked)} />
            <Label htmlFor="catFlashActive">Active</Label>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => onSave({ category, label: label || null, discountPct: parseFloat(discountPct), saleStart, saleEnd, isActive })} disabled={saving || !category || !discountPct || !saleStart || !saleEnd}>
            <Save className="h-4 w-4 mr-1" />{saving ? 'Saving…' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
