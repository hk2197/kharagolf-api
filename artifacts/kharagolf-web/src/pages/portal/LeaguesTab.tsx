import { Trophy } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { STATUS_COLORS, type LeagueRow } from './types';

interface LeaguesTabProps {
  leagues: LeagueRow[];
}

export function LeaguesTab({ leagues }: LeaguesTabProps) {
  const { t } = useTranslation(['portal']);

  return (
    <div data-testid="portal-leagues-tab">
      {leagues.length === 0 ? (
        <Card className="glass-panel border-white/10 p-12 text-center">
          <Trophy className="w-10 h-10 text-muted-foreground opacity-30 mx-auto mb-3" />
          <p className="text-muted-foreground">{t('portal:emptyStates.noLeagues')}</p>
          <p className="text-xs text-muted-foreground mt-1">{t('portal:leagueAdminNote')}</p>
        </Card>
      ) : (
        <div className="space-y-3">
          {leagues.map(l => (
            <Card key={l.memberId} className="glass-panel border-white/10 p-4 flex items-center gap-4">
              <div className="flex-1 min-w-0">
                <p className="font-semibold text-white truncate">{l.leagueName}</p>
                <div className="flex items-center gap-2 mt-1 flex-wrap">
                  <span className="text-xs text-muted-foreground">{t(`portal:formats.${l.leagueFormat}`, { defaultValue: l.leagueFormat })}</span>
                  {l.roundsPlayed !== null && (
                    <span className="text-xs text-muted-foreground">· {t('portal:roundsPlayedCount', { count: l.roundsPlayed })}</span>
                  )}
                </div>
              </div>
              <div className="flex flex-col items-end gap-1 flex-shrink-0">
                <Badge className={`${STATUS_COLORS[l.leagueStatus] ?? ''} border text-xs`}>{l.leagueStatus}</Badge>
                {l.position !== null && (
                  <span className="text-xs text-muted-foreground">#{l.position} · {l.totalPoints ?? 0} pts</span>
                )}
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
