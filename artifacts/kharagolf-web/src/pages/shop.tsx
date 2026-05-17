import { useState, useMemo, useEffect, useCallback } from 'react';
import { useParams } from 'wouter';
import { useGetMe } from '@workspace/api-client-react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import {
  ShoppingBag, Plus, Package, Truck, CheckCircle2, X,
  CreditCard, ExternalLink, RefreshCw, Edit2, Search,
  ShoppingCart, Minus, Trash2, History, ChevronRight, Heart, Star,
  MessageSquare, ThumbsUp, Bell, Settings, Download, Tag,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';
import { PriceWithFx } from '@/components/PriceWithFx';
import { StripeCheckoutDialog } from '@/components/StripeCheckoutDialog';

const SHOP_CURRENCY_SYMBOLS: Record<string, string> = {
  INR: '₹', USD: '$', GBP: '£', AED: 'د.إ', EUR: '€', SGD: 'S$', AUD: 'A$',
};

const GST_RATES = ['0', '5', '12', '18', '28'];

interface ShopProduct {
  id: number;
  name: string;
  description: string | null;
  imageUrl: string | null;
  category: string;
  basePrice: string;
  markupPrice: string;
  currency: string;
  sizes: string[];
  isActive: boolean;
  hsnCode: string | null;
  gstRate: string | null;
  salePrice: string | null;
  saleStart: string | null;
  saleEnd: string | null;
}

interface ProductVariant {
  id: number;
  productId: number;
  color: string | null;
  size: string | null;
  stockQty: number;
  sku: string | null;
}

interface CartItem {
  product: ShopProduct;
  variantId: number | null;
  size: string;
  color: string;
  qty: number;
}

interface ShopOrder {
  id: number;
  productId: number | null;
  customerName?: string;
  customerEmail?: string;
  size: string | null;
  color: string | null;
  quantity: number;
  unitPrice?: string;
  totalAmount: string;
  currency: string;
  status: string;
  paymentMode?: string | null;
  razorpayPaymentId?: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  awbCode?: string | null;
  shiprocketOrderId?: string | null;
  invoicePath?: string | null;
  createdAt: string;
  productName: string | null;
  productImage: string | null;
}

interface WishlistItem {
  wishlistId: number;
  createdAt: string;
  product: ShopProduct;
}

interface ProductReview {
  id: number;
  rating: number;
  comment: string | null;
  createdAt: string;
  reviewerName: string | null;
}

interface ReviewSummary {
  avgRating: number | null;
  totalCount: number;
  page: number;
  limit: number;
  reviews: ProductReview[];
}

interface ReviewPrompt {
  id: number;
  orderId: number;
  productId: number;
  productName: string;
  productImage: string | null;
  createdAt: string;
}

interface StoreSettings {
  gstin: string | null;
  sellerName: string | null;
  sellerAddress: string | null;
  sellerState: string | null;
  sellerStateCode: string | null;
  shiprocketEmail: string | null;
  reviewModerationEnabled: boolean;
}

const ORDER_STATUS_COLORS: Record<string, string> = {
  pending: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30',
  cod_pending: 'bg-orange-500/20 text-orange-400 border-orange-500/30',
  paid: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
  processing: 'bg-purple-500/20 text-purple-400 border-purple-500/30',
  shipped: 'bg-cyan-500/20 text-cyan-400 border-cyan-500/30',
  delivered: 'bg-green-500/20 text-green-400 border-green-500/30',
  cancelled: 'bg-gray-500/20 text-gray-400 border-gray-500/30',
  refunded: 'bg-red-500/20 text-red-400 border-red-500/30',
};

const ORDER_STATUS_ICONS: Record<string, React.FC<{ className?: string }>> = {
  pending: ({ className }) => <ShoppingCart className={className} />,
  cod_pending: ({ className }) => <Package className={className} />,
  paid: ({ className }) => <CreditCard className={className} />,
  processing: ({ className }) => <Package className={className} />,
  shipped: ({ className }) => <Truck className={className} />,
  delivered: ({ className }) => <CheckCircle2 className={className} />,
  cancelled: ({ className }) => <X className={className} />,
  refunded: ({ className }) => <RefreshCw className={className} />,
};

const CURRENCY_SYM: Record<string, string> = { INR: '₹', USD: '$', GBP: '£', EUR: '€', AED: 'د.إ', SGD: 'S$', AUD: 'A$' };
const fmtPrice = (price: string | number, currency: string) =>
  `${CURRENCY_SYM[currency] ?? currency}${parseFloat(String(price)).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

const CATEGORIES = ['all', 'apparel', 'headwear', 'accessories', 'drinkware', 'bags', 'other'];
const CATEGORY_LABELS: Record<string, string> = {
  all: 'All', apparel: 'Apparel', headwear: 'Headwear', accessories: 'Accessories',
  drinkware: 'Drinkware', bags: 'Bags', other: 'Other',
};

function StarRating({ rating, max = 5, size = 'sm', interactive = false, onRate }: {
  rating: number; max?: number; size?: 'sm' | 'md'; interactive?: boolean; onRate?: (r: number) => void;
}) {
  const [hovered, setHovered] = useState(0);
  const sz = size === 'sm' ? 'w-3.5 h-3.5' : 'w-5 h-5';
  return (
    <div className="flex items-center gap-0.5">
      {Array.from({ length: max }, (_, i) => i + 1).map(i => (
        <Star
          key={i}
          className={`${sz} transition-colors ${interactive ? 'cursor-pointer' : ''} ${
            i <= (hovered || rating) ? 'fill-yellow-400 text-yellow-400' : 'text-gray-600'
          }`}
          onClick={() => interactive && onRate?.(i)}
          onMouseEnter={() => interactive && setHovered(i)}
          onMouseLeave={() => interactive && setHovered(0)}
        />
      ))}
    </div>
  );
}

export default function ShopPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: user } = useGetMe();
  const params = useParams<{ orgId?: string }>();
  const orgId: number | undefined = params.orgId ? parseInt(params.orgId) : (user?.organizationId ?? undefined);
  const isGuest = !user;
  const isAdmin = !isGuest && (user?.role === 'org_admin' || user?.role === 'super_admin' || user?.role === 'tournament_director');

  // ── State ────────────────────────────────────────────────────────────────
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('all');

  const cartKey = orgId ? `kg_shop_cart_${orgId}` : null;
  const [cartItems, setCartItems] = useState<CartItem[]>([]);
  const [cartHydrated, setCartHydrated] = useState(false);

  useEffect(() => {
    if (!cartKey || cartHydrated) return;
    try {
      const saved = localStorage.getItem(cartKey);
      if (saved) {
        const parsed = JSON.parse(saved) as CartItem[];
        if (Array.isArray(parsed) && parsed.length > 0) setCartItems(parsed);
      }
    } catch { /* corrupt */ }
    setCartHydrated(true);
  }, [cartKey, cartHydrated]);

  useEffect(() => {
    if (!cartKey || !cartHydrated) return;
    try { localStorage.setItem(cartKey, JSON.stringify(cartItems)); } catch { /* full */ }
  }, [cartItems, cartKey, cartHydrated]);

  const [cartOpen, setCartOpen] = useState(false);
  const [detailProduct, setDetailProduct] = useState<ShopProduct | null>(null);
  const [detailVariantId, setDetailVariantId] = useState<number | null>(null);
  const [detailSize, setDetailSize] = useState('');
  const [detailColor, setDetailColor] = useState('');

  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [paymentMode, setPaymentMode] = useState<'razorpay' | 'cod'>('razorpay');
  const [checkoutForm, setCheckoutForm] = useState({
    customerName: '', customerEmail: '', customerPhone: '',
    addressLine1: '', addressCity: '', addressState: '', addressPincode: '', addressCountry: 'IN',
    buyerGstin: '',
  });
  const [checkingOut, setCheckingOut] = useState(false);
  const [stripeCheckout, setStripeCheckout] = useState<{
    publishableKey: string; clientSecret: string; description: string; amountLabel: string;
    resolve: () => void; reject: (e: Error) => void;
  } | null>(null);
  const [promoCode, setPromoCode] = useState('');
  const [affiliateCodeInput, setAffiliateCodeInput] = useState('');
  const [loyaltyPointsToRedeem, setLoyaltyPointsToRedeem] = useState(0);
  const [discountResult, setDiscountResult] = useState<{
    discounts: Array<{ type: string; label: string; amount: number; commission?: number }>;
    discountTotal: number;
    finalTotal: number;
    stackingPolicy: string;
  } | null>(null);

  const [addProductOpen, setAddProductOpen] = useState(false);
  const [productForm, setProductForm] = useState<{
    name: string; description: string; imageUrl: string; category: string;
    basePrice: string; markupPrice: string; currency: string;
    hsnCode: string; gstRate: string;
  }>({ name: '', description: '', imageUrl: '', category: 'apparel', basePrice: '', markupPrice: '', currency: 'INR', hsnCode: '', gstRate: '18' });
  const [saving, setSaving] = useState(false);

  // Variant management
  const [variantMgmtProductId, setVariantMgmtProductId] = useState<number | null>(null);
  const [newVariant, setNewVariant] = useState({ color: '', size: '', stockQty: 0, sku: '' });
  const [savingVariant, setSavingVariant] = useState(false);

  const [trackingOrder, setTrackingOrder] = useState<ShopOrder | null>(null);
  const [trackingForm, setTrackingForm] = useState({ trackingNumber: '', trackingUrl: '', status: '' });
  const [updatingTracking, setUpdatingTracking] = useState(false);
  const [creatingShipment, setCreatingShipment] = useState<number | null>(null);
  const [orderStatusFilter, setOrderStatusFilter] = useState<string>('all');

  // Store settings
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [storeForm, setStoreForm] = useState<{
    gstin: string; sellerName: string; sellerAddress: string; sellerState: string; sellerStateCode: string;
    shiprocketEmail: string; shiprocketPassword: string;
  }>({ gstin: '', sellerName: '', sellerAddress: '', sellerState: '', sellerStateCode: '', shiprocketEmail: '', shiprocketPassword: '' });
  const [savingStoreSettings, setSavingStoreSettings] = useState(false);

  // Review state
  const [reviewProduct, setReviewProduct] = useState<ShopProduct | null>(null);
  const [reviewRating, setReviewRating] = useState(0);
  const [reviewComment, setReviewComment] = useState('');
  const [submittingReview, setSubmittingReview] = useState(false);
  const [reviewPromptDismissed, setReviewPromptDismissed] = useState<Set<number>>(new Set());

  // Return request state
  const [returnOrder, setReturnOrder] = useState<ShopOrder | null>(null);
  const [returnForm, setReturnForm] = useState({ reason: '', reasonDetail: '', returnType: 'refund' });
  const [submittingReturn, setSubmittingReturn] = useState(false);

  // ── Queries ──────────────────────────────────────────────────────────────
  const { data: products = [], isLoading: productsLoading } = useQuery<ShopProduct[]>({
    queryKey: [`/api/organizations/${orgId}/shop/products`, isAdmin],
    queryFn: () => fetch(`/api/organizations/${orgId}/shop/products${isAdmin ? '?admin=true' : ''}`).then(r => { if (!r.ok) throw new Error('Request failed'); return r.json(); }),
    enabled: !!orgId,
  });

  const { data: orders = [], isLoading: ordersLoading, refetch: refetchOrders } = useQuery<ShopOrder[]>({
    queryKey: [`/api/organizations/${orgId}/shop/orders`],
    queryFn: () => fetch(`/api/organizations/${orgId}/shop/orders`, { credentials: 'include' }).then(r => { if (!r.ok) throw new Error('Request failed'); return r.json(); }),
    enabled: !!orgId && isAdmin,
  });

  const { data: myOrders = [], isLoading: myOrdersLoading } = useQuery<ShopOrder[]>({
    queryKey: [`/api/organizations/${orgId}/shop/my-orders`],
    queryFn: () => fetch(`/api/organizations/${orgId}/shop/my-orders`, { credentials: 'include' }).then(r => { if (!r.ok) throw new Error('Request failed'); return r.json(); }),
    enabled: !!orgId && !isGuest,
  });

  interface MyReturn { id: number; orderId: number | null; reason: string; status: string; returnType: string; refundAmount: string | null; currency: string; fraudFlag: boolean; createdAt: string; resolvedAt: string | null; }
  const { data: myReturns = [] } = useQuery<MyReturn[]>({
    queryKey: [`/api/organizations/${orgId}/shop/my-returns`],
    queryFn: () => fetch(`/api/organizations/${orgId}/shop/my-returns`, { credentials: 'include' }).then(r => r.ok ? r.json() : []),
    enabled: !!orgId && !isGuest,
  });
  const myReturnsByOrderId = Object.fromEntries(myReturns.map(r => [r.orderId, r]));

  const { data: reviewAggregates = {} } = useQuery<Record<number, { avgRating: number; totalCount: number }>>({
    queryKey: [`/api/organizations/${orgId}/shop/review-aggregates`],
    queryFn: () => fetch(`/api/organizations/${orgId}/shop/review-aggregates`).then(r => r.ok ? r.json() : {}),
    enabled: !!orgId,
    staleTime: 5 * 60 * 1000,
  });

  const { data: wishlistIds = [] } = useQuery<number[]>({
    queryKey: [`/api/organizations/${orgId}/shop/wishlist/ids`],
    queryFn: () => fetch(`/api/organizations/${orgId}/shop/wishlist/ids`, { credentials: 'include' }).then(r => r.ok ? r.json() : []),
    enabled: !!orgId && !isGuest,
  });

  const { data: wishlist = [], isLoading: wishlistLoading } = useQuery<WishlistItem[]>({
    queryKey: [`/api/organizations/${orgId}/shop/wishlist`],
    queryFn: () => fetch(`/api/organizations/${orgId}/shop/wishlist`, { credentials: 'include' }).then(r => r.ok ? r.json() : []),
    enabled: !!orgId && !isGuest,
  });

  const { data: storeSettings, refetch: refetchSettings } = useQuery<StoreSettings>({
    queryKey: [`/api/organizations/${orgId}/shop/store-settings`],
    queryFn: (): Promise<StoreSettings> => fetch(`/api/organizations/${orgId}/shop/store-settings`, { credentials: 'include' }).then(r => r.ok ? r.json() as Promise<StoreSettings> : {} as StoreSettings),
    enabled: !!orgId && isAdmin,
    staleTime: 2 * 60 * 1000,
  });

  const { data: loyaltyMe } = useQuery<{ account: { pointsBalance: number } } | null>({
    queryKey: [`/api/organizations/${orgId}/loyalty/me`],
    queryFn: () => fetch(`/api/organizations/${orgId}/loyalty/me`, { credentials: 'include' }).then(r => r.ok ? r.json() : null),
    enabled: !!orgId && !isGuest,
    staleTime: 60 * 1000,
  });
  const loyaltyBalance = loyaltyMe?.account?.pointsBalance ?? 0;

  // Variants for product in management dialog
  const { data: managedVariants = [], refetch: refetchManagedVariants } = useQuery<ProductVariant[]>({
    queryKey: [`/api/organizations/${orgId}/shop/products/${variantMgmtProductId}/variants`],
    queryFn: () => fetch(`/api/organizations/${orgId}/shop/products/${variantMgmtProductId}/variants`).then(r => r.ok ? r.json() : []),
    enabled: !!orgId && !!variantMgmtProductId,
  });

  type AdminReview = { id: number; productId: number; rating: number; comment: string | null; isApproved: boolean; createdAt: string; reviewerName: string | null; reviewerEmail: string | null; productName: string | null };
  const { data: adminReviews = [], refetch: refetchAdminReviews } = useQuery<AdminReview[]>({
    queryKey: [`/api/organizations/${orgId}/shop/reviews`],
    queryFn: () => fetch(`/api/organizations/${orgId}/shop/reviews`, { credentials: 'include' }).then(r => r.ok ? r.json() : []),
    enabled: !!orgId && isAdmin,
  });

  const { data: reviewPrompts = [] } = useQuery<ReviewPrompt[]>({
    queryKey: [`/api/organizations/${orgId}/shop/review-prompts`],
    queryFn: () => fetch(`/api/organizations/${orgId}/shop/review-prompts`, { credentials: 'include' }).then(r => r.ok ? r.json() : []),
    enabled: !!orgId && !isGuest,
    refetchInterval: 5 * 60 * 1000,
  });

  const visiblePrompts = reviewPrompts.filter(p => !reviewPromptDismissed.has(p.id));

  // Populate store settings form when loaded
  useEffect(() => {
    if (storeSettings) {
      setStoreForm({
        gstin: storeSettings.gstin ?? '',
        sellerName: storeSettings.sellerName ?? '',
        sellerAddress: storeSettings.sellerAddress ?? '',
        sellerState: storeSettings.sellerState ?? '',
        sellerStateCode: storeSettings.sellerStateCode ?? '',
        shiprocketEmail: storeSettings.shiprocketEmail ?? '',
        shiprocketPassword: '',
      });
    }
  }, [storeSettings]);

  // Open product detail modal from URL ?product=:id
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const productParam = params.get('product');
    if (productParam && products.length > 0) {
      const pid = parseInt(productParam);
      const found = products.find(p => p.id === pid);
      if (found) setDetailProduct(found);
    }
  }, [products]);

  // ── Filtered products ────────────────────────────────────────────────────
  const filteredProducts = useMemo(() => {
    return products.filter(p => {
      if (!isAdmin && !p.isActive) return false;
      if (categoryFilter !== 'all' && p.category !== categoryFilter) return false;
      if (search) {
        const q = search.toLowerCase();
        if (!p.name.toLowerCase().includes(q) && !(p.description ?? '').toLowerCase().includes(q)) return false;
      }
      return true;
    });
  }, [products, categoryFilter, search, isAdmin]);

  const cartTotal = cartItems.reduce((sum, item) => sum + parseFloat(item.product.markupPrice) * item.qty, 0);
  const cartCount = cartItems.reduce((sum, item) => sum + item.qty, 0);
  const wishlistIdSet = useMemo(() => new Set(wishlistIds), [wishlistIds]);

  // ── Wishlist helpers ──────────────────────────────────────────────────────
  const toggleWishlist = useCallback(async (product: ShopProduct, e?: React.MouseEvent) => {
    e?.stopPropagation();
    if (isGuest) {
      toast({ title: 'Sign in to save items', description: 'Create an account to use your wishlist.', variant: 'destructive' });
      return;
    }
    const inWishlist = wishlistIdSet.has(product.id);
    if (inWishlist) {
      await fetch(`/api/organizations/${orgId}/shop/wishlist/${product.id}`, { method: 'DELETE', credentials: 'include' });
      toast({ title: 'Removed from wishlist' });
    } else {
      await fetch(`/api/organizations/${orgId}/shop/wishlist`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productId: product.id }),
      });
      toast({ title: 'Added to wishlist', description: product.name });
    }
    queryClient.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/shop/wishlist/ids`] });
    queryClient.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/shop/wishlist`] });
  }, [isGuest, orgId, wishlistIdSet, queryClient, toast]);

  // ── Cart helpers ─────────────────────────────────────────────────────────
  const addToCart = (product: ShopProduct, size: string, color: string = '', variantId: number | null = null) => {
    setCartItems(prev => {
      const existing = prev.find(i => i.product.id === product.id && i.size === size && i.color === color);
      if (existing) return prev.map(i => i === existing ? { ...i, qty: i.qty + 1 } : i);
      return [...prev, { product, size, color, qty: 1, variantId }];
    });
    toast({ title: 'Added to cart', description: `${product.name}${size ? ` — ${size}` : ''}${color ? ` / ${color}` : ''}` });
  };

  const updateCartQty = (index: number, delta: number) => {
    setCartItems(prev => {
      const item = prev[index];
      if (!item) return prev;
      const newQty = item.qty + delta;
      if (newQty <= 0) return prev.filter((_, i) => i !== index);
      return prev.map((it, i) => i === index ? { ...it, qty: newQty } : it);
    });
  };

  const removeFromCart = (index: number) => setCartItems(prev => prev.filter((_, i) => i !== index));

  // ── Checkout ─────────────────────────────────────────────────────────────
  const proceedToCheckout = () => { setCartOpen(false); setCheckoutOpen(true); };

  const doCheckout = async (items: CartItem[]) => {
    if (!items.length) return;
    if (isGuest) {
      toast({ title: 'Login required', description: 'Please sign in to complete your purchase.', variant: 'destructive' });
      return;
    }
    if (!checkoutForm.customerName || !checkoutForm.customerEmail) {
      toast({ title: 'Name and email required', variant: 'destructive' }); return;
    }
    if (!checkoutForm.addressLine1 || !checkoutForm.addressCity || !checkoutForm.addressState || !checkoutForm.addressPincode) {
      toast({ title: 'Shipping address required', variant: 'destructive' }); return;
    }

    const shippingAddress = {
      line1: checkoutForm.addressLine1,
      city: checkoutForm.addressCity,
      state: checkoutForm.addressState,
      pincode: checkoutForm.addressPincode,
      country: checkoutForm.addressCountry || 'IN',
    };
    const payload = {
      items: items.map(i => ({
        productId: i.product.id,
        variantId: i.variantId ?? undefined,
        size: i.size || undefined,
        color: i.color || undefined,
        quantity: i.qty,
      })),
      customerName: checkoutForm.customerName,
      customerEmail: checkoutForm.customerEmail,
      customerPhone: checkoutForm.customerPhone || undefined,
      shippingAddress,
      buyerGstin: checkoutForm.buyerGstin || undefined,
      promoCode: promoCode.trim().toUpperCase() || undefined,
      affiliateCode: affiliateCodeInput.trim().toUpperCase() || undefined,
      loyaltyPointsToRedeem: loyaltyPointsToRedeem > 0 ? loyaltyPointsToRedeem : undefined,
    };

    setCheckingOut(true);
    try {
      if (paymentMode === 'cod') {
        const res = await fetch(`/api/organizations/${orgId}/shop/orders/cod`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
          body: JSON.stringify(payload),
        });
        if (!res.ok) throw new Error((await res.json()).error ?? 'COD order failed');
        queryClient.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/shop/my-orders`] });
        setCartItems([]);
        setCheckoutOpen(false);
        toast({ title: 'COD Order Placed!', description: 'Pay on delivery. Confirmation email sent.' });
      } else {
        const initiateRes = await fetch(`/api/organizations/${orgId}/shop/orders/initiate-cart`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
          body: JSON.stringify(payload),
        });
        if (!initiateRes.ok) throw new Error((await initiateRes.json()).error ?? 'Checkout failed');
        const data = await initiateRes.json() as {
          orderIds: number[]; razorpayOrderId: string; amount: number; currency: string; keyId: string;
          processor?: 'razorpay' | 'stripe';
          stripePublishableKey?: string; clientSecret?: string;
          discounts?: Array<{ type: string; label: string; amount: number }>; discountTotal?: number; finalTotal?: number; stackingPolicy?: string;
        };
        if (data.discounts && data.discounts.length > 0) {
          setDiscountResult({
            discounts: data.discounts,
            discountTotal: data.discountTotal ?? 0,
            finalTotal: data.finalTotal ?? cartTotal,
            stackingPolicy: data.stackingPolicy ?? 'promo_member',
          });
        }

        // ── Stripe path (non-INR clubs) ────────────────────────────────
        if (data.processor === 'stripe') {
          if (!data.stripePublishableKey || !data.clientSecret) {
            throw new Error('Stripe checkout is missing required configuration. Please contact the club.');
          }
          const sym = SHOP_CURRENCY_SYMBOLS[data.currency] ?? `${data.currency} `;
          const description = items.length === 1 ? items[0]!.product.name : `${items.length} items`;
          const amountLabel = `${sym}${(data.amount / 100).toLocaleString()}`;
          await new Promise<void>((resolve, reject) => {
            setStripeCheckout({
              publishableKey: data.stripePublishableKey!,
              clientSecret: data.clientSecret!,
              description,
              amountLabel,
              resolve,
              reject,
            });
          });

          queryClient.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/shop/my-orders`] });
          queryClient.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/shop/review-prompts`] });
          setCartItems([]);
          setCheckoutOpen(false);
          toast({ title: 'Order placed!', description: 'Confirmation email on its way.' });
          return;
        }

        // ── Razorpay path (INR clubs) ─────────────────────────────────
        await new Promise<void>((resolve, reject) => {
          const RzpCtor = (window as unknown as { Razorpay?: new (o: Record<string, unknown>) => { open(): void } }).Razorpay;
          if (!RzpCtor) { reject(new Error('Payment system unavailable — please refresh and try again')); return; }
          const rzp = new RzpCtor({
            key: data.keyId,
            amount: data.amount,
            currency: data.currency,
            name: 'Club Shop',
            description: items.length === 1 ? items[0]!.product.name : `${items.length} items`,
            order_id: data.razorpayOrderId,
            prefill: { name: checkoutForm.customerName, email: checkoutForm.customerEmail, contact: checkoutForm.customerPhone },
            handler: async (response: Record<string, string>) => {
              const verifyRes = await fetch(`/api/organizations/${orgId}/shop/orders/verify-cart`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
                body: JSON.stringify(response),
              });
              if (!verifyRes.ok) { reject(new Error((await verifyRes.json()).error ?? 'Payment verification failed')); return; }
              resolve();
            },
            modal: { ondismiss: () => reject(new Error('cancelled')) },
          });
          rzp.open();
        });

        queryClient.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/shop/my-orders`] });
        queryClient.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/shop/review-prompts`] });
        setCartItems([]);
        setCheckoutOpen(false);
        toast({ title: 'Order placed!', description: 'Confirmation email on its way.' });
      }
    } catch (e) {
      const msg = (e as Error).message;
      if (msg === 'cancelled') return;
      toast({ title: 'Checkout failed', description: msg, variant: 'destructive' });
    } finally { setCheckingOut(false); }
  };

  // ── Admin helpers ─────────────────────────────────────────────────────────
  const saveProduct = async () => {
    if (!productForm.name || !productForm.markupPrice) {
      toast({ title: 'Name and selling price required', variant: 'destructive' }); return;
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/organizations/${orgId}/shop/products`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...productForm,
          basePrice: productForm.basePrice || productForm.markupPrice,
          hsnCode: productForm.hsnCode || undefined,
        }),
      });
      if (!res.ok) throw new Error((await res.json()).error);
      const newProduct = await res.json() as ShopProduct;
      await queryClient.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/shop/products`] });
      setAddProductOpen(false);
      setProductForm({ name: '', description: '', imageUrl: '', category: 'apparel', basePrice: '', markupPrice: '', currency: 'INR', hsnCode: '', gstRate: '18' });
      toast({ title: 'Product added', description: 'You can now add size/colour variants.' });
      setVariantMgmtProductId(newProduct.id);
    } catch (e) {
      toast({ title: 'Failed', description: (e as Error).message, variant: 'destructive' });
    } finally { setSaving(false); }
  };

  const toggleProduct = async (product: ShopProduct) => {
    await fetch(`/api/organizations/${orgId}/shop/products/${product.id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...product, isActive: !product.isActive }),
    });
    queryClient.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/shop/products`] });
    toast({ title: product.isActive ? 'Product hidden' : 'Product published' });
  };

  const addVariant = async () => {
    if (!variantMgmtProductId) return;
    if (!newVariant.color && !newVariant.size) {
      toast({ title: 'Color or size required', variant: 'destructive' }); return;
    }
    setSavingVariant(true);
    try {
      const res = await fetch(`/api/organizations/${orgId}/shop/products/${variantMgmtProductId}/variants`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ ...newVariant, stockQty: Number(newVariant.stockQty) || 0 }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? 'Failed to add variant');
      setNewVariant({ color: '', size: '', stockQty: 0, sku: '' });
      refetchManagedVariants();
      toast({ title: 'Variant added' });
    } catch (e) {
      toast({ title: 'Failed', description: (e as Error).message, variant: 'destructive' });
    } finally { setSavingVariant(false); }
  };

  const updateVariantStock = async (variantId: number, delta: number, currentQty: number) => {
    const newQty = Math.max(0, currentQty + delta);
    await fetch(`/api/organizations/${orgId}/shop/products/${variantMgmtProductId}/variants/${variantId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
      body: JSON.stringify({ stockQty: newQty }),
    });
    refetchManagedVariants();
  };

  const deleteVariant = async (variantId: number) => {
    await fetch(`/api/organizations/${orgId}/shop/products/${variantMgmtProductId}/variants/${variantId}`, {
      method: 'DELETE', credentials: 'include',
    });
    refetchManagedVariants();
    toast({ title: 'Variant removed' });
  };

  const openTrackingDialog = (order: ShopOrder) => {
    setTrackingOrder(order);
    setTrackingForm({ trackingNumber: order.trackingNumber ?? '', trackingUrl: order.trackingUrl ?? '', status: order.status });
  };

  const updateTracking = async () => {
    if (!trackingOrder) return;
    setUpdatingTracking(true);
    try {
      const res = await fetch(`/api/organizations/${orgId}/shop/orders/${trackingOrder.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify(trackingForm),
      });
      if (!res.ok) throw new Error((await res.json()).error);
      await queryClient.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/shop/orders`] });
      setTrackingOrder(null);
      toast({ title: 'Order updated', description: trackingForm.trackingNumber ? 'Tracking saved & customer notified.' : 'Status updated.' });
    } catch (e) {
      toast({ title: 'Update failed', description: (e as Error).message, variant: 'destructive' });
    } finally { setUpdatingTracking(false); }
  };

  const createShipment = async (orderId: number) => {
    setCreatingShipment(orderId);
    try {
      const res = await fetch(`/api/organizations/${orgId}/shop/orders/${orderId}/shiprocket`, {
        method: 'POST', credentials: 'include',
      });
      const data = await res.json() as { awbCode?: string; shiprocketOrderId?: string; error?: string };
      if (!res.ok) throw new Error(data.error ?? 'Shipment creation failed');
      await refetchOrders();
      toast({ title: 'Shipment created', description: `AWB: ${data.awbCode ?? 'pending'}` });
    } catch (e) {
      toast({ title: 'Shipment failed', description: (e as Error).message, variant: 'destructive' });
    } finally { setCreatingShipment(null); }
  };

  const saveStoreSettings = async () => {
    setSavingStoreSettings(true);
    try {
      const res = await fetch(`/api/organizations/${orgId}/shop/store-settings`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify(storeForm),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? 'Failed');
      await refetchSettings();
      setSettingsOpen(false);
      toast({ title: 'Store settings saved' });
    } catch (e) {
      toast({ title: 'Save failed', description: (e as Error).message, variant: 'destructive' });
    } finally { setSavingStoreSettings(false); }
  };

  const toggleModeration = async () => {
    if (!orgId) return;
    const next = !storeSettings?.reviewModerationEnabled;
    await fetch(`/api/organizations/${orgId}/shop/settings`, {
      method: 'PATCH', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reviewModerationEnabled: next }),
    });
    refetchSettings();
  };

  // ── Review helpers ────────────────────────────────────────────────────────
  const approveReview = async (reviewId: number, approve: boolean) => {
    await fetch(`/api/organizations/${orgId}/shop/reviews/${reviewId}/approve`, {
      method: 'PATCH', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isApproved: approve }),
    });
    refetchAdminReviews();
    queryClient.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/shop/review-aggregates`] });
  };

  const deleteReview = async (reviewId: number) => {
    await fetch(`/api/organizations/${orgId}/shop/reviews/${reviewId}`, { method: 'DELETE', credentials: 'include' });
    refetchAdminReviews();
    queryClient.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/shop/review-aggregates`] });
  };

  const submitReview = async () => {
    if (!reviewProduct || reviewRating === 0) {
      toast({ title: 'Please select a star rating', variant: 'destructive' }); return;
    }
    setSubmittingReview(true);
    try {
      const res = await fetch(`/api/organizations/${orgId}/shop/products/${reviewProduct.id}/reviews`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rating: reviewRating, comment: reviewComment.trim() || undefined }),
      });
      if (!res.ok) {
        const d = await res.json() as { error?: string };
        throw new Error(d.error ?? 'Failed to submit review');
      }
      queryClient.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/shop/review-prompts`] });
      queryClient.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/shop/review-aggregates`] });
      if (reviewProduct) {
        queryClient.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/shop/products/${reviewProduct.id}/reviews`] });
        queryClient.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/shop/products/${reviewProduct.id}/reviews/can-review`] });
      }
      setReviewProduct(null); setReviewRating(0); setReviewComment('');
      toast({ title: 'Review submitted!', description: 'Thank you for your feedback.' });
    } catch (e) {
      toast({ title: 'Review failed', description: (e as Error).message, variant: 'destructive' });
    } finally { setSubmittingReview(false); }
  };

  const dismissPrompt = async (promptId: number) => {
    setReviewPromptDismissed(prev => new Set([...prev, promptId]));
    await fetch(`/api/organizations/${orgId}/shop/review-prompts/${promptId}/dismiss`, {
      method: 'POST', credentials: 'include',
    }).catch(() => {});
  };

  const submitReturn = async () => {
    if (!returnOrder || !orgId) return;
    if (!returnForm.reason) { toast({ title: 'Select a reason', variant: 'destructive' }); return; }
    setSubmittingReturn(true);
    try {
      const r = await fetch(`/api/organizations/${orgId}/shop/returns`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ orderId: returnOrder.id, ...returnForm }),
      });
      const data = await r.json();
      if (!r.ok) { toast({ title: 'Failed to submit', description: data.error, variant: 'destructive' }); return; }
      toast({ title: data.flagged ? 'Return submitted — under review' : 'Return request submitted', description: data.flagged ? 'Your return has been flagged for manual review.' : 'We\'ll process it shortly.' });
      queryClient.invalidateQueries({ queryKey: [`/api/organizations/${orgId}/shop/my-returns`] });
      setReturnOrder(null);
      setReturnForm({ reason: '', reasonDetail: '', returnType: 'refund' });
    } catch { toast({ title: 'Error', description: 'Request failed', variant: 'destructive' }); }
    finally { setSubmittingReturn(false); }
  };

  // ── Checkout form ─────────────────────────────────────────────────────────
  const CheckoutFields = () => (
    <div className="space-y-3">
      <div><label className="text-xs text-muted-foreground uppercase tracking-wider">Your Name *</label>
        <Input value={checkoutForm.customerName} onChange={e => setCheckoutForm(f => ({ ...f, customerName: e.target.value }))} className="mt-1 bg-black/40 border-white/10 text-white" /></div>
      <div><label className="text-xs text-muted-foreground uppercase tracking-wider">Email *</label>
        <Input type="email" value={checkoutForm.customerEmail} onChange={e => setCheckoutForm(f => ({ ...f, customerEmail: e.target.value }))} className="mt-1 bg-black/40 border-white/10 text-white" /></div>
      <div><label className="text-xs text-muted-foreground uppercase tracking-wider">Phone</label>
        <Input value={checkoutForm.customerPhone} onChange={e => setCheckoutForm(f => ({ ...f, customerPhone: e.target.value }))} className="mt-1 bg-black/40 border-white/10 text-white" /></div>
      <div className="border-t border-white/5 pt-3">
        <p className="text-xs text-muted-foreground uppercase tracking-wider mb-2">Shipping Address *</p>
        <div className="space-y-2">
          <Input placeholder="Address line 1 *" value={checkoutForm.addressLine1} onChange={e => setCheckoutForm(f => ({ ...f, addressLine1: e.target.value }))} className="bg-black/40 border-white/10 text-white placeholder:text-white/30" />
          <div className="flex gap-2">
            <Input placeholder="City *" value={checkoutForm.addressCity} onChange={e => setCheckoutForm(f => ({ ...f, addressCity: e.target.value }))} className="flex-1 bg-black/40 border-white/10 text-white placeholder:text-white/30" />
            <Input placeholder="State *" value={checkoutForm.addressState} onChange={e => setCheckoutForm(f => ({ ...f, addressState: e.target.value }))} className="flex-1 bg-black/40 border-white/10 text-white placeholder:text-white/30" />
          </div>
          <div className="flex gap-2">
            <Input placeholder="PIN *" value={checkoutForm.addressPincode} onChange={e => setCheckoutForm(f => ({ ...f, addressPincode: e.target.value }))} className="flex-1 bg-black/40 border-white/10 text-white placeholder:text-white/30" />
            <Input placeholder="Country (e.g. IN)" value={checkoutForm.addressCountry} onChange={e => setCheckoutForm(f => ({ ...f, addressCountry: e.target.value }))} className="flex-1 bg-black/40 border-white/10 text-white placeholder:text-white/30" />
          </div>
        </div>
      </div>
      <div><label className="text-xs text-muted-foreground uppercase tracking-wider">GST No. (optional)</label>
        <Input value={checkoutForm.buyerGstin} onChange={e => setCheckoutForm(f => ({ ...f, buyerGstin: e.target.value }))} placeholder="22AAAAA0000A1Z5" className="mt-1 bg-black/40 border-white/10 text-white placeholder:text-white/30" /></div>
    </div>
  );

  return (
    <div className="h-full overflow-y-auto">
      {stripeCheckout && (
        <StripeCheckoutDialog
          open
          onOpenChange={(o) => {
            // Closing the dialog (Esc, backdrop, or X button) cancels the in-flight
            // checkout promise. Settling the promise also clears stripeCheckout state,
            // so this branch only fires while the promise is still pending.
            if (!o) {
              stripeCheckout.reject(new Error('cancelled'));
              setStripeCheckout(null);
            }
          }}
          publishableKey={stripeCheckout.publishableKey}
          clientSecret={stripeCheckout.clientSecret}
          description={stripeCheckout.description}
          amountLabel={stripeCheckout.amountLabel}
          onSuccess={async ({ stripe_payment_intent_id }) => {
            try {
              const verifyRes = await fetch(`/api/organizations/${orgId}/shop/orders/verify-cart`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
                body: JSON.stringify({ stripe_payment_intent_id }),
              });
              if (!verifyRes.ok) {
                const e = await verifyRes.json().catch(() => ({}));
                stripeCheckout.reject(new Error(e.error ?? 'Payment verification failed'));
              } else {
                stripeCheckout.resolve();
              }
            } finally {
              setStripeCheckout(null);
            }
          }}
        />
      )}
      <div className="max-w-7xl mx-auto p-8 space-y-6">
        <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }}>
          <div className="flex items-center justify-between">
            <div>
              <div className="flex items-center gap-3 mb-1">
                <ShoppingBag className="w-6 h-6 text-primary" />
                <h1 className="text-2xl font-display font-bold text-white tracking-tight">Club Shop</h1>
              </div>
              <p className="text-muted-foreground text-sm">Official club merchandise — self-managed inventory, India-first</p>
            </div>
            <div className="flex items-center gap-3">
              {!isGuest && wishlist.length > 0 && (
                <div className="relative">
                  <Heart className="w-5 h-5 text-red-400" />
                  <span className="absolute -top-1.5 -right-1.5 w-4 h-4 bg-red-500 rounded-full text-[9px] font-bold flex items-center justify-center text-white">{wishlist.length}</span>
                </div>
              )}
              {cartCount > 0 && (
                <Button onClick={() => setCartOpen(true)} className="relative bg-primary hover:bg-primary/90 text-white gap-2">
                  <ShoppingCart className="w-4 h-4" />Cart
                  <span className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-red-500 rounded-full text-[10px] font-bold flex items-center justify-center">{cartCount}</span>
                </Button>
              )}
              {isAdmin && (
                <>
                  <Button onClick={() => setAddProductOpen(true)} className="bg-white/10 hover:bg-white/20 text-white gap-2 border border-white/10">
                    <Plus className="w-4 h-4" /> Add Product
                  </Button>
                  <Button onClick={() => setSettingsOpen(true)} variant="ghost" size="sm" className="text-muted-foreground hover:text-white gap-1.5">
                    <Settings className="w-4 h-4" />
                  </Button>
                </>
              )}
            </div>
          </div>
        </motion.div>

        {/* ── Review prompts banner ─────────────────────────────────────────── */}
        {visiblePrompts.length > 0 && (
          <div className="space-y-2">
            {visiblePrompts.map(prompt => (
              <div key={prompt.id} className="flex items-center gap-4 p-4 bg-yellow-500/10 border border-yellow-500/20 rounded-xl">
                <Bell className="w-5 h-5 text-yellow-400 flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-white text-sm font-semibold">How was your <span className="text-yellow-300">{prompt.productName}</span>?</p>
                  <p className="text-yellow-300/70 text-xs mt-0.5">Leave a quick review to help other club members.</p>
                </div>
                <Button size="sm" className="bg-yellow-500/20 hover:bg-yellow-500/30 text-yellow-400 border border-yellow-500/30 gap-1.5 flex-shrink-0"
                  onClick={() => { const prod = products.find(p => p.id === prompt.productId); if (prod) { setReviewProduct(prod); setReviewRating(0); setReviewComment(''); } }}>
                  <Star className="w-3.5 h-3.5" /> Write Review
                </Button>
                <Button size="sm" variant="ghost" aria-label="Dismiss" className="text-muted-foreground hover:text-white h-7 w-7 p-0 flex-shrink-0" onClick={() => dismissPrompt(prompt.id)}>
                  <X className="w-3.5 h-3.5" />
                </Button>
              </div>
            ))}
          </div>
        )}

        <Tabs defaultValue="products" className="w-full">
          <TabsList className="bg-black/40 border border-white/5 p-1 rounded-xl flex-wrap h-auto gap-1">
            <TabsTrigger value="products" className="rounded-lg data-[state=active]:bg-primary/20 data-[state=active]:text-white px-5 py-2.5 font-semibold flex items-center gap-2">
              <Package className="w-4 h-4" /> Products
            </TabsTrigger>
            {!isGuest && (
              <TabsTrigger value="wishlist" className="rounded-lg data-[state=active]:bg-red-500/20 data-[state=active]:text-red-400 px-5 py-2.5 font-semibold flex items-center gap-2">
                <Heart className="w-4 h-4" /> Wishlist {wishlist.length > 0 && <span className="text-xs bg-red-500/30 text-red-400 rounded-full px-1.5">{wishlist.length}</span>}
              </TabsTrigger>
            )}
            {!isGuest && (
              <TabsTrigger value="my-orders" className="rounded-lg data-[state=active]:bg-cyan-500/20 data-[state=active]:text-cyan-400 px-5 py-2.5 font-semibold flex items-center gap-2">
                <History className="w-4 h-4" /> My Orders {myOrders.length > 0 && <span className="text-xs bg-cyan-500/30 text-cyan-400 rounded-full px-1.5">{myOrders.length}</span>}
              </TabsTrigger>
            )}
            {isAdmin && (
              <TabsTrigger value="orders" className="rounded-lg data-[state=active]:bg-emerald-500/20 data-[state=active]:text-emerald-400 px-5 py-2.5 font-semibold flex items-center gap-2">
                <Truck className="w-4 h-4" /> Orders {orders.length > 0 && <span className="text-xs bg-emerald-500/30 text-emerald-400 rounded-full px-1.5">{orders.length}</span>}
              </TabsTrigger>
            )}
          </TabsList>

          {/* ── Products tab ─────────────────────────────────────────────── */}
          <TabsContent value="products" className="mt-4 space-y-4">
            <div className="flex flex-col sm:flex-row gap-3">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input placeholder="Search products…" value={search} onChange={e => setSearch(e.target.value)} className="pl-9 bg-black/40 border-white/10 text-white placeholder:text-white/30" />
              </div>
              <div className="flex gap-1.5 flex-wrap">
                {CATEGORIES.map(cat => (
                  <button key={cat} onClick={() => setCategoryFilter(cat)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${categoryFilter === cat ? 'bg-primary/20 text-primary border border-primary/30' : 'bg-white/5 text-muted-foreground hover:bg-white/10 border border-transparent'}`}>
                    {CATEGORY_LABELS[cat]}
                  </button>
                ))}
              </div>
            </div>

            {productsLoading ? (
              <div className="flex items-center justify-center h-48 text-muted-foreground gap-2">
                <RefreshCw className="w-4 h-4 animate-spin" /> Loading products…
              </div>
            ) : filteredProducts.length === 0 ? (
              <Card className="glass-card">
                <CardContent className="flex flex-col items-center justify-center py-16 text-center">
                  <ShoppingBag className="w-12 h-12 text-primary/40 mb-4" />
                  <p className="text-white font-semibold mb-1">{products.length === 0 ? 'No products yet' : 'No matching products'}</p>
                  <p className="text-muted-foreground text-sm max-w-sm">
                    {products.length === 0 ? 'Add club-branded merchandise, set GST rates and HSN codes, then manage inventory variants.' : 'Try adjusting your search or category filter.'}
                  </p>
                  {isAdmin && products.length === 0 && (
                    <Button onClick={() => setAddProductOpen(true)} className="mt-4 bg-primary hover:bg-primary/90 text-white gap-2">
                      <Plus className="w-4 h-4" />Add Product
                    </Button>
                  )}
                </CardContent>
              </Card>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                {filteredProducts.map(p => (
                  <ProductCard
                    key={p.id} product={p} isAdmin={isAdmin} isGuest={isGuest} orgId={orgId}
                    inWishlist={wishlistIdSet.has(p.id)} reviewAggregate={reviewAggregates[p.id]}
                    onOpen={() => { setDetailProduct(p); setDetailVariantId(null); setDetailSize(''); setDetailColor(''); }}
                    onAddToCart={() => addToCart(p, '', '', null)}
                    onToggleWishlist={(e) => toggleWishlist(p, e)}
                    onToggleActive={() => toggleProduct(p)}
                    onManageVariants={() => setVariantMgmtProductId(p.id)}
                  />
                ))}
              </div>
            )}
          </TabsContent>

          {/* ── Wishlist tab ──────────────────────────────────────────────── */}
          {!isGuest && (
            <TabsContent value="wishlist" className="mt-4">
              {wishlistLoading ? (
                <div className="flex items-center justify-center h-48 text-muted-foreground gap-2">
                  <RefreshCw className="w-4 h-4 animate-spin" /> Loading wishlist…
                </div>
              ) : wishlist.length === 0 ? (
                <Card className="glass-card">
                  <CardContent className="flex flex-col items-center justify-center py-16 text-center">
                    <Heart className="w-12 h-12 text-red-500/30 mb-4" />
                    <p className="text-white font-semibold mb-1">Your wishlist is empty</p>
                    <p className="text-muted-foreground text-sm">Tap the heart icon on any product to save it here for later.</p>
                  </CardContent>
                </Card>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                  {wishlist.map(item => (
                    <Card key={item.wishlistId} className="glass-card overflow-hidden group">
                      <div className="aspect-square bg-white/5 relative overflow-hidden cursor-pointer"
                        onClick={() => { setDetailProduct(item.product); setDetailVariantId(null); setDetailSize(''); setDetailColor(''); }}>
                        {item.product.imageUrl ? (
                          <img src={item.product.imageUrl} alt={item.product.name} className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300" />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center"><Package className="w-16 h-16 text-white/20" /></div>
                        )}
                        <Badge className="absolute top-2 left-2 bg-black/60 text-white border-white/10 text-xs capitalize">{item.product.category}</Badge>
                        <button className="absolute top-2 right-2 p-1.5 rounded-full bg-black/60 hover:bg-red-500/30 transition-colors" onClick={e => toggleWishlist(item.product, e)}>
                          <Heart className="w-4 h-4 fill-red-400 text-red-400" />
                        </button>
                      </div>
                      <CardContent className="p-4">
                        <h3 className="font-semibold text-white text-sm leading-tight">{item.product.name}</h3>
                        <div className="flex items-center justify-between mt-3">
                          <span className="text-primary font-bold">{fmtPrice(item.product.markupPrice, item.product.currency)}</span>
                        </div>
                        <Button onClick={() => addToCart(item.product, '', '', null)} disabled={!item.product.isActive} className="w-full mt-3 bg-primary hover:bg-primary/90 text-white text-xs h-8 gap-1">
                          <ShoppingCart className="w-3.5 h-3.5" /> Add to Cart
                        </Button>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              )}
            </TabsContent>
          )}

          {/* ── My Orders tab ─────────────────────────────────────────────── */}
          {!isGuest && (
            <TabsContent value="my-orders" className="mt-4">
              {myOrdersLoading ? (
                <div className="flex items-center justify-center h-48 text-muted-foreground gap-2">
                  <RefreshCw className="w-4 h-4 animate-spin" /> Loading your orders…
                </div>
              ) : myOrders.length === 0 ? (
                <Card className="glass-card">
                  <CardContent className="flex flex-col items-center justify-center py-16 text-center">
                    <History className="w-12 h-12 text-cyan-500/40 mb-4" />
                    <p className="text-white font-semibold mb-1">No orders yet</p>
                    <p className="text-muted-foreground text-sm">Your shop orders will appear here after you check out.</p>
                  </CardContent>
                </Card>
              ) : (
                <div className="space-y-3">
                  {myOrders.map(o => {
                    const Icon = ORDER_STATUS_ICONS[o.status] ?? Package;
                    const isDelivered = (o.status === 'shipped' || o.status === 'delivered');
                    return (
                      <Card key={o.id} className="glass-card">
                        <CardContent className="p-4 flex items-center gap-4">
                          {o.productImage ? (
                            <img src={o.productImage} alt={o.productName ?? ''} className="w-14 h-14 rounded-lg object-cover flex-shrink-0" />
                          ) : (
                            <div className="w-14 h-14 rounded-lg bg-white/5 flex items-center justify-center flex-shrink-0">
                              <Package className="w-7 h-7 text-white/20" />
                            </div>
                          )}
                          <div className="flex-1 min-w-0">
                            <p className="text-white font-semibold text-sm">{o.productName ?? 'Item'}</p>
                            <p className="text-muted-foreground text-xs mt-0.5">
                              {o.size ? `Size: ${o.size}` : ''}{o.color ? ` / ${o.color}` : ''}{(o.size || o.color) ? ' · ' : ''}{o.quantity}× · {fmtPrice(o.totalAmount, o.currency)} · {new Date(o.createdAt).toLocaleDateString()}
                            </p>
                            {o.paymentMode === 'cod' && (
                              <Badge className="bg-orange-500/20 text-orange-400 border border-orange-500/30 text-xs mt-1">Cash on Delivery</Badge>
                            )}
                            {o.awbCode && (
                              <p className="text-xs mt-1 text-cyan-300">AWB: {o.awbCode}</p>
                            )}
                            {o.trackingNumber && (
                              <p className="text-xs mt-1">
                                <span className="text-muted-foreground">Tracking: </span>
                                {o.trackingUrl
                                  ? <a href={o.trackingUrl} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline flex items-center gap-1 inline-flex">{o.trackingNumber} <ExternalLink className="w-3 h-3" /></a>
                                  : <span className="text-white">{o.trackingNumber}</span>
                                }
                              </p>
                            )}
                            <div className="flex items-center gap-2 mt-1 flex-wrap">
                              {orgId && (
                                <a href={`/api/organizations/${orgId}/shop/orders/${o.id}/invoice`} target="_blank" rel="noopener noreferrer"
                                  className="text-xs text-blue-400 hover:text-blue-300 flex items-center gap-1">
                                  <Download className="w-3 h-3" /> Invoice
                                </a>
                              )}
                              {orgId && ['paid', 'processing', 'shipped', 'delivered'].includes(o.status) && (
                                <a href={`/api/organizations/${orgId}/gst-invoices/by-order/${o.id}`} target="_blank" rel="noopener noreferrer"
                                  className="text-xs text-green-400 hover:text-green-300 flex items-center gap-1">
                                  <Download className="w-3 h-3" /> GST Invoice
                                </a>
                              )}
                              {isDelivered && o.productId && orgId && (
                                <OrderReviewCta orgId={orgId} productId={o.productId} onOpen={() => {
                                  const prod = products.find(p => p.id === o.productId);
                                  if (prod) { setReviewProduct(prod); setReviewRating(0); setReviewComment(''); }
                                }} />
                              )}
                              {/* Return button — show for paid/shipped/delivered */}
                              {(['paid', 'shipped', 'delivered'].includes(o.status)) && (() => {
                                const existingReturn = myReturnsByOrderId[o.id];
                                if (existingReturn) {
                                  const rc: Record<string, string> = {
                                    pending: 'text-yellow-400', flagged: 'text-orange-400', received: 'text-cyan-400',
                                    approved: 'text-blue-400', refunded: 'text-green-400', rejected: 'text-red-400', exchanged: 'text-purple-400',
                                  };
                                  return (
                                    <span className={`text-xs flex items-center gap-1 ${rc[existingReturn.status] ?? 'text-muted-foreground'}`}>
                                      <RefreshCw className="w-3 h-3" /> Return: {existingReturn.status}
                                    </span>
                                  );
                                }
                                return (
                                  <button
                                    onClick={() => { setReturnOrder(o); setReturnForm({ reason: '', reasonDetail: '', returnType: 'refund' }); }}
                                    className="text-xs text-muted-foreground hover:text-orange-400 flex items-center gap-1 transition-colors"
                                  >
                                    <RefreshCw className="w-3 h-3" /> Request Return
                                  </button>
                                );
                              })()}
                            </div>
                          </div>
                          <Badge className={`border text-xs flex-shrink-0 flex items-center gap-1 ${ORDER_STATUS_COLORS[o.status] ?? 'bg-gray-500/20 text-gray-400 border-gray-500/30'}`}>
                            <Icon className="w-3 h-3" />
                            {o.status}
                          </Badge>
                        </CardContent>
                      </Card>
                    );
                  })}
                </div>
              )}
            </TabsContent>
          )}

          {/* ── Admin Orders tab ──────────────────────────────────────────── */}
          {isAdmin && (
            <TabsContent value="orders" className="mt-4 space-y-4">
              {/* Review moderation */}
              <Card className="glass-card">
                <CardContent className="py-3 px-4 flex items-center justify-between gap-4">
                  <div>
                    <p className="text-white text-sm font-semibold flex items-center gap-2">
                      <Star className="w-4 h-4 text-yellow-400" /> Review Moderation
                    </p>
                    <p className="text-muted-foreground text-xs mt-0.5">
                      {storeSettings?.reviewModerationEnabled ? 'New reviews require admin approval.' : 'Reviews auto-approved and visible immediately.'}
                    </p>
                  </div>
                  <Button variant="outline" size="sm" onClick={toggleModeration}
                    className={storeSettings?.reviewModerationEnabled ? 'border-yellow-500/40 text-yellow-400 hover:bg-yellow-500/10 text-xs' : 'border-white/10 text-muted-foreground hover:bg-white/5 text-xs'}>
                    {storeSettings?.reviewModerationEnabled ? 'Moderation ON' : 'Moderation OFF'}
                  </Button>
                </CardContent>
              </Card>

              {adminReviews.length > 0 && (
                <Card className="glass-card overflow-hidden">
                  <CardHeader className="pb-2 pt-3 px-4">
                    <CardTitle className="text-white text-sm flex items-center gap-2">
                      <Star className="w-4 h-4 text-yellow-400" /> Customer Reviews
                      {storeSettings?.reviewModerationEnabled && adminReviews.some(r => !r.isApproved) && (
                        <Badge className="bg-yellow-500/20 text-yellow-400 border border-yellow-500/30 text-xs ml-1">{adminReviews.filter(r => !r.isApproved).length} pending</Badge>
                      )}
                    </CardTitle>
                  </CardHeader>
                  <div className="divide-y divide-white/5">
                    {adminReviews.map(r => (
                      <div key={r.id} className="px-4 py-2.5 flex items-start gap-3">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-white text-xs font-medium">{r.reviewerName ?? r.reviewerEmail ?? 'Anonymous'}</span>
                            <span className="text-muted-foreground text-xs">{r.productName ?? `Product #${r.productId}`}</span>
                            <span className="text-yellow-400 text-xs">{'★'.repeat(r.rating)}{'☆'.repeat(5 - r.rating)}</span>
                            {!r.isApproved && <Badge className="bg-yellow-500/20 text-yellow-400 border border-yellow-500/30 text-xs py-0">Pending</Badge>}
                          </div>
                          {r.comment && <p className="text-muted-foreground text-xs mt-0.5 truncate">{r.comment}</p>}
                        </div>
                        <div className="flex items-center gap-1.5 flex-shrink-0">
                          {!r.isApproved ? (
                            <Button size="sm" variant="ghost" className="h-6 px-2 text-green-400 hover:text-green-300 hover:bg-green-500/10 text-xs" onClick={() => approveReview(r.id, true)}>Approve</Button>
                          ) : (
                            <Button size="sm" variant="ghost" className="h-6 px-2 text-muted-foreground hover:text-yellow-400 hover:bg-yellow-500/10 text-xs" onClick={() => approveReview(r.id, false)}>Unapprove</Button>
                          )}
                          <Button size="sm" variant="ghost" className="h-6 w-6 p-0 text-muted-foreground hover:text-red-400 hover:bg-red-500/10" onClick={() => deleteReview(r.id)}>
                            <Trash2 className="w-3 h-3" />
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                </Card>
              )}

              {ordersLoading ? (
                <div className="flex items-center justify-center h-48 text-muted-foreground">Loading orders…</div>
              ) : orders.length === 0 ? (
                <Card className="glass-card">
                  <CardContent className="flex flex-col items-center justify-center py-16 text-center">
                    <Truck className="w-12 h-12 text-blue-500/40 mb-4" />
                    <p className="text-white font-semibold mb-1">No orders yet</p>
                    <p className="text-muted-foreground text-sm">Shop orders will appear here once customers check out.</p>
                  </CardContent>
                </Card>
              ) : (() => {
                const STATUS_FILTER_OPTIONS = [
                  { value: 'all', label: 'All' },
                  { value: 'pending', label: 'Pending' },
                  { value: 'cod_pending', label: 'COD Pending' },
                  { value: 'paid', label: 'Paid' },
                  { value: 'processing', label: 'Processing' },
                  { value: 'shipped', label: 'Shipped' },
                  { value: 'delivered', label: 'Delivered' },
                  { value: 'cancelled', label: 'Cancelled' },
                ];
                const filteredOrders = orderStatusFilter === 'all' ? orders : orders.filter(o => o.status === orderStatusFilter);
                return (
                <div className="space-y-3">
                  <div className="flex flex-wrap gap-2">
                    {STATUS_FILTER_OPTIONS.map(opt => (
                      <button key={opt.value}
                        onClick={() => setOrderStatusFilter(opt.value)}
                        className={`text-xs px-3 py-1 rounded-full border transition-colors ${orderStatusFilter === opt.value
                          ? 'border-primary/60 bg-primary/20 text-primary'
                          : 'border-white/10 bg-white/5 text-muted-foreground hover:border-white/20 hover:text-white'}`}
                      >
                        {opt.label}
                        {opt.value !== 'all' && orders.filter(o => o.status === opt.value).length > 0 && (
                          <span className="ml-1.5 opacity-70">{orders.filter(o => o.status === opt.value).length}</span>
                        )}
                      </button>
                    ))}
                  </div>
                <Card className="glass-card overflow-hidden">
                  <Table>
                    <TableHeader>
                      <TableRow className="border-white/5 hover:bg-transparent">
                        <TableHead className="text-muted-foreground text-xs uppercase tracking-wider">Customer</TableHead>
                        <TableHead className="text-muted-foreground text-xs uppercase tracking-wider">Product / Variant</TableHead>
                        <TableHead className="text-muted-foreground text-xs uppercase tracking-wider">Amount</TableHead>
                        <TableHead className="text-muted-foreground text-xs uppercase tracking-wider">Payment</TableHead>
                        <TableHead className="text-muted-foreground text-xs uppercase tracking-wider">Status</TableHead>
                        <TableHead className="text-muted-foreground text-xs uppercase tracking-wider">Tracking / AWB</TableHead>
                        <TableHead className="text-muted-foreground text-xs uppercase tracking-wider">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filteredOrders.length === 0 ? (
                        <TableRow><TableCell colSpan={7} className="text-center text-muted-foreground py-8 text-sm">No orders with status "{orderStatusFilter}"</TableCell></TableRow>
                      ) : filteredOrders.map(o => (
                        <TableRow key={o.id} className="border-white/5 hover:bg-white/[0.02]">
                          <TableCell>
                            <div className="font-medium text-white text-sm">{o.customerName}</div>
                            <div className="text-muted-foreground text-xs">{o.customerEmail}</div>
                          </TableCell>
                          <TableCell>
                            <div className="text-white text-sm">{o.productName ?? 'Unknown'}</div>
                            <div className="text-muted-foreground text-xs">
                              {[o.size, o.color].filter(Boolean).join(' / ') || '—'} × {o.quantity}
                            </div>
                          </TableCell>
                          <TableCell className="text-white font-medium text-sm">{fmtPrice(o.totalAmount, o.currency)}</TableCell>
                          <TableCell>
                            {o.paymentMode === 'cod' ? (
                              <Badge className="bg-orange-500/20 text-orange-400 border border-orange-500/30 text-xs">COD</Badge>
                            ) : (
                              <Badge className="bg-blue-500/20 text-blue-400 border border-blue-500/30 text-xs">Razorpay</Badge>
                            )}
                          </TableCell>
                          <TableCell>
                            <Badge className={`border text-xs ${ORDER_STATUS_COLORS[o.status] ?? 'bg-gray-500/20 text-gray-400 border-gray-500/30'}`}>
                              {o.status}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            {o.awbCode ? (
                              <span className="text-cyan-300 text-xs">{o.awbCode}</span>
                            ) : o.trackingNumber ? (
                              o.trackingUrl
                                ? <a href={o.trackingUrl} target="_blank" rel="noopener noreferrer" className="text-primary text-xs hover:underline flex items-center gap-1">
                                    {o.trackingNumber} <ExternalLink className="w-3 h-3" />
                                  </a>
                                : <span className="text-white text-xs">{o.trackingNumber}</span>
                            ) : <span className="text-muted-foreground text-xs">—</span>}
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center gap-1">
                              <Button size="sm" variant="ghost" className="h-6 w-6 p-0 text-muted-foreground hover:text-white" onClick={() => openTrackingDialog(o)} title="Update tracking">
                                <Edit2 className="w-3 h-3" />
                              </Button>
                              {!o.shiprocketOrderId && (o.status === 'cod_pending' || o.status === 'paid' || o.status === 'processing') && (
                                <Button size="sm" variant="ghost"
                                  className="h-6 px-2 text-xs text-cyan-400 hover:text-cyan-300 hover:bg-cyan-500/10"
                                  disabled={creatingShipment === o.id}
                                  onClick={() => createShipment(o.id)}
                                  title="Create Shiprocket shipment"
                                >
                                  {creatingShipment === o.id ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Truck className="w-3 h-3" />}
                                </Button>
                              )}
                              <a href={`/api/organizations/${orgId}/shop/orders/${o.id}/invoice`} target="_blank" rel="noopener noreferrer"
                                className="h-6 w-6 flex items-center justify-center text-muted-foreground hover:text-blue-400 transition-colors" title="Download GST invoice">
                                <Download className="w-3 h-3" />
                              </a>
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </Card>
                </div>
                );
              })()}
            </TabsContent>
          )}
        </Tabs>
      </div>

      {/* ── Product Detail Modal ──────────────────────────────────────────────── */}
      <Dialog open={!!detailProduct} onOpenChange={o => { if (!o) setDetailProduct(null); }}>
        <DialogContent className="bg-[#0a1628] border border-white/10 text-white max-w-2xl max-h-[90vh] overflow-y-auto">
          {detailProduct && (
            <ProductDetailModal
              product={detailProduct}
              detailSize={detailSize} setDetailSize={setDetailSize}
              detailColor={detailColor} setDetailColor={setDetailColor}
              detailVariantId={detailVariantId} setDetailVariantId={setDetailVariantId}
              isGuest={isGuest} orgId={orgId}
              inWishlist={wishlistIdSet.has(detailProduct.id)}
              onToggleWishlist={(e) => toggleWishlist(detailProduct, e)}
              onAddToCart={() => { addToCart(detailProduct, detailSize, detailColor, detailVariantId); setDetailProduct(null); }}
              onBuyNow={() => { setCartItems([{ product: detailProduct, size: detailSize, color: detailColor, qty: 1, variantId: detailVariantId }]); setDetailProduct(null); setCheckoutOpen(true); }}
              onWriteReview={() => { setReviewProduct(detailProduct); setReviewRating(0); setReviewComment(''); setDetailProduct(null); }}
            />
          )}
        </DialogContent>
      </Dialog>

      {/* ── Cart Modal ──────────────────────────────────────────────────────── */}
      <Dialog open={cartOpen} onOpenChange={setCartOpen}>
        <DialogContent className="bg-[#0a1628] border border-white/10 text-white max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ShoppingCart className="w-5 h-5 text-primary" /> Your Cart ({cartCount} item{cartCount !== 1 ? 's' : ''})
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3 mt-2 max-h-80 overflow-y-auto">
            {cartItems.map((item, i) => (
              <div key={i} className="flex items-center gap-3 p-3 bg-white/5 rounded-lg">
                {item.product.imageUrl
                  ? <img src={item.product.imageUrl} alt={item.product.name} className="w-12 h-12 object-cover rounded" />
                  : <div className="w-12 h-12 bg-white/10 rounded flex items-center justify-center"><Package className="w-6 h-6 text-white/30" /></div>}
                <div className="flex-1 min-w-0">
                  <p className="text-white text-sm font-semibold truncate">{item.product.name}</p>
                  {(item.size || item.color) && <p className="text-muted-foreground text-xs">{[item.size, item.color].filter(Boolean).join(' / ')}</p>}
                  <p className="text-primary text-sm font-bold">{fmtPrice(parseFloat(item.product.markupPrice) * item.qty, item.product.currency)}</p>
                </div>
                <div className="flex items-center gap-1">
                  <Button size="sm" variant="ghost" aria-label="Decrease quantity" className="h-7 w-7 p-0 text-muted-foreground hover:text-white" onClick={() => updateCartQty(i, -1)}><Minus className="w-3 h-3" /></Button>
                  <span className="w-6 text-center text-white text-sm font-semibold">{item.qty}</span>
                  <Button size="sm" variant="ghost" aria-label="Increase quantity" className="h-7 w-7 p-0 text-muted-foreground hover:text-white" onClick={() => updateCartQty(i, 1)}><Plus className="w-3 h-3" /></Button>
                  <Button size="sm" variant="ghost" aria-label="Remove from cart" className="h-7 w-7 p-0 text-red-400/60 hover:text-red-400 ml-1" onClick={() => removeFromCart(i)}><Trash2 className="w-3 h-3" /></Button>
                </div>
              </div>
            ))}
          </div>
          {isGuest && (
            <div className="flex items-center gap-2 p-3 bg-yellow-500/10 border border-yellow-500/20 rounded-lg text-sm text-yellow-300">
              <CreditCard className="w-4 h-4 flex-shrink-0" /> Please sign in to complete your purchase.
            </div>
          )}
          <div className="flex items-center justify-between pt-3 border-t border-white/5">
            <div>
              <p className="text-muted-foreground text-sm">Total</p>
              <p className="text-xl font-bold text-primary">{cartItems[0] ? fmtPrice(cartTotal, cartItems[0].product.currency) : '—'}</p>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setCartOpen(false)} className="border-white/10 text-white hover:bg-white/5">Continue Shopping</Button>
              <Button onClick={proceedToCheckout} disabled={isGuest} className="bg-primary hover:bg-primary/90 text-white gap-2 disabled:opacity-50">
                <CreditCard className="w-4 h-4" /> Checkout
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Checkout Modal ───────────────────────────────────────────────────── */}
      <Dialog open={checkoutOpen} onOpenChange={o => { if (!o) setCheckoutOpen(false); }}>
        <DialogContent className="bg-[#0a1628] border border-white/10 text-white max-w-md max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CreditCard className="w-5 h-5 text-primary" /> Checkout
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 mt-2">
            <div className="p-3 bg-white/5 rounded-lg space-y-2">
              {cartItems.map((item, i) => (
                <div key={i} className="flex items-center justify-between text-sm">
                  <span className="text-white">{item.product.name}{item.size ? ` (${item.size})` : ''}{item.color ? ` / ${item.color}` : ''} × {item.qty}</span>
                  <span className="text-primary font-semibold">{fmtPrice(parseFloat(item.product.markupPrice) * item.qty, item.product.currency)}</span>
                </div>
              ))}
              {cartItems.length > 1 && (
                <div className="flex items-center justify-between text-sm font-bold border-t border-white/10 pt-2">
                  <span className="text-white">Total</span>
                  <span className="text-primary">{cartItems[0] ? fmtPrice(cartTotal, cartItems[0].product.currency) : '—'}</span>
                </div>
              )}
            </div>

            {/* Discount codes */}
            <div className="p-3 bg-white/5 rounded-lg space-y-2">
              <p className="text-xs text-white/60 uppercase tracking-wider">Discount Codes</p>
              <div className="flex gap-2">
                <Input
                  value={promoCode}
                  onChange={e => { setPromoCode(e.target.value.toUpperCase()); setDiscountResult(null); }}
                  placeholder="Promo code"
                  className="bg-black/40 border-white/10 text-white placeholder:text-white/30 text-sm"
                />
              </div>
              <div className="flex gap-2">
                <Input
                  value={affiliateCodeInput}
                  onChange={e => { setAffiliateCodeInput(e.target.value.toUpperCase()); setDiscountResult(null); }}
                  placeholder="Referral / affiliate code"
                  className="bg-black/40 border-white/10 text-white placeholder:text-white/30 text-sm"
                />
              </div>
              {loyaltyBalance > 0 && (
                <div className="space-y-1">
                  <p className="text-xs text-white/60">
                    Loyalty points: <span className="text-amber-400 font-semibold">{loyaltyBalance.toLocaleString('en-IN')}</span> available
                  </p>
                  <div className="flex items-center gap-2">
                    <Input
                      type="number"
                      min={0}
                      max={loyaltyBalance}
                      value={loyaltyPointsToRedeem || ''}
                      onChange={e => { setLoyaltyPointsToRedeem(Math.max(0, Math.min(loyaltyBalance, parseInt(e.target.value) || 0))); setDiscountResult(null); }}
                      placeholder="Points to redeem"
                      className="bg-black/40 border-white/10 text-white placeholder:text-white/30 text-sm flex-1"
                    />
                    {loyaltyPointsToRedeem > 0 && (
                      <button
                        className="text-xs text-white/50 hover:text-white/80 transition-colors"
                        onClick={() => { setLoyaltyPointsToRedeem(0); setDiscountResult(null); }}
                      >Clear</button>
                    )}
                  </div>
                </div>
              )}
              {discountResult && discountResult.discounts.length > 0 && (
                <div className="border-t border-white/10 pt-2 space-y-1">
                  {discountResult.discounts.map((d, i) => (
                    <div key={i} className="flex justify-between text-sm text-green-400">
                      <span>{d.label}</span>
                      <span>−{fmtPrice(d.amount, cartItems[0]?.product.currency ?? 'INR')}</span>
                    </div>
                  ))}
                  <div className="flex justify-between text-sm font-bold text-green-300 border-t border-white/10 pt-1">
                    <span>Total after discounts</span>
                    <span>{fmtPrice(discountResult.finalTotal, cartItems[0]?.product.currency ?? 'INR')}</span>
                  </div>
                  {discountResult.stackingPolicy && (
                    <p className="text-xs text-white/40 pt-1">
                      Stacking policy: <span className="capitalize">{discountResult.stackingPolicy.replace(/_/g, ' ')}</span>
                    </p>
                  )}
                </div>
              )}
            </div>

            {/* Payment mode selector */}
            <div>
              <p className="text-xs text-muted-foreground uppercase tracking-wider mb-2">Payment Method</p>
              <div className="flex gap-2">
                <button
                  onClick={() => setPaymentMode('razorpay')}
                  className={`flex-1 p-3 rounded-lg border text-sm font-semibold transition-all flex items-center justify-center gap-2 ${paymentMode === 'razorpay' ? 'border-primary bg-primary/10 text-primary' : 'border-white/10 bg-white/5 text-muted-foreground hover:border-white/20'}`}
                >
                  <CreditCard className="w-4 h-4" /> Pay Online
                </button>
                <button
                  onClick={() => setPaymentMode('cod')}
                  className={`flex-1 p-3 rounded-lg border text-sm font-semibold transition-all flex items-center justify-center gap-2 ${paymentMode === 'cod' ? 'border-orange-500 bg-orange-500/10 text-orange-400' : 'border-white/10 bg-white/5 text-muted-foreground hover:border-white/20'}`}
                >
                  <Package className="w-4 h-4" /> Cash on Delivery
                </button>
              </div>
            </div>

            <CheckoutFields />
            <div className="flex gap-3 pt-2">
              <Button onClick={() => doCheckout(cartItems)} disabled={checkingOut} className={`flex-1 text-white gap-2 ${paymentMode === 'cod' ? 'bg-orange-600 hover:bg-orange-700' : 'bg-primary hover:bg-primary/90'}`}>
                {checkingOut
                  ? <><RefreshCw className="w-4 h-4 animate-spin" /> Processing…</>
                  : paymentMode === 'cod'
                    ? <><Package className="w-4 h-4" /> Place COD Order</>
                    : <><CreditCard className="w-4 h-4" /> Pay {cartItems[0] ? fmtPrice((discountResult?.discountTotal ?? 0) > 0 ? discountResult!.finalTotal : cartTotal, cartItems[0].product.currency) : ''}</>
                }
              </Button>
              <Button variant="outline" onClick={() => setCheckoutOpen(false)} className="border-white/10 text-white hover:bg-white/5">Back</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Update Tracking Dialog ───────────────────────────────────────────── */}
      <Dialog open={!!trackingOrder} onOpenChange={o => { if (!o) setTrackingOrder(null); }}>
        <DialogContent className="bg-[#0a1628] border border-white/10 text-white max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Truck className="w-5 h-5 text-emerald-400" /> Update Order — {trackingOrder?.customerName}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 mt-2">
            <div>
              <label className="text-xs text-muted-foreground uppercase tracking-wider">Order Status</label>
              <Select value={trackingForm.status} onValueChange={v => setTrackingForm(f => ({ ...f, status: v }))}>
                <SelectTrigger aria-label="Order Status" className="mt-1 bg-black/40 border-white/10 text-white"><SelectValue /></SelectTrigger>
                <SelectContent className="bg-[#0a1628] border-white/10 text-white">
                  {['pending', 'paid', 'processing', 'shipped', 'delivered', 'cancelled', 'refunded'].map(s => (
                    <SelectItem key={s} value={s} className="text-white hover:bg-white/5 capitalize">{s}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-xs text-muted-foreground uppercase tracking-wider">Tracking Number</label>
              <Input value={trackingForm.trackingNumber} onChange={e => setTrackingForm(f => ({ ...f, trackingNumber: e.target.value }))} placeholder="e.g. SR123456789IN" className="mt-1 bg-black/40 border-white/10 text-white" />
            </div>
            <div>
              <label className="text-xs text-muted-foreground uppercase tracking-wider">Tracking URL (optional)</label>
              <Input value={trackingForm.trackingUrl} onChange={e => setTrackingForm(f => ({ ...f, trackingUrl: e.target.value }))} placeholder="https://shiprocket.co/tracking/..." className="mt-1 bg-black/40 border-white/10 text-white" />
            </div>
            <p className="text-xs text-muted-foreground">Adding a tracking number will automatically email the customer.</p>
            <div className="flex gap-3 pt-1">
              <Button onClick={updateTracking} disabled={updatingTracking} className="flex-1 bg-emerald-700 hover:bg-emerald-800 text-white">
                {updatingTracking ? <><RefreshCw className="w-4 h-4 mr-2 animate-spin" />Saving…</> : 'Save Changes'}
              </Button>
              <Button variant="outline" onClick={() => setTrackingOrder(null)} className="border-white/10 text-white hover:bg-white/5">Cancel</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Write Review Dialog ──────────────────────────────────────────────── */}
      <Dialog open={!!reviewProduct} onOpenChange={o => { if (!o) { setReviewProduct(null); setReviewRating(0); setReviewComment(''); } }}>
        <DialogContent className="bg-[#0a1628] border border-white/10 text-white max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <MessageSquare className="w-5 h-5 text-yellow-400" /> Review: {reviewProduct?.name}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 mt-2">
            <div>
              <label className="text-xs text-muted-foreground uppercase tracking-wider mb-2 block">Your Rating *</label>
              <StarRating rating={reviewRating} interactive onRate={setReviewRating} size="md" />
            </div>
            <div>
              <label className="text-xs text-muted-foreground uppercase tracking-wider">Comment (optional)</label>
              <Textarea value={reviewComment} onChange={e => setReviewComment(e.target.value)} placeholder="Share your experience…" maxLength={500} className="mt-1 bg-black/40 border-white/10 text-white resize-none" rows={4} />
              <p className="text-xs text-muted-foreground mt-1 text-right">{reviewComment.length}/500</p>
            </div>
            <div className="flex gap-3 pt-1">
              <Button onClick={submitReview} disabled={submittingReview || reviewRating === 0} className="flex-1 bg-yellow-500/20 hover:bg-yellow-500/30 text-yellow-400 border border-yellow-500/30">
                {submittingReview ? <><RefreshCw className="w-4 h-4 mr-2 animate-spin" />Submitting…</> : 'Submit Review'}
              </Button>
              <Button variant="outline" onClick={() => { setReviewProduct(null); setReviewRating(0); setReviewComment(''); }} className="border-white/10 text-white hover:bg-white/5">Cancel</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Add Product Dialog ───────────────────────────────────────────────── */}
      <Dialog open={addProductOpen} onOpenChange={setAddProductOpen}>
        <DialogContent className="bg-[#0a1628] border border-white/10 text-white max-w-lg">
          <DialogHeader><DialogTitle>Add Shop Product</DialogTitle></DialogHeader>
          <div className="space-y-4 mt-2 max-h-[70vh] overflow-y-auto pr-1">
            <div><label className="text-xs text-muted-foreground uppercase tracking-wider">Product Name *</label>
              <Input value={productForm.name} onChange={e => setProductForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Club Polo Shirt" className="mt-1 bg-black/40 border-white/10 text-white" /></div>
            <div><label className="text-xs text-muted-foreground uppercase tracking-wider">Category</label>
              <Select value={productForm.category} onValueChange={v => setProductForm(f => ({ ...f, category: v }))}>
                <SelectTrigger aria-label="Category" className="mt-1 bg-black/40 border-white/10 text-white"><SelectValue /></SelectTrigger>
                <SelectContent className="bg-[#0a1628] border-white/10 text-white">
                  {CATEGORIES.filter(c => c !== 'all').map(c => <SelectItem key={c} value={c} className="text-white hover:bg-white/5 capitalize">{c}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div><label className="text-xs text-muted-foreground uppercase tracking-wider">Description</label>
              <Input value={productForm.description} onChange={e => setProductForm(f => ({ ...f, description: e.target.value }))} className="mt-1 bg-black/40 border-white/10 text-white" /></div>
            <div><label className="text-xs text-muted-foreground uppercase tracking-wider">Product Image URL</label>
              <Input value={productForm.imageUrl} onChange={e => setProductForm(f => ({ ...f, imageUrl: e.target.value }))} placeholder="https://..." className="mt-1 bg-black/40 border-white/10 text-white" /></div>
            <div className="flex gap-3">
              <div className="flex-1"><label className="text-xs text-muted-foreground uppercase tracking-wider">Selling Price *</label>
                <Input type="number" value={productForm.markupPrice} onChange={e => setProductForm(f => ({ ...f, markupPrice: e.target.value }))} className="mt-1 bg-black/40 border-white/10 text-white" /></div>
              <div className="w-28"><label className="text-xs text-muted-foreground uppercase tracking-wider">Currency</label>
                <Select value={productForm.currency} onValueChange={v => setProductForm(f => ({ ...f, currency: v }))}>
                  <SelectTrigger aria-label="Currency" className="mt-1 bg-black/40 border-white/10 text-white"><SelectValue /></SelectTrigger>
                  <SelectContent className="bg-[#0a1628] border-white/10 text-white">
                    {['INR', 'USD', 'GBP', 'EUR'].map(c => <SelectItem key={c} value={c} className="text-white hover:bg-white/5">{c}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>
            {/* GST fields */}
            <div className="flex gap-3">
              <div className="flex-1"><label className="text-xs text-muted-foreground uppercase tracking-wider flex items-center gap-1"><Tag className="w-3 h-3" /> HSN Code</label>
                <Input value={productForm.hsnCode} onChange={e => setProductForm(f => ({ ...f, hsnCode: e.target.value }))} placeholder="e.g. 6217" className="mt-1 bg-black/40 border-white/10 text-white placeholder:text-white/30" /></div>
              <div className="w-32"><label className="text-xs text-muted-foreground uppercase tracking-wider">GST Rate %</label>
                <Select value={productForm.gstRate} onValueChange={v => setProductForm(f => ({ ...f, gstRate: v }))}>
                  <SelectTrigger aria-label="GST Rate" className="mt-1 bg-black/40 border-white/10 text-white"><SelectValue /></SelectTrigger>
                  <SelectContent className="bg-[#0a1628] border-white/10 text-white">
                    {GST_RATES.map(r => <SelectItem key={r} value={r} className="text-white hover:bg-white/5">{r}%</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="flex gap-3 pt-2">
              <Button onClick={saveProduct} disabled={saving} className="flex-1 bg-primary hover:bg-primary/90 text-white">{saving ? 'Saving…' : 'Add Product'}</Button>
              <Button variant="outline" onClick={() => setAddProductOpen(false)} className="border-white/10 text-white hover:bg-white/5">Cancel</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Variant Management Dialog ─────────────────────────────────────────── */}
      <Dialog open={!!variantMgmtProductId} onOpenChange={o => { if (!o) setVariantMgmtProductId(null); }}>
        <DialogContent className="bg-[#0a1628] border border-white/10 text-white max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Package className="w-5 h-5 text-primary" /> Manage Variants & Inventory
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 mt-2">
            {/* Existing variants */}
            {managedVariants.length > 0 && (
              <div className="space-y-2 max-h-64 overflow-y-auto">
                {managedVariants.map(v => (
                  <div key={v.id} className="flex items-center gap-3 p-3 bg-white/5 rounded-lg">
                    <div className="flex-1 min-w-0">
                      <p className="text-white text-sm font-medium">{[v.color, v.size].filter(Boolean).join(' / ') || 'Unnamed'}</p>
                      {v.sku && <p className="text-muted-foreground text-xs">SKU: {v.sku}</p>}
                    </div>
                    <div className="flex items-center gap-1">
                      <Button size="sm" variant="ghost" aria-label="Decrease stock" className="h-7 w-7 p-0 text-muted-foreground hover:text-white" onClick={() => updateVariantStock(v.id, -1, v.stockQty)}><Minus className="w-3 h-3" /></Button>
                      <span className="w-10 text-center text-white text-sm font-semibold">{v.stockQty}</span>
                      <Button size="sm" variant="ghost" aria-label="Increase stock" className="h-7 w-7 p-0 text-muted-foreground hover:text-white" onClick={() => updateVariantStock(v.id, 1, v.stockQty)}><Plus className="w-3 h-3" /></Button>
                    </div>
                    <Button size="sm" variant="ghost" aria-label="Delete variant" className="h-7 w-7 p-0 text-red-400/60 hover:text-red-400" onClick={() => deleteVariant(v.id)}>
                      <Trash2 className="w-3 h-3" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
            {managedVariants.length === 0 && (
              <p className="text-muted-foreground text-sm text-center py-4">No variants yet. Add size/colour variants below.</p>
            )}
            {/* Add new variant */}
            <div className="border-t border-white/10 pt-4">
              <p className="text-xs text-muted-foreground uppercase tracking-wider mb-3">Add Variant</p>
              <div className="grid grid-cols-2 gap-2">
                <div><label className="text-xs text-muted-foreground">Colour</label>
                  <Input value={newVariant.color} onChange={e => setNewVariant(v => ({ ...v, color: e.target.value }))} placeholder="e.g. Navy Blue" className="mt-1 bg-black/40 border-white/10 text-white text-sm h-8" /></div>
                <div><label className="text-xs text-muted-foreground">Size</label>
                  <Input value={newVariant.size} onChange={e => setNewVariant(v => ({ ...v, size: e.target.value }))} placeholder="e.g. L, XL" className="mt-1 bg-black/40 border-white/10 text-white text-sm h-8" /></div>
                <div><label className="text-xs text-muted-foreground">Stock Qty</label>
                  <Input type="number" min={0} value={newVariant.stockQty} onChange={e => setNewVariant(v => ({ ...v, stockQty: parseInt(e.target.value) || 0 }))} className="mt-1 bg-black/40 border-white/10 text-white text-sm h-8" /></div>
                <div><label className="text-xs text-muted-foreground">SKU (optional)</label>
                  <Input value={newVariant.sku} onChange={e => setNewVariant(v => ({ ...v, sku: e.target.value }))} placeholder="e.g. POLO-NVY-L" className="mt-1 bg-black/40 border-white/10 text-white text-sm h-8" /></div>
              </div>
              <Button onClick={addVariant} disabled={savingVariant} className="w-full mt-3 bg-primary/20 hover:bg-primary/30 text-primary border border-primary/30 gap-2 text-sm">
                {savingVariant ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />} Add Variant
              </Button>
            </div>
            <Button variant="outline" onClick={() => setVariantMgmtProductId(null)} className="w-full border-white/10 text-white hover:bg-white/5">Done</Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Store Settings Dialog ─────────────────────────────────────────────── */}
      <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
        <DialogContent className="bg-[#0a1628] border border-white/10 text-white max-w-lg">
          <DialogHeader><DialogTitle className="flex items-center gap-2"><Settings className="w-5 h-5 text-primary" /> Store Settings</DialogTitle></DialogHeader>
          <div className="space-y-4 mt-2 max-h-[70vh] overflow-y-auto pr-1">
            <p className="text-xs text-muted-foreground uppercase tracking-wider border-b border-white/10 pb-2">GST & Seller Info</p>
            <div><label className="text-xs text-muted-foreground">GSTIN</label>
              <Input value={storeForm.gstin} onChange={e => setStoreForm(f => ({ ...f, gstin: e.target.value }))} placeholder="22AAAAA0000A1Z5" className="mt-1 bg-black/40 border-white/10 text-white" /></div>
            <div><label className="text-xs text-muted-foreground">Legal Business Name</label>
              <Input value={storeForm.sellerName} onChange={e => setStoreForm(f => ({ ...f, sellerName: e.target.value }))} placeholder="Club Name Pvt. Ltd." className="mt-1 bg-black/40 border-white/10 text-white" /></div>
            <div><label className="text-xs text-muted-foreground">Full Seller Address</label>
              <Input value={storeForm.sellerAddress} onChange={e => setStoreForm(f => ({ ...f, sellerAddress: e.target.value }))} placeholder="123, Golf Road, City, PIN" className="mt-1 bg-black/40 border-white/10 text-white" /></div>
            <div className="flex gap-2">
              <div className="flex-1"><label className="text-xs text-muted-foreground">State</label>
                <Input value={storeForm.sellerState} onChange={e => setStoreForm(f => ({ ...f, sellerState: e.target.value }))} placeholder="Maharashtra" className="mt-1 bg-black/40 border-white/10 text-white" /></div>
              <div className="w-24"><label className="text-xs text-muted-foreground">State Code</label>
                <Input value={storeForm.sellerStateCode} onChange={e => setStoreForm(f => ({ ...f, sellerStateCode: e.target.value }))} placeholder="27" className="mt-1 bg-black/40 border-white/10 text-white" /></div>
            </div>
            <p className="text-xs text-muted-foreground uppercase tracking-wider border-b border-white/10 pb-2 pt-2">Shiprocket Integration</p>
            <div><label className="text-xs text-muted-foreground">Shiprocket Email</label>
              <Input type="email" value={storeForm.shiprocketEmail} onChange={e => setStoreForm(f => ({ ...f, shiprocketEmail: e.target.value }))} placeholder="your@shiprocket.in" className="mt-1 bg-black/40 border-white/10 text-white" /></div>
            <div><label className="text-xs text-muted-foreground">Shiprocket Password</label>
              <Input type="password" value={storeForm.shiprocketPassword} onChange={e => setStoreForm(f => ({ ...f, shiprocketPassword: e.target.value }))} placeholder="Leave blank to keep existing" className="mt-1 bg-black/40 border-white/10 text-white" /></div>
            <p className="text-xs text-muted-foreground">Password is stored encrypted. Leave blank when saving to keep the existing password.</p>
            <div className="flex gap-3 pt-2">
              <Button onClick={saveStoreSettings} disabled={savingStoreSettings} className="flex-1 bg-primary hover:bg-primary/90 text-white">
                {savingStoreSettings ? <><RefreshCw className="w-4 h-4 mr-2 animate-spin" />Saving…</> : 'Save Settings'}
              </Button>
              <Button variant="outline" onClick={() => setSettingsOpen(false)} className="border-white/10 text-white hover:bg-white/5">Cancel</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Return Request Dialog ─────────────────────────────────────────── */}
      <Dialog open={!!returnOrder} onOpenChange={o => { if (!o) setReturnOrder(null); }}>
        <DialogContent className="bg-[#0a1628] border border-white/10 text-white max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-white">
              <RefreshCw className="w-5 h-5 text-orange-400" /> Request Return
            </DialogTitle>
          </DialogHeader>
          {returnOrder && (
            <div className="space-y-4 mt-2">
              <div className="p-3 bg-white/5 rounded-lg">
                <p className="text-white text-sm font-medium">{returnOrder.productName ?? 'Item'}</p>
                <p className="text-muted-foreground text-xs mt-0.5">
                  {returnOrder.size ? `Size: ${returnOrder.size}` : ''}{returnOrder.color ? ` / ${returnOrder.color}` : ''}{' '}× {returnOrder.quantity} · {fmtPrice(returnOrder.totalAmount, returnOrder.currency)}
                </p>
              </div>
              <div>
                <label className="text-xs text-muted-foreground uppercase tracking-wider mb-2 block">Reason *</label>
                <Select value={returnForm.reason} onValueChange={v => setReturnForm(f => ({ ...f, reason: v }))}>
                  <SelectTrigger aria-label="Return reason" className="bg-black/40 border-white/10 text-white">
                    <SelectValue placeholder="Select a reason…" />
                  </SelectTrigger>
                  <SelectContent className="bg-[#0a1628] border-white/10">
                    {[
                      { value: 'wrong_size', label: 'Wrong Size' },
                      { value: 'defective', label: 'Defective / Damaged' },
                      { value: 'changed_mind', label: 'Changed My Mind' },
                      { value: 'wrong_item', label: 'Wrong Item Received' },
                      { value: 'damaged_in_shipping', label: 'Damaged in Shipping' },
                      { value: 'other', label: 'Other' },
                    ].map(opt => (
                      <SelectItem key={opt.value} value={opt.value} className="text-white">{opt.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="text-xs text-muted-foreground uppercase tracking-wider mb-2 block">Resolution Type</label>
                <Select value={returnForm.returnType} onValueChange={v => setReturnForm(f => ({ ...f, returnType: v }))}>
                  <SelectTrigger aria-label="Resolution type" className="bg-black/40 border-white/10 text-white">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="bg-[#0a1628] border-white/10">
                    <SelectItem value="refund" className="text-white">Refund</SelectItem>
                    <SelectItem value="exchange" className="text-white">Exchange for Different Size/Colour</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="text-xs text-muted-foreground uppercase tracking-wider mb-2 block">Additional Details (optional)</label>
                <Textarea
                  value={returnForm.reasonDetail}
                  onChange={e => setReturnForm(f => ({ ...f, reasonDetail: e.target.value }))}
                  placeholder="Describe the issue in detail…"
                  className="bg-black/40 border-white/10 text-white placeholder:text-white/30 text-sm min-h-[80px]"
                />
              </div>
              <p className="text-xs text-muted-foreground">Returns are subject to a 30-day return window and admin review. You will receive a confirmation email once processed.</p>
              <div className="flex gap-2 pt-1">
                <Button onClick={submitReturn} disabled={submittingReturn || !returnForm.reason}
                  className="flex-1 bg-orange-500/20 hover:bg-orange-500/30 text-orange-400 border border-orange-500/30 gap-2">
                  {submittingReturn ? <><RefreshCw className="w-4 h-4 animate-spin" /> Submitting…</> : <><RefreshCw className="w-4 h-4" /> Submit Return Request</>}
                </Button>
                <Button variant="outline" onClick={() => setReturnOrder(null)} className="border-white/10 text-white hover:bg-white/5">Cancel</Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function OrderReviewCta({ orgId, productId, onOpen }: { orgId: number; productId: number; onOpen: () => void }) {
  const { data } = useQuery<{ canReview: boolean }>({
    queryKey: [`/api/organizations/${orgId}/shop/products/${productId}/reviews/can-review`],
    queryFn: () => fetch(`/api/organizations/${orgId}/shop/products/${productId}/reviews/can-review`, { credentials: 'include' }).then(r => { if (!r.ok) throw new Error('Request failed'); return r.json(); }),
    staleTime: 60_000,
  });
  if (!data?.canReview) return null;
  return (
    <button className="text-xs text-yellow-400 hover:text-yellow-300 flex items-center gap-1" onClick={onOpen}>
      <Star className="w-3 h-3" /> Leave a review
    </button>
  );
}

function ProductCard({
  product, isAdmin, isGuest, orgId, inWishlist, reviewAggregate, onOpen, onAddToCart, onToggleWishlist, onToggleActive, onManageVariants,
}: {
  product: ShopProduct; isAdmin: boolean; isGuest: boolean; orgId: number | undefined; inWishlist: boolean;
  reviewAggregate?: { avgRating: number; totalCount: number };
  onOpen: () => void; onAddToCart: () => void;
  onToggleWishlist: (e: React.MouseEvent) => void; onToggleActive: () => void;
  onManageVariants: () => void;
}) {
  return (
    <Card className={`glass-card overflow-hidden cursor-pointer group transition-all hover:border-primary/30 ${!product.isActive ? 'opacity-60' : ''}`} onClick={onOpen}>
      <div className="aspect-square bg-white/5 relative overflow-hidden">
        {product.imageUrl ? (
          <img src={product.imageUrl} alt={product.name} className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300" />
        ) : (
          <div className="w-full h-full flex items-center justify-center"><Package className="w-16 h-16 text-white/20" /></div>
        )}
        {!product.isActive && (
          <div className="absolute inset-0 bg-black/60 flex items-center justify-center">
            <Badge className="bg-gray-500/40 text-gray-300 border-gray-500/30">Hidden</Badge>
          </div>
        )}
        <Badge className="absolute top-2 left-2 bg-black/60 text-white border-white/10 text-xs capitalize">{product.category}</Badge>
        {(() => {
          const now = Date.now();
          const isFlash = product.salePrice &&
            (!product.saleStart || new Date(product.saleStart).getTime() <= now) &&
            (!product.saleEnd || new Date(product.saleEnd).getTime() >= now);
          return isFlash ? (
            <Badge className="absolute bottom-2 left-2 bg-red-600 text-white border-red-500 text-[10px] font-bold animate-pulse">SALE</Badge>
          ) : null;
        })()}
        {product.gstRate && (
          <div className="absolute top-2 right-2 bg-black/60 border border-white/10 rounded px-1.5 py-0.5 text-[10px] font-semibold text-green-300">
            GST {product.gstRate}%
          </div>
        )}
        {!isAdmin && (
          <button className="absolute bottom-2 right-2 p-1.5 rounded-full bg-black/60 hover:bg-red-500/30 transition-colors opacity-0 group-hover:opacity-100" onClick={onToggleWishlist}>
            <Heart className={`w-4 h-4 transition-colors ${inWishlist ? 'fill-red-400 text-red-400' : 'text-white/70'}`} />
          </button>
        )}
      </div>
      <CardContent className="p-4">
        <h3 className="font-semibold text-white text-sm leading-tight">{product.name}</h3>
        {product.hsnCode && <p className="text-muted-foreground text-[11px] mt-0.5">HSN: {product.hsnCode}</p>}
        {product.description && <p className="text-muted-foreground text-xs mt-1 line-clamp-2">{product.description}</p>}
        {reviewAggregate && reviewAggregate.totalCount > 0 && (
          <div className="flex items-center gap-1.5 mt-1.5">
            <StarRating rating={Math.round(reviewAggregate.avgRating)} />
            <span className="text-yellow-400 text-xs font-semibold">{reviewAggregate.avgRating.toFixed(1)}</span>
            <span className="text-muted-foreground text-xs">({reviewAggregate.totalCount})</span>
          </div>
        )}
        <div className="flex items-center justify-between mt-2">
          {(() => {
            const now = Date.now();
            const isFlash = product.salePrice &&
              (!product.saleStart || new Date(product.saleStart).getTime() <= now) &&
              (!product.saleEnd || new Date(product.saleEnd).getTime() >= now);
            return isFlash ? (
              <div className="flex flex-col gap-0.5">
                <div className="flex items-center gap-1.5">
                  <PriceWithFx orgId={orgId ?? null} amount={product.salePrice!} currency={product.currency} bookedClassName="text-red-400 font-bold" showDisclosure={false} disclosureOnHover />
                  <span className="text-muted-foreground text-xs line-through">{fmtPrice(product.markupPrice, product.currency)}</span>
                </div>
              </div>
            ) : (
              <PriceWithFx orgId={orgId ?? null} amount={product.markupPrice} currency={product.currency} bookedClassName="text-primary font-bold" showDisclosure={false} disclosureOnHover />
            );
          })()}
          <ChevronRight className="w-4 h-4 text-muted-foreground group-hover:text-primary transition-colors" />
        </div>
        <div className="flex gap-2 mt-3">
          <Button onClick={e => { e.stopPropagation(); if (product.isActive) onAddToCart(); }} disabled={!product.isActive} className="flex-1 bg-primary hover:bg-primary/90 text-white text-xs h-8 gap-1">
            <ShoppingCart className="w-3.5 h-3.5" /> Add to Cart
          </Button>
          {isAdmin && (
            <>
              <Button size="sm" variant="outline" onClick={e => { e.stopPropagation(); onToggleActive(); }} className="border-white/10 text-white hover:bg-white/5 h-8 px-2" title={product.isActive ? 'Hide' : 'Publish'}>
                {product.isActive ? <X className="w-3.5 h-3.5" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
              </Button>
              <Button size="sm" variant="outline" onClick={e => { e.stopPropagation(); onManageVariants(); }} className="border-white/10 text-white hover:bg-white/5 h-8 px-2" title="Manage variants">
                <Edit2 className="w-3.5 h-3.5" />
              </Button>
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function ProductDetailModal({
  product, detailSize, setDetailSize, detailColor, setDetailColor, detailVariantId, setDetailVariantId,
  isGuest, orgId, inWishlist, onToggleWishlist, onAddToCart, onBuyNow, onWriteReview,
}: {
  product: ShopProduct; detailSize: string; setDetailSize: (s: string) => void;
  detailColor: string; setDetailColor: (c: string) => void;
  detailVariantId: number | null; setDetailVariantId: (id: number | null) => void;
  isGuest: boolean; orgId: number | undefined; inWishlist: boolean;
  onToggleWishlist: (e: React.MouseEvent) => void;
  onAddToCart: () => void; onBuyNow: () => void; onWriteReview: () => void;
}) {
  const [reviewPage, setReviewPage] = useState(1);
  const REVIEW_PAGE_SIZE = 5;
  const { toast } = useToast();

  // Notify Me (waitlist) state
  const [showNotifyForm, setShowNotifyForm] = useState(false);
  const [notifyEmail, setNotifyEmail] = useState("");
  const [notifyName, setNotifyName] = useState("");
  const [notifySubmitted, setNotifySubmitted] = useState(false);

  const notifyMutation = useMutation({
    mutationFn: async () => {
      if (!orgId) throw new Error("No org");
      const r = await fetch(`/api/organizations/${orgId}/shop/products/${product.id}/waitlist`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          variantId: detailVariantId ?? null,
          email: notifyEmail,
          name: notifyName || undefined,
        }),
      });
      if (!r.ok) { const e = await r.json(); throw new Error(e.error ?? "Failed"); }
      return r.json();
    },
    onSuccess: () => {
      setNotifySubmitted(true);
      setShowNotifyForm(false);
      toast({ title: "You're on the list!", description: "We'll email you when this item is back in stock." });
    },
    onError: (e: Error) => toast({ title: "Could not join waitlist", description: e.message, variant: "destructive" }),
  });

  const { data: variants = [] } = useQuery<ProductVariant[]>({
    queryKey: [`/api/organizations/${orgId}/shop/products/${product.id}/variants`],
    queryFn: () => fetch(`/api/organizations/${orgId}/shop/products/${product.id}/variants`).then(r => r.ok ? r.json() : []),
    enabled: !!orgId,
  });

  const colors = [...new Set(variants.filter(v => v.color).map(v => v.color!))];
  const sizesForColor = variants.filter(v => !detailColor || v.color === detailColor || !v.color).map(v => v.size).filter(Boolean) as string[];
  const uniqueSizes = [...new Set(sizesForColor)];

  const selectedVariant = variants.find(v =>
    (v.color === detailColor || (!detailColor && !v.color)) &&
    (v.size === detailSize || (!detailSize && !v.size))
  ) ?? null;

  useEffect(() => {
    if (selectedVariant) setDetailVariantId(selectedVariant.id);
    else setDetailVariantId(null);
  }, [selectedVariant, setDetailVariantId]);

  const inStock = selectedVariant ? selectedVariant.stockQty > 0 : variants.length === 0 || variants.some(v => v.stockQty > 0);

  const { data: canReviewData } = useQuery<{ canReview: boolean; reason?: string }>({
    queryKey: [`/api/organizations/${orgId}/shop/products/${product.id}/reviews/can-review`],
    queryFn: () => fetch(`/api/organizations/${orgId}/shop/products/${product.id}/reviews/can-review`, { credentials: 'include' }).then(r => { if (!r.ok) throw new Error('Request failed'); return r.json(); }),
    enabled: !!orgId && !isGuest,
    staleTime: 60 * 1000,
  });
  const canReview = !isGuest && canReviewData?.canReview === true;

  const { data: reviewData } = useQuery<ReviewSummary>({
    queryKey: [`/api/organizations/${orgId}/shop/products/${product.id}/reviews`, reviewPage],
    queryFn: () => fetch(`/api/organizations/${orgId}/shop/products/${product.id}/reviews?page=${reviewPage}&limit=${REVIEW_PAGE_SIZE}`).then(r => { if (!r.ok) throw new Error('Request failed'); return r.json(); }),
    enabled: !!orgId,
    staleTime: 2 * 60 * 1000,
  });

  return (
    <>
      <DialogHeader>
        <div className="flex items-center justify-between">
          <DialogTitle className="text-lg flex items-center gap-2">
            <Package className="w-5 h-5 text-primary" /> {product.name}
          </DialogTitle>
          {!isGuest && (
            <button className="p-2 rounded-full hover:bg-white/10 transition-colors mr-6" onClick={onToggleWishlist}>
              <Heart className={`w-5 h-5 transition-colors ${inWishlist ? 'fill-red-400 text-red-400' : 'text-white/60 hover:text-red-400'}`} />
            </button>
          )}
        </div>
      </DialogHeader>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 mt-2">
        <div className="aspect-square bg-white/5 rounded-xl overflow-hidden">
          {product.imageUrl
            ? <img src={product.imageUrl} alt={product.name} className="w-full h-full object-cover" />
            : <div className="w-full h-full flex items-center justify-center"><Package className="w-20 h-20 text-white/20" /></div>
          }
        </div>
        <div className="space-y-4">
          <div>
            <Badge className="bg-black/40 border-white/10 text-white text-xs capitalize mb-2">{product.category}</Badge>
            {product.description && <p className="text-muted-foreground text-sm leading-relaxed">{product.description}</p>}
          </div>
          <div className="text-2xl font-bold text-primary">
            <PriceWithFx orgId={orgId ?? null} amount={product.markupPrice} currency={product.currency} bookedClassName="text-primary" />
          </div>
          {product.hsnCode && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Tag className="w-3 h-3" /> HSN: {product.hsnCode}
              {product.gstRate && <span className="text-green-400"> · GST {product.gstRate}%</span>}
            </div>
          )}
          {reviewData && reviewData.totalCount > 0 && (
            <div className="flex items-center gap-2">
              <StarRating rating={Math.round(reviewData.avgRating ?? 0)} />
              <span className="text-white text-xs font-semibold">{reviewData.avgRating?.toFixed(1)}</span>
              <span className="text-muted-foreground text-xs">({reviewData.totalCount} review{reviewData.totalCount !== 1 ? 's' : ''})</span>
            </div>
          )}

          {/* Color picker */}
          {colors.length > 0 && (
            <div>
              <p className="text-xs text-muted-foreground uppercase tracking-wider mb-2">Select Colour</p>
              <div className="flex flex-wrap gap-2">
                {colors.map(c => (
                  <button key={c} onClick={() => { setDetailColor(c); setDetailSize(''); }}
                    className={`px-3 py-1.5 rounded-lg text-sm font-semibold border transition-all ${detailColor === c ? 'bg-primary/20 border-primary text-primary' : 'bg-white/5 border-white/10 text-muted-foreground hover:border-white/30'}`}>
                    {c}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Size picker */}
          {(uniqueSizes.length > 0 || product.sizes?.length > 0) && (
            <div>
              <p className="text-xs text-muted-foreground uppercase tracking-wider mb-2">Select Size</p>
              <div className="flex flex-wrap gap-2">
                {(uniqueSizes.length > 0 ? uniqueSizes : product.sizes ?? []).map(s => {
                  const variantForSize = variants.find(v => v.size === s && (v.color === detailColor || !detailColor || !v.color));
                  const isOutOfStock = variantForSize ? variantForSize.stockQty === 0 : false;
                  return (
                    <button key={s} onClick={() => setDetailSize(s)} disabled={isOutOfStock}
                      className={`px-4 py-2 rounded-lg text-sm font-semibold border transition-all relative ${isOutOfStock ? 'opacity-40 cursor-not-allowed bg-white/5 border-white/5 text-white/40' : detailSize === s ? 'bg-primary/20 border-primary text-primary' : 'bg-white/5 border-white/10 text-muted-foreground hover:border-white/30'}`}>
                      {s}
                      {isOutOfStock && <span className="absolute -top-1.5 -right-1.5 text-[8px] bg-red-500/80 text-white px-0.5 rounded">Out</span>}
                    </button>
                  );
                })}
              </div>
              {selectedVariant && selectedVariant.stockQty > 0 && selectedVariant.stockQty <= 5 && (
                <p className="text-orange-400 text-xs mt-1">Only {selectedVariant.stockQty} left!</p>
              )}
            </div>
          )}

          <div className="flex gap-2 pt-2">
            {inStock ? (
              <>
                <Button onClick={onAddToCart} disabled={!product.isActive} className="flex-1 bg-primary hover:bg-primary/90 text-white gap-2">
                  <ShoppingCart className="w-4 h-4" /> Add to Cart
                </Button>
                <Button onClick={onBuyNow} disabled={!product.isActive} variant="outline" className="border-white/10 text-white hover:bg-white/5 gap-2">
                  <CreditCard className="w-4 h-4" /> Buy Now
                </Button>
              </>
            ) : notifySubmitted ? (
              <div className="flex-1 flex items-center gap-2 text-emerald-400 text-sm p-2 bg-emerald-500/10 rounded-md border border-emerald-500/20">
                <CheckCircle2 className="w-4 h-4" /> You'll be notified when back in stock.
              </div>
            ) : (
              <div className="flex-1 space-y-2">
                <div className="text-amber-400 text-xs flex items-center gap-1">
                  <Package className="w-3.5 h-3.5" /> Out of Stock — get notified when available
                </div>
                {showNotifyForm ? (
                  <div className="space-y-2">
                    <Input
                      placeholder="Your email"
                      type="email"
                      value={notifyEmail}
                      onChange={e => setNotifyEmail(e.target.value)}
                      className="bg-white/5 border-white/10 text-white text-sm h-8"
                    />
                    <Input
                      placeholder="Your name (optional)"
                      value={notifyName}
                      onChange={e => setNotifyName(e.target.value)}
                      className="bg-white/5 border-white/10 text-white text-sm h-8"
                    />
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        className="flex-1 bg-amber-500 hover:bg-amber-400 text-white"
                        onClick={() => notifyMutation.mutate()}
                        disabled={!notifyEmail || notifyMutation.isPending}
                      >
                        {notifyMutation.isPending ? "Saving…" : "Notify Me"}
                      </Button>
                      <Button size="sm" variant="ghost" className="text-white/50" onClick={() => setShowNotifyForm(false)}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : (
                  <Button
                    variant="outline"
                    className="w-full border-amber-500/40 text-amber-400 hover:bg-amber-500/10 gap-2"
                    onClick={() => setShowNotifyForm(true)}
                  >
                    <Bell className="w-4 h-4" /> Notify Me When Available
                  </Button>
                )}
              </div>
            )}
          </div>
          {canReview && (
            <Button variant="outline" size="sm" className="w-full border-yellow-500/30 text-yellow-400 hover:bg-yellow-500/10 gap-1.5" onClick={onWriteReview}>
              <Star className="w-3.5 h-3.5" /> Write a Review
            </Button>
          )}
        </div>
      </div>

      {/* Reviews section */}
      {reviewData && reviewData.totalCount > 0 && (
        <div className="mt-6 border-t border-white/5 pt-4">
          <h4 className="text-white font-semibold text-sm mb-3 flex items-center gap-2">
            <MessageSquare className="w-4 h-4 text-yellow-400" /> Customer Reviews ({reviewData.totalCount})
          </h4>
          <div className="space-y-3">
            {reviewData.reviews.map(r => (
              <div key={r.id} className="p-3 bg-white/5 rounded-lg">
                <div className="flex items-center justify-between mb-1">
                  <StarRating rating={r.rating} />
                  <span className="text-muted-foreground text-xs">{new Date(r.createdAt).toLocaleDateString()}</span>
                </div>
                {r.reviewerName && <p className="text-xs text-primary/80 font-semibold mb-1">{r.reviewerName}</p>}
                {r.comment && <p className="text-muted-foreground text-xs leading-relaxed">{r.comment}</p>}
              </div>
            ))}
          </div>
          {reviewData.totalCount > REVIEW_PAGE_SIZE && (
            <div className="flex items-center justify-between mt-4 pt-3 border-t border-white/5">
              <Button variant="outline" size="sm" disabled={reviewPage <= 1} onClick={() => setReviewPage(p => Math.max(1, p - 1))} className="border-white/10 text-white hover:bg-white/5 text-xs h-7">← Previous</Button>
              <span className="text-xs text-muted-foreground">Page {reviewPage} of {Math.ceil(reviewData.totalCount / REVIEW_PAGE_SIZE)}</span>
              <Button variant="outline" size="sm" disabled={reviewPage >= Math.ceil(reviewData.totalCount / REVIEW_PAGE_SIZE)} onClick={() => setReviewPage(p => p + 1)} className="border-white/10 text-white hover:bg-white/5 text-xs h-7">Next →</Button>
            </div>
          )}
        </div>
      )}
    </>
  );
}
