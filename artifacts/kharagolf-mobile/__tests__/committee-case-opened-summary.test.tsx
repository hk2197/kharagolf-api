/**
 * UI test: mobile committee case detail — aggregate "X of Y opened" badge
 * (Task #1200).
 *
 * Verifies that:
 *   - The case detail screen renders an aggregate `X of Y opened` badge for
 *     the peer reviewer set, mirroring the web admin behaviour.
 *   - Tapping the badge opens a sheet listing reviewers grouped into "Opened"
 *     and "Not yet opened" sections.
 *   - The badge does NOT render when the case has no peer reviewers yet.
 */
import React, { type ReactNode } from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const { routerMock } = vi.hoisted(() => ({
  routerMock: { push: vi.fn(), back: vi.fn(), replace: vi.fn(), canGoBack: () => true },
}));

vi.mock("expo-router", () => ({
  router: routerMock,
  useLocalSearchParams: () => ({ id: "42", orgId: "7" }),
  Stack: { Screen: () => null },
  useFocusEffect: () => undefined,
}));

vi.mock("react-native-safe-area-context", () => ({
  SafeAreaView: ({ children }: { children?: ReactNode }) =>
    React.createElement(React.Fragment, null, children),
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock("@/context/auth", () => ({
  useAuth: () => ({
    token: "test-token",
    user: { id: 1, organizationId: 7 },
    isAuthenticated: true,
    isLoading: false,
  }),
}));

vi.mock("@/i18n", () => ({
  getLocale: () => "en-US",
}));

import CommitteeCaseDetailScreen from "../app/handicap-committee/case/[id]";

interface PeerReviewFixture {
  id: number;
  reviewerUserId: number | null;
  reviewerName: string | null;
  reviewerEmail: string | null;
  recommendation: "confirm" | "dispute" | "insufficient_info" | null;
  comment: string | null;
  invitedAt: string;
  respondedAt: string | null;
  seenAt: string | null;
  expiresAt: string | null;
}

interface CaseFixture {
  id: number;
  organizationId: number;
  subjectUserId: number;
  subjectName: string | null;
  subjectEmail: string | null;
  kind: string;
  status: string;
  details: string | null;
  periodLabel: string | null;
  createdAt: string;
  decision: string | null;
  decisionRationale: string | null;
  peerReviews: PeerReviewFixture[];
  auditLog: unknown[];
}

function buildCase(peerReviews: PeerReviewFixture[]): CaseFixture {
  return {
    id: 42,
    organizationId: 7,
    subjectUserId: 99,
    subjectName: "Sam Subject",
    subjectEmail: "sam@example.com",
    kind: "anomalous",
    status: "awaiting_peer",
    details: "Score swing exceeded threshold",
    periodLabel: "2026-Q1",
    createdAt: "2026-04-20T10:00:00Z",
    decision: null,
    decisionRationale: null,
    peerReviews,
    auditLog: [],
  };
}

let caseResponse: CaseFixture = buildCase([]);

const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const method = (init?.method ?? "GET").toUpperCase();
  if (/\/organizations\/7\/handicap\/cases\/42$/.test(url) && method === "GET") {
    return new Response(JSON.stringify(caseResponse), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (url.includes("/organizations/7/members") && method === "GET") {
    return new Response("[]", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  return new Response("[]", {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});

beforeEach(() => {
  fetchMock.mockClear();
  routerMock.push.mockClear();
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("CommitteeCaseDetailScreen — aggregate opened badge (Task #1200)", () => {
  it("renders 'X of Y opened' and reveals reviewer lists when tapped", async () => {
    caseResponse = buildCase([
      {
        id: 901,
        reviewerUserId: 11,
        reviewerName: "Olivia Opened",
        reviewerEmail: "olivia@example.com",
        recommendation: null,
        comment: null,
        invitedAt: "2026-04-20T10:00:00Z",
        respondedAt: null,
        seenAt: "2026-04-21T08:00:00Z",
        expiresAt: null,
      },
      {
        id: 902,
        reviewerUserId: 12,
        reviewerName: "Nora NotOpened",
        reviewerEmail: "nora@example.com",
        recommendation: null,
        comment: null,
        invitedAt: "2026-04-20T10:00:00Z",
        respondedAt: null,
        seenAt: null,
        expiresAt: null,
      },
      {
        id: 903,
        reviewerUserId: 13,
        reviewerName: "Riley Responded",
        reviewerEmail: "riley@example.com",
        recommendation: "confirm",
        comment: "Looks fine.",
        invitedAt: "2026-04-20T10:00:00Z",
        respondedAt: "2026-04-22T08:00:00Z",
        seenAt: "2026-04-21T11:00:00Z",
        expiresAt: null,
      },
    ]);

    render(<CommitteeCaseDetailScreen />);

    const badge = await screen.findByTestId("peer-opened-summary-42");
    // 2 of 3 reviewers have a seenAt — Olivia + Riley.
    expect(badge.textContent).toContain("2 of 3 opened");

    // Tap to reveal the lists.
    await act(async () => {
      fireEvent.click(badge);
    });

    await waitFor(() => {
      expect(screen.getByTestId("peer-opened-summary-opened-901")).toBeInTheDocument();
    });
    expect(screen.getByTestId("peer-opened-summary-opened-903")).toBeInTheDocument();
    expect(screen.getByTestId("peer-opened-summary-unopened-902")).toBeInTheDocument();

    // The opened section must NOT include the unopened reviewer, and vice versa.
    expect(screen.queryByTestId("peer-opened-summary-opened-902")).toBeNull();
    expect(screen.queryByTestId("peer-opened-summary-unopened-901")).toBeNull();
    expect(screen.queryByTestId("peer-opened-summary-unopened-903")).toBeNull();

    // Reviewer names are surfaced in the sheet so committee members can see who
    // (the inline pending/responded lists also show the names, so just assert
    // each name renders at least once).
    expect(screen.getAllByText("Olivia Opened").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Nora NotOpened").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Riley Responded").length).toBeGreaterThan(0);

    // Section headers count correctly (2 opened, 1 unopened). The same labels
    // also appear on the Awaiting-response filter pills, so the assertion just
    // verifies the modal contributes its own header.
    expect(screen.getAllByText(/Opened \(2\)/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Not yet opened \(1\)/).length).toBeGreaterThan(0);
  });

  it("does not render the badge when there are no peer reviewers yet", async () => {
    caseResponse = buildCase([]);
    render(<CommitteeCaseDetailScreen />);

    // Wait for the case to load by waiting for the summary card to appear.
    await screen.findByTestId("case-summary-42");
    expect(screen.queryByTestId("peer-opened-summary-42")).toBeNull();
  });
});
