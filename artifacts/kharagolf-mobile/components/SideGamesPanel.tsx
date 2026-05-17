/**
 * SideGamesPanel — live standings + settlement sheet for skins/snake/wolf/nassau.
 *
 * Polls /api/side-game-instances?tournamentId=&round= (or generalPlayRoundId=)
 * and shows per-player net + who-owes-whom rows, with a "Settle" action for
 * the round director and a "Pay now" action (Razorpay UPI/cards or club
 * wallet) for the player who owes each persisted settlement (Task #455).
 *
 * For Wolf and Nassau instances, also exposes live capture controls so the
 * group can record wolf picks and Nassau presses on the course:
 *   - Wolf: "Pick partner / Lone wolf / Blind wolf" prompt for the wolf of
 *     the current hole.
 *   - Nassau: "Call press" buttons for either side, scoped to the current
 *     segment (front/back/total).
 */
import React, { useEffect, useState } from "react";
import { View, Text, StyleSheet, Pressable, ActivityIndicator, FlatList, Alert, Modal } from "react-native";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchPortal, postPortal, putPortal } from "@/utils/api";
import { BASE_URL } from "@/utils/api";
import { NotifyBadgesRow } from "@/components/NotifyBadgesRow";

// Razorpay native module isn't available in Expo Go; load defensively so the
// rest of the panel still renders. Pay-now will surface a clear error when
// the module is missing.
type RzpOpts = Record<string, unknown>;
type RzpResult = { razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string };
let RazorpayCheckout: { open: (opts: RzpOpts) => Promise<RzpResult> } | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  RazorpayCheckout = require("react-native-razorpay").default;
} catch {
  RazorpayCheckout = null;
}

type Scope =
  | { tournamentId: number; round?: number }
  | { generalPlayRoundId: number }
  | { leagueRoundId: number };

interface PlayerStanding {
  playerId: number;
  /** App user id behind this player, when known. Drives the wolf/nassau gating. */
  userId?: number | null;
  name: string;
  net: number;
  detail: Record<string, unknown>;
}

interface Standings {
  perPlayer: PlayerStanding[];
  perHoleNotes: Array<{ hole: number; note: string }>;
  settlements: Array<{ fromPlayerId: number; fromName: string; toPlayerId: number; toName: string; amount: number }>;
  summary: string;
  gameType: string;
}

interface WolfPick {
  hole: number;
  mode: "partner" | "lone" | "blind";
  partnerPlayerId?: number | null;
}

interface NassauPress {
  hole: number;
  calledByTeam: "A" | "B";
  segment: "front" | "back" | "total";
}

interface InstanceEvents {
  picks?: WolfPick[];
  presses?: NassauPress[];
  [k: string]: unknown;
}

interface Instance {
  id: number;
  gameType: string;
  name: string | null;
  rules: Record<string, unknown> & {
    wolfOrder?: number[];
    teamA?: number[];
    teamB?: number[];
    frontHoles?: number[];
    backHoles?: number[];
    allowPress?: boolean;
  };
  events: InstanceEvents | null;
  stake: string | null;
  currency: string | null;
  status: string;
  organizationId: number;
  participantPlayerIds?: number[];
}

// Task #1841 — per-channel notify state surfaced by the side-games-v2
// settlement endpoint, used to render the same "next try in 2m 14s" /
// "gave up X ago" badges that wallet withdrawals already get on this
// surface. Mirrors the web NotifyInfo shape in
// artifacts/kharagolf-web/src/components/SideGamesAdmin.tsx.
type NotifyDeliveryStatus = 'sent' | 'retrying' | 'failed_permanent';
interface NotifyChannel {
  status: NotifyDeliveryStatus | null;
  attempts: number;
  lastAt: string | null;
  nextRetryAt: string | null;
  exhaustedAt: string | null;
}
interface NotifyInfo { email: NotifyChannel; push: NotifyChannel }

interface PersistedSettlement {
  id: number;
  fromPlayerId: number | null;
  fromName: string | null;
  toPlayerId: number | null;
  toName: string | null;
  amount: string;
  currency: string | null;
  status: "pending" | "paid" | "cancelled";
  paymentMethod: string | null;
  paymentRef: string | null;
  fromUserId: number | null;
  toUserId: number | null;
  notify?: NotifyInfo | null;
}

function buildQuery(scope: Scope): string {
  const params = new URLSearchParams();
  if ("tournamentId" in scope) {
    params.set("tournamentId", String(scope.tournamentId));
    if (scope.round) params.set("round", String(scope.round));
  } else if ("generalPlayRoundId" in scope) {
    params.set("generalPlayRoundId", String(scope.generalPlayRoundId));
  } else if ("leagueRoundId" in scope) {
    params.set("leagueRoundId", String(scope.leagueRoundId));
  }
  return params.toString();
}

/** Direct fetch with Bearer auth, hitting /api/<path> (the side-games-v2 router is mounted at /api). */
async function apiFetch<T>(path: string, token: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE_URL}/api${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? `API error ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export function SideGamesPanel({ scope, token, isAdmin = false, currentUserId, currentHole = null }: {
  scope: Scope;
  token: string | null;
  isAdmin?: boolean;
  /** Logged-in player's app_users.id — used to gate "Pay now" to debtors only. */
  currentUserId?: number | null;
  /** Hole the group is currently playing — drives live wolf/nassau prompts. */
  currentHole?: number | null;
}) {
  const qc = useQueryClient();
  const queryString = buildQuery(scope);
  const listKey = ["side-game-instances", queryString];

  const { data: instances, isLoading } = useQuery<Instance[]>({
    queryKey: listKey,
    enabled: !!token,
    queryFn: () => fetchPortal<Instance[]>(`/side-game-instances?${queryString}`, token!),
    refetchInterval: 30_000,
  });

  if (!token) return null;
  if (isLoading) return <ActivityIndicator style={{ marginVertical: 12 }} />;
  if (!instances || instances.length === 0) {
    return (
      <View style={styles.empty}>
        <Text style={styles.emptyText}>No side games for this round.</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Text style={styles.header}>Side Games</Text>
      {instances.map(inst => (
        <SideGameCard
          key={inst.id}
          instance={inst}
          token={token}
          isAdmin={isAdmin}
          currentUserId={currentUserId ?? null}
          currentHole={currentHole}
          onChanged={() => qc.invalidateQueries({ queryKey: listKey })}
        />
      ))}
    </View>
  );
}

function SideGameCard({ instance, token, isAdmin, currentUserId, currentHole, onChanged }: {
  instance: Instance;
  token: string;
  isAdmin: boolean;
  currentUserId: number | null;
  currentHole: number | null;
  onChanged: () => void;
}) {
  const qc = useQueryClient();
  const [showNotes, setShowNotes] = useState(false);
  const standingsKey = ["side-game-standings", instance.id];
  const detailKey = ["side-game-instance", instance.id];

  const { data, isLoading } = useQuery<{ standings: Standings; currency: string; stake: number; holesScored: number; instance: Instance }>({
    queryKey: standingsKey,
    queryFn: () => fetchPortal(`/side-game-instances/${instance.id}/standings`, token),
    refetchInterval: 30_000,
  });

  // Persisted settlements (only meaningful once the instance has been settled).
  const { data: detail } = useQuery<{ settlements: PersistedSettlement[] }>({
    queryKey: detailKey,
    enabled: instance.status === "completed",
    queryFn: () => apiFetch(`/side-game-instances/${instance.id}`, token),
    refetchInterval: 30_000,
  });

  const settle = useMutation({
    mutationFn: () => postPortal(`/side-game-instances/${instance.id}/settle`, token, {}),
    onSuccess: () => {
      onChanged();
      qc.invalidateQueries({ queryKey: detailKey });
      qc.invalidateQueries({ queryKey: standingsKey });
    },
  });

  const updateEvents = useMutation({
    mutationFn: (events: InstanceEvents) =>
      putPortal(`/side-game-instances/${instance.id}`, token, { events }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: standingsKey });
      onChanged();
    },
  });

  // Prefer the freshly-loaded instance from /standings — it carries the
  // latest events written by other group members.
  const liveInstance: Instance = data?.instance ? { ...instance, ...data.instance } as Instance : instance;
  const standings = data?.standings;
  const currency = data?.currency ?? "INR";
  const settlements = detail?.settlements ?? [];

  // Task #1841 — re-render every 5s while at least one paid settlement
  // has a live notify retry timer so the "next try in 2m 14s" / "gave
  // up X ago" suffix on the email/push receipt badges stays accurate
  // between fetches. Mirrors the wallet-withdrawal ticker on `wallet.tsx`.
  const hasLiveRetryTimer = settlements.some(s => {
    const n = s.notify;
    if (!n) return false;
    return n.email.nextRetryAt != null || n.push.nextRetryAt != null
      || n.email.exhaustedAt != null || n.push.exhaustedAt != null;
  });
  const [retryNowMs, setRetryNowMs] = useState<number>(() => Date.now());
  useEffect(() => {
    if (!hasLiveRetryTimer) return;
    setRetryNowMs(Date.now());
    const id = setInterval(() => setRetryNowMs(Date.now()), 5000);
    return () => clearInterval(id);
  }, [hasLiveRetryTimer]);

  return (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <Text style={styles.cardTitle}>{liveInstance.name ?? liveInstance.gameType.toUpperCase()}</Text>
        <Text style={styles.cardSubtitle}>
          {liveInstance.gameType} · stake {liveInstance.stake ?? "1"} {currency} · {data?.holesScored ?? 0} holes
        </Text>
      </View>

      {isLoading || !standings ? (
        <ActivityIndicator size="small" />
      ) : (
        <>
          {liveInstance.gameType === "wolf" && currentHole != null && liveInstance.status !== "completed" && (
            <WolfControls
              instance={liveInstance}
              standings={standings}
              currentHole={currentHole}
              currentUserId={currentUserId}
              busy={updateEvents.isPending}
              onSubmit={(events) => updateEvents.mutate(events)}
            />
          )}

          {liveInstance.gameType === "nassau" && currentHole != null && liveInstance.status !== "completed" && (
            <NassauControls
              instance={liveInstance}
              standings={standings}
              currentHole={currentHole}
              currentUserId={currentUserId}
              busy={updateEvents.isPending}
              onSubmit={(events) => updateEvents.mutate(events)}
            />
          )}

          {standings.perPlayer.length === 0 ? (
            <Text style={styles.muted}>No participants configured.</Text>
          ) : (
            <FlatList
              data={[...standings.perPlayer].sort((a, b) => b.net - a.net)}
              keyExtractor={p => String(p.playerId)}
              scrollEnabled={false}
              renderItem={({ item }) => (
                <View style={styles.row}>
                  <Text style={styles.playerName} numberOfLines={1}>{item.name}</Text>
                  <Text style={[styles.netCell, item.net > 0 ? styles.win : item.net < 0 ? styles.lose : null]}>
                    {item.net > 0 ? "+" : ""}{item.net.toFixed(2)}
                  </Text>
                </View>
              )}
            />
          )}

          {standings.summary ? <Text style={styles.summary}>{standings.summary}</Text> : null}

          {/* Persisted settlements (with Pay now actions) take precedence
              over the live preview once a round has been settled. */}
          {settlements.length > 0 ? (
            <View style={styles.settlements}>
              <Text style={styles.sectionLabel}>Who owes whom</Text>
              {settlements.map(s => (
                <SettlementRow
                  key={s.id}
                  settlement={s}
                  token={token}
                  currentUserId={currentUserId}
                  organizationId={liveInstance.organizationId}
                  retryNowMs={retryNowMs}
                  onPaid={() => qc.invalidateQueries({ queryKey: detailKey })}
                />
              ))}
            </View>
          ) : standings.settlements.length > 0 ? (
            <View style={styles.settlements}>
              <Text style={styles.sectionLabel}>Who owes whom</Text>
              {standings.settlements.map((s, i) => (
                <Text key={i} style={styles.owes}>
                  {s.fromName} → {s.toName}: {currency} {s.amount.toFixed(2)}
                </Text>
              ))}
            </View>
          ) : null}

          {standings.perHoleNotes.length > 0 && (
            <Pressable onPress={() => setShowNotes(v => !v)} style={styles.toggleBtn}>
              <Text style={styles.toggleText}>{showNotes ? "Hide" : "Show"} per-hole notes ({standings.perHoleNotes.length})</Text>
            </Pressable>
          )}
          {showNotes && standings.perHoleNotes.map((n, i) => (
            <Text key={i} style={styles.noteRow}>Hole {n.hole}: {n.note}</Text>
          ))}

          {isAdmin && liveInstance.status !== "completed" && (
            <Pressable
              style={[styles.settleBtn, settle.isPending && styles.settleBtnBusy]}
              onPress={() => settle.mutate()}
              disabled={settle.isPending}
            >
              <Text style={styles.settleBtnText}>{settle.isPending ? "Settling…" : "Lock & Settle"}</Text>
            </Pressable>
          )}
        </>
      )}
    </View>
  );
}

// ─── Wolf controls ─────────────────────────────────────────────────────

function wolfForHole(instance: Instance, standings: Standings, hole: number): PlayerStanding | null {
  // Preference order matches the server (routes/side-games-v2.ts ::
  // wolfOrderFor) so the live UI and the authorization check agree on
  // who the wolf is for any given hole.
  const order = (instance.rules.wolfOrder && instance.rules.wolfOrder.length > 0)
    ? instance.rules.wolfOrder
    : (instance.participantPlayerIds && instance.participantPlayerIds.length > 0)
    ? instance.participantPlayerIds
    : standings.perPlayer.map(p => p.playerId);
  if (order.length === 0) return null;
  const wolfId = order[(hole - 1) % order.length];
  return standings.perPlayer.find(p => p.playerId === wolfId) ?? null;
}

function WolfControls({ instance, standings, currentHole, currentUserId, busy, onSubmit }: {
  instance: Instance;
  standings: Standings;
  currentHole: number;
  currentUserId: number | null;
  busy: boolean;
  onSubmit: (events: InstanceEvents) => void;
}) {
  const wolf = wolfForHole(instance, standings, currentHole);
  const picks: WolfPick[] = instance.events?.picks ?? [];
  const existing = picks.find(p => p.hole === currentHole) ?? null;
  const [partnerOpen, setPartnerOpen] = useState(false);

  if (!wolf) return null;

  // Only the wolf for this hole gets the live capture controls. Everyone
  // else sees a read-only "waiting for…" line so accidental edits from
  // another phone in the group can't change a pick.
  const isWolf = currentUserId != null && wolf.userId != null && wolf.userId === currentUserId;

  const teammates = standings.perPlayer.filter(p => p.playerId !== wolf.playerId);

  const writePick = (pick: WolfPick) => {
    const next = picks.filter(p => p.hole !== currentHole).concat(pick);
    onSubmit({ ...(instance.events ?? {}), picks: next });
  };

  const clearPick = () => {
    const next = picks.filter(p => p.hole !== currentHole);
    onSubmit({ ...(instance.events ?? {}), picks: next });
  };

  const partnerName = (id: number | null | undefined) =>
    teammates.find(t => t.playerId === id)?.name ?? "?";

  return (
    <View style={styles.live}>
      <Text style={styles.liveTitle}>Hole {currentHole} · Wolf: {wolf.name}</Text>
      {existing ? (
        <View style={{ marginTop: 4 }}>
          <Text style={styles.liveSubtitle}>
            {existing.mode === "partner"
              ? `Picked partner: ${partnerName(existing.partnerPlayerId)}`
              : existing.mode === "lone"
              ? "Going lone wolf (x2)"
              : "Blind wolf declared (x3)"}
          </Text>
          {isWolf && (
            <Pressable style={styles.linkBtn} onPress={clearPick} disabled={busy}>
              <Text style={styles.linkText}>Change pick</Text>
            </Pressable>
          )}
        </View>
      ) : isWolf ? (
        <View style={styles.btnRow}>
          <Pressable
            style={[styles.actionBtn, busy && styles.actionBtnBusy]}
            onPress={() => setPartnerOpen(true)}
            disabled={busy || teammates.length === 0}
          >
            <Text style={styles.actionBtnText}>Pick partner</Text>
          </Pressable>
          <Pressable
            style={[styles.actionBtn, busy && styles.actionBtnBusy]}
            onPress={() => writePick({ hole: currentHole, mode: "lone" })}
            disabled={busy}
          >
            <Text style={styles.actionBtnText}>Lone wolf</Text>
          </Pressable>
          <Pressable
            style={[styles.actionBtn, busy && styles.actionBtnBusy]}
            onPress={() => writePick({ hole: currentHole, mode: "blind" })}
            disabled={busy}
          >
            <Text style={styles.actionBtnText}>Blind wolf</Text>
          </Pressable>
        </View>
      ) : (
        <Text style={styles.liveSubtitle}>Waiting for {wolf.name} to pick…</Text>
      )}

      <Modal transparent animationType="fade" visible={partnerOpen} onRequestClose={() => setPartnerOpen(false)}>
        <Pressable style={styles.modalBackdrop} onPress={() => setPartnerOpen(false)}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Pick a partner</Text>
            {teammates.map(t => (
              <Pressable
                key={t.playerId}
                style={styles.modalRow}
                onPress={() => {
                  writePick({ hole: currentHole, mode: "partner", partnerPlayerId: t.playerId });
                  setPartnerOpen(false);
                }}
              >
                <Text style={styles.modalRowText}>{t.name}</Text>
              </Pressable>
            ))}
            <Pressable style={[styles.modalRow, { borderTopWidth: 1, borderTopColor: "#eee", marginTop: 4 }]}
              onPress={() => setPartnerOpen(false)}>
              <Text style={[styles.modalRowText, { color: "#888" }]}>Cancel</Text>
            </Pressable>
          </View>
        </Pressable>
      </Modal>
    </View>
  );
}

// ─── Nassau controls ───────────────────────────────────────────────────

function defaultSegment(instance: Instance, hole: number): "front" | "back" {
  const back = instance.rules.backHoles ?? Array.from({ length: 9 }, (_, i) => i + 10);
  return back.includes(hole) ? "back" : "front";
}

function NassauControls({ instance, standings, currentHole, currentUserId, busy, onSubmit }: {
  instance: Instance;
  standings: Standings;
  currentHole: number;
  currentUserId: number | null;
  busy: boolean;
  onSubmit: (events: InstanceEvents) => void;
}) {
  const allowPress = instance.rules.allowPress !== false;
  const presses: NassauPress[] = instance.events?.presses ?? [];
  const [segment, setSegment] = useState<"front" | "back" | "total">(defaultSegment(instance, currentHole));
  const [segmentTouched, setSegmentTouched] = useState(false);

  // Figure out which Nassau team the logged-in user belongs to so we only
  // expose the "Press · Team A/B" button for their own side. Members are
  // configured as playerIds on instance.rules.teamA / teamB; we map back to
  // userIds via standings.perPlayer.
  const teamA = (instance.rules.teamA ?? []).map(Number);
  const teamB = (instance.rules.teamB ?? []).map(Number);
  const myPlayerIds = currentUserId == null
    ? []
    : standings.perPlayer.filter(p => p.userId != null && p.userId === currentUserId).map(p => p.playerId);
  const onTeamA = myPlayerIds.some(pid => teamA.includes(pid));
  const onTeamB = myPlayerIds.some(pid => teamB.includes(pid));
  const myTeam: "A" | "B" | null = onTeamA ? "A" : onTeamB ? "B" : null;

  // Auto-track the segment to whichever side of the round we're on, until
  // the user manually picks one (e.g. they want a "total" press from the front).
  useEffect(() => {
    if (!segmentTouched) setSegment(defaultSegment(instance, currentHole));
  }, [currentHole, instance, segmentTouched]);

  const callPress = (team: "A" | "B") => {
    const next: NassauPress[] = [...presses, { hole: currentHole, calledByTeam: team, segment }];
    onSubmit({ ...(instance.events ?? {}), presses: next });
  };

  const removePress = (idx: number) => {
    const next = presses.filter((_, i) => i !== idx);
    onSubmit({ ...(instance.events ?? {}), presses: next });
  };

  const canPress = (team: "A" | "B") => myTeam === team;

  return (
    <View style={styles.live}>
      <Text style={styles.liveTitle}>Hole {currentHole} · Nassau presses</Text>
      {!allowPress ? (
        <Text style={styles.liveSubtitle}>Presses are disabled for this match.</Text>
      ) : (
        <>
          <View style={styles.segRow}>
            {(["front", "back", "total"] as const).map(s => (
              <Pressable
                key={s}
                onPress={() => { setSegment(s); setSegmentTouched(true); }}
                style={[styles.segBtn, segment === s && styles.segBtnActive]}
              >
                <Text style={[styles.segBtnText, segment === s && styles.segBtnTextActive]}>{s.toUpperCase()}</Text>
              </Pressable>
            ))}
          </View>
          <View style={styles.btnRow}>
            <Pressable
              style={[styles.actionBtn, (busy || !canPress("A")) && styles.actionBtnBusy]}
              onPress={() => callPress("A")}
              disabled={busy || !canPress("A")}
            >
              <Text style={styles.actionBtnText}>Press · Team A</Text>
            </Pressable>
            <Pressable
              style={[styles.actionBtn, (busy || !canPress("B")) && styles.actionBtnBusy]}
              onPress={() => callPress("B")}
              disabled={busy || !canPress("B")}
            >
              <Text style={styles.actionBtnText}>Press · Team B</Text>
            </Pressable>
          </View>
          {myTeam == null && (
            <Text style={styles.liveSubtitle}>Only members of Team A or B can call a press.</Text>
          )}
        </>
      )}

      {presses.length > 0 && (
        <View style={{ marginTop: 8 }}>
          <Text style={styles.sectionLabel}>Presses called</Text>
          {presses.map((p, i) => (
            <View key={i} style={styles.pressRow}>
              <Text style={styles.pressText}>
                Hole {p.hole} · Team {p.calledByTeam} · {p.segment}
              </Text>
              {canPress(p.calledByTeam) && (
                <Pressable onPress={() => removePress(i)} disabled={busy}>
                  <Text style={styles.linkText}>Remove</Text>
                </Pressable>
              )}
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

/** A single who-owes-whom row, with a "Pay now" action when the current user owes. */
function SettlementRow({ settlement, token, currentUserId, organizationId, retryNowMs, onPaid }: {
  settlement: PersistedSettlement;
  token: string;
  currentUserId: number | null;
  organizationId: number;
  // Task #1841 — wall-clock (refreshed by `SideGameCard` every 5s) so the
  // "next try in 2m 14s" / "gave up X ago" suffix on receipt notify badges
  // stays accurate without each row spinning up its own ticker.
  retryNowMs: number;
  onPaid: () => void;
}) {
  const currency = settlement.currency ?? "INR";
  const isMine = currentUserId != null && settlement.fromUserId === currentUserId;
  const isPending = settlement.status === "pending";
  const amount = Number(settlement.amount);

  const payRazorpay = useMutation({
    mutationFn: async () => {
      if (!RazorpayCheckout) {
        throw new Error('Install the dev build to enable Razorpay (Expo Go does not support it).');
      }
      const order = await apiFetch<{ orderId: string; amount: number; currency: string; keyId: string }>(
        `/side-game-settlements/${settlement.id}/pay-order`, token, { method: 'POST', body: '{}' },
      );
      const checkout = await RazorpayCheckout.open({
        key: order.keyId,
        amount: order.amount,
        currency: order.currency,
        name: 'KHARAGOLF',
        description: `Settle up with ${settlement.toName ?? 'player'}`,
        order_id: order.orderId,
        prefill: {},
        theme: { color: '#0a7d33' },
      });
      await apiFetch(`/side-game-settlements/${settlement.id}/pay-verify`, token, {
        method: 'POST',
        body: JSON.stringify({
          razorpayOrderId: checkout.razorpay_order_id,
          razorpayPaymentId: checkout.razorpay_payment_id,
          razorpaySignature: checkout.razorpay_signature,
        }),
      });
    },
    onSuccess: () => { onPaid(); Alert.alert('Paid', 'Settlement marked paid.'); },
    onError: (err: Error) => {
      // Razorpay throws on user cancellation — that's not really an error.
      if (err.message?.toLowerCase().includes('cancel')) return;
      Alert.alert('Payment failed', err.message ?? 'Could not complete payment');
    },
  });

  const payWallet = useMutation({
    mutationFn: () => apiFetch(`/side-game-settlements/${settlement.id}/pay-wallet`, token, {
      method: 'POST', body: '{}',
    }),
    onSuccess: () => { onPaid(); Alert.alert('Paid', 'Settled from wallet balance.'); },
    onError: (err: Error) => {
      if (err.message === 'INSUFFICIENT_FUNDS') {
        Alert.alert('Insufficient wallet balance', 'Top up your wallet or pay via UPI.');
        return;
      }
      Alert.alert('Payment failed', err.message ?? 'Could not complete payment');
    },
  });

  const showPicker = () => {
    Alert.alert(
      `Pay ${currency} ${amount.toFixed(2)}`,
      `Settle up with ${settlement.toName ?? 'player'}`,
      [
        { text: 'Wallet balance', onPress: () => payWallet.mutate() },
        { text: 'UPI / Card', onPress: () => payRazorpay.mutate() },
        { text: 'Cancel', style: 'cancel' },
      ],
    );
  };

  const busy = payRazorpay.isPending || payWallet.isPending;
  return (
    <View style={{ paddingVertical: 4 }} testID={`settlement-row-${settlement.id}`}>
      <View style={styles.settlementRow}>
        <Text style={styles.owes}>
          {settlement.fromName ?? '?'} → {settlement.toName ?? '?'}: {currency} {amount.toFixed(2)}
        </Text>
        {settlement.status === 'paid' ? (
          <Text style={styles.paidBadge}>PAID</Text>
        ) : isMine && isPending ? (
          <Pressable
            style={[styles.payBtn, busy && styles.payBtnBusy]}
            onPress={showPicker}
            disabled={busy}
          >
            <Text style={styles.payBtnText}>{busy ? 'Paying…' : 'Pay now'}</Text>
          </Pressable>
        ) : null}
      </View>
      {/* Task #1841 — receipt notify badges (email + push) with the
          shared "next try in 2m 14s" / "gave up X ago" countdown that
          wallet withdrawals already render. Only meaningful once the
          settlement has been paid (the notify pipeline fires from
          `notifySettlementPaid`). */}
      {settlement.status === 'paid' && settlement.notify ? (
        <NotifyBadgesRow
          notify={settlement.notify}
          retryNowMs={retryNowMs}
          rowTestID={`row-settlement-notify-${settlement.id}`}
          badgeTestIDPrefix={`badge-settlement-${settlement.id}`}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { marginTop: 16, paddingHorizontal: 16 },
  header: { fontSize: 18, fontWeight: "700", marginBottom: 8 },
  empty: { padding: 16 },
  emptyText: { color: "#666" },
  card: { backgroundColor: "#fff", borderRadius: 12, padding: 12, marginBottom: 12, borderWidth: 1, borderColor: "#eaeaea" },
  cardHeader: { marginBottom: 8 },
  cardTitle: { fontSize: 16, fontWeight: "600" },
  cardSubtitle: { fontSize: 12, color: "#666", marginTop: 2 },
  row: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: "#f3f3f3" },
  playerName: { flex: 1, fontSize: 14 },
  netCell: { fontSize: 14, fontWeight: "600", minWidth: 64, textAlign: "right" },
  win: { color: "#0a7d33" },
  lose: { color: "#c0392b" },
  muted: { color: "#888", fontStyle: "italic" },
  summary: { marginTop: 8, fontSize: 12, color: "#444" },
  settlements: { marginTop: 10, paddingTop: 10, borderTopWidth: 1, borderTopColor: "#eee" },
  sectionLabel: { fontSize: 13, fontWeight: "600", marginBottom: 4 },
  owes: { fontSize: 13, paddingVertical: 2, flex: 1 },
  settlementRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 4, gap: 8 },
  payBtn: { backgroundColor: '#0a7d33', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 6 },
  payBtnBusy: { backgroundColor: '#7aa88a' },
  payBtnText: { color: '#fff', fontSize: 12, fontWeight: '600' },
  paidBadge: { color: '#0a7d33', fontSize: 11, fontWeight: '700', letterSpacing: 0.5 },
  toggleBtn: { marginTop: 8 },
  toggleText: { fontSize: 12, color: "#0066cc" },
  noteRow: { fontSize: 12, color: "#555", paddingVertical: 1 },
  settleBtn: { marginTop: 12, backgroundColor: "#0a7d33", paddingVertical: 10, borderRadius: 8, alignItems: "center" },
  settleBtnBusy: { backgroundColor: "#7aa88a" },
  settleBtnText: { color: "#fff", fontWeight: "600" },

  live: { marginBottom: 10, padding: 10, borderRadius: 8, backgroundColor: "#f6f9f6", borderWidth: 1, borderColor: "#dfeadf" },
  liveTitle: { fontSize: 13, fontWeight: "700", color: "#0a4d23" },
  liveSubtitle: { fontSize: 12, color: "#446644", marginTop: 2 },
  btnRow: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 8 },
  actionBtn: { backgroundColor: "#0a7d33", paddingVertical: 8, paddingHorizontal: 10, borderRadius: 6 },
  actionBtnBusy: { opacity: 0.6 },
  actionBtnText: { color: "#fff", fontWeight: "600", fontSize: 12 },
  linkBtn: { marginTop: 6 },
  linkText: { color: "#0066cc", fontSize: 12, fontWeight: "600" },
  segRow: { flexDirection: "row", gap: 6, marginTop: 6 },
  segBtn: { paddingVertical: 4, paddingHorizontal: 8, borderRadius: 4, backgroundColor: "#fff", borderWidth: 1, borderColor: "#cfd8cf" },
  segBtnActive: { backgroundColor: "#0a7d33", borderColor: "#0a7d33" },
  segBtnText: { fontSize: 11, color: "#446644", fontWeight: "600" },
  segBtnTextActive: { color: "#fff" },
  pressRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 3 },
  pressText: { fontSize: 12, color: "#333" },

  modalBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)", justifyContent: "center", alignItems: "center", padding: 24 },
  modalCard: { backgroundColor: "#fff", borderRadius: 10, padding: 12, width: "100%", maxWidth: 320 },
  modalTitle: { fontSize: 14, fontWeight: "700", marginBottom: 8 },
  modalRow: { paddingVertical: 10, paddingHorizontal: 4 },
  modalRowText: { fontSize: 14 },
});
