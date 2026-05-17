/**
 * Task #2130 — per-coach persistence for the "Copy / Paste drawings"
 * clipboard introduced in Task #1712. Without this the clipboard lived in
 * React state on the Coach Workspace page and was wiped the moment the
 * coach refreshed the tab or navigated away — exactly the situations a
 * busy coach wants the clipboard to survive.
 *
 * Storage strategy:
 *   - Web uses `localStorage` keyed by the coach's pro id so a shared
 *     device never surfaces one coach's callout pattern to another.
 *   - The shape payload is whatever the caller hands us; we only validate
 *     it as a JSON array on read so a corrupted entry returns `[]` instead
 *     of throwing inside the workspace's render path.
 *   - Saving an empty array removes the key entirely — that lets the
 *     "Clear" path (and the explicit `clear()` helper used by sign-out)
 *     scrub the persisted entry without leaving an empty placeholder.
 */

const KEY_PREFIX = "kharagolf:coachDrawingClipboard:";

function keyFor(coachId: number | string): string {
  return `${KEY_PREFIX}${coachId}`;
}

function getStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function loadCoachDrawingClipboard<T = unknown>(coachId: number | string): T[] {
  const storage = getStorage();
  if (!storage) return [];
  try {
    const raw = storage.getItem(keyFor(coachId));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

export function saveCoachDrawingClipboard<T>(coachId: number | string, shapes: readonly T[]): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    if (!shapes || shapes.length === 0) {
      storage.removeItem(keyFor(coachId));
      return;
    }
    storage.setItem(keyFor(coachId), JSON.stringify(shapes));
  } catch {
    // Best-effort — Safari private mode / quota errors should not break
    // the workspace.
  }
}

export function clearCoachDrawingClipboard(coachId: number | string): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.removeItem(keyFor(coachId));
  } catch {
    // Best-effort.
  }
}

/**
 * Wipe every persisted coach clipboard on this device. Wired to the
 * top-bar sign-out so a shared workstation does not leave one coach's
 * callout pattern on disk for the next coach who logs in.
 */
export function clearAllCoachDrawingClipboards(): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    const keys: string[] = [];
    for (let i = 0; i < storage.length; i += 1) {
      const k = storage.key(i);
      if (k && k.startsWith(KEY_PREFIX)) keys.push(k);
    }
    for (const k of keys) storage.removeItem(k);
  } catch {
    // Best-effort.
  }
}
