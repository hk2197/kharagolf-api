/**
 * Task #1916 — super-admin Ops Alert card surfaces "Last test sent
 * <relative time> ago to N recipient(s) by <author>." next to the
 * Send/Save/Reset buttons so admins can see at a glance whether a
 * fresh test send is needed (and stop firing duplicate test emails
 * "just in case", which floods on-call inboxes).
 *
 * Covers:
 *   - Renders the relative timestamp + recipient count + author display
 *     name when the GET /super-admin/ops-alert-settings response carries
 *     last-test metadata.
 *   - Pluralises "recipient" correctly for N === 1 vs N > 1.
 *   - Falls back to the empty-state copy when the metadata is null.
 *   - Posting the test endpoint refreshes the card so a refetched
 *     response with newer last-test metadata replaces stale text.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@workspace/api-client-react", () => ({
  useGetMe: () => ({ data: { id: 1, organizationId: 1, role: "super_admin" } }),
}));

const toastMock = vi.fn();
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: toastMock }),
}));

vi.mock("wouter", () => ({
  useLocation: () => ["/super-admin", vi.fn()],
}));

import SuperAdminPage from "../super-admin";

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve({
    ok: status < 400,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response);
}

interface LastTestFields {
  lastTestSentAt: string | null;
  lastTestSentByUserId: number | null;
  lastTestSentByDisplayName: string | null;
  lastTestSentByUsername: string | null;
  lastTestRecipientCount: number | null;
}

const NULL_LAST_TEST: LastTestFields = {
  lastTestSentAt: null,
  lastTestSentByUserId: null,
  lastTestSentByDisplayName: null,
  lastTestSentByUsername: null,
  lastTestRecipientCount: null,
};

function buildOpsConfig(lastTest: LastTestFields) {
  return {
    threshold: 5,
    windowHours: 24,
    source: { threshold: "default" as const, windowHours: "default" as const },
    dbThreshold: null,
    dbWindowHours: null,
    envThreshold: null,
    envWindowHours: null,
    defaultThreshold: 5,
    defaultWindowHours: 24,
    manualEntry: {
      rateThresholdPct: 30,
      minSample: 20,
      consecutiveZero: 3,
      cooldownHours: 6,
      source: {
        rateThresholdPct: "default" as const,
        minSample: "default" as const,
        consecutiveZero: "default" as const,
        cooldownHours: "default" as const,
      },
      dbRateThresholdPct: null,
      dbMinSample: null,
      dbConsecutiveZero: null,
      dbCooldownHours: null,
      envRateThresholdPct: null,
      envMinSample: null,
      envConsecutiveZero: null,
      envCooldownHours: null,
      defaultRateThresholdPct: 30,
      defaultMinSample: 20,
      defaultConsecutiveZero: 3,
      defaultCooldownHours: 6,
    },
    // Task #1910 — DB-backed override of the recipient list. The card
    // also renders a recipients editor that reads these fields, so the
    // page crashes on render if they're missing — keep the fixture in
    // sync with whatever the API returns.
    recipients: {
      effective: ["ops@example.com"],
      source: "env" as const,
      dbList: null,
      envList: ["ops@example.com"],
      envVar: "OPS_ALERT_EMAILS",
    },
    updatedAt: null,
    updatedByUserId: null,
    updatedByDisplayName: null,
    updatedByUsername: null,
    ...lastTest,
  };
}

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <SuperAdminPage />
    </QueryClientProvider>,
  );
}

function makeFetchMock(initialLastTest: LastTestFields) {
  let opsConfig = buildOpsConfig(initialLastTest);
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.startsWith("/api/super-admin/dashboard") && method === "GET") {
      return jsonResponse({
        totalClubs: 0, activeClubs: 0, totalUsers: 0, totalTournaments: 0,
        activeTournaments: 0,
        tierBreakdown: { free: 0, starter: 0, pro: 0, enterprise: 0 },
        estimatedMrr: 0, bookingsThisMonth: 0, bookingRevenueThisMonth: 0,
        bookingsByClub: [],
      });
    }
    if (url.startsWith("/api/super-admin/clubs?")) {
      return jsonResponse({ clubs: [], total: 0 });
    }
    if (url.startsWith("/api/super-admin/caddie-prompt-metrics")) {
      return jsonResponse({
        total: 0, windowStart: null, windowEnd: null,
        byMode: { shots: 0, rounds: 0 },
        avgEstimatedInputTokens: 0, p50EstimatedInputTokens: 0,
        p95EstimatedInputTokens: 0, maxEstimatedInputTokens: 0,
        avgTotalTrackedShots: 0, avgRoundCount: 0, recent: [],
      });
    }
    if (url.startsWith("/api/super-admin/watch-position-metrics")) {
      const emptyWindow = {
        totalMessages: 0, bucketCount: 0, activeSessionCount: 0,
        avgMessagesPerSessionMinute: 0, p50MessagesPerSessionMinute: 0,
        p95MessagesPerSessionMinute: 0, maxMessagesPerSessionMinute: 0,
      };
      return jsonResponse({
        windows: { "24h": emptyWindow, "7d": emptyWindow, "30d": emptyWindow },
        seriesByWindow: { "24h": [], "7d": [], "30d": [] },
        seriesBucketSeconds: { "24h": 60, "7d": 3600, "30d": 86400 },
        recent: [],
      });
    }
    if (
      url === "/api/super-admin/ops-alert-settings"
      || url.startsWith("/api/super-admin/ops-alert-settings?")
    ) {
      return jsonResponse({ config: opsConfig });
    }
    if (url.startsWith("/api/super-admin/ops-alert-settings/history")) {
      return jsonResponse({ entries: [] });
    }
    if (url === "/api/super-admin/ops-alert-settings/test" && method === "POST") {
      // Simulate a successful test send updating the singleton row.
      opsConfig = buildOpsConfig({
        lastTestSentAt: "2026-04-30T11:59:00.000Z",
        lastTestSentByUserId: 1,
        lastTestSentByDisplayName: "Fresh Author",
        lastTestSentByUsername: "fresh_author",
        lastTestRecipientCount: 4,
      });
      return jsonResponse({ ok: true, recipients: 4 });
    }
    return jsonResponse({});
  });
  return { fetchMock };
}

describe("Ops Alert card — Last test sent display (Task #1916)", () => {
  beforeEach(() => {
    toastMock.mockClear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  it("renders the relative timestamp, recipient count, and author when last-test metadata is present", async () => {
    // Pick "two hours before real now" so the formatter produces "2h ago"
    // without needing fake timers (which would freeze React Query).
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const { fetchMock } = makeFetchMock({
      lastTestSentAt: twoHoursAgo,
      lastTestSentByUserId: 7,
      lastTestSentByDisplayName: "Casey Ops",
      lastTestSentByUsername: "casey",
      lastTestRecipientCount: 3,
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();

    const line = await screen.findByTestId("text-ops-alert-last-test");
    expect(line.textContent).toMatch(/Last test sent/i);
    // Relative time uses the "Xh ago" / "Xd ago" formatter — exactly 2h
    // back lands on "2h ago" (the formatter rounds, so a few ms of test
    // execution drift can't bump us off the bucket).
    expect(screen.getByTestId("text-ops-alert-last-test-when").textContent)
      .toMatch(/2h ago/);
    expect(screen.getByTestId("text-ops-alert-last-test-recipients").textContent)
      .toBe("3 recipients");
    expect(screen.getByTestId("text-ops-alert-last-test-author").textContent)
      .toBe("Casey Ops");
    // The empty-state copy must NOT be in the DOM when we have data.
    expect(screen.queryByTestId("text-ops-alert-last-test-empty")).toBeNull();
  });

  it("uses singular 'recipient' when exactly one recipient was emailed", async () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const { fetchMock } = makeFetchMock({
      lastTestSentAt: fiveMinAgo,
      lastTestSentByUserId: null,
      lastTestSentByDisplayName: null,
      lastTestSentByUsername: null,
      lastTestRecipientCount: 1,
    });
    vi.stubGlobal("fetch", fetchMock);

    renderPage();

    const recipients = await screen.findByTestId("text-ops-alert-last-test-recipients");
    expect(recipients.textContent).toBe("1 recipient");
    // No author block when the editor is unknown.
    expect(screen.queryByTestId("text-ops-alert-last-test-author")).toBeNull();
  });

  it("renders the empty-state copy when no test has ever been sent", async () => {
    const { fetchMock } = makeFetchMock(NULL_LAST_TEST);
    vi.stubGlobal("fetch", fetchMock);

    renderPage();

    const empty = await screen.findByTestId("text-ops-alert-last-test-empty");
    expect(empty.textContent).toMatch(/No test alert has been sent yet/i);
    // The populated line must NOT render in the empty state.
    expect(screen.queryByTestId("text-ops-alert-last-test")).toBeNull();
    expect(screen.queryByTestId("text-ops-alert-last-test-when")).toBeNull();
    expect(screen.queryByTestId("text-ops-alert-last-test-recipients")).toBeNull();
  });

  it("refreshes the last-test line after the operator clicks Send test alert", async () => {
    const { fetchMock } = makeFetchMock(NULL_LAST_TEST);
    vi.stubGlobal("fetch", fetchMock);

    const user = userEvent.setup();
    renderPage();

    // Empty state first.
    await screen.findByTestId("text-ops-alert-last-test-empty");

    // Click Send → the confirm dialog opens, then click the inner Send
    // button (a separate testid so we don't collide with the trigger).
    await user.click(screen.getByTestId("button-ops-alert-send-test"));
    const confirmBtn = await screen.findByTestId("button-ops-alert-test-confirm");
    await user.click(confirmBtn);

    // POST should fire, then GET refetch should populate the new metadata.
    await waitFor(() => {
      const posted = fetchMock.mock.calls.some(
        c => typeof c[0] === "string"
          && c[0] === "/api/super-admin/ops-alert-settings/test"
          && (c[1] as RequestInit | undefined)?.method === "POST",
      );
      expect(posted).toBe(true);
    });

    // After refetch, populated line replaces the empty-state.
    await waitFor(() => {
      expect(screen.queryByTestId("text-ops-alert-last-test-empty")).toBeNull();
      expect(screen.getByTestId("text-ops-alert-last-test-recipients").textContent)
        .toBe("4 recipients");
      expect(screen.getByTestId("text-ops-alert-last-test-author").textContent)
        .toBe("Fresh Author");
    });

    vi.useRealTimers();
  });
});
