/**
 * Task #636 — mobile interaction coverage for the per-hole verify tap
 * added in Task #483 (`handleVerifyHole` in app/(tabs)/marker.tsx).
 *
 * Walks the marker through the real review-modal flow and proves:
 *   1. Tapping the amber "awaiting marker" row on hole 1 shows the
 *      confirm dialog and, when confirmed, POSTs to the new endpoint
 *        POST /api/portal/submissions/:id/scores/:hole/verify
 *   2. After the endpoint resolves, the local awaiting count on the
 *      inbox card decrements (1 → 0) — proving the optimistic update
 *      runs without needing a refresh.
 */
import React, { type ReactNode } from "react";
import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
  type Mock,
} from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

// ── Module mocks (must come BEFORE the screen import) ──────────────────────

vi.mock("react-native-safe-area-context", () => {
  const ReactInner = require("react") as typeof React;
  return {
    SafeAreaView: ({ children }: { children?: ReactNode }) =>
      ReactInner.createElement("div", null, children),
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  };
});

const { alertMock } = vi.hoisted(() => ({
  alertMock: vi.fn<(
    title: string,
    message?: string,
    buttons?: Array<{ text: string; onPress?: () => void; style?: string }>,
  ) => void>(),
}));
vi.mock("react-native", async () => {
  const RN = await vi.importActual<typeof import("react-native")>("react-native");
  return { ...RN, Alert: { alert: alertMock } };
});

vi.mock("@/context/auth", () => ({
  useAuth: () => ({
    token: "test-token",
    user: { id: 99, username: "marker", role: "player" },
    isAuthenticated: true,
    isLoading: false,
  }),
}));

// ── Imports under test (after mocks) ───────────────────────────────────────
import MarkerScreen from "../app/(tabs)/marker";

// ── Test fixtures ──────────────────────────────────────────────────────────

const SUBMISSION_ID = 7777;
const TOURNAMENT_ID = 555;

interface FakeTournamentPending {
  submissionId: number;
  playerName: string;
  tournamentName: string;
  tournamentId: number;
  round: number;
  totalStrokes: number | null;
  submittedAt: string;
  awaitingMarkerCount: number;
  scores: Array<{ hole: number; strokes: number; awaitingMarker: boolean; isVerified: boolean }>;
}

function pendingFixture(): FakeTournamentPending {
  return {
    submissionId: SUBMISSION_ID,
    playerName: "Pat Player",
    tournamentName: "Spring Open",
    tournamentId: TOURNAMENT_ID,
    round: 1,
    totalStrokes: 12,
    submittedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    awaitingMarkerCount: 1,
    scores: [
      // Only hole 1 is awaiting — the rest are already verified. The
      // tap-to-verify wrapper renders only on rows where awaitingMarker is
      // true, so this gives us exactly one tappable row.
      { hole: 1, strokes: 4, awaitingMarker: true, isVerified: false },
      { hole: 2, strokes: 5, awaitingMarker: false, isVerified: true },
      { hole: 3, strokes: 3, awaitingMarker: false, isVerified: true },
    ],
  };
}

let pending: FakeTournamentPending;

type FetchMock = Mock<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>;
let fetchMock: FetchMock;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  pending = pendingFixture();
  alertMock.mockReset();
  // Auto-confirm: when the screen shows the "Confirm hole N" dialog,
  // immediately invoke the "Confirm" button's onPress.
  alertMock.mockImplementation((_title, _message, buttons) => {
    const confirmBtn = buttons?.find((b) => b.text === "Confirm");
    confirmBtn?.onPress?.();
  });

  fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/api/portal/general-play/pending-marker")) {
      return jsonResponse([]);
    }
    if (url.endsWith("/api/portal/pending-submissions")) {
      return jsonResponse([pending]);
    }
    if (url.includes(`/api/public/tournaments/${TOURNAMENT_ID}/holes`)) {
      // Empty hole metadata is fine — the per-hole verify row is rendered
      // from selectedItem.scores, not from this list.
      return jsonResponse([]);
    }
    if (url.endsWith(`/api/portal/submissions/${SUBMISSION_ID}/scores/1/verify`)) {
      return jsonResponse({ ok: true, holeNumber: 1, verified: true });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as unknown as FetchMock;

  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("MarkerScreen — tap-to-verify a single hole (Task #483 / #636)", () => {
  it("posts to the per-hole verify endpoint and decrements the awaiting count", async () => {
    render(<MarkerScreen />);

    // Inbox card renders with the partial-awaiting indicator.
    await screen.findByText("Pat Player");
    expect(screen.getByText("1 hole need confirmation")).toBeInTheDocument();

    // Open the review modal by tapping the card.
    await act(async () => {
      fireEvent.click(screen.getByText("Pat Player"));
    });

    // Wait for the holes list inside the modal to render. The awaiting row
    // has an accessibilityLabel of "Confirm hole 1" — react-native-web maps
    // accessibilityLabel → aria-label, so we can locate it that way.
    const confirmRow = await waitFor(() => {
      const el = document.querySelector('[aria-label="Confirm hole 1"]');
      if (!el) throw new Error("Confirm hole 1 row not yet rendered");
      return el as HTMLElement;
    });
    expect(confirmRow).toBeInTheDocument();

    // Tap the awaiting row → Alert.alert fires → our mock auto-presses
    // "Confirm" → handleVerifyHole posts to the new endpoint.
    await act(async () => {
      fireEvent.click(confirmRow);
    });

    // The screen should have invoked Alert.alert with the per-hole prompt.
    expect(alertMock).toHaveBeenCalled();
    const firstCall = alertMock.mock.calls[0];
    expect(String(firstCall[0])).toMatch(/Confirm hole 1/i);

    // The new endpoint must have been hit with method POST and the auth header.
    await waitFor(() => {
      const verifyCall = fetchMock.mock.calls.find(([url]) =>
        String(url).endsWith(`/api/portal/submissions/${SUBMISSION_ID}/scores/1/verify`),
      );
      expect(verifyCall).toBeDefined();
      const init = verifyCall?.[1] as RequestInit | undefined;
      expect(init?.method).toBe("POST");
      const headers = (init?.headers ?? {}) as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer test-token");
    });

    // After the verify resolves, the optimistic update on the modal +
    // inbox card should drop the awaiting count from 1 to 0 — the
    // "1 hole need confirmation" badge must disappear.
    await waitFor(() => {
      expect(screen.queryByText(/hole.* need confirmation/i)).toBeNull();
    });
  });
});
