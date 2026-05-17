/**
 * Task #665 — UI test for the Brand Overrides editor (Task #584).
 *
 * Confirms the "Reset to theme defaults" button on the marketing-site
 * editor:
 *   - Is disabled when none of the three overrides are set.
 *   - Is enabled as soon as any override is set.
 *   - Clears all three overrides (primary color, accent color, heading
 *     font) when clicked, and goes back to disabled afterwards.
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
  brandPrimaryColor: string | null;
  brandAccentColor: string | null;
  brandHeadingFont: string | null;
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
    isPublished: false,
    publishedAt: null,
    cacheVersion: 1,
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

function setupFetch() {
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
        return jsonResponse({ token: "tok_brand", expiresInMs: 60 * 60 * 1000 });
      }
      if (url.endsWith("/api/organizations/42/marketing-site") && method === "PUT") {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        currentSite = { ...currentSite, ...body, cacheVersion: currentSite.cacheVersion + 1 };
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

describe("ClubMarketingSitePage — Brand overrides reset (Task #584)", () => {
  it("disables 'Reset to theme defaults' when no overrides are set", async () => {
    currentSite = makeSite();
    render(<ClubMarketingSitePage />);

    const resetBtn = await screen.findByTestId("button-reset-brand");
    expect(resetBtn).toBeDisabled();
  });

  it("enables Reset when any override is set, then clears all three when clicked", async () => {
    currentSite = makeSite({
      brandPrimaryColor: "#102030",
      brandAccentColor: "#aa1188",
      brandHeadingFont: "'Playfair Display', Georgia, serif",
    });
    render(<ClubMarketingSitePage />);

    // Initially the per-field clear buttons and the font preview are present.
    const resetBtn = await screen.findByTestId("button-reset-brand");
    expect(resetBtn).toBeEnabled();
    expect(screen.getByTestId("button-clear-brand-primary")).toBeInTheDocument();
    expect(screen.getByTestId("button-clear-brand-accent")).toBeInTheDocument();
    expect(screen.getByTestId("button-clear-brand-font")).toBeInTheDocument();
    expect(screen.getByTestId("brand-font-preview")).toBeInTheDocument();

    // The hex inputs reflect the current values.
    const primaryHex = screen.getByTestId("input-brand-primary-hex") as HTMLInputElement;
    const accentHex = screen.getByTestId("input-brand-accent-hex") as HTMLInputElement;
    const fontSelect = screen.getByTestId("select-brand-heading-font") as HTMLSelectElement;
    expect(primaryHex.value).toBe("#102030");
    expect(accentHex.value).toBe("#aa1188");
    expect(fontSelect.value).toBe("'Playfair Display', Georgia, serif");

    fireEvent.click(resetBtn);

    // After reset: all three inputs return to their empty/default state,
    // the per-field clear buttons disappear (only shown when a value
    // exists), and the Reset button itself becomes disabled again.
    await waitFor(() => {
      expect(
        (screen.getByTestId("input-brand-primary-hex") as HTMLInputElement).value,
      ).toBe("");
    });
    expect(
      (screen.getByTestId("input-brand-accent-hex") as HTMLInputElement).value,
    ).toBe("");
    expect(
      (screen.getByTestId("select-brand-heading-font") as HTMLSelectElement).value,
    ).toBe("");

    expect(screen.queryByTestId("button-clear-brand-primary")).toBeNull();
    expect(screen.queryByTestId("button-clear-brand-accent")).toBeNull();
    expect(screen.queryByTestId("button-clear-brand-font")).toBeNull();
    expect(screen.queryByTestId("brand-font-preview")).toBeNull();
    expect(screen.getByTestId("button-reset-brand")).toBeDisabled();
  });

  it("re-enables the Reset button when only a single override is set", async () => {
    currentSite = makeSite({ brandAccentColor: "#aa1188" });
    render(<ClubMarketingSitePage />);

    const resetBtn = await screen.findByTestId("button-reset-brand");
    expect(resetBtn).toBeEnabled();

    fireEvent.click(resetBtn);

    await waitFor(() => {
      expect(screen.getByTestId("button-reset-brand")).toBeDisabled();
    });
  });
});
