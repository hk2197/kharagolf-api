export interface AvatarPreset {
  id: string;
  label: string;
  svgXml: string;
}

const PRESET_SVGS: Record<string, string> = {
  flag: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><radialGradient id="g" cx="50%" cy="40%" r="60%"><stop offset="0%" stop-color="#2d9d6e"/><stop offset="100%" stop-color="#0d4a2c"/></radialGradient></defs><circle cx="50" cy="50" r="50" fill="url(#g)"/><rect x="47" y="18" width="4" height="58" fill="white" rx="2"/><polygon points="51,18 72,30 51,42" fill="#fbbf24"/><ellipse cx="50" cy="77" rx="14" ry="4" fill="rgba(255,255,255,0.2)"/></svg>`,
  ball: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="50" fill="#1e293b"/><circle cx="50" cy="50" r="30" fill="white"/><path d="M36 40 Q50 34 64 40" stroke="#94a3b8" fill="none" stroke-width="2.5" stroke-linecap="round"/><path d="M32 50 Q50 43 68 50" stroke="#94a3b8" fill="none" stroke-width="2.5" stroke-linecap="round"/><path d="M34 60 Q50 66 66 60" stroke="#94a3b8" fill="none" stroke-width="2.5" stroke-linecap="round"/></svg>`,
  trophy: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="50" fill="#451a03"/><path d="M37 27 h26 v22 Q63 60 50 60 Q37 60 37 49 z" fill="#fbbf24"/><path d="M29 31 Q29 48 37 50" stroke="#fbbf24" fill="none" stroke-width="5" stroke-linecap="round"/><path d="M71 31 Q71 48 63 50" stroke="#fbbf24" fill="none" stroke-width="5" stroke-linecap="round"/><rect x="44" y="60" width="12" height="9" fill="#fbbf24"/><rect x="35" y="69" width="30" height="5" rx="2.5" fill="#fbbf24"/></svg>`,
  eagle: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="50" fill="#1e3a8a"/><polygon points="50,22 56,40 75,40 61,51 66,69 50,58 34,69 39,51 25,40 44,40" fill="#fbbf24"/></svg>`,
  birdie: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="50" fill="#7f1d1d"/><circle cx="50" cy="50" r="28" fill="none" stroke="#fca5a5" stroke-width="3"/><circle cx="50" cy="50" r="20" fill="none" stroke="#f87171" stroke-width="3"/><circle cx="50" cy="50" r="8" fill="#ef4444"/><rect x="48" y="22" width="4" height="28" fill="white" rx="2"/><polygon points="52,22 52,36 64,29" fill="#fbbf24"/></svg>`,
  ace: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="50" fill="#3b0764"/><text x="50" y="46" font-family="serif" font-size="28" font-weight="700" fill="#fbbf24" text-anchor="middle" dominant-baseline="middle">ACE</text><text x="50" y="66" font-family="serif" font-size="11" fill="#c4b5fd" text-anchor="middle">HOLE IN ONE</text></svg>`,
  club: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="50" fill="#0f172a"/><line x1="55" y1="18" x2="42" y2="74" stroke="white" stroke-width="4" stroke-linecap="round"/><ellipse cx="38" cy="76" rx="14" ry="8" fill="white" transform="rotate(-15 38 76)"/></svg>`,
  crossed: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="50" fill="#0c2d1e"/><line x1="62" y1="20" x2="28" y2="78" stroke="white" stroke-width="4" stroke-linecap="round"/><line x1="38" y1="20" x2="72" y2="78" stroke="white" stroke-width="4" stroke-linecap="round"/><ellipse cx="24" cy="76" rx="10" ry="6" fill="white" transform="rotate(60 24 76)"/><ellipse cx="76" cy="76" rx="10" ry="6" fill="white" transform="rotate(-60 76 76)"/></svg>`,
  crown: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="50" fill="#451a03"/><polygon points="20,65 30,38 50,52 70,38 80,65" fill="#fbbf24"/><polygon points="50,30 55,40 60,30 60,52 40,52 40,30 45,40" fill="#fcd34d"/><circle cx="20" cy="65" r="4" fill="#fcd34d"/><circle cx="50" cy="30" r="4" fill="#fcd34d"/><circle cx="80" cy="65" r="4" fill="#fcd34d"/><rect x="17" y="65" width="66" height="8" rx="3" fill="#fbbf24"/></svg>`,
  par: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="50" fill="#1f2937"/><circle cx="50" cy="28" r="9" fill="white"/><line x1="50" y1="37" x2="50" y2="62" stroke="white" stroke-width="4" stroke-linecap="round"/><line x1="50" y1="48" x2="38" y2="42" stroke="white" stroke-width="3" stroke-linecap="round"/><line x1="50" y1="62" x2="38" y2="75" stroke="white" stroke-width="4" stroke-linecap="round"/><line x1="50" y1="62" x2="62" y2="75" stroke="white" stroke-width="4" stroke-linecap="round"/></svg>`,
  course: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="50" fill="#14532d"/><ellipse cx="50" cy="60" rx="32" ry="18" fill="#16a34a" opacity="0.5"/><ellipse cx="50" cy="60" rx="18" ry="10" fill="#22c55e" opacity="0.5"/><circle cx="50" cy="60" r="5" fill="#166534"/><rect x="49" y="38" width="3" height="22" fill="white" rx="1.5"/><polygon points="52,38 52,48 64,43" fill="#fbbf24"/></svg>`,
  kg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="50" fill="#0a3320"/><text x="50" y="55" font-family="serif" font-size="36" font-weight="700" text-anchor="middle"><tspan fill="white">K</tspan><tspan fill="#C9A84C">G</tspan></text></svg>`,
};

export const AVATAR_PRESETS: AvatarPreset[] = [
  { id: 'flag',    label: 'Flag Pin',      svgXml: PRESET_SVGS.flag },
  { id: 'ball',    label: 'Golf Ball',     svgXml: PRESET_SVGS.ball },
  { id: 'trophy',  label: 'Trophy',        svgXml: PRESET_SVGS.trophy },
  { id: 'eagle',   label: 'Eagle Star',    svgXml: PRESET_SVGS.eagle },
  { id: 'birdie',  label: 'Birdie',        svgXml: PRESET_SVGS.birdie },
  { id: 'ace',     label: 'Hole In One',   svgXml: PRESET_SVGS.ace },
  { id: 'club',    label: 'Golf Club',     svgXml: PRESET_SVGS.club },
  { id: 'crossed', label: 'Crossed Clubs', svgXml: PRESET_SVGS.crossed },
  { id: 'crown',   label: 'Champion',      svgXml: PRESET_SVGS.crown },
  { id: 'par',     label: 'Par Golfer',    svgXml: PRESET_SVGS.par },
  { id: 'course',  label: 'Golf Course',   svgXml: PRESET_SVGS.course },
  { id: 'kg',      label: 'KharaGolf',     svgXml: PRESET_SVGS.kg },
];

export const PRESET_MAP: Record<string, AvatarPreset> = Object.fromEntries(
  AVATAR_PRESETS.map(p => [p.id, p]),
);

export function isPresetAvatar(profileImage: string | null | undefined): boolean {
  return typeof profileImage === 'string' && profileImage.startsWith('preset:');
}

export function getPresetId(profileImage: string): string {
  return profileImage.replace(/^preset:/, '');
}
