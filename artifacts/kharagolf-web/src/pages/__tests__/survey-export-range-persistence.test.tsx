/**
 * Task #2029 — remember the admin's last-used export date range per
 * tournament so admins exporting "last week's responses" for a recurring
 * committee meeting don't have to re-pick the dates on every visit.
 *
 * Acceptance criteria:
 *   1. After picking a range, the same range is pre-filled the next time the
 *      panel mounts for that tournament (persisted in localStorage).
 *   2. The storage key is scoped per tournament so different events do not
 *      bleed into each other.
 *   3. A small "Clear" button resets both pickers and removes the saved value.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { PostEventSurveyResponsesPanel } from "../tournament-detail";

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve({
    ok: status < 400,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response);
}

const responsesPayload = {
  survey: {
    id: 7,
    sentAt: "2026-04-20T10:00:00.000Z",
    reminderSentAt: null,
    closesAt: "2026-12-31T23:59:00.000Z",
    questions: [],
  },
  totalResponses: 3,
  eligiblePlayers: 12,
  aggregates: [],
};

beforeEach(() => {
  window.localStorage.clear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/survey/responses")) return jsonResponse(responsesPayload);
      return jsonResponse({}, 404);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

function renderPanel(props: { orgId: number; tournamentId: number }) {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchInterval: false, staleTime: 0, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={qc}>
      <PostEventSurveyResponsesPanel {...props} />
    </QueryClientProvider>,
  );
}

async function waitForPanel() {
  await waitFor(() => {
    if (!screen.queryByTestId("survey-responses-panel")) {
      throw new Error("panel not yet rendered");
    }
  });
}

describe("PostEventSurveyResponsesPanel — export date range persistence", () => {
  it("re-hydrates the From/To pickers from localStorage on the next mount", async () => {
    // First mount — admin enters a range.
    const first = renderPanel({ orgId: 1, tournamentId: 42 });
    await waitForPanel();
    const fromA = screen.getByTestId("input-export-from") as HTMLInputElement;
    const toA = screen.getByTestId("input-export-to") as HTMLInputElement;
    fireEvent.change(fromA, { target: { value: "2026-04-20" } });
    fireEvent.change(toA, { target: { value: "2026-04-27" } });

    await waitFor(() => {
      const raw = window.localStorage.getItem("tournament-detail.exportRange.1.42");
      if (!raw) throw new Error("range not yet persisted");
      expect(JSON.parse(raw)).toEqual({ from: "2026-04-20", to: "2026-04-27" });
    });

    first.unmount();

    // Second mount — same tournament — pickers come back pre-filled.
    renderPanel({ orgId: 1, tournamentId: 42 });
    await waitForPanel();
    const fromB = screen.getByTestId("input-export-from") as HTMLInputElement;
    const toB = screen.getByTestId("input-export-to") as HTMLInputElement;
    expect(fromB.value).toBe("2026-04-20");
    expect(toB.value).toBe("2026-04-27");
  });

  it("scopes the saved range per tournament so other events stay empty", async () => {
    // Tournament 42 — set a range.
    const first = renderPanel({ orgId: 1, tournamentId: 42 });
    await waitForPanel();
    fireEvent.change(screen.getByTestId("input-export-from"), { target: { value: "2026-04-20" } });
    fireEvent.change(screen.getByTestId("input-export-to"), { target: { value: "2026-04-27" } });
    await waitFor(() => {
      if (!window.localStorage.getItem("tournament-detail.exportRange.1.42")) {
        throw new Error("range not yet persisted");
      }
    });
    first.unmount();

    // Tournament 99 — pickers are empty, the other event's value is untouched.
    renderPanel({ orgId: 1, tournamentId: 99 });
    await waitForPanel();
    const fromOther = screen.getByTestId("input-export-from") as HTMLInputElement;
    const toOther = screen.getByTestId("input-export-to") as HTMLInputElement;
    expect(fromOther.value).toBe("");
    expect(toOther.value).toBe("");
    expect(window.localStorage.getItem("tournament-detail.exportRange.1.99")).toBeNull();
    // The originally-saved range still exists for tournament 42.
    expect(window.localStorage.getItem("tournament-detail.exportRange.1.42")).not.toBeNull();
  });

  it("hides the Clear button until a date is set, then clears both pickers and storage", async () => {
    renderPanel({ orgId: 1, tournamentId: 42 });
    await waitForPanel();

    // No dates set yet → no Clear button.
    expect(screen.queryByTestId("button-clear-export-range")).toBeNull();

    fireEvent.change(screen.getByTestId("input-export-from"), { target: { value: "2026-04-20" } });
    fireEvent.change(screen.getByTestId("input-export-to"), { target: { value: "2026-04-27" } });

    const clearBtn = await waitFor(() => {
      const el = screen.queryByTestId("button-clear-export-range");
      if (!el) throw new Error("clear button not yet rendered");
      return el as HTMLButtonElement;
    });

    fireEvent.click(clearBtn);

    const fromAfter = screen.getByTestId("input-export-from") as HTMLInputElement;
    const toAfter = screen.getByTestId("input-export-to") as HTMLInputElement;
    expect(fromAfter.value).toBe("");
    expect(toAfter.value).toBe("");
    expect(window.localStorage.getItem("tournament-detail.exportRange.1.42")).toBeNull();
    // Clear button hides itself again once both pickers are empty.
    await waitFor(() => {
      expect(screen.queryByTestId("button-clear-export-range")).toBeNull();
    });
  });
});
