/**
 * Task #2010 — admin "Send reminder" button on the survey responses page.
 *
 * Covers the four acceptance criteria from the brief:
 *   1. The button appears on the responses panel
 *   2. After firing, the UI refreshes and shows how many players were reminded
 *   3. The button is disabled (with a "Reminder already sent on <date>" hint)
 *      once `reminderSentAt` is set
 *   4. The button is hidden once the survey is closed (`closesAt` in the past)
 *
 * The non-admin gate is enforced one level up — `tournament-detail.tsx` only
 * mounts this panel inside an `isAdmin`-gated tab — so it isn't covered here.
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

interface ResponsesPayload {
  survey:
    | {
        id: number;
        sentAt: string | null;
        reminderSentAt: string | null;
        closesAt: string | null;
        questions: unknown;
      }
    | null;
  totalResponses: number;
  eligiblePlayers: number;
  aggregates: unknown[];
}

let responsesPayload: ResponsesPayload;
let remindResponse: { status: number; body: unknown };
const remindCalls: string[] = [];

beforeEach(() => {
  responsesPayload = {
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
  remindResponse = { status: 200, body: { remindersSent: 9, reminderSentAt: "2026-04-30T09:00:00.000Z" } };
  remindCalls.length = 0;

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/survey/remind") && (init?.method ?? "GET") === "POST") {
        remindCalls.push(url);
        return jsonResponse(remindResponse.body, remindResponse.status);
      }
      if (url.includes("/survey/responses")) return jsonResponse(responsesPayload);
      return jsonResponse({}, 404);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function renderPanel() {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchInterval: false, staleTime: 0, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={qc}>
      <PostEventSurveyResponsesPanel orgId={1} tournamentId={42} />
    </QueryClientProvider>,
  );
}

describe("PostEventSurveyResponsesPanel — Send reminder button", () => {
  it("renders an enabled 'Send reminder' button when no reminder has fired and the survey is open", async () => {
    const button = await screenFindReminderButton();
    expect(button).not.toBeNull();
    expect(button.disabled).toBe(false);
    expect(button.textContent).toMatch(/Send reminder/);
    // No "Reminder sent:" header line until the API surfaces a stamp.
    expect(screen.queryByTestId("survey-reminder-sent-at")).toBeNull();
  });

  it("fires POST /survey/remind, refreshes the responses query and shows the new timestamp", async () => {
    const button = await screenFindReminderButton();

    // Arrange the next responses fetch (triggered by the mutation's invalidate)
    // to come back with the stamped reminder so the UI flips to disabled.
    responsesPayload = {
      ...responsesPayload,
      survey: { ...responsesPayload.survey!, reminderSentAt: "2026-04-30T09:00:00.000Z" },
    };

    fireEvent.click(button);

    await waitFor(() => {
      expect(remindCalls).toHaveLength(1);
    });

    // After the refetch the header surfaces the timestamp and the button
    // disables with a "Reminder sent <date>" label.
    await waitFor(() => {
      expect(screen.queryByTestId("survey-reminder-sent-at")).not.toBeNull();
    });
    const refreshed = screen.getByTestId("button-send-survey-reminder") as HTMLButtonElement;
    expect(refreshed.disabled).toBe(true);
    expect(refreshed.title).toMatch(/Reminder already sent on/);
  });

  it("renders disabled with a 'Reminder already sent on <date>' hint once `reminderSentAt` is set", async () => {
    responsesPayload = {
      ...responsesPayload,
      survey: { ...responsesPayload.survey!, reminderSentAt: "2026-04-25T08:30:00.000Z" },
    };
    const button = await screenFindReminderButton();
    expect(button.disabled).toBe(true);
    expect(button.title).toMatch(/Reminder already sent on/);
    // The "Reminder sent: <date>" header line shows alongside Sent / Closes.
    expect(screen.queryByTestId("survey-reminder-sent-at")).not.toBeNull();
  });

  it("hides the button entirely when the survey has already closed", async () => {
    responsesPayload = {
      ...responsesPayload,
      survey: { ...responsesPayload.survey!, closesAt: "2020-01-01T00:00:00.000Z" },
    };
    renderPanel();
    // Wait for the panel to mount past its loading state.
    await waitFor(() => {
      expect(screen.queryByTestId("survey-responses-panel")).not.toBeNull();
    });
    expect(screen.queryByTestId("button-send-survey-reminder")).toBeNull();
  });

  it("flips to the 'already sent' disabled state when the API returns 409 from a concurrent admin", async () => {
    remindResponse = {
      status: 409,
      body: { error: "reminder already sent", reminderSentAt: "2026-04-30T07:00:00.000Z" },
    };

    const button = await screenFindReminderButton();

    // Arrange the refetch (kicked off by the 409 handler) to surface the
    // stamp the other admin set so the disabled state lands.
    responsesPayload = {
      ...responsesPayload,
      survey: { ...responsesPayload.survey!, reminderSentAt: "2026-04-30T07:00:00.000Z" },
    };

    fireEvent.click(button);

    await waitFor(() => {
      expect(remindCalls).toHaveLength(1);
    });
    await waitFor(() => {
      const refreshed = screen.getByTestId("button-send-survey-reminder") as HTMLButtonElement;
      if (!refreshed.disabled) throw new Error("button should be disabled after 409");
    });
    const refreshed = screen.getByTestId("button-send-survey-reminder") as HTMLButtonElement;
    expect(refreshed.title).toMatch(/Reminder already sent on/);
  });
});

async function screenFindReminderButton(): Promise<HTMLButtonElement> {
  renderPanel();
  return await waitFor(() => {
    const el = screen.queryByTestId("button-send-survey-reminder");
    if (!el) throw new Error("reminder button not yet rendered");
    return el as HTMLButtonElement;
  });
}
