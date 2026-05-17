import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import {
  GreenContourDialog,
  parseCsv,
  parseJson,
  validateGrid,
  MAX_DIM,
} from "@/components/GreenContourDialog";

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

describe("GreenContourDialog parsers (Task #538)", () => {
  describe("parseCsv", () => {
    it("parses a valid 3x3 grid with comma separators", () => {
      const r = parseCsv("0,0.05,0.10\n-0.02,0.04,0.09\n-0.05,0,0.06");
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.data.rows).toBe(3);
        expect(r.data.cols).toBe(3);
        expect(r.data.elevations).toEqual([0, 0.05, 0.1, -0.02, 0.04, 0.09, -0.05, 0, 0.06]);
      }
    });

    it("accepts semicolon and tab separators and ignores comments/blank lines", () => {
      const r = parseCsv("# header\n0;1;2\n\n3\t4\t5\n6,7,8\n");
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.data.rows).toBe(3);
        expect(r.data.cols).toBe(3);
        expect(r.data.elevations).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
      }
    });

    it("rejects ragged rows", () => {
      const r = parseCsv("0,1,2\n3,4\n5,6,7");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/Row 2 has 2 columns, expected 3/);
    });

    it("rejects non-numeric cells", () => {
      const r = parseCsv("0,1,2\n3,four,5");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/Row 2.*"four" is not a number/);
    });

    it("rejects empty CSV input", () => {
      const r = parseCsv("\n  \n# only a comment\n");
      expect(r.ok).toBe(false);
    });
  });

  describe("parseJson", () => {
    it("parses a 2D array", () => {
      const r = parseJson("[[0,0.05,0.10],[-0.02,0.04,0.09],[-0.05,0,0.06]]");
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.data.rows).toBe(3);
        expect(r.data.cols).toBe(3);
        expect(r.data.elevations).toHaveLength(9);
      }
    });

    it("parses {rows, cols, elevations} shape", () => {
      const r = parseJson(
        JSON.stringify({ rows: 2, cols: 3, elevations: [0, 1, 2, 3, 4, 5] }),
      );
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.data.rows).toBe(2);
        expect(r.data.cols).toBe(3);
        expect(r.data.elevations).toEqual([0, 1, 2, 3, 4, 5]);
      }
    });

    it("rejects 2D arrays with mismatched row lengths", () => {
      const r = parseJson("[[0,1,2],[3,4]]");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/Row 2 length mismatch/);
    });

    it("rejects 2D arrays with non-numeric cells", () => {
      const r = parseJson('[[0,1,"x"],[3,4,5]]');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/Non-numeric value at row 1/);
    });

    it("rejects elevations length not equal to rows*cols", () => {
      const r = parseJson(
        JSON.stringify({ rows: 3, cols: 3, elevations: [0, 1, 2, 3] }),
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/elevations length \(4\) must equal rows × cols \(9\)/);
    });

    it("rejects malformed JSON", () => {
      const r = parseJson("{not json");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/Invalid JSON/);
    });

    it("rejects unrecognised JSON shape", () => {
      const r = parseJson('{"foo":1}');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/Unrecognised JSON shape/);
    });
  });

  describe("validateGrid", () => {
    it("accepts an in-range grid", () => {
      expect(
        validateGrid({ rows: 5, cols: 5, elevations: new Array(25).fill(0.1) }),
      ).toBeNull();
    });

    it("rejects undersize grids", () => {
      const err = validateGrid({ rows: 2, cols: 5, elevations: new Array(10).fill(0) });
      expect(err).toMatch(/too small/);
    });

    it("rejects oversize grids", () => {
      const big = MAX_DIM + 1;
      const err = validateGrid({
        rows: big,
        cols: 4,
        elevations: new Array(big * 4).fill(0),
      });
      expect(err).toMatch(/too large/);
    });

    it("rejects out-of-range elevations (positive and negative)", () => {
      const tooHigh = validateGrid({ rows: 3, cols: 3, elevations: [0, 0, 0, 0, 999, 0, 0, 0, 0] });
      expect(tooHigh).toMatch(/outside ±50/);
      const tooLow = validateGrid({ rows: 3, cols: 3, elevations: [0, 0, 0, 0, -999, 0, 0, 0, 0] });
      expect(tooLow).toMatch(/outside ±50/);
    });
  });
});

describe("GreenContourDialog component (Task #538)", () => {
  const orgId = 7;
  const course = { id: 42, name: "Test Course", holes: 18 };
  const existingContour = {
    courseId: 42,
    holeNumber: 1,
    originLat: "28.6139",
    originLng: "77.2090",
    rows: 3,
    cols: 3,
    cellMeters: "1.5",
    elevations: [0, 0.05, 0.1, -0.02, 0.04, 0.09, -0.05, 0, 0.06],
    source: "lidar",
    updatedAt: "2026-04-01T12:00:00Z",
  };

  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.endsWith("/holes/1/contour") && method === "GET") {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(existingContour),
        });
      }
      if (url.endsWith("/holes/1/contour") && method === "PUT") {
        const body = JSON.parse(String(init?.body ?? "{}"));
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({ ...existingContour, ...body, courseId: 42, holeNumber: 1 }),
        });
      }
      return Promise.resolve({
        ok: false,
        status: 404,
        json: () => Promise.resolve({}),
      });
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("loads existing contour for the selected hole and renders the heatmap preview", async () => {
    render(
      <GreenContourDialog open={true} onClose={() => {}} orgId={orgId} course={course} />,
    );

    await waitFor(() => {
      expect(screen.getByText(/Existing grid: 3×3 \(lidar\)/)).toBeInTheDocument();
    });

    expect(screen.getByText(/Preview — 3 × 3/)).toBeInTheDocument();
    expect(screen.getByLabelText("3 by 3 elevation grid")).toBeInTheDocument();

    const getCalls = fetchMock.mock.calls.filter(
      (c) => (c[1]?.method ?? "GET").toUpperCase() === "GET",
    );
    expect(getCalls.length).toBeGreaterThanOrEqual(1);
    expect(String(getCalls[0][0])).toContain(
      `/api/organizations/${orgId}/courses/${course.id}/holes/1/contour`,
    );
  });

  it("Save calls PUT with the parsed grid and current origin/cell payload", async () => {
    render(
      <GreenContourDialog open={true} onClose={() => {}} orgId={orgId} course={course} />,
    );

    await waitFor(() => {
      expect(screen.getByText(/Existing grid: 3×3 \(lidar\)/)).toBeInTheDocument();
    });

    const csv = "0.10,0.20,0.30\n0.05,0.15,0.25\n0.00,0.10,0.20";
    const textarea = screen.getByPlaceholderText(/0\.0, 0\.05, 0\.10/);
    fireEvent.change(textarea, { target: { value: csv } });

    await waitFor(() => {
      expect(screen.getByText(/Preview — 3 × 3/)).toBeInTheDocument();
    });

    const saveBtn = screen.getByRole("button", { name: /Replace contour/i });
    expect(saveBtn).not.toBeDisabled();
    fireEvent.click(saveBtn);

    await waitFor(() => {
      const putCall = fetchMock.mock.calls.find(
        (c) => (c[1]?.method ?? "").toUpperCase() === "PUT",
      );
      expect(putCall).toBeTruthy();
    });

    const putCall = fetchMock.mock.calls.find(
      (c) => (c[1]?.method ?? "").toUpperCase() === "PUT",
    )!;
    expect(String(putCall[0])).toBe(
      `/api/organizations/${orgId}/courses/${course.id}/holes/1/contour`,
    );
    const init = putCall[1] as RequestInit;
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    const body = JSON.parse(String(init.body));
    expect(body).toEqual({
      originLat: 28.6139,
      originLng: 77.209,
      rows: 3,
      cols: 3,
      cellMeters: 1.5,
      elevations: [0.1, 0.2, 0.3, 0.05, 0.15, 0.25, 0, 0.1, 0.2],
      source: "lidar",
    });
  });
});
