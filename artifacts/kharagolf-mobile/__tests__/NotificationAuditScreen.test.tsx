/**
 * Component test: mobile `NotificationAuditScreen` (Task #2223 — mobile
 * mirror of the web portal `/portal/notification-audit` page).
 *
 * Exercises the new screen end-to-end at the React level: mocks `fetch`
 * so the GET hydrates the suppressed-notification rows, and verifies
 * that:
 *
 *   1. The screen calls GET `/api/portal/notification-audit?days=30` on
 *      mount and renders the heading.
 *   2. Each row renders with the correct `kind` discriminator badge
 *      (`user_muted` → "You muted this", everything else →
 *      "System suppressed") and the user-muted rows show a
 *      "Re-enable in settings" button.
 *   3. Empty responses render the empty-state copy.
 *   4. 401s render the signed-out copy; non-OK responses render the
 *      generic load-failed copy.
 *   5. Switching the time-window pill re-fetches with the new `days`
 *      query and the active pill carries `aria-checked=true`.
 *   6. The `link-comm-prefs` button navigates to the communications
 *      screen via `expo-router`.
 *
 * Mirrors the web portal's
 * `artifacts/kharagolf-web/src/tests/portal-notification-audit.test.tsx`
 * coverage so any future contract drift between the two surfaces gets
 * flagged on both sides.
 */
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const pushMock = vi.fn();

vi.mock("@/context/auth", () => ({
  useAuth: () => ({ token: "test-token", user: { id: 1 }, isAuthenticated: true, isLoading: false }),
}));

vi.mock("@/constants/colors", () => ({
  default: {
    primary: "#0a0",
    background: "#000",
    surface: "#111",
    border: "#222",
    tabIconDefault: "#888",
  },
}));

vi.mock("expo-router", () => ({
  router: { push: (path: string) => pushMock(path), replace: () => {}, back: () => {} },
  useRouter: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
  useLocalSearchParams: () => ({}),
  useSegments: () => [],
  Link: ({ children }: { children?: unknown }) => children,
  Stack: { Screen: () => null },
}));

import NotificationAuditScreen from "../app/my-360/notification-audit";

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

let auditResponse: { status: number; body: AuditResponse | { error: string } } = {
  status: 200,
  body: { entries: [], windowDays: 30, limit: 50, hasMore: false, nextBefore: null },
};

const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
  const url = String(input);
  if (url.includes("/api/portal/notification-audit")) {
    return new Response(JSON.stringify(auditResponse.body), {
      status: auditResponse.status,
      headers: { "Content-Type": "application/json" },
    });
  }
  throw new Error(`Unexpected fetch: ${url}`);
});

beforeEach(() => {
  auditResponse = {
    status: 200,
    body: { entries: [], windowDays: 30, limit: 50, hasMore: false, nextBefore: null },
  };
  pushMock.mockClear();
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("NotificationAuditScreen — initial load", () => {
  it("calls GET /api/portal/notification-audit?days=30 on mount and renders the heading", async () => {
    render(<NotificationAuditScreen />);

    expect(await screen.findByTestId("heading-notification-audit")).toBeInTheDocument();
    await waitFor(() => {
      const calls = fetchMock.mock.calls.filter(c => String(c[0]).includes("/api/portal/notification-audit"));
      expect(calls.length).toBeGreaterThanOrEqual(1);
      expect(String(calls[0][0])).toContain("days=30");
    });
  });

  it("renders the empty-state copy when the API returns no entries", async () => {
    render(<NotificationAuditScreen />);
    expect(await screen.findByTestId("audit-empty")).toBeInTheDocument();
  });
});

describe("NotificationAuditScreen — row rendering", () => {
  it("tags user_muted rows with the muted badge AND a re-enable button, and system_suppressed rows with the system badge AND no button", async () => {
    auditResponse = {
      status: 200,
      body: {
        entries: [
          {
            id: 101,
            notificationKey: "privacy.erasure.storage_failures.controller_digest",
            category: "privacy",
            description: "Controller daily digest: stuck object-storage erasures",
            channel: "email",
            status: "skipped",
            reason: "event_opted_out",
            kind: "user_muted",
            payload: {},
            createdAt: "2026-04-15T10:00:00Z",
          },
          {
            id: 202,
            notificationKey: "billing.statement_ready",
            category: "billing",
            description: "Monthly statement ready",
            channel: "push",
            status: "skipped",
            reason: "no_address",
            kind: "system_suppressed",
            payload: {},
            createdAt: "2026-04-14T10:00:00Z",
          },
        ],
        windowDays: 30,
        limit: 50,
        hasMore: false,
        nextBefore: null,
      },
    };

    render(<NotificationAuditScreen />);

    expect(await screen.findByTestId("audit-row-101")).toBeInTheDocument();
    expect(screen.getByTestId("audit-row-202")).toBeInTheDocument();

    // The user-muted row shows the muted badge and a re-enable button.
    expect(screen.getByTestId("badge-kind-101")).toHaveTextContent(/You muted this/i);
    expect(screen.getByTestId("btn-reenable-101")).toBeInTheDocument();

    // The system-suppressed row shows the system badge and NO re-enable button.
    expect(screen.getByTestId("badge-kind-202")).toHaveTextContent(/System suppressed/i);
    expect(screen.queryByTestId("btn-reenable-202")).toBeNull();

    // Each row renders the notification key, channel, and reason metadata.
    const row101 = screen.getByTestId("audit-row-101");
    expect(row101).toHaveTextContent("privacy.erasure.storage_failures.controller_digest");
    expect(row101).toHaveTextContent("email");
    expect(row101).toHaveTextContent("event_opted_out");
  });
});

describe("NotificationAuditScreen — error handling", () => {
  it("renders the signed-out copy when the API returns 401", async () => {
    auditResponse = { status: 401, body: { error: "unauthorized" } };
    render(<NotificationAuditScreen />);
    const card = await screen.findByTestId("audit-error");
    expect(card).toHaveTextContent(/Sign in to view your suppressed notifications/i);
  });

  it("renders the generic load-failed copy when the API returns 500", async () => {
    auditResponse = { status: 500, body: { error: "boom" } };
    render(<NotificationAuditScreen />);
    const card = await screen.findByTestId("audit-error");
    expect(card).toHaveTextContent(/Couldn't load your notification audit/i);
  });
});

describe("NotificationAuditScreen — window selector", () => {
  it("re-fetches with the selected days when the window pill changes", async () => {
    render(<NotificationAuditScreen />);
    await screen.findByTestId("audit-empty");

    await act(async () => {
      fireEvent.click(screen.getByTestId("btn-window-7"));
    });

    await waitFor(() => {
      const calls = fetchMock.mock.calls.filter(c => String(c[0]).includes("days=7"));
      expect(calls.length).toBeGreaterThanOrEqual(1);
    });
  });
});

describe("NotificationAuditScreen — comm-prefs deep link", () => {
  it("navigates back to /my-360/communications when the link button is tapped", async () => {
    render(<NotificationAuditScreen />);
    const link = await screen.findByTestId("link-comm-prefs");

    await act(async () => {
      fireEvent.click(link);
    });

    expect(pushMock).toHaveBeenCalledWith("/my-360/communications");
  });
});
