/**
 * Task #1992 — UI tests for the "Near misses" section of the Test modifier
 * dialog in dynamic-pricing.tsx.
 *
 * Task #1605 added a Near misses section that explains in plain English why
 * a modifier didn't fire on a slot (utilisation band, lead-time window,
 * weather, applyTo segment, course scope). The API contract is covered by
 * dynamic-pricing-tier-modifier-preview.test.ts; these tests verify the
 * rendering layer + copy strings + per-slot test ids so a regression in the
 * front end is caught.
 *
 * Coverage:
 *   - Section renders with one row per near-miss slot, keyed by slotId.
 *   - The utilisation-below-min branch produces the band copy with the
 *     expected and actual percentages ("needs at least 50%, slot is at 25%").
 *   - The applyTo branch produces the segment copy ("targets member,
 *     previewing for guest").
 *   - Each row carries the modifier-near-miss-reason-${slotId} test id with
 *     the matching data-condition attribute.
 *
 * The fetch mock returns a fully-controlled ModifierTestResult, so the test
 * is deterministic regardless of what day of week (or what date) it runs on.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// jsdom polyfills for Radix primitives used inside the test-modifier dialog.
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

interface Modifier {
  id: number; name: string; courseId: number | null;
  kind: "utilization" | "lead_time" | "weather";
  thresholdMin: string | null; thresholdMax: string | null;
  weatherCondition: string | null;
  adjustmentType: "percent" | "flat"; adjustmentValue: string;
  applyTo: "any" | "member" | "guest"; priority: number; isActive: boolean;
}

const ORG_ID = 42;
const MOD_ID = 501;

// Two near-miss rows — one per formatter branch the task asks us to cover.
// slotId 9001: utilisation-below-min (band-mismatch branch).
// slotId 9002: applyTo (member-vs-guest segment branch).
const previewResponse = {
  modifier: { id: MOD_ID, name: "Members surge", kind: "utilization" },
  days: 7,
  memberType: "guest" as const,
  courseId: null,
  simulatedWeather: null,
  slotsConsidered: 2,
  matchCount: 0,
  matches: [],
  nearMissLimit: 5,
  nearMisses: [
    {
      slotId: 9001,
      courseId: 77,
      slotDate: "2026-05-09",
      slotTime: "08:00",
      capacity: 4,
      bookedCount: 1,
      utilizationPct: 0.25,
      leadTimeHours: 36,
      failures: [
        { condition: "utilizationBelowMin", expected: 0.5, actual: 0.25 },
      ],
    },
    {
      slotId: 9002,
      courseId: 77,
      slotDate: "2026-05-09",
      slotTime: "10:00",
      capacity: 4,
      bookedCount: 3,
      utilizationPct: 0.75,
      leadTimeHours: 38,
      failures: [
        { condition: "applyTo", expected: "member", actual: "guest" },
      ],
    },
  ],
};

const modifiersFixture: Modifier[] = [
  {
    id: MOD_ID,
    name: "Members surge",
    courseId: null,
    kind: "utilization",
    thresholdMin: "0.5",
    thresholdMax: "1.01",
    weatherCondition: null,
    adjustmentType: "percent",
    adjustmentValue: "20",
    applyTo: "member",
    priority: 1,
    isActive: true,
  },
];

interface FetchCall { method: string; url: string; body: unknown }
let fetchCalls: FetchCall[];

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
      return json([]);
    }
    if (url.endsWith(`/api/organizations/${ORG_ID}/tee-pricing/modifiers`) && method === "GET") {
      return json(modifiersFixture);
    }
    if (url.includes(`/api/organizations/${ORG_ID}/tee-pricing/audit`) && method === "GET") {
      return json([]);
    }
    if (url.includes(`/api/organizations/${ORG_ID}/tee-pricing/rules`) && method === "GET") {
      return json([]);
    }
    if (url.endsWith(`/api/organizations/${ORG_ID}/courses`) && method === "GET") {
      // Provide the course referenced by the near-miss rows so the lookup
      // resolves to a name rather than the "#77" fallback.
      return json([{ id: 77, name: "Lakeside Links" }]);
    }
    if (url.endsWith(`/api/organizations/${ORG_ID}/tee-pricing/modifiers/${MOD_ID}/preview`) && method === "POST") {
      return json(previewResponse);
    }

    return new Response("not found", { status: 404 }) as unknown as Response;
  }) as typeof fetch;
}

let DynamicPricingPage: typeof import("../dynamic-pricing").default;

beforeEach(async () => {
  fetchCalls = [];
  toastMock.mockReset();
  installFetch();
  DynamicPricingPage = (await import("../dynamic-pricing")).default;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function openTestModifierDialog() {
  // Switch to the Modifiers tab — the test-modifier button lives on each
  // modifier card.
  const modifiersTab = await screen.findByRole("tab", { name: /modifiers/i });
  await userEvent.click(modifiersTab);

  const testButton = await screen.findByTestId(`btn-test-modifier-${MOD_ID}`);
  await userEvent.click(testButton);

  // Wait for the dialog to mount.
  await screen.findByTestId("dialog-test-modifier");
}

describe("dynamic-pricing.tsx — Test modifier Near misses section (Task #1992)", () => {
  it("renders the Near misses section with a row per near-miss slot when the modifier matches nothing", async () => {
    render(<DynamicPricingPage />);
    await openTestModifierDialog();

    // The preview POST fires on dialog open — wait for it before asserting
    // on the rendered section.
    await waitFor(() => {
      const preview = fetchCalls.find(c =>
        c.method === "POST" &&
        c.url.endsWith(`/tee-pricing/modifiers/${MOD_ID}/preview`));
      expect(preview, "expected POST /modifiers/501/preview to fire").toBeDefined();
    });

    const section = await screen.findByTestId("section-test-modifier-near-misses");
    expect(section).toBeInTheDocument();

    // One row per near-miss slot, keyed by slotId.
    expect(within(section).getByTestId("row-test-modifier-near-miss-9001")).toBeInTheDocument();
    expect(within(section).getByTestId("row-test-modifier-near-miss-9002")).toBeInTheDocument();
  });

  it("formats the utilisation-below-min branch as a band copy with expected and actual percentages", async () => {
    render(<DynamicPricingPage />);
    await openTestModifierDialog();

    const reason = await screen.findByTestId("modifier-near-miss-reason-9001");
    // The branch identifier comes back as a data-attribute so a copy reword
    // doesn't accidentally hide the wrong reason on the wrong row.
    expect(reason).toHaveAttribute("data-condition", "utilizationBelowMin");
    // Copy must spell out both the modifier's required threshold and the
    // slot's actual occupancy as percentages, not raw 0..1 numbers.
    expect(reason.textContent).toMatch(/Occupancy too low/i);
    expect(reason.textContent).toMatch(/at least 50%/);
    expect(reason.textContent).toMatch(/slot is at 25%/);
  });

  it("formats the applyTo branch as a member-vs-guest segment copy", async () => {
    render(<DynamicPricingPage />);
    await openTestModifierDialog();

    const reason = await screen.findByTestId("modifier-near-miss-reason-9002");
    expect(reason).toHaveAttribute("data-condition", "applyTo");
    expect(reason.textContent).toMatch(/Wrong member type/i);
    expect(reason.textContent).toMatch(/targets member/);
    expect(reason.textContent).toMatch(/previewing for guest/);
  });
});
