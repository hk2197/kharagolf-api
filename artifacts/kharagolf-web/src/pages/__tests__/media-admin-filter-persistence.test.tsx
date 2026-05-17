/**
 * Task #2000 — The Video Cleanup filter controls (uploader search, "older
 * than" age, tournament/league) on /media-admin must survive a page reload
 * and be shareable via URL. Task #1598 added the controls but kept their
 * state in memory only, so admins working through the backlog over multiple
 * sessions (or after the auto-refresh re-mounts the page) had to re-pick
 * the same filters every time.
 *
 * This test pins down four behaviours so a regression in any of them fails:
 *   1. With no query string, the filters render their defaults and the URL
 *      is left clean (no spurious `?uploader=` etc.).
 *   2. Mounting with `?uploader=…&older=30&event=tournament:7` hydrates the
 *      controls so a refresh / shared link reproduces the view.
 *   3. Typing into the uploader search mirrors the value into the URL
 *      (and clearing it removes the param so the URL stays tidy).
 *   4. Unrelated query-string parameters (e.g. `?activeOrg=…`) are
 *      preserved when the filters change.
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
  uploaderLastNudgedAt: string | null;
}

// A small fixture covering each "shape" the filters care about: a row
// linked to a tournament, one linked to a league, and one with no event,
// with two uploaders so the uploader search has something to bite on.
const VIDEOS: UnverifiableVideo[] = [
  {
    id: 1,
    objectPath: "/v/1.mp4",
    thumbnailPath: null,
    uploaderName: "Alice Player",
    uploadedByUserId: 101,
    uploaderEmail: "alice@example.com",
    tournamentId: 7,
    leagueId: null,
    caption: "Front nine",
    approved: true,
    createdAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(),
    durationLastCheckedAt: null,
    autoRecheckCount: 1,
    unverifiableReason: "permanently_unverifiable",
    uploaderLastNudgedAt: null,
  },
  {
    id: 2,
    objectPath: "/v/2.mp4",
    thumbnailPath: null,
    uploaderName: "Bob Player",
    uploadedByUserId: 102,
    uploaderEmail: "bob@example.com",
    tournamentId: null,
    leagueId: 9,
    caption: "Back nine",
    approved: true,
    createdAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
    durationLastCheckedAt: null,
    autoRecheckCount: 1,
    unverifiableReason: "permanently_unverifiable",
    uploaderLastNudgedAt: null,
  },
  {
    id: 3,
    objectPath: "/v/3.mp4",
    thumbnailPath: null,
    uploaderName: "Bob Player",
    uploadedByUserId: 102,
    uploaderEmail: "bob@example.com",
    tournamentId: null,
    leagueId: null,
    caption: "Practice round",
    approved: true,
    createdAt: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString(),
    durationLastCheckedAt: null,
    autoRecheckCount: 1,
    unverifiableReason: "object_missing",
    uploaderLastNudgedAt: null,
  },
];

function installFetch() {
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";

    if (url.includes("/media/unverifiable-videos") && method === "GET") {
      return new Response(JSON.stringify({
        count: VIDEOS.length,
        items: VIDEOS,
        truncated: false,
        limit: 500,
        cooldownSeconds: 60,
        reuploadCooldownHours: 24,
      }), { status: 200, headers: { "Content-Type": "application/json" } }) as unknown as Response;
    }

    // Tournament / league name lookups — best-effort and not required by
    // these assertions, so an empty list keeps the network quiet.
    if (url.endsWith("/tournaments")) {
      return new Response(JSON.stringify([{ id: 7, name: "Spring Open" }]), {
        status: 200, headers: { "Content-Type": "application/json" },
      }) as unknown as Response;
    }
    if (url.endsWith("/leagues")) {
      return new Response(JSON.stringify([{ id: 9, name: "Tuesday League" }]), {
        status: 200, headers: { "Content-Type": "application/json" },
      }) as unknown as Response;
    }

    return new Response("not found", { status: 404 }) as unknown as Response;
  }) as typeof fetch;
}

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity, refetchOnWindowFocus: false, refetchInterval: false },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MediaAdminPage />
    </QueryClientProvider>,
  );
}

// jsdom doesn't implement these and Radix Select pokes at them.
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
  // jsdom keeps `window.location` between tests, so reset to a clean URL
  // so initial-state assertions are deterministic.
  window.history.replaceState(null, "", "/media-admin");
  toastMock.mockClear();
  installFetch();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Media admin filter persistence (Task #2000)", () => {
  it("defaults to empty filters and leaves the URL clean for a first-time visitor", async () => {
    renderPage();

    const uploaderInput = await screen.findByTestId("input-filter-uploader") as HTMLInputElement;
    expect(uploaderInput.value).toBe("");

    // All three rows render — no filter is hiding any of them.
    await waitFor(() => {
      expect(screen.getByTestId("row-video-1")).toBeInTheDocument();
      expect(screen.getByTestId("row-video-2")).toBeInTheDocument();
      expect(screen.getByTestId("row-video-3")).toBeInTheDocument();
    });

    expect(window.location.search).toBe("");
  });

  it("hydrates the filters from the URL so a refresh / shared link reproduces the view", async () => {
    window.history.replaceState(null, "", "/media-admin?uploader=alice&older=30&event=tournament%3A7");
    renderPage();

    const uploaderInput = await screen.findByTestId("input-filter-uploader") as HTMLInputElement;
    await waitFor(() => {
      expect(uploaderInput.value).toBe("alice");
    });

    // Only the row matching the uploader query, the >30-day age filter,
    // and the tournament:7 event filter is left visible.
    await waitFor(() => {
      expect(screen.getByTestId("row-video-1")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("row-video-2")).not.toBeInTheDocument();
    expect(screen.queryByTestId("row-video-3")).not.toBeInTheDocument();

    // The summary reflects the filtered count.
    expect(screen.getByTestId("text-filtered-count").textContent).toBe("1");

    // And the original URL params are preserved (not stripped on mount).
    const sp = new URLSearchParams(window.location.search);
    expect(sp.get("uploader")).toBe("alice");
    expect(sp.get("older")).toBe("30");
    expect(sp.get("event")).toBe("tournament:7");
  });

  it("ignores an unknown `older` value and falls back to 'any' (and scrubs it from the URL)", async () => {
    window.history.replaceState(null, "", "/media-admin?older=bogus");
    renderPage();

    // No row is filtered out — `older=bogus` was ignored, not enforced.
    await waitFor(() => {
      expect(screen.getByTestId("row-video-1")).toBeInTheDocument();
      expect(screen.getByTestId("row-video-2")).toBeInTheDocument();
      expect(screen.getByTestId("row-video-3")).toBeInTheDocument();
    });

    // And the rogue param is wiped from the URL on the first effect tick.
    await waitFor(() => {
      expect(window.location.search).toBe("");
    });
  });

  it("ignores a malformed `event` value and falls back to 'any' (and scrubs it from the URL)", async () => {
    window.history.replaceState(null, "", "/media-admin?event=garbage");
    renderPage();

    // No row is filtered out — the malformed event filter was ignored.
    await waitFor(() => {
      expect(screen.getByTestId("row-video-1")).toBeInTheDocument();
      expect(screen.getByTestId("row-video-2")).toBeInTheDocument();
      expect(screen.getByTestId("row-video-3")).toBeInTheDocument();
    });

    await waitFor(() => {
      expect(window.location.search).toBe("");
    });
  });

  it("mirrors uploader-search keystrokes into the URL and clears the param when the field empties", async () => {
    const user = userEvent.setup();
    renderPage();

    const uploaderInput = await screen.findByTestId("input-filter-uploader");

    await act(async () => {
      await user.type(uploaderInput, "bob");
    });

    await waitFor(() => {
      const sp = new URLSearchParams(window.location.search);
      expect(sp.get("uploader")).toBe("bob");
    });

    // Filter has narrowed to Bob's two rows.
    expect(screen.queryByTestId("row-video-1")).not.toBeInTheDocument();
    expect(screen.getByTestId("row-video-2")).toBeInTheDocument();
    expect(screen.getByTestId("row-video-3")).toBeInTheDocument();

    await act(async () => {
      await user.clear(uploaderInput);
    });

    await waitFor(() => {
      expect(window.location.search).toBe("");
    });
  });

  it("preserves unrelated query-string parameters when filters change", async () => {
    window.history.replaceState(null, "", "/media-admin?activeOrg=42");
    const user = userEvent.setup();
    renderPage();

    const uploaderInput = await screen.findByTestId("input-filter-uploader");
    await act(async () => {
      await user.type(uploaderInput, "alice");
    });

    await waitFor(() => {
      const sp = new URLSearchParams(window.location.search);
      expect(sp.get("activeOrg")).toBe("42");
      expect(sp.get("uploader")).toBe("alice");
    });

    await act(async () => {
      await user.clear(uploaderInput);
    });

    await waitFor(() => {
      const sp = new URLSearchParams(window.location.search);
      expect(sp.get("activeOrg")).toBe("42");
      expect(sp.has("uploader")).toBe(false);
    });
  });
});
