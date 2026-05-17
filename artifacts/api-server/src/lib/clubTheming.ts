/**
 * Per-club theming resolver — Wave 3 W3-L.
 *
 * Returns merged theme (db row || defaults) for an organization, cached
 * in-process for 60s. Wave 0 design tokens consume this on the client; this
 * helper just centralizes the read path so every consumer gets the same
 * fallback behaviour.
 */

import { sql } from "drizzle-orm";
import { db } from "@workspace/db";

export interface ClubTheme {
  primaryColor: string;
  accentColor: string;
  fontFamily: string;
  logoUrl: string | null;
  faviconUrl: string | null;
  /**
   * `true` when the org has saved its own theme row (Task #1438 — clients
   * use this flag to decide whether to inject overrides at all, so an org
   * with no row keeps the KHARAGOLF defaults declared in the apps' own
   * design tokens instead of being silently re-painted with our internal
   * fallbacks here).
   */
  customized: boolean;
}

const DEFAULT_THEME: Omit<ClubTheme, "customized"> = {
  primaryColor: "#0a7c46",
  accentColor: "#e6b32a",
  fontFamily: "Inter, system-ui, sans-serif",
  logoUrl: null,
  faviconUrl: null,
};

const CACHE_MS = 60_000;
const cache = new Map<number, { value: ClubTheme; expiresAt: number }>();

export async function getClubTheme(orgId: number): Promise<ClubTheme> {
  const now = Date.now();
  const hit = cache.get(orgId);
  if (hit && hit.expiresAt > now) return hit.value;

  const rows = await db.execute(sql`
    SELECT primary_color, accent_color, font_family, logo_url, favicon_url
    FROM club_theming
    WHERE organization_id = ${orgId}
    LIMIT 1
  `);
  const r = rows as unknown as { rows?: Array<Record<string, string | null>> };
  const row = r.rows?.[0];
  const theme: ClubTheme = row ? {
    primaryColor: row.primary_color || DEFAULT_THEME.primaryColor,
    accentColor: row.accent_color || DEFAULT_THEME.accentColor,
    fontFamily: row.font_family || DEFAULT_THEME.fontFamily,
    logoUrl: row.logo_url ?? null,
    faviconUrl: row.favicon_url ?? null,
    customized: true,
  } : { ...DEFAULT_THEME, customized: false };

  cache.set(orgId, { value: theme, expiresAt: now + CACHE_MS });
  return theme;
}

export function invalidateClubThemeCache(orgId: number): void {
  cache.delete(orgId);
}

export function defaultClubTheme(): ClubTheme {
  return { ...DEFAULT_THEME, customized: false };
}

/**
 * Resolves the branding fields used by transactional emails / membership
 * cards / overlays for a given org (Task #1438).
 *
 * Order of preference for `logoUrl` and `primaryColor`:
 *   1. The club_theming row, when the org has saved its own theme
 *      (i.e. `customized === true`). This is what the admin most
 *      recently picked in the club-theming UI, so it should win.
 *   2. The legacy `organizations.logo_url` / `organizations.primary_color`
 *      columns (still populated by older onboarding flows).
 *   3. `undefined` / KHARAGOLF defaults applied downstream.
 *
 * Returns `undefined` for missing values rather than `null` so the
 * mailer's `EmailBranding`-shaped consumers can spread it directly
 * without coercion.
 */
export async function resolveOrgBranding(
  orgId: number,
  fallback?: { name?: string | null; logoUrl?: string | null; primaryColor?: string | null },
): Promise<{ orgName?: string; logoUrl?: string; primaryColor?: string }> {
  const theme = await getClubTheme(orgId).catch(() => null);
  const customized = theme?.customized === true;
  return {
    orgName: fallback?.name ?? undefined,
    logoUrl: (customized ? theme?.logoUrl : null) ?? fallback?.logoUrl ?? undefined,
    primaryColor: (customized ? theme?.primaryColor : null) ?? fallback?.primaryColor ?? undefined,
  };
}
