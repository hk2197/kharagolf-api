import { useEffect, useState } from 'react';
import { Loader2, ShieldCheck, Smartphone, Trash2, KeyRound } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useToast } from '@/hooks/use-toast';

interface SessionRow {
  id: number;
  deviceLabel: string | null;
  ip: string | null;
  userAgent: string | null;
  lastSeenAt: string | null;
  createdAt: string | null;
  revokedAt: string | null;
}

interface SetupResponse {
  secret: string;
  otpauthUrl: string;
}

const API = (path: string) => `/api${path}`;

export default function PortalSecurityPage() {
  const { toast } = useToast();

  // 2FA state
  const [setup, setSetup] = useState<SetupResponse | null>(null);
  const [setupLoading, setSetupLoading] = useState(false);
  const [code, setCode] = useState('');
  const [currentCode, setCurrentCode] = useState('');
  const [verifyLoading, setVerifyLoading] = useState(false);
  const [confirmed, setConfirmed] = useState(false);

  // Sessions state
  const [sessions, setSessions] = useState<SessionRow[] | null>(null);
  const [revokingId, setRevokingId] = useState<number | null>(null);

  const loadSessions = async () => {
    try {
      const r = await fetch(API('/portal/sessions'), { credentials: 'include' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json() as { sessions: SessionRow[] };
      setSessions(d.sessions ?? []);
    } catch (e) {
      toast({ title: 'Could not load sessions', description: e instanceof Error ? e.message : '', variant: 'destructive' });
    }
  };

  useEffect(() => { void loadSessions(); }, []);

  const startSetup = async () => {
    setSetupLoading(true);
    try {
      const r = await fetch(API('/portal/2fa/totp/setup'), {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(currentCode ? { currentCode } : {}),
      });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
      setSetup(body as SetupResponse);
      setConfirmed(false);
    } catch (e) {
      toast({ title: 'Could not start 2FA setup', description: e instanceof Error ? e.message : '', variant: 'destructive' });
    } finally {
      setSetupLoading(false);
    }
  };

  const verify = async () => {
    setVerifyLoading(true);
    try {
      const r = await fetch(API('/portal/2fa/totp/verify'), {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: code.trim() }),
      });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
      setConfirmed(true);
      setSetup(null);
      setCode('');
      toast({ title: '2FA confirmed', description: 'Your authenticator is now linked.' });
    } catch (e) {
      toast({ title: 'Verification failed', description: e instanceof Error ? e.message : '', variant: 'destructive' });
    } finally {
      setVerifyLoading(false);
    }
  };

  const revokeSession = async (id: number) => {
    setRevokingId(id);
    try {
      const r = await fetch(API(`/portal/sessions/${id}`), { method: 'DELETE', credentials: 'include' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      await loadSessions();
    } catch (e) {
      toast({ title: 'Could not revoke session', description: e instanceof Error ? e.message : '', variant: 'destructive' });
    } finally {
      setRevokingId(null);
    }
  };

  return (
    <div className="max-w-3xl mx-auto px-4 py-8 space-y-8" data-testid="page-portal-security">
      <div>
        <h1 className="text-2xl font-display font-bold text-white">Security</h1>
        <p className="text-sm text-muted-foreground">Manage two-factor authentication and active sign-ins.</p>
      </div>

      <Card className="glass-panel border-white/10 p-6 space-y-4" data-testid="card-2fa">
        <div className="flex items-center gap-2">
          <ShieldCheck className="w-5 h-5 text-primary" />
          <h2 className="text-lg font-semibold text-white">Two-Factor Authentication (TOTP)</h2>
        </div>
        {confirmed && (
          <p className="text-sm text-green-400">2FA is enabled on this account.</p>
        )}
        {!setup && (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Use an authenticator app (Google Authenticator, 1Password, Authy) to add a second factor at sign-in.
            </p>
            <div className="flex flex-col sm:flex-row gap-2 sm:items-end">
              <div className="flex-1">
                <label className="text-xs text-muted-foreground" htmlFor="current-code">If 2FA is already on, enter a current code:</label>
                <Input
                  id="current-code"
                  inputMode="numeric"
                  value={currentCode}
                  onChange={e => setCurrentCode(e.target.value)}
                  placeholder="123456"
                  data-testid="input-current-code"
                />
              </div>
              <Button onClick={startSetup} disabled={setupLoading} data-testid="button-start-2fa">
                {setupLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <KeyRound className="w-4 h-4 mr-1" />}
                Start setup
              </Button>
            </div>
          </div>
        )}
        {setup && (
          <div className="space-y-3" data-testid="block-totp-setup">
            <p className="text-sm text-muted-foreground">
              Add this secret to your authenticator app, then enter the 6-digit code it shows.
            </p>
            <div className="bg-black/40 border border-white/10 rounded-lg p-3 font-mono text-sm text-white break-all" data-testid="text-totp-secret">
              {setup.secret}
            </div>
            <p className="text-xs text-muted-foreground break-all">otpauth: {setup.otpauthUrl}</p>
            <div className="flex flex-col sm:flex-row gap-2 sm:items-end">
              <div className="flex-1">
                <label className="text-xs text-muted-foreground" htmlFor="verify-code">Enter the 6-digit code</label>
                <Input
                  id="verify-code"
                  inputMode="numeric"
                  value={code}
                  onChange={e => setCode(e.target.value)}
                  placeholder="123456"
                  data-testid="input-verify-code"
                />
              </div>
              <Button onClick={verify} disabled={verifyLoading || code.length < 6} data-testid="button-verify-2fa">
                {verifyLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Verify'}
              </Button>
            </div>
          </div>
        )}
      </Card>

      <Card className="glass-panel border-white/10 p-6 space-y-4" data-testid="card-sessions">
        <div className="flex items-center gap-2">
          <Smartphone className="w-5 h-5 text-primary" />
          <h2 className="text-lg font-semibold text-white">Active sessions</h2>
        </div>
        {sessions === null ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading…
          </div>
        ) : sessions.length === 0 ? (
          <p className="text-sm text-muted-foreground">No active sessions recorded.</p>
        ) : (
          <ul className="space-y-2">
            {sessions.map(s => (
              <li
                key={s.id}
                className="flex items-center justify-between gap-3 bg-white/[0.03] rounded-lg px-3 py-2"
                data-testid={`session-row-${s.id}`}
              >
                <div className="min-w-0">
                  <p className="text-sm text-white truncate">{s.deviceLabel ?? s.userAgent ?? 'Unknown device'}</p>
                  <p className="text-xs text-muted-foreground">
                    {s.ip ?? '—'} · last seen {s.lastSeenAt ? new Date(s.lastSeenAt).toLocaleString() : '—'}
                    {s.revokedAt ? ' · revoked' : ''}
                  </p>
                </div>
                {!s.revokedAt && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => revokeSession(s.id)}
                    disabled={revokingId === s.id}
                    data-testid={`button-revoke-${s.id}`}
                  >
                    {revokingId === s.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
