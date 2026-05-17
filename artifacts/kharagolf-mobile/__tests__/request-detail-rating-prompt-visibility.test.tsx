/**
 * Task #1861 — focused unit tests for the rating-prompt visibility logic
 * inside `RequestDetailModalInner` (artifacts/kharagolf-mobile/app/(tabs)/coach.tsx).
 *
 * The wider coach-payout-detail test exercises the full payout → review
 * tap → modal flow and locks in the *coach* paths (prompt hidden, "Member
 * rating" summary shown). This file pins the *member* path explicitly so
 * a future refactor that always hides the form (regression in the other
 * direction) is caught immediately:
 *
 *   - owner viewer + delivered + rating == null   → prompt visible
 *   - owner viewer + delivered + rating != null   → "You rated this review"
 *   - missing viewerRole (older server payload)   → defaults to owner
 */
import React from "react";
import {
  describe,
  it,
  expect,
  afterEach,
  vi,
} from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

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
    user: { id: 1 },
    isAuthenticated: true,
    isLoading: false,
  }),
}));

vi.mock("@/utils/api", () => ({ BASE_URL: "" }));

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

import { RequestDetailModalInner } from "../app/(tabs)/coach";

afterEach(() => {
  cleanup();
});

function makeData(overrides: {
  rating?: number | null;
  ratingComment?: string | null;
  viewerRole?: "owner" | "coach" | "admin";
}) {
  return {
    request: {
      id: 7,
      status: "delivered",
      rating: overrides.rating ?? null,
      ratingComment: overrides.ratingComment ?? null,
      annotationId: 1,
    },
    video: { id: 1, videoUrl: "https://example.test/swing.mp4", fps: 30 },
    annotation: {
      id: 1,
      drawings: [],
      voiceOverUrl: null,
      voiceOverDurationSeconds: null,
      textNotes: "Looks great",
    },
    pro: { id: 9, displayName: "Pro Test", photoUrl: null },
    viewerRole: overrides.viewerRole,
  };
}

function mount(viewerRole: "owner" | "coach" | "admin" | undefined, rating: number | null, ratingComment: string | null = null) {
  render(
    <RequestDetailModalInner
      data={makeData({ rating, ratingComment, viewerRole }) as any}
      onClose={() => {}}
      rating={0}
      setRating={() => {}}
      comment=""
      setComment={() => {}}
      submitRating={() => {}}
    />,
  );
}

describe("RequestDetailModalInner — rating prompt visibility (Task #1861)", () => {
  it("shows the 5-star rating form for the owning member when no rating exists yet", () => {
    mount("owner", null);
    expect(screen.getByText("Rate this review")).toBeTruthy();
    expect(screen.getByText("Submit Rating")).toBeTruthy();
  });

  it("hides the rating form from a coach viewer even when no rating exists", () => {
    mount("coach", null);
    expect(screen.queryByText("Rate this review")).toBeNull();
    expect(screen.queryByText("Submit Rating")).toBeNull();
  });

  it("hides the rating form from an admin viewer", () => {
    mount("admin", null);
    expect(screen.queryByText("Rate this review")).toBeNull();
    expect(screen.queryByText("Submit Rating")).toBeNull();
  });

  it("defaults to owner behaviour when viewerRole is missing (older server payload)", () => {
    mount(undefined, null);
    expect(screen.getByText("Rate this review")).toBeTruthy();
  });

  it("shows the self-referential 'You rated this review' summary for the owning member", () => {
    mount("owner", 4, "Loved it.");
    expect(screen.getByText("You rated this review")).toBeTruthy();
    expect(screen.queryByText("Member rating")).toBeNull();
  });

  it("shows a non-self-referential 'Member rating' summary for a coach viewer of a rated review", () => {
    mount("coach", 4, "Loved it.");
    expect(screen.getByText("Member rating")).toBeTruthy();
    expect(screen.queryByText("You rated this review")).toBeNull();
  });
});
