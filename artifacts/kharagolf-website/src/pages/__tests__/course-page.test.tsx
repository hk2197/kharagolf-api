/**
 * Task #627 — UI coverage for the public course page (Task #475 work).
 *
 * Exercises the React component end-to-end against a stubbed `fetch`:
 *   - The page loads the course payload and renders the photo gallery.
 *   - Clicking a thumbnail opens the lightbox.
 *   - ArrowRight navigates to the next photo; Escape closes the lightbox.
 *   - The "Submit a photo" form drives the three-step upload flow
 *     (presigned URL -> PUT -> finalize) with the correct request bodies.
 *
 * No real network or browser is needed; happy-dom + a fetch stub are enough
 * to catch regressions in lightbox rendering, keyboard handling, and the
 * client-side moderation handoff that Task #475 introduced.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { Router as WouterRouter } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import CoursePage from "../course-page";

const CLUB_SLUG = "test-club";
const COURSE_SLUG = "trail-course";
const COURSE_URL = `/api/public/clubs/${CLUB_SLUG}/courses/${COURSE_SLUG}`;
const UPLOAD_URL_ENDPOINT = `${COURSE_URL}/photos/upload-url`;
const PHOTOS_ENDPOINT = `${COURSE_URL}/photos`;

const buildCoursePayload = () => ({
  club: {
    id: 1,
    name: "Test Club",
    slug: CLUB_SLUG,
    address: "123 Fairway",
    contactPhone: null,
    contactEmail: null,
  },
  course: {
    id: 10,
    slug: COURSE_SLUG,
    name: "Trail Course",
    description: "A pretty test course.",
    location: "Test Town",
    latitude: null,
    longitude: null,
    holes: 18,
    par: 72,
    rating: null,
    slope: null,
    yardage: null,
    designer: null,
    yearOpened: null,
    awards: [],
    contactPhone: null,
    contactEmail: null,
    heroImageUrl: "/objects/hero.jpg",
  },
  holes: [],
  photos: [
    {
      id: 101,
      url: "/objects/photo-1.jpg",
      thumbnailUrl: null,
      caption: "Front nine view",
      holeNumber: null,
      isHero: false,
      uploaderName: "Seed Photographer",
    },
    {
      id: 102,
      url: "/objects/photo-2.jpg",
      thumbnailUrl: null,
      caption: "Back nine view",
      holeNumber: null,
      isHero: false,
      uploaderName: "Seed Photographer",
    },
  ],
  reviewSummary: { averageRating: null, totalReviews: 0, recent: [] },
  teeTimeUrl: "https://example.com/tee-times",
});

function renderCoursePage() {
  // Wouter `memory-location` lets us drive the route without a real browser URL.
  const { hook } = memoryLocation({ path: `/clubs/${CLUB_SLUG}/courses/${COURSE_SLUG}` });
  return render(
    <WouterRouter hook={hook}>
      <CoursePage />
    </WouterRouter>,
  );
}

interface FetchCall {
  url: string;
  init?: RequestInit;
}

let fetchCalls: FetchCall[] = [];

function makeJsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  fetchCalls = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    fetchCalls.push({ url, init });

    if (url === COURSE_URL && (!init || init.method === undefined || init.method === "GET")) {
      return makeJsonResponse(200, buildCoursePayload());
    }
    if (url === UPLOAD_URL_ENDPOINT && init?.method === "POST") {
      return makeJsonResponse(200, {
        uploadURL: "https://storage.example.com/upload/abc",
        objectPath: "/objects/uploads/abc",
        uploadToken: "tok-abc",
      });
    }
    if (url === "https://storage.example.com/upload/abc" && init?.method === "PUT") {
      return new Response(null, { status: 200 });
    }
    if (url === PHOTOS_ENDPOINT && init?.method === "POST") {
      return makeJsonResponse(201, { id: 999, approved: false, status: "pending" });
    }
    return makeJsonResponse(404, { error: `Unexpected URL ${url}` });
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("CoursePage gallery + photo submission flow", () => {
  it("renders the gallery once the course payload loads", async () => {
    renderCoursePage();

    expect(await screen.findByRole("heading", { name: "Trail Course" })).toBeInTheDocument();
    const gallery = screen.getByTestId("course-gallery");
    expect(within(gallery).getByTestId("gallery-photo-101")).toBeInTheDocument();
    expect(within(gallery).getByTestId("gallery-photo-102")).toBeInTheDocument();
    expect(screen.getByTestId("button-open-photo-submit")).toBeInTheDocument();
  });

  // Task #1939 — When the public course payload has no lat/lng (whether
  // explicit or via the mapper-centre fallback), the embedded map widget
  // should stay hidden so we don't render a meaningless tile.
  it("hides the embedded map preview when the course has no coordinates", async () => {
    renderCoursePage();
    await screen.findByRole("heading", { name: "Trail Course" });
    expect(screen.queryByTestId("course-map-preview")).not.toBeInTheDocument();
    expect(screen.queryByTestId("course-map-iframe")).not.toBeInTheDocument();
  });

  // Task #1939 — When lat/lng come back, render an OSM iframe pinned on the
  // course and a "View on map" link out to OpenStreetMap. The link should
  // carry the marker so the OSM tab opens with the same pin.
  it("renders the embedded map and OSM link when the course has coordinates", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url === COURSE_URL) {
          const payload = buildCoursePayload();
          (payload.course as { latitude: string | null }).latitude = "37.7749";
          (payload.course as { longitude: string | null }).longitude = "-122.4194";
          return makeJsonResponse(200, payload);
        }
        return makeJsonResponse(404, { error: `Unexpected URL ${url}` });
      }),
    );

    renderCoursePage();
    await screen.findByRole("heading", { name: "Trail Course" });

    const preview = await screen.findByTestId("course-map-preview");
    expect(preview).toBeInTheDocument();

    const iframe = within(preview).getByTestId("course-map-iframe") as HTMLIFrameElement;
    expect(iframe.getAttribute("src")).toContain("openstreetmap.org/export/embed.html");
    expect(iframe.getAttribute("src")).toContain("marker=37.7749,-122.4194");
    expect(iframe.getAttribute("title")).toMatch(/Trail Course/);

    const link = within(preview).getByTestId("course-map-osm-link") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toContain("mlat=37.7749");
    expect(link.getAttribute("href")).toContain("mlon=-122.4194");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toMatch(/noopener/);
  });

  it("opens the lightbox, navigates with ArrowRight, and closes with Escape", async () => {
    renderCoursePage();

    const firstThumb = await screen.findByTestId("gallery-photo-101");
    fireEvent.click(firstThumb);

    const lightbox = await screen.findByTestId("gallery-lightbox");
    expect(lightbox).toBeInTheDocument();
    expect(within(lightbox).getByText(/1 \/ 2/)).toBeInTheDocument();
    expect(within(lightbox).getByText(/Front nine view/)).toBeInTheDocument();

    // ArrowRight advances to the next photo. The lightbox listens on `window`.
    fireEvent.keyDown(window, { key: "ArrowRight" });

    await waitFor(() => {
      expect(within(lightbox).getByText(/2 \/ 2/)).toBeInTheDocument();
    });
    expect(within(lightbox).getByText(/Back nine view/)).toBeInTheDocument();

    // Escape closes the lightbox.
    fireEvent.keyDown(window, { key: "Escape" });

    await waitFor(() => {
      expect(screen.queryByTestId("gallery-lightbox")).not.toBeInTheDocument();
    });
  });

  it("submits a photo through the three-step upload flow with correct payloads", async () => {
    renderCoursePage();

    fireEvent.click(await screen.findByTestId("button-open-photo-submit"));

    const form = await screen.findByTestId("form-submit-photo");
    expect(form).toBeInTheDocument();

    const fileInput = screen.getByTestId("input-photo-file") as HTMLInputElement;
    const file = new File([new Uint8Array([1, 2, 3, 4])], "test.jpg", { type: "image/jpeg" });
    fireEvent.change(fileInput, { target: { files: [file] } });

    fireEvent.change(screen.getByTestId("input-photo-name"), { target: { value: "Test Visitor" } });
    fireEvent.change(screen.getByTestId("input-photo-caption"), {
      target: { value: "Lovely test photo" },
    });

    fireEvent.submit(form);

    // Wait for the finalize call to land in our fetch-call log.
    await waitFor(() => {
      expect(fetchCalls.some(c => c.url === PHOTOS_ENDPOINT && c.init?.method === "POST")).toBe(true);
    });

    const uploadUrlCall = fetchCalls.find(
      c => c.url === UPLOAD_URL_ENDPOINT && c.init?.method === "POST",
    );
    expect(uploadUrlCall).toBeTruthy();
    const uploadUrlBody = JSON.parse(uploadUrlCall!.init!.body as string);
    expect(uploadUrlBody.contentType).toBe("image/jpeg");
    expect(uploadUrlBody.size).toBe(4);

    const putCall = fetchCalls.find(
      c => c.url === "https://storage.example.com/upload/abc" && c.init?.method === "PUT",
    );
    expect(putCall).toBeTruthy();

    const finalizeCall = fetchCalls.find(
      c => c.url === PHOTOS_ENDPOINT && c.init?.method === "POST",
    );
    expect(finalizeCall).toBeTruthy();
    const finalizeBody = JSON.parse(finalizeCall!.init!.body as string);
    expect(finalizeBody).toMatchObject({
      objectPath: "/objects/uploads/abc",
      uploadToken: "tok-abc",
      uploaderName: "Test Visitor",
      caption: "Lovely test photo",
    });

    // Task #791 — after a successful submission, the parent page calls
    // load() to refresh, which re-renders the gallery. The "Thanks for
    // sharing!" panel must survive that refresh and remain visible to
    // the visitor. (Previously the page returned a full-screen spinner
    // during the refetch, which unmounted the form and wiped the
    // local success state.)
    const successPanel = await screen.findByTestId("photo-submit-success");
    expect(successPanel).toHaveTextContent(/Thanks for sharing/i);
    expect(successPanel).toHaveTextContent(/moderation queue/i);
  });

  it("surfaces a server-side error when the upload-url endpoint rejects the request", async () => {
    // Override fetch to reject the upload-url with a 400.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url === COURSE_URL) return makeJsonResponse(200, buildCoursePayload());
        if (url === UPLOAD_URL_ENDPOINT) {
          return makeJsonResponse(400, { error: "Unsupported image type. Allowed: JPEG, PNG, GIF, WebP" });
        }
        return makeJsonResponse(404, { error: "unexpected" });
      }),
    );

    renderCoursePage();
    fireEvent.click(await screen.findByTestId("button-open-photo-submit"));

    const form = await screen.findByTestId("form-submit-photo");
    const fileInput = screen.getByTestId("input-photo-file") as HTMLInputElement;
    const file = new File([new Uint8Array([1, 2, 3, 4])], "test.jpg", { type: "image/jpeg" });
    fireEvent.change(fileInput, { target: { files: [file] } });
    fireEvent.change(screen.getByTestId("input-photo-name"), { target: { value: "Test Visitor" } });
    fireEvent.submit(form);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/Unsupported image type/i);
  });
});
