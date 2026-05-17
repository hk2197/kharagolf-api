/**
 * Persists the AI Caddie chat transcript per-player.
 *
 * Source of truth is the backend (`/api/portal/caddie/history`) so a player
 * who signs in on a second phone, tablet, or the web portal sees the same
 * conversation (Task #843). AsyncStorage is kept as an offline mirror so
 * the screen still loads when the network is unreachable, and falls back
 * cleanly when a remote fetch fails.
 *
 * Cross-device concurrency (Task #989): the server stamps each saved row
 * with a monotonically increasing `version`. Every PUT echoes back the
 * version we last loaded as `baseVersion`; the server rejects stale writes
 * with HTTP 409 and returns its current state so we can merge by message
 * id and retry. Without this, a player using two devices at once could
 * lose recent turns when the second device PUT its older snapshot.
 *
 * Capped to a sensible number of turns to keep payloads small.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import { BASE_URL, deletePortal, fetchPortal } from "@/utils/api";

export type CaddieChatRole = "user" | "assistant";

export interface PersistedCaddieMessage {
  id: string;
  role: CaddieChatRole;
  content: string;
  context?: { shots: number; rounds: number; mode?: "shots" | "rounds"; totalTrackedShots?: number };
  error?: string;
}

export const CADDIE_HISTORY_MAX_MESSAGES = 50;

const KEY_PREFIX = "kharagolf_caddie_history_v1:";
const VERSION_KEY_PREFIX = "kharagolf_caddie_history_v1_version:";

function keyFor(userId: number | string): string {
  return `${KEY_PREFIX}${userId}`;
}

function versionKeyFor(userId: number | string): string {
  return `${VERSION_KEY_PREFIX}${userId}`;
}

function sanitize(input: unknown): PersistedCaddieMessage[] {
  if (!Array.isArray(input)) return [];
  return input.filter(
    (m): m is PersistedCaddieMessage =>
      m && typeof m === "object" &&
      (m.role === "user" || m.role === "assistant") &&
      typeof m.content === "string" &&
      typeof m.id === "string",
  );
}

async function readLocal(userId: number | string): Promise<PersistedCaddieMessage[]> {
  try {
    const raw = await AsyncStorage.getItem(keyFor(userId));
    if (!raw) return [];
    return sanitize(JSON.parse(raw));
  } catch {
    return [];
  }
}

async function writeLocal(
  userId: number | string,
  messages: PersistedCaddieMessage[],
): Promise<void> {
  try {
    await AsyncStorage.setItem(keyFor(userId), JSON.stringify(messages));
  } catch {
    // Best-effort.
  }
}

async function readLocalVersion(userId: number | string): Promise<number> {
  try {
    const raw = await AsyncStorage.getItem(versionKeyFor(userId));
    if (!raw) return 0;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

async function writeLocalVersion(userId: number | string, version: number): Promise<void> {
  try {
    await AsyncStorage.setItem(versionKeyFor(userId), String(Math.max(0, Math.floor(version))));
  } catch {
    // Best-effort.
  }
}

/**
 * Merge a server-side transcript with locally-pending turns by message id.
 * Server messages come first (they include any turns from the other device);
 * any local-only messages — typically the most recent turns this device just
 * appended — are appended after, preserving their relative order. Capped to
 * the last N turns.
 */
function mergeByMessageId(
  serverMessages: PersistedCaddieMessage[],
  localMessages: PersistedCaddieMessage[],
): PersistedCaddieMessage[] {
  const serverIds = new Set(serverMessages.map(m => m.id));
  const merged = [...serverMessages];
  for (const m of localMessages) {
    if (!serverIds.has(m.id)) merged.push(m);
  }
  return merged.slice(-CADDIE_HISTORY_MAX_MESSAGES);
}

/**
 * Load the player's transcript. Tries the server first so the conversation
 * follows the player across devices; falls back to the AsyncStorage mirror
 * when offline or on any remote error.
 */
export async function loadCaddieHistory(
  userId: number | string,
  token?: string | null,
): Promise<PersistedCaddieMessage[]> {
  if (token) {
    try {
      const remote = await fetchPortal<{ messages: unknown; version?: unknown }>("/caddie/history", token);
      const messages = sanitize(remote?.messages).slice(-CADDIE_HISTORY_MAX_MESSAGES);
      const version = typeof remote?.version === "number" && Number.isFinite(remote.version)
        ? Math.max(0, Math.floor(remote.version))
        : 0;
      // Refresh the offline mirror so a later offline open shows the latest state.
      void writeLocal(userId, messages);
      void writeLocalVersion(userId, version);
      return messages;
    } catch {
      // Fall through to local cache (offline / network error / not yet synced).
    }
  }
  return readLocal(userId);
}

interface PutResponse {
  ok?: boolean;
  count?: number;
  updatedAt?: string | null;
  version?: number;
}

interface ConflictResponse {
  current?: {
    messages?: unknown;
    updatedAt?: string | null;
    version?: number;
  };
}

/**
 * Send a PUT with the supplied baseVersion. Returns the parsed body on
 * success, or the conflict payload (with status 409) so the caller can
 * merge and retry. Throws on any other error.
 */
async function putHistory(
  token: string,
  messages: PersistedCaddieMessage[],
  baseVersion: number,
): Promise<{ status: "ok"; body: PutResponse } | { status: "conflict"; body: ConflictResponse } | { status: "error" }> {
  try {
    const res = await fetch(`${BASE_URL}/api/portal/caddie/history`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ messages, baseVersion }),
    });
    if (res.status === 409) {
      const body = await res.json().catch(() => ({})) as ConflictResponse;
      return { status: "conflict", body };
    }
    if (!res.ok) return { status: "error" };
    const body = await res.json().catch(() => ({})) as PutResponse;
    return { status: "ok", body };
  } catch {
    return { status: "error" };
  }
}

/**
 * Persist the transcript locally and (best-effort) to the server.
 * The local write always happens so an offline session is not lost; the
 * remote write uses optimistic concurrency to avoid clobbering turns sent
 * from another device. On a 409 conflict we merge the server's transcript
 * with our locally-pending turns by message id and retry once with the
 * server's new version.
 */
export async function saveCaddieHistory(
  userId: number | string,
  messages: PersistedCaddieMessage[],
  token?: string | null,
): Promise<void> {
  const trimmed = messages.slice(-CADDIE_HISTORY_MAX_MESSAGES);
  await writeLocal(userId, trimmed);
  if (!token) return;

  const baseVersion = await readLocalVersion(userId);
  const first = await putHistory(token, trimmed, baseVersion);

  if (first.status === "ok") {
    if (typeof first.body.version === "number") {
      await writeLocalVersion(userId, first.body.version);
    }
    return;
  }

  if (first.status === "conflict") {
    const serverMessages = sanitize(first.body.current?.messages);
    const serverVersion = typeof first.body.current?.version === "number"
      ? Math.max(0, Math.floor(first.body.current.version))
      : 0;
    const merged = mergeByMessageId(serverMessages, trimmed);
    // Persist the merged transcript locally so the UI reflects whichever
    // turns came in from the other device on the next read.
    await writeLocal(userId, merged);
    await writeLocalVersion(userId, serverVersion);

    const retry = await putHistory(token, merged, serverVersion);
    if (retry.status === "ok" && typeof retry.body.version === "number") {
      await writeLocalVersion(userId, retry.body.version);
    }
    // If the retry also conflicts (yet another concurrent writer) or fails,
    // we leave the merged state in the local mirror; the next save attempt
    // will pick up the latest server version and merge again.
    return;
  }

  // Network / transient failure — local copy will resync on the next save.
}

/**
 * Wipe the transcript everywhere — local cache and (best-effort) server.
 */
export async function clearCaddieHistory(
  userId: number | string,
  token?: string | null,
): Promise<void> {
  try {
    await AsyncStorage.removeItem(keyFor(userId));
    await AsyncStorage.removeItem(versionKeyFor(userId));
  } catch {
    // Best-effort.
  }
  if (token) {
    try {
      await deletePortal("/caddie/history", token);
    } catch {
      // Best-effort: a stale remote copy will be overwritten the next time
      // the player sends a turn (PUT replaces the whole array).
    }
  }
}
