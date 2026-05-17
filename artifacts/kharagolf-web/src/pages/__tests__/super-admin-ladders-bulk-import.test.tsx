/**
 * Unit + UI tests for the ladder CSV bulk-import flow on the super-admin
 * ladder management panel (Task #748).
 *
 * Covers:
 *   - parseCsv (quoted fields, CRLF, BOM, blank rows, missing trailing newline)
 *   - Header validation (missing required columns, header normalization)
 *   - Row validation (unknown player, non-participating club, missing scores
 *     per format) and partial-import success/error reporting
 *   - The downloadable CSV template (button click + content shape)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import {
  parseCsv,
  CSV_HEADERS,
  TEMPLATE_CSV,
  BulkImportPanel,
} from "../super-admin-ladders";

// jsdom's Blob/File don't implement .text() — polyfill via FileReader so that
// the panel's `await file.text()` and our template-blob assertion both work.
function polyfillBlobText() {
  const proto = (globalThis as { Blob: typeof Blob }).Blob.prototype as Blob & {
    text?: () => Promise<string>;
  };
  if (typeof proto.text !== "function") {
    proto.text = function (this: Blob): Promise<string> {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result ?? ""));
        reader.onerror = () => reject(reader.error);
        reader.readAsText(this);
      });
    };
  }
}
polyfillBlobText();

// ─── parseCsv unit tests ────────────────────────────────────────────────────

describe("parseCsv", () => {
  it("parses a simple header + rows", () => {
    const { headers, rows } = parseCsv("a,b,c\n1,2,3\n4,5,6\n");
    expect(headers).toEqual(["a", "b", "c"]);
    expect(rows).toEqual([
      ["1", "2", "3"],
      ["4", "5", "6"],
    ]);
  });

  it("handles quoted fields containing commas, newlines, and escaped quotes", () => {
    const text =
      'player,notes\n' +
      '"Doe, Jane","line1\nline2"\n' +
      '"Smith ""JR"" John","ok"\n';
    const { headers, rows } = parseCsv(text);
    expect(headers).toEqual(["player", "notes"]);
    expect(rows).toEqual([
      ["Doe, Jane", "line1\nline2"],
      ['Smith "JR" John', "ok"],
    ]);
  });

  it("strips a UTF-8 BOM from the first header", () => {
    const text = "\uFEFFplayer,club\nJane,PB\n";
    const { headers, rows } = parseCsv(text);
    expect(headers).toEqual(["player", "club"]);
    expect(rows).toEqual([["Jane", "PB"]]);
  });

  it("treats CRLF line endings the same as LF", () => {
    const { headers, rows } = parseCsv("a,b\r\n1,2\r\n3,4\r\n");
    expect(headers).toEqual(["a", "b"]);
    expect(rows).toEqual([["1", "2"], ["3", "4"]]);
  });

  it("drops fully-blank rows but keeps rows with any non-empty cell", () => {
    const text = "a,b\n1,2\n\n,\n3,\n";
    const { rows } = parseCsv(text);
    // The empty line and the all-empty ",\n" line are dropped;
    // "3," is kept because it has at least one non-empty cell.
    expect(rows).toEqual([
      ["1", "2"],
      ["3", ""],
    ]);
  });

  it("captures the final row even without a trailing newline", () => {
    const { rows } = parseCsv("a,b\n1,2");
    expect(rows).toEqual([["1", "2"]]);
  });

  it("returns empty headers and rows for empty input", () => {
    expect(parseCsv("")).toEqual({ headers: [], rows: [] });
  });
});

describe("TEMPLATE_CSV", () => {
  it("declares all canonical headers in order", () => {
    const { headers, rows } = parseCsv(TEMPLATE_CSV);
    expect(headers).toEqual([...CSV_HEADERS]);
    // Two example rows shipped in the template, one stableford + one stroke
    expect(rows.length).toBe(2);
    const stablefordIdx = headers.indexOf("stableford");
    const grossIdx = headers.indexOf("gross");
    const netIdx = headers.indexOf("net");
    expect(rows[0][stablefordIdx]).not.toBe("");
    expect(rows[1][grossIdx]).not.toBe("");
    expect(rows[1][netIdx]).not.toBe("");
  });
});

// ─── BulkImportPanel UI tests ───────────────────────────────────────────────

const PARTICIPATING_CLUBS = [
  { id: 1, organizationId: 11, orgName: "Pebble Beach", orgSlug: "pebble", joinedAt: "2026-01-01" },
  { id: 2, organizationId: 22, orgName: "St Andrews", orgSlug: "st-andrews", joinedAt: "2026-01-01" },
];

const ENTRIES = [
  { id: 101, ladderId: 7, userId: 1, homeOrganizationId: 11, playerName: "Jane Doe", division: 1, totalPoints: 0, roundsCounted: 0, position: null },
  { id: 102, ladderId: 7, userId: 2, homeOrganizationId: 22, playerName: "John Smith", division: 1, totalPoints: 0, roundsCounted: 0, position: null },
];

interface Captured {
  url: string;
  body: Record<string, unknown>;
}

let postedRequests: Captured[] = [];
let postFailures: Map<string, { status: number; error?: string }>;

function installFetch() {
  postedRequests = [];
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (init?.method === "POST" && url.includes("/results")) {
      const body = JSON.parse(String(init.body));
      postedRequests.push({ url, body });
      const failKey = `${body.entryId}:${body.roundDate}`;
      const failure = postFailures.get(failKey);
      if (failure) {
        return new Response(
          JSON.stringify({ error: failure.error ?? "Server rejected" }),
          { status: failure.status, headers: { "Content-Type": "application/json" } },
        ) as unknown as Response;
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200, headers: { "Content-Type": "application/json" },
      }) as unknown as Response;
    }
    return new Response("not found", { status: 404 }) as unknown as Response;
  }) as typeof fetch;
}

function renderPanel(format: "stableford" | "stroke" | "national_ladder" = "stableford") {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchInterval: false, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={qc}>
      <BulkImportPanel
        ladderId={7}
        format={format}
        entries={ENTRIES}
        participatingClubs={PARTICIPATING_CLUBS}
      />
    </QueryClientProvider>,
  );
}

function csvFile(content: string, name = "results.csv") {
  return new File([content], name, { type: "text/csv" });
}

beforeEach(() => {
  postFailures = new Map();
  installFetch();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("<BulkImportPanel /> — header & row validation", () => {
  it("normalizes header variants (case, spaces, underscores, dashes)", async () => {
    const user = userEvent.setup();
    renderPanel("stableford");

    const csv =
      "Player,Round Date,Club,STABLEFORD,Gross,Net,Notes\n" +
      "Jane Doe,2026-04-15,Pebble Beach,38,,,\n";

    await user.upload(screen.getByTestId("input-csv-file-7"), csvFile(csv));
    expect(screen.queryByTestId("text-csv-parse-error-7")).not.toBeInTheDocument();

    const importBtn = await screen.findByTestId("button-import-csv-7");
    expect(importBtn).toHaveTextContent(/Import 1 rows/);
    await user.click(importBtn);

    await waitFor(() => {
      expect(screen.getByTestId("bulk-results-7").textContent).toMatch(/1 succeeded, 0 failed/);
    });
    expect(postedRequests).toHaveLength(1);
    expect(postedRequests[0].body).toMatchObject({
      entryId: 101,
      roundDate: "2026-04-15",
      organizationId: 11,
      stablefordPoints: 38,
    });

    cleanup();
    postedRequests = [];

    // Underscore + dash variants of the same headers are also accepted
    renderPanel("stableford");
    const csv2 =
      "player,round_date,club,stable-ford,gross,net,notes\n" +
      "John Smith,2026-04-16,St Andrews,42,,,\n";
    await user.upload(screen.getByTestId("input-csv-file-7"), csvFile(csv2));
    expect(screen.queryByTestId("text-csv-parse-error-7")).not.toBeInTheDocument();
    await user.click(await screen.findByTestId("button-import-csv-7"));
    await waitFor(() => {
      expect(screen.getByTestId("bulk-results-7").textContent).toMatch(/1 succeeded, 0 failed/);
    });
    expect(postedRequests[0].body).toMatchObject({
      entryId: 102,
      roundDate: "2026-04-16",
      organizationId: 22,
      stablefordPoints: 42,
    });
  });

  it("surfaces a parse error when required columns are missing", async () => {
    const user = userEvent.setup();
    renderPanel("stableford");

    const input = screen.getByTestId("input-csv-file-7") as HTMLInputElement;
    // 'club' column is missing
    await user.upload(input, csvFile("player,roundDate,stableford\nJane Doe,2026-04-15,38\n"));

    const err = await screen.findByTestId("text-csv-parse-error-7");
    expect(err.textContent).toMatch(/Missing required column\(s\): club/);
    // Import button stays effectively unusable
    expect(screen.queryByText(/Import 1 rows/)).not.toBeInTheDocument();
  });

  it("imports a partial batch: success + unknown player + non-participating club + missing score", async () => {
    const user = userEvent.setup();
    renderPanel("stableford");

    const csv =
      "player,roundDate,club,stableford,gross,net,notes\n" +
      "Jane Doe,2026-04-15,Pebble Beach,38,,,Front nine windy\n" +
      "Ghost Player,2026-04-15,Pebble Beach,40,,,\n" +
      "John Smith,2026-04-15,Augusta,42,,,\n" +
      "John Smith,2026-04-16,St Andrews,,,,no score\n";

    await user.upload(screen.getByTestId("input-csv-file-7"), csvFile(csv));

    const importBtn = await screen.findByTestId("button-import-csv-7");
    expect(importBtn).toHaveTextContent(/Import 4 rows/);
    await user.click(importBtn);

    // Wait for all 4 rows to be processed
    await waitFor(() => {
      expect(screen.getByTestId("bulk-results-7").textContent).toMatch(/1 succeeded, 3 failed/);
    });

    // Exactly one POST hit the API (only the valid row)
    expect(postedRequests).toHaveLength(1);
    expect(postedRequests[0].url).toContain("/api/cross-club-ladders/7/results");
    expect(postedRequests[0].body).toMatchObject({
      entryId: 101,
      roundDate: "2026-04-15",
      organizationId: 11,
      stablefordPoints: 38,
      notes: "Front nine windy",
    });

    // Per-row feedback messages
    expect(screen.getByTestId("bulk-row-2").textContent).toMatch(/Posted/);
    expect(screen.getByTestId("bulk-row-3").textContent).toMatch(/No registered entry for player "Ghost Player"/);
    expect(screen.getByTestId("bulk-row-4").textContent).toMatch(/Club "Augusta" is not a participating club/);
    expect(screen.getByTestId("bulk-row-5").textContent).toMatch(/Stableford points required/);
  });

  it("requires gross or net (not stableford) for stroke-format ladders and matches club by slug", async () => {
    const user = userEvent.setup();
    renderPanel("stroke");

    const csv =
      "player,roundDate,club,stableford,gross,net,notes\n" +
      // matched by slug "pebble" + only net score → success
      "Jane Doe,2026-04-15,pebble,,,71,\n" +
      // no gross AND no net → error
      "John Smith,2026-04-15,St Andrews,38,,,\n";

    await user.upload(screen.getByTestId("input-csv-file-7"), csvFile(csv));
    await user.click(await screen.findByTestId("button-import-csv-7"));

    await waitFor(() => {
      expect(screen.getByTestId("bulk-results-7").textContent).toMatch(/1 succeeded, 1 failed/);
    });

    expect(postedRequests).toHaveLength(1);
    expect(postedRequests[0].body).toMatchObject({
      entryId: 101,
      organizationId: 11, // resolved via slug
      netScore: 71,
    });
    expect(postedRequests[0].body).not.toHaveProperty("stablefordPoints");
    expect(postedRequests[0].body).not.toHaveProperty("grossScore");

    expect(screen.getByTestId("bulk-row-3").textContent).toMatch(/Gross or net score required/);
  });

  it("propagates server errors per-row while still posting other rows", async () => {
    postFailures.set("102:2026-04-15", { status: 409, error: "Duplicate result" });
    const user = userEvent.setup();
    renderPanel("stableford");

    const csv =
      "player,roundDate,club,stableford\n" +
      "Jane Doe,2026-04-15,Pebble Beach,38\n" +
      "John Smith,2026-04-15,St Andrews,42\n";

    await user.upload(screen.getByTestId("input-csv-file-7"), csvFile(csv));
    await user.click(await screen.findByTestId("button-import-csv-7"));

    await waitFor(() => {
      expect(screen.getByTestId("bulk-results-7").textContent).toMatch(/1 succeeded, 1 failed/);
    });

    expect(postedRequests).toHaveLength(2);
    expect(screen.getByTestId("bulk-row-2").textContent).toMatch(/Posted/);
    expect(screen.getByTestId("bulk-row-3").textContent).toMatch(/Duplicate result/);
  });
});

describe("<BulkImportPanel /> — downloadable template", () => {
  it("creates a Blob URL and clicks an anchor with the expected filename", async () => {
    const created: Blob[] = [];
    const createObjectURL = vi.fn((blob: Blob) => {
      created.push(blob);
      return "blob:fake-url";
    });
    const revokeObjectURL = vi.fn();
    // jsdom doesn't implement these — capture the originals so we can restore
    // them after the test to avoid leaking into other suites.
    const urlAny = URL as unknown as Record<string, unknown>;
    const origCreate = urlAny.createObjectURL;
    const origRevoke = urlAny.revokeObjectURL;
    Object.defineProperty(URL, "createObjectURL", { value: createObjectURL, writable: true, configurable: true });
    Object.defineProperty(URL, "revokeObjectURL", { value: revokeObjectURL, writable: true, configurable: true });

    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    const user = userEvent.setup();
    renderPanel("stableford");

    await user.click(screen.getByTestId("button-download-template-7"));

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:fake-url");
    expect(clickSpy).toHaveBeenCalledTimes(1);

    // Anchor was created with the right download filename
    const anchor = clickSpy.mock.instances[0] as HTMLAnchorElement;
    expect(anchor.download).toBe("ladder-results-template.csv");
    expect(anchor.href).toBe("blob:fake-url");

    // Blob content matches the exported template constant and parses cleanly
    expect(created).toHaveLength(1);
    const text = await created[0].text();
    expect(text).toBe(TEMPLATE_CSV);
    const { headers } = parseCsv(text);
    expect(headers).toEqual([...CSV_HEADERS]);

    clickSpy.mockRestore();
    if (origCreate === undefined) {
      delete urlAny.createObjectURL;
    } else {
      Object.defineProperty(URL, "createObjectURL", { value: origCreate, writable: true, configurable: true });
    }
    if (origRevoke === undefined) {
      delete urlAny.revokeObjectURL;
    } else {
      Object.defineProperty(URL, "revokeObjectURL", { value: origRevoke, writable: true, configurable: true });
    }
  });
});
