/**
 * Task #1220 — UI coverage for the mobile coach payout re-verification
 * banner inside the `PayoutAccountCard` (app/(tabs)/coach.tsx). Task #1061
 * introduced the banner without any automated coverage; a regression
 * could silently leave coaches unaware that their saved payout details
 * stopped re-verifying and that payouts are now paused.
 *
 * The banner reads `profile.payoutVerificationStatus === "needs_attention"`
 * and surfaces:
 *   - the upstream failure reason (`profile.payoutVerificationFailureReason`)
 *   - a `button-payout-needs-attention-fix` CTA that flips the card into
 *     edit mode so the coach can re-verify on the spot.
 *
 * Mirrors the web coverage in
 * artifacts/kharagolf-web/src/tests/coach-workspace.test.tsx
 * (Task #1220 describe block).
 */
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

// Heavy native modules that the (tabs)/coach.tsx module pulls in at the
// top of file. None of these are exercised by PayoutAccountCard itself,
// but they have to resolve to *something* so the import does not throw
// under jsdom + react-native-web.
vi.mock("expo-camera", () => ({
  CameraView: () => null,
  useCameraPermissions: () => [{ granted: true }, async () => ({ granted: true })],
}));

vi.mock("expo-av", () => ({
  Video: () => null,
  ResizeMode: { COVER: "cover", CONTAIN: "contain" },
  Audio: { Sound: class {} },
}));

vi.mock("expo-image-picker", () => ({
  launchImageLibraryAsync: async () => ({ canceled: true }),
  launchCameraAsync: async () => ({ canceled: true }),
  MediaTypeOptions: { Images: "Images", Videos: "Videos", All: "All" },
  requestCameraPermissionsAsync: async () => ({ granted: true }),
  requestMediaLibraryPermissionsAsync: async () => ({ granted: true }),
}));

vi.mock("expo-file-system/legacy", () => ({
  documentDirectory: "file:///documents/",
  cacheDirectory: "file:///cache/",
  getInfoAsync: async () => ({ exists: false }),
  downloadAsync: async () => ({ uri: "" }),
  deleteAsync: async () => {},
  uploadAsync: async () => ({ status: 200, body: "{}" }),
  FileSystemUploadType: { BINARY_CONTENT: 0 },
}));

vi.mock("react-native-svg", () => {
  const ReactInner = require("react") as typeof React;
  const passthrough = (tag: string) =>
    ReactInner.forwardRef<Element, { children?: React.ReactNode }>(({ children, ...rest }, ref) =>
      ReactInner.createElement(tag, { ...rest, ref }, children),
    );
  const Svg = passthrough("svg");
  return {
    __esModule: true,
    default: Svg,
    Svg,
    Line: passthrough("line"),
    Circle: passthrough("circle"),
    Polyline: passthrough("polyline"),
    Path: passthrough("path"),
    Rect: passthrough("rect"),
  };
});

vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock("@/context/auth", () => ({
  useAuth: () => ({
    token: "test-token",
    user: { id: 42, organizationId: 9 },
    isAuthenticated: true,
    isLoading: false,
  }),
}));

vi.mock("@/utils/api", () => ({
  BASE_URL: "",
}));

import { PayoutAccountCard } from "../app/(tabs)/coach";

const baseProfile = {
  payoutMethod: "upi",
  payoutAccountId: "fa_existing",
  payoutAccountHolderName: "Test Coach",
  payoutVpa: "test@bank",
  payoutBankAccountNumber: null,
  payoutBankIfsc: null,
  payoutVerificationStatus: null as string | null,
  payoutVerificationFailureReason: null as string | null,
};

beforeEach(() => {
  // PayoutAccountCard fires GET /payout-account/history on mount via the
  // useEffect / loadHistory pair; stub it so the card renders cleanly
  // without an unhandled-rejection from `fetch` being undefined.
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/coach-marketplace/me/payout-account/history")) {
        return new Response(JSON.stringify({ history: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch,
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("PayoutAccountCard payout re-verification banner (Task #1220)", () => {
  it("renders the banner with the failure reason and opens the editor when the CTA is pressed", async () => {
    const reload = vi.fn();
    render(
      <PayoutAccountCard
        profile={{
          ...baseProfile,
          payoutVerificationStatus: "needs_attention",
          payoutVerificationFailureReason: "VPA inactive at upstream bank",
        }}
        token="test-token"
        reload={reload}
      />,
    );

    const banner = await screen.findByTestId("banner-payout-needs-attention");
    expect(banner).toBeInTheDocument();
    expect(banner.textContent ?? "").toMatch(/Your payout account needs re-verification/i);
    expect(banner.textContent ?? "").toMatch(/VPA inactive at upstream bank/);

    // The inline editor (its "Verify account" submit button and the
    // account-holder text input) is gated by `editing === true`; it
    // must not be rendered yet.
    expect(screen.queryByText(/^Verify account$/)).toBeNull();
    expect(
      screen.queryByPlaceholderText(/Account holder name/i),
    ).toBeNull();

    const cta = screen.getByTestId("button-payout-needs-attention-fix");
    fireEvent.click(cta);

    // Editor opens — the verify submit button + the holder placeholder
    // appear, and the banner CTA is removed (the `!editing && ...` guard
    // hides it once the coach is editing).
    await waitFor(() => {
      expect(screen.getByText(/^Verify account$/)).toBeInTheDocument();
    });
    expect(screen.getByPlaceholderText(/Account holder name/i)).toBeInTheDocument();
    expect(screen.queryByTestId("button-payout-needs-attention-fix")).toBeNull();
  });

  it("does not render the banner when the payout verification status is verified", async () => {
    const reload = vi.fn();
    render(
      <PayoutAccountCard
        profile={{
          ...baseProfile,
          payoutVerificationStatus: "verified",
          payoutVerificationFailureReason: null,
        }}
        token="test-token"
        reload={reload}
      />,
    );

    // Wait for the card to mount fully — the "Update" Pressable only
    // renders once the card has its profile and is in the non-editing
    // initial state, which makes this assertion meaningful (i.e. not
    // racing against an empty render).
    await waitFor(() => {
      expect(screen.getByText(/^Update$/)).toBeInTheDocument();
    });

    expect(screen.queryByTestId("banner-payout-needs-attention")).toBeNull();
    expect(screen.queryByTestId("button-payout-needs-attention-fix")).toBeNull();
  });
});
