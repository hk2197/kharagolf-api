/**
 * Task #438 — Custom-domain context.
 *
 * Visiting `https://customdomain.com/` should land on that club's
 * marketing mini-site rather than the generic KHARAGOLF homepage. We
 * detect this by asking the API server whether the current Host is
 * mapped to an active organisation. The result is cached in a context
 * so child pages (notably the mini-site renderer) can reuse the
 * already-fetched payload and the canonical URL.
 */
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export interface CustomDomainSiteState {
  loading: boolean;
  /** Slug of the club mapped to the current host (if any). */
  slug: string | null;
  /** The custom domain hostname returned by the API (lowercased). */
  customDomain: string | null;
  /** Pre-fetched payload — saves the mini-site a round-trip. */
  prefetched: unknown | null;
}

const CustomDomainContext = createContext<CustomDomainSiteState>({
  loading: true,
  slug: null,
  customDomain: null,
  prefetched: null,
});

const KHARAGOLF_HOSTS = new Set([
  "kharagolf.com",
  "www.kharagolf.com",
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
]);

/**
 * Skip the host lookup for hostnames we know belong to KHARAGOLF
 * itself or local/dev preview environments. This avoids a needless
 * round-trip on the canonical marketing site.
 */
function shouldSkipLookup(hostname: string): boolean {
  if (KHARAGOLF_HOSTS.has(hostname)) return true;
  if (hostname.endsWith(".kharagolf.com")) return true;
  // Replit preview domains and other dev hosts.
  if (hostname.endsWith(".replit.dev")) return true;
  if (hostname.endsWith(".repl.co")) return true;
  if (hostname.endsWith(".loca.lt")) return true;
  return false;
}

export function CustomDomainProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<CustomDomainSiteState>({
    loading: true,
    slug: null,
    customDomain: null,
    prefetched: null,
  });

  useEffect(() => {
    if (typeof window === "undefined") {
      setState(s => ({ ...s, loading: false }));
      return;
    }
    const hostname = window.location.hostname.toLowerCase();
    if (shouldSkipLookup(hostname)) {
      setState({ loading: false, slug: null, customDomain: null, prefetched: null });
      return;
    }

    let cancelled = false;
    fetch(`/api/public/clubs/by-host/site`, { headers: { Accept: "application/json" } })
      .then(async r => {
        if (!r.ok) return null;
        return r.json();
      })
      .then((payload: { organization?: { slug?: string; customDomain?: string | null } } | null) => {
        if (cancelled) return;
        const slug = payload?.organization?.slug ?? null;
        const customDomain = payload?.organization?.customDomain?.toLowerCase() ?? null;
        setState({ loading: false, slug, customDomain, prefetched: slug ? payload : null });
      })
      .catch(() => {
        if (!cancelled) setState({ loading: false, slug: null, customDomain: null, prefetched: null });
      });
    return () => { cancelled = true; };
  }, []);

  const value = useMemo(() => state, [state]);
  return <CustomDomainContext.Provider value={value}>{children}</CustomDomainContext.Provider>;
}

export function useCustomDomainSite(): CustomDomainSiteState {
  return useContext(CustomDomainContext);
}
