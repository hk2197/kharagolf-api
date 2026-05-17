/**
 * UI test (Task #777): the controller dashboard PrivacyRequestsWidget
 * surfaces the new `completed_export` notification kind.
 *
 *   - Rows whose `lastNotificationKind` is `completed_export` render an
 *     "Export ready" badge so admins can spot a delivered download notice
 *     at a glance.
 *   - The new "Export ready" filter tab isolates those rows.
 *   - Rows for other kinds (or no notice yet) do not render the badge.
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

interface Row {
  id: number;
  clubMemberId: number;
  requestType: string;
  status: string;
  requestedAt: string;
  dueBy: string | null;
  handlerUserId: number | null;
  memberFirstName: string;
  memberLastName: string;
  lastNotificationKind?: string | null;
  lastNotifiedAt?: string | null;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  }) as unknown as Response;
}

function makeRow(overrides: Partial<Row> = {}): Row {
  const now = new Date();
  return {
    id: 1,
    clubMemberId: 10,
    requestType: "access",
    status: "pending",
    requestedAt: now.toISOString(),
    dueBy: new Date(now.getTime() + 30 * 86_400_000).toISOString(),
    handlerUserId: null,
    memberFirstName: "Pat",
    memberLastName: "Member",
    ...overrides,
  };
}

let rows: Row[];

beforeEach(() => {
  rows = [];
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/data-requests/open")) {
      return jsonResponse({
        counts: { open: rows.length, overdue: 0, dueSoon: 0 },
        requests: rows,
        unreadAssignedToMe: 0,
      });
    }
    return new Response("not found", { status: 404 }) as unknown as Response;
  }) as typeof fetch;
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function renderWidget() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0, refetchOnWindowFocus: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <PrivacyRequestsWidget orgId={42} currentUserId={99} />
    </QueryClientProvider>,
  );
}

describe("<PrivacyRequestsWidget /> — Task #777 export-ready notice", () => {
  it("renders an Export ready badge only on rows whose lastNotificationKind is completed_export", async () => {
    rows = [
      makeRow({ id: 1, lastNotificationKind: "filed", memberFirstName: "Filed" }),
      makeRow({ id: 2, lastNotificationKind: "completed_export", memberFirstName: "Export", lastNotifiedAt: new Date().toISOString() }),
      makeRow({ id: 3, lastNotificationKind: null, memberFirstName: "None" }),
    ];
    renderWidget();

    await screen.findByTestId("privacy-row-2");
    expect(screen.getByTestId("privacy-export-ready-2")).toBeInTheDocument();
    expect(screen.queryByTestId("privacy-export-ready-1")).not.toBeInTheDocument();
    expect(screen.queryByTestId("privacy-export-ready-3")).not.toBeInTheDocument();

    const exportRow = screen.getByTestId("privacy-row-2");
    expect(exportRow).toHaveAttribute("data-last-notification-kind", "completed_export");
  });

  it("Export ready filter tab isolates completed_export rows and shows the count", async () => {
    rows = [
      makeRow({ id: 1, lastNotificationKind: "filed", memberFirstName: "Filed" }),
      makeRow({ id: 2, lastNotificationKind: "completed_export", memberFirstName: "Exporter A" }),
      makeRow({ id: 4, lastNotificationKind: "completed_export", memberFirstName: "Exporter B" }),
    ];
    renderWidget();

    const tab = await screen.findByTestId("privacy-filter-export-ready");
    await waitFor(() => expect(tab).toHaveTextContent("Export ready (2)"));

    await userEvent.click(tab);

    await waitFor(() => {
      expect(screen.queryByTestId("privacy-row-1")).not.toBeInTheDocument();
    });
    expect(screen.getByTestId("privacy-row-2")).toBeInTheDocument();
    expect(screen.getByTestId("privacy-row-4")).toBeInTheDocument();
  });
});
