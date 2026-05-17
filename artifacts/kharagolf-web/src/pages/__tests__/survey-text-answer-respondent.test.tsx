/**
 * Task #2027 — survey "Survey responses" panel must show the respondent name
 * (or "Anonymous") next to each text answer so admins can follow up on a
 * specific comment without downloading the CSV.
 *
 * These tests pin:
 *   1. Named respondents render alongside the answer text & timestamp
 *   2. Anonymous respondents render with the literal "Anonymous" label
 *   3. The respondent label carries an aria-label for screen readers and a
 *      tooltip (`title`) for hover/tap context
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
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
  aggregates: Array<
    | {
        id: string;
        label: string;
        type: "text";
        count: number;
        answers: Array<{ text: string; respondent: string; submittedAt: string }>;
      }
  >;
}

let responsesPayload: ResponsesPayload;

beforeEach(() => {
  responsesPayload = {
    survey: {
      id: 7,
      sentAt: "2026-04-20T10:00:00.000Z",
      reminderSentAt: null,
      closesAt: "2026-12-31T23:59:00.000Z",
      questions: [],
    },
    totalResponses: 2,
    eligiblePlayers: 12,
    aggregates: [
      {
        id: "comments",
        label: "Any comments?",
        type: "text",
        count: 2,
        answers: [
          {
            text: "Greens were perfect, thanks!",
            respondent: "Sam Patel",
            submittedAt: "2026-04-21T09:00:00.000Z",
          },
          {
            text: "Bunkers needed raking on the back nine.",
            respondent: "Anonymous",
            submittedAt: "2026-04-21T11:30:00.000Z",
          },
        ],
      },
    ],
  };

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

describe("PostEventSurveyResponsesPanel — text-answer respondent label", () => {
  it("renders the respondent name next to a named text answer", async () => {
    renderPanel();
    await waitFor(() => {
      expect(screen.queryByTestId("text-answers-comments")).not.toBeNull();
    });
    const named = screen.getByTestId("text-answer-respondent-comments-0");
    expect(named.textContent).toBe("Sam Patel");
    expect(named.getAttribute("aria-label")).toBe("Respondent: Sam Patel");
    expect(named.getAttribute("title")).toBe("Submitted by Sam Patel");
  });

  it("renders 'Anonymous' (with an explanatory tooltip) for unlinked respondents", async () => {
    renderPanel();
    await waitFor(() => {
      expect(screen.queryByTestId("text-answers-comments")).not.toBeNull();
    });
    const anon = screen.getByTestId("text-answer-respondent-comments-1");
    expect(anon.textContent).toBe("Anonymous");
    expect(anon.getAttribute("aria-label")).toBe("Respondent: Anonymous");
    expect(anon.getAttribute("title")).toBe("Submitted without a linked account");
  });

  it("keeps the submitted-at timestamp alongside the respondent label", async () => {
    renderPanel();
    await waitFor(() => {
      expect(screen.queryByTestId("text-answers-comments")).not.toBeNull();
    });
    const meta = screen.getByTestId("text-answer-meta-comments-0");
    expect(meta.textContent).toContain("Sam Patel");
    expect(meta.textContent).toContain(
      new Date("2026-04-21T09:00:00.000Z").toLocaleString(),
    );
  });
});
