/**
 * UI test for the web AI Caddie chat page (Task #842).
 *
 * Mounts <AiCaddiePage /> with a stubbed `fetch` that returns an
 * SSE-streamed response from `POST /api/portal/caddie/ask` and asserts:
 *   1. The streamed reply tokens render in the assistant bubble.
 *   2. The "Based on your last N shots / N rounds" attribution chip
 *      renders with the correct copy when the final `done` event carries
 *      contextShots / contextRounds metadata.
 *   3. When the `done` event omits the metadata the assistant reply still
 *      renders and no attribution chip appears (graceful fallback).
 *
 * The server-side contract for the SSE endpoint is exercised separately by
 * the api-server tests; this file focuses on the page's streaming parser,
 * composer behaviour, and chip rendering.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, cleanup, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("wouter", () => ({
  useLocation: () => ["/ai-caddie", vi.fn()] as const,
}));

import AiCaddiePage from "../ai-caddie";

interface AskCall {
  question: string;
  history: Array<{ role: string; content: string }>;
}

interface SsePart {
  // Raw JSON payload to emit as a single SSE `data:` event.
  payload: Record<string, unknown>;
}

interface FetchState {
  askCalls: AskCall[];
  // Queue of scripted SSE responses, one per ask call (FIFO).
  scripts: SsePart[][];
}

let state: FetchState;

function encodeSse(parts: SsePart[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const p of parts) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(p.payload)}\n\n`));
      }
      controller.close();
    },
  });
}

function installFetch() {
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();

    if (url.endsWith("/api/portal/caddie/ask") && method === "POST") {
      const body = JSON.parse((init?.body as string) ?? "{}") as AskCall;
      state.askCalls.push(body);
      const script = state.scripts.shift() ?? [];
      const stream = encodeSse(script);
      return new Response(stream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }) as unknown as Response;
    }

    return new Response("not found", { status: 404 }) as unknown as Response;
  }) as typeof fetch;
}

beforeEach(() => {
  state = { askCalls: [], scripts: [] };
  installFetch();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("<AiCaddiePage /> — streaming chat + attribution chip", () => {
  it("streams the assistant reply, posts the question to /api/portal/caddie/ask, and renders the shot-based attribution chip", async () => {
    state.scripts.push([
      { payload: { content: "Try a smooth " } },
      { payload: { content: "7-iron." } },
      {
        payload: {
          done: true,
          contextShots: 12,
          contextRounds: 0,
          contextMode: "shots",
        },
      },
    ]);

    render(<AiCaddiePage />);

    const input = await screen.findByTestId("ai-caddie-input");
    await userEvent.type(input, "What club from 150?");
    await userEvent.click(screen.getByTestId("ai-caddie-send"));

    // The page POSTed to the SSE endpoint with the typed question and an
    // empty history (this is the first turn).
    await waitFor(() => expect(state.askCalls.length).toBe(1));
    expect(state.askCalls[0].question).toBe("What club from 150?");
    expect(state.askCalls[0].history).toEqual([]);

    // Streamed tokens are concatenated into the assistant bubble.
    const assistant = await screen.findByTestId("ai-caddie-assistant-content");
    await waitFor(() => expect(assistant.textContent).toContain("Try a smooth 7-iron."));

    // Attribution chip renders with the shot-mode copy from the `done` event.
    const chip = await screen.findByTestId("ai-caddie-context-chip");
    expect(chip).toHaveTextContent(/Based on your last 12 shots/i);

    // Composer flips back to the Send button (streaming finished).
    await waitFor(() => expect(screen.getByTestId("ai-caddie-send")).toBeInTheDocument());
  });

  it("renders the rounds-mode chip with shots-tracked suffix when the done event reports rounds + totalTrackedShots", async () => {
    state.scripts.push([
      { payload: { content: "Your approach play has been trending up." } },
      {
        payload: {
          done: true,
          contextShots: 0,
          contextRounds: 5,
          contextMode: "rounds",
          totalTrackedShots: 320,
        },
      },
    ]);

    render(<AiCaddiePage />);
    await userEvent.click(await screen.findByTestId("ai-caddie-starter-How is my ap"));

    await waitFor(() => expect(state.askCalls.length).toBe(1));

    const chip = await screen.findByTestId("ai-caddie-context-chip");
    expect(chip).toHaveTextContent(/Based on your last 5 rounds \(320 shots tracked\)/i);
  });

  it("renders the assistant reply but no attribution chip when the done event omits the context metadata (graceful fallback)", async () => {
    state.scripts.push([
      { payload: { content: "Work on your wedge dispersion this week." } },
      // `done` event with no contextShots / contextRounds / contextMode —
      // the page must still finalise the bubble and not render a chip.
      { payload: { done: true } },
    ]);

    render(<AiCaddiePage />);

    const input = await screen.findByTestId("ai-caddie-input");
    await userEvent.type(input, "What should I work on?");
    await userEvent.click(screen.getByTestId("ai-caddie-send"));

    const assistant = await screen.findByTestId("ai-caddie-assistant-content");
    await waitFor(() =>
      expect(assistant.textContent).toContain("Work on your wedge dispersion this week."),
    );

    // Composer returned to the idle state, confirming the stream completed.
    await waitFor(() => expect(screen.getByTestId("ai-caddie-send")).toBeInTheDocument());

    // No attribution chip should be rendered for a metadata-less `done`.
    expect(screen.queryByTestId("ai-caddie-context-chip")).toBeNull();

    // And no error bubble either — the empty done is a graceful no-op.
    expect(screen.queryByTestId("ai-caddie-error")).toBeNull();
  });

  it("sends prior turns as history on the second ask", async () => {
    state.scripts.push([
      { payload: { content: "Answer one." } },
      { payload: { done: true, contextShots: 3, contextMode: "shots" } },
    ]);
    state.scripts.push([
      { payload: { content: "Answer two." } },
      { payload: { done: true, contextShots: 4, contextMode: "shots" } },
    ]);

    render(<AiCaddiePage />);

    const input = await screen.findByTestId("ai-caddie-input");
    await userEvent.type(input, "Question one?");
    await userEvent.click(screen.getByTestId("ai-caddie-send"));

    await waitFor(() => expect(state.askCalls.length).toBe(1));
    const firstChip = await screen.findByTestId("ai-caddie-context-chip");
    expect(firstChip).toHaveTextContent(/Based on your last 3 shots/i);

    // Wait for streaming to finish before sending the next turn.
    await waitFor(() => expect(screen.getByTestId("ai-caddie-send")).toBeInTheDocument());

    await userEvent.type(screen.getByTestId("ai-caddie-input"), "Question two?");
    await userEvent.click(screen.getByTestId("ai-caddie-send"));

    await waitFor(() => expect(state.askCalls.length).toBe(2));
    expect(state.askCalls[1].question).toBe("Question two?");
    expect(state.askCalls[1].history).toEqual([
      { role: "user", content: "Question one?" },
      { role: "assistant", content: "Answer one." },
    ]);

    // Most recent assistant bubble shows the new chip.
    const chips = await screen.findAllByTestId("ai-caddie-context-chip");
    expect(within(chips[chips.length - 1]).getByText(/Based on your last 4 shots/i)).toBeInTheDocument();
  });
});
