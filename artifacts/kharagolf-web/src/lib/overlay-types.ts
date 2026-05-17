export type OverlayType =
  | "leaderboard"
  | "lower-third"
  | "current-group"
  | "player-card"
  | "hole"
  | "sponsor-bug";

export type SponsorPosition = "top-left" | "top-right" | "bottom-left" | "bottom-right";

export const SPONSOR_POSITIONS: SponsorPosition[] = [
  "top-left",
  "top-right",
  "bottom-left",
  "bottom-right",
];

export function isSponsorPosition(v: string): v is SponsorPosition {
  return (SPONSOR_POSITIONS as string[]).includes(v);
}

export interface OverlayTheme {
  logoUrl: string | null;
  primaryColor: string;
  accentColor: string;
  sponsorPosition: SponsorPosition;
  showSafeArea: boolean;
}

export interface OverlayState {
  active: Record<OverlayType, boolean>;
  currentGroupId: number | null;
  currentHole: number | null;
  currentPlayerId: number | null;
  currentSponsorId: number | null;
  lowerThirdText: string | null;
  leaderboardLimit: number;
  theme: OverlayTheme;
  updatedAt: string;
}

export interface OverlayStateBundle {
  tournament: { id: number; name: string; format: string; status: string };
  org: { id: number; name: string | null; logoUrl: string | null; primaryColor: string | null };
  state: OverlayState;
}

export interface OverlayLeaderboardEntry {
  position: number;
  positionDisplay: string;
  playerId: number;
  playerName: string;
  thru: string;
  grossScore: number | null;
  scoreToPar: number | null;
  netScore: number | null;
  netToPar: number | null;
}

export interface OverlayLeaderboard {
  tournamentName: string;
  coursePar: number | null;
  lastUpdated: string;
  entries: OverlayLeaderboardEntry[];
}

export interface OverlayGroupPlayer {
  playerId: number;
  playerName: string;
  flight: string | null;
  handicapIndex: number | null;
  position: number | null;
  positionDisplay: string | null;
  scoreToPar: number | null;
  thru: string | null;
  currentHole: number | null;
}

export interface OverlayGroup {
  id: number;
  teeTime: string;
  startingHole: number | null;
  round: number;
  players: OverlayGroupPlayer[];
}

export interface OverlayPlayerCard {
  playerId: number;
  playerName: string;
  flight: string | null;
  handicapIndex: number | null;
  teamName: string | null;
  profileImage: string | null;
  position: number | null;
  positionDisplay: string | null;
  grossScore: number | null;
  scoreToPar: number | null;
  netScore: number | null;
  netToPar: number | null;
  thru: string | null;
  currentRound: number | null;
}

export interface OverlayHoleStats {
  totalScored: number;
  eagles: number;
  birdies: number;
  pars: number;
  bogeys: number;
  doublePlus: number;
  avgStrokes: number | null;
}

export interface OverlayHole {
  courseName: string | null;
  holeNumber: number;
  par: number;
  yardage: number | null;
  handicap: number | null;
  description: string | null;
  stats: OverlayHoleStats;
}

export interface OverlaySponsor {
  id: number;
  name: string;
  logoUrl: string | null;
  tier: string;
  websiteUrl: string | null;
}

export interface OverlaySponsorList { sponsors: OverlaySponsor[]; }

/* Producer-panel reference data shapes */
export interface PanelTeeGroupPlayer { playerId: number; firstName: string; lastName: string; }
export interface PanelTeeGroup {
  id: number;
  teeTime: string;
  hole: number; // tee-times public endpoint uses "hole" for starting hole
  round: number;
  players: PanelTeeGroupPlayer[];
}
export interface PanelPlayer { playerId: number; firstName: string; lastName: string; }
export interface PanelTournament { id: number; name: string; status: string; }
