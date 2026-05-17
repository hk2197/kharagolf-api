/**
 * Task #1969 — UI smoke test for the WoW drift snooze history disclosure.
 *
 * The drift tile already shows a single "Last acknowledged by …" line
 * (Task #1578); this disclosure expands it into the 20 most recent rows
 * for the caller's org so admins can do postmortems without dropping into
 * the database.
 *
 * Catches:
 *   - the disclosure does not render when no acknowledgment has ever been
 *     recorded (the parent line is its anchor),
 *   - opening the disclosure triggers the lazy fetch of the history
 *     endpoint (it must not run on initial render),
 *   - each entry shows actor name + role + snoozeDays + a timestamp.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent, within } from "@testing-library/react";
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
  id: 42, name: "Pine Valley", slug: "pinevalley", description: null,
  logoUrl: null, primaryColor: "#1e4d2b", customDomain: null,
  subscriptionTier: "enterprise", isActive: true, contactEmail: null,
  contactPhone: null, address: null, website: null, defaultLanguage: "en",
};

interface Ack {
  acknowledgedAt: string;
  acknowledgedByName: string | null;
  acknowledgedByRole: string | null;
  snoozeDays: number;
}

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
  org: {
    id: number;
    name: string | null;
    lastSentAt: string | null;
    nextEligibleAt: string | null;
    lastAcknowledgment: Ack | null;
  } | null;
}

function installFetch(opts: { drift: DriftSnapshot; history?: { entries: Ack[] } | null }) {
  const historyFetch = vi.fn((_input: RequestInfo | URL) =>
    jsonResponse({
      evaluatedAt: "2026-04-24T00:00:00Z",
      organizationId: 42,
      limit: 20,
      entries: opts.history?.entries ?? [],
    }),
  );
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
              baseCurrency: "INR", usesStripe: false, secretKeyConfigured: false,
              webhookSecretConfigured: false, webhookEndpoint: "/api/stripe/webhook",
              warning: false, setupInstructions: null,
            },
          },
        });
      }
      if (url.endsWith("/api/admin/wearable-reauth-alert-settings")) {
        return jsonResponse({
          orgId: 42,
          settings: {
            minCount: 5, minSharePct: 25, minAttempted: 4,
            wowMinDelta: null, email: null,
          },
          defaults: {
            minCount: 5, minSharePct: 25, minAttempted: 4,
            wowMinDelta: 1, fallbackEmail: null,
          },
        });
      }
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
      // Order matters: the more-specific `/history` path must match before
      // the snapshot path that's a strict prefix of it.
      if (url.includes("/api/admin/wellness-reauth-wow-drift/history")) {
        return historyFetch(input);
      }
      // Task #1577 trend chart endpoint — same prefix, different suffix.
      // The chart isn't under test here, so a permissive empty payload is
      // enough to keep the page from blowing up.
      if (url.includes("/api/admin/wellness-reauth-wow-drift-history")) {
        return jsonResponse({
          evaluatedAt: "2026-04-24T00:00:00Z",
          windowDays: 7, weeks: 0, threshold: 1, minRuns: 24, buckets: [],
        });
      }
      if (url.endsWith("/api/admin/wellness-reauth-wow-drift")) {
        return jsonResponse(opts.drift);
      }
      // The fps probe failures tile is a sibling row that reads
      // `failureCount` / `failures.length` directly; missing data crashes
      // <SettingsPage> before the disclosure ever mounts.
      if (url.includes("/api/admin/swing-fps-probe-failures")) {
        return jsonResponse({ failureCount: 0, failures: [] });
      }
      // Notification templates expander reads `.keys.length`, so it must
      // return the right shape.
      if (url.endsWith("/api/admin/notification-templates")) {
        return jsonResponse({ keys: [], previews: {} });
      }
      return jsonResponse({}, 200);
    }),
  );
  return { historyFetch };
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

const BASE_DRIFT: DriftSnapshot = {
  evaluatedAt: "2026-04-24T00:00:00Z",
  windowDays: 7, rateLimitDays: 7,
  thisWeek: { runs: 168, averageNeedsReauth: 0, totalNeedsReauth: 0 },
  lastWeek: { runs: 168, averageNeedsReauth: 0, totalNeedsReauth: 0 },
  delta: 0, threshold: 1, minRuns: 24,
  hasSufficientData: true, exceedsThreshold: false,
  org: {
    id: 42, name: "Pine Valley", lastSentAt: null,
    nextEligibleAt: null, lastAcknowledgment: null,
  },
};

describe("admin.tsx — wellness re-auth WoW drift snooze history (Task #1969)", () => {
  it("hides the disclosure when no acknowledgments have ever been recorded", async () => {
    installFetch({
      drift: { ...BASE_DRIFT, org: { ...BASE_DRIFT.org!, lastAcknowledgment: null } },
    });
    renderPage();
    await gotoChannelsSection();
    await screen.findByTestId("row-wellness-reauth-wow-drift");
    // The disclosure is anchored to the "Last acknowledged" line and only
    // renders when there is at least one ack.
    expect(screen.queryByTestId("disclosure-wellness-reauth-wow-drift-history")).not.toBeInTheDocument();
  });

  it("renders the disclosure but only fetches history after the admin opens it", async () => {
    const ack: Ack = {
      acknowledgedAt: "2026-04-22T10:00:00Z",
      acknowledgedByName: "Alice Admin", acknowledgedByRole: "org_admin", snoozeDays: 7,
    };
    const { historyFetch } = installFetch({
      drift: {
        ...BASE_DRIFT,
        org: { ...BASE_DRIFT.org!, lastAcknowledgment: ack },
      },
      history: {
        entries: [
          ack,
          { acknowledgedAt: "2026-04-15T09:00:00Z", acknowledgedByName: "Tom Director", acknowledgedByRole: "tournament_director", snoozeDays: 14 },
          { acknowledgedAt: "2026-04-08T08:00:00Z", acknowledgedByName: null, acknowledgedByRole: null, snoozeDays: 1 },
        ],
      },
    });
    renderPage();
    await gotoChannelsSection();

    const disclosure = await screen.findByTestId("disclosure-wellness-reauth-wow-drift-history");
    // Lazy: the history endpoint should not have been called yet.
    expect(historyFetch).not.toHaveBeenCalled();

    // Open the <details>; React's onToggle fires once the open attribute
    // flips, which triggers the `enabled`-gated React Query call.
    // jsdom doesn't fire `toggle` automatically when `.open` is set, and
    // testing-library has no `fireEvent.toggle` helper, so dispatch the
    // event by hand.
    (disclosure as HTMLDetailsElement).open = true;
    fireEvent(disclosure, new Event("toggle", { bubbles: false }));

    await waitFor(() => {
      expect(historyFetch).toHaveBeenCalledTimes(1);
    });
    const list = await screen.findByTestId("list-wellness-reauth-wow-drift-history");
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(3);

    // Row 0: full name + role + snooze duration are all surfaced.
    expect(screen.getByTestId("text-wellness-reauth-wow-drift-history-name-0")).toHaveTextContent("Alice Admin");
    expect(screen.getByTestId("text-wellness-reauth-wow-drift-history-role-0")).toHaveTextContent("org_admin");
    expect(screen.getByTestId("text-wellness-reauth-wow-drift-history-snooze-0")).toHaveTextContent(/snoozed 7 days/);

    // Row 1: tournament director, plural day suffix, different name.
    expect(screen.getByTestId("text-wellness-reauth-wow-drift-history-name-1")).toHaveTextContent("Tom Director");
    expect(screen.getByTestId("text-wellness-reauth-wow-drift-history-snooze-1")).toHaveTextContent(/snoozed 14 days/);

    // Row 2: null name renders the fallback, null role hides the role span,
    // singular day suffix on snoozeDays === 1.
    expect(screen.getByTestId("text-wellness-reauth-wow-drift-history-name-2")).toHaveTextContent("an admin");
    expect(screen.queryByTestId("text-wellness-reauth-wow-drift-history-role-2")).not.toBeInTheDocument();
    expect(screen.getByTestId("text-wellness-reauth-wow-drift-history-snooze-2")).toHaveTextContent(/snoozed 1 day/);
  });

  it("shows an empty-state message when the history endpoint returns no rows", async () => {
    const ack: Ack = {
      acknowledgedAt: "2026-04-22T10:00:00Z",
      acknowledgedByName: "Alice Admin", acknowledgedByRole: "org_admin", snoozeDays: 7,
    };
    installFetch({
      drift: {
        ...BASE_DRIFT,
        org: { ...BASE_DRIFT.org!, lastAcknowledgment: ack },
      },
      history: { entries: [] },
    });
    renderPage();
    await gotoChannelsSection();

    const disclosure = await screen.findByTestId("disclosure-wellness-reauth-wow-drift-history");
    (disclosure as HTMLDetailsElement).open = true;
    fireEvent(disclosure, new Event("toggle", { bubbles: false }));

    expect(await screen.findByTestId("text-wellness-reauth-wow-drift-history-empty"))
      .toHaveTextContent(/No snooze history/);
  });
});
