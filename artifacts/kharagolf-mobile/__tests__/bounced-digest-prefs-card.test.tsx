/**
 * UI tests: mobile `BouncedDigestPrefsCard` (Task #2099 — mobile mirror of
 * the web BouncedDigestPrefsCard from Task #274).
 *
 * Verifies:
 *   1. The card self-hides on 401/403 (non-admin user).
 *   2. The card renders the loaded prefs (frequency / hour / timezone).
 *   3. Saving PATCHes the prefs endpoint with the edited values.
 */
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { BouncedDigestPrefsCard } from "../components/BouncedDigestPrefsCard";

interface Prefs {
  frequency: "daily" | "weekday" | "weekly";
  hourLocal: number | null;
  timezone: string | null;
  lastSentOn: string | null;
}

let getStatus = 200;
let getBody: Prefs = {
  frequency: "daily", hourLocal: 9, timezone: "Asia/Kolkata", lastSentOn: "2026-04-29",
};
let lastPatchBody: Partial<Prefs> | null = null;

const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const method = (init?.method ?? "GET").toUpperCase();

  if (url.endsWith("/bounced-digest-prefs") && method === "GET") {
    if (getStatus === 200) {
      return new Response(JSON.stringify(getBody), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ error: "forbidden" }), {
      status: getStatus, headers: { "Content-Type": "application/json" },
    });
  }
  if (url.endsWith("/bounced-digest-prefs") && method === "PATCH") {
    lastPatchBody = init?.body ? JSON.parse(String(init.body)) : null;
    return new Response(JSON.stringify({
      ...getBody,
      ...(lastPatchBody as Partial<Prefs>),
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  if (url.endsWith("/bounced-digest-prefs/preview") && method === "POST") {
    return new Response(JSON.stringify({ sentTo: "admin@club.test" }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  }
  throw new Error(`Unexpected fetch: ${method} ${url}`);
});

beforeEach(() => {
  getStatus = 200;
  getBody = {
    frequency: "daily", hourLocal: 9, timezone: "Asia/Kolkata", lastSentOn: "2026-04-29",
  };
  lastPatchBody = null;
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("BouncedDigestPrefsCard (Task #2099)", () => {
  it("self-hides when the API returns 403 (non-admin user)", async () => {
    getStatus = 403;
    const { container } = render(
      <BouncedDigestPrefsCard orgId={7} token="t" />,
    );
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(container.querySelector('[data-testid="card-bounced-digest-prefs"]')).toBeNull();
    });
  });

  it("self-hides when the API returns 401 (signed-out / no session)", async () => {
    getStatus = 401;
    const { container } = render(
      <BouncedDigestPrefsCard orgId={7} token="t" />,
    );
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(container.querySelector('[data-testid="card-bounced-digest-prefs"]')).toBeNull();
    });
  });

  it("renders nothing when there is no orgId or token", () => {
    const { container } = render(
      <BouncedDigestPrefsCard orgId={null} token={null} />,
    );
    expect(container.querySelector('[data-testid="card-bounced-digest-prefs"]')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("renders the loaded prefs with the chosen frequency, hour, and timezone", async () => {
    render(<BouncedDigestPrefsCard orgId={7} token="t" />);
    await waitFor(() => {
      expect(screen.getByText("Daily")).toBeTruthy();
    });
    expect(screen.getByText("09:00")).toBeTruthy();
    // Last-sent line includes the lastSentOn date string from the API.
    expect(screen.getByText(/Last digest sent on 2026-04-29/)).toBeTruthy();
  });

  it("PATCHes the prefs endpoint with the current edits when Save is tapped", async () => {
    render(<BouncedDigestPrefsCard orgId={7} token="t" />);
    await waitFor(() => {
      expect(screen.getByText("Daily")).toBeTruthy();
    });
    const saveBtn = screen.getByTestId("button-save-digest-prefs");
    await act(async () => {
      fireEvent.click(saveBtn);
    });
    await waitFor(() => {
      expect(lastPatchBody).not.toBeNull();
    });
    expect(lastPatchBody).toEqual({
      frequency: "daily",
      hourLocal: 9,
      timezone: "Asia/Kolkata",
    });
  });
});
