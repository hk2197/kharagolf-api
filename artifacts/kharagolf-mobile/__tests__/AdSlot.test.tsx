/**
 * Unit tests for the mobile AdSlot:
 *   - fetches a delivery from the public ad-slot endpoint with sessionId/tournamentId
 *   - logs an `impression` event with the right payload when a creative renders
 *   - logs a `click` event with the right payload on press, and only when the creative
 *     has a click-through URL (so the no-href case is a no-op, not a CTR-inflating beacon)
 *   - rotates by re-fetching after `slot.rotationSeconds`
 *   - renders nothing for video creatives (mobile slot is image-only)
 *   - signals onLoaded for renderable deliveries and onEmpty otherwise
 */
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { fireEvent, render, screen, waitFor, act } from "@testing-library/react";

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => {}),
  },
}));

// Mock Linking.openURL so a click doesn't actually try to navigate.
const { openURLMock } = vi.hoisted(() => ({ openURLMock: vi.fn(async () => true) }));
vi.mock("react-native", async () => {
  const actual = await vi.importActual<typeof import("react-native")>("react-native");
  return {
    ...actual,
    Linking: { ...actual.Linking, openURL: openURLMock },
  };
});

import AdSlot, { type AdDelivery } from "../components/AdSlot";

type FetchInit = RequestInit | undefined;
type FetchCall = { url: string; init: FetchInit };

let fetchCalls: FetchCall[];
let deliveryQueue: Array<AdDelivery | null>;

function imageDelivery(over: Partial<AdDelivery> = {}): AdDelivery {
  return {
    slot: { id: 7, slotKey: "leaderboard_banner", rotationSeconds: 5 },
    campaign: { id: 22, weight: 1 },
    sponsor: { id: 99, name: "Acme Tees", logoUrl: null, websiteUrl: "https://acme.example" },
    creative: {
      id: 333,
      name: "Acme Banner",
      mediaType: "image",
      mediaUrl: "https://cdn.example/banner.png",
      clickThroughUrl: "https://acme.example/promo",
      headline: null,
      subheadline: null,
    },
    ...over,
  };
}

function installFetch() {
  fetchCalls = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: FetchInit) => {
    const url = typeof input === "string" ? input : input.toString();
    fetchCalls.push({ url, init });
    if (url.includes("/api/public/ad-slot/")) {
      const body = deliveryQueue.length ? deliveryQueue.shift()! : null;
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/api/public/sponsor-events")) {
      return new Response("{}", { status: 200 });
    }
    return new Response("null", { status: 200 });
  }));
}

function eventCalls() {
  return fetchCalls
    .filter(c => c.url.includes("/api/public/sponsor-events"))
    .map(c => JSON.parse(String(c.init?.body ?? "{}")));
}

function deliveryUrls() {
  return fetchCalls.filter(c => c.url.includes("/api/public/ad-slot/")).map(c => c.url);
}

beforeEach(() => {
  installFetch();
  deliveryQueue = [];
  openURLMock.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("<AdSlot />", () => {
  it("fetches the delivery with sessionId + tournamentId and logs one impression", async () => {
    deliveryQueue.push(imageDelivery());
    const onLoaded = vi.fn();

    render(
      <AdSlot orgId={4} slotKey="leaderboard_banner" tournamentId={88} onLoaded={onLoaded} />,
    );

    await waitFor(() => expect(eventCalls().length).toBe(1));

    const url = deliveryUrls()[0];
    expect(url).toContain("/api/public/ad-slot/4/leaderboard_banner");
    expect(url).toMatch(/sessionId=[^&]+/);
    expect(url).toContain("tournamentId=88");

    const ev = eventCalls()[0];
    expect(ev).toMatchObject({
      sponsorId: 99,
      eventType: "impression",
      source: "leaderboard_banner",
      slotKey: "leaderboard_banner",
      tournamentId: 88,
      campaignId: 22,
      creativeId: 333,
    });
    expect(typeof ev.sessionId).toBe("string");
    expect(ev.sessionId.length).toBeGreaterThan(0);

    expect(onLoaded).toHaveBeenCalledTimes(1);
    expect(onLoaded.mock.calls[0][0].creative?.id).toBe(333);
  });

  it("logs a click event with the right payload and opens the click-through URL", async () => {
    deliveryQueue.push(imageDelivery());
    render(<AdSlot orgId={4} slotKey="leaderboard_banner" />);

    const img = await screen.findByLabelText("Acme Banner");
    // Pressable wraps the image; click bubbles up to the Pressable handler.
    fireEvent.click(img);

    await waitFor(() => {
      const clicks = eventCalls().filter(e => e.eventType === "click");
      expect(clicks.length).toBe(1);
    });

    const click = eventCalls().find(e => e.eventType === "click")!;
    expect(click).toMatchObject({
      sponsorId: 99,
      eventType: "click",
      source: "leaderboard_banner",
      slotKey: "leaderboard_banner",
      campaignId: 22,
      creativeId: 333,
    });
    expect(openURLMock).toHaveBeenCalledWith("https://acme.example/promo");
  });

  it("does not log a click when neither clickThroughUrl nor sponsor.websiteUrl is set", async () => {
    deliveryQueue.push(
      imageDelivery({
        sponsor: { id: 99, name: "Acme", logoUrl: null, websiteUrl: null },
        creative: {
          id: 333,
          name: "Acme Banner",
          mediaType: "image",
          mediaUrl: "https://cdn.example/banner.png",
          clickThroughUrl: null,
          headline: null,
          subheadline: null,
        },
      }),
    );
    render(<AdSlot orgId={4} slotKey="leaderboard_banner" />);

    const img = await screen.findByLabelText("Acme Banner");
    // Wait for impression to flush so we know the effect chain ran.
    await waitFor(() => expect(eventCalls().some(e => e.eventType === "impression")).toBe(true));

    fireEvent.click(img);
    // Allow any potential click POST to flush.
    await new Promise(r => setTimeout(r, 20));

    expect(eventCalls().some(e => e.eventType === "click")).toBe(false);
    expect(openURLMock).not.toHaveBeenCalled();
  });

  it("renders nothing and reports empty for video creatives", async () => {
    deliveryQueue.push(
      imageDelivery({
        creative: {
          id: 333,
          name: "Acme Video",
          mediaType: "video",
          mediaUrl: "https://cdn.example/v.mp4",
          clickThroughUrl: null,
          headline: null,
          subheadline: null,
        },
      }),
    );
    const onEmpty = vi.fn();
    const onLoaded = vi.fn();

    const { container } = render(
      <AdSlot orgId={4} slotKey="mobile_splash" onEmpty={onEmpty} onLoaded={onLoaded} />,
    );

    await waitFor(() => expect(onEmpty).toHaveBeenCalledTimes(1));
    expect(onLoaded).not.toHaveBeenCalled();
    // No image rendered.
    expect(container.querySelector("img")).toBeNull();
  });

  it("reports empty when the delivery endpoint returns no creative (frequency-cap exhausted)", async () => {
    // Public endpoint returns a 200 with `creative: null` once the cap is hit.
    deliveryQueue.push({
      slot: { id: 7, slotKey: "leaderboard_banner", rotationSeconds: 0 },
      campaign: null,
      sponsor: null,
      creative: null,
    });
    const onEmpty = vi.fn();

    render(<AdSlot orgId={4} slotKey="leaderboard_banner" onEmpty={onEmpty} />);

    await waitFor(() => expect(onEmpty).toHaveBeenCalledTimes(1));
    expect(eventCalls()).toHaveLength(0);
  });

  it("rotates by re-fetching the delivery after rotationSeconds", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    deliveryQueue.push(imageDelivery({ slot: { id: 7, slotKey: "leaderboard_banner", rotationSeconds: 5 } }));
    deliveryQueue.push(imageDelivery({
      sponsor: { id: 200, name: "Beta", logoUrl: null, websiteUrl: "https://beta.example" },
      creative: {
        id: 444,
        name: "Beta Banner",
        mediaType: "image",
        mediaUrl: "https://cdn.example/beta.png",
        clickThroughUrl: "https://beta.example/x",
        headline: null,
        subheadline: null,
      },
      slot: { id: 7, slotKey: "leaderboard_banner", rotationSeconds: 5 },
    }));

    render(<AdSlot orgId={4} slotKey="leaderboard_banner" />);

    await waitFor(() => expect(deliveryUrls().length).toBe(1));
    await waitFor(() => expect(eventCalls().filter(e => e.eventType === "impression").length).toBe(1));

    await act(async () => {
      vi.advanceTimersByTime(5_000);
    });

    await waitFor(() => expect(deliveryUrls().length).toBe(2));
    await waitFor(() =>
      expect(eventCalls().filter(e => e.eventType === "impression").length).toBe(2),
    );

    const impressions = eventCalls().filter(e => e.eventType === "impression");
    expect(impressions[0].creativeId).toBe(333);
    expect(impressions[1].creativeId).toBe(444);
  });
});
