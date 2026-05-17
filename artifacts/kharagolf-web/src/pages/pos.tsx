import { useState, useCallback, useEffect, useRef } from "react";
import { useActiveOrgContext } from "@/context/ActiveOrgContext";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import {
  Search, ShoppingCart, Trash2, Plus, Minus, CreditCard, Banknote, UserSquare2,
  Receipt, CheckCircle, X, Send, ChevronLeft, BarChart3, Loader2, Tag, Gift, ScanLine, RotateCcw,
  WifiOff, RefreshCw,
} from "lucide-react";

// ─── OFFLINE INDEXEDDB QUEUE ──────────────────────────────────────────────────
const IDB_DB_NAME = "pos_offline_queue";
const IDB_STORE   = "transactions";
const IDB_VERSION = 1;

function openIDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_DB_NAME, IDB_VERSION);
    req.onupgradeneeded = (e) => {
      (e.target as IDBOpenDBRequest).result.createObjectStore(IDB_STORE, { keyPath: "localId" });
    };
    req.onsuccess = (e) => resolve((e.target as IDBOpenDBRequest).result);
    req.onerror  = () => reject(req.error);
  });
}

async function idbPush(tx: object): Promise<void> {
  const db = await openIDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(IDB_STORE, "readwrite");
    t.objectStore(IDB_STORE).put(tx);
    t.oncomplete = () => resolve();
    t.onerror    = () => reject(t.error);
  });
}

async function idbGetAll(): Promise<object[]> {
  const db = await openIDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(IDB_STORE, "readonly");
    const req = t.objectStore(IDB_STORE).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

async function idbClear(): Promise<void> {
  const db = await openIDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(IDB_STORE, "readwrite");
    t.objectStore(IDB_STORE).clear();
    t.oncomplete = () => resolve();
    t.onerror    = () => reject(t.error);
  });
}

async function idbDeleteByLocalIds(localIds: string[]): Promise<void> {
  if (localIds.length === 0) return;
  const db = await openIDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(IDB_STORE, "readwrite");
    const store = t.objectStore(IDB_STORE);
    for (const id of localIds) store.delete(id);
    t.oncomplete = () => resolve();
    t.onerror    = () => reject(t.error);
  });
}

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

type Product = {
  id: number;
  name: string;
  category: string;
  markupPrice: string;
  imageUrl: string | null;
  stockCount: number | null;
  variants: { id: number; color: string | null; size: string | null; stockQty: number }[];
  isBundle?: boolean;
  bundleId?: number;
};

type CartItem = {
  productId: number;
  variantId?: number;
  bundleId?: number;
  productName: string;
  category: string;
  unitPrice: number;
  quantity: number;
  discountPct: number;
  variantLabel?: string;
};

type Member = {
  id: number;
  memberNumber: string | null;
  firstName: string;
  lastName: string;
  email: string | null;
};

type PaymentMethod = "cash" | "razorpay_pos" | "member_account" | "gift_card" | "split_gift_card_cash";

type GiftCardLookup = {
  valid: boolean;
  reason?: string;
  card: {
    id: number;
    code: string;
    currentBalancePaise: number;
    status: string;
  };
};

const CATEGORIES = ["all", "apparel", "equipment", "accessories", "food_beverage", "lessons", "misc", "bundles"];
const CAT_LABELS: Record<string, string> = {
  all: "All Items",
  apparel: "Apparel",
  equipment: "Equipment",
  accessories: "Accessories",
  food_beverage: "F&B",
  lessons: "Lessons",
  misc: "Misc",
  bundles: "Bundles",
};

function fmt(n: number) {
  return `₹${n.toFixed(2)}`;
}

export default function POSTerminalPage() {
  const { activeOrgId } = useActiveOrgContext();
  const { toast } = useToast();
  const qc = useQueryClient();

  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("all");
  const [cart, setCart] = useState<CartItem[]>([]);
  const [memberSearch, setMemberSearch] = useState("");
  const [selectedMember, setSelectedMember] = useState<Member | null>(null);
  const [memberDiscountPct, setMemberDiscountPct] = useState(0);
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>("cash");
  const [customerEmail, setCustomerEmail] = useState("");
  const [notes, setNotes] = useState("");

  const [showVariantPicker, setShowVariantPicker] = useState<Product | null>(null);
  const [showPaymentModal, setShowPaymentModal] = useState(false);
  const [showReceiptModal, setShowReceiptModal] = useState(false);
  const [receipt, setReceipt] = useState<{ receiptNumber: string; totalAmount: string; items: CartItem[]; giftCardCode?: string; giftCardAmountApplied?: string; paymentMethod?: string; isOffline?: boolean } | null>(null);
  const [showReportPanel, setShowReportPanel] = useState(false);
  const [reportDate, setReportDate] = useState(new Date().toISOString().slice(0, 10));
  const [giftCardCode, setGiftCardCode] = useState("");
  const [giftCardLookup, setGiftCardLookup] = useState<GiftCardLookup | null>(null);
  const [giftCardLookupLoading, setGiftCardLookupLoading] = useState(false);
  const [showBarcodeScanner, setShowBarcodeScanner] = useState(false);
  const [showReturnDialog, setShowReturnDialog] = useState(false);
  const [fulfillmentLocationId, setFulfillmentLocationId] = useState<string>('');

  // Offline mode state
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [offlineQueueCount, setOfflineQueueCount] = useState(0);
  const [isSyncing, setIsSyncing] = useState(false);

  const locationsQuery = useQuery<{ locations: { id: number; name: string; isDefault: boolean }[] }>({
    queryKey: ["pos-locations", activeOrgId],
    queryFn: async () => {
      if (!activeOrgId) return { locations: [] };
      const r = await fetch(`${BASE}/api/organizations/${activeOrgId}/inventory/locations`, { credentials: "include" });
      if (!r.ok) return { locations: [] };
      return r.json();
    },
    enabled: !!activeOrgId,
  });

  const locations = locationsQuery.data?.locations ?? [];

  useEffect(() => {
    if (fulfillmentLocationId === '' && locations.length > 0) {
      const def = locations.find(l => l.isDefault) ?? locations[0];
      setFulfillmentLocationId(String(def.id));
    }
  }, [locations, fulfillmentLocationId]);

  // Offline queue count on mount
  useEffect(() => {
    idbGetAll().then(all => setOfflineQueueCount(all.length)).catch(() => {});
  }, []);

  // Online/offline event listeners + auto-sync on reconnect
  useEffect(() => {
    const handleOnline = () => {
      setIsOnline(true);
      if (activeOrgId) syncOfflineQueue(activeOrgId);
    };
    const handleOffline = () => setIsOnline(false);
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, [activeOrgId]);

  const syncOfflineQueue = async (orgId: number) => {
    const queued = await idbGetAll();
    if (!queued.length) return;
    setIsSyncing(true);
    try {
      const r = await fetch(`${BASE}/api/organizations/${orgId}/pos/offline-sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ transactions: queued }),
      });
      if (r.ok) {
        const result = await r.json() as { synced: number; duplicates?: number; errors?: number; total: number; results: { localId: string; status: "ok" | "duplicate" | "error" }[] };
        // Only remove transactions that were successfully synced or already-duplicates.
        // Leave failed ones in IndexedDB so they can be retried on next sync.
        const clearIds = result.results
          .filter(r => r.status === "ok" || r.status === "duplicate")
          .map(r => r.localId);
        if (clearIds.length > 0) await idbDeleteByLocalIds(clearIds);
        const remaining = await idbGetAll();
        setOfflineQueueCount(remaining.length);
        const errorCount = result.errors ?? result.results.filter(r => r.status === "error").length;
        toast({
          title: "Offline sales synced",
          description: errorCount > 0
            ? `${result.synced + (result.duplicates ?? 0)} uploaded, ${errorCount} failed (will retry).`
            : `${result.synced} of ${result.total} transactions uploaded.`,
          variant: errorCount > 0 ? "destructive" : "default",
        });
        qc.invalidateQueries({ queryKey: ["pos-products", orgId] });
      }
    } catch {
      toast({ title: "Sync failed", description: "Could not upload queued sales. Will retry when online.", variant: "destructive" });
    } finally {
      setIsSyncing(false);
    }
  };

  const productsQuery = useQuery({
    queryKey: ["pos-products", activeOrgId, category, search],
    queryFn: async () => {
      if (!activeOrgId) return [];
      const params = new URLSearchParams();
      if (category !== "all") params.set("category", category);
      if (search.trim()) params.set("q", search.trim());
      const r = await fetch(`${BASE}/api/organizations/${activeOrgId}/pos/products?${params}`);
      if (!r.ok) throw new Error("Failed to load products");
      return r.json() as Promise<Product[]>;
    },
    enabled: !!activeOrgId,
  });

  const membersQuery = useQuery({
    queryKey: ["pos-member-search", activeOrgId, memberSearch],
    queryFn: async () => {
      if (!activeOrgId || memberSearch.length < 2) return [];
      const r = await fetch(`${BASE}/api/organizations/${activeOrgId}/pos/members/search?q=${encodeURIComponent(memberSearch)}`);
      if (!r.ok) return [];
      return r.json() as Promise<Member[]>;
    },
    enabled: !!activeOrgId && memberSearch.length >= 2,
  });

  const reportQuery = useQuery({
    queryKey: ["pos-report", activeOrgId, reportDate],
    queryFn: async () => {
      if (!activeOrgId) return null;
      const r = await fetch(`${BASE}/api/organizations/${activeOrgId}/pos/reports/daily?date=${reportDate}`);
      if (!r.ok) throw new Error("Failed to load report");
      return r.json();
    },
    enabled: !!activeOrgId && showReportPanel,
  });

  const lookupGiftCard = async () => {
    if (!giftCardCode.trim() || !activeOrgId) return;
    setGiftCardLookupLoading(true);
    try {
      const r = await fetch(`${BASE}/api/organizations/${activeOrgId}/gift-cards/lookup?code=${encodeURIComponent(giftCardCode.trim())}`, { credentials: "include" });
      const data = await r.json();
      if (r.ok) {
        setGiftCardLookup(data);
      } else {
        toast({ title: "Not found", description: data.error, variant: "destructive" });
        setGiftCardLookup(null);
      }
    } catch {
      toast({ title: "Error", description: "Lookup failed", variant: "destructive" });
    } finally {
      setGiftCardLookupLoading(false);
    }
  };

  const checkoutMutation = useMutation({
    mutationFn: async () => {
      if (!activeOrgId) throw new Error("No org");

      let posTransactionId: number | null = null;

      if (paymentMethod === "gift_card" || paymentMethod === "split_gift_card_cash") {
        if (!giftCardLookup?.valid) throw new Error("Please validate a gift card first.");
        const available = giftCardLookup.card.currentBalancePaise / 100;
        if (paymentMethod === "gift_card" && available < cartSubtotal) {
          throw new Error(`Insufficient gift card balance. Available: ₹${available.toFixed(2)}, Required: ₹${cartSubtotal.toFixed(2)}. Use "Split: Gift Card + Cash" instead.`);
        }
      }

      // ── OFFLINE MODE: queue in IndexedDB and show receipt stub ──────────────
      // NOTE: Gift cards cannot be reliably validated offline (balance may change).
      // We preserve the gift_card payment method in the queue for accounting accuracy
      // but also store the code for deferred validation when the queue is synced.
      if (!navigator.onLine) {
        if (paymentMethod === "gift_card" || paymentMethod === "split_gift_card_cash") {
          throw new Error("Gift card payment cannot be processed offline. Please use cash or member account.");
        }
        const localId = `offline-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const offlineTx = {
          localId,
          clientTransactionId: localId,
          items: cart.map(ci => ({
            // For bundles: productId is negative placeholder; persist bundleId so sync can decrement components
            productId: ci.bundleId ? undefined : ci.productId,
            variantId: ci.variantId,
            bundleId: ci.bundleId ?? undefined,
            productName: ci.productName, category: ci.category,
            quantity: ci.quantity, unitPrice: ci.unitPrice, discountPct: ci.discountPct,
          })),
          paymentMethod,
          totalAmount: cartSubtotal,
          subtotal: cartSubtotal,
          clubMemberId: selectedMember?.id ?? null,
          memberName: selectedMember ? `${selectedMember.firstName} ${selectedMember.lastName}` : null,
          customerName: selectedMember ? `${selectedMember.firstName} ${selectedMember.lastName}` : null,
          customerEmail: customerEmail || selectedMember?.email || null,
          notes: notes || null,
          queuedAt: new Date().toISOString(),
        };
        await idbPush(offlineTx);
        const allQueued = await idbGetAll();
        setOfflineQueueCount(allQueued.length);
        return { offlineQueued: true, localId, receiptNumber: localId, totalAmount: String(cartSubtotal) };
      }

      // ── ONLINE CHECKOUT ─────────────────────────────────────────────────────
      // Gift cards are sent directly to the POS transaction endpoint.
      // The server validates, charges, and records redemption atomically.
      const body = {
        items: cart.map(ci => ({
          // For bundles, productId is negative (placeholder) and bundleId is the real id.
          // We omit productId for bundles so the server doesn't try to update a non-existent product.
          ...(ci.bundleId ? {} : { productId: ci.productId }),
          variantId: ci.variantId,
          bundleId: ci.bundleId ?? undefined,
          productName: ci.productName,
          category: ci.category,
          quantity: ci.quantity,
          unitPrice: ci.unitPrice,
          discountPct: ci.discountPct,
        })),
        paymentMethod,
        clubMemberId: selectedMember?.id ?? null,
        memberName: selectedMember ? `${selectedMember.firstName} ${selectedMember.lastName}` : null,
        customerName: selectedMember ? `${selectedMember.firstName} ${selectedMember.lastName}` : null,
        customerEmail: customerEmail || selectedMember?.email || null,
        notes: notes || null,
        locationId: fulfillmentLocationId ? parseInt(fulfillmentLocationId) : undefined,
        // Gift card fields — server handles lookup, validation, and redemption atomically
        ...(paymentMethod === "gift_card" || paymentMethod === "split_gift_card_cash" ? { giftCardCode: giftCardCode.trim() } : {}),
        // For split payment: send the gift card portion amount; server charges that and marks rest as cash
        ...(paymentMethod === "split_gift_card_cash" && giftCardLookup?.valid ? {
          giftCardAmountApplied: (giftCardLookup.card.currentBalancePaise / 100).toFixed(2),
        } : {}),
      };
      const r = await fetch(`${BASE}/api/organizations/${activeOrgId}/pos/transactions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const e = await r.json();
        throw new Error(e.error ?? "Checkout failed");
      }
      const txn = await r.json();
      posTransactionId = txn.id;

      return txn;
    },
    onSuccess: (data) => {
      setReceipt({
        receiptNumber: data.receiptNumber,
        totalAmount: data.totalAmount,
        items: cart,
        giftCardCode: (paymentMethod === "gift_card" || paymentMethod === "split_gift_card_cash") ? giftCardCode.trim() : undefined,
        giftCardAmountApplied: paymentMethod === "split_gift_card_cash" && giftCardLookup?.valid
          ? (giftCardLookup.card.currentBalancePaise / 100).toFixed(2)
          : undefined,
        paymentMethod,
        isOffline: data.offlineQueued === true,
      });
      setCart([]);
      setSelectedMember(null);
      setMemberDiscountPct(0);
      setCustomerEmail("");
      setNotes("");
      setPaymentMethod("cash");
      setGiftCardCode("");
      setGiftCardLookup(null);
      setShowPaymentModal(false);
      setShowReceiptModal(true);
      if (!data.offlineQueued) qc.invalidateQueries({ queryKey: ["pos-products", activeOrgId] });
    },
    onError: (e: Error) => {
      toast({ title: "Checkout failed", description: e.message, variant: "destructive" });
    },
  });

  const addToCart = useCallback((product: Product, variantId?: number, variantLabel?: string) => {
    const unitPrice = parseFloat(product.markupPrice);
    setCart(prev => {
      const existing = prev.find(ci =>
        ci.productId === product.id && ci.variantId === (variantId ?? undefined) && ci.bundleId === (product.bundleId ?? undefined)
      );
      if (existing) {
        return prev.map(ci =>
          ci.productId === product.id && ci.variantId === (variantId ?? undefined) && ci.bundleId === (product.bundleId ?? undefined)
            ? { ...ci, quantity: ci.quantity + 1 }
            : ci
        );
      }
      return [...prev, {
        productId: product.id,    // negative for bundles (from API)
        variantId,
        bundleId: product.bundleId,  // set for bundles
        productName: product.name,
        category: product.category,
        unitPrice,
        quantity: 1,
        discountPct: memberDiscountPct,
        variantLabel,
      }];
    });
  }, [memberDiscountPct]);

  const removeFromCart = (idx: number) => setCart(prev => prev.filter((_, i) => i !== idx));

  const updateQty = (idx: number, delta: number) => {
    setCart(prev => {
      const next = [...prev];
      next[idx] = { ...next[idx], quantity: Math.max(1, next[idx].quantity + delta) };
      return next;
    });
  };

  const cartSubtotal = cart.reduce((s, ci) => {
    return s + ci.unitPrice * ci.quantity * (1 - ci.discountPct / 100);
  }, 0);

  const handleProductClick = (product: Product) => {
    if (product.variants.length > 0) {
      setShowVariantPicker(product);
    } else {
      addToCart(product);
    }
  };

  const handleBarcodeScanForCart = useCallback(async (barcode: string) => {
    if (!activeOrgId) return;
    try {
      const r = await fetch(`${BASE}/api/organizations/${activeOrgId}/inventory/barcode/${encodeURIComponent(barcode)}`, { credentials: "include" });
      const d = await r.json();
      if (!r.ok) {
        toast({ title: "Barcode not found", description: d.error, variant: "destructive" });
        return;
      }
      const v = d.variant;
      const cartProduct: Product = {
        id: v.productId,
        name: v.productName,
        category: v.productCategory,
        markupPrice: String(v.productMarkupPrice),
        imageUrl: v.productImageUrl ?? null,
        stockCount: null,
        variants: [],
      };
      const variantLabel = [v.variantColor, v.variantSize].filter(Boolean).join(" / ") || undefined;
      addToCart(cartProduct, v.variantId, variantLabel);
      setShowBarcodeScanner(false);
      toast({ title: "Item added", description: `${v.productName}${variantLabel ? ` — ${variantLabel}` : ""}` });
    } catch {
      toast({ title: "Scan failed", description: "Could not look up barcode", variant: "destructive" });
    }
  }, [activeOrgId, addToCart, toast]);

  const handleMemberSelect = (member: Member) => {
    setSelectedMember(member);
    setMemberSearch("");
    setMemberDiscountPct(10);
    setCart(prev => prev.map(ci => ({ ...ci, discountPct: 10 })));
  };

  const products = productsQuery.data ?? [];

  if (showReportPanel) {
    return (
      <div className="h-screen flex flex-col bg-background p-6 overflow-auto">
        <div className="flex items-center gap-4 mb-6">
          <Button variant="ghost" onClick={() => setShowReportPanel(false)}>
            <ChevronLeft className="w-4 h-4 mr-1" /> Back to POS
          </Button>
          <h1 className="text-2xl font-bold">Daily Sales Report</h1>
        </div>
        <div className="flex items-center gap-4 mb-6">
          <Input
            type="date"
            value={reportDate}
            onChange={e => setReportDate(e.target.value)}
            className="w-44"
          />
        </div>
        {reportQuery.isLoading && <div className="flex items-center gap-2"><Loader2 className="animate-spin w-5 h-5" /> Loading...</div>}
        {reportQuery.data && (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <Card>
              <CardHeader><CardTitle>Total Revenue</CardTitle></CardHeader>
              <CardContent>
                <div className="text-4xl font-bold">{fmt(reportQuery.data.totalRevenue)}</div>
                <div className="text-sm text-muted-foreground mt-1">{reportQuery.data.totalTransactions} transactions</div>
                {reportQuery.data.voidedCount > 0 && (
                  <div className="text-sm text-destructive mt-1">{Number(reportQuery.data.voidedCount)} voided</div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader><CardTitle>By Payment Method</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                {Object.entries(reportQuery.data.byPaymentMethod as Record<string, { count: number; total: number }>).map(([method, data]) => (
                  <div key={method} className="flex justify-between items-center">
                    <div>
                      <div className="font-medium capitalize">{method.replace(/_/g, " ")}</div>
                      <div className="text-xs text-muted-foreground">{data.count} transactions</div>
                    </div>
                    <div className="font-bold">{fmt(data.total)}</div>
                  </div>
                ))}
                {Object.keys(reportQuery.data.byPaymentMethod).length === 0 && (
                  <p className="text-muted-foreground text-sm">No transactions today</p>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader><CardTitle>By Category</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                {Object.entries(reportQuery.data.byCategory as Record<string, { quantity: number; total: number }>).map(([cat, data]) => (
                  <div key={cat} className="flex justify-between items-center">
                    <div>
                      <div className="font-medium capitalize">{cat.replace(/_/g, " ")}</div>
                      <div className="text-xs text-muted-foreground">{data.quantity} units sold</div>
                    </div>
                    <div className="font-bold">{fmt(data.total)}</div>
                  </div>
                ))}
                {Object.keys(reportQuery.data.byCategory).length === 0 && (
                  <p className="text-muted-foreground text-sm">No items sold today</p>
                )}
              </CardContent>
            </Card>

            <Card className="md:col-span-3">
              <CardHeader><CardTitle>Transactions</CardTitle></CardHeader>
              <CardContent>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b">
                        <th className="text-left py-2">Receipt #</th>
                        <th className="text-left py-2">Time</th>
                        <th className="text-left py-2">Customer</th>
                        <th className="text-left py-2">Payment</th>
                        <th className="text-right py-2">Total</th>
                        <th className="text-left py-2">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(reportQuery.data.transactions as {
                        id: number; receiptNumber: string; transactedAt: string;
                        customerName: string | null; memberName: string | null;
                        paymentMethod: string; totalAmount: string; status: string;
                      }[]).map(txn => (
                        <tr key={txn.id} className="border-b hover:bg-muted/30">
                          <td className="py-2 font-mono text-xs">{txn.receiptNumber}</td>
                          <td className="py-2">{new Date(txn.transactedAt).toLocaleTimeString()}</td>
                          <td className="py-2">{txn.customerName ?? txn.memberName ?? "Walk-in"}</td>
                          <td className="py-2 capitalize">{txn.paymentMethod.replace(/_/g, " ")}</td>
                          <td className="py-2 text-right font-medium">{fmt(parseFloat(txn.totalAmount))}</td>
                          <td className="py-2">
                            <Badge variant={txn.status === "completed" ? "default" : "destructive"} className="text-xs">
                              {txn.status}
                            </Badge>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {(reportQuery.data.transactions as unknown[]).length === 0 && (
                    <p className="text-muted-foreground text-sm py-4 text-center">No transactions for this date</p>
                  )}
                </div>
              </CardContent>
            </Card>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="h-screen flex overflow-hidden bg-background">
      {/* LEFT — Product grid */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Offline Banner */}
        {!isOnline && (
          <div className="bg-amber-500 text-amber-950 px-4 py-2 flex items-center gap-2 text-sm font-medium">
            <WifiOff className="w-4 h-4 flex-shrink-0" />
            <span>Offline — sales are being queued locally.</span>
            {offlineQueueCount > 0 && (
              <span className="ml-1 bg-amber-700 text-white rounded-full px-2 py-0.5 text-xs">
                {offlineQueueCount} queued
              </span>
            )}
            <div className="flex-1" />
            <span className="text-xs opacity-70">Will sync automatically when reconnected.</span>
          </div>
        )}
        {isOnline && offlineQueueCount > 0 && (
          <div className="bg-emerald-500 text-white px-4 py-2 flex items-center gap-2 text-sm font-medium">
            <RefreshCw className={`w-4 h-4 flex-shrink-0 ${isSyncing ? "animate-spin" : ""}`} />
            <span>{isSyncing ? "Syncing…" : `${offlineQueueCount} offline sale(s) ready to sync.`}</span>
            {!isSyncing && activeOrgId && (
              <Button size="sm" variant="secondary" className="ml-auto h-6 text-xs" onClick={() => syncOfflineQueue(activeOrgId!)}>
                Sync Now
              </Button>
            )}
          </div>
        )}
        {/* Header */}
        <div className="border-b px-4 py-3 flex items-center gap-3 bg-card">
          <ShoppingCart className="w-5 h-5 text-primary" />
          <h1 className="text-lg font-bold">Pro Shop POS</h1>
          <div className="flex-1" />
          <Button variant="outline" size="sm" onClick={() => setShowReportPanel(true)}>
            <BarChart3 className="w-4 h-4 mr-1.5" /> Daily Report
          </Button>
        </div>

        {/* Category filters */}
        <div className="px-4 py-2 border-b flex gap-2 overflow-x-auto flex-shrink-0">
          {CATEGORIES.map(cat => (
            <Button
              key={cat}
              size="sm"
              variant={category === cat ? "default" : "outline"}
              onClick={() => setCategory(cat)}
              className="flex-shrink-0"
            >
              {CAT_LABELS[cat]}
            </Button>
          ))}
        </div>

        {/* Search + Location */}
        <div className="px-4 py-2 flex gap-2 flex-shrink-0">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              placeholder="Search products..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="pl-9"
            />
          </div>
          {locations.length > 1 && (
            <Select value={fulfillmentLocationId} onValueChange={setFulfillmentLocationId}>
              <SelectTrigger className="w-44 h-10 text-sm">
                <SelectValue placeholder="Location" />
              </SelectTrigger>
              <SelectContent>
                {locations.map(l => (
                  <SelectItem key={l.id} value={String(l.id)}>
                    {l.name}{l.isDefault ? ' (default)' : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowBarcodeScanner(true)}
            title="Scan barcode to add item"
          >
            <ScanLine className="w-4 h-4" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowReturnDialog(true)}
            title="Process stock return"
          >
            <RotateCcw className="w-4 h-4" />
          </Button>
        </div>

        {/* Product grid */}
        <ScrollArea className="flex-1 px-4 py-2">
          {productsQuery.isLoading && (
            <div className="flex items-center justify-center h-40">
              <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
            </div>
          )}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3 pb-4">
            {products.map(product => (
              <button
                key={product.id}
                onClick={() => handleProductClick(product)}
                className="bg-card border rounded-xl p-3 text-left hover:border-primary hover:shadow-md transition-all active:scale-95"
              >
                {product.imageUrl ? (
                  <img src={product.imageUrl} alt={product.name} className="w-full h-28 object-cover rounded-lg mb-2" />
                ) : (
                  <div className="w-full h-28 bg-muted rounded-lg mb-2 flex items-center justify-center">
                    <Tag className="w-8 h-8 text-muted-foreground" />
                  </div>
                )}
                <div className="flex items-start justify-between gap-1 mb-0.5">
                  <div className="font-medium text-sm truncate">{product.name}</div>
                  {product.isBundle && (
                    <span className="shrink-0 text-[10px] bg-violet-500/20 text-violet-300 border border-violet-500/30 rounded px-1 py-0.5 font-medium">Bundle</span>
                  )}
                </div>
                <div className="text-xs text-muted-foreground capitalize mb-1">
                  {product.isBundle ? "Product Bundle" : product.category}
                </div>
                <div className="font-bold text-primary">{fmt(parseFloat(product.markupPrice))}</div>
                {!product.isBundle && product.variants.length === 0 && product.stockCount !== null && (
                  <div className={`text-xs mt-1 ${product.stockCount <= 5 ? "text-destructive" : "text-muted-foreground"}`}>
                    {product.stockCount} in stock
                  </div>
                )}
                {!product.isBundle && product.variants.length > 0 && (
                  <div className="text-xs text-muted-foreground mt-1">{product.variants.length} variants</div>
                )}
              </button>
            ))}
            {!productsQuery.isLoading && products.length === 0 && (
              <div className="col-span-full text-center py-12 text-muted-foreground">
                No products found
              </div>
            )}
          </div>
        </ScrollArea>
      </div>

      {/* RIGHT — Cart panel */}
      <div className="w-80 xl:w-96 border-l flex flex-col bg-card">
        {/* Member section */}
        <div className="p-4 border-b">
          <div className="flex items-center gap-2 mb-2">
            <UserSquare2 className="w-4 h-4 text-muted-foreground" />
            <span className="text-sm font-medium">Member</span>
          </div>
          {selectedMember ? (
            <div className="flex items-center justify-between bg-primary/10 border border-primary/20 rounded-lg px-3 py-2">
              <div>
                <div className="font-medium text-sm">{selectedMember.firstName} {selectedMember.lastName}</div>
                {selectedMember.memberNumber && (
                  <div className="text-xs text-muted-foreground">#{selectedMember.memberNumber}</div>
                )}
                {memberDiscountPct > 0 && (
                  <Badge variant="secondary" className="text-xs mt-0.5">{memberDiscountPct}% discount</Badge>
                )}
              </div>
              <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => {
                setSelectedMember(null);
                setMemberDiscountPct(0);
                setCart(prev => prev.map(ci => ({ ...ci, discountPct: 0 })));
              }}>
                <X className="w-3.5 h-3.5" />
              </Button>
            </div>
          ) : (
            <div className="relative">
              <Input
                placeholder="Search member by name / number..."
                value={memberSearch}
                onChange={e => setMemberSearch(e.target.value)}
                className="text-sm"
              />
              {membersQuery.data && membersQuery.data.length > 0 && (
                <div className="absolute left-0 right-0 top-full mt-1 z-50 bg-popover border rounded-lg shadow-lg overflow-hidden">
                  {membersQuery.data.map(m => (
                    <button
                      key={m.id}
                      onClick={() => handleMemberSelect(m)}
                      className="w-full text-left px-3 py-2 text-sm hover:bg-muted"
                    >
                      <span className="font-medium">{m.firstName} {m.lastName}</span>
                      {m.memberNumber && <span className="text-muted-foreground ml-2">#{m.memberNumber}</span>}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Cart items */}
        <ScrollArea className="flex-1 px-4">
          {cart.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-40 text-muted-foreground">
              <ShoppingCart className="w-10 h-10 mb-2 opacity-30" />
              <p className="text-sm">Cart is empty</p>
            </div>
          ) : (
            <div className="py-3 space-y-3">
              {cart.map((ci, idx) => (
                <div key={idx} className="flex items-start gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-sm truncate">{ci.productName}</div>
                    {ci.variantLabel && (
                      <div className="text-xs text-muted-foreground">{ci.variantLabel}</div>
                    )}
                    <div className="text-xs text-muted-foreground">
                      {fmt(ci.unitPrice)}
                      {ci.discountPct > 0 && <span className="ml-1 text-primary">-{ci.discountPct}%</span>}
                    </div>
                    <div className="flex items-center gap-1 mt-1">
                      <Button variant="outline" size="icon" className="h-6 w-6" onClick={() => updateQty(idx, -1)}>
                        <Minus className="w-3 h-3" />
                      </Button>
                      <span className="w-6 text-center text-sm">{ci.quantity}</span>
                      <Button variant="outline" size="icon" className="h-6 w-6" onClick={() => updateQty(idx, 1)}>
                        <Plus className="w-3 h-3" />
                      </Button>
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="font-bold text-sm">
                      {fmt(ci.unitPrice * ci.quantity * (1 - ci.discountPct / 100))}
                    </div>
                    <Button variant="ghost" size="icon" className="h-6 w-6 mt-1 text-destructive" onClick={() => removeFromCart(idx)}>
                      <Trash2 className="w-3 h-3" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </ScrollArea>

        {/* Totals and checkout */}
        <div className="border-t p-4 space-y-3">
          <div className="flex justify-between text-sm text-muted-foreground">
            <span>Subtotal ({cart.reduce((s, c) => s + c.quantity, 0)} items)</span>
            <span>{fmt(cartSubtotal)}</span>
          </div>
          <Separator />
          <div className="flex justify-between font-bold text-lg">
            <span>Total</span>
            <span>{fmt(cartSubtotal)}</span>
          </div>
          <Button
            className="w-full"
            size="lg"
            disabled={cart.length === 0}
            onClick={() => setShowPaymentModal(true)}
          >
            <CreditCard className="w-4 h-4 mr-2" />
            Charge {fmt(cartSubtotal)}
          </Button>
          {cart.length > 0 && (
            <Button variant="ghost" className="w-full text-destructive" onClick={() => setCart([])}>
              Clear Cart
            </Button>
          )}
        </div>
      </div>

      {/* Variant picker dialog */}
      <Dialog open={!!showVariantPicker} onOpenChange={open => !open && setShowVariantPicker(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{showVariantPicker?.name}</DialogTitle>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-2 py-2">
            {showVariantPicker?.variants.map(v => (
              <Button
                key={v.id}
                variant="outline"
                disabled={v.stockQty === 0}
                onClick={() => {
                  if (showVariantPicker) {
                    addToCart(showVariantPicker, v.id, [v.size, v.color].filter(Boolean).join(" / "));
                    setShowVariantPicker(null);
                  }
                }}
                className="h-16 flex-col"
              >
                <span className="font-medium">{[v.size, v.color].filter(Boolean).join(" / ") || "Default"}</span>
                <span className="text-xs text-muted-foreground">
                  {v.stockQty === 0 ? "Out of stock" : `${v.stockQty} left`}
                </span>
              </Button>
            ))}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => {
              if (showVariantPicker) {
                addToCart(showVariantPicker);
                setShowVariantPicker(null);
              }
            }}>Add without variant</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Payment modal */}
      <Dialog open={showPaymentModal} onOpenChange={setShowPaymentModal}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Select Payment Method</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="grid grid-cols-2 gap-3">
              {([
                { method: "cash", label: "Cash", icon: Banknote },
                { method: "razorpay_pos", label: "Card / POS", icon: CreditCard },
                { method: "member_account", label: "Account Charge", icon: UserSquare2 },
                { method: "gift_card", label: "Gift Card", icon: Gift },
              ] as { method: PaymentMethod; label: string; icon: React.ComponentType<{ className?: string }> }[]).map(({ method, label, icon: Icon }) => (
                <button
                  key={method}
                  onClick={() => { setPaymentMethod(method); if (method !== "gift_card" && method !== "split_gift_card_cash") { setGiftCardCode(""); setGiftCardLookup(null); } }}
                  className={`border-2 rounded-xl p-4 flex flex-col items-center gap-2 transition-all ${
                    (paymentMethod === method || (method === "gift_card" && paymentMethod === "split_gift_card_cash")) ? "border-primary bg-primary/5" : "border-border hover:border-primary/40"
                  }`}
                >
                  <Icon className="w-6 h-6" />
                  <span className="text-sm font-medium text-center">{label}</span>
                </button>
              ))}
            </div>

            {(paymentMethod === "gift_card" || paymentMethod === "split_gift_card_cash") && (
              <div className="space-y-2">
                <label className="text-sm font-medium block">Gift Card Code</label>
                <div className="flex gap-2">
                  <Input
                    className="font-mono uppercase"
                    placeholder="GC-XXXX-XXXX-XXXX"
                    value={giftCardCode}
                    onChange={(e) => { setGiftCardCode(e.target.value.toUpperCase()); setGiftCardLookup(null); setPaymentMethod("gift_card"); }}
                    onKeyDown={(e) => { if (e.key === "Enter") lookupGiftCard(); }}
                  />
                  <Button variant="outline" onClick={lookupGiftCard} disabled={giftCardLookupLoading}>
                    {giftCardLookupLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : "Check"}
                  </Button>
                </div>
                {giftCardLookup && (
                  <>
                    <div className={`rounded-lg px-3 py-2 text-sm ${giftCardLookup.valid ? "bg-green-500/10 text-green-400 border border-green-500/20" : "bg-red-500/10 text-red-400 border border-red-500/20"}`}>
                      {giftCardLookup.valid
                        ? `✓ Valid — Balance: ₹${(giftCardLookup.card.currentBalancePaise / 100).toFixed(2)}`
                        : `✗ ${giftCardLookup.reason === "expired" ? "Card expired" : giftCardLookup.reason === "cancelled" ? "Card cancelled" : "No balance"}`}
                    </div>
                    {giftCardLookup.valid && (giftCardLookup.card.currentBalancePaise / 100) < cartSubtotal && (
                      <div className="bg-amber-500/10 border border-amber-500/20 rounded-lg p-3 space-y-2">
                        <p className="text-xs text-amber-400">Gift card balance is less than the cart total. Choose split payment to charge the remainder in cash.</p>
                        <div className="grid grid-cols-2 gap-2 text-xs">
                          <div className="rounded p-2 bg-muted">
                            <div className="text-muted-foreground">Gift card covers</div>
                            <div className="font-bold text-green-400">₹{(giftCardLookup.card.currentBalancePaise / 100).toFixed(2)}</div>
                          </div>
                          <div className="rounded p-2 bg-muted">
                            <div className="text-muted-foreground">Cash remainder</div>
                            <div className="font-bold text-orange-400">₹{(cartSubtotal - giftCardLookup.card.currentBalancePaise / 100).toFixed(2)}</div>
                          </div>
                        </div>
                        <button
                          onClick={() => setPaymentMethod("split_gift_card_cash")}
                          className={`w-full text-sm rounded-lg border-2 py-2 transition-all ${paymentMethod === "split_gift_card_cash" ? "border-amber-500 bg-amber-500/10 text-amber-300" : "border-border hover:border-amber-500/50"}`}
                        >
                          {paymentMethod === "split_gift_card_cash" ? "✓ Split: Gift Card + Cash selected" : "Use Split Payment (Gift Card + Cash)"}
                        </button>
                      </div>
                    )}
                  </>
                )}
              </div>
            )}

            {paymentMethod === "member_account" && !selectedMember && (
              <div className="text-sm text-destructive bg-destructive/10 rounded-lg p-3">
                Please select a member before charging to account.
              </div>
            )}

            <div>
              <label className="text-sm font-medium block mb-1">Customer Email (for receipt)</label>
              <Input
                type="email"
                placeholder="customer@email.com"
                value={customerEmail}
                onChange={e => setCustomerEmail(e.target.value)}
              />
            </div>

            <div>
              <label className="text-sm font-medium block mb-1">Notes (optional)</label>
              <Input
                placeholder="e.g. Member card 1234"
                value={notes}
                onChange={e => setNotes(e.target.value)}
              />
            </div>

            <div className="bg-muted rounded-lg p-4">
              <div className="flex justify-between text-sm mb-1">
                <span className="text-muted-foreground">Subtotal</span>
                <span>{fmt(cartSubtotal)}</span>
              </div>
              {paymentMethod === "split_gift_card_cash" && giftCardLookup?.valid && (
                <>
                  <div className="flex justify-between text-sm text-green-400 mb-0.5">
                    <span>Gift Card (GC)</span>
                    <span>-{fmt(giftCardLookup.card.currentBalancePaise / 100)}</span>
                  </div>
                  <div className="flex justify-between text-sm text-orange-400 mb-1">
                    <span>Cash Remainder</span>
                    <span>{fmt(Math.max(0, cartSubtotal - giftCardLookup.card.currentBalancePaise / 100))}</span>
                  </div>
                </>
              )}
              <div className="flex justify-between font-bold text-lg border-t border-border pt-1 mt-1">
                <span>Total Due</span>
                <span>{fmt(cartSubtotal)}</span>
              </div>
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setShowPaymentModal(false)}>Cancel</Button>
            <Button
              onClick={() => checkoutMutation.mutate()}
              disabled={
                checkoutMutation.isPending ||
                (paymentMethod === "member_account" && !selectedMember)
              }
            >
              {checkoutMutation.isPending ? (
                <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Processing...</>
              ) : (
                <><CheckCircle className="w-4 h-4 mr-2" /> Confirm {fmt(cartSubtotal)}</>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Receipt modal */}
      <Dialog open={showReceiptModal} onOpenChange={setShowReceiptModal}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {receipt?.isOffline
                ? <WifiOff className="w-5 h-5 text-amber-500" />
                : <CheckCircle className="w-5 h-5 text-green-500" />}
              {receipt?.isOffline ? "Sale Queued (Offline)" : "Payment Complete"}
            </DialogTitle>
          </DialogHeader>
          {receipt && (
            <div className="space-y-4">
              {receipt.isOffline && (
                <div className="bg-amber-50 border border-amber-200 text-amber-800 rounded-md p-3 text-xs flex items-center gap-2">
                  <WifiOff className="w-3.5 h-3.5 flex-shrink-0" />
                  This sale was saved locally and will sync automatically when online.
                </div>
              )}
              <div className="bg-muted rounded-lg p-4 font-mono text-sm">
                <div className="text-center font-bold text-base mb-3">PRO SHOP RECEIPT</div>
                <div className="text-center text-xs text-muted-foreground mb-3">
                  {receipt.isOffline ? "OFFLINE QUEUE" : `#${receipt.receiptNumber}`}
                </div>
                <Separator className="mb-3" />
                {receipt.items.map((ci, idx) => (
                  <div key={idx} className="flex justify-between text-xs mb-1">
                    <span>{ci.quantity}x {ci.productName}</span>
                    <span>{fmt(ci.unitPrice * ci.quantity * (1 - ci.discountPct / 100))}</span>
                  </div>
                ))}
                <Separator className="my-3" />
                {receipt.giftCardCode && (
                  <div className="space-y-1 mb-2">
                    <div className="flex items-center gap-1 text-xs text-emerald-700">
                      <Gift className="w-3 h-3" />
                      <span>Gift card: {receipt.giftCardCode}</span>
                    </div>
                    {receipt.giftCardAmountApplied ? (
                      <>
                        <div className="flex justify-between text-xs text-emerald-700">
                          <span>Gift card applied</span>
                          <span>-{fmt(parseFloat(receipt.giftCardAmountApplied))}</span>
                        </div>
                        <div className="flex justify-between text-xs">
                          <span>Cash remainder</span>
                          <span>{fmt(parseFloat(receipt.totalAmount) - parseFloat(receipt.giftCardAmountApplied))}</span>
                        </div>
                      </>
                    ) : (
                      <div className="text-xs text-emerald-700">Full amount paid by gift card</div>
                    )}
                  </div>
                )}
                <div className="flex justify-between font-bold">
                  <span>TOTAL</span>
                  <span>{fmt(parseFloat(receipt.totalAmount))}</span>
                </div>
              </div>
              {customerEmail && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Send className="w-4 h-4" />
                  Receipt emailed to {customerEmail}
                </div>
              )}
            </div>
          )}
          <DialogFooter>
            <Button onClick={() => {
              setShowReceiptModal(false);
              setReceipt(null);
            }} className="w-full">
              <Receipt className="w-4 h-4 mr-2" />
              New Transaction
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Barcode Scanner Dialog */}
      {showBarcodeScanner && (
        <Dialog open onOpenChange={() => setShowBarcodeScanner(false)}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <ScanLine className="w-5 h-5 text-primary" />
                Scan Barcode to Add Item
              </DialogTitle>
            </DialogHeader>
            <POSBarcodeScanner
              onScan={handleBarcodeScanForCart}
              onClose={() => setShowBarcodeScanner(false)}
            />
          </DialogContent>
        </Dialog>
      )}

      {/* Process Return Dialog */}
      {showReturnDialog && activeOrgId && (
        <Dialog open onOpenChange={() => setShowReturnDialog(false)}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <RotateCcw className="w-5 h-5 text-primary" />
                Process Stock Return
              </DialogTitle>
            </DialogHeader>
            <POSReturnFlow orgId={activeOrgId} onClose={() => setShowReturnDialog(false)} />
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

function POSReturnFlow({ orgId, onClose }: { orgId: number; onClose: () => void }) {
  const { toast } = useToast();
  const [step, setStep] = useState<"scan" | "confirm">("scan");
  const [barcode, setBarcode] = useState("");
  const [qty, setQty] = useState(1);
  const [reason, setReason] = useState("Customer return");
  const [loading, setLoading] = useState(false);
  const [found, setFound] = useState<{ variantId: number; productName: string; color: string | null; size: string | null } | null>(null);
  const [locationId, setLocationId] = useState<number | null>(null);
  const [locations, setLocations] = useState<{ id: number; name: string }[]>([]);

  useEffect(() => {
    fetch(`${BASE}/api/organizations/${orgId}/inventory/locations`, { credentials: "include" }).then(r => r.json()).then(d => {
      const locs: { id: number; name: string; isDefault?: boolean }[] = d.locations ?? [];
      setLocations(locs);
      const def = locs.find(l => l.isDefault) ?? locs[0];
      if (def) setLocationId(def.id);
    }).catch(() => null);
  }, [orgId]);

  const handleLookup = async () => {
    if (!barcode.trim() || !locationId) return;
    setLoading(true);
    try {
      const r = await fetch(`${BASE}/api/organizations/${orgId}/inventory/barcode/${encodeURIComponent(barcode.trim())}`, { credentials: "include" });
      if (!r.ok) { toast({ title: "Not found", description: "No product matched this barcode/SKU.", variant: "destructive" }); return; }
      const d = await r.json();
      setFound({ variantId: d.variant.variantId, productName: d.variant.productName, color: d.variant.variantColor, size: d.variant.variantSize });
      setStep("confirm");
    } catch { toast({ title: "Error", description: "Barcode lookup failed.", variant: "destructive" }); }
    finally { setLoading(false); }
  };

  const handleConfirm = async () => {
    if (!found || !locationId) return;
    setLoading(true);
    try {
      const r = await fetch(`${BASE}/api/organizations/${orgId}/inventory/returns`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ variantId: found.variantId, locationId, quantity: qty, reason }),
      });
      if (!r.ok) { const e = await r.json().catch(() => ({})); toast({ title: "Return failed", description: e.error ?? "Unknown error", variant: "destructive" }); return; }
      const d = await r.json();
      toast({ title: "Return processed", description: `+${qty} unit(s) of ${found.productName} returned to stock. New qty: ${d.newQuantity}` });
      onClose();
    } catch { toast({ title: "Error", description: "Failed to process return.", variant: "destructive" }); }
    finally { setLoading(false); }
  };

  if (step === "confirm" && found) {
    return (
      <div className="space-y-4">
        <div className="bg-muted/40 rounded-lg p-4 space-y-1">
          <p className="font-medium">{found.productName}</p>
          <p className="text-sm text-muted-foreground">{[found.color, found.size].filter(Boolean).join(" / ")}</p>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-sm font-medium mb-1 block">Qty to Return</label>
            <Input type="number" min={1} value={qty} onChange={e => setQty(Math.max(1, parseInt(e.target.value) || 1))} />
          </div>
          <div>
            <label className="text-sm font-medium mb-1 block">Return to Location</label>
            <select className="w-full h-10 rounded-md border border-input bg-background px-3 text-sm" value={locationId ?? ""} onChange={e => setLocationId(parseInt(e.target.value))}>
              {locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </div>
        </div>
        <div>
          <label className="text-sm font-medium mb-1 block">Reason</label>
          <Input value={reason} onChange={e => setReason(e.target.value)} placeholder="Reason for return" />
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" className="flex-1" onClick={() => setStep("scan")}>Back</Button>
          <Button className="flex-1" disabled={loading} onClick={handleConfirm}>
            {loading ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <RotateCcw className="w-4 h-4 mr-2" />}
            Confirm Return
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">Scan or type the barcode/SKU of the item being returned.</p>
      <div className="flex gap-2">
        <Input
          value={barcode}
          onChange={e => setBarcode(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") handleLookup(); }}
          placeholder="Barcode or SKU"
          autoFocus
        />
        <Button disabled={!barcode.trim() || loading} onClick={handleLookup}>
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : "Lookup"}
        </Button>
      </div>
      <Button variant="ghost" size="sm" className="w-full" onClick={onClose}>Cancel</Button>
    </div>
  );
}

function POSBarcodeScanner({ onScan, onClose }: { onScan: (code: string) => void; onClose: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [manualCode, setManualCode] = useState("");
  const [cameraError, setCameraError] = useState("");
  const [statusText, setStatusText] = useState("Initialising…");
  const streamRef = useRef<MediaStream | null>(null);
  const animRef = useRef<number | null>(null);
  const doneRef = useRef(false);

  useEffect(() => {
    let active = true;
    const hasBD = typeof window.BarcodeDetector !== "undefined";

    navigator.mediaDevices?.getUserMedia({ video: { facingMode: "environment" } })
      .then(stream => {
        if (!active) { stream.getTracks().forEach(t => t.stop()); return; }
        streamRef.current = stream;
        if (videoRef.current) { videoRef.current.srcObject = stream; videoRef.current.play().catch(() => null); }

        if (!hasBD) { setStatusText("Camera ready — point at barcode or type below."); return; }

        const det = new window.BarcodeDetector!({ formats: ["ean_13", "ean_8", "code_128", "upc_a", "upc_e"] });
        setStatusText("Scanning — point camera at barcode…");
        const scan = async () => {
          if (!active || doneRef.current) return;
          try {
            const results = await det.detect(videoRef.current!);
            if (results.length > 0) { doneRef.current = true; onScan(results[0].rawValue as string); return; }
          } catch { /* continue */ }
          if (active) animRef.current = requestAnimationFrame(scan);
        };
        videoRef.current?.addEventListener("playing", () => { if (active) animRef.current = requestAnimationFrame(scan); }, { once: true });
      })
      .catch(() => { setCameraError("Camera unavailable — type or use USB scanner."); setStatusText("Manual mode"); });

    return () => {
      active = false;
      if (animRef.current) cancelAnimationFrame(animRef.current);
      streamRef.current?.getTracks().forEach(t => t.stop());
    };
  }, [onScan]);

  return (
    <div className="space-y-4">
      {cameraError
        ? <p className="text-sm text-amber-400 bg-amber-500/10 p-3 rounded-lg">{cameraError}</p>
        : (
          <div className="relative rounded-lg overflow-hidden bg-black aspect-video">
            <video ref={videoRef} autoPlay playsInline muted className="w-full h-full object-cover" />
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div className="w-56 h-28 border-2 border-yellow-400 rounded opacity-80" style={{ boxShadow: "0 0 0 1000px rgba(0,0,0,0.4)" }} />
            </div>
            <div className="absolute inset-x-0 bottom-2 flex justify-center">
              <span className="text-xs text-white/80 bg-black/50 px-2 py-0.5 rounded-full">{statusText}</span>
            </div>
          </div>
        )}
      <div className="flex gap-2">
        <Input
          value={manualCode}
          onChange={e => setManualCode(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter" && manualCode.trim()) { onScan(manualCode.trim()); setManualCode(""); } }}
          placeholder="Type or scan barcode / SKU"
          autoFocus={!!cameraError}
        />
        <Button disabled={!manualCode.trim()} onClick={() => { if (manualCode.trim()) { onScan(manualCode.trim()); setManualCode(""); } }}>Add</Button>
      </div>
      <Button variant="ghost" size="sm" className="w-full" onClick={onClose}>Cancel</Button>
    </div>
  );
}
