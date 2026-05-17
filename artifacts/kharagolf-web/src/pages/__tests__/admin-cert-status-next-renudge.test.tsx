/**
 * Task #1256 — UI test for the HTTPS re-nudge ETA line in the admin
 * custom-domain panel (admin.tsx → CustomDomainCertStatus).
 *
 * Task #1100 wired up a `cert-status-next-renudge` line that tells admins
 * roughly when the platform will email them again about a still-failing
 * HTTPS cert (or that no re-nudge is currently scheduled). The API field
 * has its own server tests, but until now nothing verified that the line
 * actually rendered with the right relative phrasing.
 *
 * This file seeds an org into the "HTTPS failed and notified N days ago"
 * state, opens the Custom Domain section, and asserts the line is visible
 * with the expected phrasing for both the scheduled ("in X days") and
 * unscheduled ("No re-nudge scheduled") branches.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
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
    checkedAt: "2026-04-24T08:00:00.000Z",
    notifiedStatus: "failed",
    notifiedHost: "golf.pinevalley.com",
    notifiedAt: "2026-04-21T08:00:00.000Z",
    nextRenudgeAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  toastMock.mockReset();
  // Pin Date.now() / new Date() so the relative phrasing ("in 3 days")
  // is deterministic — but don't fake setTimeout/setInterval, otherwise
  // react-query's internal scheduling stalls and waitFor() hangs.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-04-24T12:00:00.000Z"));

  currentOrg = makeOrg();
  certState = makeCertState();

  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = (init?.method ?? "GET").toUpperCase();

      if (url.endsWith("/api/organizations/42") && method === "GET") {
        return jsonResponse(currentOrg);
      }

      if (url.endsWith("/api/organizations/42/custom-domain/status")
          && method === "GET") {
        return jsonResponse(certState);
      }

      // The reachability panel auto-runs a verify on mount; failing it
      // silently keeps the test focused on the cert-status panel.
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

describe("admin.tsx — HTTPS re-nudge ETA line (Task #1256)", () => {
  it("renders the scheduled re-nudge with relative 'in X days' phrasing when the cert is failing", async () => {
    // ~3 days after the pinned "now" — within the >48h "days" branch of
    // formatNextRenudge so the i18n string falls back to nextRenudgeDays.
    certState = makeCertState({
      nextRenudgeAt: "2026-04-27T12:00:00.000Z",
    });

    await gotoDomainSection();

    const line = await screen.findByTestId("cert-status-next-renudge");
    expect(line).toBeVisible();
    // Sentence shape from admin.json en: "Next reminder in 3 days (…)".
    expect(line.textContent).toMatch(/Next reminder in 3 days/);

    // Sanity-check the panel context: failed badge is what makes the line
    // visible in the first place.
    expect(screen.getByTestId("cert-status-badge-failed")).toBeInTheDocument();
  });

  it("collapses sub-day distances into 'in X hours' phrasing", async () => {
    // 5 hours after "now" — exercises the hours branch of formatNextRenudge.
    certState = makeCertState({
      nextRenudgeAt: "2026-04-24T17:00:00.000Z",
    });

    await gotoDomainSection();

    const line = await screen.findByTestId("cert-status-next-renudge");
    expect(line.textContent).toMatch(/Next reminder in 5 hours/);
  });

  it("shows the 'No re-nudge scheduled' fallback when nextRenudgeAt is null", async () => {
    certState = makeCertState({ nextRenudgeAt: null });

    await gotoDomainSection();

    const line = await screen.findByTestId("cert-status-next-renudge");
    expect(line).toBeVisible();
    expect(line.textContent).toMatch(/No re-nudge scheduled/);
  });

  it("does not render the re-nudge line when the cert is healthy (status === 'active')", async () => {
    certState = makeCertState({
      status: "active",
      issuedAt: "2026-04-22T08:00:00.000Z",
      error: null,
      notifiedStatus: "active",
      // Server would not send a re-nudge for a healthy cert, but even if
      // it did the UI must not surface a misleading reminder ETA next to
      // the green "HTTPS Active" badge.
      nextRenudgeAt: "2026-04-27T12:00:00.000Z",
    });

    await gotoDomainSection();

    // Wait for the panel to mount (active badge renders) before asserting
    // the absence of the re-nudge line — otherwise the assertion could
    // pass simply because the query hadn't resolved yet.
    await screen.findByTestId("cert-status-badge-active");
    expect(screen.queryByTestId("cert-status-next-renudge")).toBeNull();
  });
});
