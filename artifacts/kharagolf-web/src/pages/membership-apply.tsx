import { useState } from 'react';
import { useParams } from 'wouter';
import { useQuery, useMutation } from '@tanstack/react-query';
import { motion, AnimatePresence } from 'framer-motion';
import {
  ChevronRight, ChevronLeft, CheckCircle2, User, Trophy,
  Users, FileText, Loader2, AlertCircle,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';

const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');

interface OrgInfo {
  id: number;
  name: string;
  logoUrl: string | null;
  primaryColor: string | null;
  description: string | null;
}
interface Tier {
  id: number;
  name: string;
  description: string | null;
  annualFee: string;
  currency: string;
}

const STEPS = [
  { id: 0, label: 'Personal Details', icon: User },
  { id: 1, label: 'Golf Background', icon: Trophy },
  { id: 2, label: 'Proposer & Seconder', icon: Users },
  { id: 3, label: 'Review & Submit', icon: FileText },
];

const currencySymbol: Record<string, string> = { INR: '₹', USD: '$', GBP: '£', EUR: '€' };

export default function MembershipApplyPage() {
  const { orgSlug } = useParams<{ orgSlug: string }>();
  const { toast } = useToast();
  const [step, setStep] = useState(0);
  const [submitted, setSubmitted] = useState<{ referenceCode: string } | null>(null);

  const [form, setForm] = useState({
    firstName: '',
    lastName: '',
    email: '',
    phone: '',
    dateOfBirth: '',
    address: '',
    tierId: '',
    golfBackground: '',
    currentHandicap: '',
    previousClub: '',
    yearsPlaying: '',
    proposerName: '',
    proposerMemberNumber: '',
    seconderName: '',
    seconderMemberNumber: '',
  });

  const { data, isLoading, error } = useQuery({
    queryKey: ['apply-org', orgSlug],
    queryFn: async () => {
      const res = await fetch(`${BASE}/api/public/organizations/${orgSlug}/apply`);
      if (!res.ok) throw new Error('Organization not found');
      return res.json() as Promise<{ org: OrgInfo; tiers: Tier[] }>;
    },
    enabled: Boolean(orgSlug),
  });

  const submitMutation = useMutation({
    mutationFn: async (payload: typeof form) => {
      const res = await fetch(`${BASE}/api/public/organizations/${orgSlug}/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...payload,
          tierId: payload.tierId || undefined,
          currentHandicap: payload.currentHandicap ? Number(payload.currentHandicap) : undefined,
          yearsPlaying: payload.yearsPlaying ? Number(payload.yearsPlaying) : undefined,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? 'Submission failed');
      }
      return res.json() as Promise<{ referenceCode: string }>;
    },
    onSuccess: (data) => {
      setSubmitted(data);
    },
    onError: (err: Error) => {
      toast({ title: 'Submission failed', description: err.message, variant: 'destructive' });
    },
  });

  const set = (key: keyof typeof form, val: string) => setForm(f => ({ ...f, [key]: val }));

  const canGoNext = () => {
    if (step === 0) return form.firstName.trim() && form.lastName.trim() && form.email.trim();
    return true;
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-[#0a0a0a] flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-green-500" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="min-h-screen bg-[#0a0a0a] flex items-center justify-center text-center px-4">
        <div>
          <AlertCircle className="w-12 h-12 text-red-400 mx-auto mb-4" />
          <h2 className="text-white text-xl font-bold mb-2">Club Not Found</h2>
          <p className="text-gray-400">The membership application link appears to be invalid.</p>
        </div>
      </div>
    );
  }

  const { org, tiers } = data;
  const primaryColor = /^#[0-9a-fA-F]{3,6}$/.test(org.primaryColor ?? '') ? org.primaryColor! : '#1e4d2b';

  if (submitted) {
    return (
      <div className="min-h-screen bg-[#0a0a0a] flex items-center justify-center px-4">
        <motion.div
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          className="max-w-md w-full text-center"
        >
          <div className="w-20 h-20 rounded-full bg-green-500/20 flex items-center justify-center mx-auto mb-6">
            <CheckCircle2 className="w-10 h-10 text-green-400" />
          </div>
          <h1 className="text-white text-3xl font-bold mb-3">Application Submitted!</h1>
          <p className="text-gray-400 mb-8">
            Thank you for applying to join <strong className="text-white">{org.name}</strong>. 
            We'll review your application and keep you informed by email.
          </p>
          <div className="bg-[#111] border border-white/10 rounded-xl p-6 mb-6">
            <p className="text-gray-500 text-xs uppercase tracking-widest mb-2">Your Reference Code</p>
            <p className="text-green-400 text-3xl font-mono font-bold tracking-widest">{submitted.referenceCode}</p>
            <p className="text-gray-500 text-sm mt-2">Please keep this safe for future enquiries.</p>
          </div>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0a0a0a]">
      {/* Header */}
      <div className="w-full py-8 px-4" style={{ background: `linear-gradient(135deg, ${primaryColor} 0%, #0a0a0a 100%)` }}>
        <div className="max-w-2xl mx-auto text-center">
          {org.logoUrl && (
            <img src={org.logoUrl} alt={org.name} className="h-14 object-contain mx-auto mb-4" />
          )}
          <h1 className="text-white text-3xl font-bold tracking-tight">{org.name}</h1>
          <p className="text-white/70 text-sm mt-1 uppercase tracking-widest">Membership Application</p>
        </div>
      </div>

      <div className="max-w-2xl mx-auto px-4 py-8">
        {/* Step Indicators */}
        <div className="flex items-center justify-between mb-8">
          {STEPS.map((s, idx) => {
            const Icon = s.icon;
            const active = idx === step;
            const done = idx < step;
            return (
              <div key={s.id} className="flex items-center flex-1">
                <div className={`flex items-center gap-2 ${active ? 'text-green-400' : done ? 'text-green-600' : 'text-gray-600'}`}>
                  <div className={`w-8 h-8 rounded-full flex items-center justify-center border-2 flex-shrink-0 transition-all
                    ${active ? 'border-green-400 bg-green-400/10' : done ? 'border-green-600 bg-green-600/10' : 'border-gray-700 bg-transparent'}`}>
                    {done ? <CheckCircle2 className="w-4 h-4" /> : <Icon className="w-4 h-4" />}
                  </div>
                  <span className="text-xs font-medium hidden sm:block">{s.label}</span>
                </div>
                {idx < STEPS.length - 1 && (
                  <div className={`flex-1 h-px mx-2 ${done ? 'bg-green-600' : 'bg-gray-800'}`} />
                )}
              </div>
            );
          })}
        </div>

        <AnimatePresence mode="wait">
          <motion.div
            key={step}
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -20 }}
            transition={{ duration: 0.2 }}
          >
            {step === 0 && (
              <Card className="bg-[#111] border-white/10">
                <CardHeader>
                  <CardTitle className="text-white">Personal Details</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                      <Label className="text-gray-400">First Name *</Label>
                      <Input value={form.firstName} onChange={e => set('firstName', e.target.value)}
                        className="bg-white/5 border-white/10 text-white" placeholder="Jane" />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-gray-400">Last Name *</Label>
                      <Input value={form.lastName} onChange={e => set('lastName', e.target.value)}
                        className="bg-white/5 border-white/10 text-white" placeholder="Smith" />
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-gray-400">Email Address *</Label>
                    <Input type="email" value={form.email} onChange={e => set('email', e.target.value)}
                      className="bg-white/5 border-white/10 text-white" placeholder="jane@example.com" />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-gray-400">Phone Number</Label>
                    <Input value={form.phone} onChange={e => set('phone', e.target.value)}
                      className="bg-white/5 border-white/10 text-white" placeholder="+91 9999 999999" />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-gray-400">Date of Birth</Label>
                    <Input type="date" value={form.dateOfBirth} onChange={e => set('dateOfBirth', e.target.value)}
                      className="bg-white/5 border-white/10 text-white" />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-gray-400">Address</Label>
                    <Textarea value={form.address} onChange={e => set('address', e.target.value)}
                      className="bg-white/5 border-white/10 text-white resize-none" rows={2} placeholder="Street, City, State" />
                  </div>

                  {tiers.length > 0 && (
                    <div className="space-y-1.5">
                      <Label className="text-gray-400">Preferred Membership Category</Label>
                      <Select value={form.tierId} onValueChange={v => set('tierId', v)}>
                        <SelectTrigger className="bg-white/5 border-white/10 text-white">
                          <SelectValue placeholder="Select a membership tier (optional)" />
                        </SelectTrigger>
                        <SelectContent className="bg-[#1a1a2e] border-white/10">
                          {tiers.map(tier => (
                            <SelectItem key={tier.id} value={String(tier.id)} className="text-white focus:bg-white/10">
                              <span>{tier.name}</span>
                              <span className="text-gray-400 ml-2">
                                {currencySymbol[tier.currency] ?? ''}{Number(tier.annualFee).toLocaleString()}/yr
                              </span>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                </CardContent>
              </Card>
            )}

            {step === 1 && (
              <Card className="bg-[#111] border-white/10">
                <CardHeader>
                  <CardTitle className="text-white">Golf Background</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-1.5">
                    <Label className="text-gray-400">Tell us about your golf background</Label>
                    <Textarea value={form.golfBackground} onChange={e => set('golfBackground', e.target.value)}
                      className="bg-white/5 border-white/10 text-white resize-none" rows={4}
                      placeholder="How long have you been playing? What's your experience level? Any tournaments or leagues?" />
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                      <Label className="text-gray-400">Current Handicap Index</Label>
                      <Input type="number" step="0.1" min="0" max="54"
                        value={form.currentHandicap} onChange={e => set('currentHandicap', e.target.value)}
                        className="bg-white/5 border-white/10 text-white" placeholder="e.g. 18.4" />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-gray-400">Years Playing Golf</Label>
                      <Input type="number" min="0" value={form.yearsPlaying} onChange={e => set('yearsPlaying', e.target.value)}
                        className="bg-white/5 border-white/10 text-white" placeholder="e.g. 5" />
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-gray-400">Previous / Current Club</Label>
                    <Input value={form.previousClub} onChange={e => set('previousClub', e.target.value)}
                      className="bg-white/5 border-white/10 text-white" placeholder="Name of previous or current club" />
                  </div>
                </CardContent>
              </Card>
            )}

            {step === 2 && (
              <Card className="bg-[#111] border-white/10">
                <CardHeader>
                  <CardTitle className="text-white">Proposer & Seconder</CardTitle>
                  <p className="text-gray-400 text-sm mt-1">
                    If the club requires a proposer and seconder, please provide their details. Leave blank if not required.
                  </p>
                </CardHeader>
                <CardContent className="space-y-6">
                  <div className="space-y-3">
                    <p className="text-white text-sm font-medium">Proposer</p>
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-1.5">
                        <Label className="text-gray-400">Full Name</Label>
                        <Input value={form.proposerName} onChange={e => set('proposerName', e.target.value)}
                          className="bg-white/5 border-white/10 text-white" placeholder="John Doe" />
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-gray-400">Member Number</Label>
                        <Input value={form.proposerMemberNumber} onChange={e => set('proposerMemberNumber', e.target.value)}
                          className="bg-white/5 border-white/10 text-white" placeholder="MBR-0001" />
                      </div>
                    </div>
                  </div>
                  <div className="space-y-3">
                    <p className="text-white text-sm font-medium">Seconder</p>
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-1.5">
                        <Label className="text-gray-400">Full Name</Label>
                        <Input value={form.seconderName} onChange={e => set('seconderName', e.target.value)}
                          className="bg-white/5 border-white/10 text-white" placeholder="Jane Smith" />
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-gray-400">Member Number</Label>
                        <Input value={form.seconderMemberNumber} onChange={e => set('seconderMemberNumber', e.target.value)}
                          className="bg-white/5 border-white/10 text-white" placeholder="MBR-0002" />
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            )}

            {step === 3 && (
              <Card className="bg-[#111] border-white/10">
                <CardHeader>
                  <CardTitle className="text-white">Review & Submit</CardTitle>
                </CardHeader>
                <CardContent className="space-y-6">
                  <div className="space-y-3">
                    <p className="text-xs text-gray-500 uppercase tracking-widest">Personal Details</p>
                    <div className="grid grid-cols-2 gap-2 text-sm">
                      <div><span className="text-gray-500">Name:</span> <span className="text-white ml-1">{form.firstName} {form.lastName}</span></div>
                      <div><span className="text-gray-500">Email:</span> <span className="text-white ml-1">{form.email}</span></div>
                      {form.phone && <div><span className="text-gray-500">Phone:</span> <span className="text-white ml-1">{form.phone}</span></div>}
                      {form.dateOfBirth && <div><span className="text-gray-500">DOB:</span> <span className="text-white ml-1">{form.dateOfBirth}</span></div>}
                      {form.address && <div className="col-span-2"><span className="text-gray-500">Address:</span> <span className="text-white ml-1">{form.address}</span></div>}
                      {form.tierId && data?.tiers && (
                        <div><span className="text-gray-500">Category:</span> <span className="text-white ml-1">
                          {data.tiers.find(t => String(t.id) === form.tierId)?.name}
                        </span></div>
                      )}
                    </div>
                  </div>

                  {(form.golfBackground || form.currentHandicap || form.previousClub) && (
                    <div className="space-y-3">
                      <p className="text-xs text-gray-500 uppercase tracking-widest">Golf Background</p>
                      <div className="grid grid-cols-2 gap-2 text-sm">
                        {form.currentHandicap && <div><span className="text-gray-500">HCP:</span> <span className="text-white ml-1">{form.currentHandicap}</span></div>}
                        {form.yearsPlaying && <div><span className="text-gray-500">Years playing:</span> <span className="text-white ml-1">{form.yearsPlaying}</span></div>}
                        {form.previousClub && <div className="col-span-2"><span className="text-gray-500">Previous club:</span> <span className="text-white ml-1">{form.previousClub}</span></div>}
                        {form.golfBackground && <div className="col-span-2"><span className="text-gray-500">Background:</span> <span className="text-white ml-1">{form.golfBackground}</span></div>}
                      </div>
                    </div>
                  )}

                  {(form.proposerName || form.seconderName) && (
                    <div className="space-y-3">
                      <p className="text-xs text-gray-500 uppercase tracking-widest">Proposer & Seconder</p>
                      <div className="grid grid-cols-2 gap-2 text-sm">
                        {form.proposerName && <div><span className="text-gray-500">Proposer:</span> <span className="text-white ml-1">{form.proposerName} {form.proposerMemberNumber && `(${form.proposerMemberNumber})`}</span></div>}
                        {form.seconderName && <div><span className="text-gray-500">Seconder:</span> <span className="text-white ml-1">{form.seconderName} {form.seconderMemberNumber && `(${form.seconderMemberNumber})`}</span></div>}
                      </div>
                    </div>
                  )}

                  <div className="bg-green-500/10 border border-green-500/20 rounded-lg p-4">
                    <p className="text-green-400 text-sm">
                      By submitting this application, you confirm that all information provided is accurate.
                      The club will contact you regarding the status of your application.
                    </p>
                  </div>
                </CardContent>
              </Card>
            )}
          </motion.div>
        </AnimatePresence>

        {/* Navigation */}
        <div className="flex items-center justify-between mt-6">
          <Button variant="outline" onClick={() => setStep(s => s - 1)} disabled={step === 0}
            className="border-white/10 text-gray-300 hover:bg-white/5">
            <ChevronLeft className="w-4 h-4 mr-1" /> Back
          </Button>

          {step < STEPS.length - 1 ? (
            <Button onClick={() => setStep(s => s + 1)} disabled={!canGoNext()}
              className="bg-green-600 hover:bg-green-700 text-white">
              Next <ChevronRight className="w-4 h-4 ml-1" />
            </Button>
          ) : (
            <Button onClick={() => submitMutation.mutate(form)}
              disabled={submitMutation.isPending}
              className="bg-green-600 hover:bg-green-700 text-white px-8">
              {submitMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
              Submit Application
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
