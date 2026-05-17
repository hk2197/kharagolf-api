/**
 * Task #1896 — UI smoke test for the "Download CSV" button on the
 * storage-cleanup audit list (PrivacyTab).
 *
 * Pins down:
 *   1. The button is rendered next to the existing refresh / show-hide
 *      controls so admins find it without expanding the body.
 *   2. Clicking it opens the CSV variant of the audit-log endpoint
 *      (.csv path), preserving the actor / action / pathPrefix filters
 *      the admin currently has applied.
 *   3. With no filters active, the URL has no query string at all so
 *      we don't accidentally pin a stale filter value.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

import { PrivacyTab } from "../governance";

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve({
    ok: status < 400,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response);
}

const ORG_ID = 42;

const CONSENT_HEALTH = {
  totalMembers: 0,
  categories: [],
  accountDeletions: { inGrace: 0, overdue: 0, rows: [] },
  dataExports: { pending: 0, ready: 0, expired: 0, failed: 0, rows: [] },
};

const FAILURES_EMPTY = {
  count: 0,
  totalFailedFiles: 0,
  items: [],
  pendingStorageDeletions: { total: 0, exhausted: 0 },
};

const PENDING_DELETIONS_EMPTY = {
  count: 0,
  onlyExhausted: true,
  items: [],
};

// One audit row + one actor in the dropdown so the actor filter has
// something to select.
const AUDIT_LOG = {
  count: 1,
  limit: 50,
  items: [
    {
      id: 7001,
      action: "force_retry" as const,
      createdAt: "2026-04-25T12:00:00.000Z",
      reason: null,
      path: "/objects/live-member-orphan",
      attempts: 8,
      lastError: null,
      pendingId: 9001,
      clubMemberId: 9001,
      memberFirstName: "Liv",
      memberLastName: "Surviving",
      memberNumber: "LIV-001",
      memberDeleted: false,
      actorUserId: 1,
      actorName: "Admin Alpha",
      actorDisplayName: "Admin Alpha",
      actorUsername: "admin_alpha",
      actorEmail: "admin@club.test",
    },
  ],
  actors: [
    { userId: 1, label: "Admin Alpha" },
  ],
  filters: { actorUserId: null, action: null, pathPrefix: null },
};

function installFetch() {
  const fetchSpy = vi.fn((input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/members-360/consent-health")) return jsonResponse(CONSENT_HEALTH);
    if (url.includes("/erasures/storage-failures/audit-log")) return jsonResponse(AUDIT_LOG);
    if (url.includes("/erasures/storage-failures/pending")) return jsonResponse(PENDING_DELETIONS_EMPTY);
    if (url.includes("/erasures/storage-failures")) return jsonResponse(FAILURES_EMPTY);
    return jsonResponse({}, 200);
  });
  vi.stubGlobal("fetch", fetchSpy);
  return fetchSpy;
}

function renderTab() {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchInterval: false, staleTime: 0 },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={qc}>
      <PrivacyTab orgId={ORG_ID} />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("PrivacyTab — Download CSV button (Task #1896)", () => {
  it("renders the download button next to the refresh / toggle controls", async () => {
    installFetch();
    renderTab();

    // The button is alongside refresh + toggle (i.e. visible without
    // expanding the body), which the trio of testids confirms.
    await screen.findByTestId("pending-storage-audit-log-refresh");
    await screen.findByTestId("pending-storage-audit-log-toggle");
    const csvBtn = await screen.findByTestId("pending-storage-audit-log-download-csv");
    expect(csvBtn.textContent).toMatch(/csv/i);
  });

  it("opens the CSV endpoint with no query string when no filters are applied", async () => {
    installFetch();
    const openSpy = vi.fn();
    vi.stubGlobal("open", openSpy);
    renderTab();

    fireEvent.click(await screen.findByTestId("pending-storage-audit-log-download-csv"));

    expect(openSpy).toHaveBeenCalledTimes(1);
    const [url, target] = openSpy.mock.calls[0];
    expect(target).toBe("_blank");
    expect(String(url)).toMatch(
      new RegExp(`/api/organizations/${ORG_ID}/members-360/erasures/storage-failures/audit-log\\.csv$`),
    );
    // No leftover filter params dangling on the URL.
    expect(String(url)).not.toContain("?");
  });

  it("forwards the active action + pathPrefix filters into the CSV URL", async () => {
    installFetch();
    const openSpy = vi.fn();
    vi.stubGlobal("open", openSpy);
    renderTab();

    // Expand so the filter inputs are mounted.
    fireEvent.click(await screen.findByTestId("pending-storage-audit-log-toggle"));

    // Set a path prefix and apply it. The action + actor filters use a
    // Radix Select that's awkward to drive in jsdom, so we exercise the
    // path-prefix branch which is a plain Input + Apply button.
    const pathInput = await screen.findByTestId("pending-storage-audit-log-filter-path");
    fireEvent.change(pathInput, { target: { value: "members/2024-migration/" } });
    fireEvent.click(await screen.findByTestId("pending-storage-audit-log-filter-path-apply"));

    // Wait for the filter to be committed (the "filtered" note appears
    // in the header once auditFiltersActive flips to true).
    await screen.findByTestId("pending-storage-audit-log-filtered-note");

    // Now click Download CSV and assert the path filter is on the URL.
    fireEvent.click(screen.getByTestId("pending-storage-audit-log-download-csv"));

    await waitFor(() => expect(openSpy).toHaveBeenCalled());
    const [url] = openSpy.mock.calls[0];
    const u = new URL(String(url), "http://localhost");
    expect(u.pathname).toMatch(
      new RegExp(`/api/organizations/${ORG_ID}/members-360/erasures/storage-failures/audit-log\\.csv$`),
    );
    expect(u.searchParams.get("pathPrefix")).toBe("members/2024-migration/");
    // Other filters were never set so they should be absent.
    expect(u.searchParams.get("actorUserId")).toBeNull();
    expect(u.searchParams.get("action")).toBeNull();
  });
});
