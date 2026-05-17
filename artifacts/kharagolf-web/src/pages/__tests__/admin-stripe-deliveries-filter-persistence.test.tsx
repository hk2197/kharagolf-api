/**
 * Task #1535 — The "Failures only" toggle on the Recent webhook deliveries
 * panel must survive a refresh and be shareable via URL. This pins down two
 * behaviours so a regression in either can't slip in:
 *   1. The initial filter state is read from `?webhookFilter=failures` (so a
 *      refresh / shared link reproduces the view).
 *   2. Toggling the filter mirrors the choice into the URL via
 *      `history.replaceState`, and clearing it back to "All" removes the
 *      query param entirely so the URL stays clean.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@workspace/api-client-react", () => ({
  useGetMe: () => ({
    data: { id: 1, organizationId: 42, role: "org_admin" },
  }),
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

import SettingsPage from "../admin";

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve({
    ok: status < 400,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response);
}

const ORG = {
  id: 42,
  name: "Pine Valley",
  slug: "pinevalley",
  description: null,
  logoUrl: null,
  primaryColor: "#1e4d2b",
  customDomain: null,
  subscriptionTier: "enterprise",
  isActive: true,
  contactEmail: null,
  contactPhone: null,
  address: null,
  website: null,
  defaultLanguage: "en",
};

const STRIPE_OK = {
  baseCurrency: "USD",
  usesStripe: true,
  secretKeyConfigured: true,
  webhookSecretConfigured: true,
  webhookEndpoint: "/api/stripe/webhook",
  warning: false,
  setupInstructions: null,
};

const fetchedUrls: string[] = [];

function installFetch() {
  fetchedUrls.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      fetchedUrls.push(url);
      if (url.endsWith("/api/organizations/42")) {
        return jsonResponse(ORG);
      }
      if (url.endsWith("/api/admin/channel-status")) {
        return jsonResponse({
          channels: {
            email: { active: false, provider: null, setupInstructions: null },
            push: { active: false, provider: null, setupInstructions: null },
            sms: { active: false, provider: null, setupInstructions: null },
            whatsapp: { active: false, provider: null, setupInstructions: null },
          },
          payments: { stripe: STRIPE_OK },
        });
      }
      if (url.endsWith("/api/admin/wearable-reauth-alert-settings")) {
        return jsonResponse({
          orgId: 42,
          settings: { minCount: 0, minSharePct: 0, minAttempted: 0, email: null },
          defaults: { minCount: 0, minSharePct: 0, minAttempted: 0, fallbackEmail: null },
        });
      }
      if (url.includes("/api/admin/stripe-webhook-deliveries")) {
        return jsonResponse({ deliveries: [] });
      }
      if (url.endsWith("/api/admin/stripe-webhook-sweep-status")) {
        return jsonResponse({ lastSweep: null });
      }
      if (url.includes("/api/admin/stripe-webhook-sweep-history")) {
        return jsonResponse({ days: 14, runs: [] });
      }
      if (url.endsWith("/api/admin/wellness-sweep-status")) {
        return jsonResponse({ lastSweep: null });
      }
      if (url.includes("/api/admin/wellness-sweep-history")) {
        return jsonResponse({ days: 30, runs: [] });
      }
      // The drift tile renders unconditionally on a truthy response, so a
      // bare `{}` would crash on `thisWeek.averageNeedsReauth`. Return null
      // to keep the tile out of the tree — it isn't relevant to this test.
      if (url.endsWith("/api/admin/wellness-reauth-wow-drift")) {
        return jsonResponse(null);
      }
      if (url.endsWith("/api/admin/notification-templates")) {
        return jsonResponse({ keys: [] });
      }
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
      <SettingsPage />
    </QueryClientProvider>,
  );
}

// The "Recent webhook deliveries" panel lives inside the "Comm Channels"
// section, which isn't the default tab. Click into it so the filter
// segmented control is mounted before the test inspects it.
async function openChannelsTab() {
  const user = userEvent.setup();
  const navBtn = await screen.findByRole("button", { name: /comm channels/i });
  await act(async () => {
    await user.click(navBtn);
  });
  return user;
}

beforeEach(() => {
  // Reset to a clean URL between tests so initial-state assertions are
  // deterministic. jsdom keeps `window.location` between tests otherwise.
  window.history.replaceState(null, "", "/admin");
  installFetch();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("admin.tsx — Recent webhook deliveries filter persistence (Task #1535)", () => {
  it("defaults to 'All' for first-time visitors with no query string", async () => {
    renderPage();
    await openChannelsTab();

    const allBtn = await screen.findByTestId("button-stripe-deliveries-filter-all");
    const failuresBtn = await screen.findByTestId("button-stripe-deliveries-filter-failures");
    expect(allBtn.getAttribute("aria-pressed")).toBe("true");
    expect(failuresBtn.getAttribute("aria-pressed")).toBe("false");

    // The unfiltered endpoint is what gets requested when the default applies.
    await waitFor(() => {
      expect(fetchedUrls).toContain("/api/admin/stripe-webhook-deliveries");
    });
    expect(fetchedUrls).not.toContain("/api/admin/stripe-webhook-deliveries?status=failures");
    // And the URL is left clean (no `?webhookFilter=...`).
    expect(window.location.search).toBe("");
  });

  it("hydrates 'Failures only' from `?webhookFilter=failures` so a refresh / shared link reproduces the view", async () => {
    window.history.replaceState(null, "", "/admin?webhookFilter=failures");
    renderPage();
    await openChannelsTab();

    const failuresBtn = await screen.findByTestId("button-stripe-deliveries-filter-failures");
    const allBtn = await screen.findByTestId("button-stripe-deliveries-filter-all");
    await waitFor(() => {
      expect(failuresBtn.getAttribute("aria-pressed")).toBe("true");
    });
    expect(allBtn.getAttribute("aria-pressed")).toBe("false");

    // The failures-only endpoint is what gets requested.
    await waitFor(() => {
      expect(fetchedUrls).toContain("/api/admin/stripe-webhook-deliveries?status=failures");
    });
    // The URL parameter is preserved (not stripped on mount).
    expect(window.location.search).toBe("?webhookFilter=failures");
  });

  it("ignores unknown values of `?webhookFilter` and falls back to 'All'", async () => {
    window.history.replaceState(null, "", "/admin?webhookFilter=bogus");
    renderPage();
    await openChannelsTab();

    const allBtn = await screen.findByTestId("button-stripe-deliveries-filter-all");
    expect(allBtn.getAttribute("aria-pressed")).toBe("true");
    // And the rogue value is wiped from the URL on the first effect tick.
    await waitFor(() => {
      expect(window.location.search).toBe("");
    });
  });

  it("mirrors a click on 'Failures only' into the URL, and clears the param when toggled back", async () => {
    renderPage();
    const user = await openChannelsTab();

    const allBtn = await screen.findByTestId("button-stripe-deliveries-filter-all");
    const failuresBtn = await screen.findByTestId("button-stripe-deliveries-filter-failures");

    await act(async () => {
      await user.click(failuresBtn);
    });
    await waitFor(() => {
      expect(window.location.search).toBe("?webhookFilter=failures");
    });
    expect(failuresBtn.getAttribute("aria-pressed")).toBe("true");

    await act(async () => {
      await user.click(allBtn);
    });
    await waitFor(() => {
      expect(window.location.search).toBe("");
    });
    expect(allBtn.getAttribute("aria-pressed")).toBe("true");
  });

  it("preserves unrelated query-string parameters when toggling the filter", async () => {
    window.history.replaceState(null, "", "/admin?tab=integrations");
    renderPage();
    const user = await openChannelsTab();

    const failuresBtn = await screen.findByTestId("button-stripe-deliveries-filter-failures");
    await act(async () => {
      await user.click(failuresBtn);
    });
    await waitFor(() => {
      const sp = new URLSearchParams(window.location.search);
      expect(sp.get("tab")).toBe("integrations");
      expect(sp.get("webhookFilter")).toBe("failures");
    });

    const allBtn = await screen.findByTestId("button-stripe-deliveries-filter-all");
    await act(async () => {
      await user.click(allBtn);
    });
    await waitFor(() => {
      const sp = new URLSearchParams(window.location.search);
      expect(sp.get("tab")).toBe("integrations");
      expect(sp.has("webhookFilter")).toBe(false);
    });
  });
});
