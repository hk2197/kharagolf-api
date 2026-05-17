import { useState, useCallback } from 'react';
import { useLocation } from 'wouter';
import {
  Building2, MapPin, Mail, Phone, Globe, ChevronRight, ChevronLeft,
  Check, Loader2, Trophy, Users, BarChart3, Zap, Star, Crown,
  AlertCircle, CheckCircle2, Globe2, CreditCard,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';

declare global {
  interface Window {
    Razorpay: new (opts: Record<string, unknown>) => { open(): void };
  }
}

function loadRazorpayScript(): Promise<boolean> {
  return new Promise((resolve) => {
    if (window.Razorpay) { resolve(true); return; }
    const script = document.createElement('script');
    script.src = 'https://checkout.razorpay.com/v1/checkout.js';
    script.onload = () => resolve(true);
    script.onerror = () => resolve(false);
    document.body.appendChild(script);
  });
}

const STEPS = ['Club Details', 'Contact', 'Choose Plan', 'Create Account', 'Done'];

interface Plan {
  tier: string;
  label: string;
  priceMonthly: number;
  currency: string;
  description: string;
}

const PLAN_ICONS: Record<string, React.ReactNode> = {
  free: <Trophy className="w-5 h-5" />,
  starter: <Zap className="w-5 h-5" />,
  pro: <Star className="w-5 h-5" />,
  enterprise: <Crown className="w-5 h-5" />,
};

const PLAN_FEATURES: Record<string, string[]> = {
  free: ['1 active tournament', '50 members', '1 league', 'Basic analytics'],
  starter: ['5 active tournaments', '200 members', '3 leagues', 'Sponsor logos', 'Priority email support'],
  pro: ['Unlimited tournaments', 'Unlimited members', 'Unlimited leagues', 'Advanced analytics', 'Priority support'],
  enterprise: ['Everything in Pro', 'White-label branding', 'Custom domain', 'Dedicated account manager'],
};

const PLAN_COLORS: Record<string, string> = {
  free: 'border-border',
  starter: 'border-blue-500/50',
  pro: 'border-primary/50',
  enterprise: 'border-purple-500/50',
};

const PLAN_BADGE_COLORS: Record<string, string> = {
  free: 'bg-muted text-muted-foreground',
  starter: 'bg-blue-500/20 text-blue-400',
  pro: 'bg-primary/20 text-primary',
  enterprise: 'bg-purple-500/20 text-purple-400',
};

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

interface SubscriptionState {
  subscriptionId: string;
  keyId: string;
  tier: string;
  tierLabel: string;
  priceMonthly: number;
}

export default function ClubOnboardingPage() {
  const [, navigate] = useLocation();
  const [step, setStep] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [slugChecking, setSlugChecking] = useState(false);
  const [slugAvailable, setSlugAvailable] = useState<boolean | null>(null);
  const [upgradeRequired, setUpgradeRequired] = useState(false);
  const [upgradeLoading, setUpgradeLoading] = useState(false);
  const [upgradeError, setUpgradeError] = useState('');
  const [paymentComplete, setPaymentComplete] = useState(false);
  const [registeredEmail, setRegisteredEmail] = useState('');
  const [plans] = useState<Plan[]>([
    { tier: 'free', label: 'Free', priceMonthly: 0, currency: 'INR', description: 'Perfect for small clubs just getting started' },
    { tier: 'starter', label: 'Starter', priceMonthly: 2999, currency: 'INR', description: 'For growing clubs with regular tournaments' },
    { tier: 'pro', label: 'Pro', priceMonthly: 7999, currency: 'INR', description: 'Unlimited everything for established clubs' },
    { tier: 'enterprise', label: 'Enterprise', priceMonthly: 19999, currency: 'INR', description: 'Full platform control with white-label branding' },
  ]);

  const [form, setForm] = useState({
    clubName: '',
    slug: '',
    description: '',
    location: '',
    website: '',
    contactEmail: '',
    contactPhone: '',
    selectedTier: 'free',
    adminEmail: '',
    adminPassword: '',
    adminConfirmPassword: '',
    adminFirstName: '',
    adminLastName: '',
  });

  function updateForm(field: string, value: string) {
    setForm(prev => {
      const updated = { ...prev, [field]: value };
      if (field === 'clubName' && !prev.slug) {
        updated.slug = slugify(value);
      }
      return updated;
    });
    if (field === 'slug') {
      setSlugAvailable(null);
    }
  }

  async function checkSlug() {
    if (!form.slug) return;
    setSlugChecking(true);
    try {
      const res = await fetch('/api/onboarding/check-slug', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: form.slug }),
      });
      const data = await res.json();
      setSlugAvailable(data.available);
      if (data.slug) updateForm('slug', data.slug);
    } catch {
      setSlugAvailable(null);
    } finally {
      setSlugChecking(false);
    }
  }

  function canProceed(): boolean {
    if (step === 0) return !!form.clubName.trim() && !!form.slug.trim() && slugAvailable !== false;
    if (step === 1) return true;
    if (step === 2) return !!form.selectedTier;
    if (step === 3) return !!form.adminEmail.trim() && !!form.adminPassword && form.adminPassword === form.adminConfirmPassword && form.adminPassword.length >= 8;
    return true;
  }

  async function handleNext() {
    setError('');
    if (step === 3) {
      await handleSubmit();
      return;
    }
    setStep(s => s + 1);
  }

  async function handleSubmit() {
    setLoading(true);
    try {
      const res = await fetch('/api/onboarding/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clubName: form.clubName,
          slug: form.slug,
          description: form.description,
          location: form.location,
          website: form.website,
          contactEmail: form.contactEmail || form.adminEmail,
          contactPhone: form.contactPhone,
          adminFirstName: form.adminFirstName,
          adminLastName: form.adminLastName,
          adminEmail: form.adminEmail,
          adminPassword: form.adminPassword,
          subscriptionTier: form.selectedTier,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Registration failed. Please try again.');
        return;
      }
      setUpgradeRequired(!!data.upgradeRequired);
      setRegisteredEmail(form.adminEmail);
      setStep(4);
    } catch {
      setError('Network error. Please check your connection and try again.');
    } finally {
      setLoading(false);
    }
  }

  const handleStartUpgrade = useCallback(async () => {
    setUpgradeError('');
    setUpgradeLoading(true);
    try {
      const loaded = await loadRazorpayScript();
      if (!loaded) {
        setUpgradeError('Failed to load payment gateway. Please check your connection.');
        return;
      }

      const subRes = await fetch('/api/onboarding/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ targetTier: form.selectedTier }),
      });
      const subData: SubscriptionState & { error?: string } = await subRes.json();
      if (!subRes.ok) {
        setUpgradeError(subData.error ?? 'Failed to initiate subscription.');
        return;
      }

      const rzp = new window.Razorpay({
        key: subData.keyId,
        subscription_id: subData.subscriptionId,
        name: 'KHARAGOLF',
        description: `${subData.tierLabel} Plan — ₹${subData.priceMonthly.toLocaleString('en-IN')}/month`,
        prefill: { email: registeredEmail },
        theme: { color: '#16a34a' },
        handler: async (response: { razorpay_subscription_id: string; razorpay_payment_id: string; razorpay_signature: string }) => {
          try {
            const verRes = await fetch('/api/onboarding/subscribe/verify', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              credentials: 'include',
              body: JSON.stringify({
                razorpaySubscriptionId: response.razorpay_subscription_id,
                razorpayPaymentId: response.razorpay_payment_id,
                razorpaySignature: response.razorpay_signature,
              }),
            });
            if (verRes.ok) {
              setPaymentComplete(true);
              setTimeout(() => { window.location.href = '/'; }, 2000);
            } else {
              const verData = await verRes.json();
              setUpgradeError(verData.error ?? 'Payment verification failed. Contact support.');
            }
          } catch {
            setUpgradeError('Payment verification failed. Contact support.');
          }
        },
      });
      rzp.open();
    } catch {
      setUpgradeError('Unexpected error. Please try again.');
    } finally {
      setUpgradeLoading(false);
    }
  }, [form.selectedTier, registeredEmail]);

  if (step === 4) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-4">
        <div className="max-w-md w-full text-center">
          <div className={`w-20 h-20 rounded-full flex items-center justify-center mx-auto mb-6 shadow-[0_0_40px_rgba(34,197,94,0.3)] ${paymentComplete ? 'bg-primary/30' : 'bg-primary/20'}`}>
            <CheckCircle2 className="w-10 h-10 text-primary" />
          </div>
          <h1 className="text-3xl font-bold text-white mb-3">
            {paymentComplete ? 'Upgrade complete!' : 'Welcome aboard!'}
          </h1>
          <p className="text-muted-foreground mb-2">
            <span className="text-white font-semibold">{form.clubName}</span>{' '}
            {paymentComplete
              ? `is now on the ${form.selectedTier.charAt(0).toUpperCase() + form.selectedTier.slice(1)} plan. Redirecting to your dashboard…`
              : 'has been registered successfully on the Free plan.'}
          </p>

          {upgradeRequired && !paymentComplete ? (
            <div className="mt-4 p-4 bg-amber-500/10 border border-amber-500/30 rounded-xl text-left space-y-3">
              <div className="flex items-center gap-2">
                <CreditCard className="w-4 h-4 text-amber-400 flex-shrink-0" />
                <strong className="text-amber-300 text-sm">
                  Complete upgrade to {form.selectedTier.charAt(0).toUpperCase() + form.selectedTier.slice(1)}
                </strong>
              </div>
              <p className="text-xs text-amber-200/70">
                Your club is live on the Free plan. Pay now to unlock all {form.selectedTier.charAt(0).toUpperCase() + form.selectedTier.slice(1)} features, or skip and upgrade later from Settings → Billing.
              </p>
              {upgradeError && (
                <p className="text-xs text-red-400 flex items-center gap-1">
                  <AlertCircle className="w-3 h-3" /> {upgradeError}
                </p>
              )}
              <Button
                onClick={handleStartUpgrade}
                disabled={upgradeLoading}
                className="w-full bg-amber-500 hover:bg-amber-600 text-black font-bold h-10"
              >
                {upgradeLoading ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <>Pay ₹{plans.find(p => p.tier === form.selectedTier)?.priceMonthly?.toLocaleString('en-IN') ?? ''}/month</>
                )}
              </Button>
              <button
                onClick={() => window.location.href = '/'}
                className="w-full text-xs text-muted-foreground hover:text-primary transition-colors pt-1"
              >
                Skip for now — upgrade later
              </button>
            </div>
          ) : !paymentComplete ? (
            <p className="text-sm text-muted-foreground mb-6">
              You are signed in. Go to your dashboard to start managing tournaments.
            </p>
          ) : null}

          {!upgradeRequired && (
            <Button
              onClick={() => window.location.href = '/'}
              className="w-full bg-primary hover:bg-primary/90 h-11 font-semibold mt-4"
            >
              Go to dashboard
            </Button>
          )}
          <button
            onClick={() => navigate('/clubs')}
            className="mt-3 w-full text-sm text-muted-foreground hover:text-primary transition-colors"
          >
            Browse clubs directory
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <div className="border-b border-border bg-card/50">
        <div className="max-w-2xl mx-auto px-4 py-4 flex items-center justify-between">
          <button onClick={() => navigate('/')} className="flex items-center gap-2">
            <img src="/logo.png" alt="KHARAGOLF" className="w-7 h-7 object-contain" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
            <span className="font-bold text-white text-lg">KHARAGOLF</span>
          </button>
          <span className="text-sm text-muted-foreground">Club Registration</span>
        </div>
      </div>

      <div className="max-w-2xl mx-auto px-4 py-8">
        {/* Progress */}
        <div className="flex items-center gap-2 mb-8">
          {STEPS.slice(0, -1).map((s, i) => (
            <div key={s} className="flex items-center gap-2 flex-1">
              <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 transition-all ${
                i < step ? 'bg-primary text-primary-foreground' :
                i === step ? 'bg-primary/20 border-2 border-primary text-primary' :
                'bg-muted text-muted-foreground'
              }`}>
                {i < step ? <Check className="w-4 h-4" /> : i + 1}
              </div>
              <span className={`text-xs font-medium hidden sm:block ${i === step ? 'text-white' : 'text-muted-foreground'}`}>{s}</span>
              {i < STEPS.length - 2 && <div className={`flex-1 h-px ${i < step ? 'bg-primary' : 'bg-border'}`} />}
            </div>
          ))}
        </div>

        <div className="bg-card border border-border rounded-2xl p-6 shadow-xl">
          {/* Step 0: Club Details */}
          {step === 0 && (
            <div className="space-y-5">
              <div>
                <h2 className="text-xl font-bold text-white mb-1">Tell us about your club</h2>
                <p className="text-sm text-muted-foreground">Basic information about your golf club or association.</p>
              </div>
              <div>
                <label className="block text-sm text-muted-foreground mb-1.5">Club Name *</label>
                <div className="relative">
                  <Building2 className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                  <Input
                    value={form.clubName}
                    onChange={e => updateForm('clubName', e.target.value)}
                    placeholder="e.g. Kharagpur Golf Club"
                    className="pl-9 bg-background border-border text-white"
                  />
                </div>
              </div>
              <div>
                <label className="block text-sm text-muted-foreground mb-1.5">Club URL *</label>
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <Globe2 className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                    <Input
                      value={form.slug}
                      onChange={e => updateForm('slug', e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'))}
                      onBlur={checkSlug}
                      placeholder="your-club-name"
                      className="pl-9 bg-background border-border text-white"
                    />
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={checkSlug}
                    disabled={slugChecking || !form.slug}
                    className="flex-shrink-0"
                  >
                    {slugChecking ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Check'}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  Your club page: <span className="text-primary">kharagolf.app/clubs/{form.slug || 'your-club'}</span>
                </p>
                {slugAvailable === true && (
                  <p className="text-xs text-green-400 mt-1 flex items-center gap-1"><Check className="w-3 h-3" /> This URL is available!</p>
                )}
                {slugAvailable === false && (
                  <p className="text-xs text-red-400 mt-1 flex items-center gap-1"><AlertCircle className="w-3 h-3" /> This URL is already taken. Try another.</p>
                )}
              </div>
              <div>
                <label className="block text-sm text-muted-foreground mb-1.5">Description <span className="text-xs">(optional)</span></label>
                <textarea
                  value={form.description}
                  onChange={e => updateForm('description', e.target.value)}
                  placeholder="A brief description of your club..."
                  rows={3}
                  className="w-full bg-background border border-border rounded-lg px-3 py-2 text-white text-sm resize-none focus:outline-none focus:ring-2 focus:ring-primary/50"
                />
              </div>
              <div>
                <label className="block text-sm text-muted-foreground mb-1.5">Location <span className="text-xs">(optional)</span></label>
                <div className="relative">
                  <MapPin className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                  <Input
                    value={form.location}
                    onChange={e => updateForm('location', e.target.value)}
                    placeholder="e.g. Kharagpur, West Bengal, India"
                    className="pl-9 bg-background border-border text-white"
                  />
                </div>
              </div>
            </div>
          )}

          {/* Step 1: Contact */}
          {step === 1 && (
            <div className="space-y-5">
              <div>
                <h2 className="text-xl font-bold text-white mb-1">Contact details</h2>
                <p className="text-sm text-muted-foreground">How players and members can reach your club.</p>
              </div>
              <div>
                <label className="block text-sm text-muted-foreground mb-1.5">Club Email</label>
                <div className="relative">
                  <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                  <Input
                    type="email"
                    value={form.contactEmail}
                    onChange={e => updateForm('contactEmail', e.target.value)}
                    placeholder="info@yourclub.com"
                    className="pl-9 bg-background border-border text-white"
                  />
                </div>
              </div>
              <div>
                <label className="block text-sm text-muted-foreground mb-1.5">Phone Number</label>
                <div className="relative">
                  <Phone className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                  <Input
                    type="tel"
                    value={form.contactPhone}
                    onChange={e => updateForm('contactPhone', e.target.value)}
                    placeholder="+91 00000 00000"
                    className="pl-9 bg-background border-border text-white"
                  />
                </div>
              </div>
              <div>
                <label className="block text-sm text-muted-foreground mb-1.5">Website</label>
                <div className="relative">
                  <Globe className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                  <Input
                    type="url"
                    value={form.website}
                    onChange={e => updateForm('website', e.target.value)}
                    placeholder="https://yourclub.com"
                    className="pl-9 bg-background border-border text-white"
                  />
                </div>
              </div>
            </div>
          )}

          {/* Step 2: Plan Selection */}
          {step === 2 && (
            <div className="space-y-5">
              <div>
                <h2 className="text-xl font-bold text-white mb-1">Choose your plan</h2>
                <p className="text-sm text-muted-foreground">You can upgrade or downgrade anytime from your dashboard.</p>
              </div>
              <div className="space-y-3">
                {plans.map((plan) => (
                  <button
                    key={plan.tier}
                    onClick={() => updateForm('selectedTier', plan.tier)}
                    className={`w-full text-left border rounded-xl p-4 transition-all ${
                      form.selectedTier === plan.tier
                        ? `${PLAN_COLORS[plan.tier]} bg-primary/5 ring-1 ring-primary/30`
                        : 'border-border hover:border-white/20'
                    }`}
                  >
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <span className={`p-1.5 rounded-lg ${PLAN_BADGE_COLORS[plan.tier]}`}>
                          {PLAN_ICONS[plan.tier]}
                        </span>
                        <span className="font-semibold text-white">{plan.label}</span>
                        {plan.tier === 'pro' && (
                          <Badge className="bg-primary/20 text-primary border-primary/30 text-xs">Popular</Badge>
                        )}
                      </div>
                      <div className="text-right">
                        {plan.priceMonthly === 0 ? (
                          <span className="text-xl font-bold text-white">Free</span>
                        ) : (
                          <span className="text-xl font-bold text-white">₹{plan.priceMonthly.toLocaleString('en-IN')}<span className="text-sm font-normal text-muted-foreground">/mo</span></span>
                        )}
                      </div>
                    </div>
                    <p className="text-sm text-muted-foreground mb-2">{plan.description}</p>
                    <div className="flex flex-wrap gap-1">
                      {PLAN_FEATURES[plan.tier]?.map(f => (
                        <span key={f} className="text-xs text-muted-foreground flex items-center gap-1">
                          <Check className="w-3 h-3 text-primary flex-shrink-0" />{f}
                        </span>
                      ))}
                    </div>
                  </button>
                ))}
              </div>
              <div className="p-3 bg-amber-500/10 border border-amber-500/30 rounded-lg text-xs text-amber-300">
                <strong>How billing works:</strong> Your club always starts on the <span className="font-semibold">Free plan</span> first.
                After signing in, you can upgrade to{' '}
                {form.selectedTier !== 'free' ? <span className="font-semibold">{form.selectedTier.charAt(0).toUpperCase() + form.selectedTier.slice(1)}</span> : 'a paid plan'}{' '}
                and complete payment via Razorpay — no upfront charge required during registration.
              </div>
            </div>
          )}

          {/* Step 3: Admin Account */}
          {step === 3 && (
            <div className="space-y-5">
              <div>
                <h2 className="text-xl font-bold text-white mb-1">Create your admin account</h2>
                <p className="text-sm text-muted-foreground">This will be the primary administrator account for your club.</p>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm text-muted-foreground mb-1.5">First Name</label>
                  <Input
                    value={form.adminFirstName}
                    onChange={e => updateForm('adminFirstName', e.target.value)}
                    placeholder="John"
                    className="bg-background border-border text-white"
                  />
                </div>
                <div>
                  <label className="block text-sm text-muted-foreground mb-1.5">Last Name</label>
                  <Input
                    value={form.adminLastName}
                    onChange={e => updateForm('adminLastName', e.target.value)}
                    placeholder="Smith"
                    className="bg-background border-border text-white"
                  />
                </div>
              </div>
              <div>
                <label className="block text-sm text-muted-foreground mb-1.5">Email Address *</label>
                <div className="relative">
                  <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                  <Input
                    type="email"
                    value={form.adminEmail}
                    onChange={e => updateForm('adminEmail', e.target.value)}
                    placeholder="admin@yourclub.com"
                    className="pl-9 bg-background border-border text-white"
                  />
                </div>
              </div>
              <div>
                <label className="block text-sm text-muted-foreground mb-1.5">Password *</label>
                <Input
                  type="password"
                  value={form.adminPassword}
                  onChange={e => updateForm('adminPassword', e.target.value)}
                  placeholder="Min. 8 characters"
                  className="bg-background border-border text-white"
                />
              </div>
              <div>
                <label className="block text-sm text-muted-foreground mb-1.5">Confirm Password *</label>
                <Input
                  type="password"
                  value={form.adminConfirmPassword}
                  onChange={e => updateForm('adminConfirmPassword', e.target.value)}
                  placeholder="Repeat password"
                  className="bg-background border-border text-white"
                />
                {form.adminConfirmPassword && form.adminPassword !== form.adminConfirmPassword && (
                  <p className="text-xs text-red-400 mt-1">Passwords do not match</p>
                )}
              </div>
              <div className="p-3 bg-muted/30 border border-border rounded-lg text-xs text-muted-foreground">
                <strong className="text-white">Summary:</strong>{' '}
                Registering <span className="text-white">{form.clubName}</span> on the <span className="text-primary capitalize">{form.selectedTier}</span> plan.
              </div>
            </div>
          )}

          {error && (
            <div className="mt-4 p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-sm flex items-center gap-2">
              <AlertCircle className="w-4 h-4 flex-shrink-0" />
              {error}
            </div>
          )}

          <div className="flex gap-3 mt-6">
            {step > 0 && (
              <Button variant="outline" onClick={() => { setStep(s => s - 1); setError(''); }} className="flex-1">
                <ChevronLeft className="w-4 h-4 mr-1" /> Back
              </Button>
            )}
            <Button
              onClick={handleNext}
              disabled={!canProceed() || loading}
              className="flex-1 bg-primary hover:bg-primary/90 font-semibold h-11"
            >
              {loading ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : step === 3 ? (
                'Create Club'
              ) : (
                <>Next <ChevronRight className="w-4 h-4 ml-1" /></>
              )}
            </Button>
          </div>
        </div>

        <p className="text-center text-sm text-muted-foreground mt-4">
          Already have an account?{' '}
          <button onClick={() => navigate('/login')} className="text-primary hover:underline">Sign in</button>
        </p>
      </div>
    </div>
  );
}
