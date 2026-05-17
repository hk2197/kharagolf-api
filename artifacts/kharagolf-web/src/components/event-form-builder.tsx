import React, { useState, useEffect, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';
import {
  Plus, Trash2, Edit3, GripVertical, Eye, Download, ClipboardList, FileText, ChevronDown,
  CheckSquare, Upload, AlignLeft, AlignJustify, FileDown, BarChart2, Send, X, Save, RefreshCw,
  Users, Clock
} from 'lucide-react';

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

interface SurveyField {
  id: number;
  fieldType: FieldType;
  label: string;
  placeholder?: string | null;
  helpText?: string | null;
  options?: string[] | null;
  required: boolean;
  termsText?: string | null;
  sortOrder: number;
}

interface SurveyForm {
  id: number;
  title: string;
  description?: string | null;
  sendDelayHours: number;
  isActive: boolean;
  sentAt?: string | null;
  fields: SurveyField[];
}

interface ResponseEntry {
  entryId: number;
  entryName: string;
  answers: Record<number, string | null>;
}

const FIELD_TYPE_LABELS: Record<FieldType, string> = {
  short_text: 'Short Text',
  long_text: 'Long Text',
  dropdown: 'Dropdown',
  checkbox: 'Checkbox / Multi-select',
  file_upload: 'File Upload',
  terms_acceptance: 'T&C Acceptance',
};

const FIELD_ICONS: Record<FieldType, React.ReactNode> = {
  short_text: <AlignLeft className="w-3.5 h-3.5" />,
  long_text: <AlignJustify className="w-3.5 h-3.5" />,
  dropdown: <ChevronDown className="w-3.5 h-3.5" />,
  checkbox: <CheckSquare className="w-3.5 h-3.5" />,
  file_upload: <Upload className="w-3.5 h-3.5" />,
  terms_acceptance: <FileText className="w-3.5 h-3.5" />,
};

function FieldPreview({ field }: { field: FormField | SurveyField }) {
  return (
    <div className="space-y-1.5">
      <label className="text-sm font-medium text-white">
        {field.label}
        {field.required && <span className="text-red-400 ml-1">*</span>}
      </label>
      {field.helpText && <p className="text-xs text-muted-foreground">{field.helpText}</p>}
      {field.fieldType === 'short_text' && (
        <div className="h-9 rounded-md bg-black/30 border border-white/10 px-3 flex items-center">
          <span className="text-xs text-muted-foreground">{field.placeholder || 'Enter text…'}</span>
        </div>
      )}
      {field.fieldType === 'long_text' && (
        <div className="h-20 rounded-md bg-black/30 border border-white/10 px-3 pt-2">
          <span className="text-xs text-muted-foreground">{field.placeholder || 'Enter text…'}</span>
        </div>
      )}
      {field.fieldType === 'dropdown' && (
        <div className="h-9 rounded-md bg-black/30 border border-white/10 px-3 flex items-center justify-between">
          <span className="text-xs text-muted-foreground">Select an option…</span>
          <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />
        </div>
      )}
      {field.fieldType === 'checkbox' && (
        <div className="space-y-1.5">
          {(field.options ?? ['Option 1', 'Option 2']).map((opt, i) => (
            <div key={i} className="flex items-center gap-2">
              <div className="w-4 h-4 rounded bg-black/30 border border-white/20" />
              <span className="text-xs text-muted-foreground">{opt}</span>
            </div>
          ))}
        </div>
      )}
      {field.fieldType === 'file_upload' && (
        <div className="h-9 rounded-md bg-black/30 border border-white/10 px-3 flex items-center gap-2">
          <Upload className="w-3.5 h-3.5 text-muted-foreground" />
          <span className="text-xs text-muted-foreground">Choose file…</span>
        </div>
      )}
      {field.fieldType === 'terms_acceptance' && (
        <div className="flex items-start gap-2">
          <div className="w-4 h-4 rounded mt-0.5 bg-black/30 border border-white/20 flex-shrink-0" />
          <span className="text-xs text-muted-foreground">{field.termsText || 'I accept the terms and conditions.'}</span>
        </div>
      )}
    </div>
  );
}

interface FieldEditorProps {
  field?: Partial<FormField>;
  allFields: FormField[];
  onSave: (data: Partial<FormField>) => void;
  onClose: () => void;
  saving: boolean;
}

function FieldEditor({ field, allFields, onSave, onClose, saving }: FieldEditorProps) {
  const [form, setForm] = useState<Partial<FormField>>({
    fieldType: 'short_text',
    label: '',
    placeholder: '',
    helpText: '',
    required: false,
    options: [],
    conditionalOnFieldId: null,
    conditionalOnValue: '',
    termsText: '',
    ...field,
  });
  const [optionsText, setOptionsText] = useState((field?.options ?? []).join('\n'));

  const hasOptions = form.fieldType === 'dropdown' || form.fieldType === 'checkbox';
  const isTerms = form.fieldType === 'terms_acceptance';

  const handleSave = () => {
    const data = {
      ...form,
      options: hasOptions ? optionsText.split('\n').map(o => o.trim()).filter(Boolean) : null,
    };
    onSave(data);
  };

  return (
    <div className="space-y-4">
      <div>
        <label className="text-xs text-muted-foreground uppercase tracking-wider">Field Type *</label>
        <Select value={form.fieldType} onValueChange={v => setForm(f => ({ ...f, fieldType: v as FieldType }))}>
          <SelectTrigger className="mt-1 bg-black/40 border-white/10 text-white">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="bg-[#0a1628] border-white/10 text-white">
            {(Object.keys(FIELD_TYPE_LABELS) as FieldType[]).map(t => (
              <SelectItem key={t} value={t} className="text-white hover:bg-white/5">
                {FIELD_TYPE_LABELS[t]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div>
        <label className="text-xs text-muted-foreground uppercase tracking-wider">Label *</label>
        <Input value={form.label ?? ''} onChange={e => setForm(f => ({ ...f, label: e.target.value }))}
          placeholder="E.g. Dietary Requirements" className="mt-1 bg-black/40 border-white/10 text-white" />
      </div>

      {!isTerms && (
        <>
          <div>
            <label className="text-xs text-muted-foreground uppercase tracking-wider">Placeholder</label>
            <Input value={form.placeholder ?? ''} onChange={e => setForm(f => ({ ...f, placeholder: e.target.value }))}
              placeholder="Optional hint text" className="mt-1 bg-black/40 border-white/10 text-white" />
          </div>
          <div>
            <label className="text-xs text-muted-foreground uppercase tracking-wider">Help Text</label>
            <Input value={form.helpText ?? ''} onChange={e => setForm(f => ({ ...f, helpText: e.target.value }))}
              placeholder="Additional guidance for players" className="mt-1 bg-black/40 border-white/10 text-white" />
          </div>
        </>
      )}

      {isTerms && (
        <div>
          <label className="text-xs text-muted-foreground uppercase tracking-wider">Terms Text *</label>
          <textarea value={form.termsText ?? ''} onChange={e => setForm(f => ({ ...f, termsText: e.target.value }))}
            placeholder="I accept the terms and conditions and agree to..."
            className="mt-1 w-full bg-black/40 border border-white/10 text-white rounded-md px-3 py-2 text-sm resize-y min-h-[80px]" />
        </div>
      )}

      {hasOptions && (
        <div>
          <label className="text-xs text-muted-foreground uppercase tracking-wider">Options (one per line) *</label>
          <textarea value={optionsText} onChange={e => setOptionsText(e.target.value)}
            placeholder={"Option 1\nOption 2\nOption 3"}
            className="mt-1 w-full bg-black/40 border border-white/10 text-white rounded-md px-3 py-2 text-sm resize-y min-h-[100px] font-mono" />
        </div>
      )}

      <div className="flex items-center gap-3">
        <button
          onClick={() => setForm(f => ({ ...f, required: !f.required }))}
          className={`w-10 h-5 rounded-full transition-colors ${form.required ? 'bg-emerald-500' : 'bg-white/20'} relative`}
        >
          <span className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${form.required ? 'translate-x-5' : 'translate-x-0.5'}`} />
        </button>
        <label className="text-sm text-white">Required field</label>
      </div>

      {allFields.length > 0 && (
        <div className="space-y-2 border border-white/10 rounded-xl p-3">
          <p className="text-xs text-muted-foreground uppercase tracking-wider">Conditional Display</p>
          <Select
            value={form.conditionalOnFieldId ? String(form.conditionalOnFieldId) : 'none'}
            onValueChange={v => setForm(f => ({ ...f, conditionalOnFieldId: v === 'none' ? null : parseInt(v) }))}
          >
            <SelectTrigger className="bg-black/40 border-white/10 text-white text-sm">
              <SelectValue placeholder="Always show" />
            </SelectTrigger>
            <SelectContent className="bg-[#0a1628] border-white/10 text-white">
              <SelectItem value="none" className="text-white hover:bg-white/5">Always show</SelectItem>
              {allFields.filter(f => f.id !== field?.id).map(f => (
                <SelectItem key={f.id} value={String(f.id)} className="text-white hover:bg-white/5">{f.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          {form.conditionalOnFieldId && (
            <Input value={form.conditionalOnValue ?? ''} onChange={e => setForm(f => ({ ...f, conditionalOnValue: e.target.value }))}
              placeholder="Show when value equals…" className="bg-black/40 border-white/10 text-white text-sm" />
          )}
        </div>
      )}

      <div className="flex gap-3 pt-2">
        <Button onClick={handleSave} disabled={saving || !form.label} className="flex-1 bg-emerald-600 hover:bg-emerald-700 text-white">
          {saving ? <><RefreshCw className="w-3.5 h-3.5 mr-1.5 animate-spin" /> Saving…</> : <><Save className="w-3.5 h-3.5 mr-1.5" /> Save Field</>}
        </Button>
        <Button variant="outline" onClick={onClose} className="border-white/10 text-white hover:bg-white/5">Cancel</Button>
      </div>
    </div>
  );
}

// ─── REGISTRATION FORM TAB ────────────────────────────────────────────────────

export function RegistrationFormTab({
  orgId,
  eventId,
  eventType,
}: {
  orgId: number;
  eventId: number;
  eventType: 'tournament' | 'league';
}) {
  const { toast } = useToast();
  const [fields, setFields] = useState<FormField[]>([]);
  const [loading, setLoading] = useState(true);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingField, setEditingField] = useState<FormField | undefined>();
  const [saving, setSaving] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [responsesOpen, setResponsesOpen] = useState(false);
  const [responses, setResponses] = useState<{ fields: FormField[]; entries: ResponseEntry[] } | null>(null);
  const [responsesLoading, setResponsesLoading] = useState(false);
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);

  const base = `/api/organizations/${orgId}/event-forms/${eventType}/${eventId}`;

  const fetchFields = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${base}/fields`, { credentials: 'include' });
      if (res.ok) setFields(await res.json());
    } finally { setLoading(false); }
  }, [base]);

  useEffect(() => { fetchFields(); }, [fetchFields]);

  const openAdd = () => { setEditingField(undefined); setEditorOpen(true); };
  const openEdit = (f: FormField) => { setEditingField(f); setEditorOpen(true); };

  const handleSave = async (data: Partial<FormField>) => {
    setSaving(true);
    try {
      const url = editingField ? `${base}/fields/${editingField.id}` : `${base}/fields`;
      const method = editingField ? 'PATCH' : 'POST';
      const res = await fetch(url, {
        method, credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (!res.ok) { const d = await res.json(); toast({ title: d.error ?? 'Failed', variant: 'destructive' }); return; }
      toast({ title: editingField ? 'Field updated' : 'Field added' });
      setEditorOpen(false);
      fetchFields();
    } finally { setSaving(false); }
  };

  const handleDelete = async (id: number) => {
    if (!confirm('Delete this field? Existing responses will also be deleted.')) return;
    await fetch(`${base}/fields/${id}`, { method: 'DELETE', credentials: 'include' });
    toast({ title: 'Field deleted' });
    fetchFields();
  };

  const handleReorder = async (newOrder: FormField[]) => {
    setFields(newOrder);
    await fetch(`${base}/fields/reorder`, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderedIds: newOrder.map(f => f.id) }),
    });
  };

  const handleDragStart = (idx: number) => setDragIdx(idx);
  const handleDragOver = (e: React.DragEvent, idx: number) => { e.preventDefault(); setDragOverIdx(idx); };
  const handleDrop = (idx: number) => {
    if (dragIdx === null || dragIdx === idx) { setDragIdx(null); setDragOverIdx(null); return; }
    const reordered = [...fields];
    const [moved] = reordered.splice(dragIdx, 1);
    reordered.splice(idx, 0, moved);
    handleReorder(reordered);
    setDragIdx(null);
    setDragOverIdx(null);
  };

  const fetchResponses = async () => {
    setResponsesLoading(true);
    try {
      const res = await fetch(`${base}/responses`, { credentials: 'include' });
      if (res.ok) setResponses(await res.json());
    } finally { setResponsesLoading(false); }
  };

  const exportCsv = () => {
    window.open(`${base}/responses/csv`, '_blank');
  };

  return (
    <div className="space-y-4">
      <Card className="glass-card">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <CardTitle className="text-white flex items-center gap-2">
              <ClipboardList className="w-4 h-4 text-emerald-400" /> Registration Form Builder
            </CardTitle>
            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" onClick={() => setPreviewOpen(true)}
                className="border-white/10 text-white hover:bg-white/5 gap-1.5">
                <Eye className="w-3.5 h-3.5" /> Preview
              </Button>
              <Button size="sm" variant="outline" onClick={() => { fetchResponses(); setResponsesOpen(true); }}
                className="border-white/10 text-white hover:bg-white/5 gap-1.5">
                <Users className="w-3.5 h-3.5" /> Responses
              </Button>
              <Button size="sm" onClick={openAdd} className="bg-emerald-600 hover:bg-emerald-700 text-white gap-1.5">
                <Plus className="w-3.5 h-3.5" /> Add Field
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="text-muted-foreground text-sm py-8 text-center">Loading…</div>
          ) : fields.length === 0 ? (
            <div className="text-center py-12 space-y-3">
              <ClipboardList className="w-10 h-10 text-muted-foreground mx-auto opacity-40" />
              <p className="text-muted-foreground text-sm">No custom fields yet.</p>
              <p className="text-xs text-muted-foreground">Add fields like dietary requirements, shirt size, or T&C acceptance that players will fill in when registering.</p>
              <Button onClick={openAdd} size="sm" className="bg-emerald-600 hover:bg-emerald-700 text-white gap-1.5 mt-2">
                <Plus className="w-3.5 h-3.5" /> Add First Field
              </Button>
            </div>
          ) : (
            <div className="space-y-2">
              {fields.map((field, idx) => (
                <div
                  key={field.id}
                  draggable
                  onDragStart={() => handleDragStart(idx)}
                  onDragOver={e => handleDragOver(e, idx)}
                  onDrop={() => handleDrop(idx)}
                  onDragEnd={() => { setDragIdx(null); setDragOverIdx(null); }}
                  className={`flex items-center gap-3 p-3 rounded-xl border transition-all cursor-move ${
                    dragOverIdx === idx
                      ? 'border-emerald-500/50 bg-emerald-500/10'
                      : 'border-white/10 bg-black/20 hover:border-white/20'
                  }`}
                >
                  <GripVertical className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-muted-foreground">{FIELD_ICONS[field.fieldType]}</span>
                      <span className="text-sm font-medium text-white truncate">{field.label}</span>
                      {field.required && <Badge className="bg-red-500/20 text-red-400 border-red-500/30 text-xs">Required</Badge>}
                      {field.conditionalOnFieldId && <Badge className="bg-yellow-500/20 text-yellow-400 border-yellow-500/30 text-xs">Conditional</Badge>}
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">{FIELD_TYPE_LABELS[field.fieldType]}</p>
                  </div>
                  <div className="flex items-center gap-1">
                    <button onClick={() => openEdit(field)} className="p-1.5 rounded-lg hover:bg-white/10 text-muted-foreground hover:text-white transition-colors">
                      <Edit3 className="w-3.5 h-3.5" />
                    </button>
                    <button onClick={() => handleDelete(field.id)} className="p-1.5 rounded-lg hover:bg-red-500/10 text-muted-foreground hover:text-red-400 transition-colors">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              ))}
              <p className="text-xs text-muted-foreground pt-2 text-center">Drag to reorder fields</p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Field Editor Dialog */}
      <Dialog open={editorOpen} onOpenChange={setEditorOpen}>
        <DialogContent className="bg-[#0a1628] border border-white/10 text-white max-w-lg">
          <DialogHeader>
            <DialogTitle>{editingField ? 'Edit Field' : 'Add Custom Field'}</DialogTitle>
          </DialogHeader>
          <FieldEditor
            field={editingField}
            allFields={fields}
            onSave={handleSave}
            onClose={() => setEditorOpen(false)}
            saving={saving}
          />
        </DialogContent>
      </Dialog>

      {/* Preview Dialog */}
      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent className="bg-[#0a1628] border border-white/10 text-white max-w-lg max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><Eye className="w-4 h-4 text-emerald-400" /> Player Preview</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 mt-2">
            {fields.length === 0 ? (
              <p className="text-muted-foreground text-sm text-center py-8">No fields added yet.</p>
            ) : (
              fields.map(field => <FieldPreview key={field.id} field={field} />)
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Responses Dialog */}
      <Dialog open={responsesOpen} onOpenChange={setResponsesOpen}>
        <DialogContent className="bg-[#0a1628] border border-white/10 text-white max-w-4xl max-h-[80vh] overflow-hidden flex flex-col">
          <DialogHeader>
            <div className="flex items-center justify-between">
              <DialogTitle className="flex items-center gap-2"><Users className="w-4 h-4 text-emerald-400" /> Registration Responses</DialogTitle>
              <Button size="sm" variant="outline" onClick={exportCsv}
                className="border-white/10 text-white hover:bg-white/5 gap-1.5 text-xs">
                <FileDown className="w-3.5 h-3.5" /> Export CSV
              </Button>
            </div>
          </DialogHeader>
          <div className="flex-1 overflow-auto mt-2">
            {responsesLoading ? (
              <div className="text-muted-foreground text-sm py-8 text-center">Loading…</div>
            ) : !responses || responses.entries.length === 0 ? (
              <p className="text-muted-foreground text-sm text-center py-8">No responses yet.</p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-white/10">
                    <th className="text-left text-muted-foreground font-medium py-2 px-3">Player</th>
                    {responses.fields.map(f => (
                      <th key={f.id} className="text-left text-muted-foreground font-medium py-2 px-3 whitespace-nowrap">{f.label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {responses.entries.map(entry => (
                    <tr key={entry.entryId} className="border-b border-white/5 hover:bg-white/5">
                      <td className="py-2 px-3 text-white font-medium">{entry.entryName}</td>
                      {responses.fields.map(f => (
                        <td key={f.id} className="py-2 px-3 text-muted-foreground max-w-[200px] truncate">
                          {entry.answers[f.id] ?? '—'}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── SURVEY FIELD EDITOR ──────────────────────────────────────────────────────

interface SurveyFieldEditorProps {
  field?: Partial<SurveyField>;
  onSave: (data: Partial<SurveyField>) => void;
  onClose: () => void;
  saving: boolean;
}

function SurveyFieldEditor({ field, onSave, onClose, saving }: SurveyFieldEditorProps) {
  const [form, setForm] = useState<Partial<SurveyField>>({
    fieldType: 'short_text',
    label: '',
    placeholder: '',
    helpText: '',
    required: false,
    options: [],
    termsText: '',
    ...field,
  });
  const [optionsText, setOptionsText] = useState((field?.options ?? []).join('\n'));

  const hasOptions = form.fieldType === 'dropdown' || form.fieldType === 'checkbox';
  const isTerms = form.fieldType === 'terms_acceptance';

  const handleSave = () => {
    const data = { ...form, options: hasOptions ? optionsText.split('\n').map(o => o.trim()).filter(Boolean) : null };
    onSave(data);
  };

  return (
    <div className="space-y-4">
      <div>
        <label className="text-xs text-muted-foreground uppercase tracking-wider">Field Type *</label>
        <Select value={form.fieldType} onValueChange={v => setForm(f => ({ ...f, fieldType: v as FieldType }))}>
          <SelectTrigger className="mt-1 bg-black/40 border-white/10 text-white"><SelectValue /></SelectTrigger>
          <SelectContent className="bg-[#0a1628] border-white/10 text-white">
            {(Object.keys(FIELD_TYPE_LABELS) as FieldType[]).map(t => (
              <SelectItem key={t} value={t} className="text-white hover:bg-white/5">{FIELD_TYPE_LABELS[t]}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div>
        <label className="text-xs text-muted-foreground uppercase tracking-wider">Question / Label *</label>
        <Input value={form.label ?? ''} onChange={e => setForm(f => ({ ...f, label: e.target.value }))}
          placeholder="E.g. How would you rate today's event?" className="mt-1 bg-black/40 border-white/10 text-white" />
      </div>
      {!isTerms && (
        <div>
          <label className="text-xs text-muted-foreground uppercase tracking-wider">Help Text</label>
          <Input value={form.helpText ?? ''} onChange={e => setForm(f => ({ ...f, helpText: e.target.value }))}
            placeholder="Additional guidance" className="mt-1 bg-black/40 border-white/10 text-white" />
        </div>
      )}
      {isTerms && (
        <div>
          <label className="text-xs text-muted-foreground uppercase tracking-wider">Terms Text</label>
          <textarea value={form.termsText ?? ''} onChange={e => setForm(f => ({ ...f, termsText: e.target.value }))}
            className="mt-1 w-full bg-black/40 border border-white/10 text-white rounded-md px-3 py-2 text-sm resize-y min-h-[80px]" />
        </div>
      )}
      {hasOptions && (
        <div>
          <label className="text-xs text-muted-foreground uppercase tracking-wider">Options (one per line)</label>
          <textarea value={optionsText} onChange={e => setOptionsText(e.target.value)}
            placeholder={"Excellent\nGood\nFair\nPoor"}
            className="mt-1 w-full bg-black/40 border border-white/10 text-white rounded-md px-3 py-2 text-sm resize-y min-h-[100px] font-mono" />
        </div>
      )}
      <div className="flex items-center gap-3">
        <button onClick={() => setForm(f => ({ ...f, required: !f.required }))}
          className={`w-10 h-5 rounded-full transition-colors ${form.required ? 'bg-emerald-500' : 'bg-white/20'} relative`}>
          <span className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${form.required ? 'translate-x-5' : 'translate-x-0.5'}`} />
        </button>
        <label className="text-sm text-white">Required</label>
      </div>
      <div className="flex gap-3 pt-2">
        <Button onClick={handleSave} disabled={saving || !form.label} className="flex-1 bg-emerald-600 hover:bg-emerald-700 text-white">
          {saving ? 'Saving…' : 'Save Question'}
        </Button>
        <Button variant="outline" onClick={onClose} className="border-white/10 text-white hover:bg-white/5">Cancel</Button>
      </div>
    </div>
  );
}

// ─── SURVEY TAB ───────────────────────────────────────────────────────────────

export function SurveyTab({
  orgId,
  eventId,
  eventType,
}: {
  orgId: number;
  eventId: number;
  eventType: 'tournament' | 'league';
}) {
  const { toast } = useToast();
  const [survey, setSurvey] = useState<SurveyForm | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingField, setEditingField] = useState<SurveyField | undefined>();
  const [fieldSaving, setFieldSaving] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [resultsOpen, setResultsOpen] = useState(false);
  const [results, setResults] = useState<{
    survey: SurveyForm;
    fields: SurveyField[];
    results: { field: SurveyField; tally: Record<string, number>; freeText: string[]; count: number }[];
    responseRate: number;
    totalRespondents: number;
    responded: number;
    rawRows: { respondentId: number; respondentName: string | null; respondedAt: string | null; answers: Record<number, string | null> }[];
  } | null>(null);
  const [resultsLoading, setResultsLoading] = useState(false);
  const [sendLoading, setSendLoading] = useState(false);
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);

  const base = `/api/organizations/${orgId}/event-forms/${eventType}/${eventId}`;

  const fetchSurvey = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${base}/survey`, { credentials: 'include' });
      if (res.ok) setSurvey(await res.json());
    } finally { setLoading(false); }
  }, [base]);

  useEffect(() => { fetchSurvey(); }, [fetchSurvey]);

  const saveMeta = async (updates: Partial<SurveyForm>) => {
    if (!survey) return;
    setSaving(true);
    try {
      const res = await fetch(`${base}/survey`, {
        method: 'PUT', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...survey, ...updates }),
      });
      if (res.ok) { setSurvey(await res.json()); toast({ title: 'Survey settings saved' }); }
      else { const d = await res.json(); toast({ title: d.error ?? 'Failed', variant: 'destructive' }); }
    } finally { setSaving(false); }
  };

  const handleFieldSave = async (data: Partial<SurveyField>) => {
    if (!survey) return;
    setFieldSaving(true);
    try {
      const url = editingField ? `${base}/survey/fields/${editingField.id}` : `${base}/survey/fields`;
      const method = editingField ? 'PATCH' : 'POST';
      const res = await fetch(url, {
        method, credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (!res.ok) { const d = await res.json(); toast({ title: d.error ?? 'Failed', variant: 'destructive' }); return; }
      toast({ title: editingField ? 'Question updated' : 'Question added' });
      setEditorOpen(false);
      fetchSurvey();
    } finally { setFieldSaving(false); }
  };

  const handleDeleteField = async (id: number) => {
    if (!survey) return;
    if (!confirm('Delete this question?')) return;
    await fetch(`${base}/survey/fields/${id}`, { method: 'DELETE', credentials: 'include' });
    toast({ title: 'Question deleted' });
    fetchSurvey();
  };

  const handleDragStart = (idx: number) => setDragIdx(idx);
  const handleDragOver = (e: React.DragEvent, idx: number) => { e.preventDefault(); setDragOverIdx(idx); };
  const handleDrop = async (idx: number) => {
    if (!survey || dragIdx === null || dragIdx === idx) { setDragIdx(null); setDragOverIdx(null); return; }
    const reordered = [...survey.fields];
    const [moved] = reordered.splice(dragIdx, 1);
    reordered.splice(idx, 0, moved);
    setSurvey(s => s ? { ...s, fields: reordered } : s);
    await fetch(`${base}/survey/fields/reorder`, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderedIds: reordered.map(f => f.id) }),
    });
    setDragIdx(null); setDragOverIdx(null);
  };

  const sendNow = async () => {
    if (!confirm('Send the survey now to all participants? This cannot be undone.')) return;
    setSendLoading(true);
    try {
      const res = await fetch(`${base}/survey/send`, { method: 'POST', credentials: 'include' });
      const d = await res.json();
      if (res.ok) { toast({ title: 'Survey emails enqueued!', description: d.message }); fetchSurvey(); }
      else { toast({ title: d.error ?? 'Failed to send', variant: 'destructive' }); }
    } finally { setSendLoading(false); }
  };

  const fetchResults = async () => {
    setResultsLoading(true);
    try {
      const res = await fetch(`${base}/survey/results`, { credentials: 'include' });
      if (res.ok) setResults(await res.json());
    } finally { setResultsLoading(false); }
  };

  const exportResultsCsv = () => window.open(`${base}/survey/results/csv`, '_blank');

  if (loading) return <div className="text-muted-foreground text-sm py-12 text-center">Loading…</div>;
  if (!survey) return null;

  return (
    <div className="space-y-4">
      {/* Survey Configuration */}
      <Card className="glass-card">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <CardTitle className="text-white flex items-center gap-2">
              <FileText className="w-4 h-4 text-blue-400" /> Post-Event Survey
            </CardTitle>
            <div className="flex items-center gap-2">
              {survey.sentAt && (
                <Badge className="bg-emerald-500/20 text-emerald-400 border-emerald-500/30 text-xs">
                  Sent {new Date(survey.sentAt).toLocaleDateString()}
                </Badge>
              )}
              <Button size="sm" variant="outline" onClick={() => setPreviewOpen(true)}
                className="border-white/10 text-white hover:bg-white/5 gap-1.5">
                <Eye className="w-3.5 h-3.5" /> Preview
              </Button>
              <Button size="sm" variant="outline" onClick={() => { fetchResults(); setResultsOpen(true); }}
                className="border-white/10 text-white hover:bg-white/5 gap-1.5">
                <BarChart2 className="w-3.5 h-3.5" /> Results
              </Button>
              <Button size="sm" onClick={sendNow} disabled={sendLoading || survey.fields.length === 0}
                className="bg-blue-600 hover:bg-blue-700 text-white gap-1.5">
                {sendLoading ? <><RefreshCw className="w-3.5 h-3.5 animate-spin" /> Sending…</> : <><Send className="w-3.5 h-3.5" /> Send Now</>}
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="text-xs text-muted-foreground uppercase tracking-wider">Survey Title</label>
              <Input
                defaultValue={survey.title}
                onBlur={e => { if (e.target.value !== survey.title) saveMeta({ title: e.target.value }); }}
                className="mt-1 bg-black/40 border-white/10 text-white"
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground uppercase tracking-wider">Send Delay (hours after completion)</label>
              <Input
                type="number"
                min={0}
                defaultValue={survey.sendDelayHours}
                onBlur={e => {
                  const v = parseInt(e.target.value);
                  if (!isNaN(v) && v !== survey.sendDelayHours) saveMeta({ sendDelayHours: v });
                }}
                className="mt-1 bg-black/40 border-white/10 text-white"
              />
            </div>
          </div>
          <div>
            <label className="text-xs text-muted-foreground uppercase tracking-wider">Description (optional)</label>
            <textarea
              defaultValue={survey.description ?? ''}
              onBlur={e => { if (e.target.value !== (survey.description ?? '')) saveMeta({ description: e.target.value || null }); }}
              placeholder="Tell participants what this survey is about…"
              className="mt-1 w-full bg-black/40 border border-white/10 text-white rounded-md px-3 py-2 text-sm resize-y min-h-[60px]"
            />
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={() => saveMeta({ isActive: !survey.isActive })}
              className={`w-10 h-5 rounded-full transition-colors ${survey.isActive ? 'bg-emerald-500' : 'bg-white/20'} relative`}
            >
              <span className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${survey.isActive ? 'translate-x-5' : 'translate-x-0.5'}`} />
            </button>
            <label className="text-sm text-white">Survey active (accepts responses)</label>
          </div>
          <div className="rounded-xl bg-blue-500/10 border border-blue-500/20 p-3 text-xs text-blue-300 flex items-start gap-2">
            <Clock className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
            <span>
              {survey.sendDelayHours === 0
                ? 'Survey emails will be sent immediately when the event is marked as completed.'
                : `Survey emails will be sent ${survey.sendDelayHours} hour${survey.sendDelayHours !== 1 ? 's' : ''} after the event is marked as completed.`
              }
              {' '}You can also send manually using "Send Now".
            </span>
          </div>
        </CardContent>
      </Card>

      {/* Question Builder */}
      <Card className="glass-card">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-white text-base">Questions ({survey.fields.length})</CardTitle>
            <Button size="sm" onClick={() => { setEditingField(undefined); setEditorOpen(true); }}
              className="bg-blue-600 hover:bg-blue-700 text-white gap-1.5">
              <Plus className="w-3.5 h-3.5" /> Add Question
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {survey.fields.length === 0 ? (
            <div className="text-center py-8 space-y-2">
              <FileText className="w-8 h-8 text-muted-foreground mx-auto opacity-40" />
              <p className="text-muted-foreground text-sm">No questions yet. Add questions to get feedback from participants.</p>
            </div>
          ) : (
            <div className="space-y-2">
              {survey.fields.map((field, idx) => (
                <div
                  key={field.id}
                  draggable
                  onDragStart={() => handleDragStart(idx)}
                  onDragOver={e => handleDragOver(e, idx)}
                  onDrop={() => handleDrop(idx)}
                  onDragEnd={() => { setDragIdx(null); setDragOverIdx(null); }}
                  className={`flex items-center gap-3 p-3 rounded-xl border transition-all cursor-move ${
                    dragOverIdx === idx
                      ? 'border-blue-500/50 bg-blue-500/10'
                      : 'border-white/10 bg-black/20 hover:border-white/20'
                  }`}
                >
                  <GripVertical className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-muted-foreground">{FIELD_ICONS[field.fieldType]}</span>
                      <span className="text-sm font-medium text-white truncate">{field.label}</span>
                      {field.required && <Badge className="bg-red-500/20 text-red-400 border-red-500/30 text-xs">Required</Badge>}
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">{FIELD_TYPE_LABELS[field.fieldType]}</p>
                  </div>
                  <div className="flex items-center gap-1">
                    <button onClick={() => { setEditingField(field); setEditorOpen(true); }}
                      className="p-1.5 rounded-lg hover:bg-white/10 text-muted-foreground hover:text-white transition-colors">
                      <Edit3 className="w-3.5 h-3.5" />
                    </button>
                    <button onClick={() => handleDeleteField(field.id)}
                      className="p-1.5 rounded-lg hover:bg-red-500/10 text-muted-foreground hover:text-red-400 transition-colors">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              ))}
              <p className="text-xs text-muted-foreground pt-2 text-center">Drag to reorder</p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Survey Field Editor Dialog */}
      <Dialog open={editorOpen} onOpenChange={setEditorOpen}>
        <DialogContent className="bg-[#0a1628] border border-white/10 text-white max-w-lg">
          <DialogHeader>
            <DialogTitle>{editingField ? 'Edit Question' : 'Add Survey Question'}</DialogTitle>
          </DialogHeader>
          <SurveyFieldEditor
            field={editingField}
            onSave={handleFieldSave}
            onClose={() => setEditorOpen(false)}
            saving={fieldSaving}
          />
        </DialogContent>
      </Dialog>

      {/* Preview Dialog */}
      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent className="bg-[#0a1628] border border-white/10 text-white max-w-lg max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{survey.title}</DialogTitle>
            {survey.description && <p className="text-sm text-muted-foreground mt-1">{survey.description}</p>}
          </DialogHeader>
          <div className="space-y-5 mt-2">
            {survey.fields.length === 0 ? (
              <p className="text-muted-foreground text-sm text-center py-8">No questions added yet.</p>
            ) : (
              survey.fields.map(field => <FieldPreview key={field.id} field={field} />)
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Results Dialog */}
      <Dialog open={resultsOpen} onOpenChange={setResultsOpen}>
        <DialogContent className="bg-[#0a1628] border border-white/10 text-white max-w-3xl max-h-[80vh] overflow-hidden flex flex-col">
          <DialogHeader>
            <div className="flex items-center justify-between">
              <DialogTitle className="flex items-center gap-2"><BarChart2 className="w-4 h-4 text-blue-400" /> Survey Results</DialogTitle>
              <Button size="sm" variant="outline" onClick={exportResultsCsv}
                className="border-white/10 text-white hover:bg-white/5 gap-1.5 text-xs">
                <FileDown className="w-3.5 h-3.5" /> Export CSV
              </Button>
            </div>
          </DialogHeader>
          <div className="flex-1 overflow-y-auto space-y-4 mt-2">
            {resultsLoading ? (
              <div className="text-muted-foreground text-sm py-8 text-center">Loading…</div>
            ) : !results ? (
              <p className="text-muted-foreground text-sm text-center py-8">No results data.</p>
            ) : (
              <>
                <div className="grid grid-cols-3 gap-3">
                  <div className="glass-panel rounded-xl p-4 text-center">
                    <p className="text-2xl font-bold text-white">{results.responseRate}%</p>
                    <p className="text-xs text-muted-foreground mt-1">Response Rate</p>
                  </div>
                  <div className="glass-panel rounded-xl p-4 text-center">
                    <p className="text-2xl font-bold text-emerald-400">{results.responded}</p>
                    <p className="text-xs text-muted-foreground mt-1">Responded</p>
                  </div>
                  <div className="glass-panel rounded-xl p-4 text-center">
                    <p className="text-2xl font-bold text-white">{results.totalRespondents}</p>
                    <p className="text-xs text-muted-foreground mt-1">Total Sent</p>
                  </div>
                </div>
                {results.results.map(r => (
                  <div key={r.field.id} className="glass-panel rounded-xl p-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <p className="text-sm font-medium text-white">{r.field.label}</p>
                      <span className="text-xs text-muted-foreground">{r.count} response{r.count !== 1 ? 's' : ''}</span>
                    </div>
                    {Object.keys(r.tally).length > 0 && (
                      <div className="space-y-2">
                        {Object.entries(r.tally).sort(([, a], [, b]) => b - a).map(([opt, cnt]) => (
                          <div key={opt} className="space-y-1">
                            <div className="flex justify-between text-xs text-muted-foreground">
                              <span>{opt}</span>
                              <span>{cnt} ({r.count > 0 ? Math.round(cnt / r.count * 100) : 0}%)</span>
                            </div>
                            <div className="h-2 rounded-full bg-white/10 overflow-hidden">
                              <div
                                className="h-full rounded-full bg-blue-500 transition-all"
                                style={{ width: `${r.count > 0 ? (cnt / r.count) * 100 : 0}%` }}
                              />
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                    {r.freeText.length > 0 && (
                      <div className="space-y-1.5 max-h-32 overflow-y-auto">
                        {r.freeText.map((t, i) => (
                          <p key={i} className="text-xs text-muted-foreground bg-black/30 rounded-lg px-3 py-2">"{t}"</p>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
