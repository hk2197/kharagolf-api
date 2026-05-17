/**
 * Component test for Task #2021 — coach marketplace card emphasises the
 * matched price (and dims the unmatched side) so the player can see at a
 * glance which side of a coach's offer the active mode + price bracket
 * is filtering against.
 *
 * The card under test lives in
 * `artifacts/kharagolf-web/src/pages/coach-marketplace.tsx`. Its mode
 * toggle and price bracket are wired client-side to a `priceSideStatus`
 * helper that mirrors the server-side mode→price mapping in
 * `artifacts/api-server/src/routes/coach-marketplace.ts`. This test
 * pins down the four cases that helper has to handle, since a regression
 * here would silently surface random-looking results to the player:
 *
 *   1. mode = all + no price filter → both sides render neutrally
 *   2. mode = in_person → in-person side is active, async side is dim
 *   3. mode = async → async side is active, in-person side is dim
 *   4. mode = all + price bracket → only the side that falls inside the
 *      bracket is active; the other is dimmed and a "Matches filter"
 *      badge appears on the matched side
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import CoachMarketplacePage from "@/pages/coach-marketplace";

interface CoachSeed {
  proId: number;
  displayName: string;
  hourlyRatePaise: number;
  asyncReviewPricePaise: number;
  acceptsInPerson: boolean;
  acceptsAsync: boolean;
}

function buildBackend(coaches: CoachSeed[]) {
  const ok = (body: unknown) =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(body),
    } as Response);

  const handler = (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const path = url.split("?")[0].replace(/^.*\/api\//, "/api/");

    if (path === "/api/coach-marketplace/coaches") {
      return ok({
        coaches: coaches.map(c => ({
          proId: c.proId,
          organizationId: 1,
          organizationName: "Test Club",
          displayName: c.displayName,
          bio: null,
          photoUrl: null,
          specialisms: [],
          certifications: [],
          yearsExperience: 5,
          languages: ["en"],
          hourlyRatePaise: c.hourlyRatePaise,
          asyncReviewPricePaise: c.asyncReviewPricePaise,
          acceptsInPerson: c.acceptsInPerson,
          acceptsAsync: c.acceptsAsync,
          asyncTurnaroundHours: 48,
          coachesHandicapMin: null,
          coachesHandicapMax: null,
          ratingsAvg: 4.5,
          ratingsCount: 12,
          introVideoUrl: null,
        })),
      });
    }

    // Empty arrays for the side-fetches MyReviewsSection makes so the
    // test never has to render the "My swing reviews" widget.
    if (path === "/api/swing-reviews/my-requests") return ok({ requests: [] });

    return ok({});
  };

  return handler;
}

async function clickModeButton(label: string) {
  const button = screen.getByRole("button", { name: label });
  await act(async () => {
    await userEvent.click(button);
  });
  // Allow the refetch to land.
  await act(async () => {
    await Promise.resolve();
  });
}

async function showFilters() {
  const toggle = screen.getByTestId("button-toggle-filters");
  await act(async () => {
    await userEvent.click(toggle);
  });
}

async function setFilter(testId: string, value: string) {
  const input = screen.getByTestId(testId) as HTMLInputElement;
  await act(async () => {
    await userEvent.clear(input);
    if (value !== "") await userEvent.type(input, value);
  });
  await act(async () => {
    await Promise.resolve();
  });
}

describe("Coach marketplace card price highlight (Task #2021)", () => {
  beforeEach(() => {
    const handler = buildBackend([
      {
        proId: 1,
        displayName: "Cheap Async, Premium In-Person",
        // ₹2000/hr in-person, ₹500/review async
        hourlyRatePaise: 200_000,
        asyncReviewPricePaise: 50_000,
        acceptsInPerson: true,
        acceptsAsync: true,
      },
    ]);
    vi.stubGlobal("fetch", vi.fn(handler) as unknown as typeof fetch);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function renderAndWait() {
    render(<CoachMarketplacePage />);
    await screen.findByTestId("coach-1-price-async");
  }

  it("renders both price sides as neutral when no mode/price filter is active", async () => {
    await renderAndWait();
    const asyncSide = screen.getByTestId("coach-1-price-async");
    const inPersonSide = screen.getByTestId("coach-1-price-in-person");
    expect(asyncSide.getAttribute("data-side-status")).toBe("neutral");
    expect(inPersonSide.getAttribute("data-side-status")).toBe("neutral");
    // No "Matches filter" badge should be present without a price filter.
    expect(screen.queryByTestId("coach-1-async-matches-badge")).toBeNull();
    expect(screen.queryByTestId("coach-1-in-person-matches-badge")).toBeNull();
  });

  it("emphasises the in-person side when the in-person mode is selected", async () => {
    await renderAndWait();
    await clickModeButton("In-person");
    await screen.findByTestId("coach-1-price-async");
    expect(screen.getByTestId("coach-1-price-in-person").getAttribute("data-side-status")).toBe("active");
    expect(screen.getByTestId("coach-1-price-async").getAttribute("data-side-status")).toBe("dim");
  });

  it("emphasises the async side when the async mode is selected", async () => {
    await renderAndWait();
    await clickModeButton("Async review");
    await screen.findByTestId("coach-1-price-async");
    expect(screen.getByTestId("coach-1-price-async").getAttribute("data-side-status")).toBe("active");
    expect(screen.getByTestId("coach-1-price-in-person").getAttribute("data-side-status")).toBe("dim");
  });

  it("under mode=all + price bracket, marks only the side that falls in the bracket as active and shows a Matches filter badge", async () => {
    await renderAndWait();
    await showFilters();
    // Bracket ₹0–₹1000 — the async price (₹500) is inside, the in-person
    // price (₹2000/hr) is outside.
    await setFilter("filter-price-max", "1000");
    await screen.findByTestId("coach-1-price-async");
    expect(screen.getByTestId("coach-1-price-async").getAttribute("data-side-status")).toBe("active");
    expect(screen.getByTestId("coach-1-price-in-person").getAttribute("data-side-status")).toBe("dim");
    expect(screen.getByTestId("coach-1-async-matches-badge")).toBeInTheDocument();
    expect(screen.queryByTestId("coach-1-in-person-matches-badge")).toBeNull();
  });
});
