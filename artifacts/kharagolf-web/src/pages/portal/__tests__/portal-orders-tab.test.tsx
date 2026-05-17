/**
 * Regression coverage for the player portal Orders tab (Task #1284).
 *
 * The Orders tab is rendered inline inside `src/pages/portal/index.tsx`
 * (the planned per-tab extraction has not landed yet — see Task #956),
 * so we mount the whole portal page with stubbed fetch and drive it
 * through the inline `data-testid` hooks added alongside this test:
 *
 *   - empty state         → `portal-orders-empty` is rendered when the
 *                           shop returns no orders for the member
 *   - populated state     → one `portal-order-row-<id>` per order with
 *                           the product name, status badge and price
 *   - one assertion flow  → only the non-pending order exposes the
 *                           `link-order-receipt-<id>` download link;
 *                           pending orders intentionally hide it
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

function orders() {
  return [
    {
      id: 9001,
      productId: 11,
      size: 'M',
      quantity: 1,
      unitPrice: '1500.00',
      totalAmount: '1500.00',
      currency: 'INR',
      status: 'shipped',
      trackingNumber: 'TRK-123',
      trackingUrl: null,
      createdAt: '2026-04-01T00:00:00Z',
      productName: 'Pro Glove',
      productImage: null,
    },
    {
      id: 9002,
      productId: 12,
      size: null,
      quantity: 2,
      unitPrice: '500.00',
      totalAmount: '1000.00',
      currency: 'INR',
      status: 'pending',
      trackingNumber: null,
      trackingUrl: null,
      createdAt: '2026-04-05T00:00:00Z',
      productName: 'Tour Cap',
      productImage: null,
    },
  ];
}

function installFetch(opts: { withOrders: boolean }) {
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

    if (url.includes('/loyalty/me')) return jsonResponse(null);
    if (url.includes('/loyalty/rewards')) return jsonResponse([]);
    if (url.includes('/shop/my-orders'))
      return jsonResponse(opts.withOrders ? orders() : []);
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

describe('Portal Orders tab', () => {
  it('renders the empty-state card when the shop returns no orders', async () => {
    installFetch({ withOrders: false });
    render(<PortalPage />);

    const ordersTab = await screen.findByRole('tab', { name: /portal:tabs.orders/i });
    await userEvent.click(ordersTab);

    expect(await screen.findByTestId('portal-orders-empty')).toBeInTheDocument();
    expect(screen.getByText('portal:noOrdersYet')).toBeInTheDocument();
    expect(screen.queryByTestId(/portal-order-row-/)).not.toBeInTheDocument();
  });

  it('renders one row per order with product name and price (populated state)', async () => {
    installFetch({ withOrders: true });
    render(<PortalPage />);

    const ordersTab = await screen.findByRole('tab', { name: /portal:tabs.orders/i });
    await userEvent.click(ordersTab);

    const shippedRow = await screen.findByTestId('portal-order-row-9001');
    expect(within(shippedRow).getByText('Pro Glove')).toBeInTheDocument();
    expect(within(shippedRow).getByText('shipped')).toBeInTheDocument();
    expect(within(shippedRow).getByText('₹1,500')).toBeInTheDocument();

    const pendingRow = screen.getByTestId('portal-order-row-9002');
    expect(within(pendingRow).getByText('Tour Cap')).toBeInTheDocument();
    expect(within(pendingRow).getByText('pending')).toBeInTheDocument();
  });

  it('exposes the receipt download link only on non-pending orders', async () => {
    installFetch({ withOrders: true });
    render(<PortalPage />);

    const ordersTab = await screen.findByRole('tab', { name: /portal:tabs.orders/i });
    await userEvent.click(ordersTab);

    const shippedRow = await screen.findByTestId('portal-order-row-9001');
    const receiptLink = within(shippedRow).getByTestId('link-order-receipt-9001');
    expect(receiptLink).toHaveAttribute('href', '/api/payments/shop-order/9001/receipt');

    const pendingRow = screen.getByTestId('portal-order-row-9002');
    expect(within(pendingRow).queryByTestId('link-order-receipt-9002')).not.toBeInTheDocument();
  });
});
