import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useGetMe } from '@workspace/api-client-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import {
  Settings, Palette, Globe, Shield, Upload, Check, ChevronRight,
  Building2, Link2, Copy, AlertTriangle, Zap, CreditCard,
  Mail, Smartphone, MessageSquare, MessageCircle, CheckCircle2, XCircle,
  Phone, MapPin, ExternalLink, Eye, EyeOff, KeyRound, Trash2,
  ShoppingBag, Package, Truck, Edit2, RefreshCw, DollarSign, Languages,
  BookOpen, Bell, Inbox, ShieldCheck, Search, X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import i18n, { SUPPORTED_LANGUAGES } from '@/i18n';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useToast } from '@/hooks/use-toast';
import {
  AreaChart, Area, BarChart, Bar, XAxis, YAxis, Tooltip as RechartsTooltip, ResponsiveContainer, CartesianGrid, ReferenceLine, Cell,
} from 'recharts';

// Task #1901 — keep this list in sync with the `sections` array built inside
// the component. It is used to validate the `?section=` query-string param so
// a stale or hand-edited link can't push us into a non-existent panel.
const SECTION_IDS = [
  'profile', 'contact', 'branding', 'language', 'rules', 'domain',
  'channels', 'ghin', 'shop', 'subscription', 'danger',
] as const;
type SectionId = typeof SECTION_IDS[number];
const isSectionId = (v: unknown): v is SectionId =>
  typeof v === 'string' && (SECTION_IDS as readonly string[]).includes(v);

interface OrgDetail {
  id: number;
  name: string;
  slug: string;
  description: string | null;
  logoUrl: string | null;
  primaryColor: string | null;
  customDomain: string | null;
  subscriptionTier: string;
  isActive: boolean;
  contactEmail: string | null;
  contactPhone: string | null;
  address: string | null;
  website: string | null;
  defaultLanguage: string | null;
}

export default function SettingsPage() {
  const { toast } = useToast();
  const { t } = useTranslation(['common', 'profile', 'admin']);
  const queryClient = useQueryClient();
  const { data: user } = useGetMe();
  const orgId = user?.organizationId;

  const { data: org } = useQuery<OrgDetail>({
    queryKey: [`/api/organizations/${orgId}`],
    queryFn: () => fetch(`/api/organizations/${orgId}`).then(r => { if (!r.ok) throw new Error('Request failed'); return r.json(); }),
    enabled: !!orgId,
  });

  const [profile, setProfile] = useState({ name: '', description: '' });
  const [branding, setBranding] = useState({ logoUrl: '', primaryColor: '#1e4d2b', customDomain: '' });
  const [contact, setContact] = useState({ contactEmail: '', contactPhone: '', address: '', website: '' });
  const [defaultLanguage, setDefaultLanguage] = useState('en');
  const [savingLanguage, setSavingLanguage] = useState(false);
  const [rulesGoverningBody, setRulesGoverningBody] = useState<'rna' | 'usga'>('rna');
  const [localRulesContent, setLocalRulesContent] = useState('');
  const [savingRules, setSavingRules] = useState(false);
  const [saving, setSaving] = useState(false);
  const [uploadingLogo, setUploadingLogo] = useState(false);
  const [colorPreview, setColorPreview] = useState('#1e4d2b');
  // Task #1901 — remember which settings panel the admin was looking at so a
  // refresh (or a shared link) deep-links straight back into it instead of
  // always landing on "Club Profile". Mirrors the pattern used for the
  // webhook-deliveries filter below and `?watchWindow=` in super-admin.tsx:
  // seed from the URL on mount, then `replaceState` the param on every
  // change. First-time visitors with no `?section=` in the URL still see the
  // default "profile" panel.
  const [activeSection, setActiveSection] = useState<SectionId>(() => {
    if (typeof window === 'undefined') return 'profile';
    const fromUrl = new URLSearchParams(window.location.search).get('section');
    return isSectionId(fromUrl) ? fromUrl : 'profile';
  });
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const sp = new URLSearchParams(window.location.search);
    if (activeSection === 'profile') {
      // Default panel — keep the URL clean instead of pinning ?section=profile.
      sp.delete('section');
    } else {
      sp.set('section', activeSection);
    }
    const qs = sp.toString();
    const newUrl = `${window.location.pathname}${qs ? `?${qs}` : ''}${window.location.hash}`;
    const currentUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (newUrl !== currentUrl) {
      window.history.replaceState(window.history.state, '', newUrl);
    }
  }, [activeSection]);

  useEffect(() => {
    if (org) {
      setProfile({ name: org.name ?? '', description: org.description ?? '' });
      setBranding({ logoUrl: org.logoUrl ?? '', primaryColor: org.primaryColor ?? '#1e4d2b', customDomain: org.customDomain ?? '' });
      setContact({ contactEmail: org.contactEmail ?? '', contactPhone: org.contactPhone ?? '', address: org.address ?? '', website: org.website ?? '' });
      setColorPreview(org.primaryColor ?? '#1e4d2b');
      setDefaultLanguage(org.defaultLanguage ?? 'en');
    }
  }, [org]);

  // Task #362 — load + save the per-club Rules Assistant config (governing
  // body wording + local rules markdown).
  const { data: rulesConfig } = useQuery<{ rulesGoverningBody: 'rna' | 'usga'; localRulesContent: string }>({
    queryKey: [`/api/organizations/${orgId}/rules-config`],
    queryFn: () => fetch(`/api/organizations/${orgId}/rules-config`, { credentials: 'include' })
      .then(r => { if (!r.ok) throw new Error('Request failed'); return r.json(); }),
    enabled: !!orgId && activeSection === 'rules',
  });
  useEffect(() => {
    if (rulesConfig) {
      setRulesGoverningBody(rulesConfig.rulesGoverningBody);
      setLocalRulesContent(rulesConfig.localRulesContent ?? '');
    }
  }, [rulesConfig]);

  async function saveRulesConfig() {
    if (!orgId) return;
    setSavingRules(true);
    try {
      const res = await fetch(`/api/organizations/${orgId}/rules-config`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rulesGoverningBody, localRulesContent }),
      });
      if (res.ok) {
        toast({ title: t('admin:toasts.rulesConfigSaved') });
        queryClient.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/rules-config`] });
      } else {
        const body = await res.json().catch(() => ({})) as { error?: string };
        toast({ title: body.error ?? t('admin:toasts.rulesConfigSaveFailed'), variant: 'destructive' });
      }
    } catch {
      toast({ title: t('admin:toasts.rulesConfigSaveFailed'), variant: 'destructive' });
    } finally { setSavingRules(false); }
  }

  async function saveDefaultLanguage() {
    if (!orgId) return;
    setSavingLanguage(true);
    try {
      const res = await fetch(`/api/organizations/${orgId}/language`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ defaultLanguage }),
      });
      if (res.ok) {
        toast({ title: t('admin:toasts.defaultLanguageSaved') });
        queryClient.invalidateQueries({ queryKey: [`/api/organizations/${orgId}`] });
      } else {
        toast({ title: t('admin:toasts.failedLanguageSave'), variant: 'destructive' });
      }
    } catch { toast({ title: t('admin:toasts.failedLanguageSave'), variant: 'destructive' }); }
    finally { setSavingLanguage(false); }
  }

  const saveProfile = async () => {
    if (!orgId) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/organizations/${orgId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...org, ...profile }),
      });
      if (!res.ok) throw new Error('Save failed');
      await queryClient.invalidateQueries({ queryKey: [`/api/organizations/${orgId}`] });
      toast({ title: t('admin:toasts.profileSaved') });
    } catch {
      toast({ title: t('admin:toasts.saveFailed'), variant: 'destructive' });
    } finally { setSaving(false); }
  };

  const saveContact = async () => {
    if (!orgId) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/organizations/${orgId}/contact`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(contact),
      });
      if (!res.ok) throw new Error('Save failed');
      await queryClient.invalidateQueries({ queryKey: [`/api/organizations/${orgId}`] });
      toast({ title: t('admin:toasts.contactSaved') });
    } catch {
      toast({ title: t('admin:toasts.saveFailed'), variant: 'destructive' });
    } finally { setSaving(false); }
  };

  const saveBranding = async () => {
    if (!orgId) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/organizations/${orgId}/branding`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ logoUrl: branding.logoUrl, primaryColor: branding.primaryColor }),
      });
      if (!res.ok) throw new Error('Save failed');
      await queryClient.invalidateQueries({ queryKey: [`/api/organizations/${orgId}`] });

      // Apply CSS variable immediately for live preview
      document.documentElement.style.setProperty('--primary-brand', branding.primaryColor);
      toast({ title: t('admin:toasts.brandingSaved'), description: t('admin:toasts.brandingDesc') });
    } catch {
      toast({ title: t('admin:toasts.saveFailed'), variant: 'destructive' });
    } finally { setSaving(false); }
  };

  // Task #580 — Org admins set/clear their custom vanity domain through a
  // dedicated endpoint that validates hostname syntax, normalises case,
  // checks for cross-org collisions and gates by the customDomain plan
  // flag. Errors from the server are surfaced verbatim so admins know
  // exactly what to fix.
  const saveCustomDomain = async (overrideValue?: string | null) => {
    if (!orgId) return;
    const value = overrideValue !== undefined
      ? overrideValue
      : (branding.customDomain.trim() || null);
    setSaving(true);
    try {
      const res = await fetch(`/api/organizations/${orgId}/marketing-site/custom-domain`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customDomain: value }),
      });
      const body = await res.json().catch(() => ({} as { error?: string; customDomain?: string | null }));
      if (!res.ok) {
        toast({ title: body.error ?? t('admin:toasts.saveFailed'), variant: 'destructive' });
        return;
      }
      // Reflect the server-normalised value (lowercased, stripped) in the form.
      setBranding(b => ({ ...b, customDomain: body.customDomain ?? '' }));
      await queryClient.invalidateQueries({ queryKey: [`/api/organizations/${orgId}`] });
      toast({ title: t('admin:toasts.customDomainSaved') });
    } catch {
      toast({ title: t('admin:toasts.saveFailed'), variant: 'destructive' });
    } finally { setSaving(false); }
  };

  const tierBadgeColor: Record<string, string> = {
    free: 'bg-gray-500/20 text-gray-400 border-gray-500/30',
    starter: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30',
    pro: 'bg-purple-500/20 text-purple-400 border-purple-500/30',
    enterprise: 'bg-amber-500/20 text-amber-400 border-amber-500/30',
  };

  const sections: { id: SectionId; label: string; icon: typeof Building2 }[] = [
    { id: 'profile', label: t('admin:sections.clubProfile'), icon: Building2 },
    { id: 'contact', label: t('admin:sections.contactInfo'), icon: Phone },
    { id: 'branding', label: t('admin:sections.branding'), icon: Palette },
    { id: 'language', label: t('admin:sections.language'), icon: Languages },
    { id: 'rules', label: t('admin:sections.rulesAssistant'), icon: BookOpen },
    { id: 'domain', label: t('admin:sections.customDomain'), icon: Globe },
    { id: 'channels', label: t('admin:sections.commChannels'), icon: MessageSquare },
    { id: 'ghin', label: t('admin:sections.ghinWhs'), icon: KeyRound },
    { id: 'shop', label: t('admin:sections.shop'), icon: ShoppingBag },
    { id: 'subscription', label: t('admin:sections.subscription'), icon: CreditCard },
    { id: 'danger', label: t('admin:sections.dangerZone'), icon: AlertTriangle },
  ];

  // ── Shop state ────────────────────────────────────────────────────────────
  type ShopProduct = { id: number; name: string; description: string | null; imageUrl: string | null; category: string; basePrice: string; markupPrice: string; currency: string; sizes: string[]; isActive: boolean; };
  type ShopOrder = { id: number; customerName: string; customerEmail: string; size: string | null; quantity: number; totalAmount: string; currency: string; status: string; trackingNumber: string | null; trackingUrl: string | null; createdAt: string; productName: string | null; productImage: string | null; };

  const CURRENCY_SYM: Record<string, string> = { INR: '₹', USD: '$', GBP: '£', EUR: '€', AED: 'د.إ', SGD: 'S$', AUD: 'A$' };
  const fmtPrice = (price: string | number, currency: string) =>
    `${CURRENCY_SYM[currency] ?? currency}${parseFloat(String(price)).toLocaleString(i18n.language || undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

  const ORDER_STATUS_COLORS: Record<string, string> = {
    pending: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30',
    paid: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
    processing: 'bg-purple-500/20 text-purple-400 border-purple-500/30',
    shipped: 'bg-cyan-500/20 text-cyan-400 border-cyan-500/30',
    delivered: 'bg-green-500/20 text-green-400 border-green-500/30',
    cancelled: 'bg-gray-500/20 text-gray-400 border-gray-500/30',
    refunded: 'bg-red-500/20 text-red-400 border-red-500/30',
  };

  const emptyProductForm = { name: '', description: '', imageUrl: '', category: 'apparel', basePrice: '', markupPrice: '', currency: 'INR', sizes: 'S,M,L,XL', isActive: true };
  const [shopProductDialog, setShopProductDialog] = useState(false);
  const [shopEditId, setShopEditId] = useState<number | null>(null);
  const [shopProductForm, setShopProductForm] = useState(emptyProductForm);
  const [shopSaving, setShopSaving] = useState(false);
  const [shopTrackingDialog, setShopTrackingDialog] = useState(false);
  const [shopTrackingOrder, setShopTrackingOrder] = useState<ShopOrder | null>(null);
  const [shopTrackingForm, setShopTrackingForm] = useState({ trackingNumber: '', trackingUrl: '', status: '' });
  const [shopUpdatingTracking, setShopUpdatingTracking] = useState(false);

  const { data: shopProducts = [], isLoading: shopProductsLoading, refetch: refetchShopProducts } = useQuery<ShopProduct[]>({
    queryKey: [`/api/organizations/${orgId}/shop/products-admin`],
    queryFn: () => fetch(`/api/organizations/${orgId}/shop/products?admin=true`, { credentials: 'include' }).then(r => { if (!r.ok) throw new Error('Failed'); return r.json(); }),
    enabled: !!orgId && activeSection === 'shop',
  });

  const { data: shopOrders = [], isLoading: shopOrdersLoading, refetch: refetchShopOrders } = useQuery<ShopOrder[]>({
    queryKey: [`/api/organizations/${orgId}/shop/orders-admin`],
    queryFn: () => fetch(`/api/organizations/${orgId}/shop/orders`, { credentials: 'include' }).then(r => { if (!r.ok) throw new Error('Failed'); return r.json(); }),
    enabled: !!orgId && activeSection === 'shop',
  });

  const shopRevenue = shopOrders.reduce((sum: number, o) => sum + parseFloat(o.totalAmount || '0'), 0);
  const shopCurrency = shopOrders[0]?.currency ?? 'INR';
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const ordersThisMonth = shopOrders.filter(o => new Date(o.createdAt) >= monthStart).length;
  const pendingFulfillment = shopOrders.filter(o => ['paid', 'processing'].includes(o.status)).length;

  async function saveShopProduct() {
    if (!orgId || !shopProductForm.name || !shopProductForm.markupPrice) {
      toast({ title: t('admin:toasts.priceRequired'), variant: 'destructive' }); return;
    }
    setShopSaving(true);
    try {
      const body = {
        ...shopProductForm,
        sizes: shopProductForm.sizes.split(',').map((s: string) => s.trim()).filter(Boolean),
      };
      const url = shopEditId
        ? `/api/organizations/${orgId}/shop/products/${shopEditId}`
        : `/api/organizations/${orgId}/shop/products`;
      const res = await fetch(url, {
        method: shopEditId ? 'PUT' : 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? 'Save failed');
      toast({ title: shopEditId ? t('admin:toasts.productUpdated') : t('admin:toasts.productCreated') });
      setShopProductDialog(false);
      queryClient.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/shop/products-admin`] });
    } catch (e) {
      toast({ title: (e as Error).message, variant: 'destructive' });
    } finally { setShopSaving(false); }
  }

  async function deleteShopProduct(productId: number) {
    if (!orgId || !confirm('Deactivate this product?')) return;
    await fetch(`/api/organizations/${orgId}/shop/products/${productId}`, { method: 'DELETE', credentials: 'include' });
    queryClient.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/shop/products-admin`] });
  }

  async function saveShopTracking() {
    if (!orgId || !shopTrackingOrder) return;
    setShopUpdatingTracking(true);
    try {
      const body: Record<string, string> = {};
      if (shopTrackingForm.trackingNumber) body.trackingNumber = shopTrackingForm.trackingNumber;
      if (shopTrackingForm.trackingUrl) body.trackingUrl = shopTrackingForm.trackingUrl;
      if (shopTrackingForm.status) body.status = shopTrackingForm.status;
      const res = await fetch(`/api/organizations/${orgId}/shop/orders/${shopTrackingOrder.id}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? 'Update failed');
      toast({ title: t('admin:toasts.orderUpdated') });
      setShopTrackingDialog(false);
      queryClient.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/shop/orders-admin`] });
    } catch (e) {
      toast({ title: (e as Error).message, variant: 'destructive' });
    } finally { setShopUpdatingTracking(false); }
  }

  // GHIN Credentials state
  const [ghinCreds, setGhinCreds] = useState({ apiKey: '', username: '', password: '' });
  const [showGhinPassword, setShowGhinPassword] = useState(false);
  const [savingGhin, setSavingGhin] = useState(false);
  const [deletingGhin, setDeletingGhin] = useState(false);
  const [testingGhin, setTestingGhin] = useState(false);
  const [ghinTestResult, setGhinTestResult] = useState<{ success: boolean; message?: string; error?: string; membersWithGhin?: number } | null>(null);
  const [ghinStatus, setGhinStatus] = useState<{ configured: boolean; hasOrgCredentials: boolean; hasEnvCredentials: boolean; canStoreOrgCredentials: boolean } | null>(null);

  useEffect(() => {
    if (activeSection === 'ghin' && orgId) {
      fetch(`/api/organizations/${orgId}/ghin-credentials`, { credentials: 'include' })
        .then(r => r.ok ? r.json() : null)
        .then(data => { if (data) setGhinStatus(data); })
        .catch(() => undefined);
    }
  }, [activeSection, orgId]);

  async function testGhinConnection() {
    if (!orgId) return;
    setTestingGhin(true);
    setGhinTestResult(null);
    try {
      const res = await fetch(`/api/organizations/${orgId}/ghin-credentials/test`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
      });
      const data = await res.json();
      setGhinTestResult(data);
      if (data.success) {
        toast({ title: t('admin:toasts.ghinVerified'), description: data.message });
      } else {
        toast({ title: t('admin:toasts.ghinTestFailed'), description: data.error, variant: 'destructive' });
      }
    } catch {
      toast({ title: t('admin:toasts.testFailed'), description: t('admin:toasts.networkError'), variant: 'destructive' });
    } finally {
      setTestingGhin(false);
    }
  }

  async function saveGhinCredentials() {
    if (!orgId) return;
    if (!ghinCreds.apiKey || !ghinCreds.username || !ghinCreds.password) {
      toast({ title: t('admin:toasts.allFieldsRequired'), variant: 'destructive' }); return;
    }
    setSavingGhin(true);
    try {
      const res = await fetch(`/api/organizations/${orgId}/ghin-credentials`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(ghinCreds),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Failed to save GHIN credentials');
      toast({ title: t('admin:toasts.ghinSaved'), description: t('admin:toasts.ghinSavedDesc') });
      setGhinCreds({ apiKey: '', username: '', password: '' });
      setGhinStatus({ configured: true, hasOrgCredentials: true, hasEnvCredentials: ghinStatus?.hasEnvCredentials ?? false, canStoreOrgCredentials: true });
    } catch (e: unknown) {
      toast({ title: e instanceof Error ? e.message : t('admin:toasts.failedSave'), variant: 'destructive' });
    } finally {
      setSavingGhin(false);
    }
  }

  async function deleteGhinCredentials() {
    if (!orgId) return;
    setDeletingGhin(true);
    try {
      await fetch(`/api/organizations/${orgId}/ghin-credentials`, { method: 'DELETE', credentials: 'include' });
      toast({ title: t('admin:toasts.ghinRemoved') });
      setGhinStatus(prev => prev ? { ...prev, configured: prev.hasEnvCredentials, hasOrgCredentials: false } : null);
    } catch {
      toast({ title: t('admin:toasts.failedRemove'), variant: 'destructive' });
    } finally {
      setDeletingGhin(false);
    }
  }

  interface ChannelStatus {
    active: boolean;
    provider: string | null;
    setupInstructions: string | null;
  }
  interface ChannelStatusResponse {
    channels: {
      email: ChannelStatus;
      push: ChannelStatus;
      sms: ChannelStatus;
      whatsapp: ChannelStatus;
    };
    payments?: {
      stripe: {
        baseCurrency: string | null;
        usesStripe: boolean;
        secretKeyConfigured: boolean;
        webhookSecretConfigured: boolean;
        webhookEndpoint: string;
        warning: boolean;
        setupInstructions: string | null;
      };
    };
  }

  const { data: channelStatus } = useQuery<ChannelStatusResponse>({
    queryKey: ['/api/admin/channel-status'],
    queryFn: () => fetch('/api/admin/channel-status').then(r => { if (!r.ok) throw new Error('Request failed'); return r.json(); }),
    staleTime: 30000,
  });

  // Task #1361 — registry of every notification key the dispatcher knows
  // about (Task #1005). Surfaces them in the channels section with a
  // "View audit" deep-link straight into the dispatch history feed
  // (Task #1172) for the chosen key, so admins don't have to hop to the
  // audit page and re-pick the key from the dropdown.
  // Task #1632 — entries now carry the human description, category,
  // default channels, and auditRequired flag so the row tells admins what
  // the key actually does and where it routes by default.
  interface NotificationTemplateEntry {
    key: string;
    category: string;
    description: string;
    defaultChannels: string[];
    auditRequired: boolean;
  }
  interface NotificationTemplatesResponse { keys: NotificationTemplateEntry[] }
  const { data: notificationTemplates } = useQuery<NotificationTemplatesResponse>({
    queryKey: ['/api/admin/notification-templates'],
    queryFn: () => fetch('/api/admin/notification-templates', { credentials: 'include' })
      .then(r => { if (!r.ok) throw new Error('Request failed'); return r.json(); }),
    staleTime: 5 * 60_000,
    enabled: activeSection === 'channels',
  });

  // Task #2025 / #2026 — Client-side search + category/channel filters
  // for the registry panel. The list grows with every new notify the
  // platform ships, so admins need to be able to narrow it (e.g. "all
  // handicap.* keys" or "everything that goes to push") without paging
  // through the full scroll list. The metadata required to filter on is
  // already on every row (Task #1632), so this is a pure client-side
  // operation — no extra fetches, no new endpoint.
  //
  // Task #2026 also adds an "audit-required only" toggle alongside the
  // category / channel chips so admins can quickly zero in on the keys
  // that mandate an admin audit row per dispatch (Task #1632 added the
  // auditRequired flag to every entry).
  const [registrySearch, setRegistrySearch] = useState('');
  const [registryCategoryFilters, setRegistryCategoryFilters] = useState<Set<string>>(() => new Set());
  const [registryChannelFilters, setRegistryChannelFilters] = useState<Set<string>>(() => new Set());
  const [registryAuditOnly, setRegistryAuditOnly] = useState(false);
  const registrySearchRef = useRef<HTMLInputElement | null>(null);

  // Distinct category & channel chip lists, derived from whatever the
  // server returned. Sorted alphabetically so the chip row is stable as
  // new notifications are registered.
  const registryCategoryOptions = useMemo<string[]>(() => {
    if (!notificationTemplates) return [];
    const set = new Set<string>();
    for (const e of notificationTemplates.keys) {
      if (e.category) set.add(e.category);
    }
    return Array.from(set).sort();
  }, [notificationTemplates]);
  const registryChannelOptions = useMemo<string[]>(() => {
    if (!notificationTemplates) return [];
    const set = new Set<string>();
    for (const e of notificationTemplates.keys) {
      for (const c of e.defaultChannels) set.add(c);
    }
    return Array.from(set).sort();
  }, [notificationTemplates]);

  const filteredRegistryEntries = useMemo<NotificationTemplateEntry[]>(() => {
    if (!notificationTemplates) return [];
    const q = registrySearch.trim().toLowerCase();
    return notificationTemplates.keys.filter(e => {
      if (registryAuditOnly && !e.auditRequired) return false;
      if (registryCategoryFilters.size > 0 && !registryCategoryFilters.has(e.category)) {
        return false;
      }
      // Channel chips are OR'd: a row matches if it routes to ANY of
      // the selected channels by default.
      if (registryChannelFilters.size > 0) {
        const hit = e.defaultChannels.some(c => registryChannelFilters.has(c));
        if (!hit) return false;
      }
      if (q.length > 0) {
        const hay = `${e.key} ${e.category} ${e.description}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [notificationTemplates, registrySearch, registryCategoryFilters, registryChannelFilters, registryAuditOnly]);

  const registryFiltersActive =
    registrySearch.trim().length > 0 ||
    registryCategoryFilters.size > 0 ||
    registryChannelFilters.size > 0 ||
    registryAuditOnly;

  const toggleRegistryCategory = useCallback((cat: string) => {
    setRegistryCategoryFilters(prev => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat); else next.add(cat);
      return next;
    });
  }, []);
  const toggleRegistryChannel = useCallback((ch: string) => {
    setRegistryChannelFilters(prev => {
      const next = new Set(prev);
      if (next.has(ch)) next.delete(ch); else next.add(ch);
      return next;
    });
  }, []);
  const clearRegistryFilters = useCallback(() => {
    setRegistrySearch('');
    setRegistryCategoryFilters(new Set());
    setRegistryChannelFilters(new Set());
    setRegistryAuditOnly(false);
  }, []);

  // "/" focuses the registry search box, like GitHub / Slack search.
  // Only active while the channels section is visible (otherwise the
  // input isn't mounted) and never hijacks "/" when the admin is
  // already typing into another input/textarea/select/contenteditable.
  useEffect(() => {
    if (activeSection !== 'channels') return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
        if (target.isContentEditable) return;
      }
      const input = registrySearchRef.current;
      if (!input) return;
      e.preventDefault();
      input.focus();
      input.select();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activeSection]);

  // Task #1631 — per-key template preview dialog. Hits the existing
  // `GET /api/admin/notification-templates/:key/preview` endpoint
  // (Task #1005) and renders the canned title/body/HTML the dispatcher
  // would build for that key, without firing a real send. 404s are
  // surfaced inline (e.g. a key that was renamed/removed from the
  // registry between the list fetch and the click).
  //
  // Task #1648 — adds a language picker so admins can re-render branded
  // templates in any of the 21 supported languages before they reach
  // players. The picker defaults to the admin's own preferred language
  // and is hidden for keys that fall back to the generic English-only
  // wrapper (where lang has no effect).
  interface NotificationTemplatePreview {
    key: string;
    category: string;
    description: string;
    digestable: boolean;
    defaultChannels: string[];
    auditRequired: boolean;
    branded?: boolean;
    lang?: string;
    availableLanguages?: string[];
    // Task #2051 — `"fallback"` when the API rendered the English
    // source for a non-English language because no translation pack
    // exists yet. Surfaced as an inline warning in the dialog so
    // localisation reviewers don't ship "translated" emails that
    // are actually English.
    translationStatus?: 'native' | 'fallback';
    sample: { title: string; body: string; html: string };
  }
  const [previewKey, setPreviewKey] = useState<string | null>(null);
  const [previewLang, setPreviewLang] = useState<string>('en');
  const [previewData, setPreviewData] = useState<NotificationTemplatePreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  // Task #2050 — optional side-by-side comparison pane. When enabled, a
  // second copy of the same branded template is fetched for a different
  // language so admins can spot translation gaps, layout drift (e.g.
  // long German strings overflowing the CTA), or missing variable
  // interpolations without repeatedly toggling the primary picker.
  // The compare state stays decoupled from the primary so each pane
  // can be re-rendered/loaded/errored independently.
  const [compareMode, setCompareMode] = useState<boolean>(false);
  const [compareLang, setCompareLang] = useState<string>('en');
  const [compareData, setCompareData] = useState<NotificationTemplatePreview | null>(null);
  const [compareLoading, setCompareLoading] = useState(false);
  const [compareError, setCompareError] = useState<string | null>(null);

  const fetchTemplatePreview = useCallback(async (key: string, lang: string) => {
    setPreviewError(null);
    setPreviewLoading(true);
    try {
      const r = await fetch(
        `/api/admin/notification-templates/${encodeURIComponent(key)}/preview?lang=${encodeURIComponent(lang)}`,
        { credentials: 'include' },
      );
      if (r.status === 404) {
        setPreviewError('This notification key is no longer registered with the dispatcher.');
        setPreviewData(null);
        return;
      }
      if (!r.ok) {
        setPreviewError(`Could not load preview (HTTP ${r.status}).`);
        setPreviewData(null);
        return;
      }
      const data = (await r.json()) as NotificationTemplatePreview;
      setPreviewData(data);
      // Echo the resolved language so the picker reflects fallback
      // behaviour (e.g. an unknown lang collapses to "en" server-side).
      if (data.lang) setPreviewLang(data.lang);
    } catch {
      setPreviewError('Could not load preview. Please try again.');
      setPreviewData(null);
    } finally {
      setPreviewLoading(false);
    }
  }, []);

  // Task #2050 — companion fetcher for the comparison pane. Hits the
  // same `/preview?lang=` endpoint so the two panes use the identical
  // branded renderer; only the language differs.
  const fetchCompareTemplatePreview = useCallback(async (key: string, lang: string) => {
    setCompareError(null);
    setCompareLoading(true);
    try {
      const r = await fetch(
        `/api/admin/notification-templates/${encodeURIComponent(key)}/preview?lang=${encodeURIComponent(lang)}`,
        { credentials: 'include' },
      );
      if (r.status === 404) {
        setCompareError('This notification key is no longer registered with the dispatcher.');
        setCompareData(null);
        return;
      }
      if (!r.ok) {
        setCompareError(`Could not load preview (HTTP ${r.status}).`);
        setCompareData(null);
        return;
      }
      const data = (await r.json()) as NotificationTemplatePreview;
      setCompareData(data);
      if (data.lang) setCompareLang(data.lang);
    } catch {
      setCompareError('Could not load preview. Please try again.');
      setCompareData(null);
    } finally {
      setCompareLoading(false);
    }
  }, []);

  const openTemplatePreview = useCallback(async (key: string) => {
    setPreviewKey(key);
    setPreviewData(null);
    // Reset comparison state so opening a new template doesn't carry
    // over a stale comparison render from the previous one.
    setCompareMode(false);
    setCompareData(null);
    setCompareError(null);
    setCompareLoading(false);
    // Default the picker to the admin's own preferred language. Falls
    // back to English when the user hasn't set one or when it isn't in
    // SUPPORTED_LANGUAGES (the same list the API supports).
    const userLang = (user?.preferredLanguage ?? 'en').toLowerCase();
    const initialLang = SUPPORTED_LANGUAGES.some((l) => l.code === userLang) ? userLang : 'en';
    setPreviewLang(initialLang);
    await fetchTemplatePreview(key, initialLang);
  }, [fetchTemplatePreview, user?.preferredLanguage]);

  const onPreviewLangChange = useCallback(async (lang: string) => {
    setPreviewLang(lang);
    if (previewKey) await fetchTemplatePreview(previewKey, lang);
  }, [fetchTemplatePreview, previewKey]);

  const onCompareLangChange = useCallback(async (lang: string) => {
    setCompareLang(lang);
    if (previewKey) await fetchCompareTemplatePreview(previewKey, lang);
  }, [fetchCompareTemplatePreview, previewKey]);

  // Toggle the comparison pane on/off. When turning it on for the
  // first time we pick a sensible default — English if the primary
  // pane isn't already English, otherwise the first non-English
  // language the template supports. Turning it off clears the pane
  // state so we don't keep a stale render around.
  const toggleCompareMode = useCallback(async () => {
    if (compareMode) {
      setCompareMode(false);
      setCompareData(null);
      setCompareError(null);
      setCompareLoading(false);
      return;
    }
    if (!previewKey || !previewData) return;
    const available = previewData.availableLanguages ?? [];
    const fallbackOrder = ['en', 'de', 'es', 'fr', 'ja'];
    let initial = compareLang;
    if (initial === previewLang || !available.includes(initial)) {
      initial = fallbackOrder.find((c) => c !== previewLang && available.includes(c))
        ?? available.find((c) => c !== previewLang)
        ?? available[0]
        ?? 'en';
    }
    setCompareMode(true);
    setCompareLang(initial);
    await fetchCompareTemplatePreview(previewKey, initial);
  }, [compareMode, compareLang, previewKey, previewData, previewLang, fetchCompareTemplatePreview]);

  // Task #2023 — "Send test to me" action inside the preview dialog.
  // POSTs to `POST /api/admin/notification-templates/:key/send-test`
  // which dispatches the rendered template only to the calling admin
  // via the key's `defaultChannels`, audited with `reason: "admin-test"`
  // so the test send doesn't pollute real-delivery analytics.
  const [previewSending, setPreviewSending] = useState(false);
  const sendTestTemplate = useCallback(async () => {
    if (!previewKey) return;
    setPreviewSending(true);
    try {
      const r = await fetch(
        `/api/admin/notification-templates/${encodeURIComponent(previewKey)}/send-test?lang=${encodeURIComponent(previewLang)}`,
        { method: 'POST', credentials: 'include' },
      );
      if (!r.ok) {
        toast({
          title: 'Test send failed',
          description: `Server responded with HTTP ${r.status}.`,
          variant: 'destructive',
        });
        return;
      }
      const data = (await r.json()) as {
        ok?: boolean;
        channels?: { channel: string; status: 'sent' | 'failed' | 'skipped'; reason?: string }[];
      };
      const channels = data.channels ?? [];
      const sent = channels.filter(c => c.status === 'sent').map(c => c.channel);
      const failed = channels.filter(c => c.status === 'failed').map(c => c.channel);
      const skipped = channels.filter(c => c.status === 'skipped').map(c => c.channel);
      // Build a one-line summary so the admin can see at a glance
      // which channels actually delivered. We list each bucket
      // separately rather than just "delivered" so a partial success
      // (e.g. email sent but push had no device tokens) is obvious.
      const parts: string[] = [];
      if (sent.length > 0) parts.push(`Delivered: ${sent.join(', ')}`);
      if (failed.length > 0) parts.push(`Failed: ${failed.join(', ')}`);
      if (skipped.length > 0) parts.push(`Skipped: ${skipped.join(', ')}`);
      const description = parts.length > 0 ? parts.join(' · ') : 'No channels were attempted.';
      toast({
        title: failed.length > 0 ? 'Test send had failures' : 'Test send dispatched',
        description,
        variant: failed.length > 0 ? 'destructive' : 'default',
      });
    } catch {
      toast({
        title: 'Test send failed',
        description: 'Could not reach the server. Please try again.',
        variant: 'destructive',
      });
    } finally {
      setPreviewSending(false);
    }
  }, [previewKey, previewLang, toast]);

  // Latest wellness-sweep result (Whoop / Google Fit token health). Surfaces
  // when many player tokens have flipped to needs_reauth — usually a provider
  // credential rotation — so admins can act before players complain.
  interface WellnessSweepStatus {
    lastSweep: {
      attempted: number;
      succeeded: number;
      needsReauth: number;
      ranAt: string;
      alerted: boolean;
    } | null;
  }
  const { data: wellnessSweep } = useQuery<WellnessSweepStatus>({
    queryKey: ['/api/admin/wellness-sweep-status'],
    queryFn: () => fetch('/api/admin/wellness-sweep-status').then(r => { if (!r.ok) throw new Error('Request failed'); return r.json(); }),
    staleTime: 60000,
    refetchInterval: 5 * 60 * 1000,
  });

  // Task #991 — short trend (last ~30 days) of wellness-sweep runs so admins
  // can spot a slow drift in needs_reauth (e.g. tokens silently expiring)
  // before the absolute-count alert trips. Endpoint added in task #849.
  interface WellnessSweepRun {
    attempted: number;
    succeeded: number;
    needsReauth: number;
    ranAt: string;
    alerted: boolean;
  }
  interface WellnessSweepHistoryResponse {
    days: number;
    runs: WellnessSweepRun[];
  }
  // Task #1150 — let admins switch the chart between a 7 / 30 / 90 day
  // window. Persisted in localStorage so the choice survives page reloads.
  const WELLNESS_WINDOW_STORAGE_KEY = 'admin.wellnessSweepHistory.windowDays';
  const WELLNESS_WINDOW_OPTIONS = [7, 30, 90] as const;
  type WellnessWindowDays = typeof WELLNESS_WINDOW_OPTIONS[number];
  const [wellnessWindowDays, setWellnessWindowDays] = useState<WellnessWindowDays>(() => {
    if (typeof window === 'undefined') return 30;
    const raw = window.localStorage.getItem(WELLNESS_WINDOW_STORAGE_KEY);
    const parsed = raw ? Number(raw) : NaN;
    return (WELLNESS_WINDOW_OPTIONS as readonly number[]).includes(parsed)
      ? (parsed as WellnessWindowDays)
      : 30;
  });
  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(WELLNESS_WINDOW_STORAGE_KEY, String(wellnessWindowDays));
  }, [wellnessWindowDays]);
  const { data: wellnessSweepHistory } = useQuery<WellnessSweepHistoryResponse>({
    queryKey: [`/api/admin/wellness-sweep-history?days=${wellnessWindowDays}`],
    queryFn: () => fetch(`/api/admin/wellness-sweep-history?days=${wellnessWindowDays}`).then(r => { if (!r.ok) throw new Error('Request failed'); return r.json(); }),
    staleTime: 60000,
    refetchInterval: 5 * 60 * 1000,
  });

  // Task #1324 — week-over-week needs_reauth drift snapshot. Same data the
  // cron evaluator (Task #1151) uses to send drift emails, surfaced here so
  // admins can see "this week vs last week" at a glance instead of waiting
  // for an email to arrive.
  interface WeeklyReauthDriftSnapshot {
    evaluatedAt: string;
    windowDays: number;
    rateLimitDays: number;
    thisWeek: { runs: number; averageNeedsReauth: number; totalNeedsReauth: number };
    lastWeek: { runs: number; averageNeedsReauth: number; totalNeedsReauth: number };
    delta: number;
    threshold: number;
    minRuns: number;
    hasSufficientData: boolean;
    exceedsThreshold: boolean;
    org: {
      id: number;
      name: string | null;
      lastSentAt: string | null;
      nextEligibleAt: string | null;
      lastAcknowledgment: {
        acknowledgedAt: string;
        acknowledgedByName: string | null;
        acknowledgedByRole: string | null;
        snoozeDays: number;
      } | null;
      // Task #1970 — runaway-snooze guard. Server counts Acknowledge clicks
      // in the trailing 30 days and refuses (HTTP 429) once the cap is
      // reached so the same admin can't silence a legitimate drift forever.
      // Both fields surface here so the tile can render the red banner +
      // disable the button without hard-coding the cap on the client.
      snoozeCountLast30d: number;
      maxSnoozesPer30d: number;
    } | null;
  }
  const { data: reauthWowDrift } = useQuery<WeeklyReauthDriftSnapshot>({
    queryKey: ['/api/admin/wellness-reauth-wow-drift'],
    queryFn: () => fetch('/api/admin/wellness-reauth-wow-drift').then(r => { if (!r.ok) throw new Error('Request failed'); return r.json(); }),
    staleTime: 60000,
    refetchInterval: 5 * 60 * 1000,
  });

  // Task #1577 — N-week trend of average needs_reauth so admins can tell at
  // a glance whether a spike is a one-off blip or a persistent climb. Mirrors
  // the same threshold the WoW drift tile uses; rendered as a small bar
  // chart with a threshold reference line underneath the tile.
  interface WeeklyReauthDriftHistoryBucket {
    weekStart: string;
    weekEnd: string;
    runs: number;
    averageNeedsReauth: number;
    totalNeedsReauth: number;
    hasSufficientData: boolean;
  }
  interface WeeklyReauthDriftHistoryResult {
    evaluatedAt: string;
    windowDays: number;
    weeks: number;
    threshold: number;
    minRuns: number;
    buckets: WeeklyReauthDriftHistoryBucket[];
  }
  // Task #1966 — let admins switch the trend chart between a 4 / 8 / 12 week
  // window. Mirrors the 7/30/90d toggle on the sweep history chart above.
  // Persisted in localStorage so the choice survives page reloads.
  const REAUTH_DRIFT_WEEKS_STORAGE_KEY = 'admin.wellnessReauthWowDriftHistory.weeks';
  const REAUTH_DRIFT_WEEKS_OPTIONS = [4, 8, 12] as const;
  type ReauthDriftWeeks = typeof REAUTH_DRIFT_WEEKS_OPTIONS[number];
  const [reauthDriftWeeks, setReauthDriftWeeks] = useState<ReauthDriftWeeks>(() => {
    if (typeof window === 'undefined') return 8;
    const raw = window.localStorage.getItem(REAUTH_DRIFT_WEEKS_STORAGE_KEY);
    const parsed = raw ? Number(raw) : NaN;
    return (REAUTH_DRIFT_WEEKS_OPTIONS as readonly number[]).includes(parsed)
      ? (parsed as ReauthDriftWeeks)
      : 8;
  });
  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(REAUTH_DRIFT_WEEKS_STORAGE_KEY, String(reauthDriftWeeks));
  }, [reauthDriftWeeks]);
  const { data: reauthWowDriftHistory } = useQuery<WeeklyReauthDriftHistoryResult>({
    queryKey: [`/api/admin/wellness-reauth-wow-drift-history?weeks=${reauthDriftWeeks}`],
    queryFn: () => fetch(`/api/admin/wellness-reauth-wow-drift-history?weeks=${reauthDriftWeeks}`).then(r => { if (!r.ok) throw new Error('Request failed'); return r.json(); }),
    staleTime: 60000,
    refetchInterval: 5 * 60 * 1000,
  });

  // Task #1578 — Acknowledge / snooze the WoW drift alert. Bumps the
  // per-org watermark forward by N days so the cron evaluator skips its
  // next email and the dashboard tile re-renders without the orange badge.
  const [reauthWowAckDays, setReauthWowAckDays] = useState<string>('7');
  const [reauthWowAckSaving, setReauthWowAckSaving] = useState(false);
  async function acknowledgeWowDrift() {
    const n = Number(reauthWowAckDays);
    if (!Number.isInteger(n) || n < 1 || n > 30) {
      toast({ title: 'Snooze must be 1–30 days', variant: 'destructive' });
      return;
    }
    setReauthWowAckSaving(true);
    try {
      const r = await fetch('/api/admin/wellness-reauth-wow-drift/acknowledge', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ snoozeDays: n }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({})) as { error?: string };
        toast({ title: body.error ?? 'Failed to acknowledge drift alert', variant: 'destructive' });
        return;
      }
      toast({ title: `Drift alert snoozed for ${n} day${n === 1 ? '' : 's'}` });
      await queryClient.invalidateQueries({ queryKey: ['/api/admin/wellness-reauth-wow-drift'] });
      // The newly-inserted audit row is now the freshest entry — make sure
      // the disclosure picks it up the next time it's expanded.
      await queryClient.invalidateQueries({ queryKey: ['/api/admin/wellness-reauth-wow-drift/history'] });
    } catch {
      toast({ title: 'Failed to acknowledge drift alert', variant: 'destructive' });
    } finally {
      setReauthWowAckSaving(false);
    }
  }

  // Task #1969 — Full snooze history disclosure underneath the
  // "Acknowledged by …" line. Lazy-loaded the first time the disclosure
  // is opened so the tile's initial render doesn't pay for a query the
  // admin probably never expands.
  interface WeeklyReauthDriftAcknowledgmentEntry {
    acknowledgedAt: string;
    acknowledgedByName: string | null;
    acknowledgedByRole: string | null;
    snoozeDays: number;
  }
  interface WeeklyReauthDriftAcknowledgmentHistoryResult {
    evaluatedAt: string;
    organizationId: number;
    limit: number;
    entries: WeeklyReauthDriftAcknowledgmentEntry[];
  }
  const [reauthWowHistoryOpen, setReauthWowHistoryOpen] = useState(false);
  const { data: reauthWowAckHistory, isLoading: reauthWowAckHistoryLoading } =
    useQuery<WeeklyReauthDriftAcknowledgmentHistoryResult>({
      queryKey: ['/api/admin/wellness-reauth-wow-drift/history'],
      queryFn: () => fetch('/api/admin/wellness-reauth-wow-drift/history').then(r => {
        if (!r.ok) throw new Error('Request failed');
        return r.json();
      }),
      enabled: reauthWowHistoryOpen,
      staleTime: 60000,
    });

  // Task #850 — Per-org thresholds for the wearable needs_reauth alert.
  // Larger clubs may want a higher absolute floor; smaller clubs may want
  // to be alerted on any flip. Defaults match the legacy hardcoded values.
  // Task #1325 / #1579 — also exposes the per-org override for the
  // weekly week-over-week drift threshold (`wowMinDelta`). The API
  // returns `null` when the org is inheriting the system-wide default,
  // and the resolved fallback under `defaults.wowMinDelta`.
  interface ReauthAlertSettingsResponse {
    orgId: number | null;
    settings: {
      minCount: number;
      minSharePct: number;
      minAttempted: number;
      wowMinDelta: number | null;
      wowMinDeltaEffective?: number;
      email: string | null;
    };
    defaults: {
      minCount: number;
      minSharePct: number;
      minAttempted: number;
      wowMinDelta: number;
      fallbackEmail: string | null;
    };
  }
  const { data: reauthAlertSettings } = useQuery<ReauthAlertSettingsResponse>({
    queryKey: ['/api/admin/wearable-reauth-alert-settings'],
    queryFn: () => fetch('/api/admin/wearable-reauth-alert-settings').then(r => { if (!r.ok) throw new Error('Request failed'); return r.json(); }),
    staleTime: 60000,
  });
  const [reauthAlertForm, setReauthAlertForm] = useState<{
    minCount: string; minSharePct: string; minAttempted: string; wowMinDelta: string; email: string;
  }>({ minCount: '', minSharePct: '', minAttempted: '', wowMinDelta: '', email: '' });
  const [reauthAlertSaving, setReauthAlertSaving] = useState(false);
  // Task #1579 — surface the API's 400 validation error inline so admins
  // editing the WoW threshold see the exact reason their input was rejected
  // (e.g. "wowMinDelta must be a positive number ≤ 9999.99…") without
  // hunting through the toast log.
  const [reauthAlertError, setReauthAlertError] = useState<string | null>(null);
  useEffect(() => {
    if (!reauthAlertSettings) return;
    setReauthAlertForm({
      minCount: String(reauthAlertSettings.settings.minCount),
      minSharePct: String(reauthAlertSettings.settings.minSharePct),
      minAttempted: String(reauthAlertSettings.settings.minAttempted),
      // null override = inherit the system default; show as a blank input
      // so the placeholder communicates "inheriting <default>".
      wowMinDelta: reauthAlertSettings.settings.wowMinDelta == null
        ? ''
        : reauthAlertSettings.settings.wowMinDelta.toFixed(2),
      email: reauthAlertSettings.settings.email ?? '',
    });
  }, [reauthAlertSettings]);
  async function saveReauthAlertSettings() {
    setReauthAlertSaving(true);
    setReauthAlertError(null);
    try {
      // Empty WoW input → send `null` so the API clears the override and
      // the org re-inherits the system-wide default. Otherwise parse to a
      // number; the API enforces > 0 and ≤ 9999.99 with 2-decimal rounding.
      const wowTrimmed = reauthAlertForm.wowMinDelta.trim();
      const wowMinDeltaPayload: number | null = wowTrimmed === '' ? null : Number(wowTrimmed);
      const r = await fetch('/api/admin/wearable-reauth-alert-settings', {
        method: 'PUT',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          minCount: Number(reauthAlertForm.minCount),
          minSharePct: Number(reauthAlertForm.minSharePct),
          minAttempted: Number(reauthAlertForm.minAttempted),
          wowMinDelta: wowMinDeltaPayload,
          email: reauthAlertForm.email.trim() === '' ? null : reauthAlertForm.email.trim(),
        }),
      });
      const data = await r.json();
      if (!r.ok) {
        const errMsg = data?.error ?? `HTTP ${r.status}`;
        setReauthAlertError(errMsg);
        toast({ title: 'Could not save', description: errMsg, variant: 'destructive' });
        return;
      }
      toast({ title: 'Saved', description: 'Wearable re-auth alert settings updated.' });
      await queryClient.invalidateQueries({ queryKey: ['/api/admin/wearable-reauth-alert-settings'] });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setReauthAlertError(msg);
      toast({ title: 'Could not save', description: msg, variant: 'destructive' });
    } finally {
      setReauthAlertSaving(false);
    }
  }

  const stripeStatus = channelStatus?.payments?.stripe;
  const showStripeWebhookWarning = !!stripeStatus?.warning;

  // Task #974 — last 10 real Stripe webhook deliveries. Lets admins see at a
  // glance whether Stripe has actually been delivering events lately, what
  // HTTP status we returned, and whether each event was applied.
  interface StripeWebhookDelivery {
    id: number;
    eventId: string | null;
    eventType: string | null;
    receivedAt: string;
    sourceIp: string | null;
    signatureValid: boolean | null;
    applied: boolean;
    responseStatus: number;
    // Task #1126 — short reason captured when responseStatus is non-2xx so
    // the table can show admins *why* (signature_mismatch, missing_header,
    // missing_secret, missing_body, reconciliation_failed). Null for 2xx.
    errorReason: string | null;
  }
  // Friendly labels for the machine-readable error reasons surfaced in the
  // "Recent webhook deliveries" table. Falls back to the raw value if a new
  // reason is added on the server but not yet listed here.
  const STRIPE_WEBHOOK_ERROR_REASON_LABELS: Record<string, string> = {
    signature_mismatch: 'Signature mismatch — the value of STRIPE_WEBHOOK_SECRET on this server does not match the secret in your Stripe dashboard.',
    missing_header: 'Missing stripe-signature header — the request reached the endpoint without a signature, so it cannot have been sent by Stripe.',
    missing_secret: 'STRIPE_WEBHOOK_SECRET is not configured on this server, so signed events are being rejected.',
    missing_body: 'Raw request body unavailable — signature could not be verified. Usually a reverse-proxy or middleware issue.',
    reconciliation_failed: 'The signed event was accepted but applying it to the database threw an error. Stripe will retry; check API logs for the stack trace.',
  };
  // Task #1295 — let admins narrow the deliveries table to only failed (non-2xx
  // or signature-invalid) rows when investigating after a secret rotation.
  // Task #1535 — persist the choice across refreshes and make it shareable by
  // mirroring it into a `?webhookFilter=failures` query-string parameter. The
  // initial value is read from the URL (so a refresh / shared link reproduces
  // the view), defaulting to 'all' for first-time visitors.
  const [stripeDeliveriesFilter, setStripeDeliveriesFilter] = useState<'all' | 'failures'>(() => {
    if (typeof window === 'undefined') return 'all';
    const fromUrl = new URLSearchParams(window.location.search).get('webhookFilter');
    return fromUrl === 'failures' ? 'failures' : 'all';
  });
  // Mirror the chosen filter into the URL so a refresh or shared link
  // reproduces the same view. Use `replaceState` (not navigate) to avoid
  // spamming wouter's history every time the admin toggles the filter, and
  // omit the parameter entirely when the filter is back on the default to
  // keep the URL clean.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const sp = new URLSearchParams(window.location.search);
    if (stripeDeliveriesFilter === 'failures') {
      sp.set('webhookFilter', 'failures');
    } else {
      sp.delete('webhookFilter');
    }
    const qs = sp.toString();
    const newUrl = `${window.location.pathname}${qs ? `?${qs}` : ''}${window.location.hash}`;
    const currentUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (newUrl !== currentUrl) {
      window.history.replaceState(window.history.state, '', newUrl);
    }
  }, [stripeDeliveriesFilter]);
  const stripeDeliveriesUrl = stripeDeliveriesFilter === 'failures'
    ? '/api/admin/stripe-webhook-deliveries?status=failures'
    : '/api/admin/stripe-webhook-deliveries';
  const { data: stripeDeliveries, refetch: refetchStripeDeliveries, isFetching: stripeDeliveriesFetching } = useQuery<{ deliveries: StripeWebhookDelivery[]; failureCount?: number; failureCountByReason?: Record<string, number> }>({
    queryKey: ['/api/admin/stripe-webhook-deliveries', stripeDeliveriesFilter],
    queryFn: () => fetch(stripeDeliveriesUrl).then(r => { if (!r.ok) throw new Error('Request failed'); return r.json(); }),
    staleTime: 30000,
    refetchInterval: 60 * 1000,
    enabled: !!stripeStatus?.usesStripe,
  });
  // Task #1534 — small badge on the "Failures only" toggle so admins can see
  // at a glance how many failed deliveries exist in the recent window
  // without having to flip the toggle. `failureCount` is returned by the
  // endpoint regardless of which filter is active, so the badge stays
  // accurate when the admin is viewing "All" too.
  const stripeDeliveriesFailureCount = stripeDeliveries?.failureCount ?? 0;
  // Task #1897 — highlight the failures badge when fresh failures have
  // arrived between refetches. We track the count the admin has already
  // "seen" (acknowledged by clicking either filter button or hovering the
  // badge); when the live count exceeds that baseline we render a subtle
  // pulse and a "+N new" indicator so on-call admins notice without
  // having to remember the previous number. `lastSeen` stays `null` until
  // the first response lands so the initial render never flashes.
  // Decreases or steady counts silently re-baseline lastSeen so we never
  // show a stale "+N new" once the situation has improved.
  const [stripeDeliveriesLastSeenFailureCount, setStripeDeliveriesLastSeenFailureCount] =
    useState<number | null>(null);
  useEffect(() => {
    if (stripeDeliveries === undefined) return;
    setStripeDeliveriesLastSeenFailureCount(prev => {
      if (prev === null) return stripeDeliveriesFailureCount;
      if (stripeDeliveriesFailureCount <= prev) return stripeDeliveriesFailureCount;
      return prev;
    });
  }, [stripeDeliveriesFailureCount, stripeDeliveries]);
  const stripeDeliveriesNewFailuresSinceLastLook =
    stripeDeliveriesLastSeenFailureCount === null
      ? 0
      : Math.max(0, stripeDeliveriesFailureCount - stripeDeliveriesLastSeenFailureCount);
  const acknowledgeStripeDeliveriesFailures = useCallback(() => {
    setStripeDeliveriesLastSeenFailureCount(stripeDeliveriesFailureCount);
  }, [stripeDeliveriesFailureCount]);
  // Task #1898 — turn the raw failure-by-reason map into a stable, sorted
  // list (most common reason first, ties broken alphabetically so the
  // order is deterministic between refetches). Drives both the hover
  // tooltip on the badge and the small inline summary that appears
  // above the deliveries table when failures exist.
  const stripeDeliveriesFailureByReason = useMemo(() => {
    const map = stripeDeliveries?.failureCountByReason ?? {};
    return Object.entries(map)
      .filter(([, n]) => n > 0)
      .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
      .map(([reason, n]) => ({ reason, count: n }));
  }, [stripeDeliveries?.failureCountByReason]);
  // Plain-text breakdown used for the badge's hover tooltip, e.g.
  // "2 signature_mismatch, 1 reconciliation_failed". Empty string when
  // there's nothing to investigate so the underlying `<span>`'s `title`
  // attribute stays out of the way.
  const stripeDeliveriesFailureBreakdownText = stripeDeliveriesFailureByReason
    .map(e => `${e.count} ${e.reason}`)
    .join(', ');

  // Task #1294 — Last result of the daily `stripe_webhook_deliveries` retention
  // sweep (Task #1125). Shown next to the "Recent webhook deliveries" table so
  // admins can see when the table was last pruned and how many rows it removed,
  // without having to dig through server logs. Returns `null` until the first
  // sweep has run after deploy.
  interface StripeWebhookSweepStatus {
    ranAt: string;
    removed: number;
  }
  // Task #1295 — `stale` is computed server-side (~36h since last run, or
  // since process start when no run has ever been recorded) so the admin
  // tile can render a warning badge when the daily cron has gone silent.
  const { data: stripeSweepStatus } = useQuery<{ lastSweep: StripeWebhookSweepStatus | null; stale: boolean }>({
    queryKey: ['/api/admin/stripe-webhook-sweep-status'],
    queryFn: () => fetch('/api/admin/stripe-webhook-sweep-status').then(r => { if (!r.ok) throw new Error('Request failed'); return r.json(); }),
    // The sweep only runs once a day, so polling once a minute is more than
    // enough; matches the cadence of the deliveries query above.
    staleTime: 60 * 1000,
    refetchInterval: 5 * 60 * 1000,
    enabled: !!stripeStatus?.usesStripe,
  });

  // Task #1525 — Short trend (last ~14 days) of how many old rows the daily
  // stripe-webhook retention sweep removed each day. Rendered as a small
  // inline list next to the "Retention sweep last ran …" line so admins can
  // spot a sudden spike in inbound webhook traffic, or a stretch where the
  // sweep hasn't been firing, without grepping server logs.
  interface StripeWebhookSweepHistoryEntry {
    ranAt: string;
    removed: number;
  }
  interface StripeWebhookSweepHistoryResponse {
    days: number;
    runs: StripeWebhookSweepHistoryEntry[];
  }
  // Task #1879 — let admins switch the trend window between 7 / 14 / 30 / 90
  // days, mirroring the wellness-sweep chart toggle above. Persisted in
  // localStorage so the choice survives page reloads. The history endpoint
  // already accepts `?days=` up to 90.
  const STRIPE_SWEEP_WINDOW_STORAGE_KEY = 'admin.stripeWebhookSweepHistory.windowDays';
  const STRIPE_SWEEP_WINDOW_OPTIONS = [7, 14, 30, 90] as const;
  type StripeSweepWindowDays = typeof STRIPE_SWEEP_WINDOW_OPTIONS[number];
  const [stripeSweepWindowDays, setStripeSweepWindowDays] = useState<StripeSweepWindowDays>(() => {
    if (typeof window === 'undefined') return 14;
    const raw = window.localStorage.getItem(STRIPE_SWEEP_WINDOW_STORAGE_KEY);
    const parsed = raw ? Number(raw) : NaN;
    return (STRIPE_SWEEP_WINDOW_OPTIONS as readonly number[]).includes(parsed)
      ? (parsed as StripeSweepWindowDays)
      : 14;
  });
  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(STRIPE_SWEEP_WINDOW_STORAGE_KEY, String(stripeSweepWindowDays));
  }, [stripeSweepWindowDays]);
  const { data: stripeSweepHistory } = useQuery<StripeWebhookSweepHistoryResponse>({
    queryKey: [`/api/admin/stripe-webhook-sweep-history?days=${stripeSweepWindowDays}`],
    queryFn: () => fetch(`/api/admin/stripe-webhook-sweep-history?days=${stripeSweepWindowDays}`).then(r => { if (!r.ok) throw new Error('Request failed'); return r.json(); }),
    staleTime: 60 * 1000,
    refetchInterval: 5 * 60 * 1000,
    enabled: !!stripeStatus?.usesStripe,
  });

  // Task #1705 — Recent failed swing-video fps probes. Surfaces the rows the
  // worker has given up on after MAX_FPS_PROBE_ATTEMPTS so admins can see
  // persistent ingest failures (corrupt object, unreachable storage, etc.)
  // and either re-enqueue a fresh probe or dismiss the row.
  interface SwingFpsProbeFailure {
    id: number;
    swingVideoId: number;
    objectPath: string;
    attempts: number;
    errorMessage: string | null;
    errorMessagePreview: string | null;
    completedAt: string | null;
    updatedAt: string | null;
  }
  interface SwingFpsProbeFailuresResponse {
    failures: SwingFpsProbeFailure[];
    failureCount: number;
  }
  const {
    data: fpsProbeFailures,
    refetch: refetchFpsProbeFailures,
    isFetching: fpsProbeFailuresFetching,
  } = useQuery<SwingFpsProbeFailuresResponse>({
    queryKey: ['/api/admin/swing-fps-probe-failures'],
    queryFn: () => fetch('/api/admin/swing-fps-probe-failures')
      .then(r => { if (!r.ok) throw new Error('Request failed'); return r.json(); }),
    staleTime: 30 * 1000,
    refetchInterval: 60 * 1000,
  });
  const [fpsProbeActioningId, setFpsProbeActioningId] = useState<number | null>(null);
  // Task #2127 — minimum age (in whole days) to display in the failures
  // table. 0 means "show all"; the other presets let an admin focus on
  // chronic ingest problems by hiding rows from the last N days. The
  // server returns the most recent N rows so the filter is applied
  // client-side over the same dataset.
  const [fpsProbeMinAgeDays, setFpsProbeMinAgeDays] = useState<number>(0);
  const FPS_PROBE_AGE_FILTER_OPTIONS: Array<{ value: number; label: string }> = [
    { value: 0, label: 'All' },
    { value: 1, label: '> 1 day' },
    { value: 7, label: '> 7 days' },
    { value: 30, label: '> 30 days' },
  ];
  // Rows older than this are visually emphasised (red highlight) so they
  // pop out of a long list of recent blips. Matches the threshold called
  // out in Task #2127's "done looks like" example.
  const FPS_PROBE_OLD_ROW_DAYS = 7;
  const fpsProbeFilteredFailures = useMemo(() => {
    const all = fpsProbeFailures?.failures ?? [];
    if (fpsProbeMinAgeDays <= 0) return all;
    const cutoffMs = Date.now() - fpsProbeMinAgeDays * 86_400_000;
    return all.filter(p => {
      if (!p.completedAt) return false;
      const t = new Date(p.completedAt).getTime();
      return Number.isFinite(t) && t <= cutoffMs;
    });
  }, [fpsProbeFailures, fpsProbeMinAgeDays]);
  async function actOnFpsProbeFailure(probeId: number, action: 'reenqueue' | 'dismiss') {
    setFpsProbeActioningId(probeId);
    try {
      const r = await fetch(
        `/api/admin/swing-fps-probe-failures/${probeId}/${action}`,
        { method: 'POST', credentials: 'include' },
      );
      if (!r.ok) {
        let msg = `Request failed (HTTP ${r.status})`;
        try {
          const body = await r.json() as { error?: string };
          if (body?.error) msg = body.error;
        } catch { /* keep default */ }
        throw new Error(msg);
      }
      toast({
        title: action === 'reenqueue' ? 'Probe re-enqueued' : 'Probe dismissed',
        description: action === 'reenqueue'
          ? 'A fresh probe has been queued for this swing video.'
          : 'The failed row has been removed from the list.',
      });
      await refetchFpsProbeFailures();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast({
        title: action === 'reenqueue' ? 'Re-enqueue failed' : 'Dismiss failed',
        description: msg,
        variant: 'destructive',
      });
    } finally {
      setFpsProbeActioningId(null);
    }
  }

  // Inline result of the "Send test event" Stripe webhook probe (Task #829).
  interface StripeTestResult {
    ok: boolean;
    stage: 'config' | 'delivered' | 'signature_mismatch' | 'endpoint_error' | 'unreachable';
    httpStatus?: number;
    durationMs?: number;
    endpoint?: string;
    usedPublicUrl?: boolean;
    eventId?: string;
    error?: string;
    response?: unknown;
  }
  const [stripeTesting, setStripeTesting] = useState(false);
  const [stripeTestResult, setStripeTestResult] = useState<StripeTestResult | null>(null);
  async function sendStripeTestEvent() {
    setStripeTesting(true);
    setStripeTestResult(null);
    try {
      const r = await fetch('/api/admin/test-stripe-webhook', {
        method: 'POST',
        credentials: 'include',
      });
      const data = (await r.json()) as StripeTestResult;
      setStripeTestResult(data);
      if (data.ok) {
        toast({ title: 'Webhook delivered', description: `Round-trip ${data.durationMs ?? '?'}ms` });
      } else {
        toast({
          title: 'Webhook test failed',
          description: data.error ?? `Stage: ${data.stage}`,
          variant: 'destructive',
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setStripeTestResult({ ok: false, stage: 'unreachable', error: msg });
      toast({ title: 'Webhook test failed', description: msg, variant: 'destructive' });
    } finally {
      setStripeTesting(false);
    }
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-5xl mx-auto p-8 space-y-6">
        {/* Header */}
        <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }}>
          <div className="flex items-center gap-3 mb-1">
            <Settings className="w-6 h-6 text-primary" />
            <h1 className="text-2xl font-display font-bold text-white tracking-tight">{t('admin:settings')}</h1>
          </div>
          <p className="text-muted-foreground text-sm">{t('admin:settingsDesc')}</p>
        </motion.div>

        {showStripeWebhookWarning && (
          <div
            data-testid="banner-stripe-webhook-warning"
            className="rounded-xl border border-orange-500/40 bg-orange-500/10 p-4 flex items-start gap-3"
          >
            <AlertTriangle className="w-5 h-5 text-orange-400 mt-0.5 flex-shrink-0" />
            <div className="flex-1 min-w-0 space-y-1">
              <p className="text-sm font-semibold text-orange-200">
                Stripe webhook secret is not configured
              </p>
              <p className="text-xs text-orange-100/80 leading-relaxed">
                Your club bills in {stripeStatus?.baseCurrency ?? 'a non-INR currency'} and uses Stripe for checkout, but
                <code className="mx-1 px-1.5 py-0.5 rounded bg-black/40 font-mono text-[11px]">STRIPE_WEBHOOK_SECRET</code>
                is not set on the API server. Payment confirmations will not reconcile automatically until this is fixed.
                {stripeStatus?.setupInstructions ? ` ${stripeStatus.setupInstructions}` : ''}
              </p>
              <button
                onClick={() => setActiveSection('channels')}
                className="text-xs text-orange-200 underline-offset-2 hover:underline"
              >
                Open communication & payment status →
              </button>
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
          {/* Sidebar nav */}
          <div className="space-y-1">
            {sections.map(s => (
              <button key={s.id} onClick={() => setActiveSection(s.id)}
                className={`w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-left text-sm transition-all
                  ${activeSection === s.id ? 'bg-primary/10 text-primary font-semibold border border-primary/20' : 'text-muted-foreground hover:bg-white/5 hover:text-foreground'}`}>
                <s.icon className="w-4 h-4 flex-shrink-0" />
                {s.label}
                {activeSection === s.id && <ChevronRight className="w-3.5 h-3.5 ml-auto opacity-50" />}
              </button>
            ))}
          </div>

          {/* Content */}
          <div className="md:col-span-3 space-y-4">
            {activeSection === 'profile' && (
              <Card className="glass-card">
                <CardHeader><CardTitle className="text-white flex items-center gap-2"><Building2 className="w-5 h-5 text-primary" /> {t('admin:sections.clubProfile')}</CardTitle></CardHeader>
                <CardContent className="space-y-4">
                  <div>
                    <label className="text-xs text-muted-foreground uppercase tracking-wider">{t('admin:clubName')}</label>
                    <Input value={profile.name} onChange={e => setProfile(p => ({ ...p, name: e.target.value }))} className="mt-1.5 bg-black/40 border-white/10 text-white" />
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground uppercase tracking-wider">{t('admin:description')}</label>
                    <textarea value={profile.description} onChange={e => setProfile(p => ({ ...p, description: e.target.value }))}
                      rows={3} className="mt-1.5 w-full rounded-lg bg-black/40 border border-white/10 text-white text-sm px-3 py-2 focus:outline-none focus:border-primary/50 resize-none" />
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground uppercase tracking-wider">{t('admin:slugLabel')}</label>
                    <div className="mt-1.5 flex items-center gap-2">
                      <span className="text-muted-foreground text-sm">kharagolf.app/</span>
                      <Input value={org?.slug ?? ''} disabled className="bg-black/20 border-white/5 text-muted-foreground cursor-not-allowed" />
                    </div>
                    <p className="text-xs text-muted-foreground mt-1.5">{t('admin:slugNote')}</p>
                  </div>
                  <Button onClick={saveProfile} disabled={saving} className="bg-primary hover:bg-primary/90 text-white gap-2">
                    {saving ? t('admin:saving') : <><Check className="w-4 h-4" /> {t('admin:saveProfile')}</>}
                  </Button>
                </CardContent>
              </Card>
            )}

            {activeSection === 'contact' && (
              <Card className="glass-card">
                <CardHeader><CardTitle className="text-white flex items-center gap-2"><Phone className="w-5 h-5 text-primary" /> {t('admin:contactHeading')}</CardTitle></CardHeader>
                <CardContent className="space-y-4">
                  <p className="text-muted-foreground text-sm">{t('admin:contactNote')}</p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <label className="text-xs text-muted-foreground uppercase tracking-wider flex items-center gap-1.5 mb-1.5"><Mail className="w-3.5 h-3.5" /> {t('admin:contactEmail')}</label>
                      <Input type="email" value={contact.contactEmail} onChange={e => setContact(c => ({ ...c, contactEmail: e.target.value }))}
                        placeholder="secretary@yourclub.com" className="bg-black/40 border-white/10 text-white" />
                    </div>
                    <div>
                      <label className="text-xs text-muted-foreground uppercase tracking-wider flex items-center gap-1.5 mb-1.5"><Phone className="w-3.5 h-3.5" /> {t('admin:contactPhone')}</label>
                      <Input type="tel" value={contact.contactPhone} onChange={e => setContact(c => ({ ...c, contactPhone: e.target.value }))}
                        placeholder="+91 98765 43210" className="bg-black/40 border-white/10 text-white" />
                    </div>
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground uppercase tracking-wider flex items-center gap-1.5 mb-1.5"><MapPin className="w-3.5 h-3.5" /> {t('admin:clubAddress')}</label>
                    <textarea value={contact.address} onChange={e => setContact(c => ({ ...c, address: e.target.value }))}
                      rows={2} placeholder="123 Fairway Drive, City, State, PIN"
                      className="w-full rounded-lg bg-black/40 border border-white/10 text-white text-sm px-3 py-2 focus:outline-none focus:border-primary/50 resize-none" />
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground uppercase tracking-wider flex items-center gap-1.5 mb-1.5"><ExternalLink className="w-3.5 h-3.5" /> {t('admin:clubWebsite')}</label>
                    <Input type="url" value={contact.website} onChange={e => setContact(c => ({ ...c, website: e.target.value }))}
                      placeholder="https://yourclub.com" className="bg-black/40 border-white/10 text-white" />
                  </div>
                  <Button onClick={saveContact} disabled={saving} className="bg-primary hover:bg-primary/90 text-white gap-2">
                    {saving ? t('admin:saving') : <><Check className="w-4 h-4" /> {t('admin:saveContact')}</>}
                  </Button>
                </CardContent>
              </Card>
            )}

            {activeSection === 'branding' && (
              <Card className="glass-card">
                <CardHeader><CardTitle className="text-white flex items-center gap-2"><Palette className="w-5 h-5 text-primary" /> {t('admin:sections.branding')}</CardTitle></CardHeader>
                <CardContent className="space-y-5">
                  {/* Live preview banner */}
                  <div className="rounded-xl p-4 border border-white/10" style={{ background: `${colorPreview}18` }}>
                    <div className="flex items-center gap-3">
                      {branding.logoUrl ? (
                        <img src={branding.logoUrl} alt="Club logo" className="w-10 h-10 object-contain rounded-lg bg-white/10 p-1" />
                      ) : (
                        <div className="w-10 h-10 rounded-lg flex items-center justify-center" style={{ background: `${colorPreview}40` }}>
                          <span className="font-display font-bold text-white text-sm">{profile.name?.[0] ?? 'C'}</span>
                        </div>
                      )}
                      <div>
                        <p className="font-display font-bold text-white text-base">{profile.name || t('admin:yourClub')}</p>
                        <p className="text-xs uppercase tracking-widest" style={{ color: colorPreview }}>Enterprise</p>
                      </div>
                    </div>
                  </div>

                  <div>
                    <label className="text-xs text-muted-foreground uppercase tracking-wider">{t('admin:clubLogo')}</label>
                    <p className="text-xs text-muted-foreground mt-1 mb-2">{t('admin:logoNote')}</p>
                    {/* File upload — uses signed object storage URL */}
                    <div className="flex gap-2 mb-2">
                      <label className={`flex items-center gap-2 px-3 py-2 rounded-md border border-white/10 text-sm cursor-pointer hover:bg-white/5 transition-colors ${uploadingLogo ? 'opacity-50 pointer-events-none' : ''}`}>
                        <Upload className="w-4 h-4 text-muted-foreground" />
                        <span className="text-muted-foreground">{uploadingLogo ? t('admin:uploading') : t('admin:uploadFile')}</span>
                        <input
                          type="file"
                          accept="image/png,image/jpeg,image/jpg,image/svg+xml,image/webp"
                          className="hidden"
                          onChange={async (e) => {
                            const file = e.target.files?.[0];
                            if (!file || !orgId) return;
                            setUploadingLogo(true);
                            try {
                              const res = await fetch(`/api/organizations/${orgId}/branding/logo-upload-url`, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ contentType: file.type }),
                              });
                              if (!res.ok) throw new Error((await res.json()).error);
                              const { uploadUrl, publicUrl } = await res.json();
                              await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': file.type }, body: file });
                              setBranding(b => ({ ...b, logoUrl: publicUrl }));
                              toast({ title: t('admin:toasts.logoUploaded'), description: t('admin:toasts.logoUploadedDesc') });
                            } catch (err) {
                              toast({ title: t('admin:toasts.uploadFailed'), description: (err as Error).message, variant: 'destructive' });
                            } finally { setUploadingLogo(false); }
                          }}
                        />
                      </label>
                    </div>
                    {/* Manual URL paste — fallback for CDN-hosted logos */}
                    <Input value={branding.logoUrl} onChange={e => setBranding(b => ({ ...b, logoUrl: e.target.value }))}
                      placeholder="https://your-cdn.com/club-logo.png" className="bg-black/40 border-white/10 text-white" />
                  </div>

                  <div>
                    <label className="text-xs text-muted-foreground uppercase tracking-wider">{t('admin:primaryBrandColour')}</label>
                    <p className="text-xs text-muted-foreground mt-1 mb-2">{t('admin:brandColourDesc')}</p>
                    <div className="flex items-center gap-3">
                      <input type="color" value={branding.primaryColor}
                        onChange={e => { setBranding(b => ({ ...b, primaryColor: e.target.value })); setColorPreview(e.target.value); }}
                        className="w-10 h-10 rounded-lg cursor-pointer border border-white/10 bg-transparent" />
                      <Input value={branding.primaryColor} onChange={e => { setBranding(b => ({ ...b, primaryColor: e.target.value })); setColorPreview(e.target.value); }}
                        placeholder="#1e4d2b" className="bg-black/40 border-white/10 text-white w-40 font-mono" maxLength={7} />
                      <div className="w-8 h-8 rounded-lg border border-white/10 flex-shrink-0" style={{ background: colorPreview }} />
                    </div>
                  </div>

                  <Button onClick={saveBranding} disabled={saving} className="gap-2" style={{ background: colorPreview }}>
                    {saving ? t('admin:saving') : <><Check className="w-4 h-4" /> {t('admin:applyBranding')}</>}
                  </Button>
                </CardContent>
              </Card>
            )}

            {activeSection === 'rules' && (
              <Card className="glass-card">
                <CardHeader>
                  <CardTitle className="text-white flex items-center gap-2">
                    <BookOpen className="w-5 h-5 text-primary" /> {t('admin:sections.rulesAssistant')}
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-6">
                  <p className="text-muted-foreground text-sm">{t('admin:rulesAssistantDesc')}</p>

                  <div className="space-y-3">
                    <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                      {t('admin:rulesGoverningBody')}
                    </label>
                    <Select value={rulesGoverningBody} onValueChange={(v) => setRulesGoverningBody(v as 'rna' | 'usga')}>
                      <SelectTrigger className="w-[280px]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="rna">{t('admin:governingBodyRnA')}</SelectItem>
                        <SelectItem value="usga">{t('admin:governingBodyUSGA')}</SelectItem>
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">{t('admin:rulesGoverningBodyNote')}</p>
                  </div>

                  <div className="space-y-3">
                    <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                      {t('admin:localRulesContent')}
                    </label>
                    <p className="text-xs text-muted-foreground">{t('admin:localRulesContentDesc')}</p>
                    <Textarea
                      value={localRulesContent}
                      onChange={(e) => setLocalRulesContent(e.target.value)}
                      placeholder={t('admin:localRulesPlaceholder')}
                      rows={14}
                      maxLength={20000}
                      className="bg-black/40 border-white/10 text-white font-mono text-sm"
                    />
                    <p className="text-xs text-muted-foreground text-right">
                      {localRulesContent.length.toLocaleString()} / 20,000
                    </p>
                  </div>

                  <Button onClick={saveRulesConfig} disabled={savingRules} className="gap-2">
                    {savingRules ? t('loading', { ns: 'common' }) : <><Check className="w-4 h-4" /> {t('save', { ns: 'common' })}</>}
                  </Button>
                </CardContent>
              </Card>
            )}

            {activeSection === 'language' && (
              <Card className="glass-card">
                <CardHeader>
                  <CardTitle className="text-white flex items-center gap-2">
                    <Languages className="w-5 h-5 text-primary" /> {t('language', { ns: 'common' })}
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-5">
                  <p className="text-muted-foreground text-sm">
                    {t('admin:languageDesc')}
                  </p>
                  <div className="space-y-3">
                    <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">{t('selectLanguage', { ns: 'common' })}</label>
                    <Select value={defaultLanguage} onValueChange={setDefaultLanguage}>
                      <SelectTrigger className="w-[240px]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {SUPPORTED_LANGUAGES.map((l) => (
                          <SelectItem key={l.code} value={l.code}>
                            {l.name}
                            {l.code === 'ar' && <span className="ml-2 text-xs text-muted-foreground">(RTL)</span>}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">{t('admin:languageNote')}</p>
                  </div>
                  <Button onClick={saveDefaultLanguage} disabled={savingLanguage} className="gap-2">
                    {savingLanguage ? t('loading', { ns: 'common' }) : <><Check className="w-4 h-4" /> {t('save', { ns: 'common' })}</>}
                  </Button>
                </CardContent>
              </Card>
            )}

            {activeSection === 'domain' && (
              <Card className="glass-card">
                <CardHeader><CardTitle className="text-white flex items-center gap-2"><Globe className="w-5 h-5 text-primary" /> {t('admin:sections.customDomain')}</CardTitle></CardHeader>
                <CardContent className="space-y-5">
                  <div>
                    <label className="text-xs text-muted-foreground uppercase tracking-wider">{t('admin:customSubdomain')}</label>
                    <p className="text-xs text-muted-foreground mt-1 mb-2">{t('admin:customSubdomainDesc')}</p>
                    <Input value={branding.customDomain} onChange={e => setBranding(b => ({ ...b, customDomain: e.target.value }))}
                      placeholder="golf.yourclub.com" className="bg-black/40 border-white/10 text-white" />
                  </div>

                  <CustomDomainCertStatus orgId={orgId} />
                  <CustomDomainReachabilityStatus orgId={orgId} customDomain={org?.customDomain ?? null} />

                  <div className="bg-black/40 rounded-xl p-4 border border-white/10 space-y-3">
                    <p className="text-sm font-semibold text-white flex items-center gap-2"><Link2 className="w-4 h-4 text-primary" /> {t('admin:cnameSetup')}</p>
                    <ol className="text-sm text-muted-foreground space-y-2 list-decimal list-inside">
                      <li>{t('admin:cnameStep1')}</li>
                      <li>{t('admin:cnameStep2')}</li>
                      <li>{t('admin:cnameStep3')}</li>
                    </ol>
                    <div className="bg-black/60 rounded-lg px-4 py-2 font-mono text-sm flex items-center justify-between">
                      <span className="text-primary">proxy.kharagolf.app</span>
                      <button onClick={() => { navigator.clipboard.writeText('proxy.kharagolf.app'); toast({ title: t('admin:toasts.copied') }); }}
                        className="text-muted-foreground hover:text-white transition-colors ml-3">
                        <Copy className="w-4 h-4" />
                      </button>
                    </div>
                    <p className="text-xs text-muted-foreground">{t('admin:dnsPropagation')}</p>
                  </div>

                  <div className="flex flex-wrap items-center gap-3">
                    <Button onClick={() => { void saveCustomDomain(); }} disabled={saving} className="bg-primary hover:bg-primary/90 text-white gap-2">
                      {saving ? t('admin:saving') : <><Check className="w-4 h-4" /> {t('admin:saveDomain')}</>}
                    </Button>
                    {org?.customDomain && (
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => { setBranding(b => ({ ...b, customDomain: '' })); void saveCustomDomain(null); }}
                        disabled={saving}
                        className="gap-2"
                      >
                        <Trash2 className="w-4 h-4" /> {t('admin:clearDomain')}
                      </Button>
                    )}
                  </div>
                </CardContent>
              </Card>
            )}

            {activeSection === 'channels' && (
              <Card className="glass-card">
                <CardHeader>
                  <CardTitle className="text-white flex items-center gap-2">
                    <MessageSquare className="w-5 h-5 text-primary" /> {t('admin:channels.commChannels')}
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <p className="text-sm text-muted-foreground">
                    {t('admin:channels.description')}
                  </p>

                  {[
                    {
                      key: 'email' as const,
                      label: t('admin:channels.email'),
                      icon: Mail,
                      iconColor: 'text-emerald-400',
                    },
                    {
                      key: 'push' as const,
                      label: t('admin:channels.push'),
                      icon: Smartphone,
                      iconColor: 'text-primary',
                    },
                    {
                      key: 'sms' as const,
                      label: t('admin:channels.sms'),
                      icon: MessageCircle,
                      iconColor: 'text-green-400',
                    },
                    {
                      key: 'whatsapp' as const,
                      label: t('admin:channels.whatsapp'),
                      icon: MessageSquare,
                      iconColor: 'text-emerald-400',
                    },
                  ].map(({ key, label, icon: Icon, iconColor }) => {
                    const ch = channelStatus?.channels[key];
                    const isActive = ch?.active ?? false;
                    return (
                      <div key={key} className={`rounded-xl border p-4 ${isActive ? 'border-primary/30 bg-primary/5' : 'border-white/10 bg-white/[0.02]'}`}>
                        <div className="flex items-start gap-3">
                          <div className={`mt-0.5 ${iconColor}`}>
                            <Icon className="w-5 h-5" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-1">
                              <span className="font-semibold text-white text-sm">{label}</span>
                              {isActive ? (
                                <Badge className="bg-green-500/20 text-green-400 border-green-500/30 border text-xs flex items-center gap-1">
                                  <CheckCircle2 className="w-3 h-3" /> {t('admin:active')}
                                </Badge>
                              ) : (
                                <Badge className="bg-gray-500/20 text-gray-400 border-gray-500/30 border text-xs flex items-center gap-1">
                                  <XCircle className="w-3 h-3" /> {t('admin:inactive')}
                                </Badge>
                              )}
                              {ch?.provider && (
                                <span className="text-xs text-muted-foreground capitalize">{t('admin:channels.via')} {ch.provider}</span>
                              )}
                            </div>
                            {!isActive && ch?.setupInstructions && (
                              <p className="text-xs text-muted-foreground leading-relaxed">{ch.setupInstructions}</p>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}

                  {stripeStatus && (
                    <div
                      data-testid="row-stripe-webhook-status"
                      className={`rounded-xl border p-4 ${
                        stripeStatus.warning
                          ? 'border-orange-500/40 bg-orange-500/10'
                          : stripeStatus.webhookSecretConfigured
                            ? 'border-primary/30 bg-primary/5'
                            : 'border-white/10 bg-white/[0.02]'
                      }`}
                    >
                      <div className="flex items-start gap-3">
                        <div className={`mt-0.5 ${stripeStatus.warning ? 'text-orange-400' : 'text-purple-400'}`}>
                          <CreditCard className="w-5 h-5" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1 flex-wrap">
                            <span className="font-semibold text-white text-sm">Stripe webhook</span>
                            {stripeStatus.warning ? (
                              <Badge className="bg-orange-500/20 text-orange-300 border-orange-500/30 border text-xs flex items-center gap-1">
                                <AlertTriangle className="w-3 h-3" /> Action required
                              </Badge>
                            ) : stripeStatus.webhookSecretConfigured ? (
                              <Badge className="bg-green-500/20 text-green-400 border-green-500/30 border text-xs flex items-center gap-1">
                                <CheckCircle2 className="w-3 h-3" /> {t('admin:active')}
                              </Badge>
                            ) : (
                              <Badge className="bg-gray-500/20 text-gray-400 border-gray-500/30 border text-xs flex items-center gap-1">
                                <XCircle className="w-3 h-3" /> Not configured
                              </Badge>
                            )}
                            <span className="text-xs text-muted-foreground">
                              Base currency: {stripeStatus.baseCurrency ?? 'unknown'} · {stripeStatus.usesStripe ? 'Stripe checkout' : 'Razorpay (INR)'}
                            </span>
                          </div>
                          <ul className="text-xs text-muted-foreground space-y-1 mt-2">
                            <li className="flex items-center gap-2">
                              {stripeStatus.secretKeyConfigured
                                ? <CheckCircle2 className="w-3.5 h-3.5 text-green-400" />
                                : <XCircle className="w-3.5 h-3.5 text-gray-400" />}
                              <span>
                                <code className="font-mono">STRIPE_SECRET_KEY</code> {stripeStatus.secretKeyConfigured ? 'configured' : 'not set'}
                              </span>
                            </li>
                            <li className="flex items-center gap-2">
                              {stripeStatus.webhookSecretConfigured
                                ? <CheckCircle2 className="w-3.5 h-3.5 text-green-400" />
                                : <XCircle className={`w-3.5 h-3.5 ${stripeStatus.warning ? 'text-orange-400' : 'text-gray-400'}`} />}
                              <span>
                                <code className="font-mono">STRIPE_WEBHOOK_SECRET</code> {stripeStatus.webhookSecretConfigured ? 'configured' : 'not set'}
                              </span>
                            </li>
                            <li className="flex items-center gap-2">
                              <Link2 className="w-3.5 h-3.5 text-muted-foreground" />
                              <span>
                                Endpoint: <code className="font-mono">{stripeStatus.webhookEndpoint}</code>
                              </span>
                            </li>
                          </ul>
                          {stripeStatus.setupInstructions && (
                            <p className={`text-xs leading-relaxed mt-2 ${stripeStatus.warning ? 'text-orange-100/80' : 'text-muted-foreground'}`}>
                              {stripeStatus.setupInstructions}
                            </p>
                          )}

                          {/* Send-test-event probe — Task #829 */}
                          <div className="mt-3 flex flex-wrap items-center gap-2">
                            <Button
                              data-testid="button-send-stripe-test-event"
                              type="button"
                              size="sm"
                              variant="outline"
                              disabled={!stripeStatus.webhookSecretConfigured || stripeTesting}
                              onClick={() => { void sendStripeTestEvent(); }}
                              className="gap-2 h-8 text-xs"
                            >
                              {stripeTesting ? (
                                <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                              ) : (
                                <Zap className="w-3.5 h-3.5" />
                              )}
                              {stripeTesting ? 'Sending test event…' : 'Send test event'}
                            </Button>
                            {!stripeStatus.webhookSecretConfigured && (
                              <span className="text-xs text-muted-foreground">
                                Configure <code className="font-mono">STRIPE_WEBHOOK_SECRET</code> first.
                              </span>
                            )}
                          </div>

                          {stripeTestResult && (
                            <div
                              data-testid="result-stripe-test-event"
                              className={`mt-2 rounded-lg border p-2.5 text-xs ${
                                stripeTestResult.ok
                                  ? 'border-green-500/40 bg-green-500/10 text-green-100'
                                  : 'border-red-500/40 bg-red-500/10 text-red-100'
                              }`}
                            >
                              <div className="flex items-center gap-2 font-semibold">
                                {stripeTestResult.ok ? (
                                  <>
                                    <CheckCircle2 className="w-3.5 h-3.5 text-green-400" />
                                    Delivered — webhook accepted the signed event
                                    {typeof stripeTestResult.durationMs === 'number' && (
                                      <span className="font-normal text-green-200/80">({stripeTestResult.durationMs}ms)</span>
                                    )}
                                  </>
                                ) : (
                                  <>
                                    <XCircle className="w-3.5 h-3.5 text-red-400" />
                                    {stripeTestResult.stage === 'signature_mismatch' && 'Signature mismatch'}
                                    {stripeTestResult.stage === 'unreachable' && 'Endpoint unreachable'}
                                    {stripeTestResult.stage === 'endpoint_error' && `Endpoint error (HTTP ${stripeTestResult.httpStatus ?? '?'})`}
                                    {stripeTestResult.stage === 'config' && 'Webhook not configured'}
                                  </>
                                )}
                              </div>
                              {stripeTestResult.error && (
                                <p className="mt-1 leading-relaxed opacity-90">{stripeTestResult.error}</p>
                              )}
                              {stripeTestResult.eventId && (
                                <p className="mt-1 opacity-70">Event id: <code className="font-mono">{stripeTestResult.eventId}</code></p>
                              )}
                              {stripeTestResult.endpoint && (
                                <p className="mt-1 opacity-70 break-all">
                                  Probed: <code className="font-mono">{stripeTestResult.endpoint}</code>
                                  {stripeTestResult.usedPublicUrl === false && (
                                    <span className="ml-2 italic opacity-80">(loopback fallback — set <code className="font-mono">API_BASE_URL</code> for a true end-to-end probe)</span>
                                  )}
                                </p>
                              )}
                            </div>
                          )}

                          {/* Task #974 — recent real Stripe webhook deliveries.
                              Hidden for INR-only clubs (which don't route
                              checkout through Stripe). */}
                          {stripeStatus.usesStripe && (
                            <div data-testid="table-stripe-webhook-deliveries" className="mt-4 border-t border-white/10 pt-3">
                              <div className="flex items-center justify-between mb-2 gap-2 flex-wrap">
                                <span className="text-xs font-semibold text-white">Recent webhook deliveries</span>
                                <div className="flex items-center gap-2">
                                  {/* Task #1295 — segmented control: All vs. Failures only. */}
                                  <div
                                    role="group"
                                    aria-label="Filter webhook deliveries"
                                    data-testid="group-stripe-deliveries-filter"
                                    className="inline-flex rounded-md border border-white/10 overflow-hidden"
                                  >
                                    <button
                                      type="button"
                                      data-testid="button-stripe-deliveries-filter-all"
                                      aria-pressed={stripeDeliveriesFilter === 'all'}
                                      onClick={() => {
                                        setStripeDeliveriesFilter('all');
                                        // Task #1897 — clicking either filter
                                        // counts as "looking", so re-baseline
                                        // the new-failure indicator too.
                                        acknowledgeStripeDeliveriesFailures();
                                      }}
                                      className={`px-2 py-1 text-[11px] ${stripeDeliveriesFilter === 'all' ? 'bg-white/15 text-white' : 'text-muted-foreground hover:text-white'}`}
                                    >
                                      All
                                    </button>
                                    <button
                                      type="button"
                                      data-testid="button-stripe-deliveries-filter-failures"
                                      aria-pressed={stripeDeliveriesFilter === 'failures'}
                                      onClick={() => {
                                        setStripeDeliveriesFilter('failures');
                                        // Task #1897 — admin has now "seen"
                                        // the current count; clear the +N
                                        // highlight so it stops shouting.
                                        acknowledgeStripeDeliveriesFailures();
                                      }}
                                      // Task #1897 — when fresh failures have
                                      // arrived since the admin's last look,
                                      // give the toggle a soft red pulse so
                                      // it draws the eye without being a
                                      // klaxon. Suppressed once the filter is
                                      // already on Failures (the active state
                                      // styling carries the message).
                                      className={`px-2 py-1 text-[11px] border-l border-white/10 ${
                                        stripeDeliveriesFilter === 'failures'
                                          ? 'bg-red-500/20 text-red-200'
                                          : stripeDeliveriesNewFailuresSinceLastLook > 0
                                            ? 'bg-red-500/15 text-red-200 animate-pulse'
                                            : 'text-muted-foreground hover:text-white'
                                      }`}
                                    >
                                      Failures only{' '}
                                      {/* Task #1534 — count badge so admins can see at a
                                          glance whether it's worth flipping the filter.
                                          De-emphasised when zero so a healthy state reads
                                          as "nothing to investigate".
                                          Task #1897 — hovering the badge clears the
                                          fresh-failure highlight (counts as "looking"),
                                          mirroring the on-click acknowledgement above.
                                          Task #1898 — hovering the badge also reveals a
                                          per-reason breakdown (e.g. "2 signature_mismatch,
                                          1 reconciliation_failed") via the `title`
                                          attribute, so admins can tell *what kind* of
                                          failures make up the count without flipping the
                                          filter. The breakdown updates with each refetch
                                          via the same query. */}
                                      <span
                                        data-testid="text-stripe-deliveries-failure-count"
                                        onMouseEnter={
                                          stripeDeliveriesNewFailuresSinceLastLook > 0
                                            ? acknowledgeStripeDeliveriesFailures
                                            : undefined
                                        }
                                        title={
                                          stripeDeliveriesFailureBreakdownText
                                            ? `Failure breakdown: ${stripeDeliveriesFailureBreakdownText}`
                                            : undefined
                                        }
                                        className={
                                          stripeDeliveriesFailureCount === 0
                                            ? 'opacity-50'
                                            : 'cursor-help'
                                        }
                                      >
                                        ({stripeDeliveriesFailureCount.toLocaleString()})
                                      </span>
                                      {/* Task #1897 — explicit "+N new" indicator next
                                          to the count so admins can see at a glance
                                          how many failures have arrived since they
                                          last looked, not just that something has
                                          changed. Hidden once the highlight is
                                          acknowledged (count <= lastSeen). */}
                                      {stripeDeliveriesNewFailuresSinceLastLook > 0 && (
                                        <span
                                          data-testid="badge-stripe-deliveries-new-failures"
                                          aria-label={`${stripeDeliveriesNewFailuresSinceLastLook} new failure${stripeDeliveriesNewFailuresSinceLastLook === 1 ? '' : 's'} since you last looked`}
                                          className="ml-1 rounded bg-red-500/40 text-red-50 px-1 text-[10px] font-semibold"
                                        >
                                          +{stripeDeliveriesNewFailuresSinceLastLook.toLocaleString()} new
                                        </span>
                                      )}
                                    </button>
                                  </div>
                                  <button
                                    type="button"
                                    data-testid="button-refresh-stripe-deliveries"
                                    onClick={() => { void refetchStripeDeliveries(); }}
                                    disabled={stripeDeliveriesFetching}
                                    className="text-[11px] text-muted-foreground hover:text-white inline-flex items-center gap-1 disabled:opacity-50"
                                  >
                                    <RefreshCw className={`w-3 h-3 ${stripeDeliveriesFetching ? 'animate-spin' : ''}`} />
                                    Refresh
                                  </button>
                                </div>
                              </div>
                              {/* Task #1294 — Last daily-prune summary so admins
                                  can see the retention sweep is running and
                                  how many old rows it just removed, without
                                  digging through server logs. The sweep keeps
                                  this table to the last 30 days.
                                  Task #1295 — When the server says the sweep
                                  hasn't run in ~36h (`stale: true`) we flip
                                  the line to the orange warning treatment
                                  used by the wellness sweep tile and surface
                                  a "Sweep stalled" badge so admins notice
                                  without having to scrutinise the timestamp. */}
                              <p
                                data-testid="text-stripe-webhook-sweep-status"
                                className={`text-[11px] mb-1 flex items-center gap-2 flex-wrap ${
                                  stripeSweepStatus?.stale ? 'text-orange-300' : 'text-muted-foreground'
                                }`}
                              >
                                {stripeSweepStatus?.stale && (
                                  <Badge
                                    data-testid="badge-stripe-webhook-sweep-stale"
                                    className="bg-orange-500/20 text-orange-300 border-orange-500/30 border text-[10px] flex items-center gap-1"
                                  >
                                    <AlertTriangle className="w-3 h-3" /> Sweep stalled
                                  </Badge>
                                )}
                                <span>
                                  {stripeSweepStatus?.lastSweep ? (
                                    <>
                                      Retention sweep last ran{' '}
                                      <span className={stripeSweepStatus.stale ? 'text-orange-200' : 'text-white/80'}>
                                        {new Date(stripeSweepStatus.lastSweep.ranAt).toLocaleString()}
                                      </span>
                                      {' '}and removed{' '}
                                      <span
                                        data-testid="text-stripe-webhook-sweep-removed"
                                        className={`font-mono ${stripeSweepStatus.stale ? 'text-orange-200' : 'text-white/80'}`}
                                      >
                                        {stripeSweepStatus.lastSweep.removed.toLocaleString()}
                                      </span>
                                      {' '}row{stripeSweepStatus.lastSweep.removed === 1 ? '' : 's'} older than 30 days.
                                    </>
                                  ) : stripeSweepStatus?.stale ? (
                                    <>Retention sweep hasn't run on this server. It is supposed to run every 24 hours — check the cron and server logs.</>
                                  ) : (
                                    <>Retention sweep has not run yet on this server. It runs daily and prunes rows older than 30 days.</>
                                  )}
                                </span>
                              </p>
                              {/* Task #1525 — Inline trend of removed-row counts so admins
                                  can spot a sudden spike in inbound webhook traffic, or a
                                  stretch where the sweep hasn't been firing. Rendered
                                  oldest → newest left-to-right. Decoupled from the
                                  `lastSweep` query above so a transient mismatch between
                                  the two endpoints (e.g. status hasn't returned yet but
                                  history has) doesn't hide the trend from admins. */}
                              {stripeSweepHistory && (
                                <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1">
                                  {stripeSweepHistory.runs.length > 0 ? (
                                    <p
                                      data-testid="text-stripe-webhook-sweep-history"
                                      className="text-[11px] text-muted-foreground flex flex-wrap items-center gap-x-1"
                                      title={[...stripeSweepHistory.runs]
                                        .slice()
                                        .reverse()
                                        .map(r => `${new Date(r.ranAt).toLocaleString()}: ${r.removed}`)
                                        .join('\n')}
                                    >
                                      <span className="text-muted-foreground">
                                        Last {stripeSweepHistory.days} days:
                                      </span>
                                      {[...stripeSweepHistory.runs].slice().reverse().map((r, idx, arr) => (
                                        <span
                                          key={r.ranAt}
                                          className="inline-flex items-center"
                                        >
                                          <span
                                            data-testid={`text-stripe-webhook-sweep-history-entry-${idx}`}
                                            className="text-white/80 font-mono"
                                          >
                                            {r.removed.toLocaleString()}
                                          </span>
                                          {idx < arr.length - 1 && (
                                            <span aria-hidden="true" className="text-muted-foreground/60 px-0.5">→</span>
                                          )}
                                        </span>
                                      ))}
                                    </p>
                                  ) : (
                                    <p
                                      data-testid="text-stripe-webhook-sweep-history-empty"
                                      className="text-[11px] text-muted-foreground italic"
                                    >
                                      No sweep runs in the last {stripeSweepHistory.days} days.
                                    </p>
                                  )}
                                  {/* Task #1879 — window toggle, mirroring the wellness-sweep
                                      chart's 7 / 30 / 90 toggle a few hundred lines below.
                                      Rendered alongside the trend (or empty-state) so admins
                                      can always switch to a wider window when the current one
                                      has no recorded runs. */}
                                  <div
                                    role="group"
                                    aria-label="Trend window"
                                    className="inline-flex rounded-md border border-white/10 overflow-hidden"
                                    data-testid="toggle-stripe-webhook-sweep-history-window"
                                  >
                                    {STRIPE_SWEEP_WINDOW_OPTIONS.map(opt => (
                                      <button
                                        key={opt}
                                        type="button"
                                        onClick={() => setStripeSweepWindowDays(opt)}
                                        aria-pressed={stripeSweepWindowDays === opt}
                                        data-testid={`button-stripe-webhook-sweep-history-window-${opt}`}
                                        className={`px-2 py-0.5 text-[10px] font-medium transition-colors ${
                                          stripeSweepWindowDays === opt
                                            ? 'bg-white/15 text-white'
                                            : 'text-muted-foreground hover:text-white hover:bg-white/5'
                                        }`}
                                      >
                                        {opt}d
                                      </button>
                                    ))}
                                  </div>
                                </div>
                              )}
                              {/* Task #1898 — small per-reason summary so admins
                                  can tell *what kind* of failures make up the
                                  count without hovering the badge or flipping
                                  the filter. Only rendered when failures exist
                                  and we have a breakdown to show, so the
                                  healthy-state UI stays unchanged. */}
                              {stripeDeliveriesFailureCount > 0 && stripeDeliveriesFailureByReason.length > 0 && (
                                <p
                                  data-testid="text-stripe-deliveries-failure-breakdown"
                                  className="text-[11px] text-red-200/90 mb-2 flex flex-wrap items-center gap-x-2 gap-y-1"
                                >
                                  <span className="text-muted-foreground">By reason:</span>
                                  {stripeDeliveriesFailureByReason.map((entry, idx) => (
                                    <span
                                      key={entry.reason}
                                      data-testid={`text-stripe-deliveries-failure-breakdown-${entry.reason}`}
                                      title={
                                        STRIPE_WEBHOOK_ERROR_REASON_LABELS[entry.reason]
                                          ?? (entry.reason === 'unknown'
                                            ? 'No machine-readable reason recorded — check the row details.'
                                            : entry.reason)
                                      }
                                      className="inline-flex items-center"
                                    >
                                      <span className="font-mono text-white/90">
                                        {entry.count.toLocaleString()}
                                      </span>
                                      <span className="ml-1 font-mono text-red-200/90">
                                        {entry.reason}
                                      </span>
                                      {idx < stripeDeliveriesFailureByReason.length - 1 && (
                                        <span aria-hidden="true" className="text-muted-foreground/60">,</span>
                                      )}
                                    </span>
                                  ))}
                                </p>
                              )}
                              {!stripeDeliveries || stripeDeliveries.deliveries.length === 0 ? (
                                <p className="text-xs text-muted-foreground italic">
                                  {stripeDeliveriesFilter === 'failures'
                                    ? 'No failed webhook deliveries in the recent window. Switch to "All" to see successful deliveries.'
                                    : "No real Stripe deliveries recorded yet. They'll appear here once Stripe starts sending events to the webhook endpoint."}
                                </p>
                              ) : (
                                <div className="overflow-x-auto rounded-lg border border-white/10">
                                  <table className="w-full text-[11px]">
                                    <thead className="bg-white/[0.03] text-muted-foreground">
                                      <tr>
                                        <th className="text-left font-medium px-2 py-1.5">Received</th>
                                        <th className="text-left font-medium px-2 py-1.5">Event type</th>
                                        <th className="text-left font-medium px-2 py-1.5">From</th>
                                        <th className="text-left font-medium px-2 py-1.5">Sig.</th>
                                        <th className="text-left font-medium px-2 py-1.5">Status</th>
                                        <th className="text-left font-medium px-2 py-1.5">Reason</th>
                                        <th className="text-left font-medium px-2 py-1.5">Applied</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {stripeDeliveries.deliveries.map(d => {
                                        const ok = d.responseStatus >= 200 && d.responseStatus < 300;
                                        const reasonLabel = d.errorReason
                                          ? STRIPE_WEBHOOK_ERROR_REASON_LABELS[d.errorReason] ?? d.errorReason
                                          : null;
                                        return (
                                          <tr key={d.id} data-testid={`row-stripe-delivery-${d.id}`} className="border-t border-white/5">
                                            <td className="px-2 py-1.5 text-white/90 whitespace-nowrap">{new Date(d.receivedAt).toLocaleString()}</td>
                                            <td className="px-2 py-1.5 font-mono text-white/80 whitespace-nowrap">{d.eventType ?? '—'}</td>
                                            <td className="px-2 py-1.5 font-mono text-muted-foreground whitespace-nowrap">{d.sourceIp ?? '—'}</td>
                                            <td className="px-2 py-1.5">
                                              {d.signatureValid === true ? (
                                                <CheckCircle2 className="w-3.5 h-3.5 text-green-400" aria-label="Signature valid" />
                                              ) : d.signatureValid === false ? (
                                                <XCircle className="w-3.5 h-3.5 text-red-400" aria-label="Signature invalid" />
                                              ) : (
                                                <span className="text-muted-foreground" aria-label="Signature check skipped">—</span>
                                              )}
                                            </td>
                                            <td className={`px-2 py-1.5 font-mono whitespace-nowrap ${ok ? 'text-green-300' : 'text-red-300'}`}>{d.responseStatus}</td>
                                            <td className="px-2 py-1.5">
                                              {d.errorReason ? (
                                                <span
                                                  data-testid={`stripe-delivery-reason-${d.id}`}
                                                  title={reasonLabel ?? undefined}
                                                  className="font-mono text-[10px] text-red-300 underline decoration-dotted decoration-red-400/60 cursor-help"
                                                >
                                                  {d.errorReason}
                                                </span>
                                              ) : (
                                                <span className="text-muted-foreground">—</span>
                                              )}
                                            </td>
                                            <td className="px-2 py-1.5">
                                              {d.applied ? (
                                                <Badge className="bg-green-500/20 text-green-300 border-green-500/30 border text-[10px]">Yes</Badge>
                                              ) : (
                                                <Badge className="bg-white/5 text-muted-foreground border-white/10 border text-[10px]">No</Badge>
                                              )}
                                            </td>
                                          </tr>
                                        );
                                      })}
                                    </tbody>
                                  </table>
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  )}

                  {wellnessSweep && (
                    <div
                      data-testid="row-wellness-sweep-status"
                      className={`rounded-xl border p-4 ${
                        wellnessSweep.lastSweep?.alerted
                          ? 'border-orange-500/40 bg-orange-500/10'
                          : 'border-white/10 bg-white/[0.02]'
                      }`}
                    >
                      <div className="flex items-start gap-3">
                        <div className={`mt-0.5 ${wellnessSweep.lastSweep?.alerted ? 'text-orange-400' : 'text-pink-400'}`}>
                          <Zap className="w-5 h-5" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1 flex-wrap">
                            <span className="font-semibold text-white text-sm">Wearable sync (Whoop / Google Fit)</span>
                            {wellnessSweep.lastSweep ? (
                              wellnessSweep.lastSweep.alerted ? (
                                <Badge className="bg-orange-500/20 text-orange-300 border-orange-500/30 border text-xs flex items-center gap-1">
                                  <AlertTriangle className="w-3 h-3" /> Many re-auths
                                </Badge>
                              ) : (
                                <Badge className="bg-green-500/20 text-green-400 border-green-500/30 border text-xs flex items-center gap-1">
                                  <CheckCircle2 className="w-3 h-3" /> Healthy
                                </Badge>
                              )
                            ) : (
                              <Badge className="bg-gray-500/20 text-gray-400 border-gray-500/30 border text-xs flex items-center gap-1">
                                No sweep yet
                              </Badge>
                            )}
                            {wellnessSweep.lastSweep && (
                              <span className="text-xs text-muted-foreground">
                                Last run: {new Date(wellnessSweep.lastSweep.ranAt).toLocaleString()}
                              </span>
                            )}
                          </div>
                          {wellnessSweep.lastSweep ? (
                            <ul className="text-xs text-muted-foreground space-y-1 mt-2">
                              <li>Attempted: <span className="font-mono text-white">{wellnessSweep.lastSweep.attempted}</span></li>
                              <li>Succeeded: <span className="font-mono text-emerald-300">{wellnessSweep.lastSweep.succeeded}</span></li>
                              <li>Needs re-auth: <span className={`font-mono ${wellnessSweep.lastSweep.needsReauth > 0 ? 'text-orange-300' : 'text-white'}`}>{wellnessSweep.lastSweep.needsReauth}</span></li>
                            </ul>
                          ) : (
                            <p
                              data-testid="text-wellness-sweep-status-empty"
                              className="text-xs text-muted-foreground italic mt-2"
                            >
                              The hourly sweep hasn't run yet. Latest counts will appear here once it does.
                            </p>
                          )}
                          {wellnessSweep.lastSweep?.alerted && (
                            <p className="text-xs leading-relaxed mt-2 text-orange-100/80">
                              A spike in needs_reauth usually means a Whoop or Google Fit credential rotation has invalidated existing tokens. Players will be prompted to reconnect their wearable on next app open.
                            </p>
                          )}

                          {/* Task #991 — short trend of attempted vs needs_reauth so
                              admins can spot slow token-expiry drift before the
                              absolute-count alert trips. */}
                          <div data-testid="chart-wellness-sweep-history" className="mt-4 border-t border-white/10 pt-3">
                            <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
                              <span className="text-xs font-semibold text-white">
                                Last {wellnessWindowDays} days
                              </span>
                              <div
                                role="group"
                                aria-label="Trend window"
                                className="inline-flex rounded-md border border-white/10 overflow-hidden"
                                data-testid="toggle-wellness-sweep-history-window"
                              >
                                {WELLNESS_WINDOW_OPTIONS.map(opt => (
                                  <button
                                    key={opt}
                                    type="button"
                                    onClick={() => setWellnessWindowDays(opt)}
                                    aria-pressed={wellnessWindowDays === opt}
                                    data-testid={`button-wellness-sweep-history-window-${opt}`}
                                    className={`px-2 py-0.5 text-[10px] font-medium transition-colors ${
                                      wellnessWindowDays === opt
                                        ? 'bg-white/15 text-white'
                                        : 'text-muted-foreground hover:text-white hover:bg-white/5'
                                    }`}
                                  >
                                    {opt}d
                                  </button>
                                ))}
                              </div>
                              <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
                                <span className="inline-flex items-center gap-1">
                                  <span className="inline-block w-2 h-2 rounded-sm bg-sky-400" />
                                  Attempted
                                </span>
                                <span className="inline-flex items-center gap-1">
                                  <span className="inline-block w-2 h-2 rounded-sm bg-orange-400" />
                                  Needs re-auth
                                </span>
                              </div>
                            </div>
                            {!wellnessSweepHistory || wellnessSweepHistory.runs.length === 0 ? (
                              <p
                                data-testid="text-wellness-sweep-history-empty"
                                className="text-xs text-muted-foreground italic"
                              >
                                No sweep history recorded yet. The hourly sweep will populate this chart over the next few days.
                              </p>
                            ) : (
                              <div className="h-32 -mx-1">
                                <ResponsiveContainer width="100%" height="100%">
                                  <AreaChart
                                    data={[...wellnessSweepHistory.runs]
                                      .slice()
                                      .reverse()
                                      .map(r => ({
                                        ranAt: r.ranAt,
                                        attempted: r.attempted,
                                        needsReauth: r.needsReauth,
                                        succeeded: r.succeeded,
                                      }))}
                                    margin={{ top: 4, right: 8, left: -20, bottom: 0 }}
                                  >
                                    <defs>
                                      <linearGradient id="wellnessAttempted" x1="0" y1="0" x2="0" y2="1">
                                        <stop offset="0%" stopColor="#38bdf8" stopOpacity={0.45} />
                                        <stop offset="100%" stopColor="#38bdf8" stopOpacity={0} />
                                      </linearGradient>
                                      <linearGradient id="wellnessReauth" x1="0" y1="0" x2="0" y2="1">
                                        <stop offset="0%" stopColor="#fb923c" stopOpacity={0.55} />
                                        <stop offset="100%" stopColor="#fb923c" stopOpacity={0} />
                                      </linearGradient>
                                    </defs>
                                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" vertical={false} />
                                    <XAxis
                                      dataKey="ranAt"
                                      tickFormatter={iso => {
                                        const d = new Date(iso);
                                        return `${d.getMonth() + 1}/${d.getDate()}`;
                                      }}
                                      tick={{ fontSize: 10, fill: 'rgba(255,255,255,0.5)' }}
                                      stroke="rgba(255,255,255,0.1)"
                                      minTickGap={24}
                                    />
                                    <YAxis
                                      tick={{ fontSize: 10, fill: 'rgba(255,255,255,0.5)' }}
                                      stroke="rgba(255,255,255,0.1)"
                                      allowDecimals={false}
                                      width={28}
                                    />
                                    <RechartsTooltip
                                      contentStyle={{
                                        background: 'rgba(15,15,20,0.95)',
                                        border: '1px solid rgba(255,255,255,0.1)',
                                        borderRadius: 8,
                                        fontSize: 11,
                                      }}
                                      labelStyle={{ color: 'rgba(255,255,255,0.7)', marginBottom: 4 }}
                                      itemStyle={{ color: 'white' }}
                                      labelFormatter={iso => new Date(iso as string).toLocaleString()}
                                      formatter={(value: number, name: string) => {
                                        const label = name === 'attempted'
                                          ? 'Attempted'
                                          : name === 'needsReauth'
                                            ? 'Needs re-auth'
                                            : name === 'succeeded'
                                              ? 'Succeeded'
                                              : name;
                                        return [value, label];
                                      }}
                                    />
                                    <Area
                                      type="monotone"
                                      dataKey="attempted"
                                      stroke="#38bdf8"
                                      strokeWidth={1.5}
                                      fill="url(#wellnessAttempted)"
                                      isAnimationActive={false}
                                    />
                                    <Area
                                      type="monotone"
                                      dataKey="needsReauth"
                                      stroke="#fb923c"
                                      strokeWidth={1.5}
                                      fill="url(#wellnessReauth)"
                                      isAnimationActive={false}
                                    />
                                  </AreaChart>
                                </ResponsiveContainer>
                              </div>
                            )}
                          </div>

                          {/* Task #1324 — week-over-week drift tile. Mirrors
                              the same {thisWeek, lastWeek, delta, threshold}
                              the cron evaluator emails about, plus the
                              org's per-week rate-limit watermark, so admins
                              can see the drift signal at a glance. */}
                          {reauthWowDrift && (
                            <div
                              data-testid="row-wellness-reauth-wow-drift"
                              className={`mt-4 border-t border-white/10 pt-3 rounded-md -mx-1 px-2 ${
                                reauthWowDrift.hasSufficientData && reauthWowDrift.exceedsThreshold
                                  ? 'bg-orange-500/5'
                                  : ''
                              }`}
                            >
                              <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
                                <span className="text-xs font-semibold text-white">
                                  Week-over-week re-auth drift
                                </span>
                                {reauthWowDrift.hasSufficientData ? (
                                  reauthWowDrift.exceedsThreshold ? (
                                    <Badge
                                      data-testid="badge-wellness-reauth-wow-drift-status"
                                      className="bg-orange-500/20 text-orange-300 border-orange-500/30 border text-[10px] flex items-center gap-1"
                                    >
                                      <AlertTriangle className="w-3 h-3" /> Drifting up
                                    </Badge>
                                  ) : (
                                    <Badge
                                      data-testid="badge-wellness-reauth-wow-drift-status"
                                      className="bg-green-500/20 text-green-400 border-green-500/30 border text-[10px] flex items-center gap-1"
                                    >
                                      <CheckCircle2 className="w-3 h-3" /> Steady
                                    </Badge>
                                  )
                                ) : (
                                  <Badge
                                    data-testid="badge-wellness-reauth-wow-drift-status"
                                    className="bg-gray-500/20 text-gray-400 border-gray-500/30 border text-[10px] flex items-center gap-1"
                                  >
                                    Collecting data
                                  </Badge>
                                )}
                              </div>
                              <div className="grid grid-cols-3 gap-2 text-[11px]">
                                <div className="rounded border border-white/10 bg-black/20 p-2">
                                  <div className="text-[10px] text-muted-foreground uppercase tracking-wider">This week avg</div>
                                  <div
                                    data-testid="text-wellness-reauth-wow-drift-this-week"
                                    className="font-mono text-white text-sm mt-0.5"
                                  >
                                    {reauthWowDrift.thisWeek.averageNeedsReauth.toFixed(2)}
                                  </div>
                                  <div className="text-[10px] text-muted-foreground mt-0.5">
                                    over {reauthWowDrift.thisWeek.runs} runs
                                  </div>
                                </div>
                                <div className="rounded border border-white/10 bg-black/20 p-2">
                                  <div className="text-[10px] text-muted-foreground uppercase tracking-wider">Prior week avg</div>
                                  <div
                                    data-testid="text-wellness-reauth-wow-drift-last-week"
                                    className="font-mono text-white text-sm mt-0.5"
                                  >
                                    {reauthWowDrift.lastWeek.averageNeedsReauth.toFixed(2)}
                                  </div>
                                  <div className="text-[10px] text-muted-foreground mt-0.5">
                                    over {reauthWowDrift.lastWeek.runs} runs
                                  </div>
                                </div>
                                <div className="rounded border border-white/10 bg-black/20 p-2">
                                  <div className="text-[10px] text-muted-foreground uppercase tracking-wider">Δ vs last week</div>
                                  <div
                                    data-testid="text-wellness-reauth-wow-drift-delta"
                                    className={`font-mono text-sm mt-0.5 ${
                                      reauthWowDrift.delta > 0
                                        ? 'text-orange-300'
                                        : reauthWowDrift.delta < 0
                                          ? 'text-emerald-300'
                                          : 'text-white'
                                    }`}
                                  >
                                    {reauthWowDrift.delta > 0 ? '+' : ''}{reauthWowDrift.delta.toFixed(2)}
                                  </div>
                                  <div
                                    data-testid="text-wellness-reauth-wow-drift-threshold"
                                    className="text-[10px] text-muted-foreground mt-0.5"
                                  >
                                    threshold ≥ {reauthWowDrift.threshold.toFixed(2)}
                                  </div>
                                </div>
                              </div>
                              {!reauthWowDrift.hasSufficientData && (
                                <p
                                  data-testid="text-wellness-reauth-wow-drift-insufficient"
                                  className="text-[10px] text-muted-foreground italic mt-2"
                                >
                                  Need at least {reauthWowDrift.minRuns} sweep runs in each week before the drift comparison is reliable. Counts will fill in over the next day or two.
                                </p>
                              )}
                              {reauthWowDrift.org && (
                                <p
                                  data-testid="text-wellness-reauth-wow-drift-watermark"
                                  className="text-[10px] text-muted-foreground mt-2"
                                >
                                  {reauthWowDrift.org.lastSentAt ? (
                                    <>
                                      Last drift email sent{' '}
                                      <span className="text-white/80">{new Date(reauthWowDrift.org.lastSentAt).toLocaleString()}</span>
                                      {reauthWowDrift.org.nextEligibleAt && (
                                        <>
                                          {' '}· next eligible{' '}
                                          <span className="text-white/80">{new Date(reauthWowDrift.org.nextEligibleAt).toLocaleString()}</span>
                                          {' '}(rate-limited to once per {reauthWowDrift.rateLimitDays} days)
                                        </>
                                      )}
                                    </>
                                  ) : (
                                    <>No drift email has been sent for this org yet — the next eligible alert will fire as soon as the threshold is exceeded.</>
                                  )}
                                </p>
                              )}

                              {/* Task #1577 — N-week trend chart. One bar per
                                  week (7-day average needs_reauth) with a
                                  dashed reference line at the configured
                                  alert threshold so admins can see whether
                                  the latest spike is a one-off blip or a
                                  persistent climb. */}
                              {reauthWowDriftHistory && Array.isArray(reauthWowDriftHistory.buckets) && reauthWowDriftHistory.buckets.length > 0 && (
                                <div
                                  data-testid="chart-wellness-reauth-wow-drift-history"
                                  className="mt-3 border-t border-white/10 pt-3"
                                >
                                  <div className="flex items-center justify-between flex-wrap gap-2 mb-2">
                                    <span
                                      data-testid="label-wellness-reauth-wow-drift-history"
                                      className="text-[11px] font-semibold text-white/80"
                                    >
                                      Trend over last {reauthWowDriftHistory.weeks} weeks
                                    </span>
                                    <div
                                      role="group"
                                      aria-label="Trend window"
                                      className="inline-flex rounded-md border border-white/10 overflow-hidden"
                                      data-testid="toggle-wellness-reauth-wow-drift-history-window"
                                    >
                                      {REAUTH_DRIFT_WEEKS_OPTIONS.map(opt => (
                                        <button
                                          key={opt}
                                          type="button"
                                          onClick={() => setReauthDriftWeeks(opt)}
                                          aria-pressed={reauthDriftWeeks === opt}
                                          data-testid={`button-wellness-reauth-wow-drift-history-window-${opt}`}
                                          className={`px-2 py-0.5 text-[10px] font-medium transition-colors ${
                                            reauthDriftWeeks === opt
                                              ? 'bg-white/15 text-white'
                                              : 'text-muted-foreground hover:text-white hover:bg-white/5'
                                          }`}
                                        >
                                          {opt}w
                                        </button>
                                      ))}
                                    </div>
                                    <span className="inline-flex items-center gap-3 text-[10px] text-muted-foreground">
                                      <span className="inline-flex items-center gap-1">
                                        <span className="inline-block w-2 h-2 rounded-sm bg-orange-400" />
                                        Avg needs re-auth / sweep
                                      </span>
                                      <span className="inline-flex items-center gap-1">
                                        <span className="inline-block w-3 border-t border-dashed border-rose-400/80" />
                                        Threshold ≥ {reauthWowDriftHistory.threshold.toFixed(2)}
                                      </span>
                                    </span>
                                  </div>
                                  <div className="h-28 -mx-1">
                                    <ResponsiveContainer width="100%" height="100%">
                                      <BarChart
                                        data={reauthWowDriftHistory.buckets.map(b => ({
                                          weekStart: b.weekStart,
                                          weekEnd: b.weekEnd,
                                          averageNeedsReauth: Math.round(b.averageNeedsReauth * 100) / 100,
                                          runs: b.runs,
                                          hasSufficientData: b.hasSufficientData,
                                        }))}
                                        margin={{ top: 4, right: 8, left: -20, bottom: 0 }}
                                      >
                                        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" vertical={false} />
                                        <XAxis
                                          dataKey="weekStart"
                                          tickFormatter={iso => {
                                            const d = new Date(iso);
                                            return `${d.getMonth() + 1}/${d.getDate()}`;
                                          }}
                                          tick={{ fontSize: 10, fill: 'rgba(255,255,255,0.5)' }}
                                          stroke="rgba(255,255,255,0.1)"
                                          minTickGap={8}
                                        />
                                        <YAxis
                                          tick={{ fontSize: 10, fill: 'rgba(255,255,255,0.5)' }}
                                          stroke="rgba(255,255,255,0.1)"
                                          allowDecimals={true}
                                          width={28}
                                        />
                                        <RechartsTooltip
                                          cursor={{ fill: 'rgba(255,255,255,0.04)' }}
                                          contentStyle={{
                                            background: 'rgba(15,15,20,0.95)',
                                            border: '1px solid rgba(255,255,255,0.1)',
                                            borderRadius: 8,
                                            fontSize: 11,
                                          }}
                                          labelStyle={{ color: 'rgba(255,255,255,0.7)', marginBottom: 4 }}
                                          itemStyle={{ color: 'white' }}
                                          labelFormatter={(_label, payload) => {
                                            const row = payload && payload[0]?.payload as { weekStart: string; weekEnd: string; runs: number } | undefined;
                                            if (!row) return '';
                                            const start = new Date(row.weekStart);
                                            // weekEnd is exclusive — show the inclusive last day to match
                                            // how admins read "the week of …".
                                            const lastDay = new Date(new Date(row.weekEnd).getTime() - 24 * 60 * 60 * 1000);
                                            const fmt = (d: Date) => `${d.getMonth() + 1}/${d.getDate()}`;
                                            return `Week of ${fmt(start)} – ${fmt(lastDay)} · ${row.runs} runs`;
                                          }}
                                          formatter={(value: number) => [value.toFixed(2), 'Avg needs re-auth']}
                                        />
                                        <ReferenceLine
                                          y={reauthWowDriftHistory.threshold}
                                          stroke="#fb7185"
                                          strokeDasharray="4 4"
                                          strokeWidth={1}
                                          ifOverflow="extendDomain"
                                        />
                                        <Bar
                                          dataKey="averageNeedsReauth"
                                          isAnimationActive={false}
                                          radius={[2, 2, 0, 0]}
                                        >
                                          {reauthWowDriftHistory.buckets.map((b, i) => (
                                            <Cell
                                              key={b.weekStart}
                                              fill={
                                                !b.hasSufficientData
                                                  ? 'rgba(148,163,184,0.45)'
                                                  : b.averageNeedsReauth >= reauthWowDriftHistory.threshold
                                                    ? '#fb923c'
                                                    : '#38bdf8'
                                              }
                                              data-testid={`bar-wellness-reauth-wow-drift-history-${i}`}
                                            />
                                          ))}
                                        </Bar>
                                      </BarChart>
                                    </ResponsiveContainer>
                                  </div>
                                </div>
                              )}

                              {/* Task #1578 — Acknowledge / snooze the drift
                                  alert. Bumps the watermark forward by N
                                  days so the cron evaluator skips its next
                                  email; the audit row records who clicked. */}
                              {reauthWowDrift.org && (
                                <div className="mt-3 pt-3 border-t border-white/10 space-y-2">
                                  {/* Task #1970 — runaway-snooze guard. Once the
                                      org has snoozed at least `maxSnoozesPer30d`
                                      times in the trailing 30 days the server
                                      starts refusing further clicks, and we
                                      surface a red banner so super_admins can
                                      step in instead of letting the alert get
                                      silenced indefinitely. */}
                                  {reauthWowDrift.org.snoozeCountLast30d >= reauthWowDrift.org.maxSnoozesPer30d && (
                                    <div
                                      data-testid="banner-wellness-reauth-wow-drift-snooze-cap"
                                      className="rounded border border-rose-500/40 bg-rose-500/10 px-2 py-1.5 flex items-start gap-2"
                                    >
                                      <AlertTriangle className="w-3.5 h-3.5 text-rose-300 mt-0.5 shrink-0" />
                                      <div className="text-[11px] text-rose-100 leading-snug">
                                        <span className="font-semibold">
                                          Snoozed {reauthWowDrift.org.snoozeCountLast30d} times in the last 30 days
                                        </span>{' '}
                                        (cap is {reauthWowDrift.org.maxSnoozesPer30d}). Further snoozes are blocked
                                        until older clicks age out — investigate the underlying drift or escalate to
                                        a super_admin.
                                      </div>
                                    </div>
                                  )}
                                  {reauthWowDrift.org.lastAcknowledgment && (
                                    <p
                                      data-testid="text-wellness-reauth-wow-drift-last-ack"
                                      className="text-[10px] text-muted-foreground"
                                    >
                                      Last acknowledged by{' '}
                                      <span className="text-white/80">
                                        {reauthWowDrift.org.lastAcknowledgment.acknowledgedByName ?? 'an admin'}
                                      </span>
                                      {reauthWowDrift.org.lastAcknowledgment.acknowledgedByRole && (
                                        <> ({reauthWowDrift.org.lastAcknowledgment.acknowledgedByRole})</>
                                      )}
                                      {' '}on{' '}
                                      <span className="text-white/80">
                                        {new Date(reauthWowDrift.org.lastAcknowledgment.acknowledgedAt).toLocaleString()}
                                      </span>
                                      {' '}· snoozed for {reauthWowDrift.org.lastAcknowledgment.snoozeDays} day
                                      {reauthWowDrift.org.lastAcknowledgment.snoozeDays === 1 ? '' : 's'}
                                    </p>
                                  )}
                                  {/* Task #1969 — Expandable history of every snooze
                                      click for this org, capped at the 20 most
                                      recent. Lazy-loaded on first open via the
                                      `enabled` flag on the React Query call. */}
                                  {reauthWowDrift.org.lastAcknowledgment && (
                                    <details
                                      className="text-[10px]"
                                      onToggle={(e) => setReauthWowHistoryOpen((e.target as HTMLDetailsElement).open)}
                                      data-testid="disclosure-wellness-reauth-wow-drift-history"
                                    >
                                      <summary
                                        className="cursor-pointer text-muted-foreground hover:text-white/80"
                                        data-testid="summary-wellness-reauth-wow-drift-history"
                                      >
                                        View full snooze history
                                      </summary>
                                      <div
                                        className="mt-2 rounded-md border border-white/10 bg-black/30"
                                        data-testid="container-wellness-reauth-wow-drift-history"
                                      >
                                        {reauthWowAckHistoryLoading && !reauthWowAckHistory && (
                                          <p
                                            className="p-2 text-muted-foreground"
                                            data-testid="text-wellness-reauth-wow-drift-history-loading"
                                          >
                                            Loading history…
                                          </p>
                                        )}
                                        {reauthWowAckHistory && reauthWowAckHistory.entries.length === 0 && (
                                          <p
                                            className="p-2 text-muted-foreground"
                                            data-testid="text-wellness-reauth-wow-drift-history-empty"
                                          >
                                            No snooze history recorded for this organization yet.
                                          </p>
                                        )}
                                        {reauthWowAckHistory && reauthWowAckHistory.entries.length > 0 && (
                                          <ul
                                            className="divide-y divide-white/5 max-h-48 overflow-auto"
                                            data-testid="list-wellness-reauth-wow-drift-history"
                                          >
                                            {reauthWowAckHistory.entries.map((entry, i) => (
                                              <li
                                                key={`${entry.acknowledgedAt}-${i}`}
                                                className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 px-2 py-1.5"
                                                data-testid={`row-wellness-reauth-wow-drift-history-${i}`}
                                              >
                                                <span
                                                  className="text-white/80"
                                                  data-testid={`text-wellness-reauth-wow-drift-history-name-${i}`}
                                                >
                                                  {entry.acknowledgedByName ?? 'an admin'}
                                                </span>
                                                {entry.acknowledgedByRole && (
                                                  <span
                                                    className="text-muted-foreground"
                                                    data-testid={`text-wellness-reauth-wow-drift-history-role-${i}`}
                                                  >
                                                    ({entry.acknowledgedByRole})
                                                  </span>
                                                )}
                                                <span
                                                  className="text-muted-foreground"
                                                  data-testid={`text-wellness-reauth-wow-drift-history-when-${i}`}
                                                >
                                                  {new Date(entry.acknowledgedAt).toLocaleString()}
                                                </span>
                                                <span
                                                  className="text-muted-foreground"
                                                  data-testid={`text-wellness-reauth-wow-drift-history-snooze-${i}`}
                                                >
                                                  · snoozed {entry.snoozeDays} day{entry.snoozeDays === 1 ? '' : 's'}
                                                </span>
                                              </li>
                                            ))}
                                          </ul>
                                        )}
                                      </div>
                                    </details>
                                  )}
                                  <div className="flex items-center gap-2 flex-wrap">
                                    <label
                                      htmlFor="select-wellness-reauth-wow-drift-snooze"
                                      className="text-[10px] text-muted-foreground uppercase tracking-wider"
                                    >
                                      Snooze for
                                    </label>
                                    <Select value={reauthWowAckDays} onValueChange={setReauthWowAckDays}>
                                      <SelectTrigger
                                        id="select-wellness-reauth-wow-drift-snooze"
                                        data-testid="select-wellness-reauth-wow-drift-snooze"
                                        className="h-7 w-[120px] bg-black/40 border-white/10 text-white text-xs"
                                      >
                                        <SelectValue />
                                      </SelectTrigger>
                                      <SelectContent>
                                        <SelectItem value="1">1 day</SelectItem>
                                        <SelectItem value="3">3 days</SelectItem>
                                        <SelectItem value="7">7 days</SelectItem>
                                        <SelectItem value="14">14 days</SelectItem>
                                        <SelectItem value="30">30 days</SelectItem>
                                      </SelectContent>
                                    </Select>
                                    <Button
                                      data-testid="button-wellness-reauth-wow-drift-acknowledge"
                                      size="sm"
                                      variant="outline"
                                      // Task #1970 — disable when the org has hit the 30-day
                                      // snooze cap. Server still rejects (defence in depth) but
                                      // greying the button locally avoids a confusing toast and
                                      // signals to the admin why nothing is happening.
                                      disabled={
                                        reauthWowAckSaving
                                        || reauthWowDrift.org.snoozeCountLast30d >= reauthWowDrift.org.maxSnoozesPer30d
                                      }
                                      onClick={acknowledgeWowDrift}
                                      title={
                                        reauthWowDrift.org.snoozeCountLast30d >= reauthWowDrift.org.maxSnoozesPer30d
                                          ? `Snoozed ${reauthWowDrift.org.snoozeCountLast30d} times in the last 30 days (cap is ${reauthWowDrift.org.maxSnoozesPer30d}). Investigate the underlying drift instead.`
                                          : undefined
                                      }
                                      className="h-7 text-xs border-white/15 hover:bg-white/5 disabled:opacity-50 disabled:cursor-not-allowed"
                                    >
                                      {reauthWowAckSaving ? 'Acknowledging…' : 'Acknowledge'}
                                    </Button>
                                  </div>
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Task #1705 — Recent failed swing-video fps probes. Always
                      rendered so admins can see "0 failures, all clear" instead
                      of an empty-but-invisible panel. */}
                  <div
                    data-testid="row-swing-fps-probe-failures"
                    className={`rounded-xl border p-4 ${
                      (fpsProbeFailures?.failureCount ?? 0) > 0
                        ? 'border-orange-500/40 bg-orange-500/10'
                        : 'border-white/10 bg-white/[0.02]'
                    }`}
                  >
                    <div className="flex items-start gap-3">
                      <div className={`mt-0.5 ${(fpsProbeFailures?.failureCount ?? 0) > 0 ? 'text-orange-400' : 'text-pink-400'}`}>
                        <Upload className="w-5 h-5" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1 flex-wrap">
                          <span className="font-semibold text-white text-sm">
                            Swing-video frame-rate probe failures
                          </span>
                          {fpsProbeFailures
                            ? (fpsProbeFailures.failureCount > 0 ? (
                                <Badge
                                  data-testid="badge-swing-fps-probe-failures-count"
                                  className="bg-orange-500/20 text-orange-300 border-orange-500/30 border text-xs flex items-center gap-1"
                                >
                                  <AlertTriangle className="w-3 h-3" />
                                  {fpsProbeFailures.failureCount.toLocaleString()} failed
                                </Badge>
                              ) : (
                                <Badge
                                  data-testid="badge-swing-fps-probe-failures-count"
                                  className="bg-green-500/20 text-green-400 border-green-500/30 border text-xs flex items-center gap-1"
                                >
                                  <CheckCircle2 className="w-3 h-3" /> All clear
                                </Badge>
                              ))
                            : null}
                          <button
                            type="button"
                            data-testid="button-refresh-swing-fps-probe-failures"
                            onClick={() => { void refetchFpsProbeFailures(); }}
                            disabled={fpsProbeFailuresFetching}
                            className="ml-auto text-[11px] text-muted-foreground hover:text-white inline-flex items-center gap-1 disabled:opacity-50"
                          >
                            <RefreshCw className={`w-3 h-3 ${fpsProbeFailuresFetching ? 'animate-spin' : ''}`} />
                            Refresh
                          </button>
                        </div>
                        <p className="text-xs text-muted-foreground leading-relaxed mb-3">
                          Probes that have exhausted their retry budget. The original swing video keeps fps=NULL
                          until the probe succeeds — re-enqueue to start a fresh attempt, or dismiss when the
                          underlying object is known-bad.
                        </p>
                        {/* Task #2127 — let an admin isolate chronic failures
                            from this morning's blip. Hidden when the API
                            hasn't returned yet, and when there are no rows
                            at all (the empty state below covers that). */}
                        {fpsProbeFailures && fpsProbeFailures.failures.length > 0 && (
                          <div
                            role="group"
                            aria-label="Filter failures by minimum age"
                            className="inline-flex rounded-md border border-white/10 overflow-hidden mb-3"
                            data-testid="toggle-swing-fps-probe-failures-min-age"
                          >
                            {FPS_PROBE_AGE_FILTER_OPTIONS.map(opt => (
                              <button
                                key={opt.value}
                                type="button"
                                onClick={() => setFpsProbeMinAgeDays(opt.value)}
                                aria-pressed={fpsProbeMinAgeDays === opt.value}
                                data-testid={`button-swing-fps-probe-failures-min-age-${opt.value}`}
                                className={`px-2 py-0.5 text-[10px] font-medium transition-colors ${
                                  fpsProbeMinAgeDays === opt.value
                                    ? 'bg-white/15 text-white'
                                    : 'text-muted-foreground hover:text-white hover:bg-white/5'
                                }`}
                              >
                                {opt.label}
                              </button>
                            ))}
                          </div>
                        )}
                        {!fpsProbeFailures || fpsProbeFailures.failures.length === 0 ? (
                          <p
                            data-testid="text-swing-fps-probe-failures-empty"
                            className="text-xs text-muted-foreground italic"
                          >
                            No failed fps probes recorded — recent uploads are processing cleanly.
                          </p>
                        ) : fpsProbeFilteredFailures.length === 0 ? (
                          <p
                            data-testid="text-swing-fps-probe-failures-filter-empty"
                            className="text-xs text-muted-foreground italic"
                          >
                            No failures older than {fpsProbeMinAgeDays} day{fpsProbeMinAgeDays === 1 ? '' : 's'} —
                            the recent ones are still listed when the filter is set to "All".
                          </p>
                        ) : (
                          <div className="overflow-x-auto rounded-lg border border-white/10">
                            <table className="w-full text-[11px]">
                              <thead className="bg-white/[0.03] text-muted-foreground">
                                <tr>
                                  <th className="text-left font-medium px-2 py-1.5">Failed at</th>
                                  <th className="text-left font-medium px-2 py-1.5">Swing video</th>
                                  <th className="text-left font-medium px-2 py-1.5">Object path</th>
                                  <th className="text-left font-medium px-2 py-1.5">Attempts</th>
                                  <th className="text-left font-medium px-2 py-1.5">Error</th>
                                  <th className="text-right font-medium px-2 py-1.5">Actions</th>
                                </tr>
                              </thead>
                              <tbody>
                                {fpsProbeFilteredFailures.map(p => {
                                  const busy = fpsProbeActioningId === p.id;
                                  // Task #2127 — render both the absolute
                                  // timestamp and a relative "Nd ago" badge,
                                  // and emphasise rows older than the
                                  // FPS_PROBE_OLD_ROW_DAYS threshold so the
                                  // long-broken ones pop visually.
                                  const completedMs = p.completedAt
                                    ? new Date(p.completedAt).getTime()
                                    : NaN;
                                  const ageDays = Number.isFinite(completedMs)
                                    ? Math.floor((Date.now() - completedMs) / 86_400_000)
                                    : null;
                                  const isOld = ageDays !== null && ageDays >= FPS_PROBE_OLD_ROW_DAYS;
                                  return (
                                    <tr
                                      key={p.id}
                                      data-testid={`row-swing-fps-probe-failure-${p.id}`}
                                      data-old={isOld ? 'true' : 'false'}
                                      className={`border-t border-white/5 ${isOld ? 'bg-red-500/10' : ''}`}
                                    >
                                      <td className={`px-2 py-1.5 whitespace-nowrap ${isOld ? 'text-red-200' : 'text-white/90'}`}>
                                        <div className="flex flex-col leading-tight">
                                          <span>{p.completedAt ? new Date(p.completedAt).toLocaleString() : '—'}</span>
                                          {p.completedAt && (
                                            <span
                                              data-testid={`text-swing-fps-probe-failure-age-${p.id}`}
                                              className={`text-[10px] ${isOld ? 'text-red-300 font-semibold' : 'text-muted-foreground'}`}
                                            >
                                              {formatProbeFailureAge(p.completedAt)}
                                            </span>
                                          )}
                                        </div>
                                      </td>
                                      <td className="px-2 py-1.5 font-mono text-white/80 whitespace-nowrap">
                                        #{p.swingVideoId}
                                      </td>
                                      <td className="px-2 py-1.5 font-mono text-muted-foreground max-w-[220px] truncate" title={p.objectPath}>
                                        {p.objectPath}
                                      </td>
                                      <td className="px-2 py-1.5 font-mono text-white/80 text-center">
                                        {p.attempts}
                                      </td>
                                      <td
                                        className="px-2 py-1.5 text-red-300 max-w-[280px] truncate"
                                        title={p.errorMessage ?? undefined}
                                        data-testid={`text-swing-fps-probe-failure-error-${p.id}`}
                                      >
                                        {p.errorMessagePreview ?? '—'}
                                      </td>
                                      <td className="px-2 py-1.5 whitespace-nowrap text-right">
                                        <div className="inline-flex items-center gap-1">
                                          <Button
                                            type="button"
                                            size="sm"
                                            variant="outline"
                                            disabled={busy}
                                            onClick={() => { void actOnFpsProbeFailure(p.id, 'reenqueue'); }}
                                            data-testid={`button-swing-fps-probe-failure-reenqueue-${p.id}`}
                                            className="h-7 text-[11px] border-white/15 hover:bg-white/5"
                                          >
                                            <RefreshCw className={`w-3 h-3 mr-1 ${busy ? 'animate-spin' : ''}`} />
                                            Re-enqueue
                                          </Button>
                                          <Button
                                            type="button"
                                            size="sm"
                                            variant="ghost"
                                            disabled={busy}
                                            onClick={() => { void actOnFpsProbeFailure(p.id, 'dismiss'); }}
                                            data-testid={`button-swing-fps-probe-failure-dismiss-${p.id}`}
                                            className="h-7 text-[11px] text-muted-foreground hover:text-white"
                                          >
                                            <Trash2 className="w-3 h-3 mr-1" />
                                            Dismiss
                                          </Button>
                                        </div>
                                      </td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>

                  {reauthAlertSettings && reauthAlertSettings.orgId !== null && (
                    <div
                      data-testid="row-wearable-reauth-alert-settings"
                      className="rounded-xl border border-white/10 bg-white/[0.02] p-4"
                    >
                      <div className="flex items-start gap-3">
                        <div className="mt-0.5 text-pink-400">
                          <Settings className="w-5 h-5" />
                        </div>
                        <div className="flex-1 min-w-0 space-y-3">
                          <div>
                            <span className="font-semibold text-white text-sm">Wearable re-auth alert sensitivity</span>
                            <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                              Choose how aggressive the alert is when player wearables flip to "needs re-auth" during the hourly sweep. Larger clubs typically raise the absolute floor; smaller clubs may want to be alerted on any flip.
                            </p>
                          </div>
                          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                            <div>
                              <label className="text-[11px] text-muted-foreground uppercase tracking-wider">Min count</label>
                              <Input
                                data-testid="input-reauth-min-count"
                                type="number"
                                min={1}
                                value={reauthAlertForm.minCount}
                                onChange={e => setReauthAlertForm(f => ({ ...f, minCount: e.target.value }))}
                                className="mt-1 bg-black/40 border-white/10 text-white text-sm"
                              />
                              <p className="text-[10px] text-muted-foreground mt-1">Alert when ≥ this many flip. Default {reauthAlertSettings.defaults.minCount}.</p>
                            </div>
                            <div>
                              <label className="text-[11px] text-muted-foreground uppercase tracking-wider">Min share %</label>
                              <Input
                                data-testid="input-reauth-min-share"
                                type="number"
                                min={1}
                                max={100}
                                value={reauthAlertForm.minSharePct}
                                onChange={e => setReauthAlertForm(f => ({ ...f, minSharePct: e.target.value }))}
                                className="mt-1 bg-black/40 border-white/10 text-white text-sm"
                              />
                              <p className="text-[10px] text-muted-foreground mt-1">Or ≥ this share of attempted. Default {reauthAlertSettings.defaults.minSharePct}%.</p>
                            </div>
                            <div>
                              <label className="text-[11px] text-muted-foreground uppercase tracking-wider">Min attempted</label>
                              <Input
                                data-testid="input-reauth-min-attempted"
                                type="number"
                                min={1}
                                value={reauthAlertForm.minAttempted}
                                onChange={e => setReauthAlertForm(f => ({ ...f, minAttempted: e.target.value }))}
                                className="mt-1 bg-black/40 border-white/10 text-white text-sm"
                              />
                              <p className="text-[10px] text-muted-foreground mt-1">Skip the share rule below this. Default {reauthAlertSettings.defaults.minAttempted}.</p>
                            </div>
                          </div>
                          {/* Task #1579 — Per-org override for the weekly
                              week-over-week drift threshold. The system
                              default is exposed via `defaults.wowMinDelta`;
                              an empty input clears the override (the org
                              re-inherits that default). Editing the field
                              clears any stale inline error so the user
                              gets a clean slate while correcting input. */}
                          <div>
                            <label className="text-[11px] text-muted-foreground uppercase tracking-wider">Weekly drift threshold</label>
                            <Input
                              data-testid="input-reauth-wow-min-delta"
                              type="number"
                              min={0.01}
                              max={9999.99}
                              step={0.01}
                              placeholder={reauthAlertSettings.defaults.wowMinDelta.toFixed(2)}
                              value={reauthAlertForm.wowMinDelta}
                              onChange={e => {
                                if (reauthAlertError) setReauthAlertError(null);
                                setReauthAlertForm(f => ({ ...f, wowMinDelta: e.target.value }));
                              }}
                              className="mt-1 bg-black/40 border-white/10 text-white text-sm"
                            />
                            <p className="text-[10px] text-muted-foreground mt-1">
                              Alert when this week's average needs_reauth count exceeds last week's by ≥ this delta. Leave blank to inherit the default of {reauthAlertSettings.defaults.wowMinDelta.toFixed(2)}. Max 9999.99, two decimals.
                            </p>
                          </div>
                          <div>
                            <label className="text-[11px] text-muted-foreground uppercase tracking-wider">Alert email recipient (optional)</label>
                            <Input
                              data-testid="input-reauth-alert-email"
                              type="email"
                              placeholder={reauthAlertSettings.defaults.fallbackEmail ?? 'ops@yourclub.com'}
                              value={reauthAlertForm.email}
                              onChange={e => setReauthAlertForm(f => ({ ...f, email: e.target.value }))}
                              className="mt-1 bg-black/40 border-white/10 text-white text-sm"
                            />
                            <p className="text-[10px] text-muted-foreground mt-1">
                              Leave blank to {reauthAlertSettings.defaults.fallbackEmail ? <>fall back to the global ops address (<code className="font-mono">{reauthAlertSettings.defaults.fallbackEmail}</code>)</> : 'skip the email and rely on the warn-level log only'}.
                            </p>
                          </div>
                          {reauthAlertError && (
                            <div
                              data-testid="text-reauth-alert-error"
                              role="alert"
                              className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300"
                            >
                              {reauthAlertError}
                            </div>
                          )}
                          <div>
                            <Button
                              data-testid="button-save-reauth-alert-settings"
                              onClick={() => { void saveReauthAlertSettings(); }}
                              disabled={reauthAlertSaving}
                              size="sm"
                              className="bg-primary hover:bg-primary/90 text-white gap-2 h-8 text-xs"
                            >
                              {reauthAlertSaving ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                              {reauthAlertSaving ? 'Saving…' : 'Save sensitivity'}
                            </Button>
                          </div>
                        </div>
                      </div>
                    </div>
                  )}

                  {!channelStatus && (
                    <div className="text-center py-6 text-muted-foreground text-sm">
                      {t('admin:channels.loadingStatus')}
                    </div>
                  )}

                  {/* Task #1361 — Registry of every notification key the
                      dispatcher knows about (registered via Task #1005 in
                      `notificationRegistry.ts`). Each row offers a "View
                      audit" deep-link straight into the dispatch history
                      feed (Task #1172) for that key, so admins don't have
                      to navigate to the audit page and re-pick the key
                      from the dropdown. Collapsed by default to keep the
                      channels card scannable. */}
                  {notificationTemplates && notificationTemplates.keys.length > 0 && (
                    <details
                      className="rounded-xl border border-white/10 bg-white/[0.02] p-4"
                      data-testid="panel-notification-registry"
                    >
                      <summary
                        className="cursor-pointer flex items-center gap-2 text-sm font-semibold text-white"
                        data-testid="summary-notification-registry"
                      >
                        <Bell className="w-4 h-4 text-primary" />
                        Notification template registry
                        {/* Task #2025 — badge shows the visible row count
                            (post-filter), with the unfiltered total in the
                            denominator when any filter is active so admins
                            can tell whether they're looking at the whole
                            list or a slice of it. */}
                        <Badge
                          className="ml-2 bg-white/5 text-white/70 border-white/10 border text-[10px]"
                          data-testid="badge-notification-registry-count"
                        >
                          {registryFiltersActive
                            ? `${filteredRegistryEntries.length} of ${notificationTemplates.keys.length}`
                            : notificationTemplates.keys.length}
                        </Badge>
                      </summary>
                      <p className="text-xs text-muted-foreground mt-2 mb-3">
                        Every notification key the dispatcher recognises. Click <span className="text-sky-300">Preview template</span> to
                        see the rendered title/body/HTML for a key, or <span className="text-sky-300">View audit</span> to jump straight
                        into the dispatch history feed filtered to that key.
                      </p>
                      {/* Task #2025 / #2026 — Search box + category /
                          channel filter chips and an "audit-required only"
                          toggle. All filtering happens in-memory against
                          the metadata the list endpoint already returns;
                          pressing "/" focuses the search box. */}
                      <div
                        className="mb-3 space-y-2"
                        data-testid="filters-notification-registry"
                      >
                        <div className="relative">
                          <Search
                            className="w-3.5 h-3.5 text-white/40 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none"
                            aria-hidden="true"
                          />
                          <Input
                            ref={registrySearchRef}
                            value={registrySearch}
                            onChange={e => setRegistrySearch(e.target.value)}
                            placeholder="Search keys, categories or descriptions… (press /)"
                            aria-label="Search notification template registry"
                            className="pl-8 pr-8 h-8 bg-black/40 border-white/10 text-white text-xs"
                            data-testid="input-notification-registry-search"
                          />
                          {registrySearch.length > 0 && (
                            <button
                              type="button"
                              onClick={() => setRegistrySearch('')}
                              aria-label="Clear search"
                              className="absolute right-2 top-1/2 -translate-y-1/2 text-white/40 hover:text-white/80"
                              data-testid="button-notification-registry-search-clear"
                            >
                              <X className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>
                        {registryCategoryOptions.length > 0 && (
                          <div
                            className="flex items-start gap-2 flex-wrap"
                            data-testid="chips-notification-registry-category"
                          >
                            <span className="text-[10px] uppercase tracking-wide text-white/40 mt-1">
                              Category:
                            </span>
                            {registryCategoryOptions.map(cat => {
                              const active = registryCategoryFilters.has(cat);
                              return (
                                <button
                                  key={cat}
                                  type="button"
                                  onClick={() => toggleRegistryCategory(cat)}
                                  aria-pressed={active}
                                  className={`text-[10px] px-2 py-0.5 rounded-full border transition-colors ${
                                    active
                                      ? 'bg-sky-500/20 text-sky-200 border-sky-400/40'
                                      : 'bg-white/5 text-white/60 border-white/10 hover:bg-white/10'
                                  }`}
                                  data-testid={`chip-notification-registry-category-${cat}`}
                                >
                                  {cat}
                                </button>
                              );
                            })}
                          </div>
                        )}
                        {registryChannelOptions.length > 0 && (
                          <div
                            className="flex items-start gap-2 flex-wrap"
                            data-testid="chips-notification-registry-channel"
                          >
                            <span className="text-[10px] uppercase tracking-wide text-white/40 mt-1">
                              Channel:
                            </span>
                            {registryChannelOptions.map(ch => {
                              const active = registryChannelFilters.has(ch);
                              return (
                                <button
                                  key={ch}
                                  type="button"
                                  onClick={() => toggleRegistryChannel(ch)}
                                  aria-pressed={active}
                                  className={`text-[10px] px-2 py-0.5 rounded-full border transition-colors capitalize ${
                                    active
                                      ? 'bg-sky-500/20 text-sky-200 border-sky-400/40'
                                      : 'bg-white/5 text-white/60 border-white/10 hover:bg-white/10'
                                  }`}
                                  data-testid={`chip-notification-registry-channel-${ch}`}
                                >
                                  {ch}
                                </button>
                              );
                            })}
                          </div>
                        )}
                        {/* Task #2026 — Audit-required toggle. Sits next
                            to the chip rows so admins can quickly zero in
                            on the keys that mandate an audit row per
                            dispatch (auditRequired flag from Task #1632). */}
                        <div
                          className="flex items-start gap-2 flex-wrap"
                          data-testid="chips-notification-registry-audit"
                        >
                          <span className="text-[10px] uppercase tracking-wide text-white/40 mt-1">
                            Audit:
                          </span>
                          <button
                            type="button"
                            onClick={() => setRegistryAuditOnly(v => !v)}
                            aria-pressed={registryAuditOnly}
                            className={`text-[10px] px-2 py-0.5 rounded-full border transition-colors inline-flex items-center gap-1 ${
                              registryAuditOnly
                                ? 'bg-amber-500/20 text-amber-200 border-amber-400/40'
                                : 'bg-white/5 text-white/60 border-white/10 hover:bg-white/10'
                            }`}
                            data-testid="toggle-notification-registry-audit-only"
                          >
                            <ShieldCheck className="w-3 h-3" />
                            Audit-required only
                          </button>
                        </div>
                        {registryFiltersActive && (
                          <button
                            type="button"
                            onClick={clearRegistryFilters}
                            className="text-[11px] text-sky-300 hover:text-sky-200 inline-flex items-center gap-1"
                            data-testid="button-notification-registry-clear-filters"
                          >
                            <X className="w-3 h-3" />
                            Clear filters
                          </button>
                        )}
                      </div>
                      {filteredRegistryEntries.length === 0 ? (
                        <div
                          className="rounded-md border border-white/5 bg-black/20 px-3 py-6 text-xs text-center text-white/60"
                          data-testid="empty-notification-registry"
                        >
                          No notification keys match the current filters.{' '}
                          <button
                            type="button"
                            onClick={clearRegistryFilters}
                            className="text-sky-300 hover:text-sky-200 underline"
                            data-testid="button-notification-registry-empty-clear"
                          >
                            Clear filters
                          </button>
                          .
                        </div>
                      ) : (
                      <ul
                        className="divide-y divide-white/5 max-h-96 overflow-auto rounded-md border border-white/5"
                        data-testid="list-notification-registry"
                      >
                        {filteredRegistryEntries.map((entry) => (
                          <li
                            key={entry.key}
                            className="flex items-start justify-between gap-3 px-3 py-2"
                            data-testid={`row-registry-key-${entry.key}`}
                          >
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2 flex-wrap">
                                <code
                                  className="text-xs font-mono text-white/85 truncate"
                                  data-testid={`text-registry-key-${entry.key}`}
                                >
                                  {entry.key}
                                </code>
                                {entry.category && (
                                  <Badge
                                    className="bg-white/5 text-white/60 border-white/10 border text-[10px]"
                                    data-testid={`badge-registry-category-${entry.key}`}
                                  >
                                    {entry.category}
                                  </Badge>
                                )}
                                {entry.auditRequired && (
                                  <Badge
                                    className="bg-amber-500/15 text-amber-200 border-amber-400/30 border text-[10px] inline-flex items-center gap-1"
                                    data-testid={`badge-registry-audit-${entry.key}`}
                                    title="Every dispatch of this key writes an admin audit row"
                                  >
                                    <ShieldCheck className="w-3 h-3" />
                                    audit-required
                                  </Badge>
                                )}
                              </div>
                              {entry.description && (
                                <p
                                  className="text-[11px] text-white/65 mt-1 leading-snug"
                                  data-testid={`text-registry-description-${entry.key}`}
                                >
                                  {entry.description}
                                </p>
                              )}
                              {entry.defaultChannels.length > 0 && (
                                <div
                                  className="flex items-center gap-1 mt-1.5 text-white/50"
                                  data-testid={`channels-registry-${entry.key}`}
                                >
                                  <span className="text-[10px] uppercase tracking-wide text-white/40 mr-1">
                                    Default:
                                  </span>
                                  {entry.defaultChannels.map((ch) => {
                                    const Icon =
                                      ch === 'email' ? Mail
                                      : ch === 'push' ? Bell
                                      : ch === 'sms' ? Smartphone
                                      : ch === 'whatsapp' ? MessageCircle
                                      : ch === 'inapp' ? Inbox
                                      : MessageSquare;
                                    return (
                                      <span
                                        key={ch}
                                        title={ch}
                                        className="inline-flex items-center"
                                        data-testid={`channel-icon-${entry.key}-${ch}`}
                                      >
                                        <Icon className="w-3.5 h-3.5" />
                                      </span>
                                    );
                                  })}
                                </div>
                              )}
                            </div>
                            <div className="shrink-0 flex items-center gap-3 mt-0.5">
                              <button
                                type="button"
                                onClick={() => { void openTemplatePreview(entry.key); }}
                                className="inline-flex items-center gap-1 text-xs text-sky-300 hover:text-sky-200"
                                data-testid={`button-registry-preview-template-${entry.key}`}
                              >
                                <Eye className="w-3 h-3" />
                                Preview template
                              </button>
                              <a
                                href={`/admin/notification-audit?key=${encodeURIComponent(entry.key)}`}
                                className="inline-flex items-center gap-1 text-xs text-sky-300 hover:text-sky-200"
                                data-testid={`link-registry-view-audit-${entry.key}`}
                              >
                                <ExternalLink className="w-3 h-3" />
                                View audit
                              </a>
                            </div>
                          </li>
                        ))}
                      </ul>
                      )}
                    </details>
                  )}

                  {/* Task #1631 — preview dialog for the per-key template
                      endpoint. Shows the canned title/body/HTML the
                      dispatcher would render for the key, without firing
                      a real send. The HTML is sandboxed in an iframe via
                      srcdoc so any inline styles in the template can't
                      leak into the admin shell. */}
                  <Dialog
                    open={previewKey !== null}
                    onOpenChange={(open) => {
                      if (!open) {
                        setPreviewKey(null);
                        setPreviewData(null);
                        setPreviewError(null);
                        setPreviewLoading(false);
                        // Task #2050 — also reset the comparison pane so a
                        // future open of a different key doesn't show stale
                        // compare state from this session.
                        setCompareMode(false);
                        setCompareData(null);
                        setCompareError(null);
                        setCompareLoading(false);
                      }
                    }}
                  >
                    <DialogContent
                      className={`glass-panel border-white/10 max-h-[90vh] overflow-y-auto ${
                        // Task #2050 — widen the dialog when the comparison
                        // pane is on so two side-by-side previews don't get
                        // crushed. Stays at the original width otherwise so
                        // the existing single-pane layout is unchanged.
                        compareMode ? 'sm:max-w-2xl lg:max-w-5xl' : 'sm:max-w-2xl'
                      }`}
                      data-testid="dialog-notification-template-preview"
                    >
                      <DialogHeader>
                        <DialogTitle className="text-white flex items-center gap-2">
                          <Bell className="w-4 h-4 text-primary" />
                          Template preview
                        </DialogTitle>
                        {previewKey && (
                          <p className="text-xs font-mono text-white/70 mt-1 break-all" data-testid="text-preview-key">
                            {previewKey}
                          </p>
                        )}
                      </DialogHeader>
                      {/* Task #1648 — Language picker. Only shown for keys with
                          a branded renderer (where the language actually
                          changes the output). The list comes from the API's
                          `availableLanguages` so it stays in sync with the
                          server's `NOTIFICATION_EMAIL_LANGS` enum.
                          Task #2050 — when compare mode is on, a second
                          picker appears alongside it for the comparison
                          language, plus a toggle button to enter/exit
                          compare mode. */}
                      {/* Task #2051 — warn the admin when the previewed sample
                          fell back to English because no translation pack
                          exists for the picked language yet. The flag is
                          derived server-side from the canonical translation
                          registry so it stays accurate as new bundles
                          land. Only meaningful for branded keys (the
                          generic wrapper has no per-language strings). */}
                      {previewData?.branded
                        && previewData.translationStatus === 'fallback'
                        && previewData.lang
                        && previewData.lang !== 'en' && (() => {
                          const cfg = SUPPORTED_LANGUAGES.find((l) => l.code === previewData.lang);
                          const langLabel = cfg?.name ?? previewData.lang;
                          return (
                            <div
                              role="alert"
                              className="mt-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200 flex items-start gap-2"
                              data-testid="banner-preview-translation-fallback"
                            >
                              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                              <span>
                                No <span data-testid="text-preview-fallback-language">{langLabel}</span> translation yet — showing English fallback.
                              </span>
                            </div>
                          );
                        })()}
                      {previewData?.branded && (previewData.availableLanguages?.length ?? 0) > 0 && (
                        <div
                          className="mt-3 flex flex-wrap items-end gap-3"
                          data-testid="container-preview-language"
                        >
                          <div className="flex items-center gap-2">
                            <label
                              htmlFor="preview-language-select"
                              className="text-[11px] text-muted-foreground uppercase tracking-wider"
                            >
                              Language
                            </label>
                            <Select
                              value={previewLang}
                              onValueChange={(value) => { void onPreviewLangChange(value); }}
                            >
                              <SelectTrigger
                                id="preview-language-select"
                                className="h-8 w-44 bg-black/40 border-white/10 text-white text-xs"
                                data-testid="select-preview-language"
                              >
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {(previewData.availableLanguages ?? []).map((code) => {
                                  const cfg = SUPPORTED_LANGUAGES.find((l) => l.code === code);
                                  const label = cfg ? `${cfg.flag} ${cfg.name}` : code;
                                  return (
                                    <SelectItem
                                      key={code}
                                      value={code}
                                      data-testid={`option-preview-language-${code}`}
                                    >
                                      {label}
                                    </SelectItem>
                                  );
                                })}
                              </SelectContent>
                            </Select>
                          </div>
                          {compareMode && (
                            <div
                              className="flex items-center gap-2"
                              data-testid="container-preview-language-compare"
                            >
                              <label
                                htmlFor="preview-compare-language-select"
                                className="text-[11px] text-muted-foreground uppercase tracking-wider"
                              >
                                Compare with
                              </label>
                              <Select
                                value={compareLang}
                                onValueChange={(value) => { void onCompareLangChange(value); }}
                              >
                                <SelectTrigger
                                  id="preview-compare-language-select"
                                  className="h-8 w-44 bg-black/40 border-white/10 text-white text-xs"
                                  data-testid="select-preview-language-compare"
                                >
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  {(previewData.availableLanguages ?? []).map((code) => {
                                    const cfg = SUPPORTED_LANGUAGES.find((l) => l.code === code);
                                    const label = cfg ? `${cfg.flag} ${cfg.name}` : code;
                                    return (
                                      <SelectItem
                                        key={code}
                                        value={code}
                                        data-testid={`option-preview-language-compare-${code}`}
                                      >
                                        {label}
                                      </SelectItem>
                                    );
                                  })}
                                </SelectContent>
                              </Select>
                            </div>
                          )}
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="border-white/10 text-white text-xs h-8"
                            onClick={() => { void toggleCompareMode(); }}
                            disabled={previewLoading || !!previewError || !previewData}
                            aria-pressed={compareMode}
                            data-testid="button-preview-compare-toggle"
                          >
                            {compareMode ? 'Hide comparison' : 'Compare another language'}
                          </Button>
                        </div>
                      )}
                      <div className="mt-3 space-y-3">
                        {previewLoading && (
                          <div
                            className="flex items-center gap-2 text-sm text-muted-foreground py-6 justify-center"
                            data-testid="text-preview-loading"
                          >
                            <RefreshCw className="w-4 h-4 animate-spin" />
                            Loading preview…
                          </div>
                        )}
                        {previewError && !previewLoading && (
                          <div
                            role="alert"
                            className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-3 text-sm text-red-300"
                            data-testid="text-preview-error"
                          >
                            {previewError}
                          </div>
                        )}
                        {previewData && !previewLoading && !previewError && (
                          <div className="space-y-4">
                            {/* Meta + description are language-independent
                                (they come from the registry, not the
                                rendered template), so render them once
                                even in compare mode. */}
                            <div className="flex flex-wrap gap-2" data-testid="meta-preview">
                              <Badge className="bg-white/5 text-white/80 border-white/10 border text-[10px] capitalize">
                                {previewData.category}
                              </Badge>
                              {previewData.defaultChannels.map((ch) => (
                                <Badge
                                  key={ch}
                                  className="bg-sky-500/10 text-sky-300 border-sky-500/30 border text-[10px] capitalize"
                                >
                                  {ch}
                                </Badge>
                              ))}
                              {previewData.digestable && (
                                <Badge className="bg-emerald-500/10 text-emerald-300 border-emerald-500/30 border text-[10px]">
                                  digestable
                                </Badge>
                              )}
                              {previewData.auditRequired && (
                                <Badge className="bg-amber-500/10 text-amber-300 border-amber-500/30 border text-[10px]">
                                  audited
                                </Badge>
                              )}
                            </div>
                            <p className="text-xs text-muted-foreground" data-testid="text-preview-description">
                              {previewData.description}
                            </p>
                            {/* Task #2050 — pane grid. Single column when
                                compare is off (preserving the existing
                                layout), two columns from md+ when compare
                                is on. Falls back to single column on narrow
                                screens so two stacked previews stay
                                readable on a phone. */}
                            <div
                              className={
                                compareMode
                                  ? 'grid grid-cols-1 md:grid-cols-2 gap-4'
                                  : ''
                              }
                              data-testid={compareMode ? 'container-preview-panes' : undefined}
                            >
                              {(() => {
                                // Helper to render one preview pane
                                // (title + body + HTML iframe). Test ids
                                // for the primary pane stay un-suffixed
                                // so existing locators keep working; the
                                // compare pane gets a `-compare` suffix.
                                const renderPane = (
                                  paneData: NotificationTemplatePreview | null,
                                  paneLoading: boolean,
                                  paneError: string | null,
                                  paneLang: string,
                                  isCompare: boolean,
                                ) => {
                                  const suffix = isCompare ? '-compare' : '';
                                  const cfg = SUPPORTED_LANGUAGES.find((l) => l.code === paneLang);
                                  const langLabel = cfg ? `${cfg.flag} ${cfg.name}` : paneLang;
                                  return (
                                    <div
                                      className={
                                        compareMode
                                          ? 'space-y-3 rounded-md border border-white/5 bg-white/[0.02] p-3'
                                          : 'space-y-3'
                                      }
                                      data-testid={`pane-preview${suffix}`}
                                    >
                                      {compareMode && (
                                        <div
                                          className="flex items-center justify-between"
                                          data-testid={`pane-preview-header${suffix}`}
                                        >
                                          <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
                                            {isCompare ? 'Comparison' : 'Primary'}
                                          </span>
                                          <span
                                            className="text-xs text-white/80"
                                            data-testid={`pane-preview-language${suffix}`}
                                          >
                                            {langLabel}
                                          </span>
                                        </div>
                                      )}
                                      {paneLoading && (
                                        <div
                                          className="flex items-center gap-2 text-sm text-muted-foreground py-6 justify-center"
                                          data-testid={`text-preview-loading${suffix}`}
                                        >
                                          <RefreshCw className="w-4 h-4 animate-spin" />
                                          Loading preview…
                                        </div>
                                      )}
                                      {paneError && !paneLoading && (
                                        <div
                                          role="alert"
                                          className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-3 text-sm text-red-300"
                                          data-testid={`text-preview-error${suffix}`}
                                        >
                                          {paneError}
                                        </div>
                                      )}
                                      {paneData && !paneLoading && !paneError && (
                                        <>
                                          <div>
                                            <label className="text-[11px] text-muted-foreground uppercase tracking-wider">Title</label>
                                            <div
                                              className="mt-1 rounded-md border border-white/10 bg-black/40 px-3 py-2 text-sm text-white"
                                              data-testid={`text-preview-title${suffix}`}
                                            >
                                              {paneData.sample.title}
                                            </div>
                                          </div>
                                          <div>
                                            <label className="text-[11px] text-muted-foreground uppercase tracking-wider">Body</label>
                                            <div
                                              className="mt-1 rounded-md border border-white/10 bg-black/40 px-3 py-2 text-sm text-white whitespace-pre-wrap"
                                              data-testid={`text-preview-body${suffix}`}
                                            >
                                              {paneData.sample.body}
                                            </div>
                                          </div>
                                          <div>
                                            <label className="text-[11px] text-muted-foreground uppercase tracking-wider">HTML</label>
                                            <iframe
                                              title={`Template preview for ${paneData.key}${isCompare ? ` (${paneLang})` : ''}`}
                                              srcDoc={paneData.sample.html}
                                              sandbox=""
                                              className="mt-1 w-full h-56 rounded-md border border-white/10 bg-white"
                                              data-testid={`iframe-preview-html${suffix}`}
                                            />
                                            <details className="mt-2">
                                              <summary className="text-[11px] text-muted-foreground cursor-pointer hover:text-white/80">
                                                View raw HTML source
                                              </summary>
                                              <pre
                                                className="mt-2 text-[11px] font-mono text-white/70 bg-black/60 border border-white/10 rounded-md p-2 overflow-auto max-h-40"
                                                data-testid={`text-preview-html-source${suffix}`}
                                              >
                                                {paneData.sample.html}
                                              </pre>
                                            </details>
                                          </div>
                                        </>
                                      )}
                                    </div>
                                  );
                                };
                                return (
                                  <>
                                    {renderPane(previewData, false, null, previewLang, false)}
                                    {compareMode && renderPane(
                                      compareData,
                                      compareLoading,
                                      compareError,
                                      compareLang,
                                      true,
                                    )}
                                  </>
                                );
                              })()}
                            </div>
                          </div>
                        )}
                      </div>
                      <DialogFooter className="mt-4">
                        {/* Task #2023 — fire the rendered template at the
                            calling admin so they can verify the live
                            channel works end-to-end. Disabled while a
                            preview is loading or errored, and while a
                            send is in flight, so admins can't trigger
                            duplicate sends or send a stale render. */}
                        <Button
                          variant="default"
                          onClick={() => { void sendTestTemplate(); }}
                          disabled={
                            previewSending
                            || previewLoading
                            || !!previewError
                            || !previewData
                          }
                          data-testid="button-preview-send-test"
                        >
                          {previewSending ? (
                            <>
                              <RefreshCw className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                              Sending…
                            </>
                          ) : (
                            <>
                              <Bell className="w-3.5 h-3.5 mr-1.5" />
                              Send test to me
                            </>
                          )}
                        </Button>
                        <Button
                          variant="outline"
                          className="border-white/10 text-white"
                          onClick={() => {
                            setPreviewKey(null);
                            setPreviewData(null);
                            setPreviewError(null);
                            setPreviewLoading(false);
                            // Task #2050 — clear comparison pane too so it
                            // doesn't bleed into the next preview session.
                            setCompareMode(false);
                            setCompareData(null);
                            setCompareError(null);
                            setCompareLoading(false);
                          }}
                          data-testid="button-preview-close"
                        >
                          Close
                        </Button>
                      </DialogFooter>
                    </DialogContent>
                  </Dialog>

                  {/* Task #1304 — Quick link to the in-app history view of
                      the daily ops alert (notification retry-exhaustion)
                      data, so admins can see trends and triage rows
                      without grepping email. */}
                  <div className="mt-4 border-t border-white/10 pt-3">
                    <a
                      href="/admin/notify-exhaustion-history"
                      data-testid="link-notify-exhaustion-history"
                      className="inline-flex items-center gap-2 text-xs text-sky-300 hover:text-sky-200"
                    >
                      <AlertTriangle className="w-3.5 h-3.5" />
                      View notification retry-exhaustion ops alert history
                    </a>
                    <p className="text-[11px] text-muted-foreground mt-1">
                      See recent days where coach-payout or levy-receipt
                      pushes / SMS exhausted their retries, and jump into
                      the affected rows for triage.
                    </p>
                  </div>

                  {/* Task #1501 — Quick link to the dedicated worklist of
                      wallet-withdrawal alert deliveries that exhausted
                      their retries. The cron pushes admins once when a
                      row gives up, this surface stops that push from
                      being the only chance to act. */}
                  <div className="mt-4 border-t border-white/10 pt-3">
                    <a
                      href="/admin/wallet-withdrawal-exhaustion-alerts"
                      data-testid="link-wallet-withdrawal-exhaustion-alerts"
                      className="inline-flex items-center gap-2 text-xs text-sky-300 hover:text-sky-200"
                    >
                      <AlertTriangle className="w-3.5 h-3.5" />
                      Failed wallet alert deliveries
                    </a>
                    <p className="text-[11px] text-muted-foreground mt-1">
                      Wallet-withdrawal confirmations whose email/push
                      retries exhausted. Review the failure, contact the
                      member, then mark the row followed up to clear it.
                    </p>
                  </div>
                </CardContent>
              </Card>
            )}

            {activeSection === 'shop' && (
              <div className="space-y-4">
                {/* KPI bar */}
                <div className="grid grid-cols-3 gap-3">
                  {[
                    { label: t('admin:shop.totalRevenue'), value: fmtPrice(shopRevenue, shopCurrency), icon: DollarSign, color: 'text-emerald-400' },
                    { label: t('admin:shop.ordersThisMonth'), value: String(ordersThisMonth), icon: ShoppingBag, color: 'text-primary' },
                    { label: t('admin:shop.pendingFulfillment'), value: String(pendingFulfillment), icon: Package, color: 'text-yellow-400' },
                  ].map(({ label, value, icon: Icon, color }) => (
                    <Card key={label} className="glass-card p-4">
                      <div className="flex items-center gap-2 mb-1">
                        <Icon className={`w-4 h-4 ${color}`} />
                        <p className="text-xs text-muted-foreground">{label}</p>
                      </div>
                      <p className={`text-xl font-bold ${color}`}>{value}</p>
                    </Card>
                  ))}
                </div>

                {/* Shiprocket integration status */}
                <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
                  <div className="flex items-center gap-2 mb-1">
                    <Package className="w-4 h-4 text-primary" />
                    <span className="text-sm font-semibold text-white">Shiprocket</span>
                    <Badge className="ml-auto text-[10px] border bg-blue-500/20 text-blue-400 border-blue-500/30">{t('admin:shop.selfManaged')}</Badge>
                  </div>
                  <p className="text-xs text-muted-foreground">{t('admin:shop.shiprocketDesc')}</p>
                </div>

                {/* Products */}
                <Card className="glass-card">
                  <CardHeader className="flex-row items-center justify-between pb-3">
                    <CardTitle className="text-white flex items-center gap-2 text-base"><ShoppingBag className="w-4 h-4 text-primary" /> {t('admin:shop.products')}</CardTitle>
                    <div className="flex gap-2">
                      <Button size="sm" className="bg-primary hover:bg-primary/90 text-white gap-1.5"
                        onClick={() => { setShopEditId(null); setShopProductForm(emptyProductForm); setShopProductDialog(true); }}>
                        <ShoppingBag className="w-3.5 h-3.5" /> {t('admin:shop.addProduct')}
                      </Button>
                    </div>
                  </CardHeader>
                  <CardContent className="p-0">
                    {shopProductsLoading ? (
                      <div className="p-8 text-center text-muted-foreground text-sm">{t('admin:shop.loadingProducts')}</div>
                    ) : shopProducts.length === 0 ? (
                      <div className="p-8 text-center text-muted-foreground text-sm">{t('admin:shop.noProducts')}</div>
                    ) : (
                      <Table>
                        <TableHeader>
                          <TableRow className="border-white/5">
                            <TableHead className="text-muted-foreground">{t('admin:shop.tableProduct')}</TableHead>
                            <TableHead className="text-muted-foreground">{t('admin:shop.tableCategory')}</TableHead>
                            <TableHead className="text-muted-foreground">{t('admin:shop.tablePrice')}</TableHead>
                            <TableHead className="text-muted-foreground">{t('admin:shop.tableFulfillment')}</TableHead>
                            <TableHead className="text-muted-foreground">{t('admin:shop.tableStatus')}</TableHead>
                            <TableHead />
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {shopProducts.map(p => (
                            <TableRow key={p.id} className="border-white/5">
                              <TableCell>
                                <div className="flex items-center gap-3">
                                  {p.imageUrl ? (
                                    <img src={p.imageUrl} alt={p.name} className="w-8 h-8 rounded-lg object-cover bg-white/5" />
                                  ) : (
                                    <div className="w-8 h-8 rounded-lg bg-white/5 flex items-center justify-center"><Package className="w-4 h-4 text-muted-foreground" /></div>
                                  )}
                                  <span className="text-white text-sm font-medium">{p.name}</span>
                                </div>
                              </TableCell>
                              <TableCell className="text-muted-foreground text-sm capitalize">{p.category}</TableCell>
                              <TableCell className="text-white text-sm">{fmtPrice(p.markupPrice, p.currency)}</TableCell>
                              <TableCell>
                                <Badge className={`text-xs border ${p.isActive ? 'bg-green-500/20 text-green-400 border-green-500/30' : 'bg-gray-500/20 text-gray-400 border-gray-500/30'}`}>
                                  {p.isActive ? t('admin:active') : t('admin:inactive')}
                                </Badge>
                              </TableCell>
                              <TableCell>
                                <div className="flex items-center gap-1">
                                  <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-muted-foreground hover:text-white"
                                    onClick={() => {
                                      setShopEditId(p.id);
                                      setShopProductForm({ name: p.name, description: p.description ?? '', imageUrl: p.imageUrl ?? '', category: p.category, basePrice: p.basePrice, markupPrice: p.markupPrice, currency: p.currency, sizes: p.sizes.join(', '), isActive: p.isActive });
                                      setShopProductDialog(true);
                                    }}>
                                    <Edit2 className="w-3.5 h-3.5" />
                                  </Button>
                                  <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-muted-foreground hover:text-red-400"
                                    onClick={() => deleteShopProduct(p.id)}>
                                    <Trash2 className="w-3.5 h-3.5" />
                                  </Button>
                                </div>
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    )}
                  </CardContent>
                </Card>

                {/* Orders */}
                <Card className="glass-card">
                  <CardHeader className="flex-row items-center justify-between pb-3">
                    <CardTitle className="text-white flex items-center gap-2 text-base"><Truck className="w-4 h-4 text-primary" /> {t('admin:shop.orders')}</CardTitle>
                    <Button size="sm" variant="ghost" className="text-muted-foreground hover:text-white gap-1.5"
                      onClick={() => refetchShopOrders()}>
                      <RefreshCw className="w-3.5 h-3.5" /> {t('admin:shop.refresh')}
                    </Button>
                  </CardHeader>
                  <CardContent className="p-0">
                    {shopOrdersLoading ? (
                      <div className="p-8 text-center text-muted-foreground text-sm">{t('admin:shop.loadingOrders')}</div>
                    ) : shopOrders.length === 0 ? (
                      <div className="p-8 text-center text-muted-foreground text-sm">{t('admin:shop.noOrders')}</div>
                    ) : (
                      <Table>
                        <TableHeader>
                          <TableRow className="border-white/5">
                            <TableHead className="text-muted-foreground">{t('admin:shop.tableCustomer')}</TableHead>
                            <TableHead className="text-muted-foreground">{t('admin:shop.tableProduct')}</TableHead>
                            <TableHead className="text-muted-foreground">{t('admin:shop.tableTotal')}</TableHead>
                            <TableHead className="text-muted-foreground">{t('admin:shop.tableStatus')}</TableHead>
                            <TableHead className="text-muted-foreground">{t('admin:shop.tableTracking')}</TableHead>
                            <TableHead className="text-muted-foreground">{t('admin:shop.tableDate')}</TableHead>
                            <TableHead />
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {shopOrders.map(o => (
                            <TableRow key={o.id} className="border-white/5">
                              <TableCell>
                                <div>
                                  <p className="text-white text-sm">{o.customerName}</p>
                                  <p className="text-xs text-muted-foreground">{o.customerEmail}</p>
                                </div>
                              </TableCell>
                              <TableCell className="text-muted-foreground text-sm">
                                {o.productName ?? '—'}{o.size ? ` / ${o.size}` : ''}{o.quantity > 1 ? ` ×${o.quantity}` : ''}
                              </TableCell>
                              <TableCell className="text-white text-sm">{fmtPrice(o.totalAmount, o.currency)}</TableCell>
                              <TableCell>
                                <Badge className={`text-xs border capitalize ${ORDER_STATUS_COLORS[o.status] ?? 'bg-gray-500/20 text-gray-400 border-gray-500/30'}`}>
                                  {o.status}
                                </Badge>
                              </TableCell>
                              <TableCell className="max-w-[180px]">
                                {o.trackingNumber ? (
                                  o.trackingUrl ? (
                                    <a href={o.trackingUrl} target="_blank" rel="noopener noreferrer" className="text-xs text-cyan-400 hover:text-cyan-300 font-mono truncate block max-w-[160px]">
                                      {o.trackingNumber}
                                    </a>
                                  ) : (
                                    <span className="text-xs text-muted-foreground font-mono truncate block max-w-[160px]">{o.trackingNumber}</span>
                                  )
                                ) : (
                                  <Input
                                    placeholder={t('admin:trackingPlaceholder')}
                                    className="h-7 text-xs bg-black/40 border-white/10 text-white w-36 font-mono"
                                    onBlur={async e => {
                                      const val = e.target.value.trim();
                                      if (!val || !orgId) return;
                                      await fetch(`/api/organizations/${orgId}/shop/orders/${o.id}`, {
                                        method: 'PATCH', credentials: 'include',
                                        headers: { 'Content-Type': 'application/json' },
                                        body: JSON.stringify({ trackingNumber: val, status: o.status === 'paid' || o.status === 'processing' ? 'shipped' : o.status }),
                                      });
                                      queryClient.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/shop/orders-admin`] });
                                      toast({ title: t('admin:toasts.trackingSaved') });
                                    }}
                                  />
                                )}
                              </TableCell>
                              <TableCell className="text-muted-foreground text-xs">
                                {new Date(o.createdAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}
                              </TableCell>
                              <TableCell>
                                <Button size="sm" variant="ghost" className="h-7 text-xs text-muted-foreground hover:text-white gap-1"
                                  onClick={() => {
                                    setShopTrackingOrder(o);
                                    setShopTrackingForm({ trackingNumber: o.trackingNumber ?? '', trackingUrl: o.trackingUrl ?? '', status: o.status });
                                    setShopTrackingDialog(true);
                                  }}>
                                  <Edit2 className="w-3 h-3" /> {t('admin:shop.edit')}
                                </Button>
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    )}
                  </CardContent>
                </Card>

                {/* Product add/edit dialog */}
                <Dialog open={shopProductDialog} onOpenChange={open => { if (!open && !shopSaving) setShopProductDialog(false); }}>
                  <DialogContent className="glass-panel border-white/10 sm:max-w-lg max-h-[90vh] overflow-y-auto">
                    <DialogHeader>
                      <DialogTitle className="text-white">{shopEditId ? t('admin:shop.editProduct') : t('admin:shop.addProduct')}</DialogTitle>
                    </DialogHeader>
                    <div className="space-y-3 mt-2">
                      {[
                        { label: t('admin:shop.productName'), key: 'name', placeholder: 'e.g. Club Polo Shirt' },
                        { label: t('admin:description'), key: 'description', placeholder: 'Short product description' },
                        { label: t('admin:shop.imageUrl'), key: 'imageUrl', placeholder: 'https://…' },
                        { label: t('admin:shop.basePrice'), key: 'basePrice', placeholder: '0' },
                        { label: t('admin:shop.sellingPrice'), key: 'markupPrice', placeholder: '0' },
                        { label: t('admin:shop.sizes'), key: 'sizes', placeholder: 'S, M, L, XL' },
                      ].map(({ label, key, placeholder }) => (
                        <div key={key}>
                          <label className="text-xs text-muted-foreground uppercase tracking-wider">{label}</label>
                          <Input
                            value={(shopProductForm as unknown as Record<string, string>)[key]}
                            onChange={e => setShopProductForm(f => ({ ...f, [key]: e.target.value }))}
                            placeholder={placeholder}
                            className="mt-1 bg-black/40 border-white/10 text-white"
                          />
                        </div>
                      ))}
                      <div>
                        <label className="text-xs text-muted-foreground uppercase tracking-wider">{t('admin:shop.category')}</label>
                        <Select value={shopProductForm.category} onValueChange={v => setShopProductForm(f => ({ ...f, category: v }))}>
                          <SelectTrigger className="mt-1 bg-black/40 border-white/10 text-white"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            {['apparel', 'headwear', 'accessories', 'drinkware', 'bags', 'other'].map(c => (
                              <SelectItem key={c} value={c} className="capitalize">{c}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div>
                        <label className="text-xs text-muted-foreground uppercase tracking-wider">{t('admin:shop.currency')}</label>
                        <Select value={shopProductForm.currency} onValueChange={v => setShopProductForm(f => ({ ...f, currency: v }))}>
                          <SelectTrigger className="mt-1 bg-black/40 border-white/10 text-white"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            {['INR', 'USD', 'GBP', 'EUR', 'AED', 'SGD', 'AUD'].map(c => (
                              <SelectItem key={c} value={c}>{c}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      {shopEditId && (
                        <div className="flex items-center gap-3 pt-1">
                          <label className="text-sm text-white">{t('admin:active')}</label>
                          <button
                            onClick={() => setShopProductForm(f => ({ ...f, isActive: !f.isActive }))}
                            className={`w-11 h-6 rounded-full transition-colors relative ${shopProductForm.isActive ? 'bg-primary' : 'bg-white/20'}`}
                          >
                            <span className={`block w-4 h-4 rounded-full bg-white shadow transition-transform absolute top-1 ${shopProductForm.isActive ? 'translate-x-6' : 'translate-x-1'}`} />
                          </button>
                        </div>
                      )}
                    </div>
                    <DialogFooter className="mt-4">
                      <Button variant="outline" className="border-white/10 text-white" onClick={() => setShopProductDialog(false)} disabled={shopSaving}>{t('admin:shop.cancel')}</Button>
                      <Button className="bg-primary hover:bg-primary/90 text-white" onClick={saveShopProduct} disabled={shopSaving}>
                        {shopSaving ? t('admin:saving') : shopEditId ? t('admin:shop.saveChanges') : t('admin:shop.createProduct')}
                      </Button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>

                {/* Order update dialog */}
                <Dialog open={shopTrackingDialog} onOpenChange={open => { if (!open && !shopUpdatingTracking) setShopTrackingDialog(false); }}>
                  <DialogContent className="glass-panel border-white/10 sm:max-w-md">
                    <DialogHeader>
                      <DialogTitle className="text-white">{t('admin:shop.updateOrderTitle', { id: shopTrackingOrder?.id })}</DialogTitle>
                    </DialogHeader>
                    <div className="space-y-3 mt-2">
                      <div>
                        <label className="text-xs text-muted-foreground uppercase tracking-wider">{t('admin:shop.tableStatus')}</label>
                        <Select value={shopTrackingForm.status} onValueChange={v => setShopTrackingForm(f => ({ ...f, status: v }))}>
                          <SelectTrigger className="mt-1 bg-black/40 border-white/10 text-white"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            {['pending', 'paid', 'processing', 'shipped', 'delivered', 'cancelled', 'refunded'].map(s => (
                              <SelectItem key={s} value={s} className="capitalize">{s}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div>
                        <label className="text-xs text-muted-foreground uppercase tracking-wider">{t('admin:shop.trackingNumber')}</label>
                        <Input value={shopTrackingForm.trackingNumber} onChange={e => setShopTrackingForm(f => ({ ...f, trackingNumber: e.target.value }))} placeholder="e.g. 1Z999AA10123456784" className="mt-1 bg-black/40 border-white/10 text-white" />
                      </div>
                      <div>
                        <label className="text-xs text-muted-foreground uppercase tracking-wider">{t('admin:shop.trackingUrl')}</label>
                        <Input value={shopTrackingForm.trackingUrl} onChange={e => setShopTrackingForm(f => ({ ...f, trackingUrl: e.target.value }))} placeholder="https://track.example.com/…" className="mt-1 bg-black/40 border-white/10 text-white" />
                      </div>
                    </div>
                    <DialogFooter className="mt-4">
                      <Button variant="outline" className="border-white/10 text-white" onClick={() => setShopTrackingDialog(false)} disabled={shopUpdatingTracking}>{t('admin:shop.cancel')}</Button>
                      <Button className="bg-primary hover:bg-primary/90 text-white" onClick={saveShopTracking} disabled={shopUpdatingTracking}>
                        {shopUpdatingTracking ? t('admin:saving') : t('admin:shop.save')}
                      </Button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>
              </div>
            )}

            {activeSection === 'subscription' && (
              <Card className="glass-card">
                <CardHeader><CardTitle className="text-white flex items-center gap-2"><CreditCard className="w-5 h-5 text-primary" /> {t('admin:subscription.title')}</CardTitle></CardHeader>
                <CardContent className="space-y-5">
                  <div className="flex items-center justify-between p-4 bg-white/[0.03] rounded-xl border border-white/10">
                    <div>
                      <p className="text-white font-semibold">{t('admin:subscription.currentPlan')}</p>
                      <p className="text-muted-foreground text-sm mt-0.5">{t('admin:subscription.activeTier')}</p>
                    </div>
                    <Badge className={`border capitalize ${tierBadgeColor[org?.subscriptionTier ?? 'free'] ?? tierBadgeColor.free}`}>
                      {org?.subscriptionTier ?? t('admin:subscription.free')}
                    </Badge>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {[
                      { tier: 'starter', label: 'Starter', price: '₹2,999/mo', features: ['5 Tournaments/mo', '100 Players', 'Basic Reports'] },
                      { tier: 'pro', label: 'Pro', price: '₹7,999/mo', features: ['Unlimited Tournaments', '500 Players', 'Full Analytics', 'White-label'] },
                      { tier: 'enterprise', label: 'Enterprise', price: 'Custom', features: ['Unlimited Everything', 'Dedicated Support', 'Custom Integrations', 'SLA'] },
                    ].map(plan => (
                      <div key={plan.tier} className={`p-4 rounded-xl border ${org?.subscriptionTier === plan.tier ? 'border-primary bg-primary/5' : 'border-white/10 bg-white/[0.02]'}`}>
                        <div className="flex items-start justify-between mb-3">
                          <div>
                            <p className="font-semibold text-white">{plan.label}</p>
                            <p className="text-primary text-sm font-medium">{plan.price}</p>
                          </div>
                          {org?.subscriptionTier === plan.tier && <Badge className="bg-primary/20 text-primary border-primary/30 text-xs">{t('admin:active')}</Badge>}
                        </div>
                        <ul className="space-y-1">
                          {plan.features.map(f => <li key={f} className="text-xs text-muted-foreground flex items-center gap-1.5"><Check className="w-3 h-3 text-primary flex-shrink-0" />{f}</li>)}
                        </ul>
                        {org?.subscriptionTier !== plan.tier && (
                          <Button size="sm" className="mt-3 w-full bg-white/5 hover:bg-white/10 text-white border border-white/10" onClick={() => toast({ title: t('admin:toasts.contactSupport'), description: t('admin:toasts.contactSupportEmail') })}>
                            <Zap className="w-3.5 h-3.5 mr-1.5" /> {t('admin:subscription.upgrade')}
                          </Button>
                        )}
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}

            {activeSection === 'ghin' && (
              <Card className="glass-card">
                <CardHeader>
                  <CardTitle className="text-white flex items-center gap-2">
                    <KeyRound className="w-5 h-5 text-emerald-400" /> {t('admin:ghin.integrationTitle')}
                  </CardTitle>
                  <p className="text-sm text-muted-foreground mt-1">
                    {t('admin:ghin.integrationDesc')}
                  </p>
                </CardHeader>
                <CardContent className="space-y-6">
                  {/* Current status */}
                  <div className="p-4 rounded-xl glass-panel space-y-2">
                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">{t('admin:ghin.credentialStatus')}</p>
                    <div className="flex items-center gap-2">
                      {ghinStatus?.hasOrgCredentials ? (
                        <><CheckCircle2 className="w-4 h-4 text-emerald-400" /><span className="text-sm text-emerald-400">{t('admin:ghin.orgCredsConfigured')}</span></>
                      ) : (
                        <><XCircle className="w-4 h-4 text-muted-foreground" /><span className="text-sm text-muted-foreground">{t('admin:ghin.noOrgCreds')}</span></>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      {ghinStatus?.hasEnvCredentials ? (
                        <><CheckCircle2 className="w-4 h-4 text-emerald-400" /><span className="text-sm text-emerald-400">{t('admin:ghin.globalCredsAvailable')}</span></>
                      ) : (
                        <><XCircle className="w-4 h-4 text-muted-foreground" /><span className="text-sm text-muted-foreground">{t('admin:ghin.noEnvCreds')}</span></>
                      )}
                    </div>
                    {!ghinStatus?.configured && (
                      <div className="mt-3 p-3 rounded-lg bg-red-500/10 border border-red-500/20">
                        <p className="text-xs text-red-400">{t('admin:ghin.noGhinConfigured')}</p>
                      </div>
                    )}
                  </div>

                  {/* Encryption key warning */}
                  {ghinStatus && !ghinStatus.canStoreOrgCredentials && (
                    <div className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/20">
                      <p className="text-xs font-semibold text-amber-400 mb-1">{t('admin:ghin.encKeyMissing')}</p>
                      <p className="text-xs text-muted-foreground">
                        {t('admin:ghin.encKeyDesc')}
                        {ghinStatus.hasEnvCredentials && t('admin:ghin.encKeyFallback')}
                      </p>
                    </div>
                  )}

                  {/* Set/update credentials */}
                  <div className="space-y-4">
                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                      {ghinStatus?.hasOrgCredentials ? t('admin:ghin.updateCreds') : t('admin:ghin.setCreds')}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {t('admin:ghin.credDesc')}
                    </p>
                    <div className="space-y-3">
                      <div className="space-y-1">
                        <label className="text-xs font-medium text-muted-foreground">{t('admin:ghin.apiKey')}</label>
                        <Input
                          value={ghinCreds.apiKey}
                          onChange={e => setGhinCreds(p => ({ ...p, apiKey: e.target.value }))}
                          placeholder={t('admin:ghin.apiKeyPlaceholder')}
                          className="bg-black/50 border-white/10 text-white font-mono text-sm"
                          autoComplete="off"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs font-medium text-muted-foreground">{t('admin:ghin.username')}</label>
                        <Input
                          value={ghinCreds.username}
                          onChange={e => setGhinCreds(p => ({ ...p, username: e.target.value }))}
                          placeholder="software@yourclub.com"
                          type="email"
                          className="bg-black/50 border-white/10 text-white text-sm"
                          autoComplete="off"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs font-medium text-muted-foreground">{t('admin:ghin.password')}</label>
                        <div className="relative">
                          <Input
                            value={ghinCreds.password}
                            onChange={e => setGhinCreds(p => ({ ...p, password: e.target.value }))}
                            placeholder={t('admin:ghin.passwordPlaceholder')}
                            type={showGhinPassword ? 'text' : 'password'}
                            className="bg-black/50 border-white/10 text-white text-sm pr-10"
                            autoComplete="new-password"
                          />
                          <button
                            type="button"
                            onClick={() => setShowGhinPassword(v => !v)}
                            className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-white"
                          >
                            {showGhinPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                          </button>
                        </div>
                      </div>
                    </div>
                    <div className="flex gap-3">
                      <Button
                        onClick={saveGhinCredentials}
                        disabled={savingGhin || !ghinCreds.apiKey || !ghinCreds.username || !ghinCreds.password || ghinStatus?.canStoreOrgCredentials === false}
                        title={ghinStatus?.canStoreOrgCredentials === false ? t('admin:ghin.encKeyMissing') : undefined}
                        className="bg-emerald-600 hover:bg-emerald-700 text-white"
                      >
                        {savingGhin ? t('admin:saving') : t('admin:ghin.saveCredentials')}
                      </Button>
                      {ghinStatus?.hasOrgCredentials && (
                        <Button
                          variant="outline"
                          onClick={deleteGhinCredentials}
                          disabled={deletingGhin}
                          className="border-red-500/30 text-red-400 hover:bg-red-500/10 gap-2"
                        >
                          <Trash2 className="w-4 h-4" />
                          {deletingGhin ? t('admin:ghin.removing') : t('admin:ghin.removeCredentials')}
                        </Button>
                      )}
                    </div>
                  </div>

                  {/* Test Connection */}
                  {ghinStatus?.configured && (
                    <div className="space-y-3">
                      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">{t('admin:ghin.connectionTest')}</p>
                      <p className="text-xs text-muted-foreground">
                        {t('admin:ghin.connectionTestDesc')}
                      </p>
                      <Button
                        variant="outline"
                        onClick={testGhinConnection}
                        disabled={testingGhin}
                        className="border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/10 gap-2"
                      >
                        <RefreshCw className={`w-4 h-4 ${testingGhin ? 'animate-spin' : ''}`} />
                        {testingGhin ? t('admin:ghin.testing') : t('admin:ghin.testConnection')}
                      </Button>
                      {ghinTestResult && (
                        <div className={`p-3 rounded-lg border text-sm ${ghinTestResult.success ? 'border-emerald-500/30 bg-emerald-500/5' : 'border-red-500/30 bg-red-500/5'}`}>
                          {ghinTestResult.success ? (
                            <div className="flex items-start gap-2">
                              <CheckCircle2 className="w-4 h-4 text-emerald-400 mt-0.5 flex-shrink-0" />
                              <div>
                                <p className="text-emerald-400 font-medium">{ghinTestResult.message}</p>
                                <p className="text-xs text-muted-foreground mt-0.5">
                                  {t(ghinTestResult.membersWithGhin !== 1 ? 'admin:ghin.playersWithGhin_plural' : 'admin:ghin.playersWithGhin', { count: ghinTestResult.membersWithGhin ?? 0 })}
                                </p>
                              </div>
                            </div>
                          ) : (
                            <div className="flex items-start gap-2">
                              <XCircle className="w-4 h-4 text-red-400 mt-0.5 flex-shrink-0" />
                              <p className="text-red-400">{ghinTestResult.error}</p>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </CardContent>
              </Card>
            )}

            {activeSection === 'danger' && (
              <Card className="glass-card border-destructive/30">
                <CardHeader><CardTitle className="text-destructive flex items-center gap-2"><AlertTriangle className="w-5 h-5" /> {t('admin:danger.title')}</CardTitle></CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex items-center justify-between p-4 rounded-xl border border-destructive/20 bg-destructive/5">
                    <div>
                      <p className="font-semibold text-white">{t('admin:danger.deactivateTitle')}</p>
                      <p className="text-sm text-muted-foreground mt-0.5">{t('admin:danger.deactivateDesc')}</p>
                    </div>
                    <Button variant="outline" className="border-destructive/50 text-destructive hover:bg-destructive/10" onClick={() => toast({ title: t('admin:toasts.contactSupportDeactivate'), description: t('admin:toasts.contactSupportDeactivateEmail') })}>
                      {t('admin:danger.deactivate')}
                    </Button>
                  </div>
                  <div className="flex items-center justify-between p-4 rounded-xl border border-destructive/20 bg-destructive/5">
                    <div>
                      <p className="font-semibold text-white">{t('admin:exportData')}</p>
                      <p className="text-sm text-muted-foreground mt-0.5">{t('admin:danger.exportDesc')}</p>
                    </div>
                    <Button variant="outline" className="border-white/20 text-white hover:bg-white/5" onClick={() => toast({ title: t('admin:toasts.exportRequested'), description: t('admin:toasts.exportDesc') })}>
                      <Shield className="w-4 h-4 mr-2" /> {t('admin:export')}
                    </Button>
                  </div>
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Task #581 — Cert provisioning state badge for the configured custom
 * domain. Polls the status endpoint while the cert is pending so the
 * indicator transitions from "pending" to "active" without a refresh,
 * and exposes a Retry button when the ingress provider reported a
 * failure.
 */
// Task #2127 — humanise an absolute "completedAt" timestamp into a short
// "3d ago" / "5h ago" / "12m ago" / "just now" badge for the swing-fps
// probe failures table. Inlined here (rather than imported from a shared
// util) to match the pattern used by the other admin/super-admin pages
// — none of which pull in a date library for this single use.
function formatProbeFailureAge(iso: string, nowMs: number = Date.now()): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return iso;
  const diffSec = Math.max(0, Math.round((nowMs - t) / 1000));
  if (diffSec < 5) return 'just now';
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.round(diffHr / 24);
  return `${diffDay}d ago`;
}

function formatNextRenudge(iso: string, t: (k: string, opts?: Record<string, unknown>) => string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return t('admin:certStatus.nextRenudgeOverdue');
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return t('admin:certStatus.nextRenudgeMinutes', { count: minutes });
  const hours = Math.round(ms / 3_600_000);
  if (hours < 48) return t('admin:certStatus.nextRenudgeHours', { count: hours });
  const days = Math.round(ms / 86_400_000);
  return t('admin:certStatus.nextRenudgeDays', { count: days });
}

function CustomDomainCertStatus({ orgId }: { orgId: number | undefined }) {
  const { t } = useTranslation(['admin']);
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [retrying, setRetrying] = useState(false);
  // Task #1261 — separate busy flag for the snooze controls so the
  // "Snooze re-nudge" / "Cancel snooze" buttons don't spin in lockstep
  // with the unrelated Retry button next to them.
  const [snoozing, setSnoozing] = useState(false);
  // Task #1481 — admin-selected snooze window. Defaults to the
  // platform default (14 days) so the chooser starts on the same value
  // the original single-button shipped with; the user can pick a
  // shorter (7) or longer (30 / 90) preset for shorter pauses or
  // longer DNS migrations.
  const [snoozeDays, setSnoozeDays] = useState<number>(CUSTOM_DOMAIN_RENUDGE_SNOOZE_DAYS);

  type CertState = {
    customDomain: string | null;
    status: 'none' | 'pending' | 'active' | 'failed';
    provider: string | null;
    error: string | null;
    requestedAt: string | null;
    issuedAt: string | null;
    checkedAt: string | null;
    // Task #818 — last admin-email record for HTTPS lifecycle.
    notifiedStatus: 'active' | 'failed' | null;
    notifiedHost: string | null;
    notifiedAt: string | null;
    // Task #1100 — when the platform will email admins again about a
    // still-failing HTTPS cert. Null when no re-nudge is scheduled.
    nextRenudgeAt: string | null;
    // Task #1261 — active re-nudge snooze. Set by POST /snooze-renudge,
    // cleared by DELETE /snooze-renudge or any path that flips the cert
    // back to 'active'. Null when no snooze is in effect.
    renudgeSnoozedUntil: string | null;
    // Task #1482 — when the most recent re-nudge fired because an
    // admin-set snooze had just elapsed, this carries the original
    // snooze-until date so the panel can render a one-line banner
    // mirroring the email body. Null when no snooze just ended, or
    // when the banner has aged past the server-side TTL, or when the
    // admin has already acted (retry / re-snooze / cancel-snooze /
    // domain change). Same date the email's snoozeEnded line shows.
    snoozeEndedFromUntil: string | null;
  };

  const { data, refetch } = useQuery<CertState>({
    queryKey: [`/api/organizations/${orgId}/custom-domain/status`],
    queryFn: () => fetch(`/api/organizations/${orgId}/custom-domain/status`, { credentials: 'include' })
      .then(r => { if (!r.ok) throw new Error('Request failed'); return r.json(); }),
    enabled: !!orgId,
    refetchInterval: (q) => (q.state.data?.status === 'pending' ? 5000 : false),
  });

  if (!data || !data.customDomain) return null;

  const onRetry = async () => {
    if (!orgId) return;
    setRetrying(true);
    try {
      const res = await fetch(`/api/organizations/${orgId}/custom-domain/retry`, {
        method: 'POST',
        credentials: 'include',
      });
      if (!res.ok) throw new Error('retry failed');
      await refetch();
      await queryClient.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/custom-domain/status`] });
      toast({ title: t('admin:certStatus.retryQueued') });
    } catch {
      toast({ title: t('admin:certStatus.retryFailed'), variant: 'destructive' });
    } finally {
      setRetrying(false);
    }
  };

  // Task #1261 — POST /snooze-renudge with the admin-chosen window.
  // Refresh the status query on success so the panel immediately swaps
  // the "Snooze re-nudge" button for the "snoozed until …" line + Cancel
  // button without waiting for the next poll.
  // Task #1481 — the body now carries the admin-selected `days` value
  // from the chooser instead of relying on the server-side default.
  const onSnooze = async () => {
    if (!orgId) return;
    setSnoozing(true);
    try {
      const res = await fetch(`/api/organizations/${orgId}/custom-domain/snooze-renudge`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ days: snoozeDays }),
      });
      if (!res.ok) throw new Error('snooze failed');
      await refetch();
      await queryClient.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/custom-domain/status`] });
      toast({ title: t('admin:certStatus.snoozeQueued') });
    } catch {
      toast({ title: t('admin:certStatus.snoozeFailed'), variant: 'destructive' });
    } finally {
      setSnoozing(false);
    }
  };

  // Task #1261 — DELETE /snooze-renudge clears the snooze immediately.
  const onCancelSnooze = async () => {
    if (!orgId) return;
    setSnoozing(true);
    try {
      const res = await fetch(`/api/organizations/${orgId}/custom-domain/snooze-renudge`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!res.ok) throw new Error('cancel failed');
      await refetch();
      await queryClient.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/custom-domain/status`] });
      toast({ title: t('admin:certStatus.snoozeCancelled') });
    } catch {
      toast({ title: t('admin:certStatus.snoozeCancelFailed'), variant: 'destructive' });
    } finally {
      setSnoozing(false);
    }
  };

  const config: Record<CertState['status'], { label: string; className: string; Icon: typeof CheckCircle2 }> = {
    active:  { label: t('admin:certStatus.active'),  className: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30', Icon: CheckCircle2 },
    pending: { label: t('admin:certStatus.pending'), className: 'bg-amber-500/15 text-amber-300 border-amber-500/30',     Icon: RefreshCw     },
    failed:  { label: t('admin:certStatus.failed'),  className: 'bg-red-500/15 text-red-300 border-red-500/30',           Icon: XCircle       },
    none:    { label: t('admin:certStatus.none'),    className: 'bg-white/5 text-muted-foreground border-white/10',       Icon: Shield        },
  };
  const c = config[data.status];

  return (
    <div className="bg-black/40 rounded-xl p-4 border border-white/10 space-y-3" data-testid="custom-domain-cert-status">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold border ${c.className}`}
            data-testid={`cert-status-badge-${data.status}`}>
            <c.Icon className={`w-3.5 h-3.5 ${data.status === 'pending' ? 'animate-spin' : ''}`} />
            {c.label}
          </span>
          <span className="text-sm text-muted-foreground">{data.customDomain}</span>
        </div>
        {data.status !== 'active' && (
          <Button size="sm" variant="outline" className="border-white/20 text-white hover:bg-white/5"
            disabled={retrying} onClick={onRetry} data-testid="cert-status-retry">
            <RefreshCw className={`w-3.5 h-3.5 mr-1.5 ${retrying ? 'animate-spin' : ''}`} />
            {t('admin:certStatus.retry')}
          </Button>
        )}
      </div>
      {/* Task #1482 — One-line banner mirroring the resumed re-nudge
          email's "you snoozed this until X — that snooze has now ended"
          header. Rendered above the failure summary so an admin who
          only checks the dashboard (and never opens the email) sees
          the same acknowledgement and immediately understands why
          re-nudges are back. The server hides the field once the
          banner is older than its TTL and on every admin action, so
          the banner auto-disappears the moment the admin acts. */}
      {data.snoozeEndedFromUntil && (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2"
             data-testid="cert-status-snooze-ended-banner">
          <p className="text-[11px] text-amber-200/95">
            {t('admin:certStatus.snoozeEndedBanner', {
              when: new Date(data.snoozeEndedFromUntil).toLocaleString(),
            })}
          </p>
        </div>
      )}
      {data.error && (
        <p className="text-xs text-red-300/90" data-testid="cert-status-error">{data.error}</p>
      )}
      {data.provider && (
        <p className="text-[11px] text-muted-foreground">
          {t('admin:certStatus.provider', { provider: data.provider })}
        </p>
      )}
      <p className="text-[11px] text-muted-foreground/80" data-testid="cert-status-email-note">
        {t('admin:certStatus.emailNote')}
      </p>
      {data.notifiedAt && data.notifiedStatus && (
        <p className="text-[11px] text-muted-foreground/80" data-testid="cert-status-last-notified">
          {t(
            data.notifiedStatus === 'active'
              ? 'admin:certStatus.lastNotifiedActive'
              : 'admin:certStatus.lastNotifiedFailed',
            { when: new Date(data.notifiedAt).toLocaleString() },
          )}
        </p>
      )}
      {/* Task #1100 — show how long until the next HTTPS re-nudge email so
          admins know when to expect another reminder (and don't ping
          support asking "did you get my email?"). Task #1261 — when an
          admin has snoozed the re-nudge we hide the ETA line entirely
          and replace it with the "snoozed until …" line + Cancel button
          so the panel doesn't contradict itself. */}
      {data.status === 'failed' && !isSnoozeActive(data.renudgeSnoozedUntil) && (
        <p className="text-[11px] text-muted-foreground/80" data-testid="cert-status-next-renudge">
          {data.nextRenudgeAt
            ? t('admin:certStatus.nextRenudge', {
                relative: formatNextRenudge(data.nextRenudgeAt, t),
                when: new Date(data.nextRenudgeAt).toLocaleString(),
              })
            : t('admin:certStatus.nextRenudgeNone')}
        </p>
      )}
      {/* Task #1261 — Snooze controls. Only meaningful while the cert
          is in 'failed' state: the snooze auto-clears whenever the
          cert flips to 'active', and offering a "snooze for 14 days"
          button on a healthy domain would just confuse admins. */}
      {data.status === 'failed' && (
        isSnoozeActive(data.renudgeSnoozedUntil) ? (
          <div className="flex flex-wrap items-center justify-between gap-2 pt-1"
               data-testid="cert-status-snooze-active">
            <p className="text-[11px] text-amber-300/90" data-testid="cert-status-snoozed-until">
              {t('admin:certStatus.snoozedUntil', {
                when: new Date(data.renudgeSnoozedUntil!).toLocaleString(),
              })}
            </p>
            <Button size="sm" variant="outline"
              className="border-white/20 text-white hover:bg-white/5"
              disabled={snoozing}
              onClick={onCancelSnooze}
              data-testid="cert-status-cancel-snooze">
              <XCircle className="w-3.5 h-3.5 mr-1.5" />
              {t('admin:certStatus.cancelSnooze')}
            </Button>
          </div>
        ) : (
          // Task #1481 — duration chooser + snooze button. Admins can
          // pick a 7 / 14 / 30 / 90 day window before clicking Snooze;
          // the API already accepts any value 1–90 so the four presets
          // cover the common short-pause and long-DNS-migration cases.
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <label className="text-[11px] text-muted-foreground"
              htmlFor="cert-status-snooze-duration"
              data-testid="cert-status-snooze-duration-label">
              {t('admin:certStatus.snoozeDurationLabel')}
            </label>
            <Select
              value={String(snoozeDays)}
              onValueChange={(v) => setSnoozeDays(Number(v))}
              disabled={snoozing}>
              <SelectTrigger
                id="cert-status-snooze-duration"
                className="h-8 w-[110px] bg-black/40 border-white/20 text-white text-xs"
                data-testid="cert-status-snooze-duration">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CUSTOM_DOMAIN_RENUDGE_SNOOZE_OPTIONS.map((d) => (
                  <SelectItem
                    key={d}
                    value={String(d)}
                    data-testid={`cert-status-snooze-duration-option-${d}`}>
                    {t('admin:certStatus.snoozeDurationOption', { count: d })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button size="sm" variant="outline"
              className="border-white/20 text-white hover:bg-white/5"
              disabled={snoozing}
              onClick={onSnooze}
              data-testid="cert-status-snooze">
              <Shield className="w-3.5 h-3.5 mr-1.5" />
              {t('admin:certStatus.snoozeRenudge', { count: snoozeDays })}
            </Button>
          </div>
        )
      )}
    </div>
  );
}

// Task #1261 — Default snooze window matches the API's
// CUSTOM_DOMAIN_HTTPS_RENUDGE_SNOOZE_DEFAULT_DAYS so the button label
// ("Snooze for 14 days") and the actual server-side snooze stay in
// sync. Kept as a plain const here rather than imported from the API
// package to avoid pulling server-only deps into the web bundle.
const CUSTOM_DOMAIN_RENUDGE_SNOOZE_DAYS = 14;
// Task #1481 — Preset snooze windows offered in the duration chooser.
// Covers a short pause (7), the default (14), a typical DNS-migration
// window (30), and the API's hard cap (90 = CUSTOM_DOMAIN_HTTPS_
// RENUDGE_SNOOZE_MAX_DAYS). Every value is within the server's 1–90
// validated range so any pick will be accepted by the API.
const CUSTOM_DOMAIN_RENUDGE_SNOOZE_OPTIONS = [7, 14, 30, 90] as const;

// Snooze is only "active" while the recorded until-timestamp is in the
// future. A past timestamp means the snooze has elapsed and re-nudging
// has resumed (the server clears the value lazily / on the next cron),
// so the UI should already be back to its non-snoozed shape.
function isSnoozeActive(snoozedUntil: string | null | undefined): boolean {
  if (!snoozedUntil) return false;
  return new Date(snoozedUntil).getTime() > Date.now();
}

/**
 * Task #662 — On-demand custom-domain reachability check. Hits the API's
 * `/marketing-site/verify-domain` endpoint, which performs a DNS lookup
 * against the saved hostname and an HTTPS request to the public mini-site
 * via that domain. Surfaces a colored status badge ("Live", "Pending DNS",
 * "Mismatch", "Unreachable") plus the server's plain-language explanation
 * of what's wrong and how to fix it. Independent of the cert provisioning
 * status above: a domain can have HTTPS provisioned and still fail this
 * end-to-end check (e.g. CNAME pointing somewhere else, DNS not propagated
 * to public resolvers yet).
 */
function CustomDomainReachabilityStatus({
  orgId,
  customDomain,
}: { orgId: number | undefined; customDomain: string | null }) {
  const { t } = useTranslation(['admin']);
  const { toast } = useToast();
  type VerifyState = {
    status: 'none' | 'live' | 'pending_dns' | 'mismatch' | 'unreachable';
    customDomain: string | null;
    expectedTarget: string | null;
    dns: { records: string[]; recordType: 'CNAME' | 'A' | null; matched: boolean | null; error: string | null } | null;
    https: { status: number | null; ok: boolean; error: string | null; returnedOrgId: number | null; returnedSlug: string | null } | null;
    message: string | null;
    checkedAt: string;
  };
  const [data, setData] = useState<VerifyState | null>(null);
  const [checking, setChecking] = useState(false);

  const runCheck = useCallback(async (silent = false) => {
    if (!orgId) return;
    setChecking(true);
    try {
      const res = await fetch(`/api/organizations/${orgId}/marketing-site/verify-domain`, {
        method: 'POST',
        credentials: 'include',
      });
      if (!res.ok) throw new Error('verify failed');
      const body = (await res.json()) as VerifyState;
      setData(body);
    } catch {
      if (!silent) toast({ title: t('admin:domainVerify.checkFailed'), variant: 'destructive' });
    } finally {
      setChecking(false);
    }
  }, [orgId, t, toast]);

  // Auto-run one verification on mount/when the saved domain changes so
  // admins immediately see whether their domain is live, without having
  // to click Re-check first. Errors are swallowed silently here — the
  // manual button surfaces them on demand.
  useEffect(() => {
    if (!orgId || !customDomain) return;
    void runCheck(true);
  }, [orgId, customDomain, runCheck]);

  if (!customDomain) return null;

  const status = data?.status ?? 'unknown';
  const config: Record<string, { label: string; className: string; Icon: typeof CheckCircle2 }> = {
    live:        { label: t('admin:domainVerify.live'),        className: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30', Icon: CheckCircle2  },
    pending_dns: { label: t('admin:domainVerify.pendingDns'),  className: 'bg-amber-500/15 text-amber-300 border-amber-500/30',       Icon: RefreshCw     },
    mismatch:    { label: t('admin:domainVerify.mismatch'),    className: 'bg-orange-500/15 text-orange-300 border-orange-500/30',    Icon: AlertTriangle },
    unreachable: { label: t('admin:domainVerify.unreachable'), className: 'bg-red-500/15 text-red-300 border-red-500/30',             Icon: XCircle       },
    unknown:     { label: t('admin:domainVerify.unknown'),     className: 'bg-white/5 text-muted-foreground border-white/10',         Icon: Globe         },
    none:        { label: t('admin:domainVerify.unknown'),     className: 'bg-white/5 text-muted-foreground border-white/10',         Icon: Globe         },
  };
  const c = config[status];

  return (
    <div className="bg-black/40 rounded-xl p-4 border border-white/10 space-y-3"
      data-testid="custom-domain-verify-status">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3 min-w-0">
          <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold border ${c.className}`}
            data-testid={`domain-verify-badge-${status}`}>
            <c.Icon className={`w-3.5 h-3.5 ${checking && status === 'unknown' ? 'animate-spin' : ''}`} />
            {c.label}
          </span>
          <span className="text-sm text-muted-foreground truncate">
            {t('admin:domainVerify.heading')}
          </span>
        </div>
        <Button size="sm" variant="outline" className="border-white/20 text-white hover:bg-white/5 shrink-0"
          disabled={checking} onClick={() => { void runCheck(); }} data-testid="domain-verify-recheck">
          <RefreshCw className={`w-3.5 h-3.5 mr-1.5 ${checking ? 'animate-spin' : ''}`} />
          {checking ? t('admin:domainVerify.checking') : t('admin:domainVerify.recheck')}
        </Button>
      </div>
      {data?.message && (
        <p className="text-xs text-muted-foreground" data-testid="domain-verify-message">
          {data.message}
        </p>
      )}
      {data?.dns && (
        <p className="text-[11px] text-muted-foreground">
          <span className="font-semibold text-white/70">{t('admin:domainVerify.dnsLabel')}:</span>{' '}
          {data.dns.records.length === 0
            ? t('admin:domainVerify.noRecords')
            : `${data.dns.recordType ?? ''} → ${data.dns.records.join(', ')}`}
        </p>
      )}
      {data?.expectedTarget && (
        <p className="text-[11px] text-muted-foreground">
          {t('admin:domainVerify.expectedTarget', { target: data.expectedTarget })}
        </p>
      )}
      {data?.checkedAt && (
        <p className="text-[11px] text-muted-foreground/70">
          {t('admin:domainVerify.lastChecked', { when: new Date(data.checkedAt).toLocaleString() })}
        </p>
      )}
    </div>
  );
}
