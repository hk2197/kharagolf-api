/**
 * Task #437 / #583 — UI test for the club-marketing-site editor's
 * embedded preview pane.
 *
 * Covers:
 *   - "Open preview" button mints a token from the API and renders the
 *     iframe with `?preview=<token>` in its src.
 *   - Selecting a different theme card flips the editor's `theme` value
 *     (Save still pending).
 *   - After Save the iframe re-mounts (its `key` changes, so its `src`
 *     gets a new `&v=` cache-buster) without requiring a fresh token.
 *   - "Open in new tab" link points at the same preview URL with
 *     target=_blank.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";

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
    isPublished: false,
    publishedAt: null,
    cacheVersion: 1,
    ...overrides,
  };
}

let currentSite: FakeSite;
let tokenCounter = 0;

function jsonResponse(body: unknown, init: { status?: number } = {}) {
  return Promise.resolve({
    ok: (init.status ?? 200) < 400,
    status: init.status ?? 200,
    json: () => Promise.resolve(body),
  } as Response);
}

beforeEach(() => {
  currentSite = makeSite();
  tokenCounter = 0;
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
        tokenCounter += 1;
        return jsonResponse({
          token: `tok_${tokenCounter}`,
          expiresInMs: 60 * 60 * 1000,
        });
      }
      if (url.endsWith("/api/organizations/42/marketing-site") && method === "PUT") {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        currentSite = {
          ...currentSite,
          ...body,
          cacheVersion: currentSite.cacheVersion + 1,
        };
        return jsonResponse(currentSite);
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

describe("ClubMarketingSitePage — preview pane (Task #437)", () => {
  it("opens an iframe preview with a freshly issued token", async () => {
    render(<ClubMarketingSitePage />);

    // Wait for the editor to load.
    const openBtn = await screen.findByTestId("button-open-preview");
    expect(openBtn).toBeInTheDocument();
    expect(screen.queryByTestId("preview-iframe")).toBeNull();

    fireEvent.click(openBtn);

    const iframe = await screen.findByTestId("preview-iframe");
    expect(iframe.tagName).toBe("IFRAME");
    const src = iframe.getAttribute("src") ?? "";
    expect(src).toContain("/clubs/pinevalley");
    expect(src).toContain("preview=tok_1");

    // The "Open in new tab" link mirrors the same preview URL and opens in a new tab.
    const newTabLink = screen.getByTestId("link-open-preview") as HTMLAnchorElement;
    expect(newTabLink.getAttribute("target")).toBe("_blank");
    expect(newTabLink.getAttribute("href")).toContain("preview=tok_1");

    // The token endpoint was called exactly once.
    expect(tokenCounter).toBe(1);
  });

  it("flips the selected theme card when clicked", async () => {
    render(<ClubMarketingSitePage />);

    const classicBtn = await screen.findByTestId("theme-card-classic");
    const boldBtn = screen.getByTestId("theme-card-bold");
    expect(classicBtn.getAttribute("aria-pressed")).toBe("true");
    expect(boldBtn.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(boldBtn);

    expect(classicBtn.getAttribute("aria-pressed")).toBe("false");
    expect(boldBtn.getAttribute("aria-pressed")).toBe("true");
  });

  it("re-mounts the iframe with a new cache-buster after Save (no new token)", async () => {
    render(<ClubMarketingSitePage />);
    fireEvent.click(await screen.findByTestId("button-open-preview"));

    const firstSrc = (await screen.findByTestId("preview-iframe")).getAttribute("src") ?? "";
    expect(firstSrc).toContain("preview=tok_1");
    const firstV = new URL(firstSrc, "http://x").searchParams.get("v");

    // Click Save — backend bumps cacheVersion → editor refreshes the iframe.
    fireEvent.click(screen.getByTestId("button-save-site"));

    await waitFor(() => {
      const next = (screen.getByTestId("preview-iframe").getAttribute("src") ?? "");
      expect(next).toContain("preview=tok_1"); // same token
      const nextV = new URL(next, "http://x").searchParams.get("v");
      expect(nextV).not.toBe(firstV);          // cache-buster bumped
    });

    // No additional token mints — the existing token is still valid.
    expect(tokenCounter).toBe(1);
  });

  it("issues a brand new token when Refresh is clicked", async () => {
    render(<ClubMarketingSitePage />);
    fireEvent.click(await screen.findByTestId("button-open-preview"));
    await screen.findByTestId("preview-iframe");
    expect(tokenCounter).toBe(1);

    fireEvent.click(screen.getByTestId("button-refresh-preview"));

    await waitFor(() => {
      const src = screen.getByTestId("preview-iframe").getAttribute("src") ?? "";
      expect(src).toContain("preview=tok_2");
    });
    expect(tokenCounter).toBe(2);
  });
});
