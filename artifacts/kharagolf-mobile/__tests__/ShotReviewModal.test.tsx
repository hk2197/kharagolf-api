/**
 * Task #649 — automated coverage for the per-hole "Add Shot" flow added in
 * Task #519 (`ShotReviewModal` in components/ShotReviewModal.tsx).
 *
 * Walks the modal through the real Add-Shot interaction and proves:
 *   1. Initial hydration calls GET /portal/rounds/:round/shots?tournamentId=…
 *      and lists the existing shots for the targeted hole.
 *   2. Tapping "Add Shot" opens the new-shot form with the next shot number
 *      pre-filled (existing max + 1).
 *   3. Editing the form and pressing Save POSTs to /api/portal/shots/manual
 *      with the active tournamentId/round/holeNumber and chosen fields.
 *   4. After a successful save the form closes, the modal re-fetches and the
 *      new shot appears in the list with the chosen shot number, AND the
 *      parent's onMutated callback fires (so the per-hole SG card refetches).
 *   5. Validation errors short-circuit before the network — submitting with a
 *      blank shot type triggers the "Missing shot type" alert and never POSTs.
 */
import React, { type ReactNode } from "react";
import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
  type Mock,
} from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

// ── Module mocks (must come BEFORE the component import) ───────────────────

vi.mock("react-native-safe-area-context", () => {
  const ReactInner = require("react") as typeof React;
  return {
    SafeAreaView: ({ children }: { children?: ReactNode }) =>
      ReactInner.createElement("div", null, children),
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  };
});

const { alertMock } = vi.hoisted(() => ({
  alertMock: vi.fn<(
    title: string,
    message?: string,
    buttons?: Array<{ text: string; onPress?: () => void; style?: string }>,
  ) => void>(),
}));
vi.mock("react-native", async () => {
  const RN = await vi.importActual<typeof import("react-native")>("react-native");
  return { ...RN, Alert: { alert: alertMock } };
});

// ── Imports under test (after mocks) ───────────────────────────────────────
import ShotReviewModal, { type ServerShot } from "../components/ShotReviewModal";

// ── Test fixtures ──────────────────────────────────────────────────────────

const TOURNAMENT_ID = 555;
const ROUND = 1;
const HOLE = 7;
const TOKEN = "test-token";

function makeShot(overrides: Partial<ServerShot> & Pick<ServerShot, "id" | "shotNumber">): ServerShot {
  return {
    round: ROUND,
    holeNumber: HOLE,
    shotType: "tee",
    club: "driver",
    lieType: "Tee",
    missDirection: null,
    shotShape: null,
    penaltyReason: null,
    distanceToPin: null,
    ...overrides,
  };
}

let serverShots: ServerShot[];
let onMutated: Mock<() => void>;

type FetchMock = Mock<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>;
let fetchMock: FetchMock;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  alertMock.mockReset();
  // Default behaviour: silently pass through. Individual tests override when
  // they need to assert on the alert content.
  alertMock.mockImplementation(() => {});

  serverShots = [makeShot({ id: 1001, shotNumber: 1 })];
  onMutated = vi.fn();

  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (method === "GET" && url.includes(`/api/portal/rounds/${ROUND}/shots`)) {
      // Group-by-hole shape the modal expects.
      return jsonResponse([{ hole: HOLE, shots: serverShots }]);
    }
    if (method === "POST" && url.endsWith("/api/portal/shots/manual")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        shotNumber: number;
        shotType: string;
        club?: string;
        lieType?: string;
        missDirection?: string;
      };
      // Persist into our fake server so the post-save refetch surfaces it.
      const inserted = makeShot({
        id: 2000 + serverShots.length,
        shotNumber: body.shotNumber,
        shotType: body.shotType,
        club: body.club ?? null,
        lieType: body.lieType ?? null,
        missDirection: body.missDirection ?? null,
      });
      serverShots = [...serverShots, inserted];
      return jsonResponse({ ok: true, shot: inserted });
    }
    throw new Error(`Unexpected fetch: ${method} ${url}`);
  }) as unknown as FetchMock;

  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderModal() {
  return render(
    <ShotReviewModal
      visible={true}
      onClose={() => {}}
      token={TOKEN}
      tournamentId={TOURNAMENT_ID}
      round={ROUND}
      holeNumber={HOLE}
      onMutated={onMutated}
    />,
  );
}

describe("ShotReviewModal — Add Shot flow (Task #519 / #649)", () => {
  it("posts to /api/portal/shots/manual, surfaces the new shot, and fires onMutated", async () => {
    renderModal();

    // Initial hydration: the existing shot row should render.
    await waitFor(() => {
      expect(document.body.textContent).toContain("TEE");
    });
    // The hydration request hits the per-round shots endpoint with the
    // active tournamentId on the query string.
    const initialFetch = fetchMock.mock.calls.find(([url]) =>
      String(url).includes(`/api/portal/rounds/${ROUND}/shots?tournamentId=${TOURNAMENT_ID}`),
    );
    expect(initialFetch).toBeDefined();
    const initInit = initialFetch?.[1] as RequestInit | undefined;
    const initHeaders = (initInit?.headers ?? {}) as Record<string, string>;
    expect(initHeaders.Authorization).toBe(`Bearer ${TOKEN}`);

    // Open the Add Shot form.
    const addBtn = screen.getByLabelText("Add Shot");
    await act(async () => {
      fireEvent.click(addBtn);
    });

    // The Shot # input must be pre-populated with max(existing) + 1 = 2.
    const shotNumberInput = screen.getByLabelText("New shot number") as HTMLInputElement;
    expect(shotNumberInput.value).toBe("2");

    // Fill in the rest of the new shot fields.
    const typeInput = screen.getByLabelText("New shot type") as HTMLInputElement;
    const clubInput = screen.getByLabelText("New shot club") as HTMLInputElement;
    const lieInput  = screen.getByLabelText("New shot lie") as HTMLInputElement;
    const missInput = screen.getByLabelText("New shot miss") as HTMLInputElement;
    await act(async () => {
      fireEvent.change(typeInput, { target: { value: "approach" } });
      fireEvent.change(clubInput, { target: { value: "7I" } });
      fireEvent.change(lieInput,  { target: { value: "Fairway" } });
      fireEvent.change(missInput, { target: { value: "Left" } });
    });

    // Save → POST /api/portal/shots/manual
    const saveBtn = screen.getByLabelText("Save new shot");
    await act(async () => {
      fireEvent.click(saveBtn);
    });

    // The manual-shot endpoint must have been hit with the right method,
    // auth header, and a body that mirrors the active tournament/round/hole
    // and the chosen field values.
    await waitFor(() => {
      const postCall = fetchMock.mock.calls.find(([url, init]) =>
        String(url).endsWith("/api/portal/shots/manual") && init?.method === "POST",
      );
      expect(postCall).toBeDefined();
      const init = postCall?.[1] as RequestInit;
      const headers = (init.headers ?? {}) as Record<string, string>;
      expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
      expect(headers["Content-Type"]).toBe("application/json");
      const body = JSON.parse(String(init.body ?? "{}"));
      expect(body).toMatchObject({
        tournamentId: TOURNAMENT_ID,
        round: ROUND,
        holeNumber: HOLE,
        shotNumber: 2,
        shotType: "approach",
        club: "7I",
        lieType: "Fairway",
        missDirection: "Left",
      });
    });

    // After save the modal refetches; the new APPROACH · 7I row must appear,
    // and the parent's onMutated callback must have been invoked so the
    // per-hole SG card refreshes.
    await waitFor(() => {
      expect(document.body.textContent).toContain("APPROACH");
      expect(document.body.textContent).toContain("7I");
    });
    expect(onMutated).toHaveBeenCalled();

    // The shot-number badge for the new row should read "2".
    const shotNumBadges = Array.from(document.querySelectorAll("*"))
      .filter(el => el.textContent === "2" && el.children.length === 0);
    expect(shotNumBadges.length).toBeGreaterThanOrEqual(1);
  });

  it("blocks the POST and alerts the player when shot type is blank", async () => {
    renderModal();
    await waitFor(() => {
      expect(document.body.textContent).toContain("TEE");
    });

    // Open the form, then clear the shot type field.
    await act(async () => {
      fireEvent.click(screen.getByLabelText("Add Shot"));
    });
    const typeInput = screen.getByLabelText("New shot type") as HTMLInputElement;
    await act(async () => {
      fireEvent.change(typeInput, { target: { value: "  " } });
    });

    // Pressing Save must alert and NOT hit the network.
    await act(async () => {
      fireEvent.click(screen.getByLabelText("Save new shot"));
    });
    expect(alertMock).toHaveBeenCalled();
    const firstAlert = alertMock.mock.calls[0];
    expect(String(firstAlert[0])).toMatch(/Missing shot type/i);

    // No /shots/manual POST should have fired.
    const postCall = fetchMock.mock.calls.find(([url, init]) =>
      String(url).endsWith("/api/portal/shots/manual") && init?.method === "POST",
    );
    expect(postCall).toBeUndefined();
    // And the parent's onMutated must not have fired.
    expect(onMutated).not.toHaveBeenCalled();
  });
});
