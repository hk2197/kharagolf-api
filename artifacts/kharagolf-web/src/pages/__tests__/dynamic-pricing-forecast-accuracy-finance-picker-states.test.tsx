/**
 * Task #2258 — UI tests for the loading, error, and empty branches of the
 * finance team picker on the forecast accuracy email schedule panel
 * (ForecastAccuracyEmailSchedulePanel inside dynamic-pricing.tsx).
 *
 * The sibling file `dynamic-pricing-forecast-accuracy-finance-picker.test.tsx`
 * already covers the happy path with three seeded treasurers (dropdown
 * options, filtering, picking, disabled state). The picker, however, swaps
 * its placeholder and the helper copy under
 * `forecast-accuracy-finance-picker-help` based on three other branches:
 *
 *   1. The finance-team-members request is still loading — the search input
 *      is disabled and the placeholder reads "Loading finance team…".
 *   2. The request fails (non-2xx) — the helper copy switches to
 *      "Could not load finance team members." so admins know to retry.
 *   3. The request succeeds with an empty members array — the placeholder
 *      reads "No finance team members tagged yet" and the helper copy
 *      points admins at the Members page to tag treasurers.
 *
 * If any of those copy paths regress, admins lose the inline guidance that
 * tells them what to do next, so this file pins them down.
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

type FinanceMembersResponder = (
  json: (data: unknown, status?: number) => Response,
) => Response | Promise<Response>;

let respondToFinanceMembers: FinanceMembersResponder;

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
      return respondToFinanceMembers(json);
    }

    return new Response("not found", { status: 404 }) as unknown as Response;
  }) as typeof fetch;
}

let DynamicPricingPage: typeof import("../dynamic-pricing").default;

beforeEach(async () => {
  toastMock.mockReset();
  // Default — overridden in each test before render.
  respondToFinanceMembers = (json) => json({ members: [], missingEmail: [], missingEmailCount: 0 });
  installFetch();
  DynamicPricingPage = (await import("../dynamic-pricing")).default;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <DynamicPricingPage />
    </QueryClientProvider>,
  );
}

async function gotoAccuracyTab() {
  renderPage();
  const accuracyTab = await screen.findByTestId("tab-accuracy");
  await userEvent.click(accuracyTab);
  // The schedule panel mounts once the schedule query resolves; the finance
  // picker's input is rendered alongside it regardless of the finance query
  // state (the input itself is what advertises the loading/empty/error
  // copy).
  await screen.findByTestId("forecast-accuracy-email-schedule");
  return screen.findByTestId("input-forecast-accuracy-finance-search") as Promise<HTMLInputElement>;
}

describe("dynamic-pricing.tsx — finance team picker loading/error/empty states (Task #2258)", () => {
  it("disables the search input and shows the loading placeholder while the finance-team-members request is in flight", async () => {
    // Hold the finance-team-members request open for the lifetime of this
    // test so the picker stays in its loading branch.
    let resolveFinance: (() => void) | null = null;
    respondToFinanceMembers = (_json) =>
      new Promise<Response>((resolve) => {
        resolveFinance = () =>
          resolve(
            new Response(JSON.stringify({ members: [], missingEmail: [], missingEmailCount: 0 }), {
              status: 200, headers: { "Content-Type": "application/json" },
            }) as unknown as Response,
          );
      });

    const search = await gotoAccuracyTab();

    expect(search).toBeDisabled();
    expect(search).toHaveAttribute("placeholder", "Loading finance team…");

    // Helper copy stays on the default "pick from your treasurers" line
    // while loading — it does NOT prematurely advertise the empty state or
    // the error state.
    const help = screen.getByTestId("forecast-accuracy-finance-picker-help");
    expect(help).toHaveTextContent("Pick from your treasurers, or type any email below for external accountants.");
    expect(help).not.toHaveTextContent("Could not load finance team members.");
    expect(help).not.toHaveTextContent("Tag treasurers in Members");

    // Drain the pending request so React Query / act don't whine when the
    // test tears down. The deferred fetch resolves with an empty members
    // array, so the input stays disabled — wait for the placeholder to
    // flip out of the loading copy as the signal that the request settled.
    resolveFinance?.();
    await waitFor(() => {
      expect(screen.getByTestId("input-forecast-accuracy-finance-search"))
        .toHaveAttribute("placeholder", "No finance team members tagged yet");
    });
  });

  it("shows the 'could not load finance team members' help copy when the request fails", async () => {
    respondToFinanceMembers = (_json) =>
      new Response(JSON.stringify({ error: "boom" }), {
        status: 500, headers: { "Content-Type": "application/json" },
      }) as unknown as Response;

    await gotoAccuracyTab();

    // Wait for the helper copy to flip into the error branch once the
    // 500 response is observed.
    await waitFor(() => {
      const help = screen.getByTestId("forecast-accuracy-finance-picker-help");
      expect(help).toHaveTextContent("Could not load finance team members.");
    });

    const help = screen.getByTestId("forecast-accuracy-finance-picker-help");
    // The error branch wins over the empty/default copy.
    expect(help).not.toHaveTextContent("Tag treasurers in Members");
    expect(help).not.toHaveTextContent("Pick from your treasurers, or type any email below for external accountants.");
  });

  it("shows the empty-state placeholder and 'tag treasurers in Members' help copy when the API returns no members", async () => {
    respondToFinanceMembers = (json) =>
      json({ members: [], missingEmail: [], missingEmailCount: 0 });

    const search = await gotoAccuracyTab();

    // After the empty response settles, the picker must:
    //  * disable the search input (nothing to filter against), and
    //  * advertise the empty state in its placeholder.
    await waitFor(() => {
      expect(search).toBeDisabled();
      expect(search).toHaveAttribute("placeholder", "No finance team members tagged yet");
    });

    const help = screen.getByTestId("forecast-accuracy-finance-picker-help");
    expect(help).toHaveTextContent(
      "Tag treasurers in Members to enable name-based selection. You can still add any email below.",
    );
    expect(help).not.toHaveTextContent("Could not load finance team members.");
    expect(help).not.toHaveTextContent("Pick from your treasurers, or type any email below for external accountants.");
  });
});
