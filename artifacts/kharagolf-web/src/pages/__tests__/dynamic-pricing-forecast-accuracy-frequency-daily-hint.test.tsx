/**
 * Task #2247 — UI test for the Daily-frequency volume warning on the
 * forecast accuracy email schedule panel (ForecastAccuracyEmailSchedulePanel
 * inside dynamic-pricing.tsx).
 *
 * The schedule editor now shows an inline amber hint under the Frequency
 * Select when the org admin picks Daily, warning that recipients will get
 * one email per day. Without test coverage, a future refactor of the panel
 * could silently drop the hint and reintroduce the inbox-fatigue complaints
 * that motivated it. This file exercises the conditional rendering end to
 * end so the warning stays wired to the Daily option.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

if (typeof Element !== "undefined") {
  const proto = Element.prototype as unknown as Record<string, unknown>;
  if (!proto.hasPointerCapture) proto.hasPointerCapture = () => false;
  if (!proto.releasePointerCapture) proto.releasePointerCapture = () => {};
  if (!proto.setPointerCapture) proto.setPointerCapture = () => {};
  if (!proto.scrollIntoView) proto.scrollIntoView = () => {};
}

vi.mock("@workspace/api-client-react", () => ({
  useGetMe: () => ({
    data: { id: 1, organizationId: 42, role: "org_admin" },
  }),
}));

const toastMock = vi.fn();
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: toastMock }),
}));

const ORG_ID = 42;

function installFetch() {
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();

    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), {
      status, headers: { "Content-Type": "application/json" },
    }) as unknown as Response;

    if (url.endsWith(`/api/organizations/${ORG_ID}/tee-pricing/config`) && method === "GET") {
      return json({
        organizationId: ORG_ID, enabled: true,
        priceFloorPct: "0.50", priceCeilingPct: "2.00", dealBadgeThresholdPct: "0.85",
        defaultMemberElasticity: "-0.20", defaultGuestElasticity: "-0.70",
      });
    }
    if (url.endsWith(`/api/organizations/${ORG_ID}/tee-pricing/tiers`) && method === "GET") {
      return json([]);
    }
    if (url.endsWith(`/api/organizations/${ORG_ID}/tee-pricing/modifiers`) && method === "GET") {
      return json([]);
    }
    if (url.includes(`/api/organizations/${ORG_ID}/tee-pricing/audit`) && method === "GET") {
      return json([]);
    }
    if (url.includes(`/api/organizations/${ORG_ID}/tee-pricing/rules`) && method === "GET") {
      return json([]);
    }
    if (url.endsWith(`/api/organizations/${ORG_ID}/courses`) && method === "GET") {
      return json([]);
    }
    if (url.includes(`/api/organizations/${ORG_ID}/tee-pricing/forecast-accuracy?`) && method === "GET") {
      return json({ rows: [], summary: null });
    }
    if (url.endsWith(`/api/organizations/${ORG_ID}/tee-pricing/forecast-accuracy/email-schedule`) && method === "GET") {
      return json({ schedule: null, history: [] });
    }
    if (url.endsWith(`/api/organizations/${ORG_ID}/tee-pricing/forecast-accuracy/email-schedule/finance-team-members`) && method === "GET") {
      return json({ members: [], missingEmail: [], missingEmailCount: 0 });
    }

    return new Response("not found", { status: 404 }) as unknown as Response;
  }) as typeof fetch;
}

let DynamicPricingPage: typeof import("../dynamic-pricing").default;

beforeEach(async () => {
  toastMock.mockReset();
  installFetch();
  DynamicPricingPage = (await import("../dynamic-pricing")).default;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderPage() {
  // The DynamicPricingPage relies on TanStack Query inside the schedule panel;
  // wrap it in a fresh QueryClientProvider so each test starts from a clean
  // cache (no retries, no shared state).
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <DynamicPricingPage />
    </QueryClientProvider>,
  );
}

async function gotoAccuracyTabAndOpenFrequencySelect() {
  renderPage();
  // The page defaults to the "tiers" tab — switch to the accuracy tab so the
  // schedule panel mounts.
  const accuracyTab = await screen.findByTestId("tab-accuracy");
  await userEvent.click(accuracyTab);

  // Wait for the panel to render once the schedule + finance-team requests
  // resolve.
  await screen.findByTestId("forecast-accuracy-email-schedule");
  return await screen.findByTestId("select-forecast-accuracy-frequency");
}

const DAILY_HINT_TESTID = "forecast-accuracy-frequency-daily-hint";
const DAILY_HINT_COPY = /one email per day/i;

describe("dynamic-pricing.tsx — Daily-frequency volume warning (Task #2247)", () => {
  it("hides the warning while Frequency is Weekly (the default) or Monthly", async () => {
    const trigger = await gotoAccuracyTabAndOpenFrequencySelect();

    // Default frequency is Weekly — the hint must not be in the document.
    expect(trigger).toHaveTextContent(/weekly/i);
    expect(screen.queryByTestId(DAILY_HINT_TESTID)).toBeNull();

    // Switch to Monthly — the hint must still be absent.
    await userEvent.click(trigger);
    const monthlyOption = await screen.findByRole("option", { name: /monthly/i });
    await userEvent.click(monthlyOption);
    await waitFor(() => {
      expect(screen.getByTestId("select-forecast-accuracy-frequency")).toHaveTextContent(/monthly/i);
    });
    expect(screen.queryByTestId(DAILY_HINT_TESTID)).toBeNull();
  });

  it("shows the volume-implication warning copy when Frequency is set to Daily", async () => {
    const trigger = await gotoAccuracyTabAndOpenFrequencySelect();

    // Sanity: hint hidden before we touch the Select.
    expect(screen.queryByTestId(DAILY_HINT_TESTID)).toBeNull();

    // Open the Select and pick Daily.
    await userEvent.click(trigger);
    const dailyOption = await screen.findByRole("option", { name: /daily/i });
    await userEvent.click(dailyOption);

    // The hint must surface with the "one email per day" copy that warns
    // admins about inbox volume before they save the schedule.
    const hint = await screen.findByTestId(DAILY_HINT_TESTID);
    expect(hint).toBeVisible();
    expect(hint).toHaveTextContent(DAILY_HINT_COPY);

    // Flip back to Weekly — the hint disappears again so it stays scoped to
    // the Daily cadence.
    await userEvent.click(screen.getByTestId("select-forecast-accuracy-frequency"));
    const weeklyOption = await screen.findByRole("option", { name: /weekly/i });
    await userEvent.click(weeklyOption);
    await waitFor(() => {
      expect(screen.queryByTestId(DAILY_HINT_TESTID)).toBeNull();
    });
  });
});
