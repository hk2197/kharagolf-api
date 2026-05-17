/**
 * Task #1756 — UI tests for the pre-auth club logo.
 *
 * Mounts <LoginPage /> and <PreAuthBrand /> after seeding
 * `window.location` and stubbing the public branding endpoints so we
 * can exercise the full pre-auth contract:
 *   - When `?org=<slug>` resolves to a branded org, the login page
 *     renders the club's logo + name instead of the default KHARAGOLF
 *     wordmark.
 *   - When an explicit `orgId` is passed (the register-page case),
 *     the by-id endpoint is used and the legacy
 *     `organizations.logoUrl` fallback is honoured — clubs that never
 *     saved a customised theme row still see their saved logo.
 *   - When no club is in scope (or the lookup misses), the default
 *     KHARAGOLF mark is preserved so the unbranded login still works.
 *
 * Server-side resolution (slug/id → branding row) is exercised
 * separately by the API server's public-route tests.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";

vi.mock("wouter", () => ({
  useLocation: () => ["/login", () => {}],
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

import LoginPage from "../login";
import { PreAuthBrand } from "@/components/PreAuthBrand";

interface FetchHistory {
  brandingByOrg: number;
  brandingByOrgId: number;
  setupCheck: number;
  lastBySlug?: string;
  lastByOrgId?: string;
}
let history: FetchHistory;

function jsonResponse(body: unknown, init: { status?: number } = {}): Promise<Response> {
  return Promise.resolve({
    ok: (init.status ?? 200) < 400,
    status: init.status ?? 200,
    json: () => Promise.resolve(body),
  } as Response);
}

interface BrandingHandlers {
  bySlug?: (slug: string) => unknown;
  byOrgId?: (orgId: string) => unknown;
}

function installFetch(handlers: BrandingHandlers) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      const slugMatch = url.match(/\/api\/public\/orgs\/by-slug\/([^/]+)\/branding/);
      if (slugMatch) {
        history.brandingByOrg += 1;
        const slug = decodeURIComponent(slugMatch[1]);
        history.lastBySlug = slug;
        return jsonResponse(handlers.bySlug ? handlers.bySlug(slug) : { branding: null });
      }
      const orgIdMatch = url.match(/\/api\/public\/orgs\/by-id\/([^/]+)\/branding/);
      if (orgIdMatch) {
        history.brandingByOrgId += 1;
        const orgId = decodeURIComponent(orgIdMatch[1]);
        history.lastByOrgId = orgId;
        return jsonResponse(handlers.byOrgId ? handlers.byOrgId(orgId) : { branding: null });
      }
      if (url.includes("/api/auth/admin-setup-check")) {
        history.setupCheck += 1;
        return jsonResponse({ setupAvailable: false });
      }
      return jsonResponse({ error: "unmocked", url }, { status: 404 });
    }),
  );
}

function setLocationSearch(search: string) {
  // jsdom's location.search is read-only; replaceState gives us the
  // same observable URL via window.location.search without navigating.
  window.history.replaceState({}, "", `/login${search}`);
}

beforeEach(() => {
  history = { brandingByOrg: 0, brandingByOrgId: 0, setupCheck: 0 };
  setLocationSearch("");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("<LoginPage /> — pre-auth club logo (Task #1756)", () => {
  it("renders the club's logo and name when ?org=<slug> resolves to a branded org", async () => {
    setLocationSearch("?org=pinevalley");
    installFetch({
      bySlug: (slug) => ({
        branding: slug === "pinevalley" ? {
          organizationId: 42,
          slug: "pinevalley",
          name: "Pine Valley Golf Club",
          logoUrl: "https://cdn.example.com/pinevalley-logo.png",
          faviconUrl: null,
          primaryColor: "#102030",
        } : null,
      }),
    });

    render(<LoginPage />);

    // Wait for the lookup to complete and the org mark to swap in.
    const orgLogo = await waitFor(() => screen.getByTestId("preauth-brand-org-logo"));
    expect(orgLogo).toHaveAttribute("src", "https://cdn.example.com/pinevalley-logo.png");
    expect(orgLogo).toHaveAttribute("alt", "Pine Valley Golf Club logo");
    expect(screen.getByTestId("preauth-brand-org-name")).toHaveTextContent("Pine Valley Golf Club");

    // The default KHARAGOLF mark must NOT also be rendered above the
    // form when an org logo took its place — otherwise the page shows
    // two competing brand marks and the player sees the wrong one
    // first.
    expect(screen.queryByTestId("preauth-brand-default")).toBeNull();

    // Only one branding lookup should fire per slug.
    await waitFor(() => expect(history.brandingByOrg).toBe(1));
    // by-slug lookup, not by-id
    expect(history.brandingByOrgId).toBe(0);
  });

  it("falls back to the default KHARAGOLF mark when no slug is in the URL", async () => {
    installFetch({});

    render(<LoginPage />);

    // Default mark is rendered immediately; no branding lookup fires
    // because no slug could be resolved.
    expect(screen.getByTestId("preauth-brand-default")).toBeInTheDocument();
    expect(screen.queryByTestId("preauth-brand-org-logo")).toBeNull();

    // Settle the admin-setup-check fetch + a microtask so the (skipped)
    // branding effect has a chance to no-op.
    await waitFor(() => expect(history.setupCheck).toBeGreaterThanOrEqual(1));
    expect(history.brandingByOrg).toBe(0);
    expect(history.brandingByOrgId).toBe(0);
  });

  it("falls back to the default mark when the slug doesn't match a club", async () => {
    setLocationSearch("?org=unknown-club");
    installFetch({ bySlug: () => ({ branding: null }) });

    render(<LoginPage />);

    // Default mark is rendered both immediately and after the lookup
    // resolves to `branding: null`.
    expect(screen.getByTestId("preauth-brand-default")).toBeInTheDocument();
    await waitFor(() => expect(history.brandingByOrg).toBe(1));
    expect(screen.queryByTestId("preauth-brand-org-logo")).toBeNull();
    expect(screen.getByTestId("preauth-brand-default")).toBeInTheDocument();
  });
});

describe("<PreAuthBrand orgId> — register & reset-password explicit-orgId flow (Task #1756)", () => {
  it("uses the by-id endpoint and renders the legacy org logo even when the theme row isn't customised", async () => {
    // Simulates the register page passing tournament.organizationId.
    // The server returns the legacy `organizations.logoUrl` because
    // the club never saved a customised theme row — the regression
    // the code review caught: this case was previously dropped on
    // the floor by the old `/api/organizations/:orgId/theming` path.
    installFetch({
      byOrgId: (orgId) => ({
        branding: orgId === "777" ? {
          organizationId: 777,
          slug: "legacyclub",
          name: "Legacy Club",
          // logoUrl set, but customised theme row would be absent —
          // the public by-id endpoint normalises both cases into the
          // same response, so the hook just sees a usable logoUrl.
          logoUrl: "https://cdn.example.com/legacy-club.png",
          faviconUrl: null,
          primaryColor: null,
        } : null,
      }),
    });

    render(<PreAuthBrand size="md" orgId={777} />);

    const orgLogo = await waitFor(() => screen.getByTestId("preauth-brand-org-logo"));
    expect(orgLogo).toHaveAttribute("src", "https://cdn.example.com/legacy-club.png");
    expect(screen.getByTestId("preauth-brand-org-name")).toHaveTextContent("Legacy Club");
    expect(screen.queryByTestId("preauth-brand-default")).toBeNull();

    // by-id endpoint, not by-slug
    await waitFor(() => expect(history.brandingByOrgId).toBe(1));
    expect(history.lastByOrgId).toBe("777");
    expect(history.brandingByOrg).toBe(0);
  });

  it("falls back to the default mark when the orgId lookup misses (and never queries by slug)", async () => {
    installFetch({ byOrgId: () => ({ branding: null }) });

    render(<PreAuthBrand size="md" orgId={9999} />);

    expect(screen.getByTestId("preauth-brand-default")).toBeInTheDocument();
    await waitFor(() => expect(history.brandingByOrgId).toBe(1));
    expect(history.brandingByOrg).toBe(0);
    expect(screen.queryByTestId("preauth-brand-org-logo")).toBeNull();
  });

  it("uses slug detection on the reset-password flow when no orgId is passed", async () => {
    // The reset-password page renders <PreAuthBrand /> with no orgId,
    // so it should fall through to the URL slug heuristic the same
    // way the login page does.
    setLocationSearch("?org=pinevalley");
    installFetch({
      bySlug: (slug) => ({
        branding: slug === "pinevalley" ? {
          organizationId: 42,
          slug: "pinevalley",
          name: "Pine Valley Golf Club",
          logoUrl: "https://cdn.example.com/pinevalley-logo.png",
          faviconUrl: null,
          primaryColor: null,
        } : null,
      }),
    });

    render(<PreAuthBrand size="md" />);

    await waitFor(() => screen.getByTestId("preauth-brand-org-logo"));
    expect(screen.getByTestId("preauth-brand-org-name")).toHaveTextContent("Pine Valley Golf Club");
    await waitFor(() => expect(history.brandingByOrg).toBe(1));
    expect(history.brandingByOrgId).toBe(0);
  });
});
