/**
 * UI test: Bulk-verifying pending documents from the staff queue (Task #265).
 *
 * Mounts <DocumentsPendingPage /> with a mocked fetch and a mocked router/auth
 * stack. Drives the user-visible flow: load the queue, select multiple rows,
 * click "Verify selected", and assert the queue refreshes plus the toast
 * reflects success and (when relevant) per-row error counts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, within, cleanup } from "@testing-library/react";
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

interface FetchHandler {
  pending: PendingDoc[];
  bulkResponse?: {
    verifiedCount: number;
    errorCount: number;
    verified: Array<{ id: number; clubMemberId: number }>;
    errors: Array<{ documentId: number; error: string }>;
  };
  /** Updated `pending` returned on the refetch after a successful bulk verify. */
  pendingAfter?: PendingDoc[];
  bulkRequests: Array<{ documentIds: number[] }>;
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
    if (url.includes("/documents/verify-bulk") && init?.method === "POST") {
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
  // disable retries so test failures surface immediately, and turn off the
  // 30s background refetch so it doesn't race assertions
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

describe("<DocumentsPendingPage /> — bulk verify", () => {
  it("selects rows, verifies them, and refreshes the queue with a success toast", async () => {
    handler.bulkResponse = {
      verifiedCount: 2, errorCount: 0,
      verified: [{ id: 101, clubMemberId: 201 }, { id: 102, clubMemberId: 202 }],
      errors: [],
    };
    handler.pendingAfter = [makeDoc(103, "Doc Gamma")];

    const user = userEvent.setup();
    renderPage();

    // Wait for queue to load
    await screen.findByText("Doc Alpha");
    expect(screen.getByText("Doc Beta")).toBeInTheDocument();
    expect(screen.getByText("Doc Gamma")).toBeInTheDocument();

    // Bulk verify button hidden until something is selected
    expect(screen.queryByTestId("button-verify-selected")).not.toBeInTheDocument();

    // Select two of three rows
    await user.click(screen.getByTestId("checkbox-select-101"));
    await user.click(screen.getByTestId("checkbox-select-102"));

    const verifyBtn = await screen.findByTestId("button-verify-selected");
    expect(verifyBtn).toHaveTextContent(/Verify selected \(2\)/);

    await user.click(verifyBtn);

    // The bulk endpoint receives exactly the two selected ids (no leftovers)
    await waitFor(() => expect(handler.bulkRequests.length).toBe(1));
    expect(handler.bulkRequests[0].documentIds.sort()).toEqual([101, 102]);

    // Success toast surfaces verified count
    await waitFor(() => {
      expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({
        title: expect.stringMatching(/Verified 2 documents/),
      }));
    });
    // No error toast when there are no per-row failures
    expect(toastMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ variant: "destructive" }),
    );

    // Queue refetches and the verified rows disappear
    await waitFor(() => expect(handler.pendingFetchCount).toBeGreaterThanOrEqual(2));
    await waitFor(() => expect(screen.queryByText("Doc Alpha")).not.toBeInTheDocument());
    expect(screen.queryByText("Doc Beta")).not.toBeInTheDocument();
    expect(screen.getByText("Doc Gamma")).toBeInTheDocument();
  });

  it("surfaces per-row errors in a destructive toast and keeps failed rows selected", async () => {
    handler.bulkResponse = {
      verifiedCount: 1, errorCount: 2,
      verified: [{ id: 101, clubMemberId: 201 }],
      errors: [
        { documentId: 102, error: "Document is already verified." },
        { documentId: 103, error: "Document was rejected and cannot be verified." },
      ],
    };
    // Doc 101 disappears from the refresh, the two failed docs remain
    handler.pendingAfter = [makeDoc(102, "Doc Beta"), makeDoc(103, "Doc Gamma")];

    const user = userEvent.setup();
    renderPage();
    await screen.findByText("Doc Alpha");

    await user.click(screen.getByTestId("checkbox-select-101"));
    await user.click(screen.getByTestId("checkbox-select-102"));
    await user.click(screen.getByTestId("checkbox-select-103"));

    const verifyBtn = await screen.findByTestId("button-verify-selected");
    expect(verifyBtn).toHaveTextContent(/Verify selected \(3\)/);
    await user.click(verifyBtn);

    await waitFor(() => expect(handler.bulkRequests.length).toBe(1));

    // Both a success and a destructive (error) toast are emitted
    await waitFor(() => {
      const titles = toastMock.mock.calls.map((c) => c[0]?.title);
      expect(titles).toEqual(expect.arrayContaining([
        expect.stringMatching(/Verified 1 document/),
        expect.stringMatching(/2 documents not verified/),
      ]));
    });
    const destructiveCall = toastMock.mock.calls.find((c) => c[0]?.variant === "destructive");
    expect(destructiveCall).toBeTruthy();
    // Description includes the per-row errors so staff can act on them
    expect(destructiveCall![0].description).toMatch(/already verified/i);
    expect(destructiveCall![0].description).toMatch(/rejected/i);

    // Queue refreshes; verified row gone, failed rows still present and still selected
    await waitFor(() => expect(screen.queryByText("Doc Alpha")).not.toBeInTheDocument());
    expect(screen.getByText("Doc Beta")).toBeInTheDocument();
    expect(screen.getByText("Doc Gamma")).toBeInTheDocument();
    expect(screen.getByTestId("checkbox-select-102")).toBeChecked();
    expect(screen.getByTestId("checkbox-select-103")).toBeChecked();

    // Bulk button still reflects the remaining (failed) selection so staff can retry
    const retryBtn = within(document.body).queryByTestId("button-verify-selected");
    expect(retryBtn).not.toBeNull();
    expect(retryBtn).toHaveTextContent(/Verify selected \(2\)/);
  });
});
