/**
 * UI test: "Save this cohort as a segment" toggle in the Re-apply (clone) dialog
 * (Task #327, covering the toggle added by Task #266).
 *
 * Mounts <BulkAuditDetails /> in isolation, opens the "Re-apply to filtered
 * members" dialog, and asserts:
 *   1. Ticking the toggle, naming the segment, and confirming both:
 *        - POSTs to /saved-segments with the entered name and the selected
 *          cohort's filters, and
 *        - POSTs to /bulk-action/clone with the selected cohort's memberIds.
 *      Re-rendering the parent with the freshly-saved segment in
 *      cohortChoices then surfaces it in the cohort dropdown.
 *   2. When the chosen cohort is itself a saved segment, the toggle is
 *      disabled, the explanatory note is shown, and confirming the dialog
 *      does NOT POST to /saved-segments (only the clone fires).
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
  savedSegmentResponse: { id: number; name: string };
  cloneRequests: Array<Record<string, unknown>>;
  cloneResponse: {
    redone: number;
    skipped: number;
    originalAction: string;
    cloneReason: string;
    cohortSize: number;
    requested: number;
  };
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
      return new Response(JSON.stringify(handler.savedSegmentResponse), {
        status: 201, headers: { "Content-Type": "application/json" },
      }) as unknown as Response;
    }

    if (url.endsWith("/bulk-action/clone") && init?.method === "POST") {
      handler.cloneRequests.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify(handler.cloneResponse), {
        status: 200, headers: { "Content-Type": "application/json" },
      }) as unknown as Response;
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
  const onReversed = vi.fn();
  const utils = render(
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
        onReversed={onReversed}
        cohortChoices={cohortChoices}
      />
    </QueryClientProvider>,
  );
  const rerenderWith = (next: CohortChoice[]) =>
    utils.rerender(
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
          onReversed={onReversed}
          cohortChoices={next}
        />
      </QueryClientProvider>,
    );
  return { ...utils, onReversed, rerenderWith };
}

beforeEach(() => {
  toastMock.mockReset();
  handler = {
    detailsRows: [makeRow(1, 101), makeRow(2, 102), makeRow(3, 103), makeRow(4, 104)],
    savedSegmentRequests: [],
    savedSegmentResponse: { id: 4242, name: "Winter freeze cohort" },
    cloneRequests: [],
    cloneResponse: {
      redone: 2, skipped: 1, originalAction: "freeze",
      cloneReason: "bulk redo-of #2026-04-18T10:00:00.000Z (filtered: Current filter)",
      cohortSize: 3, requested: 3,
    },
  };
  installFetch();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("<BulkAuditDetails /> — save cohort as segment from clone dialog", () => {
  it("ticking the toggle, naming the segment, and confirming saves the segment, runs the clone, and the new segment shows up in the cohort dropdown", async () => {
    const user = userEvent.setup();
    const filters = { status: "active" as const };
    const initialCohorts: CohortChoice[] = [
      {
        key: "current-filter",
        label: "Current filter",
        memberIds: [101, 102, 103],
        description: "status=active",
        filters,
      },
    ];
    const { rerenderWith } = renderDetails(initialCohorts);

    // Open the "Re-apply to filtered members" dialog
    const cloneBtn = await screen.findByTestId("button-bulk-audit-clone-2026-04-18T10:00:00.000Z");
    await user.click(cloneBtn);

    // Dialog appears with the toggle enabled (cohort is not a saved segment yet)
    const dialog = await screen.findByTestId("dialog-bulk-clone-confirm");
    const toggle = within(dialog).getByTestId("switch-clone-save-as-segment");
    expect(toggle).not.toBeDisabled();
    expect(toggle).toHaveAttribute("data-state", "unchecked");
    // Name input only appears once the toggle is on
    expect(within(dialog).queryByTestId("input-clone-save-as-segment-name")).toBeNull();

    // Tick the toggle and enter a name
    await user.click(toggle);
    expect(toggle).toHaveAttribute("data-state", "checked");
    const nameInput = await within(dialog).findByTestId("input-clone-save-as-segment-name");
    await user.type(nameInput, "Winter freeze cohort");

    // Confirm
    await user.click(within(dialog).getByTestId("button-bulk-clone-confirm"));

    // /saved-segments POSTed with the entered name + selected cohort's filters
    await waitFor(() => expect(handler.savedSegmentRequests.length).toBe(1));
    expect(handler.savedSegmentRequests[0]).toMatchObject({
      name: "Winter freeze cohort",
      filters: { status: "active" },
      isShared: false,
      description: "status=active",
    });

    // /bulk-action/clone POSTed with the selected cohort's memberIds + label
    await waitFor(() => expect(handler.cloneRequests.length).toBe(1));
    expect(handler.cloneRequests[0]).toMatchObject({
      bucket: "2026-04-18T10:00:00.000Z",
      entity: "lifecycle",
      reason: "bulk freeze: holiday closure",
      actorUserId: 7,
      memberIds: [101, 102, 103],
      cohortLabel: "Current filter",
    });

    // Success toast shown
    await waitFor(() => {
      expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({
        title: expect.stringMatching(/re-applied/i),
      }));
    });

    // Simulate the parent re-rendering after invalidating saved-segments — the
    // dropdown should now include the new segment.
    rerenderWith([
      ...initialCohorts,
      {
        key: "segment-4242",
        label: "Segment: Winter freeze cohort",
        memberIds: [101, 102, 103],
        description: "status=active",
        filters,
        savedSegmentId: 4242,
      },
    ]);

    // Re-open the dialog to inspect the cohort dropdown
    await user.click(await screen.findByTestId("button-bulk-audit-clone-2026-04-18T10:00:00.000Z"));
    const dialog2 = await screen.findByTestId("dialog-bulk-clone-confirm");
    const trigger = within(dialog2).getByTestId("select-clone-cohort");
    await user.click(trigger);
    expect(await screen.findByTestId("option-clone-cohort-segment-4242"))
      .toHaveTextContent("Segment: Winter freeze cohort");
  });

  it("disables the toggle (and skips POST /saved-segments) when the chosen cohort is already a saved segment", async () => {
    const user = userEvent.setup();
    const cohorts: CohortChoice[] = [
      {
        key: "segment-77",
        label: "Segment: Frozen seniors",
        memberIds: [201, 202],
        description: "status=frozen",
        filters: { status: "frozen" as const },
        savedSegmentId: 77,
      },
    ];
    renderDetails(cohorts);

    await user.click(await screen.findByTestId("button-bulk-audit-clone-2026-04-18T10:00:00.000Z"));
    const dialog = await screen.findByTestId("dialog-bulk-clone-confirm");

    // Toggle is disabled and the explanatory message is rendered
    const toggle = within(dialog).getByTestId("switch-clone-save-as-segment");
    expect(toggle).toBeDisabled();
    expect(within(dialog).getByText(/already saved as a segment/i)).toBeInTheDocument();

    // Clicking the disabled toggle does nothing — no name input appears
    await user.click(toggle).catch(() => undefined);
    expect(within(dialog).queryByTestId("input-clone-save-as-segment-name")).toBeNull();

    // Confirm the clone — only /bulk-action/clone fires, /saved-segments is NOT called
    await user.click(within(dialog).getByTestId("button-bulk-clone-confirm"));

    await waitFor(() => expect(handler.cloneRequests.length).toBe(1));
    expect(handler.cloneRequests[0]).toMatchObject({
      memberIds: [201, 202],
      cohortLabel: "Segment: Frozen seniors",
    });
    expect(handler.savedSegmentRequests.length).toBe(0);
  });
});
