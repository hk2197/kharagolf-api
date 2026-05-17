import { useState, useEffect, useMemo, useCallback } from 'react';
import JSZip from 'jszip';
import { Mountain, Upload, Loader2, Trash2, FileJson, FileSpreadsheet, AlertCircle, CheckCircle, Layers, XCircle, Download } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { useToast } from '@/hooks/use-toast';

interface CourseRow { id: number; name: string; holes: number }

interface ContourRow {
  courseId: number;
  holeNumber: number;
  originLat: string;
  originLng: string;
  rows: number;
  cols: number;
  cellMeters: string;
  elevations: number[];
  source?: string | null;
  updatedAt?: string | null;
}

interface ParsedGrid {
  rows: number;
  cols: number;
  elevations: number[];
}

interface BulkHolePayload {
  originLat: number;
  originLng: number;
  rows: number;
  cols: number;
  cellMeters: number;
  elevations: number[];
  source?: string | null;
}

interface BulkResult {
  holeNumber: number;
  ok: boolean;
  error?: string;
  rows?: number;
  cols?: number;
}

export const MIN_DIM = 3;
export const MAX_DIM = 64;
export const MAX_ABS_ELEV = 50;

export function parseCsv(text: string): { ok: true; data: ParsedGrid } | { ok: false; error: string } {
  const lines = text
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l.length > 0 && !l.startsWith('#'));
  if (lines.length === 0) return { ok: false, error: 'CSV is empty.' };

  const matrix: number[][] = [];
  for (let i = 0; i < lines.length; i++) {
    const cells = lines[i].split(/[,;\t]+/).map(c => c.trim()).filter(c => c.length > 0);
    if (cells.length === 0) continue;
    const row: number[] = [];
    for (const cell of cells) {
      const n = Number(cell);
      if (!Number.isFinite(n)) {
        return { ok: false, error: `Row ${i + 1}: "${cell}" is not a number.` };
      }
      row.push(n);
    }
    matrix.push(row);
  }
  if (matrix.length === 0) return { ok: false, error: 'No data rows found.' };
  const cols = matrix[0].length;
  for (let i = 1; i < matrix.length; i++) {
    if (matrix[i].length !== cols) {
      return { ok: false, error: `Row ${i + 1} has ${matrix[i].length} columns, expected ${cols}.` };
    }
  }
  return { ok: true, data: { rows: matrix.length, cols, elevations: matrix.flat() } };
}

export function parseJson(text: string): { ok: true; data: ParsedGrid } | { ok: false; error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `Invalid JSON: ${(e as Error).message}` };
  }
  // Accept either { rows, cols, elevations[] } OR raw 2D array
  if (Array.isArray(raw) && raw.length > 0 && Array.isArray(raw[0])) {
    const matrix = raw as unknown[][];
    const cols = matrix[0].length;
    const elev: number[] = [];
    for (let i = 0; i < matrix.length; i++) {
      if (!Array.isArray(matrix[i]) || matrix[i].length !== cols) {
        return { ok: false, error: `Row ${i + 1} length mismatch.` };
      }
      for (const v of matrix[i]) {
        const n = Number(v);
        if (!Number.isFinite(n)) return { ok: false, error: `Non-numeric value at row ${i + 1}.` };
        elev.push(n);
      }
    }
    return { ok: true, data: { rows: matrix.length, cols, elevations: elev } };
  }
  if (raw && typeof raw === 'object' && 'rows' in raw && 'cols' in raw && 'elevations' in raw) {
    const r = raw as { rows: unknown; cols: unknown; elevations: unknown };
    const rows = Number(r.rows);
    const cols = Number(r.cols);
    if (!Number.isInteger(rows) || !Number.isInteger(cols)) return { ok: false, error: 'rows/cols must be integers.' };
    if (!Array.isArray(r.elevations)) return { ok: false, error: 'elevations must be an array.' };
    const elev: number[] = [];
    for (const v of r.elevations) {
      const n = Number(v);
      if (!Number.isFinite(n)) return { ok: false, error: 'Non-numeric elevation value.' };
      elev.push(n);
    }
    if (elev.length !== rows * cols) {
      return { ok: false, error: `elevations length (${elev.length}) must equal rows × cols (${rows * cols}).` };
    }
    return { ok: true, data: { rows, cols, elevations: elev } };
  }
  return { ok: false, error: 'Unrecognised JSON shape. Expected 2D array or { rows, cols, elevations }.' };
}

function normaliseBulkHole(raw: unknown, label: string): { ok: true; data: BulkHolePayload } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, error: `${label}: not an object.` };
  const r = raw as Record<string, unknown>;

  let rows = Number(r.rows);
  let cols = Number(r.cols);
  let elevations: number[] | null = null;

  if (Array.isArray(r.elevations) && Array.isArray((r.elevations as unknown[])[0])) {
    const matrix = r.elevations as unknown[][];
    cols = matrix[0].length;
    rows = matrix.length;
    const flat: number[] = [];
    for (let i = 0; i < matrix.length; i++) {
      if (!Array.isArray(matrix[i]) || matrix[i].length !== cols) {
        return { ok: false, error: `${label}: row ${i + 1} length mismatch.` };
      }
      for (const v of matrix[i]) {
        const n = Number(v);
        if (!Number.isFinite(n)) return { ok: false, error: `${label}: non-numeric value at row ${i + 1}.` };
        flat.push(n);
      }
    }
    elevations = flat;
  } else if (Array.isArray(r.elevations)) {
    elevations = (r.elevations as unknown[]).map(v => Number(v));
    if (elevations.some(v => !Number.isFinite(v))) return { ok: false, error: `${label}: non-numeric elevation value.` };
  } else if (Array.isArray(r.grid) && Array.isArray((r.grid as unknown[])[0])) {
    return normaliseBulkHole({ ...r, elevations: r.grid }, label);
  } else {
    return { ok: false, error: `${label}: missing elevations[] or 2D grid.` };
  }

  if (!Number.isInteger(rows) || !Number.isInteger(cols) || rows <= 0 || cols <= 0) {
    return { ok: false, error: `${label}: rows/cols must be positive integers.` };
  }
  if (elevations.length !== rows * cols) {
    return { ok: false, error: `${label}: elevations length (${elevations.length}) ≠ rows × cols (${rows * cols}).` };
  }
  const grid: ParsedGrid = { rows, cols, elevations };
  const v = validateGrid(grid);
  if (v) return { ok: false, error: `${label}: ${v}` };

  const originLat = Number(r.originLat);
  const originLng = Number(r.originLng);
  if (!Number.isFinite(originLat) || originLat < -90 || originLat > 90) {
    return { ok: false, error: `${label}: originLat must be between -90 and 90.` };
  }
  if (!Number.isFinite(originLng) || originLng < -180 || originLng > 180) {
    return { ok: false, error: `${label}: originLng must be between -180 and 180.` };
  }
  const cellMeters = r.cellMeters != null ? Number(r.cellMeters) : 1.5;
  if (!Number.isFinite(cellMeters) || cellMeters <= 0 || cellMeters > 10) {
    return { ok: false, error: `${label}: cellMeters must be > 0 and ≤ 10.` };
  }
  const source = typeof r.source === 'string' ? r.source : null;

  return { ok: true, data: { originLat, originLng, rows, cols, cellMeters, elevations, source } };
}

function parseBulkJson(text: string): { ok: true; holes: Record<string, BulkHolePayload> } | { ok: false; error: string } {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch (e) {
    return { ok: false, error: `Invalid JSON: ${(e as Error).message}` };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'Top-level JSON must be an object keyed by hole number.' };
  }
  const obj = raw as Record<string, unknown>;
  // Allow { holes: { ... } } wrapper.
  const map: Record<string, unknown> =
    obj.holes && typeof obj.holes === 'object' && !Array.isArray(obj.holes)
      ? obj.holes as Record<string, unknown>
      : Object.fromEntries(Object.entries(obj).filter(([k]) => /^\d+$/.test(k)));

  const entries = Object.entries(map);
  if (entries.length === 0) {
    return { ok: false, error: 'No hole entries found. Expected numeric keys like "1", "2", ...' };
  }
  const out: Record<string, BulkHolePayload> = {};
  for (const [k, v] of entries) {
    if (!/^\d+$/.test(k)) return { ok: false, error: `Invalid hole key "${k}" (must be a number).` };
    const r = normaliseBulkHole(v, `Hole ${k}`);
    if (!r.ok) return { ok: false, error: r.error };
    out[k] = r.data;
  }
  return { ok: true, holes: out };
}

export function validateGrid(g: ParsedGrid): string | null {
  if (g.rows < MIN_DIM || g.cols < MIN_DIM) {
    return `Grid is too small (minimum ${MIN_DIM}×${MIN_DIM}).`;
  }
  if (g.rows > MAX_DIM || g.cols > MAX_DIM) {
    return `Grid is too large (maximum ${MAX_DIM}×${MAX_DIM}).`;
  }
  for (const v of g.elevations) {
    if (Math.abs(v) > MAX_ABS_ELEV) {
      return `Elevation ${v} is outside ±${MAX_ABS_ELEV} m. Use values relative to the green centre.`;
    }
  }
  return null;
}

function colourFor(value: number, min: number, max: number): string {
  if (max === min) return 'rgb(120,120,120)';
  const t = (value - min) / (max - min); // 0..1
  // Blue (low) -> green (mid) -> red (high)
  const r = Math.round(255 * Math.max(0, t - 0.5) * 2);
  const b = Math.round(255 * Math.max(0, 0.5 - t) * 2);
  const g = Math.round(255 * (1 - Math.abs(t - 0.5) * 2));
  return `rgb(${r},${g},${b})`;
}

export function GreenContourDialog({
  open,
  onClose,
  orgId,
  course,
}: {
  open: boolean;
  onClose: () => void;
  orgId: number;
  course: CourseRow | null;
}) {
  const { toast } = useToast();
  const [holeNumber, setHoleNumber] = useState<number>(1);
  const [tab, setTab] = useState<'csv' | 'json' | 'file' | 'bulk'>('csv');
  const [text, setText] = useState('');
  const [originLat, setOriginLat] = useState('');
  const [originLng, setOriginLng] = useState('');
  const [cellMeters, setCellMeters] = useState('1.5');
  const [source, setSource] = useState('manual');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [existing, setExisting] = useState<ContourRow | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [bulkHoles, setBulkHoles] = useState<Record<string, BulkHolePayload> | null>(null);
  const [bulkFileName, setBulkFileName] = useState<string | null>(null);
  const [bulkParseError, setBulkParseError] = useState<string | null>(null);
  const [bulkResults, setBulkResults] = useState<BulkResult[] | null>(null);
  const [bulkUploading, setBulkUploading] = useState(false);
  const [downloadingTemplate, setDownloadingTemplate] = useState(false);

  const courseId = course?.id;
  const totalHoles = course?.holes ?? 18;

  const TEMPLATE_DIM = 8;
  const TEMPLATE_CELL_METERS = 1.5;

  // Reset on close
  useEffect(() => {
    if (!open) {
      setHoleNumber(1); setText(''); setOriginLat(''); setOriginLng('');
      setCellMeters('1.5'); setSource('manual'); setExisting(null); setFileName(null);
      setTab('csv');
      setBulkHoles(null); setBulkFileName(null); setBulkParseError(null); setBulkResults(null);
    }
  }, [open]);

  // Load existing contour for selected hole
  useEffect(() => {
    if (!open || !courseId) return;
    setLoading(true);
    setExisting(null);
    fetch(`/api/organizations/${orgId}/courses/${courseId}/holes/${holeNumber}/contour`, { credentials: 'include' })
      .then(async r => {
        if (r.status === 404) return null;
        if (!r.ok) throw new Error('Failed to load existing contour');
        return r.json() as Promise<ContourRow>;
      })
      .then(c => {
        if (c) {
          setExisting(c);
          setOriginLat(String(c.originLat));
          setOriginLng(String(c.originLng));
          setCellMeters(String(c.cellMeters));
          setSource(c.source ?? 'manual');
        } else {
          setOriginLat(''); setOriginLng(''); setCellMeters('1.5'); setSource('manual');
        }
      })
      .catch((e: Error) => {
        toast({ title: e.message || 'Could not load existing contour for this hole.', variant: 'destructive' });
      })
      .finally(() => setLoading(false));
  }, [open, orgId, courseId, holeNumber]);

  const parsed = useMemo(() => {
    if (tab === 'bulk') return null;
    if (!text.trim()) return null;
    return tab === 'json' ? parseJson(text) : parseCsv(text);
  }, [text, tab]);

  const previewGrid: ParsedGrid | null = useMemo(() => {
    if (parsed && parsed.ok) return parsed.data;
    if (existing) return { rows: existing.rows, cols: existing.cols, elevations: existing.elevations };
    return null;
  }, [parsed, existing]);

  const validationError = useMemo(() => {
    if (parsed && !parsed.ok) return parsed.error;
    if (parsed && parsed.ok) return validateGrid(parsed.data);
    return null;
  }, [parsed]);

  const elevStats = useMemo(() => {
    if (!previewGrid) return null;
    let min = Infinity, max = -Infinity, sum = 0;
    for (const v of previewGrid.elevations) {
      if (v < min) min = v; if (v > max) max = v; sum += v;
    }
    return { min, max, mean: sum / previewGrid.elevations.length };
  }, [previewGrid]);

  const onPickBulkFile = useCallback(async (file: File) => {
    setBulkFileName(file.name);
    setBulkParseError(null);
    setBulkResults(null);
    setBulkHoles(null);
    const lower = file.name.toLowerCase();
    try {
      if (lower.endsWith('.zip')) {
        const zip = await JSZip.loadAsync(file);
        const map: Record<string, unknown> = {};
        const fileNames = Object.keys(zip.files).filter(n => !zip.files[n].dir);
        for (const name of fileNames) {
          const base = name.split('/').pop() ?? name;
          const m = base.match(/(\d+)/);
          if (!m) continue;
          const holeKey = String(parseInt(m[1]));
          const lowerName = base.toLowerCase();
          const txt = await zip.files[name].async('text');
          if (lowerName.endsWith('.json')) {
            try { map[holeKey] = JSON.parse(txt); }
            catch (e) { setBulkParseError(`${base}: invalid JSON — ${(e as Error).message}`); return; }
          } else if (lowerName.endsWith('.csv') || lowerName.endsWith('.txt')) {
            const parsed = parseCsv(txt);
            if (!parsed.ok) { setBulkParseError(`${base}: ${parsed.error}`); return; }
            // CSV files alone don't carry origin/cell metadata — flag clearly.
            setBulkParseError(`${base}: CSV files in bulk ZIP must include a sibling .json with origin/cell metadata. Use the JSON-per-hole format instead.`);
            return;
          }
        }
        if (Object.keys(map).length === 0) {
          setBulkParseError('ZIP contained no recognised hole files (need names like "1.json", "hole-2.json").');
          return;
        }
        const result = parseBulkJson(JSON.stringify(map));
        if (!result.ok) { setBulkParseError(result.error); return; }
        setBulkHoles(result.holes);
      } else {
        const text = await file.text();
        const result = parseBulkJson(text);
        if (!result.ok) { setBulkParseError(result.error); return; }
        setBulkHoles(result.holes);
      }
    } catch (e) {
      setBulkParseError((e as Error).message || 'Failed to read file.');
    }
  }, []);

  const handleDownloadTemplate = async () => {
    if (!courseId || !course) return;
    setDownloadingTemplate(true);
    try {
      let centreLat: number | null = null;
      let centreLng: number | null = null;
      try {
        const res = await fetch(`/api/organizations/${orgId}/courses/${courseId}`, { credentials: 'include' });
        if (res.ok) {
          const detail = await res.json() as { latitude?: string | number | null; longitude?: string | number | null };
          const lat = detail.latitude == null ? NaN : Number(detail.latitude);
          const lng = detail.longitude == null ? NaN : Number(detail.longitude);
          if (Number.isFinite(lat) && lat >= -90 && lat <= 90) centreLat = lat;
          if (Number.isFinite(lng) && lng >= -180 && lng <= 180) centreLng = lng;
        }
      } catch {
        // Non-fatal; we'll fall back to placeholder coordinates.
      }

      const cellCount = TEMPLATE_DIM * TEMPLATE_DIM;
      const zeros: number[] = new Array(cellCount).fill(0);
      const template: Record<string, BulkHolePayload> = {};
      for (let n = 1; n <= totalHoles; n++) {
        template[String(n)] = {
          originLat: centreLat ?? 0,
          originLng: centreLng ?? 0,
          rows: TEMPLATE_DIM,
          cols: TEMPLATE_DIM,
          cellMeters: TEMPLATE_CELL_METERS,
          elevations: [...zeros],
          source: 'manual',
        };
      }

      const slug = course.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || `course-${courseId}`;
      const json = JSON.stringify(template, null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${slug}-green-contours-template.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      const fullyPrefilled = centreLat != null && centreLng != null;
      toast({
        title: `Template ready for ${totalHoles} hole${totalHoles === 1 ? '' : 's'}`,
        description: fullyPrefilled
          ? 'Origin coordinates pre-filled from the course location. Replace the zero elevations with your survey data.'
          : 'Course has no saved location — replace the placeholder originLat/originLng for each hole.',
      });
    } catch (e) {
      toast({ title: (e as Error).message || 'Could not generate template.', variant: 'destructive' });
    } finally {
      setDownloadingTemplate(false);
    }
  };

  const handleBulkUpload = async () => {
    if (!courseId || !bulkHoles) return;
    setBulkUploading(true);
    setBulkResults(null);
    try {
      const res = await fetch(`/api/organizations/${orgId}/courses/${courseId}/contour/bulk`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ holes: bulkHoles }),
      });
      const data = await res.json().catch(() => ({})) as { results?: BulkResult[]; summary?: { saved: number; failed: number; total: number }; error?: string };
      if (!res.ok && !data.results) {
        throw new Error(data.error ?? `Bulk upload failed (HTTP ${res.status})`);
      }
      setBulkResults(data.results ?? []);
      const saved = data.summary?.saved ?? 0;
      const failed = data.summary?.failed ?? 0;
      toast({
        title: failed === 0 ? `Saved ${saved} hole grid${saved === 1 ? '' : 's'}` : `Saved ${saved}, failed ${failed}`,
        variant: failed === 0 ? 'default' : 'destructive',
      });
      if (saved > 0 && existing == null) {
        // Refresh existing for currently-selected hole if it was in the bulk set.
        const me = data.results?.find(r => r.holeNumber === holeNumber && r.ok);
        if (me) {
          fetch(`/api/organizations/${orgId}/courses/${courseId}/holes/${holeNumber}/contour`, { credentials: 'include' })
            .then(r => r.ok ? r.json() : null)
            .then(c => { if (c) setExisting(c as ContourRow); });
        }
      }
    } catch (e) {
      toast({ title: (e as Error).message, variant: 'destructive' });
    } finally {
      setBulkUploading(false);
    }
  };

  const onPickFile = useCallback((file: File) => {
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = () => {
      const txt = String(reader.result ?? '');
      setText(txt);
      const lower = file.name.toLowerCase();
      if (lower.endsWith('.json')) setTab('json');
      else setTab('csv');
    };
    reader.readAsText(file);
  }, []);

  const handleSave = async () => {
    if (!courseId) return;
    if (!parsed || !parsed.ok) {
      toast({ title: 'Provide a valid elevation grid first.', variant: 'destructive' });
      return;
    }
    if (validationError) {
      toast({ title: validationError, variant: 'destructive' });
      return;
    }
    const lat = Number(originLat);
    const lng = Number(originLng);
    const cell = Number(cellMeters);
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
      toast({ title: 'Origin latitude must be between -90 and 90.', variant: 'destructive' }); return;
    }
    if (!Number.isFinite(lng) || lng < -180 || lng > 180) {
      toast({ title: 'Origin longitude must be between -180 and 180.', variant: 'destructive' }); return;
    }
    if (!Number.isFinite(cell) || cell <= 0 || cell > 10) {
      toast({ title: 'Cell size must be between 0 and 10 metres.', variant: 'destructive' }); return;
    }

    setSaving(true);
    try {
      const res = await fetch(`/api/organizations/${orgId}/courses/${courseId}/holes/${holeNumber}/contour`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          originLat: lat,
          originLng: lng,
          rows: parsed.data.rows,
          cols: parsed.data.cols,
          cellMeters: cell,
          elevations: parsed.data.elevations,
          source: source.trim() || 'manual',
        }),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error((e as { error?: string }).error ?? 'Save failed');
      }
      const saved = await res.json() as ContourRow;
      setExisting(saved);
      setText('');
      setFileName(null);
      toast({ title: `Contour saved for hole ${holeNumber}` });
    } catch (e) {
      toast({ title: (e as Error).message, variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!courseId || !existing) return;
    if (!confirm(`Delete contour data for hole ${holeNumber}?`)) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/organizations/${orgId}/courses/${courseId}/holes/${holeNumber}/contour`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!res.ok) throw new Error('Delete failed');
      setExisting(null);
      setOriginLat(''); setOriginLng(''); setCellMeters('1.5');
      toast({ title: `Contour deleted for hole ${holeNumber}` });
    } catch (e) {
      toast({ title: (e as Error).message, variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="glass-panel border-white/10 sm:max-w-[680px] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-xl font-display text-white flex items-center gap-2">
            <Mountain className="w-5 h-5 text-primary" /> Green Contour — {course?.name ?? ''}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 mt-2">
          <div className="grid grid-cols-2 gap-3 items-end">
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-white">Hole</label>
              <Select value={String(holeNumber)} onValueChange={(v) => setHoleNumber(parseInt(v))}>
                <SelectTrigger className="bg-black/50 border-white/10 text-white">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-card border-white/10 text-white max-h-72">
                  {Array.from({ length: totalHoles }, (_, i) => i + 1).map(n => (
                    <SelectItem key={n} value={String(n)}>Hole {n}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="text-xs text-muted-foreground">
              {loading ? (
                <span className="flex items-center gap-1.5"><Loader2 className="w-3 h-3 animate-spin" /> Checking…</span>
              ) : existing ? (
                <span className="flex items-center gap-1.5 text-primary">
                  <CheckCircle className="w-3.5 h-3.5" /> Existing grid: {existing.rows}×{existing.cols} ({existing.source ?? 'manual'})
                </span>
              ) : (
                <span>No contour data yet for this hole.</span>
              )}
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-white">Origin Lat</label>
              <Input value={originLat} onChange={e => setOriginLat(e.target.value)} placeholder="28.6139" className="bg-black/50 border-white/10 text-white" />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-white">Origin Lng</label>
              <Input value={originLng} onChange={e => setOriginLng(e.target.value)} placeholder="77.2090" className="bg-black/50 border-white/10 text-white" />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-white">Cell size (m)</label>
              <Input value={cellMeters} onChange={e => setCellMeters(e.target.value)} placeholder="1.5" className="bg-black/50 border-white/10 text-white" />
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-white">Source</label>
            <Input value={source} onChange={e => setSource(e.target.value)} placeholder="manual / lidar / survey" className="bg-black/50 border-white/10 text-white" />
          </div>

          <div className="rounded-xl border border-white/10 bg-white/5 p-3">
            <Tabs value={tab} onValueChange={(v) => setTab(v as 'csv' | 'json' | 'file' | 'bulk')}>
              <TabsList className="bg-black/30">
                <TabsTrigger value="csv"><FileSpreadsheet className="w-3.5 h-3.5 mr-1.5" />Paste CSV</TabsTrigger>
                <TabsTrigger value="json"><FileJson className="w-3.5 h-3.5 mr-1.5" />Paste JSON</TabsTrigger>
                <TabsTrigger value="file"><Upload className="w-3.5 h-3.5 mr-1.5" />Upload file</TabsTrigger>
                <TabsTrigger value="bulk"><Layers className="w-3.5 h-3.5 mr-1.5" />Bulk upload</TabsTrigger>
              </TabsList>
              <TabsContent value="csv" className="mt-3">
                <Textarea
                  value={text}
                  onChange={e => setText(e.target.value)}
                  placeholder={'0.0, 0.05, 0.10\n-0.02, 0.04, 0.09\n-0.05, 0.00, 0.06'}
                  className="bg-black/50 border-white/10 text-white font-mono text-xs min-h-[140px]"
                />
                <p className="text-xs text-muted-foreground mt-1.5">
                  Each line is one row. Comma, semicolon, or tab-separated. Values in metres, relative to the green centre.
                </p>
              </TabsContent>
              <TabsContent value="json" className="mt-3">
                <Textarea
                  value={text}
                  onChange={e => setText(e.target.value)}
                  placeholder={'[[0,0.05,0.10],[-0.02,0.04,0.09],[-0.05,0,0.06]]\n\n— or —\n\n{"rows":3,"cols":3,"elevations":[0,0.05,0.10,-0.02,0.04,0.09,-0.05,0,0.06]}'}
                  className="bg-black/50 border-white/10 text-white font-mono text-xs min-h-[140px]"
                />
                <p className="text-xs text-muted-foreground mt-1.5">
                  Accepts a 2D array <code>[[…]]</code> or an object <code>{'{rows, cols, elevations}'}</code>.
                </p>
              </TabsContent>
              <TabsContent value="file" className="mt-3 space-y-2">
                <label className="flex items-center justify-center gap-2 px-4 py-6 rounded-lg border border-dashed border-white/15 bg-black/30 cursor-pointer hover:border-primary/40 hover:bg-primary/5 transition-colors">
                  <Upload className="w-4 h-4 text-primary" />
                  <span className="text-sm text-white">{fileName ?? 'Choose a .csv or .json file'}</span>
                  <input
                    type="file"
                    accept=".csv,.json,.txt,text/csv,application/json"
                    className="hidden"
                    onChange={(e) => { const f = e.target.files?.[0]; if (f) onPickFile(f); }}
                  />
                </label>
                {text && (
                  <pre className="text-[10px] text-muted-foreground bg-black/40 rounded p-2 max-h-32 overflow-auto">
                    {text.slice(0, 500)}{text.length > 500 ? `\n… (${text.length - 500} more chars)` : ''}
                  </pre>
                )}
              </TabsContent>
              <TabsContent value="bulk" className="mt-3 space-y-3">
                <p className="text-xs text-muted-foreground">
                  Upload one file containing contour grids for many holes at once. Origin Lat/Lng/Cell size set above are <em>ignored</em> — each hole entry must include its own metadata.
                </p>
                <div className="flex items-center justify-between gap-2 rounded-lg border border-white/10 bg-black/20 px-3 py-2">
                  <div className="text-xs text-muted-foreground">
                    New here? Grab a pre-filled skeleton with one entry per hole ({TEMPLATE_DIM}×{TEMPLATE_DIM} of zeros, course location pre-populated).
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={handleDownloadTemplate}
                    disabled={downloadingTemplate || !courseId}
                    className="text-primary hover:bg-primary/10 hover:text-primary flex-shrink-0"
                    data-testid="button-download-bulk-template"
                  >
                    {downloadingTemplate ? (
                      <span className="flex items-center gap-1.5"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Preparing…</span>
                    ) : (
                      <span className="flex items-center gap-1.5"><Download className="w-3.5 h-3.5" /> Download template</span>
                    )}
                  </Button>
                </div>
                <label className="flex items-center justify-center gap-2 px-4 py-6 rounded-lg border border-dashed border-white/15 bg-black/30 cursor-pointer hover:border-primary/40 hover:bg-primary/5 transition-colors">
                  <Upload className="w-4 h-4 text-primary" />
                  <span className="text-sm text-white">{bulkFileName ?? 'Choose a multi-hole .json or .zip'}</span>
                  <input
                    type="file"
                    accept=".json,.zip,application/json,application/zip"
                    className="hidden"
                    onChange={(e) => { const f = e.target.files?.[0]; if (f) onPickBulkFile(f); }}
                  />
                </label>
                <details className="text-[11px] text-muted-foreground bg-black/30 rounded p-2">
                  <summary className="cursor-pointer text-white/80">Expected formats</summary>
                  <div className="mt-2 space-y-2">
                    <div>
                      <strong className="text-white/90">Multi-document JSON</strong> — one file keyed by hole number:
                      <pre className="bg-black/40 rounded p-2 mt-1 overflow-auto">{`{
  "1": { "originLat": 28.6, "originLng": 77.2, "rows": 8, "cols": 8,
         "cellMeters": 1.5, "elevations": [...64 numbers...] },
  "2": { ... },
  "3": { "originLat": 28.6, "originLng": 77.2,
         "elevations": [[...], [...], ...] }   /* 2D array also accepted */
}`}</pre>
                    </div>
                    <div>
                      <strong className="text-white/90">ZIP archive</strong> — one <code>.json</code> file per hole, named <code>1.json</code>, <code>hole-2.json</code>, etc. Each file follows the per-hole shape above (without the outer numeric key).
                    </div>
                  </div>
                </details>

                {bulkParseError && (
                  <div className="flex items-start gap-2 text-xs text-red-300 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
                    <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                    <span>{bulkParseError}</span>
                  </div>
                )}

                {bulkHoles && (
                  <div className="rounded-lg border border-primary/20 bg-primary/5 p-3 text-xs space-y-1">
                    <div className="text-primary font-semibold uppercase tracking-wider">
                      Ready to upload {Object.keys(bulkHoles).length} hole{Object.keys(bulkHoles).length === 1 ? '' : 's'}
                    </div>
                    <div className="text-muted-foreground flex flex-wrap gap-1.5">
                      {Object.entries(bulkHoles)
                        .sort((a, b) => parseInt(a[0]) - parseInt(b[0]))
                        .map(([k, h]) => (
                          <span key={k} className="px-1.5 py-0.5 rounded bg-black/30">
                            #{k} ({h.rows}×{h.cols})
                          </span>
                        ))}
                    </div>
                  </div>
                )}

                <Button
                  onClick={handleBulkUpload}
                  disabled={bulkUploading || !bulkHoles}
                  className="bg-primary hover:bg-primary/90 text-primary-foreground w-full"
                  data-testid="button-bulk-upload-contours"
                >
                  {bulkUploading ? (
                    <span className="flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Uploading…</span>
                  ) : (
                    <>Upload all holes</>
                  )}
                </Button>

                {bulkResults && bulkResults.length > 0 && (
                  <div className="rounded-lg border border-white/10 bg-black/30 p-2 max-h-56 overflow-auto text-xs">
                    <div className="font-semibold text-white/90 mb-1.5">Upload results</div>
                    <ul className="space-y-1">
                      {bulkResults.map((r, i) => (
                        <li key={i} className="flex items-start gap-2">
                          {r.ok ? (
                            <CheckCircle className="w-3.5 h-3.5 text-primary flex-shrink-0 mt-0.5" />
                          ) : (
                            <XCircle className="w-3.5 h-3.5 text-red-400 flex-shrink-0 mt-0.5" />
                          )}
                          <span className={r.ok ? 'text-white/80' : 'text-red-300'}>
                            Hole {Number.isFinite(r.holeNumber) ? r.holeNumber : '?'}
                            {r.ok ? ` — saved (${r.rows}×${r.cols})` : ` — ${r.error}`}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </TabsContent>
            </Tabs>
          </div>

          {validationError && (
            <div className="flex items-start gap-2 text-xs text-red-300 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
              <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
              <span>{validationError}</span>
            </div>
          )}

          {previewGrid && (
            <div className="rounded-xl border border-primary/20 bg-primary/5 p-3 space-y-2">
              <div className="flex items-center justify-between text-xs">
                <span className="font-semibold text-primary uppercase tracking-wider">
                  Preview — {previewGrid.rows} × {previewGrid.cols}
                </span>
                {elevStats && (
                  <span className="text-muted-foreground">
                    min {elevStats.min.toFixed(2)}m · mean {elevStats.mean.toFixed(2)}m · max {elevStats.max.toFixed(2)}m
                  </span>
                )}
              </div>
              <ContourHeatmap grid={previewGrid} />
              <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                <span>low</span>
                <div className="flex-1 h-2 rounded" style={{ background: 'linear-gradient(to right, rgb(0,0,255), rgb(0,255,0), rgb(255,0,0))' }} />
                <span>high</span>
              </div>
            </div>
          )}

          <div className="flex justify-between gap-3 pt-1">
            <div>
              {existing && (
                <Button variant="ghost" onClick={handleDelete} disabled={saving} className="text-red-400 hover:bg-red-500/10 hover:text-red-300">
                  <Trash2 className="w-4 h-4 mr-1.5" /> Delete
                </Button>
              )}
            </div>
            <div className="flex gap-2">
              <Button variant="ghost" onClick={onClose} className="hover:bg-white/5 text-white">Cancel</Button>
              <Button
                onClick={handleSave}
                disabled={saving || !parsed || !parsed.ok || !!validationError}
                className="bg-primary hover:bg-primary/90 text-primary-foreground"
              >
                {saving ? 'Saving…' : existing ? 'Replace contour' : 'Save contour'}
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ContourHeatmap({ grid }: { grid: ParsedGrid }) {
  const { rows, cols, elevations } = grid;
  let min = Infinity, max = -Infinity;
  for (const v of elevations) { if (v < min) min = v; if (v > max) max = v; }
  const cellSize = Math.max(8, Math.min(28, Math.floor(360 / Math.max(rows, cols))));
  return (
    <div className="overflow-auto">
      <div
        role="img"
        aria-label={`${rows} by ${cols} elevation grid`}
        className="grid mx-auto"
        style={{
          gridTemplateColumns: `repeat(${cols}, ${cellSize}px)`,
          gridTemplateRows: `repeat(${rows}, ${cellSize}px)`,
          gap: 1,
        }}
      >
        {elevations.map((v, i) => (
          <div
            key={i}
            title={`r${Math.floor(i / cols) + 1} c${(i % cols) + 1}: ${v.toFixed(2)} m`}
            style={{ background: colourFor(v, min, max), width: cellSize, height: cellSize }}
          />
        ))}
      </div>
    </div>
  );
}
