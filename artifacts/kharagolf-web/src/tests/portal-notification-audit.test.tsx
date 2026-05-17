/**
 * Component test: web portal "Suppressed notifications" page (Task #1775).
 *
 * The new GET `/api/portal/notification-audit` surface exists so that a
 * controller who muted both the email and push channels for an alert
 * (canonically `privacy.erasure.storage_failures.controller_digest`) can
 * still see that the cron tried to reach them. This page is the *only*
 * UI rendering of those rows, so a regression here means the audit data
 * goes back to being invisible — exactly the silent-failure scenario the
 * task is meant to prevent.
 *
 * The mocked `fetch` returns:
 *   - one `event_opted_out` row → the UI must tag it `user_muted` and
 *     show the "Re-enable in settings" deep-link back to comm-prefs.
 *   - one `no_address` row → the UI must tag it `system_suppressed` and
 *     must NOT show the re-enable link (the user didn't mute it; flipping
 *     a toggle won't help).
 *   - `hasMore: true` + a cursor → the "Show more" affordance must appear
 *     and a click must fetch with the cursor + append the new entries.
 *
 * The `?days=` window selector is exercised by clicking the 7-day option
 * and asserting the next fetch carries that value, so the comm-prefs
 * deep-link arrives with sensible defaults but the controller can still
 * widen / narrow without leaving the page.
 */
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

interface AuditEntry {
  id: number;
  notificationKey: string;
  category: string | null;
  description: string | null;
  channel: string;
  status: string;
  reason: string | null;
  kind: "user_muted" | "system_suppressed";
  payload: Record<string, unknown>;
  createdAt: string;
}

interface AuditResponse {
  entries: AuditEntry[];
  windowDays: number;
  limit: number;
  hasMore: boolean;
  nextBefore: string | null;
}

const MUTED_ROW: AuditEntry = {
  id: 11,
  notificationKey: "privacy.erasure.storage_failures.controller_digest",
  category: "privacy_admin",
  description: "Stuck-erasure cleanup digest",
  channel: "email",
  status: "skipped",
  reason: "event_opted_out",
  kind: "user_muted",
  payload: {},
  createdAt: "2026-04-15T12:00:00.000Z",
};
const SYSTEM_ROW: AuditEntry = {
  id: 22,
  notificationKey: "billing.invoice.failure",
  category: "billing",
  description: "Invoice failure alert",
  channel: "email",
  status: "skipped",
  reason: "no_address",
  kind: "system_suppressed",
  payload: {},
  createdAt: "2026-04-14T08:00:00.000Z",
};
const PAGE_2_ROW: AuditEntry = {
  id: 33,
  notificationKey: "privacy.erasure.storage_failures.controller_digest",
  category: "privacy_admin",
  description: "Stuck-erasure cleanup digest",
  channel: "push",
  status: "skipped",
  reason: "event_opted_out",
  kind: "user_muted",
  payload: {},
  createdAt: "2026-04-10T08:00:00.000Z",
};

let firstPageResponse: AuditResponse = {
  entries: [MUTED_ROW, SYSTEM_ROW],
  windowDays: 30,
  limit: 50,
  hasMore: true,
  nextBefore: "2026-04-14T08:00:00.000Z",
};
let secondPageResponse: AuditResponse = {
  entries: [PAGE_2_ROW],
  windowDays: 30,
  limit: 50,
  hasMore: false,
  nextBefore: null,
};

const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const method = (init?.method ?? "GET").toUpperCase();
  if (method === "GET" && url.includes("/api/portal/notification-audit")) {
    // The component pages by appending `&before=<cursor>` — distinguish
    // the two responses on that, not on `days`, so the cursor wiring is
    // what's actually under test here.
    if (url.includes("before=")) {
      return new Response(JSON.stringify(secondPageResponse), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify(firstPageResponse), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  throw new Error(`Unexpected fetch: ${method} ${url}`);
});

beforeEach(() => {
  firstPageResponse = {
    entries: [MUTED_ROW, SYSTEM_ROW],
    windowDays: 30,
    limit: 50,
    hasMore: true,
    nextBefore: "2026-04-14T08:00:00.000Z",
  };
  secondPageResponse = {
    entries: [PAGE_2_ROW],
    windowDays: 30,
    limit: 50,
    hasMore: false,
    nextBefore: null,
  };
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function loadPage() {
  const mod = await import("../pages/portal/notification-audit");
  return mod.PortalNotificationAudit;
}

describe("PortalNotificationAudit (Task #1775)", () => {
  it("renders rows from the GET response and tags each with the correct kind badge", async () => {
    const PortalNotificationAudit = await loadPage();
    render(<PortalNotificationAudit />);

    // Both rows render — the muted one with a `user_muted` data-kind, the
    // system one with `system_suppressed`. We assert via `data-kind`
    // rather than badge text so the test isn't tied to translation copy.
    const mutedRow = await screen.findByTestId(`audit-row-${MUTED_ROW.id}`);
    expect(mutedRow.getAttribute("data-kind")).toBe("user_muted");

    const sysRow = await screen.findByTestId(`audit-row-${SYSTEM_ROW.id}`);
    expect(sysRow.getAttribute("data-kind")).toBe("system_suppressed");

    // Description from the registry is what the user actually reads;
    // assert it surfaced for both rows so a missing/incorrect server
    // join would fail this test, not just the backend test.
    expect(mutedRow.textContent).toContain("Stuck-erasure cleanup digest");
    expect(sysRow.textContent).toContain("Invoice failure alert");
  });

  it("only shows the 'Re-enable in settings' link on user-muted rows", async () => {
    const PortalNotificationAudit = await loadPage();
    render(<PortalNotificationAudit />);

    // The whole point of distinguishing the two kinds: a system-suppressed
    // row (e.g. bouncing email) cannot be fixed by flipping a settings
    // toggle, so we must NOT mislead the user with a "Re-enable" CTA.
    await screen.findByTestId(`audit-row-${MUTED_ROW.id}`);
    expect(screen.queryByTestId(`btn-reenable-${MUTED_ROW.id}`)).not.toBeNull();
    expect(screen.queryByTestId(`btn-reenable-${SYSTEM_ROW.id}`)).toBeNull();
  });

  it("'Show more' fetches with the cursor and appends the next page", async () => {
    const PortalNotificationAudit = await loadPage();
    render(<PortalNotificationAudit />);

    // Initial render = page 1 with hasMore=true so the load-more affordance
    // appears. Clicking it must trigger a fetch carrying `before=<cursor>`.
    await screen.findByTestId(`audit-row-${MUTED_ROW.id}`);
    const loadMore = await screen.findByTestId("btn-load-more");
    await act(async () => {
      fireEvent.click(loadMore);
    });

    await waitFor(() => {
      const cursorCalls = fetchMock.mock.calls.filter(c =>
        String(c[0]).includes("before=2026-04-14T08%3A00%3A00.000Z"),
      );
      expect(cursorCalls.length).toBeGreaterThanOrEqual(1);
    });

    // The page-2 row must be appended (not replace the existing list) so
    // the controller can scroll back through history without losing
    // context. Both old and new ids must be present after the click.
    await screen.findByTestId(`audit-row-${PAGE_2_ROW.id}`);
    expect(screen.queryByTestId(`audit-row-${MUTED_ROW.id}`)).not.toBeNull();
    expect(screen.queryByTestId(`audit-row-${SYSTEM_ROW.id}`)).not.toBeNull();
  });

  it("clicking the 7-day window option re-fetches with ?days=7", async () => {
    const PortalNotificationAudit = await loadPage();
    render(<PortalNotificationAudit />);

    await screen.findByTestId(`audit-row-${MUTED_ROW.id}`);

    const sevenDays = await screen.findByTestId("btn-window-7");
    await act(async () => {
      fireEvent.click(sevenDays);
    });

    // Default load fires with days=30; the click must trigger a *new*
    // GET carrying days=7 so the user's window choice actually narrows
    // the dataset (otherwise the buttons are decorative).
    await waitFor(() => {
      const dayCalls = fetchMock.mock.calls.filter(c =>
        String(c[0]).includes("/api/portal/notification-audit?days=7"),
      );
      expect(dayCalls.length).toBeGreaterThanOrEqual(1);
    });
  });

  it("renders the empty state when the API returns zero entries", async () => {
    firstPageResponse = {
      entries: [],
      windowDays: 30,
      limit: 50,
      hasMore: false,
      nextBefore: null,
    };

    const PortalNotificationAudit = await loadPage();
    render(<PortalNotificationAudit />);

    // The empty state is what new users see — assert it exists rather
    // than "no rows", so a blank-page regression (e.g. component throws
    // on `entries.length === 0`) surfaces here.
    await screen.findByTestId("audit-empty");
    expect(screen.queryByTestId("audit-list")).toBeNull();
  });

  it("surfaces a 401 from the API as a sign-in prompt instead of an empty list", async () => {
    fetchMock.mockImplementationOnce(async () => new Response("Unauthorized", { status: 401 }));

    const PortalNotificationAudit = await loadPage();
    render(<PortalNotificationAudit />);

    // Distinguishing 401 from "no entries" matters: a logged-out user
    // staring at "Nothing suppressed" would conclude their alerts work,
    // when actually we just couldn't read their data. We assert the
    // i18n *key* (not the rendered copy) because the test env doesn't
    // initialize i18next — what matters is that the 401 path renders the
    // signed-out copy, not the generic load-failed copy.
    const error = await screen.findByTestId("audit-error");
    expect(error.textContent ?? "").toContain("notificationAudit.errors.signedOut");
    expect(screen.queryByTestId("audit-list")).toBeNull();
    expect(screen.queryByTestId("audit-empty")).toBeNull();
  });
});
