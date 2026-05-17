/**
 * UI test: Bulk reverse pre-flight preview (Task #295).
 *
 * Mounts <BulkAuditDetails /> in isolation, opens the "Undo for all" dialog,
 * and asserts the preview-count test IDs render the numbers returned by the
 * `/bulk-action/reverse/preview` endpoint, plus that they refresh on submit
 * (the component refetches the preview before posting the reverse).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("wouter", () => ({
  Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) =>
    <a href={href} {...rest}>{children}</a>,
}));

const toastMock = vi.fn();
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: toastMock }),
}));

import { BulkAuditDetails } from "../club-members";

interface PreviewResponse {
  willChange: number;
  alreadyReversed: number;
  affectedMembers: number;
  originalAction: string;
}

interface Handler {
  detailsRows: Array<{
    auditId: number;
    clubMemberId: number | null;
    firstName: string | null;
    lastName: string | null;
    email: string | null;
    memberNumber: string | null;
    action: string;
    fieldChanges: Record<string, { from: unknown; to: unknown }> | null;
    createdAt: string;
  }>;
  /** Sequence of preview responses; each call pops the next one (last sticks). */
  previewResponses: PreviewResponse[];
  previewRequests: Array<Record<string, unknown>>;
  reverseResponse: { reversed: number; skipped: number };
  reverseRequests: Array<Record<string, unknown>>;
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

    if (url.includes("/bulk-action/reverse/preview") && init?.method === "POST") {
      handler.previewRequests.push(JSON.parse(String(init.body)));
      const next = handler.previewResponses.length > 1
        ? handler.previewResponses.shift()!
        : handler.previewResponses[0];
      return new Response(JSON.stringify(next), {
        status: 200, headers: { "Content-Type": "application/json" },
      }) as unknown as Response;
    }

    if (url.endsWith("/bulk-action/reverse") && init?.method === "POST") {
      handler.reverseRequests.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify(handler.reverseResponse), {
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

function renderDetails() {
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
        cohortChoices={[]}
      />
    </QueryClientProvider>,
  );
  return { ...utils, onReversed };
}

beforeEach(() => {
  toastMock.mockReset();
  handler = {
    detailsRows: [makeRow(1, 101), makeRow(2, 102), makeRow(3, 103), makeRow(4, 104)],
    previewResponses: [{
      willChange: 3, alreadyReversed: 1, affectedMembers: 4, originalAction: "freeze",
    }],
    previewRequests: [],
    reverseResponse: { reversed: 3, skipped: 1 },
    reverseRequests: [],
  };
  installFetch();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("<BulkAuditDetails /> — reverse pre-flight preview", () => {
  it("opens the reverse dialog and renders the preview counts from the API", async () => {
    const user = userEvent.setup();
    renderDetails();

    // Wait for details to load so the action toolbar (with the Undo button) is visible
    const undoBtn = await screen.findByTestId("button-bulk-audit-undo-2026-04-18T10:00:00.000Z");
    await user.click(undoBtn);

    // Preview block appears, and once the query resolves the count testIds show the API numbers
    await screen.findByTestId("bulk-reverse-preview-2026-04-18T10:00:00.000Z");
    const willChange = await screen.findByTestId("bulk-reverse-preview-will-change");
    const already = screen.getByTestId("bulk-reverse-preview-already");
    expect(willChange).toHaveTextContent("3");
    expect(already).toHaveTextContent("1");

    // The preview was queried with the bucket/entity/reason/actorUserId from props
    expect(handler.previewRequests.length).toBe(1);
    expect(handler.previewRequests[0]).toMatchObject({
      bucket: "2026-04-18T10:00:00.000Z",
      entity: "lifecycle",
      reason: "bulk freeze: holiday closure",
      actorUserId: 7,
    });
  });

  it("refreshes the preview counts on submit before posting the reverse", async () => {
    // Second response simulates the cohort changing between dialog-open and submit:
    // one of the "will change" members has been unfrozen elsewhere, so willChange
    // drops from 3 → 2 and alreadyReversed grows from 1 → 2.
    handler.previewResponses = [
      { willChange: 3, alreadyReversed: 1, affectedMembers: 4, originalAction: "freeze" },
      { willChange: 2, alreadyReversed: 2, affectedMembers: 4, originalAction: "freeze" },
    ];

    const user = userEvent.setup();
    const { onReversed } = renderDetails();

    await user.click(await screen.findByTestId("button-bulk-audit-undo-2026-04-18T10:00:00.000Z"));

    // Initial preview: 3 / 1
    const willChange = await screen.findByTestId("bulk-reverse-preview-will-change");
    expect(willChange).toHaveTextContent("3");
    expect(screen.getByTestId("bulk-reverse-preview-already")).toHaveTextContent("1");
    expect(handler.previewRequests.length).toBe(1);

    // Click "Reverse it" — the component refetches the preview before posting.
    await user.click(screen.getByTestId("button-bulk-undo-confirm"));

    // Reverse endpoint was called once, with the same bucket/entity/reason
    await waitFor(() => expect(handler.reverseRequests.length).toBe(1));
    expect(handler.reverseRequests[0]).toMatchObject({
      bucket: "2026-04-18T10:00:00.000Z",
      entity: "lifecycle",
      reason: "bulk freeze: holiday closure",
      actorUserId: 7,
    });

    // Preview was refetched (so the admin submitted against the freshest counts)
    expect(handler.previewRequests.length).toBeGreaterThanOrEqual(2);

    // Success toast surfaces the reversed/skipped breakdown
    await waitFor(() => {
      expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({
        title: expect.stringMatching(/reversed/i),
        description: expect.stringMatching(/3 reversed.*1 skipped/),
      }));
    });

    // The dialog notifies its parent so the audit list can refresh
    await waitFor(() => expect(onReversed).toHaveBeenCalled());
  });
});
