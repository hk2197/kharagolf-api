import { useState, useEffect } from 'react';
import { useLocation } from 'wouter';
import { Loader2, Eye, EyeOff, Lock, Mail, User, Building2, CheckCircle } from 'lucide-react';
import { KharaGolfBrand } from '@/components/kharagolf-brand';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

const API = (path: string) => `/api${path}`;

export default function AdminSetupPage() {
  const [, navigate] = useLocation();
  const [checking, setChecking] = useState(true);
  const [setupAvailable, setSetupAvailable] = useState(false);
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [orgName, setOrgName] = useState('');
  const [showPass, setShowPass] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  useEffect(() => {
    fetch(API('/auth/admin-setup-check'))
      .then(r => r.ok ? r.json() : { setupAvailable: false })
      .then(d => {
        setSetupAvailable(!!d.setupAvailable);
        setChecking(false);
        if (!d.setupAvailable) {
          setTimeout(() => navigate('/login'), 2500);
        }
      })
      .catch(() => { setChecking(false); setSetupAvailable(false); setTimeout(() => navigate('/login'), 2500); });
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (password !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }
    if (password.length < 8) {
      setError('Password must be at least 8 characters');
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(API('/auth/admin-setup'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ firstName, lastName, email, password, organizationName: orgName }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Setup failed. Please try again.');
        return;
      }
      setDone(true);
      setTimeout(() => { window.location.href = '/'; }, 1500);
    } catch {
      setError('Network error. Please check your connection and try again.');
    } finally {
      setLoading(false);
    }
  }

  if (checking) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!setupAvailable) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center p-4 text-center">
        <Lock className="w-10 h-10 text-muted-foreground mb-4" />
        <h2 className="text-white text-lg font-semibold mb-2">Setup already completed</h2>
        <p className="text-muted-foreground text-sm">An administrator account already exists. Redirecting to sign in…</p>
      </div>
    );
  }

  if (done) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center p-4 text-center">
        <CheckCircle className="w-12 h-12 text-primary mb-4" />
        <h2 className="text-white text-xl font-semibold mb-2">Admin account created!</h2>
        <p className="text-muted-foreground text-sm">You're now logged in. Redirecting to dashboard…</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <KharaGolfBrand size="lg" />
        </div>

        <div className="bg-card border border-border rounded-2xl p-8 shadow-2xl">
          <h2 className="text-white text-xl font-semibold mb-1">First-time setup</h2>
          <p className="text-muted-foreground text-sm mb-6">
            Create your administrator account to get started.
          </p>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm text-muted-foreground mb-1.5">First name</label>
                <div className="relative">
                  <User className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                  <Input
                    value={firstName}
                    onChange={e => setFirstName(e.target.value)}
                    placeholder="John"
                    required
                    className="pl-9 bg-background border-border text-white"
                  />
                </div>
              </div>
              <div>
                <label className="block text-sm text-muted-foreground mb-1.5">Last name</label>
                <Input
                  value={lastName}
                  onChange={e => setLastName(e.target.value)}
                  placeholder="Smith"
                  required
                  className="bg-background border-border text-white"
                />
              </div>
            </div>

            <div>
              <label className="block text-sm text-muted-foreground mb-1.5">Email address</label>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                  type="email"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  placeholder="admin@yourclub.com"
                  required
                  autoComplete="email"
                  className="pl-10 bg-background border-border text-white"
                />
              </div>
            </div>

            <div>
              <label className="block text-sm text-muted-foreground mb-1.5">Club / Organization name (optional)</label>
              <div className="relative">
                <Building2 className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                  value={orgName}
                  onChange={e => setOrgName(e.target.value)}
                  placeholder="e.g. Kharagpur Golf Club"
                  className="pl-10 bg-background border-border text-white"
                />
              </div>
            </div>

            <div>
              <label className="block text-sm text-muted-foreground mb-1.5">Password</label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                  type={showPass ? 'text' : 'password'}
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  placeholder="Min. 8 characters"
                  required
                  autoComplete="new-password"
                  className="pl-10 pr-10 bg-background border-border text-white"
                />
                <button
                  type="button"
                  onClick={() => setShowPass(v => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-white transition-colors"
                >
                  {showPass ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            <div>
              <label className="block text-sm text-muted-foreground mb-1.5">Confirm password</label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                  type={showPass ? 'text' : 'password'}
                  value={confirmPassword}
                  onChange={e => setConfirmPassword(e.target.value)}
                  placeholder="Repeat password"
                  required
                  autoComplete="new-password"
                  className="pl-10 bg-background border-border text-white"
                />
              </div>
            </div>

            {error && (
              <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-sm">
                {error}
              </div>
            )}

            <Button type="submit" disabled={loading} className="w-full bg-primary hover:bg-primary/90 text-primary-foreground font-semibold h-11">
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Create admin account'}
            </Button>
          </form>

          <div className="mt-4 text-center">
            <button onClick={() => navigate('/login')} className="text-sm text-muted-foreground hover:text-primary transition-colors">
              Already have an account? Sign in
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
