import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useActiveOrgId } from '@/context/ActiveOrgContext';
import {
  FileText, Download, Search, Filter, ChevronDown,
  Receipt, BarChart2, CheckSquare, Square, Loader2,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
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

interface GstInvoice {
  id: number;
  invoiceNumber: string;
  channel: 'shop' | 'pos' | 'tournament' | 'league';
  status: string;
  buyerName: string;
  buyerEmail: string | null;
  buyerGstin: string | null;
  buyerStateCode: string | null;
  sellerGstin: string | null;
  gstRouting: 'cgst_sgst' | 'igst' | 'zero_rated';
  taxableAmount: string;
  cgstAmount: string;
  sgstAmount: string;
  igstAmount: string;
  totalAmount: string;
  currency: string;
  pdfPath: string | null;
  invoiceDate: string;
  stateOfSupply: string | null;
}

interface GstSummary {
  overall: {
    totalInvoices: number;
    totalAmount: string | null;
    totalTaxable: string | null;
    totalCgst: string | null;
    totalSgst: string | null;
    totalIgst: string | null;
  };
  byChannel: Array<{ channel: string; invoiceCount: number; totalAmount: string | null; cgst: string | null; sgst: string | null; igst: string | null }>;
  byRouting: Array<{ routing: string; invoiceCount: number; totalCgst: string | null; totalSgst: string | null; totalIgst: string | null }>;
  byStateOfSupply: Array<{ stateOfSupply: string | null; invoiceCount: number; totalAmount: string | null; totalCgst: string | null; totalSgst: string | null; totalIgst: string | null }>;
}

const CHANNEL_LABELS: Record<string, string> = {
  shop: 'Online Shop', pos: 'POS / Pro Shop', tournament: 'Tournament', league: 'League',
};
const ROUTING_LABELS: Record<string, string> = {
  cgst_sgst: 'CGST + SGST', igst: 'IGST', zero_rated: 'Zero-Rated (Export)',
};
const ROUTING_BADGE_VARIANT: Record<string, string> = {
  cgst_sgst: 'default', igst: 'secondary', zero_rated: 'outline',
};

function fmt(val: string | null | undefined, currency = 'INR') {
  const n = parseFloat(val ?? '0');
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 2 }).format(n);
}

function today() { return new Date().toISOString().slice(0, 10); }
function monthStart() {
  const d = new Date(); d.setDate(1); return d.toISOString().slice(0, 10);
}

export default function GstInvoicesPage() {
  const { orgId } = useActiveOrgId();
  const { toast } = useToast();

  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(today());
  const [channel, setChannel] = useState('all');
  const [routing, setRouting] = useState('all');
  const [status, setStatus] = useState('all');
  const [stateOfSupply, setStateOfSupply] = useState('');
  const [q, setQ] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [downloading, setDownloading] = useState(false);
  const [bulkDownloading, setBulkDownloading] = useState(false);

  const invoicesQuery = useQuery({
    queryKey: ['gst-invoices', orgId, from, to, channel, routing, status, stateOfSupply, q],
    queryFn: () => {
      const params = new URLSearchParams({ from, to, limit: '100' });
      if (channel && channel !== 'all') params.set('channel', channel);
      if (routing && routing !== 'all') params.set('routing', routing);
      if (status && status !== 'all') params.set('status', status);
      if (stateOfSupply) params.set('stateOfSupply', stateOfSupply);
      if (q) params.set('q', q);
      return apiFetch<GstInvoice[]>(API(`/organizations/${orgId}/gst-invoices?${params}`));
    },
    enabled: !!orgId,
  });

  const summaryQuery = useQuery({
    queryKey: ['gst-summary', orgId, from, to],
    queryFn: () => {
      const params = new URLSearchParams({ from, to });
      return apiFetch<GstSummary>(API(`/organizations/${orgId}/gst-invoices/summary?${params}`));
    },
    enabled: !!orgId,
  });

  const invoices = invoicesQuery.data ?? [];
  const summary = summaryQuery.data;

  function toggleSelect(id: number) {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    if (selectedIds.size === invoices.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(invoices.map(i => i.id)));
    }
  }

  async function downloadSingle(inv: GstInvoice) {
    if (!inv.pdfPath) { toast({ title: 'No PDF', description: 'PDF not yet generated for this invoice.', variant: 'destructive' }); return; }
    setDownloading(true);
    try {
      const res = await fetch(API(`/organizations/${orgId}/gst-invoices/${inv.id}/download`), { credentials: 'include' });
      if (!res.ok) throw new Error('Download failed');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url;
      a.download = `${inv.invoiceNumber}.pdf`; a.click();
      URL.revokeObjectURL(url);
    } catch {
      toast({ title: 'Download failed', variant: 'destructive' });
    } finally { setDownloading(false); }
  }

  async function bulkDownload() {
    if (selectedIds.size === 0) { toast({ title: 'No invoices selected', variant: 'destructive' }); return; }
    setBulkDownloading(true);
    try {
      const res = await fetch(API(`/organizations/${orgId}/gst-invoices/bulk-download`), {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: Array.from(selectedIds) }),
      });
      if (!res.ok) throw new Error('Bulk download failed');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url;
      a.download = `invoices-${Date.now()}.zip`; a.click();
      URL.revokeObjectURL(url);
    } catch {
      toast({ title: 'Bulk download failed', variant: 'destructive' });
    } finally { setBulkDownloading(false); }
  }

  const totalGstCollected = summary
    ? parseFloat(summary.overall.totalCgst ?? '0') + parseFloat(summary.overall.totalSgst ?? '0') + parseFloat(summary.overall.totalIgst ?? '0')
    : 0;

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">
      <div className="flex items-center gap-3">
        <Receipt className="h-7 w-7 text-green-600" />
        <div>
          <h1 className="text-2xl font-bold">GST Invoices</h1>
          <p className="text-sm text-muted-foreground">Tax invoices for shop orders, POS transactions, and tournament fees</p>
        </div>
      </div>

      {/* Summary Cards */}
      {summary && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Card>
            <CardContent className="pt-4">
              <p className="text-xs text-muted-foreground">Total Invoices</p>
              <p className="text-2xl font-bold">{summary.overall.totalInvoices}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4">
              <p className="text-xs text-muted-foreground">Taxable Value</p>
              <p className="text-2xl font-bold">{fmt(summary.overall.totalTaxable)}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4">
              <p className="text-xs text-muted-foreground">Total GST Collected</p>
              <p className="text-2xl font-bold text-green-600">
                {new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(totalGstCollected)}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4">
              <p className="text-xs text-muted-foreground">Invoice Total</p>
              <p className="text-2xl font-bold">{fmt(summary.overall.totalAmount)}</p>
            </CardContent>
          </Card>
        </div>
      )}

      <Tabs defaultValue="invoices">
        <TabsList>
          <TabsTrigger value="invoices"><FileText className="h-4 w-4 mr-1" />Invoices</TabsTrigger>
          <TabsTrigger value="gstr1"><BarChart2 className="h-4 w-4 mr-1" />GSTR-1 Summary</TabsTrigger>
        </TabsList>

        {/* ── Invoices Tab ── */}
        <TabsContent value="invoices" className="space-y-4">
          {/* Filters */}
          <Card>
            <CardContent className="pt-4">
              <div className="flex flex-wrap gap-3 items-end">
                <div className="flex flex-col gap-1">
                  <label className="text-xs font-medium">From</label>
                  <Input type="date" value={from} onChange={e => setFrom(e.target.value)} className="w-36" />
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-xs font-medium">To</label>
                  <Input type="date" value={to} onChange={e => setTo(e.target.value)} className="w-36" />
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-xs font-medium">Channel</label>
                  <Select value={channel} onValueChange={setChannel}>
                    <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All Channels</SelectItem>
                      <SelectItem value="shop">Online Shop</SelectItem>
                      <SelectItem value="pos">POS</SelectItem>
                      <SelectItem value="tournament">Tournament</SelectItem>
                      <SelectItem value="league">League</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-xs font-medium">GST Routing</label>
                  <Select value={routing} onValueChange={setRouting}>
                    <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All Routing</SelectItem>
                      <SelectItem value="cgst_sgst">CGST + SGST</SelectItem>
                      <SelectItem value="igst">IGST (Inter-State)</SelectItem>
                      <SelectItem value="zero_rated">Zero-Rated (Export)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-xs font-medium">Status</label>
                  <Select value={status} onValueChange={setStatus}>
                    <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All Status</SelectItem>
                      <SelectItem value="issued">Issued</SelectItem>
                      <SelectItem value="cancelled">Cancelled</SelectItem>
                      <SelectItem value="amended">Amended</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-xs font-medium">State of Supply</label>
                  <Input
                    placeholder="e.g. Karnataka"
                    value={stateOfSupply}
                    onChange={e => setStateOfSupply(e.target.value)}
                    className="w-36"
                  />
                </div>
                <div className="flex flex-col gap-1 flex-1 min-w-48">
                  <label className="text-xs font-medium">Search</label>
                  <div className="relative">
                    <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
                    <Input
                      placeholder="Invoice #, buyer name, email, GSTIN…"
                      value={q}
                      onChange={e => setQ(e.target.value)}
                      className="pl-8"
                    />
                  </div>
                </div>
                {selectedIds.size > 0 && (
                  <Button variant="outline" onClick={bulkDownload} disabled={bulkDownloading}>
                    {bulkDownloading ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Download className="h-4 w-4 mr-1" />}
                    Download {selectedIds.size} selected
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Invoices Table */}
          <Card>
            <CardContent className="p-0">
              {invoicesQuery.isLoading ? (
                <div className="flex items-center justify-center py-16">
                  <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                </div>
              ) : invoices.length === 0 ? (
                <div className="text-center py-16 text-muted-foreground">
                  <Receipt className="h-10 w-10 mx-auto mb-3 opacity-30" />
                  <p>No invoices found for this period</p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b bg-muted/40">
                        <th className="p-3 w-10">
                          <button onClick={toggleAll}>
                            {selectedIds.size === invoices.length && invoices.length > 0
                              ? <CheckSquare className="h-4 w-4" />
                              : <Square className="h-4 w-4" />}
                          </button>
                        </th>
                        <th className="p-3 text-left font-medium">Invoice #</th>
                        <th className="p-3 text-left font-medium">Date</th>
                        <th className="p-3 text-left font-medium">Channel</th>
                        <th className="p-3 text-left font-medium">Status</th>
                        <th className="p-3 text-left font-medium">Buyer</th>
                        <th className="p-3 text-left font-medium">GST Type</th>
                        <th className="p-3 text-right font-medium">Taxable</th>
                        <th className="p-3 text-right font-medium">GST</th>
                        <th className="p-3 text-right font-medium">Total</th>
                        <th className="p-3 w-16"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {invoices.map(inv => {
                        const gst = parseFloat(inv.cgstAmount) + parseFloat(inv.sgstAmount) + parseFloat(inv.igstAmount);
                        return (
                          <tr key={inv.id} className="border-b hover:bg-muted/20 transition-colors">
                            <td className="p-3">
                              <button onClick={() => toggleSelect(inv.id)}>
                                {selectedIds.has(inv.id)
                                  ? <CheckSquare className="h-4 w-4 text-green-600" />
                                  : <Square className="h-4 w-4" />}
                              </button>
                            </td>
                            <td className="p-3 font-mono text-xs font-semibold">{inv.invoiceNumber}</td>
                            <td className="p-3 text-xs text-muted-foreground">
                              {new Date(inv.invoiceDate).toLocaleDateString('en-IN')}
                            </td>
                            <td className="p-3">
                              <Badge variant="outline" className="text-xs">{CHANNEL_LABELS[inv.channel] ?? inv.channel}</Badge>
                            </td>
                            <td className="p-3">
                              <Badge
                                variant={inv.status === 'cancelled' ? 'destructive' : inv.status === 'amended' ? 'secondary' : 'outline'}
                                className="text-xs capitalize"
                              >{inv.status}</Badge>
                            </td>
                            <td className="p-3">
                              <div className="font-medium text-xs">{inv.buyerName}</div>
                              {inv.buyerGstin && <div className="text-xs text-muted-foreground font-mono">{inv.buyerGstin}</div>}
                            </td>
                            <td className="p-3">
                              <Badge variant={ROUTING_BADGE_VARIANT[inv.gstRouting] as "default" | "secondary" | "outline" | "destructive"} className="text-xs">
                                {ROUTING_LABELS[inv.gstRouting] ?? inv.gstRouting}
                              </Badge>
                            </td>
                            <td className="p-3 text-right text-xs">{fmt(inv.taxableAmount)}</td>
                            <td className="p-3 text-right text-xs font-semibold text-green-700">
                              {new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(gst)}
                            </td>
                            <td className="p-3 text-right text-xs font-bold">{fmt(inv.totalAmount)}</td>
                            <td className="p-3">
                              <Button
                                size="sm" variant="ghost"
                                onClick={() => downloadSingle(inv)}
                                disabled={!inv.pdfPath || downloading}
                              >
                                <Download className="h-3.5 w-3.5" />
                              </Button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── GSTR-1 Summary Tab ── */}
        <TabsContent value="gstr1" className="space-y-4">
          {summaryQuery.isLoading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : summary ? (
            <div className="space-y-4">
              {/* By Channel */}
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">GST by Sales Channel</CardTitle>
                </CardHeader>
                <CardContent>
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-muted-foreground">
                        <th className="pb-2 text-left">Channel</th>
                        <th className="pb-2 text-right">Invoices</th>
                        <th className="pb-2 text-right">Total</th>
                        <th className="pb-2 text-right">CGST</th>
                        <th className="pb-2 text-right">SGST</th>
                        <th className="pb-2 text-right">IGST</th>
                      </tr>
                    </thead>
                    <tbody>
                      {summary.byChannel.map(r => (
                        <tr key={r.channel} className="border-b last:border-0">
                          <td className="py-2 font-medium">{CHANNEL_LABELS[r.channel] ?? r.channel}</td>
                          <td className="py-2 text-right">{r.invoiceCount}</td>
                          <td className="py-2 text-right">{fmt(r.totalAmount)}</td>
                          <td className="py-2 text-right text-blue-600">{fmt(r.cgst)}</td>
                          <td className="py-2 text-right text-purple-600">{fmt(r.sgst)}</td>
                          <td className="py-2 text-right text-orange-600">{fmt(r.igst)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </CardContent>
              </Card>

              {/* By GST Routing */}
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">GST by Transaction Type</CardTitle>
                </CardHeader>
                <CardContent>
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-muted-foreground">
                        <th className="pb-2 text-left">Type</th>
                        <th className="pb-2 text-right">Invoices</th>
                        <th className="pb-2 text-right">CGST</th>
                        <th className="pb-2 text-right">SGST</th>
                        <th className="pb-2 text-right">IGST</th>
                      </tr>
                    </thead>
                    <tbody>
                      {summary.byRouting.map(r => (
                        <tr key={r.routing} className="border-b last:border-0">
                          <td className="py-2 font-medium">{ROUTING_LABELS[r.routing] ?? r.routing}</td>
                          <td className="py-2 text-right">{r.invoiceCount}</td>
                          <td className="py-2 text-right text-blue-600">{fmt(r.totalCgst)}</td>
                          <td className="py-2 text-right text-purple-600">{fmt(r.totalSgst)}</td>
                          <td className="py-2 text-right text-orange-600">{fmt(r.totalIgst)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </CardContent>
              </Card>

              {/* By State */}
              {summary.byStateOfSupply.length > 0 && (
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">GST by State of Supply</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b text-muted-foreground">
                          <th className="pb-2 text-left">State</th>
                          <th className="pb-2 text-right">Invoices</th>
                          <th className="pb-2 text-right">Total</th>
                          <th className="pb-2 text-right">CGST</th>
                          <th className="pb-2 text-right">SGST</th>
                          <th className="pb-2 text-right">IGST</th>
                        </tr>
                      </thead>
                      <tbody>
                        {summary.byStateOfSupply.map(r => (
                          <tr key={r.stateOfSupply} className="border-b last:border-0">
                            <td className="py-2 font-medium">{r.stateOfSupply}</td>
                            <td className="py-2 text-right">{r.invoiceCount}</td>
                            <td className="py-2 text-right">{fmt(r.totalAmount)}</td>
                            <td className="py-2 text-right text-blue-600">{fmt(r.totalCgst)}</td>
                            <td className="py-2 text-right text-purple-600">{fmt(r.totalSgst)}</td>
                            <td className="py-2 text-right text-orange-600">{fmt(r.totalIgst)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </CardContent>
                </Card>
              )}

              {/* GST Totals box */}
              <Card className="bg-green-50 border-green-200">
                <CardHeader>
                  <CardTitle className="text-base text-green-800">GSTR-1 Filing Summary</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                    <div>
                      <p className="text-xs text-green-700">Taxable Turnover</p>
                      <p className="text-lg font-bold text-green-900">{fmt(summary.overall.totalTaxable)}</p>
                    </div>
                    <div>
                      <p className="text-xs text-blue-700">CGST Collected</p>
                      <p className="text-lg font-bold text-blue-900">{fmt(summary.overall.totalCgst)}</p>
                    </div>
                    <div>
                      <p className="text-xs text-purple-700">SGST Collected</p>
                      <p className="text-lg font-bold text-purple-900">{fmt(summary.overall.totalSgst)}</p>
                    </div>
                    <div>
                      <p className="text-xs text-orange-700">IGST Collected</p>
                      <p className="text-lg font-bold text-orange-900">{fmt(summary.overall.totalIgst)}</p>
                    </div>
                  </div>
                  <div className="mt-3 pt-3 border-t border-green-200">
                    <p className="text-xs text-green-700">Total Tax Liability</p>
                    <p className="text-2xl font-bold text-green-900">
                      {new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(totalGstCollected)}
                    </p>
                  </div>
                </CardContent>
              </Card>
            </div>
          ) : (
            <div className="text-center py-16 text-muted-foreground">
              No GST data available for this period.
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
