/**
 * UI test: entity-filter dropdown + cron-sourced data-export purge row on the
 * Member 360 audit timeline (Task #970 / Task #1122).
 *
 * Mounts <AuditTab /> with a mocked fetch and asserts:
 *   - the cron-sourced data_export purge row renders the friendly summary
 *     line ("Data export #N auto-deleted on … by the system") and a
 *     "system" badge tagging the audit row as cron-written.
 *   - changing the entity dropdown to "Data export" re-issues the request
 *     with `?entity=data_export` and the timeline narrows to only that
 *     entity (the unrelated profile row disappears).
 *
 * Regression guard: a typo in the filter URL or in the friendly-copy /
 * system-badge mapping would fail this test.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// jsdom polyfills for Radix Select (uses pointer capture + scrollIntoView).
if (typeof Element !== "undefined") {
  if (!(Element.prototype as unknown as { hasPointerCapture?: unknown }).hasPointerCapture) {
    (Element.prototype as unknown as { hasPointerCapture: () => boolean }).hasPointerCapture = () => false;
  }
  if (!(Element.prototype as unknown as { releasePointerCapture?: unknown }).releasePointerCapture) {
    (Element.prototype as unknown as { releasePointerCapture: () => void }).releasePointerCapture = () => {};
  }
  if (!(Element.prototype as unknown as { setPointerCapture?: unknown }).setPointerCapture) {
    (Element.prototype as unknown as { setPointerCapture: () => void }).setPointerCapture = () => {};
  }
  if (!(Element.prototype as unknown as { scrollIntoView?: unknown }).scrollIntoView) {
    (Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {};
  }
}

vi.mock("wouter", () => ({
  Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) =>
    <a href={href} {...rest}>{children}</a>,
}));

const toastMock = vi.fn();
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: toastMock }),
}));

import { AuditTab } from "../member-360";

const ORG_ID = 42;
const MEMBER_ID = 7;
const BASE = `/api/organizations/${ORG_ID}/members-360/${MEMBER_ID}`;

const PURGE_AUDIT_ID = 4001;
const PURGE_ENTITY_ID = 9001;
const PROFILE_AUDIT_ID = 4002;

interface AuditFixture {
  id: number;
  entity: string;
  entityId: number | null;
  action: string;
  actorName: string | null;
  actorRole: string | null;
  reason: string | null;
  fieldChanges: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  ipAddress: string | null;
  linkedLevyId: number | null;
  linkedChargeId: number | null;
  receiptLevyId: number | null;
  receiptStatus: "sent" | "skipped" | "failed" | null;
  receiptReason: string | null;
  receiptKind: "payment" | "partial_payment" | "refund" | "waiver" | null;
  receiptAmount: string | null;
  receiptAt: string | null;
}

const PURGE_ROW: AuditFixture = {
  id: PURGE_AUDIT_ID,
  entity: "data_export",
  entityId: PURGE_ENTITY_ID,
  action: "purge",
  actorName: "system",
  actorRole: null,
  reason: "expired archive auto-deleted",
  fieldChanges: null,
  metadata: { source: "cron", artifactUrl: "/objects/data-exports/x.json", alreadyMissing: false },
  createdAt: new Date("2026-01-15T10:00:00Z").toISOString(),
  ipAddress: null,
  linkedLevyId: null,
  linkedChargeId: null,
  receiptLevyId: null,
  receiptStatus: null,
  receiptReason: null,
  receiptKind: null,
  receiptAmount: null,
  receiptAt: null,
};

const PROFILE_ROW: AuditFixture = {
  id: PROFILE_AUDIT_ID,
  entity: "profile",
  entityId: 1,
  action: "update",
  actorName: "Admin",
  actorRole: "org_admin",
  reason: "profile updated",
  fieldChanges: null,
  metadata: null,
  createdAt: new Date("2026-01-14T10:00:00Z").toISOString(),
  ipAddress: null,
  linkedLevyId: null,
  linkedChargeId: null,
  receiptLevyId: null,
  receiptStatus: null,
  receiptReason: null,
  receiptKind: null,
  receiptAmount: null,
  receiptAt: null,
};

interface FetchHandler {
  auditCalls: string[];
}
let handler: FetchHandler;

function installFetch() {
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/audit-log")) {
      handler.auditCalls.push(url);
      // Mirror the server-side filter so the UI sees the narrowed result set
      // when it switches the dropdown to "Data export".
      const isDataExportFilter = /[?&]entity=data_export(?:&|$)/.test(url);
      const body: AuditFixture[] = isDataExportFilter
        ? [PURGE_ROW]
        : [PURGE_ROW, PROFILE_ROW];
      return new Response(JSON.stringify(body), {
        status: 200, headers: { "Content-Type": "application/json" },
      }) as unknown as Response;
    }
    return new Response("not found", { status: 404 }) as unknown as Response;
  }) as typeof fetch;
}

function renderTab() {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchInterval: false, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={qc}>
      <AuditTab base={BASE} orgId={ORG_ID} memberId={MEMBER_ID} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  toastMock.mockReset();
  handler = { auditCalls: [] };
  installFetch();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("<AuditTab /> — entity filter + data-export rendering", () => {
  it("renders the cron-sourced data-export purge row with the friendly summary and 'system' badge", async () => {
    renderTab();

    await screen.findByTestId(`audit-entry-${PURGE_AUDIT_ID}`);

    const summary = screen.getByTestId(`audit-data-export-summary-${PURGE_AUDIT_ID}`);
    expect(summary).toHaveTextContent(/Data export #9001 auto-deleted on .* by the system/i);

    const cronBadge = screen.getByTestId(`audit-source-cron-${PURGE_AUDIT_ID}`);
    expect(cronBadge).toHaveTextContent(/system/i);

    // The unrelated profile row should not get the friendly summary or
    // cron badge — those are scoped to data_export+purge+source=cron.
    expect(
      screen.queryByTestId(`audit-data-export-summary-${PROFILE_AUDIT_ID}`),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId(`audit-source-cron-${PROFILE_AUDIT_ID}`),
    ).not.toBeInTheDocument();
  });

  it("filters the timeline when the entity dropdown is switched to 'Data export'", async () => {
    const user = userEvent.setup();
    renderTab();

    // Initial unfiltered render shows both rows.
    await screen.findByTestId(`audit-entry-${PURGE_AUDIT_ID}`);
    expect(screen.getByTestId(`audit-entry-${PROFILE_AUDIT_ID}`)).toBeInTheDocument();
    expect(handler.auditCalls.at(-1)).not.toMatch(/[?&]entity=/);

    // Open the dropdown and pick "Data export".
    await user.click(screen.getByTestId("select-audit-entity-filter"));
    await user.click(await screen.findByTestId("select-audit-entity-option-data_export"));

    // The hook should re-fetch with ?entity=data_export and the profile row
    // should drop out of the rendered timeline.
    await waitFor(() => {
      expect(handler.auditCalls.some(u => /[?&]entity=data_export/.test(u))).toBe(true);
    });
    await waitFor(() => {
      expect(
        screen.queryByTestId(`audit-entry-${PROFILE_AUDIT_ID}`),
      ).not.toBeInTheDocument();
    });
    expect(screen.getByTestId(`audit-entry-${PURGE_AUDIT_ID}`)).toBeInTheDocument();
  });
});
