/**
 * Regression test for Task #1999 — coverage for the live tournament
 * insights widget (`LiveOddsWidget`).
 *
 * The leaderboard cut-block test (see leaderboard-cut-block.test.tsx)
 * silences this widget by returning a 404 from the mocked `/odds`
 * endpoint, because the widget gracefully hides on error. That means
 * the widget's success-path rendering, telemetry, and SSE update
 * branches were previously uncovered. This file exercises:
 *
 *   - the loading placeholder before the initial fetch resolves,
 *   - the silent-gating branch when the API returns a non-OK response,
 *   - the silent-gating branch when the fetch itself rejects,
 *   - the success render (win-probability ladder, expected scores,
 *     biggest swings, disclosure copy),
 *   - the impression telemetry POST that fires once on successful mount,
 *   - the click telemetry POSTs fired by hovering the three sub-cards,
 *   - the SSE `odds_update` event replacing the rendered payload.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, waitFor, within, act, fireEvent } from "@testing-library/react";

import LiveOddsWidget from "@/components/LiveOddsWidget";

// ── Fixtures ──────────────────────────────────────────────────────────

function makeInitialPayload() {
  return {
    tournamentId: 42,
    tournamentName: "Live Insights Open",
    coursePar: 72,
    rounds: 2,
    winProbability: [
      { playerId: 1, name: "Aiden Iron",   position: 1, scoreToPar: -4, holesCompleted: 36, winProbability: 0.421 },
      { playerId: 2, name: "Brynn Brassie", position: 2, scoreToPar: 0,  holesCompleted: 36, winProbability: 0.193 },
      { playerId: 3, name: "Carl Chip",     position: 3, scoreToPar: 3,  holesCompleted: 36, winProbability: 0.082 },
    ],
    expectedScores: [
      { holeNumber: 1, par: 4, expectedStrokes: 4.12, scoringAverageVsPar:  0.12 },
      { holeNumber: 2, par: 3, expectedStrokes: 2.78, scoringAverageVsPar: -0.22 },
      { holeNumber: 3, par: 5, expectedStrokes: 5.40, scoringAverageVsPar:  0.40 },
    ],
    biggestSwings: [
      { playerId: 1, name: "Aiden Iron",   delta: -1.85, holeNumber: 7,  round: 2, strokes: 3, par: 5 },
      { playerId: 2, name: "Brynn Brassie", delta:  2.10, holeNumber: 12, round: 2, strokes: 6, par: 4 },
    ],
    disclosure: "Entertainment use only. Not gambling advice.",
    lastUpdated: "2026-04-30T10:00:00.000Z",
  };
}

function makeUpdatedPayload() {
  const next = makeInitialPayload();
  // The leaderboard moved: Brynn now leads, Aiden has dropped to 3rd, and
  // a brand-new swing has appeared at the top of the list.
  next.winProbability = [
    { playerId: 2, name: "Brynn Brassie", position: 1, scoreToPar: -3, holesCompleted: 54, winProbability: 0.512 },
    { playerId: 1, name: "Aiden Iron",   position: 3, scoreToPar:  0, holesCompleted: 54, winProbability: 0.131 },
  ];
  next.biggestSwings = [
    { playerId: 99, name: "Drew Driver", delta: -2.30, holeNumber: 4, round: 3, strokes: 2, par: 4 },
    ...next.biggestSwings,
  ];
  next.lastUpdated = "2026-04-30T11:00:00.000Z";
  return next;
}

// ── Browser API stubs ─────────────────────────────────────────────────
//
// We intercept EventSource construction so the test can drive the
// onmessage handler directly. Storing instances on a shared array lets
// us reach in and call `instance.onmessage({ data: ... })` to simulate
// a server push without depending on a real network or timers.

type FakeES = {
  url: string;
  onmessage: ((ev: MessageEvent) => void) | null;
  onopen: ((ev: Event) => void) | null;
  onerror: ((ev: Event) => void) | null;
  close: () => void;
};

const eventSources: FakeES[] = [];
class FakeEventSource implements FakeES {
  url: string;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onopen: ((ev: Event) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  closed = false;
  constructor(url: string) {
    this.url = url;
    eventSources.push(this);
  }
  close() { this.closed = true; }
  addEventListener() { /* noop */ }
  removeEventListener() { /* noop */ }
}

type FetchCall = { url: string; init?: RequestInit };
let fetchCalls: FetchCall[] = [];

function installFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  fetchCalls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      fetchCalls.push({ url, init });
      return Promise.resolve(handler(url, init));
    }) as unknown as typeof fetch,
  );
}

function jsonResponse(body: unknown, init?: { status?: number; ok?: boolean }) {
  const status = init?.status ?? 200;
  const ok = init?.ok ?? (status >= 200 && status < 300);
  return {
    ok,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body ?? {})),
  } as unknown as Response;
}

beforeEach(() => {
  eventSources.length = 0;
  vi.stubGlobal("EventSource", FakeEventSource as unknown as typeof EventSource);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ── Tests ─────────────────────────────────────────────────────────────

describe("LiveOddsWidget", () => {
  it("shows the loading placeholder before the initial fetch resolves", async () => {
    // Hold the fetch open so the loading branch stays mounted until we
    // explicitly resolve it. This lets the assertion run before the
    // success state replaces the placeholder.
    let resolveFetch: ((r: Response) => void) | null = null;
    installFetch(() => new Promise<Response>((resolve) => { resolveFetch = resolve; }));

    render(<LiveOddsWidget tournamentId={42} />);

    expect(await screen.findByTestId("live-odds-loading")).toBeInTheDocument();
    expect(screen.getByText(/Loading live insights/i)).toBeInTheDocument();

    // Resolve so the test cleanup doesn't leak an unresolved promise.
    await act(async () => {
      resolveFetch?.(jsonResponse({}, { status: 404 }));
    });
  });

  it("renders nothing when the odds endpoint returns a non-OK response", async () => {
    installFetch(() => jsonResponse({ reason: "Disabled for this region" }, { status: 403 }));

    const { container } = render(<LiveOddsWidget tournamentId={42} />);

    // Wait for the loading placeholder to drop out of the DOM, then
    // confirm the widget body never rendered.
    await waitFor(() => {
      expect(screen.queryByTestId("live-odds-loading")).toBeNull();
    });
    expect(screen.queryByTestId("live-odds-widget")).toBeNull();
    expect(container).toBeEmptyDOMElement();

    // No telemetry should fire on the gated path, and no SSE stream
    // should be opened either — only the one initial fetch.
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toMatch(/\/api\/public\/tournaments\/42\/odds$/);
    expect(eventSources).toHaveLength(0);
  });

  it("renders nothing when the initial fetch rejects outright", async () => {
    installFetch(() => Promise.reject(new Error("network down")) as unknown as Response);

    const { container } = render(<LiveOddsWidget tournamentId={42} />);

    await waitFor(() => {
      expect(screen.queryByTestId("live-odds-loading")).toBeNull();
    });
    expect(container).toBeEmptyDOMElement();
    expect(eventSources).toHaveLength(0);
  });

  it("renders the success layout, fires impression telemetry, and opens an SSE stream", async () => {
    const initial = makeInitialPayload();
    installFetch((url) => {
      if (url.endsWith("/odds")) return jsonResponse(initial);
      // Telemetry POSTs land here — return a generic ok response.
      return jsonResponse({ ok: true });
    });

    render(<LiveOddsWidget tournamentId={42} surface="web_public" />);

    const widget = await screen.findByTestId("live-odds-widget");
    expect(widget).toHaveAttribute("aria-label", "Live tournament insights");

    // Win probability ladder shows player names and percentage strings.
    const winCard = within(widget).getByTestId("win-prob-card");
    expect(within(winCard).getByText("Aiden Iron")).toBeInTheDocument();
    expect(within(winCard).getByText("Brynn Brassie")).toBeInTheDocument();
    expect(within(winCard).getByText("42.1%")).toBeInTheDocument();
    expect(within(winCard).getByText("19.3%")).toBeInTheDocument();
    // The score-to-par formatting branches: negative, even, positive.
    expect(within(winCard).getByText("-4")).toBeInTheDocument();
    expect(within(winCard).getByText("E")).toBeInTheDocument();
    expect(within(winCard).getByText("+3")).toBeInTheDocument();

    // Expected scores grid renders one cell per hole with the strokes
    // formatted to two decimal places.
    const expectedCard = within(widget).getByTestId("expected-score-card");
    expect(within(expectedCard).getByText("4.12")).toBeInTheDocument();
    expect(within(expectedCard).getByText("2.78")).toBeInTheDocument();
    expect(within(expectedCard).getByText("5.40")).toBeInTheDocument();

    // Biggest swings list renders the round / hole / strokes summary
    // line and the signed delta for both directions.
    const swingCard = within(widget).getByTestId("biggest-swings-card");
    expect(within(swingCard).getByText(/R2 H7 • 3\/5/)).toBeInTheDocument();
    expect(within(swingCard).getByText(/R2 H12 • 6\/4/)).toBeInTheDocument();
    expect(within(swingCard).getByText("-1.85")).toBeInTheDocument();
    expect(within(swingCard).getByText("+2.10")).toBeInTheDocument();

    // Disclosure copy is wired up from the payload, not hard-coded.
    expect(within(widget).getByText(initial.disclosure)).toBeInTheDocument();

    // Impression telemetry: exactly one POST to /odds/telemetry with
    // eventType=impression and the surface forwarded from props.
    await waitFor(() => {
      const telemetry = fetchCalls.filter(c => c.url.endsWith("/odds/telemetry"));
      expect(telemetry).toHaveLength(1);
    });
    const impression = fetchCalls.find(c => c.url.endsWith("/odds/telemetry"))!;
    expect(impression.init?.method).toBe("POST");
    const impressionBody = JSON.parse((impression.init?.body as string) ?? "{}");
    expect(impressionBody).toEqual({
      eventType: "impression",
      widget: "win_probability",
      surface: "web_public",
    });

    // SSE stream opens against the matching odds endpoint exactly once.
    expect(eventSources).toHaveLength(1);
    expect(eventSources[0].url).toMatch(/\/api\/public\/tournaments\/42\/odds\/stream$/);
  });

  it("forwards the click widget id when a sub-card is interacted with", async () => {
    installFetch((url) => {
      if (url.endsWith("/odds")) return jsonResponse(makeInitialPayload());
      return jsonResponse({ ok: true });
    });

    render(<LiveOddsWidget tournamentId={42} surface="kiosk" />);

    const widget = await screen.findByTestId("live-odds-widget");

    // Clear the impression POST so the click assertions only see new
    // entries pushed by the hover handlers.
    await waitFor(() => {
      expect(fetchCalls.some(c => c.url.endsWith("/odds/telemetry"))).toBe(true);
    });
    const baseTelemetryCount = fetchCalls.filter(c => c.url.endsWith("/odds/telemetry")).length;

    // Each card uses onMouseEnter to record interest in that sub-widget.
    fireEvent.mouseEnter(within(widget).getByTestId("win-prob-card"));
    fireEvent.mouseEnter(within(widget).getByTestId("expected-score-card"));
    fireEvent.mouseEnter(within(widget).getByTestId("biggest-swings-card"));

    await waitFor(() => {
      const total = fetchCalls.filter(c => c.url.endsWith("/odds/telemetry")).length;
      expect(total).toBe(baseTelemetryCount + 3);
    });

    const clickEvents = fetchCalls
      .filter(c => c.url.endsWith("/odds/telemetry"))
      .slice(baseTelemetryCount)
      .map(c => JSON.parse((c.init?.body as string) ?? "{}"));

    expect(clickEvents).toEqual([
      { eventType: "click", widget: "win_probability", surface: "kiosk" },
      { eventType: "click", widget: "expected_score",  surface: "kiosk" },
      { eventType: "click", widget: "biggest_swings",  surface: "kiosk" },
    ]);
  });

  it("replaces the rendered data when an SSE odds_update message arrives", async () => {
    installFetch((url) => {
      if (url.endsWith("/odds")) return jsonResponse(makeInitialPayload());
      return jsonResponse({ ok: true });
    });

    render(<LiveOddsWidget tournamentId={42} />);

    const widget = await screen.findByTestId("live-odds-widget");
    // Wait for the SSE stream to be opened (it happens after the
    // initial fetch resolves and impression telemetry is queued).
    await waitFor(() => {
      expect(eventSources).toHaveLength(1);
    });

    // Sanity: pre-update state.
    expect(within(widget).getByText("42.1%")).toBeInTheDocument();
    expect(within(widget).queryByText("Drew Driver")).toBeNull();

    // Simulate a server push. The widget only updates when the parsed
    // envelope's `type` is exactly "odds_update".
    const updated = makeUpdatedPayload();
    await act(async () => {
      eventSources[0].onmessage?.({
        data: JSON.stringify({ type: "odds_update", data: updated }),
      } as MessageEvent);
    });

    await waitFor(() => {
      expect(within(widget).getByText("51.2%")).toBeInTheDocument();
    });
    expect(within(widget).getByText("Drew Driver")).toBeInTheDocument();
    // The previous leader's percentage should be gone — only the new
    // payload's rows are rendered.
    expect(within(widget).queryByText("42.1%")).toBeNull();

    // Unrelated event types and malformed JSON must NOT clobber the UI.
    await act(async () => {
      eventSources[0].onmessage?.({
        data: JSON.stringify({ type: "heartbeat" }),
      } as MessageEvent);
      eventSources[0].onmessage?.({ data: "not json at all" } as MessageEvent);
    });
    expect(within(widget).getByText("51.2%")).toBeInTheDocument();
    expect(within(widget).getByText("Drew Driver")).toBeInTheDocument();
  });
});
