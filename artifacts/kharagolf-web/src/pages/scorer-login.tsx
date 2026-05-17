import { useState, useEffect } from 'react';
import { useLocation } from 'wouter';
import { Loader2, Trophy, KeyRound, AlertCircle, ChevronDown } from 'lucide-react';
import { KharaGolfBrand, KharaGolfWordmark } from '@/components/kharagolf-brand';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

interface Tournament {
  id: number;
  name: string;
  status: string;
  startDate: string | null;
}

const API = (path: string) => `/api${path}`;

export default function ScorerLoginPage() {
  const [, navigate] = useLocation();
  const [pin, setPin] = useState('');
  const [tournamentId, setTournamentId] = useState('');
  const [tournaments, setTournaments] = useState<Tournament[]>([]);
  const [loadingTournaments, setLoadingTournaments] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    fetch(API('/public/tournaments'))
      .then(r => r.ok ? r.json() : [])
      .then((data: Tournament[]) => {
        setTournaments(data);
        if (data.length === 1) setTournamentId(String(data[0].id));
      })
      .catch(() => setTournaments([]))
      .finally(() => setLoadingTournaments(false));
  }, []);

  const handlePinInput = (value: string) => {
    setPin(value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (pin.length !== 6) {
      setError('Please enter your 6-character PIN.');
      return;
    }
    if (!tournamentId) {
      setError('Please select a tournament.');
      return;
    }

    setLoading(true);
    try {
      const res = await fetch(API('/auth/scorer-login'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ pin, tournamentId: parseInt(tournamentId) }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Login failed. Please try again.');
        return;
      }
      window.location.href = `/scorer/tournament/${tournamentId}`;
    } catch {
      setError('Network error. Please check your connection and try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <KharaGolfBrand size="md" className="justify-center mb-4" />
          <div className="flex items-center justify-center gap-2 mt-3">
            <KeyRound className="w-4 h-4 text-primary" />
            <h1 className="font-display font-bold text-lg text-white tracking-widest uppercase">Scorer Access</h1>
          </div>
          <p className="text-muted-foreground text-sm mt-1">Enter your scorer PIN to begin</p>
        </div>

        <div className="bg-card border border-border rounded-2xl p-8 shadow-2xl">
          <form onSubmit={handleSubmit} className="space-y-5">
            <div>
              <label className="block text-sm text-muted-foreground mb-1.5">Select Tournament</label>
              {loadingTournaments ? (
                <div className="flex items-center gap-2 text-muted-foreground text-sm py-2">
                  <Loader2 className="w-4 h-4 animate-spin" /> Loading tournaments…
                </div>
              ) : (
                <Select value={tournamentId} onValueChange={setTournamentId}>
                  <SelectTrigger className="bg-background border-border text-white">
                    <SelectValue placeholder="Select a tournament" />
                  </SelectTrigger>
                  <SelectContent>
                    {tournaments.length === 0 ? (
                      <SelectItem value="none" disabled>No active tournaments</SelectItem>
                    ) : (
                      tournaments.map(t => (
                        <SelectItem key={t.id} value={String(t.id)}>
                          {t.name}
                        </SelectItem>
                      ))
                    )}
                  </SelectContent>
                </Select>
              )}
            </div>

            <div>
              <label className="block text-sm text-muted-foreground mb-1.5">Scorer PIN</label>
              <Input
                type="text"
                value={pin}
                onChange={e => handlePinInput(e.target.value)}
                placeholder="XXXXXX"
                maxLength={6}
                autoComplete="off"
                autoCapitalize="characters"
                className="bg-background border-border text-white font-mono text-2xl tracking-[0.5em] text-center placeholder:text-muted-foreground/40 placeholder:tracking-normal placeholder:text-base h-14"
              />
              <p className="text-xs text-muted-foreground mt-1 text-center">6-character PIN (letters and numbers)</p>
            </div>

            {error && (
              <div className="flex items-start gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/30">
                <AlertCircle className="w-4 h-4 text-red-400 mt-0.5 shrink-0" />
                <p className="text-red-400 text-sm">{error}</p>
              </div>
            )}

            <Button
              type="submit"
              disabled={loading || pin.length !== 6 || !tournamentId}
              className="w-full bg-primary hover:bg-primary/90 text-primary-foreground font-semibold h-11"
            >
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Access Scoring'}
            </Button>
          </form>

          <div className="mt-6 pt-5 border-t border-border text-center">
            <a href="/login" className="text-xs text-muted-foreground hover:text-primary transition-colors">
              Admin login →
            </a>
          </div>
        </div>

        <p className="text-center text-xs text-muted-foreground mt-6">
          <KharaGolfWordmark /> — Scorer Access
        </p>
      </div>
    </div>
  );
}
