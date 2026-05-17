import { useCallback, useEffect, useRef, useState } from "react";
import type { FlatList } from "react-native";

const FLASH_DURATION_MS = 2400;

/**
 * Parses a numeric query param value. Expo router params can be string |
 * string[] | undefined; we want a single number or null.
 */
export function parseIdParam(raw: string | string[] | undefined): number | null {
  if (raw == null) return null;
  const v = Array.isArray(raw) ? raw[0] : raw;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Tracks a deep-link highlight id from a query param. The id stays "active"
 * for ~2.4s so a row can flash, then is cleared so subsequent re-renders
 * don't keep flashing it.
 *
 * Returns the active highlight id (or null) plus a manual `clear()` helper
 * that callers can invoke once they've consumed it (e.g. after scroll).
 */
export function useHighlightFlash(rawParam: string | string[] | undefined): {
  highlightId: number | null;
  clear: () => void;
} {
  const initial = parseIdParam(rawParam);
  const [highlightId, setHighlightId] = useState<number | null>(initial);
  const lastSeenRef = useRef<number | null>(initial);

  useEffect(() => {
    const next = parseIdParam(rawParam);
    if (next !== lastSeenRef.current) {
      lastSeenRef.current = next;
      setHighlightId(next);
    }
  }, [rawParam]);

  useEffect(() => {
    if (highlightId == null) return;
    const timer = setTimeout(() => setHighlightId(null), FLASH_DURATION_MS);
    return () => clearTimeout(timer);
  }, [highlightId]);

  const clear = useCallback(() => setHighlightId(null), []);
  return { highlightId, clear };
}

/**
 * Scrolls a FlatList to the row matching `highlightId` once data is loaded.
 * Used by my-bookings tabs that present items in a FlatList.
 */
export function useScrollToHighlight<T>(
  listRef: React.RefObject<FlatList<T> | null>,
  data: T[] | null | undefined,
  highlightId: number | null,
  getId: (item: T) => number,
) {
  const scrolledForRef = useRef<number | null>(null);
  useEffect(() => {
    if (highlightId == null || !data || data.length === 0) return;
    if (scrolledForRef.current === highlightId) return;
    const idx = data.findIndex(item => getId(item) === highlightId);
    if (idx < 0) return;
    scrolledForRef.current = highlightId;
    // Defer to next frame so FlatList has measured.
    requestAnimationFrame(() => {
      try {
        listRef.current?.scrollToIndex({ index: idx, animated: true, viewPosition: 0.3 });
      } catch {
        // FlatList may throw on first render before layout — ignore.
      }
    });
  }, [data, highlightId, getId, listRef]);
}
