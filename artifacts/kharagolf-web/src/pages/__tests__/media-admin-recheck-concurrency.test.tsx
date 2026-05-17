/**
 * Task #1983 — UI test for the per-row Re-check concurrency cap on the
 * Media Admin page.
 *
 * Before this task an admin could click "Re-check" on every visible
 * unverifiable-video row in quick succession and fan out one POST per
 * click in parallel. Each request triggers a server-side ffprobe + an
 * object-storage read, so a large backlog could saturate the API and
 * egress.
 *
 * The page now caps in-flight per-row Re-checks at MAX_CONCURRENT_RECHECKS
 * (3) and queues the rest. This test mounts <MediaAdminPage /> with a
 * fixture of 6 unverifiable videos, holds the recheck-duration responses
 * open with manually-resolved promises, clicks every row's Re-check
 * button before any response settles, and asserts:
 *
 *   1. Only 3 POST /recheck-duration requests are in flight at once
 *      (the rest sit on the client-side queue).
 *   2. The 3 still-waiting rows render their "Queued" button label and
 *      "waiting…" hint, with the button disabled.
 *   3. As each in-flight request resolves, exactly one queued row is
 *      promoted to in-flight (the queue drains FIFO, so the limit holds
 *      across the whole batch).
 *   4. Eventually all 6 rows have been re-checked once — i.e. queueing
 *      defers but never drops requests.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, vi } from "vitest";
import { render, screen, waitFor, cleanup, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("wouter", () => ({
  Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) =>
    <a href={href} {...rest}>{children}</a>,
}));

vi.mock("@workspace/api-client-react", () => ({
  useGetMe: () => ({ data: { id: 1, organizationId: 42, role: "org_admin" } }),
}));

vi.mock("@/context/ActiveOrgContext", () => ({
  useActiveOrgContext: () => ({ activeOrgId: 42, isOrgOverridden: false, setActiveOrg: () => {} }),
}));

const toastMock = vi.fn();
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: toastMock }),
}));

import MediaAdminPage from "../media-admin";

interface UnverifiableVideo {
  id: number;
  objectPath: string;
  thumbnailPath: string | null;
  uploaderName: string | null;
  uploadedByUserId: number | null;
  uploaderEmail: string | null;
  tournamentId: number | null;
  leagueId: number | null;
  caption: string | null;
  approved: boolean;
  createdAt: string;
  durationLastCheckedAt: string | null;
  autoRecheckCount: number;
  unverifiableReason: "object_missing" | "permanently_unverifiable" | null;
}

function makeVideo(id: number): UnverifiableVideo {
  return {
    id,
    objectPath: `/v/${id}.mp4`,
    thumbnailPath: null,
    uploaderName: `Player ${id}`,
    uploadedByUserId: 100 + id,
    uploaderEmail: `p${id}@example.com`,
    tournamentId: null,
    leagueId: null,
    caption: `Clip ${id}`,
    approved: true,
    createdAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
    durationLastCheckedAt: null,
    autoRecheckCount: 1,
    unverifiableReason: "permanently_unverifiable",
  };
}

interface PendingRecheck {
  mediaId: number;
  resolve: (body: unknown) => void;
}

interface FetchHandler {
  videos: UnverifiableVideo[];
  pending: PendingRecheck[];
  recheckedIds: number[];
}

let handler: FetchHandler;

function installFetch() {
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";

    if (url.includes("/media/unverifiable-videos") && method === "GET") {
      return new Response(JSON.stringify({
        count: handler.videos.length,
        items: handler.videos,
        truncated: false,
        limit: 500,
        cooldownSeconds: 60,
      }), { status: 200, headers: { "Content-Type": "application/json" } }) as unknown as Response;
    }

    // Match /tournaments and /leagues list endpoints (best-effort lookups).
    if (url.endsWith("/tournaments") || url.endsWith("/leagues")) {
      return new Response(JSON.stringify([]), {
        status: 200, headers: { "Content-Type": "application/json" },
      }) as unknown as Response;
    }

    // Per-row recheck — hold the response open so the test can drive
    // when each request settles, and assert how many are in-flight.
    const recheckMatch = url.match(/\/media\/(\d+)\/recheck-duration$/);
    if (recheckMatch && method === "POST") {
      const mediaId = Number(recheckMatch[1]);
      handler.recheckedIds.push(mediaId);
      return await new Promise<Response>((resolveOuter) => {
        handler.pending.push({
          mediaId,
          resolve: (body) => {
            resolveOuter(new Response(JSON.stringify(body), {
              status: 200, headers: { "Content-Type": "application/json" },
            }) as unknown as Response);
          },
        });
      });
    }

    return new Response("not found", { status: 404 }) as unknown as Response;
  }) as typeof fetch;
}

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, refetchOnWindowFocus: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MediaAdminPage />
    </QueryClientProvider>,
  );
}

// jsdom doesn't implement these and Radix Select / Checkbox poke at them,
// even though this test never opens a dropdown. Cheap shims keep the
// render quiet.
beforeAll(() => {
  if (!Object.prototype.hasOwnProperty.call(HTMLElement.prototype, "hasPointerCapture")) {
    Object.defineProperty(HTMLElement.prototype, "hasPointerCapture", {
      configurable: true, value: () => false,
    });
  }
  if (!Object.prototype.hasOwnProperty.call(HTMLElement.prototype, "releasePointerCapture")) {
    Object.defineProperty(HTMLElement.prototype, "releasePointerCapture", {
      configurable: true, value: () => {},
    });
  }
  if (!Object.prototype.hasOwnProperty.call(HTMLElement.prototype, "scrollIntoView")) {
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true, value: () => {},
    });
  }
});

beforeEach(() => {
  handler = {
    videos: [1, 2, 3, 4, 5, 6].map(makeVideo),
    pending: [],
    recheckedIds: [],
  };
  toastMock.mockClear();
  installFetch();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Media admin per-row Re-check concurrency cap (Task #1983)", () => {
  it("caps in-flight per-row Re-checks at 3 and queues the rest", async () => {
    const user = userEvent.setup();
    renderPage();

    // Wait for the table to render all six rows.
    await waitFor(() => {
      expect(screen.getByTestId("button-recheck-1")).toBeInTheDocument();
      expect(screen.getByTestId("button-recheck-6")).toBeInTheDocument();
    });

    // Click every row's Re-check button in quick succession. Each click
    // adds the row to the page's queue; the drain effect dispatches up
    // to 3 in-flight requests against the server.
    for (const id of [1, 2, 3, 4, 5, 6]) {
      await user.click(screen.getByTestId(`button-recheck-${id}`));
    }

    // After all six clicks, only 3 POST /recheck-duration requests
    // should have actually gone out — the rest sit on the queue.
    await waitFor(() => {
      expect(handler.pending.length).toBe(3);
    });
    expect(handler.recheckedIds).toEqual([1, 2, 3]);

    // The first three rows are dispatched and disabled; the last three
    // are visibly queued ("waiting…" hint + disabled button labelled
    // "Queued"). The queued indicators are unique to this state — they
    // don't render for in-flight rows.
    for (const id of [4, 5, 6]) {
      expect(screen.getByTestId(`text-recheck-queued-${id}`)).toBeInTheDocument();
      expect(screen.getByTestId(`button-recheck-${id}`)).toBeDisabled();
      expect(screen.getByTestId(`button-recheck-${id}`)).toHaveTextContent(/Queued/);
    }
    for (const id of [1, 2, 3]) {
      expect(screen.queryByTestId(`text-recheck-queued-${id}`)).not.toBeInTheDocument();
      expect(screen.getByTestId(`button-recheck-${id}`)).toBeDisabled();
    }

    // Resolve the first in-flight request. That should free a slot,
    // and the drain effect should immediately promote the next queued
    // row (id=4) to in-flight — but we never go above 3 simultaneously.
    const first = handler.pending.shift()!;
    await act(async () => {
      first.resolve({ ok: true, recovered: false, reason: "unverifiable" });
    });

    await waitFor(() => {
      expect(handler.recheckedIds).toEqual([1, 2, 3, 4]);
    });
    expect(handler.pending.length).toBe(3);
    // Row 4 has been promoted off the queue.
    expect(screen.queryByTestId("text-recheck-queued-4")).not.toBeInTheDocument();
    // Rows 5 and 6 are still queued.
    expect(screen.getByTestId("text-recheck-queued-5")).toBeInTheDocument();
    expect(screen.getByTestId("text-recheck-queued-6")).toBeInTheDocument();

    // Drain the rest of the queue and assert each settle promotes
    // exactly one waiting row, never exceeding the cap.
    const second = handler.pending.shift()!;
    await act(async () => {
      second.resolve({ ok: true, recovered: false, reason: "unverifiable" });
    });
    await waitFor(() => {
      expect(handler.recheckedIds).toEqual([1, 2, 3, 4, 5]);
    });
    expect(handler.pending.length).toBe(3);

    const third = handler.pending.shift()!;
    await act(async () => {
      third.resolve({ ok: true, recovered: false, reason: "unverifiable" });
    });
    await waitFor(() => {
      expect(handler.recheckedIds).toEqual([1, 2, 3, 4, 5, 6]);
    });
    expect(handler.pending.length).toBe(3);

    // Drain the last three so the test doesn't leak hanging promises.
    while (handler.pending.length > 0) {
      const p = handler.pending.shift()!;
      await act(async () => {
        p.resolve({ ok: true, recovered: false, reason: "unverifiable" });
      });
    }

    // Eventually every row was re-checked exactly once: queueing defers,
    // it never drops requests.
    expect(new Set(handler.recheckedIds)).toEqual(new Set([1, 2, 3, 4, 5, 6]));
    expect(handler.recheckedIds.length).toBe(6);
  });
});
