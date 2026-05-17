import { useState, useEffect, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Bell, Settings, Plus, Send, Eye, Edit3, Trash2, Loader2, RefreshCw, AlertTriangle } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';

interface AutomationRule {
  id: number;
  orgId: number;
  tournamentId: number | null;
  leagueId: number | null;
  name: string;
  triggerType: string;
  triggerParams: { value?: number; unit?: string } | null;
  channel: string;
  audienceFilter: { type: string; flightId?: number } | null;
  subject: string | null;
  body: string;
  isActive: boolean;
  lastTriggeredAt: string | null;
  createdAt: string;
}

interface AutomationRuleLog {
  id: number;
  ruleId: number;
  triggeredAt: string;
  audienceSize: number;
  deliveredCount: number;
  failedCount: number;
  status: string;
  errorMessage: string | null;
}

interface AutomationTemplate {
  id: string;
  name: string;
  triggerType: string;
  triggerParams: { value?: number; unit?: string };
  channel: string;
  audienceFilter: { type: string };
  subject: string;
  body: string;
}

interface Flight {
  id: number;
  name: string;
}

const TRIGGER_LABELS: Record<string, string> = {
  event_created: 'Event Created',
  registration_opens: 'Registration Opens',
  registration_deadline: 'Before Registration Deadline',
  draw_published: 'Draw Published',
  event_starts: 'Before Event Starts',
  round_complete: 'Round Completed',
  event_closed: 'Event Closed',
};

const CHANNEL_LABELS: Record<string, string> = {
  email: '📧 Email',
  push: '🔔 Push Notification',
};

const AUDIENCE_LABELS: Record<string, string> = {
  all_registrants: 'All Registrants',
  unpaid_registrants: 'Unpaid Registrants',
  specific_flight: 'Specific Flight',
  all_members: 'All Members',
};

const MERGE_TAGS = ['{{player_name}}', '{{tournament_name}}', '{{league_name}}', '{{tee_time}}', '{{draw_link}}', '{{results_link}}', '{{org_name}}'];

function triggerDescription(rule: Pick<AutomationRule, 'triggerType' | 'triggerParams'>): string {
  const base = TRIGGER_LABELS[rule.triggerType] ?? rule.triggerType;
  if (rule.triggerParams?.value && (rule.triggerType === 'registration_deadline' || rule.triggerType === 'event_starts')) {
    return `${rule.triggerParams.value} ${rule.triggerParams.unit ?? 'hours'} before — ${base.replace('Before ', '')}`;
  }
  return base;
}

interface Props {
  orgId: number;
  tournamentId?: number | null;
  leagueId?: number | null;
  automation?: { autoWelcome: boolean; autoReminder: boolean; autoResults: boolean; autoPostWhs: boolean; notifyManualEntryAlerts: boolean };
  autoSaving?: boolean;
  saveAutomation?: (key: string, value: boolean) => void;
  // Task #1674 — optional callback for updating the parent's local
  // automation state WITHOUT firing a PATCH. Used by the override-
  // restore flow where the server has already flipped the value.
  onAutomationLocallyUpdated?: (key: string, value: boolean) => void;
}

export function AutomationRulesPanel({ orgId, tournamentId, leagueId, automation, autoSaving, saveAutomation, onAutomationLocallyUpdated }: Props) {
  const { toast } = useToast();
  const [rules, setRules] = useState<AutomationRule[]>([]);
  const [templates, setTemplates] = useState<AutomationTemplate[]>([]);
  const [flights, setFlights] = useState<Flight[]>([]);
  const [loading, setLoading] = useState(true);
  const [showDrawer, setShowDrawer] = useState(false);
  const [editingRule, setEditingRule] = useState<AutomationRule | null>(null);
  const [expandedLogs, setExpandedLogs] = useState<Record<number, AutomationRuleLog[]>>({});
  const [logsLoading, setLogsLoading] = useState<number | null>(null);
  const [testSending, setTestSending] = useState<number | null>(null);
  const [retrying, setRetrying] = useState<number | null>(null);

  // Task #1674 — banner shown when a club admin's recent bulk-apply
  // flipped this tournament's manual-entry alert preference. Loaded
  // once on mount and after every restore so the row disappears the
  // moment the director acts. Only meaningful for tournament-scoped
  // automation (the panel is shared with leagues).
  type OverrideNotice = {
    id: number;
    setting: 'notifyManualEntryAlerts';
    previousValue: boolean;
    appliedValue: boolean;
    appliedAt: string;
    appliedByName: string | null;
  };
  const [overrideNotice, setOverrideNotice] = useState<OverrideNotice | null>(null);
  const [restoringOverride, setRestoringOverride] = useState(false);
  const [dismissingOverride, setDismissingOverride] = useState(false);

  const [form, setForm] = useState({
    name: '',
    triggerType: 'event_starts',
    triggerValue: 24,
    triggerUnit: 'hours' as 'hours' | 'days',
    channel: 'email',
    audienceType: 'all_registrants',
    flightId: null as number | null,
    subject: '',
    body: '',
    isActive: true,
  });

  const qs = tournamentId ? `?tournamentId=${tournamentId}` : leagueId ? `?leagueId=${leagueId}` : '';

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [rulesRes, tmplRes] = await Promise.all([
        fetch(`/api/organizations/${orgId}/automation-rules${qs}`, { credentials: 'include' }).then(r => r.ok ? r.json() : []),
        fetch(`/api/organizations/${orgId}/automation-rules/templates`, { credentials: 'include' }).then(r => r.ok ? r.json() : []),
      ]);
      setRules(rulesRes);
      setTemplates(tmplRes);
    } finally {
      setLoading(false);
    }
  }, [orgId, qs]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!tournamentId) return;
    fetch(`/api/organizations/${orgId}/tournaments/${tournamentId}/flights`, { credentials: 'include' })
      .then(r => r.ok ? r.json() : [])
      .then((data: Flight[]) => setFlights(data))
      .catch(() => {});
  }, [orgId, tournamentId]);

  // Task #1674 — pull the latest unacknowledged bulk-apply override
  // notice for this tournament. Endpoint already filters out the row
  // for the user who actually pressed the bulk-apply button so admins
  // don't see banners about their own actions.
  const loadOverrideNotice = useCallback(async () => {
    if (!tournamentId) { setOverrideNotice(null); return; }
    try {
      const res = await fetch(
        `/api/organizations/${orgId}/tournaments/${tournamentId}/manual-entry-override-notice`,
        { credentials: 'include' },
      );
      const data = res.ok ? await res.json() : { notice: null };
      setOverrideNotice(data?.notice ?? null);
    } catch {
      setOverrideNotice(null);
    }
  }, [orgId, tournamentId]);

  useEffect(() => { loadOverrideNotice(); }, [loadOverrideNotice]);

  const restoreOverride = async () => {
    if (!tournamentId || !overrideNotice || restoringOverride) return;
    setRestoringOverride(true);
    try {
      const res = await fetch(
        `/api/organizations/${orgId}/tournaments/${tournamentId}/manual-entry-override-notice/restore`,
        { method: 'POST', credentials: 'include' },
      );
      const data = res.ok ? await res.json() : null;
      if (!res.ok) {
        toast({ title: 'Could not restore your preference', variant: 'destructive' });
        return;
      }
      // Update the local automation toggle in the parent so the UI
      // reflects the restored value without needing a full reload.
      // The server has already persisted the restored value, so we use
      // the local-only callback to avoid firing a redundant PATCH.
      if (onAutomationLocallyUpdated && data && typeof data.notifyManualEntryAlerts === 'boolean') {
        onAutomationLocallyUpdated('notifyManualEntryAlerts', data.notifyManualEntryAlerts);
      }
      setOverrideNotice(null);
      toast({
        title: 'Preference restored',
        description: 'Your manual-entry alert setting has been put back the way you had it.',
      });
    } finally {
      setRestoringOverride(false);
    }
  };

  // Task #2089 — Acknowledge the override without changing the
  // tournament's stored value. For directors who actually agree with
  // the new value and just want the banner to go away.
  const dismissOverride = async () => {
    if (!tournamentId || !overrideNotice || dismissingOverride) return;
    setDismissingOverride(true);
    try {
      const res = await fetch(
        `/api/organizations/${orgId}/tournaments/${tournamentId}/manual-entry-override-notice/dismiss`,
        { method: 'POST', credentials: 'include' },
      );
      if (!res.ok) {
        toast({ title: 'Could not dismiss the notice', variant: 'destructive' });
        return;
      }
      setOverrideNotice(null);
      toast({
        title: 'Notice dismissed',
        description: 'Your manual-entry alert setting was left unchanged.',
      });
    } finally {
      setDismissingOverride(false);
    }
  };

  const resetForm = () => setForm({ name: '', triggerType: 'event_starts', triggerValue: 24, triggerUnit: 'hours', channel: 'email', audienceType: 'all_registrants', flightId: null, subject: '', body: '', isActive: true });

  const openNew = () => { setEditingRule(null); resetForm(); setShowDrawer(true); };

  const openEdit = (rule: AutomationRule) => {
    setEditingRule(rule);
    const hasTimingParam = rule.triggerType === 'registration_deadline' || rule.triggerType === 'event_starts';
    setForm({
      name: rule.name,
      triggerType: rule.triggerType,
      triggerValue: hasTimingParam ? (rule.triggerParams?.value ?? 24) : 24,
      triggerUnit: (rule.triggerParams?.unit as 'hours' | 'days') ?? 'hours',
      channel: rule.channel,
      audienceType: rule.audienceFilter?.type ?? 'all_registrants',
      flightId: rule.audienceFilter?.flightId ?? null,
      subject: rule.subject ?? '',
      body: rule.body,
      isActive: rule.isActive,
    });
    setShowDrawer(true);
  };

  const applyTemplate = (tmpl: AutomationTemplate) => {
    const hasTimingParam = tmpl.triggerType === 'registration_deadline' || tmpl.triggerType === 'event_starts';
    setEditingRule(null);
    setForm({
      name: tmpl.name,
      triggerType: tmpl.triggerType,
      triggerValue: hasTimingParam ? (tmpl.triggerParams?.value ?? 24) : 24,
      triggerUnit: (tmpl.triggerParams?.unit as 'hours' | 'days') ?? 'hours',
      channel: tmpl.channel,
      audienceType: tmpl.audienceFilter?.type ?? 'all_registrants',
      flightId: null,
      subject: tmpl.subject,
      body: tmpl.body,
      isActive: true,
    });
    setShowDrawer(true);
  };

  const saveRule = async () => {
    if (!form.name || !form.body) { toast({ title: 'Name and body are required', variant: 'destructive' }); return; }
    if (form.audienceType === 'specific_flight' && !form.flightId && tournamentId) {
      toast({ title: 'Please select a flight', variant: 'destructive' }); return;
    }
    const hasTimingParam = form.triggerType === 'registration_deadline' || form.triggerType === 'event_starts';
    const audienceFilter: { type: string; flightId?: number } = { type: form.audienceType };
    if (form.audienceType === 'specific_flight' && form.flightId) audienceFilter.flightId = form.flightId;
    const payload = {
      name: form.name,
      triggerType: form.triggerType,
      triggerParams: hasTimingParam ? { value: form.triggerValue, unit: form.triggerUnit } : null,
      channel: form.channel,
      audienceFilter,
      subject: form.subject || null,
      body: form.body,
      isActive: form.isActive,
      ...(tournamentId ? { tournamentId } : {}),
      ...(leagueId ? { leagueId } : {}),
    };
    try {
      if (editingRule) {
        const res = await fetch(`/api/organizations/${orgId}/automation-rules/${editingRule.id}`, {
          method: 'PUT', credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!res.ok) throw new Error();
        toast({ title: 'Rule updated' });
      } else {
        const res = await fetch(`/api/organizations/${orgId}/automation-rules`, {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!res.ok) throw new Error();
        toast({ title: 'Rule created' });
      }
      setShowDrawer(false);
      load();
    } catch {
      toast({ title: 'Failed to save rule', variant: 'destructive' });
    }
  };

  const toggleRule = async (rule: AutomationRule) => {
    try {
      await fetch(`/api/organizations/${orgId}/automation-rules/${rule.id}`, {
        method: 'PUT', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isActive: !rule.isActive }),
      });
      setRules(prev => prev.map(r => r.id === rule.id ? { ...r, isActive: !r.isActive } : r));
    } catch {
      toast({ title: 'Failed to toggle rule', variant: 'destructive' });
    }
  };

  const deleteRule = async (ruleId: number) => {
    if (!confirm('Delete this automation rule?')) return;
    try {
      await fetch(`/api/organizations/${orgId}/automation-rules/${ruleId}`, { method: 'DELETE', credentials: 'include' });
      setRules(prev => prev.filter(r => r.id !== ruleId));
      toast({ title: 'Rule deleted' });
    } catch {
      toast({ title: 'Failed to delete rule', variant: 'destructive' });
    }
  };

  const testSend = async (ruleId: number) => {
    setTestSending(ruleId);
    try {
      const res = await fetch(`/api/organizations/${orgId}/automation-rules/${ruleId}/test`, { method: 'POST', credentials: 'include' });
      const data = await res.json();
      if (res.ok) toast({ title: `Test sent to ${data.sentTo}` });
      else toast({ title: data.error ?? 'Test failed', variant: 'destructive' });
    } catch {
      toast({ title: 'Failed to send test', variant: 'destructive' });
    } finally {
      setTestSending(null);
    }
  };

  const retryRule = async (ruleId: number) => {
    setRetrying(ruleId);
    try {
      const res = await fetch(`/api/organizations/${orgId}/automation-rules/${ruleId}/retry`, { method: 'POST', credentials: 'include' });
      const data = await res.json();
      if (res.ok) {
        toast({ title: `Retried: ${data.deliveredCount} delivered` });
        loadLogs(ruleId);
      } else {
        toast({ title: data.error ?? 'Retry failed', variant: 'destructive' });
      }
    } catch {
      toast({ title: 'Failed to retry rule', variant: 'destructive' });
    } finally {
      setRetrying(null);
    }
  };

  const loadLogs = async (ruleId: number) => {
    if (expandedLogs[ruleId] !== undefined) {
      setExpandedLogs(prev => { const n = { ...prev }; delete n[ruleId]; return n; });
      return;
    }
    setLogsLoading(ruleId);
    try {
      const res = await fetch(`/api/organizations/${orgId}/automation-rules/${ruleId}/logs`, { credentials: 'include' });
      const data = res.ok ? await res.json() : [];
      setExpandedLogs(prev => ({ ...prev, [ruleId]: data }));
    } finally {
      setLogsLoading(null);
    }
  };

  const hasTimingParam = form.triggerType === 'registration_deadline' || form.triggerType === 'event_starts';

  return (
    <div className="space-y-6">
      {overrideNotice && (
        <div
          data-testid="banner-manual-entry-override"
          className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3"
        >
          <div className="flex items-start gap-2 text-amber-200 text-sm">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-amber-400" />
            <span>
              Your manual-entry alert preference was overridden
              {overrideNotice.appliedByName ? ` by ${overrideNotice.appliedByName}` : ' by a club admin'}
              {' on '}
              {new Date(overrideNotice.appliedAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}.
            </span>
          </div>
          <div className="flex flex-wrap gap-2 self-start sm:self-auto">
            <Button
              data-testid="button-restore-manual-entry-preference"
              size="sm"
              variant="outline"
              disabled={restoringOverride || dismissingOverride}
              onClick={restoreOverride}
              className="border-amber-500/40 text-amber-100 hover:bg-amber-500/20"
            >
              {restoringOverride ? <><Loader2 className="w-3 h-3 mr-1 animate-spin" /> Restoring…</> : 'Restore my preference'}
            </Button>
            <Button
              data-testid="button-dismiss-manual-entry-override"
              size="sm"
              variant="ghost"
              disabled={restoringOverride || dismissingOverride}
              onClick={dismissOverride}
              className="text-amber-100 hover:bg-amber-500/20"
            >
              {dismissingOverride ? <><Loader2 className="w-3 h-3 mr-1 animate-spin" /> Dismissing…</> : 'Dismiss'}
            </Button>
          </div>
        </div>
      )}

      {automation && saveAutomation && (
        <Card className="glass-card">
          <CardHeader><CardTitle className="text-white text-base">Built-in Auto-Actions</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <p className="text-xs text-muted-foreground">These built-in triggers activate immediately and don't require rule configuration.</p>
            {[
              { key: 'autoWelcome', label: 'Welcome Email on Registration', desc: 'Send a welcome email when a player registers.' },
              { key: 'autoReminder', label: '24h Tee-Time Reminder', desc: 'Push reminder to all players 24 hours before start.' },
              { key: 'autoResults', label: 'Results Notification', desc: 'Push notification when tournament is marked Completed.' },
              { key: 'autoPostWhs', label: 'Auto-Post Scores to WHS/GHIN', desc: 'Submit scores to WHS when tournament is Completed. Requires GHIN credentials.' },
              { key: 'notifyManualEntryAlerts', label: 'Send manual-entry alerts', desc: 'Notify directors when a closed round is mostly hand-entered. Turn off for casual social leagues to silence the noise.' },
            ].map(item => (
              <div key={item.key} className="flex items-center justify-between gap-4 p-3 bg-black/20 rounded-lg">
                <div className="flex-1 min-w-0">
                  <p className="text-white text-sm font-medium">{item.label}</p>
                  <p className="text-muted-foreground text-xs mt-0.5">{item.desc}</p>
                </div>
                <button
                  disabled={autoSaving}
                  onClick={() => saveAutomation(item.key, !automation[item.key as keyof typeof automation])}
                  className={`relative inline-flex h-6 w-11 flex-shrink-0 rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                    automation[item.key as keyof typeof automation] ? 'bg-primary' : 'bg-white/10'
                  } ${autoSaving ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
                >
                  <span className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                    automation[item.key as keyof typeof automation] ? 'translate-x-5' : 'translate-x-0'
                  }`} />
                </button>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <Card className="glass-card">
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-white flex items-center gap-2">
              <Settings className="w-4 h-4 text-primary" /> Automation Rules
              <Badge variant="secondary" className="text-xs">{rules.length}</Badge>
            </CardTitle>
            <Button size="sm" onClick={openNew} className="bg-primary hover:bg-primary/90 text-primary-foreground">
              <Plus className="w-4 h-4 mr-1" /> New Rule
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-5 h-5 animate-spin text-primary" />
            </div>
          ) : rules.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground text-sm space-y-2">
              <Bell className="w-8 h-8 mx-auto text-white/20" />
              <p>No automation rules yet. Create one or use a template below.</p>
            </div>
          ) : (
            <div className="space-y-3">
              {rules.map(rule => (
                <div key={rule.id} className="border border-white/10 rounded-xl overflow-hidden">
                  <div className="flex items-start gap-3 p-4">
                    <button
                      onClick={() => toggleRule(rule)}
                      className={`relative inline-flex h-6 w-11 flex-shrink-0 rounded-full border-2 border-transparent transition-colors mt-0.5 ${
                        rule.isActive ? 'bg-primary' : 'bg-white/10'
                      } cursor-pointer`}
                    >
                      <span className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                        rule.isActive ? 'translate-x-5' : 'translate-x-0'
                      }`} />
                    </button>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="text-white text-sm font-semibold">{rule.name}</p>
                        <Badge className={`text-xs ${rule.isActive ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30' : 'bg-white/5 text-muted-foreground border-white/10'}`}>
                          {rule.isActive ? 'Active' : 'Paused'}
                        </Badge>
                      </div>
                      <div className="flex items-center gap-2 mt-1 flex-wrap">
                        <span className="text-xs text-muted-foreground">{triggerDescription(rule)}</span>
                        <span className="text-white/20">·</span>
                        <span className="text-xs text-muted-foreground">{CHANNEL_LABELS[rule.channel] ?? rule.channel}</span>
                        <span className="text-white/20">·</span>
                        <span className="text-xs text-muted-foreground">{AUDIENCE_LABELS[rule.audienceFilter?.type ?? 'all_registrants'] ?? rule.audienceFilter?.type}</span>
                      </div>
                      {rule.lastTriggeredAt && (
                        <p className="text-xs text-emerald-400 mt-1">Last fired: {new Date(rule.lastTriggeredAt).toLocaleString()}</p>
                      )}
                    </div>
                    <div className="flex items-center gap-1 flex-shrink-0">
                      <button
                        onClick={() => testSend(rule.id)}
                        disabled={testSending === rule.id}
                        className="p-1.5 rounded-lg hover:bg-white/10 text-muted-foreground hover:text-emerald-400 transition-colors"
                        title="Send test to yourself"
                      >
                        {testSending === rule.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                      </button>
                      <button
                        onClick={() => loadLogs(rule.id)}
                        className="p-1.5 rounded-lg hover:bg-white/10 text-muted-foreground hover:text-white transition-colors"
                        title="View execution history"
                      >
                        {logsLoading === rule.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Eye className="w-3.5 h-3.5" />}
                      </button>
                      <button
                        onClick={() => openEdit(rule)}
                        className="p-1.5 rounded-lg hover:bg-white/10 text-muted-foreground hover:text-white transition-colors"
                        title="Edit rule"
                      >
                        <Edit3 className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => deleteRule(rule.id)}
                        className="p-1.5 rounded-lg hover:bg-white/10 text-muted-foreground hover:text-red-400 transition-colors"
                        title="Delete rule"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                  {expandedLogs[rule.id] !== undefined && (
                    <div className="border-t border-white/10 bg-black/30 p-4">
                      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">Execution History</p>
                      {expandedLogs[rule.id].length === 0 ? (
                        <p className="text-xs text-muted-foreground">No execution records yet.</p>
                      ) : (
                        <div className="space-y-2">
                          {expandedLogs[rule.id].map(log => (
                            <div key={log.id} className="flex items-center gap-3 text-xs py-1.5 border-b border-white/5 last:border-0 flex-wrap">
                              <span className="text-muted-foreground">{new Date(log.triggeredAt).toLocaleString()}</span>
                              <span className="text-white">{log.audienceSize} recipients</span>
                              <span className="text-emerald-400">{log.deliveredCount} delivered</span>
                              {log.failedCount > 0 && <span className="text-red-400">{log.failedCount} failed</span>}
                              <span className={`font-medium ${log.status === 'completed' ? 'text-emerald-400' : log.status === 'partial' ? 'text-yellow-400' : 'text-red-400'}`}>
                                {log.status}
                              </span>
                              {(log.status === 'failed' || log.status === 'partial') && (
                                <button
                                  onClick={() => retryRule(rule.id)}
                                  disabled={retrying === rule.id}
                                  className="ml-auto flex items-center gap-1 px-2 py-0.5 rounded bg-yellow-500/10 text-yellow-400 border border-yellow-500/20 hover:bg-yellow-500/20 transition-colors text-xs"
                                  title="Retry delivery now"
                                >
                                  {retrying === rule.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />} Retry
                                </button>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {templates.length > 0 && (
        <Card className="glass-card">
          <CardHeader><CardTitle className="text-white text-base">Pre-built Templates</CardTitle></CardHeader>
          <CardContent>
            <p className="text-xs text-muted-foreground mb-4">Activate a template in one click. You can customise it after.</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {templates.map(tmpl => (
                <button
                  key={tmpl.id}
                  onClick={() => applyTemplate(tmpl)}
                  className="text-left p-4 rounded-xl border border-white/10 hover:border-primary/40 hover:bg-primary/5 transition-all group"
                >
                  <p className="text-white text-sm font-medium group-hover:text-primary transition-colors">{tmpl.name}</p>
                  <p className="text-muted-foreground text-xs mt-1">{triggerDescription(tmpl)}</p>
                  <p className="text-xs text-primary/60 mt-1">{CHANNEL_LABELS[tmpl.channel] ?? tmpl.channel} · {AUDIENCE_LABELS[tmpl.audienceFilter?.type ?? 'all_registrants']}</p>
                </button>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <Dialog open={showDrawer} onOpenChange={setShowDrawer}>
        <DialogContent className="max-w-xl bg-[#0a0a0a] border border-white/10 text-white max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-white">{editingRule ? 'Edit Automation Rule' : 'New Automation Rule'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-5 mt-2">
            <div>
              <label className="text-xs text-muted-foreground uppercase tracking-wider mb-1.5 block">Rule Name</label>
              <Input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Draw Published Notification" className="bg-black/40 border-white/10 text-white" />
            </div>

            <div>
              <label className="text-xs text-muted-foreground uppercase tracking-wider mb-1.5 block">Trigger</label>
              <Select value={form.triggerType} onValueChange={v => setForm(f => ({ ...f, triggerType: v }))}>
                <SelectTrigger className="bg-black/40 border-white/10 text-white">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-[#1a1a1a] border-white/10">
                  {Object.entries(TRIGGER_LABELS).map(([k, v]) => (
                    <SelectItem key={k} value={k}>{v}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {hasTimingParam && (
                <div className="flex items-center gap-2 mt-2">
                  <Input
                    type="number" min={1} max={365}
                    value={form.triggerValue}
                    onChange={e => setForm(f => ({ ...f, triggerValue: parseInt(e.target.value) || 1 }))}
                    className="bg-black/40 border-white/10 text-white w-24"
                  />
                  <Select value={form.triggerUnit} onValueChange={v => setForm(f => ({ ...f, triggerUnit: v as 'hours' | 'days' }))}>
                    <SelectTrigger className="bg-black/40 border-white/10 text-white w-28">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="bg-[#1a1a1a] border-white/10">
                      <SelectItem value="hours">hours</SelectItem>
                      <SelectItem value="days">days</SelectItem>
                    </SelectContent>
                  </Select>
                  <span className="text-muted-foreground text-xs">before</span>
                </div>
              )}
            </div>

            <div>
              <label className="text-xs text-muted-foreground uppercase tracking-wider mb-1.5 block">Channel</label>
              <div className="flex flex-wrap gap-2">
                {Object.entries(CHANNEL_LABELS).map(([k, v]) => (
                  <button key={k} type="button"
                    onClick={() => setForm(f => ({ ...f, channel: k }))}
                    className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition-all ${
                      form.channel === k ? 'bg-primary/20 text-primary border-primary/40' : 'bg-white/5 text-muted-foreground border-white/10'
                    }`}
                  >
                    {v}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="text-xs text-muted-foreground uppercase tracking-wider mb-1.5 block">Audience</label>
              <Select value={form.audienceType} onValueChange={v => setForm(f => ({ ...f, audienceType: v, flightId: null }))}>
                <SelectTrigger className="bg-black/40 border-white/10 text-white">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-[#1a1a1a] border-white/10">
                  {Object.entries(AUDIENCE_LABELS)
                    .filter(([k]) => k !== 'specific_flight' || (tournamentId && flights.length > 0))
                    .map(([k, v]) => (
                      <SelectItem key={k} value={k}>{v}</SelectItem>
                    ))}
                </SelectContent>
              </Select>
              {form.audienceType === 'specific_flight' && flights.length > 0 && (
                <div className="mt-2">
                  <label className="text-xs text-muted-foreground uppercase tracking-wider mb-1.5 block">Select Flight</label>
                  <Select
                    value={form.flightId !== null ? String(form.flightId) : ''}
                    onValueChange={v => setForm(f => ({ ...f, flightId: parseInt(v) }))}
                  >
                    <SelectTrigger className="bg-black/40 border-white/10 text-white">
                      <SelectValue placeholder="Choose a flight…" />
                    </SelectTrigger>
                    <SelectContent className="bg-[#1a1a1a] border-white/10">
                      {flights.map(fl => (
                        <SelectItem key={fl.id} value={String(fl.id)}>{fl.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>

            {form.channel === 'email' && (
              <div>
                <label className="text-xs text-muted-foreground uppercase tracking-wider mb-1.5 block">Subject</label>
                <Input value={form.subject} onChange={e => setForm(f => ({ ...f, subject: e.target.value }))} placeholder="Email subject line" className="bg-black/40 border-white/10 text-white" />
              </div>
            )}

            <div>
              <label className="text-xs text-muted-foreground uppercase tracking-wider block mb-1.5">Message Body</label>
              <div className="flex flex-wrap gap-1 mb-2">
                {MERGE_TAGS.map(tag => (
                  <button key={tag} type="button"
                    onClick={() => setForm(f => ({ ...f, body: f.body + tag }))}
                    className="px-2 py-0.5 rounded text-xs bg-white/5 text-primary/80 border border-white/10 hover:bg-primary/10 transition-colors font-mono"
                  >
                    {tag}
                  </button>
                ))}
              </div>
              <textarea
                value={form.body}
                onChange={e => setForm(f => ({ ...f, body: e.target.value }))}
                rows={6}
                placeholder="Write your message. Click merge tags above to insert dynamic values."
                className="w-full bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-white text-sm resize-none focus:outline-none focus:border-primary/50 placeholder:text-muted-foreground"
              />
            </div>

            <div className="flex items-center gap-3">
              <button
                onClick={() => setForm(f => ({ ...f, isActive: !f.isActive }))}
                className={`relative inline-flex h-6 w-11 flex-shrink-0 rounded-full border-2 border-transparent transition-colors cursor-pointer ${form.isActive ? 'bg-primary' : 'bg-white/10'}`}
              >
                <span className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${form.isActive ? 'translate-x-5' : 'translate-x-0'}`} />
              </button>
              <span className="text-sm text-white">{form.isActive ? 'Active (will fire when triggered)' : 'Paused'}</span>
            </div>

            <div className="flex gap-3 pt-2">
              <Button onClick={saveRule} className="flex-1 bg-primary hover:bg-primary/90 text-primary-foreground">
                {editingRule ? 'Save Changes' : 'Create Rule'}
              </Button>
              <Button variant="outline" onClick={() => setShowDrawer(false)} className="border-white/10 text-white hover:bg-white/10">
                Cancel
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
