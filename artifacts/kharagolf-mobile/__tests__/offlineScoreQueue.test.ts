/**
 * Task #1329 — automated coverage for the mobile offline-replay flush.
 *
 * `flushOfflineQueue` is the half of the W1-B contract that lives on the
 * phone: the server may answer the batch POST with HTTP 409 + a per-row
 * `conflicts` array, and the queue handler must
 *
 *   1. Drop every row the server accepted (so we don't re-send them).
 *   2. Keep every conflicted row in AsyncStorage (so the chooser modal
 *      can still resolve it without losing the local entry).
 *   3. Surface the conflicts to the caller (so the screen can render the
 *      "review needed" banner / chooser modal).
 *
 * If any of those slips, the bug is the same one the server-side conflict
 * detection was built to stop: silently overwriting another device's
 * score on the next online flush.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/utils/api", () => ({ BASE_URL: "https://example.test" }));

const memoryStore = new Map<string, string>();
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: (k: string) => Promise.resolve(memoryStore.get(k) ?? null),
    setItem: (k: string, v: string) => { memoryStore.set(k, v); return Promise.resolve(); },
    removeItem: (k: string) => { memoryStore.delete(k); return Promise.resolve(); },
    getAllKeys: () => Promise.resolve(Array.from(memoryStore.keys())),
  },
}));

import {
  OFFLINE_QUEUE_KEY,
  flushOfflineQueue,
  type OfflineScore,
} from "@/utils/offlineScoreQueue";

const TOURNAMENT = 42;
const PLAYER = 7;

function seedQueue(entries: OfflineScore[]) {
  memoryStore.set(OFFLINE_QUEUE_KEY, JSON.stringify(entries));
}

function readQueue(): OfflineScore[] {
  const raw = memoryStore.get(OFFLINE_QUEUE_KEY);
  return raw ? JSON.parse(raw) : [];
}

beforeEach(() => {
  memoryStore.clear();
  vi.restoreAllMocks();
});

describe("flushOfflineQueue — Wave 1 W1-B conflict handling (Task #1329)", () => {
  it("keeps conflicted rows queued, removes synced rows, and returns the conflicts to the caller", async () => {
    const stalePhoneKnownAt = new Date(Date.now() - 60_000).toISOString();
    const queue: OfflineScore[] = [
      // Hole 5 — stale, will be reported as a conflict by the (mocked) server.
      { tournamentId: TOURNAMENT, playerId: PLAYER, round: 1, holeNumber: 5, strokes: 7, putts: 4, timestamp: 1, clientKnownAt: stalePhoneKnownAt },
      // Hole 6 — fresh, will be accepted.
      { tournamentId: TOURNAMENT, playerId: PLAYER, round: 1, holeNumber: 6, strokes: 3, putts: 1, timestamp: 2 },
      // A different player's row — must NOT be touched by this flush.
      { tournamentId: TOURNAMENT, playerId: PLAYER + 1, round: 1, holeNumber: 5, strokes: 4, putts: 2, timestamp: 3 },
    ];
    seedQueue(queue);

    const fetchMock = vi.fn(async () => ({
      status: 409,
      json: async () => ({
        synced: 1,
        conflict: true,
        conflicts: [
          {
            holeNumber: 5,
            round: 1,
            server: { strokes: 4, putts: 2, updatedAt: new Date().toISOString() },
            client: { strokes: 7, putts: 4 },
          },
        ],
      }),
    } as unknown as Response));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await flushOfflineQueue(TOURNAMENT, PLAYER);

    // Caller sees the conflict + the synced count, exactly what the
    // scoring screen needs to wire the review banner / chooser modal.
    expect(result.synced).toBe(1);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].holeNumber).toBe(5);
    expect(result.conflicts[0].server.strokes).toBe(4);
    expect(result.conflicts[0].client.strokes).toBe(7);

    // Network call shape: only the player's own rows go up, both with the
    // batch endpoint's expected scores[] payload.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://example.test/api/public/tournaments/${TOURNAMENT}/players/${PLAYER}/scores/batch`);
    const body = JSON.parse(init.body as string) as { scores: Array<{ holeNumber: number; clientKnownAt?: string }> };
    expect(body.scores).toHaveLength(2);
    expect(body.scores.map(s => s.holeNumber).sort()).toEqual([5, 6]);
    // The stale row's clientKnownAt must be forwarded — that's how the
    // server is able to detect the conflict in the first place.
    expect(body.scores.find(s => s.holeNumber === 5)?.clientKnownAt).toBe(stalePhoneKnownAt);

    // Storage shape: hole 6 (synced) gone, hole 5 (conflicted) retained,
    // the other player's row left untouched.
    const remaining = readQueue();
    const myRows = remaining.filter(r => r.playerId === PLAYER);
    expect(myRows).toHaveLength(1);
    expect(myRows[0].holeNumber).toBe(5);
    expect(myRows[0].strokes).toBe(7);

    const otherRows = remaining.filter(r => r.playerId !== PLAYER);
    expect(otherRows).toHaveLength(1);
    expect(otherRows[0].holeNumber).toBe(5);
  });

  it("clears all of the player's rows on a clean 200 success (no conflicts)", async () => {
    seedQueue([
      { tournamentId: TOURNAMENT, playerId: PLAYER, round: 1, holeNumber: 1, strokes: 4, timestamp: 1 },
      { tournamentId: TOURNAMENT, playerId: PLAYER, round: 1, holeNumber: 2, strokes: 5, timestamp: 2 },
    ]);
    globalThis.fetch = (vi.fn(async () => ({
      status: 200,
      json: async () => ({ synced: 2 }),
    })) as unknown) as typeof fetch;

    const result = await flushOfflineQueue(TOURNAMENT, PLAYER);

    expect(result.synced).toBe(2);
    expect(result.conflicts).toEqual([]);
    expect(readQueue()).toEqual([]);
  });

  it("leaves the queue intact when the network errors so nothing is lost", async () => {
    const queue: OfflineScore[] = [
      { tournamentId: TOURNAMENT, playerId: PLAYER, round: 1, holeNumber: 4, strokes: 5, timestamp: 1 },
    ];
    seedQueue(queue);
    globalThis.fetch = (vi.fn(async () => { throw new Error("boom"); }) as unknown) as typeof fetch;

    const result = await flushOfflineQueue(TOURNAMENT, PLAYER);

    expect(result).toEqual({ synced: 0, conflicts: [] });
    expect(readQueue()).toEqual(queue);
  });
});
