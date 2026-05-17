/**
 * Task #1482 — UI tests for the "your snooze just ended" banner in the
 * admin custom-domain panel (admin.tsx → CustomDomainCertStatus).
 *
 * Task #1262 added an email header acknowledging an elapsed snooze, but
 * an admin who only checks the dashboard (and never opens the email)
 * needs to see the same acknowledgement in-app. The status endpoint
 * surfaces a `snoozeEndedFromUntil` field whenever the most recent
 * re-nudge fired because the admin's snooze had just elapsed; this
 * panel renders a one-line banner above the failure summary while the
 * field is set.
 *
 * These tests pin down the contract:
 *   - When `snoozeEndedFromUntil` is set, the banner is visible above
 *     the failure summary and quotes the elapsed snooze date.
 *   - When `snoozeEndedFromUntil` is null, the banner is not rendered.
 *   - The banner does not interfere with the snooze controls below
 *     (which key off `renudgeSnoozedUntil`, not the banner).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@workspace/api-client-react", () => ({
  useGetMe: () => ({
    data: { id: 1, organizationId: 42, role: "org_admin" },
  }),
}));

const toastMock = vi.fn();
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: toastMock }),
}));

import SettingsPage from "../admin";

interface Org {
  id: number;
  name: string;
  slug: string;
  description: string | null;
  logoUrl: string | null;
  primaryColor: string | null;
  customDomain: string | null;
  subscriptionTier: string;
  isActive: boolean;
  contactEmail: string | null;
  contactPhone: string | null;
  address: string | null;
  website: string | null;
  defaultLanguage: string | null;
}

interface CertState {
  customDomain: string | null;
  status: "none" | "pending" | "active" | "failed";
  provider: string | null;
  error: string | null;
  requestedAt: string | null;
  issuedAt: string | null;
  checkedAt: string | null;
  notifiedStatus: "active" | "failed" | null;
  notifiedHost: string | null;
  notifiedAt: string | null;
  nextRenudgeAt: string | null;
  renudgeSnoozedUntil: string | null;
  snoozeEndedFromUntil: string | null;
}

let currentOrg: Org;
let certState: CertState;

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve({
    ok: status < 400,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response);
}

function makeOrg(overrides: Partial<Org> = {}): Org {
  return {
    id: 42,
    name: "Pine Valley",
    slug: "pinevalley",
    description: null,
    logoUrl: null,
    primaryColor: "#1e4d2b",
    customDomain: "golf.pinevalley.com",
    subscriptionTier: "enterprise",
    isActive: true,
    contactEmail: null,
    contactPhone: null,
    address: null,
    website: null,
    defaultLanguage: "en",
    ...overrides,
  };
}

function makeCertState(overrides: Partial<CertState> = {}): CertState {
  return {
    customDomain: "golf.pinevalley.com",
    status: "failed",
    provider: "letsencrypt",
    error: "Could not provision certificate (DNS lookup failed).",
    requestedAt: "2026-04-20T08:00:00.000Z",
    issuedAt: null,
    checkedAt: "2026-04-29T08:00:00.000Z",
    notifiedStatus: "failed",
    notifiedHost: "golf.pinevalley.com",
    notifiedAt: "2026-04-29T08:00:00.000Z",
    nextRenudgeAt: "2026-05-06T08:00:00.000Z",
    renudgeSnoozedUntil: null,
    snoozeEndedFromUntil: null,
    ...overrides,
  };
}

beforeEach(() => {
  toastMock.mockReset();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-04-29T12:00:00.000Z"));

  currentOrg = makeOrg();
  certState = makeCertState();

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = (init?.method ?? "GET").toUpperCase();

      if (url.endsWith("/api/organizations/42") && method === "GET") {
        return jsonResponse(currentOrg);
      }
      if (url.endsWith("/api/organizations/42/custom-domain/status")
          && method === "GET") {
        return jsonResponse(certState);
      }
      // The reachability panel auto-runs verify on mount; failing it
      // silently keeps these tests focused on the cert-status panel.
      if (url.endsWith("/api/organizations/42/marketing-site/verify-domain")) {
        return jsonResponse({ error: "skipped" }, 503);
      }
      return jsonResponse({}, 404);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function gotoDomainSection() {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchInterval: false, staleTime: 0 },
      mutations: { retry: false },
    },
  });
  render(
    <QueryClientProvider client={qc}>
      <SettingsPage />
    </QueryClientProvider>,
  );
  const navBtn = await screen.findByRole("button", { name: /custom domain/i });
  fireEvent.click(navBtn);
  await screen.findByRole("button", { name: /save domain/i });
}

describe("admin.tsx — snooze-ended banner (Task #1482)", () => {
  it("renders the banner above the failure summary when snoozeEndedFromUntil is set", async () => {
    // Snooze that elapsed 2 days ago — exactly the case the cron just
    // fired the snooze-ended re-nudge for, so the server still surfaces
    // the field within its short freshness window.
    certState = makeCertState({
      snoozeEndedFromUntil: "2026-04-27T08:00:00.000Z",
    });

    await gotoDomainSection();

    const banner = await screen.findByTestId("cert-status-snooze-ended-banner");
    expect(banner).toBeVisible();
    // The English string includes the literal "snooze has now ended"
    // phrase from admin.json + the localised snoozedUntil date.
    expect(banner.textContent).toMatch(/snooze has now ended/);

    // Banner must come before the existing failure summary so an admin
    // sees the acknowledgement *first* when scanning the panel.
    const card = screen.getByTestId("custom-domain-cert-status");
    const error = screen.getByTestId("cert-status-error");
    const bannerIdx = Array.from(card.children).indexOf(banner);
    const errorIdx = Array.from(card.children).indexOf(error);
    expect(bannerIdx).toBeGreaterThanOrEqual(0);
    expect(errorIdx).toBeGreaterThanOrEqual(0);
    expect(bannerIdx).toBeLessThan(errorIdx);
  });

  it("does not render the banner when snoozeEndedFromUntil is null", async () => {
    certState = makeCertState({ snoozeEndedFromUntil: null });

    await gotoDomainSection();

    // Wait for the panel to mount before asserting absence.
    await screen.findByTestId("cert-status-error");
    expect(screen.queryByTestId("cert-status-snooze-ended-banner")).toBeNull();
  });

  it("can render alongside the snooze button (banner gates on its own field)", async () => {
    // Snooze just elapsed → banner showing AND no active snooze
    // → snooze button visible. The two surfaces key off independent
    // fields and must not interfere.
    certState = makeCertState({
      snoozeEndedFromUntil: "2026-04-27T08:00:00.000Z",
      renudgeSnoozedUntil: null,
    });

    await gotoDomainSection();

    expect(await screen.findByTestId("cert-status-snooze-ended-banner")).toBeVisible();
    expect(await screen.findByTestId("cert-status-snooze")).toBeVisible();
  });
});
