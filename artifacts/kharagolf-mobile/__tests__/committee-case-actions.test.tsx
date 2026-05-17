/**
 * Task #1206 — end-to-end coverage for the mobile handicap-committee case
 * actions added in Task #1042 (Assign / Invite peer / Record decision).
 *
 * The screen is a thin client over three live committee endpoints, each with
 * non-trivial validation rules:
 *
 *   POST /handicap/cases/:id/assign       { assigneeUserId }
 *   POST /handicap/cases/:id/peer-invite  { reviewerUserId }
 *   POST /handicap/cases/:id/decide       { decision, rationale, createAdjustment?, applyToPlayer? }
 *
 * These tests render the real `CommitteeCaseDetailScreen`, exercise each modal
 * end-to-end, and confirm that:
 *   1. The submit hits the correct endpoint with the expected body.
 *   2. After the POST resolves, the screen re-fetches the case and surfaces
 *      the new status / decision / audit entry.
 *   3. The form-side validators block bad inputs (missing rationale, invalid
 *      strokes for index_adjustment, invalid cap for soft_cap/hard_cap) and
 *      that applyToPlayer is silently dropped from the body when the chosen
 *      decision is `no_action` (the API rejects that combination, so the UI
 *      strips it before sending).
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

const { alertMock } = vi.hoisted(() => ({
  alertMock: vi.fn<(title: string, message?: string) => void>(),
}));
vi.mock("react-native", async () => {
  const RN = await vi.importActual<typeof import("react-native")>("react-native");
  return { ...RN, Alert: { alert: alertMock } };
});

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
// Pull validation copy from the same JSON the screen renders so the assertions
// can never silently drift away from the production strings (the screen is now
// fully i18n'd via `t("validation.*")` — Task #1397).
import enHandicapCommittee from "@/i18n/locales/en/handicapCommittee.json";

// ── Fixtures ──────────────────────────────────────────────────────────────

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

interface AuditFixture {
  id: number;
  action: string;
  details: string | null;
  createdAt: string;
  actorName: string | null;
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
  auditLog: AuditFixture[];
}

interface MemberFixture {
  userId: number;
  displayName: string | null;
  email: string | null;
  role: string;
}

const SUBJECT_USER_ID = 99;

function freshCase(): CaseFixture {
  return {
    id: 42,
    organizationId: 7,
    subjectUserId: SUBJECT_USER_ID,
    subjectName: "Sam Subject",
    subjectEmail: "sam@example.com",
    kind: "anomalous",
    status: "open",
    details: "Score swing exceeded threshold",
    periodLabel: "2026-Q1",
    createdAt: "2026-04-20T10:00:00Z",
    decision: null,
    decisionRationale: null,
    peerReviews: [],
    auditLog: [],
  };
}

const COMMITTEE_MEMBERS: MemberFixture[] = [
  { userId: 11, displayName: "Carol Committee", email: "carol@example.com", role: "committee_member" },
  { userId: 12, displayName: "Adam Admin", email: "adam@example.com", role: "org_admin" },
  // Pure player — should be filtered out by the screen's role gate.
  { userId: 13, displayName: "Pat Player", email: "pat@example.com", role: "player" },
  // Subject of the case — should be filtered out of the peer-invite picker.
  { userId: SUBJECT_USER_ID, displayName: "Sam Subject", email: "sam@example.com", role: "committee_member" },
];

let caseState: CaseFixture;
let assignBodies: unknown[];
let peerBodies: unknown[];
let decideBodies: unknown[];

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
  if (/\/handicap\/cases\/42\/assign$/.test(url) && method === "POST") {
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    assignBodies.push(body);
    // Mutate the in-memory case so the next GET reflects the assignment.
    caseState = {
      ...caseState,
      status: "assigned",
      auditLog: [
        {
          id: caseState.auditLog.length + 1,
          action: "assigned",
          details: `Assigned to user #${(body as { assigneeUserId: number }).assigneeUserId}`,
          createdAt: "2026-04-23T10:00:00Z",
          actorName: "Carol Committee",
        },
        ...caseState.auditLog,
      ],
    };
    return new Response(JSON.stringify({ ...caseState }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (/\/handicap\/cases\/42\/peer-invite$/.test(url) && method === "POST") {
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    peerBodies.push(body);
    const reviewerUserId = (body as { reviewerUserId: number }).reviewerUserId;
    const reviewer = COMMITTEE_MEMBERS.find(m => m.userId === reviewerUserId);
    caseState = {
      ...caseState,
      peerReviews: [
        ...caseState.peerReviews,
        {
          id: 700 + reviewerUserId,
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
      auditLog: [
        {
          id: caseState.auditLog.length + 1,
          action: "peer_invited",
          details: `Invited ${reviewer?.displayName ?? `user #${reviewerUserId}`}`,
          createdAt: "2026-04-23T11:00:00Z",
          actorName: "Carol Committee",
        },
        ...caseState.auditLog,
      ],
    };
    return new Response(
      JSON.stringify({ success: true, peerReviewId: 700 + reviewerUserId, responseUrl: "https://example/peer-review/tok" }),
      { status: 201, headers: { "Content-Type": "application/json" } },
    );
  }
  if (/\/handicap\/cases\/42\/decide$/.test(url) && method === "POST") {
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    decideBodies.push(body);
    const decision = (body as { decision: string }).decision;
    caseState = {
      ...caseState,
      status: "decided",
      decision,
      decisionRationale: (body as { rationale: string }).rationale,
      auditLog: [
        {
          id: caseState.auditLog.length + 1,
          action: "decided",
          details: `Decision: ${decision}`,
          createdAt: "2026-04-23T12:00:00Z",
          actorName: "Carol Committee",
        },
        ...caseState.auditLog,
      ],
    };
    return new Response(JSON.stringify({ ...caseState }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  // Anything else — empty array keeps optional list endpoints quiet.
  return new Response("[]", {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});

beforeEach(() => {
  caseState = freshCase();
  assignBodies = [];
  peerBodies = [];
  decideBodies = [];
  fetchMock.mockClear();
  alertMock.mockClear();
  routerMock.push.mockClear();
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function renderAndWaitForCase(): Promise<void> {
  render(<CommitteeCaseDetailScreen />);
  await screen.findByTestId("case-summary-42");
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("CommitteeCaseDetailScreen — Assign action", () => {
  it("opens the assign sheet, only lists committee-eligible members, picks one, posts to /assign and refreshes the case to 'assigned'", async () => {
    await renderAndWaitForCase();

    await act(async () => {
      fireEvent.click(screen.getByTestId("action-assign"));
    });

    // Eligible (committee_member, org_admin, super_admin) members are shown.
    await screen.findByTestId("assign-member-11");
    expect(screen.getByTestId("assign-member-12")).toBeInTheDocument();
    // The pure player and the case subject must NOT appear in the assign list
    // — the assign endpoint only accepts committee-eligible members.
    expect(screen.queryByTestId("assign-member-13")).toBeNull();
    // (subject 99 has the committee_member role here, so it's allowed for
    // assign — but is filtered out for peer-invite below.)

    // Submit is disabled until a member is picked.
    const submit = screen.getByTestId("assign-submit");
    expect(submit.getAttribute("aria-disabled")).toBe("true");

    await act(async () => {
      fireEvent.click(screen.getByTestId("assign-member-11"));
    });
    // react-native-web only emits aria-disabled when the prop is truthy, so an
    // enabled button has no attribute (or a non-"true" value).
    expect(submit.getAttribute("aria-disabled")).not.toBe("true");

    await act(async () => {
      fireEvent.click(submit);
    });

    await waitFor(() => expect(assignBodies).toHaveLength(1));
    expect(assignBodies[0]).toEqual({ assigneeUserId: 11 });

    // After submit the screen reloads the case — status pill should now read
    // ASSIGNED, and a new audit entry should appear.
    await waitFor(() => {
      expect(screen.getByText("ASSIGNED")).toBeInTheDocument();
    });
    expect(screen.getByText("assigned")).toBeInTheDocument();
    expect(screen.getByText(/Assigned to user #11/)).toBeInTheDocument();
  });
});

describe("CommitteeCaseDetailScreen — Peer-invite action", () => {
  it("opens the peer sheet, excludes the case subject, posts to /peer-invite and the new reviewer appears under 'Awaiting response'", async () => {
    await renderAndWaitForCase();

    await act(async () => {
      fireEvent.click(screen.getByTestId("action-peer-invite"));
    });

    await screen.findByTestId("peer-member-11");
    expect(screen.getByTestId("peer-member-12")).toBeInTheDocument();
    // The case subject (userId 99) must NEVER appear as a peer-invite candidate
    // — the API explicitly rejects "Reviewer cannot be the case subject".
    expect(screen.queryByTestId(`peer-member-${SUBJECT_USER_ID}`)).toBeNull();
    // And non-committee roles are filtered out client-side.
    expect(screen.queryByTestId("peer-member-13")).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByTestId("peer-member-12"));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("peer-submit"));
    });

    await waitFor(() => expect(peerBodies).toHaveLength(1));
    expect(peerBodies[0]).toEqual({ reviewerUserId: 12 });

    // After the case re-fetches, the new pending reviewer is rendered.
    await waitFor(() => {
      expect(screen.getByTestId("peer-pending-712")).toBeInTheDocument();
    });
    expect(screen.getAllByText("Adam Admin").length).toBeGreaterThan(0);
    // Audit entry surfaces too.
    expect(screen.getByText(/Invited Adam Admin/)).toBeInTheDocument();
  });
});

describe("CommitteeCaseDetailScreen — Decide action (happy paths)", () => {
  it("records a no_action decision with rationale and the case flips to DECIDED", async () => {
    await renderAndWaitForCase();

    await act(async () => { fireEvent.click(screen.getByTestId("action-decide")); });
    await screen.findByTestId("decision-no_action");

    await act(async () => { fireEvent.click(screen.getByTestId("decision-no_action")); });
    await act(async () => {
      fireEvent.change(screen.getByTestId("decision-rationale"), {
        target: { value: "No action warranted." },
      });
    });
    await act(async () => { fireEvent.click(screen.getByTestId("decision-submit")); });

    await waitFor(() => expect(decideBodies).toHaveLength(1));
    expect(decideBodies[0]).toEqual({
      decision: "no_action",
      rationale: "No action warranted.",
    });
    // Crucially: no createAdjustment, and no applyToPlayer key.
    expect((decideBodies[0] as Record<string, unknown>).createAdjustment).toBeUndefined();
    expect((decideBodies[0] as Record<string, unknown>).applyToPlayer).toBeUndefined();

    await waitFor(() => expect(screen.getByText("DECIDED")).toBeInTheDocument());
    expect(screen.getByText("no action")).toBeInTheDocument();
    expect(screen.getByText(/Decision: no_action/)).toBeInTheDocument();
  });

  it("records an index_adjustment decision with positive strokes and applyToPlayer=true", async () => {
    await renderAndWaitForCase();

    await act(async () => { fireEvent.click(screen.getByTestId("action-decide")); });
    await act(async () => { fireEvent.click(await screen.findByTestId("decision-index_adjustment")); });
    await act(async () => {
      fireEvent.change(screen.getByTestId("decision-rationale"), {
        target: { value: "Suspicious round — +1.0 to HI." },
      });
    });
    await act(async () => {
      fireEvent.change(screen.getByTestId("decision-strokes"), {
        target: { value: "1.5" },
      });
    });
    await act(async () => {
      fireEvent.change(screen.getByTestId("decision-notes"), {
        target: { value: "See video review." },
      });
    });
    // Toggle Apply-to-player. react-native-web renders Switch as a wrapper
    // containing an <input type="checkbox">; toggle the inner checkbox.
    const applySwitch = screen.getByTestId("decision-apply");
    const applyCheckbox = applySwitch.querySelector(
      "input[type='checkbox']",
    ) as HTMLInputElement | null;
    expect(applyCheckbox).not.toBeNull();
    await act(async () => { fireEvent.click(applyCheckbox!); });
    await act(async () => { fireEvent.click(screen.getByTestId("decision-submit")); });

    await waitFor(() => expect(decideBodies).toHaveLength(1));
    expect(decideBodies[0]).toEqual({
      decision: "index_adjustment",
      rationale: "Suspicious round — +1.0 to HI.",
      createAdjustment: { adjustmentStrokes: 1.5, notes: "See video review." },
      applyToPlayer: true,
    });
  });

  it("records a soft_cap decision with a valid cap value", async () => {
    await renderAndWaitForCase();

    await act(async () => { fireEvent.click(screen.getByTestId("action-decide")); });
    await act(async () => { fireEvent.click(await screen.findByTestId("decision-soft_cap")); });
    await act(async () => {
      fireEvent.change(screen.getByTestId("decision-rationale"), {
        target: { value: "Soft cap at 18.4." },
      });
    });
    await act(async () => {
      fireEvent.change(screen.getByTestId("decision-cap"), {
        target: { value: "18.4" },
      });
    });
    await act(async () => { fireEvent.click(screen.getByTestId("decision-submit")); });

    await waitFor(() => expect(decideBodies).toHaveLength(1));
    expect(decideBodies[0]).toMatchObject({
      decision: "soft_cap",
      rationale: "Soft cap at 18.4.",
      createAdjustment: { capValue: 18.4 },
    });
  });
});

describe("CommitteeCaseDetailScreen — Decide action (validation paths)", () => {
  it("disables the submit button when rationale is missing — no /decide call is made", async () => {
    await renderAndWaitForCase();

    await act(async () => { fireEvent.click(screen.getByTestId("action-decide")); });
    await act(async () => { fireEvent.click(await screen.findByTestId("decision-no_action")); });

    const submit = screen.getByTestId("decision-submit");
    // Decision is set but rationale is empty → submit is disabled.
    expect(submit.getAttribute("aria-disabled")).toBe("true");

    await act(async () => { fireEvent.click(submit); });
    // A blank-rationale tap should not have hit the API at all.
    expect(decideBodies).toHaveLength(0);

    // Once the user types a rationale the button becomes enabled.
    await act(async () => {
      fireEvent.change(screen.getByTestId("decision-rationale"), {
        target: { value: "Reviewed." },
      });
    });
    expect(submit.getAttribute("aria-disabled")).not.toBe("true");
  });

  it("rejects index_adjustment with non-positive strokes via Alert.alert and never POSTs", async () => {
    await renderAndWaitForCase();

    await act(async () => { fireEvent.click(screen.getByTestId("action-decide")); });
    await act(async () => { fireEvent.click(await screen.findByTestId("decision-index_adjustment")); });
    await act(async () => {
      fireEvent.change(screen.getByTestId("decision-rationale"), {
        target: { value: "Adjusting up." },
      });
    });
    // Strokes left empty → Number("") is NaN → !Number.isFinite → invalid.
    await act(async () => { fireEvent.click(screen.getByTestId("decision-submit")); });
    expect(alertMock).toHaveBeenCalledWith(
      enHandicapCommittee.validation.invalidStrokesTitle,
      enHandicapCommittee.validation.invalidStrokesMessage,
    );
    expect(decideBodies).toHaveLength(0);

    alertMock.mockClear();

    // Zero strokes is also invalid (must be > 0).
    await act(async () => {
      fireEvent.change(screen.getByTestId("decision-strokes"), {
        target: { value: "0" },
      });
    });
    await act(async () => { fireEvent.click(screen.getByTestId("decision-submit")); });
    expect(alertMock).toHaveBeenCalledWith(
      enHandicapCommittee.validation.invalidStrokesTitle,
      enHandicapCommittee.validation.invalidStrokesMessage,
    );
    expect(decideBodies).toHaveLength(0);
  });

  it("rejects soft_cap with a cap value above 54 via Alert.alert and never POSTs", async () => {
    await renderAndWaitForCase();

    await act(async () => { fireEvent.click(screen.getByTestId("action-decide")); });
    await act(async () => { fireEvent.click(await screen.findByTestId("decision-soft_cap")); });
    await act(async () => {
      fireEvent.change(screen.getByTestId("decision-rationale"), {
        target: { value: "Capping HI." },
      });
    });
    await act(async () => {
      fireEvent.change(screen.getByTestId("decision-cap"), {
        target: { value: "100" },
      });
    });
    await act(async () => { fireEvent.click(screen.getByTestId("decision-submit")); });
    expect(alertMock).toHaveBeenCalledWith(
      enHandicapCommittee.validation.invalidCapTitle,
      enHandicapCommittee.validation.invalidCapMessage,
    );
    expect(decideBodies).toHaveLength(0);

    alertMock.mockClear();

    // Negative is also invalid.
    await act(async () => {
      fireEvent.change(screen.getByTestId("decision-cap"), {
        target: { value: "-1" },
      });
    });
    await act(async () => { fireEvent.click(screen.getByTestId("decision-submit")); });
    expect(alertMock).toHaveBeenCalledWith(
      enHandicapCommittee.validation.invalidCapTitle,
      enHandicapCommittee.validation.invalidCapMessage,
    );
    expect(decideBodies).toHaveLength(0);
  });

  it("strips applyToPlayer from the request body when the chosen decision is no_action", async () => {
    // The API rejects applyToPlayer + no_action with a 400. The UI matches
    // that contract by silently dropping the flag — even if the user toggled
    // it on while a non-no_action decision was selected and then switched
    // back to no_action (the toggle is hidden on no_action but the React
    // state persists for the lifetime of the modal session).
    await renderAndWaitForCase();

    await act(async () => { fireEvent.click(screen.getByTestId("action-decide")); });

    // Pick index_adjustment first so the apply-to-player switch renders.
    await act(async () => { fireEvent.click(await screen.findByTestId("decision-index_adjustment")); });
    // Toggle the inner checkbox (Switch in react-native-web) and confirm it
    // is actually ON before switching decisions, so the test can't pass for
    // the wrong reason if the click never registered.
    const applySwitch = screen.getByTestId("decision-apply");
    const applyCheckbox = applySwitch.querySelector(
      "input[type='checkbox']",
    ) as HTMLInputElement | null;
    expect(applyCheckbox).not.toBeNull();
    expect(applyCheckbox!.checked).toBe(false);
    await act(async () => { fireEvent.click(applyCheckbox!); });
    expect(applyCheckbox!.checked).toBe(true);

    // Now switch to no_action — the apply switch disappears but state stays true.
    await act(async () => { fireEvent.click(screen.getByTestId("decision-no_action")); });
    expect(screen.queryByTestId("decision-apply")).toBeNull();

    await act(async () => {
      fireEvent.change(screen.getByTestId("decision-rationale"), {
        target: { value: "No action after all." },
      });
    });
    await act(async () => { fireEvent.click(screen.getByTestId("decision-submit")); });

    await waitFor(() => expect(decideBodies).toHaveLength(1));
    const body = decideBodies[0] as Record<string, unknown>;
    expect(body.decision).toBe("no_action");
    expect(body.rationale).toBe("No action after all.");
    // Critical: no applyToPlayer in the payload, even though the user toggled
    // it on while index_adjustment was selected.
    expect(body.applyToPlayer).toBeUndefined();
    // And no adjustment payload either — no_action never carries one.
    expect(body.createAdjustment).toBeUndefined();
  });
});
