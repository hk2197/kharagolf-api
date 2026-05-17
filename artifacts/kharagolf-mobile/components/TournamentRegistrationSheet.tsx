import React, { useState, useEffect, useCallback } from "react";
import {
  Modal,
  View,
  Text,
  TextInput,
  Pressable,
  ScrollView,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Alert,
  StyleSheet,
} from "react-native";
import { Feather, Ionicons } from "@expo/vector-icons";
import { useQueryClient } from "@tanstack/react-query";
import Colors from "@/constants/colors";
import { BASE_URL } from "@/utils/api";
import { StripeCheckoutModal, stripeModuleAvailable } from "@/components/StripeCheckoutModal";
import { PriceWithFx } from "@/components/PriceWithFx";

let RazorpayCheckout: {
  open: (opts: RazorpayOptions) => Promise<RazorpaySuccess>;
} | null = null;
try {
  RazorpayCheckout = require("react-native-razorpay").default;
} catch {
  RazorpayCheckout = null;
}

interface RazorpayOptions {
  key: string;
  order_id: string;
  amount: number;
  currency: string;
  name: string;
  description: string;
  prefill?: { email?: string; name?: string };
}

interface RazorpaySuccess {
  razorpay_payment_id: string;
  razorpay_order_id: string;
  razorpay_signature: string;
}

interface Flight {
  id: number;
  name: string;
}

export interface TournamentForRegistration {
  id: number;
  name: string;
  format: string;
  status: string;
  startDate?: string;
  endDate?: string;
  organizationId: number;
  organizationName: string;
  courseName?: string;
  entryFee?: string | null;
  currency?: string;
  maxPlayers?: number | null;
  playerCount?: number;
  isFull?: boolean;
}

interface TournamentDetail extends TournamentForRegistration {
  flights: Flight[];
  description?: string | null;
}

interface PlayerProfile {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  handicapIndex: string;
  ghinNumber: string;
}

interface Props {
  visible: boolean;
  tournament: TournamentForRegistration | null;
  token: string | null;
  userEmail?: string;
  userDisplayName?: string;
  onClose: () => void;
  onSuccess: () => void;
}

const TEE_BOXES = [
  { value: "white", label: "White" },
  { value: "blue", label: "Blue" },
  { value: "red", label: "Red" },
  { value: "gold", label: "Gold" },
  { value: "black", label: "Black" },
];

function formatFee(fee?: string | null, currency?: string): string {
  if (!fee || parseFloat(fee) === 0) return "Free";
  const sym = currency === "USD" ? "$" : currency === "GBP" ? "£" : "₹";
  return `${sym}${parseFloat(fee).toLocaleString()}`;
}

function formatDate(d?: string): string {
  if (!d) return "Date TBD";
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

const FORMAT_LABELS: Record<string, string> = {
  stroke_play: "Stroke Play",
  stableford: "Stableford",
  match_play: "Match Play",
  scramble: "Scramble",
  four_ball: "Four-Ball",
  foursomes: "Foursomes",
  bogey: "Bogey",
  par: "Par Competition",
  greensome: "Greensome",
  texas_scramble: "Texas Scramble",
  ambrose: "Ambrose",
  skins: "Skins",
  eclectic: "Eclectic",
  mixed: "Mixed",
};

export default function TournamentRegistrationSheet({
  visible,
  tournament,
  token,
  userEmail,
  userDisplayName,
  onClose,
  onSuccess,
}: Props) {
  const queryClient = useQueryClient();

  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  const [loading, setLoading] = useState(false);
  const [detail, setDetail] = useState<TournamentDetail | null>(null);
  const [registeredPlayerId, setRegisteredPlayerId] = useState<number | null>(null);
  const [isWaitlisted, setIsWaitlisted] = useState(false);
  const [waitlistPos, setWaitlistPos] = useState<number | null>(null);

  const guessFirstName = useCallback(() => {
    if (!userDisplayName) return "";
    return userDisplayName.split(" ")[0] ?? "";
  }, [userDisplayName]);

  const guessLastName = useCallback(() => {
    if (!userDisplayName) return "";
    const parts = userDisplayName.split(" ");
    return parts.length > 1 ? parts.slice(1).join(" ") : "";
  }, [userDisplayName]);

  const [profile, setProfile] = useState<PlayerProfile>({
    firstName: guessFirstName(),
    lastName: guessLastName(),
    email: userEmail ?? "",
    phone: "",
    handicapIndex: "",
    ghinNumber: "",
  });
  const [selectedFlight, setSelectedFlight] = useState<string>("");
  const [selectedTeeBox, setSelectedTeeBox] = useState<string>("white");
  const [payLoading, setPayLoading] = useState(false);
  const [stripeCheckout, setStripeCheckout] = useState<{
    publishableKey: string; clientSecret: string; paymentIntentId: string; merchantDisplayName: string;
  } | null>(null);
  const [ghinLookupLoading, setGhinLookupLoading] = useState(false);
  const [ghinVerified, setGhinVerified] = useState<{ name: string; handicap: number | null; club: string | null } | null>(null);

  useEffect(() => {
    if (visible && tournament) {
      setStep(1);
      setRegisteredPlayerId(null);
      setIsWaitlisted(false);
      setWaitlistPos(null);
      setProfile({
        firstName: guessFirstName(),
        lastName: guessLastName(),
        email: userEmail ?? "",
        phone: "",
        handicapIndex: "",
        ghinNumber: "",
      });
      setSelectedFlight("");
      setSelectedTeeBox("white");
      setGhinVerified(null);
      fetchDetail();
    }
  }, [visible, tournament?.id]);

  async function lookupGhin() {
    if (!tournament || !profile.ghinNumber.trim()) return;
    setGhinLookupLoading(true);
    setGhinVerified(null);
    try {
      const res = await fetch(
        `${BASE_URL}/api/public/orgs/${tournament.organizationId}/tournaments/${tournament.id}/ghin/player/${encodeURIComponent(profile.ghinNumber.trim())}`
      );
      const data = await res.json() as {
        firstName?: string; lastName?: string; handicapIndex?: number | null; homeClub?: string | null;
        error?: string; code?: string;
      };
      if (!res.ok) {
        if (data.code === "NO_CREDENTIALS") {
          Alert.alert("GHIN Not Configured", "GHIN credentials are not configured for this club. Contact the administrator.");
        } else if (data.code === "NOT_FOUND") {
          Alert.alert("Not Found", "No golfer found with that GHIN number. Please check and try again.");
        } else {
          Alert.alert("Lookup Failed", data.error ?? "Could not retrieve GHIN player data.");
        }
        return;
      }
      setProfile(p => ({
        ...p,
        firstName: data.firstName ?? p.firstName,
        lastName: data.lastName ?? p.lastName,
        handicapIndex: data.handicapIndex != null ? String(data.handicapIndex) : p.handicapIndex,
      }));
      setGhinVerified({ name: `${data.firstName ?? ""} ${data.lastName ?? ""}`.trim(), handicap: data.handicapIndex ?? null, club: data.homeClub ?? null });
    } catch {
      Alert.alert("Error", "Network error during GHIN lookup. Please try again.");
    } finally {
      setGhinLookupLoading(false);
    }
  }

  async function fetchDetail() {
    if (!tournament) return;
    try {
      const url = `${BASE_URL}/api/public/orgs/${tournament.organizationId}/tournaments/${tournament.id}`;
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json() as TournamentDetail;
        setDetail(data);
        if (data.flights?.length === 1) setSelectedFlight(String(data.flights[0].id));
      }
    } catch {
      // non-critical
    }
  }

  const isFree = !detail?.entryFee || parseFloat(detail.entryFee) === 0;
  const spotsLeft = detail?.maxPlayers ? Math.max(0, detail.maxPlayers - (detail.playerCount ?? 0)) : null;
  const tournamentFull = detail?.isFull ?? tournament?.isFull ?? false;

  async function handleRegister() {
    if (!tournament) return;
    if (!profile.firstName.trim() || !profile.lastName.trim() || !profile.email.trim()) {
      Alert.alert("Missing Info", "Please fill in first name, last name, and email.");
      return;
    }
    setLoading(true);
    try {
      const body: Record<string, string | undefined> = {
        firstName: profile.firstName.trim(),
        lastName: profile.lastName.trim(),
        email: profile.email.trim(),
        phone: profile.phone.trim() || undefined,
        handicapIndex: profile.handicapIndex.trim() || undefined,
        ghinNumber: profile.ghinNumber.trim() || undefined,
        teeBox: selectedTeeBox,
        flight: selectedFlight || undefined,
      };
      const res = await fetch(
        `${BASE_URL}/api/public/orgs/${tournament.organizationId}/tournaments/${tournament.id}/register`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      );
      const data = await res.json() as {
        id?: number;
        waitlisted?: boolean;
        position?: number;
        waitlistId?: number;
        error?: string;
        message?: string;
      };
      if (!res.ok && !data.waitlisted) {
        Alert.alert("Registration Failed", data.error ?? "Could not complete registration. Please try again.");
        return;
      }
      if (data.waitlisted) {
        setIsWaitlisted(true);
        setWaitlistPos(data.position ?? null);
        setStep(4);
        queryClient.invalidateQueries({ queryKey: ["my-tournaments"] });
        return;
      }
      setRegisteredPlayerId(data.playerId ?? data.id ?? null);
      queryClient.invalidateQueries({ queryKey: ["my-tournaments"] });
      if (isFree) {
        setStep(4);
      } else {
        setStep(3);
      }
    } catch {
      Alert.alert("Error", "Network error. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  async function handlePayNow() {
    if (!token || !registeredPlayerId) return;
    setPayLoading(true);
    try {
      const orderRes = await fetch(`${BASE_URL}/api/portal/tournament-player/${registeredPlayerId}/order`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
      });
      const orderData = await orderRes.json() as {
        processor?: "razorpay" | "stripe";
        orderId?: string; amount?: number; currency?: string; keyId?: string;
        stripePublishableKey?: string; clientSecret?: string;
        name?: string; playerName?: string; email?: string; error?: string;
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
          Alert.alert("Payment", "Card payments require a production build. Please use the website to complete this payment.");
          return;
        }
        setStripeCheckout({
          publishableKey: orderData.stripePublishableKey,
          clientSecret: orderData.clientSecret,
          paymentIntentId: orderData.orderId,
          merchantDisplayName: orderData.name ?? "Tournament Entry Fee",
        });
        return;
      }

      if (RazorpayCheckout) {
        const opts: RazorpayOptions = {
          key: orderData.keyId!,
          order_id: orderData.orderId,
          amount: orderData.amount!,
          currency: orderData.currency!,
          name: orderData.name ?? "KHARAGOLF",
          description: "Tournament Entry Fee",
          prefill: { name: orderData.playerName, email: orderData.email ?? profile.email },
        };
        const result = await RazorpayCheckout.open(opts);
        await fetch(`${BASE_URL}/api/portal/tournament-player/${registeredPlayerId}/payment-callback`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
          body: JSON.stringify(result),
        });
        queryClient.invalidateQueries({ queryKey: ["my-tournaments"] });
        setStep(4);
      } else {
        Alert.alert(
          "Payment",
          "Native checkout requires a production build. Please use the website to complete this payment.",
        );
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg?.toLowerCase().includes("cancel")) {
        Alert.alert("Payment Error", "Payment could not be completed.");
      }
    } finally {
      setPayLoading(false);
    }
  }

  function handlePayLater() {
    setStep(4);
  }

  function handleDone() {
    onSuccess();
    onClose();
  }

  async function finalizeTournamentStripePayment(paymentIntentId: string) {
    if (!token || !registeredPlayerId) { setStripeCheckout(null); return; }
    try {
      const verifyRes = await fetch(`${BASE_URL}/api/payments/tournament-player/${registeredPlayerId}/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ stripe_payment_intent_id: paymentIntentId }),
      });
      if (verifyRes.ok) {
        queryClient.invalidateQueries({ queryKey: ["my-tournaments"] });
        setStep(4);
      } else {
        const vd = await verifyRes.json().catch(() => ({})) as { error?: string };
        Alert.alert("Verification Failed", vd.error ?? "Payment received but verification failed. Contact the organiser.");
      }
    } finally {
      setStripeCheckout(null);
    }
  }

  if (!tournament) return null;

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        {stripeCheckout && (
          <StripeCheckoutModal
            visible
            publishableKey={stripeCheckout.publishableKey}
            clientSecret={stripeCheckout.clientSecret}
            paymentIntentId={stripeCheckout.paymentIntentId}
            merchantDisplayName={stripeCheckout.merchantDisplayName}
            onSuccess={(intentId) => { void finalizeTournamentStripePayment(intentId); }}
            onCancel={() => setStripeCheckout(null)}
            onError={(msg) => { setStripeCheckout(null); Alert.alert("Payment Error", msg); }}
          />
        )}
        <View style={styles.container}>
          <View style={styles.header}>
            <Text style={styles.headerTitle}>
              {step === 1 ? "Tournament Details" :
               step === 2 ? "Your Information" :
               step === 3 ? "Payment" : "Confirmed"}
            </Text>
            <Pressable onPress={onClose} style={styles.closeBtn} hitSlop={8}>
              <Ionicons name="close" size={22} color={Colors.textSecondary} />
            </Pressable>
          </View>

          {step !== 4 && (
            <View style={styles.stepRow}>
              {[1, 2, 3].map(s => (
                <View key={s} style={styles.stepWrap}>
                  <View style={[styles.stepDot, step >= s && styles.stepDotActive]}>
                    {step > s ? (
                      <Ionicons name="checkmark" size={10} color="#fff" />
                    ) : (
                      <Text style={[styles.stepNum, step >= s && styles.stepNumActive]}>{s}</Text>
                    )}
                  </View>
                  {s < 3 && <View style={[styles.stepLine, step > s && styles.stepLineActive]} />}
                </View>
              ))}
            </View>
          )}

          <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
            {step === 1 && (
              <Step1Details
                tournament={tournament}
                detail={detail}
                isFull={tournamentFull}
                spotsLeft={spotsLeft}
                formatFee={formatFee}
                formatDate={formatDate}
                onContinue={() => setStep(2)}
              />
            )}
            {step === 2 && (
              <Step2Info
                profile={profile}
                setProfile={setProfile}
                flights={detail?.flights ?? []}
                selectedFlight={selectedFlight}
                setSelectedFlight={setSelectedFlight}
                selectedTeeBox={selectedTeeBox}
                setSelectedTeeBox={setSelectedTeeBox}
                isFull={tournamentFull}
                loading={loading}
                onBack={() => setStep(1)}
                onSubmit={handleRegister}
                ghinLookupLoading={ghinLookupLoading}
                ghinVerified={ghinVerified}
                onGhinLookup={lookupGhin}
                onGhinChange={() => setGhinVerified(null)}
              />
            )}
            {step === 3 && (
              <Step3Payment
                entryFee={detail?.entryFee ?? tournament.entryFee}
                currency={detail?.currency ?? tournament.currency ?? "INR"}
                orgId={tournament.organizationId}
                payLoading={payLoading}
                token={token}
                onPayNow={handlePayNow}
                onPayLater={handlePayLater}
                onBack={() => setStep(2)}
              />
            )}
            {step === 4 && (
              <Step4Confirm
                tournament={tournament}
                isWaitlisted={isWaitlisted}
                waitlistPos={waitlistPos}
                customerName={`${profile.firstName} ${profile.lastName}`.trim()}
                customerEmail={profile.email}
                customerPhone={profile.phone}
                onDone={handleDone}
              />
            )}
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function Step1Details({
  tournament,
  detail,
  isFull,
  spotsLeft,
  formatFee,
  formatDate,
  onContinue,
}: {
  tournament: TournamentForRegistration;
  detail: TournamentDetail | null;
  isFull: boolean;
  spotsLeft: number | null;
  formatFee: (f?: string | null, c?: string) => string;
  formatDate: (d?: string) => string;
  onContinue: () => void;
}) {
  const fee = formatFee(detail?.entryFee ?? tournament.entryFee, detail?.currency ?? tournament.currency);

  return (
    <View>
      <View style={styles.tournamentBanner}>
        <View style={styles.bannerIcon}>
          <Ionicons name="golf" size={28} color={Colors.primary} />
        </View>
        <Text style={styles.bannerTitle}>{tournament.name}</Text>
        <Text style={styles.bannerOrg}>{tournament.organizationName}</Text>
      </View>

      <View style={styles.detailCard}>
        <DetailRow icon="calendar" label="Date" value={formatDate(tournament.startDate)} />
        {tournament.courseName && <DetailRow icon="map-pin" label="Course" value={tournament.courseName} />}
        <DetailRow icon="activity" label="Format" value={FORMAT_LABELS[tournament.format] ?? tournament.format} />
        {(detail?.entryFee ?? tournament.entryFee) && parseFloat(detail?.entryFee ?? tournament.entryFee ?? "0") > 0 ? (
          <View style={styles.detailRow} testID="tournament-entry-fee-row">
            <Feather name="dollar-sign" size={15} color={Colors.textSecondary} style={{ marginRight: 8 }} />
            <Text style={styles.detailLabel}>Entry Fee</Text>
            <View style={{ alignItems: "flex-end", maxWidth: "55%" }}>
              <PriceWithFx
                orgId={tournament.organizationId}
                amount={detail?.entryFee ?? tournament.entryFee}
                currency={detail?.currency ?? tournament.currency ?? "INR"}
                productClass="tournament_entry"
                bookedStyle={styles.detailValue}
              />
            </View>
          </View>
        ) : (
          <DetailRow icon="dollar-sign" label="Entry Fee" value="Free" valueColor={Colors.primary} />
        )}
        {tournament.maxPlayers && (
          <DetailRow
            icon="users"
            label="Capacity"
            value={`${tournament.playerCount ?? 0} / ${tournament.maxPlayers}`}
            valueColor={isFull ? Colors.error : Colors.text}
          />
        )}
        {spotsLeft !== null && spotsLeft <= 5 && !isFull && (
          <View style={styles.warningBanner}>
            <Feather name="alert-triangle" size={14} color="#d97706" />
            <Text style={styles.warningText}>Only {spotsLeft} spot{spotsLeft !== 1 ? "s" : ""} left!</Text>
          </View>
        )}
        {isFull && (
          <View style={[styles.warningBanner, styles.warningBannerFull]}>
            <Feather name="info" size={14} color={Colors.textSecondary} />
            <Text style={[styles.warningText, { color: Colors.textSecondary }]}>
              Tournament is full — you will be added to the waitlist.
            </Text>
          </View>
        )}
        {detail?.description ? (
          <View style={{ marginTop: 8 }}>
            <Text style={styles.detailLabel}>About</Text>
            <Text style={styles.description}>{detail.description}</Text>
          </View>
        ) : null}
      </View>

      <Pressable style={styles.primaryBtn} onPress={onContinue}>
        <Text style={styles.primaryBtnText}>{isFull ? "Join Waitlist" : "Register"}</Text>
        <Feather name="arrow-right" size={16} color="#fff" />
      </Pressable>
    </View>
  );
}

function Step2Info({
  profile,
  setProfile,
  flights,
  selectedFlight,
  setSelectedFlight,
  selectedTeeBox,
  setSelectedTeeBox,
  isFull,
  loading,
  onBack,
  onSubmit,
  ghinLookupLoading,
  ghinVerified,
  onGhinLookup,
  onGhinChange,
}: {
  profile: PlayerProfile;
  setProfile: React.Dispatch<React.SetStateAction<PlayerProfile>>;
  flights: Flight[];
  selectedFlight: string;
  setSelectedFlight: (v: string) => void;
  selectedTeeBox: string;
  setSelectedTeeBox: (v: string) => void;
  isFull: boolean;
  loading: boolean;
  onBack: () => void;
  onSubmit: () => void;
  ghinLookupLoading: boolean;
  ghinVerified: { name: string; handicap: number | null; club: string | null } | null;
  onGhinLookup: () => void;
  onGhinChange: () => void;
}) {
  return (
    <View>
      <Text style={styles.sectionTitle}>Player Information</Text>
      <Text style={styles.sectionHint}>Pre-filled from your profile — edit as needed.</Text>

      {/* GHIN Auto-fill */}
      <View style={styles.formField}>
        <Text style={styles.fieldLabel}>GHIN Number <Text style={styles.fieldHint}>(auto-fills name & handicap)</Text></Text>
        <View style={styles.ghinRow}>
          <TextInput
            style={[styles.input, { flex: 1, marginRight: 8 }]}
            value={profile.ghinNumber}
            onChangeText={v => { setProfile(p => ({ ...p, ghinNumber: v })); onGhinChange(); }}
            placeholder="e.g. 1234567"
            placeholderTextColor={Colors.muted}
            keyboardType="numeric"
          />
          <Pressable
            style={[styles.ghinLookupBtn, (!profile.ghinNumber.trim() || ghinLookupLoading) && styles.ghinLookupBtnDisabled]}
            onPress={onGhinLookup}
            disabled={!profile.ghinNumber.trim() || ghinLookupLoading}
          >
            {ghinLookupLoading ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <Text style={styles.ghinLookupBtnText}>Lookup</Text>
            )}
          </Pressable>
        </View>
        {ghinVerified && (
          <View style={styles.ghinVerified}>
            <Feather name="check-circle" size={12} color="#22c55e" />
            <Text style={styles.ghinVerifiedText}>
              {ghinVerified.name}
              {ghinVerified.handicap != null ? `  HCP ${ghinVerified.handicap.toFixed(1)}` : ""}
              {ghinVerified.club ? `  · ${ghinVerified.club}` : ""}
            </Text>
          </View>
        )}
      </View>

      <View style={styles.formRow}>
        <View style={[styles.formField, { flex: 1, marginRight: 6 }]}>
          <Text style={styles.fieldLabel}>First Name *</Text>
          <TextInput
            style={styles.input}
            value={profile.firstName}
            onChangeText={v => setProfile(p => ({ ...p, firstName: v }))}
            placeholder="First name"
            placeholderTextColor={Colors.muted}
            autoCapitalize="words"
          />
        </View>
        <View style={[styles.formField, { flex: 1, marginLeft: 6 }]}>
          <Text style={styles.fieldLabel}>Last Name *</Text>
          <TextInput
            style={styles.input}
            value={profile.lastName}
            onChangeText={v => setProfile(p => ({ ...p, lastName: v }))}
            placeholder="Last name"
            placeholderTextColor={Colors.muted}
            autoCapitalize="words"
          />
        </View>
      </View>

      <View style={styles.formField}>
        <Text style={styles.fieldLabel}>Email *</Text>
        <TextInput
          style={styles.input}
          value={profile.email}
          onChangeText={v => setProfile(p => ({ ...p, email: v }))}
          placeholder="your@email.com"
          placeholderTextColor={Colors.muted}
          keyboardType="email-address"
          autoCapitalize="none"
        />
      </View>

      <View style={styles.formRow}>
        <View style={[styles.formField, { flex: 1, marginRight: 6 }]}>
          <Text style={styles.fieldLabel}>Phone</Text>
          <TextInput
            style={styles.input}
            value={profile.phone}
            onChangeText={v => setProfile(p => ({ ...p, phone: v }))}
            placeholder="+91..."
            placeholderTextColor={Colors.muted}
            keyboardType="phone-pad"
          />
        </View>
        <View style={[styles.formField, { flex: 1, marginLeft: 6 }]}>
          <Text style={styles.fieldLabel}>Handicap Index</Text>
          <TextInput
            style={styles.input}
            value={profile.handicapIndex}
            onChangeText={v => setProfile(p => ({ ...p, handicapIndex: v }))}
            placeholder="e.g. 12.4"
            placeholderTextColor={Colors.muted}
            keyboardType="decimal-pad"
          />
        </View>
      </View>

      <View style={styles.formField}>
        <Text style={styles.fieldLabel}>Tee Box</Text>
        <View style={styles.segmentRow}>
          {TEE_BOXES.map(tb => (
            <Pressable
              key={tb.value}
              style={[styles.segmentBtn, selectedTeeBox === tb.value && styles.segmentBtnActive]}
              onPress={() => setSelectedTeeBox(tb.value)}
            >
              <Text style={[styles.segmentText, selectedTeeBox === tb.value && styles.segmentTextActive]}>
                {tb.label}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      {flights.length > 1 && (
        <View style={styles.formField}>
          <Text style={styles.fieldLabel}>Flight</Text>
          <View style={styles.segmentRow}>
            <Pressable
              style={[styles.segmentBtn, !selectedFlight && styles.segmentBtnActive]}
              onPress={() => setSelectedFlight("")}
            >
              <Text style={[styles.segmentText, !selectedFlight && styles.segmentTextActive]}>Any</Text>
            </Pressable>
            {flights.map(f => (
              <Pressable
                key={f.id}
                style={[styles.segmentBtn, selectedFlight === String(f.id) && styles.segmentBtnActive]}
                onPress={() => setSelectedFlight(String(f.id))}
              >
                <Text style={[styles.segmentText, selectedFlight === String(f.id) && styles.segmentTextActive]}>
                  {f.name}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>
      )}

      <View style={styles.buttonRow}>
        <Pressable style={styles.backBtn} onPress={onBack}>
          <Feather name="arrow-left" size={16} color={Colors.textSecondary} />
          <Text style={styles.backBtnText}>Back</Text>
        </Pressable>
        <Pressable style={[styles.primaryBtn, { flex: 1, marginLeft: 12 }]} onPress={onSubmit} disabled={loading}>
          {loading ? (
            <ActivityIndicator color="#fff" size="small" />
          ) : (
            <>
              <Text style={styles.primaryBtnText}>{isFull ? "Join Waitlist" : "Register"}</Text>
              <Feather name="arrow-right" size={16} color="#fff" />
            </>
          )}
        </Pressable>
      </View>
    </View>
  );
}

export function Step3Payment({
  entryFee,
  currency,
  orgId,
  payLoading,
  token,
  onPayNow,
  onPayLater,
  onBack,
}: {
  entryFee?: string | null;
  currency: string;
  orgId?: number | null;
  payLoading: boolean;
  token: string | null;
  onPayNow: () => void;
  onPayLater: () => void;
  onBack: () => void;
}) {
  return (
    <View>
      <View style={styles.paymentCard} testID="tournament-payment-card">
        <View style={styles.paymentIcon}>
          <Ionicons name="card" size={36} color={Colors.primary} />
        </View>
        <Text style={styles.paymentLabel}>Entry Fee</Text>
        {entryFee ? (
          <PriceWithFx
            orgId={orgId ?? null}
            token={token}
            amount={entryFee}
            currency={currency}
            productClass="tournament_entry"
            bookedStyle={styles.paymentAmount}
          />
        ) : (
          <Text style={styles.paymentAmount}>—</Text>
        )}
        <Text style={styles.paymentHint}>
          You are registered! Pay now to secure your spot, or pay later from the My Events tab.
        </Text>
      </View>

      <Pressable
        style={[styles.primaryBtn, payLoading && { opacity: 0.7 }]}
        onPress={onPayNow}
        disabled={payLoading || !token}
      >
        {payLoading ? (
          <ActivityIndicator color="#fff" size="small" />
        ) : (
          <>
            <Ionicons name="card" size={16} color="#fff" />
            <Text style={[styles.primaryBtnText, { marginLeft: 6 }]}>Pay Now</Text>
          </>
        )}
      </Pressable>

      <Pressable style={styles.secondaryBtn} onPress={onPayLater}>
        <Text style={styles.secondaryBtnText}>Pay Later</Text>
      </Pressable>

      <Pressable style={[styles.backBtn, { marginTop: 4 }]} onPress={onBack}>
        <Feather name="arrow-left" size={16} color={Colors.textSecondary} />
        <Text style={styles.backBtnText}>Back</Text>
      </Pressable>
    </View>
  );
}

interface MerchandiseItem {
  productId: number;
  productName: string;
  price: string;
  stockCount: number | null;
  imageUrl: string | null;
  variants: { id: number; label: string; price: string; stock: number }[];
}

function Step4Confirm({
  tournament,
  isWaitlisted,
  waitlistPos,
  customerName,
  customerEmail,
  customerPhone,
  onDone,
}: {
  tournament: TournamentForRegistration;
  isWaitlisted: boolean;
  waitlistPos: number | null;
  customerName: string;
  customerEmail: string;
  customerPhone?: string;
  onDone: () => void;
}) {
  const [merchandise, setMerchandise] = useState<MerchandiseItem[]>([]);
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [orderLoading, setOrderLoading] = useState(false);
  const [orderPlaced, setOrderPlaced] = useState(false);

  useEffect(() => {
    if (tournament.id && tournament.organizationId) {
      fetch(`${BASE_URL}/api/public/orgs/${tournament.organizationId}/tournaments/${tournament.id}/merchandise`)
        .then(r => r.ok ? r.json() : null)
        .then((data: MerchandiseItem[] | null) => { if (data) setMerchandise(data); })
        .catch(() => {});
    }
  }, [tournament.id, tournament.organizationId]);

  function qtyKey(productId: number, variantId?: number) {
    return variantId ? `v${variantId}` : `p${productId}`;
  }

  function adjustQty(key: string, delta: number) {
    setQuantities(prev => {
      const next = Math.max(0, (prev[key] ?? 0) + delta);
      if (next === 0) {
        const copy = { ...prev };
        delete copy[key];
        return copy;
      }
      return { ...prev, [key]: next };
    });
  }

  async function placeOrder() {
    const orderItems: { productId?: number; variantId?: number; quantity: number }[] = [];
    for (const item of merchandise) {
      if (item.variants.length > 0) {
        for (const v of item.variants) {
          const qty = quantities[qtyKey(item.productId, v.id)] ?? 0;
          if (qty > 0) orderItems.push({ productId: item.productId, variantId: v.id, quantity: qty });
        }
      } else {
        const qty = quantities[qtyKey(item.productId)] ?? 0;
        if (qty > 0) orderItems.push({ productId: item.productId, quantity: qty });
      }
    }
    if (orderItems.length === 0) { onDone(); return; }
    if (!customerName || !customerEmail) {
      Alert.alert("Missing Info", "Player name and email are required to place a merchandise order.");
      return;
    }
    setOrderLoading(true);
    try {
      const res = await fetch(
        `${BASE_URL}/api/public/orgs/${tournament.organizationId}/tournaments/${tournament.id}/merchandise/order`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            customerName,
            customerEmail,
            customerPhone: customerPhone ?? undefined,
            items: orderItems,
          }),
        }
      );
      if (res.ok) {
        setOrderPlaced(true);
      } else {
        const err = await res.json() as { error?: string };
        Alert.alert("Order Failed", err.error ?? "Could not place merchandise order.");
      }
    } catch {
      Alert.alert("Error", "Network error placing merchandise order.");
    } finally {
      setOrderLoading(false);
    }
  }

  const totalSelected = Object.values(quantities).reduce((a, b) => a + b, 0);

  if (orderPlaced) {
    return (
      <View style={styles.confirmWrap}>
        <View style={styles.confirmIcon}>
          <Ionicons name="bag-check" size={64} color={Colors.primary} />
        </View>
        <Text style={styles.confirmTitle}>Order Placed!</Text>
        <Text style={styles.confirmSubtitle}>Your merchandise order has been submitted. The pro shop will have it ready for you.</Text>
        <Pressable style={styles.primaryBtn} onPress={onDone}>
          <Text style={styles.primaryBtnText}>View My Events</Text>
          <Feather name="arrow-right" size={16} color="#fff" />
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.confirmWrap}>
      <View style={styles.confirmIcon}>
        <Ionicons
          name={isWaitlisted ? "time" : "checkmark-circle"}
          size={64}
          color={isWaitlisted ? Colors.secondary : Colors.primary}
        />
      </View>
      <Text style={styles.confirmTitle}>
        {isWaitlisted ? "You're on the Waitlist!" : "You're Registered!"}
      </Text>
      <Text style={styles.confirmSubtitle}>
        {isWaitlisted
          ? `You are #${waitlistPos ?? "?"} on the waitlist for ${tournament.name}. We'll notify you if a spot opens.`
          : `Welcome to ${tournament.name}! Check your email for a confirmation.`}
      </Text>

      <View style={styles.confirmCard}>
        <Text style={styles.confirmCardLabel}>{tournament.organizationName}</Text>
        <Text style={styles.confirmCardName}>{tournament.name}</Text>
        {tournament.startDate && (
          <Text style={styles.confirmCardDate}>{formatDate(tournament.startDate)}</Text>
        )}
      </View>

      {merchandise.length > 0 && (
        <View style={{ width: "100%", marginBottom: 20 }}>
          <Text style={[styles.sectionTitle, { marginBottom: 4 }]}>Tournament Merchandise</Text>
          <Text style={[styles.sectionHint, { marginBottom: 12 }]}>Add items to your registration — collected at check-in.</Text>
          {merchandise.map(item => (
            <View key={item.productId} style={styles.merchCard}>
              <Text style={styles.merchName}>{item.productName}</Text>
              {item.variants.length > 0 ? (
                item.variants.map(v => (
                  <View key={v.id} style={styles.merchRow}>
                    <Text style={styles.merchVariant}>{v.label}</Text>
                    <Text style={styles.merchPrice}>₹{parseFloat(v.price).toLocaleString()}</Text>
                    <View style={styles.qtyRow}>
                      <Pressable onPress={() => adjustQty(qtyKey(item.productId, v.id), -1)} style={styles.qtyBtn}>
                        <Text style={styles.qtyBtnText}>−</Text>
                      </Pressable>
                      <Text style={styles.qtyNum}>{quantities[qtyKey(item.productId, v.id)] ?? 0}</Text>
                      <Pressable onPress={() => adjustQty(qtyKey(item.productId, v.id), 1)} style={styles.qtyBtn}>
                        <Text style={styles.qtyBtnText}>+</Text>
                      </Pressable>
                    </View>
                  </View>
                ))
              ) : (
                <View style={styles.merchRow}>
                  <Text style={styles.merchPrice}>₹{parseFloat(item.price).toLocaleString()}</Text>
                  <View style={styles.qtyRow}>
                    <Pressable onPress={() => adjustQty(qtyKey(item.productId), -1)} style={styles.qtyBtn}>
                      <Text style={styles.qtyBtnText}>−</Text>
                    </Pressable>
                    <Text style={styles.qtyNum}>{quantities[qtyKey(item.productId)] ?? 0}</Text>
                    <Pressable onPress={() => adjustQty(qtyKey(item.productId), 1)} style={styles.qtyBtn}>
                      <Text style={styles.qtyBtnText}>+</Text>
                    </Pressable>
                  </View>
                </View>
              )}
            </View>
          ))}
          <Pressable
            style={[styles.primaryBtn, { marginTop: 8 }, orderLoading && { opacity: 0.7 }]}
            onPress={placeOrder}
            disabled={orderLoading}
          >
            {orderLoading ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <>
                <Feather name="shopping-bag" size={16} color="#fff" />
                <Text style={styles.primaryBtnText}>
                  {totalSelected > 0 ? `Add ${totalSelected} Item${totalSelected !== 1 ? "s" : ""} to Order` : "Skip Merchandise"}
                </Text>
              </>
            )}
          </Pressable>
        </View>
      )}

      {merchandise.length === 0 && (
        <Pressable style={styles.primaryBtn} onPress={onDone}>
          <Text style={styles.primaryBtnText}>View My Events</Text>
          <Feather name="arrow-right" size={16} color="#fff" />
        </Pressable>
      )}
    </View>
  );
}

function DetailRow({
  icon,
  label,
  value,
  valueColor,
}: {
  icon: string;
  label: string;
  value: string;
  valueColor?: string;
}) {
  return (
    <View style={styles.detailRow}>
      <Feather name={icon as never} size={15} color={Colors.textSecondary} style={{ marginRight: 8 }} />
      <Text style={styles.detailLabel}>{label}</Text>
      <Text style={[styles.detailValue, valueColor ? { color: valueColor } : null]}>{value}</Text>
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
    paddingTop: 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  headerTitle: {
    fontSize: 17,
    fontWeight: "700",
    color: Colors.text,
  },
  closeBtn: {
    padding: 4,
  },
  stepRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 14,
    gap: 0,
  },
  stepWrap: {
    flexDirection: "row",
    alignItems: "center",
  },
  stepDot: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: Colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  stepDotActive: {
    backgroundColor: Colors.primary,
  },
  stepNum: {
    fontSize: 12,
    fontWeight: "600",
    color: Colors.textSecondary,
  },
  stepNumActive: {
    color: "#fff",
  },
  stepLine: {
    width: 40,
    height: 2,
    backgroundColor: Colors.border,
    marginHorizontal: 4,
  },
  stepLineActive: {
    backgroundColor: Colors.primary,
  },
  scrollContent: {
    padding: 20,
    paddingBottom: 40,
  },
  tournamentBanner: {
    alignItems: "center",
    marginBottom: 20,
  },
  bannerIcon: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: Colors.primary + "18",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 10,
  },
  bannerTitle: {
    fontSize: 20,
    fontWeight: "700",
    color: Colors.text,
    textAlign: "center",
    marginBottom: 4,
  },
  bannerOrg: {
    fontSize: 14,
    color: Colors.textSecondary,
    textAlign: "center",
  },
  detailCard: {
    backgroundColor: Colors.card,
    borderRadius: 12,
    padding: 16,
    marginBottom: 20,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  detailRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border + "60",
  },
  detailLabel: {
    fontSize: 13,
    color: Colors.textSecondary,
    flex: 1,
  },
  detailValue: {
    fontSize: 13,
    fontWeight: "600",
    color: Colors.text,
    textAlign: "right",
    maxWidth: "55%",
  },
  description: {
    fontSize: 13,
    color: Colors.textSecondary,
    lineHeight: 19,
    marginTop: 4,
  },
  warningBanner: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#fef3c7",
    borderRadius: 8,
    padding: 8,
    marginTop: 10,
    gap: 6,
  },
  warningBannerFull: {
    backgroundColor: Colors.card,
  },
  warningText: {
    fontSize: 12,
    color: "#92400e",
    flex: 1,
  },
  primaryBtn: {
    backgroundColor: Colors.primary,
    borderRadius: 12,
    paddingVertical: 14,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    marginBottom: 10,
  },
  primaryBtnText: {
    color: "#fff",
    fontSize: 15,
    fontWeight: "700",
  },
  secondaryBtn: {
    backgroundColor: Colors.card,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: Colors.border,
    marginBottom: 10,
  },
  secondaryBtnText: {
    color: Colors.text,
    fontSize: 15,
    fontWeight: "600",
  },
  sectionTitle: {
    fontSize: 17,
    fontWeight: "700",
    color: Colors.text,
    marginBottom: 4,
  },
  sectionHint: {
    fontSize: 13,
    color: Colors.textSecondary,
    marginBottom: 16,
  },
  formRow: {
    flexDirection: "row",
    marginBottom: 12,
  },
  formField: {
    marginBottom: 12,
  },
  fieldLabel: {
    fontSize: 12,
    fontWeight: "600",
    color: Colors.textSecondary,
    marginBottom: 6,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  fieldHint: {
    fontSize: 11,
    fontWeight: "400",
    color: Colors.muted,
    textTransform: "none",
    letterSpacing: 0,
  },
  ghinRow: {
    flexDirection: "row",
    alignItems: "center",
  },
  ghinLookupBtn: {
    backgroundColor: Colors.primary,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    minWidth: 72,
    alignItems: "center",
    justifyContent: "center",
  },
  ghinLookupBtnDisabled: {
    opacity: 0.5,
  },
  ghinLookupBtnText: {
    fontSize: 13,
    fontWeight: "700",
    color: "#fff",
  },
  ghinVerified: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 6,
    backgroundColor: "rgba(34,197,94,0.08)",
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: "rgba(34,197,94,0.25)",
  },
  ghinVerifiedText: {
    fontSize: 12,
    color: Colors.text,
    flex: 1,
  },
  input: {
    backgroundColor: Colors.card,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    color: Colors.text,
  },
  segmentRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
  },
  segmentBtn: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 8,
    backgroundColor: Colors.card,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  segmentBtnActive: {
    backgroundColor: Colors.primary,
    borderColor: Colors.primary,
  },
  segmentText: {
    fontSize: 13,
    color: Colors.textSecondary,
    fontWeight: "500",
  },
  segmentTextActive: {
    color: "#fff",
    fontWeight: "600",
  },
  buttonRow: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: 8,
  },
  backBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    padding: 8,
  },
  backBtnText: {
    fontSize: 14,
    color: Colors.textSecondary,
  },
  paymentCard: {
    backgroundColor: Colors.card,
    borderRadius: 16,
    padding: 24,
    alignItems: "center",
    borderWidth: 1,
    borderColor: Colors.border,
    marginBottom: 24,
  },
  paymentIcon: {
    marginBottom: 12,
  },
  paymentLabel: {
    fontSize: 13,
    color: Colors.textSecondary,
    marginBottom: 4,
  },
  paymentAmount: {
    fontSize: 36,
    fontWeight: "700",
    color: Colors.text,
    marginBottom: 12,
  },
  paymentHint: {
    fontSize: 13,
    color: Colors.textSecondary,
    textAlign: "center",
    lineHeight: 19,
  },
  confirmWrap: {
    alignItems: "center",
    paddingTop: 20,
  },
  confirmIcon: {
    marginBottom: 16,
  },
  confirmTitle: {
    fontSize: 24,
    fontWeight: "700",
    color: Colors.text,
    textAlign: "center",
    marginBottom: 8,
  },
  confirmSubtitle: {
    fontSize: 14,
    color: Colors.textSecondary,
    textAlign: "center",
    lineHeight: 21,
    marginBottom: 24,
    paddingHorizontal: 10,
  },
  confirmCard: {
    backgroundColor: Colors.card,
    borderRadius: 12,
    padding: 16,
    alignItems: "center",
    borderWidth: 1,
    borderColor: Colors.border,
    width: "100%",
    marginBottom: 24,
  },
  confirmCardLabel: {
    fontSize: 12,
    color: Colors.textSecondary,
    marginBottom: 4,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  confirmCardName: {
    fontSize: 18,
    fontWeight: "700",
    color: Colors.text,
    textAlign: "center",
    marginBottom: 4,
  },
  confirmCardDate: {
    fontSize: 13,
    color: Colors.textSecondary,
  },
  merchCard: {
    backgroundColor: Colors.card,
    borderRadius: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: Colors.border,
    marginBottom: 10,
    width: "100%",
  },
  merchName: {
    fontSize: 14,
    fontWeight: "700",
    color: Colors.text,
    marginBottom: 8,
  },
  merchRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 4,
  },
  merchVariant: {
    fontSize: 13,
    color: Colors.textSecondary,
    flex: 1,
  },
  merchPrice: {
    fontSize: 13,
    fontWeight: "600",
    color: Colors.text,
    marginRight: 12,
  },
  qtyRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  qtyBtn: {
    backgroundColor: Colors.primary,
    borderRadius: 6,
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
  },
  qtyBtnText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "700",
    lineHeight: 18,
  },
  qtyNum: {
    fontSize: 14,
    fontWeight: "700",
    color: Colors.text,
    minWidth: 20,
    textAlign: "center",
  },
});

