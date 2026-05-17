/**
 * UI test: duplicate segment names surface as a toast in the
 * "Save this cohort as a segment" flow inside the Re-apply (clone) dialog
 * (Task #388).
 *
 * Mounts <BulkAuditDetails /> in isolation, opens the dialog, ticks the
 * "save as segment" toggle, and asserts:
 *   - When POST /saved-segments returns 409 with a user-readable error,
 *     the dialog surfaces it as a destructive toast that includes the
 *     server's message verbatim.
 *   - The clone request is NOT sent (the failed save aborts the flow so
 *     admins can rename without leaving an orphaned re-apply).
 *   - The dialog stays open so the admin can correct the name.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, cleanup, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// jsdom polyfills for Radix Select (uses pointer capture + scrollIntoView)
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

import { BulkAuditDetails } from "../club-members";

interface CohortChoice {
  key: string;
  label: string;
  memberIds: number[];
  description?: string;
  filters?: Record<string, unknown>;
  savedSegmentId?: number;
}

interface Handler {
  detailsRows: Array<Record<string, unknown>>;
  savedSegmentRequests: Array<Record<string, unknown>>;
  savedSegmentError: { status: number; body: { error: string } };
  cloneRequests: Array<Record<string, unknown>>;
}

let handler: Handler;

function installFetch() {
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();

    if (url.includes("/bulk-audit/details")) {
      return new Response(JSON.stringify({
        rows: handler.detailsRows, truncated: false, limit: 500,
      }), { status: 200, headers: { "Content-Type": "application/json" } }) as unknown as Response;
    }

    if (url.endsWith("/saved-segments") && init?.method === "POST") {
      handler.savedSegmentRequests.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify(handler.savedSegmentError.body), {
        status: handler.savedSegmentError.status,
        headers: { "Content-Type": "application/json" },
      }) as unknown as Response;
    }

    if (url.endsWith("/bulk-action/clone") && init?.method === "POST") {
      handler.cloneRequests.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({
        redone: 0, skipped: 0, originalAction: "freeze",
        cloneReason: "", cohortSize: 0, requested: 0,
      }), { status: 200, headers: { "Content-Type": "application/json" } }) as unknown as Response;
    }

    return new Response("not found", { status: 404 }) as unknown as Response;
  }) as typeof fetch;
}

function makeRow(auditId: number, clubMemberId: number) {
  return {
    auditId,
    clubMemberId,
    firstName: "Test",
    lastName: `M${auditId}`,
    email: `m${auditId}@example.com`,
    memberNumber: `M${auditId}`,
    action: "update",
    fieldChanges: { lifecycleStatus: { from: "active", to: "frozen" } },
    createdAt: new Date().toISOString(),
  };
}

function renderDetails(cohortChoices: CohortChoice[]) {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchInterval: false, staleTime: 0 },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={qc}>
      <BulkAuditDetails
        orgId={42}
        bucket="2026-04-18T10:00:00.000Z"
        entity="lifecycle"
        reason="bulk freeze: holiday closure"
        actorUserId={7}
        actionType="freeze"
        memberCount={4}
        canReverse={true}
        onReversed={vi.fn()}
        cohortChoices={cohortChoices}
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  toastMock.mockReset();
  handler = {
    detailsRows: [makeRow(1, 101), makeRow(2, 102), makeRow(3, 103), makeRow(4, 104)],
    savedSegmentRequests: [],
    savedSegmentError: {
      status: 409,
      body: { error: 'A segment named "Winter freeze cohort" already exists. Please choose a different name.' },
    },
    cloneRequests: [],
  };
  installFetch();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("<BulkAuditDetails /> — duplicate segment name surfaces as a toast", () => {
  it("shows the server's user-readable error as a destructive toast and skips the clone when POST /saved-segments returns 409", async () => {
    const user = userEvent.setup();
    const filters = { status: "active" as const };
    const cohorts: CohortChoice[] = [
      {
        key: "current-filter",
        label: "Current filter",
        memberIds: [101, 102, 103],
        description: "status=active",
        filters,
      },
    ];
    renderDetails(cohorts);

    // Open the "Re-apply to filtered members" dialog
    await user.click(await screen.findByTestId("button-bulk-audit-clone-2026-04-18T10:00:00.000Z"));
    const dialog = await screen.findByTestId("dialog-bulk-clone-confirm");

    // Tick the toggle and enter a name that collides server-side
    const toggle = within(dialog).getByTestId("switch-clone-save-as-segment");
    await user.click(toggle);
    const nameInput = await within(dialog).findByTestId("input-clone-save-as-segment-name");
    await user.type(nameInput, "Winter freeze cohort");

    // Confirm — the server replies 409
    await user.click(within(dialog).getByTestId("button-bulk-clone-confirm"));

    // /saved-segments was POSTed exactly once with the entered name
    await waitFor(() => expect(handler.savedSegmentRequests.length).toBe(1));
    expect(handler.savedSegmentRequests[0]).toMatchObject({
      name: "Winter freeze cohort",
      filters: { status: "active" },
      isShared: false,
    });

    // The destructive toast surfaces the server's user-readable error verbatim
    await waitFor(() => {
      expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({
        title: expect.stringMatching(/re-apply failed/i),
        description: 'A segment named "Winter freeze cohort" already exists. Please choose a different name.',
        variant: "destructive",
      }));
    });

    // The clone is NOT sent — the failed save aborts the flow so the admin
    // can rename without leaving an orphaned re-apply behind.
    expect(handler.cloneRequests.length).toBe(0);

    // The dialog stays open so the admin can correct the name
    expect(screen.queryByTestId("dialog-bulk-clone-confirm")).toBeInTheDocument();
  });
});
