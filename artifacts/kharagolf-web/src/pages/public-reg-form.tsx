import { useState, useEffect } from 'react';
import { useParams } from 'wouter';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useToast } from '@/hooks/use-toast';
import { CheckSquare, ChevronDown, Upload, FileText, RefreshCw, CheckCircle2, AlignLeft, AlignJustify } from 'lucide-react';
import { PreAuthBrand } from '@/components/PreAuthBrand';

type FieldType = 'short_text' | 'long_text' | 'dropdown' | 'checkbox' | 'file_upload' | 'terms_acceptance';

interface FormField {
  id: number;
  fieldType: FieldType;
  label: string;
  placeholder?: string | null;
  helpText?: string | null;
  options?: string[] | null;
  required: boolean;
  conditionalOnFieldId?: number | null;
  conditionalOnValue?: string | null;
  termsText?: string | null;
  sortOrder: number;
}

export default function PublicRegFormPage() {
  const params = useParams<{ eventType: string; eventId: string }>();
  const eventType = params.eventType ?? 'tournament';
  const eventId = parseInt(params.eventId ?? '0');

  const { t } = useTranslation('register');
  const { toast } = useToast();
  const [fields, setFields] = useState<FormField[]>([]);
  const [loading, setLoading] = useState(true);
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [checkboxAnswers, setCheckboxAnswers] = useState<Record<number, string[]>>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/public/event-forms/${eventType}/${eventId}/fields`)
      .then(r => r.ok ? r.json() : Promise.reject())
      .then((data: FormField[]) => setFields(data))
      .catch(() => setError(t('publicForm.unableToLoad')))
      .finally(() => setLoading(false));
  }, [eventType, eventId]);

  const isVisible = (field: FormField): boolean => {
    if (!field.conditionalOnFieldId) return true;
    const parentVal = answers[field.conditionalOnFieldId] ?? '';
    return parentVal === (field.conditionalOnValue ?? '');
  };

  const handleCheckbox = (fieldId: number, option: string, checked: boolean) => {
    setCheckboxAnswers(prev => {
      const current = prev[fieldId] ?? [];
      return {
        ...prev,
        [fieldId]: checked ? [...current, option] : current.filter(o => o !== option),
      };
    });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    for (const field of fields) {
      if (!field.required || !isVisible(field)) continue;
      if (field.fieldType === 'checkbox') {
        if ((checkboxAnswers[field.id] ?? []).length === 0) {
          toast({ title: t('errors.isRequired', { label: field.label }), variant: 'destructive' }); return;
        }
      } else if (!answers[field.id]?.trim()) {
        toast({ title: t('errors.isRequired', { label: field.label }), variant: 'destructive' }); return;
      }
    }

    const responseItems = fields
      .filter(f => isVisible(f))
      .map(f => ({
        fieldId: f.id,
        value: f.fieldType === 'checkbox'
          ? (checkboxAnswers[f.id] ?? []).join(', ')
          : (answers[f.id] ?? ''),
      }));

    setSubmitting(true);
    try {
      const res = await fetch(`/api/public/event-forms/${eventType}/${eventId}/responses`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ responseItems }),
      });
      if (res.ok) {
        setSubmitted(true);
      } else {
        const d = await res.json() as { error?: string };
        toast({ title: d.error ?? t('publicForm.submissionFailed'), variant: 'destructive' });
      }
    } finally { setSubmitting(false); }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-[#07111f] flex items-center justify-center">
        <RefreshCw className="w-8 h-8 text-emerald-400 animate-spin" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-[#07111f] flex flex-col items-center justify-center px-4 py-10">
        <PreAuthBrand size="md" className="mb-8" />
        <div className="text-center space-y-3">
          <p className="text-red-400 font-medium">{error}</p>
          <p className="text-muted-foreground text-sm">{t('publicForm.contactOrganiser')}</p>
        </div>
      </div>
    );
  }

  if (submitted) {
    return (
      <div className="min-h-screen bg-[#07111f] flex flex-col items-center justify-center px-4 py-10">
        <PreAuthBrand size="md" className="mb-8" />
        <div className="text-center space-y-4 max-w-sm">
          <CheckCircle2 className="w-16 h-16 text-emerald-400 mx-auto" />
          <h2 className="text-2xl font-bold text-white">{t('publicForm.submitted')}</h2>
          <p className="text-muted-foreground text-sm">{t('publicForm.submittedDesc')}</p>
        </div>
      </div>
    );
  }

  if (fields.length === 0) {
    return (
      <div className="min-h-screen bg-[#07111f] flex flex-col items-center justify-center px-4 py-10">
        <PreAuthBrand size="md" className="mb-8" />
        <p className="text-muted-foreground text-sm">{t('publicForm.noAdditionalInfo')}</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#07111f] flex items-center justify-center px-4 py-10">
      <div className="w-full max-w-lg">
        <div className="mb-8 text-center">
          <PreAuthBrand size="md" className="mb-6" />
          <div className="w-12 h-12 rounded-2xl bg-emerald-500/20 flex items-center justify-center mx-auto mb-4">
            <CheckSquare className="w-6 h-6 text-emerald-400" />
          </div>
          <h1 className="text-2xl font-bold text-white">{t('publicForm.registrationDetails')}</h1>
          <p className="text-muted-foreground text-sm mt-2">{t('publicForm.completeToFinish')}</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-6">
          <div className="rounded-2xl border border-white/10 bg-white/5 backdrop-blur-sm p-6 space-y-6">
            {fields.filter(isVisible).map(field => (
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
                    className="w-full bg-black/40 border border-white/10 text-white rounded-md px-3 py-2 text-sm resize-y min-h-[100px]"
                  />
                )}

                {field.fieldType === 'dropdown' && (
                  <select
                    value={answers[field.id] ?? ''}
                    onChange={e => setAnswers(a => ({ ...a, [field.id]: e.target.value }))}
                    className="w-full bg-black/40 border border-white/10 text-white rounded-md px-3 py-2 text-sm"
                  >
                    <option value="" disabled>{t('selectOption')}</option>
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
                          className="w-4 h-4 rounded accent-emerald-500"
                        />
                        <span className="text-sm text-white">{opt}</span>
                      </label>
                    ))}
                  </div>
                )}

                {field.fieldType === 'file_upload' && (
                  <div>
                    <label className="flex items-center gap-2 cursor-pointer px-3 py-2 rounded-md border border-white/10 bg-black/40 text-sm text-muted-foreground hover:border-white/20 transition-colors w-full">
                      <Upload className="w-4 h-4 flex-shrink-0" />
                      {answers[field.id] ? answers[field.id] : t('chooseFile')}
                      <input
                        type="file"
                        className="hidden"
                        onChange={e => {
                          const f = e.target.files?.[0];
                          if (f) setAnswers(a => ({ ...a, [field.id]: f.name }));
                        }}
                      />
                    </label>
                    <p className="text-xs text-muted-foreground mt-1">{t('publicForm.fileUploadNote')}</p>
                  </div>
                )}

                {field.fieldType === 'terms_acceptance' && (
                  <label className="flex items-start gap-3 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={answers[field.id] === 'accepted'}
                      onChange={e => setAnswers(a => ({ ...a, [field.id]: e.target.checked ? 'accepted' : '' }))}
                      className="w-4 h-4 rounded accent-emerald-500 mt-0.5 flex-shrink-0"
                    />
                    <span className="text-sm text-muted-foreground">{field.termsText ?? t('publicForm.acceptTerms')}</span>
                  </label>
                )}
              </div>
            ))}
          </div>

          <Button type="submit" disabled={submitting} className="w-full bg-emerald-600 hover:bg-emerald-700 text-white py-3">
            {submitting ? <><RefreshCw className="w-4 h-4 mr-2 animate-spin" /> {t('submitting')}</> : t('publicForm.submitRegistration')}
          </Button>
        </form>
      </div>
    </div>
  );
}
