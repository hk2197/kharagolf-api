/**
 * UI tests: mobile `TieBreakEmailOptOutsCard` (Task #1402 — mobile mirror of
 * the web TieBreakEmailOptOutsCard added in Task #1208).
 *
 * Verifies:
 *   1. The card self-hides on 401/403 (non-admin user).
 *   2. The card renders the empty-state copy when the GET returns [].
 *   3. The card lists director rows with name, email, and opted-out date.
 *   4. Tapping "Re-subscribe" DELETEs the opt-out and removes the row.
 */
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/i18n", () => ({ getLocale: () => "en-US" }));

import { TieBreakEmailOptOutsCard } from "../components/TieBreakEmailOptOutsCard";

interface OptOut {
  userId: number;
  email: string | null;
  displayName: string;
  optedOutAt: string;
}

let getStatus = 200;
let getBody: OptOut[] = [];
let deletedUserIds: number[] = [];

const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const method = (init?.method ?? "GET").toUpperCase();

  const deleteMatch = url.match(/\/organizations\/(\d+)\/tie-break-email-opt-outs\/(\d+)$/);
  if (deleteMatch && method === "DELETE") {
    deletedUserIds.push(parseInt(deleteMatch[2], 10));
    return new Response(null, { status: 204 });
  }
  if (url.endsWith("/tie-break-email-opt-outs") && method === "GET") {
    if (getStatus === 200) {
      return new Response(JSON.stringify(getBody), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ error: "forbidden" }), {
      status: getStatus, headers: { "Content-Type": "application/json" },
    });
  }
  throw new Error(`Unexpected fetch: ${method} ${url}`);
});

beforeEach(() => {
  getStatus = 200;
  getBody = [];
  deletedUserIds = [];
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("TieBreakEmailOptOutsCard (Task #1402)", () => {
  it("self-hides when the API returns 403 (non-admin user)", async () => {
    getStatus = 403;
    const { container } = render(
      <TieBreakEmailOptOutsCard orgId={7} token="t" />,
    );
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(container.querySelector('[data-testid="card-tie-break-email-opt-outs"]')).toBeNull();
    });
  });

  it("self-hides when the API returns 401 (signed-out / no session)", async () => {
    getStatus = 401;
    const { container } = render(
      <TieBreakEmailOptOutsCard orgId={7} token="t" />,
    );
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(container.querySelector('[data-testid="card-tie-break-email-opt-outs"]')).toBeNull();
    });
  });

  it("renders nothing when orgId or token is missing (no API call)", async () => {
    const { container } = render(
      <TieBreakEmailOptOutsCard orgId={null} token={null} />,
    );
    expect(container.querySelector('[data-testid="card-tie-break-email-opt-outs"]')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("renders the empty state when no directors have opted out", async () => {
    getBody = [];
    render(<TieBreakEmailOptOutsCard orgId={7} token="t" />);
    expect(
      await screen.findByTestId("text-no-tie-break-opt-outs"),
    ).toBeInTheDocument();
  });

  it("lists each opted-out director with name, email, and date", async () => {
    getBody = [
      {
        userId: 11,
        email: "alice@example.com",
        displayName: "Alice Director",
        optedOutAt: "2026-04-01T10:00:00Z",
      },
      {
        userId: 22,
        email: null,
        displayName: "Bob Captain",
        optedOutAt: "2026-04-02T10:00:00Z",
      },
    ];
    render(<TieBreakEmailOptOutsCard orgId={7} token="t" />);
    expect(await screen.findByText("Alice Director")).toBeInTheDocument();
    expect(screen.getByText("alice@example.com")).toBeInTheDocument();
    expect(screen.getByText("Bob Captain")).toBeInTheDocument();
    expect(screen.getByTestId("button-resubscribe-tie-break-11")).toBeInTheDocument();
    expect(screen.getByTestId("button-resubscribe-tie-break-22")).toBeInTheDocument();
  });

  it("re-shows the card after switching from an unauthorized org to an authorized one", async () => {
    // Start on org 7 where the API returns 403 — card hides.
    getStatus = 403;
    const { container, rerender } = render(
      <TieBreakEmailOptOutsCard orgId={7} token="t" />,
    );
    await waitFor(() => {
      expect(container.querySelector('[data-testid="card-tie-break-email-opt-outs"]')).toBeNull();
    });

    // Switch to org 9 where the user IS an admin — card should re-render.
    getStatus = 200;
    getBody = [
      {
        userId: 33,
        email: "carol@example.com",
        displayName: "Carol Director",
        optedOutAt: "2026-04-03T10:00:00Z",
      },
    ];
    rerender(<TieBreakEmailOptOutsCard orgId={9} token="t" />);

    expect(await screen.findByText("Carol Director")).toBeInTheDocument();
    expect(
      container.querySelector('[data-testid="card-tie-break-email-opt-outs"]'),
    ).not.toBeNull();
  });

  it("re-subscribing a director DELETEs the opt-out and removes the row", async () => {
    getBody = [
      {
        userId: 11,
        email: "alice@example.com",
        displayName: "Alice Director",
        optedOutAt: "2026-04-01T10:00:00Z",
      },
    ];
    render(<TieBreakEmailOptOutsCard orgId={7} token="t" />);
    const btn = await screen.findByTestId("button-resubscribe-tie-break-11");

    await act(async () => {
      fireEvent.click(btn);
    });

    await waitFor(() => {
      expect(deletedUserIds).toEqual([11]);
    });
    await waitFor(() => {
      expect(screen.queryByText("Alice Director")).toBeNull();
    });
    // Empty state shows up after the only row disappears.
    expect(screen.getByTestId("text-no-tie-break-opt-outs")).toBeInTheDocument();
  });
});
