/**
 * Task #1806 — UI test for the finance team picker on the forecast accuracy
 * email schedule panel (ForecastAccuracyEmailSchedulePanel inside
 * dynamic-pricing.tsx).
 *
 * Task #1471 wired a finance-team autocomplete into the schedule editor so
 * org admins can pick tagged treasurers instead of typing emails by hand.
 * The backend endpoint (/forecast-accuracy/email-schedule/finance-team-members)
 * is exercised by an API integration test, but the picker dropdown itself was
 * only verified manually. This file covers the UI wiring so regressions like
 * the dropdown rendering behind another element, the option click failing to
 * append the email, or the chip badges not surfacing for matched recipients
 * get caught automatically.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, within } from "@testing-library/react";
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

let financeMembers: FinanceMember[];

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
      return json({ members: financeMembers, missingEmail: [], missingEmailCount: 0 });
    }

    return new Response("not found", { status: 404 }) as unknown as Response;
  }) as typeof fetch;
}

let DynamicPricingPage: typeof import("../dynamic-pricing").default;

beforeEach(async () => {
  toastMock.mockReset();
  financeMembers = [
    { userId: 101, displayName: "Asha Treasurer",   email: "asha@club.com",   role: "treasurer" },
    { userId: 102, displayName: "Bilal Bookkeeper", email: "bilal@club.com",  role: "treasurer" },
    { userId: 103, displayName: "Chen Controller",  email: "chen@club.com",   role: "treasurer" },
  ];
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

async function gotoAccuracyTabAndOpenPicker() {
  renderPage();
  // The page defaults to the "tiers" tab — switch to the accuracy tab so the
  // schedule panel mounts.
  const accuracyTab = await screen.findByTestId("tab-accuracy");
  await userEvent.click(accuracyTab);

  // Wait for the panel + finance picker to appear once the finance-team
  // request resolves.
  await screen.findByTestId("forecast-accuracy-email-schedule");
  const search = await screen.findByTestId("input-forecast-accuracy-finance-search");
  // Focus opens the dropdown.
  await userEvent.click(search);
  await screen.findByTestId("forecast-accuracy-finance-picker-dropdown");
  return search as HTMLInputElement;
}

describe("dynamic-pricing.tsx — finance team picker (Task #1806)", () => {
  it("lists every tagged treasurer in the picker dropdown", async () => {
    await gotoAccuracyTabAndOpenPicker();

    const dropdown = screen.getByTestId("forecast-accuracy-finance-picker-dropdown");
    // Every seeded treasurer surfaces as an option, with their display name
    // and role label visible.
    expect(within(dropdown).getByTestId("forecast-accuracy-finance-option-101"))
      .toHaveTextContent("Asha Treasurer");
    expect(within(dropdown).getByTestId("forecast-accuracy-finance-option-102"))
      .toHaveTextContent("Bilal Bookkeeper");
    expect(within(dropdown).getByTestId("forecast-accuracy-finance-option-103"))
      .toHaveTextContent("Chen Controller");
    // The role label ("Treasurer") is rendered for at least one option.
    expect(within(dropdown).getAllByText(/treasurer/i).length).toBeGreaterThan(0);
  });

  it("filters the picker as the admin types a name fragment", async () => {
    const search = await gotoAccuracyTabAndOpenPicker();

    await userEvent.type(search, "bilal");

    const dropdown = await screen.findByTestId("forecast-accuracy-finance-picker-dropdown");
    expect(within(dropdown).getByTestId("forecast-accuracy-finance-option-102"))
      .toHaveTextContent("Bilal Bookkeeper");
    expect(within(dropdown).queryByTestId("forecast-accuracy-finance-option-101")).toBeNull();
    expect(within(dropdown).queryByTestId("forecast-accuracy-finance-option-103")).toBeNull();

    // A fragment that matches no member surfaces the empty-state row.
    await userEvent.clear(search);
    await userEvent.type(search, "zzz-no-match");
    await screen.findByTestId("forecast-accuracy-finance-picker-empty");
  });

  it("appends the picked treasurer's email to the recipients textarea and shows their chip badge", async () => {
    await gotoAccuracyTabAndOpenPicker();

    const recipients = screen.getByTestId("input-forecast-accuracy-recipients") as HTMLTextAreaElement;
    expect(recipients.value).toBe("");
    // No chip badges yet — none of the empty list of recipients matches a
    // tagged treasurer.
    expect(screen.queryByTestId("forecast-accuracy-recipient-member-tag-101")).toBeNull();

    // Click Asha — the option uses onMouseDown so userEvent.click (which
    // fires both mousedown and click) replays the same path the admin takes.
    const ashaOption = screen.getByTestId("forecast-accuracy-finance-option-101");
    await userEvent.click(ashaOption);

    await waitFor(() => {
      expect(recipients.value).toBe("asha@club.com");
    });

    // The chip badge for Asha appears under the textarea.
    const ashaTag = await screen.findByTestId("forecast-accuracy-recipient-member-tag-101");
    expect(ashaTag).toHaveTextContent("Asha Treasurer");

    // Re-open the dropdown and pick a second treasurer — the new email is
    // appended (with a comma separator) and a second chip badge appears.
    const search = screen.getByTestId("input-forecast-accuracy-finance-search");
    await userEvent.click(search);
    await screen.findByTestId("forecast-accuracy-finance-picker-dropdown");
    const bilalOption = screen.getByTestId("forecast-accuracy-finance-option-102");
    await userEvent.click(bilalOption);

    await waitFor(() => {
      expect(recipients.value).toBe("asha@club.com, bilal@club.com");
    });
    const bilalTag = await screen.findByTestId("forecast-accuracy-recipient-member-tag-102");
    expect(bilalTag).toHaveTextContent("Bilal Bookkeeper");
    // The first chip badge is still rendered.
    expect(screen.getByTestId("forecast-accuracy-recipient-member-tag-101")).toBeInTheDocument();
  });

  it("marks an already-added treasurer's option as disabled in the dropdown", async () => {
    await gotoAccuracyTabAndOpenPicker();

    // First pick — Asha lands in the textarea.
    await userEvent.click(screen.getByTestId("forecast-accuracy-finance-option-101"));
    await waitFor(() => {
      const ta = screen.getByTestId("input-forecast-accuracy-recipients") as HTMLTextAreaElement;
      expect(ta.value).toBe("asha@club.com");
    });

    // Re-open the dropdown — Asha's option is now disabled (the "already
    // added" state). Picking her again must NOT duplicate her email.
    const search = screen.getByTestId("input-forecast-accuracy-finance-search");
    await userEvent.click(search);
    await screen.findByTestId("forecast-accuracy-finance-picker-dropdown");

    const ashaOption = screen.getByTestId("forecast-accuracy-finance-option-101") as HTMLButtonElement;
    expect(ashaOption).toBeDisabled();

    await userEvent.click(ashaOption);
    const ta = screen.getByTestId("input-forecast-accuracy-recipients") as HTMLTextAreaElement;
    expect(ta.value).toBe("asha@club.com");
  });
});
