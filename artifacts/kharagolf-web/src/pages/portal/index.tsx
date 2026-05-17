import { useState, useEffect, useRef, useCallback } from 'react';
import { useLocation } from 'wouter';
import { Loader2, Trophy, Flag, BarChart3, LogOut, User, CheckCircle, AlertCircle, ChevronRight, ExternalLink, CreditCard, ShieldAlert, ShieldCheck, XCircle, Download, Users, RefreshCcw, Bell, LogOutIcon, Camera, Trash2, ShoppingBag, Heart, Package, Truck, PenLine, Lock, Gift, Star, Coins, FileText, DollarSign, Clock, Calendar, MapPin, Globe, BookOpen, Printer } from 'lucide-react';
import { markdownToHtml } from '@/lib/markdown';
import { KharaGolfWordmark } from '@/components/kharagolf-brand';
import { PreAuthBrand } from '@/components/PreAuthBrand';
import { useOrgBranding } from '@/lib/theme/OrgThemeProvider';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useToast } from '@/hooks/use-toast';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { AVATAR_PRESETS, resolveAvatarSrc, isPresetAvatar } from '@/lib/avatarPresets';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { useTranslation } from 'react-i18next';
import i18n, { applyLanguageDirection, type SupportedLanguage } from '@/i18n';
import { PriceWithFx } from '@/components/PriceWithFx';
import { PortalCommPrefs } from './PortalCommPrefs';
import { MyUpcomingWidget } from '@/components/MyUpcomingWidget';
import { UpcomingFullList } from '@/components/UpcomingFullList';
import {
  STATUS_COLORS,
  type PlayerUser,
  type LeagueRow,
  type MembershipInfo,
  type MembershipTier,
  type DuesInvoice,
  type MyTeeBooking,
  type LockerAssignment,
  type LockerWaitlistEntry,
} from './types';
import { LeaguesTab } from './LeaguesTab';
import { InvoicesTab } from './InvoicesTab';
import { LockerTab } from './LockerTab';
import { TeeBookingsTab } from './TeeBookingsTab';
import { MembershipTab } from './MembershipTab';
import { ProfileTab } from './ProfileTab';

const API = (path: string) => `/api${path}`;

declare global {
  interface Window {
    Razorpay: new (options: Record<string, unknown>) => { open(): void };
  }
}

interface TournamentRow {
  playerId: number;
  tournamentId: number;
  tournamentName: string;
  tournamentStatus: string;
  startDate: string | null;
  endDate: string | null;
  paymentStatus: string;
  checkedIn: boolean;
  tournamentFormat: string;
  handicapIndex: string | null;
  leaderboardType?: string | null;
  selfPosting?: boolean;
  markerValidation?: boolean;
}

interface RankingHistoryEntry {
  id: number;
  seriesId: number;
  seriesName: string | null;
  seriesLevel: string | null;
  seriesStatus: string | null;
  seasonStart: string | null;
  seasonEnd: string | null;
  category: string;
  totalPoints: number;
  eventsPlayed: number;
  wins: number;
  runnerUps: number;
  top3: number;
  position: number | null;
  history: {
    id: number;
    tournamentId: number;
    tournamentName: string | null;
    tournamentDate: string | null;
    position: number;
    pointsAwarded: number;
    awardedAt: string;
  }[];
}

interface Stats {
  tournamentsPlayed: number;
  totalScores: number;
  averageStrokes: number | null;
  bestRound: number | null;
  handicapTrend?: { handicapIndex: number; recordedAt: string | null }[];
  courseBreakdown?: { courseId: number; courseName: string; rounds: number; avgGross: number; bestGross: number }[];
}

const PORTAL_KNOWN_TABS = new Set([
  'tournaments', 'leagues', 'membership', 'orders', 'wishlist',
  'locker', 'rankings', 'loyalty', 'invoices', 'levies',
  'tee-bookings', 'upcoming', 'profile',
]);

export default function PlayerPortal() {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const { t } = useTranslation(['profile', 'common', 'portal']);

  // Active tab inside the dashboard. Defaults to "tournaments" but can be
  // deep-linked via ?tab= (e.g. from the home Upcoming widget rows). Unknown
  // values fall back to the default so a stale link can't leave the dashboard
  // with no active tab.
  const [portalTab, setPortalTab] = useState<string>(() => {
    if (typeof window === 'undefined') return 'tournaments';
    const requested = new URLSearchParams(window.location.search).get('tab');
    return requested && PORTAL_KNOWN_TABS.has(requested) ? requested : 'tournaments';
  });

  // Auth state
  const [user, setUser] = useState<PlayerUser | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [view, setView] = useState<'login' | 'register' | 'forgot' | 'verify-sent' | 'claim' | 'dashboard'>('login');

  // Login form
  const [loginEmail, setLoginEmail] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [loginLoading, setLoginLoading] = useState(false);
  const [loginError, setLoginError] = useState('');
  const [unverified, setUnverified] = useState(false);

  // Register form
  const [regEmailDelivered, setRegEmailDelivered] = useState(true);
  const [regFirstName, setRegFirstName] = useState('');
  const [regLastName, setRegLastName] = useState('');
  const [regEmail, setRegEmail] = useState('');
  const [regPassword, setRegPassword] = useState('');
  const [regConfirm, setRegConfirm] = useState('');
  const [regMemberNumber, setRegMemberNumber] = useState('');
  const [regLoading, setRegLoading] = useState(false);
  const [regError, setRegError] = useState('');

  // Claim account (invite link flow)
  const [claimToken, setClaimToken] = useState('');
  const [claimPassword, setClaimPassword] = useState('');
  const [claimConfirm, setClaimConfirm] = useState('');
  const [claimLoading, setClaimLoading] = useState(false);
  const [claimError, setClaimError] = useState('');
  const [adminPreviewDismissed, setAdminPreviewDismissed] = useState(false);

  // Forgot password form
  const [forgotEmail, setForgotEmail] = useState('');
  const [forgotLoading, setForgotLoading] = useState(false);
  const [forgotSent, setForgotSent] = useState(false);

  // Dashboard data
  const [stats, setStats] = useState<Stats | null>(null);
  const [tournaments, setTournaments] = useState<TournamentRow[]>([]);
  const [leagues, setLeagues] = useState<LeagueRow[]>([]);
  const [rankingHistory, setRankingHistory] = useState<RankingHistoryEntry[]>([]);
  const [membership, setMembership] = useState<MembershipInfo | null | undefined>(undefined);
  const [cancelLoading, setCancelLoading] = useState(false);
  const [dashLoading, setDashLoading] = useState(false);

  // Task #406 — club Local Rules viewer
  const [localRulesContent, setLocalRulesContent] = useState<string>('');
  const [organizationName, setOrganizationName] = useState<string>('');
  const [organizationLogoUrl, setOrganizationLogoUrl] = useState<string | null>(null);
  const [localRulesOpen, setLocalRulesOpen] = useState(false);
  const handlePrintLocalRules = useCallback(() => {
    if (!localRulesContent.trim()) return;
    const html = markdownToHtml(localRulesContent);
    const w = window.open('', '_blank', 'width=900,height=720');
    if (!w) return;
    const escapeHtml = (s: string) => s.replace(/[&<>"']/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string
    ));
    // Task #844 — When the club has uploaded a logo, mirror the mobile PDF
    // header (logo above the club name) so branding is consistent across web
    // and mobile printouts. Falls back to the original text-only header when
    // no logo is configured, to avoid changing the look for clubs that haven't
    // set one up.
    const headerHtml = organizationLogoUrl
      ? `<header class="brand">
  ${organizationName ? `<div class="club">${escapeHtml(organizationName)}</div>` : ''}
  <img class="logo" src="${escapeHtml(organizationLogoUrl)}" alt="" />
  <div class="doc-title">Local Rules</div>
</header>`
      : `<header>Local Rules</header>`;
    w.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Local Rules</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #111; max-width: 720px; margin: 32px auto; padding: 0 24px; line-height: 1.55; }
  h1 { font-size: 24px; margin-top: 18px; }
  h2 { font-size: 19px; margin-top: 16px; }
  h3 { font-size: 16px; margin-top: 12px; }
  p, li { font-size: 14px; }
  code { background: #f0f0f0; padding: 1px 4px; border-radius: 3px; font-family: ui-monospace, Menlo, monospace; font-size: 13px; }
  ul, ol { padding-left: 22px; }
  header { border-bottom: 1px solid #ddd; padding-bottom: 8px; margin-bottom: 16px; color: #555; font-size: 12px; }
  @media print { header { color: #888; } }
  header.brand { border-bottom: 3px solid #00ff88; padding-bottom: 14px; margin-bottom: 22px; color: inherit; font-size: inherit; }
  header.brand .club { font-size: 22px; font-weight: 700; color: #0b3d2a; line-height: 1.2; }
  header.brand .logo { display: block; max-height: 64px; max-width: 220px; height: auto; width: auto; margin: 8px 0 6px; object-fit: contain; }
  header.brand .doc-title { font-size: 14px; font-weight: 600; color: #1a1a1a; margin-top: 10px; }
</style></head><body>
${headerHtml}
${html}
<script>
  window.onload = function(){
    var imgs = document.images;
    var pending = 0;
    function go(){ setTimeout(function(){ window.print(); }, 100); }
    for (var i = 0; i < imgs.length; i++) {
      if (!imgs[i].complete) {
        pending++;
        imgs[i].addEventListener('load', function(){ if (--pending === 0) go(); });
        imgs[i].addEventListener('error', function(){ if (--pending === 0) go(); });
      }
    }
    if (pending === 0) go();
  };
</script>
</body></html>`);
    w.document.close();
  }, [localRulesContent, organizationName, organizationLogoUrl]);

  // Locker data
  const [lockerAssignment, setLockerAssignment] = useState<LockerAssignment | null | undefined>(undefined);
  const [lockerWaitlist, setLockerWaitlist] = useState<LockerWaitlistEntry | null>(null);
  const [joiningWaitlist, setJoiningWaitlist] = useState(false);

  // Loyalty programme
  interface LoyaltyAccountData {
    account: { pointsBalance: number; lifetimePoints: number; rollingYearPoints: number; currentTier: string };
    programme: { pointsName: string; isEnabled: boolean } | null;
    currentTierDef: { label: string; perks: string[]; multiplier: string } | null;
    nextTier: { tier: string; label: string; minPoints: number } | null;
    pointsToNextTier: number | null;
  }
  interface LoyaltyReward { id: number; name: string; description: string | null; pointsCost: number; rewardType: string; minTier: string; }
  const [loyaltyData, setLoyaltyData] = useState<LoyaltyAccountData | null>(null);
  const [loyaltyRewards, setLoyaltyRewards] = useState<LoyaltyReward[]>([]);
  const [redeemingId, setRedeemingId] = useState<number | null>(null);

  // Dues invoices
  const [myInvoices, setMyInvoices] = useState<DuesInvoice[]>([]);

  // Outstanding levy charges (member-initiated online payment)
  interface LevyChargeRow {
    charge: {
      id: number;
      levyId: number;
      clubMemberId: number;
      amount: string;
      paidAmount: string;
      refundedAmount: string;
      status: string;
      paid: boolean;
      paidAt: string | null;
      createdAt: string;
    };
    levy: {
      id: number;
      name: string;
      currency: string;
      description: string | null;
    };
  }
  const [levyCharges, setLevyCharges] = useState<LevyChargeRow[]>([]);
  const [statementOutstanding, setStatementOutstanding] = useState<string>('0.00');
  const [payingChargeId, setPayingChargeId] = useState<number | null>(null);
  const [partialDialogCharge, setPartialDialogCharge] = useState<LevyChargeRow | null>(null);
  const [partialDialogAmount, setPartialDialogAmount] = useState<string>('');

  // Marketplace tee time bookings
  const [myTeeBookings, setMyTeeBookings] = useState<MyTeeBooking[]>([]);
  const [cancellingBookingId, setCancellingBookingId] = useState<number | null>(null);

  // Notification preferences
  const [notifPrefs, setNotifPrefs] = useState({ preferEmail: true, preferPush: true, preferSms: false, preferWhatsapp: false, notifyMemberDocuments: true, notifyCommitteePeerDigest: true });
  const [notifCaps, setNotifCaps] = useState({ hasPhone: false, hasPushToken: false, isCommitteeMember: false });
  const [savingNotifPref, setSavingNotifPref] = useState(false);

  // Per-category member communication preferences are owned by `PortalCommPrefs`
  // (extracted to a sub-component so it can be unit-tested without driving the
  // full PlayerPortal auth + dashboard render path — see Task #648).

  // Task #1270 — one-time backfill announcement card pointing existing
  // members at the new "Side-game payment receipts" toggle. Lazily
  // populated by `GET /api/portal/announcements/side-game-receipt-toggle`
  // and dismissed via the matching POST. Newly-registered members never
  // see it (the API gates eligibility on `clubMembers.createdAt`).
  interface SideGameReceiptToggleAnnouncement {
    id: number;
    subject: string;
    body: string;
    sentAt: string;
    prefsUrl: string;
    prefsAnchor: string;
  }
  const [sideGameToggleAnnouncement, setSideGameToggleAnnouncement] =
    useState<SideGameReceiptToggleAnnouncement | null>(null);
  const [dismissingSideGameToggleAnnouncement, setDismissingSideGameToggleAnnouncement] =
    useState(false);

  // GHIN number
  const [ghinNumber, setGhinNumber] = useState<string>('');
  const [ghinSaved, setGhinSaved] = useState<string | null>(null);
  const [savingGhin, setSavingGhin] = useState(false);
  const [savingLang, setSavingLang] = useState(false);

  // Membership self-subscribe state
  const [tiers, setTiers] = useState<MembershipTier[]>([]);
  const [tiersLoading, setTiersLoading] = useState(false);
  const [subscribeTierId, setSubscribeTierId] = useState<number | ''>('');
  const [subscribeLoading, setSubscribeLoading] = useState(false);
  const [showInDirectory, setShowInDirectory] = useState<boolean | null>(null);
  const [directoryOptLoading, setDirectoryOptLoading] = useState(false);

  // Self-withdrawal state
  const [withdrawingTournamentId, setWithdrawingTournamentId] = useState<number | null>(null);
  const [withdrawLoading, setWithdrawLoading] = useState(false);
  const [withdrawnTournaments, setWithdrawnTournaments] = useState<Map<number, { refundPending: boolean }>>(new Map());

  // Shop orders and wishlist
  interface PortalOrder {
    id: number;
    productId: number | null;
    size: string | null;
    quantity: number;
    unitPrice?: string;
    totalAmount: string;
    currency: string;
    status: string;
    trackingNumber: string | null;
    trackingUrl: string | null;
    createdAt: string;
    productName: string | null;
    productImage: string | null;
  }
  interface PortalWishlistItem {
    wishlistId: number;
    createdAt: string;
    product: {
      id: number;
      name: string;
      imageUrl: string | null;
      markupPrice: string;
      currency: string;
      category: string;
    };
  }
  const [myOrders, setMyOrders] = useState<PortalOrder[]>([]);
  const [myWishlist, setMyWishlist] = useState<PortalWishlistItem[]>([]);

  const PORTAL_ORDER_STATUS_COLORS: Record<string, string> = {
    pending: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30',
    paid: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
    processing: 'bg-purple-500/20 text-purple-400 border-purple-500/30',
    shipped: 'bg-cyan-500/20 text-cyan-400 border-cyan-500/30',
    delivered: 'bg-green-500/20 text-green-400 border-green-500/30',
    cancelled: 'bg-gray-500/20 text-gray-400 border-gray-500/30',
    refunded: 'bg-red-500/20 text-red-400 border-red-500/30',
  };
  const PORTAL_CURRENCY_SYM: Record<string, string> = { INR: '₹', USD: '$', GBP: '£', EUR: '€', AED: 'د.إ', SGD: 'S$', AUD: 'A$' };
  const portalFmtPrice = (price: string | number, currency: string) =>
    `${PORTAL_CURRENCY_SYM[currency] ?? currency}${parseFloat(String(price)).toLocaleString(i18n.language || undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

  // Avatar upload state
  const [avatarModalOpen, setAvatarModalOpen] = useState(false);
  const [avatarModalTab, setAvatarModalTab] = useState<'upload' | 'preset'>('upload');
  const [avatarUploading, setAvatarUploading] = useState(false);
  const [avatarPreviewSrc, setAvatarPreviewSrc] = useState<string | null>(null);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [minZoom, setMinZoom] = useState(0.05);
  const [cropZoom, setCropZoom] = useState(0.05);
  const [cropOffset, setCropOffset] = useState({ x: 0, y: 0 });
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const cropCanvasRef = useRef<HTMLCanvasElement>(null);
  const cropImgRef = useRef<HTMLImageElement | null>(null);
  const cropDragRef = useRef<{ startX: number; startY: number; offsetX: number; offsetY: number } | null>(null);
  const touchDragRef = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);

  // Redraw crop canvas when zoom/offset/image changes
  useEffect(() => {
    if (!avatarPreviewSrc || !cropCanvasRef.current) return;
    const canvas = cropCanvasRef.current;
    const ctx = canvas.getContext('2d')!;
    const SIZE = 240;
    canvas.width = SIZE; canvas.height = SIZE;
    const img = cropImgRef.current ?? new Image();
    if (!cropImgRef.current) {
      cropImgRef.current = img;
      img.onload = () => {
        const fitZoom = SIZE / Math.min(img.naturalWidth, img.naturalHeight);
        setMinZoom(fitZoom);
        setCropZoom(fitZoom);
        drawCrop(ctx, img, SIZE, fitZoom, { x: 0, y: 0 });
      };
      img.src = avatarPreviewSrc;
    } else {
      drawCrop(ctx, img, SIZE, cropZoom, cropOffset);
    }
  }, [avatarPreviewSrc, cropZoom, cropOffset]);

  function drawCrop(ctx: CanvasRenderingContext2D, img: HTMLImageElement, SIZE: number, zoom: number, offset: { x: number; y: number }) {
    ctx.clearRect(0, 0, SIZE, SIZE);
    ctx.save();
    ctx.beginPath();
    ctx.arc(SIZE / 2, SIZE / 2, SIZE / 2, 0, Math.PI * 2);
    ctx.clip();
    const iw = img.naturalWidth * zoom;
    const ih = img.naturalHeight * zoom;
    ctx.drawImage(img, (SIZE - iw) / 2 + offset.x, (SIZE - ih) / 2 + offset.y, iw, ih);
    ctx.restore();
    ctx.beginPath();
    ctx.arc(SIZE / 2, SIZE / 2, SIZE / 2 - 1, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.3)';
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  const handleCropMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    cropDragRef.current = { startX: e.clientX, startY: e.clientY, offsetX: cropOffset.x, offsetY: cropOffset.y };
  }, [cropOffset]);

  const handleCropMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!cropDragRef.current) return;
    const dx = e.clientX - cropDragRef.current.startX;
    const dy = e.clientY - cropDragRef.current.startY;
    setCropOffset({ x: cropDragRef.current.offsetX + dx, y: cropDragRef.current.offsetY + dy });
  }, []);

  const handleCropMouseUp = useCallback(() => { cropDragRef.current = null; }, []);

  const handleCropWheel = useCallback((e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    setCropZoom(prev => Math.max(minZoom, Math.min(minZoom * 4, prev - e.deltaY * 0.0008 * minZoom * 4)));
  }, [minZoom]);

  const handleTouchStart = useCallback((e: React.TouchEvent<HTMLCanvasElement>) => {
    if (e.touches.length === 1) {
      const t = e.touches[0];
      touchDragRef.current = { x: t.clientX, y: t.clientY, ox: cropOffset.x, oy: cropOffset.y };
    }
  }, [cropOffset]);

  const handleTouchMove = useCallback((e: React.TouchEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    if (e.touches.length === 1 && touchDragRef.current) {
      const t = e.touches[0];
      setCropOffset({ x: touchDragRef.current.ox + t.clientX - touchDragRef.current.x, y: touchDragRef.current.oy + t.clientY - touchDragRef.current.y });
    }
  }, []);

  const handleTouchEnd = useCallback(() => { touchDragRef.current = null; }, []);

  // Check URL for verify-email token or invite claim action
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const verifyToken = params.get('token');
    const action = params.get('action');

    if (action === 'reset-password') {
      return;
    }

    if (action === 'claim') {
      const token = params.get('token');
      if (token) {
        setClaimToken(token);
        setView('claim');
      }
      return;
    }

    if (verifyToken) {
      fetch(API('/auth/verify-email'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: verifyToken }),
      })
        .then(r => r.json())
        .then(d => {
          if (d.message) {
            toast({ title: t('portal:emailVerified'), description: t('portal:emailVerifiedDesc') });
          } else {
            toast({ title: t('portal:verificationFailed'), description: d.error, variant: 'destructive' });
          }
          navigate('/portal');
        })
        .catch(() => navigate('/portal'));
    }
  }, []);

  // Check if already logged in
  useEffect(() => {
    fetch(API('/portal/me'), { credentials: 'include' })
      .then(r => r.ok ? r.json() : null)
      .then(u => {
        if (u?.id) {
          setUser(u);
          setView('dashboard');
          loadDashboard(u.organizationId);
          if (u.preferredLanguage && u.preferredLanguage !== i18n.language) {
            i18n.changeLanguage(u.preferredLanguage);
            applyLanguageDirection(u.preferredLanguage);
          }
        }
      })
      .finally(() => setAuthLoading(false));
  }, []);

  async function loadDashboard(orgIdParam?: number) {
    setDashLoading(true);
    try {
      const [s, t, l, m, np, gh, lockerData, rankData] = await Promise.all([
        fetch(API('/portal/my-stats'), { credentials: 'include' }).then(r => { if (!r.ok) throw new Error('Request failed'); return r.json(); }),
        fetch(API('/portal/my-tournaments'), { credentials: 'include' }).then(r => { if (!r.ok) throw new Error('Request failed'); return r.json(); }),
        fetch(API('/portal/my-leagues'), { credentials: 'include' }).then(r => { if (!r.ok) throw new Error('Request failed'); return r.json(); }),
        fetch(API('/portal/membership'), { credentials: 'include' }).then(r => r.ok ? r.json() : null),
        fetch(API('/portal/notification-preferences'), { credentials: 'include' }).then(r => r.ok ? r.json() : null),
        fetch(API('/portal/ghin'), { credentials: 'include' }).then(r => r.ok ? r.json() : null),
        fetch(API('/portal/locker'), { credentials: 'include' }).then(r => r.ok ? r.json() : null),
        fetch(API('/portal/rankings/history'), { credentials: 'include' }).then(r => r.ok ? r.json() : []),
      ]);
      setStats(s);
      setTournaments(Array.isArray(t) ? t : []);
      setLeagues(Array.isArray(l) ? l : []);
      setRankingHistory(Array.isArray(rankData) ? rankData : []);
      setMembership(m as MembershipInfo | null);
      if (np) {
        setNotifPrefs({ preferEmail: !!np.preferEmail, preferPush: !!np.preferPush, preferSms: !!np.preferSms, preferWhatsapp: !!np.preferWhatsapp, notifyMemberDocuments: np.notifyMemberDocuments !== false, notifyCommitteePeerDigest: np.notifyCommitteePeerDigest !== false });
        setNotifCaps({ hasPhone: !!np.hasPhone, hasPushToken: !!np.hasPushToken, isCommitteeMember: !!np.isCommitteeMember });
      }
      if (gh?.ghinNumber) { setGhinNumber(gh.ghinNumber); setGhinSaved(gh.ghinNumber); }
      if (lockerData) {
        setLockerAssignment(lockerData.assignment ?? null);
        setLockerWaitlist(lockerData.waitlistEntry ?? null);
      }
      // Fetch tiers only if the user is org-linked (needed for self-subscribe)
      fetch(API('/portal/membership/tiers'), { credentials: 'include' })
        .then(r => r.ok ? r.json() : [])
        .then((tiersData: unknown[]) => setTiers(tiersData as MembershipTier[]));
      // Task #1270 — best-effort fetch of the side-game-receipt-toggle
      // backfill announcement. Returns `{ announcement: null }` for
      // newly-registered members, multi-club members who already
      // dismissed it, or anyone without a club_members row.
      fetch(API('/portal/announcements/side-game-receipt-toggle'), { credentials: 'include' })
        .then(r => (r.ok ? r.json() : null))
        .then((data: { announcement: SideGameReceiptToggleAnnouncement | null } | null) => {
          if (data?.announcement) setSideGameToggleAnnouncement(data.announcement);
        })
        .catch(() => {});
      // Shop orders and wishlist (org-scoped)
      const resolvedOrgId = orgIdParam ?? user?.organizationId;
      if (resolvedOrgId) {
        // Loyalty
        Promise.all([
          fetch(`/api/organizations/${resolvedOrgId}/loyalty/me`, { credentials: 'include' }).then(r => r.ok ? r.json() : null),
          fetch(`/api/organizations/${resolvedOrgId}/loyalty/rewards`, { credentials: 'include' }).then(r => r.ok ? r.json() : []),
        ]).then(([loyaltyAcc, rewards]) => {
          if (loyaltyAcc?.account) setLoyaltyData(loyaltyAcc as LoyaltyAccountData);
          setLoyaltyRewards(Array.isArray(rewards) ? rewards : []);
        }).catch(() => {});
        fetch(`/api/organizations/${resolvedOrgId}/shop/my-orders`, { credentials: 'include' })
          .then(r => r.ok ? r.json() : [])
          .then((orders: PortalOrder[]) => setMyOrders(orders));
        fetch(`/api/organizations/${resolvedOrgId}/shop/wishlist`, { credentials: 'include' })
          .then(r => r.ok ? r.json() : [])
          .then((wl: PortalWishlistItem[]) => setMyWishlist(wl));
        fetch(`/api/organizations/${resolvedOrgId}/dues-billing/my-invoices`, { credentials: 'include' })
          .then(r => r.ok ? r.json() : [])
          .then((inv: DuesInvoice[]) => setMyInvoices(Array.isArray(inv) ? inv : []));
        loadMyStatement();
        fetch(`/api/organizations/${resolvedOrgId}/marketplace/my-bookings`, { credentials: 'include' })
          .then(r => r.ok ? r.json() : [])
          .then((bookings: MyTeeBooking[]) => setMyTeeBookings(Array.isArray(bookings) ? bookings : []))
          .catch(() => {});
        // Task #406 — fetch the club's Local Rules so players can review them.
        fetch(`/api/organizations/${resolvedOrgId}/rules-config`, { credentials: 'include' })
          .then(r => r.ok ? r.json() : null)
          .then((data: { localRulesContent?: string; organizationName?: string; logoUrl?: string | null } | null) => {
            setLocalRulesContent((data?.localRulesContent ?? '').trim());
            // Task #844 — keep the club name + logo around so the printable
            // Local Rules header matches the mobile PDF branding.
            setOrganizationName(data?.organizationName ?? '');
            setOrganizationLogoUrl(data?.logoUrl ?? null);
          })
          .catch(() => {});
      }
    } finally {
      setDashLoading(false);
    }
  }

  async function loadMyStatement() {
    try {
      const r = await fetch(API('/portal/my-statement'), { credentials: 'include' });
      if (!r.ok) return;
      const data = await r.json();
      setLevyCharges(Array.isArray(data?.levyCharges) ? data.levyCharges : []);
      if (typeof data?.outstandingBalance === 'string') setStatementOutstanding(data.outstandingBalance);
    } catch {}
  }

  function levyRemaining(row: LevyChargeRow): number {
    const total = parseFloat(String(row.charge.amount ?? '0'));
    const paid = parseFloat(String(row.charge.paidAmount ?? '0'));
    const refunded = parseFloat(String(row.charge.refundedAmount ?? '0'));
    return Math.max(0, Math.round((total - paid - refunded) * 100) / 100);
  }

  async function ensureRazorpayLoaded(): Promise<void> {
    if (window.Razorpay) return;
    await new Promise<void>((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://checkout.razorpay.com/v1/checkout.js';
      script.onload = () => resolve();
      script.onerror = () => reject(new Error('Failed to load Razorpay'));
      document.head.appendChild(script);
    });
  }

  async function payLevyCharge(chargeId: number, amountOverride?: number) {
    if (payingChargeId) return;
    setPayingChargeId(chargeId);
    // We only keep `payingChargeId` set if Razorpay's modal actually opens —
    // every early-exit (network/order error, script load failure, exception)
    // must clear it so the buttons don't stay disabled forever.
    let modalOpened = false;
    try {
      const orderRes = await fetch(API(`/portal/levies/charges/${chargeId}/order`), {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(amountOverride != null ? { amount: amountOverride } : {}),
      });
      const orderData = await orderRes.json().catch(() => ({}));
      if (!orderRes.ok) {
        toast({ title: orderData.error ?? 'Could not start payment', variant: 'destructive' });
        return;
      }
      try { await ensureRazorpayLoaded(); }
      catch { toast({ title: 'Could not load payment processor', variant: 'destructive' }); return; }

      const rzp = new window.Razorpay({
        key: orderData.keyId,
        order_id: orderData.orderId,
        amount: orderData.amount,
        currency: orderData.currency,
        name: orderData.levyName ?? 'Levy Payment',
        description: `Levy charge #${chargeId}`,
        prefill: { email: user?.email ?? undefined, name: user?.displayName ?? undefined },
        handler: async (response: { razorpay_payment_id: string; razorpay_order_id: string; razorpay_signature: string }) => {
          try {
            const verifyRes = await fetch(API(`/portal/levies/charges/${chargeId}/verify`), {
              method: 'POST',
              credentials: 'include',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                razorpayOrderId: response.razorpay_order_id,
                razorpayPaymentId: response.razorpay_payment_id,
                razorpaySignature: response.razorpay_signature,
              }),
            });
            const verifyData = await verifyRes.json().catch(() => ({}));
            if (!verifyRes.ok) {
              toast({ title: verifyData.error ?? 'Payment verification failed', variant: 'destructive' });
              return;
            }
            toast({
              title: verifyData.alreadyApplied
                ? 'Payment already recorded'
                : verifyData.fullySettled
                  ? 'Levy paid in full'
                  : `Partial payment received — balance ${verifyData.remainingBalance}`,
            });
            loadMyStatement();
          } catch {
            toast({ title: 'Payment verification failed', variant: 'destructive' });
          } finally {
            setPayingChargeId(null);
          }
        },
        modal: {
          ondismiss: () => setPayingChargeId(null),
        },
      });
      rzp.open();
      modalOpened = true;
    } catch {
      toast({ title: 'Could not start payment', variant: 'destructive' });
    } finally {
      if (!modalOpened) setPayingChargeId(null);
    }
  }

  function openPartialPaymentDialog(row: LevyChargeRow) {
    setPartialDialogCharge(row);
    setPartialDialogAmount('');
  }

  async function submitPartialPayment() {
    if (!partialDialogCharge) return;
    const amt = Number(partialDialogAmount);
    const remaining = levyRemaining(partialDialogCharge);
    if (!Number.isFinite(amt) || amt <= 0) {
      toast({ title: 'Enter a valid amount', variant: 'destructive' }); return;
    }
    if (amt > remaining + 0.01) {
      toast({ title: `Amount can't exceed remaining ${remaining}`, variant: 'destructive' }); return;
    }
    const chargeId = partialDialogCharge.charge.id;
    setPartialDialogCharge(null);
    setPartialDialogAmount('');
    await payLevyCharge(chargeId, Math.round(amt * 100) / 100);
  }

  async function saveGhin() {
    setSavingGhin(true);
    try {
      const res = await fetch(API('/portal/ghin'), {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ghinNumber: ghinNumber.trim() || null }),
      });
      if (res.ok) {
        const data = await res.json();
        setGhinSaved(data.ghinNumber);
        toast({ title: data.ghinNumber ? t('portal:ghin.savedToast') : t('portal:ghin.clearedToast') });
      } else {
        toast({ title: t('portal:ghin.saveFailed'), variant: 'destructive' });
      }
    } catch { toast({ title: t('portal:ghin.saveFailed'), variant: 'destructive' }); }
    finally { setSavingGhin(false); }
  }

  async function saveLanguagePreference(lang: SupportedLanguage) {
    setSavingLang(true);
    try {
      const res = await fetch(API('/portal/me/language'), {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ language: lang }),
      });
      if (res.ok) {
        setUser(u => u ? { ...u, preferredLanguage: lang } : u);
        toast({ title: t('portal:languageSaved') });
      } else {
        toast({ title: t('portal:languageSaveFailed'), variant: 'destructive' });
      }
    } catch { toast({ title: t('portal:languageSaveFailed'), variant: 'destructive' }); }
    finally { setSavingLang(false); }
  }

  async function saveNotifPref(key: keyof typeof notifPrefs, value: boolean) {
    const updated = { ...notifPrefs, [key]: value };
    setNotifPrefs(updated);
    setSavingNotifPref(true);
    try {
      await fetch(API('/portal/notification-preferences'), {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [key]: value }),
      });
    } catch { /* silent */ }
    setSavingNotifPref(false);
  }

  async function handleSubscribe() {
    if (!subscribeTierId) { toast({ title: t('portal:selectTier'), description: t('portal:selectTierDesc'), variant: 'destructive' }); return; }
    setSubscribeLoading(true);
    try {
      const res = await fetch(API('/portal/membership/subscribe'), {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tierId: subscribeTierId }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast({ title: t('portal:subscriptionError'), description: data.error ?? t('portal:failedToSubscribe'), variant: 'destructive' });
      } else {
        toast({ title: t('portal:subscriptionRequested'), description: data.message });
        if (data.subscribeUrl) window.open(data.subscribeUrl, '_blank');
        await loadDashboard();
      }
    } finally {
      setSubscribeLoading(false);
    }
  }

  async function handleDirectoryOptIn(val: boolean) {
    setDirectoryOptLoading(true);
    try {
      const res = await fetch(API('/portal/membership/directory-opt-in'), {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ showInDirectory: val }),
      });
      if (res.ok) {
        setShowInDirectory(val);
        toast({ title: val ? t('portal:addedToDirectory') : t('portal:removedFromDirectory'), description: val ? t('portal:addedToDirectoryDesc') : t('portal:removedFromDirectoryDesc') });
      }
    } finally {
      setDirectoryOptLoading(false);
    }
  }

  function downloadMemberCard() {
    const a = document.createElement('a');
    a.href = API('/portal/membership/card');
    a.download = 'membership-card.pdf';
    a.click();
  }

  async function handleCancelSubscription() {
    if (!confirm(t('portal:confirmCancelSubscription'))) return;
    setCancelLoading(true);
    try {
      const res = await fetch(API('/portal/membership/cancel-subscription'), {
        method: 'POST',
        credentials: 'include',
      });
      const data = await res.json();
      if (!res.ok) {
        toast({ title: t('common:error'), description: data.error ?? t('portal:failedToCancelSubscription'), variant: 'destructive' });
      } else {
        toast({ title: t('portal:subscriptionCancelled'), description: data.message });
        await loadDashboard();
      }
    } finally {
      setCancelLoading(false);
    }
  }

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setLoginError('');
    setUnverified(false);
    setLoginLoading(true);
    try {
      const r = await fetch(API('/auth/player-login'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email: loginEmail, password: loginPassword }),
      });
      const d = await r.json();
      if (!r.ok) {
        if (d.error?.toLowerCase().includes('verify')) setUnverified(true);
        setLoginError(d.error ?? t('portal:loginFailed'));
        return;
      }
      setUser(d.user);
      if (d.user?.preferredLanguage && d.user.preferredLanguage !== i18n.language) {
        i18n.changeLanguage(d.user.preferredLanguage);
        applyLanguageDirection(d.user.preferredLanguage);
      }
      setView('dashboard');
      loadDashboard(d.user?.organizationId);
    } finally {
      setLoginLoading(false);
    }
  }

  async function handleRegister(e: React.FormEvent) {
    e.preventDefault();
    setRegError('');
    if (regPassword !== regConfirm) { setRegError(t('portal:passwordsDoNotMatch')); return; }
    if (regPassword.length < 8) { setRegError(t('portal:passwordTooShort')); return; }
    setRegLoading(true);
    try {
      const urlOrgId = new URLSearchParams(window.location.search).get('orgId');
      const body: Record<string, string> = { firstName: regFirstName, lastName: regLastName, email: regEmail, password: regPassword };
      if (regMemberNumber.trim()) body.memberNumber = regMemberNumber.trim();
      if (urlOrgId && !isNaN(parseInt(urlOrgId))) body.organizationId = urlOrgId;
      const r = await fetch(API('/auth/player-register'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const d = await r.json();
      if (!r.ok) { setRegError(d.error ?? t('portal:registrationFailed')); return; }
      setRegEmailDelivered(d.emailDelivered !== false);
      setView('verify-sent');
    } finally {
      setRegLoading(false);
    }
  }

  async function handleClaim(e: React.FormEvent) {
    e.preventDefault();
    setClaimError('');
    if (claimPassword !== claimConfirm) { setClaimError(t('portal:passwordsDoNotMatch')); return; }
    if (claimPassword.length < 8) { setClaimError(t('portal:passwordTooShort')); return; }
    setClaimLoading(true);
    try {
      const r = await fetch(API('/auth/claim-account'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ inviteToken: claimToken, password: claimPassword }),
      });
      const d = await r.json();
      if (!r.ok) { setClaimError(d.error ?? t('portal:failedToActivateAccount')); return; }
      setUser(d.user);
      setView('dashboard');
      loadDashboard(d.user?.organizationId);
      window.history.replaceState({}, '', '/portal');
    } finally {
      setClaimLoading(false);
    }
  }

  async function handleForgot(e: React.FormEvent) {
    e.preventDefault();
    setForgotLoading(true);
    try {
      await fetch(API('/auth/forgot-password'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: forgotEmail }),
      });
      setForgotSent(true);
    } finally {
      setForgotLoading(false);
    }
  }

  async function handleResendVerification() {
    const r = await fetch(API('/auth/resend-verification'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: loginEmail }),
    });
    const d = await r.json();
    toast({ title: d.message ?? t('portal:verificationEmailSent') });
  }

  // Task #1270 — dismiss the side-game-receipt-toggle backfill announcement.
  // Optimistically clear the card, post to the server, and on failure restore
  // the card so the member can retry. `openPrefs` also switches to the Profile
  // tab and scrolls to the `#comm-prefs` anchor where `PortalCommPrefs` is
  // rendered. Either action satisfies "never reappears".
  async function dismissSideGameToggleAnnouncement(openPrefs: boolean) {
    if (!sideGameToggleAnnouncement || dismissingSideGameToggleAnnouncement) return;
    const prev = sideGameToggleAnnouncement;
    setDismissingSideGameToggleAnnouncement(true);
    setSideGameToggleAnnouncement(null);
    if (openPrefs) {
      setPortalTab('profile');
      // Defer scroll to next tick so the Profile tab has rendered the
      // `#comm-prefs` Card before we attempt to scroll it into view.
      setTimeout(() => {
        const el = document.getElementById(prev.prefsAnchor);
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        else if (typeof window !== 'undefined') {
          window.location.hash = prev.prefsAnchor;
        }
      }, 50);
    }
    try {
      const r = await fetch(API('/portal/announcements/side-game-receipt-toggle/dismiss'), {
        method: 'POST',
        credentials: 'include',
      });
      if (!r.ok) setSideGameToggleAnnouncement(prev);
    } catch {
      setSideGameToggleAnnouncement(prev);
    } finally {
      setDismissingSideGameToggleAnnouncement(false);
    }
  }

  async function handleLogout() {
    await fetch(API('/auth/player-logout'), { method: 'POST', credentials: 'include' });
    setUser(null);
    setView('login');
    setStats(null);
    setTournaments([]);
    setLeagues([]);
  }

  async function handleWithdrawConfirm() {
    if (!withdrawingTournamentId) return;
    setWithdrawLoading(true);
    const tid = withdrawingTournamentId;
    try {
      const res = await fetch(API(`/portal/tournaments/${tid}/withdraw`), { method: 'DELETE', credentials: 'include' });
      const data = await res.json() as { withdrawn?: boolean; refundPending?: boolean; message?: string; error?: string };
      if (res.ok) {
        const refundPending = data.refundPending ?? false;
        toast({ title: refundPending ? t('portal:withdrawnRefund') : t('portal:withdrawnSuccess') });
        setWithdrawnTournaments(prev => new Map(prev).set(tid, { refundPending }));
      } else {
        toast({ title: data.error ?? t('portal:failedToWithdraw'), variant: 'destructive' });
      }
    } catch {
      toast({ title: t('portal:failedToWithdraw'), variant: 'destructive' });
    } finally {
      setWithdrawLoading(false);
      setWithdrawingTournamentId(null);
    }
  }

  if (authLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Loader2 className="w-10 h-10 animate-spin text-primary" />
      </div>
    );
  }

  // ─── Verify sent ───────────────────────────────────────────────
  if (view === 'verify-sent') {
    return (
      <PortalShell>
        <div className="flex flex-col items-center text-center max-w-md mx-auto py-16 gap-6">
          <PreAuthBrand size="md" />
          <div className={`w-20 h-20 rounded-full flex items-center justify-center ${regEmailDelivered ? 'bg-primary/20' : 'bg-yellow-500/20'}`}>
            <CheckCircle className={`w-10 h-10 ${regEmailDelivered ? 'text-primary' : 'text-yellow-400'}`} />
          </div>
          <h2 className="text-2xl font-display font-bold text-white">
            {regEmailDelivered ? t('portal:checkYourInbox') : t('portal:accountCreated')}
          </h2>
          {regEmailDelivered ? (
            <p className="text-muted-foreground leading-relaxed">
              {t('portal:verifySentDescPlain', { email: regEmail })}
            </p>
          ) : (
            <p className="text-muted-foreground leading-relaxed">
              {t('portal:verifyNoEmailDesc', { email: regEmail })}
            </p>
          )}
          <Button onClick={() => setView('login')} className="bg-primary hover:bg-primary/90">
            {t('portal:goToSignIn')}
          </Button>
        </div>
      </PortalShell>
    );
  }

  // ─── Claim Account ─────────────────────────────────────────────
  if (view === 'claim') {
    return (
      <PortalShell>
        <div className="max-w-md mx-auto py-12 px-4">
          <div className="text-center mb-10">
            <PreAuthBrand size="lg" className="mb-4" />
            <h2 className="text-xl font-bold text-white">{t('portal:claimTitle')}</h2>
            <p className="text-muted-foreground text-sm mt-2">{t('portal:claimSubtitle')}</p>
          </div>
          <Card className="glass-panel border-white/10 p-8">
            {claimError && (
              <div className="bg-red-900/40 border border-red-700/50 rounded-lg p-3 mb-4">
                <p className="text-red-300 text-sm">{claimError}</p>
              </div>
            )}
            <form onSubmit={handleClaim} className="space-y-4">
              <div>
                <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1.5 block">{t('portal:labelNewPassword')}</label>
                <Input value={claimPassword} onChange={e => setClaimPassword(e.target.value)} type="password" placeholder={t('portal:placeholderMinChars')} required className="bg-black/40 border-white/10 text-white" />
              </div>
              <div>
                <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1.5 block">{t('portal:labelConfirmPassword')}</label>
                <Input value={claimConfirm} onChange={e => setClaimConfirm(e.target.value)} type="password" placeholder={t('portal:placeholderRepeatPassword')} required className="bg-black/40 border-white/10 text-white" />
              </div>
              <Button type="submit" disabled={claimLoading} className="w-full bg-primary hover:bg-primary/90 text-primary-foreground font-bold">
                {claimLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : t('portal:activateAccount')}
              </Button>
            </form>
            <button onClick={() => { setView('login'); window.history.replaceState({}, '', '/portal'); }} className="w-full mt-4 text-sm text-muted-foreground hover:text-white transition-colors">
              {t('portal:backToSignIn')}
            </button>
          </Card>
        </div>
      </PortalShell>
    );
  }

  // ─── Login ─────────────────────────────────────────────────────
  if (view === 'login') {
    return (
      <PortalShell>
        <div className="max-w-md mx-auto py-12 px-4">
          <div className="text-center mb-10">
            <PreAuthBrand size="lg" className="mb-4" />
            <h2 className="text-xl font-bold text-white">{t('portal:playerPortal')}</h2>
            <p className="text-muted-foreground text-sm mt-2">{t('portal:playerPortalSubtitle')}</p>
          </div>

          <Card className="glass-panel border-white/10 p-8">
            {loginError && (
              <div className="bg-red-900/40 border border-red-700/50 rounded-lg p-3 mb-4 flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0" />
                  <p className="text-red-300 text-sm">{loginError}</p>
                </div>
                {unverified && (
                  <button onClick={handleResendVerification} className="text-primary text-sm font-semibold hover:underline text-left pl-6">
                    {t('portal:resendVerificationEmail')}
                  </button>
                )}
              </div>
            )}
            <form onSubmit={handleLogin} className="space-y-4">
              <div>
                <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1.5 block">{t('portal:labelEmailAddress')}</label>
                <Input value={loginEmail} onChange={e => setLoginEmail(e.target.value)} type="email" placeholder="your@email.com" required className="bg-black/40 border-white/10 text-white" />
              </div>
              <div>
                <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1.5 block">{t('portal:labelPassword')}</label>
                <Input value={loginPassword} onChange={e => setLoginPassword(e.target.value)} type="password" placeholder="••••••••" required className="bg-black/40 border-white/10 text-white" />
              </div>
              <div className="flex justify-end">
                <button type="button" onClick={() => { setView('forgot'); setForgotSent(false); }} className="text-primary text-sm font-semibold hover:underline">
                  {t('portal:forgotPassword')}
                </button>
              </div>
              <Button type="submit" disabled={loginLoading} className="w-full bg-primary hover:bg-primary/90 text-primary-foreground font-bold">
                {loginLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : t('portal:signIn')}
              </Button>
            </form>

            <div className="flex items-center gap-3 my-6">
              <div className="flex-1 h-px bg-white/10" />
              <span className="text-muted-foreground text-xs">{t('portal:newToKharagolf')}</span>
              <div className="flex-1 h-px bg-white/10" />
            </div>

            <Button variant="outline" onClick={() => setView('register')} className="w-full border-primary/40 text-primary hover:bg-primary/10">
              {t('portal:createPlayerAccount')}
            </Button>
            <p className="text-center text-xs text-muted-foreground/60 mt-4">
              {t('portal:clubAdministrator')}{' '}
              <a href="/" className="hover:text-primary transition-colors">{t('portal:signInHere')}</a>
            </p>
          </Card>
        </div>
      </PortalShell>
    );
  }

  // ─── Register ──────────────────────────────────────────────────
  if (view === 'register') {
    return (
      <PortalShell>
        <div className="max-w-md mx-auto py-12 px-4">
          <div className="text-center mb-10">
            <PreAuthBrand size="lg" className="mb-4" />
            <h2 className="text-xl font-bold text-white">{t('portal:createPlayerAccountTitle')}</h2>
          </div>
          <Card className="glass-panel border-white/10 p-8">
            {regError && (
              <div className="bg-red-900/40 border border-red-700/50 rounded-lg p-3 mb-4">
                <p className="text-red-300 text-sm">{regError}</p>
              </div>
            )}
            <form onSubmit={handleRegister} className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1.5 block">{t('portal:labelFirstName')}</label>
                  <Input value={regFirstName} onChange={e => setRegFirstName(e.target.value)} placeholder={t('portal:placeholderFirstName')} required className="bg-black/40 border-white/10 text-white" />
                </div>
                <div>
                  <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1.5 block">{t('portal:labelLastName')}</label>
                  <Input value={regLastName} onChange={e => setRegLastName(e.target.value)} placeholder={t('portal:placeholderLastName')} required className="bg-black/40 border-white/10 text-white" />
                </div>
              </div>
              <div>
                <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1.5 block">{t('portal:labelEmailAddress')}</label>
                <Input value={regEmail} onChange={e => setRegEmail(e.target.value)} type="email" placeholder="your@email.com" required className="bg-black/40 border-white/10 text-white" />
              </div>
              <div>
                <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1.5 block">{t('portal:labelPassword')}</label>
                <Input value={regPassword} onChange={e => setRegPassword(e.target.value)} type="password" placeholder={t('portal:placeholderMinChars')} required className="bg-black/40 border-white/10 text-white" />
              </div>
              <div>
                <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1.5 block">{t('portal:labelConfirmPassword')}</label>
                <Input value={regConfirm} onChange={e => setRegConfirm(e.target.value)} type="password" placeholder={t('portal:placeholderRepeatPassword')} required className="bg-black/40 border-white/10 text-white" />
              </div>
              <div>
                <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1.5 block">
                  {t('portal:labelMemberNumber')} <span className="text-muted-foreground/50 font-normal normal-case">{t('portal:memberNumberOptionalNote')}</span>
                </label>
                <Input value={regMemberNumber} onChange={e => setRegMemberNumber(e.target.value)} placeholder={t('portal:placeholderMemberNumber')} className="bg-black/40 border-white/10 text-white" />
              </div>
              <Button type="submit" disabled={regLoading} className="w-full bg-primary hover:bg-primary/90 text-primary-foreground font-bold">
                {regLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : t('portal:createAccount')}
              </Button>
            </form>
            <button onClick={() => setView('login')} className="w-full mt-4 text-sm text-muted-foreground hover:text-white transition-colors">
              {t('portal:backToSignIn')}
            </button>
          </Card>
        </div>
      </PortalShell>
    );
  }

  // ─── Forgot Password ───────────────────────────────────────────
  if (view === 'forgot') {
    return (
      <PortalShell>
        <div className="max-w-md mx-auto py-12 px-4">
          <div className="text-center mb-10">
            <PreAuthBrand size="lg" className="mb-4" />
            <h2 className="text-xl font-bold text-white">{t('portal:resetPassword')}</h2>
            <p className="text-muted-foreground text-sm mt-2">{t('portal:resetPasswordSubtitle')}</p>
          </div>
          <Card className="glass-panel border-white/10 p-8">
            {forgotSent ? (
              <div className="text-center space-y-4">
                <CheckCircle className="w-12 h-12 text-primary mx-auto" />
                <p className="text-white font-medium">{t('portal:resetLinkSent')}</p>
                <p className="text-muted-foreground text-sm">
                  {t('portal:resetLinkSentDesc', { email: forgotEmail })}
                </p>
                <Button onClick={() => setView('login')} className="bg-primary hover:bg-primary/90 w-full">
                  {t('portal:backToSignIn')}
                </Button>
              </div>
            ) : (
              <form onSubmit={handleForgot} className="space-y-4">
                <div>
                  <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1.5 block">{t('portal:labelEmailAddress')}</label>
                  <Input value={forgotEmail} onChange={e => setForgotEmail(e.target.value)} type="email" placeholder="your@email.com" required className="bg-black/40 border-white/10 text-white" />
                </div>
                <Button type="submit" disabled={forgotLoading} className="w-full bg-primary hover:bg-primary/90 text-primary-foreground font-bold">
                  {forgotLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : t('portal:sendResetLink')}
                </Button>
              </form>
            )}
            {!forgotSent && (
              <button onClick={() => setView('login')} className="w-full mt-4 text-sm text-muted-foreground hover:text-white transition-colors">
                {t('portal:backToSignIn')}
              </button>
            )}
          </Card>
        </div>
      </PortalShell>
    );
  }

  // ─── Avatar helpers ─────────────────────────────────────────────
  function openAvatarModal() {
    setAvatarModalTab('upload');
    setAvatarPreviewSrc(null);
    setPendingFile(null);
    setAvatarModalOpen(true);
  }

  function handleFileSelected(file: File) {
    if (!file.type.startsWith('image/')) return;
    setPendingFile(file);
    setCropZoom(0.05);
    setMinZoom(0.05);
    setCropOffset({ x: 0, y: 0 });
    cropImgRef.current = null;
    const reader = new FileReader();
    reader.onload = (e) => setAvatarPreviewSrc(e.target?.result as string);
    reader.readAsDataURL(file);
  }

  async function confirmUploadPhoto() {
    if (!pendingFile || !cropCanvasRef.current) return;
    setAvatarUploading(true);
    try {
      // Export crop canvas (240×240) → upscale to 400×400
      const contentType = 'image/jpeg';
      const res = await fetch(API('/portal/avatar-upload-url'), {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contentType }),
      });
      if (!res.ok) throw new Error('Failed to get upload URL');
      const { uploadUrl, publicUrl } = await res.json();

      // Copy crop canvas contents → 400×400 export canvas
      const exportCanvas = document.createElement('canvas');
      exportCanvas.width = 400; exportCanvas.height = 400;
      const exportCtx = exportCanvas.getContext('2d')!;
      exportCtx.drawImage(cropCanvasRef.current, 0, 0, 400, 400);
      const blob = await new Promise<Blob>((resolve) => exportCanvas.toBlob(b => resolve(b!), contentType, 0.9));

      const putRes = await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': contentType }, body: blob });
      if (!putRes.ok) throw new Error('Failed to upload to storage');

      const saveRes = await fetch(API('/portal/me/avatar'), {
        method: 'PATCH', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profileImage: publicUrl }),
      });
      if (!saveRes.ok) throw new Error('Failed to save avatar');
      setUser(u => u ? { ...u, profileImage: publicUrl } : u);
      toast({ title: t('portal:profilePhotoUpdated') });
      setAvatarModalOpen(false);
    } catch {
      toast({ title: t('portal:uploadFailed'), description: t('portal:uploadFailedDesc'), variant: 'destructive' });
    } finally {
      setAvatarUploading(false);
      if (avatarInputRef.current) avatarInputRef.current.value = '';
    }
  }

  async function selectPreset(presetId: string) {
    setAvatarUploading(true);
    try {
      const profileImage = `preset:${presetId}`;
      const saveRes = await fetch(API('/portal/me/avatar'), {
        method: 'PATCH', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profileImage }),
      });
      if (!saveRes.ok) throw new Error('Failed to save preset');
      setUser(u => u ? { ...u, profileImage } : u);
      toast({ title: t('portal:avatarUpdated') });
      setAvatarModalOpen(false);
    } catch {
      toast({ title: t('portal:failedToSelectAvatar'), variant: 'destructive' });
    } finally {
      setAvatarUploading(false);
    }
  }

  async function handleAvatarRemove() {
    setAvatarUploading(true);
    try {
      await fetch(API('/portal/me/avatar'), { method: 'DELETE', credentials: 'include' });
      setUser(u => u ? { ...u, profileImage: null } : u);
      toast({ title: t('portal:profilePhotoRemoved') });
      setAvatarModalOpen(false);
    } catch {
      toast({ title: t('portal:failedToRemovePhoto'), variant: 'destructive' });
    } finally {
      setAvatarUploading(false);
    }
  }

  // ─── Dashboard ─────────────────────────────────────────────────
  const initials = user?.displayName
    ? user.displayName.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2)
    : (user?.email?.[0] ?? '?').toUpperCase();

  return (
    <PortalShell user={user} onLogout={handleLogout}>
      <div className="max-w-4xl mx-auto px-4 py-8 space-y-8">
        {/* Admin preview banner */}
        {user?.role && user.role !== 'player' && user.role !== 'spectator' && !adminPreviewDismissed && (
          <div className="flex items-center gap-3 bg-amber-500/10 border border-amber-500/30 rounded-xl px-4 py-2.5">
            <span className="text-amber-400 text-sm font-medium">{t('portal:adminPreviewBanner')}</span>
            <a href="/" className="text-xs text-primary hover:underline ml-auto whitespace-nowrap">{t('portal:goToAdmin')}</a>
            <button onClick={() => setAdminPreviewDismissed(true)} className="text-muted-foreground hover:text-white text-xs transition-colors">{t('portal:dismiss')}</button>
          </div>
        )}
        {/* Task #1270 — one-time backfill announcement card pointing
            existing members at the new "Side-game payment receipts"
            toggle. Auto-dismisses on either button (server-side readAt
            stamp) so it never reappears, even on a different device. */}
        {sideGameToggleAnnouncement && (
          <Card
            className="glass-panel border-primary/30 bg-primary/[0.06] p-4"
            data-testid="card-side-game-receipt-toggle-announcement"
          >
            <div className="flex items-start gap-3">
              <div className="w-9 h-9 rounded-lg bg-primary/15 border border-primary/30 flex items-center justify-center flex-shrink-0">
                <Bell className="w-4 h-4 text-primary" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-semibold text-white text-sm">
                  {sideGameToggleAnnouncement.subject}
                </p>
                <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                  {sideGameToggleAnnouncement.body}
                </p>
                <div className="flex flex-wrap gap-2 mt-3">
                  <Button
                    size="sm"
                    className="bg-primary hover:bg-primary/90 text-primary-foreground h-8 px-3 text-xs"
                    disabled={dismissingSideGameToggleAnnouncement}
                    onClick={() => dismissSideGameToggleAnnouncement(true)}
                    data-testid="btn-side-game-receipt-toggle-open-prefs"
                  >
                    Open settings
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="border-white/15 text-muted-foreground hover:text-white hover:bg-white/5 h-8 px-3 text-xs"
                    disabled={dismissingSideGameToggleAnnouncement}
                    onClick={() => dismissSideGameToggleAnnouncement(false)}
                    data-testid="btn-side-game-receipt-toggle-got-it"
                  >
                    Got it
                  </Button>
                </div>
              </div>
            </div>
          </Card>
        )}
        {/* Welcome */}
        <div className="flex items-center gap-4">
          <div className="relative group flex-shrink-0">
            <button
              onClick={openAvatarModal}
              disabled={avatarUploading}
              className="w-16 h-16 rounded-full overflow-hidden bg-gradient-to-tr from-primary/60 to-green-800/60 flex items-center justify-center text-white text-xl font-bold ring-2 ring-white/10 hover:ring-primary/60 transition-all focus:outline-none"
              title={t('portal:changeProfilePhoto')}
            >
              {avatarUploading ? (
                <Loader2 className="w-6 h-6 animate-spin text-white" />
              ) : (() => {
                const src = resolveAvatarSrc(user?.profileImage);
                return src ? <img src={src} alt="Avatar" className="w-full h-full object-cover" /> : <span>{initials}</span>;
              })()}
            </button>
            <div className="absolute inset-0 rounded-full bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center pointer-events-none">
              <Camera className="w-5 h-5 text-white" />
            </div>
          </div>
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-2xl font-display font-bold text-white">{t('portal:welcomeBack', { name: user?.displayName?.split(' ')[0] ?? 'Player' })}</h1>
              {membership ? (
                <span className="inline-flex items-center gap-1 bg-primary/20 text-primary border border-primary/30 rounded-full px-2 py-0.5 text-[11px] font-semibold">
                  ✓ Member
                </span>
              ) : membership === null ? (
                <span className="inline-flex items-center gap-1 bg-white/10 text-muted-foreground border border-white/10 rounded-full px-2 py-0.5 text-[11px] font-semibold">
                  Guest
                </span>
              ) : null}
            </div>
            <p className="text-muted-foreground text-sm">{user?.email}</p>
            <button onClick={openAvatarModal} className="text-xs text-primary/70 hover:text-primary mt-0.5 transition-colors">
              {user?.profileImage ? t('portal:changePhoto') : t('portal:addProfilePhoto')}
            </button>
          </div>
        </div>

        {/* Task #406 — Local Rules quick-access card */}
        {localRulesContent && (
          <Card className="glass-panel border-white/10 p-4 flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-primary/15 border border-primary/30 flex items-center justify-center flex-shrink-0">
              <BookOpen className="w-5 h-5 text-primary" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-white text-sm font-semibold">{t('portal:localRules.inEffect')}</p>
              <p className="text-xs text-muted-foreground">{t('portal:localRules.inEffectDesc')}</p>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="border-primary/40 text-primary hover:bg-primary/10 hover:text-primary"
              onClick={() => setLocalRulesOpen(true)}
            >
              {t('portal:localRules.view')}
            </Button>
          </Card>
        )}

        {/* Local Rules viewer dialog */}
        <Dialog open={localRulesOpen} onOpenChange={setLocalRulesOpen}>
          <DialogContent className="bg-[#0a1a0f] border-white/10 text-white max-w-2xl max-h-[85vh] flex flex-col">
            <DialogHeader>
              <DialogTitle className="text-white font-display flex items-center gap-2">
                <BookOpen className="w-5 h-5 text-primary" /> {t('portal:localRules.dialogTitle')}
              </DialogTitle>
              <p className="text-xs text-muted-foreground">{t('portal:localRules.dialogSubtitle')}</p>
            </DialogHeader>
            <div
              className="prose prose-invert prose-sm max-w-none overflow-y-auto pr-2 flex-1
                prose-headings:text-white prose-headings:font-display
                prose-p:text-muted-foreground prose-li:text-muted-foreground
                prose-strong:text-white prose-em:text-white
                prose-code:text-primary prose-code:bg-black/40 prose-code:px-1 prose-code:rounded"
              dangerouslySetInnerHTML={{ __html: markdownToHtml(localRulesContent) }}
            />
            <DialogFooter>
              <Button
                variant="outline"
                size="sm"
                className="border-white/15 text-white hover:bg-white/5"
                onClick={handlePrintLocalRules}
              >
                <Printer className="w-4 h-4 mr-1.5" /> {t('portal:localRules.printSavePdf')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Avatar Editor Modal */}
        <Dialog open={avatarModalOpen} onOpenChange={o => { if (!avatarUploading) setAvatarModalOpen(o); }}>
          <DialogContent className="bg-[#0a1a0f] border-white/10 text-white max-w-md">
            <DialogHeader>
              <DialogTitle className="text-white font-display">{t('portal:profilePhoto')}</DialogTitle>
            </DialogHeader>
            <Tabs value={avatarModalTab} onValueChange={v => setAvatarModalTab(v as 'upload' | 'preset')}>
              <TabsList className="bg-black/40 border border-white/10 w-full">
                <TabsTrigger value="upload" className="flex-1 data-[state=active]:bg-white/10">{t('portal:uploadPhoto')}</TabsTrigger>
                <TabsTrigger value="preset" className="flex-1 data-[state=active]:bg-white/10">{t('portal:chooseAvatar')}</TabsTrigger>
              </TabsList>

              {/* Upload tab */}
              <TabsContent value="upload" className="mt-4 space-y-4">
                {avatarPreviewSrc ? (
                  <div className="flex flex-col items-center gap-3">
                    <div className="relative select-none" style={{ width: 240, height: 240 }}>
                      <canvas
                        ref={cropCanvasRef}
                        width={240}
                        height={240}
                        className="rounded-full cursor-grab active:cursor-grabbing touch-none"
                        style={{ display: 'block', userSelect: 'none' }}
                        onMouseDown={handleCropMouseDown}
                        onMouseMove={handleCropMouseMove}
                        onMouseUp={handleCropMouseUp}
                        onMouseLeave={handleCropMouseUp}
                        onWheel={handleCropWheel}
                        onTouchStart={handleTouchStart}
                        onTouchMove={handleTouchMove}
                        onTouchEnd={handleTouchEnd}
                      />
                    </div>
                    <div className="w-full space-y-1">
                      <div className="flex justify-between text-xs text-muted-foreground">
                        <span>{t('portal:zoom')}</span><span>{Math.round((cropZoom / minZoom) * 100)}%</span>
                      </div>
                      <input
                        type="range" min={minZoom} max={minZoom * 4} step={minZoom * 0.05} value={cropZoom}
                        onChange={e => setCropZoom(Number(e.target.value))}
                        className="w-full accent-primary h-1.5 cursor-pointer"
                      />
                      <p className="text-[11px] text-muted-foreground/60 text-center">{t('portal:dragToReposition')}</p>
                    </div>
                    <div className="flex gap-2 w-full">
                      <Button
                        variant="outline"
                        size="sm"
                        className="flex-1 border-white/10 text-muted-foreground hover:text-white hover:bg-white/5"
                        onClick={() => { setAvatarPreviewSrc(null); setPendingFile(null); cropImgRef.current = null; if (avatarInputRef.current) avatarInputRef.current.value = ''; }}
                      >
                        {t('portal:chooseDifferent')}
                      </Button>
                      <Button
                        size="sm"
                        className="flex-1 bg-primary hover:bg-primary/90 text-primary-foreground"
                        disabled={avatarUploading}
                        onClick={confirmUploadPhoto}
                      >
                        {avatarUploading ? <Loader2 className="w-4 h-4 animate-spin" /> : t('portal:uploadAndSave')}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div
                    className="border-2 border-dashed border-white/15 rounded-xl p-8 text-center cursor-pointer hover:border-primary/40 hover:bg-white/[0.02] transition-all"
                    onClick={() => avatarInputRef.current?.click()}
                    onDragOver={e => e.preventDefault()}
                    onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f) handleFileSelected(f); }}
                  >
                    <Camera className="w-8 h-8 text-muted-foreground/50 mx-auto mb-2" />
                    <p className="text-sm text-muted-foreground">{t('portal:clickToSelectOrDrop')}</p>
                    <p className="text-xs text-muted-foreground/60 mt-1">{t('portal:fileFormatNote')}</p>
                  </div>
                )}
                <input
                  ref={avatarInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  className="hidden"
                  onChange={e => { const f = e.target.files?.[0]; if (f) handleFileSelected(f); }}
                />
              </TabsContent>

              {/* Preset tab */}
              <TabsContent value="preset" className="mt-4">
                <p className="text-xs text-muted-foreground mb-3">{t('portal:selectGolfAvatar')}</p>
                <div className="grid grid-cols-4 gap-2">
                  {AVATAR_PRESETS.map(preset => {
                    const isActive = user?.profileImage === `preset:${preset.id}`;
                    return (
                      <button
                        key={preset.id}
                        onClick={() => selectPreset(preset.id)}
                        disabled={avatarUploading}
                        className={`relative rounded-xl overflow-hidden aspect-square ring-2 transition-all hover:scale-105 ${isActive ? 'ring-primary' : 'ring-transparent hover:ring-primary/40'}`}
                        title={preset.label}
                      >
                        <img
                          src={`data:image/svg+xml;base64,${btoa(preset.svgXml)}`}
                          alt={preset.label}
                          className="w-full h-full object-cover"
                        />
                        {isActive && (
                          <div className="absolute inset-0 bg-primary/20 flex items-center justify-center">
                            <CheckCircle className="w-4 h-4 text-primary" />
                          </div>
                        )}
                        {avatarUploading && <div className="absolute inset-0 bg-black/50 flex items-center justify-center"><Loader2 className="w-3 h-3 animate-spin text-white" /></div>}
                      </button>
                    );
                  })}
                </div>
              </TabsContent>
            </Tabs>

            {user?.profileImage && (
              <DialogFooter className="mt-2">
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-red-400 hover:text-red-300 hover:bg-red-900/20 gap-1.5"
                  disabled={avatarUploading}
                  onClick={handleAvatarRemove}
                >
                  <Trash2 className="w-3.5 h-3.5" /> Remove Current Photo
                </Button>
              </DialogFooter>
            )}
          </DialogContent>
        </Dialog>

        {/* Email not verified warning */}
        {user?.isLocalAuth && !user.emailVerified && (
          <div className="bg-yellow-900/30 border border-yellow-700/50 rounded-xl p-4 flex items-center gap-3">
            <AlertCircle className="w-5 h-5 text-yellow-400 flex-shrink-0" />
            <p className="text-yellow-300 text-sm">{t('portal:emailNotVerified')}</p>
          </div>
        )}

        {/* Stats */}
        {dashLoading ? (
          <div className="flex justify-center py-8"><Loader2 className="w-8 h-8 animate-spin text-primary" /></div>
        ) : (
          <>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {[
                { icon: Flag, label: t('portal:stats.tournaments'), value: stats?.tournamentsPlayed ?? 0, color: 'text-primary' },
                { icon: BarChart3, label: t('portal:stats.avgStrokes'), value: stats?.averageStrokes ?? '—', color: 'text-blue-400' },
                { icon: Trophy, label: t('portal:stats.bestRound'), value: stats?.bestRound ?? '—', color: 'text-yellow-400' },
                { icon: User, label: t('portal:stats.holesPlayed'), value: stats?.totalScores ?? 0, color: 'text-white' },
              ].map(({ icon: Icon, label, value, color }) => (
                <Card key={label} className="glass-card p-5">
                  <Icon className={`w-5 h-5 ${color} mb-2 opacity-70`} />
                  <p className={`text-2xl font-display font-bold ${color}`}>{value}</p>
                  <p className="text-xs text-muted-foreground mt-1 uppercase tracking-wider">{label}</p>
                </Card>
              ))}
            </div>

            {/* Handicap Trend */}
            {(stats?.handicapTrend ?? []).length >= 2 && (
              <Card className="glass-panel border-white/10 p-5">
                <p className="text-sm font-semibold text-white mb-4">{t('portal:handicapTrend')}</p>
                <ResponsiveContainer width="100%" height={140}>
                  <LineChart data={(stats!.handicapTrend!).map((h, i) => ({ idx: i, hcp: h.handicapIndex, label: h.recordedAt ? new Date(h.recordedAt).toLocaleDateString('en', { month: 'short', year: '2-digit' }) : `#${i + 1}` }))}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                    <XAxis dataKey="label" tick={{ fill: 'rgba(255,255,255,0.35)', fontSize: 10 }} axisLine={false} tickLine={false} />
                    <YAxis domain={['auto', 'auto']} reversed tick={{ fill: 'rgba(255,255,255,0.35)', fontSize: 10 }} axisLine={false} tickLine={false} width={28} />
                    <Tooltip contentStyle={{ background: '#0d1f12', border: '1px solid rgba(201,168,76,0.3)', borderRadius: 8, fontSize: 11 }} labelStyle={{ color: '#C9A84C' }} formatter={(v: number) => [`HCP ${v.toFixed(1)}`, '']} />
                    <Line type="monotone" dataKey="hcp" stroke="#C9A84C" strokeWidth={2} dot={{ r: 3, fill: '#C9A84C' }} activeDot={{ r: 5 }} />
                  </LineChart>
                </ResponsiveContainer>
                <div className="flex justify-between items-center mt-2 text-xs text-muted-foreground">
                  <span>{t('portal:start')} {stats!.handicapTrend![0].handicapIndex.toFixed(1)}</span>
                  <span className={stats!.handicapTrend![stats!.handicapTrend!.length - 1].handicapIndex < stats!.handicapTrend![0].handicapIndex ? 'text-green-400' : 'text-red-400'}>
                    {t('portal:current')} {stats!.handicapTrend![stats!.handicapTrend!.length - 1].handicapIndex.toFixed(1)}
                  </span>
                </div>
              </Card>
            )}

            {/* Course Breakdown */}
            {(stats?.courseBreakdown ?? []).length > 0 && (
              <Card className="glass-panel border-white/10 p-5">
                <p className="text-sm font-semibold text-white mb-4">{t('portal:coursePerformance')}</p>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-xs text-muted-foreground uppercase tracking-wider border-b border-white/10">
                        <th className="text-left py-2 pr-4">{t('portal:course')}</th>
                        <th className="text-right py-2 px-2">{t('portal:rounds')}</th>
                        <th className="text-right py-2 px-2">{t('portal:avgScore')}</th>
                        <th className="text-right py-2 pl-2">{t('portal:best')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {stats!.courseBreakdown!.map(c => (
                        <tr key={c.courseId} className="border-b border-white/5 hover:bg-white/[0.02] transition-colors">
                          <td className="py-2 pr-4 text-white font-medium">{c.courseName}</td>
                          <td className="py-2 px-2 text-right text-muted-foreground">{c.rounds}</td>
                          <td className="py-2 px-2 text-right text-white font-bold">{c.avgGross.toFixed(1)}</td>
                          <td className="py-2 pl-2 text-right text-green-400 font-semibold">{c.bestGross > 0 ? c.bestGross : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            )}

            {/* Handicap "What-If" Calculator */}
            <PortalHandicapCalc currentHI={stats?.handicapTrend?.length ? stats.handicapTrend[stats.handicapTrend.length - 1].handicapIndex : 18} />

            {/* Task #998 — Highlight reel editor entry point. The web editor
                lives at /portal/highlights but had no link from this page,
                forcing players to know the URL. Mirrors the mobile app's
                discoverability. */}
            <button
              type="button"
              onClick={() => navigate('/portal/highlights')}
              data-testid="link-highlight-reels"
              className="w-full text-left"
            >
              <Card className="glass-panel border-white/10 p-4 flex items-center gap-4 hover:bg-white/[0.04] transition-colors">
                <div className="w-10 h-10 rounded-lg bg-primary/15 border border-primary/30 flex items-center justify-center flex-shrink-0">
                  <Camera className="w-5 h-5 text-primary" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-semibold text-white">{t('portal:highlightReels.title', { defaultValue: 'Highlight Reels' })}</p>
                  <p className="text-xs text-muted-foreground truncate">
                    {t('portal:highlightReels.subtitle', { defaultValue: 'Build and share short videos from your rounds' })}
                  </p>
                </div>
                <ChevronRight className="w-5 h-5 text-muted-foreground flex-shrink-0" />
              </Card>
            </button>

            <MyUpcomingWidget />

            <button
              type="button"
              onClick={() => navigate('/portal/security')}
              data-testid="link-security"
              className="w-full text-left"
            >
              <Card className="glass-panel border-white/10 p-4 flex items-center gap-4 hover:bg-white/[0.04] transition-colors">
                <div className="w-10 h-10 rounded-lg bg-primary/15 border border-primary/30 flex items-center justify-center flex-shrink-0">
                  <Lock className="w-5 h-5 text-primary" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-semibold text-white">Security</p>
                  <p className="text-xs text-muted-foreground truncate">Two-factor authentication and active sessions</p>
                </div>
                <ChevronRight className="w-5 h-5 text-muted-foreground flex-shrink-0" />
              </Card>
            </button>

            <Tabs
              value={portalTab}
              onValueChange={setPortalTab}
              className="w-full"
            >
              <TabsList className="bg-black/40 border border-white/10 flex-wrap h-auto gap-1 p-1">
                <TabsTrigger value="tournaments" className="data-[state=active]:bg-white/10">{t('portal:tabs.myTournaments')}</TabsTrigger>
                <TabsTrigger value="leagues" className="data-[state=active]:bg-white/10">{t('portal:tabs.myLeagues')}</TabsTrigger>
                {membership !== undefined && (
                  <TabsTrigger value="membership" className="data-[state=active]:bg-white/10">
                    <CreditCard className="w-3.5 h-3.5 mr-1.5" />
                    {t('portal:tabs.membership')}
                  </TabsTrigger>
                )}
                {user?.organizationId && (
                  <>
                    <TabsTrigger value="orders" className="data-[state=active]:bg-white/10">
                      <ShoppingBag className="w-3.5 h-3.5 mr-1.5" />
                      {t('portal:tabs.orders')}
                    </TabsTrigger>
                    <TabsTrigger value="wishlist" className="data-[state=active]:bg-white/10">
                      <Heart className="w-3.5 h-3.5 mr-1.5" />
                      {t('portal:tabs.wishlist')}
                    </TabsTrigger>
                  </>
                )}
                {(lockerAssignment !== undefined || lockerWaitlist !== null) && (
                  <TabsTrigger value="locker" className="data-[state=active]:bg-white/10">
                    <Lock className="w-3.5 h-3.5 mr-1.5" />
                    {t('portal:tabs.myLocker')}
                  </TabsTrigger>
                )}
                {rankingHistory.length > 0 && (
                  <TabsTrigger value="rankings" className="data-[state=active]:bg-white/10">
                    <Trophy className="w-3.5 h-3.5 mr-1.5" />
                    {t('portal:tabs.rankings')}
                  </TabsTrigger>
                )}
                {loyaltyData && (
                  <TabsTrigger value="loyalty" className="data-[state=active]:bg-white/10">
                    <Star className="w-3.5 h-3.5 mr-1.5" />
                    {t('portal:tabs.loyalty')}
                  </TabsTrigger>
                )}
                {myInvoices.length > 0 && (
                  <TabsTrigger value="invoices" className="data-[state=active]:bg-white/10">
                    <FileText className="w-3.5 h-3.5 mr-1.5" />
                    {t('portal:tabs.invoices')}
                  </TabsTrigger>
                )}
                {levyCharges.length > 0 && (
                  <TabsTrigger value="levies" className="data-[state=active]:bg-white/10">
                    <DollarSign className="w-3.5 h-3.5 mr-1.5" />
                    Levies
                  </TabsTrigger>
                )}
                {myTeeBookings.length > 0 && (
                  <TabsTrigger value="tee-bookings" className="data-[state=active]:bg-white/10">
                    <Clock className="w-3.5 h-3.5 mr-1.5" />
                    {t('portal:tabs.teeBookings')}
                  </TabsTrigger>
                )}
                <TabsTrigger value="upcoming" className="data-[state=active]:bg-white/10">
                  <Calendar className="w-3.5 h-3.5 mr-1.5" />
                  Upcoming
                </TabsTrigger>
                <TabsTrigger value="profile" className="data-[state=active]:bg-white/10">
                  <Bell className="w-3.5 h-3.5 mr-1.5" />
                  {t('portal:tabs.notifications')}
                </TabsTrigger>
              </TabsList>

              <TabsContent value="tournaments" className="mt-4">
                {tournaments.length === 0 ? (
                  <Card className="glass-panel border-white/10 p-12 text-center" data-testid="portal-tournaments-empty">
                    <Flag className="w-10 h-10 text-muted-foreground opacity-30 mx-auto mb-3" />
                    <p className="text-muted-foreground">{t('portal:emptyStates.noTournaments')}</p>
                    <p className="text-xs text-muted-foreground mt-1">{t('portal:emptyStates.noTournamentsDesc')}</p>
                  </Card>
                ) : (
                  <>
                  <div className="space-y-3">
                    {tournaments.map(row => (
                      <Card
                        key={row.playerId}
                        className="glass-panel border-white/10 p-4 hover:bg-white/[0.03] transition-colors"
                        data-testid={`portal-tournament-row-${row.tournamentId}`}
                      >
                        <div className="flex items-start gap-4">
                          <div className="flex-1 min-w-0">
                            <p className="font-semibold text-white truncate">{row.tournamentName}</p>
                            <div className="flex items-center gap-2 mt-1 flex-wrap">
                              <span className="text-xs text-muted-foreground">{t(`portal:formats.${row.tournamentFormat}`, { defaultValue: row.tournamentFormat })}</span>
                              {row.startDate && (
                                <span className="text-xs text-muted-foreground">· {new Date(row.startDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}</span>
                              )}
                              {row.handicapIndex && (
                                <span className="text-xs text-muted-foreground">· HCP {row.handicapIndex}</span>
                              )}
                            </div>
                          </div>
                          <div className="flex items-center gap-2 flex-shrink-0">
                            {withdrawnTournaments.has(row.tournamentId) ? (
                              <>
                                <Badge className="bg-orange-900/40 text-orange-400 border-orange-700/40 border text-xs">{t('portal:withdrawn')}</Badge>
                                {withdrawnTournaments.get(row.tournamentId)?.refundPending && (
                                  <Badge className="bg-yellow-900/40 text-yellow-400 border-yellow-700/40 border text-xs">{t('portal:refundPending')}</Badge>
                                )}
                              </>
                            ) : (
                              <>
                                <Badge className={`${STATUS_COLORS[row.tournamentStatus] ?? ''} border text-xs`}>
                                  {row.tournamentStatus}
                                </Badge>
                                {row.paymentStatus === 'paid' && (
                                  <Badge className="bg-green-900/40 text-green-400 border-green-700/40 border text-xs">{t('portal:paid')}</Badge>
                                )}
                              </>
                            )}
                          </div>
                        </div>
                        {(row.tournamentStatus === 'active' || row.tournamentStatus === 'completed') && (
                          <div className="mt-3 pt-3 border-t border-white/5 flex gap-2 flex-wrap">
                            <a
                              href={`/leaderboard/${row.tournamentId}${row.leaderboardType === 'net' ? '?mode=net' : ''}`}
                              className="inline-flex items-center gap-1.5 text-xs text-primary hover:text-primary/80 font-medium transition-colors"
                            >
                              <Trophy className="w-3.5 h-3.5" />
                              {t('portal:viewLeaderboard')}
                              <ExternalLink className="w-3 h-3" />
                            </a>
                            <span className="text-white/10">·</span>
                            <button
                              onClick={() => navigate(`/portal/scores/${row.tournamentId}`)}
                              className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-white font-medium transition-colors"
                            >
                              <BarChart3 className="w-3.5 h-3.5" />
                              {t('portal:myScorecard')}
                            </button>
                            {row.selfPosting && row.tournamentStatus === 'active' && (
                              <>
                                <span className="text-white/10">·</span>
                                <button
                                  onClick={() => navigate(`/portal/scores/${row.tournamentId}`)}
                                  className="inline-flex items-center gap-1.5 text-xs text-emerald-400 hover:text-emerald-300 font-medium transition-colors"
                                >
                                  <PenLine className="w-3.5 h-3.5" />
                                  {t('portal:enterScores')}
                                </button>
                                {row.markerValidation && (
                                  <>
                                    <span className="text-white/10">·</span>
                                    <button
                                      onClick={() => navigate('/portal/marker-sign')}
                                      className="inline-flex items-center gap-1.5 text-xs text-cyan-400 hover:text-cyan-300 font-medium transition-colors"
                                    >
                                      <ShieldCheck className="w-3.5 h-3.5" />
                                      {t('portal:signCard')}
                                    </button>
                                  </>
                                )}
                              </>
                            )}
                          </div>
                        )}
                        {row.tournamentStatus === 'upcoming' && !withdrawnTournaments.has(row.tournamentId) && (
                          <div className="mt-3 pt-3 border-t border-white/5 flex gap-2">
                            <button
                              onClick={() => setWithdrawingTournamentId(row.tournamentId)}
                              className="inline-flex items-center gap-1.5 text-xs text-orange-400 hover:text-orange-300 font-medium transition-colors"
                              data-testid={`button-withdraw-tournament-${row.tournamentId}`}
                            >
                              <LogOutIcon className="w-3.5 h-3.5" />
                              {t('portal:withdraw')}
                            </button>
                          </div>
                        )}
                      </Card>
                    ))}
                  </div>

                  {/* Withdrawal confirm dialog */}
                  <Dialog open={withdrawingTournamentId !== null} onOpenChange={open => { if (!open && !withdrawLoading) setWithdrawingTournamentId(null); }}>
                    <DialogContent className="glass-panel border-white/10 sm:max-w-sm">
                      <DialogHeader>
                        <DialogTitle className="text-white">{t('portal:withdrawTitle')}</DialogTitle>
                      </DialogHeader>
                      <p className="text-sm text-muted-foreground">
                        {t('portal:withdrawConfirmText', { name: tournaments.find(t => t.tournamentId === withdrawingTournamentId)?.tournamentName ?? '' })}
                      </p>
                      <DialogFooter className="gap-2 mt-2">
                        <Button variant="outline" className="bg-white/5 border-white/10 text-white" disabled={withdrawLoading} onClick={() => setWithdrawingTournamentId(null)}>
                          {t('portal:cancel')}
                        </Button>
                        <Button
                          variant="destructive"
                          disabled={withdrawLoading}
                          onClick={handleWithdrawConfirm}
                          className="bg-orange-600 hover:bg-orange-700"
                          data-testid="button-confirm-withdraw"
                        >
                          {withdrawLoading ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
                          {t('portal:confirmWithdrawal')}
                        </Button>
                      </DialogFooter>
                    </DialogContent>
                  </Dialog>
                  </>
                )}
              </TabsContent>

              <TabsContent value="leagues" className="mt-4">
                <LeaguesTab leagues={leagues} />
              </TabsContent>

              <TabsContent value="rankings" className="mt-4">
                {rankingHistory.length === 0 ? (
                  <Card className="glass-panel border-white/10 p-12 text-center" data-testid="portal-rankings-empty">
                    <Trophy className="w-10 h-10 text-muted-foreground opacity-30 mx-auto mb-3" />
                    <p className="text-muted-foreground">{t('portal:noRankingEntries')}</p>
                    <p className="text-xs text-muted-foreground mt-1">{t('portal:youllAppearHereRanked')}</p>
                  </Card>
                ) : (
                  <div className="space-y-4">
                    {rankingHistory.map((entry) => (
                      <Card
                        key={entry.id}
                        className="glass-panel border-white/10 p-5"
                        data-testid={`portal-ranking-entry-${entry.seriesId}`}
                      >
                        <div className="flex items-start justify-between mb-3">
                          <div>
                            <h3 className="text-white font-semibold">{entry.seriesName ?? "Ranking Series"}</h3>
                            <div className="flex items-center gap-2 mt-1">
                              {entry.seriesLevel && (
                                <span className="text-xs px-2 py-0.5 rounded-full bg-primary/20 text-primary font-medium capitalize">
                                  {entry.seriesLevel}
                                </span>
                              )}
                              <span className="text-xs text-muted-foreground capitalize">{entry.category}</span>
                              {entry.seasonStart && entry.seasonEnd && (
                                <span className="text-xs text-muted-foreground">
                                  {new Date(entry.seasonStart).getFullYear()}
                                </span>
                              )}
                            </div>
                          </div>
                          <div className="text-right">
                            <p className="text-2xl font-bold text-primary">{entry.totalPoints} pts</p>
                            {entry.position !== null && (
                              <p className="text-sm text-white font-semibold">
                                {entry.position === 1 ? "🥇" : entry.position === 2 ? "🥈" : entry.position === 3 ? "🥉" : `#${entry.position}`} Position
                              </p>
                            )}
                          </div>
                        </div>
                        <div className="grid grid-cols-3 gap-3 border-t border-white/10 pt-3 mb-4">
                          {[
                            { label: t('portal:stats.events'), value: entry.eventsPlayed },
                            { label: t('portal:stats.wins'), value: entry.wins },
                            { label: t('portal:stats.top3'), value: entry.top3 },
                          ].map((stat) => (
                            <div key={stat.label} className="text-center">
                              <p className="text-white font-bold text-lg">{stat.value}</p>
                              <p className="text-muted-foreground text-xs">{stat.label}</p>
                            </div>
                          ))}
                        </div>
                        {entry.history.length > 0 && (
                          <div>
                            <p className="text-xs text-muted-foreground uppercase tracking-wide font-semibold mb-2">{t('portal:eventHistory')}</p>
                            <div className="space-y-2">
                              {entry.history.map((h) => (
                                <div key={h.id} className="flex items-center justify-between text-sm">
                                  <div>
                                    <span className="text-white">{h.tournamentName ?? "Tournament"}</span>
                                    {h.tournamentDate && (
                                      <span className="text-muted-foreground text-xs ml-2">
                                        {new Date(h.tournamentDate).toLocaleDateString("en", { day: "numeric", month: "short" })}
                                      </span>
                                    )}
                                  </div>
                                  <div className="flex items-center gap-2">
                                    <span className="text-muted-foreground text-xs">
                                      {h.position === 1 ? "🥇" : h.position === 2 ? "🥈" : h.position === 3 ? "🥉" : `#${h.position}`}
                                    </span>
                                    <span className="text-primary font-semibold">+{h.pointsAwarded} pts</span>
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </Card>
                    ))}
                  </div>
                )}
              </TabsContent>

              <TabsContent value="membership" className="mt-4">
                <MembershipTab
                  membership={membership}
                  orgId={user?.organizationId ?? null}
                  tiers={tiers}
                  tiersLoading={tiersLoading}
                  subscribeTierId={subscribeTierId}
                  setSubscribeTierId={setSubscribeTierId}
                  subscribeLoading={subscribeLoading}
                  handleSubscribe={handleSubscribe}
                  showInDirectory={showInDirectory}
                  directoryOptLoading={directoryOptLoading}
                  handleDirectoryOptIn={handleDirectoryOptIn}
                  downloadMemberCard={downloadMemberCard}
                  cancelLoading={cancelLoading}
                  handleCancelSubscription={handleCancelSubscription}
                />
              </TabsContent>

              <TabsContent value="orders" className="mt-4">
                {myOrders.length === 0 ? (
                  <Card className="glass-panel border-white/10 p-12 text-center" data-testid="portal-orders-empty">
                    <ShoppingBag className="w-10 h-10 text-muted-foreground opacity-30 mx-auto mb-3" />
                    <p className="text-muted-foreground">{t('portal:noOrdersYet')}</p>
                    <p className="text-xs text-muted-foreground mt-1">{t('portal:visitShopBrowse')}</p>
                    {user?.organizationId && (
                      <a href={`/shop/${user.organizationId}`} className="inline-flex items-center gap-1.5 text-sm text-primary hover:text-primary/80 font-medium mt-4 transition-colors">
                        <ShoppingBag className="w-4 h-4" /> {t('portal:goToShop')} <ExternalLink className="w-3.5 h-3.5" />
                      </a>
                    )}
                  </Card>
                ) : (
                  <div className="space-y-3">
                    {myOrders.map(o => (
                      <Card key={o.id} className="glass-panel border-white/10 p-4" data-testid={`portal-order-row-${o.id}`}>
                        <div className="flex items-start gap-4">
                          {o.productImage ? (
                            <img src={o.productImage} alt={o.productName ?? 'Product'} className="w-12 h-12 rounded-lg object-cover bg-white/5 flex-shrink-0" />
                          ) : (
                            <div className="w-12 h-12 rounded-lg bg-white/5 flex items-center justify-center flex-shrink-0">
                              <Package className="w-5 h-5 text-muted-foreground" />
                            </div>
                          )}
                          <div className="flex-1 min-w-0">
                            <p className="font-semibold text-white truncate">{o.productName ?? `Order #${o.id}`}</p>
                            <div className="flex items-center gap-2 mt-1 flex-wrap">
                              {o.size && <span className="text-xs text-muted-foreground">{t('portal:sizeLabel', { size: o.size })}</span>}
                              {o.quantity > 1 && <span className="text-xs text-muted-foreground">· {t('portal:qtyLabel', { count: o.quantity })}</span>}
                              <span className="text-xs text-muted-foreground">·</span>
                              <span className="text-xs text-muted-foreground">
                                {new Date(o.createdAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}
                              </span>
                            </div>
                            {(o.trackingNumber || o.trackingUrl) && (
                              <div className="mt-2 flex items-center gap-1.5">
                                <Truck className="w-3.5 h-3.5 text-cyan-400 flex-shrink-0" />
                                {o.trackingUrl ? (
                                  <a href={o.trackingUrl} target="_blank" rel="noopener noreferrer" className="text-xs text-cyan-400 hover:text-cyan-300 transition-colors">
                                    {o.trackingNumber ?? t('portal:trackShipment')} <ExternalLink className="w-3 h-3 inline" />
                                  </a>
                                ) : (
                                  <span className="text-xs text-muted-foreground font-mono">{o.trackingNumber}</span>
                                )}
                              </div>
                            )}
                          </div>
                          <div className="flex flex-col items-end gap-2 flex-shrink-0">
                            <Badge className={`text-xs border capitalize ${PORTAL_ORDER_STATUS_COLORS[o.status] ?? 'bg-gray-500/20 text-gray-400 border-gray-500/30'}`}>
                              {o.status}
                            </Badge>
                            <span className="text-sm font-semibold text-white">{portalFmtPrice(o.totalAmount, o.currency)}</span>
                            {o.status !== 'pending' && o.status !== 'cancelled' && o.status !== 'cod_pending' && (
                              <a
                                href={`/api/payments/shop-order/${o.id}/receipt`}
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex items-center gap-1 text-xs text-cyan-400 hover:text-cyan-300 transition-colors"
                                data-testid={`link-order-receipt-${o.id}`}
                              >
                                <Download className="w-3 h-3" /> {t('portal:downloadReceipt', { defaultValue: 'Receipt' })}
                              </a>
                            )}
                          </div>
                        </div>
                      </Card>
                    ))}
                  </div>
                )}
              </TabsContent>

              <TabsContent value="wishlist" className="mt-4">
                {myWishlist.length === 0 ? (
                  <Card className="glass-panel border-white/10 p-12 text-center" data-testid="portal-wishlist-empty">
                    <Heart className="w-10 h-10 text-muted-foreground opacity-30 mx-auto mb-3" />
                    <p className="text-muted-foreground">{t('portal:wishlistEmpty')}</p>
                    <p className="text-xs text-muted-foreground mt-1">{t('portal:saveProductsNote')}</p>
                    {user?.organizationId && (
                      <a href={`/shop/${user.organizationId}`} className="inline-flex items-center gap-1.5 text-sm text-primary hover:text-primary/80 font-medium mt-4 transition-colors">
                        <ShoppingBag className="w-4 h-4" /> {t('portal:browseShop')} <ExternalLink className="w-3.5 h-3.5" />
                      </a>
                    )}
                  </Card>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {myWishlist.map(w => (
                      <Card
                        key={w.wishlistId}
                        className="glass-panel border-white/10 p-4 flex items-center gap-4"
                        data-testid={`portal-wishlist-row-${w.wishlistId}`}
                      >
                        {w.product.imageUrl ? (
                          <img src={w.product.imageUrl} alt={w.product.name} className="w-14 h-14 rounded-lg object-cover bg-white/5 flex-shrink-0" />
                        ) : (
                          <div className="w-14 h-14 rounded-lg bg-white/5 flex items-center justify-center flex-shrink-0">
                            <ShoppingBag className="w-6 h-6 text-muted-foreground" />
                          </div>
                        )}
                        <div className="flex-1 min-w-0">
                          <p className="font-semibold text-white truncate">{w.product.name}</p>
                          <p className="text-xs text-muted-foreground capitalize mt-0.5">{w.product.category}</p>
                          <p className="text-sm text-primary font-semibold mt-1">{portalFmtPrice(w.product.markupPrice, w.product.currency)}</p>
                        </div>
                        {user?.organizationId && (
                          <a
                            href={`/shop/${user.organizationId}?product=${w.product.id}`}
                            className="flex-shrink-0 inline-flex items-center gap-1 text-xs bg-primary text-white hover:bg-primary/90 rounded-lg px-2.5 py-1.5 transition-colors font-medium"
                            data-testid={`link-add-to-cart-${w.product.id}`}
                          >
                            <ShoppingBag className="w-3 h-3" /> Add to Cart
                          </a>
                        )}
                      </Card>
                    ))}
                  </div>
                )}
              </TabsContent>

              <TabsContent value="loyalty" className="mt-4 space-y-4">
                {loyaltyData && (
                  <>
                    {/* Points Balance Card */}
                    <Card className="glass-panel border-white/10 p-6" data-testid="portal-loyalty-balance">
                      <div className="flex items-center gap-2 mb-4">
                        <Star className="w-5 h-5 text-amber-400" />
                        <h3 className="text-white font-semibold">
                          {t('portal:pointsBalance', { points: loyaltyData.programme?.pointsName ?? t('common:points') })}
                        </h3>
                      </div>
                      <div className="flex items-center justify-between mb-6">
                        <div>
                          <p className="text-4xl font-black text-amber-400">{loyaltyData.account.pointsBalance.toLocaleString()}</p>
                          <p className="text-xs text-muted-foreground mt-1">{loyaltyData.programme?.pointsName ?? 'Points'} available</p>
                        </div>
                        {loyaltyData.account.currentTier !== 'none' && (
                          <div className={`px-4 py-2 rounded-xl border text-sm font-bold ${
                            loyaltyData.account.currentTier === 'platinum' ? 'bg-purple-500/20 text-purple-300 border-purple-500/30'
                            : loyaltyData.account.currentTier === 'gold' ? 'bg-amber-500/20 text-amber-300 border-amber-500/30'
                            : 'bg-slate-400/20 text-slate-300 border-slate-400/30'
                          }`}>
                            {loyaltyData.account.currentTier === 'platinum' ? '💎'
                              : loyaltyData.account.currentTier === 'gold' ? '🥇' : '🥈'}{' '}
                            {loyaltyData.currentTierDef?.label ?? loyaltyData.account.currentTier}
                          </div>
                        )}
                      </div>
                      <div className="grid grid-cols-2 gap-4 mb-4">
                        <div className="bg-white/[0.04] rounded-xl p-4 border border-white/10">
                          <p className="text-xs text-muted-foreground mb-1">Lifetime Earned</p>
                          <p className="text-white font-semibold text-lg">{loyaltyData.account.lifetimePoints.toLocaleString()}</p>
                        </div>
                        <div className="bg-white/[0.04] rounded-xl p-4 border border-white/10">
                          <p className="text-xs text-muted-foreground mb-1">Earned This Year</p>
                          <p className="text-white font-semibold text-lg">{loyaltyData.account.rollingYearPoints.toLocaleString()}</p>
                        </div>
                      </div>
                      {/* Tier progress */}
                      {loyaltyData.nextTier && loyaltyData.pointsToNextTier != null && (
                        <div className="bg-white/[0.03] rounded-xl p-4 border border-white/10">
                          <div className="flex items-center justify-between mb-2">
                            <p className="text-xs text-muted-foreground">Progress to {loyaltyData.nextTier.label}</p>
                            <p className="text-xs text-amber-400 font-medium">{loyaltyData.pointsToNextTier.toLocaleString()} pts needed</p>
                          </div>
                          <div className="h-2 bg-white/10 rounded-full overflow-hidden">
                            <div
                              className="h-full bg-gradient-to-r from-amber-500 to-amber-300 rounded-full transition-all"
                              style={{ width: `${Math.min(100, 100 - (loyaltyData.pointsToNextTier / loyaltyData.nextTier.minPoints) * 100)}%` }}
                            />
                          </div>
                        </div>
                      )}
                      {/* Current tier perks */}
                      {loyaltyData.currentTierDef?.perks && loyaltyData.currentTierDef.perks.length > 0 && (
                        <div className="mt-4">
                          <p className="text-xs text-muted-foreground uppercase tracking-wider mb-2">Your Tier Benefits</p>
                          <div className="space-y-1">
                            {loyaltyData.currentTierDef.perks.map((perk, i) => (
                              <div key={i} className="flex items-start gap-2 text-sm text-white/80">
                                <CheckCircle className="w-3.5 h-3.5 text-green-400 mt-0.5 flex-shrink-0" />
                                {perk}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </Card>
                    {/* Rewards Catalogue */}
                    {loyaltyRewards.length > 0 && (
                      <Card className="glass-panel border-white/10 p-6">
                        <div className="flex items-center gap-2 mb-4">
                          <Gift className="w-5 h-5 text-primary" />
                          <h3 className="text-white font-semibold">Rewards Catalogue</h3>
                        </div>
                        <div className="space-y-3">
                          {loyaltyRewards.map(reward => {
                            const canAfford = loyaltyData.account.pointsBalance >= reward.pointsCost;
                            return (
                              <div
                                key={reward.id}
                                className={`flex items-center gap-3 p-3 rounded-xl border ${canAfford ? 'bg-white/[0.03] border-white/10' : 'bg-white/[0.02] border-white/5 opacity-70'}`}
                                data-testid={`portal-loyalty-reward-${reward.id}`}
                              >
                                <div className={`w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 ${canAfford ? 'bg-primary/20' : 'bg-white/5'}`}>
                                  <Gift className={`w-4 h-4 ${canAfford ? 'text-primary' : 'text-muted-foreground'}`} />
                                </div>
                                <div className="flex-1 min-w-0">
                                  <p className="text-white text-sm font-medium truncate">{reward.name}</p>
                                  {reward.description && <p className="text-xs text-muted-foreground mt-0.5 truncate">{reward.description}</p>}
                                  {!canAfford && (
                                    <p className="text-xs text-amber-400/70 mt-0.5">Need {(reward.pointsCost - loyaltyData.account.pointsBalance).toLocaleString()} more pts</p>
                                  )}
                                </div>
                                <div className="flex items-center gap-2 flex-shrink-0">
                                  <span className="text-amber-400 text-sm font-bold">{reward.pointsCost.toLocaleString()}</span>
                                  <Coins className="w-3.5 h-3.5 text-amber-400" />
                                </div>
                              </div>
                            );
                          })}
                        </div>
                        <p className="text-xs text-muted-foreground mt-4 text-center">Contact your club to redeem rewards at the reception desk.</p>
                      </Card>
                    )}
                  </>
                )}
              </TabsContent>

              <TabsContent value="locker" className="mt-4">
                <LockerTab
                  lockerAssignment={lockerAssignment}
                  lockerWaitlist={lockerWaitlist}
                  joiningWaitlist={joiningWaitlist}
                  setJoiningWaitlist={setJoiningWaitlist}
                  setLockerWaitlist={setLockerWaitlist}
                  orgId={user?.organizationId ?? null}
                />
              </TabsContent>

              <TabsContent value="invoices" className="mt-4">
                <InvoicesTab invoices={myInvoices} orgId={user?.organizationId ?? null} />
              </TabsContent>

              {/* ─── Levies Tab ─── */}
              <TabsContent value="levies" className="mt-4 space-y-3">
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-white font-semibold text-base flex items-center gap-2">
                    <DollarSign className="w-4 h-4 text-primary" /> My Levies
                  </h3>
                  <div className="text-sm text-muted-foreground">
                    Outstanding balance: <span className="text-white font-semibold">{statementOutstanding}</span>
                  </div>
                </div>
                {levyCharges.length === 0 ? (
                  <Card className="glass-panel border-white/10 p-12 text-center">
                    <DollarSign className="w-10 h-10 text-muted-foreground opacity-30 mx-auto mb-3" />
                    <p className="text-muted-foreground">No levy charges on your account.</p>
                  </Card>
                ) : (
                  <div className="space-y-3">
                    {levyCharges.map(row => {
                      const remaining = levyRemaining(row);
                      const fullyPaid = row.charge.paid || remaining <= 0 || row.charge.status === 'paid';
                      const waived = row.charge.status === 'waived';
                      const refunded = row.charge.status === 'refunded';
                      const partial = row.charge.status === 'partial' || (parseFloat(row.charge.paidAmount) > 0 && !fullyPaid);
                      const CURRENCY_SYM: Record<string, string> = { INR: '₹', USD: '$', GBP: '£', AED: 'د.إ', EUR: '€', SGD: 'S$', AUD: 'A$' };
                      const sym = CURRENCY_SYM[row.levy.currency] ?? '';
                      const isPaying = payingChargeId === row.charge.id;
                      return (
                        <Card key={row.charge.id} className="glass-panel border-white/10 p-4">
                          <div className="flex flex-wrap items-start justify-between gap-3">
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="text-white font-semibold">{row.levy.name}</span>
                                {fullyPaid && <span className="text-xs px-2 py-0.5 rounded bg-green-500/20 text-green-300">Paid</span>}
                                {partial && !fullyPaid && <span className="text-xs px-2 py-0.5 rounded bg-amber-500/20 text-amber-300">Partial</span>}
                                {!fullyPaid && !partial && !waived && !refunded && <span className="text-xs px-2 py-0.5 rounded bg-red-500/20 text-red-300">Unpaid</span>}
                                {waived && <span className="text-xs px-2 py-0.5 rounded bg-slate-500/20 text-slate-300">Waived</span>}
                                {refunded && <span className="text-xs px-2 py-0.5 rounded bg-blue-500/20 text-blue-300">Refunded</span>}
                              </div>
                              {row.levy.description && (
                                <p className="text-xs text-muted-foreground mt-1 truncate">{row.levy.description}</p>
                              )}
                              <div className="text-xs text-muted-foreground mt-2 flex flex-wrap gap-x-4 gap-y-1">
                                <span>Total: <PriceWithFx orgId={user?.organizationId ?? null} amount={row.charge.amount} currency={row.levy.currency} bookedClassName="text-white" showDisclosure={false} disclosureOnHover /></span>
                                <span>Paid: <span className="text-white">{sym}{row.charge.paidAmount}</span></span>
                                {parseFloat(row.charge.refundedAmount) > 0 && (
                                  <span>Refunded: <span className="text-white">{sym}{row.charge.refundedAmount}</span></span>
                                )}
                                {!fullyPaid && !waived && (
                                  <span>Remaining: <PriceWithFx orgId={user?.organizationId ?? null} amount={remaining.toFixed(2)} currency={row.levy.currency} bookedClassName="text-white font-semibold" /></span>
                                )}
                              </div>
                            </div>
                            {!fullyPaid && !waived && remaining > 0 && (
                              <div className="flex flex-col gap-2 shrink-0">
                                <Button
                                  size="sm"
                                  className="bg-primary hover:bg-primary/90"
                                  disabled={isPaying}
                                  onClick={() => payLevyCharge(row.charge.id)}
                                  data-testid={`button-pay-levy-${row.charge.id}`}
                                >
                                  {isPaying ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <CreditCard className="w-3.5 h-3.5 mr-1.5" />}
                                  Pay {sym}{remaining.toFixed(2)}
                                </Button>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  disabled={isPaying}
                                  onClick={() => openPartialPaymentDialog(row)}
                                  data-testid={`button-partial-pay-levy-${row.charge.id}`}
                                >
                                  Pay partial
                                </Button>
                              </div>
                            )}
                          </div>
                        </Card>
                      );
                    })}
                  </div>
                )}
                {partialDialogCharge && (
                  <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => setPartialDialogCharge(null)}>
                    <Card className="glass-panel border-white/10 p-5 w-full max-w-sm" onClick={e => e.stopPropagation()}>
                      <h4 className="text-white font-semibold mb-3">Pay partial amount</h4>
                      <p className="text-xs text-muted-foreground mb-3">
                        {partialDialogCharge.levy.name} — Remaining {levyRemaining(partialDialogCharge).toFixed(2)} {partialDialogCharge.levy.currency}
                      </p>
                      <Input
                        type="number"
                        step="0.01"
                        min="0.01"
                        max={levyRemaining(partialDialogCharge)}
                        placeholder="Amount"
                        value={partialDialogAmount}
                        onChange={e => setPartialDialogAmount(e.target.value)}
                        data-testid="input-partial-pay-amount"
                      />
                      <div className="flex justify-end gap-2 mt-4">
                        <Button size="sm" variant="ghost" onClick={() => setPartialDialogCharge(null)}>Cancel</Button>
                        <Button size="sm" onClick={submitPartialPayment} data-testid="button-submit-partial-pay">Continue</Button>
                      </div>
                    </Card>
                  </div>
                )}
              </TabsContent>

              {/* ─── Tee Bookings Tab ─── */}
              <TabsContent value="tee-bookings" className="mt-4">
                <TeeBookingsTab
                  bookings={myTeeBookings}
                  setBookings={setMyTeeBookings}
                  orgId={user?.organizationId ?? null}
                  cancellingBookingId={cancellingBookingId}
                  setCancellingBookingId={setCancellingBookingId}
                />
              </TabsContent>

              <TabsContent value="upcoming" className="mt-4">
                <UpcomingFullList
                  initialKind={(() => {
                    if (typeof window === 'undefined') return undefined;
                    const k = new URLSearchParams(window.location.search).get('kind');
                    return k === 'tee' || k === 'lesson' || k === 'range' || k === 'fb' || k === 'rental' || k === 'wallet_topup'
                      ? k
                      : undefined;
                  })()}
                />
              </TabsContent>

              <TabsContent value="profile" className="mt-4">
                <ProfileTab
                  user={user}
                  ghinNumber={ghinNumber}
                  setGhinNumber={setGhinNumber}
                  ghinSaved={ghinSaved}
                  savingGhin={savingGhin}
                  saveGhin={saveGhin}
                  savingLang={savingLang}
                  saveLanguagePreference={saveLanguagePreference}
                  notifPrefs={notifPrefs}
                  notifCaps={notifCaps}
                  savingNotifPref={savingNotifPref}
                  saveNotifPref={saveNotifPref}
                />
              </TabsContent>
            </Tabs>
          </>
        )}
      </div>
    </PortalShell>
  );
}

interface OrgContact {
  name: string;
  contactEmail: string | null;
  contactPhone: string | null;
  address: string | null;
  website: string | null;
}

function PortalShell({ children, user, onLogout, orgId }: {
  children: React.ReactNode;
  user?: PlayerUser | null;
  onLogout?: () => void;
  orgId?: number | null;
}) {
  const [orgContact, setOrgContact] = useState<OrgContact | null>(null);
  // Task #1438 — pull the active org's branding so the portal header swaps
  // the default KHARAGOLF wordmark for the club's saved logo (when set).
  // Falls back to the wordmark when no logo is configured.
  const orgBranding = useOrgBranding();
  const orgLogoUrl = orgBranding?.logoUrl || null;
  useEffect(() => {
    const id = orgId ?? 1;
    fetch(`/api/public/orgs/${id}/contact`).then(r => r.ok ? r.json() : null).then(d => { if (d) setOrgContact(d); }).catch(() => {});
  }, [orgId]);

  const hasContact = orgContact && (orgContact.contactEmail || orgContact.contactPhone || orgContact.address || orgContact.website);

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <header className="border-b border-white/10 bg-black/60 backdrop-blur-sm sticky top-0 z-50">
        <div className="max-w-4xl mx-auto px-4 h-14 flex items-center justify-between">
          <div className="flex items-center gap-3">
            {orgLogoUrl ? (
              <img
                src={orgLogoUrl}
                alt={orgContact?.name ? `${orgContact.name} logo` : 'Club logo'}
                className="h-8 w-auto max-w-[160px] object-contain"
                data-testid="portal-org-logo"
              />
            ) : (
              <KharaGolfWordmark className="text-lg" />
            )}
            <Badge className="bg-primary/20 text-primary border-primary/30 border text-[10px] tracking-wider">PLAYER PORTAL</Badge>
          </div>
          {user && onLogout && (
            <button onClick={onLogout} className="flex items-center gap-1.5 text-muted-foreground hover:text-white text-sm transition-colors">
              <LogOut className="w-4 h-4" />
              Sign Out
            </button>
          )}
        </div>
      </header>
      <main className="flex-1">{children}</main>
      {hasContact && (
        <footer className="border-t border-white/5 bg-black/40 mt-auto">
          <div className="max-w-4xl mx-auto px-4 py-6">
            <p className="text-[11px] text-muted-foreground uppercase tracking-widest mb-3 font-semibold">{orgContact!.name}</p>
            <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
              {orgContact!.contactEmail && (
                <a href={`mailto:${orgContact!.contactEmail}`} className="flex items-center gap-1.5 hover:text-white transition-colors">
                  <span className="text-primary">✉</span> {orgContact!.contactEmail}
                </a>
              )}
              {orgContact!.contactPhone && (
                <a href={`tel:${orgContact!.contactPhone}`} className="flex items-center gap-1.5 hover:text-white transition-colors">
                  <span className="text-primary">📞</span> {orgContact!.contactPhone}
                </a>
              )}
              {orgContact!.address && (
                <span className="flex items-center gap-1.5">
                  <span className="text-primary">📍</span> {orgContact!.address}
                </span>
              )}
              {orgContact!.website && (
                <a href={orgContact!.website} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1.5 hover:text-white transition-colors">
                  <span className="text-primary">🌐</span> {orgContact!.website}
                </a>
              )}
            </div>
          </div>
        </footer>
      )}
    </div>
  );
}

export function PortalHandicapCalc({ currentHI }: { currentHI: number }) {
  // Labels are intentionally hardcoded English strings here. PortalHandicapCalc
  // previously pulled them from useTranslation('portal') via `t('portal:calc.*')`,
  // which was the source of the recurring "t is not defined" runtime crash on
  // /portal whenever the destructure was accidentally removed during edits to
  // this large file. Keeping the labels self-contained removes that whole class
  // of bug — the surrounding heading is already English-only too. (Task #354)
  const [hi, setHi] = useState(currentHI);
  const [slope, setSlope] = useState(113);
  const [cr, setCr] = useState(72.0);
  const [par, setPar] = useState(72);
  const [pct, setPct] = useState(100);
  const [grossScore, setGrossScore] = useState<number | null>(null);
  const [result, setResult] = useState<{
    courseHandicap: number; playingHandicap: number; netPar: number; parDiff: number;
    projectedHandicapIndex: number | null; differential: number | null;
  } | null>(null);

  useEffect(() => {
    const params = new URLSearchParams({
      handicapIndex: String(hi), courseSlope: String(slope), courseRating: String(cr),
      coursePar: String(par), handicapAllowance: String(pct),
    });
    if (grossScore !== null) params.set('grossScore', String(grossScore));
    fetch(`/api/portal/handicap/simulate?${params}`, { credentials: 'include' })
      .then(r => r.ok ? r.json() : null)
      .then(d => d && setResult(d))
      .catch(() => null);
  }, [hi, slope, cr, par, pct, grossScore]);

  const sliderCls = "w-full h-1.5 rounded-full appearance-none bg-white/10 accent-[#C9A84C]";

  const indexDelta = result?.projectedHandicapIndex != null ? result.projectedHandicapIndex - hi : null;

  return (
    <Card className="glass-panel border-white/10 p-5" data-testid="portal-handicap-calc">
      <div className="flex items-center gap-2 mb-4">
        <span className="text-base">⛳</span>
        <p className="text-sm font-semibold text-white">Handicap What-If Calculator</p>
        <span className="ml-auto text-[10px] text-muted-foreground uppercase tracking-wider">WHS Formula</span>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        <div className="space-y-4">
          {([
            { label: 'My Handicap Index', val: hi, set: setHi, min: 0, max: 54, step: 0.1, fmt: (v: number) => v.toFixed(1) },
            { label: 'Slope Rating', val: slope, set: setSlope, min: 55, max: 155, step: 1, fmt: (v: number) => String(v) },
            { label: 'Course Rating', val: cr, set: setCr, min: 60, max: 80, step: 0.1, fmt: (v: number) => v.toFixed(1) },
            { label: 'Par', val: par, set: setPar, min: 68, max: 74, step: 1, fmt: (v: number) => String(v) },
            { label: 'Allowance %', val: pct, set: setPct, min: 50, max: 100, step: 5, fmt: (v: number) => `${v}%` },
          ] as { label: string; val: number; set: (v: number) => void; min: number; max: number; step: number; fmt: (v: number) => string }[]).map(({ label, val, set, min, max, step, fmt }) => (
            <div key={label}>
              <div className="flex justify-between text-xs mb-1.5">
                <span className="text-muted-foreground">{label}</span>
                <span className="font-semibold text-white">{fmt(val)}</span>
              </div>
              <input type="range" className={sliderCls} min={min} max={max} step={step}
                value={val} onChange={e => set(parseFloat(e.target.value))} />
            </div>
          ))}
          {/* What-if gross score input */}
          <div>
            <div className="flex justify-between text-xs mb-1.5">
              <span className="text-muted-foreground">What-If Gross Score</span>
              <span className="font-semibold text-white">{grossScore ?? 'None'}</span>
            </div>
            <div className="flex items-center gap-2">
              <input type="range" className={sliderCls} min={60} max={130} step={1}
                value={grossScore ?? par}
                onChange={e => setGrossScore(parseInt(e.target.value))} />
              {grossScore !== null && (
                <button
                  onClick={() => setGrossScore(null)}
                  className="text-[10px] text-gray-500 hover:text-white shrink-0"
                >✕ Clear</button>
              )}
            </div>
            <p className="text-[10px] text-gray-600 mt-1">Set a hypothetical score to see the impact on your handicap index</p>
          </div>
        </div>
        {result ? (
          <div className="flex flex-col gap-3">
            <div className="rounded-xl bg-[#C9A84C]/10 border border-[#C9A84C]/20 p-4 text-center">
              <p className="text-[10px] text-gray-500 uppercase tracking-widest mb-1">Course Handicap</p>
              <p className="text-3xl font-extrabold text-[#C9A84C]">{result.courseHandicap}</p>
            </div>
            <div className="rounded-xl bg-green-500/10 border border-green-500/20 p-4 text-center">
              <p className="text-[10px] text-gray-500 uppercase tracking-widest mb-1">Playing Handicap</p>
              <p className="text-3xl font-extrabold text-green-400">{result.playingHandicap}</p>
            </div>
            <div className="rounded-xl bg-white/5 border border-white/10 p-3 flex justify-between items-center">
              <p className="text-xs text-muted-foreground">Net Par</p>
              <p className="font-bold text-white">{result.netPar} <span className="text-xs text-muted-foreground">({result.parDiff >= 0 ? "+" : ""}{result.parDiff})</span></p>
            </div>
            {result.projectedHandicapIndex !== null && grossScore !== null && (
              <>
                <div className="rounded-xl bg-white/5 border border-white/10 p-3 flex justify-between items-center">
                  <div>
                    <p className="text-xs text-muted-foreground">Score Differential</p>
                    <p className="text-[10px] text-gray-500">(113/Slope) × (Gross − CR)</p>
                  </div>
                  <p className="font-bold text-white">{result.differential?.toFixed(1) ?? '—'}</p>
                </div>
                <div className={`rounded-xl p-3 border flex justify-between items-center ${indexDelta != null && indexDelta < 0 ? 'bg-green-500/10 border-green-500/20' : 'bg-orange-500/10 border-orange-500/20'}`}>
                  <div>
                    <p className="text-xs text-muted-foreground">Projected New HCP Index</p>
                    <p className="text-[10px] text-gray-500">after this round (single-round WHS diff)</p>
                  </div>
                  <div className="text-right">
                    <p className={`font-bold text-lg ${indexDelta != null && indexDelta < 0 ? 'text-green-400' : 'text-orange-400'}`}>{result.projectedHandicapIndex.toFixed(1)}</p>
                    {indexDelta != null && <p className={`text-xs font-semibold ${indexDelta < 0 ? 'text-green-400' : 'text-orange-400'}`}>{indexDelta > 0 ? `+${indexDelta.toFixed(1)}` : indexDelta.toFixed(1)}</p>}
                  </div>
                </div>
              </>
            )}
            {result.projectedHandicapIndex !== null && grossScore === null && (
              <div className="rounded-xl bg-blue-500/10 border border-blue-500/20 p-3 flex justify-between items-center">
                <p className="text-xs text-muted-foreground">Projected HCP (at par)</p>
                <p className="font-bold text-blue-400">{result.projectedHandicapIndex.toFixed(1)}</p>
              </div>
            )}
            <p className="text-[10px] text-gray-600 leading-relaxed">
              CH = HI × (Slope/113) + (CR−Par). Projected uses WHS single-round differential formula.
            </p>
          </div>
        ) : (
          <div className="flex items-center justify-center h-full text-muted-foreground text-xs">Loading…</div>
        )}
      </div>
    </Card>
  );
}
