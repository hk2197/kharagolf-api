/**
 * Task #1770 — Make the digest deep link actually open the
 * stuck-erasures panel.
 *
 * The daily controller stuck-erasure digest, the in-app inbox row,
 * and the home dashboard backlog widget all link to
 * `/privacy?panel=erasure-storage-failures`. Before this task the
 * web app had no `/privacy` route at all so every notification dead
 * ended on the 404 page; now `/privacy` mounts GovernancePage with
 * the panel query param plumbed through, the Privacy tab activated,
 * and the rose-tinted "Erasures with stuck storage cleanup" card
 * scrolled into view.
 *
 * This suite pins down the panel-aware behaviour at the PrivacyTab
 * boundary so a future tab/scaffold refactor can't silently lose it:
 *
 *   1. With `initialPanel="erasure-storage-failures"` and a non-empty
 *      stuck-failures payload, the failures card mounts and
 *      `scrollIntoView` is invoked on it.
 *   2. With `initialPanel` unset, the same payload renders the same
 *      card but `scrollIntoView` is NOT invoked — controllers
 *      arriving via the in-app sidebar shouldn't have the page yank
 *      itself for them.
 *   3. With `initialPanel="erasure-storage-failures"` but no stuck
 *      failures, the card is not rendered and `scrollIntoView` is
 *      not invoked (no card to scroll to, and we don't want to
 *      thrash the layout for a clean state).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
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

const FAILURES_WITH_STUCK = {
  count: 2,
  totalFailedFiles: 5,
  autoRetryExhaustedCount: 0,
  items: [
    {
      clubMemberId: 9001,
      memberFirstName: "Liv",
      memberLastName: "Surviving",
      memberNumber: "LIV-001",
      failedAt: "2026-04-25T09:00:00.000Z",
      failedFiles: 3,
      failedPaths: ["/objects/9001-a", "/objects/9001-b", "/objects/9001-c"],
      autoRetryExhausted: false,
      dataRequestId: 4242,
    },
    {
      clubMemberId: 9002,
      memberFirstName: "Pat",
      memberLastName: "Pending",
      memberNumber: "PAT-002",
      failedAt: "2026-04-26T09:00:00.000Z",
      failedFiles: 2,
      failedPaths: ["/objects/9002-a", "/objects/9002-b"],
      autoRetryExhausted: false,
      dataRequestId: 4243,
    },
  ],
  pendingStorageDeletions: { total: 5, exhausted: 0 },
};

const FAILURES_EMPTY = {
  count: 0,
  totalFailedFiles: 0,
  autoRetryExhaustedCount: 0,
  items: [],
  pendingStorageDeletions: { total: 0, exhausted: 0 },
};

const PENDING_DELETIONS_EMPTY = {
  count: 0,
  onlyExhausted: true,
  items: [],
};

const AUDIT_LOG_EMPTY = {
  count: 0,
  limit: 50,
  items: [],
  actors: [],
  actions: [],
};

function installFetch(opts: { failuresPayload: unknown }) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/members-360/consent-health")) {
        return jsonResponse(CONSENT_HEALTH);
      }
      if (url.includes("/erasures/storage-failures/audit-log")) {
        return jsonResponse(AUDIT_LOG_EMPTY);
      }
      if (url.includes("/erasures/storage-failures/pending")) {
        return jsonResponse(PENDING_DELETIONS_EMPTY);
      }
      if (url.includes("/erasures/storage-failures")) {
        return jsonResponse(opts.failuresPayload);
      }
      return jsonResponse({}, 200);
    }),
  );
}

function renderTab(initialPanel?: string) {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchInterval: false, staleTime: 0 },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={qc}>
      <PrivacyTab orgId={ORG_ID} initialPanel={initialPanel} />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("PrivacyTab — digest deep link `?panel=erasure-storage-failures` (Task #1770)", () => {
  it("scrolls the stuck-erasures card into view when initialPanel matches and there are failures", async () => {
    installFetch({ failuresPayload: FAILURES_WITH_STUCK });
    const scrollSpy = vi.fn();
    // jsdom doesn't implement scrollIntoView; install a spy on the
    // prototype so the hook's call lands on it for every element.
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      writable: true,
      value: scrollSpy,
    });

    renderTab("erasure-storage-failures");

    // The card itself must mount (proves the deep link doesn't dead-
    // end on a hidden element).
    const card = await screen.findByTestId("erasure-storage-failures-card");
    expect(card).toBeInTheDocument();

    // The hook calls scrollIntoView on the card after the failures
    // query resolves and the next tick fires (setTimeout(…, 0)).
    await waitFor(() => expect(scrollSpy).toHaveBeenCalled());
    // And it asks for a smooth scroll positioning the card at the
    // top of the viewport — both args matter for the controller
    // experience (a jumpy "instant" scroll feels broken, and `end`
    // would push the count badge off-screen).
    const lastCall = scrollSpy.mock.calls[scrollSpy.mock.calls.length - 1];
    expect(lastCall[0]).toMatchObject({ behavior: "smooth", block: "start" });
  });

  it("does not scroll when initialPanel is unset, even when the failures card is on screen", async () => {
    installFetch({ failuresPayload: FAILURES_WITH_STUCK });
    const scrollSpy = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      writable: true,
      value: scrollSpy,
    });

    renderTab(/* initialPanel */ undefined);

    // Same data, same card — but no auto-scroll because the visitor
    // didn't arrive via the deep link.
    await screen.findByTestId("erasure-storage-failures-card");

    // Give the scroll-after-fetch effect a tick to fire if it were
    // going to. It must not.
    await new Promise(r => setTimeout(r, 25));
    expect(scrollSpy).not.toHaveBeenCalled();
  });

  it("does not scroll when initialPanel matches but there are no stuck failures (nothing to scroll to)", async () => {
    installFetch({ failuresPayload: FAILURES_EMPTY });
    const scrollSpy = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      writable: true,
      value: scrollSpy,
    });

    renderTab("erasure-storage-failures");

    // The rose card is conditional on count > 0; on a clean state it
    // is not in the DOM. Wait for the privacy-tab wrapper so we know
    // the page actually rendered before asserting on the spy.
    await screen.findByTestId("privacy-tab");
    expect(screen.queryByTestId("erasure-storage-failures-card")).not.toBeInTheDocument();

    await new Promise(r => setTimeout(r, 25));
    expect(scrollSpy).not.toHaveBeenCalled();
  });
});
