import { CheckCircle, Loader2, Lock } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import i18n from '@/i18n';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { useToast } from '@/hooks/use-toast';
import { LockerRenewalCard } from './LockerRenewalCard';
import type { LockerAssignment, LockerWaitlistEntry } from './types';

const API = (path: string) => `/api${path}`;

interface LockerTabProps {
  lockerAssignment: LockerAssignment | null | undefined;
  lockerWaitlist: LockerWaitlistEntry | null;
  joiningWaitlist: boolean;
  setJoiningWaitlist: (value: boolean) => void;
  setLockerWaitlist: (entry: LockerWaitlistEntry) => void;
  orgId: number | null;
}

export function LockerTab({
  lockerAssignment,
  lockerWaitlist,
  joiningWaitlist,
  setJoiningWaitlist,
  setLockerWaitlist,
  orgId,
}: LockerTabProps) {
  const { toast } = useToast();
  const { t } = useTranslation(['portal', 'common']);

  const handleJoinWaitlist = async () => {
    setJoiningWaitlist(true);
    try {
      const res = await fetch(API('/portal/locker/join-waitlist'), { method: 'POST', credentials: 'include' });
      if (res.ok) {
        const entry = await res.json();
        setLockerWaitlist(entry);
        toast({ title: t('portal:addedToWaitlist'), description: t('portal:addedToWaitlistDesc') });
      } else {
        const err = await res.json();
        toast({ title: t('common:error'), description: err.error ?? t('portal:couldNotJoinWaitlist'), variant: 'destructive' });
      }
    } catch {
      toast({ title: t('common:error'), description: t('portal:couldNotJoinWaitlist'), variant: 'destructive' });
    } finally {
      setJoiningWaitlist(false);
    }
  };

  return (
    <div data-testid="portal-locker-tab">
      {lockerAssignment ? (
        <LockerRenewalCard assignment={lockerAssignment} orgId={orgId} />
      ) : lockerAssignment === null && !lockerWaitlist ? (
        <Card className="glass-panel border-white/10 p-12 text-center">
          <Lock className="w-10 h-10 text-muted-foreground opacity-30 mx-auto mb-3" />
          <p className="text-white font-medium mb-1">{t('portal:noLockerAssigned')}</p>
          <p className="text-xs text-muted-foreground mb-5">{t('portal:noLockerDescription')}</p>
          <Button
            onClick={handleJoinWaitlist}
            disabled={joiningWaitlist}
            className="bg-primary hover:bg-primary/90 text-white gap-2"
          >
            {joiningWaitlist ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
            {t('portal:joinWaitlist')}
          </Button>
        </Card>
      ) : lockerWaitlist ? (
        <Card className="glass-panel border-white/10 p-8 text-center">
          <CheckCircle className="w-10 h-10 text-emerald-400 mx-auto mb-3" />
          <p className="text-white font-medium mb-1">{t('portal:onWaitlist')}</p>
          <p className="text-xs text-muted-foreground mb-2">
            {t('portal:joined', { date: new Date(lockerWaitlist.requestedAt).toLocaleDateString(i18n.language || undefined, { year: 'numeric', month: 'short', day: 'numeric' }) })}
          </p>
          <Badge className={`${lockerWaitlist.status === 'notified' ? 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30' : 'bg-blue-500/20 text-blue-400 border-blue-500/30'}`}>
            {lockerWaitlist.status === 'notified' ? t('portal:lockerAvailableContact') : t('portal:waiting')}
          </Badge>
        </Card>
      ) : (
        <Card className="glass-panel border-white/10 p-12 text-center">
          <Loader2 className="w-8 h-8 text-muted-foreground animate-spin mx-auto" />
        </Card>
      )}
    </div>
  );
}
