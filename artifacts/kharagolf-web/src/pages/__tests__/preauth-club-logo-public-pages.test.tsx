/**
 * Task #2188 — UI tests for the pre-auth club logo on the rest of the
 * public-facing surfaces a player meets before signing in.
 *
 * Task #1756 wired the logo into login / register / forgot-password
 * pages. The same `<PreAuthBrand />` mark must now also brand:
 *
 *   - the public event registration form (`/public/register/...`),
 *     which links from club-branded emails with `?org=<slug>` so the
 *     URL slug heuristic resolves the inviting club;
 *   - the league-join landing page (`/leagues/join`), which carries
 *     an explicit `organizationId` from the invite token and so must
 *     hit the by-id endpoint and update the in-card header logo +
 *     name once the invite resolves;
 *   - the player portal's pre-auth views (login / register / forgot /
 *     verify-sent / claim) under `/portal`, which players land on from
 *     magic-link and email-confirmation CTAs.
 *
 * In every case the page must fall back to the KHARAGOLF default mark
 * when no club is in scope or the lookup misses — matching the
 * unbranded login behaviour.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";

vi.mock("wouter", () => ({
  useLocation: () => ["/", () => {}],
  useParams: () => ({ eventType: "tournament", eventId: "123" }),
  useSearch: () => "?invite=tok-1",
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (k: string, opts?: Record<string, unknown>) => {
      if (opts && "label" in opts) return `${k}:${opts.label as string}`;
      return k;
    },
    i18n: { language: "en" },
  }),
  Trans: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import PublicRegFormPage from "../public-reg-form";
import LeagueJoin from "../league-join";

interface FetchHistory {
  brandingBySlug: number;
  brandingByOrgId: number;
  formFields: number;
  invite: number;
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

interface BrandingResponse {
  organizationId: number;
  slug: string;
  name: string;
  logoUrl: string | null;
  faviconUrl: string | null;
  primaryColor: string | null;
}

interface Handlers {
  bySlug?: (slug: string) => { branding: BrandingResponse | null };
  byOrgId?: (orgId: string) => { branding: BrandingResponse | null };
  invite?: () => unknown;
  formFields?: () => unknown;
}

function installFetch(handlers: Handlers) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      const slugMatch = url.match(/\/api\/public\/orgs\/by-slug\/([^/]+)\/branding/);
      if (slugMatch) {
        history.brandingBySlug += 1;
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
      if (url.includes("/api/public/event-forms/")) {
        history.formFields += 1;
        return jsonResponse(handlers.formFields ? handlers.formFields() : []);
      }
      if (url.includes("/api/public/invitations/")) {
        history.invite += 1;
        return jsonResponse(handlers.invite ? handlers.invite() : { error: "missing" }, { status: handlers.invite ? 200 : 404 });
      }
      return jsonResponse({ error: "unmocked", url }, { status: 404 });
    }),
  );
}

function setLocationSearch(path: string, search: string) {
  window.history.replaceState({}, "", `${path}${search}`);
}

beforeEach(() => {
  history = { brandingBySlug: 0, brandingByOrgId: 0, formFields: 0, invite: 0 };
  setLocationSearch("/", "");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("<PublicRegFormPage /> — pre-auth club logo (Task #2188)", () => {
  it("renders the inviting club's logo + name from the ?org=<slug> CTA", async () => {
    setLocationSearch("/public/register/tournament/123", "?org=pinevalley");
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
      formFields: () => [
        { id: 1, fieldType: "short_text", label: "Name", required: true, sortOrder: 1 },
      ],
    });

    render(<PublicRegFormPage />);

    const orgLogo = await waitFor(() => screen.getByTestId("preauth-brand-org-logo"));
    expect(orgLogo).toHaveAttribute("src", "https://cdn.example.com/pinevalley-logo.png");
    expect(screen.getByTestId("preauth-brand-org-name")).toHaveTextContent("Pine Valley Golf Club");
    expect(screen.queryByTestId("preauth-brand-default")).toBeNull();

    await waitFor(() => expect(history.brandingBySlug).toBeGreaterThanOrEqual(1));
    expect(history.brandingByOrgId).toBe(0);
  });

  it("falls back to the default KHARAGOLF mark when no club slug is in the URL", async () => {
    setLocationSearch("/public/register/tournament/123", "");
    installFetch({
      formFields: () => [
        { id: 1, fieldType: "short_text", label: "Name", required: true, sortOrder: 1 },
      ],
    });

    render(<PublicRegFormPage />);

    await waitFor(() => expect(history.formFields).toBe(1));
    expect(screen.getByTestId("preauth-brand-default")).toBeInTheDocument();
    expect(screen.queryByTestId("preauth-brand-org-logo")).toBeNull();
    expect(history.brandingBySlug).toBe(0);
    expect(history.brandingByOrgId).toBe(0);
  });
});

describe("<LeagueJoin /> — pre-auth club logo (Task #2188)", () => {
  it("swaps the in-card logo + name to the inviting club once the invite resolves to an organizationId", async () => {
    setLocationSearch("/leagues/join", "?invite=tok-1");
    installFetch({
      invite: () => ({
        organizationId: 777,
        leagueId: 9,
        tournamentId: null,
        recipientName: null,
        leagueName: "Spring Stableford",
        leagueMembersOnly: false,
        leagueEntryFee: null,
        leagueMemberEntryFee: null,
        leagueCurrency: null,
        tournamentName: null,
        orgName: "Legacy Club",
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      }),
      byOrgId: (orgId) => ({
        branding: orgId === "777" ? {
          organizationId: 777,
          slug: "legacy",
          name: "Legacy Club",
          logoUrl: "https://cdn.example.com/legacy-club.png",
          faviconUrl: null,
          primaryColor: null,
        } : null,
      }),
    });

    render(<LeagueJoin />);

    // The in-card org logo appears once the invite (and then the
    // by-id branding lookup) resolves. Before the invite loads the
    // page falls through to the URL slug heuristic, which is empty
    // here, so no extra by-slug call should have fired by the time
    // the by-id lookup wins.
    const inCardLogo = await waitFor(() => screen.getByTestId("league-join-org-logo"));
    expect(inCardLogo).toHaveAttribute("src", "https://cdn.example.com/legacy-club.png");
    expect(inCardLogo).toHaveAttribute("alt", "Legacy Club logo");

    await waitFor(() => expect(history.brandingByOrgId).toBe(1));
    expect(history.lastByOrgId).toBe("777");
    expect(history.brandingBySlug).toBe(0);
  });

  it("falls back to the default KHARAGOLF wordmark when the invite has no organizationId branding on file", async () => {
    setLocationSearch("/leagues/join", "?invite=tok-1");
    installFetch({
      invite: () => ({
        organizationId: 9999,
        leagueId: 9,
        tournamentId: null,
        recipientName: null,
        leagueName: "Spring Stableford",
        leagueMembersOnly: false,
        leagueEntryFee: null,
        leagueMemberEntryFee: null,
        leagueCurrency: null,
        tournamentName: null,
        orgName: null,
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      }),
      byOrgId: () => ({ branding: null }),
    });

    render(<LeagueJoin />);

    // Wait for the invite to load — once it does, the by-id lookup
    // misses and the page must fall back to the default `/logo.png`
    // mark, never showing a stale `league-join-org-logo`.
    await waitFor(() => expect(history.invite).toBe(1));
    await waitFor(() => expect(history.brandingByOrgId).toBe(1));

    expect(screen.queryByTestId("league-join-org-logo")).toBeNull();
    expect(screen.getByAltText("KharaGolf")).toBeInTheDocument();
  });
});
