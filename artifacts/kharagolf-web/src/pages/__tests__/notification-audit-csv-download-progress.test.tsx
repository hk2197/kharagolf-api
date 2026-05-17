/**
 * Task #2015 — Verifies the admin Communications notification-audit page
 * surfaces a live progress indicator (and surfaces a clear error) while
 * the streaming `/api/admin/notification-audit.csv` download is in
 * flight, and disables the trigger button so a double-click can't
 * spawn a second concurrent download.
 *
 * The CSV endpoint streams row-by-row over chunked transfer-encoding,
 * so for very large exports the response can take many seconds to
 * finish even though the first byte arrives almost immediately. Without
 * the progress banner the admin couldn't tell whether anything was
 * happening; this test exercises the banner across the success, error,
 * and double-fire paths.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";

import NotificationAuditPage from "../notification-audit";

interface FetchCall { url: string; init?: RequestInit }
let fetchCalls: FetchCall[];
let auditTotal: number;

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve({
    ok: status < 400,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response);
}

function makeAuditBody(total: number) {
  return {
    entries: [
      {
        id: 1,
        notificationKey: "handicap.committee.changed",
        userId: 42,
        userDisplayName: "Player A",
        username: "playerA",
        userEmail: "a@example.com",
        channel: "email",
        status: "sent",
        reason: null,
        payload: {},
        createdAt: "2026-04-20T10:00:00.000Z",
      },
    ],
    total,
    page: 1,
    limit: 50,
    facets: { keys: ["handicap.committee.changed"], channels: ["email"], statuses: ["sent"] },
  };
}

// Build a fake streaming Response whose body emits the supplied chunks
// one at a time, gated on a per-chunk promise. Each chunk's resolver is
// returned so the test can drip them out and assert the in-flight UI
// between drips. The final auto-resolves on `flushAll()` so cleanup
// doesn't leave dangling promises.
function makeStreamingCsvResponse(chunks: string[]) {
  const encoder = new TextEncoder();
  const gates: Array<() => void> = [];
  let cancelled = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (let i = 0; i < chunks.length; i++) {
        await new Promise<void>((resolve) => {
          gates.push(resolve);
        });
        if (cancelled) {
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(chunks[i]));
      }
      controller.close();
    },
    cancel() { cancelled = true; },
  });

  const response = new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": 'attachment; filename="notification-audit-2026.csv"',
    },
  });

  return {
    response,
    async releaseChunk(idx: number) {
      // Wait until the stream has registered its `await` for this
      // gate, then resolve it. Polling keeps us decoupled from the
      // microtask scheduling order.
      let waited = 0;
      while (gates[idx] === undefined) {
        await new Promise((r) => setTimeout(r, 0));
        waited += 1;
        if (waited > 200) throw new Error(`gate ${idx} never registered`);
      }
      const release = gates[idx]!;
      gates[idx] = (() => {}) as () => void;
      release();
    },
    flushAll() {
      for (const g of gates) {
        try { g(); } catch { /* best effort */ }
      }
    },
  };
}

let csvResponseFactory:
  | (() => Promise<Response> | Response)
  | null;

beforeEach(() => {
  fetchCalls = [];
  auditTotal = 50_000; // default to "above the large-CSV threshold"
  csvResponseFactory = null;

  // Stub out URL.createObjectURL / revokeObjectURL — jsdom doesn't
  // implement them and the download path uses both to hand the
  // assembled blob to a synthesized anchor click.
  vi.stubGlobal("URL", {
    ...URL,
    createObjectURL: vi.fn(() => "blob:mock-url"),
    revokeObjectURL: vi.fn(),
  });

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      fetchCalls.push({ url, init });
      if (url.endsWith("/api/auth/me")) return jsonResponse({ role: "org_admin" });
      if (url.startsWith("/api/admin/notification-audit.csv")) {
        if (!csvResponseFactory) {
          throw new Error("test did not configure a CSV response factory");
        }
        return await csvResponseFactory();
      }
      if (url.startsWith("/api/admin/notification-audit")) {
        return jsonResponse(makeAuditBody(auditTotal));
      }
      return jsonResponse({}, 404);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function renderPage() {
  const { hook, searchHook } = memoryLocation({ path: "/admin/notification-audit", searchPath: "" });
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchInterval: false, staleTime: 0 },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={qc}>
      <Router hook={hook} searchHook={searchHook}>
        <NotificationAuditPage />
      </Router>
    </QueryClientProvider>,
  );
}

describe("NotificationAuditPage CSV download progress (Task #2015)", () => {
  it("shows a streaming progress banner with row count and disables the trigger while in flight", async () => {
    auditTotal = 50_000;
    // The header line + a couple of data rows; the page counts
    // newlines and reports `(newlines - 1)` so the user sees the
    // running data-row tally, not "header + rows".
    const stream = makeStreamingCsvResponse([
      "when,key,user,email,channel,status,reason,payload\n",
      "2026-04-20T10:00:00Z,k,u,e@example.com,email,sent,,{}\n",
      "2026-04-20T10:00:01Z,k,u,e@example.com,email,sent,,{}\n",
    ]);
    csvResponseFactory = () => stream.response;

    renderPage();

    // Wait for the page to finish loading the JSON list so the
    // download button is rendered with the row count.
    const trigger = await waitFor(() => {
      const el = screen.getByTestId("button-download-audit-csv");
      if (!el.textContent?.includes("50,000")) throw new Error("count not rendered");
      return el;
    });

    // Large counts go through the confirmation dialog.
    fireEvent.click(trigger);
    const confirm = await screen.findByTestId("button-confirm-large-csv");
    fireEvent.click(confirm);

    // The progress banner should appear immediately; the trigger
    // button flips to disabled with a "Downloading…" label.
    await waitFor(() => {
      expect(screen.getByTestId("audit-download-progress")).toBeTruthy();
    });
    expect(screen.getByTestId("button-download-audit-csv")).toBeDisabled();
    expect(screen.getByTestId("button-download-audit-csv").textContent)
      .toContain("Downloading…");
    expect(screen.getByTestId("icon-download-audit-csv-spinner")).toBeTruthy();

    // Drip in the header chunk — the running count is still 0 data
    // rows because the only newline so far is the header.
    await act(async () => { await stream.releaseChunk(0); });
    await waitFor(() => {
      const banner = screen.getByTestId("audit-download-progress");
      // bytes-only state when no data rows have been seen yet
      expect(banner.textContent).toContain("received");
    });

    // Drip in the next data row — the banner should now report "1 row"
    // before we release the final chunk. We deliberately verify the
    // running tally on this intermediate state because that's the
    // whole point of the indicator: it has to update mid-stream, not
    // just flash on / off at the very end.
    await act(async () => { await stream.releaseChunk(1); });
    await waitFor(() => {
      expect(screen.getByTestId("text-download-progress-rows").textContent).toBe("1");
    });

    // Release the remaining chunk so the stream can drain. We don't
    // assert the "2 rows" intermediate state because the post-stream
    // cleanup (Blob + idle) can coalesce with that final state
    // update in the same render commit; the meaningful guarantee is
    // that the banner clears and the trigger re-enables once the
    // download finishes.
    await act(async () => { await stream.releaseChunk(2); });
    await waitFor(() => {
      expect(screen.queryByTestId("audit-download-progress")).toBeNull();
    });
    expect(screen.getByTestId("button-download-audit-csv")).not.toBeDisabled();
    expect(screen.getByTestId("button-download-audit-csv").textContent)
      .toContain("Download CSV");
  });

  it("surfaces a clear error banner when the streaming download fails partway", async () => {
    auditTotal = 200; // small enough to skip the confirm dialog
    csvResponseFactory = () => Promise.resolve(new Response(null, {
      status: 500,
      statusText: "Internal Server Error",
    }));

    renderPage();

    const trigger = await waitFor(() => {
      const el = screen.getByTestId("button-download-audit-csv");
      if (!el.textContent?.includes("200")) throw new Error("count not rendered");
      return el;
    });
    fireEvent.click(trigger);

    // The error banner should appear with the server's status code,
    // and the trigger should be re-enabled so the admin can retry
    // immediately rather than being stuck.
    const banner = await screen.findByTestId("audit-download-error");
    expect(banner.textContent).toContain("CSV download failed");
    const message = screen.getByTestId("text-download-error-message");
    expect(message.textContent).toMatch(/500/);
    expect(screen.getByTestId("button-download-audit-csv")).not.toBeDisabled();

    // Dismissing the banner should clear it.
    fireEvent.click(screen.getByTestId("button-dismiss-download-error"));
    await waitFor(() => {
      expect(screen.queryByTestId("audit-download-error")).toBeNull();
    });
  });

  it("offers a 'Try again' button on the error banner that re-fires the download", async () => {
    auditTotal = 200;
    let attempt = 0;
    csvResponseFactory = () => {
      attempt += 1;
      if (attempt === 1) {
        return Promise.resolve(new Response(null, {
          status: 503,
          statusText: "Service Unavailable",
        }));
      }
      // Second attempt succeeds.
      return Promise.resolve(new Response(
        new TextEncoder().encode(
          "when,key,user,email,channel,status,reason,payload\n" +
          "2026-04-20T10:00:00Z,k,u,e@example.com,email,sent,,{}\n",
        ),
        {
          status: 200,
          headers: {
            "content-type": "text/csv; charset=utf-8",
            "content-disposition": 'attachment; filename="audit.csv"',
          },
        },
      ));
    };

    renderPage();

    const trigger = await waitFor(() => screen.getByTestId("button-download-audit-csv"));
    fireEvent.click(trigger);
    await screen.findByTestId("audit-download-error");

    fireEvent.click(screen.getByTestId("button-retry-download"));

    // Error banner should clear after the retry succeeds.
    await waitFor(() => {
      expect(screen.queryByTestId("audit-download-error")).toBeNull();
    });
    expect(attempt).toBe(2);
  });

  it("ignores a second click on the trigger while a download is already in flight", async () => {
    auditTotal = 200;
    const stream = makeStreamingCsvResponse([
      "when,key,user,email,channel,status,reason,payload\n",
      "row,row,row,row,row,row,row,{}\n",
    ]);
    csvResponseFactory = () => stream.response;

    renderPage();

    const trigger = await waitFor(() => screen.getByTestId("button-download-audit-csv"));
    fireEvent.click(trigger);

    // While in-flight: click again. The button is disabled, so the
    // event shouldn't fire a new fetch — the one in-flight CSV
    // request remains the only one.
    await waitFor(() => {
      expect(screen.getByTestId("button-download-audit-csv")).toBeDisabled();
    });
    fireEvent.click(trigger);

    // Drain the stream so the test exits cleanly.
    await act(async () => {
      await stream.releaseChunk(0);
      await stream.releaseChunk(1);
    });
    await waitFor(() => {
      expect(screen.queryByTestId("audit-download-progress")).toBeNull();
    });

    // Exactly one CSV request — the second click was a no-op.
    const csvCalls = fetchCalls.filter(c => c.url.includes("/api/admin/notification-audit.csv"));
    expect(csvCalls.length).toBe(1);
  });
});
