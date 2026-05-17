import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useGetMe } from '@workspace/api-client-react';
import {
  Plus, Edit2, Trash2, Utensils, MapPin, Clock, SlidersHorizontal,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useToast } from '@/hooks/use-toast';
import { Textarea } from '@/components/ui/textarea';

interface Station { id: number; name: string; description?: string; holesServed: number[]; isActive: boolean }
interface Category { id: number; name: string; sortOrder: number; isActive: boolean }
interface MenuItem {
  id: number; name: string; description?: string; price: string; currency: string;
  imageUrl?: string; isAvailable: boolean; sortOrder: number;
  categoryId?: number; stationId?: number;
  inventoryVariantId?: number | null; inventoryDeductQty?: number;
  modifierGroupIds?: number[]; servicePeriodIds?: number[];
}
interface ModifierOption { id: number; groupId: number; name: string; priceDelta: string; isAvailable: boolean; isDefault: boolean; sortOrder: number }
interface ModifierGroup {
  id: number; name: string; description?: string;
  selectionType: 'single' | 'multiple'; isRequired: boolean;
  minSelections: number; maxSelections?: number | null; sortOrder: number;
  options: ModifierOption[];
}
interface ServicePeriod {
  id: number; name: string; startTime: string; endTime: string;
  daysOfWeek: number[]; isActive: boolean;
}
interface ShopVariant { id: number; sku?: string; productName?: string; productId?: number }

function fmtPrice(price: string | number, currency = 'INR') {
  const n = parseFloat(String(price));
  return currency === 'INR' ? `₹${n.toFixed(2)}` : `${currency} ${n.toFixed(2)}`;
}

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export default function FbAdminPage() {
  const { toast } = useToast();
  const { data: user } = useGetMe();
  const orgId = user?.organizationId;

  const [activeTab, setActiveTab] = useState<'menu' | 'categories' | 'stations' | 'modifiers' | 'periods'>('menu');

  // ─── DATA QUERIES ──────────────────────────────────────────────────────────
  const { data: stations = [], refetch: refetchStations } = useQuery<Station[]>({
    queryKey: [`fb-stations-${orgId}`],
    queryFn: () => fetch(`/api/organizations/${orgId}/fb/stations`).then(r => r.json()),
    enabled: !!orgId,
  });
  const { data: categories = [], refetch: refetchCategories } = useQuery<Category[]>({
    queryKey: [`fb-categories-${orgId}`],
    queryFn: () => fetch(`/api/organizations/${orgId}/fb/categories`).then(r => r.json()),
    enabled: !!orgId,
  });
  const { data: menuData, refetch: refetchMenu } = useQuery<{ items: MenuItem[]; categories: Category[] }>({
    queryKey: [`fb-menu-admin-${orgId}`],
    queryFn: () => fetch(`/api/organizations/${orgId}/fb/menu`).then(r => r.json()),
    enabled: !!orgId,
  });
  const menuItems = menuData?.items ?? [];
  const { data: modGroups = [], refetch: refetchMods } = useQuery<ModifierGroup[]>({
    queryKey: [`fb-mod-groups-${orgId}`],
    queryFn: () => fetch(`/api/organizations/${orgId}/fb/modifier-groups`).then(r => r.json()),
    enabled: !!orgId,
  });
  const { data: periods = [], refetch: refetchPeriods } = useQuery<ServicePeriod[]>({
    queryKey: [`fb-periods-${orgId}`],
    queryFn: () => fetch(`/api/organizations/${orgId}/fb/service-periods`).then(r => r.json()),
    enabled: !!orgId,
  });
  // Shop variants for inventory linking (best-effort; tolerate missing endpoint)
  const { data: variants = [] } = useQuery<ShopVariant[]>({
    queryKey: [`shop-variants-${orgId}`],
    queryFn: async () => {
      const r = await fetch(`/api/organizations/${orgId}/shop/variants`);
      if (!r.ok) return [];
      return r.json();
    },
    enabled: !!orgId,
  });

  // ─── HELPERS ───────────────────────────────────────────────────────────────
  async function apiSave<T>(url: string, method: 'POST' | 'PUT' | 'PATCH', body: unknown): Promise<T | null> {
    const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) { toast({ title: 'Save failed', variant: 'destructive' }); return null; }
    return r.json() as Promise<T>;
  }
  async function apiDelete(url: string): Promise<boolean> {
    const r = await fetch(url, { method: 'DELETE' });
    if (!r.ok) { toast({ title: 'Delete failed', variant: 'destructive' }); return false; }
    return true;
  }

  // ─── STATION DIALOG ────────────────────────────────────────────────────────
  const [showStationDialog, setShowStationDialog] = useState(false);
  const [editingStation, setEditingStation] = useState<Partial<Station> | null>(null);
  async function saveStation() {
    if (!orgId || !editingStation?.name) return;
    const url = editingStation.id ? `/api/organizations/${orgId}/fb/stations/${editingStation.id}` : `/api/organizations/${orgId}/fb/stations`;
    const ok = await apiSave(url, editingStation.id ? 'PUT' : 'POST', editingStation);
    if (ok) { await refetchStations(); setShowStationDialog(false); toast({ title: editingStation.id ? 'Station updated' : 'Station created' }); }
  }
  async function deleteStation(id: number) {
    if (!confirm('Delete this station?')) return;
    if (await apiDelete(`/api/organizations/${orgId}/fb/stations/${id}`)) { await refetchStations(); toast({ title: 'Station deleted' }); }
  }

  // ─── CATEGORY DIALOG ───────────────────────────────────────────────────────
  const [showCategoryDialog, setShowCategoryDialog] = useState(false);
  const [editingCategory, setEditingCategory] = useState<Partial<Category> | null>(null);
  async function saveCategory() {
    if (!orgId || !editingCategory?.name) return;
    const url = editingCategory.id ? `/api/organizations/${orgId}/fb/categories/${editingCategory.id}` : `/api/organizations/${orgId}/fb/categories`;
    const ok = await apiSave(url, editingCategory.id ? 'PUT' : 'POST', editingCategory);
    if (ok) { await refetchCategories(); setShowCategoryDialog(false); toast({ title: editingCategory.id ? 'Category updated' : 'Category created' }); }
  }
  async function deleteCategory(id: number) {
    if (!confirm('Delete this category?')) return;
    if (await apiDelete(`/api/organizations/${orgId}/fb/categories/${id}`)) { await refetchCategories(); toast({ title: 'Category deleted' }); }
  }

  // ─── MENU ITEM DIALOG ──────────────────────────────────────────────────────
  const [showItemDialog, setShowItemDialog] = useState(false);
  const [editingItem, setEditingItem] = useState<Partial<MenuItem> | null>(null);
  async function saveItem() {
    if (!orgId || !editingItem?.name || editingItem.price == null) return;
    const url = editingItem.id ? `/api/organizations/${orgId}/fb/menu/${editingItem.id}` : `/api/organizations/${orgId}/fb/menu`;
    const ok = await apiSave(url, editingItem.id ? 'PUT' : 'POST', editingItem);
    if (ok) { await refetchMenu(); setShowItemDialog(false); toast({ title: editingItem.id ? 'Item updated' : 'Item created' }); }
  }
  async function deleteItem(id: number) {
    if (!confirm('Delete this menu item?')) return;
    if (await apiDelete(`/api/organizations/${orgId}/fb/menu/${id}`)) { await refetchMenu(); toast({ title: 'Item deleted' }); }
  }
  async function toggleAvailability(item: MenuItem) {
    await fetch(`/api/organizations/${orgId}/fb/menu/${item.id}/availability`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isAvailable: !item.isAvailable }),
    });
    await refetchMenu();
  }

  // ─── MODIFIER GROUP DIALOG ────────────────────────────────────────────────
  const [showModGroupDialog, setShowModGroupDialog] = useState(false);
  const [editingModGroup, setEditingModGroup] = useState<Partial<ModifierGroup> | null>(null);
  async function saveModGroup() {
    if (!orgId || !editingModGroup?.name) return;
    const url = editingModGroup.id ? `/api/organizations/${orgId}/fb/modifier-groups/${editingModGroup.id}` : `/api/organizations/${orgId}/fb/modifier-groups`;
    const ok = await apiSave(url, editingModGroup.id ? 'PUT' : 'POST', editingModGroup);
    if (ok) { await refetchMods(); setShowModGroupDialog(false); toast({ title: 'Saved' }); }
  }
  async function deleteModGroup(id: number) {
    if (!confirm('Delete this modifier group? All linked options and item assignments will be removed.')) return;
    if (await apiDelete(`/api/organizations/${orgId}/fb/modifier-groups/${id}`)) { await refetchMods(); toast({ title: 'Group deleted' }); }
  }
  // Inline option management
  const [optAdd, setOptAdd] = useState<Record<number, { name: string; priceDelta: string }>>({});
  async function addOption(groupId: number) {
    const draft = optAdd[groupId];
    if (!draft?.name) return;
    const ok = await apiSave(`/api/organizations/${orgId}/fb/modifier-groups/${groupId}/options`, 'POST', {
      name: draft.name, priceDelta: parseFloat(draft.priceDelta || '0'),
    });
    if (ok) { setOptAdd(prev => ({ ...prev, [groupId]: { name: '', priceDelta: '0' } })); await refetchMods(); }
  }
  async function deleteOption(optionId: number) {
    if (await apiDelete(`/api/organizations/${orgId}/fb/modifier-options/${optionId}`)) await refetchMods();
  }
  async function toggleOptionAvail(opt: ModifierOption) {
    await apiSave(`/api/organizations/${orgId}/fb/modifier-options/${opt.id}`, 'PUT', { isAvailable: !opt.isAvailable });
    await refetchMods();
  }

  // ─── SERVICE PERIOD DIALOG ────────────────────────────────────────────────
  const [showPeriodDialog, setShowPeriodDialog] = useState(false);
  const [editingPeriod, setEditingPeriod] = useState<Partial<ServicePeriod> | null>(null);
  async function savePeriod() {
    if (!orgId || !editingPeriod?.name || !editingPeriod.startTime || !editingPeriod.endTime) return;
    const url = editingPeriod.id ? `/api/organizations/${orgId}/fb/service-periods/${editingPeriod.id}` : `/api/organizations/${orgId}/fb/service-periods`;
    const ok = await apiSave(url, editingPeriod.id ? 'PUT' : 'POST', editingPeriod);
    if (ok) { await refetchPeriods(); setShowPeriodDialog(false); toast({ title: 'Saved' }); }
  }
  async function deletePeriod(id: number) {
    if (!confirm('Delete this service period?')) return;
    if (await apiDelete(`/api/organizations/${orgId}/fb/service-periods/${id}`)) { await refetchPeriods(); toast({ title: 'Period deleted' }); }
  }

  const categoryMap = new Map(categories.map(c => [c.id, c.name]));
  const stationMap = new Map(stations.map(s => [s.id, s.name]));

  if (!orgId) return <div className="p-8 text-center text-muted-foreground">Select an organization to manage F&B.</div>;

  const tabs: { id: typeof activeTab; label: string }[] = [
    { id: 'menu', label: 'Menu' },
    { id: 'categories', label: 'Categories' },
    { id: 'stations', label: 'Stations' },
    { id: 'modifiers', label: 'Modifiers' },
    { id: 'periods', label: 'Service Periods' },
  ];

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Utensils className="w-6 h-6 text-primary" /> F&B Menu Management
          </h1>
          <p className="text-sm text-muted-foreground mt-1">Menus, modifiers, service periods & fulfillment routing</p>
        </div>
      </div>

      <div className="flex gap-1 mb-6 bg-muted rounded-lg p-1 w-fit flex-wrap">
        {tabs.map(t => (
          <button key={t.id} onClick={() => setActiveTab(t.id)}
            className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${activeTab === t.id ? 'bg-background shadow text-foreground' : 'text-muted-foreground hover:text-foreground'}`}>
            {t.label}
          </button>
        ))}
      </div>

      {/* ── MENU ITEMS TAB ── */}
      {activeTab === 'menu' && (
        <div>
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-semibold text-lg">Menu Items ({menuItems.length})</h2>
            <Button size="sm" onClick={() => { setEditingItem({ isAvailable: true, currency: 'INR', sortOrder: 0, inventoryDeductQty: 1, modifierGroupIds: [], servicePeriodIds: [] }); setShowItemDialog(true); }}>
              <Plus className="w-4 h-4 mr-1" /> Add Item
            </Button>
          </div>
          {menuItems.length === 0 ? (
            <Card><CardContent className="p-8 text-center text-muted-foreground">No menu items yet.</CardContent></Card>
          ) : (
            <div className="grid gap-3">
              {menuItems.map(item => (
                <Card key={item.id} className={item.isAvailable ? '' : 'opacity-60'}>
                  <CardContent className="p-4 flex items-center justify-between gap-4">
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-1 flex-wrap">
                        <span className="font-semibold">{item.name}</span>
                        {!item.isAvailable && <Badge variant="outline" className="text-xs text-muted-foreground">86'd</Badge>}
                        {item.categoryId && <Badge variant="secondary" className="text-xs">{categoryMap.get(item.categoryId)}</Badge>}
                        {item.stationId && <Badge variant="outline" className="text-xs"><MapPin className="w-3 h-3 inline mr-1" />{stationMap.get(item.stationId)}</Badge>}
                        {(item.modifierGroupIds?.length ?? 0) > 0 && <Badge variant="outline" className="text-xs"><SlidersHorizontal className="w-3 h-3 inline mr-1" />{item.modifierGroupIds!.length} mod{item.modifierGroupIds!.length > 1 ? 's' : ''}</Badge>}
                        {(item.servicePeriodIds?.length ?? 0) > 0 && <Badge variant="outline" className="text-xs"><Clock className="w-3 h-3 inline mr-1" />{item.servicePeriodIds!.length} period{item.servicePeriodIds!.length > 1 ? 's' : ''}</Badge>}
                      </div>
                      {item.description && <p className="text-sm text-muted-foreground">{item.description}</p>}
                      <p className="text-sm font-bold text-primary mt-1">{fmtPrice(item.price, item.currency)}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Switch checked={item.isAvailable} onCheckedChange={() => toggleAvailability(item)} />
                      <Button variant="ghost" size="sm" onClick={() => { setEditingItem({ ...item, modifierGroupIds: item.modifierGroupIds ?? [], servicePeriodIds: item.servicePeriodIds ?? [] }); setShowItemDialog(true); }}>
                        <Edit2 className="w-4 h-4" />
                      </Button>
                      <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={() => deleteItem(item.id)}>
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── CATEGORIES TAB ── */}
      {activeTab === 'categories' && (
        <div>
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-semibold text-lg">Categories ({categories.length})</h2>
            <Button size="sm" onClick={() => { setEditingCategory({ isActive: true, sortOrder: 0 }); setShowCategoryDialog(true); }}>
              <Plus className="w-4 h-4 mr-1" /> Add
            </Button>
          </div>
          {categories.length === 0 ? <Card><CardContent className="p-8 text-center text-muted-foreground">No categories yet.</CardContent></Card> : (
            <div className="grid gap-3">
              {categories.map(cat => (
                <Card key={cat.id}>
                  <CardContent className="p-4 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <span className="font-medium">{cat.name}</span>
                      {!cat.isActive && <Badge variant="outline" className="text-xs">Hidden</Badge>}
                      <span className="text-xs text-muted-foreground">Order: {cat.sortOrder}</span>
                    </div>
                    <div className="flex gap-2">
                      <Button variant="ghost" size="sm" onClick={() => { setEditingCategory({ ...cat }); setShowCategoryDialog(true); }}><Edit2 className="w-4 h-4" /></Button>
                      <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={() => deleteCategory(cat.id)}><Trash2 className="w-4 h-4" /></Button>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── STATIONS TAB ── */}
      {activeTab === 'stations' && (
        <div>
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-semibold text-lg">Fulfillment Stations ({stations.length})</h2>
            <Button size="sm" onClick={() => { setEditingStation({ isActive: true, holesServed: [] }); setShowStationDialog(true); }}>
              <Plus className="w-4 h-4 mr-1" /> Add
            </Button>
          </div>
          {stations.length === 0 ? <Card><CardContent className="p-8 text-center text-muted-foreground">No stations yet.</CardContent></Card> : (
            <div className="grid gap-3">
              {stations.map(s => (
                <Card key={s.id} className={s.isActive ? '' : 'opacity-60'}>
                  <CardContent className="p-4 flex items-center justify-between gap-4">
                    <div>
                      <div className="flex items-center gap-2 mb-1">
                        <span className="font-semibold">{s.name}</span>
                        {!s.isActive && <Badge variant="outline">Inactive</Badge>}
                      </div>
                      {s.description && <p className="text-sm text-muted-foreground">{s.description}</p>}
                      {s.holesServed?.length > 0 && <p className="text-xs text-muted-foreground mt-1">Holes: {s.holesServed.join(', ')}</p>}
                    </div>
                    <div className="flex gap-2">
                      <Button variant="ghost" size="sm" onClick={() => { setEditingStation({ ...s }); setShowStationDialog(true); }}><Edit2 className="w-4 h-4" /></Button>
                      <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={() => deleteStation(s.id)}><Trash2 className="w-4 h-4" /></Button>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── MODIFIERS TAB ── */}
      {activeTab === 'modifiers' && (
        <div>
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-semibold text-lg">Modifier Groups ({modGroups.length})</h2>
            <Button size="sm" onClick={() => { setEditingModGroup({ selectionType: 'single', isRequired: false, minSelections: 0, sortOrder: 0 }); setShowModGroupDialog(true); }}>
              <Plus className="w-4 h-4 mr-1" /> New Group
            </Button>
          </div>
          {modGroups.length === 0 ? <Card><CardContent className="p-8 text-center text-muted-foreground">No modifier groups yet. Create one to add options like "Milk type" or "Sides".</CardContent></Card> : (
            <div className="grid gap-3">
              {modGroups.map(g => (
                <Card key={g.id}>
                  <CardContent className="p-4">
                    <div className="flex items-start justify-between gap-4 mb-3">
                      <div>
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-semibold">{g.name}</span>
                          <Badge variant="secondary" className="text-xs">{g.selectionType === 'single' ? 'Pick one' : 'Multi-select'}</Badge>
                          {g.isRequired && <Badge variant="outline" className="text-xs">Required</Badge>}
                        </div>
                        {g.description && <p className="text-sm text-muted-foreground mt-1">{g.description}</p>}
                      </div>
                      <div className="flex gap-2">
                        <Button variant="ghost" size="sm" onClick={() => { setEditingModGroup({ ...g }); setShowModGroupDialog(true); }}><Edit2 className="w-4 h-4" /></Button>
                        <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={() => deleteModGroup(g.id)}><Trash2 className="w-4 h-4" /></Button>
                      </div>
                    </div>
                    {/* Options */}
                    <div className="border-t pt-3 space-y-2">
                      {g.options.map(opt => (
                        <div key={opt.id} className="flex items-center justify-between bg-muted/30 rounded px-3 py-2 text-sm">
                          <div className="flex items-center gap-2">
                            <Switch checked={opt.isAvailable} onCheckedChange={() => toggleOptionAvail(opt)} />
                            <span className={opt.isAvailable ? '' : 'line-through text-muted-foreground'}>{opt.name}</span>
                            {parseFloat(opt.priceDelta) !== 0 && <Badge variant="outline" className="text-xs">{parseFloat(opt.priceDelta) > 0 ? '+' : ''}{fmtPrice(opt.priceDelta)}</Badge>}
                          </div>
                          <Button variant="ghost" size="sm" className="text-destructive" onClick={() => deleteOption(opt.id)}><Trash2 className="w-4 h-4" /></Button>
                        </div>
                      ))}
                      <div className="flex items-center gap-2">
                        <Input placeholder="Option name" value={optAdd[g.id]?.name ?? ''}
                          onChange={e => setOptAdd(p => ({ ...p, [g.id]: { ...(p[g.id] ?? { name: '', priceDelta: '0' }), name: e.target.value } }))}
                          className="flex-1" />
                        <Input type="number" step="0.01" placeholder="+₹0.00" value={optAdd[g.id]?.priceDelta ?? '0'}
                          onChange={e => setOptAdd(p => ({ ...p, [g.id]: { ...(p[g.id] ?? { name: '', priceDelta: '0' }), priceDelta: e.target.value } }))}
                          className="w-28" />
                        <Button size="sm" onClick={() => addOption(g.id)}><Plus className="w-4 h-4" /></Button>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── SERVICE PERIODS TAB ── */}
      {activeTab === 'periods' && (
        <div>
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-semibold text-lg">Service Periods ({periods.length})</h2>
            <Button size="sm" onClick={() => { setEditingPeriod({ isActive: true, startTime: '07:00', endTime: '11:00', daysOfWeek: [0,1,2,3,4,5,6] }); setShowPeriodDialog(true); }}>
              <Plus className="w-4 h-4 mr-1" /> New Period
            </Button>
          </div>
          {periods.length === 0 ? <Card><CardContent className="p-8 text-center text-muted-foreground">No service periods yet. Add Breakfast, Lunch, Dinner, Late Night to control menu visibility by time of day.</CardContent></Card> : (
            <div className="grid gap-3">
              {periods.map(p => (
                <Card key={p.id} className={p.isActive ? '' : 'opacity-60'}>
                  <CardContent className="p-4 flex items-center justify-between gap-4">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-semibold">{p.name}</span>
                        {!p.isActive && <Badge variant="outline">Inactive</Badge>}
                      </div>
                      <p className="text-sm text-muted-foreground mt-1">
                        {p.startTime} – {p.endTime} · {p.daysOfWeek.length === 7 ? 'Daily' : p.daysOfWeek.map(d => DAY_LABELS[d]).join(', ')}
                      </p>
                    </div>
                    <div className="flex gap-2">
                      <Button variant="ghost" size="sm" onClick={() => { setEditingPeriod({ ...p }); setShowPeriodDialog(true); }}><Edit2 className="w-4 h-4" /></Button>
                      <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={() => deletePeriod(p.id)}><Trash2 className="w-4 h-4" /></Button>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── MENU ITEM DIALOG ── */}
      <Dialog open={showItemDialog} onOpenChange={setShowItemDialog}>
        <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader><DialogTitle>{editingItem?.id ? 'Edit Item' : 'New Menu Item'}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div>
              <label className="text-sm font-medium mb-1 block">Name *</label>
              <Input value={editingItem?.name ?? ''} onChange={e => setEditingItem(p => ({ ...p!, name: e.target.value }))} />
            </div>
            <div>
              <label className="text-sm font-medium mb-1 block">Description</label>
              <Textarea value={editingItem?.description ?? ''} onChange={e => setEditingItem(p => ({ ...p!, description: e.target.value }))} rows={2} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-sm font-medium mb-1 block">Price *</label>
                <Input type="number" step="0.01" min="0" value={editingItem?.price ?? ''} onChange={e => setEditingItem(p => ({ ...p!, price: e.target.value }))} />
              </div>
              <div>
                <label className="text-sm font-medium mb-1 block">Currency</label>
                <Select value={editingItem?.currency ?? 'INR'} onValueChange={v => setEditingItem(p => ({ ...p!, currency: v }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="INR">INR (₹)</SelectItem>
                    <SelectItem value="USD">USD ($)</SelectItem>
                    <SelectItem value="GBP">GBP (£)</SelectItem>
                    <SelectItem value="EUR">EUR (€)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-sm font-medium mb-1 block">Category</label>
                <Select value={editingItem?.categoryId ? String(editingItem.categoryId) : 'none'} onValueChange={v => setEditingItem(p => ({ ...p!, categoryId: v === 'none' ? undefined : parseInt(v) }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">None</SelectItem>
                    {categories.map(c => <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="text-sm font-medium mb-1 block">Station</label>
                <Select value={editingItem?.stationId ? String(editingItem.stationId) : 'none'} onValueChange={v => setEditingItem(p => ({ ...p!, stationId: v === 'none' ? undefined : parseInt(v) }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">None</SelectItem>
                    {stations.map(s => <SelectItem key={s.id} value={String(s.id)}>{s.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* Modifier Groups multi-select */}
            <div>
              <label className="text-sm font-medium mb-1 block flex items-center gap-1"><SlidersHorizontal className="w-3 h-3" /> Modifier Groups</label>
              {modGroups.length === 0 ? (
                <p className="text-xs text-muted-foreground">Create modifier groups in the Modifiers tab.</p>
              ) : (
                <div className="border rounded p-2 space-y-1 max-h-40 overflow-y-auto">
                  {modGroups.map(g => {
                    const checked = editingItem?.modifierGroupIds?.includes(g.id) ?? false;
                    return (
                      <label key={g.id} className="flex items-center gap-2 text-sm cursor-pointer">
                        <input type="checkbox" checked={checked} onChange={e => setEditingItem(p => {
                          const cur = new Set(p?.modifierGroupIds ?? []);
                          if (e.target.checked) cur.add(g.id); else cur.delete(g.id);
                          return { ...p!, modifierGroupIds: Array.from(cur) };
                        })} />
                        {g.name} <span className="text-xs text-muted-foreground">({g.options.length} options)</span>
                      </label>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Service Periods multi-select */}
            <div>
              <label className="text-sm font-medium mb-1 block flex items-center gap-1"><Clock className="w-3 h-3" /> Service Periods <span className="text-xs text-muted-foreground font-normal">(empty = always available)</span></label>
              {periods.length === 0 ? (
                <p className="text-xs text-muted-foreground">No service periods defined.</p>
              ) : (
                <div className="border rounded p-2 space-y-1">
                  {periods.map(p => {
                    const checked = editingItem?.servicePeriodIds?.includes(p.id) ?? false;
                    return (
                      <label key={p.id} className="flex items-center gap-2 text-sm cursor-pointer">
                        <input type="checkbox" checked={checked} onChange={e => setEditingItem(prev => {
                          const cur = new Set(prev?.servicePeriodIds ?? []);
                          if (e.target.checked) cur.add(p.id); else cur.delete(p.id);
                          return { ...prev!, servicePeriodIds: Array.from(cur) };
                        })} />
                        {p.name} <span className="text-xs text-muted-foreground">({p.startTime}–{p.endTime})</span>
                      </label>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Inventory linkage */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-sm font-medium mb-1 block">Inventory Variant (optional)</label>
                <Select value={editingItem?.inventoryVariantId ? String(editingItem.inventoryVariantId) : 'none'} onValueChange={v => setEditingItem(p => ({ ...p!, inventoryVariantId: v === 'none' ? null : parseInt(v) }))}>
                  <SelectTrigger><SelectValue placeholder="None" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">No stock tracking</SelectItem>
                    {variants.map(v => <SelectItem key={v.id} value={String(v.id)}>{v.productName ?? v.sku ?? `Variant #${v.id}`}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="text-sm font-medium mb-1 block">Deduct per unit</label>
                <Input type="number" min="0" value={editingItem?.inventoryDeductQty ?? 1} onChange={e => setEditingItem(p => ({ ...p!, inventoryDeductQty: parseInt(e.target.value) || 0 }))} />
              </div>
            </div>

            <div>
              <label className="text-sm font-medium mb-1 block">Sort Order</label>
              <Input type="number" value={editingItem?.sortOrder ?? 0} onChange={e => setEditingItem(p => ({ ...p!, sortOrder: parseInt(e.target.value) || 0 }))} />
            </div>
            <div className="flex items-center gap-2">
              <Switch checked={editingItem?.isAvailable ?? true} onCheckedChange={v => setEditingItem(p => ({ ...p!, isAvailable: v }))} />
              <label className="text-sm">Available (off = 86'd)</label>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowItemDialog(false)}>Cancel</Button>
            <Button onClick={saveItem} disabled={!editingItem?.name || editingItem?.price == null}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── CATEGORY DIALOG ── */}
      <Dialog open={showCategoryDialog} onOpenChange={setShowCategoryDialog}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>{editingCategory?.id ? 'Edit Category' : 'New Category'}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div>
              <label className="text-sm font-medium mb-1 block">Name *</label>
              <Input value={editingCategory?.name ?? ''} onChange={e => setEditingCategory(p => ({ ...p!, name: e.target.value }))} />
            </div>
            <div>
              <label className="text-sm font-medium mb-1 block">Sort Order</label>
              <Input type="number" value={editingCategory?.sortOrder ?? 0} onChange={e => setEditingCategory(p => ({ ...p!, sortOrder: parseInt(e.target.value) || 0 }))} />
            </div>
            <div className="flex items-center gap-2">
              <Switch checked={editingCategory?.isActive ?? true} onCheckedChange={v => setEditingCategory(p => ({ ...p!, isActive: v }))} />
              <label className="text-sm">Active</label>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCategoryDialog(false)}>Cancel</Button>
            <Button onClick={saveCategory} disabled={!editingCategory?.name}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── STATION DIALOG ── */}
      <Dialog open={showStationDialog} onOpenChange={setShowStationDialog}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>{editingStation?.id ? 'Edit Station' : 'New Station'}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div>
              <label className="text-sm font-medium mb-1 block">Name *</label>
              <Input value={editingStation?.name ?? ''} onChange={e => setEditingStation(p => ({ ...p!, name: e.target.value }))} />
            </div>
            <div>
              <label className="text-sm font-medium mb-1 block">Description</label>
              <Input value={editingStation?.description ?? ''} onChange={e => setEditingStation(p => ({ ...p!, description: e.target.value }))} />
            </div>
            <div>
              <label className="text-sm font-medium mb-1 block">Holes Served (comma-separated)</label>
              <Input value={editingStation?.holesServed?.join(', ') ?? ''}
                onChange={e => setEditingStation(p => ({ ...p!, holesServed: e.target.value.split(',').map(n => parseInt(n.trim())).filter(n => !isNaN(n)) }))}
                placeholder="e.g. 1, 2, 3, 9, 10" />
            </div>
            <div className="flex items-center gap-2">
              <Switch checked={editingStation?.isActive ?? true} onCheckedChange={v => setEditingStation(p => ({ ...p!, isActive: v }))} />
              <label className="text-sm">Active</label>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowStationDialog(false)}>Cancel</Button>
            <Button onClick={saveStation} disabled={!editingStation?.name}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── MODIFIER GROUP DIALOG ── */}
      <Dialog open={showModGroupDialog} onOpenChange={setShowModGroupDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>{editingModGroup?.id ? 'Edit Modifier Group' : 'New Modifier Group'}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div>
              <label className="text-sm font-medium mb-1 block">Name *</label>
              <Input value={editingModGroup?.name ?? ''} onChange={e => setEditingModGroup(p => ({ ...p!, name: e.target.value }))} placeholder="e.g. Milk choice" />
            </div>
            <div>
              <label className="text-sm font-medium mb-1 block">Description</label>
              <Textarea value={editingModGroup?.description ?? ''} onChange={e => setEditingModGroup(p => ({ ...p!, description: e.target.value }))} rows={2} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-sm font-medium mb-1 block">Selection</label>
                <Select value={editingModGroup?.selectionType ?? 'single'} onValueChange={v => setEditingModGroup(p => ({ ...p!, selectionType: v as 'single' | 'multiple' }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="single">Single (radio)</SelectItem>
                    <SelectItem value="multiple">Multiple (checkboxes)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="text-sm font-medium mb-1 block">Min</label>
                <Input type="number" min="0" value={editingModGroup?.minSelections ?? 0} onChange={e => setEditingModGroup(p => ({ ...p!, minSelections: parseInt(e.target.value) || 0 }))} />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-sm font-medium mb-1 block">Max (blank = unlimited)</label>
                <Input type="number" min="1" value={editingModGroup?.maxSelections ?? ''} onChange={e => setEditingModGroup(p => ({ ...p!, maxSelections: e.target.value ? parseInt(e.target.value) : null }))} />
              </div>
              <div>
                <label className="text-sm font-medium mb-1 block">Sort Order</label>
                <Input type="number" value={editingModGroup?.sortOrder ?? 0} onChange={e => setEditingModGroup(p => ({ ...p!, sortOrder: parseInt(e.target.value) || 0 }))} />
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Switch checked={editingModGroup?.isRequired ?? false} onCheckedChange={v => setEditingModGroup(p => ({ ...p!, isRequired: v }))} />
              <label className="text-sm">Required</label>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowModGroupDialog(false)}>Cancel</Button>
            <Button onClick={saveModGroup} disabled={!editingModGroup?.name}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── SERVICE PERIOD DIALOG ── */}
      <Dialog open={showPeriodDialog} onOpenChange={setShowPeriodDialog}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>{editingPeriod?.id ? 'Edit Service Period' : 'New Service Period'}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div>
              <label className="text-sm font-medium mb-1 block">Name *</label>
              <Input value={editingPeriod?.name ?? ''} onChange={e => setEditingPeriod(p => ({ ...p!, name: e.target.value }))} placeholder="e.g. Breakfast" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-sm font-medium mb-1 block">Start *</label>
                <Input type="time" value={editingPeriod?.startTime ?? '07:00'} onChange={e => setEditingPeriod(p => ({ ...p!, startTime: e.target.value }))} />
              </div>
              <div>
                <label className="text-sm font-medium mb-1 block">End *</label>
                <Input type="time" value={editingPeriod?.endTime ?? '11:00'} onChange={e => setEditingPeriod(p => ({ ...p!, endTime: e.target.value }))} />
              </div>
            </div>
            <div>
              <label className="text-sm font-medium mb-1 block">Days of Week</label>
              <div className="flex gap-1 flex-wrap">
                {DAY_LABELS.map((d, i) => {
                  const checked = editingPeriod?.daysOfWeek?.includes(i) ?? false;
                  return (
                    <button type="button" key={i} onClick={() => setEditingPeriod(p => {
                      const cur = new Set(p?.daysOfWeek ?? []);
                      if (cur.has(i)) cur.delete(i); else cur.add(i);
                      return { ...p!, daysOfWeek: Array.from(cur).sort() };
                    })}
                      className={`px-3 py-1 rounded text-xs font-medium border ${checked ? 'bg-primary text-primary-foreground border-primary' : 'bg-background border-border'}`}>
                      {d}
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Switch checked={editingPeriod?.isActive ?? true} onCheckedChange={v => setEditingPeriod(p => ({ ...p!, isActive: v }))} />
              <label className="text-sm">Active</label>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowPeriodDialog(false)}>Cancel</Button>
            <Button onClick={savePeriod} disabled={!editingPeriod?.name || !editingPeriod?.startTime || !editingPeriod?.endTime}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
