import { Switch, Route, Router as WouterRouter, useLocation } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useGetMe } from "@workspace/api-client-react";
import { Loader2 } from "lucide-react";
import { useEffect } from "react";
import { KharaGolfBrand } from "@/components/kharagolf-brand";
import { ActiveOrgProvider } from "@/context/ActiveOrgContext";
import { OrgThemeProvider } from "@/lib/theme/OrgThemeProvider";

import NotFound from "@/pages/not-found";
import { AppLayout } from "@/components/layout";
import Dashboard from "@/pages/dashboard";
import Tournaments from "@/pages/tournaments";
import TournamentDetail from "@/pages/tournament-detail";
import Courses from "@/pages/courses";
import Leagues from "@/pages/leagues";
import PlayersPage from "@/pages/players";
import Register from "@/pages/register";
import PublicLeaderboard from "@/pages/public-leaderboard";
import LeaderboardDisplay from "@/pages/leaderboard-display";
import LeaderboardKiosk from "@/pages/leaderboard-kiosk";
import PlayerPortal from "@/pages/portal/index";
import ResetPasswordPage from "@/pages/portal/reset-password";
import PortalScoresPage from "@/pages/portal/scores";
import PortalPrivacyPage from "@/pages/portal/privacy";
import PortalEmailPreferencesPage from "@/pages/portal/email-preferences";
import PortalSecurityPage from "@/pages/portal/security";
import ClubThemingPage from "@/pages/club-theming";
import MarkerSignPage from "@/pages/portal/marker-sign";
import MarkerLivePage from "@/pages/portal/marker-live";
import WatchActiveContextPage from "@/pages/portal/watch-active-context";
import PortalHighlightsPage from "@/pages/portal/highlights";
import PortalCourseCorrectionsPage from "@/pages/portal/course-corrections";
import PortalSurveyPage from "@/pages/portal/survey";
import PortalNotificationAuditPage from "@/pages/portal/notification-audit";
import PrintScorecards from "@/pages/print-scorecards";
import PocketScorecards from "@/pages/pocket-scorecards";
import TournamentResults from "@/pages/tournament-results";
import PublicScorecardPage from "@/pages/public-scorecard";
import MessagesPage from "@/pages/messages";
import PaymentsDashboard from "@/pages/payments";
import StatsPage from "@/pages/stats";
import YearInGolfPage from "@/pages/year-in-golf";
import LeagueJoin from "@/pages/league-join";
import SettingsPage from "@/pages/admin";
import ClubMembersPage from "@/pages/club-members";
import Member360Page from "@/pages/member-360";
import DocumentsPendingPage from "@/pages/documents-pending";
import FinanceLedgerPage from "@/pages/finance-ledger";
import WalletTopupRefundsPage from "@/pages/wallet-topup-refunds";
import ShopPage from "@/pages/shop";
import LoginPage from "@/pages/login";
import AdminSetupPage from "@/pages/admin-setup";
import ScorerLoginPage from "@/pages/scorer-login";
import ScorerSessionPage from "@/pages/scorer-session";
import SpectatorPage from "@/pages/spectator";
import HandicapSimulator from "@/pages/handicap-simulator";
import HandicapCommitteePage from "@/pages/handicap-committee";
import MarketplacePage from "@/pages/marketplace";
import PublicBookPage from "@/pages/public-book";
import ClubOnboardingPage from "@/pages/club-onboarding";
import SuperAdminPage from "@/pages/super-admin";
import SuperAdminLaddersPage from "@/pages/super-admin-ladders";
import ManualEntryAlertsPage from "@/pages/manual-entry-alerts";
import OrgManualEntryAlertsPage from "@/pages/org-manual-entry-alerts";
import SuperAdminShareRollupsPage from "@/pages/super-admin-share-rollups";
import LadderPublicPage from "@/pages/ladder-public";
import { ClubsDirectoryPage, ClubPublicPage } from "@/pages/clubs-directory";
import HandicapProfilePage from "@/pages/handicap-profile";
import MyFollowsPage from "@/pages/my-follows";
import NotificationsPage from "@/pages/notifications";
import NotificationAuditPage from "@/pages/notification-audit";
import AdminEventMutesPage from "@/pages/admin-event-mutes";
import NotifyExhaustionHistoryPage from "@/pages/notify-exhaustion-history";
import NotifyFailuresPage from "@/pages/notify-failures";
import WalletWithdrawalExhaustionAlertsPage from "@/pages/wallet-withdrawal-exhaustion-alerts";
import RecapBroadcastsPage from "@/pages/recap-broadcasts";
import WalletAlertsPage from "@/pages/wallet-alerts";
import AdminRecapShareStatsPage from "@/pages/admin-recap-share-stats";
import AdminNotificationConversionsPage from "@/pages/admin-notification-conversions";
import AdminEmailCtaStatsPage from "@/pages/admin-email-cta-stats";
import TeeTimeBookingPage from "@/pages/tee-time-booking";
import TeeSheetSettingsPage from "@/pages/tee-sheet-settings";
import DynamicPricingPage from "@/pages/dynamic-pricing";
import GeneralPlayPage from "@/pages/general-play";
import GeneralPlayRoundPage from "@/pages/general-play-round";
import AnnualHandicapReviewPage from "@/pages/annual-handicap-review";
import PeerReviewPage from "@/pages/peer-review";
import CartFleetPage from "@/pages/cart-fleet";
import NoticeBoardPage from "@/pages/notice-board";
import POSTerminalPage from "@/pages/pos";
import BracketPage from "@/pages/bracket";
import RyderCupPage from "@/pages/ryder-cup";
import FantasyPage from "@/pages/fantasy";
import LessonsPage from "@/pages/lessons";
import ProDashboardPage from "@/pages/pro-dashboard";
import LessonsAdminPage from "@/pages/lessons-admin";
import CoachMarketplacePage from "@/pages/coach-marketplace";
import CoachWorkspacePage from "@/pages/coach-workspace";
import CoachAdminPage from "@/pages/coach-admin";
import LockersPage from "@/pages/lockers";
import FbAdminPage from "@/pages/fb-admin";
import FbFulfillmentPage from "@/pages/fb-fulfillment";
import FbPosPage from "@/pages/fb-pos";
import SponsorsPage from "@/pages/sponsors";
import SponsorCampaignsPage from "@/pages/sponsor-campaigns";
import SponsorPortalPage from "@/pages/sponsor-portal";
import GovernancePage from "@/pages/governance";
import FeedPage from "@/pages/feed";
import TripsPage from "@/pages/trips";
import TvDisplay from "@/pages/tv-display";
import DisplaySettingsPage from "@/pages/display-settings";
import PaceOfPlayPage from "@/pages/pace-of-play";
import RankingsPage from "@/pages/rankings";
import ClubRepairPage from "@/pages/club-repair";
import ProcurementPage from "@/pages/procurement";
import RentalsPage from "@/pages/rentals";
import RentalDetailPage from "@/pages/rental-detail";
import FbOrderDetailPage from "@/pages/fb-order-detail";
import ConsignmentPage from "@/pages/consignment";
import GiftCardsPage from "@/pages/gift-cards";
import LoyaltyPage from "@/pages/loyalty";
import PromotionsPage from "@/pages/promotions";
import CommissionsPage from "@/pages/commissions";
import CaddiesPage from "@/pages/caddies";
import CourseMaintenancePage from "@/pages/course-maintenance";
import EventsPage from "@/pages/events";
import SchedulingPage from "@/pages/scheduling";
import WaitlistPage from "@/pages/waitlist";
import MembershipApplyPage from "@/pages/membership-apply";
import PublicRegFormPage from "@/pages/public-reg-form";
import SurveyRespondPage from "@/pages/survey-respond";
import GuestPassesPage from "@/pages/guest-passes";
import VisitorPassPage from "@/pages/visitor-pass";
import GuestCheckinPage from "@/pages/guest-checkin";
import DuesBillingPage from "@/pages/dues-billing";
import AccountingPage from "@/pages/accounting";
import RangeBookingsPage from "@/pages/range-bookings";
import AnalyticsPage from "@/pages/analytics";
import AdminAnalyticsPage from "@/pages/admin-analytics";
// Task #2044 — admin dashboard for tip-driven vs manual practice cohorts.
import PracticeCohortsPage from "@/pages/practice-cohorts";
import SurveysPage from "@/pages/surveys";
import WebhooksPage from "@/pages/webhooks";
import ClubChampionshipPage from "@/pages/club-championship";
import InterclubPage from "@/pages/interclub";
import HonoursBoardPage from "@/pages/honours-board";
import JuniorGolfPage from "@/pages/junior-golf";
import EventStaffingPage from "@/pages/event-staffing";
import MarketingPage from "@/pages/marketing";
import VendorOperatorsPage from "@/pages/vendor-operators";
import ShopReturnsPage from "@/pages/shop-returns";
import GstInvoicesPage from "@/pages/gst-invoices";
import CurrencyTaxSettingsPage from "@/pages/currency-tax-settings";
import CommerceAnalyticsPage from "@/pages/commerce-analytics";
import InventoryPage from "@/pages/inventory";
import ClubSettingsPage from "@/pages/club-settings";
import ClubMarketingSitePage from "@/pages/club-marketing-site";
import CourseModerationPage from "@/pages/course-moderation";
import MediaAdminPage from "@/pages/media-admin";
import ReportsPage from "@/pages/reports";
import OverlayPage from "@/pages/overlay";
import OverlayControlPage from "@/pages/overlay-control";
import PublicBracketPage from "@/pages/public-bracket";
import PublicRyderCupPage from "@/pages/public-ryder-cup";
import HighlightEngagementPage from "@/pages/highlight-engagement";
import AiCaddiePage from "@/pages/ai-caddie";
import CourseMapperPage from "@/pages/course-mapper";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

function getRoleRedirect(role: string | undefined, returnTo: string): string {
  if (returnTo && returnTo !== "/" && returnTo.startsWith("/")) {
    return returnTo;
  }
  switch (role) {
    case "org_admin":
    case "super_admin":
    case "tournament_director":
      return "/";
    case "committee_member":
      return "/";
    case "player":
    case "spectator":
      return "/portal";
    default:
      return "/";
  }
}

/**
 * Wrap public/player-portal routes so each page renders under the
 * active org's saved branding (logo, primary/accent colours, fonts,
 * favicon). When the player isn't logged in yet, `useGetMe()` returns
 * undefined and the providers no-op back to KHARAGOLF defaults.
 *
 * Task #1438 — without this, `/portal*` routes were registered in
 * the public block and never received CSS variable overrides or the
 * `useOrgBranding()` context.
 */
function PortalProviders({ children }: { children: React.ReactNode }) {
  return (
    <ActiveOrgProvider>
      <OrgThemeProvider>{children}</OrgThemeProvider>
    </ActiveOrgProvider>
  );
}

function AuthGuard({ children }: { children: React.ReactNode }) {
  const { data: user, isLoading, error } = useGetMe({ query: { retry: false } });

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center">
        <div className="relative">
          <div className="w-16 h-16 border-4 border-primary/20 rounded-full"></div>
          <div className="w-16 h-16 border-4 border-primary border-t-transparent rounded-full animate-spin absolute inset-0 shadow-[0_0_30px_rgba(34,197,94,0.5)]"></div>
        </div>
        <KharaGolfBrand size="md" className="mt-6" />
      </div>
    );
  }

  if (error || !user) {
    const returnTo = encodeURIComponent(window.location.pathname + window.location.search);
    window.location.href = '/login?returnTo=' + returnTo;
    return null;
  }

  if (user.role === 'player' || user.role === 'spectator') {
    window.location.href = '/portal';
    return null;
  }

  return <>{children}</>;
}

function RoleAwareRedirect() {
  const { data: user, isLoading } = useGetMe({ query: { retry: false } });
  const [, navigate] = useLocation();

  useEffect(() => {
    if (!isLoading && user) {
      const params = new URLSearchParams(window.location.search);
      const returnTo = params.get("returnTo") || "/";
      const dest = getRoleRedirect(user.role, returnTo);
      if (dest !== window.location.pathname) {
        window.location.href = dest;
      }
    }
  }, [user, isLoading]);

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center">
        <div className="relative">
          <div className="w-16 h-16 border-4 border-primary/20 rounded-full"></div>
          <div className="w-16 h-16 border-4 border-primary border-t-transparent rounded-full animate-spin absolute inset-0 shadow-[0_0_30px_rgba(34,197,94,0.5)]"></div>
        </div>
        <KharaGolfBrand size="md" className="mt-6" />
      </div>
    );
  }

  return null;
}

function Router() {
  return (
    <Switch>
      <Route path="/">
        <AppLayout><Dashboard /></AppLayout>
      </Route>
      <Route path="/tournaments">
        <AppLayout><Tournaments /></AppLayout>
      </Route>
      <Route path="/tournaments/:id">
        <AppLayout><TournamentDetail /></AppLayout>
      </Route>
      <Route path="/courses">
        <AppLayout><Courses /></AppLayout>
      </Route>
      <Route path="/courses/:id/mapper">
        <AppLayout><CourseMapperPage /></AppLayout>
      </Route>
      <Route path="/leagues">
        <AppLayout><Leagues /></AppLayout>
      </Route>
      <Route path="/players">
        <AppLayout><PlayersPage /></AppLayout>
      </Route>
      <Route path="/messages">
        <AppLayout><MessagesPage /></AppLayout>
      </Route>
      <Route path="/payments">
        <AppLayout><PaymentsDashboard /></AppLayout>
      </Route>
      <Route path="/stats">
        <AppLayout><StatsPage /></AppLayout>
      </Route>
      <Route path="/year-in-golf">
        <AppLayout><YearInGolfPage /></AppLayout>
      </Route>
      <Route path="/admin">
        <AppLayout><SettingsPage /></AppLayout>
      </Route>
      <Route path="/admin/notification-audit">
        <AppLayout><NotificationAuditPage /></AppLayout>
      </Route>
      <Route path="/admin/event-mutes">
        <AppLayout><AdminEventMutesPage /></AppLayout>
      </Route>
      <Route path="/admin/notify-exhaustion-history">
        <AppLayout><NotifyExhaustionHistoryPage /></AppLayout>
      </Route>
      <Route path="/admin/notify-failures">
        <AppLayout><NotifyFailuresPage /></AppLayout>
      </Route>
      <Route path="/admin/wallet-withdrawal-exhaustion-alerts">
        <AppLayout><WalletWithdrawalExhaustionAlertsPage /></AppLayout>
      </Route>
      <Route path="/admin/recap-broadcasts">
        <AppLayout><RecapBroadcastsPage /></AppLayout>
      </Route>
      <Route path="/admin/wallet-alerts">
        <AppLayout><WalletAlertsPage /></AppLayout>
      </Route>
      <Route path="/admin/recap-share-stats">
        <AppLayout><AdminRecapShareStatsPage /></AppLayout>
      </Route>
      {/* Task #2020 — per-key clicks → conversions admin view. */}
      <Route path="/admin/notification-conversions">
        <AppLayout><AdminNotificationConversionsPage /></AppLayout>
      </Route>
      <Route path="/admin/email-cta-stats">
        <AppLayout><AdminEmailCtaStatsPage /></AppLayout>
      </Route>
      {/* Task #2068 — per-org rollup of skipped/failed manual-entry alerts. */}
      <Route path="/admin/manual-entry-alerts">
        <AppLayout><OrgManualEntryAlertsPage /></AppLayout>
      </Route>
      <Route path="/club-members">
        <AppLayout><ClubMembersPage /></AppLayout>
      </Route>
      <Route path="/member-360/:id">
        <AppLayout><Member360Page /></AppLayout>
      </Route>
      <Route path="/documents-pending">
        <AppLayout><DocumentsPendingPage /></AppLayout>
      </Route>
      <Route path="/finance-ledger">
        <AppLayout><FinanceLedgerPage /></AppLayout>
      </Route>
      <Route path="/wallet-topup-refunds">
        <AppLayout><WalletTopupRefundsPage /></AppLayout>
      </Route>
      <Route path="/shop">
        <AppLayout><ShopPage /></AppLayout>
      </Route>
      <Route path="/handicap-simulator">
        <AppLayout><HandicapSimulator /></AppLayout>
      </Route>
      <Route path="/handicap-committee">
        <AppLayout><HandicapCommitteePage /></AppLayout>
      </Route>
      <Route path="/marketplace">
        <AppLayout><MarketplacePage /></AppLayout>
      </Route>
      <Route path="/super-admin">
        <AppLayout><SuperAdminPage /></AppLayout>
      </Route>
      <Route path="/super-admin/ladders">
        <AppLayout><SuperAdminLaddersPage /></AppLayout>
      </Route>
      <Route path="/super-admin/manual-entry-alerts">
        <AppLayout><ManualEntryAlertsPage /></AppLayout>
      </Route>
      <Route path="/super-admin/share-rollups">
        <AppLayout><SuperAdminShareRollupsPage /></AppLayout>
      </Route>
      {/* Legacy URL kept so existing bookmarks keep working — Task #1474
          replaced the badge-only page with a combined share-rollups page. */}
      <Route path="/super-admin/badge-share-rollup">
        <AppLayout><SuperAdminShareRollupsPage /></AppLayout>
      </Route>
      <Route path="/ladder/:slug">
        <LadderPublicPage />
      </Route>
      <Route path="/handicap-profile">
        <AppLayout><HandicapProfilePage /></AppLayout>
      </Route>
      <Route path="/notifications">
        <AppLayout><NotificationsPage /></AppLayout>
      </Route>
      <Route path="/tee-bookings">
        <AppLayout><TeeTimeBookingPage /></AppLayout>
      </Route>
      <Route path="/tee-sheet-settings">
        <AppLayout><TeeSheetSettingsPage /></AppLayout>
      </Route>
      <Route path="/dynamic-pricing">
        <AppLayout><DynamicPricingPage /></AppLayout>
      </Route>
      <Route path="/general-play">
        <AppLayout><GeneralPlayPage /></AppLayout>
      </Route>
      <Route path="/general-play/:id">
        <AppLayout><GeneralPlayRoundPage /></AppLayout>
      </Route>
      <Route path="/annual-handicap-review">
        <AppLayout><AnnualHandicapReviewPage /></AppLayout>
      </Route>
      <Route path="/cart-fleet">
        <AppLayout><CartFleetPage /></AppLayout>
      </Route>
      <Route path="/notice-board">
        <AppLayout><NoticeBoardPage /></AppLayout>
      </Route>
      <Route path="/pos">
        <AppLayout><POSTerminalPage /></AppLayout>
      </Route>
      <Route path="/tournaments/:id/bracket">
        <AppLayout><BracketPage /></AppLayout>
      </Route>
      <Route path="/tournaments/:id/ryder-cup">
        <AppLayout><RyderCupPage /></AppLayout>
      </Route>
      <Route path="/fantasy">
        <AppLayout><FantasyPage /></AppLayout>
      </Route>
      <Route path="/lessons">
        <AppLayout><LessonsPage /></AppLayout>
      </Route>
      <Route path="/pro-dashboard">
        <AppLayout><ProDashboardPage /></AppLayout>
      </Route>
      <Route path="/lessons-admin">
        <AppLayout><LessonsAdminPage /></AppLayout>
      </Route>
      <Route path="/coach-marketplace">
        <AppLayout><CoachMarketplacePage /></AppLayout>
      </Route>
      <Route path="/coach-workspace">
        <AppLayout><CoachWorkspacePage /></AppLayout>
      </Route>
      <Route path="/coach-admin">
        <AppLayout><CoachAdminPage /></AppLayout>
      </Route>
      {/* Task #2044 — Practice cohort analytics: tip-driven vs manual practice volumes,
          weekly trend, per-club, and per-player engagement breakdown. */}
      <Route path="/admin/practice-cohorts">
        <AppLayout><PracticeCohortsPage /></AppLayout>
      </Route>
      <Route path="/lockers">
        <AppLayout><LockersPage /></AppLayout>
      </Route>
      <Route path="/fb-admin">
        <AppLayout><FbAdminPage /></AppLayout>
      </Route>
      <Route path="/fb-fulfillment">
        <AppLayout><FbFulfillmentPage /></AppLayout>
      </Route>
      <Route path="/fb-pos">
        <AppLayout><FbPosPage /></AppLayout>
      </Route>
      <Route path="/sponsors">
        <AppLayout><SponsorsPage /></AppLayout>
      </Route>
      <Route path="/sponsor-campaigns">
        <AppLayout><SponsorCampaignsPage /></AppLayout>
      </Route>
      <Route path="/governance">
        <AppLayout><GovernancePage /></AppLayout>
      </Route>
      {/* Task #1770 — `/privacy?panel=erasure-storage-failures` is the
          canonical cross-surface deep link from the daily controller
          digest email, the in-app inbox row, and the home-screen
          stuck-erasure backlog widget. There is no standalone
          `/privacy` page; the controller-facing privacy controls live
          on the Governance page's Privacy tab, so we mount the same
          page here so those clicks land on the panel instead of the
          404. GovernancePage reads the `panel` query param and
          activates the Privacy tab + scrolls the
          erasure-storage-failures-card into view. */}
      <Route path="/privacy">
        <AppLayout><GovernancePage /></AppLayout>
      </Route>
      <Route path="/feed">
        <AppLayout><FeedPage /></AppLayout>
      </Route>
      <Route path="/trips">
        <AppLayout><TripsPage /></AppLayout>
      </Route>
      <Route path="/display-settings">
        <AppLayout><DisplaySettingsPage /></AppLayout>
      </Route>
      <Route path="/pace-of-play">
        <AppLayout><PaceOfPlayPage /></AppLayout>
      </Route>
      <Route path="/rankings-admin">
        <AppLayout><RankingsPage /></AppLayout>
      </Route>
      <Route path="/club-repair">
        <AppLayout><ClubRepairPage /></AppLayout>
      </Route>
      <Route path="/procurement">
        <AppLayout><ProcurementPage /></AppLayout>
      </Route>
      {/* Member-facing rental booking detail — must be matched before /rentals
          so wouter routes /rentals/bookings/:id here instead of falling
          through to the admin RentalsPage. Task #1728. */}
      <Route path="/rentals/bookings/:bookingId">
        <AppLayout><RentalDetailPage /></AppLayout>
      </Route>
      <Route path="/rentals">
        <AppLayout><RentalsPage /></AppLayout>
      </Route>
      {/* Member-facing F&B order detail page — Task #1728. */}
      <Route path="/fb-orders/:orderId">
        <AppLayout><FbOrderDetailPage /></AppLayout>
      </Route>
      <Route path="/consignment">
        <AppLayout><ConsignmentPage /></AppLayout>
      </Route>
      <Route path="/gift-cards">
        <AppLayout><GiftCardsPage /></AppLayout>
      </Route>
      <Route path="/loyalty">
        <AppLayout><LoyaltyPage /></AppLayout>
      </Route>
      <Route path="/promotions">
        <AppLayout><PromotionsPage /></AppLayout>
      </Route>
      <Route path="/commissions">
        <AppLayout><CommissionsPage /></AppLayout>
      </Route>
      <Route path="/caddies">
        <AppLayout><CaddiesPage /></AppLayout>
      </Route>
      <Route path="/course-maintenance">
        <AppLayout><CourseMaintenancePage /></AppLayout>
      </Route>
      <Route path="/events">
        <AppLayout><EventsPage /></AppLayout>
      </Route>
      <Route path="/scheduling">
        <AppLayout><SchedulingPage /></AppLayout>
      </Route>
      <Route path="/waitlist">
        <AppLayout><WaitlistPage /></AppLayout>
      </Route>
      <Route path="/guest-passes">
        <AppLayout><GuestPassesPage /></AppLayout>
      </Route>
      <Route path="/guest-checkin">
        <AppLayout><GuestCheckinPage /></AppLayout>
      </Route>
      <Route path="/dues-billing">
        <AppLayout><DuesBillingPage /></AppLayout>
      </Route>
      <Route path="/accounting">
        <AppLayout><AccountingPage /></AppLayout>
      </Route>
      <Route path="/range-bookings">
        <AppLayout><RangeBookingsPage /></AppLayout>
      </Route>
      <Route path="/analytics">
        <AppLayout><AnalyticsPage /></AppLayout>
      </Route>
      <Route path="/admin/analytics">
        <AppLayout><AdminAnalyticsPage /></AppLayout>
      </Route>
      <Route path="/surveys">
        <AppLayout><SurveysPage /></AppLayout>
      </Route>
      <Route path="/webhooks">
        <AppLayout><WebhooksPage /></AppLayout>
      </Route>
      <Route path="/marketing">
        <AppLayout><MarketingPage /></AppLayout>
      </Route>
      <Route path="/club-championship">
        <AppLayout><ClubChampionshipPage /></AppLayout>
      </Route>
      <Route path="/interclub">
        <AppLayout><InterclubPage /></AppLayout>
      </Route>
      <Route path="/junior-golf">
        <JuniorGolfPage />
      </Route>
      <Route path="/event-staffing">
        <AppLayout><EventStaffingPage /></AppLayout>
      </Route>
      <Route path="/inventory">
        <AppLayout><InventoryPage /></AppLayout>
      </Route>
      <Route path="/vendor-operators">
        <AppLayout><VendorOperatorsPage /></AppLayout>
      </Route>
      <Route path="/shop-returns">
        <AppLayout><ShopReturnsPage /></AppLayout>
      </Route>
      <Route path="/gst-invoices">
        <AppLayout><GstInvoicesPage /></AppLayout>
      </Route>
      <Route path="/currency-tax-settings">
        <AppLayout><CurrencyTaxSettingsPage /></AppLayout>
      </Route>
      <Route path="/commerce-analytics">
        <AppLayout><CommerceAnalyticsPage /></AppLayout>
      </Route>
      <Route path="/club-settings">
        <AppLayout><ClubSettingsPage /></AppLayout>
      </Route>
      <Route path="/club-theming">
        <AppLayout><ClubThemingPage /></AppLayout>
      </Route>
      <Route path="/club-marketing-site">
        <AppLayout><ClubMarketingSitePage /></AppLayout>
      </Route>
      <Route path="/course-moderation">
        <AppLayout><CourseModerationPage /></AppLayout>
      </Route>
      <Route path="/media-admin">
        <AppLayout><MediaAdminPage /></AppLayout>
      </Route>
      <Route path="/reports">
        <AppLayout><ReportsPage /></AppLayout>
      </Route>
      <Route path="/overlay-control">
        <AppLayout><OverlayControlPage /></AppLayout>
      </Route>
      <Route path="/highlight-engagement">
        <AppLayout><HighlightEngagementPage /></AppLayout>
      </Route>
      <Route path="/ai-caddie">
        <AppLayout><AiCaddiePage /></AppLayout>
      </Route>
      <Route>
        <AppLayout><NotFound /></AppLayout>
      </Route>
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <a
            href="#main-content"
            className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[100] focus:px-4 focus:py-2 focus:rounded-lg focus:bg-primary focus:text-primary-foreground focus:shadow-lg focus:outline-none focus:ring-2 focus:ring-ring"
          >
            Skip to main content
          </a>
          <Switch>
            {/* Admin local login + first-time setup — no auth required */}
            <Route path="/login">
              <LoginPage />
            </Route>
            <Route path="/admin-setup">
              <AdminSetupPage />
            </Route>
            {/* Scorer PIN login — no auth required */}
            <Route path="/scorer">
              <ScorerLoginPage />
            </Route>
            {/* Scorer session — stripped scoring interface */}
            <Route path="/scorer/tournament/:tournamentId">
              <ScorerSessionPage />
            </Route>
            {/* Role-aware post-login redirect */}
            <Route path="/redirect">
              <RoleAwareRedirect />
            </Route>
            {/* Fully public routes — no auth, no layout */}
            <Route path="/my-follows">
              <MyFollowsPage />
            </Route>
            {/*
              Player-portal routes — wrapped so each page renders
              under the active org's saved theme (Task #1438).
              `PortalProviders` handles unauthenticated callers
              (e.g. /portal login) by no-opping to defaults.
            */}
            <Route path="/portal/reset-password">
              <PortalProviders><ResetPasswordPage /></PortalProviders>
            </Route>
            <Route path="/portal/scores/:tournamentId">
              <PortalProviders><PortalScoresPage /></PortalProviders>
            </Route>
            <Route path="/portal/privacy">
              <PortalProviders><PortalPrivacyPage /></PortalProviders>
            </Route>
            <Route path="/portal/email-preferences">
              <PortalProviders><PortalEmailPreferencesPage /></PortalProviders>
            </Route>
            <Route path="/portal/security">
              <PortalProviders><PortalSecurityPage /></PortalProviders>
            </Route>
            <Route path="/portal/marker-sign">
              <PortalProviders><MarkerSignPage /></PortalProviders>
            </Route>
            <Route path="/portal/marker-live/:token">
              <PortalProviders><MarkerLivePage /></PortalProviders>
            </Route>
            <Route path="/portal/watch/active-context">
              <PortalProviders><WatchActiveContextPage /></PortalProviders>
            </Route>
            <Route path="/portal/highlights">
              <PortalProviders><PortalHighlightsPage /></PortalProviders>
            </Route>
            <Route path="/portal/course-corrections">
              <PortalProviders><PortalCourseCorrectionsPage /></PortalProviders>
            </Route>
            <Route path="/portal/surveys/:surveyId">
              <PortalProviders><PortalSurveyPage /></PortalProviders>
            </Route>
            {/* Task #1775 — surfaces `event_opted_out` audit rows so a
                controller who muted both channels for an alert (e.g.
                stuck-erasure controller digest) can still see what was
                suppressed and re-enable in one click. */}
            <Route path="/portal/notification-audit">
              <PortalProviders><PortalNotificationAuditPage /></PortalProviders>
            </Route>
            <Route path="/portal">
              <PortalProviders><PlayerPortal /></PortalProviders>
            </Route>
            <Route path="/register/:orgId/:tournamentId">
              <Register />
            </Route>
            <Route path="/leagues/join">
              <LeagueJoin />
            </Route>
            <Route path="/leaderboard/:tournamentId/display">
              <LeaderboardDisplay />
            </Route>
            <Route path="/leaderboard/:tournamentId/kiosk">
              <LeaderboardKiosk />
            </Route>
            {/* Standalone TV display board — no auth, pairing code required */}
            <Route path="/display">
              <TvDisplay />
            </Route>
            {/* Broadcast overlays — public, transparent, OBS/vMix browser sources */}
            <Route path="/overlay/:tournamentId">
              <OverlayPage />
            </Route>
            <Route path="/orgs/:orgId/tournaments/:tournamentId/print-scorecards">
              <PrintScorecards />
            </Route>
            <Route path="/orgs/:orgId/tournaments/:tournamentId/pocket-scorecards">
              <PocketScorecards />
            </Route>
            <Route path="/leaderboard/:tournamentId">
              <PublicLeaderboard />
            </Route>
            <Route path="/results/:tournamentId">
              <TournamentResults />
            </Route>
            <Route path="/scorecard/:shareToken">
              <PublicScorecardPage />
            </Route>
            <Route path="/spectator/:tournamentId">
              <SpectatorPage />
            </Route>
            <Route path="/bracket/:shareToken">
              <PublicBracketPage />
            </Route>
            <Route path="/ryder-cup/:shareToken">
              <PublicRyderCupPage />
            </Route>
            {/* Public shop — accessible without login via org-scoped URL */}
            <Route path="/orgs/:orgId/shop">
              <div className="min-h-screen bg-background">
                <ShopPage />
              </div>
            </Route>
            {/* Public tee time booking page — accessible without login */}
            <Route path="/:orgSlug/book">
              <PublicBookPage />
            </Route>
            {/* Public visitor pass purchase — no auth required */}
            <Route path="/visitor-pass">
              <VisitorPassPage />
            </Route>
            {/* Sponsor portal — public, JWT-authenticated separately */}
            <Route path="/sponsor-portal">
              <SponsorPortalPage />
            </Route>
            {/* Public honours board — no auth required */}
            <Route path="/orgs/:orgId/honours-board">
              <HonoursBoardPage />
            </Route>
            {/* Club registration / onboarding wizard */}
            <Route path="/register-club">
              <ClubOnboardingPage />
            </Route>
            {/* Public membership application form */}
            <Route path="/:orgSlug/apply">
              <MembershipApplyPage />
            </Route>
            {/* Public event registration custom form — no auth required */}
            <Route path="/public/register/:eventType/:eventId">
              <PublicRegFormPage />
            </Route>
            {/* Post-event survey response — token-gated, no auth required */}
            <Route path="/survey/:token">
              <SurveyRespondPage />
            </Route>
            {/* Handicap committee peer review — token-gated, no auth required */}
            <Route path="/peer-review/:token">
              <PeerReviewPage />
            </Route>
            {/* Public clubs directory */}
            <Route path="/clubs/:slug">
              <ClubPublicPage />
            </Route>
            <Route path="/clubs">
              <ClubsDirectoryPage />
            </Route>
            {/* Public rankings — accessible without login */}
            <Route path="/rankings">
              <RankingsPage />
            </Route>
            {/* All other routes require auth */}
            <Route>
              <AuthGuard>
                <ActiveOrgProvider>
                  <OrgThemeProvider>
                    <Router />
                  </OrgThemeProvider>
                </ActiveOrgProvider>
              </AuthGuard>
            </Route>
          </Switch>
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
