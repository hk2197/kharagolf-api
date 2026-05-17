/**
 * Component test: mobile member-facing WhatsApp opt-in toggle (Task #511).
 *
 * Exercises the mobile `my-360/communications` screen end-to-end at the
 * React level: mocks `fetch` so the GET hydrates the prefs list and the PUT
 * captures the body the screen sends. Verifies that:
 *
 *   1. With NO prefs row from the server, the WhatsApp switch defaults to OFF
 *      (the schema/UI default — members must explicitly opt in).
 *   2. Toggling the WhatsApp switch fires a PUT to /api/portal/my-comm-prefs
 *      with the correct body shape and `whatsappEnabled: true`.
 *   3. After the PUT resolves, the screen re-fetches and the switch reflects
 *      the new server state.
 */
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, cleanup } from "@testing-library/react";

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

vi.mock("../app/my-360/_shared", async () => {
  const actual = await vi.importActual<typeof import("../app/my-360/_shared")>("../app/my-360/_shared");
  return {
    ...actual,
    useActingMemberId: () => [null, () => {}],
    actingQs: () => "",
  };
});

import CommunicationsScreen from "../app/my-360/communications";

interface PrefRow {
  id: number; category: string;
  emailEnabled: boolean | null; smsEnabled: boolean | null; pushEnabled: boolean | null;
  whatsappEnabled: boolean | null; inAppEnabled: boolean | null;
}

interface KeyPref {
  key: string;
  category: string;
  description: string;
  override: "realtime" | "digest" | null;
  effectiveMode: "realtime" | "digest";
}

let serverPrefs: PrefRow[] = [];
let serverKeyPrefs: { digestMode: boolean; keys: KeyPref[] } = { digestMode: false, keys: [] };
let serverNotifPrefs: Record<string, unknown> | null = null;
const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const method = (init?.method ?? "GET").toUpperCase();

  if (url.includes("/api/portal/notification-key-prefs")) {
    if (method === "GET") {
      return new Response(JSON.stringify(serverKeyPrefs), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (method === "PATCH") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { key: string; deliveryMode: "realtime" | "digest" | null };
      const idx = serverKeyPrefs.keys.findIndex(k => k.key === body.key);
      if (idx >= 0 && (body.deliveryMode === "realtime" || body.deliveryMode === "digest")) {
        const next: KeyPref = { ...serverKeyPrefs.keys[idx], override: body.deliveryMode, effectiveMode: body.deliveryMode };
        const nextKeys = serverKeyPrefs.keys.slice();
        nextKeys[idx] = next;
        serverKeyPrefs = { ...serverKeyPrefs, keys: nextKeys };
      }
      return new Response(JSON.stringify({ key: body.key, override: body.deliveryMode }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    throw new Error(`Unexpected method ${method} for ${url}`);
  }

  if (url.includes("/api/portal/notification-preferences")) {
    if (method === "GET") {
      return new Response(JSON.stringify(serverNotifPrefs), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (method === "PATCH") {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      serverNotifPrefs = { ...(serverNotifPrefs ?? {}), ...body };
      return new Response(JSON.stringify(serverNotifPrefs), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    throw new Error(`Unexpected method ${method} for ${url}`);
  }

  if (!url.includes("/api/portal/my-comm-prefs")) {
    throw new Error(`Unexpected fetch: ${url}`);
  }
  if (method === "GET") {
    return new Response(JSON.stringify(serverPrefs), { status: 200, headers: { "Content-Type": "application/json" } });
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
    return new Response(JSON.stringify(next), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  throw new Error(`Unexpected method: ${method}`);
});

beforeEach(() => {
  serverPrefs = [];
  serverKeyPrefs = { digestMode: false, keys: [] };
  serverNotifPrefs = null;
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("CommunicationsScreen — WhatsApp opt-in toggle (Task #511)", () => {
  it("defaults the WhatsApp switch to OFF when the member has no prefs row", async () => {
    render(<CommunicationsScreen />);

    // Wait for the GET to resolve and the loading spinner to be replaced.
    const billingSwitch = await screen.findByTestId("switch-comm-billing-whatsappEnabled");
    expect(billingSwitch).toBeInTheDocument();

    // react-native-web renders Switch as a checkbox-role input.
    const checkbox = billingSwitch.querySelector("input[type='checkbox']") as HTMLInputElement | null;
    expect(checkbox).not.toBeNull();
    expect(checkbox!.checked).toBe(false);

    // Privacy & legal category should also default OFF for WhatsApp.
    const privacySwitch = await screen.findByTestId("switch-comm-privacy-whatsappEnabled");
    const privacyCheckbox = privacySwitch.querySelector("input[type='checkbox']") as HTMLInputElement | null;
    expect(privacyCheckbox!.checked).toBe(false);

    // Initial GET happened.
    const getCalls = fetchMock.mock.calls.filter(c => (c[1]?.method ?? "GET") === "GET");
    expect(getCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("toggling WhatsApp ON fires a PUT with whatsappEnabled=true and reflects the new state", async () => {
    render(<CommunicationsScreen />);

    const billingSwitch = await screen.findByTestId("switch-comm-billing-whatsappEnabled");
    const checkbox = billingSwitch.querySelector("input[type='checkbox']") as HTMLInputElement;
    expect(checkbox.checked).toBe(false);

    await act(async () => {
      fireEvent.click(checkbox);
    });

    // The PUT fires with the WhatsApp opt-in.
    await waitFor(() => {
      const putCalls = fetchMock.mock.calls.filter(c => (c[1]?.method ?? "GET") === "PUT");
      expect(putCalls.length).toBe(1);
    });

    const putCall = fetchMock.mock.calls.find(c => (c[1]?.method ?? "GET") === "PUT")!;
    const putUrl = String(putCall[0]);
    expect(putUrl).toContain("/api/portal/my-comm-prefs");
    const body = JSON.parse(String((putCall[1] as RequestInit).body)) as Record<string, unknown>;
    expect(body.category).toBe("billing");
    expect(body.whatsappEnabled).toBe(true);
    // The toggle preserves the other channel defaults (email on, sms off, push on, in_app on).
    expect(body.emailEnabled).toBe(true);
    expect(body.smsEnabled).toBe(false);
    expect(body.pushEnabled).toBe(true);
    expect(body.inAppEnabled).toBe(true);

    // After the PUT resolves the screen re-fetches; the switch should now be ON.
    await waitFor(() => {
      const refreshed = screen.getByTestId("switch-comm-billing-whatsappEnabled");
      const cb = refreshed.querySelector("input[type='checkbox']") as HTMLInputElement;
      expect(cb.checked).toBe(true);
    });
  });

  it("toggling WhatsApp OFF for a category that was previously ON sends whatsappEnabled=false", async () => {
    // Seed the server so the screen renders with billing.whatsapp=true.
    serverPrefs = [{
      id: 1, category: "billing",
      emailEnabled: true, smsEnabled: false, pushEnabled: true,
      whatsappEnabled: true, inAppEnabled: true,
    }];

    render(<CommunicationsScreen />);

    const billingSwitch = await screen.findByTestId("switch-comm-billing-whatsappEnabled");
    const checkbox = billingSwitch.querySelector("input[type='checkbox']") as HTMLInputElement;
    await waitFor(() => expect(checkbox.checked).toBe(true));

    await act(async () => {
      fireEvent.click(checkbox);
    });

    await waitFor(() => {
      const putCalls = fetchMock.mock.calls.filter(c => (c[1]?.method ?? "GET") === "PUT");
      expect(putCalls.length).toBe(1);
    });

    const putCall = fetchMock.mock.calls.find(c => (c[1]?.method ?? "GET") === "PUT")!;
    const body = JSON.parse(String((putCall[1] as RequestInit).body)) as Record<string, unknown>;
    expect(body.category).toBe("billing");
    expect(body.whatsappEnabled).toBe(false);

    await waitFor(() => {
      const refreshed = screen.getByTestId("switch-comm-billing-whatsappEnabled");
      const cb = refreshed.querySelector("input[type='checkbox']") as HTMLInputElement;
      expect(cb.checked).toBe(false);
    });
  });
});

describe("CommunicationsScreen — per-notification key prefs (Task #1352)", () => {
  it("hides the per-key section when the registry returns no digestable keys", async () => {
    serverKeyPrefs = { digestMode: false, keys: [] };
    render(<CommunicationsScreen />);
    // Wait for the screen to finish loading.
    await screen.findByTestId("switch-comm-billing-whatsappEnabled");
    expect(screen.queryByTestId("section-notification-key-prefs")).toBeNull();
  });

  it("renders one row per digestable notification key with the effective mode reflected in the segment", async () => {
    serverKeyPrefs = {
      digestMode: false,
      keys: [
        { key: "tournament.draw_published", category: "tournaments", description: "Tournament draw published", override: null, effectiveMode: "realtime" },
        { key: "billing.statement_ready", category: "billing", description: "Monthly statement ready", override: "digest", effectiveMode: "digest" },
      ],
    };
    render(<CommunicationsScreen />);

    await screen.findByTestId("section-notification-key-prefs");
    expect(screen.getByTestId("row-key-pref-tournament.draw_published")).toBeInTheDocument();
    expect(screen.getByTestId("row-key-pref-billing.statement_ready")).toBeInTheDocument();

    // The first key inherits the off-global-digest default → real-time is selected.
    const draw = screen.getByTestId("btn-key-pref-tournament.draw_published-realtime");
    expect(draw.getAttribute("id")).toBe("btn-key-pref-tournament.draw_published-realtime-active");
    // The second key has an explicit digest override → daily summary is selected.
    const stmt = screen.getByTestId("btn-key-pref-billing.statement_ready-digest");
    expect(stmt.getAttribute("id")).toBe("btn-key-pref-billing.statement_ready-digest-active");

    // The GET to the new endpoint happened.
    const getCalls = fetchMock.mock.calls.filter(
      c => String(c[0]).includes("/api/portal/notification-key-prefs") && (c[1]?.method ?? "GET") === "GET",
    );
    expect(getCalls.length).toBe(1);
  });

  it("tapping 'Daily summary' for a real-time key PATCHes the new override and updates the UI", async () => {
    serverKeyPrefs = {
      digestMode: false,
      keys: [
        { key: "tournament.draw_published", category: "tournaments", description: "Tournament draw published", override: null, effectiveMode: "realtime" },
      ],
    };
    render(<CommunicationsScreen />);

    const digestBtn = await screen.findByTestId("btn-key-pref-tournament.draw_published-digest");
    expect(digestBtn.getAttribute("id")).toBe("btn-key-pref-tournament.draw_published-digest-inactive");

    await act(async () => {
      fireEvent.click(digestBtn);
    });

    await waitFor(() => {
      const patchCalls = fetchMock.mock.calls.filter(
        c => String(c[0]).includes("/api/portal/notification-key-prefs") && (c[1]?.method ?? "GET") === "PATCH",
      );
      expect(patchCalls.length).toBe(1);
    });

    const patchCall = fetchMock.mock.calls.find(
      c => String(c[0]).includes("/api/portal/notification-key-prefs") && (c[1]?.method ?? "GET") === "PATCH",
    )!;
    const body = JSON.parse(String((patchCall[1] as RequestInit).body)) as Record<string, unknown>;
    expect(body.key).toBe("tournament.draw_published");
    expect(body.deliveryMode).toBe("digest");

    // Optimistic UI: the digest button should now be selected without a re-fetch.
    await waitFor(() => {
      const refreshed = screen.getByTestId("btn-key-pref-tournament.draw_published-digest");
      expect(refreshed.getAttribute("id")).toBe("btn-key-pref-tournament.draw_published-digest-active");
    });
  });

  it("tapping 'Real-time' for a digest-overridden key PATCHes deliveryMode=realtime", async () => {
    serverKeyPrefs = {
      digestMode: true,
      keys: [
        { key: "billing.statement_ready", category: "billing", description: "Monthly statement ready", override: "digest", effectiveMode: "digest" },
      ],
    };
    render(<CommunicationsScreen />);

    const realtimeBtn = await screen.findByTestId("btn-key-pref-billing.statement_ready-realtime");
    expect(realtimeBtn.getAttribute("id")).toBe("btn-key-pref-billing.statement_ready-realtime-inactive");

    await act(async () => {
      fireEvent.click(realtimeBtn);
    });

    await waitFor(() => {
      const patchCalls = fetchMock.mock.calls.filter(
        c => String(c[0]).includes("/api/portal/notification-key-prefs") && (c[1]?.method ?? "GET") === "PATCH",
      );
      expect(patchCalls.length).toBe(1);
    });

    const patchCall = fetchMock.mock.calls.find(
      c => String(c[0]).includes("/api/portal/notification-key-prefs") && (c[1]?.method ?? "GET") === "PATCH",
    )!;
    const body = JSON.parse(String((patchCall[1] as RequestInit).body)) as Record<string, unknown>;
    expect(body.key).toBe("billing.statement_ready");
    expect(body.deliveryMode).toBe("realtime");
  });
});

describe("CommunicationsScreen — data export expiring reminder toggle (Task #1433)", () => {
  it("hydrates the switch from notifyDataExportExpiring=true → ON", async () => {
    serverNotifPrefs = { notifySideGameReceipts: true, notifyDataExportExpiring: true };

    render(<CommunicationsScreen />);

    const toggle = await screen.findByTestId("switch-notify-data-export-expiring");
    const checkbox = toggle.querySelector("input[type='checkbox']") as HTMLInputElement | null;
    expect(checkbox).not.toBeNull();
    await waitFor(() => expect(checkbox!.checked).toBe(true));
  });

  it("hydrates the switch from notifyDataExportExpiring=false → OFF", async () => {
    serverNotifPrefs = { notifySideGameReceipts: true, notifyDataExportExpiring: false };

    render(<CommunicationsScreen />);

    const toggle = await screen.findByTestId("switch-notify-data-export-expiring");
    const checkbox = toggle.querySelector("input[type='checkbox']") as HTMLInputElement | null;
    expect(checkbox).not.toBeNull();
    await waitFor(() => expect(checkbox!.checked).toBe(false));
  });

  it("toggling the switch off PATCHes notifyDataExportExpiring=false and reflects the new state", async () => {
    serverNotifPrefs = { notifySideGameReceipts: true, notifyDataExportExpiring: true };

    render(<CommunicationsScreen />);

    const toggle = await screen.findByTestId("switch-notify-data-export-expiring");
    const checkbox = toggle.querySelector("input[type='checkbox']") as HTMLInputElement;
    await waitFor(() => expect(checkbox.checked).toBe(true));

    await act(async () => {
      fireEvent.click(checkbox);
    });

    await waitFor(() => {
      const patchCalls = fetchMock.mock.calls.filter(
        c => String(c[0]).includes("/api/portal/notification-preferences") && (c[1]?.method ?? "GET") === "PATCH",
      );
      expect(patchCalls.length).toBe(1);
    });

    const patchCall = fetchMock.mock.calls.find(
      c => String(c[0]).includes("/api/portal/notification-preferences") && (c[1]?.method ?? "GET") === "PATCH",
    )!;
    const body = JSON.parse(String((patchCall[1] as RequestInit).body)) as Record<string, unknown>;
    expect(body).toEqual({ notifyDataExportExpiring: false });

    // Optimistic UI: the switch reflects the new state without waiting for a re-fetch.
    await waitFor(() => {
      const refreshed = screen.getByTestId("switch-notify-data-export-expiring");
      const cb = refreshed.querySelector("input[type='checkbox']") as HTMLInputElement;
      expect(cb.checked).toBe(false);
    });

    // The unrelated sibling toggle isn't touched by the PATCH.
    const sideGame = screen.getByTestId("switch-notify-side-game-receipts");
    const sideGameCb = sideGame.querySelector("input[type='checkbox']") as HTMLInputElement;
    expect(sideGameCb.checked).toBe(true);
  });

  it("toggling the switch back on PATCHes notifyDataExportExpiring=true", async () => {
    serverNotifPrefs = { notifySideGameReceipts: true, notifyDataExportExpiring: false };

    render(<CommunicationsScreen />);

    const toggle = await screen.findByTestId("switch-notify-data-export-expiring");
    const checkbox = toggle.querySelector("input[type='checkbox']") as HTMLInputElement;
    await waitFor(() => expect(checkbox.checked).toBe(false));

    await act(async () => {
      fireEvent.click(checkbox);
    });

    await waitFor(() => {
      const patchCalls = fetchMock.mock.calls.filter(
        c => String(c[0]).includes("/api/portal/notification-preferences") && (c[1]?.method ?? "GET") === "PATCH",
      );
      expect(patchCalls.length).toBe(1);
    });

    const patchCall = fetchMock.mock.calls.find(
      c => String(c[0]).includes("/api/portal/notification-preferences") && (c[1]?.method ?? "GET") === "PATCH",
    )!;
    const body = JSON.parse(String((patchCall[1] as RequestInit).body)) as Record<string, unknown>;
    expect(body).toEqual({ notifyDataExportExpiring: true });

    await waitFor(() => {
      const refreshed = screen.getByTestId("switch-notify-data-export-expiring");
      const cb = refreshed.querySelector("input[type='checkbox']") as HTMLInputElement;
      expect(cb.checked).toBe(true);
    });
  });
});

describe("CommunicationsScreen — stuck-erasure cleanup digest toggle (Task #1769)", () => {
  // Mirrors the web-portal test
  // (`artifacts/kharagolf-web/src/tests/portal-comm-prefs-erasure-storage-digest.test.tsx`):
  // hydrate the toggle from GET, flip it, assert the PATCH body matches
  // the new field, and confirm the optimistic UI lands. The mobile screen
  // doesn't gate the row on role (matching how the rest of this screen
  // renders the existing controller-flavoured rows for everyone), so
  // there's no role-based assertion to mirror.

  it("hydrates the switch from notifyErasureStorageDigest=true → ON", async () => {
    serverNotifPrefs = { notifySideGameReceipts: true, notifyErasureStorageDigest: true };

    render(<CommunicationsScreen />);

    const toggle = await screen.findByTestId("switch-notify-erasure-storage-digest");
    const checkbox = toggle.querySelector("input[type='checkbox']") as HTMLInputElement | null;
    expect(checkbox).not.toBeNull();
    await waitFor(() => expect(checkbox!.checked).toBe(true));
  });

  it("hydrates the switch from notifyErasureStorageDigest=false → OFF", async () => {
    serverNotifPrefs = { notifySideGameReceipts: true, notifyErasureStorageDigest: false };

    render(<CommunicationsScreen />);

    const toggle = await screen.findByTestId("switch-notify-erasure-storage-digest");
    const checkbox = toggle.querySelector("input[type='checkbox']") as HTMLInputElement | null;
    expect(checkbox).not.toBeNull();
    await waitFor(() => expect(checkbox!.checked).toBe(false));
  });

  it("toggling the switch off PATCHes notifyErasureStorageDigest=false and reflects the new state", async () => {
    serverNotifPrefs = { notifySideGameReceipts: true, notifyErasureStorageDigest: true };

    render(<CommunicationsScreen />);

    const toggle = await screen.findByTestId("switch-notify-erasure-storage-digest");
    const checkbox = toggle.querySelector("input[type='checkbox']") as HTMLInputElement;
    await waitFor(() => expect(checkbox.checked).toBe(true));

    await act(async () => {
      fireEvent.click(checkbox);
    });

    await waitFor(() => {
      const patchCalls = fetchMock.mock.calls.filter(
        c => String(c[0]).includes("/api/portal/notification-preferences") && (c[1]?.method ?? "GET") === "PATCH",
      );
      expect(patchCalls.length).toBe(1);
    });

    const patchCall = fetchMock.mock.calls.find(
      c => String(c[0]).includes("/api/portal/notification-preferences") && (c[1]?.method ?? "GET") === "PATCH",
    )!;
    const body = JSON.parse(String((patchCall[1] as RequestInit).body)) as Record<string, unknown>;
    expect(body).toEqual({ notifyErasureStorageDigest: false });

    // Optimistic UI: the switch flips immediately without waiting for a re-fetch.
    await waitFor(() => {
      const refreshed = screen.getByTestId("switch-notify-erasure-storage-digest");
      const cb = refreshed.querySelector("input[type='checkbox']") as HTMLInputElement;
      expect(cb.checked).toBe(false);
    });

    // Sanity: the unrelated sibling toggle isn't touched by the PATCH.
    const sideGame = screen.getByTestId("switch-notify-side-game-receipts");
    const sideGameCb = sideGame.querySelector("input[type='checkbox']") as HTMLInputElement;
    expect(sideGameCb.checked).toBe(true);
  });

  it("toggling the switch back on PATCHes notifyErasureStorageDigest=true", async () => {
    serverNotifPrefs = { notifySideGameReceipts: true, notifyErasureStorageDigest: false };

    render(<CommunicationsScreen />);

    const toggle = await screen.findByTestId("switch-notify-erasure-storage-digest");
    const checkbox = toggle.querySelector("input[type='checkbox']") as HTMLInputElement;
    await waitFor(() => expect(checkbox.checked).toBe(false));

    await act(async () => {
      fireEvent.click(checkbox);
    });

    await waitFor(() => {
      const patchCalls = fetchMock.mock.calls.filter(
        c => String(c[0]).includes("/api/portal/notification-preferences") && (c[1]?.method ?? "GET") === "PATCH",
      );
      expect(patchCalls.length).toBe(1);
    });

    const patchCall = fetchMock.mock.calls.find(
      c => String(c[0]).includes("/api/portal/notification-preferences") && (c[1]?.method ?? "GET") === "PATCH",
    )!;
    const body = JSON.parse(String((patchCall[1] as RequestInit).body)) as Record<string, unknown>;
    expect(body).toEqual({ notifyErasureStorageDigest: true });

    await waitFor(() => {
      const refreshed = screen.getByTestId("switch-notify-erasure-storage-digest");
      const cb = refreshed.querySelector("input[type='checkbox']") as HTMLInputElement;
      expect(cb.checked).toBe(true);
    });
  });
});

describe("CommunicationsScreen — stuck-erasure cleanup digest in-app/push toggle (Task #2205)", () => {
  // Mirrors the email-channel block above for the in-app/push half of the
  // controller-only stuck-erasure cleanup digest. The two channels are
  // independent: silencing one must not affect the other.

  it("hydrates the switch from notifyErasureStorageDigestPush=true → ON", async () => {
    serverNotifPrefs = { notifySideGameReceipts: true, notifyErasureStorageDigestPush: true };

    render(<CommunicationsScreen />);

    const toggle = await screen.findByTestId("switch-notify-erasure-storage-digest-push");
    const checkbox = toggle.querySelector("input[type='checkbox']") as HTMLInputElement | null;
    expect(checkbox).not.toBeNull();
    await waitFor(() => expect(checkbox!.checked).toBe(true));
  });

  it("hydrates the switch from notifyErasureStorageDigestPush=false → OFF", async () => {
    serverNotifPrefs = { notifySideGameReceipts: true, notifyErasureStorageDigestPush: false };

    render(<CommunicationsScreen />);

    const toggle = await screen.findByTestId("switch-notify-erasure-storage-digest-push");
    const checkbox = toggle.querySelector("input[type='checkbox']") as HTMLInputElement | null;
    expect(checkbox).not.toBeNull();
    await waitFor(() => expect(checkbox!.checked).toBe(false));
  });

  it("toggling the switch off PATCHes notifyErasureStorageDigestPush=false and reflects the new state", async () => {
    serverNotifPrefs = { notifySideGameReceipts: true, notifyErasureStorageDigestPush: true };

    render(<CommunicationsScreen />);

    const toggle = await screen.findByTestId("switch-notify-erasure-storage-digest-push");
    const checkbox = toggle.querySelector("input[type='checkbox']") as HTMLInputElement;
    await waitFor(() => expect(checkbox.checked).toBe(true));

    await act(async () => {
      fireEvent.click(checkbox);
    });

    await waitFor(() => {
      const patchCalls = fetchMock.mock.calls.filter(
        c => String(c[0]).includes("/api/portal/notification-preferences") && (c[1]?.method ?? "GET") === "PATCH",
      );
      expect(patchCalls.length).toBe(1);
    });

    const patchCall = fetchMock.mock.calls.find(
      c => String(c[0]).includes("/api/portal/notification-preferences") && (c[1]?.method ?? "GET") === "PATCH",
    )!;
    const body = JSON.parse(String((patchCall[1] as RequestInit).body)) as Record<string, unknown>;
    expect(body).toEqual({ notifyErasureStorageDigestPush: false });

    await waitFor(() => {
      const refreshed = screen.getByTestId("switch-notify-erasure-storage-digest-push");
      const cb = refreshed.querySelector("input[type='checkbox']") as HTMLInputElement;
      expect(cb.checked).toBe(false);
    });

    // Sanity: the unrelated sibling toggle isn't touched by the PATCH.
    const sideGame = screen.getByTestId("switch-notify-side-game-receipts");
    const sideGameCb = sideGame.querySelector("input[type='checkbox']") as HTMLInputElement;
    expect(sideGameCb.checked).toBe(true);
  });

  it("toggling the switch back on PATCHes notifyErasureStorageDigestPush=true", async () => {
    serverNotifPrefs = { notifySideGameReceipts: true, notifyErasureStorageDigestPush: false };

    render(<CommunicationsScreen />);

    const toggle = await screen.findByTestId("switch-notify-erasure-storage-digest-push");
    const checkbox = toggle.querySelector("input[type='checkbox']") as HTMLInputElement;
    await waitFor(() => expect(checkbox.checked).toBe(false));

    await act(async () => {
      fireEvent.click(checkbox);
    });

    await waitFor(() => {
      const patchCalls = fetchMock.mock.calls.filter(
        c => String(c[0]).includes("/api/portal/notification-preferences") && (c[1]?.method ?? "GET") === "PATCH",
      );
      expect(patchCalls.length).toBe(1);
    });

    const patchCall = fetchMock.mock.calls.find(
      c => String(c[0]).includes("/api/portal/notification-preferences") && (c[1]?.method ?? "GET") === "PATCH",
    )!;
    const body = JSON.parse(String((patchCall[1] as RequestInit).body)) as Record<string, unknown>;
    expect(body).toEqual({ notifyErasureStorageDigestPush: true });

    await waitFor(() => {
      const refreshed = screen.getByTestId("switch-notify-erasure-storage-digest-push");
      const cb = refreshed.querySelector("input[type='checkbox']") as HTMLInputElement;
      expect(cb.checked).toBe(true);
    });
  });
});
