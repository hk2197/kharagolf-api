import { Feather, Ionicons } from "@expo/vector-icons";
import { useQuery } from "@tanstack/react-query";
import * as ImagePicker from "expo-image-picker";
import { useRouter } from "expo-router";
import { Video, ResizeMode } from "expo-av";
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Alert,
  Dimensions,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Colors from "@/constants/colors";
import { useAuth } from "@/context/auth";
import { BASE_URL, fetchPublic } from "@/utils/api";
import MemberAvatar from "@/components/MemberAvatar";
import ConsentPrompt from "@/components/ConsentPrompt";
import { StripeCheckoutModal, stripeModuleAvailable } from "@/components/StripeCheckoutModal";
import NationalLaddersCard from "@/components/national-ladders-card";
import { PriceWithFx } from "@/components/PriceWithFx";
import { LeagueCard } from "@/components/LeagueCard";
import { usePrewarmPublicProfileHandles } from "@/hooks/usePublicProfileHandle";
import { getLocale } from "@/i18n";

// Native Razorpay SDK — loaded dynamically to gracefully handle Expo Go
// (native module not available in managed workflow without a custom dev build).
let RazorpayCheckout: {
  open: (opts: LeagueRzpOptions) => Promise<LeagueRzpSuccess>;
} | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  RazorpayCheckout = require("react-native-razorpay").default;
} catch {
  RazorpayCheckout = null;
}

interface LeagueRzpOptions {
  key: string;
  order_id: string;
  amount: number;
  currency: string;
  name: string;
  description: string;
  prefill?: { email?: string; name?: string };
}
interface LeagueRzpSuccess {
  razorpay_payment_id: string;
  razorpay_order_id: string;
  razorpay_signature: string;
}

interface MyLeagueMembership {
  memberId: number;
  leagueId: number;
  paymentStatus: string;
  paymentLinkUrl: string | null;
  leagueCurrency: string | null;
  leagueEntryFee: string | null;
}

const QUICK_EMOJIS = ["👍", "❤️", "😂", "🎉", "🏌️", "⛳"];

const CURRENCY_SYMBOLS: Record<string, string> = {
  INR: "₹", USD: "$", GBP: "£", AED: "د.إ", EUR: "€", SGD: "S$", AUD: "A$",
};
function fmtFee(entryFee: string | null, currency: string | null): string {
  if (!entryFee || Number(entryFee) <= 0) return "";
  const sym = CURRENCY_SYMBOLS[currency ?? "INR"] ?? (currency ?? "");
  return `${sym}${Number(entryFee).toFixed(2)}`;
}

interface League {
  id: number;
  name: string;
  description: string | null;
  format: string;
  type: string;
  status: string;
  seasonStart: string | null;
  seasonEnd: string | null;
  maxMembers: number | null;
  entryFee: string | null;
  currency: string | null;
  handicapAllowance: number | null;
  roundsCount: number | null;
  organizationId: number;
}

interface GalleryItem {
  id: number;
  objectPath: string;
  thumbnailPath: string | null;
  caption: string | null;
  uploaderName: string | null;
  uploadedByUserId: number | null;
  mediaType: string;
  approved: boolean;
  createdAt: string;
}

interface ChatMessage {
  id: number;
  displayName: string;
  body: string;
  messageType: string;
  mediaId: number | null;
  mediaThumbnailPath?: string | null;
  mediaObjectPath?: string | null;
  reactions: Record<string, number[]>;
  isPinned: boolean;
  createdAt: string;
}

interface ChatRoomState {
  roomId: number | null;
  enabled: boolean;
  organizationId: number | null;
  messages: ChatMessage[];
}

const FORMAT_LABELS: Record<string, string> = {
  stroke_play: "Stroke Play",
  stableford: "Stableford",
  match_play: "Match Play",
  scramble: "Scramble",
  best_ball: "Best Ball",
  skins: "Skins",
  four_ball: "Four Ball",
  foursomes: "Foursomes",
  net_stroke: "Net Stroke",
};

const TYPE_LABELS: Record<string, string> = {
  club: "Club",
  corporate: "Corporate",
  charity: "Charity",
  social: "Social",
  professional: "Pro",
};

const STATUS_COLORS: Record<string, string> = {
  active: Colors.primary,
  upcoming: Colors.secondary,
  completed: Colors.muted,
  cancelled: Colors.error,
};

// `LeagueCard` lives in components/LeagueCard.tsx so the FX-aware entry-fee
// row can be regression-tested in isolation (Task #955), mirroring the
// LockerRenewalCard extraction pattern.

function EmptyState() {
  return (
    <View style={styles.emptyState}>
      <Ionicons name="trophy-outline" size={52} color={Colors.muted} />
      <Text style={styles.emptyTitle}>No Public Leagues</Text>
      <Text style={styles.emptySubtitle}>Public leagues will appear here once they are published.</Text>
    </View>
  );
}

type DetailTab = "overview" | "members" | "standings" | "rounds" | "fixtures" | "gallery" | "chat" | "documents";

interface StandingRow {
  id: number; memberId: number;
  // Task #2239 — appUsersTable.id of the linked user (null when the
  // league member is a guest entry not yet attached to a user account).
  // Surfaced by GET /api/public/leagues/:leagueId/standings so each
  // per-player standings row can navigate into the public profile
  // viewer (or the private member fallback) for that player.
  userId: number | null;
  roundsPlayed: number; won: number; drawn: number; lost: number;
  totalPoints: number; totalGross: number; totalNet: number; totalStableford: number; bestScore: number | null;
  position: number; firstName: string; lastName: string; handicapIndex: string | null; teamName: string | null;
  profileImage?: string | null;
}
interface RoundRow {
  id: number; leagueId: number; roundNumber: number; name: string | null;
  scheduledDate: string | null; status: string; tournamentId: number | null;
}
interface MemberRow {
  id: number;
  // Task #1457 — appUsersTable.id of the linked user (null when the
  // league member is a guest entry not yet attached to a user account).
  // Surfaced by GET /api/public/leagues/:leagueId/members so the row can
  // navigate into the public profile viewer.
  userId: number | null;
  firstName: string; lastName: string;
  handicapIndex: string | null; teamName: string | null; joinedAt: string; paymentStatus: string;
  profileImage?: string | null;
}
interface FixtureMember {
  id: number;
  // Task #2240 — appUsersTable.id of the linked user (null when the
  // league member is a guest entry not yet attached to a user account).
  // Surfaced by GET /api/public/leagues/:leagueId/fixtures so each
  // home/away name on a fixture card can navigate into the public
  // profile viewer (or the private member fallback).
  userId: number | null;
  firstName: string;
  lastName: string;
}
interface FixtureRow {
  id: number; leagueId: number; roundNumber: number; homeId: number; awayId: number;
  homeScore: number | null; awayScore: number | null; result: string | null;
  notes: string | null; scheduledDate: string | null; isPlayed: boolean;
  home: FixtureMember | null; away: FixtureMember | null;
}
interface RoundResultRow {
  id: number; memberId: number;
  // Task #1791 — appUsersTable.id of the linked user (null when the
  // league member is a guest entry not yet attached to a user account).
  // Surfaced by GET /api/public/leagues/:leagueId/rounds/:roundId/results
  // so the round-result row can navigate into the public profile viewer.
  userId: number | null;
  grossScore: number | null; netScore: number | null;
  stablefordPoints: number | null; matchResult: string | null;
  firstName: string; lastName: string; handicapIndex: string | null;
  profileImage?: string | null;
}

function RoundResultCard({ leagueId, round, isMatchPlay, isStableford }: {
  leagueId: number; round: RoundRow; isMatchPlay: boolean; isStableford: boolean;
}) {
  const router = useRouter();
  const [expanded, setExpanded] = useState(false);
  const { data: results, isLoading } = useQuery<RoundResultRow[]>({
    queryKey: ["round-results", leagueId, round.id],
    queryFn: () => fetchPublic<RoundResultRow[]>(`/leagues/${leagueId}/rounds/${round.id}/results`),
    staleTime: 60000,
    enabled: expanded,
  });
  const statusColor = round.status === "completed" ? "#22c55e"
    : round.status === "cancelled" ? Colors.error
    : Colors.secondary;
  return (
    <Pressable
      onPress={() => { if (round.status === "completed") setExpanded(e => !e); }}
      style={styles.roundCard}
    >
      <View style={styles.roundNumberBadge}>
        <Text style={styles.roundNumberText}>R{round.roundNumber}</Text>
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.roundName} numberOfLines={1}>
          {round.name ?? `Round ${round.roundNumber}`}
        </Text>
        {round.scheduledDate ? (
          <Text style={styles.roundDate}>
            {new Date(round.scheduledDate).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}
          </Text>
        ) : null}
        {/* Expanded results summary */}
        {expanded && round.status === "completed" && (
          <View style={styles.roundExpanded}>
            {isLoading ? (
              <LoadingSpinner size="small" color={Colors.primary} style={{ marginTop: 8 }} />
            ) : !results || results.length === 0 ? (
              <Text style={styles.roundExpandedEmpty}>No scores recorded for this round.</Text>
            ) : (
              <>
                <Text style={styles.roundExpandedTitle}>Top Scores</Text>
                {results
                  .sort((a, b) => {
                    if (isStableford) return (b.stablefordPoints ?? 0) - (a.stablefordPoints ?? 0);
                    return (a.grossScore ?? 999) - (b.grossScore ?? 999);
                  })
                  .slice(0, 5)
                  .map((r, i) => {
                    // Task #1791 — tapping a scorer's name opens the
                    // public profile viewer (or the private member
                    // fallback) for parity with the league members tab.
                    const fullName = `${r.firstName} ${r.lastName}`.trim();
                    const goToProfile = () => {
                      if (r.userId == null) return;
                      router.push({
                        pathname: "/member/[userId]",
                        params: {
                          userId: String(r.userId),
                          displayName: fullName,
                          avatar: r.profileImage ?? "",
                        },
                      });
                    };
                    return (
                      <View key={r.id} style={styles.roundExpandedRow}>
                        <Text style={styles.roundExpandedPos}>{i + 1}.</Text>
                        <MemberAvatar profileImage={r.profileImage} firstName={r.firstName} lastName={r.lastName} size={24} />
                        {r.userId != null ? (
                          <Pressable
                            onPress={goToProfile}
                            hitSlop={6}
                            style={{ flex: 1 }}
                            accessibilityRole="link"
                            accessibilityLabel={`Open ${fullName}'s profile`}
                            testID={`round-result-name-${r.userId}`}
                          >
                            <Text style={styles.roundExpandedName}>{r.firstName} {r.lastName}</Text>
                          </Pressable>
                        ) : (
                          <Text style={styles.roundExpandedName}>{r.firstName} {r.lastName}</Text>
                        )}
                        <Text style={styles.roundExpandedScore}>
                          {isStableford ? `${r.stablefordPoints ?? "—"} pts`
                            : isMatchPlay ? (r.matchResult ?? "—")
                            : r.grossScore != null ? `${r.grossScore}` : "—"}
                        </Text>
                      </View>
                    );
                  })}
              </>
            )}
          </View>
        )}
      </View>
      <View style={{ alignItems: "flex-end", gap: 4 }}>
        <View style={[styles.roundStatusBadge, { borderColor: statusColor + "60", backgroundColor: statusColor + "18" }]}>
          <Text style={[styles.roundStatusText, { color: statusColor }]}>
            {round.status.charAt(0).toUpperCase() + round.status.slice(1)}
          </Text>
        </View>
        {round.status === "completed" && (
          <Feather name={expanded ? "chevron-up" : "chevron-down"} size={14} color={Colors.muted} />
        )}
      </View>
    </Pressable>
  );
}

function LeagueDetailModal({ league, onClose }: { league: League; onClose: () => void }) {
  const insets = useSafeAreaInsets();
  const { token, user } = useAuth();
  const router = useRouter();
  const [tab, setTab] = useState<DetailTab>("overview");
  const tabScrollRef = useRef<ScrollView>(null);
  const tabXPositions = useRef<Partial<Record<DetailTab, number>>>({});

  // ── Membership / payment state ────────────────────────────────
  const [myMembership, setMyMembership] = useState<MyLeagueMembership | null>(null);
  const [payLoading, setPayLoading] = useState(false);
  const [stripeCheckout, setStripeCheckout] = useState<{
    publishableKey: string; clientSecret: string; paymentIntentId: string; merchantDisplayName: string;
  } | null>(null);

  useEffect(() => {
    if (!token) return;
    fetch(`${BASE_URL}/api/portal/my-leagues`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => r.json())
      .then((rows: MyLeagueMembership[]) => {
        const match = rows.find(r => r.leagueId === league.id);
        setMyMembership(match ?? null);
      })
      .catch(() => {/* ignore */});
  }, [league.id, token]);

  async function handlePayLeague() {
    if (!token || !myMembership) return;
    setPayLoading(true);
    try {
      const orderRes = await fetch(`${BASE_URL}/api/portal/league-member/${myMembership.memberId}/order`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      });
      const orderData = await orderRes.json() as {
        processor?: "razorpay" | "stripe";
        orderId?: string; amount?: number; currency?: string; keyId?: string;
        stripePublishableKey?: string; clientSecret?: string;
        name?: string; memberName?: string; email?: string; error?: string;
      };
      if (!orderRes.ok || !orderData.orderId) {
        Alert.alert("Payment Error", orderData.error ?? "Could not create payment order.");
        return;
      }

      // ── Stripe path (non-INR clubs) ──────────────────────────────────
      if (orderData.processor === "stripe") {
        if (!orderData.stripePublishableKey || !orderData.clientSecret) {
          Alert.alert("Payment Error", "Stripe checkout is missing required configuration."); return;
        }
        if (!stripeModuleAvailable) {
          if (myMembership.paymentLinkUrl) {
            await Linking.openURL(myMembership.paymentLinkUrl);
          } else {
            Alert.alert("Payment", "Card payments require a production build. Please use the website to complete this payment.");
          }
          return;
        }
        setStripeCheckout({
          publishableKey: orderData.stripePublishableKey,
          clientSecret: orderData.clientSecret,
          paymentIntentId: orderData.orderId,
          merchantDisplayName: orderData.name ?? "League Entry Fee",
        });
        return;
      }

      if (RazorpayCheckout) {
        const opts: LeagueRzpOptions = {
          key: orderData.keyId!,
          order_id: orderData.orderId,
          amount: orderData.amount!,
          currency: orderData.currency!,
          name: orderData.name ?? "KHARAGOLF",
          description: "League Entry Fee",
          prefill: { name: orderData.memberName, email: orderData.email },
        };
        const payment = await RazorpayCheckout.open(opts);
        const verifyRes = await fetch(`${BASE_URL}/api/payments/league-member/${myMembership.memberId}/verify`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            razorpay_payment_id: payment.razorpay_payment_id,
            razorpay_order_id: payment.razorpay_order_id,
            razorpay_signature: payment.razorpay_signature,
          }),
        });
        if (verifyRes.ok) {
          setMyMembership(prev => prev ? { ...prev, paymentStatus: "paid" } : prev);
          Alert.alert("Payment Successful", "Your league entry fee has been received!");
        } else {
          const vd = await verifyRes.json() as { error?: string };
          Alert.alert("Verification Failed", vd.error ?? "Payment received but verification failed. Contact the organiser.");
        }
      } else {
        // Fallback: payment link (Expo Go)
        if (myMembership.paymentLinkUrl) {
          await Linking.openURL(myMembership.paymentLinkUrl);
        } else {
          const linkRes = await fetch(`${BASE_URL}/api/portal/league-member/${myMembership.memberId}/payment-link`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          });
          const linkData = await linkRes.json() as { url?: string; error?: string };
          if (!linkRes.ok || !linkData.url) {
            Alert.alert("Payment Error", linkData.error ?? "Could not generate payment link.");
            return;
          }
          await Linking.openURL(linkData.url);
        }
      }
    } catch (err: unknown) {
      const msg = err !== null && typeof err === "object" && "message" in err
        ? String((err as { message: unknown }).message)
        : "Network error. Please try again.";
      if (msg.toLowerCase().includes("cancel")) return;
      Alert.alert("Payment Error", msg);
    } finally {
      setPayLoading(false);
    }
  }

  // ── Gallery state ──────────────────────────────────────────────
  const [galleryItems, setGalleryItems] = useState<GalleryItem[]>([]);
  const [galleryLoading, setGalleryLoading] = useState(false);
  const [galleryError, setGalleryError] = useState<string | null>(null);
  const [galleryUploading, setGalleryUploading] = useState(false);
  // Task #620 — friendly consent prompt when API blocks photo/video uploads.
  const [consentPrompt, setConsentPrompt] = useState<{ message: string; category: string } | null>(null);
  const [galleryCaption, setGalleryCaption] = useState("");
  const [lightboxItem, setLightboxItem] = useState<GalleryItem | null>(null);

  const loadGallery = useCallback(async () => {
    if (!token) { setGalleryError("Sign in to view league gallery"); return; }
    setGalleryLoading(true);
    setGalleryError(null);
    try {
      const r = await fetch(
        `${BASE_URL}/api/organizations/${league.organizationId}/media?leagueId=${league.id}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (r.status === 403) { setGalleryError("League membership required to view gallery"); return; }
      if (!r.ok) throw new Error("Failed to load gallery");
      setGalleryItems(await r.json());
    } catch {
      setGalleryError("Unable to load gallery");
    } finally {
      setGalleryLoading(false);
    }
  }, [league.id, league.organizationId, token]);

  useEffect(() => { if (tab === "gallery") loadGallery(); }, [tab, loadGallery]);

  const uploadAsset = useCallback(async (asset: ImagePicker.ImagePickerAsset) => {
    if (!token) return;
    const mimeType = asset.mimeType ?? (asset.type === "video" ? "video/mp4" : "image/jpeg");
    const mediaType = mimeType.startsWith("video/") ? "video" : "image";
    if (mediaType === "video" && asset.duration && asset.duration > 60000) {
      Alert.alert("Too long", "Videos must be 60 seconds or shorter."); return;
    }
    if (asset.fileSize && asset.fileSize > 100 * 1024 * 1024) {
      Alert.alert("Too large", "File must be under 100 MB."); return;
    }
    setGalleryUploading(true);
    try {
      const fileName = asset.uri.split("/").pop() ?? (mediaType === "video" ? "video.mp4" : "photo.jpg");
      const urlRes = await fetch(`${BASE_URL}/api/organizations/${league.organizationId}/media/upload-url`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ fileName, contentType: mimeType, leagueId: league.id }),
      });
      if (!urlRes.ok) {
        // Task #469 / Task #620 — when consent for photos or videos has been
        // withdrawn the API returns 403 with code "CONSENT_REQUIRED". Surface
        // the friendly ConsentPrompt component (matches CaddieCard / Caddie
        // Insights) on native, falling back to a basic alert on web.
        const body = await urlRes.json().catch(() => ({} as { code?: string; consentRequired?: { message?: string } }));
        if (urlRes.status === 403 && body.code === "CONSENT_REQUIRED") {
          const consentMessage = body.consentRequired?.message ?? "Consent required to upload media.";
          const category = mediaType === "video" ? "video" : "photo";
          if (Platform.OS === "web") {
            Alert.alert(
              "Consent required",
              consentMessage,
              [
                { text: "Cancel", style: "cancel" },
                { text: "Open Consent Settings", onPress: () => router.push("/my-360/consents") },
              ],
            );
          } else {
            setConsentPrompt({ message: consentMessage, category });
          }
          return;
        }
        Alert.alert("Error", "Could not get upload URL");
        return;
      }
      const { uploadURL, objectPath, uploadToken } = await urlRes.json() as { uploadURL: string; objectPath: string; uploadToken: string };
      const blob = await fetch(asset.uri).then(r => r.blob());
      const putRes = await fetch(uploadURL, { method: "PUT", body: blob, headers: { "Content-Type": mimeType } });
      if (!putRes.ok) { Alert.alert("Error", "Upload failed"); return; }
      const regRes = await fetch(`${BASE_URL}/api/organizations/${league.organizationId}/media`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ objectPath, uploadToken, caption: galleryCaption.trim() || null, leagueId: league.id }),
      });
      if (!regRes.ok) {
        const err = await regRes.json().catch(() => ({})) as { error?: string };
        Alert.alert("Error", err.error ?? "Registration failed");
        return;
      }
      setGalleryCaption("");
      await loadGallery();
      Alert.alert("Uploaded", `${mediaType === "video" ? "Video" : "Photo"} uploaded! It will appear once approved.`);
    } catch (e: unknown) {
      Alert.alert("Error", (e as Error).message ?? "Upload failed");
    } finally {
      setGalleryUploading(false);
    }
  }, [token, league.id, league.organizationId, galleryCaption, loadGallery, router]);

  const pickAndUpload = useCallback(async () => {
    if (!token) { Alert.alert("Sign in", "Please sign in to upload photos."); return; }
    Alert.alert("Add to Gallery", "Choose a source", [
      {
        text: "📷 Camera",
        onPress: async () => {
          const perm = await ImagePicker.requestCameraPermissionsAsync();
          if (!perm.granted) { Alert.alert("Permission required", "Camera permission is required."); return; }
          const result = await ImagePicker.launchCameraAsync({ mediaTypes: ImagePicker.MediaTypeOptions.All, quality: 0.85, videoMaxDuration: 60 });
          if (!result.canceled && result.assets.length) await uploadAsset(result.assets[0]);
        },
      },
      {
        text: "🖼 Photo Library",
        onPress: async () => {
          const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
          if (!perm.granted) { Alert.alert("Permission required", "Media library permission is required."); return; }
          const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ImagePicker.MediaTypeOptions.All, quality: 0.85, videoMaxDuration: 60 });
          if (!result.canceled && result.assets.length) await uploadAsset(result.assets[0]);
        },
      },
      { text: "Cancel", style: "cancel" },
    ]);
  }, [token, uploadAsset]);

  const deleteOwnItem = useCallback(async (item: GalleryItem) => {
    Alert.alert("Delete", "Remove this item from the gallery?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete", style: "destructive",
        onPress: async () => {
          const r = await fetch(`${BASE_URL}/api/organizations/${league.organizationId}/media/${item.id}`, {
            method: "DELETE",
            headers: { Authorization: `Bearer ${token}` },
          });
          if (r.ok) await loadGallery();
          else Alert.alert("Error", "Could not delete. Please try again.");
        },
      },
    ]);
  }, [league.organizationId, token, loadGallery]);

  // ── Chat state ─────────────────────────────────────────────────
  const [chatRoom, setChatRoom] = useState<ChatRoomState | null>(null);
  const [chatLoading, setChatLoading] = useState(false);
  const [chatInput, setChatInput] = useState("");
  const [chatSending, setChatSending] = useState(false);
  const sseAbortRef = useRef<AbortController | null>(null);
  const chatScrollRef = useRef<ScrollView>(null);

  const connectSSE = useCallback(async (roomId: number, authToken: string) => {
    if (sseAbortRef.current) sseAbortRef.current.abort();
    const ctrl = new AbortController();
    sseAbortRef.current = ctrl;
    try {
      const res = await fetch(`${BASE_URL}/api/sse/chat/${roomId}`, {
        headers: { Authorization: `Bearer ${authToken}` },
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) return;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const parts = buf.split("\n\n");
        buf = parts.pop() ?? "";
        for (const part of parts) {
          for (const line of part.split("\n")) {
            if (!line.startsWith("data: ")) continue;
            try {
              const payload = JSON.parse(line.slice(6)) as { type: string; data: ChatMessage & { id?: number; roomId?: number } };
              if (payload.type === "chat_message") {
                setChatRoom(prev => {
                  if (!prev) return prev;
                  if (prev.messages.some(m => m.id === payload.data.id)) return prev;
                  return { ...prev, messages: [...prev.messages, payload.data] };
                });
              } else if (payload.type === "chat_message_deleted") {
                setChatRoom(prev => {
                  if (!prev) return prev;
                  return { ...prev, messages: prev.messages.filter(m => m.id !== payload.data.id) };
                });
              } else if (payload.type === "chat_cleared") {
                setChatRoom(prev => prev ? { ...prev, messages: [] } : prev);
              }
            } catch { /* ignore */ }
          }
        }
      }
    } catch (e: unknown) {
      if ((e as Error)?.name !== "AbortError" && !ctrl.signal.aborted) {
        setTimeout(() => connectSSE(roomId, authToken), 5000);
      }
    }
  }, []);

  const loadChat = useCallback(async () => {
    if (!token) return;
    setChatLoading(true);
    try {
      const res = await fetch(
        `${BASE_URL}/api/organizations/${league.organizationId}/chat/league/${league.id}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (!res.ok) throw new Error("chat fetch failed");
      const data = await res.json() as { room: { id: number; enabled: boolean; organizationId: number }; messages: ChatMessage[] };
      setChatRoom({ roomId: data.room.id, enabled: data.room.enabled, organizationId: data.room.organizationId, messages: data.messages });
    } catch { /* silent */ } finally { setChatLoading(false); }
  }, [league.id, league.organizationId, token]);

  useEffect(() => { if (tab === "chat" && !chatRoom) loadChat(); }, [tab, chatRoom, loadChat]);
  // Eagerly load chat room status on mount so tab can reflect enabled/disabled
  useEffect(() => { if (token && !chatRoom) loadChat(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (chatRoom?.roomId && token && chatRoom.enabled) {
      connectSSE(chatRoom.roomId, token);
    }
    return () => { if (sseAbortRef.current) { sseAbortRef.current.abort(); sseAbortRef.current = null; } };
  }, [chatRoom?.roomId, chatRoom?.enabled, token, connectSSE]);

  useEffect(() => {
    if (tab === "chat") {
      setTimeout(() => chatScrollRef.current?.scrollToEnd({ animated: false }), 100);
    }
  }, [tab, chatRoom?.messages.length]);

  const sendMessage = async () => {
    const body = chatInput.trim();
    if (!body || !token || !chatRoom?.roomId || !chatRoom.organizationId) return;
    setChatSending(true);
    setChatInput("");
    try {
      await fetch(`${BASE_URL}/api/organizations/${chatRoom.organizationId}/chat/league/${league.id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ body }),
      });
    } catch { /* silent */ } finally { setChatSending(false); }
  };

  const imgUrl = (item: GalleryItem) => {
    const p = item.mediaType === "video" && item.thumbnailPath ? item.thumbnailPath : item.objectPath;
    return `${BASE_URL}/api/storage${p}`;
  };

  // ── Standings / Rounds / Members data ─────────────────────────
  const { data: standings, isLoading: standingsLoading } = useQuery<StandingRow[]>({
    queryKey: ["league-standings", league.id],
    queryFn: () => fetchPublic<StandingRow[]>(`/leagues/${league.id}/standings`),
    staleTime: 30000,
  });

  const isTeamFormat = league.type === "team" || league.type === "pairs";
  const { data: teamStandings } = useQuery<any[]>({
    queryKey: ["league-team-standings", league.id],
    queryFn: () => fetchPublic<any[]>(`/leagues/${league.id}/standings/teams`),
    staleTime: 30000,
    refetchInterval: 30000,
    enabled: isTeamFormat,
  });

  const { data: rounds, isLoading: roundsLoading } = useQuery<RoundRow[]>({
    queryKey: ["league-rounds", league.id],
    queryFn: () => fetchPublic<RoundRow[]>(`/leagues/${league.id}/rounds`),
    staleTime: 30000,
  });

  const { data: members, isLoading: membersLoading } = useQuery<MemberRow[]>({
    queryKey: ["league-members", league.id],
    queryFn: () => fetchPublic<MemberRow[]>(`/leagues/${league.id}/members`),
    staleTime: 30000,
  });

  // Task #2234 — pre-warm the userId → public-handle cache for every
  // league member with a linked user account so the *first* tap on a
  // row in the Members tab opens the public profile (or the private
  // member fallback) without a centred spinner. The same cache entries
  // are reused by `usePublicProfileHandle` on the /member/[userId]
  // resolver screen (matching query key), so the tap is a synchronous
  // hit even on the very first navigation.
  const memberUserIds = React.useMemo(() => {
    if (!members) return [] as number[];
    const ids: number[] = [];
    for (const m of members) {
      if (typeof m.userId === "number") ids.push(m.userId);
    }
    return ids;
  }, [members]);
  usePrewarmPublicProfileHandles(memberUserIds);

  // Task #2239 — pre-warm the userId → public-handle cache for every
  // per-player standings row with a linked user account too, so the
  // *first* tap on a name in the Standings tab opens the public profile
  // (or the private member fallback) without a centred spinner. Mirrors
  // the affordance already wired up on the Members tab (Task #2234).
  const standingsUserIds = React.useMemo(() => {
    if (!standings) return [] as number[];
    const ids: number[] = [];
    for (const s of standings) {
      if (typeof s.userId === "number") ids.push(s.userId);
    }
    return ids;
  }, [standings]);
  usePrewarmPublicProfileHandles(standingsUserIds);

  const { data: fixtures, isLoading: fixturesLoading } = useQuery<FixtureRow[]>({
    queryKey: ["league-fixtures", league.id],
    queryFn: () => fetchPublic<FixtureRow[]>(`/leagues/${league.id}/fixtures`),
    staleTime: 30000,
    enabled: league.format === "match_play",
  });

  const isMatchPlay = league.format === "match_play";
  const isStableford = ["stableford", "better_ball", "alliance", "waltz"].includes(league.format ?? "");
  const isNet = ["net_stroke", "scramble", "shamble"].includes(league.format ?? "");
  const isOOM = league.format === "order_of_merit";

  async function finalizeLeagueStripePayment(paymentIntentId: string) {
    if (!token || !myMembership) { setStripeCheckout(null); return; }
    try {
      const verifyRes = await fetch(`${BASE_URL}/api/payments/league-member/${myMembership.memberId}/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ stripe_payment_intent_id: paymentIntentId }),
      });
      if (verifyRes.ok) {
        setMyMembership(prev => prev ? { ...prev, paymentStatus: "paid" } : prev);
        Alert.alert("Payment Successful", "Your league entry fee has been received!");
      } else {
        const vd = await verifyRes.json().catch(() => ({})) as { error?: string };
        Alert.alert("Verification Failed", vd.error ?? "Payment received but verification failed. Contact the organiser.");
      }
    } finally {
      setStripeCheckout(null);
    }
  }

  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={[styles.modalContainer, { paddingTop: insets.top || 16 }]}>
        {stripeCheckout && (
          <StripeCheckoutModal
            visible
            publishableKey={stripeCheckout.publishableKey}
            clientSecret={stripeCheckout.clientSecret}
            paymentIntentId={stripeCheckout.paymentIntentId}
            merchantDisplayName={stripeCheckout.merchantDisplayName}
            onSuccess={(intentId) => { void finalizeLeagueStripePayment(intentId); }}
            onCancel={() => setStripeCheckout(null)}
            onError={(msg) => { setStripeCheckout(null); Alert.alert("Payment Error", msg); }}
          />
        )}
        {/* Modal header */}
        <View style={styles.modalHeader}>
          <Pressable onPress={onClose} style={styles.closeBtn} hitSlop={8}>
            <Ionicons name="chevron-down" size={22} color={Colors.text} />
          </Pressable>
          <Text style={styles.modalTitle} numberOfLines={1}>{league.name}</Text>
          <View style={{ width: 36 }} />
        </View>

        {/* Payment banner — visible when player has an unpaid league entry fee */}
        {myMembership && myMembership.paymentStatus === "unpaid" && myMembership.leagueEntryFee && (
          <View style={styles.payBanner}>
            <Feather name="alert-circle" size={14} color="#f59e0b" style={{ marginRight: 8 }} />
            <View style={{ flex: 1 }}>
              <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap" }}>
                <PriceWithFx
                  orgId={league.organizationId}
                  token={token}
                  amount={myMembership.leagueEntryFee}
                  currency={myMembership.leagueCurrency ?? "INR"}
                  productClass="league_entry"
                  bookedStyle={styles.payBannerText}
                  showDisclosure={false}
                  disclosureOnHover
                />
                <Text style={styles.payBannerText}> entry fee outstanding</Text>
              </View>
            </View>
            <Pressable
              onPress={handlePayLeague}
              disabled={payLoading}
              style={[styles.payBannerBtn, payLoading && { opacity: 0.5 }]}
            >
              {payLoading
                ? <LoadingSpinner size="small" color="#000" />
                : <Text style={styles.payBannerBtnText}>
                    Pay {fmtFee(myMembership.leagueEntryFee, myMembership.leagueCurrency)}
                  </Text>}
            </Pressable>
          </View>
        )}

        {/* Tabs — 7-tab horizontal scroll chip bar with snap-to-active */}
        <ScrollView
          ref={tabScrollRef}
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.tabsScroll}
          contentContainerStyle={styles.tabsScrollContent}
        >
          {(["overview", "members", "standings", "rounds", "fixtures", "gallery", "chat", "documents"] as DetailTab[]).map(t => {
            const icons: Record<DetailTab, string> = {
              overview: "info", members: "users", standings: "bar-chart-2", rounds: "calendar",
              fixtures: "list", gallery: "image", chat: "message-circle", documents: "file-text",
            } as const;
            const labels: Record<DetailTab, string> = {
              overview: "Overview", members: "Members", standings: "Standings", rounds: "Rounds",
              fixtures: "Fixtures", gallery: "Gallery", chat: "Chat", documents: "Docs",
            } as const;
            const dimmed = (t === "chat" && chatRoom !== null && !chatRoom.enabled) ||
              (t === "fixtures" && !isMatchPlay);
            return (
              <Pressable
                key={t}
                onPress={() => {
                  setTab(t);
                  const x = tabXPositions.current[t] ?? 0;
                  tabScrollRef.current?.scrollTo({ x: Math.max(0, x - 20), animated: true });
                }}
                onLayout={(e) => { tabXPositions.current[t] = e.nativeEvent.layout.x; }}
                style={[styles.tabBtn, tab === t && styles.tabBtnActive, dimmed && { opacity: 0.45 }]}
              >
                <Feather name={icons[t] as never} size={14} color={tab === t ? Colors.primary : Colors.textSecondary} />
                <Text style={[styles.tabLabel, tab === t && styles.tabLabelActive]}>{labels[t]}</Text>
                {t === "members" && members && members.length > 0 && (
                  <View style={styles.tabCountBadge}>
                    <Text style={styles.tabCountText}>{members.length}</Text>
                  </View>
                )}
              </Pressable>
            );
          })}
        </ScrollView>

        {/* Overview tab */}
        {tab === "overview" && (
          <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }} showsVerticalScrollIndicator={false}>
            {/* Format / Type / Status row */}
            <View style={styles.overviewCard}>
              <Text style={styles.overviewSectionTitle}>League Info</Text>
              <View style={styles.overviewRow}>
                <View style={styles.overviewItem}>
                  <Text style={styles.overviewLabel}>Format</Text>
                  <Text style={styles.overviewValue}>{FORMAT_LABELS[league.format] ?? league.format}</Text>
                </View>
                <View style={styles.overviewItem}>
                  <Text style={styles.overviewLabel}>Type</Text>
                  <Text style={styles.overviewValue}>{TYPE_LABELS[league.type] ?? league.type}</Text>
                </View>
                <View style={styles.overviewItem}>
                  <Text style={styles.overviewLabel}>Status</Text>
                  <Text style={[styles.overviewValue, { color: STATUS_COLORS[league.status] ?? Colors.muted }]}>
                    {league.status.charAt(0).toUpperCase() + league.status.slice(1)}
                  </Text>
                </View>
              </View>
            </View>

            {/* Season dates */}
            <View style={styles.overviewCard}>
              <Text style={styles.overviewSectionTitle}>Season</Text>
              <View style={styles.overviewRow}>
                {league.seasonStart ? (
                  <View style={styles.overviewItem}>
                    <Text style={styles.overviewLabel}>Start</Text>
                    <Text style={styles.overviewValue}>
                      {new Date(league.seasonStart).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}
                    </Text>
                  </View>
                ) : null}
                {league.seasonEnd ? (
                  <View style={styles.overviewItem}>
                    <Text style={styles.overviewLabel}>End</Text>
                    <Text style={styles.overviewValue}>
                      {new Date(league.seasonEnd).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}
                    </Text>
                  </View>
                ) : null}
                {!league.seasonStart && !league.seasonEnd ? (
                  <Text style={styles.overviewNone}>Season dates not set</Text>
                ) : null}
              </View>
            </View>

            {/* Key stats */}
            <View style={styles.overviewCard}>
              <Text style={styles.overviewSectionTitle}>Details</Text>
              <View style={styles.overviewRow}>
                {league.roundsCount ? (
                  <View style={styles.overviewItem}>
                    <Text style={styles.overviewLabel}>Rounds</Text>
                    <Text style={styles.overviewValue}>{league.roundsCount}</Text>
                  </View>
                ) : null}
                {league.handicapAllowance !== null ? (
                  <View style={styles.overviewItem}>
                    <Text style={styles.overviewLabel}>Handicap</Text>
                    <Text style={styles.overviewValue}>{league.handicapAllowance}%</Text>
                  </View>
                ) : null}
                {league.maxMembers ? (
                  <View style={styles.overviewItem}>
                    <Text style={styles.overviewLabel}>Max Members</Text>
                    <Text style={styles.overviewValue}>{league.maxMembers}</Text>
                  </View>
                ) : null}
              </View>
              {league.entryFee && Number(league.entryFee) > 0 && (
                <View style={[styles.overviewRow, { marginTop: 8 }]} testID="league-overview-fee-row">
                  <View style={styles.overviewItem}>
                    <Text style={styles.overviewLabel}>Entry Fee</Text>
                    <PriceWithFx
                      orgId={league.organizationId}
                      token={token}
                      amount={league.entryFee}
                      currency={league.currency ?? "INR"}
                      productClass="league_entry"
                      bookedStyle={[styles.overviewValue, { color: Colors.secondary }]}
                    />
                  </View>
                </View>
              )}
            </View>

            {/* Description */}
            {league.description ? (
              <View style={styles.overviewCard}>
                <Text style={styles.overviewSectionTitle}>About</Text>
                <Text style={styles.overviewDescription}>{league.description}</Text>
              </View>
            ) : null}
          </ScrollView>
        )}

        {/* Fixtures tab */}
        {tab === "fixtures" && (
          <View style={{ flex: 1 }}>
            {!isMatchPlay ? (
              <View style={styles.centerFill}>
                <Feather name="list" size={32} color={Colors.muted} />
                <Text style={styles.emptyTabText}>Fixtures are only available for match play leagues.</Text>
              </View>
            ) : fixturesLoading ? (
              <View style={styles.centerFill}>
                <LoadingSpinner size="large" color={Colors.primary} />
              </View>
            ) : !fixtures || fixtures.length === 0 ? (
              <View style={styles.centerFill}>
                <Feather name="calendar" size={32} color={Colors.muted} />
                <Text style={styles.emptyTabText}>No fixtures scheduled yet.</Text>
              </View>
            ) : (
              <ScrollView contentContainerStyle={{ padding: 16, gap: 8 }} showsVerticalScrollIndicator={false}>
                {/* Group fixtures by scheduledDate — day section headers */}
                {(() => {
                  const dateOf = (f: FixtureRow) =>
                    f.scheduledDate ? f.scheduledDate.split("T")[0] : "__unscheduled__";
                  const dateKeys = [...new Set(fixtures.map(dateOf))].sort((a, b) =>
                    a === "__unscheduled__" ? 1 : b === "__unscheduled__" ? -1 : a.localeCompare(b)
                  );
                  return dateKeys.map(dk => (
                    <View key={dk} style={{ gap: 6 }}>
                      <Text style={styles.fixtureGroupHeader}>
                        {dk === "__unscheduled__" ? "Unscheduled"
                          : new Date(dk + "T00:00:00").toLocaleDateString(undefined, {
                              weekday: "short", day: "numeric", month: "long", year: "numeric",
                            })}
                      </Text>
                      {fixtures.filter(f => dateOf(f) === dk).map(f => {
                        const resultColor = f.result === "home_win" ? "#22c55e"
                          : f.result === "away_win" ? Colors.error
                          : f.result === "draw" ? Colors.secondary
                          : Colors.muted;
                        const resultLabel = f.result === "home_win" ? `${f.home?.firstName} wins`
                          : f.result === "away_win" ? `${f.away?.firstName} wins`
                          : f.result === "draw" ? "Draw"
                          : f.isPlayed ? "Played" : "Upcoming";
                        // Task #2240 — tapping a fixture player's name opens
                        // the public profile viewer (or the private member
                        // fallback) for parity with every other surface in
                        // the leagues screen (singles leaderboard, league
                        // members, team standings expanded rows, round-result
                        // cards). Falls back to a non-pressable label when
                        // the league member is a guest entry not linked to
                        // a user account.
                        const openProfile = (m: FixtureMember) => {
                          if (m.userId == null) return;
                          const fullName = `${m.firstName} ${m.lastName}`.trim();
                          router.push({
                            pathname: "/member/[userId]",
                            params: {
                              userId: String(m.userId),
                              displayName: fullName,
                              avatar: "",
                            },
                          });
                        };
                        const renderName = (m: FixtureMember | null, side: "home" | "away") => {
                          if (!m) return <Text style={styles.fixturePlayerName} numberOfLines={1}>—</Text>;
                          const label = `${m.firstName} ${m.lastName}`;
                          if (m.userId == null) {
                            return <Text style={styles.fixturePlayerName} numberOfLines={1}>{label}</Text>;
                          }
                          return (
                            <Pressable
                              onPress={() => openProfile(m)}
                              hitSlop={6}
                              accessibilityRole="link"
                              accessibilityLabel={`Open ${label.trim()}'s profile`}
                              testID={`fixture-${side}-name-${m.userId}`}
                            >
                              <Text style={styles.fixturePlayerName} numberOfLines={1}>{label}</Text>
                            </Pressable>
                          );
                        };
                        return (
                          <View key={f.id} style={styles.fixtureCard}>
                            <View style={styles.fixturePlayerSide}>
                              {renderName(f.home, "home")}
                              {f.homeScore != null && (
                                <Text style={styles.fixtureScore}>{f.homeScore}</Text>
                              )}
                            </View>
                            <View style={styles.fixtureCenter}>
                              <Text style={styles.fixtureVs}>vs</Text>
                              {f.isPlayed && (
                                <Text style={[styles.fixtureResult, { color: resultColor }]}>{resultLabel}</Text>
                              )}
                              {!f.isPlayed && f.scheduledDate && (
                                <Text style={styles.fixtureDate}>
                                  {new Date(f.scheduledDate).toLocaleDateString(undefined, { day: "numeric", month: "short" })}
                                </Text>
                              )}
                            </View>
                            <View style={[styles.fixturePlayerSide, { alignItems: "flex-end" }]}>
                              {f.awayScore != null && (
                                <Text style={styles.fixtureScore}>{f.awayScore}</Text>
                              )}
                              {renderName(f.away, "away")}
                            </View>
                          </View>
                        );
                      })}
                    </View>
                  ));
                })()}
              </ScrollView>
            )}
          </View>
        )}

        {/* Standings tab */}
        {tab === "standings" && (
          <View style={{ flex: 1 }}>
            {/* Team standings section */}
            {isTeamFormat && teamStandings && teamStandings.length > 0 && (
              <View style={{ marginBottom: 16 }}>
                <Text style={{ color: "#fff", fontWeight: "700", fontSize: 13, marginBottom: 6, letterSpacing: 0.5 }}>Team Standings</Text>
                {/* Header */}
                <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 10, paddingBottom: 4, borderBottomWidth: 1, borderBottomColor: "rgba(255,255,255,0.08)" }}>
                  <Text style={{ color: "#6B7280", fontSize: 10, width: 24, textAlign: "center" }}>#</Text>
                  <Text style={{ color: "#6B7280", fontSize: 10, flex: 1, marginLeft: 18 }}>Team</Text>
                  <Text style={{ color: "#6B7280", fontSize: 10, width: 28, textAlign: "right" }}>Rds</Text>
                  {isMatchPlay && (
                    <>
                      <Text style={{ color: "#6B7280", fontSize: 10, width: 36, textAlign: "right" }}>W/D/L</Text>
                    </>
                  )}
                  <Text style={{ color: "#6B7280", fontSize: 10, width: 40, textAlign: "right" }}>
                    {isMatchPlay ? "Pts" : isStableford ? "Stbl" : isNet ? "Net" : "Score"}
                  </Text>
                </View>
                {teamStandings.map((t, idx) => (
                  <View key={t.teamId} style={{
                    flexDirection: "row", alignItems: "center", paddingVertical: 8, paddingHorizontal: 10,
                    backgroundColor: idx % 2 === 0 ? "rgba(255,255,255,0.04)" : "transparent",
                    borderRadius: 6, marginTop: 1,
                  }}>
                    <Text style={{ color: "#9CA3AF", fontSize: 12, width: 24, textAlign: "center" }}>{t.position}</Text>
                    <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: t.teamColour ?? "#22c55e", marginLeft: 4, marginRight: 4 }} />
                    <Text style={{ color: "#fff", flex: 1, fontSize: 13, fontWeight: "500" }} numberOfLines={1}>{t.teamName}</Text>
                    <Text style={{ color: "#9CA3AF", fontSize: 12, width: 28, textAlign: "right" }}>{t.roundsPlayed ?? 0}</Text>
                    {isMatchPlay && (
                      <Text style={{ color: "#9CA3AF", fontSize: 11, width: 36, textAlign: "right" }}>
                        <Text style={{ color: "#22c55e" }}>{t.won ?? 0}</Text>
                        {"/"}
                        <Text>{t.drawn ?? 0}</Text>
                        {"/"}
                        <Text style={{ color: "#ef4444" }}>{t.lost ?? 0}</Text>
                      </Text>
                    )}
                    <Text style={{ color: "#6366f1", fontWeight: "700", fontSize: 13, width: 40, textAlign: "right" }}>
                      {isMatchPlay ? t.totalPoints
                        : isStableford ? (t.totalStableford ?? t.totalPoints ?? 0)
                        : isNet ? (t.totalNet ?? t.totalGross ?? 0)
                        : (t.totalGross ?? 0)}
                    </Text>
                  </View>
                ))}
              </View>
            )}
            {standingsLoading ? (
              <View style={styles.centerFill}>
                <LoadingSpinner size="large" color={Colors.primary} />
              </View>
            ) : !standings || standings.length === 0 ? (
              <View style={styles.centerFill}>
                <Feather name="bar-chart-2" size={32} color={Colors.muted} />
                <Text style={styles.emptyTabText}>No standings yet. Check back after rounds are played.</Text>
              </View>
            ) : (
              <ScrollView showsVerticalScrollIndicator={false}>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ minWidth: "100%" }}>
                <View style={{ flex: 1 }}>
                {/* Header row */}
                <View style={styles.standingsHeader}>
                  <Text style={[styles.standingsCell, styles.standingsPosCol, styles.standingsHeaderText]}>#</Text>
                  <Text style={[styles.standingsCell, styles.standingsNameCol, styles.standingsHeaderText]}>Player</Text>
                  <Text style={[styles.standingsCell, styles.standingsNumCol, styles.standingsHeaderText]}>Rds</Text>
                  {isMatchPlay && (
                    <>
                      <Text style={[styles.standingsCell, styles.standingsNumCol, styles.standingsHeaderText]}>W</Text>
                      <Text style={[styles.standingsCell, styles.standingsNumCol, styles.standingsHeaderText]}>D</Text>
                      <Text style={[styles.standingsCell, styles.standingsNumCol, styles.standingsHeaderText]}>L</Text>
                    </>
                  )}
                  <Text style={[styles.standingsCell, styles.standingsNumCol, styles.standingsHeaderText]}>
                    {isMatchPlay ? "Pts" : isStableford ? "Pts" : isOOM ? "OOM" : "Gross"}
                  </Text>
                </View>
                {standings.map((s, idx) => {
                  const medalColor = s.position === 1 ? "#C9A84C"
                    : s.position === 2 ? "#9E9E9E"
                    : s.position === 3 ? "#CD7F32"
                    : null;
                  // Task #2239 — tapping a player's name on the
                  // per-player league standings opens the public profile
                  // viewer (or the private member fallback) for that
                  // player, matching the affordance already on the
                  // league members tab and the round-result expanded
                  // rows.
                  const fullName = `${s.firstName} ${s.lastName}`.trim();
                  const goToProfile = () => {
                    if (s.userId == null) return;
                    router.push({
                      pathname: "/member/[userId]",
                      params: {
                        userId: String(s.userId),
                        displayName: fullName,
                        avatar: s.profileImage ?? "",
                      },
                    });
                  };
                  return (
                  <View key={s.id} style={[
                    styles.standingsRow, idx % 2 === 0 && styles.standingsRowAlt,
                    medalColor ? { borderLeftWidth: 3, borderLeftColor: medalColor } : null,
                  ]}>
                    <View style={[styles.standingsCell, styles.standingsPosCol, styles.posBadgeWrap]}>
                      <Text style={[styles.posBadge, medalColor ? { color: medalColor } : null]}>{s.position}</Text>
                    </View>
                    <View style={[styles.standingsCell, styles.standingsNameCol, { flexDirection: "row", alignItems: "center", gap: 6 }]}>
                      <MemberAvatar profileImage={s.profileImage} firstName={s.firstName} lastName={s.lastName} size={28} />
                      {s.userId != null ? (
                        <Pressable
                          onPress={goToProfile}
                          hitSlop={6}
                          style={{ flex: 1 }}
                          accessibilityRole="link"
                          accessibilityLabel={`Open ${fullName}'s profile`}
                          testID={`league-standings-name-${s.userId}`}
                        >
                          <Text style={styles.standingsName} numberOfLines={1}>
                            {s.firstName} {s.lastName}
                          </Text>
                          {s.teamName ? <Text style={styles.standingsTeam} numberOfLines={1}>{s.teamName}</Text> : null}
                        </Pressable>
                      ) : (
                        <View style={{ flex: 1 }}>
                          <Text style={styles.standingsName} numberOfLines={1}>
                            {s.firstName} {s.lastName}
                          </Text>
                          {s.teamName ? <Text style={styles.standingsTeam} numberOfLines={1}>{s.teamName}</Text> : null}
                        </View>
                      )}
                    </View>
                    <Text style={[styles.standingsCell, styles.standingsNumCol, styles.standingsNum]}>{s.roundsPlayed}</Text>
                    {isMatchPlay && (
                      <>
                        <Text style={[styles.standingsCell, styles.standingsNumCol, styles.standingsNum, { color: "#22c55e" }]}>{s.won}</Text>
                        <Text style={[styles.standingsCell, styles.standingsNumCol, styles.standingsNum, { color: Colors.muted }]}>{s.drawn}</Text>
                        <Text style={[styles.standingsCell, styles.standingsNumCol, styles.standingsNum, { color: Colors.error }]}>{s.lost}</Text>
                      </>
                    )}
                    <Text style={[styles.standingsCell, styles.standingsNumCol, styles.standingsNum, styles.standingsPts]}>
                      {isMatchPlay ? s.totalPoints
                        : isStableford ? s.totalStableford
                        : isOOM ? s.totalPoints
                        : s.totalGross}
                    </Text>
                  </View>
                  );
                })}
                </View>
                </ScrollView>
              </ScrollView>
            )}
          </View>
        )}

        {/* Rounds tab */}
        {tab === "rounds" && (
          <View style={{ flex: 1 }}>
            {roundsLoading ? (
              <View style={styles.centerFill}>
                <LoadingSpinner size="large" color={Colors.primary} />
              </View>
            ) : !rounds || rounds.length === 0 ? (
              <View style={styles.centerFill}>
                <Feather name="calendar" size={32} color={Colors.muted} />
                <Text style={styles.emptyTabText}>No rounds scheduled yet.</Text>
              </View>
            ) : (
              <ScrollView contentContainerStyle={{ padding: 16, gap: 10 }} showsVerticalScrollIndicator={false}>
                {rounds.map(r => (
                  <RoundResultCard
                    key={r.id}
                    leagueId={league.id}
                    round={r}
                    isMatchPlay={isMatchPlay}
                    isStableford={isStableford}
                  />
                ))}
              </ScrollView>
            )}
          </View>
        )}

        {/* Members tab */}
        {tab === "members" && (
          <View style={{ flex: 1 }}>
            {membersLoading ? (
              <View style={styles.centerFill}>
                <LoadingSpinner size="large" color={Colors.primary} />
              </View>
            ) : !members || members.length === 0 ? (
              <View style={styles.centerFill}>
                <Feather name="users" size={32} color={Colors.muted} />
                <Text style={styles.emptyTabText}>No members yet.</Text>
              </View>
            ) : (
              <ScrollView contentContainerStyle={{ padding: 16, gap: 8 }} showsVerticalScrollIndicator={false}>
                <Text style={styles.memberCount}>{members.length} member{members.length !== 1 ? "s" : ""}</Text>
                {members.map((m, idx) => {
                  // Task #1457 — make each league member tappable so the
                  // members tab funnels into the public profile viewer
                  // (or the private member fallback) for that player.
                  const fullName = `${m.firstName} ${m.lastName}`.trim();
                  const goToProfile = () => {
                    if (m.userId == null) return;
                    router.push({
                      pathname: "/member/[userId]",
                      params: {
                        userId: String(m.userId),
                        displayName: fullName,
                        avatar: m.profileImage ?? "",
                      },
                    });
                  };
                  const rowBody = (
                    <>
                      <MemberAvatar
                        profileImage={m.profileImage}
                        firstName={m.firstName}
                        lastName={m.lastName}
                        size={40}
                      />
                      <View style={{ flex: 1 }}>
                        <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                          <Text style={styles.memberName}>{m.firstName} {m.lastName}</Text>
                          {(() => {
                            const st = m.paymentStatus?.toLowerCase() ?? "active";
                            const badgeColor = st === "active" || st === "paid" ? "#22c55e"
                              : st === "pending" ? "#F59E0B"
                              : "#ef4444";
                            return (
                              <View style={[styles.memberStatusBadge, { borderColor: badgeColor + "60", backgroundColor: badgeColor + "22" }]}>
                                <Text style={[styles.memberStatusText, { color: badgeColor }]}>
                                  {st.charAt(0).toUpperCase() + st.slice(1)}
                                </Text>
                              </View>
                            );
                          })()}
                        </View>
                        <View style={{ flexDirection: "row", gap: 8, marginTop: 2 }}>
                          {m.handicapIndex != null && (
                            <Text style={styles.memberMeta}>HCP {parseFloat(m.handicapIndex).toFixed(1)}</Text>
                          )}
                          {m.teamName && (
                            <Text style={styles.memberMeta}>{m.teamName}</Text>
                          )}
                        </View>
                      </View>
                      <Text style={styles.memberSeq}>#{idx + 1}</Text>
                    </>
                  );
                  if (m.userId != null) {
                    return (
                      <Pressable
                        key={m.id}
                        style={styles.memberRow}
                        onPress={goToProfile}
                        accessibilityRole="button"
                        accessibilityLabel={`Open ${fullName}'s profile`}
                        testID={`league-member-${m.userId}`}
                      >
                        {rowBody}
                      </Pressable>
                    );
                  }
                  return (
                    <View key={m.id} style={styles.memberRow}>
                      {rowBody}
                    </View>
                  );
                })}
              </ScrollView>
            )}
          </View>
        )}

        {/* Gallery tab */}
        {tab === "gallery" && (
          <View style={{ flex: 1 }}>
            {/* Upload toolbar */}
            {token && !galleryError && (
              <View style={styles.galleryToolbar}>
                <TextInput
                  style={styles.captionInput}
                  value={galleryCaption}
                  onChangeText={setGalleryCaption}
                  placeholder="Caption (optional)..."
                  placeholderTextColor={Colors.muted}
                  maxLength={200}
                />
                <Pressable
                  onPress={pickAndUpload}
                  disabled={galleryUploading}
                  style={[styles.uploadBtn, galleryUploading && { opacity: 0.5 }]}
                >
                  {galleryUploading
                    ? <LoadingSpinner size="small" color="#000" />
                    : <Feather name="upload" size={16} color="#000" />}
                </Pressable>
              </View>
            )}
            {galleryLoading ? (
              <View style={styles.centerFill}>
                <LoadingSpinner size="large" color={Colors.primary} />
              </View>
            ) : galleryError ? (
              <View style={styles.centerFill}>
                <Feather name="lock" size={32} color={Colors.muted} />
                <Text style={styles.errorText}>{galleryError}</Text>
              </View>
            ) : galleryItems.length === 0 ? (
              <View style={styles.centerFill}>
                <Feather name="image" size={32} color={Colors.muted} />
                <Text style={styles.emptyTabText}>No photos yet. Tap the upload button to add the first one!</Text>
              </View>
            ) : (
              <>
              <ScrollView contentContainerStyle={styles.galleryGrid} showsVerticalScrollIndicator={false}>
                {galleryItems.map(item => {
                  const isOwn = user?.id != null && item.uploadedByUserId === user.id;
                  return (
                    <Pressable key={item.id} style={styles.galleryCell} onPress={() => setLightboxItem(item)}>
                      <Image
                        source={{ uri: imgUrl(item) }}
                        style={styles.galleryImage}
                        resizeMode="cover"
                      />
                      {item.mediaType === "video" && (
                        <View style={styles.playOverlay}>
                          <Text style={styles.playIcon}>▶</Text>
                        </View>
                      )}
                      {!item.approved && (
                        <View style={styles.pendingOverlay}>
                          <Text style={styles.pendingText}>Pending</Text>
                        </View>
                      )}
                      {item.caption ? (
                        <View style={styles.captionOverlay}>
                          <Text style={styles.captionText} numberOfLines={1}>{item.caption}</Text>
                        </View>
                      ) : null}
                      {isOwn && (
                        <Pressable onPress={(e) => { e.stopPropagation?.(); deleteOwnItem(item); }} style={styles.deleteOwnBtn} hitSlop={4}>
                          <Feather name="trash-2" size={12} color="#fff" />
                        </Pressable>
                      )}
                    </Pressable>
                  );
                })}
              </ScrollView>
              {/* Lightbox */}
              {lightboxItem && (
                <Modal visible animationType="fade" transparent onRequestClose={() => setLightboxItem(null)}>
                  <View style={styles.lightboxBackdrop}>
                    <Pressable style={{ position: "absolute", top: 16, right: 16, zIndex: 10, backgroundColor: "rgba(0,0,0,0.5)", borderRadius: 20, padding: 8 }} onPress={() => setLightboxItem(null)}>
                      <Text style={{ color: "#fff", fontSize: 18 }}>✕</Text>
                    </Pressable>
                    {lightboxItem.mediaType === "video" ? (
                      <Video
                        source={{ uri: `${BASE_URL}/api/storage${lightboxItem.objectPath}` }}
                        style={styles.lightboxMedia}
                        resizeMode={ResizeMode.CONTAIN}
                        useNativeControls
                        shouldPlay
                      />
                    ) : (
                      <Pressable style={{ flex: 1, width: "100%" }} onPress={() => setLightboxItem(null)}>
                        <Image source={{ uri: `${BASE_URL}/api/storage${lightboxItem.objectPath}` }} style={styles.lightboxMedia} resizeMode="contain" />
                      </Pressable>
                    )}
                    {lightboxItem.caption ? (
                      <View style={styles.lightboxCaption}>
                        <Text style={styles.lightboxCaptionText}>{lightboxItem.caption}</Text>
                        {lightboxItem.uploaderName ? <Text style={styles.lightboxUploader}>by {lightboxItem.uploaderName}</Text> : null}
                      </View>
                    ) : null}
                  </View>
                </Modal>
              )}
              </>
            )}
          </View>
        )}

        {/* Chat tab */}
        {tab === "chat" && (
          <KeyboardAvoidingView
            style={{ flex: 1 }}
            behavior={Platform.OS === "ios" ? "padding" : undefined}
            keyboardVerticalOffset={insets.bottom + 60}
          >
            {!token ? (
              <View style={styles.centerFill}>
                <Feather name="lock" size={32} color={Colors.muted} />
                <Text style={styles.errorText}>Sign in to access league chat</Text>
              </View>
            ) : chatLoading ? (
              <View style={styles.centerFill}>
                <LoadingSpinner size="large" color={Colors.primary} />
              </View>
            ) : !chatRoom?.enabled ? (
              <View style={styles.centerFill}>
                <Feather name="message-circle" size={32} color={Colors.muted} />
                <Text style={styles.emptyTabText}>Chat is not enabled for this league</Text>
              </View>
            ) : (
              <>
                <ScrollView
                  ref={chatScrollRef}
                  style={styles.chatMessages}
                  contentContainerStyle={styles.chatMessagesContent}
                  showsVerticalScrollIndicator={false}
                >
                  {chatRoom.messages.length === 0 ? (
                    <Text style={styles.chatEmpty}>No messages yet. Say hello!</Text>
                  ) : chatRoom.messages.map(msg => (
                    <View key={msg.id} style={[styles.chatBubble, msg.isPinned && styles.chatBubblePinned]}>
                      <View style={styles.chatBubbleHeader}>
                        <Text style={styles.chatSender}>{msg.displayName}</Text>
                        <Text style={styles.chatTime}>
                          {new Date(msg.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                        </Text>
                        {msg.isPinned && <Ionicons name="pin" size={12} color={Colors.secondary} />}
                      </View>
                      {msg.messageType === "gallery-share" && (msg.mediaThumbnailPath || msg.mediaObjectPath) && (
                      <Image
                        source={{ uri: `${BASE_URL}/api/storage${msg.mediaThumbnailPath ?? msg.mediaObjectPath}` }}
                        style={{ width: "100%", height: 120, borderRadius: 6, marginBottom: 4 }}
                        resizeMode="cover"
                      />
                    )}
                    <Text style={styles.chatBody}>{msg.body}</Text>
                      {Object.keys(msg.reactions ?? {}).length > 0 && (
                        <View style={styles.reactionsRow}>
                          {Object.entries(msg.reactions).map(([emoji, uids]) => (
                            <View key={emoji} style={styles.reactionChip}>
                              <Text style={styles.reactionEmoji}>{emoji}</Text>
                              <Text style={styles.reactionCount}>{uids.length}</Text>
                            </View>
                          ))}
                        </View>
                      )}
                    </View>
                  ))}
                </ScrollView>
                <View style={styles.emojiStrip}>
                  {QUICK_EMOJIS.map(e => (
                    <Pressable key={e} onPress={() => setChatInput(prev => prev + e)} style={styles.emojiBtn} hitSlop={4}>
                      <Text style={styles.emojiText}>{e}</Text>
                    </Pressable>
                  ))}
                </View>
                <View style={[styles.chatInputRow, { paddingBottom: insets.bottom || 16 }]}>
                  <TextInput
                    style={styles.chatInput}
                    value={chatInput}
                    onChangeText={setChatInput}
                    placeholder="Type a message..."
                    placeholderTextColor={Colors.muted}
                    multiline
                    maxLength={1000}
                    onSubmitEditing={sendMessage}
                    returnKeyType="send"
                  />
                  <Pressable
                    onPress={sendMessage}
                    disabled={chatSending || !chatInput.trim()}
                    style={[styles.sendBtn, (!chatInput.trim() || chatSending) && { opacity: 0.4 }]}
                  >
                    <Ionicons name="send" size={18} color="#000" />
                  </Pressable>
                </View>
              </>
            )}
          </KeyboardAvoidingView>
        )}
        {tab === "documents" && (
          <LeagueDocumentsTab leagueId={league.id} orgId={league.organizationId} />
        )}

        {/* Task #620 — friendly consent prompt for blocked photo/video uploads. */}
        {consentPrompt && (
          <Modal visible animationType="fade" transparent onRequestClose={() => setConsentPrompt(null)}>
            <Pressable style={styles.consentBackdrop} onPress={() => setConsentPrompt(null)}>
              <Pressable onPress={(e) => e.stopPropagation()}>
                <ConsentPrompt
                  message={consentPrompt.message}
                  category={consentPrompt.category}
                  onDismiss={() => setConsentPrompt(null)}
                />
              </Pressable>
            </Pressable>
          </Modal>
        )}
      </View>
    </Modal>
  );
}

function LeagueDocumentsTab({ leagueId, orgId }: { leagueId: number; orgId: number }) {
  const { user } = useAuth();
  const isAdmin = ["super_admin", "org_admin", "tournament_director"].includes(user?.role ?? "");
  const [docs, setDocs] = useState<Array<{
    eventDocumentId: number; documentId: number; title: string; category: string;
    filename: string | null; fileSize: number | null;
  }>>([]);
  const [loading, setLoading] = useState(true);

  const CATEGORY_COLORS: Record<string, string> = {
    local_rules: "#10b981", pace_of_play: "#3b82f6", policy: "#8b5cf6",
    general: "#6b7280", results: "#f59e0b", notice: "#f43f5e",
  };
  const CATEGORY_LABELS: Record<string, string> = {
    local_rules: "Local Rules", pace_of_play: "Pace of Play", policy: "Policy",
    general: "General", results: "Results", notice: "Notice",
  };

  useEffect(() => {
    if (isAdmin) {
      fetch(`${BASE_URL}/api/organizations/${orgId}/leagues/${leagueId}/documents`, { credentials: "include" })
        .then(r => r.ok ? r.json() : [])
        .then(setDocs)
        .catch(() => {})
        .finally(() => setLoading(false));
    } else {
      fetch(`${BASE_URL}/api/public/leagues/${leagueId}/documents`)
        .then(r => r.ok ? r.json() : [])
        .then(setDocs)
        .catch(() => {})
        .finally(() => setLoading(false));
    }
  }, [leagueId, orgId, isAdmin]);

  if (loading) {
    return (
      <View style={{ padding: 24, alignItems: "center" }}>
        <LoadingSpinner color={Colors.primary} />
      </View>
    );
  }

  if (docs.length === 0) {
    return (
      <View style={{ padding: 32, alignItems: "center" }}>
        <Feather name="file-text" size={40} color={Colors.textMuted} style={{ opacity: 0.3 }} />
        <Text style={{ color: Colors.textMuted, fontSize: 14, marginTop: 12, textAlign: "center" }}>
          No documents attached to this league.
        </Text>
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 10 }}>
      {docs.map(doc => (
        <Pressable
          key={doc.eventDocumentId}
          style={{
            flexDirection: "row", alignItems: "center", gap: 12,
            backgroundColor: Colors.surface, borderRadius: 12,
            padding: 14, borderWidth: 1, borderColor: "rgba(255,255,255,0.06)",
          }}
          onPress={() => {
            const url = isAdmin
              ? `${BASE_URL}/api/organizations/${orgId}/documents/${doc.documentId}/download`
              : `${BASE_URL}/api/public/leagues/${leagueId}/documents/${doc.documentId}`;
            Linking.openURL(url).catch(() => {});
          }}
        >
          <View style={{
            width: 40, height: 40, borderRadius: 10,
            backgroundColor: "rgba(255,255,255,0.05)",
            justifyContent: "center", alignItems: "center",
          }}>
            <Feather name="file-text" size={18} color={CATEGORY_COLORS[doc.category] ?? CATEGORY_COLORS.general} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={{ color: Colors.text, fontSize: 14, fontWeight: "600" }}>{doc.title}</Text>
            <Text style={{ color: Colors.textMuted, fontSize: 11, marginTop: 2 }}>
              {CATEGORY_LABELS[doc.category] ?? doc.category}
              {doc.filename ? ` · ${doc.filename}` : ""}
            </Text>
          </View>
          <Feather name="download" size={16} color={Colors.textMuted} />
        </Pressable>
      ))}
    </ScrollView>
  );
}

export default function LeaguesScreen() {
  const insets = useSafeAreaInsets();
  const isWeb = Platform.OS === "web";
  const topPadding = isWeb ? 67 : insets.top;
  const [selectedLeague, setSelectedLeague] = useState<League | null>(null);
  const { token } = useAuth();

  const { data: leagues, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ["public-leagues"],
    queryFn: () => fetchPublic<League[]>("/leagues"),
    staleTime: 60000,
  });

  return (
    <View style={[styles.container, { paddingTop: topPadding }]}>
      {/* Header */}
      <View style={styles.header}>
        <View>
          <Text style={styles.brand}>KHARA<Text style={{ color: '#C9A84C' }}>GOLF</Text></Text>
          <Text style={styles.headerTitle}>Leagues</Text>
        </View>
        <View style={styles.logoContainer}>
          <Image source={require('../../assets/logo.png')} style={styles.logoImage} resizeMode="contain" />
        </View>
      </View>

      {isLoading ? (
        <View style={styles.loadingContainer}>
          <LoadingSpinner size="large" color={Colors.primary} />
          <Text style={styles.loadingText}>Loading leagues...</Text>
        </View>
      ) : error ? (
        <View style={styles.emptyState}>
          <Feather name="wifi-off" size={40} color={Colors.error} />
          <Text style={styles.emptyTitle}>Connection Error</Text>
          <Pressable style={styles.retryBtn} onPress={() => refetch()}>
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      ) : (
        <FlatList
          data={leagues}
          keyExtractor={(item) => String(item.id)}
          ListHeaderComponent={<NationalLaddersCard />}
          renderItem={({ item }) => (
            <LeagueCard item={item} onPress={() => setSelectedLeague(item)} token={token} />
          )}
          ListEmptyComponent={EmptyState}
          contentContainerStyle={[
            styles.listContent,
            { paddingBottom: isWeb ? 34 + 84 : insets.bottom + 100 },
          ]}
          refreshControl={
            <RefreshControl
              refreshing={isFetching && !isLoading}
              onRefresh={refetch}
              tintColor={Colors.primary}
              colors={[Colors.primary]}
            />
          }
          showsVerticalScrollIndicator={false}
        />
      )}

      {selectedLeague && (
        <LeagueDetailModal
          league={selectedLeague}
          onClose={() => setSelectedLeague(null)}
        />
      )}
    </View>
  );
}

const CELL_SIZE = 120;

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.background },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 20,
    paddingBottom: 16,
    paddingTop: 8,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  brand: {
    fontFamily: "Inter_700Bold",
    fontSize: 10,
    color: Colors.text,
    letterSpacing: 3,
    marginBottom: 2,
  },
  headerTitle: {
    fontFamily: "Inter_700Bold",
    fontSize: 24,
    color: Colors.text,
  },
  logoContainer: {
    width: 48,
    height: 48,
    borderRadius: 16,
    backgroundColor: Colors.card,
    borderWidth: 1,
    borderColor: Colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  logoImage: { width: 36, height: 36, marginBottom: 4 },
  listContent: {
    padding: 16,
    gap: 12,
  },
  card: {
    backgroundColor: Colors.card,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: Colors.border,
    overflow: "hidden",
    flexDirection: "row",
  },
  cardAccent: {
    width: 4,
  },
  cardContent: {
    flex: 1,
    padding: 16,
    gap: 6,
  },
  cardHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  statusBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 20,
    borderWidth: 1,
  },
  statusText: {
    fontFamily: "Inter_700Bold",
    fontSize: 9,
    letterSpacing: 1,
  },
  badges: {
    flexDirection: "row",
    gap: 6,
  },
  typeBadge: {
    fontFamily: "Inter_500Medium",
    fontSize: 11,
    color: Colors.secondary,
    backgroundColor: Colors.secondary + "15",
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 6,
  },
  formatBadge: {
    fontFamily: "Inter_500Medium",
    fontSize: 11,
    color: Colors.textSecondary,
    backgroundColor: Colors.surface,
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 6,
  },
  cardTitle: {
    fontFamily: "Inter_700Bold",
    fontSize: 17,
    color: Colors.text,
  },
  description: {
    fontFamily: "Inter_400Regular",
    fontSize: 13,
    color: Colors.textSecondary,
    lineHeight: 18,
  },
  metaRow: {
    flexDirection: "row",
    gap: 14,
    flexWrap: "wrap",
    marginTop: 2,
  },
  metaItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  metaText: {
    fontFamily: "Inter_400Regular",
    fontSize: 12,
    color: Colors.textSecondary,
  },
  feeRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    marginTop: 2,
  },
  feeText: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 13,
    color: Colors.secondary,
  },
  handicapText: {
    fontFamily: "Inter_400Regular",
    fontSize: 12,
    color: Colors.muted,
  },
  loadingContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
  },
  loadingText: {
    fontFamily: "Inter_400Regular",
    fontSize: 14,
    color: Colors.textSecondary,
  },
  emptyState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 32,
    gap: 12,
  },
  emptyTitle: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 20,
    color: Colors.text,
  },
  emptySubtitle: {
    fontFamily: "Inter_400Regular",
    fontSize: 14,
    color: Colors.textSecondary,
    textAlign: "center",
  },
  retryBtn: {
    marginTop: 8,
    paddingHorizontal: 24,
    paddingVertical: 10,
    backgroundColor: Colors.primary,
    borderRadius: 12,
  },
  retryText: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 14,
    color: "#000",
  },
  // Modal styles
  modalContainer: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  modalHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  closeBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: Colors.card,
    alignItems: "center",
    justifyContent: "center",
  },
  modalTitle: {
    fontFamily: "Inter_700Bold",
    fontSize: 17,
    color: Colors.text,
    flex: 1,
    textAlign: "center",
    marginHorizontal: 8,
  },
  payBanner: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#2d1f00",
    borderRadius: 10,
    marginHorizontal: 16,
    marginTop: 10,
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderWidth: 1,
    borderColor: "#f59e0b44",
  },
  payBannerText: {
    flex: 1,
    fontFamily: "Inter_500Medium",
    fontSize: 13,
    color: "#f59e0b",
  },
  payBannerBtn: {
    backgroundColor: "#22c55e",
    borderRadius: 8,
    paddingVertical: 6,
    paddingHorizontal: 16,
    minWidth: 80,
    alignItems: "center",
  },
  payBannerBtnText: {
    fontFamily: "Inter_700Bold",
    fontSize: 13,
    color: "#000",
  },
  tabsScroll: {
    maxHeight: 56,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  tabsScrollContent: {
    flexDirection: "row",
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 10,
    gap: 8,
    alignItems: "center",
  },
  tabBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 12,
    backgroundColor: Colors.card,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  tabBtnActive: {
    backgroundColor: Colors.primary + "20",
    borderColor: Colors.primary + "60",
  },
  tabLabel: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 13,
    color: Colors.textSecondary,
  },
  tabLabelActive: {
    color: Colors.primary,
  },
  // Standings styles
  standingsHeader: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: Colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  standingsRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border + "60",
  },
  standingsRowAlt: {
    backgroundColor: Colors.card + "80",
  },
  standingsCell: {
    justifyContent: "center",
  },
  standingsPosCol: { width: 36 },
  standingsNameCol: { flex: 1, paddingRight: 8 },
  standingsNumCol: { width: 36, alignItems: "center" },
  standingsHeaderText: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 11,
    color: Colors.muted,
    letterSpacing: 0.5,
    textAlign: "center",
  },
  standingsName: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 14,
    color: Colors.text,
  },
  standingsTeam: {
    fontFamily: "Inter_400Regular",
    fontSize: 11,
    color: Colors.muted,
    marginTop: 1,
  },
  standingsNum: {
    fontFamily: "Inter_500Medium",
    fontSize: 13,
    color: Colors.textSecondary,
    textAlign: "center",
  },
  standingsPts: {
    fontFamily: "Inter_700Bold",
    fontSize: 14,
    color: Colors.primary,
  },
  posBadgeWrap: { alignItems: "center" },
  posBadge: {
    fontFamily: "Inter_700Bold",
    fontSize: 13,
    color: Colors.textSecondary,
    width: 24,
    textAlign: "center",
  },
  posBadgeTop: { color: Colors.secondary },
  // Rounds styles
  roundCard: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: Colors.card,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: 14,
    gap: 12,
  },
  roundNumberBadge: {
    width: 40,
    height: 40,
    borderRadius: 10,
    backgroundColor: Colors.primary + "20",
    alignItems: "center",
    justifyContent: "center",
  },
  roundNumberText: {
    fontFamily: "Inter_700Bold",
    fontSize: 13,
    color: Colors.primary,
  },
  roundName: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 15,
    color: Colors.text,
  },
  roundDate: {
    fontFamily: "Inter_400Regular",
    fontSize: 12,
    color: Colors.muted,
    marginTop: 2,
  },
  roundStatusBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 8,
    borderWidth: 1,
  },
  roundStatusText: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 11,
  },
  // Members styles
  memberCount: {
    fontFamily: "Inter_500Medium",
    fontSize: 13,
    color: Colors.muted,
    marginBottom: 4,
  },
  memberRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: Colors.card,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: 12,
  },
  memberAvatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: Colors.primary + "30",
    alignItems: "center",
    justifyContent: "center",
  },
  memberAvatarText: {
    fontFamily: "Inter_700Bold",
    fontSize: 14,
    color: Colors.primary,
  },
  memberName: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 15,
    color: Colors.text,
  },
  memberMeta: {
    fontFamily: "Inter_400Regular",
    fontSize: 12,
    color: Colors.muted,
    backgroundColor: Colors.surface,
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 6,
  },
  memberSeq: {
    fontFamily: "Inter_500Medium",
    fontSize: 12,
    color: Colors.muted,
  },
  memberStatusBadge: {
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 1,
  },
  memberStatusText: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 10,
  },
  roundExpanded: {
    marginTop: 10,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: Colors.border,
    gap: 4,
  },
  roundExpandedEmpty: {
    fontFamily: "Inter_400Regular",
    fontSize: 12,
    color: Colors.muted,
    textAlign: "center",
    paddingVertical: 6,
  },
  roundExpandedTitle: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 11,
    color: Colors.textSecondary,
    marginBottom: 4,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  roundExpandedRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: 2,
  },
  roundExpandedPos: {
    fontFamily: "Inter_500Medium",
    fontSize: 12,
    color: Colors.muted,
    width: 18,
  },
  roundExpandedName: {
    fontFamily: "Inter_500Medium",
    fontSize: 12,
    color: Colors.text,
    flex: 1,
  },
  roundExpandedScore: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 12,
    color: Colors.primary,
  },
  centerFill: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    paddingHorizontal: 24,
  },
  errorText: {
    fontFamily: "Inter_400Regular",
    fontSize: 14,
    color: Colors.textSecondary,
    textAlign: "center",
  },
  emptyTabText: {
    fontFamily: "Inter_400Regular",
    fontSize: 14,
    color: Colors.muted,
    textAlign: "center",
  },
  galleryGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    padding: 8,
    gap: 4,
  },
  galleryCell: {
    width: CELL_SIZE,
    height: CELL_SIZE,
    borderRadius: 10,
    overflow: "hidden",
    backgroundColor: Colors.card,
    margin: 2,
  },
  galleryImage: {
    width: "100%",
    height: "100%",
  },
  playOverlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  playIcon: {
    fontSize: 24,
    color: "#fff",
    textShadowColor: "#000",
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
  },
  pendingOverlay: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: "rgba(0,0,0,0.6)",
    alignItems: "center",
    paddingVertical: 3,
  },
  pendingText: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 10,
    color: "#fbbf24",
  },
  captionOverlay: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: "rgba(0,0,0,0.5)",
    paddingHorizontal: 4,
    paddingVertical: 3,
  },
  captionText: {
    fontFamily: "Inter_400Regular",
    fontSize: 10,
    color: "#fff",
  },
  galleryToolbar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: "rgba(255,255,255,0.08)",
  },
  captionInput: {
    flex: 1,
    height: 36,
    backgroundColor: "rgba(255,255,255,0.08)",
    borderRadius: 8,
    paddingHorizontal: 10,
    fontFamily: "Inter_400Regular",
    fontSize: 13,
    color: Colors.text,
  },
  uploadBtn: {
    width: 36,
    height: 36,
    borderRadius: 8,
    backgroundColor: Colors.secondary,
    alignItems: "center",
    justifyContent: "center",
  },
  deleteOwnBtn: {
    position: "absolute",
    top: 4,
    right: 4,
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: "rgba(220,38,38,0.85)",
    alignItems: "center",
    justifyContent: "center",
  },
  lightboxBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.92)",
    alignItems: "center",
    justifyContent: "center",
  },
  lightboxMedia: {
    width: Dimensions.get("window").width,
    height: Dimensions.get("window").height * 0.75,
  },
  lightboxCaption: { paddingHorizontal: 24, paddingTop: 16, alignItems: "center" },
  lightboxCaptionText: { fontFamily: "Inter_600SemiBold", fontSize: 15, color: "#fff", textAlign: "center" },
  lightboxUploader: { fontFamily: "Inter_400Regular", fontSize: 12, color: Colors.muted, marginTop: 4 },
  emojiStrip: {
    flexDirection: "row",
    paddingHorizontal: 12,
    paddingVertical: 6,
    gap: 8,
    borderTopWidth: 1,
    borderTopColor: "rgba(255,255,255,0.06)",
  },
  emojiBtn: {
    padding: 4,
  },
  emojiText: {
    fontSize: 22,
  },
  chatMessages: {
    flex: 1,
    paddingHorizontal: 12,
  },
  chatMessagesContent: {
    paddingVertical: 12,
    gap: 8,
  },
  chatEmpty: {
    fontFamily: "Inter_400Regular",
    fontSize: 14,
    color: Colors.muted,
    textAlign: "center",
    marginTop: 40,
  },
  chatBubble: {
    backgroundColor: Colors.card,
    borderRadius: 12,
    padding: 10,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  chatBubblePinned: {
    borderColor: Colors.secondary + "60",
    backgroundColor: Colors.secondary + "10",
  },
  chatBubbleHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginBottom: 3,
  },
  chatSender: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 12,
    color: Colors.primary,
    flex: 1,
  },
  chatTime: {
    fontFamily: "Inter_400Regular",
    fontSize: 11,
    color: Colors.muted,
  },
  chatBody: {
    fontFamily: "Inter_400Regular",
    fontSize: 14,
    color: Colors.text,
    lineHeight: 20,
  },
  reactionsRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 4,
    marginTop: 6,
  },
  reactionChip: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: Colors.surface,
    borderRadius: 12,
    paddingHorizontal: 6,
    paddingVertical: 2,
    gap: 3,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  reactionEmoji: { fontSize: 13 },
  reactionCount: {
    fontFamily: "Inter_500Medium",
    fontSize: 11,
    color: Colors.textSecondary,
  },
  chatInputRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 8,
    paddingHorizontal: 12,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: Colors.border,
    backgroundColor: Colors.background,
  },
  chatInput: {
    flex: 1,
    backgroundColor: Colors.card,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 10,
    color: Colors.text,
    fontFamily: "Inter_400Regular",
    fontSize: 14,
    maxHeight: 100,
  },
  sendBtn: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: Colors.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  // Tab count badge
  tabCountBadge: {
    backgroundColor: Colors.primary,
    borderRadius: 10,
    minWidth: 18,
    height: 18,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 4,
  },
  tabCountText: {
    fontFamily: "Inter_700Bold",
    fontSize: 10,
    color: "#000",
  },
  // Overview tab styles
  overviewCard: {
    backgroundColor: Colors.card,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: 16,
    gap: 10,
  },
  overviewSectionTitle: {
    fontFamily: "Inter_700Bold",
    fontSize: 12,
    color: Colors.muted,
    letterSpacing: 0.8,
    textTransform: "uppercase",
  },
  overviewRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 16,
  },
  overviewItem: {
    gap: 3,
    minWidth: 80,
  },
  overviewLabel: {
    fontFamily: "Inter_400Regular",
    fontSize: 11,
    color: Colors.muted,
  },
  overviewValue: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 14,
    color: Colors.text,
  },
  overviewNone: {
    fontFamily: "Inter_400Regular",
    fontSize: 13,
    color: Colors.muted,
    fontStyle: "italic",
  },
  overviewDescription: {
    fontFamily: "Inter_400Regular",
    fontSize: 14,
    color: Colors.textSecondary,
    lineHeight: 21,
  },
  // Fixtures tab styles
  fixtureGroupHeader: {
    fontFamily: "Inter_700Bold",
    fontSize: 12,
    color: Colors.muted,
    letterSpacing: 0.8,
    textTransform: "uppercase",
    paddingVertical: 4,
    paddingHorizontal: 2,
  },
  fixtureCard: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: Colors.card,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: 12,
    gap: 8,
  },
  fixturePlayerSide: {
    flex: 1,
    gap: 2,
  },
  fixturePlayerName: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 13,
    color: Colors.text,
  },
  fixtureScore: {
    fontFamily: "Inter_700Bold",
    fontSize: 18,
    color: Colors.primary,
  },
  fixtureCenter: {
    alignItems: "center",
    gap: 2,
    minWidth: 60,
  },
  fixtureVs: {
    fontFamily: "Inter_500Medium",
    fontSize: 12,
    color: Colors.muted,
  },
  fixtureResult: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 10,
    textAlign: "center",
  },
  fixtureDate: {
    fontFamily: "Inter_400Regular",
    fontSize: 11,
    color: Colors.muted,
    textAlign: "center",
  },

  // Task #620 — backdrop for the friendly consent prompt modal.
  consentBackdrop: {
    flex: 1, backgroundColor: "rgba(0,0,0,0.7)",
    justifyContent: "center", alignItems: "stretch", paddingHorizontal: 8,
  },
});
