import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { CheckCircle2, XCircle, Scan, AlertCircle, RefreshCw } from 'lucide-react';
import { useGetMe } from '@workspace/api-client-react';
import { useActiveOrgContext } from '@/context/ActiveOrgContext';
import { useToast } from '@/hooks/use-toast';

const GOLD = '#C9A84C';

function fmtDate(d: string | Date | null) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

function fmtMoney(v: string | number | null) {
  if (v == null) return '₹0';
  return `₹${parseFloat(String(v)).toLocaleString('en-IN', { minimumFractionDigits: 0 })}`;
}

type ScanResult = {
  type: 'guest_pass' | 'visitor_pass';
  pass: Record<string, unknown>;
  warning?: string;
};

export default function GuestCheckinPage() {
  const { data: user } = useGetMe();
  const { activeOrgId } = useActiveOrgContext();
  const orgId = activeOrgId ?? user?.organizationId as number;
  const { toast } = useToast();

  const urlParams = new URLSearchParams(window.location.search);
  const urlToken = urlParams.get('token');

  const [token, setToken] = useState(urlToken ?? '');
  const [result, setResult] = useState<ScanResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const scanMutation = useMutation({
    mutationFn: (qrToken: string) =>
      fetch(`/api/organizations/${orgId}/checkin/scan`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ qrToken }),
      }).then(async r => {
        const data = await r.json();
        if (!r.ok) throw data;
        return data;
      }),
    onSuccess: (data: ScanResult) => {
      setResult(data);
      setError(null);
    },
    onError: (e: { error?: string }) => {
      setError(e.error ?? 'QR code not found');
      setResult(null);
    },
  });

  function handleScan() {
    if (!token.trim() || !orgId) return;
    scanMutation.mutate(token.trim());
  }

  function reset() {
    setToken('');
    setResult(null);
    setError(null);
  }

  const pass = result?.pass;
  const guestName = pass ? String(pass.guestName ?? pass.visitorName ?? '') : '';
  const passType = result?.type === 'guest_pass' ? 'Member Guest' : 'Visitor Pass';
  const playDate = pass ? fmtDate(pass.playDate as string) : '';
  const greenFee = pass ? fmtMoney(pass.greenFee as string ?? pass.greenFee as string) : '';
  const isAlreadyCheckedIn = result?.warning != null;

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center">
          <div className="w-16 h-16 rounded-2xl mx-auto flex items-center justify-center mb-4"
            style={{ background: `${GOLD}20`, border: `1px solid ${GOLD}40` }}>
            <Scan className="w-8 h-8" style={{ color: GOLD }} />
          </div>
          <h1 className="text-2xl font-bold text-white">Guest Check-In</h1>
          <p className="text-muted-foreground text-sm mt-1">Scan or enter guest QR token</p>
        </div>

        {!result && !error && (
          <Card className="p-6 bg-card/80 border-white/10 space-y-4">
            <div>
              <Label className="text-muted-foreground">QR Token</Label>
              <Input
                className="mt-1.5 bg-background/50 font-mono text-sm"
                value={token}
                onChange={e => setToken(e.target.value)}
                placeholder="Paste token here…"
                onKeyDown={e => e.key === 'Enter' && handleScan()}
                autoFocus
              />
            </div>
            <Button
              className="w-full"
              style={{ background: GOLD, color: '#000', fontWeight: 600 }}
              disabled={!token.trim() || !orgId || scanMutation.isPending}
              onClick={handleScan}
            >
              {scanMutation.isPending ? (
                <><RefreshCw className="w-4 h-4 mr-2 animate-spin" /> Checking…</>
              ) : (
                <><Scan className="w-4 h-4 mr-2" /> Verify & Check In</>
              )}
            </Button>
          </Card>
        )}

        {error && (
          <Card className="p-6 bg-red-500/10 border-red-500/30 space-y-4 text-center">
            <XCircle className="w-12 h-12 text-red-400 mx-auto" />
            <div>
              <p className="text-white font-semibold">Check-in Failed</p>
              <p className="text-red-300 text-sm mt-1">{error}</p>
            </div>
            <Button variant="outline" onClick={reset} className="w-full">Try Again</Button>
          </Card>
        )}

        {result && (
          <Card className={`p-6 space-y-4 ${isAlreadyCheckedIn ? 'bg-amber-500/10 border-amber-500/30' : 'bg-emerald-500/10 border-emerald-500/30'}`}>
            <div className="flex items-center gap-3">
              {isAlreadyCheckedIn ? (
                <AlertCircle className="w-10 h-10 text-amber-400 flex-shrink-0" />
              ) : (
                <CheckCircle2 className="w-10 h-10 text-emerald-400 flex-shrink-0" />
              )}
              <div>
                <p className="text-white font-bold text-lg">
                  {isAlreadyCheckedIn ? 'Already Checked In' : 'Check-In Successful!'}
                </p>
                <p className="text-sm text-muted-foreground">{passType}</p>
              </div>
            </div>
            <div className="bg-black/20 rounded-xl p-4 space-y-2">
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Guest</span>
                <span className="text-white font-semibold">{guestName}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Play Date</span>
                <span className="text-white">{playDate}</span>
              </div>
              {greenFee && greenFee !== '₹0' && (
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Green Fee</span>
                  <span className="font-semibold" style={{ color: GOLD }}>{greenFee}</span>
                </div>
              )}
              {pass?.feeSettlement && (
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Settlement</span>
                  <span className="text-white capitalize">{String(pass.feeSettlement).replace('_', ' ')}</span>
                </div>
              )}
            </div>
            {isAlreadyCheckedIn && (
              <p className="text-amber-400 text-sm text-center">{result.warning}</p>
            )}
            <Button variant="outline" onClick={reset} className="w-full">
              Scan Another
            </Button>
          </Card>
        )}
      </div>
    </div>
  );
}
