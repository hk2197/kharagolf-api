/**
 * UI test: dashboard "Assigned to me" unread-count badge (Task #284 / #337).
 *
 * Mounts <PrivacyRequestsWidget /> with a mocked fetch and asserts the
 * dashboard contract called out by the task spec:
 *   - the `privacy-filter-mine` toggle renders a `privacy-unread-badge`
 *     showing the API's `unreadAssignedToMe` count
 *   - reloading after the API count drops to zero (i.e. the handler
 *     opened the Member 360 Data tab and the GET marked the in-app
 *     handler-assigned notice read) clears the badge
 *   - the new-handler / old-handler reassignment flow surfaces correctly
 *     in the widget for whichever viewer is logged in
 *
 * The backend lifecycle (open list returning the right `unreadAssignedToMe`
 * + per-row `assignmentUnread`, plus the GET /:memberId/data-requests
 * route flipping `read_at` on the underlying member_messages row) is
 * separately covered against the live PostgreSQL test DB by
 * artifacts/api-server/src/tests/data-request-unread-badge.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import userEvent from "@testing-library/user-event";

vi.mock("wouter", () => ({
  Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) =>
    <a href={href} data-testid="wouter-link" {...rest}>{children}</a>,
}));

import { PrivacyRequestsWidget } from "../dashboard";

interface OpenPrivacyRow {
  id: number;
  clubMemberId: number;
  requestType: string;
  status: string;
  requestedAt: string;
  dueBy: string | null;
  notes?: string | null;
  handlerUserId: number | null;
  handlerDisplayName?: string | null;
  handlerUsername?: string | null;
  handlerEmail?: string | null;
  memberFirstName: string;
  memberLastName: string;
  memberNumber?: string | null;
  assignmentUnread?: boolean;
}
interface OpenPrivacyResponse {
  counts: { open: number; overdue: number; dueSoon: number };
  requests: OpenPrivacyRow[];
  unreadAssignedToMe?: number;
}

interface FetchHandler {
  /** Response returned for `?assignedToMe=true`. */
  mine: OpenPrivacyResponse;
  /** Response returned for the unfiltered list. */
  all: OpenPrivacyResponse;
  mineCalls: number;
  allCalls: number;
}

let handler: FetchHandler;

function emptyResponse(): OpenPrivacyResponse {
  return { counts: { open: 0, overdue: 0, dueSoon: 0 }, requests: [], unreadAssignedToMe: 0 };
}

function installFetch() {
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/data-requests/open")) {
      const isMine = url.includes("assignedToMe=true");
      const body = isMine ? handler.mine : handler.all;
      if (isMine) handler.mineCalls += 1;
      else handler.allCalls += 1;
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }) as unknown as Response;
    }
    return new Response("not found", { status: 404 }) as unknown as Response;
  }) as typeof fetch;
}

function renderWidget(currentUserId: number | undefined = 99, orgId = 42) {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: 0, refetchOnWindowFocus: false },
    },
  });
  const utils = render(
    <QueryClientProvider client={qc}>
      <PrivacyRequestsWidget orgId={orgId} currentUserId={currentUserId} />
    </QueryClientProvider>,
  );
  return { qc, ...utils };
}

function makeRow(overrides: Partial<OpenPrivacyRow> = {}): OpenPrivacyRow {
  const now = new Date();
  return {
    id: 1,
    clubMemberId: 10,
    requestType: "access",
    status: "pending",
    requestedAt: now.toISOString(),
    dueBy: new Date(now.getTime() + 30 * 86400_000).toISOString(),
    handlerUserId: 99,
    memberFirstName: "Pat",
    memberLastName: "Member",
    assignmentUnread: true,
    ...overrides,
  };
}

beforeEach(() => {
  handler = {
    mine: emptyResponse(),
    all: emptyResponse(),
    mineCalls: 0,
    allCalls: 0,
  };
  installFetch();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("<PrivacyRequestsWidget /> — assigned-to-me unread badge", () => {
  it("does not render the badge when unreadAssignedToMe is 0", async () => {
    handler.all = { ...emptyResponse(), unreadAssignedToMe: 0 };
    renderWidget();

    // Wait for the All-mode fetch to settle and the toggle to render.
    const toggle = await screen.findByTestId("privacy-filter-mine");
    expect(toggle).toBeInTheDocument();
    expect(screen.queryByTestId("privacy-unread-badge")).not.toBeInTheDocument();
  });

  it("shows the badge with the count from the API and clears it after the count drops to zero", async () => {
    // Initial state: handler A is the assignee, has 1 unread assignment.
    handler.mine = {
      counts: { open: 1, overdue: 0, dueSoon: 1 },
      requests: [makeRow({ id: 7, handlerUserId: 99, assignmentUnread: true })],
      unreadAssignedToMe: 1,
    };
    handler.all = {
      counts: { open: 1, overdue: 0, dueSoon: 1 },
      requests: [makeRow({ id: 7, handlerUserId: 99, assignmentUnread: true })],
      unreadAssignedToMe: 1,
    };

    const { qc } = renderWidget(99);

    // Badge appears next to the "Assigned to me" toggle even before the
    // viewer engages the toggle — the dashboard surfaces the count from
    // the unfiltered list so admins notice unread work without clicking.
    const badge = await screen.findByTestId("privacy-unread-badge");
    expect(badge).toHaveTextContent("1");
    expect(badge).toHaveAccessibleName(/1 unread assignment/);

    // Engage the "Assigned to me" toggle — the widget refetches with
    // ?assignedToMe=true and the badge still shows 1 from that response.
    const toggle = screen.getByTestId("privacy-filter-mine");
    await userEvent.click(toggle);
    await waitFor(() => expect(handler.mineCalls).toBeGreaterThanOrEqual(1));
    expect(screen.getByTestId("privacy-unread-badge")).toHaveTextContent("1");

    // Simulate the user opening the Member 360 Data tab, which marks the
    // underlying handler-assigned notice as read on the server. The next
    // refetch returns unreadAssignedToMe=0.
    handler.mine = {
      counts: { open: 1, overdue: 0, dueSoon: 1 },
      requests: [makeRow({ id: 7, handlerUserId: 99, assignmentUnread: false })],
      unreadAssignedToMe: 0,
    };
    handler.all = {
      counts: { open: 1, overdue: 0, dueSoon: 1 },
      requests: [makeRow({ id: 7, handlerUserId: 99, assignmentUnread: false })],
      unreadAssignedToMe: 0,
    };

    // Force the widget to refetch (mirrors the dashboard reload the task
    // spec asks us to assert on — the polling refetchInterval would do
    // the same in the wild after 60s).
    await qc.invalidateQueries({ queryKey: ["/api/organizations", 42, "data-requests", "open"] });

    // Badge disappears once the API reports zero unread.
    await waitFor(() => {
      expect(screen.queryByTestId("privacy-unread-badge")).not.toBeInTheDocument();
    });
    // The toggle itself remains so the viewer can still narrow the list.
    expect(screen.getByTestId("privacy-filter-mine")).toBeInTheDocument();
  });

  it("reassignment: new handler sees the badge and the previous handler does not", async () => {
    // ── Mount as the NEW handler (id 200) — sees the badge with count 1.
    handler.all = {
      counts: { open: 1, overdue: 0, dueSoon: 1 },
      requests: [makeRow({ id: 12, handlerUserId: 200, assignmentUnread: true })],
      unreadAssignedToMe: 1,
    };
    handler.mine = handler.all;
    const newHandler = renderWidget(200);
    const newBadge = await screen.findByTestId("privacy-unread-badge");
    expect(newBadge).toHaveTextContent("1");
    expect(newBadge).toHaveAccessibleName(/1 unread assignment/);
    newHandler.unmount();
    cleanup();

    // ── Mount as the PREVIOUS handler (id 99) — the API now reports the
    // request belongs to handler 200 with unreadAssignedToMe=0 for the
    // viewer. The badge must NOT render.
    handler = {
      // The previous handler's mine-only list no longer contains the
      // reassigned request and reports zero unread for them.
      mine: { counts: { open: 0, overdue: 0, dueSoon: 0 }, requests: [], unreadAssignedToMe: 0 },
      all: {
        counts: { open: 1, overdue: 0, dueSoon: 1 },
        // The unfiltered list still shows the row but assigned to someone
        // else; the unread count for THIS viewer is 0 because the row
        // isn't theirs anymore.
        requests: [makeRow({ id: 12, handlerUserId: 200, assignmentUnread: false })],
        unreadAssignedToMe: 0,
      },
      mineCalls: 0,
      allCalls: 0,
    };
    installFetch();

    renderWidget(99);
    // Wait for the All-mode fetch to settle.
    await screen.findByTestId("privacy-filter-mine");
    await waitFor(() => expect(handler.allCalls).toBeGreaterThanOrEqual(1));
    expect(screen.queryByTestId("privacy-unread-badge")).not.toBeInTheDocument();
  });
});
