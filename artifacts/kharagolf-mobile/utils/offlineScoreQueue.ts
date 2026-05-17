/**
 * Offline score queue helpers — extracted from app/(tabs)/score.tsx so the
 * batch-flush conflict handling can be unit-tested in isolation. The mobile
 * scoring screen still owns the user-facing flow; this module just packages
 * the AsyncStorage <-> server batch-endpoint plumbing.
 *
 * Wave 1 W1-B contract: the batch endpoint may answer with HTTP 409 and a
 * per-row `conflicts` array. We treat 409 as a partial success — server-
 * accepted rows are removed from AsyncStorage, conflicted rows stay queued
 * so the chooser modal can resolve them, and the conflict list bubbles up
 * to the caller.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";

import { BASE_URL } from "@/utils/api";

export const OFFLINE_QUEUE_KEY = "kharagolf_offline_score_queue";

export interface OfflineScore {
  tournamentId: number;
  playerId: number;
  round: number;
  holeNumber: number;
  strokes: number;
  putts?: number | null;
  timestamp: number;
  // Last server `updatedAt` the phone saw for this hole. Sent back as
  // `clientKnownAt` on the batch flush so the server can detect another
  // device wrote a newer value while we were offline and return a 409.
  clientKnownAt?: string;
}

export interface BatchConflict {
  holeNumber: number;
  round: number;
  server: { strokes: number; putts: number | null; updatedAt: string };
  client: { strokes: number; putts: number | null };
}

export interface FlushResult {
  synced: number;
  conflicts: BatchConflict[];
}

/**
 * Merge new flush conflicts into the pending-review list, dedupe by
 * (round, holeNumber). Newer entries replace older ones for the same hole.
 */
export function mergeBatchConflicts(prev: BatchConflict[], next: BatchConflict[]): BatchConflict[] {
  const out = [...prev];
  for (const n of next) {
    const idx = out.findIndex(c => c.holeNumber === n.holeNumber && c.round === n.round);
    if (idx >= 0) out[idx] = n; else out.push(n);
  }
  return out;
}

export async function enqueueScore(entry: OfflineScore) {
  const raw = await AsyncStorage.getItem(OFFLINE_QUEUE_KEY);
  const queue: OfflineScore[] = raw ? JSON.parse(raw) : [];
  const idx = queue.findIndex(q => q.tournamentId === entry.tournamentId && q.playerId === entry.playerId && q.round === entry.round && q.holeNumber === entry.holeNumber);
  if (idx >= 0) queue[idx] = entry; else queue.push(entry);
  await AsyncStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(queue));
}

export async function flushOfflineQueue(tournamentId: number, playerId: number, token?: string): Promise<FlushResult> {
  const raw = await AsyncStorage.getItem(OFFLINE_QUEUE_KEY);
  if (!raw) return { synced: 0, conflicts: [] };
  const queue: OfflineScore[] = JSON.parse(raw);
  const mine = queue.filter(q => q.tournamentId === tournamentId && q.playerId === playerId);
  if (mine.length === 0) return { synced: 0, conflicts: [] };
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const resp = await fetch(`${BASE_URL}/api/public/tournaments/${tournamentId}/players/${playerId}/scores/batch`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        scores: mine.map(q => {
          const item: { round: number; holeNumber: number; strokes: number; putts?: number | null; clientKnownAt?: string } =
            { round: q.round, holeNumber: q.holeNumber, strokes: q.strokes };
          if (q.putts !== undefined) item.putts = q.putts;
          if (q.clientKnownAt) item.clientKnownAt = q.clientKnownAt;
          return item;
        }),
      }),
    });
    // Both 200 and 409 are flush "successes" from the queue's perspective:
    // rows the server accepted are removed; conflicted rows stay in the queue
    // so the player can resolve them via the chooser modal (which re-fires
    // the per-hole save with the server's newer `updatedAt`).
    if (resp.status !== 200 && resp.status !== 409) {
      return { synced: 0, conflicts: [] };
    }
    const payload = await resp.json().catch(() => ({})) as {
      synced?: number;
      conflicts?: Array<{
        holeNumber: number;
        round: number;
        server: { strokes: number; putts: number | null; updatedAt: string };
        client: { strokes: number; putts: number | null };
      }>;
    };
    const conflicts: BatchConflict[] = (payload.conflicts ?? []).map(c => ({
      holeNumber: c.holeNumber,
      round: c.round,
      server: {
        strokes: c.server.strokes,
        putts: c.server.putts ?? null,
        updatedAt: c.server.updatedAt ?? new Date().toISOString(),
      },
      client: { strokes: c.client.strokes, putts: c.client.putts ?? null },
    }));
    // Drop everything that wasn't conflicted; keep conflicted rows so the
    // user-visible resolver can address them without losing the local entry.
    const isConflicted = (q: OfflineScore) =>
      conflicts.some(c => c.holeNumber === q.holeNumber && c.round === q.round);
    const remaining = queue.filter(q => {
      if (q.tournamentId !== tournamentId || q.playerId !== playerId) return true;
      return isConflicted(q);
    });
    await AsyncStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(remaining));
    return { synced: payload.synced ?? (mine.length - conflicts.length), conflicts };
  } catch {
    return { synced: 0, conflicts: [] };
  }
}
