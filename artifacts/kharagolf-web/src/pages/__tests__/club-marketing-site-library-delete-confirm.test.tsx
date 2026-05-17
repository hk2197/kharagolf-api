/**
 * Task #1207 / Task #1398 / Task #1682 — UI test for the
 * delete-from-library confirmation flow inside the marketing-site
 * editor's <LibraryPickerButton>.
 *
 * Task #1398 replaced the old window.confirm with a styled in-app
 * AlertDialog so the affected spots can be rendered as a real list with
 * deep-links into the editor section that uses the image. Task #1682
 * extended the same dialog to the unused-image path so the delete
 * experience is uniform whether or not the image is in use. This test
 * drives that new dialog instead of stubbing window.confirm.
 *
 * Covers:
 *   - Clicking the per-thumbnail delete button on an in-use image opens
 *     the styled confirm dialog and lists every spot the image is used.
 *   - Clicking a usage row jumps to that editor section (and cancels
 *     the pending delete) without firing a DELETE.
 *   - Cancelling the dialog leaves the image in the grid and never
 *     issues a DELETE request.
 *   - Confirming the dialog fires
 *     DELETE /api/organizations/:id/marketing-site/library/:imageId.
 *   - Clicking delete on an *unused* image opens the same styled
 *     AlertDialog (no usage list), and cancel/confirm behave the same
 *     way as the in-use path.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";

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
let fetchMock: ReturnType<typeof vi.fn>;

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
  setLocationMock.mockReset();
  stableToast.toast.mockReset();
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
  fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
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
    if (
      /\/api\/organizations\/42\/marketing-site\/library\/\d+$/.test(url) &&
      method === "DELETE"
    ) {
      return jsonResponse(null, { status: 204 });
    }
    if (url.endsWith("/api/organizations/42/marketing-site") && method === "PUT") {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      currentSite = { ...currentSite, ...body, cacheVersion: currentSite.cacheVersion + 1 };
      return jsonResponse(currentSite);
    }
    return jsonResponse({ error: "unmocked: " + method + " " + url }, { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
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
  await screen.findByTestId("library-image-11");
}

function deleteCallCount() {
  return fetchMock.mock.calls.filter(([input, init]) => {
    const url = typeof input === "string" ? input : String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    return method === "DELETE" && /\/marketing-site\/library\//.test(url);
  }).length;
}

describe("LibraryPickerButton — in-use delete confirmation (Task #1398)", () => {
  it("opens a styled in-app dialog listing every spot the image is used", async () => {
    await openHeroPicker();

    // Native confirm should never be invoked for an in-use image.
    const confirmSpy = vi.spyOn(window, "confirm");

    fireEvent.click(screen.getByTestId("library-delete-11"));

    const dialog = await screen.findByTestId("library-delete-confirm");
    expect(dialog).toBeInTheDocument();
    expect(confirmSpy).not.toHaveBeenCalled();

    const list = within(dialog).getByTestId("library-delete-confirm-usage-list");
    const items = within(list).getAllByRole("button");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent("Hero image");
    expect(items[1]).toHaveTextContent("Pine Valley — Cover photo");
  });

  it("clicking a usage row jumps to the editor section and cancels the pending delete", async () => {
    await openHeroPicker();

    fireEvent.click(screen.getByTestId("library-delete-11"));

    const usageRow = await screen.findByTestId("library-delete-confirm-usage-1");
    fireEvent.click(usageRow);

    // Course usages have an href, so we navigate to the linked editor.
    expect(setLocationMock).toHaveBeenCalledWith("/courses?courseId=7");
    // The confirm dialog disappears and no DELETE is fired.
    await waitFor(() => {
      expect(screen.queryByTestId("library-delete-confirm")).toBeNull();
    });
    expect(deleteCallCount()).toBe(0);
  });

  it("cancelling the dialog leaves the image in the library and does not call DELETE", async () => {
    await openHeroPicker();

    fireEvent.click(screen.getByTestId("library-delete-11"));

    const cancel = await screen.findByTestId("library-delete-confirm-cancel");
    fireEvent.click(cancel);

    await waitFor(() => {
      expect(screen.queryByTestId("library-delete-confirm")).toBeNull();
    });

    // The grid still contains the thumbnail and no DELETE was issued.
    expect(screen.getByTestId("library-image-11")).toBeInTheDocument();
    expect(deleteCallCount()).toBe(0);
  });

  it("confirming the delete fires DELETE /organizations/:id/marketing-site/library/:imageId", async () => {
    await openHeroPicker();

    fireEvent.click(screen.getByTestId("library-delete-11"));

    const confirm = await screen.findByTestId("library-delete-confirm-confirm");
    fireEvent.click(confirm);

    await waitFor(() => {
      expect(deleteCallCount()).toBe(1);
    });

    const deleteCall = fetchMock.mock.calls.find(([input, init]) => {
      const url = typeof input === "string" ? input : String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      return method === "DELETE" && /\/marketing-site\/library\//.test(url);
    });
    expect(deleteCall).toBeDefined();
    const calledUrl = typeof deleteCall![0] === "string"
      ? (deleteCall![0] as string)
      : String(deleteCall![0]);
    expect(calledUrl).toMatch(/\/api\/organizations\/42\/marketing-site\/library\/11$/);

    // Optimistic removal: the deleted thumbnail disappears from the grid.
    await waitFor(() => {
      expect(screen.queryByTestId("library-image-11")).toBeNull();
    });

    // The confirm dialog also closes after the delete.
    await waitFor(() => {
      expect(screen.queryByTestId("library-delete-confirm")).toBeNull();
    });
  });
});

describe("LibraryPickerButton — unused-image delete confirmation (Task #1682)", () => {
  beforeEach(() => {
    // Replace the in-use image with a single unused one so the delete
    // path renders the styled dialog without a usage list.
    libraryImages = [
      {
        id: 22,
        objectPath: "/o/22.jpg",
        url: "https://cdn.example.com/unused.jpg",
        contentType: "image/jpeg",
        sizeBytes: 12345,
        createdAt: "2026-01-02T00:00:00.000Z",
        usage: [],
      },
    ];
  });

  it("opens the same styled AlertDialog (without a usage list) instead of window.confirm", async () => {
    render(<ClubMarketingSitePage />);
    const trigger = await screen.findByTestId("button-library-hero");
    fireEvent.click(trigger);
    await screen.findByTestId("library-image-22");

    // Native confirm should never be invoked for an unused image either.
    const confirmSpy = vi.spyOn(window, "confirm");

    fireEvent.click(screen.getByTestId("library-delete-22"));

    const dialog = await screen.findByTestId("library-delete-confirm");
    expect(dialog).toBeInTheDocument();
    expect(confirmSpy).not.toHaveBeenCalled();

    // No usage list is rendered for an image that's not in use.
    expect(
      within(dialog).queryByTestId("library-delete-confirm-usage-list"),
    ).toBeNull();
    // The cancel/confirm buttons from the same styled dialog are still there.
    expect(within(dialog).getByTestId("library-delete-confirm-cancel")).toBeInTheDocument();
    expect(within(dialog).getByTestId("library-delete-confirm-confirm")).toBeInTheDocument();
  });

  it("cancelling the dialog leaves the unused image in the library and does not call DELETE", async () => {
    render(<ClubMarketingSitePage />);
    const trigger = await screen.findByTestId("button-library-hero");
    fireEvent.click(trigger);
    await screen.findByTestId("library-image-22");

    fireEvent.click(screen.getByTestId("library-delete-22"));

    const cancel = await screen.findByTestId("library-delete-confirm-cancel");
    fireEvent.click(cancel);

    await waitFor(() => {
      expect(screen.queryByTestId("library-delete-confirm")).toBeNull();
    });

    expect(screen.getByTestId("library-image-22")).toBeInTheDocument();
    expect(deleteCallCount()).toBe(0);
  });

  it("confirming fires DELETE /organizations/:id/marketing-site/library/:imageId for the unused image", async () => {
    render(<ClubMarketingSitePage />);
    const trigger = await screen.findByTestId("button-library-hero");
    fireEvent.click(trigger);
    await screen.findByTestId("library-image-22");

    fireEvent.click(screen.getByTestId("library-delete-22"));

    const confirm = await screen.findByTestId("library-delete-confirm-confirm");
    fireEvent.click(confirm);

    await waitFor(() => {
      expect(deleteCallCount()).toBe(1);
    });

    const deleteCall = fetchMock.mock.calls.find(([input, init]) => {
      const url = typeof input === "string" ? input : String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      return method === "DELETE" && /\/marketing-site\/library\//.test(url);
    });
    expect(deleteCall).toBeDefined();
    const calledUrl = typeof deleteCall![0] === "string"
      ? (deleteCall![0] as string)
      : String(deleteCall![0]);
    expect(calledUrl).toMatch(/\/api\/organizations\/42\/marketing-site\/library\/22$/);

    // Optimistic removal: the deleted thumbnail disappears from the grid.
    await waitFor(() => {
      expect(screen.queryByTestId("library-image-22")).toBeNull();
    });

    // The confirm dialog also closes after the delete.
    await waitFor(() => {
      expect(screen.queryByTestId("library-delete-confirm")).toBeNull();
    });
  });
});
