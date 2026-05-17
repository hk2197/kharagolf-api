import React, { useState, useEffect, useCallback, useRef } from "react";
import {
  Alert,
  FlatList,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import { useLocalSearchParams } from "expo-router";
import Colors from "@/constants/colors";
import { useAuth } from "@/context/auth";
import { useActiveClub } from "@/context/activeClub";
import { BASE_URL } from "@/utils/api";
import { useHighlightFlash, useScrollToHighlight } from "@/hooks/use-highlight";

const GOLD = "#C9A84C";
const GREEN = "#22c55e";
const RED = "#ef4444";

type AssetCondition = "excellent" | "good" | "fair" | "poor" | "damaged" | "retired";
type BookingStatus = "reserved" | "checked_out" | "returned" | "cancelled";

interface AvailabilityItem {
  id: number;
  assetCode: string;
  description: string | null;
  condition: AssetCondition;
  categoryId: number;
  categoryName: string;
  categoryIcon: string;
  effectiveRate: string;
  currency: string;
  available: boolean;
}

interface MyBooking {
  id: number;
  assetId: number;
  assetCode: string;
  assetDescription: string | null;
  categoryName: string;
  memberName: string | null;
  status: BookingStatus;
  rentalDate: string;
  expectedReturnAt: string | null;
  rateCharged: string | null;
  currency: string;
  damageReported: boolean;
}

const CONDITION_LABEL: Record<AssetCondition, string> = {
  excellent: "Excellent",
  good: "Good",
  fair: "Fair",
  poor: "Poor",
  damaged: "Damaged",
  retired: "Retired",
};

const STATUS_LABEL: Record<BookingStatus, string> = {
  reserved: "Reserved",
  checked_out: "Checked Out",
  returned: "Returned",
  cancelled: "Cancelled",
};

const STATUS_COLOR: Record<BookingStatus, string> = {
  reserved: GOLD,
  checked_out: "#f97316",
  returned: GREEN,
  cancelled: "#6b7280",
};

export default function RentalsScreen() {
  const insets = useSafeAreaInsets();
  // Auth context only exposes `token`/`user`; the club comes from the
  // ActiveClubProvider (mirrors how (tabs)/order.tsx wires its rentals/F&B
  // calls). Previously this destructured `portalToken` and `club` which
  // don't exist, leaving `orgId` undefined and the bookings fetch a no-op
  // — so deep-link arrivals from MyUpcomingWidget never loaded the row.
  const { token: portalToken } = useAuth();
  const { activeClub: club } = useActiveClub();

  const params = useLocalSearchParams<{ bookingId?: string }>();
  const { highlightId } = useHighlightFlash(params.bookingId);
  const [tab, setTab] = useState<"browse" | "my-bookings">(highlightId ? "my-bookings" : "browse");
  useEffect(() => {
    if (highlightId != null) setTab("my-bookings");
  }, [highlightId]);
  const myBookingsListRef = useRef<FlatList<MyBooking>>(null);
  const [date, setDate] = useState<string>(new Date().toISOString().slice(0, 10));
  const [availability, setAvailability] = useState<AvailabilityItem[]>([]);
  const [myBookings, setMyBookings] = useState<MyBooking[]>([]);
  const [loading, setLoading] = useState(false);

  const [showBookModal, setShowBookModal] = useState(false);
  const [selectedAsset, setSelectedAsset] = useState<AvailabilityItem | null>(null);
  const [bookName, setBookName] = useState("");
  const [bookNotes, setBookNotes] = useState("");
  const [booking, setBooking] = useState(false);

  const orgId = club?.id;

  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${portalToken}`,
  };

  const fetchAvailability = useCallback(async () => {
    if (!orgId) return;
    setLoading(true);
    try {
      const r = await fetch(`${BASE_URL}/api/organizations/${orgId}/rentals/availability?date=${date}`, {
        headers: { Authorization: `Bearer ${portalToken}` },
      });
      if (r.ok) setAvailability(await r.json());
    } catch {}
    setLoading(false);
  }, [orgId, date, portalToken]);

  const fetchMyBookings = useCallback(async () => {
    if (!orgId) return;
    setLoading(true);
    try {
      const r = await fetch(
        `${BASE_URL}/api/organizations/${orgId}/rentals/my-bookings?status=reserved,checked_out,returned`,
        { headers: { Authorization: `Bearer ${portalToken}` } },
      );
      if (r.ok) setMyBookings(await r.json());
    } catch {}
    setLoading(false);
  }, [orgId, portalToken]);

  useEffect(() => {
    if (tab === "browse") fetchAvailability();
    else fetchMyBookings();
  }, [tab, date, fetchAvailability, fetchMyBookings]);

  function openBook(asset: AvailabilityItem) {
    setSelectedAsset(asset);
    setBookName("");
    setBookNotes("");
    setShowBookModal(true);
  }

  async function confirmBooking() {
    if (!orgId || !selectedAsset) return;
    setBooking(true);
    try {
      const r = await fetch(`${BASE_URL}/api/organizations/${orgId}/rentals/bookings`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          assetId: selectedAsset.id,
          memberName: bookName || null,
          rentalDate: new Date(date).toISOString(),
          rateCharged: selectedAsset.effectiveRate || null,
          currency: selectedAsset.currency,
          notes: bookNotes || null,
        }),
      });
      if (r.ok) {
        setShowBookModal(false);
        Alert.alert("Booked!", `${selectedAsset.assetCode} has been reserved for you.`);
        fetchAvailability();
      } else {
        const err = await r.json();
        Alert.alert("Error", err.error || "Booking failed");
      }
    } catch {
      Alert.alert("Error", "Could not create booking");
    }
    setBooking(false);
  }

  const groupedByCategory = availability.reduce<Record<string, AvailabilityItem[]>>((acc, item) => {
    if (!acc[item.categoryName]) acc[item.categoryName] = [];
    acc[item.categoryName].push(item);
    return acc;
  }, {});

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={styles.header}>
        <Feather name="package" size={22} color={GOLD} />
        <Text style={styles.headerTitle}>Rental Equipment</Text>
      </View>

      {/* Tabs */}
      <View style={styles.tabRow}>
        {(["browse", "my-bookings"] as const).map(t => (
          <Pressable
            key={t}
            style={[styles.tab, tab === t && styles.tabActive]}
            onPress={() => setTab(t)}
          >
            <Text style={[styles.tabText, tab === t && styles.tabTextActive]}>
              {t === "browse" ? "Browse & Book" : "My Bookings"}
            </Text>
          </Pressable>
        ))}
      </View>

      {tab === "browse" && (
        <>
          {/* Date picker */}
          <View style={styles.dateRow}>
            <Feather name="calendar" size={16} color={GOLD} />
            <TextInput
              value={date}
              onChangeText={setDate}
              style={styles.dateInput}
              placeholder="YYYY-MM-DD"
              placeholderTextColor="#6b7280"
              onEndEditing={fetchAvailability}
            />
            <Pressable onPress={fetchAvailability} style={styles.refreshBtn}>
              <Feather name="refresh-cw" size={14} color={GOLD} />
            </Pressable>
          </View>

          {loading ? (
            <LoadingSpinner color={GOLD} style={{ marginTop: 32 }} />
          ) : (
            <ScrollView contentContainerStyle={styles.scroll}>
              {Object.entries(groupedByCategory).map(([catName, items]) => (
                <View key={catName} style={styles.catSection}>
                  <Text style={styles.catTitle}>{catName}</Text>
                  {items.map(item => (
                    <View key={item.id} style={[styles.assetCard, !item.available && styles.assetCardUnavailable]}>
                      <View style={styles.assetLeft}>
                        <Text style={styles.assetCode}>{item.assetCode}</Text>
                        {item.description && <Text style={styles.assetDesc}>{item.description}</Text>}
                        <Text style={styles.assetMeta}>
                          Condition: {CONDITION_LABEL[item.condition]} · {item.currency} {parseFloat(item.effectiveRate).toFixed(2)}/day
                        </Text>
                      </View>
                      {item.available ? (
                        <Pressable style={styles.bookBtn} onPress={() => openBook(item)}>
                          <Text style={styles.bookBtnText}>Book</Text>
                        </Pressable>
                      ) : (
                        <View style={styles.unavailBadge}>
                          <Text style={styles.unavailText}>Booked</Text>
                        </View>
                      )}
                    </View>
                  ))}
                </View>
              ))}
              {!loading && availability.length === 0 && (
                <View style={styles.emptyState}>
                  <Feather name="package" size={40} color="#374151" />
                  <Text style={styles.emptyTitle}>No rental items available</Text>
                  <Text style={styles.emptyDesc}>Check back later or contact the pro shop.</Text>
                </View>
              )}
            </ScrollView>
          )}
        </>
      )}

      {tab === "my-bookings" && (
        <>
          {loading ? (
            <LoadingSpinner color={GOLD} style={{ marginTop: 32 }} />
          ) : (
            <RentalBookingsList
              listRef={myBookingsListRef}
              bookings={myBookings}
              highlightId={highlightId}
            />
          )}
        </>
      )}

      {/* Booking Modal */}
      <Modal visible={showBookModal} animationType="slide" transparent presentationStyle="overFullScreen">
        <View style={styles.modalOverlay}>
          <View style={styles.modalSheet}>
            <View style={styles.modalHandle} />
            <Text style={styles.modalTitle}>Reserve Equipment</Text>
            {selectedAsset && (
              <>
                <View style={styles.modalAssetInfo}>
                  <Text style={styles.modalAssetCode}>{selectedAsset.assetCode}</Text>
                  <Text style={styles.modalAssetCat}>{selectedAsset.categoryName}</Text>
                  <Text style={styles.modalRate}>
                    {selectedAsset.currency} {parseFloat(selectedAsset.effectiveRate).toFixed(2)} / day
                  </Text>
                </View>
                <View style={styles.modalField}>
                  <Text style={styles.modalLabel}>Your Name</Text>
                  <TextInput
                    value={bookName}
                    onChangeText={setBookName}
                    style={styles.modalInput}
                    placeholder="Enter your name"
                    placeholderTextColor="#6b7280"
                  />
                </View>
                <View style={styles.modalField}>
                  <Text style={styles.modalLabel}>Notes (optional)</Text>
                  <TextInput
                    value={bookNotes}
                    onChangeText={setBookNotes}
                    style={styles.modalInput}
                    placeholder="Any special requests?"
                    placeholderTextColor="#6b7280"
                  />
                </View>
                <Text style={styles.modalDateNote}>Booking date: {date}</Text>
              </>
            )}
            <View style={styles.modalActions}>
              <Pressable style={styles.modalCancelBtn} onPress={() => setShowBookModal(false)}>
                <Text style={styles.modalCancelText}>Cancel</Text>
              </Pressable>
              <Pressable style={styles.modalConfirmBtn} onPress={confirmBooking} disabled={booking}>
                {booking ? (
                  <LoadingSpinner color="#000" size="small" />
                ) : (
                  <Text style={styles.modalConfirmText}>Confirm Booking</Text>
                )}
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  header: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 20, paddingVertical: 16, borderBottomWidth: 1, borderBottomColor: "#1f2937" },
  headerTitle: { fontSize: 20, fontWeight: "700", color: "#fff" },
  tabRow: { flexDirection: "row", borderBottomWidth: 1, borderBottomColor: "#1f2937" },
  tab: { flex: 1, alignItems: "center", paddingVertical: 12 },
  tabActive: { borderBottomWidth: 2, borderBottomColor: GOLD },
  tabText: { fontSize: 13, color: "#9ca3af", fontWeight: "500" },
  tabTextActive: { color: "#fff" },
  dateRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: "#1f2937" },
  dateInput: { flex: 1, color: "#fff", fontSize: 14, fontFamily: "monospace" },
  refreshBtn: { padding: 6, borderRadius: 8, backgroundColor: "#1f2937" },
  scroll: { padding: 16, gap: 16 },
  catSection: { gap: 8 },
  catTitle: { fontSize: 13, fontWeight: "600", color: GOLD, textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 4 },
  assetCard: { backgroundColor: "#111827", borderRadius: 12, padding: 14, flexDirection: "row", alignItems: "center", justifyContent: "space-between", borderWidth: 1, borderColor: "#1f2937" },
  assetCardUnavailable: { opacity: 0.6 },
  assetLeft: { flex: 1, gap: 2 },
  assetCode: { fontSize: 15, fontWeight: "700", color: "#fff" },
  assetDesc: { fontSize: 12, color: "#9ca3af" },
  assetMeta: { fontSize: 11, color: "#6b7280", marginTop: 2 },
  bookBtn: { backgroundColor: GOLD, borderRadius: 8, paddingHorizontal: 14, paddingVertical: 8, marginLeft: 12 },
  bookBtnText: { color: "#000", fontWeight: "700", fontSize: 13 },
  unavailBadge: { backgroundColor: "#374151", borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6, marginLeft: 12 },
  unavailText: { color: "#9ca3af", fontSize: 12, fontWeight: "600" },
  emptyState: { alignItems: "center", paddingVertical: 60, gap: 12 },
  emptyTitle: { fontSize: 16, fontWeight: "600", color: "#9ca3af" },
  emptyDesc: { fontSize: 13, color: "#6b7280", textAlign: "center", paddingHorizontal: 40 },
  bookingCard: { backgroundColor: "#111827", borderRadius: 12, padding: 14, gap: 4, borderWidth: 1, borderColor: "#1f2937", marginBottom: 10 },
  bookingCardHighlight: { borderColor: GOLD, borderWidth: 2, backgroundColor: GOLD + "1A" },
  bookingHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  bookingCode: { fontSize: 16, fontWeight: "700", color: "#fff" },
  statusBadge: { borderRadius: 20, borderWidth: 1, paddingHorizontal: 10, paddingVertical: 3 },
  statusText: { fontSize: 12, fontWeight: "600" },
  bookingCat: { fontSize: 12, color: "#9ca3af" },
  bookingDate: { fontSize: 12, color: "#6b7280", marginTop: 2 },
  bookingRate: { fontSize: 12, color: GOLD, marginTop: 2 },
  damageBadge: { flexDirection: "row", alignItems: "center", gap: 4, marginTop: 4 },
  damageText: { fontSize: 11, color: RED },
  modalOverlay: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.7)" },
  modalSheet: { backgroundColor: "#111827", borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 24, gap: 16 },
  modalHandle: { width: 40, height: 4, backgroundColor: "#374151", borderRadius: 2, alignSelf: "center", marginBottom: 8 },
  modalTitle: { fontSize: 18, fontWeight: "700", color: "#fff", textAlign: "center" },
  modalAssetInfo: { backgroundColor: "#1f2937", borderRadius: 12, padding: 14, gap: 4 },
  modalAssetCode: { fontSize: 17, fontWeight: "700", color: "#fff" },
  modalAssetCat: { fontSize: 13, color: "#9ca3af" },
  modalRate: { fontSize: 14, color: GOLD, fontWeight: "600", marginTop: 4 },
  modalField: { gap: 6 },
  modalLabel: { fontSize: 12, color: "#9ca3af", fontWeight: "500" },
  modalInput: { backgroundColor: "#1f2937", borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10, color: "#fff", fontSize: 14, borderWidth: 1, borderColor: "#374151" },
  modalDateNote: { fontSize: 12, color: "#6b7280", textAlign: "center" },
  modalActions: { flexDirection: "row", gap: 12, marginTop: 4 },
  modalCancelBtn: { flex: 1, backgroundColor: "#1f2937", borderRadius: 12, paddingVertical: 14, alignItems: "center" },
  modalCancelText: { color: "#9ca3af", fontWeight: "600" },
  modalConfirmBtn: { flex: 2, backgroundColor: GOLD, borderRadius: 12, paddingVertical: 14, alignItems: "center" },
  modalConfirmText: { color: "#000", fontWeight: "700", fontSize: 15 },
});

const getRentalBookingId = (b: MyBooking) => b.id;

function RentalBookingsList({
  listRef,
  bookings,
  highlightId,
}: {
  listRef: React.RefObject<FlatList<MyBooking> | null>;
  bookings: MyBooking[];
  highlightId: number | null;
}) {
  useScrollToHighlight<MyBooking>(listRef, bookings, highlightId, getRentalBookingId);
  return (
    <FlatList
      ref={listRef}
      data={bookings}
      keyExtractor={b => String(b.id)}
      contentContainerStyle={styles.scroll}
      onScrollToIndexFailed={({ index, averageItemLength }) => {
        listRef.current?.scrollToOffset({
          offset: averageItemLength * index,
          animated: true,
        });
      }}
      ListEmptyComponent={
        <View style={styles.emptyState}>
          <Feather name="clock" size={40} color="#374151" />
          <Text style={styles.emptyTitle}>No bookings yet</Text>
          <Text style={styles.emptyDesc}>Browse and reserve rental equipment from the Browse tab.</Text>
        </View>
      }
      renderItem={({ item: b }) => {
        const isHighlight = highlightId === b.id;
        return (
          <View
            style={[styles.bookingCard, isHighlight && styles.bookingCardHighlight]}
            testID={`rental-booking-${b.id}`}
          >
            <View style={styles.bookingHeader}>
              <Text style={styles.bookingCode}>{b.assetCode}</Text>
              <View style={[styles.statusBadge, { borderColor: STATUS_COLOR[b.status] + "60" }]}>
                <Text style={[styles.statusText, { color: STATUS_COLOR[b.status] }]}>{STATUS_LABEL[b.status]}</Text>
              </View>
            </View>
            <Text style={styles.bookingCat}>{b.categoryName}</Text>
            <Text style={styles.bookingDate}>
              {new Date(b.rentalDate).toLocaleDateString()}
              {b.expectedReturnAt ? ` → ${new Date(b.expectedReturnAt).toLocaleDateString()}` : ""}
            </Text>
            {b.rateCharged && (
              <Text style={styles.bookingRate}>{b.currency} {parseFloat(b.rateCharged).toFixed(2)}</Text>
            )}
            {b.damageReported && (
              <View style={styles.damageBadge}>
                <Feather name="alert-triangle" size={12} color={RED} />
                <Text style={styles.damageText}>Damage reported</Text>
              </View>
            )}
          </View>
        );
      }}
    />
  );
}
