/**
 * Component test: web portal Notifications tab WhatsApp opt-in toggle
 * (Task #511 / Task #648).
 *
 * Renders the extracted `PortalCommPrefs` sub-component (split out of the
 * 3000-line `PlayerPortal` so it is testable in isolation) end-to-end at the
 * React level: mocks `fetch` so the GET hydrates the prefs list and the PUT
 * captures the body the card sends. Mirrors the mobile coverage in
 * `artifacts/kharagolf-mobile/__tests__/CommunicationsScreen.test.tsx`.
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

// Stub `useGetMe` so the controller-only "Stuck erasure cleanup digest"
// row added in Task #1453 can read a role without dragging a real
// QueryClient into this test. Default to a player so the new row stays
// hidden and this fixture remains focused on the WhatsApp row.
vi.mock("@workspace/api-client-react", () => ({
  useGetMe: () => ({ data: { id: 1, organizationId: 1, role: "player" } }),
}));

import { PortalCommPrefs } from "../pages/portal/PortalCommPrefs";

interface PrefRow {
  id: number;
  category: string;
  emailEnabled: boolean | null;
  smsEnabled: boolean | null;
  pushEnabled: boolean | null;
  whatsappEnabled: boolean | null;
  inAppEnabled: boolean | null;
}

let serverPrefs: PrefRow[] = [];
const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (!url.includes("/api/portal/my-comm-prefs")) {
    throw new Error(`Unexpected fetch: ${url}`);
  }
  const method = (init?.method ?? "GET").toUpperCase();
  if (method === "GET") {
    return new Response(JSON.stringify(serverPrefs), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (method === "PUT") {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    const cat = String(body.category);
    const existingIdx = serverPrefs.findIndex(p => p.category === cat);
    const next: PrefRow = {
      id: existingIdx >= 0 ? serverPrefs[existingIdx].id : serverPrefs.length + 100,
      category: cat,
      emailEnabled: Boolean(body.emailEnabled),
      smsEnabled: Boolean(body.smsEnabled),
      pushEnabled: Boolean(body.pushEnabled),
      whatsappEnabled: Boolean(body.whatsappEnabled),
      inAppEnabled: Boolean(body.inAppEnabled),
    };
    if (existingIdx >= 0) serverPrefs[existingIdx] = next;
    else serverPrefs = [...serverPrefs, next];
    return new Response(JSON.stringify(next), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  throw new Error(`Unexpected method: ${method}`);
});

beforeEach(() => {
  serverPrefs = [];
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("PortalCommPrefs — WhatsApp opt-in toggle (Task #648)", () => {
  it("renders a WhatsApp column and per-category WhatsApp switches", async () => {
    render(<PortalCommPrefs />);

    // Anchor on the table testid so we don't accidentally match unrelated copy.
    const table = await screen.findByTestId("table-comm-prefs");
    expect(table).toBeInTheDocument();
    expect(table.textContent).toMatch(/WhatsApp/);

    // Every category should expose a WhatsApp switch with the documented testid.
    for (const cat of [
      "billing",
      "operations",
      "service",
      "events",
      "tournaments",
      "newsletters",
      "marketing",
      "social",
      "privacy",
    ]) {
      expect(
        screen.getByTestId(`switch-comm-${cat}-whatsappEnabled`),
      ).toBeInTheDocument();
    }
  });

  it("defaults the WhatsApp switch to OFF when the member has no prefs row", async () => {
    render(<PortalCommPrefs />);

    const billingSwitch = await screen.findByTestId(
      "switch-comm-billing-whatsappEnabled",
    );
    await waitFor(() =>
      expect(billingSwitch.getAttribute("aria-checked")).toBe("false"),
    );

    const privacySwitch = screen.getByTestId(
      "switch-comm-privacy-whatsappEnabled",
    );
    expect(privacySwitch.getAttribute("aria-checked")).toBe("false");

    const getCalls = fetchMock.mock.calls.filter(
      c => ((c[1] as RequestInit | undefined)?.method ?? "GET") === "GET",
    );
    expect(getCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("toggling WhatsApp ON fires a PUT with whatsappEnabled=true and reflects the new state", async () => {
    render(<PortalCommPrefs />);

    const billingSwitch = await screen.findByTestId(
      "switch-comm-billing-whatsappEnabled",
    );
    await waitFor(() =>
      expect(billingSwitch.getAttribute("aria-checked")).toBe("false"),
    );

    await act(async () => {
      fireEvent.click(billingSwitch);
    });

    await waitFor(() => {
      const putCalls = fetchMock.mock.calls.filter(
        c => ((c[1] as RequestInit | undefined)?.method ?? "GET") === "PUT",
      );
      expect(putCalls.length).toBe(1);
    });

    const putCall = fetchMock.mock.calls.find(
      c => ((c[1] as RequestInit | undefined)?.method ?? "GET") === "PUT",
    )!;
    const putUrl = String(putCall[0]);
    expect(putUrl).toContain("/api/portal/my-comm-prefs");
    const body = JSON.parse(
      String((putCall[1] as RequestInit).body),
    ) as Record<string, unknown>;
    expect(body.category).toBe("billing");
    expect(body.whatsappEnabled).toBe(true);
    // The toggle preserves the other channel defaults (email on, sms off, push on, in_app on).
    expect(body.emailEnabled).toBe(true);
    expect(body.smsEnabled).toBe(false);
    expect(body.pushEnabled).toBe(true);
    expect(body.inAppEnabled).toBe(true);

    await waitFor(() => {
      const refreshed = screen.getByTestId(
        "switch-comm-billing-whatsappEnabled",
      );
      expect(refreshed.getAttribute("aria-checked")).toBe("true");
    });
  });

  it("toggling WhatsApp OFF for a category that was previously ON sends whatsappEnabled=false", async () => {
    serverPrefs = [
      {
        id: 1,
        category: "billing",
        emailEnabled: true,
        smsEnabled: false,
        pushEnabled: true,
        whatsappEnabled: true,
        inAppEnabled: true,
      },
    ];

    render(<PortalCommPrefs />);

    const billingSwitch = await screen.findByTestId(
      "switch-comm-billing-whatsappEnabled",
    );
    await waitFor(() =>
      expect(billingSwitch.getAttribute("aria-checked")).toBe("true"),
    );

    await act(async () => {
      fireEvent.click(billingSwitch);
    });

    await waitFor(() => {
      const putCalls = fetchMock.mock.calls.filter(
        c => ((c[1] as RequestInit | undefined)?.method ?? "GET") === "PUT",
      );
      expect(putCalls.length).toBe(1);
    });

    const putCall = fetchMock.mock.calls.find(
      c => ((c[1] as RequestInit | undefined)?.method ?? "GET") === "PUT",
    )!;
    const body = JSON.parse(
      String((putCall[1] as RequestInit).body),
    ) as Record<string, unknown>;
    expect(body.category).toBe("billing");
    expect(body.whatsappEnabled).toBe(false);

    await waitFor(() => {
      const refreshed = screen.getByTestId(
        "switch-comm-billing-whatsappEnabled",
      );
      expect(refreshed.getAttribute("aria-checked")).toBe("false");
    });
  });
});
