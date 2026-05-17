import React, { useState, useEffect, useCallback } from "react";
import {
  Alert,
  FlatList,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import Colors from "@/constants/colors";
import { useAuth } from "@/context/auth";
import { BASE_URL } from "@/utils/api";
import { getLocale } from "@/i18n";

const GOLD = "#C9A84C";

interface Trip {
  id: number;
  name: string;
  destination: string;
  externalCourseName: string;
  description: string | null;
  startDate: string;
  endDate: string;
  status: string;
  maxParticipants: number | null;
  depositAmount: string | null;
  currency: string;
  estimatedTotalCost: string | null;
  notes: string | null;
}

interface Participant {
  id: number;
  firstName: string;
  lastName: string;
  email: string | null;
  handicapIndex: string | null;
  status: string;
  depositStatus: string;
}

interface ItineraryItem {
  id: number;
  dayNumber: number;
  startTime: string | null;
  endTime: string | null;
  type: string;
  title: string;
  location: string | null;
  description: string | null;
}

interface Room {
  id: number;
  roomName: string;
  roomType: string | null;
  costPerNight: string | null;
  nights: number | null;
  participantIds: number[];
}

interface Car {
  id: number;
  carLabel: string;
  totalCost: string | null;
  participantIds: number[];
}

interface TeeSlot {
  id: number;
  roundDay: number;
  teeTime: string;
  holeStart: number;
  participantIds: number[];
}

interface LeaderboardEntry {
  participantId: number;
  firstName: string;
  lastName: string;
  handicapIndex: string | null;
  totalStrokes: number | null;
  holesPlayed: number;
  roundsPlayed: number;
  position: number | null;
}

interface Settlement {
  participantId: number;
  name: string;
  totalOwed: number;
  totalPaid: number;
  balance: number;
}

const ITEM_TYPE_ICONS: Record<string, string> = {
  travel: "send",
  golf_round: "flag",
  dinner: "coffee",
  accommodation: "home",
  activity: "activity",
  free_time: "clock",
};

const ITEM_TYPE_LABELS: Record<string, string> = {
  travel: "Travel",
  golf_round: "Golf Round",
  dinner: "Dinner",
  accommodation: "Accommodation",
  activity: "Activity",
  free_time: "Free Time",
};

const STATUS_COLORS: Record<string, string> = {
  draft: Colors.textSecondary,
  open: "#60A5FA",
  confirmed: "#34D399",
  completed: "#A78BFA",
  cancelled: "#F87171",
};

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString(getLocale(), { day: "numeric", month: "short", year: "numeric" });
}

function formatDateShort(iso: string) {
  return new Date(iso).toLocaleDateString(getLocale(), { day: "numeric", month: "short" });
}

function useFetch<T>(url: string | null): { data: T | null; loading: boolean; refresh: () => void } {
  const { token } = useAuth();
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(false);

  const fetch_ = useCallback(async () => {
    if (!url) return;
    setLoading(true);
    try {
      const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (r.ok) setData(await r.json());
    } finally {
      setLoading(false);
    }
  }, [url, token]);

  useEffect(() => { fetch_(); }, [fetch_]);

  return { data, loading, refresh: fetch_ };
}

type TabKey = "itinerary" | "myGroup" | "costs" | "leaderboard";

function TripDetailModal({
  trip,
  orgId,
  myParticipantId,
  visible,
  onClose,
}: {
  trip: Trip;
  orgId: number;
  myParticipantId: number | null;
  visible: boolean;
  onClose: () => void;
}) {
  const { token } = useAuth();
  const insets = useSafeAreaInsets();
  const [tab, setTab] = useState<TabKey>("itinerary");

  const { data: itinerary, loading: loadingItinerary } = useFetch<ItineraryItem[]>(
    visible ? `${BASE_URL}api/organizations/${orgId}/trips/${trip.id}/itinerary` : null
  );

  const { data: rooms } = useFetch<Room[]>(
    visible ? `${BASE_URL}api/organizations/${orgId}/trips/${trip.id}/rooms` : null
  );

  const { data: cars } = useFetch<Car[]>(
    visible ? `${BASE_URL}api/organizations/${orgId}/trips/${trip.id}/cars` : null
  );

  const { data: teeSlots } = useFetch<TeeSlot[]>(
    visible ? `${BASE_URL}api/organizations/${orgId}/trips/${trip.id}/tee-slots` : null
  );

  const { data: participants } = useFetch<Participant[]>(
    visible ? `${BASE_URL}api/organizations/${orgId}/trips/${trip.id}/participants` : null
  );

  const { data: expensesData } = useFetch<{ expenses: unknown[]; settlement: Settlement[] }>(
    visible ? `${BASE_URL}api/organizations/${orgId}/trips/${trip.id}/expenses` : null
  );

  const { data: leaderboardData } = useFetch<{ leaderboard: LeaderboardEntry[] }>(
    visible ? `${BASE_URL}api/organizations/${orgId}/trips/${trip.id}/leaderboard` : null
  );

  const getParticipantName = (id: number) => {
    const p = (participants ?? []).find(x => x.id === id);
    return p ? `${p.firstName} ${p.lastName}` : `#${id}`;
  };

  const myRoom = (rooms ?? []).find(r => myParticipantId && r.participantIds.includes(myParticipantId));
  const myCar = (cars ?? []).find(c => myParticipantId && c.participantIds.includes(myParticipantId));
  const myTeeSlots = (teeSlots ?? []).filter(s => myParticipantId && s.participantIds.includes(myParticipantId));
  const mySettlement = myParticipantId
    ? (expensesData?.settlement ?? []).find(s => s.participantId === myParticipantId) ?? null
    : null;

  const groupedItinerary: Record<number, ItineraryItem[]> = {};
  for (const item of (itinerary ?? [])) {
    if (!groupedItinerary[item.dayNumber]) groupedItinerary[item.dayNumber] = [];
    groupedItinerary[item.dayNumber].push(item);
  }

  const startDate = new Date(trip.startDate);
  const getDayDate = (day: number) => {
    const d = new Date(startDate);
    d.setDate(d.getDate() + day - 1);
    return d.toLocaleDateString(getLocale(), { weekday: "short", day: "numeric", month: "short" });
  };

  const sym = trip.currency === "USD" ? "$" : trip.currency === "GBP" ? "£" : "₹";

  const tabs: { key: TabKey; label: string; icon: string }[] = [
    { key: "itinerary", label: "Itinerary", icon: "list" },
    { key: "myGroup", label: "My Group", icon: "users" },
    { key: "costs", label: "Costs", icon: "dollar-sign" },
    { key: "leaderboard", label: "Scores", icon: "bar-chart-2" },
  ];

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={[styles.modalContainer, { paddingTop: insets.top }]}>
        <View style={styles.modalHeader}>
          <View style={{ flex: 1 }}>
            <Text style={styles.modalTitle}>{trip.name}</Text>
            <Text style={styles.modalSubtitle}>{trip.destination} · {trip.externalCourseName}</Text>
          </View>
          <Pressable onPress={onClose} style={styles.closeBtn}>
            <Feather name="x" size={22} color={Colors.text} />
          </Pressable>
        </View>

        {/* Info strip */}
        <View style={styles.infoStrip}>
          <View style={styles.infoItem}>
            <Feather name="calendar" size={14} color={Colors.textSecondary} />
            <Text style={styles.infoText}>{formatDateShort(trip.startDate)} – {formatDateShort(trip.endDate)}</Text>
          </View>
          <View style={[styles.statusBadge, { backgroundColor: `${STATUS_COLORS[trip.status]}22` }]}>
            <Text style={[styles.statusText, { color: STATUS_COLORS[trip.status] }]}>{trip.status}</Text>
          </View>
        </View>

        {/* Tabs */}
        <View style={styles.tabBar}>
          {tabs.map(t => (
            <Pressable
              key={t.key}
              style={[styles.tabItem, tab === t.key && styles.tabItemActive]}
              onPress={() => setTab(t.key)}
            >
              <Feather name={t.icon as any} size={14} color={tab === t.key ? GOLD : Colors.textSecondary} />
              <Text style={[styles.tabLabel, tab === t.key && styles.tabLabelActive]}>{t.label}</Text>
            </Pressable>
          ))}
        </View>

        <ScrollView style={styles.modalScroll} contentContainerStyle={{ paddingBottom: insets.bottom + 20 }}>
          {/* ITINERARY TAB */}
          {tab === "itinerary" && (
            <View style={styles.tabContent}>
              {loadingItinerary ? (
                <LoadingSpinner color={GOLD} style={{ marginTop: 32 }} />
              ) : Object.keys(groupedItinerary).length === 0 ? (
                <Text style={styles.emptyText}>No itinerary items yet</Text>
              ) : (
                Object.entries(groupedItinerary)
                  .sort(([a], [b]) => Number(a) - Number(b))
                  .map(([day, items]) => (
                    <View key={day} style={{ marginBottom: 16 }}>
                      <Text style={styles.dayHeader}>Day {day} — {getDayDate(Number(day))}</Text>
                      {items.map(item => (
                        <View key={item.id} style={styles.itineraryItem}>
                          <Feather
                            name={(ITEM_TYPE_ICONS[item.type] ?? "circle") as any}
                            size={16}
                            color={GOLD}
                            style={{ marginTop: 2 }}
                          />
                          <View style={{ flex: 1 }}>
                            <Text style={styles.itineraryTitle}>{item.title}</Text>
                            <View style={styles.itineraryMeta}>
                              {item.startTime ? (
                                <Text style={styles.itineraryMetaText}>
                                  {item.startTime}{item.endTime ? ` – ${item.endTime}` : ""}
                                </Text>
                              ) : null}
                              {item.location ? (
                                <Text style={styles.itineraryMetaText}>· {item.location}</Text>
                              ) : null}
                            </View>
                            {item.description ? (
                              <Text style={styles.itineraryDesc}>{item.description}</Text>
                            ) : null}
                          </View>
                          <View style={styles.typeBadge}>
                            <Text style={styles.typeBadgeText}>{ITEM_TYPE_LABELS[item.type]}</Text>
                          </View>
                        </View>
                      ))}
                    </View>
                  ))
              )}
            </View>
          )}

          {/* MY GROUP TAB */}
          {tab === "myGroup" && (
            <View style={styles.tabContent}>
              {/* Room */}
              <Text style={styles.sectionHeader}>Room Assignment</Text>
              {myRoom ? (
                <View style={styles.groupCard}>
                  <Feather name="home" size={18} color={GOLD} />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.groupCardTitle}>{myRoom.roomName}</Text>
                    {myRoom.roomType && <Text style={styles.groupCardSub}>{myRoom.roomType}</Text>}
                    <Text style={styles.groupCardSub}>
                      Sharing with: {myRoom.participantIds.filter(id => id !== myParticipantId).map(getParticipantName).join(", ") || "Solo"}
                    </Text>
                    {myRoom.costPerNight && myRoom.nights && (
                      <Text style={styles.groupCardSub}>
                        Cost: {sym}{(parseFloat(myRoom.costPerNight) * myRoom.nights / myRoom.participantIds.length).toFixed(2)} per person
                      </Text>
                    )}
                  </View>
                </View>
              ) : (
                <Text style={styles.emptyText}>No room assignment yet</Text>
              )}

              {/* Car */}
              <Text style={[styles.sectionHeader, { marginTop: 20 }]}>Transport</Text>
              {myCar ? (
                <View style={styles.groupCard}>
                  <Feather name="truck" size={18} color={GOLD} />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.groupCardTitle}>{myCar.carLabel}</Text>
                    <Text style={styles.groupCardSub}>
                      Travelling with: {myCar.participantIds.filter(id => id !== myParticipantId).map(getParticipantName).join(", ") || "Solo"}
                    </Text>
                    {myCar.totalCost && (
                      <Text style={styles.groupCardSub}>
                        Cost: {sym}{(parseFloat(myCar.totalCost) / myCar.participantIds.length).toFixed(2)} per person
                      </Text>
                    )}
                  </View>
                </View>
              ) : (
                <Text style={styles.emptyText}>No transport assignment yet</Text>
              )}

              {/* Tee times */}
              <Text style={[styles.sectionHeader, { marginTop: 20 }]}>Tee Times</Text>
              {myTeeSlots.length === 0 ? (
                <Text style={styles.emptyText}>No tee time assignments yet</Text>
              ) : (
                myTeeSlots.map(slot => (
                  <View key={slot.id} style={styles.groupCard}>
                    <Feather name="flag" size={18} color={GOLD} />
                    <View style={{ flex: 1 }}>
                      <Text style={styles.groupCardTitle}>Day {slot.roundDay} — {slot.teeTime}</Text>
                      <Text style={styles.groupCardSub}>Hole {slot.holeStart} start</Text>
                      <Text style={styles.groupCardSub}>
                        Group: {slot.participantIds.map(getParticipantName).join(", ")}
                      </Text>
                    </View>
                  </View>
                ))
              )}
            </View>
          )}

          {/* COSTS TAB */}
          {tab === "costs" && (
            <View style={styles.tabContent}>
              {mySettlement ? (
                <>
                  <View style={styles.costSummaryCard}>
                    <Text style={styles.costSummaryLabel}>My Share</Text>
                    <Text style={styles.costSummaryAmount}>{sym}{mySettlement.totalOwed.toFixed(2)}</Text>
                  </View>
                  <View style={styles.costSummaryCard}>
                    <Text style={styles.costSummaryLabel}>I've Paid</Text>
                    <Text style={styles.costSummaryAmount}>{sym}{mySettlement.totalPaid.toFixed(2)}</Text>
                  </View>
                  <View style={[styles.costSummaryCard, { borderColor: mySettlement.balance >= 0 ? "#34D399" : "#F87171" }]}>
                    <Text style={styles.costSummaryLabel}>Balance</Text>
                    <Text style={[styles.costSummaryAmount, { color: mySettlement.balance >= 0 ? "#34D399" : "#F87171" }]}>
                      {mySettlement.balance >= 0 ? "+" : ""}{sym}{mySettlement.balance.toFixed(2)}
                    </Text>
                  </View>
                </>
              ) : (
                <Text style={styles.emptyText}>No cost information available</Text>
              )}
              {trip.depositAmount && (
                <View style={[styles.costSummaryCard, { marginTop: 16 }]}>
                  <Text style={styles.costSummaryLabel}>Deposit Required</Text>
                  <Text style={styles.costSummaryAmount}>{sym}{parseFloat(trip.depositAmount).toFixed(2)}</Text>
                </View>
              )}
            </View>
          )}

          {/* LEADERBOARD TAB */}
          {tab === "leaderboard" && (
            <View style={styles.tabContent}>
              {(leaderboardData?.leaderboard ?? []).length === 0 ? (
                <Text style={styles.emptyText}>No scores recorded yet</Text>
              ) : (
                <>
                  <Text style={styles.sectionHeader}>{trip.externalCourseName}</Text>
                  {(leaderboardData?.leaderboard ?? []).map((entry, idx) => (
                    <View
                      key={entry.participantId}
                      style={[
                        styles.leaderboardRow,
                        myParticipantId === entry.participantId && styles.leaderboardRowHighlight,
                      ]}
                    >
                      <Text style={[styles.leaderboardPos, !entry.position && { color: Colors.textSecondary }]}>
                        {entry.position ?? "—"}
                      </Text>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.leaderboardName}>
                          {entry.firstName} {entry.lastName}
                          {myParticipantId === entry.participantId ? " (You)" : ""}
                        </Text>
                        <Text style={styles.leaderboardMeta}>
                          {entry.roundsPlayed} round{entry.roundsPlayed !== 1 ? "s" : ""} · {entry.holesPlayed} holes
                        </Text>
                      </View>
                      <Text style={styles.leaderboardScore}>
                        {entry.totalStrokes !== null ? `${entry.totalStrokes}` : "—"}
                      </Text>
                    </View>
                  ))}
                </>
              )}
            </View>
          )}
        </ScrollView>
      </View>
    </Modal>
  );
}

export default function TripsScreen() {
  const insets = useSafeAreaInsets();
  const { user, token } = useAuth();
  const [trips, setTrips] = useState<Trip[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedTrip, setSelectedTrip] = useState<Trip | null>(null);
  const [participants, setParticipants] = useState<Participant[]>([]);

  const orgId = user?.organizationId;

  const loadTrips = useCallback(async () => {
    if (!orgId) return;
    setLoading(true);
    try {
      const r = await fetch(`${BASE_URL}api/organizations/${orgId}/trips`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (r.ok) setTrips(await r.json());
    } finally {
      setLoading(false);
    }
  }, [orgId, token]);

  useEffect(() => { loadTrips(); }, [loadTrips]);

  const loadParticipantsForTrip = useCallback(async (tripId: number) => {
    if (!orgId) return;
    const r = await fetch(`${BASE_URL}api/organizations/${orgId}/trips/${tripId}/participants`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (r.ok) setParticipants(await r.json());
  }, [orgId, token]);

  const handleSelectTrip = (trip: Trip) => {
    setSelectedTrip(trip);
    loadParticipantsForTrip(trip.id);
  };

  const myParticipantId = user?.id
    ? (participants.find(p => p.email === user.email)?.id ?? null)
    : null;

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Golf Trips</Text>
        <Pressable onPress={loadTrips} style={styles.refreshBtn}>
          <Feather name="refresh-cw" size={18} color={Colors.textSecondary} />
        </Pressable>
      </View>

      {loading ? (
        <View style={styles.loadingContainer}>
          <LoadingSpinner size="large" color={GOLD} />
        </View>
      ) : trips.length === 0 ? (
        <View style={styles.emptyContainer}>
          <Feather name="map-pin" size={48} color={Colors.textSecondary} />
          <Text style={styles.emptyTitle}>No trips planned</Text>
          <Text style={styles.emptySubtitle}>Your club hasn't scheduled any away days yet</Text>
        </View>
      ) : (
        <FlatList
          data={trips}
          keyExtractor={t => String(t.id)}
          contentContainerStyle={{ padding: 16 }}
          ItemSeparatorComponent={() => <View style={{ height: 12 }} />}
          renderItem={({ item: trip }) => (
            <Pressable style={styles.tripCard} onPress={() => handleSelectTrip(trip)}>
              <View style={styles.tripCardHeader}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.tripName}>{trip.name}</Text>
                  <View style={styles.tripMeta}>
                    <Feather name="map-pin" size={12} color={Colors.textSecondary} />
                    <Text style={styles.tripMetaText}>{trip.destination}</Text>
                  </View>
                </View>
                <View style={[styles.statusBadge, { backgroundColor: `${STATUS_COLORS[trip.status]}22` }]}>
                  <Text style={[styles.statusText, { color: STATUS_COLORS[trip.status] }]}>
                    {trip.status}
                  </Text>
                </View>
              </View>
              <View style={styles.tripDetails}>
                <View style={styles.tripDetailItem}>
                  <Feather name="flag" size={13} color={Colors.textSecondary} />
                  <Text style={styles.tripDetailText}>{trip.externalCourseName}</Text>
                </View>
                <View style={styles.tripDetailItem}>
                  <Feather name="calendar" size={13} color={Colors.textSecondary} />
                  <Text style={styles.tripDetailText}>
                    {formatDateShort(trip.startDate)} – {formatDateShort(trip.endDate)}
                  </Text>
                </View>
                {trip.depositAmount && (
                  <View style={styles.tripDetailItem}>
                    <Feather name="credit-card" size={13} color={Colors.textSecondary} />
                    <Text style={styles.tripDetailText}>
                      Deposit: {trip.currency} {trip.depositAmount}
                    </Text>
                  </View>
                )}
              </View>
              <View style={styles.tripCardFooter}>
                <Text style={styles.viewDetailsText}>View details</Text>
                <Feather name="chevron-right" size={16} color={GOLD} />
              </View>
            </Pressable>
          )}
        />
      )}

      {selectedTrip && orgId && (
        <TripDetailModal
          trip={selectedTrip}
          orgId={orgId}
          myParticipantId={myParticipantId}
          visible={!!selectedTrip}
          onClose={() => setSelectedTrip(null)}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  headerTitle: {
    fontSize: 22,
    fontWeight: "700",
    color: Colors.text,
  },
  refreshBtn: {
    padding: 8,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
  },
  emptyContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 32,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: "600",
    color: Colors.text,
  },
  emptySubtitle: {
    fontSize: 14,
    color: Colors.textSecondary,
    textAlign: "center",
  },
  tripCard: {
    backgroundColor: Colors.surface,
    borderRadius: 14,
    padding: 16,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  tripCardHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 12,
    marginBottom: 12,
  },
  tripName: {
    fontSize: 17,
    fontWeight: "700",
    color: Colors.text,
    marginBottom: 4,
  },
  tripMeta: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  tripMetaText: {
    fontSize: 13,
    color: Colors.textSecondary,
  },
  statusBadge: {
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  statusText: {
    fontSize: 11,
    fontWeight: "600",
    textTransform: "capitalize",
  },
  tripDetails: {
    gap: 6,
    marginBottom: 12,
  },
  tripDetailItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  tripDetailText: {
    fontSize: 13,
    color: Colors.textSecondary,
  },
  tripCardFooter: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: 4,
    borderTopWidth: 1,
    borderTopColor: Colors.border,
    paddingTop: 10,
  },
  viewDetailsText: {
    fontSize: 13,
    color: GOLD,
    fontWeight: "600",
  },
  // Modal styles
  modalContainer: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  modalHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
    gap: 12,
  },
  modalTitle: {
    fontSize: 20,
    fontWeight: "700",
    color: Colors.text,
  },
  modalSubtitle: {
    fontSize: 13,
    color: Colors.textSecondary,
    marginTop: 2,
  },
  closeBtn: {
    padding: 6,
    marginTop: 2,
  },
  infoStrip: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingVertical: 10,
    backgroundColor: Colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  infoItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  infoText: {
    fontSize: 13,
    color: Colors.textSecondary,
  },
  tabBar: {
    flexDirection: "row",
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
    gap: 4,
  },
  tabItem: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    paddingVertical: 8,
    borderRadius: 8,
  },
  tabItemActive: {
    backgroundColor: `${GOLD}22`,
  },
  tabLabel: {
    fontSize: 11,
    color: Colors.textSecondary,
    fontWeight: "500",
  },
  tabLabelActive: {
    color: GOLD,
    fontWeight: "700",
  },
  modalScroll: {
    flex: 1,
  },
  tabContent: {
    padding: 16,
  },
  emptyText: {
    fontSize: 14,
    color: Colors.textSecondary,
    textAlign: "center",
    marginTop: 32,
  },
  dayHeader: {
    fontSize: 13,
    fontWeight: "700",
    color: Colors.textSecondary,
    marginBottom: 8,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  itineraryItem: {
    flexDirection: "row",
    gap: 12,
    backgroundColor: Colors.surface,
    borderRadius: 10,
    padding: 12,
    marginBottom: 6,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  itineraryTitle: {
    fontSize: 15,
    fontWeight: "600",
    color: Colors.text,
  },
  itineraryMeta: {
    flexDirection: "row",
    gap: 4,
    marginTop: 2,
  },
  itineraryMetaText: {
    fontSize: 12,
    color: Colors.textSecondary,
  },
  itineraryDesc: {
    fontSize: 12,
    color: Colors.textSecondary,
    marginTop: 4,
  },
  typeBadge: {
    backgroundColor: "rgba(255,255,255,0.06)",
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 2,
    alignSelf: "flex-start",
  },
  typeBadgeText: {
    fontSize: 10,
    color: Colors.textSecondary,
    fontWeight: "600",
  },
  sectionHeader: {
    fontSize: 13,
    fontWeight: "700",
    color: Colors.textSecondary,
    marginBottom: 10,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  groupCard: {
    flexDirection: "row",
    gap: 12,
    backgroundColor: Colors.surface,
    borderRadius: 10,
    padding: 14,
    borderWidth: 1,
    borderColor: Colors.border,
    marginBottom: 8,
  },
  groupCardTitle: {
    fontSize: 15,
    fontWeight: "600",
    color: Colors.text,
  },
  groupCardSub: {
    fontSize: 12,
    color: Colors.textSecondary,
    marginTop: 3,
  },
  costSummaryCard: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    backgroundColor: Colors.surface,
    borderRadius: 10,
    padding: 14,
    borderWidth: 1,
    borderColor: Colors.border,
    marginBottom: 8,
  },
  costSummaryLabel: {
    fontSize: 14,
    color: Colors.textSecondary,
  },
  costSummaryAmount: {
    fontSize: 18,
    fontWeight: "700",
    color: Colors.text,
  },
  leaderboardRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: Colors.surface,
    borderRadius: 10,
    padding: 12,
    marginBottom: 6,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  leaderboardRowHighlight: {
    borderColor: GOLD,
    backgroundColor: `${GOLD}11`,
  },
  leaderboardPos: {
    fontSize: 18,
    fontWeight: "700",
    color: GOLD,
    width: 28,
    textAlign: "center",
  },
  leaderboardName: {
    fontSize: 15,
    fontWeight: "600",
    color: Colors.text,
  },
  leaderboardMeta: {
    fontSize: 12,
    color: Colors.textSecondary,
    marginTop: 2,
  },
  leaderboardScore: {
    fontSize: 16,
    fontWeight: "700",
    color: Colors.text,
  },
});
