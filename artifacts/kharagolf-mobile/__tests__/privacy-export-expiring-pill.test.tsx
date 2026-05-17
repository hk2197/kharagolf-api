/**
 * Component test for Task #1077 — the mobile member privacy screen should
 * render an "Export expiring soon" pill on any open data request whose
 * lastNotificationKind = 'export_expiring' (mirroring the controller-dashboard
 * + member-360 web badge added in Task #922).
 *
 * Tapping the pill opens an Alert that surfaces the resend-history /
 * download-link affordances (Resend reminder + Download archive).
 */
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, cleanup } from "@testing-library/react";
import { Alert } from "react-native";

vi.mock("@/context/auth", () => ({
  useAuth: () => ({ token: "test-token", user: { id: 1 }, isAuthenticated: true, isLoading: false }),
}));

vi.mock("expo-file-system/legacy", () => ({
  cacheDirectory: "/tmp/",
  downloadAsync: vi.fn(async () => ({ status: 200, uri: "/tmp/x.json" })),
}));

vi.mock("expo-sharing", () => ({
  isAvailableAsync: vi.fn(async () => false),
  shareAsync: vi.fn(),
}));

import PrivacyScreen from "../app/my-360/privacy";

interface DataRequestRow {
  id: number;
  requestType: string;
  status: string;
  requestedAt: string;
  dueBy: string | null;
  resolvedAt: string | null;
  notes: string | null;
  artifactUrl: string | null;
  lastNotificationKind: string | null;
  lastNotifiedAt: string | null;
  lastEmailStatus: string | null;
  lastEmailAt: string | null;
  lastInAppMessageId: number | null;
  lastInAppAt: string | null;
  lastPushStatus: string | null;
  lastPushAt: string | null;
  lastSmsStatus: string | null;
  lastSmsAt: string | null;
}

let requestsResponse: DataRequestRow[] = [];
let exportsResponse: {
  exports: Array<{
    id: number;
    status: string;
    requestedAt: string;
    resolvedAt: string | null;
    artifactUrl: string | null;
    computedStatus: "pending" | "ready" | "expired" | "failed";
    expiresAt: string | null;
    purgedAt: string | null;
    downloadUrl: string | null;
    signedUrlEndpoint: string | null;
  }>;
  validForDays: number;
  auditEntries?: unknown[];
} = { exports: [], validForDays: 7 };

function installFetch() {
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.includes("/api/portal/my-data-requests") && method === "GET") {
      return new Response(JSON.stringify(requestsResponse), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("/api/portal/my-account-deletion") && method === "GET") {
      return new Response(JSON.stringify({ pending: null, gracePeriodDays: 30, gracePeriodEndsAt: null, canCancel: false }), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("/api/portal/my-data-export") && method === "GET") {
      return new Response(JSON.stringify(exportsResponse), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("/api/portal/my-data-requests/") && url.endsWith("/resend") || url.includes("/resend?")) {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  });
  vi.stubGlobal("fetch", mock as unknown as typeof fetch);
  return mock;
}

function makeRequest(overrides: Partial<DataRequestRow> = {}): DataRequestRow {
  return {
    id: 1,
    requestType: "access",
    status: "in_progress",
    requestedAt: "2026-04-20T12:00:00.000Z",
    dueBy: null,
    resolvedAt: null,
    notes: null,
    artifactUrl: null,
    lastNotificationKind: null,
    lastNotifiedAt: null,
    lastEmailStatus: null,
    lastEmailAt: null,
    lastInAppMessageId: null,
    lastInAppAt: null,
    lastPushStatus: null,
    lastPushAt: null,
    lastSmsStatus: null,
    lastSmsAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  requestsResponse = [];
  exportsResponse = { exports: [], validForDays: 7 };
  installFetch();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("<PrivacyScreen /> — Export expiring pill (Task #1077)", () => {
  it("renders the pill only on requests whose lastNotificationKind is export_expiring", async () => {
    requestsResponse = [
      makeRequest({ id: 1, lastNotificationKind: "filed" }),
      makeRequest({ id: 2, lastNotificationKind: "export_expiring", lastNotifiedAt: "2026-04-22T10:00:00.000Z" }),
      makeRequest({ id: 3, lastNotificationKind: "completed_export" }),
      makeRequest({ id: 4, lastNotificationKind: null }),
    ];

    render(<PrivacyScreen />);

    await waitFor(() =>
      expect(screen.getByTestId("data-request-export-expiring-pill-2")).toBeInTheDocument(),
    );
    expect(screen.queryByTestId("data-request-export-expiring-pill-1")).toBeNull();
    expect(screen.queryByTestId("data-request-export-expiring-pill-3")).toBeNull();
    expect(screen.queryByTestId("data-request-export-expiring-pill-4")).toBeNull();
    expect(screen.getByTestId("data-request-export-expiring-pill-2"))
      .toHaveTextContent(/Export expiring soon/i);
  });

  it("offers Resend + Download affordances when a ready export exists", async () => {
    requestsResponse = [
      makeRequest({ id: 7, lastNotificationKind: "export_expiring", lastNotifiedAt: "2026-04-22T10:00:00.000Z" }),
    ];
    exportsResponse = {
      exports: [{
        id: 99,
        status: "ready",
        requestedAt: "2026-04-15T10:00:00.000Z",
        resolvedAt: "2026-04-15T10:05:00.000Z",
        artifactUrl: "/objects/exports/99.json",
        computedStatus: "ready",
        expiresAt: "2026-04-25T10:00:00.000Z",
        purgedAt: null,
        downloadUrl: "/api/portal/my-data-export/99/download",
        signedUrlEndpoint: "/api/portal/my-data-export/99/signed-url",
      }],
      validForDays: 7,
    };

    const alertSpy = vi.spyOn(Alert, "alert").mockImplementation(() => {});
    render(<PrivacyScreen />);

    const pill = await screen.findByTestId("data-request-export-expiring-pill-7");
    await act(async () => { fireEvent.click(pill); });

    await waitFor(() => expect(alertSpy).toHaveBeenCalled());
    const [title, , buttons] = alertSpy.mock.calls[0] as [string, string, Array<{ text: string }>];
    expect(title).toMatch(/Export expiring soon/i);
    const labels = buttons.map(b => b.text);
    expect(labels).toEqual(expect.arrayContaining(["Close", "Resend reminder", "Download archive"]));
  });

  it("omits Download when no ready export is available", async () => {
    requestsResponse = [
      makeRequest({ id: 8, lastNotificationKind: "export_expiring" }),
    ];
    exportsResponse = { exports: [], validForDays: 7 };

    const alertSpy = vi.spyOn(Alert, "alert").mockImplementation(() => {});
    render(<PrivacyScreen />);

    const pill = await screen.findByTestId("data-request-export-expiring-pill-8");
    await act(async () => { fireEvent.click(pill); });

    await waitFor(() => expect(alertSpy).toHaveBeenCalled());
    const [, , buttons] = alertSpy.mock.calls[0] as [string, string, Array<{ text: string }>];
    const labels = buttons.map(b => b.text);
    expect(labels).toEqual(["Close", "Resend reminder"]);
  });
});
