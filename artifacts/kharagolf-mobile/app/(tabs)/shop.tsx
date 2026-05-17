import { Feather } from "@expo/vector-icons";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import React, { useState, useMemo, useCallback, useEffect } from "react";
import {
  Alert,
  FlatList,
  Linking,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  Image,
  TouchableOpacity,
} from "react-native";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Colors from "@/constants/colors";
import { useAuth } from "@/context/auth";
import { PriceWithFx } from "@/components/PriceWithFx";
import { ShopCartTotalRow } from "@/components/ShopCartTotalRow";
import { BASE_URL, FeatureGateError } from "@/utils/api";
import UpgradePrompt from "@/components/UpgradePrompt";
import { StripeCheckoutModal, stripeModuleAvailable } from "@/components/StripeCheckoutModal";
import { getLocale } from "@/i18n";
import { useTranslation } from "react-i18next";

let RazorpayCheckout: {
  open: (opts: RzpOptions) => Promise<RzpSuccess>;
} | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  RazorpayCheckout = require("react-native-razorpay").default;
} catch {
  RazorpayCheckout = null;
}

interface RzpOptions {
  key: string;
  order_id: string;
  amount: number;
  currency: string;
  name: string;
  description: string;
  prefill?: { name?: string; email?: string; contact?: string };
}
interface RzpSuccess {
  razorpay_payment_id: string;
  razorpay_order_id: string;
  razorpay_signature: string;
}

interface ShopProduct {
  id: number;
  name: string;
  description: string | null;
  imageUrl: string | null;
  category: string;
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

interface WishlistItem {
  wishlistId: number;
  createdAt: string;
  product: ShopProduct;
}

interface ReviewAggregate {
  avgRating: number;
  totalCount: number;
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

interface MyOrder {
  id: number;
  productId: number | null;
  status: string;
  productName: string | null;
  productImage: string | null;
  totalAmount: string;
  currency: string;
  size: string | null;
  color: string | null;
  quantity: number;
  paymentMode: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  awbCode: string | null;
  invoicePath: string | null;
  createdAt: string;
}

const CURRENCY_SYMBOLS: Record<string, string> = {
  INR: "₹", USD: "$", GBP: "£", EUR: "€", AED: "د.إ",
};

const fmtPrice = (price: string, currency: string) =>
  `${CURRENCY_SYMBOLS[currency] ?? currency}${parseFloat(price).toLocaleString(getLocale(), { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

const CATEGORY_LABELS: Record<string, string> = {
  apparel: "Apparel", headwear: "Headwear", accessories: "Accessories",
  drinkware: "Drinkware", bags: "Bags", other: "Other",
};

function StarRow({ rating, size = 14, interactive = false, onRate }: {
  rating: number; size?: number; interactive?: boolean; onRate?: (r: number) => void;
}) {
  return (
    <View style={{ flexDirection: "row", gap: 2 }}>
      {[1, 2, 3, 4, 5].map(i => (
        <TouchableOpacity
          key={i}
          onPress={() => interactive && onRate?.(i)}
          disabled={!interactive}
          activeOpacity={interactive ? 0.7 : 1}
        >
          <Feather
            name="star"
            size={size}
            color={i <= rating ? "#facc15" : "#374151"}
          />
        </TouchableOpacity>
      ))}
    </View>
  );
}

type TabType = "products" | "saved" | "orders";

export default function ShopScreen() {
  const insets = useSafeAreaInsets();
  const isWeb = Platform.OS === "web";
  const topPadding = isWeb ? 67 : insets.top;

  const { isAuthenticated, token, user } = useAuth();
  const orgId: number | undefined = user?.organizationId;
  const queryClient = useQueryClient();
  const { t } = useTranslation("shop");

  const [activeTab, setActiveTab] = useState<TabType>("products");
  const [checkoutProduct, setCheckoutProduct] = useState<ShopProduct | null>(null);

  // ── MULTI-ITEM CART ──────────────────────────────────────────────────────────
  type CartItem = {
    localId: string; productId: number; variantId: number | null;
    productName: string; price: number; currency: string;
    size?: string; color?: string; quantity: number; imageUrl: string | null;
  };
  const [cart, setCart] = useState<CartItem[]>([]);
  const [showCart, setShowCart] = useState(false);
  const [cartCheckoutMode, setCartCheckoutMode] = useState(false);

  const addToCart = useCallback((product: ShopProduct, size?: string, color?: string, variantId?: number | null) => {
    if (!isAuthenticated) {
      Alert.alert("Sign In Required", "Please sign in to add items to your cart.");
      return;
    }
    const localId = `${product.id}-${variantId ?? 'nv'}-${size ?? ''}-${color ?? ''}`;
    setCart(prev => {
      const existing = prev.find(c => c.localId === localId);
      if (existing) return prev.map(c => c.localId === localId ? { ...c, quantity: c.quantity + 1 } : c);
      return [...prev, {
        localId, productId: product.id, variantId: variantId ?? null,
        productName: product.name, price: parseFloat(product.markupPrice),
        currency: product.currency, size, color, quantity: 1, imageUrl: product.imageUrl,
      }];
    });
    setDetailProduct(null);
    Alert.alert(t("addToCart"), `${product.name} ${t("add")}.`, [
      { text: t("cancel"), style: "cancel" },
      { text: t("tabCart"), onPress: () => setShowCart(true) },
    ]);
  }, [isAuthenticated]);

  const cartTotal = cart.reduce((sum, c) => sum + c.price * c.quantity, 0);
  const cartCount = cart.reduce((sum, c) => sum + c.quantity, 0);
  const [detailProduct, setDetailProduct] = useState<ShopProduct | null>(null);
  const [detailSelectedColor, setDetailSelectedColor] = useState("");
  const [detailSelectedSize, setDetailSelectedSize] = useState("");
  const [checkoutForm, setCheckoutForm] = useState({
    size: "", color: "", customerName: "", customerEmail: "", customerPhone: "",
    line1: "", city: "", state: "", pincode: "", country: "IN",
  });
  const [selectedVariantId, setSelectedVariantId] = useState<number | null>(null);
  const [paymentMode, setPaymentMode] = useState<"razorpay" | "cod">("razorpay");
  const [buying, setBuying] = useState(false);
  const [stripeCheckout, setStripeCheckout] = useState<{
    publishableKey: string; clientSecret: string; paymentIntentId: string; merchantDisplayName: string;
  } | null>(null);
  const [checkoutPromoCode, setCheckoutPromoCode] = useState("");
  const [checkoutAffiliateCode, setCheckoutAffiliateCode] = useState("");
  const [checkoutLoyaltyPoints, setCheckoutLoyaltyPoints] = useState(0);
  const [checkoutDiscounts, setCheckoutDiscounts] = useState<Array<{ label: string; amount: number }> | null>(null);
  const [checkoutDiscountTotal, setCheckoutDiscountTotal] = useState(0);
  const [checkoutFinalTotal, setCheckoutFinalTotal] = useState<number | null>(null);
  const [checkoutStackingPolicy, setCheckoutStackingPolicy] = useState<string | null>(null);
  const [togglingWishlist, setTogglingWishlist] = useState<number | null>(null);

  // Review state
  const [reviewProduct, setReviewProduct] = useState<ShopProduct | null>(null);
  const [reviewRating, setReviewRating] = useState(0);
  const [reviewComment, setReviewComment] = useState("");
  const [submittingReview, setSubmittingReview] = useState(false);
  const [detailReviewPage, setDetailReviewPage] = useState(1);

  // Return request state
  const [returnOrder, setReturnOrder] = useState<MyOrder | null>(null);
  const [returnReason, setReturnReason] = useState("");
  const [returnType, setReturnType] = useState<"refund" | "exchange">("refund");
  const [returnDetail, setReturnDetail] = useState("");
  const [submittingReturn, setSubmittingReturn] = useState(false);

  // Plan-gate state: shown when the club's plan doesn't include a feature
  const [featureGate, setFeatureGate] = useState<{
    message: string;
    currentTier: string;
    requiredTier: string;
  } | null>(null);
  const DETAIL_REVIEW_PAGE_SIZE = 5;

  const authHeaders: Record<string, string> = { "Content-Type": "application/json" };
  if (token) authHeaders["Authorization"] = `Bearer ${token}`;

  const { data: products = [], isLoading, refetch, isRefetching } = useQuery<ShopProduct[]>({
    queryKey: ["shop-products", orgId],
    queryFn: async () => {
      if (!orgId) return [];
      const res = await fetch(`${BASE_URL}/api/organizations/${orgId}/shop/products`);
      if (!res.ok) return [];
      return res.json() as Promise<ShopProduct[]>;
    },
    enabled: !!orgId,
    staleTime: 2 * 60 * 1000,
  });

  const { data: reviewAggregates = {} } = useQuery<Record<number, ReviewAggregate>>({
    queryKey: ["shop-review-aggregates", orgId],
    queryFn: async () => {
      if (!orgId) return {};
      const res = await fetch(`${BASE_URL}/api/organizations/${orgId}/shop/review-aggregates`);
      if (!res.ok) return {};
      return res.json() as Promise<Record<number, ReviewAggregate>>;
    },
    enabled: !!orgId,
    staleTime: 5 * 60 * 1000,
  });

  const { data: wishlistIds = [] } = useQuery<number[]>({
    queryKey: ["shop-wishlist-ids", orgId],
    queryFn: async () => {
      if (!orgId || !isAuthenticated) return [];
      const res = await fetch(`${BASE_URL}/api/organizations/${orgId}/shop/wishlist/ids`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) return [];
      return res.json() as Promise<number[]>;
    },
    enabled: !!orgId && isAuthenticated,
    staleTime: 60 * 1000,
  });

  const { data: wishlist = [], isLoading: wishlistLoading, refetch: refetchWishlist } = useQuery<WishlistItem[]>({
    queryKey: ["shop-wishlist", orgId],
    queryFn: async () => {
      if (!orgId || !isAuthenticated) return [];
      const res = await fetch(`${BASE_URL}/api/organizations/${orgId}/shop/wishlist`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) return [];
      return res.json() as Promise<WishlistItem[]>;
    },
    enabled: !!orgId && isAuthenticated,
    staleTime: 60 * 1000,
  });

  const { data: myOrders = [], isLoading: ordersLoading, refetch: refetchOrders } = useQuery<MyOrder[]>({
    queryKey: ["shop-my-orders", orgId],
    queryFn: async () => {
      if (!orgId || !isAuthenticated) return [];
      const res = await fetch(`${BASE_URL}/api/organizations/${orgId}/shop/my-orders`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) return [];
      return res.json() as Promise<MyOrder[]>;
    },
    enabled: !!orgId && isAuthenticated,
    staleTime: 60 * 1000,
  });

  interface MyReturn { id: number; orderId: number | null; reason: string; status: string; returnType: string; refundAmount: string | null; currency: string; fraudFlag: boolean; createdAt: string; resolvedAt: string | null; }
  const { data: myReturns = [], refetch: refetchReturns } = useQuery<MyReturn[]>({
    queryKey: ["shop-my-returns", orgId],
    queryFn: async () => {
      if (!orgId || !isAuthenticated) return [];
      const res = await fetch(`${BASE_URL}/api/organizations/${orgId}/shop/my-returns`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) return [];
      return res.json() as Promise<MyReturn[]>;
    },
    enabled: !!orgId && isAuthenticated,
    staleTime: 60 * 1000,
  });
  const myReturnsByOrderId = Object.fromEntries(myReturns.map(r => [r.orderId, r]));

  // Reviews for detail product (paginated)
  const { data: detailReviews } = useQuery<ReviewSummary>({
    queryKey: ["shop-product-reviews", orgId, detailProduct?.id, detailReviewPage],
    queryFn: async () => {
      if (!orgId || !detailProduct) return { avgRating: null, totalCount: 0, page: 1, limit: DETAIL_REVIEW_PAGE_SIZE, reviews: [] };
      const res = await fetch(`${BASE_URL}/api/organizations/${orgId}/shop/products/${detailProduct.id}/reviews?page=${detailReviewPage}&limit=${DETAIL_REVIEW_PAGE_SIZE}`);
      if (!res.ok) return { avgRating: null, totalCount: 0, page: 1, limit: DETAIL_REVIEW_PAGE_SIZE, reviews: [] };
      return res.json() as Promise<ReviewSummary>;
    },
    enabled: !!orgId && !!detailProduct,
    staleTime: 2 * 60 * 1000,
  });

  // Server-side can-review check for detail product (includes "already reviewed" detection)
  const { data: canReviewData } = useQuery<{ canReview: boolean; reason?: string }>({
    queryKey: ["shop-can-review", orgId, detailProduct?.id],
    queryFn: async () => {
      if (!orgId || !detailProduct || !isAuthenticated) return { canReview: false };
      const res = await fetch(`${BASE_URL}/api/organizations/${orgId}/shop/products/${detailProduct.id}/reviews/can-review`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) return { canReview: false };
      return res.json() as Promise<{ canReview: boolean; reason?: string }>;
    },
    enabled: !!orgId && !!detailProduct && isAuthenticated,
    staleTime: 60 * 1000,
  });

  const { data: loyaltyMe } = useQuery<{ account: { pointsBalance: number } } | null>({
    queryKey: ["shop-loyalty-me", orgId],
    queryFn: async () => {
      if (!orgId || !isAuthenticated) return null;
      const res = await fetch(`${BASE_URL}/api/organizations/${orgId}/loyalty/me`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) return null;
      return res.json();
    },
    enabled: !!orgId && isAuthenticated,
    staleTime: 60 * 1000,
  });
  const loyaltyPointsBalance = loyaltyMe?.account?.pointsBalance ?? 0;

  // Variants for detail product
  const { data: detailVariants = [] } = useQuery<ProductVariant[]>({
    queryKey: ["shop-variants", orgId, detailProduct?.id],
    queryFn: async () => {
      if (!orgId || !detailProduct) return [];
      const res = await fetch(`${BASE_URL}/api/organizations/${orgId}/shop/products/${detailProduct.id}/variants`);
      if (!res.ok) return [];
      return res.json() as Promise<ProductVariant[]>;
    },
    enabled: !!orgId && !!detailProduct,
    staleTime: 60 * 1000,
  });

  // Variants for checkout product
  const { data: checkoutVariants = [] } = useQuery<ProductVariant[]>({
    queryKey: ["shop-variants", orgId, checkoutProduct?.id],
    queryFn: async () => {
      if (!orgId || !checkoutProduct) return [];
      const res = await fetch(`${BASE_URL}/api/organizations/${orgId}/shop/products/${checkoutProduct.id}/variants`);
      if (!res.ok) return [];
      return res.json() as Promise<ProductVariant[]>;
    },
    enabled: !!orgId && !!checkoutProduct,
    staleTime: 60 * 1000,
  });

  // Review prompts for authenticated users
  const { data: reviewPrompts = [], refetch: refetchPrompts } = useQuery<ReviewPrompt[]>({
    queryKey: ["shop-review-prompts", orgId],
    queryFn: async () => {
      if (!orgId || !isAuthenticated) return [];
      const res = await fetch(`${BASE_URL}/api/organizations/${orgId}/shop/review-prompts`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) return [];
      return res.json() as Promise<ReviewPrompt[]>;
    },
    enabled: !!orgId && isAuthenticated,
    staleTime: 2 * 60 * 1000,
  });

  // Reset review page and variant selection when product changes
  useEffect(() => {
    setDetailReviewPage(1);
    setDetailSelectedColor("");
    setDetailSelectedSize("");
  }, [detailProduct?.id]);

  const wishlistIdSet = useMemo(() => new Set(wishlistIds), [wishlistIds]);
  const canReviewDetailProduct = isAuthenticated && !!detailProduct && canReviewData?.canReview === true;

  const toggleWishlist = useCallback(async (productId: number) => {
    if (!isAuthenticated) {
      Alert.alert("Sign In Required", "Please sign in to save items to your wishlist.");
      return;
    }
    if (!orgId) return;
    setTogglingWishlist(productId);
    try {
      const inWishlist = wishlistIdSet.has(productId);
      if (inWishlist) {
        await fetch(`${BASE_URL}/api/organizations/${orgId}/shop/wishlist/${productId}`, {
          method: "DELETE",
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
      } else {
        await fetch(`${BASE_URL}/api/organizations/${orgId}/shop/wishlist`, {
          method: "POST",
          headers: authHeaders,
          body: JSON.stringify({ productId }),
        });
      }
      queryClient.invalidateQueries({ queryKey: ["shop-wishlist-ids", orgId] });
      queryClient.invalidateQueries({ queryKey: ["shop-wishlist", orgId] });
    } catch {
      Alert.alert("Error", "Could not update wishlist. Please try again.");
    } finally {
      setTogglingWishlist(null);
    }
  }, [isAuthenticated, orgId, wishlistIdSet, token, queryClient]);

  const dismissPrompt = async (prompt: ReviewPrompt) => {
    if (!orgId) return;
    try {
      await fetch(`${BASE_URL}/api/organizations/${orgId}/shop/review-prompts/${prompt.id}/dismiss`, {
        method: "POST",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      queryClient.invalidateQueries({ queryKey: ["shop-review-prompts", orgId] });
    } catch {
      // silent — just refresh
      refetchPrompts();
    }
  };

  const submitReview = async () => {
    if (!reviewProduct || reviewRating === 0) {
      Alert.alert("Rating Required", "Please select a star rating."); return;
    }
    if (!orgId) return;
    setSubmittingReview(true);
    try {
      const res = await fetch(`${BASE_URL}/api/organizations/${orgId}/shop/products/${reviewProduct.id}/reviews`, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ rating: reviewRating, comment: reviewComment.trim() || undefined }),
      });
      if (res.status === 409) {
        Alert.alert("Already Reviewed", "You have already submitted a review for this product."); return;
      }
      if (!res.ok) {
        const d = await res.json() as { error?: string };
        Alert.alert("Error", d.error ?? "Could not submit review."); return;
      }
      const submittedProduct = reviewProduct;
      setReviewProduct(null);
      setReviewRating(0);
      setReviewComment("");
      queryClient.invalidateQueries({ queryKey: ["shop-review-aggregates", orgId] });
      queryClient.invalidateQueries({ queryKey: ["shop-product-reviews", orgId, submittedProduct.id] });
      queryClient.invalidateQueries({ queryKey: ["shop-can-review", orgId, submittedProduct.id] });
      queryClient.invalidateQueries({ queryKey: ["shop-review-prompts", orgId] });
      Alert.alert("Thank You!", "Your review has been submitted.");
    } catch {
      Alert.alert("Error", "Network error. Please try again.");
    } finally {
      setSubmittingReview(false);
    }
  };

  const submitReturn = async () => {
    if (!returnOrder || !returnReason || !orgId) {
      Alert.alert("Incomplete", "Please select a reason for your return."); return;
    }
    setSubmittingReturn(true);
    try {
      const res = await fetch(`${BASE_URL}/api/organizations/${orgId}/shop/returns`, {
        method: "POST",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ orderId: returnOrder.id, reason: returnReason, reasonDetail: returnDetail.trim() || undefined, returnType }),
      });
      const data = await res.json() as { error?: string; flagged?: boolean };
      if (!res.ok) { Alert.alert("Error", data.error ?? "Could not submit return request."); return; }
      setReturnOrder(null);
      setReturnReason("");
      setReturnDetail("");
      setReturnType("refund");
      refetchReturns();
      Alert.alert(data.flagged ? "Return Submitted — Under Review" : "Return Submitted", data.flagged ? "Your return has been flagged for manual review. We will contact you shortly." : "Your return request has been submitted. We will process it and get back to you.");
    } catch {
      Alert.alert("Error", "Network error. Please try again.");
    } finally {
      setSubmittingReturn(false);
    }
  };

  const openCheckout = (product: ShopProduct, preSize?: string, preColor?: string) => {
    if (!isAuthenticated) {
      Alert.alert("Sign In Required", "Please sign in to your player portal to purchase items.");
      return;
    }
    setDetailProduct(null);
    setCheckoutForm(f => ({ ...f, size: preSize ?? product.sizes?.[0] ?? "", color: preColor ?? "" }));
    setSelectedVariantId(null);
    setPaymentMode("razorpay");
    setCheckoutPromoCode("");
    setCheckoutAffiliateCode("");
    setCheckoutLoyaltyPoints(0);
    setCheckoutDiscounts(null);
    setCheckoutDiscountTotal(0);
    setCheckoutStackingPolicy(null);
    setCheckoutProduct(product);
  };

  const handleBuy = async () => {
    if (!checkoutProduct || !orgId) return;
    if (!checkoutForm.customerName || !checkoutForm.customerEmail) {
      Alert.alert("Required Fields", "Please enter your name and email address."); return;
    }
    if (!checkoutForm.line1 || !checkoutForm.city || !checkoutForm.state || !checkoutForm.pincode) {
      Alert.alert("Shipping Address", "Please fill in your full delivery address."); return;
    }

    const shippingAddress = {
      line1: checkoutForm.line1,
      city: checkoutForm.city,
      state: checkoutForm.state,
      pincode: checkoutForm.pincode,
      country: checkoutForm.country || "IN",
    };

    const itemPayload = {
      items: cartCheckoutMode ? cart.map(c => ({
        productId: c.productId,
        variantId: c.variantId ?? undefined,
        size: c.size || undefined,
        color: c.color || undefined,
        quantity: c.quantity,
      })) : [{
        productId: checkoutProduct.id,
        variantId: selectedVariantId ?? undefined,
        size: checkoutForm.size || undefined,
        color: checkoutForm.color || undefined,
        quantity: 1,
      }],
      customerName: checkoutForm.customerName,
      customerEmail: checkoutForm.customerEmail,
      customerPhone: checkoutForm.customerPhone || undefined,
      shippingAddress,
      promoCode: checkoutPromoCode.trim() || undefined,
      affiliateCode: checkoutAffiliateCode.trim() || undefined,
      loyaltyPointsToRedeem: checkoutLoyaltyPoints > 0 ? checkoutLoyaltyPoints : undefined,
    };

    setBuying(true);
    try {
      if (paymentMode === "cod") {
        const codRes = await fetch(`${BASE_URL}/api/organizations/${orgId}/shop/orders/cod`, {
          method: "POST", headers: authHeaders, body: JSON.stringify(itemPayload),
        });
        const codData = await codRes.json() as { ok?: boolean; orderIds?: number[]; error?: string };
        if (!codRes.ok) {
          Alert.alert("Order Error", codData.error ?? "Could not place COD order. Try again."); return;
        }
        setCheckoutProduct(null);
        if (cartCheckoutMode) { setCart([]); setCartCheckoutMode(false); }
        queryClient.invalidateQueries({ queryKey: ["shop-my-orders", orgId] });
        Alert.alert("COD Order Placed!", cartCheckoutMode ? `Your cart order (${cartCount} items) has been placed. Pay on delivery.` : `Your order for ${checkoutProduct.name} has been placed. Pay on delivery.`);
        return;
      }

      const initiateRes = await fetch(`${BASE_URL}/api/organizations/${orgId}/shop/orders/initiate-cart`, {
        method: "POST", headers: authHeaders, body: JSON.stringify(itemPayload),
      });

      type InitiateCartResponse = {
        orderIds?: number[]; razorpayOrderId?: string; amount?: number; currency?: string; keyId?: string; error?: string;
        processor?: "razorpay" | "stripe";
        clientSecret?: string;
        stripePublishableKey?: string;
        discounts?: Array<{ type: string; label: string; amount: number }>;
        discountTotal?: number;
        finalTotal?: number;
        stackingPolicy?: string;
        featureGate?: { currentTier?: string; requiredTier?: string; message?: string };
      };
      const orderData = await initiateRes.json() as InitiateCartResponse;

      if (orderData.discounts && orderData.discounts.length > 0) {
        setCheckoutDiscounts(orderData.discounts.map(d => ({ label: d.label, amount: d.amount })));
        setCheckoutDiscountTotal(orderData.discountTotal ?? 0);
        setCheckoutFinalTotal(orderData.finalTotal ?? null);
        setCheckoutStackingPolicy(orderData.stackingPolicy ?? null);
      } else {
        setCheckoutDiscounts(null);
        setCheckoutDiscountTotal(0);
        setCheckoutFinalTotal(null);
        setCheckoutStackingPolicy(null);
      }

      if (initiateRes.status === 402 && orderData.featureGate) {
        const fg = (orderData as { featureGate: { currentTier: string; requiredTier: string; message: string } }).featureGate;
        setFeatureGate({ message: fg.message, currentTier: fg.currentTier, requiredTier: fg.requiredTier });
        setCheckoutProduct(null);
        return;
      }

      // ── Stripe path (non-INR clubs) ──────────────────────────────────
      if (orderData.processor === "stripe") {
        if (!orderData.stripePublishableKey || !orderData.clientSecret) {
          Alert.alert("Payment Error", "Stripe checkout is missing required configuration."); return;
        }
        if (!stripeModuleAvailable) {
          setCheckoutProduct(null);
          Alert.alert(
            "Payment",
            "Card payments require a production build. Please visit the club website to complete your purchase.",
            [
              { text: "Cancel", style: "cancel" },
              { text: "Open Website", onPress: () => Linking.openURL(`${BASE_URL}/shop`).catch(() => {}) },
            ],
          );
          return;
        }
        setStripeCheckout({
          publishableKey: orderData.stripePublishableKey,
          clientSecret: orderData.clientSecret,
          paymentIntentId: orderData.razorpayOrderId ?? "",
          merchantDisplayName: cartCheckoutMode ? "Club Shop" : checkoutProduct.name,
        });
        return;
      }

      if (!initiateRes.ok || !orderData.razorpayOrderId) {
        Alert.alert("Order Error", orderData.error ?? "Could not create order. Try again."); return;
      }

      if (RazorpayCheckout) {
        const opts: RzpOptions = {
          key: orderData.keyId!,
          order_id: orderData.razorpayOrderId,
          amount: orderData.amount!,
          currency: orderData.currency!,
          name: "Club Shop",
          description: checkoutProduct.name,
          prefill: { name: checkoutForm.customerName, email: checkoutForm.customerEmail, contact: checkoutForm.customerPhone || undefined },
        };

        const payment = await RazorpayCheckout.open(opts);

        const verifyRes = await fetch(`${BASE_URL}/api/organizations/${orgId}/shop/orders/verify-cart`, {
          method: "POST", headers: authHeaders,
          body: JSON.stringify({
            razorpay_payment_id: payment.razorpay_payment_id,
            razorpay_order_id: payment.razorpay_order_id,
            razorpay_signature: payment.razorpay_signature,
          }),
        });

        if (verifyRes.ok) {
          setCheckoutProduct(null);
          if (cartCheckoutMode) { setCart([]); setCartCheckoutMode(false); }
          queryClient.invalidateQueries({ queryKey: ["shop-my-orders", orgId] });
          Alert.alert("Order Placed!", cartCheckoutMode ? `Your cart order (${cartCount} items) has been confirmed! Check My Orders for tracking.` : `Your order for ${checkoutProduct.name} has been confirmed. You'll receive an email shortly.`);
        } else {
          const vd = await verifyRes.json() as { error?: string };
          Alert.alert("Verification Failed", vd.error ?? "Payment received but verification failed. Contact the club.");
        }
      } else {
        setCheckoutProduct(null);
        Alert.alert(
          "Payment",
          "Native checkout requires a production build. Please visit the club website to complete your purchase.",
          [
            { text: "Cancel", style: "cancel" },
            { text: "Open Website", onPress: () => Linking.openURL(`${BASE_URL}/shop`).catch(() => {}) },
          ],
        );
      }
    } catch (err: unknown) {
      const msg = err !== null && typeof err === "object" && "message" in err
        ? String((err as { message: unknown }).message)
        : "Network error. Please try again.";
      if (msg.toLowerCase().includes("cancel")) return;
      Alert.alert("Error", msg);
    } finally {
      setBuying(false);
    }
  };

  const activeProducts = products.filter(p => p.isActive);

  const renderProductCard = ({ item }: { item: ShopProduct }) => {
    const inWishlist = wishlistIdSet.has(item.id);
    const toggling = togglingWishlist === item.id;
    const agg = reviewAggregates[item.id];
    return (
      <Pressable
        style={({ pressed }) => [styles.productCard, { opacity: pressed ? 0.85 : 1 }]}
        onPress={() => setDetailProduct(item)}
      >
        <View style={styles.productImageContainer}>
          {item.imageUrl ? (
            <Image source={{ uri: item.imageUrl }} style={styles.productImage} resizeMode="cover" />
          ) : (
            <View style={styles.productImagePlaceholder}>
              <Feather name="package" size={32} color={Colors.muted} />
            </View>
          )}
          <View style={styles.categoryBadge}>
            <Text style={styles.categoryBadgeText}>{CATEGORY_LABELS[item.category] ?? item.category}</Text>
          </View>
          <TouchableOpacity
            style={styles.heartBtn}
            onPress={() => toggleWishlist(item.id)}
            disabled={toggling}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Feather
              name="heart"
              size={16}
              color={inWishlist ? "#f87171" : "rgba(255,255,255,0.7)"}
            />
          </TouchableOpacity>
        </View>
        <View style={styles.productInfo}>
          <Text style={styles.productName} numberOfLines={2}>{item.name}</Text>
          {item.description ? (
            <Text style={styles.productDesc} numberOfLines={1}>{item.description}</Text>
          ) : null}
          {agg && agg.totalCount > 0 && (
            <View style={styles.ratingRow}>
              <StarRow rating={Math.round(agg.avgRating)} size={11} />
              <Text style={styles.ratingText}>{agg.avgRating.toFixed(1)} ({agg.totalCount})</Text>
            </View>
          )}
          <View style={styles.productFooter}>
            {(() => {
              const now = Date.now();
              const isFlash = item.salePrice &&
                (!item.saleStart || new Date(item.saleStart).getTime() <= now) &&
                (!item.saleEnd || new Date(item.saleEnd).getTime() >= now);
              return isFlash ? (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <View style={styles.saleBadge}><Text style={styles.saleBadgeText}>{t("sale")}</Text></View>
                  <PriceWithFx
                    orgId={orgId}
                    token={token}
                    amount={item.salePrice!}
                    currency={item.currency}
                    productClass="shop"
                    bookedStyle={styles.salePrice}
                    showDisclosure={false}
                    disclosureOnHover
                  />
                  <Text style={[styles.productPrice, { textDecorationLine: 'line-through', opacity: 0.5, fontSize: 10 }]}>{fmtPrice(item.markupPrice, item.currency)}</Text>
                </View>
              ) : (
                <PriceWithFx
                  orgId={orgId}
                  token={token}
                  amount={item.markupPrice}
                  currency={item.currency}
                  productClass="shop"
                  bookedStyle={styles.productPrice}
                  showDisclosure={false}
                  disclosureOnHover
                />
              );
            })()}
            <Pressable
              style={({ pressed }) => [styles.buyBtn, { opacity: pressed ? 0.8 : 1 }]}
              onPress={() => addToCart(item)}
            >
              <Feather name="shopping-cart" size={12} color="#fff" />
              <Text style={styles.buyBtnText}>{t("add")}</Text>
            </Pressable>
          </View>
          {item.sizes && item.sizes.length > 0 && (
            <View style={styles.sizesRow}>
              {item.sizes.slice(0, 4).map(s => (
                <View key={s} style={styles.sizeChip}>
                  <Text style={styles.sizeChipText}>{s}</Text>
                </View>
              ))}
              {item.sizes.length > 4 && <Text style={styles.moreSizes}>+{item.sizes.length - 4}</Text>}
            </View>
          )}
        </View>
      </Pressable>
    );
  };

  const renderWishlistCard = ({ item }: { item: WishlistItem }) => {
    const p = item.product;
    const agg = reviewAggregates[p.id];
    return (
      <Pressable
        style={({ pressed }) => [styles.productCard, { opacity: pressed ? 0.85 : 1 }]}
        onPress={() => setDetailProduct(p)}
      >
        <View style={styles.productImageContainer}>
          {p.imageUrl ? (
            <Image source={{ uri: p.imageUrl }} style={styles.productImage} resizeMode="cover" />
          ) : (
            <View style={styles.productImagePlaceholder}>
              <Feather name="package" size={32} color={Colors.muted} />
            </View>
          )}
          <View style={styles.categoryBadge}>
            <Text style={styles.categoryBadgeText}>{CATEGORY_LABELS[p.category] ?? p.category}</Text>
          </View>
          <TouchableOpacity
            style={styles.heartBtn}
            onPress={() => toggleWishlist(p.id)}
            disabled={togglingWishlist === p.id}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Feather name="heart" size={16} color="#f87171" />
          </TouchableOpacity>
        </View>
        <View style={styles.productInfo}>
          <Text style={styles.productName} numberOfLines={2}>{p.name}</Text>
          {agg && agg.totalCount > 0 && (
            <View style={styles.ratingRow}>
              <StarRow rating={Math.round(agg.avgRating)} size={11} />
              <Text style={styles.ratingText}>{agg.avgRating.toFixed(1)} ({agg.totalCount})</Text>
            </View>
          )}
          <View style={styles.productFooter}>
            <PriceWithFx
              orgId={orgId}
              token={token}
              amount={p.markupPrice}
              currency={p.currency}
              productClass="shop"
              bookedStyle={styles.productPrice}
              showDisclosure={false}
              disclosureOnHover
            />
            <Pressable
              style={({ pressed }) => [styles.buyBtn, { opacity: pressed ? 0.8 : 1 }]}
              onPress={() => addToCart(p)}
            >
              <Feather name="shopping-cart" size={12} color="#fff" />
              <Text style={styles.buyBtnText}>{t("add")}</Text>
            </Pressable>
          </View>
        </View>
      </Pressable>
    );
  };

  const finalizeStripeOrder = useCallback(async (paymentIntentId: string) => {
    try {
      const verifyRes = await fetch(`${BASE_URL}/api/organizations/${orgId}/shop/orders/verify-cart`, {
        method: "POST", headers: authHeaders,
        body: JSON.stringify({ stripe_payment_intent_id: paymentIntentId }),
      });
      if (verifyRes.ok) {
        setCheckoutProduct(null);
        if (cartCheckoutMode) { setCart([]); setCartCheckoutMode(false); }
        queryClient.invalidateQueries({ queryKey: ["shop-my-orders", orgId] });
        Alert.alert("Order Placed!", "Your order has been confirmed. You'll receive an email shortly.");
      } else {
        const vd = await verifyRes.json().catch(() => ({})) as { error?: string };
        Alert.alert("Verification Failed", vd.error ?? "Payment received but verification failed. Contact the club.");
      }
    } finally {
      setStripeCheckout(null);
    }
  }, [orgId, authHeaders, cartCheckoutMode, queryClient]);

  return (
    <View style={[styles.container, { paddingTop: topPadding }]}>
      {stripeCheckout && (
        <StripeCheckoutModal
          visible
          publishableKey={stripeCheckout.publishableKey}
          clientSecret={stripeCheckout.clientSecret}
          merchantDisplayName={stripeCheckout.merchantDisplayName}
          onSuccess={(intentId) => { void finalizeStripeOrder(intentId); }}
          onCancel={() => { setStripeCheckout(null); }}
          onError={(msg) => { setStripeCheckout(null); Alert.alert("Payment Error", msg); }}
        />
      )}
      <View style={styles.header}>
        <View>
          <Text style={styles.headerTitle}>{t("title")}</Text>
          <Text style={styles.headerSubtitle}>{t("subtitle")}</Text>
        </View>
        <Pressable onPress={() => { refetch(); refetchWishlist(); }} style={styles.refreshBtn} disabled={isRefetching}>
          <Feather name="refresh-cw" size={18} color={isRefetching ? Colors.muted : Colors.primary} />
        </Pressable>
      </View>

      {/* Plan upgrade prompt — shown when the club's plan gates a feature */}
      {featureGate && (
        <UpgradePrompt
          message={featureGate.message}
          currentTier={featureGate.currentTier}
          requiredTier={featureGate.requiredTier}
          upgradeUrl={`${BASE_URL}/admin?tab=billing`}
          onDismiss={() => setFeatureGate(null)}
        />
      )}

      {/* Tab bar */}
      <View style={styles.tabBar}>
        <TouchableOpacity style={[styles.tab, activeTab === "products" && styles.tabActive]} onPress={() => setActiveTab("products")}>
          <Feather name="shopping-bag" size={15} color={activeTab === "products" ? Colors.primary : Colors.textSecondary} />
          <Text style={[styles.tabText, activeTab === "products" && styles.tabTextActive]}>{t("tabProducts")}</Text>
        </TouchableOpacity>
        {isAuthenticated && (
          <TouchableOpacity style={[styles.tab, activeTab === "saved" && styles.tabActive]} onPress={() => setActiveTab("saved")}>
            <Feather name="heart" size={15} color={activeTab === "saved" ? "#f87171" : Colors.textSecondary} />
            <Text style={[styles.tabText, activeTab === "saved" && styles.tabTextSaved]}>
              {wishlist.length > 0 ? t("tabSavedCount", { count: wishlist.length }) : t("tabSaved")}
            </Text>
          </TouchableOpacity>
        )}
        {isAuthenticated && (
          <TouchableOpacity style={[styles.tab, activeTab === "orders" && styles.tabActive]} onPress={() => setActiveTab("orders")}>
            <Feather name="package" size={15} color={activeTab === "orders" ? Colors.primary : Colors.textSecondary} />
            <Text style={[styles.tabText, activeTab === "orders" && styles.tabTextActive]}>
              {myOrders.length > 0 ? t("tabOrdersCount", { count: myOrders.length }) : t("tabOrders")}
            </Text>
          </TouchableOpacity>
        )}
        {/* Cart button with badge */}
        <TouchableOpacity style={styles.tab} onPress={() => setShowCart(true)}>
          <View style={{ position: 'relative' }}>
            <Feather name="shopping-cart" size={15} color={cartCount > 0 ? Colors.primary : Colors.textSecondary} />
            {cartCount > 0 && (
              <View style={styles.cartBadge}>
                <Text style={styles.cartBadgeText}>{cartCount > 9 ? "9+" : cartCount}</Text>
              </View>
            )}
          </View>
          <Text style={[styles.tabText, cartCount > 0 && styles.tabTextActive]}>
            {cartCount > 0 ? t("tabCartCount", { count: cartCount }) : t("tabCart")}
          </Text>
        </TouchableOpacity>
      </View>

      {/* Review prompts banner */}
      {isAuthenticated && reviewPrompts.length > 0 && (
        <View style={styles.promptBanner}>
          <Feather name="star" size={14} color="#facc15" style={{ marginRight: 6 }} />
          <View style={{ flex: 1 }}>
            <Text style={styles.promptTitle}>{t("reviewPromptTitle")}</Text>
            <Text style={styles.promptSubtitle} numberOfLines={1}>
              {reviewPrompts[0].productName}
            </Text>
          </View>
          <TouchableOpacity
            onPress={() => {
              const p = products.find(pr => pr.id === reviewPrompts[0].productId);
              if (p) { setReviewProduct(p); setReviewRating(0); setReviewComment(""); }
            }}
            style={styles.promptWriteBtn}
          >
            <Text style={styles.promptWriteBtnText}>{t("writeReview")}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => dismissPrompt(reviewPrompts[0])}
            style={{ padding: 4, marginLeft: 4 }}
          >
            <Feather name="x" size={14} color={Colors.textSecondary} />
          </TouchableOpacity>
        </View>
      )}

      {/* Products Tab */}
      {activeTab === "products" && (
        isLoading ? (
          <View style={styles.center}>
            <LoadingSpinner color={Colors.primary} size="large" />
            <Text style={styles.loadingText}>{t("loadingShop")}</Text>
          </View>
        ) : !orgId ? (
          <View style={styles.center}>
            <Feather name="shopping-bag" size={48} color={Colors.muted} />
            <Text style={styles.emptyTitle}>{t("shopUnavailable")}</Text>
            <Text style={styles.emptySubtitle}>{t("shopUnavailableSub")}</Text>
          </View>
        ) : activeProducts.length === 0 ? (
          <View style={styles.center}>
            <Feather name="shopping-bag" size={48} color={Colors.muted} />
            <Text style={styles.emptyTitle}>{t("noProducts")}</Text>
            <Text style={styles.emptySubtitle}>{t("noProductsSub")}</Text>
          </View>
        ) : (
          <FlatList
            data={activeProducts}
            keyExtractor={item => String(item.id)}
            numColumns={2}
            columnWrapperStyle={styles.row}
            contentContainerStyle={styles.listContent}
            refreshing={isRefetching}
            onRefresh={refetch}
            renderItem={renderProductCard}
          />
        )
      )}

      {/* Saved (Wishlist) Tab */}
      {activeTab === "saved" && isAuthenticated && (
        wishlistLoading ? (
          <View style={styles.center}>
            <LoadingSpinner color={Colors.primary} size="large" />
            <Text style={styles.loadingText}>{t("loadingWishlist")}</Text>
          </View>
        ) : wishlist.length === 0 ? (
          <View style={styles.center}>
            <Feather name="heart" size={48} color={Colors.muted} />
            <Text style={styles.emptyTitle}>{t("noSaved")}</Text>
            <Text style={styles.emptySubtitle}>{t("noSavedSub")}</Text>
          </View>
        ) : (
          <FlatList
            data={wishlist}
            keyExtractor={item => String(item.wishlistId)}
            numColumns={2}
            columnWrapperStyle={styles.row}
            contentContainerStyle={styles.listContent}
            refreshing={wishlistLoading}
            onRefresh={refetchWishlist}
            renderItem={renderWishlistCard}
          />
        )
      )}

      {/* My Orders Tab */}
      {activeTab === "orders" && isAuthenticated && (
        ordersLoading ? (
          <View style={styles.center}>
            <LoadingSpinner color={Colors.primary} size="large" />
            <Text style={styles.loadingText}>{t("loadingOrders")}</Text>
          </View>
        ) : myOrders.length === 0 ? (
          <View style={styles.center}>
            <Feather name="package" size={48} color={Colors.muted} />
            <Text style={styles.emptyTitle}>{t("noOrders")}</Text>
            <Text style={styles.emptySubtitle}>{t("noOrdersSub")}</Text>
          </View>
        ) : (
          <FlatList
            data={myOrders}
            keyExtractor={item => String(item.id)}
            contentContainerStyle={[styles.listContent, { paddingHorizontal: 16 }]}
            refreshing={ordersLoading}
            onRefresh={refetchOrders}
            renderItem={({ item: order }) => {
              const statusColors: Record<string, string> = {
                paid: "#16a34a", pending: "#ca8a04", cod_pending: "#ca8a04",
                shipped: Colors.primary, delivered: "#16a34a", cancelled: "#dc2626",
              };
              const color = statusColors[order.status] ?? Colors.textSecondary;
              const label = order.status === "cod_pending" ? "COD Pending" : order.status.charAt(0).toUpperCase() + order.status.slice(1);
              return (
                <View style={styles.orderCard}>
                  <View style={styles.orderCardRow}>
                    {order.productImage ? (
                      <Image source={{ uri: order.productImage }} style={styles.orderImage} resizeMode="cover" />
                    ) : (
                      <View style={[styles.orderImage, styles.orderImagePlaceholder]}>
                        <Feather name="package" size={18} color={Colors.muted} />
                      </View>
                    )}
                    <View style={{ flex: 1, marginLeft: 12 }}>
                      <Text style={styles.orderProductName} numberOfLines={2}>{order.productName ?? "Product"}</Text>
                      <View style={{ flexDirection: "row", gap: 6, marginTop: 4, flexWrap: "wrap" }}>
                        {order.color && <Text style={styles.orderVariantChip}>{order.color}</Text>}
                        {order.size && <Text style={styles.orderVariantChip}>{order.size}</Text>}
                        {order.paymentMode === "cod" && (
                          <View style={styles.codBadge}><Text style={styles.codBadgeText}>COD</Text></View>
                        )}
                      </View>
                      <Text style={{ color, fontSize: 12, fontWeight: "700", marginTop: 4 }}>{label}</Text>
                    </View>
                    <View style={{ alignItems: "flex-end" }}>
                      <Text style={styles.orderAmount}>₹{parseFloat(order.totalAmount).toFixed(0)}</Text>
                      <Text style={styles.orderDate}>{new Date(order.createdAt).toLocaleDateString(getLocale(), { day: "2-digit", month: "short" })}</Text>
                    </View>
                  </View>
                  {(order.awbCode || order.invoicePath) && (
                    <View style={styles.orderTrackRow}>
                      {order.awbCode && (
                        <>
                          <Feather name="truck" size={12} color={Colors.primary} />
                          <Text style={styles.orderAwb}>AWB: {order.awbCode}</Text>
                          {order.trackingUrl && (
                            <TouchableOpacity onPress={() => Linking.openURL(order.trackingUrl!).catch(() => {})}>
                              <Text style={styles.orderTrackLink}>{t("track")}</Text>
                            </TouchableOpacity>
                          )}
                        </>
                      )}
                      {order.invoicePath && orgId && (
                        <TouchableOpacity
                          onPress={() => Linking.openURL(`${BASE_URL}/api/organizations/${orgId}/shop/orders/${order.id}/invoice`).catch(() => {})}
                          style={{ marginLeft: order.awbCode ? 8 : 0 }}
                        >
                          <Text style={styles.orderTrackLink}>
                            <Feather name="file-text" size={11} /> {t("invoice")}
                          </Text>
                        </TouchableOpacity>
                      )}
                    </View>
                  )}
                  {/* Return request / status row */}
                  {["paid", "shipped", "delivered"].includes(order.status) && (() => {
                    const existingReturn = myReturnsByOrderId[order.id];
                    if (existingReturn) {
                      const returnStatusColor: Record<string, string> = {
                        pending: "#ca8a04", flagged: "#ea580c", received: "#0891b2",
                        approved: "#2563eb", refunded: "#16a34a", rejected: "#dc2626", exchanged: "#9333ea",
                      };
                      return (
                        <View style={[styles.orderTrackRow, { marginTop: 4 }]}>
                          <Feather name="refresh-cw" size={11} color={returnStatusColor[existingReturn.status] ?? Colors.muted} />
                          <Text style={{ fontSize: 11, color: returnStatusColor[existingReturn.status] ?? Colors.muted, marginLeft: 4 }}>
                            {t("returnLabel", { status: existingReturn.status })}
                          </Text>
                        </View>
                      );
                    }
                    return (
                      <TouchableOpacity
                        style={[styles.orderTrackRow, { marginTop: 6 }]}
                        onPress={() => { setReturnOrder(order); setReturnReason(""); setReturnDetail(""); setReturnType("refund"); }}
                        activeOpacity={0.7}
                      >
                        <Feather name="refresh-cw" size={11} color={Colors.muted} />
                        <Text style={{ fontSize: 11, color: Colors.muted, marginLeft: 4 }}>{t("requestReturn")}</Text>
                      </TouchableOpacity>
                    );
                  })()}
                </View>
              );
            }}
          />
        )
      )}

      {/* Product Detail Modal */}
      <Modal visible={!!detailProduct} animationType="slide" transparent>
        <View style={styles.modalOverlay}>
          <View style={styles.modalContainer}>
            <View style={styles.modalHeader}>
              <Text style={[styles.modalTitle, { flex: 1 }]} numberOfLines={1}>{detailProduct?.name ?? ""}</Text>
              {detailProduct && (
                <Pressable onPress={() => toggleWishlist(detailProduct.id)} style={{ marginRight: 12 }}>
                  <Feather
                    name="heart"
                    size={20}
                    color={wishlistIdSet.has(detailProduct.id) ? "#ef4444" : Colors.muted}
                  />
                </Pressable>
              )}
              <Pressable onPress={() => setDetailProduct(null)}>
                <Feather name="x" size={22} color={Colors.text} />
              </Pressable>
            </View>

            {detailProduct && (
              <ScrollView style={styles.modalBody} showsVerticalScrollIndicator={false}>
                {detailProduct.imageUrl && (
                  <Image source={{ uri: detailProduct.imageUrl }} style={styles.detailImage} resizeMode="cover" />
                )}

                <View style={styles.detailInfo}>
                  <PriceWithFx
                    orgId={orgId}
                    token={token}
                    amount={detailProduct.markupPrice}
                    currency={detailProduct.currency}
                    productClass="shop"
                    bookedStyle={styles.detailPrice}
                  />

                  {/* Aggregate star rating */}
                  {detailReviews && detailReviews.totalCount > 0 && (
                    <View style={styles.detailRatingRow}>
                      <StarRow rating={Math.round(detailReviews.avgRating ?? 0)} size={16} />
                      <Text style={styles.detailRatingText}>
                        {detailReviews.avgRating?.toFixed(1)} · {detailReviews.totalCount} review{detailReviews.totalCount !== 1 ? "s" : ""}
                      </Text>
                    </View>
                  )}

                  {detailProduct.description ? (
                    <Text style={styles.detailDesc}>{detailProduct.description}</Text>
                  ) : null}

                  {/* Variant Picker in detail modal */}
                  {detailVariants.length > 0 ? (() => {
                    const colors = Array.from(new Set(detailVariants.filter(v => v.color).map(v => v.color!)));
                    const sizes = Array.from(new Set(
                      detailVariants
                        .filter(v => v.size && (!detailSelectedColor || v.color === detailSelectedColor))
                        .map(v => v.size!)
                    ));
                    return (
                      <>
                        {colors.length > 0 && (
                          <View style={[styles.formSection, { marginTop: 10 }]}>
                            <Text style={styles.formLabel}>COLOUR</Text>
                            <View style={styles.sizePicker}>
                              {colors.map(c => (
                                <Pressable key={c} onPress={() => { setDetailSelectedColor(c); setDetailSelectedSize(""); }}
                                  style={[styles.sizePickerItem, detailSelectedColor === c && styles.sizePickerItemActive]}>
                                  <Text style={[styles.sizePickerText, detailSelectedColor === c && styles.sizePickerTextActive]}>{c}</Text>
                                </Pressable>
                              ))}
                            </View>
                          </View>
                        )}
                        {sizes.length > 0 && (
                          <View style={styles.formSection}>
                            <Text style={styles.formLabel}>SIZE</Text>
                            <View style={styles.sizePicker}>
                              {sizes.map(s => {
                                const v = detailVariants.find(vv => vv.size === s && (!detailSelectedColor || vv.color === detailSelectedColor));
                                const outOfStock = v ? v.stockQty <= 0 : false;
                                return (
                                  <Pressable key={s} onPress={() => { if (!outOfStock) setDetailSelectedSize(s); }}
                                    style={[styles.sizePickerItem, detailSelectedSize === s && styles.sizePickerItemActive, outOfStock && { opacity: 0.4 }]}>
                                    <Text style={[styles.sizePickerText, detailSelectedSize === s && styles.sizePickerTextActive]}>{s}{outOfStock ? " ✕" : ""}</Text>
                                  </Pressable>
                                );
                              })}
                            </View>
                          </View>
                        )}
                      </>
                    );
                  })() : detailProduct.sizes && detailProduct.sizes.length > 0 ? (
                    <View style={[styles.formSection, { marginTop: 10 }]}>
                      <Text style={styles.formLabel}>SIZE</Text>
                      <View style={styles.sizePicker}>
                        {detailProduct.sizes.map(s => (
                          <Pressable key={s} onPress={() => setDetailSelectedSize(s)}
                            style={[styles.sizePickerItem, detailSelectedSize === s && styles.sizePickerItemActive]}>
                            <Text style={[styles.sizePickerText, detailSelectedSize === s && styles.sizePickerTextActive]}>{s}</Text>
                          </Pressable>
                        ))}
                      </View>
                    </View>
                  ) : null}

                  {/* Buy / Add to Cart buttons */}
                  <View style={{ flexDirection: 'row', gap: 8, marginTop: 12 }}>
                    <Pressable
                      style={({ pressed }) => [styles.payBtn, { flex: 1, opacity: pressed ? 0.8 : 1, backgroundColor: '#2a2a2a', borderWidth: 1, borderColor: Colors.primary }]}
                      onPress={() => addToCart(detailProduct, detailSelectedSize || undefined, detailSelectedColor || undefined, selectedVariantId)}
                    >
                      <Feather name="plus-circle" size={15} color={Colors.primary} style={{ marginRight: 6 }} />
                      <Text style={[styles.payBtnText, { color: Colors.primary }]}>{t("addToCart")}</Text>
                    </Pressable>
                    <Pressable
                      style={({ pressed }) => [styles.payBtn, { flex: 1, opacity: pressed ? 0.8 : 1 }]}
                      onPress={() => openCheckout(detailProduct, detailSelectedSize || undefined, detailSelectedColor || undefined)}
                    >
                      <Feather name="shopping-cart" size={15} color="#fff" style={{ marginRight: 6 }} />
                      <Text style={styles.payBtnText}>{t("buyNow")}</Text>
                    </Pressable>
                  </View>

                  {/* Write Review button (for eligible users) */}
                  {canReviewDetailProduct && (
                    <Pressable
                      style={({ pressed }) => [styles.reviewBtn, { opacity: pressed ? 0.8 : 1 }]}
                      onPress={() => { setReviewProduct(detailProduct); setReviewRating(0); setReviewComment(""); }}
                    >
                      <Feather name="star" size={15} color="#facc15" style={{ marginRight: 6 }} />
                      <Text style={styles.reviewBtnText}>Write a Review</Text>
                    </Pressable>
                  )}
                </View>

                {/* Customer Reviews Section */}
                {detailReviews && detailReviews.totalCount > 0 && (
                  <View style={styles.reviewsSection}>
                    <Text style={styles.reviewsSectionTitle}>
                      Customer Reviews ({detailReviews.totalCount})
                    </Text>
                    {detailReviews.reviews.map(r => (
                      <View key={r.id} style={styles.reviewCard}>
                        <View style={styles.reviewCardHeader}>
                          <StarRow rating={r.rating} size={12} />
                          <Text style={styles.reviewDate}>{new Date(r.createdAt).toLocaleDateString()}</Text>
                        </View>
                        {r.reviewerName && <Text style={styles.reviewerName}>{r.reviewerName}</Text>}
                        {r.comment && <Text style={styles.reviewComment}>{r.comment}</Text>}
                      </View>
                    ))}
                    {/* Pagination */}
                    {detailReviews.totalCount > DETAIL_REVIEW_PAGE_SIZE && (
                      <View style={styles.reviewPagination}>
                        <TouchableOpacity
                          style={[styles.reviewPageBtn, detailReviewPage <= 1 && styles.reviewPageBtnDisabled]}
                          onPress={() => setDetailReviewPage(p => Math.max(1, p - 1))}
                          disabled={detailReviewPage <= 1}
                        >
                          <Feather name="chevron-left" size={14} color={detailReviewPage <= 1 ? Colors.muted : Colors.text} />
                        </TouchableOpacity>
                        <Text style={styles.reviewPageText}>
                          {detailReviewPage} / {Math.ceil(detailReviews.totalCount / DETAIL_REVIEW_PAGE_SIZE)}
                        </Text>
                        <TouchableOpacity
                          style={[styles.reviewPageBtn, detailReviewPage >= Math.ceil(detailReviews.totalCount / DETAIL_REVIEW_PAGE_SIZE) && styles.reviewPageBtnDisabled]}
                          onPress={() => setDetailReviewPage(p => p + 1)}
                          disabled={detailReviewPage >= Math.ceil(detailReviews.totalCount / DETAIL_REVIEW_PAGE_SIZE)}
                        >
                          <Feather name="chevron-right" size={14} color={detailReviewPage >= Math.ceil(detailReviews.totalCount / DETAIL_REVIEW_PAGE_SIZE) ? Colors.muted : Colors.text} />
                        </TouchableOpacity>
                      </View>
                    )}
                  </View>
                )}

                <View style={{ height: 24 }} />
              </ScrollView>
            )}
          </View>
        </View>
      </Modal>

      {/* Write Review Modal */}
      <Modal visible={!!reviewProduct} animationType="slide" transparent>
        <View style={styles.modalOverlay}>
          <View style={[styles.modalContainer, { maxHeight: "70%" }]}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Review: {reviewProduct?.name}</Text>
              <Pressable onPress={() => { setReviewProduct(null); setReviewRating(0); setReviewComment(""); }}>
                <Feather name="x" size={22} color={Colors.text} />
              </Pressable>
            </View>
            <ScrollView style={styles.modalBody} keyboardShouldPersistTaps="handled">
              <Text style={styles.formLabel}>YOUR RATING *</Text>
              <View style={{ marginBottom: 16 }}>
                <StarRow rating={reviewRating} size={28} interactive onRate={setReviewRating} />
              </View>
              <Text style={styles.formLabel}>COMMENT (OPTIONAL)</Text>
              <TextInput
                style={[styles.input, { minHeight: 80, textAlignVertical: "top" }]}
                placeholder="Share your experience with this product…"
                placeholderTextColor={Colors.textSecondary}
                value={reviewComment}
                onChangeText={setReviewComment}
                multiline
                maxLength={500}
              />
              <Text style={[styles.formLabel, { textAlign: "right", marginTop: 4 }]}>{reviewComment.length}/500</Text>

              <Pressable
                onPress={submitReview}
                disabled={submittingReview || reviewRating === 0}
                style={({ pressed }) => [styles.payBtn, { opacity: pressed || submittingReview || reviewRating === 0 ? 0.6 : 1, marginTop: 16, backgroundColor: "#92400e" }]}
              >
                {submittingReview ? (
                  <LoadingSpinner color="#fff" size="small" />
                ) : (
                  <>
                    <Feather name="star" size={16} color="#facc15" style={{ marginRight: 8 }} />
                    <Text style={styles.payBtnText}>{t("writeReview")}</Text>
                  </>
                )}
              </Pressable>
              <View style={{ height: 24 }} />
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* ── CART MODAL ── */}
      <Modal visible={showCart} animationType="slide" transparent onRequestClose={() => !buying && setShowCart(false)}>
        <View style={styles.modalOverlay}>
          <View style={[styles.modalContainer, { maxHeight: '90%' }]}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>{t("tabCart")} ({cartCount})</Text>
              <Pressable onPress={() => setShowCart(false)}><Feather name="x" size={22} color={Colors.text} /></Pressable>
            </View>

            {cart.length === 0 ? (
              <View style={{ padding: 32, alignItems: 'center' }}>
                <Feather name="shopping-cart" size={40} color={Colors.muted} />
                <Text style={{ color: Colors.muted, marginTop: 12, textAlign: 'center' }}>{t("emptyCart")}{"\n"}{t("emptyCartSub")}</Text>
              </View>
            ) : (
              <ScrollView style={{ maxHeight: 400 }} showsVerticalScrollIndicator={false}>
                {cart.map((item, idx) => (
                  <View key={item.localId} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 10, borderBottomWidth: idx < cart.length - 1 ? 1 : 0, borderBottomColor: 'rgba(255,255,255,0.08)' }}>
                    {item.imageUrl ? (
                      <Image source={{ uri: item.imageUrl }} style={{ width: 52, height: 52, borderRadius: 8, marginRight: 10 }} resizeMode="cover" />
                    ) : (
                      <View style={{ width: 52, height: 52, borderRadius: 8, marginRight: 10, backgroundColor: '#1a1a1a', alignItems: 'center', justifyContent: 'center' }}>
                        <Feather name="package" size={22} color={Colors.muted} />
                      </View>
                    )}
                    <View style={{ flex: 1 }}>
                      <Text style={{ color: Colors.text, fontSize: 13, fontWeight: '600' }} numberOfLines={2}>{item.productName}</Text>
                      {(item.size || item.color) && (
                        <Text style={{ color: Colors.muted, fontSize: 11, marginTop: 1 }}>
                          {[item.size, item.color].filter(Boolean).join(' · ')}
                        </Text>
                      )}
                      <Text style={{ color: Colors.primary, fontSize: 13, fontWeight: '700', marginTop: 3 }}>
                        {fmtPrice(String(item.price * item.quantity), item.currency)}
                      </Text>
                    </View>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginLeft: 8 }}>
                      <Pressable
                        style={{ padding: 4, backgroundColor: '#1a1a1a', borderRadius: 6 }}
                        onPress={() => setCart(prev => prev.map(c => c.localId === item.localId ? { ...c, quantity: Math.max(1, c.quantity - 1) } : c))}
                      >
                        <Feather name="minus" size={12} color={Colors.text} />
                      </Pressable>
                      <Text style={{ color: Colors.text, fontSize: 13, fontWeight: '600', minWidth: 20, textAlign: 'center' }}>{item.quantity}</Text>
                      <Pressable
                        style={{ padding: 4, backgroundColor: '#1a1a1a', borderRadius: 6 }}
                        onPress={() => setCart(prev => prev.map(c => c.localId === item.localId ? { ...c, quantity: c.quantity + 1 } : c))}
                      >
                        <Feather name="plus" size={12} color={Colors.text} />
                      </Pressable>
                      <Pressable
                        style={{ padding: 4, marginLeft: 4 }}
                        onPress={() => setCart(prev => prev.filter(c => c.localId !== item.localId))}
                      >
                        <Feather name="trash-2" size={13} color="#f87171" />
                      </Pressable>
                    </View>
                  </View>
                ))}
              </ScrollView>
            )}

            {cart.length > 0 && (
              <View style={{ marginTop: 12 }}>
                <ShopCartTotalRow
                  orgId={orgId}
                  token={token}
                  total={cartTotal}
                  currency={cart[0]?.currency ?? 'INR'}
                  totalLabel={t("total")}
                />
                <Pressable
                  style={({ pressed }) => [styles.payBtn, { opacity: pressed ? 0.8 : 1 }]}
                  onPress={() => {
                    setShowCart(false);
                    setCartCheckoutMode(true);
                    setCheckoutForm(f => ({ ...f, size: '', color: '' }));
                    setPaymentMode("razorpay");
                    setCheckoutPromoCode("");
                    setCheckoutAffiliateCode("");
                    setCheckoutLoyaltyPoints(0);
                    setCheckoutDiscounts(null);
                    setCheckoutDiscountTotal(0);
                    setCheckoutStackingPolicy(null);
                    setCheckoutProduct(cart[0] ? { id: cart[0].productId, name: `Cart (${cartCount} items)`, markupPrice: String(cartTotal), currency: cart[0].currency } as ShopProduct : null);
                  }}
                >
                  <Feather name="credit-card" size={16} color="#fff" style={{ marginRight: 8 }} />
                  <Text style={styles.payBtnText}>{t("checkout")} — {fmtPrice(String(cartTotal), cart[0]?.currency ?? 'INR')}</Text>
                </Pressable>
                <Pressable style={{ marginTop: 8, alignItems: 'center', paddingVertical: 6 }} onPress={() => { setCart([]); setShowCart(false); }}>
                  <Text style={{ color: '#f87171', fontSize: 12 }}>{t("clearCart")}</Text>
                </Pressable>
              </View>
            )}
          </View>
        </View>
      </Modal>

      {/* Checkout Modal */}
      <Modal visible={!!checkoutProduct} animationType="slide" transparent>
        <View style={styles.modalOverlay}>
          <View style={styles.modalContainer}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>{t("checkout")}</Text>
              <Pressable onPress={() => !buying && setCheckoutProduct(null)}>
                <Feather name="x" size={22} color={Colors.text} />
              </Pressable>
            </View>

            {checkoutProduct && (
              <ScrollView style={styles.modalBody} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
                {/* Cart items summary OR single product row */}
                {cartCheckoutMode ? (
                  <View style={{ marginBottom: 12 }}>
                    <Text style={{ color: Colors.textSecondary, fontSize: 11, fontWeight: '600', letterSpacing: 0.5, marginBottom: 8 }}>ORDER SUMMARY</Text>
                    {cart.map((item, idx) => (
                      <View key={item.localId} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 6, borderBottomWidth: idx < cart.length - 1 ? 1 : 0, borderBottomColor: 'rgba(255,255,255,0.06)' }}>
                        <View style={{ flex: 1 }}>
                          <Text style={{ color: Colors.text, fontSize: 12, fontWeight: '600' }} numberOfLines={1}>{item.productName}</Text>
                          {(item.size || item.color) && <Text style={{ color: Colors.muted, fontSize: 10 }}>{[item.size, item.color].filter(Boolean).join(' · ')}</Text>}
                        </View>
                        <Text style={{ color: Colors.muted, fontSize: 12 }}>×{item.quantity}</Text>
                        <View style={{ marginLeft: 8, alignItems: 'flex-end' }}>
                          <PriceWithFx
                            orgId={orgId}
                            token={token}
                            amount={item.price * item.quantity}
                            currency={item.currency}
                            productClass="shop"
                            bookedStyle={{ color: Colors.primary, fontSize: 12, fontWeight: '700' }}
                            showDisclosure={false}
                            disclosureOnHover
                          />
                        </View>
                      </View>
                    ))}
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 8, paddingTop: 8, borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.1)' }}>
                      <Text style={{ color: Colors.text, fontWeight: '700', fontSize: 13 }}>{t("total")}</Text>
                      <View style={{ alignItems: 'flex-end' }}>
                        <PriceWithFx
                          orgId={orgId}
                          token={token}
                          amount={cartTotal}
                          currency={cart[0]?.currency ?? 'INR'}
                          productClass="shop"
                          bookedStyle={{ color: Colors.primary, fontWeight: '800', fontSize: 14 }}
                        />
                      </View>
                    </View>
                  </View>
                ) : (
                  <View style={styles.checkoutProductRow}>
                    {checkoutProduct.imageUrl ? (
                      <Image source={{ uri: checkoutProduct.imageUrl }} style={styles.checkoutProductImage} resizeMode="cover" />
                    ) : (
                      <View style={[styles.checkoutProductImage, styles.checkoutProductImagePlaceholder]}>
                        <Feather name="package" size={20} color={Colors.muted} />
                      </View>
                    )}
                    <View style={{ flex: 1 }}>
                      <Text style={styles.checkoutProductName}>{checkoutProduct.name}</Text>
                      <PriceWithFx
                        orgId={orgId}
                        token={token}
                        amount={checkoutProduct.markupPrice}
                        currency={checkoutProduct.currency}
                        productClass="shop"
                        bookedStyle={styles.checkoutProductPrice}
                      />
                    </View>
                  </View>
                )}

                {/* Variant Picker: colors then sizes from DB variants (single product only) */}
                {!cartCheckoutMode && (checkoutVariants.length > 0 ? (() => {
                  const colors = Array.from(new Set(checkoutVariants.filter(v => v.color).map(v => v.color!)));
                  const sizes = Array.from(new Set(
                    checkoutVariants
                      .filter(v => v.size && (!checkoutForm.color || v.color === checkoutForm.color))
                      .map(v => v.size!)
                  ));
                  return (
                    <>
                      {colors.length > 0 && (
                        <View style={styles.formSection}>
                          <Text style={styles.formLabel}>COLOUR</Text>
                          <View style={styles.sizePicker}>
                            {colors.map(c => (
                              <Pressable key={c} onPress={() => {
                                setCheckoutForm(f => ({ ...f, color: c, size: "" }));
                                setSelectedVariantId(null);
                              }} style={[styles.sizePickerItem, checkoutForm.color === c && styles.sizePickerItemActive]}>
                                <Text style={[styles.sizePickerText, checkoutForm.color === c && styles.sizePickerTextActive]}>{c}</Text>
                              </Pressable>
                            ))}
                          </View>
                        </View>
                      )}
                      {sizes.length > 0 && (
                        <View style={styles.formSection}>
                          <Text style={styles.formLabel}>SIZE</Text>
                          <View style={styles.sizePicker}>
                            {sizes.map(s => {
                              const variant = checkoutVariants.find(v => v.size === s && (!checkoutForm.color || v.color === checkoutForm.color));
                              const outOfStock = variant ? variant.stockQty <= 0 : false;
                              return (
                                <Pressable key={s} onPress={() => {
                                  if (outOfStock) return;
                                  setCheckoutForm(f => ({ ...f, size: s }));
                                  if (variant) setSelectedVariantId(variant.id);
                                }} style={[styles.sizePickerItem, checkoutForm.size === s && styles.sizePickerItemActive, outOfStock && { opacity: 0.4 }]}>
                                  <Text style={[styles.sizePickerText, checkoutForm.size === s && styles.sizePickerTextActive]}>{s}{outOfStock ? " ✕" : ""}</Text>
                                </Pressable>
                              );
                            })}
                          </View>
                        </View>
                      )}
                    </>
                  );
                })() : checkoutProduct.sizes && checkoutProduct.sizes.length > 0 ? (
                  <View style={styles.formSection}>
                    <Text style={styles.formLabel}>SIZE *</Text>
                    <View style={styles.sizePicker}>
                      {checkoutProduct.sizes.map(s => (
                        <Pressable key={s} onPress={() => setCheckoutForm(f => ({ ...f, size: s }))}
                          style={[styles.sizePickerItem, checkoutForm.size === s && styles.sizePickerItemActive]}>
                          <Text style={[styles.sizePickerText, checkoutForm.size === s && styles.sizePickerTextActive]}>{s}</Text>
                        </Pressable>
                      ))}
                    </View>
                  </View>
                ) : null)}

                <View style={styles.formSection}>
                  <Text style={styles.formLabel}>YOUR NAME *</Text>
                  <TextInput style={styles.input} placeholder="Full name" placeholderTextColor={Colors.textSecondary} value={checkoutForm.customerName} onChangeText={v => setCheckoutForm(f => ({ ...f, customerName: v }))} />
                </View>
                <View style={styles.formSection}>
                  <Text style={styles.formLabel}>EMAIL *</Text>
                  <TextInput style={styles.input} placeholder="email@example.com" placeholderTextColor={Colors.textSecondary} value={checkoutForm.customerEmail} onChangeText={v => setCheckoutForm(f => ({ ...f, customerEmail: v }))} keyboardType="email-address" autoCapitalize="none" />
                </View>
                <View style={styles.formSection}>
                  <Text style={styles.formLabel}>PHONE</Text>
                  <TextInput style={styles.input} placeholder="+91 98765 43210" placeholderTextColor={Colors.textSecondary} value={checkoutForm.customerPhone} onChangeText={v => setCheckoutForm(f => ({ ...f, customerPhone: v }))} keyboardType="phone-pad" />
                </View>

                <View style={styles.formDivider}>
                  <Text style={styles.formSectionHeader}>SHIPPING ADDRESS *</Text>
                </View>

                <View style={styles.formSection}>
                  <TextInput style={styles.input} placeholder="Address line 1 *" placeholderTextColor={Colors.textSecondary} value={checkoutForm.line1} onChangeText={v => setCheckoutForm(f => ({ ...f, line1: v }))} />
                </View>
                <View style={styles.formRow}>
                  <TextInput style={[styles.input, { flex: 1 }]} placeholder="City *" placeholderTextColor={Colors.textSecondary} value={checkoutForm.city} onChangeText={v => setCheckoutForm(f => ({ ...f, city: v }))} />
                  <View style={{ width: 8 }} />
                  <TextInput style={[styles.input, { flex: 1 }]} placeholder="State *" placeholderTextColor={Colors.textSecondary} value={checkoutForm.state} onChangeText={v => setCheckoutForm(f => ({ ...f, state: v }))} />
                </View>
                <View style={styles.formRow}>
                  <TextInput style={[styles.input, { flex: 1 }]} placeholder="PIN / ZIP *" placeholderTextColor={Colors.textSecondary} value={checkoutForm.pincode} onChangeText={v => setCheckoutForm(f => ({ ...f, pincode: v }))} keyboardType="numeric" />
                  <View style={{ width: 8 }} />
                  <TextInput style={[styles.input, { flex: 1 }]} placeholder="Country (e.g. IN)" placeholderTextColor={Colors.textSecondary} value={checkoutForm.country} onChangeText={v => setCheckoutForm(f => ({ ...f, country: v }))} autoCapitalize="characters" />
                </View>

                {/* Promo / Affiliate Codes */}
                <View style={styles.formDivider}>
                  <Text style={styles.formSectionHeader}>DISCOUNTS & PROMO CODES</Text>
                </View>
                <View style={styles.formSection}>
                  <Text style={styles.formLabel}>PROMO CODE</Text>
                  <TextInput
                    style={styles.input}
                    placeholder="Enter promo/coupon code"
                    placeholderTextColor={Colors.textSecondary}
                    value={checkoutPromoCode}
                    onChangeText={v => { setCheckoutPromoCode(v); setCheckoutDiscounts(null); }}
                    autoCapitalize="characters"
                    autoCorrect={false}
                  />
                </View>
                <View style={styles.formSection}>
                  <Text style={styles.formLabel}>REFERRAL / AFFILIATE CODE</Text>
                  <TextInput
                    style={styles.input}
                    placeholder="Enter referral code"
                    placeholderTextColor={Colors.textSecondary}
                    value={checkoutAffiliateCode}
                    onChangeText={v => { setCheckoutAffiliateCode(v); setCheckoutDiscounts(null); }}
                    autoCapitalize="characters"
                    autoCorrect={false}
                  />
                </View>
                {loyaltyPointsBalance > 0 && (
                  <View style={styles.formSection}>
                    <Text style={styles.formLabel}>LOYALTY POINTS</Text>
                    <Text style={{ fontSize: 12, color: Colors.textSecondary, marginBottom: 6 }}>
                      Available: <Text style={{ color: "#d97706", fontWeight: "600" }}>{loyaltyPointsBalance.toLocaleString(getLocale())} pts</Text>
                    </Text>
                    <TextInput
                      style={styles.input}
                      placeholder="Points to redeem (0 = none)"
                      placeholderTextColor={Colors.textSecondary}
                      value={checkoutLoyaltyPoints > 0 ? String(checkoutLoyaltyPoints) : ""}
                      onChangeText={v => {
                        const n = parseInt(v) || 0;
                        setCheckoutLoyaltyPoints(Math.max(0, Math.min(loyaltyPointsBalance, n)));
                        setCheckoutDiscounts(null);
                      }}
                      keyboardType="number-pad"
                    />
                  </View>
                )}
                {checkoutDiscounts && checkoutDiscounts.length > 0 && (
                  <View style={{ backgroundColor: "#f0fdf4", borderRadius: 8, padding: 12, marginBottom: 8 }}>
                    {checkoutDiscounts.map((d, i) => (
                      <View key={i} style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: 2 }}>
                        <Text style={{ fontSize: 13, color: "#166534" }}>{d.label}</Text>
                        <Text style={{ fontSize: 13, fontWeight: "600", color: "#166534" }}>−{fmtPrice(d.amount, "INR")}</Text>
                      </View>
                    ))}
                    <View style={{ flexDirection: "row", justifyContent: "space-between", marginTop: 6, borderTopWidth: 1, borderTopColor: "#bbf7d0", paddingTop: 6 }}>
                      <Text style={{ fontSize: 13, fontWeight: "700", color: "#166534" }}>Total Savings</Text>
                      <Text style={{ fontSize: 13, fontWeight: "700", color: "#166534" }}>−{fmtPrice(checkoutDiscountTotal, "INR")}</Text>
                    </View>
                    {checkoutStackingPolicy && (
                      <Text style={{ fontSize: 11, color: "#6b7280", marginTop: 4 }}>
                        Stacking policy: {checkoutStackingPolicy.replace(/_/g, " ")}
                      </Text>
                    )}
                  </View>
                )}

                {/* Payment Mode Selector */}
                <View style={styles.formDivider}>
                  <Text style={styles.formSectionHeader}>PAYMENT METHOD *</Text>
                </View>
                <View style={styles.paymentModeRow}>
                  <Pressable
                    style={[styles.paymentModeOption, paymentMode === "razorpay" && styles.paymentModeActive]}
                    onPress={() => setPaymentMode("razorpay")}
                  >
                    <Feather name="credit-card" size={16} color={paymentMode === "razorpay" ? Colors.primary : Colors.textSecondary} />
                    <Text style={[styles.paymentModeText, paymentMode === "razorpay" && styles.paymentModeTextActive]}>Pay Online</Text>
                  </Pressable>
                  <Pressable
                    style={[styles.paymentModeOption, paymentMode === "cod" && styles.paymentModeActive]}
                    onPress={() => setPaymentMode("cod")}
                  >
                    <Feather name="dollar-sign" size={16} color={paymentMode === "cod" ? Colors.primary : Colors.textSecondary} />
                    <Text style={[styles.paymentModeText, paymentMode === "cod" && styles.paymentModeTextActive]}>{t("cod")}</Text>
                  </Pressable>
                </View>

                <Pressable onPress={handleBuy} disabled={buying} style={({ pressed }) => [styles.payBtn, { opacity: pressed || buying ? 0.7 : 1, marginTop: 16 }]}>
                  {buying ? (
                    <LoadingSpinner color="#fff" size="small" />
                  ) : paymentMode === "cod" ? (
                    <>
                      <Feather name="package" size={16} color="#fff" style={{ marginRight: 8 }} />
                      <Text style={styles.payBtnText}>{t("placeOrder")} — {fmtPrice(
                        cartCheckoutMode
                          ? String(checkoutDiscountTotal > 0 ? cartTotal - checkoutDiscountTotal : cartTotal)
                          : String(checkoutDiscountTotal > 0 ? parseFloat(checkoutProduct.markupPrice) - checkoutDiscountTotal : parseFloat(checkoutProduct.markupPrice)),
                        cartCheckoutMode ? (cart[0]?.currency ?? 'INR') : checkoutProduct.currency
                      )}</Text>
                    </>
                  ) : (
                    <>
                      <Feather name="credit-card" size={16} color="#fff" style={{ marginRight: 8 }} />
                      <Text style={styles.payBtnText}>{t("checkout")} — {fmtPrice(
                        String(checkoutFinalTotal ?? (cartCheckoutMode ? cartTotal : parseFloat(checkoutProduct.markupPrice))),
                        cartCheckoutMode ? (cart[0]?.currency ?? 'INR') : checkoutProduct.currency
                      )}</Text>
                    </>
                  )}
                </Pressable>
                <View style={{ height: 24 }} />
              </ScrollView>
            )}
          </View>
        </View>
      </Modal>

      {/* ── Return Request Modal ──────────────────────────────────────── */}
      <Modal visible={!!returnOrder} animationType="slide" transparent onRequestClose={() => setReturnOrder(null)}>
        <View style={styles.modalOverlay}>
          <View style={[styles.modalContainer, { maxHeight: "85%" }]}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Request Return</Text>
              <Pressable onPress={() => setReturnOrder(null)} style={styles.modalCloseBtn}>
                <Feather name="x" size={20} color={Colors.text} />
              </Pressable>
            </View>
            {returnOrder && (
              <ScrollView style={{ padding: 16 }} showsVerticalScrollIndicator={false}>
                <View style={{ backgroundColor: Colors.surface, borderRadius: 10, padding: 12, marginBottom: 16 }}>
                  <Text style={{ color: Colors.text, fontWeight: "600", fontSize: 14 }} numberOfLines={2}>{returnOrder.productName ?? "Item"}</Text>
                  <Text style={{ color: Colors.textSecondary, fontSize: 12, marginTop: 2 }}>
                    {[returnOrder.size && `Size: ${returnOrder.size}`, returnOrder.color && returnOrder.color].filter(Boolean).join(" / ")} × {returnOrder.quantity}
                  </Text>
                </View>

                <Text style={{ color: Colors.textSecondary, fontSize: 12, fontWeight: "600", marginBottom: 8, textTransform: "uppercase", letterSpacing: 0.5 }}>Reason *</Text>
                {[
                  { value: "wrong_size", label: "Wrong Size" },
                  { value: "defective", label: "Defective / Damaged" },
                  { value: "changed_mind", label: "Changed My Mind" },
                  { value: "wrong_item", label: "Wrong Item Received" },
                  { value: "damaged_in_shipping", label: "Damaged in Shipping" },
                  { value: "other", label: "Other" },
                ].map(opt => (
                  <TouchableOpacity
                    key={opt.value}
                    onPress={() => setReturnReason(opt.value)}
                    style={{ flexDirection: "row", alignItems: "center", paddingVertical: 10, paddingHorizontal: 12, borderRadius: 8, marginBottom: 6, backgroundColor: returnReason === opt.value ? Colors.primary + "20" : Colors.surface, borderWidth: 1, borderColor: returnReason === opt.value ? Colors.primary : Colors.border }}
                    activeOpacity={0.7}
                  >
                    <View style={{ width: 16, height: 16, borderRadius: 8, borderWidth: 2, borderColor: returnReason === opt.value ? Colors.primary : Colors.textSecondary, alignItems: "center", justifyContent: "center", marginRight: 10 }}>
                      {returnReason === opt.value && <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: Colors.primary }} />}
                    </View>
                    <Text style={{ color: returnReason === opt.value ? Colors.primary : Colors.text, fontSize: 14 }}>{opt.label}</Text>
                  </TouchableOpacity>
                ))}

                <Text style={{ color: Colors.textSecondary, fontSize: 12, fontWeight: "600", marginTop: 14, marginBottom: 8, textTransform: "uppercase", letterSpacing: 0.5 }}>Resolution</Text>
                <View style={{ flexDirection: "row", gap: 8, marginBottom: 14 }}>
                  {(["refund", "exchange"] as const).map(rt => (
                    <TouchableOpacity
                      key={rt}
                      onPress={() => setReturnType(rt)}
                      style={{ flex: 1, alignItems: "center", paddingVertical: 10, borderRadius: 8, borderWidth: 1, borderColor: returnType === rt ? Colors.primary : Colors.border, backgroundColor: returnType === rt ? Colors.primary + "20" : Colors.surface }}
                      activeOpacity={0.7}
                    >
                      <Text style={{ color: returnType === rt ? Colors.primary : Colors.textSecondary, fontSize: 13, fontWeight: "600" }}>{rt === "refund" ? "Refund" : "Exchange"}</Text>
                    </TouchableOpacity>
                  ))}
                </View>

                <Text style={{ color: Colors.textSecondary, fontSize: 12, fontWeight: "600", marginBottom: 8, textTransform: "uppercase", letterSpacing: 0.5 }}>Additional Details</Text>
                <TextInput
                  value={returnDetail}
                  onChangeText={setReturnDetail}
                  placeholder="Describe the issue…"
                  placeholderTextColor={Colors.muted}
                  style={{ backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border, borderRadius: 8, padding: 12, color: Colors.text, fontSize: 14, minHeight: 70, textAlignVertical: "top" }}
                  multiline
                />

                <Text style={{ color: Colors.muted, fontSize: 11, marginTop: 10, marginBottom: 16, lineHeight: 16 }}>Returns are subject to a 30-day window from order date and admin review. You will be notified once processed.</Text>

                <Pressable
                  onPress={submitReturn}
                  disabled={submittingReturn || !returnReason}
                  style={{ backgroundColor: returnReason ? Colors.primary : Colors.border, borderRadius: 10, paddingVertical: 14, alignItems: "center", flexDirection: "row", justifyContent: "center", gap: 8 }}
                >
                  <Feather name="refresh-cw" size={16} color="#fff" />
                  <Text style={{ color: "#fff", fontWeight: "700", fontSize: 15 }}>{submittingReturn ? t("processingOrder") : t("submitReturn")}</Text>
                </Pressable>
                <View style={{ height: 24 }} />
              </ScrollView>
            )}
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  header: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    paddingHorizontal: 20, paddingVertical: 16,
    borderBottomWidth: 1, borderBottomColor: Colors.border,
  },
  headerTitle: { fontSize: 22, fontWeight: "700", color: Colors.text, letterSpacing: -0.3 },
  headerSubtitle: { fontSize: 12, color: Colors.textSecondary, marginTop: 2 },
  refreshBtn: { padding: 8 },
  tabBar: {
    flexDirection: "row", paddingHorizontal: 16, paddingTop: 12, paddingBottom: 4,
    gap: 8, borderBottomWidth: 1, borderBottomColor: Colors.border,
  },
  tab: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 16, paddingVertical: 8, borderRadius: 20, backgroundColor: "transparent" },
  tabActive: { backgroundColor: Colors.primary + "20" },
  tabText: { fontSize: 13, fontWeight: "600", color: Colors.textSecondary },
  tabTextActive: { color: Colors.primary },
  tabTextSaved: { color: "#f87171" },
  cartBadge: { position: 'absolute', top: -5, right: -6, backgroundColor: '#ef4444', borderRadius: 7, minWidth: 14, height: 14, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 2 },
  cartBadgeText: { color: '#fff', fontSize: 9, fontWeight: '800', lineHeight: 14 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 40 },
  loadingText: { color: Colors.textSecondary, marginTop: 12, fontSize: 14 },
  emptyTitle: { fontSize: 18, fontWeight: "700", color: Colors.text, marginTop: 16, textAlign: "center" },
  emptySubtitle: { fontSize: 13, color: Colors.textSecondary, marginTop: 8, textAlign: "center", lineHeight: 20 },
  listContent: { padding: 12, paddingBottom: 100 },
  row: { justifyContent: "space-between", marginBottom: 12 },
  productCard: {
    backgroundColor: Colors.surface, borderRadius: 16, borderWidth: 1,
    borderColor: Colors.border, overflow: "hidden", width: "48.5%",
  },
  productImageContainer: { aspectRatio: 1, backgroundColor: Colors.card, position: "relative" },
  productImage: { width: "100%", height: "100%" },
  productImagePlaceholder: { width: "100%", height: "100%", alignItems: "center", justifyContent: "center" },
  categoryBadge: {
    position: "absolute", top: 6, left: 6, backgroundColor: "rgba(0,0,0,0.6)",
    borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2,
  },
  categoryBadgeText: { color: "#fff", fontSize: 9, fontWeight: "600", letterSpacing: 0.3 },
  printfulBadge: {
    position: "absolute", top: 6, right: 6, backgroundColor: "rgba(0,0,0,0.6)",
    borderRadius: 6, paddingHorizontal: 5, paddingVertical: 2, flexDirection: "row", alignItems: "center", gap: 3,
  },
  printfulBadgeText: { color: Colors.primary, fontSize: 9, fontWeight: "700" },
  heartBtn: { position: "absolute", bottom: 6, right: 6, backgroundColor: "rgba(0,0,0,0.55)", borderRadius: 20, padding: 6 },
  productInfo: { padding: 10 },
  productName: { color: Colors.text, fontSize: 13, fontWeight: "600", lineHeight: 18 },
  productDesc: { color: Colors.textSecondary, fontSize: 11, marginTop: 3 },
  ratingRow: { flexDirection: "row", alignItems: "center", gap: 4, marginTop: 4 },
  ratingText: { color: "#facc15", fontSize: 10, fontWeight: "600" },
  productFooter: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 8 },
  productPrice: { color: Colors.primary, fontSize: 15, fontWeight: "700" },
  saleBadge: { backgroundColor: "#dc2626", borderRadius: 4, paddingHorizontal: 5, paddingVertical: 2 },
  saleBadgeText: { color: "#fff", fontSize: 9, fontWeight: "700", letterSpacing: 0.5 },
  salePrice: { color: "#f87171", fontSize: 14, fontWeight: "700" },
  buyBtn: {
    backgroundColor: Colors.primary, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 5,
    flexDirection: "row", alignItems: "center", gap: 4,
  },
  buyBtnText: { color: "#fff", fontSize: 11, fontWeight: "700" },
  sizesRow: { flexDirection: "row", flexWrap: "wrap", gap: 4, marginTop: 6 },
  sizeChip: { backgroundColor: "rgba(255,255,255,0.07)", borderRadius: 4, paddingHorizontal: 5, paddingVertical: 2 },
  sizeChipText: { color: Colors.textSecondary, fontSize: 9, fontWeight: "600" },
  moreSizes: { color: Colors.muted, fontSize: 9, alignSelf: "center" },
  // Modal
  modalOverlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.7)", justifyContent: "flex-end" },
  modalContainer: {
    backgroundColor: Colors.surface, borderTopLeftRadius: 24, borderTopRightRadius: 24,
    maxHeight: "92%", borderTopWidth: 1, borderColor: Colors.border,
  },
  modalHeader: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    padding: 20, borderBottomWidth: 1, borderBottomColor: Colors.border,
  },
  modalTitle: { fontSize: 18, fontWeight: "700", color: Colors.text, flex: 1, marginRight: 12 },
  modalBody: { padding: 20 },
  // Detail
  detailImage: { width: "100%", aspectRatio: 1, borderRadius: 16, marginBottom: 16, backgroundColor: Colors.card },
  detailInfo: { marginBottom: 8 },
  detailPrice: { color: Colors.primary, fontSize: 22, fontWeight: "700", marginBottom: 6 },
  detailRatingRow: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 8 },
  detailRatingText: { color: "#facc15", fontSize: 13, fontWeight: "600" },
  detailDesc: { color: Colors.textSecondary, fontSize: 13, lineHeight: 20, marginTop: 4, marginBottom: 8 },
  reviewBtn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center",
    borderWidth: 1.5, borderColor: "#92400e", borderRadius: 12, paddingVertical: 10,
    marginTop: 8, backgroundColor: "rgba(146,64,14,0.15)",
  },
  reviewBtnText: { color: "#facc15", fontSize: 14, fontWeight: "600" },
  // Reviews section
  reviewsSection: { marginTop: 20 },
  reviewsSectionTitle: { color: Colors.text, fontSize: 14, fontWeight: "700", marginBottom: 12 },
  reviewCard: { backgroundColor: Colors.card, borderRadius: 10, padding: 12, marginBottom: 10, borderWidth: 1, borderColor: Colors.border },
  reviewCardHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 4 },
  reviewDate: { color: Colors.textSecondary, fontSize: 10 },
  reviewerName: { color: Colors.primary, fontSize: 11, fontWeight: "600", marginBottom: 4 },
  reviewComment: { color: Colors.textSecondary, fontSize: 12, lineHeight: 18 },
  // Checkout
  checkoutProductRow: {
    flexDirection: "row", alignItems: "center", gap: 12, padding: 12,
    backgroundColor: Colors.card, borderRadius: 12, marginBottom: 16,
    borderWidth: 1, borderColor: Colors.border,
  },
  checkoutProductImage: { width: 52, height: 52, borderRadius: 8, backgroundColor: Colors.card },
  checkoutProductImagePlaceholder: { alignItems: "center", justifyContent: "center" },
  checkoutProductName: { color: Colors.text, fontSize: 14, fontWeight: "600", lineHeight: 20 },
  checkoutProductPrice: { color: Colors.primary, fontSize: 16, fontWeight: "700", marginTop: 2 },
  formSection: { marginBottom: 12 },
  formLabel: { color: Colors.textSecondary, fontSize: 10, fontWeight: "600", letterSpacing: 0.8, marginBottom: 6 },
  formSectionHeader: { color: Colors.textSecondary, fontSize: 10, fontWeight: "700", letterSpacing: 0.8 },
  formDivider: { borderTopWidth: 1, borderTopColor: Colors.border, paddingTop: 12, marginBottom: 12 },
  formRow: { flexDirection: "row", marginBottom: 12 },
  input: {
    backgroundColor: Colors.card, borderWidth: 1, borderColor: Colors.border, borderRadius: 10,
    paddingHorizontal: 14, paddingVertical: 11, color: Colors.text, fontSize: 14,
  },
  sizePicker: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  sizePickerItem: { borderWidth: 1.5, borderColor: Colors.border, borderRadius: 8, paddingHorizontal: 14, paddingVertical: 7 },
  sizePickerItemActive: { borderColor: Colors.primary, backgroundColor: Colors.primary + "20" },
  sizePickerText: { color: Colors.textSecondary, fontSize: 13, fontWeight: "600" },
  sizePickerTextActive: { color: Colors.primary },
  payBtn: {
    backgroundColor: Colors.primary, borderRadius: 12, paddingVertical: 14,
    flexDirection: "row", alignItems: "center", justifyContent: "center",
  },
  payBtnText: { color: "#fff", fontSize: 16, fontWeight: "700", letterSpacing: 0.3 },
  // Review prompts banner
  promptBanner: {
    flexDirection: "row", alignItems: "center", backgroundColor: "rgba(146,64,14,0.15)",
    borderBottomWidth: 1, borderBottomColor: "#92400e44", paddingHorizontal: 16, paddingVertical: 10,
  },
  promptTitle: { color: Colors.text, fontSize: 12, fontWeight: "600" },
  promptSubtitle: { color: Colors.textSecondary, fontSize: 11, marginTop: 1 },
  promptWriteBtn: {
    backgroundColor: "rgba(250,204,21,0.15)", borderWidth: 1, borderColor: "#92400e",
    borderRadius: 8, paddingHorizontal: 10, paddingVertical: 5, marginLeft: 8,
  },
  promptWriteBtnText: { color: "#facc15", fontSize: 11, fontWeight: "700" },
  // Review pagination
  reviewPagination: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 16, marginTop: 12 },
  reviewPageBtn: { padding: 8, borderRadius: 8, backgroundColor: Colors.card, borderWidth: 1, borderColor: Colors.border },
  reviewPageBtnDisabled: { opacity: 0.4 },
  // Orders tab
  orderCard: {
    backgroundColor: Colors.surface, borderRadius: 14, borderWidth: 1, borderColor: Colors.border,
    marginBottom: 12, padding: 14,
  },
  orderCardRow: { flexDirection: "row", alignItems: "flex-start" },
  orderImage: { width: 56, height: 56, borderRadius: 8, backgroundColor: Colors.card },
  orderImagePlaceholder: { alignItems: "center", justifyContent: "center" },
  orderProductName: { color: Colors.text, fontSize: 13, fontWeight: "600", lineHeight: 18, flexShrink: 1 },
  orderVariantChip: {
    backgroundColor: Colors.card, borderWidth: 1, borderColor: Colors.border,
    borderRadius: 6, paddingHorizontal: 7, paddingVertical: 2, fontSize: 10, color: Colors.textSecondary, fontWeight: "600",
  },
  codBadge: { backgroundColor: "#ca8a0422", borderWidth: 1, borderColor: "#ca8a04", borderRadius: 6, paddingHorizontal: 7, paddingVertical: 2 },
  codBadgeText: { color: "#ca8a04", fontSize: 10, fontWeight: "700" },
  orderAmount: { color: Colors.primary, fontSize: 14, fontWeight: "700" },
  orderDate: { color: Colors.textSecondary, fontSize: 10, marginTop: 4 },
  orderTrackRow: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 10, paddingTop: 10, borderTopWidth: 1, borderTopColor: Colors.border },
  orderAwb: { color: Colors.textSecondary, fontSize: 11, flex: 1 },
  orderTrackLink: { color: Colors.primary, fontSize: 11, fontWeight: "700" },
  // Payment mode
  paymentModeRow: { flexDirection: "row", gap: 10, marginBottom: 8 },
  paymentModeOption: {
    flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8,
    borderWidth: 1.5, borderColor: Colors.border, borderRadius: 10, paddingVertical: 10,
    backgroundColor: Colors.card,
  },
  paymentModeActive: { borderColor: Colors.primary, backgroundColor: Colors.primary + "15" },
  paymentModeText: { color: Colors.textSecondary, fontSize: 13, fontWeight: "600" },
  paymentModeTextActive: { color: Colors.primary },
  reviewPageText: { color: Colors.textSecondary, fontSize: 12 },
});
