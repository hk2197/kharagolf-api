import { useState, useEffect, useRef } from 'react';
import { useLocation } from 'wouter';
import { Loader2, Eye, EyeOff, Lock, Mail, AlertCircle } from 'lucide-react';
import { KharaGolfWordmark } from '@/components/kharagolf-brand';
import { PreAuthBrand } from '@/components/PreAuthBrand';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useToast } from '@/hooks/use-toast';

const API = (path: string) => `/api${path}`;

const GOOGLE_CLIENT_ID = (import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined) ?? '';
const APPLE_SERVICES_ID = (import.meta.env.VITE_APPLE_SERVICES_ID as string | undefined) ?? '';
const APPLE_REDIRECT_URI = (import.meta.env.VITE_APPLE_REDIRECT_URI as string | undefined) ?? '';

declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize: (config: {
            client_id: string;
            callback: (response: { credential: string }) => void;
            ux_mode?: 'popup' | 'redirect';
            auto_select?: boolean;
          }) => void;
          renderButton: (parent: HTMLElement, options: Record<string, unknown>) => void;
        };
      };
    };
    AppleID?: {
      auth: {
        init: (config: {
          clientId: string;
          scope: string;
          redirectURI: string;
          usePopup: boolean;
        }) => void;
        signIn: () => Promise<{
          authorization: { id_token: string; code: string; state?: string };
          user?: { name?: { firstName?: string; lastName?: string }; email?: string };
        }>;
      };
    };
  }
}

function loadScriptOnce(src: string, id: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (document.getElementById(id)) { resolve(); return; }
    const s = document.createElement('script');
    s.src = src; s.id = id; s.async = true; s.defer = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(s);
  });
}

type View = 'login' | 'forgot';

export default function LoginPage() {
  const [, navigate] = useLocation();
  const { toast } = useToast();

  const [view, setView] = useState<View>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPass, setShowPass] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [unverified, setUnverified] = useState(false);
  const [forgotEmail, setForgotEmail] = useState('');
  const [forgotLoading, setForgotLoading] = useState(false);
  const [forgotSent, setForgotSent] = useState(false);
  const [resendLoading, setResendLoading] = useState(false);
  const [setupAvailable, setSetupAvailable] = useState(false);
  const [socialLoading, setSocialLoading] = useState<null | 'google' | 'apple'>(null);
  const googleBtnRef = useRef<HTMLDivElement | null>(null);

  const returnTo = new URLSearchParams(window.location.search).get('returnTo') || '/';

  function destinationFor(role: string | undefined): string {
    let dest = returnTo.startsWith('/') && returnTo !== '/login' ? returnTo : '/';
    if (!returnTo || returnTo === '/' || returnTo === '/login') {
      dest = role === 'player' || role === 'spectator' ? '/portal' : '/';
    }
    return dest;
  }

  async function postSocialIdToken(provider: 'google' | 'apple', body: Record<string, unknown>) {
    setSocialLoading(provider);
    setError('');
    try {
      const res = await fetch(API(`/auth/${provider}`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || `Sign-in with ${provider} failed.`);
        return;
      }
      window.location.href = destinationFor(data.user?.role);
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setSocialLoading(null);
    }
  }

  // Initialize Google Identity Services button
  useEffect(() => {
    if (!GOOGLE_CLIENT_ID) return;
    let cancelled = false;
    loadScriptOnce('https://accounts.google.com/gsi/client', 'google-gsi-script')
      .then(() => {
        if (cancelled || !window.google || !googleBtnRef.current) return;
        window.google.accounts.id.initialize({
          client_id: GOOGLE_CLIENT_ID,
          callback: (response) => {
            if (response.credential) void postSocialIdToken('google', { idToken: response.credential });
          },
          ux_mode: 'popup',
        });
        window.google.accounts.id.renderButton(googleBtnRef.current, {
          type: 'standard',
          theme: 'filled_black',
          size: 'large',
          text: 'continue_with',
          shape: 'rectangular',
          logo_alignment: 'left',
          width: googleBtnRef.current.clientWidth || 340,
        });
      })
      .catch(() => {/* network error — buttons just won't appear */});
    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Initialize Apple JS
  useEffect(() => {
    if (!APPLE_SERVICES_ID) return;
    loadScriptOnce(
      'https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/en_US/appleid.auth.js',
      'apple-auth-script',
    )
      .then(() => {
        if (!window.AppleID) return;
        window.AppleID.auth.init({
          clientId: APPLE_SERVICES_ID,
          scope: 'name email',
          redirectURI: APPLE_REDIRECT_URI || window.location.origin + '/login',
          usePopup: true,
        });
      })
      .catch(() => {/* ignore */});
  }, []);

  async function handleAppleClick() {
    if (!window.AppleID) return;
    try {
      const data = await window.AppleID.auth.signIn();
      const fullName = data.user?.name
        ? { givenName: data.user.name.firstName, familyName: data.user.name.lastName }
        : undefined;
      await postSocialIdToken('apple', {
        identityToken: data.authorization.id_token,
        fullName,
      });
    } catch {
      // User cancelled or popup blocked — silent
    }
  }

  useEffect(() => {
    fetch(API('/auth/admin-setup-check'))
      .then(r => r.ok ? r.json() : { setupAvailable: false })
      .then(d => setSetupAvailable(!!d.setupAvailable))
      .catch(() => {});
  }, []);

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setUnverified(false);
    setLoading(true);
    try {
      const res = await fetch(API('/auth/player-login'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (res.status === 403) {
          setUnverified(true);
          setError(data.error || 'Please verify your email before logging in.');
        } else {
          setError(data.error || 'Login failed. Please try again.');
        }
        return;
      }
      const role = data.user?.role;
      let dest = returnTo.startsWith('/') && returnTo !== '/login' ? returnTo : '/';
      if (!returnTo || returnTo === '/' || returnTo === '/login') {
        if (role === 'player' || role === 'spectator') dest = '/portal';
        else dest = '/';
      }
      window.location.href = dest;
    } catch {
      setError('Network error. Please check your connection and try again.');
    } finally {
      setLoading(false);
    }
  }

  async function handleForgot(e: React.FormEvent) {
    e.preventDefault();
    setForgotLoading(true);
    try {
      await fetch(API('/auth/forgot-password'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: forgotEmail }),
      });
      setForgotSent(true);
    } catch {
      toast({ title: 'Error', description: 'Failed to send reset email. Please try again.', variant: 'destructive' });
    } finally {
      setForgotLoading(false);
    }
  }

  async function handleResend() {
    setResendLoading(true);
    try {
      await fetch(API('/auth/resend-verification'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      toast({ title: 'Verification email sent', description: 'Check your inbox for the verification link.' });
    } catch {
      toast({ title: 'Error', description: 'Failed to send verification email.', variant: 'destructive' });
    } finally {
      setResendLoading(false);
    }
  }

  return (
    <main id="main-content" tabIndex={-1} className="min-h-screen bg-background flex flex-col items-center justify-center p-4 focus:outline-none">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <PreAuthBrand size="lg" />
        </div>

        <div className="bg-card border border-border rounded-2xl p-8 shadow-2xl">
          {view === 'login' && (
            <>
              <h2 className="text-white text-xl font-semibold mb-6">Sign in to your account</h2>
              <form onSubmit={handleLogin} className="space-y-4">
                <div>
                  <label htmlFor="login-email" className="block text-sm text-muted-foreground mb-1.5">Email address</label>
                  <div className="relative">
                    <Mail aria-hidden="true" className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                    <Input
                      id="login-email"
                      type="email"
                      value={email}
                      onChange={e => setEmail(e.target.value)}
                      placeholder="admin@example.com"
                      required
                      autoComplete="email"
                      className="pl-10 bg-background border-border text-white placeholder:text-muted-foreground"
                    />
                  </div>
                </div>
                <div>
                  <label htmlFor="login-password" className="block text-sm text-muted-foreground mb-1.5">Password</label>
                  <div className="relative">
                    <Lock aria-hidden="true" className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                    <Input
                      id="login-password"
                      type={showPass ? 'text' : 'password'}
                      value={password}
                      onChange={e => setPassword(e.target.value)}
                      placeholder="••••••••"
                      required
                      autoComplete="current-password"
                      className="pl-10 pr-10 bg-background border-border text-white"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPass(v => !v)}
                      aria-label={showPass ? 'Hide password' : 'Show password'}
                      aria-pressed={showPass}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-white transition-colors"
                    >
                      {showPass ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                </div>

                {error && (
                  <div className="flex items-start gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/30">
                    <AlertCircle className="w-4 h-4 text-red-400 mt-0.5 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="text-red-400 text-sm">{error}</p>
                      {unverified && (
                        <button
                          type="button"
                          onClick={handleResend}
                          disabled={resendLoading}
                          className="mt-1 text-xs text-primary hover:underline disabled:opacity-50"
                        >
                          {resendLoading ? 'Sending…' : 'Resend verification email'}
                        </button>
                      )}
                    </div>
                  </div>
                )}

                <Button type="submit" disabled={loading} className="w-full bg-primary hover:bg-primary/90 text-primary-foreground font-semibold h-11">
                  {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Sign in'}
                </Button>
              </form>

              {(GOOGLE_CLIENT_ID || APPLE_SERVICES_ID) && (
                <>
                  <div className="my-5 flex items-center gap-3">
                    <div className="flex-1 h-px bg-border" />
                    <span className="text-xs text-muted-foreground uppercase tracking-wider">or</span>
                    <div className="flex-1 h-px bg-border" />
                  </div>
                  <div className="space-y-3">
                    {GOOGLE_CLIENT_ID && (
                      <div ref={googleBtnRef} className="w-full flex justify-center min-h-[44px]" />
                    )}
                    {APPLE_SERVICES_ID && (
                      <button
                        type="button"
                        onClick={handleAppleClick}
                        disabled={socialLoading !== null}
                        className="w-full h-11 rounded-md bg-black text-white font-medium flex items-center justify-center gap-2 hover:bg-black/90 disabled:opacity-60"
                        aria-label="Continue with Apple"
                      >
                        {socialLoading === 'apple' ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <>
                            <svg width="16" height="16" viewBox="0 0 384 512" fill="currentColor" aria-hidden="true">
                              <path d="M318.7 268.7c-.2-36.7 16.4-64.4 50-84.8-18.8-26.9-47.2-41.7-84.7-44.6-35.5-2.8-74.3 20.7-88.5 20.7-15 0-49.4-19.7-76.4-19.7C63.3 141.2 4 184.8 4 273.5q0 39.3 14.4 81.2c12.8 36.7 59 126.7 107.2 125.2 25.2-.6 43-17.9 75.8-17.9 31.8 0 48.3 17.9 76.4 17.9 48.6-.7 90.4-82.5 102.6-119.3-65.2-30.7-61.7-90-61.7-91.9zm-56.6-164.2c27.3-32.4 24.8-61.9 24-72.5-24.1 1.4-52 16.4-67.9 34.9-17.5 19.8-27.8 44.3-25.6 71.9 26.1 2 49.9-11.4 69.5-34.3z" />
                            </svg>
                            <span>Continue with Apple</span>
                          </>
                        )}
                      </button>
                    )}
                    {socialLoading === 'google' && (
                      <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
                        <Loader2 className="w-3 h-3 animate-spin" /> Signing in with Google…
                      </div>
                    )}
                  </div>
                </>
              )}

              <div className="mt-4 flex flex-col gap-2 text-center">
                <button
                  onClick={() => { setView('forgot'); setForgotEmail(email); setForgotSent(false); }}
                  className="text-sm text-muted-foreground hover:text-primary transition-colors"
                >
                  Forgot your password?
                </button>
                {setupAvailable && (
                  <button
                    onClick={() => navigate('/admin-setup')}
                    className="text-sm text-muted-foreground hover:text-primary transition-colors"
                  >
                    First time? Set up admin account
                  </button>
                )}
                <a href="/scorer" className="text-sm text-muted-foreground hover:text-primary transition-colors">
                  Scorer? Use PIN access →
                </a>
                <a href="/portal" className="text-sm text-muted-foreground hover:text-primary transition-colors">
                  Are you a player? Sign in at the Player Portal →
                </a>
              </div>
            </>
          )}

          {view === 'forgot' && (
            <>
              <button onClick={() => setView('login')} className="text-sm text-muted-foreground hover:text-primary mb-4 flex items-center gap-1">
                ← Back to sign in
              </button>
              <h2 className="text-white text-xl font-semibold mb-2">Reset your password</h2>
              <p className="text-muted-foreground text-sm mb-6">
                Enter your email address and we'll send you a link to reset your password.
              </p>
              {forgotSent ? (
                <div className="p-4 rounded-lg bg-green-500/10 border border-green-500/30 text-green-400 text-sm text-center">
                  If that email is registered, a password reset link has been sent. Check your inbox.
                </div>
              ) : (
                <form onSubmit={handleForgot} className="space-y-4">
                  <div className="relative">
                    <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                    <Input
                      type="email"
                      value={forgotEmail}
                      onChange={e => setForgotEmail(e.target.value)}
                      placeholder="admin@example.com"
                      required
                      className="pl-10 bg-background border-border text-white"
                    />
                  </div>
                  <Button type="submit" disabled={forgotLoading} className="w-full bg-primary hover:bg-primary/90 text-primary-foreground font-semibold h-11">
                    {forgotLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Send reset link'}
                  </Button>
                </form>
              )}
            </>
          )}
        </div>

        <p className="text-center text-xs text-muted-foreground mt-6">
          <KharaGolfWordmark /> <span style={{color:'#C9A84C'}}>Elysium</span><span style={{color:'#ffffff'}}>OS</span> — Secure Admin Portal
        </p>
      </div>
    </main>
  );
}
