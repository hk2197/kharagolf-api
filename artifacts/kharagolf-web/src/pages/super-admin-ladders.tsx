/**
 * Cross-Club Ladders — super-admin management (Task #376, #461)
 */
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";

interface Ladder {
  id: number;
  name: string;
  description: string | null;
  scope: "regional" | "national";
  format: "stroke" | "stableford" | "team_series" | "knockout_cup" | "national_ladder";
  status: "draft" | "open" | "active" | "completed" | "archived";
  region: string | null;
  seasonStart: string;
  seasonEnd: string;
  shareSlug: string;
  divisionCount: number;
  promotionRelegationEnabled: boolean;
  bestOfRounds: number | null;
}

interface LadderClub {
  id: number;
  organizationId: number;
  orgName: string | null;
  orgSlug: string | null;
  joinedAt: string;
}

interface LadderEntry {
  id: number;
  ladderId: number;
  userId: number | null;
  homeOrganizationId: number | null;
  playerName: string;
  division: number;
  totalPoints: number;
  roundsCounted: number;
  position: number | null;
}

interface LadderDetail extends Ladder {
  clubs: LadderClub[];
  entries: LadderEntry[];
}

interface OrgSummary {
  id: number;
  name: string;
  slug: string;
}

interface FormState {
  name: string;
  description: string;
  scope: "regional" | "national";
  format: Ladder["format"];
  region: string;
  seasonStart: string;
  seasonEnd: string;
  minHandicap: string;
  maxHandicap: string;
  bestOfRounds: string;
  divisionCount: string;
  promotionRelegationEnabled: boolean;
  promotePerDivision: string;
  relegatePerDivision: string;
}

const emptyForm: FormState = {
  name: "",
  description: "",
  scope: "national",
  format: "stableford",
  region: "",
  seasonStart: "",
  seasonEnd: "",
  minHandicap: "",
  maxHandicap: "",
  bestOfRounds: "",
  divisionCount: "1",
  promotionRelegationEnabled: false,
  promotePerDivision: "0",
  relegatePerDivision: "0",
};

export default function SuperAdminLaddersPage() {
  const qc = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const { data: ladders = [], isLoading } = useQuery<Ladder[]>({
    queryKey: ["/api/cross-club-ladders"],
    queryFn: () => fetch("/api/cross-club-ladders", { credentials: "include" }).then(r => r.json()),
  });

  const createMutation = useMutation({
    mutationFn: async (payload: Record<string, unknown>) => {
      const res = await fetch("/api/cross-club-ladders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error((await res.json()).error || "Failed");
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/cross-club-ladders"] });
      setShowCreate(false);
      setForm(emptyForm);
    },
  });

  const finalizeMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`/api/cross-club-ladders/${id}/finalize`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/cross-club-ladders"] }),
  });

  function submitCreate(e: React.FormEvent) {
    e.preventDefault();
    createMutation.mutate({
      name: form.name,
      description: form.description || undefined,
      scope: form.scope,
      format: form.format,
      region: form.region || undefined,
      seasonStart: form.seasonStart,
      seasonEnd: form.seasonEnd,
      minHandicap: form.minHandicap ? Number(form.minHandicap) : undefined,
      maxHandicap: form.maxHandicap ? Number(form.maxHandicap) : undefined,
      bestOfRounds: form.bestOfRounds ? Number(form.bestOfRounds) : undefined,
      divisionCount: Number(form.divisionCount) || 1,
      promotionRelegationEnabled: form.promotionRelegationEnabled,
      promotePerDivision: Number(form.promotePerDivision) || 0,
      relegatePerDivision: Number(form.relegatePerDivision) || 0,
    });
  }

  return (
    <div className="min-h-screen bg-slate-950 text-white p-6" data-testid="page-super-admin-ladders">
      <div className="max-w-6xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold">Cross-Club Ladders</h1>
            <p className="text-sm text-slate-400">National & regional season-long ladders across participating clubs.</p>
          </div>
          <div className="flex gap-2">
            <Link href="/super-admin" className="px-4 py-2 bg-slate-800 rounded text-sm" data-testid="link-back-super-admin">
              ← Super Admin
            </Link>
            <button
              onClick={() => setShowCreate(s => !s)}
              className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 rounded text-sm"
              data-testid="button-toggle-create"
            >
              {showCreate ? "Cancel" : "+ New Ladder"}
            </button>
          </div>
        </div>

        {showCreate && (
          <form onSubmit={submitCreate} className="bg-slate-900 border border-slate-800 rounded p-4 mb-6 grid grid-cols-1 md:grid-cols-2 gap-3" data-testid="form-create-ladder">
            <input className="bg-slate-800 px-3 py-2 rounded" placeholder="Name *" value={form.name} onChange={e => setForm({...form, name: e.target.value})} required data-testid="input-name" />
            <input className="bg-slate-800 px-3 py-2 rounded" placeholder="Region (optional)" value={form.region} onChange={e => setForm({...form, region: e.target.value})} data-testid="input-region" />
            <textarea className="bg-slate-800 px-3 py-2 rounded md:col-span-2" placeholder="Description" value={form.description} onChange={e => setForm({...form, description: e.target.value})} data-testid="input-description" />
            <select className="bg-slate-800 px-3 py-2 rounded" value={form.scope} onChange={e => setForm({...form, scope: e.target.value as "regional" | "national"})} data-testid="select-scope">
              <option value="national">National</option>
              <option value="regional">Regional</option>
            </select>
            <select className="bg-slate-800 px-3 py-2 rounded" value={form.format} onChange={e => setForm({...form, format: e.target.value as Ladder["format"]})} data-testid="select-format">
              <option value="stableford">Stableford</option>
              <option value="stroke">Stroke</option>
              <option value="team_series">Team Series</option>
              <option value="knockout_cup">Knockout Cup</option>
              <option value="national_ladder">National Ladder</option>
            </select>
            <label className="text-sm text-slate-400">Season start
              <input type="date" className="bg-slate-800 px-3 py-2 rounded w-full mt-1" value={form.seasonStart} onChange={e => setForm({...form, seasonStart: e.target.value})} required data-testid="input-season-start" />
            </label>
            <label className="text-sm text-slate-400">Season end
              <input type="date" className="bg-slate-800 px-3 py-2 rounded w-full mt-1" value={form.seasonEnd} onChange={e => setForm({...form, seasonEnd: e.target.value})} required data-testid="input-season-end" />
            </label>
            <input className="bg-slate-800 px-3 py-2 rounded" placeholder="Min handicap" value={form.minHandicap} onChange={e => setForm({...form, minHandicap: e.target.value})} data-testid="input-min-hcp" />
            <input className="bg-slate-800 px-3 py-2 rounded" placeholder="Max handicap" value={form.maxHandicap} onChange={e => setForm({...form, maxHandicap: e.target.value})} data-testid="input-max-hcp" />
            <input className="bg-slate-800 px-3 py-2 rounded" placeholder="Best of N rounds" value={form.bestOfRounds} onChange={e => setForm({...form, bestOfRounds: e.target.value})} data-testid="input-best-of" />
            <input className="bg-slate-800 px-3 py-2 rounded" placeholder="Division count" value={form.divisionCount} onChange={e => setForm({...form, divisionCount: e.target.value})} data-testid="input-divisions" />
            <label className="flex items-center gap-2 text-sm md:col-span-2">
              <input type="checkbox" checked={form.promotionRelegationEnabled} onChange={e => setForm({...form, promotionRelegationEnabled: e.target.checked})} data-testid="checkbox-prom-rel" />
              Enable promotion/relegation
            </label>
            {form.promotionRelegationEnabled && (
              <>
                <input className="bg-slate-800 px-3 py-2 rounded" placeholder="Promote per division" value={form.promotePerDivision} onChange={e => setForm({...form, promotePerDivision: e.target.value})} data-testid="input-promote" />
                <input className="bg-slate-800 px-3 py-2 rounded" placeholder="Relegate per division" value={form.relegatePerDivision} onChange={e => setForm({...form, relegatePerDivision: e.target.value})} data-testid="input-relegate" />
              </>
            )}
            <button type="submit" disabled={createMutation.isPending} className="md:col-span-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-500 rounded text-sm font-semibold" data-testid="button-submit-create">
              {createMutation.isPending ? "Creating…" : "Create Ladder"}
            </button>
            {createMutation.error ? (
              <p className="md:col-span-2 text-rose-400 text-sm" data-testid="text-create-error">{(createMutation.error as Error).message}</p>
            ) : null}
          </form>
        )}

        {isLoading ? (
          <p className="text-slate-400" data-testid="text-loading">Loading…</p>
        ) : ladders.length === 0 ? (
          <div className="bg-slate-900 border border-slate-800 rounded p-8 text-center text-slate-400" data-testid="text-empty">
            No cross-club ladders yet. Create one to get started.
          </div>
        ) : (
          <div className="space-y-3">
            {ladders.map(l => (
              <div key={l.id} className="bg-slate-900 border border-slate-800 rounded" data-testid={`row-ladder-${l.id}`}>
                <div className="p-4 flex items-center justify-between">
                  <div>
                    <div className="flex items-center gap-2">
                      <h3 className="font-semibold">{l.name}</h3>
                      <span className="px-2 py-0.5 text-xs rounded bg-slate-800 text-slate-300">{l.format}</span>
                      <span className="px-2 py-0.5 text-xs rounded bg-slate-800 text-slate-300">{l.scope}</span>
                      <span className={`px-2 py-0.5 text-xs rounded ${l.status === "active" ? "bg-emerald-700" : l.status === "completed" ? "bg-slate-700" : "bg-amber-700"}`}>
                        {l.status}
                      </span>
                    </div>
                    <p className="text-xs text-slate-400 mt-1">
                      {new Date(l.seasonStart).toLocaleDateString()} – {new Date(l.seasonEnd).toLocaleDateString()}
                      {l.region ? ` • ${l.region}` : ""}
                      {l.divisionCount > 1 ? ` • ${l.divisionCount} divisions` : ""}
                    </p>
                    <p className="text-xs text-slate-500 mt-1">Public URL: <code>/ladder/{l.shareSlug}</code></p>
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={() => setExpandedId(expandedId === l.id ? null : l.id)}
                      className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 rounded text-xs"
                      data-testid={`button-manage-${l.id}`}
                    >
                      {expandedId === l.id ? "Close" : "Manage"}
                    </button>
                    <Link href={`/ladder/${l.shareSlug}`} className="px-3 py-1.5 bg-slate-800 rounded text-xs" data-testid={`link-view-${l.id}`}>
                      View
                    </Link>
                    {l.status !== "completed" && (
                      <button
                        onClick={() => {
                          if (confirm(`Finalize "${l.name}"? This will close the ladder, apply promotion/relegation and notify players of final standings.`)) {
                            finalizeMutation.mutate(l.id);
                          }
                        }}
                        disabled={finalizeMutation.isPending}
                        className="px-3 py-1.5 bg-emerald-700 hover:bg-emerald-600 rounded text-xs"
                        data-testid={`button-finalize-${l.id}`}
                      >
                        Finalize
                      </button>
                    )}
                  </div>
                </div>
                {expandedId === l.id && (
                  <ManageLadderPanel ladderId={l.id} format={l.format} />
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ManageLadderPanel({ ladderId, format }: { ladderId: number; format: Ladder["format"] }) {
  const qc = useQueryClient();
  const detailKey = ["/api/cross-club-ladders", ladderId];
  const orgsKey = ["/api/organizations"];

  const { data: detail, isLoading: loadingDetail } = useQuery<LadderDetail>({
    queryKey: detailKey,
    queryFn: () => fetch(`/api/cross-club-ladders/${ladderId}`, { credentials: "include" }).then(r => r.json()),
  });

  const { data: orgs = [] } = useQuery<OrgSummary[]>({
    queryKey: orgsKey,
    queryFn: () => fetch("/api/organizations", { credentials: "include" }).then(r => r.json()),
  });

  const [orgToAdd, setOrgToAdd] = useState<string>("");

  const addClubMutation = useMutation({
    mutationFn: async (organizationId: number) => {
      const res = await fetch(`/api/cross-club-ladders/${ladderId}/clubs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ organizationId }),
      });
      if (!res.ok) throw new Error((await res.json()).error || "Failed to add club");
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: detailKey });
      setOrgToAdd("");
    },
  });

  const removeClubMutation = useMutation({
    mutationFn: async (orgId: number) => {
      const res = await fetch(`/api/cross-club-ladders/${ladderId}/clubs/${orgId}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to remove club");
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: detailKey }),
  });

  if (loadingDetail || !detail) {
    return (
      <div className="border-t border-slate-800 px-4 py-3 text-sm text-slate-400" data-testid={`panel-loading-${ladderId}`}>
        Loading details…
      </div>
    );
  }

  const participatingIds = new Set(detail.clubs.map(c => c.organizationId));
  const availableOrgs = orgs.filter(o => !participatingIds.has(o.id));

  return (
    <div className="border-t border-slate-800 p-4 space-y-6" data-testid={`panel-manage-${ladderId}`}>
      {/* Participating clubs */}
      <section data-testid={`section-clubs-${ladderId}`}>
        <h4 className="font-semibold text-sm mb-2">Participating Clubs ({detail.clubs.length})</h4>
        {detail.clubs.length === 0 ? (
          <p className="text-xs text-slate-500 mb-2" data-testid={`text-no-clubs-${ladderId}`}>No participating clubs yet.</p>
        ) : (
          <ul className="space-y-1 mb-3">
            {detail.clubs.map(c => (
              <li key={c.id} className="flex items-center justify-between bg-slate-800 px-3 py-2 rounded text-sm" data-testid={`row-club-${c.organizationId}`}>
                <span>{c.orgName ?? `Org #${c.organizationId}`}</span>
                <button
                  onClick={() => {
                    if (confirm(`Remove ${c.orgName ?? "this club"} from the ladder?`)) {
                      removeClubMutation.mutate(c.organizationId);
                    }
                  }}
                  disabled={removeClubMutation.isPending}
                  className="px-2 py-1 bg-rose-700 hover:bg-rose-600 rounded text-xs"
                  data-testid={`button-remove-club-${c.organizationId}`}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
        {removeClubMutation.error ? (
          <p className="text-rose-400 text-xs mb-2" data-testid={`text-remove-club-error-${ladderId}`}>
            {(removeClubMutation.error as Error).message}
          </p>
        ) : null}
        <div className="flex gap-2">
          <select
            className="bg-slate-800 px-3 py-2 rounded text-sm flex-1"
            value={orgToAdd}
            onChange={e => setOrgToAdd(e.target.value)}
            data-testid={`select-add-club-${ladderId}`}
          >
            <option value="">Select a club to add…</option>
            {availableOrgs.map(o => (
              <option key={o.id} value={o.id}>{o.name}</option>
            ))}
          </select>
          <button
            onClick={() => orgToAdd && addClubMutation.mutate(Number(orgToAdd))}
            disabled={!orgToAdd || addClubMutation.isPending}
            className="px-3 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 rounded text-sm"
            data-testid={`button-add-club-${ladderId}`}
          >
            {addClubMutation.isPending ? "Adding…" : "Add Club"}
          </button>
        </div>
        {addClubMutation.error ? (
          <p className="text-rose-400 text-xs mt-1" data-testid={`text-add-club-error-${ladderId}`}>
            {(addClubMutation.error as Error).message}
          </p>
        ) : null}
      </section>

      {/* Post results */}
      <section data-testid={`section-results-${ladderId}`}>
        <h4 className="font-semibold text-sm mb-2">Post Qualifying-Round Results ({detail.entries.length} registered)</h4>
        {detail.entries.length === 0 ? (
          <p className="text-xs text-slate-500" data-testid={`text-no-entries-${ladderId}`}>
            No players have registered yet. Once players register, you can post their qualifying-round results here.
          </p>
        ) : (
          <div className="space-y-2">
            {detail.entries.map(e => (
              <div key={e.id} className="space-y-2">
                <PostResultRow
                  ladderId={ladderId}
                  entry={e}
                  format={format}
                  participatingClubs={detail.clubs}
                />
                <ResultHistoryList
                  ladderId={ladderId}
                  entry={e}
                  format={format}
                />
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Bulk CSV import */}
      <BulkImportPanel
        ladderId={ladderId}
        format={format}
        entries={detail.entries}
        participatingClubs={detail.clubs}
      />
    </div>
  );
}

// ─── Bulk CSV import ─────────────────────────────────────────────────────────

interface ParsedRow {
  rowNumber: number;
  raw: Record<string, string>;
  player: string;
  roundDate: string;
  club: string;
  stableford: string;
  gross: string;
  net: string;
  notes: string;
}

interface RowResult {
  rowNumber: number;
  player: string;
  status: "pending" | "success" | "error";
  message?: string;
}

export const CSV_HEADERS = ["player", "roundDate", "club", "stableford", "gross", "net", "notes"] as const;
export const TEMPLATE_CSV =
  "player,roundDate,club,stableford,gross,net,notes\n" +
  "Jane Doe,2026-04-15,Pebble Beach,38,,,Front nine windy\n" +
  "John Smith,2026-04-15,Pebble Beach,,82,72,\n";

export function parseCsv(text: string): { headers: string[]; rows: string[][] } {
  const rows: string[][] = [];
  let cur: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else { inQuotes = false; }
      } else { field += ch; }
    } else {
      if (ch === '"') { inQuotes = true; }
      else if (ch === ",") { cur.push(field); field = ""; }
      else if (ch === "\n" || ch === "\r") {
        if (ch === "\r" && text[i + 1] === "\n") i++;
        cur.push(field); field = "";
        if (cur.some(c => c !== "")) rows.push(cur);
        cur = [];
      } else { field += ch; }
    }
  }
  if (field !== "" || cur.length > 0) {
    cur.push(field);
    if (cur.some(c => c !== "")) rows.push(cur);
  }
  if (rows.length === 0) return { headers: [], rows: [] };
  const headers = rows[0].map((h, i) => {
    let v = h.trim();
    if (i === 0 && v.charCodeAt(0) === 0xfeff) v = v.slice(1); // strip UTF-8 BOM
    return v;
  });
  return { headers, rows: rows.slice(1) };
}

function normalizeHeader(h: string): string {
  return h.trim().toLowerCase().replace(/[\s_-]+/g, "");
}

export function BulkImportPanel({
  ladderId,
  format,
  entries,
  participatingClubs,
}: {
  ladderId: number;
  format: Ladder["format"];
  entries: LadderEntry[];
  participatingClubs: LadderClub[];
}) {
  const qc = useQueryClient();
  const usesStableford = format === "stableford" || format === "national_ladder";
  const [parsed, setParsed] = useState<ParsedRow[]>([]);
  const [parseError, setParseError] = useState<string | null>(null);
  const [results, setResults] = useState<RowResult[]>([]);
  const [importing, setImporting] = useState(false);
  const [fileName, setFileName] = useState<string>("");

  function downloadTemplate() {
    const blob = new Blob([TEMPLATE_CSV], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "ladder-results-template.csv";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  async function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    setParseError(null);
    setResults([]);
    setParsed([]);
    setFileName("");
    if (!file) return;
    setFileName(file.name);
    try {
      const text = await file.text();
      const { headers, rows } = parseCsv(text);
      if (headers.length === 0) {
        setParseError("CSV is empty.");
        return;
      }
      const headerIndex = new Map<string, number>();
      headers.forEach((h, i) => { headerIndex.set(normalizeHeader(h), i); });
      const idx: Record<string, number> = {};
      for (const h of CSV_HEADERS) idx[h] = headerIndex.get(normalizeHeader(h)) ?? -1;
      const missing = ["player", "roundDate", "club"].filter(h => idx[h] < 0);
      if (missing.length > 0) {
        setParseError(`Missing required column(s): ${missing.join(", ")}. Expected headers: ${CSV_HEADERS.join(", ")}.`);
        return;
      }
      const parsedRows: ParsedRow[] = rows.map((cells, i) => ({
        rowNumber: i + 2, // +2 = header row + 1-based
        raw: Object.fromEntries(headers.map((h, j) => [h, (cells[j] ?? "").trim()])),
        player: (cells[idx.player] ?? "").trim(),
        roundDate: (cells[idx.roundDate] ?? "").trim(),
        club: (cells[idx.club] ?? "").trim(),
        stableford: idx.stableford >= 0 ? (cells[idx.stableford] ?? "").trim() : "",
        gross: idx.gross >= 0 ? (cells[idx.gross] ?? "").trim() : "",
        net: idx.net >= 0 ? (cells[idx.net] ?? "").trim() : "",
        notes: idx.notes >= 0 ? (cells[idx.notes] ?? "").trim() : "",
      }));
      setParsed(parsedRows);
    } catch (err) {
      setParseError((err as Error).message || "Failed to read file.");
    }
  }

  function findEntry(playerName: string): LadderEntry | undefined {
    const norm = playerName.toLowerCase().trim();
    return entries.find(e => e.playerName.toLowerCase().trim() === norm);
  }

  function findClubOrgId(clubName: string): number | undefined {
    const norm = clubName.toLowerCase().trim();
    const m = participatingClubs.find(c =>
      (c.orgName ?? "").toLowerCase().trim() === norm ||
      (c.orgSlug ?? "").toLowerCase().trim() === norm
    );
    return m?.organizationId;
  }

  async function importAll() {
    if (parsed.length === 0) return;
    setImporting(true);
    const initial: RowResult[] = parsed.map(r => ({ rowNumber: r.rowNumber, player: r.player, status: "pending" }));
    setResults(initial);

    // Validate locally and build the bulk payload. Rows that fail client-side
    // validation are marked as errors immediately and excluded from the request.
    const setRow = (rowNumber: number, patch: Partial<RowResult>) => {
      setResults(prev => prev.map(r => r.rowNumber === rowNumber ? { ...r, ...patch } : r));
    };

    type BulkPayloadRow = {
      rowNumber: number;
      entryId: number;
      organizationId: number;
      roundDate: string;
      notes?: string;
      stablefordPoints?: number;
      grossScore?: number;
      netScore?: number;
    };
    const bulkRows: BulkPayloadRow[] = [];

    for (const row of parsed) {
      try {
        if (!row.player) throw new Error("Missing player");
        if (!row.roundDate) throw new Error("Missing roundDate");
        if (!row.club) throw new Error("Missing club");
        const entry = findEntry(row.player);
        if (!entry) throw new Error(`No registered entry for player "${row.player}"`);
        const orgId = findClubOrgId(row.club);
        if (!orgId) throw new Error(`Club "${row.club}" is not a participating club`);

        const stableford = row.stableford !== "" ? Number(row.stableford) : null;
        const gross = row.gross !== "" ? Number(row.gross) : null;
        const net = row.net !== "" ? Number(row.net) : null;

        if (usesStableford) {
          if (stableford == null || Number.isNaN(stableford)) {
            throw new Error("Stableford points required for this format");
          }
        } else {
          if ((gross == null || Number.isNaN(gross)) && (net == null || Number.isNaN(net))) {
            throw new Error("Gross or net score required for this format");
          }
        }

        const payload: BulkPayloadRow = {
          rowNumber: row.rowNumber,
          entryId: entry.id,
          organizationId: orgId,
          roundDate: row.roundDate,
        };
        if (row.notes) payload.notes = row.notes;
        if (stableford != null && !Number.isNaN(stableford)) payload.stablefordPoints = stableford;
        if (gross != null && !Number.isNaN(gross)) payload.grossScore = gross;
        if (net != null && !Number.isNaN(net)) payload.netScore = net;
        bulkRows.push(payload);
      } catch (err) {
        setRow(row.rowNumber, { status: "error", message: (err as Error).message });
      }
    }

    if (bulkRows.length > 0) {
      try {
        const res = await fetch(`/api/cross-club-ladders/${ladderId}/results/bulk`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ rows: bulkRows }),
        });
        if (res.status === 404 || res.status === 405) {
          // Older backend without the bulk endpoint — fall back to per-row posts.
          await fallbackPerRowImport(bulkRows);
        } else {
          const body = await res.json().catch(() => ({} as Record<string, unknown>));
          if (!res.ok) {
            const message = (body as { error?: string }).error || `HTTP ${res.status}`;
            setResults(prev => prev.map(r =>
              r.status === "pending" ? { ...r, status: "error", message } : r,
            ));
          } else {
            const serverResults = (body as { results?: { rowNumber: number; status: "success" | "error"; message?: string }[] }).results ?? [];
            const byRow = new Map(serverResults.map(s => [s.rowNumber, s]));
            setResults(prev => prev.map(r => {
              const s = byRow.get(r.rowNumber);
              if (!s) return r;
              return { ...r, status: s.status, message: s.message ?? (s.status === "success" ? "Posted" : "Failed") };
            }));
          }
        }
      } catch (err) {
        const message = (err as Error).message || "Network error";
        setResults(prev => prev.map(r =>
          r.status === "pending" ? { ...r, status: "error", message } : r,
        ));
      }
    }

    async function fallbackPerRowImport(rows: BulkPayloadRow[]) {
      for (const row of rows) {
        const { rowNumber, ...payload } = row;
        try {
          const r = await fetch(`/api/cross-club-ladders/${ladderId}/results`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify(payload),
          });
          if (!r.ok) {
            const b = await r.json().catch(() => ({}));
            throw new Error((b as { error?: string }).error || `HTTP ${r.status}`);
          }
          setResults(prev => prev.map(p => p.rowNumber === rowNumber ? { ...p, status: "success", message: "Posted" } : p));
        } catch (err) {
          setResults(prev => prev.map(p => p.rowNumber === rowNumber ? { ...p, status: "error", message: (err as Error).message } : p));
        }
      }
    }

    setImporting(false);
    qc.invalidateQueries({ queryKey: ["/api/cross-club-ladders", ladderId] });
  }

  const successCount = results.filter(r => r.status === "success").length;
  const errorCount = results.filter(r => r.status === "error").length;

  return (
    <section className="border-t border-slate-800 pt-4" data-testid={`section-bulk-import-${ladderId}`}>
      <div className="flex items-center justify-between mb-2">
        <h4 className="font-semibold text-sm">Bulk Import Results (CSV)</h4>
        <button
          type="button"
          onClick={downloadTemplate}
          className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 rounded text-xs"
          data-testid={`button-download-template-${ladderId}`}
        >
          Download CSV template
        </button>
      </div>
      <p className="text-xs text-slate-500 mb-2">
        Columns: <code>{CSV_HEADERS.join(", ")}</code>. Player must match a registered entry name; club
        must match a participating club name or slug. Use stableford for stableford/national-ladder formats,
        otherwise gross and/or net.
      </p>
      <div className="flex items-center gap-2 mb-3">
        <input
          type="file"
          accept=".csv,text/csv"
          onChange={onFileChange}
          className="text-xs text-slate-300"
          data-testid={`input-csv-file-${ladderId}`}
        />
        <button
          type="button"
          onClick={importAll}
          disabled={importing || parsed.length === 0}
          className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 rounded text-xs font-semibold"
          data-testid={`button-import-csv-${ladderId}`}
        >
          {importing ? "Importing…" : parsed.length > 0 ? `Import ${parsed.length} rows` : "Import"}
        </button>
      </div>
      {fileName ? (
        <p className="text-xs text-slate-500 mb-2" data-testid={`text-csv-filename-${ladderId}`}>
          File: {fileName} ({parsed.length} row{parsed.length === 1 ? "" : "s"})
        </p>
      ) : null}
      {parseError ? (
        <p className="text-rose-400 text-xs mb-2" data-testid={`text-csv-parse-error-${ladderId}`}>{parseError}</p>
      ) : null}
      {results.length > 0 && (
        <div className="bg-slate-800 rounded p-2 text-xs" data-testid={`bulk-results-${ladderId}`}>
          <div className="mb-2 text-slate-300">
            {successCount} succeeded, {errorCount} failed{importing ? " (importing…)" : ""}
          </div>
          <ul className="space-y-1 max-h-60 overflow-auto">
            {results.map(r => (
              <li
                key={r.rowNumber}
                className={`flex justify-between gap-2 px-2 py-1 rounded ${
                  r.status === "success" ? "bg-emerald-900/40" : r.status === "error" ? "bg-rose-900/40" : "bg-slate-900"
                }`}
                data-testid={`bulk-row-${r.rowNumber}`}
              >
                <span className="truncate">Row {r.rowNumber}: {r.player || "(no player)"}</span>
                <span className={r.status === "error" ? "text-rose-300" : r.status === "success" ? "text-emerald-300" : "text-slate-400"}>
                  {r.status === "pending" ? "…" : r.message}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function PostResultRow({
  ladderId,
  entry,
  format,
  participatingClubs,
}: {
  ladderId: number;
  entry: LadderEntry;
  format: Ladder["format"];
  participatingClubs: LadderClub[];
}) {
  const qc = useQueryClient();
  const usesStableford = format === "stableford" || format === "national_ladder";
  const [open, setOpen] = useState(false);
  const [roundDate, setRoundDate] = useState<string>(new Date().toISOString().slice(0, 10));
  const [stableford, setStableford] = useState<string>("");
  const [gross, setGross] = useState<string>("");
  const [net, setNet] = useState<string>("");
  const [orgId, setOrgId] = useState<string>(entry.homeOrganizationId ? String(entry.homeOrganizationId) : "");
  const [notes, setNotes] = useState<string>("");

  const postMutation = useMutation({
    mutationFn: async () => {
      if (!usesStableford && gross === "" && net === "") {
        throw new Error("Enter a gross or net score before submitting.");
      }
      const payload: Record<string, unknown> = {
        entryId: entry.id,
        roundDate,
        notes: notes || undefined,
      };
      if (orgId) payload.organizationId = Number(orgId);
      if (stableford !== "") payload.stablefordPoints = Number(stableford);
      if (gross !== "") payload.grossScore = Number(gross);
      if (net !== "") payload.netScore = Number(net);
      const res = await fetch(`/api/cross-club-ladders/${ladderId}/results`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error((await res.json()).error || "Failed to post result");
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/cross-club-ladders", ladderId] });
      qc.invalidateQueries({ queryKey: ["/api/cross-club-ladders", ladderId, "entries", entry.id, "results"] });
      setStableford("");
      setGross("");
      setNet("");
      setNotes("");
      setOpen(false);
    },
  });

  return (
    <div className="bg-slate-800 rounded p-3 text-sm" data-testid={`row-entry-${entry.id}`}>
      <div className="flex items-center justify-between">
        <div>
          <div className="font-medium">{entry.playerName}</div>
          <div className="text-xs text-slate-400">
            Div {entry.division} • {entry.totalPoints} pts • {entry.roundsCounted} rounds counted
            {entry.position != null ? ` • position ${entry.position}` : ""}
          </div>
        </div>
        <button
          onClick={() => setOpen(o => !o)}
          className="px-3 py-1.5 bg-emerald-700 hover:bg-emerald-600 rounded text-xs"
          data-testid={`button-toggle-post-${entry.id}`}
        >
          {open ? "Cancel" : "Post Result"}
        </button>
      </div>
      {open && (
        <form
          onSubmit={(e) => { e.preventDefault(); postMutation.mutate(); }}
          className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-2"
          data-testid={`form-post-result-${entry.id}`}
        >
          <label className="text-xs text-slate-400">Round date
            <input
              type="date"
              className="bg-slate-900 px-2 py-1.5 rounded w-full mt-1 text-sm"
              value={roundDate}
              onChange={e => setRoundDate(e.target.value)}
              required
              data-testid={`input-round-date-${entry.id}`}
            />
          </label>
          <label className="text-xs text-slate-400">Posted at club
            <select
              className="bg-slate-900 px-2 py-1.5 rounded w-full mt-1 text-sm"
              value={orgId}
              onChange={e => setOrgId(e.target.value)}
              data-testid={`select-result-org-${entry.id}`}
            >
              <option value="">Select participating club…</option>
              {participatingClubs.map(c => (
                <option key={c.id} value={c.organizationId}>{c.orgName ?? `Org #${c.organizationId}`}</option>
              ))}
            </select>
          </label>
          {usesStableford ? (
            <label className="text-xs text-slate-400 md:col-span-2">Stableford points
              <input
                type="number"
                step="1"
                className="bg-slate-900 px-2 py-1.5 rounded w-full mt-1 text-sm"
                value={stableford}
                onChange={e => setStableford(e.target.value)}
                required
                data-testid={`input-stableford-${entry.id}`}
              />
            </label>
          ) : (
            <>
              <label className="text-xs text-slate-400">Gross score
                <input
                  type="number"
                  step="1"
                  className="bg-slate-900 px-2 py-1.5 rounded w-full mt-1 text-sm"
                  value={gross}
                  onChange={e => setGross(e.target.value)}
                  data-testid={`input-gross-${entry.id}`}
                />
              </label>
              <label className="text-xs text-slate-400">Net score
                <input
                  type="number"
                  step="1"
                  className="bg-slate-900 px-2 py-1.5 rounded w-full mt-1 text-sm"
                  value={net}
                  onChange={e => setNet(e.target.value)}
                  data-testid={`input-net-${entry.id}`}
                />
              </label>
            </>
          )}
          <input
            className="bg-slate-900 px-2 py-1.5 rounded text-sm md:col-span-2"
            placeholder="Notes (optional)"
            value={notes}
            onChange={e => setNotes(e.target.value)}
            data-testid={`input-notes-${entry.id}`}
          />
          <button
            type="submit"
            disabled={postMutation.isPending}
            className="md:col-span-2 px-3 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 rounded text-sm font-semibold"
            data-testid={`button-submit-result-${entry.id}`}
          >
            {postMutation.isPending ? "Posting…" : "Submit Result"}
          </button>
          {postMutation.error ? (
            <p className="md:col-span-2 text-rose-400 text-xs" data-testid={`text-post-error-${entry.id}`}>
              {(postMutation.error as Error).message}
            </p>
          ) : null}
        </form>
      )}
    </div>
  );
}

interface PostedResult {
  id: number;
  ladderId: number;
  entryId: number;
  organizationId: number | null;
  roundDate: string;
  grossScore: number | null;
  netScore: number | null;
  stablefordPoints: number | null;
  pointsAwarded: number;
  notes: string | null;
  auditCount?: number;
  lastAudit?: {
    action: "update" | "delete";
    actorName: string | null;
    actorRole: string | null;
    createdAt: string;
  } | null;
}

interface AuditEntry {
  id: number;
  action: "update" | "delete";
  actorName: string | null;
  actorRole: string | null;
  createdAt: string;
  fieldChanges: Record<string, { from: unknown; to: unknown }> | null;
  snapshot: Record<string, unknown> | null;
}

function formatAuditValue(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v)) {
    return new Date(v).toLocaleDateString();
  }
  return String(v);
}

function ResultAuditPanel({ ladderId, resultId }: { ladderId: number; resultId: number }) {
  const { data: audits = [], isLoading } = useQuery<AuditEntry[]>({
    queryKey: ["/api/cross-club-ladders", ladderId, "results", resultId, "audits"],
    queryFn: async () => {
      const res = await fetch(`/api/cross-club-ladders/${ladderId}/results/${resultId}/audits`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Failed to load audit history");
      return res.json();
    },
  });

  if (isLoading) {
    return (
      <div className="mt-2 text-xs text-slate-500" data-testid={`text-audit-loading-${resultId}`}>
        Loading change history…
      </div>
    );
  }
  if (audits.length === 0) {
    return (
      <div className="mt-2 text-xs text-slate-500" data-testid={`text-no-audits-${resultId}`}>
        No changes recorded.
      </div>
    );
  }
  return (
    <div className="mt-2 border-t border-slate-800 pt-2 space-y-2" data-testid={`audit-list-${resultId}`}>
      <div className="text-xs text-slate-400 font-semibold">Change history ({audits.length})</div>
      {audits.map(a => (
        <div key={a.id} className="text-xs text-slate-400" data-testid={`audit-row-${a.id}`}>
          <div>
            <span className="text-slate-300 font-semibold">
              {a.action === "delete" ? "Deleted" : "Edited"}
            </span>
            <span className="ml-1">
              by {a.actorName ?? "Unknown"}{a.actorRole ? ` (${a.actorRole})` : ""}
            </span>
            <span className="ml-1 text-slate-500">
              · {new Date(a.createdAt).toLocaleString()}
            </span>
          </div>
          {a.fieldChanges && Object.keys(a.fieldChanges).length > 0 ? (
            <ul className="mt-0.5 ml-3 list-disc text-slate-500">
              {Object.entries(a.fieldChanges).map(([field, change]) => (
                <li key={field}>
                  <span className="text-slate-400">{field}:</span>{" "}
                  <span className="text-rose-400">{formatAuditValue(change.from)}</span>
                  {" → "}
                  <span className="text-emerald-400">{formatAuditValue(change.to)}</span>
                </li>
              ))}
            </ul>
          ) : null}
          {a.action === "delete" && a.snapshot ? (
            <div className="mt-0.5 ml-3 text-slate-500">
              Snapshot: {a.snapshot.pointsAwarded as number ?? 0} pts
              {a.snapshot.stablefordPoints != null ? `, stbl ${a.snapshot.stablefordPoints as number}` : ""}
              {a.snapshot.grossScore != null ? `, gross ${a.snapshot.grossScore as number}` : ""}
              {a.snapshot.netScore != null ? `, net ${a.snapshot.netScore as number}` : ""}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function ResultHistoryList({
  ladderId,
  entry,
  format,
}: {
  ladderId: number;
  entry: LadderEntry;
  format: Ladder["format"];
}) {
  const qc = useQueryClient();
  const detailKey = ["/api/cross-club-ladders", ladderId];
  const historyKey = ["/api/cross-club-ladders", ladderId, "entries", entry.id, "results"];
  const [editingId, setEditingId] = useState<number | null>(null);
  const [auditOpenId, setAuditOpenId] = useState<number | null>(null);

  const { data: results = [], isLoading } = useQuery<PostedResult[]>({
    queryKey: historyKey,
    queryFn: async () => {
      const res = await fetch(`/api/cross-club-ladders/${ladderId}/entries/${entry.id}/results`, { credentials: "include" });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Failed to load result history");
      return res.json();
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (resultId: number) => {
      const res = await fetch(`/api/cross-club-ladders/${ladderId}/results/${resultId}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) throw new Error((await res.json()).error || "Failed to delete result");
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: historyKey });
      qc.invalidateQueries({ queryKey: detailKey });
      qc.invalidateQueries({ queryKey: ["/api/cross-club-ladders", ladderId, "entries", entry.id, "audits"] });
    },
  });

  if (isLoading) {
    return (
      <p className="text-xs text-slate-500 pl-3" data-testid={`text-history-loading-${entry.id}`}>Loading history…</p>
    );
  }

  if (results.length === 0) {
    return (
      <div className="pl-3 space-y-1" data-testid={`history-${entry.id}`}>
        <p className="text-xs text-slate-600" data-testid={`text-no-history-${entry.id}`}>No posted results yet.</p>
        <DeletedResultsList ladderId={ladderId} entryId={entry.id} />
      </div>
    );
  }

  return (
    <div className="pl-3 space-y-1" data-testid={`history-${entry.id}`}>
      <div className="text-xs text-slate-400 font-semibold mb-1">Posted results ({results.length})</div>
      {results.map(r => (
        <div key={r.id} className="bg-slate-900 border border-slate-800 rounded px-3 py-2 text-xs" data-testid={`row-result-${r.id}`}>
          {editingId === r.id ? (
            <EditResultForm
              ladderId={ladderId}
              result={r}
              format={format}
              onClose={() => setEditingId(null)}
              entryId={entry.id}
            />
          ) : (
            <>
              <div className="flex items-center justify-between">
                <div>
                  <div>
                    <span className="text-slate-300">{new Date(r.roundDate).toLocaleDateString()}</span>
                    <span className="ml-2 text-slate-400">
                      {r.stablefordPoints != null ? `${r.stablefordPoints} stbl` : ""}
                      {r.grossScore != null ? ` • gross ${r.grossScore}` : ""}
                      {r.netScore != null ? ` • net ${r.netScore}` : ""}
                    </span>
                    <span className="ml-2 text-emerald-400 font-semibold">{r.pointsAwarded} pts</span>
                  </div>
                  {r.notes ? <div className="text-slate-500 mt-0.5">{r.notes}</div> : null}
                  {r.lastAudit ? (
                    <div
                      className="text-amber-400/80 mt-0.5"
                      title={`${r.lastAudit.action === "delete" ? "Deleted" : "Edited"} by ${r.lastAudit.actorName ?? "Unknown"}${r.lastAudit.actorRole ? ` (${r.lastAudit.actorRole})` : ""} on ${new Date(r.lastAudit.createdAt).toLocaleString()}`}
                      data-testid={`text-last-audit-${r.id}`}
                    >
                      {r.lastAudit.action === "delete" ? "Deleted" : "Edited"} by {r.lastAudit.actorName ?? "Unknown"} · {new Date(r.lastAudit.createdAt).toLocaleString()}
                      {r.auditCount && r.auditCount > 1 ? ` (${r.auditCount} changes)` : ""}
                    </div>
                  ) : null}
                </div>
                <div className="flex gap-1">
                  {r.auditCount && r.auditCount > 0 ? (
                    <button
                      onClick={() => setAuditOpenId(auditOpenId === r.id ? null : r.id)}
                      className="px-2 py-1 bg-slate-700 hover:bg-slate-600 rounded text-xs"
                      data-testid={`button-toggle-audit-${r.id}`}
                    >
                      {auditOpenId === r.id ? "Hide history" : "History"}
                    </button>
                  ) : null}
                  <button
                    onClick={() => setEditingId(r.id)}
                    className="px-2 py-1 bg-slate-700 hover:bg-slate-600 rounded text-xs"
                    data-testid={`button-edit-result-${r.id}`}
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => {
                      if (confirm("Delete this posted result? Standings will be recomputed.")) {
                        deleteMutation.mutate(r.id);
                      }
                    }}
                    disabled={deleteMutation.isPending}
                    className="px-2 py-1 bg-rose-700 hover:bg-rose-600 rounded text-xs"
                    data-testid={`button-delete-result-${r.id}`}
                  >
                    Delete
                  </button>
                </div>
              </div>
              {auditOpenId === r.id ? (
                <ResultAuditPanel ladderId={ladderId} resultId={r.id} />
              ) : null}
            </>
          )}
        </div>
      ))}
      {deleteMutation.error ? (
        <p className="text-rose-400 text-xs" data-testid={`text-delete-result-error-${entry.id}`}>
          {(deleteMutation.error as Error).message}
        </p>
      ) : null}
      <DeletedResultsList ladderId={ladderId} entryId={entry.id} />
    </div>
  );
}

interface EntryAuditEntry extends AuditEntry {
  resultId: number;
  resultStillExists: boolean;
}

function DeletedResultsList({ ladderId, entryId }: { ladderId: number; entryId: number }) {
  const { data: audits = [] } = useQuery<EntryAuditEntry[]>({
    queryKey: ["/api/cross-club-ladders", ladderId, "entries", entryId, "audits"],
    queryFn: async () => {
      const res = await fetch(`/api/cross-club-ladders/${ladderId}/entries/${entryId}/audits`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Failed to load entry audit feed");
      return res.json();
    },
  });
  const tombstones = audits.filter(a => a.action === "delete" && !a.resultStillExists);
  if (tombstones.length === 0) return null;
  return (
    <div className="mt-2 border-t border-slate-800 pt-2 space-y-1" data-testid={`deleted-results-${entryId}`}>
      <div className="text-xs text-slate-400 font-semibold">Deleted results ({tombstones.length})</div>
      {tombstones.map(a => {
        const snap = a.snapshot ?? {};
        return (
          <div key={a.id} className="bg-slate-900/60 border border-rose-900/50 rounded px-3 py-2 text-xs" data-testid={`tombstone-${a.id}`}>
            <div className="text-rose-300">
              Deleted by {a.actorName ?? "Unknown"}{a.actorRole ? ` (${a.actorRole})` : ""}
              <span className="ml-1 text-slate-500">· {new Date(a.createdAt).toLocaleString()}</span>
            </div>
            <div className="text-slate-400 mt-0.5">
              {snap.roundDate ? new Date(String(snap.roundDate)).toLocaleDateString() : "—"} ·{" "}
              {snap.stablefordPoints != null ? `${snap.stablefordPoints as number} stbl ` : ""}
              {snap.grossScore != null ? `gross ${snap.grossScore as number} ` : ""}
              {snap.netScore != null ? `net ${snap.netScore as number} ` : ""}
              <span className="text-emerald-400">· {(snap.pointsAwarded as number) ?? 0} pts</span>
            </div>
            {snap.notes ? <div className="text-slate-500 mt-0.5">{snap.notes as string}</div> : null}
          </div>
        );
      })}
    </div>
  );
}

function EditResultForm({
  ladderId,
  entryId,
  result,
  format,
  onClose,
}: {
  ladderId: number;
  entryId: number;
  result: PostedResult;
  format: Ladder["format"];
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const usesStableford = format === "stableford" || format === "national_ladder";
  const [roundDate, setRoundDate] = useState<string>(new Date(result.roundDate).toISOString().slice(0, 10));
  const [stableford, setStableford] = useState<string>(result.stablefordPoints != null ? String(result.stablefordPoints) : "");
  const [gross, setGross] = useState<string>(result.grossScore != null ? String(result.grossScore) : "");
  const [net, setNet] = useState<string>(result.netScore != null ? String(result.netScore) : "");
  const [notes, setNotes] = useState<string>(result.notes ?? "");

  const editMutation = useMutation({
    mutationFn: async () => {
      const payload: Record<string, unknown> = {
        roundDate,
        notes: notes,
        stablefordPoints: stableford === "" ? null : Number(stableford),
        grossScore: gross === "" ? null : Number(gross),
        netScore: net === "" ? null : Number(net),
      };
      const res = await fetch(`/api/cross-club-ladders/${ladderId}/results/${result.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error((await res.json()).error || "Failed to update result");
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/cross-club-ladders", ladderId, "entries", entryId, "results"] });
      qc.invalidateQueries({ queryKey: ["/api/cross-club-ladders", ladderId] });
      qc.invalidateQueries({ queryKey: ["/api/cross-club-ladders", ladderId, "results", result.id, "audits"] });
      qc.invalidateQueries({ queryKey: ["/api/cross-club-ladders", ladderId, "entries", entryId, "audits"] });
      onClose();
    },
  });

  return (
    <form
      onSubmit={(e) => { e.preventDefault(); editMutation.mutate(); }}
      className="grid grid-cols-1 md:grid-cols-2 gap-2"
      data-testid={`form-edit-result-${result.id}`}
    >
      <label className="text-xs text-slate-400">Round date
        <input
          type="date"
          className="bg-slate-800 px-2 py-1.5 rounded w-full mt-1 text-sm"
          value={roundDate}
          onChange={e => setRoundDate(e.target.value)}
          required
          data-testid={`input-edit-round-date-${result.id}`}
        />
      </label>
      {usesStableford ? (
        <label className="text-xs text-slate-400">Stableford points
          <input
            type="number"
            step="1"
            className="bg-slate-800 px-2 py-1.5 rounded w-full mt-1 text-sm"
            value={stableford}
            onChange={e => setStableford(e.target.value)}
            data-testid={`input-edit-stableford-${result.id}`}
          />
        </label>
      ) : (
        <>
          <label className="text-xs text-slate-400">Gross
            <input
              type="number"
              step="1"
              className="bg-slate-800 px-2 py-1.5 rounded w-full mt-1 text-sm"
              value={gross}
              onChange={e => setGross(e.target.value)}
              data-testid={`input-edit-gross-${result.id}`}
            />
          </label>
          <label className="text-xs text-slate-400">Net
            <input
              type="number"
              step="1"
              className="bg-slate-800 px-2 py-1.5 rounded w-full mt-1 text-sm"
              value={net}
              onChange={e => setNet(e.target.value)}
              data-testid={`input-edit-net-${result.id}`}
            />
          </label>
        </>
      )}
      <input
        className="bg-slate-800 px-2 py-1.5 rounded text-sm md:col-span-2"
        placeholder="Notes (optional)"
        value={notes}
        onChange={e => setNotes(e.target.value)}
        data-testid={`input-edit-notes-${result.id}`}
      />
      <div className="md:col-span-2 flex gap-2">
        <button
          type="submit"
          disabled={editMutation.isPending}
          className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 rounded text-xs font-semibold"
          data-testid={`button-save-result-${result.id}`}
        >
          {editMutation.isPending ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          onClick={onClose}
          className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 rounded text-xs"
          data-testid={`button-cancel-edit-${result.id}`}
        >
          Cancel
        </button>
        {editMutation.error ? (
          <span className="text-rose-400 text-xs self-center" data-testid={`text-edit-error-${result.id}`}>
            {(editMutation.error as Error).message}
          </span>
        ) : null}
      </div>
    </form>
  );
}
