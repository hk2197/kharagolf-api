import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useParams, Link } from 'wouter';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { useGetMe } from '@workspace/api-client-react';
// Task #1934 — `DEFAULT_REMEMBERED_ZOOM` (and `geometryCentroid`, used
// by the `backfill:course-map-defaults` script) live in
// `@workspace/course-map-defaults` so this page and the backfill can
// never silently disagree on what "remembered centre" means. This page
// itself only needs the constant — Task #1937 replaced the per-feature
// centroid call here with the bbox-based `featuresBoundingCentre`
// below — but the shared module remains the source of truth so any
// future tweak (e.g. polygon area-weighting) lands in one place.
import { DEFAULT_REMEMBERED_ZOOM } from '@workspace/course-map-defaults';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';
import { Loader2, Save, Trash2, MapPin, Pencil, Check, X, ChevronLeft, Crosshair, Search, Trees, AlertTriangle } from 'lucide-react';

type FeatureType =
  | 'green'
  | 'fairway'
  | 'hazard_water'
  | 'hazard_bunker'
  | 'hazard_oob'
  | 'tee_box'
  | 'cart_path';

type GeomType = 'Polygon' | 'LineString' | 'Point';

type LngLat = [number, number];

interface PolygonGeom { type: 'Polygon'; coordinates: LngLat[][] }
interface LineStringGeom { type: 'LineString'; coordinates: LngLat[] }
interface PointGeom { type: 'Point'; coordinates: LngLat }
type GeoJsonGeom = PolygonGeom | LineStringGeom | PointGeom;

interface DraftFeature {
  id: string;             // local id (uuid-ish) or `srv_<n>` for loaded rows
  serverId?: number;      // server row id when loaded from API
  holeNumber: number;
  featureType: FeatureType;
  label: string | null;
  geometry: GeoJsonGeom;
}

interface ApiGeometryRow {
  id: number;
  holeNumber: number;
  featureType: FeatureType;
  label: string | null;
  geometry: GeoJsonGeom;
}
interface ApiGeometryResponse { courseId: number; features: ApiGeometryRow[] }

// Each tool entry pairs a course feature type with a specific geometry kind.
// The same feature type can appear multiple times (e.g. tee_box can be a
// polygon outline OR a single marker), giving admins explicit access to
// Polygon, LineString and Point creation.
interface ToolDef { value: string; featureType: FeatureType; geom: GeomType; label: string; color: string }
const TOOLS: ToolDef[] = [
  { value: 'green',          featureType: 'green',         geom: 'Polygon',    label: 'Green',                 color: '#22c55e' },
  { value: 'fairway',        featureType: 'fairway',       geom: 'Polygon',    label: 'Fairway',               color: '#84cc16' },
  { value: 'hazard_water',   featureType: 'hazard_water',  geom: 'Polygon',    label: 'Water hazard',          color: '#3b82f6' },
  { value: 'hazard_bunker',  featureType: 'hazard_bunker', geom: 'Polygon',    label: 'Bunker',                color: '#facc15' },
  { value: 'hazard_oob',     featureType: 'hazard_oob',    geom: 'LineString', label: 'OOB / red line',        color: '#ef4444' },
  { value: 'tee_box',        featureType: 'tee_box',       geom: 'Polygon',    label: 'Tee box (polygon)',     color: '#a855f7' },
  { value: 'tee_box_marker', featureType: 'tee_box',       geom: 'Point',      label: 'Tee box marker (pin)',  color: '#a855f7' },
  { value: 'cart_path',      featureType: 'cart_path',     geom: 'LineString', label: 'Cart path',             color: '#94a3b8' },
  { value: 'hazard_pin',     featureType: 'hazard_water',  geom: 'Point',      label: 'Hazard marker (pin)',   color: '#3b82f6' },
];

const FEATURE_COLOR: Record<FeatureType, string> = {
  green: '#22c55e',
  fairway: '#84cc16',
  hazard_water: '#3b82f6',
  hazard_bunker: '#facc15',
  hazard_oob: '#ef4444',
  tee_box: '#a855f7',
  cart_path: '#94a3b8',
};
const FEATURE_LABEL: Record<FeatureType, string> = {
  green: 'Green',
  fairway: 'Fairway',
  hazard_water: 'Water hazard',
  hazard_bunker: 'Bunker',
  hazard_oob: 'OOB',
  tee_box: 'Tee box',
  cart_path: 'Cart path',
};

function polyStyle(t: FeatureType, weight = 2): L.PathOptions {
  const c = FEATURE_COLOR[t];
  return { color: c, weight, fillColor: c, fillOpacity: 0.3 };
}
function lineStyle(t: FeatureType, weight = 3): L.PathOptions {
  return { color: FEATURE_COLOR[t], weight };
}

function uid(): string {
  return `tmp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// GeoJSON uses [lng, lat]; Leaflet uses [lat, lng]. Convert helpers.
const toLatLng = (c: LngLat): L.LatLng => L.latLng(c[1], c[0]);
const fromLatLng = (l: L.LatLng): LngLat => [l.lng, l.lat];

interface CourseRow {
  id: number;
  name: string;
  holes: number;
  location?: string | null;
  // Task #1312 — remembered mapper centre. Saved by this page so the
  // next admin to open the mapper for the course flies straight there
  // instead of starting at the [20, 0] world view.
  mapDefaultLat?: number | null;
  mapDefaultLng?: number | null;
  mapDefaultZoom?: number | null;
}

// Compute the centre of the bounding box that fits *every* saved
// feature so we can remember a sensible "open here next time" centre
// after the first save on a previously-blank course. Using the bbox
// of all features (rather than the centroid of `features[0]`) means
// that if the first thing an admin draws happens to be a tiny bunker
// on hole 12, we still remember the centre of the playable area
// instead of that one off-centre feature.
function featuresBoundingCentre(
  features: ReadonlyArray<{ geometry: GeoJsonGeom }>,
): LngLat | null {
  let minLng = Infinity, maxLng = -Infinity, minLat = Infinity, maxLat = -Infinity;
  let any = false;
  for (const f of features) {
    const g = f.geometry;
    const pts: LngLat[] =
      g.type === 'Point'
        ? [g.coordinates]
        : g.type === 'Polygon'
          // Drop the closing duplicate vertex so it isn't double-counted.
          ? (g.coordinates[0] ?? []).slice(0, -1)
          : g.coordinates;
    for (const [lng, lat] of pts) {
      if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      any = true;
    }
  }
  if (!any) return null;
  return [(minLng + maxLng) / 2, (minLat + maxLat) / 2];
}

export default function CourseMapperPage() {
  const params = useParams();
  const courseId = parseInt(params.id as string);
  const { data: user, isLoading: userLoading } = useGetMe();
  const { toast } = useToast();
  const orgId = user?.organizationId as number | undefined;

  const mapElRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  // Rendered layer per feature id (so we can remove on re-render).
  const layerByIdRef = useRef<Map<string, L.Layer>>(new Map());
  // Drag handles for the currently-selected, editable feature.
  const handlesRef = useRef<L.Marker[]>([]);
  // In-progress draft drawing layers.
  const previewShapeRef = useRef<L.Polygon | L.Polyline | null>(null);
  const previewVerticesRef = useRef<L.LayerGroup | null>(null);
  const draftPointsRef = useRef<L.LatLng[]>([]);

  const [course, setCourse] = useState<CourseRow | null>(null);
  const [features, setFeatures] = useState<DraftFeature[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [hole, setHole] = useState<number>(1);
  const [toolValue, setToolValue] = useState<string>(TOOLS[0].value);
  const [drawing, setDrawing] = useState(false);
  const [draftLabel, setDraftLabel] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingLabel, setEditingLabel] = useState<string>('');
  const [dirty, setDirty] = useState(false);
  // Hole number whose existing fairway should be replaced once the next
  // fairway draw is committed. Set by "Redraw" so cancelling doesn't
  // wipe the prior outline.
  const [pendingFairwayReplace, setPendingFairwayReplace] = useState<number | null>(null);

  // Place-search (Nominatim / OpenStreetMap) state.
  interface PlaceResult {
    place_id: number;
    display_name: string;
    lat: string;
    lon: string;
    boundingbox?: [string, string, string, string]; // [south, north, west, east]
  }
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<PlaceResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [showResults, setShowResults] = useState(false);

  const tool = useMemo(() => TOOLS.find((t) => t.value === toolValue) ?? TOOLS[0], [toolValue]);
  const isAdmin = user?.role === 'org_admin' || user?.role === 'super_admin';

  useEffect(() => {
    if (!orgId || Number.isNaN(courseId)) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const [cRes, gRes] = await Promise.all([
          fetch(`/api/organizations/${orgId}/courses/${courseId}`, { credentials: 'include' }),
          fetch(`/api/organizations/${orgId}/courses/${courseId}/geometry`, { credentials: 'include' }),
        ]);
        if (!cRes.ok) throw new Error(`Course ${cRes.status}`);
        if (!gRes.ok) throw new Error(`Geometry ${gRes.status}`);
        const c = (await cRes.json()) as {
          id: number;
          name: string;
          holes?: number;
          location?: string | null;
          mapDefaultLat?: number | string | null;
          mapDefaultLng?: number | string | null;
          mapDefaultZoom?: number | null;
        };
        const g = (await gRes.json()) as ApiGeometryResponse;
        if (cancelled) return;
        // numeric() columns come back as strings — coerce here so the
        // map effect can compare/use them as numbers without surprises.
        const lat = c.mapDefaultLat == null ? null : Number(c.mapDefaultLat);
        const lng = c.mapDefaultLng == null ? null : Number(c.mapDefaultLng);
        setCourse({
          id: c.id,
          name: c.name,
          holes: c.holes ?? 18,
          location: c.location ?? null,
          mapDefaultLat: Number.isFinite(lat as number) ? (lat as number) : null,
          mapDefaultLng: Number.isFinite(lng as number) ? (lng as number) : null,
          mapDefaultZoom: c.mapDefaultZoom ?? null,
        });
        setFeatures(g.features.map(rowToDraft));
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown error';
        toast({ title: 'Failed to load course', description: msg, variant: 'destructive' });
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [orgId, courseId, toast]);

  // The canvas <div> is only rendered once `loading` flips to false (the
  // early return shows a spinner before then). Re-run the init effect when
  // loading transitions so the ref is actually populated; the inner guard
  // prevents double-initialization.
  useEffect(() => {
    if (loading) return;
    if (!mapElRef.current || mapRef.current) return;
    // Task #1312 — fly straight to the remembered mapper centre when the
    // course has one, so the admin doesn't have to re-search every open.
    // Falls back to the [20, 0] world view (zoom 2) when no centre has
    // been saved yet for this course. `course` is set in the same async
    // load callback that flips `loading` → false so it is already
    // populated by the time this effect runs; the inner ref guard keeps
    // it a one-shot init regardless.
    const remembered =
      course
      && course.mapDefaultLat != null
      && course.mapDefaultLng != null
      && Number.isFinite(course.mapDefaultLat)
      && Number.isFinite(course.mapDefaultLng)
        ? {
            center: [course.mapDefaultLat, course.mapDefaultLng] as L.LatLngTuple,
            zoom: course.mapDefaultZoom ?? DEFAULT_REMEMBERED_ZOOM,
          }
        : null;
    const map = L.map(mapElRef.current, {
      center: remembered?.center ?? [20, 0],
      zoom: remembered?.zoom ?? 2,
      worldCopyJump: true,
      doubleClickZoom: false,
    });
    L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      {
        maxZoom: 22,
        attribution:
          'Tiles &copy; Esri — Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community',
      },
    ).addTo(map);
    mapRef.current = map;
    setTimeout(() => map.invalidateSize(), 50);
    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, [loading]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    layerByIdRef.current.forEach((layer) => map.removeLayer(layer));
    layerByIdRef.current.clear();

    const visible = features.filter((f) => f.holeNumber === hole);
    const bounds = L.latLngBounds([]);
    for (const f of visible) {
      const isSelected = selectedId === f.id;
      let layer: L.Layer | null = null;
      if (f.geometry.type === 'Polygon') {
        const ring = f.geometry.coordinates[0]?.map(toLatLng) ?? [];
        layer = L.polygon(ring, polyStyle(f.featureType, isSelected ? 4 : 2));
        ring.forEach((p) => bounds.extend(p));
      } else if (f.geometry.type === 'LineString') {
        const pts = f.geometry.coordinates.map(toLatLng);
        layer = L.polyline(pts, lineStyle(f.featureType, isSelected ? 5 : 3));
        pts.forEach((p) => bounds.extend(p));
      } else {
        const p = toLatLng(f.geometry.coordinates);
        layer = L.circleMarker(p, {
          color: FEATURE_COLOR[f.featureType],
          fillColor: FEATURE_COLOR[f.featureType],
          fillOpacity: 0.6,
          radius: isSelected ? 10 : 7,
          weight: isSelected ? 3 : 2,
        });
        bounds.extend(p);
      }
      if (!layer) continue;
      if (f.label) layer.bindTooltip(f.label, { direction: 'top', offset: [0, -4] });
      layer.on('click', (ev: L.LeafletMouseEvent) => {
        L.DomEvent.stopPropagation(ev);
        setSelectedId(f.id);
      });
      layer.addTo(map);
      layerByIdRef.current.set(f.id, layer);
    }
    if (visible.length > 0 && bounds.isValid()) {
      map.fitBounds(bounds.pad(0.15));
    }
  }, [features, hole, selectedId]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    handlesRef.current.forEach((h) => map.removeLayer(h));
    handlesRef.current = [];

    if (!isAdmin || !selectedId || drawing) return;
    const f = features.find((x) => x.id === selectedId);
    if (!f) return;

    const vertices: L.LatLng[] =
      f.geometry.type === 'Polygon'
        ? (f.geometry.coordinates[0] ?? []).slice(0, -1).map(toLatLng) // drop closing duplicate
        : f.geometry.type === 'LineString'
        ? f.geometry.coordinates.map(toLatLng)
        : [toLatLng(f.geometry.coordinates)];

    const handleIcon = L.divIcon({
      className: 'mapper-vertex-handle',
      html: `<div style="width:12px;height:12px;border-radius:9999px;background:#fff;border:2px solid ${FEATURE_COLOR[f.featureType]};box-shadow:0 0 0 1px rgba(0,0,0,0.5)"></div>`,
      iconSize: [12, 12],
      iconAnchor: [6, 6],
    });

    vertices.forEach((latlng, idx) => {
      const m = L.marker(latlng, { draggable: true, icon: handleIcon, zIndexOffset: 1000 });
      m.on('drag', (e: L.LeafletEvent) => {
        const newPos = (e.target as L.Marker).getLatLng();
        // Live update of the rendered shape without a state churn.
        const shape = layerByIdRef.current.get(f.id);
        if (!shape) return;
        if (f.geometry.type === 'Polygon') {
          const ring = f.geometry.coordinates[0].slice(0, -1).map(toLatLng);
          ring[idx] = newPos;
          (shape as L.Polygon).setLatLngs([ring]);
        } else if (f.geometry.type === 'LineString') {
          const pts = f.geometry.coordinates.map(toLatLng);
          pts[idx] = newPos;
          (shape as L.Polyline).setLatLngs(pts);
        } else {
          (shape as L.CircleMarker).setLatLng(newPos);
        }
      });
      m.on('dragend', (e: L.LeafletEvent) => {
        const newPos = (e.target as L.Marker).getLatLng();
        setFeatures((prev) =>
          prev.map((cur) => {
            if (cur.id !== f.id) return cur;
            if (cur.geometry.type === 'Polygon') {
              const ring = cur.geometry.coordinates[0].slice();
              // Update vertex; if first vertex, also keep closing duplicate in sync.
              ring[idx] = fromLatLng(newPos);
              if (idx === 0) ring[ring.length - 1] = fromLatLng(newPos);
              return { ...cur, geometry: { type: 'Polygon', coordinates: [ring] } };
            }
            if (cur.geometry.type === 'LineString') {
              const pts = cur.geometry.coordinates.slice();
              pts[idx] = fromLatLng(newPos);
              return { ...cur, geometry: { type: 'LineString', coordinates: pts } };
            }
            return { ...cur, geometry: { type: 'Point', coordinates: fromLatLng(newPos) } };
          }),
        );
        setDirty(true);
      });
      m.addTo(map);
      handlesRef.current.push(m);
    });

    return () => {
      handlesRef.current.forEach((h) => map.removeLayer(h));
      handlesRef.current = [];
    };
  }, [selectedId, features, drawing, isAdmin]);

  // Debounced lookup against Nominatim (OpenStreetMap). Free, requires
  // attribution and avoids burst traffic — we throttle to 1 req per 350ms.
  useEffect(() => {
    const q = searchQuery.trim();
    if (q.length < 3) {
      setSearchResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    const ctrl = new AbortController();
    const handle = setTimeout(async () => {
      try {
        const url = `https://nominatim.openstreetmap.org/search?format=json&addressdetails=0&limit=5&q=${encodeURIComponent(q)}`;
        const res = await fetch(url, {
          signal: ctrl.signal,
          headers: { Accept: 'application/json' },
        });
        if (!res.ok) throw new Error(`Search ${res.status}`);
        const json = (await res.json()) as PlaceResult[];
        setSearchResults(json);
        setShowResults(true);
      } catch (err) {
        if ((err as DOMException)?.name === 'AbortError') return;
        setSearchResults([]);
      } finally {
        setSearching(false);
      }
    }, 350);
    return () => {
      clearTimeout(handle);
      ctrl.abort();
    };
  }, [searchQuery]);

  // Persist the mapper centre on the course so the next open of this
  // course flies straight here (Task #1312). Best-effort: a failure
  // shouldn't block the admin's actual edit, so we surface a toast and
  // keep going.
  const persistMapCenter = useCallback(
    async (lat: number, lng: number, zoom: number | null) => {
      if (!orgId || !Number.isFinite(lat) || !Number.isFinite(lng)) return;
      try {
        const res = await fetch(`/api/organizations/${orgId}/courses/${courseId}/map-center`, {
          method: 'PUT',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ mapDefaultLat: lat, mapDefaultLng: lng, mapDefaultZoom: zoom }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        setCourse((prev) =>
          prev
            ? { ...prev, mapDefaultLat: lat, mapDefaultLng: lng, mapDefaultZoom: zoom }
            : prev,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown error';
        toast({
          title: "Couldn't remember this location",
          description: msg,
          variant: 'destructive',
        });
      }
    },
    [orgId, courseId, toast],
  );

  function flyToResult(r: PlaceResult) {
    const map = mapRef.current;
    if (!map) return;
    const lat = parseFloat(r.lat);
    const lon = parseFloat(r.lon);
    let centerLat = lat;
    let centerLng = lon;
    let centerZoom: number | null = null;
    if (r.boundingbox) {
      const [south, north, west, east] = r.boundingbox.map(parseFloat) as [number, number, number, number];
      const bounds = L.latLngBounds([south, west], [north, east]);
      map.fitBounds(bounds.pad(0.1), { maxZoom: 18 });
      // Use the bounding box centre rather than the raw point so we
      // remember roughly where the admin is looking, not just the OSM
      // pin which can sit at an entrance/clubhouse far from the course.
      centerLat = (south + north) / 2;
      centerLng = (west + east) / 2;
      centerZoom = map.getZoom();
    } else if (Number.isFinite(lat) && Number.isFinite(lon)) {
      map.setView([lat, lon], 17);
      centerZoom = 17;
    }
    setShowResults(false);
    if (isAdmin && Number.isFinite(centerLat) && Number.isFinite(centerLng)) {
      void persistMapCenter(centerLat, centerLng, centerZoom);
    }
  }

  const refreshPreview = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;
    if (previewShapeRef.current) { map.removeLayer(previewShapeRef.current); previewShapeRef.current = null; }
    if (previewVerticesRef.current) { map.removeLayer(previewVerticesRef.current); previewVerticesRef.current = null; }
    const pts = draftPointsRef.current;
    if (pts.length === 0) return;
    if (tool.geom === 'Polygon' && pts.length >= 2) {
      previewShapeRef.current = L.polygon(pts, { ...polyStyle(tool.featureType), dashArray: '4 4' }).addTo(map);
    } else if (tool.geom === 'LineString' && pts.length >= 2) {
      previewShapeRef.current = L.polyline(pts, { ...lineStyle(tool.featureType), dashArray: '4 4' }).addTo(map);
    }
    previewVerticesRef.current = L.layerGroup(
      pts.map((p) => L.circleMarker(p, { radius: 4, color: tool.color, fillColor: '#fff', fillOpacity: 1, weight: 2 })),
    ).addTo(map);
  }, [tool]);

  const finishDrawing = useCallback(
    (pts: L.LatLng[]) => {
      let geometry: GeoJsonGeom;
      if (tool.geom === 'Polygon') {
        const ring = pts.map(fromLatLng);
        const first = ring[0];
        const last = ring[ring.length - 1];
        if (first[0] !== last[0] || first[1] !== last[1]) ring.push([first[0], first[1]]);
        geometry = { type: 'Polygon', coordinates: [ring] };
      } else if (tool.geom === 'LineString') {
        geometry = { type: 'LineString', coordinates: pts.map(fromLatLng) };
      } else {
        geometry = { type: 'Point', coordinates: fromLatLng(pts[0]) };
      }
      const f: DraftFeature = {
        id: uid(),
        holeNumber: hole,
        featureType: tool.featureType,
        label: draftLabel.trim() || null,
        geometry,
      };
      setFeatures((prev) => {
        // If this draw is replacing an existing fairway for the hole
        // (Redraw flow), drop the old one now that we have a new outline.
        const filtered = pendingFairwayReplace !== null
            && tool.featureType === 'fairway'
            && pendingFairwayReplace === hole
          ? prev.filter((p) => !(p.holeNumber === hole && p.featureType === 'fairway'))
          : prev;
        return [...filtered, f];
      });
      setPendingFairwayReplace(null);
      setDirty(true);
      // Reset draft state.
      draftPointsRef.current = [];
      const map = mapRef.current;
      if (map) {
        if (previewShapeRef.current) { map.removeLayer(previewShapeRef.current); previewShapeRef.current = null; }
        if (previewVerticesRef.current) { map.removeLayer(previewVerticesRef.current); previewVerticesRef.current = null; }
      }
      setDrawing(false);
      setDraftLabel('');
      setSelectedId(f.id);
    },
    [tool, hole, draftLabel, pendingFairwayReplace],
  );

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const onClick = (e: L.LeafletMouseEvent) => {
      if (!drawing) return;
      if (tool.geom === 'Point') {
        finishDrawing([e.latlng]);
        return;
      }
      draftPointsRef.current = [...draftPointsRef.current, e.latlng];
      refreshPreview();
    };
    const onDblClick = (e: L.LeafletMouseEvent) => {
      if (!drawing) return;
      e.originalEvent.preventDefault();
      const pts = draftPointsRef.current;
      const min = tool.geom === 'Polygon' ? 3 : 2;
      if (pts.length >= min) finishDrawing(pts);
    };
    map.on('click', onClick);
    map.on('dblclick', onDblClick);
    return () => {
      map.off('click', onClick);
      map.off('dblclick', onDblClick);
    };
  }, [drawing, tool, refreshPreview, finishDrawing]);

  function startDrawing() {
    if (!isAdmin) return;
    draftPointsRef.current = [];
    refreshPreview();
    setDrawing(true);
    setSelectedId(null);
  }

  // Dedicated entry-point used by the per-hole "Draw fairway" quick action.
  // Switches the active tool to the fairway polygon, optionally clears any
  // existing fairway on the current hole (when the user picks "Replace"),
  // and immediately enters drawing mode so a non-technical greenkeeper can
  // start tracing without hunting through the feature dropdown. Wired to
  // Task #999's snap-to-fairway helper — saved polygons feed it directly.
  function startDrawFairway(replaceExisting: boolean) {
    if (!isAdmin) return;
    setToolValue('fairway');
    setDraftLabel('');
    // Defer the actual deletion of the existing fairway until the new
    // outline is committed — cancelling the draw should leave the prior
    // polygon intact rather than silently removing it.
    setPendingFairwayReplace(replaceExisting ? hole : null);
    draftPointsRef.current = [];
    refreshPreview();
    setSelectedId(null);
    setDrawing(true);
  }

  function deleteHoleFairway() {
    setFeatures((prev) => {
      const next = prev.filter(
        (f) => !(f.holeNumber === hole && f.featureType === 'fairway'),
      );
      if (next.length !== prev.length) setDirty(true);
      return next;
    });
  }

  function cancelDrawing() {
    draftPointsRef.current = [];
    const map = mapRef.current;
    if (map) {
      if (previewShapeRef.current) { map.removeLayer(previewShapeRef.current); previewShapeRef.current = null; }
      if (previewVerticesRef.current) { map.removeLayer(previewVerticesRef.current); previewVerticesRef.current = null; }
    }
    setDrawing(false);
    setDraftLabel('');
    setPendingFairwayReplace(null);
  }

  function deleteFeature(id: string) {
    setFeatures((prev) => prev.filter((f) => f.id !== id));
    setDirty(true);
    if (selectedId === id) setSelectedId(null);
  }

  function commitLabel(id: string, raw: string) {
    const next = raw.trim();
    setFeatures((prev) => prev.map((f) => (f.id === id ? { ...f, label: next === '' ? null : next } : f)));
    setDirty(true);
  }

  // Re-seed the controlled label editor whenever the selection changes so
  // that an existing label can be cleared by emptying the input.
  useEffect(() => {
    const f = selectedId ? features.find((x) => x.id === selectedId) : null;
    setEditingLabel(f?.label ?? '');
  }, [selectedId, features]);

  async function saveAll() {
    if (!orgId) return;
    setSaving(true);
    try {
      const payload = {
        replace: true,
        features: features.map((f) => ({
          holeNumber: f.holeNumber,
          featureType: f.featureType,
          geometry: f.geometry,
          label: f.label,
          source: 'in_house' as const,
        })),
      };
      const res = await fetch(`/api/organizations/${orgId}/courses/${courseId}/geometry`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `HTTP ${res.status}`);
      }
      const json = (await res.json()) as ApiGeometryResponse;
      const reloaded = json.features.map(rowToDraft);
      setFeatures(reloaded);
      setDirty(false);
      toast({ title: 'Course geometry saved', description: `${reloaded.length} feature${reloaded.length === 1 ? '' : 's'} stored.` });

      // Task #1312 — if the course doesn't yet have a remembered centre,
      // derive one so the next admin to open the mapper flies straight
      // there. Use the live map's current zoom so we preserve how far
      // the admin had zoomed in. Skipped entirely once a centre is
      // already stored — search-result clicks are the canonical way to
      // overwrite it after that. Use explicit `== null` checks so a
      // legitimate 0° lat/lng (e.g. a course on the equator or prime
      // meridian) isn't treated as "missing" and silently overwritten
      // on every save.
      // Task #1938 — derive the centre from the bounding box of *all*
      // saved features rather than the centroid of `features[0]`, so a
      // tiny first-drawn bunker on hole 12 doesn't anchor the
      // remembered centre to one corner of the course.
      const noStoredCentre =
        course?.mapDefaultLat == null || course?.mapDefaultLng == null;
      if (noStoredCentre && reloaded.length > 0) {
        const centre = featuresBoundingCentre(reloaded);
        const map = mapRef.current;
        if (centre) {
          const [lng, lat] = centre;
          void persistMapCenter(lat, lng, map ? map.getZoom() : DEFAULT_REMEMBERED_ZOOM);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      toast({ title: 'Save failed', description: msg, variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  }

  const visibleFeatures = useMemo(
    () => features.filter((f) => f.holeNumber === hole),
    [features, hole],
  );
  // Computed before the early returns below so hook order stays stable
  // across the loading → loaded transition (Rules of Hooks).
  const holesWithFairway = useMemo(() => {
    const set = new Set<number>();
    for (const f of features) if (f.featureType === 'fairway') set.add(f.holeNumber);
    return set;
  }, [features]);

  if (userLoading || loading) {
    return (
      <div className="flex items-center justify-center h-[60vh]">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <div className="max-w-xl mx-auto mt-16">
        <Card><CardContent className="p-6 text-center">
          <h2 className="text-xl font-semibold text-white mb-2">Course mapper restricted</h2>
          <p className="text-muted-foreground">Only organisation admins can edit course geometry.</p>
          <Link href="/courses"><Button className="mt-4" variant="outline"><ChevronLeft className="w-4 h-4 mr-2" /> Back to courses</Button></Link>
        </CardContent></Card>
      </div>
    );
  }

  if (!course) {
    return (
      <div className="max-w-xl mx-auto mt-16">
        <Card><CardContent className="p-6 text-center">
          <p className="text-muted-foreground">Course not found.</p>
          <Link href="/courses"><Button className="mt-4" variant="outline"><ChevronLeft className="w-4 h-4 mr-2" /> Back to courses</Button></Link>
        </CardContent></Card>
      </div>
    );
  }

  const selected = selectedId ? features.find((f) => f.id === selectedId) ?? null : null;
  const holeOptions = Array.from({ length: course.holes }, (_, i) => i + 1);
  const holeFairway = features.find(
    (f) => f.holeNumber === hole && f.featureType === 'fairway',
  );

  return (
    <div className="space-y-4 max-w-[1600px] mx-auto" data-testid="course-mapper">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <Link href="/courses"><Button variant="ghost" size="sm" className="mb-1 -ml-3"><ChevronLeft className="w-4 h-4 mr-1" /> Courses</Button></Link>
          <h1 className="text-2xl font-display font-bold text-white tracking-tight">{course.name} — Mapper</h1>
          <p className="text-muted-foreground text-sm">Draw greens, hazards and cart paths on the satellite view. Saved features power the mobile hole map.</p>
        </div>
        <div className="flex items-center gap-2">
          {dirty && <Badge variant="outline" className="border-amber-400 text-amber-400">Unsaved changes</Badge>}
          <Button onClick={saveAll} disabled={saving || !dirty} data-testid="button-save-geometry">
            {saving ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Save className="w-4 h-4 mr-2" />}
            Save all
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-4">
        {/* Left panel */}
        <div className="space-y-3">
          <Card><CardContent className="p-4 space-y-3">
            <div>
              <Label className="text-xs uppercase tracking-wide text-muted-foreground">Hole</Label>
              <Select value={String(hole)} onValueChange={(v) => { setHole(parseInt(v)); setSelectedId(null); cancelDrawing(); }}>
                <SelectTrigger data-testid="select-hole" className="bg-black/40"><SelectValue /></SelectTrigger>
                <SelectContent className="max-h-72">
                  {holeOptions.map((n) => (
                    <SelectItem key={n} value={String(n)}>
                      Hole {n}{holesWithFairway.has(n) ? ' • fairway ✓' : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {/*
                Task #1174 — quick "Report an error" deep link for the
                currently-selected hole. Greenkeepers and admins working in the
                mapper often spot wrong par/yardage/SI on a specific hole;
                surfacing the correction form here saves them from having to
                find the right course id and hole number in the portal.
                Task #1351 — the mapper only loads geometry (greens, hazards,
                cart paths) for the hole; per-hole par/yardage/SI are not in
                scope here, so we deliberately omit `currentValue` rather than
                guess. The portal form leaves the field blank in that case
                (same as before #1351), and the user can fill it in by hand.
              */}
              <a
                href={`/portal/course-corrections?courseId=${course.id}&hole=${hole}&field=par`}
                data-testid="link-report-hole"
                className="mt-1 inline-flex items-center gap-1 text-[11px] text-amber-300/80 hover:text-amber-200"
              >
                <AlertTriangle className="w-3 h-3" /> Report an error on hole {hole}
              </a>
            </div>

            {/*
              Per-hole "Draw fairway" quick action (Task #1157). The generic
              feature picker below can also draw a fairway, but greenkeepers
              kept missing it in the dropdown — the snap-to-fairway helper
              from Task #999 only kicks in once a polygon is saved here, so
              we surface a dedicated button + status line per hole.
            */}
            <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3 space-y-2" data-testid="fairway-quick-action">
              <div className="flex items-center gap-2">
                <Trees className="w-4 h-4 text-emerald-400" />
                <span className="text-sm font-medium text-white">Fairway for hole {hole}</span>
                {holeFairway ? (
                  <Badge variant="outline" className="ml-auto border-emerald-400 text-emerald-300" data-testid="fairway-status-present">
                    Mapped
                  </Badge>
                ) : (
                  <Badge variant="outline" className="ml-auto border-white/20 text-muted-foreground" data-testid="fairway-status-missing">
                    Not drawn
                  </Badge>
                )}
              </div>
              <p className="text-[11px] text-muted-foreground">
                Trace the playable fairway outline so the mobile app can snap shots onto it.
              </p>
              {holeFairway ? (
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    className="flex-1"
                    onClick={() => { setSelectedId(holeFairway.id); cancelDrawing(); }}
                    data-testid="button-edit-fairway"
                  >
                    <Pencil className="w-3.5 h-3.5 mr-1" /> Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => startDrawFairway(true)}
                    data-testid="button-redraw-fairway"
                  >
                    Redraw
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={deleteHoleFairway}
                    data-testid="button-delete-fairway"
                    aria-label="Delete fairway"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                </div>
              ) : (
                <Button
                  size="sm"
                  className="w-full bg-emerald-500 hover:bg-emerald-600 text-black"
                  onClick={() => startDrawFairway(false)}
                  data-testid="button-draw-fairway"
                >
                  <Pencil className="w-3.5 h-3.5 mr-1" /> Draw fairway
                </Button>
              )}
            </div>

            <div>
              <Label className="text-xs uppercase tracking-wide text-muted-foreground">Feature</Label>
              <Select value={toolValue} onValueChange={(v) => { setToolValue(v); cancelDrawing(); }}>
                <SelectTrigger data-testid="select-feature-type" className="bg-black/40"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {TOOLS.map((t) => (
                    <SelectItem key={t.value} value={t.value}>
                      <span className="inline-flex items-center gap-2">
                        <span className="w-3 h-3 rounded-sm" style={{ background: t.color }} />
                        {t.label} <span className="text-muted-foreground text-xs">({t.geom})</span>
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div>
              <Label className="text-xs uppercase tracking-wide text-muted-foreground">Label (optional)</Label>
              <Input
                placeholder='e.g. "Front bunker"'
                value={draftLabel}
                onChange={(e) => setDraftLabel(e.target.value)}
                data-testid="input-draft-label"
                className="bg-black/40"
              />
            </div>

            {!drawing ? (
              <Button onClick={startDrawing} className="w-full" data-testid="button-start-draw">
                <Pencil className="w-4 h-4 mr-2" /> Draw {tool.label.toLowerCase()}
              </Button>
            ) : (
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground">
                  {tool.geom === 'Point'
                    ? 'Click on the map to place the point.'
                    : `Click to add vertices. Double-click to finish (need at least ${tool.geom === 'Polygon' ? 3 : 2}).`}
                </p>
                <div className="flex gap-2">
                  <Button
                    onClick={() => {
                      const pts = draftPointsRef.current;
                      const min = tool.geom === 'Polygon' ? 3 : tool.geom === 'LineString' ? 2 : 1;
                      if (pts.length >= min) finishDrawing(pts);
                    }}
                    className="flex-1"
                    data-testid="button-finish-draw"
                  >
                    <Check className="w-4 h-4 mr-2" /> Finish
                  </Button>
                  <Button onClick={cancelDrawing} variant="outline" data-testid="button-cancel-draw">
                    <X className="w-4 h-4" />
                  </Button>
                </div>
              </div>
            )}
          </CardContent></Card>

          <Card><CardContent className="p-4 space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-xs uppercase tracking-wide text-muted-foreground">Features on hole {hole}</Label>
              <Badge variant="secondary">{visibleFeatures.length}</Badge>
            </div>
            {visibleFeatures.length === 0 ? (
              <p className="text-xs text-muted-foreground py-2">Nothing drawn yet for this hole.</p>
            ) : (
              <ul className="space-y-1 max-h-[320px] overflow-auto pr-1">
                {visibleFeatures.map((f) => {
                  const isSel = selectedId === f.id;
                  return (
                    <li
                      key={f.id}
                      onClick={() => setSelectedId(f.id)}
                      className={`flex items-center gap-2 rounded px-2 py-1 cursor-pointer text-sm ${isSel ? 'bg-white/10' : 'hover:bg-white/5'}`}
                      data-testid={`feature-row-${f.id}`}
                    >
                      <span className="w-3 h-3 rounded-sm shrink-0" style={{ background: FEATURE_COLOR[f.featureType] }} />
                      <span className="flex-1 truncate text-white">
                        {f.label || `${FEATURE_LABEL[f.featureType]} (${f.geometry.type})`}
                      </span>
                      <button
                        onClick={(e) => { e.stopPropagation(); deleteFeature(f.id); }}
                        className="text-muted-foreground hover:text-red-400"
                        data-testid={`button-delete-${f.id}`}
                        aria-label="Delete feature"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent></Card>

          {selected && (
            <Card><CardContent className="p-4 space-y-3">
              <Label className="text-xs uppercase tracking-wide text-muted-foreground">Selected feature</Label>
              <div className="text-sm text-white">
                {FEATURE_LABEL[selected.featureType]} <span className="text-muted-foreground">({selected.geometry.type})</span>
              </div>
              <div className="flex items-end gap-2">
                <div className="flex-1">
                  <Label className="text-xs">Label</Label>
                  <Input
                    value={editingLabel}
                    onChange={(e) => setEditingLabel(e.target.value)}
                    placeholder="Leave blank to remove the label"
                    className="bg-black/40"
                    data-testid="input-edit-label"
                  />
                </div>
                <Button
                  size="sm"
                  onClick={() => commitLabel(selected.id, editingLabel)}
                  data-testid="button-save-label"
                >
                  <Check className="w-4 h-4" />
                </Button>
              </div>
              <p className="text-[11px] text-muted-foreground">
                Drag the white handles on the map to reshape this feature.
              </p>
              <Button
                variant="destructive"
                size="sm"
                className="w-full"
                onClick={() => deleteFeature(selected.id)}
                data-testid="button-delete-selected"
              >
                <Trash2 className="w-4 h-4 mr-2" /> Delete feature
              </Button>
            </CardContent></Card>
          )}

          <Card><CardContent className="p-4 space-y-2 text-xs text-muted-foreground">
            <div className="flex items-center gap-2 text-white text-sm font-medium">
              <Crosshair className="w-4 h-4" /> Tip
            </div>
            <p>Use the search box on the map to jump straight to your course by address or name, then pan and zoom to fine-tune.</p>
            <p>Saved features replace the entire course geometry — make sure all holes are still represented before saving.</p>
          </CardContent></Card>
        </div>

        {/* Map */}
        <div className="relative rounded-2xl overflow-hidden border border-white/10 bg-black/40" style={{ minHeight: 600, height: 'calc(100vh - 220px)' }}>
          <div ref={mapElRef} className="absolute inset-0" data-testid="mapper-canvas" />
          <div className="absolute top-3 left-3 z-[400] w-[min(360px,calc(100%-1.5rem))]">
            <div className="relative">
              <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
              <Input
                value={searchQuery}
                onChange={(e) => { setSearchQuery(e.target.value); setShowResults(true); }}
                onFocus={() => { if (searchResults.length > 0) setShowResults(true); }}
                placeholder="Search course or address (e.g. Augusta National)"
                className="pl-9 pr-9 bg-black/80 backdrop-blur border-white/10 text-white placeholder:text-muted-foreground"
                data-testid="input-place-search"
                aria-label="Search for a place"
              />
              {searching && (
                <Loader2 className="w-4 h-4 absolute right-9 top-1/2 -translate-y-1/2 animate-spin text-muted-foreground" />
              )}
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => { setSearchQuery(''); setSearchResults([]); setShowResults(false); }}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-muted-foreground hover:text-white"
                  aria-label="Clear search"
                  data-testid="button-clear-search"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
              {showResults && searchQuery.trim().length >= 3 && (
                <div className="absolute left-0 right-0 mt-1 rounded-md border border-white/10 bg-black/90 backdrop-blur shadow-xl overflow-hidden">
                  {searchResults.length === 0 && !searching ? (
                    <div className="px-3 py-2 text-xs text-muted-foreground">No matches found.</div>
                  ) : (
                    <ul className="max-h-72 overflow-auto" data-testid="place-search-results">
                      {searchResults.map((r) => (
                        <li key={r.place_id}>
                          <button
                            type="button"
                            onClick={() => flyToResult(r)}
                            className="w-full text-left px-3 py-2 text-xs text-white hover:bg-white/10 flex items-start gap-2"
                            data-testid={`place-result-${r.place_id}`}
                          >
                            <MapPin className="w-3.5 h-3.5 mt-0.5 shrink-0 text-muted-foreground" />
                            <span className="line-clamp-2">{r.display_name}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="px-3 py-1.5 text-[10px] text-muted-foreground border-t border-white/5 bg-black/60">
                    Search by{' '}
                    <a
                      href="https://nominatim.openstreetmap.org/"
                      target="_blank"
                      rel="noreferrer"
                      className="underline hover:text-white"
                    >
                      Nominatim
                    </a>{' '}
                    · © OpenStreetMap contributors
                  </div>
                </div>
              )}
            </div>
          </div>
          {drawing && (
            <div className="absolute top-3 left-1/2 -translate-x-1/2 bg-black/80 backdrop-blur px-3 py-1.5 rounded-full text-xs text-white border border-white/10 shadow-lg flex items-center gap-2 z-[400]">
              <MapPin className="w-3.5 h-3.5" />
              Drawing {tool.label.toLowerCase()} on hole {hole}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function rowToDraft(row: ApiGeometryRow): DraftFeature {
  return {
    id: `srv_${row.id}`,
    serverId: row.id,
    holeNumber: row.holeNumber,
    featureType: row.featureType,
    label: row.label ?? null,
    geometry: row.geometry,
  };
}
