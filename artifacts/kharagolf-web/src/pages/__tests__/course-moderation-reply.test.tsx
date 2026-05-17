/**
 * Task #790 — UI coverage for the admin-reply flow on course-moderation.tsx.
 *
 * Drives the user-visible flow against a mocked fetch:
 *   - the moderation page boots into the Pending list,
 *   - the admin clicks the Approved filter and the page refetches,
 *   - the admin opens the reply editor on an approved review, types a reply,
 *     and clicks Save,
 *   - the page sends the right PUT body to
 *     /api/organizations/:orgId/marketing-site/course-reviews/:id/reply,
 *   - on success the inline reply (data-testid="review-reply-:id") shows the
 *     new text and the page surfaces the "Reply posted" toast.
 *
 * Pairs with the page-level rendering test in
 *   artifacts/kharagolf-website/src/pages/__tests__/course-page-admin-reply.test.tsx
 * which asserts the saved reply appears under the review on the public course page.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

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

import CourseModerationPage from "../course-moderation";

interface ApprovedReview {
  id: number;
  courseId: number;
  rating: number;
  title: string | null;
  body: string | null;
  reviewerDisplayName: string | null;
  reviewerEmail: string | null;
  displayMode: string | null;
  status: string;
  abuseReportCount: number;
  createdAt: string;
  adminReply: string | null;
  adminReplyAt: string | null;
}

function makeApprovedReview(id: number, title: string, adminReply: string | null = null): ApprovedReview {
  return {
    id,
    courseId: 7,
    rating: 5,
    title,
    body: `Body for ${title}`,
    reviewerDisplayName: "Riley Reviewer",
    reviewerEmail: "rev@example.com",
    displayMode: "public",
    status: "approved",
    abuseReportCount: 0,
    createdAt: new Date().toISOString(),
    adminReply,
    adminReplyAt: adminReply ? new Date().toISOString() : null,
  };
}

interface State {
  pending: ApprovedReview[];
  approved: ApprovedReview[];
  pendingFetches: number;
  approvedFetches: number;
  replyRequests: Array<{ url: string; body: { reply: string | null } }>;
}

let state: State;

function installFetch() {
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";

    // Reply endpoint — PUT .../course-reviews/:id/reply
    const replyMatch = url.match(/\/marketing-site\/course-reviews\/(\d+)\/reply$/);
    if (replyMatch && method === "PUT") {
      const id = Number(replyMatch[1]);
      const body = JSON.parse(String(init?.body ?? "{}")) as { reply: string | null };
      state.replyRequests.push({ url, body });
      // Mirror the server behaviour: the row in the approved list now carries
      // the new adminReply / adminReplyAt so the next refetch picks them up.
      const next = state.approved.map(r =>
        r.id === id
          ? { ...r, adminReply: body.reply, adminReplyAt: body.reply ? new Date().toISOString() : null }
          : r,
      );
      state.approved = next;
      const updated = next.find(r => r.id === id)!;
      return new Response(JSON.stringify({
        ...updated, adminReplyByUserId: body.reply ? 1 : null,
      }), { status: 200, headers: { "Content-Type": "application/json" } }) as unknown as Response;
    }

    if (url.includes("/marketing-site/course-reviews?status=pending")) {
      state.pendingFetches += 1;
      return new Response(JSON.stringify(state.pending), {
        status: 200, headers: { "Content-Type": "application/json" },
      }) as unknown as Response;
    }
    if (url.includes("/marketing-site/course-reviews?status=approved")) {
      state.approvedFetches += 1;
      return new Response(JSON.stringify(state.approved), {
        status: 200, headers: { "Content-Type": "application/json" },
      }) as unknown as Response;
    }
    if (url.includes("/marketing-site/course-photos")) {
      return new Response(JSON.stringify([]), {
        status: 200, headers: { "Content-Type": "application/json" },
      }) as unknown as Response;
    }
    if (url.match(/\/organizations\/\d+\/courses(\?|$)/)) {
      return new Response(JSON.stringify([{ id: 7, name: "Riverbend" }]), {
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
      <CourseModerationPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  toastMock.mockReset();
  state = {
    pending: [],
    approved: [makeApprovedReview(501, "Loved it")],
    pendingFetches: 0,
    approvedFetches: 0,
    replyRequests: [],
  };
  installFetch();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("<CourseModerationPage /> — admin reply flow", () => {
  it("switching to the Approved filter shows the reply editor only on approved rows", async () => {
    const user = userEvent.setup();
    renderPage();

    // Initial render hits the pending list (no rows) → no reply editor.
    await waitFor(() => expect(state.pendingFetches).toBeGreaterThanOrEqual(1));
    expect(screen.queryByTestId("button-edit-reply-501")).not.toBeInTheDocument();

    // Click the Approved tab and wait for the new fetch.
    await user.click(screen.getByTestId("filter-reviews-approved"));
    await waitFor(() => expect(state.approvedFetches).toBeGreaterThanOrEqual(1));

    // The approved row + its "Write a reply" button must now be visible.
    await screen.findByTestId("review-row-501");
    expect(await screen.findByTestId("button-edit-reply-501")).toBeInTheDocument();
  });

  it("posting a reply sends PUT { reply } and renders the reply on the row", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByTestId("filter-reviews-approved"));
    await screen.findByTestId("review-row-501");

    // Open the editor.
    await user.click(await screen.findByTestId("button-edit-reply-501"));

    // Type a reply and save.
    const textarea = await screen.findByTestId("textarea-reply-501") as HTMLTextAreaElement;
    await user.type(textarea, "Thanks for visiting!");
    const saveBtn = await screen.findByTestId("button-save-reply-501");
    expect(saveBtn).not.toBeDisabled();
    await user.click(saveBtn);

    // The PUT payload must carry the trimmed reply.
    await waitFor(() => expect(state.replyRequests.length).toBe(1));
    expect(state.replyRequests[0].body).toEqual({ reply: "Thanks for visiting!" });
    expect(state.replyRequests[0].url).toMatch(/\/organizations\/42\/marketing-site\/course-reviews\/501\/reply$/);

    // Success toast.
    await waitFor(() => {
      expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({
        title: "Reply posted",
      }));
    });

    // The inline reply now renders with the new text on the same row.
    const replyEl = await screen.findByTestId("review-reply-501");
    expect(replyEl).toHaveTextContent("Thanks for visiting!");
  });

  it("the Save button stays disabled until the draft has non-empty content", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByTestId("filter-reviews-approved"));
    await user.click(await screen.findByTestId("button-edit-reply-501"));

    const saveBtn = await screen.findByTestId("button-save-reply-501");
    // Empty draft → disabled.
    expect(saveBtn).toBeDisabled();

    // Whitespace-only draft is still disabled (matches the trim() guard).
    const textarea = await screen.findByTestId("textarea-reply-501") as HTMLTextAreaElement;
    await user.type(textarea, "   ");
    expect(saveBtn).toBeDisabled();

    // Real content enables it.
    await user.type(textarea, "Hi!");
    expect(saveBtn).not.toBeDisabled();
  });
});
