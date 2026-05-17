import React, { createContext, useContext, useEffect, useState, useCallback } from "react";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
import { useAuth } from "./auth";

async function secureGet(key: string): Promise<string | null> {
  if (Platform.OS === "web") return localStorage.getItem(key);
  return SecureStore.getItemAsync(key);
}

async function secureSet(key: string, value: string): Promise<void> {
  if (Platform.OS === "web") { localStorage.setItem(key, value); return; }
  await SecureStore.setItemAsync(key, value);
}

const ACTIVE_CLUB_KEY = "kharagolf_active_club_id";

const BASE_URL = process.env.EXPO_PUBLIC_DOMAIN
  ? `https://${process.env.EXPO_PUBLIC_DOMAIN}`
  : "";

export interface ActiveClub {
  id: number;
  name: string;
  slug: string;
  subscriptionTier: string;
  role?: string;
  logoUrl?: string | null;
  primaryColor?: string | null;
  accentColor?: string | null;
}

interface ActiveClubContextValue {
  activeOrgId: number | null;
  activeClub: ActiveClub | null;
  clubs: ActiveClub[];
  switchClub: (clubId: number) => Promise<void>;
  isSuperAdmin: boolean;
  canSwitchClub: boolean;
}

const ActiveClubContext = createContext<ActiveClubContextValue>({
  activeOrgId: null,
  activeClub: null,
  clubs: [],
  switchClub: async () => {},
  isSuperAdmin: false,
  canSwitchClub: false,
});

export function ActiveClubProvider({ children }: { children: React.ReactNode }) {
  const { user, token } = useAuth();
  const isSuperAdmin = user?.role === "super_admin";

  const [clubs, setClubs] = useState<ActiveClub[]>([]);
  const [activeClubId, setActiveClubId] = useState<number | null>(null);

  // Restore persisted selection, then load the user's club list.
  // super_admin   → load all clubs via /api/super-admin/clubs (may be many)
  // regular users → load their org memberships via /api/portal/my-orgs
  //                 and show switcher only when they belong to more than one club
  useEffect(() => {
    if (!token || !user) {
      setClubs([]);
      setActiveClubId(null);
      return;
    }

    void secureGet(ACTIVE_CLUB_KEY).then(v => {
      if (v) setActiveClubId(Number(v));
    });

    if (isSuperAdmin) {
      fetch(`${BASE_URL}/api/super-admin/clubs`, {
        headers: { Authorization: `Bearer ${token}` },
      })
        .then(r => r.ok ? r.json() : { clubs: [] })
        .then((d: { clubs?: ActiveClub[] }) => setClubs(d.clubs ?? []))
        .catch(() => {});
    } else {
      fetch(`${BASE_URL}/api/portal/my-orgs`, {
        headers: { Authorization: `Bearer ${token}` },
      })
        .then(r => r.ok ? r.json() : { orgs: [] })
        .then((d: { orgs?: ActiveClub[] }) => {
          const orgs = d.orgs ?? [];
          setClubs(orgs);
        })
        .catch(() => {});
    }
  }, [isSuperAdmin, token, user?.id]);

  const switchClub = useCallback(async (clubId: number) => {
    setActiveClubId(clubId);
    try {
      await secureSet(ACTIVE_CLUB_KEY, String(clubId));
    } catch { /* ignore */ }
  }, []);

  const effectiveOrgId = activeClubId ?? user?.organizationId ?? null;
  const activeClub = clubs.find(c => c.id === effectiveOrgId) ?? null;

  // Users can switch clubs if:
  // - they are super_admin (can switch between any club), or
  // - they are a regular user with memberships in more than one org
  const canSwitchClub = isSuperAdmin || clubs.length > 1;

  return (
    <ActiveClubContext.Provider
      value={{ activeOrgId: effectiveOrgId, activeClub, clubs, switchClub, isSuperAdmin, canSwitchClub }}
    >
      {children}
    </ActiveClubContext.Provider>
  );
}

export function useActiveClub() {
  return useContext(ActiveClubContext);
}
