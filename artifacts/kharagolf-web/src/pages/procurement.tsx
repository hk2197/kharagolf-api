import { useState, useEffect } from 'react';
import { useGetMe } from '@workspace/api-client-react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import {
  Plus, Edit2, Trash2, ChevronRight, Package, Truck, Building2,
  CheckCircle2, XCircle, Clock, Send, Eye, ReceiptText, RefreshCw,
  AlertCircle, FileText, ShoppingCart, ScanLine, Layers, Trophy, X, Bell,
} from 'lucide-react';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useToast } from '@/hooks/use-toast';
import { useActiveOrgId } from '@/context/ActiveOrgContext';

const BASE = import.meta.env.BASE_URL?.replace(/\/$/, '') || '';
const GOLD = '#C9A84C';

const PO_STATUS_COLORS: Record<string, string> = {
  draft: 'bg-white/10 text-white/60',
  sent: 'bg-blue-500/20 text-blue-300 border-blue-500/30',
  partially_received: 'bg-amber-500/20 text-amber-300 border-amber-500/30',
  fully_received: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30',
  cancelled: 'bg-red-500/20 text-red-300 border-red-500/30',
};

const PO_STATUS_LABELS: Record<string, string> = {
  draft: 'Draft',
  sent: 'Sent',
  partially_received: 'Partially Received',
  fully_received: 'Fully Received',
  cancelled: 'Cancelled',
};

interface Supplier {
  id: number;
  name: string;
  contactName: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  paymentTerms: string | null;
  leadTimeDays: number | null;
  notes: string | null;
  isActive: boolean;
  createdAt: string;
}

interface PoLine {
  id: number;
  purchaseOrderId: number;
  productId: number | null;
  variantId: number | null;
  productName: string;
  sku: string | null;
  quantity: number;
  unitCost: string;
  lineTotal: string;
  receivedQty: number;
}

interface PurchaseOrder {
  id: number;
  poNumber: string;
  status: string;
  totalAmount: string;
  currency: string;
  expectedDeliveryDate: string | null;
  sentAt: string | null;
  notes: string | null;
  createdAt: string;
  supplierId: number;
  supplierName: string | null;
  supplierEmail: string | null;
  supplierPhone: string | null;
  supplierAddress: string | null;
  supplierContactName: string | null;
  supplierPaymentTerms: string | null;
}

interface DeliveryReceipt {
  id: number;
  purchaseOrderId: number;
  notes: string | null;
  receivedAt: string;
}

interface DeliveryReceiptLine {
  id: number;
  deliveryReceiptId: number;
  purchaseOrderLineId: number;
  receivedQty: number;
  notes: string | null;
}

function fmtCurrency(amount: string | number, currency = 'INR'): string {
  const n = typeof amount === 'string' ? parseFloat(amount) : amount;
  if (isNaN(n)) return '—';
  return `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

// ─── SUPPLIER FORM ────────────────────────────────────────────────────────────

function SupplierForm({
  initial,
  onSave,
  onClose,
}: {
  initial?: Partial<Supplier>;
  onSave: (data: Partial<Supplier>) => Promise<void>;
  onClose: () => void;
}) {
  const [form, setForm] = useState({
    name: initial?.name ?? '',
    contactName: initial?.contactName ?? '',
    email: initial?.email ?? '',
    phone: initial?.phone ?? '',
    address: initial?.address ?? '',
    paymentTerms: initial?.paymentTerms ?? '',
    leadTimeDays: initial?.leadTimeDays != null ? String(initial.leadTimeDays) : '',
    notes: initial?.notes ?? '',
  });
  const [saving, setSaving] = useState(false);

  const set = (k: string, v: string) => setForm(f => ({ ...f, [k]: v }));

  const handleSave = async () => {
    if (!form.name.trim()) return;
    setSaving(true);
    try {
      await onSave({
        ...form,
        leadTimeDays: form.leadTimeDays ? parseInt(form.leadTimeDays) : undefined,
      });
      onClose();
    } finally { setSaving(false); }
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <div className="col-span-2">
          <label className="text-xs text-muted-foreground mb-1 block">Supplier Name *</label>
          <Input value={form.name} onChange={e => set('name', e.target.value)} placeholder="e.g. Titleist India Pvt Ltd" />
        </div>
        <div>
          <label className="text-xs text-muted-foreground mb-1 block">Contact Name</label>
          <Input value={form.contactName} onChange={e => set('contactName', e.target.value)} placeholder="Sales rep name" />
        </div>
        <div>
          <label className="text-xs text-muted-foreground mb-1 block">Email</label>
          <Input value={form.email} onChange={e => set('email', e.target.value)} placeholder="orders@supplier.com" type="email" />
        </div>
        <div>
          <label className="text-xs text-muted-foreground mb-1 block">Phone</label>
          <Input value={form.phone} onChange={e => set('phone', e.target.value)} placeholder="+91 98..." />
        </div>
        <div>
          <label className="text-xs text-muted-foreground mb-1 block">Lead Time (days)</label>
          <Input value={form.leadTimeDays} onChange={e => set('leadTimeDays', e.target.value)} placeholder="7" type="number" min="0" />
        </div>
        <div className="col-span-2">
          <label className="text-xs text-muted-foreground mb-1 block">Address</label>
          <Input value={form.address} onChange={e => set('address', e.target.value)} placeholder="Full mailing address" />
        </div>
        <div className="col-span-2">
          <label className="text-xs text-muted-foreground mb-1 block">Payment Terms</label>
          <Input value={form.paymentTerms} onChange={e => set('paymentTerms', e.target.value)} placeholder="e.g. Net 30, 50% advance" />
        </div>
        <div className="col-span-2">
          <label className="text-xs text-muted-foreground mb-1 block">Notes</label>
          <Input value={form.notes} onChange={e => set('notes', e.target.value)} placeholder="Any additional notes" />
        </div>
      </div>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button onClick={handleSave} disabled={!form.name.trim() || saving}>
          {saving ? 'Saving…' : initial?.id ? 'Update Supplier' : 'Add Supplier'}
        </Button>
      </DialogFooter>
    </div>
  );
}

// ─── LINE ITEMS EDITOR ────────────────────────────────────────────────────────

interface LineItem {
  productId?: number;
  variantId?: number;
  productName: string;
  sku: string;
  quantity: string;
  unitCost: string;
}

interface OrgProduct { id: number; name: string }
interface OrgVariant { id: number; color: string | null; size: string | null; sku: string | null }

function LineItemsEditor({
  lines,
  onChange,
  orgId,
}: {
  lines: LineItem[];
  onChange: (lines: LineItem[]) => void;
  orgId: number;
}) {
  const [products, setProducts] = useState<OrgProduct[]>([]);
  const [variantMap, setVariantMap] = useState<Record<number, OrgVariant[]>>({});

  useEffect(() => {
    fetch(`/api/organizations/${orgId}/shop/products?admin=true`, { credentials: 'include' })
      .then(r => r.json())
      .then(d => setProducts((Array.isArray(d) ? d : (d.products ?? [])).map((p: { id: number; name: string }) => ({ id: p.id, name: p.name }))))
      .catch(() => null);
  }, [orgId]);

  const fetchVariants = async (productId: number) => {
    if (variantMap[productId]) return;
    const r = await fetch(`/api/organizations/${orgId}/shop/products/${productId}/variants`, { credentials: 'include' }).catch(() => null);
    if (!r?.ok) return;
    const d = await r.json();
    const rawVariants = Array.isArray(d) ? d : (d.variants ?? []);
    const variants: OrgVariant[] = rawVariants.map((v: { id: number; color?: string | null; size?: string | null; sku?: string | null }) => ({
      id: v.id, color: v.color ?? null, size: v.size ?? null, sku: v.sku ?? null,
    }));
    setVariantMap(m => ({ ...m, [productId]: variants }));
  };

  const addLine = () => onChange([...lines, { productName: '', sku: '', quantity: '1', unitCost: '0' }]);
  const removeLine = (i: number) => onChange(lines.filter((_, idx) => idx !== i));
  const setLine = (i: number, patch: Partial<LineItem>) => {
    const next = [...lines];
    next[i] = { ...next[i], ...patch };
    onChange(next);
  };

  const selectProduct = async (i: number, productId: number | null) => {
    if (!productId) {
      setLine(i, { productId: undefined, variantId: undefined });
      return;
    }
    const product = products.find(p => p.id === productId);
    setLine(i, { productId, variantId: undefined, productName: product?.name ?? '' });
    await fetchVariants(productId);
  };

  const selectVariant = (i: number, variantId: number | null) => {
    if (!variantId || !lines[i].productId) return;
    const variants = variantMap[lines[i].productId!] ?? [];
    const v = variants.find(v => v.id === variantId);
    if (!v) return;
    const label = [v.color, v.size].filter(Boolean).join(' / ');
    const productName = label
      ? `${products.find(p => p.id === lines[i].productId)?.name ?? ''} — ${label}`
      : (products.find(p => p.id === lines[i].productId)?.name ?? '');
    setLine(i, { variantId, sku: v.sku ?? '', productName });
  };

  const total = lines.reduce((s, l) => s + (parseFloat(l.quantity) || 0) * (parseFloat(l.unitCost) || 0), 0);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Line Items</span>
        <Button size="sm" variant="ghost" onClick={addLine} className="h-7 text-xs gap-1">
          <Plus className="w-3 h-3" /> Add Line
        </Button>
      </div>
      {lines.length === 0 && (
        <p className="text-xs text-muted-foreground text-center py-4 border border-dashed border-white/10 rounded-lg">
          No items yet. Click "Add Line" to begin.
        </p>
      )}
      {lines.map((l, i) => (
        <div key={i} className="border border-white/10 rounded-lg p-3 space-y-2">
          {/* Row 1: Product + Variant selectors */}
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-[10px] text-muted-foreground mb-0.5 block">Catalog Product</label>
              <Select
                value={l.productId ? String(l.productId) : '__none__'}
                onValueChange={v => selectProduct(i, v === '__none__' ? null : parseInt(v))}
              >
                <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Pick product (optional)" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">— Manual entry —</SelectItem>
                  {products.map(p => <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-[10px] text-muted-foreground mb-0.5 block">Variant</label>
              <Select
                value={l.variantId ? String(l.variantId) : '__none__'}
                onValueChange={v => selectVariant(i, v === '__none__' ? null : parseInt(v))}
                disabled={!l.productId || !(variantMap[l.productId!]?.length)}
              >
                <SelectTrigger className="h-8 text-xs"><SelectValue placeholder={l.productId ? 'Pick variant' : 'Select product first'} /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">— No variant —</SelectItem>
                  {(l.productId ? (variantMap[l.productId] ?? []) : []).map(v => (
                    <SelectItem key={v.id} value={String(v.id)}>
                      {[v.color, v.size].filter(Boolean).join(' / ') || `Variant #${v.id}`}
                      {v.sku ? ` (${v.sku})` : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          {/* Row 2: Description + SKU + Qty + Cost + Delete */}
          <div className="grid grid-cols-12 gap-2 items-center">
            <div className="col-span-4">
              <label className="text-[10px] text-muted-foreground mb-0.5 block">Description</label>
              <Input value={l.productName} onChange={e => setLine(i, { productName: e.target.value })} placeholder="Product name" className="h-8 text-xs" />
            </div>
            <div className="col-span-2">
              <label className="text-[10px] text-muted-foreground mb-0.5 block">SKU</label>
              <Input value={l.sku} onChange={e => setLine(i, { sku: e.target.value })} placeholder="SKU" className="h-8 text-xs" />
            </div>
            <div className="col-span-2">
              <label className="text-[10px] text-muted-foreground mb-0.5 block">Qty</label>
              <Input value={l.quantity} onChange={e => setLine(i, { quantity: e.target.value })} type="number" min="1" className="h-8 text-xs" />
            </div>
            <div className="col-span-3">
              <label className="text-[10px] text-muted-foreground mb-0.5 block">Unit Cost (₹)</label>
              <Input value={l.unitCost} onChange={e => setLine(i, { unitCost: e.target.value })} type="number" min="0" step="0.01" className="h-8 text-xs" />
            </div>
            <div className="col-span-1 flex items-end justify-center pb-0.5">
              <div className="mb-3" />
              <button onClick={() => removeLine(i)} className="text-muted-foreground hover:text-destructive transition-colors">
                <XCircle className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>
      ))}
      {lines.length > 0 && (
        <div className="flex justify-end pt-2 border-t border-white/5">
          <span className="text-sm font-semibold text-white">Total: {fmtCurrency(total)}</span>
        </div>
      )}
    </div>
  );
}

// ─── PO FORM ──────────────────────────────────────────────────────────────────

function PoForm({
  suppliers,
  initial,
  initialLines,
  onSave,
  onClose,
  orgId,
}: {
  suppliers: Supplier[];
  initial?: Partial<PurchaseOrder>;
  initialLines?: PoLine[];
  onSave: (data: {
    supplierId: number;
    expectedDeliveryDate?: string;
    notes?: string;
    lines: LineItem[];
  }) => Promise<void>;
  onClose: () => void;
  orgId: number;
}) {
  const [supplierId, setSupplierId] = useState(initial?.supplierId ? String(initial.supplierId) : '');
  const [expectedDate, setExpectedDate] = useState(
    initial?.expectedDeliveryDate ? new Date(initial.expectedDeliveryDate).toISOString().split('T')[0] : ''
  );
  const [notes, setNotes] = useState(initial?.notes ?? '');
  const [lines, setLines] = useState<LineItem[]>(
    initialLines?.map(l => ({
      productId: l.productId ?? undefined,
      variantId: l.variantId ?? undefined,
      productName: l.productName,
      sku: l.sku ?? '',
      quantity: String(l.quantity),
      unitCost: l.unitCost,
    })) ?? [{ productName: '', sku: '', quantity: '1', unitCost: '0' }]
  );
  const [saving, setSaving] = useState(false);

  const isValid = supplierId && lines.length > 0 && lines.every(l => l.productName.trim());

  const handleSave = async () => {
    if (!isValid) return;
    setSaving(true);
    try {
      await onSave({ supplierId: parseInt(supplierId), expectedDeliveryDate: expectedDate || undefined, notes: notes || undefined, lines });
      onClose();
    } finally { setSaving(false); }
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <div className="col-span-2">
          <label className="text-xs text-muted-foreground mb-1 block">Supplier *</label>
          <Select value={supplierId} onValueChange={setSupplierId}>
            <SelectTrigger><SelectValue placeholder="Select supplier" /></SelectTrigger>
            <SelectContent>
              {suppliers.filter(s => s.isActive).map(s => (
                <SelectItem key={s.id} value={String(s.id)}>{s.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <label className="text-xs text-muted-foreground mb-1 block">Expected Delivery</label>
          <Input value={expectedDate} onChange={e => setExpectedDate(e.target.value)} type="date" />
        </div>
        <div>
          <label className="text-xs text-muted-foreground mb-1 block">Notes</label>
          <Input value={notes} onChange={e => setNotes(e.target.value)} placeholder="Optional notes" />
        </div>
      </div>
      <LineItemsEditor lines={lines} onChange={setLines} orgId={orgId} />
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button onClick={handleSave} disabled={!isValid || saving}>
          {saving ? 'Saving…' : initial?.id ? 'Update PO' : 'Create PO'}
        </Button>
      </DialogFooter>
    </div>
  );
}

// ─── DELIVERY FORM ────────────────────────────────────────────────────────────

function DeliveryForm({
  po,
  poLines,
  orgId,
  onSave,
  onClose,
}: {
  po: PurchaseOrder;
  poLines: PoLine[];
  orgId: number;
  onSave: (data: { notes?: string; receivedAt?: string; lines: Array<{ purchaseOrderLineId: number; receivedQty: string; variantId?: number }> }) => Promise<void>;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const [notes, setNotes] = useState('');
  const [receivedAt, setReceivedAt] = useState(new Date().toISOString().split('T')[0]);
  const [quantities, setQuantities] = useState<Record<number, string>>(() => {
    const init: Record<number, string> = {};
    poLines.forEach(l => { init[l.id] = String(Math.max(0, l.quantity - l.receivedQty)); });
    return init;
  });
  const [barcodeInputs, setBarcodeInputs] = useState<Record<number, string>>({});
  const [barcodeStatus, setBarcodeStatus] = useState<Record<number, { ok: boolean; label: string; variantId?: number }>>({});
  const [scanLoading, setScanLoading] = useState<Record<number, boolean>>({});
  const [saving, setSaving] = useState(false);

  const lookupBarcode = async (lineId: number, line: PoLine) => {
    const code = (barcodeInputs[lineId] ?? '').trim();
    if (!code) return;
    setScanLoading(l => ({ ...l, [lineId]: true }));
    try {
      const r = await fetch(`${BASE}/api/organizations/${orgId}/inventory/barcode/${encodeURIComponent(code)}`, { credentials: 'include' });
      if (!r.ok) {
        setBarcodeStatus(s => ({ ...s, [lineId]: { ok: false, label: `Not found: "${code}"` } }));
        return;
      }
      const d = await r.json();
      const v = d.variant;
      const varLabel = [v.variantColor, v.variantSize].filter(Boolean).join(' / ') || 'Default';
      // Prefer ID-based matching (productId) → SKU matching → name fallback
      let matched = false;
      if (line.productId != null && v.productId != null) {
        matched = v.productId === line.productId;
      } else if (line.sku && v.sku) {
        matched = v.sku.toLowerCase() === line.sku.toLowerCase();
      } else {
        matched = v.productName?.toLowerCase() === line.productName.toLowerCase();
      }
      setBarcodeStatus(s => ({
        ...s,
        [lineId]: {
          ok: matched,
          variantId: v.variantId,
          label: matched
            ? `✓ Matched: ${v.productName} — ${varLabel} (scanned)`
            : `Warning: scanned ${v.productName} (${varLabel}) — expected "${line.productName}"`,
        },
      }));
      // Auto-increment received qty by 1 on a successful match
      if (matched) {
        const remaining = line.quantity - line.receivedQty;
        setQuantities(q => {
          const current = parseInt(q[lineId] ?? '0') || 0;
          const next = Math.min(current + 1, remaining);
          return { ...q, [lineId]: String(next) };
        });
        // Clear the barcode input so the next scan is ready
        setBarcodeInputs(b => ({ ...b, [lineId]: '' }));
      }
    } catch {
      toast({ title: 'Error', description: 'Barcode lookup failed', variant: 'destructive' });
    } finally {
      setScanLoading(l => ({ ...l, [lineId]: false }));
    }
  };

  const handleSave = async () => {
    const lines = poLines
      .map(l => ({
        purchaseOrderLineId: l.id,
        receivedQty: quantities[l.id] ?? '0',
        variantId: barcodeStatus[l.id]?.variantId,
      }))
      .filter(l => parseInt(l.receivedQty) > 0);
    if (lines.length === 0) return;
    setSaving(true);
    try {
      await onSave({ notes: notes || undefined, receivedAt, lines });
      onClose();
    } finally { setSaving(false); }
  };

  const anyQty = poLines.some(l => parseInt(quantities[l.id] ?? '0') > 0);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-xs text-muted-foreground mb-1 block">Received Date</label>
          <Input value={receivedAt} onChange={e => setReceivedAt(e.target.value)} type="date" />
        </div>
        <div>
          <label className="text-xs text-muted-foreground mb-1 block">Notes</label>
          <Input value={notes} onChange={e => setNotes(e.target.value)} placeholder="Condition, partial reason, etc." />
        </div>
      </div>
      <div>
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">Items Received</p>
        <div className="space-y-3">
          {poLines.map(l => {
            const remaining = l.quantity - l.receivedQty;
            const status = barcodeStatus[l.id];
            return (
              <div key={l.id} className="p-3 rounded-lg bg-white/5 space-y-2">
                <div className="flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-white truncate">{l.productName}</p>
                    <p className="text-xs text-muted-foreground">Ordered: {l.quantity} | Received: {l.receivedQty} | Remaining: {remaining}</p>
                  </div>
                  <div className="w-24 flex-shrink-0">
                    <Input
                      value={quantities[l.id] ?? '0'}
                      onChange={e => setQuantities(q => ({ ...q, [l.id]: e.target.value }))}
                      type="number" min="0" max={remaining} className="h-8 text-sm"
                    />
                  </div>
                </div>
                <div className="flex gap-2">
                  <Input
                    value={barcodeInputs[l.id] ?? ''}
                    onChange={e => setBarcodeInputs(b => ({ ...b, [l.id]: e.target.value }))}
                    onKeyDown={e => { if (e.key === 'Enter') lookupBarcode(l.id, l); }}
                    placeholder="Scan barcode — auto-counts on match…"
                    className="h-7 text-xs flex-1"
                  />
                  <Button size="sm" variant="outline" className="h-7 px-2"
                    onClick={() => lookupBarcode(l.id, l)}
                    disabled={scanLoading[l.id] || !(barcodeInputs[l.id] ?? '').trim()}>
                    <ScanLine className="w-3.5 h-3.5" />
                  </Button>
                </div>
                {status && (
                  <p className={`text-xs ${status.ok ? 'text-green-400' : 'text-yellow-400'}`}>{status.label}</p>
                )}
              </div>
            );
          })}
        </div>
      </div>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button onClick={handleSave} disabled={!anyQty || saving}>
          {saving ? 'Recording…' : 'Record Delivery'}
        </Button>
      </DialogFooter>
    </div>
  );
}

// ─── PO DETAIL PANEL ──────────────────────────────────────────────────────────

function PoDetailPanel({
  poId,
  orgId,
  suppliers,
  onClose,
  onRefresh,
}: {
  poId: number;
  orgId: number;
  suppliers: Supplier[];
  onClose: () => void;
  onRefresh: () => void;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [showDelivery, setShowDelivery] = useState(false);
  const [showEdit, setShowEdit] = useState(false);
  const [acting, setActing] = useState(false);

  const { data, isLoading, refetch } = useQuery<{
    purchaseOrder: PurchaseOrder;
    lines: PoLine[];
    receipts: DeliveryReceipt[];
    receiptLines: DeliveryReceiptLine[];
  }>({
    queryKey: [`/api/organizations/${orgId}/procurement/purchase-orders/${poId}`],
    queryFn: () => fetch(`/api/organizations/${orgId}/procurement/purchase-orders/${poId}`, { credentials: 'include' }).then(r => r.json()),
  });

  const po = data?.purchaseOrder;
  const lines = data?.lines ?? [];
  const receipts = data?.receipts ?? [];
  const receiptLines = data?.receiptLines ?? [];

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/procurement/purchase-orders`] });
    refetch();
    onRefresh();
  };

  const sendPo = async () => {
    setActing(true);
    try {
      const r = await fetch(`/api/organizations/${orgId}/procurement/purchase-orders/${poId}/send`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const d = await r.json();
      if (!r.ok) { toast({ title: 'Error', description: d.error, variant: 'destructive' }); return; }
      toast({ title: 'PO Sent', description: d.emailSent ? `Email sent to supplier` : 'PO marked as sent (email not configured)' });
      invalidate();
    } finally { setActing(false); }
  };

  const cancelPo = async () => {
    if (!confirm('Cancel this purchase order?')) return;
    setActing(true);
    try {
      const r = await fetch(`/api/organizations/${orgId}/procurement/purchase-orders/${poId}/cancel`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const d = await r.json();
      if (!r.ok) { toast({ title: 'Error', description: d.error, variant: 'destructive' }); return; }
      toast({ title: 'PO Cancelled' });
      invalidate();
    } finally { setActing(false); }
  };

  const recordDelivery = async (payload: { notes?: string; receivedAt?: string; lines: Array<{ purchaseOrderLineId: number; receivedQty: string; variantId?: number }> }) => {
    const r = await fetch(`/api/organizations/${orgId}/procurement/purchase-orders/${poId}/receipts`, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const d = await r.json();
    if (!r.ok) {
      const mismatches: Array<{ purchaseOrderLineId: number; expectedProductId: number | null; scannedVariantId: number }> = d.mismatches ?? [];
      const detail = mismatches.length > 0
        ? `${d.error}. Lines affected: ${mismatches.map(m => `line ${m.purchaseOrderLineId}`).join(', ')}`
        : d.error;
      toast({ title: 'Error', description: detail, variant: 'destructive' });
      throw new Error(d.error);
    }
    toast({ title: 'Delivery recorded', description: 'Stock levels updated.' });
    invalidate();
  };

  const updatePo = async (payload: { supplierId: number; expectedDeliveryDate?: string; notes?: string; lines: LineItem[] }) => {
    const r = await fetch(`/api/organizations/${orgId}/procurement/purchase-orders/${poId}`, {
      method: 'PUT', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const d = await r.json();
    if (!r.ok) { toast({ title: 'Error', description: d.error, variant: 'destructive' }); throw new Error(d.error); }
    toast({ title: 'PO updated' });
    invalidate();
  };

  if (isLoading) return (
    <div className="flex items-center justify-center h-64">
      <RefreshCw className="w-6 h-6 animate-spin text-primary" />
    </div>
  );

  if (!po) return null;

  const canEdit = ['draft', 'sent'].includes(po.status);
  const canSend = po.status === 'draft';
  const canDeliver = ['sent', 'partially_received'].includes(po.status);
  const canCancel = !['fully_received', 'cancelled'].includes(po.status);

  const pendingLines = lines.filter(l => l.receivedQty < l.quantity);

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-bold text-white">{po.poNumber}</h2>
            <Badge className={`text-xs border ${PO_STATUS_COLORS[po.status] ?? ''}`}>{PO_STATUS_LABELS[po.status] ?? po.status}</Badge>
          </div>
          <p className="text-sm text-muted-foreground mt-0.5">{po.supplierName}</p>
        </div>
        <div className="flex gap-2 flex-wrap justify-end">
          {canEdit && (
            <Button size="sm" variant="outline" onClick={() => setShowEdit(true)} className="gap-1">
              <Edit2 className="w-3.5 h-3.5" /> Edit
            </Button>
          )}
          {canSend && (
            <Button size="sm" onClick={sendPo} disabled={acting} className="gap-1">
              <Send className="w-3.5 h-3.5" /> Send PO
            </Button>
          )}
          {canDeliver && pendingLines.length > 0 && (
            <Button size="sm" variant="outline" onClick={() => setShowDelivery(true)} className="gap-1 border-emerald-500/40 text-emerald-400 hover:bg-emerald-500/10">
              <Truck className="w-3.5 h-3.5" /> Record Delivery
            </Button>
          )}
          {canCancel && (
            <Button size="sm" variant="ghost" onClick={cancelPo} disabled={acting} className="text-destructive hover:bg-destructive/10 gap-1">
              <XCircle className="w-3.5 h-3.5" /> Cancel
            </Button>
          )}
        </div>
      </div>

      {/* Details grid */}
      <div className="grid grid-cols-2 gap-3 text-sm">
        <div className="bg-white/5 rounded-lg p-3">
          <p className="text-xs text-muted-foreground mb-0.5">Supplier Contact</p>
          <p className="text-white font-medium">{po.supplierContactName ?? '—'}</p>
          {po.supplierEmail && <p className="text-primary text-xs">{po.supplierEmail}</p>}
          {po.supplierPhone && <p className="text-muted-foreground text-xs">{po.supplierPhone}</p>}
        </div>
        <div className="bg-white/5 rounded-lg p-3">
          <p className="text-xs text-muted-foreground mb-0.5">Delivery</p>
          <p className="text-white font-medium">{fmtDate(po.expectedDeliveryDate)}</p>
          {po.sentAt && <p className="text-xs text-muted-foreground">Sent: {fmtDate(po.sentAt)}</p>}
          {po.supplierPaymentTerms && <p className="text-xs text-muted-foreground">{po.supplierPaymentTerms}</p>}
        </div>
      </div>

      {po.notes && (
        <div className="bg-white/5 rounded-lg p-3 text-sm text-muted-foreground">
          <span className="text-white font-medium">Notes: </span>{po.notes}
        </div>
      )}

      {/* Line items */}
      <div>
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">Items</p>
        <div className="rounded-lg border border-white/10 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/10 bg-white/5">
                <th className="text-left px-3 py-2 text-xs text-muted-foreground font-medium">Product</th>
                <th className="text-center px-3 py-2 text-xs text-muted-foreground font-medium">Ordered</th>
                <th className="text-center px-3 py-2 text-xs text-muted-foreground font-medium">Received</th>
                <th className="text-right px-3 py-2 text-xs text-muted-foreground font-medium">Unit Cost</th>
                <th className="text-right px-3 py-2 text-xs text-muted-foreground font-medium">Total</th>
              </tr>
            </thead>
            <tbody>
              {lines.map(l => {
                const isFullyReceived = l.receivedQty >= l.quantity;
                return (
                  <tr key={l.id} className="border-b border-white/5">
                    <td className="px-3 py-2">
                      <p className="text-white">{l.productName}</p>
                      {l.sku && <p className="text-xs text-muted-foreground">{l.sku}</p>}
                    </td>
                    <td className="px-3 py-2 text-center text-white">{l.quantity}</td>
                    <td className="px-3 py-2 text-center">
                      <span className={isFullyReceived ? 'text-emerald-400' : l.receivedQty > 0 ? 'text-amber-400' : 'text-muted-foreground'}>
                        {l.receivedQty}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right text-white">{fmtCurrency(l.unitCost)}</td>
                    <td className="px-3 py-2 text-right text-white">{fmtCurrency(l.lineTotal)}</td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="border-t border-white/10">
                <td colSpan={4} className="px-3 py-2 text-right font-semibold text-white">Total</td>
                <td className="px-3 py-2 text-right font-bold text-white">{fmtCurrency(po.totalAmount)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      {/* Delivery receipts */}
      {receipts.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">Delivery History</p>
          <div className="space-y-2">
            {receipts.map(r => {
              const rLines = receiptLines.filter(rl => rl.deliveryReceiptId === r.id);
              return (
                <div key={r.id} className="bg-white/5 rounded-lg p-3">
                  <div className="flex items-center justify-between mb-1">
                    <div className="flex items-center gap-2">
                      <Truck className="w-4 h-4 text-emerald-400" />
                      <span className="text-sm font-medium text-white">Received {fmtDate(r.receivedAt)}</span>
                    </div>
                  </div>
                  {r.notes && <p className="text-xs text-muted-foreground mb-1">{r.notes}</p>}
                  <div className="space-y-0.5">
                    {rLines.map(rl => {
                      const poLine = lines.find(l => l.id === rl.purchaseOrderLineId);
                      return (
                        <p key={rl.id} className="text-xs text-muted-foreground">
                          {poLine?.productName ?? `Line #${rl.purchaseOrderLineId}`}: <span className="text-white">{rl.receivedQty} units</span>
                        </p>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Edit Dialog */}
      <Dialog open={showEdit} onOpenChange={setShowEdit}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader><DialogTitle>Edit Purchase Order</DialogTitle></DialogHeader>
          <PoForm
            suppliers={suppliers}
            initial={po}
            initialLines={lines}
            onSave={updatePo}
            onClose={() => setShowEdit(false)}
            orgId={orgId}
          />
        </DialogContent>
      </Dialog>

      {/* Delivery Dialog */}
      <Dialog open={showDelivery} onOpenChange={setShowDelivery}>
        <DialogContent className="max-w-xl max-h-[90vh] overflow-y-auto">
          <DialogHeader><DialogTitle>Record Delivery — {po.poNumber}</DialogTitle></DialogHeader>
          <DeliveryForm
            po={po}
            poLines={pendingLines}
            orgId={orgId}
            onSave={recordDelivery}
            onClose={() => setShowDelivery(false)}
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── MAIN PAGE ────────────────────────────────────────────────────────────────

export default function ProcurementPage() {
  const { data: user } = useGetMe();
  const orgId = useActiveOrgId() ?? user?.organizationId as number;
  const { toast } = useToast();
  const qc = useQueryClient();
  const [tab, setTab] = useState<'pos' | 'suppliers' | 'bundles' | 'tournament-merchandise'>('pos');
  const [statusFilter, setStatusFilter] = useState('all');
  const [supplierFilter, setSupplierFilter] = useState('all');
  const [showNewPo, setShowNewPo] = useState(false);
  const [showNewSupplier, setShowNewSupplier] = useState(false);
  const [editSupplier, setEditSupplier] = useState<Supplier | null>(null);
  const [selectedPoId, setSelectedPoId] = useState<number | null>(null);

  // Bundle state
  const [showBundleDialog, setShowBundleDialog] = useState(false);
  const [bundleForm, setBundleForm] = useState({ name: '', description: '', sku: '', price: '', isActive: true });
  const [editBundleId, setEditBundleId] = useState<number | null>(null);
  // Bundle component management (used when editing an existing bundle)
  const [bundleComponentProductId, setBundleComponentProductId] = useState('');
  const [bundleComponentQty, setBundleComponentQty] = useState('1');
  const [bundleComponentLoading, setBundleComponentLoading] = useState(false);

  // Tournament merchandise state
  const [tournamentMerchandiseTournamentId, setTournamentMerchandiseTournamentId] = useState<string>('');
  const [tournamentMerchandiseProductId, setTournamentMerchandiseProductId] = useState<string>('');
  const [tournamentMerchandiseNote, setTournamentMerchandiseNote] = useState('');

  const { data: suppliersData, isLoading: loadingSuppliers, refetch: refetchSuppliers } = useQuery<{ suppliers: Supplier[] }>({
    queryKey: [`/api/organizations/${orgId}/procurement/suppliers`],
    queryFn: () => fetch(`/api/organizations/${orgId}/procurement/suppliers`, { credentials: 'include' }).then(r => r.json()),
    enabled: !!orgId,
  });

  const suppliers = suppliersData?.suppliers ?? [];

  const { data: posData, isLoading: loadingPos, refetch: refetchPos } = useQuery<{ purchaseOrders: PurchaseOrder[] }>({
    queryKey: [`/api/organizations/${orgId}/procurement/purchase-orders`, statusFilter, supplierFilter],
    queryFn: () => {
      const params = new URLSearchParams();
      if (statusFilter !== 'all') params.set('status', statusFilter);
      if (supplierFilter !== 'all') params.set('supplierId', supplierFilter);
      return fetch(`/api/organizations/${orgId}/procurement/purchase-orders?${params}`, { credentials: 'include' }).then(r => r.json());
    },
    enabled: !!orgId,
  });

  const purchaseOrders = posData?.purchaseOrders ?? [];

  // Product bundles query
  const { data: bundlesData, refetch: refetchBundles } = useQuery<Array<{
    id: number; name: string; description: string | null; sku: string | null;
    price: string; currency: string; isActive: boolean; createdAt: string;
    components: Array<{ id: number; productId: number; variantId: number | null; quantity: number; productName: string }>;
  }>>({
    queryKey: [`/api/organizations/${orgId}/shop/bundles`],
    queryFn: () => fetch(`/api/organizations/${orgId}/shop/bundles`, { credentials: 'include' }).then(r => r.ok ? r.json() : []),
    enabled: !!orgId && tab === 'bundles',
  });
  const bundles = bundlesData ?? [];

  // Tournaments query (for tournament merchandise tab)
  const { data: tournamentsData } = useQuery<Array<{ id: number; name: string; startDate: string }>>({
    queryKey: [`/api/organizations/${orgId}/tournaments`],
    queryFn: () => fetch(`/api/organizations/${orgId}/tournaments`, { credentials: 'include' }).then(r => r.ok ? r.json() : []),
    enabled: !!orgId && tab === 'tournament-merchandise',
  });
  const tournaments = tournamentsData ?? [];

  // Products query (for tournament merchandise and bundle assignment)
  const { data: shopProductsData } = useQuery<{ products?: Array<{ id: number; name: string; category: string; basePrice: string }> } | Array<{ id: number; name: string; category: string; basePrice: string }>>({
    queryKey: [`/api/organizations/${orgId}/shop/products`, 'all'],
    queryFn: () => fetch(`/api/organizations/${orgId}/shop/products?limit=200`, { credentials: 'include' }).then(r => r.ok ? r.json() : []),
    enabled: !!orgId && (tab === 'tournament-merchandise' || tab === 'bundles'),
  });
  const shopProducts = (Array.isArray(shopProductsData) ? shopProductsData : (shopProductsData as { products?: Array<{ id: number; name: string; category: string; basePrice: string }> })?.products) ?? [];

  // Tournament merchandise query
  const { data: tournamentMerchandise, refetch: refetchTournamentMerchandise } = useQuery<Array<{
    id: number; tournamentId: number; note: string | null; displayOrder: number;
    product: { id: number; name: string; category: string; basePrice: string; currency: string };
  }>>({
    queryKey: [`/api/organizations/${orgId}/shop/tournaments/${tournamentMerchandiseTournamentId}/merchandise`],
    queryFn: () => fetch(`/api/organizations/${orgId}/shop/tournaments/${tournamentMerchandiseTournamentId}/merchandise`, { credentials: 'include' }).then(r => r.ok ? r.json() : []),
    enabled: !!orgId && !!tournamentMerchandiseTournamentId,
  });

  const createSupplier = async (data: Partial<Supplier>) => {
    const r = await fetch(`/api/organizations/${orgId}/procurement/suppliers`, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    const d = await r.json();
    if (!r.ok) { toast({ title: 'Error', description: d.error, variant: 'destructive' }); throw new Error(d.error); }
    toast({ title: 'Supplier added' });
    qc.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/procurement/suppliers`] });
  };

  const updateSupplier = async (id: number, data: Partial<Supplier>) => {
    const r = await fetch(`/api/organizations/${orgId}/procurement/suppliers/${id}`, {
      method: 'PUT', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    const d = await r.json();
    if (!r.ok) { toast({ title: 'Error', description: d.error, variant: 'destructive' }); throw new Error(d.error); }
    toast({ title: 'Supplier updated' });
    qc.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/procurement/suppliers`] });
  };

  const deactivateSupplier = async (s: Supplier) => {
    if (!confirm(`Deactivate supplier "${s.name}"?`)) return;
    const r = await fetch(`/api/organizations/${orgId}/procurement/suppliers/${s.id}`, {
      method: 'DELETE', credentials: 'include',
    });
    const d = await r.json();
    if (!r.ok) { toast({ title: 'Error', description: d.error, variant: 'destructive' }); return; }
    toast({ title: 'Supplier deactivated' });
    qc.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/procurement/suppliers`] });
  };

  const createPo = async (payload: { supplierId: number; expectedDeliveryDate?: string; notes?: string; lines: LineItem[] }) => {
    const r = await fetch(`/api/organizations/${orgId}/procurement/purchase-orders`, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const d = await r.json();
    if (!r.ok) { toast({ title: 'Error', description: d.error, variant: 'destructive' }); throw new Error(d.error); }
    toast({ title: 'Purchase order created', description: d.purchaseOrder?.poNumber });
    qc.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/procurement/purchase-orders`] });
    setSelectedPoId(d.purchaseOrder?.id);
  };

  const selectedPo = purchaseOrders.find(p => p.id === selectedPoId);

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2">
            <Package className="w-6 h-6" style={{ color: GOLD }} />
            Procurement
          </h1>
          <p className="text-muted-foreground text-sm mt-0.5">Manage suppliers and purchase orders for the pro shop</p>
        </div>
        <div className="flex gap-2">
          {tab === 'pos' && (
            <Button onClick={() => setShowNewPo(true)} className="gap-1.5" disabled={suppliers.filter(s => s.isActive).length === 0}>
              <Plus className="w-4 h-4" /> New PO
            </Button>
          )}
          {tab === 'suppliers' && (
            <Button onClick={() => setShowNewSupplier(true)} className="gap-1.5">
              <Plus className="w-4 h-4" /> Add Supplier
            </Button>
          )}
        </div>
      </div>

      <Tabs value={tab} onValueChange={v => { setTab(v as 'pos' | 'suppliers' | 'bundles' | 'tournament-merchandise'); setSelectedPoId(null); }}>
        <TabsList>
          <TabsTrigger value="pos" className="gap-1.5">
            <FileText className="w-3.5 h-3.5" /> Purchase Orders
          </TabsTrigger>
          <TabsTrigger value="suppliers" className="gap-1.5">
            <Building2 className="w-3.5 h-3.5" /> Suppliers
          </TabsTrigger>
          <TabsTrigger value="bundles" className="gap-1.5">
            <Layers className="w-3.5 h-3.5" /> Product Bundles
          </TabsTrigger>
          <TabsTrigger value="tournament-merchandise" className="gap-1.5">
            <Trophy className="w-3.5 h-3.5" /> Tournament Merch
          </TabsTrigger>
        </TabsList>

        {/* ── PURCHASE ORDERS TAB ── */}
        <TabsContent value="pos" className="mt-4">
          {selectedPoId ? (
            <Card className="bg-card/50 border-white/10">
              <CardHeader className="pb-3">
                <div className="flex items-center gap-2">
                  <Button variant="ghost" size="sm" onClick={() => setSelectedPoId(null)} className="gap-1 text-muted-foreground">
                    <ChevronRight className="w-4 h-4 rotate-180" /> Back to list
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                <PoDetailPanel
                  poId={selectedPoId}
                  orgId={orgId}
                  suppliers={suppliers}
                  onClose={() => setSelectedPoId(null)}
                  onRefresh={() => refetchPos()}
                />
              </CardContent>
            </Card>
          ) : (
            <>
              {/* Filters */}
              <div className="flex gap-3 mb-4">
                <Select value={statusFilter} onValueChange={setStatusFilter}>
                  <SelectTrigger className="w-48"><SelectValue placeholder="All statuses" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Statuses</SelectItem>
                    <SelectItem value="draft">Draft</SelectItem>
                    <SelectItem value="sent">Sent</SelectItem>
                    <SelectItem value="partially_received">Partially Received</SelectItem>
                    <SelectItem value="fully_received">Fully Received</SelectItem>
                    <SelectItem value="cancelled">Cancelled</SelectItem>
                  </SelectContent>
                </Select>
                <Select value={supplierFilter} onValueChange={setSupplierFilter}>
                  <SelectTrigger className="w-48"><SelectValue placeholder="All suppliers" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Suppliers</SelectItem>
                    {suppliers.map(s => <SelectItem key={s.id} value={String(s.id)}>{s.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>

              {loadingPos ? (
                <div className="flex justify-center py-16"><RefreshCw className="w-6 h-6 animate-spin text-primary" /></div>
              ) : purchaseOrders.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 text-center">
                  <ShoppingCart className="w-12 h-12 text-muted-foreground mb-3 opacity-30" />
                  <p className="text-white font-medium">No purchase orders found</p>
                  <p className="text-sm text-muted-foreground mt-1">
                    {suppliers.filter(s => s.isActive).length === 0
                      ? 'Add a supplier first before creating purchase orders.'
                      : 'Create your first purchase order to get started.'}
                  </p>
                </div>
              ) : (
                <div className="rounded-xl border border-white/10 overflow-hidden">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-white/10 bg-white/5">
                        <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground">PO Number</th>
                        <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground">Supplier</th>
                        <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground">Status</th>
                        <th className="text-right px-4 py-3 text-xs font-medium text-muted-foreground">Total</th>
                        <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground">Expected</th>
                        <th className="text-left px-4 py-3 text-xs font-medium text-muted-foreground">Created</th>
                        <th className="px-4 py-3" />
                      </tr>
                    </thead>
                    <tbody>
                      {purchaseOrders.map(po => (
                        <tr key={po.id} className="border-b border-white/5 hover:bg-white/5 cursor-pointer transition-colors" onClick={() => setSelectedPoId(po.id)}>
                          <td className="px-4 py-3">
                            <span className="font-mono font-medium text-white">{po.poNumber}</span>
                          </td>
                          <td className="px-4 py-3 text-white">{po.supplierName ?? '—'}</td>
                          <td className="px-4 py-3">
                            <Badge className={`text-xs border ${PO_STATUS_COLORS[po.status] ?? ''}`}>{PO_STATUS_LABELS[po.status] ?? po.status}</Badge>
                          </td>
                          <td className="px-4 py-3 text-right text-white font-medium">{fmtCurrency(po.totalAmount)}</td>
                          <td className="px-4 py-3 text-muted-foreground">{fmtDate(po.expectedDeliveryDate)}</td>
                          <td className="px-4 py-3 text-muted-foreground">{fmtDate(po.createdAt)}</td>
                          <td className="px-4 py-3">
                            <ChevronRight className="w-4 h-4 text-muted-foreground" />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </TabsContent>

        {/* ── SUPPLIERS TAB ── */}
        <TabsContent value="suppliers" className="mt-4">
          {loadingSuppliers ? (
            <div className="flex justify-center py-16"><RefreshCw className="w-6 h-6 animate-spin text-primary" /></div>
          ) : suppliers.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <Building2 className="w-12 h-12 text-muted-foreground mb-3 opacity-30" />
              <p className="text-white font-medium">No suppliers yet</p>
              <p className="text-sm text-muted-foreground mt-1">Add suppliers to start raising purchase orders.</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {suppliers.map(s => (
                <Card key={s.id} className={`bg-card/50 border-white/10 transition-all ${!s.isActive ? 'opacity-50' : ''}`}>
                  <CardContent className="p-4">
                    <div className="flex items-start justify-between mb-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <h3 className="font-semibold text-white truncate">{s.name}</h3>
                          {!s.isActive && <Badge variant="outline" className="text-xs">Inactive</Badge>}
                        </div>
                        {s.contactName && <p className="text-sm text-muted-foreground">{s.contactName}</p>}
                      </div>
                      <div className="flex gap-1 ml-2 flex-shrink-0">
                        <Button size="sm" variant="ghost" onClick={() => setEditSupplier(s)} className="h-7 w-7 p-0">
                          <Edit2 className="w-3.5 h-3.5" />
                        </Button>
                        {s.isActive && (
                          <Button size="sm" variant="ghost" onClick={() => deactivateSupplier(s)} className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive">
                            <Trash2 className="w-3.5 h-3.5" />
                          </Button>
                        )}
                      </div>
                    </div>
                    <div className="space-y-1 text-xs text-muted-foreground">
                      {s.email && <p className="truncate">{s.email}</p>}
                      {s.phone && <p>{s.phone}</p>}
                      {s.paymentTerms && <p><span className="text-white">Terms:</span> {s.paymentTerms}</p>}
                      {s.leadTimeDays != null && <p><span className="text-white">Lead time:</span> {s.leadTimeDays} days</p>}
                    </div>
                    <div className="mt-3 pt-3 border-t border-white/5 flex justify-between items-center">
                      <Button
                        size="sm" variant="ghost"
                        className="text-xs text-primary hover:text-primary gap-1 h-7 px-2"
                        onClick={() => { setSupplierFilter(String(s.id)); setTab('pos'); }}
                      >
                        <FileText className="w-3 h-3" /> View POs
                      </Button>
                      {s.isActive && (
                        <Button
                          size="sm" variant="ghost"
                          className="text-xs gap-1 h-7 px-2"
                          onClick={() => { setShowNewPo(true); }}
                        >
                          <Plus className="w-3 h-3" /> New PO
                        </Button>
                      )}
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>

        {/* ── PRODUCT BUNDLES TAB ── */}
        <TabsContent value="bundles" className="mt-4">
          <div className="flex justify-between items-center mb-4">
            <div>
              <h3 className="text-white font-semibold">Product Bundles</h3>
              <p className="text-white/50 text-xs mt-0.5">Create bundles of products sold as a single SKU. Selling a bundle auto-decrements component stock.</p>
            </div>
            <Button onClick={() => { setBundleForm({ name: '', description: '', sku: '', price: '', isActive: true }); setEditBundleId(null); setShowBundleDialog(true); }} className="gap-1.5">
              <Plus className="w-4 h-4" /> New Bundle
            </Button>
          </div>

          {bundles.length === 0 ? (
            <Card className="bg-card/50 border-white/10">
              <CardContent className="py-12 text-center text-white/40">
                <Layers className="w-8 h-8 mx-auto mb-3 opacity-30" />
                <p>No product bundles yet. Create one to package multiple products as a single SKU.</p>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-3">
              {bundles.map(bundle => (
                <Card key={bundle.id} className="bg-card/50 border-white/10">
                  <CardContent className="p-4">
                    <div className="flex items-start justify-between">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-white font-medium">{bundle.name}</span>
                          {bundle.sku && <span className="text-xs text-white/40 font-mono">{bundle.sku}</span>}
                          <Badge variant={bundle.isActive ? 'default' : 'secondary'} className="text-xs">
                            {bundle.isActive ? 'Active' : 'Inactive'}
                          </Badge>
                        </div>
                        {bundle.description && <p className="text-white/50 text-xs mt-0.5">{bundle.description}</p>}
                        <p className="text-[#C9A84C] font-semibold mt-1">
                          ₹{parseFloat(bundle.price).toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                        </p>
                        {bundle.components.length > 0 && (
                          <div className="mt-2 flex flex-wrap gap-1">
                            {bundle.components.map(c => (
                              <span key={c.id} className="text-xs bg-white/5 border border-white/10 rounded px-1.5 py-0.5 text-white/60">
                                {c.quantity}× {c.productName}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                      <div className="flex items-center gap-1 ml-3">
                        <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-white/40 hover:text-white" onClick={() => {
                          setBundleForm({ name: bundle.name, description: bundle.description ?? '', sku: bundle.sku ?? '', price: bundle.price, isActive: bundle.isActive });
                          setEditBundleId(bundle.id);
                          setShowBundleDialog(true);
                        }}>
                          <Edit2 className="w-3.5 h-3.5" />
                        </Button>
                        <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-red-400/60 hover:text-red-400" onClick={async () => {
                          if (!confirm('Delete this bundle?')) return;
                          await fetch(`/api/organizations/${orgId}/shop/bundles/${bundle.id}`, { method: 'DELETE', credentials: 'include' });
                          refetchBundles();
                        }}>
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>

        {/* ── TOURNAMENT MERCHANDISE TAB ── */}
        <TabsContent value="tournament-merchandise" className="mt-4">
          <div className="mb-4">
            <h3 className="text-white font-semibold mb-1">Tournament Merchandise</h3>
            <p className="text-white/50 text-xs">Link shop products to tournaments. These appear as event merchandise during registration.</p>
          </div>

          <div className="mb-4">
            <label className="text-xs text-white/60 block mb-1">Select Tournament</label>
            <Select value={tournamentMerchandiseTournamentId} onValueChange={setTournamentMerchandiseTournamentId}>
              <SelectTrigger className="bg-black/40 border-white/10 text-white max-w-sm">
                <SelectValue placeholder="Choose a tournament…" />
              </SelectTrigger>
              <SelectContent>
                {tournaments.map(t => (
                  <SelectItem key={t.id} value={String(t.id)}>{t.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {tournamentMerchandiseTournamentId && (
            <>
              <Card className="bg-card/50 border-white/10 mb-4">
                <CardContent className="p-4">
                  <h4 className="text-white text-sm font-medium mb-3 flex items-center gap-2">
                    <Plus className="w-4 h-4 text-[#C9A84C]" /> Add Product to Tournament
                  </h4>
                  <div className="flex gap-2 flex-wrap">
                    <Select value={tournamentMerchandiseProductId} onValueChange={setTournamentMerchandiseProductId}>
                      <SelectTrigger className="bg-black/40 border-white/10 text-white w-64">
                        <SelectValue placeholder="Select product…" />
                      </SelectTrigger>
                      <SelectContent>
                        {shopProducts.map(p => (
                          <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Input
                      placeholder="Note (optional)"
                      value={tournamentMerchandiseNote}
                      onChange={e => setTournamentMerchandiseNote(e.target.value)}
                      className="bg-black/40 border-white/10 text-white w-40 text-sm"
                    />
                    <Button
                      disabled={!tournamentMerchandiseProductId}
                      onClick={async () => {
                        if (!tournamentMerchandiseProductId) return;
                        const r = await fetch(`/api/organizations/${orgId}/shop/tournaments/${tournamentMerchandiseTournamentId}/merchandise`, {
                          method: 'POST', credentials: 'include',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ productId: parseInt(tournamentMerchandiseProductId), note: tournamentMerchandiseNote || null }),
                        });
                        if (r.ok) {
                          setTournamentMerchandiseProductId('');
                          setTournamentMerchandiseNote('');
                          refetchTournamentMerchandise();
                          toast({ title: 'Product linked to tournament' });
                        } else {
                          const e = await r.json();
                          toast({ title: 'Error', description: e.error, variant: 'destructive' });
                        }
                      }}
                    >
                      <Plus className="w-4 h-4 mr-1" /> Link Product
                    </Button>
                  </div>
                </CardContent>
              </Card>

              {(tournamentMerchandise ?? []).length === 0 ? (
                <Card className="bg-card/50 border-white/10">
                  <CardContent className="py-10 text-center text-white/40">
                    <Trophy className="w-8 h-8 mx-auto mb-3 opacity-30" />
                    <p className="text-sm">No merchandise linked to this tournament yet.</p>
                  </CardContent>
                </Card>
              ) : (
                <div className="space-y-2">
                  {(tournamentMerchandise ?? []).map(item => (
                    <Card key={item.id} className="bg-card/50 border-white/10">
                      <CardContent className="p-3 flex items-center justify-between">
                        <div>
                          <span className="text-white text-sm font-medium">{item.product.name}</span>
                          <span className="ml-2 text-xs text-white/40 capitalize">{item.product.category}</span>
                          {item.note && <span className="ml-2 text-xs text-white/50 italic">{item.note}</span>}
                          <p className="text-[#C9A84C] text-xs mt-0.5">₹{parseFloat(item.product.basePrice).toLocaleString('en-IN')}</p>
                        </div>
                        <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-red-400/60 hover:text-red-400" onClick={async () => {
                          await fetch(`/api/organizations/${orgId}/shop/tournaments/${tournamentMerchandiseTournamentId}/merchandise/${item.id}`, {
                            method: 'DELETE', credentials: 'include'
                          });
                          refetchTournamentMerchandise();
                        }}>
                          <X className="w-3.5 h-3.5" />
                        </Button>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              )}
            </>
          )}
        </TabsContent>
      </Tabs>

      {/* Bundle Create/Edit Dialog */}
      <Dialog open={showBundleDialog} onOpenChange={open => {
        setShowBundleDialog(open);
        if (!open) { setBundleComponentProductId(''); setBundleComponentQty('1'); }
      }}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editBundleId ? 'Edit Bundle' : 'Create Product Bundle'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <label className="text-xs text-white/60 block mb-1">Bundle Name *</label>
              <Input value={bundleForm.name} onChange={e => setBundleForm(f => ({ ...f, name: e.target.value }))} className="bg-black/40 border-white/10 text-white" />
            </div>
            <div>
              <label className="text-xs text-white/60 block mb-1">SKU</label>
              <Input value={bundleForm.sku} onChange={e => setBundleForm(f => ({ ...f, sku: e.target.value }))} className="bg-black/40 border-white/10 text-white" placeholder="Optional" />
            </div>
            <div>
              <label className="text-xs text-white/60 block mb-1">Price (₹) *</label>
              <Input type="number" value={bundleForm.price} onChange={e => setBundleForm(f => ({ ...f, price: e.target.value }))} className="bg-black/40 border-white/10 text-white" />
            </div>
            <div>
              <label className="text-xs text-white/60 block mb-1">Description</label>
              <Input value={bundleForm.description} onChange={e => setBundleForm(f => ({ ...f, description: e.target.value }))} className="bg-black/40 border-white/10 text-white" placeholder="Optional" />
            </div>
          </div>

          {/* ── Component management (only when editing an existing bundle) ── */}
          {editBundleId && (() => {
            const currentBundle = bundles.find(b => b.id === editBundleId);
            const components = currentBundle?.components ?? [];
            return (
              <div className="mt-4 border-t border-white/10 pt-4 space-y-3">
                <p className="text-xs font-semibold text-white/70 uppercase tracking-wider">Components</p>
                <p className="text-xs text-white/40">These products' stock will be decremented when the bundle is sold.</p>
                {components.length === 0 ? (
                  <p className="text-xs text-white/30 italic">No components added yet.</p>
                ) : (
                  <div className="space-y-1.5">
                    {components.map(c => (
                      <div key={c.id} className="flex items-center justify-between bg-white/5 rounded px-2 py-1.5 text-xs">
                        <span className="text-white/80">{c.productName}</span>
                        <div className="flex items-center gap-2">
                          <span className="text-white/40">×{c.quantity}</span>
                          <button
                            className="text-red-400 hover:text-red-300 transition-colors"
                            title="Remove component"
                            onClick={async () => {
                              setBundleComponentLoading(true);
                              try {
                                const r = await fetch(`/api/organizations/${orgId}/shop/bundles/${editBundleId}/components/${c.id}`, {
                                  method: 'DELETE', credentials: 'include',
                                });
                                if (r.ok) { refetchBundles(); toast({ title: 'Component removed' }); }
                                else { const e = await r.json(); toast({ title: 'Error', description: e.error, variant: 'destructive' }); }
                              } finally { setBundleComponentLoading(false); }
                            }}
                          >✕</button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                {/* Add component row */}
                <div className="flex gap-2 items-end">
                  <div className="flex-1">
                    <label className="text-xs text-white/50 block mb-1">Product</label>
                    <select
                      value={bundleComponentProductId}
                      onChange={e => setBundleComponentProductId(e.target.value)}
                      className="w-full bg-black/40 border border-white/10 text-white rounded px-2 py-1.5 text-xs"
                    >
                      <option value="">Select a product…</option>
                      {shopProducts.map(p => (
                        <option key={p.id} value={String(p.id)}>{p.name}</option>
                      ))}
                    </select>
                  </div>
                  <div className="w-16">
                    <label className="text-xs text-white/50 block mb-1">Qty</label>
                    <Input
                      type="number" min="1" value={bundleComponentQty}
                      onChange={e => setBundleComponentQty(e.target.value)}
                      className="bg-black/40 border-white/10 text-white text-xs px-2 py-1.5 h-auto"
                    />
                  </div>
                  <Button
                    size="sm" variant="secondary"
                    disabled={!bundleComponentProductId || bundleComponentLoading}
                    onClick={async () => {
                      setBundleComponentLoading(true);
                      try {
                        const r = await fetch(`/api/organizations/${orgId}/shop/bundles/${editBundleId}/components`, {
                          method: 'POST', credentials: 'include',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ productId: parseInt(bundleComponentProductId), quantity: parseInt(bundleComponentQty) || 1 }),
                        });
                        if (r.ok) {
                          refetchBundles();
                          setBundleComponentProductId('');
                          setBundleComponentQty('1');
                          toast({ title: 'Component added' });
                        } else {
                          const e = await r.json();
                          toast({ title: 'Error', description: e.error, variant: 'destructive' });
                        }
                      } finally { setBundleComponentLoading(false); }
                    }}
                  >Add</Button>
                </div>
              </div>
            );
          })()}

          <DialogFooter className="mt-4">
            <Button variant="outline" onClick={() => setShowBundleDialog(false)}>Cancel</Button>
            <Button
              disabled={!bundleForm.name || !bundleForm.price}
              onClick={async () => {
                const url = editBundleId
                  ? `/api/organizations/${orgId}/shop/bundles/${editBundleId}`
                  : `/api/organizations/${orgId}/shop/bundles`;
                const method = editBundleId ? 'PATCH' : 'POST';
                const r = await fetch(url, {
                  method, credentials: 'include',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify(bundleForm),
                });
                if (r.ok) {
                  const data = await r.json();
                  refetchBundles();
                  if (!editBundleId) {
                    // After creating, switch to edit mode so the user can add components immediately
                    setEditBundleId(data.id);
                    setBundleComponentProductId('');
                    setBundleComponentQty('1');
                    toast({ title: 'Bundle created — add components below' });
                  } else {
                    toast({ title: 'Bundle updated' });
                  }
                } else {
                  const e = await r.json();
                  toast({ title: 'Error', description: e.error, variant: 'destructive' });
                }
              }}
            >
              {editBundleId ? 'Save Changes' : 'Create Bundle'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* New PO Dialog */}
      <Dialog open={showNewPo} onOpenChange={setShowNewPo}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader><DialogTitle>Create Purchase Order</DialogTitle></DialogHeader>
          <PoForm
            suppliers={suppliers}
            onSave={createPo}
            onClose={() => setShowNewPo(false)}
            orgId={orgId}
          />
        </DialogContent>
      </Dialog>

      {/* New Supplier Dialog */}
      <Dialog open={showNewSupplier} onOpenChange={setShowNewSupplier}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>Add Supplier</DialogTitle></DialogHeader>
          <SupplierForm
            onSave={createSupplier}
            onClose={() => setShowNewSupplier(false)}
          />
        </DialogContent>
      </Dialog>

      {/* Edit Supplier Dialog */}
      <Dialog open={!!editSupplier} onOpenChange={o => { if (!o) setEditSupplier(null); }}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>Edit Supplier</DialogTitle></DialogHeader>
          {editSupplier && (
            <SupplierForm
              initial={editSupplier}
              onSave={data => updateSupplier(editSupplier.id, data)}
              onClose={() => setEditSupplier(null)}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
