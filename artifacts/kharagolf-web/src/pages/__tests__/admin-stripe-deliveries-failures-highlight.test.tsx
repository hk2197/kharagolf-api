/**
 * Task #1897 — When the failure count on the "Failures only" badge in the
 * Recent webhook deliveries panel increases between refetches, the toggle
 * must briefly highlight (pulse + a "+N new" indicator) so on-call admins
 * notice fresh failures without having to remember the previous number.
 *
 * This pins down the four behaviours the task specifies:
 *   1. The first response never flashes (there is no previous baseline yet).
 *   2. When the count increases between refetches, a "+N new" indicator
 *      appears next to the badge and the button gains the `animate-pulse`
 *      class.
 *   3. Acknowledging via either a click on the toggle or a hover on the
 *      badge clears the highlight (so it isn't perpetually shouting), and
 *      a subsequent increase highlights the new delta only.
 *   4. Decreases or steady counts do not trigger the highlight, and a
 *      decrease silently re-baselines the "lastSeen" counter so a future
 *      bump is measured against the lower number.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor, act, fireEvent } from "@testing-library/react";
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

// Mutable so individual tests can advance the failure count between
// refetches and assert the badge reacts.
let currentFailureCount = 0;

function installFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
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
          settings: {
            minCount: 0,
            minSharePct: 0,
            minAttempted: 0,
            wowMinDelta: null,
            email: null,
          },
          defaults: {
            minCount: 0,
            minSharePct: 0,
            minAttempted: 0,
            wowMinDelta: 0,
            fallbackEmail: null,
          },
        });
      }
      if (url.includes("/api/admin/stripe-webhook-deliveries")) {
        return jsonResponse({ deliveries: [], failureCount: currentFailureCount });
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
      if (url.endsWith("/api/admin/wellness-reauth-wow-drift")) {
        return jsonResponse(null);
      }
      if (url.endsWith("/api/admin/notification-templates")) {
        return jsonResponse({ keys: [] });
      }
      // The fps probe failures panel reads `.failures.length`, so the
      // catch-all empty body would crash the page. Return the empty
      // shape the panel expects.
      if (url.includes("/api/admin/swing-fps-probe-failures")) {
        return jsonResponse({ failures: [] });
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

async function openChannelsTab() {
  const user = userEvent.setup();
  const navBtn = await screen.findByRole("button", { name: /comm channels/i });
  await act(async () => {
    await user.click(navBtn);
  });
  return user;
}

// Trigger a refetch of the deliveries query without depending on the
// background polling timer. The visible "Refresh" button right next to the
// filter does exactly that.
async function refreshDeliveries(user: ReturnType<typeof userEvent.setup>) {
  const refresh = await screen.findByTestId("button-refresh-stripe-deliveries");
  await act(async () => {
    await user.click(refresh);
  });
}

beforeEach(() => {
  window.history.replaceState(null, "", "/admin");
  currentFailureCount = 0;
  installFetch();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("admin.tsx — Failures-only badge highlight (Task #1897)", () => {
  it("does not flash on the very first response (no previous baseline yet)", async () => {
    currentFailureCount = 3;
    renderPage();
    await openChannelsTab();

    const failuresBtn = await screen.findByTestId("button-stripe-deliveries-filter-failures");
    const count = await screen.findByTestId("text-stripe-deliveries-failure-count");
    await waitFor(() => {
      expect(count.textContent).toContain("3");
    });

    expect(screen.queryByTestId("badge-stripe-deliveries-new-failures")).toBeNull();
    expect(failuresBtn.className).not.toContain("animate-pulse");
  });

  it("shows a '+N new' indicator and pulses the toggle when the count rises between refetches", async () => {
    currentFailureCount = 2;
    renderPage();
    const user = await openChannelsTab();

    const failuresBtn = await screen.findByTestId("button-stripe-deliveries-filter-failures");
    await waitFor(() => {
      expect(screen.getByTestId("text-stripe-deliveries-failure-count").textContent).toContain("2");
    });
    expect(screen.queryByTestId("badge-stripe-deliveries-new-failures")).toBeNull();

    // Two new failures arrive; the next refetch should highlight the badge.
    currentFailureCount = 4;
    await refreshDeliveries(user);

    const newBadge = await screen.findByTestId("badge-stripe-deliveries-new-failures");
    expect(newBadge.textContent).toContain("+2 new");
    expect(failuresBtn.className).toContain("animate-pulse");
  });

  it("clears the highlight when the admin clicks the 'Failures only' toggle", async () => {
    currentFailureCount = 1;
    renderPage();
    const user = await openChannelsTab();

    await screen.findByTestId("button-stripe-deliveries-filter-failures");
    await waitFor(() => {
      expect(screen.getByTestId("text-stripe-deliveries-failure-count").textContent).toContain("1");
    });

    currentFailureCount = 4;
    await refreshDeliveries(user);
    await screen.findByTestId("badge-stripe-deliveries-new-failures");

    const failuresBtn = screen.getByTestId("button-stripe-deliveries-filter-failures");
    await act(async () => {
      await user.click(failuresBtn);
    });

    await waitFor(() => {
      expect(screen.queryByTestId("badge-stripe-deliveries-new-failures")).toBeNull();
    });
    expect(failuresBtn.className).not.toContain("animate-pulse");
  });

  it("clears the highlight when the admin hovers the count badge", async () => {
    currentFailureCount = 0;
    renderPage();
    const user = await openChannelsTab();

    await screen.findByTestId("button-stripe-deliveries-filter-failures");
    await waitFor(() => {
      expect(screen.getByTestId("text-stripe-deliveries-failure-count").textContent).toContain("0");
    });

    currentFailureCount = 5;
    await refreshDeliveries(user);
    const newBadge = await screen.findByTestId("badge-stripe-deliveries-new-failures");
    expect(newBadge.textContent).toContain("+5 new");

    const count = screen.getByTestId("text-stripe-deliveries-failure-count");
    await act(async () => {
      fireEvent.mouseEnter(count);
    });

    await waitFor(() => {
      expect(screen.queryByTestId("badge-stripe-deliveries-new-failures")).toBeNull();
    });
    expect(screen.getByTestId("button-stripe-deliveries-filter-failures").className)
      .not.toContain("animate-pulse");
  });

  it("does not highlight when the count stays the same or decreases, and re-baselines on a decrease", async () => {
    currentFailureCount = 5;
    renderPage();
    const user = await openChannelsTab();

    await waitFor(() => {
      expect(screen.getByTestId("text-stripe-deliveries-failure-count").textContent).toContain("5");
    });
    expect(screen.queryByTestId("badge-stripe-deliveries-new-failures")).toBeNull();

    // Steady — no flash.
    await refreshDeliveries(user);
    await waitFor(() => {
      expect(screen.getByTestId("text-stripe-deliveries-failure-count").textContent).toContain("5");
    });
    expect(screen.queryByTestId("badge-stripe-deliveries-new-failures")).toBeNull();

    // Decrease — no flash, and lastSeen drops to 3 so the next +1 still
    // counts as "new" (not absorbed by the previous high-water mark).
    currentFailureCount = 3;
    await refreshDeliveries(user);
    await waitFor(() => {
      expect(screen.getByTestId("text-stripe-deliveries-failure-count").textContent).toContain("3");
    });
    expect(screen.queryByTestId("badge-stripe-deliveries-new-failures")).toBeNull();

    // One new failure arrives after the decrease — should highlight as
    // "+1 new", proving the baseline was lowered when the count dropped.
    currentFailureCount = 4;
    await refreshDeliveries(user);
    const newBadge = await screen.findByTestId("badge-stripe-deliveries-new-failures");
    expect(newBadge.textContent).toContain("+1 new");
  });

  it("clicking the 'All' filter also acknowledges the highlight (interacting with the panel = looking)", async () => {
    currentFailureCount = 0;
    renderPage();
    const user = await openChannelsTab();

    await waitFor(() => {
      expect(screen.getByTestId("text-stripe-deliveries-failure-count").textContent).toContain("0");
    });

    currentFailureCount = 7;
    await refreshDeliveries(user);
    await screen.findByTestId("badge-stripe-deliveries-new-failures");

    const allBtn = screen.getByTestId("button-stripe-deliveries-filter-all");
    await act(async () => {
      await user.click(allBtn);
    });

    await waitFor(() => {
      expect(screen.queryByTestId("badge-stripe-deliveries-new-failures")).toBeNull();
    });
  });
});
