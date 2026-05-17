import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Reads a numeric ID from the current URL's query string and exposes helpers
 * to scroll/flash the matching row once it appears in the DOM. Used by the
 * "my upcoming" deep-link flow so each detail page can land users directly on
 * their booking and visually surface it.
 */
export function useHighlightFromQuery(paramName: string): {
  highlightId: number | null;
  consume: () => void;
} {
  const [highlightId, setHighlightId] = useState<number | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const raw = new URLSearchParams(window.location.search).get(paramName);
    if (!raw) return;
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) setHighlightId(n);
  }, [paramName]);

  const consume = useCallback(() => {
    setHighlightId(null);
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    if (url.searchParams.has(paramName)) {
      url.searchParams.delete(paramName);
      window.history.replaceState({}, '', url.toString());
    }
  }, [paramName]);

  return { highlightId, consume };
}

/**
 * Attaches a ref that scrolls itself into view and flashes a temporary ring
 * the first time it mounts for the given id. Pair with
 * {@link useHighlightFromQuery} so deep-linked rows visually pulse without
 * the parent page needing extra plumbing.
 */
export function useHighlightTarget<T extends HTMLElement = HTMLElement>(
  active: boolean,
  onConsume: () => void,
): (node: T | null) => void {
  const handledRef = useRef(false);
  return useCallback((node: T | null): void => {
    if (!active || !node || handledRef.current) return;
    handledRef.current = true;
    requestAnimationFrame(() => {
      node.scrollIntoView({ behavior: 'smooth', block: 'center' });
      node.classList.add('booking-highlight-flash');
      window.setTimeout(() => {
        node.classList.remove('booking-highlight-flash');
        onConsume();
      }, 2400);
    });
  }, [active, onConsume]);
}
