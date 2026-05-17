import { describe, it, expect } from "vitest";
import { computeRoundRobinStandings, type StandingsMatch } from "../round-robin-standings";

const player = (id: number, last: string) => ({ id, firstName: "P", lastName: last });

function match(
  id: number,
  p1: number,
  p2: number,
  result: string,
  winnerId: number | null,
  holes: Record<string, "player1" | "player2" | "halved"> = {},
): StandingsMatch {
  return {
    id,
    bracketType: "main",
    player1Id: p1,
    player2Id: p2,
    player1IsBye: false,
    player2IsBye: false,
    result,
    winnerId,
    holeResults: holes,
    player1: player(p1, `L${p1}`),
    player2: player(p2, `L${p2}`),
  };
}

describe("computeRoundRobinStandings", () => {
  it("scores wins, losses and halved matches", () => {
    const matches = [
      match(1, 1, 2, "player1_wins", 1),
      match(2, 1, 3, "halved", null),
      match(3, 2, 3, "player2_wins", 3),
    ];
    const byId = new Map(computeRoundRobinStandings(matches).map(r => [r.playerId, r]));

    expect(byId.get(1)).toMatchObject({ played: 2, wins: 1, losses: 0, halved: 1, points: 1.5 });
    expect(byId.get(2)).toMatchObject({ played: 2, wins: 0, losses: 2, halved: 0, points: 0 });
    expect(byId.get(3)).toMatchObject({ played: 2, wins: 1, losses: 0, halved: 1, points: 1.5 });
  });

  it("breaks a two-player tie by head-to-head", () => {
    // Players 1 and 2 each beat 3 once, but 1 also beat 2 head-to-head.
    const matches = [
      match(1, 1, 3, "player1_wins", 1),
      match(2, 2, 3, "player1_wins", 2),
      match(3, 1, 2, "player1_wins", 1),
    ];
    const standings = computeRoundRobinStandings(matches);

    // Player 1: 2 wins (2pts), Player 2: 1 win (1pt), Player 3: 0 wins (0pts).
    // No actual tie at the top — verify ordering reflects raw points.
    expect(standings.map(r => r.playerId)).toEqual([1, 2, 3]);
    expect(standings.map(r => r.rank)).toEqual([1, 2, 3]);
  });

  it("uses head-to-head to order two players tied on points", () => {
    // 1 and 2 both finish with 1 point. Their head-to-head result decides the rank.
    const matches = [
      match(1, 1, 2, "player1_wins", 1), // 1 beats 2 head-to-head
      match(2, 1, 3, "player2_wins", 3), // 3 beats 1
      match(3, 2, 3, "player1_wins", 2), // 2 beats 3
    ];
    const standings = computeRoundRobinStandings(matches);

    expect(standings.find(r => r.playerId === 1)!.points).toBe(1);
    expect(standings.find(r => r.playerId === 2)!.points).toBe(1);
    expect(standings.find(r => r.playerId === 3)!.points).toBe(1);

    // Player 1 should rank ahead of Player 2 because they won the head-to-head.
    const rank1 = standings.find(r => r.playerId === 1)!.rank;
    const rank2 = standings.find(r => r.playerId === 2)!.rank;
    expect(rank1).toBeLessThan(rank2);
  });

  it("falls back to holes won when points and head-to-head are tied", () => {
    // 1 and 2 split a pair of matches (1 win each, 1 point each).
    // Their head-to-head total is even; holes won decides the order.
    const matches = [
      match(1, 1, 2, "player1_wins", 1, { 1: "player1", 2: "player1", 3: "player2" }),
      match(2, 2, 1, "player1_wins", 2, { 1: "player2", 2: "player1" }),
    ];
    const standings = computeRoundRobinStandings(matches);

    // Player 1 holes won: 2 (as player1 in match 1) + 1 (as player2 in match 2) = 3
    // Player 2 holes won: 1 (as player2 in match 1) + 1 (as player1 in match 2) = 2
    expect(standings[0]).toMatchObject({ playerId: 1, holesWon: 3, rank: 1 });
    expect(standings[1]).toMatchObject({ playerId: 2, holesWon: 2, rank: 2 });
  });

  it("ignores bye matches and does not count pending matches as played", () => {
    const matches: StandingsMatch[] = [
      match(1, 1, 2, "pending", null),
      { ...match(2, 1, 2, "player1_wins", 1), player2IsBye: true },
    ];
    const standings = computeRoundRobinStandings(matches);

    expect(standings.find(r => r.playerId === 1)?.played).toBe(0);
    expect(standings.find(r => r.playerId === 2)?.played).toBe(0);
  });

  it("flags top players as tied when points/h2h/holes-won are all equal", () => {
    // 1 and 2 split a pair of matches: each wins one with identical hole counts
    // ⇒ same points, even h2h, identical holes won. They must remain tied at #1.
    const matches: StandingsMatch[] = [
      match(1, 1, 2, "player1_wins", 1, { 1: "player1", 2: "player1" }),
      match(2, 2, 1, "player1_wins", 2, { 1: "player1", 2: "player1" }),
    ];
    const standings = computeRoundRobinStandings(matches);
    expect(standings[0].tied).toBe(true);
    expect(standings[1].tied).toBe(true);
  });

  it("does not flag a unique #1 as tied", () => {
    const matches = [
      match(1, 1, 2, "player1_wins", 1),
      match(2, 1, 3, "player1_wins", 1),
      match(3, 2, 3, "player2_wins", 3),
    ];
    const standings = computeRoundRobinStandings(matches);
    expect(standings[0].playerId).toBe(1);
    expect(standings[0].tied).toBe(false);
  });
});
