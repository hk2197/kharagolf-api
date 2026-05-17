/**
 * Task #1860 — UI regression coverage for the coach `PayoutDetailModal`
 * bottom sheet that consumes `GET /coach/payouts/:id/requests`.
 *
 * The backend route itself is exercised by
 * `artifacts/api-server/src/tests/coach-payout-breakdown.test.ts`; this
 * test mirrors the same response shape from the mobile side so that
 * future changes to the modal's data plumbing or rendering can't
 * silently drop fields a coach relies on.
 *
 * Locks in:
 *   1. With multiple delivered review-request rows in the response,
 *      the sheet renders one card per request showing the member name,
 *      gross price (rupees), and the coach-share amount (rupees).
 *   2. When the API returns `requests: []`, the sheet shows the
 *      empty-state copy instead of an infinite spinner or a blank list.
 *
 * The modal is a private function inside `app/(tabs)/coach.tsx`, so we
 * drive it the same way the existing payout-breakdown tests do — by
 * rendering `CoachScreen`, opening the payout row, and then asserting
 * against the sheet's `testID`s.
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

// Mirrors the backend test's per-request shape so a regression on
// either side surfaces here.
const PAYOUT_REQUESTS_PAYLOAD = {
  sharePct: 80,
  requests: [
    {
      id: 501,
      memberName: "Asha Member",
      deliveredAt: "2026-02-15T10:00:00.000Z",
      pricePaise: 50_000, // ₹500
      coachSharePaise: 40_000, // ₹400 (80% of ₹500)
    },
    {
      id: 502,
      memberName: "Rahul Member",
      deliveredAt: "2026-02-20T10:00:00.000Z",
      pricePaise: 30_000, // ₹300
      coachSharePaise: 24_000, // ₹240 (80% of ₹300)
    },
  ],
};

type FetchMock = Mock<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>;
let fetchMock: FetchMock;

function makeFetchMock(payoutRequestsPayload: unknown): FetchMock {
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
    if (url.match(/\/api\/swing-reviews\/coach\/payouts\/\d+\/requests/)) {
      return jsonResponse(payoutRequestsPayload);
    }
    return jsonResponse({}, 200);
  });
}

beforeEach(() => {
  fetchMock = makeFetchMock(PAYOUT_REQUESTS_PAYLOAD);
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("<CoachScreen /> — payout breakdown sheet rows (Task #1860)", () => {
  it("renders one row per delivered review with member name, gross price, and coach share", async () => {
    await act(async () => {
      render(<CoachScreen />);
    });

    const payoutRow = await screen.findByTestId("payout-row-99-press");
    await act(async () => {
      fireEvent.click(payoutRow);
    });

    // Wait for the breakdown sheet to finish loading by querying for
    // the first request row by its stable testID.
    const firstRow = await screen.findByTestId("payout-detail-request-501");
    const secondRow = await screen.findByTestId("payout-detail-request-502");

    // Member names — surfaced from the API's `memberName` field.
    expect(screen.getByText("Asha Member")).toBeTruthy();
    expect(screen.getByText("Rahul Member")).toBeTruthy();

    // Gross prices (rupees, no decimals — matches `formatRupees`).
    // ₹500 for request 501, ₹300 for request 502.
    expect(firstRow.textContent ?? "").toContain("₹500");
    expect(secondRow.textContent ?? "").toContain("₹300");

    // Coach-share amounts per row.
    // 80% of ₹500 = ₹400, 80% of ₹300 = ₹240.
    expect(firstRow.textContent ?? "").toContain("Your share: ₹400");
    expect(secondRow.textContent ?? "").toContain("Your share: ₹240");

    // The header "Coach share: 80% of each review" reflects the API
    // sharePct so coaches understand how their share was derived.
    expect(screen.getByText(/Coach share:\s*80%\s*of each review/i)).toBeTruthy();

    // Confirm the empty-state copy is NOT shown when rows are present.
    expect(screen.queryByTestId("payout-detail-sheet-99-empty")).toBeNull();
  });

  it("renders the empty-state copy when the API returns `requests: []`", async () => {
    fetchMock = makeFetchMock({ sharePct: 80, requests: [] });
    vi.stubGlobal("fetch", fetchMock);

    await act(async () => {
      render(<CoachScreen />);
    });

    const payoutRow = await screen.findByTestId("payout-row-99-press");
    await act(async () => {
      fireEvent.click(payoutRow);
    });

    const empty = await screen.findByTestId("payout-detail-sheet-99-empty");
    expect(empty.textContent ?? "").toMatch(/No reviews are linked to this payout yet/i);

    // And no per-request rows are rendered.
    expect(screen.queryByTestId("payout-detail-request-501")).toBeNull();
    expect(screen.queryByTestId("payout-detail-request-502")).toBeNull();
  });
});
