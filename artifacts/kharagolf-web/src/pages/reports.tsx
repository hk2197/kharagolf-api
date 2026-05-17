import { useState, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useActiveOrgId } from '@/context/ActiveOrgContext';
import {
  FileText, Plus, Trash2, Play, Download, Edit2, Save, ChevronLeft,
  ChevronRight, ArrowUpDown, X, GripVertical, Filter, Database,
  RefreshCw, FileDown, Loader2, Table, Check,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { useToast } from '@/hooks/use-toast';

const BASE_URL = (import.meta.env.BASE_URL ?? '/').replace(/\/$/, '');
function API(path: string) { return `${BASE_URL}/api${path}`; }

async function apiFetch<T>(url: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: 'include', ...opts });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

interface ColumnDef { key: string; label: string; }
interface FilterDef { key: string; label: string; type: 'text' | 'date_range' | 'select' | 'number_range'; options?: { value: string; label: string }[]; }
interface DataSourceDef { key: string; label: string; columns: ColumnDef[]; filters: FilterDef[]; defaultColumns: string[]; }
interface SavedReport {
  id: number;
  name: string;
  description: string | null;
  dataSource: string;
  columns: ColumnDef[];
  filters: Record<string, unknown>;
  sortConfig: { column: string; direction: 'asc' | 'desc' } | null;
  isTemplate: boolean;
  createdAt: string;
}
interface RunResult { rows: Record<string, unknown>[]; total: number; page: number; pageSize: number; totalPages: number; }

type ViewMode = 'list' | 'builder' | 'run';

function FilterInput({ filter, value, onChange }: { filter: FilterDef; value: unknown; onChange: (v: unknown) => void }) {
  if (filter.type === 'select') {
    return (
      <Select value={String(value ?? '_any_')} onValueChange={(v) => onChange(v === '_any_' ? undefined : v)}>
        <SelectTrigger className="h-8 text-xs">
          <SelectValue placeholder="Any" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="_any_">Any</SelectItem>
          {filter.options?.map(o => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
        </SelectContent>
      </Select>
    );
  }
  if (filter.type === 'date_range') {
    const val = (value as { from?: string; to?: string } | undefined) ?? {};
    return (
      <div className="flex gap-2">
        <Input type="date" className="h-8 text-xs" placeholder="From" value={val.from ?? ''} onChange={e => onChange({ ...val, from: e.target.value || undefined })} />
        <Input type="date" className="h-8 text-xs" placeholder="To" value={val.to ?? ''} onChange={e => onChange({ ...val, to: e.target.value || undefined })} />
      </div>
    );
  }
  if (filter.type === 'number_range') {
    const val = (value as { min?: number; max?: number } | undefined) ?? {};
    return (
      <div className="flex gap-2">
        <Input type="number" className="h-8 text-xs" placeholder="Min" value={val.min ?? ''} onChange={e => onChange({ ...val, min: e.target.value ? parseInt(e.target.value) : undefined })} />
        <Input type="number" className="h-8 text-xs" placeholder="Max" value={val.max ?? ''} onChange={e => onChange({ ...val, max: e.target.value ? parseInt(e.target.value) : undefined })} />
      </div>
    );
  }
  return (
    <Input className="h-8 text-xs" placeholder={`Filter by ${filter.label.toLowerCase()}`} value={String(value ?? '')} onChange={e => onChange(e.target.value || undefined)} />
  );
}

export default function ReportsPage() {
  const orgId = useActiveOrgId();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [view, setView] = useState<ViewMode>('list');
  const [editingReport, setEditingReport] = useState<SavedReport | null>(null);
  const [runningReport, setRunningReport] = useState<SavedReport | null>(null);

  const [step, setStep] = useState(1);
  const [builderName, setBuilderName] = useState('');
  const [builderDescription, setBuilderDescription] = useState('');
  const [builderDataSource, setBuilderDataSource] = useState('');
  const [builderColumns, setBuilderColumns] = useState<ColumnDef[]>([]);
  const [builderFilters, setBuilderFilters] = useState<Record<string, unknown>>({});
  const [builderSort, setBuilderSort] = useState<{ column: string; direction: 'asc' | 'desc' } | null>(null);

  const [runPage, setRunPage] = useState(1);
  const [runResult, setRunResult] = useState<RunResult | null>(null);
  const [runLoading, setRunLoading] = useState(false);
  const [previewResult, setPreviewResult] = useState<RunResult | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const [deleteConfirm, setDeleteConfirm] = useState<number | null>(null);

  const { data: schema = [] } = useQuery<DataSourceDef[]>({
    queryKey: ['reports-schema', orgId],
    queryFn: () => apiFetch(API(`/organizations/${orgId}/reports/schema`)),
    enabled: !!orgId,
  });

  const { data: reports = [], isLoading: reportsLoading } = useQuery<SavedReport[]>({
    queryKey: ['reports', orgId],
    queryFn: () => apiFetch(API(`/organizations/${orgId}/reports`)),
    enabled: !!orgId,
  });

  const createMutation = useMutation({
    mutationFn: (data: object) => apiFetch(API(`/organizations/${orgId}/reports`), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
    }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['reports', orgId] }); },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: number; data: object }) => apiFetch(API(`/organizations/${orgId}/reports/${id}`), {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
    }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['reports', orgId] }); },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => fetch(API(`/organizations/${orgId}/reports/${id}`), { method: 'DELETE', credentials: 'include' }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['reports', orgId] }); },
  });

  const currentDS = schema.find(s => s.key === builderDataSource);

  function startBuilder(report?: SavedReport) {
    if (report) {
      setEditingReport(report);
      setBuilderName(report.name);
      setBuilderDescription(report.description ?? '');
      setBuilderDataSource(report.dataSource);
      setBuilderColumns(report.columns ?? []);
      setBuilderFilters(report.filters ?? {});
      setBuilderSort(report.sortConfig);
    } else {
      setEditingReport(null);
      setBuilderName('');
      setBuilderDescription('');
      setBuilderDataSource('');
      setBuilderColumns([]);
      setBuilderFilters({});
      setBuilderSort(null);
    }
    setStep(1);
    setPreviewResult(null);
    setView('builder');
  }

  function handleDataSourceSelect(key: string) {
    setBuilderDataSource(key);
    const ds = schema.find(s => s.key === key);
    if (ds) {
      setBuilderColumns(ds.defaultColumns.map(k => ds.columns.find(c => c.key === k)!).filter(Boolean));
    }
    setBuilderFilters({});
    setBuilderSort(null);
  }

  function toggleColumn(col: ColumnDef) {
    setBuilderColumns(prev => {
      const exists = prev.find(c => c.key === col.key);
      if (exists) return prev.filter(c => c.key !== col.key);
      return [...prev, col];
    });
  }

  function moveColumn(idx: number, dir: -1 | 1) {
    setBuilderColumns(prev => {
      const arr = [...prev];
      const newIdx = idx + dir;
      if (newIdx < 0 || newIdx >= arr.length) return arr;
      [arr[idx], arr[newIdx]] = [arr[newIdx], arr[idx]];
      return arr;
    });
  }

  async function runPreview() {
    if (!builderDataSource || builderColumns.length === 0) return;
    setPreviewLoading(true);
    try {
      const result = await apiFetch<RunResult>(API(`/organizations/${orgId}/reports/run`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dataSource: builderDataSource, columns: builderColumns, filters: builderFilters, sortConfig: builderSort, page: 1, pageSize: 50 }),
      });
      setPreviewResult(result);
    } catch (e) {
      toast({ title: 'Preview failed', description: e instanceof Error ? e.message : 'Unknown error', variant: 'destructive' });
    } finally {
      setPreviewLoading(false);
    }
  }

  async function saveReport() {
    if (!builderName || !builderDataSource) return;
    const payload = { name: builderName, description: builderDescription, dataSource: builderDataSource, columns: builderColumns, filters: builderFilters, sortConfig: builderSort };
    try {
      if (editingReport) {
        await updateMutation.mutateAsync({ id: editingReport.id, data: payload });
        toast({ title: 'Report updated' });
      } else {
        await createMutation.mutateAsync(payload);
        toast({ title: 'Report saved' });
      }
      setView('list');
    } catch (e) {
      toast({ title: 'Save failed', description: e instanceof Error ? e.message : 'Unknown error', variant: 'destructive' });
    }
  }

  async function runSavedReport(report: SavedReport, page = 1) {
    setRunLoading(true);
    try {
      const result = await apiFetch<RunResult>(API(`/organizations/${orgId}/reports/${report.id}/run`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ page, pageSize: 50 }),
      });
      setRunResult(result);
      setRunPage(page);
    } catch (e) {
      toast({ title: 'Run failed', description: e instanceof Error ? e.message : 'Unknown error', variant: 'destructive' });
    } finally {
      setRunLoading(false);
    }
  }

  function openRunView(report: SavedReport) {
    setRunningReport(report);
    setRunResult(null);
    setRunPage(1);
    setView('run');
    runSavedReport(report, 1);
  }

  function handleDelete(id: number) {
    deleteMutation.mutate(id, {
      onSuccess: () => toast({ title: 'Report deleted' }),
    });
    setDeleteConfirm(null);
  }

  function downloadCSV(report: SavedReport) {
    window.open(API(`/organizations/${orgId}/reports/${report.id}/csv`), '_blank');
  }

  function downloadPDF(report: SavedReport) {
    window.open(API(`/organizations/${orgId}/reports/${report.id}/pdf`), '_blank');
  }

  const templateReports = reports.filter(r => r.isTemplate);
  const myReports = reports.filter(r => !r.isTemplate);

  if (view === 'builder') {
    return (
      <div className="p-6 max-w-5xl mx-auto space-y-6">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={() => setView('list')}>
            <ChevronLeft className="w-4 h-4 mr-1" /> Back
          </Button>
          <h1 className="text-2xl font-bold">{editingReport ? 'Edit Report' : 'New Report'}</h1>
          <div className="flex gap-1 ml-auto">
            {[1, 2, 3, 4].map(s => (
              <div key={s} className={`w-8 h-1.5 rounded-full transition-colors ${step >= s ? 'bg-primary' : 'bg-muted'}`} />
            ))}
          </div>
        </div>

        {step === 1 && (
          <Card>
            <CardHeader><CardTitle className="flex items-center gap-2"><Database className="w-4 h-4" /> Step 1: Choose Data Source</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label>Report Name *</Label>
                <Input placeholder="e.g. Season Payments Summary" value={builderName} onChange={e => setBuilderName(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>Description</Label>
                <Textarea placeholder="What is this report for?" value={builderDescription} onChange={e => setBuilderDescription(e.target.value)} rows={2} />
              </div>
              <div className="space-y-2">
                <Label>Data Source *</Label>
                <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mt-2">
                  {schema.map(ds => (
                    <button
                      key={ds.key}
                      onClick={() => handleDataSourceSelect(ds.key)}
                      className={`p-4 rounded-lg border text-left transition-colors ${builderDataSource === ds.key ? 'border-primary bg-primary/5 text-primary' : 'border-border hover:border-muted-foreground/50'}`}
                    >
                      <div className="flex items-center gap-2 mb-1">
                        {builderDataSource === ds.key && <Check className="w-3.5 h-3.5 text-primary" />}
                        <span className="text-sm font-medium">{ds.label}</span>
                      </div>
                      <p className="text-xs text-muted-foreground">{ds.columns.length} available columns</p>
                    </button>
                  ))}
                </div>
              </div>
              <div className="flex justify-end">
                <Button onClick={() => setStep(2)} disabled={!builderName || !builderDataSource}>Next: Pick Columns</Button>
              </div>
            </CardContent>
          </Card>
        )}

        {step === 2 && currentDS && (
          <Card>
            <CardHeader><CardTitle className="flex items-center gap-2"><Table className="w-4 h-4" /> Step 2: Choose Columns</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm text-muted-foreground">Select and reorder the columns you want in your report.</p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div>
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">Available Columns</p>
                  <div className="space-y-1 max-h-72 overflow-y-auto border rounded-lg p-2">
                    {currentDS.columns.map(col => (
                      <label key={col.key} className="flex items-center gap-2 p-1.5 rounded hover:bg-muted cursor-pointer">
                        <Checkbox checked={!!builderColumns.find(c => c.key === col.key)} onCheckedChange={() => toggleColumn(col)} />
                        <span className="text-sm">{col.label}</span>
                      </label>
                    ))}
                  </div>
                </div>
                <div>
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">Selected ({builderColumns.length}) — click label to rename</p>
                  <div className="space-y-1 max-h-72 overflow-y-auto border rounded-lg p-2">
                    {builderColumns.length === 0 && <p className="text-xs text-muted-foreground text-center py-4">No columns selected</p>}
                    {builderColumns.map((col, i) => (
                      <div key={col.key} className="flex items-center gap-2 p-1.5 rounded bg-muted/50">
                        <GripVertical className="w-3 h-3 text-muted-foreground flex-shrink-0" />
                        <Input
                          className="h-6 text-xs flex-1 border-transparent bg-transparent focus:bg-white focus:border-border px-1 py-0"
                          value={col.label}
                          onChange={e => setBuilderColumns(prev => prev.map((c, idx) => idx === i ? { ...c, label: e.target.value } : c))}
                          title="Click to edit column display name"
                        />
                        <div className="flex gap-0.5 flex-shrink-0">
                          <button onClick={() => moveColumn(i, -1)} disabled={i === 0} className="p-0.5 rounded hover:bg-muted disabled:opacity-30">
                            <ChevronLeft className="w-3 h-3" />
                          </button>
                          <button onClick={() => moveColumn(i, 1)} disabled={i === builderColumns.length - 1} className="p-0.5 rounded hover:bg-muted disabled:opacity-30">
                            <ChevronRight className="w-3 h-3" />
                          </button>
                          <button onClick={() => toggleColumn(col)} className="p-0.5 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive">
                            <X className="w-3 h-3" />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
              <div className="flex justify-between">
                <Button variant="outline" onClick={() => setStep(1)}>Back</Button>
                <Button onClick={() => setStep(3)} disabled={builderColumns.length === 0}>Next: Add Filters</Button>
              </div>
            </CardContent>
          </Card>
        )}

        {step === 3 && currentDS && (
          <Card>
            <CardHeader><CardTitle className="flex items-center gap-2"><Filter className="w-4 h-4" /> Step 3: Configure Filters & Sort</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm text-muted-foreground">Filters are optional. Leave blank to include all records.</p>
              <div className="space-y-3">
                {currentDS.filters.map(filter => (
                  <div key={filter.key} className="grid grid-cols-3 gap-3 items-center">
                    <Label className="text-sm">{filter.label}</Label>
                    <div className="col-span-2">
                      <FilterInput filter={filter} value={builderFilters[filter.key]} onChange={v => setBuilderFilters(prev => ({ ...prev, [filter.key]: v }))} />
                    </div>
                  </div>
                ))}
              </div>
              <hr className="my-4" />
              <div className="grid grid-cols-3 gap-3 items-center">
                <Label className="text-sm flex items-center gap-1"><ArrowUpDown className="w-3 h-3" /> Sort By</Label>
                <div className="col-span-2 flex gap-2">
                  <Select value={builderSort?.column ?? '_none_'} onValueChange={v => setBuilderSort(v === '_none_' ? null : { column: v, direction: builderSort?.direction ?? 'asc' })}>
                    <SelectTrigger className="h-8 text-xs">
                      <SelectValue placeholder="No sort" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="_none_">No sort</SelectItem>
                      {builderColumns.map(c => <SelectItem key={c.key} value={c.key}>{c.label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  {builderSort && (
                    <Select value={builderSort.direction} onValueChange={v => setBuilderSort(prev => prev ? { ...prev, direction: v as 'asc' | 'desc' } : null)}>
                      <SelectTrigger className="h-8 text-xs w-28">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="asc">Ascending</SelectItem>
                        <SelectItem value="desc">Descending</SelectItem>
                      </SelectContent>
                    </Select>
                  )}
                </div>
              </div>
              <div className="flex justify-between">
                <Button variant="outline" onClick={() => setStep(2)}>Back</Button>
                <Button onClick={() => { setStep(4); runPreview(); }}>Next: Preview</Button>
              </div>
            </CardContent>
          </Card>
        )}

        {step === 4 && (
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="flex items-center gap-2"><Play className="w-4 h-4" /> Step 4: Preview & Save</CardTitle>
                <Button variant="outline" size="sm" onClick={runPreview} disabled={previewLoading}>
                  {previewLoading ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <RefreshCw className="w-3 h-3 mr-1" />}
                  Refresh
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              {previewLoading && (
                <div className="flex items-center justify-center py-12 text-muted-foreground">
                  <Loader2 className="w-6 h-6 animate-spin mr-2" /> Running preview...
                </div>
              )}
              {!previewLoading && previewResult && (
                <>
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <span>Showing first {previewResult.rows.length} of {previewResult.total} records</span>
                  </div>
                  <div className="overflow-x-auto rounded-lg border">
                    <table className="w-full text-xs">
                      <thead className="bg-muted/50">
                        <tr>
                          {builderColumns.map(col => (
                            <th key={col.key} className="px-3 py-2 text-left font-medium text-muted-foreground whitespace-nowrap">{col.label}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {previewResult.rows.map((row, i) => (
                          <tr key={i} className="border-t hover:bg-muted/20">
                            {builderColumns.map(col => (
                              <td key={col.key} className="px-3 py-1.5 whitespace-nowrap">{String(row[col.key] ?? '')}</td>
                            ))}
                          </tr>
                        ))}
                        {previewResult.rows.length === 0 && (
                          <tr><td colSpan={builderColumns.length} className="px-3 py-8 text-center text-muted-foreground">No data found</td></tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
              <div className="flex justify-between pt-2">
                <Button variant="outline" onClick={() => setStep(3)}>Back</Button>
                <Button onClick={saveReport} disabled={createMutation.isPending || updateMutation.isPending}>
                  {(createMutation.isPending || updateMutation.isPending) ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Save className="w-4 h-4 mr-2" />}
                  {editingReport ? 'Update Report' : 'Save Report'}
                </Button>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    );
  }

  if (view === 'run' && runningReport) {
    const cols = runningReport.columns ?? [];
    return (
      <div className="p-6 max-w-full space-y-4">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={() => setView('list')}>
            <ChevronLeft className="w-4 h-4 mr-1" /> Back
          </Button>
          <div className="flex-1">
            <h1 className="text-xl font-bold">{runningReport.name}</h1>
            {runningReport.description && <p className="text-sm text-muted-foreground">{runningReport.description}</p>}
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => downloadCSV(runningReport)}>
              <Download className="w-3.5 h-3.5 mr-1" /> CSV
            </Button>
            <Button variant="outline" size="sm" onClick={() => downloadPDF(runningReport)}>
              <FileDown className="w-3.5 h-3.5 mr-1" /> PDF
            </Button>
          </div>
        </div>

        {runLoading && (
          <div className="flex items-center justify-center py-16 text-muted-foreground">
            <Loader2 className="w-6 h-6 animate-spin mr-2" /> Loading report...
          </div>
        )}

        {!runLoading && runResult && (
          <>
            <div className="flex items-center justify-between text-sm text-muted-foreground">
              <span>{runResult.total} total records</span>
              <span>Page {runResult.page} of {runResult.totalPages}</span>
            </div>
            <div className="overflow-x-auto rounded-lg border bg-card">
              <table className="w-full text-xs">
                <thead className="bg-muted/50 sticky top-0">
                  <tr>
                    {cols.map(col => (
                      <th key={col.key} className="px-3 py-2.5 text-left font-medium text-muted-foreground whitespace-nowrap border-b">{col.label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {runResult.rows.map((row, i) => (
                    <tr key={i} className="border-t hover:bg-muted/20">
                      {cols.map(col => (
                        <td key={col.key} className="px-3 py-1.5 whitespace-nowrap">{String(row[col.key] ?? '')}</td>
                      ))}
                    </tr>
                  ))}
                  {runResult.rows.length === 0 && (
                    <tr><td colSpan={cols.length} className="px-3 py-12 text-center text-muted-foreground">No data found for this report</td></tr>
                  )}
                </tbody>
              </table>
            </div>
            {runResult.totalPages > 1 && (
              <div className="flex items-center justify-center gap-2">
                <Button variant="outline" size="sm" disabled={runPage === 1} onClick={() => { const p = runPage - 1; setRunPage(p); runSavedReport(runningReport, p); }}>
                  <ChevronLeft className="w-4 h-4" />
                </Button>
                <span className="text-sm">{runPage} / {runResult.totalPages}</span>
                <Button variant="outline" size="sm" disabled={runPage === runResult.totalPages} onClick={() => { const p = runPage + 1; setRunPage(p); runSavedReport(runningReport, p); }}>
                  <ChevronRight className="w-4 h-4" />
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Reports</h1>
          <p className="text-muted-foreground text-sm">Build, save, and export custom data reports for your club</p>
        </div>
        <Button onClick={() => startBuilder()}>
          <Plus className="w-4 h-4 mr-2" /> New Report
        </Button>
      </div>

      {templateReports.length > 0 && (
        <div>
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">Standard Reports</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
            {templateReports.map(report => (
              <Card key={report.id} className="hover:border-primary/50 transition-colors">
                <CardContent className="p-4 space-y-3">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="font-medium text-sm">{report.name}</p>
                      {report.description && <p className="text-xs text-muted-foreground mt-0.5">{report.description}</p>}
                    </div>
                    <Badge variant="secondary" className="text-xs flex-shrink-0">Template</Badge>
                  </div>
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <Badge variant="outline" className="text-xs">
                      {schema.find(s => s.key === report.dataSource)?.label ?? report.dataSource}
                    </Badge>
                    <Badge variant="outline" className="text-xs">{report.columns.length} cols</Badge>
                  </div>
                  <div className="flex gap-2 pt-1">
                    <Button size="sm" className="flex-1" onClick={() => openRunView(report)}>
                      <Play className="w-3 h-3 mr-1" /> Run
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => downloadCSV(report)} title="Download CSV">
                      <Download className="w-3 h-3" />
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => downloadPDF(report)} title="Download PDF">
                      <FileDown className="w-3 h-3" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      )}

      <div>
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">My Reports</h2>
        {reportsLoading && (
          <div className="flex items-center justify-center py-12 text-muted-foreground">
            <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading reports...
          </div>
        )}
        {!reportsLoading && myReports.length === 0 && (
          <Card>
            <CardContent className="py-12 text-center">
              <FileText className="w-10 h-10 mx-auto text-muted-foreground mb-3" />
              <p className="font-medium mb-1">No saved reports yet</p>
              <p className="text-sm text-muted-foreground mb-4">Create a custom report using the builder above</p>
              <Button onClick={() => startBuilder()}>
                <Plus className="w-4 h-4 mr-2" /> New Report
              </Button>
            </CardContent>
          </Card>
        )}
        {myReports.length > 0 && (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {myReports.map(report => (
              <Card key={report.id} className="hover:border-primary/50 transition-colors">
                <CardContent className="p-4 space-y-3">
                  <div>
                    <p className="font-medium text-sm">{report.name}</p>
                    {report.description && <p className="text-xs text-muted-foreground mt-0.5">{report.description}</p>}
                  </div>
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <Badge variant="outline" className="text-xs">
                      {schema.find(s => s.key === report.dataSource)?.label ?? report.dataSource}
                    </Badge>
                    <Badge variant="outline" className="text-xs">{report.columns.length} cols</Badge>
                    <span className="text-xs text-muted-foreground ml-auto">
                      {new Date(report.createdAt).toLocaleDateString()}
                    </span>
                  </div>
                  <div className="flex gap-2 pt-1">
                    <Button size="sm" className="flex-1" onClick={() => openRunView(report)}>
                      <Play className="w-3 h-3 mr-1" /> Run
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => startBuilder(report)} title="Edit">
                      <Edit2 className="w-3 h-3" />
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => downloadCSV(report)} title="Download CSV">
                      <Download className="w-3 h-3" />
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => downloadPDF(report)} title="Download PDF">
                      <FileDown className="w-3 h-3" />
                    </Button>
                    {deleteConfirm === report.id ? (
                      <>
                        <Button size="sm" variant="destructive" onClick={() => handleDelete(report.id)}>
                          <Check className="w-3 h-3" />
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => setDeleteConfirm(null)}>
                          <X className="w-3 h-3" />
                        </Button>
                      </>
                    ) : (
                      <Button size="sm" variant="outline" onClick={() => setDeleteConfirm(report.id)} title="Delete">
                        <Trash2 className="w-3 h-3" />
                      </Button>
                    )}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
