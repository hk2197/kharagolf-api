/**
 * UI test: Bulk-rejecting pending documents from the staff queue (Task #264 / #326).
 *
 * Mounts <DocumentsPendingPage /> with a mocked fetch and a mocked router/auth
 * stack. Drives the user-visible flow: load the queue, select multiple rows,
 * click "Reject selected", open the bulk dialog, type a reason, submit it, and
 * assert that:
 *   - the request body carries every selected id and the trimmed reason,
 *   - successfully-rejected ids drop out of the selection,
 *   - per-row failures keep their rows selected and surface a destructive toast.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("wouter", () => ({
  Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) =>
    <a href={href} {...rest}>{children}</a>,
}));

vi.mock("@workspace/api-client-react", () => ({
  useGetMe: () => ({ data: { id: 1, organizationId: 42, role: "org_admin" } }),
}));

vi.mock("@/context/ActiveOrgContext", () => ({
  useActiveOrgContext: () => ({ activeOrgId: 42, isOrgOverridden: false, setActiveOrg: () => {} }),
}));

const toastMock = vi.fn();
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: toastMock }),
}));

import DocumentsPendingPage from "../documents-pending";

interface PendingDoc {
  id: number;
  clubMemberId: number;
  documentType: string;
  title: string;
  fileUrl: string;
  mimeType: string | null;
  fileSize: number | null;
  expiresAt: string | null;
  uploadedByUserId: number | null;
  createdAt: string;
  memberFirstName: string | null;
  memberLastName: string | null;
  memberNumber: string | null;
}

function makeDoc(id: number, title: string): PendingDoc {
  return {
    id,
    clubMemberId: 100 + id,
    documentType: "id_proof",
    title,
    fileUrl: `https://example.com/${id}.pdf`,
    mimeType: "application/pdf",
    fileSize: 1024,
    expiresAt: null,
    uploadedByUserId: null,
    createdAt: new Date().toISOString(),
    memberFirstName: "Test",
    memberLastName: `Member${id}`,
    memberNumber: `M${id}`,
  };
}

interface BulkRejectResponse {
  rejectedCount: number;
  errorCount: number;
  rejected: Array<{ id: number; clubMemberId: number; notification?: unknown }>;
  errors: Array<{ documentId: number; error: string }>;
}

interface FetchHandler {
  pending: PendingDoc[];
  pendingAfter?: PendingDoc[];
  bulkResponse?: BulkRejectResponse;
  bulkRequests: Array<{ documentIds: number[]; reason: string }>;
  pendingFetchCount: number;
}

let handler: FetchHandler;

function installFetch() {
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/documents/pending")) {
      handler.pendingFetchCount += 1;
      const docs = handler.pendingFetchCount > 1 && handler.pendingAfter
        ? handler.pendingAfter
        : handler.pending;
      return new Response(JSON.stringify({ count: docs.length, documents: docs }), {
        status: 200, headers: { "Content-Type": "application/json" },
      }) as unknown as Response;
    }
    if (url.includes("/documents/reject-bulk") && init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      handler.bulkRequests.push(body);
      return new Response(JSON.stringify(handler.bulkResponse), {
        status: 200, headers: { "Content-Type": "application/json" },
      }) as unknown as Response;
    }
    return new Response("not found", { status: 404 }) as unknown as Response;
  }) as typeof fetch;
}

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchInterval: false, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={qc}>
      <DocumentsPendingPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  toastMock.mockReset();
  handler = {
    pending: [
      makeDoc(101, "Doc Alpha"),
      makeDoc(102, "Doc Beta"),
      makeDoc(103, "Doc Gamma"),
    ],
    bulkRequests: [],
    pendingFetchCount: 0,
  };
  installFetch();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("<DocumentsPendingPage /> — bulk reject", () => {
  it("opens the dialog, submits a reason, drops rejected ids, and refreshes the queue", async () => {
    handler.bulkResponse = {
      rejectedCount: 2, errorCount: 0,
      rejected: [
        { id: 101, clubMemberId: 201 },
        { id: 102, clubMemberId: 202 },
      ],
      errors: [],
    };
    handler.pendingAfter = [makeDoc(103, "Doc Gamma")];

    const user = userEvent.setup();
    renderPage();

    await screen.findByText("Doc Alpha");
    expect(screen.getByText("Doc Beta")).toBeInTheDocument();

    // Bulk-reject button hidden until something is selected
    expect(screen.queryByTestId("button-reject-selected")).not.toBeInTheDocument();

    await user.click(screen.getByTestId("checkbox-select-101"));
    await user.click(screen.getByTestId("checkbox-select-102"));

    const rejectBtn = await screen.findByTestId("button-reject-selected");
    expect(rejectBtn).toHaveTextContent(/Reject selected \(2\)/);

    // Open the bulk-reject dialog
    await user.click(rejectBtn);
    const reasonBox = await screen.findByTestId("textarea-bulk-reject-reason");
    const confirmBtn = screen.getByTestId("button-confirm-bulk-reject");
    // Confirm disabled until a reason is supplied
    expect(confirmBtn).toBeDisabled();

    await user.type(reasonBox, "  Photos are blurry, please re-upload.  ");
    expect(confirmBtn).not.toBeDisabled();

    await user.click(confirmBtn);

    // The bulk endpoint receives exactly the two selected ids and the trimmed reason
    await waitFor(() => expect(handler.bulkRequests.length).toBe(1));
    expect(handler.bulkRequests[0].documentIds.sort()).toEqual([101, 102]);
    expect(handler.bulkRequests[0].reason).toBe("Photos are blurry, please re-upload.");

    // Success toast surfaces rejected count
    await waitFor(() => {
      expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({
        title: expect.stringMatching(/Rejected 2 documents/),
      }));
    });
    // No destructive toast when there are no per-row failures
    expect(toastMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ variant: "destructive" }),
    );

    // Queue refetches and the rejected rows disappear
    await waitFor(() => expect(handler.pendingFetchCount).toBeGreaterThanOrEqual(2));
    await waitFor(() => expect(screen.queryByText("Doc Alpha")).not.toBeInTheDocument());
    expect(screen.queryByText("Doc Beta")).not.toBeInTheDocument();
    expect(screen.getByText("Doc Gamma")).toBeInTheDocument();

    // Selection cleared (no remaining rows selected) → bulk button gone
    expect(screen.queryByTestId("button-reject-selected")).not.toBeInTheDocument();
  });

  it("keeps failed rows selected and surfaces per-row errors in a destructive toast", async () => {
    handler.bulkResponse = {
      rejectedCount: 1, errorCount: 2,
      rejected: [{ id: 101, clubMemberId: 201 }],
      errors: [
        { documentId: 102, error: "Cannot reject a document that has already been verified." },
        { documentId: 103, error: "Document is already rejected." },
      ],
    };
    // Doc 101 disappears from the refresh, the two failed docs remain pending
    handler.pendingAfter = [makeDoc(102, "Doc Beta"), makeDoc(103, "Doc Gamma")];

    const user = userEvent.setup();
    renderPage();
    await screen.findByText("Doc Alpha");

    await user.click(screen.getByTestId("checkbox-select-101"));
    await user.click(screen.getByTestId("checkbox-select-102"));
    await user.click(screen.getByTestId("checkbox-select-103"));

    const rejectBtn = await screen.findByTestId("button-reject-selected");
    expect(rejectBtn).toHaveTextContent(/Reject selected \(3\)/);
    await user.click(rejectBtn);

    const reasonBox = await screen.findByTestId("textarea-bulk-reject-reason");
    await user.type(reasonBox, "Please re-upload clearer scans.");
    await user.click(screen.getByTestId("button-confirm-bulk-reject"));

    await waitFor(() => expect(handler.bulkRequests.length).toBe(1));
    expect(handler.bulkRequests[0].documentIds.sort()).toEqual([101, 102, 103]);

    // Both a success and a destructive toast are emitted
    await waitFor(() => {
      const titles = toastMock.mock.calls.map((c) => c[0]?.title);
      expect(titles).toEqual(expect.arrayContaining([
        expect.stringMatching(/Rejected 1 document/),
        expect.stringMatching(/2 documents not rejected/),
      ]));
    });
    const destructiveCall = toastMock.mock.calls.find((c) => c[0]?.variant === "destructive");
    expect(destructiveCall).toBeTruthy();
    expect(destructiveCall![0].description).toMatch(/already.*verified/i);
    expect(destructiveCall![0].description).toMatch(/already rejected/i);

    // Queue refreshes; rejected row gone, failed rows still present and still selected
    await waitFor(() => expect(screen.queryByText("Doc Alpha")).not.toBeInTheDocument());
    expect(screen.getByText("Doc Beta")).toBeInTheDocument();
    expect(screen.getByText("Doc Gamma")).toBeInTheDocument();
    expect(screen.getByTestId("checkbox-select-102")).toBeChecked();
    expect(screen.getByTestId("checkbox-select-103")).toBeChecked();

    // Bulk-reject button still reflects the remaining (failed) selection so staff can retry
    const retryBtn = screen.queryByTestId("button-reject-selected");
    expect(retryBtn).not.toBeNull();
    expect(retryBtn).toHaveTextContent(/Reject selected \(2\)/);
  });

  it("blocks submission when the reason is blank/whitespace-only", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("Doc Alpha");

    await user.click(screen.getByTestId("checkbox-select-101"));
    await user.click(await screen.findByTestId("button-reject-selected"));

    const reasonBox = await screen.findByTestId("textarea-bulk-reject-reason");
    const confirmBtn = screen.getByTestId("button-confirm-bulk-reject");
    expect(confirmBtn).toBeDisabled();

    await user.type(reasonBox, "   ");
    // Spaces alone don't enable the button (trim().length === 0)
    expect(confirmBtn).toBeDisabled();

    // No request was made
    expect(handler.bulkRequests.length).toBe(0);
  });
});
