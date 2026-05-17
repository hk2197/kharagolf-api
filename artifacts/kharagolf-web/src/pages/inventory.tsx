import { useState, useRef, useEffect, useCallback } from 'react';
import { useLocation } from 'wouter';
import { useActiveOrgContext } from '@/context/ActiveOrgContext';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Package, MapPin, ArrowLeftRight, ClipboardList, BarChart3, Plus, Edit2,
  AlertTriangle, CheckCircle2, Search, ScanLine, Loader2, RefreshCw,
  Download, Truck, Settings, X, TrendingDown, TrendingUp, Archive,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useToast } from '@/hooks/use-toast';

const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');
const GOLD = '#C9A84C';

function fmt(n: number | string | null | undefined) {
  if (n == null) return '—';
  const num = typeof n === 'string' ? parseFloat(n) : n;
  if (isNaN(num)) return '—';
  return `₹${num.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

interface Location {
  id: number;
  name: string;
  type: string;
  isDefault: boolean;
  isActive: boolean;
}

interface VariantStock {
  locationId: number;
  locationName: string;
  quantity: number;
  reorderPoint: number | null;
  reorderQty: number | null;
  belowReorder: boolean;
}

interface Variant {
  id: number;
  productId: number;
  color: string | null;
  size: string | null;
  barcode: string | null;
  sku: string | null;
  costPrice: string | null;
  stockQty: number;
  stock: VariantStock[];
  totalStock: number;
}

interface Product {
  id: number;
  name: string;
  category: string;
  markupPrice: string;
  basePrice: string;
  imageUrl: string | null;
  isActive: boolean;
  variants: Variant[];
}

interface StocktakeSession {
  id: number;
  locationId: number;
  status: string;
  notes: string | null;
  createdAt: string;
  completedAt: string | null;
}

interface StocktakeItem {
  id: number;
  variantId: number;
  expectedQty: number;
  countedQty: number;
  color: string | null;
  size: string | null;
  barcode: string | null;
  sku: string | null;
  productId: number | null;
  productName: string | null;
}

interface LowStockAlert {
  variantId: number;
  locationId: number;
  locationName: string;
  quantity: number;
  reorderPoint: number | null;
  reorderQty: number | null;
  deficit: number;
  productName: string | null;
  color: string | null;
  size: string | null;
  sku: string | null;
}

// ─── BARCODE SCANNER COMPONENT ─────────────────────────────────────────────────
// Uses the BarcodeDetector API (Chrome/Edge/Safari 17+) for real camera decoding.
// Falls back to keyboard-wedge / manual entry when API is unavailable.

function BarcodeScanner({ onScan, onClose }: { onScan: (code: string) => void; onClose: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [manualCode, setManualCode] = useState('');
  const [cameraError, setCameraError] = useState('');
  const [scanStatus, setScanStatus] = useState('Initialising camera…');
  const streamRef = useRef<MediaStream | null>(null);
  const animFrameRef = useRef<number | null>(null);
  const scannedRef = useRef(false);

  useEffect(() => {
    let active = true;

    const hasBarcodeDetector = typeof window.BarcodeDetector !== 'undefined';

    if (!hasBarcodeDetector) {
      setCameraError('');
      setScanStatus('Keyboard scanner / manual mode');
    }

    navigator.mediaDevices?.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } } })
      .then(stream => {
        if (!active) { stream.getTracks().forEach(t => t.stop()); return; }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.play().catch(() => null);
        }

        if (!hasBarcodeDetector) { setScanStatus('Camera ready. Point at barcode or type below.'); return; }

        const detector = new window.BarcodeDetector!({ formats: ['ean_13', 'ean_8', 'code_128', 'upc_a', 'upc_e', 'qr_code', 'data_matrix'] });
        setScanStatus('Scanning — point camera at barcode…');

        const scan = async () => {
          if (!active || scannedRef.current) return;
          try {
            const results = await detector.detect(videoRef.current!);
            if (results.length > 0 && !scannedRef.current) {
              scannedRef.current = true;
              const code = results[0].rawValue as string;
              onScan(code);
              return;
            }
          } catch { /* detection frame error — continue */ }
          if (active) animFrameRef.current = requestAnimationFrame(scan);
        };

        videoRef.current?.addEventListener('playing', () => {
          if (active) animFrameRef.current = requestAnimationFrame(scan);
        }, { once: true });
      })
      .catch(() => {
        setCameraError('Camera not available. Use a USB/Bluetooth barcode scanner or type below.');
        setScanStatus('Manual entry mode');
      });

    return () => {
      active = false;
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
      streamRef.current?.getTracks().forEach(t => t.stop());
    };
  }, [onScan]);

  const handleManual = () => {
    if (manualCode.trim()) { onScan(manualCode.trim()); setManualCode(''); }
  };

  return (
    <div className="space-y-4">
      {cameraError ? (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-amber-500/10 text-amber-300 text-sm">
          <AlertTriangle className="w-4 h-4 flex-shrink-0" />
          <span>{cameraError}</span>
        </div>
      ) : (
        <div className="relative rounded-lg overflow-hidden bg-black aspect-video">
          <video ref={videoRef} autoPlay playsInline muted className="w-full h-full object-cover" />
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="w-56 h-28 border-2 border-yellow-400 rounded opacity-80" style={{ boxShadow: '0 0 0 1000px rgba(0,0,0,0.4)' }} />
          </div>
          <div className="absolute inset-x-0 bottom-2 flex justify-center">
            <span className="text-xs text-white/80 bg-black/50 px-2 py-0.5 rounded-full">{scanStatus}</span>
          </div>
        </div>
      )}
      <div className="flex gap-2">
        <Input
          value={manualCode}
          onChange={e => setManualCode(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleManual()}
          placeholder="Scan or type barcode / SKU"
          className="flex-1"
          autoFocus={!!cameraError}
        />
        <Button onClick={handleManual} disabled={!manualCode.trim()}>Lookup</Button>
      </div>
      <Button variant="ghost" size="sm" onClick={onClose} className="w-full">Cancel</Button>
    </div>
  );
}

// ─── LOCATION FORM ─────────────────────────────────────────────────────────────

function LocationForm({ initial, onSave, onClose }: {
  initial?: Partial<Location>;
  onSave: (d: { name: string; type: string; isDefault: boolean }) => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [type, setType] = useState(initial?.type ?? 'pro_shop');
  const [isDefault, setIsDefault] = useState(initial?.isDefault ?? false);
  const [saving, setSaving] = useState(false);

  return (
    <div className="space-y-4">
      <div>
        <label className="text-xs text-muted-foreground mb-1 block">Location Name *</label>
        <Input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Pro Shop, Halfway House" />
      </div>
      <div>
        <label className="text-xs text-muted-foreground mb-1 block">Type</label>
        <Select value={type} onValueChange={setType}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="pro_shop">Pro Shop</SelectItem>
            <SelectItem value="halfway_house">Halfway House</SelectItem>
            <SelectItem value="driving_range">Driving Range Kiosk</SelectItem>
            <SelectItem value="warehouse">Warehouse / Store Room</SelectItem>
            <SelectItem value="other">Other</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <label className="flex items-center gap-2 cursor-pointer">
        <input type="checkbox" checked={isDefault} onChange={e => setIsDefault(e.target.checked)} className="rounded" />
        <span className="text-sm text-white">Set as default location</span>
      </label>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button disabled={!name.trim() || saving} onClick={async () => {
          setSaving(true);
          try { await onSave({ name: name.trim(), type, isDefault }); onClose(); }
          finally { setSaving(false); }
        }}>
          {saving ? 'Saving…' : initial?.id ? 'Update' : 'Create'}
        </Button>
      </DialogFooter>
    </div>
  );
}

// ─── STOCK EDIT DIALOG ────────────────────────────────────────────────────────

function StockEditDialog({ variant, locations, orgId, onClose }: {
  variant: Variant;
  locations: Location[];
  orgId: number;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [locationId, setLocationId] = useState(locations[0]?.id ? String(locations[0].id) : '');
  const [quantity, setQuantity] = useState('0');
  const [reorderPoint, setReorderPoint] = useState('');
  const [reorderQty, setReorderQty] = useState('');
  const [barcode, setBarcode] = useState(variant.barcode ?? '');
  const [sku, setSku] = useState(variant.sku ?? '');
  const [costPrice, setCostPrice] = useState(variant.costPrice ?? '');
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState<'stock' | 'barcode'>('stock');

  const selectedLoc = variant.stock.find(s => s.locationId === parseInt(locationId));
  useEffect(() => {
    if (selectedLoc) {
      setQuantity(String(selectedLoc.quantity));
      setReorderPoint(selectedLoc.reorderPoint != null ? String(selectedLoc.reorderPoint) : '');
      setReorderQty(selectedLoc.reorderQty != null ? String(selectedLoc.reorderQty) : '');
    } else {
      setQuantity('0');
      setReorderPoint('');
      setReorderQty('');
    }
  }, [locationId]);

  const saveStock = async () => {
    setSaving(true);
    try {
      const r = await fetch(`${BASE}/api/organizations/${orgId}/inventory/variants/${variant.id}/stock`, {
        method: 'PUT', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          locationId: parseInt(locationId),
          quantity: parseInt(quantity),
          reorderPoint: reorderPoint ? parseInt(reorderPoint) : null,
          reorderQty: reorderQty ? parseInt(reorderQty) : null,
        }),
      });
      const d = await r.json();
      if (!r.ok) { toast({ title: 'Error', description: d.error, variant: 'destructive' }); return; }
      toast({ title: 'Stock updated' });
      qc.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/inventory/overview`] });
    } finally { setSaving(false); }
  };

  const saveBarcode = async () => {
    setSaving(true);
    try {
      const r = await fetch(`${BASE}/api/organizations/${orgId}/inventory/variants/${variant.id}/barcode`, {
        method: 'PATCH', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ barcode: barcode || null, sku: sku || null, costPrice: costPrice || null }),
      });
      const d = await r.json();
      if (!r.ok) { toast({ title: 'Error', description: d.error, variant: 'destructive' }); return; }
      toast({ title: 'Variant updated' });
      qc.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/inventory/overview`] });
      onClose();
    } finally { setSaving(false); }
  };

  const variantLabel = [variant.color, variant.size].filter(Boolean).join(' / ') || 'Default';

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">Editing: <span className="text-white font-medium">{variantLabel}</span></p>

      <div className="flex gap-2 mb-2">
        <Button size="sm" variant={tab === 'stock' ? 'default' : 'outline'} onClick={() => setTab('stock')}>Stock Levels</Button>
        <Button size="sm" variant={tab === 'barcode' ? 'default' : 'outline'} onClick={() => setTab('barcode')}>Barcode / SKU</Button>
      </div>

      {tab === 'stock' && (
        <div className="space-y-3">
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Location</label>
            <Select value={locationId} onValueChange={setLocationId}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {locations.map(l => <SelectItem key={l.id} value={String(l.id)}>{l.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Quantity</label>
              <Input value={quantity} onChange={e => setQuantity(e.target.value)} type="number" min="0" />
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Reorder Point</label>
              <Input value={reorderPoint} onChange={e => setReorderPoint(e.target.value)} type="number" min="0" placeholder="—" />
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Reorder Qty</label>
              <Input value={reorderQty} onChange={e => setReorderQty(e.target.value)} type="number" min="0" placeholder="—" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <Button disabled={saving || !locationId} onClick={saveStock}>{saving ? 'Saving…' : 'Save Stock'}</Button>
          </DialogFooter>
        </div>
      )}

      {tab === 'barcode' && (
        <div className="space-y-3">
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Barcode (EAN-13 / UPC-A / Custom)</label>
            <Input value={barcode} onChange={e => setBarcode(e.target.value)} placeholder="e.g. 4901234567890" />
          </div>
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">SKU</label>
            <Input value={sku} onChange={e => setSku(e.target.value)} placeholder="e.g. TW-POLO-RED-M" />
          </div>
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Cost Price</label>
            <Input value={costPrice} onChange={e => setCostPrice(e.target.value)} type="number" min="0" step="0.01" placeholder="0.00" />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <Button disabled={saving} onClick={saveBarcode}>{saving ? 'Saving…' : 'Save'}</Button>
          </DialogFooter>
        </div>
      )}
    </div>
  );
}

// ─── TRANSFER FORM ────────────────────────────────────────────────────────────

function TransferForm({ locations, products, orgId, onClose }: {
  locations: Location[];
  products: Product[];
  orgId: number;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [fromLocationId, setFromLocationId] = useState('');
  const [toLocationId, setToLocationId] = useState('');
  const [selectedProductId, setSelectedProductId] = useState('');
  const [variantId, setVariantId] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [barcodeInput, setBarcodeInput] = useState('');
  const [barcodeLoading, setBarcodeLoading] = useState(false);
  const [barcodeFound, setBarcodeFound] = useState<string | null>(null);

  const selectedProduct = products.find(p => p.id === parseInt(selectedProductId));
  const selectedVariant = selectedProduct?.variants.find(v => v.id === parseInt(variantId));
  const fromStock = selectedVariant?.stock.find(s => s.locationId === parseInt(fromLocationId));

  const handleBarcodeSearch = async () => {
    if (!barcodeInput.trim()) return;
    setBarcodeLoading(true);
    setBarcodeFound(null);
    try {
      const r = await fetch(`${BASE}/api/organizations/${orgId}/inventory/barcode/${encodeURIComponent(barcodeInput.trim())}`, { credentials: 'include' });
      if (!r.ok) { toast({ title: 'Barcode not found', description: `No product matched "${barcodeInput.trim()}"`, variant: 'destructive' }); return; }
      const d = await r.json();
      const v = d.variant;
      setSelectedProductId(String(v.productId));
      setVariantId(String(v.variantId));
      const label = [v.variantColor, v.variantSize].filter(Boolean).join(' / ') || 'Default';
      setBarcodeFound(`${v.productName} — ${label}`);
    } catch { toast({ title: 'Error', description: 'Barcode lookup failed', variant: 'destructive' }); }
    finally { setBarcodeLoading(false); }
  };

  const isValid = fromLocationId && toLocationId && fromLocationId !== toLocationId
    && variantId && parseInt(quantity) > 0;

  const handleSave = async () => {
    setSaving(true);
    try {
      const r = await fetch(`${BASE}/api/organizations/${orgId}/inventory/transfers`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fromLocationId: parseInt(fromLocationId),
          toLocationId: parseInt(toLocationId),
          variantId: parseInt(variantId),
          quantity: parseInt(quantity),
          notes: notes || undefined,
        }),
      });
      const d = await r.json();
      if (!r.ok) { toast({ title: 'Error', description: d.error, variant: 'destructive' }); return; }
      toast({ title: 'Stock transferred successfully' });
      qc.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/inventory/overview`] });
      qc.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/inventory/transfers`] });
      onClose();
    } finally { setSaving(false); }
  };

  return (
    <div className="space-y-4">
      <div>
        <label className="text-xs text-muted-foreground mb-1 block">Scan Barcode to Find Variant</label>
        <div className="flex gap-2">
          <Input
            value={barcodeInput}
            onChange={e => setBarcodeInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleBarcodeSearch(); }}
            placeholder="Scan or type barcode / SKU…"
            className="flex-1 h-8 text-sm"
          />
          <Button size="sm" variant="outline" onClick={handleBarcodeSearch} disabled={barcodeLoading || !barcodeInput.trim()}>
            {barcodeLoading ? '…' : 'Find'}
          </Button>
        </div>
        {barcodeFound && (
          <p className="text-xs text-green-400 mt-1">Matched: {barcodeFound}</p>
        )}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-xs text-muted-foreground mb-1 block">From Location *</label>
          <Select value={fromLocationId} onValueChange={setFromLocationId}>
            <SelectTrigger><SelectValue placeholder="Select location" /></SelectTrigger>
            <SelectContent>
              {locations.map(l => <SelectItem key={l.id} value={String(l.id)}>{l.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div>
          <label className="text-xs text-muted-foreground mb-1 block">To Location *</label>
          <Select value={toLocationId} onValueChange={setToLocationId}>
            <SelectTrigger><SelectValue placeholder="Select location" /></SelectTrigger>
            <SelectContent>
              {locations.filter(l => l.id !== parseInt(fromLocationId)).map(l => (
                <SelectItem key={l.id} value={String(l.id)}>{l.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <div>
        <label className="text-xs text-muted-foreground mb-1 block">Product *</label>
        <Select value={selectedProductId} onValueChange={v => { setSelectedProductId(v); setVariantId(''); }}>
          <SelectTrigger><SelectValue placeholder="Select product" /></SelectTrigger>
          <SelectContent>
            {products.map(p => <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      {selectedProduct && selectedProduct.variants.length > 0 && (
        <div>
          <label className="text-xs text-muted-foreground mb-1 block">Variant *</label>
          <Select value={variantId} onValueChange={setVariantId}>
            <SelectTrigger><SelectValue placeholder="Select variant" /></SelectTrigger>
            <SelectContent>
              {selectedProduct.variants.map(v => {
                const label = [v.color, v.size].filter(Boolean).join(' / ') || 'Default';
                const avail = fromLocationId ? (v.stock.find(s => s.locationId === parseInt(fromLocationId))?.quantity ?? 0) : v.totalStock;
                return <SelectItem key={v.id} value={String(v.id)}>{label} (avail: {avail})</SelectItem>;
              })}
            </SelectContent>
          </Select>
        </div>
      )}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-xs text-muted-foreground mb-1 block">Quantity *</label>
          <Input value={quantity} onChange={e => setQuantity(e.target.value)} type="number" min="1"
            max={fromStock?.quantity ?? undefined} />
          {fromStock != null && (
            <p className="text-xs text-muted-foreground mt-1">Available at source: {fromStock.quantity}</p>
          )}
        </div>
        <div>
          <label className="text-xs text-muted-foreground mb-1 block">Notes</label>
          <Input value={notes} onChange={e => setNotes(e.target.value)} placeholder="Optional" />
        </div>
      </div>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button disabled={!isValid || saving} onClick={handleSave}>
          {saving ? 'Transferring…' : 'Transfer Stock'}
        </Button>
      </DialogFooter>
    </div>
  );
}

// ─── STOCKTAKE VIEW ───────────────────────────────────────────────────────────

function StocktakeView({ orgId, locations }: { orgId: number; locations: Location[] }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [showNewSession, setShowNewSession] = useState(false);
  const [newLocationId, setNewLocationId] = useState('');
  const [newNotes, setNewNotes] = useState('');
  const [activeSessionId, setActiveSessionId] = useState<number | null>(null);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [completing, setCompleting] = useState(false);

  const sessionsQuery = useQuery<{ sessions: StocktakeSession[] }>({
    queryKey: [`/api/organizations/${orgId}/inventory/stocktake/sessions`],
    queryFn: () => fetch(`${BASE}/api/organizations/${orgId}/inventory/stocktake/sessions`, { credentials: 'include' }).then(r => r.json()),
  });

  const sessionDetailQuery = useQuery<{ session: StocktakeSession; items: StocktakeItem[] }>({
    queryKey: [`/api/organizations/${orgId}/inventory/stocktake/sessions/${activeSessionId}`],
    queryFn: () => fetch(`${BASE}/api/organizations/${orgId}/inventory/stocktake/sessions/${activeSessionId}`, { credentials: 'include' }).then(r => r.json()),
    enabled: activeSessionId != null,
  });

  const createSession = async () => {
    if (!newLocationId) return;
    const r = await fetch(`${BASE}/api/organizations/${orgId}/inventory/stocktake/sessions`, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ locationId: parseInt(newLocationId), notes: newNotes || undefined }),
    });
    const d = await r.json();
    if (!r.ok) { toast({ title: 'Error', description: d.error, variant: 'destructive' }); return; }
    toast({ title: 'Stocktake session started' });
    qc.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/inventory/stocktake/sessions`] });
    setShowNewSession(false);
    setActiveSessionId(d.session.id);
  };

  const handleScan = async (barcode: string) => {
    if (!activeSessionId) return;
    const r = await fetch(`${BASE}/api/organizations/${orgId}/inventory/stocktake/sessions/${activeSessionId}/scan`, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ barcode }),
    });
    const d = await r.json();
    if (!r.ok) { toast({ title: 'Barcode not found', description: d.error, variant: 'destructive' }); return; }
    toast({ title: 'Item counted', description: `Scanned successfully` });
    qc.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/inventory/stocktake/sessions/${activeSessionId}`] });
  };

  const updateCountedQty = async (variantId: number, qty: number) => {
    if (!activeSessionId) return;
    await fetch(`${BASE}/api/organizations/${orgId}/inventory/stocktake/sessions/${activeSessionId}/scan`, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ variantId, countedQty: qty, setAbsolute: true }),
    });
    qc.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/inventory/stocktake/sessions/${activeSessionId}`] });
  };

  const completeSession = async () => {
    if (!activeSessionId) return;
    setCompleting(true);
    try {
      const r = await fetch(`${BASE}/api/organizations/${orgId}/inventory/stocktake/sessions/${activeSessionId}/complete`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ applyAdjustments: true }),
      });
      const d = await r.json();
      if (!r.ok) { toast({ title: 'Error', description: d.error, variant: 'destructive' }); return; }
      toast({ title: 'Stocktake complete', description: `${d.discrepanciesApplied} adjustments applied` });
      qc.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/inventory/stocktake/sessions`] });
      qc.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/inventory/overview`] });
      setActiveSessionId(null);
    } finally { setCompleting(false); }
  };

  const sessions = sessionsQuery.data?.sessions ?? [];
  const session = sessionDetailQuery.data?.session;
  const items = sessionDetailQuery.data?.items ?? [];
  const discrepancies = items.filter(i => i.countedQty !== i.expectedQty);

  if (activeSessionId && session) {
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-lg font-bold text-white">
              Stocktake – {locations.find(l => l.id === session.locationId)?.name}
            </h3>
            <p className="text-sm text-muted-foreground">{items.length} items | {discrepancies.length} discrepancies</p>
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => setScannerOpen(true)} className="gap-1">
              <ScanLine className="w-4 h-4" /> Scan Item
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setActiveSessionId(null)}>← Back</Button>
            <Button size="sm" onClick={completeSession} disabled={completing} className="gap-1 bg-emerald-600 hover:bg-emerald-700">
              {completing ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
              Complete & Apply
            </Button>
          </div>
        </div>

        {scannerOpen && (
          <Card className="bg-white/5 border-white/10">
            <CardContent className="pt-4">
              <BarcodeScanner onScan={(code) => { handleScan(code); setScannerOpen(false); }} onClose={() => setScannerOpen(false)} />
            </CardContent>
          </Card>
        )}

        <div className="space-y-1">
          {items.map(item => {
            const diff = item.countedQty - item.expectedQty;
            const hasDisc = diff !== 0;
            return (
              <div key={item.id} className={`flex items-center gap-3 p-2.5 rounded-lg ${hasDisc ? 'bg-amber-500/10 border border-amber-500/20' : 'bg-white/5'}`}>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-white">{item.productName}</p>
                  <p className="text-xs text-muted-foreground">
                    {[item.color, item.size].filter(Boolean).join(' / ')}
                    {item.barcode && <span className="ml-2 font-mono">{item.barcode}</span>}
                  </p>
                </div>
                <div className="text-center w-20">
                  <p className="text-xs text-muted-foreground">Expected</p>
                  <p className="text-sm font-bold text-white">{item.expectedQty}</p>
                </div>
                <div className="w-24">
                  <label className="text-xs text-muted-foreground block text-center mb-0.5">Counted</label>
                  <Input
                    type="number" min="0"
                    defaultValue={item.countedQty}
                    onBlur={e => updateCountedQty(item.variantId, parseInt(e.target.value) || 0)}
                    className="h-7 text-sm text-center"
                  />
                </div>
                {hasDisc && (
                  <div className={`w-16 text-center text-sm font-bold ${diff > 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                    {diff > 0 ? `+${diff}` : diff}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-base font-semibold text-white">Stocktake Sessions</h3>
        <Button size="sm" onClick={() => setShowNewSession(true)} className="gap-1">
          <Plus className="w-4 h-4" /> New Stocktake
        </Button>
      </div>

      {showNewSession && (
        <Card className="bg-white/5 border-white/10">
          <CardContent className="pt-4 space-y-3">
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Location</label>
              <Select value={newLocationId} onValueChange={setNewLocationId}>
                <SelectTrigger><SelectValue placeholder="Select location" /></SelectTrigger>
                <SelectContent>
                  {locations.map(l => <SelectItem key={l.id} value={String(l.id)}>{l.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Notes</label>
              <Input value={newNotes} onChange={e => setNewNotes(e.target.value)} placeholder="Optional" />
            </div>
            <div className="flex gap-2">
              <Button size="sm" variant="ghost" onClick={() => setShowNewSession(false)}>Cancel</Button>
              <Button size="sm" onClick={createSession} disabled={!newLocationId}>Start Stocktake</Button>
            </div>
          </CardContent>
        </Card>
      )}

      {sessions.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          <Archive className="w-12 h-12 mx-auto mb-3 opacity-30" />
          <p>No stocktake sessions yet.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {sessions.map(s => (
            <div key={s.id} className="flex items-center justify-between p-3 rounded-lg bg-white/5 hover:bg-white/8 transition-colors">
              <div>
                <p className="text-sm font-medium text-white">
                  {locations.find(l => l.id === s.locationId)?.name ?? `Location ${s.locationId}`}
                </p>
                <p className="text-xs text-muted-foreground">{new Date(s.createdAt).toLocaleDateString('en-IN')}</p>
              </div>
              <div className="flex items-center gap-2">
                <Badge className={s.status === 'open' ? 'bg-emerald-500/20 text-emerald-300' : 'bg-white/10 text-white/60'}>
                  {s.status}
                </Badge>
                {s.status === 'open' && (
                  <Button size="sm" variant="outline" onClick={() => setActiveSessionId(s.id)}>Resume</Button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── MAIN PAGE ────────────────────────────────────────────────────────────────

export default function InventoryPage() {
  const { activeOrgId } = useActiveOrgContext();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  const [tab, setTab] = useState('overview');
  const [search, setSearch] = useState('');
  const [selectedLocationId, setSelectedLocationId] = useState<string>('all');
  const [editVariant, setEditVariant] = useState<Variant | null>(null);
  const [showTransfer, setShowTransfer] = useState(false);
  const [showLocationForm, setShowLocationForm] = useState(false);
  const [editLocation, setEditLocation] = useState<Location | null>(null);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [scanResult, setScanResult] = useState<{ productName: string; variantId: number; productId: number } | null>(null);

  const locationsQuery = useQuery<{ locations: Location[] }>({
    queryKey: [`/api/organizations/${activeOrgId}/inventory/locations`],
    queryFn: () => fetch(`${BASE}/api/organizations/${activeOrgId}/inventory/locations`, { credentials: 'include' }).then(r => r.json()),
    enabled: !!activeOrgId,
  });

  const overviewQuery = useQuery<{ locations: Location[]; products: Product[] }>({
    queryKey: [`/api/organizations/${activeOrgId}/inventory/overview`],
    queryFn: () => fetch(`${BASE}/api/organizations/${activeOrgId}/inventory/overview`, { credentials: 'include' }).then(r => r.json()),
    enabled: !!activeOrgId,
  });

  const lowStockQuery = useQuery<{ alerts: LowStockAlert[] }>({
    queryKey: [`/api/organizations/${activeOrgId}/inventory/low-stock`],
    queryFn: () => fetch(`${BASE}/api/organizations/${activeOrgId}/inventory/low-stock`, { credentials: 'include' }).then(r => r.json()),
    enabled: !!activeOrgId,
  });

  const movementQuery = useQuery<{ adjustments: unknown[] }>({
    queryKey: [`/api/organizations/${activeOrgId}/inventory/reports/movement`],
    queryFn: () => fetch(`${BASE}/api/organizations/${activeOrgId}/inventory/reports/movement`, { credentials: 'include' }).then(r => r.json()),
    enabled: !!activeOrgId && tab === 'reports',
  });

  const valuationQuery = useQuery<{ rows: unknown[]; totalValue: string; locations: Location[] }>({
    queryKey: [`/api/organizations/${activeOrgId}/inventory/reports/valuation`],
    queryFn: () => fetch(`${BASE}/api/organizations/${activeOrgId}/inventory/reports/valuation`, { credentials: 'include' }).then(r => r.json()),
    enabled: !!activeOrgId && tab === 'reports',
  });

  const consignmentQuery = useQuery<{ items: Array<{ id: number; vendorName: string; description: string; listingPrice: string; agreedPricePct: number; status: string; createdAt: string; soldAt?: string; payoutAt?: string }> }>({
    queryKey: [`/api/organizations/${activeOrgId}/consignment`, tab],
    queryFn: () => fetch(`${BASE}/api/organizations/${activeOrgId}/consignment`, { credentials: 'include' }).then(r => r.json()),
    enabled: !!activeOrgId && tab === 'consignment',
  });

  const dropshipQuery = useQuery<{ configured: boolean; products: Array<{ partner: 'printful' | 'printify'; productId: string | number; name: string; thumbnail?: string; variants: Array<{ id: string | number; name: string; available: boolean }>; error?: string }> }>({
    queryKey: [`/api/organizations/${activeOrgId}/inventory/dropship-status`, tab],
    queryFn: () => fetch(`${BASE}/api/organizations/${activeOrgId}/inventory/dropship-status`, { credentials: 'include' }).then(r => r.json()),
    enabled: !!activeOrgId && tab === 'consignment',
    staleTime: 60_000,
  });

  const waitlistQuery = useQuery<Array<{ id: number; productId: number; email: string; name: string | null }>>({
    queryKey: [`/api/organizations/${activeOrgId}/shop/waitlist`],
    queryFn: () => fetch(`${BASE}/api/organizations/${activeOrgId}/shop/waitlist`, { credentials: 'include' }).then(r => r.ok ? r.json() : []),
    enabled: !!activeOrgId && tab === 'overview',
  });
  const waitlistByProduct = (waitlistQuery.data ?? []).reduce<Record<number, number>>((acc, w) => {
    acc[w.productId] = (acc[w.productId] ?? 0) + 1;
    return acc;
  }, {});

  const locations = locationsQuery.data?.locations ?? overviewQuery.data?.locations ?? [];
  const products = overviewQuery.data?.products ?? [];
  const alerts = lowStockQuery.data?.alerts ?? [];

  const filteredProducts = products.filter(p => {
    if (search.trim() && !p.name.toLowerCase().includes(search.trim().toLowerCase())) return false;
    return true;
  });

  const handleBarcodeScan = async (barcode: string) => {
    if (!activeOrgId) return;
    const r = await fetch(`${BASE}/api/organizations/${activeOrgId}/inventory/barcode/${encodeURIComponent(barcode)}`, { credentials: 'include' });
    const d = await r.json();
    if (!r.ok) { toast({ title: 'Barcode not found', description: d.error, variant: 'destructive' }); return; }
    const v = d.variant;
    setScanResult({ productName: v.productName, variantId: v.variantId, productId: v.productId });
    setScannerOpen(false);
    toast({ title: 'Product found', description: `${v.productName} — ${[v.variantColor, v.variantSize].filter(Boolean).join(' / ') || 'Default'}` });
    setTab('overview');
    setSearch(v.productName);
  };

  const createLocation = async (data: { name: string; type: string; isDefault: boolean }) => {
    const r = await fetch(`${BASE}/api/organizations/${activeOrgId}/inventory/locations`, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error);
    toast({ title: 'Location created' });
    qc.invalidateQueries({ queryKey: [`/api/organizations/${activeOrgId}/inventory/locations`] });
    qc.invalidateQueries({ queryKey: [`/api/organizations/${activeOrgId}/inventory/overview`] });
  };

  const updateLocation = async (id: number, data: { name: string; type: string; isDefault: boolean }) => {
    const r = await fetch(`${BASE}/api/organizations/${activeOrgId}/inventory/locations/${id}`, {
      method: 'PUT', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error);
    toast({ title: 'Location updated' });
    qc.invalidateQueries({ queryKey: [`/api/organizations/${activeOrgId}/inventory/locations`] });
    qc.invalidateQueries({ queryKey: [`/api/organizations/${activeOrgId}/inventory/overview`] });
  };

  const movement = (movementQuery.data?.adjustments ?? []) as Array<{
    id: number; type: string; qtyDelta: number; reason: string | null;
    productName: string | null; color: string | null; size: string | null;
    sku: string | null; locationId: number | null; locationName: string | null; createdAt: string;
  }>;

  const valuation = (valuationQuery.data?.rows ?? []) as Array<{
    variantId: number; locationId: number; locationName: string;
    quantity: number; costPrice: string; lineValue: string;
    productName: string | null; color: string | null; size: string | null;
    sku: string | null;
  }>;

  const totalValue = valuationQuery.data?.totalValue ?? '0';

  const orgId = activeOrgId ?? 0;

  if (!activeOrgId) return (
    <div className="flex items-center justify-center h-64 text-muted-foreground">Select an organisation to manage inventory.</div>
  );

  return (
    <div className="max-w-7xl mx-auto px-4 py-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2">
            <Package className="w-7 h-7" style={{ color: GOLD }} />
            Inventory Management
          </h1>
          <p className="text-muted-foreground text-sm mt-0.5">Multi-location stock, barcodes, stocktake & reports</p>
        </div>
        <div className="flex gap-2 flex-wrap">
          {alerts.length > 0 && (
            <Badge className="bg-red-500/20 text-red-300 border-red-500/30 gap-1">
              <AlertTriangle className="w-3 h-3" />
              {alerts.length} Low Stock Alert{alerts.length !== 1 ? 's' : ''}
            </Badge>
          )}
          <Button size="sm" variant="outline" onClick={() => setScannerOpen(true)} className="gap-1">
            <ScanLine className="w-4 h-4" /> Scan Barcode
          </Button>
          <Button size="sm" onClick={() => setShowTransfer(true)} className="gap-1">
            <ArrowLeftRight className="w-4 h-4" /> Transfer Stock
          </Button>
        </div>
      </div>

      {/* Global barcode scanner */}
      {scannerOpen && (
        <Card className="bg-white/5 border-white/10">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Barcode Lookup</CardTitle>
          </CardHeader>
          <CardContent>
            <BarcodeScanner onScan={handleBarcodeScan} onClose={() => setScannerOpen(false)} />
          </CardContent>
        </Card>
      )}

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="flex-wrap h-auto gap-1">
          <TabsTrigger value="overview" className="gap-1"><Package className="w-4 h-4" />Overview</TabsTrigger>
          <TabsTrigger value="transfers" className="gap-1"><ArrowLeftRight className="w-4 h-4" />Transfers</TabsTrigger>
          <TabsTrigger value="stocktake" className="gap-1"><ClipboardList className="w-4 h-4" />Stocktake</TabsTrigger>
          <TabsTrigger value="reports" className="gap-1"><BarChart3 className="w-4 h-4" />Reports</TabsTrigger>
          <TabsTrigger value="locations" className="gap-1"><MapPin className="w-4 h-4" />Locations</TabsTrigger>
          <TabsTrigger value="consignment" className="gap-1"><Truck className="w-4 h-4" />Consignment</TabsTrigger>
        </TabsList>

        {/* ── OVERVIEW TAB ── */}
        <TabsContent value="overview" className="space-y-4">
          <div className="flex gap-2 flex-wrap">
            <div className="relative flex-1 min-w-48">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search products…" className="pl-9" />
            </div>
            <Select value={selectedLocationId} onValueChange={setSelectedLocationId}>
              <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Locations</SelectItem>
                {locations.map(l => <SelectItem key={l.id} value={String(l.id)}>{l.name}</SelectItem>)}
              </SelectContent>
            </Select>
            <Button size="sm" variant="ghost" onClick={() => { overviewQuery.refetch(); lowStockQuery.refetch(); }}>
              <RefreshCw className="w-4 h-4" />
            </Button>
          </div>

          {/* Low Stock Alerts Strip */}
          {alerts.length > 0 && (
            <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20">
              <div className="flex items-center justify-between mb-2">
                <p className="text-sm font-semibold text-red-400 flex items-center gap-1">
                  <AlertTriangle className="w-4 h-4" /> Low Stock Alerts
                </p>
                <Button size="sm" variant="outline" className="h-7 text-xs gap-1 border-red-500/30 text-red-400 hover:bg-red-500/10" onClick={() => navigate('/procurement')}>
                  <Truck className="w-3 h-3" /> Raise PO
                </Button>
              </div>
              <div className="space-y-1">
                {alerts.slice(0, 5).map(a => (
                  <div key={`${a.variantId}-${a.locationId}`} className="flex items-center justify-between text-sm">
                    <span className="text-white">{a.productName} {[a.color, a.size].filter(Boolean).join(' / ')}</span>
                    <span className="text-muted-foreground">{a.locationName}: <span className="text-red-400 font-bold">{a.quantity}</span> / reorder at {a.reorderPoint}</span>
                  </div>
                ))}
                {alerts.length > 5 && <p className="text-xs text-muted-foreground">+{alerts.length - 5} more…</p>}
              </div>
            </div>
          )}

          {overviewQuery.isLoading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="w-8 h-8 animate-spin text-primary" />
            </div>
          ) : filteredProducts.length === 0 ? (
            <div className="text-center py-16 text-muted-foreground">
              <Package className="w-12 h-12 mx-auto mb-3 opacity-30" />
              <p>No products found.</p>
            </div>
          ) : (
            <div className="space-y-3">
              {filteredProducts.map(product => {
                const locationsToShow = selectedLocationId === 'all' ? locations : locations.filter(l => l.id === parseInt(selectedLocationId));
                if (product.variants.length === 0) return null;
                return (
                  <Card key={product.id} className="bg-white/5 border-white/10">
                    <CardHeader className="pb-2 pt-3">
                      <div className="flex items-center justify-between">
                        <div>
                          <CardTitle className="text-sm font-bold text-white">{product.name}</CardTitle>
                          <p className="text-xs text-muted-foreground capitalize">{product.category}</p>
                        </div>
                        <div className="flex items-center gap-2">
                          {!product.isActive && <Badge className="bg-white/10 text-white/50 text-xs">Inactive</Badge>}
                          {(waitlistByProduct[product.id] ?? 0) > 0 && (
                            <Badge className="bg-amber-500/20 text-amber-400 border border-amber-500/30 text-xs gap-1">
                              <span className="inline-block w-1.5 h-1.5 bg-amber-400 rounded-full" />
                              {waitlistByProduct[product.id]} waiting
                            </Badge>
                          )}
                          <Button
                            size="sm" variant="ghost"
                            onClick={() => {
                              const r = new URL(`${window.location.origin}${BASE}/api/organizations/${orgId}/inventory/barcode-labels`);
                              const ids = product.variants.map(v => v.id).join(',');
                              r.searchParams.set('variantIds', ids);
                              window.open(r.toString(), '_blank');
                            }}
                            className="text-xs gap-1 text-muted-foreground hover:text-white"
                          >
                            <Download className="w-3 h-3" /> Labels
                          </Button>
                        </div>
                      </div>
                    </CardHeader>
                    <CardContent className="pt-0">
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="border-b border-white/10 text-xs text-muted-foreground">
                              <th className="text-left py-1.5 pr-4 font-medium">Variant</th>
                              <th className="text-left py-1.5 pr-4 font-medium">Barcode</th>
                              {locationsToShow.map(l => (
                                <th key={l.id} className="text-center py-1.5 px-2 font-medium">{l.name}</th>
                              ))}
                              <th className="text-center py-1.5 px-2 font-medium">Total</th>
                              <th className="py-1.5 px-2"></th>
                            </tr>
                          </thead>
                          <tbody>
                            {product.variants.map(v => {
                              const variantLabel = [v.color, v.size].filter(Boolean).join(' / ') || 'Default';
                              const highlightScan = scanResult?.variantId === v.id;
                              return (
                                <tr key={v.id} className={`border-b border-white/5 last:border-0 ${highlightScan ? 'bg-yellow-500/10' : ''}`}>
                                  <td className="py-2 pr-4">
                                    <span className="text-white">{variantLabel}</span>
                                    {v.sku && <span className="text-xs text-muted-foreground ml-2">({v.sku})</span>}
                                  </td>
                                  <td className="py-2 pr-4 font-mono text-xs text-muted-foreground">{v.barcode ?? '—'}</td>
                                  {locationsToShow.map(l => {
                                    const s = v.stock.find(st => st.locationId === l.id);
                                    const qty = s?.quantity ?? 0;
                                    const below = s?.belowReorder ?? false;
                                    return (
                                      <td key={l.id} className="py-2 px-2 text-center">
                                        <span className={`font-bold ${below ? 'text-red-400' : qty === 0 ? 'text-muted-foreground' : 'text-white'}`}>
                                          {qty}
                                        </span>
                                        {below && <AlertTriangle className="w-3 h-3 text-red-400 inline ml-1" />}
                                      </td>
                                    );
                                  })}
                                  <td className="py-2 px-2 text-center font-bold text-white">{v.totalStock}</td>
                                  <td className="py-2 px-2">
                                    <Button size="sm" variant="ghost" onClick={() => setEditVariant(v)} className="h-6 w-6 p-0">
                                      <Edit2 className="w-3 h-3" />
                                    </Button>
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </TabsContent>

        {/* ── TRANSFERS TAB ── */}
        <TabsContent value="transfers" className="space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-base font-semibold text-white">Stock Transfers</h3>
            <Button size="sm" onClick={() => setShowTransfer(true)} className="gap-1">
              <Plus className="w-4 h-4" /> New Transfer
            </Button>
          </div>
          <TransfersTable orgId={orgId} locations={locations} />
        </TabsContent>

        {/* ── STOCKTAKE TAB ── */}
        <TabsContent value="stocktake">
          <StocktakeView orgId={orgId} locations={locations} />
        </TabsContent>

        {/* ── REPORTS TAB ── */}
        <TabsContent value="reports" className="space-y-6">
          {/* Valuation summary */}
          <Card className="bg-white/5 border-white/10">
            <CardHeader>
              <CardTitle className="text-sm font-bold text-white flex items-center gap-2">
                <BarChart3 className="w-4 h-4" style={{ color: GOLD }} />
                Stock Valuation (at Cost)
              </CardTitle>
            </CardHeader>
            <CardContent>
              {valuationQuery.isLoading ? <Loader2 className="w-5 h-5 animate-spin" /> : (
                <>
                  <p className="text-2xl font-bold text-white mb-4">{fmt(parseFloat(totalValue))}</p>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-xs text-muted-foreground border-b border-white/10">
                          <th className="text-left py-1.5 pr-4">Product / Variant</th>
                          <th className="text-left py-1.5 pr-4">Location</th>
                          <th className="text-right py-1.5 pr-4">Qty</th>
                          <th className="text-right py-1.5 pr-4">Cost</th>
                          <th className="text-right py-1.5">Value</th>
                        </tr>
                      </thead>
                      <tbody>
                        {valuation.map((r, i) => (
                          <tr key={i} className="border-b border-white/5 last:border-0">
                            <td className="py-2 pr-4 text-white">
                              {r.productName}
                              {[r.color, r.size].filter(Boolean).length > 0 && (
                                <span className="text-muted-foreground ml-1">({[r.color, r.size].filter(Boolean).join('/')})</span>
                              )}
                            </td>
                            <td className="py-2 pr-4 text-muted-foreground">{r.locationName}</td>
                            <td className="py-2 pr-4 text-right text-white">{r.quantity}</td>
                            <td className="py-2 pr-4 text-right text-muted-foreground">{fmt(r.costPrice)}</td>
                            <td className="py-2 text-right font-bold text-white">{fmt(r.lineValue)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </CardContent>
          </Card>

          {/* Movement log */}
          <Card className="bg-white/5 border-white/10">
            <CardHeader>
              <CardTitle className="text-sm font-bold text-white flex items-center gap-2">
                <TrendingUp className="w-4 h-4" style={{ color: GOLD }} />
                Stock Movement Log (last 500)
              </CardTitle>
            </CardHeader>
            <CardContent>
              {movementQuery.isLoading ? <Loader2 className="w-5 h-5 animate-spin" /> : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-xs text-muted-foreground border-b border-white/10">
                        <th className="text-left py-1.5 pr-4">Date</th>
                        <th className="text-left py-1.5 pr-4">Product / Variant</th>
                        <th className="text-left py-1.5 pr-4">Location</th>
                        <th className="text-left py-1.5 pr-4">Type</th>
                        <th className="text-right py-1.5 pr-4">Δ Qty</th>
                        <th className="text-left py-1.5">Reason</th>
                      </tr>
                    </thead>
                    <tbody>
                      {movement.map(m => (
                        <tr key={m.id} className="border-b border-white/5 last:border-0">
                          <td className="py-1.5 pr-4 text-muted-foreground text-xs">{new Date(m.createdAt).toLocaleDateString('en-IN')}</td>
                          <td className="py-1.5 pr-4 text-white">
                            {m.productName}
                            {[m.color, m.size].filter(Boolean).length > 0 && (
                              <span className="text-muted-foreground ml-1">({[m.color, m.size].filter(Boolean).join('/')})</span>
                            )}
                          </td>
                          <td className="py-1.5 pr-4 text-muted-foreground text-xs">{m.locationName ?? '—'}</td>
                          <td className="py-1.5 pr-4">
                            <Badge className={`text-xs ${m.type.includes('in') || m.type === 'initial_stock' || m.type === 'goods_receipt' || m.type === 'return' ? 'bg-emerald-500/20 text-emerald-300' : m.type.includes('out') || m.type === 'sale' ? 'bg-red-500/20 text-red-300' : 'bg-white/10 text-white/60'}`}>
                              {m.type.replace(/_/g, ' ')}
                            </Badge>
                          </td>
                          <td className={`py-1.5 pr-4 text-right font-bold ${m.qtyDelta > 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                            {m.qtyDelta > 0 ? `+${m.qtyDelta}` : m.qtyDelta}
                          </td>
                          <td className="py-1.5 text-muted-foreground text-xs">{m.reason ?? '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {movement.length === 0 && <p className="text-center text-muted-foreground py-8">No stock movements recorded yet.</p>}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── LOCATIONS TAB ── */}
        <TabsContent value="locations" className="space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-base font-semibold text-white">Stock Locations</h3>
            <Button size="sm" onClick={() => { setEditLocation(null); setShowLocationForm(true); }} className="gap-1">
              <Plus className="w-4 h-4" /> Add Location
            </Button>
          </div>
          <div className="space-y-2">
            {locations.map(l => (
              <div key={l.id} className="flex items-center justify-between p-3 rounded-lg bg-white/5">
                <div className="flex items-center gap-3">
                  <MapPin className="w-4 h-4 text-muted-foreground" />
                  <div>
                    <p className="text-sm font-medium text-white">{l.name}</p>
                    <p className="text-xs text-muted-foreground capitalize">{l.type.replace(/_/g, ' ')}</p>
                  </div>
                  {l.isDefault && <Badge className="bg-primary/20 text-primary text-xs">Default</Badge>}
                  {!l.isActive && <Badge className="bg-white/10 text-white/50 text-xs">Inactive</Badge>}
                </div>
                <Button size="sm" variant="ghost" onClick={() => { setEditLocation(l); setShowLocationForm(true); }}>
                  <Edit2 className="w-4 h-4" />
                </Button>
              </div>
            ))}
            {locations.length === 0 && (
              <div className="text-center py-12 text-muted-foreground">
                <MapPin className="w-12 h-12 mx-auto mb-3 opacity-30" />
                <p>No locations configured. Add your first stock location.</p>
              </div>
            )}
          </div>
        </TabsContent>

        {/* ── CONSIGNMENT TAB ── */}
        <TabsContent value="consignment" className="space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-base font-semibold text-white">Consignment &amp; Dropship Items</h3>
            <Button size="sm" variant="ghost" onClick={() => { consignmentQuery.refetch(); dropshipQuery.refetch(); }}>
              <RefreshCw className="w-4 h-4" />
            </Button>
          </div>
          {consignmentQuery.isLoading ? (
            <div className="flex justify-center py-12"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
          ) : (
            <Card className="bg-white/5 border-white/10">
              <CardContent className="p-0">
                {(consignmentQuery.data?.items ?? []).length === 0 ? (
                  <div className="text-center py-12 text-muted-foreground">
                    <Truck className="w-12 h-12 mx-auto mb-3 opacity-30" />
                    <p>No consignment items recorded. Add items via the Consignment section.</p>
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-xs text-muted-foreground border-b border-white/10">
                          <th className="text-left py-2 px-4">Item</th>
                          <th className="text-left py-2 px-4">Vendor</th>
                          <th className="text-right py-2 px-4">Price</th>
                          <th className="text-right py-2 px-4">Commission</th>
                          <th className="text-center py-2 px-4">Status</th>
                          <th className="text-right py-2 px-4">Added</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(consignmentQuery.data?.items ?? []).map(item => {
                          const statusColors: Record<string, string> = {
                            unsold: 'bg-blue-500/20 text-blue-300 border-blue-500/30',
                            sold: 'bg-green-500/20 text-green-300 border-green-500/30',
                            payout_pending: 'bg-yellow-500/20 text-yellow-300 border-yellow-500/30',
                            paid: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30',
                            returned: 'bg-white/10 text-white/60 border-white/20',
                          };
                          return (
                            <tr key={item.id} className="border-b border-white/5 last:border-0 hover:bg-white/5">
                              <td className="py-2 px-4 text-white font-medium">{item.description || '—'}</td>
                              <td className="py-2 px-4 text-muted-foreground">{item.vendorName}</td>
                              <td className="py-2 px-4 text-right text-white">₹{parseFloat(item.listingPrice).toLocaleString('en-IN')}</td>
                              <td className="py-2 px-4 text-right text-muted-foreground">{item.agreedPricePct}%</td>
                              <td className="py-2 px-4 text-center">
                                <Badge className={`text-xs border ${statusColors[item.status] ?? 'bg-white/10 text-white/60'}`}>
                                  {item.status.replace(/_/g, ' ')}
                                </Badge>
                              </td>
                              <td className="py-2 px-4 text-right text-muted-foreground text-xs">
                                {new Date(item.createdAt).toLocaleDateString()}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {/* ── Dropship partner sync status (Printful / Printify) ── */}
          <Card className="bg-white/5 border-white/10">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-bold text-white flex items-center gap-2">
                <Download className="w-4 h-4" style={{ color: GOLD }} />
                Dropship Partner Sync Status
              </CardTitle>
            </CardHeader>
            <CardContent>
              {dropshipQuery.isLoading ? (
                <div className="flex items-center gap-2 text-muted-foreground text-sm">
                  <Loader2 className="w-4 h-4 animate-spin" /> Checking partner status…
                </div>
              ) : !dropshipQuery.data?.configured ? (
                <div className="text-center py-6 text-muted-foreground text-sm">
                  <Settings className="w-8 h-8 mx-auto mb-2 opacity-30" />
                  <p>No dropship partners configured.</p>
                  <p className="text-xs mt-1">Set <code className="bg-white/10 px-1 rounded">PRINTFUL_API_KEY</code> or <code className="bg-white/10 px-1 rounded">PRINTIFY_API_KEY</code> + <code className="bg-white/10 px-1 rounded">PRINTIFY_SHOP_ID</code> to enable sync.</p>
                </div>
              ) : (dropshipQuery.data?.products ?? []).length === 0 ? (
                <p className="text-sm text-muted-foreground">Partner configured but no products found.</p>
              ) : (
                <div className="space-y-3">
                  {(dropshipQuery.data?.products ?? []).map(p => {
                    const availCount = p.variants.filter(v => v.available).length;
                    const totalCount = p.variants.length;
                    return (
                      <div key={`${p.partner}-${p.productId}`} className="flex items-center gap-3 p-2 rounded-lg bg-white/5">
                        {p.thumbnail && <img src={p.thumbnail} alt={p.name} className="w-10 h-10 rounded object-cover flex-shrink-0" />}
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-white truncate">{p.name}</p>
                          <p className="text-xs text-muted-foreground">{p.partner === 'printful' ? 'Printful' : 'Printify'} · {availCount}/{totalCount} variants available</p>
                        </div>
                        <Badge className={`text-xs border flex-shrink-0 ${availCount === totalCount ? 'bg-green-500/20 text-green-300 border-green-500/30' : availCount === 0 ? 'bg-red-500/20 text-red-300 border-red-500/30' : 'bg-yellow-500/20 text-yellow-300 border-yellow-500/30'}`}>
                          {availCount === totalCount ? 'In Sync' : availCount === 0 ? 'Unavailable' : 'Partial'}
                        </Badge>
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* ── DIALOGS ── */}

      {editVariant && (
        <Dialog open onOpenChange={() => setEditVariant(null)}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>Edit Variant Stock</DialogTitle>
            </DialogHeader>
            <StockEditDialog variant={editVariant} locations={locations} orgId={orgId} onClose={() => setEditVariant(null)} />
          </DialogContent>
        </Dialog>
      )}

      {showTransfer && (
        <Dialog open onOpenChange={() => setShowTransfer(false)}>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>Transfer Stock Between Locations</DialogTitle>
            </DialogHeader>
            <TransferForm locations={locations} products={products} orgId={orgId} onClose={() => setShowTransfer(false)} />
          </DialogContent>
        </Dialog>
      )}

      {showLocationForm && (
        <Dialog open onOpenChange={() => setShowLocationForm(false)}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>{editLocation ? 'Edit Location' : 'Add Stock Location'}</DialogTitle>
            </DialogHeader>
            <LocationForm
              initial={editLocation ?? undefined}
              onSave={async (data) => {
                if (editLocation) await updateLocation(editLocation.id, data);
                else await createLocation(data);
              }}
              onClose={() => setShowLocationForm(false)}
            />
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

function TransfersTable({ orgId, locations }: { orgId: number; locations: Location[] }) {
  const transfersQuery = useQuery<{
    transfers: Array<{
      id: number; fromLocationId: number; toLocationId: number;
      variantId: number; quantity: number; notes: string | null; createdAt: string;
    }>;
  }>({
    queryKey: [`/api/organizations/${orgId}/inventory/transfers`],
    queryFn: () => fetch(`${BASE}/api/organizations/${orgId}/inventory/transfers`, { credentials: 'include' }).then(r => r.json()),
    enabled: !!orgId,
  });

  const transfers = transfersQuery.data?.transfers ?? [];

  if (transfersQuery.isLoading) return <Loader2 className="w-6 h-6 animate-spin" />;

  if (transfers.length === 0) return (
    <div className="text-center py-12 text-muted-foreground">
      <ArrowLeftRight className="w-12 h-12 mx-auto mb-3 opacity-30" />
      <p>No stock transfers recorded yet.</p>
    </div>
  );

  const locName = (id: number) => locations.find(l => l.id === id)?.name ?? `Loc ${id}`;

  return (
    <div className="space-y-2">
      {transfers.map(t => (
        <div key={t.id} className="flex items-center gap-3 p-3 rounded-lg bg-white/5">
          <ArrowLeftRight className="w-4 h-4 text-muted-foreground flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-sm text-white">{locName(t.fromLocationId)} → {locName(t.toLocationId)}</p>
            {t.notes && <p className="text-xs text-muted-foreground">{t.notes}</p>}
          </div>
          <div className="text-center">
            <p className="text-xs text-muted-foreground">Qty</p>
            <p className="text-sm font-bold text-white">{t.quantity}</p>
          </div>
          <p className="text-xs text-muted-foreground">{new Date(t.createdAt).toLocaleDateString('en-IN')}</p>
        </div>
      ))}
    </div>
  );
}
