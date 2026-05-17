import { useState, useEffect } from 'react';
import { useParams } from 'wouter';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useToast } from '@/hooks/use-toast';
import { RefreshCw, CheckCircle2, FileText, Star } from 'lucide-react';

type FieldType = 'short_text' | 'long_text' | 'dropdown' | 'checkbox' | 'file_upload' | 'terms_acceptance';

interface SurveyField {
  id: number;
  fieldType: FieldType;
  label: string;
  placeholder?: string | null;
  helpText?: string | null;
  options?: string[] | null;
  required: boolean;
  termsText?: string | null;
}

interface SurveyPageData {
  survey: {
    id: number;
    title: string;
    description?: string | null;
  };
  fields: SurveyField[];
  respondentName: string | null;
  alreadySubmitted: boolean;
  existingAnswers: Record<number, string | null>;
}

export default function SurveyRespondPage() {
  const params = useParams<{ token: string }>();
  const token = params.token ?? '';
  const { toast } = useToast();

  const [data, setData] = useState<SurveyPageData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [checkboxAnswers, setCheckboxAnswers] = useState<Record<number, string[]>>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    fetch(`/api/public/survey-respond/${token}`)
      .then(async r => {
        if (!r.ok) {
          const d = await r.json() as { error?: string };
          throw new Error(d.error ?? 'Invalid link');
        }
        return r.json() as Promise<SurveyPageData>;
      })
      .then(d => {
        setData(d);
        if (d.alreadySubmitted) {
          const existing: Record<number, string> = {};
          const existingCb: Record<number, string[]> = {};
          for (const [fIdStr, val] of Object.entries(d.existingAnswers)) {
            const fId = parseInt(fIdStr);
            const field = d.fields.find(f => f.id === fId);
            if (!field || !val) continue;
            if (field.fieldType === 'checkbox') {
              existingCb[fId] = val.split(', ').filter(Boolean);
            } else {
              existing[fId] = val;
            }
          }
          setAnswers(existing);
          setCheckboxAnswers(existingCb);
          setSubmitted(true);
        }
      })
      .catch(e => setError((e as Error).message ?? 'Failed to load survey.'))
      .finally(() => setLoading(false));
  }, [token]);

  const handleCheckbox = (fieldId: number, option: string, checked: boolean) => {
    setCheckboxAnswers(prev => {
      const current = prev[fieldId] ?? [];
      return { ...prev, [fieldId]: checked ? [...current, option] : current.filter(o => o !== option) };
    });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!data) return;

    for (const field of data.fields) {
      if (!field.required) continue;
      if (field.fieldType === 'checkbox') {
        if ((checkboxAnswers[field.id] ?? []).length === 0) {
          toast({ title: `"${field.label}" is required`, variant: 'destructive' }); return;
        }
      } else if (!answers[field.id]?.trim()) {
        toast({ title: `"${field.label}" is required`, variant: 'destructive' }); return;
      }
    }

    const answersPayload: Record<string, string> = {};
    for (const field of data.fields) {
      if (field.fieldType === 'checkbox') {
        answersPayload[String(field.id)] = (checkboxAnswers[field.id] ?? []).join(', ');
      } else {
        answersPayload[String(field.id)] = answers[field.id] ?? '';
      }
    }

    setSubmitting(true);
    try {
      const res = await fetch(`/api/public/survey-respond/${token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answers: answersPayload }),
      });
      if (res.ok) {
        setSubmitted(true);
      } else {
        const d = await res.json() as { error?: string };
        toast({ title: d.error ?? 'Submission failed', variant: 'destructive' });
      }
    } finally { setSubmitting(false); }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-[#07111f] flex items-center justify-center">
        <RefreshCw className="w-8 h-8 text-blue-400 animate-spin" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-[#07111f] flex items-center justify-center px-4">
        <div className="text-center space-y-3 max-w-sm">
          <div className="w-12 h-12 rounded-2xl bg-red-500/20 flex items-center justify-center mx-auto">
            <FileText className="w-6 h-6 text-red-400" />
          </div>
          <h2 className="text-xl font-bold text-white">Unable to Load Survey</h2>
          <p className="text-muted-foreground text-sm">{error}</p>
          <p className="text-muted-foreground text-xs">The link may have expired or is invalid. Please contact the event organiser.</p>
        </div>
      </div>
    );
  }

  if (!data) return null;

  if (submitted) {
    return (
      <div className="min-h-screen bg-[#07111f] flex items-center justify-center px-4">
        <div className="text-center space-y-4 max-w-sm">
          <CheckCircle2 className="w-16 h-16 text-blue-400 mx-auto" />
          <h2 className="text-2xl font-bold text-white">Thank You!</h2>
          <p className="text-white font-medium">{data.survey.title}</p>
          <p className="text-muted-foreground text-sm">Your feedback has been recorded. We really appreciate you taking the time to respond.</p>
          <div className="flex justify-center gap-1 pt-2">
            {[1, 2, 3, 4, 5].map(i => (
              <Star key={i} className="w-5 h-5 text-yellow-400 fill-yellow-400" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#07111f] flex items-center justify-center px-4 py-10">
      <div className="w-full max-w-lg">
        <div className="mb-8 text-center">
          <div className="w-12 h-12 rounded-2xl bg-blue-500/20 flex items-center justify-center mx-auto mb-4">
            <FileText className="w-6 h-6 text-blue-400" />
          </div>
          <h1 className="text-2xl font-bold text-white">{data.survey.title}</h1>
          {data.survey.description && (
            <p className="text-muted-foreground text-sm mt-2">{data.survey.description}</p>
          )}
          {data.respondentName && (
            <p className="text-white/60 text-sm mt-3">
              Hi, <span className="text-white font-medium">{data.respondentName}</span> — we'd love your feedback!
            </p>
          )}
        </div>

        <form onSubmit={handleSubmit} className="space-y-6">
          <div className="rounded-2xl border border-white/10 bg-white/5 backdrop-blur-sm p-6 space-y-6">
            {data.fields.map(field => (
              <div key={field.id} className="space-y-2">
                <label className="text-sm font-medium text-white">
                  {field.label}
                  {field.required && <span className="text-red-400 ml-1">*</span>}
                </label>
                {field.helpText && <p className="text-xs text-muted-foreground">{field.helpText}</p>}

                {field.fieldType === 'short_text' && (
                  <Input
                    value={answers[field.id] ?? ''}
                    onChange={e => setAnswers(a => ({ ...a, [field.id]: e.target.value }))}
                    placeholder={field.placeholder ?? ''}
                    className="bg-black/40 border-white/10 text-white"
                  />
                )}

                {field.fieldType === 'long_text' && (
                  <textarea
                    value={answers[field.id] ?? ''}
                    onChange={e => setAnswers(a => ({ ...a, [field.id]: e.target.value }))}
                    placeholder={field.placeholder ?? ''}
                    className="w-full bg-black/40 border border-white/10 text-white rounded-md px-3 py-2 text-sm resize-y min-h-[120px]"
                  />
                )}

                {field.fieldType === 'dropdown' && (
                  <select
                    value={answers[field.id] ?? ''}
                    onChange={e => setAnswers(a => ({ ...a, [field.id]: e.target.value }))}
                    className="w-full bg-black/40 border border-white/10 text-white rounded-md px-3 py-2 text-sm"
                  >
                    <option value="" disabled>Select…</option>
                    {(field.options ?? []).map(opt => (
                      <option key={opt} value={opt}>{opt}</option>
                    ))}
                  </select>
                )}

                {field.fieldType === 'checkbox' && (
                  <div className="space-y-2">
                    {(field.options ?? []).map(opt => (
                      <label key={opt} className="flex items-center gap-3 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={(checkboxAnswers[field.id] ?? []).includes(opt)}
                          onChange={e => handleCheckbox(field.id, opt, e.target.checked)}
                          className="w-4 h-4 rounded accent-blue-500"
                        />
                        <span className="text-sm text-white">{opt}</span>
                      </label>
                    ))}
                  </div>
                )}

                {field.fieldType === 'terms_acceptance' && (
                  <label className="flex items-start gap-3 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={answers[field.id] === 'accepted'}
                      onChange={e => setAnswers(a => ({ ...a, [field.id]: e.target.checked ? 'accepted' : '' }))}
                      className="w-4 h-4 rounded accent-blue-500 mt-0.5 flex-shrink-0"
                    />
                    <span className="text-sm text-muted-foreground">{field.termsText ?? 'I accept the terms and conditions.'}</span>
                  </label>
                )}
              </div>
            ))}
          </div>

          <Button type="submit" disabled={submitting} className="w-full bg-blue-600 hover:bg-blue-700 text-white py-3">
            {submitting ? <><RefreshCw className="w-4 h-4 mr-2 animate-spin" /> Submitting…</> : 'Submit Feedback'}
          </Button>
        </form>
      </div>
    </div>
  );
}
