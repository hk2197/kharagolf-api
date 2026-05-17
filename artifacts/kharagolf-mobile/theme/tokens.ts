/**
 * Mobile design tokens — Wave 0 / Task #935 W0-4.
 *
 * The single source of truth for color, spacing, radius, and motion on the
 * Expo / React Native app. Mirrors the web token semantics (`primary`,
 * `accent`, `card`, `background`, `border`, `text`, `textSecondary`,
 * `muted`, `error`) so cross-platform components feel identical.
 *
 * Architectural rule (from #935): no hard-coded hex codes anywhere in the
 * mobile app. Always go through `useTheme().tokens`.
 */

export interface ColorTokens {
  background: string;
  surface: string;
  card: string;
  cardHighlight: string;
  border: string;
  primary: string;
  primaryDark: string;
  accent: string;
  text: string;
  textSecondary: string;
  muted: string;
  error: string;
  warning: string;
  success: string;
  info: string;
  // Score-to-par semantic palette (existing convention preserved)
  eagle: string;
  birdie: string;
  par: string;
  bogey: string;
  doubleOrWorse: string;
  // Document / category accents (replaces previously-hardcoded literals)
  categoryRules: string;
  categoryPace: string;
  categoryPolicy: string;
  categoryGeneral: string;
  categoryResults: string;
  categoryNotice: string;
}

export interface SpacingTokens {
  xs: number;
  sm: number;
  md: number;
  lg: number;
  xl: number;
  xxl: number;
}

export interface RadiusTokens {
  sm: number;
  md: number;
  lg: number;
  xl: number;
  pill: number;
}

export interface MotionTokens {
  fast: number;
  base: number;
  slow: number;
}

export interface TypographyTokens {
  fontFamilyBody: string;
  fontFamilyDisplay: string;
  fontWeightRegular: "400";
  fontWeightMedium: "500";
  fontWeightSemibold: "600";
  fontWeightBold: "700";
}

export interface ThemeTokens {
  colors: ColorTokens;
  spacing: SpacingTokens;
  radius: RadiusTokens;
  motion: MotionTokens;
  typography: TypographyTokens;
}

export const DEFAULT_DARK_TOKENS: ThemeTokens = {
  colors: {
    background: "#0b1512",
    surface: "#142019",
    card: "#1a2c22",
    cardHighlight: "#1f3428",
    border: "#243b2e",
    primary: "#22c55e",
    primaryDark: "#16a34a",
    accent: "#f59e0b",
    text: "#ffffff",
    textSecondary: "#94b4a4",
    muted: "#4b7060",
    error: "#ef4444",
    warning: "#f59e0b",
    success: "#22c55e",
    info: "#3b82f6",
    eagle: "#f59e0b",
    birdie: "#ef4444",
    par: "#94b4a4",
    bogey: "#3b82f6",
    doubleOrWorse: "#8b5cf6",
    categoryRules: "#10b981",
    categoryPace: "#3b82f6",
    categoryPolicy: "#8b5cf6",
    categoryGeneral: "#6b7280",
    categoryResults: "#f59e0b",
    categoryNotice: "#f43f5e",
  },
  spacing: { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 },
  radius: { sm: 6, md: 10, lg: 14, xl: 20, pill: 999 },
  motion: { fast: 150, base: 250, slow: 400 },
  typography: {
    fontFamilyBody: "Inter_400Regular",
    fontFamilyDisplay: "Inter_700Bold",
    fontWeightRegular: "400",
    fontWeightMedium: "500",
    fontWeightSemibold: "600",
    fontWeightBold: "700",
  },
};

/**
 * Apply per-club overrides on top of the default token set. Accepts an
 * optional `primaryColor`, `accentColor`, and `fontFamily` coming from
 * `club_theming.*` (Task #1438). The legacy `organizations.primaryColor`
 * /`organizations.accentColor` source still flows through the same shape
 * so older callers keep working.
 */
export function applyOrgOverrides(
  base: ThemeTokens,
  overrides?: { primaryColor?: string | null; accentColor?: string | null; fontFamily?: string | null } | null,
): ThemeTokens {
  if (!overrides?.primaryColor && !overrides?.accentColor && !overrides?.fontFamily) return base;
  // Pick the first font name out of a comma-separated CSS font stack so
  // React Native (which only accepts a single family per `fontFamily`
  // prop) gets a usable value. The full string is kept as a fallback.
  const headlineFont = overrides.fontFamily
    ? overrides.fontFamily.split(",")[0].trim().replace(/^['"]|['"]$/g, "")
    : null;
  return {
    ...base,
    colors: {
      ...base.colors,
      ...(overrides.primaryColor ? { primary: overrides.primaryColor, success: overrides.primaryColor } : {}),
      ...(overrides.accentColor ? { accent: overrides.accentColor } : {}),
    },
    typography: headlineFont ? {
      ...base.typography,
      fontFamilyDisplay: headlineFont,
    } : base.typography,
  };
}
