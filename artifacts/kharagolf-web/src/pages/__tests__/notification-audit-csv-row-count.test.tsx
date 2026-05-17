/**
 * Task #1624 — Verifies the audit page shows the matching row count in
 * the Download CSV affordance once the JSON list endpoint has answered,
 * and gates "obviously large" downloads behind a one-tap confirmation
 * dialog so admins don't accidentally pull a multi-megabyte file.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";

import NotificationAuditPage from "../notification-audit";

interface FetchCall { url: string }
let fetchCalls: FetchCall[];
let auditTotal: number;
// Task #2007 — Per-test override for the server-supplied CSV size hint.
// `null` means "omit the field" so we can also exercise the legacy
// (no-hint) rendering path that older servers would produce.
let auditCsvEstimate:
  | { avgRowBytes: number | null; headerBytes: number }
  | null;

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve({
    ok: status < 400,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response);
}

function makeAuditBody(total: number) {
  const body: Record<string, unknown> = {
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
  if (auditCsvEstimate !== null) body.csvEstimate = auditCsvEstimate;
  return body;
}

beforeEach(() => {
  fetchCalls = [];
  auditTotal = 0;
  auditCsvEstimate = null;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      fetchCalls.push({ url });
      if (url.endsWith("/api/auth/me")) return jsonResponse({ role: "org_admin" });
      if (url.startsWith("/api/admin/notification-audit")) return jsonResponse(makeAuditBody(auditTotal));
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

describe("NotificationAuditPage Download CSV row count (Task #1624)", () => {
  it("shows the matching row count in the button label once data loads", async () => {
    auditTotal = 1243;
    renderPage();

    const btn = await waitFor(() => {
      const el = screen.getByTestId("button-download-audit-csv");
      // Wait until the count appears; before the JSON endpoint resolves
      // the label is just "Download CSV".
      if (!el.textContent?.includes("1,243")) throw new Error("count not yet rendered");
      return el;
    });

    expect(btn.textContent).toContain("Download CSV");
    expect(btn.textContent).toContain("1,243 rows");
    // Task #2015 — The download is now driven by a fetch + streaming
    // reader so we can show in-page progress, so the trigger is a
    // real <button>. The earlier assertion that this was an <a> with
    // href + download attributes was specific to the pre-progress
    // anchor implementation it replaced.
    expect(btn.tagName).toBe("BUTTON");
  });

  it("uses singular 'row' when exactly one row matches", async () => {
    auditTotal = 1;
    renderPage();

    await waitFor(() => {
      const el = screen.getByTestId("button-download-audit-csv");
      if (!el.textContent?.includes("1 row")) throw new Error("singular not yet rendered");
      // Make sure we got "1 row", not "1 rows".
      expect(el.textContent).toContain("(1 row)");
    });
  });

  it("intercepts the click and shows a confirm dialog when the count exceeds the large-download threshold", async () => {
    auditTotal = 50_000;
    renderPage();

    const btn = await waitFor(() => {
      const el = screen.getByTestId("button-download-audit-csv");
      if (!el.textContent?.includes("50,000")) throw new Error("count not yet rendered");
      return el;
    });

    // For very large totals the affordance is a plain <button>, not an
    // <a>, because clicking it opens the confirm dialog instead of
    // starting the download immediately.
    expect(btn.tagName).toBe("BUTTON");
    expect(btn.textContent).toContain("50,000 rows");

    fireEvent.click(btn);

    const dialog = await screen.findByTestId("dialog-confirm-large-csv");
    expect(dialog).toBeTruthy();
    expect(screen.getByTestId("text-confirm-csv-row-count").textContent).toBe("50,000");

    // Task #2015 — The confirm action now triggers the same fetch
    // + streaming-progress flow as the small-file path so the admin
    // sees an in-page banner during the multi-second download. It's
    // a real <button>, not the previous bare <a>.
    const confirmBtn = screen.getByTestId("button-confirm-large-csv");
    expect(confirmBtn.tagName).toBe("BUTTON");
  });

  // Task #2007 — When the JSON list endpoint returns a per-row size hint
  // we render an "~480 KB" / "~12 MB" suffix next to the row count so
  // admins can decide whether to start the download without finding
  // out post-hoc that it's 50 MB.
  it("appends an estimated download size to the button label when the server supplies a hint", async () => {
    auditTotal = 1243;
    // 1243 rows × 400 bytes/row = 497,200 bytes ≈ 486 KB. Add the 80
    // header bytes and we're still well into the "~486 KB" bucket.
    auditCsvEstimate = { avgRowBytes: 400, headerBytes: 80 };
    renderPage();

    const btn = await waitFor(() => {
      const el = screen.getByTestId("button-download-audit-csv");
      if (!el.textContent?.includes("KB")) throw new Error("size suffix not yet rendered");
      return el;
    });

    expect(btn.textContent).toContain("1,243 rows");
    // "·" separator between row count and size hint, prefixed with "~"
    // so it reads as an estimate.
    expect(btn.textContent).toMatch(/1,243 rows · ~\d/);
    expect(btn.textContent).toContain("KB");
    // Size estimate should be in the right ballpark (within ±25 % of the
    // expected ~486 KB) — we don't pin the exact display because the
    // formatter rounds to 0 / 1 / 2 decimal places depending on
    // magnitude, but it must be a 3-digit KB figure.
    expect(btn.textContent).toMatch(/~4\d{2} KB/);
  });

  it("formats the size hint in MB for very large exports", async () => {
    auditTotal = 50_000;
    // 50_000 × 600 bytes ≈ 30 MB.
    auditCsvEstimate = { avgRowBytes: 600, headerBytes: 80 };
    renderPage();

    const btn = await waitFor(() => {
      const el = screen.getByTestId("button-download-audit-csv");
      if (!el.textContent?.includes("MB")) throw new Error("MB suffix not yet rendered");
      return el;
    });

    expect(btn.textContent).toContain("50,000 rows");
    expect(btn.textContent).toMatch(/~\d+(\.\d+)? MB/);

    // Confirm dialog also surfaces the size so the "should I download
    // this on coffee-shop wifi?" decision is obvious before clicking
    // through.
    fireEvent.click(btn);
    await screen.findByTestId("dialog-confirm-large-csv");
    const sizeEl = screen.getByTestId("text-confirm-csv-size");
    expect(sizeEl.textContent).toMatch(/~\d+(\.\d+)? MB/);
  });

  it("omits the size suffix when the server does not supply a hint (legacy server)", async () => {
    auditTotal = 1243;
    // Default is no hint — should fall back to the row-count-only label.
    renderPage();

    const btn = await waitFor(() => {
      const el = screen.getByTestId("button-download-audit-csv");
      if (!el.textContent?.includes("1,243")) throw new Error("count not yet rendered");
      return el;
    });

    expect(btn.textContent).toContain("1,243 rows");
    // No size suffix at all — neither "KB" nor "MB" nor a tilde.
    expect(btn.textContent).not.toContain("·");
    expect(btn.textContent).not.toContain("KB");
    expect(btn.textContent).not.toContain("MB");
    expect(btn.textContent).not.toContain("~");
  });

  it("omits the size suffix when the server reports avgRowBytes=null (no sample)", async () => {
    auditTotal = 1243;
    // Filtered-to-empty server response: hint is present but avg is null
    // because no rows were available to sample. Client should treat
    // that the same as "no estimate".
    auditCsvEstimate = { avgRowBytes: null, headerBytes: 80 };
    renderPage();

    const btn = await waitFor(() => {
      const el = screen.getByTestId("button-download-audit-csv");
      if (!el.textContent?.includes("1,243")) throw new Error("count not yet rendered");
      return el;
    });

    expect(btn.textContent).toContain("1,243 rows");
    expect(btn.textContent).not.toContain("·");
    expect(btn.textContent).not.toContain("~");
  });

  it("closes the confirm dialog when the user cancels and never starts the download", async () => {
    auditTotal = 50_000;
    renderPage();

    const btn = await waitFor(() => {
      const el = screen.getByTestId("button-download-audit-csv");
      if (!el.textContent?.includes("50,000")) throw new Error("count not yet rendered");
      return el;
    });
    fireEvent.click(btn);

    await screen.findByTestId("dialog-confirm-large-csv");
    fireEvent.click(screen.getByTestId("button-cancel-large-csv"));

    await waitFor(() => {
      expect(screen.queryByTestId("dialog-confirm-large-csv")).toBeNull();
    });

    // The page should never have requested the .csv endpoint — only
    // /api/auth/me and the JSON list endpoint.
    expect(fetchCalls.some(c => c.url.includes("/api/admin/notification-audit.csv"))).toBe(false);
  });
});
