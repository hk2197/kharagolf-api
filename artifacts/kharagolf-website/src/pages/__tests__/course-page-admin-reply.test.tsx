/**
 * Task #790 — UI coverage for the public-facing admin reply on course-page.tsx.
 *
 * Pairs with the moderation-side flow in
 *   artifacts/kharagolf-web/src/pages/__tests__/course-moderation-reply.test.tsx
 *
 * Stubs `fetch` for GET /api/public/clubs/:slug/courses/:courseSlug and asserts:
 *   - When a recent approved review carries an `adminReply`, the page renders
 *     the dedicated reply block (data-testid="admin-reply-:id") containing
 *     the reply text and a "Reply from <club name>" attribution line.
 *   - When `adminReply` is null the block is not rendered (no false positives).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { Router as WouterRouter } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import CoursePage from "../course-page";

const CLUB_SLUG = "test-club";
const COURSE_SLUG = "trail-course";
const COURSE_URL = `/api/public/clubs/${CLUB_SLUG}/courses/${COURSE_SLUG}`;

interface RecentReview {
  id: number;
  rating: number;
  title: string | null;
  body: string | null;
  reviewerDisplayName: string | null;
  displayMode: string;
  createdAt: string;
  adminReply: string | null;
  adminReplyAt: string | null;
}

function buildPayload(recent: RecentReview[]) {
  return {
    club: {
      id: 1, name: "Test Club", slug: CLUB_SLUG,
      address: "123 Fairway", contactPhone: null, contactEmail: null,
    },
    course: {
      id: 10, slug: COURSE_SLUG, name: "Trail Course",
      description: "Description.", location: "Town",
      latitude: null, longitude: null,
      holes: 18, par: 72, rating: null, slope: null, yardage: null,
      designer: null, yearOpened: null, awards: [],
      contactPhone: null, contactEmail: null,
      heroImageUrl: "/objects/hero.jpg",
    },
    holes: [],
    photos: [],
    reviewSummary: {
      averageRating: recent.length ? 5 : null,
      totalReviews: recent.length,
      recent,
    },
    teeTimeUrl: "https://example.com/tee-times",
  };
}

function renderCoursePage() {
  const { hook } = memoryLocation({ path: `/clubs/${CLUB_SLUG}/courses/${COURSE_SLUG}` });
  return render(
    <WouterRouter hook={hook}>
      <CoursePage />
    </WouterRouter>,
  );
}

function installFetch(payload: ReturnType<typeof buildPayload>) {
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.startsWith(COURSE_URL) && !url.includes("/photos") && !url.includes("/reviews")) {
      return new Response(JSON.stringify(payload), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("CoursePage — admin reply", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("renders the public admin reply block when a review carries adminReply", async () => {
    const replyText = "Thanks for visiting — the back nine misses you already.";
    installFetch(buildPayload([{
      id: 7777,
      rating: 5,
      title: "Loved it",
      body: "Greens were perfect.",
      reviewerDisplayName: "Riley Reviewer",
      displayMode: "public",
      createdAt: new Date("2026-04-01T12:00:00Z").toISOString(),
      adminReply: replyText,
      adminReplyAt: new Date("2026-04-02T09:00:00Z").toISOString(),
    }]));

    renderCoursePage();

    const reply = await screen.findByTestId("admin-reply-7777");
    expect(reply).toHaveTextContent(replyText);
    expect(reply).toHaveTextContent(/Reply from Test Club/);
  });

  it("does not render an admin-reply block when adminReply is null", async () => {
    installFetch(buildPayload([{
      id: 8888,
      rating: 4,
      title: "Solid",
      body: "Good day out.",
      reviewerDisplayName: "Cory Critic",
      displayMode: "public",
      createdAt: new Date("2026-04-01T12:00:00Z").toISOString(),
      adminReply: null,
      adminReplyAt: null,
    }]));

    renderCoursePage();

    // Wait for the review body to render so we know the page settled.
    await waitFor(() => {
      expect(screen.getByText("Good day out.")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("admin-reply-8888")).not.toBeInTheDocument();
  });
});
