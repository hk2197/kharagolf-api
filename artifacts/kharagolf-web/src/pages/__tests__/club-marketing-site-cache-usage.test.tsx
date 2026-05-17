/**
 * Task #1799 — UI test for the marketing-cache storage usage hint shown
 * inside the "Logo & favicon" card on the marketing-site admin editor.
 *
 * Covers:
 *   - When the GET response includes `marketingCacheUsage`, the hint
 *     renders the formatted byte count + file count (singular/plural).
 *   - When the server returns `marketingCacheUsage: null` (best-effort
 *     fallback because the storage backend was unreachable), the hint
 *     renders the em-dash placeholder instead of crashing the page.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";

vi.mock("@/context/ActiveOrgContext", () => ({
  useActiveOrgId: () => 42,
}));
const stableToast = { toast: vi.fn() };
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => stableToast,
}));
vi.mock("wouter", () => ({
  useLocation: () => ["/club-marketing", vi.fn()],
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
  isPublished: boolean;
  publishedAt: string | null;
  cacheVersion: number;
  marketingCacheUsage: { totalBytes: number; objectCount: number } | null;
}

function makeSite(overrides: Partial<FakeSite> = {}): FakeSite {
  return {
    id: 1,
    organizationId: 42,
    theme: "classic",
    heroImageUrl: null,
    heroTitle: "Welcome",
    heroSubtitle: null,
    heroCtaLabel: null,
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
    isPublished: false,
    publishedAt: null,
    cacheVersion: 1,
    marketingCacheUsage: { totalBytes: 0, objectCount: 0 },
    ...overrides,
  };
}

let currentSite: FakeSite;

function jsonResponse(body: unknown, init: { status?: number } = {}) {
  return Promise.resolve({
    ok: (init.status ?? 200) < 400,
    status: init.status ?? 200,
    json: () => Promise.resolve(body),
  } as Response);
}

beforeEach(() => {
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = function () {};
  }
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
        return jsonResponse({ token: "tok_usage", expiresInMs: 60 * 60 * 1000 });
      }
      return jsonResponse({ error: "unmocked: " + method + " " + url }, { status: 404 });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Marketing-cache storage usage hint (Task #1799)", () => {
  it("renders bytes + file count when the API returns usage stats", async () => {
    currentSite = makeSite({
      marketingCacheUsage: { totalBytes: 1_572_864, objectCount: 3 },
    });

    render(<ClubMarketingSitePage />);

    const hint = await screen.findByTestId("text-marketing-cache-usage");
    await waitFor(() => {
      // 1.5 MB = 1_572_864 bytes; multi-file → plural "files".
      expect(hint).toHaveTextContent(/1\.5 MB used/);
      expect(hint).toHaveTextContent(/3 files/);
    });
  });

  it("uses singular 'file' when exactly one cached image exists", async () => {
    currentSite = makeSite({
      marketingCacheUsage: { totalBytes: 850, objectCount: 1 },
    });

    render(<ClubMarketingSitePage />);

    const hint = await screen.findByTestId("text-marketing-cache-usage");
    await waitFor(() => {
      // < 1 KB → render raw bytes; singular "file".
      expect(hint).toHaveTextContent(/850 B used/);
      expect(hint).toHaveTextContent(/1 file\b/);
      expect(hint).not.toHaveTextContent(/files/);
    });
  });

  it("renders an em-dash placeholder when the API could not read storage", async () => {
    currentSite = makeSite({ marketingCacheUsage: null });

    render(<ClubMarketingSitePage />);

    const hint = await screen.findByTestId("text-marketing-cache-usage");
    await waitFor(() => {
      expect(hint).toHaveTextContent(/Cached image storage:\s*—/);
    });
  });
});
