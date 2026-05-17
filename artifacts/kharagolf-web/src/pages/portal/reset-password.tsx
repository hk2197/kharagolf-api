import { useState, useEffect } from 'react';
import { useLocation } from 'wouter';
import { Loader2, CheckCircle, AlertCircle } from 'lucide-react';
import { KharaGolfWordmark } from '@/components/kharagolf-brand';
import { usePreAuthOrgBranding } from '@/lib/theme/usePreAuthOrgBranding';
import { useOrgTheme } from '@/lib/theme/useOrgTheme';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

const API = (path: string) => `/api${path}`;

export default function ResetPasswordPage() {
  const [, navigate] = useLocation();
  const [token, setToken] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);

  // Task #1756 — Render the active club's mark in the header when the
  // reset link came from a club-branded email (links append ?org=<slug>)
  // or a vanity domain. Falls back to the KHARAGOLF wordmark otherwise.
  const orgBranding = usePreAuthOrgBranding();
  useOrgTheme(orgBranding?.branding ?? null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const t = params.get('token');
    if (!t) { setError('Invalid reset link. Please request a new password reset.'); return; }
    setToken(t);
  }, []);

  async function handleReset(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (password.length < 8) { setError('Password must be at least 8 characters'); return; }
    if (password !== confirm) { setError('Passwords do not match'); return; }
    setLoading(true);
    try {
      const r = await fetch(API('/auth/reset-password'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password }),
      });
      const d = await r.json();
      if (!r.ok) { setError(d.error ?? 'Reset failed'); return; }
      setSuccess(true);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-white/10 bg-black/60 backdrop-blur-sm sticky top-0 z-50">
        <div className="max-w-4xl mx-auto px-4 h-14 flex items-center">
          {orgBranding?.logoUrl ? (
            <img
              src={orgBranding.logoUrl}
              alt={orgBranding.name ? `${orgBranding.name} logo` : 'Club logo'}
              className="h-8 w-auto max-w-[160px] object-contain mr-2"
              data-testid="reset-password-org-logo"
            />
          ) : (
            <>
              <img src="/logo.png" alt="KharaGolf" className="h-8 w-8 object-contain mr-2" />
              <KharaGolfWordmark className="text-lg" />
            </>
          )}
          <Badge className="ml-3 bg-primary/20 text-primary border-primary/30 border text-[10px] tracking-wider">PLAYER PORTAL</Badge>
        </div>
      </header>

      <div className="max-w-md mx-auto py-12 px-4">
        <div className="text-center mb-10">
          <h2 className="text-xl font-bold text-white">Set New Password</h2>
          <p className="text-muted-foreground text-sm mt-2">Enter your new password below</p>
        </div>

        <Card className="glass-panel border-white/10 p-8">
          {success ? (
            <div className="text-center space-y-4">
              <CheckCircle className="w-12 h-12 text-primary mx-auto" />
              <p className="text-white font-semibold text-lg">Password updated!</p>
              <p className="text-muted-foreground text-sm">You can now sign in with your new password.</p>
              <Button onClick={() => navigate('/portal')} className="w-full bg-primary hover:bg-primary/90">
                Go to Sign In
              </Button>
            </div>
          ) : (
            <>
              {error && (
                <div className="bg-red-900/40 border border-red-700/50 rounded-lg p-3 mb-4 flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0" />
                  <p className="text-red-300 text-sm">{error}</p>
                </div>
              )}
              {!token && !error ? (
                <div className="text-center py-4">
                  <Loader2 className="w-6 h-6 animate-spin text-primary mx-auto" />
                </div>
              ) : token ? (
                <form onSubmit={handleReset} className="space-y-4">
                  <div>
                    <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1.5 block">New Password</label>
                    <Input value={password} onChange={e => setPassword(e.target.value)} type="password" placeholder="Min. 8 characters" required className="bg-black/40 border-white/10 text-white" />
                  </div>
                  <div>
                    <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1.5 block">Confirm Password</label>
                    <Input value={confirm} onChange={e => setConfirm(e.target.value)} type="password" placeholder="Repeat new password" required className="bg-black/40 border-white/10 text-white" />
                  </div>
                  <Button type="submit" disabled={loading} className="w-full bg-primary hover:bg-primary/90 text-primary-foreground font-bold">
                    {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Update Password'}
                  </Button>
                </form>
              ) : null}
            </>
          )}
        </Card>
      </div>
    </div>
  );
}
