/**
 * Task #2102 — end-to-end RTL coverage for the handicap-committee case
 * detail screen in Arabic.
 *
 * The Arabic JSON exists and committee-case-actions / -opened-summary tests
 * already prove the screen behaves correctly in English. What no existing
 * test covers is whether the rendered output actually *looks right* when
 * the strings are right-to-left and the runtime interleaves them with
 * left-to-right tokens that come from data — case numbers (`#{{id}}`),
 * counts (`({{count}})`), HI ranges (`0–54`), interpolated dates, and the
 * BiDi-sensitive `·` mid-dot separator inside `pendingPeer.invitedWithSeen`.
 *
 * Common regressions in this space:
 *   - Mirrored badges or status pills (e.g. "(2)" rendering as ")2(").
 *   - Reversed parentheses around `({{count}})`.
 *   - Numeric tokens drifting to the wrong end of an RTL sentence so the
 *     sentence reads "X من Y" but the count interpolation lands as
 *     "Y من X" because the template was authored in LTR.
 *   - The peer-status sheet losing its "opened before unopened" ordering
 *     when flexbox direction flips under RTL.
 *
 * This suite mounts the real `CommitteeCaseDetailScreen`, switches the
 * shared i18n instance to Arabic, renders a richly-populated fixture
 * (responded reviewer + opened-pending + unopened-pending + audit log),
 * and asserts:
 *
 *   1. Every section the task lists — header, summary, peer responses,
 *      pending peer, activity — renders the expected Arabic copy.
 *   2. Numeric and date interpolations land inside the right Arabic
 *      sentence (e.g. "الحالة #42", "ردود الزملاء (1)", "فُتحت في …",
 *      "في انتظار الرد (2)").
 *   3. The peer-status badge text reads "2 من 3 فتحوا" — i.e. the
 *      placeholders are not transposed under RTL.
 *   4. Tapping the badge opens the bottom-sheet and the opened/unopened
 *      buckets render with their counts in parentheses ("مفتوح (2)",
 *      "لم يُفتح بعد (1)") and in the correct DOM (= flex column paint)
 *      order — opened section appears above the unopened section.
 *   5. The `pendingPeer.invitedWithSeen` mid-dot separator (`·`) appears
 *      verbatim between the "invited" and "seen" tokens — a known BiDi
 *      hazard for screen readers if it gets reversed or absorbed.
 *
 * Transport mirrors `committee-case-opened-summary-e2e.test.tsx` (vitest +
 * `react-native-web` via the shared vitest.config.ts alias) so the suite is
 * picked up by `pnpm --filter @workspace/kharagolf-mobile test` in CI
 * alongside the other mobile e2e suites with no extra wiring.
 */
import React, { type ReactNode } from "react";
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import i18n from "i18next";

import arHandicapCommittee from "@/i18n/locales/ar/handicapCommittee.json";

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

// `getLocale()` is consulted by the screen to format `toLocaleString` dates.
// Pin it to Arabic-UAE so the date strings match what production users see
// when their locale resolves to ar.
vi.mock("@/i18n", () => ({
  getLocale: () => "ar-AE",
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

// 2 reviewers have opened (seenAt set) — one responded, one still pending.
// 1 reviewer has not opened yet. Drives all the "X of Y opened" maths and
// surfaces the `pendingPeer.invitedWithSeen` mid-dot string for the opened
// pending row.
const PEER_RILEY_RESPONDED: PeerReviewFixture = {
  id: 901,
  reviewerUserId: 11,
  reviewerName: "Riley Responded",
  reviewerEmail: "riley@example.com",
  recommendation: "confirm",
  comment: null,
  invitedAt: "2026-04-20T10:00:00Z",
  respondedAt: "2026-04-22T08:00:00Z",
  seenAt: "2026-04-21T11:00:00Z",
  expiresAt: null,
};

const PEER_OLIVIA_OPENED_PENDING: PeerReviewFixture = {
  id: 902,
  reviewerUserId: 12,
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
  id: 903,
  reviewerUserId: 13,
  reviewerName: "Nora NotOpened",
  reviewerEmail: "nora@example.com",
  recommendation: null,
  comment: null,
  invitedAt: "2026-04-20T10:00:00Z",
  respondedAt: null,
  seenAt: null,
  expiresAt: null,
};

const CASE_FIXTURE: CaseFixture = {
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
  peerReviews: [
    PEER_RILEY_RESPONDED,
    PEER_OLIVIA_OPENED_PENDING,
    PEER_NORA_UNOPENED,
  ],
  auditLog: [
    {
      id: 1,
      action: "case_opened",
      details: "Case opened by automation.",
      createdAt: "2026-04-20T10:00:00Z",
      actorName: "Carol Committee",
    },
  ],
};

const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const method = (init?.method ?? "GET").toUpperCase();
  if (/\/organizations\/7\/handicap\/cases\/42$/.test(url) && method === "GET") {
    return new Response(JSON.stringify(CASE_FIXTURE), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  // Members endpoint and anything else — keep quiet so the screen's optional
  // fetches don't blow up the suite.
  return new Response("[]", {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});

// Add Arabic resources to the shared (English-only) i18n instance the
// setup.ts bootstrap built. `addResourceBundle` is idempotent under
// `deep + overwrite = true`, so re-running the suite locally is safe.
beforeAll(async () => {
  i18n.addResourceBundle(
    "ar",
    "handicapCommittee",
    arHandicapCommittee,
    /* deep */ true,
    /* overwrite */ true,
  );
  await i18n.changeLanguage("ar");
});

afterAll(async () => {
  // Restore English so any sibling test file that runs in the same worker
  // (vitest may share workers across files) doesn't inherit Arabic state.
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  fetchMock.mockClear();
  routerMock.back.mockClear();
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

describe("CommitteeCaseDetailScreen — Arabic (RTL) rendering (Task #2102)", () => {
  it("renders the header with the Arabic title and the LTR case-number token in the right place", async () => {
    await renderAndWaitForCase();

    // header.caseNumber → "الحالة #{{id}}". The literal "#" + digits stays
    // in LTR run within the RTL sentence. We assert the *whole* phrase to
    // catch a regression where the interpolation lands on the wrong side.
    expect(screen.getByText("الحالة #42")).toBeInTheDocument();
    // header.subtitle — pure Arabic copy.
    expect(screen.getByText("مراجعة لجنة الإعاقة")).toBeInTheDocument();
    // header.back — accessibility label for the chevron.
    expect(screen.getByLabelText("رجوع")).toBeInTheDocument();
  });

  it("renders all summary labels and surfaces the openedAt sentence in Arabic with the date token interpolated", async () => {
    await renderAndWaitForCase();

    // summary.subject / period / details — section labels.
    expect(screen.getByText("الموضوع")).toBeInTheDocument();
    expect(screen.getByText("الفترة")).toBeInTheDocument();
    expect(screen.getByText("التفاصيل")).toBeInTheDocument();
    // The subject + period values are LTR data tokens that must still
    // render unmodified inside the RTL summary card.
    expect(screen.getByText("Sam Subject")).toBeInTheDocument();
    expect(screen.getByText("2026-Q1")).toBeInTheDocument();
    expect(screen.getByText("Score swing exceeded threshold")).toBeInTheDocument();

    // summary.openedAt → "فُتحت في {{date}}". Asserting on a substring
    // because `toLocaleString("ar-AE")` formatting can vary across Node /
    // ICU versions, but the prefix is fixed by the JSON.
    const openedRow = screen.getByText((_, node) => {
      const text = node?.textContent ?? "";
      return text.startsWith("فُتحت في ") && text.length > "فُتحت في ".length;
    });
    expect(openedRow).toBeInTheDocument();
  });

  it("renders the peer-responses section with its parenthesized count un-mirrored", async () => {
    await renderAndWaitForCase();

    // peerResponses.headingWithCount → "ردود الزملاء ({{count}})". The
    // parentheses must wrap the digit "1" (not be reversed to ")1(").
    expect(screen.getByText("ردود الزملاء (1)")).toBeInTheDocument();
    // The reviewer's recommendation chip uses the Arabic label.
    expect(screen.getByText("مؤكد")).toBeInTheDocument();
    // The "Seen <relative>" line for the responded reviewer is rendered
    // somewhere on screen — its prefix is the Arabic "شوهد ". Don't
    // assert the exact relative-time string (locale + Date.now driven),
    // and use `getAllByText` because the same prefix is reused by the
    // peer-status pill, the per-card seen pill, and the sheet's
    // "Seen {{relative}}" meta line — all valid surfaces, only one of
    // which we care about for this assertion.
    const seenRows = screen.getAllByText((_, node) =>
      (node?.textContent ?? "").startsWith("شوهد "),
    );
    expect(seenRows.length).toBeGreaterThan(0);
    // peerResponses.respondedAt → "ردّ في {{date}}".
    const respondedRows = screen.getAllByText((_, node) =>
      (node?.textContent ?? "").startsWith("ردّ في "),
    );
    expect(respondedRows.length).toBeGreaterThan(0);
  });

  it("renders the pending-peer section, its filter chips, and the BiDi-sensitive mid-dot separator inside invitedWithSeen", async () => {
    await renderAndWaitForCase();

    // pendingPeer.heading → "في انتظار الرد ({{count}})" with count = 2
    // (Olivia opened-pending + Nora unopened).
    expect(screen.getByText("في انتظار الرد (2)")).toBeInTheDocument();
    // Filter chips: each carries its own count interpolation. Verifying
    // exact text catches both reversed parens AND transposed counts.
    expect(screen.getByText("الكل (2)")).toBeInTheDocument();
    expect(screen.getByText("مفتوح، بلا رد (1)")).toBeInTheDocument();
    expect(screen.getByText("لم يُفتح بعد (1)")).toBeInTheDocument();

    // pendingPeer.invitedWithSeen → "دُعي {{invited}} · شوهد {{seen}}".
    // The mid-dot is the BiDi-sensitive bit — assert it appears between
    // the two clauses inside the *same* text node, not split across
    // children (which would happen if an extra `<Text>` wrapped one half
    // and the JSON template had been silently rewritten).
    const openedPendingCard = screen.getByTestId("peer-pending-902");
    const midDotNode = Array.from(
      openedPendingCard.querySelectorAll("*"),
    ).find(
      el =>
        el.children.length === 0 &&
        (el.textContent ?? "").includes("دُعي") &&
        (el.textContent ?? "").includes(" · شوهد "),
    );
    expect(midDotNode, "expected dُعي … · شوهد … to render in one text node").toBeTruthy();

    // The unopened pending reviewer falls back to pendingPeer.invited
    // ("دُعي في {{date}}") — no mid-dot.
    const unopenedCard = screen.getByTestId("peer-pending-903");
    expect(unopenedCard.textContent ?? "").toMatch(/دُعي في /);
    expect(unopenedCard.textContent ?? "").not.toMatch(/ · شوهد /);
    // And the unopened reviewer shows the Arabic "not yet opened" pill.
    expect(unopenedCard.textContent ?? "").toContain("لم يُفتح بعد");
  });

  it("renders the activity section heading and the audit row's '· {actorName}' separator under RTL", async () => {
    await renderAndWaitForCase();

    expect(screen.getByText("النشاط")).toBeInTheDocument();
    // Audit row's meta line is `${date} · ${actorName}`. The actor name
    // is an LTR token; the mid-dot separator must survive the RTL flow
    // without being absorbed or reordered. testing-library matches text
    // on every ancestor too, so use `getAllByText` and assert the
    // separator + name token appear at least once anywhere on screen.
    const actorRows = screen.getAllByText((_, node) =>
      (node?.textContent ?? "").includes(" · Carol Committee"),
    );
    expect(actorRows.length).toBeGreaterThan(0);
  });

  it("renders the peer-status badge with the count placeholders in Arabic order: 'X من Y فتحوا'", async () => {
    await renderAndWaitForCase();

    // 3 reviewers total, 2 with seenAt (Riley + Olivia) → "2 من 3 فتحوا".
    // peerSummary.badge → "{{opened}} من {{total}} فتحوا"; if a future
    // refactor swaps the placeholders this assertion fails loudly.
    const badge = screen.getByTestId("peer-opened-summary-42");
    expect(badge.textContent).toContain("2 من 3 فتحوا");

    // The accessibility label is the longer Arabic sentence and must
    // also carry the same X/Y ordering for screen-reader users.
    expect(badge.getAttribute("aria-label") ?? "").toContain(
      "2 من 3 مراجعين فتحوا الدعوة. انقر لرؤية التفاصيل.",
    );
  });

  it("opens the peer-status bottom sheet, shows opened/unopened headings with un-mirrored parens, and orders the opened bucket above the unopened bucket", async () => {
    await renderAndWaitForCase();

    const badge = screen.getByTestId("peer-opened-summary-42");
    await act(async () => {
      fireEvent.click(badge);
    });

    // Sheet header → "حالة المراجعين الزملاء" + "{{opened}} من {{total}} فتحوا الدعوة".
    await waitFor(() => {
      expect(screen.getByText("حالة المراجعين الزملاء")).toBeInTheDocument();
    });
    expect(screen.getByText("2 من 3 فتحوا الدعوة")).toBeInTheDocument();

    // Bucket headings — parens around the count must NOT be reversed.
    // Use `getAllByText` for "لم يُفتح بعد (1)" because the same string
    // is reused by the pending-peer filter chip in the page body, and
    // testing-library matches both surfaces. We then narrow to the
    // sheet's heading by picking the one rendered with the modal's
    // `formLabel` styling (uppercase tracking + small font).
    const openedHeading = screen.getByText("مفتوح (2)");
    const notYetHeadings = screen.getAllByText("لم يُفتح بعد (1)");
    expect(notYetHeadings.length).toBeGreaterThanOrEqual(1);
    const notYetHeading =
      notYetHeadings.find(el =>
        (el.className ?? "").toString().includes("textTransform"),
      ) ?? notYetHeadings[notYetHeadings.length - 1];
    expect(openedHeading).toBeInTheDocument();
    expect(notYetHeading).toBeInTheDocument();

    // Both opened reviewers (Riley + Olivia) appear in the opened bucket,
    // and Nora appears in the unopened bucket.
    expect(screen.getByTestId("peer-opened-summary-opened-901")).toBeInTheDocument();
    expect(screen.getByTestId("peer-opened-summary-opened-902")).toBeInTheDocument();
    expect(screen.getByTestId("peer-opened-summary-unopened-903")).toBeInTheDocument();
    // And no cross-contamination between buckets.
    expect(screen.queryByTestId("peer-opened-summary-opened-903")).toBeNull();
    expect(screen.queryByTestId("peer-opened-summary-unopened-901")).toBeNull();
    expect(screen.queryByTestId("peer-opened-summary-unopened-902")).toBeNull();

    // Ordering — under RTL, react-native-web flips horizontal flex-row
    // children, but the sheet's *vertical* column should still paint the
    // opened heading above the not-yet-opened heading. DOM order is the
    // proxy for vertical paint order in jsdom.
    const positionBits = openedHeading.compareDocumentPosition(notYetHeading);
    expect(positionBits & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // Within the opened bucket itself, both reviewer rows render with
    // their Arabic "Seen <relative>" meta line (peerSummary.seenRelative
    // → "شوهد {{relative}}").
    const openedRiley = screen.getByTestId("peer-opened-summary-opened-901");
    expect((openedRiley.textContent ?? "").includes("شوهد ")).toBe(true);
    // And the unopened bucket uses peerSummary.invitedRelative
    // → "دُعي {{relative}}".
    const unopenedNora = screen.getByTestId("peer-opened-summary-unopened-903");
    expect((unopenedNora.textContent ?? "").includes("دُعي ")).toBe(true);
  });

  it("renders the action buttons with their Arabic labels (no English fallbacks)", async () => {
    await renderAndWaitForCase();

    // The case is `awaiting_peer` (non-terminal), so all three actions
    // are visible and must use Arabic copy. A regression where the
    // namespace fails to resolve would surface English fallbacks here.
    expect(
      screen.getByTestId("action-assign").textContent ?? "",
    ).toContain("تعيين");
    expect(
      screen.getByTestId("action-peer-invite").textContent ?? "",
    ).toContain("دعوة زميل");
    expect(
      screen.getByTestId("action-decide").textContent ?? "",
    ).toContain("تسجيل القرار");
  });
});
