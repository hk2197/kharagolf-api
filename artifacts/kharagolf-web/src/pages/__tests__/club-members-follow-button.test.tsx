/**
 * Task #1422 — UI coverage for the Follow button on club-members member rows.
 *
 * Mounts <ClubMembersPage /> with a mocked fetch + the wouter / api-client /
 * toast stack stubbed out, then asserts the contract called out in the task
 * brief:
 *
 *   1. Every linked member row (m.userId != null) renders a
 *      <FollowButton userId={m.userId} /> with the testid
 *      `button-follow-{userId}`.
 *   2. The current viewer's own row never renders the Follow button (the
 *      `m.userId !== currentUserId` guard at club-members.tsx:3887).
 *   3. Unlinked rows (no portal account) never render the Follow button.
 *   4. The pre-fetched followee list from /api/portal/follows hydrates the
 *      button into its "Following" state on initial mount instead of the
 *      empty "Follow" state.
 *   5. Clicking a "Follow" button POSTs to /api/portal/follows/{userId}
 *      and the button label flips to "Following".
 *
 * The HTTP contract for /api/portal/follows + /api/portal/follows/:id (auth,
 * self-follow rejection, idempotency) is separately covered against the live
 * PostgreSQL test DB by artifacts/api-server/src/tests/follows-status.test.ts
 * and artifacts/api-server/src/tests/follows-toggle.test.ts. This test
 * exercises the *web wiring* the task description specifically calls out.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, cleanup, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// jsdom polyfills for Radix primitives used inside the page (Select,
// Tooltip, etc) — copied from bulk-clone-save-segment.test.tsx so the
// initial render doesn't blow up before the rows mount.
if (typeof Element !== "undefined") {
  if (!(Element.prototype as unknown as { hasPointerCapture?: unknown }).hasPointerCapture) {
    (Element.prototype as unknown as { hasPointerCapture: () => boolean }).hasPointerCapture = () => false;
  }
  if (!(Element.prototype as unknown as { releasePointerCapture?: unknown }).releasePointerCapture) {
    (Element.prototype as unknown as { releasePointerCapture: () => void }).releasePointerCapture = () => {};
  }
  if (!(Element.prototype as unknown as { setPointerCapture?: unknown }).setPointerCapture) {
    (Element.prototype as unknown as { setPointerCapture: () => void }).setPointerCapture = () => {};
  }
  if (!(Element.prototype as unknown as { scrollIntoView?: unknown }).scrollIntoView) {
    (Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {};
  }
}

// Render <Link> as a plain anchor so we can mount the page without a router.
vi.mock("wouter", () => ({
  Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) =>
    <a href={href} {...rest}>{children}</a>,
}));

// The viewer is org_admin id=99 in org=42. Member id=99 below is the viewer's
// own portal-linked row, used to assert the self-row guard.
const CURRENT_USER_ID = 99;
const ORG_ID = 42;

vi.mock("@workspace/api-client-react", () => ({
  useGetMe: () => ({
    data: { id: CURRENT_USER_ID, organizationId: ORG_ID, role: "org_admin" },
  }),
}));

const toastMock = vi.fn();
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: toastMock }),
}));

import ClubMembersPage from "../club-members";

interface ClubMember {
  id: number;
  userId: number | null;
  memberNumber: string | null;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  handicapIndex: string | null;
  whsGhinNumber: string | null;
  joinDate: string;
  renewalDate: string | null;
  subscriptionStatus: string;
  showInDirectory: boolean;
  tierId: number | null;
  tierName: string | null;
  tierAnnualFee: string | null;
  inviteToken: string | null;
  inviteTokenExpiry: string | null;
  pendingMemberLink: boolean;
}

const baseMember = (overrides: Partial<ClubMember>): ClubMember => ({
  id: 0,
  userId: null,
  memberNumber: null,
  firstName: "First",
  lastName: "Last",
  email: null,
  phone: null,
  handicapIndex: null,
  whsGhinNumber: null,
  joinDate: new Date().toISOString(),
  renewalDate: null,
  subscriptionStatus: "active",
  showInDirectory: true,
  tierId: null,
  tierName: null,
  tierAnnualFee: null,
  inviteToken: null,
  inviteTokenExpiry: null,
  pendingMemberLink: false,
  ...overrides,
});

interface Handler {
  members: ClubMember[];
  /** userIds returned by GET /api/portal/follows. */
  followeeIds: number[];
  followeesFetchCount: number;
  followToggleRequests: Array<{ method: string; userId: number }>;
  followToggleResponseStatus: number;
}

let handler: Handler;

function installFetch() {
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();

    // Members directory feeding the row map at club-members.tsx:3768.
    if (url.endsWith("/club-members/members")) {
      return new Response(JSON.stringify(handler.members), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }) as unknown as Response;
    }

    // Pre-fetch hydrating the FollowButton on each linked row
    // (club-members.tsx:2655 -> useFolloweeIds()).
    if (url.endsWith("/api/portal/follows")) {
      handler.followeesFetchCount += 1;
      return new Response(JSON.stringify({ followeeIds: handler.followeeIds }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }) as unknown as Response;
    }

    // POST/DELETE /api/portal/follows/:id from <FollowButton onClick>.
    const followToggle = url.match(/\/api\/portal\/follows\/(\d+)$/);
    if (followToggle && (method === "POST" || method === "DELETE")) {
      handler.followToggleRequests.push({
        method,
        userId: parseInt(followToggle[1], 10),
      });
      return new Response(JSON.stringify({ ok: true }), {
        status: handler.followToggleResponseStatus,
        headers: { "Content-Type": "application/json" },
      }) as unknown as Response;
    }

    // Every other side-query (tiers, levies, saved-segments, bulk-audit,
    // practice activity) is irrelevant here — return a benign empty body
    // so the page can finish its initial render without bombing out.
    return new Response("[]", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }) as unknown as Response;
  }) as typeof fetch;
}

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={qc}>
      <ClubMembersPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  handler = {
    members: [],
    followeeIds: [],
    followeesFetchCount: 0,
    followToggleRequests: [],
    followToggleResponseStatus: 200,
  };
  toastMock.mockClear();
  installFetch();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Task #1422 — Follow button on club-members rows", () => {
  it("renders a Follow button on every linked member row except the viewer's own", async () => {
    handler.members = [
      // Linked member, NOT the viewer — should show Follow.
      baseMember({ id: 1, userId: 201, firstName: "Aanya", lastName: "Patel", memberNumber: "M-001" }),
      // The viewer's OWN portal-linked row — must NOT render Follow.
      baseMember({ id: 2, userId: CURRENT_USER_ID, firstName: "Self", lastName: "Viewer", memberNumber: "M-002" }),
      // Linked member, NOT the viewer — should show Follow.
      baseMember({ id: 3, userId: 203, firstName: "Bilal", lastName: "Khan", memberNumber: "M-003" }),
      // Unlinked member (no portal account) — must NOT render Follow.
      baseMember({ id: 4, userId: null, firstName: "Pending", lastName: "Member", memberNumber: "M-004" }),
    ];
    handler.followeeIds = [];

    renderPage();

    // Wait for the row map to render — we look for the testid the
    // FollowButton is going to add for the first non-self linked member.
    const btn201 = await screen.findByTestId("button-follow-201");
    const btn203 = await screen.findByTestId("button-follow-203");
    expect(btn201).toBeInTheDocument();
    expect(btn203).toBeInTheDocument();

    // Self-row guard: there must NOT be a Follow button for the viewer.
    expect(screen.queryByTestId(`button-follow-${CURRENT_USER_ID}`)).not.toBeInTheDocument();

    // Unlinked rows have no userId at all, so by definition no
    // button-follow-* testid exists for them. We assert via the
    // total count of follow buttons rendered: exactly 2 (one per
    // linked, non-self member).
    const allFollowButtons = screen.getAllByTestId(/^button-follow-\d+$/);
    expect(allFollowButtons).toHaveLength(2);
    const renderedIds = allFollowButtons
      .map(btn => btn.getAttribute("data-testid")!)
      .sort();
    expect(renderedIds).toEqual([
      "button-follow-201",
      "button-follow-203",
    ]);
  });

  it("hydrates the button to 'Following' when the user is in the pre-fetched followees list", async () => {
    handler.members = [
      baseMember({ id: 1, userId: 201, firstName: "Already", lastName: "Followed", memberNumber: "M-001" }),
      baseMember({ id: 2, userId: 202, firstName: "Not", lastName: "Followed", memberNumber: "M-002" }),
    ];
    // /api/portal/follows says we already follow user 201 but not 202.
    handler.followeeIds = [201];

    renderPage();

    const btn201 = await screen.findByTestId("button-follow-201");
    const btn202 = await screen.findByTestId("button-follow-202");

    // 201 hydrates as "Following" thanks to useFolloweeIds; 202 stays "Follow".
    await waitFor(() => {
      expect(btn201).toHaveTextContent(/^Following$/);
    });
    expect(btn202).toHaveTextContent(/^Follow$/);

    // Sanity: the pre-fetch endpoint actually fired (this is the wiring the
    // task brief calls out — we're explicitly locking in that the page
    // doesn't ship a regression where the pre-fetch is removed and the
    // button always flashes "Follow" first).
    expect(handler.followeesFetchCount).toBeGreaterThanOrEqual(1);
  });

  it("POSTs to /api/portal/follows/:id and flips the button to 'Following' when clicked", async () => {
    handler.members = [
      baseMember({ id: 1, userId: 201, firstName: "Aanya", lastName: "Patel", memberNumber: "M-001" }),
    ];
    handler.followeeIds = [];

    renderPage();

    const btn = await screen.findByTestId("button-follow-201");
    expect(btn).toHaveTextContent(/^Follow$/);

    const user = userEvent.setup();
    await user.click(btn);

    // The toggle endpoint was hit with POST and the right userId.
    await waitFor(() => {
      expect(handler.followToggleRequests).toHaveLength(1);
    });
    expect(handler.followToggleRequests[0]).toEqual({ method: "POST", userId: 201 });

    // Optimistic-ish post-success state flip: button now reads "Following".
    await waitFor(() => {
      expect(btn).toHaveTextContent(/^Following$/);
    });

    // No failure toast surfaced.
    expect(toastMock).not.toHaveBeenCalled();
  });

  it("does not render the Follow button on a directory of only-unlinked members", async () => {
    // Edge case: a club that has imported a CSV roster but nobody has
    // claimed their portal account yet. Every row has userId === null,
    // so the FollowButton must not render at all.
    handler.members = [
      baseMember({ id: 10, userId: null, firstName: "U1", lastName: "L1", memberNumber: "M-010" }),
      baseMember({ id: 11, userId: null, firstName: "U2", lastName: "L2", memberNumber: "M-011" }),
    ];

    renderPage();

    // Wait for the directory to render — pick a stable string from the row.
    await screen.findByText(/M-010/);
    expect(screen.queryByTestId(/^button-follow-\d+$/)).not.toBeInTheDocument();
  });
});
