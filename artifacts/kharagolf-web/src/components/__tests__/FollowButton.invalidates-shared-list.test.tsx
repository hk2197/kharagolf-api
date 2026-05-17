/**
 * Task #2142 — Follow / Unfollow updates every follow-driven surface in the
 * same page session, with no reload.
 *
 * Background: <FollowButton> previously toggled only its own local state
 * (`useState(initialFollowing)`), but every other surface that reads from
 * the shared `['portal-follows-list']` query through `useFolloweeIds`
 * (spectator "Following" section, leaderboard followed-row pill,
 * member-360, players, club-members, my-follows) stayed out of sync until
 * the page was reloaded.
 *
 * The fix added a `queryClient.invalidateQueries({ queryKey:
 * ['portal-follows-list'] })` call after the POST/DELETE settles. This
 * test mounts <FollowButton> next to a tiny consumer that reads the same
 * shared query and asserts:
 *
 *   1. Following a not-yet-followed user causes the shared list to
 *      re-fetch and the consumer re-renders the new id.
 *   2. Unfollowing an already-followed user does the same in reverse.
 *   3. A failed POST/DELETE does NOT invalidate the shared list (the
 *      catch branch short-circuits before the invalidation runs).
 */
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';

const toastMock = vi.fn();
vi.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: toastMock }),
}));

import { FollowButton } from '../FollowButton';

interface Handler {
  /** Current followee list returned by GET /api/portal/follows. */
  followeeIds: number[];
  /** Number of times GET /api/portal/follows has been hit. */
  fetchCount: number;
  /** Toggle requests recorded in order of arrival. */
  toggleRequests: Array<{ method: string; userId: number }>;
  /** HTTP status the next POST/DELETE will respond with. */
  toggleStatus: number;
}

let handler: Handler;

function installFetch() {
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = (init?.method ?? 'GET').toUpperCase();

    if (url.endsWith('/api/portal/follows') && method === 'GET') {
      handler.fetchCount += 1;
      return new Response(JSON.stringify({ followeeIds: handler.followeeIds }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }) as unknown as Response;
    }

    const toggle = url.match(/\/api\/portal\/follows\/(\d+)$/);
    if (toggle && (method === 'POST' || method === 'DELETE')) {
      const userId = parseInt(toggle[1], 10);
      handler.toggleRequests.push({ method, userId });
      if (handler.toggleStatus >= 200 && handler.toggleStatus < 300) {
        if (method === 'POST' && !handler.followeeIds.includes(userId)) {
          handler.followeeIds = [...handler.followeeIds, userId];
        }
        if (method === 'DELETE') {
          handler.followeeIds = handler.followeeIds.filter(id => id !== userId);
        }
      }
      return new Response(JSON.stringify({ ok: handler.toggleStatus < 400 }), {
        status: handler.toggleStatus,
        headers: { 'Content-Type': 'application/json' },
      }) as unknown as Response;
    }

    return new Response('{}', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }) as unknown as Response;
  }) as typeof fetch;
}

/**
 * Tiny consumer that mirrors what useFolloweeIds does — reads the same
 * `['portal-follows-list']` cache key from `/api/portal/follows`. We use
 * a hand-rolled useQuery (instead of importing useFolloweeIds directly)
 * to keep this test focused on the cache-invalidation contract: any
 * consumer of the shared key must see the new value after a toggle.
 */
function FolloweeListProbe() {
  const { data } = useQuery<{ followeeIds: number[] }>({
    queryKey: ['portal-follows-list'],
    queryFn: async () => {
      const res = await fetch('/api/portal/follows', { credentials: 'include' });
      if (!res.ok) return { followeeIds: [] };
      return res.json();
    },
    staleTime: 30 * 1000,
  });
  const ids = data?.followeeIds ?? [];
  return (
    <ul data-testid="probe-followee-list">
      {ids.map(id => (
        <li key={id} data-testid={`probe-followee-${id}`}>{id}</li>
      ))}
    </ul>
  );
}

function renderHarness(props: { userId: number; initialFollowing: boolean }) {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false, staleTime: 30_000 },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={qc}>
      <FollowButton userId={props.userId} initialFollowing={props.initialFollowing} />
      <FolloweeListProbe />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  handler = {
    followeeIds: [],
    fetchCount: 0,
    toggleRequests: [],
    toggleStatus: 200,
  };
  toastMock.mockClear();
  installFetch();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Task #2142 — FollowButton invalidates the shared portal-follows-list cache', () => {
  it('refetches the shared list (so co-rendered surfaces update) after a successful follow', async () => {
    handler.followeeIds = [];

    renderHarness({ userId: 201, initialFollowing: false });

    // Initial render: probe fires the first /api/portal/follows fetch and
    // sees an empty list, so no <li> is rendered for user 201.
    await waitFor(() => {
      expect(handler.fetchCount).toBeGreaterThanOrEqual(1);
    });
    expect(screen.queryByTestId('probe-followee-201')).not.toBeInTheDocument();

    const fetchesBeforeClick = handler.fetchCount;
    handler.followeeIds = [201]; // server-side state after the POST below

    const btn = screen.getByTestId('button-follow-201');
    await userEvent.setup().click(btn);

    // FollowButton fired the POST.
    await waitFor(() => {
      expect(handler.toggleRequests).toEqual([{ method: 'POST', userId: 201 }]);
    });

    // The button itself flipped to "Following" (existing optimistic flip).
    await waitFor(() => {
      expect(btn).toHaveTextContent(/^Following$/);
    });

    // The crux of the task: the shared list cache was invalidated, so the
    // co-rendered probe re-fetched and now shows user 201.
    await waitFor(() => {
      expect(handler.fetchCount).toBeGreaterThan(fetchesBeforeClick);
    });
    await waitFor(() => {
      expect(screen.getByTestId('probe-followee-201')).toBeInTheDocument();
    });
  });

  it('refetches the shared list after a successful unfollow so the dropped id disappears', async () => {
    handler.followeeIds = [201];

    renderHarness({ userId: 201, initialFollowing: true });

    // Initial fetch hydrates the probe with the existing followee.
    await waitFor(() => {
      expect(screen.getByTestId('probe-followee-201')).toBeInTheDocument();
    });

    const fetchesBeforeClick = handler.fetchCount;

    const btn = screen.getByTestId('button-follow-201');
    await userEvent.setup().click(btn);

    await waitFor(() => {
      expect(handler.toggleRequests).toEqual([{ method: 'DELETE', userId: 201 }]);
    });

    // Button flipped back to "Follow".
    await waitFor(() => {
      expect(btn).toHaveTextContent(/^Follow$/);
    });

    // Shared cache was invalidated => probe refetched => row gone.
    await waitFor(() => {
      expect(handler.fetchCount).toBeGreaterThan(fetchesBeforeClick);
    });
    await waitFor(() => {
      expect(screen.queryByTestId('probe-followee-201')).not.toBeInTheDocument();
    });
  });

  it('does NOT invalidate the shared list when the toggle request fails', async () => {
    handler.followeeIds = [];
    handler.toggleStatus = 500;

    renderHarness({ userId: 201, initialFollowing: false });

    await waitFor(() => {
      expect(handler.fetchCount).toBeGreaterThanOrEqual(1);
    });
    const fetchesBeforeClick = handler.fetchCount;

    const btn = screen.getByTestId('button-follow-201');
    await userEvent.setup().click(btn);

    // The POST was attempted.
    await waitFor(() => {
      expect(handler.toggleRequests).toEqual([{ method: 'POST', userId: 201 }]);
    });

    // The error toast surfaced (catch branch).
    await waitFor(() => {
      expect(toastMock).toHaveBeenCalled();
    });

    // The button stays on "Follow" (no optimistic flip on failure).
    expect(btn).toHaveTextContent(/^Follow$/);

    // No invalidation => no extra refetch of the shared list.
    expect(handler.fetchCount).toBe(fetchesBeforeClick);
    expect(screen.queryByTestId('probe-followee-201')).not.toBeInTheDocument();
  });
});
