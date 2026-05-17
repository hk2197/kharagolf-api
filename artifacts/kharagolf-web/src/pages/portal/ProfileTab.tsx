import { Bell, CheckCircle, ChevronRight, DollarSign, Globe, Loader2, ShieldCheck, UserCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import i18n, { SUPPORTED_LANGUAGES, type SupportedLanguage } from '@/i18n';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { CurrencyPicker } from '@/components/CurrencyPicker';
import { PortalCommPrefs } from './PortalCommPrefs';
import type { NotifCaps, NotifPrefs, PlayerUser } from './types';

interface ProfileTabProps {
  user: PlayerUser | null;
  ghinNumber: string;
  setGhinNumber: (v: string) => void;
  ghinSaved: string | null;
  savingGhin: boolean;
  saveGhin: () => void | Promise<void>;
  savingLang: boolean;
  saveLanguagePreference: (lang: SupportedLanguage) => void | Promise<void>;
  notifPrefs: NotifPrefs;
  notifCaps: NotifCaps;
  savingNotifPref: boolean;
  saveNotifPref: (key: keyof NotifPrefs, value: boolean) => void | Promise<void>;
}

export function ProfileTab({
  user,
  ghinNumber,
  setGhinNumber,
  ghinSaved,
  savingGhin,
  saveGhin,
  savingLang,
  saveLanguagePreference,
  notifPrefs,
  notifCaps,
  savingNotifPref,
  saveNotifPref,
}: ProfileTabProps) {
  const { t } = useTranslation(['portal', 'profile']);

  const items: { key: keyof NotifPrefs; label: string; desc: string; locked: boolean; available: boolean }[] = [
    { key: 'preferEmail', label: t('portal:notifPrefs.email'), desc: t('portal:notifPrefs.emailDesc'), locked: true, available: true },
    { key: 'preferPush', label: t('portal:notifPrefs.push'), desc: notifCaps.hasPushToken ? t('portal:notifPrefs.pushDesc') : t('portal:notifPrefs.pushDescNoToken'), locked: false, available: notifCaps.hasPushToken },
    { key: 'preferSms', label: t('portal:notifPrefs.sms'), desc: notifCaps.hasPhone ? t('portal:notifPrefs.smsDesc') : t('portal:notifPrefs.noPhone'), locked: false, available: notifCaps.hasPhone },
    { key: 'preferWhatsapp', label: t('portal:notifPrefs.whatsapp'), desc: notifCaps.hasPhone ? t('portal:notifPrefs.whatsappDesc') : t('portal:notifPrefs.noPhone'), locked: false, available: notifCaps.hasPhone },
    ...(user?.role && user.role !== 'player' && user.role !== 'spectator' ? [
      { key: 'notifyMemberDocuments' as const, label: t('portal:notifPrefs.memberDocuments'), desc: t('portal:notifPrefs.memberDocumentsDesc'), locked: false, available: true },
    ] : []),
    ...(notifCaps.isCommitteeMember ? [
      { key: 'notifyCommitteePeerDigest' as const, label: t('portal:notifPrefs.committeePeerDigest'), desc: t('portal:notifPrefs.committeePeerDigestDesc'), locked: false, available: true },
    ] : []),
  ];

  return (
    <div className="space-y-4" data-testid="portal-profile-tab">
      {/* Public profile & privacy */}
      <Card className="glass-panel border-white/10 p-6">
        <div className="flex items-center gap-2 mb-2">
          <ShieldCheck className="w-5 h-5 text-emerald-400" />
          <h3 className="text-white font-semibold text-base">Public profile & privacy</h3>
        </div>
        <p className="text-sm text-muted-foreground mb-4">
          Reserve a public handle, control which sections are visible, and hide individual scorecards.
        </p>
        <a
          href="/portal/privacy"
          className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium"
          data-testid="link-privacy-settings"
        >
          Manage privacy settings
        </a>
      </Card>

      {/* Following & followers */}
      <Card className="glass-panel border-white/10 p-6">
        <div className="flex items-center gap-2 mb-2">
          <UserCheck className="w-5 h-5 text-emerald-400" />
          <h3 className="text-white font-semibold text-base">Following & followers</h3>
        </div>
        <p className="text-sm text-muted-foreground mb-4">
          See who you follow, count your followers, and unfollow members in one place.
        </p>
        <a
          href="/my-follows"
          className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium"
          data-testid="link-my-follows"
        >
          Open my follows
        </a>
      </Card>

      {/* Language Preference */}
      <Card className="glass-panel border-white/10 p-6">
        <div className="flex items-center gap-2 mb-4">
          <Globe className="w-5 h-5 text-blue-400" />
          <h3 className="text-white font-semibold text-base">{t('languagePreference', { ns: 'profile' })}</h3>
        </div>
        <p className="text-sm text-muted-foreground mb-4">
          {t('selectLanguage', { ns: 'profile' })}
        </p>
        <div className="flex gap-3 items-center">
          <Select
            value={user?.preferredLanguage ?? i18n.language ?? 'en'}
            onValueChange={(lang) => {
              i18n.changeLanguage(lang);
              saveLanguagePreference(lang as SupportedLanguage);
            }}
          >
            <SelectTrigger className="w-[200px] bg-black/40 border-white/10 text-white">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="bg-[#0a1a0f] border-white/10 text-white">
              {SUPPORTED_LANGUAGES.map((l) => (
                <SelectItem key={l.code} value={l.code} className="text-white hover:bg-white/10 focus:bg-white/10 focus:text-white">
                  {l.name}
                  {l.code === 'ar' && <span className="ml-2 text-xs text-muted-foreground">(RTL)</span>}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {savingLang && <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />}
        </div>
      </Card>

      {/* Display currency preference */}
      <Card className="glass-panel border-white/10 p-6">
        <div className="flex items-center gap-2 mb-4">
          <DollarSign className="w-5 h-5 text-emerald-400" />
          <h3 className="text-white font-semibold text-base">Currency</h3>
        </div>
        <CurrencyPicker />
      </Card>

      {/* GHIN / WHS Number */}
      <Card className="glass-panel border-white/10 p-6">
        <div className="flex items-center gap-2 mb-4">
          <CheckCircle className="w-5 h-5 text-emerald-400" />
          <h3 className="text-white font-semibold text-base">{t('portal:ghin.title')}</h3>
        </div>
        <p className="text-sm text-muted-foreground mb-4">
          {t('portal:ghin.description')}
        </p>
        <div className="flex gap-3 items-start">
          <div className="flex-1">
            <Input
              value={ghinNumber}
              onChange={e => setGhinNumber(e.target.value)}
              placeholder="e.g. 1234567"
              className="bg-black/40 border-white/10 text-white font-mono"
              maxLength={20}
            />
            {ghinSaved && (
              <p className="text-xs text-emerald-400 mt-1.5 flex items-center gap-1">
                <CheckCircle className="w-3 h-3" /> {t('portal:ghin.saved', { number: ghinSaved })}
              </p>
            )}
          </div>
          <Button onClick={saveGhin} disabled={savingGhin} className="bg-emerald-600 hover:bg-emerald-700 text-white gap-2 flex-shrink-0">
            {savingGhin ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
            {t('portal:ghin.saveBtn')}
          </Button>
        </div>
      </Card>

      <Card className="glass-panel border-white/10 p-6">
        <div className="flex items-center gap-2 mb-5">
          <Bell className="w-5 h-5 text-primary" />
          <h3 className="text-white font-semibold text-base">{t('portal:notifPrefs.title')}</h3>
        </div>
        <p className="text-sm text-muted-foreground mb-5">
          {t('portal:notifPrefs.description')}
        </p>
        <div className="space-y-3">
          {items.map(({ key, label, desc, locked, available }) => {
            const isOn = locked ? true : notifPrefs[key];
            return (
              <div key={key} className={`flex items-center justify-between p-4 rounded-xl bg-white/[0.03] border border-white/5 transition-colors ${available ? 'hover:border-white/10' : 'opacity-50'}`}>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-white font-medium text-sm">{label}</p>
                    {locked && <span className="text-[10px] text-primary font-semibold uppercase tracking-wider">{t('portal:notifPrefs.alwaysOn')}</span>}
                  </div>
                  <p className="text-muted-foreground text-xs mt-0.5 leading-relaxed">{desc}</p>
                </div>
                <button
                  disabled={savingNotifPref || locked || !available}
                  onClick={() => { if (!locked && available) saveNotifPref(key, !notifPrefs[key]); }}
                  className={`ml-4 flex-shrink-0 w-11 h-6 rounded-full transition-colors relative focus:outline-none ${isOn && available ? 'bg-primary' : 'bg-white/20'} ${(savingNotifPref || locked || !available) ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
                  aria-checked={isOn}
                  role="switch"
                >
                  <span className={`block w-4 h-4 rounded-full bg-white shadow transition-transform absolute top-1 ${isOn && available ? 'translate-x-6' : 'translate-x-1'}`} />
                </button>
              </div>
            );
          })}
        </div>
        {savingNotifPref && (
          <p className="text-xs text-muted-foreground mt-3 flex items-center gap-1.5">
            <Loader2 className="w-3 h-3 animate-spin" /> {t('portal:notifPrefs.saving')}
          </p>
        )}
        <div className="mt-4 pt-4 border-t border-white/5 space-y-2">
          <a
            href="/portal/email-preferences"
            className="inline-flex items-center gap-1.5 text-xs text-blue-400 hover:text-blue-300"
            data-testid="link-email-preferences"
          >
            Manage individual email subscriptions
            <ChevronRight className="w-3 h-3" />
          </a>
          <a
            href="/portal/course-corrections"
            className="flex items-center gap-1.5 text-xs text-blue-400 hover:text-blue-300"
            data-testid="link-course-corrections"
          >
            Report a course data error
            <ChevronRight className="w-3 h-3" />
          </a>
        </div>
      </Card>

      <PortalCommPrefs />
    </div>
  );
}
