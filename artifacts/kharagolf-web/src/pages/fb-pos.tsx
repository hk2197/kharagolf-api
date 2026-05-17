import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useGetMe } from '@workspace/api-client-react';
import {
  Plus, Minus, Trash2, ShoppingCart, Coffee, Users as UsersIcon,
  X, Receipt, Split, ArrowRightLeft, Search,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';

interface Category { id: number; name: string; sortOrder: number; isActive: boolean }
interface ModifierOption { id: number; groupId: number; name: string; priceDelta: string; isAvailable: boolean }
interface ModifierGroup {
  id: number; name: string; selectionType: 'single' | 'multiple';
  isRequired: boolean; minSelections: number; maxSelections?: number | null;
  options: ModifierOption[];
}
interface MenuItem {
  id: number; name: string; description?: string; price: string; currency: string;
  isAvailable: boolean; categoryId?: number;
  modifierGroupIds?: number[];
}
interface Tab {
  id: number; tableLabel: string; guestName?: string | null; partySize?: number;
  status: 'open' | 'closed' | 'voided'; clubMemberId?: number | null;
  serverUserId?: number | null; openedAt: string;
}
interface TabOrderItem {
  id: number; menuItemId: number; name: string; price: string;
  quantity: number; modifiers?: { name: string; priceDelta: string }[] | null;
  modifierTotal?: string;
}
interface TabOrder {
  id: number; status: string; totalAmount: string; currency: string;
  createdAt: string; items: TabOrderItem[];
}
interface TabDetail extends Tab {
  orders: TabOrder[];
  subtotal: string;
}
interface ClubMember { id: number; firstName: string; lastName: string; email?: string }

interface CartLine {
  key: string; // unique line id
  menuItemId: number; name: string; price: string; currency: string;
  quantity: number;
  modifiers: { groupId?: number; optionId: number; name: string; priceDelta: string }[];
  notes?: string;
}

function fmt(n: number | string, currency = 'INR') {
  const v = typeof n === 'string' ? parseFloat(n) : n;
  return currency === 'INR' ? `₹${v.toFixed(2)}` : `${currency} ${v.toFixed(2)}`;
}
function lineTotal(l: CartLine): number {
  const mod = l.modifiers.reduce((s, m) => s + parseFloat(m.priceDelta || '0'), 0);
  return (parseFloat(l.price) + mod) * l.quantity;
}

export default function FbPosPage() {
  const { toast } = useToast();
  const { data: user } = useGetMe();
  const orgId = user?.organizationId;
  const [mode, setMode] = useState<'counter' | 'table'>('counter');

  // ─── Menu, modifiers, categories ──────────────────────────────────────────
  const { data: menuData } = useQuery<{ items: MenuItem[]; categories: Category[] }>({
    queryKey: [`fb-menu-pos-${orgId}`],
    queryFn: () => fetch(`/api/organizations/${orgId}/fb/menu?currentOnly=1`).then(r => r.json()),
    enabled: !!orgId,
  });
  const menuItems = menuData?.items ?? [];
  const categories = menuData?.categories ?? [];
  const { data: modGroups = [] } = useQuery<ModifierGroup[]>({
    queryKey: [`fb-mod-groups-${orgId}`],
    queryFn: () => fetch(`/api/organizations/${orgId}/fb/modifier-groups`).then(r => r.json()),
    enabled: !!orgId,
  });
  const modGroupMap = useMemo(() => new Map(modGroups.map(g => [g.id, g])), [modGroups]);

  const [search, setSearch] = useState('');
  const [activeCategory, setActiveCategory] = useState<number | 'all'>('all');
  const visibleItems = menuItems.filter(it => {
    if (!it.isAvailable) return false;
    if (activeCategory !== 'all' && it.categoryId !== activeCategory) return false;
    if (search && !it.name.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  // ─── Cart (shared between counter and "add to tab") ───────────────────────
  const [cart, setCart] = useState<CartLine[]>([]);
  // Modifier dialog
  const [modItem, setModItem] = useState<MenuItem | null>(null);
  const [modSelection, setModSelection] = useState<Record<number, number[]>>({}); // groupId -> optionIds
  const [modNotes, setModNotes] = useState('');

  function startAddItem(item: MenuItem) {
    const groups = (item.modifierGroupIds ?? []).map(id => modGroupMap.get(id)).filter(Boolean) as ModifierGroup[];
    if (groups.length === 0) {
      addToCart(item, [], '');
    } else {
      setModItem(item);
      const init: Record<number, number[]> = {};
      groups.forEach(g => { init[g.id] = []; });
      setModSelection(init);
      setModNotes('');
    }
  }
  function confirmModifiers() {
    if (!modItem) return;
    const groups = (modItem.modifierGroupIds ?? []).map(id => modGroupMap.get(id)).filter(Boolean) as ModifierGroup[];
    const flat: { groupId: number; optionId: number; name: string; priceDelta: string }[] = [];
    for (const g of groups) {
      const sel = modSelection[g.id] ?? [];
      if (g.isRequired && sel.length < (g.minSelections || 1)) {
        toast({ title: `Select at least ${g.minSelections || 1} option for "${g.name}"`, variant: 'destructive' });
        return;
      }
      for (const optId of sel) {
        const opt = g.options.find(o => o.id === optId);
        if (opt) flat.push({ groupId: g.id, optionId: optId, name: opt.name, priceDelta: opt.priceDelta });
      }
    }
    addToCart(modItem, flat, modNotes);
    setModItem(null);
  }
  function addToCart(item: MenuItem, modifiers: CartLine['modifiers'], notes: string) {
    const key = `${item.id}-${Date.now()}-${Math.random().toString(36).slice(2,7)}`;
    setCart(c => [...c, { key, menuItemId: item.id, name: item.name, price: item.price, currency: item.currency, quantity: 1, modifiers, notes: notes || undefined }]);
  }
  function changeQty(key: string, delta: number) {
    setCart(c => c.flatMap(l => {
      if (l.key !== key) return [l];
      const q = l.quantity + delta;
      return q <= 0 ? [] : [{ ...l, quantity: q }];
    }));
  }
  const cartTotal = cart.reduce((s, l) => s + lineTotal(l), 0);
  const currency = cart[0]?.currency ?? 'INR';

  // ─── Counter checkout ─────────────────────────────────────────────────────
  const [showCheckout, setShowCheckout] = useState(false);
  const [counterPay, setCounterPay] = useState<'card_on_delivery' | 'account_charge'>('card_on_delivery');
  const [counterMember, setCounterMember] = useState<number | null>(null);
  const [counterNotes, setCounterNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const { data: members = [] } = useQuery<ClubMember[]>({
    queryKey: [`club-members-${orgId}`],
    queryFn: async () => {
      const r = await fetch(`/api/organizations/${orgId}/club-members`);
      if (!r.ok) return [];
      return r.json();
    },
    enabled: !!orgId,
  });

  async function submitCounterOrder() {
    if (cart.length === 0) return;
    if (counterPay === 'account_charge' && !counterMember) {
      toast({ title: 'Select a club member', variant: 'destructive' }); return;
    }
    setSubmitting(true);
    try {
      const items = cart.map(l => ({
        menuItemId: l.menuItemId, quantity: l.quantity,
        modifiers: l.modifiers.map(m => ({ optionId: m.optionId })),
        notes: l.notes,
      }));
      const r = await fetch(`/api/organizations/${orgId}/fb/orders`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          orderType: 'counter', paymentMethod: counterPay,
          notes: counterNotes || undefined,
          items,
          ...(counterPay === 'account_charge' && counterMember ? { /* member is via tab close usually; counter account_charge keys to caller */ } : {}),
        }),
      });
      if (!r.ok) throw new Error('Order failed');
      const ord = await r.json();
      toast({ title: `Order #${ord.id} sent to kitchen`, description: fmt(cartTotal, currency) });
      setCart([]); setShowCheckout(false); setCounterMember(null); setCounterNotes('');
    } catch {
      toast({ title: 'Order failed', variant: 'destructive' });
    } finally { setSubmitting(false); }
  }

  // ─── Table mode: tabs ─────────────────────────────────────────────────────
  const { data: openTabs = [], refetch: refetchTabs } = useQuery<Tab[]>({
    queryKey: [`fb-tabs-${orgId}`],
    queryFn: () => fetch(`/api/organizations/${orgId}/fb/tabs?status=open`).then(r => r.json()),
    enabled: !!orgId && mode === 'table',
    refetchInterval: 30000,
  });
  const [selectedTabId, setSelectedTabId] = useState<number | null>(null);
  const { data: tabDetail, refetch: refetchTabDetail } = useQuery<TabDetail>({
    queryKey: [`fb-tab-${orgId}-${selectedTabId}`],
    queryFn: () => fetch(`/api/organizations/${orgId}/fb/tabs/${selectedTabId}`).then(r => r.json()),
    enabled: !!orgId && !!selectedTabId,
  });

  const [showOpenTab, setShowOpenTab] = useState(false);
  const [newTab, setNewTab] = useState({ tableLabel: '', guestName: '', partySize: 1 });
  async function openTab() {
    if (!newTab.tableLabel) return;
    const r = await fetch(`/api/organizations/${orgId}/fb/tabs`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newTab),
    });
    if (!r.ok) { toast({ title: 'Failed to open tab', variant: 'destructive' }); return; }
    const t = await r.json();
    await refetchTabs();
    setSelectedTabId(t.id);
    setShowOpenTab(false);
    setNewTab({ tableLabel: '', guestName: '', partySize: 1 });
    toast({ title: `Tab opened: ${t.tableLabel}` });
  }

  async function sendToTab() {
    if (!selectedTabId || cart.length === 0) return;
    const items = cart.map(l => ({
      menuItemId: l.menuItemId, quantity: l.quantity,
      modifiers: l.modifiers.map(m => ({ optionId: m.optionId })),
      notes: l.notes,
    }));
    const r = await fetch(`/api/organizations/${orgId}/fb/orders`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderType: 'table', tabId: selectedTabId, items }),
    });
    if (!r.ok) { toast({ title: 'Failed to send', variant: 'destructive' }); return; }
    setCart([]);
    await refetchTabDetail();
    toast({ title: 'Sent to kitchen' });
  }

  // Close tab (payment)
  const [showClose, setShowClose] = useState(false);
  const [closePay, setClosePay] = useState<'cash' | 'card' | 'member_account'>('cash');
  const [closeTip, setCloseTip] = useState('0');
  const [closeMember, setCloseMember] = useState<number | null>(null);
  async function closeTab() {
    if (!selectedTabId) return;
    if (closePay === 'member_account' && !closeMember && !tabDetail?.clubMemberId) {
      toast({ title: 'Select a member', variant: 'destructive' }); return;
    }
    const r = await fetch(`/api/organizations/${orgId}/fb/tabs/${selectedTabId}/close`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        paymentMethod: closePay,
        tip: parseFloat(closeTip || '0'),
        ...(closePay === 'member_account' && closeMember ? { clubMemberId: closeMember } : {}),
      }),
    });
    if (!r.ok) { toast({ title: 'Close failed', variant: 'destructive' }); return; }
    const result = await r.json();
    toast({ title: 'Tab closed', description: `Total ${fmt(result.total ?? 0)}` });
    setShowClose(false); setSelectedTabId(null); setCloseTip('0'); setCloseMember(null);
    await refetchTabs();
  }

  // Transfer / split
  const [showTransfer, setShowTransfer] = useState(false);
  const [transferTo, setTransferTo] = useState<number | null>(null);
  const [transferOrders, setTransferOrders] = useState<number[]>([]);
  async function transferOrders_() {
    if (!selectedTabId || !transferTo || transferOrders.length === 0) return;
    const r = await fetch(`/api/organizations/${orgId}/fb/tabs/${selectedTabId}/transfer-orders`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ toTabId: transferTo, orderIds: transferOrders }),
    });
    if (!r.ok) { toast({ title: 'Transfer failed', variant: 'destructive' }); return; }
    setShowTransfer(false); setTransferOrders([]); setTransferTo(null);
    await refetchTabDetail(); await refetchTabs();
    toast({ title: 'Transferred' });
  }

  const [showSplit, setShowSplit] = useState(false);
  const [splitOrders, setSplitOrders] = useState<number[]>([]);
  const [splitLabel, setSplitLabel] = useState('');
  async function splitTab() {
    if (!selectedTabId || splitOrders.length === 0) return;
    const r = await fetch(`/api/organizations/${orgId}/fb/tabs/${selectedTabId}/split`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderIds: splitOrders, newTableLabel: splitLabel || undefined }),
    });
    if (!r.ok) { toast({ title: 'Split failed', variant: 'destructive' }); return; }
    const newTab = await r.json();
    setShowSplit(false); setSplitOrders([]); setSplitLabel('');
    await refetchTabDetail(); await refetchTabs();
    toast({ title: `Split to ${newTab.tableLabel}` });
  }

  if (!orgId) return <div className="p-8 text-center text-muted-foreground">Sign in with an org to use POS.</div>;

  return (
    <div className="p-4 md:p-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-4 gap-4 flex-wrap">
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Coffee className="w-6 h-6 text-primary" /> F&B POS
        </h1>
        <Tabs value={mode} onValueChange={(v) => { setMode(v as 'counter' | 'table'); setCart([]); setSelectedTabId(null); }}>
          <TabsList>
            <TabsTrigger value="counter"><ShoppingCart className="w-4 h-4 mr-1" />Counter</TabsTrigger>
            <TabsTrigger value="table"><UsersIcon className="w-4 h-4 mr-1" />Table Service</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      <div className="grid lg:grid-cols-[1fr_380px] gap-4">
        {/* ── LEFT: Menu (counter) OR Tabs list (table) ── */}
        <div>
          {mode === 'table' && !selectedTabId ? (
            <div>
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-lg font-semibold">Open Tabs ({openTabs.length})</h2>
                <Button onClick={() => setShowOpenTab(true)}><Plus className="w-4 h-4 mr-1" /> Open Tab</Button>
              </div>
              {openTabs.length === 0 ? (
                <Card><CardContent className="p-12 text-center text-muted-foreground">No open tabs. Open one to start.</CardContent></Card>
              ) : (
                <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                  {openTabs.map(t => (
                    <Card key={t.id} className="cursor-pointer hover:border-primary transition-colors" onClick={() => setSelectedTabId(t.id)}>
                      <CardContent className="p-4">
                        <div className="font-bold text-lg">{t.tableLabel}</div>
                        {t.guestName && <p className="text-sm text-muted-foreground">{t.guestName}</p>}
                        <p className="text-xs text-muted-foreground mt-1">Party of {t.partySize ?? 1} · opened {new Date(t.openedAt).toLocaleTimeString()}</p>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div>
              {/* Search + categories */}
              <div className="flex gap-2 mb-3 flex-wrap items-center">
                <div className="relative flex-1 min-w-[180px]">
                  <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                  <Input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search menu" className="pl-9" />
                </div>
                <Select value={activeCategory === 'all' ? 'all' : String(activeCategory)} onValueChange={v => setActiveCategory(v === 'all' ? 'all' : parseInt(v))}>
                  <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All categories</SelectItem>
                    {categories.map(c => <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>)}
                  </SelectContent>
                </Select>
                {mode === 'table' && selectedTabId && (
                  <Button variant="outline" size="sm" onClick={() => setSelectedTabId(null)}>← Back to tabs</Button>
                )}
              </div>

              {visibleItems.length === 0 ? (
                <Card><CardContent className="p-8 text-center text-muted-foreground">No menu items.</CardContent></Card>
              ) : (
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
                  {visibleItems.map(it => (
                    <button key={it.id} onClick={() => startAddItem(it)}
                      className="text-left border rounded-lg p-3 hover:border-primary hover:bg-primary/5 transition-colors">
                      <div className="font-semibold text-sm leading-tight">{it.name}</div>
                      <div className="text-primary font-bold text-sm mt-1">{fmt(it.price, it.currency)}</div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* ── RIGHT: Cart / Tab detail ── */}
        <div>
          {mode === 'table' && selectedTabId && tabDetail ? (
            // ── TAB DETAIL ──
            <Card>
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-lg">{tabDetail.tableLabel}</CardTitle>
                  <Badge>{tabDetail.status}</Badge>
                </div>
                {tabDetail.guestName && <p className="text-sm text-muted-foreground">{tabDetail.guestName}</p>}
              </CardHeader>
              <CardContent className="space-y-3">
                {tabDetail.orders.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No items yet — add from the menu.</p>
                ) : (
                  <div className="space-y-2 max-h-[40vh] overflow-y-auto border rounded p-2">
                    {tabDetail.orders.map(o => (
                      <div key={o.id} className="border-b last:border-0 pb-2">
                        <div className="flex items-center justify-between text-xs text-muted-foreground mb-1">
                          <span>Order #{o.id} · {o.status}</span>
                          <span>{fmt(o.totalAmount, o.currency)}</span>
                        </div>
                        {o.items.map(it => (
                          <div key={it.id} className="text-sm">
                            <div className="flex justify-between">
                              <span>{it.quantity}× {it.name}</span>
                              <span className="text-muted-foreground">{fmt((parseFloat(it.price) + parseFloat(it.modifierTotal ?? '0')) * it.quantity, o.currency)}</span>
                            </div>
                            {it.modifiers && it.modifiers.length > 0 && (
                              <ul className="ml-4 text-xs text-muted-foreground list-disc">
                                {it.modifiers.map((m, i) => <li key={i}>{m.name}</li>)}
                              </ul>
                            )}
                          </div>
                        ))}
                      </div>
                    ))}
                  </div>
                )}
                <div className="flex justify-between font-bold border-t pt-2">
                  <span>Subtotal</span><span>{fmt(tabDetail.subtotal)}</span>
                </div>

                {/* Cart staging area */}
                {cart.length > 0 && (
                  <div className="border rounded p-2 bg-amber-500/5 border-amber-500/30">
                    <p className="text-xs font-semibold mb-1 text-amber-500">New items (not sent)</p>
                    {cart.map(l => (
                      <div key={l.key} className="flex items-center justify-between text-sm">
                        <span>{l.quantity}× {l.name}</span>
                        <div className="flex items-center gap-1">
                          <Button size="icon" variant="ghost" className="h-6 w-6" onClick={() => changeQty(l.key, -1)}><Minus className="w-3 h-3" /></Button>
                          <Button size="icon" variant="ghost" className="h-6 w-6" onClick={() => changeQty(l.key, 1)}><Plus className="w-3 h-3" /></Button>
                        </div>
                      </div>
                    ))}
                    <Button className="w-full mt-2" size="sm" onClick={sendToTab}>Send to Kitchen ({fmt(cartTotal, currency)})</Button>
                  </div>
                )}

                <div className="grid grid-cols-3 gap-2">
                  <Button size="sm" variant="outline" onClick={() => { setTransferOrders([]); setShowTransfer(true); }}><ArrowRightLeft className="w-3 h-3 mr-1" />Transfer</Button>
                  <Button size="sm" variant="outline" onClick={() => { setSplitOrders([]); setShowSplit(true); }}><Split className="w-3 h-3 mr-1" />Split</Button>
                  <Button size="sm" onClick={() => setShowClose(true)}><Receipt className="w-3 h-3 mr-1" />Pay</Button>
                </div>
              </CardContent>
            </Card>
          ) : (
            // ── COUNTER CART ──
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-lg flex items-center gap-2">
                  <ShoppingCart className="w-5 h-5" /> Cart ({cart.length})
                </CardTitle>
              </CardHeader>
              <CardContent>
                {cart.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-6">Tap menu items to add.</p>
                ) : (
                  <div className="space-y-2">
                    {cart.map(l => (
                      <div key={l.key} className="border rounded p-2">
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex-1">
                            <div className="text-sm font-medium">{l.name}</div>
                            {l.modifiers.length > 0 && (
                              <ul className="text-xs text-muted-foreground ml-3 list-disc">
                                {l.modifiers.map((m, i) => <li key={i}>{m.name}{parseFloat(m.priceDelta) !== 0 && ` (+${fmt(m.priceDelta, l.currency)})`}</li>)}
                              </ul>
                            )}
                            {l.notes && <p className="text-xs italic text-amber-400">{l.notes}</p>}
                          </div>
                          <div className="text-sm font-semibold">{fmt(lineTotal(l), l.currency)}</div>
                        </div>
                        <div className="flex items-center justify-between mt-2">
                          <div className="flex items-center gap-1">
                            <Button size="icon" variant="outline" className="h-7 w-7" onClick={() => changeQty(l.key, -1)}><Minus className="w-3 h-3" /></Button>
                            <span className="w-8 text-center text-sm">{l.quantity}</span>
                            <Button size="icon" variant="outline" className="h-7 w-7" onClick={() => changeQty(l.key, 1)}><Plus className="w-3 h-3" /></Button>
                          </div>
                          <Button size="sm" variant="ghost" className="text-destructive h-7" onClick={() => setCart(c => c.filter(x => x.key !== l.key))}>
                            <Trash2 className="w-3 h-3" />
                          </Button>
                        </div>
                      </div>
                    ))}
                    <div className="flex justify-between font-bold border-t pt-2">
                      <span>Total</span><span>{fmt(cartTotal, currency)}</span>
                    </div>
                    {mode === 'counter' ? (
                      <Button className="w-full" onClick={() => setShowCheckout(true)}>
                        <Receipt className="w-4 h-4 mr-1" /> Checkout
                      </Button>
                    ) : (
                      <p className="text-xs text-center text-muted-foreground">Select an open tab to send these items.</p>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      {/* ── MODIFIER DIALOG ── */}
      <Dialog open={!!modItem} onOpenChange={(o) => !o && setModItem(null)}>
        <DialogContent className="max-w-md max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{modItem?.name}</DialogTitle>
          </DialogHeader>
          {modItem && (
            <div className="space-y-4">
              {(modItem.modifierGroupIds ?? []).map(gid => {
                const g = modGroupMap.get(gid);
                if (!g) return null;
                const sel = modSelection[gid] ?? [];
                return (
                  <div key={gid}>
                    <div className="flex items-center gap-2 mb-2">
                      <span className="font-medium">{g.name}</span>
                      {g.isRequired && <Badge variant="outline" className="text-xs">Required</Badge>}
                      <span className="text-xs text-muted-foreground">{g.selectionType === 'single' ? 'Pick one' : g.maxSelections ? `Up to ${g.maxSelections}` : 'Multi'}</span>
                    </div>
                    <div className="space-y-1">
                      {g.options.filter(o => o.isAvailable).map(opt => {
                        const checked = sel.includes(opt.id);
                        return (
                          <label key={opt.id} className="flex items-center justify-between border rounded px-3 py-2 cursor-pointer hover:border-primary">
                            <div className="flex items-center gap-2">
                              <input
                                type={g.selectionType === 'single' ? 'radio' : 'checkbox'}
                                name={`g-${g.id}`}
                                checked={checked}
                                onChange={() => setModSelection(prev => {
                                  const cur = new Set(prev[g.id] ?? []);
                                  if (g.selectionType === 'single') return { ...prev, [g.id]: [opt.id] };
                                  if (cur.has(opt.id)) cur.delete(opt.id);
                                  else {
                                    if (g.maxSelections && cur.size >= g.maxSelections) return prev;
                                    cur.add(opt.id);
                                  }
                                  return { ...prev, [g.id]: Array.from(cur) };
                                })}
                              />
                              <span className="text-sm">{opt.name}</span>
                            </div>
                            {parseFloat(opt.priceDelta) !== 0 && <span className="text-xs text-muted-foreground">+{fmt(opt.priceDelta)}</span>}
                          </label>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
              <div>
                <label className="text-sm font-medium block mb-1">Item notes</label>
                <Input value={modNotes} onChange={e => setModNotes(e.target.value)} placeholder="e.g. no ice" />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setModItem(null)}>Cancel</Button>
            <Button onClick={confirmModifiers}>Add to Cart</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── COUNTER CHECKOUT DIALOG ── */}
      <Dialog open={showCheckout} onOpenChange={setShowCheckout}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>Checkout — {fmt(cartTotal, currency)}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div>
              <label className="text-sm font-medium block mb-1">Payment Method</label>
              <Select value={counterPay} onValueChange={v => setCounterPay(v as 'card_on_delivery' | 'account_charge')}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="card_on_delivery">Cash / Card</SelectItem>
                  <SelectItem value="account_charge">Member Account</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {counterPay === 'account_charge' && (
              <p className="text-xs text-muted-foreground">
                Charge will post to the signed-in staff/member account. To charge a specific member, use Table mode and open a tab in their name.
              </p>
            )}
            <div>
              <label className="text-sm font-medium block mb-1">Notes</label>
              <Textarea value={counterNotes} onChange={e => setCounterNotes(e.target.value)} rows={2} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCheckout(false)}>Cancel</Button>
            <Button onClick={submitCounterOrder} disabled={submitting}>{submitting ? 'Sending...' : 'Send Order'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── OPEN TAB DIALOG ── */}
      <Dialog open={showOpenTab} onOpenChange={setShowOpenTab}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>Open New Tab</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div>
              <label className="text-sm font-medium block mb-1">Table / Label *</label>
              <Input value={newTab.tableLabel} onChange={e => setNewTab(p => ({ ...p, tableLabel: e.target.value }))} placeholder="e.g. T-12, Bar 3" />
            </div>
            <div>
              <label className="text-sm font-medium block mb-1">Guest Name (optional)</label>
              <Input value={newTab.guestName} onChange={e => setNewTab(p => ({ ...p, guestName: e.target.value }))} />
            </div>
            <div>
              <label className="text-sm font-medium block mb-1">Party Size</label>
              <Input type="number" min="1" value={newTab.partySize} onChange={e => setNewTab(p => ({ ...p, partySize: parseInt(e.target.value) || 1 }))} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowOpenTab(false)}>Cancel</Button>
            <Button onClick={openTab} disabled={!newTab.tableLabel}>Open</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── CLOSE TAB DIALOG ── */}
      <Dialog open={showClose} onOpenChange={setShowClose}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>Close Tab — {tabDetail?.tableLabel}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="flex justify-between text-sm border-b pb-2">
              <span>Subtotal</span><span className="font-semibold">{fmt(tabDetail?.subtotal ?? '0')}</span>
            </div>
            <div>
              <label className="text-sm font-medium block mb-1">Payment Method</label>
              <Select value={closePay} onValueChange={v => setClosePay(v as 'cash' | 'card' | 'member_account')}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="cash">Cash</SelectItem>
                  <SelectItem value="card">Card</SelectItem>
                  <SelectItem value="member_account">Member Account</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {closePay === 'member_account' && (
              <div>
                <label className="text-sm font-medium block mb-1">Member</label>
                <Select value={closeMember ? String(closeMember) : (tabDetail?.clubMemberId ? String(tabDetail.clubMemberId) : '')} onValueChange={v => setCloseMember(parseInt(v))}>
                  <SelectTrigger><SelectValue placeholder="Select member" /></SelectTrigger>
                  <SelectContent>
                    {members.map(m => <SelectItem key={m.id} value={String(m.id)}>{m.firstName} {m.lastName}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div>
              <label className="text-sm font-medium block mb-1">Tip</label>
              <Input type="number" step="0.01" value={closeTip} onChange={e => setCloseTip(e.target.value)} />
            </div>
            <div className="flex justify-between font-bold pt-2 border-t">
              <span>Total</span>
              <span>{fmt(parseFloat(tabDetail?.subtotal ?? '0') + parseFloat(closeTip || '0'))}</span>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowClose(false)}>Cancel</Button>
            <Button onClick={closeTab}>Charge & Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── TRANSFER DIALOG ── */}
      <Dialog open={showTransfer} onOpenChange={setShowTransfer}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>Transfer Orders</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div>
              <label className="text-sm font-medium block mb-1">To Tab</label>
              <Select value={transferTo ? String(transferTo) : ''} onValueChange={v => setTransferTo(parseInt(v))}>
                <SelectTrigger><SelectValue placeholder="Choose destination tab" /></SelectTrigger>
                <SelectContent>
                  {openTabs.filter(t => t.id !== selectedTabId).map(t => <SelectItem key={t.id} value={String(t.id)}>{t.tableLabel}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-sm font-medium block mb-1">Orders to move</label>
              <div className="space-y-1 border rounded p-2 max-h-60 overflow-y-auto">
                {tabDetail?.orders.map(o => (
                  <label key={o.id} className="flex items-center justify-between text-sm cursor-pointer">
                    <span><input type="checkbox" checked={transferOrders.includes(o.id)}
                      onChange={e => setTransferOrders(prev => e.target.checked ? [...prev, o.id] : prev.filter(x => x !== o.id))}
                      className="mr-2" />Order #{o.id} ({o.items.length} items)</span>
                    <span className="text-muted-foreground">{fmt(o.totalAmount, o.currency)}</span>
                  </label>
                ))}
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowTransfer(false)}>Cancel</Button>
            <Button onClick={transferOrders_} disabled={!transferTo || transferOrders.length === 0}>Transfer</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── SPLIT DIALOG ── */}
      <Dialog open={showSplit} onOpenChange={setShowSplit}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>Split Tab</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div>
              <label className="text-sm font-medium block mb-1">New Tab Label</label>
              <Input value={splitLabel} onChange={e => setSplitLabel(e.target.value)} placeholder={`${tabDetail?.tableLabel ?? ''} / Split`} />
            </div>
            <div>
              <label className="text-sm font-medium block mb-1">Orders to move</label>
              <div className="space-y-1 border rounded p-2 max-h-60 overflow-y-auto">
                {tabDetail?.orders.map(o => (
                  <label key={o.id} className="flex items-center justify-between text-sm cursor-pointer">
                    <span><input type="checkbox" checked={splitOrders.includes(o.id)}
                      onChange={e => setSplitOrders(prev => e.target.checked ? [...prev, o.id] : prev.filter(x => x !== o.id))}
                      className="mr-2" />Order #{o.id} ({o.items.length} items)</span>
                    <span className="text-muted-foreground">{fmt(o.totalAmount, o.currency)}</span>
                  </label>
                ))}
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowSplit(false)}>Cancel</Button>
            <Button onClick={splitTab} disabled={splitOrders.length === 0}>Split</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
