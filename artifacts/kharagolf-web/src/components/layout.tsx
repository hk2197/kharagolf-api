import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Link, useLocation } from 'wouter';
import { useTranslation } from 'react-i18next';
import { motion } from 'framer-motion';
import {
  Trophy, LayoutDashboard, Map, Users, Bell,
  LogOut, ChevronRight, ChevronLeft, BarChart3, MessageSquare, CreditCard, TrendingUp,
  ShoppingBag, Settings, UserSquare2, Shield, CalendarDays, Crown, Building2, ChevronDown, Check,
  Activity, Award, Clock, Car, Lock, Store, Newspaper, Star, GraduationCap, Coffee, UtensilsCrossed, Handshake, Vote,
  Rss, MapPin, Tv, Wrench, Package, Tag, Gift, DollarSign, Leaf, CalendarClock, ListOrdered, UserCheck, BookOpen, Target, PieChart, ClipboardList, Megaphone, Archive, Globe, Film,
  Receipt, BarChart2, Webhook, FileText, Cpu, Palette,
  type LucideIcon,
} from 'lucide-react';
import { useGetMe } from '@workspace/api-client-react';
import { useQuery } from '@tanstack/react-query';
import { PlanStrip, PlanStripCollapsed } from './plan-usage';
import { useActiveOrgContext } from '@/context/ActiveOrgContext';
import { LanguageSelector } from './language-selector';
import { clearAllCoachDrawingClipboards } from '@/lib/coachDrawingClipboard';

// Task #2130 — wipe every persisted coach drawing clipboard before the
// browser navigates to `/api/logout` so a shared workstation does not
// leave one coach's callout pattern on disk for the next coach who logs
// in. Kept as a top-level helper so both the avatar dropdown and the
// expanded sidebar fire the same teardown.
function signOutWithCleanup() {
  clearAllCoachDrawingClipboards();
  window.location.href = '/api/logout';
}

const SIDEBAR_COLLAPSED_KEY = 'kharagolf_sidebar_collapsed';
const SIDEBAR_SECTIONS_KEY = 'kharagolf_sidebar_sections';

interface OrgBranding {
  id: number;
  name: string;
  logoUrl: string | null;
  primaryColor: string | null;
}

interface OrgListItem {
  id: number;
  name: string;
  slug: string;
  logoUrl: string | null;
  subscriptionTier: string;
}

interface NavItem {
  name: string;
  path: string;
  icon: LucideIcon;
  adminOnly?: boolean;
  superAdminOnly?: boolean;
  noticeBadge?: boolean;
  pendingDocsBadge?: boolean;
  moderationBadge?: boolean;
}

interface NavSection {
  id: string;
  label: string;
  adminOnly?: boolean;
  superAdminOnly?: boolean;
  items: NavItem[];
}

const NAV_SECTIONS: NavSection[] = [
  {
    id: 'core',
    label: 'Overview',
    items: [
      { name: 'Dashboard', path: '/', icon: LayoutDashboard },
    ],
  },
  {
    id: 'play',
    label: 'Play',
    items: [
      { name: 'Tee Bookings', path: '/tee-bookings', icon: Clock },
      { name: 'Tee Sheet Settings', path: '/tee-sheet-settings', icon: Settings, adminOnly: true },
      { name: 'Dynamic Pricing', path: '/dynamic-pricing', icon: TrendingUp, adminOnly: true },
      { name: 'Driving Range', path: '/range-bookings', icon: Target },
      { name: 'General Play', path: '/general-play', icon: Activity },
      { name: 'Tee Time Marketplace', path: '/marketplace', icon: CalendarDays, adminOnly: true },
      { name: 'Courses', path: '/courses', icon: Map, adminOnly: true },
      { name: 'Pace of Play', path: '/pace-of-play', icon: Clock, adminOnly: true },
    ],
  },
  {
    id: 'competitions',
    label: 'Competitions',
    items: [
      { name: 'Tournaments', path: '/tournaments', icon: Trophy },
      { name: 'Leagues', path: '/leagues', icon: BarChart3 },
      { name: 'Fantasy Golf', path: '/fantasy', icon: Star },
      { name: 'Club Championship', path: '/club-championship', icon: Trophy },
      { name: 'Interclub', path: '/interclub', icon: Users },
      { name: 'Junior Golf', path: '/junior-golf', icon: GraduationCap },
    ],
  },
  {
    id: 'handicap',
    label: 'Handicap',
    items: [
      { name: 'My Handicap', path: '/handicap-profile', icon: Award },
      { name: 'My Follows', path: '/my-follows', icon: UserCheck },
      { name: 'Annual H.I. Review', path: '/annual-handicap-review', icon: Shield },
      { name: 'HCP Committee', path: '/handicap-committee', icon: Shield, adminOnly: true },
    ],
  },
  {
    id: 'members',
    label: 'Members',
    adminOnly: true,
    items: [
      { name: 'Club Members', path: '/club-members', icon: UserSquare2 },
      { name: 'Players', path: '/players', icon: Users },
      { name: 'Pending Documents', path: '/documents-pending', icon: FileText, pendingDocsBadge: true },
      { name: 'Waitlist', path: '/waitlist', icon: ListOrdered },
      { name: 'Guest Passes', path: '/guest-passes', icon: UserCheck },
    ],
  },
  {
    id: 'commerce',
    label: 'Commerce',
    adminOnly: true,
    items: [
      { name: 'POS Terminal', path: '/pos', icon: Store },
      { name: 'Shop', path: '/shop', icon: ShoppingBag },
      { name: 'Gift Cards', path: '/gift-cards', icon: Gift },
      { name: 'Payments', path: '/payments', icon: CreditCard },
      { name: 'Dues & Billing', path: '/dues-billing', icon: DollarSign },
      { name: 'Finance / Ledger', path: '/finance-ledger', icon: Receipt },
      { name: 'Commissions', path: '/commissions', icon: DollarSign },
      { name: 'Consignment', path: '/consignment', icon: Tag },
      { name: 'Loyalty & Rewards', path: '/loyalty', icon: Star },
      { name: 'GST Invoices', path: '/gst-invoices', icon: Receipt },
      { name: 'Commerce Analytics', path: '/commerce-analytics', icon: BarChart2 },
      { name: 'Promotions', path: '/promotions', icon: Tag },
    ],
  },
  {
    id: 'fnb',
    label: 'Food & Beverage',
    adminOnly: true,
    items: [
      { name: 'F&B Orders', path: '/fb-admin', icon: UtensilsCrossed },
      { name: 'F&B Fulfillment', path: '/fb-fulfillment', icon: Coffee },
    ],
  },
  {
    id: 'facilities',
    label: 'Facilities',
    adminOnly: true,
    items: [
      { name: 'Cart Fleet', path: '/cart-fleet', icon: Car },
      { name: 'Caddies', path: '/caddies', icon: Users },
      { name: 'Rentals', path: '/rentals', icon: Package },
      { name: 'Lockers', path: '/lockers', icon: Lock },
      { name: 'Club Repair', path: '/club-repair', icon: Wrench },
      { name: 'Course Maintenance', path: '/course-maintenance', icon: Leaf },
    ],
  },
  {
    id: 'communication',
    label: 'Communication',
    items: [
      { name: 'AI Caddie', path: '/ai-caddie', icon: Cpu },
      { name: 'Notice Board', path: '/notice-board', icon: Newspaper, noticeBadge: true },
      { name: 'Club Feed', path: '/feed', icon: Rss },
      { name: 'Messages', path: '/messages', icon: MessageSquare },
      { name: 'Surveys & Feedback', path: '/surveys', icon: ClipboardList },
      { name: 'Marketing', path: '/marketing', icon: Megaphone, adminOnly: true },
      { name: 'Reel Engagement', path: '/highlight-engagement', icon: Film, adminOnly: true },
      { name: 'Marketing Site', path: '/club-marketing-site', icon: Globe, adminOnly: true },
      { name: 'Course Moderation', path: '/course-moderation', icon: Shield, adminOnly: true, moderationBadge: true },
      { name: 'Video Cleanup', path: '/media-admin', icon: Film, adminOnly: true },
    ],
  },
  {
    id: 'business',
    label: 'Business',
    adminOnly: true,
    items: [
      { name: 'Analytics', path: '/stats', icon: TrendingUp },
      { name: 'BI Dashboard', path: '/analytics', icon: PieChart },
      { name: 'Event Stream', path: '/admin/analytics', icon: Activity, adminOnly: true },
      { name: 'Reports', path: '/reports', icon: FileText },
      { name: 'Sponsors', path: '/sponsors', icon: Handshake },
      { name: 'Vendor Operators', path: '/vendor-operators', icon: Building2 },
      { name: 'Procurement', path: '/procurement', icon: Package },
      { name: 'Inventory', path: '/inventory', icon: Archive },
      { name: 'Accounting & Finance', path: '/accounting', icon: BookOpen },
      { name: 'Rankings', path: '/rankings-admin', icon: Trophy },
    ],
  },
  {
    id: 'events',
    label: 'Events & Education',
    adminOnly: true,
    items: [
      { name: 'Events & Functions', path: '/events', icon: CalendarDays },
      { name: 'Golf Trips', path: '/trips', icon: MapPin },
      { name: 'Scheduling', path: '/scheduling', icon: CalendarClock },
      { name: 'Event Staffing', path: '/event-staffing', icon: UserCheck },
      { name: 'Lessons', path: '/lessons', icon: GraduationCap },
      { name: 'Pro Dashboard', path: '/pro-dashboard', icon: GraduationCap },
      { name: 'Lessons Admin', path: '/lessons-admin', icon: GraduationCap },
    ],
  },
  {
    id: 'admin',
    label: 'Administration',
    adminOnly: true,
    items: [
      { name: 'Settings', path: '/admin', icon: Settings },
      { name: 'Notification Audit', path: '/admin/notification-audit', icon: Bell },
      { name: 'Alert Mute Settings', path: '/admin/event-mutes', icon: Bell },
      { name: 'Recap Broadcasts', path: '/admin/recap-broadcasts', icon: Bell },
      { name: 'Recap Share Stats', path: '/admin/recap-share-stats', icon: Bell },
      { name: 'Webhooks', path: '/webhooks', icon: Webhook },
      { name: 'Documents', path: '/club-settings', icon: FileText },
      { name: 'Club Theming', path: '/club-theming', icon: Palette, adminOnly: true },
      { name: 'Governance', path: '/governance', icon: Vote },
      { name: 'TV Display', path: '/display-settings', icon: Tv },
      { name: 'Broadcast Overlays', path: '/overlay-control', icon: Tv },
    ],
  },
  {
    id: 'system',
    label: 'System',
    superAdminOnly: true,
    items: [
      { name: 'Super Admin', path: '/super-admin', icon: Crown },
      { name: 'Notification Conversions', path: '/admin/notification-conversions', icon: Bell },
      { name: 'Email CTA Stats', path: '/admin/email-cta-stats', icon: Bell },
    ],
  },
];

/** Org-switcher dropdown — shown for super admins in the sidebar */
function OrgSwitcher({
  orgs,
  activeOrgId,
  onSwitch,
  collapsed,
}: {
  orgs: OrgListItem[];
  activeOrgId: number | null;
  onSwitch: (id: number) => void;
  collapsed: boolean;
}) {
  const { t } = useTranslation('navigation');
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const activeOrg = orgs.find(o => o.id === activeOrgId) ?? orgs[0];

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    if (open) document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  if (collapsed) {
    return (
      <div className="p-1 border-b border-white/5 flex-shrink-0">
        <button
          title={activeOrg?.name ?? t('switchClub')}
          onClick={() => setOpen(o => !o)}
          className="w-8 h-8 rounded-lg bg-white/5 border border-white/10 flex items-center justify-center text-muted-foreground hover:text-white mx-auto"
        >
          <Building2 className="w-4 h-4" />
        </button>
        {open && (
          <div ref={ref} className="absolute left-12 top-16 z-50 w-56 bg-card border border-white/10 rounded-xl shadow-xl overflow-hidden">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground px-3 py-2 border-b border-white/5">{t('switchClub')}</p>
            <div className="max-h-60 overflow-y-auto">
              {orgs.map(o => (
                <button key={o.id} onClick={() => { onSwitch(o.id); setOpen(false); }} className="w-full text-left px-3 py-2 text-sm hover:bg-white/5 flex items-center gap-2">
                  {o.id === activeOrgId ? <Check className="w-3.5 h-3.5 text-primary flex-shrink-0" /> : <span className="w-3.5" />}
                  <span className="text-white truncate">{o.name}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div ref={ref} className="p-4 border-b border-white/5 flex-shrink-0 relative">
      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1.5">{t('activeClub')}</p>
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-white/5 transition-colors group"
      >
        <div className="w-2 h-2 rounded-full bg-primary animate-pulse flex-shrink-0" />
        <span className="text-sm font-semibold text-white flex-1 truncate text-left">{activeOrg?.name ?? t('allClubs')}</span>
        <ChevronDown className={`w-3.5 h-3.5 text-muted-foreground transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="absolute left-4 right-4 top-full mt-1 z-50 bg-card border border-white/10 rounded-xl shadow-xl overflow-hidden">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground px-3 py-2 border-b border-white/5">{t('switchClub')}</p>
          <div className="max-h-60 overflow-y-auto">
            {orgs.map(o => (
              <button
                key={o.id}
                onClick={() => { onSwitch(o.id); setOpen(false); }}
                className="w-full text-left px-3 py-2 text-sm hover:bg-white/5 flex items-center gap-2"
              >
                {o.id === activeOrgId ? <Check className="w-3.5 h-3.5 text-primary flex-shrink-0" /> : <span className="w-3.5 flex-shrink-0" />}
                <span className="text-white flex-1 truncate">{o.name}</span>
                <span className="text-[10px] text-muted-foreground capitalize">{o.subscriptionTier}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function UserFooter({ collapsed, user }: {
  collapsed: boolean;
  user: { displayName?: string; username?: string; role?: string } | undefined;
}) {
  const { t } = useTranslation('navigation');
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    if (open) document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  const initial = user?.username?.[0]?.toUpperCase() ?? '?';
  const displayName = user?.displayName || user?.username || '';
  const roleLabel = user?.role?.replace(/_/g, ' ') ?? '';

  if (collapsed) {
    return (
      <div ref={ref} className="border-t border-white/5 flex-shrink-0 p-1 flex justify-center relative">
        <button
          onClick={() => setOpen(o => !o)}
          className="group relative w-8 h-8 rounded-full bg-gradient-to-tr from-primary to-emerald-700 flex items-center justify-center text-white font-bold text-sm flex-shrink-0"
        >
          {initial}
          <div className="pointer-events-none group-hover:pointer-events-auto absolute ltr:left-full rtl:right-full ltr:ms-2 rtl:me-2 bottom-0 z-50 w-44 bg-black/90 border border-white/10 rounded-xl shadow-lg opacity-0 group-hover:opacity-100 transition-opacity">
            <div className="px-3 py-2 border-b border-white/10">
              <p className="text-xs font-semibold text-white truncate">{displayName}</p>
              {roleLabel && <p className="text-[11px] text-muted-foreground capitalize">{roleLabel}</p>}
            </div>
            <button
              onClick={(e) => { e.stopPropagation(); signOutWithCleanup(); }}
              className="w-full flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground hover:text-destructive transition-colors hover:bg-destructive/10 rounded-b-xl"
            >
              <LogOut className="w-3.5 h-3.5" /> {t('signOut')}
            </button>
          </div>
        </button>
      </div>
    );
  }

  return (
    <div ref={ref} className="border-t border-white/5 flex-shrink-0 px-2 py-1 relative">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-white/5 transition-colors group"
      >
        <div className="w-7 h-7 rounded-full bg-gradient-to-tr from-primary to-emerald-700 flex items-center justify-center text-white font-bold text-xs flex-shrink-0">
          {initial}
        </div>
        <div className="flex-1 min-w-0 text-left">
          <p className="text-sm font-semibold text-white truncate leading-tight">{displayName}</p>
          <p className="text-[11px] text-muted-foreground capitalize leading-tight">{roleLabel}</p>
        </div>
        <LogOut className="w-3.5 h-3.5 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0" />
      </button>
      {open && (
        <div className="absolute bottom-full left-2 right-2 mb-1 z-50 bg-card border border-white/10 rounded-xl shadow-2xl overflow-hidden">
          <div className="px-3 py-2 border-b border-white/5">
            <p className="text-sm font-semibold text-white truncate">{displayName}</p>
            <p className="text-xs text-muted-foreground capitalize">{roleLabel}</p>
          </div>
          <div className="px-3 py-2 border-b border-white/5">
            <LanguageSelector
              showLabel
              className="text-xs"
              onChange={async (lang) => {
                try {
                  await fetch('/api/auth/me/language', {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ language: lang }),
                    credentials: 'include',
                  });
                } catch {}
              }}
            />
          </div>
          <button
            onClick={() => { signOutWithCleanup(); }}
            className="w-full flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground hover:text-destructive transition-colors hover:bg-destructive/10"
          >
            <LogOut className="w-4 h-4" /> {t('signOut')}
          </button>
        </div>
      )}
    </div>
  );
}

/** Returns the section IDs that contain the current path */
function getActiveSectionIds(location: string, sections: NavSection[]): string[] {
  return sections
    .filter(s => s.items.some(item =>
      item.path === location || (item.path !== '/' && location.startsWith(item.path))
    ))
    .map(s => s.id);
}

function loadSectionState(defaultOpen: string[]): Record<string, boolean> {
  try {
    const stored = localStorage.getItem(SIDEBAR_SECTIONS_KEY);
    if (stored) return JSON.parse(stored) as Record<string, boolean>;
  } catch {}
  return Object.fromEntries(defaultOpen.map(id => [id, true]));
}

function saveSectionState(state: Record<string, boolean>) {
  try { localStorage.setItem(SIDEBAR_SECTIONS_KEY, JSON.stringify(state)); } catch {}
}

const ITEM_T_KEYS: Record<string, string> = {
  "Dashboard": "dashboard", "Tee Bookings": "teeBookings", "Tee Sheet Settings": "teeSheetSettings",
  "Driving Range": "drivingRange", "General Play": "generalPlay", "Tee Time Marketplace": "teeTimeMarketplace",
  "Courses": "courses", "Pace of Play": "paceOfPlay", "Tournaments": "tournaments", "Leagues": "leagues",
  "Fantasy Golf": "fantasyGolf", "Club Championship": "clubChampionship", "Interclub": "interclub",
  "Junior Golf": "juniorGolf", "My Handicap": "myHandicap", "Annual H.I. Review": "annualHIReview",
  "HCP Committee": "hcpCommittee", "Club Members": "clubMembers", "Players": "players",
  "Waitlist": "waitlist", "Guest Passes": "guestPasses", "POS Terminal": "posTerminal",
  "Shop": "shop", "Gift Cards": "giftCards", "Payments": "payments", "Dues & Billing": "duesBilling",
  "Commissions": "commissions", "Consignment": "consignment", "Loyalty & Rewards": "loyaltyRewards",
  "GST Invoices": "gstInvoices", "Commerce Analytics": "commerceAnalytics", "Promotions": "promotions",
  "F&B Orders": "fbOrders", "F&B Fulfillment": "fbFulfillment", "Cart Fleet": "cartFleet",
  "Caddies": "caddies", "Rentals": "rentals", "Lockers": "lockers", "Club Repair": "clubRepair",
  "Course Maintenance": "courseMaintenance", "AI Caddie": "aiCaddie", "Notice Board": "noticeBoard", "Club Feed": "clubFeed",
  "Messages": "messages", "Surveys & Feedback": "surveysFeedback", "Marketing": "marketing",
  "Analytics": "analytics", "BI Dashboard": "biDashboard", "Sponsors": "sponsors",
  "Vendor Operators": "vendorOperators", "Procurement": "procurement", "Inventory": "inventory",
  "Accounting & Finance": "accountingFinance", "Rankings": "rankings",
  "Events & Functions": "eventsFunctions", "Golf Trips": "golfTrips", "Scheduling": "scheduling",
  "Event Staffing": "eventStaffing", "Lessons": "lessons", "Pro Dashboard": "proDashboard",
  "Lessons Admin": "lessonsAdmin", "Settings": "settings", "Webhooks": "webhooks",
  "Governance": "governance", "TV Display": "tvDisplay", "Super Admin": "superAdmin",
};

export function AppLayout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const { data: user } = useGetMe();
  const { t, i18n } = useTranslation('navigation');
  const isSuperAdmin = user?.role === 'super_admin';
  const isAdmin = user?.role === 'org_admin' || user?.role === 'super_admin' || user?.role === 'tournament_director';

  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === 'true'; } catch { return false; }
  });

  const { activeOrgId, setActiveOrg } = useActiveOrgContext();
  const effectiveOrgId = activeOrgId ?? user?.organizationId;

  // TEMP: Role gates removed — show all sections regardless of auth
  // Original filtering preserved below for easy restoration:
  // const visibleSections = NAV_SECTIONS
  //   .filter(s => {
  //     if (s.superAdminOnly) return isSuperAdmin;
  //     if (s.adminOnly) return isAdmin;
  //     return true;
  //   })
  //   .map(s => ({
  //     ...s,
  //     items: s.items.filter(item => {
  //       if (item.superAdminOnly) return isSuperAdmin;
  //       if (item.adminOnly) return isAdmin;
  //       return true;
  //     }),
  //   }))
  //   .filter(s => s.items.length > 0);
  const visibleSections = NAV_SECTIONS;

  // Section open/closed state — default open: Overview + active section
  const defaultOpen = ['core', ...getActiveSectionIds(location, visibleSections)];
  const [sectionOpen, setSectionOpen] = useState<Record<string, boolean>>(() =>
    loadSectionState(defaultOpen)
  );

  // Bootstrap language from user preference on login/page load
  useEffect(() => {
    const lang = user?.preferredLanguage;
    if (lang && lang !== i18n.language) {
      i18n.changeLanguage(lang);
      document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
      document.documentElement.lang = lang;
    }
  }, [user, i18n]);

  // Auto-expand active section when location changes
  useEffect(() => {
    const activeSectionIds = getActiveSectionIds(location, visibleSections);
    if (activeSectionIds.length === 0) return;
    setSectionOpen(prev => {
      const needsUpdate = activeSectionIds.some(id => !prev[id]);
      if (!needsUpdate) return prev;
      const next = { ...prev };
      activeSectionIds.forEach(id => { next[id] = true; });
      saveSectionState(next);
      return next;
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location]);

  const toggleSection = useCallback((id: string) => {
    setSectionOpen(prev => {
      const next = { ...prev, [id]: !prev[id] };
      saveSectionState(next);
      return next;
    });
  }, []);

  const { data: org } = useQuery<OrgBranding>({
    queryKey: [`/api/organizations/${effectiveOrgId}`],
    queryFn: () => fetch(`/api/organizations/${effectiveOrgId}`).then(r => r.json()),
    enabled: !!effectiveOrgId,
    staleTime: 5 * 60 * 1000,
  });

  const { data: allOrgs } = useQuery<{ clubs: OrgListItem[] }>({
    queryKey: ['/api/super-admin/clubs'],
    queryFn: () => fetch('/api/super-admin/clubs').then(r => r.json()),
    enabled: isSuperAdmin,
    staleTime: 60 * 1000,
    select: (d) => ({ clubs: (d as { clubs?: OrgListItem[] }).clubs ?? [] }),
  });

  const { data: noticeUnreadData } = useQuery<{ count: number }>({
    queryKey: [`/api/organizations/${effectiveOrgId}/notice-board/unread-count`],
    queryFn: () => fetch(`/api/organizations/${effectiveOrgId}/notice-board/unread-count`, { credentials: 'include' }).then(r => r.ok ? r.json() : { count: 0 }),
    enabled: !!effectiveOrgId && !!user,
    staleTime: 60 * 1000,
    refetchInterval: 60 * 1000,
  });
  const noticeUnreadCount = noticeUnreadData?.count ?? 0;

  const { data: pendingDocsData } = useQuery<{ count: number }>({
    queryKey: ['documents-pending-count', effectiveOrgId],
    queryFn: () => fetch(`/api/organizations/${effectiveOrgId}/members-360/documents/pending`, { credentials: 'include' }).then(r => r.ok ? r.json() : { count: 0 }),
    enabled: !!effectiveOrgId && isAdmin,
    staleTime: 30 * 1000,
    refetchInterval: 30 * 1000,
  });
  const pendingDocsCount = pendingDocsData?.count ?? 0;

  // Course moderation badge — sums pending reviews + photos for the active org
  // so admins know at a glance there's curation work waiting on their public
  // course pages (Task #476).
  const { data: moderationCountData } = useQuery<{ count: number }>({
    queryKey: ['course-moderation-count', effectiveOrgId],
    queryFn: async () => {
      const [reviews, photos] = await Promise.all([
        fetch(`/api/organizations/${effectiveOrgId}/marketing-site/course-reviews?status=pending`, { credentials: 'include' })
          .then(r => r.ok ? r.json() : []),
        fetch(`/api/organizations/${effectiveOrgId}/marketing-site/course-photos?status=pending`, { credentials: 'include' })
          .then(r => r.ok ? r.json() : []),
      ]);
      const reviewCount = Array.isArray(reviews) ? reviews.length : 0;
      const photoCount = Array.isArray(photos) ? photos.length : 0;
      return { count: reviewCount + photoCount };
    },
    enabled: !!effectiveOrgId && isAdmin,
    staleTime: 60 * 1000,
    refetchInterval: 60 * 1000,
  });
  const moderationCount = moderationCountData?.count ?? 0;

  // Player notifications unread count — surfaces committee handicap notifications
  // (and any other deep-linked items) directly in the global header so players
  // don't have to navigate to /notifications to discover them (Task #606).
  const { data: notifUnreadData } = useQuery<{ unreadCount: number }>({
    queryKey: ['portal-handicap-notifications-unread'],
    queryFn: () => fetch('/api/portal/handicap/notifications?unread=1&limit=1', { credentials: 'include' })
      .then(r => r.ok ? r.json() : { unreadCount: 0 })
      .catch(() => ({ unreadCount: 0 })),
    enabled: !!user,
    staleTime: 30 * 1000,
    refetchInterval: 30 * 1000,
  });
  // Task #2159 — also poll the generic in-app inbox (which surfaces
  // `social.follow.new` rows today) so a new follower lights up the
  // bell for players who have no committee activity. The bell badge
  // sums both totals; the inbox page renders both feeds merged by
  // createdAt desc.
  const { data: inboxUnreadData } = useQuery<{ unreadCount: number }>({
    queryKey: ['portal-inbox-notifications-unread'],
    queryFn: () => fetch('/api/portal/inbox/notifications?unread=1&limit=1', { credentials: 'include' })
      .then(r => r.ok ? r.json() : { unreadCount: 0 })
      .catch(() => ({ unreadCount: 0 })),
    enabled: !!user,
    staleTime: 30 * 1000,
    refetchInterval: 30 * 1000,
  });
  const notifUnreadCount = (notifUnreadData?.unreadCount ?? 0) + (inboxUnreadData?.unreadCount ?? 0);

  // Apply brand colour
  useEffect(() => {
    if (!org?.primaryColor) return;
    const hex = org.primaryColor.replace('#', '');
    const r = parseInt(hex.substring(0, 2), 16) / 255;
    const g = parseInt(hex.substring(2, 4), 16) / 255;
    const b = parseInt(hex.substring(4, 6), 16) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2;
    const d = max - min;
    const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
    let h = 0;
    if (d !== 0) {
      if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
      else if (max === g) h = ((b - r) / d + 2) / 6;
      else h = ((r - g) / d + 4) / 6;
    }
    const hsl = `${Math.round(h * 360)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%`;
    document.documentElement.style.setProperty('--brand-primary', org.primaryColor);
    document.documentElement.style.setProperty('--primary', hsl);
    document.documentElement.style.setProperty('--ring', hsl);
  }, [org?.primaryColor]);

  const clubName = org?.name || user?.organizationName || 'KHARAGOLF';

  const toggleCollapse = () => {
    setCollapsed(prev => {
      const next = !prev;
      try { localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(next)); } catch {}
      return next;
    });
  };

  // Flat list for collapsed icon-only mode (all visible items, no section structure)
  const allVisibleItems = visibleSections.flatMap(s => s.items);

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      {/* Sidebar */}
      <motion.aside
        initial={{ x: -250 }}
        animate={{ x: 0 }}
        style={{ width: collapsed ? 48 : 224, transition: 'width 0.25s ease' }}
        className="border-r border-white/5 bg-card/50 backdrop-blur-xl flex flex-col z-20 relative flex-shrink-0"
      >
        {/* Header / Logo */}
        <div className={`flex items-center border-b border-white/5 flex-shrink-0 ${collapsed ? 'p-2 flex-col gap-2' : 'px-4 py-3.5 gap-3'}`}>
          <img
            src={org?.logoUrl || '/logo.png'}
            alt={clubName}
            className="w-8 h-8 object-contain rounded-lg bg-white/10 p-0.5 flex-shrink-0"
            onError={(e) => { const img = e.currentTarget as HTMLImageElement; if (img.src !== window.location.origin + '/logo.png') { img.src = '/logo.png'; } else { img.style.display = 'none'; } }}
          />
          {!collapsed && (
            <div className="min-w-0 flex-1">
              <h1 className="font-display font-bold text-sm leading-tight tracking-tight text-white truncate">{clubName}</h1>
              <p className="text-[10px] uppercase tracking-wider font-semibold"><span style={{ color: '#C9A84C' }}>Elysium</span><span style={{ color: '#ffffff' }}>OS</span></p>
            </div>
          )}
          <Link
            href="/notifications"
            data-testid="button-header-notifications"
            title={t('notifications', { defaultValue: 'Notifications' })}
            className={`relative flex items-center justify-center w-8 h-8 rounded-lg border transition-colors flex-shrink-0 ${
              location === '/notifications'
                ? 'bg-primary/20 text-white border-primary/40'
                : 'bg-white/5 border-white/10 text-muted-foreground hover:text-white hover:bg-white/10'
            }`}
          >
            <Bell className="w-4 h-4" />
            {notifUnreadCount > 0 && (
              <span
                data-testid="badge-header-notifications-unread"
                className="absolute -top-1 -right-1 min-w-[16px] h-4 px-1 rounded-full bg-primary text-[10px] font-bold text-primary-foreground flex items-center justify-center leading-none ring-2 ring-card"
              >
                {notifUnreadCount > 99 ? '99+' : notifUnreadCount}
              </span>
            )}
          </Link>
        </div>

        {/* Org Switcher */}
        {isSuperAdmin && allOrgs?.clubs && allOrgs.clubs.length > 0 ? (
          <OrgSwitcher
            orgs={allOrgs.clubs}
            activeOrgId={activeOrgId ?? null}
            onSwitch={setActiveOrg}
            collapsed={collapsed}
          />
        ) : !collapsed ? (
          <div className="px-4 py-2.5 border-b border-white/5 flex-shrink-0">
            <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider mb-0.5">{t('organization')}</p>
            <div className="flex items-center gap-2 text-sm font-semibold text-white">
              <div className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse flex-shrink-0" />
              <span className="truncate">{user?.organizationName || 'System Admin'}</span>
            </div>
          </div>
        ) : null}

        {/* Navigation */}
        <nav className={`flex-1 overflow-y-auto ${collapsed ? 'p-1 space-y-0.5' : 'py-2 overflow-x-hidden'}`}>
          {collapsed ? (
            // Collapsed: flat icon list with tooltips
            allVisibleItems.map((item) => {
              const isActive = location === item.path || (item.path !== '/' && location.startsWith(item.path));
              return (
                <Link key={item.path + item.name} href={item.path} className="block">
                  <div
                    title={t('items.' + (ITEM_T_KEYS[item.name] ?? item.name), { defaultValue: item.name })}
                    className={`relative group flex items-center justify-center w-8 h-8 rounded-lg mx-auto transition-all duration-200
                      ${isActive ? 'bg-primary/20 text-white border border-primary/40' : 'text-muted-foreground hover:bg-white/5 hover:text-foreground'}
                    `}
                  >
                    <item.icon className="w-4 h-4 flex-shrink-0" />
                    {item.noticeBadge && noticeUnreadCount > 0 && (
                      <span className="absolute -top-0.5 -right-0.5 min-w-[14px] h-3.5 px-0.5 rounded-full bg-primary text-[9px] font-bold text-primary-foreground flex items-center justify-center leading-none">
                        {noticeUnreadCount > 99 ? '99+' : noticeUnreadCount}
                      </span>
                    )}
                    {item.pendingDocsBadge && pendingDocsCount > 0 && (
                      <span className="absolute -top-0.5 -right-0.5 min-w-[14px] h-3.5 px-0.5 rounded-full bg-amber-500 text-[9px] font-bold text-black flex items-center justify-center leading-none">
                        {pendingDocsCount > 99 ? '99+' : pendingDocsCount}
                      </span>
                    )}
                    {item.moderationBadge && moderationCount > 0 && (
                      <span className="absolute -top-0.5 -right-0.5 min-w-[14px] h-3.5 px-0.5 rounded-full bg-primary text-[9px] font-bold text-primary-foreground flex items-center justify-center leading-none">
                        {moderationCount > 99 ? '99+' : moderationCount}
                      </span>
                    )}
                    <span className="pointer-events-none absolute ltr:left-full rtl:right-full ltr:ms-2 rtl:me-2 z-50 whitespace-nowrap rounded-md bg-black/90 border border-white/10 px-2 py-1 text-xs text-white opacity-0 group-hover:opacity-100 transition-opacity shadow-lg">
                      {t('items.' + (ITEM_T_KEYS[item.name] ?? item.name), { defaultValue: item.name })}
                    </span>
                  </div>
                </Link>
              );
            })
          ) : (
            // Expanded: grouped sections with collapsible headers
            visibleSections.map((section) => {
              const isOpenSection = sectionOpen[section.id] ?? false;
              const hasActiveItem = section.items.some(item =>
                location === item.path || (item.path !== '/' && location.startsWith(item.path))
              );

              return (
                <div key={section.id} className="mb-0.5">
                  {/* Section header — single-item sections (Overview) skip the toggle */}
                  {section.items.length === 1 ? (
                    // Single-item section: render just the item, no header
                    (() => {
                      const item = section.items[0];
                      const isActive = location === item.path || (item.path !== '/' && location.startsWith(item.path));
                      return (
                        <div className="px-2 mb-0.5">
                          <Link href={item.path} className="block">
                            <div className={`
                              flex items-center gap-2.5 px-2.5 py-2 rounded-lg transition-all duration-150 group
                              ${isActive
                                ? 'bg-primary/20 text-white font-semibold border border-primary/40'
                                : 'text-muted-foreground hover:bg-white/5 hover:text-foreground'
                              }
                            `}>
                              <item.icon className={`w-4 h-4 flex-shrink-0 ${isActive ? 'text-primary' : 'group-hover:text-foreground'}`} />
                              <span className="text-sm">{t('items.' + (ITEM_T_KEYS[item.name] ?? item.name), { defaultValue: item.name })}</span>
                            </div>
                          </Link>
                        </div>
                      );
                    })()
                  ) : (
                    <>
                      {/* Collapsible section header */}
                      <button
                        onClick={() => toggleSection(section.id)}
                        className={`w-full flex items-center gap-1.5 px-4 py-1.5 text-left transition-colors group ${
                          hasActiveItem && !isOpenSection ? 'text-primary/80' : 'text-muted-foreground hover:text-foreground/70'
                        }`}
                      >
                        <span className="text-[10px] uppercase tracking-widest font-semibold flex-1 truncate">
                          {t('sections.' + section.id, { defaultValue: section.label })}
                        </span>
                        {hasActiveItem && !isOpenSection && (
                          <span className="w-1.5 h-1.5 rounded-full bg-primary flex-shrink-0" />
                        )}
                        <ChevronDown className={`w-3 h-3 flex-shrink-0 transition-transform duration-200 ${isOpenSection ? '' : '-rotate-90'}`} />
                      </button>

                      {/* Section items */}
                      {isOpenSection && (
                        <div className="px-2 space-y-0.5 mb-1">
                          {section.items.map((item) => {
                            const isActive = location === item.path || (item.path !== '/' && location.startsWith(item.path));
                            return (
                              <Link key={item.path + item.name} href={item.path} className="block">
                                <div className={`
                                  flex items-center gap-2.5 px-2.5 py-2 rounded-lg transition-all duration-150 group
                                  ${isActive
                                    ? 'bg-primary/20 text-white font-semibold border border-primary/40'
                                    : 'text-muted-foreground hover:bg-white/5 hover:text-foreground'
                                  }
                                `}>
                                  <item.icon className={`w-4 h-4 flex-shrink-0 ${isActive ? 'text-primary' : 'group-hover:text-foreground'}`} />
                                  <span className="text-sm">{t('items.' + (ITEM_T_KEYS[item.name] ?? item.name), { defaultValue: item.name })}</span>
                                  {item.noticeBadge && noticeUnreadCount > 0 && (
                                    <span className="ms-auto min-w-[18px] h-[18px] px-1 rounded-full bg-primary text-[10px] font-bold text-primary-foreground flex items-center justify-center leading-none">
                                      {noticeUnreadCount > 99 ? '99+' : noticeUnreadCount}
                                    </span>
                                  )}
                                  {item.pendingDocsBadge && pendingDocsCount > 0 && (
                                    <span className="ms-auto min-w-[18px] h-[18px] px-1 rounded-full bg-amber-500 text-[10px] font-bold text-black flex items-center justify-center leading-none">
                                      {pendingDocsCount > 99 ? '99+' : pendingDocsCount}
                                    </span>
                                  )}
                                  {item.moderationBadge && moderationCount > 0 && (
                                    <span className="ms-auto min-w-[18px] h-[18px] px-1 rounded-full bg-primary text-[10px] font-bold text-primary-foreground flex items-center justify-center leading-none">
                                      {moderationCount > 99 ? '99+' : moderationCount}
                                    </span>
                                  )}
                                  {isActive && !item.noticeBadge && !item.pendingDocsBadge && !item.moderationBadge && <ChevronRight className="w-3 h-3 ms-auto opacity-40 flex-shrink-0" />}
                                </div>
                              </Link>
                            );
                          })}
                        </div>
                      )}
                    </>
                  )}
                </div>
              );
            })
          )}
        </nav>

        {/* Plan strip */}
        {isAdmin && !isSuperAdmin && (
          <div className={`flex-shrink-0 border-t border-white/5 ${collapsed ? 'py-1 px-1' : 'py-1 px-2'}`}>
            {collapsed
              ? <PlanStripCollapsed orgId={effectiveOrgId ?? undefined} />
              : <PlanStrip orgId={effectiveOrgId ?? undefined} />
            }
          </div>
        )}

        {/* User footer */}
        <UserFooter collapsed={collapsed} user={user} />

        {/* Collapse toggle */}
        <button
          onClick={toggleCollapse}
          title={collapsed ? t('expandSidebar') : t('collapseSidebar')}
          className="absolute top-[60px] -right-3 z-30 w-6 h-6 rounded-full bg-card border border-white/10 flex items-center justify-center text-muted-foreground hover:text-white hover:border-white/30 transition-all shadow-md"
        >
          {collapsed ? <ChevronRight className="w-3 h-3" /> : <ChevronLeft className="w-3 h-3" />}
        </button>
      </motion.aside>

      {/* Main Content */}
      <main
        id="main-content"
        tabIndex={-1}
        className="flex-1 min-w-0 flex flex-col relative overflow-hidden focus:outline-none"
        style={{ transition: 'margin-left 0.25s ease' }}
      >
        <div className="absolute inset-0 pointer-events-none z-0" aria-hidden="true">
          <div className="absolute top-0 right-0 w-[500px] h-[500px] bg-primary/5 rounded-full blur-[120px] mix-blend-screen" />
          <div className="absolute bottom-0 left-0 w-[500px] h-[500px] bg-emerald-500/5 rounded-full blur-[120px] mix-blend-screen" />
        </div>
        <div className="flex-1 min-w-0 overflow-y-auto z-10">
          {children}
        </div>
      </main>
    </div>
  );
}
