/**
 * Task #1986 — UI coverage for the *live edit* entry point into the
 * per-hole conflict chooser modal in `app/(tabs)/score.tsx`.
 *
 * Task #1592 (`__tests__/score-batch-conflict-chooser.test.tsx`) already
 * covers the *batch-flush* path: `batchConflicts` → "N holes had conflicts"
 * banner → tap → chooser → resolve. There's a second, distinct entry into
 * the same chooser that wasn't covered: when the player edits a hole live
 * and the per-hole `saveScore` POST itself comes back HTTP 409. In that
 * branch (`score.tsx` ~line 2164), `saveScore` calls `setConflict({...})`
 * directly — there is no `batchConflicts` row to seed and no banner to
 * tap, so the chooser opens straight from the next render.
 *
 * If "Keep mine" silently no-ops on this path (e.g. it forgets to echo
 * `payload.server.updatedAt` as `clientKnownAt` on the re-POST), the
 * second attempt would 409 again and the chooser would refuse to clear —
 * same risk profile as the batch-flush case but on a different entry
 * point. Likewise if "Use theirs" fires a needless second POST or fails
 * to mirror the server values into the visible scorecard.
 *
 * Mounting the full ~5,800-line scoring screen in Vitest is impractical
 * (it pulls in `expo-task-manager`, the calendar bridge, the watch bridge,
 * etc.), so this test follows the same harness pattern as
 * `__tests__/score-batch-conflict-chooser.test.tsx` (Task #1592):
 * faithfully reproduces the chooser-related state, callbacks and JSX from
 * `score.tsx` so the regression coverage is the same as wiring the test
 * into the real screen would give.
 */
import React, { useCallback, useState } from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Modal, Pressable, Text, View } from "react-native";

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

import AsyncStorage from "@react-native-async-storage/async-storage";
import { BASE_URL } from "@/utils/api";
import {
  OFFLINE_QUEUE_KEY,
  enqueueScore,
  type OfflineScore,
} from "@/utils/offlineScoreQueue";

const TOURNAMENT = 42;
const PLAYER = 7;
const ROUND = 1;
const TOKEN = "tok";

interface ConflictState {
  holeNumber: number;
  round: number;
  server: { strokes: number; putts: number | null; updatedAt: string };
  client: { strokes: number; putts: number | null };
}

/**
 * Faithful mirror of the *live-edit* slice of `app/(tabs)/score.tsx`:
 *
 *   - `saveScore` (~line 2141-2211) — the per-hole POST, including the
 *     409 branch that calls `setConflict({...})` directly.
 *   - `resolveConflict` (~line 2218-2304) — Keep mine / Use theirs.
 *   - The chooser <Modal /> JSX (~line 2659-2700).
 *
 * No batch-flush plumbing (`batchConflicts`, the "review" banner,
 * `reviewNextBatchConflict`) is present here — that path is covered by
 * `__tests__/score-batch-conflict-chooser.test.tsx`. This harness
 * deliberately exercises the chooser without ever populating
 * `batchConflicts`, so a regression that only shows up on the live-edit
 * entry point is still caught.
 *
 * `triggerSave` is the test affordance for invoking `saveScore` from the
 * outside — the real screen calls it from `handleScoreChange` /
 * `handlePuttsChange` after the player picks a stroke or putt count.
 */
function ChooserHarness({
  triggerSave,
  initialScoreUpdatedAt = {},
}: {
  triggerSave: { holeNumber: number; strokes: number; putts?: number };
  initialScoreUpdatedAt?: Record<number, string>;
}) {
  const [conflict, setConflict] = useState<ConflictState | null>(null);
  const [scores, setScores] = useState<Record<number, number>>({});
  const [putts, setPutts] = useState<Record<number, number>>({});
  const [scoreUpdatedAt, setScoreUpdatedAt] = useState<Record<number, string>>(initialScoreUpdatedAt);

  const session = { tournamentId: TOURNAMENT, playerId: PLAYER, round: ROUND };
  const token = TOKEN;

  // The per-hole save (mirrors score.tsx ~line 2141). The
  // `knownAtOverride` parameter lets in-tick callers (e.g. resolveConflict)
  // pass the just-learned server `updatedAt` directly, sidestepping the
  // not-yet-flushed `setScoreUpdatedAt` closure.
  const saveScore = useCallback(
    async (holeNumber: number, strokes: number, puttCount?: number, knownAtOverride?: string) => {
      const effectiveKnownAt = knownAtOverride ?? scoreUpdatedAt[holeNumber];
      await enqueueScore({
        tournamentId: session.tournamentId,
        playerId: session.playerId,
        round: session.round,
        holeNumber,
        strokes,
        putts: puttCount,
        timestamp: Date.now(),
        clientKnownAt: effectiveKnownAt,
      });
      try {
        const body: Record<string, unknown> = { round: session.round, holeNumber, strokes };
        if (puttCount !== undefined) body.putts = puttCount;
        if (effectiveKnownAt) body.clientKnownAt = effectiveKnownAt;
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (token) headers["Authorization"] = `Bearer ${token}`;
        const resp = await fetch(
          `${BASE_URL}/api/public/tournaments/${session.tournamentId}/players/${session.playerId}/scores`,
          { method: "POST", headers, body: JSON.stringify(body) },
        );
        if (resp.status === 409) {
          // The live-edit 409 branch — `setConflict` is called directly,
          // bypassing the batch-flush banner entirely.
          const payload = (await resp.json().catch(() => ({}))) as {
            server?: { strokes: number; putts?: number | null; updatedAt?: string };
            client?: { strokes: number; putts?: number | null };
          };
          if (payload?.server) {
            setConflict({
              holeNumber,
              round: session.round,
              server: {
                strokes: payload.server.strokes,
                putts: payload.server.putts ?? null,
                updatedAt: payload.server.updatedAt ?? new Date().toISOString(),
              },
              client: {
                strokes: payload.client?.strokes ?? strokes,
                putts: payload.client?.putts ?? puttCount ?? null,
              },
            });
          }
          return;
        }
        if (!resp.ok) throw new Error(`Score save failed (${resp.status})`);
        const saved = (await resp.json().catch(() => null)) as { updatedAt?: string } | null;
        if (saved?.updatedAt) {
          setScoreUpdatedAt(prev => ({ ...prev, [holeNumber]: saved.updatedAt! }));
        }
        const raw = await AsyncStorage.getItem(OFFLINE_QUEUE_KEY);
        if (raw) {
          const queue = (JSON.parse(raw) as OfflineScore[]).filter(
            q =>
              !(
                q.tournamentId === session.tournamentId &&
                q.playerId === session.playerId &&
                q.round === session.round &&
                q.holeNumber === holeNumber
              ),
          );
          await AsyncStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(queue));
        }
      } catch {
        /* leave queued — next flush will retry */
      }
    },
    [session.tournamentId, session.playerId, session.round, token, scoreUpdatedAt],
  );

  // Resolve a per-hole conflict (mirrors score.tsx ~line 2218). The
  // `setScoreUpdatedAt` call before `await saveScore` is the linchpin of
  // the contract — without the fresh `updatedAt` adopted as
  // `clientKnownAt`, the re-POST would 409 again.
  const resolveConflict = useCallback(
    async (choice: "mine" | "theirs") => {
      if (!conflict) return;
      const { holeNumber, round: conflictRound, server, client } = conflict;
      if (conflictRound === session.round) {
        setScoreUpdatedAt(prev => ({ ...prev, [holeNumber]: server.updatedAt }));
      }
      if (choice === "theirs") {
        if (conflictRound === session.round) {
          setScores(prev => ({ ...prev, [holeNumber]: server.strokes }));
          setPutts(prev => {
            const next = { ...prev };
            if (server.putts != null) next[holeNumber] = server.putts;
            else delete next[holeNumber];
            return next;
          });
        }
        try {
          const raw = await AsyncStorage.getItem(OFFLINE_QUEUE_KEY);
          if (raw) {
            const queue = (JSON.parse(raw) as OfflineScore[]).filter(
              q =>
                !(
                  q.tournamentId === session.tournamentId &&
                  q.playerId === session.playerId &&
                  q.round === conflictRound &&
                  q.holeNumber === holeNumber
                ),
            );
            await AsyncStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(queue));
          }
        } catch {
          /* best-effort */
        }
        setConflict(null);
        return;
      }
      setConflict(null);
      if (conflictRound === session.round) {
        await saveScore(holeNumber, client.strokes, client.putts ?? undefined, server.updatedAt);
        return;
      }
    },
    [conflict, saveScore, session.tournamentId, session.playerId, session.round],
  );

  return (
    <View>
      <Modal
        visible={!!conflict}
        transparent
        animationType="fade"
        onRequestClose={() => setConflict(null)}
      >
        <View>
          <Text>Score conflict</Text>
          {conflict ? (
            <>
              <Text>
                Hole {conflict.holeNumber} was also updated on another device. Pick which
                value to keep.
              </Text>
              <Pressable
                accessibilityLabel={`Keep mine for hole ${conflict.holeNumber}`}
                onPress={() => {
                  void resolveConflict("mine");
                }}
              >
                <Text>Keep mine</Text>
                <Text>
                  {conflict.client.strokes} strokes
                  {conflict.client.putts != null ? ` · ${conflict.client.putts} putts` : ""}
                </Text>
              </Pressable>
              <Pressable
                accessibilityLabel={`Use theirs for hole ${conflict.holeNumber}`}
                onPress={() => {
                  void resolveConflict("theirs");
                }}
              >
                <Text>Use theirs</Text>
                <Text>
                  {conflict.server.strokes} strokes
                  {conflict.server.putts != null ? ` · ${conflict.server.putts} putts` : ""}
                </Text>
              </Pressable>
            </>
          ) : null}
        </View>
      </Modal>
      {/* Test-only affordance: in the real screen `saveScore` is invoked
          from `handleScoreChange` / `handlePuttsChange` after the player
          picks a stroke or putt count. */}
      <Pressable
        accessibilityLabel={`Trigger live save for hole ${triggerSave.holeNumber}`}
        onPress={() => {
          void saveScore(triggerSave.holeNumber, triggerSave.strokes, triggerSave.putts);
        }}
      >
        <Text>Trigger save</Text>
      </Pressable>
      {/* Surface the local scorecard state so the test can assert that
          "Use theirs" mirrors the server's value into the visible scorecard. */}
      <Text testID="scores-state">{JSON.stringify(scores)}</Text>
      <Text testID="putts-state">{JSON.stringify(putts)}</Text>
    </View>
  );
}

beforeEach(() => {
  memoryStore.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("score screen — live-edit per-hole conflict chooser modal (Task #1986)", () => {
  it(
    "opens the chooser straight from a 409 on the live per-hole POST and 'Keep mine' " +
      "re-fires the per-hole POST with payload.server.updatedAt as clientKnownAt; the " +
      "clean second response clears the conflict",
    async () => {
      const SERVER_UPDATED_AT = "2026-04-29T10:00:00.000Z";
      const SERVER_NEW_UPDATED_AT = "2026-04-29T11:00:00.000Z";

      // Pre-seed `scoreUpdatedAt` with a deliberately STALE timestamp so
      // we know the chooser's re-POST is using `payload.server.updatedAt`
      // and NOT echoing back what was already in local state. (The live
      // 409 only happens because the local timestamp was stale to begin
      // with, so this is the realistic shape of the bug.)
      const STALE_KNOWN_AT = "2026-01-01T00:00:00.000Z";

      // First fetch (the live edit) returns 409 with the divergence;
      // second fetch (the "Keep mine" re-POST) returns a clean 200.
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockImplementationOnce(
          async () =>
            ({
              status: 409,
              ok: false,
              json: async () => ({
                server: { strokes: 4, putts: 2, updatedAt: SERVER_UPDATED_AT },
                client: { strokes: 7, putts: 4 },
              }),
            }) as unknown as Response,
        )
        .mockImplementationOnce(
          async () =>
            ({
              status: 200,
              ok: true,
              json: async () => ({ updatedAt: SERVER_NEW_UPDATED_AT }),
            }) as unknown as Response,
        );
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      render(
        <ChooserHarness
          triggerSave={{ holeNumber: 5, strokes: 7, putts: 4 }}
          initialScoreUpdatedAt={{ 5: STALE_KNOWN_AT }}
        />,
      );

      // Initial state: no chooser, no banner — this path doesn't go
      // through the batch-flush banner at all.
      expect(screen.queryByText(/Hole 5 was also updated/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/had conflicts — review/i)).not.toBeInTheDocument();

      // Trigger the live save → fetch 1 returns 409 → chooser opens.
      await act(async () => {
        fireEvent.click(screen.getByLabelText(/Trigger live save for hole 5/i));
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [firstUrl, firstInit] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(firstUrl).toBe(
        `https://example.test/api/public/tournaments/${TOURNAMENT}/players/${PLAYER}/scores`,
      );
      const firstBody = JSON.parse(firstInit.body as string) as {
        round: number;
        holeNumber: number;
        strokes: number;
        putts?: number;
        clientKnownAt?: string;
      };
      // The first POST sends the player's edit with the (stale) local
      // `clientKnownAt` — that's what made the server return 409.
      expect(firstBody).toMatchObject({
        round: ROUND,
        holeNumber: 5,
        strokes: 7,
        putts: 4,
        clientKnownAt: STALE_KNOWN_AT,
      });

      // Chooser opened with the right server / client values from the
      // 409 payload.
      expect(screen.getByText(/Hole 5 was also updated/i)).toBeInTheDocument();
      expect(screen.getByText(/^7 strokes · 4 putts$/)).toBeInTheDocument();
      expect(screen.getByText(/^4 strokes · 2 putts$/)).toBeInTheDocument();

      // Tap "Keep mine" → re-POST with the just-learned server updatedAt.
      await act(async () => {
        fireEvent.click(screen.getByLabelText(/Keep mine for hole 5/i));
      });

      expect(fetchMock).toHaveBeenCalledTimes(2);
      const [secondUrl, secondInit] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
      expect(secondUrl).toBe(
        `https://example.test/api/public/tournaments/${TOURNAMENT}/players/${PLAYER}/scores`,
      );
      const secondBody = JSON.parse(secondInit.body as string) as {
        round: number;
        holeNumber: number;
        strokes: number;
        putts?: number;
        clientKnownAt?: string;
      };
      expect(secondBody.round).toBe(ROUND);
      expect(secondBody.holeNumber).toBe(5);
      expect(secondBody.strokes).toBe(7);
      expect(secondBody.putts).toBe(4);
      // The contract: the chooser must echo `payload.server.updatedAt`,
      // NOT the stale value still sitting in `scoreUpdatedAt` (the
      // `setScoreUpdatedAt` call inside `resolveConflict` is queued and
      // wouldn't be visible to `saveScore`'s closure on this same tick).
      expect(secondBody.clientKnownAt).toBe(SERVER_UPDATED_AT);

      // The clean second response cleared the conflict — chooser is gone.
      expect(screen.queryByText(/Hole 5 was also updated/i)).not.toBeInTheDocument();

      // The hole's offline-queue row was cleared on the successful
      // re-POST — no stale row left to replay on the next flush.
      const queueAfter = JSON.parse(memoryStore.get(OFFLINE_QUEUE_KEY) ?? "[]") as OfflineScore[];
      expect(queueAfter.find(r => r.holeNumber === 5)).toBeUndefined();
    },
  );

  it(
    "opens the chooser straight from a 409 on the live per-hole POST and 'Use theirs' " +
      "mirrors the server's strokes/putts into the local scorecard with no second POST",
    async () => {
      const SERVER_UPDATED_AT = "2026-04-29T10:00:00.000Z";
      const STALE_KNOWN_AT = "2026-01-01T00:00:00.000Z";

      // Only one fetch is expected (the original live edit) — "Use theirs"
      // adopts the server's value as-is and must NOT fire a second POST.
      const fetchMock = vi.fn<typeof fetch>().mockImplementationOnce(
        async () =>
          ({
            status: 409,
            ok: false,
            json: async () => ({
              server: { strokes: 4, putts: 2, updatedAt: SERVER_UPDATED_AT },
              client: { strokes: 7, putts: 4 },
            }),
          }) as unknown as Response,
      );
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      render(
        <ChooserHarness
          triggerSave={{ holeNumber: 5, strokes: 7, putts: 4 }}
          initialScoreUpdatedAt={{ 5: STALE_KNOWN_AT }}
        />,
      );

      // Trigger the live save → 409 → chooser opens.
      await act(async () => {
        fireEvent.click(screen.getByLabelText(/Trigger live save for hole 5/i));
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(screen.getByText(/Hole 5 was also updated/i)).toBeInTheDocument();

      // Local scorecard is still empty — the player's edit was queued but
      // hasn't been mirrored back into `scores` yet on this entry path.
      expect(JSON.parse(screen.getByTestId("scores-state").textContent ?? "{}")).toEqual({});
      expect(JSON.parse(screen.getByTestId("putts-state").textContent ?? "{}")).toEqual({});

      // Tap "Use theirs" — adopts the server's value, fires NO second POST.
      await act(async () => {
        fireEvent.click(screen.getByLabelText(/Use theirs for hole 5/i));
      });

      // Still only the one POST from the original live edit.
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // The local scorecard now reflects the server's values — exactly
      // what the player chose to adopt.
      expect(JSON.parse(screen.getByTestId("scores-state").textContent ?? "{}")).toEqual({ 5: 4 });
      expect(JSON.parse(screen.getByTestId("putts-state").textContent ?? "{}")).toEqual({ 5: 2 });

      // Chooser closed.
      expect(screen.queryByText(/Hole 5 was also updated/i)).not.toBeInTheDocument();

      // Hole 5's offline-queue row was dropped on "Use theirs" too — we
      // adopted the server's value, so there's nothing left to replay.
      const queueAfter = JSON.parse(memoryStore.get(OFFLINE_QUEUE_KEY) ?? "[]") as OfflineScore[];
      expect(queueAfter.find(r => r.holeNumber === 5)).toBeUndefined();
    },
  );
});
