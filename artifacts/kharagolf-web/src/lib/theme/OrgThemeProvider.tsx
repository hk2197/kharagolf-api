/**
 * Wave 0 / Task #935 W0-4 — applies the active org's branding (if any)
 * to the global CSS variables, so every shadcn/Tailwind component picks
 * up the override without per-component plumbing.
 *
 * Task #1438 — extended to fetch the full theme record (primary/accent
 * colors, font family, logo and favicon URLs) from
 * `/api/organizations/:orgId/theming` and to expose the branding via a
 * React context so components like the portal nav can render the org's
 * logo. We only inject overrides when the org has actually saved a
 * customised theme (`customized: true`); otherwise we hand back `null`
 * branding so the KHARAGOLF defaults declared in `index.css` survive.
 */
import { createContext, useContext, useEffect, useState } from "react";
import { useGetMe } from "@workspace/api-client-react";
import { useActiveOrgId } from "@/context/ActiveOrgContext";
import { useOrgTheme, type OrgBranding } from "./useOrgTheme";

interface OrgThemeApiResponse {
  theme: {
    primaryColor: string | null;
    accentColor: string | null;
    fontFamily: string | null;
    logoUrl: string | null;
    faviconUrl: string | null;
    customized?: boolean;
  } | null;
}

async function fetchOrgBranding(orgId: number): Promise<OrgBranding | null> {
  try {
    const res = await fetch(`/api/organizations/${orgId}/theming`, { credentials: "include" });
    if (!res.ok) return null;
    const data = await res.json() as OrgThemeApiResponse;
    const t = data?.theme;
    if (!t || t.customized !== true) return null;
    return {
      primaryColor: t.primaryColor ?? null,
      accentColor: t.accentColor ?? null,
      fontFamily: t.fontFamily ?? null,
      logoUrl: t.logoUrl ?? null,
      faviconUrl: t.faviconUrl ?? null,
    };
  } catch {
    return null;
  }
}

const OrgBrandingContext = createContext<OrgBranding | null>(null);

/**
 * Read the active org's branding (logo, colors, etc) from the nearest
 * `OrgThemeProvider`. Returns `null` when the user is not inside an org
 * context or the org has no custom theme — consumers must fall back to
 * the KHARAGOLF default mark in that case.
 */
export function useOrgBranding(): OrgBranding | null {
  return useContext(OrgBrandingContext);
}

export function OrgThemeProvider({ children }: { children: React.ReactNode }) {
  const { data: user } = useGetMe({ query: { retry: false } });
  const activeOrgId = useActiveOrgId();
  const orgId = activeOrgId ?? user?.organizationId;
  const [branding, setBranding] = useState<OrgBranding | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!orgId) { setBranding(null); return; }
    fetchOrgBranding(orgId).then((b) => { if (!cancelled) setBranding(b); });
    return () => { cancelled = true; };
  }, [orgId]);

  useOrgTheme(branding);
  return (
    <OrgBrandingContext.Provider value={branding}>
      {children}
    </OrgBrandingContext.Provider>
  );
}
