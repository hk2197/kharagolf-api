/**
 * Pre-auth brand mark — Task #1756.
 *
 * Renders the active club's saved logo + name on the login, register
 * and forgot-password pages when one can be resolved from the URL or
 * an explicit `orgId`. Falls back to the default `<KharaGolfBrand />`
 * mark when no club is in scope or the club hasn't customised its
 * theme — so the unbranded KHARAGOLF wordmark behaviour is preserved
 * for the default `kharagolf.com` login flow.
 *
 * Mirrors the portal-nav rendering rule from Task #1438:
 *   - the org logo is rendered at a comparable visual weight to the
 *     KHARAGOLF wordmark it replaces, and
 *   - the org name is shown beneath the logo so the player can verify
 *     they're on the right club's branded page before typing their
 *     password.
 *
 * Also hands the resolved branding to `useOrgTheme` so the page picks
 * up the club's primary colour / favicon, matching the post-auth
 * portal experience.
 */
import { KharaGolfBrand } from "./kharagolf-brand";
import { useOrgTheme } from "@/lib/theme/useOrgTheme";
import { usePreAuthOrgBranding } from "@/lib/theme/usePreAuthOrgBranding";

interface PreAuthBrandProps {
  size?: "sm" | "md" | "lg" | "xl";
  tagline?: string;
  /** Explicit org id — see usePreAuthOrgBranding. */
  orgId?: number | null;
  className?: string;
}

const SIZE_LOGO: Record<string, string> = {
  sm: "w-8 h-8",
  md: "w-12 h-12",
  lg: "w-16 h-16",
  xl: "w-24 h-24",
};
const SIZE_TEXT: Record<string, string> = {
  sm: "text-sm",
  md: "text-base",
  lg: "text-lg",
  xl: "text-xl",
};

export function PreAuthBrand({
  size = "lg",
  tagline,
  orgId,
  className = "",
}: PreAuthBrandProps) {
  const result = usePreAuthOrgBranding({ orgId: orgId ?? null });
  // Apply primary colour / favicon overrides too so the rest of the
  // page (form button, link colour, browser tab) match the org's
  // theme — same effect the post-auth portal already gets.
  useOrgTheme(result?.branding ?? null);

  if (result && result.logoUrl) {
    return (
      <div
        className={`flex flex-col items-center ${className}`}
        data-testid="preauth-brand-org"
      >
        <img
          src={result.logoUrl}
          alt={result.name ? `${result.name} logo` : "Club logo"}
          className={`${SIZE_LOGO[size]} object-contain mb-3 drop-shadow-lg`}
          data-testid="preauth-brand-org-logo"
        />
        {result.name && (
          <h1
            className={`font-display font-black tracking-widest uppercase leading-none text-white ${SIZE_TEXT[size]}`}
            data-testid="preauth-brand-org-name"
          >
            {result.name}
          </h1>
        )}
      </div>
    );
  }

  return (
    <div data-testid="preauth-brand-default" className={className}>
      <KharaGolfBrand size={size} tagline={tagline} showTagline={!!tagline} />
    </div>
  );
}
