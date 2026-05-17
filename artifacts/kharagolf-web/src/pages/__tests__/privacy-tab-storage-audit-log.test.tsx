/**
 * Task #1529 — UI smoke test for the "Recent storage-cleanup admin actions"
 * audit list on the Privacy tab.
 *
 * Pins down the three behaviours that were shipped without coverage:
 *   1. Collapsible toggle: the count badge is always visible but the row
 *      list is hidden by default. Clicking the Show/Hide button reveals
 *      the body.
 *   2. "Member row removed" badge: rows whose `clubMemberId` is null
 *      (cascade-deleted member) render the explicit badge instead of
 *      a clickable Member 360 link, so admins know the deep-link target
 *      is gone.
 *   3. Refresh-after-mutation: a successful per-row force-retry triggers
 *      a re-fetch of the audit-log endpoint so the freshly-written
 *      audit row shows up without a page reload.
 *
 * Task #1893 — also asserts that rows whose API payload has bulk=true
 * render the "bulk" pill next to the action badge, while bulk=false
 * rows do not.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

// PrivacyTab calls useActiveOrgContext + useGetMe at the parent
// GovernancePage scope. We render PrivacyTab directly with an orgId
// prop, so neither needs to actually run — but the imports still
// resolve, so leave them as-is.

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

// Minimal consent-health payload — PrivacyTab renders even if this is
// "empty" (no categories) because the audit-log card doesn't depend on
// it. Returning it cleanly so the page doesn't show the loading
// spinner instead of the audit list.
const CONSENT_HEALTH = {
  totalMembers: 0,
  categories: [],
  accountDeletions: { inGrace: 0, overdue: 0, rows: [] },
  dataExports: { pending: 0, ready: 0, expired: 0, failed: 0, rows: [] },
};

// No stuck-storage failures — keeps the rose-tinted card off the DOM
// so the audit list is the only thing under test.
const FAILURES_EMPTY = {
  count: 0,
  totalFailedFiles: 0,
  items: [],
  pendingStorageDeletions: { total: 0, exhausted: 0 },
};

// One pending stuck row so we can click force-retry and assert the
// audit-log refetch.
const PENDING_DELETIONS = {
  count: 1,
  onlyExhausted: true,
  items: [
    {
      id: 555,
      clubMemberId: 9001,
      sourceAuditId: null,
      path: "/objects/stuck-orphan",
      attempts: 12,
      lastAttemptAt: "2026-04-25T09:00:00.000Z",
      lastError: "TimeoutError: backend unavailable",
      nextAttemptAt: "2026-04-26T09:00:00.000Z",
      createdAt: "2026-04-20T09:00:00.000Z",
      exhausted: true,
      exhaustionNotifiedAt: "2026-04-25T09:30:00.000Z",
      memberFirstName: "Liv",
      memberLastName: "Surviving",
      memberNumber: "LIV-001",
      memberDeleted: false,
    },
  ],
};

// Two audit rows, including one whose member was cascade-deleted so
// we can assert the "member row removed" badge. Row 7001 is also a
// bulk-action row (Task #1893) so the "bulk" pill renders for it but
// not for the per-row resolve at 7002.
const AUDIT_LOG_INITIAL = {
  count: 2,
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
      actorName: "Admin Alpha (snapshot)",
      actorDisplayName: "Admin Alpha",
      actorUsername: "admin_alpha",
      actorEmail: "admin@club.test",
      // Task #1893 — emitted by the bulk-retry-now endpoint.
      bulk: true,
    },
    {
      id: 7002,
      action: "resolve" as const,
      createdAt: "2026-04-23T10:00:00.000Z",
      reason: "auto-resolved after cascade",
      path: "/objects/cascade-deleted-orphan",
      attempts: 5,
      lastError: null,
      pendingId: 9002,
      clubMemberId: null,
      memberFirstName: null,
      memberLastName: null,
      memberNumber: null,
      memberDeleted: true,
      actorUserId: null,
      actorName: "system",
      actorDisplayName: null,
      actorUsername: null,
      actorEmail: null,
      // Task #1893 — per-row action, no bulk pill expected.
      bulk: false,
    },
  ],
  // Task #1530 added `actors` to the response shape so the actor
  // filter dropdown can be rendered. Mirrors the distinct admin
  // surfaced in `items` above (the cascade-deleted system row at
  // 7002 has actorUserId=null and so doesn't contribute), matching
  // what the live `/audit-log` endpoint would compute from the same
  // rows. Anything else and the fixture would silently disagree
  // with the API contract.
  actors: [{ userId: 1, label: "Admin Alpha" }],
  filters: { actorUserId: null, action: null, pathPrefix: null },
};

// The post-mutation snapshot adds a third row (the freshly-written
// force-retry audit). Only used by the refresh-after-mutation test.
const AUDIT_LOG_AFTER_MUTATION = {
  count: 3,
  limit: 50,
  items: [
    {
      id: 7003,
      action: "force_retry" as const,
      createdAt: "2026-04-26T13:00:00.000Z",
      reason: null,
      path: "/objects/stuck-orphan",
      attempts: 12,
      lastError: "TimeoutError: backend unavailable",
      pendingId: 555,
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
      // Per-row force-retry mutation, so no bulk pill on the new row.
      bulk: false,
    },
    ...AUDIT_LOG_INITIAL.items,
  ],
  // Same single distinct admin (Admin Alpha, userId=1) across all
  // three rows — the freshly-written 7003 audit was attributed to
  // the same actor, so the distinct-actor list doesn't grow.
  actors: [{ userId: 1, label: "Admin Alpha" }],
  filters: { actorUserId: null, action: null, pathPrefix: null },
};

interface FetchOptions {
  // Number of times the audit-log endpoint has been hit. The test
  // asserts on the second hit to verify the refetch happened.
  auditLogPayloads?: typeof AUDIT_LOG_INITIAL[];
}

function installFetch(opts: FetchOptions = {}) {
  const auditLogPayloads = opts.auditLogPayloads ?? [AUDIT_LOG_INITIAL];
  let auditLogHits = 0;
  let pendingDeletionHits = 0;
  let forceRetryHits = 0;

  const fetchSpy = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();

    if (url.includes("/members-360/consent-health")) {
      return jsonResponse(CONSENT_HEALTH);
    }
    if (url.includes("/erasures/storage-failures/audit-log")) {
      const idx = Math.min(auditLogHits, auditLogPayloads.length - 1);
      auditLogHits += 1;
      return jsonResponse(auditLogPayloads[idx]);
    }
    if (url.includes("/erasures/storage-failures/pending/") && method === "POST") {
      forceRetryHits += 1;
      return jsonResponse({ id: 555, attempts: 12, nextAttemptAt: new Date().toISOString() });
    }
    if (url.includes("/erasures/storage-failures/pending")) {
      pendingDeletionHits += 1;
      return jsonResponse(PENDING_DELETIONS);
    }
    if (url.includes("/erasures/storage-failures")) {
      return jsonResponse(FAILURES_EMPTY);
    }
    return jsonResponse({}, 200);
  });
  vi.stubGlobal("fetch", fetchSpy);
  return {
    fetchSpy,
    auditHits: () => auditLogHits,
    pendingHits: () => pendingDeletionHits,
    forceRetryHits: () => forceRetryHits,
  };
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

describe("PrivacyTab — Recent storage-cleanup admin actions audit list (Task #1529)", () => {
  it("renders collapsed by default with the count badge visible, and the toggle expands the body", async () => {
    installFetch();
    renderTab();

    // Card mounts with a count badge (always visible) but no body rows.
    const countBadge = await screen.findByTestId("pending-storage-audit-log-count");
    expect(countBadge.textContent).toBe("2");

    // Body is collapsed: no audit rows in the DOM yet.
    expect(screen.queryByTestId("pending-storage-audit-row-7001")).not.toBeInTheDocument();
    expect(screen.queryByTestId("pending-storage-audit-row-7002")).not.toBeInTheDocument();

    // Toggle says "Show" before expansion.
    const toggle = screen.getByTestId("pending-storage-audit-log-toggle");
    expect(toggle.textContent).toMatch(/show/i);

    fireEvent.click(toggle);

    // Body expands — both audit rows render.
    await screen.findByTestId("pending-storage-audit-row-7001");
    await screen.findByTestId("pending-storage-audit-row-7002");

    // Toggle now says "Hide" so a second click can collapse it again.
    expect(screen.getByTestId("pending-storage-audit-log-toggle").textContent).toMatch(/hide/i);

    // Collapse again — body must disappear.
    fireEvent.click(screen.getByTestId("pending-storage-audit-log-toggle"));
    await waitFor(() => {
      expect(screen.queryByTestId("pending-storage-audit-row-7001")).not.toBeInTheDocument();
    });
  });

  it("renders the 'member row removed' badge for cascade-deleted rows and a Member 360 link otherwise", async () => {
    installFetch();
    renderTab();

    // Expand the audit list so the rows are in the DOM.
    fireEvent.click(await screen.findByTestId("pending-storage-audit-log-toggle"));
    const liveRow = await screen.findByTestId("pending-storage-audit-row-7001");
    const cascadeRow = await screen.findByTestId("pending-storage-audit-row-7002");

    // Live row: name renders as a link to /member-360/<clubMemberId>.
    const liveLink = await screen.findByTestId("pending-storage-audit-member-link-7001");
    expect(liveLink.getAttribute("href")).toBe("/member-360/9001");
    expect(liveLink.textContent).toMatch(/Liv Surviving/);
    // Live row must NOT have the deleted badge — the renderer should
    // pick the link branch for this row.
    expect(liveRow.querySelector("[data-testid='pending-storage-audit-member-deleted-7001']")).toBeNull();

    // Cascade row: explicit "member row removed" badge with the
    // exact data-testid we asserted on the API side.
    const deletedBadge = await screen.findByTestId("pending-storage-audit-member-deleted-7002");
    expect(deletedBadge.textContent).toMatch(/member row removed/i);
    // No link rendered for the deleted-row case (would 404 if clicked).
    expect(cascadeRow.querySelector("[data-testid='pending-storage-audit-member-link-7002']")).toBeNull();

    // The action / actor / reason fields must still render even when
    // the underlying member is gone.
    expect(screen.getByTestId("pending-storage-audit-action-7002").textContent).toMatch(/resolved/i);
    expect(screen.getByTestId("pending-storage-audit-actor-7002").textContent).toMatch(/system/i);
    expect(screen.getByTestId("pending-storage-audit-reason-7002").textContent).toMatch(/auto-resolved after cascade/);
    expect(screen.getByTestId("pending-storage-audit-path-7002").textContent).toBe("/objects/cascade-deleted-orphan");
  });

  it("(Task #1893) renders a 'bulk' pill for bulk=true rows and omits it for per-row actions", async () => {
    installFetch();
    renderTab();

    // Expand the audit list so the rows are in the DOM.
    fireEvent.click(await screen.findByTestId("pending-storage-audit-log-toggle"));
    await screen.findByTestId("pending-storage-audit-row-7001");
    await screen.findByTestId("pending-storage-audit-row-7002");

    // The bulk fixture (7001) must render the pill, sitting next to
    // (not replacing) the existing action badge.
    const bulkPill = screen.getByTestId("pending-storage-audit-bulk-7001");
    expect(bulkPill.textContent).toMatch(/bulk/i);
    // The action pill is still there alongside it.
    expect(screen.getByTestId("pending-storage-audit-action-7001").textContent).toMatch(/force retry/i);

    // The per-row resolve fixture (7002) must NOT render the pill —
    // bulk=false on the API payload means no badge in the DOM.
    expect(screen.queryByTestId("pending-storage-audit-bulk-7002")).toBeNull();
  });

  it("re-fetches the audit list after a successful force-retry mutation so the new audit row appears", async () => {
    const harness = installFetch({
      auditLogPayloads: [AUDIT_LOG_INITIAL, AUDIT_LOG_AFTER_MUTATION],
    });
    renderTab();

    // Wait for the initial audit-log fetch to settle (count badge present).
    const countBadge = await screen.findByTestId("pending-storage-audit-log-count");
    expect(countBadge.textContent).toBe("2");
    expect(harness.auditHits()).toBe(1);

    // The stuck-rows row must be on screen so we can click force-retry.
    const forceRetryButton = await screen.findByTestId("pending-storage-force-retry-555");
    fireEvent.click(forceRetryButton);

    // The mutation hits the per-row force-retry endpoint exactly once.
    await waitFor(() => expect(harness.forceRetryHits()).toBe(1));

    // The onSuccess effect must trigger a refetch of the audit-log
    // endpoint — the count badge updates to the new payload.
    await waitFor(() => {
      expect(harness.auditHits()).toBeGreaterThanOrEqual(2);
      expect(screen.getByTestId("pending-storage-audit-log-count").textContent).toBe("3");
    });

    // Expand and confirm the freshly-written audit row is rendered.
    fireEvent.click(screen.getByTestId("pending-storage-audit-log-toggle"));
    await screen.findByTestId("pending-storage-audit-row-7003");
    expect(screen.getByTestId("pending-storage-audit-action-7003").textContent).toMatch(/force retry/i);
    expect(screen.getByTestId("pending-storage-audit-path-7003").textContent).toBe("/objects/stuck-orphan");
  });
});
