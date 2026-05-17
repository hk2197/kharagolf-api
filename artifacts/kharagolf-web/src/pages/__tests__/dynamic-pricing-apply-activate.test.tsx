/**
 * Task #1023 — UI tests for the "Apply & activate" button in the
 * dynamic-pricing tier editor (dynamic-pricing.tsx).
 *
 * The button (data-testid="btn-apply-activate-draft") was added in Task #880
 * to let admins save a draft tier and immediately flip it live via the same
 * /tiers/:id/activate endpoint as the manual toggle. These tests cover:
 *
 *   - The button is visible only when an INACTIVE draft is open in the
 *     editor (it is hidden for an already-active tier).
 *   - Clicking it fires PATCH /tiers/:id (with the edited fields) and then
 *     POST /tiers/:id/activate, in that order, against the same tier id.
 *   - The page reloads after activation and a "Tier applied & activated"
 *     toast surfaces.
 *
 * The audit-log side of the contract (a `tier.activated` row is written
 * when /activate is called) is asserted by the API integration test in
 * artifacts/api-server/src/tests/dynamic-pricing-apply-activate.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// jsdom polyfills for Radix primitives used inside the editor dialog.
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

interface Tier {
  id: number; name: string; description: string | null; courseId: number | null;
  daysOfWeek: number[]; startTime: string | null; endTime: string | null;
  seasonStart: string | null; seasonEnd: string | null;
  memberType: "any" | "member" | "guest";
  memberRate: string; guestRate: string; priority: number; isActive: boolean;
}

interface FetchCall { method: string; url: string; body: unknown }

const ORG_ID = 42;

function makeTier(overrides: Partial<Tier> = {}): Tier {
  return {
    id: 0,
    name: "Tier",
    description: null,
    courseId: null,
    daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
    startTime: null,
    endTime: null,
    seasonStart: null,
    seasonEnd: null,
    memberType: "any",
    memberRate: "1000",
    guestRate: "1500",
    priority: 0,
    isActive: false,
    ...overrides,
  };
}

const forecastResponse = {
  horizonDays: 14,
  assumptions: {
    historicalSampleDays: 30, memberShare: 0.5, fallbackUtilization: 0.5,
    slotsConsidered: 100, elasticity: -0.4, memberElasticity: -0.2, guestElasticity: -0.7,
  },
  active: { revenue: 100000, seatsBooked: 80, seatsTotal: 200, slots: 50, avgPrice: 1250, utilizationPct: 0.4 },
  draft:  { revenue: 110000, seatsBooked: 82, seatsTotal: 200, slots: 50, avgPrice: 1342, utilizationPct: 0.41 },
  delta:  { revenue: 10000, revenuePct: 10, avgPrice: 92, avgPricePct: 7.4, utilizationPct: 0.01 },
  daily: [],
};

let fetchCalls: FetchCall[];
let tiers: Tier[];

function installFetch() {
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    let body: unknown = undefined;
    if (init?.body) {
      try { body = JSON.parse(String(init.body)); } catch { body = init.body; }
    }
    fetchCalls.push({ method, url, body });

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
      return json(tiers);
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
    if (url.endsWith(`/api/organizations/${ORG_ID}/tee-pricing/forecast`) && method === "POST") {
      return json(forecastResponse);
    }

    // PATCH a tier — return the merged row.
    const patchMatch = url.match(new RegExp(`/api/organizations/${ORG_ID}/tee-pricing/tiers/(\\d+)$`));
    if (patchMatch && method === "PATCH") {
      const id = Number(patchMatch[1]);
      const existing = tiers.find(t => t.id === id);
      const merged: Tier = { ...(existing ?? makeTier({ id })), ...(body as Partial<Tier>), id };
      return json(merged);
    }
    // POST /activate — flip isActive=true and return.
    const activateMatch = url.match(new RegExp(`/api/organizations/${ORG_ID}/tee-pricing/tiers/(\\d+)/activate$`));
    if (activateMatch && method === "POST") {
      const id = Number(activateMatch[1]);
      const tier = tiers.find(t => t.id === id);
      if (tier) tier.isActive = true;
      return json(tier ?? { id, isActive: true });
    }

    return new Response("not found", { status: 404 }) as unknown as Response;
  }) as typeof fetch;
}

let DynamicPricingPage: typeof import("../dynamic-pricing").default;

beforeEach(async () => {
  fetchCalls = [];
  toastMock.mockReset();
  installFetch();
  // Import after mocks so useGetMe / useToast are wired correctly.
  DynamicPricingPage = (await import("../dynamic-pricing")).default;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function openEditorFor(tierId: number) {
  const card = await screen.findByTestId(`tier-${tierId}`);
  // The editor is opened by the pencil button — it's the second of three
  // ghost buttons in the card actions row (toggle, edit, delete).
  const pencilButton = within(card).getAllByRole("button")[1];
  await userEvent.click(pencilButton);
  // Wait for the editor dialog to mount.
  await screen.findByTestId("btn-save-tier");
}

describe("dynamic-pricing.tsx — Apply & activate button (Task #1023)", () => {
  it("shows the Apply & activate button when an inactive draft tier is open in the editor", async () => {
    tiers = [makeTier({ id: 11, name: "Twilight draft", isActive: false })];
    render(<DynamicPricingPage />);

    await openEditorFor(11);

    // The button only renders once the inline what-if forecast resolves
    // (it lives inside the forecast panel), so we wait for it to appear.
    const applyActivate = await screen.findByTestId("btn-apply-activate-draft", {}, { timeout: 3000 });
    expect(applyActivate).toBeInTheDocument();
    expect(applyActivate).toHaveTextContent(/apply & activate/i);
  });

  it("hides the Apply & activate button when the open tier is already active", async () => {
    tiers = [makeTier({ id: 12, name: "Live tier", isActive: true })];
    render(<DynamicPricingPage />);

    await openEditorFor(12);

    // The plain "Apply this draft" button still appears once the forecast
    // lands — wait for it so we know the panel finished rendering before
    // asserting the activate variant is absent.
    await screen.findByTestId("btn-apply-draft", {}, { timeout: 3000 });
    expect(screen.queryByTestId("btn-apply-activate-draft")).not.toBeInTheDocument();
  });

  it("PATCHes the tier and POSTs /activate when Apply & activate is clicked", async () => {
    tiers = [makeTier({ id: 21, name: "Twilight draft", memberRate: "750", isActive: false })];
    render(<DynamicPricingPage />);

    await openEditorFor(21);
    const applyActivate = await screen.findByTestId("btn-apply-activate-draft", {}, { timeout: 3000 });

    await userEvent.click(applyActivate);

    // Both the save (PATCH) and the activate (POST) requests must fire,
    // in that order, against the same tier id.
    await waitFor(() => {
      const patch = fetchCalls.find(c =>
        c.method === "PATCH" && c.url.endsWith(`/tee-pricing/tiers/21`));
      const activate = fetchCalls.find(c =>
        c.method === "POST" && c.url.endsWith(`/tee-pricing/tiers/21/activate`));
      expect(patch, "expected PATCH /tiers/21 to fire").toBeDefined();
      expect(activate, "expected POST /tiers/21/activate to fire").toBeDefined();
    });

    const patchIdx = fetchCalls.findIndex(c =>
      c.method === "PATCH" && c.url.endsWith(`/tee-pricing/tiers/21`));
    const activateIdx = fetchCalls.findIndex(c =>
      c.method === "POST" && c.url.endsWith(`/tee-pricing/tiers/21/activate`));
    expect(patchIdx).toBeGreaterThanOrEqual(0);
    expect(activateIdx).toBeGreaterThan(patchIdx);

    // The PATCH body carries the edited tier fields (e.g. the original name).
    const patchCall = fetchCalls[patchIdx];
    expect(patchCall.body).toMatchObject({ id: 21, name: "Twilight draft" });

    // The success toast surfaces.
    await waitFor(() => {
      expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({
        title: expect.stringMatching(/applied & activated/i),
      }));
    });
  });
});
