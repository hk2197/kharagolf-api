/**
 * Task #900 — UI test for the image-library detail panel inside the
 * marketing-site editor's <LibraryPickerButton>.
 *
 * Covers:
 *   - Clicking a thumbnail opens the side detail panel and renders the
 *     correct usage list for that image.
 *   - "Use this image" still selects the image (writes the URL back to
 *     the caller field) and closes the dialog.
 *   - Clicking a same-page usage closes the dialog and focuses the
 *     targeted editor field.
 *   - Clicking a course usage navigates to /courses?courseId=… via
 *     wouter's setLocation.
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

const setLocationMock = vi.fn();
vi.mock("wouter", () => ({
  useLocation: () => ["/club-marketing", setLocationMock],
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

interface LibImage {
  id: number;
  objectPath: string;
  url: string;
  contentType: string | null;
  sizeBytes: number | null;
  createdAt: string;
  usage: Array<{
    kind: string;
    label: string;
    targetTestId?: string;
    href?: string;
    courseId?: number;
  }>;
}

let libraryImages: LibImage[];
let currentSite: FakeSite;

function jsonResponse(body: unknown, init: { status?: number } = {}) {
  return Promise.resolve({
    ok: (init.status ?? 200) < 400,
    status: init.status ?? 200,
    json: () => Promise.resolve(body),
  } as Response);
}

beforeEach(() => {
  // jsdom doesn't implement scrollIntoView; the same-page jump calls it.
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = function () {};
  }
  setLocationMock.mockReset();
  currentSite = makeSite();
  libraryImages = [
    {
      id: 11,
      objectPath: "/o/11.jpg",
      url: "https://cdn.example.com/hero.jpg",
      contentType: "image/jpeg",
      sizeBytes: 12345,
      createdAt: "2026-01-01T00:00:00.000Z",
      usage: [
        { kind: "hero", label: "Hero image", targetTestId: "input-hero-image-url" },
        { kind: "course", label: "Pine Valley — Cover photo", href: "/courses?courseId=7", courseId: 7 },
      ],
    },
  ];
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
        return jsonResponse({ token: "tok_lib", expiresInMs: 60 * 60 * 1000 });
      }
      if (url.endsWith("/api/organizations/42/marketing-site/library") && method === "GET") {
        return jsonResponse(libraryImages);
      }
      if (url.endsWith("/api/organizations/42/marketing-site") && method === "PUT") {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        currentSite = { ...currentSite, ...body, cacheVersion: currentSite.cacheVersion + 1 };
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
  vi.useRealTimers();
});

async function openHeroPicker() {
  render(<ClubMarketingSitePage />);
  const trigger = await screen.findByTestId("button-library-hero");
  fireEvent.click(trigger);
  // Library list loads asynchronously after the dialog opens.
  await screen.findByTestId("library-image-11");
}

describe("LibraryPickerButton — image-usage detail panel (Task #900)", () => {
  it("opens the detail panel with the correct usage list when a thumbnail is clicked", async () => {
    await openHeroPicker();

    // Panel is hidden until the user clicks a thumbnail.
    expect(screen.queryByTestId("library-detail-panel")).toBeNull();

    fireEvent.click(screen.getByTestId("library-select-11"));

    const panel = await screen.findByTestId("library-detail-panel");
    expect(panel).toBeInTheDocument();

    const list = screen.getByTestId("library-detail-usage-list");
    const items = list.querySelectorAll('[data-testid^="library-detail-usage-"]');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent("Hero image");
    expect(items[1]).toHaveTextContent("Pine Valley — Cover photo");
  });

  it("'Use this image' selects the image URL and closes the dialog", async () => {
    await openHeroPicker();

    const heroInput = screen.getByTestId("input-hero-image-url") as HTMLInputElement;
    expect(heroInput.value).toBe("");

    fireEvent.click(screen.getByTestId("library-select-11"));
    fireEvent.click(await screen.findByTestId("library-use-11"));

    await waitFor(() => {
      expect(screen.queryByTestId("library-grid")).toBeNull();
    });
    expect(
      (screen.getByTestId("input-hero-image-url") as HTMLInputElement).value,
    ).toBe("https://cdn.example.com/hero.jpg");
  });

  it("clicking a same-page usage closes the dialog and focuses the targeted field", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await openHeroPicker();

    fireEvent.click(screen.getByTestId("library-select-11"));
    const heroUsage = await screen.findByTestId("library-detail-usage-0");
    expect(heroUsage).toHaveTextContent("Hero image");

    fireEvent.click(heroUsage);

    // Dialog closes immediately.
    await waitFor(() => {
      expect(screen.queryByTestId("library-grid")).toBeNull();
    });

    // The same-page jump scrolls/focuses the target after a short delay.
    vi.advanceTimersByTime(100);

    const target = screen.getByTestId("input-hero-image-url");
    expect(document.activeElement).toBe(target);
    expect(target.className).toContain("ring-2");
    expect(setLocationMock).not.toHaveBeenCalled();
  });

  it("clicking a course usage navigates to /courses?courseId=…", async () => {
    await openHeroPicker();

    fireEvent.click(screen.getByTestId("library-select-11"));
    const courseUsage = await screen.findByTestId("library-detail-usage-1");
    expect(courseUsage).toHaveTextContent("Pine Valley");

    fireEvent.click(courseUsage);

    await waitFor(() => {
      expect(setLocationMock).toHaveBeenCalledWith("/courses?courseId=7");
    });

    // Picker closes when navigating away.
    await waitFor(() => {
      expect(screen.queryByTestId("library-grid")).toBeNull();
    });
  });
});
