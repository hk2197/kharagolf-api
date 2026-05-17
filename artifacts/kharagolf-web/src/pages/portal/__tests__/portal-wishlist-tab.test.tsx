/**
 * Regression coverage for the player portal Wishlist tab (Task #1284).
 *
 * The Wishlist tab is rendered inline inside `src/pages/portal/index.tsx`
 * (the planned per-tab extraction has not landed yet — see Task #956),
 * so we mount the whole portal page with stubbed fetch and drive it
 * through the inline `data-testid` hooks added alongside this test:
 *
 *   - empty state         → `portal-wishlist-empty` is rendered when
 *                           the shop returns no wishlist items
 *   - populated state     → one `portal-wishlist-row-<wishlistId>` per
 *                           saved item with the product name and price
 *   - one assertion flow  → each row exposes a
 *                           `link-add-to-cart-<productId>` link that
 *                           routes to the org-scoped shop with the
 *                           correct `?product=` query string
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

function wishlist() {
  return [
    {
      wishlistId: 5001,
      createdAt: '2026-04-01T00:00:00Z',
      product: {
        id: 21,
        name: 'Range Finder',
        imageUrl: null,
        markupPrice: '7500.00',
        currency: 'INR',
        category: 'electronics',
      },
    },
    {
      wishlistId: 5002,
      createdAt: '2026-04-02T00:00:00Z',
      product: {
        id: 22,
        name: 'Tour Polo',
        imageUrl: null,
        markupPrice: '2200.00',
        currency: 'INR',
        category: 'apparel',
      },
    },
  ];
}

function installFetch(opts: { withWishlist: boolean }) {
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
    if (url.includes('/shop/my-orders')) return jsonResponse([]);
    if (url.includes('/shop/wishlist'))
      return jsonResponse(opts.withWishlist ? wishlist() : []);
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

describe('Portal Wishlist tab', () => {
  it('renders the empty-state card when the shop returns no wishlist items', async () => {
    installFetch({ withWishlist: false });
    render(<PortalPage />);

    const wishlistTab = await screen.findByRole('tab', { name: /portal:tabs.wishlist/i });
    await userEvent.click(wishlistTab);

    expect(await screen.findByTestId('portal-wishlist-empty')).toBeInTheDocument();
    expect(screen.getByText('portal:wishlistEmpty')).toBeInTheDocument();
    expect(screen.queryByTestId(/portal-wishlist-row-/)).not.toBeInTheDocument();
  });

  it('renders one row per saved item with name and price (populated state)', async () => {
    installFetch({ withWishlist: true });
    render(<PortalPage />);

    const wishlistTab = await screen.findByRole('tab', { name: /portal:tabs.wishlist/i });
    await userEvent.click(wishlistTab);

    const row = await screen.findByTestId('portal-wishlist-row-5001');
    expect(within(row).getByText('Range Finder')).toBeInTheDocument();
    expect(within(row).getByText('₹7,500')).toBeInTheDocument();

    expect(screen.getByTestId('portal-wishlist-row-5002')).toBeInTheDocument();
  });

  it('exposes an Add-to-Cart link that routes to the org-scoped shop with the product id', async () => {
    installFetch({ withWishlist: true });
    render(<PortalPage />);

    const wishlistTab = await screen.findByRole('tab', { name: /portal:tabs.wishlist/i });
    await userEvent.click(wishlistTab);

    const row = await screen.findByTestId('portal-wishlist-row-5001');
    const addLink = within(row).getByTestId('link-add-to-cart-21');
    expect(addLink).toHaveAttribute('href', '/shop/42?product=21');
  });
});
