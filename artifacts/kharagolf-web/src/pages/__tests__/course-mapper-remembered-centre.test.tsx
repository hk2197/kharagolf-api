/**
 * UI test (Task #1560) — the in-house Course Mapper remembers the
 * "where you last looked" centre across reopens.
 *
 * Task #1312 added a backend test for `PUT /map-center`, but the actual
 * UX promise — "open the mapper, pick a search result, close the page,
 * reopen, and you're already there" — was not pinned by an integration
 * test. A regression in the load effect (numeric coercion of
 * `mapDefaultLat` / `mapDefaultLng`), the `flyToResult` persist call, or
 * the GET payload could have silently broken the flow without any test
 * failing.
 *
 * Two flows are covered against a mocked Leaflet + a mocked Nominatim:
 *   1. Search-and-fly: blank course → admin types into the place search,
 *      clicks a result, and the page PUTs the bounding-box centre to
 *      /map-center. After unmount/remount, the GET returns the saved
 *      values and the map initialises at the remembered centre / zoom
 *      rather than the [20, 0] / zoom 2 world view.
 *   2. First-save centroid: blank course (no stored centre) → admin
 *      draws a polygon and saves; the centroid is derived and PUT to
 *      /map-center automatically. After remount, the map initialises at
 *      that centroid.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@workspace/api-client-react", () => ({
  useGetMe: () => ({
    data: { id: 1, organizationId: 42, role: "org_admin" },
    isLoading: false,
  }),
}));

const toastMock = vi.fn();
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: toastMock }),
}));

vi.mock("wouter", async () => {
  const actual = await vi.importActual<typeof import("wouter")>("wouter");
  return {
    ...actual,
    useParams: () => ({ id: "7" }),
    Link: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  };
});

// ── Leaflet mock ────────────────────────────────────────────────────────────
// The real Leaflet refuses to render without a sized container; for these
// assertions we only need to (a) capture the init opts so we can prove the
// map was opened at the remembered (or default) centre/zoom, (b) capture
// the click/dblclick handlers so we can drive a polygon draw, and (c)
// expose `getZoom()` so `flyToResult` and the post-save centroid path can
// remember a stable value.

interface MapHandlers { click?: (e: unknown) => void; dblclick?: (e: unknown) => void }
interface MapInitOpts { center: [number, number]; zoom: number }
interface MockMap {
  __handlers: MapHandlers;
  __initOpts: MapInitOpts;
  on: (ev: string, h: (e: unknown) => void) => MockMap;
  off: (ev: string, h: (e: unknown) => void) => MockMap;
  removeLayer: (l: unknown) => MockMap;
  addLayer: (l: unknown) => MockMap;
  invalidateSize: () => void;
  remove: () => void;
  fitBounds: (b: unknown, opts?: unknown) => void;
  setView: (c: [number, number], z: number) => void;
  getZoom: () => number;
}

const mapInits: MapInitOpts[] = [];
let currentMap: MockMap | null = null;
let nextGetZoom = 16;

function makeLayer() {
  const layer = {
    addTo: (_m: unknown) => layer,
    bindTooltip: (_t: string, _o?: unknown) => layer,
    on: (_ev: string, _h: (e: unknown) => void) => layer,
    setLatLngs: (_x: unknown) => layer,
    setLatLng: (_x: unknown) => layer,
  };
  return layer;
}

vi.mock("leaflet/dist/leaflet.css", () => ({}));
vi.mock("leaflet", () => {
  const L = {
    map: (
      _el: unknown,
      opts: { center: [number, number]; zoom: number },
    ): MockMap => {
      const handlers: MapHandlers = {};
      const initOpts: MapInitOpts = {
        center: [opts.center[0], opts.center[1]],
        zoom: opts.zoom,
      };
      mapInits.push(initOpts);
      const map: MockMap = {
        __handlers: handlers,
        __initOpts: initOpts,
        on(ev, h) { (handlers as Record<string, (e: unknown) => void>)[ev] = h; return map; },
        off(ev) { delete (handlers as Record<string, unknown>)[ev]; return map; },
        removeLayer() { return map; },
        addLayer() { return map; },
        invalidateSize() {},
        remove() {},
        fitBounds() {},
        setView() {},
        getZoom() { return nextGetZoom; },
      };
      currentMap = map;
      return map;
    },
    tileLayer: (_url: string, _opts: unknown) => ({ addTo: (_m: unknown) => ({}) }),
    latLng: (lat: number, lng: number) => ({ lat, lng }),
    latLngBounds: (..._args: unknown[]) => {
      const b = {
        extend(_p: unknown) { return b; },
        pad(_n: number) { return b; },
        isValid() { return true; },
      };
      return b;
    },
    polygon: (_latlngs: unknown, _style: unknown) => makeLayer(),
    polyline: (_latlngs: unknown, _style: unknown) => makeLayer(),
    circleMarker: (_latlng: unknown, _opts: unknown) => makeLayer(),
    marker: (latlng: unknown, _opts: unknown) => ({
      ...makeLayer(),
      getLatLng: () => latlng,
    }),
    divIcon: (_o: unknown) => ({}),
    layerGroup: (_layers: unknown) => ({ addTo: (_m: unknown) => ({}) }),
    DomEvent: { stopPropagation: (_e: unknown) => {} },
  };
  return { default: L, ...L };
});

import CourseMapperPage from "../course-mapper";

// ── Server stub ─────────────────────────────────────────────────────────────
// Models the two endpoints the mapper hits during this flow:
//   GET  /organizations/:orgId/courses/:courseId         → course header
//                                                          incl. mapDefault*
//   GET  /organizations/:orgId/courses/:courseId/geometry → saved features
//   POST /organizations/:orgId/courses/:courseId/geometry → save (replace)
//   PUT  /organizations/:orgId/courses/:courseId/map-center
//                                                        → persist centre
// Plus the external Nominatim URL the place-search debounce hits.
//
// The course's `mapDefault*` values come back as strings from the real
// Postgres `numeric()` column; we mirror that here so the front-end's
// `Number(...)` coercion path is exercised.

interface ServerCourse {
  id: number;
  name: string;
  holes: number;
  location: string | null;
  mapDefaultLat: string | null;
  mapDefaultLng: string | null;
  mapDefaultZoom: number | null;
}
interface ServerFeature {
  id: number;
  holeNumber: number;
  featureType: string;
  label: string | null;
  geometry: { type: string; coordinates: unknown };
}
interface ServerState {
  course: ServerCourse;
  features: ServerFeature[];
  mapCenterPuts: Array<{
    mapDefaultLat: number | null;
    mapDefaultLng: number | null;
    mapDefaultZoom: number | null;
  }>;
}
let server: ServerState;

interface NominatimResult {
  place_id: number;
  display_name: string;
  lat: string;
  lon: string;
  boundingbox?: [string, string, string, string];
}
let nominatimResults: NominatimResult[] = [];

function installFetch() {
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();

    if (url.startsWith("https://nominatim.openstreetmap.org/")) {
      return new Response(JSON.stringify(nominatimResults), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }) as unknown as Response;
    }

    if (url.match(/\/organizations\/42\/courses\/7\/map-center/) && init?.method === "PUT") {
      const body = JSON.parse(String(init.body)) as {
        mapDefaultLat: number | null;
        mapDefaultLng: number | null;
        mapDefaultZoom: number | null;
      };
      server.mapCenterPuts.push(body);
      // Persist on the course so the next GET returns the new centre,
      // and serialise like the real numeric() columns would (string).
      server.course.mapDefaultLat = body.mapDefaultLat == null
        ? null : String(body.mapDefaultLat);
      server.course.mapDefaultLng = body.mapDefaultLng == null
        ? null : String(body.mapDefaultLng);
      server.course.mapDefaultZoom = body.mapDefaultZoom;
      return new Response(JSON.stringify({
        id: server.course.id,
        mapDefaultLat: server.course.mapDefaultLat,
        mapDefaultLng: server.course.mapDefaultLng,
        mapDefaultZoom: server.course.mapDefaultZoom,
      }), { status: 200, headers: { "Content-Type": "application/json" } }) as unknown as Response;
    }

    if (url.match(/\/organizations\/42\/courses\/7\/geometry/) && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as {
        replace?: boolean;
        features: Array<Omit<ServerFeature, "id">>;
      };
      if (body.replace !== false) server.features = [];
      let nextId = 1000;
      for (const f of body.features) {
        server.features.push({ id: nextId++, ...f });
      }
      return new Response(JSON.stringify({
        courseId: 7, features: server.features, replaced: true,
      }), { status: 200, headers: { "Content-Type": "application/json" } }) as unknown as Response;
    }

    if (url.match(/\/organizations\/42\/courses\/7\/geometry/)) {
      return new Response(JSON.stringify({
        courseId: 7, features: server.features,
      }), { status: 200, headers: { "Content-Type": "application/json" } }) as unknown as Response;
    }

    if (url.match(/\/organizations\/42\/courses\/7$/)) {
      return new Response(JSON.stringify(server.course), {
        status: 200, headers: { "Content-Type": "application/json" },
      }) as unknown as Response;
    }

    return new Response("not found", { status: 404 }) as unknown as Response;
  }) as typeof fetch;
}

beforeEach(() => {
  toastMock.mockReset();
  mapInits.length = 0;
  currentMap = null;
  nextGetZoom = 16;
  nominatimResults = [];
  server = {
    course: {
      id: 7,
      name: "Riverbend GC",
      holes: 18,
      location: null,
      mapDefaultLat: null,
      mapDefaultLng: null,
      mapDefaultZoom: null,
    },
    features: [],
    mapCenterPuts: [],
  };
  installFetch();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("<CourseMapperPage /> — remembered map centre across reopens (Task #1560)", () => {
  it("PUTs /map-center after a search-result click and reopens at the saved centre", async () => {
    const user = userEvent.setup();

    // Augusta-shaped fixture: bounding box dictates the centre we expect to
    // be persisted (and `getZoom()` decides the zoom we expect to be
    // persisted alongside it).
    nominatimResults = [
      {
        place_id: 12345,
        display_name: "Augusta National Golf Club, Georgia, USA",
        lat: "33.5021",
        lon: "-82.0226",
        boundingbox: ["33.4951", "33.5093", "-82.0301", "-82.0151"],
      },
    ];
    nextGetZoom = 16;

    const { unmount } = render(<CourseMapperPage />);
    await screen.findByText(/Riverbend GC/);

    // Initial mount: no remembered centre, so the [20, 0] / zoom 2 world
    // view is what the map opens at.
    expect(mapInits).toHaveLength(1);
    expect(mapInits[0]).toEqual({ center: [20, 0], zoom: 2 });

    // Drive the place-search box. The component debounces the Nominatim
    // call by 350ms, so we wait for the dropdown to appear before
    // clicking the result.
    const searchInput = screen.getByTestId("input-place-search");
    await user.type(searchInput, "Augusta National");

    const resultBtn = await screen.findByTestId(
      "place-result-12345",
      {},
      { timeout: 2000 },
    );
    await user.click(resultBtn);

    // Assert the persist PUT fired with the bounding-box centre (NOT the
    // raw Nominatim point — the component deliberately remembers the
    // centre of where the admin is looking) and the live map zoom.
    await waitFor(() => expect(server.mapCenterPuts.length).toBe(1));
    const put = server.mapCenterPuts[0];
    const expectedLat = (33.4951 + 33.5093) / 2;
    const expectedLng = (-82.0301 + -82.0151) / 2;
    expect(put.mapDefaultLat).toBeCloseTo(expectedLat, 6);
    expect(put.mapDefaultLng).toBeCloseTo(expectedLng, 6);
    expect(put.mapDefaultZoom).toBe(16);

    // ── Reload simulation ─────────────────────────────────────────────────
    // Unmount + remount: the GET now returns the saved values (as
    // strings, like the real numeric column). The fresh map must be
    // initialised at the remembered centre/zoom rather than [20, 0]/2.
    unmount();
    mapInits.length = 0;

    render(<CourseMapperPage />);
    await screen.findByText(/Riverbend GC/);

    await waitFor(() => expect(mapInits.length).toBe(1));
    expect(mapInits[0].center[0]).toBeCloseTo(expectedLat, 6);
    expect(mapInits[0].center[1]).toBeCloseTo(expectedLng, 6);
    expect(mapInits[0].zoom).toBe(16);
    // And explicitly NOT the world view.
    expect(mapInits[0]).not.toEqual({ center: [20, 0], zoom: 2 });
  });

  it("PUTs /map-center with the centroid after the first save on a blank course and reopens at it", async () => {
    const user = userEvent.setup();
    nextGetZoom = 18;

    const { unmount } = render(<CourseMapperPage />);
    await screen.findByText(/Riverbend GC/);

    // Sanity: blank course with no stored centre opens at the world view.
    expect(mapInits).toHaveLength(1);
    expect(mapInits[0]).toEqual({ center: [20, 0], zoom: 2 });

    // Draw a Green polygon (the default tool) on hole 1 by feeding the
    // mocked map's click/dblclick handlers four vertices.
    await user.click(screen.getByTestId("button-start-draw"));
    expect(currentMap).toBeTruthy();
    const onClick = currentMap!.__handlers.click!;
    const onDblClick = currentMap!.__handlers.dblclick!;

    // Square around (lat 33.50, lng -82.02) — picked so the centroid is
    // unambiguous and easy to assert with `toBeCloseTo`.
    const drawnLatLngs: Array<[number, number]> = [
      [33.5000, -82.0200],
      [33.5000, -82.0100],
      [33.5100, -82.0100],
      [33.5100, -82.0200],
    ];
    for (const [lat, lng] of drawnLatLngs) onClick({ latlng: { lat, lng } });
    onDblClick({
      latlng: { lat: 33.5100, lng: -82.0200 },
      originalEvent: { preventDefault: () => {} },
    });

    // The polygon now exists in the side list — confirm before saving so
    // we know we're saving real geometry and not an empty payload.
    await screen.findByText(/Green \(Polygon\)/);

    const saveBtn = await screen.findByTestId("button-save-geometry");
    await waitFor(() => expect(saveBtn).not.toBeDisabled());
    await user.click(saveBtn);

    // After save the post-save centroid path PUTs /map-center exactly
    // once. Centroid of the 4 distinct vertices = the box centre, which
    // is (33.5050, -82.0150). Zoom is whatever `getZoom()` reports.
    await waitFor(() => expect(server.mapCenterPuts.length).toBe(1));
    const put = server.mapCenterPuts[0];
    expect(put.mapDefaultLat).toBeCloseTo(33.5050, 6);
    expect(put.mapDefaultLng).toBeCloseTo(-82.0150, 6);
    expect(put.mapDefaultZoom).toBe(18);

    // ── Reload simulation ─────────────────────────────────────────────────
    // Fresh mount: the GET returns the persisted centre and the map
    // opens there rather than at the [20, 0] world view.
    unmount();
    mapInits.length = 0;

    render(<CourseMapperPage />);
    await screen.findByText(/Riverbend GC/);

    await waitFor(() => expect(mapInits.length).toBe(1));
    expect(mapInits[0].center[0]).toBeCloseTo(33.5050, 6);
    expect(mapInits[0].center[1]).toBeCloseTo(-82.0150, 6);
    expect(mapInits[0].zoom).toBe(18);
    expect(mapInits[0]).not.toEqual({ center: [20, 0], zoom: 2 });
  });

  it("derives the first-save centre from the bounding box of every feature, not just the first one (Task #1938)", async () => {
    // Regression for the original behaviour where the post-save
    // centroid was taken from `features[0]` only. If the very first
    // thing the admin drew was a tiny bunker on, say, hole 12, the
    // remembered centre was anchored to that bunker and the next admin
    // opened the mapper looking at one corner of the course rather
    // than at the playable area. The fix uses the bounding-box centre
    // of *all* saved features.
    const user = userEvent.setup();
    nextGetZoom = 17;

    render(<CourseMapperPage />);
    await screen.findByText(/Riverbend GC/);

    // Sanity: blank course opens at the world view.
    expect(mapInits).toHaveLength(1);
    expect(mapInits[0]).toEqual({ center: [20, 0], zoom: 2 });

    // ── Feature #1: a tiny bunker in the south-west corner of the
    //    eventual course bounding box. Drawn first so the legacy
    //    `features[0]`-only centroid would land here.
    await user.click(screen.getByTestId("button-start-draw"));
    let onClick = currentMap!.__handlers.click!;
    let onDblClick = currentMap!.__handlers.dblclick!;
    const bunkerVertices: Array<[number, number]> = [
      [33.5000, -82.0300],
      [33.5000, -82.0290],
      [33.5010, -82.0290],
      [33.5010, -82.0300],
    ];
    for (const [lat, lng] of bunkerVertices) onClick({ latlng: { lat, lng } });
    onDblClick({
      latlng: { lat: 33.5010, lng: -82.0300 },
      originalEvent: { preventDefault: () => {} },
    });
    await screen.findByText(/Green \(Polygon\)/);

    // ── Feature #2: a much larger green way over in the north-east
    //    corner. With the fix the bbox spans both shapes, so the
    //    persisted centre should sit between them.
    await user.click(screen.getByTestId("button-start-draw"));
    onClick = currentMap!.__handlers.click!;
    onDblClick = currentMap!.__handlers.dblclick!;
    const greenVertices: Array<[number, number]> = [
      [33.5180, -82.0150],
      [33.5180, -82.0100],
      [33.5200, -82.0100],
      [33.5200, -82.0150],
    ];
    for (const [lat, lng] of greenVertices) onClick({ latlng: { lat, lng } });
    onDblClick({
      latlng: { lat: 33.5200, lng: -82.0150 },
      originalEvent: { preventDefault: () => {} },
    });

    // Two features are now staged for hole 1.
    await waitFor(() =>
      expect(screen.getAllByText(/Green \(Polygon\)/).length).toBe(2),
    );

    const saveBtn = await screen.findByTestId("button-save-geometry");
    await waitFor(() => expect(saveBtn).not.toBeDisabled());
    await user.click(saveBtn);

    await waitFor(() => expect(server.mapCenterPuts.length).toBe(1));
    const put = server.mapCenterPuts[0];

    // Bounding box across both features:
    //   lat: [33.5000, 33.5200] → centre 33.5100
    //   lng: [-82.0300, -82.0100] → centre -82.0200
    const expectedLat = (33.5000 + 33.5200) / 2;
    const expectedLng = (-82.0300 + -82.0100) / 2;
    expect(put.mapDefaultLat).toBeCloseTo(expectedLat, 6);
    expect(put.mapDefaultLng).toBeCloseTo(expectedLng, 6);
    expect(put.mapDefaultZoom).toBe(17);

    // Sanity: the persisted centre sits *between* the two features
    // (strictly north of the bunker and strictly south of the green;
    // strictly east of the bunker and strictly west of the green).
    expect(put.mapDefaultLat!).toBeGreaterThan(33.5010);
    expect(put.mapDefaultLat!).toBeLessThan(33.5180);
    expect(put.mapDefaultLng!).toBeGreaterThan(-82.0290);
    expect(put.mapDefaultLng!).toBeLessThan(-82.0150);

    // And explicitly NOT the centroid of the first-drawn bunker
    // (which the legacy `features[0]`-only code would have chosen).
    const bunkerCentroidLat =
      bunkerVertices.reduce((s, [lat]) => s + lat, 0) / bunkerVertices.length;
    const bunkerCentroidLng =
      bunkerVertices.reduce((s, [, lng]) => s + lng, 0) / bunkerVertices.length;
    expect(put.mapDefaultLat).not.toBeCloseTo(bunkerCentroidLat, 4);
    expect(put.mapDefaultLng).not.toBeCloseTo(bunkerCentroidLng, 4);
  });

  it("does not re-PUT /map-center on subsequent saves once a centre is already stored", async () => {
    // Guard against a regression where the post-save centroid path
    // overwrites a deliberately-chosen search-result centre on every
    // save. The component skips the centroid PUT entirely when
    // `mapDefaultLat`/`mapDefaultLng` are already set.
    const user = userEvent.setup();

    // Pre-seed the course with a remembered centre — exactly what we'd
    // see on the second open after the first test scenario above.
    server.course.mapDefaultLat = "33.5022";
    server.course.mapDefaultLng = "-82.0226";
    server.course.mapDefaultZoom = 16;

    render(<CourseMapperPage />);
    await screen.findByText(/Riverbend GC/);

    // The first thing we expect: the map is initialised at the saved
    // centre, NOT the world view.
    expect(mapInits).toHaveLength(1);
    expect(mapInits[0].center[0]).toBeCloseTo(33.5022, 6);
    expect(mapInits[0].center[1]).toBeCloseTo(-82.0226, 6);
    expect(mapInits[0].zoom).toBe(16);

    // Draw + save a polygon on hole 1 — this would, on a blank course,
    // trigger a centroid PUT, but it must not here.
    await user.click(screen.getByTestId("button-start-draw"));
    const onClick = currentMap!.__handlers.click!;
    const onDblClick = currentMap!.__handlers.dblclick!;
    for (const [lat, lng] of [
      [33.5000, -82.0200],
      [33.5000, -82.0100],
      [33.5100, -82.0100],
      [33.5100, -82.0200],
    ] as Array<[number, number]>) onClick({ latlng: { lat, lng } });
    onDblClick({
      latlng: { lat: 33.5100, lng: -82.0200 },
      originalEvent: { preventDefault: () => {} },
    });

    await screen.findByText(/Green \(Polygon\)/);
    const saveBtn = await screen.findByTestId("button-save-geometry");
    await waitFor(() => expect(saveBtn).not.toBeDisabled());
    await user.click(saveBtn);

    // Wait for the geometry save toast so we know the save round-trip
    // completed before we assert "no map-center PUT".
    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith(
        expect.objectContaining({ title: expect.stringMatching(/Course geometry saved/i) }),
      ),
    );

    expect(server.mapCenterPuts).toHaveLength(0);
    expect(server.course.mapDefaultLat).toBe("33.5022");
    expect(server.course.mapDefaultLng).toBe("-82.0226");
  });
});
