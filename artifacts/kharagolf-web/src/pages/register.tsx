import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { getLocale } from '@/i18n';
import { PreAuthBrand } from '@/components/PreAuthBrand';
import { useParams, useLocation, useSearch } from 'wouter';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { CheckCircle2, Trophy, MapPin, Calendar, CalendarPlus, Users, AlertCircle, Loader2, ShoppingBag, Tag, ChevronDown, Upload } from 'lucide-react';
import { PriceWithFx } from '@/components/PriceWithFx';
import { StripeCheckoutDialog } from '@/components/StripeCheckoutDialog';

interface RegFormField {
  id: number;
  fieldType: 'short_text' | 'long_text' | 'dropdown' | 'checkbox' | 'file_upload' | 'terms_acceptance';
  label: string;
  placeholder?: string | null;
  helpText?: string | null;
  options?: string[] | null;
  required: boolean;
  conditionalOnFieldId?: number | null;
  conditionalOnValue?: string | null;
  termsText?: string | null;
}

interface TournamentMerchandiseItem {
  id: number;
  productId: number;
  productName: string;
  productCategory: string;
  price: string;
  imageUrl: string | null;
  stockCount: number | null;
  note: string | null;
  variants: { id: number; label: string; price: string; stock: number }[];
}

const CURRENCY_SYMBOLS: Record<string, string> = {
  INR: '₹', USD: '$', GBP: '£', AED: 'د.إ', EUR: '€', SGD: 'S$', AUD: 'A$',
};

interface TournamentInfo {
  id: number;
  name: string;
  description?: string;
  format: string;
  status: string;
  startDate?: string;
  endDate?: string;
  maxPlayers?: number;
  entryFee?: string | null;
  memberEntryFee?: string | null;
  currency?: string;
  rounds?: number;
  courseName?: string;
  organizationName: string;
  organizationId?: number;
  defaultLanguage?: string;
  playerCount: number;
  isFull: boolean;
  membersOnly?: boolean;
}

export default function Register() {
  const params = useParams<{ orgId: string; tournamentId: string }>();
  const orgId = params.orgId;
  const tournamentId = params.tournamentId;
  const [, navigate] = useLocation();
  const { i18n, t } = useTranslation('register');
  const search = useSearch();
  const inviteToken = new URLSearchParams(search).get('invite') ?? undefined;

  const [tournament, setTournament] = useState<TournamentInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [merchandise, setMerchandise] = useState<TournamentMerchandiseItem[]>([]);
  const [selectedMerch, setSelectedMerch] = useState<Record<number, number>>({}); // productId -> qty
  const [orderingMerch, setOrderingMerch] = useState(false);
  const [merchOrdered, setMerchOrdered] = useState(false);
  const [merchOrderMessage, setMerchOrderMessage] = useState('');

  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [handicap, setHandicap] = useState('');
  const [teeBox, setTeeBox] = useState('white');

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [waitlistSuccess, setWaitlistSuccess] = useState(false);
  const [waitlistPosition, setWaitlistPosition] = useState<number | null>(null);
  const [registeredName, setRegisteredName] = useState('');
  const [registeredPlayerId, setRegisteredPlayerId] = useState<number | null>(null);
  const [paymentDone, setPaymentDone] = useState(false);
  const [autoPayTriggered, setAutoPayTriggered] = useState(false);
  const [stripeCheckout, setStripeCheckout] = useState<{
    publishableKey: string; clientSecret: string; description: string; amountLabel: string;
  } | null>(null);

  // Custom registration form fields
  const [regFormFields, setRegFormFields] = useState<RegFormField[]>([]);
  const [regFormAnswers, setRegFormAnswers] = useState<Record<number, string>>({});
  const [regFormCheckboxAnswers, setRegFormCheckboxAnswers] = useState<Record<number, string[]>>({});
  const [regFormSubmitting, setRegFormSubmitting] = useState(false);
  const [regFormSubmitted, setRegFormSubmitted] = useState(false);
  const [regFormError, setRegFormError] = useState<string | null>(null);

  useEffect(() => {
    if (!orgId || !tournamentId) return;
    Promise.all([
      fetch(`/api/public/orgs/${orgId}/tournaments/${tournamentId}`),
      fetch(`/api/public/orgs/${orgId}/tournaments/${tournamentId}/merchandise`),
    ]).then(async ([tournamentRes, mercRes]) => {
      if (!tournamentRes.ok) {
        const data = await tournamentRes.json();
        setError(data.error || t('errors.tournamentNotFound'));
      } else {
        const data = await tournamentRes.json();
        setTournament(data);
        if (data.defaultLanguage && data.defaultLanguage !== i18n.language) {
          i18n.changeLanguage(data.defaultLanguage);
          document.documentElement.dir = data.defaultLanguage === 'ar' ? 'rtl' : 'ltr';
          document.documentElement.lang = data.defaultLanguage;
        }
      }
      if (mercRes.ok) {
        const mercData = await mercRes.json();
        setMerchandise(Array.isArray(mercData) ? mercData : []);
      }
    }).catch(() => setError(t('errors.failedToLoad')))
      .finally(() => setLoading(false));
  }, [orgId, tournamentId]);

  const handleRazorpayPayment = async () => {
    if (!registeredPlayerId) return;
    try {
      const res = await fetch(`/api/payments/tournament-player/${registeredPlayerId}/order`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      if (!res.ok) {
        alert(t('errors.couldNotCreateOrder'));
        return;
      }
      const order = await res.json() as {
        processor?: 'razorpay' | 'stripe';
        orderId: string; amount: number; currency: string;
        keyId?: string; stripePublishableKey?: string; clientSecret?: string;
        playerName?: string; email?: string; description?: string;
      };

      // ── Stripe path (non-INR clubs) ────────────────────────────────────
      if (order.processor === 'stripe') {
        if (!order.stripePublishableKey || !order.clientSecret) {
          alert(t('errors.paymentError'));
          return;
        }
        const sym = CURRENCY_SYMBOLS[order.currency] ?? `${order.currency} `;
        setStripeCheckout({
          publishableKey: order.stripePublishableKey,
          clientSecret: order.clientSecret,
          description: order.description ?? 'Tournament entry fee',
          amountLabel: `${sym}${(order.amount / 100).toLocaleString()}`,
        });
        return;
      }

      // ── Razorpay path (INR clubs) ──────────────────────────────────────
      const options = {
        key: order.keyId,
        amount: order.amount,
        currency: order.currency,
        name: 'KHARAGOLF',
        description: order.description,
        order_id: order.orderId,
        prefill: { name: order.playerName, email: order.email },
        theme: { color: '#22c55e' },
        handler: async (response: { razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string }) => {
          const verifyRes = await fetch(`/api/payments/tournament-player/${registeredPlayerId}/verify`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(response),
          });
          if (verifyRes.ok) {
            setPaymentDone(true);
          } else {
            alert(t('errors.paymentVerificationFailed'));
          }
        },
      };
      const rzp = new (window as any).Razorpay(options);
      rzp.open();
    } catch {
      alert(t('errors.paymentError'));
    }
  };

  const handleStripeSuccess = async ({ stripe_payment_intent_id }: { stripe_payment_intent_id: string }) => {
    if (!registeredPlayerId) return;
    const verifyRes = await fetch(`/api/payments/tournament-player/${registeredPlayerId}/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stripe_payment_intent_id }),
    });
    if (verifyRes.ok) {
      setPaymentDone(true);
      setStripeCheckout(null);
    } else {
      alert(t('errors.paymentVerificationFailed'));
    }
  };

  // Auto-launch Razorpay checkout immediately after successful registration when a fee is required
  useEffect(() => {
    if (success && registeredPlayerId && !paymentDone && !autoPayTriggered && tournament?.entryFee && parseFloat(tournament.entryFee) > 0) {
      setAutoPayTriggered(true);
      handleRazorpayPayment();
    }
  }, [success, registeredPlayerId, tournament?.entryFee]);

  // Fetch custom registration form fields after successful registration
  useEffect(() => {
    if (success && tournamentId) {
      fetch(`/api/public/event-forms/tournament/${tournamentId}/fields`)
        .then(r => r.ok ? r.json() : [])
        .then((fields: RegFormField[]) => setRegFormFields(fields))
        .catch(() => {});
    }
  }, [success, tournamentId]);

  const isRegFieldVisible = (field: RegFormField): boolean => {
    if (!field.conditionalOnFieldId) return true;
    const parentVal = regFormAnswers[field.conditionalOnFieldId] ?? '';
    return parentVal === (field.conditionalOnValue ?? '');
  };

  const handleRegFormCheckbox = (fieldId: number, option: string, checked: boolean) => {
    setRegFormCheckboxAnswers(prev => {
      const current = prev[fieldId] ?? [];
      return { ...prev, [fieldId]: checked ? [...current, option] : current.filter(o => o !== option) };
    });
  };

  const handleRegFormSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!registeredPlayerId) return;
    setRegFormError(null);

    const visibleFields = regFormFields.filter(isRegFieldVisible);
    for (const field of visibleFields) {
      if (!field.required) continue;
      if (field.fieldType === 'checkbox') {
        if ((regFormCheckboxAnswers[field.id] ?? []).length === 0) {
          setRegFormError(t('errors.isRequired', { label: field.label })); return;
        }
      } else if (!regFormAnswers[field.id]?.trim()) {
        setRegFormError(t('errors.isRequired', { label: field.label })); return;
      }
    }

    const answers: Record<string, string> = {};
    for (const field of visibleFields) {
      if (field.fieldType === 'checkbox') {
        answers[String(field.id)] = (regFormCheckboxAnswers[field.id] ?? []).join(', ');
      } else {
        answers[String(field.id)] = regFormAnswers[field.id] ?? '';
      }
    }

    setRegFormSubmitting(true);
    try {
      const res = await fetch(`/api/public/event-forms/tournament/${tournamentId}/responses`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entryId: registeredPlayerId, answers }),
      });
      if (res.ok) {
        setRegFormSubmitted(true);
      } else {
        const d = await res.json() as { error?: string };
        setRegFormError(d.error ?? t('errors.failedToSubmit'));
      }
    } catch {
      setRegFormError(t('errors.anError'));
    } finally {
      setRegFormSubmitting(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!firstName.trim() || !lastName.trim() || !email.trim()) {
      setSubmitError(t('errors.requiredFields'));
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await fetch(`/api/public/orgs/${orgId}/tournaments/${tournamentId}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ firstName, lastName, email, phone, handicapIndex: handicap || undefined, teeBox, inviteToken }),
      });
      const data = await res.json();
      if (res.status === 202) {
        // Added to waitlist
        setRegisteredName(`${firstName} ${lastName}`);
        setWaitlistPosition(data.position ?? null);
        setWaitlistSuccess(true);
      } else if (res.status === 403 && data.membersOnly) {
        setSubmitError(t('errors.membersOnly'));
      } else if (!res.ok) {
        setSubmitError(data.error || t('errors.registrationFailed'));
      } else {
        setRegisteredName(`${firstName} ${lastName}`);
        setRegisteredPlayerId(data.id ?? null);
        setSuccess(true);
      }
    } catch {
      setSubmitError(t('errors.anError'));
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <main id="main-content" tabIndex={-1} className="min-h-screen bg-[#0a0f0d] flex items-center justify-center focus:outline-none">
        <div className="flex flex-col items-center gap-4">
          <div className="relative">
            <div className="w-16 h-16 border-4 border-primary/20 rounded-full" />
            <div className="w-16 h-16 border-4 border-primary border-t-transparent rounded-full animate-spin absolute inset-0" />
          </div>
          <p className="text-primary text-sm font-medium tracking-widest">{t('loading')}</p>
        </div>
      </main>
    );
  }

  if (error) {
    return (
      <main id="main-content" tabIndex={-1} className="min-h-screen bg-[#0a0f0d] flex items-center justify-center p-4 focus:outline-none">
        <Card className="bg-black/40 border-white/10 max-w-md w-full text-center">
          <CardContent className="pt-10 pb-8 px-8">
            <AlertCircle className="w-16 h-16 text-red-400 mx-auto mb-4" />
            <h2 className="text-2xl font-bold text-white mb-2">{t('registrationUnavailable')}</h2>
            <p className="text-muted-foreground">{error}</p>
          </CardContent>
        </Card>
      </main>
    );
  }

  if (waitlistSuccess) {
    return (
      <main id="main-content" tabIndex={-1} className="min-h-screen bg-[#0a0f0d] flex items-center justify-center p-4 focus:outline-none">
        <Card className="bg-black/40 border-white/10 max-w-md w-full text-center">
          <CardContent className="pt-10 pb-8 px-8">
            <div className="w-20 h-20 rounded-full bg-yellow-500/20 flex items-center justify-center mx-auto mb-6 shadow-[0_0_40px_rgba(234,179,8,0.3)]">
              <Users className="w-10 h-10 text-yellow-400" />
            </div>
            <h2 className="text-3xl font-bold text-white mb-2 font-display">{t('addedToWaitlist')}</h2>
            <p className="text-muted-foreground text-lg mb-1">{registeredName}</p>
            <p className="text-yellow-400 font-semibold mb-4">{tournament?.name}</p>
            {waitlistPosition !== null && (
              <div className="mb-6 p-4 rounded-xl border border-yellow-500/30 bg-yellow-500/10">
                <p className="text-yellow-400 font-bold text-4xl mb-1">#{waitlistPosition}</p>
                <p className="text-muted-foreground text-sm">{t('waitlistPosition')}</p>
              </div>
            )}
            <p className="text-sm text-muted-foreground">
              {t('waitlistAutoReg')}
            </p>
          </CardContent>
        </Card>
      </main>
    );
  }

  if (success) {
    const hasEntryFee = !!(tournament?.entryFee && parseFloat(tournament.entryFee) > 0);
    return (
      <main id="main-content" tabIndex={-1} className="min-h-screen bg-[#0a0f0d] flex items-center justify-center p-4 focus:outline-none">
        <Card className="bg-black/40 border-white/10 max-w-md w-full text-center">
          <CardContent className="pt-10 pb-8 px-8">
            <div className="w-20 h-20 rounded-full bg-primary/20 flex items-center justify-center mx-auto mb-6 shadow-[0_0_40px_rgba(34,197,94,0.3)]">
              <CheckCircle2 className="w-10 h-10 text-primary" />
            </div>
            <h2 className="text-3xl font-bold text-white mb-2 font-display">{t('youreRegistered')}</h2>
            <p className="text-muted-foreground text-lg mb-1">{registeredName}</p>
            <p className="text-primary font-semibold mb-4">{tournament?.name}</p>

            {hasEntryFee && !paymentDone && (
              <div className="mb-6 p-4 rounded-xl border border-yellow-500/30 bg-yellow-500/10">
                <p className="text-yellow-400 font-semibold mb-1">{t('entryFeeRequired')}</p>
                <div className="text-white text-2xl font-bold mb-3">
                  <PriceWithFx
                    orgId={tournament?.organizationId ?? null}
                    amount={tournament!.entryFee}
                    currency={tournament!.currency ?? 'INR'}
                    bookedClassName="text-white"
                  />
                </div>
                <Button
                  onClick={handleRazorpayPayment}
                  className="w-full bg-[#007bff] hover:bg-[#0056d3] text-white font-semibold py-5"
                >
                  {tournament?.currency && tournament.currency !== 'INR' ? t('payNow', 'Pay Now') : t('payWithRazorpay')}
                </Button>
              </div>
            )}

            {(!hasEntryFee || paymentDone) && (
              <div className={paymentDone ? 'mb-4 p-3 rounded-xl bg-primary/10 border border-primary/30' : ''}>
                {paymentDone && <p className="text-primary font-semibold mb-1">{t('paymentSuccessful')}</p>}
                <p className="text-sm text-muted-foreground">
                  {tournament?.startDate ? t('tournamentBegins', { date: new Date(tournament.startDate).toLocaleDateString(getLocale(), { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }) }) : t('datesToConfirm')}
                  {' '}{t('checkEmail')}
                </p>
              </div>
            )}
            {tournament?.organizationId && (
              <Button
                variant="outline"
                className="w-full mt-3 bg-primary/10 border-primary/30 hover:bg-primary/20 text-primary"
                onClick={() => {
                  const a = document.createElement('a');
                  a.href = `/api/public/orgs/${tournament.organizationId}/tournaments/${tournament.id}/calendar.ics`;
                  a.download = '';
                  a.click();
                }}
              >
                <CalendarPlus className="w-4 h-4 mr-2" /> {t('addToCalendar')}
              </Button>
            )}
          </CardContent>

          {/* Custom Registration Form Fields */}
          {regFormFields.length > 0 && !regFormSubmitted && (
            <div className="border-t border-white/10 px-8 pt-5 pb-6 text-left">
              <h3 className="text-sm font-semibold text-white mb-1">{t('additionalDetails')}</h3>
              <p className="text-xs text-muted-foreground mb-4">{t('completeAdditionalInfo')}</p>
              <form onSubmit={handleRegFormSubmit} className="space-y-4">
                {regFormFields.filter(isRegFieldVisible).map(field => (
                  <div key={field.id} className="space-y-1.5">
                    <label className="text-sm font-medium text-white">
                      {field.label}
                      {field.required && <span className="text-red-400 ml-1">*</span>}
                    </label>
                    {field.helpText && <p className="text-xs text-muted-foreground">{field.helpText}</p>}
                    {field.fieldType === 'short_text' && (
                      <Input value={regFormAnswers[field.id] ?? ''} onChange={e => setRegFormAnswers(a => ({ ...a, [field.id]: e.target.value }))}
                        placeholder={field.placeholder ?? ''} className="bg-black/50 border-white/10 text-white" />
                    )}
                    {field.fieldType === 'long_text' && (
                      <textarea value={regFormAnswers[field.id] ?? ''} onChange={e => setRegFormAnswers(a => ({ ...a, [field.id]: e.target.value }))}
                        placeholder={field.placeholder ?? ''}
                        className="w-full bg-black/50 border border-white/10 text-white rounded-md px-3 py-2 text-sm resize-y min-h-[80px]" />
                    )}
                    {field.fieldType === 'dropdown' && (
                      <select value={regFormAnswers[field.id] ?? ''} onChange={e => setRegFormAnswers(a => ({ ...a, [field.id]: e.target.value }))}
                        className="w-full bg-black/50 border border-white/10 text-white rounded-md px-3 py-2 text-sm">
                        <option value="" disabled>{t('selectOption')}</option>
                        {(field.options ?? []).map(opt => <option key={opt} value={opt}>{opt}</option>)}
                      </select>
                    )}
                    {field.fieldType === 'checkbox' && (
                      <div className="space-y-2">
                        {(field.options ?? []).map(opt => (
                          <label key={opt} className="flex items-center gap-3 cursor-pointer">
                            <input type="checkbox" className="w-4 h-4 rounded accent-emerald-500"
                              checked={(regFormCheckboxAnswers[field.id] ?? []).includes(opt)}
                              onChange={e => handleRegFormCheckbox(field.id, opt, e.target.checked)} />
                            <span className="text-sm text-white">{opt}</span>
                          </label>
                        ))}
                      </div>
                    )}
                    {field.fieldType === 'file_upload' && (
                      <label className="flex items-center gap-2 cursor-pointer px-3 py-2 rounded-md border border-white/10 bg-black/50 text-sm text-muted-foreground hover:border-white/20 w-full">
                        <Upload className="w-4 h-4 flex-shrink-0" />
                        {regFormAnswers[field.id] ?? t('chooseFile')}
                        <input type="file" className="hidden" onChange={e => {
                          const f = e.target.files?.[0];
                          if (f) setRegFormAnswers(a => ({ ...a, [field.id]: f.name }));
                        }} />
                      </label>
                    )}
                    {field.fieldType === 'terms_acceptance' && (
                      <label className="flex items-start gap-3 cursor-pointer">
                        <input type="checkbox" className="w-4 h-4 rounded accent-emerald-500 mt-0.5 flex-shrink-0"
                          checked={regFormAnswers[field.id] === 'accepted'}
                          onChange={e => setRegFormAnswers(a => ({ ...a, [field.id]: e.target.checked ? 'accepted' : '' }))} />
                        <span className="text-sm text-muted-foreground">{field.termsText ?? t('publicForm.acceptTerms')}</span>
                      </label>
                    )}
                  </div>
                ))}
                {regFormError && <p className="text-red-400 text-sm">{regFormError}</p>}
                <Button type="submit" disabled={regFormSubmitting} className="w-full bg-emerald-600 hover:bg-emerald-700 text-white">
                  {regFormSubmitting ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> {t('submitting')}</> : t('submitDetails')}
                </Button>
              </form>
            </div>
          )}
          {regFormFields.length > 0 && regFormSubmitted && (
            <div className="border-t border-white/10 px-8 pt-4 pb-5 text-center">
              <CheckCircle2 className="w-8 h-8 text-emerald-400 mx-auto mb-2" />
              <p className="text-sm text-white font-medium">{t('detailsSubmitted')}</p>
              <p className="text-xs text-muted-foreground mt-1">{t('allDone')}</p>
            </div>
          )}

          {merchandise.length > 0 && (
            <div className="border-t border-white/10 px-8 pt-4 pb-6">
              <div className="flex items-center gap-2 mb-2">
                <ShoppingBag className="w-4 h-4 text-primary" />
                <h3 className="text-sm font-semibold text-white">{t('eventMerchandise')}</h3>
              </div>
              {!merchOrdered ? (
                <>
                  <p className="text-xs text-muted-foreground mb-3">{t('reserveItemsNow')}</p>
                  <div className="space-y-2 mb-3">
                    {merchandise.map(item => {
                      const qty = selectedMerch[item.productId] ?? 0;
                      return (
                        <div key={item.id} className="flex items-center gap-3 bg-white/5 rounded-lg p-2">
                          {item.imageUrl ? (
                            <img src={item.imageUrl} alt={item.productName} className="w-10 h-10 object-cover rounded" />
                          ) : (
                            <div className="w-10 h-10 bg-white/10 rounded flex items-center justify-center">
                              <Tag className="w-4 h-4 text-muted-foreground" />
                            </div>
                          )}
                          <div className="flex-1 min-w-0">
                            <p className="text-sm text-white truncate">{item.productName}</p>
                            {item.note && <p className="text-xs text-muted-foreground">{item.note}</p>}
                            <p className="text-xs text-primary font-semibold">{CURRENCY_SYMBOLS[tournament?.currency ?? 'INR'] ?? '₹'}{parseFloat(item.price ?? '0').toFixed(0)}</p>
                          </div>
                          <div className="flex items-center gap-2">
                            <button
                              onClick={() => setSelectedMerch(prev => ({ ...prev, [item.productId]: Math.max(0, (prev[item.productId] ?? 0) - 1) }))}
                              className="w-6 h-6 rounded bg-white/10 text-white flex items-center justify-center text-xs hover:bg-white/20 disabled:opacity-30"
                              disabled={qty === 0}
                            >-</button>
                            <span className="text-sm font-bold text-white w-4 text-center">{qty}</span>
                            <button
                              onClick={() => setSelectedMerch(prev => ({ ...prev, [item.productId]: (prev[item.productId] ?? 0) + 1 }))}
                              className="w-6 h-6 rounded bg-primary/80 text-white flex items-center justify-center text-xs hover:bg-primary"
                            >+</button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  {Object.values(selectedMerch).some(q => q > 0) && (
                    <button
                      disabled={orderingMerch}
                      onClick={async () => {
                        setOrderingMerch(true);
                        try {
                          const items = Object.entries(selectedMerch)
                            .filter(([, q]) => q > 0)
                            .map(([productId, quantity]) => ({ productId: parseInt(productId), quantity }));
                          const res = await fetch(`/api/public/orgs/${orgId}/tournaments/${tournamentId}/merchandise/order`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ customerName: registeredName, customerEmail: email, customerPhone: phone, items }),
                          });
                          const data = await res.json();
                          if (res.ok) {
                            setMerchOrdered(true);
                            setMerchOrderMessage(data.message ?? 'Merchandise reserved!');
                          }
                        } finally {
                          setOrderingMerch(false);
                        }
                      }}
                      className="w-full text-sm bg-primary/80 hover:bg-primary text-white font-semibold rounded-lg py-2 transition-all disabled:opacity-60"
                      aria-label={orderingMerch ? t('reserving') : t('reserveSelected')}
                    >
                      {orderingMerch ? t('reserving') : t('reserveSelected')}
                    </button>
                  )}
                </>
              ) : (
                <div className="bg-green-500/10 border border-green-500/20 rounded-lg p-3 text-center">
                  <CheckCircle2 className="w-5 h-5 text-green-400 mx-auto mb-1" />
                  <p className="text-sm text-green-400 font-medium">{merchOrderMessage}</p>
                </div>
              )}
            </div>
          )}
        </Card>
      </main>
    );
  }

  const formatName = tournament?.format?.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()) ?? '';

  return (
    <main id="main-content" tabIndex={-1} className="min-h-screen bg-[#0a0f0d] py-8 px-4 focus:outline-none">
      {stripeCheckout && (
        <StripeCheckoutDialog
          open={!!stripeCheckout}
          onOpenChange={(o) => { if (!o) setStripeCheckout(null); }}
          publishableKey={stripeCheckout.publishableKey}
          clientSecret={stripeCheckout.clientSecret}
          description={stripeCheckout.description}
          amountLabel={stripeCheckout.amountLabel}
          onSuccess={handleStripeSuccess}
        />
      )}
      {/* Brand header — picks up the club's saved logo (Task #1756)
          via tournament.organizationId once the tournament loads,
          and falls back to the KHARAGOLF wordmark otherwise. */}
      <div className="text-center mb-8">
        <PreAuthBrand size="md" tagline="ENTERPRISE PLATFORM" orgId={tournament?.organizationId ?? null} />
      </div>

      <div className="max-w-xl mx-auto">
        {/* Tournament banner */}
        <Card className="bg-black/60 border-white/10 mb-6 overflow-hidden">
          <div className="h-2 bg-gradient-to-r from-primary/60 to-primary w-full" />
          <CardHeader className="pb-4">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-muted-foreground text-sm mb-1">{tournament?.organizationName}</p>
                <CardTitle className="text-2xl text-white font-display">{tournament?.name}</CardTitle>
                {tournament?.description && <p className="text-muted-foreground text-sm mt-2">{tournament.description}</p>}
              </div>
              <Badge className="bg-primary/20 text-primary border-primary/40 shrink-0 ml-3">{formatName}</Badge>
            </div>
          </CardHeader>
          <CardContent className="pt-0">
            <div className="grid grid-cols-2 gap-3 text-sm">
              {tournament?.courseName && (
                <div className="flex items-center gap-2 text-muted-foreground">
                  <MapPin className="w-3.5 h-3.5 text-primary" />
                  {tournament.courseName}
                </div>
              )}
              {tournament?.startDate && (
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Calendar className="w-3.5 h-3.5 text-emerald-400" />
                  {new Date(tournament.startDate).toLocaleDateString(getLocale())}
                </div>
              )}
              {tournament?.organizationId && (
                <button
                  onClick={() => {
                    const a = document.createElement('a');
                    a.href = `/api/public/orgs/${tournament.organizationId}/tournaments/${tournament.id}/calendar.ics`;
                    a.download = '';
                    a.click();
                  }}
                  className="flex items-center gap-2 text-primary hover:text-primary/80 text-sm font-medium transition-colors"
                >
                  <CalendarPlus className="w-3.5 h-3.5" />
                  {t('addToCalendar')}
                </button>
              )}
              <div className="flex items-center gap-2 text-muted-foreground">
                <Users className="w-3.5 h-3.5 text-orange-400" />
                {tournament?.playerCount ?? 0}{tournament?.maxPlayers ? ` / ${tournament.maxPlayers}` : ''} {t('players')}
              </div>
              {tournament?.membersOnly && (
                <Badge className="bg-amber-500/20 text-amber-400 border-amber-500/30 border text-xs">{t('membersOnly')}</Badge>
              )}
              {tournament?.entryFee && (
                <div className="text-muted-foreground">
                  {tournament.membersOnly && tournament.memberEntryFee ? (
                    <div className="space-y-1">
                      <div>{t('guestFee')}:{' '}
                        <PriceWithFx orgId={tournament.organizationId ?? null} amount={tournament.entryFee} currency={tournament.currency ?? 'INR'} bookedClassName="text-white" />
                      </div>
                      <div>{t('memberFee')}:{' '}
                        <PriceWithFx orgId={tournament.organizationId ?? null} amount={tournament.memberEntryFee} currency={tournament.currency ?? 'INR'} bookedClassName="text-primary" />
                      </div>
                    </div>
                  ) : (
                    <div>{t('entryFee')}:{' '}
                      <PriceWithFx orgId={tournament.organizationId ?? null} amount={tournament.entryFee} currency={tournament.currency ?? 'INR'} bookedClassName="text-white" />
                    </div>
                  )}
                </div>
              )}
            </div>
            {tournament?.membersOnly && (
              <div className="mt-3 p-3 bg-amber-500/10 border border-amber-500/20 rounded-lg text-amber-400 text-sm text-center flex items-center gap-2 justify-center">
                <AlertCircle className="w-4 h-4 flex-shrink-0" />
                {t('membersOnlyNote')}
              </div>
            )}
            {tournament?.isFull && !tournament?.membersOnly && (
              <div className="mt-3 p-3 bg-yellow-500/10 border border-yellow-500/20 rounded-lg text-yellow-400 text-sm text-center">
                {t('tournamentFullWaitlist')}
              </div>
            )}
            {tournament?.isFull && tournament?.membersOnly && (
              <div className="mt-3 p-3 bg-yellow-500/10 border border-yellow-500/20 rounded-lg text-yellow-400 text-sm text-center">
                {t('tournamentFullMembersWaitlist')}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Registration form — always show; API handles waitlist when full */}
        <Card className="bg-black/60 border-white/10">
            <CardHeader>
              <CardTitle className="text-white text-xl">
                {tournament?.isFull ? t('joinWaitlist') : t('playerRegistration')}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleSubmit} className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium text-white">{t('firstName')} *</label>
                    <Input
                      value={firstName}
                      onChange={e => setFirstName(e.target.value)}
                      placeholder="John"
                      required
                      className="bg-black/50 border-white/10 text-white placeholder:text-muted-foreground"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-sm font-medium text-white">{t('lastName')} *</label>
                    <Input
                      value={lastName}
                      onChange={e => setLastName(e.target.value)}
                      placeholder="Doe"
                      required
                      className="bg-black/50 border-white/10 text-white placeholder:text-muted-foreground"
                    />
                  </div>
                </div>

                <div className="space-y-1.5">
                  <label className="text-sm font-medium text-white">{t('emailAddress')} *</label>
                  <Input
                    type="email"
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                    placeholder="john@example.com"
                    required
                    className="bg-black/50 border-white/10 text-white placeholder:text-muted-foreground"
                  />
                </div>

                <div className="space-y-1.5">
                  <label className="text-sm font-medium text-white">{t('phoneNumber')}</label>
                  <Input
                    type="tel"
                    value={phone}
                    onChange={e => setPhone(e.target.value)}
                    placeholder="+1 (555) 000-0000"
                    className="bg-black/50 border-white/10 text-white placeholder:text-muted-foreground"
                  />
                </div>

                <div className="space-y-1.5">
                  <label className="text-sm font-medium text-white">{t('handicapIndex')}</label>
                  <Input
                    type="number"
                    value={handicap}
                    onChange={e => setHandicap(e.target.value)}
                    placeholder="0.0"
                    step="0.1"
                    min="-10"
                    max="54"
                    className="bg-black/50 border-white/10 text-white placeholder:text-muted-foreground"
                  />
                </div>

                <div className="space-y-1.5">
                  <label className="text-sm font-medium text-white">{t('teeBox')}</label>
                  <Select value={teeBox} onValueChange={setTeeBox}>
                    <SelectTrigger className="bg-black/50 border-white/10 text-white">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="bg-card border-white/10 text-white">
                      <SelectItem value="black">{t('teeBoxes.black')}</SelectItem>
                      <SelectItem value="blue">{t('teeBoxes.blue')}</SelectItem>
                      <SelectItem value="white">{t('teeBoxes.white')}</SelectItem>
                      <SelectItem value="gold">{t('teeBoxes.gold')}</SelectItem>
                      <SelectItem value="red">{t('teeBoxes.red')}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {merchandise.length > 0 && (
                  <div className="p-3 bg-primary/5 border border-primary/20 rounded-lg">
                    <div className="flex items-center gap-2 mb-2">
                      <ShoppingBag className="w-4 h-4 text-primary" />
                      <span className="text-sm font-medium text-white">{t('eventMerchandiseAvailable')}</span>
                    </div>
                    <div className="space-y-1.5">
                      {merchandise.map(item => (
                        <div key={item.id} className="flex items-center justify-between text-xs">
                          <span className="text-muted-foreground truncate mr-2">{item.productName}</span>
                          <span className="text-primary font-semibold whitespace-nowrap">
                            {CURRENCY_SYMBOLS[tournament?.currency ?? 'INR'] ?? '₹'}{parseFloat(item.price ?? '0').toFixed(0)}
                          </span>
                        </div>
                      ))}
                    </div>
                    <p className="text-xs text-muted-foreground mt-2">{t('availableAtProShop')}</p>
                  </div>
                )}

                {submitError && (
                  <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-red-400 text-sm flex items-center gap-2">
                    <AlertCircle className="w-4 h-4 shrink-0" />
                    {submitError}
                  </div>
                )}

                <Button
                  type="submit"
                  disabled={submitting}
                  className="w-full bg-primary hover:bg-primary/90 text-primary-foreground font-semibold py-6 text-base shadow-[0_0_20px_rgba(34,197,94,0.3)]"
                >
                  {submitting ? (
                    <><Loader2 className="w-5 h-5 mr-2 animate-spin" /> {tournament?.isFull ? t('joiningWaitlist') : t('registering')}</>
                  ) : tournament?.isFull ? (
                    t('joinWaitlistBtn')
                  ) : (
                    t('registerForTournament')
                  )}
                </Button>

                <p className="text-xs text-muted-foreground text-center">
                  {t('agreeToRules')}
                </p>
              </form>
            </CardContent>
          </Card>
      </div>
    </main>
  );
}
