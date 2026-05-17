/**
 * Task #1324 — UI smoke test for the week-over-week re-auth drift tile.
 *
 * Companion to artifacts/api-server/src/lib/__tests__/wellness-reauth-wow-drift-snapshot.test.ts
 * (which pins down the API contract). This file covers the UI half: that
 * admin.tsx actually renders the tile when the drift snapshot endpoint
 * returns data, and that the badge / delta / threshold / watermark fields
 * read the right paths off the response.
 *
 * Catches regressions like a `data-testid` rename, a conditional flip, or
 * a layout change that drops the tile.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
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

interface DriftSnapshot {
  evaluatedAt: string;
  windowDays: number;
  rateLimitDays: number;
  thisWeek: { runs: number; averageNeedsReauth: number; totalNeedsReauth: number };
  lastWeek: { runs: number; averageNeedsReauth: number; totalNeedsReauth: number };
  delta: number;
  threshold: number;
  minRuns: number;
  hasSufficientData: boolean;
  exceedsThreshold: boolean;
  org: { id: number; name: string | null; lastSentAt: string | null; nextEligibleAt: string | null } | null;
}

function installFetch(drift: DriftSnapshot) {
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
          payments: {
            stripe: {
              baseCurrency: "INR",
              usesStripe: false,
              secretKeyConfigured: false,
              webhookSecretConfigured: false,
              webhookEndpoint: "/api/stripe/webhook",
              warning: false,
              setupInstructions: null,
            },
          },
        });
      }
      if (url.endsWith("/api/admin/wearable-reauth-alert-settings")) {
        return jsonResponse({
          orgId: 42,
          settings: { minCount: 5, minSharePct: 25, minAttempted: 4, email: null },
          defaults: { minCount: 5, minSharePct: 25, minAttempted: 4, fallbackEmail: null },
        });
      }
      // The wellness sweep status row is the parent container the drift tile
      // is rendered inside, so it must not be null or the tile won't render.
      if (url.endsWith("/api/admin/wellness-sweep-status")) {
        return jsonResponse({
          lastSweep: {
            attempted: 50, succeeded: 48, needsReauth: 2,
            ranAt: new Date("2026-04-20T00:00:00Z").toISOString(),
            alerted: false,
          },
        });
      }
      if (url.includes("/api/admin/wellness-sweep-history")) {
        return jsonResponse({ days: 30, runs: [] });
      }
      if (url.endsWith("/api/admin/wellness-reauth-wow-drift")) {
        return jsonResponse(drift);
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

async function gotoChannelsSection() {
  // The drift tile lives under the "Communication Channels" section, which is
  // not the default-active section. Click the sidebar entry to switch to it.
  // The sidebar button text comes from the i18n key admin:sections.commChannels;
  // the test i18n stub typically returns the key itself, so match either.
  const channelsButton = await screen.findByRole("button", {
    name: /comm channels|communication channels|sections\.commChannels/i,
  });
  fireEvent.click(channelsButton);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const BASE_DRIFT: DriftSnapshot = {
  evaluatedAt: "2026-04-24T00:00:00Z",
  windowDays: 7,
  rateLimitDays: 7,
  thisWeek: { runs: 168, averageNeedsReauth: 0, totalNeedsReauth: 0 },
  lastWeek: { runs: 168, averageNeedsReauth: 0, totalNeedsReauth: 0 },
  delta: 0,
  threshold: 1,
  minRuns: 24,
  hasSufficientData: true,
  exceedsThreshold: false,
  org: { id: 42, name: "Pine Valley", lastSentAt: null, nextEligibleAt: null },
};

describe("admin.tsx — wellness re-auth WoW drift tile (Task #1324)", () => {
  it("renders 'Drifting up' badge with the delta and threshold when above threshold", async () => {
    installFetch({
      ...BASE_DRIFT,
      thisWeek: { runs: 168, averageNeedsReauth: 5.5, totalNeedsReauth: 924 },
      lastWeek: { runs: 168, averageNeedsReauth: 1.2, totalNeedsReauth: 201 },
      delta: 4.3,
      threshold: 1,
      hasSufficientData: true,
      exceedsThreshold: true,
      org: {
        id: 42, name: "Pine Valley",
        lastSentAt: "2026-04-22T10:00:00Z",
        nextEligibleAt: "2026-04-29T10:00:00Z",
      },
    });
    renderPage();
    await gotoChannelsSection();

    const tile = await screen.findByTestId("row-wellness-reauth-wow-drift");
    expect(tile).toBeInTheDocument();
    expect(screen.getByTestId("badge-wellness-reauth-wow-drift-status")).toHaveTextContent(/Drifting up/);
    expect(screen.getByTestId("text-wellness-reauth-wow-drift-this-week")).toHaveTextContent("5.50");
    expect(screen.getByTestId("text-wellness-reauth-wow-drift-last-week")).toHaveTextContent("1.20");
    expect(screen.getByTestId("text-wellness-reauth-wow-drift-delta")).toHaveTextContent("+4.30");
    expect(screen.getByTestId("text-wellness-reauth-wow-drift-threshold")).toHaveTextContent(/threshold ≥ 1\.00/);
    // Watermark surfaces both the last-sent-at and the next-eligible-at the
    // cron evaluator's atomic conditional UPDATE will respect.
    const watermark = screen.getByTestId("text-wellness-reauth-wow-drift-watermark");
    expect(watermark.textContent).toMatch(/Last drift email sent/);
    expect(watermark.textContent).toMatch(/next eligible/);
    expect(watermark.textContent).toMatch(/once per 7 days/);
  });

  it("renders 'Steady' badge when WoW delta is under the configured threshold", async () => {
    installFetch({ ...BASE_DRIFT, exceedsThreshold: false });
    renderPage();
    await gotoChannelsSection();

    await screen.findByTestId("row-wellness-reauth-wow-drift");
    expect(screen.getByTestId("badge-wellness-reauth-wow-drift-status")).toHaveTextContent(/Steady/);
    // Delta should not be flagged as orange when under threshold.
    expect(screen.getByTestId("text-wellness-reauth-wow-drift-delta")).toHaveTextContent("0.00");
  });

  it("renders 'Collecting data' badge when fewer than minRuns rows in either window", async () => {
    installFetch({
      ...BASE_DRIFT,
      thisWeek: { runs: 5, averageNeedsReauth: 2, totalNeedsReauth: 10 },
      lastWeek: { runs: 0, averageNeedsReauth: 0, totalNeedsReauth: 0 },
      hasSufficientData: false,
      exceedsThreshold: false,
    });
    renderPage();
    await gotoChannelsSection();

    await screen.findByTestId("row-wellness-reauth-wow-drift");
    expect(screen.getByTestId("badge-wellness-reauth-wow-drift-status")).toHaveTextContent(/Collecting data/);
    expect(screen.getByTestId("text-wellness-reauth-wow-drift-insufficient")).toHaveTextContent(/Need at least 24/);
  });

  it("indicates no drift email has been sent yet when org watermark is null", async () => {
    installFetch({
      ...BASE_DRIFT,
      hasSufficientData: true,
      exceedsThreshold: false,
      org: { id: 42, name: "Pine Valley", lastSentAt: null, nextEligibleAt: null },
    });
    renderPage();
    await gotoChannelsSection();

    await screen.findByTestId("row-wellness-reauth-wow-drift");
    await waitFor(() => {
      const watermark = screen.getByTestId("text-wellness-reauth-wow-drift-watermark");
      expect(watermark.textContent).toMatch(/No drift email has been sent/);
    });
  });
});
