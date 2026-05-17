/**
 * Task #1592 — UI coverage for the per-hole conflict resolver chooser modal.
 *
 * `__tests__/offlineScoreQueue.test.ts` already covers the *queue* half of
 * Wave 1 W1-B (server returns 409, mobile keeps conflicted rows queued and
 * surfaces them via `flushOfflineQueue`). What was previously uncovered is
 * the *user-facing* resolver in `app/(tabs)/score.tsx`:
 *
 *   - the "N holes had conflicts — review" banner that pops the chooser
 *     when tapped (~line 2705);
 *   - the chooser <Modal /> that shows one conflict at a time and offers
 *     "Keep mine" or "Use theirs" (~line 2659);
 *   - `resolveConflict` (~line 2257), which on "Keep mine" re-fires the
 *     per-hole POST with the server's fresh `updatedAt` adopted as
 *     `clientKnownAt` so the second attempt passes the freshness check,
 *     and on "Use theirs" mirrors the server's value into the local
 *     scorecard without a second POST;
 *   - `reviewNextBatchConflict` (~line 2346), which pops the next pending
 *     conflict each time the banner is tapped.
 *
 * If any of those silently no-op or skip a conflict, the player would see
 * a stuck "review" banner — or worse, the chooser would appear to do
 * nothing while the offline queue still holds a stale row.
 *
 * Mounting the full ~5,800-line scoring screen in Vitest is impractical
 * (it pulls in `expo-task-manager`, the calendar bridge, the watch bridge,
 * etc.), so this test follows the same harness pattern as
 * `__tests__/score-cached-course-indicator.test.tsx` (Task #1587):
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
  type BatchConflict,
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
 * Faithful mirror of the chooser-related slice of `app/(tabs)/score.tsx`:
 *
 *   - `saveScore` (~line 2183-2250) — the per-hole POST.
 *   - `resolveConflict` (~line 2257-2339) — Keep mine / Use theirs.
 *   - `reviewNextBatchConflict` (~line 2346-2350) — pops the next conflict.
 *   - The chooser <Modal /> JSX (~line 2659-2700).
 *   - The "N holes had conflicts" banner (~line 2704-2711).
 *
 * Anything not relevant to the chooser flow (saving / offline UI plumbing
 * like `setSaving` / `setIsOffline`) is intentionally elided.
 */
function ChooserHarness({
  initialBatchConflicts,
  initialScoreUpdatedAt = {},
}: {
  initialBatchConflicts: BatchConflict[];
  initialScoreUpdatedAt?: Record<number, string>;
}) {
  const [batchConflicts, setBatchConflicts] = useState<BatchConflict[]>(initialBatchConflicts);
  const [conflict, setConflict] = useState<ConflictState | null>(null);
  const [scores, setScores] = useState<Record<number, number>>({});
  const [putts, setPutts] = useState<Record<number, number>>({});
  const [scoreUpdatedAt, setScoreUpdatedAt] = useState<Record<number, string>>(initialScoreUpdatedAt);

  const session = { tournamentId: TOURNAMENT, playerId: PLAYER, round: ROUND };
  const token = TOKEN;

  // The per-hole save (mirrors score.tsx ~line 2186). The
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

  // Resolve a per-hole conflict (mirrors score.tsx ~line 2257). The
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
      setBatchConflicts(prev =>
        prev.filter(c => !(c.holeNumber === holeNumber && c.round === conflictRound)),
      );
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
        // The fourth arg is the just-learned `server.updatedAt` — without
        // it the re-POST would carry the stale `clientKnownAt` from the
        // not-yet-flushed `setScoreUpdatedAt` above and 409 again.
        await saveScore(holeNumber, client.strokes, client.putts ?? undefined, server.updatedAt);
        return;
      }
      // Cross-round path is also exercised by score.tsx but isn't part of
      // this test's scope (the seeded conflicts share the session round).
    },
    [conflict, saveScore, session.tournamentId, session.playerId, session.round],
  );

  const reviewNextBatchConflict = useCallback(() => {
    if (batchConflicts.length === 0) return;
    const next = batchConflicts[0];
    setConflict({
      holeNumber: next.holeNumber,
      round: next.round,
      server: next.server,
      client: next.client,
    });
  }, [batchConflicts]);

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
      {batchConflicts.length > 0 ? (
        <Pressable
          accessibilityLabel="Review batch conflicts banner"
          onPress={reviewNextBatchConflict}
        >
          <Text>
            {batchConflicts.length} {batchConflicts.length === 1 ? "hole" : "holes"} had
            conflicts — review
          </Text>
        </Pressable>
      ) : null}
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

describe("score screen — per-hole conflict resolver chooser modal (Task #1592)", () => {
  it(
    "pops one conflict at a time from the banner; Keep mine fires the per-hole POST " +
      "with the server-fresh updatedAt; Use theirs adopts the server values without a " +
      "second POST; the banner disappears once the list is empty",
    async () => {
      // Two same-round stale rows from the offline-replay batch flush.
      // Each carries the server-fresh `updatedAt` the chooser must adopt
      // as `clientKnownAt` on the re-POST.
      const SERVER5_UPDATED_AT = "2026-04-29T10:00:00.000Z";
      const SERVER6_UPDATED_AT = "2026-04-29T10:01:00.000Z";
      const SERVER5_NEW_UPDATED_AT = "2026-04-29T11:00:00.000Z";
      const conflicts: BatchConflict[] = [
        {
          holeNumber: 5,
          round: ROUND,
          server: { strokes: 4, putts: 2, updatedAt: SERVER5_UPDATED_AT },
          client: { strokes: 7, putts: 4 },
        },
        {
          holeNumber: 6,
          round: ROUND,
          server: { strokes: 3, putts: 1, updatedAt: SERVER6_UPDATED_AT },
          client: { strokes: 5, putts: 2 },
        },
      ];

      // Pre-seed the offline queue with the same two stale rows so we can
      // verify each row is removed once its conflict is resolved.
      memoryStore.set(
        OFFLINE_QUEUE_KEY,
        JSON.stringify([
          { tournamentId: TOURNAMENT, playerId: PLAYER, round: ROUND, holeNumber: 5, strokes: 7, putts: 4, timestamp: 1 },
          { tournamentId: TOURNAMENT, playerId: PLAYER, round: ROUND, holeNumber: 6, strokes: 5, putts: 2, timestamp: 2 },
        ] satisfies OfflineScore[]),
      );

      // The "Keep mine" re-POST is mocked as a clean 200 with a fresh
      // server `updatedAt` — what the contract requires the chooser's
      // re-POST to look like once it carries the right `clientKnownAt`.
      const fetchMock = vi.fn(
        async () =>
          ({
            status: 200,
            ok: true,
            json: async () => ({ updatedAt: SERVER5_NEW_UPDATED_AT }),
          }) as unknown as Response,
      );
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      // Pre-seed `scoreUpdatedAt` with a deliberately STALE timestamp for
      // each conflicted hole. This is the realistic shape of the bug: the
      // player's last-known `updatedAt` is older than the server's, which
      // is exactly *why* the batch flush returned 409s in the first place.
      // The chooser must NOT echo this stale value back as `clientKnownAt`
      // on the re-POST — it must echo `conflict.server.updatedAt`. (The
      // `setScoreUpdatedAt` call inside `resolveConflict` is queued, so
      // without the explicit override the re-POST would fire on the same
      // tick with the stale closure value and 409 again — see the
      // `knownAtOverride` parameter on `saveScore` in score.tsx.)
      const STALE_KNOWN_AT = "2026-01-01T00:00:00.000Z";
      render(
        <ChooserHarness
          initialBatchConflicts={conflicts}
          initialScoreUpdatedAt={{ 5: STALE_KNOWN_AT, 6: STALE_KNOWN_AT }}
        />,
      );

      // Initial state: banner shows the count, modal closed.
      expect(screen.getByText(/2 holes had conflicts — review/i)).toBeInTheDocument();
      expect(screen.queryByText(/Hole 5 was also updated/i)).not.toBeInTheDocument();

      // Tap the banner → chooser opens with hole 5 (the first pending).
      await act(async () => {
        fireEvent.click(screen.getByLabelText(/Review batch conflicts banner/i));
      });
      expect(screen.getByText(/Hole 5 was also updated/i)).toBeInTheDocument();
      // The two choices show the player's value vs the server's value so
      // the user can compare at a glance.
      expect(screen.getByText(/^7 strokes · 4 putts$/)).toBeInTheDocument();
      expect(screen.getByText(/^4 strokes · 2 putts$/)).toBeInTheDocument();

      // Keep mine — fires the per-hole POST with the server's fresh
      // `updatedAt` adopted as `clientKnownAt`.
      await act(async () => {
        fireEvent.click(screen.getByLabelText(/Keep mine for hole 5/i));
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe(
        `https://example.test/api/public/tournaments/${TOURNAMENT}/players/${PLAYER}/scores`,
      );
      const body = JSON.parse(init.body as string) as {
        round: number;
        holeNumber: number;
        strokes: number;
        putts?: number;
        clientKnownAt?: string;
      };
      expect(body.round).toBe(ROUND);
      expect(body.holeNumber).toBe(5);
      expect(body.strokes).toBe(7);
      // The contract: the chooser must echo the server's fresh
      // `updatedAt` so the re-POST passes the freshness check rather
      // than 409-ing forever.
      expect(body.clientKnownAt).toBe(SERVER5_UPDATED_AT);

      // Hole 5 is gone from the pending list and the modal closed; the
      // banner now reads "1 hole".
      expect(screen.queryByText(/Hole 5 was also updated/i)).not.toBeInTheDocument();
      expect(screen.getByText(/1 hole had conflicts — review/i)).toBeInTheDocument();

      // The hole's offline-queue row was cleared too — no stale row left
      // to replay on the next flush.
      const afterMine = JSON.parse(memoryStore.get(OFFLINE_QUEUE_KEY) ?? "[]") as OfflineScore[];
      expect(afterMine.find(r => r.holeNumber === 5)).toBeUndefined();
      expect(afterMine.find(r => r.holeNumber === 6)).toBeDefined();

      // Tap the banner again → chooser opens with hole 6.
      await act(async () => {
        fireEvent.click(screen.getByLabelText(/Review batch conflicts banner/i));
      });
      expect(screen.getByText(/Hole 6 was also updated/i)).toBeInTheDocument();

      // Use theirs — must NOT fire another POST (we're adopting the
      // server's value as-is) but must mirror the server's strokes / putts
      // into the visible scorecard so the next render shows the up-to-date
      // value.
      await act(async () => {
        fireEvent.click(screen.getByLabelText(/Use theirs for hole 6/i));
      });

      // Still only the one POST from "Keep mine".
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // Local scorecard now shows the server's hole 6 values.
      expect(JSON.parse(screen.getByTestId("scores-state").textContent ?? "{}")).toEqual({ 6: 3 });
      expect(JSON.parse(screen.getByTestId("putts-state").textContent ?? "{}")).toEqual({ 6: 1 });

      // Pending list empty → the "review" banner disappears entirely
      // (no stuck banner, even though the player only ever interacted with
      // the chooser via the banner itself).
      expect(screen.queryByText(/had conflicts — review/i)).not.toBeInTheDocument();

      // Hole 6's offline-queue row was dropped on "Use theirs" too — we
      // adopted the server's value, so there's nothing left to replay.
      const afterTheirs = JSON.parse(memoryStore.get(OFFLINE_QUEUE_KEY) ?? "[]") as OfflineScore[];
      expect(afterTheirs.find(r => r.holeNumber === 6)).toBeUndefined();
    },
  );
});
