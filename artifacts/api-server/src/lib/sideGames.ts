/**
 * Side Games engine — pure compute over scores + per-game events.
 *
 * Supported games (gameType):
 *   - "skins"   : per-hole low net/gross wins; ties carry over.
 *   - "snake"   : a 3-putt "passes the snake"; whoever holds it at end pays.
 *   - "wolf"    : rotating wolf chooses partner / lone / blind; teams scored.
 *   - "nassau"  : front 9, back 9, total — match play, with optional presses.
 *
 * Each game has a `rules` object stored on the instance (jsonb).  Wolf and
 * Nassau additionally consume `events` (wolf picks, nassau presses, teams).
 * Engine output: a normalised `Standings` shape with per-player totals (in
 * stake-units) plus a settlement list of who-owes-whom.
 */

export type GameType = "skins" | "snake" | "wolf" | "nassau";

export interface ScoreEntry {
  playerId: number;
  holeNumber: number;
  strokes: number;
  putts?: number | null;
  par?: number | null;
  strokeIndex?: number | null;
  /** handicap strokes received on this hole (precomputed by caller) */
  handicapStrokes?: number;
}

export interface Participant {
  playerId: number;
  name: string;
  userId?: number | null;
  /** course handicap, if any (used for net skins) */
  courseHandicap?: number | null;
}

export interface SkinsRules {
  scoring?: "gross" | "net";
  carryover?: boolean;
  /** Validation rule: winner must beat with at least one of these to "validate" */
  validation?: "none" | "birdie_or_better" | "par_or_better";
  /** Per-skin currency stake (1 unit by default) */
  perSkin?: number;
}

export interface SnakeRules {
  /** Penalty per hole the snake is held at the end. Default 1. */
  stake?: number;
  /** If true, snake also passes on a 4-putt or worse. Default true. */
  fourPuttsAlsoPass?: boolean;
}

export interface WolfRules {
  /** "lone wolf" multiplier (default 2) */
  loneWolfMultiplier?: number;
  /** "blind wolf" (declared before tee) multiplier (default 3) */
  blindWolfMultiplier?: number;
  /** Stake per hole won (default 1) */
  perHole?: number;
  /** Order of wolves by hole — array of playerIds, length 18 (or holes) */
  wolfOrder?: number[];
}

export interface NassauRules {
  /** Stake per match segment (front, back, total). Default 1. */
  perSegment?: number;
  /** Allow double-press on each press. Default false. */
  allowPress?: boolean;
  /** Fixed teams: A vs B (each is array of playerIds) */
  teamA?: number[];
  teamB?: number[];
  /** Holes considered "front" (default 1-9) and "back" (default 10-18) */
  frontHoles?: number[];
  backHoles?: number[];
}

export interface WolfPick {
  hole: number;
  /** Mode: "partner" picks one tee-mate, "lone" goes alone after seeing tees,
   *  "blind" declares lone before any tee shot. */
  mode: "partner" | "lone" | "blind";
  partnerPlayerId?: number | null;
}

export interface NassauPress {
  /** Hole at which the press was called */
  hole: number;
  /** Which side called the press */
  calledByTeam: "A" | "B";
  /** Which segment to add a press match to */
  segment: "front" | "back" | "total";
}

export interface PlayerStanding {
  playerId: number;
  /** App user id behind this player (when known). Used to gate live wolf/nassau inputs to the right user. */
  userId?: number | null;
  name: string;
  /** Net winnings for this game (positive = owed, negative = owes) */
  net: number;
  /** Per-game breakdown: skins won, holes won, segments won, etc. */
  detail: Record<string, number | string | null>;
}

export interface OwedRow {
  fromPlayerId: number;
  fromName: string;
  toPlayerId: number;
  toName: string;
  amount: number;
}

export interface Standings {
  gameType: GameType;
  perPlayer: PlayerStanding[];
  /** Per-hole annotations the UI renders inline ("Carry +1", "Lone wolf wins", etc.) */
  perHoleNotes: Array<{ hole: number; note: string }>;
  /** Net settlement (after netting cycles) */
  settlements: OwedRow[];
  /** Free-form summary for the settlement sheet */
  summary: string;
}

// ─── Helpers ────────────────────────────────────────────────────────────

function netStrokes(s: ScoreEntry): number {
  return s.strokes - (s.handicapStrokes ?? 0);
}

function nameOf(p: Participant | undefined, fallbackId: number): string {
  return p?.name ?? `Player ${fallbackId}`;
}

/** Net pairwise debts → simplified settlements (each net positive ↔ each net negative). */
function settleFromNet(perPlayer: PlayerStanding[]): OwedRow[] {
  const debtors = perPlayer
    .filter(p => p.net < -0.0001)
    .map(p => ({ id: p.playerId, name: p.name, amt: -p.net }))
    .sort((a, b) => b.amt - a.amt);
  const creditors = perPlayer
    .filter(p => p.net > 0.0001)
    .map(p => ({ id: p.playerId, name: p.name, amt: p.net }))
    .sort((a, b) => b.amt - a.amt);
  const out: OwedRow[] = [];
  let i = 0, j = 0;
  while (i < debtors.length && j < creditors.length) {
    const pay = Math.min(debtors[i].amt, creditors[j].amt);
    if (pay > 0.005) {
      out.push({
        fromPlayerId: debtors[i].id,
        fromName: debtors[i].name,
        toPlayerId: creditors[j].id,
        toName: creditors[j].name,
        amount: Math.round(pay * 100) / 100,
      });
    }
    debtors[i].amt -= pay;
    creditors[j].amt -= pay;
    if (debtors[i].amt < 0.005) i++;
    if (creditors[j].amt < 0.005) j++;
  }
  return out;
}

function blankStandings(participants: Participant[], gameType: GameType): Standings {
  return {
    gameType,
    perPlayer: participants.map(p => ({
      playerId: p.playerId, userId: p.userId ?? null, name: p.name, net: 0, detail: {},
    })),
    perHoleNotes: [],
    settlements: [],
    summary: "",
  };
}

// ─── SKINS ──────────────────────────────────────────────────────────────

export function computeSkins(
  participants: Participant[],
  scores: ScoreEntry[],
  rules: SkinsRules,
): Standings {
  const out = blankStandings(participants, "skins");
  const carryover = rules.carryover !== false;
  const useNet = rules.scoring === "net";
  const perSkin = rules.perSkin ?? 1;
  const validation = rules.validation ?? "none";

  // Group by hole
  const holes = [...new Set(scores.map(s => s.holeNumber))].sort((a, b) => a - b);
  const byPlayer = new Map<number, PlayerStanding>();
  out.perPlayer.forEach(p => byPlayer.set(p.playerId, p));
  for (const p of out.perPlayer) {
    p.detail.skins = 0;
    p.detail.carries = 0;
  }

  let carry = 0;
  for (const hole of holes) {
    const holeScores = scores.filter(s => s.holeNumber === hole && participants.some(p => p.playerId === s.playerId));
    if (holeScores.length === 0) continue;

    const eff = (s: ScoreEntry) => useNet ? netStrokes(s) : s.strokes;
    const minScore = Math.min(...holeScores.map(eff));
    const winners = holeScores.filter(s => eff(s) === minScore);

    if (winners.length > 1) {
      // Tie -> carry
      if (carryover) {
        carry += 1;
        out.perHoleNotes.push({ hole, note: `Tied at ${minScore}${useNet ? " net" : ""} — carries (${carry})` });
      } else {
        out.perHoleNotes.push({ hole, note: `Tied at ${minScore}${useNet ? " net" : ""} — no skin` });
      }
      continue;
    }

    const winner = winners[0];
    // Validation check
    if (validation !== "none") {
      const par = winner.par ?? null;
      if (par == null) {
        // Without par we can't validate — treat as not validated; carry anyway.
        out.perHoleNotes.push({ hole, note: "Skin not validated (par unknown) — carries" });
        if (carryover) carry += 1;
        continue;
      }
      const eff = useNet ? netStrokes(winner) : winner.strokes;
      const toPar = eff - par;
      const minRequired = validation === "birdie_or_better" ? -1 : 0;
      if (toPar > minRequired) {
        out.perHoleNotes.push({ hole, note: `Won at ${winner.strokes} but not validated (need ${validation === "birdie_or_better" ? "birdie" : "par"} or better)` });
        if (carryover) carry += 1;
        continue;
      }
    }

    const skinsWon = 1 + carry;
    const winnerStanding = byPlayer.get(winner.playerId);
    if (winnerStanding) {
      winnerStanding.detail.skins = (Number(winnerStanding.detail.skins) || 0) + skinsWon;
    }
    out.perHoleNotes.push({
      hole,
      note: carry > 0
        ? `${winnerStanding?.name ?? "—"} wins ${skinsWon} skins (1 + ${carry} carry)`
        : `${winnerStanding?.name ?? "—"} wins`,
    });
    carry = 0;
  }

  // Convert skins won → net stake.  Each skin: winner gets perSkin from each
  // non-winner of that hole, and each non-winner pays perSkin to the winner.
  const n = participants.length;
  if (n >= 2) {
    let c = 0;
    for (const hole of holes) {
      const holeScores = scores.filter(s => s.holeNumber === hole && participants.some(pp => pp.playerId === s.playerId));
      if (holeScores.length === 0) continue;
      const eff = (s: ScoreEntry) => useNet ? netStrokes(s) : s.strokes;
      const m = Math.min(...holeScores.map(eff));
      const winners = holeScores.filter(s => eff(s) === m);
      let validated = winners.length === 1;
      if (validated && validation !== "none") {
        const w = winners[0];
        const par = w.par ?? null;
        if (par == null) validated = false;
        else {
          const toPar = (useNet ? netStrokes(w) : w.strokes) - par;
          const minRequired = validation === "birdie_or_better" ? -1 : 0;
          if (toPar > minRequired) validated = false;
        }
      }
      if (!validated) {
        if (carryover) c += 1;
        continue;
      }
      const skinsWon = 1 + c;
      const w = winners[0];
      const winnerStanding = byPlayer.get(w.playerId);
      const losers = holeScores.filter(s => s.playerId !== w.playerId);
      const payout = skinsWon * perSkin;
      if (winnerStanding) winnerStanding.net += payout * losers.length;
      for (const l of losers) {
        const ls = byPlayer.get(l.playerId);
        if (ls) ls.net -= payout;
      }
      c = 0;
    }
  }

  out.settlements = settleFromNet(out.perPlayer);
  const totalSkins = out.perPlayer.reduce((s, p) => s + (Number(p.detail.skins) || 0), 0);
  out.summary = `${totalSkins} skin${totalSkins === 1 ? "" : "s"} awarded${carry > 0 ? `, ${carry} carrying` : ""}`;
  return out;
}

// ─── SNAKE ──────────────────────────────────────────────────────────────
// Whoever 3-putts most recently "holds the snake" — they pay everyone the
// snake stake at the end of the round.  fourPuttsAlsoPass toggles 4+ putts
// counting the same as a 3-putt.

export function computeSnake(
  participants: Participant[],
  scores: ScoreEntry[],
  rules: SnakeRules,
): Standings {
  const out = blankStandings(participants, "snake");
  const stake = rules.stake ?? 1;
  const fourPlus = rules.fourPuttsAlsoPass !== false;
  const byPlayer = new Map<number, PlayerStanding>();
  out.perPlayer.forEach(p => { byPlayer.set(p.playerId, p); p.detail.threePutts = 0; });

  // Sort scores by hole number (ascending) and find latest 3-putt
  const sorted = [...scores]
    .filter(s => participants.some(p => p.playerId === s.playerId))
    .sort((a, b) => a.holeNumber - b.holeNumber);

  let snakeHolder: number | null = null;
  let snakeHole: number | null = null;
  for (const s of sorted) {
    const putts = s.putts ?? 0;
    if (putts >= 3) {
      if (putts === 3 || fourPlus) {
        const ps = byPlayer.get(s.playerId);
        if (ps) ps.detail.threePutts = (Number(ps.detail.threePutts) || 0) + 1;
        if (snakeHolder !== s.playerId) {
          snakeHolder = s.playerId;
          snakeHole = s.holeNumber;
          out.perHoleNotes.push({
            hole: s.holeNumber,
            note: `${nameOf(participants.find(p => p.playerId === s.playerId), s.playerId)} ${putts}-putts — holds the snake 🐍`,
          });
        } else {
          out.perHoleNotes.push({ hole: s.holeNumber, note: "Same player still holds snake" });
        }
      }
    }
  }

  if (snakeHolder !== null) {
    const losers = participants.filter(p => p.playerId !== snakeHolder);
    const holderStanding = byPlayer.get(snakeHolder);
    if (holderStanding) holderStanding.net -= stake * losers.length;
    for (const l of losers) {
      const ls = byPlayer.get(l.playerId);
      if (ls) ls.net += stake;
    }
    out.summary = `Snake last seen on hole ${snakeHole}: ${nameOf(participants.find(p => p.playerId === snakeHolder!), snakeHolder)} pays.`;
  } else {
    out.summary = "No 3-putts recorded — no snake holder.";
  }

  out.settlements = settleFromNet(out.perPlayer);
  return out;
}

// ─── WOLF ───────────────────────────────────────────────────────────────
// Each hole has a designated "wolf".  After tee shots, wolf chooses to
// partner up (1 player) or go alone (lone wolf, 2x).  If declared blind
// before any tees, payout is blindWolfMultiplier.

export function computeWolf(
  participants: Participant[],
  scores: ScoreEntry[],
  rules: WolfRules,
  events: { picks?: WolfPick[] } = {},
): Standings {
  const out = blankStandings(participants, "wolf");
  const perHole = rules.perHole ?? 1;
  const loneMul = rules.loneWolfMultiplier ?? 2;
  const blindMul = rules.blindWolfMultiplier ?? 3;
  const picks = events.picks ?? [];
  const order = rules.wolfOrder ?? [];
  const byPlayer = new Map<number, PlayerStanding>();
  out.perPlayer.forEach(p => { byPlayer.set(p.playerId, p); p.detail.holesWon = 0; });

  const playerIds = participants.map(p => p.playerId);

  const holes = [...new Set(scores.map(s => s.holeNumber))].sort((a, b) => a - b);
  for (const hole of holes) {
    const holeScores = scores.filter(s => s.holeNumber === hole && playerIds.includes(s.playerId));
    if (holeScores.length < 2) continue;

    // Determine wolf for this hole
    let wolfId: number | null = null;
    if (order.length > 0) {
      wolfId = order[(hole - 1) % order.length];
    } else if (playerIds.length > 0) {
      wolfId = playerIds[(hole - 1) % playerIds.length];
    }
    if (wolfId === null) continue;

    const pick = picks.find(p => p.hole === hole);
    let teamWolf: number[];
    let teamRest: number[];
    let multiplier = 1;
    if (!pick || pick.mode === "partner") {
      // Default: if no pick, treat as partner with the lowest scoring teammate
      const teammates = playerIds.filter(id => id !== wolfId);
      let partner: number | null = pick?.partnerPlayerId ?? null;
      if (!partner && teammates.length > 0) {
        // Auto: lowest scoring teammate is chosen
        const tScores = holeScores.filter(s => teammates.includes(s.playerId));
        if (tScores.length > 0) {
          const m = Math.min(...tScores.map(s => netStrokes(s)));
          partner = tScores.find(s => netStrokes(s) === m)!.playerId;
        }
      }
      teamWolf = partner ? [wolfId, partner] : [wolfId];
      teamRest = playerIds.filter(id => !teamWolf.includes(id));
    } else if (pick.mode === "lone") {
      teamWolf = [wolfId];
      teamRest = playerIds.filter(id => id !== wolfId);
      multiplier = loneMul;
    } else {
      teamWolf = [wolfId];
      teamRest = playerIds.filter(id => id !== wolfId);
      multiplier = blindMul;
    }

    const wolfBest = Math.min(...holeScores.filter(s => teamWolf.includes(s.playerId)).map(netStrokes));
    const restBest = Math.min(...holeScores.filter(s => teamRest.includes(s.playerId)).map(netStrokes));

    if (wolfBest === restBest) {
      out.perHoleNotes.push({ hole, note: "Halved" });
      continue;
    }
    const wolfWins = wolfBest < restBest;
    const winners = wolfWins ? teamWolf : teamRest;
    const losers = wolfWins ? teamRest : teamWolf;
    const payout = perHole * multiplier;

    // Each loser pays each winner `payout`.
    for (const l of losers) {
      for (const w of winners) {
        const ls = byPlayer.get(l); const ws = byPlayer.get(w);
        if (ls) ls.net -= payout;
        if (ws) {
          ws.net += payout;
          ws.detail.holesWon = (Number(ws.detail.holesWon) || 0) + 1;
        }
      }
    }
    const wname = nameOf(participants.find(p => p.playerId === wolfId), wolfId);
    out.perHoleNotes.push({
      hole,
      note: wolfWins
        ? `Wolf (${wname}) wins${multiplier > 1 ? ` x${multiplier}` : ""}`
        : `Pack wins${multiplier > 1 ? ` (wolf doubled vs. ${wname})` : ""}`,
    });
  }

  out.settlements = settleFromNet(out.perPlayer);
  out.summary = `${out.perHoleNotes.filter(n => !n.note.includes("Halved")).length} holes settled.`;
  return out;
}

// ─── NASSAU ─────────────────────────────────────────────────────────────
// Three matches: front 9, back 9, total.  Each is match play (lowest net per
// hole = 1 up, ties = halve).  Presses spawn additional sub-matches starting
// at the press hole through the segment end.

export function computeNassau(
  participants: Participant[],
  scores: ScoreEntry[],
  rules: NassauRules,
  events: { presses?: NassauPress[] } = {},
): Standings {
  const out = blankStandings(participants, "nassau");
  const perSeg = rules.perSegment ?? 1;
  const teamA = rules.teamA ?? participants.slice(0, 1).map(p => p.playerId);
  const teamB = rules.teamB ?? participants.slice(1, 2).map(p => p.playerId);
  const front = rules.frontHoles ?? Array.from({ length: 9 }, (_, i) => i + 1);
  const back = rules.backHoles ?? Array.from({ length: 9 }, (_, i) => i + 10);
  const presses = events.presses ?? [];
  const byPlayer = new Map<number, PlayerStanding>();
  out.perPlayer.forEach(p => { byPlayer.set(p.playerId, p); });

  if (teamA.length === 0 || teamB.length === 0) {
    out.summary = "Nassau requires both teams to have members.";
    return out;
  }

  function bestNet(team: number[], hole: number): number | null {
    const xs = scores.filter(s => s.holeNumber === hole && team.includes(s.playerId)).map(netStrokes);
    return xs.length > 0 ? Math.min(...xs) : null;
  }

  function playMatch(holes: number[], startHole: number, label: string): { winner: "A" | "B" | "halve"; aUp: number } {
    let upA = 0;
    for (const h of holes) {
      if (h < startHole) continue;
      const a = bestNet(teamA, h);
      const b = bestNet(teamB, h);
      if (a == null || b == null) continue;
      if (a < b) upA += 1;
      else if (b < a) upA -= 1;
    }
    out.perHoleNotes.push({
      hole: startHole,
      note: `${label}: ${upA === 0 ? "Halved" : (upA > 0 ? `Team A wins +${upA}` : `Team B wins +${-upA}`)}`,
    });
    return { winner: upA > 0 ? "A" : upA < 0 ? "B" : "halve", aUp: upA };
  }

  function applyPayout(winner: "A" | "B" | "halve", amount: number) {
    if (winner === "halve") return;
    const winners = winner === "A" ? teamA : teamB;
    const losers = winner === "A" ? teamB : teamA;
    // Each loser pays each winner amount.
    for (const l of losers) {
      for (const w of winners) {
        const ls = byPlayer.get(l); const ws = byPlayer.get(w);
        if (ls) ls.net -= amount;
        if (ws) ws.net += amount;
      }
    }
  }

  // Base 3 matches
  const m1 = playMatch(front, front[0], "Front 9");
  applyPayout(m1.winner, perSeg);
  const m2 = playMatch(back, back[0], "Back 9");
  applyPayout(m2.winner, perSeg);
  const m3 = playMatch([...front, ...back], front[0], "Total 18");
  applyPayout(m3.winner, perSeg);

  // Presses (each spawns a sub-match within its segment from press hole onward)
  if (rules.allowPress) {
    for (const pr of presses) {
      const segHoles = pr.segment === "front" ? front : pr.segment === "back" ? back : [...front, ...back];
      const sub = playMatch(segHoles, pr.hole, `${pr.segment.toUpperCase()} press by ${pr.calledByTeam}`);
      applyPayout(sub.winner, perSeg);
    }
  }

  out.settlements = settleFromNet(out.perPlayer);
  out.summary = `Front: ${m1.winner}, Back: ${m2.winner}, Total: ${m3.winner}`;
  return out;
}

// ─── DISPATCHER ─────────────────────────────────────────────────────────

export function computeStandings(
  gameType: GameType,
  participants: Participant[],
  scores: ScoreEntry[],
  rules: Record<string, unknown>,
  events: Record<string, unknown> = {},
): Standings {
  switch (gameType) {
    case "skins":  return computeSkins(participants, scores, rules as SkinsRules);
    case "snake":  return computeSnake(participants, scores, rules as SnakeRules);
    case "wolf":   return computeWolf(participants, scores, rules as WolfRules, events as { picks?: WolfPick[] });
    case "nassau": return computeNassau(participants, scores, rules as NassauRules, events as { presses?: NassauPress[] });
    default: {
      const exhaustive: never = gameType;
      throw new Error(`Unknown game type: ${exhaustive}`);
    }
  }
}

export const SUPPORTED_GAME_TYPES: readonly GameType[] = ["skins", "snake", "wolf", "nassau"] as const;

export function isGameType(s: unknown): s is GameType {
  return typeof s === "string" && (SUPPORTED_GAME_TYPES as readonly string[]).includes(s);
}
