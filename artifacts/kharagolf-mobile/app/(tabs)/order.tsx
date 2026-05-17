import React, { useState, useCallback, useRef, useEffect } from "react";
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  TextInput,
  Modal,
  FlatList,
  RefreshControl,
  Alert,
  Platform,
} from "react-native";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import { Feather } from "@expo/vector-icons";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import { useLocalSearchParams } from "expo-router";
import { useAuth } from "@/context/auth";
import { useActiveClub } from "@/context/activeClub";
import Colors from "@/constants/colors";
import { useHighlightFlash, parseIdParam } from "@/hooks/use-highlight";
import * as Notifications from "expo-notifications";

const BASE_URL = process.env.EXPO_PUBLIC_DOMAIN
  ? `https://${process.env.EXPO_PUBLIC_DOMAIN}`
  : "";

interface MenuItem {
  id: number;
  name: string;
  description?: string;
  price: string;
  currency: string;
  imageUrl?: string;
  isAvailable: boolean;
  sortOrder: number;
  categoryId?: number;
  stationId?: number;
}

interface MenuCategory {
  id: number;
  name: string;
  sortOrder: number;
  isActive: boolean;
}

interface CartItem {
  menuItem: MenuItem;
  quantity: number;
}

interface OrderItem {
  name: string;
  price: string;
  quantity: number;
}

interface FbOrder {
  id: number;
  holeNumber?: number;
  status: "received" | "preparing" | "ready" | "delivered" | "cancelled";
  paymentMethod: string;
  totalAmount: string;
  currency: string;
  notes?: string;
  createdAt: string;
  items: OrderItem[];
}

const STATUS_COLORS: Record<string, string> = {
  received: "#f59e0b",
  preparing: "#3b82f6",
  ready: Colors.primary,
  delivered: "#6b7280",
  cancelled: Colors.error,
};

function fmtPrice(price: string | number, currency = "INR") {
  const num = parseFloat(String(price));
  if (currency === "INR") return `₹${num.toFixed(2)}`;
  return `${currency} ${num.toFixed(2)}`;
}

async function scheduleReadyNotification(orderRef: string, t: (key: string, opts?: object) => string) {
  if (Platform.OS === "web") return;
  try {
    const { status } = await Notifications.getPermissionsAsync();
    const finalStatus = status === "granted"
      ? status
      : (await Notifications.requestPermissionsAsync()).status;
    if (finalStatus !== "granted") return;
    await Notifications.scheduleNotificationAsync({
      content: {
        title: t("order:orderReadyTitle"),
        body: t("order:orderReadyBody", { ref: orderRef }),
        sound: true,
      },
      trigger: null,
    });
  } catch {}
}

export default function OrderTab() {
  const insets = useSafeAreaInsets();
  const { t } = useTranslation("order");
  const { token, isAuthenticated, user } = useAuth();
  const { activeClub } = useActiveClub();
  const qc = useQueryClient();

  const params = useLocalSearchParams<{ orderId?: string }>();
  // Deep-link from MyUpcomingWidget: jump straight to "Orders" tab. We also
  // remember the requested id so that once `myOrders` loads we can auto-open
  // the live tracker for that order (one-shot — see effect below).
  const deepLinkOrderId = parseIdParam(params.orderId);
  const { highlightId } = useHighlightFlash(params.orderId);
  const [activeTab, setActiveTab] = useState<"menu" | "orders">(deepLinkOrderId ? "orders" : "menu");
  useEffect(() => {
    if (deepLinkOrderId != null) setActiveTab("orders");
  }, [deepLinkOrderId]);
  const [selectedCategory, setSelectedCategory] = useState<number | null>(null);
  const [cart, setCart] = useState<CartItem[]>([]);
  const [showCart, setShowCart] = useState(false);
  const [holeNumber, setHoleNumber] = useState("");
  const [paymentMethod, setPaymentMethod] = useState<"account_charge" | "card_on_delivery">("card_on_delivery");
  const [notes, setNotes] = useState("");
  const [placingOrder, setPlacingOrder] = useState(false);
  const [trackingOrder, setTrackingOrder] = useState<FbOrder | null>(null);
  const [orderStatus, setOrderStatus] = useState<string | null>(null);
  const sseRef = useRef<EventSource | null>(null);

  const orgId = activeClub?.id;

  const authHeaders = token ? { Authorization: `Bearer ${token}` } : {};

  const { data: menuData, isLoading: menuLoading, refetch: refetchMenu } = useQuery<{
    items: MenuItem[];
    categories: MenuCategory[];
  }>({
    queryKey: [`fb-menu-${orgId}`],
    queryFn: () => fetch(`${BASE_URL}/api/organizations/${orgId}/fb/menu`, { headers: authHeaders })
      .then(r => r.json()),
    enabled: !!orgId && isAuthenticated,
  });

  const { data: myOrders = [], isLoading: ordersLoading, refetch: refetchOrders } = useQuery<FbOrder[]>({
    queryKey: [`fb-orders-mine-${orgId}`],
    queryFn: () => fetch(`${BASE_URL}/api/organizations/${orgId}/fb/orders/mine`, { headers: authHeaders })
      .then(r => r.json()),
    enabled: !!orgId && isAuthenticated && activeTab === "orders",
  });

  // One-shot: when arriving via deep link with ?orderId=N, automatically
  // open the live tracker for that order as soon as it loads.
  const autoTrackedRef = useRef<number | null>(null);

  const categories = menuData?.categories ?? [];
  const allItems = menuData?.items ?? [];
  const filteredItems = selectedCategory
    ? allItems.filter(i => i.categoryId === selectedCategory)
    : allItems;

  function addToCart(item: MenuItem) {
    setCart(prev => {
      const existing = prev.find(c => c.menuItem.id === item.id);
      if (existing) return prev.map(c => c.menuItem.id === item.id ? { ...c, quantity: c.quantity + 1 } : c);
      return [...prev, { menuItem: item, quantity: 1 }];
    });
  }

  function removeFromCart(itemId: number) {
    setCart(prev => {
      const existing = prev.find(c => c.menuItem.id === itemId);
      if (!existing) return prev;
      if (existing.quantity <= 1) return prev.filter(c => c.menuItem.id !== itemId);
      return prev.map(c => c.menuItem.id === itemId ? { ...c, quantity: c.quantity - 1 } : c);
    });
  }

  const cartTotal = cart.reduce((s, c) => s + parseFloat(c.menuItem.price) * c.quantity, 0);
  const cartCount = cart.reduce((s, c) => s + c.quantity, 0);

  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);

  function stopTracking() {
    if (sseRef.current) { sseRef.current.close(); sseRef.current = null; }
    if (pollingRef.current) { clearInterval(pollingRef.current); pollingRef.current = null; }
  }

  const prevStatusRef = useRef<string | null>(null);

  function handleStatusUpdate(newStatus: string, orderId: number) {
    const prev = prevStatusRef.current;
    prevStatusRef.current = newStatus;
    setOrderStatus(newStatus);
    if (newStatus === "ready" && prev !== "ready") {
      scheduleReadyNotification(String(orderId), t);
    }
  }

  async function pollOrderStatus(orderId: number) {
    try {
      const r = await fetch(`${BASE_URL}/api/organizations/${orgId}/fb/orders/mine`, { headers: authHeaders });
      if (!r.ok) return;
      const orders: FbOrder[] = await r.json();
      const updated = orders.find(o => o.id === orderId);
      if (updated) {
        handleStatusUpdate(updated.status, orderId);
        if (updated.status === "delivered" || updated.status === "cancelled") {
          stopTracking();
        }
      }
    } catch {}
  }

  function startTracking(order: FbOrder) {
    setTrackingOrder(order);
    prevStatusRef.current = order.status;
    setOrderStatus(order.status);
    stopTracking();

    if (order.status === "delivered" || order.status === "cancelled") return;

    if (Platform.OS === "web") {
      // Web: use SSE for real-time updates
      const url = `${BASE_URL}/api/organizations/${orgId}/fb/orders/${order.id}/sse`;
      const es = new EventSource(url);
      es.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          if (msg.type === "order_status") {
            handleStatusUpdate(msg.data.status, order.id);
            if (msg.data.status === "delivered" || msg.data.status === "cancelled") es.close();
          }
        } catch {}
      };
      sseRef.current = es;
    } else {
      // Native (iOS/Android): poll every 15 seconds for order status
      pollingRef.current = setInterval(() => pollOrderStatus(order.id), 15000);
    }
  }

  useEffect(() => () => { stopTracking(); }, []);

  // Auto-open the live tracker for a deep-linked order, once.
  useEffect(() => {
    if (deepLinkOrderId == null) return;
    if (autoTrackedRef.current === deepLinkOrderId) return;
    if (!myOrders || myOrders.length === 0) return;
    const found = myOrders.find(o => o.id === deepLinkOrderId);
    if (!found) return;
    autoTrackedRef.current = deepLinkOrderId;
    startTracking(found);
  }, [deepLinkOrderId, myOrders]);

  async function placeOrder() {
    if (!orgId || cart.length === 0) return;
    setPlacingOrder(true);
    try {
      const body = {
        holeNumber: holeNumber ? parseInt(holeNumber) : null,
        paymentMethod,
        notes: notes || null,
        items: cart.map(c => ({ menuItemId: c.menuItem.id, quantity: c.quantity })),
      };
      const r = await fetch(`${BASE_URL}/api/organizations/${orgId}/fb/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders },
        body: JSON.stringify(body),
      });
      if (!r.ok) { const e = await r.json(); throw new Error(e.error ?? "Failed to place order"); }
      const order = await r.json();
      setCart([]);
      setShowCart(false);
      setHoleNumber("");
      setNotes("");
      qc.invalidateQueries({ queryKey: [`fb-orders-mine-${orgId}`] });
      setActiveTab("orders");
      startTracking(order);
    } catch (err: unknown) {
      Alert.alert(t("error"), err instanceof Error ? err.message : t("failedToPlaceOrder"));
    } finally {
      setPlacingOrder(false);
    }
  }

  const topPadding = insets.top + 8;

  const getStatusLabel = (status: string) => {
    const map: Record<string, string> = {
      received: t("statusReceived"),
      preparing: t("statusPreparing"),
      ready: t("statusReady"),
      delivered: t("statusDelivered"),
      cancelled: t("statusCancelled"),
    };
    return map[status] ?? status;
  };

  if (!isAuthenticated) {
    return (
      <View style={[styles.container, { paddingTop: topPadding, alignItems: "center", justifyContent: "center" }]}>
        <Feather name="coffee" size={48} color={Colors.muted} />
        <Text style={[styles.emptyText, { marginTop: 16 }]}>{t("signInToOrder")}</Text>
      </View>
    );
  }

  if (!orgId) {
    return (
      <View style={[styles.container, { paddingTop: topPadding, alignItems: "center", justifyContent: "center" }]}>
        <Feather name="coffee" size={48} color={Colors.muted} />
        <Text style={[styles.emptyText, { marginTop: 16 }]}>{t("selectClub")}</Text>
      </View>
    );
  }

  return (
    <View style={[styles.container, { paddingTop: topPadding }]}>
      {/* Header */}
      <View style={styles.header}>
        <View>
          <Text style={styles.headerTitle}>{t("title")}</Text>
          <Text style={styles.headerSubtitle}>{t("subtitle")}</Text>
        </View>
        {cart.length > 0 && (
          <TouchableOpacity style={styles.cartBtn} onPress={() => setShowCart(true)}>
            <Feather name="shopping-cart" size={20} color={Colors.primary} />
            <View style={styles.cartBadge}><Text style={styles.cartBadgeText}>{cartCount}</Text></View>
          </TouchableOpacity>
        )}
      </View>

      {/* Tab bar */}
      <View style={styles.tabBar}>
        <TouchableOpacity style={[styles.tab, activeTab === "menu" && styles.tabActive]} onPress={() => setActiveTab("menu")}>
          <Feather name="menu" size={15} color={activeTab === "menu" ? Colors.primary : Colors.textSecondary} />
          <Text style={[styles.tabText, activeTab === "menu" && styles.tabTextActive]}>{t("tabMenu")}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.tab, activeTab === "orders" && styles.tabActive]} onPress={() => setActiveTab("orders")}>
          <Feather name="clock" size={15} color={activeTab === "orders" ? Colors.primary : Colors.textSecondary} />
          <Text style={[styles.tabText, activeTab === "orders" && styles.tabTextActive]}>{t("tabMyOrders")}</Text>
        </TouchableOpacity>
      </View>

      {/* Active order tracking banner */}
      {trackingOrder && activeTab === "menu" && (
        <TouchableOpacity style={[styles.trackingBanner, { borderColor: STATUS_COLORS[orderStatus ?? trackingOrder.status] }]}
          onPress={() => setActiveTab("orders")}>
          <View style={[styles.trackingDot, { backgroundColor: STATUS_COLORS[orderStatus ?? trackingOrder.status] }]} />
          <Text style={styles.trackingText}>
            {t("trackingBanner", { id: trackingOrder.id, status: getStatusLabel(orderStatus ?? trackingOrder.status) })}
          </Text>
          <Feather name="chevron-right" size={14} color={Colors.textSecondary} />
        </TouchableOpacity>
      )}

      {/* MENU TAB */}
      {activeTab === "menu" && (
        <View style={{ flex: 1 }}>
          {/* Category filter */}
          {categories.length > 0 && (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.categoryScroll}
              contentContainerStyle={{ paddingHorizontal: 16, gap: 8 }}>
              <TouchableOpacity
                style={[styles.categoryChip, selectedCategory === null && styles.categoryChipActive]}
                onPress={() => setSelectedCategory(null)}>
                <Text style={[styles.categoryChipText, selectedCategory === null && styles.categoryChipTextActive]}>{t("all")}</Text>
              </TouchableOpacity>
              {categories.map(cat => (
                <TouchableOpacity key={cat.id}
                  style={[styles.categoryChip, selectedCategory === cat.id && styles.categoryChipActive]}
                  onPress={() => setSelectedCategory(cat.id)}>
                  <Text style={[styles.categoryChipText, selectedCategory === cat.id && styles.categoryChipTextActive]}>{cat.name}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          )}

          {menuLoading ? (
            <View style={styles.centered}><LoadingSpinner color={Colors.primary} /></View>
          ) : filteredItems.length === 0 ? (
            <View style={styles.centered}>
              <Feather name="coffee" size={40} color={Colors.muted} />
              <Text style={styles.emptyText}>{t("noItems")}</Text>
            </View>
          ) : (
            <FlatList
              data={filteredItems}
              keyExtractor={item => String(item.id)}
              contentContainerStyle={{ padding: 16, paddingBottom: 100 }}
              refreshControl={<RefreshControl refreshing={false} onRefresh={refetchMenu} tintColor={Colors.primary} />}
              renderItem={({ item }) => {
                const cartItem = cart.find(c => c.menuItem.id === item.id);
                return (
                  <View style={[styles.menuCard, !item.isAvailable && styles.menuCardUnavailable]}>
                    <View style={styles.menuCardContent}>
                      <View style={styles.menuItemInfo}>
                        <Text style={styles.menuItemName}>{item.name}</Text>
                        {item.description ? <Text style={styles.menuItemDesc} numberOfLines={2}>{item.description}</Text> : null}
                        <Text style={styles.menuItemPrice}>{fmtPrice(item.price, item.currency)}</Text>
                      </View>
                      <View style={styles.menuItemActions}>
                        {!item.isAvailable ? (
                          <View style={styles.unavailableBadge}><Text style={styles.unavailableBadgeText}>{t("soldOut")}</Text></View>
                        ) : cartItem ? (
                          <View style={styles.qtyRow}>
                            <TouchableOpacity style={styles.qtyBtn} onPress={() => removeFromCart(item.id)}>
                              <Feather name="minus" size={14} color={Colors.primary} />
                            </TouchableOpacity>
                            <Text style={styles.qtyText}>{cartItem.quantity}</Text>
                            <TouchableOpacity style={styles.qtyBtn} onPress={() => addToCart(item)}>
                              <Feather name="plus" size={14} color={Colors.primary} />
                            </TouchableOpacity>
                          </View>
                        ) : (
                          <TouchableOpacity style={styles.addBtn} onPress={() => addToCart(item)}>
                            <Feather name="plus" size={14} color="#fff" />
                            <Text style={styles.addBtnText}>{t("add")}</Text>
                          </TouchableOpacity>
                        )}
                      </View>
                    </View>
                  </View>
                );
              }}
            />
          )}

          {/* Floating cart button */}
          {cart.length > 0 && (
            <TouchableOpacity style={styles.floatingCart} onPress={() => setShowCart(true)}>
              <View style={styles.floatingCartInner}>
                <View style={styles.floatingCartBadge}><Text style={styles.floatingCartBadgeText}>{cartCount}</Text></View>
                <Text style={styles.floatingCartText}>{t("viewCart")}</Text>
                <Text style={styles.floatingCartTotal}>{fmtPrice(cartTotal)}</Text>
              </View>
            </TouchableOpacity>
          )}
        </View>
      )}

      {/* ORDERS TAB */}
      {activeTab === "orders" && (
        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 100 }}
          refreshControl={<RefreshControl refreshing={ordersLoading} onRefresh={refetchOrders} tintColor={Colors.primary} />}>
          {myOrders.length === 0 ? (
            <View style={styles.centered}>
              <Feather name="clock" size={40} color={Colors.muted} />
              <Text style={styles.emptyText}>{t("noOrders")}</Text>
              <TouchableOpacity onPress={() => setActiveTab("menu")} style={styles.browseBtn}>
                <Text style={styles.browseBtnText}>{t("browseMenu")}</Text>
              </TouchableOpacity>
            </View>
          ) : (
            myOrders.map(order => (
              <View
                key={order.id}
                style={[styles.orderCard, highlightId === order.id && styles.orderCardHighlight]}
                testID={`fb-order-${order.id}`}
              >
                <View style={styles.orderCardHeader}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.orderCardId}>{t("orderRef", { id: order.id })}</Text>
                    <Text style={styles.orderCardDate}>{new Date(order.createdAt).toLocaleString()}</Text>
                    {order.holeNumber && <Text style={styles.orderCardHole}>{t("hole", { n: order.holeNumber })}</Text>}
                  </View>
                  <View style={[styles.statusBadge, { backgroundColor: STATUS_COLORS[order.status] + "22", borderColor: STATUS_COLORS[order.status] }]}>
                    <Text style={[styles.statusBadgeText, { color: STATUS_COLORS[order.status] }]}>{getStatusLabel(order.status)}</Text>
                  </View>
                </View>
                <View style={styles.orderItems}>
                  {order.items.map((item, i) => (
                    <View key={i} style={styles.orderItemRow}>
                      <Text style={styles.orderItemName}>{item.quantity}× {item.name}</Text>
                      <Text style={styles.orderItemPrice}>{fmtPrice(parseFloat(item.price) * item.quantity)}</Text>
                    </View>
                  ))}
                </View>
                <View style={styles.orderCardFooter}>
                  <Text style={styles.orderTotal}>{t("total", { amount: fmtPrice(order.totalAmount) })}</Text>
                  {(order.status === "received" || order.status === "preparing") && (
                    <TouchableOpacity onPress={() => startTracking(order)} style={styles.trackBtn}>
                      <Feather name="eye" size={13} color={Colors.primary} />
                      <Text style={styles.trackBtnText}>{t("track")}</Text>
                    </TouchableOpacity>
                  )}
                </View>
              </View>
            ))
          )}
        </ScrollView>
      )}

      {/* CART MODAL */}
      <Modal visible={showCart} animationType="slide" transparent presentationStyle="overFullScreen">
        <View style={styles.modalOverlay}>
          <View style={styles.modalSheet}>
            <View style={styles.modalHandle} />
            <Text style={styles.modalTitle}>{t("yourCart")}</Text>

            {cart.length === 0 ? (
              <Text style={styles.emptyText}>{t("cartEmpty")}</Text>
            ) : (
              <ScrollView style={{ maxHeight: 280 }}>
                {cart.map(c => (
                  <View key={c.menuItem.id} style={styles.cartItemRow}>
                    <View style={styles.cartItemInfo}>
                      <Text style={styles.cartItemName}>{c.menuItem.name}</Text>
                      <Text style={styles.cartItemPrice}>{fmtPrice(c.menuItem.price, c.menuItem.currency)} {t("eachSuffix")}</Text>
                    </View>
                    <View style={styles.qtyRow}>
                      <TouchableOpacity style={styles.qtyBtn} onPress={() => removeFromCart(c.menuItem.id)}>
                        <Feather name="minus" size={14} color={Colors.primary} />
                      </TouchableOpacity>
                      <Text style={styles.qtyText}>{c.quantity}</Text>
                      <TouchableOpacity style={styles.qtyBtn} onPress={() => addToCart(c.menuItem)}>
                        <Feather name="plus" size={14} color={Colors.primary} />
                      </TouchableOpacity>
                    </View>
                  </View>
                ))}
              </ScrollView>
            )}

            <View style={styles.divider} />

            {/* Hole number */}
            <Text style={styles.inputLabel}>{t("currentHole")}</Text>
            <TextInput
              style={styles.input}
              placeholder={t("holePlaceholder")}
              placeholderTextColor={Colors.muted}
              keyboardType="numeric"
              value={holeNumber}
              onChangeText={setHoleNumber}
              maxLength={2}
            />

            {/* Payment method */}
            <Text style={styles.inputLabel}>{t("payment")}</Text>
            <View style={styles.paymentRow}>
              {([["card_on_delivery", t("cardAtDelivery")], ["account_charge", t("chargeToAccount")]] as const).map(([val, label]) => (
                <TouchableOpacity key={val}
                  style={[styles.paymentOption, paymentMethod === val && styles.paymentOptionActive]}
                  onPress={() => setPaymentMethod(val)}>
                  <Text style={[styles.paymentOptionText, paymentMethod === val && styles.paymentOptionTextActive]}>{label}</Text>
                </TouchableOpacity>
              ))}
            </View>

            {/* Notes */}
            <Text style={styles.inputLabel}>{t("specialInstructions")}</Text>
            <TextInput
              style={[styles.input, { height: 64 }]}
              placeholder={t("allergenPlaceholder")}
              placeholderTextColor={Colors.muted}
              multiline
              value={notes}
              onChangeText={setNotes}
            />

            <View style={styles.cartFooter}>
              <Text style={styles.cartTotalText}>{t("total", { amount: fmtPrice(cartTotal) })}</Text>
              <TouchableOpacity
                style={[styles.placeOrderBtn, (placingOrder || cart.length === 0) && styles.placeOrderBtnDisabled]}
                onPress={placeOrder}
                disabled={placingOrder || cart.length === 0}>
                {placingOrder ? <LoadingSpinner color="#fff" size="small" /> : (
                  <Text style={styles.placeOrderBtnText}>{t("placeOrder")}</Text>
                )}
              </TouchableOpacity>
            </View>

            <TouchableOpacity style={styles.closeBtn} onPress={() => setShowCart(false)}>
              <Text style={styles.closeBtnText}>{t("close")}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* ORDER STATUS MODAL */}
      {trackingOrder && (
        <Modal visible={!!trackingOrder} animationType="fade" transparent presentationStyle="overFullScreen">
          <View style={styles.modalOverlay}>
            <View style={[styles.modalSheet, { paddingBottom: 32 }]}>
              <View style={styles.modalHandle} />
              <Text style={styles.modalTitle}>{t("orderRef", { id: trackingOrder.id })}</Text>

              <View style={[styles.statusCircle, { borderColor: STATUS_COLORS[orderStatus ?? trackingOrder.status] }]}>
                <Feather
                  name={orderStatus === "delivered" ? "check-circle" : orderStatus === "cancelled" ? "x-circle" : "clock"}
                  size={40}
                  color={STATUS_COLORS[orderStatus ?? trackingOrder.status]}
                />
              </View>
              <Text style={[styles.statusLabel, { color: STATUS_COLORS[orderStatus ?? trackingOrder.status] }]}>
                {getStatusLabel(orderStatus ?? trackingOrder.status)}
              </Text>

              <View style={styles.statusSteps}>
                {["received", "preparing", "ready", "delivered"].map((s, i) => {
                  const cur = orderStatus ?? trackingOrder.status;
                  const steps = ["received", "preparing", "ready", "delivered"];
                  const curIdx = steps.indexOf(cur);
                  const active = i <= curIdx;
                  return (
                    <View key={s} style={styles.statusStep}>
                      <View style={[styles.stepDot, active && styles.stepDotActive]} />
                      <Text style={[styles.stepLabel, active && styles.stepLabelActive]}>{getStatusLabel(s)}</Text>
                      {i < 3 && <View style={[styles.stepLine, active && i < curIdx && styles.stepLineActive]} />}
                    </View>
                  );
                })}
              </View>

              <TouchableOpacity style={styles.closeBtn} onPress={() => { setTrackingOrder(null); stopTracking(); }}>
                <Text style={styles.closeBtnText}>{t("close")}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </Modal>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16, paddingBottom: 12 },
  headerTitle: { color: Colors.text, fontSize: 22, fontWeight: "700" },
  headerSubtitle: { color: Colors.textSecondary, fontSize: 13, marginTop: 2 },
  cartBtn: { position: "relative", padding: 8 },
  cartBadge: { position: "absolute", top: 4, right: 4, backgroundColor: Colors.error, borderRadius: 8, minWidth: 16, alignItems: "center", justifyContent: "center", paddingHorizontal: 3 },
  cartBadgeText: { color: "#fff", fontSize: 10, fontWeight: "700" },
  tabBar: { flexDirection: "row", marginHorizontal: 16, backgroundColor: Colors.card, borderRadius: 12, padding: 4, marginBottom: 12, borderWidth: 1, borderColor: Colors.border },
  tab: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, paddingVertical: 8, borderRadius: 10 },
  tabActive: { backgroundColor: Colors.surface },
  tabText: { color: Colors.textSecondary, fontSize: 13, fontWeight: "600" },
  tabTextActive: { color: Colors.primary },
  trackingBanner: { marginHorizontal: 16, marginBottom: 8, flexDirection: "row", alignItems: "center", backgroundColor: Colors.card, borderWidth: 1.5, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, gap: 8 },
  trackingDot: { width: 8, height: 8, borderRadius: 4 },
  trackingText: { flex: 1, color: Colors.text, fontSize: 13, fontWeight: "600" },
  categoryScroll: { marginBottom: 8 },
  categoryChip: { backgroundColor: Colors.card, borderWidth: 1, borderColor: Colors.border, borderRadius: 20, paddingHorizontal: 14, paddingVertical: 7 },
  categoryChipActive: { backgroundColor: Colors.primary + "22", borderColor: Colors.primary },
  categoryChipText: { color: Colors.textSecondary, fontSize: 13, fontWeight: "600" },
  categoryChipTextActive: { color: Colors.primary },
  centered: { flex: 1, alignItems: "center", justifyContent: "center", paddingVertical: 60 },
  emptyText: { color: Colors.textSecondary, fontSize: 14, marginTop: 8, textAlign: "center" },
  menuCard: { backgroundColor: Colors.card, borderRadius: 14, borderWidth: 1, borderColor: Colors.border, marginBottom: 10, overflow: "hidden" },
  menuCardUnavailable: { opacity: 0.5 },
  menuCardContent: { flexDirection: "row", alignItems: "center", padding: 14, gap: 12 },
  menuItemInfo: { flex: 1 },
  menuItemName: { color: Colors.text, fontSize: 15, fontWeight: "600", marginBottom: 2 },
  menuItemDesc: { color: Colors.textSecondary, fontSize: 12, marginBottom: 6, lineHeight: 17 },
  menuItemPrice: { color: Colors.primary, fontSize: 15, fontWeight: "700" },
  menuItemActions: { alignItems: "center" },
  addBtn: { flexDirection: "row", alignItems: "center", gap: 4, backgroundColor: Colors.primary, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 7 },
  addBtnText: { color: "#fff", fontSize: 13, fontWeight: "700" },
  unavailableBadge: { backgroundColor: Colors.card, borderWidth: 1, borderColor: Colors.border, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4 },
  unavailableBadgeText: { color: Colors.textSecondary, fontSize: 11, fontWeight: "600" },
  qtyRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  qtyBtn: { width: 30, height: 30, borderRadius: 15, backgroundColor: Colors.card, borderWidth: 1, borderColor: Colors.primary, alignItems: "center", justifyContent: "center" },
  qtyText: { color: Colors.text, fontSize: 14, fontWeight: "700", minWidth: 20, textAlign: "center" },
  floatingCart: { position: "absolute", bottom: 90, left: 16, right: 16 },
  floatingCartInner: { backgroundColor: Colors.primary, borderRadius: 14, flexDirection: "row", alignItems: "center", paddingVertical: 14, paddingHorizontal: 16, gap: 10 },
  floatingCartBadge: { backgroundColor: "rgba(255,255,255,0.25)", borderRadius: 12, paddingHorizontal: 8, paddingVertical: 2 },
  floatingCartBadgeText: { color: "#fff", fontSize: 12, fontWeight: "700" },
  floatingCartText: { color: "#fff", fontSize: 15, fontWeight: "700", flex: 1 },
  floatingCartTotal: { color: "#fff", fontSize: 15, fontWeight: "700" },
  orderCard: { backgroundColor: Colors.card, borderRadius: 14, borderWidth: 1, borderColor: Colors.border, marginBottom: 12, padding: 14 },
  orderCardHighlight: { borderColor: Colors.primary, borderWidth: 2, backgroundColor: Colors.primary + "1A" },
  orderCardHeader: { flexDirection: "row", alignItems: "flex-start", marginBottom: 10 },
  orderCardId: { color: Colors.text, fontSize: 14, fontWeight: "700" },
  orderCardDate: { color: Colors.textSecondary, fontSize: 11, marginTop: 2 },
  orderCardHole: { color: Colors.textSecondary, fontSize: 11, marginTop: 1 },
  statusBadge: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4 },
  statusBadgeText: { fontSize: 11, fontWeight: "700" },
  orderItems: { borderTopWidth: 1, borderTopColor: Colors.border, paddingTop: 8 },
  orderItemRow: { flexDirection: "row", justifyContent: "space-between", marginBottom: 4 },
  orderItemName: { color: Colors.textSecondary, fontSize: 13 },
  orderItemPrice: { color: Colors.text, fontSize: 13, fontWeight: "600" },
  orderCardFooter: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 10, paddingTop: 10, borderTopWidth: 1, borderTopColor: Colors.border },
  orderTotal: { color: Colors.primary, fontSize: 14, fontWeight: "700" },
  trackBtn: { flexDirection: "row", alignItems: "center", gap: 4 },
  trackBtnText: { color: Colors.primary, fontSize: 12, fontWeight: "600" },
  browseBtn: { marginTop: 12, backgroundColor: Colors.primary, borderRadius: 10, paddingHorizontal: 20, paddingVertical: 10 },
  browseBtnText: { color: "#fff", fontSize: 14, fontWeight: "700" },
  modalOverlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.7)", justifyContent: "flex-end" },
  modalSheet: { backgroundColor: Colors.surface, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 20, maxHeight: "90%" },
  modalHandle: { width: 36, height: 4, backgroundColor: Colors.border, borderRadius: 2, alignSelf: "center", marginBottom: 16 },
  modalTitle: { color: Colors.text, fontSize: 18, fontWeight: "700", marginBottom: 14 },
  cartItemRow: { flexDirection: "row", alignItems: "center", paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: Colors.border },
  cartItemInfo: { flex: 1 },
  cartItemName: { color: Colors.text, fontSize: 14, fontWeight: "600" },
  cartItemPrice: { color: Colors.textSecondary, fontSize: 12, marginTop: 2 },
  divider: { height: 1, backgroundColor: Colors.border, marginVertical: 12 },
  inputLabel: { color: Colors.textSecondary, fontSize: 12, fontWeight: "600", marginBottom: 6, marginTop: 10, textTransform: "uppercase" },
  input: { backgroundColor: Colors.card, borderWidth: 1, borderColor: Colors.border, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, color: Colors.text, fontSize: 14 },
  paymentRow: { flexDirection: "row", gap: 8 },
  paymentOption: { flex: 1, borderWidth: 1.5, borderColor: Colors.border, borderRadius: 10, paddingVertical: 10, alignItems: "center" },
  paymentOptionActive: { borderColor: Colors.primary, backgroundColor: Colors.primary + "15" },
  paymentOptionText: { color: Colors.textSecondary, fontSize: 12, fontWeight: "600", textAlign: "center" },
  paymentOptionTextActive: { color: Colors.primary },
  cartFooter: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 12 },
  cartTotalText: { color: Colors.text, fontSize: 16, fontWeight: "700" },
  placeOrderBtn: { backgroundColor: Colors.primary, borderRadius: 12, paddingHorizontal: 20, paddingVertical: 12 },
  placeOrderBtnDisabled: { opacity: 0.5 },
  placeOrderBtnText: { color: "#fff", fontSize: 15, fontWeight: "700" },
  closeBtn: { marginTop: 12, alignItems: "center", paddingVertical: 10 },
  closeBtnText: { color: Colors.textSecondary, fontSize: 14 },
  statusCircle: { width: 80, height: 80, borderRadius: 40, borderWidth: 2, alignItems: "center", justifyContent: "center", alignSelf: "center", marginVertical: 20 },
  statusLabel: { textAlign: "center", fontSize: 18, fontWeight: "700", marginBottom: 20 },
  statusSteps: { flexDirection: "row", justifyContent: "center", alignItems: "flex-start", gap: 0, marginBottom: 20 },
  statusStep: { alignItems: "center", flex: 1 },
  stepDot: { width: 12, height: 12, borderRadius: 6, backgroundColor: Colors.border, marginBottom: 6 },
  stepDotActive: { backgroundColor: Colors.primary },
  stepLabel: { color: Colors.muted, fontSize: 10, textAlign: "center" },
  stepLabelActive: { color: Colors.primary, fontWeight: "600" },
  stepLine: { position: "absolute", top: 5, left: "50%", right: "-50%", height: 2, backgroundColor: Colors.border },
  stepLineActive: { backgroundColor: Colors.primary },
});
