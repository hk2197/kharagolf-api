/**
 * Unit tests for the side games scoring engine.
 *
 * These are pure-compute tests — no DB, no app boot — covering:
 *   - skins: gross/net, carryover on/off, birdie/par validation, ties
 *   - snake: 3-putt and 4-putt rules, holder persistence across holes
 *   - wolf:  partner / lone / blind multipliers and rotation
 *   - nassau: front/back/total with and without presses, fixed teams
 *   - settlement: greedy net → owed-rows for a known cycle
 */
import { describe, it, expect } from "vitest";
import {
  computeSkins,
  computeSnake,
  computeWolf,
  computeNassau,
  computeStandings,
  isGameType,
  SUPPORTED_GAME_TYPES,
  type Participant,
  type ScoreEntry,
} from "../lib/sideGames.js";

const P = (id: number, name: string, courseHandicap: number | null = null): Participant => ({
  playerId: id, name, courseHandicap,
});
const S = (
  playerId: number,
  holeNumber: number,
  strokes: number,
  extra: Partial<ScoreEntry> = {},
): ScoreEntry => ({ playerId, holeNumber, strokes, ...extra });

const netOf = (s: ReturnType<typeof computeSkins>, id: number) =>
  s.perPlayer.find(p => p.playerId === id)!.net;
const detailOf = (s: ReturnType<typeof computeSkins>, id: number) =>
  s.perPlayer.find(p => p.playerId === id)!.detail;

// ─── SKINS ──────────────────────────────────────────────────────────────

describe("computeSkins", () => {
  const players = [P(1, "A"), P(2, "B"), P(3, "C"), P(4, "D")];

  it("awards gross skins with carryover on a tie", () => {
    // Hole 1: A wins outright with 4
    // Hole 2: A & B tie at 4 → carry
    // Hole 3: B wins outright with 4 → wins 2 skins
    const scores: ScoreEntry[] = [
      S(1, 1, 4), S(2, 1, 5), S(3, 1, 5), S(4, 1, 5),
      S(1, 2, 4), S(2, 2, 4), S(3, 2, 5), S(4, 2, 5),
      S(1, 3, 5), S(2, 3, 4), S(3, 3, 5), S(4, 3, 5),
    ];
    const out = computeSkins(players, scores, { scoring: "gross", carryover: true });

    expect(detailOf(out, 1).skins).toBe(1);
    expect(detailOf(out, 2).skins).toBe(2);
    expect(detailOf(out, 3).skins).toBe(0);
    expect(detailOf(out, 4).skins).toBe(0);

    // 4 players, perSkin=1: A wins 1 skin → +3, B wins 2 skins (incl. 1 carry) → +6
    // Each non-winner pays perSkin per skin awarded:
    //   Hole 1 (1 skin): each of B,C,D pays 1 to A
    //   Hole 3 (2 skins): each of A,C,D pays 2 to B
    expect(netOf(out, 1)).toBe(3 - 2);   // +1
    expect(netOf(out, 2)).toBe(-1 + 6);  // +5
    expect(netOf(out, 3)).toBe(-1 - 2);  // -3
    expect(netOf(out, 4)).toBe(-1 - 2);  // -3
    expect(out.perPlayer.reduce((s, p) => s + p.net, 0)).toBe(0);

    // Carry note must reference the hole that tied
    expect(out.perHoleNotes.some(n => n.hole === 2 && /carries/i.test(n.note))).toBe(true);
    expect(out.summary).toMatch(/3 skins awarded/);
  });

  it("with carryover disabled: tied holes simply have no skin", () => {
    const scores: ScoreEntry[] = [
      S(1, 1, 4), S(2, 1, 5), S(3, 1, 5), S(4, 1, 5),
      S(1, 2, 4), S(2, 2, 4), S(3, 2, 5), S(4, 2, 5),  // tie, no skin
      S(1, 3, 5), S(2, 3, 4), S(3, 3, 5), S(4, 3, 5),
    ];
    const out = computeSkins(players, scores, { scoring: "gross", carryover: false });

    expect(detailOf(out, 1).skins).toBe(1);
    expect(detailOf(out, 2).skins).toBe(1);
    // Winner of a single skin gets perSkin from each of (n-1) losers
    expect(netOf(out, 1)).toBe(3 - 1); // +2
    expect(netOf(out, 2)).toBe(-1 + 3); // +2
    expect(netOf(out, 3)).toBe(-2);
    expect(netOf(out, 4)).toBe(-2);
    expect(out.perHoleNotes.some(n => n.hole === 2 && /no skin/i.test(n.note))).toBe(true);
  });

  it("birdie-or-better validation rejects a par win and carries it forward", () => {
    // Par 4. A "wins" hole 1 with 4 (par) — fails birdie validation, carry.
    // Hole 2 tie at 4 — carry.
    // Hole 3 B wins with 3 (birdie) → validated, sweeps 3 skins.
    const scores: ScoreEntry[] = [
      S(1, 1, 4, { par: 4 }), S(2, 1, 5, { par: 4 }), S(3, 1, 5, { par: 4 }), S(4, 1, 5, { par: 4 }),
      S(1, 2, 4, { par: 4 }), S(2, 2, 4, { par: 4 }), S(3, 2, 5, { par: 4 }), S(4, 2, 5, { par: 4 }),
      S(1, 3, 5, { par: 4 }), S(2, 3, 3, { par: 4 }), S(3, 3, 5, { par: 4 }), S(4, 3, 5, { par: 4 }),
    ];
    const out = computeSkins(players, scores, {
      scoring: "gross", carryover: true, validation: "birdie_or_better",
    });

    expect(detailOf(out, 1).skins).toBe(0);
    expect(detailOf(out, 2).skins).toBe(3);
    expect(netOf(out, 2)).toBe(9); // 3 skins × 3 losers
    expect(netOf(out, 1)).toBe(-3);
    expect(out.perHoleNotes.some(n => n.hole === 1 && /not validated/i.test(n.note))).toBe(true);
  });

  it("par-or-better validation accepts par wins", () => {
    const scores: ScoreEntry[] = [
      S(1, 1, 4, { par: 4 }), S(2, 1, 5, { par: 4 }), S(3, 1, 5, { par: 4 }), S(4, 1, 5, { par: 4 }),
    ];
    const out = computeSkins(players, scores, {
      scoring: "gross", carryover: true, validation: "par_or_better",
    });
    expect(detailOf(out, 1).skins).toBe(1);
    expect(netOf(out, 1)).toBe(3);
  });

  it("net skins use handicap strokes to break a gross tie", () => {
    // Gross both 4, but A has 1 handicap stroke on hole 1 → A net 3 wins.
    const scores: ScoreEntry[] = [
      S(1, 1, 4, { handicapStrokes: 1 }),
      S(2, 1, 4, { handicapStrokes: 0 }),
      S(3, 1, 5, { handicapStrokes: 0 }),
      S(4, 1, 5, { handicapStrokes: 0 }),
    ];
    const gross = computeSkins(players, scores, { scoring: "gross", carryover: true });
    const net = computeSkins(players, scores, { scoring: "net", carryover: true });

    // Gross: A & B tie at 4 → carry, no skins
    expect(detailOf(gross, 1).skins).toBe(0);
    expect(detailOf(gross, 2).skins).toBe(0);
    // Net: A wins outright
    expect(detailOf(net, 1).skins).toBe(1);
    expect(netOf(net, 1)).toBe(3);
  });
});

// ─── SNAKE ──────────────────────────────────────────────────────────────

describe("computeSnake", () => {
  const players = [P(1, "A"), P(2, "B"), P(3, "C"), P(4, "D")];

  it("the latest 3-putter holds the snake and pays the rest", () => {
    const scores: ScoreEntry[] = [
      S(1, 5, 5, { putts: 3 }),       // A grabs the snake
      S(2, 8, 5, { putts: 3 }),       // B grabs the snake
      S(1, 12, 5, { putts: 3 }),      // A grabs it back at hole 12
      S(3, 15, 4, { putts: 2 }),      // not a 3-putt — no change
    ];
    const out = computeSnake(players, scores, { stake: 1 });

    expect(netOf(out, 1)).toBe(-3); // pays 1 to each of B, C, D
    expect(netOf(out, 2)).toBe(1);
    expect(netOf(out, 3)).toBe(1);
    expect(netOf(out, 4)).toBe(1);
    expect(out.summary).toMatch(/hole 12/);
  });

  it("4-putts also pass the snake by default", () => {
    const scores: ScoreEntry[] = [
      S(2, 5, 6, { putts: 4 }),       // B 4-putts → holds snake
    ];
    const out = computeSnake(players, scores, { stake: 2 });
    expect(netOf(out, 2)).toBe(-6); // 2 stake × 3 losers
    expect(netOf(out, 1)).toBe(2);
  });

  it("when fourPuttsAlsoPass is false, a 4-putt does not pass the snake", () => {
    const scores: ScoreEntry[] = [
      S(1, 3, 6, { putts: 4 }),       // ignored — not a 3-putt and 4+ disabled
      S(2, 8, 5, { putts: 3 }),       // B grabs the snake
    ];
    const out = computeSnake(players, scores, { stake: 1, fourPuttsAlsoPass: false });
    expect(netOf(out, 2)).toBe(-3);
    expect(netOf(out, 1)).toBe(1);
    // A's 4-putt was not counted
    expect(detailOf(out, 1).threePutts).toBe(0);
    expect(detailOf(out, 2).threePutts).toBe(1);
  });

  it("if the same player 3-putts twice in a row, the holder note signals persistence", () => {
    const scores: ScoreEntry[] = [
      S(1, 5, 5, { putts: 3 }),
      S(1, 7, 6, { putts: 3 }),       // same player still holds
    ];
    const out = computeSnake(players, scores, { stake: 1 });
    expect(detailOf(out, 1).threePutts).toBe(2);
    expect(out.perHoleNotes.some(n => /still holds/i.test(n.note))).toBe(true);
    expect(netOf(out, 1)).toBe(-3);
  });

  it("no 3-putts → no snake holder, no debts", () => {
    const out = computeSnake(players, [S(1, 1, 4, { putts: 2 })], { stake: 1 });
    expect(out.perPlayer.every(p => p.net === 0)).toBe(true);
    expect(out.summary).toMatch(/no snake/i);
  });
});

// ─── WOLF ───────────────────────────────────────────────────────────────

describe("computeWolf", () => {
  const players = [P(1, "A"), P(2, "B"), P(3, "C"), P(4, "D")];

  it("partner mode auto-picks the lowest scoring teammate and shares the win", () => {
    // Hole 1, default rotation → wolf = A (id=1)
    // Scores: A=4, B=5, C=4, D=6 → auto partner = C (best teammate)
    // teamWolf=[A,C] best=4, teamRest=[B,D] best=5 → wolf team wins
    const scores: ScoreEntry[] = [
      S(1, 1, 4), S(2, 1, 5), S(3, 1, 4), S(4, 1, 6),
    ];
    const out = computeWolf(players, scores, {});
    // payout 1 per loser-winner pair: A,C each get +2; B,D each -2
    expect(netOf(out, 1)).toBe(2);
    expect(netOf(out, 3)).toBe(2);
    expect(netOf(out, 2)).toBe(-2);
    expect(netOf(out, 4)).toBe(-2);
  });

  it("lone wolf doubles the stake when the wolf wins alone", () => {
    // Hole 2, default rotation → wolf = B (id=2)
    const scores: ScoreEntry[] = [
      S(2, 2, 3), S(1, 2, 4), S(3, 2, 4), S(4, 2, 4),
    ];
    const out = computeWolf(players, scores, { perHole: 1, loneWolfMultiplier: 2 }, {
      picks: [{ hole: 2, mode: "lone" }],
    });
    // payout = 2; each of 3 losers pays 2 to wolf B → B +6, others -2
    expect(netOf(out, 2)).toBe(6);
    expect(netOf(out, 1)).toBe(-2);
    expect(netOf(out, 3)).toBe(-2);
    expect(netOf(out, 4)).toBe(-2);
    expect(out.perHoleNotes.some(n => n.hole === 2 && /x2/i.test(n.note))).toBe(true);
  });

  it("blind wolf pays at the blind multiplier and applies even when wolf loses", () => {
    // Hole 3, default rotation → wolf = C (id=3); declare blind, then lose.
    const scores: ScoreEntry[] = [
      S(3, 3, 5), S(1, 3, 4), S(2, 3, 4), S(4, 3, 4),
    ];
    const out = computeWolf(players, scores, { perHole: 1, blindWolfMultiplier: 3 }, {
      picks: [{ hole: 3, mode: "blind" }],
    });
    // Pack wins: payout=3, C pays 3 to each of 3 winners → C -9, others +3
    expect(netOf(out, 3)).toBe(-9);
    expect(netOf(out, 1)).toBe(3);
    expect(netOf(out, 2)).toBe(3);
    expect(netOf(out, 4)).toBe(3);
  });

  it("rotates the wolf using the configured wolfOrder", () => {
    // Order forces wolf = D on hole 1
    const scores: ScoreEntry[] = [
      S(4, 1, 3), S(1, 1, 4), S(2, 1, 4), S(3, 1, 4),
    ];
    const out = computeWolf(players, scores, { wolfOrder: [4, 1, 2, 3] }, {
      picks: [{ hole: 1, mode: "lone" }],
    });
    expect(netOf(out, 4)).toBe(6);
    expect(netOf(out, 1)).toBe(-2);
  });

  it("halves the hole when wolf and pack tie", () => {
    const scores: ScoreEntry[] = [
      S(1, 1, 4), S(2, 1, 4), S(3, 1, 5), S(4, 1, 5),
    ];
    const out = computeWolf(players, scores, {}, {
      picks: [{ hole: 1, mode: "lone" }],
    });
    expect(out.perPlayer.every(p => p.net === 0)).toBe(true);
    expect(out.perHoleNotes.some(n => /halved/i.test(n.note))).toBe(true);
  });
});

// ─── NASSAU ─────────────────────────────────────────────────────────────

describe("computeNassau", () => {
  it("settles front/back/total as three independent matches (1v1, no presses)", () => {
    const players = [P(1, "A"), P(2, "B")];
    // A dominates the front, B dominates the back, total nets out.
    const scores: ScoreEntry[] = [];
    for (let h = 1; h <= 9; h++) {
      scores.push(S(1, h, 4));   // A par
      scores.push(S(2, h, 5));   // B bogey
    }
    for (let h = 10; h <= 18; h++) {
      scores.push(S(1, h, 5));   // A bogey
      scores.push(S(2, h, 4));   // B par
    }
    const out = computeNassau(players, scores, { perSegment: 1 });
    // A wins front (+1), B wins back (+1 to B = -1 to A), total halved (0)
    expect(netOf(out, 1)).toBe(0);
    expect(netOf(out, 2)).toBe(0);
    expect(out.summary).toMatch(/Front: A.*Back: B.*Total: halve/);
  });

  it("respects fixed teams (2v2) for match scoring", () => {
    // A & B vs C & D. Best ball wins each hole.
    const players = [P(1, "A"), P(2, "B"), P(3, "C"), P(4, "D")];
    const scores: ScoreEntry[] = [];
    for (let h = 1; h <= 18; h++) {
      // Team AB best = 4, Team CD best = 5 → AB wins every hole
      scores.push(S(1, h, 4));
      scores.push(S(2, h, 6));
      scores.push(S(3, h, 5));
      scores.push(S(4, h, 7));
    }
    const out = computeNassau(players, scores, {
      perSegment: 1, teamA: [1, 2], teamB: [3, 4],
    });
    // Team A wins all three matches. Each loser pays each winner perSeg per match.
    // 3 segments × 1 perSeg = 3 per loser-winner pair. 2x2 grid → A,B each get +6, C,D each -6.
    expect(netOf(out, 1)).toBe(6);
    expect(netOf(out, 2)).toBe(6);
    expect(netOf(out, 3)).toBe(-6);
    expect(netOf(out, 4)).toBe(-6);
  });

  it("includes a press sub-match only when allowPress is true and only from the press hole onward", () => {
    const players = [P(1, "A"), P(2, "B")];
    const scores: ScoreEntry[] = [];
    // Front holes 1-5: B wins all 5 (B leads -5 on front so far)
    for (let h = 1; h <= 5; h++) {
      scores.push(S(1, h, 5));
      scores.push(S(2, h, 4));
    }
    // Front holes 6-9: A wins all 4
    for (let h = 6; h <= 9; h++) {
      scores.push(S(1, h, 3));
      scores.push(S(2, h, 4));
    }
    // Back: halved every hole
    for (let h = 10; h <= 18; h++) {
      scores.push(S(1, h, 4));
      scores.push(S(2, h, 4));
    }
    // Press by A on the front at hole 6 — covers only holes 6-9
    const events = { presses: [{ hole: 6, calledByTeam: "A" as const, segment: "front" as const }] };

    const noPress = computeNassau(players, scores, { perSegment: 1 }, events);
    // Without allowPress: front upA = -5+4 = -1 (B wins +1), back halved (0), total upA = -1 (B +1)
    // → A: -2, B: +2
    expect(netOf(noPress, 1)).toBe(-2);
    expect(netOf(noPress, 2)).toBe(2);

    const pressed = computeNassau(players, scores, { perSegment: 1, allowPress: true }, events);
    // The press sub-match runs holes 6-9: A wins all 4 → A wins press +1.
    // Net for A: -1 (front) + 0 (back) + -1 (total) + 1 (press) = -1
    expect(netOf(pressed, 1)).toBe(-1);
    expect(netOf(pressed, 2)).toBe(1);
    expect(pressed.perHoleNotes.some(n => /press/i.test(n.note))).toBe(true);
  });

  it("returns a friendly message when a team has no members", () => {
    const players = [P(1, "A"), P(2, "B")];
    const out = computeNassau(players, [], { perSegment: 1, teamA: [1], teamB: [] });
    expect(out.summary).toMatch(/both teams/i);
  });
});

// ─── SETTLEMENT (greedy, via skins) ─────────────────────────────────────

describe("greedy settlement from netted positions", () => {
  it("collapses a known imbalance into the minimum number of who-pays-whom rows", () => {
    // 3-player skins set up so finals are A=+5, B=-1, C=-4 (sums to 0).
    const players = [P(1, "A"), P(2, "B"), P(3, "C")];
    const scores: ScoreEntry[] = [
      S(1, 1, 4), S(2, 1, 5), S(3, 1, 5), // A wins 1 skin
      S(1, 2, 5), S(2, 2, 4), S(3, 2, 5), // B wins 1 skin
      S(1, 3, 5), S(2, 3, 5), S(3, 3, 5), // tie, carry
      S(1, 4, 4), S(2, 4, 5), S(3, 4, 5), // A wins 2 skins (incl. carry)
    ];
    const out = computeSkins(players, scores, { scoring: "gross", carryover: true });
    expect(netOf(out, 1)).toBe(5);
    expect(netOf(out, 2)).toBe(-1);
    expect(netOf(out, 3)).toBe(-4);

    // Expect exactly two settlement rows: C pays A 4, B pays A 1.
    expect(out.settlements).toHaveLength(2);
    const cToA = out.settlements.find(r => r.fromPlayerId === 3 && r.toPlayerId === 1);
    const bToA = out.settlements.find(r => r.fromPlayerId === 2 && r.toPlayerId === 1);
    expect(cToA?.amount).toBe(4);
    expect(bToA?.amount).toBe(1);
  });

  it("produces no settlements when everyone is square", () => {
    const players = [P(1, "A"), P(2, "B"), P(3, "C")];
    // No 3-putts, no snake holder → all zero
    const out = computeSnake(players, [S(1, 1, 4, { putts: 2 })], { stake: 1 });
    expect(out.settlements).toEqual([]);
  });
});

// ─── DISPATCHER ─────────────────────────────────────────────────────────

describe("computeStandings dispatcher", () => {
  it("routes to the correct engine and matches the direct call", () => {
    const players = [P(1, "A"), P(2, "B"), P(3, "C"), P(4, "D")];
    const scores: ScoreEntry[] = [
      S(1, 1, 4), S(2, 1, 5), S(3, 1, 5), S(4, 1, 5),
    ];
    const direct = computeSkins(players, scores, { scoring: "gross" });
    const viaDispatch = computeStandings("skins", players, scores, { scoring: "gross" });
    expect(viaDispatch.perPlayer.map(p => p.net)).toEqual(direct.perPlayer.map(p => p.net));
  });

  it("isGameType + SUPPORTED_GAME_TYPES agree", () => {
    for (const t of SUPPORTED_GAME_TYPES) expect(isGameType(t)).toBe(true);
    expect(isGameType("bridge")).toBe(false);
    expect(isGameType(42)).toBe(false);
  });
});
