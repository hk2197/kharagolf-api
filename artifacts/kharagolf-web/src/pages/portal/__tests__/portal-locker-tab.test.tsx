/**
 * Regression coverage for the player portal Locker tab (Task #1514).
 *
 * The Locker tab was extracted into its own `LockerTab.tsx` with a
 * `data-testid="portal-locker-tab"` hook, so we mount the component
 * directly with mocked props (mirroring the per-tab pattern other
 * sibling tests use). We cover the three rendering states and the
 * join-waitlist fetch behavior:
 *
 *   - assigned state      → when `lockerAssignment` is present, the
 *                           renewal card is rendered (mocked) and no
 *                           "Join Waitlist" button is shown
 *   - unassigned state    → `lockerAssignment === null` with no
 *                           waitlist shows "No Locker Assigned" and a
 *                           "Join Waitlist" button; clicking it POSTs
 *                           to `/api/portal/locker/join-waitlist` and
 *                           surfaces the returned entry via the
 *                           `setLockerWaitlist` prop
 *   - on-waitlist state   → an existing `lockerWaitlist` entry shows
 *                           the "On waitlist" card with the right
 *                           badge color/copy for `waiting` vs
 *                           `notified`
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../LockerRenewalCard', () => ({
  LockerRenewalCard: ({ assignment }: { assignment: { lockerNumber: string } }) => (
    <div data-testid="locker-renewal">Renewal {assignment.lockerNumber}</div>
  ),
}));

const toastMock = vi.fn();
vi.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: toastMock }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string; date?: string }) => {
      if (opts?.date) return `${key}:${opts.date}`;
      return opts?.defaultValue ?? key;
    },
    i18n: { language: 'en', changeLanguage: () => {} },
  }),
}));

vi.mock('@/i18n', () => ({
  default: { language: 'en', changeLanguage: () => {} },
  SUPPORTED_LANGUAGES: ['en'] as const,
  applyLanguageDirection: () => {},
}));

import { LockerTab } from '../LockerTab';
import type { LockerAssignment, LockerWaitlistEntry } from '../types';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  }) as unknown as Response;
}

function makeAssignment(overrides: Partial<LockerAssignment> = {}): LockerAssignment {
  return {
    id: 1,
    lockerNumber: 'A-12',
    bay: 'North',
    expiryDate: '2027-01-01',
    startDate: '2026-01-01',
    status: 'active',
    annualFee: '5000.00',
    currency: 'INR',
    paymentStatus: 'paid',
    paymentLinkUrl: null,
    ...overrides,
  };
}

function renderTab(props: {
  lockerAssignment?: LockerAssignment | null;
  lockerWaitlist?: LockerWaitlistEntry | null;
  joiningWaitlist?: boolean;
  setJoiningWaitlist?: (value: boolean) => void;
  setLockerWaitlist?: (entry: LockerWaitlistEntry) => void;
  orgId?: number | null;
}) {
  const setJoiningWaitlist = props.setJoiningWaitlist ?? vi.fn();
  const setLockerWaitlist = props.setLockerWaitlist ?? vi.fn();
  render(
    <LockerTab
      lockerAssignment={props.lockerAssignment}
      lockerWaitlist={props.lockerWaitlist ?? null}
      joiningWaitlist={props.joiningWaitlist ?? false}
      setJoiningWaitlist={setJoiningWaitlist}
      setLockerWaitlist={setLockerWaitlist}
      orgId={props.orgId ?? 42}
    />,
  );
  return { setJoiningWaitlist, setLockerWaitlist };
}

afterEach(() => {
  cleanup();
  toastMock.mockClear();
  vi.restoreAllMocks();
});

describe('Portal Locker tab', () => {
  it('renders the renewal card when the player has a current locker assignment', () => {
    renderTab({ lockerAssignment: makeAssignment({ lockerNumber: 'B-7' }) });

    const tab = screen.getByTestId('portal-locker-tab');
    expect(within(tab).getByTestId('locker-renewal')).toHaveTextContent('Renewal B-7');
    expect(within(tab).queryByRole('button', { name: 'portal:joinWaitlist' })).not.toBeInTheDocument();
    expect(within(tab).queryByText('portal:noLockerAssigned')).not.toBeInTheDocument();
  });

  it('shows the Join Waitlist call to action when the player has no locker and is not on the waitlist', async () => {
    const setJoiningWaitlist = vi.fn();
    const setLockerWaitlist = vi.fn();
    const newEntry: LockerWaitlistEntry = {
      id: 77,
      requestedAt: '2026-04-29T10:00:00Z',
      status: 'waiting',
    };
    global.fetch = vi.fn(async () => jsonResponse(newEntry)) as typeof fetch;

    renderTab({
      lockerAssignment: null,
      lockerWaitlist: null,
      setJoiningWaitlist,
      setLockerWaitlist,
    });

    const tab = screen.getByTestId('portal-locker-tab');
    expect(within(tab).getByText('portal:noLockerAssigned')).toBeInTheDocument();

    const joinButton = within(tab).getByRole('button', { name: 'portal:joinWaitlist' });
    await userEvent.click(joinButton);

    await waitFor(() => {
      expect(setLockerWaitlist).toHaveBeenCalledWith(newEntry);
    });
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/portal/locker/join-waitlist',
      expect.objectContaining({ method: 'POST', credentials: 'include' }),
    );
    expect(setJoiningWaitlist).toHaveBeenCalledWith(true);
    await waitFor(() => {
      expect(setJoiningWaitlist).toHaveBeenLastCalledWith(false);
    });
  });

  it('shows a destructive toast and resets joiningWaitlist when the join-waitlist fetch rejects', async () => {
    const setJoiningWaitlist = vi.fn();
    const setLockerWaitlist = vi.fn();
    global.fetch = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }) as typeof fetch;

    renderTab({
      lockerAssignment: null,
      lockerWaitlist: null,
      setJoiningWaitlist,
      setLockerWaitlist,
    });

    const tab = screen.getByTestId('portal-locker-tab');
    const joinButton = within(tab).getByRole('button', { name: 'portal:joinWaitlist' });
    await userEvent.click(joinButton);

    await waitFor(() => {
      expect(toastMock).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'common:error',
          description: 'portal:couldNotJoinWaitlist',
          variant: 'destructive',
        }),
      );
    });
    expect(setLockerWaitlist).not.toHaveBeenCalled();
    expect(setJoiningWaitlist).toHaveBeenCalledWith(true);
    await waitFor(() => {
      expect(setJoiningWaitlist).toHaveBeenLastCalledWith(false);
    });
  });

  it('renders the on-waitlist card with the blue "waiting" badge when the entry is still queued', () => {
    renderTab({
      lockerAssignment: null,
      lockerWaitlist: { id: 1, requestedAt: '2026-04-01T00:00:00Z', status: 'waiting' },
    });

    const tab = screen.getByTestId('portal-locker-tab');
    expect(within(tab).getByText('portal:onWaitlist')).toBeInTheDocument();

    const badge = within(tab).getByText('portal:waiting');
    expect(badge.className).toMatch(/blue-/);
    expect(badge.className).not.toMatch(/yellow-/);
    expect(within(tab).queryByRole('button', { name: 'portal:joinWaitlist' })).not.toBeInTheDocument();
  });

  it('renders the on-waitlist card with the yellow "notified" badge when a locker is available', () => {
    renderTab({
      lockerAssignment: null,
      lockerWaitlist: { id: 2, requestedAt: '2026-04-10T00:00:00Z', status: 'notified' },
    });

    const tab = screen.getByTestId('portal-locker-tab');
    expect(within(tab).getByText('portal:onWaitlist')).toBeInTheDocument();

    const badge = within(tab).getByText('portal:lockerAvailableContact');
    expect(badge.className).toMatch(/yellow-/);
    expect(badge.className).not.toMatch(/blue-/);
  });
});
