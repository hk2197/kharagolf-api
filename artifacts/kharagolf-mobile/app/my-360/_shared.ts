import { useEffect, useState, useCallback } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";

export const BASE_URL = process.env.EXPO_PUBLIC_DOMAIN
  ? `https://${process.env.EXPO_PUBLIC_DOMAIN}`
  : "";

export type ActingCtx = { actingMemberId: number | null };

export function actingQs(ctx: ActingCtx): string {
  return ctx.actingMemberId ? `?actingMemberId=${ctx.actingMemberId}` : "";
}

export async function authedFetch<T = unknown>(
  path: string,
  token: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`${res.status}: ${txt || res.statusText}`);
  }
  return res.json() as Promise<T>;
}

/** Persisted family-context selection. Lives in AsyncStorage so it survives
 * cold starts; mirrored in memory for synchronous reads. Cleared on logout. */
const ACTING_STORAGE_KEY = "kharagolf_acting_member_id";
let _actingMemberId: number | null = null;
let _hydrated = false;
const listeners = new Set<(id: number | null) => void>();

function notify(id: number | null) {
  for (const l of listeners) l(id);
}

async function hydrateActingMemberId(): Promise<void> {
  if (_hydrated) return;
  _hydrated = true;
  try {
    const raw = await AsyncStorage.getItem(ACTING_STORAGE_KEY);
    if (raw == null) return;
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) {
      _actingMemberId = parsed;
      notify(_actingMemberId);
    }
  } catch {
    /* ignore — selection just won't survive this session */
  }
}

export function getActingMemberId(): number | null { return _actingMemberId; }

export function setActingMemberId(id: number | null): void {
  _actingMemberId = id;
  notify(id);
  // Fire-and-forget persistence
  (async () => {
    try {
      if (id == null) {
        await AsyncStorage.removeItem(ACTING_STORAGE_KEY);
      } else {
        await AsyncStorage.setItem(ACTING_STORAGE_KEY, String(id));
      }
    } catch {
      /* ignore persistence failures */
    }
  })();
}

/** Clear the acting-as selection from memory and storage. Call on logout. */
export async function clearActingMemberId(): Promise<void> {
  _actingMemberId = null;
  notify(null);
  try {
    await AsyncStorage.removeItem(ACTING_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

export function useActingMemberId(): [number | null, (id: number | null) => void] {
  const [id, setId] = useState<number | null>(_actingMemberId);
  useEffect(() => {
    const l = (next: number | null) => setId(next);
    listeners.add(l);
    // Hydrate on first mount; the listener will pick up the value if it loads.
    void hydrateActingMemberId();
    return () => { listeners.delete(l); };
  }, []);
  const setter = useCallback((next: number | null) => setActingMemberId(next), []);
  return [id, setter];
}
