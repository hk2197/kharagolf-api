/**
 * UI test: Bulk-moderating reviews and photos from the Course Moderation page (Task #629 / #788).
 *
 * Mounts <CourseModerationPage /> with a mocked fetch and a mocked auth/org
 * stack. Drives the user-visible flow:
 *   - load the queue, select rows via the per-row + select-all checkboxes,
 *   - click "Approve selected" / "Reject selected" for both reviews and photos,
 *   - assert the request body carries every selected id and the right action,
 *   - assert successfully-handled ids drop out of the selection while failed
 *     rows stay selected so staff can retry,
 *   - assert per-row failures surface in a destructive toast.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, cleanup, within } from "@testing-library/react";
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

interface PendingReview {
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

interface PendingPhoto {
  id: number;
  courseId: number;
  objectPath: string;
  thumbnailPath: string | null;
  caption: string | null;
  holeNumber: number | null;
  isHero: boolean;
  mediaType: string | null;
  uploaderName: string | null;
  approved: boolean;
  createdAt: string;
}

function makeReview(id: number, title: string): PendingReview {
  return {
    id,
    courseId: 7,
    rating: 4,
    title,
    body: `Body for ${title}`,
    reviewerDisplayName: "Reviewer",
    reviewerEmail: "rev@example.com",
    displayMode: "public",
    status: "pending",
    abuseReportCount: 0,
    createdAt: new Date().toISOString(),
    adminReply: null,
    adminReplyAt: null,
  };
}

function makePhoto(id: number, caption: string): PendingPhoto {
  return {
    id,
    courseId: 7,
    objectPath: `/photo-${id}.jpg`,
    thumbnailPath: null,
    caption,
    holeNumber: null,
    isHero: false,
    mediaType: "image",
    uploaderName: "Test Uploader",
    approved: false,
    createdAt: new Date().toISOString(),
  };
}

interface BulkReviewResp {
  updatedCount: number;
  errorCount: number;
  status: "approved" | "rejected" | "hidden";
  updated: Array<{ id: number; courseId: number; status: string }>;
  errors: Array<{ reviewId: number; error: string }>;
}

interface BulkPhotoResp {
  updatedCount: number;
  errorCount: number;
  action: "approve" | "reject";
  updated: Array<{ id: number; courseId: number | null }>;
  errors: Array<{ photoId: number; error: string }>;
}

interface FetchHandler {
  reviewsPending: PendingReview[];
  reviewsPendingAfter?: PendingReview[];
  photosPending: PendingPhoto[];
  photosPendingAfter?: PendingPhoto[];
  reviewsBulkResp?: BulkReviewResp;
  photosBulkResp?: BulkPhotoResp;
  bulkReviewRequests: Array<{ reviewIds: number[]; status: string }>;
  bulkPhotoRequests: Array<{ photoIds: number[]; action: string }>;
  reviewsFetchCount: number;
  photosFetchCount: number;
}

let handler: FetchHandler;

function installFetch() {
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/marketing-site/course-reviews/moderate-bulk") && init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      handler.bulkReviewRequests.push(body);
      return new Response(JSON.stringify(handler.reviewsBulkResp), {
        status: 200, headers: { "Content-Type": "application/json" },
      }) as unknown as Response;
    }
    if (url.includes("/marketing-site/course-photos/moderate-bulk") && init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      handler.bulkPhotoRequests.push(body);
      return new Response(JSON.stringify(handler.photosBulkResp), {
        status: 200, headers: { "Content-Type": "application/json" },
      }) as unknown as Response;
    }
    if (url.includes("/marketing-site/course-reviews")) {
      handler.reviewsFetchCount += 1;
      const list = handler.reviewsFetchCount > 1 && handler.reviewsPendingAfter
        ? handler.reviewsPendingAfter
        : handler.reviewsPending;
      return new Response(JSON.stringify(list), {
        status: 200, headers: { "Content-Type": "application/json" },
      }) as unknown as Response;
    }
    if (url.includes("/marketing-site/course-photos")) {
      handler.photosFetchCount += 1;
      const list = handler.photosFetchCount > 1 && handler.photosPendingAfter
        ? handler.photosPendingAfter
        : handler.photosPending;
      return new Response(JSON.stringify(list), {
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
  handler = {
    reviewsPending: [
      makeReview(101, "Great course"),
      makeReview(102, "Loved it"),
      makeReview(103, "OK"),
    ],
    photosPending: [
      makePhoto(201, "Hole 1 view"),
      makePhoto(202, "Sunset"),
      makePhoto(203, "Clubhouse"),
    ],
    bulkReviewRequests: [],
    bulkPhotoRequests: [],
    reviewsFetchCount: 0,
    photosFetchCount: 0,
  };
  installFetch();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("<CourseModerationPage /> — bulk reviews", () => {
  it("select-all + Approve selected sends every visible id and clears the selection on success", async () => {
    handler.reviewsBulkResp = {
      updatedCount: 3, errorCount: 0, status: "approved",
      updated: [
        { id: 101, courseId: 7, status: "approved" },
        { id: 102, courseId: 7, status: "approved" },
        { id: 103, courseId: 7, status: "approved" },
      ],
      errors: [],
    };
    handler.reviewsPendingAfter = [];

    const user = userEvent.setup();
    renderPage();

    await screen.findByText("Great course");

    // No bulk buttons until something is selected
    expect(screen.queryByTestId("button-approve-selected-reviews")).not.toBeInTheDocument();

    await user.click(screen.getByTestId("checkbox-select-all-reviews"));

    const approveBtn = await screen.findByTestId("button-approve-selected-reviews");
    expect(approveBtn).toHaveTextContent(/Approve selected \(3\)/);

    await user.click(approveBtn);

    await waitFor(() => expect(handler.bulkReviewRequests.length).toBe(1));
    expect(handler.bulkReviewRequests[0].reviewIds.sort()).toEqual([101, 102, 103]);
    expect(handler.bulkReviewRequests[0].status).toBe("approved");

    await waitFor(() => {
      expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({
        title: expect.stringMatching(/Approved 3 reviews/),
      }));
    });
    // No destructive toast when nothing failed
    expect(toastMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ variant: "destructive" }),
    );

    // Queue refetches and the approved rows disappear → bulk button gone
    await waitFor(() => expect(handler.reviewsFetchCount).toBeGreaterThanOrEqual(2));
    await waitFor(() => expect(screen.queryByText("Great course")).not.toBeInTheDocument());
    expect(screen.queryByTestId("button-approve-selected-reviews")).not.toBeInTheDocument();
  });

  it("Reject selected with per-row failures keeps failed rows selected and shows a destructive toast", async () => {
    handler.reviewsBulkResp = {
      updatedCount: 1, errorCount: 1, status: "rejected",
      updated: [{ id: 101, courseId: 7, status: "rejected" }],
      errors: [{ reviewId: 102, error: "Review is already rejected." }],
    };
    handler.reviewsPendingAfter = [makeReview(102, "Loved it"), makeReview(103, "OK")];

    const user = userEvent.setup();
    renderPage();
    await screen.findByText("Great course");

    await user.click(screen.getByTestId("checkbox-review-101"));
    await user.click(screen.getByTestId("checkbox-review-102"));

    const rejectBtn = await screen.findByTestId("button-reject-selected-reviews");
    expect(rejectBtn).toHaveTextContent(/Reject selected \(2\)/);
    await user.click(rejectBtn);

    await waitFor(() => expect(handler.bulkReviewRequests.length).toBe(1));
    expect(handler.bulkReviewRequests[0].reviewIds.sort()).toEqual([101, 102]);
    expect(handler.bulkReviewRequests[0].status).toBe("rejected");

    await waitFor(() => {
      const titles = toastMock.mock.calls.map((c) => c[0]?.title);
      expect(titles).toEqual(expect.arrayContaining([
        expect.stringMatching(/Rejected 1 review/),
        expect.stringMatching(/1 review not updated/),
      ]));
    });
    const destructive = toastMock.mock.calls.find((c) => c[0]?.variant === "destructive");
    expect(destructive).toBeTruthy();
    expect(destructive![0].description).toMatch(/already rejected/i);

    // Successful row is gone; failed row 102 still rendered + still selected.
    await waitFor(() => expect(screen.queryByText("Great course")).not.toBeInTheDocument());
    expect(screen.getByText("Loved it")).toBeInTheDocument();
    expect(screen.getByTestId("checkbox-review-102")).toBeChecked();

    // The bulk reject button is back, reflecting the remaining selection (1).
    const retryBtn = await screen.findByTestId("button-reject-selected-reviews");
    expect(retryBtn).toHaveTextContent(/Reject selected \(1\)/);
  });
});

describe("<CourseModerationPage /> — bulk photos", () => {
  it("Approve selected photos sends every selected id and clears them on success", async () => {
    handler.photosBulkResp = {
      updatedCount: 2, errorCount: 0, action: "approve",
      updated: [
        { id: 201, courseId: 7 },
        { id: 202, courseId: 7 },
      ],
      errors: [],
    };
    handler.photosPendingAfter = [makePhoto(203, "Clubhouse")];

    const user = userEvent.setup();
    renderPage();

    // Switch to the photos tab
    await user.click(await screen.findByTestId("tab-photos"));
    await screen.findByTestId("photo-row-201");

    await user.click(screen.getByTestId("checkbox-photo-201"));
    await user.click(screen.getByTestId("checkbox-photo-202"));

    const approveBtn = await screen.findByTestId("button-approve-selected-photos");
    expect(approveBtn).toHaveTextContent(/Approve selected \(2\)/);
    await user.click(approveBtn);

    await waitFor(() => expect(handler.bulkPhotoRequests.length).toBe(1));
    expect(handler.bulkPhotoRequests[0].photoIds.sort()).toEqual([201, 202]);
    expect(handler.bulkPhotoRequests[0].action).toBe("approve");

    await waitFor(() => {
      expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({
        title: expect.stringMatching(/Approved 2 photos/),
      }));
    });

    await waitFor(() => expect(screen.queryByTestId("photo-row-201")).not.toBeInTheDocument());
    expect(screen.queryByTestId("photo-row-202")).not.toBeInTheDocument();
    expect(screen.getByTestId("photo-row-203")).toBeInTheDocument();
    expect(screen.queryByTestId("button-approve-selected-photos")).not.toBeInTheDocument();
  });

  it("Reject selected photos prompts for confirmation and skips the call when cancelled", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByTestId("tab-photos"));
    await screen.findByTestId("photo-row-201");

    await user.click(screen.getByTestId("checkbox-select-all-photos"));
    const rejectBtn = await screen.findByTestId("button-reject-selected-photos");
    expect(rejectBtn).toHaveTextContent(/Reject selected \(3\)/);

    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    await user.click(rejectBtn);

    expect(confirmSpy).toHaveBeenCalledWith(expect.stringMatching(/Delete 3 photos/i));
    expect(handler.bulkPhotoRequests.length).toBe(0);
    confirmSpy.mockRestore();
  });

  it("Reject selected photos (confirmed) deletes successful ids and surfaces per-row failures", async () => {
    handler.photosBulkResp = {
      updatedCount: 1, errorCount: 1, action: "reject",
      updated: [{ id: 201, courseId: 7 }],
      errors: [{ photoId: 202, error: "Photo not found in this organization." }],
    };
    handler.photosPendingAfter = [makePhoto(202, "Sunset"), makePhoto(203, "Clubhouse")];

    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByTestId("tab-photos"));
    await screen.findByTestId("photo-row-201");

    await user.click(screen.getByTestId("checkbox-photo-201"));
    await user.click(screen.getByTestId("checkbox-photo-202"));

    const rejectBtn = await screen.findByTestId("button-reject-selected-photos");
    expect(rejectBtn).toHaveTextContent(/Reject selected \(2\)/);

    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    await user.click(rejectBtn);

    await waitFor(() => expect(handler.bulkPhotoRequests.length).toBe(1));
    expect(handler.bulkPhotoRequests[0].photoIds.sort()).toEqual([201, 202]);
    expect(handler.bulkPhotoRequests[0].action).toBe("reject");

    await waitFor(() => {
      const titles = toastMock.mock.calls.map((c) => c[0]?.title);
      expect(titles).toEqual(expect.arrayContaining([
        expect.stringMatching(/Deleted 1 photo/),
        expect.stringMatching(/1 photo not updated/),
      ]));
    });
    const destructive = toastMock.mock.calls.find((c) => c[0]?.variant === "destructive");
    expect(destructive).toBeTruthy();
    expect(destructive![0].description).toMatch(/not found/i);

    // 201 is gone; 202 still selected so staff can retry.
    await waitFor(() => expect(screen.queryByTestId("photo-row-201")).not.toBeInTheDocument());
    expect(screen.getByTestId("photo-row-202")).toBeInTheDocument();
    expect(within(screen.getByTestId("photo-row-202")).getByTestId("checkbox-photo-202")).toBeChecked();

    confirmSpy.mockRestore();
  });
});
