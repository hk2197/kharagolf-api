/**
 * UI tests: mobile `OrgNotificationDefaultsCard` (Task #2099 — mobile mirror
 * of the web OrgNotificationDefaultsCard from Tasks #1188 / #1379 / #1673).
 *
 * Verifies:
 *   1. The card self-hides on 401/403 (non-admin user).
 *   2. The card renders all three known toggles with their loaded values
 *      and a per-toggle inheritance summary.
 *   3. Flipping a toggle PATCHes the defaults endpoint with the new value.
 */
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { OrgNotificationDefaultsCard } from "../components/OrgNotificationDefaultsCard";

type Defaults = {
  notifyManualEntryAlerts: boolean;
  notifyScheduleChanges: boolean;
  notifyScoreCorrections: boolean;
};

let defaultsStatus = 200;
let defaultsBody: Defaults = {
  notifyManualEntryAlerts: true,
  notifyScheduleChanges: true,
  notifyScoreCorrections: false,
};

let lastPatchBody: Partial<Defaults> | null = null;

const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const method = (init?.method ?? "GET").toUpperCase();

  if (url.endsWith("/notification-defaults") && method === "GET") {
    if (defaultsStatus === 200) {
      return new Response(JSON.stringify(defaultsBody), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ error: "forbidden" }), {
      status: defaultsStatus, headers: { "Content-Type": "application/json" },
    });
  }
  if (url.endsWith("/notification-defaults/tournaments") && method === "GET") {
    return new Response(JSON.stringify({
      tournaments: [
        {
          id: 1, name: "Spring Open", status: "active", startDate: "2026-05-01",
          notifyManualEntryAlerts: true,
          notifyScheduleChanges: false,
          notifyScoreCorrections: false,
        },
        {
          id: 2, name: "Junior Cup", status: "upcoming", startDate: "2026-06-01",
          notifyManualEntryAlerts: true,
          notifyScheduleChanges: true,
          notifyScoreCorrections: false,
        },
      ],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (url.endsWith("/notification-defaults") && method === "PATCH") {
    lastPatchBody = init?.body ? JSON.parse(String(init.body)) : null;
    return new Response(JSON.stringify({ ok: true }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  }
  throw new Error(`Unexpected fetch: ${method} ${url}`);
});

beforeEach(() => {
  defaultsStatus = 200;
  defaultsBody = {
    notifyManualEntryAlerts: true,
    notifyScheduleChanges: true,
    notifyScoreCorrections: false,
  };
  lastPatchBody = null;
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("OrgNotificationDefaultsCard (Task #2099)", () => {
  it("self-hides when the API returns 403 (non-admin user)", async () => {
    defaultsStatus = 403;
    const { container } = render(
      <OrgNotificationDefaultsCard orgId={7} token="t" />,
    );
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(container.querySelector('[data-testid="card-org-notification-defaults"]')).toBeNull();
    });
  });

  it("self-hides when the API returns 401 (signed-out / no session)", async () => {
    defaultsStatus = 401;
    const { container } = render(
      <OrgNotificationDefaultsCard orgId={7} token="t" />,
    );
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(container.querySelector('[data-testid="card-org-notification-defaults"]')).toBeNull();
    });
  });

  it("renders all three known toggles with their per-key inheritance summaries", async () => {
    render(<OrgNotificationDefaultsCard orgId={7} token="t" />);
    await waitFor(() => {
      expect(screen.getByTestId("card-org-notification-defaults")).toBeTruthy();
    });
    // All three toggles are present.
    await waitFor(() => {
      expect(screen.getByTestId("switch-org-notify-manual-entry")).toBeTruthy();
      expect(screen.getByTestId("switch-org-notify-schedule-changes")).toBeTruthy();
      expect(screen.getByTestId("switch-org-notify-score-corrections")).toBeTruthy();
    });
    // Per-toggle inheritance summary lines render after tournaments load.
    await waitFor(() => {
      expect(screen.getByTestId("text-inheritance-summary-manual-entry")).toBeTruthy();
      expect(screen.getByTestId("text-inheritance-summary-schedule-changes")).toBeTruthy();
      expect(screen.getByTestId("text-inheritance-summary-score-corrections")).toBeTruthy();
    });
  });

  it("PATCHes the defaults endpoint with the new value when a toggle is flipped", async () => {
    const { container } = render(<OrgNotificationDefaultsCard orgId={7} token="t" />);
    await screen.findByTestId("switch-org-notify-score-corrections");
    // react-native-web's Switch renders as a host <div> wrapping an
    // `<input role="switch">`. Click the underlying input so the
    // onValueChange callback fires (clicking the wrapper div is a no-op
    // because event handlers live on the input).
    const wrapper = container.querySelector(
      '[data-testid="switch-org-notify-score-corrections"]',
    ) as HTMLElement | null;
    expect(wrapper).not.toBeNull();
    const input = wrapper!.querySelector('input[role="switch"]') as HTMLInputElement | null;
    expect(input).not.toBeNull();
    await act(async () => {
      fireEvent.click(input!);
    });
    await waitFor(() => {
      expect(lastPatchBody).not.toBeNull();
    });
    expect(lastPatchBody).toEqual({ notifyScoreCorrections: true });
  });
});
