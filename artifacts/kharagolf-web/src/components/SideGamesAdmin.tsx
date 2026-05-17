/**
 * SideGamesAdmin — admin UI to attach side games to a league round (or
 * tournament) and manage reusable templates.  Lists running instances with
 * live standings + a "Lock & Settle" action that persists who-owes-whom.
 */
import React, { useEffect, useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { holderNamesDifferSignificantly } from "@workspace/verified-holder-name";
import { useToast } from "@/hooks/use-toast";
import { PriceWithFx } from "@/components/PriceWithFx";
import { RefundDeliveryStatusRow, type RefundDeliveryInfo } from "@/components/RefundDeliveryStatusRow";

type GameType = "skins" | "snake" | "wolf" | "nassau";
const GAME_TYPES: GameType[] = ["skins", "snake", "wolf", "nassau"];

interface Template {
  id: number;
  name: string;
  gameType: GameType;
  rules: Record<string, unknown>;
  stake: string | null;
  currency: string | null;
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
  gameType: GameType;
  name: string | null;
  rules: Record<string, unknown> & {
    wolfOrder?: number[];
    allowPress?: boolean;
  };
  events: InstanceEvents | null;
  stake: string | null;
  currency: string | null;
  status: string;
}

interface Standings {
  perPlayer: Array<{ playerId: number; name: string; net: number }>;
  perHoleNotes: Array<{ hole: number; note: string }>;
  settlements: Array<{ fromPlayerId: number; fromName: string; toPlayerId: number; toName: string; amount: number }>;
  summary: string;
  gameType: string;
}

// Task #1841 — generic per-channel notify state shared by every retry
// pipeline (wallet withdrawal, side-game settlement receipt, wallet
// top-up refund). The `outcome` field on `WithdrawalNotifyInfo` is
// withdrawal-only — receipts/refunds don't have a terminal outcome
// concept, so they use the smaller `NotifyInfo` shape.
interface NotifyChannelLite {
  status: 'sent' | 'retrying' | 'failed_permanent' | null;
  attempts: number;
  lastAt: string | null;
  nextRetryAt: string | null;
  exhaustedAt: string | null;
}
interface NotifyInfo {
  email: NotifyChannelLite;
  push: NotifyChannelLite;
}

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
  // Task #1841 — per-channel email/push notify state for the receipt
  // delivery, used to render the same "next try in 2m 14s" / "gave up
  // X ago" badges that wallet withdrawals already get.
  notify?: NotifyInfo | null;
}

async function ensureRazorpayLoaded(): Promise<void> {
  if (window.Razorpay) return;
  await new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://checkout.razorpay.com/v1/checkout.js';
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Failed to load Razorpay'));
    document.head.appendChild(script);
  });
}

export default function SideGamesAdmin({
  orgId,
  leagueId,
  leagueRoundId,
  tournamentId,
  round,
  isAdmin = false,
}: {
  orgId: number;
  leagueId?: number;
  leagueRoundId?: number;
  tournamentId?: number;
  round?: number;
  // Task #1517 — gate the admin-only "Re-verify now" button on the wallet
  // panel. The wallet view itself is per-user (everyone sees their own
  // wallet), but the underlying reverify endpoint requires org-admin.
  isAdmin?: boolean;
}) {
  const { toast } = useToast();
  const [templates, setTemplates] = useState<Template[]>([]);
  const [instances, setInstances] = useState<Instance[]>([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newGameType, setNewGameType] = useState<GameType>("skins");
  const [newName, setNewName] = useState("");
  const [newStake, setNewStake] = useState("1");
  const [newCurrency, setNewCurrency] = useState("INR");

  // Template editor
  const [tplOpen, setTplOpen] = useState(false);
  const [tplName, setTplName] = useState("");
  const [tplType, setTplType] = useState<GameType>("skins");
  const [tplStake, setTplStake] = useState("1");

  const refreshInstances = useCallback(async () => {
    const params = new URLSearchParams();
    if (leagueRoundId) params.set("leagueRoundId", String(leagueRoundId));
    else if (tournamentId) {
      params.set("tournamentId", String(tournamentId));
      if (round) params.set("round", String(round));
    } else return;
    const r = await fetch(`/api/side-game-instances?${params}`, { credentials: "include" });
    if (r.ok) setInstances(await r.json());
  }, [leagueRoundId, tournamentId, round]);

  const refreshTemplates = useCallback(async () => {
    const params = new URLSearchParams({ organizationId: String(orgId) });
    if (leagueId) params.set("leagueId", String(leagueId));
    const r = await fetch(`/api/side-game-templates?${params}`, { credentials: "include" });
    if (r.ok) setTemplates(await r.json());
  }, [orgId, leagueId]);

  useEffect(() => {
    setLoading(true);
    Promise.all([refreshInstances(), refreshTemplates()]).finally(() => setLoading(false));
  }, [refreshInstances, refreshTemplates]);

  const createInstance = async (templateId?: number) => {
    setCreating(true);
    try {
      const tpl = templateId ? templates.find(t => t.id === templateId) : null;
      const body: Record<string, unknown> = {
        organizationId: orgId,
        gameType: tpl?.gameType ?? newGameType,
        name: tpl?.name ?? (newName || null),
        stake: tpl?.stake ?? newStake,
        currency: tpl?.currency ?? newCurrency,
        rules: tpl?.rules ?? {},
        templateId: templateId,
      };
      if (leagueRoundId) body.leagueRoundId = leagueRoundId;
      else if (tournamentId) { body.tournamentId = tournamentId; body.round = round ?? 1; }
      const r = await fetch("/api/side-game-instances", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(await r.text());
      toast({ title: "Side game created" });
      setNewName("");
      await refreshInstances();
    } catch (e) {
      toast({ title: "Failed to create", description: String(e), variant: "destructive" });
    } finally { setCreating(false); }
  };

  const saveTemplate = async () => {
    if (!tplName) return;
    try {
      const r = await fetch("/api/side-game-templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          organizationId: orgId,
          leagueId: leagueId ?? null,
          name: tplName,
          gameType: tplType,
          stake: tplStake,
          rules: {},
        }),
      });
      if (!r.ok) throw new Error(await r.text());
      toast({ title: "Template saved" });
      setTplName(""); setTplOpen(false);
      await refreshTemplates();
    } catch (e) {
      toast({ title: "Failed to save template", description: String(e), variant: "destructive" });
    }
  };

  const deleteInstance = async (id: number) => {
    if (!confirm("Delete this side game?")) return;
    const r = await fetch(`/api/side-game-instances/${id}`, { method: "DELETE", credentials: "include" });
    if (r.ok) { toast({ title: "Deleted" }); refreshInstances(); }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-base font-semibold text-white">Side Games</h3>
        <button
          className="text-xs px-3 py-1.5 rounded bg-white/10 hover:bg-white/20 text-white"
          onClick={() => setTplOpen(v => !v)}
        >{tplOpen ? "Cancel" : "+ New template"}</button>
      </div>

      <WalletPanel orgId={orgId} isAdmin={isAdmin} />

      {tplOpen && (
        <div className="glass-panel rounded-lg p-3 space-y-2">
          <input className="bg-black/30 text-white rounded px-2 py-1 w-full text-sm" placeholder="Template name"
            value={tplName} onChange={e => setTplName(e.target.value)} />
          <div className="flex gap-2">
            <select className="bg-black/30 text-white rounded px-2 py-1 text-sm" value={tplType}
              onChange={e => setTplType(e.target.value as GameType)}>
              {GAME_TYPES.map(g => <option key={g} value={g}>{g}</option>)}
            </select>
            <input className="bg-black/30 text-white rounded px-2 py-1 text-sm w-24" placeholder="Stake"
              value={tplStake} onChange={e => setTplStake(e.target.value)} />
            <button className="text-xs px-3 py-1 rounded bg-primary text-primary-foreground" onClick={saveTemplate}>
              Save
            </button>
          </div>
        </div>
      )}

      {templates.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">Templates (click to attach)</p>
          <div className="flex flex-wrap gap-2">
            {templates.map(t => (
              <button key={t.id}
                className="text-xs px-2 py-1 rounded bg-white/5 hover:bg-white/15 border border-white/10 text-white"
                onClick={() => createInstance(t.id)} disabled={creating}>
                {t.name} <span className="text-muted-foreground">· {t.gameType} · {t.stake ?? "1"}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="glass-panel rounded-lg p-3 space-y-2">
        <p className="text-xs text-muted-foreground">Attach new game</p>
        <div className="flex gap-2 flex-wrap">
          <select className="bg-black/30 text-white rounded px-2 py-1 text-sm" value={newGameType}
            onChange={e => setNewGameType(e.target.value as GameType)}>
            {GAME_TYPES.map(g => <option key={g} value={g}>{g}</option>)}
          </select>
          <input className="bg-black/30 text-white rounded px-2 py-1 text-sm flex-1 min-w-[160px]"
            placeholder="Name (optional)" value={newName} onChange={e => setNewName(e.target.value)} />
          <input className="bg-black/30 text-white rounded px-2 py-1 text-sm w-24" placeholder="Stake"
            value={newStake} onChange={e => setNewStake(e.target.value)} />
          <input className="bg-black/30 text-white rounded px-2 py-1 text-sm w-20" placeholder="INR"
            value={newCurrency} onChange={e => setNewCurrency(e.target.value)} />
          <button className="text-xs px-3 py-1.5 rounded bg-primary text-primary-foreground"
            onClick={() => createInstance()} disabled={creating}>
            {creating ? "…" : "Add"}
          </button>
        </div>
      </div>

      {loading ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : instances.length === 0 ? (
        <p className="text-xs text-muted-foreground py-4 text-center">No side games attached.</p>
      ) : (
        instances.map(inst => (
          <InstanceCard key={inst.id} instance={inst} onChanged={refreshInstances} onDelete={() => deleteInstance(inst.id)} />
        ))
      )}
    </div>
  );
}

function InstanceCard({ instance, onChanged, onDelete }: {
  instance: Instance;
  onChanged: () => void;
  onDelete: () => void;
}) {
  const { toast } = useToast();
  const [standings, setStandings] = useState<Standings | null>(null);
  const [currency, setCurrency] = useState("INR");
  const [busy, setBusy] = useState(false);
  const [persisted, setPersisted] = useState<PersistedSettlement[]>([]);
  const [payingId, setPayingId] = useState<number | null>(null);
  // Task #1841 — re-render every 5s while at least one paid settlement
  // has a live notify retry timer so the "next try in 2m 14s" / "gave
  // up X ago" suffix on the email/push badges stays accurate.
  const retryNowMs = useNotifyRetryTicker(hasLiveNotifyTimer(persisted));

  const refresh = useCallback(async () => {
    const r = await fetch(`/api/side-game-instances/${instance.id}/standings`, { credentials: "include" });
    if (r.ok) {
      const j = await r.json();
      setStandings(j.standings);
      setCurrency(j.currency ?? "INR");
    }
    if (instance.status === "completed") {
      const d = await fetch(`/api/side-game-instances/${instance.id}`, { credentials: "include" });
      if (d.ok) {
        const j = await d.json();
        setPersisted(j.settlements ?? []);
      }
    } else {
      setPersisted([]);
    }
  }, [instance.id, instance.status]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 30_000);
    return () => clearInterval(t);
  }, [refresh]);

  // Settle-up payment (Task #455). Opens Razorpay Checkout for the
  // selected pending settlement, then verifies the signature server-side
  // so the row is marked paid + the recipient's wallet is credited.
  async function payRazorpay(s: PersistedSettlement) {
    if (payingId) return;
    setPayingId(s.id);
    let modalOpened = false;
    try {
      const orderRes = await fetch(`/api/side-game-settlements/${s.id}/pay-order`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      const orderData = await orderRes.json().catch(() => ({}));
      if (!orderRes.ok) {
        toast({ title: orderData.error ?? 'Could not start payment', variant: 'destructive' });
        return;
      }
      try { await ensureRazorpayLoaded(); }
      catch { toast({ title: 'Could not load payment processor', variant: 'destructive' }); return; }
      const rzp = new window.Razorpay!({
        key: orderData.keyId,
        order_id: orderData.orderId,
        amount: orderData.amount,
        currency: orderData.currency,
        name: 'KHARAGOLF',
        description: `Settle up: ${s.fromName ?? '?'} → ${s.toName ?? '?'}`,
        handler: async (response: { razorpay_payment_id: string; razorpay_order_id: string; razorpay_signature: string }) => {
          try {
            const verifyRes = await fetch(`/api/side-game-settlements/${s.id}/pay-verify`, {
              method: 'POST', credentials: 'include',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                razorpayOrderId: response.razorpay_order_id,
                razorpayPaymentId: response.razorpay_payment_id,
                razorpaySignature: response.razorpay_signature,
              }),
            });
            const data = await verifyRes.json().catch(() => ({}));
            if (!verifyRes.ok) {
              toast({ title: data.error ?? 'Payment verification failed', variant: 'destructive' });
              return;
            }
            toast({ title: 'Settlement paid' });
            refresh();
          } catch {
            toast({ title: 'Payment verification failed', variant: 'destructive' });
          } finally {
            setPayingId(null);
          }
        },
        modal: { ondismiss: () => setPayingId(null) },
      });
      rzp.open();
      modalOpened = true;
    } catch {
      toast({ title: 'Could not start payment', variant: 'destructive' });
    } finally {
      if (!modalOpened) setPayingId(null);
    }
  }

  async function payWallet(s: PersistedSettlement) {
    if (payingId) return;
    setPayingId(s.id);
    try {
      const r = await fetch(`/api/side-game-settlements/${s.id}/pay-wallet`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        toast({
          title: data.error === 'INSUFFICIENT_FUNDS' ? 'Wallet balance too low' : (data.error ?? 'Wallet payment failed'),
          variant: 'destructive',
        });
        return;
      }
      toast({ title: 'Settled from wallet' });
      refresh();
    } finally {
      setPayingId(null);
    }
  }

  const settle = async () => {
    if (!confirm("Lock standings and create settlement records?")) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/side-game-instances/${instance.id}/settle`, {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" }, body: "{}",
      });
      if (!r.ok) throw new Error(await r.text());
      toast({ title: "Settled" });
      onChanged();
      refresh();
    } catch (e) {
      toast({ title: "Failed to settle", description: String(e), variant: "destructive" });
    } finally { setBusy(false); }
  };

  return (
    <div className="glass-panel rounded-lg p-3 space-y-2">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-semibold text-white">{instance.name ?? instance.gameType.toUpperCase()}</p>
          <p className="text-xs text-muted-foreground">{instance.gameType} · stake {instance.stake ?? "1"} {currency} · {instance.status}</p>
        </div>
        <div className="flex gap-2">
          {instance.status !== "completed" && (
            <button className="text-xs px-2 py-1 rounded bg-emerald-600/30 hover:bg-emerald-600/50 text-white" onClick={settle} disabled={busy}>
              {busy ? "…" : "Lock & Settle"}
            </button>
          )}
          <button className="text-xs px-2 py-1 rounded bg-red-600/20 hover:bg-red-600/40 text-white" onClick={onDelete}>
            Delete
          </button>
        </div>
      </div>

      {standings && (
        <>
          {standings.perPlayer.length > 0 && (
            <table className="w-full text-xs">
              <tbody>
                {[...standings.perPlayer].sort((a, b) => b.net - a.net).map(p => (
                  <tr key={p.playerId} className="border-b border-white/5">
                    <td className="py-1 text-white">{p.name}</td>
                    <td className={`py-1 text-right font-semibold ${p.net > 0 ? "text-emerald-400" : p.net < 0 ? "text-red-400" : "text-muted-foreground"}`}>
                      {p.net > 0 ? "+" : ""}{p.net.toFixed(2)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {standings.summary && <p className="text-xs text-muted-foreground italic">{standings.summary}</p>}
          {persisted.length > 0 ? (
            <div className="pt-2 border-t border-white/10 space-y-1">
              <p className="text-xs font-semibold text-white">Who owes whom</p>
              {persisted.map(s => (
                <div key={s.id} className="flex flex-col gap-1 py-1" data-testid={`settlement-row-${s.id}`}>
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs text-muted-foreground flex-1">
                    {s.fromName ?? '?'} → {s.toName ?? '?'}: {s.currency ?? currency} {Number(s.amount).toFixed(2)}
                  </p>
                  {s.status === 'paid' ? (
                    <span className="text-xs font-semibold text-emerald-400 uppercase tracking-wide">Paid · {s.paymentMethod}</span>
                  ) : s.status === 'pending' ? (
                    <div className="flex gap-1">
                      <button
                        className="text-xs px-2 py-1 rounded bg-white/10 hover:bg-white/20 text-white disabled:opacity-50"
                        onClick={() => payWallet(s)}
                        disabled={payingId === s.id}
                        title="Pay from club wallet balance"
                      >
                        {payingId === s.id ? '…' : 'Wallet'}
                      </button>
                      <button
                        className="text-xs px-2 py-1 rounded bg-emerald-600/40 hover:bg-emerald-600/60 text-white disabled:opacity-50"
                        onClick={() => payRazorpay(s)}
                        disabled={payingId === s.id}
                      >
                        {payingId === s.id ? 'Paying…' : 'Pay now'}
                      </button>
                    </div>
                  ) : null}
                </div>
                {/* Task #1841 — receipt notify badges (email + push) with the
                    shared "next try in 2m 14s" / "gave up X ago" countdown
                    that wallet withdrawals already render. Only meaningful
                    once the settlement has been paid (the notify pipeline
                    fires from `notifySettlementPaid`). */}
                {s.status === 'paid' && s.notify ? (
                  <NotifyChannelBadgesRow
                    notify={s.notify}
                    retryNowMs={retryNowMs}
                    rowTestId={`row-settlement-notify-${s.id}`}
                    badgeTestIdPrefix={`badge-settlement-${s.id}`}
                    attemptsTitleNoun="receipt"
                  />
                ) : null}
                </div>
              ))}
            </div>
          ) : standings.settlements.length > 0 ? (
            <div className="pt-2 border-t border-white/10 space-y-1">
              <p className="text-xs font-semibold text-white">Who owes whom (preview)</p>
              {standings.settlements.map((s, i) => (
                <p key={i} className="text-xs text-muted-foreground">
                  {s.fromName} → {s.toName}: {currency} {s.amount.toFixed(2)}
                </p>
              ))}
            </div>
          ) : null}

          {(instance.gameType === "wolf" || instance.gameType === "nassau") && (
            <EventsEditor
              instance={instance}
              standings={standings}
              onChanged={() => { onChanged(); refresh(); }}
            />
          )}
        </>
      )}
    </div>
  );
}

// ─── Wolf picks / Nassau presses editor ────────────────────────────────

function EventsEditor({ instance, standings, onChanged }: {
  instance: Instance;
  standings: Standings;
  onChanged: () => void;
}) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);

  const writeEvents = async (events: InstanceEvents) => {
    setBusy(true);
    try {
      const r = await fetch(`/api/side-game-instances/${instance.id}`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ events }),
      });
      if (!r.ok) throw new Error(await r.text());
      onChanged();
    } catch (e) {
      toast({ title: "Failed to update", description: String(e), variant: "destructive" });
    } finally { setBusy(false); }
  };

  if (instance.gameType === "wolf") {
    const picks: WolfPick[] = instance.events?.picks ?? [];
    const order = instance.rules.wolfOrder && instance.rules.wolfOrder.length > 0
      ? instance.rules.wolfOrder
      : standings.perPlayer.map(p => p.playerId);
    const nameOf = (id: number | null | undefined) =>
      standings.perPlayer.find(p => p.playerId === id)?.name ?? "—";

    const setPick = (hole: number, mode: WolfPick["mode"], partnerPlayerId?: number | null) => {
      const next = picks.filter(p => p.hole !== hole);
      next.push({ hole, mode, partnerPlayerId: mode === "partner" ? partnerPlayerId ?? null : undefined });
      void writeEvents({ ...(instance.events ?? {}), picks: next });
    };
    const clearPick = (hole: number) => {
      void writeEvents({ ...(instance.events ?? {}), picks: picks.filter(p => p.hole !== hole) });
    };

    const holesPlayed = new Set<number>(standings.perHoleNotes.map(n => n.hole));
    // Show holes 1..18 plus any with existing picks
    const holes = Array.from(new Set([
      ...Array.from({ length: 18 }, (_, i) => i + 1),
      ...picks.map(p => p.hole),
      ...holesPlayed,
    ])).sort((a, b) => a - b);

    return (
      <div className="pt-2 border-t border-white/10 space-y-2">
        <p className="text-xs font-semibold text-white">Wolf picks (override)</p>
        <div className="max-h-56 overflow-y-auto space-y-1">
          {holes.map(hole => {
            const wolfId = order.length > 0 ? order[(hole - 1) % order.length] : null;
            const wolfName = nameOf(wolfId);
            const pick = picks.find(p => p.hole === hole) ?? null;
            const teammates = standings.perPlayer.filter(p => p.playerId !== wolfId);
            return (
              <div key={hole} className="flex flex-wrap items-center gap-1 text-xs text-white">
                <span className="w-20 text-muted-foreground">H{hole} · {wolfName}</span>
                <select
                  className="bg-black/30 text-white rounded px-1.5 py-0.5"
                  value={pick?.mode ?? ""}
                  onChange={e => {
                    const v = e.target.value;
                    if (!v) { clearPick(hole); return; }
                    if (v === "partner") setPick(hole, "partner", pick?.partnerPlayerId ?? teammates[0]?.playerId ?? null);
                    else setPick(hole, v as WolfPick["mode"]);
                  }}
                  disabled={busy}
                >
                  <option value="">— auto —</option>
                  <option value="partner">Partner</option>
                  <option value="lone">Lone wolf</option>
                  <option value="blind">Blind wolf</option>
                </select>
                {pick?.mode === "partner" && (
                  <select
                    className="bg-black/30 text-white rounded px-1.5 py-0.5"
                    value={pick.partnerPlayerId ?? ""}
                    onChange={e => setPick(hole, "partner", e.target.value ? Number(e.target.value) : null)}
                    disabled={busy}
                  >
                    <option value="">— auto —</option>
                    {teammates.map(t => <option key={t.playerId} value={t.playerId}>{t.name}</option>)}
                  </select>
                )}
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  // Nassau
  const presses: NassauPress[] = instance.events?.presses ?? [];
  const allowPress = instance.rules.allowPress !== false;
  const [holeInput, setHoleInput] = useState<string>("1");
  const [team, setTeam] = useState<"A" | "B">("A");
  const [segment, setSegment] = useState<"front" | "back" | "total">("front");

  const addPress = () => {
    const h = Number(holeInput);
    if (!Number.isFinite(h) || h < 1) return;
    const next: NassauPress[] = [...presses, { hole: h, calledByTeam: team, segment }];
    void writeEvents({ ...(instance.events ?? {}), presses: next });
  };
  const removePress = (idx: number) => {
    const next = presses.filter((_, i) => i !== idx);
    void writeEvents({ ...(instance.events ?? {}), presses: next });
  };

  return (
    <div className="pt-2 border-t border-white/10 space-y-2">
      <p className="text-xs font-semibold text-white">Nassau presses (review/override)</p>
      {!allowPress && (
        <p className="text-xs text-amber-300">Presses disabled in rules — calls below will be ignored by the engine.</p>
      )}
      <div className="space-y-1">
        {presses.length === 0
          ? <p className="text-xs text-muted-foreground">No presses called.</p>
          : presses.map((p, i) => (
            <div key={i} className="flex items-center justify-between text-xs text-white">
              <span>Hole {p.hole} · Team {p.calledByTeam} · {p.segment}</span>
              <button className="text-xs text-red-400 hover:text-red-300" onClick={() => removePress(i)} disabled={busy}>
                Remove
              </button>
            </div>
          ))}
      </div>
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        <input
          type="number" min={1} max={18}
          className="bg-black/30 text-white rounded px-1.5 py-0.5 w-14"
          value={holeInput} onChange={e => setHoleInput(e.target.value)}
          placeholder="Hole"
        />
        <select className="bg-black/30 text-white rounded px-1.5 py-0.5"
          value={team} onChange={e => setTeam(e.target.value as "A" | "B")}>
          <option value="A">Team A</option>
          <option value="B">Team B</option>
        </select>
        <select className="bg-black/30 text-white rounded px-1.5 py-0.5"
          value={segment} onChange={e => setSegment(e.target.value as typeof segment)}>
          <option value="front">Front</option>
          <option value="back">Back</option>
          <option value="total">Total</option>
        </select>
        <button
          className="text-xs px-2 py-0.5 rounded bg-primary text-primary-foreground"
          onClick={addPress} disabled={busy}
        >Add press</button>
      </div>
    </div>
  );
}

// ─── Wallet panel (Task #613) ─────────────────────────────────────────
//
// Lets the org admin user view their own club wallet balance + recent
// ledger and top up via Razorpay. Wallet is per-user-per-org, so this
// screen always operates on the currently-signed-in admin's wallet for
// the active organization.

interface WalletTxn {
  id: number;
  kind: string;
  amount: number;
  currency: string;
  sourceType: string | null;
  paymentRef: string | null;
  note: string | null;
  balanceAfter: number;
  createdAt: string;
  // Task #1841 — only populated for `wallet_topup_refund` rows so the
  // refund-pending member sees the same notify retry countdown that
  // wallet withdrawals already render.
  notify?: NotifyInfo | null;
  // Task #1862 — full four-channel (email/push/sms/whatsapp) delivery
  // status from `/wallet`. Member view, so `lastError` is omitted.
  delivery?: RefundDeliveryInfo | null;
}

interface WalletResp {
  wallet: { id: number; balance: number; currency: string };
  transactions: WalletTxn[];
}

interface PayoutAccountInfo {
  id: number;
  method: 'upi' | 'bank_account';
  accountHolderName: string;
  upiVpa: string | null;
  bankAccountNumberLast4: string | null;
  bankIfsc: string | null;
  verified: boolean;
  verifiedAt?: string | null;
  verifiedHolderName?: string | null;
  verificationStatus?: string | null;
  verificationFailureReason?: string | null;
  // Task #1517 — surfaced by the API so the admin "Re-verify now" button
  // can disable itself when no Razorpay fund-account exists to validate.
  hasRazorpayFundAccount?: boolean;
}
interface PayoutAccountResp {
  account: PayoutAccountInfo | null;
  limits: { minPerTxn: number; maxPerTxn: number; maxPerDay: number; currency: string };
}

type NotifyDeliveryStatus = 'sent' | 'retrying' | 'failed_permanent';

interface WithdrawalNotifyChannel {
  status: NotifyDeliveryStatus | null;
  attempts: number;
  lastAt: string | null;
  // Task #1499 — when the cron will next try this channel (NULL once
  // retries are exhausted). Used to render "next try in 2m 14s" so the
  // member can tell whether to wait 30 seconds or half an hour.
  nextRetryAt: string | null;
  exhaustedAt: string | null;
}

interface WithdrawalNotifyInfo {
  outcome: 'processed' | 'failed' | 'reversed';
  email: WithdrawalNotifyChannel;
  push: WithdrawalNotifyChannel;
}

interface WithdrawalRow {
  id: number;
  amount: number;
  currency: string;
  method: string;
  status: string;
  payoutMode: string | null;
  razorpayPayoutId: string | null;
  failureReason: string | null;
  utr: string | null;
  debitTxnId: number | null;
  refundTxnId: number | null;
  requestedAt: string;
  processedAt?: string | null;
  failedAt?: string | null;
  // Task #1278 — per-channel delivery status from
  // wallet_withdrawal_notify_attempts. `null` until a terminal
  // (processed/failed/reversed) outcome has been notified.
  notify?: WithdrawalNotifyInfo | null;
}

function notifyChannelLabel(channel: 'email' | 'push', s: NotifyDeliveryStatus): string {
  const channelLabel = channel === 'email' ? 'Email' : 'Push';
  switch (s) {
    case 'sent': return `${channelLabel} sent`;
    case 'retrying': return `${channelLabel} retrying`;
    case 'failed_permanent': return `${channelLabel} undelivered`;
  }
}

// Task #1499 / #1841 — the "in 2m 14s" / "5m ago" formatter that powers
// every notify-retry badge suffix on web (wallet withdrawal, side-game
// settlement receipt, wallet top-up refund) lives in a shared module so
// the surfaces can never silently disagree. Re-exported here for the
// existing unit test which imports it from `../SideGamesAdmin`.
// Local binding for in-file usage (the inline `NotifyChannelBadgesRow`
// component below references `formatRetryRelative` directly), plus a
// re-export so existing test imports from `../SideGamesAdmin` keep
// working — pure `export { ... } from` does not create a local binding.
import { formatRetryRelative } from "@/lib/formatRetryRelative";
export { formatRetryRelative };

function notifyChannelClass(s: NotifyDeliveryStatus): string {
  switch (s) {
    case 'sent': return 'border-emerald-400/40 bg-emerald-500/15 text-emerald-200';
    case 'retrying': return 'border-amber-400/40 bg-amber-500/15 text-amber-200';
    case 'failed_permanent': return 'border-rose-400/50 bg-rose-500/15 text-rose-200';
  }
}

/**
 * Task #1841 — re-render every 5s while at least one visible row has a
 * live retry / exhausted timestamp, so the "next try in 2m 14s" /
 * "gave up 5m ago" suffix on the notify badges stays fresh between
 * react-query refetches. Used by InstanceCard (settlement receipt
 * badges) and WalletPanel (withdrawal + topup-refund badges).
 */
function useNotifyRetryTicker(hasLiveTimer: boolean): number {
  const [retryNowMs, setRetryNowMs] = useState<number>(() => Date.now());
  useEffect(() => {
    if (!hasLiveTimer) return;
    setRetryNowMs(Date.now());
    const id = setInterval(() => setRetryNowMs(Date.now()), 5000);
    return () => clearInterval(id);
  }, [hasLiveTimer]);
  return retryNowMs;
}

/**
 * Task #1841 — reusable row of email + push notify badges with the
 * shared "next try in 2m 14s" / "gave up X ago" suffix. Mirrors the
 * inline withdrawal-badge logic added in Task #1499 so all three
 * pipelines (withdrawal, settlement receipt, topup refund) read the
 * same on web.
 */
function NotifyChannelBadgesRow({
  notify,
  retryNowMs,
  rowTestId,
  badgeTestIdPrefix,
  attemptsTitleNoun,
}: {
  notify: NotifyInfo;
  retryNowMs: number;
  rowTestId: string;
  badgeTestIdPrefix: string;
  attemptsTitleNoun: string;
}) {
  const badges: React.ReactNode[] = [];
  const renderBadge = (channel: 'email' | 'push', ch: NotifyChannelLite) => {
    const s = ch.status;
    if (!s) return;
    const nextTry = s === 'retrying' ? formatRetryRelative(ch.nextRetryAt, retryNowMs) : null;
    const exhausted = s === 'failed_permanent' ? formatRetryRelative(ch.exhaustedAt, retryNowMs) : null;
    const baseLabel = notifyChannelLabel(channel, s);
    const suffix = s === 'retrying' && nextTry
      ? ` — next try ${nextTry}`
      : s === 'failed_permanent' && exhausted
        ? ` — gave up ${exhausted}`
        : '';
    const channelTitleLabel = channel === 'email' ? 'Email' : 'Push';
    const title = s === 'failed_permanent'
      ? `${channelTitleLabel} gave up after ${ch.attempts} attempts${exhausted ? ` (${exhausted})` : ''}. Check your ${attemptsTitleNoun}.`
      : s === 'retrying'
        ? `${channelTitleLabel} retrying (${ch.attempts} attempt${ch.attempts === 1 ? '' : 's'} so far)${nextTry ? `. Next try ${nextTry}.` : ''}`
        : `${channelTitleLabel} ${attemptsTitleNoun} delivered`;
    badges.push(
      <span
        key={channel}
        className={`inline-block px-1.5 py-0.5 rounded border text-[10px] ${notifyChannelClass(s)}`}
        data-testid={`${badgeTestIdPrefix}-${channel}`}
        data-status={s}
        data-next-retry-at={ch.nextRetryAt ?? undefined}
        data-exhausted-at={ch.exhaustedAt ?? undefined}
        title={title}
      >{baseLabel}{suffix}</span>,
    );
  };
  renderBadge('email', notify.email);
  renderBadge('push', notify.push);
  if (badges.length === 0) return null;
  return (
    <div className="mt-1 flex flex-wrap gap-1" data-testid={rowTestId}>{badges}</div>
  );
}

/**
 * Task #1841 — true when at least one of the supplied notify rows has a
 * live retry / exhausted timestamp the ticker should keep ticking for.
 */
function hasLiveNotifyTimer(rows: ReadonlyArray<{ notify?: NotifyInfo | null }>): boolean {
  return rows.some(r => {
    const n = r.notify;
    if (!n) return false;
    return (
      n.email.nextRetryAt != null || n.push.nextRetryAt != null ||
      n.email.exhaustedAt != null || n.push.exhaustedAt != null
    );
  });
}

/**
 * Tiny presentational sub-component for the "Verified as: <name>" line under
 * the wallet payout summary (Task #1120). Extracted from WalletPanel so the
 * matching/mismatch logic — and the amber warning copy — can be locked in by
 * unit tests independently of the larger wallet panel (Task #1293).
 *
 * The token + comparison helpers it relies on (`holderNamesDifferSignificantly`)
 * live in the shared `@workspace/verified-holder-name` package so the web and
 * mobile copies can never silently disagree (Task #1521).
 *
 * Renders nothing when `verifiedHolderName` is null/empty, mirroring the
 * inline `payout?.account?.verifiedHolderName && (…)` guard in WalletPanel.
 */
export function VerifiedHolderLine({
  accountHolderName,
  verifiedHolderName,
}: {
  accountHolderName: string;
  verifiedHolderName: string | null | undefined;
}) {
  if (!verifiedHolderName) return null;
  const mismatch = holderNamesDifferSignificantly(accountHolderName, verifiedHolderName);
  return (
    <div className={`text-[11px] ${mismatch ? 'text-amber-300' : 'text-muted-foreground'}`}>
      Verified as: <span className={mismatch ? 'text-amber-200' : 'text-white'}>{verifiedHolderName}</span>
      {mismatch && (
        <span className="ml-2">
          · doesn't match what you entered (“{accountHolderName}”). Re-save if this isn't your account.
        </span>
      )}
    </div>
  );
}

/**
 * Task #1511 — wallet "needs re-verification" banner. Extracted from
 * the inline JSX inside `WalletPanel` so the persisted-failure-reason
 * copy and Re-save CTA can be unit-tested without mocking the wallet,
 * payout-account, and withdrawals fetches that `WalletPanel` fans out
 * to on mount. Mirrors the `VerifiedHolderLine` extraction (Task #1293).
 *
 * Renders nothing unless `verificationStatus === 'needs_attention'`.
 * Hides the CTA when `accountFormOpen` is true so the form below isn't
 * duplicated.
 */
export function WalletPayoutNeedsReverifyBanner({
  method,
  verificationStatus,
  verificationFailureReason,
  accountFormOpen,
  onReSave,
}: {
  method: 'upi' | 'bank_account';
  verificationStatus: string | null | undefined;
  verificationFailureReason: string | null | undefined;
  accountFormOpen: boolean;
  onReSave: () => void;
}) {
  // Task #1872 — banner copy is now read from the `profile` i18n
  // namespace (`walletPayoutNeedsReverify.*`) so non-English members
  // see fully localised text instead of an English mix-in.
  const { t } = useTranslation('profile');
  if (verificationStatus !== 'needs_attention') return null;
  const title = method === 'upi'
    ? t('walletPayoutNeedsReverify.titleUpi')
    : t('walletPayoutNeedsReverify.titleBank');
  return (
    <div
      data-testid="banner-wallet-payout-needs-reverify"
      className="rounded-lg border border-amber-600 bg-amber-950/40 p-2 flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2"
      role="alert"
    >
      <div className="text-xs text-amber-100">
        <div className="font-semibold text-amber-200">{title}</div>
        <div className="text-amber-100/80 mt-1">
          {t('walletPayoutNeedsReverify.body')}
          {verificationFailureReason ? (
            <>
              {' '}
              <span className="text-amber-50">
                {t('walletPayoutNeedsReverify.reason', { reason: verificationFailureReason })}
              </span>
            </>
          ) : null}
        </div>
      </div>
      {!accountFormOpen && (
        <button
          type="button"
          data-testid="button-wallet-payout-needs-reverify-fix"
          className="text-xs px-3 py-1.5 rounded bg-amber-500 hover:bg-amber-400 text-black font-semibold whitespace-nowrap"
          onClick={onReSave}
        >{t('walletPayoutNeedsReverify.cta')}</button>
      )}
    </div>
  );
}

function withdrawalStatusLabel(s: string): { label: string; cls: string } {
  switch (s) {
    case 'pending': return { label: 'Pending', cls: 'bg-white/10 text-white' };
    case 'processing': return { label: 'Processing', cls: 'bg-amber-400/20 text-amber-200' };
    case 'processed': return { label: 'Paid', cls: 'bg-emerald-500/30 text-emerald-200' };
    case 'failed': return { label: 'Failed (refunded)', cls: 'bg-rose-500/30 text-rose-200' };
    case 'reversed': return { label: 'Reversed (refunded)', cls: 'bg-rose-500/30 text-rose-200' };
    case 'cancelled': return { label: 'Cancelled', cls: 'bg-white/10 text-white' };
    case 'dispatch_unknown': return { label: 'Reconciling', cls: 'bg-amber-500/30 text-amber-200' };
    case 'paid_after_refund': return { label: 'Paid (review)', cls: 'bg-rose-500/40 text-rose-100' };
    default: return { label: s, cls: 'bg-white/10 text-white' };
  }
}

// Task #1518 / Task #1886 — one row from
// GET /api/admin/wallet/payout-accounts/:id/history. Mirrors the
// per-coach `PayoutAccountHistoryEntry` on /coach-admin so the two
// admin surfaces stay shaped the same way and a future shared
// renderer can swap in without another type rewrite. Today the
// backend only writes `admin_reverify` rows for wallet accounts, but
// we model `changeKind` openly so 'created' / 'updated' rows can be
// surfaced later without another contract change.
interface WalletPayoutHistoryEntry {
  id: number;
  walletPayoutAccountId: number;
  changeKind: string;
  method: 'upi' | 'bank_account' | string;
  accountHolderName: string | null;
  upiVpaMasked: string | null;
  bankAccountLast4: string | null;
  bankIfsc: string | null;
  changedByUserId: number | null;
  changedByRole: string | null;
  changedByName: string | null;
  verificationOutcome: 'verified' | 'needs_attention' | 'skipped' | string | null;
  verificationReason: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string;
}

// Task #1886 — friendly label for the wallet history row's outcome
// chip. Keeps the inline list and (future) CSV export in sync. Falls
// back to the raw value so unknown outcomes from a newer API still
// render something readable instead of an empty pill.
function walletHistoryOutcomeLabel(o: string | null): string {
  switch (o) {
    case 'verified': return 'Verified';
    case 'needs_attention': return 'Needs attention';
    case 'skipped': return 'Skipped';
    case null:
    case undefined:
      return 'Unknown';
    default: return o;
  }
}

// Match the inline reverify-button colour palette so an admin scanning
// the page sees the same visual language for the same outcome.
function walletHistoryOutcomeClass(o: string | null): string {
  switch (o) {
    case 'verified': return 'border-emerald-400/40 bg-emerald-500/15 text-emerald-200';
    case 'skipped': return 'border-sky-400/40 bg-sky-500/15 text-sky-200';
    case 'needs_attention': return 'border-amber-400/40 bg-amber-500/15 text-amber-200';
    default: return 'border-white/15 bg-white/5 text-white';
  }
}

/**
 * Task #1886 — admin-only "Re-verification history" section under the
 * saved wallet payout account. Calls
 *   GET /api/admin/wallet/payout-accounts/:id/history
 * (added in Task #1518) and renders the rows newest-first with the
 * masked account snapshot, outcome, reason, admin name, and
 * timestamp. Mirrors the per-coach payout-account history dialog on
 * /coach-admin (`PayoutAccountHistoryDialog`) so the two admin
 * surfaces feel the same.
 *
 * The endpoint requires org-admin, so this component is only mounted
 * when WalletPanel's `isAdmin` is true. `refreshKey` bumps after a
 * successful inline "Re-verify now" click so the new row shows up
 * without a page reload.
 */
function WalletPayoutReverifyHistory({
  accountId,
  refreshKey,
}: {
  accountId: number;
  refreshKey: number;
}) {
  const [items, setItems] = useState<WalletPayoutHistoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setItems(null);
    setError(null);
    fetch(`/api/admin/wallet/payout-accounts/${accountId}/history`, {
      credentials: 'include',
    })
      .then(r => r.json().then(d => ({ ok: r.ok, d })))
      .then(({ ok, d }) => {
        if (cancelled) return;
        if (!ok) {
          setError((d as { error?: string })?.error ?? 'Failed to load history');
          return;
        }
        setItems(((d as { history?: WalletPayoutHistoryEntry[] }).history) ?? []);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => { cancelled = true; };
  }, [accountId, refreshKey]);

  return (
    <div
      className="pt-2 border-t border-white/10 space-y-1"
      data-testid="wallet-payout-reverify-history"
    >
      <p className="text-xs text-muted-foreground">Re-verification history</p>
      {error && (
        <div
          className="text-[11px] text-rose-300"
          data-testid="text-wallet-payout-history-error"
        >{error}</div>
      )}
      {!error && items === null && (
        <div
          className="text-[11px] text-muted-foreground"
          data-testid="text-wallet-payout-history-loading"
        >Loading…</div>
      )}
      {!error && items && items.length === 0 && (
        <div
          className="text-[11px] text-muted-foreground"
          data-testid="text-wallet-payout-history-empty"
        >No re-verification events recorded for this account yet.</div>
      )}
      {!error && items && items.length > 0 && (
        <ul className="space-y-1.5">
          {items.map(h => (
            <li
              key={h.id}
              className="rounded border border-white/10 bg-black/20 p-2 text-[11px]"
              data-testid={`wallet-payout-history-row-${h.id}`}
            >
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <span
                  className={`inline-block px-1.5 py-0.5 rounded border text-[10px] ${walletHistoryOutcomeClass(h.verificationOutcome)}`}
                  data-testid={`wallet-payout-history-outcome-${h.id}`}
                  data-outcome={h.verificationOutcome ?? ''}
                >
                  {walletHistoryOutcomeLabel(h.verificationOutcome)}
                </span>
                <span className="text-muted-foreground">
                  {new Date(h.createdAt).toLocaleString()}
                </span>
              </div>
              <div className="text-white/80 mt-1">
                {h.method === 'upi'
                  ? <span>UPI {h.upiVpaMasked ?? '—'}</span>
                  : h.method === 'bank_account'
                    ? (
                      <span>
                        Bank •••• {h.bankAccountLast4 ?? '—'}
                        {h.bankIfsc ? <span className="ml-2">IFSC {h.bankIfsc}</span> : null}
                      </span>
                    )
                    : <span>{h.method}</span>}
                {h.accountHolderName
                  ? <span className="text-muted-foreground"> · {h.accountHolderName}</span>
                  : null}
              </div>
              {h.verificationReason ? (
                <div
                  className="text-muted-foreground mt-1"
                  data-testid={`wallet-payout-history-reason-${h.id}`}
                >Reason: {h.verificationReason}</div>
              ) : null}
              <div className="text-muted-foreground mt-1">
                By {h.changedByName ?? 'unknown'}
                {h.changedByRole ? ` (${h.changedByRole})` : ''}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function WalletPanel({ orgId, isAdmin = false }: { orgId: number; isAdmin?: boolean }) {
  const { toast } = useToast();
  const [data, setData] = useState<WalletResp | null>(null);
  const [loading, setLoading] = useState(false);
  const [topupOpen, setTopupOpen] = useState(false);
  const [amount, setAmount] = useState('1000');
  const [busy, setBusy] = useState(false);
  // Withdrawal state (Task #770)
  const [payout, setPayout] = useState<PayoutAccountResp | null>(null);
  const [withdrawals, setWithdrawals] = useState<WithdrawalRow[]>([]);
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [accountFormOpen, setAccountFormOpen] = useState(false);
  const [withdrawAmount, setWithdrawAmount] = useState('');
  const [withdrawBusy, setWithdrawBusy] = useState(false);
  const [acctMethod, setAcctMethod] = useState<'upi' | 'bank_account'>('upi');
  const [acctName, setAcctName] = useState('');
  const [acctUpi, setAcctUpi] = useState('');
  const [acctBank, setAcctBank] = useState('');
  const [acctIfsc, setAcctIfsc] = useState('');
  const [acctBusy, setAcctBusy] = useState(false);
  // Task #1517 — admin-triggered re-verification of the saved payout
  // account. Mirrors the coach-side button on /coach-admin (which calls
  // POST /coach-marketplace/admin/coaches/:proId/payout-account/reverify).
  const [reverifyBusy, setReverifyBusy] = useState(false);
  // Persistent inline outcome shown next to the button after a click,
  // so the admin still sees verified / needs_attention (with reason) /
  // skipped after the toast disappears. Cleared automatically when the
  // admin re-saves or changes the underlying account.
  const [reverifyOutcome, setReverifyOutcome] = useState<{
    outcome: 'verified' | 'needs_attention' | 'skipped' | 'error';
    reason: string | null;
  } | null>(null);
  // Task #1886 — bumped after a successful inline "Re-verify now" click
  // (and after the admin re-saves the account, since the new row from
  // the backend audit trail belongs to a freshly-created account) so
  // the WalletPayoutReverifyHistory child refetches without us having
  // to lift its data into the parent. Starts at 0 because the child's
  // own mount-time fetch already covers the first load.
  const [reverifyHistoryRefreshKey, setReverifyHistoryRefreshKey] = useState(0);
  const [highlightTxnId, setHighlightTxnId] = useState<number | null>(null);
  const [extraTxnIds, setExtraTxnIds] = useState<number[]>([]);
  // Task #1499 — re-render every 5s so the "next try in 2m 14s"
  // countdown on retrying notify badges stays fresh between fetches.
  // The interval is gated on whether at least one badge actually has a
  // future retry timestamp, so a wallet with only happy "Email sent"
  // badges never spins this up.
  // Task #1841 — also tick for wallet top-up refund txns whose notify
  // attempt has a live retry/exhausted timestamp, so the new badges on
  // those rows stay fresh without each row spinning up its own timer.
  const refundTxns = (data?.transactions ?? []).filter(t => t.sourceType === 'wallet_topup_refund');
  const retryNowMs = useNotifyRetryTicker(
    hasLiveNotifyTimer(withdrawals) || hasLiveNotifyTimer(refundTxns),
  );

  const scrollToTxn = useCallback((id: number) => {
    setHighlightTxnId(id);
    requestAnimationFrame(() => {
      const el = document.getElementById(`wallet-txn-${id}`);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    setTimeout(() => setHighlightTxnId(prev => (prev === id ? null : prev)), 2400);
  }, []);

  const focusTxn = useCallback((id: number) => {
    const loaded = data?.transactions ?? [];
    // Always pin the deep-linked txn so the row stays mounted for the
    // lifetime of the panel (until navigation away). The highlight is
    // separately auto-cleared by the timers below — only the row's
    // visibility is sticky. See Task #1491.
    setExtraTxnIds(prev => (prev.includes(id) ? prev : [...prev, id]));
    if (loaded.some(t => t.id === id)) {
      scrollToTxn(id);
    } else {
      setHighlightTxnId(id);
      // Match the loaded path's auto-clear so the highlight doesn't linger if
      // the refetch fails or the row never appears.
      setTimeout(() => setHighlightTxnId(prev => (prev === id ? null : prev)), 4000);
    }
  }, [data, scrollToTxn]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const walletQs = new URLSearchParams({ organizationId: String(orgId), currency: 'INR' });
      if (extraTxnIds.length > 0) walletQs.set('includeTxnIds', extraTxnIds.join(','));
      const [w, p, h] = await Promise.all([
        fetch(`/api/wallet?${walletQs.toString()}`, { credentials: 'include' }),
        fetch(`/api/wallet/payout-account?organizationId=${orgId}`, { credentials: 'include' }),
        fetch(`/api/wallet/withdrawals?organizationId=${orgId}`, { credentials: 'include' }),
      ]);
      if (w.ok) setData(await w.json());
      if (p.ok) {
        const pd = await p.json() as PayoutAccountResp;
        setPayout(pd);
        if (pd.account) {
          setAcctMethod(pd.account.method);
          setAcctName(pd.account.accountHolderName);
          setAcctUpi(pd.account.upiVpa ?? '');
          setAcctIfsc(pd.account.bankIfsc ?? '');
        }
      }
      if (h.ok) {
        const hd = await h.json() as { withdrawals: WithdrawalRow[] };
        setWithdrawals(hd.withdrawals ?? []);
      }
    } finally { setLoading(false); }
  }, [orgId, extraTxnIds]);

  useEffect(() => { void refresh(); }, [refresh]);

  // After a refetch that pulled in a previously-unloaded txn, scroll to it.
  useEffect(() => {
    if (highlightTxnId == null) return;
    const loaded = data?.transactions ?? [];
    if (!loaded.some(t => t.id === highlightTxnId)) return;
    requestAnimationFrame(() => {
      const el = document.getElementById(`wallet-txn-${highlightTxnId}`);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  }, [data, highlightTxnId]);

  const submitWithdraw = async () => {
    const amt = Number(withdrawAmount);
    if (!Number.isFinite(amt) || amt <= 0) { toast({ title: 'Enter a valid amount', variant: 'destructive' }); return; }
    if (amt > balance) { toast({ title: 'Insufficient balance', variant: 'destructive' }); return; }
    if (payout && amt < payout.limits.minPerTxn) { toast({ title: `Minimum is ${ccy} ${payout.limits.minPerTxn}`, variant: 'destructive' }); return; }
    if (payout && amt > payout.limits.maxPerTxn) { toast({ title: `Maximum per withdrawal is ${ccy} ${payout.limits.maxPerTxn}`, variant: 'destructive' }); return; }
    setWithdrawBusy(true);
    try {
      const r = await fetch('/api/wallet/withdraw', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ organizationId: orgId, amount: amt, currency: 'INR' }),
      });
      const d = await r.json().catch(() => ({})) as {
        error?: string;
        code?: string;
        verificationFailureReason?: string | null;
        withdrawal?: { status?: string };
        balance?: number;
      };
      if (!r.ok) {
        // Task #1511 — when the daily re-verification cron has flagged
        // the saved account, the API returns 400 with code
        // PAYOUT_ACCOUNT_NEEDS_REVERIFY. Refresh the payout-account
        // query so the inline `needs_attention` banner (with the
        // failure reason and Re-save CTA) renders, close the withdraw
        // sheet, and skip the generic "Withdrawal failed" toast — the
        // banner is the friendlier surface.
        if (d.code === 'PAYOUT_ACCOUNT_NEEDS_REVERIFY') {
          setWithdrawOpen(false);
          setWithdrawAmount('');
          void refresh();
          return;
        }
        toast({ title: d.error ?? 'Withdrawal failed', variant: 'destructive' });
        return;
      }
      toast({ title: 'Withdrawal initiated', description: `Status: ${d.withdrawal?.status ?? 'processing'}. Balance: ${ccy} ${Number(d.balance).toFixed(2)}` });
      setWithdrawOpen(false);
      setWithdrawAmount('');
      void refresh();
    } finally { setWithdrawBusy(false); }
  };

  const reverifyPayoutAccount = async () => {
    const accountId = payout?.account?.id;
    if (!accountId) return;
    setReverifyBusy(true);
    try {
      const r = await fetch(`/api/admin/wallet/payout-accounts/${accountId}/reverify`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        const reason: string | null = d?.error ?? `Failed (${r.status})`;
        setReverifyOutcome({ outcome: 'error', reason });
        toast({ title: 'Re-verify failed', description: reason, variant: 'destructive' });
        return;
      }
      const outcome: string = d.outcome ?? 'unknown';
      const reason: string | null = d.reason ?? null;
      if (outcome === 'verified') {
        setReverifyOutcome({ outcome: 'verified', reason: null });
        toast({ title: 'Payout account re-verified', description: 'The saved account is active.' });
      } else if (outcome === 'needs_attention') {
        setReverifyOutcome({ outcome: 'needs_attention', reason });
        toast({
          title: 'Re-verification failed',
          description: reason ?? 'Account needs attention. The member has been notified.',
          variant: 'destructive',
        });
      } else if (outcome === 'skipped') {
        setReverifyOutcome({ outcome: 'skipped', reason });
        toast({ title: 'Re-verification pending', description: reason ?? 'Validation is still in flight; try again shortly.' });
      } else {
        setReverifyOutcome({ outcome: 'error', reason: reason ?? outcome });
        toast({ title: 'Re-verification error', description: reason ?? outcome, variant: 'destructive' });
      }
      // Task #1886 — every backend reverify (verified / needs_attention
      // / skipped) writes a new wallet_payout_account_history row, so
      // refetch the inline history list to surface it without a page
      // reload. Bumped on the error path too because needs_attention /
      // skipped are written even when the outcome isn't a clean pass.
      setReverifyHistoryRefreshKey(k => k + 1);
      void refresh();
    } catch (e: unknown) {
      const reason = e instanceof Error ? e.message : String(e);
      setReverifyOutcome({ outcome: 'error', reason });
      toast({ title: 'Re-verify failed', description: reason, variant: 'destructive' });
    } finally {
      setReverifyBusy(false);
    }
  };

  const submitPayoutAccount = async () => {
    if (!acctName.trim()) { toast({ title: 'Account holder name is required', variant: 'destructive' }); return; }
    let body: Record<string, unknown> = { organizationId: orgId, method: acctMethod, accountHolderName: acctName.trim() };
    if (acctMethod === 'upi') {
      if (!/^[\w.\-]{2,}@[\w.\-]{2,}$/.test(acctUpi.trim())) { toast({ title: 'Enter a valid UPI ID (e.g. name@bank)', variant: 'destructive' }); return; }
      body = { ...body, upiVpa: acctUpi.trim() };
    } else {
      if (!/^\d{6,20}$/.test(acctBank.replace(/\s+/g, ''))) { toast({ title: 'Enter a valid account number', variant: 'destructive' }); return; }
      if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(acctIfsc.trim().toUpperCase())) { toast({ title: 'Enter a valid IFSC', variant: 'destructive' }); return; }
      body = { ...body, bankAccountNumber: acctBank.replace(/\s+/g, ''), bankIfsc: acctIfsc.trim().toUpperCase() };
    }
    setAcctBusy(true);
    try {
      const r = await fetch('/api/wallet/payout-account', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { toast({ title: d.error ?? 'Could not save payout account', variant: 'destructive' }); return; }
      toast({ title: 'Payout account saved' });
      setAccountFormOpen(false);
      setAcctBank('');
      // The saved account is brand-new; any prior reverify outcome
      // refers to a different (now-replaced) row, so drop it.
      setReverifyOutcome(null);
      // Task #1886 — re-saving usually creates a brand-new
      // wallet_payout_accounts row, so the history list (which is
      // keyed off `payout?.account?.id`) needs to refetch under the
      // new id once `refresh()` updates the saved-account view. Bump
      // the key so the child remounts/refetches even if the id ends
      // up being the same.
      setReverifyHistoryRefreshKey(k => k + 1);
      void refresh();
    } finally { setAcctBusy(false); }
  };

  const startTopup = async () => {
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) {
      toast({ title: 'Enter a valid amount', variant: 'destructive' });
      return;
    }
    setBusy(true);
    let modalOpened = false;
    try {
      const orderRes = await fetch('/api/wallet/topup-order', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ organizationId: orgId, amount: amt, currency: 'INR' }),
      });
      const orderData = await orderRes.json().catch(() => ({}));
      if (!orderRes.ok) {
        toast({ title: orderData.error ?? 'Could not start top-up', variant: 'destructive' });
        return;
      }
      try { await ensureRazorpayLoaded(); }
      catch { toast({ title: 'Could not load payment processor', variant: 'destructive' }); return; }
      const rzp = new window.Razorpay!({
        key: orderData.keyId,
        order_id: orderData.orderId,
        amount: orderData.amount,
        currency: orderData.currency,
        name: 'KHARAGOLF',
        description: 'Club wallet top-up',
        handler: async (response: { razorpay_payment_id: string; razorpay_order_id: string; razorpay_signature: string }) => {
          try {
            const verifyRes = await fetch('/api/wallet/topup-verify', {
              method: 'POST', credentials: 'include',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                razorpayOrderId: response.razorpay_order_id,
                razorpayPaymentId: response.razorpay_payment_id,
                razorpaySignature: response.razorpay_signature,
              }),
            });
            const data = await verifyRes.json().catch(() => ({}));
            if (!verifyRes.ok) {
              toast({ title: data.error ?? 'Top-up verification failed', variant: 'destructive' });
              return;
            }
            toast({ title: 'Wallet topped up', description: `Balance: INR ${Number(data.balance).toFixed(2)}` });
            setTopupOpen(false);
            void refresh();
          } catch {
            toast({ title: 'Top-up verification failed', variant: 'destructive' });
          } finally {
            setBusy(false);
          }
        },
        modal: { ondismiss: () => setBusy(false) },
      });
      rzp.open();
      modalOpened = true;
    } catch {
      toast({ title: 'Could not start top-up', variant: 'destructive' });
    } finally {
      // Only the Razorpay modal's own callbacks (handler / ondismiss) own
      // resetting busy once the checkout window is open. For every early
      // exit (validation failure, order error, script load failure, thrown
      // exception) we must clear busy here to avoid a sticky disabled state.
      if (!modalOpened) setBusy(false);
    }
  };

  const balance = data?.wallet.balance ?? 0;
  const ccy = data?.wallet.currency ?? 'INR';
  const txns = data?.transactions ?? [];

  return (
    <div className="glass-panel rounded-lg p-3 space-y-2">
      <div className="flex items-center justify-between" data-testid="wallet-balance-row">
        <div>
          <p className="text-xs text-muted-foreground uppercase tracking-wide">My club wallet</p>
          {loading && !data ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : (
            <p className="text-lg font-semibold text-white" data-testid="wallet-balance">{ccy} {balance.toFixed(2)}</p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            className="text-xs px-3 py-1.5 rounded bg-primary text-primary-foreground disabled:opacity-50"
            onClick={() => setTopupOpen(v => !v)}
            disabled={busy}
            data-testid="wallet-topup-toggle"
          >{topupOpen ? 'Cancel' : '+ Add money'}</button>
          <button
            className="text-xs px-3 py-1.5 rounded border border-amber-400/60 text-amber-300 hover:bg-amber-400/10 disabled:opacity-50"
            onClick={() => setWithdrawOpen(v => !v)}
            disabled={
              withdrawBusy
              || balance <= 0
              || !payout?.account?.verified
              // Task #1511 — the daily re-verification cron leaves
              // `verifiedAt` populated when it flags an account as
              // needs_attention so the saved-account banner can keep
              // showing the prior verification timestamp. Without this
              // extra guard the Withdraw button would still appear
              // enabled and clicking it would only surface the API's
              // `PAYOUT_ACCOUNT_NEEDS_REVERIFY` error.
              || payout?.account?.verificationStatus === 'needs_attention'
            }
            title={
              balance <= 0
                ? 'No balance to withdraw'
                : !payout?.account
                  ? 'Add a UPI / bank account first'
                  : !payout.account.verified
                    ? 'Verify your payout account first'
                    : payout.account.verificationStatus === 'needs_attention'
                      ? 'Re-save your UPI / bank to resume withdrawals'
                      : 'Withdraw to UPI / bank'
            }
            data-testid="wallet-withdraw-toggle"
          >{withdrawOpen ? 'Cancel' : '↑ Withdraw'}</button>
        </div>
      </div>

      <div className="text-[11px] text-muted-foreground flex items-center gap-2 flex-wrap">
        <span>Payout to:</span>
        {payout?.account ? (
          <>
            <span className="text-white">
              {payout.account.method === 'upi'
                ? `UPI · ${payout.account.upiVpa}`
                : `Bank · ${payout.account.accountHolderName} · •••• ${payout.account.bankAccountNumberLast4} · ${payout.account.bankIfsc}`}
            </span>
            <button
              className="underline hover:text-white"
              onClick={() => setAccountFormOpen(v => !v)}
            >{accountFormOpen ? 'Close' : 'Change'}</button>
            {/* Task #1517 — admin-only inline button to re-run the same
                Razorpay VPA / fund-account validation the nightly cron
                uses, so support can unstick a member who phones in. The
                outcome of the most recent click stays pinned next to
                the button so the admin can still see it after the toast
                disappears. */}
            {isAdmin && (() => {
              const hasFundAccount = payout.account.hasRazorpayFundAccount !== false;
              const reverifyDisabled = reverifyBusy || !hasFundAccount;
              const reverifyTitle = !hasFundAccount
                ? 'No Razorpay fund-account on file to re-verify'
                : 'Re-verify the saved payout account with the bank';
              // Task #1885 — surface the saved account's *current*
              // verification status inline (mirrors the coach-admin
              // badge pattern) so support can diagnose without first
              // clicking Re-verify or opening the Razorpay dashboard.
              // The persisted status comes from the daily re-verify
              // cron (Task #1119) and any prior admin-triggered
              // reverify (Task #1517); `void refresh()` after a click
              // updates `payout.account.verificationStatus` so this
              // badge tracks the latest result without a panel reload.
              const rawStatus = payout.account.verificationStatus ?? null;
              const statusLabel: 'verified' | 'needs_attention' | 'pending' =
                rawStatus === 'verified' ? 'verified' :
                rawStatus === 'needs_attention' ? 'needs_attention' :
                'pending';
              const statusColour =
                statusLabel === 'verified'        ? 'bg-emerald-500/15 text-emerald-300' :
                statusLabel === 'needs_attention' ? 'bg-amber-500/15 text-amber-300'     :
                                                    'bg-sky-500/15 text-sky-300';
              const statusText =
                statusLabel === 'verified'        ? 'Verified' :
                statusLabel === 'needs_attention' ? 'Needs attention' :
                                                    'Pending';
              const failureReason = payout.account.verificationFailureReason ?? null;
              return (
                <>
                  <span
                    className={`px-1.5 py-0.5 rounded ${statusColour}`}
                    title={statusLabel === 'needs_attention' && failureReason ? failureReason : undefined}
                    data-testid="badge-wallet-payout-verification-status"
                    data-status={statusLabel}
                  >{statusText}</span>
                  <button
                    className="underline text-amber-300 hover:text-amber-200 disabled:opacity-50 disabled:no-underline disabled:cursor-not-allowed"
                    onClick={reverifyPayoutAccount}
                    disabled={reverifyDisabled}
                    title={reverifyTitle}
                    data-testid="button-reverify-wallet-payout"
                  >{reverifyBusy ? 'Re-verifying…' : 'Re-verify now'}</button>
                  {statusLabel === 'needs_attention' && failureReason && (
                    <span
                      className="text-amber-300 max-w-[20rem] truncate"
                      title={failureReason}
                      data-testid="text-wallet-payout-verification-reason"
                    >{failureReason}</span>
                  )}
                  {reverifyOutcome && (() => {
                    const o = reverifyOutcome.outcome;
                    const colour =
                      o === 'verified' ? 'text-emerald-300' :
                      o === 'skipped'  ? 'text-sky-300'     :
                                          'text-amber-200'; // needs_attention / error
                    const label =
                      o === 'verified'        ? 'Verified' :
                      o === 'needs_attention' ? 'Needs attention' :
                      o === 'skipped'         ? 'Pending' :
                                                 'Error';
                    return (
                      <span
                        className={colour}
                        data-testid="text-reverify-outcome"
                        data-outcome={o}
                      >
                        · {label}
                        {reverifyOutcome.reason ? `: ${reverifyOutcome.reason}` : ''}
                      </span>
                    );
                  })()}
                </>
              );
            })()}
          </>
        ) : (
          <button
            className="underline text-amber-300 hover:text-amber-200"
            onClick={() => setAccountFormOpen(v => !v)}
          >{accountFormOpen ? 'Close' : 'Add UPI or bank account to enable withdrawals'}</button>
        )}
      </div>

      {payout?.account && (
        <VerifiedHolderLine
          accountHolderName={payout.account.accountHolderName}
          verifiedHolderName={payout.account.verifiedHolderName}
        />
      )}

      {/* Task #1511 — surface the persisted re-verification failure
          reason from the daily cron (Task #1119) so members see the
          same friendly banner here that's already shown on coach
          payouts. Without this banner the wallet UI would only show a
          generic toast on Withdraw and members had no way to learn
          *why* payouts were paused. The Re-save CTA jumps straight
          into the saved-account form. */}
      {payout?.account ? (
        <WalletPayoutNeedsReverifyBanner
          method={payout.account.method}
          verificationStatus={payout.account.verificationStatus}
          verificationFailureReason={payout.account.verificationFailureReason}
          accountFormOpen={accountFormOpen}
          onReSave={() => { setWithdrawOpen(false); setAccountFormOpen(true); }}
        />
      ) : null}

      {/* Task #1886 — admin-only audit feed of every re-verify event
          for the saved wallet payout account. Sourced from
          GET /api/admin/wallet/payout-accounts/:id/history (Task
          #1518). Mirrors the per-coach payout-account history dialog
          on /coach-admin so the two admin surfaces stay consistent.
          Hidden when there's no saved account (nothing to verify
          yet) and for non-admin viewers (member view of their own
          wallet doesn't expose the audit trail). */}
      {isAdmin && payout?.account ? (
        <WalletPayoutReverifyHistory
          accountId={payout.account.id}
          refreshKey={reverifyHistoryRefreshKey}
        />
      ) : null}

      {accountFormOpen && (
        <div className="rounded border border-white/10 bg-black/20 p-2 space-y-2" data-testid="wallet-payout-account-form">
          <div className="flex gap-1">
            {(['upi', 'bank_account'] as const).map(m => (
              <button
                key={m}
                className={`text-xs px-2 py-1 rounded ${acctMethod === m ? 'bg-white/20 text-white' : 'bg-white/5 text-muted-foreground hover:bg-white/10'}`}
                onClick={() => setAcctMethod(m)}
                disabled={acctBusy}
                data-testid={`wallet-payout-account-method-tab-${m}`}
              >{m === 'upi' ? 'UPI' : 'Bank account'}</button>
            ))}
          </div>
          <input
            className="w-full bg-black/30 text-white rounded px-2 py-1 text-xs"
            placeholder="Account holder name (as per bank)"
            value={acctName} onChange={e => setAcctName(e.target.value)} disabled={acctBusy}
            data-testid="wallet-payout-account-name"
          />
          {acctMethod === 'upi' ? (
            <input
              className="w-full bg-black/30 text-white rounded px-2 py-1 text-xs"
              placeholder="UPI ID (e.g. name@bank)"
              value={acctUpi} onChange={e => setAcctUpi(e.target.value)} disabled={acctBusy}
              data-testid="wallet-payout-account-upi"
            />
          ) : (
            <div className="flex gap-2">
              <input
                className="flex-1 bg-black/30 text-white rounded px-2 py-1 text-xs"
                placeholder="Account number"
                value={acctBank} onChange={e => setAcctBank(e.target.value)} disabled={acctBusy}
                data-testid="wallet-payout-account-bank-number"
              />
              <input
                className="w-32 bg-black/30 text-white rounded px-2 py-1 text-xs uppercase"
                placeholder="IFSC"
                value={acctIfsc} onChange={e => setAcctIfsc(e.target.value)} disabled={acctBusy}
                data-testid="wallet-payout-account-bank-ifsc"
              />
            </div>
          )}
          <div className="flex justify-end">
            <button
              className="text-xs px-3 py-1 rounded bg-emerald-600/40 hover:bg-emerald-600/60 text-white disabled:opacity-50"
              onClick={submitPayoutAccount} disabled={acctBusy}
              data-testid="wallet-payout-account-submit"
            >{acctBusy ? 'Saving…' : payout?.account ? 'Update account' : 'Save account'}</button>
          </div>
        </div>
      )}

      {withdrawOpen && (
        <div className="rounded border border-amber-400/30 bg-amber-400/5 p-2 space-y-2" data-testid="wallet-withdraw-form">
          <div className="text-[11px] text-muted-foreground">
            Available {ccy} {balance.toFixed(2)}
            {payout && ` · Limit ${ccy} ${payout.limits.maxPerTxn}/txn, ${ccy} ${payout.limits.maxPerDay}/day`}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">{ccy}</span>
            <input
              className="bg-black/30 text-white rounded px-2 py-1 text-sm w-28"
              type="number" min="1" step="1"
              placeholder="0"
              value={withdrawAmount}
              onChange={e => setWithdrawAmount(e.target.value)}
              disabled={withdrawBusy || !payout?.account?.verified}
              data-testid="wallet-withdraw-amount-input"
            />
            <button
              className="text-xs px-2 py-1 rounded bg-white/10 hover:bg-white/20 text-white disabled:opacity-40"
              onClick={() => setWithdrawAmount(String(balance))}
              disabled={withdrawBusy}
              data-testid="wallet-withdraw-max"
            >Max</button>
            <button
              className="text-xs px-3 py-1.5 rounded bg-amber-500/70 hover:bg-amber-500 text-black font-semibold disabled:opacity-50"
              onClick={submitWithdraw}
              disabled={withdrawBusy || !payout?.account?.verified}
              data-testid="wallet-withdraw-submit"
            >{withdrawBusy ? 'Withdrawing…' : 'Withdraw'}</button>
          </div>
          {!payout?.account ? (
            <div className="text-[11px] text-amber-300">Add a UPI / bank account first.</div>
          ) : !payout.account.verified ? (
            <div className="text-[11px] text-amber-300">
              {payout.account.verificationFailureReason
                ?? 'This account hasn\u2019t been verified with the bank yet — re-save it to verify.'}
            </div>
          ) : null}
        </div>
      )}

      {topupOpen && (
        <div className="flex gap-2 items-center pt-1" data-testid="wallet-topup-form">
          <span className="text-xs text-muted-foreground">{ccy}</span>
          <input
            className="bg-black/30 text-white rounded px-2 py-1 text-sm w-28"
            type="number" min="1" step="1"
            value={amount}
            onChange={e => setAmount(e.target.value)}
            disabled={busy}
            data-testid="wallet-topup-amount-input"
          />
          {[500, 1000, 2000, 5000].map(a => (
            <button key={a}
              className="text-xs px-2 py-1 rounded bg-white/10 hover:bg-white/20 text-white"
              onClick={() => setAmount(String(a))}
              disabled={busy}
              data-testid={`wallet-topup-quick-amount-${a}`}
            >{a}</button>
          ))}
          <button
            className="text-xs px-3 py-1.5 rounded bg-emerald-600/40 hover:bg-emerald-600/60 text-white disabled:opacity-50"
            onClick={startTopup}
            disabled={busy}
            data-testid="wallet-topup-submit"
          >{busy ? 'Processing…' : 'Pay with Razorpay'}</button>
        </div>
      )}

      {withdrawals.length > 0 && (
        <div className="pt-2 border-t border-white/10 space-y-1">
          <p className="text-xs text-muted-foreground" data-testid="wallet-withdrawals-heading">Withdrawals</p>
          <table className="w-full text-xs" data-testid="wallet-withdrawals-table">
            <tbody>
              {withdrawals.slice(0, 8).map(w => {
                const st = withdrawalStatusLabel(w.status);
                return (
                  <tr
                    key={w.id}
                    className="border-b border-white/5"
                    data-testid={`wallet-withdrawal-row-${w.id}`}
                  >
                    <td className="py-1 text-white">
                      {w.method === 'upi' ? 'UPI' : 'Bank'}
                      {w.utr ? <span className="text-muted-foreground"> · UTR {w.utr}</span> : null}
                      {w.debitTxnId ? (
                        <>
                          {' · '}
                          <button
                            type="button"
                            onClick={() => focusTxn(w.debitTxnId!)}
                            className="underline text-amber-300/90 hover:text-amber-200"
                            title="Jump to ledger debit"
                            data-testid={`wallet-withdrawal-txn-link-${w.debitTxnId}`}
                          >Txn #{w.debitTxnId}</button>
                        </>
                      ) : null}
                      {w.refundTxnId ? (
                        <>
                          {' · '}
                          <button
                            type="button"
                            onClick={() => focusTxn(w.refundTxnId!)}
                            className="underline text-emerald-300/90 hover:text-emerald-200"
                            title="Jump to refund credit"
                            data-testid={`wallet-withdrawal-refund-link-${w.refundTxnId}`}
                          >Refund #{w.refundTxnId}</button>
                        </>
                      ) : null}
                      {w.failureReason && (w.status === 'failed' || w.status === 'reversed' || w.status === 'paid_after_refund')
                        ? <div className="text-[10px] text-rose-300/80">{w.failureReason}</div>
                        : null}
                      {w.notify ? (() => {
                        const badges: React.ReactNode[] = [];
                        const renderBadge = (channel: 'email' | 'push', ch: WithdrawalNotifyChannel) => {
                          const s = ch.status;
                          if (!s) return;
                          // Task #1499 — append "next try in 2m 14s" while
                          // retrying and "gave up 3m ago" once exhausted so
                          // the member knows whether to wait or move on.
                          const nextTry = s === 'retrying' ? formatRetryRelative(ch.nextRetryAt, retryNowMs) : null;
                          const exhausted = s === 'failed_permanent' ? formatRetryRelative(ch.exhaustedAt, retryNowMs) : null;
                          const baseLabel = notifyChannelLabel(channel, s);
                          const suffix = s === 'retrying' && nextTry
                            ? ` — next try ${nextTry}`
                            : s === 'failed_permanent' && exhausted
                              ? ` — gave up ${exhausted}`
                              : '';
                          const channelTitleLabel = channel === 'email' ? 'Email' : 'Push';
                          const title = s === 'failed_permanent'
                            ? `${channelTitleLabel} gave up after ${ch.attempts} attempts${exhausted ? ` (${exhausted})` : ''}. Check the bank app for the payout.`
                            : s === 'retrying'
                              ? `${channelTitleLabel} retrying (${ch.attempts} attempt${ch.attempts === 1 ? '' : 's'} so far)${nextTry ? `. Next try ${nextTry}.` : ''}`
                              : `${channelTitleLabel} confirmation delivered`;
                          badges.push(
                            <span
                              key={channel}
                              className={`inline-block px-1.5 py-0.5 rounded border text-[10px] ${notifyChannelClass(s)}`}
                              data-testid={`badge-withdrawal-${channel}-${w.id}`}
                              data-status={s}
                              data-next-retry-at={ch.nextRetryAt ?? undefined}
                              data-exhausted-at={ch.exhaustedAt ?? undefined}
                              title={title}
                            >{baseLabel}{suffix}</span>,
                          );
                        };
                        renderBadge('email', w.notify.email);
                        renderBadge('push', w.notify.push);
                        return badges.length > 0
                          ? <div className="mt-1 flex flex-wrap gap-1" data-testid={`row-withdrawal-notify-${w.id}`}>{badges}</div>
                          : null;
                      })() : null}
                    </td>
                    <td className="py-1">
                      <span className={`inline-block px-1.5 py-0.5 rounded ${st.cls}`}>{st.label}</span>
                    </td>
                    <td className="py-1 text-muted-foreground">{new Date(w.requestedAt).toLocaleDateString()}</td>
                    <td className="py-1 text-right font-semibold text-amber-300 align-top">
                      <span className="mr-0.5">−</span>
                      <PriceWithFx
                        orgId={orgId}
                        amount={w.amount}
                        currency={w.currency}
                        productClass="wallet"
                        showDisclosure={false}
                        disclosureOnHover
                        className="inline-block text-right align-top"
                        bookedClassName="text-amber-300"
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {txns.length > 0 && (
        <div className="pt-2 border-t border-white/10 space-y-1">
          <p className="text-xs text-muted-foreground" data-testid="wallet-recent-transactions-heading">Recent transactions</p>
          <table className="w-full text-xs" data-testid="wallet-recent-transactions-table">
            <tbody>
              {(() => {
                // Keep deep-linked txns mounted for the lifetime of the panel
                // — key off `extraTxnIds` (the sticky deep-link set) instead
                // of the short-lived `highlightTxnId`. See Task #1491.
                let visibleCount = 8;
                for (const id of extraTxnIds) {
                  const idx = txns.findIndex(t => t.id === id);
                  if (idx >= 0) visibleCount = Math.max(visibleCount, idx + 1);
                }
                return txns.slice(0, visibleCount).map(t => {
                  const credit = t.kind === 'credit';
                  const sign = credit ? '+' : '−';
                  const color = credit ? 'text-emerald-400' : 'text-red-400';
                  const label = t.note ?? (t.sourceType === 'wallet_topup_razorpay' ? 'Wallet top-up' : t.sourceType ?? t.kind);
                  const highlighted = highlightTxnId === t.id;
                  return (
                    <tr
                      key={t.id}
                      id={`wallet-txn-${t.id}`}
                      data-testid={`wallet-txn-row-${t.id}`}
                      className={`border-b border-white/5 transition-colors ${highlighted ? 'bg-amber-300/20' : ''}`}
                    >
                      <td className="py-1 text-white">
                        <span className="text-muted-foreground mr-1">#{t.id}</span>{label}
                        {/* Task #1841 — render the same email/push retry
                            countdown badges that wallet withdrawals get,
                            for `wallet_topup_refund` txns whose notify
                            attempts row carries a non-null delivery state. */}
                        {t.sourceType === 'wallet_topup_refund' && t.notify ? (
                          <NotifyChannelBadgesRow
                            notify={t.notify}
                            retryNowMs={retryNowMs}
                            rowTestId={`row-topup-refund-notify-${t.id}`}
                            badgeTestIdPrefix={`badge-topup-refund-${t.id}`}
                            attemptsTitleNoun="refund email"
                          />
                        ) : null}
                        {/* Task #1862 — full four-channel delivery
                            row (Email/Push/SMS/WhatsApp). Member-
                            facing wallet view, so `lastError` is
                            neither requested nor rendered. */}
                        {t.sourceType === 'wallet_topup_refund' && t.delivery ? (
                          <RefundDeliveryStatusRow
                            delivery={t.delivery}
                            rowTestId={`row-topup-refund-delivery-${t.id}`}
                            channelTestIdPrefix={`delivery-topup-refund-${t.id}`}
                          />
                        ) : null}
                      </td>
                      <td className="py-1 text-muted-foreground">{new Date(t.createdAt).toLocaleDateString()}</td>
                      <td className={`py-1 text-right font-semibold ${color}`}>{sign} {t.currency} {Number(t.amount).toFixed(2)}</td>
                    </tr>
                  );
                });
              })()}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

declare global {
  interface Window {
    Razorpay: new (options: Record<string, unknown>) => { open: () => void };
  }
}
