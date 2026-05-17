/**
 * Pre-auth org-branding resolver — Task #1756.
 *
 * The login / register / forgot-password pages render before the player
 * has a session, so the existing `OrgThemeProvider` (which keys off
 * `useGetMe()` / `useActiveOrgId()`) has nothing to look up. This hook
 * provides a small, dedicated lookup path so those pages can still show
 * the correct club's mark when the player arrived from a club-branded
 * email or the club's vanity domain.
 *
 * Org resolution order:
 *   1. Explicit `orgId` prop — used by pages that already know which org
 *      they belong to (e.g. `/register/:orgId/:tournamentId`). Hits the
 *      public `/api/public/orgs/by-id/:orgId/branding` endpoint, which
 *      mirrors the by-slug endpoint and applies the same legacy
 *      `organizations.logoUrl` fallback.
 *   2. `?org=<slug>` query string — the canonical pre-auth selector
 *      (transactional emails append it to all CTAs).
 *   3. Subdomain heuristic — first hostname label when the host has
 *      three+ labels and isn't an obvious platform / proxy host
 *      (`localhost`, IPs, `replit.dev`, `replit.app`, leading
 *      `www`/`app`/`portal`).
 *
 * Returns `null` when no slug / orgId could be resolved or the club
 * has no logo on file — callers must fall back to the KHARAGOLF
 * default mark in that case.
 */
import { useEffect, useState } from "react";
import type { OrgBranding } from "./useOrgTheme";

export interface PreAuthBrandingResult {
  /** Public-facing club display name, e.g. "Pine Valley Golf Club". */
  name: string;
  /** Club logo URL — already validated server-side as a public URL. */
  logoUrl: string | null;
  branding: OrgBranding;
}

/** Hosts where the first label is never a club slug. */
const SKIP_FIRST_LABELS = new Set(["www", "app", "portal", "admin", "api"]);

function isLikelyPlatformHost(hostname: string): boolean {
  if (!hostname) return true;
  if (hostname === "localhost" || hostname === "0.0.0.0") return true;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) return true; // IPv4
  if (hostname.includes("[") || hostname.includes(":")) return true; // IPv6
  // Replit preview / deploy hosts — never treat the long random label as
  // a club slug.
  if (hostname.endsWith(".replit.dev") || hostname.endsWith(".replit.app") ||
      hostname.endsWith(".repl.co")) return true;
  return false;
}

export function detectOrgSlugFromUrl(): string | null {
  if (typeof window === "undefined") return null;
  // 1. ?org=<slug>
  try {
    const queryOrg = new URLSearchParams(window.location.search).get("org");
    if (queryOrg && /^[a-zA-Z0-9_-]{1,64}$/.test(queryOrg.trim())) {
      return queryOrg.trim().toLowerCase();
    }
  } catch {
    // ignore — fall through to subdomain detection
  }
  // 2. subdomain heuristic
  const hostname = window.location.hostname || "";
  if (isLikelyPlatformHost(hostname)) return null;
  const labels = hostname.split(".");
  if (labels.length < 3) return null;
  const first = labels[0]?.toLowerCase() ?? "";
  if (!first || SKIP_FIRST_LABELS.has(first)) return null;
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(first)) return null;
  return first;
}

interface PublicBrandingResponse {
  branding: {
    organizationId: number;
    slug: string;
    name: string;
    logoUrl: string | null;
    faviconUrl: string | null;
    primaryColor: string | null;
  } | null;
}

async function fetchPublicBranding(url: string): Promise<PreAuthBrandingResult | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = (await res.json()) as PublicBrandingResponse;
    const b = data?.branding;
    if (!b || !b.logoUrl) return null;
    const branding: OrgBranding = {
      primaryColor: b.primaryColor,
      accentColor: null,
      fontFamily: null,
      logoUrl: b.logoUrl,
      faviconUrl: b.faviconUrl,
    };
    return { name: b.name, logoUrl: b.logoUrl, branding };
  } catch {
    return null;
  }
}

async function fetchBrandingByOrgId(orgId: number): Promise<PreAuthBrandingResult | null> {
  return fetchPublicBranding(`/api/public/orgs/by-id/${encodeURIComponent(String(orgId))}/branding`);
}

async function fetchBrandingBySlug(slug: string): Promise<PreAuthBrandingResult | null> {
  return fetchPublicBranding(`/api/public/orgs/by-slug/${encodeURIComponent(slug)}/branding`);
}

export interface UsePreAuthOrgBrandingOptions {
  /**
   * Explicit org id — when provided, the slug / subdomain heuristics
   * are skipped and the org's theming row is fetched directly. Used
   * by `/register/:orgId/:tournamentId` once the tournament has
   * loaded so the brand mark switches in without depending on the
   * caller's URL shape.
   */
  orgId?: number | null;
}

export function usePreAuthOrgBranding(
  options: UsePreAuthOrgBrandingOptions = {},
): PreAuthBrandingResult | null {
  const { orgId } = options;
  const [result, setResult] = useState<PreAuthBrandingResult | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function run() {
      // Explicit org id wins over URL-derived signals.
      if (typeof orgId === "number" && Number.isFinite(orgId)) {
        const r = await fetchBrandingByOrgId(orgId);
        if (!cancelled) setResult(r);
        return;
      }
      const slug = detectOrgSlugFromUrl();
      if (!slug) { if (!cancelled) setResult(null); return; }
      const r = await fetchBrandingBySlug(slug);
      if (!cancelled) setResult(r);
    }
    void run();
    return () => { cancelled = true; };
  }, [orgId]);

  return result;
}
