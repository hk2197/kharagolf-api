/**
 * Task #1512 — UI test for the "Open review" path that lets a coach jump
 * from the payout breakdown sheet straight into the existing swing-review
 * detail modal. Locks in two contracts:
 *   1. Tapping a review row in the breakdown fetches the review detail
 *      and renders the existing review viewer (member's display name from
 *      the request payload appears).
 *   2. When the review's annotation has been deleted, the viewer shows
 *      the explicit "no longer available" fallback instead of crashing
 *      or silently hiding the section.
 */
import React from "react";
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

vi.mock("expo-router", () => ({
  router: { push: vi.fn(), back: vi.fn(), replace: vi.fn() },
  useLocalSearchParams: () => ({ tab: "coach" }),
}));

vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock("@/context/auth", () => ({
  useAuth: () => ({
    token: "test-token",
    user: {
      id: 1,
      username: "coach",
      role: "coach",
      displayName: "Coach Carter",
      email: "c@example.com",
    },
    isAuthenticated: true,
    isLoading: false,
  }),
}));

vi.mock("expo-camera", () => ({
  CameraView: () => null,
  useCameraPermissions: () => [
    { granted: true },
    () => Promise.resolve({ granted: true }),
  ],
}));
vi.mock("expo-av", () => ({
  Video: () => null,
  ResizeMode: { CONTAIN: "contain", COVER: "cover", STRETCH: "stretch" },
  Audio: {
    Sound: class {
      static createAsync = vi.fn(async () => ({
        sound: {
          unloadAsync: vi.fn(async () => {}),
          pauseAsync: vi.fn(async () => {}),
          playAsync: vi.fn(async () => {}),
          setPositionAsync: vi.fn(async () => {}),
          getStatusAsync: vi.fn(async () => ({
            isLoaded: true,
            positionMillis: 0,
            isPlaying: false,
          })),
        },
      }));
    },
    setAudioModeAsync: vi.fn(async () => {}),
  },
}));
vi.mock("expo-image-picker", () => ({
  launchImageLibraryAsync: vi.fn(),
  requestMediaLibraryPermissionsAsync: vi.fn(),
  MediaTypeOptions: { Videos: "Videos", Images: "Images" },
}));
vi.mock("expo-file-system/legacy", () => ({
  getInfoAsync: vi.fn(),
  readAsStringAsync: vi.fn(),
  uploadAsync: vi.fn(),
  EncodingType: { Base64: "base64", UTF8: "utf8" },
  FileSystemUploadType: { BINARY_CONTENT: 0, MULTIPART: 1 },
}));
vi.mock("react-native-svg", () => {
  const Stub = ({ children }: { children?: React.ReactNode }) => children ?? null;
  return {
    default: Stub,
    Svg: Stub,
    Line: Stub,
    Circle: Stub,
    Polyline: Stub,
    Path: Stub,
    Rect: Stub,
  };
});

import CoachScreen from "../app/(tabs)/coach";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const COACH_PROFILE_PAYLOAD = {
  pro: {
    id: 1,
    organizationId: 1,
    organizationName: "Kharagpur GC",
    displayName: "Coach Carter",
  },
  profile: {
    payoutMethod: "upi",
    payoutAccountId: "fa_123",
    payoutAccountHolderName: "Coach Carter",
    payoutVerificationStatus: "verified",
  },
};

const EARNINGS_PAYLOAD = {
  summary: { lifetimeEarningsPaise: 50_000, pendingPayoutPaise: 0, unpaidCount: 0 },
  sharePct: 70,
  payouts: [
    {
      id: 99,
      status: "paid",
      netPayoutPaise: 25_000,
      periodStart: "2026-02-01",
      periodEnd: "2026-02-28",
      payoutReference: "PAY-OPEN",
      paidAt: "2026-03-02T10:00:00.000Z",
    },
  ],
};

const PAYOUT_REQUESTS_PAYLOAD = {
  sharePct: 70,
  requests: [
    {
      id: 501,
      memberName: "Asha Member",
      deliveredAt: "2026-02-15T10:00:00.000Z",
      pricePaise: 30_000,
      coachSharePaise: 21_000,
    },
    {
      id: 502,
      memberName: "Rahul Member",
      deliveredAt: "2026-02-20T10:00:00.000Z",
      pricePaise: 20_000,
      coachSharePaise: 14_000,
    },
  ],
};

type FetchMock = Mock<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>;
let fetchMock: FetchMock;

function makeFetchMock(detailHandler: (id: number) => unknown): FetchMock {
  return vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/api/coach-marketplace/me/coach-profile")) {
      return jsonResponse(COACH_PROFILE_PAYLOAD);
    }
    if (url.includes("/api/swing-reviews/coach/queue")) {
      return jsonResponse({ queue: [] });
    }
    if (url.includes("/api/swing-reviews/coach/earnings")) {
      return jsonResponse(EARNINGS_PAYLOAD);
    }
    if (url.includes("/api/coach-marketplace/me/payout-account/history")) {
      return jsonResponse({ history: [] });
    }
    const payoutRequestsMatch = url.match(/\/api\/swing-reviews\/coach\/payouts\/(\d+)\/requests/);
    if (payoutRequestsMatch) {
      return jsonResponse(PAYOUT_REQUESTS_PAYLOAD);
    }
    const requestDetailMatch = url.match(/\/api\/swing-reviews\/requests\/(\d+)$/);
    if (requestDetailMatch) {
      const id = Number(requestDetailMatch[1]);
      return jsonResponse(detailHandler(id));
    }
    return jsonResponse({}, 200);
  });
}

beforeEach(() => {
  fetchMock = makeFetchMock((id) => ({
    request: {
      id,
      status: "delivered",
      pricePaise: 30_000,
      annotationId: 9001,
      rating: null,
      memberPrompt: null,
    },
    video: { id: 700, videoUrl: "/uploads/vid.mp4", fps: 60 },
    annotation: {
      id: 9001,
      textNotes: "Solid hip rotation — great work!",
      drawings: [],
      voiceOverUrl: null,
      voiceOverDurationSeconds: null,
    },
    pro: { id: 1, displayName: "Coach Carter", photoUrl: null },
    // Task #1861 — server tags the response so the viewer can hide the
    // member-only rating prompt for non-owners.
    viewerRole: "coach",
  }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("<CoachScreen /> — payout breakdown opens review detail (Task #1512)", () => {
  it("opens the existing review viewer when a row in the payout sheet is tapped", async () => {
    await act(async () => {
      render(<CoachScreen />);
    });

    const payoutRow = await screen.findByTestId("payout-row-99-press");
    await act(async () => {
      fireEvent.click(payoutRow);
    });

    const reviewRow = await screen.findByTestId("payout-detail-request-501");
    await act(async () => {
      fireEvent.click(reviewRow);
    });

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([input]) => {
          const url = typeof input === "string" ? input : input!.toString();
          return url.endsWith("/api/swing-reviews/requests/501");
        }),
      ).toBe(true);
    });

    // The existing RequestDetailModalInner renders the coach's display
    // name as the modal title and the annotation text-notes block.
    await screen.findByText("Solid hip rotation — great work!");
  });

  it("shows the annotation-missing fallback when the review's notes have been deleted", async () => {
    fetchMock = makeFetchMock((id) => ({
      request: {
        id,
        status: "delivered",
        pricePaise: 30_000,
        annotationId: null,
        rating: null,
        memberPrompt: null,
      },
      video: { id: 700, videoUrl: "/uploads/vid.mp4", fps: 60 },
      annotation: null,
      pro: { id: 1, displayName: "Coach Carter", photoUrl: null },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await act(async () => {
      render(<CoachScreen />);
    });

    const payoutRow = await screen.findByTestId("payout-row-99-press");
    await act(async () => {
      fireEvent.click(payoutRow);
    });

    const reviewRow = await screen.findByTestId("payout-detail-request-502");
    await act(async () => {
      fireEvent.click(reviewRow);
    });

    const missing = await screen.findByTestId("request-detail-502-annotation-missing");
    expect(missing.textContent ?? "").toMatch(/no longer available/i);
  });

  it("opens a refunded review's detail modal so coaches can revisit refunded line items", async () => {
    fetchMock = makeFetchMock((id) => ({
      request: {
        id,
        status: "refunded",
        pricePaise: 30_000,
        annotationId: 9001,
        rating: null,
        memberPrompt: null,
      },
      video: { id: 700, videoUrl: "/uploads/vid.mp4", fps: 60 },
      annotation: {
        id: 9001,
        textNotes: "Refunded session — original notes preserved.",
        drawings: [],
        voiceOverUrl: null,
        voiceOverDurationSeconds: null,
      },
      pro: { id: 1, displayName: "Coach Carter", photoUrl: null },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await act(async () => {
      render(<CoachScreen />);
    });

    const payoutRow = await screen.findByTestId("payout-row-99-press");
    await act(async () => {
      fireEvent.click(payoutRow);
    });

    const reviewRow = await screen.findByTestId("payout-detail-request-501");
    await act(async () => {
      fireEvent.click(reviewRow);
    });

    // The detail modal renders the annotation text-notes from the
    // refunded request — proves both that (a) the row tap routed by id
    // (status-agnostic) and (b) the annotation block still renders for
    // refunded reviews that retained their notes.
    await screen.findByText("Refunded session — original notes preserved.");
    // And the status label shows the refunded state inside the same
    // modal (via statusLabel("refunded") → "Refunded").
    const statusMatches = await screen.findAllByText(/^Refunded$/);
    expect(statusMatches.length).toBeGreaterThan(0);
  });

  // Task #1861 — coaches now reach the review viewer via the payout
  // breakdown sheet, but the bottom-of-modal "Rate this review" 5-star
  // form is member-only. Lock in that the prompt is suppressed when the
  // server tags the viewer as a coach (the /rate endpoint already
  // rejects them; the form should not have been visible in the first
  // place).
  it("hides the member-only 'Rate this review' prompt when the coach opens an unrated delivered review", async () => {
    await act(async () => {
      render(<CoachScreen />);
    });

    const payoutRow = await screen.findByTestId("payout-row-99-press");
    await act(async () => {
      fireEvent.click(payoutRow);
    });

    const reviewRow = await screen.findByTestId("payout-detail-request-501");
    await act(async () => {
      fireEvent.click(reviewRow);
    });

    // Detail loaded (annotation text rendered).
    await screen.findByText("Solid hip rotation — great work!");

    // The member-facing rating prompt and its submit button must be absent.
    expect(screen.queryByText("Rate this review")).toBeNull();
    expect(screen.queryByText("Submit Rating")).toBeNull();
  });

  it("shows a read-only 'Member rating' summary when a coach views a review the member has already rated", async () => {
    fetchMock = makeFetchMock((id) => ({
      request: {
        id,
        status: "delivered",
        pricePaise: 30_000,
        annotationId: 9001,
        rating: 4,
        ratingComment: "Really helped my takeaway.",
        memberPrompt: null,
      },
      video: { id: 700, videoUrl: "/uploads/vid.mp4", fps: 60 },
      annotation: {
        id: 9001,
        textNotes: "Solid hip rotation — great work!",
        drawings: [],
        voiceOverUrl: null,
        voiceOverDurationSeconds: null,
      },
      pro: { id: 1, displayName: "Coach Carter", photoUrl: null },
      viewerRole: "coach",
    }));
    vi.stubGlobal("fetch", fetchMock);

    await act(async () => {
      render(<CoachScreen />);
    });

    const payoutRow = await screen.findByTestId("payout-row-99-press");
    await act(async () => {
      fireEvent.click(payoutRow);
    });

    const reviewRow = await screen.findByTestId("payout-detail-request-501");
    await act(async () => {
      fireEvent.click(reviewRow);
    });

    // Coach-facing summary header (NOT "You rated this review") and the
    // member's comment are both shown.
    await screen.findByText("Member rating");
    expect(screen.queryByText("You rated this review")).toBeNull();
    const comment = await screen.findByTestId("request-detail-501-rating-comment");
    expect(comment.textContent ?? "").toMatch(/Really helped my takeaway/);
  });

  it("falls back to a friendly message when the review itself can no longer be loaded", async () => {
    fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/coach-marketplace/me/coach-profile")) {
        return jsonResponse(COACH_PROFILE_PAYLOAD);
      }
      if (url.includes("/api/swing-reviews/coach/queue")) {
        return jsonResponse({ queue: [] });
      }
      if (url.includes("/api/swing-reviews/coach/earnings")) {
        return jsonResponse(EARNINGS_PAYLOAD);
      }
      if (url.includes("/api/coach-marketplace/me/payout-account/history")) {
        return jsonResponse({ history: [] });
      }
      if (url.match(/\/api\/swing-reviews\/coach\/payouts\/\d+\/requests/)) {
        return jsonResponse(PAYOUT_REQUESTS_PAYLOAD);
      }
      if (url.match(/\/api\/swing-reviews\/requests\/\d+$/)) {
        return jsonResponse({ error: "Not found" }, 404);
      }
      return jsonResponse({}, 200);
    });
    vi.stubGlobal("fetch", fetchMock);

    await act(async () => {
      render(<CoachScreen />);
    });

    const payoutRow = await screen.findByTestId("payout-row-99-press");
    await act(async () => {
      fireEvent.click(payoutRow);
    });

    const reviewRow = await screen.findByTestId("payout-detail-request-501");
    await act(async () => {
      fireEvent.click(reviewRow);
    });

    const unavailable = await screen.findByTestId("request-detail-501-unavailable");
    expect(unavailable.textContent ?? "").toMatch(/no longer available/i);
  });
});
