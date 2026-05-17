/**
 * UI tests: WellnessDashboardScreen
 *
 * Covers Task #533 (loading/error/empty/populated states, range switcher,
 * averages, null-gap charts) plus the contract changes from Tasks #1091/#946:
 *   - The initial fetch omits the range param so the server can echo back
 *     the user's stored preference (`rangeDays` field). Sending the param
 *     on first load would clobber any choice made on another device.
 *   - User-driven range switches send `?rangeDays=N` (canonical name; the
 *     server still accepts the legacy `?days=N` alias for older app builds).
 *   - Averages and `N-DAY AVG` labels re-render when the range changes.
 *   - Charts handle null gaps without crashing.
 */
import React, { type ReactNode } from "react";
import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

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
    Line: passthrough("line"),
    Path: passthrough("path"),
    Text: passthrough("svgtext"),
  };
});

vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock("@/context/auth", () => ({
  useAuth: () => ({ token: "test-token" }),
}));

import WellnessDashboardScreen from "../app/wellness-dashboard";

type WellnessDay = {
  metricDate: string;
  readinessScore: number | null;
  sleepMinutes: number | null;
  sleepScore: number | null;
  hrvMs: number | null;
  restingHr: number | null;
  steps: number | null;
  sources: string[];
};

function day(
  date: string,
  overrides: Partial<WellnessDay> = {},
): WellnessDay {
  return {
    metricDate: date,
    readinessScore: 80,
    sleepMinutes: 420,
    sleepScore: 85,
    hrvMs: 60,
    restingHr: 55,
    steps: 8000,
    sources: ["test"],
    ...overrides,
  };
}

// Build N days newest-first (matches the API contract).
function makeSeries(n: number, builder: (i: number) => Partial<WellnessDay> = () => ({})): WellnessDay[] {
  const base = new Date("2026-04-18T00:00:00.000Z").getTime();
  const out: WellnessDay[] = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(base - i * 86400_000).toISOString().slice(0, 10);
    out.push(day(d, builder(i)));
  }
  return out;
}

type FetchMock = Mock<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>;

let fetchMock: FetchMock;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  fetchMock = vi.fn() as unknown as FetchMock;
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

function lastCalledUrl(): string {
  const call = fetchMock.mock.calls.at(-1);
  if (!call) throw new Error("fetch was never called");
  const u = call[0];
  return typeof u === "string" ? u : u instanceof URL ? u.toString() : (u as Request).url;
}

// Walk up from a metric title until the enclosing card root (which contains
// both the title and the "DAY AVG" label). The metric title also appears in
// the legend below each chart, so try every match until we find one that sits
// inside a card.
function getCard(title: string): HTMLElement {
  const titleEls = screen.getAllByText(title);
  for (const titleEl of titleEls) {
    let node: HTMLElement | null = titleEl;
    while (node && node.parentElement) {
      const parent: HTMLElement = node.parentElement;
      const hasChart =
        !!parent.querySelector("svg") ||
        !!parent.textContent?.includes("No data in this range");
      if (
        parent.textContent?.includes(title) &&
        parent.textContent?.includes("DAY AVG") &&
        hasChart
      ) {
        return parent;
      }
      node = parent;
    }
  }
  throw new Error(`Could not find card for "${title}"`);
}

// The averaged value lives in a Text styled with the metric's color — the only
// element inside the card whose inline style mentions the metric color.
function getCardAverageText(card: HTMLElement, color: string): string {
  // react-native-web renders Text as a div; the inline style includes the colour.
  const norm = color.toLowerCase();
  const candidates = Array.from(card.querySelectorAll<HTMLElement>("[style]")).filter((el) => {
    const s = (el.getAttribute("style") ?? "").toLowerCase();
    return s.includes(norm) || s.includes(hexToRgb(norm));
  });
  if (candidates.length === 0) {
    throw new Error(`No element with color ${color} found inside card`);
  }
  return (candidates[0].textContent ?? "").trim();
}

function hexToRgb(hex: string): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgb(${r}, ${g}, ${b})`;
}

describe("<WellnessDashboardScreen />", () => {
  it("shows the loading state before the first response resolves", async () => {
    let resolveFetch: (r: Response) => void = () => {};
    fetchMock.mockImplementationOnce(
      () => new Promise<Response>((resolve) => { resolveFetch = resolve; }),
    );

    render(<WellnessDashboardScreen />);

    // ActivityIndicator from react-native-web renders as a div with role="progressbar".
    expect(await screen.findByRole("progressbar")).toBeInTheDocument();
    expect(screen.queryByText(/Recovery trends/i)).toBeInTheDocument();
    // No metric cards yet.
    expect(screen.queryByText(/30-DAY AVG/i)).toBeNull();

    await act(async () => {
      resolveFetch(jsonResponse({ series: [] }));
    });
  });

  it("shows the empty state when the API returns no rows", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ series: [] }));

    render(<WellnessDashboardScreen />);

    expect(
      await screen.findByText(/No wellness data yet\. Connect a wearable/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/30-DAY AVG/i)).toBeNull();
  });

  it("shows an error message when the server returns a non-OK status", async () => {
    fetchMock.mockResolvedValueOnce(new Response("nope", { status: 500 }));

    render(<WellnessDashboardScreen />);

    expect(await screen.findByText(/Server error \(500\)/i)).toBeInTheDocument();
    expect(screen.queryByText(/30-DAY AVG/i)).toBeNull();
  });

  it("shows a network error when fetch rejects", async () => {
    fetchMock.mockRejectedValueOnce(new Error("offline"));

    render(<WellnessDashboardScreen />);

    expect(await screen.findByText(/Network error/i)).toBeInTheDocument();
  });

  it("renders cards with averages computed from the populated series", async () => {
    // Three days, easy-to-verify means.
    // readiness: (90 + 80 + 70) / 3 = 80
    // sleepMinutes: (480 + 420 + 360) / 3 = 420  → 7.0h
    // hrvMs: (70 + 60 + 50) / 3 = 60 ms
    // restingHr: (50 + 55 + 60) / 3 = 55 bpm
    const series: WellnessDay[] = [
      day("2026-04-18", { readinessScore: 90, sleepMinutes: 480, hrvMs: 70, restingHr: 50 }),
      day("2026-04-17", { readinessScore: 80, sleepMinutes: 420, hrvMs: 60, restingHr: 55 }),
      day("2026-04-16", { readinessScore: 70, sleepMinutes: 360, hrvMs: 50, restingHr: 60 }),
    ];
    fetchMock.mockResolvedValueOnce(jsonResponse({ series }));

    render(<WellnessDashboardScreen />);

    // Each metric title is rendered twice (card title + legend), so use
    // findAllByText/getAllByText and assert at least one match.
    expect((await screen.findAllByText("Readiness")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("Sleep duration").length).toBeGreaterThan(0);
    expect(screen.getAllByText("HRV").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Resting heart rate").length).toBeGreaterThan(0);

    // Averages — scoped to each card to avoid axis-tick collisions.
    expect(getCardAverageText(getCard("Readiness"), "#22c55e")).toBe("80");
    expect(getCardAverageText(getCard("Sleep duration"), "#3b82f6")).toBe("7.0h");
    expect(getCardAverageText(getCard("HRV"), "#a855f7")).toBe("60 ms");
    expect(getCardAverageText(getCard("Resting heart rate"), "#ef4444")).toBe("55 bpm");

    // Default range = 30 → "30-DAY AVG" labels (one per metric card).
    expect(screen.getAllByText(/30-DAY AVG/)).toHaveLength(4);

    // Charts rendered: at least one path per metric and one dot per data point.
    const svgs = document.querySelectorAll("svg");
    expect(svgs.length).toBe(4);
    for (const svg of Array.from(svgs)) {
      const path = svg.querySelector("path");
      expect(path).not.toBeNull();
      // 3 data points → 3 circles plotted on top of the path.
      expect(svg.querySelectorAll("circle").length).toBe(3);
    }
  });

  it("refetches with the right ?rangeDays= value and re-renders averages when the range changes", async () => {
    // NOTE: This test originally asserted the initial fetch URL contained
    // `?days=30` and that range switches sent `days=N`. That matched the
    // Task #533 contract, but Tasks #1091/#946 changed the contract so the
    // visible-range preference is persisted server-side (`user_health_prefs`)
    // and follows the player across devices. To support that:
    //   - The initial fetch deliberately omits the range param so the server
    //     can echo back the user's stored preference (`rangeDays` in the
    //     response). The default 30d is returned when no preference is set.
    //   - When the user actively switches range, the screen sends
    //     `?rangeDays=N` (the canonical param name; the server also still
    //     accepts the legacy `?days=N` alias for backwards compatibility).
    // This test now asserts the current correct contract.
    const series30: WellnessDay[] = [
      day("2026-04-18", { readinessScore: 80 }),
      day("2026-04-17", { readinessScore: 80 }),
    ];
    const series60: WellnessDay[] = [
      day("2026-04-18", { readinessScore: 50 }),
      day("2026-04-17", { readinessScore: 50 }),
      day("2026-04-16", { readinessScore: 50 }),
    ];
    const series90: WellnessDay[] = [
      day("2026-04-18", { readinessScore: 90 }),
    ];

    fetchMock.mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : (input as URL | Request).toString();
      if (url.includes("rangeDays=60")) {
        return jsonResponse({ series: series60, rangeDays: 60, rangeDaysStored: true });
      }
      if (url.includes("rangeDays=90")) {
        return jsonResponse({ series: series90, rangeDays: 90, rangeDaysStored: true });
      }
      if (url.includes("rangeDays=30")) {
        return jsonResponse({ series: series30, rangeDays: 30, rangeDaysStored: true });
      }
      // Initial fetch — no range param, server echoes back its default (30).
      if (!url.includes("rangeDays=")) {
        return jsonResponse({ series: series30, rangeDays: 30, rangeDaysStored: false });
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });

    render(<WellnessDashboardScreen />);

    // Initial fetch — no range param (the server returns the stored
    // preference, defaulting to 30d). Readiness average from series30 = 80.
    await screen.findAllByText("Readiness");
    await waitFor(() =>
      expect(getCardAverageText(getCard("Readiness"), "#22c55e")).toBe("80"),
    );
    // Initial URL must hit the endpoint with NO query string at all — neither
    // the canonical `rangeDays` nor the legacy `days` alias. Sending either
    // would persist the default 30 server-side and clobber a value the user
    // chose on another device. Asserting absence of `?` catches both.
    const initialUrl = lastCalledUrl();
    expect(initialUrl).toContain("/api/portal/wellness/daily");
    expect(initialUrl).not.toContain("?");
    expect(initialUrl).not.toContain("rangeDays=");
    expect(initialUrl).not.toContain("days=");
    expect(screen.getAllByText(/30-DAY AVG/)).toHaveLength(4);

    // Switch to 60d.
    fireEvent.click(screen.getByTestId("range-60"));

    await waitFor(() => expect(lastCalledUrl()).toContain("rangeDays=60"));
    await waitFor(() =>
      expect(getCardAverageText(getCard("Readiness"), "#22c55e")).toBe("50"),
    );
    expect(screen.getAllByText(/60-DAY AVG/)).toHaveLength(4);
    expect(screen.queryAllByText(/30-DAY AVG/)).toHaveLength(0);

    // Switch to 90d.
    fireEvent.click(screen.getByTestId("range-90"));

    await waitFor(() => expect(lastCalledUrl()).toContain("rangeDays=90"));
    await waitFor(() =>
      expect(getCardAverageText(getCard("Readiness"), "#22c55e")).toBe("90"),
    );
    expect(screen.getAllByText(/90-DAY AVG/)).toHaveLength(4);

    // The Authorization header should accompany every fetch.
    for (const call of fetchMock.mock.calls) {
      const init = call[1] as RequestInit | undefined;
      const headers = (init?.headers ?? {}) as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer test-token");
    }
  });

  it("renders without crashing when the series contains null gaps, and skips them in averages and dots", async () => {
    // Five days, three with readiness, two null. Average = (90+60+30)/3 = 60.
    // HRV all-null → average renders as the em-dash placeholder.
    const series: WellnessDay[] = [
      day("2026-04-18", { readinessScore: 90, hrvMs: null }),
      day("2026-04-17", { readinessScore: null, hrvMs: null }),
      day("2026-04-16", { readinessScore: 60, hrvMs: null }),
      day("2026-04-15", { readinessScore: null, hrvMs: null }),
      day("2026-04-14", { readinessScore: 30, hrvMs: null }),
    ];
    fetchMock.mockResolvedValueOnce(jsonResponse({ series }));

    render(<WellnessDashboardScreen />);

    await screen.findAllByText("Readiness");

    // Readiness average ignores nulls: 60.
    expect(getCardAverageText(getCard("Readiness"), "#22c55e")).toBe("60");

    // HRV is fully null → em-dash placeholder for the average.
    expect(getCardAverageText(getCard("HRV"), "#a855f7")).toBe("—");

    // Readiness card chart: only 3 data dots even though the series has 5 days.
    const readinessCard = getCard("Readiness");
    const readinessSvg = readinessCard.querySelector("svg");
    expect(readinessSvg).not.toBeNull();
    expect(readinessSvg!.querySelectorAll("circle").length).toBe(3);

    // The path must lift the pen across gaps: more than one "M" command.
    const readinessPath = readinessSvg!.querySelector("path");
    const d = readinessPath?.getAttribute("d") ?? "";
    expect((d.match(/M/g) ?? []).length).toBeGreaterThanOrEqual(2);

    // HRV card has no SVG — instead the in-chart empty placeholder is shown.
    const hrvCard = getCard("HRV");
    expect(hrvCard.querySelector("svg")).toBeNull();
    expect(screen.getByText(/No data in this range/i)).toBeInTheDocument();

    // Total SVGs = 3 (Readiness, Sleep duration, Resting heart rate).
    expect(document.querySelectorAll("svg")).toHaveLength(3);
  });
});
