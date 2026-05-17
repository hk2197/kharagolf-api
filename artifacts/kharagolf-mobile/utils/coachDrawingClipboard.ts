/**
 * Task #2130 — per-coach persistence for the mobile "Copy / Paste drawings"
 * clipboard introduced in Task #1712. The clipboard previously lived in
 * React state on the Coach Workspace tab and was wiped the moment the
 * coach relaunched the app or switched tabs (the deliver modal unmounts).
 *
 * Storage strategy:
 *   - Mobile uses AsyncStorage keyed by the player's user id so a shared
 *     phone never surfaces one coach's callout pattern to another.
 *   - We persist whatever shape payload the caller hands us; reads only
 *     validate it as a JSON array so a corrupted entry returns `[]`
 *     instead of throwing inside the workspace's render path.
 *   - Saving an empty array removes the key — that lets the explicit
 *     `clear()` helper used by `useAuth().logout` scrub the persisted
 *     entry without leaving an empty placeholder behind.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";

const KEY_PREFIX = "kharagolf:coachDrawingClipboard:";

function keyFor(coachId: number | string): string {
  return `${KEY_PREFIX}${coachId}`;
}

export async function loadCoachDrawingClipboard<T = unknown>(
  coachId: number | string,
): Promise<T[]> {
  try {
    const raw = await AsyncStorage.getItem(keyFor(coachId));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

export async function saveCoachDrawingClipboard<T>(
  coachId: number | string,
  shapes: readonly T[],
): Promise<void> {
  try {
    if (!shapes || shapes.length === 0) {
      await AsyncStorage.removeItem(keyFor(coachId));
      return;
    }
    await AsyncStorage.setItem(keyFor(coachId), JSON.stringify(shapes));
  } catch {
    // Best-effort.
  }
}

export async function clearCoachDrawingClipboard(coachId: number | string): Promise<void> {
  try {
    await AsyncStorage.removeItem(keyFor(coachId));
  } catch {
    // Best-effort.
  }
}

/**
 * Wipe every persisted coach clipboard on this device. Wired to the
 * AuthProvider's `logout` callback so a shared phone does not leave one
 * coach's callout pattern on disk for the next coach who logs in.
 */
export async function clearAllCoachDrawingClipboards(): Promise<void> {
  try {
    const keys = await AsyncStorage.getAllKeys();
    const matches = keys.filter(k => k.startsWith(KEY_PREFIX));
    if (matches.length > 0) {
      await AsyncStorage.multiRemove(matches);
    }
  } catch {
    // Best-effort.
  }
}
