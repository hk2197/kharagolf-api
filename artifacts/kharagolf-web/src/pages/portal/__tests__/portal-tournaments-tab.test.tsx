/**
 * Regression coverage for the player portal Tournaments tab (Task #1284).
 *
 * The Tournaments tab is currently rendered inline inside
 * `src/pages/portal/index.tsx` (the planned per-tab extraction has not
 * landed yet — see Task #956), so we mount the whole portal page with
 * stubbed fetch and drive it through the inline `data-testid` hooks
 * added alongside this test:
 *
 *   - empty state         → `portal-tournaments-empty`
 *   - populated state     → one `portal-tournament-row-<id>` per row
 *                           with the expected name and badges
 *   - interactive flow    → clicking `button-withdraw-tournament-<id>`
 *                           opens the confirm dialog; clicking
 *                           `button-confirm-withdraw` DELETEs
 *                           `/portal/tournaments/<id>/withdraw` and
 *                           swaps the row badges to the withdrawn state
 *
 * Backend behaviour for `/portal/tournaments/<id>/withdraw` is covered
 * separately by api-server tests.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, cleanup, within } from '@testing-library/react';
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

interface WithdrawCall { tournamentId: number }

let withdrawCalls: WithdrawCall[];

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

function tournamentRows() {
  return [
    {
      playerId: 1001,
      tournamentId: 700,
      tournamentName: 'Spring Open',
      tournamentStatus: 'upcoming',
      startDate: '2026-05-10T00:00:00Z',
      endDate: '2026-05-12T00:00:00Z',
      paymentStatus: 'paid',
      checkedIn: false,
      tournamentFormat: 'stroke',
      handicapIndex: '12.4',
    },
    {
      playerId: 1002,
      tournamentId: 701,
      tournamentName: 'Winter Cup',
      tournamentStatus: 'completed',
      startDate: '2026-01-10T00:00:00Z',
      endDate: '2026-01-12T00:00:00Z',
      paymentStatus: 'paid',
      checkedIn: true,
      tournamentFormat: 'stableford',
      handicapIndex: '12.4',
    },
  ];
}

function installFetch(opts: { withTournaments: boolean; withdrawStatus?: number; withdrawBody?: unknown }) {
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = (init?.method ?? 'GET').toUpperCase();

    if (url.endsWith('/api/portal/me')) return jsonResponse(ME);
    if (url.endsWith('/api/portal/my-stats'))
      return jsonResponse({ tournamentsPlayed: 0, totalScores: 0, averageStrokes: null, bestRound: null });
    if (url.endsWith('/api/portal/my-tournaments'))
      return jsonResponse(opts.withTournaments ? tournamentRows() : []);
    if (url.endsWith('/api/portal/my-leagues')) return jsonResponse([]);
    if (url.endsWith('/api/portal/membership')) return jsonResponse(null);
    if (url.endsWith('/api/portal/notification-preferences')) return jsonResponse(null);
    if (url.endsWith('/api/portal/ghin')) return jsonResponse(null);
    if (url.endsWith('/api/portal/locker')) return jsonResponse(null);
    if (url.endsWith('/api/portal/rankings/history')) return jsonResponse([]);
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

    const withdrawMatch = url.match(/\/api\/portal\/tournaments\/(\d+)\/withdraw$/);
    if (withdrawMatch && method === 'DELETE') {
      withdrawCalls.push({ tournamentId: Number(withdrawMatch[1]) });
      return jsonResponse(opts.withdrawBody ?? { withdrawn: true, refundPending: true }, opts.withdrawStatus ?? 200);
    }

    return new Response('', { status: 404 }) as unknown as Response;
  }) as typeof fetch;
}

beforeEach(() => {
  withdrawCalls = [];
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Portal Tournaments tab', () => {
  it('renders the empty-state card when the player has no tournaments', async () => {
    installFetch({ withTournaments: false });
    render(<PortalPage />);

    expect(await screen.findByTestId('portal-tournaments-empty')).toBeInTheDocument();
    expect(screen.getByText('portal:emptyStates.noTournaments')).toBeInTheDocument();
    // Without tournaments there are no per-row hooks.
    expect(screen.queryByTestId(/portal-tournament-row-/)).not.toBeInTheDocument();
  });

  it('renders one row per tournament with name + paid badge (populated state)', async () => {
    installFetch({ withTournaments: true });
    render(<PortalPage />);

    const upcomingRow = await screen.findByTestId('portal-tournament-row-700');
    expect(within(upcomingRow).getByText('Spring Open')).toBeInTheDocument();
    expect(within(upcomingRow).getByText('portal:paid')).toBeInTheDocument();
    // Withdraw affordance only shows for upcoming tournaments.
    expect(within(upcomingRow).getByTestId('button-withdraw-tournament-700')).toBeInTheDocument();

    const completedRow = screen.getByTestId('portal-tournament-row-701');
    expect(within(completedRow).getByText('Winter Cup')).toBeInTheDocument();
    expect(within(completedRow).queryByTestId('button-withdraw-tournament-701')).not.toBeInTheDocument();
  });

  it('confirming the withdraw dialog DELETEs the tournament and updates the badges', async () => {
    installFetch({ withTournaments: true, withdrawBody: { withdrawn: true, refundPending: true } });
    render(<PortalPage />);

    const withdrawBtn = await screen.findByTestId('button-withdraw-tournament-700');
    await userEvent.click(withdrawBtn);

    const confirmBtn = await screen.findByTestId('button-confirm-withdraw');
    await userEvent.click(confirmBtn);

    await waitFor(() => expect(withdrawCalls.length).toBe(1));
    expect(withdrawCalls[0].tournamentId).toBe(700);

    // Row swaps to the withdrawn + refund-pending badges, and the
    // withdraw button disappears.
    const updatedRow = await screen.findByTestId('portal-tournament-row-700');
    await waitFor(() => {
      expect(within(updatedRow).getByText('portal:withdrawn')).toBeInTheDocument();
    });
    expect(within(updatedRow).getByText('portal:refundPending')).toBeInTheDocument();
    expect(within(updatedRow).queryByTestId('button-withdraw-tournament-700')).not.toBeInTheDocument();
  });
});
