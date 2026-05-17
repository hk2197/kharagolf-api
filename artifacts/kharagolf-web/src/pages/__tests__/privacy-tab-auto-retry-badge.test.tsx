/**
 * Task #1780 — UI smoke test for the auto-retry chain badges + panel-level
 * banner on the Privacy tab's "Erasures with stuck storage cleanup" card.
 *
 * Task #1459 added two badge states and a banner whose API contract is
 * covered by Vitest, but no UI test asserts the React wiring. This file
 * pins down:
 *   1. Exhausted chain — destructive
 *      `erasure-storage-auto-retry-exhausted-<id>` badge plus the
 *      `erasure-storage-needs-action-banner` with the right count.
 *   2. In-progress chain — amber
 *      `erasure-storage-auto-retry-inflight-<id>` badge instead, and the
 *      banner stays off when no member has been exhausted.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
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

const PENDING_DELETIONS_EMPTY = {
  count: 0,
  onlyExhausted: false,
  items: [],
};

const AUDIT_LOG_EMPTY = {
  count: 0,
  limit: 50,
  items: [],
};

type FailuresPayload = {
  count: number;
  totalFailedFiles: number;
  items: Array<{
    clubMemberId: number;
    auditId: number;
    completedAt: string;
    objectStorageFilesFailed: number;
    dataRequestId: number | null;
    memberFirstName: string | null;
    memberLastName: string | null;
    memberNumber: string | null;
    memberDeleted: boolean;
    autoRetryAttempts?: number;
    autoRetryExhausted?: boolean;
  }>;
  pendingStorageDeletions?: { total: number; exhausted: number };
  autoRetryExhaustedCount?: number;
  autoRetryMaxAttempts?: number;
};

function installFetch(failures: FailuresPayload) {
  const fetchSpy = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();

    if (url.includes("/members-360/consent-health")) {
      return jsonResponse(CONSENT_HEALTH);
    }
    if (url.includes("/erasures/storage-failures/audit-log")) {
      return jsonResponse(AUDIT_LOG_EMPTY);
    }
    if (
      url.includes("/erasures/storage-failures/pending/") &&
      method === "POST"
    ) {
      return jsonResponse({ ok: true });
    }
    if (url.includes("/erasures/storage-failures/pending")) {
      return jsonResponse(PENDING_DELETIONS_EMPTY);
    }
    if (url.includes("/erasures/storage-failures")) {
      return jsonResponse(failures);
    }
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

describe("PrivacyTab — auto-retry chain badges + needs-action banner (Task #1780)", () => {
  it("renders the destructive 'auto-retry exhausted' badge and the panel-level needs-action banner when the chain is capped", async () => {
    installFetch({
      count: 1,
      totalFailedFiles: 3,
      items: [
        {
          clubMemberId: 9001,
          auditId: 12345,
          completedAt: "2026-04-25T09:00:00.000Z",
          objectStorageFilesFailed: 3,
          dataRequestId: 77,
          memberFirstName: "Liv",
          memberLastName: "Surviving",
          memberNumber: "LIV-001",
          memberDeleted: false,
          autoRetryAttempts: 5,
          autoRetryExhausted: true,
        },
      ],
      pendingStorageDeletions: { total: 1, exhausted: 1 },
      autoRetryExhaustedCount: 1,
      autoRetryMaxAttempts: 5,
    });

    renderTab();

    // The destructive per-row badge appears with the exact testid contract
    // the deep link / digest copy depends on.
    const exhaustedBadge = await screen.findByTestId(
      "erasure-storage-auto-retry-exhausted-9001",
    );
    expect(exhaustedBadge.textContent).toMatch(
      /auto-retry exhausted — needs your action/i,
    );

    // The amber in-progress badge must NOT also render for the same row —
    // the renderer picks one branch.
    expect(
      screen.queryByTestId("erasure-storage-auto-retry-inflight-9001"),
    ).not.toBeInTheDocument();

    // Panel-level banner is visible and shows the right count via the
    // dedicated count testid.
    const banner = await screen.findByTestId(
      "erasure-storage-needs-action-banner",
    );
    expect(banner).toBeInTheDocument();
    expect(banner.textContent).toMatch(/auto-retry/i);
    expect(banner.textContent).toMatch(/manually re-run cleanup/i);

    const bannerCount = await screen.findByTestId(
      "erasure-storage-needs-action-count",
    );
    expect(bannerCount.textContent).toBe("1");
  });

  it("renders the amber 'auto-retry in progress' badge for a chain that has not yet hit the cap, and omits the needs-action banner", async () => {
    installFetch({
      count: 1,
      totalFailedFiles: 2,
      items: [
        {
          clubMemberId: 9002,
          auditId: 22222,
          completedAt: "2026-04-26T10:00:00.000Z",
          objectStorageFilesFailed: 2,
          dataRequestId: 78,
          memberFirstName: "Mira",
          memberLastName: "Pending",
          memberNumber: "MIR-002",
          memberDeleted: false,
          autoRetryAttempts: 3,
          autoRetryExhausted: false,
        },
      ],
      pendingStorageDeletions: { total: 1, exhausted: 0 },
      autoRetryExhaustedCount: 0,
      autoRetryMaxAttempts: 5,
    });

    renderTab();

    // The amber in-progress badge appears with the n/cap label so a
    // controller can see how many auto-attempts remain before the cron
    // gives up.
    const inflightBadge = await screen.findByTestId(
      "erasure-storage-auto-retry-inflight-9002",
    );
    expect(inflightBadge.textContent).toMatch(
      /auto-retry in progress \(3\/5\)/i,
    );

    // Mutually exclusive with the exhausted badge.
    expect(
      screen.queryByTestId("erasure-storage-auto-retry-exhausted-9002"),
    ).not.toBeInTheDocument();

    // No member has been exhausted, so the panel-level banner must not
    // render at all.
    expect(
      screen.queryByTestId("erasure-storage-needs-action-banner"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("erasure-storage-needs-action-count"),
    ).not.toBeInTheDocument();
  });
});
