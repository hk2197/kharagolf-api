import React, { createContext, useContext, useState, useCallback } from 'react';
import { useGetMe } from '@workspace/api-client-react';

const ACTIVE_ORG_KEY = 'kharagolf_active_org_id';

interface ActiveOrgContextValue {
  /** The effective org ID to use for all data queries in the current session */
  activeOrgId: number | undefined;
  /** True when the super-admin has overridden their default org */
  isOrgOverridden: boolean;
  /** Set the active org (super-admin only). Pass undefined to clear the override. */
  setActiveOrg: (id: number | undefined) => void;
}

const ActiveOrgContext = createContext<ActiveOrgContextValue | null>(null);

export function ActiveOrgProvider({ children }: { children: React.ReactNode }) {
  const { data: user } = useGetMe();
  const isSuperAdmin = user?.role === 'super_admin';

  const [overrideOrgId, setOverrideOrgId] = useState<number | undefined>(() => {
    if (!isSuperAdmin) return undefined;
    try {
      const stored = localStorage.getItem(ACTIVE_ORG_KEY);
      return stored ? Number(stored) : undefined;
    } catch {
      return undefined;
    }
  });

  const setActiveOrg = useCallback((id: number | undefined) => {
    if (!isSuperAdmin) return;
    setOverrideOrgId(id);
    try {
      if (id != null) {
        localStorage.setItem(ACTIVE_ORG_KEY, String(id));
      } else {
        localStorage.removeItem(ACTIVE_ORG_KEY);
      }
    } catch {}
  }, [isSuperAdmin]);

  // Super admins can switch the active org; regular admins always use their own org
  const activeOrgId = isSuperAdmin && overrideOrgId
    ? overrideOrgId
    : user?.organizationId ?? undefined;

  return (
    <ActiveOrgContext.Provider value={{
      activeOrgId,
      isOrgOverridden: isSuperAdmin && !!overrideOrgId,
      setActiveOrg,
    }}>
      {children}
    </ActiveOrgContext.Provider>
  );
}

/**
 * Hook that returns the effective org ID for the current admin session.
 *
 * For regular org admins: always returns their own organizationId.
 * For super admins: returns the overridden org (set via OrgSwitcher) or their own org.
 *
 * Use this in page components instead of `user?.organizationId` to correctly
 * support multi-club switching for super admins.
 */
export function useActiveOrgId(): number | undefined {
  const ctx = useContext(ActiveOrgContext);
  // Graceful fallback if used outside provider
  if (!ctx) {
    console.warn('useActiveOrgId called outside ActiveOrgProvider');
    return undefined;
  }
  return ctx.activeOrgId;
}

export function useActiveOrgContext(): ActiveOrgContextValue {
  const ctx = useContext(ActiveOrgContext);
  if (!ctx) throw new Error('useActiveOrgContext must be used inside ActiveOrgProvider');
  return ctx;
}
