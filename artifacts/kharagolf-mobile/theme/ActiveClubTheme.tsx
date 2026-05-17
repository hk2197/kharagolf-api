/**
 * Wave 0 / Task #935 W0-4 — bridge between ActiveClub and ThemeProvider
 * so per-club branding (primary/accent) automatically flows into the
 * mobile token system. Must be mounted *inside* ActiveClubProvider.
 *
 * Task #1438 — also fetches the active org's full theme record (font
 * family + logo URL in addition to the colors already on `activeClub`)
 * from `/api/organizations/:orgId/theming`.
 *
 * Source-of-truth rules:
 *   - The server's `customized` flag (whether a `club_theming` row
 *     exists) is authoritative. When it resolves to `false`, we hand
 *     back `null` branding so KHARAGOLF defaults survive on the
 *     player tab bar et al.
 *   - To avoid a perceptible flash from "customised" colours to the
 *     KHARAGOLF default while the request is in flight, we keep the
 *     legacy `activeClub` colours during the brief loading window
 *     only. This fallback is dropped as soon as `/theming` resolves.
 */
import React, { useEffect, useState } from "react";
import { useActiveClub } from "@/context/activeClub";
import { BASE_URL } from "@/utils/api";
import { ThemeProvider, type ThemeBranding } from "./ThemeProvider";

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

type Status = "loading" | "resolved";

export function ActiveClubThemeProvider({ children }: { children: React.ReactNode }) {
  const { activeClub, activeOrgId } = useActiveClub();
  const [status, setStatus] = useState<Status>("loading");
  const [remote, setRemote] = useState<ThemeBranding | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!activeOrgId) {
      // Nothing to fetch — there is no org-scoped theme to resolve.
      // Skip the loading window entirely so we land on KHARAGOLF
      // defaults immediately.
      setRemote(null);
      setStatus("resolved");
      return;
    }
    setStatus("loading");
    setRemote(null);
    fetch(`${BASE_URL}/api/organizations/${activeOrgId}/theming`)
      .then(r => (r.ok ? (r.json() as Promise<OrgThemeApiResponse>) : null))
      .then(data => {
        if (cancelled) return;
        const t = data?.theme;
        if (!t || t.customized !== true) {
          setRemote(null);
          setStatus("resolved");
          return;
        }
        setRemote({
          primaryColor: t.primaryColor ?? null,
          accentColor: t.accentColor ?? null,
          fontFamily: t.fontFamily ?? null,
          logoUrl: t.logoUrl ?? null,
          customized: true,
        });
        setStatus("resolved");
      })
      .catch(() => {
        if (!cancelled) {
          setRemote(null);
          setStatus("resolved");
        }
      });
    return () => { cancelled = true; };
  }, [activeOrgId]);

  // Resolution priority:
  //   1. Customised /theming row → use it (customized=true)
  //   2. Loading window with a legacy activeClub colour available →
  //      use those colours to avoid flashing the default theme.
  //      `customized=true` is set so consumers (tab bar) preview the
  //      branded look during this brief window.
  //   3. Anything else (resolved with no customisation, or loading
  //      with no legacy colours) → null branding → KHARAGOLF defaults.
  let branding: ThemeBranding | null = null;
  if (remote) {
    branding = remote;
  } else if (
    status === "loading" &&
    (activeClub?.primaryColor || activeClub?.accentColor || activeClub?.logoUrl)
  ) {
    branding = {
      primaryColor: activeClub.primaryColor ?? null,
      accentColor: activeClub.accentColor ?? null,
      logoUrl: activeClub.logoUrl ?? null,
      customized: true,
    };
  }

  return <ThemeProvider branding={branding}>{children}</ThemeProvider>;
}
