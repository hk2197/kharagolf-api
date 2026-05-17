/**
 * UI test for the portal "Share my profile" Copy link button (Task #787).
 *
 * Mounts <PortalPrivacyPage /> with stubbed fetch + clipboard so we can
 * exercise the analytics contract: clicking the "Copy link" button must
 * POST to /api/portal/me/profile-share-events with { method: "copy",
 * source: "web" } and then refresh /api/portal/me/public-profile/share-stats.
 *
 * The server-side contract for that endpoint (auth, method validation,
 * no-handle case, source whitelist, aggregation) is covered against the
 * live PostgreSQL test DB by
 * artifacts/api-server/src/tests/profile-share-events.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("wouter", () => ({
  Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) =>
    <a href={href} {...rest}>{children}</a>,
}));

import PortalPrivacyPage from "../portal/privacy";

interface ShareEventBody { method: string; source: string }

interface FetchState {
  shareEventCalls: ShareEventBody[];
  shareStatsCalls: number;
  total: number;
  byMethodCopy: number;
  // Task #1782 — drive the optional web-vs-mobile reach split. When
  // `bySource` is null, the share-stats response omits the field entirely
  // (mirroring the API for owners with only legacy/null-source history).
  bySource: { web: number; mobile: number } | null;
}

let state: FetchState;

function installFetch() {
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();

    // Initial settings fetch — return a profile with a handle and public
    // profile enabled so the Share section renders.
    if (url.endsWith("/api/portal/me/public-profile") && method === "GET") {
      return new Response(JSON.stringify({
        publicHandle: "share-tester",
        publicProfileEnabled: true,
        publicShowHandicap: true,
        publicShowRecentRounds: true,
        publicShowAchievements: true,
        publicShowFavoriteCourses: true,
        publicBio: null,
        publicLocation: null,
      }), { status: 200, headers: { "Content-Type": "application/json" } }) as unknown as Response;
    }

    if (url.endsWith("/api/portal/me/public-scorecards") && method === "GET") {
      return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } }) as unknown as Response;
    }

    if (url.endsWith("/api/portal/me/public-profile/share-stats") && method === "GET") {
      state.shareStatsCalls += 1;
      const payload: {
        total: number;
        byMethod: Record<string, number>;
        bySource?: { web: number; mobile: number };
      } = {
        total: state.total,
        byMethod: { copy: state.byMethodCopy, web_share: 0, native_share: 0, qr_open: 0 },
      };
      if (state.bySource) payload.bySource = state.bySource;
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }) as unknown as Response;
    }

    if (url.endsWith("/api/portal/me/profile-share-events") && method === "POST") {
      const body = JSON.parse((init?.body as string) ?? "{}") as ShareEventBody;
      state.shareEventCalls.push(body);
      // Mirror the server: bump the cached share count so the next stats
      // refresh sees the new event.
      if (body.method === "copy") {
        state.byMethodCopy += 1;
        state.total += 1;
        // The server also tags the event by source; for source="web" it
        // bumps the web bucket of bySource. We mirror that so the chip
        // row updates after a fresh share.
        if (body.source === "web") {
          state.bySource = state.bySource
            ? { ...state.bySource, web: state.bySource.web + 1 }
            : { web: 1, mobile: 0 };
        }
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }) as unknown as Response;
    }

    return new Response("not found", { status: 404 }) as unknown as Response;
  }) as typeof fetch;
}

function installClipboard() {
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: vi.fn(async () => undefined) },
    configurable: true,
  });
}

beforeEach(() => {
  state = { shareEventCalls: [], shareStatsCalls: 0, total: 0, byMethodCopy: 0, bySource: null };
  installFetch();
  installClipboard();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("<PortalPrivacyPage /> — Share my profile copy link", () => {
  it("renders the Share section once the public profile is loaded", async () => {
    render(<PortalPrivacyPage />);
    expect(await screen.findByTestId("share-section")).toBeInTheDocument();
    expect(screen.getByTestId("share-copy")).toHaveTextContent(/Copy link/i);
    // Initial stats fetch happened as part of the page-load Promise.all.
    await waitFor(() => expect(state.shareStatsCalls).toBeGreaterThanOrEqual(1));
  });

  it("clicking Copy link writes the URL to the clipboard, POSTs a method=copy / source=web event, and refreshes the stats", async () => {
    render(<PortalPrivacyPage />);
    const copyBtn = await screen.findByTestId("share-copy");

    const statsBefore = state.shareStatsCalls;

    await userEvent.click(copyBtn);

    // Clipboard received the profile URL — the page builds it from
    // window.location and the public handle.
    const clip = navigator.clipboard.writeText as ReturnType<typeof vi.fn>;
    await waitFor(() => expect(clip).toHaveBeenCalledTimes(1));
    const writtenUrl = clip.mock.calls[0][0] as string;
    expect(writtenUrl).toMatch(/\/p\/share-tester$/);

    // Analytics POST — exactly one event with the expected shape.
    await waitFor(() => expect(state.shareEventCalls.length).toBe(1));
    expect(state.shareEventCalls[0]).toEqual({ method: "copy", source: "web" });

    // Button briefly flips to the "Copied!" state to confirm to the user.
    await waitFor(() => expect(copyBtn).toHaveTextContent(/Copied!/i));

    // Stats refresh fires after the event POST settles, so the visible
    // count and the per-method line update without a full reload.
    await waitFor(() => expect(state.shareStatsCalls).toBeGreaterThan(statsBefore));
    const stats = await screen.findByTestId("share-stats");
    expect(stats).toHaveTextContent(/1 share so far/i);
    expect(stats).toHaveTextContent(/Copy link: 1/);
  });
});

/**
 * UI coverage for Task #1458's web-vs-mobile reach split (Task #1782).
 *
 * The API change has unit-test coverage but the chip row that renders
 * "Where shares come from: Web N · Mobile N" did not. Without this
 * coverage a refactor to the privacy screen could silently drop the
 * breakdown from the visible UI even though the JSON payload still
 * carries it.
 */
describe("<PortalPrivacyPage /> — web vs mobile share-source chips (Task #1782)", () => {
  it("renders the source split chips with the bucket counts when bySource is present", async () => {
    state.total = 7;
    state.byMethodCopy = 7;
    state.bySource = { web: 5, mobile: 2 };

    render(<PortalPrivacyPage />);

    const split = await screen.findByTestId("share-source-split");
    expect(split).toBeInTheDocument();
    const web = screen.getByTestId("share-source-web");
    const mobile = screen.getByTestId("share-source-mobile");
    expect(web).toHaveTextContent(/Web\s*5/);
    expect(mobile).toHaveTextContent(/Mobile\s*2/);
  });

  it("hides the source split row when the share-stats payload omits bySource", async () => {
    // bySource left at null — server returns no `bySource` field at all,
    // mirroring legacy owners with only null-source share history.
    state.total = 3;
    state.byMethodCopy = 3;
    state.bySource = null;

    render(<PortalPrivacyPage />);

    // Wait for the stats block to render so we know the chip-row code
    // path executed and decided to skip rendering.
    expect(await screen.findByTestId("share-stats")).toBeInTheDocument();
    expect(screen.queryByTestId("share-source-split")).not.toBeInTheDocument();
    expect(screen.queryByTestId("share-source-web")).not.toBeInTheDocument();
    expect(screen.queryByTestId("share-source-mobile")).not.toBeInTheDocument();
  });

  it("hides the source split row when bySource is present but both buckets are 0", async () => {
    state.total = 4;
    state.byMethodCopy = 4;
    state.bySource = { web: 0, mobile: 0 };

    render(<PortalPrivacyPage />);

    expect(await screen.findByTestId("share-stats")).toBeInTheDocument();
    expect(screen.queryByTestId("share-source-split")).not.toBeInTheDocument();
  });

  it("updates the chip counts after a fresh share is logged", async () => {
    // Start with one mobile-tagged share already on file and no web-tagged
    // shares — the chip row should render with Web 0 / Mobile 1 first.
    state.total = 1;
    state.byMethodCopy = 1;
    state.bySource = { web: 0, mobile: 1 };

    render(<PortalPrivacyPage />);

    let web = await screen.findByTestId("share-source-web");
    let mobile = screen.getByTestId("share-source-mobile");
    expect(web).toHaveTextContent(/Web\s*0/);
    expect(mobile).toHaveTextContent(/Mobile\s*1/);

    // Trigger a fresh source="web" copy share. The mocked POST handler
    // bumps state.bySource.web, and the post-share stats refresh re-reads
    // the payload — the chip should reflect the new count.
    const copyBtn = await screen.findByTestId("share-copy");
    await userEvent.click(copyBtn);

    await waitFor(() => {
      web = screen.getByTestId("share-source-web");
      expect(web).toHaveTextContent(/Web\s*1/);
    });
    mobile = screen.getByTestId("share-source-mobile");
    expect(mobile).toHaveTextContent(/Mobile\s*1/);
  });
});
