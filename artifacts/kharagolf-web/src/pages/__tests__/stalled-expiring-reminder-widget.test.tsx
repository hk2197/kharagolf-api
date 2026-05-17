/**
 * UI test: dashboard "Stalled export reminders" widget (Task #1527).
 *
 * Task #1297 added <StalledExpiringReminderWidget /> on dashboard.tsx so
 * controllers can see members who opened the export-expiring reminder
 * but never came back to download their archive, with a per-row
 * "Send nudge" button that hits the existing
 * `POST /members-360/:memberId/data-requests/:id/resend` endpoint.
 *
 * The list endpoint
 * (`GET /members-360/data-requests/expiring-reminder-stalled`) is
 * already covered by
 * artifacts/api-server/src/tests/member-360-expiring-reminder-stalled.test.ts.
 * This file mirrors that coverage at the UI level: it mounts the widget
 * with two seeded rows (one opened-only, one clicked) and asserts:
 *   - both rows render with the right "Opened only" / "Clicked" badge
 *     and the per-tab counts come from the backend payload,
 *   - switching the filter tab re-fetches with `?filter=` and narrows
 *     the visible rows to match the backend payload,
 *   - clicking "Send nudge" issues a
 *     POST /organizations/:orgId/members-360/:memberId/data-requests/:id/resend
 *     for the right member/request, shows the success toast, and
 *     invalidates every filter variant so the list re-queries,
 *   - a failing nudge surfaces the destructive "Could not send nudge"
 *     toast with the server error message and does NOT trigger a
 *     re-query (so the row stays put for a retry),
 *   - the widget self-hides when the list endpoint responds 401/403
 *     (i.e. the viewer is not a member admin), mirroring the
 *     `if (!isLoading && data === null) return null` guard.
 *
 * Pattern mirrors levy-totals-widget.test.tsx (mocked global fetch +
 * isolated QueryClient) since this widget also speaks fetch directly
 * rather than going through the generated api-client.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// Render <Link> as a plain anchor so the member deep-link doesn't need a
// router context — matches the wouter mock used by levy-totals-widget.test.tsx.
vi.mock("wouter", () => ({
  Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) =>
    <a href={href} data-testid="wouter-link" {...rest}>{children}</a>,
}));

// Capture toast() calls so we can assert the success/error branches of
// the nudge mutation without rendering the toaster.
const toastMock = vi.fn();
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: toastMock }),
}));

import { StalledExpiringReminderWidget } from "../dashboard";

interface StalledRow {
  id: number;
  clubMemberId: number;
  memberFirstName: string | null;
  memberLastName: string | null;
  memberNumber: string | null;
  memberEmail: string | null;
  resolvedAt: string | null;
  expiringNoticeSentAt: string | null;
  expiringReminderEmailOpenedAt: string | null;
  expiringReminderEmailClickedAt: string | null;
  lastNotificationKind: string | null;
  lastNotifiedAt: string | null;
  purgesAt: string | null;
}

interface ResendResult {
  status: number;
  body: unknown;
}

interface FetchHandler {
  /** Status to return for the list endpoint (defaults to 200). */
  listStatus: number;
  /** All rows the backend "knows about" — filtered down per request. */
  allRows: StalledRow[];
  /** Per-filter call counts, used to assert the list is re-queried. */
  listCalls: Record<"all" | "opened-only" | "clicked", number>;
  /** Captured POSTs to /resend, in order. */
  resendCalls: { url: string; method: string }[];
  /** Result the next /resend call returns (default: 200 ok). */
  nextResendResult: ResendResult;
}

let handler: FetchHandler;

const ORG_ID = 42;

function makeRow(overrides: Partial<StalledRow>): StalledRow {
  return {
    id: 0,
    clubMemberId: 0,
    memberFirstName: null,
    memberLastName: null,
    memberNumber: null,
    memberEmail: null,
    resolvedAt: "2026-04-25T10:00:00.000Z",
    expiringNoticeSentAt: "2026-04-26T10:00:00.000Z",
    expiringReminderEmailOpenedAt: "2026-04-27T10:00:00.000Z",
    expiringReminderEmailClickedAt: null,
    lastNotificationKind: "expiring",
    lastNotifiedAt: "2026-04-26T10:00:00.000Z",
    // resolvedAt + 7d (DATA_EXPORT_VALID_DAYS) so the UI shows a real countdown.
    purgesAt: "2026-05-02T10:00:00.000Z",
    ...overrides,
  };
}

function applyFilter(filter: "all" | "opened-only" | "clicked"): StalledRow[] {
  if (filter === "opened-only") {
    return handler.allRows.filter((r) => r.expiringReminderEmailClickedAt === null);
  }
  if (filter === "clicked") {
    return handler.allRows.filter((r) => r.expiringReminderEmailClickedAt !== null);
  }
  return handler.allRows.slice();
}

function buildListBody(filter: "all" | "opened-only" | "clicked") {
  // Mirrors the route's response shape: `counts` is computed against the
  // unfiltered eligibility surface so unfocused tabs still show their
  // per-bucket totals — see artifacts/api-server/src/routes/member-360.ts.
  const all = handler.allRows;
  const openedOnly = all.filter((r) => r.expiringReminderEmailClickedAt === null).length;
  const clicked = all.filter((r) => r.expiringReminderEmailClickedAt !== null).length;
  return {
    filter,
    validDays: 7,
    counts: { total: all.length, openedOnly, clicked },
    items: applyFilter(filter),
  };
}

function installFetch() {
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();

    if (url.includes("/data-requests/expiring-reminder-stalled")) {
      const filter = (new URL(url, "http://localhost").searchParams.get("filter")
        ?? "all") as "all" | "opened-only" | "clicked";
      handler.listCalls[filter] += 1;
      if (handler.listStatus >= 400) {
        return new Response("", { status: handler.listStatus }) as unknown as Response;
      }
      return new Response(JSON.stringify(buildListBody(filter)), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }) as unknown as Response;
    }

    if (method === "POST" && /\/data-requests\/\d+\/resend$/.test(url)) {
      handler.resendCalls.push({ url, method });
      const { status, body } = handler.nextResendResult;
      return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }) as unknown as Response;
    }

    return new Response("not found", { status: 404 }) as unknown as Response;
  }) as typeof fetch;
}

function renderWidget(orgId = ORG_ID) {
  // Disable retry so a 401/403 on the list query immediately resolves
  // `data === null`, which is the gate the widget uses to self-hide.
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: 0, refetchOnWindowFocus: false, refetchInterval: false },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={qc}>
      <StalledExpiringReminderWidget orgId={orgId} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  toastMock.mockReset();
  handler = {
    listStatus: 200,
    allRows: [],
    listCalls: { "all": 0, "opened-only": 0, "clicked": 0 },
    resendCalls: [],
    nextResendResult: { status: 200, body: { ok: true } },
  };
  installFetch();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("<StalledExpiringReminderWidget /> (Task #1297 / Task #1527)", () => {
  it("renders the seeded rows with the right Opened-only vs Clicked badges and per-tab counts", async () => {
    handler.allRows = [
      // Opened the courtesy reminder but never clicked the download CTA.
      makeRow({
        id: 11,
        clubMemberId: 101,
        memberFirstName: "Alex",
        memberLastName: "Opener",
        expiringReminderEmailOpenedAt: "2026-04-27T10:00:00.000Z",
        expiringReminderEmailClickedAt: null,
      }),
      // Clicked the CTA but the signed URL never landed a download —
      // the more urgent of the two cohorts per the route docstring.
      makeRow({
        id: 22,
        clubMemberId: 202,
        memberFirstName: "Riley",
        memberLastName: "Clicker",
        expiringReminderEmailOpenedAt: "2026-04-26T10:00:00.000Z",
        expiringReminderEmailClickedAt: "2026-04-26T11:00:00.000Z",
      }),
    ];

    renderWidget();

    // Both rows render under the default "all" filter.
    const openedRow = await screen.findByTestId("stalled-row-11");
    const clickedRow = await screen.findByTestId("stalled-row-22");

    // The badges are the only visible signal of which cohort each row
    // belongs to, and they drive the controller's triage decision.
    expect(within(openedRow).getByText("Opened only")).toBeInTheDocument();
    expect(within(clickedRow).getByText("Clicked")).toBeInTheDocument();

    // Member name (firstName + lastName) is the link text on each row.
    expect(within(openedRow).getByTestId("stalled-member-11"))
      .toHaveTextContent("Alex Opener");
    expect(within(clickedRow).getByTestId("stalled-member-22"))
      .toHaveTextContent("Riley Clicker");

    // Per-tab counts are baked into the filter labels — they must
    // mirror the backend payload (total=2, openedOnly=1, clicked=1).
    expect(screen.getByTestId("stalled-filter-all")).toHaveTextContent("All (2)");
    expect(screen.getByTestId("stalled-filter-opened-only"))
      .toHaveTextContent("Opened only (1)");
    expect(screen.getByTestId("stalled-filter-clicked"))
      .toHaveTextContent("Clicked (1)");

    // Sanity: the request was scoped to the orgId and used the default
    // ?filter=all on first mount.
    const calls = (global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.some(([input]) => {
      const u = String(input);
      return u.includes(`/organizations/${ORG_ID}/members-360/data-requests/expiring-reminder-stalled`)
        && u.includes("filter=all");
    })).toBe(true);
  });

  it("re-fetches with ?filter= and narrows the list when the controller switches tabs", async () => {
    handler.allRows = [
      makeRow({
        id: 11,
        clubMemberId: 101,
        memberFirstName: "Alex",
        memberLastName: "Opener",
        expiringReminderEmailClickedAt: null,
      }),
      makeRow({
        id: 22,
        clubMemberId: 202,
        memberFirstName: "Riley",
        memberLastName: "Clicker",
        expiringReminderEmailClickedAt: "2026-04-26T11:00:00.000Z",
      }),
    ];

    renderWidget();
    await screen.findByTestId("stalled-row-11");
    await screen.findByTestId("stalled-row-22");

    // Switch to "Opened only" — the clicked row must drop off and the
    // list query must be re-issued with ?filter=opened-only.
    fireEvent.click(screen.getByTestId("stalled-filter-opened-only"));

    await waitFor(() => {
      expect(handler.listCalls["opened-only"]).toBeGreaterThanOrEqual(1);
    });
    await waitFor(() => {
      expect(screen.queryByTestId("stalled-row-22")).toBeNull();
    });
    expect(screen.getByTestId("stalled-row-11")).toBeInTheDocument();
    // Active tab marker — the styling key the dashboard uses.
    expect(screen.getByTestId("stalled-filter-opened-only"))
      .toHaveAttribute("data-active", "true");

    // Now switch to "Clicked" — only row 22 should remain.
    fireEvent.click(screen.getByTestId("stalled-filter-clicked"));

    await waitFor(() => {
      expect(handler.listCalls["clicked"]).toBeGreaterThanOrEqual(1);
    });
    await waitFor(() => {
      expect(screen.queryByTestId("stalled-row-11")).toBeNull();
    });
    expect(screen.getByTestId("stalled-row-22")).toBeInTheDocument();

    // Counts are computed against the unfiltered surface, so the
    // labels stay (2 / 1 / 1) regardless of which tab is active.
    expect(screen.getByTestId("stalled-filter-all")).toHaveTextContent("All (2)");
    expect(screen.getByTestId("stalled-filter-opened-only"))
      .toHaveTextContent("Opened only (1)");
    expect(screen.getByTestId("stalled-filter-clicked"))
      .toHaveTextContent("Clicked (1)");
  });

  it("renders the empty-state message when a filter has no matching rows", async () => {
    // Only an "opened-only" row exists, so the Clicked tab should hit
    // the empty-state branch.
    handler.allRows = [
      makeRow({
        id: 11,
        clubMemberId: 101,
        memberFirstName: "Alex",
        memberLastName: "Opener",
        expiringReminderEmailClickedAt: null,
      }),
    ];

    renderWidget();
    await screen.findByTestId("stalled-row-11");

    fireEvent.click(screen.getByTestId("stalled-filter-clicked"));
    await waitFor(() => expect(handler.listCalls["clicked"]).toBeGreaterThanOrEqual(1));

    expect(await screen.findByTestId("stalled-empty"))
      .toHaveTextContent(/No stalled reminders/i);
    expect(screen.queryByTestId("stalled-row-11")).toBeNull();
  });

  it("clicking 'Send nudge' POSTs the right resend URL, shows the success toast, and re-queries the list", async () => {
    handler.allRows = [
      makeRow({
        id: 11,
        clubMemberId: 101,
        memberFirstName: "Alex",
        memberLastName: "Opener",
      }),
      makeRow({
        id: 22,
        clubMemberId: 202,
        memberFirstName: "Riley",
        memberLastName: "Clicker",
        expiringReminderEmailClickedAt: "2026-04-26T11:00:00.000Z",
      }),
    ];

    renderWidget();
    await screen.findByTestId("stalled-row-22");

    // Snapshot how many list fetches we've already made so the
    // "re-query after success" assertion is unambiguous.
    const allCallsBefore = handler.listCalls["all"];

    fireEvent.click(screen.getByTestId("stalled-nudge-22"));

    // The mutation must hit the existing per-request resend endpoint
    // for the *clicked* member (clubMemberId=202, requestId=22).
    await waitFor(() => expect(handler.resendCalls.length).toBe(1));
    expect(handler.resendCalls[0].method).toBe("POST");
    expect(handler.resendCalls[0].url).toMatch(
      new RegExp(`/organizations/${ORG_ID}/members-360/202/data-requests/22/resend$`),
    );

    // Success toast — non-destructive, with the copy from dashboard.tsx.
    await waitFor(() => expect(toastMock).toHaveBeenCalled());
    const successCall = toastMock.mock.calls.find(([arg]) =>
      arg?.title === "Personal nudge sent");
    expect(successCall).toBeTruthy();
    expect(successCall![0]).not.toHaveProperty("variant", "destructive");
    // Task #1881 — the success toast must name *who* the nudge went to
    // so an admin firing several in a row can tell at a glance which
    // confirmation belongs to which row (and that they didn't misclick).
    expect(successCall![0].description).toBe(
      "The export-expiring reminder was re-delivered to Riley Clicker.",
    );

    // The mutation invalidates the entire expiring-reminder-stalled
    // prefix so unfocused tabs (All / Opened only / Clicked) reflect
    // the freshly-resent row's new state on the next mount instead of
    // waiting for the 60s refetchInterval. With the active tab still
    // "all", that re-query bumps the all-call counter.
    await waitFor(() => {
      expect(handler.listCalls["all"]).toBeGreaterThan(allCallsBefore);
    });
  });

  it("surfaces the destructive 'Could not send nudge' toast when the resend fails", async () => {
    handler.allRows = [
      makeRow({
        id: 11,
        clubMemberId: 101,
        memberFirstName: "Alex",
        memberLastName: "Opener",
      }),
    ];
    // Server says "no" — the mutation should propagate the body.error
    // string into the toast description rather than swallowing it.
    handler.nextResendResult = {
      status: 409,
      body: { error: "Member opted out of marketing emails" },
    };

    renderWidget();
    await screen.findByTestId("stalled-row-11");

    const allCallsBefore = handler.listCalls["all"];

    fireEvent.click(screen.getByTestId("stalled-nudge-11"));

    await waitFor(() => expect(handler.resendCalls.length).toBe(1));

    // Destructive variant + the server's error message in the toast,
    // prefixed with the recipient (Task #1881) so an admin firing
    // several nudges can tell which row failed.
    await waitFor(() => {
      expect(toastMock.mock.calls.some(([arg]) =>
        arg?.title === "Could not send nudge"
        && arg?.variant === "destructive"
        && arg?.description === "Alex Opener: Member opted out of marketing emails"
      )).toBe(true);
    });

    // A failed nudge must NOT invalidate the list — the row should
    // stay put (with its existing tabs/counts) so the controller can
    // retry without losing context. Give react-query a beat to settle
    // before asserting "no extra fetch happened".
    await new Promise((r) => setTimeout(r, 50));
    expect(handler.listCalls["all"]).toBe(allCallsBefore);
  });

  it("falls back to the member number in the toast when the recipient's name is missing (Task #1881)", async () => {
    // Anonymised export / deleted profile: no name parts, but the
    // member still has a club-issued number. The toast should never be
    // anonymous — it should name the member by their number so the
    // controller can still tell which row was just nudged.
    handler.allRows = [
      makeRow({
        id: 33,
        clubMemberId: 303,
        memberFirstName: null,
        memberLastName: null,
        memberNumber: "M-0303",
      }),
    ];

    renderWidget();
    await screen.findByTestId("stalled-row-33");

    fireEvent.click(screen.getByTestId("stalled-nudge-33"));

    await waitFor(() => expect(handler.resendCalls.length).toBe(1));
    await waitFor(() => {
      expect(toastMock.mock.calls.some(([arg]) =>
        arg?.title === "Personal nudge sent"
        && arg?.description
          === "The export-expiring reminder was re-delivered to M-0303."
      )).toBe(true);
    });
  });

  it("self-hides the widget when the list endpoint responds 403 (non-admin viewer)", async () => {
    handler.listStatus = 403;

    renderWidget();

    // Wait for the list request to complete so we know the 403 has
    // been processed (otherwise the assertion could pass simply
    // because the widget hasn't rendered yet).
    await waitFor(() => expect(handler.listCalls["all"]).toBeGreaterThanOrEqual(1));

    // After 401/403 the widget renders nothing — no card, no filter
    // tabs, no rows. (Mirrors `if (!isLoading && data === null) return null`.)
    await waitFor(() => {
      expect(screen.queryByTestId("stalled-expiring-reminders-widget")).toBeNull();
    });
    expect(screen.queryByTestId("stalled-filters")).toBeNull();
  });

  it("also self-hides on 401 (unauthenticated viewer)", async () => {
    handler.listStatus = 401;

    renderWidget();

    await waitFor(() => expect(handler.listCalls["all"]).toBeGreaterThanOrEqual(1));
    await waitFor(() => {
      expect(screen.queryByTestId("stalled-expiring-reminders-widget")).toBeNull();
    });
  });
});
