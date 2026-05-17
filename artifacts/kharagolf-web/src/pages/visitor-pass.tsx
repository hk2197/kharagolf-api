import { useState, useEffect, useRef } from 'react';
import { useLocation } from 'wouter';
import { useQuery, useMutation } from '@tanstack/react-query';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';
import { CheckCircle2, CalendarDays, DollarSign, QrCode, User, Mail, Phone, AlertCircle } from 'lucide-react';
import QRCode from 'qrcode';

const GOLD = '#C9A84C';

function fmtDate(d: string | Date | null) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' });
}

function fmtMoney(v: string | number | null) {
  if (v == null) return '₹0';
  return `₹${parseFloat(String(v)).toLocaleString('en-IN', { minimumFractionDigits: 0 })}`;
}

function QrCanvas({ token, orgId }: { token: string; orgId: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const qrData = `${window.location.origin}/guest-checkin?org=${orgId}&token=${token}`;
  useEffect(() => {
    if (canvasRef.current) {
      QRCode.toCanvas(canvasRef.current, qrData, { width: 220, margin: 2 }).catch(() => {});
    }
  }, [qrData]);
  return <canvas ref={canvasRef} className="rounded-xl shadow-lg" />;
}

export default function VisitorPassPage() {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const params = new URLSearchParams(window.location.search);
  const orgId = parseInt(params.get('org') ?? '0');
  const [step, setStep] = useState<'form' | 'confirm' | 'success'>('form');
  const [createdPass, setCreatedPass] = useState<Record<string, unknown> | null>(null);
  const [orgData, setOrgData] = useState<{ name: string; logoUrl?: string } | null>(null);

  const [form, setForm] = useState({
    visitorName: '', visitorEmail: '', visitorPhone: '',
    playDate: '', pricingRuleId: '',
  });

  const { data: pricingRules = [] } = useQuery<Record<string, unknown>[]>({
    queryKey: [`/api/public/orgs/${orgId}/visitor-pricing`],
    queryFn: () => fetch(`/api/public/orgs/${orgId}/visitor-pricing`).then(r => r.json()),
    enabled: !!orgId,
  });

  const selectedRule = pricingRules.find((r) => String(r.id) === form.pricingRuleId) as Record<string, unknown> | undefined;

  function getRate(rule: Record<string, unknown> | undefined, dateStr: string): number {
    if (!rule || !dateStr) return 0;
    const d = new Date(dateStr);
    const day = d.getDay();
    const isWeekend = day === 0 || day === 6;
    const dayOverrides = rule.dayOverrides as Record<string, string> | undefined;
    if (dayOverrides?.[String(day)] != null) return parseFloat(dayOverrides[String(day)]);
    return isWeekend ? parseFloat(String(rule.weekendRate ?? 0)) : parseFloat(String(rule.weekdayRate ?? 0));
  }

  const estimatedFee = getRate(selectedRule ?? pricingRules[0] as Record<string, unknown> | undefined, form.playDate);

  const createMutation = useMutation({
    mutationFn: () => fetch(`/api/public/orgs/${orgId}/visitor-passes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...form, pricingRuleId: form.pricingRuleId ? parseInt(form.pricingRuleId) : undefined }),
    }).then(r => r.ok ? r.json() : r.json().then(e => Promise.reject(e))),
    onSuccess: (data) => {
      setCreatedPass(data.pass as Record<string, unknown>);
      setOrgData({ name: data.orgName, logoUrl: undefined });
      setStep('success');
    },
    onError: (e: { error?: string }) => toast({ title: 'Error', description: e.error ?? 'Failed to create pass', variant: 'destructive' }),
  });

  if (!orgId) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Card className="p-8 text-center bg-card/80 border-white/10 max-w-sm">
          <AlertCircle className="w-12 h-12 mx-auto text-red-400 mb-4" />
          <p className="text-white font-semibold">Invalid club link</p>
          <p className="text-muted-foreground text-sm mt-2">Please use the visitor pass link provided by your host club.</p>
        </Card>
      </div>
    );
  }

  if (step === 'success' && createdPass) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-4">
        <Card className="p-8 bg-card/80 border-white/10 max-w-sm w-full text-center space-y-6">
          <div className="flex justify-center">
            <div className="w-16 h-16 rounded-full bg-emerald-500/20 flex items-center justify-center">
              <CheckCircle2 className="w-8 h-8 text-emerald-400" />
            </div>
          </div>
          <div>
            <h1 className="text-xl font-bold text-white">Visitor Pass Confirmed!</h1>
            <p className="text-muted-foreground text-sm mt-1">{orgData?.name}</p>
          </div>
          <div className="bg-background/40 rounded-xl p-4 space-y-2 text-left">
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Name</span>
              <span className="text-white font-medium">{String(createdPass.visitorName)}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Play Date</span>
              <span className="text-white font-medium">{fmtDate(createdPass.playDate as string)}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Green Fee</span>
              <span className="font-semibold" style={{ color: GOLD }}>{fmtMoney(createdPass.greenFee as string)}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Status</span>
              <Badge className={createdPass.status === 'paid' ? 'text-emerald-400 bg-emerald-500/20' : 'text-amber-400 bg-amber-500/20'}>
                {String(createdPass.status).replace('_', ' ')}
              </Badge>
            </div>
          </div>
          <div className="flex justify-center">
            <QrCanvas token={String(createdPass.qrToken)} orgId={orgId} />
          </div>
          <p className="text-xs text-muted-foreground">
            Show this QR code at the club entrance. Staff will scan it to check you in.
          </p>
          {parseFloat(String(createdPass.greenFee ?? 0)) > 0 && createdPass.status === 'pending_payment' && (
            <Card className="p-3 bg-amber-500/10 border-amber-500/30">
              <p className="text-amber-400 text-sm font-medium">Payment required</p>
              <p className="text-amber-300 text-xs mt-1">
                Please complete payment of {fmtMoney(createdPass.greenFee as string)} at the club reception before play.
              </p>
            </Card>
          )}
          <Button variant="outline" className="w-full" onClick={() => window.print()}>
            Print / Save Pass
          </Button>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="w-full max-w-md space-y-6">
        {/* Header */}
        <div className="text-center">
          <div className="w-16 h-16 rounded-2xl mx-auto flex items-center justify-center mb-4" style={{ background: `${GOLD}20`, border: `1px solid ${GOLD}40` }}>
            <QrCode className="w-8 h-8" style={{ color: GOLD }} />
          </div>
          <h1 className="text-2xl font-bold text-white">Visitor Day Pass</h1>
          <p className="text-muted-foreground text-sm mt-1">Purchase a green fee to play at our course</p>
        </div>

        <Card className="p-6 bg-card/80 border-white/10 space-y-5">
          <div>
            <Label className="text-muted-foreground text-sm flex items-center gap-1.5">
              <User className="w-3.5 h-3.5" /> Your Full Name *
            </Label>
            <Input className="mt-1.5 bg-background/50" value={form.visitorName}
              onChange={e => setForm(f => ({ ...f, visitorName: e.target.value }))}
              placeholder="First & Last Name" />
          </div>

          <div>
            <Label className="text-muted-foreground text-sm flex items-center gap-1.5">
              <Mail className="w-3.5 h-3.5" /> Email Address *
            </Label>
            <Input className="mt-1.5 bg-background/50" type="email" value={form.visitorEmail}
              onChange={e => setForm(f => ({ ...f, visitorEmail: e.target.value }))}
              placeholder="your@email.com" />
          </div>

          <div>
            <Label className="text-muted-foreground text-sm flex items-center gap-1.5">
              <Phone className="w-3.5 h-3.5" /> Phone Number
            </Label>
            <Input className="mt-1.5 bg-background/50" value={form.visitorPhone}
              onChange={e => setForm(f => ({ ...f, visitorPhone: e.target.value }))}
              placeholder="+91 98765 43210" />
          </div>

          <div>
            <Label className="text-muted-foreground text-sm flex items-center gap-1.5">
              <CalendarDays className="w-3.5 h-3.5" /> Play Date *
            </Label>
            <Input className="mt-1.5 bg-background/50" type="date" value={form.playDate}
              min={new Date().toISOString().split('T')[0]}
              onChange={e => setForm(f => ({ ...f, playDate: e.target.value }))} />
          </div>

          {pricingRules.length > 1 && (
            <div>
              <Label className="text-muted-foreground text-sm flex items-center gap-1.5">
                <DollarSign className="w-3.5 h-3.5" /> Visitor Category
              </Label>
              <Select value={form.pricingRuleId} onValueChange={v => setForm(f => ({ ...f, pricingRuleId: v }))}>
                <SelectTrigger className="mt-1.5 bg-background/50">
                  <SelectValue placeholder="Select category…" />
                </SelectTrigger>
                <SelectContent>
                  {pricingRules.map((r) => (
                    <SelectItem key={String(r.id)} value={String(r.id)}>{String(r.label)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {form.playDate && (
            <Card className="p-3 bg-white/5 border-white/10">
              <div className="flex justify-between items-center">
                <span className="text-muted-foreground text-sm">Estimated Green Fee</span>
                <span className="text-xl font-bold" style={{ color: GOLD }}>{fmtMoney(estimatedFee)}</span>
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                {new Date(form.playDate).getDay() === 0 || new Date(form.playDate).getDay() === 6 ? 'Weekend rate' : 'Weekday rate'}
              </p>
            </Card>
          )}

          <Button
            className="w-full"
            style={{ background: GOLD, color: '#000', fontWeight: 600 }}
            disabled={!form.visitorName || !form.visitorEmail || !form.playDate || createMutation.isPending}
            onClick={() => createMutation.mutate()}
          >
            {createMutation.isPending ? 'Processing…' : 'Purchase Visitor Pass'}
          </Button>

          <p className="text-xs text-muted-foreground text-center">
            Your QR code pass will be generated immediately after submission.
            Payment may be required at the club reception.
          </p>
        </Card>
      </div>
    </div>
  );
}
