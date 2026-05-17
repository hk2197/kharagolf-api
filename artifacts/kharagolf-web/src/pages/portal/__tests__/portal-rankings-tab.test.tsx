/**
 * Regression coverage for the player portal Rankings tab (Task #1284).
 *
 * The Rankings tab is rendered inline inside `src/pages/portal/index.tsx`
 * (the planned per-tab extraction has not landed yet — see Task #956),
 * so we mount the whole portal page with stubbed fetch and drive it
 * through the inline `data-testid` hooks added alongside this test:
 *
 *   - empty state         → the Rankings tab trigger is suppressed when
 *                           the player has no ranking entries; no
 *                           `portal-ranking-entry-<seriesId>` rows
 *                           appear in the DOM
 *   - populated state     → one `portal-ranking-entry-<seriesId>` per
 *                           series with its name, points and position
 *   - one assertion flow  → switching to the Rankings tab surfaces the
 *                           series' event-history rows (their names and
 *                           points awarded), exercising the conditional
 *                           render
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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

function rankingHistory() {
  return [
    {
      id: 11,
      seriesId: 311,
      seriesName: 'National Order of Merit',
      seriesLevel: 'national',
      seriesStatus: 'active',
      seasonStart: '2026-01-01',
      seasonEnd: '2026-12-31',
      category: 'mens',
      totalPoints: 420,
      eventsPlayed: 6,
      wins: 1,
      runnerUps: 2,
      top3: 4,
      position: 3,
      history: [
        {
          id: 9001,
          tournamentId: 81,
          tournamentName: 'Coastal Classic',
          tournamentDate: '2026-03-15',
          position: 2,
          pointsAwarded: 80,
          awardedAt: '2026-03-15T18:00:00Z',
        },
        {
          id: 9002,
          tournamentId: 82,
          tournamentName: 'Hill Invitational',
          tournamentDate: '2026-04-02',
          position: 1,
          pointsAwarded: 100,
          awardedAt: '2026-04-02T18:00:00Z',
        },
      ],
    },
  ];
}

function installFetch(opts: { withRankings: boolean }) {
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
    if (url.endsWith('/api/portal/rankings/history'))
      return jsonResponse(opts.withRankings ? rankingHistory() : []);
    if (url.endsWith('/api/portal/membership/tiers')) return jsonResponse([]);
    if (url.endsWith('/api/portal/my-statement'))
      return jsonResponse({ levyCharges: [], outstandingBalance: '0.00' });

    if (url.includes('/loyalty/me')) return jsonResponse(null);
    if (url.includes('/loyalty/rewards')) return jsonResponse([]);
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

describe('Portal Rankings tab', () => {
  it('hides the Rankings tab when the player has no ranking entries (empty state)', async () => {
    installFetch({ withRankings: false });
    render(<PortalPage />);

    // Wait for the initial load to settle by looking at the always-present
    // tournaments empty state.
    expect(await screen.findByTestId('portal-tournaments-empty')).toBeInTheDocument();

    expect(screen.queryByRole('tab', { name: /portal:tabs.rankings/i })).not.toBeInTheDocument();
    expect(screen.queryByTestId(/portal-ranking-entry-/)).not.toBeInTheDocument();
  });

  it('renders one entry per series with name, points, and position (populated state)', async () => {
    installFetch({ withRankings: true });
    render(<PortalPage />);

    const rankingsTab = await screen.findByRole('tab', { name: /portal:tabs.rankings/i });
    await userEvent.click(rankingsTab);

    const entry = await screen.findByTestId('portal-ranking-entry-311');
    expect(within(entry).getByText('National Order of Merit')).toBeInTheDocument();
    expect(within(entry).getByText('420 pts')).toBeInTheDocument();
    expect(within(entry).getByText(/Position/)).toBeInTheDocument();
  });

  it('shows the per-tournament event history once the tab is opened', async () => {
    installFetch({ withRankings: true });
    render(<PortalPage />);

    const rankingsTab = await screen.findByRole('tab', { name: /portal:tabs.rankings/i });
    await userEvent.click(rankingsTab);

    const entry = await screen.findByTestId('portal-ranking-entry-311');
    expect(within(entry).getByText('portal:eventHistory')).toBeInTheDocument();
    expect(within(entry).getByText('Coastal Classic')).toBeInTheDocument();
    expect(within(entry).getByText('+80 pts')).toBeInTheDocument();
    expect(within(entry).getByText('Hill Invitational')).toBeInTheDocument();
    expect(within(entry).getByText('+100 pts')).toBeInTheDocument();
  });
});
