import { describe, it, expect } from "vitest";
import { computeRoundRobinStandings, type StandingsMatch } from "@/utils/round-robin-standings";

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

describe("computeRoundRobinStandings (mobile)", () => {
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

  it("uses head-to-head to order two players tied on points", () => {
    // Players 1 and 2 both finish on 1 point. Their head-to-head meeting
    // decides the order; holes won is deliberately tied so this isolates
    // the head-to-head tie-break.
    const matches = [
      match(1, 1, 2, "player1_wins", 1, { 1: "player1", 2: "player2" }),
      match(2, 1, 3, "player2_wins", 3, { 1: "player2", 2: "player1" }),
      match(3, 2, 3, "player1_wins", 2, { 1: "player1", 2: "player2" }),
    ];
    const standings = computeRoundRobinStandings(matches);

    expect(standings.find(r => r.playerId === 1)!.points).toBe(1);
    expect(standings.find(r => r.playerId === 2)!.points).toBe(1);
    expect(standings.find(r => r.playerId === 1)!.holesWon)
      .toBe(standings.find(r => r.playerId === 2)!.holesWon);

    const rank1 = standings.find(r => r.playerId === 1)!.rank;
    const rank2 = standings.find(r => r.playerId === 2)!.rank;
    expect(rank1).toBeLessThan(rank2);
  });

  it("falls back to holes won when points and head-to-head are tied", () => {
    const matches = [
      match(1, 1, 2, "player1_wins", 1, { 1: "player1", 2: "player1", 3: "player2" }),
      match(2, 2, 1, "player1_wins", 2, { 1: "player2", 2: "player1" }),
    ];
    const standings = computeRoundRobinStandings(matches);

    expect(standings[0]).toMatchObject({ playerId: 1, holesWon: 3, rank: 1 });
    expect(standings[1]).toMatchObject({ playerId: 2, holesWon: 2, rank: 2 });
  });

  it("ignores bye matches and pending matches", () => {
    const matches: StandingsMatch[] = [
      match(1, 1, 2, "pending", null),
      { ...match(2, 1, 2, "player1_wins", 1), player2IsBye: true },
    ];
    const standings = computeRoundRobinStandings(matches);

    expect(standings.find(r => r.playerId === 1)?.played).toBe(0);
    expect(standings.find(r => r.playerId === 2)?.played).toBe(0);
  });
});
