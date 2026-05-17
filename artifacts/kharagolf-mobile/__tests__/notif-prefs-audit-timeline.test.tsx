/**
 * UI tests: mobile `NotifPrefsAuditTimeline` + `MemberCommPrefsHistoryCard`
 * (Task #1853 — mobile mirror of the web `NotifPrefsAuditTimeline` rendered
 * in the Players page expanded row, Task #1505).
 *
 * Verifies:
 *   1. Timeline self-hides on 401/403 (defense-in-depth gate).
 *   2. Timeline renders the empty-state copy when the audit log is empty.
 *   3. Timeline lists each entry with its field-level diff, actor, and date.
 *   4. Picker card self-hides on 401/403 from the members listing.
 *   5. Picker card lets admin filter members and tap one to load the
 *      timeline for that member.
 */
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { NotifPrefsAuditTimeline } from "../components/NotifPrefsAuditTimeline";
import { MemberCommPrefsHistoryCard } from "../components/MemberCommPrefsHistoryCard";

interface AuditEntry {
  id: number;
  createdAt: string;
  actorUserId: number | null;
  actorName: string | null;
  actorRole: string | null;
  entity: string;
  entityId: number;
  action: string;
  fieldChanges: Record<string, { from: unknown; to: unknown }> | null;
  reason: string | null;
  metadata: unknown;
}

interface OrgMember {
  userId: number;
  displayName: string | null;
  username: string;
  email: string | null;
  role: string;
}

let auditStatus = 200;
let auditBody: { entries: AuditEntry[]; limit: number } = { entries: [], limit: 20 };
let membersStatus = 200;
let membersBody: OrgMember[] = [];

const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const method = (init?.method ?? "GET").toUpperCase();

  if (url.includes("/audit-log") && method === "GET") {
    if (auditStatus === 200) {
      return new Response(JSON.stringify(auditBody), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ error: "forbidden" }), {
      status: auditStatus, headers: { "Content-Type": "application/json" },
    });
  }
  if (/\/organizations\/\d+\/members$/.test(url) && method === "GET") {
    if (membersStatus === 200) {
      return new Response(JSON.stringify(membersBody), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ error: "forbidden" }), {
      status: membersStatus, headers: { "Content-Type": "application/json" },
    });
  }
  throw new Error(`Unexpected fetch: ${method} ${url}`);
});

beforeEach(() => {
  auditStatus = 200;
  auditBody = { entries: [], limit: 20 };
  membersStatus = 200;
  membersBody = [];
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("NotifPrefsAuditTimeline (Task #1853)", () => {
  it("self-hides when the API returns 403 (non-admin user)", async () => {
    auditStatus = 403;
    const { container } = render(
      <NotifPrefsAuditTimeline orgId={7} userId={11} token="t" />,
    );
    await waitFor(() => { expect(fetchMock).toHaveBeenCalled(); });
    await waitFor(() => {
      expect(container.querySelector('[data-testid="comm-prefs-audit-11"]')).toBeNull();
    });
  });

  it("self-hides when the API returns 401 (signed-out / no session)", async () => {
    auditStatus = 401;
    const { container } = render(
      <NotifPrefsAuditTimeline orgId={7} userId={11} token="t" />,
    );
    await waitFor(() => { expect(fetchMock).toHaveBeenCalled(); });
    await waitFor(() => {
      expect(container.querySelector('[data-testid="comm-prefs-audit-11"]')).toBeNull();
    });
  });

  it("renders nothing when orgId, userId, or token is missing", async () => {
    const { container } = render(
      <NotifPrefsAuditTimeline orgId={null} userId={11} token="t" />,
    );
    expect(container.querySelector('[data-testid="comm-prefs-audit-11"]')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("renders the empty-state copy when no audit rows exist", async () => {
    auditBody = { entries: [], limit: 20 };
    render(<NotifPrefsAuditTimeline orgId={7} userId={11} token="t" />);
    expect(
      await screen.findByTestId("comm-prefs-audit-empty-11"),
    ).toBeInTheDocument();
  });

  it("renders the error-state copy when the API returns 5xx", async () => {
    auditStatus = 500;
    render(<NotifPrefsAuditTimeline orgId={7} userId={11} token="t" />);
    expect(
      await screen.findByTestId("comm-prefs-audit-error-11"),
    ).toBeInTheDocument();
  });

  it("ignores a slow stale response when userId changes mid-flight", async () => {
    // Drive the order in which the two in-flight requests resolve so the
    // FIRST userId's response arrives AFTER we've already swapped to the
    // second userId. Without the request-id guard, the first response
    // would clobber the second member's timeline — a real correctness
    // bug for an audit surface.
    const resolvers: Array<(body: { entries: AuditEntry[]; limit: number }) => void> = [];
    const slowFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const userIdMatch = url.match(/\/members\/(\d+)\/audit-log/);
      const uid = userIdMatch ? Number(userIdMatch[1]) : 0;
      return await new Promise<Response>((resolve) => {
        resolvers.push((body) => {
          resolve(new Response(JSON.stringify(body), {
            status: 200, headers: { "Content-Type": "application/json" },
          }));
        });
        // Tag the resolver with the userId so the test can address it.
        (resolvers[resolvers.length - 1] as unknown as { uid: number }).uid = uid;
      });
    });
    vi.stubGlobal("fetch", slowFetch as unknown as typeof fetch);

    const { rerender } = render(
      <NotifPrefsAuditTimeline orgId={7} userId={11} token="t" />,
    );
    await waitFor(() => { expect(slowFetch).toHaveBeenCalledTimes(1); });

    // Switch to userId=22 before the first response arrives.
    rerender(<NotifPrefsAuditTimeline orgId={7} userId={22} token="t" />);
    await waitFor(() => { expect(slowFetch).toHaveBeenCalledTimes(2); });

    // Now resolve the SECOND (current) request first with member 22's
    // timeline, then the STALE first request with member 11's timeline.
    // The stale response must NOT overwrite the visible timeline.
    const member22Body = {
      entries: [{
        id: 222, createdAt: "2026-04-15T10:00:00Z", actorUserId: 99,
        actorName: "A", actorRole: "org_admin", entity: "comm_prefs",
        entityId: 22, action: "updated",
        fieldChanges: { preferEmail: { from: true, to: false } },
        reason: null, metadata: null,
      }],
      limit: 20,
    };
    const member11Body = {
      entries: [{
        id: 111, createdAt: "2026-04-10T10:00:00Z", actorUserId: 99,
        actorName: "A", actorRole: "org_admin", entity: "comm_prefs",
        entityId: 11, action: "updated",
        fieldChanges: { preferEmail: { from: true, to: false } },
        reason: null, metadata: null,
      }],
      limit: 20,
    };
    await act(async () => { resolvers[1](member22Body); });
    await act(async () => { resolvers[0](member11Body); });

    expect(await screen.findByTestId("comm-prefs-audit-row-222")).toBeInTheDocument();
    expect(screen.queryByTestId("comm-prefs-audit-row-111")).toBeNull();
  });

  it("lists each audit entry with its field-level diff, actor, and date", async () => {
    auditBody = {
      entries: [
        {
          id: 901,
          createdAt: "2026-04-15T10:00:00Z",
          actorUserId: 99,
          actorName: "Alice Admin",
          actorRole: "org_admin",
          entity: "comm_prefs",
          entityId: 11,
          action: "updated",
          fieldChanges: {
            notifySideGameReceipts: { from: true, to: false },
          },
          reason: "Member called in",
          metadata: null,
        },
        {
          id: 902,
          createdAt: "2026-04-10T10:00:00Z",
          actorUserId: 99,
          actorName: "Alice Admin",
          actorRole: "org_admin",
          entity: "comm_prefs",
          entityId: 11,
          action: "updated",
          fieldChanges: {
            preferEmail: { from: true, to: false },
          },
          reason: null,
          metadata: null,
        },
      ],
      limit: 20,
    };
    render(<NotifPrefsAuditTimeline orgId={7} userId={11} token="t" />);
    expect(await screen.findByTestId("comm-prefs-audit-row-901")).toBeInTheDocument();
    expect(screen.getByTestId("comm-prefs-audit-row-902")).toBeInTheDocument();
    // Field labels are humanized, not raw column names.
    expect(screen.getByText(/Side-game receipts/i)).toBeInTheDocument();
    expect(screen.getByText(/Email channel/i)).toBeInTheDocument();
    // The reason is surfaced when present.
    expect(screen.getByText(/Member called in/)).toBeInTheDocument();
  });
});

describe("MemberCommPrefsHistoryCard (Task #1853)", () => {
  it("self-hides when the members API returns 403", async () => {
    membersStatus = 403;
    const { container } = render(
      <MemberCommPrefsHistoryCard orgId={7} token="t" />,
    );
    await waitFor(() => { expect(fetchMock).toHaveBeenCalled(); });
    await waitFor(() => {
      expect(container.querySelector('[data-testid="card-member-comm-prefs-history"]')).toBeNull();
    });
  });

  it("renders nothing when orgId or token is missing (no API call)", async () => {
    const { container } = render(
      <MemberCommPrefsHistoryCard orgId={null} token={null} />,
    );
    expect(container.querySelector('[data-testid="card-member-comm-prefs-history"]')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("loads the audit timeline when admin taps a member from the picker", async () => {
    membersBody = [
      { userId: 11, displayName: "Alice Member", username: "alice", email: "alice@example.com", role: "player" },
      { userId: 22, displayName: "Bob Member", username: "bob", email: "bob@example.com", role: "player" },
    ];
    auditBody = {
      entries: [
        {
          id: 555,
          createdAt: "2026-04-15T10:00:00Z",
          actorUserId: 99,
          actorName: "Alice Admin",
          actorRole: "org_admin",
          entity: "comm_prefs",
          entityId: 22,
          action: "updated",
          fieldChanges: { notifySideGameReceipts: { from: true, to: false } },
          reason: null,
          metadata: null,
        },
      ],
      limit: 20,
    };
    render(<MemberCommPrefsHistoryCard orgId={7} token="t" />);

    // Members list renders both rows once the listing resolves.
    expect(await screen.findByTestId("button-member-comm-prefs-pick-11")).toBeInTheDocument();
    const bobBtn = screen.getByTestId("button-member-comm-prefs-pick-22");

    await act(async () => { fireEvent.click(bobBtn); });

    // Tapping the row renders the timeline for that user, which in turn
    // fetches the audit log endpoint.
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([u]) => String(u).includes("/members/22/audit-log")),
      ).toBe(true);
    });
    expect(await screen.findByTestId("comm-prefs-audit-row-555")).toBeInTheDocument();
  });
});
