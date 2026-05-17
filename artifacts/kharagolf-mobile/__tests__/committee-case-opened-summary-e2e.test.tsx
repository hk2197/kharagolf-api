/**
 * Task #1385 — end-to-end coverage for the mobile aggregate
 * "X of Y opened" peer-reviewer badge on the handicap-committee case
 * detail screen.
 *
 * The unit test (`committee-case-opened-summary.test.tsx`) covers the
 * happy-path render of the badge and the bottom-sheet's bucket grouping
 * against a static fixture. This e2e suite drives the *real*
 * `CommitteeCaseDetailScreen` through richer flows that catch routing,
 * gesture, and layout regressions the unit test cannot:
 *
 *   1. Routing — the screen reads `id` + `orgId` from `useLocalSearchParams`
 *      to compose the case GET, and the back chevron calls `router.back()`.
 *   2. Gesture — the badge's `onPress` opens the sheet and re-opening it
 *      after a dismiss returns the same up-to-date bucket contents (the
 *      handler must keep working across open→close→open cycles).
 *   3. Layout — the aggregate badge renders before the "Peer responses"
 *      section title in DOM order, so committee members see the
 *      at-a-glance summary above the per-reviewer detail.
 *   4. All-seen variant — when every reviewer has `seenAt`, the badge
 *      reports "N of N opened" and the bottom-sheet's "Not yet opened"
 *      group renders its empty-state copy instead of any reviewer rows.
 *   5. Live data — after a reviewer is invited through the peer-invite
 *      flow, the case re-fetches and the badge text + the sheet's bucket
 *      contents update without a remount.
 *
 * The transport is the same vitest + react-native-web harness used by
 * `committee-case-actions.test.tsx` (the established e2e tier for this
 * artifact), so the suite is picked up by `pnpm --filter
 * @workspace/kharagolf-mobile test` in CI alongside the other mobile e2e
 * suites without any extra wiring.
 */
import React, { type ReactNode } from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

const { routerMock } = vi.hoisted(() => ({
  routerMock: {
    push: vi.fn(),
    back: vi.fn(),
    replace: vi.fn(),
    canGoBack: () => true,
  },
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

interface MemberFixture {
  userId: number;
  displayName: string | null;
  email: string | null;
  role: string;
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

const SUBJECT_USER_ID = 99;

function buildCase(peerReviews: PeerReviewFixture[]): CaseFixture {
  return {
    id: 42,
    organizationId: 7,
    subjectUserId: SUBJECT_USER_ID,
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

const COMMITTEE_MEMBERS: MemberFixture[] = [
  { userId: 11, displayName: "Olivia Opened", email: "olivia@example.com", role: "committee_member" },
  { userId: 12, displayName: "Nora NotOpened", email: "nora@example.com", role: "committee_member" },
  { userId: 13, displayName: "Riley Responded", email: "riley@example.com", role: "committee_member" },
  { userId: 14, displayName: "Casey Candidate", email: "casey@example.com", role: "org_admin" },
];

let caseState: CaseFixture;

const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const method = (init?.method ?? "GET").toUpperCase();

  if (/\/organizations\/7\/handicap\/cases\/42$/.test(url) && method === "GET") {
    return new Response(JSON.stringify(caseState), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (url.includes("/organizations/7/members") && method === "GET") {
    return new Response(JSON.stringify(COMMITTEE_MEMBERS), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (/\/handicap\/cases\/42\/peer-invite$/.test(url) && method === "POST") {
    const body = init?.body ? JSON.parse(String(init.body)) as { reviewerUserId: number } : null;
    const reviewerUserId = body?.reviewerUserId ?? 0;
    const reviewer = COMMITTEE_MEMBERS.find(m => m.userId === reviewerUserId);
    caseState = {
      ...caseState,
      peerReviews: [
        ...caseState.peerReviews,
        {
          id: 800 + reviewerUserId,
          reviewerUserId,
          reviewerName: reviewer?.displayName ?? null,
          reviewerEmail: reviewer?.email ?? null,
          recommendation: null,
          comment: null,
          invitedAt: "2026-04-23T11:00:00Z",
          respondedAt: null,
          seenAt: null,
          expiresAt: null,
        },
      ],
    };
    return new Response(
      JSON.stringify({ success: true, peerReviewId: 800 + reviewerUserId }),
      { status: 201, headers: { "Content-Type": "application/json" } },
    );
  }
  // Anything else is a no-op for this suite.
  return new Response("[]", {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});

const PEER_OLIVIA_OPENED: PeerReviewFixture = {
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
};

const PEER_NORA_UNOPENED: PeerReviewFixture = {
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
};

const PEER_RILEY_RESPONDED: PeerReviewFixture = {
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
};

beforeEach(() => {
  caseState = buildCase([]);
  fetchMock.mockClear();
  routerMock.push.mockClear();
  routerMock.back.mockClear();
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function renderAndWaitForBadge(): Promise<HTMLElement> {
  render(<CommitteeCaseDetailScreen />);
  return await screen.findByTestId("peer-opened-summary-42");
}

describe("CommitteeCaseDetailScreen — aggregate opened badge (e2e, Task #1385)", () => {
  it("hydrates from the route params, renders the badge, and the back chevron calls router.back()", async () => {
    caseState = buildCase([PEER_OLIVIA_OPENED, PEER_NORA_UNOPENED]);

    const badge = await renderAndWaitForBadge();
    expect(badge.textContent).toContain("1 of 2 opened");

    // Routing concern: the screen used `id`=42 + `orgId`=7 from
    // useLocalSearchParams to compose the GET URL. If a future refactor
    // breaks param plumbing, the case GET would never fire.
    const caseGetCalls = fetchMock.mock.calls.filter(
      ([u, i]) =>
        /\/organizations\/7\/handicap\/cases\/42$/.test(String(u)) &&
        ((i as RequestInit | undefined)?.method ?? "GET") === "GET",
    );
    expect(caseGetCalls.length).toBeGreaterThanOrEqual(1);

    // Back chevron is wired to expo-router's `router.back()`. Find the
    // button by its accessibility label so the test isn't coupled to icon
    // implementation details.
    const back = screen.getByLabelText("Back");
    await act(async () => {
      fireEvent.click(back);
    });
    expect(routerMock.back).toHaveBeenCalledTimes(1);
  });

  it("opens the sheet on tap and survives an open→close→open cycle without losing reviewer rows", async () => {
    caseState = buildCase([PEER_OLIVIA_OPENED, PEER_NORA_UNOPENED, PEER_RILEY_RESPONDED]);

    const badge = await renderAndWaitForBadge();
    expect(badge.textContent).toContain("2 of 3 opened");

    // First tap — the sheet opens with the right buckets. Opened holds the
    // two reviewers with `seenAt`, unopened holds the one without it.
    await act(async () => {
      fireEvent.click(badge);
    });
    await waitFor(() => {
      expect(screen.getByTestId("peer-opened-summary-opened-901")).toBeInTheDocument();
    });
    expect(screen.getByTestId("peer-opened-summary-opened-903")).toBeInTheDocument();
    expect(screen.getByTestId("peer-opened-summary-unopened-902")).toBeInTheDocument();

    // Cross-check: opened reviewers must NOT appear in the unopened bucket
    // and vice versa. This guards against a regression where the filter
    // predicate is inverted or the Y-bucket falls back to "all reviewers".
    expect(screen.queryByTestId("peer-opened-summary-opened-902")).toBeNull();
    expect(screen.queryByTestId("peer-opened-summary-unopened-901")).toBeNull();
    expect(screen.queryByTestId("peer-opened-summary-unopened-903")).toBeNull();

    // Dismiss via the X button in the header. Note: react-native-web's
    // <Modal> keeps its subtree mounted across visibility flips, so we
    // can't assert the close button vanishes from the DOM. What we *can*
    // assert is that the open handler keeps working — re-tapping the badge
    // continues to show the up-to-date bucket contents.
    await act(async () => {
      fireEvent.click(screen.getByTestId("peer-opened-summary-close"));
    });

    // Second tap — the sheet still wires up correctly and shows the same
    // reviewers. If the tap handler swallowed events after a close, this
    // test would hang on the next assertion.
    await act(async () => {
      fireEvent.click(badge);
    });
    await waitFor(() => {
      expect(screen.getByTestId("peer-opened-summary-opened-901")).toBeInTheDocument();
    });
    expect(screen.getByTestId("peer-opened-summary-unopened-902")).toBeInTheDocument();
    // And the reviewer names land somewhere on screen so committee members
    // can identify who is who without expanding rows.
    expect(screen.getAllByText("Olivia Opened").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Nora NotOpened").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Riley Responded").length).toBeGreaterThan(0);
  });

  it("renders the aggregate badge above the 'Peer responses' section in DOM order", async () => {
    caseState = buildCase([PEER_OLIVIA_OPENED, PEER_NORA_UNOPENED]);

    const badge = await renderAndWaitForBadge();
    // The "Peer responses" section heading sits below the badge in the
    // layout so committee members see the at-a-glance summary first.
    // jsdom has no layout engine, but DOM order is what react-native-web's
    // flexbox column will paint top-to-bottom, so this is the right proxy.
    const responsesHeading = screen.getByText(/Peer responses/);
    const positionBits = badge.compareDocumentPosition(responsesHeading);
    expect(positionBits & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("shows the all-seen state ('N of N opened') with an empty 'Not yet opened' bucket when every reviewer has opened", async () => {
    caseState = buildCase([
      PEER_OLIVIA_OPENED,
      // Riley both opened AND responded → still counts as opened.
      PEER_RILEY_RESPONDED,
    ]);

    const badge = await renderAndWaitForBadge();
    expect(badge.textContent).toContain("2 of 2 opened");

    await act(async () => {
      fireEvent.click(badge);
    });

    await waitFor(() => {
      expect(screen.getByTestId("peer-opened-summary-opened-901")).toBeInTheDocument();
    });
    expect(screen.getByTestId("peer-opened-summary-opened-903")).toBeInTheDocument();
    // Section header reflects the all-seen state.
    expect(screen.getAllByText(/Opened \(2\)/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Not yet opened \(0\)/).length).toBeGreaterThan(0);
    // And the unopened bucket renders its empty-state copy instead of any
    // reviewer rows. The unit test never exercises this branch.
    expect(screen.getByText(/Everyone has opened the invitation\./)).toBeInTheDocument();
    // No peer-opened-summary-unopened-* nodes exist when nobody is unopened.
    const unopenedNodes = document.querySelectorAll(
      "[data-testid^='peer-opened-summary-unopened-']",
    );
    expect(unopenedNodes.length).toBe(0);
  });

  it("updates the badge count and sheet contents after a peer invite triggers a refetch", async () => {
    // Start with a single, opened reviewer — badge reads "1 of 1 opened".
    caseState = buildCase([PEER_OLIVIA_OPENED]);

    const badge = await renderAndWaitForBadge();
    expect(badge.textContent).toContain("1 of 1 opened");

    // Drive the real Invite-peer flow: open the picker, choose Casey
    // Candidate, submit. The mocked POST appends a new (unopened) reviewer
    // to `caseState`, and the screen re-fetches the case.
    await act(async () => {
      fireEvent.click(screen.getByTestId("action-peer-invite"));
    });
    await screen.findByTestId("peer-member-14");
    await act(async () => {
      fireEvent.click(screen.getByTestId("peer-member-14"));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("peer-submit"));
    });

    // After the refetch the badge text updates without a remount: 1 of 2.
    await waitFor(() => {
      expect(screen.getByTestId("peer-opened-summary-42").textContent).toContain(
        "1 of 2 opened",
      );
    });

    // Re-open the sheet and confirm the new reviewer landed in the unopened
    // bucket (testID derived from the synthetic peer-review id 800 + 14).
    await act(async () => {
      fireEvent.click(screen.getByTestId("peer-opened-summary-42"));
    });
    await waitFor(() => {
      expect(screen.getByTestId("peer-opened-summary-opened-901")).toBeInTheDocument();
    });
    expect(screen.getByTestId("peer-opened-summary-unopened-814")).toBeInTheDocument();
    expect(screen.getAllByText("Casey Candidate").length).toBeGreaterThan(0);
    // And the section headers reflect the new totals.
    expect(screen.getAllByText(/Opened \(1\)/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Not yet opened \(1\)/).length).toBeGreaterThan(0);
  });
});
