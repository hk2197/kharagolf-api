/**
 * Regression coverage for the player portal Loyalty tab (Task #1284).
 *
 * The Loyalty tab is rendered inline inside `src/pages/portal/index.tsx`
 * (the planned per-tab extraction has not landed yet — see Task #956),
 * so we mount the whole portal page with stubbed fetch and drive it
 * through the inline `data-testid` hooks added alongside this test:
 *
 *   - empty state         → the Loyalty tab trigger is suppressed when
 *                           the org's loyalty endpoint returns no
 *                           account; `portal-loyalty-balance` and any
 *                           `portal-loyalty-reward-<id>` rows are
 *                           absent from the DOM
 *   - populated state     → `portal-loyalty-balance` shows the points
 *                           balance, current tier label and
 *                           progress-to-next-tier copy
 *   - one assertion flow  → affordable rewards render the row plainly
 *                           while unaffordable ones surface the
 *                           "Need X more pts" hint, exercising the
 *                           per-row affordability branch
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('wouter', () => ({
  useLocation: () => ['/portal', vi.fn()],
  Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) =>
    <a href={href} {...rest}>{children}</a>,
}));

vi.mock('@/components/PriceWithFx', () => ({
  PriceWithFx: ({ amount, currency }: { amount: string; currency: string }) =>
    <span data-testid="price-with-fx">{amount} {currency}</span>,
}));

vi.mock('@/components/CurrencyPicker', () => ({
  CurrencyPicker: () => <div data-testid="currency-picker" />,
}));

vi.mock('@/components/MyUpcomingWidget', () => ({
  MyUpcomingWidget: () => <div data-testid="my-upcoming" />,
}));

vi.mock('@/components/kharagolf-brand', () => ({
  KharaGolfBrand: () => <div />,
  KharaGolfWordmark: () => <div />,
}));

vi.mock('./PortalCommPrefs', () => ({
  PortalCommPrefs: () => <div data-testid="comm-prefs" />,
}));

vi.mock('./LockerRenewalCard', () => ({
  LockerRenewalCard: () => <div data-testid="locker-renewal" />,
}));

vi.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock('@/lib/markdown', () => ({
  markdownToHtml: (s: string) => s,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key,
    i18n: { language: 'en', changeLanguage: () => {} },
  }),
}));

vi.mock('@/i18n', () => ({
  default: { language: 'en', changeLanguage: () => {} },
  SUPPORTED_LANGUAGES: ['en'] as const,
  applyLanguageDirection: () => {},
}));

import PortalPage from '../index';

const ME = {
  id: 7, email: 'p@example.com', displayName: 'Player', username: 'player',
  role: 'player', organizationId: 42, emailVerified: true, isLocalAuth: true,
  preferredLanguage: 'en',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  }) as unknown as Response;
}

function loyaltyAccount() {
  return {
    account: {
      pointsBalance: 1500,
      lifetimePoints: 3200,
      rollingYearPoints: 900,
      currentTier: 'gold',
    },
    programme: { pointsName: 'Birdies', isEnabled: true },
    currentTierDef: { label: 'Gold', perks: ['10% pro shop discount'], multiplier: '1.5' },
    nextTier: { tier: 'platinum', label: 'Platinum', minPoints: 5000 },
    pointsToNextTier: 1800,
  };
}

function loyaltyRewards() {
  return [
    { id: 701, name: 'Free range bucket', description: 'One large bucket', pointsCost: 500, rewardType: 'voucher', minTier: 'silver' },
    { id: 702, name: 'VIP locker upgrade', description: 'Premium locker for 1 year', pointsCost: 4000, rewardType: 'service', minTier: 'gold' },
  ];
}

function installFetch(opts: { withLoyalty: boolean }) {
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();

    if (url.endsWith('/api/portal/me')) return jsonResponse(ME);
    if (url.endsWith('/api/portal/my-stats'))
      return jsonResponse({ tournamentsPlayed: 0, totalScores: 0, averageStrokes: null, bestRound: null });
    if (url.endsWith('/api/portal/my-tournaments')) return jsonResponse([]);
    if (url.endsWith('/api/portal/my-leagues')) return jsonResponse([]);
    if (url.endsWith('/api/portal/membership')) return jsonResponse(null);
    if (url.endsWith('/api/portal/notification-preferences')) return jsonResponse(null);
    if (url.endsWith('/api/portal/ghin')) return jsonResponse(null);
    if (url.endsWith('/api/portal/locker')) return jsonResponse(null);
    if (url.endsWith('/api/portal/rankings/history')) return jsonResponse([]);
    if (url.endsWith('/api/portal/membership/tiers')) return jsonResponse([]);
    if (url.endsWith('/api/portal/my-statement'))
      return jsonResponse({ levyCharges: [], outstandingBalance: '0.00' });

    if (url.includes('/loyalty/me'))
      return jsonResponse(opts.withLoyalty ? loyaltyAccount() : null);
    if (url.includes('/loyalty/rewards'))
      return jsonResponse(opts.withLoyalty ? loyaltyRewards() : []);
    if (url.includes('/shop/my-orders')) return jsonResponse([]);
    if (url.includes('/shop/wishlist')) return jsonResponse([]);
    if (url.includes('/dues-billing/my-invoices')) return jsonResponse([]);
    if (url.includes('/marketplace/my-bookings')) return jsonResponse([]);
    if (url.includes('/rules-config')) return jsonResponse(null);

    return new Response('', { status: 404 }) as unknown as Response;
  }) as typeof fetch;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Portal Loyalty tab', () => {
  it('hides the Loyalty tab when the loyalty endpoint returns no account (empty state)', async () => {
    installFetch({ withLoyalty: false });
    render(<PortalPage />);

    // Wait for the initial dashboard render to settle.
    expect(await screen.findByTestId('portal-tournaments-empty')).toBeInTheDocument();

    expect(screen.queryByRole('tab', { name: /portal:tabs.loyalty/i })).not.toBeInTheDocument();
    expect(screen.queryByTestId('portal-loyalty-balance')).not.toBeInTheDocument();
    expect(screen.queryByTestId(/portal-loyalty-reward-/)).not.toBeInTheDocument();
  });

  it('renders the balance card with points, tier label and progress copy (populated state)', async () => {
    installFetch({ withLoyalty: true });
    render(<PortalPage />);

    const loyaltyTab = await screen.findByRole('tab', { name: /portal:tabs.loyalty/i });
    await userEvent.click(loyaltyTab);

    const balance = await screen.findByTestId('portal-loyalty-balance');
    expect(within(balance).getByText('1,500')).toBeInTheDocument();
    expect(within(balance).getByText(/Gold/)).toBeInTheDocument();
    expect(within(balance).getByText(/Progress to Platinum/)).toBeInTheDocument();
    expect(within(balance).getByText('1,800 pts needed')).toBeInTheDocument();
  });

  it('marks unaffordable rewards with the "Need X more pts" hint while keeping affordable ones plain', async () => {
    installFetch({ withLoyalty: true });
    render(<PortalPage />);

    const loyaltyTab = await screen.findByRole('tab', { name: /portal:tabs.loyalty/i });
    await userEvent.click(loyaltyTab);

    const affordable = await screen.findByTestId('portal-loyalty-reward-701');
    expect(within(affordable).getByText('Free range bucket')).toBeInTheDocument();
    expect(within(affordable).queryByText(/Need.*more pts/)).not.toBeInTheDocument();

    const unaffordable = screen.getByTestId('portal-loyalty-reward-702');
    expect(within(unaffordable).getByText('VIP locker upgrade')).toBeInTheDocument();
    // 4000 cost - 1500 balance = 2500 missing
    expect(within(unaffordable).getByText('Need 2,500 more pts')).toBeInTheDocument();
  });
});
