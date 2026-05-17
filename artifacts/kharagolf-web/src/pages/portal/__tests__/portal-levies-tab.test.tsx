/**
 * Regression coverage for the player portal Levies tab (Task #1115).
 *
 * The Levies tab is currently rendered inline inside
 * `src/pages/portal/index.tsx` (the planned extraction in Task #956 has
 * not landed yet — see commit notes), so we mount the whole portal page
 * with stubbed fetch + Razorpay and drive it through the existing
 * `data-testid` hooks:
 *
 *   - empty state         → no `levies` tab trigger when the statement
 *                           returns no charges
 *   - populated state     → one row per charge with a working
 *                           `button-pay-levy-<id>` and
 *                           `button-partial-pay-levy-<id>`
 *   - interactive flow    → the partial-pay dialog (`input-partial-pay-amount`
 *                           + `button-submit-partial-pay`) POSTs to
 *                           `/portal/levies/charges/<id>/order` with the
 *                           amount the player typed
 *
 * Backend behaviour for `/portal/my-statement` and the levy order
 * endpoint is covered separately by api-server tests.
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

interface OrderCall {
  chargeId: number;
  body: Record<string, unknown>;
}

interface FetchState {
  orderCalls: OrderCall[];
  levyChargeAmount: string;
  levyChargePaid: string;
}

let state: FetchState;

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

function levyCharge() {
  return [{
    charge: {
      id: 501, levyId: 9, clubMemberId: 12,
      amount: '500.00', paidAmount: '0.00', refundedAmount: '0.00',
      status: 'unpaid', paid: false, paidAt: null,
      createdAt: '2026-04-01T00:00:00Z',
    },
    levy: { id: 9, name: 'Spring levy', currency: 'INR', description: 'Annual greens' },
  }];
}

function installFetch(opts: { withLevies: boolean }) {
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = (init?.method ?? 'GET').toUpperCase();

    // Auth + initial dashboard fan-out.
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
    if (url.endsWith('/api/portal/my-statement')) {
      return jsonResponse({
        levyCharges: opts.withLevies ? levyCharge() : [],
        outstandingBalance: opts.withLevies ? '500.00' : '0.00',
      });
    }

    // Org-scoped fan-out.
    if (url.includes('/loyalty/me')) return jsonResponse(null);
    if (url.includes('/loyalty/rewards')) return jsonResponse([]);
    if (url.includes('/shop/my-orders')) return jsonResponse([]);
    if (url.includes('/shop/wishlist')) return jsonResponse([]);
    if (url.includes('/dues-billing/my-invoices')) return jsonResponse([]);
    if (url.includes('/marketplace/my-bookings')) return jsonResponse([]);
    if (url.includes('/rules-config')) return jsonResponse(null);

    // Levy partial-pay order endpoint — the assertion we care about.
    const orderMatch = url.match(/\/api\/portal\/levies\/charges\/(\d+)\/order$/);
    if (orderMatch && method === 'POST') {
      state.orderCalls.push({
        chargeId: Number(orderMatch[1]),
        body: JSON.parse((init?.body as string) ?? '{}'),
      });
      // Return 4xx so payLevyCharge bails before touching Razorpay (we only
      // need to assert the order POST, not the gateway flow).
      return jsonResponse({ error: 'noop' }, 400);
    }

    return new Response('', { status: 404 }) as unknown as Response;
  }) as typeof fetch;
}

beforeEach(() => {
  state = { orderCalls: [], levyChargeAmount: '500.00', levyChargePaid: '0.00' };
  // Stub Razorpay so ensureRazorpayLoaded short-circuits if we ever reach it.
  (window as unknown as { Razorpay: unknown }).Razorpay = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete (window as unknown as { Razorpay?: unknown }).Razorpay;
});

describe('Portal Levies tab', () => {
  it('hides the Levies tab when the member has no levy charges (empty state)', async () => {
    installFetch({ withLevies: false });
    render(<PortalPage />);

    // Wait for dashboard to finish loading by waiting for the always-present
    // tournaments tab content.
    await waitFor(() => {
      expect(screen.getByText('portal:emptyStates.noTournaments')).toBeInTheDocument();
    });

    expect(screen.queryByRole('tab', { name: /Levies/i })).not.toBeInTheDocument();
  });

  it('renders one row per charge with pay + partial-pay buttons (populated state)', async () => {
    installFetch({ withLevies: true });
    render(<PortalPage />);

    const leviesTab = await screen.findByRole('tab', { name: /Levies/i });
    await userEvent.click(leviesTab);

    expect(await screen.findByTestId('button-pay-levy-501')).toBeInTheDocument();
    expect(screen.getByTestId('button-partial-pay-levy-501')).toBeInTheDocument();
    expect(screen.getByText('Spring levy')).toBeInTheDocument();
  });

  it('partial-pay dialog POSTs the entered amount to the levy order endpoint', async () => {
    installFetch({ withLevies: true });
    render(<PortalPage />);

    const leviesTab = await screen.findByRole('tab', { name: /Levies/i });
    await userEvent.click(leviesTab);

    const partialBtn = await screen.findByTestId('button-partial-pay-levy-501');
    await userEvent.click(partialBtn);

    const amountInput = await screen.findByTestId('input-partial-pay-amount');
    await userEvent.clear(amountInput);
    await userEvent.type(amountInput, '120.50');

    const submitBtn = screen.getByTestId('button-submit-partial-pay');
    await userEvent.click(submitBtn);

    await waitFor(() => expect(state.orderCalls.length).toBe(1));
    expect(state.orderCalls[0].chargeId).toBe(501);
    expect(state.orderCalls[0].body).toEqual({ amount: 120.5 });
  });

  it('rejects an over-balance partial payment without hitting the order endpoint', async () => {
    installFetch({ withLevies: true });
    render(<PortalPage />);

    const leviesTab = await screen.findByRole('tab', { name: /Levies/i });
    await userEvent.click(leviesTab);

    await userEvent.click(await screen.findByTestId('button-partial-pay-levy-501'));

    const amountInput = await screen.findByTestId('input-partial-pay-amount');
    await userEvent.clear(amountInput);
    await userEvent.type(amountInput, '9999');

    await userEvent.click(screen.getByTestId('button-submit-partial-pay'));

    // Give any async error path a tick to settle.
    await new Promise(r => setTimeout(r, 20));
    expect(state.orderCalls.length).toBe(0);

    // Dialog stays open so the player can correct the amount.
    expect(within(document.body).getByTestId('input-partial-pay-amount')).toBeInTheDocument();
  });
});
