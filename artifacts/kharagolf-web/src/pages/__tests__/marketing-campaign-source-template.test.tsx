/**
 * Task #1953 — Each campaign card on the Campaigns tab must show a
 * "From template: <name>" badge when the campaign has a source template
 * attached, and clicking it must open the template editor pre-populated
 * with that template (mirrors the Suppressions tab affordance from
 * Task #1555). The campaign create/edit dialog must also expose a
 * "Source Template" dropdown so admins can attach or change the
 * attribution after the fact, without overwriting the body.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor, act, within, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@workspace/api-client-react", () => ({
  useGetMe: () => ({ data: { id: 1, organizationId: 42, role: "org_admin" } }),
}));

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

import MarketingPage from "../marketing";

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve({
    ok: status < 400,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response);
}

const TEMPLATES = [
  { id: 7, name: "Welcome HTML", category: "general", bodyHtml: "<p>welcome</p>", isGlobal: false },
  { id: 9, name: "Spring Promo", category: "promotions", bodyHtml: "<p>spring</p>", isGlobal: true },
];

const CAMPAIGN_WITH_TEMPLATE = {
  id: 101,
  name: "Spring Open Blast",
  subject: "Tee off with us",
  subjectVariantB: null,
  previewText: null,
  bodyHtml: "<p>body</p>",
  bodyText: null,
  channels: ["email"],
  status: "draft",
  type: "one_off",
  scheduledAt: null,
  sentAt: null,
  segmentId: null,
  dripSeriesId: null,
  templateId: 9,
  totalSent: 0,
  totalOpened: 0,
  totalClicked: 0,
  totalUnsubscribed: 0,
  createdAt: new Date().toISOString(),
};

const CAMPAIGN_NO_TEMPLATE = {
  ...CAMPAIGN_WITH_TEMPLATE,
  id: 102,
  name: "Hand-written blast",
  templateId: null,
};

const CAMPAIGN_DELETED_TEMPLATE = {
  ...CAMPAIGN_WITH_TEMPLATE,
  id: 103,
  name: "Legacy newsletter",
  templateId: 999,
};

function installFetch(campaigns = [CAMPAIGN_WITH_TEMPLATE, CAMPAIGN_NO_TEMPLATE, CAMPAIGN_DELETED_TEMPLATE]) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/marketing/campaigns")) return jsonResponse(campaigns);
      if (url.includes("/marketing/segments")) return jsonResponse([]);
      if (url.includes("/marketing/drip-series")) return jsonResponse([]);
      if (url.includes("/marketing/templates")) return jsonResponse(TEMPLATES);
      if (url.includes("/marketing/bounce-sources")) {
        return jsonResponse({ windowDays: 30, totalBounces: 0, sources: [], truncated: false });
      }
      if (url.includes("/marketing/suppressions")) return jsonResponse([]);
      return jsonResponse({}, 200);
    }),
  );
}

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchInterval: false, staleTime: 0 },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MarketingPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  installFetch();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Campaigns tab — source template attribution (Task #1953)", () => {
  it("renders a 'From template' badge with the template name on cards that have a source template", async () => {
    renderPage();

    const badge = await screen.findByTestId("campaign-source-template-101");
    expect(badge).toHaveTextContent(/from template:/i);
    expect(badge).toHaveTextContent("Spring Promo");
    // Should be a clickable button when the template is loadable.
    expect(badge.tagName).toBe("BUTTON");
  });

  it("does not render the badge for campaigns built from scratch", async () => {
    renderPage();

    // Wait for cards to mount.
    await screen.findByText("Hand-written blast");
    expect(screen.queryByTestId("campaign-source-template-102")).not.toBeInTheDocument();
  });

  it("falls back to the template id (non-clickable) when the template is no longer visible", async () => {
    renderPage();

    const badge = await screen.findByTestId("campaign-source-template-103");
    expect(badge).toHaveTextContent("From template: #999");
    expect(badge.tagName).toBe("SPAN");
  });

  it("clicking the badge opens the template editor pre-populated with the source template", async () => {
    const user = userEvent.setup();
    renderPage();

    const badge = await screen.findByTestId("campaign-source-template-101");
    await act(async () => {
      await user.click(badge);
    });

    // The template editor dialog renders an "Edit Template" header
    // when `editingTemplate` is set, and pre-fills the name input
    // with the chosen template's name.
    await waitFor(() => {
      expect(screen.getByText(/edit template/i)).toBeInTheDocument();
    });
    const nameInput = screen.getByDisplayValue("Spring Promo");
    expect(nameInput).toBeInTheDocument();
  });

  it("exposes a Source Template dropdown in the campaign edit dialog seeded with the campaign's templateId", async () => {
    renderPage();

    // Find the card for the campaign with the attached template, then
    // open its edit dialog. We locate the pencil (edit) button by
    // looking at the action group on the right-hand side of the card,
    // which is the only element matching `.flex.gap-2.flex-shrink-0`
    // inside the row. Indexing the full card's button list would
    // include the new "From template" badge button (also a <button>),
    // which shifts the count and makes positional indexing brittle.
    const headline = await screen.findByText("Spring Open Blast");
    const card = headline.closest(".bg-card") as HTMLElement;
    expect(card).not.toBeNull();
    const actions = card.querySelector(".flex-shrink-0") as HTMLElement;
    expect(actions).not.toBeNull();
    const actionButtons = within(actions).getAllByRole("button");
    // For a draft card the action order is: Eye, Pencil, Calendar,
    // Send, Trash. The pencil opens openEditCampaign.
    fireEvent.click(actionButtons[1]);

    const select = await screen.findByTestId("campaign-source-template-select") as HTMLSelectElement;
    expect(select.value).toBe("9");
    // Both saved templates should be selectable.
    expect(select.querySelector('option[value="7"]')).toBeTruthy();
    expect(select.querySelector('option[value="9"]')).toBeTruthy();
    // And an explicit "no source" option must exist so admins can clear it.
    expect(select.querySelector('option[value=""]')).toBeTruthy();
  });

  it("changing the Source Template dropdown updates only attribution (body unchanged)", async () => {
    renderPage();

    const headline = await screen.findByText("Spring Open Blast");
    const card = headline.closest(".bg-card") as HTMLElement;
    const actions = card.querySelector(".flex-shrink-0") as HTMLElement;
    const actionButtons = within(actions).getAllByRole("button");
    fireEvent.click(actionButtons[1]);

    const select = await screen.findByTestId("campaign-source-template-select") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "7" } });
    expect(select.value).toBe("7");

    // The body editor (HTML textarea) should not have been overwritten
    // by the saved template's body — this dropdown is attribution-only.
    const bodyTextarea = screen.getAllByRole("textbox").find(el => (el as HTMLTextAreaElement).value === "<p>body</p>");
    expect(bodyTextarea).toBeTruthy();
  });
});
