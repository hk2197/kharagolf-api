/**
 * Task #1577 — UI smoke test for the N-week re-auth drift trend chart.
 *
 * Companion to artifacts/api-server/src/lib/__tests__/wellness-reauth-wow-drift-history.test.ts
 * (which pins down the API contract). This file covers the UI half: that
 * admin.tsx actually renders the chart container + legend underneath the
 * WoW drift tile when the history endpoint returns data, and that the
 * threshold + per-bucket fields are read from the right paths.
 *
 * Catches regressions like a `data-testid` rename, a conditional flip that
 * hides the chart, or a layout change that drops it from the wellness card.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { cloneElement, isValidElement } from "react";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@workspace/api-client-react", () => ({
  useGetMe: () => ({
    data: { id: 1, organizationId: 42, role: "org_admin" },
  }),
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

// Recharts uses ResponsiveContainer which measures its parent for layout —
// tests run in jsdom without a real layout, so stub it out and inject
// explicit width/height into the chart child. Without this the chart never
// renders its <Bar> cells and the test can't assert on the per-bucket DOM.
vi.mock("recharts", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("recharts");
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: React.ReactElement }) =>
      isValidElement(children)
        ? cloneElement(children as React.ReactElement<Record<string, unknown>>, { width: 400, height: 200 })
        : <>{children}</>,
  };
});

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

const BASE_DRIFT = {
  evaluatedAt: "2026-04-24T00:00:00Z",
  windowDays: 7,
  rateLimitDays: 7,
  thisWeek: { runs: 168, averageNeedsReauth: 1.0, totalNeedsReauth: 168 },
  lastWeek: { runs: 168, averageNeedsReauth: 0.5, totalNeedsReauth: 84 },
  delta: 0.5,
  threshold: 1,
  minRuns: 24,
  hasSufficientData: true,
  exceedsThreshold: false,
  org: { id: 42, name: "Pine Valley", lastSentAt: null, nextEligibleAt: null },
};

interface DriftHistoryBucket {
  weekStart: string;
  weekEnd: string;
  runs: number;
  averageNeedsReauth: number;
  totalNeedsReauth: number;
  hasSufficientData: boolean;
}
interface DriftHistory {
  evaluatedAt: string;
  windowDays: number;
  weeks: number;
  threshold: number;
  minRuns: number;
  buckets: DriftHistoryBucket[];
}

function installFetch(history: DriftHistory | null) {
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
      // The wellness sweep status row is the parent container the drift
      // tile (and therefore the trend chart underneath it) is rendered
      // inside, so it must not be null or the chart won't render.
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
        return jsonResponse(BASE_DRIFT);
      }
      if (url.endsWith("/api/admin/wellness-reauth-wow-drift-history")) {
        return history === null ? jsonResponse({}, 500) : jsonResponse(history);
      }
      // Notification templates expander reads `.keys.length`, so it must
      // return the right shape even though the chart test doesn't care
      // about it; otherwise `<SettingsPage>` throws and the chart never
      // mounts.
      if (url.endsWith("/api/admin/notification-templates")) {
        return jsonResponse({ keys: [], previews: {} });
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

function buildBuckets(weeks: number, averages: number[]): DriftHistoryBucket[] {
  if (averages.length !== weeks) {
    throw new Error(`buildBuckets: expected ${weeks} averages, got ${averages.length}`);
  }
  const day = 24 * 60 * 60 * 1000;
  const now = new Date("2026-04-24T00:00:00Z").getTime();
  const buckets: DriftHistoryBucket[] = [];
  for (let i = 0; i < weeks; i++) {
    const end = new Date(now - (weeks - 1 - i) * 7 * day);
    const start = new Date(end.getTime() - 7 * day);
    buckets.push({
      weekStart: start.toISOString(),
      weekEnd: end.toISOString(),
      runs: 168,
      averageNeedsReauth: averages[i],
      totalNeedsReauth: Math.round(averages[i] * 168),
      hasSufficientData: true,
    });
  }
  return buckets;
}

describe("admin.tsx — wellness re-auth WoW drift trend chart (Task #1577)", () => {
  it("renders the chart with a per-week bar and the legend reflecting the threshold", async () => {
    installFetch({
      evaluatedAt: "2026-04-24T00:00:00Z",
      windowDays: 7,
      weeks: 8,
      threshold: 1.5,
      minRuns: 24,
      buckets: buildBuckets(8, [0.1, 0.2, 0.3, 0.4, 0.5, 1.0, 1.7, 2.4]),
    });
    renderPage();
    await gotoChannelsSection();

    const chart = await screen.findByTestId("chart-wellness-reauth-wow-drift-history");
    expect(chart).toBeInTheDocument();
    expect(screen.getByTestId("label-wellness-reauth-wow-drift-history")).toHaveTextContent(/Trend over last 8 weeks/);
    // Legend surfaces the threshold the cron evaluator would alert on, so
    // admins can read the dashed reference line at a glance.
    expect(chart.textContent).toMatch(/Threshold ≥ 1\.50/);

    // One <Cell> per bucket — distinct testids let the test pin down both
    // the count of bars rendered and that the bucket → DOM mapping is stable.
    // The chart container `findByTestId` above already waited for mount, so
    // the bars are guaranteed to be in the DOM by now.
    expect(screen.getAllByTestId(/^bar-wellness-reauth-wow-drift-history-/)).toHaveLength(8);
  });

  it("does not render the chart when the history endpoint returns no buckets", async () => {
    installFetch({
      evaluatedAt: "2026-04-24T00:00:00Z",
      windowDays: 7,
      weeks: 0,
      threshold: 1,
      minRuns: 24,
      buckets: [],
    });
    renderPage();
    await gotoChannelsSection();

    // Wait for the parent tile to render so we know the page settled, then
    // assert the chart is absent.
    await screen.findByTestId("row-wellness-reauth-wow-drift");
    expect(screen.queryByTestId("chart-wellness-reauth-wow-drift-history")).toBeNull();
  });

  it("does not render the chart when the history endpoint fails", async () => {
    installFetch(null);
    renderPage();
    await gotoChannelsSection();

    await screen.findByTestId("row-wellness-reauth-wow-drift");
    expect(screen.queryByTestId("chart-wellness-reauth-wow-drift-history")).toBeNull();
  });
});
