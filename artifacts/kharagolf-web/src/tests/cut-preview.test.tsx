/**
 * Task #1989 — `CutPreview` regression test.
 *
 * The cut-line input on the tournament edit page renders an inline
 * preview translating "+N over par" into the absolute strokes a player
 * would need to make the cut. The preview must mirror `applyCut`'s par
 * resolution exactly:
 *
 *   - Prefer the sum of `hole_details.par` when the seeded hole count
 *     equals `courses.holes`; otherwise fall back to `courses.par`.
 *   - For multi-course tournaments, sum the per-round course par
 *     across rounds 1..cutAfterRound (per-round assignment wins,
 *     otherwise the tournament's default course is used).
 *   - For single-round events, "after round" is implicitly 1 so the
 *     preview shows up immediately as the admin types the cut value.
 *   - Multi-round tournaments without a "Cut After Round" picked yet
 *     show a hint instead of a fake number.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { CutPreview } from "@/pages/tournament-detail";
import { setBaseUrl } from "@workspace/api-client-react";

type FetchHandler = () => unknown;

function stubFetch(handlers: Record<string, FetchHandler>) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      const stripped = url.split("?")[0];
      const matched = Object.keys(handlers).find(key => stripped.endsWith(key));
      if (!matched) {
        return Promise.resolve({
          ok: false,
          status: 404,
          json: () => Promise.resolve({}),
          text: () => Promise.resolve("{}"),
        } as unknown as Response);
      }
      const body = handlers[matched]();
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: () => Promise.resolve(body),
        text: () => Promise.resolve(JSON.stringify(body ?? {})),
      } as unknown as Response);
    }) as unknown as typeof fetch,
  );
}

function makeCourse(opts: {
  id: number;
  name?: string;
  holes?: number;
  par: number;
  holeDetails?: Array<{ par: number }>;
}) {
  const holes = opts.holes ?? 18;
  const details = (opts.holeDetails ?? []).map((h, i) => ({
    id: opts.id * 100 + i + 1,
    holeNumber: i + 1,
    par: h.par,
    handicap: i + 1,
    yardageBlue: null,
    yardageWhite: null,
    yardageRed: null,
    description: null,
  }));
  return {
    id: opts.id,
    organizationId: 1,
    name: opts.name ?? `Course ${opts.id}`,
    location: null,
    holes,
    par: opts.par,
    rating: null,
    slope: null,
    yardage: null,
    externalCourseId: null,
    mapDefaultLat: null,
    mapDefaultLng: null,
    mapDefaultZoom: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    holeDetails: details,
  };
}

function renderPreview(props: React.ComponentProps<typeof CutPreview>) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <CutPreview {...props} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  // The generated client uses a relative base URL by default, but
  // jsdom's `fetch` shim still wants something parseable. Pin it to a
  // stable origin so URL construction never throws.
  setBaseUrl("http://localhost");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("CutPreview", () => {
  it("renders nothing when the cut-line input is empty", () => {
    stubFetch({});
    const { container } = renderPreview({
      orgId: 1,
      courseId: "10",
      roundCourses: {},
      cutLine: "",
      cutAfterRound: "",
      rounds: "1",
    });
    expect(container.textContent).toBe("");
  });

  it("uses the par-70 sum of hole_details for a single-round event", async () => {
    // Course 10 is a 9-hole layout (par 35) seeded with hole-by-hole par.
    // The sum (35) should match courses.holes so the preview prefers
    // sum(hole_details.par) over the course-level fallback (which we set
    // to 99 to make sure the wrong branch would fail loudly).
    const par9 = [4, 4, 3, 5, 4, 3, 4, 4, 4]; // sum = 35
    stubFetch({
      "/api/organizations/1/courses/10": () =>
        makeCourse({
          id: 10,
          holes: 9,
          par: 99,
          holeDetails: par9.map(p => ({ par: p })),
        }),
    });

    renderPreview({
      orgId: 1,
      courseId: "10",
      roundCourses: {},
      cutLine: "5",
      cutAfterRound: "",
      rounds: "1",
    });

    const preview = await screen.findByTestId("text-cutline-absolute-strokes");
    // 35 + 5 = 40 strokes after the only round.
    expect(preview.textContent).toContain("40 strokes");
    expect(preview.textContent).toContain("par 35");
    expect(preview.textContent).toContain("after round 1");
  });

  it("falls back to courses.par when hole_details are partially seeded", async () => {
    // Hole detail count (5) does NOT match courses.holes (18), so the
    // preview should fall back to the course-level par (70) just like
    // applyCut does — and ignore the partial seed entirely.
    const partial = [4, 4, 4, 4, 4]; // sum = 20, but this should NOT be used
    stubFetch({
      "/api/organizations/1/courses/20": () =>
        makeCourse({
          id: 20,
          holes: 18,
          par: 70,
          holeDetails: partial.map(p => ({ par: p })),
        }),
    });

    renderPreview({
      orgId: 1,
      courseId: "20",
      roundCourses: {},
      cutLine: "5",
      cutAfterRound: "",
      rounds: "1",
    });

    const preview = await screen.findByTestId("text-cutline-absolute-strokes");
    // 70 (course par fallback) + 5 = 75 strokes.
    expect(preview.textContent).toContain("75 strokes");
    expect(preview.textContent).toContain("par 70");
  });

  it("sums per-round course par for multi-course tournaments", async () => {
    // Three rounds; round 1 + round 3 ride the default course (par 72)
    // and round 2 has a per-round override pointing at the par-71
    // Sunday course. Total par = 72 + 71 + 72 = 215; cut line +6 →
    // 221 strokes after round 3.
    stubFetch({
      "/api/organizations/1/courses/30": () => makeCourse({ id: 30, holes: 18, par: 72 }),
      "/api/organizations/1/courses/31": () => makeCourse({ id: 31, holes: 18, par: 71 }),
    });

    renderPreview({
      orgId: 1,
      courseId: "30",
      roundCourses: { 1: "", 2: "31", 3: "" },
      cutLine: "6",
      cutAfterRound: "3",
      rounds: "3",
    });

    const preview = await screen.findByTestId("text-cutline-absolute-strokes");
    expect(preview.textContent).toContain("221 strokes");
    expect(preview.textContent).toContain("par 215");
    expect(preview.textContent).toContain("+6");
    expect(preview.textContent).toContain("after round 3");
  });

  it("only sums up through the chosen 'cut after round'", async () => {
    // Same fixture as above, but with cutAfterRound=2 — round 3 must
    // not contribute, so the total par is 72 + 71 = 143, and the
    // preview reads 148 strokes after round 2.
    stubFetch({
      "/api/organizations/1/courses/30": () => makeCourse({ id: 30, holes: 18, par: 72 }),
      "/api/organizations/1/courses/31": () => makeCourse({ id: 31, holes: 18, par: 71 }),
    });

    renderPreview({
      orgId: 1,
      courseId: "30",
      roundCourses: { 1: "", 2: "31", 3: "" },
      cutLine: "5",
      cutAfterRound: "2",
      rounds: "3",
    });

    const preview = await screen.findByTestId("text-cutline-absolute-strokes");
    expect(preview.textContent).toContain("148 strokes");
    expect(preview.textContent).toContain("par 143");
    expect(preview.textContent).toContain("after round 2");
  });

  it("surfaces an error state when a required course fetch fails instead of silently using par 72", async () => {
    // No handler for course 40 → the stubbed fetch returns 404, the
    // generated client throws, react-query marks the query as errored.
    // The preview must NOT fall through to a confidently wrong number
    // (which would happen if it silently defaulted to par 72).
    stubFetch({});

    renderPreview({
      orgId: 1,
      courseId: "40",
      roundCourses: {},
      cutLine: "5",
      cutAfterRound: "",
      rounds: "1",
    });

    const errorMsg = await screen.findByTestId("text-cutline-absolute-strokes-error");
    expect(errorMsg.textContent).toMatch(/couldn't load course par/i);
    // The numeric preview must not appear alongside the error.
    expect(screen.queryByTestId("text-cutline-absolute-strokes")).toBeNull();
  });

  it("nudges the admin to pick a 'cut after round' for multi-round events", async () => {
    stubFetch({
      "/api/organizations/1/courses/30": () => makeCourse({ id: 30, holes: 18, par: 72 }),
    });

    renderPreview({
      orgId: 1,
      courseId: "30",
      roundCourses: {},
      cutLine: "5",
      cutAfterRound: "",
      rounds: "3",
    });

    const hint = await screen.findByTestId("text-cutline-absolute-strokes-hint");
    expect(hint.textContent).toMatch(/Cut After Round/i);
    // The numeric preview should never render until the admin picks a round.
    await waitFor(() => {
      expect(screen.queryByTestId("text-cutline-absolute-strokes")).toBeNull();
    });
  });
});
