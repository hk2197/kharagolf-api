import { useState, useEffect, useCallback } from 'react';
import { useGetMe } from '@workspace/api-client-react';
import { motion } from 'framer-motion';
import { MessageSquare, Send, Mail, Bell, History, Users, Trophy, BarChart3, Link2, Trash2, RefreshCw, CheckCircle2, Clock, Plus, X, Copy, FileText, Edit2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';

interface Tournament { id: number; name: string; status: string }
interface League { id: number; name: string; status: string }
interface DeliveryStats { email?: { sent: number; failed: number }; sms?: { sent: number; failed: number }; whatsapp?: { sent: number; failed: number }; push?: { sent: number; failed: number } }
interface MessageLog { id: number; subject: string | null; body: string; channels: string[]; recipientCount: number; sentAt: string; status: string; tournamentId?: number | null; leagueId?: number | null; deliveryStats?: DeliveryStats | null }
interface Invitation { id: number; recipientEmail: string | null; recipientPhone: string | null; recipientName: string | null; status: string; effectiveStatus: string; channels: string[]; createdAt: string; sentAt: string | null; expiresAt: string; tournamentId?: number | null; leagueId?: number | null; token: string }
interface MessageTemplate { id: number; name: string; subject: string | null; body: string; type: string; channels: string[]; createdAt: string; updatedAt: string }

interface ChannelStatus {
  active: boolean;
  provider: string | null;
  setupInstructions: string | null;
}
interface ChannelStatusResponse {
  channels: {
    email: ChannelStatus;
    push: ChannelStatus;
    sms: ChannelStatus;
    whatsapp: ChannelStatus;
  };
}

function ChannelHealthTab({ orgId }: { orgId?: number }) {
  const { toast } = useToast();
  const [status, setStatus] = useState<ChannelStatusResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [testSending, setTestSending] = useState(false);

  const loadStatus = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/admin/channel-status');
      if (res.ok) setStatus(await res.json());
    } catch { /* silent */ } finally { setLoading(false); }
  }, []);

  useEffect(() => { if (orgId) loadStatus(); }, [orgId, loadStatus]);

  const sendTestEmail = async () => {
    setTestSending(true);
    try {
      const res = await fetch('/api/admin/test-email', { method: 'POST' });
      const data = await res.json();
      if (res.ok) {
        toast({ title: 'Test email sent!', description: `Delivered to ${data.sentTo}. Check your inbox.` });
      } else {
        toast({ title: 'Test failed', description: data.error, variant: 'destructive' });
      }
    } catch {
      toast({ title: 'Network error', description: 'Could not reach the server.', variant: 'destructive' });
    } finally { setTestSending(false); }
  };

  const channelConfig = [
    {
      key: 'email' as const,
      label: 'Email',
      icon: '✉️',
      color: 'text-emerald-400',
      bg: 'bg-emerald-400/10',
      setupVars: ['GMAIL_USER', 'GMAIL_APP_PASSWORD'],
    },
    {
      key: 'push' as const,
      label: 'Push Notifications',
      icon: '🔔',
      color: 'text-primary',
      bg: 'bg-primary/10',
      setupVars: [],
    },
    {
      key: 'sms' as const,
      label: 'SMS',
      icon: '📱',
      color: 'text-yellow-400',
      bg: 'bg-yellow-400/10',
      setupVars: ['SMS_PROVIDER=msg91', 'MSG91_AUTH_KEY', 'MSG91_SENDER_ID'],
    },
    {
      key: 'whatsapp' as const,
      label: 'WhatsApp',
      icon: '💬',
      color: 'text-green-400',
      bg: 'bg-green-400/10',
      setupVars: ['WHATSAPP_PROVIDER=msg91', 'MSG91_WHATSAPP_AUTH_KEY', 'MSG91_WHATSAPP_INTEGRATED_NUMBER'],
    },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-display font-semibold text-white">Communication Channel Health</h2>
          <p className="text-sm text-muted-foreground mt-1">Status of all delivery channels configured for your organization.</p>
        </div>
        <Button variant="outline" size="sm" className="border-white/10 hover:bg-white/5" onClick={loadStatus} disabled={loading}>
          <RefreshCw className={`w-4 h-4 mr-2 ${loading ? 'animate-spin' : ''}`} /> Refresh
        </Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {channelConfig.map(ch => {
          const info = status?.channels[ch.key];
          const active = info?.active ?? false;
          return (
            <Card key={ch.key} className={`glass-card border ${active ? 'border-primary/20' : 'border-white/5'}`}>
              <CardContent className="p-5">
                <div className="flex items-start justify-between mb-3">
                  <div className="flex items-center gap-3">
                    <div className={`w-10 h-10 rounded-xl ${ch.bg} flex items-center justify-center text-lg`}>
                      {ch.icon}
                    </div>
                    <div>
                      <p className="text-sm font-semibold text-white">{ch.label}</p>
                      {info?.provider && <p className="text-xs text-muted-foreground capitalize">{info.provider}</p>}
                    </div>
                  </div>
                  <Badge className={active
                    ? 'bg-primary/20 text-primary border-primary/40'
                    : 'bg-white/5 text-muted-foreground border-white/10'
                  }>
                    {loading ? '…' : active ? '✓ Active' : 'Not configured'}
                  </Badge>
                </div>
                {!active && ch.setupVars.length > 0 && (
                  <div className="mt-3 p-3 rounded-lg bg-white/5 border border-white/10">
                    <p className="text-xs text-muted-foreground mb-2">Add these secrets in Replit:</p>
                    <div className="space-y-1">
                      {ch.setupVars.map(v => (
                        <code key={v} className="block text-xs font-mono text-yellow-400">{v}</code>
                      ))}
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Email test */}
      <Card className="glass-card border-none">
        <CardHeader>
          <CardTitle className="text-white text-base flex items-center gap-2">
            <Mail className="w-4 h-4 text-emerald-400" /> Test Email Delivery
          </CardTitle>
          <p className="text-sm text-muted-foreground">Send a test email to your account to verify the email channel is working end-to-end.</p>
        </CardHeader>
        <CardContent>
          <Button
            onClick={sendTestEmail}
            disabled={testSending || !(status?.channels.email.active)}
            className="bg-emerald-700 hover:bg-emerald-800 text-white"
          >
            {testSending ? <><RefreshCw className="w-4 h-4 mr-2 animate-spin" /> Sending…</> : <><Send className="w-4 h-4 mr-2" /> Send Test Email to My Account</>}
          </Button>
          {!(status?.channels.email.active) && !loading && (
            <p className="text-xs text-muted-foreground mt-3">Email must be configured before you can send a test.</p>
          )}
        </CardContent>
      </Card>

      {/* MSG91 Setup Guide */}
      <Card className="glass-card border-none">
        <CardHeader>
          <CardTitle className="text-white text-base">MSG91 Setup Reference (SMS & WhatsApp)</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-muted-foreground">
          {[
            { step: '1', text: 'Sign up at msg91.com and complete KYC (business documents).' },
            { step: '2', text: 'Complete DLT registration on a telecom portal (Airtel/Jio/Vi). Get your Entity ID, Sender ID, and Template IDs. Takes 1–3 business days.' },
            { step: '3', text: 'In MSG91 → API → API Keys, create a key and copy it.' },
            { step: '4', text: 'For WhatsApp: connect a number via MSG91 → WhatsApp → Get Started (requires Meta Business account).' },
            { step: '5', text: 'Add the secrets shown above to Replit Secrets, then restart the API Server workflow.' },
          ].map(item => (
            <div key={item.step} className="flex gap-3">
              <span className="w-6 h-6 rounded-full bg-primary/20 text-primary text-xs font-bold flex items-center justify-center flex-shrink-0">{item.step}</span>
              <p>{item.text}</p>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

export default function MessagesPage() {
  const { data: user } = useGetMe();
  const orgId: number | undefined = user?.organizationId ?? undefined;
  const { toast } = useToast();

  const [tournaments, setTournaments] = useState<Tournament[]>([]);
  const [leagues, setLeagues] = useState<League[]>([]);
  const [messageLogs, setMessageLogs] = useState<MessageLog[]>([]);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [loading, setLoading] = useState(false);
  const [invLoading, setInvLoading] = useState(false);
  const [broadcastOpen, setBroadcastOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);

  // Broadcast form state
  const [bForm, setBForm] = useState({ targetType: 'tournament', targetId: '', subject: '', body: '', channels: ['email'] });
  const [bSending, setBSending] = useState(false);

  // Invite form state
  const [iForm, setIForm] = useState({ targetType: 'tournament', targetId: '', recipientName: '', recipientEmail: '', recipientPhone: '', channels: ['email'], sendNow: true });
  const [iSending, setISending] = useState(false);
  const [bulkMode, setBulkMode] = useState(false);
  const [bulkEmails, setBulkEmails] = useState('');
  const [bulkSending, setBulkSending] = useState(false);
  const [bulkResults, setBulkResults] = useState<Array<{ email: string; ok: boolean }>>([]);

  // Template library state
  const [templates, setTemplates] = useState<MessageTemplate[]>([]);
  const [templatesLoading, setTemplatesLoading] = useState(false);
  const [templateDialogOpen, setTemplateDialogOpen] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<MessageTemplate | null>(null);
  const [tForm, setTForm] = useState({ name: '', subject: '', body: '', type: 'general', channels: ['email'] });
  const [tSaving, setTSaving] = useState(false);
  const [deletingTemplateId, setDeletingTemplateId] = useState<number | null>(null);

  // Notification preferences for current user
  const [notifPrefs, setNotifPrefs] = useState({ preferEmail: true, preferPush: true, preferSms: false, preferWhatsapp: false });
  const [notifPrefsSaving, setNotifPrefsSaving] = useState(false);

  const load = useCallback(async () => {
    if (!orgId) return;
    setLoading(true);
    try {
      const [t, l, m, inv] = await Promise.all([
        fetch(`/api/organizations/${orgId}/tournaments`, { credentials: 'include' }).then(r => r.ok ? r.json() : []),
        fetch(`/api/organizations/${orgId}/leagues`, { credentials: 'include' }).then(r => r.ok ? r.json() : []),
        fetch(`/api/organizations/${orgId}/messages`, { credentials: 'include' }).then(r => r.ok ? r.json() : []),
        fetch(`/api/organizations/${orgId}/invitations`, { credentials: 'include' }).then(r => r.ok ? r.json() : []),
      ]);
      setTournaments(Array.isArray(t) ? t : (t.tournaments ?? []));
      setLeagues(Array.isArray(l) ? l : []);
      setMessageLogs(m);
      setInvitations(inv);
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  useEffect(() => { load(); }, [load]);

  // Load notification prefs for current admin user
  useEffect(() => {
    fetch('/api/portal/notification-preferences', { credentials: 'include' })
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (data) setNotifPrefs({ preferEmail: data.preferEmail, preferPush: data.preferPush, preferSms: data.preferSms, preferWhatsapp: data.preferWhatsapp ?? false }); })
      .catch(() => {});
  }, []);

  const saveNotifPref = async (key: keyof typeof notifPrefs, value: boolean) => {
    setNotifPrefs(prev => ({ ...prev, [key]: value }));
    setNotifPrefsSaving(true);
    try {
      await fetch('/api/portal/notification-preferences', {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [key]: value }),
      });
      toast({ title: 'Preferences saved' });
    } catch {
      toast({ title: 'Failed to save preferences', variant: 'destructive' });
    }
    setNotifPrefsSaving(false);
  };

  const sendBroadcast = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!orgId || !bForm.body.trim()) return;
    setBSending(true);
    try {
      const body: Record<string, unknown> = {
        subject: bForm.subject || undefined,
        body: bForm.body,
        channels: bForm.channels,
      };
      if (bForm.targetType === 'tournament' && bForm.targetId) body.tournamentId = bForm.targetId;
      if (bForm.targetType === 'league' && bForm.targetId) body.leagueId = bForm.targetId;

      const res = await fetch(`/api/organizations/${orgId}/messages/broadcast`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error();
      const data = await res.json();
      toast({ title: `Message sent to ${data.recipientCount} recipients` });
      setBroadcastOpen(false);
      setBForm({ targetType: 'tournament', targetId: '', subject: '', body: '', channels: ['email'] });
      load();
    } catch {
      toast({ title: 'Failed to send message', variant: 'destructive' });
    } finally {
      setBSending(false);
    }
  };

  const sendInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!orgId || (!iForm.recipientEmail && !iForm.recipientPhone)) return;
    setISending(true);
    try {
      const body: Record<string, unknown> = {
        recipientName: iForm.recipientName || undefined,
        recipientEmail: iForm.recipientEmail || undefined,
        recipientPhone: iForm.recipientPhone || undefined,
        channels: iForm.channels,
        sendNow: iForm.sendNow,
      };
      if (iForm.targetType === 'tournament' && iForm.targetId) body.tournamentId = iForm.targetId;
      if (iForm.targetType === 'league' && iForm.targetId) body.leagueId = iForm.targetId;

      const res = await fetch(`/api/organizations/${orgId}/invitations`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error();
      toast({ title: iForm.sendNow && iForm.channels.includes('email') ? 'Invitation sent!' : 'Invitation created' });
      setInviteOpen(false);
      setIForm({ targetType: 'tournament', targetId: '', recipientName: '', recipientEmail: '', recipientPhone: '', channels: ['email'], sendNow: true });
      load();
    } catch {
      toast({ title: 'Failed to create invitation', variant: 'destructive' });
    } finally {
      setISending(false);
    }
  };

  const revokeInvite = async (id: number) => {
    if (!confirm('Revoke this invitation?')) return;
    await fetch(`/api/organizations/${orgId}/invitations/${id}`, { method: 'DELETE', credentials: 'include' });
    toast({ title: 'Invitation revoked' });
    load();
  };

  const resendInvite = async (id: number) => {
    const res = await fetch(`/api/organizations/${orgId}/invitations/${id}/resend`, { method: 'POST', credentials: 'include' });
    if (res.ok) toast({ title: 'Invitation resent' });
    else toast({ title: 'Failed to resend', variant: 'destructive' });
    load();
  };

  const sendBulkInvites = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!orgId || !bulkEmails.trim()) return;
    // Parse comma or newline separated entries (emails or phone numbers)
    const entries = bulkEmails
      .split(/[\n,]+/)
      .map(l => l.trim())
      .filter(l => l.length > 0);
    if (entries.length === 0) return;
    setBulkSending(true);
    setBulkResults([]);
    const results: Array<{ email: string; ok: boolean }> = [];
    for (const entry of entries) {
      // Detect if entry is a phone number (starts with + or contains only digits/spaces/dashes/parens)
      const isPhone = /^\+?[\d\s\-().]{7,}$/.test(entry);
      const isEmail = entry.includes('@');
      if (!isPhone && !isEmail) { results.push({ email: entry, ok: false }); continue; }
      try {
        const body: Record<string, unknown> = {
          recipientEmail: isEmail ? entry.replace(/[<>]/g, '').trim() : null,
          recipientPhone: isPhone ? entry.trim() : null,
          channels: isPhone ? ['sms'] : ['email'],
          sendNow: true,
        };
        if (iForm.targetType === 'tournament' && iForm.targetId) body.tournamentId = parseInt(iForm.targetId);
        if (iForm.targetType === 'league' && iForm.targetId) body.leagueId = parseInt(iForm.targetId);
        const res = await fetch(`/api/organizations/${orgId}/invitations`, {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        results.push({ email: entry, ok: res.ok });
      } catch {
        results.push({ email: entry, ok: false });
      }
    }
    setBulkResults(results);
    setBulkSending(false);
    const sent = results.filter(r => r.ok).length;
    toast({ title: `Sent ${sent} of ${entries.length} invitations` });
    if (sent > 0) load();
  };

  const copyInviteLink = (invite: Invitation) => {
    const base = window.location.origin + (import.meta.env.BASE_URL?.replace(/\/$/, '') || '');
    const url = invite.leagueId
      ? `${base}/leagues?orgId=${orgId}&invite=${invite.token}`
      : `${base}/register/${orgId}/${invite.tournamentId}?invite=${invite.token}`;
    navigator.clipboard.writeText(url).then(() => toast({ title: 'Invite link copied!' }));
  };

  const toggleChannel = (ch: string, form: typeof bForm, setForm: typeof setBForm) => {
    setForm(f => ({
      ...f,
      channels: f.channels.includes(ch) ? f.channels.filter(c => c !== ch) : [...f.channels, ch],
    }));
  };

  const statusColor = (s: string) => {
    if (s === 'pending') return 'bg-yellow-500/20 text-yellow-300 border-yellow-500/30';
    if (s === 'accepted') return 'bg-green-500/20 text-green-300 border-green-500/30';
    if (s === 'revoked' || s === 'expired') return 'bg-red-500/20 text-red-300 border-red-500/30';
    return 'bg-gray-500/20 text-gray-300';
  };

  // Template library functions
  const loadTemplates = useCallback(async () => {
    if (!orgId) return;
    setTemplatesLoading(true);
    try {
      const r = await fetch(`/api/organizations/${orgId}/templates`, { credentials: 'include' });
      if (r.ok) setTemplates(await r.json());
    } finally {
      setTemplatesLoading(false);
    }
  }, [orgId]);

  useEffect(() => { loadTemplates(); }, [loadTemplates]);

  const openNewTemplate = () => {
    setEditingTemplate(null);
    setTForm({ name: '', subject: '', body: '', type: 'general', channels: ['email'] });
    setTemplateDialogOpen(true);
  };

  const openEditTemplate = (tmpl: MessageTemplate) => {
    setEditingTemplate(tmpl);
    setTForm({ name: tmpl.name, subject: tmpl.subject ?? '', body: tmpl.body, type: tmpl.type, channels: Array.isArray(tmpl.channels) ? tmpl.channels : ['email'] });
    setTemplateDialogOpen(true);
  };

  const saveTemplate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!orgId || !tForm.name.trim() || !tForm.body.trim()) return;
    setTSaving(true);
    try {
      const method = editingTemplate ? 'PUT' : 'POST';
      const url = editingTemplate
        ? `/api/organizations/${orgId}/templates/${editingTemplate.id}`
        : `/api/organizations/${orgId}/templates`;
      const res = await fetch(url, {
        method, credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(tForm),
      });
      if (!res.ok) throw new Error();
      toast({ title: editingTemplate ? 'Template updated' : 'Template created' });
      setTemplateDialogOpen(false);
      loadTemplates();
    } catch {
      toast({ title: 'Failed to save template', variant: 'destructive' });
    } finally {
      setTSaving(false);
    }
  };

  const deleteTemplate = async (id: number) => {
    if (!confirm('Delete this template?')) return;
    setDeletingTemplateId(id);
    try {
      const res = await fetch(`/api/organizations/${orgId}/templates/${id}`, { method: 'DELETE', credentials: 'include' });
      if (res.ok) {
        toast({ title: 'Template deleted' });
        loadTemplates();
      } else {
        toast({ title: 'Failed to delete template', variant: 'destructive' });
      }
    } finally {
      setDeletingTemplateId(null);
    }
  };

  const useTemplate = (tmpl: MessageTemplate) => {
    setBForm(f => ({ ...f, subject: tmpl.subject ?? f.subject, body: tmpl.body, channels: Array.isArray(tmpl.channels) ? tmpl.channels : f.channels }));
    setBroadcastOpen(true);
  };

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-display font-bold text-white tracking-tight">Communications</h1>
          <p className="text-muted-foreground mt-1">Send messages and invitations to your players and members.</p>
        </div>
        <div className="flex gap-3">
          <Button
            onClick={() => setInviteOpen(true)}
            variant="outline"
            className="bg-emerald-500/10 border-emerald-500/30 hover:bg-emerald-500/20 text-emerald-400"
          >
            <Link2 className="w-4 h-4 mr-2" /> Send Invitation
          </Button>
          <Button
            onClick={() => setBroadcastOpen(true)}
            className="bg-primary hover:bg-primary/90 text-primary-foreground shadow-[0_0_20px_rgba(34,197,94,0.3)]"
          >
            <Send className="w-4 h-4 mr-2" /> Broadcast Message
          </Button>
        </div>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: 'Messages Sent', value: messageLogs.length, icon: MessageSquare, color: 'text-primary' },
          { label: 'Invitations', value: invitations.length, icon: Link2, color: 'text-emerald-400' },
          { label: 'Pending Invites', value: invitations.filter(i => (i.effectiveStatus ?? i.status) === 'pending').length, icon: Clock, color: 'text-yellow-400' },
          { label: 'Accepted', value: invitations.filter(i => (i.effectiveStatus ?? i.status) === 'accepted').length, icon: CheckCircle2, color: 'text-green-400' },
        ].map(({ label, value, icon: Icon, color }) => (
          <Card key={label} className="glass-card">
            <CardContent className="p-4 flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-white/5 flex items-center justify-center">
                <Icon className={`w-5 h-5 ${color}`} />
              </div>
              <div>
                <p className="text-2xl font-bold text-white">{value}</p>
                <p className="text-xs text-muted-foreground">{label}</p>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Tabs defaultValue="messages" className="w-full">
        <TabsList className="bg-black/40 border border-white/5 p-1 rounded-xl">
          <TabsTrigger value="messages" className="rounded-lg data-[state=active]:bg-primary/20 data-[state=active]:text-primary px-5 py-2.5">
            <History className="w-4 h-4 mr-2" /> Message History
          </TabsTrigger>
          <TabsTrigger value="invitations" className="rounded-lg data-[state=active]:bg-emerald-500/20 data-[state=active]:text-emerald-400 px-5 py-2.5">
            <Link2 className="w-4 h-4 mr-2" /> Invitations ({invitations.length})
          </TabsTrigger>
          <TabsTrigger value="templates" className="rounded-lg data-[state=active]:bg-amber-500/20 data-[state=active]:text-amber-400 px-5 py-2.5">
            <FileText className="w-4 h-4 mr-2" /> Templates ({templates.length})
          </TabsTrigger>
          <TabsTrigger value="preferences" className="rounded-lg data-[state=active]:bg-green-500/20 data-[state=active]:text-green-400 px-5 py-2.5">
            <Bell className="w-4 h-4 mr-2" /> My Preferences
          </TabsTrigger>
          <TabsTrigger value="channel-health" className="rounded-lg data-[state=active]:bg-orange-500/20 data-[state=active]:text-orange-400 px-5 py-2.5">
            <BarChart3 className="w-4 h-4 mr-2" /> Channel Health
          </TabsTrigger>
        </TabsList>

        <div className="mt-6">
          {/* Message History */}
          <TabsContent value="messages">
            <Card className="glass-card">
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle className="text-white flex items-center gap-2"><History className="w-5 h-5 text-primary" /> Sent Messages</CardTitle>
                  <Button size="sm" variant="ghost" onClick={load} className="text-muted-foreground hover:text-white">
                    <RefreshCw className="w-4 h-4" />
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                {loading ? (
                  <div className="space-y-3">
                    {[1,2,3].map(i => <div key={i} className="h-16 glass-panel rounded-xl animate-pulse" />)}
                  </div>
                ) : messageLogs.length === 0 ? (
                  <div className="text-center py-12">
                    <MessageSquare className="w-12 h-12 text-muted-foreground opacity-30 mx-auto mb-3" />
                    <p className="text-muted-foreground">No messages sent yet. Use "Broadcast Message" to reach your players.</p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {messageLogs.map((m, i) => {
                      const stats = m.deliveryStats;
                      const totalDelivered = stats ? Object.values(stats).reduce((s, c) => s + (c?.sent ?? 0), 0) : null;
                      const totalFailed = stats ? Object.values(stats).reduce((s, c) => s + (c?.failed ?? 0), 0) : null;
                      const isPartial = m.status === 'partial';
                      return (
                        <motion.div key={m.id} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.03 }}
                          className="glass-panel rounded-xl p-4">
                          <div className="flex items-start justify-between gap-3">
                            <div className="flex-1 min-w-0">
                              {m.subject && <p className="text-white font-semibold text-sm mb-1">{m.subject}</p>}
                              <p className="text-muted-foreground text-sm line-clamp-2">{m.body}</p>
                              <div className="flex items-center gap-3 mt-2 flex-wrap">
                                <span className="text-xs text-muted-foreground flex items-center gap-1">
                                  <Users className="w-3 h-3" /> {m.recipientCount} recipients
                                </span>
                                {m.channels.map(c => (
                                  <Badge key={c} className="text-[10px] bg-white/10 text-white border-white/10 px-1.5 py-0">{c}</Badge>
                                ))}
                                <span className="text-xs text-muted-foreground">
                                  {new Date(m.sentAt).toLocaleString()}
                                </span>
                              </div>
                              {stats && (
                                <div className="flex items-center gap-3 mt-2 flex-wrap">
                                  {Object.entries(stats).map(([ch, s]) => s ? (
                                    <span key={ch} className="text-[10px] flex items-center gap-1">
                                      <span className="text-muted-foreground capitalize">{ch}:</span>
                                      <span className="text-green-400">{s.sent} delivered</span>
                                      {s.failed > 0 && <span className="text-red-400">{s.failed} failed</span>}
                                    </span>
                                  ) : null)}
                                  {totalDelivered !== null && totalFailed !== null && (
                                    <span className="text-[10px] text-muted-foreground">
                                      Total: {totalDelivered}/{totalDelivered + totalFailed}
                                    </span>
                                  )}
                                </div>
                              )}
                            </div>
                            <Badge className={isPartial ? "bg-yellow-500/20 text-yellow-300 border-yellow-500/30 shrink-0" : "bg-green-500/20 text-green-300 border-green-500/30 shrink-0"}>
                              {isPartial ? 'Partial' : 'Sent'}
                            </Badge>
                          </div>
                        </motion.div>
                      );
                    })}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* Invitations */}
          <TabsContent value="invitations">
            <Card className="glass-card">
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle className="text-white flex items-center gap-2"><Link2 className="w-5 h-5 text-emerald-400" /> Invitations</CardTitle>
                  <Button size="sm" onClick={() => setInviteOpen(true)} className="bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-400">
                    <Plus className="w-4 h-4 mr-1" /> New
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                {invLoading || loading ? (
                  <div className="space-y-3">
                    {[1,2,3].map(i => <div key={i} className="h-16 glass-panel rounded-xl animate-pulse" />)}
                  </div>
                ) : invitations.length === 0 ? (
                  <div className="text-center py-12">
                    <Link2 className="w-12 h-12 text-muted-foreground opacity-30 mx-auto mb-3" />
                    <p className="text-muted-foreground">No invitations yet. Send your first invitation to a player.</p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {invitations.map((inv, i) => (
                      <motion.div key={inv.id} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.03 }}
                        className="glass-panel rounded-xl p-4">
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-1 flex-wrap">
                              <p className="text-white font-semibold text-sm">{inv.recipientName || inv.recipientEmail || inv.recipientPhone}</p>
                              <Badge className={`text-[10px] px-1.5 py-0 ${statusColor(inv.effectiveStatus ?? inv.status)}`}>{inv.effectiveStatus ?? inv.status}</Badge>
                            </div>
                            <p className="text-xs text-muted-foreground">{inv.recipientEmail}</p>
                            <div className="flex items-center gap-3 mt-2 flex-wrap">
                              {inv.channels.map(c => (
                                <Badge key={c} className="text-[10px] bg-white/10 text-white border-white/10 px-1.5 py-0">{c}</Badge>
                              ))}
                              <span className="text-xs text-muted-foreground">
                                Expires {new Date(inv.expiresAt).toLocaleDateString()}
                              </span>
                              {inv.sentAt && <span className="text-xs text-muted-foreground">Sent {new Date(inv.sentAt).toLocaleDateString()}</span>}
                            </div>
                          </div>
                          <div className="flex gap-1.5 shrink-0">
                            <Button size="icon" variant="ghost" onClick={() => copyInviteLink(inv)} className="w-8 h-8 text-muted-foreground hover:text-white" title="Copy link">
                              <Copy className="w-3.5 h-3.5" />
                            </Button>
                            {(inv.effectiveStatus ?? inv.status) === 'pending' && (
                              <>
                                <Button size="icon" variant="ghost" onClick={() => resendInvite(inv.id)} className="w-8 h-8 text-emerald-400 hover:text-emerald-300" title="Resend">
                                  <Send className="w-3.5 h-3.5" />
                                </Button>
                                <Button size="icon" variant="ghost" onClick={() => revokeInvite(inv.id)} className="w-8 h-8 text-red-400 hover:text-red-300" title="Revoke">
                                  <X className="w-3.5 h-3.5" />
                                </Button>
                              </>
                            )}
                          </div>
                        </div>
                      </motion.div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* Template Library */}
          <TabsContent value="templates">
            <Card className="glass-card">
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle className="text-white flex items-center gap-2"><FileText className="w-5 h-5 text-amber-400" /> Message Templates</CardTitle>
                  <Button size="sm" onClick={openNewTemplate} className="bg-amber-500/20 hover:bg-amber-500/30 text-amber-400">
                    <Plus className="w-4 h-4 mr-1" /> New Template
                  </Button>
                </div>
                <p className="text-sm text-muted-foreground mt-1">Save reusable message templates and load them into broadcasts with one click.</p>
              </CardHeader>
              <CardContent>
                {templatesLoading ? (
                  <div className="space-y-3">
                    {[1,2,3].map(i => <div key={i} className="h-20 glass-panel rounded-xl animate-pulse" />)}
                  </div>
                ) : templates.length === 0 ? (
                  <div className="text-center py-12">
                    <FileText className="w-12 h-12 text-muted-foreground opacity-30 mx-auto mb-3" />
                    <p className="text-muted-foreground mb-4">No templates yet. Create your first reusable message template.</p>
                    <Button onClick={openNewTemplate} className="bg-amber-500/20 hover:bg-amber-500/30 text-amber-400">
                      <Plus className="w-4 h-4 mr-2" /> Create Template
                    </Button>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {templates.map((tmpl, i) => (
                      <motion.div key={tmpl.id} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.03 }}
                        className="glass-panel rounded-xl p-4">
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-1 flex-wrap">
                              <p className="text-white font-semibold text-sm">{tmpl.name}</p>
                              <Badge className="text-[10px] bg-amber-500/20 text-amber-300 border-amber-500/30 px-1.5 py-0">{tmpl.type}</Badge>
                              {(Array.isArray(tmpl.channels) ? tmpl.channels : []).map(c => (
                                <Badge key={c} className="text-[10px] bg-white/10 text-white border-white/10 px-1.5 py-0">{c}</Badge>
                              ))}
                            </div>
                            {tmpl.subject && <p className="text-xs text-primary/80 mb-1">Subject: {tmpl.subject}</p>}
                            <p className="text-muted-foreground text-sm line-clamp-2">{tmpl.body}</p>
                            <p className="text-xs text-muted-foreground mt-1">Updated {new Date(tmpl.updatedAt).toLocaleDateString()}</p>
                          </div>
                          <div className="flex gap-1.5 shrink-0">
                            <Button size="sm" onClick={() => useTemplate(tmpl)} className="bg-primary/20 hover:bg-primary/30 text-primary text-xs h-8 px-3">
                              <Send className="w-3 h-3 mr-1" /> Use
                            </Button>
                            <Button size="icon" variant="ghost" onClick={() => openEditTemplate(tmpl)} className="w-8 h-8 text-muted-foreground hover:text-white">
                              <Edit2 className="w-3.5 h-3.5" />
                            </Button>
                            <Button size="icon" variant="ghost" onClick={() => deleteTemplate(tmpl.id)} disabled={deletingTemplateId === tmpl.id} className="w-8 h-8 text-red-400 hover:text-red-300">
                              <Trash2 className="w-3.5 h-3.5" />
                            </Button>
                          </div>
                        </div>
                      </motion.div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* My Notification Preferences */}
          <TabsContent value="preferences">
            <Card className="glass-card">
              <CardHeader>
                <CardTitle className="text-white flex items-center gap-2">
                  <Bell className="w-5 h-5 text-green-400" /> My Notification Preferences
                </CardTitle>
                <p className="text-sm text-muted-foreground">Control how you receive communications from the platform.</p>
              </CardHeader>
              <CardContent className="space-y-4">
                {[
                  { key: 'preferEmail' as const, label: 'Email Notifications', desc: 'Receive tournament updates and announcements by email.' },
                  { key: 'preferPush' as const, label: 'Push Notifications', desc: 'Receive real-time alerts on your mobile device.' },
                  { key: 'preferSms' as const, label: 'SMS Notifications', desc: 'Receive text message reminders and alerts.' },
                  { key: 'preferWhatsapp' as const, label: 'WhatsApp Notifications', desc: "Receive tournament updates and invitations via WhatsApp. Sent from the club's verified WhatsApp Business number — standard MSG91 carrier rules apply." },
                ].map(item => (
                  <div key={item.key} className="flex items-center justify-between p-4 rounded-lg bg-white/5 border border-white/10">
                    <div>
                      <p className="text-sm font-medium text-white">{item.label}</p>
                      <p className="text-xs text-muted-foreground mt-0.5">{item.desc}</p>
                    </div>
                    <button
                      disabled={notifPrefsSaving}
                      onClick={() => saveNotifPref(item.key, !notifPrefs[item.key])}
                      className={`relative w-11 h-6 rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-primary/40 ${notifPrefs[item.key] ? 'bg-primary' : 'bg-white/20'} ${notifPrefsSaving ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
                    >
                      <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${notifPrefs[item.key] ? 'translate-x-5' : 'translate-x-0'}`} />
                    </button>
                  </div>
                ))}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="channel-health">
            <ChannelHealthTab orgId={orgId} />
          </TabsContent>
        </div>
      </Tabs>

      {/* Template Create/Edit Dialog */}
      <Dialog open={templateDialogOpen} onOpenChange={setTemplateDialogOpen}>
        <DialogContent className="glass-panel border-white/10 sm:max-w-[560px]">
          <DialogHeader>
            <DialogTitle className="text-xl font-display text-white flex items-center gap-2">
              <FileText className="w-5 h-5 text-amber-400" /> {editingTemplate ? 'Edit Template' : 'New Template'}
            </DialogTitle>
          </DialogHeader>
          <form onSubmit={saveTemplate} className="space-y-4 mt-2">
            <div>
              <label className="text-xs text-muted-foreground uppercase tracking-wider mb-1.5 block">Template Name *</label>
              <Input value={tForm.name} onChange={e => setTForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Tee time reminder" required className="bg-black/40 border-white/10 text-white" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-muted-foreground uppercase tracking-wider mb-1.5 block">Type</label>
                <Select value={tForm.type} onValueChange={v => setTForm(f => ({ ...f, type: v }))}>
                  <SelectTrigger className="bg-black/40 border-white/10 text-white">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="general">General</SelectItem>
                    <SelectItem value="reminder">Reminder</SelectItem>
                    <SelectItem value="welcome">Welcome</SelectItem>
                    <SelectItem value="results">Results</SelectItem>
                    <SelectItem value="schedule">Schedule</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="text-xs text-muted-foreground uppercase tracking-wider mb-1.5 block">Channels</label>
                <div className="flex gap-2 flex-wrap pt-1">
                  {['email', 'push', 'sms', 'whatsapp'].map(ch => (
                    <button key={ch} type="button"
                      onClick={() => setTForm(f => ({ ...f, channels: f.channels.includes(ch) ? f.channels.filter(c => c !== ch) : [...f.channels, ch] }))}
                      className={`px-2.5 py-1 rounded-lg text-xs font-semibold border transition-all ${tForm.channels.includes(ch) ? 'bg-amber-500/20 text-amber-400 border-amber-500/40' : 'bg-white/5 text-muted-foreground border-white/10'}`}
                    >{ch}</button>
                  ))}
                </div>
              </div>
            </div>
            <div>
              <label className="text-xs text-muted-foreground uppercase tracking-wider mb-1.5 block">Subject (Email)</label>
              <Input value={tForm.subject} onChange={e => setTForm(f => ({ ...f, subject: e.target.value }))} placeholder="Optional email subject" className="bg-black/40 border-white/10 text-white" />
            </div>
            <div>
              <label className="text-xs text-muted-foreground uppercase tracking-wider mb-1.5 block">Message Body *</label>
              <textarea
                value={tForm.body}
                onChange={e => setTForm(f => ({ ...f, body: e.target.value }))}
                placeholder="Your message content..."
                required
                rows={5}
                className="w-full px-3 py-2 rounded-xl bg-black/40 border border-white/10 text-white placeholder:text-muted-foreground text-sm resize-none focus:outline-none focus:ring-2 focus:ring-amber-500/40"
              />
            </div>
            <div className="flex justify-end gap-3 pt-1">
              <Button type="button" variant="ghost" onClick={() => setTemplateDialogOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={tSaving || !tForm.name.trim() || !tForm.body.trim()} className="bg-amber-500/80 hover:bg-amber-500/90 text-white">
                {tSaving ? 'Saving...' : <><FileText className="w-4 h-4 mr-2" /> {editingTemplate ? 'Update Template' : 'Create Template'}</>}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {/* Broadcast Dialog */}
      <Dialog open={broadcastOpen} onOpenChange={setBroadcastOpen}>
        <DialogContent className="glass-panel border-white/10 sm:max-w-[560px]">
          <DialogHeader>
            <DialogTitle className="text-xl font-display text-white flex items-center gap-2">
              <Send className="w-5 h-5 text-primary" /> Broadcast Message
            </DialogTitle>
          </DialogHeader>
          <form onSubmit={sendBroadcast} className="space-y-4 mt-2">
            <div>
              <label className="text-xs text-muted-foreground uppercase tracking-wider mb-1.5 block">Send To</label>
              <div className="grid grid-cols-2 gap-3">
                <Select value={bForm.targetType} onValueChange={v => setBForm(f => ({ ...f, targetType: v, targetId: '' }))}>
                  <SelectTrigger className="bg-black/40 border-white/10 text-white">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="tournament">Tournament Players</SelectItem>
                    <SelectItem value="league">League Members</SelectItem>
                    <SelectItem value="all">All Players in Org</SelectItem>
                  </SelectContent>
                </Select>
                {bForm.targetType === 'tournament' && (
                  <Select value={bForm.targetId} onValueChange={v => setBForm(f => ({ ...f, targetId: v }))}>
                    <SelectTrigger className="bg-black/40 border-white/10 text-white">
                      <SelectValue placeholder="Select tournament" />
                    </SelectTrigger>
                    <SelectContent>
                      {tournaments.map(t => <SelectItem key={t.id} value={String(t.id)}>{t.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                )}
                {bForm.targetType === 'league' && (
                  <Select value={bForm.targetId} onValueChange={v => setBForm(f => ({ ...f, targetId: v }))}>
                    <SelectTrigger className="bg-black/40 border-white/10 text-white">
                      <SelectValue placeholder="Select league" />
                    </SelectTrigger>
                    <SelectContent>
                      {leagues.map(l => <SelectItem key={l.id} value={String(l.id)}>{l.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                )}
              </div>
            </div>

            <div>
              <label className="text-xs text-muted-foreground uppercase tracking-wider mb-1.5 block">Channels</label>
              <div className="flex gap-2 flex-wrap">
                {[
                  { key: 'email', label: '📧 Email' },
                  { key: 'push', label: '🔔 Push' },
                  { key: 'sms', label: '💬 SMS' },
                  { key: 'whatsapp', label: '📱 WhatsApp' },
                ].map(ch => (
                  <button
                    key={ch.key}
                    type="button"
                    onClick={() => toggleChannel(ch.key, bForm, setBForm)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition-all ${
                      bForm.channels.includes(ch.key)
                        ? 'bg-primary/20 text-primary border-primary/40'
                        : 'bg-white/5 text-muted-foreground border-white/10'
                    }`}
                  >
                    {ch.label}
                  </button>
                ))}
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                {bForm.channels.includes('push') && 'Push requires mobile app. '}
                {(bForm.channels.includes('sms') || bForm.channels.includes('whatsapp')) && 'SMS/WhatsApp sent to players with phone numbers on file. '}
              </p>
            </div>

            <div>
              <label className="text-xs text-muted-foreground uppercase tracking-wider mb-1.5 block">Subject (optional)</label>
              <Input
                value={bForm.subject}
                onChange={e => setBForm(f => ({ ...f, subject: e.target.value }))}
                placeholder="e.g. Tournament Update"
                className="bg-black/40 border-white/10 text-white"
              />
            </div>

            <div>
              <label className="text-xs text-muted-foreground uppercase tracking-wider mb-1.5 block">Message</label>
              <textarea
                value={bForm.body}
                onChange={e => setBForm(f => ({ ...f, body: e.target.value }))}
                required
                rows={5}
                placeholder="Write your message here..."
                className="w-full bg-black/40 border border-white/10 rounded-lg px-3 py-2 text-white text-sm resize-none focus:outline-none focus:border-primary/50 placeholder:text-muted-foreground"
              />
            </div>

            <div className="flex justify-end gap-3 pt-2">
              <Button type="button" variant="ghost" onClick={() => setBroadcastOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={bSending || !bForm.body.trim()} className="bg-primary hover:bg-primary/90 text-primary-foreground">
                {bSending ? 'Sending...' : <><Send className="w-4 h-4 mr-2" /> Send Message</>}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {/* Invite Dialog */}
      <Dialog open={inviteOpen} onOpenChange={(open) => { setInviteOpen(open); if (!open) { setBulkMode(false); setBulkEmails(''); setBulkResults([]); } }}>
        <DialogContent className="glass-panel border-white/10 sm:max-w-[560px]">
          <DialogHeader>
            <div className="flex items-center justify-between">
              <DialogTitle className="text-xl font-display text-white flex items-center gap-2">
                <Link2 className="w-5 h-5 text-emerald-400" /> {bulkMode ? 'Bulk Invite' : 'Send Invitation'}
              </DialogTitle>
              <button
                type="button"
                onClick={() => { setBulkMode(b => !b); setBulkResults([]); }}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition-all ${bulkMode ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/40' : 'bg-white/5 text-muted-foreground border-white/10 hover:text-white'}`}
              >
                {bulkMode ? 'Single Invite' : 'Bulk Paste'}
              </button>
            </div>
          </DialogHeader>
          {bulkMode ? (
            <form onSubmit={sendBulkInvites} className="space-y-4 mt-2">
              <div>
                <label className="text-xs text-muted-foreground uppercase tracking-wider mb-1.5 block">Event</label>
                <div className="grid grid-cols-2 gap-3">
                  <Select value={iForm.targetType} onValueChange={v => setIForm(f => ({ ...f, targetType: v, targetId: '' }))}>
                    <SelectTrigger className="bg-black/40 border-white/10 text-white"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="tournament">Tournament</SelectItem>
                      <SelectItem value="league">League</SelectItem>
                    </SelectContent>
                  </Select>
                  {iForm.targetType === 'tournament' ? (
                    <Select value={iForm.targetId} onValueChange={v => setIForm(f => ({ ...f, targetId: v }))}>
                      <SelectTrigger className="bg-black/40 border-white/10 text-white"><SelectValue placeholder="Select tournament" /></SelectTrigger>
                      <SelectContent>{tournaments.map(t => <SelectItem key={t.id} value={String(t.id)}>{t.name}</SelectItem>)}</SelectContent>
                    </Select>
                  ) : (
                    <Select value={iForm.targetId} onValueChange={v => setIForm(f => ({ ...f, targetId: v }))}>
                      <SelectTrigger className="bg-black/40 border-white/10 text-white"><SelectValue placeholder="Select league" /></SelectTrigger>
                      <SelectContent>{leagues.map(l => <SelectItem key={l.id} value={String(l.id)}>{l.name}</SelectItem>)}</SelectContent>
                    </Select>
                  )}
                </div>
              </div>
              <div>
                <label className="text-xs text-muted-foreground uppercase tracking-wider mb-1.5 block">
                  Email List — one per line
                  <span className="ml-2 normal-case text-muted-foreground/60 font-normal">(format: email or "Name email@example.com")</span>
                </label>
                <textarea
                  value={bulkEmails}
                  onChange={e => setBulkEmails(e.target.value)}
                  placeholder={"alice@example.com\nBob Smith bob@example.com\ncharlie@example.com"}
                  rows={8}
                  className="w-full px-3 py-2 rounded-xl bg-black/40 border border-white/10 text-white placeholder:text-muted-foreground text-sm resize-none focus:outline-none focus:ring-2 focus:ring-emerald-500/40 font-mono"
                />
                <p className="text-xs text-muted-foreground mt-1">
                  {bulkEmails.split('\n').filter(l => l.trim().includes('@')).length} valid emails detected
                </p>
              </div>
              {bulkResults.length > 0 && (
                <div className="rounded-xl bg-black/30 border border-white/10 p-3 max-h-36 overflow-y-auto">
                  <p className="text-xs text-muted-foreground mb-2">{bulkResults.filter(r => r.ok).length} sent / {bulkResults.filter(r => !r.ok).length} failed</p>
                  {bulkResults.map((r, i) => (
                    <div key={i} className={`text-xs flex items-center gap-2 ${r.ok ? 'text-green-400' : 'text-red-400'}`}>
                      <span>{r.ok ? '✓' : '✗'}</span><span>{r.email}</span>
                    </div>
                  ))}
                </div>
              )}
              <div className="flex justify-end gap-3 pt-1">
                <Button type="button" variant="ghost" onClick={() => setInviteOpen(false)}>Cancel</Button>
                <Button type="submit" disabled={bulkSending || !bulkEmails.trim()} className="bg-emerald-600 hover:bg-emerald-700 text-white">
                  {bulkSending ? 'Sending...' : <><Send className="w-4 h-4 mr-2" /> Send Bulk Invites</>}
                </Button>
              </div>
            </form>
          ) : (
          <form onSubmit={sendInvite} className="space-y-4 mt-2">
            <div>
              <label className="text-xs text-muted-foreground uppercase tracking-wider mb-1.5 block">Event Type</label>
              <div className="grid grid-cols-2 gap-3">
                <Select value={iForm.targetType} onValueChange={v => setIForm(f => ({ ...f, targetType: v, targetId: '' }))}>
                  <SelectTrigger className="bg-black/40 border-white/10 text-white">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="tournament">Tournament</SelectItem>
                    <SelectItem value="league">League</SelectItem>
                  </SelectContent>
                </Select>
                {iForm.targetType === 'tournament' ? (
                  <Select value={iForm.targetId} onValueChange={v => setIForm(f => ({ ...f, targetId: v }))}>
                    <SelectTrigger className="bg-black/40 border-white/10 text-white">
                      <SelectValue placeholder="Select tournament" />
                    </SelectTrigger>
                    <SelectContent>
                      {tournaments.map(t => <SelectItem key={t.id} value={String(t.id)}>{t.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                ) : (
                  <Select value={iForm.targetId} onValueChange={v => setIForm(f => ({ ...f, targetId: v }))}>
                    <SelectTrigger className="bg-black/40 border-white/10 text-white">
                      <SelectValue placeholder="Select league" />
                    </SelectTrigger>
                    <SelectContent>
                      {leagues.map(l => <SelectItem key={l.id} value={String(l.id)}>{l.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                )}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-muted-foreground uppercase tracking-wider mb-1.5 block">Recipient Name</label>
                <Input value={iForm.recipientName} onChange={e => setIForm(f => ({ ...f, recipientName: e.target.value }))} placeholder="Full name" className="bg-black/40 border-white/10 text-white" />
              </div>
              <div>
                <label className="text-xs text-muted-foreground uppercase tracking-wider mb-1.5 block">Email</label>
                <Input type="email" value={iForm.recipientEmail} onChange={e => setIForm(f => ({ ...f, recipientEmail: e.target.value }))} placeholder="player@email.com" className="bg-black/40 border-white/10 text-white" />
              </div>
            </div>
            <div>
              <label className="text-xs text-muted-foreground uppercase tracking-wider mb-1.5 block">Phone (for SMS / WhatsApp)</label>
              <Input type="tel" value={iForm.recipientPhone} onChange={e => setIForm(f => ({ ...f, recipientPhone: e.target.value }))} placeholder="+91 98765 43210" className="bg-black/40 border-white/10 text-white" />
              <p className="text-xs text-muted-foreground mt-1">Email or phone required. Phone enables SMS/WhatsApp channel.</p>
            </div>

            <div>
              <label className="text-xs text-muted-foreground uppercase tracking-wider mb-1.5 block">Channels</label>
              <div className="flex gap-2 flex-wrap">
                {[
                  { key: 'email', label: '📧 Email', needsEmail: true },
                  { key: 'sms', label: '💬 SMS', needsPhone: true },
                  { key: 'whatsapp', label: '📱 WhatsApp', needsPhone: true },
                ].map(ch => {
                  const disabled = (ch.needsEmail && !iForm.recipientEmail) || (ch.needsPhone && !iForm.recipientPhone);
                  return (
                    <button
                      key={ch.key}
                      type="button"
                      disabled={disabled}
                      onClick={() => {
                        if (disabled) return;
                        setIForm(f => ({
                          ...f,
                          channels: f.channels.includes(ch.key) ? f.channels.filter(c => c !== ch.key) : [...f.channels, ch.key],
                        }));
                      }}
                      className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition-all ${
                        iForm.channels.includes(ch.key)
                          ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/40'
                          : disabled
                          ? 'bg-white/5 text-muted-foreground/40 border-white/5 cursor-not-allowed'
                          : 'bg-white/5 text-muted-foreground border-white/10'
                      }`}
                    >
                      {ch.label}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="flex items-center gap-3">
              <input
                type="checkbox"
                id="sendNow"
                checked={iForm.sendNow}
                onChange={e => setIForm(f => ({ ...f, sendNow: e.target.checked }))}
                className="w-4 h-4 rounded accent-primary"
              />
              <label htmlFor="sendNow" className="text-sm text-white cursor-pointer">Send email invitation immediately</label>
            </div>

            <div className="flex justify-end gap-3 pt-2">
              <Button type="button" variant="ghost" onClick={() => setInviteOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={iSending || (!iForm.recipientEmail && !iForm.recipientPhone)} className="bg-emerald-600 hover:bg-emerald-700 text-white">
                {iSending ? 'Sending...' : <><Link2 className="w-4 h-4 mr-2" /> {iForm.sendNow ? 'Send Invitation' : 'Create Invitation'}</>}
              </Button>
            </div>
          </form>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
