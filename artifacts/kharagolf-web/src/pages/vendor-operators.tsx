import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Building2, Plus, Edit2, Trash2, FileText, RefreshCw,
  ChevronRight, CheckCircle2, AlertTriangle,
  Send, Link2, Receipt,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useToast } from '@/hooks/use-toast';
import { useActiveOrgId } from '@/context/ActiveOrgContext';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';

const GOLD = '#C9A84C';

const CONTRACT_STATUS_COLORS: Record<string, string> = {
  active: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30',
  expired: 'bg-amber-500/20 text-amber-300 border-amber-500/30',
  terminated: 'bg-red-500/20 text-red-300 border-red-500/30',
  draft: 'bg-white/10 text-white/60',
};

const INVOICE_STATUS_COLORS: Record<string, string> = {
  unpaid: 'bg-amber-500/20 text-amber-300 border-amber-500/30',
  paid: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30',
  overdue: 'bg-red-500/20 text-red-300 border-red-500/30',
  cancelled: 'bg-white/10 text-white/60',
};

const ALERT_LEVEL_COLORS: Record<string, string> = {
  critical: 'bg-red-500/20 text-red-300 border-red-500/30',
  warning: 'bg-amber-500/20 text-amber-300 border-amber-500/30',
  info: 'bg-blue-500/20 text-blue-300 border-blue-500/30',
};

const FACILITY_LABELS: Record<string, string> = {
  pro_shop: 'Pro Shop',
  f_and_b: 'F&B',
  driving_range: 'Driving Range',
  other: 'Other',
};

const BILLING_MODEL_LABELS: Record<string, string> = {
  fixed: 'Fixed Fee',
  revenue_share: 'Revenue Share',
  hybrid: 'Hybrid (Fixed + Rev Share)',
};

interface VendorOperator {
  id: number;
  name: string;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  address: string | null;
  gstin: string | null;
  bankAccountName: string | null;
  bankAccountNumber: string | null;
  bankIfsc: string | null;
  notes: string | null;
  isActive: boolean;
  createdAt: string;
  activeContract: VendorContract | null;
}

interface VendorContract {
  id: number;
  billingModel: string;
  fixedFeeAmount: string;
  revenueSharePct: string;
  revenueShareThreshold: string | null;
  billingFrequency: string;
  contractStartDate: string;
  contractEndDate: string | null;
  noticePeriodDays: number;
  autoRenewal: boolean;
  status: string;
  terminationReason: string | null;
  previousContractId: number | null;
  notes: string | null;
  createdAt: string;
}

interface VendorFacilityAssignment {
  id: number;
  facilityType: string;
  facilityName: string | null;
  isActive: boolean;
  assignedAt: string;
}

interface VendorBillingCycle {
  id: number;
  periodStart: string;
  periodEnd: string;
  grossSales: string;
  memberChargesTotal: string;
  revenueShareAmount: string;
  fixedFeeAmount: string;
  netAmountDue: string;
  currency: string;
}

interface VendorInvoice {
  id: number;
  invoiceNumber: string;
  status: string;
  totalAmount: string;
  currency: string;
  dueDate: string | null;
  paidAt: string | null;
  paymentMethod: string | null;
  razorpayPaymentLinkUrl: string | null;
  sentAt: string | null;
  notes: string | null;
  createdAt: string;
  vendorBillingCycleId: number | null;
}

interface RenewalAlert {
  contractId: number;
  vendorId: number;
  vendorName: string;
  contractEndDate: string | null;
  daysLeft: number | null;
  autoRenewal: boolean;
  alertLevel: string;
}

function formatDate(d: string | null | undefined): string {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

function formatCurrency(val: string | number | null | undefined): string {
  if (val == null) return '—';
  return `₹${parseFloat(String(val)).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
}

async function apiCall(url: string, method: string, body?: unknown, toast?: (p: { title: string; description?: string; variant?: 'destructive' }) => void): Promise<unknown> {
  const r = await fetch(url, {
    method,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) {
    const e = await r.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(e.error || 'Request failed');
  }
  return r.json();
}

// ─── Sub-components ────────────────────────────────────────────────────────────

function VendorForm({ onClose, initial, base, invalidate }: {
  onClose: () => void;
  initial?: VendorOperator;
  base: string;
  invalidate: () => void;
}) {
  const { toast } = useToast();
  const [form, setForm] = useState({
    name: initial?.name ?? '',
    contactName: initial?.contactName ?? '',
    contactEmail: initial?.contactEmail ?? '',
    contactPhone: initial?.contactPhone ?? '',
    address: initial?.address ?? '',
    gstin: initial?.gstin ?? '',
    bankAccountName: initial?.bankAccountName ?? '',
    bankAccountNumber: initial?.bankAccountNumber ?? '',
    bankIfsc: initial?.bankIfsc ?? '',
    notes: initial?.notes ?? '',
  });
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!form.name) return;
    setSaving(true);
    try {
      if (initial) {
        await apiCall(`${base}/${initial.id}`, 'PATCH', form);
        toast({ title: 'Vendor updated' });
      } else {
        await apiCall(base, 'POST', form);
        toast({ title: 'Vendor created' });
      }
      invalidate();
      onClose();
    } catch (err) { toast({ title: 'Error', description: String(err instanceof Error ? err.message : err), variant: 'destructive' }); }
    finally { setSaving(false); }
  };

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1 col-span-2">
          <Label className="text-white/70 text-xs">Vendor Name *</Label>
          <Input className="bg-white/5 border-white/10 text-white" value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))} placeholder="e.g. Adidas Golf Solutions" />
        </div>
        <div className="space-y-1">
          <Label className="text-white/70 text-xs">Contact Name</Label>
          <Input className="bg-white/5 border-white/10 text-white" value={form.contactName} onChange={e => setForm(p => ({ ...p, contactName: e.target.value }))} />
        </div>
        <div className="space-y-1">
          <Label className="text-white/70 text-xs">Email</Label>
          <Input className="bg-white/5 border-white/10 text-white" value={form.contactEmail} onChange={e => setForm(p => ({ ...p, contactEmail: e.target.value }))} type="email" />
        </div>
        <div className="space-y-1">
          <Label className="text-white/70 text-xs">Phone</Label>
          <Input className="bg-white/5 border-white/10 text-white" value={form.contactPhone} onChange={e => setForm(p => ({ ...p, contactPhone: e.target.value }))} />
        </div>
        <div className="space-y-1">
          <Label className="text-white/70 text-xs">GSTIN</Label>
          <Input className="bg-white/5 border-white/10 text-white" value={form.gstin} onChange={e => setForm(p => ({ ...p, gstin: e.target.value }))} />
        </div>
        <div className="space-y-1 col-span-2">
          <Label className="text-white/70 text-xs">Address</Label>
          <Textarea className="bg-white/5 border-white/10 text-white resize-none" value={form.address} onChange={e => setForm(p => ({ ...p, address: e.target.value }))} rows={2} />
        </div>
        <div className="space-y-1">
          <Label className="text-white/70 text-xs">Bank Account Name</Label>
          <Input className="bg-white/5 border-white/10 text-white" value={form.bankAccountName} onChange={e => setForm(p => ({ ...p, bankAccountName: e.target.value }))} />
        </div>
        <div className="space-y-1">
          <Label className="text-white/70 text-xs">Account Number</Label>
          <Input className="bg-white/5 border-white/10 text-white" value={form.bankAccountNumber} onChange={e => setForm(p => ({ ...p, bankAccountNumber: e.target.value }))} />
        </div>
        <div className="space-y-1">
          <Label className="text-white/70 text-xs">IFSC Code</Label>
          <Input className="bg-white/5 border-white/10 text-white" value={form.bankIfsc} onChange={e => setForm(p => ({ ...p, bankIfsc: e.target.value }))} />
        </div>
        <div className="space-y-1">
          <Label className="text-white/70 text-xs">Notes</Label>
          <Input className="bg-white/5 border-white/10 text-white" value={form.notes} onChange={e => setForm(p => ({ ...p, notes: e.target.value }))} />
        </div>
      </div>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose} className="text-white/60">Cancel</Button>
        <Button onClick={save} disabled={saving || !form.name} style={{ backgroundColor: GOLD, color: '#0a0a0a' }}>
          {saving ? 'Saving...' : initial ? 'Save Changes' : 'Create Vendor'}
        </Button>
      </DialogFooter>
    </div>
  );
}

function ContractForm({ onClose, initial, vendorId, base, invalidate }: {
  onClose: () => void;
  initial?: VendorContract & { previousContractId?: number | null };
  vendorId: number;
  base: string;
  invalidate: () => void;
}) {
  const { toast } = useToast();
  const [form, setForm] = useState({
    billingModel: initial?.billingModel ?? 'fixed',
    fixedFeeAmount: initial?.fixedFeeAmount ?? '0',
    revenueSharePct: initial?.revenueSharePct ?? '0',
    revenueShareThreshold: initial?.revenueShareThreshold ?? '',
    billingFrequency: initial?.billingFrequency ?? 'monthly',
    contractStartDate: initial ? initial.contractStartDate.slice(0, 10) : new Date().toISOString().slice(0, 10),
    contractEndDate: initial?.contractEndDate ? initial.contractEndDate.slice(0, 10) : '',
    noticePeriodDays: String(initial?.noticePeriodDays ?? 30),
    autoRenewal: initial?.autoRenewal ?? false,
    notes: initial?.notes ?? '',
  });
  const [saving, setSaving] = useState(false);
  const isRenew = initial && initial.id === -1;

  const save = async () => {
    setSaving(true);
    try {
      const payload = {
        ...form,
        fixedFeeAmount: parseFloat(form.fixedFeeAmount) || 0,
        revenueSharePct: parseFloat(form.revenueSharePct) || 0,
        revenueShareThreshold: form.revenueShareThreshold ? parseFloat(form.revenueShareThreshold) : null,
        noticePeriodDays: parseInt(form.noticePeriodDays) || 30,
        contractEndDate: form.contractEndDate || null,
      };
      if (isRenew && initial?.previousContractId) {
        await apiCall(`${base}/${vendorId}/contracts/${initial.previousContractId}/renew`, 'POST', payload);
        toast({ title: 'Contract renewed' });
      } else if (initial && initial.id > 0) {
        await apiCall(`${base}/${vendorId}/contracts/${initial.id}`, 'PATCH', payload);
        toast({ title: 'Contract updated' });
      } else {
        await apiCall(`${base}/${vendorId}/contracts`, 'POST', payload);
        toast({ title: 'Contract created' });
      }
      invalidate();
      onClose();
    } catch (err) { toast({ title: 'Error', description: String(err instanceof Error ? err.message : err), variant: 'destructive' }); }
    finally { setSaving(false); }
  };

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1 col-span-2">
          <Label className="text-white/70 text-xs">Billing Model</Label>
          <Select value={form.billingModel} onValueChange={v => setForm(p => ({ ...p, billingModel: v }))}>
            <SelectTrigger className="bg-white/5 border-white/10 text-white"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="fixed">Fixed Fee</SelectItem>
              <SelectItem value="revenue_share">Revenue Share</SelectItem>
              <SelectItem value="hybrid">Hybrid (Fixed + Rev Share)</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {(form.billingModel === 'fixed' || form.billingModel === 'hybrid') && (
          <div className="space-y-1">
            <Label className="text-white/70 text-xs">Fixed Fee (₹)</Label>
            <Input className="bg-white/5 border-white/10 text-white" type="number" value={form.fixedFeeAmount} onChange={e => setForm(p => ({ ...p, fixedFeeAmount: e.target.value }))} />
          </div>
        )}
        {(form.billingModel === 'revenue_share' || form.billingModel === 'hybrid') && (
          <div className="space-y-1">
            <Label className="text-white/70 text-xs">Revenue Share %</Label>
            <Input className="bg-white/5 border-white/10 text-white" type="number" value={form.revenueSharePct} onChange={e => setForm(p => ({ ...p, revenueSharePct: e.target.value }))} />
          </div>
        )}
        {form.billingModel === 'hybrid' && (
          <div className="space-y-1">
            <Label className="text-white/70 text-xs">Rev Share Threshold (₹)</Label>
            <Input className="bg-white/5 border-white/10 text-white" type="number" value={form.revenueShareThreshold} onChange={e => setForm(p => ({ ...p, revenueShareThreshold: e.target.value }))} />
          </div>
        )}
        <div className="space-y-1">
          <Label className="text-white/70 text-xs">Billing Frequency</Label>
          <Select value={form.billingFrequency} onValueChange={v => setForm(p => ({ ...p, billingFrequency: v }))}>
            <SelectTrigger className="bg-white/5 border-white/10 text-white"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="monthly">Monthly</SelectItem>
              <SelectItem value="annual">Annual</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-white/70 text-xs">Start Date</Label>
          <Input className="bg-white/5 border-white/10 text-white" type="date" value={form.contractStartDate} onChange={e => setForm(p => ({ ...p, contractStartDate: e.target.value }))} />
        </div>
        <div className="space-y-1">
          <Label className="text-white/70 text-xs">End Date</Label>
          <Input className="bg-white/5 border-white/10 text-white" type="date" value={form.contractEndDate} onChange={e => setForm(p => ({ ...p, contractEndDate: e.target.value }))} />
        </div>
        <div className="space-y-1">
          <Label className="text-white/70 text-xs">Notice Period (days)</Label>
          <Input className="bg-white/5 border-white/10 text-white" type="number" value={form.noticePeriodDays} onChange={e => setForm(p => ({ ...p, noticePeriodDays: e.target.value }))} />
        </div>
        <div className="flex items-center gap-2 mt-4">
          <Checkbox id="autoRenewal" checked={form.autoRenewal} onCheckedChange={v => setForm(p => ({ ...p, autoRenewal: !!v }))} />
          <Label htmlFor="autoRenewal" className="text-white/70 text-sm">Auto Renewal</Label>
        </div>
        <div className="space-y-1 col-span-2">
          <Label className="text-white/70 text-xs">Notes</Label>
          <Textarea className="bg-white/5 border-white/10 text-white resize-none" value={form.notes} onChange={e => setForm(p => ({ ...p, notes: e.target.value }))} rows={2} />
        </div>
      </div>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose} className="text-white/60">Cancel</Button>
        <Button onClick={save} disabled={saving} style={{ backgroundColor: GOLD, color: '#0a0a0a' }}>
          {saving ? 'Saving...' : isRenew ? 'Renew Contract' : initial ? 'Save Changes' : 'Create Contract'}
        </Button>
      </DialogFooter>
    </div>
  );
}

function AssignmentForm({ onClose, vendorId, base, invalidate }: {
  onClose: () => void;
  vendorId: number;
  base: string;
  invalidate: () => void;
}) {
  const { toast } = useToast();
  const [facilityType, setFacilityType] = useState('pro_shop');
  const [facilityName, setFacilityName] = useState('');
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      await apiCall(`${base}/${vendorId}/assignments`, 'POST', { facilityType, facilityName: facilityName || null });
      toast({ title: 'Facility assigned' });
      invalidate();
      onClose();
    } catch (err) { toast({ title: 'Error', description: String(err instanceof Error ? err.message : err), variant: 'destructive' }); }
    finally { setSaving(false); }
  };

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <Label className="text-white/70 text-xs">Facility Type</Label>
        <Select value={facilityType} onValueChange={setFacilityType}>
          <SelectTrigger className="bg-white/5 border-white/10 text-white"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="pro_shop">Pro Shop</SelectItem>
            <SelectItem value="f_and_b">F&B</SelectItem>
            <SelectItem value="driving_range">Driving Range</SelectItem>
            <SelectItem value="other">Other</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1">
        <Label className="text-white/70 text-xs">Custom Name (optional)</Label>
        <Input className="bg-white/5 border-white/10 text-white" value={facilityName} onChange={e => setFacilityName(e.target.value)} placeholder="e.g. Main Pro Shop" />
      </div>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose} className="text-white/60">Cancel</Button>
        <Button onClick={save} disabled={saving} style={{ backgroundColor: GOLD, color: '#0a0a0a' }}>
          {saving ? 'Saving...' : 'Assign'}
        </Button>
      </DialogFooter>
    </div>
  );
}

function TerminateForm({ onClose, contractId, vendorId, base, invalidate }: {
  onClose: () => void;
  contractId: number;
  vendorId: number;
  base: string;
  invalidate: () => void;
}) {
  const { toast } = useToast();
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      await apiCall(`${base}/${vendorId}/contracts/${contractId}/terminate`, 'POST', { terminationReason: reason || null });
      toast({ title: 'Contract terminated' });
      invalidate();
      onClose();
    } catch (err) { toast({ title: 'Error', description: String(err instanceof Error ? err.message : err), variant: 'destructive' }); }
    finally { setSaving(false); }
  };

  return (
    <div className="space-y-3">
      <p className="text-white/60 text-sm">Are you sure you want to terminate this contract?</p>
      <div className="space-y-1">
        <Label className="text-white/70 text-xs">Reason (optional)</Label>
        <Textarea className="bg-white/5 border-white/10 text-white resize-none" value={reason} onChange={e => setReason(e.target.value)} rows={3} />
      </div>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose} className="text-white/60">Cancel</Button>
        <Button onClick={save} disabled={saving} variant="destructive">
          {saving ? 'Terminating...' : 'Terminate Contract'}
        </Button>
      </DialogFooter>
    </div>
  );
}

function GenerateCycleForm({ onClose, vendorId, contracts, base, invalidate, onGenerated }: {
  onClose: () => void;
  vendorId: number;
  contracts: VendorContract[];
  base: string;
  invalidate: () => void;
  onGenerated?: (cycle: VendorBillingCycle) => void;
}) {
  const { toast } = useToast();
  const now = new Date();
  const firstOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const lastOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  const [contractId, setContractId] = useState('');
  const [periodStart, setPeriodStart] = useState(firstOfMonth.toISOString().slice(0, 10));
  const [periodEnd, setPeriodEnd] = useState(lastOfMonth.toISOString().slice(0, 10));
  const [saving, setSaving] = useState(false);

  const activeContracts = contracts.filter(c => c.status === 'active');

  const save = async () => {
    if (!contractId || !periodStart || !periodEnd) return;
    setSaving(true);
    try {
      const cycle = await apiCall(`${base}/${vendorId}/billing-cycles`, 'POST', {
        contractId: parseInt(contractId), periodStart, periodEnd,
      }) as VendorBillingCycle;
      toast({ title: 'Billing cycle generated', description: `Net due: ${formatCurrency(cycle.netAmountDue)}` });
      invalidate();
      onGenerated?.(cycle);
      onClose();
    } catch (err) { toast({ title: 'Error', description: String(err instanceof Error ? err.message : err), variant: 'destructive' }); }
    finally { setSaving(false); }
  };

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <Label className="text-white/70 text-xs">Contract</Label>
        <Select value={contractId} onValueChange={setContractId}>
          <SelectTrigger className="bg-white/5 border-white/10 text-white"><SelectValue placeholder="Select contract" /></SelectTrigger>
          <SelectContent>
            {activeContracts.map(c => (
              <SelectItem key={c.id} value={String(c.id)}>
                {BILLING_MODEL_LABELS[c.billingModel]} · since {formatDate(c.contractStartDate)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label className="text-white/70 text-xs">Period Start</Label>
          <Input className="bg-white/5 border-white/10 text-white" type="date" value={periodStart} onChange={e => setPeriodStart(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label className="text-white/70 text-xs">Period End</Label>
          <Input className="bg-white/5 border-white/10 text-white" type="date" value={periodEnd} onChange={e => setPeriodEnd(e.target.value)} />
        </div>
      </div>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose} className="text-white/60">Cancel</Button>
        <Button onClick={save} disabled={saving || !contractId} style={{ backgroundColor: GOLD, color: '#0a0a0a' }}>
          {saving ? 'Generating...' : 'Generate'}
        </Button>
      </DialogFooter>
    </div>
  );
}

function CreateInvoiceForm({ onClose, vendorId, cycle, base, invalidate, onCreated }: {
  onClose: () => void;
  vendorId: number;
  cycle?: VendorBillingCycle | null;
  base: string;
  invalidate: () => void;
  onCreated?: () => void;
}) {
  const { toast } = useToast();
  const [totalAmount, setTotalAmount] = useState(cycle?.netAmountDue ? parseFloat(cycle.netAmountDue).toFixed(2) : '');
  const [dueDate, setDueDate] = useState('');
  const [notes, setNotes] = useState('');
  const [createPaymentLink, setCreatePaymentLink] = useState(false);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!totalAmount) return;
    setSaving(true);
    try {
      const inv = await apiCall(`${base}/${vendorId}/invoices`, 'POST', {
        vendorBillingCycleId: cycle?.id ?? null,
        totalAmount: parseFloat(totalAmount),
        dueDate: dueDate || null,
        notes: notes || null,
        createPaymentLink,
      }) as VendorInvoice;
      toast({ title: 'Invoice created', description: inv.invoiceNumber });
      invalidate();
      onCreated?.();
      onClose();
    } catch (err) { toast({ title: 'Error', description: String(err instanceof Error ? err.message : err), variant: 'destructive' }); }
    finally { setSaving(false); }
  };

  return (
    <div className="space-y-3">
      {cycle && (
        <div className="bg-white/5 rounded-lg p-3 text-sm">
          <span className="text-white/50">For billing cycle: </span>
          <span className="text-white">{formatDate(cycle.periodStart)} — {formatDate(cycle.periodEnd)}</span>
        </div>
      )}
      <div className="space-y-1">
        <Label className="text-white/70 text-xs">Total Amount (₹)</Label>
        <Input className="bg-white/5 border-white/10 text-white" type="number" value={totalAmount} onChange={e => setTotalAmount(e.target.value)} />
      </div>
      <div className="space-y-1">
        <Label className="text-white/70 text-xs">Due Date</Label>
        <Input className="bg-white/5 border-white/10 text-white" type="date" value={dueDate} onChange={e => setDueDate(e.target.value)} />
      </div>
      <div className="space-y-1">
        <Label className="text-white/70 text-xs">Notes</Label>
        <Textarea className="bg-white/5 border-white/10 text-white resize-none" value={notes} onChange={e => setNotes(e.target.value)} rows={2} />
      </div>
      <div className="flex items-center gap-2">
        <Checkbox id="createLink" checked={createPaymentLink} onCheckedChange={v => setCreatePaymentLink(!!v)} />
        <Label htmlFor="createLink" className="text-white/70 text-sm">Create Razorpay payment link</Label>
      </div>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose} className="text-white/60">Cancel</Button>
        <Button onClick={save} disabled={saving || !totalAmount} style={{ backgroundColor: GOLD, color: '#0a0a0a' }}>
          {saving ? 'Creating...' : 'Create Invoice'}
        </Button>
      </DialogFooter>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function VendorOperatorsPage() {
  const orgId = useActiveOrgId();
  const qc = useQueryClient();
  const { toast } = useToast();

  const [selectedVendorId, setSelectedVendorId] = useState<number | null>(null);
  const [vendorTab, setVendorTab] = useState('overview');
  const [showAddVendor, setShowAddVendor] = useState(false);
  const [showEditVendor, setShowEditVendor] = useState<VendorOperator | null>(null);
  const [showAddAssignment, setShowAddAssignment] = useState(false);
  const [showAddContract, setShowAddContract] = useState(false);
  const [showEditContract, setShowEditContract] = useState<VendorContract | null>(null);
  const [showTerminate, setShowTerminate] = useState<number | null>(null);
  const [showRenew, setShowRenew] = useState<VendorContract | null>(null);
  const [showGenerateCycle, setShowGenerateCycle] = useState(false);
  const [showCreateInvoice, setShowCreateInvoice] = useState<VendorBillingCycle | null | false>(false);
  const [settlementCycleId, setSettlementCycleId] = useState<number | null>(null);
  const [showRenewalAlerts, setShowRenewalAlerts] = useState(false);

  const base = `/api/organizations/${orgId}/vendor-operators`;

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: [base] });
    if (selectedVendorId) {
      qc.invalidateQueries({ queryKey: [`${base}/${selectedVendorId}`] });
      qc.invalidateQueries({ queryKey: [`${base}/${selectedVendorId}/billing-cycles`] });
      qc.invalidateQueries({ queryKey: [`${base}/${selectedVendorId}/invoices`] });
    }
  };

  const { data: vendors = [], isLoading } = useQuery<VendorOperator[]>({
    queryKey: [base],
    queryFn: () => fetch(base, { credentials: 'include' }).then(r => r.json()),
    enabled: !!orgId,
  });

  const selectedVendor = vendors.find(v => v.id === selectedVendorId) ?? null;

  const { data: vendorDetail } = useQuery<VendorOperator & { assignments: VendorFacilityAssignment[]; contracts: VendorContract[] }>({
    queryKey: [`${base}/${selectedVendorId}`],
    queryFn: () => fetch(`${base}/${selectedVendorId}`, { credentials: 'include' }).then(r => r.json()),
    enabled: !!selectedVendorId && !!orgId,
  });

  const { data: billingCycles = [] } = useQuery<VendorBillingCycle[]>({
    queryKey: [`${base}/${selectedVendorId}/billing-cycles`],
    queryFn: () => fetch(`${base}/${selectedVendorId}/billing-cycles`, { credentials: 'include' }).then(r => r.json()),
    enabled: !!selectedVendorId && !!orgId && vendorTab === 'billing',
  });

  const { data: invoices = [] } = useQuery<VendorInvoice[]>({
    queryKey: [`${base}/${selectedVendorId}/invoices`],
    queryFn: () => fetch(`${base}/${selectedVendorId}/invoices`, { credentials: 'include' }).then(r => r.json()),
    enabled: !!selectedVendorId && !!orgId && vendorTab === 'invoices',
  });

  const { data: settlementReport } = useQuery({
    queryKey: [`${base}/${selectedVendorId}/billing-cycles/${settlementCycleId}/settlement`],
    queryFn: () =>
      fetch(`${base}/${selectedVendorId}/billing-cycles/${settlementCycleId}/settlement`, { credentials: 'include' }).then(r => r.json()),
    enabled: !!selectedVendorId && !!settlementCycleId && !!orgId,
  });

  const { data: renewalAlerts = [] } = useQuery<RenewalAlert[]>({
    queryKey: [`${base}/renewal-alerts`],
    queryFn: () => fetch(`${base}/renewal-alerts`, { credentials: 'include' }).then(r => r.json()),
    enabled: !!orgId && showRenewalAlerts,
  });

  const { data: vendorStaff = [] } = useQuery<Array<{
    membershipId: number; userId: number; role: string; vendorOperatorId: number;
    joinedAt: string; displayName: string | null; email: string | null;
  }>>({
    queryKey: [`${base}/${selectedVendorId}/staff`],
    queryFn: () => fetch(`${base}/${selectedVendorId}/staff`, { credentials: 'include' }).then(r => r.json()),
    enabled: !!selectedVendorId && !!orgId && vendorTab === 'staff',
  });

  function showErr(err: unknown) {
    toast({ title: 'Error', description: String(err instanceof Error ? err.message : err), variant: 'destructive' });
  }

  const isSettlementView = vendorTab === 'settlement' && settlementCycleId && settlementReport;

  return (
    <div className="min-h-screen bg-background text-white p-6">
      <div className="max-w-7xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-white">Vendor Operators</h1>
            <p className="text-white/50 text-sm mt-1">Manage third-party pro shop operators, contracts, and billing</p>
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={() => setShowRenewalAlerts(true)}
              className="border-amber-500/30 text-amber-300 hover:bg-amber-500/10"
            >
              <AlertTriangle className="w-4 h-4 mr-2" />
              Renewal Alerts
            </Button>
            <Button onClick={() => setShowAddVendor(true)} style={{ backgroundColor: GOLD, color: '#0a0a0a' }}>
              <Plus className="w-4 h-4 mr-2" />
              Add Vendor
            </Button>
          </div>
        </div>

        <div className="grid grid-cols-12 gap-4">
          {/* Vendor List */}
          <div className="col-span-4 space-y-2">
            {isLoading ? (
              <div className="text-white/40 text-sm p-4">Loading vendors...</div>
            ) : vendors.length === 0 ? (
              <Card className="bg-white/5 border-white/10">
                <CardContent className="p-6 text-center text-white/40">
                  <Building2 className="w-8 h-8 mx-auto mb-2 opacity-40" />
                  <p className="text-sm">No vendor operators yet</p>
                  <Button onClick={() => setShowAddVendor(true)} size="sm" className="mt-3" style={{ backgroundColor: GOLD, color: '#0a0a0a' }}>
                    Add First Vendor
                  </Button>
                </CardContent>
              </Card>
            ) : vendors.map(v => (
              <Card
                key={v.id}
                onClick={() => { setSelectedVendorId(v.id); setVendorTab('overview'); setSettlementCycleId(null); }}
                className={`cursor-pointer transition-all border ${selectedVendorId === v.id ? 'border-amber-500/50 bg-amber-500/5' : 'border-white/10 bg-white/5 hover:border-white/20'}`}
              >
                <CardContent className="p-4">
                  <div className="flex items-start justify-between">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-white">{v.name}</span>
                        {!v.isActive && <Badge variant="outline" className="text-xs text-white/40 border-white/20">Inactive</Badge>}
                      </div>
                      {v.contactEmail && <p className="text-white/50 text-xs mt-0.5">{v.contactEmail}</p>}
                    </div>
                    <div className="flex items-center gap-2">
                      {v.activeContract && (
                        <Badge variant="outline" className={`text-xs border ${CONTRACT_STATUS_COLORS[v.activeContract.status]}`}>
                          {v.activeContract.status}
                        </Badge>
                      )}
                      <ChevronRight className="w-4 h-4 text-white/30" />
                    </div>
                  </div>
                  {v.activeContract && (
                    <p className="text-white/40 text-xs mt-2">
                      {BILLING_MODEL_LABELS[v.activeContract.billingModel]} · {v.activeContract.billingFrequency}
                    </p>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>

          {/* Vendor Detail */}
          <div className="col-span-8">
            {!selectedVendor ? (
              <Card className="bg-white/5 border-white/10 h-full flex items-center justify-center">
                <CardContent className="text-center text-white/30 p-12">
                  <Building2 className="w-12 h-12 mx-auto mb-3 opacity-20" />
                  <p>Select a vendor to view details</p>
                </CardContent>
              </Card>
            ) : (
              <Card className="bg-white/5 border-white/10">
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <CardTitle className="text-white text-lg">{selectedVendor.name}</CardTitle>
                      {selectedVendor.contactEmail && <p className="text-white/50 text-sm">{selectedVendor.contactEmail}</p>}
                    </div>
                    <div className="flex gap-2">
                      <Button size="sm" variant="ghost" onClick={() => setShowEditVendor(selectedVendor)} className="text-white/60 hover:text-white">
                        <Edit2 className="w-4 h-4" />
                      </Button>
                      <Button size="sm" variant="ghost" onClick={async () => {
                        try {
                          await apiCall(`${base}/${selectedVendor.id}`, 'DELETE');
                          toast({ title: 'Vendor deactivated' });
                          setSelectedVendorId(null);
                          invalidate();
                        } catch (err) { showErr(err); }
                      }} className="text-red-400 hover:text-red-300">
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                  </div>
                </CardHeader>
                <CardContent>
                  <Tabs value={vendorTab} onValueChange={v => { if (v !== 'settlement') { setVendorTab(v); setSettlementCycleId(null); } }}>
                    <TabsList className="bg-white/5 mb-4">
                      <TabsTrigger value="overview" className="data-[state=active]:text-black data-[state=active]:bg-amber-400">Overview</TabsTrigger>
                      <TabsTrigger value="contracts" className="data-[state=active]:text-black data-[state=active]:bg-amber-400">Contracts</TabsTrigger>
                      <TabsTrigger value="billing" className="data-[state=active]:text-black data-[state=active]:bg-amber-400">Billing</TabsTrigger>
                      <TabsTrigger value="invoices" className="data-[state=active]:text-black data-[state=active]:bg-amber-400">Invoices</TabsTrigger>
                      <TabsTrigger value="staff" className="data-[state=active]:text-black data-[state=active]:bg-amber-400">Staff</TabsTrigger>
                    </TabsList>

                    {/* ── Overview ── */}
                    <TabsContent value="overview" className="space-y-4">
                      <div className="grid grid-cols-2 gap-3 text-sm">
                        <div className="bg-white/5 rounded-lg p-3">
                          <div className="text-white/50 text-xs mb-1">Contact</div>
                          <div className="text-white">{selectedVendor.contactName || '—'}</div>
                          <div className="text-white/60 text-xs">{selectedVendor.contactPhone || ''}</div>
                        </div>
                        <div className="bg-white/5 rounded-lg p-3">
                          <div className="text-white/50 text-xs mb-1">GSTIN</div>
                          <div className="text-white font-mono text-sm">{selectedVendor.gstin || '—'}</div>
                        </div>
                        <div className="bg-white/5 rounded-lg p-3 col-span-2">
                          <div className="text-white/50 text-xs mb-1">Address</div>
                          <div className="text-white">{selectedVendor.address || '—'}</div>
                        </div>
                        {selectedVendor.bankAccountName && (
                          <div className="bg-white/5 rounded-lg p-3 col-span-2">
                            <div className="text-white/50 text-xs mb-1">Bank Details</div>
                            <div className="text-white">{selectedVendor.bankAccountName}</div>
                            <div className="text-white/60 text-xs font-mono">{selectedVendor.bankAccountNumber} · IFSC: {selectedVendor.bankIfsc}</div>
                          </div>
                        )}
                      </div>

                      {/* Facility Assignments */}
                      <div>
                        <div className="flex items-center justify-between mb-2">
                          <h3 className="text-white/70 text-sm font-medium">Facility Assignments</h3>
                          <Button size="sm" variant="ghost" onClick={() => setShowAddAssignment(true)} className="text-amber-400 hover:text-amber-300 h-7 text-xs">
                            <Plus className="w-3 h-3 mr-1" /> Assign Facility
                          </Button>
                        </div>
                        <div className="space-y-2">
                          {(vendorDetail?.assignments ?? []).filter(a => a.isActive).map(a => (
                            <div key={a.id} className="flex items-center justify-between bg-white/5 rounded-lg px-3 py-2">
                              <div>
                                <span className="text-white text-sm">{a.facilityName || FACILITY_LABELS[a.facilityType]}</span>
                                <Badge variant="outline" className="ml-2 text-xs border-white/20 text-white/50">{FACILITY_LABELS[a.facilityType]}</Badge>
                              </div>
                              <Button size="sm" variant="ghost" className="h-6 text-xs text-red-400 hover:text-red-300" onClick={async () => {
                                try {
                                  await apiCall(`${base}/${selectedVendorId}/assignments/${a.id}`, 'DELETE');
                                  toast({ title: 'Unassigned' });
                                  invalidate();
                                } catch (err) { showErr(err); }
                              }}>Remove</Button>
                            </div>
                          ))}
                          {(vendorDetail?.assignments ?? []).filter(a => a.isActive).length === 0 && (
                            <p className="text-white/30 text-xs p-2">No active facility assignments</p>
                          )}
                        </div>
                      </div>
                    </TabsContent>

                    {/* ── Contracts ── */}
                    <TabsContent value="contracts" className="space-y-4">
                      <div className="flex items-center justify-between mb-3">
                        <h3 className="text-white/70 text-sm font-medium">Contract History</h3>
                        <Button size="sm" onClick={() => setShowAddContract(true)} style={{ backgroundColor: GOLD, color: '#0a0a0a' }}>
                          <Plus className="w-3 h-3 mr-1" /> New Contract
                        </Button>
                      </div>
                      {(vendorDetail?.contracts ?? []).map(c => {
                        const endDate = c.contractEndDate ? new Date(c.contractEndDate) : null;
                        const now = new Date();
                        const daysLeft = endDate ? Math.ceil((endDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)) : null;
                        return (
                          <div key={c.id} className="bg-white/5 rounded-lg p-4 border border-white/10">
                            <div className="flex items-start justify-between">
                              <div>
                                <div className="flex items-center gap-2">
                                  <Badge variant="outline" className={`border text-xs ${CONTRACT_STATUS_COLORS[c.status]}`}>{c.status}</Badge>
                                  <span className="text-white/70 text-sm">{BILLING_MODEL_LABELS[c.billingModel]}</span>
                                </div>
                                <div className="text-white text-sm mt-1">
                                  {c.billingModel === 'fixed' && `₹${parseFloat(c.fixedFeeAmount).toLocaleString('en-IN')} / ${c.billingFrequency}`}
                                  {c.billingModel === 'revenue_share' && `${c.revenueSharePct}% of sales / ${c.billingFrequency}`}
                                  {c.billingModel === 'hybrid' && `₹${parseFloat(c.fixedFeeAmount).toLocaleString('en-IN')} + ${c.revenueSharePct}% above threshold`}
                                </div>
                                <div className="text-white/40 text-xs mt-1">
                                  {formatDate(c.contractStartDate)} → {c.contractEndDate ? formatDate(c.contractEndDate) : 'Open-ended'}
                                  {daysLeft != null && c.status === 'active' && (
                                    <span className={`ml-2 ${daysLeft <= 30 ? 'text-red-400' : daysLeft <= 60 ? 'text-amber-400' : 'text-white/40'}`}>
                                      ({daysLeft}d left)
                                    </span>
                                  )}
                                </div>
                                {c.autoRenewal && <div className="text-emerald-400 text-xs mt-1">Auto-renews</div>}
                                {c.terminationReason && <div className="text-red-400 text-xs mt-1">Reason: {c.terminationReason}</div>}
                              </div>
                              {c.status === 'active' && (
                                <div className="flex gap-2">
                                  <Button size="sm" variant="ghost" onClick={() => setShowEditContract(c)} className="text-white/50 hover:text-white h-7 text-xs">Edit</Button>
                                  <Button size="sm" variant="ghost" onClick={() => setShowRenew(c)} className="text-emerald-400 hover:text-emerald-300 h-7 text-xs">Renew</Button>
                                  <Button size="sm" variant="ghost" onClick={() => setShowTerminate(c.id)} className="text-red-400 hover:text-red-300 h-7 text-xs">Terminate</Button>
                                </div>
                              )}
                            </div>
                          </div>
                        );
                      })}
                      {(vendorDetail?.contracts ?? []).length === 0 && (
                        <p className="text-white/30 text-sm text-center py-8">No contracts yet</p>
                      )}
                    </TabsContent>

                    {/* ── Billing ── */}
                    <TabsContent value="billing" className="space-y-4">
                      <div className="flex items-center justify-between mb-3">
                        <h3 className="text-white/70 text-sm font-medium">Billing Cycles</h3>
                        <Button size="sm" onClick={() => setShowGenerateCycle(true)} style={{ backgroundColor: GOLD, color: '#0a0a0a' }}>
                          <RefreshCw className="w-3 h-3 mr-1" /> Generate Cycle
                        </Button>
                      </div>
                      {billingCycles.length === 0 ? (
                        <p className="text-white/30 text-sm text-center py-8">No billing cycles yet</p>
                      ) : billingCycles.map(cycle => (
                        <div key={cycle.id} className="bg-white/5 rounded-lg p-4 border border-white/10">
                          <div className="flex items-start justify-between">
                            <div>
                              <div className="text-white text-sm font-medium">{formatDate(cycle.periodStart)} — {formatDate(cycle.periodEnd)}</div>
                              <div className="grid grid-cols-3 gap-3 mt-2 text-xs">
                                <div>
                                  <div className="text-white/40">Gross Sales</div>
                                  <div className="text-white">{formatCurrency(cycle.grossSales)}</div>
                                </div>
                                <div>
                                  <div className="text-white/40">Member Charges</div>
                                  <div className="text-white">{formatCurrency(cycle.memberChargesTotal)}</div>
                                </div>
                                <div>
                                  <div className="text-white/40">Net Due</div>
                                  <div className="font-bold" style={{ color: GOLD }}>{formatCurrency(cycle.netAmountDue)}</div>
                                </div>
                              </div>
                            </div>
                            <div className="flex gap-2">
                              <Button size="sm" variant="ghost" onClick={() => { setSettlementCycleId(cycle.id); setVendorTab('settlement'); }} className="text-blue-400 hover:text-blue-300 h-7 text-xs">
                                <FileText className="w-3 h-3 mr-1" /> Report
                              </Button>
                              <Button size="sm" variant="ghost" onClick={() => setShowCreateInvoice(cycle)} className="text-amber-400 hover:text-amber-300 h-7 text-xs">
                                <Receipt className="w-3 h-3 mr-1" /> Invoice
                              </Button>
                            </div>
                          </div>
                        </div>
                      ))}
                    </TabsContent>

                    {/* ── Invoices ── */}
                    <TabsContent value="invoices" className="space-y-4">
                      <div className="flex items-center justify-between mb-3">
                        <h3 className="text-white/70 text-sm font-medium">Invoices</h3>
                        <Button size="sm" onClick={() => setShowCreateInvoice(null)} style={{ backgroundColor: GOLD, color: '#0a0a0a' }}>
                          <Plus className="w-3 h-3 mr-1" /> New Invoice
                        </Button>
                      </div>
                      {invoices.length === 0 ? (
                        <p className="text-white/30 text-sm text-center py-8">No invoices yet</p>
                      ) : invoices.map(inv => (
                        <div key={inv.id} className="bg-white/5 rounded-lg p-4 border border-white/10">
                          <div className="flex items-start justify-between">
                            <div>
                              <div className="flex items-center gap-2">
                                <span className="font-medium text-white font-mono text-sm">{inv.invoiceNumber}</span>
                                <Badge variant="outline" className={`border text-xs ${INVOICE_STATUS_COLORS[inv.status]}`}>{inv.status}</Badge>
                              </div>
                              <div className="text-white/70 text-sm mt-1">{formatCurrency(inv.totalAmount)}</div>
                              {inv.dueDate && <div className="text-white/40 text-xs">Due: {formatDate(inv.dueDate)}</div>}
                              {inv.paidAt && <div className="text-emerald-400 text-xs">Paid: {formatDate(inv.paidAt)}</div>}
                              {inv.razorpayPaymentLinkUrl && (
                                <a href={inv.razorpayPaymentLinkUrl} target="_blank" rel="noopener noreferrer" className="text-blue-400 text-xs hover:underline flex items-center gap-1 mt-1">
                                  <Link2 className="w-3 h-3" /> Payment Link
                                </a>
                              )}
                            </div>
                            <div className="flex gap-2">
                              {inv.status !== 'paid' && inv.status !== 'cancelled' && (
                                <>
                                  <Button size="sm" variant="ghost" onClick={async () => {
                                    try {
                                      await apiCall(`${base}/${selectedVendorId}/invoices/${inv.id}/payment-link`, 'POST');
                                      toast({ title: 'Payment link created' });
                                      invalidate();
                                    } catch (err) { showErr(err); }
                                  }} className="text-blue-400 hover:text-blue-300 h-7 text-xs">
                                    <Send className="w-3 h-3 mr-1" /> Link
                                  </Button>
                                  <Button size="sm" variant="ghost" onClick={async () => {
                                    try {
                                      await apiCall(`${base}/${selectedVendorId}/invoices/${inv.id}`, 'PATCH', { status: 'paid' });
                                      toast({ title: 'Invoice marked paid' });
                                      invalidate();
                                    } catch (err) { showErr(err); }
                                  }} className="text-emerald-400 hover:text-emerald-300 h-7 text-xs">
                                    <CheckCircle2 className="w-3 h-3 mr-1" /> Mark Paid
                                  </Button>
                                </>
                              )}
                            </div>
                          </div>
                        </div>
                      ))}
                    </TabsContent>

                    {/* ── Staff ── */}
                    <TabsContent value="staff" className="space-y-3">
                      <div className="flex items-center justify-between mb-1">
                        <p className="text-white/50 text-xs">
                          Staff assigned here get the <code className="bg-white/10 rounded px-1">pro_shop</code> role scoped to this vendor — they can process POS sales only for this vendor's facility.
                        </p>
                      </div>
                      {vendorStaff.length === 0 ? (
                        <div className="text-white/30 text-sm py-6 text-center border border-white/10 rounded-lg">
                          No staff assigned to this vendor yet.
                        </div>
                      ) : (
                        <div className="space-y-2">
                          {vendorStaff.map(s => (
                            <div key={s.userId} className="flex items-center justify-between bg-white/5 rounded-lg px-3 py-2">
                              <div>
                                <span className="text-white text-sm font-medium">{s.displayName ?? `User #${s.userId}`}</span>
                                {s.email && <span className="text-white/50 text-xs ml-2">{s.email}</span>}
                              </div>
                              <div className="flex items-center gap-3">
                                <Badge variant="outline" className="text-xs border-white/20 text-white/50">{s.role}</Badge>
                                <Button size="sm" variant="ghost" className="h-6 text-xs text-red-400 hover:text-red-300" onClick={async () => {
                                  try {
                                    await apiCall(`${base}/${selectedVendorId}/staff/${s.userId}`, 'DELETE');
                                    toast({ title: 'Staff unscoped from vendor' });
                                    qc.invalidateQueries({ queryKey: [`${base}/${selectedVendorId}/staff`] });
                                  } catch (err) { showErr(err); }
                                }}>Remove</Button>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </TabsContent>
                  </Tabs>
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      </div>

      {/* Settlement Report Full-Screen Overlay */}
      {isSettlementView && (
        <div className="fixed inset-0 z-50 bg-background overflow-auto p-6">
          <div className="max-w-4xl mx-auto">
            <div className="flex items-center justify-between mb-6">
              <div>
                <h2 className="text-xl font-bold text-white">Settlement Report</h2>
                <p className="text-white/50 text-sm">
                  {settlementReport.vendor?.name} · {formatDate(settlementReport.cycle?.periodStart)} to {formatDate(settlementReport.cycle?.periodEnd)}
                </p>
              </div>
              <div className="flex gap-2">
                <a
                  href={`/api/organizations/${orgId}/vendor-operators/${selectedVendorId}/billing-cycles/${settlementCycleId}/settlement/pdf`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <Button size="sm" variant="outline" className="border-white/20 text-white/70 hover:text-white">
                    <FileText className="w-4 h-4 mr-2" /> Download PDF
                  </Button>
                </a>
                <Button variant="ghost" onClick={() => { setVendorTab('billing'); setSettlementCycleId(null); }} className="text-white/60">
                  ← Back to Billing
                </Button>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4 mb-6">
              <Card className="bg-white/5 border-white/10">
                <CardContent className="p-4">
                  <div className="text-white/50 text-xs">POS Sales</div>
                  <div className="text-2xl font-bold text-white">{formatCurrency(settlementReport.posSales?.total)}</div>
                  <div className="text-white/30 text-xs">{settlementReport.posSales?.count} transactions</div>
                </CardContent>
              </Card>
              <Card className="bg-white/5 border-white/10">
                <CardContent className="p-4">
                  <div className="text-white/50 text-xs">Member Account Charges</div>
                  <div className="text-2xl font-bold text-white">{formatCurrency(settlementReport.memberCharges?.total)}</div>
                  <div className="text-white/30 text-xs">{settlementReport.memberCharges?.count} charges</div>
                </CardContent>
              </Card>
              <Card className="bg-white/5 border-white/10">
                <CardContent className="p-4">
                  <div className="text-white/50 text-xs">Billing Model</div>
                  <div className="text-white font-medium">
                    {settlementReport.billing?.billingModel ? BILLING_MODEL_LABELS[settlementReport.billing.billingModel] : '—'}
                  </div>
                  {(settlementReport.billing?.fixedFeeAmount ?? 0) > 0 && (
                    <div className="text-white/60 text-xs">Fixed: {formatCurrency(settlementReport.billing?.fixedFeeAmount)}</div>
                  )}
                  {(settlementReport.billing?.revenueShareAmount ?? 0) > 0 && (
                    <div className="text-white/60 text-xs">Rev Share: {formatCurrency(settlementReport.billing?.revenueShareAmount)}</div>
                  )}
                </CardContent>
              </Card>
              <Card className="bg-amber-500/10 border-amber-500/30">
                <CardContent className="p-4">
                  <div className="text-amber-300/70 text-xs">Net Amount Due</div>
                  <div className="text-2xl font-bold" style={{ color: GOLD }}>{formatCurrency(settlementReport.billing?.netAmountDue)}</div>
                  {(settlementReport.billing?.outstandingBalance ?? 0) > 0 && (
                    <>
                      <div className="text-amber-300/60 text-xs mt-1">+ Prior Outstanding: {formatCurrency(settlementReport.billing?.outstandingBalance)}</div>
                      <div className="text-amber-200 text-sm font-semibold mt-0.5">Total (inc. prior): {formatCurrency(settlementReport.billing?.totalWithOutstanding)}</div>
                    </>
                  )}
                  <div className="text-amber-300/40 text-xs mt-1">{settlementReport.billing?.currency}</div>
                </CardContent>
              </Card>
            </div>

            {/* Sales by Category Breakdown */}
            {settlementReport.posSales?.byCategory?.length > 0 && (
              <Card className="bg-white/5 border-white/10 mb-4">
                <CardHeader className="pb-2"><CardTitle className="text-white text-sm">Sales by Category</CardTitle></CardHeader>
                <CardContent>
                  <div className="divide-y divide-white/5">
                    {(settlementReport.posSales.byCategory as Array<{ category: string; total: number; count: number }>).map(cat => (
                      <div key={cat.category} className="py-2 flex items-center justify-between text-sm">
                        <div>
                          <span className="text-white">{cat.category}</span>
                          <span className="text-white/40 ml-3 text-xs">{cat.count} item{cat.count !== 1 ? 's' : ''}</span>
                        </div>
                        <span className="text-white font-medium">{formatCurrency(cat.total)}</span>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}

            {settlementReport.posSales?.transactions?.length > 0 && (
              <Card className="bg-white/5 border-white/10 mb-4">
                <CardHeader className="pb-2"><CardTitle className="text-white text-sm">POS Transactions</CardTitle></CardHeader>
                <CardContent>
                  <div className="divide-y divide-white/5">
                    {(settlementReport.posSales.transactions as Array<{
                      id: number; receiptNumber: string; transactedAt: string;
                      memberName?: string; customerName?: string; totalAmount: string; paymentMethod: string;
                    }>).map(txn => (
                      <div key={txn.id} className="py-2 flex items-center justify-between text-sm">
                        <div>
                          <span className="font-mono text-white/70">{txn.receiptNumber}</span>
                          <span className="text-white/40 ml-3 text-xs">{formatDate(txn.transactedAt)}</span>
                          <span className="text-white/50 ml-3 text-xs">{txn.memberName ?? txn.customerName ?? 'Walk-in'}</span>
                        </div>
                        <span className="text-white">{formatCurrency(txn.totalAmount)}</span>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}

            {settlementReport.invoice && (
              <Card className="bg-white/5 border-white/10">
                <CardContent className="p-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <span className="text-white/50 text-sm">Invoice: </span>
                      <span className="text-white font-mono">{settlementReport.invoice.invoiceNumber}</span>
                      <Badge variant="outline" className={`ml-3 border text-xs ${INVOICE_STATUS_COLORS[settlementReport.invoice.status]}`}>
                        {settlementReport.invoice.status}
                      </Badge>
                    </div>
                    {settlementReport.invoice.razorpayPaymentLinkUrl && (
                      <a href={settlementReport.invoice.razorpayPaymentLinkUrl} target="_blank" rel="noopener noreferrer" className="text-blue-400 text-sm hover:underline flex items-center gap-1">
                        <Link2 className="w-3 h-3" /> View Payment Link
                      </a>
                    )}
                  </div>
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      )}

      {/* ── Dialogs ────────────────────────────────────────────────────── */}

      <Dialog open={showRenewalAlerts} onOpenChange={setShowRenewalAlerts}>
        <DialogContent className="bg-[#1a1a1a] border-white/10 text-white max-w-2xl">
          <DialogHeader>
            <DialogTitle className="text-white flex items-center gap-2">
              <AlertTriangle className="w-5 h-5 text-amber-400" /> Contract Renewal Alerts
            </DialogTitle>
          </DialogHeader>
          {renewalAlerts.length === 0 ? (
            <div className="py-8 text-center text-white/40">
              <CheckCircle2 className="w-8 h-8 mx-auto mb-2 text-emerald-400" />
              <p>No contracts expiring in the next 90 days</p>
            </div>
          ) : renewalAlerts.map(alert => (
            <div key={alert.contractId} className={`p-3 rounded-lg border ${ALERT_LEVEL_COLORS[alert.alertLevel]}`}>
              <div className="flex items-center justify-between">
                <div>
                  <span className="font-medium">{alert.vendorName}</span>
                  <Badge variant="outline" className={`ml-2 text-xs border ${ALERT_LEVEL_COLORS[alert.alertLevel]}`}>{alert.alertLevel}</Badge>
                </div>
                <div className="text-sm">
                  <span>{alert.daysLeft}d left</span>
                  <span className="ml-2 text-white/50">{formatDate(alert.contractEndDate)}</span>
                </div>
              </div>
              {alert.autoRenewal && <p className="text-xs text-emerald-400 mt-1">Auto-renewal enabled</p>}
            </div>
          ))}
        </DialogContent>
      </Dialog>

      <Dialog open={showAddVendor} onOpenChange={setShowAddVendor}>
        <DialogContent className="bg-[#1a1a1a] border-white/10 text-white max-w-2xl">
          <DialogHeader><DialogTitle className="text-white">Add Vendor Operator</DialogTitle></DialogHeader>
          <VendorForm onClose={() => setShowAddVendor(false)} base={base} invalidate={invalidate} />
        </DialogContent>
      </Dialog>

      <Dialog open={!!showEditVendor} onOpenChange={() => setShowEditVendor(null)}>
        <DialogContent className="bg-[#1a1a1a] border-white/10 text-white max-w-2xl">
          <DialogHeader><DialogTitle className="text-white">Edit Vendor Operator</DialogTitle></DialogHeader>
          {showEditVendor && <VendorForm onClose={() => setShowEditVendor(null)} initial={showEditVendor} base={base} invalidate={invalidate} />}
        </DialogContent>
      </Dialog>

      <Dialog open={showAddAssignment} onOpenChange={setShowAddAssignment}>
        <DialogContent className="bg-[#1a1a1a] border-white/10 text-white">
          <DialogHeader><DialogTitle className="text-white">Assign Facility</DialogTitle></DialogHeader>
          {selectedVendorId && showAddAssignment && (
            <AssignmentForm onClose={() => setShowAddAssignment(false)} vendorId={selectedVendorId} base={base} invalidate={invalidate} />
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={showAddContract || !!showEditContract} onOpenChange={() => { setShowAddContract(false); setShowEditContract(null); }}>
        <DialogContent className="bg-[#1a1a1a] border-white/10 text-white max-w-2xl overflow-y-auto max-h-[90vh]">
          <DialogHeader>
            <DialogTitle className="text-white">{showEditContract ? 'Edit Contract' : 'New Contract'}</DialogTitle>
          </DialogHeader>
          {selectedVendorId && (showAddContract || showEditContract) && (
            <ContractForm
              onClose={() => { setShowAddContract(false); setShowEditContract(null); }}
              initial={showEditContract ?? undefined}
              vendorId={selectedVendorId}
              base={base}
              invalidate={invalidate}
            />
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={!!showTerminate} onOpenChange={() => setShowTerminate(null)}>
        <DialogContent className="bg-[#1a1a1a] border-white/10 text-white">
          <DialogHeader><DialogTitle className="text-white">Terminate Contract</DialogTitle></DialogHeader>
          {showTerminate && selectedVendorId && (
            <TerminateForm
              onClose={() => setShowTerminate(null)}
              contractId={showTerminate}
              vendorId={selectedVendorId}
              base={base}
              invalidate={invalidate}
            />
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={!!showRenew} onOpenChange={() => setShowRenew(null)}>
        <DialogContent className="bg-[#1a1a1a] border-white/10 text-white max-w-2xl overflow-y-auto max-h-[90vh]">
          <DialogHeader><DialogTitle className="text-white">Renew Contract</DialogTitle></DialogHeader>
          {showRenew && selectedVendorId && (
            <>
              <p className="text-white/50 text-sm mb-2">A new contract will be created to replace the current one. Adjust terms below.</p>
              <ContractForm
                onClose={() => setShowRenew(null)}
                initial={{ ...showRenew, id: -1, previousContractId: showRenew.id }}
                vendorId={selectedVendorId}
                base={base}
                invalidate={invalidate}
              />
            </>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={showGenerateCycle} onOpenChange={setShowGenerateCycle}>
        <DialogContent className="bg-[#1a1a1a] border-white/10 text-white">
          <DialogHeader><DialogTitle className="text-white">Generate Billing Cycle</DialogTitle></DialogHeader>
          {selectedVendorId && showGenerateCycle && (
            <GenerateCycleForm
              onClose={() => setShowGenerateCycle(false)}
              vendorId={selectedVendorId}
              contracts={vendorDetail?.contracts ?? []}
              base={base}
              invalidate={invalidate}
            />
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={showCreateInvoice !== false} onOpenChange={open => { if (!open) setShowCreateInvoice(false); }}>
        <DialogContent className="bg-[#1a1a1a] border-white/10 text-white">
          <DialogHeader><DialogTitle className="text-white">Create Invoice</DialogTitle></DialogHeader>
          {selectedVendorId && showCreateInvoice !== false && (
            <CreateInvoiceForm
              onClose={() => setShowCreateInvoice(false)}
              vendorId={selectedVendorId}
              cycle={showCreateInvoice}
              base={base}
              invalidate={invalidate}
              onCreated={() => setVendorTab('invoices')}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
