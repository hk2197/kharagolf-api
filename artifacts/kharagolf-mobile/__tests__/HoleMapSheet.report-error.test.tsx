/**
 * Task #1350 — "Report an error" deep link from the mobile hole detail.
 *
 * Mirrors the web "Report an error on hole N" link added in Task #1174 for
 * the course mapper / course list. When the player spots wrong par /
 * yardage / hazard data on the map sheet they can tap this link and the
 * portal correction form opens pre-filled with courseId + hole + field.
 *
 * Coverage:
 *   - link is rendered when courseId is provided and BASE_URL is set
 *   - tapping it calls Linking.openURL with the same query-string contract
 *     the web links use (courseId, hole, field=par)
 *   - link is hidden when courseId is missing (e.g. tournament round with
 *     no holesData.courseId yet) so we never deep-link without a target
 *   - Task #1615: the deep link also forwards `currentValue=<hole.par>` so
 *     the portal form can pre-fill the suggestion input with the par the
 *     player just looked at, and omits it when par isn't available.
 */
import React, { type ReactNode } from "react";
import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Linking } from "react-native";

type SvgPrimitiveProps = React.SVGAttributes<Element> & { children?: ReactNode };

vi.mock("react-native-svg", () => {
  const ReactInner = require("react") as typeof React;
  const passthrough = (tag: string) =>
    ReactInner.forwardRef<Element, SvgPrimitiveProps>(({ children, ...rest }, ref) =>
      ReactInner.createElement(tag, { ...rest, ref }, children),
    );
  const Svg = passthrough("svg");
  return {
    __esModule: true,
    default: Svg,
    Svg,
    G: passthrough("g"),
    Circle: passthrough("circle"),
    Ellipse: passthrough("ellipse"),
    Line: passthrough("line"),
    Path: passthrough("path"),
    Polygon: passthrough("polygon"),
    Polyline: passthrough("polyline"),
    Rect: passthrough("rect"),
    Text: passthrough("svgtext"),
    Defs: passthrough("defs"),
    LinearGradient: passthrough("linearGradient"),
    Stop: passthrough("stop"),
  };
});

vi.mock("@/modules/KharagolfWatchBridge", () => ({
  WatchBridge: {
    isAvailable: vi.fn(() => false),
    pushPlaysLike: vi.fn().mockResolvedValue(undefined),
  },
}));

type FetchPublicFn = (path: string) => Promise<unknown>;
const noopFetchPublic: FetchPublicFn = async (path) => {
  if (path === "/map-config") return { token: null };
  if (path.endsWith("/holes-hazards")) return [];
  if (path.endsWith("/holes-fairways")) return [];
  return null;
};

vi.mock("@/utils/api", () => ({
  // The test asserts the constructed URL — pin the BASE_URL so it's
  // deterministic regardless of EXPO_PUBLIC_DOMAIN at test time.
  BASE_URL: "https://kharagolf.test",
  fetchPublic: vi.fn<FetchPublicFn>(),
}));

import HoleMapSheet from "../components/HoleMapSheet";
import { fetchPublic } from "@/utils/api";

const fetchPublicMock = vi.mocked(fetchPublic) as unknown as Mock<FetchPublicFn>;

const HOLE = {
  holeNumber: 7,
  par: 4,
  yardageWhite: 380,
  greenCentreLat: "12.971800",
  greenCentreLng: "77.594560",
  greenFrontLat: "12.971700",
  greenFrontLng: "77.594560",
  greenBackLat: "12.971900",
  greenBackLng: "77.594560",
};

beforeEach(() => {
  fetchPublicMock.mockImplementation(noopFetchPublic);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(JSON.stringify({ elevation: [800, 802, 803, 804] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ),
  );
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("<HoleMapSheet /> — Report an error deep link (Task #1350)", () => {
  it("opens the portal correction form with courseId + hole + field=par + currentValue when tapped", async () => {
    // react-native-web's Linking is the real surface the component reaches
    // through. Spy on openURL so we can assert the deep-link target.
    const openURLSpy = vi
      .spyOn(Linking, "openURL")
      .mockResolvedValue(undefined as unknown as boolean);

    render(
      <HoleMapSheet
        visible
        onClose={() => {}}
        hole={HOLE}
        userLat={12.972300}
        userLng={77.594560}
        courseId={42}
      />,
    );

    const link = await screen.findByText(/Report an error on hole 7/i);
    fireEvent.click(link);

    expect(openURLSpy).toHaveBeenCalledTimes(1);
    // Task #1615 — currentValue is the par we're showing on the sheet, so
    // the portal form can pre-fill both the "current" and "suggested" inputs.
    expect(openURLSpy).toHaveBeenCalledWith(
      "https://kharagolf.test/portal/course-corrections?courseId=42&hole=7&field=par&currentValue=4",
    );

    openURLSpy.mockRestore();
  });

  it("omits currentValue when the hole has no par recorded (Task #1615)", async () => {
    const openURLSpy = vi
      .spyOn(Linking, "openURL")
      .mockResolvedValue(undefined as unknown as boolean);

    const holeWithoutPar = { ...HOLE, par: null as unknown as number };
    render(
      <HoleMapSheet
        visible
        onClose={() => {}}
        hole={holeWithoutPar}
        userLat={12.972300}
        userLng={77.594560}
        courseId={42}
      />,
    );

    const link = await screen.findByText(/Report an error on hole 7/i);
    fireEvent.click(link);

    expect(openURLSpy).toHaveBeenCalledTimes(1);
    const calledWith = openURLSpy.mock.calls[0][0] as string;
    expect(calledWith).toBe(
      "https://kharagolf.test/portal/course-corrections?courseId=42&hole=7&field=par",
    );
    expect(calledWith).not.toContain("currentValue");

    openURLSpy.mockRestore();
  });

  it("does not render the link when courseId is missing", () => {
    render(
      <HoleMapSheet
        visible
        onClose={() => {}}
        hole={HOLE}
        userLat={12.972300}
        userLng={77.594560}
      />,
    );

    expect(screen.queryByText(/Report an error on hole/i)).toBeNull();
  });
});
