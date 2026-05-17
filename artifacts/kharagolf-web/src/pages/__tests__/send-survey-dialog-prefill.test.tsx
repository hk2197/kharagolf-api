/**
 * Task #1636 — Pre-fill the Send-survey dialog with the previous survey's
 * questions. The actual dialog is wired through `useQuery` and rendered
 * inside `tournament-detail.tsx`; these tests cover the two helpers that do
 * the real work — `savedQuestionsToDraft` (mapping the API's stored
 * questions into the dialog's draft shape with a defaults fallback) and
 * `isoToLocalDatetimeInput` (formatting the saved `closesAt` for a
 * `<input type="datetime-local">`).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import {
  SendSurveyDialog,
  savedQuestionsToDraft,
  isoToLocalDatetimeInput,
} from "../tournament-detail";

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

beforeEach(() => {
  responsesPayload = {
    survey: null,
    totalResponses: 0,
    eligiblePlayers: 0,
    aggregates: [],
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

function renderDialog(open: boolean) {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchInterval: false, staleTime: 0, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={qc}>
      <SendSurveyDialog
        open={open}
        onOpenChange={() => {}}
        orgId={1}
        tournamentId={42}
        onSent={() => {}}
      />
    </QueryClientProvider>,
  );
}

describe("savedQuestionsToDraft", () => {
  it("returns null when the API has no saved survey questions", () => {
    expect(savedQuestionsToDraft(null)).toBeNull();
    expect(savedQuestionsToDraft(undefined)).toBeNull();
    expect(savedQuestionsToDraft([])).toBeNull();
    expect(savedQuestionsToDraft("not an array")).toBeNull();
  });

  it("preserves saved id, type and prompt for valid questions", () => {
    const saved = [
      { id: "overall", type: "rating", prompt: "Overall experience" },
      { id: "play_again", type: "boolean", prompt: "Would you play again?" },
      { id: "comments", type: "text", prompt: "Any comments?" },
    ];
    const draft = savedQuestionsToDraft(saved);
    expect(draft).toEqual([
      { id: "overall", type: "rating", prompt: "Overall experience" },
      { id: "play_again", type: "boolean", prompt: "Would you play again?" },
      { id: "comments", type: "text", prompt: "Any comments?" },
    ]);
  });

  it("falls back to label when prompt is absent (legacy stored shape)", () => {
    const saved = [{ id: "q1", type: "rating", label: "Course condition" }];
    expect(savedQuestionsToDraft(saved)).toEqual([
      { id: "q1", type: "rating", prompt: "Course condition" },
    ]);
  });

  it("coerces unknown question types to 'text' so the Select stays valid", () => {
    const saved = [{ id: "q1", type: "wibble", prompt: "Hi" }];
    expect(savedQuestionsToDraft(saved)).toEqual([
      { id: "q1", type: "text", prompt: "Hi" },
    ]);
  });

  it("generates an id when one is missing so React keys stay unique", () => {
    const saved = [{ type: "rating", prompt: "No id here" }];
    const draft = savedQuestionsToDraft(saved);
    expect(draft).toHaveLength(1);
    expect(draft![0].prompt).toBe("No id here");
    expect(draft![0].id).toMatch(/^q_/);
  });

  it("skips entries that are not objects", () => {
    const saved = [null, "nope", 7, { id: "q1", type: "rating", prompt: "Keep" }];
    expect(savedQuestionsToDraft(saved)).toEqual([
      { id: "q1", type: "rating", prompt: "Keep" },
    ]);
  });
});

describe("isoToLocalDatetimeInput", () => {
  it("returns an empty string for null/undefined/invalid input", () => {
    expect(isoToLocalDatetimeInput(null)).toBe("");
    expect(isoToLocalDatetimeInput(undefined)).toBe("");
    expect(isoToLocalDatetimeInput("not-a-date")).toBe("");
  });

  it("formats a valid ISO timestamp as YYYY-MM-DDTHH:mm in local time", () => {
    // Use a real ISO timestamp and re-derive the expected local string from
    // the same Date so the assertion is timezone-agnostic.
    const iso = "2026-04-29T15:30:00.000Z";
    const d = new Date(iso);
    const pad = (n: number) => String(n).padStart(2, "0");
    const expected =
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
      `T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    expect(isoToLocalDatetimeInput(iso)).toBe(expected);
  });
});

describe("SendSurveyDialog prefill on open", () => {
  it("prefills the questions list and closesAt from the saved survey", async () => {
    const closesAtIso = "2026-05-15T18:00:00.000Z";
    responsesPayload = {
      survey: {
        id: 7,
        sentAt: "2026-04-20T10:00:00.000Z",
        reminderSentAt: null,
        closesAt: closesAtIso,
        questions: [
          { id: "saved_overall", type: "rating", prompt: "How was the food?" },
          { id: "saved_again", type: "boolean", prompt: "Would you play again?" },
        ],
      },
      totalResponses: 0,
      eligiblePlayers: 12,
      aggregates: [],
    };

    renderDialog(true);

    // Wait for the prefill effect to run after the query resolves.
    const firstPrompt = await waitFor(() => {
      const el = screen.getByTestId("input-question-prompt-0") as HTMLInputElement;
      if (el.value !== "How was the food?") throw new Error("not yet prefilled");
      return el;
    });

    expect(firstPrompt.value).toBe("How was the food?");
    const secondPrompt = screen.getByTestId("input-question-prompt-1") as HTMLInputElement;
    expect(secondPrompt.value).toBe("Would you play again?");
    // The third default question must NOT be present once we've prefilled
    // from a saved survey that only has two questions.
    expect(screen.queryByTestId("input-question-prompt-2")).toBeNull();

    const closesInput = screen.getByTestId("input-survey-closes-at") as HTMLInputElement;
    const d = new Date(closesAtIso);
    const pad = (n: number) => String(n).padStart(2, "0");
    const expected =
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
      `T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    expect(closesInput.value).toBe(expected);
  });

  it("falls back to the three default questions when no survey exists", async () => {
    responsesPayload.survey = null;
    renderDialog(true);

    // The defaults render synchronously from initial state, but assert with
    // waitFor so we don't race the query's subsequent resolve.
    await waitFor(() => {
      const el = screen.getByTestId("input-question-prompt-0") as HTMLInputElement;
      if (el.value !== "Overall experience") throw new Error("defaults not rendered yet");
    });
    expect((screen.getByTestId("input-question-prompt-1") as HTMLInputElement).value).toBe(
      "Course condition",
    );
    expect((screen.getByTestId("input-question-prompt-2") as HTMLInputElement).value).toBe(
      "Any comments?",
    );
    expect((screen.getByTestId("input-survey-closes-at") as HTMLInputElement).value).toBe("");
  });
});

// Task #2030 — admins need to know whether they're editing an existing survey
// (and when it was last sent) or starting from defaults. The banner draws its
// timestamp from the same /survey/responses payload that drives the prefill.
describe("SendSurveyDialog last-sent banner", () => {
  it("shows when the previous survey was sent if one exists", async () => {
    const sentAtIso = "2026-04-20T10:00:00.000Z";
    responsesPayload = {
      survey: {
        id: 7,
        sentAt: sentAtIso,
        reminderSentAt: null,
        closesAt: null,
        questions: [{ id: "q1", type: "rating", prompt: "Overall" }],
      },
      totalResponses: 0,
      eligiblePlayers: 12,
      aggregates: [],
    };

    renderDialog(true);

    const expected = new Date(sentAtIso).toLocaleString();
    const banner = await waitFor(() => {
      const el = screen.getByTestId("survey-last-sent-banner");
      if (!el.textContent?.includes(expected)) throw new Error("banner not yet populated");
      return el;
    });
    expect(banner.textContent).toMatch(/Editing the survey sent on/);
    expect(banner.textContent).toContain(expected);
  });

  it("shows the defaults message when no survey has ever been sent", async () => {
    responsesPayload.survey = null;
    renderDialog(true);

    const banner = await waitFor(() => {
      const el = screen.getByTestId("survey-last-sent-banner");
      if (!el.textContent?.includes("No survey sent yet")) throw new Error("not yet rendered");
      return el;
    });
    expect(banner.textContent).toMatch(/No survey sent yet/);
    expect(banner.textContent).not.toMatch(/Editing the survey sent on/);
  });
});
