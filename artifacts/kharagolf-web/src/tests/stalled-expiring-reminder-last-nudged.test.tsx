/**
 * Task #1892 — frontend coverage for the "who last nudged" indicator on
 * the Stalled export reminders dashboard widget (Task #1528).
 *
 * Backend behaviour (latest-resend join, cross-org isolation, displayName
 * preference) is covered by integration tests; this file pins the
 * dashboard side:
 *
 *   - The inline "Nudged Xm ago by Asha" line renders with the correct
 *     display name when the API returns `lastNudgedAt`/`lastNudgedByDisplayName`.
 *   - The Send-nudge button is disabled and shows "Just nudged" when
 *     `lastNudgedAt` is inside the recent-nudge window
 *     (`STALLED_NUDGE_RECENT_WINDOW_MS` = 1h).
 *   - The same button re-enables (and shows "Send nudge") once the
 *     timestamp ages past the window.
 *   - The `window.confirm()` defence-in-depth fallback fires if a click
 *     somehow sneaks through despite the disabled state — protecting the
 *     double-nudge guard against future refactors that drop the
 *     `disabled` prop.
 *
 * Mounts only `StalledExpiringReminderWidget` so we don't drag in the
 * full Dashboard's auth/active-org/membership stack. `useToast` is
 * mocked to avoid pulling in <Toaster />, mirroring
 * `green-contour-dialog.test.tsx`.
 */
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const toastMock = vi.fn();
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: toastMock }),
}));

// Imported after the mock so the widget picks up the stubbed useToast.
import { StalledExpiringReminderWidget } from "@/pages/dashboard";

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
  lastNudgedAt: string | null;
  lastNudgedByDisplayName: string | null;
}

const ORG_ID = 42;

function buildRow(overrides: Partial<StalledRow> = {}): StalledRow {
  return {
    id: 7001,
    clubMemberId: 501,
    memberFirstName: "Priya",
    memberLastName: "Rao",
    memberNumber: "M-0501",
    memberEmail: "priya@example.test",
    resolvedAt: null,
    expiringNoticeSentAt: "2026-04-25T09:00:00.000Z",
    expiringReminderEmailOpenedAt: "2026-04-26T10:00:00.000Z",
    expiringReminderEmailClickedAt: null,
    lastNotificationKind: "expiring_reminder",
    lastNotifiedAt: "2026-04-25T09:00:00.000Z",
    // Plenty of headroom so the "Purges in" label never reads as
    // critical-red and noise up the snapshot.
    purgesAt: new Date(Date.now() + 36 * 60 * 60 * 1000).toISOString(),
    lastNudgedAt: null,
    lastNudgedByDisplayName: null,
    ...overrides,
  };
}

function buildResponse(items: StalledRow[]) {
  return {
    filter: "all" as const,
    validDays: 7,
    counts: {
      total: items.length,
      openedOnly: items.filter((i) => !i.expiringReminderEmailClickedAt).length,
      clicked: items.filter((i) => !!i.expiringReminderEmailClickedAt).length,
    },
    items,
  };
}

function ok(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

interface ResendCall {
  url: string;
  method: string;
}

let resendCalls: ResendCall[];

function installFetch(items: StalledRow[]) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();

    if (
      method === "GET" &&
      url.includes(
        `/api/organizations/${ORG_ID}/members-360/data-requests/expiring-reminder-stalled`,
      )
    ) {
      return ok(buildResponse(items));
    }
    if (method === "POST" && url.includes("/data-requests/") && url.endsWith("/resend")) {
      resendCalls.push({ url, method });
      return ok({ ok: true });
    }
    return ok({});
  });
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
  return fetchMock;
}

function renderWidget() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <StalledExpiringReminderWidget orgId={ORG_ID} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  resendCalls = [];
  toastMock.mockClear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("StalledExpiringReminderWidget — 'who last nudged' indicator (Task #1892)", () => {
  it("renders the 'Nudged X ago by <name>' line with the joined display name", async () => {
    // 30 minutes ago — comfortably inside the 1h recent-nudge window so we
    // can also assert on the disabled state inline without a second test.
    const nudgedAt = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    installFetch([
      buildRow({
        id: 7100,
        clubMemberId: 510,
        memberFirstName: "Asha",
        memberLastName: "Khan",
        lastNudgedAt: nudgedAt,
        lastNudgedByDisplayName: "Asha Admin",
      }),
    ]);

    renderWidget();

    const indicator = await screen.findByTestId("stalled-last-nudge-7100");
    // Format: "Nudged 30m ago by Asha Admin" (timeSince() resolution is
    // coarse, so anywhere from 29m–31m inclusive is acceptable in case
    // of clock-tick jitter between data prep and render).
    expect(indicator.textContent ?? "").toMatch(
      /^Nudged \d{1,2}m ago by Asha Admin$/,
    );

    // The row exposes the recency state on a data attribute the layout
    // styling reads from — pin it so future refactors of the row CSS
    // don't silently flip the badge state.
    const row = screen.getByTestId("stalled-row-7100");
    expect(row.getAttribute("data-nudged-recently")).toBe("true");
  });

  it("falls back to 'an admin' when the join returned no display name", async () => {
    installFetch([
      buildRow({
        id: 7101,
        lastNudgedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
        lastNudgedByDisplayName: null,
      }),
    ]);

    renderWidget();

    const indicator = await screen.findByTestId("stalled-last-nudge-7101");
    expect(indicator.textContent ?? "").toMatch(/by an admin$/);
  });

  it("disables the Send-nudge button and shows 'Just nudged' inside the recent-nudge window", async () => {
    // 10 minutes ago is well inside the 1h window.
    installFetch([
      buildRow({
        id: 7200,
        clubMemberId: 520,
        memberFirstName: "Vikram",
        memberLastName: null,
        memberNumber: "M-0520",
        lastNudgedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
        lastNudgedByDisplayName: "Maya Admin",
      }),
    ]);

    renderWidget();

    const button = await screen.findByTestId("stalled-nudge-7200");
    expect(button).toBeDisabled();
    expect(button.textContent).toMatch(/Just nudged/);
    // The hover hint should name the previous nudger so a second admin
    // doesn't have to scan the row body to see who already pinged it.
    expect(button.getAttribute("title") ?? "").toMatch(/Maya Admin/);

    // And — importantly — the normal click path is fully blocked. No
    // confirm dialog, no fetch, no toast.
    const confirmSpy = vi
      .spyOn(window, "confirm")
      .mockReturnValue(true);
    fireEvent.click(button);
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(resendCalls).toHaveLength(0);
  });

  it("re-enables the Send-nudge button once lastNudgedAt is older than the recent-nudge window", async () => {
    // 90 minutes ago — past the 1h window, so the indicator still shows
    // but the button is interactive again.
    const nudgedAt = new Date(Date.now() - 90 * 60 * 1000).toISOString();
    installFetch([
      buildRow({
        id: 7300,
        clubMemberId: 530,
        memberFirstName: "Diego",
        memberLastName: "Lopez",
        lastNudgedAt: nudgedAt,
        lastNudgedByDisplayName: "Sam Admin",
      }),
    ]);

    renderWidget();

    const button = await screen.findByTestId("stalled-nudge-7300");
    expect(button).not.toBeDisabled();
    expect(button.textContent).toMatch(/Send nudge/);
    // No "title" tooltip on the enabled state — only the recent-nudge
    // disabled state carries the warning copy.
    expect(button.getAttribute("title")).toBeNull();

    // The historical line still renders so the admin can see who
    // touched the row last, even though it's safe to re-nudge now.
    const indicator = screen.getByTestId("stalled-last-nudge-7300");
    expect(indicator.textContent ?? "").toMatch(/by Sam Admin$/);

    // And the click path now actually fires the resend POST.
    fireEvent.click(button);
    await waitFor(() => {
      expect(resendCalls).toHaveLength(1);
    });
    expect(resendCalls[0].url).toContain(
      `/api/organizations/${ORG_ID}/members-360/530/data-requests/7300/resend`,
    );
  });

  it("triggers the window.confirm() fallback if a recent-nudge click sneaks past the disabled guard", async () => {
    // Recent nudge → button is disabled in normal use.
    installFetch([
      buildRow({
        id: 7400,
        clubMemberId: 540,
        memberFirstName: "Kenji",
        memberLastName: "Sato",
        lastNudgedAt: new Date(Date.now() - 15 * 60 * 1000).toISOString(),
        lastNudgedByDisplayName: "Lin Admin",
      }),
    ]);

    renderWidget();

    const button = await screen.findByTestId("stalled-nudge-7400");
    expect(button).toBeDisabled();

    // Simulate the "click somehow goes through" path — a future refactor
    // that drops the `disabled` prop, a browser extension that strips it,
    // or any code path that ends up invoking the React onClick handler
    // directly. React's synthetic-event system filters native click
    // events on `disabled` interactive elements via the fiber (not the
    // DOM attribute), so neither `fireEvent.click` nor
    // `dispatchEvent('click')` is enough to exercise the handler — we
    // have to call the handler the same way React would. We pull it off
    // the rendered fiber's props bag (the `__reactProps$<root>` key
    // React 18 attaches to every host node) so the test bypasses React's
    // disabled filter exactly the way a real-world bypass would.
    const reactPropsKey = Object.keys(button).find((k) =>
      k.startsWith("__reactProps$"),
    );
    expect(reactPropsKey).toBeDefined();
    const onClick = (button as unknown as Record<string, { onClick?: (e: unknown) => void }>)[
      reactPropsKey!
    ].onClick;
    expect(typeof onClick).toBe("function");

    // First case: admin clicks Cancel in the confirm → no resend POST is sent.
    const confirmSpy = vi
      .spyOn(window, "confirm")
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    onClick!({});

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    // The confirm copy must name both the recipient and the previous
    // nudger so the second admin can decide knowingly.
    const firstPrompt = String(confirmSpy.mock.calls[0]?.[0] ?? "");
    expect(firstPrompt).toMatch(/Kenji Sato/);
    expect(firstPrompt).toMatch(/Lin Admin/);
    expect(resendCalls).toHaveLength(0);

    // Second case: same handler, admin confirms → resend POST fires.
    onClick!({});
    await waitFor(() => {
      expect(resendCalls).toHaveLength(1);
    });
    expect(confirmSpy).toHaveBeenCalledTimes(2);
    expect(resendCalls[0].url).toContain(
      `/api/organizations/${ORG_ID}/members-360/540/data-requests/7400/resend`,
    );
  });
});
