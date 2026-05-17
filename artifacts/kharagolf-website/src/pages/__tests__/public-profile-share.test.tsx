/**
 * Task #781 — UI coverage for the public profile Share button on /p/<handle>.
 *
 * Verifies the ShareProfileSection block:
 *   - The share controls render once the profile loads.
 *   - "Copy link" writes the canonical profile URL to the clipboard and
 *     toggles to a "Copied!" confirmation.
 *   - The QR toggle reveals/hides the QR panel and renders the generated
 *     QR image once the qrcode library resolves.
 *   - The native Share button only renders when navigator.share is defined,
 *     and triggering it calls navigator.share with the expected payload.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { Router as WouterRouter } from "wouter";
import { memoryLocation } from "wouter/memory-location";

vi.mock("qrcode", () => ({
  default: {
    toDataURL: vi.fn(async () => "data:image/png;base64,QRSTUB"),
  },
}));

import QRCode from "qrcode";
import PublicProfilePage from "../public-profile";

const HANDLE = "tigerw";

const buildProfilePayload = () => ({
  handle: HANDLE,
  displayName: "Tiger W",
  profileImage: null,
  bio: null,
  location: null,
  homeClub: null,
  memberSince: "2020-01-01T00:00:00.000Z",
  privacy: {
    showHandicap: false,
    showRecentRounds: false,
    showAchievements: false,
    showFavoriteCourses: false,
  },
  currentHandicap: null,
  handicapJourney: [],
  recentRounds: [],
  achievements: [],
  badgeCatalog: [],
  badgeProgress: {},
  favoriteCourses: [],
  deepLinks: { web: "https://example.com/web", mobile: "kharagolf://p/tigerw" },
});

function renderProfilePage() {
  const { hook } = memoryLocation({ path: `/p/${HANDLE}` });
  return render(
    <WouterRouter hook={hook}>
      <PublicProfilePage />
    </WouterRouter>,
  );
}

let shareStatsTotal = 5;
let shareStatsCalls = 0;

beforeEach(() => {
  shareStatsTotal = 5;
  shareStatsCalls = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === `/api/public/p/${HANDLE}`) {
        return new Response(JSON.stringify(buildProfilePayload()), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === `/api/public/p/${HANDLE}/share-stats`) {
        shareStatsCalls += 1;
        return new Response(JSON.stringify({ handle: HANDLE, total: shareStatsTotal }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: "unexpected" }), { status: 404 });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  // Remove navigator.share between tests so each test sets it explicitly.
  // happy-dom lets us delete optional navigator props.
  try { delete (navigator as unknown as { share?: unknown }).share; } catch { /* ignore */ }
});

describe("ShareProfileSection on /p/<handle>", () => {
  it("renders the share controls once the profile loads", async () => {
    renderProfilePage();
    expect(await screen.findByTestId("share-profile-section")).toBeInTheDocument();
    expect(screen.getByTestId("share-copy")).toBeInTheDocument();
    expect(screen.getByTestId("share-qr-toggle")).toBeInTheDocument();
  });

  it("copies the canonical profile URL to the clipboard when Copy link is clicked", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    renderProfilePage();
    const copyBtn = await screen.findByTestId("share-copy");
    fireEvent.click(copyBtn);

    const expectedUrl = `${window.location.origin}/p/${HANDLE}`;
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(expectedUrl);
    });
    // Button flips to "Copied!" confirmation.
    await waitFor(() => {
      expect(screen.getByTestId("share-copy")).toHaveTextContent(/Copied!/i);
    });
  });

  it("toggles the QR panel and renders the generated QR image", async () => {
    renderProfilePage();
    const toggle = await screen.findByTestId("share-qr-toggle");

    expect(screen.queryByTestId("share-qr-panel")).not.toBeInTheDocument();

    fireEvent.click(toggle);

    const panel = await screen.findByTestId("share-qr-panel");
    expect(panel).toBeInTheDocument();
    const img = await screen.findByTestId("share-qr-image");
    expect(img).toHaveAttribute("src", "data:image/png;base64,QRSTUB");
    expect(QRCode.toDataURL).toHaveBeenCalledWith(
      `${window.location.origin}/p/${HANDLE}`,
      expect.any(Object),
    );

    fireEvent.click(toggle);
    await waitFor(() => {
      expect(screen.queryByTestId("share-qr-panel")).not.toBeInTheDocument();
    });
  });

  it("hides the native Share button when navigator.share is not available", async () => {
    // Ensure navigator.share is not defined for this test.
    try { delete (navigator as unknown as { share?: unknown }).share; } catch { /* ignore */ }
    renderProfilePage();
    await screen.findByTestId("share-profile-section");
    expect(screen.queryByTestId("share-native")).not.toBeInTheDocument();
  });

  it("renders the native Share button when navigator.share exists and invokes it on click", async () => {
    const shareMock = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "share", {
      configurable: true,
      writable: true,
      value: shareMock,
    });

    renderProfilePage();
    const nativeBtn = await screen.findByTestId("share-native");
    fireEvent.click(nativeBtn);

    await waitFor(() => {
      expect(shareMock).toHaveBeenCalledTimes(1);
    });
    const calls = shareMock.mock.calls as unknown as Array<Array<{ url: string; title: string; text: string }>>;
    const arg = calls[0]![0]!;
    expect(arg.url).toBe(`${window.location.origin}/p/${HANDLE}`);
    expect(arg.title).toContain("Tiger W");
    expect(arg.title).toContain(HANDLE);
  });

  it("re-fetches the share count badge after a successful copy (Task #1082)", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    renderProfilePage();
    // Initial mount fetch lands the social-proof badge with 5 shares.
    const badge = await screen.findByTestId("share-count-badge");
    expect(badge).toHaveTextContent(/Shared 5 times/i);
    expect(shareStatsCalls).toBe(1);

    // Server count grows behind our back; clicking copy should re-fetch.
    shareStatsTotal = 9;

    fireEvent.click(screen.getByTestId("share-copy"));
    await waitFor(() => expect(writeText).toHaveBeenCalled());

    // Optimistic bump shows the +1 immediately (5 → 6) before the refetch.
    await waitFor(() => {
      expect(screen.getByTestId("share-count-badge")).toHaveTextContent(/Shared 6 times/i);
    });

    // Then the delayed refetch fires and reconciles to the server's value.
    await waitFor(() => {
      expect(shareStatsCalls).toBeGreaterThanOrEqual(2);
    }, { timeout: 2000 });
    await waitFor(() => {
      expect(screen.getByTestId("share-count-badge")).toHaveTextContent(/Shared 9 times/i);
    }, { timeout: 2000 });
  });
});
