/**
 * Mobile theme provider — Wave 0 / Task #935 W0-4.
 *
 * Wraps the app with a `ThemeContext` that exposes `tokens` (colors,
 * spacing, radius, motion, typography). The active club's branding from
 * `useActiveClub()` (when present) is applied as overrides on top of the
 * default dark tokens.
 *
 * Migrated screens consume tokens via `useTheme()` instead of importing
 * the legacy `constants/colors` module directly.
 *
 * Task #1438 — also exposes the active org's `logoUrl` so consumers (the
 * player tab nav, profile header, etc.) can render the club's mark
 * instead of the default KHARAGOLF wordmark.
 */
import React, { createContext, useContext, useMemo } from "react";
import { DEFAULT_DARK_TOKENS, applyOrgOverrides, type ThemeTokens } from "./tokens";

export interface ThemeBranding {
  primaryColor?: string | null;
  accentColor?: string | null;
  /** CSS font-family string saved by the club admin. */
  fontFamily?: string | null;
  /** Public URL for the club's logo, surfaced via `useTheme().logoUrl`. */
  logoUrl?: string | null;
  /**
   * Task #1438 — explicit flag from the API's `/theming` response that
   * mirrors `club_theming` row presence. Required so the provider can
   * tell legacy `activeClub` fallback (which we still honour briefly
   * during initial load to avoid a flash) apart from a real saved
   * customisation. Consumers (e.g. the player tab bar) check this to
   * decide whether to use the org accent or the KHARAGOLF default.
   */
  customized?: boolean;
}

interface ThemeContextValue {
  tokens: ThemeTokens;
  /** Active org logo URL (null when the club hasn't uploaded one). */
  logoUrl: string | null;
  /** True when the active org has a customised theme row. */
  customized: boolean;
}

const ThemeContext = createContext<ThemeContextValue>({
  tokens: DEFAULT_DARK_TOKENS,
  logoUrl: null,
  customized: false,
});

export interface ThemeProviderProps {
  /** Optional per-club overrides. Pass `null` (or omit) for default tokens. */
  branding?: ThemeBranding | null;
  children: React.ReactNode;
}

export function ThemeProvider({ branding, children }: ThemeProviderProps) {
  const tokens = useMemo(
    () => applyOrgOverrides(DEFAULT_DARK_TOKENS, branding ?? undefined),
    [branding?.primaryColor, branding?.accentColor, branding?.fontFamily],
  );
  const value = useMemo<ThemeContextValue>(
    () => ({
      tokens,
      logoUrl: branding?.logoUrl ?? null,
      // Source of truth is the explicit `customized` field on the
      // input branding (which the resolver on top of /theming sets
      // from the server's `club_theming` row presence). We do NOT
      // infer it from the presence of colour fields, since legacy
      // `activeClub` fallback during loading carries colours but is
      // not a real saved customisation.
      customized: branding?.customized === true,
    }),
    [tokens, branding?.logoUrl, branding?.customized],
  );
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}
