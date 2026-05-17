/**
 * Task #1361 — Verifies the audit page seeds its key filter from the
 * `?key=` URL query param so other admin surfaces (notification template
 * registry in admin.tsx, etc.) can deep-link straight into the dispatch
 * history for one notification key.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";

import NotificationAuditPage from "../notification-audit";

interface FetchCall { url: string }
let fetchCalls: FetchCall[];
let meRole: string | null;

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve({
    ok: status < 400,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response);
}

const AUDIT_BODY = {
  entries: [
    {
      id: 1,
      notificationKey: "handicap.committee.changed",
      userId: 42,
      userDisplayName: "Player A",
      username: "playerA",
      userEmail: "a@example.com",
      channel: "email",
      status: "sent",
      reason: null,
      payload: { hello: "world" },
      createdAt: "2026-04-20T10:00:00.000Z",
    },
  ],
  total: 1,
  page: 1,
  limit: 50,
  facets: {
    keys: ["handicap.committee.changed", "course.correction.resolved"],
    channels: ["email"],
    statuses: ["sent"],
  },
};

beforeEach(() => {
  fetchCalls = [];
  meRole = "org_admin";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      fetchCalls.push({ url });
      if (url.endsWith("/api/auth/me")) {
        if (meRole == null) return jsonResponse({ error: "Unauthorized" }, 401);
        return jsonResponse({ role: meRole });
      }
      if (url.startsWith("/api/admin/notification-audit")) {
        return jsonResponse(AUDIT_BODY);
      }
      return jsonResponse({}, 404);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function renderPage(path: string, searchPath: string) {
  const { hook, searchHook } = memoryLocation({ path, searchPath });
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchInterval: false, staleTime: 0 },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={qc}>
      <Router hook={hook} searchHook={searchHook}>
        <NotificationAuditPage />
      </Router>
    </QueryClientProvider>,
  );
}

describe("NotificationAuditPage deep-link (?key=)", () => {
  it("seeds the key filter from ?key= and includes it in the audit request", async () => {
    renderPage("/admin/notification-audit", "key=handicap.committee.changed");

    // The audit fetch should fire with the deep-linked key already
    // applied as a filter — admins shouldn't have to re-pick from the
    // dropdown after navigating from the registry.
    await waitFor(() => {
      const auditCall = fetchCalls.find(c =>
        c.url.startsWith("/api/admin/notification-audit?")
        && c.url.includes("key=handicap.committee.changed"),
      );
      expect(auditCall).toBeTruthy();
    });

    // And the page should actually render the matching row.
    await waitFor(() => {
      expect(screen.getByTestId("audit-row-1")).toBeTruthy();
    });
  });

  it("falls back to no key filter when ?key= is absent", async () => {
    renderPage("/admin/notification-audit", "");

    await waitFor(() => {
      // First admin call must be made.
      const auditCall = fetchCalls.find(c =>
        c.url.startsWith("/api/admin/notification-audit?"),
      );
      expect(auditCall).toBeTruthy();
      // …and must NOT include a key filter.
      expect(auditCall!.url).not.toContain("key=");
    });
  });
});
