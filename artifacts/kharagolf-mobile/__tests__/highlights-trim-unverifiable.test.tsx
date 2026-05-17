/**
 * Task #1155 — Regression coverage for the editor's "clip can't be trimmed"
 * warning (originally introduced by Task #993).
 *
 * The mobile highlight editor must hide the trim steppers and surface a
 * yellow warning for video clips whose `durationSeconds` is unknown
 * (legacy uploads, or files we couldn't probe). Without this coverage a
 * future refactor could silently restore the old 30s fallback and start
 * shipping mis-trimmed clips into rendered reels.
 *
 * The test mounts the full HighlightsScreen, opens the New Reel modal,
 * and asserts:
 *   1. The candidate-strip badge (`testID=candidate-unverifiable-<id>`)
 *      appears for video rows whose duration couldn't be measured.
 *   2. After the player taps that candidate (adding it to the draft
 *      clip list), the trim warning (`testID=trim-unverifiable-<id>`)
 *      shows and the trim/preview controls (Start / Length / Preview)
 *      are NOT rendered.
 *   3. As a sanity check, a sibling video clip with a known
 *      `durationSeconds` does NOT get the warning and DOES render the
 *      trim controls — so the test fails if we accidentally hide trim
 *      controls for everyone.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

vi.mock("expo-av", () => {
  const ReactInner = require("react") as typeof React;
  const Video = ReactInner.forwardRef((_props: unknown, _ref: unknown) =>
    ReactInner.createElement("div", { "data-testid": "stub-video" }),
  );
  return {
    Video,
    ResizeMode: { COVER: "cover", CONTAIN: "contain" },
  };
});

vi.mock("expo-file-system", () => {
  class File {
    uri: string;
    constructor(_dir: string, name: string) { this.uri = `file:///cache/${name}`; }
    get exists() { return false; }
    delete() {}
    static downloadFileAsync = vi.fn(async (_remote: string, target: { uri: string }) => target);
  }
  return { File, Paths: { cache: "file:///cache" } };
});

vi.mock("expo-media-library", () => ({
  requestPermissionsAsync: vi.fn(async () => ({ granted: true })),
  saveToLibraryAsync: vi.fn(async () => undefined),
  createAssetAsync: vi.fn(async () => ({ id: "asset-1" })),
}));

vi.mock("expo-sharing", () => ({
  isAvailableAsync: vi.fn(async () => true),
  shareAsync: vi.fn(async () => undefined),
}));

vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock("@/context/auth", () => ({
  useAuth: () => ({ token: "test-token", user: { id: 99 }, orgId: 42 }),
}));

vi.mock("@expo/vector-icons", () => {
  const Stub = (props: { name?: string }) =>
    React.createElement("span", { "data-icon": props?.name ?? "icon" });
  return { Feather: Stub, Ionicons: Stub, MaterialIcons: Stub };
});

import HighlightsScreen from "../app/highlights";

const UNVERIFIABLE_VIDEO_ID = 4242;
const VERIFIABLE_VIDEO_ID = 9090;

function installFetch() {
  global.fetch = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input);

    if (url.includes("/portal/highlights/templates")) {
      return new Response(
        JSON.stringify({
          templates: [{
            id: "classic",
            name: "Classic",
            description: "Standard highlight reel",
            durationSeconds: 30,
            primaryColor: "#0a0",
            secondaryColor: "#040",
          }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ) as unknown as Response;
    }

    if (url.includes("/portal/my-tournaments")) {
      return new Response(JSON.stringify([]), {
        status: 200, headers: { "Content-Type": "application/json" },
      }) as unknown as Response;
    }

    if (url.includes("/portal/highlights/candidate-media")) {
      return new Response(JSON.stringify({
        media: [
          {
            id: UNVERIFIABLE_VIDEO_ID,
            mediaType: "video",
            caption: null,
            holeNumber: 7,
            thumbnailUrl: null,
            url: "/objects/clips/legacy.mp4",
            // The whole point of this test — durationSeconds is null
            // (legacy upload that pre-dates Task #703 probing).
            durationSeconds: null,
            suggestedCaptions: [],
            suggestedCaptionTemplates: [],
          },
          {
            id: VERIFIABLE_VIDEO_ID,
            mediaType: "video",
            caption: null,
            holeNumber: 12,
            thumbnailUrl: null,
            url: "/objects/clips/measured.mp4",
            // Known source duration — should keep the trim controls and
            // NOT render the warning. Sanity check that the new code path
            // didn't accidentally swallow trim controls for all videos.
            durationSeconds: 18,
            suggestedCaptions: [],
            suggestedCaptionTemplates: [],
          },
        ],
      }), { status: 200, headers: { "Content-Type": "application/json" } }) as unknown as Response;
    }

    // Default: highlights list + everything else returns an empty payload
    // so the gallery shows its empty state (which exposes the
    // "Create your first reel" button we use to open the editor).
    if (url.includes("/portal/highlights")) {
      return new Response(JSON.stringify({ reels: [], quota: null }), {
        status: 200, headers: { "Content-Type": "application/json" },
      }) as unknown as Response;
    }

    return new Response("{}", {
      status: 200, headers: { "Content-Type": "application/json" },
    }) as unknown as Response;
  }) as typeof fetch;
}

beforeEach(() => {
  installFetch();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Task #1155 — highlight editor 'clip can't be trimmed' warning", () => {
  it("shows the candidate-strip badge for video clips with no measured duration", async () => {
    render(<HighlightsScreen />);

    // Wait for fetchAll() to clear `loading` and render the empty-state
    // "Create your first reel" button, then open the editor modal.
    const openBtn = await screen.findByText(/create your first reel/i);
    act(() => { fireEvent.click(openBtn); });

    // Once the modal mounts, loadCandidates() fires — wait for the
    // unverifiable badge to appear on the candidate strip.
    await waitFor(() => {
      expect(screen.getByTestId(`candidate-unverifiable-${UNVERIFIABLE_VIDEO_ID}`)).toBeInTheDocument();
    });

    // The verifiable-duration sibling must NOT carry the badge.
    expect(screen.queryByTestId(`candidate-unverifiable-${VERIFIABLE_VIDEO_ID}`)).toBeNull();
  });

  it("renders the trim warning and hides Start/Length/Preview controls once an unverifiable clip is added", async () => {
    render(<HighlightsScreen />);

    const openBtn = await screen.findByText(/create your first reel/i);
    act(() => { fireEvent.click(openBtn); });

    // Wait for both candidate cards to be in the DOM (so we can tap them).
    const unverifiableCard = await screen.findByTestId(`candidate-unverifiable-${UNVERIFIABLE_VIDEO_ID}`);

    // Tap the unverifiable candidate to add it to draftClips. The badge
    // sits inside the TouchableOpacity, so clicking the badge bubbles up
    // to the card's onPress (toggleClip).
    act(() => { fireEvent.click(unverifiableCard); });

    // The clip row should now render the trim warning.
    const warning = await screen.findByTestId(`trim-unverifiable-${UNVERIFIABLE_VIDEO_ID}`);
    expect(warning).toBeInTheDocument();
    expect(warning.textContent ?? "").toMatch(/can.?t be trimmed/i);

    // And the trim/preview controls — keyed off the literal labels the
    // editor renders inside the trim row — must NOT be present for this
    // clip. Those strings only appear inside the trim row JSX, so a
    // global query is reliable here (no other "Start" / "Length" /
    // "Preview" text exists in the editor modal at this point).
    expect(screen.queryByText("Start")).toBeNull();
    expect(screen.queryByText("Length")).toBeNull();
    expect(screen.queryByText("Preview")).toBeNull();
  });

  it("still shows trim controls (and no warning) for a sibling video with a measured duration", async () => {
    render(<HighlightsScreen />);

    const openBtn = await screen.findByText(/create your first reel/i);
    act(() => { fireEvent.click(openBtn); });

    // The unverifiable badge sits *inside* its candidate TouchableOpacity
    // card; the verifiable candidate is the sibling card under the same
    // horizontal ScrollView. Walk up from the badge to find the strip
    // and pick the card that does NOT contain the unverifiable badge.
    const unverifiableBadge = await screen.findByTestId(`candidate-unverifiable-${UNVERIFIABLE_VIDEO_ID}`);
    const unverifiableCard = unverifiableBadge.parentElement as HTMLElement;
    expect(unverifiableCard).not.toBeNull();
    const strip = unverifiableCard.parentElement as HTMLElement;
    expect(strip).not.toBeNull();
    const cards = Array.from(strip.children) as HTMLElement[];
    expect(cards.length).toBeGreaterThanOrEqual(2);
    const verifiableCard = cards.find(card => !card.contains(unverifiableBadge));
    expect(verifiableCard).toBeDefined();

    act(() => { fireEvent.click(verifiableCard!); });

    // Trim controls render for the measured-duration clip.
    await waitFor(() => {
      expect(screen.getByText("Start")).toBeInTheDocument();
    });
    expect(screen.getByText("Length")).toBeInTheDocument();
    expect(screen.getByText("Preview")).toBeInTheDocument();

    // And no trim-unverifiable warning is present for it.
    expect(screen.queryByTestId(`trim-unverifiable-${VERIFIABLE_VIDEO_ID}`)).toBeNull();
  });
});
