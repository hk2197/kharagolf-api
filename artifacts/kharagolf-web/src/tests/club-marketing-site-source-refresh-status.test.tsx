/**
 * Task #1807 — UI test for the marketing-image source-refresh status
 * panels rendered under each logo / favicon input on the club marketing
 * site editor.
 *
 * The periodic refresh job (Task #1467) writes back the source URL,
 * `sourceLastRefreshedAt`, and `sourceLastRefreshError` columns when it
 * tries to re-download an admin's externally-sourced logo / favicon.
 * The editor must surface those three pieces so admins can spot a stale
 * cached copy and fix or remove the source URL — otherwise the failure
 * stays hidden in the server logs.
 *
 * These tests cover the three render modes:
 *   1. No source URL → panel is hidden entirely.
 *   2. Source URL set, no failure → panel shows the original URL and a
 *      "Last refreshed" line with the formatted timestamp.
 *   3. Source URL set, last refresh failed → panel shows the source URL
 *      plus a plain-language error mentioning the source host, the
 *      verifier error text, and the failure date.
 *
 * Plus an interaction test that confirms the inline "Clear source"
 * button issues a PUT clearing the cached URL (which on the API side
 * also clears the `*SourceUrl` and the refresh tracking columns).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
  within,
} from "@testing-library/react";

vi.mock("@/context/ActiveOrgContext", () => ({
  useActiveOrgId: () => 42,
}));
const stableToast = { toast: vi.fn() };
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => stableToast,
}));

import ClubMarketingSitePage from "@/pages/club-marketing-site";

interface FakeSite {
  id: number;
  organizationId: number;
  theme: string;
  heroImageUrl: string | null;
  heroTitle: string | null;
  heroSubtitle: string | null;
  heroCtaLabel: string | null;
  heroCtaHref: string | null;
  aboutMarkdown: string | null;
  servicesMarkdown: string | null;
  galleryImages: Array<{ url: string; caption?: string | null }>;
  sectionOrder: string[];
  enabledSections: Record<string, boolean>;
  seoTitle: string | null;
  seoDescription: string | null;
  seoOgImageUrl: string | null;
  brandPrimaryColor: string | null;
  brandAccentColor: string | null;
  brandHeadingFont: string | null;
  logoImageUrl: string | null;
  faviconUrl: string | null;
  logoSourceUrl: string | null;
  logoSourceLastRefreshedAt: string | null;
  logoSourceLastRefreshError: string | null;
  faviconSourceUrl: string | null;
  faviconSourceLastRefreshedAt: string | null;
  faviconSourceLastRefreshError: string | null;
  isPublished: boolean;
  publishedAt: string | null;
  cacheVersion: number;
}

function makeSite(overrides: Partial<FakeSite> = {}): FakeSite {
  return {
    id: 1,
    organizationId: 42,
    theme: "classic",
    heroImageUrl: null,
    heroTitle: "Hello",
    heroSubtitle: "tagline",
    heroCtaLabel: "Book",
    heroCtaHref: null,
    aboutMarkdown: null,
    servicesMarkdown: null,
    galleryImages: [],
    sectionOrder: ["hero", "about"],
    enabledSections: { hero: true, about: true },
    seoTitle: null,
    seoDescription: null,
    seoOgImageUrl: null,
    brandPrimaryColor: null,
    brandAccentColor: null,
    brandHeadingFont: null,
    logoImageUrl: null,
    faviconUrl: null,
    logoSourceUrl: null,
    logoSourceLastRefreshedAt: null,
    logoSourceLastRefreshError: null,
    faviconSourceUrl: null,
    faviconSourceLastRefreshedAt: null,
    faviconSourceLastRefreshError: null,
    isPublished: false,
    publishedAt: null,
    cacheVersion: 1,
    ...overrides,
  };
}

let currentSite: FakeSite;
let putBodies: Array<Record<string, unknown>>;

function jsonResponse(body: unknown, init: { status?: number } = {}) {
  return Promise.resolve({
    ok: (init.status ?? 200) < 400,
    status: init.status ?? 200,
    json: () => Promise.resolve(body),
  } as Response);
}

function setupFetch() {
  putBodies = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.endsWith("/api/organizations/42/marketing-site") && method === "GET") {
        return jsonResponse(currentSite);
      }
      if (url.endsWith("/api/organizations/42") && method === "GET") {
        return jsonResponse({ id: 42, slug: "pinevalley" });
      }
      if (url.endsWith("/api/organizations/42/marketing-site/preview-token") && method === "POST") {
        return jsonResponse({ token: "tok_src", expiresInMs: 60 * 60 * 1000 });
      }
      if (url.endsWith("/api/organizations/42/marketing-site") && method === "PUT") {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        putBodies.push(body);
        // Mirror the real PUT handler in marketing-site.ts: saving a
        // new logoImageUrl / faviconUrl always resets the matching
        // *SourceUrl + refresh-tracking columns. The persisted source
        // URL is the original third-party URL that was rehosted (or
        // null for clears / internal /objects/... paths).
        const next: Partial<FakeSite> = { ...body };
        if (Object.prototype.hasOwnProperty.call(body, "logoImageUrl")) {
          next.logoSourceUrl = null;
          next.logoSourceLastRefreshedAt = null;
          next.logoSourceLastRefreshError = null;
        }
        if (Object.prototype.hasOwnProperty.call(body, "faviconUrl")) {
          next.faviconSourceUrl = null;
          next.faviconSourceLastRefreshedAt = null;
          next.faviconSourceLastRefreshError = null;
        }
        currentSite = { ...currentSite, ...next, cacheVersion: currentSite.cacheVersion + 1 };
        return jsonResponse(currentSite);
      }
      return jsonResponse({ error: "unmocked" }, { status: 404 });
    }),
  );
}

beforeEach(() => {
  setupFetch();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ClubMarketingSitePage — logo/favicon source-refresh status (Task #1807)", () => {
  it("hides the source-status panel when there is no external source URL", async () => {
    currentSite = makeSite({
      // Direct upload — internal /objects/... path, no upstream to track.
      logoImageUrl: "/objects/uploads/upload-1",
      faviconUrl: null,
    });
    render(<ClubMarketingSitePage />);

    // Wait for initial render to settle.
    await screen.findByTestId("input-logo-image-url");

    expect(screen.queryByTestId("logo-source-status")).toBeNull();
    expect(screen.queryByTestId("favicon-source-status")).toBeNull();
  });

  it("shows the original source URL + last refreshed date when refresh succeeded", async () => {
    currentSite = makeSite({
      logoImageUrl: "https://api.kharagolf.test/api/storage/objects/marketing-cache/42/logo-abc.png",
      logoSourceUrl: "https://cdn.example.com/club-logo.png",
      logoSourceLastRefreshedAt: "2026-04-27T10:00:00Z",
      logoSourceLastRefreshError: null,
    });
    render(<ClubMarketingSitePage />);

    const panel = await screen.findByTestId("logo-source-status");
    // Source URL is rendered as a link to the original.
    const link = within(panel).getByTestId("logo-source-url") as HTMLAnchorElement;
    expect(link.href).toContain("cdn.example.com/club-logo.png");
    expect(link.target).toBe("_blank");

    // Last-refreshed line is present, error line is not.
    expect(within(panel).getByTestId("logo-source-last-refreshed")).toBeInTheDocument();
    expect(within(panel).queryByTestId("logo-source-error")).toBeNull();
    // Date is formatted in plain language (Apr 27, 2026 in en-US locale).
    expect(panel.textContent).toMatch(/Last refreshed/);
  });

  it("renders a plain-language error mentioning the host, error and date when refresh failed", async () => {
    currentSite = makeSite({
      faviconUrl: "https://api.kharagolf.test/api/storage/objects/marketing-cache/42/favicon-xyz.ico",
      faviconSourceUrl: "https://cdn.example.com/favicon.ico",
      faviconSourceLastRefreshedAt: "2026-04-27T10:00:00Z",
      faviconSourceLastRefreshError: "host returned HTTP 503",
    });
    render(<ClubMarketingSitePage />);

    const panel = await screen.findByTestId("favicon-source-status");
    const errorLine = within(panel).getByTestId("favicon-source-error");
    // Mentions the host (extracted from the source URL), the verifier
    // error text, and the formatted date.
    expect(errorLine.textContent).toMatch(/cdn\.example\.com/);
    expect(errorLine.textContent).toMatch(/host returned HTTP 503/);
    expect(errorLine.textContent).toMatch(/2026/);
    // The "last refreshed" success line must NOT appear when there's an error.
    expect(within(panel).queryByTestId("favicon-source-last-refreshed")).toBeNull();
  });

  it("clears the cached URL when the inline 'Clear source' button is clicked, and persists the clear on save", async () => {
    currentSite = makeSite({
      logoImageUrl: "https://api.kharagolf.test/api/storage/objects/marketing-cache/42/logo-abc.png",
      logoSourceUrl: "https://cdn.example.com/broken.png",
      logoSourceLastRefreshedAt: "2026-04-27T10:00:00Z",
      logoSourceLastRefreshError: "DNS lookup failed",
    });
    render(<ClubMarketingSitePage />);

    const clearBtn = await screen.findByTestId("button-clear-logo-source");
    fireEvent.click(clearBtn);

    // The cached URL input goes empty immediately — admin can now type a
    // replacement URL and Save to retry, or just Save to drop back to a
    // direct upload / org logo fallback.
    const input = screen.getByTestId("input-logo-image-url") as HTMLInputElement;
    await waitFor(() => {
      expect(input.value).toBe("");
    });

    // Pressing Save persists `logoImageUrl: null`. The API contract
    // (marketing-site PUT handler) is that nulling the cached URL also
    // clears `logoSourceUrl` and the refresh tracking columns — so the
    // refresh-status panel disappears on the next render.
    fireEvent.click(screen.getByTestId("button-save-site"));

    await waitFor(() => {
      expect(putBodies.some(b => b.logoImageUrl === null)).toBe(true);
    });
    await waitFor(() => {
      expect(screen.queryByTestId("logo-source-status")).toBeNull();
    });
  });
});
