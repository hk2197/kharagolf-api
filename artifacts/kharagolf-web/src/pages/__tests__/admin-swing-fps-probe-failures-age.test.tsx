/**
 * Task #2127 — The "Swing-video frame-rate probe failures" panel must
 * surface how long each row has been broken so admins can prioritise the
 * truly stuck failures over this morning's blip:
 *
 *   1. Each row shows BOTH the absolute timestamp and a relative
 *      "Nd ago" age badge.
 *   2. Rows older than 7 days get a red highlight on the row, so the
 *      chronic ones pop visually.
 *   3. The "Show only failures older than N days" filter actually
 *      hides recent rows when set to >1d / >7d / >30d, and shows a
 *      friendly empty-state when nothing matches.
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

interface MockFailure {
  id: number;
  swingVideoId: number;
  objectPath: string;
  attempts: number;
  errorMessage: string | null;
  errorMessagePreview: string | null;
  completedAt: string | null;
  updatedAt: string | null;
}

let currentFailures: MockFailure[] = [];

function installFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/api/organizations/42")) return jsonResponse(ORG);
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
          settings: { minCount: 0, minSharePct: 0, minAttempted: 0, wowMinDelta: null, email: null },
          defaults: { minCount: 0, minSharePct: 0, minAttempted: 0, wowMinDelta: 0, fallbackEmail: null },
        });
      }
      if (url.includes("/api/admin/stripe-webhook-deliveries")) {
        return jsonResponse({ deliveries: [], failureCount: 0 });
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
      if (url.includes("/api/admin/swing-fps-probe-failures")) {
        return jsonResponse({
          failures: currentFailures,
          failureCount: currentFailures.length,
        });
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

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

function makeFailure(overrides: Partial<MockFailure> & { id: number; daysAgo: number }): MockFailure {
  const { daysAgo, ...rest } = overrides;
  return {
    id: rest.id,
    swingVideoId: rest.swingVideoId ?? rest.id * 100,
    objectPath: rest.objectPath ?? `org/42/swing/${rest.id}.mp4`,
    attempts: rest.attempts ?? 5,
    errorMessage: rest.errorMessage ?? "ffprobe: stream not found",
    errorMessagePreview: rest.errorMessagePreview ?? "ffprobe: stream not found",
    completedAt: rest.completedAt ?? isoDaysAgo(daysAgo),
    updatedAt: rest.updatedAt ?? isoDaysAgo(daysAgo),
  };
}

beforeEach(() => {
  window.history.replaceState(null, "", "/admin");
  currentFailures = [];
  installFetch();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("admin.tsx — fps-probe failures age UI (Task #2127)", () => {
  it("shows a relative 'Nd ago' badge alongside the absolute timestamp", async () => {
    currentFailures = [
      makeFailure({ id: 11, daysAgo: 3 }),
      makeFailure({ id: 12, daysAgo: 0 }),
    ];
    renderPage();
    await openChannelsTab();

    const old = await screen.findByTestId("text-swing-fps-probe-failure-age-11");
    const fresh = await screen.findByTestId("text-swing-fps-probe-failure-age-12");
    expect(old.textContent).toMatch(/3d ago/);
    // "0 days" can render as "just now" / "Ns ago" / "Nm ago" / "Nh ago"
    // depending on how long the test takes to reach this assertion — all
    // four are valid "very recent" strings.
    expect(fresh.textContent).toMatch(/(just now|s ago|m ago|h ago)/);
  });

  it("emphasises rows older than 7 days with a red highlight", async () => {
    currentFailures = [
      makeFailure({ id: 21, daysAgo: 14 }),
      makeFailure({ id: 22, daysAgo: 1 }),
    ];
    renderPage();
    await openChannelsTab();

    const oldRow = await screen.findByTestId("row-swing-fps-probe-failure-21");
    const recentRow = await screen.findByTestId("row-swing-fps-probe-failure-22");
    expect(oldRow.getAttribute("data-old")).toBe("true");
    expect(oldRow.className).toContain("bg-red-500/10");
    expect(recentRow.getAttribute("data-old")).toBe("false");
    expect(recentRow.className).not.toContain("bg-red-500/10");
  });

  it("hides recent rows when the '>7 days' filter is applied", async () => {
    currentFailures = [
      makeFailure({ id: 31, daysAgo: 14 }),
      makeFailure({ id: 32, daysAgo: 2 }),
      makeFailure({ id: 33, daysAgo: 0 }),
    ];
    renderPage();
    const user = await openChannelsTab();

    // Default is "All": every row is in the DOM.
    await screen.findByTestId("row-swing-fps-probe-failure-31");
    await screen.findByTestId("row-swing-fps-probe-failure-32");
    await screen.findByTestId("row-swing-fps-probe-failure-33");

    const sevenDayBtn = await screen.findByTestId("button-swing-fps-probe-failures-min-age-7");
    await act(async () => {
      await user.click(sevenDayBtn);
    });

    // Only the 14-day-old row survives the filter.
    await waitFor(() => {
      expect(screen.queryByTestId("row-swing-fps-probe-failure-32")).toBeNull();
      expect(screen.queryByTestId("row-swing-fps-probe-failure-33")).toBeNull();
    });
    expect(screen.getByTestId("row-swing-fps-probe-failure-31")).toBeTruthy();
    expect(sevenDayBtn.getAttribute("aria-pressed")).toBe("true");
  });

  it("shows a friendly empty-state when no rows match the age filter", async () => {
    currentFailures = [
      makeFailure({ id: 41, daysAgo: 0 }),
      makeFailure({ id: 42, daysAgo: 1 }),
    ];
    renderPage();
    const user = await openChannelsTab();

    await screen.findByTestId("row-swing-fps-probe-failure-41");

    const thirtyDayBtn = await screen.findByTestId("button-swing-fps-probe-failures-min-age-30");
    await act(async () => {
      await user.click(thirtyDayBtn);
    });

    const empty = await screen.findByTestId("text-swing-fps-probe-failures-filter-empty");
    expect(empty.textContent).toMatch(/older than 30 days/);
    // Rows are gone; the panel-level "no failures" message should not
    // appear (because the underlying dataset still has rows).
    expect(screen.queryByTestId("row-swing-fps-probe-failure-41")).toBeNull();
    expect(screen.queryByTestId("text-swing-fps-probe-failures-empty")).toBeNull();
  });
});
