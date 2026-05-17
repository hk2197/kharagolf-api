/**
 * Unit tests for the mobile SponsorSplash:
 *   - shows the fullscreen overlay (Skip button visible) once a creative loads
 *   - auto-dismisses after the slot's rotationSeconds and hides the overlay
 *   - dismisses immediately when the delivery is empty (frequency-cap exhausted)
 */
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, act, fireEvent } from "@testing-library/react";

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => {}),
  },
}));

const useActiveClubMock = vi.fn(() => ({
  activeOrgId: 4 as number | null,
  activeClub: null,
  clubs: [],
  switchClub: async () => {},
  isSuperAdmin: false,
  canSwitchClub: false,
}));
vi.mock("@/context/activeClub", () => ({
  useActiveClub: () => useActiveClubMock(),
}));

vi.mock("react-native", async () => {
  const actual = await vi.importActual<typeof import("react-native")>("react-native");
  return {
    ...actual,
    Linking: { ...actual.Linking, openURL: vi.fn(async () => true) },
    BackHandler: {
      addEventListener: vi.fn(() => ({ remove: vi.fn() })),
      removeEventListener: vi.fn(),
    },
  };
});

import SponsorSplash from "../components/SponsorSplash";
import type { AdDelivery } from "../components/AdSlot";

let deliveryQueue: Array<AdDelivery | null>;

function imageDelivery(rotationSeconds = 4): AdDelivery {
  return {
    slot: { id: 1, slotKey: "mobile_splash", rotationSeconds },
    campaign: { id: 10, weight: 1 },
    sponsor: { id: 50, name: "Splash Co", logoUrl: null, websiteUrl: "https://splash.example" },
    creative: {
      id: 500,
      name: "Splash Creative",
      mediaType: "image",
      mediaUrl: "https://cdn.example/splash.png",
      clickThroughUrl: "https://splash.example/promo",
      headline: null,
      subheadline: null,
    },
  };
}

function installFetch() {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/api/public/ad-slot/")) {
      const body = deliveryQueue.length ? deliveryQueue.shift()! : null;
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("{}", { status: 200 });
  }));
}

beforeEach(() => {
  deliveryQueue = [];
  installFetch();
  useActiveClubMock.mockReturnValue({
    activeOrgId: 4,
    activeClub: null,
    clubs: [],
    switchClub: async () => {},
    isSuperAdmin: false,
    canSwitchClub: false,
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("<SponsorSplash />", () => {
  it("renders nothing when no club is active", () => {
    useActiveClubMock.mockReturnValue({
      activeOrgId: null,
      activeClub: null,
      clubs: [],
      switchClub: async () => {},
      isSuperAdmin: false,
      canSwitchClub: false,
    });
    const { container } = render(<SponsorSplash />);
    expect(container.firstChild).toBeNull();
  });

  it("shows the splash with Skip when a creative is delivered", async () => {
    deliveryQueue.push(imageDelivery(4));

    render(<SponsorSplash />);

    // The image creative renders inside AdSlot
    expect(await screen.findByLabelText("Splash Creative")).toBeInTheDocument();
    // The Skip button only appears once `shown` becomes true (after onLoaded)
    expect(await screen.findByText("Skip")).toBeInTheDocument();
  });

  it("auto-dismisses after rotationSeconds", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    deliveryQueue.push(imageDelivery(3));

    render(<SponsorSplash />);

    await screen.findByText("Skip");

    await act(async () => {
      vi.advanceTimersByTime(3_000);
    });

    await waitFor(() => expect(screen.queryByText("Skip")).toBeNull());
    expect(screen.queryByLabelText("Splash Creative")).toBeNull();
  });

  it("dismisses immediately when the delivery is empty", async () => {
    deliveryQueue.push(null);

    const { container } = render(<SponsorSplash />);

    // After the empty delivery resolves, SponsorSplash returns null
    await waitFor(() => expect(container.firstChild).toBeNull());
    expect(screen.queryByText("Skip")).toBeNull();
  });

  it("dismisses when the user taps Skip", async () => {
    deliveryQueue.push(imageDelivery(60));

    render(<SponsorSplash />);

    const skip = await screen.findByText("Skip");
    fireEvent.click(skip);

    await waitFor(() => expect(screen.queryByText("Skip")).toBeNull());
  });
});
