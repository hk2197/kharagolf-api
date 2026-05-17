/**
 * UI test (Task #1148): the in-house Course Mapper round-trips drawn features
 * through POST /organizations/:orgId/courses/:courseId/geometry and re-renders
 * them after a fresh GET on the next page load.
 *
 * Strategy:
 *   - Mock `leaflet` so we can drive map clicks/dblclicks without a real DOM
 *     map, and so we can assert which shapes get rendered.
 *   - Mock `useGetMe` (org_admin), `useToast`, and `wouter`'s `useParams`.
 *   - Mock `fetch` for the course GET, the geometry GET, and the geometry POST.
 *   - Drive the user-visible flow: choose a hole, start drawing a Green
 *     polygon, click 4 vertices on the (mocked) map, double-click to finish,
 *     hit "Save all" and assert the POST body carries the drawn polygon.
 *   - Then UNMOUNT the page and remount it: the geometry GET now returns the
 *     saved row. Assert the page renders a Polygon layer with the same
 *     coordinates we drew, proving the save→reload round-trip works
 *     end-to-end against the existing API contract.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, cleanup, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// jsdom polyfills for Radix Select (uses pointer capture + scrollIntoView).
// Required by the hole-switching test below — Radix's Select component calls
// these on mount and on every open/close.
if (typeof Element !== "undefined") {
  if (!(Element.prototype as unknown as { hasPointerCapture?: unknown }).hasPointerCapture) {
    (Element.prototype as unknown as { hasPointerCapture: () => boolean }).hasPointerCapture = () => false;
  }
  if (!(Element.prototype as unknown as { releasePointerCapture?: unknown }).releasePointerCapture) {
    (Element.prototype as unknown as { releasePointerCapture: () => void }).releasePointerCapture = () => {};
  }
  if (!(Element.prototype as unknown as { setPointerCapture?: unknown }).setPointerCapture) {
    (Element.prototype as unknown as { setPointerCapture: () => void }).setPointerCapture = () => {};
  }
  if (!(Element.prototype as unknown as { scrollIntoView?: unknown }).scrollIntoView) {
    (Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {};
  }
}

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
// We don't need real geospatial rendering — we only need to (a) capture the
// click/dblclick handlers the component registers so the test can drive them,
// and (b) record what shapes are added so we can assert what was rendered.

interface MapHandlers { click?: (e: unknown) => void; dblclick?: (e: unknown) => void }
interface MockMap {
  __handlers: MapHandlers;
  on: (ev: string, h: (e: unknown) => void) => MockMap;
  off: (ev: string, h: (e: unknown) => void) => MockMap;
  removeLayer: (l: unknown) => MockMap;
  addLayer: (l: unknown) => MockMap;
  invalidateSize: () => void;
  remove: () => void;
  fitBounds: (b: unknown) => void;
}

interface MockLayer {
  __setLatLngsCalls: unknown[];
  __setLatLngCalls: unknown[];
  addTo: (m: unknown) => MockLayer;
  bindTooltip: (t: string, o?: unknown) => MockLayer;
  on: (ev: string, h: (e: unknown) => void) => MockLayer;
  setLatLngs: (x: unknown) => MockLayer;
  setLatLng: (x: unknown) => MockLayer;
}

interface MockMarker extends MockLayer {
  __handlers: Record<string, (e: unknown) => void>;
  __latlng: { lat: number; lng: number };
  __opts: unknown;
  getLatLng: () => { lat: number; lng: number };
}

const polygonCalls: Array<{ latlngs: unknown; style: unknown; layer: MockLayer }> = [];
const polylineCalls: Array<{ latlngs: unknown; style: unknown; layer: MockLayer }> = [];
const circleMarkerCalls: Array<{ latlng: unknown; opts: unknown; layer: MockLayer }> = [];
const markerInstances: MockMarker[] = [];
let currentMap: MockMap | null = null;

function makeLayer(): MockLayer {
  const setLatLngsCalls: unknown[] = [];
  const setLatLngCalls: unknown[] = [];
  const layer: MockLayer = {
    __setLatLngsCalls: setLatLngsCalls,
    __setLatLngCalls: setLatLngCalls,
    addTo: (_m: unknown) => layer,
    bindTooltip: (_t: string, _o?: unknown) => layer,
    on: (_ev: string, _h: (e: unknown) => void) => layer,
    setLatLngs: (x: unknown) => { setLatLngsCalls.push(x); return layer; },
    setLatLng: (x: unknown) => { setLatLngCalls.push(x); return layer; },
  };
  return layer;
}

vi.mock("leaflet/dist/leaflet.css", () => ({}));
vi.mock("leaflet", () => {
  const L = {
    map: (_el: unknown, _opts: unknown): MockMap => {
      const handlers: MapHandlers = {};
      const map: MockMap = {
        __handlers: handlers,
        on(ev, h) { (handlers as Record<string, (e: unknown) => void>)[ev] = h; return map; },
        off(ev) { delete (handlers as Record<string, unknown>)[ev]; return map; },
        removeLayer() { return map; },
        addLayer() { return map; },
        invalidateSize() {},
        remove() {},
        fitBounds() {},
      };
      currentMap = map;
      return map;
    },
    tileLayer: (_url: string, _opts: unknown) => ({ addTo: (_m: unknown) => ({}) }),
    latLng: (lat: number, lng: number) => ({ lat, lng }),
    latLngBounds: (_init: unknown) => {
      const b = {
        extend(_p: unknown) { return b; },
        pad(_n: number) { return b; },
        isValid() { return true; },
      };
      return b;
    },
    polygon: (latlngs: unknown, style: unknown) => {
      const layer = makeLayer();
      polygonCalls.push({ latlngs, style, layer });
      return layer;
    },
    polyline: (latlngs: unknown, style: unknown) => {
      const layer = makeLayer();
      polylineCalls.push({ latlngs, style, layer });
      return layer;
    },
    circleMarker: (latlng: unknown, opts: unknown) => {
      const layer = makeLayer();
      circleMarkerCalls.push({ latlng, opts, layer });
      return layer;
    },
    marker: (latlng: { lat: number; lng: number }, opts: unknown) => {
      const base = makeLayer();
      let cur = latlng;
      const handlers: Record<string, (e: unknown) => void> = {};
      const m: MockMarker = {
        ...base,
        __handlers: handlers,
        get __latlng() { return cur; },
        set __latlng(v: { lat: number; lng: number }) { cur = v; },
        __opts: opts,
        on(ev: string, h: (e: unknown) => void) { handlers[ev] = h; return m; },
        addTo(_m: unknown) { return m; },
        bindTooltip(_t: string, _o?: unknown) { return m; },
        setLatLng(p: unknown) {
          base.__setLatLngCalls.push(p);
          if (
            p && typeof p === 'object'
            && 'lat' in (p as object) && 'lng' in (p as object)
          ) cur = p as { lat: number; lng: number };
          return m;
        },
        setLatLngs(x: unknown) { base.__setLatLngsCalls.push(x); return m; },
        getLatLng: () => cur,
      };
      markerInstances.push(m);
      return m;
    },
    divIcon: (_o: unknown) => ({}),
    layerGroup: (_layers: unknown) => ({ addTo: (_m: unknown) => ({}) }),
    DomEvent: { stopPropagation: (_e: unknown) => {} },
  };
  return { default: L, ...L };
});

import CourseMapperPage from "../course-mapper";

// ── Server stub ─────────────────────────────────────────────────────────────
interface GeomFeature {
  id: number;
  holeNumber: number;
  featureType: string;
  label: string | null;
  geometry: { type: string; coordinates: unknown };
}
interface ServerState {
  course: { id: number; name: string; holes: number; location: string | null };
  features: GeomFeature[];
  postBodies: unknown[];
}
let server: ServerState;

function installFetch() {
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();

    if (url.match(/\/organizations\/42\/courses\/7\/geometry/) && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as {
        replace?: boolean;
        features: Array<Omit<GeomFeature, "id">>;
      };
      server.postBodies.push(body);
      if (body.replace !== false) server.features = [];
      let nextId = 1000;
      for (const f of body.features) {
        server.features.push({ id: nextId++, ...f });
      }
      return new Response(
        JSON.stringify({ courseId: 7, features: server.features, replaced: true }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ) as unknown as Response;
    }
    if (url.match(/\/organizations\/42\/courses\/7\/geometry/)) {
      return new Response(
        JSON.stringify({ courseId: 7, features: server.features }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ) as unknown as Response;
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
  polygonCalls.length = 0;
  polylineCalls.length = 0;
  circleMarkerCalls.length = 0;
  markerInstances.length = 0;
  currentMap = null;
  server = {
    course: { id: 7, name: "Riverbend GC", holes: 18, location: null },
    features: [],
    postBodies: [],
  };
  installFetch();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("<CourseMapperPage /> — draw → save → reload round-trip", () => {
  it("draws a green polygon for hole 1, saves it, and re-renders it after a fresh page load", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<CourseMapperPage />);

    // Initial load: course header is visible, no features yet, no Polygon
    // rendered.
    await screen.findByText(/Riverbend GC/);
    expect(polygonCalls).toHaveLength(0);
    expect(screen.getByText(/Nothing drawn yet for this hole/)).toBeInTheDocument();

    // Hole select defaults to 1; default tool is Green (Polygon). Start drawing.
    await user.click(screen.getByTestId("button-start-draw"));
    expect(currentMap).toBeTruthy();
    const onClick = currentMap!.__handlers.click!;
    const onDblClick = currentMap!.__handlers.dblclick!;
    expect(onClick).toBeTypeOf("function");
    expect(onDblClick).toBeTypeOf("function");

    // Drop 4 vertices forming a small square around (10, 20) (lat, lng).
    const drawnLatLngs: Array<[number, number]> = [
      [10.0001, 20.0001],
      [10.0001, 20.0003],
      [10.0003, 20.0003],
      [10.0003, 20.0001],
    ];
    for (const [lat, lng] of drawnLatLngs) {
      onClick({ latlng: { lat, lng } });
    }
    // Double-click finalizes the polygon.
    onDblClick({ latlng: { lat: 10.0003, lng: 20.0001 }, originalEvent: { preventDefault: () => {} } });

    // Feature should now appear in the side list (label-less default name).
    await screen.findByText(/Green \(Polygon\)/);

    // Save the canvas.
    const saveBtn = await screen.findByTestId("button-save-geometry");
    await waitFor(() => expect(saveBtn).not.toBeDisabled());
    await user.click(saveBtn);

    // Assert POST went out with the drawn polygon, in [lng, lat] GeoJSON order
    // and with the closing duplicate vertex.
    await waitFor(() => expect(server.postBodies.length).toBe(1));
    const body = server.postBodies[0] as {
      replace: boolean;
      features: Array<{
        holeNumber: number;
        featureType: string;
        source: string;
        geometry: { type: string; coordinates: number[][][] };
      }>;
    };
    expect(body.replace).toBe(true);
    expect(body.features).toHaveLength(1);
    const f = body.features[0];
    expect(f.holeNumber).toBe(1);
    expect(f.featureType).toBe("green");
    expect(f.source).toBe("in_house");
    expect(f.geometry.type).toBe("Polygon");
    const ring = f.geometry.coordinates[0];
    expect(ring).toHaveLength(drawnLatLngs.length + 1); // closed
    // First vertex (lng, lat order):
    expect(ring[0]).toEqual([20.0001, 10.0001]);
    // Closing vertex equals first.
    expect(ring[ring.length - 1]).toEqual(ring[0]);

    // Server confirms persistence and the toast fires.
    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith(
        expect.objectContaining({ title: expect.stringMatching(/Course geometry saved/i) }),
      ),
    );
    expect(server.features).toHaveLength(1);
    expect(server.features[0].featureType).toBe("green");
    expect(server.features[0].holeNumber).toBe(1);

    // ── Reload simulation ─────────────────────────────────────────────────
    // Unmount and re-mount the page — this triggers the initial fetches
    // again. The geometry GET now returns the saved row, so the polygon must
    // be rendered on the fresh map without the user touching anything.
    polygonCalls.length = 0;
    unmount();

    render(<CourseMapperPage />);
    await screen.findByText(/Riverbend GC/);

    // The reloaded feature appears in the side list and a Polygon layer is
    // rendered with the saved coordinates.
    await screen.findByText(/Green \(Polygon\)/);
    await waitFor(() => expect(polygonCalls.length).toBeGreaterThanOrEqual(1));

    // The component calls L.polygon(ring, style) with ring = LatLng[] taken
    // straight from the saved coordinates — including the closing duplicate.
    const renderedRing = polygonCalls[0].latlngs as Array<{ lat: number; lng: number }>;
    expect(renderedRing).toHaveLength(drawnLatLngs.length + 1);
    expect(renderedRing[0]).toMatchObject({ lat: 10.0001, lng: 20.0001 });
    expect(renderedRing[renderedRing.length - 1]).toMatchObject(renderedRing[0]);
  });

  // ── Task #1321 ────────────────────────────────────────────────────────────
  // Beyond the bare draw-and-reload path, the mapper also lets admins switch
  // between holes, inline-edit a feature label, and delete a saved feature.
  // The next three tests pin those interactions so they can't quietly break.

  it("renders only the active hole's features when switching between holes", async () => {
    const user = userEvent.setup();

    // Pre-seed two server features on different holes so we can prove the
    // hole-select filters what the canvas (and side list) shows.
    const HOLE1_GREEN_RING: Array<[number, number]> = [
      [20.0001, 10.0001],
      [20.0003, 10.0001],
      [20.0003, 10.0003],
      [20.0001, 10.0003],
      [20.0001, 10.0001], // closing duplicate
    ];
    const HOLE5_FAIRWAY_RING: Array<[number, number]> = [
      [30.0001, 40.0001],
      [30.0005, 40.0001],
      [30.0005, 40.0005],
      [30.0001, 40.0005],
      [30.0001, 40.0001],
    ];
    server.features = [
      {
        id: 501,
        holeNumber: 1,
        featureType: "green",
        label: "Front green",
        geometry: { type: "Polygon", coordinates: [HOLE1_GREEN_RING] },
      },
      {
        id: 502,
        holeNumber: 5,
        featureType: "fairway",
        label: "Main fairway",
        geometry: { type: "Polygon", coordinates: [HOLE5_FAIRWAY_RING] },
      },
    ];

    render(<CourseMapperPage />);
    await screen.findByText(/Riverbend GC/);

    // Default hole is 1 — only the green should appear in the side list,
    // and exactly one polygon (the green) should be on the map.
    await screen.findByText(/Front green/);
    expect(screen.queryByText(/Main fairway/)).not.toBeInTheDocument();
    await waitFor(() => expect(polygonCalls.length).toBe(1));
    expect(polygonCalls[0].latlngs).toEqual(
      HOLE1_GREEN_RING.map(([lng, lat]) => ({ lat, lng })),
    );

    // Switch the hole select from 1 → 5. Reset the polygon spy first so the
    // next assertion only sees the post-switch render.
    polygonCalls.length = 0;
    const trigger = screen.getByTestId("select-hole");
    await user.click(trigger);
    // Use the exact accessible name — /Hole 5/ alone would also match
    // "Hole 15" once that hole gets a fairway, and the bare /Hole 1/
    // regex would match Hole 1 plus Hole 10–18.
    const opt5 = await screen.findByRole("option", { name: "Hole 5 • fairway ✓" });
    await user.click(opt5);

    // Now only the fairway should be in the side list and on the map.
    await screen.findByText(/Main fairway/);
    expect(screen.queryByText(/Front green/)).not.toBeInTheDocument();
    await waitFor(() => expect(polygonCalls.length).toBe(1));
    expect(polygonCalls[0].latlngs).toEqual(
      HOLE5_FAIRWAY_RING.map(([lng, lat]) => ({ lat, lng })),
    );

    // And jumping back to hole 1 brings the green back without dragging the
    // fairway with it — proves the filter is symmetric.
    polygonCalls.length = 0;
    await user.click(trigger);
    const opt1 = await screen.findByRole("option", { name: "Hole 1" });
    await user.click(opt1);
    await screen.findByText(/Front green/);
    expect(screen.queryByText(/Main fairway/)).not.toBeInTheDocument();
    await waitFor(() => expect(polygonCalls.length).toBe(1));
    expect(polygonCalls[0].latlngs).toEqual(
      HOLE1_GREEN_RING.map(([lng, lat]) => ({ lat, lng })),
    );
  });

  it("round-trips an inline label edit through Save and reload", async () => {
    const user = userEvent.setup();

    // Pre-seed one server feature with an outdated label.
    const RING: Array<[number, number]> = [
      [20.0001, 10.0001],
      [20.0003, 10.0001],
      [20.0003, 10.0003],
      [20.0001, 10.0001],
    ];
    server.features = [
      {
        id: 700,
        holeNumber: 1,
        featureType: "green",
        label: "Old label",
        geometry: { type: "Polygon", coordinates: [RING] },
      },
    ];

    const { unmount } = render(<CourseMapperPage />);
    await screen.findByText(/Riverbend GC/);
    await screen.findByText(/Old label/);

    // Click the row to select it — this opens the "Selected feature" card
    // with the inline label editor.
    await user.click(screen.getByTestId("feature-row-srv_700"));

    const labelInput = await screen.findByTestId("input-edit-label");
    expect(labelInput).toHaveValue("Old label");
    await user.clear(labelInput);
    await user.type(labelInput, "Front green tier 2");
    await user.click(screen.getByTestId("button-save-label"));

    // The side list now reflects the new label and the canvas is dirty.
    await screen.findByText(/Front green tier 2/);
    expect(screen.queryByText(/Old label/)).not.toBeInTheDocument();

    // Save the canvas and assert the POST carries the renamed feature
    // (and only that one) with the rest of the row preserved.
    const saveBtn = screen.getByTestId("button-save-geometry");
    await waitFor(() => expect(saveBtn).not.toBeDisabled());
    await user.click(saveBtn);

    await waitFor(() => expect(server.postBodies.length).toBe(1));
    const body = server.postBodies[0] as {
      replace: boolean;
      features: Array<{
        holeNumber: number;
        featureType: string;
        label: string | null;
        geometry: { type: string };
      }>;
    };
    expect(body.replace).toBe(true);
    expect(body.features).toHaveLength(1);
    expect(body.features[0]).toMatchObject({
      holeNumber: 1,
      featureType: "green",
      label: "Front green tier 2",
    });
    expect(body.features[0].geometry.type).toBe("Polygon");

    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith(
        expect.objectContaining({ title: expect.stringMatching(/Course geometry saved/i) }),
      ),
    );

    // ── Reload simulation ─────────────────────────────────────────────────
    // Unmount and re-mount; the server now returns the renamed row, so the
    // new label must appear on the next open without any user action.
    unmount();
    render(<CourseMapperPage />);
    await screen.findByText(/Riverbend GC/);
    await screen.findByText(/Front green tier 2/);
    expect(screen.queryByText(/Old label/)).not.toBeInTheDocument();
  });

  it("round-trips a feature deletion through Save and reload", async () => {
    const user = userEvent.setup();

    // Two features on hole 1 — we'll delete the bunker and keep the green.
    const GREEN_RING: Array<[number, number]> = [
      [20.0001, 10.0001],
      [20.0003, 10.0001],
      [20.0003, 10.0003],
      [20.0001, 10.0001],
    ];
    const BUNKER_RING: Array<[number, number]> = [
      [20.0010, 10.0010],
      [20.0012, 10.0010],
      [20.0012, 10.0012],
      [20.0010, 10.0010],
    ];
    server.features = [
      {
        id: 800,
        holeNumber: 1,
        featureType: "green",
        label: "Keep me",
        geometry: { type: "Polygon", coordinates: [GREEN_RING] },
      },
      {
        id: 801,
        holeNumber: 1,
        featureType: "hazard_bunker",
        label: "Drop me",
        geometry: { type: "Polygon", coordinates: [BUNKER_RING] },
      },
    ];

    const { unmount } = render(<CourseMapperPage />);
    await screen.findByText(/Riverbend GC/);

    // Both features are listed initially.
    await screen.findByText(/Keep me/);
    await screen.findByText(/Drop me/);

    // Click the row's trash icon to delete the bunker. The button is
    // nested inside the row and stops propagation so the row's onClick
    // (which would select it) doesn't fire — exactly what we want.
    const bunkerRow = screen.getByTestId("feature-row-srv_801");
    await user.click(within(bunkerRow).getByTestId("button-delete-srv_801"));

    // Side list immediately drops the deleted feature.
    await waitFor(() => expect(screen.queryByText(/Drop me/)).not.toBeInTheDocument());
    expect(screen.getByText(/Keep me/)).toBeInTheDocument();

    // Persist the deletion via Save all.
    const saveBtn = screen.getByTestId("button-save-geometry");
    await waitFor(() => expect(saveBtn).not.toBeDisabled());
    await user.click(saveBtn);

    await waitFor(() => expect(server.postBodies.length).toBe(1));
    const body = server.postBodies[0] as {
      replace: boolean;
      features: Array<{ holeNumber: number; featureType: string; label: string | null }>;
    };
    expect(body.replace).toBe(true);
    // Only the surviving feature is sent — the deletion is encoded as
    // its absence from the replace payload.
    expect(body.features).toHaveLength(1);
    expect(body.features[0]).toMatchObject({
      holeNumber: 1,
      featureType: "green",
      label: "Keep me",
    });

    // Server state agrees: the bunker is gone after the replace.
    expect(server.features).toHaveLength(1);
    expect(server.features[0].featureType).toBe("green");

    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith(
        expect.objectContaining({ title: expect.stringMatching(/Course geometry saved/i) }),
      ),
    );

    // ── Reload simulation ─────────────────────────────────────────────────
    // After a fresh mount the deleted bunker must not reappear.
    unmount();
    render(<CourseMapperPage />);
    await screen.findByText(/Riverbend GC/);
    await screen.findByText(/Keep me/);
    expect(screen.queryByText(/Drop me/)).not.toBeInTheDocument();
  });

  // ── Task #1567 ────────────────────────────────────────────────────────────
  // Dragging a vertex handle is the most common reshape interaction. The
  // component (a) live-updates the rendered shape during the drag without
  // touching React state, and (b) commits the new vertex into `features`
  // on dragend — taking care to keep a Polygon's closing duplicate vertex
  // in sync when vertex 0 moves. The next three tests pin all three
  // branches (mid-vertex polygon drag, vertex-0 polygon drag, line drag)
  // and verify the new geometry survives Save → reload.

  it("drags a polygon vertex (not vertex 0) and round-trips the new shape", async () => {
    const user = userEvent.setup();

    // Pre-seed a closed square polygon so the vertex handles render at
    // known positions. GeoJSON order is [lng, lat].
    const RING: Array<[number, number]> = [
      [20.0001, 10.0001],
      [20.0003, 10.0001],
      [20.0003, 10.0003],
      [20.0001, 10.0003],
      [20.0001, 10.0001], // closing duplicate
    ];
    server.features = [
      {
        id: 900,
        holeNumber: 1,
        featureType: "green",
        label: "Drag me",
        geometry: { type: "Polygon", coordinates: [RING] },
      },
    ];

    const { unmount } = render(<CourseMapperPage />);
    await screen.findByText(/Riverbend GC/);
    await screen.findByText(/Drag me/);

    // Initial render: one polygon, no vertex handles yet (nothing selected).
    await waitFor(() => expect(polygonCalls.length).toBe(1));
    expect(markerInstances).toHaveLength(0);

    // Selecting the row re-runs the layer effect and then the vertex
    // handle effect, so a fresh polygon layer is created (this is the
    // one the live drag handler will mutate via setLatLngs) and one
    // draggable marker is created per open-ring vertex (4 for a square).
    polygonCalls.length = 0;
    await user.click(screen.getByTestId("feature-row-srv_900"));
    await waitFor(() => expect(polygonCalls.length).toBe(1));
    await waitFor(() => expect(markerInstances).toHaveLength(4));

    // Sanity check: handles sit at the open ring positions, in order.
    expect(markerInstances[0].getLatLng()).toEqual({ lat: 10.0001, lng: 20.0001 });
    expect(markerInstances[1].getLatLng()).toEqual({ lat: 10.0001, lng: 20.0003 });
    expect(markerInstances[2].getLatLng()).toEqual({ lat: 10.0003, lng: 20.0003 });
    expect(markerInstances[3].getLatLng()).toEqual({ lat: 10.0003, lng: 20.0001 });

    const liveShape = polygonCalls[0].layer;
    expect(liveShape.__setLatLngsCalls).toHaveLength(0);

    // Simulate dragging vertex 1 to a brand-new position. Real Leaflet
    // updates the marker's internal latlng before firing the event; we
    // mirror that by setting __latlng so getLatLng() returns the new
    // position from inside the component's drag handler.
    const NEW_LAT = 10.0010;
    const NEW_LNG = 20.0030;
    const m1 = markerInstances[1];
    m1.__latlng = { lat: NEW_LAT, lng: NEW_LNG };
    m1.__handlers.drag!({ target: m1 });

    // Live update went straight to the rendered polygon (no React churn).
    // The drag handler passes [openRing] — 4 entries, no closing duplicate.
    expect(liveShape.__setLatLngsCalls).toHaveLength(1);
    expect(liveShape.__setLatLngsCalls[0]).toEqual([
      [
        { lat: 10.0001, lng: 20.0001 },
        { lat: NEW_LAT, lng: NEW_LNG },
        { lat: 10.0003, lng: 20.0003 },
        { lat: 10.0003, lng: 20.0001 },
      ],
    ]);

    // dragend commits the vertex into React state and marks the canvas dirty.
    m1.__handlers.dragend!({ target: m1 });

    const saveBtn = await screen.findByTestId("button-save-geometry");
    await waitFor(() => expect(saveBtn).not.toBeDisabled());
    await user.click(saveBtn);

    await waitFor(() => expect(server.postBodies.length).toBe(1));
    const body = server.postBodies[0] as {
      replace: boolean;
      features: Array<{
        holeNumber: number;
        featureType: string;
        geometry: { type: string; coordinates: number[][][] };
      }>;
    };
    expect(body.replace).toBe(true);
    expect(body.features).toHaveLength(1);
    const sentRing = body.features[0].geometry.coordinates[0];
    // Same length (closed), same first/last (vertex 0 wasn't moved), and
    // vertex 1 carries the dragged coordinates in [lng, lat] order.
    expect(sentRing).toHaveLength(RING.length);
    expect(sentRing[0]).toEqual([20.0001, 10.0001]);
    expect(sentRing[1]).toEqual([NEW_LNG, NEW_LAT]);
    expect(sentRing[2]).toEqual([20.0003, 10.0003]);
    expect(sentRing[3]).toEqual([20.0001, 10.0003]);
    expect(sentRing[sentRing.length - 1]).toEqual(sentRing[0]);

    // ── Reload simulation ─────────────────────────────────────────────────
    polygonCalls.length = 0;
    markerInstances.length = 0;
    unmount();
    render(<CourseMapperPage />);
    await screen.findByText(/Riverbend GC/);
    await screen.findByText(/Drag me/);
    await waitFor(() => expect(polygonCalls.length).toBeGreaterThanOrEqual(1));

    // Reloaded polygon carries the dragged vertex.
    const reloadedRing = polygonCalls[0].latlngs as Array<{ lat: number; lng: number }>;
    expect(reloadedRing).toHaveLength(RING.length);
    expect(reloadedRing[1]).toMatchObject({ lat: NEW_LAT, lng: NEW_LNG });
    expect(reloadedRing[reloadedRing.length - 1]).toMatchObject(reloadedRing[0]);
  });

  it("drags polygon vertex 0 and keeps the closing duplicate in sync", async () => {
    const user = userEvent.setup();

    const RING: Array<[number, number]> = [
      [20.0001, 10.0001],
      [20.0003, 10.0001],
      [20.0003, 10.0003],
      [20.0001, 10.0003],
      [20.0001, 10.0001], // closing duplicate
    ];
    server.features = [
      {
        id: 901,
        holeNumber: 1,
        featureType: "fairway",
        label: "First-vertex drag",
        geometry: { type: "Polygon", coordinates: [RING] },
      },
    ];

    const { unmount } = render(<CourseMapperPage />);
    await screen.findByText(/Riverbend GC/);
    await screen.findByText(/First-vertex drag/);

    // Select to spawn handles.
    polygonCalls.length = 0;
    await user.click(screen.getByTestId("feature-row-srv_901"));
    await waitFor(() => expect(polygonCalls.length).toBe(1));
    await waitFor(() => expect(markerInstances).toHaveLength(4));

    // Drag vertex 0 — this is the path that must also mirror the move
    // into the closing duplicate to keep the ring valid.
    const NEW_LAT = 10.0099;
    const NEW_LNG = 20.0099;
    const m0 = markerInstances[0];
    m0.__latlng = { lat: NEW_LAT, lng: NEW_LNG };
    m0.__handlers.dragend!({ target: m0 });

    const saveBtn = await screen.findByTestId("button-save-geometry");
    await waitFor(() => expect(saveBtn).not.toBeDisabled());
    await user.click(saveBtn);

    await waitFor(() => expect(server.postBodies.length).toBe(1));
    const body = server.postBodies[0] as {
      replace: boolean;
      features: Array<{ geometry: { type: string; coordinates: number[][][] } }>;
    };
    const sentRing = body.features[0].geometry.coordinates[0];
    expect(sentRing).toHaveLength(RING.length);
    // Both first AND closing duplicate must reflect the dragged position.
    expect(sentRing[0]).toEqual([NEW_LNG, NEW_LAT]);
    expect(sentRing[sentRing.length - 1]).toEqual([NEW_LNG, NEW_LAT]);
    // Middle vertices are untouched.
    expect(sentRing[1]).toEqual([20.0003, 10.0001]);
    expect(sentRing[2]).toEqual([20.0003, 10.0003]);
    expect(sentRing[3]).toEqual([20.0001, 10.0003]);

    // ── Reload simulation ─────────────────────────────────────────────────
    polygonCalls.length = 0;
    markerInstances.length = 0;
    unmount();
    render(<CourseMapperPage />);
    await screen.findByText(/Riverbend GC/);
    await screen.findByText(/First-vertex drag/);
    await waitFor(() => expect(polygonCalls.length).toBeGreaterThanOrEqual(1));

    const reloadedRing = polygonCalls[0].latlngs as Array<{ lat: number; lng: number }>;
    expect(reloadedRing).toHaveLength(RING.length);
    expect(reloadedRing[0]).toMatchObject({ lat: NEW_LAT, lng: NEW_LNG });
    // The closing duplicate matches the new first vertex — proves the
    // sync survived the round-trip and didn't get clobbered server-side.
    expect(reloadedRing[reloadedRing.length - 1]).toMatchObject({
      lat: NEW_LAT,
      lng: NEW_LNG,
    });
  });

  it("drags a LineString vertex and round-trips the reshape", async () => {
    const user = userEvent.setup();

    // A 3-point cart path: handles will sit at each vertex (no closing
    // duplicate to worry about for lines).
    const PATH: Array<[number, number]> = [
      [50.0001, 30.0001],
      [50.0005, 30.0001],
      [50.0005, 30.0005],
    ];
    server.features = [
      {
        id: 950,
        holeNumber: 1,
        featureType: "cart_path",
        label: "Path A",
        geometry: { type: "LineString", coordinates: PATH },
      },
    ];

    const { unmount } = render(<CourseMapperPage />);
    await screen.findByText(/Riverbend GC/);
    await screen.findByText(/Path A/);

    // Initial render: one polyline (no polygon).
    await waitFor(() => expect(polylineCalls.length).toBe(1));
    expect(polygonCalls).toHaveLength(0);
    expect(markerInstances).toHaveLength(0);

    // Select to spawn handles. Selecting recreates the polyline layer
    // (with selected weight), and that fresh layer is what the drag
    // handler mutates live.
    polylineCalls.length = 0;
    await user.click(screen.getByTestId("feature-row-srv_950"));
    await waitFor(() => expect(polylineCalls.length).toBe(1));
    await waitFor(() => expect(markerInstances).toHaveLength(PATH.length));

    expect(markerInstances[0].getLatLng()).toEqual({ lat: 30.0001, lng: 50.0001 });
    expect(markerInstances[1].getLatLng()).toEqual({ lat: 30.0001, lng: 50.0005 });
    expect(markerInstances[2].getLatLng()).toEqual({ lat: 30.0005, lng: 50.0005 });

    const liveLine = polylineCalls[0].layer;
    expect(liveLine.__setLatLngsCalls).toHaveLength(0);

    // Drag the middle vertex.
    const NEW_LAT = 30.0050;
    const NEW_LNG = 50.0050;
    const mid = markerInstances[1];
    mid.__latlng = { lat: NEW_LAT, lng: NEW_LNG };
    mid.__handlers.drag!({ target: mid });

    // Live polyline update — note lines pass a flat LatLng[] (no extra
    // wrapping array, unlike Polygon).
    expect(liveLine.__setLatLngsCalls).toHaveLength(1);
    expect(liveLine.__setLatLngsCalls[0]).toEqual([
      { lat: 30.0001, lng: 50.0001 },
      { lat: NEW_LAT, lng: NEW_LNG },
      { lat: 30.0005, lng: 50.0005 },
    ]);

    mid.__handlers.dragend!({ target: mid });

    const saveBtn = await screen.findByTestId("button-save-geometry");
    await waitFor(() => expect(saveBtn).not.toBeDisabled());
    await user.click(saveBtn);

    await waitFor(() => expect(server.postBodies.length).toBe(1));
    const body = server.postBodies[0] as {
      replace: boolean;
      features: Array<{
        featureType: string;
        geometry: { type: string; coordinates: number[][] };
      }>;
    };
    expect(body.features).toHaveLength(1);
    expect(body.features[0].featureType).toBe("cart_path");
    expect(body.features[0].geometry.type).toBe("LineString");
    const sentPath = body.features[0].geometry.coordinates;
    expect(sentPath).toHaveLength(PATH.length);
    // Endpoints untouched, middle vertex carries the dragged coordinates
    // in [lng, lat] GeoJSON order.
    expect(sentPath[0]).toEqual([50.0001, 30.0001]);
    expect(sentPath[1]).toEqual([NEW_LNG, NEW_LAT]);
    expect(sentPath[2]).toEqual([50.0005, 30.0005]);

    // ── Reload simulation ─────────────────────────────────────────────────
    polylineCalls.length = 0;
    markerInstances.length = 0;
    unmount();
    render(<CourseMapperPage />);
    await screen.findByText(/Riverbend GC/);
    await screen.findByText(/Path A/);
    await waitFor(() => expect(polylineCalls.length).toBeGreaterThanOrEqual(1));

    const reloadedPath = polylineCalls[0].latlngs as Array<{ lat: number; lng: number }>;
    expect(reloadedPath).toHaveLength(PATH.length);
    expect(reloadedPath[1]).toMatchObject({ lat: NEW_LAT, lng: NEW_LNG });
  });

  // ── Task #1568 ────────────────────────────────────────────────────────────
  // The original round-trip test only exercised Polygon mode (Greens /
  // Fairways). The mapper also offers LineString tools (OOB lines, cart
  // paths) and Point tools (tee-box / hazard pins). Each of those takes a
  // distinct branch through finishDrawing() and renders via a different
  // Leaflet primitive (L.polyline / L.circleMarker), so a regression in
  // either branch would slip through CI without these. The two tests below
  // mirror the polygon round-trip: switch the tool, drive the map handlers
  // to draw the feature, save, reload, and assert the saved coordinates
  // come back through the matching Leaflet primitive on the fresh mount.

  it("draws an OOB LineString, saves it, and re-renders the polyline after a fresh page load", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<CourseMapperPage />);

    await screen.findByText(/Riverbend GC/);
    // No features yet, so the polyline render path hasn't run.
    expect(polylineCalls).toHaveLength(0);

    // Switch the active tool from the default Green (Polygon) to OOB (LineString).
    await user.click(screen.getByTestId("select-feature-type"));
    // Cart path is also a LineString tool, so anchor on the unique label.
    const oobOpt = await screen.findByRole("option", { name: /OOB \/ red line/ });
    await user.click(oobOpt);

    await user.click(screen.getByTestId("button-start-draw"));
    expect(currentMap).toBeTruthy();
    const onClick = currentMap!.__handlers.click!;
    const onDblClick = currentMap!.__handlers.dblclick!;
    expect(onClick).toBeTypeOf("function");
    expect(onDblClick).toBeTypeOf("function");

    // Three vertices forming an L-shaped OOB segment (lat, lng order).
    const drawnLatLngs: Array<[number, number]> = [
      [12.0001, 22.0001],
      [12.0002, 22.0002],
      [12.0003, 22.0001],
    ];
    for (const [lat, lng] of drawnLatLngs) {
      onClick({ latlng: { lat, lng } });
    }
    // Double-click finalizes the polyline (min 2 vertices for LineString).
    onDblClick({
      latlng: { lat: 12.0003, lng: 22.0001 },
      originalEvent: { preventDefault: () => {} },
    });

    // The new feature shows up in the side list with the (LineString) suffix.
    await screen.findByText(/OOB \(LineString\)/);

    const saveBtn = await screen.findByTestId("button-save-geometry");
    await waitFor(() => expect(saveBtn).not.toBeDisabled());
    await user.click(saveBtn);

    // Assert the POST carries a LineString geometry — no closing duplicate
    // vertex (that's a Polygon-only thing) and coordinates in [lng, lat]
    // GeoJSON order.
    await waitFor(() => expect(server.postBodies.length).toBe(1));
    const body = server.postBodies[0] as {
      replace: boolean;
      features: Array<{
        holeNumber: number;
        featureType: string;
        source: string;
        geometry: { type: string; coordinates: number[][] };
      }>;
    };
    expect(body.replace).toBe(true);
    expect(body.features).toHaveLength(1);
    const f = body.features[0];
    expect(f.holeNumber).toBe(1);
    expect(f.featureType).toBe("hazard_oob");
    expect(f.source).toBe("in_house");
    expect(f.geometry.type).toBe("LineString");
    expect(f.geometry.coordinates).toHaveLength(drawnLatLngs.length);
    expect(f.geometry.coordinates[0]).toEqual([22.0001, 12.0001]);
    expect(f.geometry.coordinates[1]).toEqual([22.0002, 12.0002]);
    expect(f.geometry.coordinates[2]).toEqual([22.0001, 12.0003]);

    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith(
        expect.objectContaining({ title: expect.stringMatching(/Course geometry saved/i) }),
      ),
    );
    expect(server.features).toHaveLength(1);
    expect(server.features[0].featureType).toBe("hazard_oob");

    // ── Reload simulation ─────────────────────────────────────────────────
    // Reset the polyline spy before unmount so the post-reload assertion
    // only sees the render that fires on the fresh mount (the draft draw
    // and post-save reseed both add to the same array up to this point).
    polylineCalls.length = 0;
    unmount();

    render(<CourseMapperPage />);
    await screen.findByText(/Riverbend GC/);

    // The reloaded LineString appears in the side list and is rendered by
    // L.polyline — not L.polygon — with the saved coordinates in click order.
    await screen.findByText(/OOB \(LineString\)/);
    await waitFor(() => expect(polylineCalls.length).toBeGreaterThanOrEqual(1));
    // Polygon path must NOT have been used for a LineString feature.
    expect(polygonCalls).toHaveLength(0);

    const renderedPts = polylineCalls[0].latlngs as Array<{ lat: number; lng: number }>;
    expect(renderedPts).toHaveLength(drawnLatLngs.length);
    expect(renderedPts[0]).toMatchObject({ lat: 12.0001, lng: 22.0001 });
    expect(renderedPts[1]).toMatchObject({ lat: 12.0002, lng: 22.0002 });
    expect(renderedPts[2]).toMatchObject({ lat: 12.0003, lng: 22.0001 });
  });

  it("places a tee-box marker (Point), saves it, and re-renders the circleMarker after a fresh page load", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<CourseMapperPage />);

    await screen.findByText(/Riverbend GC/);
    // No features yet, so no circleMarker has been rendered.
    expect(circleMarkerCalls).toHaveLength(0);

    // Switch the active tool from Green (Polygon) to Tee box marker (Point).
    // The dropdown also lists "Hazard marker (pin)" — anchor on the
    // unique tee-box label so we definitely select the right Point tool.
    await user.click(screen.getByTestId("select-feature-type"));
    const teeOpt = await screen.findByRole("option", { name: /Tee box marker \(pin\)/ });
    await user.click(teeOpt);

    await user.click(screen.getByTestId("button-start-draw"));
    expect(currentMap).toBeTruthy();
    const onClick = currentMap!.__handlers.click!;
    expect(onClick).toBeTypeOf("function");

    // A single click in Point mode finalizes the marker — no dblclick
    // needed (and the dblclick handler is never invoked here, exercising
    // the Point branch of finishDrawing()).
    const pinLat = 14.5;
    const pinLng = 24.5;
    onClick({ latlng: { lat: pinLat, lng: pinLng } });

    // Side list shows the new pin with a (Point) suffix.
    await screen.findByText(/Tee box \(Point\)/);

    const saveBtn = await screen.findByTestId("button-save-geometry");
    await waitFor(() => expect(saveBtn).not.toBeDisabled());
    await user.click(saveBtn);

    // POST body must carry a Point geometry whose single coordinate pair
    // is in [lng, lat] order — not [lat, lng] and not wrapped in an extra
    // array like LineString/Polygon would be.
    await waitFor(() => expect(server.postBodies.length).toBe(1));
    const body = server.postBodies[0] as {
      replace: boolean;
      features: Array<{
        holeNumber: number;
        featureType: string;
        source: string;
        geometry: { type: string; coordinates: number[] };
      }>;
    };
    expect(body.replace).toBe(true);
    expect(body.features).toHaveLength(1);
    const f = body.features[0];
    expect(f.holeNumber).toBe(1);
    expect(f.featureType).toBe("tee_box");
    expect(f.source).toBe("in_house");
    expect(f.geometry.type).toBe("Point");
    expect(f.geometry.coordinates).toEqual([pinLng, pinLat]);

    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith(
        expect.objectContaining({ title: expect.stringMatching(/Course geometry saved/i) }),
      ),
    );
    expect(server.features).toHaveLength(1);
    expect(server.features[0].featureType).toBe("tee_box");
    expect(server.features[0].geometry.type).toBe("Point");

    // ── Reload simulation ─────────────────────────────────────────────────
    // Reset the circleMarker spy: rendering the in-progress draft (and the
    // post-save reseed) both add to it; we only want to see the render
    // triggered by the fresh mount below.
    circleMarkerCalls.length = 0;
    unmount();

    render(<CourseMapperPage />);
    await screen.findByText(/Riverbend GC/);

    // The reloaded marker appears in the side list and is rendered by
    // L.circleMarker — not L.polygon or L.polyline — at the saved coords.
    await screen.findByText(/Tee box \(Point\)/);
    await waitFor(() => expect(circleMarkerCalls.length).toBeGreaterThanOrEqual(1));
    // Neither of the area primitives should have been used for a Point.
    expect(polygonCalls).toHaveLength(0);
    expect(polylineCalls).toHaveLength(0);

    const rendered = circleMarkerCalls[0].latlng as { lat: number; lng: number };
    expect(rendered).toMatchObject({ lat: pinLat, lng: pinLng });
  });
});
