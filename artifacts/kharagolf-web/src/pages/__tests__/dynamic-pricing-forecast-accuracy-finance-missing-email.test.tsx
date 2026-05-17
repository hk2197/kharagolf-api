/**
 * Task #2257 — UI test for the "missing email" warning panel on the forecast
 * accuracy email schedule panel (ForecastAccuracyEmailSchedulePanel inside
 * dynamic-pricing.tsx).
 *
 * Task #1806 covered the finance team picker dropdown itself, but the
 * adjacent warning block (`forecast-accuracy-finance-missing-email`) — which
 * surfaces when a tagged treasurer has no email on file and renders deep-links
 * back to `/club-members?search=...` — was still only verified manually. A
 * regression there could quietly hide treasurers from the picker without ever
 * telling the admin why. This file covers:
 *   - the warning renders with the right count when `missingEmail` is non-empty
 *   - each missing-email link points at `/club-members?search=...` with the
 *     treasurer's display name URI-encoded
 *   - the warning is hidden when no treasurers are missing emails
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
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

interface FinanceMember {
  userId: number;
  displayName: string | null;
  email: string;
  role: string;
}

interface MissingEmailMember {
  userId: number;
  displayName: string | null;
  username: string | null;
  role: string;
}

let financeMembers: FinanceMember[];
let missingEmail: MissingEmailMember[];
let missingEmailCount: number | undefined;

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
      return json({
        members: financeMembers,
        missingEmail,
        missingEmailCount: missingEmailCount ?? missingEmail.length,
      });
    }

    return new Response("not found", { status: 404 }) as unknown as Response;
  }) as typeof fetch;
}

let DynamicPricingPage: typeof import("../dynamic-pricing").default;

beforeEach(async () => {
  toastMock.mockReset();
  financeMembers = [
    { userId: 101, displayName: "Asha Treasurer", email: "asha@club.com", role: "treasurer" },
  ];
  missingEmail = [];
  missingEmailCount = undefined;
  installFetch();
  DynamicPricingPage = (await import("../dynamic-pricing")).default;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderPage() {
  // Each test gets its own QueryClient with retries disabled so the
  // finance-team request resolves once and a failed request would surface
  // immediately rather than being retried under the hood.
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
  // Wait for the schedule panel to mount so the finance-team request fires
  // and the missing-email block has a chance to render.
  await screen.findByTestId("forecast-accuracy-email-schedule");
}

describe("dynamic-pricing.tsx — finance team missing-email warning (Task #2257)", () => {
  it("renders the warning panel with the right count and deep-links when missingEmail is non-empty", async () => {
    missingEmail = [
      { userId: 201, displayName: "Dara Treasurer",  username: "dara",  role: "treasurer" },
      { userId: 202, displayName: "Eli Bookkeeper",  username: "eli",   role: "treasurer" },
    ];
    missingEmailCount = 2;

    await gotoAccuracyTab();

    // The warning block surfaces and the count phrase pluralises correctly
    // ("2 finance team members can't be picked…").
    const warning = await screen.findByTestId("forecast-accuracy-finance-missing-email");
    const countEl = within(warning).getByTestId("forecast-accuracy-finance-missing-email-count");
    expect(countEl).toHaveTextContent(/^2 finance team members can't be picked/);

    // Each missing treasurer shows up as a deep-link back to Members,
    // pre-filled with their display name in the search query string.
    const daraLink = within(warning).getByTestId(
      "forecast-accuracy-finance-missing-email-link-201",
    ) as HTMLAnchorElement;
    expect(daraLink).toHaveTextContent("Dara Treasurer");
    expect(daraLink.getAttribute("href")).toBe(
      `/club-members?search=${encodeURIComponent("Dara Treasurer")}`,
    );

    const eliLink = within(warning).getByTestId(
      "forecast-accuracy-finance-missing-email-link-202",
    ) as HTMLAnchorElement;
    expect(eliLink).toHaveTextContent("Eli Bookkeeper");
    expect(eliLink.getAttribute("href")).toBe(
      `/club-members?search=${encodeURIComponent("Eli Bookkeeper")}`,
    );
  });

  it("uses the singular phrasing when exactly one treasurer is missing an email", async () => {
    // The display name has a space + ampersand, so the encoded href must
    // round-trip through encodeURIComponent (spaces become %20, the
    // ampersand becomes %26). This guards against regressions that might
    // accidentally swap to a less-strict encoder like encodeURI, which
    // would leave the ampersand intact and corrupt the query string.
    missingEmail = [
      { userId: 301, displayName: "Frankie & Co", username: "frankie", role: "treasurer" },
    ];
    missingEmailCount = 1;

    await gotoAccuracyTab();

    const warning = await screen.findByTestId("forecast-accuracy-finance-missing-email");
    const countEl = within(warning).getByTestId("forecast-accuracy-finance-missing-email-count");
    expect(countEl).toHaveTextContent(/^1 finance team member can't be picked/);

    const link = within(warning).getByTestId(
      "forecast-accuracy-finance-missing-email-link-301",
    ) as HTMLAnchorElement;
    expect(link).toHaveTextContent("Frankie & Co");
    expect(link.getAttribute("href")).toBe(
      `/club-members?search=${encodeURIComponent("Frankie & Co")}`,
    );
  });

  it("hides the warning panel entirely when no treasurers are missing emails", async () => {
    missingEmail = [];
    missingEmailCount = 0;

    await gotoAccuracyTab();

    // Open the picker dropdown and wait until the seeded treasurer's option
    // is rendered — that proves the finance-team-members fetch has actually
    // resolved (rather than just the panel skeleton being present), so a
    // missing warning panel can't be a race against an unresolved query.
    const search = await screen.findByTestId("input-forecast-accuracy-finance-search");
    await userEvent.click(search);
    const dropdown = await screen.findByTestId("forecast-accuracy-finance-picker-dropdown");
    await within(dropdown).findByTestId("forecast-accuracy-finance-option-101");

    expect(screen.queryByTestId("forecast-accuracy-finance-missing-email")).toBeNull();
    expect(screen.queryByTestId("forecast-accuracy-finance-missing-email-count")).toBeNull();
  });
});
